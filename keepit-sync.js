import { execFile } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { db, DATA_DIR } from './db.js';
import { bus } from './events.js';
import * as mcp from './plaud-mcp.js';
import { meetingMedia, download } from './plaud-api.js';
import { meetingMeta, applyFromKeepIt } from './library.js';
import { summaryHtml, buildRtfd, transcriptMarkdown, highlightsMarkdown } from './note-builder.js';
import { renderMindMapPng } from './mindmap.js';
import { ensureFolderPath, importFile, trashItem, readItems, updateItem, isRunning, keepItHealth, resetHealth } from './keepit.js';

// Meetings in Keep It, kept in step both ways.
//
// Sending: up to four items per meeting, in its folder with its tags —
//   Summary (note, images in place) · Transcript (note) · Mind Map (PNG) ·
//   Highlights (note, only when the meeting has them).
// Only what's missing is sent; "replace" rebuilds items whose content changed
// (e.g. after speakers are renamed).
//
// Two-way sync (three-way merge against the last agreed state):
//   folder — changed on one side → the other follows; changed on both → Keep It wins
//   tags   — additions and removals from either side are combined
//   title  — app → Keep It item names (Keep It renames don't flow back)
//   deleted items in Keep It → the meeting shows as partially (or not) in Keep It

const run = promisify(execFile);
const TMP = path.join(DATA_DIR, 'keepit-tmp');
const KINDS = ['summary', 'transcript', 'mindmap', 'highlights'];
const LABEL = { summary: 'Summary', transcript: 'Transcript', mindmap: 'Mind Map', highlights: 'Highlights' };
// Items that show speaker names (rebuilt when speakers are renamed).
const NAMED_KINDS = ['summary', 'transcript', 'mindmap', 'highlights'];
// Gentle on Keep It (see keepit.js): background checks are infrequent.
const CHECK_EVERY_MS = 30 * 60 * 1000;
const LIST_CHECK_MIN_GAP_MS = 10 * 60 * 1000;
const QUIET_AFTER_SEND_MS = 2 * 60 * 1000;

db.exec(`
  CREATE TABLE IF NOT EXISTS keepit_items (
    file_id    TEXT NOT NULL,
    kind       TEXT NOT NULL,             -- summary | transcript | mindmap | highlights
    keepit_id  TEXT NOT NULL,
    link       TEXT,
    name       TEXT,
    sent_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (file_id, kind)
  );
  CREATE TABLE IF NOT EXISTS keepit_sends (
    file_id     TEXT PRIMARY KEY,
    status      TEXT NOT NULL,            -- running | done | failed
    step        TEXT,
    error       TEXT,
    folder_path TEXT,
    started_at  TEXT,
    finished_at TEXT
  );
`);
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
for (const [col, type] of [['meeting_start', 'TEXT'], ['expected', 'TEXT'], ['synced_folder', 'TEXT'], ['synced_tags', 'TEXT'], ['synced_title', 'TEXT'], ['sent_kinds', 'TEXT'], ['checked_at', 'TEXT']]) {
  if (!cols('keepit_sends').includes(col)) db.exec(`ALTER TABLE keepit_sends ADD COLUMN ${col} ${type}`);
}
if (!cols('keepit_items').includes('missing')) db.exec('ALTER TABLE keepit_items ADD COLUMN missing INTEGER NOT NULL DEFAULT 0');
// 1 once the item's creation date has been set to the meeting's date.
if (!cols('keepit_items').includes('dated')) db.exec('ALTER TABLE keepit_items ADD COLUMN dated INTEGER NOT NULL DEFAULT 0');
// Sends from before "expected" existed: what was sent is what's expected.
db.exec(`UPDATE keepit_sends SET expected = (SELECT json_group_array(kind) FROM keepit_items i WHERE i.file_id = keepit_sends.file_id)
         WHERE expected IS NULL`);

