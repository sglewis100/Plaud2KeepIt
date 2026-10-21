// The meeting dialog: edit title / tags / folder, play the meeting with a synced
// transcript, listen to samples of each Plaud speaker label, and save / merge /
// confirm names. The ✓ saves everything and sends the changes to Plaud.

import { attachAutocomplete } from './autocomplete.js';
import { mountDetails } from './meeting-edit.js';

const PALETTE = ['#6366f1', '#0ea5e9', '#f59e0b', '#10b981', '#ef4444', '#a855f7', '#14b8a6', '#f97316', '#64748b', '#ec4899'];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

function talkTime(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? `${Math.round(ms / 1000)}s` : m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: opts.body ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  if (!json.ok) {
    const err = new Error(json.error || 'Request failed');
    Object.assign(err, json);
    throw err;
  }
  return json.data;
}

// ---- Dialog shell ----

let dialog;

function ensureDialog() {
  if (dialog) return dialog;
  dialog = document.createElement('dialog');
  dialog.className = 'sp-dialog';
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    dialog.querySelector('audio')?.pause();
    dialog.replaceChildren();
  });
  dialog.addEventListener('click', (e) => { if (e.target === dialog) requestClose(); });
  // Handle Esc ourselves: browsers may ignore preventDefault on the dialog's own
  // cancel event, which would skip the "send to Plaud?" question.
  dialog.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    // In the tag box, Esc means "keep what I typed", never "close the dialog".
    if (e.target.matches?.('.me-tag-input') && e.target.value.trim()) return;
    if (dialog.querySelector('.sp-confirm')) dialog.querySelector('.sp-confirm').remove();
    else requestClose();
  });
  dialog.addEventListener('cancel', (e) => { e.preventDefault(); requestClose(); });
  return dialog;
}

// ---- What the ✓ does, and what closing asks about ----
// d.details: the title/tags/folder form · d.view: the speaker view (once loaded)

function pending(d) {
  const v = d.view;
  return {
    details: !!d.details?.isDirty(),
    unsaved: v ? v.unsaved() : [],
    queued: v ? v.queued() : [],
  };
}

function updateApply(d) {
  const btn = d.querySelector('.sp-apply');
  if (!btn) return;
  const count = btn.querySelector('.sp-apply-count');
  const syncing = !!d.view?.data.speakers.some((s) => s.assignment?.plaudSync === 'syncing');
  const p = pending(d);
  const n = (p.details ? 1 : 0) + p.unsaved.length + p.queued.length;
  btn.classList.toggle('busy', syncing || !!d.applying);
  btn.disabled = syncing || !!d.applying;
  count.hidden = !n || syncing;
  count.textContent = n;
  const parts = [p.details && 'meeting details', (p.unsaved.length + p.queued.length) && `${p.unsaved.length + p.queued.length} name${p.unsaved.length + p.queued.length === 1 ? '' : 's'}`].filter(Boolean);
  // Meetings already in Keep It get their items rebuilt with the new names.
  const keepIt = ['full', 'partial'].includes(d.meeting?.keepIt?.sync) && (p.unsaved.length + p.queued.length) > 0;
  btn.title = syncing ? 'Updating Plaud…' : n ? `Save ${parts.join(' and ')}, and update Plaud${keepIt ? ' and Keep It' : ''}` : 'Done';
  btn.classList.toggle('with-keepit', keepIt && !syncing);
  const note = d.querySelector('.sp-keepit-note');
  if (note) note.hidden = !keepIt;
}

