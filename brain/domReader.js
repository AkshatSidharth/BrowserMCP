'use strict';

/**
 * domReader.js
 * Extracts a structured, numbered list of all visible interactive elements
 * from the current page — inputs, buttons, links, selects, checkboxes.
 * Includes bounding-box centres for coordinate-based clicking.
 * This is sent to GPT-4o so it can reason about "what is on screen".
 */

// Selector covers everything interactive including filter checkboxes / radio buttons
const INTERACTIVE_SELECTOR =
  'input:not([type="hidden"]),' +
  'textarea, select, button, [role="button"], [role="checkbox"], [role="radio"],' +
  '[role="menuitem"], [role="option"], [role="tab"], [role="switch"],' +
  'a[href], label[for], [onclick]';

async function extractPageContext(page) {
  const url   = page.url();
  const title = await page.title();

  const elements = await page.$$eval(INTERACTIVE_SELECTOR, (els) => {
    return els
      .map((el, i) => {
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) return null; // skip invisible

        // Best label: label[for] → aria-label → aria-labelledby → placeholder → innerText → name
        let label = '';
        if (el.id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lbl) label = lbl.innerText.trim();
        }
        if (!label) label = el.getAttribute('aria-label') || '';
        if (!label && el.getAttribute('aria-labelledby')) {
          const lblEl = document.getElementById(el.getAttribute('aria-labelledby'));
          if (lblEl) label = lblEl.innerText.trim();
        }
        if (!label) label = el.getAttribute('placeholder') || '';
        if (!label) label = (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);
        if (!label) label = el.getAttribute('name') || el.getAttribute('type') || el.tagName.toLowerCase();

        // ARIA role (more semantic than tag name)
        const role = el.getAttribute('role') || el.tagName.toLowerCase();

        // Checked state for checkboxes / radios
        const checked = el.type === 'checkbox' || el.type === 'radio' || role === 'checkbox'
          ? (el.checked || el.getAttribute('aria-checked') === 'true' ? '✓' : '○')
          : '';

        // Current value for inputs/selects
        const value = el.tagName === 'SELECT'
          ? el.options[el.selectedIndex]?.text || ''
          : (el.type === 'checkbox' || el.type === 'radio' ? '' : el.value || '');

        return {
          index:   i,
          tag:     el.tagName.toLowerCase(),
          role,
          type:    el.getAttribute('type') || '',
          label:   label.trim(),
          checked,
          value:   value.trim().slice(0, 40),
          name:    el.getAttribute('name') || '',
          id:      el.id || '',
          // Centre of bounding box — for coordinate clicking (Playwright mouse.click)
          cx: Math.round(rect.left + rect.width  / 2),
          cy: Math.round(rect.top  + rect.height / 2),
        };
      })
      .filter(Boolean);
  });

  // Enrich labels using the accessibility tree (Chrome DevTools MCP: takeSnapshot)
  // page.accessibility.snapshot() surfaces names that aren't visible in the DOM
  // (e.g. Flipkart filter checkboxes whose text is a sibling span, not inside the element)
  try {
    const a11y = await page.accessibility.snapshot({ interestingOnly: true });
    if (a11y) {
      const nodeMap = new Map(); // label → {role, name}
      function walk(node) {
        if (node.name) nodeMap.set((node.name || '').toLowerCase().trim(), node);
        for (const child of node.children || []) walk(child);
      }
      walk(a11y);

      // For any element with a weak/empty label, try to find a match in the a11y tree
      for (const el of elements) {
        if (!el.label || el.label.length < 2) {
          const match = nodeMap.get(String(el.id).toLowerCase()) ||
                        nodeMap.get(String(el.name).toLowerCase());
          if (match && match.name) el.label = match.name.slice(0, 80);
        }
      }
    }
  } catch { /* accessibility API not available — continue without enrichment */ }

  return { url, title, elements };
}

/**
 * Format the page context as a readable string for the LLM prompt.
 */
function formatContext(ctx) {
  const elLines = ctx.elements.map(e => {
    const meta = [e.role !== e.tag ? e.role : '', e.type, e.name, e.id].filter(Boolean).join('|');
    const state = [e.checked, e.value].filter(Boolean).join(' ');
    return `  [${e.index}] ${e.checked || '·'} "${e.label}"  (${meta || e.tag})${state ? '  val:' + e.value : ''}  @(${e.cx},${e.cy})`;
  }).join('\n');

  return `Page: ${ctx.title}\nURL: ${ctx.url}\n\nInteractive elements (index · checked role label @coords):\n${elLines || '  (none found)'}`;
}

module.exports = { extractPageContext, formatContext };
