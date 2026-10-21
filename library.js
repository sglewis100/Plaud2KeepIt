import { db, tx } from './db.js';
import { updateTitle, MAX_TITLE } from './plaud.js';
import { meetingRenamed } from './speakers.js';
import { bus } from './events.js';

// Meeting organization: titles (pushed to Plaud), tags and nested folders.
// Tags and folders live only here (Plaud's own folders can't nest); they're
// meant to carry over to the Keep It side later.

db.exec(`
  -- Local record of meetings that have been edited/organized here. Title, start
  -- and duration are a snapshot so folders and tags can list meetings without
  -- asking Plaud.
  CREATE TABLE IF NOT EXISTS meetings (
    file_id          TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    start_at         TEXT,
    duration_ms      INTEGER,
    folder_id        INTEGER REFERENCES folders (id) ON DELETE SET NULL,
    title_sync       TEXT NOT NULL DEFAULT 'done',   -- done | queued | syncing | failed
    title_sync_error TEXT,
    updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS folders (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    parent_id   INTEGER REFERENCES folders (id),
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS folders_sibling_name ON folders (IFNULL(parent_id, 0), name COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS tags (
    id          INTEGER PRIMARY KEY,
    name        TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS meeting_tags (
    file_id  TEXT NOT NULL REFERENCES meetings (file_id) ON DELETE CASCADE,
    tag_id   INTEGER NOT NULL REFERENCES tags (id) ON DELETE CASCADE,
    PRIMARY KEY (file_id, tag_id)
  );
`);

const MAX_NAME = 60;
const cleanName = (s, what) => {
  const name = String(s ?? '').trim().replace(/\s+/g, ' ');
  if (!name) throw new Error(`Enter a ${what} name`);
  if (name.length > MAX_NAME) throw new Error(`${what[0].toUpperCase()}${what.slice(1)} names can be at most ${MAX_NAME} characters`);
  if (what === 'folder' && name.includes('/')) throw new Error('Folder names can’t contain “/”');
  return name;
};

// ---- Folders ----

export function listFolders() {
  const rows = db.prepare(`SELECT f.id, f.name, f.parent_id AS parentId,
                             (SELECT COUNT(*) FROM meetings m WHERE m.folder_id = f.id) AS count
                           FROM folders f ORDER BY f.name COLLATE NOCASE`).all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  const path = (f) => (f.parentId && byId.has(f.parentId) ? `${path(byId.get(f.parentId))} / ${f.name}` : f.name);
  const total = (f) => f.count + rows.filter((c) => c.parentId === f.id).reduce((n, c) => n + total(c), 0);
  return rows.map((r) => ({ ...r, path: path(r), total: total(r) }));
}

function descendants(id) {
  const out = [];
  for (const c of db.prepare('SELECT id FROM folders WHERE parent_id = ?').all(id)) out.push(c.id, ...descendants(c.id));
  return out;
}

function siblingClash(name, parentId, exceptId = null) {
  return db.prepare(`SELECT id FROM folders WHERE IFNULL(parent_id, 0) = IFNULL(?, 0) AND name = ? COLLATE NOCASE AND id IS NOT ?`)
    .get(parentId ?? null, name, exceptId);
}

export function createFolder({ name, parentId = null }) {
  name = cleanName(name, 'folder');
  parentId = parentId ? Number(parentId) : null;
  if (parentId && !db.prepare('SELECT id FROM folders WHERE id = ?').get(parentId)) throw new Error('That parent folder no longer exists');
  if (siblingClash(name, parentId)) throw new Error(`There’s already a folder named “${name}” there`);
  const id = Number(db.prepare('INSERT INTO folders (name, parent_id) VALUES (?, ?)').run(name, parentId).lastInsertRowid);
  return listFolders().find((f) => f.id === id);
}

// Rename and/or move. Moving into itself or one of its own subfolders is refused.
export function updateFolder(id, { name, parentId }) {
  const f = db.prepare('SELECT id, name, parent_id FROM folders WHERE id = ?').get(id);
  if (!f) throw new Error('That folder no longer exists');
  const newName = name !== undefined ? cleanName(name, 'folder') : f.name;
  const newParent = parentId !== undefined ? (parentId ? Number(parentId) : null) : f.parent_id;
  if (newParent === id || descendants(id).includes(newParent)) throw new Error('A folder can’t be moved inside itself');
  if (newParent && !db.prepare('SELECT id FROM folders WHERE id = ?').get(newParent)) throw new Error('That destination folder no longer exists');
  if (siblingClash(newName, newParent, id)) throw new Error(`There’s already a folder named “${newName}” there`);
  db.prepare('UPDATE folders SET name = ?, parent_id = ? WHERE id = ?').run(newName, newParent, id);
  changed(meetingsInFolders([id, ...descendants(id)])); // their folder path changed
  return listFolders().find((x) => x.id === id);
}

