'use strict';

// ── Phonetic normalization (same as server/index.js) ─────────────────────────
const PHONETIC_FIXES = [
  [/\bcapture[d]?\b/gi, 'Kapture'],
  [/\bcaptur\b/gi,      'Kapture'],
  [/\bseeds?\b/gi,      'CX'],
  [/\bcream\b/gi,       'CRM'],
  [/\bcram\b/gi,        'CRM'],
  [/\bin\s*two\b/gi,    'in2'],
  [/\bin\s*three\b/gi,  'in3'],
  [/\badjeter\b/gi,     'Adjetter'],
  [/\ba\s*jetter\b/gi,  'Adjetter'],
  [/\bau\s+agent/gi,    'AI agent'],
  [/\bay\s+agent/gi,    'AI agent'],
  [/\bAI\s+age\b/gi,    'AI agent'],
];
function normalizeText(t) {
  for (const [p, r] of PHONETIC_FIXES) t = t.replace(p, r);
  return t;
}

// ── Storage helpers ───────────────────────────────────────────────────────────
async function getApiKey() {
  const r = await chrome.storage.local.get('openaiApiKey');
  return r.openaiApiKey || '';
}

// ── OpenAI fetch ──────────────────────────────────────────────────────────────
async function callOpenAI(messages, { model = 'gpt-4o', maxTokens = 512, json = false } = {}) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No API key. Click ⚙️ Settings to add your OpenAI key.');

  const body = { model, messages, max_tokens: maxTokens, temperature: 0 };
  if (json) body.response_format = { type: 'json_object' };

  const resp = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
  });

  if (!resp.ok) {
    const e = await resp.json().catch(() => ({}));
    throw new Error(e.error?.message || `OpenAI ${resp.status}`);
  }
  const data = await resp.json();
  return data.choices[0]?.message?.content || '';
}

// ── Whisper transcription ─────────────────────────────────────────────────────
async function transcribeAudio(blob) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No API key set.');
  const fd = new FormData();
  fd.append('file', blob, 'audio.webm');
  fd.append('model', 'whisper-1');
  const resp = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: fd,
  });
  const data = await resp.json();
  return data.text?.trim() || '';
}

// ── Intent parser ─────────────────────────────────────────────────────────────
const INTENT_PROMPT = `
You are a browser automation intent classifier. Parse the user's voice/text command.

Return ONE of these JSON actions:
- {"action":"navigate","params":{"url":"https://..."}}        ← go to a website URL
- {"action":"click_element","params":{"target":"..."}}        ← click ONE named element already on the page
- {"action":"smart_act","params":{"command":"..."}}           ← multi-step task
- {"action":"scroll_act","params":{"direction":"down"}}       ← scroll page
- {"action":"media_act","params":{"operation":"pause"}}       ← media control
- {"action":"fill_input","params":{"field":"...","value":""}} ← fill a form field

NAVIGATE rules (highest priority — check these FIRST):
1. "open X" / "go to X" / "open X website" / "launch X" where X is a consumer app or website → navigate to that URL.
   Examples: "open BigBasket" → {"action":"navigate","params":{"url":"https://www.bigbasket.com"}}
             "open Amazon" → https://www.amazon.in
             "open Flipkart" → https://www.flipkart.com
             "open Zomato" → https://www.zomato.com
             "open Swiggy" → https://www.swiggy.com
             "open YouTube" → https://www.youtube.com
             "open Google" → https://www.google.com
             "open Instagram" → https://www.instagram.com
             "open Myntra" → https://www.myntra.com
             "open Nykaa" → https://www.nykaa.com
             "go back" / "go back to X" → use navigate with the URL of that page if known, else smart_act
2. "open X.com" or any explicit domain → navigate to that URL
3. scroll up/down/top/bottom → scroll_act
4. play/pause/mute/volume → media_act
5. "my number/email/password is X" → fill_input
6. "click on X" / "select X" / "go to X tab" (element already visible on the current page) → click_element
7. "login to <CLIENT>" (Kapture CRM partner login) → smart_act:
   "Kapture partner login for <CLIENT>: navigate https://adjetter.com/admin/home.html, sign in with Google if needed, click LOGIN TO PARTNER EMPLOYEE, select admin server https://in.kapturecrm.com, select domain <CLIENT> from React Select dropdown (click control → type name → click option), select employee, fill Remarks with 5+ words, click Submit"
8. "open Kapture" / "Kapture admin" → navigate to https://adjetter.com/admin/home.html
9. Everything else → smart_act with the full command text

KEY DISTINCTION: "open BigBasket" = go to bigbasket.com (navigate). "login to BigBasket" = Kapture CRM partner login (smart_act).

Return ONLY valid JSON. No markdown.
`.trim();

