'use strict';

const logger = require('../logger');

/**
 * Action: media_act
 * Direct video/audio control via JS — bypasses the agent loop entirely.
 *
 * KEY BEHAVIOUR: if the current page has no video, automatically scans
 * all open tabs and switches to the first one that has a video element.
 * This fixes "pause" failing when the user is on Google but YouTube is
 * open in another tab.
 */
async function mediaAct(page, { operation }) {
  if (!operation) throw new Error('"operation" param required for media_act.');

  const op = operation.toLowerCase().trim();
  logger.info(`media_act: ${op}`);

  // ── Find the right tab ────────────────────────────────────────────────────
  // Check if current page has a video. If not, scan all tabs.
  let targetPage = page;

  const hasVideoOnPage = async (pg) => {
    try {
      return await pg.evaluate(() => document.querySelectorAll('video').length > 0);
    } catch { return false; }
  };

  if (!(await hasVideoOnPage(page))) {
    logger.info('media_act: no video on current page — scanning other tabs');
    try {
      const allPages = page.context().pages();
      for (const pg of allPages) {
        if (pg === page || pg.isClosed()) continue;
        if (await hasVideoOnPage(pg)) {
          targetPage = pg;
          logger.info(`media_act: found video on tab: ${pg.url()}`);
          // Switch active page to this tab
          const { setActivePage } = require('../browser/connect');
          setActivePage(pg);
          await pg.bringToFront().catch(() => {});
          if (process.platform === 'darwin') {
            const { exec } = require('child_process');
            exec(`osascript -e 'tell application "Google Chrome" to activate'`).unref?.();
          }
          break;
        }
      }
    } catch (err) {
      logger.warn(`media_act tab scan failed: ${err.message}`);
    }
  }

  // ── Execute on the target page ────────────────────────────────────────────
  const result = await targetPage.evaluate((op) => {
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) return { found: false };

    // Prefer playing video, then largest visible area
    const v = videos.sort((a, b) => {
      if (!a.paused && b.paused) return -1;
      if (a.paused && !b.paused) return 1;
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    })[0];

    switch (op) {
      case 'pause':         v.pause(); break;
      case 'play':          v.play();  break;
      case 'toggle':
      case 'play_pause':    v.paused ? v.play() : v.pause(); break;
      case 'mute':          v.muted = true; break;
      case 'unmute':        v.muted = false; break;
      case 'toggle_mute':   v.muted = !v.muted; break;
      case 'volume_up':     v.volume = Math.min(1, v.volume + 0.2); break;
      case 'volume_down':   v.volume = Math.max(0, v.volume - 0.2); break;
      case 'seek_forward':
      case 'seek_fwd':      v.currentTime = Math.min(v.duration || Infinity, v.currentTime + 10); break;
      case 'seek_back':
      case 'seek_backward': v.currentTime = Math.max(0, v.currentTime - 10); break;
      case 'restart':       v.currentTime = 0; v.play(); break;
      case 'fullscreen':
        if (v.requestFullscreen) v.requestFullscreen().catch(() => {});
        break;
      case 'exit_fullscreen':
        if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
        break;
      default:
        return { found: true, error: `Unknown operation: ${op}` };
    }

    const after = { paused: v.paused, muted: v.muted, volume: Math.round(v.volume * 100), time: Math.round(v.currentTime) };
    return { found: true, after, url: location.href };
  }, op);

  if (!result.found) {
    return { success: false, message: 'No video found on any open tab.' };
  }
  if (result.error) {
    return { success: false, message: result.error };
  }

  const stateDesc = result.after
    ? `video is now ${result.after.paused ? 'paused' : 'playing'}, volume ${result.after.volume}%, muted: ${result.after.muted}`
    : op;

  return { success: true, message: `${op} done — ${stateDesc}` };
}

module.exports = mediaAct;
