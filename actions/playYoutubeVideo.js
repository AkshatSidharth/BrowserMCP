'use strict';

const { navigateTo } = require('../browser/connect');
const logger = require('../logger');

/**
 * Action: play_youtube_video
 * Searches YouTube and plays the first matching video.
 * Uses Playwright Locators — never stale unlike page.$() handles.
 */
async function playYoutubeVideo(_page, params) {
  const { query } = params;
  if (!query) throw new Error('"query" param is required for play_youtube_video.');

  const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  logger.info(`Searching YouTube for: "${query}"`);
  const page = await navigateTo(searchUrl);

  // Wait for at least one video card to render
  await page.waitForSelector('ytd-video-renderer', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(400); // let React finish rendering titles

  // Playwright Locators — re-queried at interaction time, never stale
  const candidates = [
    page.locator('ytd-video-renderer a#video-title').first(),
    page.locator('ytd-video-renderer #video-title').first(),
    page.locator('ytd-rich-item-renderer a#video-title').first(),
    page.locator('a#video-title').first(),
  ];

  for (const loc of candidates) {
    try {
      await loc.waitFor({ state: 'visible', timeout: 3000 });
      const title = (await loc.getAttribute('title').catch(() => null))
        || (await loc.textContent().catch(() => null))
        || query;
      await loc.click({ timeout: 5000 });
      logger.info(`Playing video: "${title.trim()}"`);
      return { success: true, message: `Playing: "${title.trim()}"` };
    } catch { /* try next locator */ }
  }

  return { success: false, message: 'Could not find a video to click. Try rephrasing the song name.' };
}

module.exports = playYoutubeVideo;
