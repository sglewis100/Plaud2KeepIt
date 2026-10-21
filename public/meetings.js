import { openSpeakerDialog } from './speakers-ui.js';
import { sendToKeepIt } from './keepit-ui.js';

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

const MAX_LAST = 500;
const STORE_KEY = 'p2k.meetings.filter';

// ---- State (remembered per browser) ----

// listMode: the tab to return to when a search is cleared.
const defaults = { listMode: 'range', mode: 'range', range: 'week', from: null, to: null, n: 25, q: '', hideSynced: false };
let state = { ...defaults, ...load() };

function load() {
  try { return JSON.parse(localStorage.getItem(STORE_KEY)) || {}; } catch { return {}; }
}
function save() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch {}
}

// ---- Date helpers (all in the browser's local time) ----

const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const addMonths = (d, n) => { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; };
const toInputDate = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fromInputDate = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };

const RANGE_LABELS = {
  today: 'Today', week: 'This week', '2weeks': 'Last two weeks',
  month: 'Last month', '6months': 'Last six months', custom: 'Custom range',
};

// Returns [from, to) as Dates. "This Week" is the rolling last 7 days, including today.
function rangeBounds(key) {
  const today = startOfDay(new Date());
  const end = addDays(today, 1);
  switch (key) {
    case 'today': return [today, end];
    case 'week': return [addDays(today, -6), end];
    case '2weeks': return [addDays(today, -13), end];
    case 'month': return [addMonths(today, -1), end];
    case '6months': return [addMonths(today, -6), end];
    case 'custom': {
      const from = state.from ? fromInputDate(state.from) : addDays(today, -6);
      const to = state.to ? addDays(fromInputDate(state.to), 1) : end;
      return [from, to];
    }
  }
  return [addDays(today, -6), end];
}

const fmtDate = (d, opts = {}) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...opts });
const fmtTime = (d) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

function fmtSpan([from, to]) {
  const last = addDays(to, -1);
  const sameYear = from.getFullYear() === last.getFullYear() && from.getFullYear() === new Date().getFullYear();
  const o = sameYear ? {} : { year: 'numeric' };
  return +from === +startOfDay(last) ? fmtDate(from, { weekday: 'short', ...o }) : `${fmtDate(from, o)} – ${fmtDate(last, o)}`;
}

function fmtDuration(ms, { long = false } = {}) {
  if (ms == null) return '—';
  const totalMin = Math.round(ms / 60000);
  if (totalMin < 1) return `${Math.round(ms / 1000)}s`;
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  if (!h) return `${m}m`;
  return long || m ? `${h}h ${m}m` : `${h}h`;
}

function dayLabel(d) {
  const today = startOfDay(new Date());
  const day = startOfDay(d);
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  const opts = { weekday: 'long', month: 'short', day: 'numeric' };
  if (day.getFullYear() !== today.getFullYear()) opts.year = 'numeric';
  return day.toLocaleDateString(undefined, opts);
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function highlight(text, q) {
  if (!q) return esc(text);
  const i = text.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return esc(text);
  return esc(text.slice(0, i)) + '<mark>' + esc(text.slice(i, i + q.length)) + '</mark>' + esc(text.slice(i + q.length));
}

// ---- UI wiring ----

function syncControls() {
  $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.mode === state.mode)));
  $$('.mode').forEach((m) => { m.hidden = m.dataset.for !== state.mode; });

  $$('#rangeChips .chip').forEach((c) => c.classList.toggle('active', c.dataset.range === state.range));
  $('#rangeCustom').hidden = state.range !== 'custom';
  const bounds = rangeBounds(state.range);
  $('#rangeFrom').value = state.from || toInputDate(bounds[0]);
  $('#rangeTo').value = state.to || toInputDate(addDays(bounds[1], -1));
  $('#rangeHint').textContent = fmtSpan(bounds);

  const preset = [10, 25, 50, 100, 250].includes(state.n) && !state.nCustom;
  $$('#lastChips .chip').forEach((c) =>
    c.classList.toggle('active', preset ? Number(c.dataset.n) === state.n : c.dataset.n === 'custom'));
  $('#lastCustom').hidden = preset;
  $('#lastN').value = state.n;

  $('#searchInput').value = state.q;
}

