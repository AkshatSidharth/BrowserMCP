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
2. If the user says "open X app" or "launch X app" or "X app kholdo" (explicitly says "app") → use desktop_act with command=the full request, so the OS launches the installed app.
3. For plain NAVIGATION without "app" — websites, web URLs ("open Gmail", "open Instagram", "go to YouTube", "X kholo", "new tab") → use open_website or new_tab.
4. For NATIVE DESKTOP actions — ("open Notes", "open Calendar", "open Finder", "write a mail using Mail app", "press keyboard shortcut", "type something on desktop") → use desktop_act.
5. For COMPOSE/EMAIL tasks ("write an email to X", "compose email to X", "send a mail") → use desktop_act so the agent can fill in To, Subject, Body.
6. For SEARCH/FIND tasks on a website ("search for X on YouTube", "find a video of X", "look up X", "search X on Amazon/Flipkart") → use smart_act. The agent will navigate to the site, type in the search bar, and scroll through results like a human.
7. For EVERYTHING ELSE that involves interacting with the current browser page → use smart_act with command=the user's full intent.
   This includes: entering text, clicking buttons, logging in, filling forms, entering OTP, scrolling, anything on the page.
8. smart_act is the PREFERRED action for any browser page interaction — it reads the DOM and figures out the steps itself.
8. Extract values the user mentions — phone numbers, emails, names, passwords — and include them in the command param.
9. Never return "unknown".

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
