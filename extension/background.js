'use strict';

// ── Open sidepanel when extension icon is clicked ────────────────────────────
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ windowId: tab.windowId });
});

// ── Message handlers for sidepanel ───────────────────────────────────────────
// The sidepanel runs the agent loop but needs background for chrome.tabs APIs
// that aren't available in the sidepanel context (captureVisibleTab, etc.)

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'CAPTURE_SCREENSHOT': {
      // chrome.tabs.captureVisibleTab must be called from background
      chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 50 }, (dataUrl) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        } else {
          sendResponse({ ok: true, dataUrl });
        }
      });
      return true; // async
    }

    case 'INJECT_CONTENT': {
      // Re-inject content script into a tab (after navigation to new page)
      chrome.scripting.executeScript(
        { target: { tabId: msg.tabId }, files: ['content.js'] },
        () => sendResponse({ ok: !chrome.runtime.lastError })
      );
      return true;
    }

    case 'WAIT_FOR_TAB_LOAD': {
      // Resolve when the tab finishes loading
      const tabId = msg.tabId;
      const timeout = msg.timeout || 20000;

      const done = (ok) => {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        sendResponse({ ok });
      };

      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') done(true);
      };

      chrome.tabs.onUpdated.addListener(listener);
      const timer = setTimeout(() => done(true), timeout); // resolve on timeout too
      return true;
    }

    default:
      break;
  }
});
