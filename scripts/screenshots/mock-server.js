// Serves the app's front end (public/) with made-up meetings and people, so
// documentation screenshots never show real recordings. Used by take.js.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

const now = new Date();
const at = (daysAgo, h, m = 0) => { const d = new Date(now); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d.toISOString(); };
const min = (n) => n * 60000;

const folders = [
  { id: 1, name: 'Customers', parentId: null },
  { id: 2, name: 'Northwind Traders', parentId: 1 },
  { id: 3, name: 'Contoso', parentId: 1 },
  { id: 4, name: 'Fabrikam', parentId: 1 },
  { id: 5, name: 'Team', parentId: null },
  { id: 6, name: 'Weekly Sync', parentId: 5 },
  { id: 7, name: 'One-on-Ones', parentId: 5 },
  { id: 8, name: 'Partners', parentId: null },
  { id: 9, name: 'Conferences', parentId: null },
];
const byId = new Map(folders.map((f) => [f.id, f]));
const fpath = (f) => (f.parentId ? `${fpath(byId.get(f.parentId))} / ${f.name}` : f.name);

const kFull = (daysAgo) => ({ status: 'done', sync: 'full', missing: [], at: at(daysAgo, 18), step: null, error: null });
const meetings = [
  { id: 'of_7d1c0a5e9b2f4c6a8e3d1b0f2a4c6e81', name: 'Northwind Q4 Planning - Storage Refresh and Migration Timeline', startAt: at(0, 9, 30), durationMs: min(52), folderId: 2, tags: ['Northwind', 'Planning', 'Storage'], keepIt: kFull(0) },
  { id: 'of_2b9e4d7a1c3f5e8b0a6d2c4f7e9b1a35', name: 'Contoso Renewal Review', startAt: at(0, 13, 0), durationMs: min(31), folderId: 3, tags: ['Contoso', 'Renewals'], keepIt: { status: 'done', sync: 'partial', missing: ['Mind Map'], at: at(0, 14), step: null, error: null } },
  { id: 'of_5f3a8c1e7b9d2f4a6c0e8b3d5f7a9c12', name: 'Weekly Team Sync', startAt: at(1, 10, 0), durationMs: min(44), folderId: 6, tags: ['Team'], keepIt: kFull(1) },
  { id: 'of_9c2e5a8f1d4b7e0a3c6f9b2d5e8a1c47', name: 'Fabrikam Architecture Workshop', startAt: at(1, 14, 30), durationMs: min(73), folderId: 4, tags: ['Fabrikam', 'Architecture', 'Workshop'], keepIt: null },
  { id: 'of_3e6b9d2a5c8f1e4b7a0d3c6f9e2b5a88', name: '1:1 - Priya Shah', startAt: at(2, 16, 0), durationMs: min(26), folderId: 7, tags: ['One-on-One'], keepIt: kFull(2) },
  { id: 'of_8a1d4f7c0e3b6a9d2f5c8e1b4a7d0f63', name: 'Partner Enablement - Data Protection', startAt: at(3, 11, 0), durationMs: min(58), folderId: 8, tags: ['Partners', 'Enablement'], keepIt: kFull(3) },
  { id: 'of_6c9f2b5e8a1d4c7f0b3e6a9d2c5f8b14', name: 'Contoso Support Escalation', startAt: at(4, 8, 45), durationMs: min(19), folderId: 3, tags: ['Contoso', 'Support'], keepIt: null },
].map((m) => ({
  ...m, createdAt: new Date(Date.parse(m.startAt) + m.durationMs + min(6)).toISOString(), serialNumber: null, plaudName: m.name,
  titleSync: 'done', folderPath: m.folderId ? fpath(byId.get(m.folderId)) : null, ignored: false,
}));
const M = meetings[0];
const M_DURATION = M.durationMs;

const people = ['Dana Whitfield', 'Marcus Okafor', 'Priya Shah', 'Tom Lindqvist', 'Elena Ruiz', 'Sam Patel', 'Grace Kim', 'Leo Novak'];
const tags = ['Northwind', 'Planning', 'Storage', 'Contoso', 'Renewals', 'Team', 'Fabrikam', 'Architecture', 'Workshop', 'One-on-One', 'Partners', 'Enablement', 'Support', 'QBR', 'Pricing', 'Roadmap']
  .map((name, i) => ({ id: i + 1, name, count: meetings.filter((m) => m.tags.includes(name)).length || 1 + (i % 3) }));