const plaudLink = (fileId) => `https://web.plaud.ai/file/${fileId.replace(/^of_/, '')}`;
const safeFile = (s) => s.replace(/[/:\\]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 180);
const itemName = (title, kind) => `${safeFile(title)} — ${LABEL[kind]}`;
const isGeneric = (name) => /^speaker\s*\d+$/i.test(name || '');
const toDate = (s) => new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
const lc = (a) => a.map((x) => x.toLowerCase());
const sameSet = (a, b) => lc(a).sort().join('\u0000') === lc(b).sort().join('\u0000');
const normPath = (p) => (p || '').split('/').map((x) => x.trim().toLowerCase()).filter(Boolean).join(' / ');
const json = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };

// ---- State: fully / partially / not in Keep It ----

function present(fileId) {
  return db.prepare('SELECT kind, keepit_id AS id, link, name, sent_at AS sentAt FROM keepit_items WHERE file_id = ? AND missing = 0').all(fileId);
}

function keepItState(fileId) {
  const s = db.prepare('SELECT * FROM keepit_sends WHERE file_id = ?').get(fileId);
  if (!s) return null;
  const have = new Set(present(fileId).map((i) => i.kind));
  const expected = json(s.expected, []);
  const missing = expected.filter((k) => !have.has(k));
  const sync = !have.size ? 'none' : missing.length ? 'partial' : 'full';
  return {
    status: s.status, step: s.step, error: s.error, folderPath: s.folder_path,
    startedAt: s.started_at, finishedAt: s.finished_at, checkedAt: s.checked_at,
    sync, present: [...have], missing: missing.map((k) => LABEL[k]), sentKinds: json(s.sent_kinds, []),
  };
}

export function sendStatus(fileId) {
  const st = keepItState(fileId);
  return st ? { ...st, items: present(fileId) } : null;
}

// For the meetings list: { status, sync: 'full'|'partial'|'none', missing, at }
export function sentMap(fileIds) {
  const out = new Map();
  for (const id of fileIds) {
    const st = keepItState(id);
    if (st) out.set(id, { status: st.status, sync: st.sync, missing: st.missing, at: st.finishedAt, step: st.step, error: st.error });
  }
  kickCheck();
  return out;
}

// ---- Pre-flight check (for the app's warnings) ----

export async function checkMeeting(fileId) {
  const f = await mcp.getFile(fileId);
  const segs = JSON.parse(f.source_list?.find((s) => s.data_type === 'transaction')?.data_content || '[]');
  const lines = new Map();
  for (const s of segs) lines.set(s.speaker, (lines.get(s.speaker) || 0) + 1);
  const meta = meetingMeta(fileId);
  return {
    title: meta.titleSync && meta.titleSync !== 'done' ? meta.title : f.name,
    speakers: [...lines].map(([name, n]) => ({ name, lines: n, generic: isGeneric(name) })),
    unnamed: [...lines].filter(([name]) => isGeneric(name)).map(([name, n]) => ({ name, lines: n })),
    tags: meta.tags,
    folderPath: meta.folderPath,
    folderId: meta.folderId,
    keepIt: keepItState(fileId),
  };
}

// ---- One job at a time (Keep It + the shared browser) ----

