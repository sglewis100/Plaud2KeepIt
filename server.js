import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { getBrowser, withPage, closeBrowser, closeInteractiveWindow } from './browser.js';
import { checkLoginStatus, startLogin, cancelLogin, logout } from './plaud.js';
import * as mcp from './plaud-mcp.js';
import * as speakers from './speakers.js';
import * as library from './library.js';
import * as keepit from './keepit-sync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 40000;
// There is no login or other security: listen on this Mac only. Setting HOST
// (e.g. 0.0.0.0) exposes everything — your Plaud account, recordings, voice
// prints and Keep It — to anyone who can reach the port.
const HOST = process.env.HOST || '127.0.0.1';
const app = express();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

app.get('/api/plaud/status', async (req, res) => {
  try {
    // ?maxAge=<ms>: a recent result is fine (used by the sign-in banner on every page)
    res.json({ ok: true, ...(await checkLoginStatus({ maxAgeMs: Number(req.query.maxAge) || 0 })) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/plaud/login', async (req, res) => {
  try {
    await startLogin();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/plaud/login/cancel', async (req, res) => {
  await cancelLogin();
  res.json({ ok: true });
});

app.post('/api/plaud/logout', async (req, res) => {
  try {
    res.json({ ok: true, ...(await logout()) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Plaud MCP ----

const mcpRoute = (fn) => async (req, res) => {
  try {
    res.json({ ok: true, data: await fn(req) });
  } catch (err) {
    res.status(err instanceof mcp.McpToolError ? 502 : 500).json({ ok: false, error: err.message });
  }
};

app.get('/api/mcp/status', mcpRoute(() => mcp.getStatus()));
app.post('/api/mcp/login', mcpRoute(() => mcp.startLogin()));
app.post('/api/mcp/logout', mcpRoute(() => mcp.logout()));
// Query: query, dateFrom, dateTo (YYYY-MM-DD), page, pageSize
app.get('/api/mcp/files', mcpRoute((req) => mcp.listFiles(req.query)));
app.get('/api/mcp/files/:id', mcpRoute((req) => mcp.getFile(req.params.id)));
app.get('/api/mcp/files/:id/notes', mcpRoute((req) => mcp.getNote(req.params.id)));
// Query: block = transaction (default) | transaction_polish | outline | mark_memo
app.get('/api/mcp/files/:id/transcript', mcpRoute((req) => mcp.getTranscript(req.params.id, req.query)));

// Meetings list for the home page. Uses list_files only.
//   ?mode=range&from=<ISO>&to=<ISO>   start time in [from, to)
//   ?mode=last&n=<1-500>
//   ?mode=search&q=<text>
app.get('/api/meetings', mcpRoute(async (req) => {
  const { mode, from, to, n, q } = req.query;
  const result = mode === 'last' ? await mcp.listLatestMeetings(n)
    : mode === 'search' ? await mcp.searchMeetings(q)
    : await mcp.listMeetingsInRange(from, to);
  // Add local tags/folder; show a title edited here until Plaud has it.
  const meta = library.metaFor(result.meetings.map((m) => m.id));
  const sent = keepit.sentMap(result.meetings.map((m) => m.id));
  const ignored = library.ignoredSet(result.meetings.map((m) => m.id));
  result.meetings = result.meetings.map((m) => {
    const x = meta.get(m.id);
    const keepIt = sent.get(m.id) || null;
    const isIgnored = ignored.has(m.id);
    if (!x) return { ...m, tags: [], folderPath: null, folderId: null, keepIt, ignored: isIgnored };
    if (x.titleSync === 'done' && x.title !== m.name) library.plaudTitleSeen(m.id, m.name);
    return { ...m, plaudName: m.name, name: x.titleSync === 'done' ? m.name : x.title, titleSync: x.titleSync, tags: x.tags, folderPath: x.folderPath, folderId: x.folderId, keepIt, ignored: isIgnored };
  });
  return result;
}));

// ---- Meeting organization: titles, tags, folders ----

const libRoute = (fn) => (req, res) => {
  try {
    res.json({ ok: true, data: fn(req) });
  } catch (err) {
    res.status(err.conflict ? 409 : 400).json({ ok: false, error: err.message, conflict: err.conflict });
  }
};

app.get('/api/library', libRoute(() => ({ folders: library.listFolders(), tags: library.listTags() })));
// ?folder=<id>|none [&deep=1] or ?tag=<id>
// Unused tags and empty folders (GET to preview, POST to remove).
app.get('/api/library/unused', libRoute(() => library.unusedItems()));
app.post('/api/library/cleanup', libRoute(() => library.cleanUpUnused()));
app.get('/api/library/meetings', libRoute((req) => library.libraryMeetings({ folderId: req.query.folder, tagId: req.query.tag, deep: !!req.query.deep })));
app.get('/api/meetings/:id/meta', libRoute((req) => library.meetingMeta(req.params.id)));
// Body: { title, folderId, tags: [names], plaudTitle, startAt, durationMs }
app.put('/api/meetings/:id/meta', libRoute((req) => library.saveMeetingMeta(req.params.id, req.body || {})));
// Body: { ignored: true|false, title? }  (hide a meeting you won't import)
app.put('/api/meetings/:id/ignore', libRoute((req) => library.setIgnored(req.params.id, req.body || {})));
app.post('/api/meetings/:id/meta/retry', libRoute((req) => library.retryTitle(req.params.id)));
app.post('/api/folders', libRoute((req) => library.createFolder(req.body || {})));
// Body: { name?, parentId? }  (parentId null = top level)
app.patch('/api/folders/:id', libRoute((req) => library.updateFolder(Number(req.params.id), req.body || {})));
// ?mode=lift (contents move up, default) | all (subfolders deleted, meetings unfiled)
app.delete('/api/folders/:id', libRoute((req) => library.deleteFolder(Number(req.params.id), req.query.mode)));
// Body: { name, merge? }  → 409 with { conflict } if the name is taken and merge isn't set
app.patch('/api/tags/:id', libRoute((req) => library.renameTag(Number(req.params.id), req.body?.name, req.body || {})));
app.delete('/api/tags/:id', libRoute((req) => library.deleteTag(Number(req.params.id))));

// ---- Send to Keep It ----

// Pre-flight: unnamed speakers, tags, folder.
app.get('/api/meetings/:id/keepit/check', mcpRoute((req) => keepit.checkMeeting(req.params.id)));
// Start a send (runs in the background); GET reports progress.
// Body (optional): { rebuild: true } replaces everything already in Keep It
// (e.g. after Plaud regenerates a summary); otherwise only missing items are sent.
app.post('/api/meetings/:id/keepit', libRoute((req) => keepit.queueSend(req.params.id, req.body?.rebuild ? { replace: ['summary', 'transcript', 'mindmap', 'highlights'] } : {})));
app.get('/api/meetings/:id/keepit', libRoute((req) => keepit.sendStatus(req.params.id)));
// Check every sent meeting against Keep It now (also runs every 5 minutes).
app.post('/api/keepit/check', mcpRoute(() => keepit.checkAll({ force: true })));
app.get('/api/keepit/overview', mcpRoute(() => keepit.overview()));

// ---- Speaker identification ----

// Transcript, per-speaker listening samples, voice-print matches and saved names.
// Costs one get_file call (cached ~45 min), plus a one-time audio download.
app.get('/api/meetings/:id/speakers', mcpRoute((req) => speakers.analyzeMeeting(req.params.id)));

// The meeting's audio, from the local cache (supports seeking via Range requests).
app.get('/api/meetings/:id/audio', async (req, res) => {
  try {
    res.sendFile(await speakers.ensureMeetingAudio(req.params.id), { headers: { 'Content-Type': 'audio/wav' } });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Body: { name, speakerId?, mode?: 'confirm' | 'merge' | 'new' }
// Without speakerId/mode, an existing speaker with the same name returns 409 + matches.
app.post('/api/meetings/:id/speakers/:label', async (req, res) => {
  try {
    res.json({ ok: true, data: await speakers.assignSpeaker(req.params.id, req.params.label, req.body || {}) });
  } catch (err) {
    if (err instanceof speakers.NameConflict) return res.status(409).json({ ok: false, conflict: true, matches: err.matches, error: err.message });
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Status of pushing this meeting's names to the Plaud website; POST retries.
app.get('/api/meetings/:id/plaud-sync', (req, res) => res.json({ ok: true, data: speakers.plaudSyncStatus(req.params.id) }));
app.post('/api/meetings/:id/plaud-sync', (req, res) => {
  speakers.queuePlaudSync(req.params.id);
  res.json({ ok: true, data: speakers.plaudSyncStatus(req.params.id) });
});

// Voice print maintenance.
const jsonRoute = (fn) => (req, res) => {
  try {
    res.json({ ok: true, data: fn(req) });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
};
app.get('/api/voiceprints', jsonRoute(() => speakers.voicePrintDatabase()));
// Body: { name, updatePlaud?: boolean }
app.patch('/api/speakers/:id', jsonRoute((req) => speakers.renamePerson(Number(req.params.id), req.body?.name, req.body || {})));
// ?ids=1,2,3 → how alike these people sound (best match between their prints)
app.get('/api/speakers/similarity', jsonRoute((req) => speakers.similarity(String(req.query.ids || '').split(',').map(Number).filter(Boolean))));
// Body: { targetId, sourceIds: [...], updatePlaud?: boolean }
app.post('/api/speakers/merge', jsonRoute((req) => speakers.mergePeople(Number(req.body?.targetId), req.body?.sourceIds || [], req.body || {})));
app.delete('/api/speakers/:id', jsonRoute((req) => speakers.deletePerson(Number(req.params.id))));
app.delete('/api/voiceprints/:id', jsonRoute((req) => speakers.deleteVoicePrint(Number(req.params.id))));

app.get('/api/speakers', (req, res) => res.json({ ok: true, data: speakers.listSpeakers() }));

// Health check for the headless browser: reports its version.
app.get('/browser/status', async (req, res) => {
  try {
    const browser = await getBrowser();
    res.json({ ok: true, version: await browser.version() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Loads a URL and returns its title. Example: /browser/test?url=https://web.plaud.ai
app.get('/browser/test', async (req, res) => {
  const url = req.query.url || 'https://example.com';
  try {
    const result = await withPage(async (page) => {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
      return { url: page.url(), title: await page.title() };
    });
    res.json({ ok: true, ...result });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  console.log(`Plaud2KeepIt listening on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(HOST)) {
    console.warn(`WARNING: listening on ${HOST}. Plaud2KeepIt has no authentication; anyone who can reach this port can use your Plaud account and Keep It.`);
  }
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await Promise.all([closeBrowser(), closeInteractiveWindow(), mcp.closeMcp()]);
    process.exit(0);
  });
}
