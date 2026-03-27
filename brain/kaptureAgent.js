'use strict';

/**
 * kaptureAgent.js
 * Direct Kapture CRM API client + GPT-4o powered natural-language dispatcher.
 *
 * Instead of browser-automating app.kapturecrm.com, we call the REST APIs
 * directly using the session cookies stored in .env. This is instant and
 * reliable — no Playwright, no screenshots, no DOM.
 *
 * Session setup (one-time):
 *   1. Log in to Kapture CRM in Chrome.
 *   2. Open DevTools → Application → Cookies.
 *   3. Copy _KAPTURECRM_SESSION, JSESSIONID, JSESSIONRID, _KSID into .env.
 */

require('dotenv').config();
const { OpenAI } = require('openai');
const https = require('https');
const http = require('http');
const { URL, URLSearchParams } = require('url');
const logger = require('../logger');

const BASE_URL = process.env.KAPTURE_BASE_URL || 'https://demokapairlines.kapturecrm.com';

// ─── Session cookies ───────────────────────────────────────────────────────────
function getSessionCookie() {
  const parts = [];
  if (process.env.KAPTURE_SESSION)    parts.push(`_KAPTURECRM_SESSION=${process.env.KAPTURE_SESSION}`);
  if (process.env.KAPTURE_JSESSIONID) parts.push(`JSESSIONID=${process.env.KAPTURE_JSESSIONID}`);
  if (process.env.KAPTURE_JSESSIONRID)parts.push(`JSESSIONRID=${process.env.KAPTURE_JSESSIONRID}`);
  if (process.env.KAPTURE_KSID)       parts.push(`_KSID=${process.env.KAPTURE_KSID}`);
  return parts.join('; ');
}

// ─── HTTP helper ──────────────────────────────────────────────────────────────
function request(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const postBody = body instanceof URLSearchParams
      ? body.toString()
      : (body ? JSON.stringify(body) : null);

    const headers = {
      Cookie: getSessionCookie(),
      'Content-Type': body instanceof URLSearchParams
        ? 'application/x-www-form-urlencoded'
        : 'application/json',
    };
    if (postBody) headers['Content-Length'] = Buffer.byteLength(postBody);

    const req = lib.request(
      { hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ raw: data, status: res.statusCode }); }
        });
      }
    );
    req.on('error', reject);
    if (postBody) req.write(postBody);
    req.end();
  });
}

// ─── Kapture API calls ─────────────────────────────────────────────────────────

async function getTicketList({ status = 'P', type = '', empId = '-1', pageSize = 20, pageNo = 0 } = {}) {
  const params = new URLSearchParams({
    sort_by_column: 'last_conversation_time',
    sort_type: 'desc',
    status,
    folder_id: '-1',
    page_no: pageNo,
    page_size: pageSize,
    response_type: 'json',
    query: `status=${status}&sub_status=&emp_id=${empId}&type=${type}&emp_queue=&priority=&folder_id=-1`,
    type: type || '5',
  });
  return request('POST', '/api/version3/ticket/get-ticket-list', params);
}

async function getTicketDetail(id, dataType = 'TICKET') {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const qs = new URLSearchParams({ id, data_type: dataType, cdate: now, fetch_action_name: 'yes' });
  return request('GET', `/api/version3/ticket/get-ticket-detail?${qs}`);
}

async function assignTicket(ticketId, taskId, assignTo, taskDetail) {
  const params = new URLSearchParams({ ticket_id: ticketId, task_id: taskId, assign_to: assignTo, task_detail: taskDetail });
  return request('POST', '/api/version3/ticket/assign-ticket', params);
}

async function resolveTickets(taskId, taskDetail, subStatus = 'RS') {
  const params = new URLSearchParams({ task_id: taskId, task_detail: taskDetail, sub_status: subStatus });
  return request('POST', '/api/version3/ticket/resolve-ticket', params);
}

async function reopenTickets(taskId, taskDetail) {
  const params = new URLSearchParams({ task_id: taskId, task_detail: taskDetail });
  return request('POST', '/api/version3/ticket/reopen-ticket', params);
}

async function disposeTicket(taskId, ticketId, folderId, subStatus, assignTo, taskDetail) {
  const params = new URLSearchParams({
    task_id: taskId, ticket_id: ticketId,
    selected_folder_list: folderId, update_folder_id: folderId,
    sub_status: subStatus, assign_to: assignTo, task_detail: taskDetail,
  });
  return request('POST', '/api/version3/ticket/dispose-ticket', params);
}

async function markTicketJunk(taskId, taskDetail) {
  const params = new URLSearchParams({ task_id: taskId, task_detail: taskDetail });
  return request('POST', '/api/version3/ticket/mark-as-junk', params);
}