const meetingsInFolders = (ids) => (ids.length
  ? db.prepare(`SELECT file_id FROM meetings WHERE folder_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.file_id)
  : []);
const meetingsWithTags = (ids) => db.prepare(`SELECT DISTINCT file_id FROM meeting_tags WHERE tag_id IN (${ids.map(() => '?').join(',')})`).all(...ids).map((r) => r.file_id);
const changed = (fileIds) => { if (fileIds.length) bus.emit('meta-changed', [...new Set(fileIds)]); };

// mode 'lift': subfolders and meetings move up to the deleted folder's parent.
// mode 'all': subfolders are deleted too; their meetings become unfiled.
export function deleteFolder(id, mode = 'lift') {
  const f = db.prepare('SELECT id, name, parent_id FROM folders WHERE id = ?').get(id);
  if (!f) throw new Error('That folder no longer exists');
  const affected = meetingsInFolders([id, ...descendants(id)]);
  const result = tx(() => {
    let moved = 0;
    if (mode === 'all') {
      const ids = [id, ...descendants(id)];
      const marks = ids.map(() => '?').join(',');
      moved = db.prepare(`UPDATE meetings SET folder_id = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE folder_id IN (${marks})`).run(...ids).changes;
      for (const fid of ids.reverse()) db.prepare('DELETE FROM folders WHERE id = ?').run(fid);
    } else {
      for (const c of db.prepare('SELECT id, name FROM folders WHERE parent_id = ?').all(id)) {
        if (siblingClash(c.name, f.parent_id, c.id)) throw new Error(`Can’t move “${c.name}” up: a folder with that name is already there. Rename one first.`);
        db.prepare('UPDATE folders SET parent_id = ? WHERE id = ?').run(f.parent_id, c.id);
      }
      moved = db.prepare(`UPDATE meetings SET folder_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE folder_id = ?`).run(f.parent_id, id).changes;
      db.prepare('DELETE FROM folders WHERE id = ?').run(id);
    }
    return { deleted: f.name, meetingsMoved: moved };
  });
  changed(affected);
  return result;
}

// ---- Tags ----

export function listTags() {
  return db.prepare(`SELECT t.id, t.name, COUNT(mt.file_id) AS count FROM tags t
                     LEFT JOIN meeting_tags mt ON mt.tag_id = t.id
                     GROUP BY t.id ORDER BY t.name COLLATE NOCASE`).all();
}

// Renames a tag on every meeting. If another tag already has the new name, the
// two are merged (only when merge is true; otherwise a conflict is reported).
export function renameTag(id, name, { merge = false } = {}) {
  name = cleanName(name, 'tag');
  const t = db.prepare('SELECT id, name FROM tags WHERE id = ?').get(id);
  if (!t) throw new Error('That tag no longer exists');
  const other = db.prepare('SELECT id, name FROM tags WHERE name = ? COLLATE NOCASE AND id != ?').get(name, id);
  if (other && !merge) {
    const err = new Error(`There’s already a tag named “${other.name}”`);
    err.conflict = { id: other.id, name: other.name };
    throw err;
  }
  const affected = meetingsWithTags([id]);
  const result = tx(() => {
    if (other) {
      db.prepare('INSERT OR IGNORE INTO meeting_tags (file_id, tag_id) SELECT file_id, ? FROM meeting_tags WHERE tag_id = ?').run(other.id, id);
      db.prepare('DELETE FROM tags WHERE id = ?').run(id);
      return { id: other.id, name: other.name, merged: true };
    }
    db.prepare('UPDATE tags SET name = ? WHERE id = ?').run(name, id);
    return { id, name, merged: false };
  });
  changed(affected);
  return result;
}

export function deleteTag(id) {
  const t = db.prepare('SELECT name FROM tags WHERE id = ?').get(id);
  if (!t) throw new Error('That tag no longer exists');
  const affected = meetingsWithTags([id]);
  db.prepare('DELETE FROM tags WHERE id = ?').run(id);
  changed(affected);
  return { deleted: t.name, meetings: affected.length };
}

// ---- Meetings ----

export function meetingMeta(fileId) {
  const m = db.prepare(`SELECT file_id AS fileId, title, start_at AS startAt, duration_ms AS durationMs, folder_id AS folderId,
                          title_sync AS titleSync, title_sync_error AS titleSyncError FROM meetings WHERE file_id = ?`).get(fileId);
  const tags = db.prepare(`SELECT t.name FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id WHERE mt.file_id = ?
                           ORDER BY t.name COLLATE NOCASE`).all(fileId).map((r) => r.name);
  const folder = m?.folderId ? listFolders().find((f) => f.id === m.folderId) : null;
  return { ...(m || { fileId, title: null, folderId: null, titleSync: 'done' }), tags, folderPath: folder?.path ?? null };
}

// Local info for many meetings at once (for the meetings list).
export function metaFor(fileIds) {
  if (!fileIds.length) return new Map();
  const marks = fileIds.map(() => '?').join(',');
  const folders = new Map(listFolders().map((f) => [f.id, f.path]));
  const rows = db.prepare(`SELECT file_id, title, folder_id, title_sync FROM meetings WHERE file_id IN (${marks})`).all(...fileIds);
  const tags = db.prepare(`SELECT mt.file_id, t.name FROM meeting_tags mt JOIN tags t ON t.id = mt.tag_id
                           WHERE mt.file_id IN (${marks}) ORDER BY t.name COLLATE NOCASE`).all(...fileIds);
  const out = new Map();
  for (const r of rows) out.set(r.file_id, { title: r.title, titleSync: r.title_sync, folderPath: folders.get(r.folder_id) ?? null, folderId: r.folder_id, tags: [] });
  for (const t of tags) out.get(t.file_id)?.tags.push(t.name);
  return out;
}

// Saves title/folder/tags. `plaudTitle` is the title Plaud has now; a different
// title is queued and pushed to Plaud in the background.
export function saveMeetingMeta(fileId, { title, folderId, tags, plaudTitle, startAt, durationMs }) {
  title = String(title ?? '').trim().replace(/\s+/g, ' ');
  if (!title) throw new Error('Enter a title');
  if (title.length > MAX_TITLE) throw new Error(`Plaud allows at most ${MAX_TITLE} characters in a title`);
  folderId = folderId ? Number(folderId) : null;
  if (folderId && !db.prepare('SELECT id FROM folders WHERE id = ?').get(folderId)) throw new Error('That folder no longer exists');
  const tagNames = [];
  for (const t of (tags || []).map((x) => cleanName(x, 'tag'))) {
    if (!tagNames.some((x) => x.toLowerCase() === t.toLowerCase())) tagNames.push(t);
  }

  const prev = db.prepare('SELECT title FROM meetings WHERE file_id = ?').get(fileId);
  const before = meetingMeta(fileId);
  const titleChanged = title !== (prev?.title ?? plaudTitle);
  const needsPlaud = titleChanged && title !== plaudTitle;

  tx(() => {
    db.prepare(`INSERT INTO meetings (file_id, title, start_at, duration_ms, folder_id, title_sync)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (file_id) DO UPDATE SET title = excluded.title, folder_id = excluded.folder_id,
                  start_at = COALESCE(excluded.start_at, start_at), duration_ms = COALESCE(excluded.duration_ms, duration_ms),
                  title_sync = CASE WHEN ? THEN excluded.title_sync ELSE title_sync END,
                  title_sync_error = CASE WHEN ? THEN NULL ELSE title_sync_error END,
                  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
      .run(fileId, title, startAt ?? null, durationMs ?? null, folderId, needsPlaud ? 'queued' : 'done', needsPlaud ? 1 : 0, needsPlaud ? 1 : 0);
    db.prepare('DELETE FROM meeting_tags WHERE file_id = ?').run(fileId);
    for (const name of tagNames) {
      db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(name);
      const tag = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name);
      db.prepare('INSERT OR IGNORE INTO meeting_tags (file_id, tag_id) VALUES (?, ?)').run(fileId, tag.id);
    }
  });

  if (needsPlaud) syncTitle(fileId);
  const after = meetingMeta(fileId);
  const sameTags = before.tags.map((t) => t.toLowerCase()).sort().join('|') === after.tags.map((t) => t.toLowerCase()).sort().join('|');
  if (before.folderId !== after.folderId || !sameTags || (before.title ?? plaudTitle) !== after.title) changed([fileId]);
  return after;
}

