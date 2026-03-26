'use strict';

require('dotenv').config();
const { navigateTo } = require('../browser/connect');
const logger = require('../logger');

const CRM_URL = process.env.CRM_BASE_URL || 'https://app.kapturecrm.com';

const SELECTORS = {
  resolveBtn: [
    '[data-test="resolve-ticket"]',
    'button:has-text("Resolve")',
    'button:has-text("Close Ticket")',
    'a:has-text("Mark Resolved")',
  ],
  confirmBtn: [
    'button:has-text("Yes")',
    'button:has-text("Confirm")',
    'button:has-text("OK")',
  ],
};

/**
 * Action: resolve_ticket  (DESTRUCTIVE — requires user confirmation via guard.js)
 * Opens a ticket and clicks the Resolve button.
 *
 * @param {import('playwright').Page} _page
 * @param {{ ticket_id: string }} params
 */
async function resolveTicket(_page, params) {
  const { ticket_id } = params;
  if (!ticket_id) throw new Error('"ticket_id" is required for resolve_ticket.');

  const ticketUrl = `${CRM_URL}/tickets/${ticket_id}`;
  logger.info(`Resolving ticket ${ticket_id} ...`);
  const page = await navigateTo(ticketUrl);
  await page.waitForLoadState('domcontentloaded');

  // Click resolve
  let clicked = false;
  for (const sel of SELECTORS.resolveBtn) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); clicked = true; break; }
    } catch { /* try next */ }
  }

  if (!clicked) {
    return {
      success: false,
      message: `Resolve button not found on ticket ${ticket_id}. Please resolve manually.`,
    };
  }

  // Handle confirmation dialog if present
  await page.waitForTimeout(500);
  for (const sel of SELECTORS.confirmBtn) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); break; }
    } catch { /* no dialog, skip */ }
  }

  return { success: true, message: `Ticket ${ticket_id} marked as resolved.` };
}

module.exports = resolveTicket;
