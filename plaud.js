import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  withPage,
  isInteractiveSessionOpen,
  openInteractiveWindow,
  closeInteractiveWindow,
} from './browser.js';
import { renameMeetingApi, renameSpeakersApi } from './plaud-api.js';
import { bus } from './events.js';

const PLAUD_ORIGIN = 'https://web.plaud.ai';
const LOGIN_URL = `${PLAUD_ORIGIN}/login`;
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;

let lastStatus = { loggedIn: null, checkedAt: null };

// Other work (e.g. the API session capture) finds out about sign-in as it goes.
bus.on('plaud-session', (loggedIn) => {
  lastStatus = { loggedIn, checkedAt: new Date().toISOString() };
});
let loginState = { inProgress: false, error: null };

const isLoginPath = (url) => {
  try {
    const u = new URL(url);
    return u.origin === PLAUD_ORIGIN && u.pathname.startsWith('/login');
  } catch {
    return false;
  }
};

const isLoggedInUrl = (url) => {
  try {
    return new URL(url).origin === PLAUD_ORIGIN && !isLoginPath(url);
  } catch {
    return false;
  }
};

// Opens Plaud's login page headlessly. A signed-in session gets redirected to
// the app; a signed-out one stays on /login.
// maxAgeMs: reuse a status at most this old instead of loading Plaud again.
export async function checkLoginStatus({ maxAgeMs = 0 } = {}) {
  if (isInteractiveSessionOpen()) {
    return { ...lastStatus, loginInProgress: true, loginError: loginState.error };
  }
  if (maxAgeMs && lastStatus.checkedAt && Date.now() - Date.parse(lastStatus.checkedAt) < maxAgeMs) {
    return { ...lastStatus, loginInProgress: false, loginError: loginState.error };
  }
  const url = await withPage(async (page) => {
    await page.goto(LOGIN_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    // The redirect is client-side; give the app a moment to run it.
    await page
      .waitForFunction(() => !location.pathname.startsWith('/login'), { timeout: 4000 })
      .catch(() => {});
    return page.url();
  });
  lastStatus = { loggedIn: isLoggedInUrl(url), checkedAt: new Date().toISOString() };
  return { ...lastStatus, loginInProgress: false, loginError: loginState.error };
}

// Opens a visible Chrome window on Plaud's login page and watches it in the
// background. The window closes itself once the user lands in the app.
export async function startLogin() {
  if (loginState.inProgress) return;
  const browser = await openInteractiveWindow(LOGIN_URL);
  loginState = { inProgress: true, error: null };
  watchLogin(browser).catch((err) => {
    loginState.error = err.message;
  });
}

export async function cancelLogin() {
  await closeInteractiveWindow();
}

async function watchLogin(browser) {
  const deadline = Date.now() + LOGIN_TIMEOUT_MS;
  try {
    while (browser.connected) {
      const pages = await browser.pages().catch(() => []);
      // On macOS, closing the last window leaves Chrome running; treat that as a cancel.
      if (pages.length === 0) break;
      if (pages.some((p) => isLoggedInUrl(p.url()))) {
        // Let the app finish writing its auth tokens before closing.
        await new Promise((r) => setTimeout(r, 2000));
        lastStatus = { loggedIn: true, checkedAt: new Date().toISOString() };
        break;
      }
      if (Date.now() > deadline) {
        loginState.error = 'Login timed out';
        break;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  } finally {
    await closeInteractiveWindow();
    loginState.inProgress = false;
  }
}

// Signs out through Plaud's own UI: "Personal workspace" menu → "Sign out".
// On failure, saves a screenshot to .debug/ so the selectors can be fixed.
export async function logout() {
  if (isInteractiveSessionOpen()) throw new Error('Finish or cancel the login first');
  const url = await withPage(async (page) => {
    await page.goto(`${PLAUD_ORIGIN}/`, { waitUntil: 'networkidle2', timeout: 30000 });
    if (isLoginPath(page.url())) return page.url(); // already signed out
    try {
      await page.locator('::-p-text(Personal workspace)').setTimeout(15000).click();
      await page.locator('::-p-text(Sign out)').setTimeout(5000).click();
      // Plaud then asks for confirmation in a dialog with its own "Sign out" button.
      await page.locator('.cfmWin .ok-btn::-p-text(Sign out)').setTimeout(5000).click();
      await page.waitForFunction(() => location.pathname.startsWith('/login'), { timeout: 15000 });
    } catch (err) {
      await saveDebugScreenshot(page, 'logout-failure');
      throw new Error(`Couldn't sign out through Plaud's menu (${err.message}). Screenshot saved in .debug/`);
    }
    return page.url();
  });
  lastStatus = { loggedIn: isLoggedInUrl(url), checkedAt: new Date().toISOString() };
  return lastStatus;
}

async function saveDebugScreenshot(page, name) {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '.debug');
  await mkdir(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, `${name}.png`), fullPage: true }).catch(() => {});
}

