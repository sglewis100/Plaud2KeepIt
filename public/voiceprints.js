// Settings → Voice Prints: browse people and their voice prints, rename a
// person (optionally in Plaud too), delete a single voice print, or delete a
// person with all their voice prints.

const $ = (sel, el = document) => el.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MAX_NAME = 32;

const fmtDate = (iso, withTime = false) => (iso
  ? new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', ...(withTime && { hour: 'numeric', minute: '2-digit' }) })
  : '—');
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');
const plaudLink = (fileId) => `https://web.plaud.ai/file/${encodeURIComponent(fileId.replace(/^of_/, ''))}`;

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json.data;
}

let people = [];
const expanded = new Set();
const selected = new Set();
const MAX_PRINTS = 10;
let editing = null;
let pollTimer = null;

// ---- Confirmation dialog ----

function confirmAction({ title, body, ok, danger = false, onOpen }) {
  const d = $('#vpConfirm');
  $('#vpConfirmTitle').textContent = title;
  $('#vpConfirmBody').innerHTML = body;
  const okBtn = $('#vpConfirmOk');
  okBtn.textContent = ok;
  okBtn.classList.toggle('danger', danger);
  d.returnValue = '';
  d.showModal();
  // Default focus on Cancel, so Enter alone never confirms.
  d.querySelector('button[value="cancel"]').focus();
  onOpen?.(d);
  return new Promise((resolve) => {
    d.addEventListener('close', () => resolve(d.returnValue === 'ok' ? d : null), { once: true });
  });
}

// ---- Loading & rendering ----

async function load() {
  try {
    people = await api('/api/voiceprints');
    for (const id of selected) if (!people.some((p) => p.id === id)) selected.delete(id);
    render();
    updateBar();
    const syncing = people.some((p) => p.meetings.some((m) => m.plaudSync === 'syncing'));
    clearTimeout(pollTimer);
    if (syncing) pollTimer = setTimeout(load, 2500);
  } catch (err) {
    showNotice(`Couldn’t load voice prints: ${esc(err.message)}`, true);
  }
}

function matches(p, q) {
  if (!q) return { person: true, prints: p.prints };
  const hit = (s) => (s || '').toLowerCase().includes(q);
  const person = hit(p.name);
  const prints = p.prints.filter((v) => hit(v.meetingName) || hit(v.plaudLabel));
  return { person, prints: person ? p.prints : prints, any: person || prints.length > 0, byMeeting: !person && prints.length > 0 };
}

function render() {
  const q = $('#vpQuery').value.trim().toLowerCase();
  const totalPrints = people.reduce((n, p) => n + p.prints.length, 0);
  $('#subtitle').textContent = `${people.length} ${people.length === 1 ? 'person' : 'people'} · ${totalPrints} voice print${totalPrints === 1 ? '' : 's'}`;

  const shown = people.map((p) => ({ p, m: matches(p, q) })).filter(({ m }) => !q || m.any);
  if (!people.length) {
    $('#people').innerHTML = `<div class="empty"><strong>No voice prints yet</strong>Name speakers in a meeting to start building voice prints.</div>`;
    return;
  }
  if (!shown.length) {
    $('#people').innerHTML = `<div class="empty"><strong>No matches</strong>Nothing matches “${esc(q)}”.</div>`;
    return;
  }
  $('#people').innerHTML = shown.map(({ p, m }) => personHtml(p, m, q)).join('');
}

