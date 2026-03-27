'use strict';

require('dotenv').config();
const { OpenAI } = require('openai');
const { extractPageContext, formatContext } = require('./domReader');
const { setActivePage } = require('../browser/connect');
const logger = require('../logger');

let _openai = null;
const getClient = () => {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
};

const MAX_STEPS = 25;

// ─── CDP-based screenshot (from Chrome DevTools MCP technique) ─────────────────
// Uses Page.captureScreenshot CDP command with optimizeForSpeed:true
// This bypasses Playwright's font-loading wait that causes YouTube timeouts.
async function cdpScreenshot(page) {
  let client;
  try {
    client = await page.context().newCDPSession(page);
    const { data } = await client.send('Page.captureScreenshot', {
      format: 'jpeg',
      quality: 45,
      optimizeForSpeed: true,
    });
    return data; // already base64
  } catch (err) {
    logger.warn(`CDP screenshot failed (${err.message}), falling back to Playwright`);
    // Fallback to Playwright screenshot with short timeout
    const buf = await page.screenshot({ type: 'jpeg', quality: 45, fullPage: false, timeout: 5000 }).catch(() => null);
    return buf ? buf.toString('base64') : null;
  } finally {
    if (client) await client.detach().catch(() => {});
  }
}

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
- fill:      type text into an input field          → {"action":"fill",     "element_index":N, "value":"...", "description":"..."}
- click:     click element by index                 → {"action":"click",    "element_index":N,               "description":"..."}
- click_xy:  click at pixel coords (any element)    → {"action":"click_xy", "x":350, "y":240,               "description":"..."}  ← for anything without a reliable index
- hover:     hover over element (reveals menus)     → {"action":"hover",    "element_index":N,               "description":"..."}
- hover_xy:  hover at pixel coords                  → {"action":"hover_xy", "x":350, "y":240,               "description":"..."}
- drag_xy:   drag from one coord to another (slider)→ {"action":"drag_xy",  "x1":100,"y1":300,"x2":400,"y2":300, "description":"..."}
- select:    choose option from <select> dropdown   → {"action":"select",   "element_index":N, "value":"option text", "description":"..."}
- press:     press a keyboard key                   → {"action":"press",    "key":"Enter",                   "description":"..."}
- scroll:    scroll the page                        → {"action":"scroll",   "direction":"down","amount":400, "description":"..."}
- scroll_xy: scroll at a specific position on page  → {"action":"scroll_xy","x":300,"y":400,"direction":"down","amount":300, "description":"..."}
- wait:      wait for content to load               → {"action":"wait",     "ms":2000,                       "description":"..."}
- navigate:  go to a URL directly                   → {"action":"navigate", "url":"https://...",             "description":"..."}
- done:      goal is fully achieved                 → {"action":"done",     "message":"what was accomplished"}
- failed:    cannot proceed, explain why            → {"action":"failed",   "message":"reason"}

Critical rules:
1. Return ONLY valid JSON — no markdown, no explanation outside the JSON.
2. Look at the screenshot carefully — identify what page you are on.
3. If a cookie banner / popup / overlay is blocking the page → click to dismiss it first.
4. If a CAPTCHA appears → return {"action":"failed","message":"CAPTCHA detected, please solve it manually then retry"}.
5. OTP RULES (important):
   a. If you see an OTP input screen AND the GOAL does not contain a 4-6 digit OTP code → return {"action":"failed","message":"OTP sent to phone. Please say 'enter OTP XXXXXX' once you receive it"}. Do NOT try to fill digits yourself.
   b. If the GOAL contains an OTP code (e.g. "OTP is 962342" or "enter OTP 962342") → fill it. For single-box OTP: fill element with the full code. For multi-box digit inputs (one box per digit): click the FIRST box, then use {"action":"press","key":"9"} for each digit one at a time — DO NOT use fill for individual digit boxes.
   c. After entering OTP in ALL boxes, click Verify/Submit ONCE. If verify fails after 1 click → return failed, do not retry.