const lines = [
  ['Speaker 1', 'Thanks everyone for making time. The goal today is to agree the refresh scope and a migration timeline we can commit to.'],
  ['Speaker 2', 'Sounds good. From our side the big constraint is the January change freeze, so anything disruptive has to land before mid-December.'],
  ['Speaker 3', 'We can work with that. If we stage the new arrays in November, the bulk data moves can run over three weekends.'],
  ['Speaker 2', 'Three weekends is fine as long as the finance cluster goes last. That one needs a rollback plan signed off.'],
  ['Speaker 4', 'I can put the rollback plan together this week and share it on Thursday.'],
  ['Speaker 1', 'Great. Let’s also confirm capacity: are we still sizing for forty percent growth over three years?'],
  ['Speaker 3', 'Forty percent, yes, plus snapshots. I’ll send the updated sizing sheet after the call.'],
  ['Speaker 2', 'Perfect. And can we get pricing for the extended support option before the end of the month?'],
  ['Speaker 1', 'Absolutely. I’ll have a quote to you by Friday with both support options side by side.'],
  ['Speaker 4', 'One more thing: the replication link to the DR site needs testing before cutover.'],
  ['Speaker 3', 'Agreed. Let’s schedule that for the first staging weekend.'],
];
// Spread the conversation across the whole meeting.
const total = lines.length * 4;
const step = (M_DURATION - 10000) / total;
let t = 4000;
const transcript = [];
for (let r = 0; r < 4; r++) for (const [label, text] of lines) { const len = Math.min(step - 500, 6000 + text.length * 55); transcript.push({ startMs: Math.round(t), endMs: Math.round(t + len), text, label }); t += step; }
const samples = (label) => {
  const seen = new Set();
  return transcript.filter((l) => l.label === label && !seen.has(l.text) && seen.add(l.text)).slice(0, 8)
    .map((l) => ({ startMs: l.startMs, endMs: l.endMs, text: l.text, words: l.text.split(' ').length }));
};
const talk = (label) => transcript.filter((l) => l.label === label).reduce((n, l) => n + l.endMs - l.startMs, 0);
const known = people.map((name, i) => ({ id: i + 1, name, createdAt: at(30 + i, 9), prints: 1 + (i * 3) % 7, lastSeen: at(i, 10), meetings: 1 + (i * 5) % 9 }));
const speakersData = {
  meeting: { id: M.id, name: M.name, startAt: M.startAt, durationMs: M.durationMs },
  transcript,
  speakers: [
    { label: 'Speaker 2', displayName: 'Marcus Okafor', voicePrint: { seconds: 60, consistency: 0.93 }, assignment: { speakerId: 2, name: 'Marcus Okafor', method: 'confirmed', assignedAt: at(0, 11), plaudSync: 'done', plaudSyncError: null }, suggestion: null, alike: [] },
    { label: 'Speaker 1', displayName: 'Dana Whitfield', voicePrint: { seconds: 60, consistency: 0.95 }, assignment: { speakerId: 1, name: 'Dana Whitfield', method: 'confirmed', assignedAt: at(0, 11), plaudSync: 'done', plaudSyncError: null }, suggestion: null, alike: [] },
    { label: 'Speaker 3', displayName: 'Speaker 3', voicePrint: { seconds: 60, consistency: 0.91 }, assignment: null, suggestion: { speakerId: 4, name: 'Tom Lindqvist', score: 0.83, confidence: 'high', source: 'voice' }, alike: [] },
    { label: 'Speaker 4', displayName: 'Speaker 4', voicePrint: { seconds: 41.5, consistency: 0.88 }, assignment: null, suggestion: { speakerId: 5, name: 'Elena Ruiz', score: 0.61, confidence: 'possible', source: 'voice' }, alike: [] },
  ].map((s) => ({ ...s, talkMs: talk(s.label), lines: transcript.filter((l) => l.label === s.label).length, samples: samples(s.label) })),
  knownSpeakers: known,
  thresholds: { strong: 0.7, possible: 0.55, sameRoomAlike: 0.6 },
};

