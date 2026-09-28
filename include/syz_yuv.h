/* =============================================================================
 * syz_yuv.h — NV12 / YUV 4:2:0 -> luma + chroma cell ingest  [SHARD 0004]
 * -----------------------------------------------------------------------------
 * HASH MARK (read this by context):
 *   WHAT     : Ingests an NV12 frame (Y plane + interleaved UV plane, each with
 *              its own stride) into arena-resident buffers: a packed luma plane,
 *              de-interleaved U and V planes (2x2 luma -> 1 chroma), and a
 *              per-cell RGB buffer (one cell = 2x4 luma pixels, the braille
 *              cell of 0001). Includes a synthetic NV12 generator (no camera).
 *   STATE    : HEWN — functions now, covered by tests/test_yuv.c.
 *   RUNS     : syz_yuv_ingest(), syz_yuv_luma_at(), syz_yuv_luma_fn() (a
 *              syz_luma_fn for 0003), syz_yuv_chroma(), syz_yuv_synth().
 *              tests/test_yuv.c: see ledger m0010 (sh tests/run.sh).
 *   SHORTCUT : Synthetic frames only (no V4L2/WebRTC). NV12 only (no I420/
 *              NV21/10-bit). Even width/height required; cols=w/2, rows=h/4
 *              (trailing rows <4 dropped). Chroma is nearest (no bilinear
 *              upsample). Cell colour = seed's: luma of pixel (2tx, 4ty+1) plus
 *              BT.601 chroma diffs. Full-range Y/UV assumed (no 16..235 clamp).
 *   ASSUMES  : 0002 arena owns every buffer (no malloc; NULL on exhaustion,
 *              arena rolled back). Caller provides the NV12 source pointers.
 *              Luma is the shared syz_luma8 scale (>>8, SCARF-4); chroma uses
 *              the seed's >>14 coefficients — the >>14 belongs here, not luma.
 *   BETTER-WHEN: 0005 fuses ingest into the braille/glyph/FFT pass so a pixel
 *              is decoded and packed without this RAM round-trip; a real
 *              V4L2 / WebRTC source replaces syz_yuv_synth (blob:2588-2617).
 *   SEED     : docs/seed/blob.md 5814-5900 (fused yuv kernel; 22971/-5638/
 *              -11700/29032 >>14; uvOffset; centre-luma), 5541-5615, 2588-2617.
 *   NEXT     : 0005-fused (call syz_yuv_ingest per frame under
 *              syz_arena_mark/rollback; feed cell luma to 0001/0003 and a luma
 *              window to 0006), 0006 window feed via syz_yuv_luma_at.
 *
 * Pure integer, libc-free, FPU-free, header-only.
 * ========================================================================== */
#ifndef SYZ_YUV_H
#define SYZ_YUV_H

#include <stdint.h>
#include <stddef.h>
#include "syz_arena.h"
#include "syz_braille.h" /* syz_luma8 (shared BT.601 >>8 luma) */
#include "syz_glyph.h"   /* syz_luma_fn */

/* Borrowed view of a raw NV12 frame. Strides are in bytes. */
typedef struct {
    const uint8_t *y;      /* w x h luma, stride y_stride                   */
    const uint8_t *uv;     /* (w/2) x (h/2) interleaved U,V pairs; uv_stride
                              bytes per chroma row (>= w)                   */
    uint32_t w, h, y_stride, uv_stride;
} SyzNv12;

/* Ingested frame; every pointer lives inside the arena passed to ingest. */
typedef struct {
    uint32_t w, h;       /* luma size                                       */
    uint32_t cw, ch;     /* chroma size = w/2, h/2                          */
    uint32_t cols, rows; /* cell grid = w/2, h/4                            */
    uint8_t *luma;       /* w*h packed, stride w                            */
    uint8_t *u, *v;      /* cw*ch each, packed                              */
    uint8_t *rgb;        /* cols*rows*3 (r,g,b per cell)                    */
} SyzYuvFrame;

static inline int32_t syz_yuv_clamp8(int32_t v) { return v < 0 ? 0 : (v > 255 ? 255 : v); }

/* Seed chroma: 14-bit fixed-point BT.601 diffs added to luma. */
static inline void syz_yuv_chroma(uint8_t luma, uint8_t u, uint8_t v,
                                  uint8_t *r, uint8_t *g, uint8_t *b) {
    int32_t uu = (int32_t)u - 128, vv = (int32_t)v - 128;
    int32_t rd = (22971 * vv) >> 14;
    int32_t gd = (-5638 * uu - 11700 * vv) >> 14;
    int32_t bd = (29032 * uu) >> 14;
    *r = (uint8_t)syz_yuv_clamp8((int32_t)luma + rd);
    *g = (uint8_t)syz_yuv_clamp8((int32_t)luma + gd);
    *b = (uint8_t)syz_yuv_clamp8((int32_t)luma + bd);
}

