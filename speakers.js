import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { db, tx, DATA_DIR } from './db.js';
import * as mcp from './plaud-mcp.js';
import { updateSpeakerNames, MAX_SPEAKER_NAME } from './plaud.js';
import { bus } from './events.js';
import { MODEL_NAME, decodeTo16k, encodeWav, decodeWav, pickSegments, voicePrint, cosine, toBlob, fromBlob } from './voiceprint.js';

// Match thresholds (cosine similarity between ERes2Net voice prints), from
// labeled meetings: the same person across meetings scored 0.76–0.92; different
// people at most 0.49 (two similar voices on call audio), and different people
// in the same meeting at most 0.39.
export const THRESHOLDS = { strong: 0.7, possible: 0.55, sameRoomAlike: 0.6 };
const STRONG_MATCH = THRESHOLDS.strong;
const POSSIBLE_MATCH = THRESHOLDS.possible;
const SAME_ROOM_ALIKE = THRESHOLDS.sameRoomAlike;

const SAMPLES_PER_SPEAKER = 8;
const AUDIO_DIR = path.join(DATA_DIR, 'audio');
const MEETING_TTL_MS = 45 * 60 * 1000; // Plaud's audio links expire after 1 hour

const isGenericLabel = (s) => /^speaker\s*\d+$/i.test(s || '');

// ---- Meeting data (one get_file call per meeting, cached) ----

const meetingCache = new Map();

async function getMeeting(fileId, { fresh = false } = {}) {
  const hit = meetingCache.get(fileId);
  if (hit && !fresh && Date.now() - hit.at < MEETING_TTL_MS) return hit.value;

  const file = await mcp.getFile(fileId);
  const raw = file.source_list?.find((s) => s.data_type === 'transaction')?.data_content;
  let segments = raw ? JSON.parse(raw) : null;
  if (!segments?.length) segments = (await mcp.getTranscript(fileId)).segments || [];

  const value = {
    id: file.id,
    name: file.name,
    startAt: file.start_at ? new Date(/Z$/.test(file.start_at) ? file.start_at : `${file.start_at}Z`).toISOString() : null,
    durationMs: file.duration,
    audioUrl: file.presigned_url,
    // `original_speaker` is Plaud's stable label ("Speaker 2"); `speaker` is the
    // current display name, which changes once someone is named in Plaud.
    segments: segments
      .map((s) => ({
        startMs: s.start_time,
        endMs: s.end_time,
        text: s.content,
        label: s.original_speaker || s.speaker,
        speaker: s.speaker,
      }))
      .sort((a, b) => a.startMs - b.startMs),
  };
  meetingCache.set(fileId, { at: Date.now(), value });
  return value;
}

// ---- Audio (cached on disk; also served to the browser for playback) ----

export function audioPath(fileId, ext = 'ogg') {
  if (!/^[\w-]+$/.test(fileId)) throw new Error('Bad file id');
  return path.join(AUDIO_DIR, `${fileId}.${ext}`);
}

async function ensureAudio(meeting) {
  const file = audioPath(meeting.id);
  if (existsSync(file)) return file;
  await mkdir(AUDIO_DIR, { recursive: true });
  let res = await fetch(meeting.audioUrl);
  if (res.status === 403) {
    // Link expired: get a fresh one.
    const fresh = await getMeeting(meeting.id, { fresh: true });
    res = await fetch(fresh.audioUrl);
  }
  if (!res.ok) throw new Error(`Audio download failed (${res.status})`);
  const tmp = `${file}.part`;
  await writeFile(tmp, Buffer.from(await res.arrayBuffer()));
  await rename(tmp, file);
  return file;
}

// Decoded 16 kHz audio, cached as WAV next to the original. The WAV is also what
// the browser plays, so playback lines up exactly with what was analyzed.
async function ensurePcm(meeting) {
  const wav = audioPath(meeting.id, 'wav');
  if (existsSync(wav)) return { wav, samples: null };
  const samples = await decodeTo16k(await readFile(await ensureAudio(meeting)));
  const tmp = `${wav}.part`;
  await writeFile(tmp, encodeWav(samples));
  await rename(tmp, wav);
  return { wav, samples };
}

