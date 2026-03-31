'use strict';

// ── BrowserMCP content script ────────────────────────────────────────────────
// Runs in the context of every web page.
// Handles: GET_SNAPSHOT (build element list) + EXECUTE_ACTION (DOM interactions)

let _els = []; // cached snapshot — rebuilt on every GET_SNAPSHOT call
const _refMap = new Map(); // ref → element entry, for stable re-finding

// ── Stable ref generation (playwright-mcp style) ──────────────────────────────
const ROLE_SHORT = { button:'btn', link:'lnk', textbox:'inp', combobox:'sel',
  checkbox:'chk', radio:'rad', tab:'tab', option:'opt', menuitem:'mnu',
  slider:'rng', generic:'div', listitem:'li' };

function makeRef(role, name, idx) {
  const r = ROLE_SHORT[role] || role.slice(0, 3);
  const n = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 22);
  return `${r}-${n || idx}`;
}

// ── Semantic re-find: if a cached element is removed from DOM, find it again ──
function reFind(entry) {
  // Try by ID
  if (entry._el.id) {
    const el = document.getElementById(entry._el.id);
    if (el) return el;
  }
  // Try by aria-label exact match
  const label = entry._el.getAttribute?.('aria-label');
  if (label) {
    const el = document.querySelector(`[aria-label="${CSS.escape(label)}"]`);
    if (el && document.contains(el)) return el;
  }
  // Try by role + accessible name scan
  const SELECTORS = 'button,input,select,textarea,a[href],[role]';
  for (const el of document.querySelectorAll(SELECTORS)) {
    if (getRole(el) === entry.role && getAccessibleName(el).startsWith(entry.name.slice(0, 25))) {
      if (document.contains(el)) return el;
    }
  }
  // Try cursor:pointer elements with matching name
  for (const el of document.querySelectorAll('div,span,li')) {
    if (getAccessibleName(el) === entry.name && getComputedStyle(el).cursor === 'pointer') {
      if (document.contains(el)) return el;
    }
  }
  return null;
}

// ── Accessible name resolution ────────────────────────────────────────────────
function getAccessibleName(el) {
  return (
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    el.getAttribute('title') ||
    el.getAttribute('alt') ||
    (el.labels?.[0]?.textContent?.trim()) ||
    (() => {
      if (!el.id) return '';
      try { return document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() || ''; }
      catch { return ''; }
    })() ||
    (el.innerText || el.textContent || '').trim().slice(0, 80) ||
    el.getAttribute('name') ||
    el.getAttribute('type') ||
    el.tagName.toLowerCase()
  ).trim();
}

function getRole(el) {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  switch (el.tagName) {
    case 'BUTTON': return 'button';
    case 'A':      return 'link';
    case 'INPUT': {
      if (el.type === 'checkbox') return 'checkbox';
      if (el.type === 'radio')    return 'radio';
      if (el.type === 'submit' || el.type === 'button') return 'button';
      if (el.type === 'range')    return 'slider';
      return 'textbox';
    }
    case 'TEXTAREA': return 'textbox';
    case 'SELECT':   return 'combobox';
    default:         return 'generic';
  }
}

function getState(el) {
  if (el.disabled) return '🚫';
  if (el.type === 'checkbox' || el.type === 'radio') return el.checked ? '✓' : '○';
  if (el.getAttribute('aria-checked') === 'true')    return '✓';
  if (el.getAttribute('aria-pressed') === 'true')    return '▼';
  if (el.getAttribute('aria-expanded') === 'true')   return '▾';
  return '';
}

function getValue(el) {
  if (el.tagName === 'SELECT') return el.options[el.selectedIndex]?.text?.slice(0, 60) || '';
  return (el.value || '').slice(0, 60);
}

function isCustomDropdown(el) {
  const cls = (el.className || '').toString();
  return (
    cls.includes('select__control') ||
    cls.includes('react-select') ||
    cls.includes('Select__control') ||
    (el.getAttribute('aria-haspopup') === 'listbox' && el.tagName !== 'SELECT')
  );
}

// ── Shadow DOM traversal ──────────────────────────────────────────────────────
function queryShadowAll(root, selector, results = []) {
  try {
    for (const el of root.querySelectorAll(selector)) results.push(el);
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) queryShadowAll(el.shadowRoot, selector, results);
    }
  } catch {}
  return results;
}

