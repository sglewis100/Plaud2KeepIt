import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OggOpusDecoder } from 'ogg-opus-decoder';
import { promisify } from 'node:util';

// Speaker voice prints: fixed-length embeddings from a speaker-verification
// model (3D-Speaker ERes2Net, trained on VoxCeleb English). Two clips of the
// same voice give embeddings with high cosine similarity; different voices
// score low. Chosen over CAM++ and others by testing on labeled meetings.

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MODEL_NAME = 'eres2net_en_voxceleb_16k';
const MODEL_PATH = path.join(__dirname, 'models', `${MODEL_NAME}.onnx`);
export const SAMPLE_RATE = 16000;

// How much speech to use per speaker, and which transcript segments qualify.
const TARGET_SECONDS = 60;
const MIN_SEGMENT_MS = 1500; // shorter turns are often "yeah"/"right" and crosstalk
const MAX_SEGMENT_MS = 15000; // cap so one long monologue doesn't dominate
const EDGE_TRIM_MS = 150; // transcript boundaries are approximate

let extractor = null;
function getExtractor() {
  extractor ??= new sherpa.SpeakerEmbeddingExtractor({ model: MODEL_PATH, numThreads: 2, debug: false });
  return extractor;
}

// ---- Audio ----

// Decodes a recording to mono Float32 PCM at 16 kHz. Plaud's own recordings
// are Ogg/Opus; files uploaded to Plaud can be MP3, M4A and so on, which macOS's
// afconvert decodes.
export async function decodeTo16k(bytes) {
  return bytes.subarray(0, 4).toString('latin1') === 'OggS' ? decodeOgg(bytes) : decodeWithAfconvert(bytes);
}

async function decodeOgg(bytes) {
  const decoder = new OggOpusDecoder();
  await decoder.ready;
  try {
    const { channelData, sampleRate, errors } = await decoder.decodeFile(new Uint8Array(bytes));
    if (!channelData?.length || !channelData[0].length) throw new Error(`Couldn’t decode the audio${errors?.[0] ? `: ${errors[0].message}` : ''}`);
    const mono = channelData.length === 1 ? channelData[0] : mixDown(channelData);
    return resample(mono, sampleRate, SAMPLE_RATE);
  } finally {
    decoder.free();
  }
}