function personHtml(p, m, q) {
  const open = expanded.has(p.id) || m.byMeeting;
  const last = p.prints.reduce((a, v) => (v.meetingStartAt > a ? v.meetingStartAt : a), '');
  const syncing = p.meetings.filter((x) => x.plaudSync === 'syncing').length;
  const failed = p.meetings.filter((x) => x.plaudSync === 'failed').length;
  const status = syncing
    ? `<span class="badge accent"><span class="spinner tiny"></span> Updating Plaud (${syncing})…</span>`
    : failed ? `<span class="badge warn">Plaud update failed (${failed})</span>` : '';
  const isEditing = editing === p.id;

  return `
    <article class="vp-person${open ? ' open' : ''}${selected.has(p.id) ? ' selected' : ''}" data-id="${p.id}">
      <div class="vp-person-head">
        <input type="checkbox" class="vp-select" data-id="${p.id}" ${selected.has(p.id) ? 'checked' : ''} aria-label="Select ${esc(p.name)}">
        <span class="vp-avatar">${esc(initials(p.name))}</span>
        <div class="vp-person-main">
          ${isEditing
            ? `<form class="vp-rename" data-id="${p.id}">
                 <input class="vp-rename-input" value="${esc(p.name)}" maxlength="${MAX_NAME}" aria-label="New name" spellcheck="false">
                 <button class="btn primary small" type="submit">Save</button>
                 <button class="btn small" type="button" data-action="cancel-edit">Cancel</button>
               </form>`
            : `<strong class="vp-name">${highlight(p.name, q)}</strong>`}
          <span class="vp-meta">${p.prints.length} voice print${p.prints.length === 1 ? '' : 's'} · ${p.meetings.length} meeting${p.meetings.length === 1 ? '' : 's'} · last heard ${fmtDate(last)}</span>
        </div>
        <div class="vp-person-actions">
          ${status}
          ${isEditing ? '' : `<button class="btn small" type="button" data-action="edit">Rename</button>`}
          ${isEditing ? '' : `<button class="btn small ghost danger-text" type="button" data-action="delete-person" title="Delete ${esc(p.name)} and all their voice prints">Delete</button>`}
          <button class="btn small ghost vp-toggle" type="button" data-action="toggle" aria-expanded="${open}">
            ${open ? 'Hide' : 'Show'} prints
            <svg viewBox="0 0 24 24" class="icon"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </div>
      </div>
      ${open ? printsHtml(p, m.prints, q) : ''}
    </article>`;
}

function printsHtml(p, prints, q) {
  if (!p.prints.length) return `<div class="vp-prints empty-row">No voice prints. ${esc(p.name)} won’t be recognized automatically until named in another meeting.</div>`;
  return `
    <div class="vp-prints">
      <table>
        <thead><tr><th>Meeting</th><th>Meeting date</th><th>Plaud label</th><th>Speech</th><th>Quality</th><th>Discovered</th><th></th></tr></thead>
        <tbody>
          ${prints.map((v) => `
            <tr>
              <td class="vp-meeting"><a href="${plaudLink(v.fileId)}" target="_blank" rel="noopener" title="Open in Plaud">${highlight(v.meetingName || v.fileId, q)}</a></td>
              <td>${fmtDate(v.meetingStartAt)}</td>
              <td>${highlight(v.plaudLabel || '—', q)}</td>
              <td>${Math.round(v.seconds)}s</td>
              <td><span class="vp-quality" title="How consistent the clips were (higher is cleaner)">${v.consistency != null ? `${Math.round(v.consistency * 100)}%` : '—'}</span></td>
              <td>${fmtDate(v.discoveredAt, true)}</td>
              <td class="vp-row-actions"><button class="btn small ghost danger-text" type="button" data-action="delete" data-print="${v.id}">Delete</button></td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function highlight(text, q) {
  text = String(text ?? '');
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q);
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

function showNotice(html, isError = false) {
  const n = $('#notice');
  n.className = isError ? 'notice error' : 'notice';
  n.innerHTML = html;
  n.hidden = false;
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 1700);
}

// ---- Actions ----

$('#vpQuery').addEventListener('input', render);

$('#people').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const id = Number(btn.closest('.vp-person').dataset.id);
  const p = people.find((x) => x.id === id);
  switch (btn.dataset.action) {
    case 'toggle':
      expanded.has(id) ? expanded.delete(id) : expanded.add(id);
      return render();
    case 'edit':
      editing = id;
      render();
      return $('.vp-rename-input')?.select();
    case 'cancel-edit':
      editing = null;
      return render();
    case 'delete':
      return deletePrint(p, Number(btn.dataset.print));
    case 'delete-person':
      return deletePerson(p);
  }
});

$('#people').addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && e.target.matches('.vp-rename-input')) {
    editing = null;
    render();
  }
});

$('#people').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target.closest('.vp-rename');
  if (!form) return;
  const p = people.find((x) => x.id === Number(form.dataset.id));
  const name = form.querySelector('input').value.trim().replace(/\s+/g, ' ');
  if (!name) return;
  if (name === p.name) {
    editing = null;
    return render();
  }
  await renamePerson(p, name);
});

