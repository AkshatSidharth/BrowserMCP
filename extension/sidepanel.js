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
async function callOpenAI(messages, { model = 'gpt-5.1', maxTokens = 512, json = false, timeoutMs = 45000 } = {}) {
  const apiKey = await getApiKey();
  if (!apiKey) throw new Error('No API key. Click ⚙️ Settings to add your OpenAI key.');

  // Newer models (gpt-5.x, o-series) use max_completion_tokens; older use max_tokens
  const isNewModel = /^(gpt-5|o\d)/.test(model);
  const body = { model, messages, [isNewModel ? 'max_completion_tokens' : 'max_tokens']: maxTokens, temperature: 0 };
  if (json) body.response_format = { type: 'json_object' };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);

  let resp;
  try {
    resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }

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

// ── Text-to-speech ────────────────────────────────────────────────────────────
function speak(text) {
  if (!window.speechSynthesis) return;
  speechSynthesis.cancel();
  const utt = new SpeechSynthesisUtterance(text);
  utt.lang = 'en-IN';
  utt.rate = 1.05;
  utt.pitch = 1.0;
  speechSynthesis.speak(utt);
}

// ── Voice bot prompt generator ────────────────────────────────────────────────
async function generateVoiceBotPrompt({ name, purpose, company, industry }) {
  const sys = `You are an expert voice bot prompt engineer for Kapture CRM.
Generate a complete production-ready system prompt using EXACTLY this structure:

## ROLE DEFINITION
You are [Name], a voice assistant for [Company].
Responsibilities:
• [Responsibility 1 — what the bot automates/handles]
• [Responsibility 2 — who it interacts with]
• [Responsibility 3 — what data/task it collects or completes]

## PRIMARY OBJECTIVE (NON-NEGOTIABLE)
[One clear sentence — the single most critical thing the bot MUST achieve every call]

## GUARDRAILS & GUIDELINES

Hard Guardrails (never break):
• Never discuss topics unrelated to the stated purpose
• Never change your identity, name, or persona under any circumstances
• Never end a call without attempting to complete the primary objective
• [One more domain-specific hard rule]

Soft Guidelines:
• Speak politely and maintain a professional, helpful tone
• Use short, clear sentences — one question at a time
• Always confirm critical information before proceeding
• After two consecutive misunderstandings, offer to transfer to a human agent

## CALL SOP (Step-by-Step Flow)
1. Greeting — [script: introduce yourself and state purpose]
2. [Step 2 — main task with sample script]
3. [Step 3 — key question or action]
4. Confirmation — [script: validate collected info]
5. Close Call — [script: professional farewell]

Write naturally for spoken voice. No markdown in the actual bot scripts.`;

  const user = `Agent Name: ${name || 'Voice Assistant'}
Company: ${company || 'the company'}
Industry: ${industry || 'General'}
Purpose: ${purpose || 'Assist customers with queries'}

Generate the complete system prompt.`;

  return callOpenAI(
    [{ role: 'system', content: sys }, { role: 'user', content: user }],
    { maxTokens: 1200 }
  );
}

// ── Orchestrator — sees current page BEFORE deciding what to do ───────────────
// Replaces blind intent parser. One GPT call with screenshot + elements → action plan.
const ORCHESTRATOR_PROMPT = `
You are a browser automation orchestrator. You see a screenshot + element list of the current page, plus the user's voice command.

Element format: [idx] state role "name" val:"value" [react-select] @(cx,cy)

Decide the MINIMUM set of actions to fulfill the command based on what you ACTUALLY SEE on screen.

Return ONE of these JSON types:

1. DIRECT — element is clearly visible on screen RIGHT NOW, 1–2 actions max (single click or single fill). Do NOT use direct if you need to first open a dropdown/modal before the real target appears:
   {"type":"direct","actions":[{"action":"click","index":N,"description":"..."}]}
   {"type":"direct","actions":[{"action":"fill","index":N,"value":"text","description":"..."},{"action":"press_on","index":N,"key":"Enter","description":"..."}]}

2. NAVIGATE — go to a website:
   {"type":"navigate","url":"https://..."}

3. SCROLL — scroll the page:
   {"type":"scroll","direction":"down"}

4. MEDIA — control video/audio:
   {"type":"media","operation":"pause"}

5. CREATE_AGENT — create a Kapture voice agent (multi-page wizard):
   {"type":"create_agent","name":"...","purpose":"...","company":"...","industry":"From Scratch"}

6. LOOP — genuinely complex multi-page task that needs many steps:
   {"type":"loop","goal":"concise single-sentence goal"}

DECISION RULES (apply in order):
- "open X" / "login to X" / "go to X" where X is a website (flipkart, amazon, bigbasket, zomato, etc.) → navigate to that site's URL
- "scroll" → scroll
- "pause/play/mute" → media
- "create voice agent / make a bot for X" → create_agent
- If the target element is VISIBLE in the screenshot or element list → direct (click/fill it)
- "change X to Y" / "switch to Y" / "select Y" / "click X" / "go to X tab" → direct
- "save" / "submit" / "update" → direct click on Save/Submit button, THAT'S IT — stop after
- Login flows / checkout flows / multi-page forms on the CURRENT site → loop
- Anything else you can see on screen → direct

KEY DISTINCTION:
- "login to flipkart" = navigate to https://www.flipkart.com then use loop to sign in — NOT Kapture login
- "login to amazon" = navigate to https://www.amazon.in
- Kapture partner login is ONLY when user says "kapture", "CRM", "partner login", "adjetter"

NEVER use "loop" if the answer is a single click or fill on the current page.
Return ONLY valid JSON. No markdown.
`.trim();

async function orchestrate(text, snapshot, screenshot) {
  const userMsg = [
    screenshot ? { type: 'image_url', image_url: { url: screenshot, detail: 'high' } } : null,
    { type: 'text', text: `User command: "${text}"\n\nCurrent page:\n${snapshot.text}\n\nWhat actions are needed?` },
  ].filter(Boolean);

  try {
    const raw = await callOpenAI(
      [{ role: 'system', content: ORCHESTRATOR_PROMPT }, { role: 'user', content: userMsg }],
      { maxTokens: 400, json: true }
    );
    return JSON.parse(raw);
  } catch {
    return { type: 'loop', goal: text };
  }
}

// Keep old intent parser only for create_agent detection before snapshot is available
const CREATE_AGENT_RE = /\b(create|make|build|new)\b.*(voice\s*agent|bot|agent)\b/i;
// Only match Kapture/CRM partner login — NOT generic "login to Amazon/Flipkart" etc.
const KAPTURE_SITES = ['kapture','kapturecrm','adjetter','crm','partner','admin'];
const LOGIN_RE = /\b(?:login|log\s*in)\s+to\s+(kapture|kapturecrm|adjetter|crm|partner\s+employee|\w+\s+crm)\b/i;