// ── Page visible text (for context) ──────────────────────────────────────────
function getVisibleText() {
  try {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const p = node.parentElement;
        if (!p) return NodeFilter.FILTER_REJECT;
        const tag = p.tagName;
        if (['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(tag)) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(p);
        if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    let text = '', node;
    while ((node = walker.nextNode()) && text.length < 600) {
      const t = node.textContent.trim();
      if (t.length > 2) text += t + ' ';
    }
    return text.trim().slice(0, 600);
  } catch { return ''; }
}

// ── Snapshot builder ──────────────────────────────────────────────────────────
function buildSnapshot() {
  _els = [];
  _refMap.clear();
  const vw = window.innerWidth, vh = window.innerHeight;
  const MARGIN = 150;
  const nameCount = {}, nameSeen = {}, refCount = {};

  const SELECTORS = [
    'button:not([disabled])',
    'input:not([type=hidden]):not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    'a[href]',
    '[role=button]:not([disabled])',
    '[role=checkbox]', '[role=radio]', '[role=tab]',
    '[role=option]', '[role=combobox]', '[role=menuitem]',
    '[role=switch]', '[role=link]', '[role=slider]',
    '[role=listitem] button', '[data-add-to-cart]',
  ].join(',');

  const seen = new WeakSet();

  function addEl(el) {
    if (seen.has(el)) return;
    seen.add(el);
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const cx = Math.round(rect.left + rect.width  / 2);
    const cy = Math.round(rect.top  + rect.height / 2);
    if (cx < -MARGIN || cy < -MARGIN || cx > vw + MARGIN || cy > vh + MARGIN) return;
    const role = getRole(el);
    const name = getAccessibleName(el);
    if (!name) return;
    const key = `${role}::${name.toLowerCase()}`;
    nameCount[key] = (nameCount[key] || 0) + 1;
    _els.push({ role, name, state: getState(el), value: getValue(el),
      type: isCustomDropdown(el) ? 'react-select' : undefined,
      cx, cy, _el: el });
  }

  // Pass 1: standard interactive elements
  for (const el of queryShadowAll(document, SELECTORS)) addEl(el);

  // Pass 2: clickable card divs/spans (React card UIs)
  for (const el of document.querySelectorAll('div,span,li,td,p')) {
    if (seen.has(el)) continue;
    try {
      const style = getComputedStyle(el);
      if (style.cursor !== 'pointer') continue;
      if (style.display === 'none' || style.visibility === 'hidden') continue;
    } catch { continue; }
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) continue;
    if (rect.width > vw * 0.8 || rect.height > 200) continue;
    const name = getAccessibleName(el);
    if (!name || name.length < 2) continue;
    addEl(el);
  }

  // Assign indices, generate stable refs, populate _refMap
  for (const e of _els) {
    const key = `${e.role}::${e.name.toLowerCase()}`;
    if (nameCount[key] > 1) {
      nameSeen[key] = (nameSeen[key] || 0) + 1;
      e.name = `${e.name} [${nameSeen[key]}]`;
    }
    e.index = _els.indexOf(e);

    // Generate unique stable ref
    let ref = makeRef(e.role, e.name, e.index);
    if (refCount[ref]) { ref = `${ref}-${refCount[ref]}`; }
    refCount[ref] = (refCount[ref] || 0) + 1;
    e.ref = ref;
    _refMap.set(ref, e);
  }

  // Format — show ref instead of raw coords; coords kept for CDP fallback
  const MAX_EL_CHARS = 5000;
  let lines = _els.map(e => {
    const val  = e.value ? ` val:"${e.value}"` : '';
    const tag  = e.type  ? ` [${e.type}]`      : '';
    const st   = e.state && e.state !== '·' ? ` ${e.state}` : '';
    return `[${e.index}] ${e.role}${st} "${e.name}"${val}${tag} #${e.ref} @(${e.cx},${e.cy})`;
  }).join('\n');
  if (lines.length > MAX_EL_CHARS) lines = lines.slice(0, MAX_EL_CHARS) + '\n...(truncated)';

  const pageText = getVisibleText();

  return {
    url:   location.href,
    title: document.title,
    text:  `Page: ${document.title}\nURL: ${location.href}\n${pageText ? `\nVisible text: ${pageText}\n` : ''}\nElements:\n${lines || '(none)'}`,
    count: _els.length,
  };
}

// ── React-compatible fill ─────────────────────────────────────────────────────
function nativeFill(el, value) {
  const proto = el.tagName === 'TEXTAREA'
    ? window.HTMLTextAreaElement.prototype
    : window.HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) {
    setter.call(el, value);
  } else {
    el.value = value;
  }
  el.dispatchEvent(new Event('input',  { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

// ── Keyboard event dispatch ───────────────────────────────────────────────────
function fireKey(target, key) {
  const keyProps = {
    Enter:     { keyCode: 13, code: 'Enter' },
    Escape:    { keyCode: 27, code: 'Escape' },
    Tab:       { keyCode:  9, code: 'Tab' },
    Backspace: { keyCode:  8, code: 'Backspace' },
    ArrowDown: { keyCode: 40, code: 'ArrowDown' },
    ArrowUp:   { keyCode: 38, code: 'ArrowUp' },
    Space:     { keyCode: 32, code: 'Space', key: ' ' },
  };
  const props = keyProps[key] || { keyCode: key.charCodeAt?.(0) || 0, code: `Key${key}` };
  const el = target || document.activeElement || document.body;
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true, ...props }));
  }
}

