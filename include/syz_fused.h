/* =============================================================================
 * syz_fused.h — the fused single pass (the syzygy)  [SHARD 0005, KEYSTONE]
 * -----------------------------------------------------------------------------
 * HASH MARK (read this by context):
 *   WHAT     : ONE call, Read(NV12) -> [ingest · glyph/edge · STE argmax ·
 *              Braille pack · 16-pt FFT · spectral-peak argmax] -> Write(cells
 *              + spectrum). One per-cell loop holds the 8 luma taps, the cell
 *              RGB, the mask, the glyph and the token in locals; each output
 *              byte is stored once. Per-frame scratch is arena mark/rollback.
 *   STATE    : HEWN — invariant I2 witnessed by tests/test_fused.c: the fused
 *              output is BYTE-IDENTICAL to the composed reference (the same
 *              frame run through 0004/0003/0001/0006 as separate staged
 *              passes). Fused == composed is what makes I2 a fact, not a claim.
 *   RUNS     : syz_fused(arena, nv12, params, out). Outputs (caller-owned, so
 *              they survive the per-frame rollback): mask[] (0001), glyph[]
 *              (0003 Sobel/ramp select, Unicode scalar), tone[] (STE argmax
 *              ramp char), spec_re/im[16] (0006) + peak_bin. After return the
 *              arena offset == its pre-call mark (I1). tests/test_fused.c.
 *   SHORTCUT : (1) Ingest (0004) is REUSED, not inlined, so the NV12 -> luma/
 *              rgb staging planes still exist in the arena for the frame's
 *              lifetime: the "one read" is honest only at the cell loop, not
 *              from raw NV12. (2) "Register-resident" is a property of the
 *              loop's shape, checked here by output equality, NOT proven from C
 *              (the compiler owns register allocation). (3) Inner-loop calls
 *              to 0003/0001 are static-inline; the sampler is a function
 *              pointer the compiler may or may not devirtualize. (4) Static
 *              4x4 basis (via 0007 syz_ste_select4); only columns 0,1 are scored, as the
 *              seed's fused kernel does. (5) The FFT window is ONE cell row
 *              (first 16 cells); needs cols >= 16 else fft_valid = 0.
 *   ASSUMES  : 0002 arena (scratch); 0004 syz_yuv_ingest (+ luma_fn); 0003
 *              syz_glyph_select; 0001 syz_braille_pack/syz_luma8; 0006
 *              syz_fft16 (inputs <= 4095: cell luma <= 255 satisfies it).
 *   BETTER-WHEN: A perf-counter / instruction-count / disassembly witness
 *              (perf stat loads+stores per cell, or objdump showing no spills
 *              in the cell loop) turns "register-resident" from output-equal
 *              into proven; ingest is inlined into the loop (raw NV12 -> cell
 *              with no staging plane); SIMD lane kernels (blob:3294-3370);
 *              0007 basis becomes learnable; the mask streams straight to the
 *              0008 wire buffer.
 *   SEED     : docs/seed/blob.md 8324-8420 (chiaroscuro_fused_ste_pipeline),
 *              3384-3536 (fused synergy kernel), 3312-3316, 8171-8239 (basis).
 *   NEXT     : 0007 (learnable basis into the argmax slot), 0008 (stream the
 *              packed cells to the wire), and the perf-counter witness above.
 *
 * SCARF-3 corrected forms used: 4x4 basis [4][4] (blob:8184); no scalar-indexed
 * kernel weights (the 3x3 convolution is dropped: the 0004 luma is the source).
 * Pure integer, libc-free, FPU-free, no malloc, header-only.
 * ========================================================================== */
#ifndef SYZ_FUSED_H
#define SYZ_FUSED_H
#include <stdint.h>
#include <stddef.h>
#include "syz_arena.h"
#include "syz_yuv.h"
#include "syz_glyph.h"
#include "syz_braille.h"
#include "syz_fft.h"
#include "syz_ste.h"

/* Basis + argmax now live in 0007 (syz_ste.h); alias kept for callers. */
#define SYZ_FUSED_BASIS SYZ_STE_BASIS

typedef struct {
    uint8_t braille_thresh; /* 0001 threshold                          */
    int64_t edge_thresh2;   /* 0003 squared edge-magnitude threshold   */
    uint32_t fft_row;       /* cell row whose first 16 cells feed 0006 */
} SyzFusedParams;

