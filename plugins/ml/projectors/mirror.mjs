// mirror — the honest baseline (chiaroscuro's "lake test" reference): each cell
// is the brightness of the pixels under it, mapped onto a density ramp. Nothing
// else. Every other projector is judged side by side against this one.
// frames > 1 stacks that many evenly spaced frames (oldest first, blank line
// between) — the brute-force way to show time: pay N x the characters.
import { lumaGrid } from '../core.mjs';
import { registerProjector } from '../registry.mjs';

export const RAMPS = { standard: ' .:-=+*#%@', short: ' .:*#', long: " .'`^\",:;Il!i><~+_-?][}{1)(|/tfjrxnuvczXYUJCLQ0OZmwqpdbkhao*#MW&8%B@$",
                       blocks: ' ░▒▓█' };

export const rowsFor = (seq, cols) => Math.max(4, Math.round(cols * (seq.frames[0].h / seq.frames[0].w) / 2));

export function toneText(grid, cols, rows, ramp, gamma = 1, invert = false) {
  const R = [...RAMPS[ramp]], n = R.length, lines = [];
  for (let y = 0; y < rows; y++) {
    let s = '';
    for (let x = 0; x < cols; x++) {
      let v = grid[y * cols + x] / 255; if (invert) v = 1 - v;
      s += R[Math.min(n - 1, Math.floor(Math.pow(v, gamma) * n))];
    }
    lines.push(s);
  }
  return lines;
}

export function pickFrames(seq, k) {
  const n = seq.frames.length; if (k <= 1) return [seq.frames[n - 1]];
  return Array.from({ length: k }, (_, i) => seq.frames[Math.round(i * (n - 1) / (k - 1))]);
}

registerProjector({
  name: 'mirror',
  about: 'brightness-only density ramp; the lake-test baseline',
  params: {
    cols:   { type: 'int', min: 16, max: 160, default: 64 },
    ramp:   { type: 'enum', values: Object.keys(RAMPS), default: 'standard' },
    gamma:  { type: 'float', min: 0.3, max: 3, default: 1 },
    invert: { type: 'bool', default: false },
    frames: { type: 'int', min: 1, max: 4, default: 1 },
  },
  project(seq, p) {
    const rows = rowsFor(seq, p.cols), blocks = [];
    for (const f of pickFrames(seq, p.frames))
      blocks.push(toneText(lumaGrid(f, p.cols, rows), p.cols, rows, p.ramp, p.gamma, p.invert).join('\n'));
    const text = blocks.join('\n\n');
    return { text_projection: text, char_budget: [...text.replace(/\n/g, '')].length,
             compute_estimate: { ops: p.frames * seq.frames[0].w * seq.frames[0].h } };
  },
});
