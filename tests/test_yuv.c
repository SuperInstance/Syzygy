/* =============================================================================
 * test_yuv.c — passing test for SHARD 0004 (NV12 ingest)
 * HASH MARK:
 *   WHAT   : Synthetic NV12 -> luma/chroma/cell buffers in the arena.
 *   STATE  : HEWN — earns 0004 its HEWN mark.
 *   RUNS   : `sh tests/run.sh`
 *   SEED   : docs/seed/blob.md 5814-5900.
 * ========================================================================== */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "syz_yuv.h"

static int failures = 0, checks = 0;
#define CHECK(cond, msg) do {                                  \
    checks++;                                                  \
    if (!(cond)) { printf("  FAIL: %s\n", msg); failures++; }  \
    else         { printf("  ok  : %s\n", msg); }              \
} while (0)

#define W 16
#define H 8
#define YS 20  /* padded strides exercise stride handling */
#define UVS 24

static uint8_t ybuf[YS * H], uvbuf[UVS * (H / 2)];
static uint8_t pool[4096];

static int inside(const uint8_t *p, size_t n) {
    return p >= pool && p + n <= pool + sizeof pool;
}

int main(void) {
    SyzArena a; SyzYuvFrame f; SyzNv12 s;
    uint8_t r, g, b, er, eg, eb;
    uint32_t x, y; int ok;
    printf("=== Syzygy shard tests: 0004 yuv ingest ===\n");

    memset(ybuf, 0xEE, sizeof ybuf); memset(uvbuf, 0xEE, sizeof uvbuf);
    syz_yuv_synth(ybuf, uvbuf, W, H, YS, UVS);
    s.y = ybuf; s.uv = uvbuf; s.w = W; s.h = H; s.y_stride = YS; s.uv_stride = UVS;
    syz_arena_init(&a, pool, sizeof pool);
    CHECK(syz_yuv_ingest(&a, &s, &f) == 0, "ingest succeeds");

    printf("[luma] known synthetic values\n");
    CHECK(syz_yuv_luma_at(&f, 0, 0) == 0, "corner (0,0) == 0");
    CHECK(syz_yuv_luma_at(&f, W - 1, 0) == 15, "corner (15,0) == 15");
    CHECK(syz_yuv_luma_at(&f, 0, H - 1) == 14, "corner (0,7) == 14");
    CHECK(syz_yuv_luma_at(&f, W - 1, H - 1) == 29, "corner (15,7) == 29");
    CHECK(syz_yuv_luma_at(&f, W / 2, H / 2) == 16, "centre (8,4) == 16");
    ok = 1;
    for (y = 0; y < H; y++) for (x = 0; x < W; x++)
        if (f.luma[y * W + x] != ((x + 2 * y) & 0xFF)) ok = 0;
    CHECK(ok, "every luma pixel matches closed form (stride padding stripped)");
    CHECK(syz_yuv_luma_at(&f, -1, 0) == 0 && syz_yuv_luma_at(&f, 0, H) == 0
          && syz_yuv_luma_at(&f, W, 0) == 0, "out-of-bounds luma reads 0");
    CHECK(syz_yuv_luma_fn(3, 2, &f) == 7, "syz_luma_fn adapter agrees");
    {
        syz_luma_fn fn = syz_yuv_luma_fn; /* type-compatible with 0003 */
        CHECK(fn(5, 1, &f) == 7, "usable as syz_luma_fn");
    }

    printf("[chroma] 2x2 -> 1 subsampling\n");
    CHECK(f.cw == W / 2 && f.ch == H / 2, "chroma plane is (w/2)x(h/2)");
    ok = 1;
    for (y = 0; y < f.ch; y++) for (x = 0; x < f.cw; x++)
        if (f.u[y * f.cw + x] != ((x * 32) & 0xFF) || f.v[y * f.cw + x] != ((y * 64) & 0xFF)) ok = 0;
    CHECK(ok, "U/V de-interleaved to expected values");
    /* luma pixels (2cx..2cx+1, 2cy..2cy+1) share chroma (cx,cy): U depends on x>>1 */
    CHECK(f.u[(5 >> 1) + (3 >> 1) * f.cw] == f.u[(4 >> 1) + (2 >> 1) * f.cw],
          "pixels (5,3) and (4,2) map to the same chroma sample");
    CHECK(f.v[(3 >> 1) * f.cw] == 64, "pixel row 3 maps to chroma row 1 (V=64)");

    printf("[cells] cell grid and colour\n");
    CHECK(f.cols == W / 2 && f.rows == H / 4, "cell grid is (w/2)x(h/4)");
    /* cell (3,1): base (6,4), centre luma (6,5)=16, chroma (3,2): U=96 V=128 */
    syz_yuv_chroma((uint8_t)((6 + 2 * 5) & 0xFF), 96, 128, &er, &eg, &eb);
    r = f.rgb[(1 * f.cols + 3) * 3]; g = f.rgb[(1 * f.cols + 3) * 3 + 1]; b = f.rgb[(1 * f.cols + 3) * 3 + 2];
    CHECK(r == er && g == eg && b == eb, "cell (3,1) rgb matches seed formula");
    /* independent hand computation: U-128=-32, V-128=0 -> rd=0, gd=(-5638*-32)>>14=11, bd=(29032*-32)>>14=-57 */
    CHECK(r == 16 && g == 27 && b == 0, "cell (3,1) == (16,27,0) by hand (luma 16)");
    syz_yuv_chroma(100, 128, 128, &r, &g, &b);
    CHECK(r == 100 && g == 100 && b == 100, "neutral chroma leaves grey");
    syz_yuv_chroma(250, 255, 255, &r, &g, &b);
    CHECK(b == 255 && r == 255, "saturating chroma clamps to 255");
    syz_yuv_chroma(5, 0, 0, &r, &g, &b);
    CHECK(r == 0 && b == 0, "negative diff clamps to 0");
    CHECK(syz_luma8(255, 255, 255) == 255 && syz_luma8(0, 0, 0) == 0,
          "shared syz_luma8 (>>8) reused, not redefined");

    printf("[arena] sizes and bounds\n");
    CHECK(inside(f.luma, W * H) && inside(f.u, 32) && inside(f.v, 32)
          && inside(f.rgb, f.cols * f.rows * 3), "all four buffers inside arena bounds");
    CHECK(((uintptr_t)(f.luma - pool) & 15u) == 0 && ((uintptr_t)(f.rgb - pool) & 15u) == 0,
          "buffers 16-byte aligned");
    CHECK(f.u >= f.luma + W * H && f.v >= f.u + 32 && f.rgb >= f.v + 32,
          "buffers disjoint");
    CHECK(syz_arena_used(&a) >= (size_t)(W * H + 32 + 32 + 8 * 2 * 3) && syz_arena_used(&a) <= 4 * 16 + W * H + 64 + 48,
          "arena accounting matches plane sizes");

    printf("[errors] exhaustion and bad args\n");
    {
        uint8_t small[64]; SyzArena sa; size_t before;
        syz_arena_init(&sa, small, sizeof small);
        CHECK(syz_yuv_ingest(&sa, &s, &f) == -1, "too-small arena -> -1");
        before = syz_arena_used(&sa);
        CHECK(before == 0, "failed ingest rolls arena back");
    }
    s.w = 15; CHECK(syz_yuv_ingest(&a, &s, &f) == -1, "odd width rejected");
    s.w = W; s.y_stride = 8; CHECK(syz_yuv_ingest(&a, &s, &f) == -1, "stride < width rejected");
    s.y_stride = YS; s.h = 2; CHECK(syz_yuv_ingest(&a, &s, &f) == -1, "height < 4 rejected");
    s.h = H; s.y = NULL; CHECK(syz_yuv_ingest(&a, &s, &f) == -1, "NULL plane rejected");

    printf("=== %d checks, %d failures ===\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