const pcmInflight = new Map();
function ensurePcmOnce(meeting) {
  if (!pcmInflight.has(meeting.id)) pcmInflight.set(meeting.id, ensurePcm(meeting).finally(() => pcmInflight.delete(meeting.id)));
  return pcmInflight.get(meeting.id);
}

// Path of the WAV the browser plays.
export async function ensureMeetingAudio(fileId) {
  return (await ensurePcmOnce(await getMeeting(fileId))).wav;
}

// ---- Voice prints for each label in a meeting (cached in meeting_prints) ----

const inflight = new Map();

async function meetingPrints(meeting, labels) {
  const rows = db
    .prepare('SELECT plaud_label, embedding, seconds, consistency FROM meeting_prints WHERE file_id = ? AND model = ?')
    .all(meeting.id, MODEL_NAME);
  const prints = new Map(rows.map((r) => [r.plaud_label, { ...r, embedding: fromBlob(r.embedding) }]));
  const missing = labels.filter((l) => !prints.has(l));
  if (!missing.length) return prints;

  // Only one decode per meeting at a time.
  if (!inflight.has(meeting.id)) {
    inflight.set(meeting.id, (async () => {
      const pcm = await ensurePcmOnce(meeting);
      const audio = pcm.samples || decodeWav(await readFile(pcm.wav));
      const segs = meeting.segments.map((s) => ({ start_time: s.startMs, end_time: s.endMs, speaker: s.label }));
      const insert = db.prepare(`INSERT OR REPLACE INTO meeting_prints
        (file_id, plaud_label, embedding, model, seconds, consistency) VALUES (?, ?, ?, ?, ?, ?)`);
      for (const label of missing) {
        const vp = voicePrint(audio, pickSegments(segs, label));
        if (vp) insert.run(meeting.id, label, toBlob(vp.embedding), MODEL_NAME, vp.seconds, vp.consistency);
      }
    })().finally(() => inflight.delete(meeting.id)));
  }
  await inflight.get(meeting.id);
  return meetingPrints(meeting, []);
}

// ---- Listening samples: 8 short passages per speaker, spread over the meeting ----

const sentenceCount = (t) => (t.match(/[.!?](\s|$)/g) || []).length || (t.trim() ? 1 : 0);

// Plaud sometimes stores a long monologue as one segment. Keep the first 2–4
// sentences (~60 words) and estimate where they end in the audio, assuming an
// even speaking rate across the segment.
function trimPassage(startMs, endMs, text) {
  const sentences = text.match(/[^.!?]+[.!?]+(\s+|$)|[^.!?]+$/g) || [text];
  let kept = '';
  for (const s of sentences) {
    const next = kept + s;
    const n = (next.match(/[.!?](\s|$)/g) || []).length;
    if (kept && (n > 4 || (n > 2 && next.split(/\s+/).length > 60))) break;
    kept = next;
  }
  kept = kept.trim();
  const end = kept.length < text.length ? startMs + Math.round((endMs - startMs) * (kept.length / text.length)) + 400 : endMs;
  return { startMs, endMs: Math.min(endMs, end), text: kept, words: kept.split(/\s+/).length };
}