async function parseIntent(text, context = '') {
  const user = context ? `Recent:\n${context}\n\nCommand: "${text}"` : `Command: "${text}"`;
  try {
    const raw = await callOpenAI(
      [{ role: 'system', content: INTENT_PROMPT }, { role: 'user', content: user }],
      { maxTokens: 200, json: true }
    );
    return JSON.parse(raw);
  } catch {
    return { action: 'smart_act', params: { command: text } };
  }
}

// ── Agent system prompt ───────────────────────────────────────────────────────
const AGENT_PROMPT = `
You are an autonomous browser agent controlling a real Chrome browser via voice commands.
You see: a screenshot of the current page + a list of interactive elements.
Element format: [idx] state role "name" val:"value" [type] @(cx,cy)
[react-select] = custom searchable dropdown — never use "select" action on it.

Return ONE JSON action per turn. Return ONLY valid JSON, no markdown, no explanation.

ACTIONS:
click      {"action":"click","index":N,"description":"..."}
fill       {"action":"fill","index":N,"value":"text","description":"..."}
press_on   {"action":"press_on","index":N,"key":"Enter","description":"..."}
click_xy   {"action":"click_xy","x":N,"y":N,"description":"..."}
scroll     {"action":"scroll","direction":"down","amount":400,"description":"..."}
scroll_xy  {"action":"scroll_xy","x":N,"y":N,"direction":"down","amount":300,"description":"..."}
select     {"action":"select","index":N,"value":"option text","description":"..."}
press      {"action":"press","key":"Tab","description":"..."}
type       {"action":"type","text":"...","description":"..."}
hover_xy   {"action":"hover_xy","x":N,"y":N,"description":"..."}
evaluate   {"action":"evaluate","script":"JS code returning string","description":"..."}
navigate   {"action":"navigate","url":"https://...","description":"..."}
wait       {"action":"wait","ms":1500,"description":"..."}
done       {"action":"done","message":"what was accomplished"}
failed     {"action":"failed","message":"why it failed"}

GENERAL RULES:
1. Study the screenshot first. Use click_xy for elements visible in screenshot but absent from the elements list.
2. Dismiss modals / cookie banners / overlays FIRST (Escape or click close/accept/continue button).
3. If goal is already done (item in cart, page loaded, form submitted), return done immediately.
4. Never repeat the same failed action twice. Try click_xy fallback using @(cx,cy) coordinates.
5. Never ask the user for values. If a value is unknown, use what makes sense from context.

SEARCH BARS (Google, Amazon, Flipkart, Myntra, etc.):
6. Find the main search input (large text box near the top). Fill it with the query, then press_on the same index with key "Enter".
7. Wait for results, then click the most relevant product result.

E-COMMERCE — PRODUCT + CART:
8. After search results load, click the first / most relevant product to open its page.
9. On product page: select size/colour/variant if required before adding to cart.
10. Click "Add to Cart" / "Add to Bag" / "Add to Wishlist" / "Buy Now" button. Confirm via cart badge change or success toast.
11. After adding: if asked to checkout, click "Go to Cart" → "Proceed to Checkout" → fill address/payment if needed.
12. Price filters: evaluate DOM to find input[type=range], select, or text inputs — use appropriate method.

LOGIN FLOWS:
13. Email/username field: fill → Tab or press_on Enter → password field: fill → click Login/Sign In/Submit.
14. Google Sign-In popup: click the Google account shown in the popup.
15. OTP fields: fill the entire OTP if single field; click individual boxes if separate.
16. "Stay signed in" / "Remember me" dialogs: click Yes/Continue.

NAVIGATION + MENUS:
17. Top nav tabs: click directly. If tab not visible, scroll up first.
18. Hover menus: hover_xy parent item, then click revealed submenu item.
19. Pagination: click "Next" or page number.
20. Infinite scroll pages: scroll down 600px to load more items.

REACT SELECT / CUSTOM DROPDOWNS ([react-select] in element list):
21. Step A: click the [react-select] control element to open it.
    Step B: use fill on the SAME element (or type action) to type the search text.
    Step C: wait 600ms then click the option that appears in the dropdown list.
    NEVER use the "select" action on a [react-select]. NEVER click an option before the dropdown is open.

KAPTURE CRM (adjetter.com / kapturecrm.com):
22. Login: click Sign in with Google.
23. Partner login flow: LOGIN TO PARTNER EMPLOYEE → Select Admin Server → Domain Name (react-select: type to search) → Select Employee → Remarks (5+ words) → Submit.

STUCK DETECTION:
24. If snapshot looks identical to previous step, try scrolling or a different element.
25. If an element click fails (not found), use click_xy at the element's @(cx,cy) as fallback.
26. After 3 failed attempts on same step, return failed with a clear reason.
`.trim();

