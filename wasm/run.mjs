// run.mjs — load the freestanding wasm32 build of the fused pass and prove it
// byte-exact: (1) it imports nothing (no libc, no host runtime), (2) the 32x16
// synthetic frame hashes to the native golden 0x6dbdd1a8, (3) every output
// field equals the browser port docs/poc/syzygy.js on a sweep of frames/params.
// Usage: node wasm/run.mjs [path/to/syzygy.wasm]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { syz_fused, syz_yuv_synth } = await import(path.join(HERE, '../docs/poc/syzygy.js'));

const GOLDEN = 0x6dbdd1a8;
const file = process.argv[2] || path.join(HERE, 'syzygy.wasm');
let pass = 0, fail = 0;
const CHECK = (ok, msg) => { ok ? pass++ : fail++; console.log(`  ${ok ? 'ok  ' : 'FAIL'}: ${msg}`); };

const mod = await WebAssembly.compile(fs.readFileSync(file));
console.log(`=== Syzygy wasm32 target: ${path.basename(file)} (${fs.statSync(file).size} bytes) ===`);
CHECK(WebAssembly.Module.imports(mod).length === 0, 'module imports nothing (no libc, no host runtime)');
const { exports: w } = await WebAssembly.instantiate(mod, {});

CHECK(w.syz_run(32, 16, 100, 4000, 1) === 0, 'syz_run(32x16, thresh 100, edge 4000, row 1) == 0');
const g = w.syz_golden() >>> 0;
console.log(`  info: wasm golden fnv1a = 0x${g.toString(16).padStart(8, '0')}`);
CHECK(g === GOLDEN, 'wasm golden == native golden 0x6dbdd1a8 (tests/test_fused.c)');

const eq = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const frames = [[32, 16], [64, 32], [16, 8], [48, 24], [64, 16]];
const params = [[100, 4000, 1], [0, 0, 0], [255, 1, 2], [60, 90000, 3], [128, 250, 0]];
let cases = 0, same = 0;
for (const [fw, fh] of frames) for (const [bt, e2, row] of params) {
  cases++;
  const rc = w.syz_run(fw, fh, bt, e2, row);
  const js = syz_fused(syz_yuv_synth(fw, fh, fw, fw), { braille_thresh: bt, edge_thresh2: e2, fft_row: row });
  const n = w.syz_cols() * w.syz_rows();
  const mem = w.memory.buffer;
  const wm = Array.from(new Uint8Array(mem, w.syz_mask_ptr(), n));
  const wt = Array.from(new Uint8Array(mem, w.syz_tone_ptr(), n));
  const wg = Array.from(new Uint32Array(mem, w.syz_glyph_ptr(), n));
  const wre = Array.from(new Int32Array(mem, w.syz_spec_re_ptr(), 16));
  const wim = Array.from(new Int32Array(mem, w.syz_spec_im_ptr(), 16));
  if (rc === 0 && w.syz_cols() === js.cols && w.syz_rows() === js.rows &&
      eq(wm, Array.from(js.mask)) && eq(wt, Array.from(js.tone)) && eq(wg, Array.from(js.glyph)) &&
      w.syz_fft_valid() === js.fft_valid &&
      (js.fft_valid === 0 || (w.syz_peak_bin() === js.peak_bin &&
        eq(wre, Array.from(js.spec_re)) && eq(wim, Array.from(js.spec_im))))) same++;
  else console.log(`  drift: ${fw}x${fh} params ${bt},${e2},${row}`);
}
CHECK(same === cases, `wasm == JS port on ${same}/${cases} frame x param cases (mask, glyph, tone, spectrum, peak)`);
console.log(`wasm: ${pass + fail} checks, ${fail} failures`);
process.exit(fail ? 1 : 0);
