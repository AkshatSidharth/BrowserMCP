'use strict';

require('dotenv').config();
const { OpenAI }      = require('openai');
const { exec }        = require('child_process');
const { promisify }   = require('util');
const fs              = require('fs');
const os              = require('os');
const path            = require('path');
const logger          = require('../logger');

const execAsync = promisify(exec);

let _openai = null;
const getClient = () => {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
};

const MAX_STEPS = 15;

// ─── Screenshot of full desktop ───────────────────────────────────────────────
async function takeDesktopScreenshot() {
  const outPath = path.join(os.tmpdir(), `desktop-${Date.now()}.png`);
  const platform = process.platform;

  if (platform === 'darwin') {
    await execAsync(`screencapture -x "${outPath}"`);
  } else if (platform === 'linux') {
    // Try scrot, then import (ImageMagick), then xwd
    try {
      await execAsync(`scrot "${outPath}"`);
    } catch {
      try {
        await execAsync(`import -window root "${outPath}"`);
      } catch {
        throw new Error('No screenshot tool found. Install scrot: sudo apt install scrot');
      }
    }
  } else {
    throw new Error('Desktop screenshots not supported on this platform yet.');
  }

  const buf    = fs.readFileSync(outPath);
  fs.unlink(outPath, () => {});
  return buf.toString('base64');
}

