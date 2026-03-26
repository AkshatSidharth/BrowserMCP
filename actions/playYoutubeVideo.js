'use strict';

const { navigateTo, getActivePage } = require('../browser/connect');
const logger = require('../logger');

/**
 * Action: play_youtube_video
 * Searches YouTube for a query and clicks the first video result to play it.
 *
 * @param {import('playwright').Page} _page
 * @param {{ query: string }} params
 */
async function playYoutubeVideo(_page, params) {
  const { query } = params;
  if (!query) throw new Error('"query" param is required for play_youtube_video.');

  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  logger.info(`Searching YouTube for: "${query}"`);
  const page = await navigateTo(searchUrl);

  // Wait for video results to load
  await page.waitForSelector('ytd-video-renderer', { timeout: 10000 }).catch(() => {});

  // Click the first video title link
  const selectors = [
    'ytd-video-renderer #video-title',         // standard search result
    'ytd-video-renderer a#thumbnail',           // thumbnail fallback
    'a#video-title',                            // older layout
  ];

  for (const sel of selectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const title = await el.getAttribute('title') || await el.innerText().catch(() => '');
        await el.click();
        logger.info(`Playing video: "${title}"`);
        return { success: true, message: `Playing: "${title}"` };
      }
    } catch { /* try next */ }
  }

  return { success: false, message: 'Could not find a video to click. Try again or navigate manually.' };
}

module.exports = playYoutubeVideo;
