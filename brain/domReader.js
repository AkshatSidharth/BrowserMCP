'use strict';

/**
 * domReader.js
 * Extracts a structured, numbered list of all visible interactive elements
 * from the current page — inputs, buttons, links, selects.
 * This is sent to GPT-4o so it can reason about "what is on screen" and
 * decide exactly which elements to interact with.
 */

async function extractPageContext(page) {
  const url   = page.url();
  const title = await page.title();

  const elements = await page.$$eval(
    'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"]),' +
    'textarea, select, button, [role="button"], a[href]',
    (els) => {
      return els
        .map((el, i) => {
          const rect = el.getBoundingClientRect();
          if (rect.width === 0 || rect.height === 0) return null; // skip invisible

          // Best label: label[for] → aria-label → placeholder → innerText → name
          let label = '';
          if (el.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
            if (lbl) label = lbl.innerText.trim();
          }
          if (!label) label = el.getAttribute('aria-label') || '';
          if (!label) label = el.getAttribute('placeholder') || '';
          if (!label) label = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
          if (!label) label = el.getAttribute('name') || el.getAttribute('type') || '';

          return {
            index:       i,
            tag:         el.tagName.toLowerCase(),
            type:        el.getAttribute('type') || '',
            label:       label.trim(),
            name:        el.getAttribute('name') || '',
            id:          el.id || '',
            placeholder: el.getAttribute('placeholder') || '',
            // Centre of bounding box — used for CDP coordinate clicking
            cx: Math.round(rect.left + rect.width  / 2),
            cy: Math.round(rect.top  + rect.height / 2),
          };
        })
        .filter(Boolean);
    }
  );

  return { url, title, elements };
}

/**
 * Format the page context as a readable string for the LLM prompt.
 */
function formatContext(ctx) {
  const elLines = ctx.elements.map(e => {
    const attrs = [e.tag, e.type, e.name, e.id, e.placeholder].filter(Boolean).join('|');
    return `  [${e.index}] "${e.label}"  (${attrs})  @(${e.cx},${e.cy})`;
  }).join('\n');

  return `Page: ${ctx.title}\nURL: ${ctx.url}\n\nInteractive elements (index, label, attrs, screen-coords):\n${elLines || '  (none found)'}`;
}

module.exports = { extractPageContext, formatContext };