async function searchEmployees(searchValue = '', offset = 0, pageSize = 10) {
  const params = new URLSearchParams({ search_value: searchValue, offset, page_size: pageSize });
  return request('POST', '/ms/employee/api/v1/employee-search', params);
}

async function getQueues() {
  return request('GET', '/api/version3/queue/get-queues');
}

// ─── OpenAI client ────────────────────────────────────────────────────────────
let _openai = null;
const getClient = () => {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
};

// ─── GPT-4o CRM dispatcher ────────────────────────────────────────────────────
const CRM_SYSTEM_PROMPT = `
You are a Kapture CRM assistant. The user gives a natural language command.
You must return ONE JSON operation to perform.

Available operations:
- list_tickets:    list open/pending tickets  → {"op":"list_tickets","status":"P","type":"","emp_id":"-1","limit":10}
- get_ticket:      get one ticket's details   → {"op":"get_ticket","ticket_id":"<id>","data_type":"TICKET"}
- assign_ticket:   assign ticket to employee  → {"op":"assign_ticket","ticket_id":"<id>","task_id":"<id>","assign_to":"<empId#Name>","note":"reason"}
- resolve_ticket:  mark ticket resolved       → {"op":"resolve_ticket","task_id":"<id>","note":"reason"}
- reopen_ticket:   reopen a closed ticket     → {"op":"reopen_ticket","task_id":"<id>","note":"reason"}
- mark_junk:       mark ticket as junk/spam   → {"op":"mark_junk","task_id":"<id>","note":"reason"}
- search_employees:find employees by name     → {"op":"search_employees","query":"<name or empty>"}
- get_queues:      list all ticket queues     → {"op":"get_queues"}
- summarize:       summarize tickets data after you have the data (use after list_tickets)

Status codes: P=Pending, C=Completed, J=Junk
Data types: TICKET, history, NOTES, SUB_TASKS, SIDE_CONVERSATIONS

Return ONLY valid JSON. No prose.
`.trim();

async function dispatchCrmCommand(command, onStep) {
  logger.info(`Kapture CRM command: "${command}"`);

  // Step 1: parse intent into operation
  const opResponse = await getClient().chat.completions.create({
    model: process.env.LLM_MODEL || 'gpt-4o',
    temperature: 0,
    max_completion_tokens: 256,
    response_format: { type: 'json_object' },
    messages: [
      { role: 'system', content: CRM_SYSTEM_PROMPT },
      { role: 'user', content: command },
    ],
  });

  let op;
  try {
    op = JSON.parse(opResponse.choices[0].message.content.trim());
  } catch {
    return { success: false, message: 'Could not parse CRM operation.' };
  }

  logger.info(`CRM op: ${JSON.stringify(op)}`);
  if (onStep) onStep(`⚡ CRM: ${op.op}...`);

  // Step 2: execute the operation
  let data;
  try {
    switch (op.op) {
      case 'list_tickets':
        data = await getTicketList({ status: op.status || 'P', type: op.type || '', empId: op.emp_id || '-1', pageSize: op.limit || 20 });
        break;
      case 'get_ticket':
        data = await getTicketDetail(op.ticket_id, op.data_type || 'TICKET');
        break;
      case 'assign_ticket':
        data = await assignTicket(op.ticket_id, op.task_id, op.assign_to, op.note || 'Assigned via voice command');
        break;
      case 'resolve_ticket':
        data = await resolveTickets(op.task_id, op.note || 'Resolved via voice command');
        break;
      case 'reopen_ticket':
        data = await reopenTickets(op.task_id, op.note || 'Reopened via voice command');
        break;
      case 'mark_junk':
        data = await markTicketJunk(op.task_id, op.note || 'Marked as junk');
        break;
      case 'search_employees':
        data = await searchEmployees(op.query || '');
        break;
      case 'get_queues':
        data = await getQueues();
        break;
      default:
        return { success: false, message: `Unknown CRM operation: ${op.op}` };
    }
  } catch (err) {
    logger.error(`Kapture API error: ${err.message}`);
    return { success: false, message: `Kapture API error: ${err.message}` };
  }

  // Step 3: summarise the raw API response in plain English
  const summaryResponse = await getClient().chat.completions.create({
    model: process.env.LLM_MODEL || 'gpt-4o',
    temperature: 0,
    max_completion_tokens: 400,
    messages: [
      { role: 'system', content: 'You are a CRM assistant. Summarise the following API response in 1-3 concise sentences the user can hear as a voice reply. Be specific — mention counts, IDs, names. No markdown.' },
      { role: 'user', content: `User asked: "${command}"\n\nAPI response:\n${JSON.stringify(data).slice(0, 3000)}` },
    ],
  });

  const summary = summaryResponse.choices[0].message.content.trim();
  logger.info(`CRM summary: ${summary}`);
  if (onStep) onStep(`✓ ${summary}`);

  return { success: true, message: summary, data };
}

module.exports = { dispatchCrmCommand };
