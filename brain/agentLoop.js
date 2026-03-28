'use strict';

/**
 * agentLoop.js — Chrome DevTools MCP-inspired browser agent
 *
 * Key techniques borrowed from ChromeDevTools/chrome-devtools-mcp:
 *
 * 1. A11y-tree element identification  (domReader: takeSnapshot approach)
 * 2. Playwright Locators — NEVER stale handles  (handle.asLocator().click())
 * 3. Coordinate clicking via page.mouse  (clickAt: pptrPage.mouse.click)
 * 4. waitForEventsAfterAction — nav detect + DOM stable  (WaitForHelper.ts)
 * 5. Dialog auto-dismiss  (handleDialog tool)
 * 6. Network idle check after navigation
 * 7. Drag via incremental mouse moves  (drag tool)
 * 8. CDP screenshot with optimizeForSpeed  (take_screenshot)
 */

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

const MAX_STEPS = 30;

// ─── 1. waitForEventsAfterAction  (Chrome DevTools MCP: WaitForHelper.ts) ────
// Exact technique from WaitForHelper.ts:
//   1. Start CDP Page.frameStartedNavigating listener BEFORE action
//   2. Race it against 100ms timeout (expectNavigationIn)
//   3. Run the action
//   4. If real navigation detected → waitForNavigation + networkidle
//   5. Always wait for DOM stable afterwards
//
// Critical: same-document navigations (SPA hash changes, history.pushState)
// resolve(false) — they don't need a full waitForNavigation round-trip.
async function waitForEventsAfterAction(page, actionFn) {
  let cdpClient;
  let realNav = false;

  // Promise that resolves true=real-nav | false=same-doc/timeout
  const navDetected = new Promise((resolve) => {
    // SAME_DOC types that don't require a full page-load wait
    const SAME_DOC = new Set(['historySameDocument', 'historyDifferentDocument', 'sameDocument']);

    page.context().newCDPSession(page)
      .then((client) => {
        cdpClient = client;
        const handler = (evt) => {
          const isReal = !SAME_DOC.has(evt.navigationType);
          realNav = isReal;
          resolve(isReal);
          client.off('Page.frameStartedNavigating', handler);
        };
        client.on('Page.frameStartedNavigating', handler);
      })
      .catch(() => resolve(false));

    // Hard cap: 100ms (WaitForHelper: expectNavigationIn)
    setTimeout(() => resolve(false), 100);
  });

  // Chain: if real nav → wait for it to complete
  const navigationFinished = navDetected.then(async (didNavigate) => {
    if (didNavigate) {
      await page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    }
  }).catch(() => {});

  try {
    await actionFn();
  } catch (err) {
    if (cdpClient) await cdpClient.detach().catch(() => {});
    throw err;
  }

  try {
    await navigationFinished;
    // Always wait for DOM stable (React re-renders, filter sidebar updates)
    await waitForDomStable(page, { timeout: 3000, quietMs: 100 });
  } catch { /* ignore */ } finally {
    if (cdpClient) await cdpClient.detach().catch(() => {});
  }
}

// ─── 2. DOM stability  (Chrome DevTools MCP: waitForStableDom) ───────────────
async function waitForDomStable(page, { timeout = 3000, quietMs = 300 } = {}) {
  try {
    await page.evaluate(({ timeout, quietMs }) => {
      return new Promise((resolve) => {
        let done = false;
        const finish = () => { if (!done) { done = true; observer.disconnect(); resolve(); } };
        let timer = setTimeout(finish, quietMs);
        const observer = new MutationObserver(() => {
          clearTimeout(timer);
          timer = setTimeout(finish, quietMs);
        });
        observer.observe(document.body || document.documentElement,
          { childList: true, subtree: true, attributes: true, characterData: true });
        setTimeout(finish, timeout); // hard cap
      });
    }, { timeout, quietMs });
  } catch { /* page navigated — fine */ }
}

// ─── 3. CDP screenshot  (Chrome DevTools MCP: take_screenshot + optimizeForSpeed) ──
async function cdpScreenshot(page) {
  let client;
  try {
    client = await page.context().newCDPSession(page);
    const { data } = await client.send('Page.captureScreenshot', {
      format: 'jpeg', quality: 50, optimizeForSpeed: true,
    });
    return data;
  } catch {
    const buf = await page.screenshot({ type: 'jpeg', quality: 50, fullPage: false, timeout: 5000 }).catch(() => null);
    return buf ? buf.toString('base64') : null;
  } finally {
    if (client) await client.detach().catch(() => {});
  }
}