async function getNextStep(goal, pageText, screenshotUrl, history) {
  const hist = history.length
    ? '\nSteps done:\n' + history.map((h, i) => `${i + 1}. ${h}`).join('\n')
    : '\nNo steps yet.';
  const goalText = `GOAL: ${goal}${hist}\n\nCurrent page:\n${pageText}\n\nNext single action?`;

  const userContent = screenshotUrl
    ? [
        { type: 'image_url', image_url: { url: screenshotUrl, detail: 'high' } },
        { type: 'text', text: goalText },
      ]
    : goalText;

  const raw = await callOpenAI(
    [{ role: 'system', content: AGENT_PROMPT }, { role: 'user', content: userContent }],
    { maxTokens: 512, json: true }
  );
  return JSON.parse(raw);
}

// ── Tab helpers ───────────────────────────────────────────────────────────────
async function getActiveTabId() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

async function ensureContentScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'PING' });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] })
      .catch(() => {});
    await new Promise(r => setTimeout(r, 300));
  }
}

async function waitForTabLoad(tabId, timeout = 20000) {
  return new Promise(resolve => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        clearTimeout(timer);
        setTimeout(resolve, 600); // let JS settle
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve();
    }, timeout);
  });
}

async function getSnapshot(tabId) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, { type: 'GET_SNAPSHOT' });
}

async function takeScreenshot() {
  try {
    return await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 80 });
  } catch {
    return null;
  }
}

async function sendAction(tabId, action) {
  await ensureContentScript(tabId);
  return chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', ...action });
}

// ── Quick click — no GPT loop, just fuzzy snapshot match ─────────────────────
function fuzzyScore(name, needle) {
  const n = name.toLowerCase(), q = needle.toLowerCase();
  if (n === q) return 100;
  if (n.includes(q) || q.includes(n)) return 80;
  const qWords = q.split(/\s+/);
  const nWords = n.split(/[\s\-_/]+/);
  const hits = qWords.filter(w => nWords.some(nw => nw.startsWith(w) || w.startsWith(nw)));
  return Math.round((hits.length / qWords.length) * 60);
}