// ---- Changes coming back from Keep It (no change announcement: they're already there) ----

// Finds or creates the folder path ("Clients / Acme"); returns its id.
export function folderIdForPath(path) {
  let parentId = null;
  for (const part of path.split(' / ').map((x) => x.trim()).filter(Boolean)) {
    const name = cleanName(part, 'folder');
    const hit = db.prepare('SELECT id FROM folders WHERE IFNULL(parent_id, 0) = IFNULL(?, 0) AND name = ? COLLATE NOCASE').get(parentId, name);
    parentId = hit ? hit.id : Number(db.prepare('INSERT INTO folders (name, parent_id) VALUES (?, ?)').run(name, parentId).lastInsertRowid);
  }
  return parentId;
}

export function applyFromKeepIt(fileId, { folderPath, tags }) {
  tx(() => {
    if (folderPath !== undefined) {
      const folderId = folderPath ? folderIdForPath(folderPath) : null;
      db.prepare(`UPDATE meetings SET folder_id = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE file_id = ?`).run(folderId, fileId);
    }
    if (tags !== undefined) {
      db.prepare('DELETE FROM meeting_tags WHERE file_id = ?').run(fileId);
      for (const name of tags) {
        db.prepare('INSERT OR IGNORE INTO tags (name) VALUES (?)').run(cleanName(name, 'tag'));
        const tag = db.prepare('SELECT id FROM tags WHERE name = ? COLLATE NOCASE').get(name);
        db.prepare('INSERT OR IGNORE INTO meeting_tags (file_id, tag_id) VALUES (?, ?)').run(fileId, tag.id);
      }
    }
  });
}

