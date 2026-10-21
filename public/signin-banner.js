// Sign-in banner: if the Plaud website or Plaud MCP isn't signed in, says so at
// the top of the page with a Sign in button, instead of leaving you to find
// it in Settings. Checks on load and when you come back to the tab (reusing a
// recent result, so it doesn't load Plaud every time).

const RECHECK_MS = 5 * 60 * 1000;
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SERVICES = {
  web: {
    what: 'the Plaud website',
    why: 'Renaming in Plaud and sending summary images to Keep It need it.',
    waiting: 'Sign in in the Chrome window that opened. This updates when you’re done.',
    async status(fresh) {
      const r = await getJson(`/api/plaud/status${fresh ? '' : `?maxAge=${RECHECK_MS}`}`);
      return { signedIn: r.loggedIn, inProgress: r.loginInProgress, error: r.loginError };
    },
    start: () => getJson('/api/plaud/login', { method: 'POST' }),
    cancel: () => getJson('/api/plaud/login/cancel', { method: 'POST' }),
  },
  mcp: {
    what: 'Plaud MCP',
    why: 'Meetings can’t be listed or read without it.',
    waiting: 'Finish in your web browser (click Authorize). This updates when you’re done.',
    async status() {
      const r = (await getJson('/api/mcp/status')).data;
      return { signedIn: r.signedIn, inProgress: r.loginInProgress, error: r.loginError };
    },
    start: () => getJson('/api/mcp/login', { method: 'POST' }),
  },
};

async function getJson(url, opts) {
  const r = await fetch(url, opts).then((res) => res.json());
  if (r.ok === false) throw new Error(r.error);
  return r;
}

const banner = document.createElement('div');
banner.className = 'signin-banner';
banner.hidden = true;
document.querySelector('main')?.prepend(banner);

const state = { web: null, mcp: null }; // per service: { signedIn, inProgress, error }
let lastCheck = 0;
let pollTimer = null;

function render() {
  const rows = Object.entries(SERVICES).filter(([k]) => state[k] && (state[k].signedIn === false || state[k].inProgress));
  banner.hidden = !rows.length;
  banner.innerHTML = rows.map(([k, svc]) => {
    const s = state[k];
    return s.inProgress
      ? `<div class="signin-row">
           <span class="spinner tiny"></span>
           <div class="signin-text"><b>Signing in to ${svc.what}…</b> ${svc.waiting}</div>
           ${svc.cancel ? `<button type="button" class="btn small" data-cancel="${k}">Cancel</button>` : ''}
         </div>`
      : `<div class="signin-row">
           <svg viewBox="0 0 24 24" class="icon"><path d="M12 8v5m0 3.5v.01M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
           <div class="signin-text"><b>You’re signed out of ${svc.what}.</b> ${svc.why}${s.error ? ` <span class="signin-err">Last attempt: ${esc(s.error)}</span>` : ''}</div>
           <button type="button" class="btn primary small" data-signin="${k}">Sign in</button>
         </div>`;
  }).join('');
}

async function check(keys = Object.keys(SERVICES), { fresh = false } = {}) {
  lastCheck = Date.now();
  await Promise.all(keys.map(async (k) => {
    try { state[k] = await SERVICES[k].status(fresh); } catch { /* leave as is; the page shows its own errors */ }
  }));
  render();
  const waiting = Object.keys(state).filter((k) => state[k]?.inProgress);
  clearTimeout(pollTimer);
  if (waiting.length) pollTimer = setTimeout(() => poll(waiting), 2000);
}

// While a sign-in is open, keep asking; once it closes, check for real.
async function poll(keys) {
  const was = keys.filter((k) => state[k]?.inProgress);
  await check(keys, { fresh: false });
  const finished = was.filter((k) => !state[k]?.inProgress);
  if (finished.length) {
    await check(finished, { fresh: true });
    if (finished.every((k) => state[k]?.signedIn)) window.dispatchEvent(new CustomEvent('plaud-signed-in', { detail: finished }));
  }
}

banner.addEventListener('click', async (e) => {
  const signin = e.target.closest('[data-signin]');
  const cancel = e.target.closest('[data-cancel]');
  const k = signin?.dataset.signin || cancel?.dataset.cancel;
  if (!k) return;
  e.target.closest('button').disabled = true;
  try {
    if (signin) {
      await SERVICES[k].start();
      state[k] = { ...state[k], inProgress: true, error: null };
      render();
      clearTimeout(pollTimer);
      pollTimer = setTimeout(() => poll([k]), 2000);
    } else {
      await SERVICES[k].cancel();
    }
  } catch (err) {
    state[k] = { ...state[k], inProgress: false, error: err.message };
    render();
  }
});

// Something on the page failed in a way that suggests signing in again.
export function recheckSignIn() {
  return check(['web'], { fresh: false });
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && Date.now() - lastCheck > RECHECK_MS) check();
});

check();