// ─── 4. Playwright Locator execution  (Chrome DevTools MCP: handle.asLocator()) ─
// Uses role+name to build a fresh locator — NEVER stale unlike $$() handles.
async function clickByLocator(page, locator, fallbackX, fallbackY) {
  const { pwRole, name } = locator;

  // Try exact name match first, then partial
  const strategies = [
    () => page.getByRole(pwRole, { name, exact: true }).first(),
    () => page.getByRole(pwRole, { name, exact: false }).first(),
    () => page.getByText(name, { exact: true }).first(),
    () => page.getByText(name, { exact: false }).first(),
    () => page.getByLabel(name, { exact: false }).first(),
    () => page.getByPlaceholder(name, { exact: false }).first(),
  ];

  for (const strategy of strategies) {
    try {
      const loc = strategy();
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
      await loc.click({ timeout: 3000 });
      return; // success
    } catch { /* try next */ }
  }

  // Coordinate fallback
  if (fallbackX != null && fallbackY != null) {
    await page.mouse.click(fallbackX, fallbackY);
    return;
  }
  throw new Error(`Could not click "${name}" (${pwRole}) — element not found`);
}

async function fillByLocator(page, locator, value, fallbackX, fallbackY) {
  const { pwRole, name } = locator;

  const strategies = [
    () => page.getByRole(pwRole, { name, exact: true }).first(),
    () => page.getByRole(pwRole, { name, exact: false }).first(),
    () => page.getByLabel(name, { exact: false }).first(),
    () => page.getByPlaceholder(name, { exact: false }).first(),
    () => page.getByRole('textbox').first(),
  ];

  for (const strategy of strategies) {
    try {
      const loc = strategy();
      await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
      // Force-clear React controlled inputs (native value setter technique)
      await loc.evaluate((node) => {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) { setter.call(node, ''); node.dispatchEvent(new Event('input', { bubbles: true })); }
        node.value = '';
      }).catch(() => {});
      await loc.fill(String(value), { timeout: 5000 });
      return;
    } catch { /* try next */ }
  }

  // Coordinate fallback: click field then type
  if (fallbackX != null && fallbackY != null) {
    await page.mouse.click(fallbackX, fallbackY);
    await page.waitForTimeout(100);
    await page.keyboard.press('Control+a');
    await page.keyboard.press('Backspace');
    await page.keyboard.type(String(value), { delay: 40 });
    return;
  }
  throw new Error(`Could not fill "${name}" — element not found`);
}