// Save the details and every typed name, then push names to Plaud in one pass.
// Stops at anything that needs an answer (merge or new) or fails to save.
async function applyAll(d) {
  if (d.applying || d.view?.data.speakers.some((s) => s.assignment?.plaudSync === 'syncing')) return false;
  const p = pending(d);
  if (!p.details && !p.unsaved.length && !p.queued.length) { d.close(); return true; }
  d.applying = true;
  updateApply(d);
  try {
    if (p.details) {
      const saved = await d.details.save().catch(() => null);
      if (!saved) return false;
      d.onSaved?.(saved);
      d.querySelector('.sp-head h2').textContent = saved.title;
    }
    for (const s of p.unsaved) {
      if ((await d.view.save(s)) !== 'ok') return false;
    }
    // Plaud keeps updating in the background, so there's nothing to wait for here.
    if (d.view?.queued().length && !(await d.view.sendToPlaud())) return false;
    d.close();
    return true;
  } finally {
    d.applying = false;
    if (d.open) updateApply(d);
  }
}

// Closing with unsaved or unsent changes asks what to do first.
function requestClose() {
  const p = pending(dialog);
  const waiting = p.details || p.queued.length || p.unsaved.some((s) => s.touched);
  if (waiting && !dialog.querySelector('.sp-confirm')) askBeforeClose(dialog);
  else dialog.close();
}

function askBeforeClose(d) {
  const p = pending(d);
  const touched = p.unsaved.filter((s) => s.touched);
  const items = [
    ...(p.details ? ['title, tags or folder changes'] : []),
    ...p.queued.map((s) => esc(s.assignment.name)),
    ...touched.map((s) => esc(d.view.card(s.label).querySelector('.sp-input').value.trim())),
  ];
  const unsavedHere = p.details || touched.length;
  const box = document.createElement('div');
  box.className = 'sp-confirm';
  box.innerHTML = `
    <div class="sp-confirm-card" role="alertdialog" aria-labelledby="sp-close-title">
      <h3 id="sp-close-title">Save your changes?</h3>
      <p>${items.map((x) => `<b>${x}</b>`).join(', ')} ${unsavedHere ? 'aren’t saved yet' : 'aren’t in Plaud yet'}. Plaud keeps updating after this window closes.</p>
      <div class="sp-confirm-actions">
        <button type="button" class="btn" data-cancel>Keep editing</button>
        <button type="button" class="btn" data-later>${unsavedHere ? 'Close without saving' : 'Close, send later'}</button>
        <button type="button" class="btn primary" data-send>Save and close</button>
      </div>
    </div>`;
  d.querySelector('.sp-shell').append(box);
  box.querySelector('[data-cancel]').onclick = () => box.remove();
  box.querySelector('[data-later]').onclick = () => d.close();
  box.querySelector('[data-send]').onclick = async () => {
    box.remove();
    const ok = await applyAll(d);
    // Close unless something needs an answer (merge/new) or failed to save.
    if (ok && d.open && !d.querySelector('.sp-confirm')) d.close();
  };
  box.querySelector('[data-send]').focus();
}

const LOADING_STEPS = ['Loading transcript…', 'Fetching audio…', 'Building voice prints…', 'Matching known speakers…'];

