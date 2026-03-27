'use strict';

/**
 * domReader.js — Chrome DevTools MCP-inspired element extraction
 *
 * PRIMARY source: page.accessibility.snapshot()  (Chrome DevTools MCP: takeSnapshot)
 *   → semantic role, computed accessible name, checked/selected state, current value
 *   → never relies on raw DOM order or fragile CSS selectors
 *
 * SECONDARY: getBoundingClientRect per element
 *   → centre (cx, cy) for coordinate clicking fallback
 *
 * Each element carries enough info for the LLM to:
 *   a) reference it by index (→ Playwright locator via role+name — always fresh)
 *   b) fall back to click_xy using screen coordinates
 */

// ─── A11y tree walker ─────────────────────────────────────────────────────────
// Roles that represent interactive / meaningful elements
const INTERACTIVE_ROLES = new Set([
  'button','link','menuitem','menuitemcheckbox','menuitemradio',
  'option','tab','treeitem','row',
  'textbox','searchbox','combobox','listbox','spinbutton',
  'checkbox','radio','switch','slider','scrollbar',
  'cell','columnheader','rowheader',
  'figure','img',  // sometimes clickable
]);

// Roles that are purely structural — skip unless they have a name
const SKIP_UNNAMED = new Set([
  'generic','group','list','listitem','presentation','none',
  'region','main','navigation','complementary','banner','contentinfo',
  'article','section','separator','LineBreak',
]);

function walkA11yTree(node, results, depth = 0) {
  if (!node) return;
  const role  = (node.role  || '').toLowerCase();
  const name  = (node.name  || '').trim();
  const value = (node.value || '').toString().trim();

  const isInteractive = INTERACTIVE_ROLES.has(role);
  const hasName       = name.length > 0;

  if (isInteractive || (hasName && !SKIP_UNNAMED.has(role))) {
    // Checked/selected state (Chrome DevTools MCP: a11y checked property)
    let state = '';
    if (node.checked === true)  state = '✓';
    if (node.checked === false) state = '○';
    if (node.selected === true) state = '●';
    if (node.pressed  === true) state = '▼';
    if (node.disabled === true) state += '🚫';

    results.push({
      index:   results.length,
      role,
      name:    name.slice(0, 100),
      state,
      value:   value.slice(0, 60),
      // Playwright locator expression — always fresh, never stale
      locator: buildLocator(role, name),
    });
  }

  for (const child of node.children || []) {
    walkA11yTree(child, results, depth + 1);
  }
}

function buildLocator(role, name) {
  // Map a11y roles → Playwright getByRole roles
  const roleMap = {
    textbox: 'textbox', searchbox: 'searchbox', combobox: 'combobox',
    button: 'button', link: 'link', checkbox: 'checkbox', radio: 'radio',
    menuitem: 'menuitem', option: 'option', tab: 'tab', switch: 'switch',
    spinbutton: 'spinbutton', slider: 'slider', listbox: 'listbox',
    menuitemcheckbox: 'menuitemcheckbox', menuitemradio: 'menuitemradio',
  };
  const pwRole = roleMap[role] || role;
  return { pwRole, name };
}

// ─── Bounding box enrichment ─────────────────────────────────────────────────
// For coordinate fallback: find the centre of each element by its accessible name
async function enrichWithCoords(page, elements) {
  if (!elements.length) return elements;

  // Batch: for each element, try to find its bounding rect in the DOM
  const coords = await page.evaluate((items) => {
    return items.map(({ role, name }) => {
      // Try ARIA role + accessible-name heuristics
      const selectors = [
        `[role="${role}"][aria-label="${name}"]`,
        `[role="${role}"][title="${name}"]`,
        `button:has-text("${name.slice(0,30)}")`,
        `a:has-text("${name.slice(0,30)}")`,
        `label:has-text("${name.slice(0,30)}")`,
        `[aria-label="${name}"]`,
        `[placeholder="${name}"]`,
        `[title="${name}"]`,
      ];
      for (const sel of selectors) {
        try {
          const el = document.querySelector(sel);
          if (el) {
            const r = el.getBoundingClientRect();
            if (r.width > 0 && r.height > 0) {
              return { cx: Math.round(r.left + r.width / 2), cy: Math.round(r.top + r.height / 2) };
            }
          }
        } catch { /* invalid selector, skip */ }
      }
      return { cx: null, cy: null };
    });
  }, elements.map(e => ({ role: e.role, name: e.name }))).catch(() => elements.map(() => ({ cx: null, cy: null })));

  return elements.map((el, i) => ({ ...el, cx: coords[i]?.cx, cy: coords[i]?.cy }));
}

