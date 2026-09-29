"use strict";
// Syzygy fused-pass JS port — byte-exact integer reimplementation of the 8 C shards.
// All arithmetic mirrors the C: signed 32-bit integers, >>0 / |0 for truncation,
// Int32Array for array storage. No floats where the C uses integers.

// ─── syz_braille.h ───────────────────────────────────────────────────────────
function syz_luma8(r, g, b) {
    return ((r * 77 + g * 150 + b * 29) >>> 8) & 0xFF;
}

const BRAILLE_LEFT  = [0, 1, 2, 6];
const BRAILLE_RIGHT = [3, 4, 5, 7];

function syz_braille_pack(cell, threshold) {
    let mask = 0;
    for (let row = 0; row < 4; row++) {
        if (cell[row][0] > threshold) mask |= (1 << BRAILLE_LEFT[row]);
        if (cell[row][1] > threshold) mask |= (1 << BRAILLE_RIGHT[row]);
    }
    return mask & 0xFF;
}

// ─── syz_glyph.h ─────────────────────────────────────────────────────────────
const SYZ_GLYPH_HORIZ  = 0x2500;
const SYZ_GLYPH_VERT   = 0x2502;
const SYZ_GLYPH_SLASH  = 0x2571;
const SYZ_GLYPH_BSLASH = 0x2572;
const SYZ_RAMP = " .:-=+*#%@";

function syz_ramp_char(luma) {
    let idx = Math.floor((luma * 9) / 255);
    if (idx > 9) idx = 9;
    return SYZ_RAMP[idx];
}

function syz_sobel_gx(L, x, y) {
    return -L(x-1,y-1) + L(x+1,y-1)
           -2*L(x-1,y) + 2*L(x+1,y)
           -L(x-1,y+1) + L(x+1,y+1);
}

function syz_sobel_gy(L, x, y) {
    return -L(x-1,y-1) - 2*L(x,y-1) - L(x+1,y-1)
           +L(x-1,y+1) + 2*L(x,y+1) + L(x+1,y+1);
}

function syz_glyph_direction(gx, gy) {
    const ax = Math.abs(gx), ay = Math.abs(gy);
    const ay_s = ay * 10000;
    if (ay_s < ax * 4142)  return SYZ_GLYPH_HORIZ;
    if (ay_s > ax * 24142) return SYZ_GLYPH_VERT;
    let gx2 = gx, gy2 = gy;
    if (gx2 < 0) gy2 = -gy2;
    return gy2 >= 0 ? SYZ_GLYPH_SLASH : SYZ_GLYPH_BSLASH;
}

function syz_glyph_select(L, x, y, thresh2) {
    const gx = syz_sobel_gx(L, x, y);
    const gy = syz_sobel_gy(L, x, y);
    const mag2 = gx * gx + gy * gy;   // stays in safe int range for 8-bit luma
    if (mag2 > thresh2) return syz_glyph_direction(gx, gy);
    return SYZ_RAMP.charCodeAt(syz_ramp_char_idx(L(x, y)));
}

function syz_ramp_char_idx(luma) {
    let idx = Math.floor((luma * 9) / 255);
    if (idx > 9) idx = 9;
    return idx;
}

// ─── syz_ste.h ────────────────────────────────────────────────────────────────
// Seed static basis (blob:8184, SCARF-3 corrected [4][4]).
const SYZ_STE_BASIS = [
    [ 32,  64,  64,  32],
    [ 64, -32, -32,  64],
    [ 16,  96,  96,  16],
    [-64,  12,  12, -64]
];

function syz_ste_select4(feat) {
    // feat[4], basis[4][4]. First maximum wins (strict '>').
    let best = 0, bestScore = 0;
    for (let i = 0; i < 4; i++) {
        let s = 0;
        for (let j = 0; j < 4; j++) s += feat[j] * SYZ_STE_BASIS[i][j];
        if (i === 0 || s > bestScore) { bestScore = s; best = i; }
    }
    return best;
}

function syz_fused_tone(luma, g) {
    const feat = [luma, g, 0, 0];
    const sel = syz_ste_select4(feat);
    let idx = Math.floor((luma * 9) / 255) + sel;
    if (idx > 9) idx = 9;
    return SYZ_RAMP.charCodeAt(idx);
}

// ─── syz_fft.h ────────────────────────────────────────────────────────────────
const SYZ_SIN_TABLE = new Int32Array([
    0, 6270, 11585, 15137, 16384, 15137, 11585, 6270,
    0, -6270, -11585, -15137, -16384, -15137, -11585, -6270
]);