async function quickClick(tabId, target, onStep) {
  onStep({ type: 'step', text: `Looking for "${target}"…` });
  let snapshot;
  try { snapshot = await getSnapshot(tabId); } catch { return null; }

  const lines = (snapshot.text || '').split('\n');
  let best = null, bestScore = 0;
  for (const line of lines) {
    const m = line.match(/^\[(\d+)\][^"]*"([^"]+)"/);
    if (!m) continue;
    const score = fuzzyScore(m[2], target);
    if (score > bestScore) { bestScore = score; best = { idx: parseInt(m[1]), name: m[2] }; }
  }

  if (!best || bestScore < 35) return null; // not found — caller falls back to agent loop

  onStep({ type: 'step', text: `Clicking "${best.name}"…` });
  const result = await sendAction(tabId, { action: 'click', index: best.idx });
  if (!result?.success) return null;

  await new Promise(r => setTimeout(r, 800));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.status === 'loading') await waitForTabLoad(tab.id);
  return { success: true, message: `Clicked "${best.name}"` };
}

// ── Agent loop ────────────────────────────────────────────────────────────────
let _abortLoop = false;

async function runAgentLoop(tabId, goal, onStep) {
  _abortLoop = false;
  const history = [];
  const MAX = 25;
  let prevSnapshotSig = '';
  let sameSnapshotCount = 0;

  for (let step = 1; step <= MAX; step++) {
    if (_abortLoop) return { success: false, message: 'Stopped by user.' };
    onStep({ type: 'step', text: `Step ${step}: reading page…` });

    // Brief settle before snapshot
    await new Promise(r => setTimeout(r, 400));

    // Snapshot
    let snapshot;
    try {
      snapshot = await getSnapshot(tabId);
    } catch (err) {
      // Content script may have been unloaded by navigation — wait and retry once
      await new Promise(r => setTimeout(r, 1200));
      try { snapshot = await getSnapshot(tabId); }
      catch (e2) { return { success: false, message: `Cannot read page: ${e2.message}` }; }
    }

    // Stuck detection: if snapshot unchanged twice, inject a scroll to shake things loose
    const sig = snapshot.text.slice(0, 300);
    if (sig === prevSnapshotSig) {
      sameSnapshotCount++;
      if (sameSnapshotCount >= 2) {
        onStep({ type: 'step', text: `Step ${step}: page unchanged — scrolling to find more…` });
        await sendAction(tabId, { action: 'scroll', direction: 'down', amount: 500 });
        await new Promise(r => setTimeout(r, 800));
        sameSnapshotCount = 0;
        try { snapshot = await getSnapshot(tabId); } catch {}
      }
    } else {
      sameSnapshotCount = 0;
      prevSnapshotSig = sig;
    }

    // Screenshot
    const screenshot = await takeScreenshot();

    // GPT
    onStep({ type: 'step', text: `Step ${step}: thinking…` });
    let action;
    try {
      action = await getNextStep(goal, snapshot.text, screenshot, history);
    } catch (err) {
      return { success: false, message: `GPT error: ${err.message}` };
    }

    const desc = action.description || action.action;
    onStep({ type: 'step', text: `Step ${step}: ${desc}` });

    if (action.action === 'done')   return { success: true,  message: action.message };
    if (action.action === 'failed') return { success: false, message: action.message };

    // Action key (stable — not description which GPT varies every turn)
    const actionKey = `${action.action}:${action.index ?? `${action.x ?? ''},${action.y ?? ''}`}`;

    // ── Single-action repeat guard ────────────────────────────────────────
    const recentKeys = history.map(h => h.split('||')[1]).filter(Boolean);
    const repeatCount = recentKeys.slice(-4).filter(k => k === actionKey).length;
    if (repeatCount >= 2 && (action.action === 'click' || action.action === 'click_xy')) {
      const coordLine = snapshot.text.split('\n')
        .find(l => action.index != null ? l.trimStart().startsWith(`[${action.index}]`) : false);
      const cm = coordLine?.match(/@\((\d+),(\d+)\)/);
      if (cm) {
        const fx = +cm[1], fy = +cm[2];
        onStep({ type: 'step', text: `Step ${step}: click unresponsive — forcing coordinate click at (${fx},${fy})…` });
        await sendAction(tabId, { action: 'click_xy', x: fx, y: fy });
        history.push(`coord fallback (${fx},${fy})||click_xy:${fx},${fy}`);
        await new Promise(r => setTimeout(r, 1500));
        const [t2] = await chrome.tabs.query({ active: true, currentWindow: true });
        if (t2?.status === 'loading') await waitForTabLoad(t2.id);
        prevSnapshotSig = '';
        continue;
      }
    }

    // ── Cycle detection (e.g. A→B→C repeating) ───────────────────────────
    if (recentKeys.length >= 6) {
      for (const cycleLen of [2, 3]) {
        const tail = recentKeys.slice(-cycleLen * 2);
        if (tail.length === cycleLen * 2 &&
            tail.slice(0, cycleLen).join() === tail.slice(cycleLen).join()) {
          return { success: false, message: `Stuck in a ${cycleLen}-step loop. The clicks are not changing the page. Please navigate manually or try a different command.` };
        }
      }
    }

    // Navigate: use chrome.tabs.update (content script can't navigate cross-origin)
    if (action.action === 'navigate') {
      await chrome.tabs.update(tabId, { url: action.url });
      onStep({ type: 'step', text: `Step ${step}: loading page…` });
      await waitForTabLoad(tabId);
      history.push(`navigate → ${action.url}`);
      prevSnapshotSig = '';
      continue;
    }

    // All other actions → content script
    let result = { success: false, message: 'no response' };
    try {
      result = await sendAction(tabId, action);
    } catch (err) {
      result = { success: false, message: err.message };
    }

    history.push(`${desc}: ${result?.success ? 'ok' : result?.message || '?'}||${actionKey}`);
    if (_abortLoop) return { success: false, message: 'Stopped by user.' };

    // Smart wait: clicks/press may open modals or trigger navigation — wait for DOM to settle
    const isNavAction = ['click','click_xy','press_on','press','select'].includes(action.action);
    await new Promise(r => setTimeout(r, isNavAction ? 1200 : 400));

    // Check if page is loading after action
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.status === 'loading') {
      onStep({ type: 'step', text: `Step ${step}: waiting for page…` });
      await waitForTabLoad(tab.id);
      prevSnapshotSig = '';
    }
  }

  return { success: false, message: 'Reached max steps. Goal may be partially complete.' };
}

// ── Top-level command runner ──────────────────────────────────────────────────
const _cmdHistory = [];
function pushHistory(t) { _cmdHistory.push(t); if (_cmdHistory.length > 5) _cmdHistory.shift(); }
function getContext()    { return _cmdHistory.slice(-3).map((c, i) => `${i+1}. "${c}"`).join('\n'); }

async function runCommand(text, onStep) {
  const norm   = normalizeText(text.trim());
  const ctx    = getContext();
  pushHistory(norm);

  onStep({ type: 'step', text: `Parsing: "${norm}"` });

  const intent = await parseIntent(norm, ctx);
  onStep({ type: 'step', text: `Intent: ${intent.action}` });

  const tabId = await getActiveTabId();
  if (!tabId) return { success: false, message: 'No active browser tab.' };

  switch (intent.action) {
    case 'click_element': {
      const target = intent.params?.target || norm;
      const r = await quickClick(tabId, target, onStep);
      if (r) return r;
      // Not found on first glance — fall back to agent loop
      return runAgentLoop(tabId, `Click on "${target}"`, onStep);
    }

    case 'navigate': {
      await chrome.tabs.update(tabId, { url: intent.params.url });
      await waitForTabLoad(tabId);
      return { success: true, message: `Navigated to ${intent.params.url}` };
    }

    case 'scroll_act': {
      const dir = intent.params.direction || 'down';
      await sendAction(tabId, { action: 'scroll', direction: dir, amount: 400 });
      return { success: true, message: `Scrolled ${dir}` };
    }

    case 'media_act': {
      const op = intent.params.operation || 'toggle';
      const scripts = {
        pause:       `document.querySelectorAll('video,audio').forEach(v=>v.pause())`,
        play:        `document.querySelectorAll('video,audio').forEach(v=>v.play())`,
        toggle:      `document.querySelectorAll('video,audio').forEach(v=>v.paused?v.play():v.pause())`,
        mute:        `document.querySelectorAll('video,audio').forEach(v=>v.muted=true)`,
        unmute:      `document.querySelectorAll('video,audio').forEach(v=>v.muted=false)`,
        volume_up:   `document.querySelectorAll('video,audio').forEach(v=>v.volume=Math.min(1,v.volume+0.1))`,
        volume_down: `document.querySelectorAll('video,audio').forEach(v=>v.volume=Math.max(0,v.volume-0.1))`,
      };
      if (scripts[op]) await sendAction(tabId, { action: 'evaluate', script: scripts[op] });
      return { success: true, message: `Media: ${op}` };
    }

    case 'fill_input':
      return runAgentLoop(tabId,
        `Fill the ${intent.params.field} field with "${intent.params.value}"`, onStep);

    default:
      return runAgentLoop(tabId, intent.params?.command || norm, onStep);
  }
}

// ── UI logic ──────────────────────────────────────────────────────────────────
const micBtn      = document.getElementById('micBtn');
const micIcon     = document.getElementById('micIcon');
const micLabel    = document.getElementById('micLabel');
const statusDot   = document.getElementById('statusDot');
const statusText  = document.getElementById('statusText');
const transcriptEl= document.getElementById('transcriptEl');
const stepsArea   = document.getElementById('stepsArea');
const textInput   = document.getElementById('textInput');
const sendBtn     = document.getElementById('sendBtn');
const apiWarning  = document.getElementById('apiWarning');
const settingsBtn = document.getElementById('settingsBtn');

function setStatus(state, text) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = text;
}

