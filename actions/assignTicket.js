'use strict';

require('dotenv').config();
const { navigateTo } = require('../browser/connect');
const logger = require('../logger');

const CRM_URL = process.env.CRM_BASE_URL || 'https://app.kapturecrm.com';

const SELECTORS = {
  assignDropdown: [
    '[data-test="assign-agent"]',
    'select[name="assigned_to"]',
    '.assign-to-dropdown',
    'button:has-text("Assign")',
  ],
  agentOption: (agentName) => [
    `option:has-text("${agentName}")`,
    `[data-agent-name="${agentName}"]`,
    `li:has-text("${agentName}")`,
  ],
  saveBtn: [
    'button[type="submit"]',
    'button:has-text("Save")',
    'button:has-text("Assign")',
  ],
};

/**
 * Action: assign_ticket
 * Opens a ticket and assigns it to the specified agent.
 *
 * @param {import('playwright').Page} _page
 * @param {{ ticket_id: string, agent: string }} params
 */
async function assignTicket(_page, params) {
  const { ticket_id, agent } = params;
  if (!ticket_id) throw new Error('"ticket_id" is required for assign_ticket.');
  if (!agent)     throw new Error('"agent" is required for assign_ticket.');

  const ticketUrl = `${CRM_URL}/tickets/${ticket_id}`;
  logger.info(`Opening ticket ${ticket_id} to assign to "${agent}"`);
  const page = await navigateTo(ticketUrl);
  await page.waitForLoadState('domcontentloaded');

  // Click assign dropdown
  let opened = false;
  for (const sel of SELECTORS.assignDropdown) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); opened = true; break; }
    } catch { /* try next */ }
  }

  if (!opened) {
    return {
      success: false,
      message: `Could not find assign dropdown on ticket ${ticket_id}. Please assign manually.`,
    };
  }

  await page.waitForTimeout(500);

  // Select agent from dropdown
  let selected = false;
  for (const sel of SELECTORS.agentOption(agent)) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); selected = true; break; }
    } catch { /* try next */ }
  }

  if (!selected) {
    return {
      success: false,
      message: `Agent "${agent}" not found in dropdown. Please assign manually.`,
    };
  }

  // Save
  for (const sel of SELECTORS.saveBtn) {
    try {
      const el = await page.$(sel);
      if (el) { await el.click(); break; }
    } catch { /* try next */ }
  }

  return { success: true, message: `Ticket ${ticket_id} assigned to "${agent}".` };
}

module.exports = assignTicket;
