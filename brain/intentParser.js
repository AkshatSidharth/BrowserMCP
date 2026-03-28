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
   SPECIAL: If the user says only "email" or "mail" or "gmail" with no other context → use open_website with site="gmail".
   SPECIAL: If the user says only "YouTube" or "Flipkart" or any site name alone → use open_website with that site.
7. For NATIVE DESKTOP actions — ("open Notes", "open Calendar", "open Finder", "write a mail using Mail app", "press keyboard shortcut") → use desktop_act.
8. For COMPOSE/EMAIL tasks ("write an email to X", "compose email to X", "send a mail") → use desktop_act.
9. For PLAYING/WATCHING videos or music ("play X", "watch X", "play the song again", "replay", "play it again", "phir se chalao", "dobara bajao") → use play_youtube_video with the song/video name as query. If the user says "play again" or "replay" without naming a specific song, still use play_youtube_video and put the last-mentioned song name or a generic query "last played song". NEVER route play/replay commands to smart_act.
16. For MEDIA CONTROLS on a playing video — pause, resume, mute, unmute, volume, seek, fullscreen → use media_act. NEVER use smart_act for these.
    - "pause" / "pause the video" / "ruk jao" / "band karo" → media_act, operation=pause
    - "play" / "resume" / "chalu karo" / "play karo" → media_act, operation=play
    - "mute" / "sound band karo" / "silent karo" → media_act, operation=mute
    - "unmute" / "sound chalu karo" / "volume on karo" → media_act, operation=unmute
    - "volume up" / "louder" / "aawaz badhao" → media_act, operation=volume_up
    - "volume down" / "softer" / "aawaz kam karo" → media_act, operation=volume_down
    - "skip ahead" / "forward 10 seconds" / "aage jao" → media_act, operation=seek_forward
    - "rewind" / "go back 10 seconds" / "peeche jao" → media_act, operation=seek_back
    - "fullscreen" / "full screen" → media_act, operation=fullscreen
    - "restart" / "from beginning" / "shuru se chalao" → media_act, operation=restart
    IMPORTANT: "pause" alone, "mute" alone, "volume up" alone — all media_act. Do NOT use smart_act.
17. For SCROLLING the current page → use scroll_act. NEVER use smart_act for scrolling.
    - "scroll down" / "neeche jao" / "neeche scroll karo" → scroll_act, direction=down
    - "scroll up" / "upar jao" / "upar scroll karo" → scroll_act, direction=up
    - "go to top" / "top pe jao" / "shuru mein jao" → scroll_act, direction=top
    - "go to bottom" / "neeche tak jao" / "end pe jao" → scroll_act, direction=bottom
10. For KAPTURE CRM operations — use kapture_act (NOT smart_act, NOT open_website). This includes:
    - Listing tickets: "show tickets", "pending tickets", "open tickets", "how many tickets", "kitne tickets hain"
    - Ticket details: "get ticket 123", "show ticket details", "ticket 456 ka status"
    - Assign ticket: "assign ticket 123 to Himanshu", "ticket assign karo"
    - Resolve ticket: "resolve ticket 456", "ticket close karo", "mark as resolved"
    - Reopen ticket: "reopen ticket 789"
    - Mark junk: "mark ticket as junk", "junk karo"
    - Employee search: "find employee John", "search agent Priya", "who is available"
    - Queue info: "show queues", "list queues", "queues dikhao"
    Set command param to the full natural language request including any IDs/names mentioned.
18. TAB SWITCH + ACTION — when the user says "go to X tab and [do something]" or "switch to X and [do something]", use compound_act with two steps: first switch tab, then the action.
    - "go to YouTube tab and pause" → {"action":"compound_act","params":{"steps":["open YouTube","pause the video"]}}
    - "YouTube tab pe jao aur pause karo" → {"action":"compound_act","params":{"steps":["open YouTube","pause the video"]}}
    - "switch to Flipkart and search for shoes" → {"action":"compound_act","params":{"steps":["open Flipkart","search for shoes on Flipkart"]}}
11. COMPOUND COMMANDS — use compound_act when the user wants 2 or more INDEPENDENT tasks on DIFFERENT sites/apps at the same time or in sequence. Examples:
    - "open Flipkart on one tab and YouTube on one tab, play X on YouTube and search Y on Flipkart"
    - "YouTube pe gaana bajao aur Flipkart pe kuch search karo"
    - "open Gmail and Amazon, check my emails and search for headphones"
    Break it into ordered steps. Each step must be a self-contained natural-language sub-command that could be parsed on its own. Steps involving the same site that depend on each other (search on Flipkart → filter results) are NOT compound — use smart_act for those.
    params.steps must be a JSON array of strings. Example:
    {"action":"compound_act","params":{"steps":["open YouTube","play Sochenge Tumhe Pyar Karun Ki Nahi song on YouTube","open Flipkart in new tab","search for Harry Potter book on Flipkart"]}}
12. For EVERYTHING ELSE interacting with the current browser page → use smart_act.
13. smart_act is ONLY for browser pages — entering text, clicking buttons in a website, logging in, filling forms, OTP.
14. Extract values the user mentions — phone numbers, emails, names, passwords — and include in command param.
15. Never return "unknown".
19. VALUE PROVISION — when the user gives a value for a field, use fill_input directly. Do NOT use smart_act.
    Patterns: "my number is X", "number is X", "it is X", "fill it with X", "type X", "enter X", "X hai mera number",
    "mera number X hai", "phone X", "email is X", "password is X"
    → fill_input with field=detected field type, value=the actual value
    Examples:
    - "my number is 6299291331" → fill_input, field="phone number", value="6299291331"
    - "mera number 9876543210 hai" → fill_input, field="phone number", value="9876543210"
    - "email is john@gmail.com" → fill_input, field="email", value="john@gmail.com"
    - "password is Pass@123" → fill_input, field="password", value="Pass@123"
    If no specific field is clear, use field="the active input field" and value=the number/text given.
21. PRICE-FILTERED SEARCH — when user says "search for X under/below/less than Y price on Flipkart/Amazon", use smart_act with the natural language command as-is (e.g. "search for AC under 10000 on Flipkart"). The agent will interact with the price filter UI elements directly on the page.

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
async function parseIntent(text, recentContext = '') {
  logger.debug(`Parsing intent for: "${text}"`);

  // Build user message — if we have recent context, prepend it so the LLM
  // can resolve fragments like "it", "again", "the song", "any Eminem song"
  const userMessage = recentContext
    ? `Recent commands (use to resolve fragments/pronouns in current command):\n${recentContext}\n\nCurrent command: "${text}"`
    : text;

  const response = await getClient().chat.completions.create({
    model: LLM_MODEL(),
    temperature: 0,            // Deterministic output
    max_completion_tokens: 256,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user',   content: userMessage },
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
