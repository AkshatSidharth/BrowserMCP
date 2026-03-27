'use strict';

const { dispatchCrmCommand } = require('../brain/kaptureAgent');

/**
 * kaptureAct — direct Kapture CRM API action.
 * Bypasses the browser entirely; calls Kapture REST APIs with session cookies.
 *
 * @param {*} _page   ignored — no browser needed
 * @param {{ command: string }} params
 * @param {Function} [onStep]
 */
async function kaptureAct(_page, params, onStep) {
  const command = params.command || params.query || '';
  if (!command) return { success: false, message: 'No CRM command provided.' };
  return dispatchCrmCommand(command, onStep);
}

module.exports = kaptureAct;
