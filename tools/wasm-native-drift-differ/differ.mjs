#!/usr/bin/env node
// =============================================================================
// differ.mjs — wasm-native-drift-differ: the regression alarm for the shipped
// browser POC. Differential test of the native C fused pass (GOLDEN) against
// the docs/poc/syzygy.js port on a seeded fuzz suite of NV12 frames (dims,
// strides, thresholds, fft_row, content modes all varied). On any drift it
// reports the FIRST divergent output field (pipeline order: cols, rows, mask,
// glyph, tone, spec_re, spec_im, peak_bin, fft_valid), the index and both
// values, and a SHRUNK minimal reproducing input.
//
// Zero deps: node built-ins + the repo's C compiler. The port is loaded from
// its source text, so a perturbation (--perturb) is applied IN MEMORY only —
// the shipped docs/poc/syzygy.js is never written.
//
//   node tools/wasm-native-drift-differ/differ.mjs [--cases N] [--seed S]
//        [--sweep N] [--perturb ID] [--out repro.json] [--port path/to/syzygy.js]
//   node tools/wasm-native-drift-differ/selftest.mjs
// Exit 0 = byte-exact on every case; 1 = drift (repro printed).
// =============================================================================
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');
export const PORT = path.join(ROOT, 'docs/poc/syzygy.js');
export const FIELDS = ['cols', 'rows', 'mask', 'glyph', 'tone', 'spec_re', 'spec_im', 'peak_bin', 'fft_valid'];
export const GOLDEN = 0x6dbdd1a8;

// Planted drifts: one JS op each, with the output field a correct differ must
// name first. Used by the self-test to prove the alarm localizes, not just rings.
export const DRIFTS = [
  { id: 'D1', expect: 'mask', why: 'braille left-column compare > -> >=',
    find: 'if (cell[row][0] > threshold)', replace: 'if (cell[row][0] >= threshold)' },
  { id: 'D2', expect: 'glyph', why: 'flat-cell ramp divisor 255 -> 256',
    find: 'function syz_ramp_char_idx(luma) {\n    let idx = Math.floor((luma * 9) / 255);',
    replace: 'function syz_ramp_char_idx(luma) {\n    let idx = Math.floor((luma * 9) / 256);' },
  { id: 'D3', expect: 'tone', why: 'red chroma diff >> 14 -> >> 13 (feeds cell luma: tone is the first field it reaches)',
    find: 'const rd = (22971 * vv) >> 14;', replace: 'const rd = (22971 * vv) >> 13;' },
  { id: 'D4', expect: 'spec_re', why: 'FFT real-twiddle rounding constant 8192 -> 8191',
    find: 'const tr = ((re[m]*c + im[m]*s + 8192) >> 14)|0;', replace: 'const tr = ((re[m]*c + im[m]*s + 8191) >> 14)|0;' },
  { id: 'D6', expect: 'spec_im', why: 'FFT imaginary-twiddle rounding constant 8192 -> 8191',
    find: 'const ti = ((im[m]*c - re[m]*s + 8192) >> 14)|0;', replace: 'const ti = ((im[m]*c - re[m]*s + 8191) >> 14)|0;' },
  { id: 'D5', expect: 'peak_bin', why: 'spectral peak search stops at bin 7',
    find: 'for (let k = 1; k <= 8; k++) {', replace: 'for (let k = 1; k < 8; k++) {' },
];

// ---- deterministic PRNG (xorshift32) ----------------------------------------
export function rng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  return { next, int: (lo, hi) => lo + (next() % (hi - lo + 1)), pick: (a) => a[next() % a.length] };
}