// ─── 5. System prompt ─────────────────────────────────────────────────────────
const SYSTEM_PROMPT = `
You are an autonomous browser agent. You see a screenshot + list of interactive elements.
Each element: [index] state role "name" val @(cx,cy)

You return ONE JSON action per turn.

Actions:
- click        → {"action":"click",      "index":N,                          "description":"..."}
- fill         → {"action":"fill",       "index":N,      "value":"...",      "description":"..."}
- press_on     → {"action":"press_on",   "index":N,      "key":"Enter",      "description":"..."}  press key ON a specific element (use after fill on search/form fields)
- click_xy     → {"action":"click_xy",   "x":300,"y":400,                    "description":"..."}  use for unlisted elements
- hover        → {"action":"hover",      "index":N,                          "description":"..."}
- hover_xy     → {"action":"hover_xy",   "x":300,"y":400,                    "description":"..."}
- drag_xy      → {"action":"drag_xy",    "x1":100,"y1":300,"x2":400,"y2":300,"description":"..."}  for sliders
- select       → {"action":"select",     "index":N,      "value":"opt text", "description":"..."}
- press        → {"action":"press",      "key":"Enter",                      "description":"..."}  press key at current focus (only if you know focus is on the right element)
- type         → {"action":"type",       "text":"...",                       "description":"..."}  type at current focus
- scroll       → {"action":"scroll",     "direction":"down","amount":400,    "description":"..."}
- scroll_xy    → {"action":"scroll_xy",  "x":100,"y":400,"direction":"down","amount":300,"description":"..."}
- double_click → {"action":"double_click","index":N,                         "description":"..."}  open files/folders
- wait_for     → {"action":"wait_for",   "text":"Add to cart",               "description":"..."}  wait until text/element visible
- evaluate     → {"action":"evaluate",   "script":"document.title",          "description":"..."}
- wait         → {"action":"wait",       "ms":1500,                          "description":"..."}
- navigate     → {"action":"navigate",   "url":"https://...",                "description":"..."}
- done         → {"action":"done",       "message":"..."}
- failed       → {"action":"failed",     "message":"..."}

Rules:
1. Return ONLY valid JSON. No markdown.
2. Always look at the screenshot first — identify exactly what page/state you are on.
3. Dismiss cookie banners / popups before doing anything else.
4. CAPTCHA visible → return failed immediately.
5. OTP screen → if OTP digits are in the goal/context, enter them. If not, return done("OTP field is ready — say the OTP digits").
6. OTP in goal → for single box: fill with full code. For digit boxes: click first box then press each digit.
7. VALUES (phone, email, password, name): If a value is present anywhere in the GOAL text or recent context, use it immediately — do NOT ask the user for it. If genuinely no value exists anywhere in the goal or context, focus the field and return done("Field is focused and ready — say the value to fill in").
   NEVER return a message asking the user to provide a value. NEVER refuse to proceed. Just focus the field and say it's ready.
8. FILTERS (checkboxes/chips in sidebar):
   - Checkboxes show ✓ or ○ in the list. Click by index to toggle.
   - If not in list → scroll_xy near the sidebar, then click_xy at the exact checkbox position.
   - Price slider → drag_xy from current thumb position to target.
9. SEARCH BARS — CRITICAL rule (Flipkart, Amazon, YouTube, any site):
   - Step 1: fill the search bar with the query (index N).
   - Step 2: press_on the SAME index N with key "Enter" — this fires Enter directly on the input, bypassing any dropdown that may have stolen focus.
   - NEVER use plain press{key:Enter} after fill — focus may have shifted to a suggestion dropdown.
   - If press_on also fails, use click_xy on the search submit button coordinates.
10. PRICE FILTERS — always INSPECT FIRST, then act. Use evaluate to detect what type of price filter exists:
    {"action":"evaluate","script":"(function(){const r=document.querySelectorAll('input[type=\"range\"]');const sel=Array.from(document.querySelectorAll('select')).filter(x=>x.textContent.includes('\\u20b9')||/price|amount/i.test(x.name+x.id+x.className));const minBox=document.querySelector('input[placeholder*=\"Min\"],input[placeholder*=\"min\"],input[aria-label*=\"Min\"],input[aria-label*=\"min\"]');const maxBox=document.querySelector('input[placeholder*=\"Max\"],input[placeholder*=\"max\"],input[aria-label*=\"Max\"],input[aria-label*=\"max\"]');return{rangeInputs:r.length,priceSelects:sel.length,hasPriceTextboxes:!!(minBox||maxBox),ranges:Array.from(r).map(x=>({min:x.min,max:x.max,val:x.value}))};})()","description":"Detect price filter type on page"}

    Based on the result, choose the RIGHT method:

    A) rangeInputs > 0 → Native HTML range slider. Set value with JS (NEVER drag_xy):
       MAX price (last slider): {"action":"evaluate","script":"(function(){const s=document.querySelectorAll('input[type=\"range\"]');const el=s[s.length-1];if(!el)return 'not found';const nv=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set;nv.call(el,'VALUE_HERE');el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return 'set to '+el.value;})()","description":"Set max price slider to VALUE_HERE"}
       MIN price (first slider): same but use s[0] instead of s[s.length-1].

    B) priceSelects > 0 → Price dropdown. Use the "select" action with the closest available option value.

    C) hasPriceTextboxes → Price text input boxes (Min ₹ / Max ₹ fields). Use fill action to type the price into the correct box (by index or click_xy), then press Enter or click "Go" / "Apply".

    D) None of the above → Custom div/React slider (e.g. Flipkart). Steps:
       1. Use evaluate to get the slider track's bounding rect and the data-min/data-max or aria-valuemin/aria-valuemax:
          {"action":"evaluate","script":"(function(){const track=document.querySelector('[class*=\"_range\"],._range,[role=\"slider\"],[class*=\"slider\"],[class*=\"Slider\"]');if(!track)return null;const r=track.getBoundingClientRect();const mn=track.getAttribute('aria-valuemin')||track.dataset.min||'0';const mx=track.getAttribute('aria-valuemax')||track.dataset.max||'100000';return{x:r.left,y:r.top+r.height/2,w:r.width,min:Number(mn),max:Number(mx)};})()","description":"Get custom slider track bounds"}
       2. Calculate click X position: x = track.x + (targetPrice - track.min) / (track.max - track.min) * track.w
       3. Click at that position: {"action":"click_xy","x":CALCULATED_X,"y":TRACK_Y,"description":"Click slider track at target price position"}
       4. If there is an "Apply" button after moving the slider, click it.
    - Search results: click the product title to open it. If click does nothing, try click_xy at the product's @(cx,cy) coordinates.
    - Product page: click "Add to Cart" or "Buy Now".
    - Cart: click "Place Order" or "Checkout".
11. Done when: goal fully achieved (item in cart, order placed, video playing, logged in, filter applied, field filled, button clicked).
12. If an action fails → try click_xy using the @(cx,cy) coordinates shown for that element.
13. For YouTube: fill search bar → press_on same index with Enter → wait for results → click best matching video title.
14. scroll_xy to scroll inside a sidebar/panel at specific coordinates.
15. WRONG PAGE: If the goal requires a specific site (YouTube, Flipkart, Gmail, etc.) but you are on a different page, use navigate to go there FIRST before attempting any actions.
16. MEDIA CONTROLS (YouTube play/pause/mute/volume): After clicking a media control ONCE, immediately return done — do NOT click it again. The button label flips (Pause↔Play) AFTER the action — that confirms success.
17. ONE-SHOT GOALS: If the goal is a single simple action (click a button, fill a field, toggle something), return done IMMEDIATELY after doing it once. Do NOT re-examine the page or repeat.
18. COUNT ACTIONS, NOT ATTEMPTS. If you have already performed the specific action the user asked, return done. Do NOT take more actions "to verify".
19. NEVER attempt the same (action, index) combination more than twice. On the third attempt, return failed with a clear explanation.
20. BE DECISIVE. This is a voice assistant — the user cannot type replies. Do your best with what you have. Never ask questions, never say "I need more info". Either do it or return failed with a short reason.
`.trim();

