// inverse — the free, local fidelity signal. Read the text back into a brightness
// grid (each character -> the ink it puts on the page) and correlate it with the
// original frame's brightness at the same grid. It asks "does the text keep the
// light where the light was?" and nothing more: it cannot see objects or motion,
// and it punishes any glyph (arrows, edges) that trades tone for meaning. That
// blind spot is why the vision-model critic exists; this one is for spending
// zero money to throw away obviously broken candidates.
import { lumaGrid } from '../core.mjs';
import { registerScorer } from '../registry.mjs';
import { RAMPS } from '../projectors/mirror.mjs';

const INK = new Map();
{ const L = [...RAMPS.long]; L.forEach((c, i) => INK.set(c, i / (L.length - 1))); }
[...' ░▒▓█'].forEach((c, i) => INK.set(c, i / 4));
for (const c of '─│╱╲') INK.set(c, 0.2);
for (const c of '→←↑↓') INK.set(c, 0.3);
export function ink(ch) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x2800 && cp <= 0x28ff) { let m = cp - 0x2800, n = 0; while (m) { n += m & 1; m >>= 1; } return n / 8; }
  return INK.has(ch) ? INK.get(ch) : 0.5;
}

// The newest frame's block of a projection (last blank-line-separated block,
// legend lines dropped) as a { cols, rows, grid } of ink values.
export function textGrid(text) {
  const blocks = text.split('\n\n'), lines = blocks[blocks.length - 1].split('\n').filter((l) => !l.startsWith('legend:'));
  const rows = lines.length, cols = Math.max(...lines.map((l) => [...l].length));
  const grid = new Float32Array(cols * rows);
  lines.forEach((l, y) => [...l].forEach((c, x) => { grid[y * cols + x] = ink(c); }));
  return { cols, rows, grid };
}

export function pearson(a, b) {
  const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; } ma /= n; mb /= n;
  let sab = 0, saa = 0, sbb = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; sab += x * y; saa += x * x; sbb += y * y; }
  return saa && sbb ? sab / Math.sqrt(saa * sbb) : 0;
}

registerScorer({
  name: 'inverse',
  cost: 'free',
  about: 'correlation between the text read back as ink and the original brightness',
  async score({ seq, projection }) {
    const t = textGrid(projection.text_projection);
    const ref = lumaGrid(seq.frames[seq.frames.length - 1], t.cols, t.rows);
    const r = pearson(t.grid, ref);
    return { fidelity: Math.max(0, r), detail: { r: +r.toFixed(4), cols: t.cols, rows: t.rows } };
  },
});
