'use strict';

// ── Open sidepanel when extension icon is clicked ────────────────────────────
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// ── Shared debugger session manager ──────────────────────────────────────────
// Prevents "Already attached" errors when multiple CDP ops run in sequence.
const _attached = new Set();

function dbgSend(tabId, method, params = {}) {
  return new Promise((res, rej) => {
    chrome.debugger.sendCommand({ tabId }, method, params, (r) => {
      if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
      else res(r);
    });
  });
}

async function withDebugger(tabId, fn) {
  const alreadyAttached = _attached.has(tabId);
  if (!alreadyAttached) {
    await new Promise((res, rej) => {
      chrome.debugger.attach({ tabId }, '1.3', () => {
        if (chrome.runtime.lastError) rej(new Error(chrome.runtime.lastError.message));
        else res();
      });
    });
    _attached.add(tabId);
  }
  try {
    return await fn();
  } finally {
    if (!alreadyAttached) {
      _attached.delete(tabId);
      await new Promise(res => chrome.debugger.detach({ tabId }, res));
    }
  }
}

// Clean up on tab navigation/close
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId) _attached.delete(source.tabId);
});

// ── Message handlers ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'CAPTURE_SCREENSHOT': {
      chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 50 }, (dataUrl) => {
        if (chrome.runtime.lastError) sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        else sendResponse({ ok: true, dataUrl });
      });
      return true;
    }

    case 'INJECT_CONTENT': {
      chrome.scripting.executeScript(
        { target: { tabId: msg.tabId }, files: ['content.js'] },
        () => sendResponse({ ok: !chrome.runtime.lastError })
      );
      return true;
    }

    case 'WAIT_FOR_TAB_LOAD': {
      const tabId = msg.tabId, timeout = msg.timeout || 20000;
      const done = (ok) => { chrome.tabs.onUpdated.removeListener(listener); clearTimeout(timer); sendResponse({ ok }); };
      const listener = (id, info) => { if (id === tabId && info.status === 'complete') done(true); };
      chrome.tabs.onUpdated.addListener(listener);
      const timer = setTimeout(() => done(true), timeout);
      return true;
    }

    // ── CDP coordinate click (existing behaviour) ────────────────────────────
    case 'CDP_CLICK': {
      const { tabId, x, y } = msg;
      withDebugger(tabId, async () => {
        await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved',    x, y, button: 'none',  clickCount: 0 });
        await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left',  clickCount: 1 });
        await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left',  clickCount: 1 });
      })
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    // ── CDP click by backendNodeId (HyperAgent-style — most reliable) ────────
    // Resolves the node's live bounding box at click time — no coord drift.
    case 'CDP_CLICK_NODE': {
      const { tabId, backendNodeId } = msg;
      withDebugger(tabId, async () => {
        // Resolve DOM node to a JS object
        const { object } = await dbgSend(tabId, 'DOM.resolveNode', { backendNodeId });
        const oid = object.objectId;

        // Scroll into view, then get live centre coords
        await dbgSend(tabId, 'Runtime.callFunctionOn', {
          objectId: oid,
          functionDeclaration: `function(){ this.scrollIntoView({block:'nearest',inline:'nearest'}); }`,
          returnByValue: false,
        });
        await new Promise(r => setTimeout(r, 80));

        const { result } = await dbgSend(tabId, 'Runtime.callFunctionOn', {
          objectId: oid,
          functionDeclaration: `function(){
            const r=this.getBoundingClientRect();
            return JSON.stringify({x:r.left+r.width/2,y:r.top+r.height/2});
          }`,
          returnByValue: true,
        });
        const { x, y } = JSON.parse(result.value);

        await dbgSend(tabId, 'Runtime.releaseObject', { objectId: oid });

        // Fire real mouse events at live coords
        await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved',    x, y, button: 'none', clickCount: 0 });
        await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed',  x, y, button: 'left', clickCount: 1 });
        await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      })
        .then(() => sendResponse({ ok: true }))
        .catch(err => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    // ── Native accessibility tree snapshot (Stagehand/HyperAgent approach) ───
    // Uses browser's built-in a11y tree — more complete than querySelectorAll.
    case 'GET_A11Y_SNAPSHOT': {
      const { tabId } = msg;
      withDebugger(tabId, async () => {
        await dbgSend(tabId, 'Accessibility.enable');
        const { nodes } = await dbgSend(tabId, 'Accessibility.getFullAXTree', {});

        const INTERACTIVE = new Set([
          'button','link','textbox','searchbox','combobox','listbox',
          'option','checkbox','radio','slider','spinbutton','tab',
          'menuitem','menuitemcheckbox','menuitemradio','switch','treeitem',
          'cell','columnheader','rowheader',
        ]);

        // Filter to actionable nodes with a name and a backend DOM node ID
        const items = [];
        for (const n of nodes) {
          if (n.ignored || !n.backendDOMNodeId) continue;
          const role = n.role?.value;
          if (!role || role === 'none' || role === 'presentation') continue;
          const name = n.name?.value?.trim();
          if (!name) continue;
          if (!INTERACTIVE.has(role)) continue;

          const props = {};
          for (const p of (n.properties || [])) {
            if (['disabled','checked','expanded','pressed','selected','required','invalid'].includes(p.name)) {
              props[p.name] = p.value?.value;
            }
          }
          items.push({ backendNodeId: n.backendDOMNodeId, role, name, props, nodeId: n.nodeId });
        }
        return items;
      })
        .then(items => sendResponse({ ok: true, items }))
        .catch(err  => sendResponse({ ok: false, error: err.message }));
      return true;
    }

    default:
      break;
  }
});
