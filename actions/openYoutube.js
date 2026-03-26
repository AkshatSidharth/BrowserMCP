'use strict';

const { navigateTo } = require('../browser/connect');
const logger = require('../logger');

/**
 * Action: open_youtube
 * Navigates the browser to YouTube.
 */
async function openYoutube(_page, _params) {
  logger.info('Opening YouTube ...');
  await navigateTo('https://www.youtube.com');
  return { success: true, message: 'Opened YouTube.' };
}

module.exports = openYoutube;
