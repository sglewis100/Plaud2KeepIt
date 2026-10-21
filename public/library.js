// Settings → Folders & Tags: a folder tree (rename, move, delete, new) and a
// tag cloud (rename, delete). Selecting a folder or tag lists its meetings.
import { folderOptions } from './meeting-edit.js';
import { openSpeakerDialog } from './speakers-ui.js';

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

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

let folders = [];
let tags = [];
let selection = null; // { kind: 'folder', id } | { kind: 'unfiled' } | { kind: 'tag', id }
let deep = true;
const collapsed = new Set();

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 1900);
}

// Modal for confirmations and small forms. Cancel has focus, so Enter alone
// never confirms; fields with `autofocus` take focus instead.
function ask({ title, body, ok, danger = false, onOpen }) {
  const d = $('#libDialog');
  $('#libDialogTitle').textContent = title;
  $('#libDialogBody').innerHTML = body;
  const okBtn = $('#libDialogOk');
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  d.returnValue = '';
  d.showModal();
  ($('[autofocus]', d) || d.querySelector('button[value="cancel"]')).focus();
  // Enter in a text field means "OK" (by default a form would use its first
  // button, which is Cancel).
  d.querySelectorAll('input[type="text"], input:not([type])').forEach((i) => {
    i.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (d.querySelector('form').reportValidity()) d.close('ok');
    });
  });
  onOpen?.(d);
  return new Promise((resolve) => d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? d : null), { once: true }));
}

// ---- Load & render ----

async function load() {
  ({ folders, tags } = await api('/api/library'));
  const meetings = folders.reduce((n, f) => n + f.count, 0);
  $('#subtitle').textContent = `${plural(folders.length, 'folder')} · ${plural(tags.length, 'tag')} · ${plural(meetings, 'filed meeting')}`;
  if (selection?.kind === 'folder' && !folders.some((f) => f.id === selection.id)) selection = null;
  if (selection?.kind === 'tag' && !tags.some((t) => t.id === selection.id)) selection = null;
  renderTree();
  renderCloud();
  renderDetail();
}

function renderTree() {
  const kids = (pid) => folders.filter((f) => (f.parentId ?? null) === pid).sort((a, b) => a.name.localeCompare(b.name));
  const row = (f, depth) => {
    const children = kids(f.id);
    const open = !collapsed.has(f.id);
    const sel = selection?.kind === 'folder' && selection.id === f.id;
    return `
      <div class="lib-node${sel ? ' selected' : ''}" role="treeitem" aria-expanded="${children.length ? open : ''}" data-folder="${f.id}" style="--depth:${depth}" tabindex="0">
        <button class="lib-caret${children.length ? '' : ' hidden'}" type="button" data-toggle="${f.id}" aria-label="${open ? 'Collapse' : 'Expand'}">
          <svg viewBox="0 0 24 24"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
        <svg viewBox="0 0 24 24" class="icon lib-folder-icon"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
        <span class="lib-node-name">${esc(f.name)}</span>
        <span class="lib-count" title="${plural(f.count, 'meeting')} here, ${f.total} including subfolders">${f.total}</span>
      </div>
      ${children.length && open ? children.map((c) => row(c, depth + 1)).join('') : ''}`;
  };
  const unfiledSel = selection?.kind === 'unfiled';
  $('#tree').innerHTML = (folders.length
    ? kids(null).map((f) => row(f, 0)).join('')
    : '<p class="me-hint lib-empty">No folders yet. Create one here, or from a meeting’s Edit dialog.</p>')
    + `<div class="lib-node lib-unfiled${unfiledSel ? ' selected' : ''}" data-unfiled tabindex="0" style="--depth:0">
         <span class="lib-caret hidden"></span>
         <svg viewBox="0 0 24 24" class="icon lib-folder-icon"><path d="M4 7h16M4 12h16M4 17h10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>
         <span class="lib-node-name">Edited meetings without a folder</span>
       </div>`;
}

function renderCloud() {
  if (!tags.length) {
    $('#cloud').innerHTML = '<p class="me-hint lib-empty">No tags yet. Add them from a meeting’s Edit dialog.</p>';
    return;
  }
  const max = Math.max(...tags.map((t) => t.count), 1);
  // Log scale so one very popular tag doesn't flatten the rest: 13px → 30px.
  const size = (n) => 13 + (17 * Math.log(1 + n)) / Math.log(1 + max);
  $('#cloud').innerHTML = tags.map((t) => {
    const sel = selection?.kind === 'tag' && selection.id === t.id;
    const weight = t.count / max;
    return `<button type="button" class="lib-tag${sel ? ' selected' : ''}${t.count ? '' : ' unused'}" data-tag="${t.id}"
              style="font-size:${size(t.count).toFixed(1)}px; --w:${weight.toFixed(2)}" title="${plural(t.count, 'meeting')}">${esc(t.name)}</button>`;
  }).join('');
}

