'use strict';

const { getActivePage } = require('../browser/connect');
const logger = require('../logger');

/**
 * Action: fill_input
 * Reads ALL visible inputs from the DOM, scores against `field` description,
 * clicks the best match to focus it, then types `value` character by character.
 * This works even on inputs with custom React/Vue event handlers that block page.fill().
 */
async function fillInput(_page, params) {
  const { field, value } = params;
  if (!field) throw new Error('"field" param required. e.g. "phone number", "email", "password"');
  if (value === undefined) throw new Error('"value" param required.');

  const page = await getActivePage();
  await page.waitForLoadState('domcontentloaded');

  // ── Pull every visible input + textarea from the DOM ──────────────────────
  const inputs = await page.$$eval(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea',
    (els) => els.map((el, i) => {
      let labelText = '';
      if (el.id) {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) labelText = lbl.innerText.trim();
      }
      if (!labelText) {
        const parent = el.closest('label, [class*="field"], [class*="form"], [class*="input"], [class*="wrap"]');
        if (parent) labelText = parent.innerText.replace(el.value || '', '').trim().slice(0, 80);
      }
      const rect = el.getBoundingClientRect();
      // Detect if input is inside a header/nav — these are search bars, not form fields
      const inNav = !!el.closest('header, nav, [class*="header"], [class*="Header"], [class*="navbar"], [class*="NavBar"], [class*="search-bar"], [class*="SearchBar"], [role="banner"]');
      return {
        index:       i,
        type:        el.type        || 'text',
        name:        el.name        || '',
        id:          el.id          || '',
        placeholder: el.placeholder || '',
        ariaLabel:   el.getAttribute('aria-label') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        labelText,
        inNav,
        visible: rect.width > 0 && rect.height > 0,
      };
    })
  );

  logger.debug(`Found ${inputs.length} inputs: ${JSON.stringify(inputs.map(i => ({ type: i.type, placeholder: i.placeholder, name: i.name, id: i.id })))}`);

  const visible = inputs.filter(i => i.visible);
  if (!visible.length) return { success: false, message: 'No visible input fields found on this page.' };

  // ── Score each input against the field description ────────────────────────
  const fieldLower = field.toLowerCase();
  const keywords   = fieldLower.split(/\s+/);

  function score(inp) {
    const hay = [inp.type, inp.name, inp.id, inp.placeholder, inp.ariaLabel, inp.autocomplete, inp.labelText]
      .join(' ').toLowerCase();
    let s = keywords.reduce((acc, kw) => acc + (hay.includes(kw) ? 2 : 0), 0);
    if (fieldLower.includes('password') && inp.type === 'password') s += 5;
    if ((fieldLower.includes('phone') || fieldLower.includes('mobile') || fieldLower.includes('number')) && inp.type === 'tel') s += 5;
    if (fieldLower.includes('email') && inp.type === 'email') s += 5;
    // Heavily penalise navbar/header inputs (search bars, site-wide search)
    // so they never win over login/form fields on the same page
    if (inp.inNav) s -= 20;
    return s;
  }

  const sorted = [...visible].sort((a, b) => score(b) - score(a));
  const best   = sorted[0];
  logger.info(`Best field match for "${field}": index=${best.index} type=${best.type} placeholder="${best.placeholder}" name="${best.name}"`);

  // ── Get a direct element handle by index (avoids broken selector strings) ─
  const allHandles = await page.$$('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea');
  const handle = allHandles[best.index];

  if (!handle) return { success: false, message: `Could not get element handle for field "${field}".` };

  // ── Dismiss any overlay that might block the click ───────────────────────
  try {
    await page.keyboard.press('Escape');
    await page.waitForTimeout(200);
  } catch { /* best-effort */ }

  // ── Click to focus, triple-click to clear, then type char-by-char ─────────
  await handle.scrollIntoViewIfNeeded();

  try {
    await handle.click({ clickCount: 3, timeout: 5000 });
    await page.waitForTimeout(150);
    await page.keyboard.type(String(value), { delay: 40 });
  } catch (clickErr) {
    // Overlay is blocking — use JS to set value directly then dispatch events
    logger.warn(`fillInput click blocked (${clickErr.message.slice(0,80)}) — using JS fallback`);
    await page.evaluate(({ idx, val }) => {
      const els = document.querySelectorAll(
        'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea'
      );
      const el = els[idx];
      if (!el) return;
      // Native value setter trick for React controlled inputs
      const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeInputValueSetter) {
        nativeInputValueSetter.call(el, val);
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else {
        el.value = val;
        el.dispatchEvent(new Event('input',  { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
      el.focus();
    }, { idx: best.index, val: String(value) });
  }

  logger.info(`Typed "${value}" into field "${field}"`);
  return { success: true, message: `Entered "${value}" in the ${field} field.` };
}

module.exports = fillInput;