async function renamePerson(p, name) {
  const others = people.filter((x) => x.id !== p.id && x.name.toLowerCase() === name.toLowerCase());
  const n = p.meetings.length;
  const d = await confirmAction({
    title: `Rename “${p.name}” to “${name}”?`,
    body: `
      <p>Changes this person’s name everywhere in Plaud2KeepIt. Their ${p.prints.length} voice print${p.prints.length === 1 ? '' : 's'} stay with them.</p>
      ${others.length ? `<p class="vp-warn">Someone else is already named “${esc(others[0].name)}”. They’ll stay separate people with separate voice prints.</p>` : ''}
      ${n ? `<label class="vp-check"><input type="checkbox" id="vpAlsoPlaud" checked> Also rename in Plaud (${n} meeting${n === 1 ? '' : 's'})</label>` : ''}`,
    ok: 'Rename',
  });
  if (!d) return;
  const updatePlaud = !!d.querySelector('#vpAlsoPlaud')?.checked;
  try {
    const r = await api(`/api/speakers/${p.id}`, { method: 'PATCH', body: { name, updatePlaud } });
    editing = null;
    toast(r.plaudUpdating ? `Renamed. Updating Plaud in ${r.plaudUpdating} meeting${r.plaudUpdating === 1 ? '' : 's'}…` : 'Renamed');
    await load();
  } catch (err) {
    alert(`Couldn’t rename: ${err.message}`);
  }
}

async function deletePerson(p) {
  const n = p.prints.length, m = p.meetings.length;
  const d = await confirmAction({
    title: `Delete ${p.name}?`,
    body: `
      <p class="vp-warn-box">Deletes <b>${esc(p.name)}</b>${n ? ` and <b>${n === 1 ? 'their voice print' : `all ${n} voice prints`}</b>. They won’t be recognized automatically any more` : ' (no voice prints)'}.</p>
      ${m ? `<p>Their name is removed from ${m} meeting${m === 1 ? '' : 's'} here, so those speakers show as unnamed in Edit. Names already in Plaud stay there.</p>` : ''}
      <p>This can’t be undone.</p>`,
    ok: `Delete ${p.name}`,
    danger: true,
  });
  if (!d) return;
  try {
    await api(`/api/speakers/${p.id}`, { method: 'DELETE' });
    selected.delete(p.id);
    expanded.delete(p.id);
    updateBar();
    toast(`${p.name} deleted`);
    await load();
  } catch (err) {
    alert(`Couldn’t delete: ${err.message}`);
  }
}

async function deletePrint(p, printId) {
  const v = p.prints.find((x) => x.id === printId);
  const left = p.prints.length - 1;
  const d = await confirmAction({
    title: 'Delete this voice print?',
    body: `
      <dl class="vp-facts">
        <dt>Person</dt><dd>${esc(p.name)}</dd>
        <dt>Meeting</dt><dd>${esc(v.meetingName || v.fileId)}</dd>
        <dt>Date</dt><dd>${fmtDate(v.meetingStartAt)}</dd>
        <dt>Plaud label</dt><dd>${esc(v.plaudLabel || '—')}</dd>
      </dl>
      <p>${left
        ? `${esc(p.name)} will have ${left} voice print${left === 1 ? '' : 's'} left.`
        : `<span class="vp-warn">${esc(p.name)} will have no voice prints left and won’t be recognized automatically.</span>`}
        Their name on that meeting stays, here and in Plaud. This can’t be undone.</p>`,
    ok: 'Delete voice print',
    danger: true,
  });
  if (!d) return;
  try {
    await api(`/api/voiceprints/${printId}`, { method: 'DELETE' });
    toast('Voice print deleted');
    await load();
  } catch (err) {
    alert(`Couldn’t delete: ${err.message}`);
  }
}

// ---- Selecting & merging people ----

$('#people').addEventListener('change', (e) => {
  if (!e.target.matches('.vp-select')) return;
  const id = Number(e.target.dataset.id);
  e.target.checked ? selected.add(id) : selected.delete(id);
  e.target.closest('.vp-person').classList.toggle('selected', e.target.checked);
  updateBar();
});

function updateBar() {
  const n = selected.size;
  $('#vpBar').hidden = !n;
  $('#vpBarText').textContent = `${n} selected`;
  $('#vpMerge').disabled = n < 2;
  $('#vpMerge').title = n < 2 ? 'Select at least two people to merge' : '';
  document.body.classList.toggle('has-bar', n > 0);
}

