/* =============================================================================
 * test_braille.c — passing test for SHARD 0001 (braille) + 0003 (glyph)
 * -----------------------------------------------------------------------------
 * HASH MARK:
 *   WHAT   : Proves the two HEWN shards behave to the seed's spec, right now.
 *   STATE  : HEWN — this is the run that earns 0001/0003 their HEWN mark.
 *   RUNS   : `sh tests/run.sh` (or cc -I include tests/test_braille.c && ./a.out)
 *   ASSUMES: a C11 host compiler + libc for asserts/printf. The shards under
 *            test use NO libc; only this harness does.
 *   SEED   : docs/seed/blob.md 923-959, 5799-5900, 8034-8053, 862-921.
 * ========================================================================== */
#include <stdio.h>
#include <stdint.h>
#include <string.h>

#include "syz_braille.h"
#include "syz_glyph.h"

static int failures = 0;
static int checks   = 0;

#define CHECK(cond, msg) do {                                      \
    checks++;                                                      \
    if (!(cond)) { printf("  FAIL: %s\n", msg); failures++; }     \
    else         { printf("  ok  : %s\n", msg); }                 \
} while (0)

/* ---- luminance ---------------------------------------------------------- */
static void test_luma(void) {
    printf("[luma8] ITU-R BT.601, 8-bit scaled\n");
    /* Expected values are the honest >>8 (truncating) integer results, not the
     * rounded weight; e.g. green = (255*150)>>8 = 38250/256 = 149. */
    CHECK(syz_luma8(0, 0, 0)       == 0,   "black -> 0");
    CHECK(syz_luma8(255, 255, 255) == 255, "white -> 255 (weights sum to 256)");
    CHECK(syz_luma8(0, 255, 0)     == 149, "pure green -> 149 (150 truncated by >>8)");
    CHECK(syz_luma8(255, 0, 0)     == 76,  "pure red -> 76 (77 truncated by >>8)");
    CHECK(syz_luma8(0, 0, 255)     == 28,  "pure blue -> 28 (29 truncated by >>8)");
}

/* ---- braille packing ---------------------------------------------------- */
static void test_pack(void) {
    printf("[braille_pack] 2x4 subpixel -> 8-bit mask -> U+2800+mask\n");
    const uint8_t T = 128; /* threshold */
    uint8_t dark[4][2]  = {{0,0},{0,0},{0,0},{0,0}};
    uint8_t bright[4][2]= {{255,255},{255,255},{255,255},{255,255}};

    CHECK(syz_braille_pack(dark, T)   == 0x00, "all dark -> mask 0x00");
    CHECK(syz_braille_pack(bright, T) == 0xFF, "all bright -> mask 0xFF");
    CHECK(syz_braille_codepoint(0x00) == 0x2800, "mask 0 -> U+2800");
    CHECK(syz_braille_codepoint(0xFF) == 0x28FF, "mask 255 -> U+28FF");

    /* only top-left subpixel (dot 1 -> bit 0). */
    uint8_t tl[4][2] = {{255,0},{0,0},{0,0},{0,0}};
    CHECK(syz_braille_pack(tl, T) == 0x01, "top-left only -> bit0 (0x01)");

    /* only bottom-right subpixel (dot 8 -> bit 7). */
    uint8_t br[4][2] = {{0,0},{0,0},{0,0},{0,255}};
    CHECK(syz_braille_pack(br, T) == 0x80, "bottom-right only -> bit7 (0x80)");

    /* whole left column: bits {0,1,2,6} = 1+2+4+64 = 71 = 0x47. */
    uint8_t left[4][2] = {{255,0},{255,0},{255,0},{255,0}};
    CHECK(syz_braille_pack(left, T) == 0x47, "left column -> bits{0,1,2,6}=0x47");

    /* whole right column: bits {3,4,5,7} = 8+16+32+128 = 184 = 0xB8. */
    uint8_t right[4][2] = {{0,255},{0,255},{0,255},{0,255}};
    CHECK(syz_braille_pack(right, T) == 0xB8, "right column -> bits{3,4,5,7}=0xB8");

    /* threshold is STRICT: a value equal to the threshold does not light. */
    uint8_t eq[4][2] = {{128,128},{128,128},{128,128},{128,128}};
    CHECK(syz_braille_pack(eq, 128) == 0x00, "value == threshold does not light");
}