/* Returns 0 on success, -1 on bad args / arena exhaustion (arena rolled back). */
static inline int syz_yuv_ingest(SyzArena *a, const SyzNv12 *src, SyzYuvFrame *out) {
    size_t mark, n_y, n_c, n_rgb;
    uint32_t x, y;
    if (!a || !src || !out || !src->y || !src->uv) return -1;
    if (src->w < 2 || src->h < 4 || (src->w & 1u) || (src->h & 1u)) return -1;
    if (src->y_stride < src->w || src->uv_stride < src->w) return -1;
    if (src->w > 65535u || src->h > 65535u) return -1; /* sizes fit 32 bits */
    out->w = src->w; out->h = src->h;
    out->cw = src->w >> 1; out->ch = src->h >> 1;
    out->cols = src->w >> 1; out->rows = src->h >> 2;
    n_y = (size_t)out->w * out->h;
    n_c = (size_t)out->cw * out->ch;
    n_rgb = (size_t)out->cols * out->rows * 3u;
    mark = syz_arena_mark(a);
    out->luma = (uint8_t *)syz_arena_alloc16(a, n_y);
    out->u    = (uint8_t *)syz_arena_alloc16(a, n_c);
    out->v    = (uint8_t *)syz_arena_alloc16(a, n_c);
    out->rgb  = (uint8_t *)syz_arena_alloc16(a, n_rgb);
    if (!out->luma || !out->u || !out->v || !out->rgb) {
        syz_arena_rollback(a, mark);
        return -1;
    }
    for (y = 0; y < out->h; y++)
        for (x = 0; x < out->w; x++)
            out->luma[(size_t)y * out->w + x] = src->y[(size_t)y * src->y_stride + x];
    for (y = 0; y < out->ch; y++)
        for (x = 0; x < out->cw; x++) {
            const uint8_t *p = &src->uv[(size_t)y * src->uv_stride + 2u * x];
            out->u[(size_t)y * out->cw + x] = p[0];
            out->v[(size_t)y * out->cw + x] = p[1];
        }
    for (y = 0; y < out->rows; y++)
        for (x = 0; x < out->cols; x++) {
            uint32_t bx = 2u * x, by = 4u * y;
            size_t ci = (size_t)(by >> 1) * out->cw + (bx >> 1);
            uint8_t l = out->luma[(size_t)(by + 1u) * out->w + bx]; /* seed centre luma */
            uint8_t *c = &out->rgb[((size_t)y * out->cols + x) * 3u];
            syz_yuv_chroma(l, out->u[ci], out->v[ci], &c[0], &c[1], &c[2]);
        }
    return 0;
}

/* Luma sampler; out of bounds reads 0 (matches syz_luma_fn contract). */
static inline uint8_t syz_yuv_luma_at(const SyzYuvFrame *f, int x, int y) {
    if (x < 0 || y < 0 || (uint32_t)x >= f->w || (uint32_t)y >= f->h) return 0;
    return f->luma[(size_t)y * f->w + (uint32_t)x];
}
/* syz_luma_fn adapter: ctx is a const SyzYuvFrame*. Drops into 0003. */
static inline uint8_t syz_yuv_luma_fn(int x, int y, void *ctx) {
    return syz_yuv_luma_at((const SyzYuvFrame *)ctx, x, y);
}

/* Synthetic NV12 test pattern, no camera needed. Known closed form:
 *   Y(x,y)          = (x + 2*y) & 0xFF
 *   U(cx,cy)        = (cx * 32) & 0xFF
 *   V(cx,cy)        = (cy * 64) & 0xFF
 * Caller supplies buffers sized y_stride*h and uv_stride*(h/2). */
static inline void syz_yuv_synth(uint8_t *y, uint8_t *uv, uint32_t w, uint32_t h,
                                 uint32_t y_stride, uint32_t uv_stride) {
    uint32_t x, r;
    for (r = 0; r < h; r++)
        for (x = 0; x < w; x++)
            y[(size_t)r * y_stride + x] = (uint8_t)((x + 2u * r) & 0xFFu);
    for (r = 0; r < (h >> 1); r++)
        for (x = 0; x < (w >> 1); x++) {
            uv[(size_t)r * uv_stride + 2u * x]      = (uint8_t)((x * 32u) & 0xFFu);
            uv[(size_t)r * uv_stride + 2u * x + 1u] = (uint8_t)((r * 64u) & 0xFFu);
        }
}

#endif /* SYZ_YUV_H */
