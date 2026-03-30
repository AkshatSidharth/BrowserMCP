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

// Optional: explicit path to Chromium binary.
// If not set, Playwright automatically finds its own bundled Chromium.
// Only set CHROMIUM_EXEC in .env when you need to override (e.g. Linux servers).
const CHROMIUM_EXEC = process.env.CHROMIUM_EXEC || null;

let _browser = null;
let _context = null;
let _page    = null;

// ─── Connect or launch ────────────────────────────────────────────────────────

async function connectBrowser() {
  if (_browser) return _browser;

  if (LAUNCH_MODE) {
    const execInfo = CHROMIUM_EXEC ? ` (${CHROMIUM_EXEC})` : ' (Playwright bundled)';
    logger.info(`Launching headless Chromium${execInfo} ...`);
    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-blink-features=AutomationControlled', // hide automation flag
      ],
    };
    if (CHROMIUM_EXEC) launchOptions.executablePath = CHROMIUM_EXEC;
    _browser = await chromium.launch(launchOptions);
    _context = await _browser.newContext({
      // Appear as a real Chrome on macOS to avoid bot detection
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1280, height: 800 },
    });
    _page = await _context.newPage();
    // Remove the webdriver flag that sites use to detect Playwright
    await _page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
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
  if (!pages.length) {
    // No tabs open — create a new one instead of failing
    logger.info('No open tabs found — opening a new tab.');
    _page = await contexts[0].newPage();
    return _page;
  }

  if (_page && !_page.isClosed()) return _page;
  _page = pages[pages.length - 1];
  logger.debug(`Active page: ${_page.url()}`);
  return _page;
}

/**
 * Find an already-open tab whose URL contains the given hostname/pattern.
 * Returns the page or null.
 */
async function findOpenTab(urlPattern) {
  await connectBrowser();
  const contexts = _browser.contexts();
  for (const ctx of contexts) {
    for (const pg of ctx.pages()) {
      if (!pg.isClosed() && pg.url().toLowerCase().includes(urlPattern.toLowerCase())) {
        return pg;
      }
    }
  }
  return null;
}

/**
 * Switch to an existing tab (bring to front + set as active).
 */
async function switchToTab(page) {
  _page = page;
  await page.bringToFront().catch(() => {});
  if (process.platform === 'darwin') {
    const { exec } = require('child_process');
    exec(`osascript -e 'tell application "Google Chrome" to activate'`).catch?.(() => {});
  }
  logger.info(`Switched to tab: ${page.url()}`);
  return page;
}

/**
 * Navigate the active page to a URL.
 */
async function navigateTo(url) {
  const page = await getActivePage();
  logger.info(`Navigating to ${url}`);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  // Bring Chrome to front on macOS so the user can see the result
  await page.bringToFront().catch(() => {});
  if (process.platform === 'darwin') {
    const { exec } = require('child_process');
    exec(`osascript -e 'tell application "Google Chrome" to activate'`).catch?.(() => {});
  }
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

/**
 * Explicitly set the active page (called when a new tab is opened).
 */
function setActivePage(page) {
  _page = page;
}

module.exports = { connectBrowser, getActivePage, setActivePage, findOpenTab, switchToTab, navigateTo, disconnect, LAUNCH_MODE };
