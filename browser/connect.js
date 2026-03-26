'use strict';

require('dotenv').config();
const { chromium } = require('playwright');
const logger = require('../logger');

const CDP_URL = `http://localhost:${process.env.CHROME_DEBUG_PORT || 9222}`;

let _browser = null;
let _page = null;

/**
 * Connect to an already-running Chrome session via Chrome DevTools Protocol.
 *
 * BEFORE running this app, launch Chrome with:
 *   chrome --remote-debugging-port=9222 --user-data-dir="./chrome-profile"
 *
 * This reuses your existing login sessions (CRM, Gmail, etc.) without any
 * credential handling inside the agent.
 */
async function connectBrowser() {
  if (_browser) return _browser;

  logger.info(`Connecting to Chrome at ${CDP_URL} ...`);
  try {
    _browser = await chromium.connectOverCDP(CDP_URL);
    logger.info('Connected to Chrome successfully.');
  } catch (err) {
    logger.error(
      `Could not connect to Chrome. Make sure Chrome is running with:\n` +
      `  chrome --remote-debugging-port=${process.env.CHROME_DEBUG_PORT || 9222} --user-data-dir="./chrome-profile"`,
    );
    throw err;
  }

  // Reconnect automatically if the browser disconnects
  _browser.on('disconnected', () => {
    logger.warn('Chrome disconnected. Will reconnect on next command.');
    _browser = null;
    _page = null;
  });

  return _browser;
}

/**
 * Return the active (foreground) page from the connected browser.
 * If multiple tabs are open, returns the last one — usually the visible tab.
 */
async function getActivePage() {
  const browser = await connectBrowser();
  const contexts = browser.contexts();

  if (!contexts.length) {
    throw new Error('No browser contexts found. Open a tab in Chrome first.');
  }

  const pages = contexts[0].pages();
  if (!pages.length) {
    throw new Error('No open tabs found. Open a tab in Chrome first.');
  }

  // Prefer a cached page unless it's been closed
  if (_page && !_page.isClosed()) return _page;

  // Use the last tab as the "active" one
  _page = pages[pages.length - 1];
  logger.debug(`Active page: ${_page.url()}`);
  return _page;
}

/**
 * Navigate the active page to a URL and wait until the network is idle.
 */
async function navigateTo(url) {
  const page = await getActivePage();
  logger.info(`Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return page;
}

/**
 * Disconnect cleanly (called on shutdown).
 */
async function disconnect() {
  if (_browser) {
    await _browser.close();
    _browser = null;
    _page = null;
  }
}

module.exports = { connectBrowser, getActivePage, navigateTo, disconnect };
