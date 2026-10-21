import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

// Keep It (Reinvented Software) via AppleScript.
//
// Keep It can deadlock (spinning beach ball, needs a force quit) when a
// scripted request arrives while it's saving in the background (its library
// syncs via File Provider, so it saves often). So, here:
//   • one request at a time, with a pause after every change so the save it
//     triggers can finish before the next request,
//   • items are addressed directly by id where possible (no library searches),
//   • every request has a timeout; a timeout marks Keep It "not responding"
//     and background work stops for a while instead of piling up requests.
// Scripts take their inputs as arguments (never pasted into the script text),
// so names and paths with quotes or special characters are safe.

const exec = promisify(execFile);
const SEP = '\u001f';
const APPLE_TIMEOUT_S = 25;
const SETTLE_AFTER_WRITE_MS = 1500;
const PAUSE_AFTER_HANG_MS = 15 * 60 * 1000;

let gate = Promise.resolve();
let quietUntil = 0;
let hungSince = 0;

export function keepItHealth() {
  return hungSince && Date.now() - hungSince < PAUSE_AFTER_HANG_MS
    ? { ok: false, since: new Date(hungSince).toISOString(), message: 'Keep It stopped responding. Force quit and reopen it; checks resume automatically.' }
    : { ok: true };
}

// After you've force-quit and reopened Keep It, checks can resume right away.
export function resetHealth() { hungSince = 0; }

export class KeepItNotResponding extends Error {}

// Runs one AppleScript, serialized with all others. write: pause afterwards.
function osa(script, args = [], { write = false } = {}) {
  const runIt = async () => {
    const wait = quietUntil - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const wrapped = script
      .replace(/tell application "Keep It"/g, `with timeout of ${APPLE_TIMEOUT_S} seconds\ntell application "Keep It"`)
      .replace(/end tell/g, 'end tell\nend timeout')
      // one-line form: tell application "Keep It" to …
      .replace(/(with timeout of \d+ seconds\ntell application "Keep It" to [^\n]*)/g, '$1\nend timeout');
    try {
      const { stdout } = await exec('osascript', ['-e', wrapped, ...args.map(String)], {
        maxBuffer: 10 * 1024 * 1024, timeout: (APPLE_TIMEOUT_S + 10) * 1000, killSignal: 'SIGKILL',
      });
      hungSince = 0;
      return stdout.trim();
    } catch (err) {
      if (err.killed || /AppleEvent timed out|\(-1712\)/.test(err.stderr || err.message)) {
        hungSince = Date.now();
        throw new KeepItNotResponding('Keep It isn’t responding (it may need a force quit)');
      }
      throw new Error((err.stderr || err.message).trim().replace(/^\d+:\d+: execution error: /, ''));
    } finally {
      if (write) quietUntil = Date.now() + SETTLE_AFTER_WRITE_MS;
    }
  };
  const p = gate.then(() => {
    if (!keepItHealth().ok) throw new KeepItNotResponding(keepItHealth().message);
    return runIt();
  });
  gate = p.catch(() => {});
  return p;
}

// Is Keep It running? (Checks never launch it.)
export async function isRunning() {
  const out = await exec('osascript', ['-e', 'application id "com.reinvented.KeepIt" is running']).then((r) => r.stdout.trim(), () => 'false');
  return out === 'true';
}

// Finds a folder by name (first match anywhere in the library).
export async function findFolder(name) {
  const out = await osa(`on run argv
    tell application "Keep It"
      set fs to every folder whose name is (item 1 of argv)
      if (count of fs) is 0 then return ""
      set f to item 1 of fs
      return (id of f) & "${SEP}" & (link of f)
    end tell
  end run`, [name]);
  if (!out) return null;
  const [id, link] = out.split(SEP);
  return { id, link, name };
}

// Finds (creating any missing levels) a folder path under Keep It's top level,
// e.g. ['Clients', 'Acme']. Matching is case-insensitive. Returns { id, link }.
export async function ensureFolderPath(parts) {
  if (!parts.length) throw new Error('No folder given');
  const out = await osa(`on run argv
    tell application "Keep It"
      set f to top level folder
      repeat with partName in argv
        set p to partName as text
        set found to missing value
        repeat with c in (every folder of f)
          if (name of c) is p then
            set found to c
            exit repeat
          end if
        end repeat
        if found is missing value then set found to make new folder at f with properties {name:p}
        set f to found
      end repeat
      return (id of f) & "${SEP}" & (link of f)
    end tell
  end run`, parts, { write: true });
  const [id, link] = out.split(SEP);
  return { id, link };
}

// Date → AppleScript-friendly local components.
const dateArgs = (d) => (d ? [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()] : ['', '', '', '']);
const SET_DATE = (target) => `if y is not "" then
        set dt to current date
        set day of dt to 1
        set year of dt to (y as integer)
        set month of dt to (m as integer)
        set day of dt to (d as integer)
        set time of dt to (secs as integer)
        set created date of ${target} to dt
      end if`;

