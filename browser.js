import { execFile, spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Persistent profile so cookies/logins (e.g. Plaud) survive restarts.
const USER_DATA_DIR = process.env.CHROME_PROFILE_DIR || path.join(__dirname, '.chrome-profile');

// HEADLESS=false opens a visible window for every automation run (handy for debugging).
const HEADLESS = process.env.HEADLESS !== 'false';

// Port for the visible login window's DevTools endpoint.
const LOGIN_DEBUG_PORT = Number(process.env.LOGIN_DEBUG_PORT || 40222);

// Analytics/telemetry endpoints Plaud's web app calls. Blocked in every page we
// open; none are needed for the site to work.
const BLOCKED_URLS = [
  '*://*.google-analytics.com/*',
  '*://analytics.google.com/*',
  '*://*.googletagmanager.com/*',
  '*://*.posthog.com/*',
  '*://firebase.googleapis.com/*',
  '*://*.firebaseinstallations.googleapis.com/*',
  '*://static.cloudflareinsights.com/*',
  '*://log.cookieyes.com/*',
  '*://m.stripe.com/*',
  '*://guardian-web.plaud.ai/*', // Sentry error reporting
];

export async function blockTrackers(page) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs', { urls: BLOCKED_URLS });
}

let browserPromise = null;

// Set while an interactive (visible) window owns the profile. Chrome locks the
// profile directory, so headless work has to wait until that window is gone.
let interactiveSession = null;

export function isInteractiveSessionOpen() {
  return interactiveSession !== null;
}

const launchOptions = () => ({
  headless: HEADLESS,
  userDataDir: USER_DATA_DIR,
  // Set CHROME_PATH to use an installed Chrome/Chromium instead of the bundled one.
  executablePath: process.env.CHROME_PATH || undefined,
  defaultViewport: { width: 1280, height: 900 },
});

export function getBrowser() {
  if (interactiveSession) {
    return Promise.reject(new Error('Browser profile is in use by the login window'));
  }
  if (!browserPromise) {
    browserPromise = puppeteer
      .launch(launchOptions())
      .catch(async (err) => {
        // A Chrome we lost touch with (e.g. across sleep, or from a server that
        // didn't shut down cleanly) still holds the profile lock: stop it, retry.
        if (!/already running/i.test(err.message) || !(await killStaleChrome())) throw err;
        return puppeteer.launch(launchOptions());
      })
      .then((browser) => {
        browser.on('disconnected', () => {
          browserPromise = null;
          // Connection lost but Chrome may still be running and holding the
          // profile; make sure it's gone so the next launch can start.
          const proc = browser.process();
          if (proc && proc.exitCode === null) proc.kill('SIGKILL');
        });
        return browser;
      })
      .catch((err) => {
        browserPromise = null;
        throw err;
      });
  }
  return browserPromise;
}

// Stops the Chrome holding this app's profile lock, if it's really one running
// on this profile. Chrome's SingletonLock points at "<host>-<pid>".
async function killStaleChrome() {
  let pid;
  try { pid = Number(readlinkSync(path.join(USER_DATA_DIR, 'SingletonLock')).split('-').pop()); } catch { return false; }
  if (!pid) return false;
  const command = await promisify(execFile)('ps', ['-p', String(pid), '-o', 'command=']).then((r) => r.stdout, () => '');
  if (!command.includes(`--user-data-dir=${USER_DATA_DIR}`)) return false;
  console.warn(`Stopping a stale Chrome (pid ${pid}) that was holding the browser profile`);
  try { process.kill(pid, 'SIGKILL'); } catch { return false; }
  for (let i = 0; i < 20; i++) {
    try { process.kill(pid, 0); } catch { return true; } // gone
    await new Promise((r) => setTimeout(r, 100));
  }
  return true;
}

// Opens a fresh page, runs fn(page), and always closes the page afterward.
export async function withPage(fn) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await blockTrackers(page);
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

export async function closeBrowser() {
  if (browserPromise) {
    const browser = await browserPromise.catch(() => null);
    browserPromise = null;
    await browser?.close();
  }
}

// Opens a normal, visible Chrome window on the shared profile so a person can
// interact with it (e.g. sign in with Google/Apple). Chrome is spawned directly
// rather than via puppeteer.launch so it doesn't carry the automation flags that
// some sign-in providers reject. Returns a puppeteer Browser connected to it.
export async function openInteractiveWindow(url) {
  if (interactiveSession) throw new Error('A login window is already open');
  await closeBrowser();

  const executable = process.env.CHROME_PATH || (await puppeteer.executablePath());
  const args = (await puppeteer.defaultArgs({ headless: false, userDataDir: USER_DATA_DIR }))
    .filter((arg) => arg !== '--enable-automation' && arg !== 'about:blank')
    .concat([
      '--disable-blink-features=AutomationControlled',
      `--remote-debugging-port=${LOGIN_DEBUG_PORT}`,
      '--new-window',
      url,
    ]);

  const child = spawn(executable, args, { stdio: 'ignore' });
  interactiveSession = { child };
  child.on('exit', () => {
    interactiveSession = null;
  });

  try {
    const browser = await connectWithRetry(`http://127.0.0.1:${LOGIN_DEBUG_PORT}`);
    interactiveSession.browser = browser;
    // Same tracker blocking for the login window (and any popups it opens).
    const guard = (page) => page && blockTrackers(page).catch(() => {});
    (await browser.pages()).forEach(guard);
    browser.on('targetcreated', async (t) => guard(await t.page().catch(() => null)));
    return browser;
  } catch (err) {
    child.kill();
    interactiveSession = null;
    throw err;
  }
}

// Closes the visible window gracefully (so cookies are flushed to disk).
export async function closeInteractiveWindow() {
  const session = interactiveSession;
  if (!session || session.child.exitCode !== null) return;
  const exited = new Promise((resolve) => session.child.once('exit', resolve));
  await session.browser?.close().catch(() => {});
  const timer = setTimeout(() => session.child.kill(), 5000);
  await exited;
  clearTimeout(timer);
}

async function connectWithRetry(browserURL, attempts = 40) {
  for (let i = 0; ; i++) {
    try {
      return await puppeteer.connect({ browserURL, defaultViewport: null });
    } catch (err) {
      if (i >= attempts) throw err;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