function syz_fft16(re, im) {
    // 1. bit-reversal
    let j = 0;
    for (let i = 0; i < 15; i++) {
        if (i < j) {
            let t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
        let k = 8;
        while (k <= j) { j -= k; k >>= 1; }
        j += k;
    }
    // 2. butterflies
    for (let step = 1; step < 16; step <<= 1) {
        const jump  = step << 1;
        const delta = 16 / jump;
        for (let g = 0; g < step; g++) {
            const idx = (g * delta) & 15;
            const s = SYZ_SIN_TABLE[idx];
            const c = SYZ_SIN_TABLE[(idx + 4) & 15];
            for (let p = g; p < 16; p += jump) {
                const m = p + step;
                // Q14 multiply + round: (x * y + 2^13) >> 14, kept as int32
                const tr = ((re[m]*c + im[m]*s + 8192) >> 14)|0;
                const ti = ((im[m]*c - re[m]*s + 8192) >> 14)|0;
                re[m] = (re[p] - tr)|0;  im[m] = (im[p] - ti)|0;
                re[p] = (re[p] + tr)|0;  im[p] = (im[p] + ti)|0;
            }
        }
    }
}

function syz_fused_peak(re, im) {
    let best = 0;
    let bm = 0;  // BigInt not needed: max re/im ~ 16*255 = 4080, sq = 16644600 < 2^53
    for (let k = 1; k <= 8; k++) {
        const m = re[k]*re[k] + im[k]*im[k];
        if (m > bm) { bm = m; best = k; }
    }
    return best;
}

// ─── syz_yuv.h ────────────────────────────────────────────────────────────────
function syz_yuv_clamp8(v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

function syz_yuv_chroma(luma, u, v) {
    const uu = u - 128, vv = v - 128;
    const rd = (22971 * vv) >> 14;
    const gd = ((-5638 * uu - 11700 * vv)) >> 14;
    const bd = (29032 * uu) >> 14;
    return [
        syz_yuv_clamp8((luma + rd)|0),
        syz_yuv_clamp8((luma + gd)|0),
        syz_yuv_clamp8((luma + bd)|0)
    ];
}

function syz_yuv_synth(w, h, y_stride, uv_stride) {
    const yBuf  = new Uint8Array(y_stride  * h);
    const uvBuf = new Uint8Array(uv_stride * (h >> 1));
    for (let r = 0; r < h; r++)
        for (let x = 0; x < w; x++)
            yBuf[r * y_stride + x] = (x + 2 * r) & 0xFF;
    for (let r = 0; r < (h >> 1); r++)
        for (let x = 0; x < (w >> 1); x++) {
            uvBuf[r * uv_stride + 2*x]     = (x * 32) & 0xFF;
            uvBuf[r * uv_stride + 2*x + 1] = (r * 64) & 0xFF;
        }
    return { y: yBuf, uv: uvBuf, w, h, y_stride, uv_stride };
}

function syz_yuv_ingest(src) {
    const { y, uv, w, h, y_stride, uv_stride } = src;
    const cols = w >> 1, rows = h >> 2;
    const cw   = w >> 1, ch   = h >> 1;

    // packed luma
    const luma = new Uint8Array(w * h);
    for (let r = 0; r < h; r++)
        for (let x = 0; x < w; x++)
            luma[r * w + x] = y[r * y_stride + x];

    // de-interleaved chroma
    const U = new Uint8Array(cw * ch);
    const V = new Uint8Array(cw * ch);
    for (let r = 0; r < ch; r++)
        for (let x = 0; x < cw; x++) {
            U[r * cw + x] = uv[r * uv_stride + 2*x];
            V[r * cw + x] = uv[r * uv_stride + 2*x + 1];
        }

    // per-cell RGB (seed: centre luma = luma[(4y+1)*w + 2x])
    const rgb = new Uint8Array(cols * rows * 3);
    for (let cy = 0; cy < rows; cy++)
        for (let cx = 0; cx < cols; cx++) {
            const bx = 2 * cx, by = 4 * cy;
            const ci = (by >> 1) * cw + (bx >> 1);
            const l  = luma[(by + 1) * w + bx];
            const [r, g, b] = syz_yuv_chroma(l, U[ci], V[ci]);
            const off = (cy * cols + cx) * 3;
            rgb[off] = r; rgb[off+1] = g; rgb[off+2] = b;
        }

    return { w, h, cw, ch, cols, rows, luma, U, V, rgb };
}

// ─── syz_fused.h — main pass ──────────────────────────────────────────────────
function syz_fused(src, params) {
    const { braille_thresh, edge_thresh2, fft_row } = params;
    const f = syz_yuv_ingest(src);
    const { cols, rows, luma, rgb } = f;
    const n = cols * rows;

    const mask  = new Uint8Array(n);
    const glyph = new Uint32Array(n);
    const tone  = new Uint8Array(n);

    // luma sampler (inline; ctx = f)
    function L(x, y) {
        if (x < 0 || y < 0 || x >= f.w || y >= f.h) return 0;
        return f.luma[y * f.w + x];
    }

    const fft_valid = (cols >= 16 && fft_row < rows) ? 1 : 0;
    const re = new Int32Array(16);
    const im = new Int32Array(16);
    let nfft = 0;

    for (let cy = 0; cy < rows; cy++) {
        for (let cx = 0; cx < cols; cx++) {
            const bx = 2 * cx, by = 4 * cy;
            const ci  = cy * cols + cx;
            const off = ci * 3;
            const r = rgb[off], g = rgb[off+1], b = rgb[off+2];
            const l = syz_luma8(r, g, b);

            // 0001: braille pack
            const cell = [
                [L(bx,   by),   L(bx+1, by)],
                [L(bx,   by+1), L(bx+1, by+1)],
                [L(bx,   by+2), L(bx+1, by+2)],
                [L(bx,   by+3), L(bx+1, by+3)]
            ];
            mask[ci] = syz_braille_pack(cell, braille_thresh);

            // 0003: glyph select — Sobel at (2cx, 4cy+1)
            glyph[ci] = syz_glyph_select(L, bx, by + 1, edge_thresh2);

            // tone
            tone[ci] = syz_fused_tone(l, g);

            // FFT window
            if (fft_valid && cy === fft_row && nfft < 16) {
                re[nfft] = l; nfft++;
            }
        }
    }

    if (fft_valid) syz_fft16(re, im);
    const peak_bin = fft_valid ? syz_fused_peak(re, im) : 0;

    return { cols, rows, mask, glyph, tone,
             spec_re: Array.from(re), spec_im: Array.from(im),
             peak_bin, fft_valid };
}

// ─── Golden FNV-1a hash (matches C test) ─────────────────────────────────────
function fnv1a_fused(out) {
    const { mask, tone, spec_re, spec_im } = out;
    const n = mask.length;
    let h = 2166136261;
    for (let i = 0; i < n; i++) {
        h = Math.imul(h ^ mask[i], 16777619) >>> 0;
        h = Math.imul(h ^ tone[i], 16777619) >>> 0;
    }
    for (let i = 0; i < 16; i++) {
        h = Math.imul(h ^ (spec_re[i] >>> 0), 16777619) >>> 0;
        h = Math.imul(h ^ (spec_im[i] >>> 0), 16777619) >>> 0;
    }
    return h;
}

// ─── Reference vectors captured from C (32x16 synth, thresh=100, edge=4000, fft_row=1) ──
const REF = {
    cols: 16, rows: 4,
    mask: [
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00,
        0x00,0x00,0x00,0x00,0x00,0x00,0x00,0x00
    ],
    tone: [
        0x3d,0x3d,0x3d,0x3d,0x3d,0x3d,0x3d,0x3d,
        0x2b,0x3d,0x3d,0x3d,0x3d,0x3d,0x3d,0x3d,
        0x2d,0x2d,0x3a,0x3a,0x3a,0x20,0x2e,0x3a,
        0x2d,0x2d,0x2d,0x2d,0x2d,0x2d,0x2e,0x3a,
        0x2b,0x3d,0x3d,0x3d,0x3d,0x3d,0x3d,0x3d,
        0x2b,0x2b,0x2b,0x3d,0x3d,0x3d,0x2b,0x2b,
        0x2d,0x2d,0x2d,0x2d,0x2d,0x2d,0x2e,0x3a,
        0x3d,0x3d,0x2d,0x2d,0x2d,0x2d,0x2d,0x2e
    ],
    glyph: [
        32,32,32,32,32,32,32,32,32,32,32,32,32,32,46,46,
        32,32,32,32,32,32,32,32,32,32,46,46,46,46,46,46,
        9472,32,32,32,32,32,46,46,46,46,46,46,46,46,46,46,
        9472,32,46,46,46,46,46,46,46,46,46,46,46,46,46,46
    ],
    spec_re: [505,-17,53,-19,12,-11,7,-9,7,-9,7,-11,12,-19,53,-17],
    spec_im: [0,74,-10,16,-5,6,2,0,0,0,-2,-6,5,-16,10,-74],
    peak_bin: 1,
    fft_valid: 1,
    golden: 0x6dbdd1a8
};

function syz_braille_codepoint(mask) { return 0x2800 + mask; }
export { syz_fused, syz_yuv_synth, fnv1a_fused, REF, SYZ_RAMP, syz_braille_codepoint };