function buildSamples(segments, label) {
  // Group consecutive segments by the same speaker into turns.
  const turns = [];
  for (const s of segments) {
    const last = turns.at(-1);
    if (last && last.label === s.label && s.startMs - last.segs.at(-1).endMs < 1500) last.segs.push(s);
    else turns.push({ label: s.label, segs: [s] });
  }

  // From each of this speaker's turns, take a passage of 2–4 sentences (≤ ~25s).
  const passages = turns
    .filter((t) => t.label === label)
    .map((t) => {
      const segs = [];
      for (const s of t.segs) {
        segs.push(s);
        const text = segs.map((x) => x.text).join(' ');
        const n = sentenceCount(text);
        if (n >= 4 || (n >= 2 && s.endMs - segs[0].startMs > 12000) || s.endMs - segs[0].startMs > 25000) break;
      }
      return trimPassage(segs[0].startMs, segs.at(-1).endMs, segs.map((x) => x.text).join(' ').trim());
    })
    .filter((p) => p.text);

  // Prefer substantial passages; fall back to short ones for quiet speakers.
  const good = passages.filter((p) => p.words >= 8 && p.endMs - p.startMs >= 2500);
  const pool = good.length >= SAMPLES_PER_SPEAKER ? good : passages;
  if (pool.length <= SAMPLES_PER_SPEAKER) return pool;

  // Split the timeline into equal bins and take the wordiest passage in each.
  const chosen = [];
  for (let i = 0; i < SAMPLES_PER_SPEAKER; i++) {
    const bin = pool.slice(Math.floor((i * pool.length) / SAMPLES_PER_SPEAKER), Math.floor(((i + 1) * pool.length) / SAMPLES_PER_SPEAKER));
    chosen.push(bin.reduce((a, b) => (b.words > a.words ? b : a)));
  }
  return chosen;
}

// ---- Matching against known speakers ----

// Known voice prints, skipping those from this meeting (for suggestions, other
// labels in the same meeting are other people) or only from this exact label
// (when comparing against a same-named speaker).
function knownPrints(fileId, label = null) {
  return db
    .prepare(`SELECT vp.speaker_id, vp.embedding, s.name FROM voice_prints vp
              JOIN speakers s ON s.id = vp.speaker_id
              WHERE vp.model = ? AND NOT (IFNULL(vp.file_id, '') = ? AND (? IS NULL OR vp.plaud_label = ?))`)
    .all(MODEL_NAME, fileId, label, label)
    .map((r) => ({ ...r, embedding: fromBlob(r.embedding) }));
}

// Best score per known speaker for one voice print (max over their prints).
function scoreAgainst(embedding, known) {
  const best = new Map();
  for (const k of known) {
    const score = cosine(embedding, k.embedding);
    if (!best.has(k.speaker_id) || score > best.get(k.speaker_id).score) best.set(k.speaker_id, { speakerId: k.speaker_id, name: k.name, score });
  }
  return [...best.values()].sort((a, b) => b.score - a.score);
}

export function listSpeakers() {
  return db
    .prepare(`SELECT s.id, s.name, s.created_at AS createdAt,
                COUNT(vp.id) AS prints,
                MAX(vp.meeting_start_at) AS lastSeen,
                (SELECT COUNT(*) FROM meeting_speakers ms WHERE ms.speaker_id = s.id) AS meetings
              FROM speakers s LEFT JOIN voice_prints vp ON vp.speaker_id = s.id
              GROUP BY s.id ORDER BY s.name COLLATE NOCASE, s.id`)
    .all();
}

// ---- Analyze a meeting for the "Name speakers" view ----