// ─── Main extractor ───────────────────────────────────────────────────────────
async function extractPageContext(page) {
  const url   = page.url();
  const title = await page.title().catch(() => '');

  // 1. A11y tree — primary source (Chrome DevTools MCP: takeSnapshot)
  let elements = [];
  try {
    const a11y = await page.accessibility.snapshot({ interestingOnly: true });
    if (a11y) walkA11yTree(a11y, elements);
  } catch { /* accessibility API unavailable */ }

  // 2. DOM fallback — pick up elements not surfaced in a11y tree
  //    (e.g. custom React components, canvas overlays, hidden-label inputs)
  try {
    const domElements = await page.$$eval(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]),' +
      'select:not([disabled]), button:not([disabled]), [role="button"],' +
      '[role="checkbox"], [role="switch"], [role="tab"], [role="option"],' +
      'a[href]',
      (els) => els.map(el => {
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return null;
        // Compute accessible name
        let name = el.getAttribute('aria-label') || el.getAttribute('placeholder')
          || el.getAttribute('title') || el.getAttribute('alt')
          || (el.innerText || el.textContent || '').trim().slice(0, 100);
        if (!name && el.id) {
          const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (lbl) name = lbl.innerText.trim();
        }
        if (!name) name = el.getAttribute('name') || el.getAttribute('type') || el.tagName.toLowerCase();
        const role = el.getAttribute('role') || {
          INPUT: el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox',
          TEXTAREA: 'textbox', SELECT: 'combobox', BUTTON: 'button', A: 'link',
        }[el.tagName] || 'generic';
        const checked = (el.type === 'checkbox' || el.type === 'radio' || role === 'checkbox')
          ? (el.checked || el.getAttribute('aria-checked') === 'true' ? '✓' : '○') : '';
        const value = el.tagName === 'SELECT'
          ? (el.options[el.selectedIndex]?.text || '') : (el.value || '');
        return {
          role, name: name.trim(), state: checked,
          value: value.trim().slice(0, 60),
          cx: Math.round(rect.left + rect.width / 2),
          cy: Math.round(rect.top + rect.height / 2),
          _fromDom: true,
        };
      }).filter(Boolean)
    );

    // Merge: add DOM elements not already covered by a11y tree (by name match)
    const a11yNames = new Set(elements.map(e => e.name.toLowerCase()));
    for (const domEl of domElements) {
      const n = domEl.name.toLowerCase();
      if (!a11yNames.has(n) && n.length > 0) {
        elements.push({ ...domEl, index: elements.length, locator: buildLocator(domEl.role, domEl.name) });
        a11yNames.add(n);
      }
    }
  } catch { /* DOM eval failed */ }

  // 3. Enrich a11y elements with coordinates
  elements = await enrichWithCoords(page, elements);

  // Re-index
  elements = elements.map((e, i) => ({ ...e, index: i }));

  return { url, title, elements };
}

// ─── Formatter ────────────────────────────────────────────────────────────────
function formatContext(ctx) {
  const lines = ctx.elements.map(e => {
    const coord = (e.cx != null && e.cy != null) ? `  @(${e.cx},${e.cy})` : '';
    const val   = e.value ? `  val:"${e.value}"` : '';
    return `  [${e.index}] ${e.state || '·'} ${e.role}  "${e.name}"${val}${coord}`;
  }).join('\n');

  return `Page: ${ctx.title}\nURL: ${ctx.url}\n\n` +
    `Interactive elements  [idx] state role "name" val @coords:\n` +
    (lines || '  (none found)');
}

module.exports = { extractPageContext, formatContext };