// ---- Edits on the Plaud website ----

// One edit at a time: they share one browser profile, and two edits to the
// same recording at once could overwrite each other.
let editChain = Promise.resolve();
function serial(fn) {
  const run = editChain.then(fn);
  editChain = run.catch(() => {});
  return run;
}

export const MAX_TITLE = 255; // Plaud's title limit

// ---- Preferred entry points: Plaud's web API first, the website as fallback ----
// The API makes the same requests the web app sends (seconds instead of a full
// page session). If it fails (expired session, Cloudflare, an API change), the
// change is made by driving the website instead.

export function updateTitle(fileId, title) {
  title = title.trim().slice(0, MAX_TITLE);
  return serial(async () => {
    try {
      await renameMeetingApi(fileId, title);
      return { via: 'api' };
    } catch (err) {
      console.warn(`Plaud API title rename failed (${err.message}); using the website instead`);
      return { via: 'website', ...(await renameMeetingNow(fileId, title)) };
    }
  });
}

// renames: [{ from: 'Speaker 2', to: 'Pat Smith' }] — from is the name Plaud shows now.
export function updateSpeakerNames(fileId, renames) {
  const todo = renames.filter((r) => r.from && r.to && r.from !== r.to);
  if (!todo.length) return Promise.resolve({ via: 'none', changed: 0 });
  return serial(async () => {
    try {
      const r = await renameSpeakersApi(fileId, Object.fromEntries(todo.map((x) => [x.from, x.to.slice(0, MAX_SPEAKER_NAME)])));
      return { via: 'api', ...r };
    } catch (err) {
      console.warn(`Plaud API speaker rename failed (${err.message}); using the website instead`);
      return { via: 'website', ...(await renameSpeakersNow(fileId, todo)) };
    }
  });
}

// Sets a recording's title through the editable title on its page (Plaud saves
// on Enter). Success is confirmed from Plaud's own save request (the one that
// carries the new title); if that isn't seen, the page is reloaded to check.
export function renameMeeting(fileId, title) {
  return serial(() => renameMeetingNow(fileId, title));
}

