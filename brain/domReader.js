'use strict';

/**
 * domReader.js — Playwright ARIA snapshot + DOM enrichment
 *
 * Primary source: page.ariaSnapshot() (Playwright ≥ 1.46)
 *   → returns a YAML-like accessibility tree with roles, names, states, values
 *   → more stable than the deprecated page.accessibility.snapshot()
 *
 * Fallback: page.accessibility.snapshot() (older Playwright) then DOM scan
 *
 * Coordinate lookup: locator.boundingBox() per element
 *   → reliable even with CSS transforms, sticky headers, overflow scroll
 *   → used for click_xy fallback when locator-based click fails
 *
 * React Select / custom dropdown tagging:
 *   → detects [class*="select__control"] and similar patterns
 *   → marks them as react-select so agent uses click+type, not native select
 *
 * Viewport filtering:
 *   → elements outside the visible viewport are excluded
 */

// ─── ARIA snapshot parser ────────────────────────────────────────────────────
// page.ariaSnapshot() returns a YAML-like string. Parse it into element objects.

const INTERACTIVE_ROLES = new Set([
  'button','link','menuitem','menuitemcheckbox','menuitemradio',
  'option','tab','treeitem','row',
  'textbox','searchbox','combobox','listbox','spinbutton',
  'checkbox','radio','switch','slider','scrollbar',
  'cell','columnheader','rowheader',
]);

const SKIP_UNNAMED = new Set([
  'generic','group','list','listitem','presentation','none',
  'region','main','navigation','complementary','banner','contentinfo',
  'article','section','separator','linebreak','document',
]);

/**
 * Parse the YAML-like ariaSnapshot string into flat element list.
 * Format: "- role \"name\" [state] [level=N] [value=\"v\"]"
 */
function parseAriaSnapshot(yaml) {
  const elements = [];
  if (!yaml) return elements;

  for (const rawLine of yaml.split('\n')) {
    const line = rawLine.trim();
    if (!line || line === '-') continue;

    // Strip leading "- "
    const content = line.replace(/^-\s*/, '');

    // Extract role (first word)
    const roleMatch = content.match(/^(\w[\w-]*)/);
    if (!roleMatch) continue;
    const role = roleMatch[1].toLowerCase();

    // Extract name (quoted string after role)
    const nameMatch = content.match(/^[\w-]+\s+"([^"]*?)"/);
    const name = nameMatch ? nameMatch[1].trim() : '';

    // Extract value  [value="..."] or val="..."
    const valueMatch = content.match(/\[value="([^"]*?)"\]/);
    const value = valueMatch ? valueMatch[1].trim().slice(0, 60) : '';

    // Extract state
    let state = '';
    if (/\[checked\]/.test(content))   state = '✓';
    if (/\[unchecked\]/.test(content)) state = '○';
    if (/\[selected\]/.test(content))  state = '●';
    if (/\[pressed\]/.test(content))   state = '▼';
    if (/\[disabled\]/.test(content))  state += '🚫';
    if (/\[expanded\]/.test(content))  state += '▾';

    const isInteractive = INTERACTIVE_ROLES.has(role);
    const hasName = name.length > 0;

    if (isInteractive || (hasName && !SKIP_UNNAMED.has(role))) {
      elements.push({ role, name: name.slice(0, 100), state, value,
        locator: buildLocator(role, name) });
    }
  }
  return elements;
}

// ─── Accessibility tree walker (fallback) ────────────────────────────────────
function walkA11yTree(node, results) {
  if (!node) return;
  const role  = (node.role  || '').toLowerCase();
  const name  = (node.name  || '').trim();
  const value = (node.value || '').toString().trim();

  const isInteractive = INTERACTIVE_ROLES.has(role);
  const hasName       = name.length > 0;

  if (isInteractive || (hasName && !SKIP_UNNAMED.has(role))) {
    let state = '';
    if (node.checked === true)  state = '✓';
    if (node.checked === false) state = '○';
    if (node.selected === true) state = '●';
    if (node.pressed  === true) state = '▼';
    if (node.disabled === true) state += '🚫';

    results.push({
      role,
      name:    name.slice(0, 100),
      state,
      value:   value.slice(0, 60),
      locator: buildLocator(role, name),
    });
  }
  for (const child of node.children || []) walkA11yTree(child, results);
}