typedef struct {
    uint32_t cols, rows;    /* filled by syz_fused                     */
    size_t   cap;           /* caller: capacity of mask/glyph/tone     */
    uint8_t  *mask;         /* cols*rows Braille masks (0001)          */
    uint32_t *glyph;        /* cols*rows glyph scalars (0003)          */
    uint8_t  *tone;         /* cols*rows STE ramp chars                */
    int32_t  spec_re[16], spec_im[16];
    uint32_t peak_bin;      /* argmax_{k=1..8} |X_k|^2 (0 if all zero) */
    int      fft_valid;     /* 1 iff cols >= 16 and fft_row < rows     */
} SyzFusedOut;

/* Straight-through argmax token (ramp char) for one cell: shared by the pass. */
static inline uint8_t syz_fused_tone(uint8_t luma, uint8_t g) {
    int32_t feat[4]; uint32_t sel, idx;
    feat[0] = luma; feat[1] = g; feat[2] = 0; feat[3] = 0; /* cols 0,1 scored */
    sel = syz_ste_select4(feat, SYZ_STE_BASIS);            /* 0007 */
    idx = ((uint32_t)luma * 9u) / 255u + sel;
    if (idx > 9u) idx = 9u;
    return (uint8_t)SYZ_RAMP[idx];
}

/* Spectral peak: argmax over bins 1..8 of re^2+im^2 (first max wins). */
static inline uint32_t syz_fused_peak(const int32_t re[16], const int32_t im[16]) {
    uint32_t k, best = 0; int64_t bm = 0;
    for (k = 1; k <= 8; k++) {
        int64_t m = (int64_t)re[k] * re[k] + (int64_t)im[k] * im[k];
        if (m > bm) { bm = m; best = k; }
    }
    return best;
}

/* 0 on success; -1 bad args / arena exhausted / out too small. The arena is
 * always returned to its pre-call mark (I1), success or failure. */
static inline int syz_fused(SyzArena *a, const SyzNv12 *src,
                            const SyzFusedParams *p, SyzFusedOut *out) {
    size_t mark;
    SyzYuvFrame f;
    uint32_t cx, cy, i, nfft = 0;
    int32_t re[16], im[16];
    if (!a || !src || !p || !out || !out->mask || !out->glyph || !out->tone) return -1;
    mark = syz_arena_mark(a);
    if (syz_yuv_ingest(a, src, &f) != 0) { syz_arena_rollback(a, mark); return -1; }
    if ((size_t)f.cols * f.rows > out->cap) { syz_arena_rollback(a, mark); return -1; }
    out->cols = f.cols; out->rows = f.rows;
    out->fft_valid = (f.cols >= 16 && p->fft_row < f.rows);
    for (i = 0; i < 16; i++) { re[i] = 0; im[i] = 0; }

    for (cy = 0; cy < f.rows; cy++) {
        for (cx = 0; cx < f.cols; cx++) {
            uint32_t bx = 2u * cx, by = 4u * cy;
            size_t ci = (size_t)cy * f.cols + cx;
            const uint8_t *c = &f.rgb[ci * 3u];
            uint8_t l = syz_luma8(c[0], c[1], c[2]);        /* cell luma (regs) */
            uint8_t cell[4][2];
            cell[0][0] = syz_yuv_luma_at(&f, (int)bx,      (int)by);
            cell[0][1] = syz_yuv_luma_at(&f, (int)bx + 1,  (int)by);
            cell[1][0] = syz_yuv_luma_at(&f, (int)bx,      (int)by + 1);
            cell[1][1] = syz_yuv_luma_at(&f, (int)bx + 1,  (int)by + 1);
            cell[2][0] = syz_yuv_luma_at(&f, (int)bx,      (int)by + 2);
            cell[2][1] = syz_yuv_luma_at(&f, (int)bx + 1,  (int)by + 2);
            cell[3][0] = syz_yuv_luma_at(&f, (int)bx,      (int)by + 3);
            cell[3][1] = syz_yuv_luma_at(&f, (int)bx + 1,  (int)by + 3);
            out->mask[ci]  = syz_braille_pack(cell, p->braille_thresh);
            out->glyph[ci] = syz_glyph_select(syz_yuv_luma_fn, &f, (int)bx, (int)by + 1,
                                              p->edge_thresh2);
            out->tone[ci]  = syz_fused_tone(l, c[1]);
            if (out->fft_valid && cy == p->fft_row && nfft < 16) { re[nfft] = (int32_t)l; nfft++; }
        }
    }
    if (out->fft_valid) {
        syz_fft16(re, im);
        out->peak_bin = syz_fused_peak(re, im);
    } else {
        out->peak_bin = 0;
    }
    for (i = 0; i < 16; i++) { out->spec_re[i] = re[i]; out->spec_im[i] = im[i]; }
    syz_arena_rollback(a, mark);
    return 0;
}
#endif /* SYZ_FUSED_H */
