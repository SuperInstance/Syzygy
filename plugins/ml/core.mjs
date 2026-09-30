// =============================================================================
// core.mjs — shared plumbing for the ML projection plugins: RGB frames, box
// resampling, BT.601 luma (the same integer weights as syz_braille.h), RGB ->
// NV12 so frames can enter the byte-exact fused pass, a zero-dependency PNG
// encoder (for sending frames to a vision model), and a seeded PRNG.
//
// Unlike include/, this layer is NOT freestanding and NOT integer-only: it runs
// in Node, it may use floats, and it may call the network. The kernel's promises
// (I1/I2/I3) stop at the fused pass; everything here sits beside it.
// =============================================================================
import zlib from 'node:zlib';

// A frame is { w, h, data: Uint8Array(w*h*3) } in row-major RGB.
export function makeFrame(w, h, fill = [0, 0, 0]) {
  const data = new Uint8Array(w * h * 3);
  for (let i = 0; i < w * h; i++) { data[3*i] = fill[0]; data[3*i+1] = fill[1]; data[3*i+2] = fill[2]; }
  return { w, h, data };
}

export function cloneFrame(f) { return { w: f.w, h: f.h, data: new Uint8Array(f.data) }; }

// BT.601 integer luma, identical to syz_luma8.
export const luma8 = (r, g, b) => ((r * 77 + g * 150 + b * 29) >>> 8) & 0xff;

export function lumaPlane(f) {
  const L = new Uint8Array(f.w * f.h);
  for (let i = 0; i < f.w * f.h; i++) L[i] = luma8(f.data[3*i], f.data[3*i+1], f.data[3*i+2]);
  return L;
}

// Box-average an RGB frame to (W, H). Exact area weights, so downsampling to any
// size (not only integer factors) keeps mean brightness.
export function resize(f, W, H) {
  const out = new Uint8Array(W * H * 3);
  const sx = f.w / W, sy = f.h / H;
  for (let Y = 0; Y < H; Y++) {
    const y0 = Math.floor(Y * sy), y1 = Math.max(y0 + 1, Math.floor((Y + 1) * sy));
    for (let X = 0; X < W; X++) {
      const x0 = Math.floor(X * sx), x1 = Math.max(x0 + 1, Math.floor((X + 1) * sx));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1 && y < f.h; y++)
        for (let x = x0; x < x1 && x < f.w; x++) {
          const o = 3 * (y * f.w + x); r += f.data[o]; g += f.data[o+1]; b += f.data[o+2]; n++;
        }
      const o = 3 * (Y * W + X);
      out[o] = Math.round(r / n); out[o+1] = Math.round(g / n); out[o+2] = Math.round(b / n);
    }
  }
  return { w: W, h: H, data: out };
}

// Box-average a luma plane to a (W, H) float grid in [0,255].
export function lumaGrid(f, W, H) {
  const r = resize(f, W, H), g = new Float32Array(W * H);
  for (let i = 0; i < W * H; i++) g[i] = luma8(r.data[3*i], r.data[3*i+1], r.data[3*i+2]);
  return g;
}

// RGB -> NV12 (full-res Y, 2x2-subsampled interleaved UV), inverse of the
// fused pass's syz_yuv_chroma to within integer rounding. w, h must be even.
export function toNV12(f) {
  const { w, h } = f, Y = new Uint8Array(w * h), UV = new Uint8Array(w * (h >> 1));
  const clamp = (v) => v < 0 ? 0 : v > 255 ? 255 : v;
  for (let i = 0; i < w * h; i++) Y[i] = luma8(f.data[3*i], f.data[3*i+1], f.data[3*i+2]);
  for (let y = 0; y < h; y += 2)
    for (let x = 0; x < w; x += 2) {
      let r = 0, g = 0, b = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
        const o = 3 * ((y + dy) * w + x + dx); r += f.data[o]; g += f.data[o+1]; b += f.data[o+2];
      }
      r /= 4; g /= 4; b /= 4;
      const l = (r * 77 + g * 150 + b * 29) / 256;
      UV[(y >> 1) * w + x] = clamp(Math.round(128 + (b - l) / 1.772));
      UV[(y >> 1) * w + x + 1] = clamp(Math.round(128 + (r - l) / 1.402));
    }
  return { y: Y, uv: UV, w, h, y_stride: w, uv_stride: w };
}

// ---- PNG encoder (RGB8, no deps) --------------------------------------------
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePNG(f) {
  const raw = Buffer.alloc((f.w * 3 + 1) * f.h);
  for (let y = 0; y < f.h; y++) {
    raw[y * (f.w * 3 + 1)] = 0;
    Buffer.from(f.data.buffer, f.data.byteOffset + y * f.w * 3, f.w * 3).copy(raw, y * (f.w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(f.w, 0); ihdr.writeUInt32BE(f.h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
export const pngDataURL = (f) => 'data:image/png;base64,' + encodePNG(f).toString('base64');

// ---- deterministic PRNG (xorshift32, same as the drift differ) --------------
export function rng(seed) {
  let s = (seed >>> 0) || 0x9e3779b9;
  const next = () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s; };
  return { next, float: () => next() / 4294967296, int: (lo, hi) => lo + (next() % (hi - lo + 1)),
           pick: (a) => a[next() % a.length] };
}

export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (const ch of Buffer.from(str, 'utf8')) { h ^= ch; h = Math.imul(h, 0x01000193) >>> 0; }
  return h >>> 0;
}
export const hex32 = (h) => '0x' + (h >>> 0).toString(16).padStart(8, '0');