async function decodeWithAfconvert(bytes) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plaud2keepit-audio-'));
  try {
    const src = path.join(dir, 'in'), out = path.join(dir, 'out.wav');
    await writeFile(src, bytes);
    await promisify(execFile)('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SAMPLE_RATE}`, '-c', '1', src, out], { timeout: 10 * 60 * 1000 })
      .catch((err) => { throw new Error(`Couldn’t decode the audio (afconvert: ${(err.stderr || err.message).trim()})`); });
    return wavSamples(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// 16-bit mono samples from any WAV (walks the chunks; afconvert adds extra ones).
function wavSamples(buf) {
  for (let at = 12; at + 8 <= buf.length;) {
    const id = buf.toString('latin1', at, at + 4), size = buf.readUInt32LE(at + 4);
    if (id === 'data') {
      const n = Math.floor(Math.min(size, buf.length - at - 8) / 2);
      const out = new Float32Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(at + 8 + i * 2) / 32768;
      return out;
    }
    at += 8 + size + (size % 2);
  }
  throw new Error('Couldn’t decode the audio (no data in converted WAV)');
}

// 16-bit mono WAV at 16 kHz. Browsers seek WAV exactly (Plaud's Ogg files carry
// an extra metadata stream that throws off some browsers' seeking by ~7%).
export function encodeWav(samples, sampleRate = SAMPLE_RATE) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  return buf;
}

export function decodeWav(buf) {
  const n = (buf.length - 44) / 2;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(44 + i * 2) / 32768;
  return out;
}

function mixDown(channels) {
  const out = new Float32Array(channels[0].length);
  for (const ch of channels) for (let i = 0; i < out.length; i++) out[i] += ch[i] / channels.length;
  return out;
}

// Low-pass (windowed-sinc FIR) then decimate. Opus is always 48 kHz → factor 3.
function resample(input, from, to) {
  if (from === to) return input;
  const factor = from / to;
  if (!Number.isInteger(factor)) throw new Error(`Unsupported resample ${from} → ${to}`);
  const taps = 64;
  const cutoff = 0.9 / (2 * factor); // just under the new Nyquist, as a fraction of `from`
  const h = new Float32Array(taps + 1);
  let sum = 0;
  for (let i = 0; i <= taps; i++) {
    const n = i - taps / 2;
    const sinc = n === 0 ? 2 * cutoff : Math.sin(2 * Math.PI * cutoff * n) / (Math.PI * n);
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / taps);
    sum += h[i] = sinc * hann;
  }
  for (let i = 0; i <= taps; i++) h[i] /= sum;

  const out = new Float32Array(Math.floor(input.length / factor));
  for (let o = 0; o < out.length; o++) {
    const center = o * factor;
    let acc = 0;
    for (let k = 0; k <= taps; k++) {
      const idx = center + k - taps / 2;
      if (idx >= 0 && idx < input.length) acc += input[idx] * h[k];
    }
    out[o] = acc;
  }
  return out;
}

// ---- Segment selection ----

// Picks the cleanest stretches of one speaker's speech: long enough turns that
// don't overlap anyone else, trimmed at the edges, longest first, until we
// have TARGET_SECONDS. Returns [{ startMs, endMs }] in timeline order.
export function pickSegments(segments, speaker) {
  const others = segments.filter((s) => s.speaker !== speaker);
  const overlapsOther = (a, b) => others.some((o) => o.start_time < b && o.end_time > a);

  const candidates = segments
    .filter((s) => s.speaker === speaker)
    .map((s) => ({ startMs: s.start_time + EDGE_TRIM_MS, endMs: s.end_time - EDGE_TRIM_MS }))
    .filter((s) => s.endMs - s.startMs >= MIN_SEGMENT_MS && !overlapsOther(s.startMs, s.endMs))
    .map((s) => ({ ...s, endMs: Math.min(s.endMs, s.startMs + MAX_SEGMENT_MS) }))
    .sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs));

  const chosen = [];
  let total = 0;
  for (const c of candidates) {
    if (total >= TARGET_SECONDS * 1000) break;
    chosen.push(c);
    total += c.endMs - c.startMs;
  }
  return chosen.sort((a, b) => a.startMs - b.startMs);
}

// ---- Embeddings ----

function embed(samples) {
  const ex = getExtractor();
  const stream = ex.createStream();
  stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples });
  stream.inputFinished();
  if (!ex.isReady(stream)) return null;
  return normalize(Float32Array.from(ex.compute(stream)));
}

// One voice print for a speaker: the normalized mean of per-segment embeddings.
// Also reports how consistent those segments were with each other (a low
// score usually means the transcript mixed up who was talking).
export function voicePrint(audio16k, chosenSegments) {
  const embeddings = [];
  let seconds = 0;
  for (const { startMs, endMs } of chosenSegments) {
    const a = Math.floor((startMs / 1000) * SAMPLE_RATE);
    const b = Math.min(audio16k.length, Math.floor((endMs / 1000) * SAMPLE_RATE));
    if (b - a < SAMPLE_RATE) continue;
    const e = embed(audio16k.subarray(a, b));
    if (e) {
      embeddings.push(e);
      seconds += (b - a) / SAMPLE_RATE;
    }
  }
  if (!embeddings.length) return null;
  const mean = new Float32Array(embeddings[0].length);
  for (const e of embeddings) for (let i = 0; i < mean.length; i++) mean[i] += e[i];
  const print = normalize(mean);
  const consistency = embeddings.reduce((acc, e) => acc + cosine(e, print), 0) / embeddings.length;
  return { embedding: print, seconds, segments: embeddings.length, consistency };
}

export function cosine(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // inputs are unit vectors
}

function normalize(v) {
  let n = 0;
  for (const x of v) n += x * x;
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < v.length; i++) v[i] /= n;
  return v;
}

export const toBlob = (f32) => Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
export const fromBlob = (buf) => new Float32Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
