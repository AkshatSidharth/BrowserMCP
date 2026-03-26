'use strict';

require('dotenv').config();
const { OpenAI }    = require('openai');
const { exec }      = require('child_process');
const { promisify } = require('util');
const fs            = require('fs');
const os            = require('os');
const path          = require('path');
const logger        = require('../logger');

const execAsync = promisify(exec);

let _openai = null;
const getClient = () => {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
};

const MAX_STEPS = 20;

// ─── Screenshot + dimensions ──────────────────────────────────────────────────
async function takeDesktopScreenshot() {
  const outPath = path.join(os.tmpdir(), `desktop-${Date.now()}.png`);

  if (process.platform === 'darwin') {
    await execAsync(`screencapture -x "${outPath}"`);
  } else if (process.platform === 'linux') {
    try { await execAsync(`scrot "${outPath}"`); }
    catch { await execAsync(`import -window root "${outPath}"`); }
  } else {
    throw new Error('Unsupported platform for desktop screenshot.');
  }

  // Get pixel dimensions (needed so GPT-4o knows coordinate space)
  let width = 1920, height = 1080;
  try {
    const { stdout } = await execAsync(`sips -g pixelWidth -g pixelHeight "${outPath}"`);
    const w = stdout.match(/pixelWidth:\s+(\d+)/);
    const h = stdout.match(/pixelHeight:\s+(\d+)/);
    if (w && h) { width = parseInt(w[1]); height = parseInt(h[1]); }
  } catch { /* sips not available on Linux, use defaults */ }

  const base64 = fs.readFileSync(outPath).toString('base64');
  fs.unlink(outPath, () => {});
  return { base64, width, height };
}

