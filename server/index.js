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

// ─── Conversational context window ────────────────────────────────────────────
// Rolling window of last 5 raw commands. Passed to the intent parser so it can
// resolve fragments ("it", "again", "the song", "any Eminem song" after "play").

const _cmdHistory = [];

function pushHistory(text) {
  _cmdHistory.push(text);
  if (_cmdHistory.length > 5) _cmdHistory.shift();
}

function getRecentContext() {
  // Only include the last 3 (enough context, not too noisy)
  return _cmdHistory.slice(-3).map((c, i) => `${i + 1}. "${c}"`).join('\n');
}

// ─── Core command runner ───────────────────────────────────────────────────────

async function runCommand(text, onStep, _isSubCommand = false) {
  if (!text?.trim()) return { ok: false, message: 'Empty command.' };

  // Build context from recent history (skip for sub-commands — they already
  // have the right context baked in from compound_act splitting)
  const context = _isSubCommand ? '' : getRecentContext();
  const intent  = await parseIntent(text.trim(), context);

  // Track in history (top-level commands only)
  if (!_isSubCommand) pushHistory(text.trim());
  logger.info(`Command: "${text}" → action="${intent.action}" params=${JSON.stringify(intent.params)}`);

  const { ok, reason } = validateAction(intent);
  if (!ok) return { ok: false, message: reason, intent };

  const { ACTION_MAP } = require('../safety/guard');
  if (ACTION_MAP[intent.action]?.destructive) {
    return { ok: false, message: `"${intent.action}" is destructive — run from CLI to confirm.`, intent };
  }

  // Actions that don't need a browser page
  let result;
  if (intent.action === 'desktop_act') {
    const { runDesktopAgent } = require('../brain/desktopAgent');
    result = await runDesktopAgent(intent.params.command, onStep);
  } else if (intent.action === 'kapture_act') {
    const { dispatchCrmCommand } = require('../brain/kaptureAgent');
    result = await dispatchCrmCommand(intent.params.command, onStep);
  } else if (intent.action === 'compound_act') {
    // Run each sub-command sequentially, streaming steps back to UI
    const steps = Array.isArray(intent.params.steps) ? intent.params.steps : [];
    if (!steps.length) return { ok: false, message: 'compound_act: no steps provided.', intent };
    const results = [];
    for (let i = 0; i < steps.length; i++) {
      const sub = steps[i];
      if (onStep) onStep(`[${i + 1}/${steps.length}] ${sub}`);
      const subResult = await runCommand(sub, onStep, true);
      results.push({ step: sub, ...subResult });
      if (!subResult.ok) {
        // Continue on failure — don't abort the whole sequence
        logger.warn(`compound_act step ${i + 1} failed: ${subResult.message}`);
      }
    }
    const allOk = results.every(r => r.ok);
    const summary = results.map((r, i) => `${i + 1}. ${r.step}: ${r.ok ? '✓' : '✗ ' + r.message}`).join('\n');
    result = { success: allOk, message: summary };
  } else {
    const page = await getActivePage();

    // smart_act gets the onStep callback for real-time streaming
    if (intent.action === 'smart_act') {
      const { runAgentLoop } = require('../brain/agentLoop');
      // If page is blank/unloaded, don't try to screenshot it
      const currentUrl = page.url();
      if (!currentUrl || currentUrl === 'about:blank') {
        result = { success: false, message: 'No browser page is open. Say "open YouTube" or a website first.' };
      } else {
        await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
        result = await runAgentLoop(page, intent.params.command, onStep, context);
      }
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
      // No language lock — auto-detect handles English, Hindi, Hinglish
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
    const page   = await getActivePage();
    // Use CDP directly (Chrome DevTools MCP technique) to avoid font-loading hang
    let buf;
    try {
      const client = await page.context().newCDPSession(page);
      const { data } = await client.send('Page.captureScreenshot', { format: 'png', optimizeForSpeed: true });
      await client.detach().catch(() => {});
      buf = Buffer.from(data, 'base64');
    } catch {
      buf = await page.screenshot({ fullPage: false, timeout: 8000 });
    }
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
