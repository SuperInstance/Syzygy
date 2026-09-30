// motion — a projector that shows what MOVED, not only what is bright.
//
// At cell resolution:
//   1. background = per-cell temporal median of luma over the last `history`
//      frames (anything that stayed put); a short history fails when a large
//      object covers a cell for more than half of it
//   Over the last `window` frames:
//   2. foreground_t = cells whose luma differs from the background by > thresh
//   3. connected foreground blobs in the newest frame are tracked back through
//      the window by nearest centroid; the displacement gives each blob a
//      velocity in cells/frame and a direction (left/right/up/down)
//   4. the text is a background layer (bg: tone ramp, the kernel's edge glyphs
//      'fused', the kernel's 8-dot 'braille', a 'dim' ramp, or 'blank') with the
//      moving blobs re-drawn:
//        mark=fill  every blob cell becomes the direction arrow
//        mark=edge  only the leading-edge cells become arrows (shape survives)
//        mark=head  the blob keeps its tone; arrows are placed just AHEAD of it
//      plus a `trail` of '~' where the blob was up to `trail` frames ago.
// `legend` prepends one line telling the reader what the marks mean (it costs
// characters; the search decides whether it pays for itself).
// Static scenes cost nothing extra: with no motion this degrades to its bg layer.
import { lumaGrid } from '../core.mjs';
import { registerProjector } from '../registry.mjs';
import { directionOf } from '../scenes.mjs';
import { rowsFor, toneText } from './mirror.mjs';
import { fusedCells, fusedText } from './syzygy.mjs';

const ARROWS = { ascii: { right: '>', left: '<', up: '^', down: 'v' }, unicode: { right: '→', left: '←', up: '↑', down: '↓' } };

function median(a) { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; }

export function components(mask, cols, rows) {
  const lab = new Int32Array(cols * rows).fill(-1), comps = [];
  for (let i = 0; i < cols * rows; i++) {
    if (!mask[i] || lab[i] >= 0) continue;
    const cells = [], stack = [i]; lab[i] = comps.length;
    while (stack.length) {
      const j = stack.pop(); cells.push(j);
      const x = j % cols, y = (j / cols) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy, k = Y * cols + X;
        if (X >= 0 && Y >= 0 && X < cols && Y < rows && mask[k] && lab[k] < 0) { lab[k] = comps.length; stack.push(k); }
      }
    }
    let sx = 0, sy = 0; for (const j of cells) { sx += j % cols; sy += (j / cols) | 0; }
    comps.push({ cells, cx: sx / cells.length, cy: sy / cells.length, n: cells.length });
  }
  return { lab, comps };
}

// Analyse motion over the window: returns per-blob tracks for the newest frame.
export function analyseMotion(seq, cols, rows, p) {
  // background from the longer history (a live camera has seconds of it);
  // tracking only over the short window
  const hist = seq.frames.slice(-p.history).map((f) => lumaGrid(f, cols, rows));
  const grids = hist.slice(-p.window), T = grids.length;
  const bg = new Float32Array(cols * rows);
  for (let i = 0; i < cols * rows; i++) bg[i] = median(hist.map((g) => g[i]));
  const fg = grids.map((g) => g.map((v, i) => Math.abs(v - bg[i]) > p.thresh ? 1 : 0));
  const perFrame = fg.map((m) => components(m, cols, rows).comps.filter((c) => c.n >= p.min_blob));
  const blobs = perFrame[T - 1].map((c) => {
    // walk back frame by frame to the nearest centroid (max jump: 1/4 of the width)
    let cur = c, steps = 0;
    for (let t = T - 2; t >= 0; t--) {
      let best = null, bd = cols / 4;
      for (const d of perFrame[t]) { const dist = Math.hypot(d.cx - cur.cx, (d.cy - cur.cy) * 2); if (dist < bd) { bd = dist; best = d; } }
      if (!best) break; cur = best; steps++;
    }
    const vx = steps ? (c.cx - cur.cx) / steps : 0, vy = steps ? (c.cy - cur.cy) / steps : 0;
    return { ...c, vx, vy, dir: directionOf(vx, vy * 2, p.min_speed), steps };
  });
  return { grids, bg, fg, blobs, T };
}

