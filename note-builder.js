import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { marked } from 'marked';

// Builds a Keep It-ready rich text document (RTFD, with images embedded) from
// a Plaud summary: Markdown → styled HTML → textutil → .rtfd bundle.
// textutil won't load images from HTML, so each image goes in as a text marker
// that's swapped afterwards for an RTFD attachment (the same form TextEdit
// writes when you paste an image), with the PNG copied into the bundle.

const run = promisify(execFile);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const CSS = `
  /* Avenir Next ships with every Mac and reads well on screen. */
  body, p, li, div, blockquote, a, td, th { font-family: "Avenir Next", Avenir, sans-serif; }
  body { font-size: 15px; color: #1f2329; line-height: 1.5; }
  h1, h2, h3, h4 { font-family: "Avenir Next", Avenir, sans-serif; }
  strong, b { font-weight: 600; }
  h1 { font-size: 24px; font-weight: 600; margin: 0 0 4px; color: #111418; }
  h2 { font-size: 18px; font-weight: 600; margin: 22px 0 6px; color: #2b2f8f; }
  h3 { font-size: 16px; font-weight: 600; margin: 18px 0 4px; color: #2b2f8f; }
  h4 { font-size: 14px; font-weight: 600; margin: 14px 0 2px; color: #3a3f4b; }
  p { margin: 0 0 8px; }
  ul, ol { margin: 0 0 8px; }
  li { margin: 0 0 3px; }
  blockquote { margin: 6px 0 10px 0; padding-left: 10px; color: #4a5160; }
  .meta { color: #7b8392; font-size: 12px; margin-bottom: 2px; }
  .meta a { color: #4f46e5; }
  .figure { margin: 10px 0 14px; }
  hr { border: 0; border-top: 1px solid #e3e6eb; margin: 14px 0; }
  .turn-head { margin: 14px 0 2px; }
  .speaker { font-weight: 600; }
  .ts { color: #9aa1ad; font-size: 12px; }
  .turn { margin: 0 0 6px; }
`;

const marker = (n) => `QQPLAUDIMAGE${n}QQ`;

// images: Map index → { file (basename inside the bundle), width, height } (points)
export function summaryHtml(markdown, { title, metaLines = [], images = new Map() }) {
  // Placeholders → figure markers that survive Markdown rendering.
  const md = markdown.replace(/^\s*\[\]\(plaud:\/\/image\?[^)]*?_i(\d+)\)\s*$/gm, (_, n) => `\n\nPLAUDIMG${n}\n\n`);
  // breaks: single line breaks stay line breaks, as Plaud shows them.
  let body = marked.parse(md, { gfm: true, breaks: true });
  body = body.replace(/<p>PLAUDIMG(\d+)<\/p>/g, (_, n) => {
    const img = images.get(Number(n));
    return img ? `<p class="figure">${marker(n)}</p>` : '<p class="meta">[image unavailable]</p>';
  });
  // Task-list checkboxes → characters (rich text has no form controls).
  body = body
    .replace(/<input[^>]*checked[^>]*>\s*/g, '☑ ')
    .replace(/<input[^>]*type="checkbox"[^>]*>\s*/g, '☐ ');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title><style>${CSS}</style></head><body>
    <h1>${esc(title)}</h1>
    ${metaLines.map((l) => `<div class="meta">${l}</div>`).join('')}
    <hr>
    ${body}
  </body></html>`;
}

// Converts html to <dir>/<baseName>.rtfd and embeds the images at their markers.
// images: Map index → { file, data (Buffer), width, height } (display size in points)
export async function buildRtfd(dir, baseName, html, images = new Map()) {
  await mkdir(dir, { recursive: true });
  const htmlPath = path.join(dir, 'summary.html');
  await writeFile(htmlPath, html);
  const out = path.join(dir, `${baseName}.rtfd`);
  await rm(out, { recursive: true, force: true });
  await run('textutil', ['-convert', 'rtfd', '-inputencoding', 'UTF-8', htmlPath, '-output', out]);

  const rtfPath = path.join(out, 'TXT.rtf');
  let rtf = await readFile(rtfPath, 'latin1');
  for (const [n, img] of images) {
    const twW = Math.round(img.width * 20), twH = Math.round(img.height * 20);
    const attachment = `{{\\NeXTGraphic ${img.file} \\width${twW} \\height${twH} \\appleattachmentpadding0 \\appleembedtype0 \\appleaqc\n}\\'ac}`;
    if (!rtf.includes(marker(n))) throw new Error(`Image ${n}'s place wasn't found in the converted note`);
    rtf = rtf.replace(marker(n), attachment);
    await writeFile(path.join(out, img.file), img.data);
  }
  await writeFile(rtfPath, rtf, 'latin1');
  // Drop anything textutil added that the text doesn't reference.
  for (const f of await readdir(out)) {
    if (f !== 'TXT.rtf' && !rtf.includes(f)) await rm(path.join(out, f), { force: true });
  }
  return out;
}

// ---- Transcripts ----

const SPEAKER_COLORS = ['#4f46e5', '#0e7c86', '#b45309', '#15803d', '#be185d', '#7c3aed', '#0369a1', '#a16207'];

export function clock(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), sec = t % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

// Plaud transcript segments → Markdown: consecutive lines by the same speaker
// become one turn, headed by the speaker (in a steady color) and a timestamp.
// segments: [{ start_time, end_time, content, speaker }]
export function transcriptMarkdown(segments) {
  const talk = new Map();
  for (const s of segments) talk.set(s.speaker, (talk.get(s.speaker) || 0) + (s.end_time - s.start_time));
  const order = [...talk.keys()].sort((a, b) => talk.get(b) - talk.get(a));
  const color = new Map(order.map((n, i) => [n, SPEAKER_COLORS[i % SPEAKER_COLORS.length]]));

  const turns = [];
  for (const s of segments) {
    const last = turns.at(-1);
    if (last && last.speaker === s.speaker) last.text.push(s.content.trim());
    else turns.push({ speaker: s.speaker, start: s.start_time, text: [s.content.trim()] });
  }

  const people = order.map((n) => `<span style="color:${color.get(n)}">**${esc(n)}**</span> ${minutes(talk.get(n))}`).join(' · ');
  const lines = [`**Speakers:** ${people}`, '', '---', ''];
  for (const t of turns) {
    lines.push(`<p class="turn-head"><span class="speaker" style="color:${color.get(t.speaker)}">${esc(t.speaker)}</span> &nbsp;<span class="ts">${clock(t.start)}</span></p>`);
    lines.push('');
    lines.push(t.text.join(' ').replace(/([\\`*_[\]#])/g, '\\$1'));
    lines.push('');
  }
  return { markdown: lines.join('\n'), turns: turns.length, speakers: order };
}

const minutes = (ms) => { const m = Math.round(ms / 60000); return m < 1 ? 'under 1 min' : `${m} min`; };

// ---- Highlights ----

// Adds each highlight's moment ("✧ 30:41", as in Plaud's export) under its
// heading. Headings appear in the same order as the highlight entries.
// timestamps: [ms, …] in highlight order.
export function highlightsMarkdown(markdown, timestamps = []) {
  let i = 0;
  return markdown.replace(/^(#{1,3} .+)$/gm, (heading) => {
    const ts = timestamps[i++];
    return ts == null ? heading : `${heading}\n\n<span class="ts">✧ ${clock(ts)}</span>\n`;
  });
}
