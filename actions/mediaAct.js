'use strict';

const logger = require('../logger');

/**
 * Action: media_act
 * Direct video/audio control via JS — bypasses the agent loop entirely.
 * Operations: pause, play, toggle, mute, unmute, volume_up, volume_down,
 *             seek_forward, seek_back, fullscreen, exit_fullscreen, restart
 *
 * This action NEVER takes a screenshot, NEVER calls GPT — it's a one-shot JS call.
 */
async function mediaAct(page, { operation }) {
  if (!operation) throw new Error('"operation" param required for media_act.');

  const op = operation.toLowerCase().trim();
  logger.info(`media_act: ${op}`);

  const result = await page.evaluate((op) => {
    // Find the most prominent video on the page
    const videos = Array.from(document.querySelectorAll('video'));
    if (!videos.length) return { found: false };

    // Prefer the video that is actually playing or has the most area
    const v = videos.sort((a, b) => {
      // Prioritise playing video
      if (!a.paused && b.paused) return -1;
      if (a.paused && !b.paused) return 1;
      // Then by visible area
      const ra = a.getBoundingClientRect();
      const rb = b.getBoundingClientRect();
      return (rb.width * rb.height) - (ra.width * ra.height);
    })[0];

    const before = { paused: v.paused, muted: v.muted, volume: v.volume, time: v.currentTime };

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
    return { found: true, before, after };
  }, op);

  if (!result.found) {
    return { success: false, message: 'No video found on the page.' };
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
