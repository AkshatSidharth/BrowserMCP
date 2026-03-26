'use strict';

const { runDesktopAgent } = require('../brain/desktopAgent');

/**
 * Action: desktop_act
 * Runs the desktop automation agent — takes a screenshot of the full desktop,
 * uses GPT-4o vision to plan AppleScript/shell steps, and executes them.
 */
async function desktopAct(_page, params, onStep) {
  const { command } = params;
  if (!command) throw new Error('"command" param required.');
  return runDesktopAgent(command, onStep);
}

module.exports = desktopAct;
