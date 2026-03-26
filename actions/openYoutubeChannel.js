'use strict';

const { navigateTo } = require('../browser/connect');
const logger = require('../logger');

/**
 * Action: open_youtube_channel
 * Navigates directly to a YouTube channel by handle or name.
 *
 * @param {import('playwright').Page} _page
 * @param {{ channel: string }} params
 */
async function openYoutubeChannel(_page, params) {
  const { channel } = params;
  if (!channel) throw new Error('"channel" param is required for open_youtube_channel.');

  // Clean up channel name — remove @ if user included it
  const handle = channel.replace(/^@/, '').trim();

  // Try the @handle URL first (modern YouTube channels)
  const url = `https://www.youtube.com/@${handle}`;
  logger.info(`Opening YouTube channel: @${handle}`);
  await navigateTo(url);
  return { success: true, message: `Opened YouTube channel @${handle}.` };
}

module.exports = openYoutubeChannel;
