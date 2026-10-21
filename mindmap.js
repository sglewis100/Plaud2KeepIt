import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withPage } from './browser.js';

// Mind map PNGs from a Plaud summary, drawn the way Plaud's web app draws them
// (markmap: root on the left, curved colored branches, text over each line).
// Plaud's layout quirks are reproduced: heading-level topics sit beside their
// bullets rather than above them, and formatting (bold, checkboxes, quotes)
// is stripped.

// Browser builds, injected into a blank headless page (packages don't export these paths).
const modules = path.join(path.dirname(fileURLToPath(import.meta.url)), 'node_modules');
const D3 = path.join(modules, 'd3/dist/d3.min.js');
const MARKMAP = path.join(modules, 'markmap-view/dist/browser/index.js');

// Soft colors, one per top-level branch (matched to Plaud's).
const PALETTE = ['#e2b48f', '#d8cf88', '#b7d88e', '#8fd5b2', '#8cc8dc', '#b5a8de', '#e0a3b8'];

const clean = (s) => s
  .replace(/^\s*>\s?/, '')
  .replace(/^\s*[-*+]\s+(\[[ xX]\]\s+)?/, '')
  .replace(/\*\*(.+?)\*\*/g, '$1')
  .replace(/__(.+?)__/g, '$1')
  .replace(/(^|\W)\*(\S.*?)\*(?=\W|$)/g, '$1$2')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/\[([^\]]+)\]\((?!plaud:)[^)]*\)/g, '$1')
  .trim();

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// Markdown → { content, children } tree in Plaud's shape.
export function summaryTree(markdown, title) {
  const root = { content: title, children: [] };
  let branch = null; // current ##/### section
  let bulletStack = []; // [{ indent, node }]
  for (const raw of markdown.split('\n')) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim() || /^\s*(---|\*\*\*|___)\s*$/.test(line)) continue;
    if (/^\[\]\(plaud:\/\/image/.test(line.trim())) continue; // image placeholders
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = h[1].length;
      const text = clean(h[2]);
      // The first heading level present becomes a branch; deeper headings are
      // leaves beside the bullets that follow them (as Plaud shows them).
      if (!branch || level <= branch.level) {
        branch = { content: text, children: [], level };
        root.children.push(branch);
      } else {
        (branch.children).push({ content: text, children: [] });
      }
      bulletStack = [];
      continue;
    }
    const parent = branch || root;
    const quote = /^\s*>/.test(line);
    const body = quote ? line.replace(/^\s*>\s?/, '') : line;
    const bullet = body.match(/^(\s*)([-*+]|\d+[.)])\s+/);
    if (bullet) {
      const indent = bullet[1].length;
      const numbered = /\d/.test(bullet[2]);
      const text = clean(numbered ? body.trim() : body);
      while (bulletStack.length && bulletStack.at(-1).indent >= indent) bulletStack.pop();
      const into = bulletStack.at(-1)?.node || parent;
      // Plaud hangs numbered items off an empty circle.
      const node = numbered ? { content: '', children: [{ content: esc(text), children: [] }] } : { content: esc(text), children: [] };
      into.children.push(node);
      bulletStack.push({ indent, node: numbered ? node.children[0] : node });
    } else {
      parent.children.push({ content: esc(clean(body)), children: [] });
      bulletStack = [];
    }
  }
  for (const b of root.children) delete b.level;
  return root;
}

// Renders the tree to a PNG (Buffer). scale 2 = retina-sharp.
export async function renderMindMapPng(markdown, title, { scale = 2, maxTitle = 29 } = {}) {
  const shortTitle = title.length > maxTitle ? `${title.slice(0, maxTitle - 3).trimEnd()}...` : title;
  const tree = summaryTree(markdown, esc(shortTitle));
  return withPage(async (page) => {
    await page.setViewport({ width: 1600, height: 1200, deviceScaleFactor: scale });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>
      html, body { margin: 0; background: #fff; }
      svg { display: block; }
      .markmap { font: 300 14px/1.35 -apple-system, BlinkMacSystemFont, "Helvetica Neue", Arial, sans-serif; color: #1f2329; }
      .markmap-foreign { font-weight: 400; }
    </style></head><body><svg id="mm"></svg></body></html>`);
    await page.addScriptTag({ path: D3 });
    await page.addScriptTag({ path: MARKMAP });
    const size = await page.evaluate(async (data, palette) => {
      const { Markmap } = window.markmap;
      const svg = document.getElementById('mm');
      svg.setAttribute('width', 4000);
      svg.setAttribute('height', 4000);
      // Color each node by its top-level branch.
      const paint = (n, b) => { n.payload = { ...(n.payload || {}), branch: b }; (n.children || []).forEach((c) => paint(c, b)); };
      data.payload = { branch: 0 };
      data.children.forEach((b, i) => paint(b, i));
      const mm = Markmap.create(svg, {
        autoFit: false,
        duration: 0,
        maxWidth: 480,
        spacingVertical: 8,
        spacingHorizontal: 90,
        paddingX: 10,
        initialExpandLevel: -1,
        color: (node) => palette[(node.payload?.branch ?? 0) % palette.length],
      }, data);
      await new Promise((r) => setTimeout(r, 300));
      // Fit the drawing tightly with a margin, at 1:1 scale.
      const g = svg.querySelector('g');
      const box = g.getBBox();
      const pad = 60;
      g.setAttribute('transform', `translate(${pad - box.x},${pad - box.y})`);
      const w = Math.ceil(box.width + pad * 2), h = Math.ceil(box.height + pad * 2);
      svg.setAttribute('width', w);
      svg.setAttribute('height', h);
      return { w, h };
    }, tree, PALETTE);
    await page.setViewport({ width: size.w, height: size.h, deviceScaleFactor: scale });
    return page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: size.w, height: size.h }, omitBackground: false });
  });
}
