/* =============================================================================
 * test_fused.c — passing test for SHARD 0005 (fused pass); the I2 witness
 * HASH MARK:
 *   WHAT   : syz_fused output == composed reference (byte-identical), I1
 *            rollback, determinism, failure paths.
 *   STATE  : HEWN — earns 0005 its HEWN mark.
 *   RUNS   : `sh tests/run.sh`
 *   SEED   : docs/seed/blob.md 8324-8420.
 * ========================================================================== */
#include <stdio.h>
#include <stdint.h>
#include <string.h>
#include "syz_fused.h"

static int failures = 0, checks = 0;
#define CHECK(cond, msg) do {                                  \
    checks++;                                                  \
    if (!(cond)) { printf("  FAIL: %s\n", msg); failures++; }  \
    else         { printf("  ok  : %s\n", msg); }              \
} while (0)

#define MAXC 512
#define GOLDEN_HASH 0x6dbdd1a8u
static uint8_t  ybuf[80 * 40], uvbuf[80 * 20];
static uint8_t  pool[65536], pool2[65536];
static uint8_t  fm[MAXC], ft[MAXC], rm[MAXC], rt[MAXC];
static uint32_t fg[MAXC], rg[MAXC];

static uint32_t lcg = 12345u;
static uint8_t rnd(void) { lcg = lcg * 1664525u + 1013904223u; return (uint8_t)(lcg >> 24); }

/* Composed reference: each shard as its own staged full-plane pass. */
static int composed(SyzArena *a, const SyzNv12 *s, const SyzFusedParams *p,
                    SyzFusedOut *r, uint8_t *maskplane, uint32_t *glyphplane,
                    uint8_t *toneplane) {
    SyzYuvFrame f; uint32_t x, y, k;
    int32_t re[16] = {0}, im[16] = {0};
    if (syz_yuv_ingest(a, s, &f) != 0) return -1;
    r->cols = f.cols; r->rows = f.rows;
    r->fft_valid = (f.cols >= 16 && p->fft_row < f.rows);
    for (y = 0; y < f.rows; y++)          /* pass 1: 0001 braille plane */
        for (x = 0; x < f.cols; x++) {
            uint8_t cell[4][2]; uint32_t r_, c_;
            for (r_ = 0; r_ < 4; r_++) for (c_ = 0; c_ < 2; c_++)
                cell[r_][c_] = syz_yuv_luma_at(&f, (int)(2*x + c_), (int)(4*y + r_));
            maskplane[y * f.cols + x] = syz_braille_pack(cell, p->braille_thresh);
        }
    for (y = 0; y < f.rows; y++)          /* pass 2: 0003 glyph plane */
        for (x = 0; x < f.cols; x++)
            glyphplane[y * f.cols + x] = syz_glyph_select(syz_yuv_luma_fn, &f,
                (int)(2*x), (int)(4*y + 1), p->edge_thresh2);
    for (y = 0; y < f.rows; y++)          /* pass 3: cell luma + tone plane */
        for (x = 0; x < f.cols; x++) {
            const uint8_t *c = &f.rgb[((size_t)y * f.cols + x) * 3u];
            toneplane[y * f.cols + x] = syz_fused_tone(syz_luma8(c[0], c[1], c[2]), c[1]);
        }
    if (r->fft_valid) {                   /* pass 4: 0006 on a staged window */
        for (k = 0; k < 16; k++) {
            const uint8_t *c = &f.rgb[((size_t)p->fft_row * f.cols + k) * 3u];
            re[k] = syz_luma8(c[0], c[1], c[2]);
        }
        syz_fft16(re, im);
        r->peak_bin = syz_fused_peak(re, im);
    } else r->peak_bin = 0;
    memcpy(r->spec_re, re, sizeof re); memcpy(r->spec_im, im, sizeof im);
    return 0;
}

static int run_case(const char *name, uint32_t w, uint32_t h, uint32_t ys, uint32_t uvs,
                    int random_frame, uint32_t fft_row) {
    SyzArena a, b; SyzNv12 s; SyzFusedParams p; SyzFusedOut fo, ro;
    size_t n; char msg[128]; int rc1, rc2;
    if (random_frame) {
        size_t i;
        for (i = 0; i < (size_t)ys * h; i++) ybuf[i] = rnd();
        for (i = 0; i < (size_t)uvs * (h / 2); i++) uvbuf[i] = rnd();
    } else syz_yuv_synth(ybuf, uvbuf, w, h, ys, uvs);
    s.y = ybuf; s.uv = uvbuf; s.w = w; s.h = h; s.y_stride = ys; s.uv_stride = uvs;
    p.braille_thresh = 100; p.edge_thresh2 = 4000; p.fft_row = fft_row;
    memset(&fo, 0, sizeof fo); memset(&ro, 0, sizeof ro);
    fo.cap = MAXC; fo.mask = fm; fo.glyph = fg; fo.tone = ft;
    memset(fm, 0, sizeof fm); memset(fg, 0, sizeof fg); memset(ft, 0, sizeof ft);
    memset(rm, 0, sizeof rm); memset(rg, 0, sizeof rg); memset(rt, 0, sizeof rt);
    syz_arena_init(&a, pool, sizeof pool); syz_arena_init(&b, pool2, sizeof pool2);
    rc1 = syz_fused(&a, &s, &p, &fo);
    rc2 = composed(&b, &s, &p, &ro, rm, rg, rt);
    n = (size_t)fo.cols * fo.rows;
    snprintf(msg, sizeof msg, "%s: both paths succeed", name);
    CHECK(rc1 == 0 && rc2 == 0, msg);
    snprintf(msg, sizeof msg, "%s: fused mask == composed (%zu cells)", name, n);
    CHECK(memcmp(fm, rm, n) == 0, msg);
    snprintf(msg, sizeof msg, "%s: fused glyph == composed", name);
    CHECK(memcmp(fg, rg, n * sizeof(uint32_t)) == 0, msg);
    snprintf(msg, sizeof msg, "%s: fused tone == composed", name);
    CHECK(memcmp(ft, rt, n) == 0, msg);
    snprintf(msg, sizeof msg, "%s: spectrum + peak + valid == composed", name);
    CHECK(memcmp(fo.spec_re, ro.spec_re, sizeof fo.spec_re) == 0 &&
          memcmp(fo.spec_im, ro.spec_im, sizeof fo.spec_im) == 0 &&
          fo.peak_bin == ro.peak_bin && fo.fft_valid == ro.fft_valid, msg);
    snprintf(msg, sizeof msg, "%s: I1 arena rolled back to pre-frame mark", name);
    CHECK(syz_arena_used(&a) == 0 && syz_arena_high_water(&a) > 0, msg);
    return 0;
}

