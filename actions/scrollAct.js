'use strict';

const logger = require('../logger');

/**
 * Action: scroll_act
 * Direct scroll control via JS — bypasses the agent loop entirely.
 * Operations: up, down, top, bottom, left, right
 * Optional: amount (pixels, default 400)
 */
async function scrollAct(page, { direction, amount }) {
  if (!direction) throw new Error('"direction" param required for scroll_act.');

  const dir = direction.toLowerCase().trim();
  const px  = parseInt(amount, 10) || 400;
  logger.info(`scroll_act: ${dir} ${px}px`);

  await page.evaluate(({ dir, px }) => {
    switch (dir) {
      case 'down':   window.scrollBy({ top:  px, behavior: 'smooth' }); break;
      case 'up':     window.scrollBy({ top: -px, behavior: 'smooth' }); break;
      case 'right':  window.scrollBy({ left:  px, behavior: 'smooth' }); break;
      case 'left':   window.scrollBy({ left: -px, behavior: 'smooth' }); break;
      case 'top':    window.scrollTo({ top: 0,    behavior: 'smooth' }); break;
      case 'bottom': window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); break;
    }
  }, { dir, px });

  return { success: true, message: `Scrolled ${dir}` };
}

module.exports = scrollAct;