// meeting: { id, name, plaudName?, startAt, durationMs } · onSaved(meta) after details are saved
export async function openSpeakerDialog(meeting, { onSaved } = {}) {
  const d = ensureDialog();
  d.innerHTML = `
    <div class="sp-shell">
      <header class="sp-head">
        <div class="sp-head-text">
          <span class="sp-eyebrow">Edit meeting <span class="sp-keepit-note badge ok" hidden title="This meeting is in Keep It: its summary, transcript, highlights and mind map will be rebuilt with the new names">✓ also updates Keep It</span></span>
          <h2 title="${esc(meeting?.name)}">${esc(meeting?.name || 'Meeting')}</h2>
        </div>
        <div class="sp-head-actions">
        <button class="sp-apply" type="button" aria-label="Save and update Plaud" title="Done">
          <svg viewBox="0 0 24 24" class="icon"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
          <span class="sp-apply-count" hidden></span>
        </button>
        <button class="sp-close" type="button" aria-label="Close">
          <svg viewBox="0 0 24 24" class="icon"><path d="M6 6l12 12M18 6 6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
        </button>
        </div>
      </header>
      <div class="sp-body">
        <section class="sp-details"></section>
        <div class="sp-main"><div class="sp-loading"><span class="spinner"></span><span class="sp-step">${LOADING_STEPS[0]}</span></div></div>
      </div>
    </div>`;
  d.view = null;
  d.meeting = meeting;
  d.applying = false;
  d.onSaved = onSaved;
  d.querySelector('.sp-close').onclick = requestClose;
  d.querySelector('.sp-apply').onclick = () => applyAll(d);
  d.showModal();
  d.details = mountDetails(d.querySelector('.sp-details'), meeting, { onChange: () => updateApply(d) });

  let step = 0;
  const ticker = setInterval(() => {
    step = Math.min(step + 1, LOADING_STEPS.length - 1);
    const el = d.querySelector('.sp-step');
    if (el) el.textContent = LOADING_STEPS[step];
  }, 2500);

  try {
    const data = await api(`/api/meetings/${encodeURIComponent(meeting.id)}/speakers`);
    clearInterval(ticker);
    if (d.open) new SpeakerView(d, data);
  } catch (err) {
    clearInterval(ticker);
    const main = d.querySelector('.sp-main');
    if (main) main.innerHTML = `<div class="notice error">Couldn’t load the speakers for this meeting: ${esc(err.message)}. You can still edit the title, tags and folder above.</div>`;
  }
}

// ---- Main view ----

class SpeakerView {
  constructor(root, data) {
    this.root = root;
    root.view = this;
    this.data = data;
    this.known = data.knownSpeakers;
    this.colors = new Map(data.speakers.map((s, i) => [s.label, PALETTE[i % PALETTE.length]]));
    this.clipEnd = null;
    this.activeLine = -1;
    this.userScrolledAt = 0;
    this.render();
  }

  nameFor(label) {
    const s = this.data.speakers.find((x) => x.label === label);
    return s?.assignment?.name || s?.displayName || label;
  }

