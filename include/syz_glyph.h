/* =============================================================================
 * syz_glyph.h — bivariate glyph / edge selector  [SHARD 0003]
 * -----------------------------------------------------------------------------
 * HASH MARK (read this by context):
 *   WHAT     : Chooses a glyph for a cell from two axes at once (bivariate):
 *              edge DIRECTION picks a line glyph, flat luminance picks a tone
 *              ramp char. Integer Sobel; no atan2, no sqrt, no FPU.
 *   STATE    : HEWN — functions now, covered by tests/test_braille.c.
 *   RUNS     : syz_sobel_gx/gy(), syz_edge_mag2(), syz_glyph_select().
 *   SHORTCUT : Fixed 3x3 Sobel weights and a fixed 10-step ramp, exactly as the
 *              seed draft. Direction is quantized to 4 line glyphs.
 *   ASSUMES  : Caller provides a luminance sampler (a function of x,y) so this
 *              shard stays free of any frame/layout decision (that belongs to
 *              the fused pass, 0005). Out-of-bounds samples read as 0.
 *   BETTER-WHEN: The learnable straight-through tokenizer replaces the fixed
 *              Sobel + ramp (seed blob:8171-8239 chiaroscuro_ste.h is the
 *              real-now static version; blob:8080-8145 is the aspirational
 *              trainable version). Also better fused into one register pass
 *              with 0001 (braille) and the FFT (0006) — see 0005-fused.
 *   SEED     : docs/seed/blob.md lines 862-921 (JS bivariate engine),
 *              8013-8021 (integer luminance + gradient), 8184-8239 (STE).
 *   NEXT     : 0005-fused (interleave this with braille + fft in one pass),
 *              0007-tokenizer (swap fixed weights for a learnable basis).
 *
 * Reproduces the seed's angle windows exactly, using integer tangent
 * comparisons instead of atan2:
 *   ratio = |gy| / |gx|
 *   ratio <  tan(22.5) ~ 0.4142  -> horizontal  U+2500  '-'
 *   ratio >  tan(67.5) ~ 2.4142  -> vertical    U+2502  '|'
 *   otherwise, fold to gx>=0; gy>=0 -> U+2571 '/' ; gy<0 -> U+2572 '\'
 * ========================================================================== */
#ifndef SYZ_GLYPH_H
#define SYZ_GLYPH_H

#include <stdint.h>
#include "syz_braille.h" /* for syz_luma8 */

/* Unicode scalars for the four directional line glyphs. */
#define SYZ_GLYPH_HORIZ  0x2500u /* ─ */
#define SYZ_GLYPH_VERT   0x2502u /* │ */
#define SYZ_GLYPH_SLASH  0x2571u /* ╱ */
#define SYZ_GLYPH_BSLASH 0x2572u /* ╲ */

/* The 10-step density ramp (seed: " .:-=+*#%@"). Index 0 = darkest. */
static const char SYZ_RAMP[11] = " .:-=+*#%@";

/* A luminance sampler: returns luma [0,255] at grid (x,y); OOB -> 0.
 * Kept as a callback so this shard makes no assumption about frame layout. */
typedef uint8_t (*syz_luma_fn)(int x, int y, void *ctx);

/* Horizontal Sobel gradient (integer). */
static inline int32_t syz_sobel_gx(syz_luma_fn L, void *ctx, int x, int y) {
    return  -1 * L(x-1, y-1, ctx) + 1 * L(x+1, y-1, ctx)
            -2 * L(x-1, y,   ctx) + 2 * L(x+1, y,   ctx)
            -1 * L(x-1, y+1, ctx) + 1 * L(x+1, y+1, ctx);
}

/* Vertical Sobel gradient (integer). */
static inline int32_t syz_sobel_gy(syz_luma_fn L, void *ctx, int x, int y) {
    return  -1 * L(x-1, y-1, ctx) - 2 * L(x, y-1, ctx) - 1 * L(x+1, y-1, ctx)
            +1 * L(x-1, y+1, ctx) + 2 * L(x, y+1, ctx) + 1 * L(x+1, y+1, ctx);
}

/* Squared edge magnitude, so callers compare against a squared threshold and
 * never need sqrt. */
static inline int64_t syz_edge_mag2(int32_t gx, int32_t gy) {
    return (int64_t)gx * gx + (int64_t)gy * gy;
}

/* Ramp char for a flat (non-edge) cell, from luminance. 10-step ramp. */
static inline char syz_ramp_char(uint8_t luma) {
    /* idx = luma * 9 / 255, integer, clamped to [0,9]. */
    uint32_t idx = ((uint32_t)luma * 9u) / 255u;
    if (idx > 9u) idx = 9u;
    return SYZ_RAMP[idx];
}

/* Classify a gradient (gx,gy) to one of the four directional glyph scalars.
 * Pure integer; reproduces the seed's atan2 window mapping. */
static inline uint32_t syz_glyph_direction(int32_t gx, int32_t gy) {
    int32_t ax = gx < 0 ? -gx : gx;
    int32_t ay = gy < 0 ? -gy : gy;
    /* ratio = ay/ax; compare with tan(22.5) and tan(67.5) via scaled ints.
     * tan(22.5) ~ 0.41421 -> 4142/10000 ; tan(67.5) ~ 2.41421 -> 24142/10000 */
    int64_t ay_s = (int64_t)ay * 10000;
    if (ay_s < (int64_t)ax * 4142)  return SYZ_GLYPH_HORIZ;
    if (ay_s > (int64_t)ax * 24142) return SYZ_GLYPH_VERT;
    /* diagonal: fold so gx>=0, then sign of gy selects the slash direction. */
    if (gx < 0) gy = -gy;
    return gy >= 0 ? SYZ_GLYPH_SLASH : SYZ_GLYPH_BSLASH;
}

/* Bivariate selection: if the edge is strong enough, return a directional line
 * glyph (Unicode scalar); otherwise return the tone-ramp ASCII char.
 * `thresh2` is the squared edge-magnitude threshold. On a ramp result, the
 * returned scalar is a plain ASCII code (< 128); on an edge, it is a box-
 * drawing scalar (>= 0x2500). Callers distinguish by range. */
static inline uint32_t syz_glyph_select(syz_luma_fn L, void *ctx, int x, int y,
                                        int64_t thresh2) {
    int32_t gx = syz_sobel_gx(L, ctx, x, y);
    int32_t gy = syz_sobel_gy(L, ctx, x, y);
    if (syz_edge_mag2(gx, gy) > thresh2) {
        return syz_glyph_direction(gx, gy);
    }
    return (uint32_t)(unsigned char)syz_ramp_char(L(x, y, ctx));
}

#endif /* SYZ_GLYPH_H */