async function renderDetail() {
  const el = $('#detail');
  if (!selection) {
    el.innerHTML = `<div class="empty"><strong>Pick a folder or a tag</strong>Its meetings show up here, along with ways to rename, move or delete it.</div>`;
    return;
  }
  let head = '', query = '';
  if (selection.kind === 'folder') {
    const f = folders.find((x) => x.id === selection.id);
    const hasKids = folders.some((x) => x.parentId === f.id);
    head = `
      <div class="lib-detail-head">
        <div>
          <span class="sp-eyebrow">Folder</span>
          <h2>${esc(f.path)}</h2>
          <span class="me-hint">${plural(f.count, 'meeting')} here${hasKids ? ` · ${f.total} including subfolders` : ''}</span>
        </div>
        <div class="lib-detail-actions">
          <button class="btn small" type="button" data-act="subfolder">+ Subfolder</button>
          <button class="btn small" type="button" data-act="rename-folder">Rename</button>
          <button class="btn small" type="button" data-act="move-folder">Move</button>
          <button class="btn small danger-text" type="button" data-act="delete-folder">Delete</button>
        </div>
      </div>
      ${hasKids ? `<label class="vp-check lib-deep"><input type="checkbox" id="deep" ${deep ? 'checked' : ''}> Include subfolders</label>` : ''}`;
    query = `folder=${f.id}${hasKids && deep ? '&deep=1' : ''}`;
  } else if (selection.kind === 'unfiled') {
    head = `<div class="lib-detail-head"><div><span class="sp-eyebrow">No folder</span><h2>Edited meetings without a folder</h2>
      <span class="me-hint">Meetings you’ve edited or tagged here but haven’t filed.</span></div></div>`;
    query = 'folder=none';
  } else {
    const t = tags.find((x) => x.id === selection.id);
    head = `
      <div class="lib-detail-head">
        <div>
          <span class="sp-eyebrow">Tag</span>
          <h2><span class="org-tag lib-big-tag">${esc(t.name)}</span></h2>
          <span class="me-hint">${plural(t.count, 'meeting')}</span>
        </div>
        <div class="lib-detail-actions">
          <button class="btn small" type="button" data-act="rename-tag">Rename</button>
          <button class="btn small danger-text" type="button" data-act="delete-tag">Delete</button>
        </div>
      </div>`;
    query = `tag=${t.id}`;
  }
  el.innerHTML = `${head}<div class="lib-meetings"><div class="me-loading"><span class="spinner"></span></div></div>`;
  $('#deep')?.addEventListener('change', (e) => { deep = e.target.checked; renderDetail(); });
  try {
    const list = await api(`/api/library/meetings?${query}`);
    $('.lib-meetings', el).innerHTML = list.length
      ? list.map((m) => `
          <button type="button" class="lib-meeting" data-meeting="${esc(m.id)}">
            <span class="lib-meeting-title">${esc(m.title)}</span>
            <span class="lib-meeting-meta">${m.startAt ? new Date(m.startAt).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : ''}${m.durationMs ? ` · ${Math.round(m.durationMs / 60000)} min` : ''}${selection.kind !== 'folder' && m.folderPath ? ` · ${esc(m.folderPath)}` : ''}</span>
            ${m.tags?.length ? `<span class="title-org">${m.tags.map((t) => `<span class="org-tag">${esc(t)}</span>`).join('')}</span>` : ''}
          </button>`).join('')
      : '<p class="me-hint lib-empty">No meetings here yet.</p>';
    $('.lib-meetings', el).onclick = (e) => {
      const b = e.target.closest('[data-meeting]');
      if (!b) return;
      const m = list.find((x) => x.id === b.dataset.meeting);
      openSpeakerDialog({ id: m.id, name: m.title, plaudName: m.titleSync === 'done' ? m.title : null, startAt: m.startAt, durationMs: m.durationMs },
        { onSaved: () => { toast('Saved'); load(); } });
    };
  } catch (err) {
    $('.lib-meetings', el).innerHTML = `<div class="notice error">${esc(err.message)}</div>`;
  }
}

// ---- Selection ----

