'use strict';

const { getActivePage } = require('../browser/connect');
const logger = require('../logger');

async function goBack(_page, _params) {
  logger.info('Navigating back ...');
  const page = await getActivePage();
  await page.goBack({ waitUntil: 'domcontentloaded' });
  return { success: true, message: 'Navigated back.' };
}

module.exports = goBack;