// ─── 6. GPT-4o call ───────────────────────────────────────────────────────────
async function getNextStep(goal, domText, base64, history) {
  const historyText = history.length
    ? `\nSteps done:\n${history.map((h, i) => `${i+1}. ${h}`).join('\n')}`
    : '\nNo steps yet.';

  const goalText = `GOAL: ${goal}${historyText}\n\nCurrent page:\n${domText}\n\nNext single action?`;

  const userContent = base64
    ? [
        { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'high' } },
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
      { role: 'user',   content: userContent },
    ],
  });

  try {
    return JSON.parse(response.choices[0].message.content.trim());
  } catch {
    return { action: 'failed', message: 'Could not parse GPT-4o response.' };
  }
}

// ─── 7. Execute one step ──────────────────────────────────────────────────────
async function executeStep(page, elements, step) {
  const { action } = step;
  const el = elements[step.index]; // may be undefined

  switch (action) {

    case 'fill': {
      if (!el) throw new Error(`No element at index ${step.index}`);
      await fillByLocator(page, el.locator, step.value, el.cx, el.cy);
      break;
    }

    case 'click': {
      if (!el) throw new Error(`No element at index ${step.index}`);
      await clickByLocator(page, el.locator, el.cx, el.cy);
      break;
    }

    case 'click_xy': {
      // Chrome DevTools MCP: pptrPage.mouse.click(x, y)
      await page.mouse.click(step.x, step.y);
      break;
    }

    case 'double_click': {
      if (!el) throw new Error(`No element at index ${step.index}`);
      try {
        const loc = page.getByRole(el.locator.pwRole, { name: el.locator.name, exact: false }).first();
        await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
        await loc.dblclick({ timeout: 3000 });
      } catch {
        if (el.cx != null) await page.mouse.dblclick(el.cx, el.cy);
        else throw new Error(`Cannot double-click "${el.name}"`);
      }
      break;
    }

    case 'hover': {
      if (!el) throw new Error(`No element at index ${step.index}`);
      try {
        const loc = page.getByRole(el.locator.pwRole, { name: el.locator.name, exact: false }).first();
        await loc.scrollIntoViewIfNeeded({ timeout: 2000 });
        await loc.hover({ timeout: 3000 });
      } catch {
        if (el.cx != null) await page.mouse.move(el.cx, el.cy);
        else throw new Error(`Cannot hover element "${el.name}"`);
      }
      await page.waitForTimeout(400);
      break;
    }

    case 'hover_xy': {
      await page.mouse.move(step.x, step.y);
      await page.waitForTimeout(400);
      break;
    }

    case 'drag_xy': {
      // Chrome DevTools MCP: mouse down → incremental move → mouse up
      await page.mouse.move(step.x1, step.y1);
      await page.mouse.down();
      const STEPS = 15;
      const dx = (step.x2 - step.x1) / STEPS;
      const dy = (step.y2 - step.y1) / STEPS;
      for (let i = 1; i <= STEPS; i++) {
        await page.mouse.move(step.x1 + dx * i, step.y1 + dy * i);
        await page.waitForTimeout(20);
      }
      await page.mouse.up();
      break;
    }

    case 'select': {
      if (!el) throw new Error(`No element at index ${step.index}`);
      try {
        const loc = page.getByRole('combobox', { name: el.locator.name, exact: false }).first();
        await loc.selectOption({ label: String(step.value) })
          .catch(() => loc.selectOption({ value: String(step.value) }));
      } catch {
        if (el.cx != null) {
          await page.mouse.click(el.cx, el.cy);
          await page.waitForTimeout(300);
        }
      }
      break;
    }

    case 'press_on': {
      // Press a key directly on a specific element — bypasses focus/dropdown issues.
      // For INPUT elements (textbox/searchbox/combobox) we use getByLabel/getByPlaceholder
      // because getByText() does NOT match input values — inputs have no text content.
      if (!el) throw new Error(`No element at index ${step.index}`);
      const k = step.key || 'Enter';
      const isInputRole = ['textbox','searchbox','combobox','spinbutton'].includes(el.locator.pwRole);

      const strategies = isInputRole
        ? [
            () => page.getByRole(el.locator.pwRole, { name: el.locator.name, exact: true  }).first(),
            () => page.getByRole(el.locator.pwRole, { name: el.locator.name, exact: false }).first(),
            () => page.getByLabel(el.locator.name,       { exact: false }).first(),
            () => page.getByPlaceholder(el.locator.name, { exact: false }).first(),
          ]
        : [
            () => page.getByRole(el.locator.pwRole, { name: el.locator.name, exact: true  }).first(),
            () => page.getByRole(el.locator.pwRole, { name: el.locator.name, exact: false }).first(),
            () => page.getByText(el.locator.name, { exact: false }).first(),
          ];

      let pressed = false;
      for (const strategy of strategies) {
        try {
          const loc = strategy();
          await loc.focus({ timeout: 2000 });
          await loc.press(k);
          pressed = true;
          break;
        } catch { /* try next */ }
      }
      // Coordinate fallback: click to focus then press
      if (!pressed && el.cx != null) {
        await page.mouse.click(el.cx, el.cy);
        await page.waitForTimeout(100);
        await page.keyboard.press(k);
      } else if (!pressed) {
        throw new Error(`press_on: could not focus element "${el.name}"`);
      }
      break;
    }

    case 'press': {
      const k = step.key || 'Enter';
      if (k.length === 1) {
        await page.keyboard.type(k, { delay: 60 });
      } else {
        await page.keyboard.press(k);
      }
      break;
    }

    case 'type': {
      await page.keyboard.type(String(step.text), { delay: 40 });
      break;
    }

    case 'scroll': {
      const dir = step.direction === 'up' ? -1 : 1;
      const amt = step.amount || 400;
      await page.evaluate(({ dir, amt }) => window.scrollBy(0, dir * amt), { dir, amt });
      break;
    }

    case 'scroll_xy': {
      // Scroll inside a panel at specific screen coordinates
      const dir = step.direction === 'up' ? -1 : 1;
      const amt = step.amount || 300;
      await page.evaluate(({ x, y, dir, amt }) => {
        const target = document.elementFromPoint(x, y);
        // Walk up to find scrollable ancestor
        let el = target;
        while (el && el !== document.body) {
          const st = window.getComputedStyle(el);
          if (/(auto|scroll)/.test(st.overflow + st.overflowY)) {
            el.scrollBy(0, dir * amt);
            return;
          }
          el = el.parentElement;
        }
        window.scrollBy(0, dir * amt);
      }, { x: step.x, y: step.y, dir, amt });
      break;
    }

    case 'wait_for': {
      // Chrome DevTools MCP: context.waitForTextOnPage — Locator.race()
      // Waits until the given text appears anywhere on the page (useful for SPAs)
      const text = step.text || '';
      try {
        await page.waitForSelector(`text=${text}`, { timeout: step.timeout || 8000 });
      } catch {
        // Try aria-based locator as fallback
        await page.getByText(text, { exact: false }).waitFor({ timeout: 3000 }).catch(() => {});
      }
      break;
    }

    case 'evaluate': {
      const result = await page.evaluate(step.script).catch(e => `Error: ${e.message}`);
      logger.info(`evaluate result: ${JSON.stringify(result)}`);
      break;
    }

    case 'wait': {
      await page.waitForTimeout(step.ms || 1500);
      break;
    }

    case 'navigate': {
      await page.goto(step.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      break;
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

// ─── 8. Auto-handle browser dialogs  (Chrome DevTools MCP: handleDialog) ─────
function installDialogHandler(page) {
  const handler = (dialog) => {
    logger.info(`Auto-dismissing dialog: ${dialog.type()} "${dialog.message().slice(0, 80)}"`);
    dialog.dismiss().catch(() => dialog.accept().catch(() => {}));
  };
  page.on('dialog', handler);
  return () => page.off('dialog', handler);
}

// ─── 9. Main agent loop ───────────────────────────────────────────────────────
async function runAgentLoop(page, goal, onStep, recentContext = '') {
  const history      = [];
  let   stepCount    = 0;
  const actionWindow = [];   // rolling window — last 12 action keys
  let   activePage   = page;

  logger.info(`Agent loop: "${goal}"`);

  // Auto-dismiss any dialogs that appear
  let removeDialogHandler = installDialogHandler(activePage);

  while (stepCount < MAX_STEPS) {
    stepCount++;

    // ── Observe ──────────────────────────────────────────────────────────────
    await activePage.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
    await waitForDomStable(activePage, { timeout: 2500, quietMs: 250 });

    const urlBefore = activePage.url();
    const ctx = await extractPageContext(activePage);
    const domText = formatContext(ctx);
    const base64  = await cdpScreenshot(activePage);
    if (!base64) logger.warn(`Step ${stepCount}: no screenshot, DOM-only mode`);

    logger.debug(`Step ${stepCount} — ${ctx.url} — ${ctx.elements.length} elements`);

    // ── Plan ─────────────────────────────────────────────────────────────────
    // Append recent voice context to goal on first step only (so agent knows
    // "my number", "my email", etc. even if stated in a prior command)
    const goalWithContext = (stepCount === 1 && recentContext)
      ? `${goal}\n\nContext from recent voice commands:\n${recentContext}`
      : goal;
    const step = await getNextStep(goalWithContext, domText, base64, history);
    logger.info(`Step ${stepCount}: ${JSON.stringify(step)}`);

    if (step.action === 'done') {
      if (onStep) onStep(`✓ Done: ${step.message}`);
      removeDialogHandler();
      return { success: true, message: step.message, steps: history };
    }
    if (step.action === 'failed') {
      if (onStep) onStep(`⚠ ${step.message}`);
      removeDialogHandler();
      return { success: false, message: step.message, steps: history };
    }

    // ── Act ───────────────────────────────────────────────────────────────────
    const pagesBefore = activePage.context().pages().length;
    try {
      // Chrome DevTools MCP: waitForEventsAfterAction wraps every action
      await waitForEventsAfterAction(activePage, () => executeStep(activePage, ctx.elements, step));

      const desc = step.description || step.action;
      history.push(desc);
      if (onStep) onStep(`⚡ ${desc}`);

      // Auto-follow new tabs opened by target=_blank clicks
      if (['click', 'click_xy'].includes(step.action)) {
        // Wait longer (800ms) for browser to open new tab
        await activePage.waitForTimeout(800);
        const allPages = activePage.context().pages();

        if (allPages.length > pagesBefore) {
          // New tab detected — follow it
          const newPage = allPages[allPages.length - 1];
          removeDialogHandler(); // detach from old page
          await newPage.bringToFront().catch(() => {});
          setActivePage(newPage);
          activePage = newPage;
          removeDialogHandler = installDialogHandler(activePage);
          logger.info(`Auto-followed new tab: ${newPage.url()}`);
          if (onStep) onStep(`⚡ Followed new tab`);
        } else {
          // No new tab — if we clicked a link element but URL is unchanged, extract href and navigate
          const el = ctx.elements[step.index];
          const urlAfter = activePage.url();
          if (el?.locator?.pwRole === 'link' && urlAfter === urlBefore) {
            const href = await activePage.evaluate((name) => {
              const links = [...document.querySelectorAll('a[href]')];
              const needle = (name || '').slice(0, 50).toLowerCase();
              for (const a of links) {
                const text = (a.textContent || a.getAttribute('aria-label') || '').trim().toLowerCase();
                if (needle && text.includes(needle)) return a.href;
              }
              return null;
            }, el.name).catch(() => null);

            if (href && href.startsWith('http') && href !== urlBefore) {
              logger.info(`Link click had no effect — navigating to href: ${href}`);
              await activePage.goto(href, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
              await activePage.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
              if (onStep) onStep(`⚡ Navigated via link href`);
              continue;
            }
          }
        }
      }

      // Loop detection — rolling window of last 12 action keys.
      // Catches both consecutive repeats (A-A-A) AND alternating patterns (A-B-A-B-A)
      // that bypass a simple "same as last" check. Typical cause: element changes
      // index on re-render, or button label flips (Play/Pause toggle on YouTube).
      const actionKey = `${step.action}:${step.index ?? ''}:${step.x ?? ''}:${step.y ?? ''}`;
      actionWindow.push(actionKey);
      if (actionWindow.length > 12) actionWindow.shift();
      const keyCount = actionWindow.filter(k => k === actionKey).length;
      if (keyCount >= 3) {
        removeDialogHandler();
        return { success: false, message: `Stuck repeating the same step. Try rephrasing your command.`, steps: history };
      }

    } catch (err) {
      // ── Auto-dismiss overlay when click is intercepted ────────────────────
      // "intercepts pointer events" = a modal/banner/popup is covering the element.
      // Try: Escape → click common close buttons → then let agent retry normally.
      if (/intercepts pointer events/i.test(err.message)) {
        logger.info('Overlay detected — attempting auto-dismiss');
        try {
          await activePage.keyboard.press('Escape');
          await activePage.waitForTimeout(400);
          // Try clicking common dismiss buttons
          const dismissSelectors = [
            'button:has-text("Accept")', 'button:has-text("Close")',
            'button:has-text("Got it")', 'button:has-text("OK")',
            'button:has-text("Dismiss")', '[aria-label="Close"]',
            '.modal-close', '.popup-close', '[data-dismiss="modal"]',
          ];
          for (const sel of dismissSelectors) {
            const btn = activePage.locator(sel).first();
            if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
              await btn.click({ timeout: 2000 }).catch(() => {});
              break;
            }
          }
          await activePage.waitForTimeout(300);
          if (onStep) onStep(`⚡ Dismissed overlay, retrying...`);
        } catch { /* best-effort */ }
        // Don't push to history — let the agent retry the same step cleanly
        continue;
      }

      const errMsg = `${step.description || step.action} → FAILED: ${err.message.slice(0, 150)}`;
      history.push(errMsg);
      logger.warn(`Step error: ${err.message}`);
      if (onStep) onStep(`⚠ ${errMsg}`);
    }
  }

  removeDialogHandler();
  return {
    success: false,
    message: `Reached max steps (${MAX_STEPS}). Last: ${history.slice(-3).join(' → ')}`,
    steps: history,
  };
}

module.exports = { runAgentLoop };