const summaryHtml = `
<h3>Meeting Information</h3>
<blockquote><p>Participants: [Dana Whitfield] [Marcus Okafor] [Speaker 3] [Speaker 4]</p></blockquote>
<hr>
<h3>Key Decisions</h3>
<ul>
<li>New arrays are staged in <strong>November</strong>; bulk data moves run over <strong>three weekends</strong>, finishing before the January change freeze.</li>
<li>The finance cluster migrates <strong>last</strong>, with a signed-off rollback plan.</li>
<li>Capacity is sized for <strong>40% growth over three years</strong>, plus snapshots.</li>
</ul>
<h3>Discussion</h3>
<h4>Timeline and constraints</h4>
<ul>
<li>Northwind’s change freeze starts in January, so disruptive work must land by mid-December.</li>
<li>Replication to the DR site will be tested on the first staging weekend.</li>
</ul>
<h4>Commercials</h4>
<ul>
<li>Northwind asked for pricing on the extended support option before month end.</li>
</ul>
<h3>Action Items</h3>
<table><thead><tr><th>Owner</th><th>Action</th><th>Due</th></tr></thead><tbody>
<tr><td>Speaker 4</td><td>Draft the rollback plan for the finance cluster</td><td>Thursday</td></tr>
<tr><td>Speaker 3</td><td>Send the updated sizing sheet</td><td>Today</td></tr>
<tr><td>Dana Whitfield</td><td>Quote both support options</td><td>Friday</td></tr>
</tbody></table>`;

const vp = known.map((p) => ({
  id: p.id, name: p.name, createdAt: p.createdAt,
  prints: Array.from({ length: p.prints }, (_, j) => {
    const m = meetings[(p.id + j) % meetings.length];
    return { id: p.id * 10 + j, speakerId: p.id, fileId: m.id, meetingName: m.name, meetingStartAt: m.startAt, plaudLabel: `Speaker ${1 + ((p.id + j) % 5)}`, seconds: j % 3 ? 60 : 47.5, consistency: 0.86 + ((p.id * 7 + j) % 10) / 100, discoveredAt: m.startAt };
  }),
  meetings: Array.from({ length: p.meetings }, (_, j) => ({ speakerId: p.id, fileId: meetings[j % meetings.length].id, plaudLabel: 'Speaker 1', plaudSync: 'done' })),
}));

const libFolders = folders.map((f) => {
  const count = meetings.filter((m) => m.folderId === f.id).length + (f.id === 6 ? 11 : f.id === 7 ? 8 : f.id === 9 ? 3 : 0);
  return { ...f, count, path: fpath(f) };
}).map((f, _, all) => ({ ...f, total: f.count + all.filter((c) => c.parentId === f.id).reduce((n, c) => n + c.count, 0) }));

const app = express();
const ok = (data) => (req, res) => res.json({ ok: true, data: typeof data === 'function' ? data(req) : data });
app.get('/api/plaud/status', (req, res) => res.json({ ok: true, loggedIn: true, checkedAt: now.toISOString(), loginInProgress: false, loginError: null }));
app.get('/api/mcp/status', ok({ loginInProgress: false, loginError: null, signedIn: true, user: { email: 'you@example.com' } }));
app.get('/api/meetings', ok({ meetings, complete: true }));
app.get('/api/meetings/:id/meta', ok((req) => { const m = meetings.find((x) => x.id === req.params.id) || M; return { fileId: m.id, title: m.name, startAt: m.startAt, durationMs: m.durationMs, folderId: m.folderId, titleSync: 'done', titleSyncError: null, tags: m.tags, folderPath: m.folderPath }; }));
app.get('/api/meetings/:id/speakers', ok(speakersData));
app.get('/api/meetings/:id/plaud-sync', ok([]));
app.get('/api/meetings/:id/summary', ok({ markdown: '', html: summaryHtml, plaudUrl: 'https://web.plaud.ai/' }));
app.get('/api/meetings/:id/keepit', ok({ status: 'done', sync: 'full', items: [] }));
app.get('/api/library', ok({ folders: libFolders, tags }));
app.get('/api/library/unused', ok({ tags: [], folders: [] }));
app.get('/api/library/meetings', ok((req) => meetings.filter((m) => !req.query.folder || m.folderId === Number(req.query.folder) || (req.query.deep && byId.get(m.folderId)?.parentId === Number(req.query.folder))).map((m) => ({ id: m.id, title: m.name, startAt: m.startAt, durationMs: m.durationMs, titleSync: 'done', folderPath: m.folderPath, folderId: m.folderId, tags: m.tags }))));
app.get('/api/speakers', ok(known));
app.get('/api/voiceprints', ok(vp));
app.get('/api/keepit/overview', ok({ meetings: 42, counts: { full: 41, partial: 1, none: 0, sending: 0, failed: 0 }, running: true, health: { ok: true }, lastCheck: { checked: 42, failed: 0, at: now.toISOString() } }));
app.use('/api', (req, res) => res.status(404).json({ ok: false, error: 'not in mock' }));
app.use(express.static(path.join(APP, 'public'), { extensions: ['html'] }));
export function startMockServer(port) {
  return new Promise((resolve) => { const server = app.listen(port, '127.0.0.1', () => resolve(server)); });
}