function addStep(text, type = 'active') {
  // Remove 'active' class from previous last step
  const prev = stepsArea.querySelector('.step-item.active');
  if (prev) prev.classList.replace('active', 'done');

  const el = document.createElement('div');
  el.className = `step-item ${type}`;
  const icon = type === 'success' ? '✓' : type === 'error' ? '✗' : '→';
  el.innerHTML = `<span class="step-icon">${icon}</span>${text}`;
  stepsArea.appendChild(el);
  stepsArea.scrollTop = stepsArea.scrollHeight;
  return el;
}

function clearSteps() { stepsArea.innerHTML = ''; }

let _lastStepEl = null;

function onStep(info) {
  if (_lastStepEl) _lastStepEl.classList.remove('active');
  _lastStepEl = addStep(info.text, 'active');
}

let _isRunning = false;

async function submitCommand(text) {
  if (!text.trim()) return;
  if (_isRunning) { addStep('Already running — stop first.', 'error'); return; }
  _isRunning = true;
  _abortLoop = false;
  clearSteps();
  transcriptEl.textContent = text;
  transcriptEl.className = 'transcript-text';
  setStatus('running', 'Running…');
  micBtn.classList.add('disabled');
  micBtn.disabled = true;
  sendBtn.textContent = '■';
  sendBtn.title = 'Stop';
  textInput.disabled = true;

  try {
    const result = await runCommand(text, onStep);
    if (_lastStepEl) {
      _lastStepEl.classList.remove('active');
      _lastStepEl.classList.add(result.success ? 'success' : 'error');
    }
    addStep(result.message || (result.success ? 'Done.' : 'Failed.'),
      result.success ? 'success' : 'error');
    setStatus('ready', result.success ? 'Ready' : 'Failed');
  } catch (err) {
    if (_abortLoop) {
      addStep('Stopped.', 'error');
      setStatus('ready', 'Ready');
    } else {
      addStep(`Error: ${err.message}`, 'error');
      setStatus('error', 'Error');
    }
  } finally {
    _isRunning = false;
    micBtn.classList.remove('disabled');
    micBtn.disabled = false;
    sendBtn.textContent = '↵';
    sendBtn.title = '';
    textInput.disabled = false;
  }
}