$('#tree').addEventListener('click', (e) => {
  const tog = e.target.closest('[data-toggle]');
  if (tog) {
    const id = Number(tog.dataset.toggle);
    collapsed.has(id) ? collapsed.delete(id) : collapsed.add(id);
    return renderTree();
  }
  const node = e.target.closest('.lib-node');
  if (!node) return;
  selection = node.dataset.unfiled !== undefined ? { kind: 'unfiled' } : { kind: 'folder', id: Number(node.dataset.folder) };
  renderTree(); renderCloud(); renderDetail();
});
$('#tree').addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.matches('.lib-node')) e.target.click(); });

$('#cloud').addEventListener('click', (e) => {
  const t = e.target.closest('[data-tag]');
  if (!t) return;
  selection = { kind: 'tag', id: Number(t.dataset.tag) };
  renderTree(); renderCloud(); renderDetail();
});

// ---- Folder actions ----

$('#newFolder').addEventListener('click', () => newFolder(selection?.kind === 'folder' ? selection.id : null));

async function newFolder(parentId) {
  const d = await ask({
    title: 'New folder',
    body: `<label class="me-field"><span>Name</span><input class="me-new-name" id="fName" maxlength="60" required autofocus></label>
           <label class="me-field"><span>Inside</span><select class="me-new-parent" id="fParent">${folderOptions(folders, parentId, { none: 'Top level' })}</select></label>`,
    ok: 'Create',
  });
  if (!d) return;
  try {
    const f = await api('/api/folders', { method: 'POST', body: { name: $('#fName', d).value, parentId: Number($('#fParent', d).value) || null } });
    if (f.parentId) collapsed.delete(f.parentId);
    selection = { kind: 'folder', id: f.id };
    toast(`Created “${f.path}”`);
    await load();
  } catch (err) { alert(err.message); }
}

$('#detail').addEventListener('click', (e) => {
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) return;
  const f = selection?.kind === 'folder' && folders.find((x) => x.id === selection.id);
  const t = selection?.kind === 'tag' && tags.find((x) => x.id === selection.id);
  ({
    subfolder: () => newFolder(f.id),
    'rename-folder': () => renameFolder(f),
    'move-folder': () => moveFolder(f),
    'delete-folder': () => deleteFolder(f),
    'rename-tag': () => renameTag(t),
    'delete-tag': () => deleteTag(t),
  })[act]?.();
});

async function renameFolder(f) {
  const d = await ask({
    title: `Rename “${f.name}”`,
    body: `<label class="me-field"><span>New name</span><input class="me-new-name" id="fName" maxlength="60" value="${esc(f.name)}" required autofocus></label>
           <p class="me-hint">${plural(f.total, 'meeting')} in this folder${f.total !== f.count ? ' and its subfolders' : ''} will show the new name.</p>`,
    ok: 'Rename',
    onOpen: (dlg) => $('#fName', dlg).select(),
  });
  if (!d) return;
  const name = $('#fName', d).value.trim();
  if (!name || name === f.name) return;
  try {
    await api(`/api/folders/${f.id}`, { method: 'PATCH', body: { name } });
    toast(`Renamed to “${name}”`);
    await load();
  } catch (err) { alert(err.message); }
}

async function moveFolder(f) {
  const own = new Set([f.id]);
  const addKids = (id) => folders.filter((x) => x.parentId === id).forEach((x) => { own.add(x.id); addKids(x.id); });
  addKids(f.id);
  const d = await ask({
    title: `Move “${f.name}”`,
    body: `<label class="me-field"><span>Move into</span><select class="me-new-parent" id="fParent">${folderOptions(folders, f.parentId, { none: 'Top level', exclude: own })}</select></label>
           <p class="me-hint">Its subfolders and ${plural(f.total, 'meeting')} move with it.</p>`,
    ok: 'Move',
  });
  if (!d) return;
  const parentId = Number($('#fParent', d).value) || null;
  if (parentId === (f.parentId ?? null)) return;
  try {
    const moved = await api(`/api/folders/${f.id}`, { method: 'PATCH', body: { parentId } });
    if (parentId) collapsed.delete(parentId);
    toast(`Moved to “${moved.path}”`);
    await load();
  } catch (err) { alert(err.message); }
}