async function renameMeetingNow(fileId, title) {
  if (isInteractiveSessionOpen()) throw new Error('Finish or cancel the Plaud login first');
  title = title.trim().slice(0, MAX_TITLE);
  const url = `${PLAUD_ORIGIN}/file/${fileId.replace(/^of_/, '')}`;
  const titleBox = 'textarea[data-testid="file-name-editor"]';
  return withPage(async (page) => {
    try {
      // The title box appears as soon as the app has the file; no need to
      // wait for every background request (saves ~2s).
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const box = await page.locator(titleBox).setTimeout(20000).waitHandle().catch(async (err) => {
        if (isLoginPath(page.url())) throw new Error('Plaud website is not logged in');
        throw err;
      });
      if ((await box.evaluate((e) => e.value.trim())) === title) return { changed: false };

      // Replace the text in one step and let the app (Vue) see it as typing.
      await box.click();
      await box.evaluate((e, t) => {
        e.focus();
        Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(e, t);
        e.dispatchEvent(new Event('input', { bubbles: true }));
      }, title);
      if ((await box.evaluate((e) => e.value.trim())) !== title) throw new Error('The title didn’t go in correctly');

      const needle = JSON.stringify(title).slice(1, -1);
      const saved = page.waitForResponse(
        (r) => r.request().method() !== 'GET' && r.url().startsWith('https://api.plaud.ai/') && (r.request().postData() || '').includes(needle),
        { timeout: 10000 },
      ).catch(() => null);
      await page.keyboard.press('Enter');
      const res = await saved;
      if (res) {
        const body = await res.json().catch(() => ({}));
        if (!res.ok() || (body.status !== undefined && body.status !== 0)) {
          throw new Error(`Plaud refused the title (${res.status()}${body.msg ? `: ${body.msg}` : ''})`);
        }
        return { changed: true, confirmedBy: 'save request' };
      }

      // Didn't see the save request: check the hard way.
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(() => {});
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      const now = await (await page.locator(titleBox).setTimeout(20000).waitHandle()).evaluate((e) => e.value.trim());
      if (now !== title) throw new Error(`Plaud still shows "${now}" after saving`);
      return { changed: true, confirmedBy: 'reload' };
    } catch (err) {
      await saveDebugScreenshot(page, 'title-failure');
      throw new Error(`${err.message} (screenshot in .debug/title-failure.png)`);
    }
  });
}

// ---- Speaker names ----

export const MAX_SPEAKER_NAME = 32; // Plaud's input limit

// Renames speakers in one Plaud recording through the web UI:
//   ⋯ (More actions) → Name speakers → click a name → type → Enter → … → Save
// Rows are matched by the name Plaud currently shows for them ("Speaker 1",
// "Scott Lewis", …).
//
// Plaud's Save only writes the transcript. The page then rewrites the names in
// the summary/notes it has loaded and saves those separately, so we wait for
// the summary to load before opening the dialog, and for those follow-up saves
// to finish before reloading to verify the transcript and summary.
// renames: [{ from: 'Speaker 1', to: 'Jamie Rivera' }]
export function renameSpeakers(fileId, renames, opts) {
  return serial(() => renameSpeakersNow(fileId, renames, opts));
}

