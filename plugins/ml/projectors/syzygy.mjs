// syzygy — the byte-exact fused pass as a projector. The frame is box-resized to
// (2*cols) x (4*rows) pixels, converted to NV12, and run through the shipped JS
// port (docs/poc/syzygy.js, byte-exact with the C kernel on 2405 frames — V02).
// `field` picks which of the pass's per-cell outputs becomes the text:
//   glyph   Sobel edge angle ─ │ ╱ ╲ on edges, density ramp elsewhere (0003)
//   braille 8-dot Braille, one dot per pixel above braille_thresh (0001)
//   tone    the argmax tokenizer's ramp character (0007)
// With the golden params (braille_thresh 100, edge_thresh2 4000) the text is
// fully determined by the kernel; this plugin adds only the resize and the NV12
// conversion in front of it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resize, toNV12 } from '../core.mjs';
import { registerProjector } from '../registry.mjs';
import { rowsFor, pickFrames } from './mirror.mjs';

const PORT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../docs/poc/syzygy.js');
export const port = await import('data:text/javascript;base64,' + fs.readFileSync(PORT).toString('base64'));

export function fusedCells(frame, cols, rows, p) {
  const nv = toNV12(resize(frame, 2 * cols, 4 * rows));
  return port.syz_fused(nv, { braille_thresh: p.braille_thresh, edge_thresh2: p.edge_thresh2, fft_row: 0 });
}

export function fusedText(o, field) {
  const lines = [];
  for (let y = 0; y < o.rows; y++) {
    let s = '';
    for (let x = 0; x < o.cols; x++) {
      const i = y * o.cols + x;
      s += field === 'braille' ? String.fromCodePoint(0x2800 + o.mask[i])
         : field === 'tone' ? String.fromCharCode(o.tone[i]) : String.fromCodePoint(o.glyph[i]);
    }
    lines.push(s);
  }
  return lines;
}

registerProjector({
  name: 'syzygy',
  about: 'the byte-exact fused kernel (docs/poc/syzygy.js) as a projector: edge glyphs, braille or tone',
  params: {
    cols:           { type: 'int', min: 16, max: 160, default: 64 },
    field:          { type: 'enum', values: ['glyph', 'braille', 'tone'], default: 'glyph' },
    braille_thresh: { type: 'int', min: 0, max: 255, default: 100 },
    edge_thresh2:   { type: 'int', min: 0, max: 400000, default: 4000 },
    frames:         { type: 'int', min: 1, max: 4, default: 1 },
  },
  project(seq, p) {
    const rows = rowsFor(seq, p.cols), blocks = [];
    for (const f of pickFrames(seq, p.frames)) blocks.push(fusedText(fusedCells(f, p.cols, rows, p), p.field).join('\n'));
    const text = blocks.join('\n\n');
    return { text_projection: text, char_budget: [...text.replace(/\n/g, '')].length,
             compute_estimate: { ops: p.frames * (seq.frames[0].w * seq.frames[0].h + 8 * 4 * p.cols * rows * 9) } };
  },
});