async function deleteFolder(f) {
  const kids = folders.filter((x) => x.parentId === f.id);
  const parent = folders.find((x) => x.id === f.parentId);
  const up = parent ? `“${esc(parent.path)}”` : 'the top level';
  const d = await ask({
    title: `Delete “${f.name}”?`,
    body: `
      <p class="vp-warn-box">This folder holds ${plural(f.count, 'meeting')}${kids.length ? ` and ${plural(kids.length, 'subfolder')} (${plural(f.total, 'meeting')} in all)` : ''}. Meetings are never deleted, only refiled.</p>
      <fieldset class="vp-keep">
        <legend>What happens to its contents</legend>
        <label><input type="radio" name="mode" value="lift" checked> <b>Move them up</b> <span>${kids.length ? 'subfolders and meetings' : 'meetings'} go to ${up}</span></label>
        ${kids.length || f.count ? `<label><input type="radio" name="mode" value="all"> <b>Delete ${kids.length ? 'subfolders too' : 'the folder only'}</b> <span>its meetings${kids.length ? ' (and the subfolders’)' : ''} end up with no folder</span></label>` : ''}
      </fieldset>`,
    ok: 'Delete folder',
    danger: true,
  });
  if (!d) return;
  const mode = d.querySelector('input[name="mode"]:checked')?.value || 'lift';
  try {
    const r = await api(`/api/folders/${f.id}?mode=${mode}`, { method: 'DELETE' });
    selection = parent ? { kind: 'folder', id: parent.id } : null;
    toast(`Deleted “${r.deleted}”${r.meetingsMoved ? ` · ${plural(r.meetingsMoved, 'meeting')} refiled` : ''}`);
    await load();
  } catch (err) { alert(err.message); }
}

// ---- Tag actions ----

async function renameTag(t) {
  const d = await ask({
    title: `Rename “${t.name}”`,
    body: `<label class="me-field"><span>New name</span><input class="me-new-name" id="tName" maxlength="60" value="${esc(t.name)}" required autofocus></label>
           <p class="me-hint">Updates ${plural(t.count, 'meeting')}.</p>`,
    ok: 'Rename',
    onOpen: (dlg) => $('#tName', dlg).select(),
  });
  if (!d) return;
  const name = $('#tName', d).value.trim();
  if (!name || name === t.name) return;
  try {
    await api(`/api/tags/${t.id}`, { method: 'PATCH', body: { name } });
    toast(`Renamed to “${name}”`);
    await load();
  } catch (err) {
    if (!err.conflict) return alert(err.message);
    const other = tags.find((x) => x.id === err.conflict.id);
    const ok = await ask({
      title: `Merge into “${err.conflict.name}”?`,
      body: `<p class="vp-warn-box">There’s already a tag named “${esc(err.conflict.name)}” (${plural(other?.count ?? 0, 'meeting')}). Merging moves all ${plural(t.count, 'meeting')} tagged “${esc(t.name)}” onto it and removes “${esc(t.name)}”.</p>`,
      ok: 'Merge tags',
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api(`/api/tags/${t.id}`, { method: 'PATCH', body: { name, merge: true } });
      selection = { kind: 'tag', id: r.id };
      toast(`Merged into “${r.name}”`);
      await load();
    } catch (e2) { alert(e2.message); }
  }
}

async function deleteTag(t) {
  const d = await ask({
    title: `Delete the tag “${t.name}”?`,
    body: `<p class="vp-warn-box">Removes it from ${plural(t.count, 'meeting')}. The meetings themselves stay. This can’t be undone.</p>`,
    ok: 'Delete tag',
    danger: true,
  });
  if (!d) return;
  try {
    const r = await api(`/api/tags/${t.id}`, { method: 'DELETE' });
    selection = null;
    toast(`Deleted “${r.deleted}” from ${plural(r.meetings, 'meeting')}`);
    await load();
  } catch (err) { alert(err.message); }
}

// ---- Clean up unused tags and empty folders ----

$('#cleanUp').addEventListener('click', async () => {
  let unused;
  try { unused = await api('/api/library/unused'); } catch (err) { return alert(err.message); }
  const { tags: t, folders: f } = unused;
  if (!t.length && !f.length) return toast('Nothing to clean up: every tag and folder is in use');
  const list = (items) => `<ul class="kp-list">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  const d = await ask({
    title: 'Clean up unused tags and folders?',
    body: `
      ${t.length ? `<p><b>${plural(t.length, 'tag')}</b> no meeting uses:</p>${list(t.map((x) => x.name))}` : ''}
      ${f.length ? `<p><b>${plural(f.length, 'folder')}</b> with no meetings (including subfolders):</p>${list(f.map((x) => x.path))}` : ''}
      <p class="me-hint">Meetings aren’t affected. This can’t be undone.</p>`,
    ok: 'Remove them',
    danger: true,
  });
  if (!d) return;
  try {
    const r = await api('/api/library/cleanup', { method: 'POST' });
    selection = null;
    toast(`Removed ${[r.tags.length && plural(r.tags.length, 'tag'), r.folders.length && plural(r.folders.length, 'folder')].filter(Boolean).join(' and ')}`);
    await load();
  } catch (err) { alert(err.message); }
});

load().catch((err) => { $('#detail').innerHTML = `<div class="notice error">Couldn’t load: ${esc(err.message)}</div>`; });
