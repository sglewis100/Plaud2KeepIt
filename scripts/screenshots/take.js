// Retakes the README screenshots (docs/screenshots/*.png) from a mock server
// with made-up data, in a throwaway Chrome profile.
//   npm run screenshots            light mode
//   npm run screenshots -- dark    dark mode
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import puppeteer from 'puppeteer';
import { startMockServer } from './mock-server.js';

const APP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = path.join(APP, 'docs', 'screenshots');
const PORT = 40100;
const BASE = `http://127.0.0.1:${PORT}`;
const scheme = process.argv[2] === 'dark' ? 'dark' : 'light';
const WIDTH = 1600; // final image width (taken at 2x, then scaled down)

const server = await startMockServer(PORT);
const tmp = await mkdtemp(path.join(os.tmpdir(), 'p2k-shots-'));
const raw = path.join(tmp, 'raw');
await mkdir(raw);
const browser = await puppeteer.launch({ headless: true, userDataDir: path.join(tmp, 'profile') });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 860, deviceScaleFactor: 2 });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: scheme }]);
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = async (name) => { await page.screenshot({ path: path.join(raw, `${name}.png`) }); console.log('took', name); };

// Meetings, with a meeting selected
await page.goto(`${BASE}/`, { waitUntil: 'networkidle0' });
await page.click('.mrow[data-id]');
await wait(400);
await shot('meetings');

// Edit dialog
await page.click('.mrow.selected [data-action="edit"]');
await wait(2500);
await shot('edit');
await page.evaluate(() => document.querySelector('.sp-card[data-label="Speaker 3"]')?.scrollIntoView({ block: 'start' }));
await wait(300);
await shot('edit-speakers');
await page.evaluate(() => document.querySelector('dialog[open]')?.close());
await wait(300);

// Summary dialog
await page.click('.mrow.selected [data-action="summary"]');
await wait(1200);
await shot('summary');
await page.evaluate(() => document.querySelector('dialog[open]')?.close());

// Settings, Voice prints, Folders & Tags
await page.goto(`${BASE}/settings`, { waitUntil: 'networkidle0' });
await wait(800);
await shot('settings');
await page.goto(`${BASE}/voiceprints`, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('.vp-person')].find((p) => /Priya/.test(p.textContent))?.querySelector('[data-action="toggle"]').click());
await wait(500);
await shot('voiceprints');
await page.goto(`${BASE}/library`, { waitUntil: 'networkidle0' });
await page.evaluate(() => [...document.querySelectorAll('#tree [role="treeitem"], #tree .lib-node, #tree button')].find((e) => /Customers/.test(e.textContent))?.click());
await wait(600);
await shot('library');

await browser.close();
server.close();

await mkdir(OUT, { recursive: true });
for (const f of await readdir(raw)) {
  await promisify(execFile)('sips', ['-Z', String(WIDTH), path.join(raw, f), '--out', path.join(OUT, f)]);
}
await rm(tmp, { recursive: true, force: true });
// Unknown API calls get a 404 from the mock (e.g. audio); anything else is worth a look.
const real = errors.filter((e) => !/status of 404/.test(e));
console.log(`Saved to ${path.relative(APP, OUT)}/${real.length ? `\nPage errors:\n${real.join('\n')}` : ''}`);
