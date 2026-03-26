'use strict';

const { navigateTo: go } = require('../browser/connect');
const logger = require('../logger');

/**
 * Action: navigate_to
 * Navigates the browser to an arbitrary URL.
 *
 * @param {import('playwright').Page} _page
 * @param {{ url: string }} params
 */
async function navigateTo(_page, params) {
  let { url } = params;
  if (!url) throw new Error('"url" param is required for navigate_to.');

  // Auto-prepend https:// if no protocol given
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;

  logger.info(`Navigating to ${url}`);
  await go(url);
  return { success: true, message: `Navigated to ${url}.` };
}

module.exports = navigateTo;
