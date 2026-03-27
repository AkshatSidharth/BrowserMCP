'use strict';

const { getActivePage } = require('../browser/connect');
const { runAgentLoop }  = require('../brain/agentLoop');
const logger = require('../logger');

// Site-specific search URL builders — used when already on that site
const SEARCH_SITES = {
  'flipkart.com':  (q) => `https://www.flipkart.com/search?q=${encodeURIComponent(q)}`,
  'amazon.in':     (q) => `https://www.amazon.in/s?k=${encodeURIComponent(q)}`,
  'amazon.com':    (q) => `https://www.amazon.com/s?k=${encodeURIComponent(q)}`,
  'youtube.com':   (q) => `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`,
  'google.com':    (q) => `https://www.google.com/search?q=${encodeURIComponent(q)}`,
  'myntra.com':    (q) => `https://www.myntra.com/${encodeURIComponent(q)}`,
};

// Get the search key for the current page URL
function currentSiteKey(url) {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return Object.keys(SEARCH_SITES).find(k => host.includes(k)) || null;
  } catch { return null; }
}

// Extract search query — strips polite prefixes, action verbs, and site suffixes
function extractSearchQuery(command) {
  return command
    .replace(/^(?:can\s+you\s+|please\s+|could\s+you\s+|bhai\s+|yaar\s+)/i, '')
    .replace(/^(?:search\s+for|look\s+for|find|search|show\s+me|get\s+me|open|play|watch|dhundh|dikhao)\s+/i, '')
    .replace(/\s+(?:on\s+(?:flipkart|amazon|youtube|google|myntra)|here|for\s+me|please)\s*$/i, '')
    .replace(/\s+(?:on\s+youtube|on\s+yt|youtube\s+pe|youtube\s+par|youtube\s+mein)\s*$/i, '')
    .replace(/\s+videos?\s*$/i, '')
    .trim();
}

async function smartAct(_page, params, onStep) {
  const { command } = params;
  if (!command) throw new Error('"command" param required.');

  const page       = await getActivePage();
  const currentUrl = page.url() || '';
  const siteKey    = currentSiteKey(currentUrl);

  // Context-aware search: if on a known site and user is searching, go directly to search URL
  const isSearchGoal = /\b(?:search|look\s+for|find|show\s+me|dhundh|dikhao|look\s+up)\b/i.test(command);
  if (isSearchGoal && siteKey) {
    const query = extractSearchQuery(command);
    if (query && query.length > 1) {
      const searchUrl = SEARCH_SITES[siteKey](query);
      if (onStep) onStep(`🔍 Searching ${siteKey} for "${query}"`);
      logger.info(`Site-aware search: ${searchUrl}`);
      await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  // YouTube goal from anywhere — navigate to YouTube search results
  const isYoutubeGoal = /youtube/i.test(command) && !siteKey?.includes('youtube');
  if (isYoutubeGoal) {
    const query = extractSearchQuery(command);
    if (query && query.length > 1) {
      if (onStep) onStep(`🔍 Searching YouTube for "${query}"`);
      await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  return runAgentLoop(page, command, onStep);
}

module.exports = smartAct;