$('#vpClear').addEventListener('click', () => {
  selected.clear();
  render();
  updateBar();
});

$('#vpMerge').addEventListener('click', mergeSelected);

async function mergeSelected() {
  const group = people.filter((p) => selected.has(p.id));
  if (group.length < 2) return;
  const prints = group.reduce((n, p) => n + p.prints.length, 0);
  const meetings = group.reduce((n, p) => n + p.meetings.length, 0);
  const keepDefault = [...group].sort((a, b) => b.prints.length - a.prints.length || b.meetings.length - a.meetings.length)[0];
  let sim = null;
  try { sim = await api(`/api/speakers/similarity?ids=${group.map((p) => p.id).join(',')}`); } catch {}

  const th = sim?.thresholds;
  const simLine = sim?.best == null
    ? '<p>There aren’t enough voice prints to compare how these people sound.</p>'
    : sim.best >= th.strong
      ? `<p class="vp-good">Their voices match (${Math.round(sim.best * 100)}%), so they’re very likely the same person.</p>`
      : sim.best >= th.possible
        ? `<p class="vp-warn">Their voices are only a possible match (${Math.round(sim.best * 100)}%). Listen to a meeting of each before merging.</p>`
        : `<p class="vp-bad">Their voices don’t match (${Math.round(Math.max(0, sim.best) * 100)}%). These sound like different people.</p>`;
  const different = sim?.best != null && sim.best < th.possible;

  const d = await confirmAction({
    title: `Merge ${group.length} people?`,
    body: `
      <p class="vp-warn-box">You are about to merge <b>${prints} voice print${prints === 1 ? '' : 's'}</b> from <b>${group.length} people</b> (${meetings} meeting${meetings === 1 ? '' : 's'}) into one person. This can’t be undone.</p>
      ${simLine}
      <fieldset class="vp-keep">
        <legend>Keep the name</legend>
        ${group.map((p) => `
          <label><input type="radio" name="vpKeep" value="${p.id}" ${p.id === keepDefault.id ? 'checked' : ''}>
            <b>${esc(p.name)}</b> <span>${p.prints.length} print${p.prints.length === 1 ? '' : 's'} · ${p.meetings.length} meeting${p.meetings.length === 1 ? '' : 's'}</span></label>`).join('')}
      </fieldset>
      ${prints > MAX_PRINTS ? `<p>Keeps the ${MAX_PRINTS} most distinct voice prints; ${prints - MAX_PRINTS} near-duplicates will be dropped.</p>` : ''}
      <label class="vp-check" id="vpPlaudRow"><input type="checkbox" id="vpAlsoPlaud" checked> <span id="vpPlaudText"></span></label>`,
    ok: different ? 'Merge anyway' : `Merge ${group.length} people`,
    danger: true,
    onOpen: (dlg) => {
      const sync = () => {
        const keep = group.find((p) => p.id === Number(dlg.querySelector('input[name="vpKeep"]:checked').value));
        const k = group.filter((p) => p.name !== keep.name).reduce((n, p) => n + p.meetings.length, 0);
        dlg.querySelector('#vpPlaudRow').hidden = !k;
        dlg.querySelector('#vpPlaudText').textContent = `Also rename to “${keep.name}” in Plaud (${k} meeting${k === 1 ? '' : 's'})`;
      };
      dlg.querySelectorAll('input[name="vpKeep"]').forEach((r) => r.addEventListener('change', sync));
      sync();
    },
  });
  if (!d) return;
  const targetId = Number(d.querySelector('input[name="vpKeep"]:checked').value);
  const updatePlaud = !!d.querySelector('#vpAlsoPlaud')?.checked;
  try {
    const r = await api('/api/speakers/merge', { method: 'POST', body: { targetId, sourceIds: group.map((p) => p.id), updatePlaud } });
    selected.clear();
    expanded.add(targetId);
    toast(`Merged into ${r.name}${r.plaudUpdating ? ` · updating Plaud in ${r.plaudUpdating} meeting${r.plaudUpdating === 1 ? '' : 's'}` : ''}`);
    await load();
  } catch (err) {
    alert(`Couldn’t merge: ${err.message}`);
  }
}

load();
