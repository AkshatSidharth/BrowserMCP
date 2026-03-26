'use strict';

require('dotenv').config();
const { OpenAI } = require('openai');
const { extractPageContext, formatContext } = require('./domReader');
const logger = require('../logger');

let _openai = null;
const getClient = () => {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
};

const SYSTEM_PROMPT = `
You are a browser automation agent. You are given:
1. A screenshot of the current webpage
2. A numbered list of all visible interactive elements (inputs, buttons, links)
3. The user's command (may be in English or Hinglish)

Your job: return ONLY a JSON object with the exact steps to complete the user's request.

Step types:
- {"action":"fill",  "element_index":N, "value":"...",  "description":"..."}
- {"action":"click", "element_index":N,                 "description":"..."}
- {"action":"press", "key":"Enter",                     "description":"..."}
- {"action":"wait",  "ms":1500,                         "description":"..."}
- {"action":"navigate", "url":"https://...",             "description":"..."}

Rules:
1. Use element_index from the numbered list — it is the most reliable way to target elements.
2. For fill actions, use the index of the matching input field.
3. For click actions, use the index of the matching button/link.
4. If the task needs multiple steps (fill phone → click OTP button), list ALL steps.
5. If something is not on this page, say so in "message" with empty steps.
6. Output ONLY valid JSON — no markdown, no explanation.

Output schema:
{
  "steps": [ ...steps ],
  "message": "optional explanation if steps are empty"
}
`.trim();

/**
 * Main smart agent function.
 * Reads the page DOM + screenshot, sends to GPT-4o, executes returned steps.
 *
 * @param {import('playwright').Page} page
 * @param {string} command  — user's natural language command
 * @returns {{ success: boolean, message: string, steps: any[] }}
 */
async function analyzeAndAct(page, command) {
  // 1. Read DOM
  const ctx = await extractPageContext(page);
  const domText = formatContext(ctx);
  logger.debug(`DOM context:\n${domText}`);

  // 2. Screenshot (JPEG, compressed — GPT-4o doesn't need full res)
  const screenshotBuf = await page.screenshot({ type: 'jpeg', quality: 55, fullPage: false });
  const base64 = screenshotBuf.toString('base64');

  // 3. Ask GPT-4o with vision
  logger.info(`Smart agent analyzing page for: "${command}"`);
  const response = await getClient().chat.completions.create({
    model: process.env.LLM_MODEL || 'gpt-4o',
    temperature: 0,
    max_completion_tokens: 1024,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          {
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${base64}`, detail: 'low' },
          },
          {
            type: 'text',
            text: `User command: "${command}"\n\n${domText}`,
          },
        ],
      },
    ],
  });

  const raw = response.choices[0].message.content.trim();
  logger.debug(`GPT-4o plan: ${raw}`);

  let plan;
  try {
    plan = JSON.parse(raw);
  } catch {
    return { success: false, message: 'Could not parse action plan from GPT-4o.', steps: [] };
  }

  const steps = plan.steps || [];
  if (!steps.length) {
    return { success: false, message: plan.message || 'No steps returned.', steps: [] };
  }

  // 4. Execute each step
  const allHandles = await page.$$(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]),' +
    'textarea, select, button, [role="button"], a[href]'
  );

  const results = [];
  for (const step of steps) {
    try {
      logger.info(`Step: ${JSON.stringify(step)}`);
      await executeStep(page, allHandles, step);
      results.push(`✓ ${step.description || step.action}`);
    } catch (err) {
      logger.warn(`Step failed: ${err.message}`);
      results.push(`⚠ ${step.description || step.action} (failed: ${err.message})`);
    }
  }

  return { success: true, message: results.join(' → '), steps };
}

async function executeStep(page, handles, step) {
  const { action, element_index, value, key, ms, url } = step;

  switch (action) {

    case 'fill': {
      const el = handles[element_index];
      if (!el) throw new Error(`No element at index ${element_index}`);
      await el.scrollIntoViewIfNeeded();
      await el.click({ clickCount: 3 }); // select all
      await page.waitForTimeout(100);
      await page.keyboard.type(String(value), { delay: 40 });
      break;
    }

    case 'click': {
      const el = handles[element_index];
      if (!el) throw new Error(`No element at index ${element_index}`);
      await el.scrollIntoViewIfNeeded();
      await el.click();
      await page.waitForTimeout(300);
      break;
    }

    case 'press': {
      await page.keyboard.press(key || 'Enter');
      break;
    }

    case 'wait': {
      await page.waitForTimeout(ms || 1000);
      break;
    }

    case 'navigate': {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      break;
    }

    default:
      logger.warn(`Unknown step action: ${action}`);
  }
}

module.exports = { analyzeAndAct };