function describe() {
  if (state.mode === 'range') return `${RANGE_LABELS[state.range]} · ${fmtSpan(rangeBounds(state.range))}`;
  if (state.mode === 'last') return `Your ${state.n} most recent meetings`;
  return state.q ? `Meetings matching “${state.q}”` : 'Search meetings by name';
}

$$('.tab').forEach((t) => t.addEventListener('click', () => {
  if (state.mode === t.dataset.mode) return;
  state.mode = t.dataset.mode;
  if (state.mode !== 'search') state.listMode = state.mode;
  save(); syncControls();
  if (state.mode === 'search') {
    $('#searchInput').focus();
    if (!state.q) return showSearchPrompt();
  }
  refresh();
}));

$$('#rangeChips .chip').forEach((c) => c.addEventListener('click', () => {
  const key = c.dataset.range;
  if (key === 'custom') {
    // Seed the custom pickers with whatever range was showing.
    const [from, to] = rangeBounds(state.range);
    state.from = state.from || toInputDate(from);
    state.to = state.to || toInputDate(addDays(to, -1));
    state.range = 'custom';
    save(); syncControls();
    $('#rangeFrom').focus();
    return;
  }
  state.range = key;
  save(); syncControls(); refresh();
}));

$('#rangeCustom').addEventListener('submit', (e) => {
  e.preventDefault();
  let from = $('#rangeFrom').value, to = $('#rangeTo').value;
  if (!from || !to) return;
  if (from > to) [from, to] = [to, from];
  Object.assign(state, { range: 'custom', from, to });
  save(); syncControls(); refresh();
});

$$('#lastChips .chip').forEach((c) => c.addEventListener('click', () => {
  if (c.dataset.n === 'custom') {
    state.nCustom = true;
    save(); syncControls();
    $('#lastN').select();
    return;
  }
  Object.assign(state, { n: Number(c.dataset.n), nCustom: false });
  save(); syncControls(); refresh();
}));

$('#lastCustom').addEventListener('submit', (e) => {
  e.preventDefault();
  const n = Math.round(Number($('#lastN').value));
  if (!(n >= 1 && n <= MAX_LAST)) return $('#lastN').reportValidity();
  Object.assign(state, { n, nCustom: true });
  save(); syncControls(); refresh();
});

$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  state.q = $('#searchInput').value.trim();
  save();
  state.q ? refresh() : clearSearch();
});

// Clearing the search (✕ in the box, Enter on an empty box, or leaving it
// empty) goes back to the list you were on before searching. Emptying the box
// while still typing doesn't.
function clearSearch() {
  state.q = '';
  $('#searchInput').value = '';
  state.mode = state.listMode === 'last' ? 'last' : 'range';
  save(); syncControls(); refresh();
}
$('#searchInput').addEventListener('search', () => { if (!$('#searchInput').value.trim()) clearSearch(); });
$('#searchInput').addEventListener('blur', () => {
  if (state.mode === 'search' && state.q && !$('#searchInput').value.trim()) clearSearch();
});

$('#reload').addEventListener('click', () => refresh());

$('#hideSynced').checked = !!state.hideSynced;
$('#hideSynced').addEventListener('change', (e) => {
  state.hideSynced = e.target.checked;
  save();
  if (lastData) render(lastData);
});

// ---- Loading & rendering ----

let requestId = 0;

function apiUrl() {
  if (state.mode === 'last') return `/api/meetings?mode=last&n=${state.n}`;
  if (state.mode === 'search') return `/api/meetings?mode=search&q=${encodeURIComponent(state.q)}`;
  const [from, to] = rangeBounds(state.range);
  return `/api/meetings?mode=range&from=${from.toISOString()}&to=${to.toISOString()}`;
}

