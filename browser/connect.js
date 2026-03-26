'use strict';

require('dotenv').config();
const path = require('path');
const { chromium } = require('playwright');
const logger = require('../logger');

const CDP_URL = `http://localhost:${process.env.CHROME_DEBUG_PORT || 9222}`;

// ─── Launch mode ──────────────────────────────────────────────────────────────
// On servers with no GUI Chrome, we launch Playwright's bundled Chromium
// directly (headless). Pass --launch flag or set BROWSER_LAUNCH=true in .env.
// On a local desktop, leave this false and start Chrome manually with
//   chrome --remote-debugging-port=9222 --user-data-dir="./chrome-profile"

const LAUNCH_MODE =
  process.argv.includes('--launch') ||
  process.env.BROWSER_LAUNCH === 'true';

// Path to the pre-installed Playwright Chromium on this machine.
// Playwright looks here when PLAYWRIGHT_BROWSERS_PATH is set, or falls back
// to the default cache location.
const CHROMIUM_EXEC =
  process.env.CHROMIUM_EXEC ||
  '/root/.cache/ms-playwright/chromium-1194/chrome-linux/chrome';

let _browser = null;
let _context = null;
let _page    = null;

// ─── Connect or launch ────────────────────────────────────────────────────────

async function connectBrowser() {
  if (_browser) return _browser;

  if (LAUNCH_MODE) {
    logger.info(`Launching headless Chromium (${CHROMIUM_EXEC}) ...`);
    _browser = await chromium.launch({
      executablePath: CHROMIUM_EXEC,
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',  // important in Docker / low-memory envs
        '--disable-gpu',
      ],
    });
    _context = await _browser.newContext();
    _page    = await _context.newPage();
    logger.info('Headless Chromium launched.');
  } else {
    logger.info(`Connecting to Chrome at ${CDP_URL} ...`);
    try {
      _browser = await chromium.connectOverCDP(CDP_URL);
      logger.info('Connected to Chrome successfully.');
    } catch (err) {
      logger.error(
        `Could not connect to Chrome. Either:\n` +
        `  A) Start Chrome with:\n` +
        `       chrome --remote-debugging-port=${process.env.CHROME_DEBUG_PORT || 9222} --user-data-dir="./chrome-profile"\n` +
        `  B) Use launch mode for headless servers:\n` +
        `       node index.js --demo --launch`,
      );
      throw err;
    }
  }

  _browser.on('disconnected', () => {
    logger.warn('Browser disconnected. Will reconnect on next command.');
    _browser = null;
    _context = null;
    _page    = null;
  });

  return _browser;
}

/**
 * Return the active page.
 * - Launch mode: returns the single managed page.
 * - CDP mode: returns the last open tab.
 */
async function getActivePage() {
  await connectBrowser();

  // Launch mode: reuse the managed page
  if (LAUNCH_MODE) {
    if (_page && !_page.isClosed()) return _page;
    _page = await _context.newPage();
    return _page;
  }

  // CDP mode: find a page from the remote contexts
  const contexts = _browser.contexts();
  if (!contexts.length) throw new Error('No browser contexts found.');
  const pages = contexts[0].pages();
  if (!pages.length)    throw new Error('No open tabs found. Open a tab in Chrome first.');

  if (_page && !_page.isClosed()) return _page;
  _page = pages[pages.length - 1];
  logger.debug(`Active page: ${_page.url()}`);
  return _page;
}

/**
 * Navigate the active page to a URL.
 */
async function navigateTo(url) {
  const page = await getActivePage();
  logger.info(`Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  return page;
}

/**
 * Disconnect / close cleanly.
 */
async function disconnect() {
  if (_browser) {
    await _browser.close();
    _browser = null;
    _context = null;
    _page    = null;
  }
}

module.exports = { connectBrowser, getActivePage, navigateTo, disconnect, LAUNCH_MODE };