  render() {
    const { meeting, transcript, speakers } = this.data;
    const when = meeting.startAt ? new Date(meeting.startAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
    this.root.querySelector('.sp-head h2').insertAdjacentHTML('afterend', `<span class="sp-sub">${esc(when)} · ${speakers.length} speakers</span>`);

    const body = this.root.querySelector('.sp-main');
    body.innerHTML = `
      <div class="sp-section-head">
        <span class="sp-section-title">Speaker Matching</span>
        <span class="sp-match-status"></span>
      </div>
      <!-- Player and transcript stay out of the Tab order: Tab goes tags → folder → speaker names. -->
      <section class="sp-player">
        <audio preload="auto" src="/api/meetings/${encodeURIComponent(meeting.id)}/audio"></audio>
        <div class="sp-controls">
          <button class="sp-play" type="button" aria-label="Play" tabindex="-1">${ICON_PLAY}</button>
          <span class="sp-clock"><span class="sp-now">0:00</span> / ${clock(meeting.durationMs)}</span>
          <div class="sp-seek">
            <div class="sp-seek-track">${this.speakerStripe()}</div>
            <input type="range" min="0" max="${meeting.durationMs}" value="0" step="100" aria-label="Seek" tabindex="-1">
          </div>
          <button class="sp-rate" type="button" title="Playback speed" tabindex="-1">1×</button>
        </div>
        <div class="sp-transcript" tabindex="-1">
          ${transcript.map((l, i) => `
            <div class="sp-line" data-i="${i}" data-start="${l.startMs}">
              <span class="sp-line-time">${clock(l.startMs)}</span>
              <span class="sp-chip" data-label="${esc(l.label)}" style="--c:${this.colors.get(l.label)}">${esc(this.nameFor(l.label))}</span>
              <span class="sp-line-text">${esc(l.text)}</span>
            </div>`).join('')}
        </div>
      </section>
      <datalist id="sp-known"></datalist>
      <section class="sp-speakers">${speakers.map((s) => this.cardHtml(s)).join('')}</section>`;

    this.audio = body.querySelector('audio');
    this.wirePlayer(body);
    this.refreshKnown();
    speakers.forEach((s) => this.wireCard(s));
    this.updateApply();
    if (speakers.some((s) => s.assignment?.plaudSync === 'syncing')) this.pollSync();
  }

  // Names saved here but not yet in Plaud (including failed attempts).
  queued() {
    return this.data.speakers.filter((s) => s.assignment && ['queued', 'pending', 'failed'].includes(s.assignment.plaudSync));
  }

  // Names typed into a box but not saved yet (their Save/Confirm button is showing).
  unsaved() {
    return this.data.speakers.filter((s) => {
      const btn = this.card(s.label).querySelector('.sp-save');
      if (btn.hidden || btn.disabled || btn.classList.contains('queued')) return false;
      // An untouched "possible" voice match needs its own Confirm click.
      return s.touched || s.suggestion?.confidence !== 'possible';
    });
  }

  updateApply() {
    updateApply(this.root);
  }

  async sendToPlaud() {
    if (!this.queued().length) return true;
    try {
      this.applySync(await api(`/api/meetings/${encodeURIComponent(this.data.meeting.id)}/plaud-sync`, { method: 'POST' }));
      this.pollSync();
      return true;
    } catch (err) {
      alert(`Couldn't send to Plaud: ${err.message}`);
      return false;
    }
  }

  // ---- Plaud website sync status ----

  pollSync() {
    clearTimeout(this.syncTimer);
    this.syncTimer = setTimeout(async () => {
      if (!this.root.open) return;
      try {
        const rows = await api(`/api/meetings/${encodeURIComponent(this.data.meeting.id)}/plaud-sync`);
        this.applySync(rows);
        if (rows.some((r) => r.plaudSync === 'syncing')) this.pollSync();
        else if (rows.length && rows.every((r) => r.plaudSync === 'done')) this.celebrate();
      } catch {
        this.pollSync();
      }
    }, 2000);
  }

  applySync(rows) {
    for (const r of rows) {
      const s = this.data.speakers.find((x) => x.label === r.label);
      if (!s?.assignment) continue;
      const changed = s.assignment.plaudSync !== r.plaudSync;
      Object.assign(s.assignment, { plaudSync: r.plaudSync, plaudSyncError: r.plaudSyncError });
      if (changed) this.updateCard(s);
    }
    this.updateApply();
  }

  celebrate() {
    const btn = this.root.querySelector('.sp-apply');
    btn.classList.remove('done');
    void btn.offsetWidth;
    btn.classList.add('done');
    btn.title = 'Plaud is up to date';
  }



  // Colored bar under the seek slider showing who talks when.
  speakerStripe() {
    const total = this.data.meeting.durationMs || 1;
    return this.data.transcript.map((l) =>
      `<i style="left:${(l.startMs / total) * 100}%;width:${Math.max(0.15, ((l.endMs - l.startMs) / total) * 100)}%;background:${this.colors.get(l.label)}"></i>`).join('');
  }

  refreshKnown() {
    const names = [...new Set(this.known.map((k) => k.name))];
    this.root.querySelector('#sp-known').innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join('');
  }

  // ---- Player ----

  wirePlayer(body) {
    const a = this.audio;
    const playBtn = body.querySelector('.sp-play');
    const seek = body.querySelector('.sp-seek input');
    const now = body.querySelector('.sp-now');
    const rateBtn = body.querySelector('.sp-rate');
    const box = body.querySelector('.sp-transcript');
    this.lines = [...box.querySelectorAll('.sp-line')];
    let seeking = false;

    playBtn.onclick = () => {
      this.clipEnd = null;
      a.paused ? a.play() : a.pause();
    };
    a.addEventListener('play', () => { playBtn.innerHTML = ICON_PAUSE; this.syncClipButtons(); });
    a.addEventListener('pause', () => { playBtn.innerHTML = ICON_PLAY; this.syncClipButtons(); });
    a.addEventListener('ended', () => { this.clipEnd = null; this.syncClipButtons(); });

    const tick = () => {
      const ms = a.currentTime * 1000;
      if (this.clipEnd != null && ms >= this.clipEnd) {
        a.pause();
        this.clipEnd = null;
        this.clip = null;
        this.syncClipButtons();
      }
      if (!seeking) seek.value = ms;
      now.textContent = clock(ms);
      this.highlightLine(ms, box);
      this.updateClipProgress(ms);
      if (!a.paused) requestAnimationFrame(tick);
    };
    a.addEventListener('play', () => requestAnimationFrame(tick));
    a.addEventListener('seeked', tick);

    seek.addEventListener('input', () => { seeking = true; now.textContent = clock(Number(seek.value)); });
    seek.addEventListener('change', () => {
      seeking = false;
      this.clipEnd = null;
      a.currentTime = Number(seek.value) / 1000;
    });

    const rates = [1, 1.25, 1.5, 2];
    rateBtn.onclick = () => {
      const next = rates[(rates.indexOf(a.playbackRate) + 1) % rates.length];
      a.playbackRate = next;
      rateBtn.textContent = `${next}×`;
    };

    box.addEventListener('click', (e) => {
      const line = e.target.closest('.sp-line');
      if (!line) return;
      this.playFrom(Number(line.dataset.start));
    });
    box.addEventListener('wheel', () => { this.userScrolledAt = Date.now(); }, { passive: true });
    box.addEventListener('touchmove', () => { this.userScrolledAt = Date.now(); }, { passive: true });
  }

  highlightLine(ms, box) {
    const t = this.data.transcript;
    let i = this.activeLine;
    if (i < 0 || ms < t[i].startMs || (t[i + 1] && ms >= t[i + 1].startMs)) {
      // Binary search for the last line starting at or before ms.
      let lo = 0, hi = t.length - 1;
      i = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (t[mid].startMs <= ms) { i = mid; lo = mid + 1; } else hi = mid - 1;
      }
    }
    if (i === this.activeLine) return;
    this.lines[this.activeLine]?.classList.remove('active');
    this.activeLine = i;
    const el = this.lines[i];
    if (!el) return;
    el.classList.add('active');
    // Follow along unless the user has been scrolling the transcript themselves.
    if (Date.now() - this.userScrolledAt > 4000) {
      box.scrollTo({ top: el.offsetTop - box.clientHeight / 3, behavior: 'smooth' });
    }
  }

