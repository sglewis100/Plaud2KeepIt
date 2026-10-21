// Meeting details: title (also changed in Plaud), tags, folder.

import { attachAutocomplete } from './autocomplete.js';
import { createFolderPicker } from './folder-picker.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAX_TITLE = 255;
const MAX_TAG = 60;

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!json.ok) throw Object.assign(new Error(json.error || 'Request failed'), json);
  return json.data;
}

// Folder <option>s, indented to show nesting.
export function folderOptions(folders, selectedId, { none = 'No folder', exclude = new Set() } = {}) {
  const kids = (pid) => folders.filter((f) => (f.parentId ?? null) === pid).sort((a, b) => a.name.localeCompare(b.name));
  const out = [`<option value="">${esc(none)}</option>`];
  const walk = (pid, depth) => {
    for (const f of kids(pid)) {
      if (exclude.has(f.id)) continue;
      out.push(`<option value="${f.id}" ${f.id === selectedId ? 'selected' : ''}>${'   '.repeat(depth)}${depth ? '└ ' : ''}${esc(f.name)}</option>`);
      walk(f.id, depth + 1);
    }
  };
  walk(null, 0);
  return out.join('');
}

// Title / tags / folder form, mounted inside the meeting dialog. Edits are kept
// in the form until save() (the dialog's ✓) writes them.
//   const details = mountDetails(el, meeting, { onChange })
//   details.isDirty() · await details.save() → saved meta
// showTitle: false hides the title (for the "pick tags and folder" prompt).
export function mountDetails(root, meeting, { onChange, showTitle = true } = {}) {
  root.innerHTML = `<div class="me-loading"><span class="spinner"></span></div>`;
  const state = { loaded: false, initial: null };
  const handle = {
    // A tag typed but not added yet counts as a change too.
    isDirty: () => state.loaded && (JSON.stringify(current()) !== state.initial || !!$('.me-tag-input')?.value.trim()),
    // Tags (including one typed but not added yet) and folder as they stand.
    values: () => (state.loaded ? { tags: tags.length + ($('.me-tag-input')?.value.trim() ? 1 : 0), folderId: picker?.value ?? null } : { tags: 0, folderId: null }),
    save,
    ready: load(),
  };
  let lib, meta, folders, known, tags, plaudTitle, picker;
  const $ = (sel) => root.querySelector(sel);
  const changed = () => onChange?.();
  const current = () => ({
    title: $('.me-title').value.trim().replace(/\s+/g, ' '),
    tags: [...tags].map((t) => t.toLowerCase()).sort(),
    folderId: picker?.value ?? null,
  });
  return handle;

  async function load() {
    try {
      [lib, meta] = await Promise.all([api('/api/library'), api(`/api/meetings/${encodeURIComponent(meeting.id)}/meta`)]);
    } catch (err) {
      root.innerHTML = `<div class="notice error">Couldn’t load title, tags and folder: ${esc(err.message)}</div>`;
      return;
    }
    plaudTitle = meeting.plaudName || meeting.name;
    tags = [...meta.tags];
    folders = lib.folders;
    known = lib.tags.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    render();
    state.loaded = true;
    state.initial = JSON.stringify(current());
    suggestSafeTitle();
    changed();
  }

  // Titles become file names in Keep It, where ":" and "/" can't be used.
  // Put a safe version in the box (saved only with ✓), with an Undo.
  function suggestSafeTitle() {
    const box = $('.me-title');
    const original = box.value;
    const safe = safeTitle(original);
    if (safe === original) return;
    box.value = safe;
    box.dispatchEvent(new Event('input'));
    const note = $('.me-title-fix');
    note.innerHTML = `<span>Titles become file names in Keep It, which can’t contain ${esc(illegalIn(original))}. Adjusted for you; saved when you click ✓.</span>
      <button type="button" class="btn small ghost" data-undo-title>Undo</button>`;
    note.hidden = false;
    note.querySelector('[data-undo-title]').onclick = () => {
      box.value = original;
      box.dispatchEvent(new Event('input'));
      note.hidden = true;
    };
  }

  function render() {
    root.innerHTML = `
      <div class="me-body">
        <label class="me-field" ${showTitle ? '' : 'hidden'}>
          <span>Title <small class="me-count"></small></span>
          <textarea class="me-title" rows="2" maxlength="${MAX_TITLE}" spellcheck="true"></textarea>
          <small class="me-hint">Changing the title also renames it in Plaud.</small>
          <div class="me-title-fix" hidden></div>
          <div class="me-title-status"></div>
        </label>
        <div class="me-row">
          <div class="me-field">
            <span>Tags</span>
            <div class="me-tags">
              <span class="me-chips"></span>
              <input class="me-tag-input" maxlength="${MAX_TAG}" placeholder="Add a tag…">
            </div>
            <small class="me-hint">Enter or comma adds · Esc keeps what you typed · Backspace removes the last tag</small>
          </div>
          <div class="me-field">
            <span>Folder</span>
            <div class="me-folder-picker"></div>
            <small class="me-hint">Search, pick, or type a new name to create it</small>
          </div>
        </div>
        <div class="me-error"></div>
      </div>`;

    const title = $('.me-title');
    // A title change still on its way to Plaud wins; otherwise show Plaud's title.
    title.value = (meta.titleSync && meta.titleSync !== 'done' ? meta.title : meeting.plaudName || meeting.name || meta.title) || '';
    const count = () => { $('.me-count').textContent = `${title.value.length}/${MAX_TITLE}`; };
    title.addEventListener('input', () => { count(); changed(); });
    // Enter in the title shouldn't add a line break (titles are one line).
    title.addEventListener('keydown', (e) => { if (e.key === 'Enter') e.preventDefault(); });
    count();
    titleStatus(meta);

    // ---- Tags ----
    const renderChips = () => {
      $('.me-chips').innerHTML = tags.map((t, i) => `<span class="me-chip">${esc(t)}<button type="button" data-remove="${i}" aria-label="Remove ${esc(t)}">×</button></span>`).join('');
      changed();
    };
    const tagInput = $('.me-tag-input');
    handle.addTag = (raw) => {
      const t = raw.trim().replace(/\s+/g, ' ');
      if (!t) return;
      // Reuse an existing tag's spelling when it differs only by case.
      const existing = known.find((k) => k.name.toLowerCase() === t.toLowerCase());
      const name = existing ? existing.name : t;
      if (!tags.some((x) => x.toLowerCase() === name.toLowerCase())) tags.push(name);
      renderChips();
    };
    // Suggestions first, so its Enter (pick highlighted) runs before ours (add typed).
    attachAutocomplete(tagInput, {
      items: () => known.map((k) => k.name),
      exclude: () => tags,
      onPick: (v) => { handle.addTag(v); tagInput.value = ''; },
    });
    tagInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        handle.addTag(tagInput.value);
        tagInput.value = '';
      } else if (e.key === 'Backspace' && !tagInput.value && tags.length) {
        tags.pop();
        renderChips();
      }
    });
    tagInput.addEventListener('input', () => {
      changed();
      // Commas (typed or pasted) separate tags.
      if (tagInput.value.includes(',')) {
        const parts = tagInput.value.split(',');
        tagInput.value = parts.pop();
        parts.forEach(handle.addTag);
      }
    });
    $('.me-chips').addEventListener('click', (e) => {
      const b = e.target.closest('[data-remove]');
      if (b) { tags.splice(Number(b.dataset.remove), 1); renderChips(); }
    });
    $('.me-tags').addEventListener('click', (e) => { if (e.target === e.currentTarget) tagInput.focus(); });
    renderChips();

    // ---- Folder ----
    picker = createFolderPicker($('.me-folder-picker'), {
      folders,
      value: meta.folderId,
      onChange: changed,
      createFolder: async (name, parentId) => {
        const f = await api('/api/folders', { method: 'POST', body: { name, parentId } });
        folders = (await api('/api/library')).folders;
        return folders.find((x) => x.id === f.id) || f;
      },
    });
  }

  function titleStatus(m) {
    const el = $('.me-title-status');
    if (m.titleSync === 'failed') {
      el.innerHTML = `<span class="sp-error">Plaud didn’t take the last title change: ${esc(m.titleSyncError || 'unknown error')}</span>
        <button class="btn small" type="button" data-retry>Try again</button>`;
      $('[data-retry]').onclick = async () => {
        titleStatus(await api(`/api/meetings/${encodeURIComponent(meeting.id)}/meta/retry`, { method: 'POST' }));
      };
    } else if (['queued', 'syncing'].includes(m.titleSync)) {
      el.innerHTML = '<span class="me-hint">Updating the title in Plaud…</span>';
    } else {
      el.innerHTML = '';
    }
  }

  // Writes the form. Throws (and shows the message) if the server refuses.
  async function save() {
    const tagInput = $('.me-tag-input');
    if (tagInput?.value.trim()) { tagInput.value.split(',').forEach(handle.addTag); tagInput.value = ''; }
    const c = current();
    try {
      const saved = await api(`/api/meetings/${encodeURIComponent(meeting.id)}/meta`, {
        method: 'PUT',
        body: { title: c.title, tags, folderId: c.folderId, plaudTitle, startAt: meeting.startAt, durationMs: meeting.durationMs },
      });
      $('.me-error').innerHTML = '';
      meta = saved;
      titleStatus(saved);
      state.initial = JSON.stringify(current());
      changed();
      return saved;
    } catch (err) {
      $('.me-error').innerHTML = `<span class="sp-error">${esc(err.message)}</span>`;
      root.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      throw err;
    }
  }
}

// ---- File-name-safe titles ----

// ": " → " - ", other ":" → "-", "/" and "\\" → "-" (" / " → " - "),
// no leading ".", tidy spaces. "Meeting: A/B" → "Meeting - A-B".
export function safeTitle(title) {
  return String(title ?? '')
    .replace(/\s*:\s+/g, ' - ')
    .replace(/:/g, '-')
    .replace(/\s+[/\\]\s+/g, ' - ')
    .replace(/[/\\]/g, '-')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function illegalIn(title) {
  const found = [':', '/', '\\'].filter((c) => title.includes(c)).map((c) => `“${c}”`);
  if (/^\./.test(title)) found.push('a leading “.”');
  return found.length > 1 ? `${found.slice(0, -1).join(', ')} or ${found.at(-1)}` : found[0];
}
