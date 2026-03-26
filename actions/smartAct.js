'use strict';

const { getActivePage } = require('../browser/connect');
const { runAgentLoop }  = require('../brain/agentLoop');
const logger = require('../logger');

/**
 * Action: smart_act
 * Runs the full agentic loop — reads page, acts, re-reads, acts again —
 * until the goal is complete or it can't proceed.
 */
async function smartAct(_page, params, onStep) {
  const { command } = params;
  if (!command) throw new Error('"command" param required.');

  const page = await getActivePage();
  await page.waitForLoadState('domcontentloaded').catch(() => {});

  return runAgentLoop(page, command, onStep);
}

module.exports = smartAct;