// ── Voice — runs in the active tab's content script (normal page context)
// The extension sidepanel cannot use mic directly; content scripts can.

let isRecording  = false;
let _finalText   = '';

function resetMicBtn() {
  micBtn.classList.remove('listening');
  micIcon.textContent  = '🎤';
  micLabel.textContent = 'Hold to speak';
}

async function getActiveTabId() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

async function startRecording() {
  if (isRecording) return;
  const tabId = await getActiveTabId();
  if (!tabId) { addStep('No active tab found.', 'error'); return; }
  // Ensure content script is injected
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
  } catch {}
  const res = await chrome.tabs.sendMessage(tabId, { type: 'START_SPEECH' }).catch(e => ({ success: false, message: e.message }));
  if (!res?.success) {
    addStep(res?.message === 'no-api' ? 'Web Speech API not available in this tab.' : `Mic error: ${res?.message}`, 'error');
    return;
  }
  isRecording = true;
  _finalText  = '';
  micBtn.classList.add('listening');
  micIcon.textContent  = '⏹';
  micLabel.textContent = 'Release to send';
  setStatus('running', 'Listening…');
  transcriptEl.textContent = '…';
  transcriptEl.className   = 'transcript-text interim';
}

async function stopRecording() {
  if (!isRecording) return;
  const tabId = await getActiveTabId();
  if (tabId) await chrome.tabs.sendMessage(tabId, { type: 'STOP_SPEECH' }).catch(() => {});
}