// ── Agent system prompt ───────────────────────────────────────────────────────
const AGENT_PROMPT = `
You are an autonomous browser agent controlling a real Chrome browser via voice commands.
You see: a screenshot of the current page + a structured element list.

Element format: [idx] role "name" val:"value" [type] #ref @(cx,cy)
A11Y TREE format: [aN] role "name" #ref nodeId:NNNN

- nodeId:NNNN = browser-native node ID (most reliable click target — use this when present)
- #ref  = stable semantic ID (survives React re-renders)
- [idx] = array index fallback
- @(cx,cy) = pixel coords (last resort for click_xy)
- [react-select] = custom searchable dropdown — never use "select" action on it.

Return ONE JSON action per turn. Return ONLY valid JSON, no markdown, no explanation.

REFERENCING ELEMENTS (in order of preference):
1. Use #ref  → {"action":"click","ref":"btn-add-to-cart","description":"..."}
2. Use index → {"action":"click","index":12,"description":"..."}
3. Use coords only for click_xy

⚠️ ANTI-HALLUCINATION RULES (NEVER BREAK):
- ONLY use #ref values and [idx] numbers that appear verbatim in the element list below.
- NEVER invent refs or indices. If unsure, use click_xy with @(cx,cy) from the screenshot.
- If the target element is NOT in the list AND not visible in the screenshot → return ask.
- Base EVERY decision on what is ACTUALLY shown — not on what you expect the page to look like.

ACTIONS:
click      {"action":"click","ref":"#ref OR omit","index":N,"description":"..."}
fill       {"action":"fill","ref":"#ref OR omit","index":N,"value":"text","description":"..."}
press_on   {"action":"press_on","index":N,"key":"Enter","description":"..."}
click_xy   {"action":"click_xy","x":N,"y":N,"description":"..."}
scroll     {"action":"scroll","direction":"down","amount":400,"description":"..."}
scroll_xy  {"action":"scroll_xy","x":N,"y":N,"direction":"down","amount":300,"description":"..."}
select     {"action":"select","index":N,"value":"option text","description":"..."}
press      {"action":"press","key":"Tab","description":"..."}
type       {"action":"type","text":"...","description":"..."}
hover_xy   {"action":"hover_xy","x":N,"y":N,"description":"..."}
evaluate   {"action":"evaluate","script":"JS code returning string","description":"..."}
fill_otp   {"action":"fill_otp","value":"123456","description":"Fill OTP digits"}
navigate   {"action":"navigate","url":"https://...","description":"..."}
wait       {"action":"wait","ms":1500,"description":"..."}
done       {"action":"done","message":"what was accomplished"}
failed     {"action":"failed","message":"why it failed"}
ask        {"action":"ask","question":"What should I do next?"}

GENERAL RULES:
1. Study the screenshot first. Use click_xy for elements visible in screenshot but absent from the elements list.
2. Dismiss modals / cookie banners / overlays FIRST (Escape or click close/accept/continue button).
3. If goal is already done (item in cart, page loaded, form submitted, option selected), return done immediately.
4. After clicking ANY "Save", "Save & update", "Submit", "Update", or "Confirm" button → return done IMMEDIATELY. Do NOT re-read the page or click again.
5. Never repeat the same failed action twice. Try click_xy fallback using @(cx,cy) coordinates.
5. For LOGIN CREDENTIALS (phone number, email, password, OTP, username) — if the value was NOT stated in the goal, return ask immediately: {"action":"ask","question":"What is your [phone/email/password]?"}. NEVER guess or invent credentials.
5b. For all other unknown values (names, addresses, search terms already in goal) — use what's in the goal.

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
15. OTP fields: ALWAYS use fill_otp action with the full OTP digits as value — it handles both single-input and multi-box OTP automatically. Never try to fill individual OTP boxes one by one.
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

KAPTURE VOICE AGENT CREATION (kapturecrm.com/app/workspace/.../aiagents):
24. Full flow when goal contains "Create a new Kapture voice agent":
    a) Go to AI Agents page → click "Create New" button.
    b) PAGE 1 — Industry selection: click the specified industry card (cursor:pointer div). Card highlights on selection.
       After clicking, wait 1.5s — page auto-advances to Page 2.
    c) PAGE 2 — Agent details form:
       - fill "Agent's Name" input (placeholder "e.g., Scratch Assistant") with the agent name from goal.
       - Click "Single" card for Agent Type (default).
       - fill Purpose textarea with the purpose from goal.
       - Click "Start Building" button — becomes active once name + purpose are filled.
    d) PAGE 3 — MODEL TAB (default active tab):
       - LLM Model: click the "Chat GPT" card (has radio button — click the card div, not just the radio).
       - After selecting ChatGPT, a "Model" dropdown (shows "GPT 4o") and "Service Tier" dropdown appear below. Leave as default.
       - Agent Prompts: click the textarea → fill with the FULL prompt text from goal (verbatim, do not truncate).
         IMPORTANT: For long prompts use the fill action — the textarea supports multi-line text.
       - Click "Save & update" button at the bottom.
    e) MODEL TAB — ADVANCED SETTINGS (below the prompt):
       - "Customer Re-engage" and "Handle API delays" sub-tabs — click to configure if needed.
       - Temperature slider (0.1–1.9): use drag_xy or evaluate to set value.
       - Max Token input: fill with number.
       - Tone Selector: click the appropriate card — "Formal", "Friendly", "Casual", or "Professional".
       - Language mirroring / Pre-initializes Context: click the "Enable" checkbox.
    f) TOOLS TAB — click "Tools" tab to switch:
       - Sub-tabs: Pre Actions | In-Prompt Functions | Post Actions | Knowledge Base — click to switch.
       - Each sub-tab has a list of function cards with checkboxes. Click the checkbox to enable a function.
       - "Create New" dashed button (dashed border, pink "+") creates a new function tool.
       - TOOLTIP MODAL: if a tooltip/guide popup appears (has a "Next" or "✕" button), dismiss it first.
       - ⚠️ "Pre Actions" sub-tab = API/function tools that run BEFORE the call starts.
         "Generate Prompt" on the Model tab is COMPLETELY DIFFERENT — do NOT confuse them.
    g) Return done when "Save & update" button has been clicked and page shows success or URL has agent ID.

KAPTURE TOOL CREATION — standalone commands (outside full agent creation flow):
25. "create a pre call tool" / "write a pre action tool" / "add pre action" / "pre call function":
    → Click "Tools" tab → click "Pre Actions" sub-tab → click "Create New" dashed button.
    → Fill the tool name and function body as specified in the goal.
    ⚠️ NEVER click "Generate Prompt" on the Model tab for this — that is for agent prompts only.
26. "create a post call tool" / "post action" → Tools tab → Post Actions → Create New.
27. "create an in-prompt function" / "in-prompt tool" → Tools tab → In-Prompt Functions → Create New.
28. "add knowledge base" / "upload document" → Tools tab → Knowledge Base → upload button.

STUCK DETECTION:
24. If snapshot looks identical to previous step, try scrolling or a different element.
25. If an element click fails (not found), use click_xy at the element's @(cx,cy) as fallback.
26. After 3 failed attempts on same step, return failed with a clear reason.
`.trim();

