'use strict';

const { navigateTo } = require('../browser/connect');
const logger = require('../logger');

/**
 * Action: open_youtube_channel
 * Opens a YouTube channel and clicks the first video to play it.
 */
async function openYoutubeChannel(_page, params) {
  const { channel } = params;
  if (!channel) throw new Error('"channel" param is required for open_youtube_channel.');

  const handle = channel.replace(/^@/, '').trim();
  const url = `https://www.youtube.com/@${handle}/videos`;
  logger.info(`Opening YouTube channel videos: @${handle}`);
  const page = await navigateTo(url);

  // Wait for video grid to load
  await page.waitForSelector('ytd-rich-item-renderer, ytd-grid-video-renderer', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1000);

  // Click the first video on the channel
  const videoSelectors = [
    'ytd-rich-item-renderer #video-title-link',
    'ytd-grid-video-renderer #video-title',
    'ytd-rich-item-renderer a#thumbnail',
  ];

  for (const sel of videoSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const title = await el.getAttribute('title') || await el.innerText().catch(() => '');
        logger.info(`Clicking video: "${title}"`);
        await el.click();
        return { success: true, message: `Playing "${title}" from @${handle}.` };
      }
    } catch { /* try next */ }
  }

  return { success: true, message: `Opened @${handle} channel. Could not auto-click a video — click one manually.` };
}

module.exports = openYoutubeChannel;
