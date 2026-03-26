'use strict';

require('dotenv').config();
const { navigateTo } = require('../browser/connect');
const logger = require('../logger');

const CRM_URL = process.env.CRM_BASE_URL || 'https://app.kapturecrm.com';

/**
 * Action: get_tickets
 * Opens the CRM ticket / support queue view.
 */
async function getTickets(_page, _params) {
  const url = `${CRM_URL}/tickets`;
  logger.info(`Opening CRM tickets view at ${url}`);
  await navigateTo(url);
  return { success: true, message: 'Opened CRM tickets queue.' };
}

module.exports = getTickets;
