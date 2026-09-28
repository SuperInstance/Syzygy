/* =============================================================================
 * syz_fft.h — 16-point radix-2 DIT fixed-point FFT  [SHARD 0006]
 * -----------------------------------------------------------------------------
 * HASH MARK (read this by context):
 *   WHAT     : In-place 16-point radix-2 decimation-in-time complex FFT in
 *              Q14 integer math (>>14). Zero allocation, no libc, no FPU.
 *   STATE    : HEWN — functions now, covered by tests/test_fft.c.
 *   RUNS     : syz_fft16(re, im): forward DFT, X_k = sum x_n e^{-j2pi nk/16},
 *              unscaled (gain N=16: DC of a constant c -> 16c). Tests: impulse
 *              flat, single-bin sinusoid, DC, linearity, vs double-DFT
 *              reference with abs error <= 8 LSB (see tests/test_fft.c).
 *   SHORTCUT : Fixed N=16. Keeps the explicit bit-reversal pass (SCARF-1
 *              timber B) — "bit-reversal-free" is NOT claimed. No per-stage
 *              scaling: caller keeps |re|,|im| <= 4095 (12-bit) so the last
 *              stage's int32 products cannot overflow. Rounds (+2^13) rather
 *              than truncating the seed's bare >>14. Right-shift of negatives
 *              assumed arithmetic (true on every target we build for).
 *   ASSUMES  : Upstream 0004 (luma/audio window) supplies 16 samples in
 *              re[], im[] zeroed. Needs 0002 arena only if buffers are staged.
 *              Consumed by 0005 (fused) — 0005 may call syz_fft16 on a row.
 *   BETTER-WHEN: The static shuffle-mask / fully-unrolled bit-reversal-free
 *              16-pt DFT exists (blob:8028-8029) — closes SCARF-1. Also a
 *              per-stage >>1 scaled variant lifts the 12-bit input bound.
 *   SEED     : docs/seed/blob.md 3236-3292 (chiaroscuro_fft_fixed),
 *              7322-7332 (butterfly math), 8305-8308 (dup trig table, unused).
 *   NEXT     : 0005-fused (fuse the window transform into the register pass),
 *              then the unrolled bit-reversal-free form to close SCARF-1.
 *
 * SCARF resolutions (docs/marks/ARCHITECTURE.md):
 *   SCARF-1: real-now = explicit bit-reversal pass (timber B), as ruled.
 *   SCARF-2: ONE sine-phased table (timber A); cos(i) = SIN[(i+4)&15].
 *            ULTIMATE_TRIG_TABLE (cos-phased) is not used.
 *   Seed bug fixed: the seed kernel names them swapped (its "sinW" reads the
 *   +4 entry, which is cosine) and rotates by e^{+j}. Here c=cos, s=sin and
 *   the twiddle is e^{-j}: t = (re*c + im*s) + j(im*c - re*s), matching the
 *   forward DFT the seed's own math section defines (blob:7322-7332 / W_N^nk).
 * ========================================================================== */
#ifndef SYZ_FFT_H
#define SYZ_FFT_H

#include <stdint.h>

#define SYZ_FFT_N 16
#define SYZ_FFT_Q 14

/* sin(2*pi*i/16) * 16384. Single source of truth (SCARF-2). */
static const int32_t SYZ_SIN_TABLE[16] = {
    0, 6270, 11585, 15137, 16384, 15137, 11585, 6270,
    0, -6270, -11585, -15137, -16384, -15137, -11585, -6270
};

static inline void syz_fft16(int32_t re[16], int32_t im[16]) {
    /* 1. bit-reversal permutation (seed blob:3249-3266) */
    uint32_t j = 0;
    for (uint32_t i = 0; i < 15; i++) {
        if (i < j) {
            int32_t t = re[i]; re[i] = re[j]; re[j] = t;
            t = im[i]; im[i] = im[j]; im[j] = t;
        }
        uint32_t k = 8;
        while (k <= j) { j -= k; k >>= 1; }
        j += k;
    }
    /* 2. butterflies */
    for (uint32_t step = 1; step < 16; step <<= 1) {
        uint32_t jump = step << 1;
        uint32_t delta = 16 / jump;
        for (uint32_t g = 0; g < step; g++) {
            uint32_t idx = g * delta;
            int32_t s = SYZ_SIN_TABLE[idx & 15];
            int32_t c = SYZ_SIN_TABLE[(idx + 4) & 15];
            for (uint32_t p = g; p < 16; p += jump) {
                uint32_t m = p + step;
                int32_t tr = (re[m] * c + im[m] * s + (1 << 13)) >> SYZ_FFT_Q;
                int32_t ti = (im[m] * c - re[m] * s + (1 << 13)) >> SYZ_FFT_Q;
                re[m] = re[p] - tr;  im[m] = im[p] - ti;
                re[p] += tr;         im[p] += ti;
            }
        }
    }
}

#endif /* SYZ_FFT_H */
