'use strict';

const { connectBrowser, setActivePage, LAUNCH_MODE } = require('../browser/connect');
const logger = require('../logger');

/**
 * Action: new_tab
 * Opens a new browser tab, optionally navigating to a URL or site name.
 */
async function newTab(_page, params) {
  const { url } = params;
  const browser  = await connectBrowser();

  let context;
  if (LAUNCH_MODE) {
    context = browser.contexts()[0];
  } else {
    const contexts = browser.contexts();
    if (!contexts.length) throw new Error('No browser context found.');
    context = contexts[0];
  }

  const page = await context.newPage();
  setActivePage(page); // all subsequent commands go to this tab
  logger.info(`Opened new tab`);

  if (url) {
    const dest = url.includes('.') && !url.startsWith('http') ? `https://${url}` : url;
    await page.goto(dest, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    logger.info(`New tab navigated to ${dest}`);
    return { success: true, message: `Opened new tab at ${dest}.` };
  }

  return { success: true, message: 'Opened a new blank tab.' };
}

module.exports = newTab;
