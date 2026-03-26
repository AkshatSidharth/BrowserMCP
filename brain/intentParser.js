'use strict';

require('dotenv').config();
const { OpenAI } = require('openai');
const logger = require('../logger');
const { ALLOWED_ACTIONS } = require('../safety/guard');

// Lazy singleton — instantiated on first use so dotenv always loads first
let _openai = null;
function getClient() {
  if (!_openai) {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error('OPENAI_API_KEY is not set. Create a .env file (see .env.example).');
    }
    _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return _openai;
}

const LLM_MODEL = () => process.env.LLM_MODEL || 'gpt-4o';

// ─── System prompt ────────────────────────────────────────────────────────────
// The LLM is instructed to output ONLY valid JSON — no prose, no markdown.
// This strict schema prevents the AI from fabricating arbitrary browser commands.

function buildSystemPrompt() {
  const actionList = ALLOWED_ACTIONS.map(a =>
    `  - "${a.name}": ${a.description}  params: ${JSON.stringify(a.params)}`
  ).join('\n');

  return `
You are an intent parser for a voice-controlled browser automation agent.
The user speaks naturally — including in mixed languages (Hinglish, etc). Understand the intent regardless of language.

Your ONLY job: convert the user's command into ONE structured JSON action.

Available actions:
${actionList}

Rules:
1. Output ONLY a single valid JSON object — no markdown, no explanation.
2. "go back" / "previous page" / "wapas jao" with NO site name → use go_back. But "come back to X" / "go back to X" / "switch to X tab" with a SITE NAME → use open_website with site=X.
3. If the user says "open X app" or "launch X app" or "X app kholdo" (explicitly says "app") → use desktop_act.
4. For SYSTEM SETTINGS navigation — any mention of a macOS settings panel: wifi, bluetooth, network, accessibility, appearance, displays, sound, battery, notifications, privacy, security, wallpaper, screensaver, focus, siri, keyboard, mouse, trackpad, users, storage, airdrop, general, login items, spotlight → use desktop_act. This includes "click on accessibility", "go to wifi", "look for bluetooth", "open display settings", "take me to notifications", "go to sound" etc.
5. For CLOSE TAB ("close this tab", "close tab", "close it", "tab band karo") → use close_tab.
6. For plain WEBSITE NAVIGATION with no content intent — opening a site OR switching to an existing tab ("open Gmail", "open Instagram", "go to YouTube", "new tab", "go back to Flipkart", "come back to YouTube", "switch to Facebook tab", "Flipkart tab pe jao") → use open_website or new_tab. BUT if the user wants specific content ("open lo-fi videos on YouTube", "search YouTube for X") → use smart_act.
7. For NATIVE DESKTOP actions — ("open Notes", "open Calendar", "open Finder", "write a mail using Mail app", "press keyboard shortcut") → use desktop_act.
8. For COMPOSE/EMAIL tasks ("write an email to X", "compose email to X", "send a mail") → use desktop_act.
9. For SEARCH/FIND tasks on a website ("search for X on YouTube", "find a video of X", "search X on Amazon") → use smart_act.
10. For EVERYTHING ELSE interacting with the current browser page → use smart_act.
11. smart_act is ONLY for browser pages — entering text, clicking buttons in a website, logging in, filling forms, OTP.
12. Extract values the user mentions — phone numbers, emails, names, passwords — and include in command param.
13. Never return "unknown".

Output schema:
{ "action": "<action_name>", "params": { ... } }
`.trim();
}

// ─── Parse intent ─────────────────────────────────────────────────────────────

/**
 * Send user text to the LLM and return a validated intent object.
 *
 * @param {string} text  Raw transcribed (or typed) user command
 * @returns {{ action: string, params: Record<string, string> }}
 */
async function parseIntent(text) {
  logger.debug(`Parsing intent for: "${text}"`);

  const response = await getClient().chat.completions.create({
    model: LLM_MODEL(),
    temperature: 0,            // Deterministic output
    max_completion_tokens: 256,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user',   content: text },
    ],
  });

  const raw = response.choices[0].message.content.trim();
  logger.debug(`LLM raw response: ${raw}`);

  let intent;
  try {
    intent = JSON.parse(raw);
  } catch {
    logger.warn(`LLM returned non-JSON: ${raw}`);
    return { action: 'unknown', params: {} };
  }

  // Normalize
  if (!intent.action || typeof intent.action !== 'string') {
    intent.action = 'unknown';
  }
  if (!intent.params || typeof intent.params !== 'object') {
    intent.params = {};
  }

  logger.info(`Intent: action="${intent.action}"  params=${JSON.stringify(intent.params)}`);
  return intent;
}

module.exports = { parseIntent };