export async function analyzeMeeting(fileId) {
  const meeting = await getMeeting(fileId);
  const byLabel = new Map();
  for (const s of meeting.segments) {
    const e = byLabel.get(s.label) || { label: s.label, displayName: s.speaker, talkMs: 0, lines: 0 };
    e.talkMs += s.endMs - s.startMs;
    e.lines++;
    e.displayName = s.speaker;
    byLabel.set(s.label, e);
  }
  const labels = [...byLabel.keys()];
  const prints = await meetingPrints(meeting, labels);
  const known = knownPrints(fileId);
  const assignments = new Map(
    db.prepare(`SELECT ms.*, s.name FROM meeting_speakers ms JOIN speakers s ON s.id = ms.speaker_id WHERE ms.file_id = ?`)
      .all(fileId)
      .map((a) => [a.plaud_label, a]),
  );

  // Candidate matches, then a one-to-one assignment (best scores first), so two
  // labels in the same meeting aren't both suggested as the same person.
  const candidates = [];
  for (const label of labels) {
    const p = prints.get(label);
    if (!p || assignments.has(label)) continue;
    for (const m of scoreAgainst(p.embedding, known)) if (m.score >= POSSIBLE_MATCH) candidates.push({ label, ...m });
  }
  candidates.sort((a, b) => b.score - a.score);
  const suggestions = new Map();
  const takenSpeakers = new Set([...assignments.values()].map((a) => a.speaker_id));
  for (const c of candidates) {
    if (suggestions.has(c.label) || takenSpeakers.has(c.speakerId)) continue;
    suggestions.set(c.label, c);
    takenSpeakers.add(c.speakerId);
  }

  const speakers = labels.map((label) => {
    const info = byLabel.get(label);
    const p = prints.get(label);
    const a = assignments.get(label);
    const s = suggestions.get(label);
    let suggestion = null;
    if (s) suggestion = { speakerId: s.speakerId, name: s.name, score: round(s.score), confidence: s.score >= STRONG_MATCH ? 'high' : 'possible', source: 'voice' };
    else if (!a && !isGenericLabel(info.displayName)) suggestion = { speakerId: null, name: info.displayName, score: null, confidence: 'plaud', source: 'plaud' };

    const alike = p
      ? labels.filter((o) => o !== label && prints.get(o) && cosine(p.embedding, prints.get(o).embedding) >= SAME_ROOM_ALIKE)
      : [];

    return {
      label,
      displayName: info.displayName,
      talkMs: info.talkMs,
      lines: info.lines,
      voicePrint: p ? { seconds: round(p.seconds, 1), consistency: round(p.consistency) } : null,
      assignment: a ? { speakerId: a.speaker_id, name: a.name, method: a.method, assignedAt: a.assigned_at, plaudSync: a.plaud_sync, plaudSyncError: a.plaud_sync_error } : null,
      suggestion,
      alike,
      samples: buildSamples(meeting.segments, label),
    };
  }).sort((a, b) => b.talkMs - a.talkMs);

  return {
    meeting: { id: meeting.id, name: meeting.name, startAt: meeting.startAt, durationMs: meeting.durationMs },
    transcript: meeting.segments.map(({ startMs, endMs, text, label }) => ({ startMs, endMs, text, label })),
    speakers,
    knownSpeakers: listSpeakers(),
    thresholds: THRESHOLDS,
  };
}

const round = (x, d = 3) => (x == null ? null : Math.round(x * 10 ** d) / 10 ** d);

// ---- Save / merge / confirm ----

export class NameConflict extends Error {
  constructor(matches) {
    super('A speaker with that name already exists');
    this.matches = matches;
  }
}

