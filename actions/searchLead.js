'use strict';

require('dotenv').config();
const { getActivePage, navigateTo } = require('../browser/connect');
const logger = require('../logger');

const CRM_URL = process.env.CRM_BASE_URL || 'https://app.kapturecrm.com';

const SELECTORS = {
  // Main CRM search bar / global search input
  searchInput: [
    'input[placeholder*="Search" i]',
    '[data-test="global-search"]',
    '#global-search',
    'input[name="search"]',
    'input[type="search"]',
  ],
};

/**
 * Action: search_lead
 * Uses the CRM's built-in search to find a lead by name or phone.
 *
 * @param {import('playwright').Page} _page
 * @param {{ query: string }} params
 */
async function searchLead(_page, params) {
  const { query } = params;
  if (!query) throw new Error('"query" param is required for search_lead.');

  // Try the CRM search URL pattern first (common in Kapture and similar CRMs)
  const searchUrl = `${CRM_URL}/contacts?search=${encodeURIComponent(query)}`;
  logger.info(`Searching CRM for: "${query}"`);
  const page = await navigateTo(searchUrl);
  await page.waitForLoadState('domcontentloaded');

  // If a search input is visible, also type into it for in-page search
  for (const sel of SELECTORS.searchInput) {
    try {
      const el = await page.$(sel);
      if (el) {
        await el.fill(query);
        await el.press('Enter');
        await page.waitForTimeout(1500); // Let results load
        break;
      }
    } catch { /* skip */ }
  }

  return { success: true, message: `Searched CRM for "${query}". Check the browser for results.` };
}

module.exports = searchLead;