registerProjector({
  name: 'motion',
  about: 'temporal-median background + tracked foreground blobs; arrows show what moved and which way',
  params: {
    cols:      { type: 'int', min: 16, max: 160, default: 64 },
    history:   { type: 'int', min: 3, max: 16, default: 12 },
    window:    { type: 'int', min: 2, max: 8, default: 4 },
    thresh:    { type: 'float', min: 4, max: 120, default: 24 },
    min_blob:  { type: 'int', min: 1, max: 20, default: 2 },
    min_speed: { type: 'float', min: 0.05, max: 3, default: 0.3 },
    bg:        { type: 'enum', values: ['tone', 'fused', 'braille', 'dim', 'blank'], default: 'tone' },
    braille_thresh: { type: 'int', min: 0, max: 255, default: 100 },
    ramp:      { type: 'enum', values: ['standard', 'short', 'blocks'], default: 'standard' },
    mark:      { type: 'enum', values: ['fill', 'edge', 'head'], default: 'edge' },
    arrows:    { type: 'enum', values: ['ascii', 'unicode'], default: 'ascii' },
    trail:     { type: 'int', min: 0, max: 7, default: 3 },
    legend:    { type: 'bool', default: false },
  },
  project(seq, p) {
    const rows = rowsFor(seq, p.cols), cols = p.cols;
    const m = analyseMotion(seq, cols, rows, p), last = m.grids[m.T - 1];
    let lines;
    if (p.bg === 'fused' || p.bg === 'braille') lines = fusedText(fusedCells(seq.frames[seq.frames.length - 1], cols, rows,
                                           { braille_thresh: p.braille_thresh, edge_thresh2: 4000 }), p.bg === 'fused' ? 'glyph' : 'braille');
    else if (p.bg === 'blank') lines = Array.from({ length: rows }, () => ' '.repeat(cols));
    else if (p.bg === 'dim') lines = toneText(last, cols, rows, 'short', 1.6);
    else lines = toneText(last, cols, rows, p.ramp);
    const G = lines.map((l) => [...l]);
    const set = (x, y, ch) => { if (x >= 0 && y >= 0 && x < cols && y < rows) G[y][x] = ch; };
    const tone = (i) => toneText([last[i]], 1, 1, p.ramp)[0];

    // trail: foreground in the last `trail` frames but not now, near a moving blob
    const moving = m.blobs.filter((b) => b.dir !== 'none');
    if (p.trail > 0 && moving.length) {
      const now = m.fg[m.T - 1];
      for (let t = Math.max(0, m.T - 1 - p.trail); t < m.T - 1; t++)
        for (let i = 0; i < cols * rows; i++) if (m.fg[t][i] && !now[i]) set(i % cols, (i / cols) | 0, '~');
    }
    // blobs: static ones keep tone even on a blank/dim background
    const A = ARROWS[p.arrows];
    for (const b of m.blobs) {
      const inBlob = new Set(b.cells);
      for (const i of b.cells) {
        const x = i % cols, y = (i / cols) | 0;
        if (b.dir === 'none') { if (p.bg === 'blank' || p.bg === 'dim') set(x, y, tone(i)); continue; }
        const [dx, dy] = { right: [1, 0], left: [-1, 0], down: [0, 1], up: [0, -1] }[b.dir];
        const lead = !inBlob.has((y + dy) * cols + (x + dx));
        if (p.mark === 'fill') set(x, y, A[b.dir]);
        else if (p.mark === 'edge') set(x, y, lead ? A[b.dir] : (p.bg === 'blank' || p.bg === 'dim' ? tone(i) : G[y][x]));
        else { if (p.bg === 'blank' || p.bg === 'dim') set(x, y, tone(i)); if (lead) set(x + dx, y + dy, A[b.dir]); }
      }
    }
    let out = G.map((r) => r.join(''));
    if (p.legend) out = [`legend: ${A.right}${A.left}${A.up}${A.down} = moving that way, ~ = where it just was`, ...out];
    const text = out.join('\n');
    return { text_projection: text, char_budget: [...text.replace(/\n/g, '')].length,
             compute_estimate: { ops: m.T * seq.frames[0].w * seq.frames[0].h + m.T * cols * rows * 8 },
             motion: m.blobs.map((b) => ({ cx: +b.cx.toFixed(1), cy: +b.cy.toFixed(1), n: b.n, dir: b.dir,
                                            vx: +b.vx.toFixed(2), vy: +b.vy.toFixed(2) })) };
  },
});