// Look up element by index OR ref — with semantic re-finding if DOM is stale
function getEl(index, ref) {
  // Try ref lookup first (more stable)
  const entry = ref ? _refMap.get(ref) : _els[index];
  if (!entry) return null;
  // Element still in DOM — return it directly
  if (document.contains(entry._el)) return entry._el;
  // Stale — try semantic re-find so React re-renders don't break clicks
  const live = reFind(entry);
  if (live) {
    entry._el = live; // update cache
    return live;
  }
  return null;
}

// ── Action executor ───────────────────────────────────────────────────────────
async function executeAction(msg) {
  const { action, index, ref, value, x, y, x1, y1, x2, y2, key, url, script,
    direction, amount, text, ms } = msg;

  try {
    switch (action) {

      case 'click': {
        let el = getEl(index, ref);
        if (!el) {
          // Element stale — try coordinate fallback using stored cx/cy
          // Look up by index OR by ref (when GPT sends ref-only without index)
          const stored = _els[index] ?? (ref ? _els.find(e => e.ref === ref) : null);
          const fx = msg.cx ?? stored?.cx;
          const fy = msg.cy ?? stored?.cy;
          if (fx != null && fy != null) {
            const live = document.elementFromPoint(fx, fy);
            if (live) {
              live.focus();
              live.scrollIntoView({ block: 'nearest' });
              live.click();
              for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
                live.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t,
                  { bubbles: true, cancelable: true, clientX: fx, clientY: fy, pointerId: 1 }));
              }
              return { success: true, message: `Clicked via coord fallback (${fx},${fy})` };
            }
          }
          return { success: false, message: `Element ${ref ? '#'+ref : '['+index+']'} not found` };
        }
        el.scrollIntoView({ block: 'nearest' });
        await new Promise(r => setTimeout(r, 80));
        // Get LIVE bounding rect after scroll (not cached coordinates)
        const rect = el.getBoundingClientRect();
        const cx = Math.round(rect.left + rect.width / 2);
        const cy = Math.round(rect.top  + rect.height / 2);
        // Use the actual topmost element at those coordinates (handles React portals/overlays)
        const topEl = document.elementFromPoint(cx, cy) || el;
        topEl.focus();
        topEl.click(); // native click — React/Vue/Angular respond to this
        for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
          topEl.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t,
            { bubbles: true, cancelable: true, clientX: cx, clientY: cy, pointerId: 1 }));
        }
        // Let React/Angular flush state before returning
        await new Promise(r => setTimeout(r, 120));
        return { success: true, message: `Clicked "${_els[index]?.name}" at (${cx},${cy})` };
      }

      case 'double_click': {
        const el = getEl(index, ref);
        if (!el) return { success: false, message: `Element [${index}] not found` };
        el.focus();
        el.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
        return { success: true, message: `Double-clicked "${_els[index]?.name}"` };
      }

      case 'fill': {
        const el = getEl(index, ref);
        if (!el) return { success: false, message: `Element [${index}] not found` };
        el.scrollIntoView({ block: 'nearest' });
        // Dismiss overlays first
        fireKey(document.activeElement, 'Escape');
        await new Promise(r => setTimeout(r, 80));
        el.focus();
        el.click();
        await new Promise(r => setTimeout(r, 60));
        // Select-all then type (works for React-controlled inputs too)
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }));
        nativeFill(el, '');
        await new Promise(r => setTimeout(r, 30));
        nativeFill(el, String(value));
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: String(value) }));
        // Blur/focusout to trigger React's onBlur form-validation handlers
        // (some SPAs only enable submit buttons after blur, not just onChange)
        el.dispatchEvent(new FocusEvent('blur',     { bubbles: true }));
        el.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
        await new Promise(r => setTimeout(r, 80));
        return { success: true, message: `Filled "${_els[index]?.name ?? ref}" with "${String(value).slice(0,60)}"` };
      }

      case 'fill_otp': {
        // Handle OTP fields — either a single input or N separate single-digit boxes
        const digits = String(value).replace(/\D/g, '');
        // Find all OTP-like inputs: maxlength=1 or type=tel/number near each other
        const otpInputs = Array.from(document.querySelectorAll(
          'input[maxlength="1"], input[data-index], input.otp, input[autocomplete="one-time-code"]'
        )).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        });

        if (otpInputs.length >= 2) {
          // Separate boxes — fill each digit into its box
          for (let i = 0; i < Math.min(digits.length, otpInputs.length); i++) {
            const box = otpInputs[i];
            box.focus();
            nativeFill(box, digits[i]);
            box.dispatchEvent(new InputEvent('input', { bubbles: true, data: digits[i] }));
            box.dispatchEvent(new KeyboardEvent('keydown', { key: digits[i], bubbles: true }));
            box.dispatchEvent(new KeyboardEvent('keyup',  { key: digits[i], bubbles: true }));
            await new Promise(r => setTimeout(r, 60));
          }
          return { success: true, message: `Filled OTP "${digits}" across ${otpInputs.length} boxes` };
        }

        // Single OTP input (autocomplete="one-time-code" style)
        const single = otpInputs[0] || document.querySelector('input[type="number"],input[type="tel"],input[type="text"]');
        if (single) {
          single.focus();
          nativeFill(single, digits);
          single.dispatchEvent(new InputEvent('input', { bubbles: true }));
          return { success: true, message: `Filled OTP "${digits}" into single input` };
        }
        return { success: false, message: 'No OTP input found' };
      }

      case 'select': {
        const el = getEl(index, ref);
        if (!el || el.tagName !== 'SELECT')
          return { success: false, message: `Native select [${index}] not found` };
        const opt = Array.from(el.options).find(o =>
          o.text.toLowerCase().includes(String(value).toLowerCase()) ||
          o.value.toLowerCase() === String(value).toLowerCase()
        );
        if (!opt) return { success: false, message: `Option "${value}" not found` };
        el.value = opt.value;
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { success: true, message: `Selected "${opt.text}"` };
      }

      case 'press_on': {
        const el = getEl(index, ref);
        if (!el) return { success: false, message: `Element [${index}] not found` };
        el.focus();
        await new Promise(r => setTimeout(r, 60));
        fireKey(el, key);
        return { success: true, message: `Pressed ${key} on [${index}]` };
      }

      case 'press': {
        fireKey(document.activeElement, key);
        return { success: true, message: `Pressed ${key}` };
      }

      case 'type': {
        const target = document.activeElement || document.body;
        for (const char of String(text)) {
          fireKey(target, char);
          if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') {
            nativeFill(target, (target.value || '') + char);
          }
          await new Promise(r => setTimeout(r, 25));
        }
        return { success: true, message: `Typed "${text}"` };
      }

      case 'scroll': {
        const px = (amount || 300) * (['up','left'].includes(direction) ? -1 : 1);
        if (direction === 'top')    { window.scrollTo({ top: 0, behavior: 'smooth' }); }
        else if (direction === 'bottom') { window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' }); }
        else if (direction === 'left' || direction === 'right') { window.scrollBy({ left: px, behavior: 'smooth' }); }
        else { window.scrollBy({ top: px, behavior: 'smooth' }); }
        return { success: true, message: `Scrolled ${direction}` };
      }

      case 'scroll_xy': {
        const el = document.elementFromPoint(x, y);
        const px = (amount || 300) * (direction === 'up' ? -1 : 1);
        if (el) el.scrollBy?.({ top: px, behavior: 'smooth' });
        return { success: true, message: `Scrolled at (${x},${y})` };
      }

      case 'click_xy': {
        const el = document.elementFromPoint(x, y);
        if (!el) return { success: false, message: `No element at (${x},${y})` };
        el.focus();
        el.click();
        for (const t of ['pointerdown','mousedown','pointerup','mouseup','click']) {
          el.dispatchEvent(new (t.startsWith('pointer') ? PointerEvent : MouseEvent)(t,
            { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1 }));
        }
        return { success: true, message: `Clicked at (${x},${y})` };
      }

      case 'hover': {
        const el = getEl(index, ref);
        if (el) {
          el.dispatchEvent(new MouseEvent('mouseover',  { bubbles: true }));
          el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        }
        return { success: true, message: `Hovered [${index}]` };
      }

      case 'hover_xy': {
        const el = document.elementFromPoint(x, y);
        if (el) {
          el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, clientX: x, clientY: y }));
          el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
        }
        return { success: true, message: `Hovered at (${x},${y})` };
      }

      case 'drag_xy': {
        const fromEl = document.elementFromPoint(x1, y1) || document.body;
        fromEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: x1, clientY: y1 }));
        const STEPS = 12;
        for (let i = 0; i <= STEPS; i++) {
          const cx = x1 + (x2 - x1) * i / STEPS;
          const cy = y1 + (y2 - y1) * i / STEPS;
          const el = document.elementFromPoint(cx, cy) || document.body;
          el.dispatchEvent(new MouseEvent('mousemove', { bubbles: true, clientX: cx, clientY: cy }));
          await new Promise(r => setTimeout(r, 12));
        }
        const toEl = document.elementFromPoint(x2, y2) || document.body;
        toEl.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, clientX: x2, clientY: y2 }));
        return { success: true, message: `Dragged (${x1},${y1})→(${x2},${y2})` };
      }

      case 'evaluate': {
        // Running in page context — can eval directly
        let result;
        try {
          // eslint-disable-next-line no-eval
          result = await eval(`(async()=>{${script}})()`);
        } catch (e) {
          result = `Error: ${e.message}`;
        }
        return { success: true, message: String(result ?? 'done') };
      }

      case 'wait': {
        await new Promise(r => setTimeout(r, ms || 1000));
        return { success: true, message: `Waited ${ms || 1000}ms` };
      }

      default:
        return { success: false, message: `Unknown action: ${action}` };
    }
  } catch (err) {
    return { success: false, message: err.message };
  }
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case 'GET_SNAPSHOT':
        sendResponse(buildSnapshot());
        break;
      case 'EXECUTE_ACTION':
        sendResponse(await executeAction(msg));
        break;
      case 'PING':
        sendResponse({ ok: true });
        break;
      case 'START_SPEECH': {
        const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
        if (!SR) { sendResponse({ success: false, message: 'no-api' }); break; }
        if (window._bmcpRec) { try { window._bmcpRec.stop(); } catch {} }
        const rec = new SR();
        window._bmcpRec = rec;
        rec.continuous     = false;
        rec.interimResults = true;
        rec.lang           = 'en-IN';
        rec.onresult = (e) => {
          let interim = '', final = '';
          for (const r of e.results) {
            if (r.isFinal) final += r[0].transcript;
            else interim += r[0].transcript;
          }
          chrome.runtime.sendMessage({ type: 'SPEECH_INTERIM', text: final || interim });
        };
        rec.onerror = (e) => {
          chrome.runtime.sendMessage({ type: 'SPEECH_ERROR', error: e.error });
        };
        rec.onend = () => {
          window._bmcpRec = null;
          chrome.runtime.sendMessage({ type: 'SPEECH_END' });
        };
        try { rec.start(); sendResponse({ success: true }); }
        catch (e) { sendResponse({ success: false, message: e.message }); }
        break;
      }
      case 'STOP_SPEECH': {
        if (window._bmcpRec) {
          try { window._bmcpRec.stop(); } catch {}
        }
        sendResponse({ success: true });
        break;
      }
      default:
        sendResponse({ success: false, message: `Unknown: ${msg.type}` });
    }
  })();
  return true; // keep channel open for async response
});