async function renameSpeakersNow(fileId, renames, { dryRun = false } = {}) {
  if (isInteractiveSessionOpen()) throw new Error('Finish or cancel the Plaud login first');
  const id = fileId.replace(/^of_/, '');
  const url = `${PLAUD_ORIGIN}/file/${id}`;

  return withPage(async (page) => {
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.locator('.more-menu, textarea[data-testid="file-name-editor"]').setTimeout(20000).wait().catch(() => {});
      if (isLoginPath(page.url())) throw new Error('Plaud website is not logged in');
      const summaryBefore = await summaryText(page);

      const names = await openNameSpeakers(page);
      const missing = renames.filter((r) => !names.includes(r.from) && !names.includes(r.to));
      if (missing.length) throw new Error(`Plaud doesn't show ${missing.map((r) => `"${r.from}"`).join(', ')} (it shows ${names.join(', ')})`);

      let changed = 0;
      for (const { from, to } of renames) {
        if (from === to || (!names.includes(from) && names.includes(to))) continue; // already named
        const name = to.slice(0, MAX_SPEAKER_NAME);
        await clickSpeaker(page, from);
        const input = await page.locator('[data-testid="speaker-name-popover"] input.speaker-input').setTimeout(5000).waitHandle();
        await input.evaluate((e) => { e.focus(); e.select(); });
        await page.keyboard.press('Backspace');
        if ((await input.evaluate((e) => e.value)) !== '') throw new Error('Couldn’t clear the speaker name box');
        await input.type(name, { delay: 15 });
        await page.keyboard.press('Enter');
        await page.waitForFunction(
          (n) => [...document.querySelectorAll('[role="dialog"] .speaker-display .speaker-name')].some((e) => e.textContent.trim() === n),
          { timeout: 5000 }, name,
        );
        changed++;
      }

      if (!changed || dryRun) {
        const shown = await page.$$eval('[role="dialog"] .speaker-display .speaker-name', (els) => els.map((e) => e.textContent.trim()));
        await page.click('[role="dialog"] button.cancel-btn').catch(() => {});
        return { changed: dryRun ? 0 : changed, names, ...(dryRun && { wouldSave: shown }) };
      }

      await page.click('[role="dialog"] button.save-btn');
      await page.waitForFunction(() => !document.querySelector('[role="dialog"][data-state="open"] .speaker-display'), { timeout: 15000 });
      // Plaud shows a success toast once the transcript is saved, then updates
      // the summary/notes in the background. Let those requests finish.
      await page.locator('.el-message--success').setTimeout(15000).wait().catch(() => {});
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 30000 }).catch(() => {});

      // Reload so Plaud refreshes, then check the saved names.
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 45000 });
      const summaryAfter = await summaryText(page);
      const after = await openNameSpeakers(page);
      await page.click('[role="dialog"] button.cancel-btn').catch(() => {});
      const notApplied = renames.filter((r) => !after.includes(r.to.slice(0, MAX_SPEAKER_NAME)));
      if (notApplied.length) throw new Error(`Saved, but Plaud still doesn't show ${notApplied.map((r) => `"${r.to}"`).join(', ')} after reload`);
      // Old labels that were in the summary before should be gone now.
      // (Ignore the old name where it's part of the new one: "Pat" → "Pat Smith".)
      const stale = renames.filter((r) => mentions(summaryBefore, r.from) && mentions(summaryAfter.split(r.to).join(''), r.from));
      if (stale.length) throw new Error(`Transcript renamed, but the summary still says ${stale.map((r) => `"${r.from}"`).join(', ')}`);
      return { changed, names: after };
    } catch (err) {
      await saveDebugScreenshot(page, 'rename-failure');
      throw new Error(`${err.message} (screenshot in .debug/rename-failure.png)`);
    }
  });
}

// Waits for the Summary tab's content (Plaud only renames inside content it has loaded).
async function summaryText(page) {
  await page.waitForFunction(() => (document.querySelector('.summary-module')?.innerText || '').length > 200, { timeout: 20000 }).catch(() => {});
  return page.$eval('.summary-module', (e) => e.innerText).catch(() => '');
}

// "Speaker 1" as a whole label (so it doesn't match "Speaker 10").
const mentions = (text, label) => new RegExp(`(^|[^\\w])${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\w)`).test(text);

// Opens ⋯ → Name speakers and returns the names shown, in order.
async function openNameSpeakers(page) {
  await page.locator('.more-menu').setTimeout(20000).click();
  await page.locator('li.el-dropdown-menu__item ::-p-text(Name speakers)').setTimeout(5000).click();
  await page.locator('[role="dialog"] .speaker-display').setTimeout(10000).wait();
  return page.$$eval('[role="dialog"] .speaker-display .speaker-name', (els) => els.map((e) => e.textContent.trim()));
}

async function clickSpeaker(page, name) {
  const handles = await page.$$('[role="dialog"] .speaker-display');
  for (const h of handles) {
    if ((await h.evaluate((e) => e.querySelector('.speaker-name')?.textContent.trim())) === name) {
      await h.evaluate((e) => e.scrollIntoView({ block: 'center' }));
      await h.click();
      return;
    }
  }
  throw new Error(`No speaker named "${name}" in Plaud's dialog`);
}
