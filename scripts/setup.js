// One-time setup after `npm install`:
//   1. downloads the speaker-recognition model used for voice prints
//   2. makes sure Puppeteer's Chrome is installed (npm may skip its install script)
import { createWriteStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MODEL = path.join(root, 'models', 'eres2net_en_voxceleb_16k.onnx');
const MODEL_URL = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_eres2net_sv_en_voxceleb_16k.onnx';

if (existsSync(MODEL) && statSync(MODEL).size > 20e6) {
  console.log('✓ Speaker model already present');
} else {
  console.log('Downloading the speaker model (~26 MB)…');
  mkdirSync(path.dirname(MODEL), { recursive: true });
  const res = await fetch(MODEL_URL);
  if (!res.ok) throw new Error(`Model download failed: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(MODEL));
  console.log(`✓ Speaker model saved (${(statSync(MODEL).size / 1e6).toFixed(1)} MB)`);
}

console.log('Checking Puppeteer’s Chrome (~570 MB the first time)…');
execFileSync('npx', ['--yes', 'puppeteer', 'browsers', 'install', 'chrome'], { cwd: root, stdio: 'inherit' });
console.log('✓ Setup complete. Start with `npm start` (or `npm run service:install`) and open http://localhost:40000');
