import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
mkdirSync(DATA_DIR, { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'plaud2keepit.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
  -- A person. Names aren't unique: two different John Smiths are two rows.
  CREATE TABLE IF NOT EXISTS speakers (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS speakers_name ON speakers (name COLLATE NOCASE);

  -- Voice prints. A speaker collects several (one per meeting they're named
  -- in), which makes later automatic matching more reliable.
  CREATE TABLE IF NOT EXISTS voice_prints (
    id               INTEGER PRIMARY KEY,
    speaker_id       INTEGER NOT NULL REFERENCES speakers (id) ON DELETE CASCADE,
    embedding        BLOB NOT NULL,          -- Float32Array, unit length
    model            TEXT NOT NULL,
    seconds          REAL NOT NULL,          -- speech used to build it
    consistency      REAL,                   -- 0–1, how alike its clips were
    file_id          TEXT,                   -- Plaud recording it came from
    plaud_label      TEXT,                   -- e.g. "Speaker 2" in that recording
    meeting_start_at TEXT,
    discovered_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE INDEX IF NOT EXISTS voice_prints_speaker ON voice_prints (speaker_id);

  -- Who each Plaud speaker label in a meeting was identified as, and whether
  -- that name has been pushed to the Plaud web app yet.
  CREATE TABLE IF NOT EXISTS meeting_speakers (
    file_id          TEXT NOT NULL,
    plaud_label      TEXT NOT NULL,
    speaker_id       INTEGER NOT NULL REFERENCES speakers (id) ON DELETE CASCADE,
    voice_print_id   INTEGER REFERENCES voice_prints (id) ON DELETE SET NULL,
    method           TEXT NOT NULL,          -- new | merged | confirmed
    assigned_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    plaud_sync       TEXT NOT NULL DEFAULT 'queued',   -- queued | syncing | done | failed
    plaud_sync_error TEXT,
    plaud_synced_at  TEXT,
    PRIMARY KEY (file_id, plaud_label)
  );

  -- Per-meeting voice prints computed when a meeting is opened, so naming a
  -- speaker later doesn't need the audio decoded again.
  CREATE TABLE IF NOT EXISTS meeting_prints (
    file_id      TEXT NOT NULL,
    plaud_label  TEXT NOT NULL,
    embedding    BLOB NOT NULL,
    model        TEXT NOT NULL,
    seconds      REAL NOT NULL,
    consistency  REAL,
    computed_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    PRIMARY KEY (file_id, plaud_label, model)
  );
`);

// Columns added after the first release.
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('voice_prints').includes('meeting_name')) db.exec('ALTER TABLE voice_prints ADD COLUMN meeting_name TEXT');

// Runs fn inside a transaction.
export function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