function buildLocator(role, name) {
  const roleMap = {
    textbox: 'textbox', searchbox: 'searchbox', combobox: 'combobox',
    button: 'button', link: 'link', checkbox: 'checkbox', radio: 'radio',
    menuitem: 'menuitem', option: 'option', tab: 'tab', switch: 'switch',
    spinbutton: 'spinbutton', slider: 'slider', listbox: 'listbox',
    menuitemcheckbox: 'menuitemcheckbox', menuitemradio: 'menuitemradio',
  };
  return { pwRole: roleMap[role] || role, name };
}

// ─── Coordinate lookup via locator.boundingBox() ────────────────────────────
// More reliable than getBoundingClientRect inside page.evaluate because
// Playwright resolves transforms, iframes, and scrolled positions correctly.
async function enrichWithCoords(page, elements) {
  const vp = page.viewportSize() || { width: 1280, height: 800 };

  for (const el of elements) {
    try {
      const { pwRole, name } = el.locator;
      // For iframe elements, search within the frame; for main page use page
      const root = el._frame || page;
      const strategies = [
        () => root.getByRole(pwRole, { name, exact: true }).first(),
        () => root.getByRole(pwRole, { name, exact: false }).first(),
        () => root.getByLabel(name, { exact: false }).first(),
        () => root.getByPlaceholder(name, { exact: false }).first(),
        () => root.getByText(name, { exact: true }).first(),
      ];

      let box = null;
      for (const strategy of strategies) {
        try {
          const loc = strategy();
          box = await loc.boundingBox({ timeout: 600 });
          if (box) break;
        } catch { /* try next */ }
      }

      if (box) {
        const cx = Math.round(box.x + box.width  / 2);
        const cy = Math.round(box.y + box.height / 2);
        // Only keep elements visible in the viewport
        if (cx >= 0 && cy >= 0 && cx <= vp.width && cy <= vp.height) {
          el.cx = cx;
          el.cy = cy;
        } else {
          el._offscreen = true;
        }
      }
    } catch { /* element not found — leave coords null */ }
  }

  return elements;
}

// ─── React Select / custom dropdown detection ────────────────────────────────
// Detects React Select and similar custom searchable dropdowns.
// Marks them with type:"react-select" so the agent knows to click+type, not
// use the native "select" action.
async function tagCustomDropdowns(page, elements) {
  try {
    const customDropdowns = await page.evaluate(() => {
      const selectors = [
        '[class*="select__control"]',          // React Select
        '[class*="react-select"]',
        '[class*="Select__control"]',
        '[class*="css-"][class*="control"]',   // emotion-styled React Select
        '.select2-selection',                   // Select2
        '[data-testid*="select"]',
        '[aria-haspopup="listbox"]:not(select)',// custom listbox triggers
      ];
      const found = [];
      for (const sel of selectors) {
        for (const el of document.querySelectorAll(sel)) {
          const r = el.getBoundingClientRect();
          if (!r.width || !r.height) continue;
          // Get label from sibling/parent label element
          let label = el.getAttribute('aria-label') || '';
          if (!label) {
            const container = el.closest('[class*="form"], [class*="field"], .form-group');
            if (container) {
              const lbl = container.querySelector('label');
              if (lbl) label = lbl.textContent.trim();
            }
          }
          // Get current selected value
          const valueEl = el.querySelector('[class*="single-value"], [class*="placeholder"], .select2-selection__rendered');
          const value = valueEl ? valueEl.textContent.trim() : '';
          found.push({
            label: label || 'custom dropdown',
            value,
            cx: Math.round(r.left + r.width  / 2),
            cy: Math.round(r.top  + r.height / 2),
          });
        }
      }
      return found;
    });

    // Add custom dropdowns not already in elements list
    const existingNames = new Set(elements.map(e => e.name.toLowerCase()));
    for (const dd of customDropdowns) {
      const key = dd.label.toLowerCase();
      if (!existingNames.has(key)) {
        elements.push({
          role: 'combobox',
          name: dd.label,
          state: '',
          value: dd.value,
          type: 'react-select',  // ← agent must click+type, NOT use "select" action
          cx: dd.cx,
          cy: dd.cy,
          locator: buildLocator('combobox', dd.label),
        });
        existingNames.add(key);
      } else {
        // Enrich existing entry with react-select tag
        const existing = elements.find(e => e.name.toLowerCase() === key);
        if (existing) existing.type = 'react-select';
      }
    }
  } catch { /* page.evaluate failed — skip */ }

  return elements;
}

