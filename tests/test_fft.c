/* =============================================================================
 * test_fft.c — passing test for SHARD 0006 (16-pt fixed-point FFT)
 * HASH MARK:
 *   WHAT   : Proves syz_fft16 against classic invariants + a double-DFT oracle.
 *   STATE  : HEWN — this run earns 0006 its HEWN mark.
 *   RUNS   : `sh tests/run.sh`
 *   TOLERANCE: abs error vs exact DFT <= 8 LSB per output (inputs |x|<=4095,
 *            unscaled gain 16); impulse flatness +-2; off-bin leakage <= 16;
 *            linearity |F(a+b)-F(a)-F(b)| <= 4 per output.
 *   ASSUMES: libm only in this harness (oracle); the shard uses none.
 *   SEED   : docs/seed/blob.md 3236-3292.
 * ========================================================================== */
#include <stdio.h>
#include <stdint.h>
#include <math.h>
#include "syz_fft.h"

static int failures = 0, checks = 0;
#define CHECK(cond, msg) do { checks++; \
    if (!(cond)) { printf("  FAIL: %s\n", msg); failures++; } \
    else printf("  ok  : %s\n", msg); } while (0)

static int32_t iabs(int32_t v) { return v < 0 ? -v : v; }

static void ref_dft(const int32_t *re, const int32_t *im, double *or_, double *oi) {
    const double pi = 3.14159265358979323846;
    for (int k = 0; k < 16; k++) {
        double a = 0, b = 0;
        for (int n = 0; n < 16; n++) {
            double w = -2.0 * pi * n * k / 16.0, c = cos(w), s = sin(w);
            a += re[n] * c - im[n] * s;
            b += re[n] * s + im[n] * c;
        }
        or_[k] = a; oi[k] = b;
    }
}

static int32_t mag_bin(const int32_t *re, const int32_t *im, int k) {
    /* L-inf-ish magnitude, integer: max(|re|,|im|) */
    return iabs(re[k]) > iabs(im[k]) ? iabs(re[k]) : iabs(im[k]);
}

static void test_impulse(void) {
    printf("[impulse] delta -> flat spectrum\n");
    int32_t re[16] = {0}, im[16] = {0};
    re[0] = 1000;
    syz_fft16(re, im);
    int ok = 1;
    for (int k = 0; k < 16; k++)
        if (iabs(re[k] - 1000) > 2 || iabs(im[k]) > 2) ok = 0;
    CHECK(ok, "impulse 1000 -> every bin == 1000+-2, imag 0+-2");
    /* shifted impulse: magnitude still flat, only phase changes */
    int32_t r2[16] = {0}, i2[16] = {0};
    r2[3] = 1000;
    syz_fft16(r2, i2);
    ok = 1;
    for (int k = 0; k < 16; k++) {
        int64_t m2 = (int64_t)r2[k]*r2[k] + (int64_t)i2[k]*i2[k];
        if (m2 < 998LL*998 || m2 > 1002LL*1002) ok = 0;
    }
    CHECK(ok, "shifted impulse -> |X_k| flat at 1000+-2");
}

static void test_dc(void) {
    printf("[dc] constant -> bin 0 only\n");
    int32_t re[16], im[16] = {0};
    for (int i = 0; i < 16; i++) re[i] = 100;
    syz_fft16(re, im);
    CHECK(iabs(re[0] - 1600) <= 2 && iabs(im[0]) <= 2, "bin0 == 16*100 = 1600+-2");
    int ok = 1;
    for (int k = 1; k < 16; k++) if (mag_bin(re, im, k) > 2) ok = 0;
    CHECK(ok, "bins 1..15 all <= 2");
}

static void test_sine(void) {
    printf("[sinusoid] single-bin tone -> energy in bin b and 16-b\n");
    static const int bins[3] = {1, 3, 5};
    for (int t = 0; t < 3; t++) {
        int b = bins[t];
        int32_t re[16], im[16] = {0};
        const double pi = 3.14159265358979323846;
        for (int n = 0; n < 16; n++) re[n] = (int32_t)lround(1000.0 * cos(2*pi*b*n/16.0));
        syz_fft16(re, im);
        int ok = iabs(mag_bin(re, im, b) - 8000) <= 24 && iabs(mag_bin(re, im, 16-b) - 8000) <= 24;
        char msg[96];
        snprintf(msg, sizeof msg, "cos tone bin %d: X[%d],X[%d] ~ 8000 (+-24)", b, b, 16-b);
        CHECK(ok, msg);
        ok = 1;
        for (int k = 0; k < 16; k++)
            if (k != b && k != 16-b && mag_bin(re, im, k) > 16) ok = 0;
        snprintf(msg, sizeof msg, "cos tone bin %d: all other bins <= 16 (leakage)", b);
        CHECK(ok, msg);
    }
}

