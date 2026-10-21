// "Send to Keep It": checks the meeting first, then sends it.
//   1. Unnamed speakers ("Speaker 1") → warning: Cancel · Send to Keep It · Name Speakers
//   2. No tags or no folder → pick them: Cancel · Save & Send to Keep It
//   3. Send, reporting progress until it's in Keep It.
import { mountDetails } from './meeting-edit.js';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

async function api(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: opts.body ? { 'Content-Type': 'application/json' } : undefined, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!json.ok) throw new Error(json.error || 'Request failed');
  return json.data;
}

// A small modal. buttons: [{ label, value, kind: 'primary' | 'danger' | '' }]
// Resolves with the clicked value ('cancel' for Esc / backdrop).
function modal({ icon, title, body, buttons, onOpen, wide = false }) {
  const d = document.createElement('dialog');
  d.className = `kp-modal${wide ? ' wide' : ''}`;
  d.innerHTML = `
    <div class="kp-card">
      <div class="kp-head">${icon ? `<span class="kp-icon ${icon}">${ICONS[icon] || ''}</span>` : ''}<h3>${esc(title)}</h3></div>
      <div class="kp-body">${body}</div>
      <div class="kp-error"></div>
      <div class="kp-actions">${buttons.map((b) => `<button type="button" class="btn ${b.kind || ''}" data-v="${b.value}">${esc(b.label)}</button>`).join('')}</div>
    </div>`;
  document.body.append(d);
  d.showModal();
  return new Promise((resolve) => {
    const done = (v) => { d.close(); d.remove(); resolve(v); };
    // In the tag box, Esc means "keep what I typed" (dismiss suggestions), not "close".
    d.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && e.target.matches?.('.me-tag-input') && e.target.value.trim()) e.preventDefault();
    });
    d.addEventListener('cancel', (e) => { e.preventDefault(); done('cancel'); });
    d.addEventListener('click', (e) => { if (e.target === d) done('cancel'); });
    d.querySelectorAll('[data-v]').forEach((b) => b.addEventListener('click', async () => {
      if (b.dataset.v !== 'cancel' && onOpen?.guard) {
        b.disabled = true;
        const ok = await onOpen.guard(b.dataset.v, d).catch((err) => { d.querySelector('.kp-error').textContent = err.message; return false; });
        b.disabled = false;
        if (!ok) return;
      }
      done(b.dataset.v);
    }));
    onOpen?.(d);
    (d.querySelector('.btn.primary') || d.querySelector('[data-v]')).focus();
  });
}

// meeting: { id, name, plaudName, startAt, durationMs }
// hooks: onNameSpeakers(meeting) · onSaved(meta) · onStatus(status)
export async function sendToKeepIt(meeting, { onNameSpeakers, onSaved, onStatus, toast } = {}) {
  onStatus?.({ status: 'checking' });
  let check;
  try {
    check = await api(`/api/meetings/${encodeURIComponent(meeting.id)}/keepit/check`);
  } catch (err) {
    onStatus?.(null);
    return toast?.(`Couldn’t check the meeting: ${err.message}`);
  }
  onStatus?.(null);

  // 1) Unnamed speakers
  if (check.unnamed.length) {
    const list = check.unnamed.map((s) => `<li><b>${esc(s.name)}</b> <span>${s.lines} line${s.lines === 1 ? '' : 's'}</span></li>`).join('');
    const choice = await modal({
      icon: 'warn',
      title: `${check.unnamed.length === 1 ? 'A speaker isn’t' : `${check.unnamed.length} speakers aren’t`} named`,
      body: `<p>These still have Plaud’s generic labels, so the summary and transcript in Keep It will say “Speaker …”:</p>
             <ul class="kp-list">${list}</ul>`,
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Send to Keep It', value: 'send' },
        { label: 'Name Speakers', value: 'name', kind: 'primary' },
      ],
    });
    if (choice === 'cancel') return;
    if (choice === 'name') return onNameSpeakers?.(meeting);
  }

  // 2) Tags and folder
  if (!check.tags.length || !check.folderId) {
    let details;
    const missing = [!check.folderId && 'a folder', !check.tags.length && 'tags'].filter(Boolean).join(' and ');
    const choice = await modal({
      icon: 'folder',
      title: `Choose ${missing}`,
      wide: true,
      body: `<p>Keep It files this meeting under its folder, with its tags.</p><div class="kp-details"></div>`,
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Save & Send to Keep It', value: 'save', kind: 'primary' },
      ],
      onOpen: Object.assign((d) => {
        details = mountDetails(d.querySelector('.kp-details'), meeting, { showTitle: false });
      }, {
        guard: async () => {
          const v = details.values();
          if (!v.folderId) throw new Error('Pick a folder.');
          if (!v.tags) throw new Error('Add at least one tag.');
          const saved = await details.save();
          onSaved?.(saved);
          return true;
        },
      }),
    });
    if (choice !== 'save') return;
  }

  // Already complete: offer to rebuild (e.g. after Plaud regenerated a summary).
  let rebuild = false;
  if (check.keepIt?.sync === 'full' && check.keepIt.status !== 'running') {
    const choice = await modal({
      icon: 'check',
      title: 'Already in Keep It',
      body: `<p>Everything for this meeting is already in Keep It (${esc(check.keepIt.folderPath || '')}).</p>
             <p>Rebuild replaces its ${esc(check.keepIt.present.length)} items with fresh copies from Plaud, for example after Plaud regenerated a summary. The old copies go to Keep It’s Deleted Items; anything you added to them in Keep It stays with those copies.</p>`,
      buttons: [
        { label: 'Cancel', value: 'cancel' },
        { label: 'Rebuild in Keep It', value: 'rebuild', kind: 'primary' },
      ],
    });
    if (choice !== 'rebuild') return;
    rebuild = true;
  }

  // 3) Send and follow progress
  try {
    let status = await api(`/api/meetings/${encodeURIComponent(meeting.id)}/keepit`, { method: 'POST', body: rebuild ? { rebuild: true } : undefined });
    onStatus?.(status);
    while (status?.status === 'running') {
      await new Promise((r) => setTimeout(r, 1000));
      status = await api(`/api/meetings/${encodeURIComponent(meeting.id)}/keepit`);
      onStatus?.(status);
    }
    if (status?.status === 'done' && !status.sentKinds?.length) toast?.('Everything is already in Keep It — nothing to send');
    else if (status?.status === 'done') toast?.(`Sent ${status.sentKinds.length} item${status.sentKinds.length === 1 ? '' : 's'} to Keep It (${status.folderPath})${status.sync === 'full' ? '' : ' — some are still missing'}`);
    else toast?.(`Keep It send failed: ${status?.error || 'unknown error'}`);
  } catch (err) {
    onStatus?.({ status: 'failed', error: err.message });
    toast?.(`Keep It send failed: ${err.message}`);
  }
}

const ICONS = {
  warn: '<svg viewBox="0 0 24 24"><path d="M12 3.5 2.5 20h19z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M12 10v4.5M12 17.2v.3" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>',
  check: '<svg viewBox="0 0 24 24"><path d="M6 3.5h9l3 3V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/><path d="m9 13 2.2 2.2L15.5 11" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
};