let chain = Promise.resolve();
const enqueue = (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
const setStep = (fileId, step) => db.prepare('UPDATE keepit_sends SET step = ? WHERE file_id = ?').run(step, fileId);

// opts.replace: kinds to rebuild even if present · opts.waitForNames: speaker
// names to wait for in Plaud's transcript (MCP lags a few seconds after a rename).
export function queueSend(fileId, opts = {}) {
  const cur = db.prepare('SELECT status FROM keepit_sends WHERE file_id = ?').get(fileId);
  if (cur?.status === 'running') return sendStatus(fileId);
  const meta = meetingMeta(fileId);
  if (!meta.folderId) throw new Error('Pick a folder first');
  db.prepare(`INSERT INTO keepit_sends (file_id, status, step, error, folder_path, started_at, finished_at)
              VALUES (?, 'running', 'Waiting…', NULL, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), NULL)
              ON CONFLICT (file_id) DO UPDATE SET status = 'running', step = 'Waiting…', error = NULL,
                started_at = excluded.started_at, finished_at = NULL`)
    .run(fileId, meta.folderPath);
  enqueue(() => send(fileId, opts));
  return sendStatus(fileId);
}

async function send(fileId, { replace = [], waitForNames = [] } = {}) {
  const t0 = Date.now();
  const dir = path.join(TMP, fileId);
  try {
    // Bring our records up to date with Keep It first (moved/deleted items).
    await syncMeetingNow(fileId).catch(() => {});
    const meta = meetingMeta(fileId);
    if (!meta.folderPath) throw new Error('Pick a folder first');

    // 1) Content (MCP)
    setStep(fileId, 'Reading the meeting from Plaud…');
    let f = await mcp.getFile(fileId);
    if (waitForNames.length) {
      setStep(fileId, 'Waiting for Plaud to show the new names…');
      for (let i = 0; i < 12 && !namesShown(f, waitForNames); i++) {
        await new Promise((r) => setTimeout(r, 5000));
        f = await mcp.getFile(fileId);
      }
    }
    const notes = await mcp.getNote(fileId);
    const title = meta.titleSync && meta.titleSync !== 'done' && meta.title ? meta.title : f.name;
    const summaryMd = notes.find((n) => n.data_type === 'auto_sum_note')?.data_content || '';
    const highlightsMd = notes.find((n) => n.data_type === 'high_light')?.data_content || '';
    const segs = JSON.parse(f.source_list?.find((s) => s.data_type === 'transaction')?.data_content || '[]');

    // What this meeting can have in Keep It, and what to send now.
    const available = KINDS.filter((k) => (k === 'transcript' ? segs.length : k === 'highlights' ? highlightsMd.trim() : summaryMd.trim()));
    if (!available.length) throw new Error('Plaud has no summary or transcript for this meeting yet');
    const have = new Map(present(fileId).map((i) => [i.kind, i]));
    const todo = available.filter((k) => !have.has(k) || replace.includes(k));
    db.prepare('UPDATE keepit_sends SET expected = ? WHERE file_id = ?').run(JSON.stringify(available), fileId);
    if (!todo.length) {
      finish(fileId, [], meta, title);
      console.log(`Keep It: ${fileId} already has everything`);
      return;
    }

    const start = toDate(f.start_at);
    db.prepare('UPDATE keepit_sends SET meeting_start = ? WHERE file_id = ?').run(start.toISOString(), fileId);
    const when = start.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    const minutes = `${Math.round(f.duration / 60000)} min`;
    const openLink = `<a href="${plaudLink(fileId)}">Open in Plaud</a>`;

    // 2) Images (API, only if an item being built needs them)
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir, { recursive: true });
    const needImages = (todo.includes('summary') && /plaud:\/\/image/.test(summaryMd)) || todo.includes('highlights');
    let media = { summary: [], highlights: [] };
    if (needImages) {
      setStep(fileId, 'Downloading images…');
      media = await meetingMedia(fileId);
    }
    const prep = async (url, name) => {
      if (!url) return null;
      const raw = path.join(dir, `${name}-raw.png`), small = path.join(dir, `${name}.png`);
      await writeFile(raw, await download(url));
      // 1040px at 144 dpi → shows 520pt wide, sharp on retina screens.
      await run('sips', ['-Z', '1040', '-s', 'format', 'png', '-s', 'dpiWidth', '144', '-s', 'dpiHeight', '144', raw, '--out', small]);
      const { stdout } = await run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', small]);
      const [w, h] = [...stdout.matchAll(/: (\d+)/g)].map((m) => Number(m[1]));
      return { file: `${name}.png`, data: await readFile(small), width: w / 2, height: h / 2 };
    };

    // 3) Build
    setStep(fileId, `Building ${todo.map((k) => LABEL[k]).join(', ')}…`);
    const built = [];
    if (todo.includes('summary')) {
      const imgs = new Map();
      for (const im of media.summary) { const p = await prep(im.url, `summary-${im.index}`); if (p) imgs.set(im.index, p); }
      const html = summaryHtml(summaryMd, { title, metaLines: [`${when} · ${minutes} · AI summary from Plaud`, openLink], images: imgs });
      built.push({ kind: 'summary', file: await buildRtfd(path.join(dir, 'summary'), itemName(title, 'summary'), html, imgs), asNote: true });
    }
    if (todo.includes('transcript')) {
      const { markdown, turns } = transcriptMarkdown(segs);
      const html = summaryHtml(markdown, { title, metaLines: [`${when} · ${minutes} · Transcript from Plaud · ${segs.length} lines in ${turns} turns`, openLink] });
      built.push({ kind: 'transcript', file: await buildRtfd(path.join(dir, 'transcript'), itemName(title, 'transcript'), html), asNote: true });
    }
    if (todo.includes('highlights')) {
      const withPics = media.highlights.filter((h) => h.url);
      const imgs = new Map();
      for (let i = 0; i < withPics.length; i++) { const p = await prep(withPics[i].url, `highlight-${i + 1}`); if (p) imgs.set(i + 1, p); }
      const md = highlightsMarkdown(highlightsMd, media.highlights.map((h) => h.timestamp));
      const html = summaryHtml(md, { title, metaLines: [`${when} · ${minutes} · Highlights from Plaud`, openLink], images: imgs });
      built.push({ kind: 'highlights', file: await buildRtfd(path.join(dir, 'highlights'), itemName(title, 'highlights'), html, imgs), asNote: true });
    }
    if (todo.includes('mindmap')) {
      setStep(fileId, 'Drawing the mind map…');
      const png = path.join(dir, `${itemName(title, 'mindmap')}.png`);
      await writeFile(png, await renderMindMapPng(summaryMd, title));
      built.push({ kind: 'mindmap', file: png, asNote: false });
    }

    // 4) Keep It
    setStep(fileId, `Sending to Keep It (${meta.folderPath})…`);
    const folder = await ensureFolderPath(meta.folderPath.split(' / '));
    const save = db.prepare(`INSERT OR REPLACE INTO keepit_items (file_id, kind, keepit_id, link, name, missing) VALUES (?, ?, ?, ?, ?, 0)`);
    for (const b of built.sort((a, c) => KINDS.indexOf(a.kind) - KINDS.indexOf(c.kind))) {
      const old = have.get(b.kind);
      if (old) await trashItem(old.id).catch(() => {}); // replacing; already gone is fine
      const item = await importFile(b.file, {
        folderId: folder.id,
        name: itemName(title, b.kind),
        tags: meta.tags,
        comments: `Plaud recording ${fileId} · ${LABEL[b.kind]} · sent by Plaud2KeepIt`,
        source: `${plaudLink(fileId)}#${b.kind}`,
        asNote: b.asNote,
        createdAt: start,
      });
      save.run(fileId, b.kind, item.id, item.link, item.name);
      db.prepare('UPDATE keepit_items SET dated = 1 WHERE file_id = ? AND kind = ?').run(fileId, b.kind);
    }
    finish(fileId, built.map((b) => b.kind), meta, title);
    lastSendAt = Date.now();
    console.log(`Sent ${fileId} to Keep It (${meta.folderPath}): ${built.map((b) => b.kind).join(', ')} in ${((Date.now() - t0) / 1000).toFixed(1)}s${needImages ? ` (images via ${media.via})` : ''}`);
  } catch (err) {
    db.prepare(`UPDATE keepit_sends SET status = 'failed', step = NULL, error = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE file_id = ?`).run(err.message, fileId);
    console.error(`Keep It send failed for ${fileId}: ${err.message}`);
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function namesShown(f, names) {
  const segs = JSON.parse(f.source_list?.find((s) => s.data_type === 'transaction')?.data_content || '[]');
  const shown = new Set(segs.map((s) => s.speaker));
  return names.every((n) => shown.has(n));
}

// After a send the two sides agree: remember that state.
function finish(fileId, sentKinds, meta, title) {
  db.prepare(`UPDATE keepit_sends SET status = 'done', step = NULL, error = NULL, folder_path = ?, sent_kinds = ?,
                synced_folder = ?, synced_tags = ?, synced_title = ?, finished_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE file_id = ?`)
    .run(meta.folderPath, JSON.stringify(sentKinds), meta.folderPath, JSON.stringify(meta.tags), title, fileId);
}

// ---- Two-way sync ----

// Brings one meeting's app record and Keep It items into agreement.
async function syncMeetingNow(fileId) {
  const s = db.prepare('SELECT * FROM keepit_sends WHERE file_id = ?').get(fileId);
  const rows = db.prepare('SELECT kind, keepit_id FROM keepit_items WHERE file_id = ?').all(fileId);
  if (!s || !rows.length) return;
  const items = await readItems(rows.map((r) => r.keepit_id));
  const byId = new Map(items.map((i) => [i.id, i]));
  const mark = db.prepare('UPDATE keepit_items SET missing = ? WHERE file_id = ? AND kind = ?');
  const live = [];
  for (const r of rows) {
    const it = byId.get(r.keepit_id);
    const gone = !it?.exists || it.deleted;
    mark.run(gone ? 1 : 0, fileId, r.kind);
    if (!gone) live.push({ ...it, kind: r.kind });
  }
  db.prepare(`UPDATE keepit_sends SET checked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE file_id = ?`).run(fileId);
  if (!live.length) return; // nothing left to keep in step

  // K = Keep It (summary first), A = app, S = last agreed
  const rep = KINDS.map((k) => live.find((i) => i.kind === k)).find(Boolean);
  const A = meetingMeta(fileId);
  // Sends from before agreed states were kept: start from the app's state.
  const S = s.synced_folder == null
    ? { folder: A.folderPath, tags: A.tags, title: A.title }
    : { folder: s.synced_folder, tags: json(s.synced_tags, []), title: s.synced_title };
  const K = { folder: rep.folderPath, tags: rep.tags };

  // Folder
  let folder = A.folderPath;
  const kMoved = normPath(K.folder) !== normPath(S.folder);
  const aMoved = normPath(A.folderPath) !== normPath(S.folder);
  if (kMoved && (!aMoved || normPath(A.folderPath) !== normPath(K.folder))) {
    if (aMoved) console.warn(`Keep It sync conflict for ${fileId}: folder changed on both sides; keeping Keep It's (${K.folder})`);
    folder = K.folder;
    applyFromKeepIt(fileId, { folderPath: folder });
  }

  // Tags: combine what each side added and removed since the last agreement.
  const added = [...K.tags, ...A.tags].filter((t) => !lc(S.tags).includes(t.toLowerCase()));
  const removed = new Set([...lc(S.tags).filter((t) => !lc(K.tags).includes(t)), ...lc(S.tags).filter((t) => !lc(A.tags).includes(t))]);
  const tags = [];
  for (const t of [...S.tags, ...added]) {
    if (!removed.has(t.toLowerCase()) && !lc(tags).includes(t.toLowerCase())) tags.push(t);
  }
  if (!sameSet(tags, A.tags)) applyFromKeepIt(fileId, { tags });

  // Title (app → Keep It names)
  const title = A.title || S.title;

  // Push to Keep It whatever differs.
  const target = normPath(folder) !== normPath(rep.folderPath) || live.some((i) => normPath(i.folderPath) !== normPath(folder))
    ? await ensureFolderPath(folder.split(' / ')) : null;
  const dated = new Set(db.prepare('SELECT keepit_id FROM keepit_items WHERE file_id = ? AND dated = 1').all(fileId).map((r) => r.keepit_id));
  // Sent before start times were recorded: look it up once.
  let startIso = s.meeting_start || A.startAt;
  if (!startIso) startIso = await mcp.getFile(fileId).then((f) => toDate(f.start_at).toISOString(), () => null);
  if (startIso && !s.meeting_start) db.prepare('UPDATE keepit_sends SET meeting_start = ? WHERE file_id = ?').run(new Date(startIso).toISOString(), fileId);
  const meetingStart = startIso ? new Date(startIso) : null;
  for (const it of live) {
    const change = {};
    if (meetingStart && !dated.has(it.id)) change.createdAt = meetingStart;
    if (target && normPath(it.folderPath) !== normPath(folder)) change.folderId = target.id;
    if (!sameSet(it.tags, tags)) change.tags = tags;
    const wantName = itemName(title, it.kind);
    if (title && it.name !== wantName) change.name = wantName;
    if (Object.keys(change).length) {
      await updateItem(it.id, change);
      if (change.createdAt) db.prepare('UPDATE keepit_items SET dated = 1 WHERE keepit_id = ?').run(it.id);
      if (change.name) db.prepare('UPDATE keepit_items SET name = ? WHERE file_id = ? AND kind = ?').run(change.name, fileId, it.kind);
    }
  }
  db.prepare('UPDATE keepit_sends SET synced_folder = ?, synced_tags = ?, synced_title = ?, folder_path = ? WHERE file_id = ?')
    .run(folder, JSON.stringify(tags), title, folder, fileId);
}

export const syncMeeting = (fileId) => enqueue(() => syncMeetingNow(fileId));

// Every meeting that's been sent. Skipped when Keep It isn't running (checks
// never launch it), isn't responding, or was just written to by a send.
let lastCheck = 0;
let lastResult = null;
let lastSendAt = 0;
export async function checkAll({ force = false } = {}) {
  if (force) resetHealth();
  if (!force && Date.now() - lastCheck < LIST_CHECK_MIN_GAP_MS) return { skipped: 'checked recently' };
  if (!force && Date.now() - lastSendAt < QUIET_AFTER_SEND_MS) return { skipped: 'a send just finished' };
  if (!keepItHealth().ok) return { skipped: keepItHealth().message };
  lastCheck = Date.now();
  if (!(await isRunning())) return (lastResult = { skipped: 'Keep It isn’t running', at: new Date().toISOString() });
  const ids = db.prepare(`SELECT file_id FROM keepit_sends WHERE status != 'running'`).all().map((r) => r.file_id);
  let failed = 0;
  for (const id of ids) {
    try {
      await enqueue(() => syncMeetingNow(id));
    } catch (err) {
      failed++;
      console.error(`Keep It check failed for ${id}: ${err.message}`);
      if (!keepItHealth().ok) break; // stop hammering a stuck Keep It
    }
  }
  return (lastResult = { checked: ids.length, failed, at: new Date().toISOString(), ...(keepItHealth().ok ? {} : { notResponding: true }) });
}
function kickCheck() { checkAll().catch(() => {}); }
setInterval(kickCheck, CHECK_EVERY_MS).unref();

// For Settings: how meetings stand in Keep It, and the last check.
export async function overview() {
  const ids = db.prepare('SELECT file_id FROM keepit_sends').all().map((r) => r.file_id);
  const counts = { full: 0, partial: 0, none: 0, sending: 0, failed: 0 };
  for (const id of ids) {
    const st = keepItState(id);
    if (st.status === 'running') counts.sending++;
    else if (st.status === 'failed' && st.sync === 'none') counts.failed++;
    else counts[st.sync]++;
  }
  return { meetings: ids.length, counts, running: await isRunning(), health: keepItHealth(), lastCheck: lastResult };
}

// ---- Reacting to changes made in the app ----

const hasItems = (fileId) => !!db.prepare('SELECT 1 FROM keepit_items WHERE file_id = ? AND missing = 0').get(fileId);

bus.on('meta-changed', (fileIds) => {
  for (const id of fileIds) if (hasItems(id)) syncMeeting(id).catch((err) => console.error(`Keep It update failed for ${id}: ${err.message}`));
});

// New speaker names in Plaud → rebuild the items that show names.
bus.on('speakers-synced', (fileId, names) => {
  if (!hasItems(fileId)) return;
  const kinds = present(fileId).map((i) => i.kind).filter((k) => NAMED_KINDS.includes(k));
  try {
    queueSend(fileId, { replace: kinds, waitForNames: names });
  } catch (err) {
    console.error(`Keep It resync after renaming speakers failed for ${fileId}: ${err.message}`);
  }
});

// A send interrupted by a restart is marked failed (it can simply be sent again).
db.prepare(`UPDATE keepit_sends SET status = 'failed', step = NULL, error = 'Interrupted by a restart; send again' WHERE status = 'running'`).run();
