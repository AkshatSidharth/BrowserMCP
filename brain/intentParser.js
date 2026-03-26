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

Your ONLY job is to convert a natural language command into a structured JSON action.

Available actions:
${actionList}

Rules:
1. Output ONLY a single valid JSON object — no markdown, no explanation.
2. Choose the closest matching action from the list above.
3. If no action matches, use action "unknown" with params {}.
4. Extract parameter values exactly as the user said them.
5. For the "query" param, preserve the user's exact search terms.

Output schema:
{
  "action": "<action_name>",
  "params": { ... }
}
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
    max_tokens: 256,
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
