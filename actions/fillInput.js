'use strict';

const { getActivePage } = require('../browser/connect');
const logger = require('../logger');

/**
 * Action: fill_input
 * Reads ALL visible inputs from the DOM, finds the one that best matches
 * the `field` description, and fills it with `value`.
 * Works on any page without hardcoded selectors.
 */
async function fillInput(_page, params) {
  const { field, value } = params;
  if (!field) throw new Error('"field" param required. e.g. "phone number", "email", "password"');
  if (value === undefined) throw new Error('"value" param required.');

  const page = await getActivePage();
  await page.waitForLoadState('domcontentloaded');

  // Pull every input + textarea from the DOM with all identifying attributes
  const inputs = await page.$$eval(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]), textarea',
    (els) => els.map((el, i) => {
      // Try to find the label text associated with this input
      let labelText = '';
      if (el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        if (lbl) labelText = lbl.innerText.trim();
      }
      if (!labelText) {
        const parent = el.closest('label, [class*="field"], [class*="form"], [class*="input"]');
        if (parent) labelText = parent.innerText.replace(el.value || '', '').trim().slice(0, 60);
      }
      return {
        index: i,
        type:        el.type        || 'text',
        name:        el.name        || '',
        id:          el.id          || '',
        placeholder: el.placeholder || '',
        ariaLabel:   el.getAttribute('aria-label') || '',
        autocomplete: el.getAttribute('autocomplete') || '',
        labelText,
      };
    })
  );

  logger.debug(`Page inputs: ${JSON.stringify(inputs)}`);

  if (!inputs.length) {
    return { success: false, message: 'No input fields found on this page.' };
  }

  // Score each input against the field description
  const fieldLower = field.toLowerCase();
  const keywords   = fieldLower.split(/\s+/);

  function score(inp) {
    const hay = [inp.type, inp.name, inp.id, inp.placeholder, inp.ariaLabel, inp.autocomplete, inp.labelText]
      .join(' ').toLowerCase();
    return keywords.reduce((s, kw) => s + (hay.includes(kw) ? 1 : 0), 0);
  }

  const sorted = [...inputs].sort((a, b) => score(b) - score(a));
  const best   = sorted[0];

  if (score(best) === 0) {
    // Nothing matched — just fill the first visible input as a last resort
    logger.warn(`No field matched "${field}" — filling first input`);
  }

  // Build the most reliable selector for this element
  let sel;
  if (best.id)   sel = `#${best.id}`;
  else if (best.name) sel = `input[name="${best.name}"]`;
  else sel = `(input:not([type="hidden"]):not([type="submit"]), textarea):visible >> nth=${best.index}`;

  logger.info(`Filling field "${field}" → selector: ${sel}  value: "${value}"`);
  await page.fill(sel, String(value));

  return { success: true, message: `Filled "${field}" with "${value}".` };
}

module.exports = fillInput;
