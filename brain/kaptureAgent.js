'use strict';

/**
 * kaptureAgent.js — Kapture CRM via GPT-4o Function Calling
 *
 * Uses OpenAI tool-use (function calling) so GPT-4o can autonomously:
 *  - Choose the right API operation
 *  - Do multi-step work (search employee → get ID → assign ticket)
 *  - Retry or chain calls when more info is needed
 *
 * API parameter names match the MCP tool schemas exactly.
 */

require('dotenv').config();
const { OpenAI } = require('openai');
const https = require('https');
const http  = require('http');
const { URL, URLSearchParams } = require('url');
const logger = require('../logger');

const BASE_URL = process.env.KAPTURE_BASE_URL || 'https://demokapairlines.kapturecrm.com';
const MAX_TOOL_ROUNDS = 10;

// ─── Auth cookies ──────────────────────────────────────────────────────────────
function getCookieHeader() {
  return [
    process.env.KAPTURE_SESSION     ? `_KAPTURECRM_SESSION=${process.env.KAPTURE_SESSION}`  : null,
    process.env.KAPTURE_JSESSIONID  ? `JSESSIONID=${process.env.KAPTURE_JSESSIONID}`        : null,
    process.env.KAPTURE_JSESSIONRID ? `JSESSIONRID=${process.env.KAPTURE_JSESSIONRID}`      : null,
    process.env.KAPTURE_KSID        ? `_KSID=${process.env.KAPTURE_KSID}`                   : null,
  ].filter(Boolean).join('; ');
}

// ─── HTTP helper ───────────────────────────────────────────────────────────────
function request(method, urlPath, body = null) {
  return new Promise((resolve, reject) => {
    const url    = new URL(urlPath, BASE_URL);
    const lib    = url.protocol === 'https:' ? https : http;
    const isForm = body instanceof URLSearchParams;
    const raw    = isForm ? body.toString() : (body ? JSON.stringify(body) : null);

    const headers = {
      Cookie:         getCookieHeader(),
      'Content-Type': isForm ? 'application/x-www-form-urlencoded' : 'application/json',
    };
    if (raw) headers['Content-Length'] = Buffer.byteLength(raw);

    const req = lib.request(
      { hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: url.pathname + url.search, method, headers },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch { resolve({ raw: data, statusCode: res.statusCode }); }
        });
      }
    );
    req.on('error', reject);
    if (raw) req.write(raw);
    req.end();
  });
}

// ─── Kapture API functions (parameter names match MCP tool schemas exactly) ────

function api_get_ticket_list({ status = 'P', type = '5', folder_id = '-1', page_no = 0,
  page_size = 20, sort_by_column = 'last_conversation_time', sort_type = 'desc', query } = {}) {
  const q = query || `status=${status}&reopened=&sub_status=&emp_id=-1&type=&emp_queue=&priority=&viewfilter_id=&cus_customer_code=&customer_name=&customer_phone=&customer_email=&folder_id=${folder_id}`;
  return request('POST', '/api/version3/ticket/get-ticket-list', new URLSearchParams(
    { sort_by_column, sort_type, status, folder_id, page_no, page_size, response_type: 'json', query: q, type }
  ));
}

function api_get_ticket({ id, data_type, cdate, fetch_action_name = 'yes' }) {
  const now = cdate || new Date().toISOString().replace('T', ' ').slice(0, 19);
  const qs  = new URLSearchParams({ id, data_type, cdate: now, fetch_action_name });
  return request('GET', `/api/version3/ticket/get-ticket-detail?${qs}`);
}

function api_assign_ticket({ ticket_id, task_id, assign_to, task_detail }) {
  return request('POST', '/api/version3/ticket/assign-ticket',
    new URLSearchParams({ ticket_id, task_id, assign_to, task_detail }));
}

function api_resolve_tickets({ task_id, task_detail, sub_status = 'RS' }) {
  return request('POST', '/api/version3/ticket/resolve-ticket',
    new URLSearchParams({ task_id, task_detail, sub_status }));
}

function api_reopen_tickets({ task_ids, task_detail }) {
  // MCP uses task_ids (plural) — matches Kapture's reopen endpoint
  return request('POST', '/api/version3/ticket/reopen-ticket',
    new URLSearchParams({ task_ids, task_detail }));
}

function api_dispose_ticket({ task_id, ticket_id, selected_folder_list, sub_status, update_folder_id, assign_to, task_detail }) {
  return request('POST', '/api/version3/ticket/dispose-ticket', new URLSearchParams(
    { task_id, ticket_id, selected_folder_list, update_folder_id, sub_status, assign_to, task_detail }
  ));
}

function api_mark_junk({ task_id, remark }) {
  // MCP uses 'remark' (not task_detail)
  return request('POST', '/api/version3/ticket/mark-as-junk',
    new URLSearchParams({ task_id, remark }));
}