  playFrom(ms, endMs = null) {
    this.clipEnd = endMs;
    this.userScrolledAt = 0;
    this.audio.currentTime = ms / 1000;
    this.audio.play();
  }

  // ---- Clips (the 8 listening samples) ----

  toggleClip(btn) {
    const start = Number(btn.dataset.start), end = Number(btn.dataset.end);
    if (this.clip === btn && !this.audio.paused) {
      this.audio.pause();
      return;
    }
    this.clip = btn;
    this.playFrom(start, end);
  }

  syncClipButtons() {
    this.root.querySelectorAll('.sp-clip-play').forEach((b) => {
      const playing = b === this.clip && !this.audio.paused && this.clipEnd != null;
      b.innerHTML = playing ? ICON_PAUSE_SM : ICON_PLAY_SM;
      b.closest('.sp-sample').classList.toggle('playing', playing);
      if (!playing) b.closest('.sp-sample').style.removeProperty('--p');
    });
  }

  updateClipProgress(ms) {
    if (!this.clip || this.clipEnd == null) return;
    const start = Number(this.clip.dataset.start), end = Number(this.clip.dataset.end);
    this.clip.closest('.sp-sample').style.setProperty('--p', `${Math.min(100, ((ms - start) / (end - start)) * 100)}%`);
  }

  // ---- Speaker cards ----