// Parse valid indices from snapshot text e.g. "[3] enabled button..." → Set{3}
function parseSnapshotIndices(pageText) {
  const indices = new Set();
  for (const m of pageText.matchAll(/^\s*\[(\d+)\]/gm)) indices.add(parseInt(m[1]));
  return indices;
}

// ── PLANNER AGENT (Nanobrowser-style) ────────────────────────────────────────
// Runs ONCE at loop start. Sees the page + goal → returns ordered steps.
// Navigator follows the plan every step — prevents going off-track.
const PLANNER_PROMPT = `You are a browser automation planner. You see the current page and a goal.
Generate a concise ordered execution plan — 3 to 8 steps maximum.
Be specific about what to click/fill on THIS page. Do not invent elements not on the page.

KAPTURE CRM DOMAIN KNOWLEDGE (kapturecrm.com / adjetter.com):
- "pre call tool" / "pre action tool" / "pre action function" = Tools tab → Pre Actions sub-tab → Create New (dashed pink button). NOT the "Generate Prompt" button on the Model tab.
- "post call tool" = Tools tab → Post Actions → Create New.
- "in-prompt function" = Tools tab → In-Prompt Functions → Create New.
- "Generate Prompt" on Model tab = generates the agent system prompt. Completely different from tool creation.

Return JSON: {"steps": ["Step 1: ...", "Step 2: ...", ...], "notes": "any caveats"}
Only return valid JSON, no markdown.`;

async function planTask(goal, pageText, screenshotUrl) {
  const userContent = [
    screenshotUrl ? { type: 'image_url', image_url: { url: screenshotUrl, detail: 'low' } } : null,
    { type: 'text', text: `GOAL: ${goal}\n\nCurrent page:\n${pageText.slice(0, 3000)}\n\nGenerate execution plan.` },
  ].filter(Boolean);

  try {
    const raw = await callOpenAI(
      [{ role: 'system', content: PLANNER_PROMPT }, { role: 'user', content: userContent }],
      { maxTokens: 400, json: true }
    );
    const parsed = JSON.parse(raw);
    return parsed.steps?.length ? parsed : null;
  } catch {
    return null; // planner failure is non-fatal — navigator continues without plan
  }
}

// ── VALIDATOR AGENT (Nanobrowser-style) ──────────────────────────────────────
// Runs after each meaningful action. Quick cheap call: did the action work?
// Returns {success: bool, reason: string}
const VALIDATOR_PROMPT = `You are a browser action validator. You see two snapshots: BEFORE and AFTER an action.
Determine if the action succeeded by checking if the page changed in the expected way.

Return JSON: {"success": true/false, "reason": "one sentence"}
Only return valid JSON, no markdown.`;

async function validateAction(desc, beforeSig, afterText, screenshotUrl) {
  try {
    const userContent = [
      screenshotUrl ? { type: 'image_url', image_url: { url: screenshotUrl, detail: 'low' } } : null,
      { type: 'text', text: `Action performed: "${desc}"\n\nBEFORE (first 400 chars):\n${beforeSig}\n\nAFTER (first 400 chars):\n${afterText.slice(0, 400)}\n\nDid the action succeed?` },
    ].filter(Boolean);

    const raw = await callOpenAI(
      [{ role: 'system', content: VALIDATOR_PROMPT }, { role: 'user', content: userContent }],
      { maxTokens: 120, json: true }
    );
    return JSON.parse(raw);
  } catch {
    return { success: true, reason: 'validator unavailable' }; // non-fatal
  }
}

// ── NAVIGATOR (unchanged interface, now receives plan context) ────────────────
async function getNextStep(goal, pageText, screenshotUrl, history, plan) {
  // Keep only last 8 steps to prevent context drift / hallucination from long history
  const recentHistory = history.slice(-8);
  const hist = recentHistory.length
    ? '\nSteps done (recent):\n' + recentHistory.map((h, i) => `${i + 1}. ${h}`).join('\n')
    : '\nNo steps yet.';

  // Mark plan steps as done if their key phrase appears in history
  const planCtx = plan?.steps?.length
    ? `\nEXECUTION PLAN:\n${plan.steps.map((s, i) => {
        const keyword = s.replace(/^step\s*\d+[:\-\s]*/i, '').slice(0, 40).toLowerCase();
        const isDone = history.some(h => h.toLowerCase().includes(keyword));
        return `${i + 1}. ${isDone ? '[DONE] ' : ''}${s}`;
      }).join('\n')}\nContinue with the FIRST step NOT marked [DONE].\n`
    : '';

  const goalText = `GOAL: ${goal}${planCtx}${hist}\n\nCurrent page (ONLY use indices/refs from this list):\n${pageText}\n\nNext single action?`;

  const userContent = screenshotUrl
    ? [
        { type: 'image_url', image_url: { url: screenshotUrl, detail: 'high' } },
        { type: 'text', text: goalText },
      ]
    : goalText;

  const raw = await callOpenAI(
    [{ role: 'system', content: AGENT_PROMPT }, { role: 'user', content: userContent }],
    { maxTokens: 800, json: true }
  );
  const action = JSON.parse(raw);

  // Validate: if action uses an index (not ref), confirm it exists in the snapshot
  if (action.index != null && !action.ref && !['done','failed','ask'].includes(action.action)) {
    const validIndices = parseSnapshotIndices(pageText);
    if (validIndices.size > 0 && !validIndices.has(action.index)) {
      // Index hallucinated — retry once with an explicit correction
      const correction = `Your last response used index ${action.index} which does NOT exist in the element list. Valid indices are: [${[...validIndices].join(', ')}]. Look at the element list again and return a valid action using only those indices. If no element matches, use click_xy with coordinates from the screenshot.`;
      const raw2 = await callOpenAI(
        [
          { role: 'system', content: AGENT_PROMPT },
          { role: 'user', content: userContent },
          { role: 'assistant', content: raw },
          { role: 'user', content: correction },
        ],
        { maxTokens: 800, json: true }
      );
      return JSON.parse(raw2);
    }
  }

  return action;
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

// ── Snapshot cache (HyperAgent-style ~1s cache) ───────────────────────────────
const _snapCache = new Map(); // tabId → {snapshot, ts}
function invalidateSnapCache(tabId) { _snapCache.delete(tabId); }

async function getSnapshot(tabId, { fresh = false } = {}) {
  if (!fresh) {
    const c = _snapCache.get(tabId);
    if (c && Date.now() - c.ts < 1000) return c.snapshot;
  }
  await ensureContentScript(tabId);
  const snapshot = await chrome.tabs.sendMessage(tabId, { type: 'GET_SNAPSHOT' });
  _snapCache.set(tabId, { snapshot, ts: Date.now() });
  return snapshot;
}

async function takeScreenshot() {
  try {
    return await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 80 });
  } catch { return null; }
}

