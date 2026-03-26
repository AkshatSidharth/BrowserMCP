'use strict';

const { getActivePage } = require('../browser/connect');
const logger = require('../logger');

/**
 * Action: login_to_website
 * Reads the current page DOM to find login fields dynamically,
 * fills in credentials and submits. Works on any login page.
 *
 * @param {import('playwright').Page} _page
 * @param {{ username: string, password: string }} params
 */
async function loginToWebsite(_page, params) {
  const { username, password } = params;
  if (!username) throw new Error('"username" param is required for login_to_website.');
  if (!password) throw new Error('"password" param is required for login_to_website.');

  const page = await getActivePage();
  await page.waitForLoadState('domcontentloaded');

  // ── Step 1: Read all visible inputs from the DOM ─────────────────────────
  // We extract attributes that help identify what each field is for.
  const inputs = await page.$$eval('input:not([type="hidden"])', (els) =>
    els.map((el) => ({
      type:        el.type        || '',
      name:        el.name        || '',
      id:          el.id          || '',
      placeholder: el.placeholder || '',
      ariaLabel:   el.getAttribute('aria-label') || '',
      autocomplete: el.getAttribute('autocomplete') || '',
      selector:    el.id
        ? `#${CSS.escape(el.id)}`
        : el.name
          ? `input[name="${el.name}"]`
          : null,
    }))
  );

  logger.debug(`Found ${inputs.length} inputs on page: ${JSON.stringify(inputs)}`);

  // ── Step 2: Identify username and password fields from DOM attributes ─────
  const isUsernameField = (inp) => {
    const combined = [inp.type, inp.name, inp.id, inp.placeholder, inp.ariaLabel, inp.autocomplete]
      .join(' ').toLowerCase();
    return (
      inp.type === 'email' ||
      inp.type === 'text' ||
      /user|email|login|phone|mobile|account|uname/i.test(combined)
    ) && !/pass|pwd|secret/i.test(combined);
  };

  const isPasswordField = (inp) => {
    const combined = [inp.type, inp.name, inp.id, inp.placeholder, inp.ariaLabel, inp.autocomplete]
      .join(' ').toLowerCase();
    return inp.type === 'password' || /pass|pwd|secret/i.test(combined);
  };

  const usernameInput = inputs.find(isUsernameField);
  const passwordInput = inputs.find(isPasswordField);

  if (!usernameInput?.selector) {
    return { success: false, message: 'Could not find a username/email field on this page.' };
  }
  if (!passwordInput?.selector) {
    return { success: false, message: 'Could not find a password field on this page.' };
  }

  logger.info(`Username field: ${usernameInput.selector}`);
  logger.info(`Password field: ${passwordInput.selector}`);

  // ── Step 3: Fill the fields ───────────────────────────────────────────────
  await page.fill(usernameInput.selector, username);
  await page.waitForTimeout(300);
  await page.fill(passwordInput.selector, password);
  await page.waitForTimeout(300);

  // ── Step 4: Find and click the submit button ──────────────────────────────
  // Read submit buttons from DOM dynamically too
  const submitSel = await page.$$eval(
    'button, input[type="submit"], [role="button"]',
    (els) => {
      const el = els.find((e) => {
        const text = (e.textContent || e.value || e.getAttribute('aria-label') || '').toLowerCase();
        return /log.?in|sign.?in|continue|submit|next|enter/i.test(text);
      });
      if (!el) return null;
      if (el.id) return `#${CSS.escape(el.id)}`;
      if (el.type === 'submit') return 'input[type="submit"]';
      return null;
    }
  );

  if (submitSel) {
    logger.info(`Clicking submit: ${submitSel}`);
    await page.click(submitSel);
  } else {
    // Fallback: press Enter on password field
    logger.info('No submit button found — pressing Enter');
    await page.press(passwordInput.selector, 'Enter');
  }

  // ── Step 5: Wait for navigation or success signal ─────────────────────────
  await page.waitForTimeout(2000);

  return { success: true, message: `Logged in as "${username}". Check the browser for result.` };
}

module.exports = loginToWebsite;