// ---- implementations --------------------------------------------------------
let harnessBin = null;
export function buildHarness() {
  if (harnessBin) return harnessBin;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syz-differ-'));
  const bin = path.join(dir, 'native_harness');
  const cc = process.env.CC || 'cc';
  const r = spawnSync(cc, ['-std=c11', '-O2', '-Wall', '-Wextra', '-I', path.join(ROOT, 'include'),
    path.join(HERE, 'native_harness.c'), '-o', bin], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error('native harness build failed:\n' + r.stderr);
  process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
  return (harnessBin = bin);
}

const hex = (u8) => Buffer.from(u8.buffer, u8.byteOffset, u8.length).toString('hex');
const caseLine = (c) => [c.w, c.h, c.ys, c.uvs, c.bt, c.e2, c.row, hex(c.y) || '', hex(c.uv) || ''].join(' ');

// Run the golden C on a batch of cases in one process.
export function runNative(cases) {
  const r = spawnSync(buildHarness(), [], { input: cases.map(caseLine).join('\n') + '\n',
    encoding: 'utf8', maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error('native harness failed: ' + r.stderr);
  const lines = r.stdout.trim().split('\n');
  if (lines.length !== cases.length) throw new Error('native harness returned ' + lines.length + ' results');
  return lines.map((l) => JSON.parse(l));
}

// A persistent harness process: one case in, one JSON line out. The shrinker
// makes thousands of sequential evaluations; a spawn per eval is too slow.
export class NativeSession {
  constructor() {
    this.p = spawn(buildHarness(), [], { stdio: ['pipe', 'pipe', 'inherit'] });
    this.buf = ''; this.waiting = [];
    this.p.stdout.setEncoding('utf8');
    this.p.stdout.on('data', (s) => {
      this.buf += s;
      let k;
      while ((k = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, k); this.buf = this.buf.slice(k + 1);
        this.waiting.shift()(JSON.parse(line));
      }
    });
  }
  run(c) { return new Promise((res) => { this.waiting.push(res); this.p.stdin.write(caseLine(c) + '\n'); }); }
  close() { this.p.stdin.end(); }
}

const portCache = new Map();
export function portSource(portPath = PORT, drift = null) {
  let src = fs.readFileSync(portPath, 'utf8');
  if (drift) {
    const n = src.split(drift.find).length - 1;
    if (n !== 1) throw new Error(`drift ${drift.id}: find text occurs ${n}x in the port (need exactly 1)`);
    src = src.replace(drift.find, () => drift.replace);
  }
  return src;
}
export async function loadPort(portPath = PORT, drift = null) {
  const src = portSource(portPath, drift);
  if (!portCache.has(src))
    portCache.set(src, await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64')));
  return portCache.get(src);
}

export function runPort(mod, c) {
  const o = mod.syz_fused({ y: c.y, uv: c.uv, w: c.w, h: c.h, y_stride: c.ys, uv_stride: c.uvs },
                          { braille_thresh: c.bt, edge_thresh2: c.e2, fft_row: c.row });
  return { rc: 0, cols: o.cols, rows: o.rows, mask: Array.from(o.mask), glyph: Array.from(o.glyph),
           tone: Array.from(o.tone), spec_re: Array.from(o.spec_re), spec_im: Array.from(o.spec_im),
           peak_bin: o.peak_bin, fft_valid: o.fft_valid ? 1 : 0 };
}

// First divergence in pipeline field order, or null if byte-exact.
export function firstDiff(n, j) {
  for (const f of FIELDS) {
    const a = n[f], b = j[f];
    if (Array.isArray(a)) {
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) if (a[i] !== b[i]) return { field: f, index: i, native: a[i], port: b[i] };
    } else if (a !== b) return { field: f, index: null, native: a, port: b };
  }
  return null;
}

// ---- the fuzz suite ---------------------------------------------------------
export function goldenCase() {
  const w = 32, h = 16, y = new Uint8Array(32 * 16), uv = new Uint8Array(32 * 8);
  for (let r = 0; r < h; r++) for (let x = 0; x < w; x++) y[r * 32 + x] = (x + 2 * r) & 0xff;
  for (let r = 0; r < h / 2; r++) for (let x = 0; x < w / 2; x++) { uv[r * 32 + 2 * x] = (x * 32) & 0xff; uv[r * 32 + 2 * x + 1] = (r * 64) & 0xff; }
  return { tag: 'golden synth 32x16', w, h, ys: 32, uvs: 32, bt: 100, e2: 4000, row: 1, y, uv };
}

const MODES = ['noise', 'synth', 'extreme', 'gradient', 'flat', 'stripes'];
export function genCase(R, i) {
  const w = 2 * R.int(1, 40), h = 2 * R.int(2, 24);
  const ys = w + R.pick([0, 0, 1, 7, 16]), uvs = w + R.pick([0, 0, 2, 5, 16]);
  const rows = h >> 2, mode = R.pick(MODES);
  const y = new Uint8Array(ys * h), uv = new Uint8Array(uvs * (h >> 1));
  for (let k = 0; k < y.length; k++) y[k] = R.next() & 0xff;   // padding stays random:
  for (let k = 0; k < uv.length; k++) uv[k] = R.next() & 0xff; // it must be ignored
  const px = (r, x) => {
    switch (mode) {
      case 'noise': return R.next() & 0xff;
      case 'synth': return (x + 2 * r) & 0xff;
      case 'extreme': return ((x ^ r) & 1) ? 255 : 0;
      case 'gradient': return Math.min(255, (x * 7 + r * 3 + (R.next() & 7))) & 0xff;
      case 'flat': return 200;
      default: return (x & 2) ? 250 : 5;
    }
  };
  for (let r = 0; r < h; r++) for (let x = 0; x < w; x++) y[r * ys + x] = px(r, x);
  if (mode === 'synth')
    for (let r = 0; r < h >> 1; r++) for (let x = 0; x < w >> 1; x++) { uv[r * uvs + 2 * x] = (x * 32) & 0xff; uv[r * uvs + 2 * x + 1] = (r * 64) & 0xff; }
  if (mode === 'extreme')
    for (let r = 0; r < h >> 1; r++) for (let x = 0; x < w; x++) uv[r * uvs + x] = R.pick([0, 255]);
  const e2 = R.pick([0, -1, 4000, 4000, R.int(0, 2000), R.int(0, 200000), 1 << 30]);
  return { tag: `fuzz#${i} ${mode} ${w}x${h}`, w, h, ys, uvs, bt: R.int(0, 255), e2,
           row: R.int(0, rows + 1), y, uv };
}

// A 32x4 frame with neutral chroma whose fft_row-0 window is exactly `win`
// (neutral chroma => cell rgb = (l,l,l) => cell luma = l). Non-window luma is
// random, so mask/glyph still get exercised.
export function windowCase(win, tag, R) {
  const w = 32, h = 4, y = new Uint8Array(w * h), uv = new Uint8Array(w * 2).fill(128);
  for (let k = 0; k < y.length; k++) y[k] = R.next() & 0xff;
  for (let k = 0; k < 16; k++) y[1 * w + 2 * k] = win[k];
  return { tag, w, h, ys: w, uvs: w, bt: 100, e2: 4000, row: 0, y, uv };
}

// Half-LSB boundary witnesses: 16-sample windows on which a Q14 twiddle
// product lands exactly on the rounding midpoint (x = 8192 mod 16384) in the
// real (tr) or imaginary (ti) butterfly. Random frames hit this ~1 in 12k
// windows, so a sub-LSB rounding drift walks straight past a plain fuzz run
// (found by the planted-drift proof, D4). Pinned so the alarm always sees it.
export const FFT_WITNESSES = [
  { site: 'tr', win: [119, 50, 77, 78, 103, 72, 110, 105, 96, 1, 57, 47, 181, 63, 204, 197] },
  { site: 'tr', win: [54, 138, 203, 13, 48, 73, 67, 236, 28, 97, 8, 226, 108, 102, 13, 26] },
  { site: 'ti', win: [240, 2, 233, 48, 135, 151, 122, 42, 93, 111, 255, 37, 95, 136, 36, 95] },
  { site: 'ti', win: [24, 168, 175, 239, 248, 152, 39, 121, 37, 8, 84, 80, 73, 158, 80, 118] },
];

export function suite(n, seed, sweep = 0) {
  const R = rng(seed), out = [goldenCase()];
  FFT_WITNESSES.forEach((x, i) => out.push(windowCase(x.win, `fft-witness#${i} (${x.site} half-LSB)`, R)));
  for (let i = 0; i < n; i++) out.push(genCase(R, i));
  for (let i = 0; i < sweep; i++)
    out.push(windowCase(Array.from({ length: 16 }, () => R.next() & 0xff), `fft-sweep#${i}`, R));
  return out;
}

// ---- shrinking: smallest input that still drifts in the SAME field ---------
function crop(c, w, h) {
  const y = new Uint8Array(w * h), uv = new Uint8Array(w * (h >> 1));
  for (let r = 0; r < h; r++) for (let x = 0; x < w; x++) y[r * w + x] = c.y[r * c.ys + x];
  for (let r = 0; r < h >> 1; r++) for (let x = 0; x < w; x++) uv[r * w + x] = c.uv[r * c.uvs + x];
  return { ...c, w, h, ys: w, uvs: w, y, uv };
}

const PARAM_PREFS = [['row', [0]], ['e2', [4000, 0]], ['bt', [100, 0]]];

export async function shrink(c0, mod, field) {
  let evals = 0;
  const nat = new NativeSession();
  const drifts = async (c) => {
    evals++;
    const n = await nat.run(c);
    if (n.rc !== 0) return false;
    const d = firstDiff(n, runPort(mod, c));
    return !!d && d.field === field;
  };
  let c = crop(c0, c0.w, c0.h);          // strides -> minimal first
  if (!(await drifts(c))) c = c0;
  let progress = true;
  while (progress) {
    progress = false;
    // 1. dimensions
    for (const [w, h] of [[c.w >> 1, c.h], [c.w, c.h >> 1], [c.w - 2, c.h], [c.w, c.h - 2]]) {
      if (w < 2 || h < 4 || (w & 1) || (h & 1)) continue;
      const t = crop(c, w, h);
      if (await drifts(t)) { c = t; progress = true; break; }
    }
    if (progress) continue;
    // 2. parameters toward canonical values (the POC defaults first). A move
    //    is taken only to a strictly more preferred value, so this terminates.
    for (const [k, prefs] of PARAM_PREFS) {
      const rank = (x) => { const r = prefs.indexOf(x); return r < 0 ? Infinity : r; };
      const v = prefs.find((x) => rank(x) < rank(c[k]));
      if (v === undefined) continue;
      const t = { ...c, [k]: v };
      if (await drifts(t)) { c = t; progress = true; break; }
    }
    if (progress) continue;
    // 3. frame bytes: zero whole chunks, halving chunk size (ddmin-style)
    for (const plane of ['y', 'uv']) {
      for (let size = c[plane].length; size >= 1; size >>= 1) {
        for (let at = 0; at < c[plane].length; at += size) {
          const buf = c[plane].slice();
          let any = false;
          for (let k = at; k < Math.min(at + size, buf.length); k++) { if (buf[k]) any = true; buf[k] = 0; }
          if (!any) continue;
          const t = { ...c, [plane]: buf };
          if (await drifts(t)) { c = t; progress = true; }
        }
      }
    }
  }
  nat.close();
  return { case: c, evals };
}

export const reproJson = (c, d) => ({ w: c.w, h: c.h, y_stride: c.ys, uv_stride: c.uvs,
  params: { braille_thresh: c.bt, edge_thresh2: c.e2, fft_row: c.row },
  y_hex: hex(c.y), uv_hex: hex(c.uv), first_divergence: d });

// ---- the run ------------------------------------------------------------
export async function differ({ cases = 400, sweep = 2000, seed = 0x5eed, drift = null, portPath = PORT, log = console.log } = {}) {
  const mod = await loadPort(portPath, drift);
  const all = suite(cases, seed, sweep);
  const native = runNative(all);
  const digest = createHash('sha256');
  let valid = 0, skipped = 0, first = null;
  for (let i = 0; i < all.length; i++) {
    if (native[i].rc !== 0) { skipped++; continue; }
    valid++;
    digest.update(JSON.stringify(native[i]));
    const d = firstDiff(native[i], runPort(mod, all[i]));
    if (d && !first) first = { i, d };
  }
  const g = all[0];
  const goldenNative = mod.fnv1a_fused(native[0]) >>> 0, goldenPort = mod.fnv1a_fused(runPort(mod, g)) >>> 0;
  const res = { cases: all.length, valid, skipped, suiteDigest: digest.digest('hex'),
                goldenNative, goldenPort, drift: null };
  log(`drift-differ: ${all.length} cases (seed 0x${seed.toString(16)}), ${valid} valid, ${skipped} rejected by C (invalid input)`);
  log(`  golden 32x16 synth: native 0x${goldenNative.toString(16)}  port 0x${goldenPort.toString(16)}  (pinned 0x${GOLDEN.toString(16)})`);
  log(`  native output digest: ${res.suiteDigest}`);
  if (!first) { log('  PASS: port is byte-exact vs native on every case'); return res; }
  const c = all[first.i];
  log(`  DRIFT at case ${first.i} (${c.tag}): first divergent field '${first.d.field}'` +
      (first.d.index !== null ? `[${first.d.index}]` : '') + `  native=${first.d.native}  port=${first.d.port}`);
  const s = await shrink(c, mod, first.d.field);
  const n = runNative([s.case])[0], d2 = firstDiff(n, runPort(mod, s.case));
  res.drift = { at: first.i, tag: c.tag, first: first.d, minimal: reproJson(s.case, d2), evals: s.evals };
  log(`  minimal repro (${s.evals} evals): ${s.case.w}x${s.case.h} strides ${s.case.ys}/${s.case.uvs}` +
      ` bt=${s.case.bt} e2=${s.case.e2} fft_row=${s.case.row}; nonzero bytes y=${s.case.y.filter(Boolean).length}` +
      ` uv=${s.case.uv.filter(Boolean).length}`);
  log(`  minimal repro diverges at '${d2.field}'` + (d2.index !== null ? `[${d2.index}]` : '') +
      `: native=${d2.native} port=${d2.port}`);
  log(`  y=${hex(s.case.y)}\n  uv=${hex(s.case.uv)}`);
  return res;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const a = process.argv.slice(2), opt = (k, d) => (a.includes(k) ? a[a.indexOf(k) + 1] : d);
  const pid = opt('--perturb', null);
  const drift = pid ? DRIFTS.find((x) => x.id === pid) : null;
  if (pid && !drift) { console.error('unknown drift ' + pid + '; have ' + DRIFTS.map((x) => x.id)); process.exit(2); }
  if (drift) console.log(`PLANTED (in memory only): ${drift.id} ${drift.why}`);
  const res = await differ({ cases: +opt('--cases', 400), sweep: +opt('--sweep', 2000), seed: +opt('--seed', 0x5eed), drift,
                             portPath: path.resolve(opt('--port', PORT)) });
  const out = opt('--out', null);
  if (out && res.drift) fs.writeFileSync(out, JSON.stringify(res.drift.minimal, null, 1) + '\n');
  const goldenOk = res.goldenNative === GOLDEN && res.goldenPort === GOLDEN;
  if (!goldenOk) console.log('  GOLDEN MISMATCH');
  process.exit(res.drift || !goldenOk ? 1 : 0);
}
