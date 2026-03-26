'use strict';

require('dotenv').config();
const { navigateTo } = require('../browser/connect');
const logger = require('../logger');

const CRM_URL = process.env.CRM_BASE_URL || 'https://app.kapturecrm.com';

/**
 * Action: open_crm
 * Opens the CRM dashboard in the browser.
 */
async function openCrm(_page, _params) {
  logger.info(`Opening CRM at ${CRM_URL} ...`);
  await navigateTo(CRM_URL);
  return { success: true, message: `Opened CRM dashboard.` };
}

module.exports = openCrm;