async function refresh() {
  const id = ++requestId;
  $('#subtitle').textContent = describe();
  $('#notice').hidden = true;
  $('#stats').hidden = true;
  $('#reload').disabled = true;
  $('#results').replaceChildren($('#skeleton').content.cloneNode(true));

  try {
    const r = await fetch(apiUrl()).then((res) => res.json());
    if (id !== requestId) return;
    if (!r.ok) throw new Error(r.error);
    render(r.data);
  } catch (err) {
    if (id !== requestId) return;
    showError(err.message);
  } finally {
    if (id === requestId) $('#reload').disabled = false;
  }
}

let meetingsById = new Map();
let rowCtx = { max: 0, q: '' };
let selectedId = null;

let lastData = null;
const fullyInKeepIt = (m) => m.keepIt?.sync === 'full' && m.keepIt?.status !== 'running';

function render(data) {
  lastData = data;
  const { complete, note, scannedBackTo } = data;
  // "Hide synced items": hide meetings fully in Keep It (partial ones stay).
  const hidden = state.hideSynced ? data.meetings.filter(fullyInKeepIt).length : 0;
  const meetings = state.hideSynced ? data.meetings.filter((m) => !fullyInKeepIt(m)) : data.meetings;
  meetingsById = new Map(data.meetings.map((m) => [m.id, m]));
  if (!meetingsById.has(selectedId)) selectedId = null;
  const durations = meetings.map((m) => m.durationMs).filter((d) => d != null);
  const total = durations.reduce((a, b) => a + b, 0);
  const max = durations.length ? Math.max(...durations) : 0;

  $('#statCount').textContent = meetings.length.toLocaleString();
  $('#statTotal').textContent = fmtDuration(total, { long: true });
  $('#statAvg').textContent = durations.length ? fmtDuration(total / durations.length) : '—';
  $('#statMax').textContent = max ? fmtDuration(max) : '—';
  $('#stats').hidden = false;
  $('#subtitle').textContent = `${describe()} · ${meetings.length} meeting${meetings.length === 1 ? '' : 's'}${hidden ? ` · ${hidden} already in Keep It hidden` : ''}`;

  if (state.mode === 'search' && complete === false) {
    const back = scannedBackTo ? ` Searched back to ${fmtDate(new Date(scannedBackTo), { year: 'numeric' })}.` : '';
    showNotice(`Plaud only searches your newest 500 recordings, so older matches may be missing.${back}${note ? ` ${esc(note)}` : ''}`);
  }

  if (!meetings.length) {
    $('#results').innerHTML = `
      <div class="empty">
        <svg viewBox="0 0 24 24"><rect x="3.5" y="5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M3.5 10h17M8 3v4M16 3v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
        <strong>${hidden ? 'Everything here is in Keep It' : 'No meetings found'}</strong>
        ${hidden ? 'Turn off “Hide synced” to see them.' : state.mode === 'search' ? 'Try a different search term.' : 'Try a wider range.'}
      </div>`;
    return;
  }

  // Group by local day, newest first.
  const groups = new Map();
  for (const m of meetings) {
    const d = new Date(m.startAt);
    const key = toInputDate(d);
    if (!groups.has(key)) groups.set(key, { date: d, items: [] });
    groups.get(key).items.push(m);
  }

  const q = state.mode === 'search' ? state.q : '';
  rowCtx = { max, q };
  const html = [];
  for (const { date, items } of groups.values()) {
    const dayTotal = items.reduce((a, m) => a + (m.durationMs || 0), 0);
    html.push(`
      <div class="day">
        <div class="day-head">
          <span class="day-title">${esc(dayLabel(date))}</span>
          <span class="day-meta">${items.length} meeting${items.length === 1 ? '' : 's'} · ${fmtDuration(dayTotal, { long: true })}</span>
        </div>
        <div class="list">${items.map((m) => rowHtml(m, max, q)).join('')}</div>
      </div>`);
  }
  $('#results').innerHTML = html.join('');
}

