// Folder picker: a button showing the chosen folder's path. Clicking opens a
// panel with a search box over a scrollable folder tree. Typing filters the
// tree (matches keep their parent folders, dimmed, for context); ↑/↓ move,
// Enter picks, Esc closes the panel. If nothing matches exactly, the last
// option creates the typed folder; "Clients / Acme" creates both levels.
//
//   const picker = createFolderPicker(el, {
//     folders,                 // [{ id, name, parentId, path }]
//     value,                   // selected folder id or null
//     onChange(id),
//     createFolder(name, parentId) → folder,   // calls the API
//   });
//   picker.value

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ICON_FOLDER = '<svg viewBox="0 0 24 24" class="icon fp-icon"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>';
const ICON_NONE = '<svg viewBox="0 0 24 24" class="icon fp-icon"><circle cx="12" cy="12" r="8" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m6.5 17.5 11-11" stroke="currentColor" stroke-width="1.8"/></svg>';
const ICON_PLUS = '<svg viewBox="0 0 24 24" class="icon fp-icon"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

export function createFolderPicker(root, { folders, value = null, onChange, createFolder }) {
  root.classList.add('fp');
  root.innerHTML = `
    <button type="button" class="fp-button" aria-haspopup="listbox" aria-expanded="false">
      <span class="fp-current"></span>
      <svg viewBox="0 0 24 24" class="fp-chevron"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
    </button>
    <div class="fp-panel" hidden>
      <div class="fp-search">
        <svg viewBox="0 0 24 24" class="icon"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
        <input type="text" placeholder="Search or create a folder…" autocomplete="off" spellcheck="false" aria-label="Search folders">
      </div>
      <ul class="fp-list" role="listbox"></ul>
      <div class="fp-foot">Type <b>Parent / Child</b> to create nested folders</div>
    </div>`;
  const button = root.querySelector('.fp-button');
  const panel = root.querySelector('.fp-panel');
  const input = root.querySelector('.fp-search input');
  const list = root.querySelector('.fp-list');
  let options = []; // [{ kind: 'none' | 'folder' | 'create', id?, path? }]
  let active = 0;
  let busy = false;

  const byId = () => new Map(folders.map((f) => [f.id, f]));
  const pathOf = (id) => byId().get(id)?.path ?? null;

  function showCurrent() {
    const p = pathOf(value);
    root.querySelector('.fp-current').innerHTML = p
      ? `${ICON_FOLDER}<span>${esc(p)}</span>`
      : `<span class="fp-placeholder">No folder</span>`;
  }

  function open() {
    panel.hidden = false;
    button.setAttribute('aria-expanded', 'true');
    input.value = '';
    render();
    input.focus();
    list.querySelector('.selected')?.scrollIntoView({ block: 'nearest' });
  }

  function close({ focus = true } = {}) {
    if (panel.hidden) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
    if (focus) button.focus();
  }

  function render() {
    const q = input.value.trim().toLowerCase();
    const segs = q.split('/').map((s) => s.trim()).filter(Boolean);
    const map = byId();
    const kids = (pid) => folders.filter((f) => (f.parentId ?? null) === pid).sort((a, b) => a.name.localeCompare(b.name));
    // With a search: keep folders whose name (or "a / b" path) matches, plus their ancestors.
    const matches = new Set();
    if (q) {
      for (const f of folders) {
        const hit = segs.length > 1 ? f.path.toLowerCase().replace(/\s*\/\s*/g, '/').includes(segs.join('/')) : f.name.toLowerCase().includes(q);
        if (hit) matches.add(f.id);
      }
    }
    const keep = new Set();
    for (const id of matches) for (let f = map.get(id); f; f = map.get(f.parentId)) keep.add(f.id);

    options = [];
    const rows = [];
    if (!q) {
      options.push({ kind: 'none' });
      rows.push({ kind: 'none', depth: 0 });
    }
    const walk = (pid, depth) => {
      for (const f of kids(pid)) {
        if (q && !keep.has(f.id)) continue;
        const selectable = !q || matches.has(f.id);
        if (selectable) options.push({ kind: 'folder', id: f.id });
        rows.push({ kind: 'folder', f, depth, selectable, idx: selectable ? options.length - 1 : -1 });
        walk(f.id, depth + 1);
      }
    };
    walk(null, 0);
    // Offer to create what was typed unless it already exists exactly.
    const typed = input.value.trim().split('/').map((s) => s.trim().replace(/\s+/g, ' ')).filter(Boolean);
    const exact = typed.length && folders.some((f) => f.path.toLowerCase() === typed.join(' / ').toLowerCase());
    if (typed.length && !exact) {
      options.push({ kind: 'create', path: typed });
      rows.push({ kind: 'create', path: typed, idx: options.length - 1 });
    }
    if (rows[0]?.kind === 'none') rows[0].idx = 0;

    // Highlight the current folder when browsing, the first match when searching.
    active = q ? 0 : Math.max(0, options.findIndex((o) => (o.kind === 'folder' ? o.id === value : o.kind === 'none' && value == null)));

    list.innerHTML = rows.map((r) => {
      if (r.kind === 'none') {
        return `<li class="fp-row${value == null ? ' selected' : ''}" data-idx="0" role="option">${ICON_NONE}<span>No folder</span></li>`;
      }
      if (r.kind === 'create') {
        const where = r.path.length > 1 ? r.path.join(' / ') : r.path[0];
        return `<li class="fp-row fp-create" data-idx="${r.idx}" role="option">${ICON_PLUS}<span>Create “${esc(where)}”</span></li>`;
      }
      const cls = ['fp-row', r.selectable ? '' : 'fp-context', r.f.id === value ? 'selected' : ''].filter(Boolean).join(' ');
      return `<li class="${cls}" ${r.selectable ? `data-idx="${r.idx}" role="option"` : 'aria-hidden="true"'} style="--depth:${r.depth}">
                ${ICON_FOLDER}<span>${mark(r.f.name, segs.at(-1) || '')}</span></li>`;
    }).join('') || '<li class="fp-empty">No folders yet. Type a name to create one.</li>';
    paintActive();
  }

  function paintActive() {
    list.querySelectorAll('[data-idx]').forEach((li) => li.classList.toggle('active', Number(li.dataset.idx) === active));
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }

  async function choose(i) {
    const o = options[i];
    if (!o || busy) return;
    if (o.kind === 'create') {
      busy = true;
      try {
        // Walk/create each level of "A / B / C".
        let parentId = null;
        for (const name of o.path) {
          const existing = folders.find((f) => (f.parentId ?? null) === parentId && f.name.toLowerCase() === name.toLowerCase());
          if (existing) { parentId = existing.id; continue; }
          const made = await createFolder(name, parentId);
          folders = [...folders, made];
          parentId = made.id;
        }
        set(parentId);
      } catch (err) {
        root.querySelector('.fp-foot').innerHTML = `<span class="sp-error">${esc(err.message)}</span>`;
      } finally {
        busy = false;
      }
      return;
    }
    set(o.kind === 'folder' ? o.id : null);
  }

  function set(id) {
    value = id;
    showCurrent();
    close();
    onChange?.(id);
  }

  button.addEventListener('click', () => (panel.hidden ? open() : close()));
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!options.length) return;
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      paintActive();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation(); // close the panel, not the dialog
      close();
    } else if (e.key === 'Tab') {
      close({ focus: false });
    }
  });
  list.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the search box
  list.addEventListener('click', (e) => {
    const li = e.target.closest('[data-idx]');
    if (li) choose(Number(li.dataset.idx));
  });
  list.addEventListener('mousemove', (e) => {
    const li = e.target.closest('[data-idx]');
    if (li && Number(li.dataset.idx) !== active) { active = Number(li.dataset.idx); paintActive(); }
  });
  document.addEventListener('mousedown', (e) => { if (!root.contains(e.target)) close({ focus: false }); });

  showCurrent();
  return {
    get value() { return value; },
    setFolders(next) { folders = next; showCurrent(); },
  };
}

function mark(text, q) {
  const i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
  if (i < 0) return esc(text);
  return `${esc(text.slice(0, i))}<b>${esc(text.slice(i, i + q.length))}</b>${esc(text.slice(i + q.length))}`;
}