static void test_linearity(void) {
    printf("[linearity] F(a+b) == F(a)+F(b) within 4 LSB\n");
    int32_t ar[16], ai[16], br[16], bi[16], sr[16], si[16];
    uint32_t s = 12345;
    for (int n = 0; n < 16; n++) {
        s = s * 1664525u + 1013904223u; ar[n] = (int32_t)((s >> 16) % 1001) - 500;
        s = s * 1664525u + 1013904223u; ai[n] = (int32_t)((s >> 16) % 1001) - 500;
        s = s * 1664525u + 1013904223u; br[n] = (int32_t)((s >> 16) % 1001) - 500;
        s = s * 1664525u + 1013904223u; bi[n] = (int32_t)((s >> 16) % 1001) - 500;
        sr[n] = ar[n] + br[n]; si[n] = ai[n] + bi[n];
    }
    syz_fft16(ar, ai); syz_fft16(br, bi); syz_fft16(sr, si);
    int ok = 1;
    for (int k = 0; k < 16; k++)
        if (iabs(sr[k] - ar[k] - br[k]) > 4 || iabs(si[k] - ai[k] - bi[k]) > 4) ok = 0;
    CHECK(ok, "random complex pair a,b: linear within 4");
    /* scaling: F(2a) == 2F(a) within 4 */
    int32_t xr[16], xi[16], yr[16], yi[16];
    for (int n = 0; n < 16; n++) { xr[n] = 37*n - 300; xi[n] = 200 - 11*n; yr[n] = 2*xr[n]; yi[n] = 2*xi[n]; }
    syz_fft16(xr, xi); syz_fft16(yr, yi);
    ok = 1;
    for (int k = 0; k < 16; k++)
        if (iabs(yr[k] - 2*xr[k]) > 4 || iabs(yi[k] - 2*xi[k]) > 4) ok = 0;
    CHECK(ok, "homogeneity F(2x) == 2F(x) within 4");
}

static void test_oracle(void) {
    printf("[oracle] vs double-precision DFT, full-scale 12-bit input\n");
    int worst = 0;
    uint32_t s = 777;
    for (int trial = 0; trial < 200; trial++) {
        int32_t re[16], im[16], r0[16], i0[16];
        for (int n = 0; n < 16; n++) {
            s = s * 1664525u + 1013904223u; re[n] = (int32_t)((s >> 16) % 8191) - 4095;
            s = s * 1664525u + 1013904223u; im[n] = (int32_t)((s >> 16) % 8191) - 4095;
            r0[n] = re[n]; i0[n] = im[n];
        }
        double er[16], ei[16];
        ref_dft(r0, i0, er, ei);
        syz_fft16(re, im);
        for (int k = 0; k < 16; k++) {
            int d1 = (int)lround(fabs(re[k] - er[k])), d2 = (int)lround(fabs(im[k] - ei[k]));
            if (d1 > worst) worst = d1;
            if (d2 > worst) worst = d2;
        }
    }
    printf("  worst abs error over 200 random full-scale vectors: %d LSB\n", worst);
    CHECK(worst <= 8, "worst abs error <= 8 LSB (no overflow at |x|<=4095)");
}

static void test_table(void) {
    printf("[trig table] SCARF-2: one sine-phased table, cos via +4\n");
    int ok = 1;
    for (int i = 0; i < 16; i++)
        if (SYZ_SIN_TABLE[i] != -SYZ_SIN_TABLE[(i + 8) & 15]) ok = 0;
    CHECK(ok, "sin(i+8) == -sin(i)");
    CHECK(SYZ_SIN_TABLE[4] == 16384 && SYZ_SIN_TABLE[(0 + 4) & 15] == 16384, "cos(0) = T[4] = 16384");
}

int main(void) {
    printf("=== Syzygy shard test: 0006 fft16 ===\n");
    test_table(); test_impulse(); test_dc(); test_sine(); test_linearity(); test_oracle();
    printf("=== %d checks, %d failures ===\n", checks, failures);
    return failures == 0 ? 0 : 1;
}