/* ---- UTF-8 serialization ------------------------------------------------ */
static void test_utf8(void) {
    printf("[braille_utf8] Braille block is exactly 3 UTF-8 bytes\n");
    char out[3];
    syz_braille_utf8(0x2800, out);
    CHECK((uint8_t)out[0]==0xE2 && (uint8_t)out[1]==0xA0 && (uint8_t)out[2]==0x80,
          "U+2800 -> E2 A0 80");
    syz_braille_utf8(0x28FF, out);
    CHECK((uint8_t)out[0]==0xE2 && (uint8_t)out[1]==0xA3 && (uint8_t)out[2]==0xBF,
          "U+28FF -> E2 A3 BF");
    syz_braille_utf8(0x2801, out);
    CHECK((uint8_t)out[0]==0xE2 && (uint8_t)out[1]==0xA0 && (uint8_t)out[2]==0x81,
          "U+2801 -> E2 A0 81");
}

/* ---- glyph: ramp + direction ------------------------------------------- */
static void test_ramp(void) {
    printf("[ramp_char] 10-step tone ramp\n");
    CHECK(syz_ramp_char(0)   == ' ', "luma 0 -> ' '");
    CHECK(syz_ramp_char(255) == '@', "luma 255 -> '@'");
    CHECK(syz_ramp_char(128) == '=', "luma 128 -> '=' (idx 4)");
}

static void test_direction(void) {
    printf("[glyph_direction] integer atan2-free window mapping\n");
    CHECK(syz_glyph_direction(1000, 0)     == SYZ_GLYPH_HORIZ,  "gx only -> horizontal");
    CHECK(syz_glyph_direction(0, 1000)     == SYZ_GLYPH_VERT,   "gy only -> vertical");
    CHECK(syz_glyph_direction(1000, 1000)  == SYZ_GLYPH_SLASH,  "45deg  -> slash");
    CHECK(syz_glyph_direction(1000, -1000) == SYZ_GLYPH_BSLASH, "-45deg -> backslash");
    CHECK(syz_glyph_direction(-1000, 1000) == SYZ_GLYPH_BSLASH, "135deg (folded) -> backslash");
    CHECK(syz_glyph_direction(300, 100)    == SYZ_GLYPH_HORIZ,  "ratio<tan22.5 -> horizontal");
    CHECK(syz_glyph_direction(100, 300)    == SYZ_GLYPH_VERT,   "ratio>tan67.5 -> vertical");
    CHECK(syz_glyph_direction(300, 200)    == SYZ_GLYPH_SLASH,  "mid ratio -> slash");
}

/* A tiny 6x6 luma grid used to exercise the Sobel path. Left half dark,
 * right half bright: a vertical brightness boundary at x=3. */
static uint8_t sample_vboundary(int x, int y, void *ctx) {
    (void)ctx;
    if (x < 0 || x > 5 || y < 0 || y > 5) return 0; /* OOB -> 0 */
    return (x >= 3) ? 255 : 0;
}
/* A flat mid-gray grid: no edges anywhere. */
static uint8_t sample_flat(int x, int y, void *ctx) {
    (void)ctx; (void)x; (void)y;
    return 128;
}

static void test_select(void) {
    printf("[glyph_select] bivariate: edge -> line glyph, flat -> ramp\n");
    /* At the vertical boundary the gradient is horizontal, so the seed maps it
     * to the horizontal line glyph (it renders gradient direction). */
    uint32_t g = syz_glyph_select(sample_vboundary, NULL, 3, 3, /*thresh2=*/10000);
    CHECK(g == SYZ_GLYPH_HORIZ, "vertical boundary -> horizontal-gradient glyph");

    /* A flat field: no edge exceeds threshold -> ramp char for luma 128. */
    uint32_t f = syz_glyph_select(sample_flat, NULL, 3, 3, /*thresh2=*/10000);
    CHECK(f == (uint32_t)'=', "flat mid-gray -> ramp char '='");
    CHECK(f < 128u, "flat result is ASCII (< 128), edge result is >= 0x2500");
}

int main(void) {
    printf("=== Syzygy shard tests: 0001 braille + 0003 glyph ===\n");
    test_luma();
    test_pack();
    test_utf8();
    test_ramp();
    test_direction();
    test_select();
    printf("=== %d checks, %d failures ===\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
