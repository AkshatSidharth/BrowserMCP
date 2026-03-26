'use strict';

const { getActivePage, connectBrowser } = require('../browser/connect');
const logger = require('../logger');

async function closeTab(_page, _params) {
  const page = await getActivePage();
  const url  = page.url();
  await page.close();
  logger.info(`Closed tab: ${url}`);
  return { success: true, message: `Closed tab (${url}).` };
}

module.exports = closeTab;
