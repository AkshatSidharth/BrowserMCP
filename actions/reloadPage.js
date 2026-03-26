'use strict';

const { getActivePage } = require('../browser/connect');
const logger = require('../logger');

async function reloadPage(_page, _params) {
  logger.info('Reloading page ...');
  const page = await getActivePage();
  await page.reload({ waitUntil: 'domcontentloaded' });
  return { success: true, message: 'Page reloaded.' };
}

module.exports = reloadPage;
