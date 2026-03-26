'use strict';

const { getActivePage } = require('../browser/connect');
const { analyzeAndAct } = require('../brain/pageAgent');
const logger = require('../logger');

/**
 * Action: smart_act
 * The AI looks at the current page (screenshot + DOM), understands it,
 * and executes whatever steps are needed to complete the user's command.
 * No hardcoded selectors. No predefined flows. Fully autonomous.
 *
 * @param {import('playwright').Page} _page
 * @param {{ command: string }} params
 */
async function smartAct(_page, params) {
  const { command } = params;
  if (!command) throw new Error('"command" param required.');

  const page = await getActivePage();
  await page.waitForLoadState('domcontentloaded');

  return analyzeAndAct(page, command);
}

module.exports = smartAct;