// Plaud is the source of truth for titles unless a change made here is still
// on its way there. Refresh the local copy when Plaud's title differs.
export function plaudTitleSeen(fileId, plaudTitle) {
  if (!plaudTitle) return;
  db.prepare(`UPDATE meetings SET title = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
              WHERE file_id = ? AND title_sync = 'done' AND title != ?`).run(plaudTitle, fileId, plaudTitle);
}

export function retryTitle(fileId) {
  db.prepare(`UPDATE meetings SET title_sync = 'queued', title_sync_error = NULL WHERE file_id = ? AND title_sync = 'failed'`).run(fileId);
  syncTitle(fileId);
  return meetingMeta(fileId);
}

async function syncTitle(fileId) {
  const row = db.prepare(`SELECT title FROM meetings WHERE file_id = ? AND title_sync = 'queued'`).get(fileId);
  if (!row) return;
  db.prepare(`UPDATE meetings SET title_sync = 'syncing' WHERE file_id = ?`).run(fileId);
  try {
    const t0 = Date.now();
    const r = await updateTitle(fileId, row.title);
    console.log(`Title updated in Plaud in ${((Date.now() - t0) / 1000).toFixed(1)}s (via ${r.via})`);
    // Only mark done if nobody changed the title again meanwhile.
    db.prepare(`UPDATE meetings SET title_sync = 'done', title_sync_error = NULL WHERE file_id = ? AND title = ?`).run(fileId, row.title);
    meetingRenamed(fileId, row.title);
  } catch (err) {
    db.prepare(`UPDATE meetings SET title_sync = 'failed', title_sync_error = ? WHERE file_id = ? AND title = ?`).run(err.message, fileId, row.title);
  }
  // A newer title may have been queued while this one was running.
  syncTitle(fileId);
}

// Meetings in a folder (optionally including subfolders) or with a tag.
export function libraryMeetings({ folderId, tagId, deep = false }) {
  let ids;
  if (tagId) {
    ids = db.prepare('SELECT file_id FROM meeting_tags WHERE tag_id = ?').all(Number(tagId)).map((r) => r.file_id);
  } else {
    const folders = folderId === 'none' ? null : [Number(folderId), ...(deep ? descendants(Number(folderId)) : [])];
    ids = folders
      ? db.prepare(`SELECT file_id FROM meetings WHERE folder_id IN (${folders.map(() => '?').join(',')})`).all(...folders).map((r) => r.file_id)
      : db.prepare('SELECT file_id FROM meetings WHERE folder_id IS NULL').all().map((r) => r.file_id);
  }
  const meta = metaFor(ids);
  return db.prepare(`SELECT file_id AS id, title, start_at AS startAt, duration_ms AS durationMs FROM meetings
                     WHERE file_id IN (${ids.map(() => '?').join(',') || "''"}) ORDER BY start_at DESC`)
    .all(...ids)
    .map((m) => ({ ...m, ...meta.get(m.id) }));
}

// Resume title updates interrupted by a restart.
for (const { file_id } of db.prepare(`SELECT file_id FROM meetings WHERE title_sync IN ('syncing', 'queued')`).all()) {
  db.prepare(`UPDATE meetings SET title_sync = 'queued' WHERE file_id = ?`).run(file_id);
  syncTitle(file_id);
}

// ---- Cleanup: unused tags and empty folders ----

// Tags no meeting uses, and folders with no meetings in them or any subfolder.
export function unusedItems() {
  const tags = listTags().filter((t) => !t.count).map(({ id, name }) => ({ id, name }));
  const folders = listFolders().filter((f) => !f.total).map(({ id, path, parentId }) => ({ id, path, parentId }));
  return { tags, folders };
}

export function cleanUpUnused() {
  const { tags, folders } = unusedItems();
  tx(() => {
    for (const t of tags) db.prepare('DELETE FROM tags WHERE id = ?').run(t.id);
    // Deepest first, so parents are empty of subfolders when they go.
    const depth = (f) => f.path.split(' / ').length;
    for (const f of [...folders].sort((a, b) => depth(b) - depth(a))) db.prepare('DELETE FROM folders WHERE id = ?').run(f.id);
  });
  return { tags: tags.map((t) => t.name), folders: folders.map((f) => f.path) };
}
