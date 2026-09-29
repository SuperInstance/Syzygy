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
const file = process.argv[2] || path.join(HERE, '../docs/poc/syzygy.wasm');
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
// host-written frames: seeded random NV12 bytes written into linear memory
let seed = 0x5eed;
const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) >>> 24;
let hcases = 0, hsame = 0;
for (const [fw, fh] of [[32, 16], [160, 96], [64, 40], [96, 64]]) for (let t = 0; t < 5; t++) {
  hcases++;
  const y = new Uint8Array(fw * fh).map(rnd), uv = new Uint8Array(fw * (fh >> 1)).map(rnd);
  new Uint8Array(w.memory.buffer, w.syz_y_ptr(), y.length).set(y);
  new Uint8Array(w.memory.buffer, w.syz_uv_ptr(), uv.length).set(uv);
  const bt = rnd(), e2 = rnd() * 97, row = t;
  const rc = w.syz_run_frame(fw, fh, bt, e2, row);
  const js = syz_fused({ y, uv, w: fw, h: fh, y_stride: fw, uv_stride: fw }, { braille_thresh: bt, edge_thresh2: e2, fft_row: row });
  const n = w.syz_cols() * w.syz_rows(), mem = w.memory.buffer;
  if (rc === 0 && eq(Array.from(new Uint8Array(mem, w.syz_mask_ptr(), n)), Array.from(js.mask)) &&
      eq(Array.from(new Uint8Array(mem, w.syz_tone_ptr(), n)), Array.from(js.tone)) &&
      eq(Array.from(new Uint32Array(mem, w.syz_glyph_ptr(), n)), Array.from(js.glyph)) &&
      w.syz_fft_valid() === js.fft_valid && (js.fft_valid === 0 || w.syz_peak_bin() === js.peak_bin)) hsame++;
  else console.log(`  drift: host frame ${fw}x${fh} #${t}`);
}
CHECK(w.syz_run_frame(w.syz_max_w() + 2, 16, 100, 4000, 1) === -1, 'oversize frame refused (-1), no out-of-bounds write');
CHECK(hsame === hcases, `wasm == JS port on ${hsame}/${hcases} seeded random host-written frames (up to 160x96)`);
CHECK(same === cases, `wasm == JS port on ${same}/${cases} frame x param cases (mask, glyph, tone, spectrum, peak)`);
console.log(`wasm: ${pass + fail} checks, ${fail} failures`);
process.exit(fail ? 1 : 0);
