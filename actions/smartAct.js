'use strict';

const { getActivePage } = require('../browser/connect');
const { runAgentLoop }  = require('../brain/agentLoop');
const logger = require('../logger');

/**
 * Action: smart_act
 * Runs the full agentic loop — reads page, acts, re-reads, acts again —
 * until the goal is complete or it can't proceed.
 */
// YouTube search query extractor — strips fluff, extracts what to search
function extractYoutubeQuery(command) {
  let q = command
    // Remove polite prefixes
    .replace(/^(?:can\s+you\s+|please\s+|could\s+you\s+|would\s+you\s+|hey\s+|bro\s+)/i, '')
    // Remove action verbs at the start
    .replace(/^(?:open|search\s+for|look\s+for|find|play|watch|show\s+me|search|look\s+up|get\s+me)\s+/i, '')
    // Remove "on youtube / youtube pe / youtube par" suffix
    .replace(/\s+(?:on\s+youtube|on\s+yt|youtube\s+pe|youtube\s+par|youtube\s+mein|in\s+youtube)\s*$/i, '')
    // Remove trailing "video(s)" only when it's not part of the actual query
    .replace(/\s+videos?\s*$/i, '')
    .trim();

  return q.length > 1 ? q : null;
}

async function smartAct(_page, params, onStep) {
  const { command } = params;
  if (!command) throw new Error('"command" param required.');

  const page = await getActivePage();

  // For YouTube search, skip the search-bar interaction and navigate directly
  // to search results URL — avoids the font-loading screenshot hang.
  const currentUrl = page.url() || '';
  const isYoutubeGoal = /youtube/i.test(command);
  if (isYoutubeGoal) {
    const query = extractYoutubeQuery(command);
    if (query) {
      if (onStep) onStep(`🔍 Searching YouTube for "${query}"`);
      await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`, {
        waitUntil: 'domcontentloaded', timeout: 20000,
      }).catch(() => {});
      await page.waitForTimeout(1500);
    } else if (!currentUrl.includes('youtube.com')) {
      await page.goto('https://www.youtube.com', { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(1500);
    }
  }

  await page.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
  return runAgentLoop(page, command, onStep);
}

module.exports = smartAct;
