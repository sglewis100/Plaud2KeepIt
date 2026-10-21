import { createRequire } from 'node:module';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

// Runs Plaud's MCP server (@plaud-ai/mcp, pinned in package.json) as a child
// process over stdio. Its OAuth tokens live in ~/.plaud/tokens-mcp.json, so a
// sign-in is shared with any other MCP client on this Mac using the same package.

const require = createRequire(import.meta.url);
const SERVER_ENTRY = require.resolve('@plaud-ai/mcp/dist/index.js');

// The login tool waits for the browser OAuth callback (up to 2 minutes).
const LOGIN_TIMEOUT_MS = 150 * 1000;

let clientPromise = null;
let loginState = { inProgress: false, error: null };

function getClient() {
  if (!clientPromise) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [SERVER_ENTRY],
      // Opt out of Plaud's usage telemetry (PostHog); the server honors either flag.
      env: { ...process.env, DO_NOT_TRACK: '1', PLAUD_TELEMETRY_DISABLED: '1' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'plaud2keepit', version: '1.0.0' });
    client.onclose = () => {
      clientPromise = null;
    };
    clientPromise = client.connect(transport).then(
      () => client,
      (err) => {
        clientPromise = null;
        throw err;
      },
    );
  }
  return clientPromise;
}

export async function closeMcp() {
  const client = await clientPromise?.catch(() => null);
  clientPromise = null;
  await client?.close();
}

export class McpToolError extends Error {}

// Calls a tool and returns its result: parsed JSON when the tool returns JSON
// text, otherwise the raw text.
export async function callTool(name, args = {}, { timeout } = {}) {
  const client = await getClient();
  const result = await client.callTool({ name, arguments: args }, undefined, timeout ? { timeout } : undefined);
  const text = (result.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  if (result.isError) throw new McpToolError(text || `${name} failed`);
  if (result.structuredContent) return result.structuredContent;
  const body = unwrapUntrusted(text);
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

// Plaud wraps recording data in a prompt-injection guard meant for LLM clients:
//   <preamble>\n<untrusted-user-data-XXXX source="...">\n{json}\n</untrusted-user-data-XXXX>
// We're not an LLM, so take what's inside the tags.
function unwrapUntrusted(text) {
  // The preamble names the tag too, so anchor on the opening tag's attributes.
  const m = text.match(/<(untrusted-user-data-[\w-]+)\s[^>]*>\n?([\s\S]*?)\n?<\/\1>/);
  return m ? m[2] : text;
}

export async function getStatus() {
  const base = { loginInProgress: loginState.inProgress, loginError: loginState.error };
  try {
    return { ...base, signedIn: true, user: await callTool('get_current_user') };
  } catch (err) {
    if (err instanceof McpToolError && /not authenticated|login/i.test(err.message)) {
      return { ...base, signedIn: false, user: null };
    }
    throw err;
  }
}

// Starts the OAuth sign-in. Plaud's server opens the authorization page in the
// default browser and waits for the callback, so this runs in the background.
export function startLogin() {
  if (loginState.inProgress) return;
  loginState = { inProgress: true, error: null };
  callTool('login', {}, { timeout: LOGIN_TIMEOUT_MS })
    .catch((err) => {
      loginState.error = err.message;
    })
    .finally(() => {
      loginState.inProgress = false;
    });
}

export async function logout() {
  await callTool('logout');
  loginState.error = null;
  return getStatus();
}

// ---- Data helpers ----

export const listFiles = ({ query, dateFrom, dateTo, page, pageSize } = {}) =>
  callTool('list_files', {
    ...(query && { query }),
    ...(dateFrom && { date_from: dateFrom }),
    ...(dateTo && { date_to: dateTo }),
    ...(page && { page: Number(page) }),
    ...(pageSize && { page_size: Number(pageSize) }),
  });

export const getFile = (fileId) => callTool('get_file', { file_id: fileId });

export const getNote = (fileId) => callTool('get_note', { file_id: fileId });

// Fetches one transcript block, following next_cursor until all pages are in.
export async function getTranscript(fileId, { block } = {}) {
  const pages = [];
  let cursor;
  do {
    const page = await callTool('get_transcript', {
      file_id: fileId,
      ...(block && { block }),
      ...(cursor && { cursor }),
      limit: 500,
    });
    pages.push(page);
    cursor = page?.next_cursor;
  } while (cursor);
  return pages.length === 1 ? pages[0] : { pages };
}

// ---- Meeting listings (list_files only; never opens individual recordings) ----

const MAX_PAGE_SIZE = 100;
export const MAX_LATEST = 500;

// Plaud returns naive timestamps that are UTC.
const toInstant = (ts) => (ts ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(ts) ? ts : `${ts}Z`) : null);

function normalize(f) {
  const start = toInstant(f.start_at) || toInstant(f.created_at);
  return {
    id: f.id,
    name: f.name,
    startAt: start?.toISOString() ?? null,
    createdAt: toInstant(f.created_at)?.toISOString() ?? null,
    durationMs: f.duration ?? null,
    serialNumber: f.serial_number ?? null,
  };
}

const byStartDesc = (a, b) => (b.startAt || '').localeCompare(a.startAt || '');
const utcDate = (d) => d.toISOString().slice(0, 10);

// All recordings whose start time falls in [from, to). Plaud's date filter uses
// its own timezone, so we ask for a day of padding either side and trim exactly.
export async function listMeetingsInRange(from, to) {
  const fromD = new Date(from);
  const toD = new Date(to);
  if (isNaN(fromD) || isNaN(toD)) throw new Error('Invalid date range');
  const params = {
    date_from: utcDate(new Date(fromD.getTime() - 86400000)),
    date_to: utcDate(new Date(toD.getTime() + 86400000)),
    page_size: MAX_PAGE_SIZE,
  };
  const items = [];
  for (let page = 1; ; page++) {
    const res = await callTool('list_files', { ...params, page });
    items.push(...res.data);
    if (res.data.length < MAX_PAGE_SIZE) break;
  }
  const meetings = items
    .map(normalize)
    .filter((m) => m.startAt && new Date(m.startAt) >= fromD && new Date(m.startAt) < toD)
    .sort(byStartDesc);
  return { meetings, complete: true };
}

// The n most recent recordings.
export async function listLatestMeetings(n) {
  n = Math.max(1, Math.min(MAX_LATEST, Math.floor(Number(n)) || 10));
  const items = [];
  for (let page = 1; items.length < n; page++) {
    const pageSize = Math.max(10, Math.min(MAX_PAGE_SIZE, n));
    const res = await callTool('list_files', { page, page_size: pageSize });
    items.push(...res.data);
    if (res.data.length < pageSize) break;
  }
  return { meetings: items.slice(0, n).map(normalize).sort(byStartDesc), complete: true };
}

// Name search. Plaud scans only the newest 500 recordings for this.
export async function searchMeetings(query) {
  if (!query?.trim()) throw new Error('Enter something to search for');
  const res = await callTool('list_files', { query: query.trim() });
  return {
    meetings: res.data.map(normalize).sort(byStartDesc),
    complete: res.complete !== false,
    scanned: res.scanned,
    scannedBackTo: res.scanned_back_to ?? null,
    note: res.note ?? null,
  };
}