// ─── DOM fallback scan ───────────────────────────────────────────────────────
async function domFallbackScan(page) {
  try {
    return await page.$$eval(
      'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]),' +
      'select:not([disabled]), button:not([disabled]), [role="button"],' +
      '[role="checkbox"], [role="switch"], [role="tab"], [role="option"],' +
      'a[href]',
      (els) => {
        const vw = window.innerWidth, vh = window.innerHeight;
        return els.map(el => {
          const rect = el.getBoundingClientRect();
          if (!rect.width || !rect.height) return null;
          const cx = Math.round(rect.left + rect.width  / 2);
          const cy = Math.round(rect.top  + rect.height / 2);
          if (cx < 0 || cy < 0 || cx > vw || cy > vh) return null; // off-screen

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

          return { role, name: name.trim(), state: checked,
            value: value.trim().slice(0, 60), cx, cy, _fromDom: true };
        }).filter(Boolean);
      }
    );
  } catch { return []; }
}

// ─── Main extractor ───────────────────────────────────────────────────────────
async function extractPageContext(page) {
  const url   = page.url();
  const title = await page.title().catch(() => '');

  let elements = [];

  // 1. Primary: page.ariaSnapshot() (Playwright ≥ 1.46)
  //    mode:'ai' strips structural noise and flattens tree for LLM consumption
  //    (from Playwright MCP's tab.captureSnapshot implementation)
  let usedAriaSnapshot = false;
  try {
    const yaml = await page.ariaSnapshot({ timeout: 5000, mode: 'ai' }).catch(() =>
      page.ariaSnapshot({ timeout: 5000 }).catch(() => null)  // fallback: no mode option
    );
    if (yaml) {
      elements = parseAriaSnapshot(yaml);
      usedAriaSnapshot = true;
    }
  } catch { /* not available */ }

  // 2. Fallback: page.accessibility.snapshot()
  if (!usedAriaSnapshot) {
    try {
      const a11y = await page.accessibility.snapshot({ interestingOnly: true });
      if (a11y) walkA11yTree(a11y, elements);
    } catch { /* unavailable */ }
  }

  // 3. Iframe scanning — from Playwright MCP's frame-aware snapshot
  //    Many enterprise/CRM pages embed content in iframes (chat widgets, reports, etc.)
  //    Playwright MCP uses: aria-ref=<ref> >> internal:control=enter-frame
  try {
    const frames = page.frames().filter(f => f !== page.mainFrame() && !f.isDetached());
    for (const frame of frames.slice(0, 3)) { // max 3 iframes to avoid timeout
      try {
        const frameYaml = await frame.locator('body').ariaSnapshot({ timeout: 2000, mode: 'ai' })
          .catch(() => frame.locator('body').ariaSnapshot({ timeout: 2000 }).catch(() => null));
        if (frameYaml) {
          const frameEls = parseAriaSnapshot(frameYaml);
          const frameUrl = frame.url();
          // Tag elements with their frame source so agent knows context
          for (const el of frameEls) {
            el._frame = frame;
            el._frameUrl = frameUrl;
            el.name = el.name; // keep as-is, frame context shown in output
          }
          const existingNames = new Set(elements.map(e => e.name.toLowerCase()));
          for (const el of frameEls) {
            if (!existingNames.has(el.name.toLowerCase())) {
              elements.push(el);
              existingNames.add(el.name.toLowerCase());
            }
          }
        }
      } catch { /* frame scan failed — skip */ }
    }
  } catch { /* frames() failed */ }

  // 3. DOM fallback: pick up elements the a11y tree missed
  const domElements = await domFallbackScan(page);
  const a11yNames = new Set(elements.map(e => e.name.toLowerCase()));
  for (const domEl of domElements) {
    const n = domEl.name.toLowerCase();
    if (!a11yNames.has(n) && n.length > 0) {
      elements.push({ ...domEl, locator: buildLocator(domEl.role, domEl.name) });
      a11yNames.add(n);
    }
  }

  // 4. Tag React Select / custom dropdowns
  elements = await tagCustomDropdowns(page, elements);

  // 5. Enrich with coordinates via locator.boundingBox()
  elements = await enrichWithCoords(page, elements);

  // 6. Drop off-screen elements and re-index
  elements = elements
    .filter(e => !e._offscreen && (e.cx != null || e._fromDom))
    .map((e, i) => ({ ...e, index: i }));

  // 7. Deduplicate names — disambiguate identical role+name pairs (openclaw nth-numbering)
  //    e.g. two "LOGIN" buttons become "LOGIN [1]" and "LOGIN [2]"
  const nameCount = {};
  const nameSeen  = {};
  for (const e of elements) {
    const key = `${e.role}::${e.name.toLowerCase()}`;
    nameCount[key] = (nameCount[key] || 0) + 1;
  }
  for (const e of elements) {
    const key = `${e.role}::${e.name.toLowerCase()}`;
    if (nameCount[key] > 1) {
      nameSeen[key] = (nameSeen[key] || 0) + 1;
      e.name = `${e.name} [${nameSeen[key]}]`;
    }
  }

  return { url, title, elements };
}