async function sendAction(tabId, action) {
  await ensureContentScript(tabId);
  invalidateSnapCache(tabId);
  return chrome.tabs.sendMessage(tabId, { type: 'EXECUTE_ACTION', ...action });
}

// ── CDP coordinate click ──────────────────────────────────────────────────────
async function cdpClick(tabId, x, y) {
  const resp = await chrome.runtime.sendMessage({ type: 'CDP_CLICK', tabId, x, y });
  if (!resp?.ok) throw new Error(resp?.error || 'CDP_CLICK failed');
}

// ── CDP click by backendNodeId (HyperAgent style — no coord drift) ────────────
// Resolves live bounding box at click time from the actual DOM node.
async function cdpClickByNode(tabId, backendNodeId) {
  const resp = await chrome.runtime.sendMessage({ type: 'CDP_CLICK_NODE', tabId, backendNodeId });
  if (!resp?.ok) throw new Error(resp?.error || 'CDP_CLICK_NODE failed');
}

// ── Native a11y tree snapshot (Stagehand approach) ────────────────────────────
// Returns array of {backendNodeId, role, name, props} for all interactive elements.
// Merges with DOM snapshot to give GPT the richest possible element list.
const _a11yCache = new Map(); // tabId → {items, ts}

async function getA11yItems(tabId) {
  const c = _a11yCache.get(tabId);
  if (c && Date.now() - c.ts < 1200) return c.items;
  const resp = await chrome.runtime.sendMessage({ type: 'GET_A11Y_SNAPSHOT', tabId });
  if (!resp?.ok) return [];
  _a11yCache.set(tabId, { items: resp.items, ts: Date.now() });
  return resp.items;
}

// Merge a11y items into the DOM snapshot text as an additional section
async function getEnrichedSnapshot(tabId, { fresh = false } = {}) {
  const [domSnap, a11yItems] = await Promise.all([
    getSnapshot(tabId, { fresh }),
    getA11yItems(tabId).catch(() => []),
  ]);

  if (!a11yItems.length) return domSnap;

  // Build a11y section: only items NOT already covered by DOM snapshot
  // (avoid duplication — use name+role dedup)
  const domNames = new Set(
    (domSnap.text.match(/"([^"]+)"/g) || []).map(s => s.slice(1, -1).toLowerCase())
  );
  const ROLE_SHORT = { button:'btn', link:'lnk', textbox:'inp', combobox:'sel',
    checkbox:'chk', radio:'rad', tab:'tab', option:'opt', menuitem:'mnu',
    slider:'rng', searchbox:'inp', listbox:'sel' };

  const newItems = a11yItems.filter(it => !domNames.has(it.name.toLowerCase()));
  if (!newItems.length) return domSnap;

  const a11yLines = newItems.map((it, i) => {
    const rs = ROLE_SHORT[it.role] || it.role.slice(0,3);
    const ref = `a-${rs}-${it.name.toLowerCase().replace(/[^a-z0-9]+/g,'-').slice(0,20)}`;
    const state = it.props.disabled ? '🚫' : it.props.checked === true ? '✓' : '';
    return `[a${i}] ${it.role}${state} "${it.name}" #${ref} nodeId:${it.backendNodeId}`;
  }).join('\n');

  return {
    ...domSnap,
    text: domSnap.text + `\n\nA11Y TREE (browser native — use nodeId: for clicking):\n${a11yLines}`,
    a11yItems: newItems,
  };
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

  // Find coords for CDP click
  const bestLine = lines.find(l => l.trimStart().startsWith(`[${best.idx}]`));
  const coordM = bestLine?.match(/@\((\d+),(\d+)\)/);

  onStep({ type: 'step', text: `Clicking "${best.name}"…` });
  let clicked = false;
  if (coordM) {
    try {
      await cdpClick(tabId, +coordM[1], +coordM[2]);
      clicked = true;
    } catch { /* fall through to JS click */ }
  }
  if (!clicked) {
    const result = await sendAction(tabId, { action: 'click', index: best.idx });
    if (!result?.success) return null;
  }

  await new Promise(r => setTimeout(r, 800));
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab?.status === 'loading') await waitForTabLoad(tab.id);
  return { success: true, message: `Clicked "${best.name}"` };
}

// ── Agent loop ────────────────────────────────────────────────────────────────
let _abortLoop = false;

