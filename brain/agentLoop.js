'use strict';

require('dotenv').config();
const { OpenAI } = require('openai');
const { extractPageContext, formatContext } = require('./domReader');
const logger = require('../logger');

let _openai = null;
const getClient = () => {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
};

const MAX_STEPS = 25;

// ─── System prompt ─────────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are an autonomous browser agent completing a user's goal step by step.

Each turn you receive:
- A screenshot of the current page
- Numbered interactive elements (inputs, buttons, links)
- The overall goal
- History of steps taken so far

You return ONE next action as JSON, or signal completion/failure.

Available actions:
- fill:     type text into an input field        → {"action":"fill",     "element_index":N, "value":"...",  "description":"..."}
- click:    click a button, link, or element      → {"action":"click",    "element_index":N,                "description":"..."}
- press:    press a keyboard key                  → {"action":"press",    "key":"Enter",                    "description":"..."}
- scroll:   scroll the page                       → {"action":"scroll",   "direction":"down", "amount":400, "description":"..."}
- wait:     wait for page/content to load         → {"action":"wait",     "ms":2000,                        "description":"..."}
- navigate: go to a URL directly                  → {"action":"navigate", "url":"https://...",              "description":"..."}
- done:     goal is fully achieved                → {"action":"done",     "message":"what was accomplished"}
- failed:   cannot proceed, explain why           → {"action":"failed",   "message":"reason"}

Critical rules:
1. Return ONLY valid JSON — no markdown, no explanation outside the JSON.
2. Look at the screenshot carefully — identify what page you are on.
3. If a cookie banner / popup / overlay is blocking the page → click to dismiss it first.
4. If a CAPTCHA appears → return {"action":"failed","message":"CAPTCHA detected, please solve it manually then retry"}.
5. If an OTP field appears → return {"action":"failed","message":"OTP sent to phone. Please say 'enter OTP XXXXXX' once you receive it"}.
6. For YouTube search: click the search bar [element_index], then fill with the query, then press Enter. After results load, scroll and click the best matching video title.
7. For Flipkart/Amazon add-to-cart: look for "Add to Cart" or "Buy Now" buttons.
8. Use element_index from the numbered list — do NOT guess CSS selectors.
9. After each fill, check if a "Next" or submit button needs to be clicked.
10. If the goal is clearly complete (cart updated, order placed, product found, video playing), return done.
11. Never loop on the same action twice — if something failed, try a different approach.
12. scroll direction: "down" to scroll down, "up" to scroll up. amount is pixels (default 400).
`.trim();

// ─── Get next step from GPT-4o ─────────────────────────────────────────────────
async function getNextStep(goal, domText, base64, history) {
  const historyText = history.length
    ? `\nSteps completed so far:\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
    : '\nNo steps taken yet.';

  const response = await getClient().chat.completions.create({
    model: process.env.LLM_MODEL || 'gpt-4o',
    temperature: 0,
    max_completion_tokens: 512,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' },
          },
          {
            type: 'text',
            text: `GOAL: ${goal}${historyText}\n\nCurrent page:\n${domText}\n\nWhat is the single next action to take?`,
          },
        ],
      },
    ],
  });

  try {
    return JSON.parse(response.choices[0].message.content.trim());
  } catch {
    return { action: 'failed', message: 'Could not parse GPT-4o response.' };
  }
}

// ─── Execute one step ──────────────────────────────────────────────────────────
async function executeStep(page, handles, step) {
  const { action, element_index, value, key, ms, url } = step;

  switch (action) {
    case 'fill': {
      const el = handles[element_index];
      if (!el) throw new Error(`No element at index ${element_index}`);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click({ clickCount: 3 });          // focus + select all existing text
      await page.waitForTimeout(150);
      await page.keyboard.press('Control+a');      // ensure all selected
      await page.keyboard.press('Backspace');      // clear
      await page.waitForTimeout(100);
      await page.keyboard.type(String(value), { delay: 40 });  // type naturally
      break;
    }
    case 'click': {
      const el = handles[element_index];
      if (!el) throw new Error(`No element at index ${element_index}`);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click();
      break;
    }
    case 'press': {
      await page.keyboard.press(key || 'Enter');
      break;
    }
    case 'wait': {
      await page.waitForTimeout(ms || 1500);
      break;
    }
    case 'scroll': {
      const direction = step.direction === 'up' ? -1 : 1;
      const amount    = step.amount || 400;
      await page.evaluate(({ dir, amt }) => window.scrollBy(0, dir * amt), { dir: direction, amt: amount });
      await page.waitForTimeout(500);
      break;
    }
    case 'navigate': {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      break;
    }
    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// ─── Main agent loop ───────────────────────────────────────────────────────────

/**
 * Run the agentic loop until goal is complete, failed, or max steps reached.
 * After EVERY action, re-reads the page so GPT-4o adapts to navigation,
 * popups, OTP screens, redirects — anything.
 *
 * @param {import('playwright').Page} page
 * @param {string} goal
 * @param {Function} [onStep]  optional callback(stepDesc) for real-time UI updates
 */
async function runAgentLoop(page, goal, onStep) {
  const history = [];
  let stepCount = 0;

  logger.info(`Agent loop started. Goal: "${goal}"`);

  while (stepCount < MAX_STEPS) {
    stepCount++;

    // 1. Observe current state
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(600); // let JS render

    const ctx = await extractPageContext(page);
    const domText = formatContext(ctx);
    const screenshotBuf = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: false, timeout: 10000 }).catch(() => null);
    if (!screenshotBuf) {
      logger.warn('Page screenshot timed out — skipping step');
      return { success: false, message: 'Page screenshot timed out. The page may be stuck or unloaded.' };
    }
    const base64 = screenshotBuf.toString('base64');

    logger.debug(`Step ${stepCount} — page: ${ctx.url} — elements: ${ctx.elements.length}`);

    // 2. Ask GPT-4o for next action
    const step = await getNextStep(goal, domText, base64, history);
    logger.info(`Step ${stepCount}: ${JSON.stringify(step)}`);

    if (step.action === 'done') {
      logger.info(`Goal achieved: ${step.message}`);
      if (onStep) onStep(`✓ Done: ${step.message}`);
      return { success: true, message: step.message, steps: history };
    }

    if (step.action === 'failed') {
      logger.warn(`Agent failed: ${step.message}`);
      if (onStep) onStep(`⚠ ${step.message}`);
      return { success: false, message: step.message, steps: history };
    }

    // 3. Get fresh element handles for this page state
    const handles = await page.$$(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]),' +
      'textarea, select, button, [role="button"], a[href]'
    );

    // 4. Execute step
    try {
      await executeStep(page, handles, step);
      history.push(step.description || step.action);
      if (onStep) onStep(`⚡ ${step.description || step.action}`);
    } catch (err) {
      const errMsg = `${step.description || step.action} → FAILED: ${err.message}`;
      history.push(errMsg);
      logger.warn(`Step execution failed: ${err.message}`);
      if (onStep) onStep(`⚠ ${errMsg}`);
    }

    // 5. Wait for navigation / re-render
    await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await page.waitForTimeout(800);
  }

  return {
    success: false,
    message: `Reached max steps (${MAX_STEPS}). Completed: ${history.slice(-3).join(' → ')}`,
    steps: history,
  };
}

module.exports = { runAgentLoop };
