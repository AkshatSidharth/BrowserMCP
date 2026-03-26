'use strict';

require('dotenv').config();
const { getActivePage, navigateTo } = require('../browser/connect');
const logger = require('../logger');

const CRM_URL = process.env.CRM_BASE_URL || 'https://app.kapturecrm.com';

// ─── Selector config ──────────────────────────────────────────────────────────
// Update these selectors to match your CRM's actual UI.
// The easiest way: open your CRM, right-click a field → "Inspect", copy selector.
//
// For Kapture CRM the lead creation form is typically at:
//   /contacts/add  OR  /leads/create
//
// IMPORTANT: Selectors break when the CRM updates its UI. Use data attributes
// (data-test, data-id) when available as they are more stable than CSS classes.

const SELECTORS = {
  // Navigation link / button to open the "Create Lead" form
  createLeadBtn: [
    '[data-test="create-lead"]',         // Preferred: data-test attribute
    'a[href*="/leads/create"]',
    'button:has-text("New Lead")',
    'button:has-text("Add Lead")',
    'a:has-text("Create Lead")',
  ],

  // Form fields
  nameField:  ['input[name="name"]',  'input[placeholder*="Name" i]',  '#contact_name'],
  phoneField: ['input[name="phone"]', 'input[placeholder*="Phone" i]', '#contact_phone'],
  emailField: ['input[name="email"]', 'input[placeholder*="Email" i]', '#contact_email'],
  noteField:  ['textarea[name="note"]', 'textarea[placeholder*="Note" i]', '#contact_note'],

  // Submit button
  submitBtn: [
    'button[type="submit"]',
    'button:has-text("Save")',
    'button:has-text("Create")',
    'input[type="submit"]',
  ],
};

// ─── Helper: try multiple selectors until one works ───────────────────────────
async function fillFirst(page, selectorList, value) {
  for (const sel of selectorList) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.fill('');   // clear first
        await el.fill(value);
        return true;
      }
    } catch { /* try next */ }
  }
  logger.warn(`Could not find field for selectors: ${selectorList.join(', ')}`);
  return false;
}

async function clickFirst(page, selectorList) {
  for (const sel of selectorList) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.click();
        return true;
      }
    } catch { /* try next */ }
  }
  return false;
}

// ─── Action handler ───────────────────────────────────────────────────────────

/**
 * Action: create_lead
 * Navigates to the CRM's "Create Lead" form and fills in the provided details.
 *
 * @param {import('playwright').Page} _page
 * @param {{ name: string, phone?: string, email?: string, note?: string }} params
 */
async function createLead(_page, params) {
  const { name, phone, email, note } = params;
  if (!name) throw new Error('"name" param is required for create_lead.');

  // Navigate to the create-lead URL directly
  const createUrl = `${CRM_URL}/contacts/add`;
  logger.info(`Opening Create Lead form at ${createUrl}`);
  const page = await navigateTo(createUrl);
  await page.waitForLoadState('domcontentloaded');

  // If direct URL didn't land on the form, try clicking the button
  const onForm = await page.$('form');
  if (!onForm) {
    logger.debug('No form found via direct URL — trying nav button ...');
    await clickFirst(page, SELECTORS.createLeadBtn);
    await page.waitForLoadState('domcontentloaded');
  }

  logger.info(`Filling lead: name="${name}" phone="${phone || ''}" email="${email || ''}"`);
  await fillFirst(page, SELECTORS.nameField,  name);
  if (phone) await fillFirst(page, SELECTORS.phoneField, phone);
  if (email) await fillFirst(page, SELECTORS.emailField, email);
  if (note)  await fillFirst(page, SELECTORS.noteField,  note);

  // Submit
  const submitted = await clickFirst(page, SELECTORS.submitBtn);
  if (!submitted) {
    logger.warn('Submit button not found — form may need manual confirmation.');
    return { success: false, message: 'Form filled but submit button not found. Please submit manually.' };
  }

  // Wait briefly for a success indicator
  try {
    await page.waitForSelector(
      'text=/saved|created|success/i',
      { timeout: 5000 },
    );
  } catch {
    // No confirmation toast found — the action may still have worked
    logger.debug('No success toast found after submit.');
  }

  return { success: true, message: `Lead "${name}" created in CRM.` };
}

module.exports = createLead;
