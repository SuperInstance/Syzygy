/* =============================================================================
 * test_ste.c — passing test for SHARD 0007 (straight-through argmax tokenizer)
 * HASH MARK:
 *   WHAT   : argmax correctness vs brute-force oracle, tie rule (first max
 *            wins), known codebook -> known token, determinism, bounds, STE
 *            backward algebra, and that 0005's tone slot is unchanged.
 *   STATE  : HEWN — this run earns 0007 its HEWN mark.
 *   RUNS   : `sh tests/run.sh`
 *   SEED   : docs/seed/blob.md 8171-8239, 8080-8145, 304-312.
 * ========================================================================== */
#include <stdio.h>
#include <stdint.h>
#include "syz_ste.h"
#include "syz_fused.h"

static int failures = 0, checks = 0;
#define CHECK(cond, msg) do { checks++; \
    if (!(cond)) { printf("  FAIL: %s\n", msg); failures++; } \
    else printf("  ok  : %s\n", msg); } while (0)

static uint32_t lcg = 12345u;
static uint32_t rnd(void) { lcg = lcg * 1664525u + 1013904223u; return lcg >> 8; }

int main(void) {
    printf("[known] seed basis -> known tokens\n");
    { int32_t f0[4] = {100, 0, 0, 0};   /* scores 3200,6400,1600,-6400 -> 1 */
      int32_t f1[4] = {0, 100, 0, 0};   /* 6400,-3200,9600,1200 -> 2 */
      int32_t f2[4] = {0, 0, 0, 100};   /* 3200,6400,1600,-6400 -> 1 */
      int32_t f3[4] = {-10, 0, -10, 0}; /* -320,-640,-160,640+... -> 3 */
      CHECK(syz_ste_select4(f0, SYZ_STE_BASIS) == 1, "f=(100,0,0,0) -> token 1");
      CHECK(syz_ste_select4(f1, SYZ_STE_BASIS) == 2, "f=(0,100,0,0) -> token 2");
      CHECK(syz_ste_select4(f2, SYZ_STE_BASIS) == 1, "f=(0,0,0,100) -> token 1");
      CHECK(syz_ste_select4(f3, SYZ_STE_BASIS) == 3, "f=(-10,0,-10,0) -> token 3");
    }
    printf("[codebook] custom 3x2 codebook\n");
    { const int32_t cb[3][2] = {{1,0},{0,1},{-1,-1}};
      int32_t a[2] = {5,1}, b[2] = {1,9}, c[2] = {-4,-3};
      CHECK(syz_ste_select(a, &cb[0][0], 3, 2) == 0, "(5,1) -> 0");
      CHECK(syz_ste_select(b, &cb[0][0], 3, 2) == 1, "(1,9) -> 1");
      CHECK(syz_ste_select(c, &cb[0][0], 3, 2) == 2, "(-4,-3) -> 2");
    }
    printf("[ties] first maximum wins\n");
    { const int32_t cb[4][2] = {{1,1},{2,0},{0,2},{-1,-1}};
      int32_t f[2] = {3,3};             /* scores 6,6,6,-6 */
      int32_t z[2] = {0,0};             /* all zero: all tie */
      CHECK(syz_ste_select(f, &cb[0][0], 4, 2) == 0, "3-way tie -> lowest index 0");
      CHECK(syz_ste_select(z, &cb[0][0], 4, 2) == 0, "all-zero features -> 0");
      const int32_t cb2[3][1] = {{-5},{7},{7}};
      int32_t o[1] = {1};
      CHECK(syz_ste_select(o, &cb2[0][0], 3, 1) == 1, "tie at max of rows 1,2 -> 1");
      const int32_t cb3[2][1] = {{-3},{-3}};
      CHECK(syz_ste_select(o, &cb3[0][0], 2, 1) == 0, "all-negative tie -> 0");
    }
    printf("[oracle] random vs brute force + bounds + determinism\n");
    { int ok = 1, inb = 1, det = 1, i, j, t;
      for (t = 0; t < 2000; t++) {
        int32_t f[4], w[6][4]; int64_t best = 0; uint32_t want = 0, got, got2;
        for (j = 0; j < 4; j++) f[j] = (int32_t)(rnd() % 2001) - 1000;
        for (i = 0; i < 6; i++) for (j = 0; j < 4; j++) w[i][j] = (int32_t)(rnd() % 129) - 64;
        for (i = 0; i < 6; i++) {
            int64_t s = 0;
            for (j = 0; j < 4; j++) s += (int64_t)f[j] * w[i][j];
            if (i == 0 || s > best) { best = s; want = i; }
        }
        got = syz_ste_select(f, &w[0][0], 6, 4);
        got2 = syz_ste_select(f, &w[0][0], 6, 4);
        if (got != want) ok = 0;
        if (got >= 6) inb = 0;
        if (got != got2) det = 0;
      }
      CHECK(ok, "2000 random cases match brute-force first-max oracle");
      CHECK(inb, "result always in [0,n)");
      CHECK(det, "repeat calls identical");
    }
    printf("[edge] degenerate args and extremes\n");
    { int32_t f[2] = {1,1}; int32_t w[2] = {1,1};
      CHECK(syz_ste_select(f, w, 0, 2) == 0, "n=0 -> 0");
      CHECK(syz_ste_select(NULL, w, 1, 2) == 0, "NULL feat -> 0");
      CHECK(syz_ste_select(f, NULL, 1, 2) == 0, "NULL basis -> 0");
      int32_t big[2] = {2147483647, 2147483647};
      const int32_t cb[2][2] = {{2147483647, 2147483647}, {-2147483647, 0}};
      CHECK(syz_ste_select(big, &cb[0][0], 2, 2) == 0, "int32 extremes: no overflow");
    }
    printf("[ste] forward one-hot + backward algebra\n");
    { int32_t f[4] = {0, 100, 0, 0}, oh[4]; int64_t sc[4];
      uint32_t s = syz_ste_forward(f, &SYZ_STE_BASIS[0][0], 4, 4, sc, oh);
      CHECK(s == 2 && oh[2] == 1 && oh[0] + oh[1] + oh[3] == 0, "one-hot at argmax");
      CHECK(sc[0] == 6400 && sc[1] == -3200 && sc[2] == 9600 && sc[3] == 1200, "scores exposed");
      int32_t g[4] = {0, 0, 1, 0}; int64_t gf[4], gb[16];
      syz_ste_backward(f, &SYZ_STE_BASIS[0][0], 4, 4, g, gf, gb);
      CHECK(gf[0] == 16 && gf[1] == 96 && gf[2] == 96 && gf[3] == 16, "dL/dx = basis row of grad");
      CHECK(gb[2*4+1] == 100 && gb[0] == 0 && gb[3*4+1] == 0, "dL/dW = g_n * x_k");
      int32_t id[4]; syz_ste_backward_identity(g, id, 4);
      CHECK(id[0] == 0 && id[2] == 1, "identity STE passes gradient unchanged");
    }
    printf("[0005] tone slot unchanged\n");
    { int ok = 1; unsigned l, g;
      for (l = 0; l < 256; l += 5) for (g = 0; g < 256; g += 5) {
        int32_t best = -999999; uint32_t sel = 0, f, idx;
        for (f = 0; f < 4; f++) {
            int32_t s = (int32_t)l * SYZ_STE_BASIS[f][0] + (int32_t)g * SYZ_STE_BASIS[f][1];
            if (s > best) { best = s; sel = f; }
        }
        idx = (l * 9u) / 255u + sel; if (idx > 9u) idx = 9u;
        if (syz_fused_tone((uint8_t)l, (uint8_t)g) != (uint8_t)SYZ_RAMP[idx]) ok = 0;
      }
      CHECK(ok, "syz_fused_tone == legacy inline argmax over luma x g grid");
    }
    printf("\ntest_ste: %d checks, %d failures\n", checks, failures);
    return failures ? 1 : 0;
}
