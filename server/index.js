'use strict';

/**
 * Browser MCP — Web Server
 *
 * Exposes a simple HTTP API + UI so the voice agent can be driven from
 * any browser (including your local laptop) while the headless Chromium
 * runs on the server.
 *
 * Endpoints:
 *   GET  /           → Voice UI (HTML page)
 *   POST /command    → { text: "..." }   → execute a text command, return result
 *   POST /voice      → multipart audio file → transcribe + execute, return result
 *   GET  /screenshot → returns PNG of the current headless browser page
 *   GET  /status     → health check + current page URL
 */

require('dotenv').config();
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const express = require('express');
const multer  = require('multer');
const { OpenAI } = require('openai');

const logger           = require('../logger');
const { getActivePage, navigateTo, connectBrowser } = require('../browser/connect');
const { parseIntent }  = require('../brain/intentParser');
const { validateAction, confirmDestructive } = require('../safety/guard');
const { executeAction } = require('../actions');

const app    = express();
const upload = multer({ dest: os.tmpdir() });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const PORT   = parseInt(process.env.PORT || '3000', 10);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── Shared command runner ────────────────────────────────────────────────────

async function runCommand(text) {
  if (!text || !text.trim()) return { ok: false, message: 'Empty command.' };

  const intent = await parseIntent(text.trim());
  logger.info(`Web command: "${text}" → ${JSON.stringify(intent)}`);

  const { ok, reason } = validateAction(intent);
  if (!ok) return { ok: false, message: reason, intent };

  // Destructive actions are auto-denied via API (no terminal to confirm in)
  const { ACTION_MAP } = require('../safety/guard');
  if (ACTION_MAP[intent.action]?.destructive) {
    return {
      ok: false,
      message: `"${intent.action}" is a destructive action — confirm it manually via the CLI (node index.js --launch).`,
      intent,
    };
  }

  const page = await getActivePage();
  const result = await executeAction(intent.action, page, intent.params);
  logger.info('Action executed', { action: intent.action, params: intent.params, ...result });
  return { ok: result.success, message: result.message, intent };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Text command
app.post('/command', async (req, res) => {
  try {
    const { text } = req.body;
    if (!text) return res.status(400).json({ ok: false, message: '"text" is required.' });
    const result = await runCommand(text);
    res.json(result);
  } catch (err) {
    logger.error(`/command error: ${err.message}`);
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Voice command (audio upload → Whisper → run)
app.post('/voice', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No audio file uploaded.' });

  const tmpPath = req.file.path;
  // Rename to .webm or .wav so Whisper accepts it
  const ext = req.file.originalname?.split('.').pop() || 'webm';
  const audioPath = `${tmpPath}.${ext}`;
  fs.renameSync(tmpPath, audioPath);

  try {
    logger.info(`Transcribing uploaded audio (${req.file.size} bytes) ...`);
    const response = await openai.audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(audioPath),
      language: 'en',
    });
    const text = response.text.trim();
    logger.info(`Transcribed: "${text}"`);

    const result = await runCommand(text);
    res.json({ ...result, transcript: text });
  } catch (err) {
    logger.error(`/voice error: ${err.message}`);
    res.status(500).json({ ok: false, message: err.message });
  } finally {
    fs.unlink(audioPath, () => {});
  }
});

// Screenshot of current headless browser state
app.get('/screenshot', async (req, res) => {
  try {
    const page = await getActivePage();
    const buf  = await page.screenshot({ fullPage: false });
    res.setHeader('Content-Type', 'image/png');
    res.send(buf);
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

// Health check
app.get('/status', async (req, res) => {
  try {
    const page = await getActivePage();
    res.json({ ok: true, url: page.url(), timestamp: new Date().toISOString() });
  } catch (err) {
    res.json({ ok: false, message: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────────────────────

async function start() {
  if (!process.env.OPENAI_API_KEY || process.env.OPENAI_API_KEY === 'YOUR_API_KEY_HERE') {
    console.error('\n[ERROR] OPENAI_API_KEY not set. Edit .env and add your key, then restart.\n');
    process.exit(1);
  }

  // Pre-connect browser so first command is instant
  try {
    await connectBrowser();
    const page = await getActivePage();
    logger.info(`Browser ready. Active page: ${page.url()}`);
  } catch (err) {
    logger.error(`Browser failed to start: ${err.message}`);
    process.exit(1);
  }

  app.listen(PORT, () => {
    logger.info(`\n✓ Browser MCP server running at http://localhost:${PORT}\n`);
  });
}

start().catch((err) => {
  logger.error(`Fatal: ${err.message}`);
  process.exit(1);
});