// ─── Execute one desktop step ─────────────────────────────────────────────────
async function executeDesktopStep(step) {
  const { type } = step;
  logger.info(`Desktop step: ${JSON.stringify(step)}`);

  switch (type) {

    case 'applescript': {
      // Run arbitrary AppleScript — most powerful option on Mac
      const escaped = step.code.replace(/"/g, '\\"');
      const { stdout, stderr } = await execAsync(`osascript -e "${escaped}"`).catch(e => ({ stdout: '', stderr: e.message }));
      if (stderr && !stderr.includes('Warning')) logger.warn(`AppleScript stderr: ${stderr}`);
      return stdout.trim();
    }

    case 'applescript_file': {
      // Write AppleScript to a temp file and run it (for multi-line scripts)
      const tmpFile = path.join(os.tmpdir(), `mcp-script-${Date.now()}.scpt`);
      fs.writeFileSync(tmpFile, step.code);
      const { stdout } = await execAsync(`osascript "${tmpFile}"`).catch(e => ({ stdout: e.message }));
      fs.unlink(tmpFile, () => {});
      return stdout.trim();
    }

    case 'shell': {
      const { stdout } = await execAsync(step.command, { timeout: 15000 }).catch(e => ({ stdout: e.message }));
      return stdout.trim();
    }

    case 'type_text': {
      // Type text at the current cursor position using AppleScript
      const safe = step.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await execAsync(`osascript -e 'tell application "System Events" to keystroke "${safe}"'`);
      break;
    }

    case 'key_combo': {
      // Press a keyboard shortcut e.g. {"keys": ["command", "return"]}
      // or {"keys": ["command", "shift", "n"]}
      const keys = step.keys || [];
      const last = keys[keys.length - 1];
      const mods = keys.slice(0, -1).map(k => `${k} down`).join(', ');
      const usingClause = mods ? ` using {${mods}}` : '';
      await execAsync(`osascript -e 'tell application "System Events" to keystroke "${last}"${usingClause}'`);
      break;
    }

    case 'open_app': {
      await execAsync(`open -a "${step.app}"`);
      await new Promise(r => setTimeout(r, step.wait_ms || 1500));
      break;
    }

    case 'open_url': {
      await execAsync(`open "${step.url}"`);
      break;
    }

    case 'wait': {
      await new Promise(r => setTimeout(r, step.ms || 1000));
      break;
    }

    default:
      logger.warn(`Unknown desktop step type: ${type}`);
  }
}

// ─── System prompt ────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are a macOS desktop automation agent. You see a screenshot of the user's screen.
Your job: return step-by-step JSON actions to complete the user's goal on the desktop.

Available step types:
- applescript_file: run multi-line AppleScript (PREFERRED for complex app control)
  → {"type":"applescript_file", "code":"tell application \\"Mail\\"\\n...\\nend tell", "description":"..."}
- shell: run a terminal command
  → {"type":"shell", "command":"open -a Notes", "description":"..."}
- type_text: type text at current cursor (after focusing a field)
  → {"type":"type_text", "text":"Hello World", "description":"..."}
- key_combo: keyboard shortcut
  → {"type":"key_combo", "keys":["command","return"], "description":"Send email"}
- open_app: open a Mac application
  → {"type":"open_app", "app":"Mail", "wait_ms":2000, "description":"Open Mail app"}
- open_url: open a URL in default browser
  → {"type":"open_url", "url":"https://mail.google.com/mail/u/0/#compose", "description":"..."}
- wait: pause for a moment
  → {"type":"wait", "ms":1500, "description":"Wait for app to open"}
- done: task complete
  → {"type":"done", "message":"..."}
- failed: cannot complete, explain why
  → {"type":"failed", "message":"..."}

Rules:
1. Output ONLY valid JSON: {"steps": [...]}
2. For email/compose tasks, prefer opening Gmail in browser via open_url — it's simpler and more reliable than Mail.app AppleScript.
3. For Mail.app, use applescript_file with proper multi-line AppleScript.
4. For typing into apps, first focus the app/field, then use type_text.
5. For keyboard shortcuts: command=command, shift=shift, option=option, control=control.
6. Be specific — if user says "write a mail to X about Y", compose with To, Subject, Body all filled.
7. Keep scripts short and reliable. Prefer shell commands for simple tasks.

Common AppleScript patterns:
- Open Mail compose: tell app "Mail" → make new outgoing message
- Open Notes and type: tell app "Notes" → make new note → set body
- Focus app: tell app "X" to activate
`.trim();

// ─── Main desktop agent loop ──────────────────────────────────────────────────
async function runDesktopAgent(goal, onStep) {
  logger.info(`Desktop agent: "${goal}"`);

  const history = [];

  for (let i = 0; i < MAX_STEPS; i++) {
    // 1. Screenshot
    let base64;
    try {
      base64 = await takeDesktopScreenshot();
    } catch (err) {
      return { success: false, message: `Screenshot failed: ${err.message}` };
    }

    // 2. Ask GPT-4o
    const historyText = history.length
      ? `\nDone so far:\n${history.map((h, j) => `${j + 1}. ${h}`).join('\n')}`
      : '';

    const response = await getClient().chat.completions.create({
      model: process.env.LLM_MODEL || 'gpt-4o',
      temperature: 0,
      max_completion_tokens: 1024,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        {
          role: 'user',
          content: [
            { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'low' } },
            { type: 'text', text: `GOAL: ${goal}${historyText}\n\nReturn all steps needed to complete this goal.` },
          ],
        },
      ],
    });

    let plan;
    try {
      plan = JSON.parse(response.choices[0].message.content.trim());
    } catch {
      return { success: false, message: 'Could not parse GPT-4o response.' };
    }

    const steps = plan.steps || [];
    if (!steps.length) return { success: false, message: plan.message || 'No steps returned.' };

    // 3. Execute all steps in this plan
    for (const step of steps) {
      if (step.type === 'done') {
        if (onStep) onStep(`✓ ${step.message}`);
        return { success: true, message: step.message, steps: history };
      }
      if (step.type === 'failed') {
        if (onStep) onStep(`⚠ ${step.message}`);
        return { success: false, message: step.message, steps: history };
      }

      try {
        const result = await executeDesktopStep(step);
        const desc = step.description || step.type;
        history.push(desc);
        if (onStep) onStep(`⚡ ${desc}`);
        logger.info(`Desktop step done: ${desc}${result ? ` → ${result}` : ''}`);
      } catch (err) {
        logger.warn(`Desktop step failed: ${err.message}`);
        if (onStep) onStep(`⚠ ${step.description} failed: ${err.message}`);
      }

      await new Promise(r => setTimeout(r, 400));
    }

    // If the plan had no done/failed, treat it as complete after executing all steps
    return { success: true, message: `Done: ${history.join(' → ')}`, steps: history };
  }

  return { success: false, message: 'Max steps reached.', steps: history };
}

module.exports = { runDesktopAgent, takeDesktopScreenshot };