  cardHtml(s) {
    const color = this.colors.get(s.label);
    const share = Math.round((s.talkMs / this.data.meeting.durationMs) * 100);
    return `
      <article class="sp-card" data-label="${esc(s.label)}" style="--c:${color}">
        <div class="sp-card-head">
          <span class="sp-swatch"></span>
          <div class="sp-card-title">
            <strong class="sp-card-name"></strong>
            <span class="sp-card-meta"><span class="sp-card-origin"></span>talks ${talkTime(s.talkMs)} (${share}%) · ${s.lines} lines</span>
          </div>
          <div class="sp-badges"></div>
        </div>
        <form class="sp-name-row" autocomplete="off">
          <label class="sp-name-label" for="sp-in-${esc(s.label)}"></label>
          <input id="sp-in-${esc(s.label)}" class="sp-input" maxlength="32" placeholder="Who is this?" spellcheck="false">
          <button class="btn primary sp-save" type="submit" hidden>Save</button>
        </form>
        <div class="sp-status" aria-live="polite"></div>
        <ol class="sp-samples">
          ${s.samples.map((p) => `
            <li class="sp-sample">
              <button type="button" class="sp-clip-play" data-start="${p.startMs}" data-end="${p.endMs}" aria-label="Play sample at ${clock(p.startMs)}">${ICON_PLAY_SM}</button>
              <span class="sp-sample-time">${clock(p.startMs)}</span>
              <span class="sp-sample-text">${esc(p.text)}</span>
            </li>`).join('') || '<li class="sp-sample empty">No clear samples for this speaker.</li>'}
        </ol>
      </article>`;
  }

  card(label) {
    return this.root.querySelector(`.sp-card[data-label="${CSS.escape(label)}"]`);
  }