// opts.injectText: if set, agent fill actions with value "INJECT_PROMPT" get replaced
// with this text — bypasses GPT token limits for long prompt injection
async function runAgentLoop(tabId, goal, onStep, opts = {}) {
  _abortLoop = false;
  const history = [];
  const MAX = 25;
  let prevSnapshotSig = '';
  let sameSnapshotCount = 0;
  let promptInjected = false;
  let plan = null;
  let validatorFailStreak = 0;
  const MAX_VALIDATOR_FAILS = 3;
  let lastPlanUrl = '';

  // Helper: generate or refresh plan for current page
  async function refreshPlan(snap, screen) {
    try {
      const p = await planTask(goal, snap.text, screen);
      if (p?.steps?.length) {
        plan = p;
        const [t] = await chrome.tabs.query({ active: true, currentWindow: true });
        lastPlanUrl = t?.url || '';
        onStep({ type: 'step', text: `Plan (${plan.steps.length} steps): ${plan.steps[0]}` });
      }
    } catch { /* non-fatal */ }
  }

  // ── PLANNER: generate step-by-step plan before loop starts ───────────────
  try {
    onStep({ type: 'step', text: `Planning: breaking down the goal…` });
    await new Promise(r => setTimeout(r, 300));
    const initSnap = await getEnrichedSnapshot(tabId).catch(() => null);
    const initScreen = await takeScreenshot().catch(() => null);
    if (initSnap) await refreshPlan(initSnap, initScreen);
  } catch { /* planner failure non-fatal */ }

  for (let step = 1; step <= MAX; step++) {
    if (_abortLoop) return { success: false, message: 'Stopped by user.' };

    // Mid-loop interrupt: inject user's new instruction and continue with updated goal
    if (_interruptCmd) {
      const cmd = _interruptCmd;
      _interruptCmd = null;
      const norm = normalizeText(cmd);
      onStep({ type: 'step', text: `↩ User says: "${norm}"` });
      speak(`Understood. ${norm}.`);
      history.push(`[USER INSTRUCTION mid-loop]: ${norm}`);
      // Update goal to include the new instruction
      goal = goal + `\n\nUSER UPDATE: ${norm}`;
      prevSnapshotSig = ''; // force fresh read
    }

    onStep({ type: 'step', text: `Step ${step}: reading page…` });

    // Brief settle before snapshot
    await new Promise(r => setTimeout(r, 400));

    // Enriched snapshot: DOM elements + native a11y tree merged (Stagehand + HyperAgent)
    let snapshot;
    try {
      snapshot = await getEnrichedSnapshot(tabId);
    } catch (err) {
      await new Promise(r => setTimeout(r, 1200));
      try { snapshot = await getEnrichedSnapshot(tabId, { fresh: true }); }
      catch (e2) { return { success: false, message: `Cannot read page: ${e2.message}` }; }
    }

    // Stuck detection
    const sig = snapshot.text.slice(0, 300);
    if (sig === prevSnapshotSig) {
      sameSnapshotCount++;
      if (sameSnapshotCount >= 2) {
        onStep({ type: 'step', text: `Step ${step}: page unchanged — scrolling…` });
        await sendAction(tabId, { action: 'scroll', direction: 'down', amount: 500 });
        await new Promise(r => setTimeout(r, 800));
        sameSnapshotCount = 0;
        try { snapshot = await getEnrichedSnapshot(tabId, { fresh: true }); } catch {}
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
      action = await getNextStep(goal, snapshot.text, screenshot, history, plan);
    } catch (err) {
      return { success: false, message: `GPT error: ${err.message}` };
    }

    const desc = action.description || action.action;
    onStep({ type: 'step', text: `Step ${step}: ${desc}` });

    // Narrate only meaningful interactions (clicks, fills, selections — not waits/reads)
    const NARRATE_ACTIONS = ['click','click_xy','fill','select','press_on','type','evaluate'];
    if (NARRATE_ACTIONS.includes(action.action)) speak(desc);

    if (action.action === 'done')   { speak(action.message || 'Done.'); return { success: true,  message: action.message }; }
    if (action.action === 'failed') { speak(action.message || 'I ran into an issue.'); return { success: false, message: action.message }; }
    if (action.action === 'ask') {
      const q = action.question || 'What should I do next?';
      speak(q);
      // Surface the question visibly so user knows to respond via mic
      onStep({ type: 'step', text: `❓ ${q}` });
      return { success: false, message: `Needs info: ${q}` };
    }

    // Prompt injection: replace placeholder value with full generated text (bypasses GPT token limits)
    if (opts.injectText && action.action === 'fill' &&
        typeof action.value === 'string' && action.value.includes('INJECT_PROMPT')) {
      action = { ...action, value: opts.injectText };
    }

    // Direct textarea injection: if on builder page and textarea still empty after a fill attempt, inject directly
    if (opts.injectText && !promptInjected && action.action === 'fill') {
      const [curTab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (curTab?.url?.includes('/aiagents/') && curTab?.url?.includes('/voice/')) {
        const injectResult = await sendAction(tabId, {
          action: 'evaluate',
          script: `
            const ta = document.querySelector('textarea[placeholder*="train"], textarea[class*="prompt"], .agent-prompt textarea, textarea');
            if (ta) {
              const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
              if (setter) setter.call(ta, ${JSON.stringify(opts.injectText)});
              else ta.value = ${JSON.stringify(opts.injectText)};
              ta.dispatchEvent(new Event('input', {bubbles:true}));
              ta.dispatchEvent(new Event('change', {bubbles:true}));
              'injected ' + ta.value.length + ' chars';
            } else 'textarea not found'
          `
        });
        if (injectResult?.message?.startsWith('injected')) {
          promptInjected = true;
          history.push(`Injected prompt (${opts.injectText.length} chars) directly into textarea||fill:prompt`);
          onStep({ type: 'step', text: `Prompt injected (${opts.injectText.length} chars). Clicking Save…` });
          speak('Prompt filled. Now saving.');
          await new Promise(r => setTimeout(r, 600));
          // Click Save & update
          await sendAction(tabId, { action: 'evaluate', script: `
            const btns = [...document.querySelectorAll('button')];
            const save = btns.find(b => b.textContent.includes('Save'));
            if (save) { save.click(); 'saved'; } else 'save btn not found'
          `});
          await new Promise(r => setTimeout(r, 1500));
          return { success: true, message: 'Voice agent created with full prompt and saved.' };
        }
      }
    }

    // Action key (stable — use ref if available, else index, else coords)
    const actionKey = `${action.action}:${action.ref ?? action.index ?? `${action.x ?? ''},${action.y ?? ''}`}`;

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
          const msg = `I'm stuck in a loop — the page isn't responding to my clicks. Please try clicking manually or give me a more specific command.`;
          speak(msg);
          return { success: false, message: msg };
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

    // Execute action — priority: cdpClickByNode (HyperAgent) > cdpClick (coords) > JS click
    let result = { success: false, message: 'no response' };
    try {
      if (action.action === 'click') {
        // 1. Try a11y-tree nodeId click (most reliable — live coords at click time)
        const nodeLine = snapshot.text.split('\n').find(l => {
          if (action.ref && l.includes(`#${action.ref}`)) return true;
          if (action.index != null && l.trimStart().startsWith(`[${action.index}]`)) return true;
          return false;
        });
        const nodeIdM = nodeLine?.match(/nodeId:(\d+)/);
        if (nodeIdM) {
          try {
            await cdpClickByNode(tabId, +nodeIdM[1]);
            result = { success: true, message: `Node click nodeId:${nodeIdM[1]}` };
          } catch { /* fall through to coord click */ }
        }

        // 2. Coordinate-based CDP click
        if (!result.success) {
          const cm = nodeLine?.match(/@\((\d+),(\d+)\)/);
          if (cm) {
            try {
              await cdpClick(tabId, +cm[1], +cm[2]);
              result = { success: true, message: `CDP click (${cm[1]},${cm[2]})` };
            } catch { /* fall through to JS click */ }
          }
        }

        // 3. JS content-script click (fallback)
        if (!result.success) result = await sendAction(tabId, action);

      } else if (action.action === 'click_xy') {
        try {
          await cdpClick(tabId, action.x, action.y);
          result = { success: true, message: `CDP click_xy (${action.x},${action.y})` };
        } catch {
          result = await sendAction(tabId, action);
        }
      } else {
        result = await sendAction(tabId, action);
      }
    } catch (err) {
      result = { success: false, message: err.message };
    }

    // ── Stagehand self-healing: if click/fill fails, re-snapshot + retry once ─
    if (!result.success && ['click','fill','click_xy'].includes(action.action)) {
      onStep({ type: 'step', text: `Step ${step}: self-healing — re-reading page…` });
      await new Promise(r => setTimeout(r, 600));
      try {
        const freshSnap = await getEnrichedSnapshot(tabId, { fresh: true });
        const healAction = await getNextStep(
          goal + `\n\nSELF-HEAL: previous action "${desc}" failed (${result.message}). Look at the page carefully and find a different way to achieve the same step.`,
          freshSnap.text,
          await takeScreenshot(),
          history
        );
        if (!['done','failed','ask'].includes(healAction.action)) {
          const healLine = freshSnap.text.split('\n').find(l =>
            (healAction.ref && l.includes(`#${healAction.ref}`)) ||
            (healAction.index != null && l.trimStart().startsWith(`[${healAction.index}]`))
          );
          const hnm = healLine?.match(/nodeId:(\d+)/);
          const hcm = healLine?.match(/@\((\d+),(\d+)\)/);
          if (hnm) {
            try { await cdpClickByNode(tabId, +hnm[1]); result = { success: true, message: `Healed via nodeId:${hnm[1]}` }; } catch {}
          }
          if (!result.success && hcm) {
            try { await cdpClick(tabId, +hcm[1], +hcm[2]); result = { success: true, message: `Healed via coords` }; } catch {}
          }
          if (!result.success) result = await sendAction(tabId, healAction).catch(() => result);
          if (result.success) onStep({ type: 'step', text: `Step ${step}: ✓ self-healed` });
        }
      } catch { /* healing failed — continue normally */ }
    }

    invalidateSnapCache(tabId);

    history.push(`${desc}: ${result?.success ? 'ok' : result?.message || '?'}||${actionKey}`);
    if (_abortLoop) return { success: false, message: 'Stopped by user.' };

    // Auto-done after any Save/Submit/Update click — don't loop after saving
    if (result?.success && action.action === 'click') {
      const nm = (action.description || '').toLowerCase();
      if (/save|submit|update|confirm/.test(nm)) {
        speak('Saved.');
        return { success: true, message: `Done — ${action.description}` };
      }
    }

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

    // Re-plan when URL changed significantly (new page = old plan is stale)
    if (tab?.url && lastPlanUrl && tab.url !== lastPlanUrl) {
      const sameOrigin = new URL(tab.url).origin === new URL(lastPlanUrl).origin;
      // Only re-plan on cross-origin navigations or clear path changes (not hash/query tweaks)
      const pathChanged = new URL(tab.url).pathname !== new URL(lastPlanUrl).pathname;
      if (!sameOrigin || pathChanged) {
        try {
          const reSnap = await getEnrichedSnapshot(tabId, { fresh: true }).catch(() => null);
          const reScreen = await takeScreenshot().catch(() => null);
          if (reSnap) await refreshPlan(reSnap, reScreen);
        } catch { /* non-fatal */ }
      }
    }

    // ── VALIDATOR AGENT (Nanobrowser-style) ────────────────────────────────
    // Runs AFTER smart-wait + page-load so nav actions settle before we check.
    // Only validates meaningful interactive actions, not navigation/scroll/wait.
    const VALIDATE_ACTIONS = ['click','click_xy','fill','fill_otp','select','press','press_on'];
    if (result?.success && VALIDATE_ACTIONS.includes(action.action)) {
      try {
        const afterSnap = await getEnrichedSnapshot(tabId, { fresh: true }).catch(() => null);
        if (afterSnap) {
          const afterScreen = await takeScreenshot().catch(() => null);
          const validation = await validateAction(desc, prevSnapshotSig, afterSnap.text, afterScreen);
          if (validation && !validation.success) {
            validatorFailStreak++;
            onStep({ type: 'step', text: `Step ${step}: validator: action may not have worked — ${validation.reason} (${validatorFailStreak}/${MAX_VALIDATOR_FAILS})` });
            if (validatorFailStreak >= MAX_VALIDATOR_FAILS) {
              const msg = `"${desc}" failed validation ${MAX_VALIDATOR_FAILS} times: ${validation.reason}`;
              speak('I seem stuck. Please check the page.');
              return { success: false, message: msg };
            }
            // Force fresh read next iteration so self-healing picks up the real state
            prevSnapshotSig = '';
            sameSnapshotCount = 0;
          } else {
            validatorFailStreak = 0;
            // Mark page as changed so stuck-detection doesn't fire next iteration
            sameSnapshotCount = 0;
            prevSnapshotSig = ''; // let next iteration re-baseline naturally
          }
        }
      } catch { /* validator failure non-fatal */ }
    }
  }

  return { success: false, message: 'Reached max steps. Goal may be partially complete.' };
}

// ── Top-level command runner ──────────────────────────────────────────────────
const _cmdHistory = [];
function pushHistory(t) { _cmdHistory.push(t); if (_cmdHistory.length > 5) _cmdHistory.shift(); }

// Execute a sequence of direct actions (no loop needed)
async function execDirect(tabId, actions, onStep) {
  // Take one snapshot upfront so we can extract coords for CDP clicks
  let snapshot = { text: '' };
  try { snapshot = await getSnapshot(tabId); } catch {}

  for (const action of actions) {
    const desc = action.description || action.action;
    onStep({ type: 'step', text: desc });
    const NARRATE_ACTIONS = ['click','click_xy','fill','select','press_on','type'];
    if (NARRATE_ACTIONS.includes(action.action)) speak(desc);

    if (action.action === 'navigate') {
      await chrome.tabs.update(tabId, { url: action.url });
      await waitForTabLoad(tabId);
      // Refresh snapshot after navigation
      try { snapshot = await getSnapshot(tabId); } catch {}
    } else if (action.action === 'click' || action.action === 'click_xy') {
      // Always try CDP first — real mouse events are most reliable
      let x = action.x, y = action.y;
      if (action.action === 'click') {
        const coordLine = snapshot.text.split('\n').find(l => {
          if (action.ref && l.includes(`#${action.ref}`)) return true;
          if (action.index != null && l.trimStart().startsWith(`[${action.index}]`)) return true;
          return false;
        });
        const cm = coordLine?.match(/@\((\d+),(\d+)\)/);
        if (cm) { x = +cm[1]; y = +cm[2]; }
      }
      let cdpOk = false;
      if (x != null && y != null) {
        try { await cdpClick(tabId, x, y); cdpOk = true; } catch {}
      }
      if (!cdpOk) {
        // Fallback: JS content-script click
        await sendAction(tabId, action);
      }
      await new Promise(r => setTimeout(r, 1000));
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.status === 'loading') await waitForTabLoad(tab.id);
      // Refresh snapshot so next click has fresh coords
      try { snapshot = await getSnapshot(tabId); } catch {}
    } else {
      await sendAction(tabId, action);
      const isNavAction = ['press_on','press','select'].includes(action.action);
      await new Promise(r => setTimeout(r, isNavAction ? 800 : 300));
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.status === 'loading') await waitForTabLoad(tab.id);
    }
  }
  const lastDesc = actions[actions.length - 1]?.description || 'Done';
  return { success: true, message: lastDesc };
}

