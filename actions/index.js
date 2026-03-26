'use strict';

/**
 * Action Registry
 * Maps action names (as returned by the intent parser) to their handler functions.
 * To add a new action:
 *   1. Create actions/myAction.js exporting async (page, params) => result
 *   2. Add an entry here
 *   3. Add the action to safety/guard.js ALLOWED_ACTIONS
 */

const registry = {
  open_youtube:         require('./openYoutube'),
  open_youtube_channel: require('./openYoutubeChannel'),
  play_youtube_video:   require('./playYoutubeVideo'),
  search_google:   require('./searchGoogle'),
  navigate_to:     require('./navigateTo'),
  open_crm:        require('./openCrm'),
  create_lead:     require('./createLead'),
  search_lead:     require('./searchLead'),
  get_tickets:     require('./getTickets'),
  assign_ticket:   require('./assignTicket'),
  resolve_ticket:  require('./resolveTicket'),
  go_back:         require('./goBack'),
  reload_page:     require('./reloadPage'),
  take_screenshot: require('./takeScreenshot'),
  click_captcha:   require('./clickCaptcha'),
};

/**
 * Execute an action by name.
 *
 * @param {string} actionName
 * @param {import('playwright').Page} page
 * @param {Record<string, string>} params
 * @returns {Promise<{ success: boolean, message: string }>}
 */
async function executeAction(actionName, page, params) {
  const handler = registry[actionName];
  if (!handler) {
    throw new Error(`No handler registered for action "${actionName}".`);
  }
  return handler(page, params);
}

module.exports = { registry, executeAction };
