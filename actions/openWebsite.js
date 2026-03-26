'use strict';

const { navigateTo, findOpenTab, switchToTab } = require('../browser/connect');
const logger = require('../logger');

// Common site name → URL mapping so users can say "open Instagram" naturally
const SITE_MAP = {
  instagram:  'https://www.instagram.com',
  facebook:   'https://www.facebook.com',
  twitter:    'https://www.twitter.com',
  x:          'https://www.x.com',
  reddit:     'https://www.reddit.com',
  youtube:    'https://www.youtube.com',
  google:     'https://www.google.com',
  gmail:      'https://mail.google.com',
  linkedin:   'https://www.linkedin.com',
  whatsapp:   'https://web.whatsapp.com',
  amazon:     'https://www.amazon.com',
  netflix:    'https://www.netflix.com',
  github:     'https://www.github.com',
  notion:     'https://www.notion.so',
  slack:      'https://app.slack.com',
  kapture:    'https://app.kapturecrm.com',
  crm:        'https://app.kapturecrm.com',
  'kapture cx': 'https://app.kapturecrm.com',
  'kapture crm':'https://app.kapturecrm.com',
  'capture cx': 'https://app.kapturecrm.com',
  'capture crm':'https://app.kapturecrm.com',
  kapturecrm:  'https://app.kapturecrm.com',
};

/**
 * Action: open_website
 * Opens a website by name (e.g. "Instagram") or full URL.
 * Handles natural site names without needing the full URL.
 */
async function openWebsite(_page, params) {
  const { site } = params;
  if (!site) throw new Error('"site" param required.');

  const key = site.toLowerCase().trim().replace(/\.(com|org|net|io)$/, '');
  const url  = SITE_MAP[key] || SITE_MAP[key.replace(/\s+/g, '')] || (site.includes('.') ? `https://${site}` : `https://www.${site}.com`);

  // Extract hostname to check if this site is already open in a tab
  let hostname = '';
  try { hostname = new URL(url).hostname.replace(/^www\./, ''); } catch {}

  if (hostname) {
    const existing = await findOpenTab(hostname);
    if (existing) {
      await switchToTab(existing);
      logger.info(`Switched to existing tab: ${existing.url()}`);
      return { success: true, message: `Switched to existing ${site} tab.` };
    }
  }

  logger.info(`Opening ${site} → ${url}`);
  await navigateTo(url);
  return { success: true, message: `Opened ${site}.` };
}

module.exports = openWebsite;
