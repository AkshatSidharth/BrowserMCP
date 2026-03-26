'use strict';

require('dotenv').config();
const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const express = require('express');
const multer  = require('multer');
const { OpenAI } = require('openai');

const logger            = require('../logger');
const { getActivePage, connectBrowser } = require('../browser/connect');
const { parseIntent }   = require('../brain/intentParser');
const { validateAction } = require('../safety/guard');
const { executeAction }  = require('../actions');

const app    = express();
const upload = multer({ dest: os.tmpdir() });
const PORT   = parseInt(process.env.PORT || '3000', 10);

let _openai = null;
const getOpenAI = () => {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
};

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── SSE helpers ──────────────────────────────────────────────────────────────
// Server-Sent Events let us push real-time step updates to the browser UI
// while the agent loop is running (can take 10–60 seconds for complex tasks).

function initSSE(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function sendSSE(res, data) {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

// ─── Core command runner ───────────────────────────────────────────────────────

async function runCommand(text, onStep) {
  if (!text?.trim()) return { ok: false, message: 'Empty command.' };

  const intent = await parseIntent(text.trim());
  logger.info(`Command: "${text}" → action="${intent.action}" params=${JSON.stringify(intent.params)}`);

  const { ok, reason } = validateAction(intent);
  if (!ok) return { ok: false, message: reason, intent };

  const { ACTION_MAP } = require('../safety/guard');
  if (ACTION_MAP[intent.action]?.destructive) {
    return { ok: false, message: `"${intent.action}" is destructive — run from CLI to confirm.`, intent };
  }

  // desktop_act doesn't need a browser page — runs native desktop automation
  let result;
  if (intent.action === 'desktop_act') {
    const { runDesktopAgent } = require('../brain/desktopAgent');
    result = await runDesktopAgent(intent.params.command, onStep);
  } else {
    const page = await getActivePage();

    // smart_act gets the onStep callback for real-time streaming
    if (intent.action === 'smart_act') {
      const { runAgentLoop } = require('../brain/agentLoop');
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      result = await runAgentLoop(page, intent.params.command, onStep);
    } else {
      result = await executeAction(intent.action, page, intent.params);
    }
  }

  logger.info('Done', { action: intent.action, success: result.success });
  return { ok: result.success, message: result.message, intent };
}

// ─── POST /command  (SSE streaming response) ──────────────────────────────────
app.post('/command', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ ok: false, message: '"text" is required.' });

  initSSE(res);

  // Stream each agent step back to the UI in real time
  const onStep = (stepDesc) => sendSSE(res, { type: 'step', message: stepDesc });

  try {
    sendSSE(res, { type: 'step', message: `Parsing: "${text}"` });
    const result = await runCommand(text, onStep);
    sendSSE(res, { type: 'done', ...result });
  } catch (err) {
    logger.error(`/command error: ${err.message}`);
    sendSSE(res, { type: 'done', ok: false, message: err.message });
  } finally {
    res.end();
  }
});

// ─── POST /voice  (audio → Whisper → SSE) ────────────────────────────────────
app.post('/voice', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, message: 'No audio file uploaded.' });

  const tmpPath   = req.file.path;
  const ext       = (req.file.originalname?.split('.').pop()) || 'webm';
  const audioPath = `${tmpPath}.${ext}`;
  fs.renameSync(tmpPath, audioPath);

  initSSE(res);

  try {
    sendSSE(res, { type: 'step', message: 'Transcribing with Whisper ...' });
    const response = await getOpenAI().audio.transcriptions.create({
      model: 'whisper-1',
      file: fs.createReadStream(audioPath),
      language: 'en',
    });
    const text = response.text.trim();
    logger.info(`Transcribed: "${text}"`);
    sendSSE(res, { type: 'transcript', text });
    sendSSE(res, { type: 'step', message: `Heard: "${text}"` });

    const onStep = (stepDesc) => sendSSE(res, { type: 'step', message: stepDesc });
    const result = await runCommand(text, onStep);
    sendSSE(res, { type: 'done', ...result });
  } catch (err) {
    logger.error(`/voice error: ${err.message}`);
    sendSSE(res, { type: 'done', ok: false, message: err.message });
  } finally {
    fs.unlink(audioPath, () => {});
    res.end();
  }
});

// ─── GET /screenshot ──────────────────────────────────────────────────────────
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

// ─── GET /status ──────────────────────────────────────────────────────────────
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
    console.error('\n[ERROR] OPENAI_API_KEY not set. Edit .env and add your key.\n');
    process.exit(1);
  }
  try {
    await connectBrowser();
    const page = await getActivePage();
    logger.info(`Browser ready: ${page.url()}`);
  } catch (err) {
    logger.error(`Browser failed: ${err.message}`);
    process.exit(1);
  }
  app.listen(PORT, () => logger.info(`\n✓ Browser MCP running at http://localhost:${PORT}\n`));
}

start().catch((err) => { logger.error(`Fatal: ${err.message}`); process.exit(1); });