// ─── Execute one desktop step ─────────────────────────────────────────────────
async function executeDesktopStep(step) {
  const { type } = step;
  logger.info(`Desktop step: ${JSON.stringify(step)}`);

  switch (type) {

    case 'click_at': {
      // Click at pixel coordinates on screen — requires Accessibility permission
      const { x, y } = step;
      const script = `tell application "System Events" to click at {${x}, ${y}}`;
      await execAsync(`osascript -e '${script}'`);
      break;
    }

    case 'double_click_at': {
      const { x, y } = step;
      const script = `tell application "System Events" to double click at {${x}, ${y}}`;
      await execAsync(`osascript -e '${script}'`);
      break;
    }

    case 'right_click_at': {
      const { x, y } = step;
      // cliclick is more reliable for right-click; fall back to AppleScript
      await execAsync(`cliclick rc:${x},${y}`).catch(() =>
        execAsync(`osascript -e 'tell application "System Events" to right click at {${x}, ${y}}'`)
      );
      break;
    }

    case 'scroll_at': {
      // scroll_direction: "up"|"down", amount: number of ticks
      const { x, y, direction = 'down', amount = 3 } = step;
      const delta = direction === 'up' ? amount : -amount;
      await execAsync(`osascript -e 'tell application "System Events" to scroll at {${x}, ${y}} by ${delta}'`)
        .catch(() => logger.warn('scroll_at not supported on this macOS version'));
      break;
    }

    case 'applescript_file': {
      const tmpFile = path.join(os.tmpdir(), `mcp-script-${Date.now()}.scpt`);
      fs.writeFileSync(tmpFile, step.code);
      const { stdout } = await execAsync(`osascript "${tmpFile}"`).catch(e => ({ stdout: e.message }));
      fs.unlink(tmpFile, () => {});
      return stdout.trim();
    }

    case 'applescript': {
      const escaped = step.code.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
      const { stdout } = await execAsync(`osascript -e '${escaped}'`).catch(e => ({ stdout: e.message }));
      return stdout.trim();
    }

    case 'shell': {
      const { stdout } = await execAsync(step.command, { timeout: 15000 }).catch(e => ({ stdout: e.message }));
      return stdout.trim();
    }

    case 'type_text': {
      const safe = step.text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      await execAsync(`osascript -e 'tell application "System Events" to keystroke "${safe}"'`);
      break;
    }

    case 'key_combo': {
      const keys = step.keys || [];
      const last  = keys[keys.length - 1];
      const mods  = keys.slice(0, -1).map(k => `${k} down`).join(', ');
      const using = mods ? ` using {${mods}}` : '';
      await execAsync(`osascript -e 'tell application "System Events" to keystroke "${last}"${using}'`);
      break;
    }

    case 'open_settings_panel': {
      // Open a specific macOS System Settings panel via URL scheme — no Accessibility needed
      const PANEL_URLS = {
        wifi:        'x-apple.systempreferences:com.apple.wifi-settings-extension',
        bluetooth:   'x-apple.systempreferences:com.apple.Bluetooth-Settings.extension',
        network:     'x-apple.systempreferences:com.apple.Network-Settings.extension',
        display:     'x-apple.systempreferences:com.apple.Displays-Settings.extension',
        sound:       'x-apple.systempreferences:com.apple.Sound-Settings.extension',
        battery:     'x-apple.systempreferences:com.apple.Battery-Settings.extension',
        notifications:'x-apple.systempreferences:com.apple.Notifications-Settings.extension',
        privacy:     'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension',
        appearance:  'x-apple.systempreferences:com.apple.Appearance-Settings.extension',
        wallpaper:   'x-apple.systempreferences:com.apple.Wallpaper-Settings.extension',
        screensaver: 'x-apple.systempreferences:com.apple.ScreenSaver-Settings.extension',
        accessibility:'x-apple.systempreferences:com.apple.Accessibility-Settings.extension',
        focus:       'x-apple.systempreferences:com.apple.Focus-Settings.extension',
        storage:     'x-apple.systempreferences:com.apple.settings.Storage',
        general:     'x-apple.systempreferences:com.apple.General-Settings.extension',
        airdrop:     'x-apple.systempreferences:com.apple.AirDrop-Handoff-Settings.extension',
        users:       'x-apple.systempreferences:com.apple.Users-Groups-Settings.extension',
        keyboard:    'x-apple.systempreferences:com.apple.Keyboard-Settings.extension',
        mouse:       'x-apple.systempreferences:com.apple.Mouse-Settings.extension',
        trackpad:    'x-apple.systempreferences:com.apple.Trackpad-Settings.extension',
        siri:        'x-apple.systempreferences:com.apple.Siri-Settings.extension',
        vpn:         'x-apple.systempreferences:com.apple.NetworkExtensionSettingsUI.NESettingsUIExtension',
      };
      const key = (step.panel || '').toLowerCase();
      const url = PANEL_URLS[key] || `x-apple.systempreferences:`;
      await execAsync(`open "${url}"`);
      await new Promise(r => setTimeout(r, 1200));
      break;
    }

    case 'open_app': {
      await execAsync(`open -a "${step.app}"`).catch(async () => {
        await execAsync(`open "${step.app}"`);
      });
      await new Promise(r => setTimeout(r, step.wait_ms || 1800));
      break;
    }

    case 'open_url': {
      await execAsync(`open "${step.url}"`);
      break;
    }

    case 'focus_app': {
      await execAsync(`osascript -e 'tell application "${step.app}" to activate'`);
      await new Promise(r => setTimeout(r, 500));
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
function buildSystemPrompt(width, height) {
  // On Retina Macs the screenshot is 2x physical pixels but System Events
  // uses LOGICAL coordinates (half the physical). Tell GPT-4o about this.
  const isRetina = width > 2000;
  const logicalW = isRetina ? Math.round(width  / 2) : width;
  const logicalH = isRetina ? Math.round(height / 2) : height;
  const retinaNote = isRetina
    ? `IMPORTANT: This is a Retina display. Screenshot is ${width}x${height} physical pixels but logical coordinates are ${logicalW}x${logicalH}. ALL x,y coordinates you return MUST be in LOGICAL pixels (divide screenshot pixel position by 2).`
    : `Screen logical size: ${width}x${height}. Use these pixel coordinates directly for click_at.`;

  return `
You are a macOS desktop vision agent. You see a real screenshot of the user's screen.
Your job: look at what is visible on screen and return exact JSON steps to complete the user's goal.

${retinaNote}

Available step types:
- click_at: click at a pixel position on screen — PREFERRED for anything visible on screen
  → {"type":"click_at", "x":350, "y":240, "description":"Click Wi-Fi in sidebar"}
- double_click_at: double-click at position
  → {"type":"double_click_at", "x":200, "y":300, "description":"Open folder"}
- right_click_at: right-click at position
  → {"type":"right_click_at", "x":200, "y":300, "description":"Right-click desktop"}
- scroll_at: scroll at position
  → {"type":"scroll_at", "x":500, "y":400, "direction":"down", "amount":3, "description":"Scroll down"}
- type_text: type text at current cursor
  → {"type":"type_text", "text":"Hello", "description":"Type search query"}
- key_combo: keyboard shortcut
  → {"type":"key_combo", "keys":["command","space"], "description":"Open Spotlight"}
- open_settings_panel: open a specific macOS System Settings panel directly (NO Accessibility needed)
  → {"type":"open_settings_panel", "panel":"wifi", "description":"Open Wi-Fi settings"}
  Available panels: wifi, bluetooth, network, display, sound, battery, notifications, privacy,
  appearance, wallpaper, screensaver, accessibility, focus, storage, general, airdrop,
  users, keyboard, mouse, trackpad, siri, vpn
- open_app: open a Mac application by name
  → {"type":"open_app", "app":"System Settings", "wait_ms":2000, "description":"Open System Settings"}
- focus_app: bring an app to front
  → {"type":"focus_app", "app":"Finder", "description":"Focus Finder"}
- open_url: open a URL in default browser
  → {"type":"open_url", "url":"https://mail.google.com/mail/u/0/#compose", "description":"Open Gmail compose"}
- applescript_file: run multi-line AppleScript for complex app control
  → {"type":"applescript_file", "code":"tell application \\"Mail\\"\\n...\\nend tell", "description":"..."}
- shell: run a shell command
  → {"type":"shell", "command":"open -a 'System Settings'", "description":"..."}
- wait: pause
  → {"type":"wait", "ms":1500, "description":"Wait for app to load"}
- done: goal achieved
  → {"type":"done", "message":"Opened System Settings Wi-Fi panel"}
- failed: cannot complete
  → {"type":"failed", "message":"reason"}

Strategy:
1. For ANY System Settings / System Preferences panel → ALWAYS use open_settings_panel with the panel name. Never use click_at for System Settings navigation. This works without any permissions.
2. For other apps: look at the screenshot. If you can see the target element → use click_at with exact coordinates.
3. If the target app is not open yet → use open_app first, then wait, then click_at on the UI element.
4. For typing: click_at on the input field first, then type_text.
5. For email/compose: prefer open_url to Gmail compose page — it's simpler than Mail.app.
6. Return ONE logical sequence of steps. Be precise with coordinates — look carefully at the screenshot.

Output ONLY valid JSON: {"steps": [...]}
`.trim();
}

// ─── Main desktop agent loop ──────────────────────────────────────────────────
async function runDesktopAgent(goal, onStep) {
  logger.info(`Desktop agent: "${goal}"`);

  const history  = [];
  let   lastDims = { width: 1920, height: 1080 };

  for (let i = 0; i < MAX_STEPS; i++) {
    // 1. Take screenshot (with dimensions)
    let base64 = null;
    try {
      const shot = await takeDesktopScreenshot();
      base64     = shot.base64;
      lastDims   = { width: shot.width, height: shot.height };
    } catch (err) {
      logger.warn(`Screenshot failed: ${err.message}`);
      if (onStep && i === 0) onStep('⚠ No Screen Recording permission — running in text-only mode. Grant it in System Settings → Privacy & Security → Screen Recording.');
    }

    // 2. Build prompt
    const historyText = history.length
      ? `\nSteps completed so far:\n${history.map((h, j) => `${j + 1}. ${h}`).join('\n')}`
      : '';
    const goalText = `GOAL: ${goal}${historyText}\n\nLook at the screenshot and return the next steps.`;

    const userContent = base64
      ? [
          { type: 'image_url', image_url: { url: `data:image/png;base64,${base64}`, detail: 'high' } },
          { type: 'text', text: goalText },
        ]
      : `${goalText}\n\n(No screenshot — use macOS knowledge to plan steps without visual context.)`;

    // 3. Ask GPT-4o
    const response = await getClient().chat.completions.create({
      model: process.env.LLM_MODEL || 'gpt-4o',
      temperature: 0,
      max_completion_tokens: 1500,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildSystemPrompt(lastDims.width, lastDims.height) },
        { role: 'user',   content: userContent },
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

    // 4. Execute steps
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
        const desc   = step.description || step.type;
        history.push(desc);
        if (onStep) onStep(`⚡ ${desc}`);
        logger.info(`Desktop step OK: ${desc}${result ? ` → ${result}` : ''}`);
      } catch (err) {
        logger.warn(`Desktop step failed: ${err.message}`);
        if (onStep) onStep(`⚠ ${step.description || step.type} failed: ${err.message}`);
      }

      // Small pause between steps so UI has time to react
      await new Promise(r => setTimeout(r, 500));
    }

    // If no done/failed step returned, loop and re-screenshot to verify progress
  }

  return { success: false, message: 'Max steps reached.', steps: history };
}

module.exports = { runDesktopAgent, takeDesktopScreenshot };
