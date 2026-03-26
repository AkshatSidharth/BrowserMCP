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
2. If the user says "open X app" or "launch X app" or "X app kholdo" (explicitly says "app") → use desktop_act.
3. For SYSTEM SETTINGS navigation — any mention of a macOS settings panel: wifi, bluetooth, network, accessibility, appearance, displays, sound, battery, notifications, privacy, security, wallpaper, screensaver, focus, siri, keyboard, mouse, trackpad, users, storage, airdrop, general, login items, spotlight → use desktop_act. This includes "click on accessibility", "go to wifi", "look for bluetooth", "open display settings", "take me to notifications", "go to sound" etc.
4. For plain WEBSITE NAVIGATION with no content intent — just opening a site ("open Gmail", "open Instagram", "go to YouTube", "new tab", "open youtube.com") → use open_website or new_tab. BUT if the user wants specific content ("open lo-fi videos on YouTube", "open MrBeast videos", "search YouTube for X") → use smart_act.
5. For NATIVE DESKTOP actions — ("open Notes", "open Calendar", "open Finder", "write a mail using Mail app", "press keyboard shortcut") → use desktop_act.
6. For COMPOSE/EMAIL tasks ("write an email to X", "compose email to X", "send a mail") → use desktop_act.
7. For SEARCH/FIND tasks on a website ("search for X on YouTube", "find a video of X", "search X on Amazon") → use smart_act.
8. For EVERYTHING ELSE interacting with the current browser page → use smart_act.
9. smart_act is ONLY for browser pages — entering text, clicking buttons in a website, logging in, filling forms, OTP.
10. Extract values the user mentions — phone numbers, emails, names, passwords — and include in command param.
11. Never return "unknown".

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
