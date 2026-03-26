'use strict';

const { getActivePage } = require('../browser/connect');
const logger = require('../logger');

/**
 * Action: click_captcha
 * Finds a reCAPTCHA "I'm not a robot" checkbox on the page and clicks it.
 * Works on the simple checkbox v2. Image challenges still require manual input.
 */
async function clickCaptcha(_page, _params) {
  const page = await getActivePage();

  // reCAPTCHA renders inside a sandboxed iframe — we must find that frame
  const frames = page.frames();
  const captchaFrame = frames.find(f =>
    f.url().includes('recaptcha') && f.url().includes('anchor')
  );

  if (!captchaFrame) {
    // Try clicking a visible checkbox directly on the page as fallback
    const directCheckbox = await page.$('input[type="checkbox"]');
    if (directCheckbox) {
      await directCheckbox.click();
      return { success: true, message: 'Clicked checkbox on page.' };
    }
    return { success: false, message: 'No reCAPTCHA found on this page.' };
  }

  logger.info('Found reCAPTCHA iframe — clicking checkbox ...');
  await captchaFrame.click('#recaptcha-anchor');
  await page.waitForTimeout(1500);

  // Check if it passed (checkbox becomes checked)
  const checked = await captchaFrame.$('#recaptcha-anchor[aria-checked="true"]');
  if (checked) {
    return { success: true, message: 'reCAPTCHA checkbox clicked and passed.' };
  }

  return {
    success: true,
    message: 'reCAPTCHA checkbox clicked. If an image challenge appeared, solve it manually.',
  };
}

module.exports = clickCaptcha;