// Receive speech events from content script
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'SPEECH_INTERIM') {
    transcriptEl.textContent = msg.text || '…';
    transcriptEl.className   = 'transcript-text interim';
    if (msg.text) _finalText = msg.text;
  } else if (msg.type === 'SPEECH_ERROR') {
    isRecording = false;
    resetMicBtn();
    if (msg.error === 'not-allowed') {
      addStep('Mic blocked — allow microphone for this site when Chrome asks.', 'error');
      setStatus('error', 'Mic blocked');
    } else if (msg.error !== 'no-speech') {
      addStep(`Speech error: ${msg.error}`, 'error');
      setStatus('error', msg.error);
    } else {
      setStatus('ready', 'Ready');
    }
  } else if (msg.type === 'SPEECH_END') {
    isRecording = false;
    resetMicBtn();
    const text = (_finalText || transcriptEl.textContent).trim();
    if (text && text !== '…' && text !== '—') {
      transcriptEl.className = 'transcript-text';
      submitCommand(text);
    } else {
      setStatus('ready', 'Ready');
      transcriptEl.textContent = '—';
      transcriptEl.className   = 'transcript-text';
    }
    _finalText = '';
  }
});

// Hold to record
micBtn.addEventListener('mousedown', () => {
  if (micBtn.classList.contains('disabled')) return;
  startRecording();
});

micBtn.addEventListener('mouseup', () => {
  stopRecording();
});

// Touch support
micBtn.addEventListener('touchstart', e => { e.preventDefault(); micBtn.dispatchEvent(new MouseEvent('mousedown')); });
micBtn.addEventListener('touchend',   e => { e.preventDefault(); micBtn.dispatchEvent(new MouseEvent('mouseup')); });

// Text input / Stop button
sendBtn.addEventListener('click', () => {
  if (_isRunning) { _abortLoop = true; return; }
  const t = textInput.value.trim();
  if (t) { textInput.value = ''; submitCommand(t); }
});
textInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') sendBtn.click();
});

// Settings + Refresh
settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('openOptionsLink')?.addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('refreshBtn').addEventListener('click', () => {
  chrome.runtime.reload();
});

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const key = await getApiKey();
  if (!key) {
    apiWarning.style.display = 'block';
    setStatus('error', 'API key missing — click ⚙️');
  } else {
    apiWarning.style.display = 'none';
    setStatus('ready', 'Ready');
  }
  if (!hasSpeechAPI) {
    addStep('Web Speech API not found. Use Chrome for voice input.', 'error');
  }
}

init();
