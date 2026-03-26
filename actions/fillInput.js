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
      return {
        index:       i,
        type:        el.type        || 'text',
        name:        el.name        || '',
        id:          el.id          || '',
        placeholder: el.placeholder || '',
        ariaLabel:   el.getAttribute('aria-label') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        labelText,
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
    // Bonus for password type when user asks for password
    let s = keywords.reduce((acc, kw) => acc + (hay.includes(kw) ? 2 : 0), 0);
    if (fieldLower.includes('password') && inp.type === 'password') s += 5;
    if ((fieldLower.includes('phone') || fieldLower.includes('mobile') || fieldLower.includes('number')) && inp.type === 'tel') s += 5;
    if (fieldLower.includes('email') && inp.type === 'email') s += 5;
    return s;
  }

  const sorted = [...visible].sort((a, b) => score(b) - score(a));
  const best   = sorted[0];
  logger.info(`Best field match for "${field}": index=${best.index} type=${best.type} placeholder="${best.placeholder}" name="${best.name}"`);

  // ── Get a direct element handle by index (avoids broken selector strings) ─
  const allHandles = await page.$$('input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]), textarea');
  const handle = allHandles[best.index];

  if (!handle) return { success: false, message: `Could not get element handle for field "${field}".` };

  // ── Click to focus, triple-click to clear, then type char-by-char ─────────
  await handle.scrollIntoViewIfNeeded();
  await handle.click({ clickCount: 3 }); // triple-click selects all existing text
  await page.waitForTimeout(150);
  await page.keyboard.type(String(value), { delay: 40 }); // 40ms between keystrokes — mimics human typing

  logger.info(`Typed "${value}" into field "${field}"`);
  return { success: true, message: `Entered "${value}" in the ${field} field.` };
}

module.exports = fillInput;