6. NEVER type placeholder values like <yourphonenumberhere>, [phone], [email], YOUR_NUMBER etc. If the actual value is not in the GOAL, return {"action":"failed","message":"Please say your phone number / email / password to enter it"}.
7. For YouTube search: fill the search bar with the query, press Enter. After results load, scroll and click the best matching video title.
8. For Flipkart/Amazon add-to-cart: look for "Add to Cart" or "Buy Now" buttons.
9. FILTER / CHECKBOX RULES (Flipkart sidebar filters, category chips etc.):
   - Checkbox filters (Brand, Rating, Discount) in the element list have ○/✓ state shown. Click by element_index to toggle them.
   - If a filter item isn't in the list → scroll_xy near the filter sidebar to reveal it, then click_xy on the checkbox you see in the screenshot.
   - For price RANGE slider: use drag_xy — drag from the slider thumb's current position to the target position.
   - Hover a section header to reveal sub-options if needed.
10. After each fill, check if a "Next" or submit button needs to be clicked.
11. If the goal is clearly complete (cart updated, order placed, product found, video playing, logged in, filter applied), return done.
12. Never repeat the same action more than once — if something failed, try click_xy at the exact pixel position you see in the screenshot.
13. scroll direction: "down" or "up". amount = pixels (default 400).
14. Use scroll_xy to scroll within a sidebar/panel without scrolling the whole page.`.trim();

// ─── Get next step from GPT-4o ─────────────────────────────────────────────────
async function getNextStep(goal, domText, base64, history) {
  const historyText = history.length
    ? `\nSteps completed so far:\n${history.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
    : '\nNo steps taken yet.';

  const goalText = `GOAL: ${goal}${historyText}\n\nCurrent page:\n${domText}\n\nWhat is the single next action to take?`;

  // If screenshot is unavailable (e.g. page stuck on font loading), use text-only prompt
  const userContent = base64
    ? [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' } },
        { type: 'text', text: goalText },
      ]
    : goalText;

  const response = await getClient().chat.completions.create({
    model: process.env.LLM_MODEL || 'gpt-4o',
    temperature: 0,
    max_completion_tokens: 512,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
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
      await el.click();
      await page.waitForTimeout(100);

      // Force-clear React/controlled inputs using native value setter
      await el.evaluate((node) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (nativeSetter) nativeSetter.call(node, '');
        node.value = '';
        node.dispatchEvent(new Event('input', { bubbles: true }));
        node.dispatchEvent(new Event('change', { bubbles: true }));
      }).catch(() => {});

      // Also keyboard-clear as backup
      await page.keyboard.press('Control+a');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(100);

      await page.keyboard.type(String(value), { delay: 40 });
      break;
    }
    case 'click': {
      const el = handles[element_index];
      if (!el) throw new Error(`No element at index ${element_index}`);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.click();
      break;
    }
    case 'click_xy': {
      // Chrome DevTools MCP technique: Playwright mouse.click at coordinates
      // More reliable than element handles on SPAs where DOM updates make handles stale.
      await page.mouse.click(step.x, step.y);
      break;
    }
    case 'hover': {
      const el = handles[element_index];
      if (!el) throw new Error(`No element at index ${element_index}`);
      await el.scrollIntoViewIfNeeded().catch(() => {});
      await el.hover();
      await page.waitForTimeout(400); // let dropdown/menu appear
      break;
    }
    case 'hover_xy': {
      await page.mouse.move(step.x, step.y);
      await page.waitForTimeout(400);
      break;
    }
    case 'drag_xy': {
      // Drag from (x1,y1) to (x2,y2) — used for price range sliders
      // Chrome DevTools MCP technique: mouse down → move → up
      await page.mouse.move(step.x1, step.y1);
      await page.mouse.down();
      // Move in small increments so the slider JS detects the drag
      const steps = 10;
      const dx = (step.x2 - step.x1) / steps;
      const dy = (step.y2 - step.y1) / steps;
      for (let i = 1; i <= steps; i++) {
        await page.mouse.move(step.x1 + dx * i, step.y1 + dy * i);
        await page.waitForTimeout(30);
      }
      await page.mouse.up();
      await page.waitForTimeout(300);
      break;
    }
    case 'select': {
      // Native <select> element — use Playwright's selectOption
      const el = handles[element_index];
      if (!el) throw new Error(`No element at index ${element_index}`);
      await el.selectOption({ label: String(step.value) }).catch(() =>
        el.selectOption({ value: String(step.value) })
      );
      break;
    }
    case 'scroll_xy': {
      // Scroll within a specific panel/sidebar without scrolling the whole page
      const dir = step.direction === 'up' ? -1 : 1;
      const amt = step.amount || 300;
      await page.evaluate(({ x, y, dir, amt }) => {
        const el = document.elementFromPoint(x, y);
        if (el) el.scrollBy(0, dir * amt);
        else window.scrollBy(0, dir * amt);
      }, { x: step.x, y: step.y, dir, amt });
      await page.waitForTimeout(400);
      break;
    }
    case 'press': {
      // For single chars (OTP digits), use keyboard.type so they register in React inputs
      const k = key || 'Enter';
      if (k.length === 1) {
        await page.keyboard.type(k, { delay: 80 });
      } else {
        await page.keyboard.press(k);
      }
      await page.waitForTimeout(120); // let focus auto-advance to next OTP box
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
  let lastDesc  = '';
  let repeatCount = 0;
  // `activePage` is mutable — updated when a click opens a new tab
  let activePage = page;

  logger.info(`Agent loop started. Goal: "${goal}"`);

  while (stepCount < MAX_STEPS) {
    stepCount++;

    // 1. Observe current state
    await activePage.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await activePage.waitForTimeout(600); // let JS render

    const ctx = await extractPageContext(activePage);
    const domText = formatContext(ctx);
    // CDP screenshot — uses Chrome DevTools Protocol directly, skips Playwright's
    // font-loading wait that causes YouTube/SPA timeouts. Falls back gracefully.
    const base64 = await cdpScreenshot(activePage);
    if (!base64) logger.warn(`Step ${stepCount}: screenshot unavailable, using DOM-only mode`);

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
    const handles = await activePage.$$(
      'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]),' +
      'textarea, select, button, [role="button"], a[href]'
    );

    // 4. Execute step — track if a new tab opens
    const pagesBefore = activePage.context().pages().length;
    try {
      await executeStep(activePage, handles, step);
      const desc = step.description || step.action;
      history.push(desc);
      if (onStep) onStep(`⚡ ${desc}`);

      // Auto-follow new tabs opened by clicks (e.g. Flipkart target="_blank" links)
      if (['click', 'click_xy'].includes(step.action)) {
        await activePage.waitForTimeout(600); // let the new tab open
        const pagesAfter = activePage.context().pages();
        if (pagesAfter.length > pagesBefore) {
          const newPage = pagesAfter[pagesAfter.length - 1];
          await newPage.bringToFront().catch(() => {});
          setActivePage(newPage);
          activePage = newPage;
          logger.info(`New tab detected — following: ${newPage.url()}`);
          if (onStep) onStep(`⚡ Followed new tab: ${newPage.url()}`);
        }
      }

      // Loop detection: same description 3 times in a row → stuck
      if (desc === lastDesc) {
        repeatCount++;
        if (repeatCount >= 3) {
          logger.warn(`Agent stuck in loop on: "${desc}"`);
          return { success: false, message: `Stuck repeating the same step. Try rephrasing your command.`, steps: history };
        }
      } else {
        repeatCount = 0;
        lastDesc = desc;
      }
    } catch (err) {
      const errMsg = `${step.description || step.action} → FAILED: ${err.message}`;
      history.push(errMsg);
      logger.warn(`Step execution failed: ${err.message}`);
      if (onStep) onStep(`⚠ ${errMsg}`);
    }

    // 5. Wait for navigation / re-render
    await activePage.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
    await activePage.waitForTimeout(800);
  }

  return {
    success: false,
    message: `Reached max steps (${MAX_STEPS}). Completed: ${history.slice(-3).join(' → ')}`,
    steps: history,
  };
}

module.exports = { runAgentLoop };