int main(void) {
    SyzArena a; SyzNv12 s; SyzFusedParams p; SyzFusedOut o1, o2;
    uint32_t h1, h2, i; size_t hw, n, pre;
    printf("=== Syzygy shard tests: 0005 fused pass (I2 witness) ===\n");

    run_case("synth 32x16 padded", 32, 16, 40, 48, 0, 1);
    run_case("synth 64x32 (cols=32, rows=8)", 64, 32, 64, 64, 0, 3);
    run_case("random 48x24 padded", 48, 24, 60, 60, 1, 2);
    run_case("random 64x40 second seed", 64, 40, 80, 80, 1, 0);
    run_case("synth 16x8 (cols=8 <16: fft invalid)", 16, 8, 16, 16, 0, 0);

    /* I1 across frames + determinism + O(1) space */
    syz_yuv_synth(ybuf, uvbuf, 32, 16, 32, 32);
    s.y = ybuf; s.uv = uvbuf; s.w = 32; s.h = 16; s.y_stride = 32; s.uv_stride = 32;
    p.braille_thresh = 100; p.edge_thresh2 = 4000; p.fft_row = 1;
    memset(&o1, 0, sizeof o1); memset(&o2, 0, sizeof o2);
    o1.cap = MAXC; o1.mask = fm; o1.glyph = fg; o1.tone = ft;
    o2.cap = MAXC; o2.mask = rm; o2.glyph = rg; o2.tone = rt;
    syz_arena_init(&a, pool, sizeof pool);
    pre = syz_arena_alloc16(&a, 64) ? syz_arena_mark(&a) : 0; /* nonzero pre-mark */
    CHECK(pre == 64, "arena has a nonzero pre-frame mark (64)");
    CHECK(syz_fused(&a, &s, &p, &o1) == 0, "frame 1 ok");
    CHECK(syz_arena_used(&a) == pre, "I1: offset == pre-frame mark after frame 1");
    hw = syz_arena_high_water(&a);
    CHECK(syz_fused(&a, &s, &p, &o2) == 0, "frame 2 (same input) ok");
    CHECK(syz_arena_used(&a) == pre, "I1: offset == pre-frame mark after frame 2");
    CHECK(syz_arena_high_water(&a) == hw, "I1: high-water unchanged frame 1 -> 2 (O(1) space)");
    n = (size_t)o1.cols * o1.rows;
    CHECK(memcmp(fm, rm, n) == 0 && memcmp(fg, rg, n * 4) == 0 && memcmp(ft, rt, n) == 0 &&
          memcmp(o1.spec_re, o2.spec_re, sizeof o1.spec_re) == 0 &&
          memcmp(o1.spec_im, o2.spec_im, sizeof o1.spec_im) == 0 && o1.peak_bin == o2.peak_bin,
          "determinism: two runs byte-identical");
    for (i = 0; i < 50; i++) syz_fused(&a, &s, &p, &o2);
    CHECK(syz_arena_used(&a) == pre && syz_arena_high_water(&a) == hw,
          "50 more frames: offset and high-water unchanged");
    /* golden hash (FNV-1a) of the fused output pins cross-target determinism */
    h1 = 2166136261u;
    for (i = 0; i < n; i++) { h1 = (h1 ^ fm[i]) * 16777619u; h1 = (h1 ^ ft[i]) * 16777619u; }
    for (i = 0; i < 16; i++) { h1 = (h1 ^ (uint32_t)o1.spec_re[i]) * 16777619u;
                               h1 = (h1 ^ (uint32_t)o1.spec_im[i]) * 16777619u; }
    h2 = h1; (void)h2;
    printf("  info: golden fnv1a = 0x%08x\n", h1);
    CHECK(h1 == GOLDEN_HASH, "golden FNV-1a of mask+tone+spectrum matches pinned value");

    /* known structure: peak bin of a pure horizontal luma ramp is bounded */
    CHECK(o1.fft_valid == 1 && o1.peak_bin >= 1 && o1.peak_bin <= 8, "peak_bin in 1..8");

    /* failure paths leave the arena unchanged */
    { uint8_t tiny[64]; SyzArena t; syz_arena_init(&t, tiny, sizeof tiny);
      CHECK(syz_fused(&t, &s, &p, &o1) == -1 && syz_arena_used(&t) == 0,
            "arena exhaustion -> -1, arena rolled back"); }
    o1.cap = 1;
    CHECK(syz_fused(&a, &s, &p, &o1) == -1 && syz_arena_used(&a) == pre,
          "output too small -> -1, arena rolled back");
    o1.cap = MAXC;
    CHECK(syz_fused(&a, &s, &p, 0) == -1 && syz_fused(0, &s, &p, &o1) == -1,
          "NULL args -> -1");

    printf("test_fused: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