function api_search_employees({ search_value = '', offset = 0, page_size = 10 }) {
  return request('POST', '/ms/employee/api/v1/employee-search',
    new URLSearchParams({ search_value, offset, page_size }));
}

function api_get_queues() {
  return request('GET', '/api/version3/queue/get-queues');
}

function api_merge_tickets({ ticket_ids, task_ids, status = 'P' }) {
  return request('POST', '/api/version3/ticket/merge-tickets',
    new URLSearchParams({ ticket_ids, task_ids, status }));
}

// ─── OpenAI tool definitions (converted from MCP schemas) ────────────────────

const KAPTURE_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_ticket_list',
      description: 'List tickets from Kapture CRM. Use to show pending/open/resolved tickets. status: P=Pending, C=Completed, J=Junk.',
      parameters: {
        type: 'object',
        properties: {
          status:         { type: 'string', description: 'P=Pending, C=Completed, J=Junk', default: 'P' },
          type:           { type: 'string', description: 'Ticket type code. Leave blank for all. E=Email, W=WhatsApp, D=Chat, B=Call', default: '' },
          folder_id:      { type: 'string', description: 'Folder filter, -1 for all', default: '-1' },
          page_no:        { type: 'integer', default: 0 },
          page_size:      { type: 'integer', description: 'How many tickets to return', default: 20 },
          sort_by_column: { type: 'string', default: 'last_conversation_time' },
          sort_type:      { type: 'string', enum: ['asc', 'desc'], default: 'desc' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_ticket',
      description: 'Get details of a specific ticket by ID. Use data_type="TICKET" for basic info, "history" for conversation history, "NOTES" for notes.',
      parameters: {
        type: 'object',
        properties: {
          id:        { type: 'string', description: 'Ticket ID' },
          data_type: { type: 'string', description: 'TICKET | history | NOTES | SUB_TASKS | SIDE_CONVERSATIONS', default: 'TICKET' },
          cdate:     { type: 'string', description: 'Created date "YYYY-MM-DD HH:MM:SS". Leave blank for now.' },
        },
        required: ['id', 'data_type'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'assign_ticket',
      description: 'Assign a ticket to an employee. IMPORTANT: Requires BOTH ticket_id AND task_id — they are different IDs. assign_to format: "EmployeeID#EmployeeName" e.g. "217346#Himanshu". Search employees first if you need the employee ID.',
      parameters: {
        type: 'object',
        properties: {
          ticket_id:   { type: 'string', description: 'The ticket identifier (e.g. "9764070704527")' },
          task_id:     { type: 'string', description: 'The task identifier — DIFFERENT from ticket_id (e.g. "935901656")' },
          assign_to:   { type: 'string', description: 'Format: "EmployeeID#EmployeeName" e.g. "217346#Himanshu"' },
          task_detail: { type: 'string', description: 'Reason / note for this assignment' },
        },
        required: ['ticket_id', 'task_id', 'assign_to', 'task_detail'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'resolve_tickets',
      description: 'Mark one or more tickets as resolved. Uses task_id (not ticket_id).',
      parameters: {
        type: 'object',
        properties: {
          task_id:     { type: 'string', description: 'Single task ID or comma-separated task IDs' },
          task_detail: { type: 'string', description: 'Resolution note' },
          sub_status:  { type: 'string', description: 'RS=Resolved (default)', default: 'RS' },
        },
        required: ['task_id', 'task_detail'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'reopen_tickets',
      description: 'Reopen one or more closed/resolved tickets. Uses task_ids (plural, not ticket_id).',
      parameters: {
        type: 'object',
        properties: {
          task_ids:    { type: 'string', description: 'Single task ID or comma-separated task IDs' },
          task_detail: { type: 'string', description: 'Reason for reopening' },
        },
        required: ['task_ids', 'task_detail'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'dispose_ticket',
      description: 'Dispose/close a ticket with folder and status update. Requires both task_id AND ticket_id.',
      parameters: {
        type: 'object',
        properties: {
          task_id:              { type: 'string' },
          ticket_id:            { type: 'string' },
          selected_folder_list: { type: 'string', description: 'Folder ID (e.g. "1131562")' },
          sub_status:           { type: 'string', description: 'e.g. "RS", "PS", "CL"' },
          update_folder_id:     { type: 'string', description: 'Same as selected_folder_list' },
          assign_to:            { type: 'string', description: '"EmployeeID#Name" or "QUEUE#name"' },
          task_detail:          { type: 'string' },
        },
        required: ['task_id', 'ticket_id', 'selected_folder_list', 'sub_status', 'update_folder_id', 'assign_to', 'task_detail'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mark_junk',
      description: 'Mark one or more tickets as junk/spam. Uses task_id (not ticket_id) and remark.',
      parameters: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Single task ID or comma-separated task IDs' },
          remark:  { type: 'string', description: 'Reason for marking as junk' },
        },
        required: ['task_id', 'remark'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_employees',
      description: 'Search Kapture CRM employees by name, email, or username. Pass empty string to list all. Use this first when you need an employee ID for assign_ticket.',
      parameters: {
        type: 'object',
        properties: {
          search_value: { type: 'string', description: 'Name/email/username to search. Empty string = all employees.' },
          offset:       { type: 'integer', default: 0 },
          page_size:    { type: 'integer', default: 10 },
        },
        required: ['search_value'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_queues',
      description: 'List all ticket queues in Kapture CRM with their names, routing types, and employee assignments.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'merge_tickets',
      description: 'Merge multiple tickets together. Requires BOTH ticket_ids AND task_ids as comma-separated strings.',
      parameters: {
        type: 'object',
        properties: {
          ticket_ids: { type: 'string', description: 'Comma-separated ticket IDs to merge' },
          task_ids:   { type: 'string', description: 'Comma-separated task IDs to merge' },
          status:     { type: 'string', default: 'P' },
        },
        required: ['ticket_ids', 'task_ids'],
      },
    },
  },
];

// ─── Tool execution ────────────────────────────────────────────────────────────

async function executeTool(name, args) {
  logger.info(`Kapture tool call: ${name}(${JSON.stringify(args)})`);
  switch (name) {
    case 'get_ticket_list':   return api_get_ticket_list(args);
    case 'get_ticket':        return api_get_ticket({ ...args, cdate: args.cdate || new Date().toISOString().replace('T', ' ').slice(0, 19) });
    case 'assign_ticket':     return api_assign_ticket(args);
    case 'resolve_tickets':   return api_resolve_tickets(args);
    case 'reopen_tickets':    return api_reopen_tickets(args);
    case 'dispose_ticket':    return api_dispose_ticket(args);
    case 'mark_junk':         return api_mark_junk(args);
    case 'search_employees':  return api_search_employees(args);
    case 'get_queues':        return api_get_queues();
    case 'merge_tickets':     return api_merge_tickets(args);
    default:                  throw new Error(`Unknown Kapture tool: ${name}`);
  }
}

// ─── OpenAI client ─────────────────────────────────────────────────────────────
let _openai = null;
const getClient = () => {
  if (!_openai) _openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return _openai;
};

// ─── Main dispatcher ───────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are a Kapture CRM voice assistant. The user gives a natural-language CRM command.
Use the provided tools to fulfil it — you may call multiple tools in sequence if needed.
Examples:
- "assign ticket 123 to Himanshu" → first search_employees("Himanshu") to get the ID, then get_ticket("123","TICKET") to get task_id, then assign_ticket(...)
- "show pending tickets" → get_ticket_list(status="P")
- "merge tickets 123 and 456" → get both tickets first to get task_ids, then merge_tickets(...)

When done, reply in ONE concise sentence the user can hear as a voice reply.
Be specific — mention ticket IDs, counts, employee names. No markdown.
`.trim();

async function dispatchCrmCommand(command, onStep) {
  logger.info(`Kapture CRM command: "${command}"`);

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user',   content: command },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await getClient().chat.completions.create({
      model:   process.env.LLM_MODEL || 'gpt-4o',
      temperature: 0,
      max_completion_tokens: 1024,
      tools:       KAPTURE_TOOLS,
      tool_choice: 'auto',
      messages,
    });

    const msg = response.choices[0].message;
    messages.push(msg);

    // No tool calls → GPT has a final text answer
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      const reply = msg.content?.trim() || 'Done.';
      logger.info(`Kapture reply: ${reply}`);
      if (onStep) onStep(`✓ ${reply}`);
      return { success: true, message: reply };
    }

    // Execute all tool calls in this round
    for (const call of msg.tool_calls) {
      const fnName = call.function.name;
      let args;
      try { args = JSON.parse(call.function.arguments); }
      catch { args = {}; }

      if (onStep) onStep(`⚡ CRM: ${fnName}(${Object.entries(args).map(([k,v]) => `${k}=${JSON.stringify(v)}`).join(', ')})`);

      let result;
      try {
        result = await executeTool(fnName, args);
      } catch (err) {
        logger.error(`Kapture tool error (${fnName}): ${err.message}`);
        result = { error: err.message };
      }

      messages.push({
        role:         'tool',
        tool_call_id: call.id,
        content:      JSON.stringify(result).slice(0, 4000), // token limit guard
      });
    }
  }

  return { success: false, message: 'CRM operation did not complete within the step limit.' };
}

module.exports = { dispatchCrmCommand };
