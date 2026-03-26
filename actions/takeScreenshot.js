'use strict';

const fs = require('fs');
const path = require('path');
const { getActivePage } = require('../browser/connect');
const logger = require('../logger');

const SCREENSHOTS_DIR = path.join(process.cwd(), 'screenshots');

async function takeScreenshot(_page, params) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = (params.filename ? params.filename.replace(/[^a-z0-9_-]/gi, '_') : `screenshot-${ts}`) + '.png';

  if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const outPath = path.join(SCREENSHOTS_DIR, filename);
  logger.info(`Taking screenshot → ${outPath}`);
  const page = await getActivePage();
  await page.screenshot({ path: outPath, fullPage: true });
  return { success: true, message: `Screenshot saved to screenshots/${filename}` };
}

module.exports = takeScreenshot;
