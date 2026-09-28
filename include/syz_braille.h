/* =============================================================================
 * syz_braille.h — 8-dot Braille subpixel bitmask packer  [SHARD 0001]
 * -----------------------------------------------------------------------------
 * HASH MARK (read this by context; you do not need the history):
 *   WHAT     : Packs a 2x4 sub-pixel luminance macroblock into one Unicode
 *              Braille glyph (U+2800 + bitmask) and serializes it to UTF-8.
 *              Pure integer, zero allocation, no FPU, no libc.
 *   STATE    : HEWN  — functions now, covered by tests/test_braille.c.
 *   RUNS     : luma8(), braille_pack(), braille_codepoint(), braille_utf8().
 *   SHORTCUT : Threshold is a fixed scalar per call (seed's `threshold` arg).
 *              An adaptive/per-cell threshold (tau) is the honest upgrade.
 *   ASSUMES  : Caller supplies an 8-point luminance macroblock already laid out
 *              as cell[row0..3][col0..1]. Upstream ingestion (yuv/nv12) is DRAWN,
 *              not built — see docs/marks/0004-yuv-ingest.md.
 *   BETTER-WHEN: A SIMD lane version (seed blob:3294) and an adaptive tau
 *              (seed blob:8037) exist; and when the fused pass writes these
 *              masks straight from registers (seed blob:8325) instead of via a
 *              staged cell[][] array.
 *   SEED     : docs/seed/blob.md lines 923-959 (JS compiler), 5799-5900
 *              (C mechanics + fused_yuv), 8034-8053 (bit layout proof).
 *   NEXT     : 0002-arena (a place to write these without malloc),
 *              0004-yuv-ingest (a real source of the 8 luminance points).
 *
 * The standard Unicode 8-dot Braille dot numbering and bit weights:
 *
 *     dot layout        bit index (value)
 *     1  4              b0(1)   b3(8)
 *     2  5              b1(2)   b4(16)
 *     3  6              b2(4)   b5(32)
 *     7  8              b6(64)  b7(128)
 *
 * So a 2x4 macroblock cell[r][c] (r=0..3 top->bottom, c=0..1 left->right)
 * maps: left column rows -> bits {0,1,2,6}; right column rows -> {3,4,5,7}.
 * This is the mapping the seed's C engine uses (blob:5857, 5869) and it is
 * the correct standard mapping (verified against U+28xx).
 * ========================================================================== */
#ifndef SYZ_BRAILLE_H
#define SYZ_BRAILLE_H

#include <stdint.h>

/* Base address of the Unicode Braille Patterns block. */
#define SYZ_BRAILLE_BASE 0x2800u

/* ITU-R BT.601 perceptual luminance, fixed-point 8-bit scaled.
 * weights 77 + 150 + 29 = 256, so the >>8 divides by the weight sum exactly.
 * Result is in [0,255]. No floating point; identical on every target. */
static inline uint8_t syz_luma8(uint8_t r, uint8_t g, uint8_t b) {
    uint32_t l = (uint32_t)r * 77u + (uint32_t)g * 150u + (uint32_t)b * 29u;
    return (uint8_t)(l >> 8);
}

/* Standard bit index for a subpixel at (row, col) of the 2x4 macroblock.
 * left column (col 0): rows 0,1,2,3 -> bits 0,1,2,6
 * right column (col 1): rows 0,1,2,3 -> bits 3,4,5,7 */
static inline uint8_t syz_braille_bit(uint8_t row /*0..3*/, uint8_t col /*0..1*/) {
    static const uint8_t left[4]  = {0, 1, 2, 6};
    static const uint8_t right[4] = {3, 4, 5, 7};
    return col ? right[row & 3u] : left[row & 3u];
}

/* Pack a 2x4 luminance macroblock into an 8-bit Braille mask.
 * A subpixel lights (its bit is set) when its luminance strictly exceeds
 * `threshold`. cell is indexed cell[row][col], row 0..3, col 0..1. */
static inline uint8_t syz_braille_pack(const uint8_t cell[4][2], uint8_t threshold) {
    uint8_t mask = 0;
    for (uint8_t row = 0; row < 4; row++) {
        if (cell[row][0] > threshold) mask |= (uint8_t)(1u << syz_braille_bit(row, 0));
        if (cell[row][1] > threshold) mask |= (uint8_t)(1u << syz_braille_bit(row, 1));
    }
    return mask;
}

/* Map an 8-bit mask to its Unicode scalar in the Braille block. */
static inline uint32_t syz_braille_codepoint(uint8_t mask) {
    return SYZ_BRAILLE_BASE + (uint32_t)mask;
}

/* Serialize a Braille codepoint (U+2800..U+28FF) as 3 UTF-8 bytes.
 * The whole Braille block encodes to exactly 3 bytes, so this is branchless.
 * Writes out[0..2]; returns the number of bytes written (always 3). */
static inline int syz_braille_utf8(uint32_t cp, char out[3]) {
    out[0] = (char)(0xE0u | ((cp >> 12) & 0x0Fu));
    out[1] = (char)(0x80u | ((cp >>  6) & 0x3Fu));
    out[2] = (char)(0x80u | ( cp        & 0x3Fu));
    return 3;
}

#endif /* SYZ_BRAILLE_H */