function rowHtml(m, max, q) {
  const start = new Date(m.startAt);
  const end = m.durationMs != null ? new Date(start.getTime() + m.durationMs) : null;
  const created = m.createdAt ? new Date(m.createdAt) : null;
  const pct = max && m.durationMs ? Math.max(6, Math.round((m.durationMs / max) * 100)) : 0;
  const meta = [];
  if (created) meta.push(`<span title="${esc(created.toLocaleString())}">Uploaded ${esc(sameDay(created, start) ? fmtTime(created) : `${fmtDate(created)}, ${fmtTime(created)}`)}</span>`);
  if (m.serialNumber) meta.push(`<span>Device ${esc(m.serialNumber)}</span>`);
  const org = [];
  if (['queued', 'syncing'].includes(m.titleSync)) org.push('<span class="badge accent"><span class="spinner tiny"></span> Renaming in Plaud…</span>');
  if (m.titleSync === 'failed') org.push('<span class="badge warn" title="Open Edit to try again">Plaud title update failed</span>');
  const k = m.keepIt;
  if (k?.status === 'checking') org.push('<span class="badge"><span class="spinner tiny"></span> Checking…</span>');
  else if (k?.status === 'running') org.push(`<span class="badge accent"><span class="spinner tiny"></span> ${esc(k.step || 'Sending to Keep It…')}</span>`);
  else if (k?.status === 'failed') org.push(`<span class="badge warn" title="${esc(k.error || '')}">Keep It send failed</span>`);
  else if (k?.sync === 'full') org.push(`<span class="badge ok" title="Sent ${k.at ? esc(new Date(k.at).toLocaleString()) : ''}">${KEEPIT_ICON} In Keep It</span>`);
  else if (k?.sync === 'partial') org.push(`<span class="badge err" title="Missing from Keep It: ${esc((k.missing || []).join(', '))}">${KEEPIT_ICON} Partially in Keep It</span>`);
  if (m.folderPath) org.push(`<span class="org-folder" title="Folder"><svg viewBox="0 0 24 24" class="icon xs"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>${esc(m.folderPath)}</span>`);
  for (const t of m.tags || []) org.push(`<span class="org-tag">${esc(t)}</span>`);
  return `
    <div class="mrow${m.id === selectedId ? ' selected' : ''}" data-id="${esc(m.id)}" tabindex="0">
      <div class="time">${esc(fmtTime(start))}${end ? `<small>to ${esc(fmtTime(end))}</small>` : ''}</div>
      <div class="title">
        <div class="title-text" title="${esc(m.name)}">${highlight(m.name || 'Untitled', q)}</div>
        <div class="title-meta">${meta.join('')}</div>
        ${org.length ? `<div class="title-org">${org.join('')}</div>` : ''}
      </div>
      <span class="dur" title="${esc(fmtDuration(m.durationMs, { long: true }))}">
        <span class="dur-bar"><i style="width:${pct}%"></i></span>${esc(fmtDuration(m.durationMs))}
      </span>
      <div class="row-actions">
        <button type="button" class="btn primary small" data-action="edit">
          <svg viewBox="0 0 24 24" class="icon"><path d="M4 20h4L19 9a2.8 2.8 0 0 0-4-4L4 16z M13.5 6.5l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>
          Edit
        </button>
        <button type="button" class="btn small" data-action="keepit">
          ${KEEPIT_ICON}
          Send to Keep It
        </button>
      </div>
      <button type="button" class="row-id" data-copy="${esc(m.id)}" title="Copy recording ID">${esc(m.id)}</button>
    </div>`;
}

const sameDay = (a, b) => toInputDate(a) === toInputDate(b);

$('#results').addEventListener('click', async (e) => {
  const copy = e.target.closest('[data-copy]');
  if (copy) {
    try { await navigator.clipboard.writeText(copy.dataset.copy); toast('Recording ID copied'); } catch {}
    return;
  }
  const row = e.target.closest('.mrow[data-id]');
  if (!row) return;
  if (e.target.closest('[data-action="edit"]')) {
    const m = meetingsById.get(row.dataset.id);
    return openSpeakerDialog(m, { onSaved: (meta) => applyMeta(m, meta) });
  }
  if (e.target.closest('[data-action="keepit"]')) {
    const m = meetingsById.get(row.dataset.id);
    const btn = e.target.closest('[data-action="keepit"]');
    if (btn.disabled) return;
    btn.disabled = true;
    return sendToKeepIt(m, {
      toast,
      onNameSpeakers: (x) => openSpeakerDialog(x, { onSaved: (meta) => applyMeta(x, meta) }),
      onSaved: (meta) => applyMeta(m, meta, true),
      onStatus: (st) => {
        m.keepIt = st ? { status: st.status, sync: st.sync, missing: st.missing, step: st.step, error: st.error, at: st.finishedAt } : (m.keepItDone || null);
        if (st?.status === 'done') m.keepItDone = m.keepIt;
        rerenderRow(m);
      },
    }).finally(() => {
      const b = document.querySelector(`.mrow[data-id="${CSS.escape(m.id)}"] [data-action="keepit"]`);
      if (b) b.disabled = false;
    });
  }
  select(row.dataset.id === selectedId ? null : row.dataset.id);
});