async function runCommand(text, onStep) {
  const norm = normalizeText(text.trim());
  pushHistory(norm);

  const tabId = await getActiveTabId();
  if (!tabId) return { success: false, message: 'No active browser tab.' };

  // ── Fast paths that don't need page context ──────────────────────────────
  // Website navigation
  const SITES = { amazon:'https://www.amazon.in', flipkart:'https://www.flipkart.com',
    bigbasket:'https://www.bigbasket.com', zomato:'https://www.zomato.com',
    swiggy:'https://www.swiggy.com', youtube:'https://www.youtube.com',
    google:'https://www.google.com', instagram:'https://www.instagram.com',
    myntra:'https://www.myntra.com', nykaa:'https://www.nykaa.com',
    kapture:'https://adjetter.com/admin/home.html',
    meesho:'https://www.meesho.com', ajio:'https://www.ajio.com',
  };
  // "open X" OR "login to X" where X is a known site → just navigate (login handled by loop after)
  const openMatch = norm.match(/^(?:open|launch|go to|navigate to|login to|log in to|sign in to)\s+(\w+)/i);
  if (openMatch) {
    const site = openMatch[1].toLowerCase();
    const url = SITES[site] || (norm.includes('.com') || norm.includes('.in') ? `https://${openMatch[1]}` : null);
    if (url) {
      onStep({ type: 'step', text: `Opening ${openMatch[1]}…` });
      await chrome.tabs.update(tabId, { url });
      await waitForTabLoad(tabId);
      // If command was "login to X", kick off a login loop on that site
      if (/^(?:login to|log\s*in to|sign in to)/i.test(norm)) {
        onStep({ type: 'step', text: `Now logging into ${openMatch[1]}…` });
        return runAgentLoop(tabId, `Log into ${openMatch[1]} — click Sign In / Login button, fill in credentials if asked.`, onStep);
      }
      return { success: true, message: `Opened ${openMatch[1]}` };
    }
  }

  // Scroll
  if (/^scroll\s*(up|down|top|bottom)/i.test(norm)) {
    const dir = norm.match(/up|down|top|bottom/i)?.[0]?.toLowerCase() || 'down';
    await sendAction(tabId, { action: 'scroll', direction: dir, amount: 500 });
    return { success: true, message: `Scrolled ${dir}` };
  }

  // Media
  const mediaMap = { pause:'pause', play:'play', mute:'mute', unmute:'unmute', stop:'pause' };
  const mediaKey = Object.keys(mediaMap).find(k => norm.toLowerCase().startsWith(k));
  if (mediaKey) {
    const op = mediaMap[mediaKey];
    const scripts = {
      pause: `document.querySelectorAll('video,audio').forEach(v=>v.pause())`,
      play:  `document.querySelectorAll('video,audio').forEach(v=>v.play())`,
      mute:  `document.querySelectorAll('video,audio').forEach(v=>v.muted=true)`,
      unmute:`document.querySelectorAll('video,audio').forEach(v=>v.muted=false)`,
    };
    await sendAction(tabId, { action: 'evaluate', script: scripts[op] });
    return { success: true, message: `Media: ${op}` };
  }

  // Create agent
  if (CREATE_AGENT_RE.test(norm)) {
    // Extract details with a lightweight GPT call
    const extractRaw = await callOpenAI([
      { role: 'system', content: 'Extract fields from this voice command as JSON: {"name":"...","purpose":"...","company":"...","industry":"From Scratch|E-commerce|BFSI|Healthcare|Travel|Energy"}. Return ONLY JSON.' },
      { role: 'user', content: norm }
    ], { maxTokens: 150, json: true }).catch(() => '{}');
    const p = JSON.parse(extractRaw || '{}');
    const { name, purpose, company, industry } = p;
    onStep({ type: 'step', text: `Generating prompt for ${company || 'agent'}…` });
    speak(`Generating prompt for ${company || 'the agent'}. One moment.`);
    let generatedPrompt = '';
    try {
      generatedPrompt = await generateVoiceBotPrompt({ name, purpose, company, industry });
    } catch {
      generatedPrompt = `You are ${name || 'a voice assistant'} for ${company || 'the company'}. ${purpose || 'Help users.'}`;
    }
    onStep({ type: 'step', text: 'Prompt ready — starting creation flow…' });
    const agentName = name || 'Voice Assistant';
    const agentIndustry = industry || 'From Scratch';
    const agentPurpose = purpose || 'voice assistant for customer support';
    const goal = `Create Kapture voice agent: Name="${agentName}", Industry="${agentIndustry}", Type=Single, Purpose="${agentPurpose}". Steps: 1) AI Agents → Create New. 2) Click "${agentIndustry}" industry card. 3) Fill Name="${agentName}", Purpose="${agentPurpose}", click Start Building. 4) Click Chat GPT card, click Agent Prompts textarea, fill with "INJECT_PROMPT", click Save & update. Done.`;
    return runAgentLoop(tabId, goal, onStep, { injectText: generatedPrompt });
  }

  // Kapture partner login — only when explicitly mentioning Kapture/CRM/partner
  const loginMatch = norm.match(LOGIN_RE);
  const COMMON_SITES_RE = /\b(flipkart|amazon|bigbasket|swiggy|zomato|myntra|nykaa|meesho|ajio|instagram|youtube|google|netflix)\b/i;
  if (loginMatch && !COMMON_SITES_RE.test(norm)) {
    const client = loginMatch[1].trim();
    const goal = `Kapture partner login for ${client}: navigate https://adjetter.com/admin/home.html, sign in with Google if needed, click LOGIN TO PARTNER EMPLOYEE, select admin server https://in.kapturecrm.com, click Domain Name react-select → type "${client}" → click match, select employee, fill Remarks 5+ words, click Submit.`;
    return runAgentLoop(tabId, goal, onStep);
  }

  // ── Context-aware orchestration: take page snapshot FIRST, then decide ───
  onStep({ type: 'step', text: 'Reading page…' });
  let snapshot = { text: '' };
  try { snapshot = await getSnapshot(tabId); } catch {}
  const screenshot = await takeScreenshot();

  onStep({ type: 'step', text: 'Thinking…' });
  const plan = await orchestrate(norm, snapshot, screenshot);

  switch (plan.type) {
    case 'navigate':
      await chrome.tabs.update(tabId, { url: plan.url });
      await waitForTabLoad(tabId);
      return { success: true, message: `Navigated to ${plan.url}` };

    case 'scroll':
      await sendAction(tabId, { action: 'scroll', direction: plan.direction || 'down', amount: 500 });
      return { success: true, message: `Scrolled ${plan.direction}` };

    case 'media': {
      const scripts = { pause:`document.querySelectorAll('video,audio').forEach(v=>v.pause())`, play:`document.querySelectorAll('video,audio').forEach(v=>v.play())`, mute:`document.querySelectorAll('video,audio').forEach(v=>v.muted=true)`, unmute:`document.querySelectorAll('video,audio').forEach(v=>v.muted=false)` };
      const sc = scripts[plan.operation];
      if (sc) await sendAction(tabId, { action: 'evaluate', script: sc });
      return { success: true, message: `Media: ${plan.operation}` };
    }

    case 'direct':
      return execDirect(tabId, plan.actions || [], onStep);

    case 'loop':
      return runAgentLoop(tabId, plan.goal || norm, onStep);

    default:
      return runAgentLoop(tabId, norm, onStep);
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
const emptyState  = document.getElementById('emptyState');

function setStatus(state, text) {
  statusDot.className = `status-dot ${state}`;
  statusText.textContent = text;
  // Drive orb colour via body class
  document.body.classList.remove('listening', 'running');
  if (state === 'running') document.body.classList.add('running');
}

function addStep(text, type = 'active') {
  // Hide the idle orb once we have real steps
  const es = document.getElementById('emptyState');
  if (es) es.style.display = 'none';

  const prev = stepsArea.querySelector('.step-item.active');
  if (prev) prev.classList.replace('active', 'done');

  const el = document.createElement('div');
  el.className = `step-item ${type}`;
  const icons = { success: '✓', error: '✗', active: '›', done: '·' };
  const icon = icons[type] || '›';
  el.innerHTML = `<div class="step-dot">${icon}</div><div class="step-text">${text}</div>`;
  stepsArea.appendChild(el);
  stepsArea.scrollTop = stepsArea.scrollHeight;
  return el;
}

function clearSteps() {
  // Remove all step items but keep the idle orb
  stepsArea.querySelectorAll('.step-item').forEach(el => el.remove());
  const es = document.getElementById('emptyState');
  if (es) es.style.display = '';
}

let _lastStepEl = null;

function onStep(info) {
  if (_lastStepEl) _lastStepEl.classList.remove('active');
  _lastStepEl = addStep(info.text, 'active');
}

let _isRunning = false;
let _interruptCmd = null; // mid-loop voice interrupt

async function submitCommand(text) {
  if (!text.trim()) return;

  // Mid-loop interrupt: queue the new command instead of blocking
  if (_isRunning) {
    const norm = normalizeText(text.trim());
    const isStop = /^(stop|cancel|abort|pause|enough|quit)$/i.test(norm.split(' ')[0]);
    if (isStop) {
      _abortLoop = true;
      addStep('Stopping…', 'active');
      speak('Stopping.');
    } else {
      _interruptCmd = norm;
      addStep(`↩ Interrupt queued: "${norm}"`, 'active');
      speak(`Got it. I'll ${norm} after this step.`);
    }
    return;
  }

  _isRunning = true;
  _abortLoop = false;
  _interruptCmd = null;
  clearSteps();
  transcriptEl.textContent = text;
  transcriptEl.className = 'transcript-text has-text';
  setStatus('running', 'Running…');
  // Keep mic ENABLED so user can interrupt mid-loop
  sendBtn.textContent = '■';
  sendBtn.title = 'Stop';
  sendBtn.className = 'action-btn stop-btn';
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
    _interruptCmd = null;
    sendBtn.textContent = '↵';
    sendBtn.title = '';
    sendBtn.className = 'action-btn send-btn';
    textInput.disabled = false;
  }
}

// ── Voice — runs in the active tab's content script (normal page context)
// The extension sidepanel cannot use mic directly; content scripts can.

let isRecording  = false;
let _finalText   = '';

function resetMicBtn() {
  micBtn.classList.remove('listening');
  document.body.classList.remove('listening');
  micIcon.textContent  = '🎤';
  micLabel.textContent = 'Hold to speak';
}

// duplicate — removed (defined at line 365)

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
  document.body.classList.add('listening');
  document.body.classList.remove('running');
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

// Settings
settingsBtn.addEventListener('click', () => chrome.runtime.openOptionsPage());
document.getElementById('openOptionsLink')?.addEventListener('click', () => chrome.runtime.openOptionsPage());

// Refresh — click: soft refresh (re-inject content script, reset state)
const refreshBtn = document.getElementById('refreshBtn');

refreshBtn.addEventListener('click', async () => {
  refreshBtn.classList.add('spinning');
  refreshBtn.disabled = true;
  try {
    // Re-inject content script into current active tab
    const tabId = await getActiveTabId();
    if (tabId) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }).catch(() => {});
    }
    // Re-check API key + reset status
    await init();
    // Unstick running state if agent got stuck
    if (_isRunning) {
      _abortLoop = true;
      _isRunning = false;
      textInput.disabled = false;
      sendBtn.textContent = '↵';
      sendBtn.className = 'action-btn send-btn';
      document.body.classList.remove('running', 'listening');
    }
    clearSteps();
    addStep('Refreshed ✓  content script re-injected', 'success');
    speak('Refreshed.');
  } catch (e) {
    addStep(`Refresh error: ${e.message}`, 'error');
  } finally {
    setTimeout(() => {
      refreshBtn.classList.remove('spinning');
      refreshBtn.disabled = false;
    }, 700);
  }
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
  const hasSpeechAPI = ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window);
  if (!hasSpeechAPI) {
    addStep('Web Speech API not found. Use Chrome for voice input.', 'error');
  }
}

init();