// ─── Incremental snapshot diff ───────────────────────────────────────────────
// Store previous snapshot per page URL so we can emit an incremental diff.
// Inspired by openclaw's _snapshotForAI() { full, incremental } pattern.
// Reduces tokens on subsequent steps when most of the page hasn't changed.

const _prevSnapshot = new Map(); // url → formatted string

function diffSnapshot(url, current) {
  const prev = _prevSnapshot.get(url) || '';
  _prevSnapshot.set(url, current);
  if (!prev) return null; // first time — no diff

  const prevLines = new Set(prev.split('\n'));
  const added = current.split('\n').filter(l => l.trim() && !prevLines.has(l));
  if (!added.length) return null; // nothing changed
  if (added.length > 15) return null; // too many changes — just use full
  return added.join('\n');
}

// ─── Formatter ────────────────────────────────────────────────────────────────
const MAX_SNAPSHOT_CHARS = 6000; // cap to avoid blowing context window

function formatContext(ctx, { incremental = false } = {}) {
  const lines = ctx.elements.map(e => {
    const coord = (e.cx != null && e.cy != null) ? `  @(${e.cx},${e.cy})` : '';
    const val   = e.value ? `  val:"${e.value}"` : '';
    const tag   = e.type  ? `  [${e.type}]`      : '';
    return `  [${e.index}] ${e.state || '·'} ${e.role}  "${e.name}"${val}${tag}${coord}`;
  }).join('\n');

  const full = `Page: ${ctx.title}\nURL: ${ctx.url}\n\n` +
    `Interactive elements  [idx] state role "name" val [type] @coords:\n` +
    (lines || '  (none found)');

  // Truncate if too large
  const capped = full.length > MAX_SNAPSHOT_CHARS
    ? full.slice(0, MAX_SNAPSHOT_CHARS) + '\n  ... (truncated)'
    : full;

  if (!incremental) return capped;

  // Try to return only changed lines (saves tokens on step 2+)
  const diff = diffSnapshot(ctx.url, capped);
  if (diff) {
    return `Page: ${ctx.title}\nURL: ${ctx.url}\n\n[CHANGED ELEMENTS ONLY]\n${diff}`;
  }
  return capped;
}

module.exports = { extractPageContext, formatContext };
