'use strict';

const readline = require('readline');
const logger = require('../logger');

// ─── Action catalogue ─────────────────────────────────────────────────────────
// Each entry describes one action that the LLM is allowed to dispatch.
// Add new actions here AND create a matching handler in actions/.

const ALLOWED_ACTIONS = [
  {
    name: 'new_tab',
    description: 'Open a new browser tab, optionally at a URL or site name. Use when user says "new tab", "open in new tab", "open a new tab with X".',
    params: { url: 'string — optional URL or site name to open in the new tab' },
    destructive: false,
  },
  {
    name: 'open_website',
    description: 'Open any website by name or URL. Use for "open Instagram", "go to Facebook", "open reddit" etc.',
    params: { site: 'string — site name like "instagram", "reddit" or full URL' },
    destructive: false,
  },
  {
    name: 'fill_input',
    description: 'Find an input field on the current page by its label/description and fill it with a value. Use for "enter my phone number", "type my email", "fill password field".',
    params: {
      field: 'string — description of the field, e.g. "phone number", "email", "password", "username"',
      value: 'string — the value to type into the field',
    },
    destructive: false,
  },
  {
    name: 'click_button',
    description: 'Find and click any button or link on the current page by its visible text. Use for "click next", "click log in", "click submit", "click send".',
    params: { text: 'string — visible text of the button/link to click, e.g. "Next", "Log in", "Send OTP"' },
    destructive: false,
  },
  {
    name: 'open_youtube',
    description: 'Open YouTube homepage in the browser.',
    params: {},
    destructive: false,
  },
  {
    name: 'open_youtube_channel',
    description: 'Open a specific YouTube channel by name or handle.',
    params: { channel: 'string — channel name or @handle, e.g. "whatthelogic" or "@MrBeast"' },
    destructive: false,
  },
  {
    name: 'play_youtube_video',
    description: 'Search YouTube for a video and play the first result. Use this when user says play, watch, or show a video.',
    params: { query: 'string — search terms, e.g. "whatthelogic latest video" or "MrBeast chocolate" ' },
    destructive: false,
  },
  {
    name: 'login_to_website',
    description: 'Log in to the current website by finding login fields in the page DOM and filling them. Use when user says log in, sign in, or enter credentials.',
    params: {
      username: 'string — email address or username',
      password: 'string — password',
    },
    destructive: false,
  },
  {
    name: 'search_google',
    description: 'Search Google for a query.',
    params: { query: 'string — the search terms' },
    destructive: false,
  },
  {
    name: 'navigate_to',
    description: 'Navigate the browser to a specific URL.',
    params: { url: 'string — full URL including https://' },
    destructive: false,
  },
  {
    name: 'open_crm',
    description: 'Open the CRM dashboard.',
    params: {},
    destructive: false,
  },
  {
    name: 'create_lead',
    description: 'Create a new lead/contact in the CRM.',
    params: {
      name:  'string — full name of the lead',
      phone: 'string — phone number (optional)',
      email: 'string — email address (optional)',
      note:  'string — any additional note (optional)',
    },
    destructive: false,
  },
  {
    name: 'search_lead',
    description: 'Search for a lead or contact in the CRM by name or phone.',
    params: { query: 'string — name or phone number to search' },
    destructive: false,
  },
  {
    name: 'get_tickets',
    description: 'Open the CRM tickets / support queue view.',
    params: {},
    destructive: false,
  },
  {
    name: 'assign_ticket',
    description: 'Assign a CRM ticket to an agent.',
    params: {
      ticket_id: 'string — the ticket ID or number',
      agent:     'string — name or email of the agent to assign to',
    },
    destructive: false,
  },
  {
    name: 'resolve_ticket',
    description: 'Mark a CRM ticket as resolved.',
    params: { ticket_id: 'string — the ticket ID' },
    destructive: true,    // Requires confirmation
  },
  {
    name: 'go_back',
    description: 'Navigate back to the previous page.',
    params: {},
    destructive: false,
  },
  {
    name: 'reload_page',
    description: 'Reload / refresh the current page.',
    params: {},
    destructive: false,
  },
  {
    name: 'take_screenshot',
    description: 'Take a screenshot of the current page and save it locally.',
    params: { filename: 'string — optional filename without extension' },
    destructive: false,
  },
  {
    name: 'click_captcha',
    description: 'Click the reCAPTCHA "I am not a robot" checkbox on the current page.',
    params: {},
    destructive: false,
  },
];

// Fast lookup map: action name → action config
const ACTION_MAP = Object.fromEntries(ALLOWED_ACTIONS.map(a => [a.name, a]));

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Validate that an intent is in the whitelist.
 * Returns { ok: true } or { ok: false, reason: string }.
 */
function validateAction(intent) {
  const { action } = intent;

  if (!action || action === 'unknown') {
    return { ok: false, reason: `Could not understand command. Try again.` };
  }

  if (!ACTION_MAP[action]) {
    return {
      ok: false,
      reason: `Action "${action}" is not in the whitelist. Blocked for safety.`,
    };
  }

  return { ok: true };
}

/**
 * For destructive actions, ask the user to confirm in the terminal.
 * Returns true if confirmed, false if denied.
 */
async function confirmDestructive(intent) {
  const config = ACTION_MAP[intent.action];
  if (!config || !config.destructive) return true;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(
      `\n⚠️  "${intent.action}" is a destructive action. Params: ${JSON.stringify(intent.params)}\n   Confirm? [y/N] `,
      (answer) => {
        rl.close();
        const confirmed = answer.trim().toLowerCase() === 'y';
        if (!confirmed) logger.warn(`Action "${intent.action}" cancelled by user.`);
        resolve(confirmed);
      },
    );
  });
}

module.exports = { ALLOWED_ACTIONS, ACTION_MAP, validateAction, confirmDestructive };
