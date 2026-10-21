import { withPage } from './browser.js';
import { bus } from './events.js';

// Plaud's internal web API (unofficial): used only for what MCP can't give us,
// i.e. the images embedded in summaries. The login token is read from the
// headless browser (the same request headers the web app sends) and kept in
// memory only. Cloudflare rejects requests without browser-like headers.
// If the API path fails, we fall back to loading the meeting page and reading
// the same data from the page's own traffic.

const API = 'https://api.plaud.ai';
let session = null; // { headers, exp }

async function captureSession() {
  const headers = await withPage(async (page) => {
    let h = null;
    page.on('request', (r) => { if (!h && r.url().startsWith(`${API}/`) && r.headers().authorization) h = r.headers(); });
    await page.goto('https://web.plaud.ai/', { waitUntil: 'domcontentloaded', timeout: 45000 });
    for (let i = 0; i < 60 && !h; i++) await new Promise((r) => setTimeout(r, 100));
    return h;
  });
  bus.emit('plaud-session', !!headers);
  if (!headers) throw new Error('Couldn’t get a Plaud web session (is the Plaud website logged in?)');
  delete headers['x-request-id'];
  Object.assign(headers, { origin: 'https://web.plaud.ai', referer: 'https://web.plaud.ai/' });
  let exp = Date.now() + 60 * 60 * 1000;
  try {
    const claims = JSON.parse(Buffer.from(headers.authorization.split(' ')[1].split('.')[1], 'base64url').toString());
    if (claims.exp) exp = claims.exp * 1000;
  } catch {}
  session = { headers, exp };
  return session;
}

async function apiGet(path, opts) {
  return apiCall('GET', path, undefined, opts);
}

async function apiCall(method, path, body, { retry = true } = {}) {
  if (!session || Date.now() > session.exp - 5 * 60 * 1000) await captureSession();
  const headers = body === undefined ? session.headers : { ...session.headers, 'content-type': 'application/json;charset=UTF-8' };
  const res = await fetch(`${API}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  if ((res.status === 401 || res.status === 403) && retry) {
    session = null;
    return apiCall(method, path, body, { retry: false });
  }
  if (!text.startsWith('{')) throw new Error(`Plaud API returned ${res.status} (not JSON)`);
  const json = JSON.parse(text);
  if (json.status !== undefined && json.status !== 0) throw new Error(`Plaud API error ${json.status}: ${json.msg || ''}`);
  return json.data ?? json.data_file ?? json;
}

// The web app's file detail, from the API or (fallback) from the page's traffic.
async function fileDetail(fileId) {
  const id = fileId.replace(/^of_/, '');
  try {
    return { detail: await apiGet(`/file/detail/${id}`), via: 'api' };
  } catch (apiErr) {
    const detail = await withPage(async (page) => {
      let d = null;
      page.on('response', async (r) => { if (r.url().includes(`/file/detail/${id}`)) { try { d = (await r.json()).data; } catch {} } });
      await page.goto(`https://web.plaud.ai/file/${id}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      for (let i = 0; i < 100 && !d; i++) await new Promise((r) => setTimeout(r, 100));
      return d;
    });
    if (!detail) throw new Error(`Couldn’t read the meeting from Plaud (API: ${apiErr.message}; web fallback found nothing)`);
    return { detail, via: 'web' };
  }
}

// Images embedded in a meeting's AI summary, in order — the same order as the
// `[](plaud://image?…_iN)` placeholders in MCP's summary. kind is 'mark' for
// photos taken while recording, 'summary_poster' for Plaud's infographic.
// Returns [{ index, kind, url, path }] (url is signed, valid ~15 minutes).
export async function summaryImages(fileId) {
  const { detail, via } = await fileDetail(fileId);
  const pre = (detail.pre_download_content_list || []).find((c) => String(c.data_id).startsWith('auto_sum'))?.data_content || '';
  const mapping = detail.download_path_mapping || {};
  const images = [...pre.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m, i) => ({
    index: i + 1,
    path: m[1],
    kind: m[1].split('/').slice(-2, -1)[0],
    url: mapping[m[1]] || null,
  }));
  return { images, via };
}

