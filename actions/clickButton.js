'use strict';

const { getActivePage } = require('../browser/connect');
const logger = require('../logger');

/**
 * Action: click_button
 * Finds any clickable element on the page whose visible text matches `text`
 * and clicks it. Works on buttons, links, divs with role=button, etc.
 */
async function clickButton(_page, params) {
  const { text } = params;
  if (!text) throw new Error('"text" param required. e.g. "Next", "Log in", "Submit"');

  const page = await getActivePage();
  await page.waitForLoadState('domcontentloaded');

  const textLower = text.toLowerCase().trim();

  // Read all clickable elements from DOM
  const clickables = await page.$$eval(
    'button, a, [role="button"], input[type="submit"], input[type="button"], [onclick], label',
    (els) => els.map((el, i) => ({
      index: i,
      tag:   el.tagName.toLowerCase(),
      text:  (el.innerText || el.value || el.getAttribute('aria-label') || '').trim().slice(0, 100),
      id:    el.id || '',
      name:  el.getAttribute('name') || '',
      type:  el.getAttribute('type') || '',
    }))
  );

  logger.debug(`Found ${clickables.length} clickable elements`);

  // Find best match by text similarity
  const exactMatch = clickables.find(el => el.text.toLowerCase() === textLower);
  const partialMatch = clickables.find(el => el.text.toLowerCase().includes(textLower) || textLower.includes(el.text.toLowerCase()));
  const best = exactMatch || partialMatch;

  if (!best) {
    return { success: false, message: `No clickable element found with text "${text}". Check the page.` };
  }

  logger.info(`Clicking "${best.text}" (${best.tag})`);

  // Use Playwright's getByText for reliable clicking
  try {
    await page.getByText(best.text, { exact: !!exactMatch }).first().click({ timeout: 5000 });
  } catch {
    // Fallback to index-based click
    await page.$$eval(
      'button, a, [role="button"], input[type="submit"], input[type="button"], [onclick], label',
      (els, idx) => els[idx]?.click(),
      best.index
    );
  }

  await page.waitForTimeout(500);
  return { success: true, message: `Clicked "${best.text}".` };
}

module.exports = clickButton;