  wireCard(s) {
    const card = this.card(s.label);
    const input = card.querySelector('.sp-input');
    const btn = card.querySelector('.sp-save');

    // Prefill from a saved name, then a voice match, then Plaud's own name.
    input.value = s.assignment?.name || s.suggestion?.name || '';
    this.updateCard(s);

    attachAutocomplete(input, { items: () => [...new Set(this.known.map((k) => k.name))] });
    input.addEventListener('input', () => {
      s.touched = true;
      this.updateButton(s);
      this.updateApply();
    });
    card.querySelector('.sp-name-row').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!btn.hidden && !btn.disabled) this.save(s);
    });
    card.querySelectorAll('.sp-clip-play').forEach((b) => b.addEventListener('click', () => this.toggleClip(b)));
  }

  // A speaker is matched once it has a real name: saved/confirmed here, or
  // already named in Plaud. Generic labels ("Speaker 2") still need matching.
  updateMatchStatus() {
    const el = this.root.querySelector('.sp-match-status');
    if (!el) return;
    const generic = (n) => /^speaker\s*\d+$/i.test(n || '');
    const pending = this.data.speakers.filter((x) => !x.assignment && generic(x.displayName));
    el.className = `sp-match-status ${pending.length ? 'pending' : 'done'}`;
    el.textContent = pending.length
      ? `Some Speakers Require Matching (${pending.length} of ${this.data.speakers.length})`
      : 'All Speakers Matched';
    el.title = pending.length ? `Still unnamed: ${pending.map((x) => x.label).join(', ')}` : '';
  }

  updateCard(s) {
    this.updateMatchStatus();
    const card = this.card(s.label);
    // Once identified, show the person's name; keep Plaud's label as a note.
    const title = this.nameFor(s.label);
    card.querySelector('.sp-card-name').textContent = title;
    card.querySelector('.sp-name-label').textContent = title;
    card.querySelector('.sp-card-origin').textContent = title !== s.label ? `Plaud label: ${s.label} · ` : '';
    const badges = [];
    if (s.assignment) {
      badges.push(`<span class="badge ok" title="${esc(s.assignment.method === 'confirmed' ? 'Confirmed voice match' : s.assignment.method === 'merged' ? 'Merged with an existing person' : 'Saved as a new person')}">${ICON_CHECK} Identified</span>`);
      const st = s.assignment.plaudSync;
      if (st === 'done') badges.push('<span class="badge">Updated in Plaud</span>');
      else if (st === 'syncing') badges.push('<span class="badge accent"><span class="spinner tiny"></span> Updating Plaud…</span>');
      else if (st === 'failed') badges.push(`<span class="badge warn" title="${esc(s.assignment.plaudSyncError || '')} — use ✓ to try again">Plaud update failed</span>`);
      else badges.push('<span class="badge accent" title="Use ✓ at the top to send to Plaud">Queued for Plaud</span>');
    } else if (s.suggestion?.source === 'voice') {
      const pct = Math.round(s.suggestion.score * 100);
      badges.push(s.suggestion.confidence === 'high'
        ? `<span class="badge accent">Voice match · ${pct}%</span>`
        : `<span class="badge warn">Possible match · ${pct}%</span>`);
    } else if (s.suggestion?.source === 'plaud') {
      badges.push('<span class="badge">Name from Plaud</span>');
    }
    if (!s.voicePrint) badges.push('<span class="badge warn" title="Not enough clear speech to build a voice print">No voice print</span>');
    card.querySelector('.sp-badges').innerHTML = badges.join('');
    if (s.assignment?.plaudSync === 'failed' && s.assignment.plaudSyncError) {
      card.querySelector('.sp-status').innerHTML = `<span class="sp-error">Plaud: ${esc(s.assignment.plaudSyncError)}</span>`;
      this.updateButton(s);
      return;
    }

    const alike = s.assignment ? [] : s.alike;
    card.querySelector('.sp-status').innerHTML = alike.length
      ? `<span class="sp-hint">${ICON_INFO} Sounds similar to ${alike.map((l) => `<b>${esc(this.nameFor(l))}</b>`).join(' and ')}. Plaud may have split one person into two labels.</span>`
      : '';
    this.updateButton(s);
  }

  // Save vs Confirm vs nothing to do.
  updateButton(s) {
    const card = this.card(s.label);
    const name = card.querySelector('.sp-input').value.trim();
    const btn = card.querySelector('.sp-save');
    const same = (a, b) => a && b && a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0;

    if (s.assignment && same(name, s.assignment.name)) {
      const waiting = ['queued', 'pending'].includes(s.assignment.plaudSync);
      btn.hidden = !waiting;
      btn.disabled = true;
      btn.classList.add('queued');
      btn.textContent = 'Queued';
      return;
    }
    if (!name) {
      btn.hidden = true;
      return;
    }
    btn.hidden = false;
    btn.disabled = false;
    btn.classList.remove('queued');
    btn.textContent = s.suggestion && same(name, s.suggestion.name) ? 'Confirm' : 'Save';
  }

  async save(s, extra = {}) {
    const card = this.card(s.label);
    const input = card.querySelector('.sp-input');
    const btn = card.querySelector('.sp-save');
    const name = input.value.trim();
    const confirming = btn.textContent === 'Confirm';
    const body = { name, ...extra };
    if (confirming && s.suggestion?.speakerId && !extra.mode) Object.assign(body, { mode: 'confirm', speakerId: s.suggestion.speakerId });

    btn.disabled = true;
    const label = btn.textContent;
    btn.innerHTML = '<span class="spinner small"></span>';
    try {
      const r = await api(`/api/meetings/${encodeURIComponent(this.data.meeting.id)}/speakers/${encodeURIComponent(s.label)}`, { method: 'POST', body });
      s.assignment = { speakerId: r.speakerId, name: r.name, method: r.method, plaudSync: r.plaudSync, plaudSyncError: r.plaudSyncError };
      s.suggestion = null;
      input.value = r.name;
      this.known = await api('/api/speakers');
      this.refreshKnown();
      this.relabelChips(s.label);
      this.data.speakers.forEach((x) => this.updateCard(x));
      flash(card);
      this.updateApply();
      return 'ok';
    } catch (err) {
      btn.textContent = label;
      btn.disabled = false;
      if (err.conflict) {
        this.askMergeOrNew(s, name, err.matches);
        return 'conflict';
      }
      card.querySelector('.sp-status').innerHTML = `<span class="sp-error">${esc(err.message)}</span>`;
      card.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return 'error';
    }
  }

  relabelChips(label) {
    const name = this.nameFor(label);
    this.root.querySelectorAll(`.sp-chip[data-label="${CSS.escape(label)}"]`).forEach((c) => { c.textContent = name; });
  }

  // Same name already in the database: merge into one of them, or create a new person.
  askMergeOrNew(s, name, matches) {
    const box = document.createElement('div');
    box.className = 'sp-confirm';
    const th = this.data.thresholds;
    const fmt = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—');
    box.innerHTML = `
      <div class="sp-confirm-card" role="alertdialog" aria-labelledby="sp-confirm-title">
        <h3 id="sp-confirm-title">“${esc(name)}” already exists</h3>
        <p>Is ${esc(s.label)} the same person, or someone else with the same name? Different people keep separate voice prints.</p>
        <div class="sp-matches">
          ${matches.map((m) => `
            <div class="sp-match">
              <div>
                <strong>${esc(m.name)}</strong>
                <span>${m.prints} voice print${m.prints === 1 ? '' : 's'} · ${m.meetings} meeting${m.meetings === 1 ? '' : 's'} · last heard ${fmt(m.lastSeen)}</span>
                ${m.voiceScore != null ? `<span class="${m.voiceScore >= th.possible ? 'good' : 'low'}">Voice similarity ${Math.round(m.voiceScore * 100)}%${m.voiceScore >= th.strong ? ' — very likely the same person' : m.voiceScore < th.possible ? ' — sounds like a different person' : ' — possibly the same person; listen to be sure'}</span>` : ''}
              </div>
              <button type="button" class="btn primary" data-merge="${m.id}">Merge</button>
            </div>`).join('')}
        </div>
        <div class="sp-confirm-actions">
          <button type="button" class="btn" data-cancel>Cancel</button>
          <button type="button" class="btn" data-new>Save as a new ${esc(name)}</button>
        </div>
      </div>`;
    this.root.querySelector('.sp-shell').append(box);
    const close = () => box.remove();
    box.querySelector('[data-cancel]').onclick = close;
    box.querySelector('[data-new]').onclick = () => { close(); this.save(s, { mode: 'new' }); };
    box.querySelectorAll('[data-merge]').forEach((b) => {
      b.onclick = () => { close(); this.save(s, { mode: 'merge', speakerId: Number(b.dataset.merge) }); };
    });
    box.querySelector('[data-merge], [data-new]').focus();
  }
}

function flash(el) {
  el.classList.remove('flash');
  void el.offsetWidth;
  el.classList.add('flash');
}

const ICON_PLAY = '<svg viewBox="0 0 24 24" class="icon"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" class="icon"><rect x="6.5" y="5" width="4" height="14" rx="1" fill="currentColor"/><rect x="13.5" y="5" width="4" height="14" rx="1" fill="currentColor"/></svg>';
const ICON_PLAY_SM = '<svg viewBox="0 0 24 24"><path d="M8.5 6v12l9.5-6z" fill="currentColor"/></svg>';
const ICON_PAUSE_SM = '<svg viewBox="0 0 24 24"><rect x="7" y="6" width="3.6" height="12" rx="1" fill="currentColor"/><rect x="13.4" y="6" width="3.6" height="12" rx="1" fill="currentColor"/></svg>';
const ICON_CHECK = '<svg viewBox="0 0 24 24" class="icon xs"><path d="m5 12.5 4.5 4.5L19 7.5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const ICON_INFO = '<svg viewBox="0 0 24 24" class="icon xs"><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" stroke-width="2"/><path d="M12 11v5M12 7.5v.5" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>';