// Imports a file into a folder. Text files (HTML, RTF/RTFD) can be converted
// to Keep It notes. Keep It's import doesn't return the new item, so it's found
// by comparing the folder's items before and after. createdAt sets the item's
// creation date (e.g. to when the meeting happened). Returns { id, name, link }.
export async function importFile(filePath, { folderId, name, tags = [], comments = '', source = '', asNote = false, createdAt = null }) {
  const out = await osa(`on run argv
    set {filePath, folderId, itemName, tagText, theComments, theSource, asNote, y, m, d, secs} to argv
    tell application "Keep It"
      set dest to folder id folderId
      set existingIds to id of every Keep It item of dest
      set tagList to {}
      if tagText is not "" then
        set AppleScript's text item delimiters to "${SEP}"
        set tagList to text items of tagText
        set AppleScript's text item delimiters to ""
      end if
      add files {POSIX file filePath} to dest converting text files (asNote is "1") always keep both true with tags tagList with comments theComments with source theSource
    end tell
    -- Let Keep It finish saving the import before asking it anything else.
    delay 2
    tell application "Keep It"
      set newItem to missing value
      repeat with attempt from 1 to 5
        set allIds to id of every Keep It item of dest
        repeat with x in allIds
          if existingIds does not contain (contents of x) then set newItem to Keep It item id (contents of x)
        end repeat
        if newItem is not missing value then exit repeat
        delay 1
      end repeat
      if newItem is missing value then error "Imported, but couldn't find the new item"
      if itemName is not "" then set name of newItem to itemName
      ${SET_DATE('newItem')}
      return (id of newItem) & "${SEP}" & (name of newItem) & "${SEP}" & (link of newItem)
    end tell
  end run`, [filePath, folderId, name || '', tags.join(SEP), comments, source, asNote ? '1' : '0', ...dateArgs(createdAt)], { write: true });
  const [id, itemName, link] = out.split(SEP);
  return { id, name: itemName, link };
}

// Moves an item to Keep It's Deleted Items (recoverable). Keep It's own
// "delete" only works on items already there, and deletes them permanently.
export async function trashItem(id) {
  await osa(`on run argv
    tell application "Keep It"
      move (Keep It item id (item 1 of argv)) to deleted items folder
    end tell
  end run`, [id], { write: true });
}

// Current state of items by id: exists, deleted, name, folder path (from the
// top level, " / "-separated), folder id and tags. One request.
export async function readItems(ids) {
  if (!ids.length) return [];
  const RS = '\u001e';
  const out = await osa(`on run argv
    set out to {}
    tell application "Keep It"
      repeat with theId in argv
        set rec to (theId as text)
        try
          set i to Keep It item id (theId as text)
          set AppleScript's text item delimiters to "\u001d"
          set tagText to (tag names of i) as text
          set pathParts to {}
          set f to folder of i
          set fid to id of f
          repeat 12 times
            try
              set p to parent folder of f
            on error
              set p to missing value
            end try
            if p is missing value then exit repeat
            set beginning of pathParts to (name of f)
            set f to p
          end repeat
          set AppleScript's text item delimiters to " / "
          set rec to rec & "${SEP}1${SEP}" & ((is deleted of i) as text) & "${SEP}" & (name of i) & "${SEP}" & (pathParts as text) & "${SEP}" & fid & "${SEP}" & tagText
        on error
          set rec to rec & "${SEP}0"
        end try
        set end of out to rec
      end repeat
    end tell
    set AppleScript's text item delimiters to "${RS}"
    return out as text
  end run`, ids);
  return out.split(RS).filter(Boolean).map((line) => {
    const [id, exists, deleted, name, folderPath, folderId, tags] = line.split(SEP);
    return exists === '1'
      ? { id, exists: true, deleted: deleted === 'true', name, folderPath, folderId, tags: tags ? tags.split('\u001d').filter(Boolean) : [] }
      : { id, exists: false };
  });
}

// Updates an item in place. Any of: name, comments, tags (replaces the list),
// folderId (moves it), createdAt (creation date).
export async function updateItem(id, { name, comments, tags, folderId, createdAt } = {}) {
  await osa(`on run argv
    set {theId, newName, newComments, tagText, setTags, newFolder, y, m, d, secs} to argv
    tell application "Keep It"
      set i to Keep It item id theId
      if newName is not "" then set name of i to newName
      if newComments is not "" then set comments of i to newComments
      if setTags is "1" then
        set tagList to {}
        if tagText is not "" then
          set AppleScript's text item delimiters to "${SEP}"
          set tagList to text items of tagText
          set AppleScript's text item delimiters to ""
        end if
        set tag names of i to tagList
      end if
      if newFolder is not "" then move i to (folder id newFolder)
      ${SET_DATE('i')}
    end tell
  end run`, [id, name || '', comments || '', (tags || []).join(SEP), tags ? '1' : '0', folderId || '', ...dateArgs(createdAt)], { write: true });
}

export async function itemInfo(id) {
  const out = await osa(`on run argv
    tell application "Keep It"
      set i to Keep It item id (item 1 of argv)
      set AppleScript's text item delimiters to ", "
      return (name of i) & "${SEP}" & (kind of i) & "${SEP}" & (tag names of i as text) & "${SEP}" & (source of i) & "${SEP}" & ((created date of i) as «class isot» as string)
    end tell
  end run`, [id]);
  const [name, kind, tags, source, created] = out.split(SEP);
  return { name, kind, tags, source, created };
}