// Everything image-related for a meeting in one call: summary images (in
// placeholder order), and highlight entries with their timestamp and picture
// (highlights reuse the photos taken while recording).
// → { summary: [{ index, kind, url }], highlights: [{ title, timestamp, url }], via }
export async function meetingMedia(fileId) {
  const { detail, via } = await fileDetail(fileId);
  const mapping = detail.download_path_mapping || {};
  const pre = detail.pre_download_content_list || [];
  const sum = pre.find((c) => String(c.data_id).startsWith('auto_sum'))?.data_content || '';
  const summary = [...sum.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((m, i) => ({
    index: i + 1, kind: m[1].split('/').slice(-2, -1)[0], url: mapping[m[1]] || null,
  }));
  const hlId = (detail.content_list || []).find((c) => c.data_type === 'high_light')?.data_id;
  let highlights = [];
  try {
    const raw = pre.find((c) => c.data_id === hlId)?.data_content;
    highlights = (raw ? JSON.parse(raw) : []).map((h) => ({ title: h.title, timestamp: h.timestamp, url: h.picture_link ? mapping[h.picture_link] || null : null }));
  } catch {}
  return { summary, highlights, via };
}

export async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Image download failed (${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

// ---- Edits (the same requests the web app sends) ----

const plainId = (fileId) => fileId.replace(/^of_/, '');

// Renames a recording. Web app: PATCH /file/<id> { filename, extra_data… }.
export async function renameMeetingApi(fileId, title) {
  await apiCall('PATCH', `/file/${plainId(fileId)}`, { filename: title, extra_data: { actionData: { hasTitleEdit: true } } });
}

// Reads one stored block (transcript JSON or note Markdown) from its signed link.
async function storedContent(link) {
  const res = await fetch(link);
  if (!res.ok) throw new Error(`Couldn’t read stored content (${res.status})`);
  let buf = Buffer.from(await res.arrayBuffer());
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = (await import('node:zlib')).gunzipSync(buf);
  return buf.toString('utf8');
}

// Plaud's own rule for putting new speaker names into notes (from its web app):
// bracketed names ([Old]) are replaced; Plaud's generic labels ("Speaker 2")
// are replaced anywhere; then repeated names on the participants line are
// collapsed. Plain mentions of a real name ("George said…") are left alone.
export function replaceSpeakerNames(text, renames) {
  if (!text) return text;
  const reEsc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let out = text, changed = false;
  for (const [from, to] of Object.entries(renames)) {
    if (!from || !to || from === to) continue;
    const f = reEsc(from);
    let next = out.replace(new RegExp(`\\[<span[^>]*>${f}<\\/span>\\]`, 'g'), `[${to}]`);
    if (/^Speaker\s+\d+$/.test(from)) {
      next = next.replace(new RegExp(`\\[${f}\\]|\\b${f}\\b`, 'g'), (m) => (m.startsWith('[') && m.endsWith(']') ? `[${to}]` : to));
    } else {
      next = next.replace(new RegExp(`\\[${f}\\]`, 'g'), `[${to}]`);
    }
    if (next !== out) { out = next; changed = true; }
  }
  return changed ? dedupeParticipants(out) : out;
}

function dedupeParticipants(text) {
  const lines = text.split('\n');
  let seen = 0;
  for (let i = 0; i < lines.length; i++) {
    const names = lines[i].match(/\[[^\]]+\]/g);
    if (lines[i]) seen++;
    if (names && names.length > 1) {
      const set = new Set();
      lines[i] = lines[i].replace(/\[([^\]]+)\]/g, (m, n) => (set.has(n) ? '' : (set.add(n), m))).replace(/\s+/g, ' ').trim();
      break;
    }
    if (seen > 10) break;
  }
  return lines.join('\n');
}

const NOT_NOTES = new Set(['transaction', 'transaction_polish', 'outline', 'high_light', 'mark_memo']);

// Renames speakers the way the web app's Name speakers → Save does:
// 1) the transcript (PATCH /file/<id> with the whole trans_result),
// 2) the polished transcript, if any (POST /ai/update_source_info),
// 3) every note tab whose text changes (POST /ai/update_note_info).
// renames: { 'Speaker 2': 'Pat Smith', … } keyed by the name Plaud shows now.
export async function renameSpeakersApi(fileId, renames) {
  const id = plainId(fileId);
  const detail = await apiGet(`/file/detail/${id}`);
  const list = detail.content_list || [];
  const done = { transcript: false, polished: false, notes: [] };

  const trans = list.find((c) => c.data_type === 'transaction');
  if (!trans?.data_link) throw new Error('This recording has no transcript to rename');
  const segments = JSON.parse(await storedContent(trans.data_link));
  let hits = 0;
  const renamed = segments.map((s) => (renames[s.speaker] ? (hits++, { ...s, speaker: renames[s.speaker] }) : s));
  if (!hits) throw new Error(`None of ${Object.keys(renames).map((n) => `"${n}"`).join(', ')} appear in the transcript`);
  await apiCall('PATCH', `/file/${id}`, {
    trans_result: renamed.map((s) => ({
      content: s.content, end_time: s.end_time, start_time: s.start_time, speaker: s.speaker,
      original_speaker: s.original_speaker ?? s.speaker, embeddingKey: s.embeddingKey ?? null,
    })),
    support_mul_summ: true,
  });
  done.transcript = true;

  const polish = list.find((c) => c.data_type === 'transaction_polish' && c.data_link);
  if (polish) {
    const raw = await storedContent(polish.data_link).catch(() => '');
    const items = raw.trim().startsWith('[') ? JSON.parse(raw) : [];
    if (items.some((s) => renames[s.speaker])) {
      const updated = items.map((s) => (renames[s.speaker] ? { ...s, speaker: renames[s.speaker] } : s));
      await apiCall('POST', '/ai/update_source_info', { file_id: id, source_id: polish.data_id, source_type: 'transaction_polish', source_content: JSON.stringify(updated) });
      done.polished = true;
    }
  }

  for (const note of list.filter((c) => !NOT_NOTES.has(c.data_type) && c.data_link)) {
    const before = await storedContent(note.data_link);
    const after = replaceSpeakerNames(before, renames);
    if (after === before) continue;
    await apiCall('POST', '/ai/update_note_info', {
      file_id: id, note_id: note.data_id, note_type: note.data_type, note_content: after,
      note_tab_name: note.data_tab_name, note_title: note.data_title,
    });
    done.notes.push(note.data_tab_name || note.data_type);
  }
  return done;
}