$('#results').addEventListener('keydown', (e) => {
  const row = e.target.closest('.mrow[data-id]');
  if (row && (e.key === 'Enter' || e.key === ' ') && e.target === row) {
    e.preventDefault();
    select(row.dataset.id === selectedId ? null : row.dataset.id);
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selectedId && !document.querySelector('dialog[open]')) select(null);
});

// Show a saved edit in the list; keep checking while Plaud is renaming.
function rerenderRow(m) {
  const row = document.querySelector(`.mrow[data-id="${CSS.escape(m.id)}"]`);
  if (row) row.outerHTML = rowHtml(m, rowCtx.max, rowCtx.q);
}

const KEEPIT_ICON = '<svg viewBox="0 0 24 24" class="icon xs"><path d="M6 3.5h9l3 3V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="m9 13 2.2 2.2L15.5 11" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

function applyMeta(m, meta, quiet = false) {
  Object.assign(m, {
    name: meta.title,
    titleSync: meta.titleSync,
    tags: meta.tags,
    folderPath: meta.folderPath,
    folderId: meta.folderId,
  });
  const row = document.querySelector(`.mrow[data-id="${CSS.escape(m.id)}"]`);
  if (row) row.outerHTML = rowHtml(m, rowCtx.max, rowCtx.q);
  if (!quiet && ['queued', 'syncing'].includes(meta.titleSync) && !m.watching) {
    toast('Saved. Renaming in Plaud…');
    m.watching = true;
    const check = async (tries) => {
      try {
        const r = await fetch(`/api/meetings/${encodeURIComponent(m.id)}/meta`).then((x) => x.json());
        if (r.ok && !['queued', 'syncing'].includes(r.data.titleSync)) {
          m.watching = false;
          applyMeta(m, r.data, true);
          toast(r.data.titleSync === 'done' ? 'Title updated in Plaud' : 'Plaud didn’t take the new title. Open Edit to try again.');
          return;
        }
      } catch {}
      if (tries > 0) setTimeout(() => check(tries - 1), 1500);
      else m.watching = false;
    };
    setTimeout(() => check(60), 1500);
  } else if (!quiet && !m.watching) {
    toast('Saved');
  }
}

function select(id) {
  selectedId = id;
  $$('.mrow[data-id]').forEach((r) => r.classList.toggle('selected', r.dataset.id === id));
}

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.append(t);
  setTimeout(() => t.remove(), 1700);
}

function showNotice(html, isError = false) {
  const n = $('#notice');
  n.className = isError ? 'notice error' : 'notice';
  n.innerHTML = html;
  n.hidden = false;
}

function showError(message) {
  $('#results').replaceChildren();
  const signedOut = /not authenticated|login/i.test(message);
  showNotice(signedOut
    ? 'Plaud MCP isn’t signed in. <a href="/settings">Go to Settings</a> to sign in.'
    : `Couldn’t load meetings: ${esc(message)}`, true);
}

function showSearchPrompt() {
  $('#subtitle').textContent = describe();
  $('#stats').hidden = true;
  $('#notice').hidden = true;
  $('#results').innerHTML = `
    <div class="empty">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="m16 16 4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      <strong>Search your meetings</strong>
      Type part of a meeting name and press Enter.
    </div>`;
}

// ---- Start ----

syncControls();
if (state.mode === 'search' && !state.q) showSearchPrompt();
else refresh();