// mode: 'confirm' | 'merge' (needs speakerId) · 'new' · undefined (check for a name clash first)
export async function assignSpeaker(fileId, label, { name, speakerId, mode }) {
  name = name?.trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Enter a name');
  if (name.length > MAX_SPEAKER_NAME) throw new Error(`Plaud allows at most ${MAX_SPEAKER_NAME} characters`);
  const meeting = await getMeeting(fileId);
  if (!meeting.segments.some((s) => s.label === label)) throw new Error(`No ${label} in this meeting`);
  const print = (await meetingPrints(meeting, [label])).get(label);

  if (!speakerId && mode !== 'new') {
    const sameName = db.prepare('SELECT id, name FROM speakers WHERE name = ? COLLATE NOCASE').all(name);
    if (sameName.length) {
      const stats = new Map(listSpeakers().map((s) => [s.id, s]));
      const scores = print ? new Map(scoreAgainst(print.embedding, knownPrints(fileId, label)).map((m) => [m.speakerId, m.score])) : new Map();
      throw new NameConflict(sameName.map((s) => ({ ...stats.get(s.id), voiceScore: round(scores.get(s.id) ?? null) })));
    }
  }

  const result = tx(() => {
    const previous = db.prepare('SELECT * FROM meeting_speakers WHERE file_id = ? AND plaud_label = ?').get(fileId, label);
    let targetId = speakerId;
    if (targetId) {
      if (!db.prepare('SELECT id FROM speakers WHERE id = ?').get(targetId)) throw new Error('That speaker no longer exists');
    } else {
      targetId = Number(db.prepare('INSERT INTO speakers (name) VALUES (?)').run(name).lastInsertRowid);
    }

    // Re-labeling: drop the voice print this label contributed to someone else.
    if (previous && previous.speaker_id !== targetId) {
      if (previous.voice_print_id) db.prepare('DELETE FROM voice_prints WHERE id = ?').run(previous.voice_print_id);
      db.prepare('DELETE FROM meeting_speakers WHERE file_id = ? AND plaud_label = ?').run(fileId, label);
      removeIfOrphan(previous.speaker_id);
    }

    let voicePrintId = previous?.speaker_id === targetId ? previous.voice_print_id : null;
    if (!voicePrintId && print) {
      voicePrintId = Number(db.prepare(`INSERT INTO voice_prints
          (speaker_id, embedding, model, seconds, consistency, file_id, plaud_label, meeting_start_at, meeting_name)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(targetId, toBlob(print.embedding), MODEL_NAME, print.seconds, print.consistency, fileId, label, meeting.startAt, meeting.name)
        .lastInsertRowid);
    }

    const method = mode === 'confirm' ? 'confirmed' : speakerId ? 'merged' : 'new';
    db.prepare(`INSERT INTO meeting_speakers (file_id, plaud_label, speaker_id, voice_print_id, method, plaud_sync)
                VALUES (?, ?, ?, ?, ?, 'queued')
                ON CONFLICT (file_id, plaud_label) DO UPDATE SET
                  speaker_id = excluded.speaker_id, voice_print_id = excluded.voice_print_id,
                  method = excluded.method, assigned_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
                  plaud_sync = 'queued', plaud_sync_error = NULL, plaud_synced_at = NULL`)
      .run(fileId, label, targetId, voicePrintId, method);
    prunePrints(targetId);

    return { speakerId: targetId, name: db.prepare('SELECT name FROM speakers WHERE id = ?').get(targetId).name, method };
  });

  // Nothing to push if Plaud already shows this name for the label.
  const shown = meeting.segments.find((x) => x.label === label)?.speaker;
  if (shown === result.name) {
    db.prepare(`UPDATE meeting_speakers SET plaud_sync = 'done', plaud_synced_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
                WHERE file_id = ? AND plaud_label = ?`).run(fileId, label);
    return { ...result, plaudSync: 'done', plaudSyncError: null };
  }
  return { ...result, plaudSync: 'queued', plaudSyncError: null };
}

function removeIfOrphan(speakerId) {
  const used = db.prepare(`SELECT (SELECT COUNT(*) FROM voice_prints WHERE speaker_id = ?) +
                                  (SELECT COUNT(*) FROM meeting_speakers WHERE speaker_id = ?) AS n`).get(speakerId, speakerId);
  if (!used.n) db.prepare('DELETE FROM speakers WHERE id = ?').run(speakerId);
}

// ---- Push names to the Plaud web app ----
//
// Saving a name only queues it. "Send to Plaud" then pushes every queued name
// for a meeting in one pass through Plaud's Name speakers form. Meetings run one
// at a time, since there's one browser profile.
// Status per label: queued → syncing → done | failed.

let syncChain = Promise.resolve();

export function queuePlaudSync(fileId) {
  const { changes } = db.prepare(`UPDATE meeting_speakers SET plaud_sync = 'syncing', plaud_sync_error = NULL
              WHERE file_id = ? AND plaud_sync IN ('queued', 'pending', 'failed')`).run(fileId);
  if (changes) syncChain = syncChain.then(() => runPlaudSync(fileId)).catch(() => {});
  return changes;
}

async function runPlaudSync(fileId) {
  const rows = db.prepare(`SELECT ms.plaud_label, ms.assigned_at, s.name FROM meeting_speakers ms
                           JOIN speakers s ON s.id = ms.speaker_id
                           WHERE ms.file_id = ? AND ms.plaud_sync = 'syncing'`).all(fileId);
  if (!rows.length) return;
  const mark = db.prepare(`UPDATE meeting_speakers SET plaud_sync = ?, plaud_sync_error = ?,
                             plaud_synced_at = CASE WHEN ? = 'done' THEN strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
                           WHERE file_id = ? AND plaud_label = ? AND assigned_at = ?`);
  try {
    const meeting = await getMeeting(fileId);
    const current = new Map(meeting.segments.map((s) => [s.label, s.speaker]));
    const t0 = Date.now();
    const r = await updateSpeakerNames(fileId, rows.map((x) => ({ from: current.get(x.plaud_label) || x.plaud_label, to: x.name })));
    console.log(`Speaker names updated in Plaud in ${((Date.now() - t0) / 1000).toFixed(1)}s (via ${r.via}${r.notes?.length ? `; notes: ${r.notes.join(', ')}` : ''})`);
    // Plaud now shows the new names; update the cached transcript to match.
    const renamed = new Map(rows.map((r) => [r.plaud_label, r.name]));
    for (const s of meeting.segments) if (renamed.has(s.label)) s.speaker = renamed.get(s.label);
    // Only rows that weren't re-assigned while we were working.
    for (const r of rows) mark.run('done', null, 'done', fileId, r.plaud_label, r.assigned_at);
    bus.emit('speakers-synced', fileId, rows.map((x) => x.name));
  } catch (err) {
    for (const r of rows) mark.run('failed', err.message, 'failed', fileId, r.plaud_label, r.assigned_at);
  }
}

export function plaudSyncStatus(fileId) {
  return db.prepare(`SELECT plaud_label AS label, plaud_sync AS plaudSync, plaud_sync_error AS plaudSyncError
                     FROM meeting_speakers WHERE file_id = ?`).all(fileId);
}

export function pendingPlaudSync() {
  return db.prepare(`SELECT ms.file_id, ms.plaud_label, s.name, ms.plaud_sync FROM meeting_speakers ms
                     JOIN speakers s ON s.id = ms.speaker_id WHERE ms.plaud_sync != 'done'`).all();
}

// Resume updates that were interrupted by a restart.
for (const { file_id } of db.prepare(`SELECT DISTINCT file_id FROM meeting_speakers WHERE plaud_sync = 'syncing'`).all()) {
  db.prepare(`UPDATE meeting_speakers SET plaud_sync = 'queued' WHERE file_id = ? AND plaud_sync = 'syncing'`).run(file_id);
  queuePlaudSync(file_id);
}

// ---- Model upgrades ----

// Recomputes saved voice prints made with an older model, from the original
// meeting's audio and the same speaker label. Until then, matching only uses
// prints from the current model.
async function upgradeVoicePrints() {
  const stale = db.prepare('SELECT id, file_id, plaud_label FROM voice_prints WHERE model != ? AND file_id IS NOT NULL').all(MODEL_NAME);
  if (!stale.length) return;
  console.log(`Upgrading ${stale.length} voice print(s) to ${MODEL_NAME}…`);
  const update = db.prepare('UPDATE voice_prints SET embedding = ?, model = ?, seconds = ?, consistency = ? WHERE id = ?');
  for (const fileId of new Set(stale.map((r) => r.file_id))) {
    try {
      const rows = stale.filter((r) => r.file_id === fileId);
      const meeting = await getMeeting(fileId);
      const prints = await meetingPrints(meeting, rows.map((r) => r.plaud_label));
      for (const r of rows) {
        const p = prints.get(r.plaud_label);
        if (p) update.run(toBlob(p.embedding), MODEL_NAME, p.seconds, p.consistency, r.id);
      }
    } catch (err) {
      console.error(`Voice print upgrade failed for ${fileId}: ${err.message}`);
    }
  }
  db.prepare('DELETE FROM meeting_prints WHERE model != ?').run(MODEL_NAME);
  console.log('Voice prints upgraded.');
}
upgradeVoicePrints();

// ---- Voice print maintenance (Settings → Voice prints) ----

export function voicePrintDatabase() {
  const people = db.prepare('SELECT id, name, created_at AS createdAt FROM speakers ORDER BY name COLLATE NOCASE, id').all();
  const prints = db.prepare(`SELECT id, speaker_id AS speakerId, file_id AS fileId, meeting_name AS meetingName,
                               meeting_start_at AS meetingStartAt, plaud_label AS plaudLabel, seconds, consistency,
                               discovered_at AS discoveredAt
                             FROM voice_prints ORDER BY meeting_start_at DESC`).all();
  const meetings = db.prepare(`SELECT speaker_id AS speakerId, file_id AS fileId, plaud_label AS plaudLabel,
                                 plaud_sync AS plaudSync FROM meeting_speakers`).all();
  return people.map((p) => ({
    ...p,
    prints: prints.filter((v) => v.speakerId === p.id),
    meetings: meetings.filter((m) => m.speakerId === p.id),
  }));
}

// Renames a person here and (optionally) in every Plaud meeting they're named in.
export function renamePerson(speakerId, name, { updatePlaud = true } = {}) {
  name = name?.trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Enter a name');
  if (name.length > MAX_SPEAKER_NAME) throw new Error(`Plaud allows at most ${MAX_SPEAKER_NAME} characters`);
  if (!db.prepare('SELECT id FROM speakers WHERE id = ?').get(speakerId)) throw new Error('That person no longer exists');
  db.prepare('UPDATE speakers SET name = ? WHERE id = ?').run(name, speakerId);
  const files = db.prepare('SELECT DISTINCT file_id FROM meeting_speakers WHERE speaker_id = ?').all(speakerId).map((r) => r.file_id);
  if (updatePlaud && files.length) {
    db.prepare(`UPDATE meeting_speakers SET plaud_sync = 'queued', plaud_sync_error = NULL WHERE speaker_id = ?`).run(speakerId);
    for (const f of files) queuePlaudSync(f);
  }
  return { name, meetings: files.length, plaudUpdating: updatePlaud ? files.length : 0 };
}

// Deletes one voice print. The person and their meeting names stay.
export function deleteVoicePrint(id) {
  const vp = db.prepare('SELECT speaker_id FROM voice_prints WHERE id = ?').get(id);
  if (!vp) throw new Error('That voice print no longer exists');
  db.prepare('DELETE FROM voice_prints WHERE id = ?').run(id);
  return { remaining: db.prepare('SELECT COUNT(*) AS n FROM voice_prints WHERE speaker_id = ?').get(vp.speaker_id).n };
}

// Deletes a person, all their voice prints and their names on meetings here.
// Names already written to Plaud stay there.
export function deletePerson(speakerId) {
  const p = db.prepare('SELECT name FROM speakers WHERE id = ?').get(speakerId);
  if (!p) throw new Error('That person no longer exists');
  const prints = db.prepare('SELECT COUNT(*) AS n FROM voice_prints WHERE speaker_id = ?').get(speakerId).n;
  db.prepare('DELETE FROM speakers WHERE id = ?').run(speakerId); // prints and meeting names cascade
  return { name: p.name, prints };
}

// Fill in meeting titles for prints saved before titles were stored.
(async () => {
  const missing = db.prepare('SELECT DISTINCT file_id FROM voice_prints WHERE meeting_name IS NULL AND file_id IS NOT NULL').all();
  for (const { file_id } of missing) {
    try {
      const m = await getMeeting(file_id);
      db.prepare('UPDATE voice_prints SET meeting_name = ? WHERE file_id = ? AND meeting_name IS NULL').run(m.name, file_id);
    } catch {}
  }
})();

// ---- Keeping voice prints bounded ----
//
// Each person keeps at most MAX_PRINTS. When there are more, drop the most
// redundant one (the print closest to another of theirs), so what's kept covers
// the widest range of conditions (phone, room mic, laptop…) rather than many
// near-copies. Ties go to the lower-quality print.
export const MAX_PRINTS = 10;

function prunePrints(speakerId) {
  const prints = db.prepare('SELECT id, embedding, seconds, consistency FROM voice_prints WHERE speaker_id = ? AND model = ?')
    .all(speakerId, MODEL_NAME)
    .map((r) => ({ ...r, e: fromBlob(r.embedding), quality: (r.consistency ?? 0.5) * Math.min(1, r.seconds / 60) }));
  const del = db.prepare('DELETE FROM voice_prints WHERE id = ?');
  while (prints.length > MAX_PRINTS) {
    let worst = 0, worstScore = -Infinity;
    prints.forEach((p, i) => {
      const nearest = Math.max(...prints.filter((_, j) => j !== i).map((o) => cosine(p.e, o.e)));
      const score = nearest - p.quality * 0.01;
      if (score > worstScore) { worstScore = score; worst = i; }
    });
    del.run(prints[worst].id);
    prints.splice(worst, 1);
  }
}

// ---- Merging people ----

// How alike two or more people sound: the best match between any of their prints.
export function similarity(ids) {
  const groups = ids.map((id) => db.prepare('SELECT embedding FROM voice_prints WHERE speaker_id = ? AND model = ?')
    .all(id, MODEL_NAME).map((r) => fromBlob(r.embedding)));
  let best = null;
  for (let a = 0; a < groups.length; a++) for (let b = a + 1; b < groups.length; b++)
    for (const x of groups[a]) for (const y of groups[b]) best = Math.max(best ?? -1, cosine(x, y));
  return { best: best == null ? null : round(best), thresholds: THRESHOLDS };
}

// Moves everyone in sourceIds into targetId (their voice prints and meeting
// names), then deletes them. Optionally renames them in Plaud to match.
export function mergePeople(targetId, sourceIds, { updatePlaud = true } = {}) {
  sourceIds = [...new Set(sourceIds.map(Number))].filter((id) => id !== targetId);
  if (!sourceIds.length) throw new Error('Pick at least two people to merge');
  const target = db.prepare('SELECT id, name FROM speakers WHERE id = ?').get(targetId);
  if (!target) throw new Error('That person no longer exists');

  const changed = tx(() => {
    const files = new Set();
    for (const id of sourceIds) {
      const src = db.prepare('SELECT name FROM speakers WHERE id = ?').get(id);
      if (!src) throw new Error('One of those people no longer exists');
      if (src.name !== target.name) {
        for (const r of db.prepare('SELECT file_id FROM meeting_speakers WHERE speaker_id = ?').all(id)) files.add(r.file_id);
      }
      db.prepare('UPDATE voice_prints SET speaker_id = ? WHERE speaker_id = ?').run(targetId, id);
      db.prepare('UPDATE meeting_speakers SET speaker_id = ? WHERE speaker_id = ?').run(targetId, id);
      db.prepare('DELETE FROM speakers WHERE id = ?').run(id);
    }
    prunePrints(targetId);
    if (updatePlaud) {
      for (const f of files) {
        db.prepare(`UPDATE meeting_speakers SET plaud_sync = 'queued', plaud_sync_error = NULL WHERE file_id = ? AND speaker_id = ?`).run(f, targetId);
      }
    }
    return [...files];
  });
  if (updatePlaud) for (const f of changed) queuePlaudSync(f);
  const prints = db.prepare('SELECT COUNT(*) AS n FROM voice_prints WHERE speaker_id = ?').get(targetId).n;
  return { name: target.name, prints, plaudUpdating: updatePlaud ? changed.length : 0 };
}

// Called after a meeting's title changes in Plaud.
export function meetingRenamed(fileId, name) {
  const hit = meetingCache.get(fileId);
  if (hit) hit.value.name = name;
  db.prepare('UPDATE voice_prints SET meeting_name = ? WHERE file_id = ?').run(name, fileId);
}
