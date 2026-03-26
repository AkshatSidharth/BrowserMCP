'use strict';

const { navigateTo } = require('../browser/connect');
const logger = require('../logger');

/**
 * Action: search_google
 * Opens a Google search for the given query.
 *
 * @param {import('playwright').Page} _page
 * @param {{ query: string }} params
 */
async function searchGoogle(_page, params) {
  const { query } = params;
  if (!query) throw new Error('"query" param is required for search_google.');

  const url = `https://www.google.com/search?q=${encodeURIComponent(query)}`;
  logger.info(`Searching Google for: "${query}"`);
  await navigateTo(url);
  return { success: true, message: `Searched Google for "${query}".` };
}

module.exports = searchGoogle;
