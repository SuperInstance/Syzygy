/* =============================================================================
 * native_harness.c — the GOLDEN side of wasm-native-drift-differ.
 * Reads cases from stdin, one per line:
 *     w h y_stride uv_stride braille_thresh edge_thresh2 fft_row <yhex> <uvhex>
 * runs the real include/syz_fused.h on each, and prints one JSON line per case
 * with every output field. The harness owns the I/O and the arena buffer; the
 * kernel is exactly the shipped header, untouched.
 * ========================================================================== */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "syz_fused.h"

static int hexval(int c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Read one whitespace-delimited hex token of exactly n bytes into buf. */
static int read_hex(uint8_t *buf, size_t n) {
    size_t i; int c;
    do { c = getchar(); } while (c == ' ' || c == '\t');
    for (i = 0; i < n; i++) {
        int hi = (i == 0) ? hexval(c) : hexval(getchar());
        int lo = hexval(getchar());
        if (hi < 0 || lo < 0) return -1;
        buf[i] = (uint8_t)(hi * 16 + lo);
    }
    return 0;
}

static void put_u8s(const char *k, const uint8_t *v, size_t n) {
    size_t i; printf(",\"%s\":[", k);
    for (i = 0; i < n; i++) printf(i ? ",%u" : "%u", (unsigned)v[i]);
    printf("]");
}

int main(void) {
    unsigned w, h, ys, uvs, bt, row; long long e2;
    while (scanf("%u %u %u %u %u %lld %u", &w, &h, &ys, &uvs, &bt, &e2, &row) == 7) {
        size_t ny = (size_t)ys * h, nuv = (size_t)uvs * (h / 2), cells = (size_t)(w / 2) * (h / 4), i;
        size_t pool_n = 4 * (size_t)w * h + 4096;
        uint8_t *y = malloc(ny ? ny : 1), *uv = malloc(nuv ? nuv : 1), *pool = malloc(pool_n);
        uint8_t *mask = malloc(cells + 1), *tone = malloc(cells + 1);
        uint32_t *glyph = malloc((cells + 1) * sizeof *glyph);
        SyzArena a; SyzNv12 s; SyzFusedParams p; SyzFusedOut o; int rc;
        if (!y || !uv || !pool || !mask || !tone || !glyph) return 2;
        if ((ny && read_hex(y, ny) != 0) || (nuv && read_hex(uv, nuv) != 0)) {
            printf("{\"rc\":\"parse-error\"}\n"); return 3;
        }
        s.y = y; s.uv = uv; s.w = w; s.h = h; s.y_stride = ys; s.uv_stride = uvs;
        p.braille_thresh = (uint8_t)bt; p.edge_thresh2 = e2; p.fft_row = row;
        memset(&o, 0, sizeof o);
        o.cap = cells + 1; o.mask = mask; o.glyph = glyph; o.tone = tone;
        syz_arena_init(&a, pool, pool_n);
        rc = syz_fused(&a, &s, &p, &o);
        printf("{\"rc\":%d", rc);
        if (rc == 0) {
            printf(",\"cols\":%u,\"rows\":%u", (unsigned)o.cols, (unsigned)o.rows);
            put_u8s("mask", mask, cells);
            printf(",\"glyph\":[");
            for (i = 0; i < cells; i++) printf(i ? ",%u" : "%u", (unsigned)glyph[i]);
            printf("]");
            put_u8s("tone", tone, cells);
            printf(",\"spec_re\":[");
            for (i = 0; i < 16; i++) printf(i ? ",%d" : "%d", (int)o.spec_re[i]);
            printf("],\"spec_im\":[");
            for (i = 0; i < 16; i++) printf(i ? ",%d" : "%d", (int)o.spec_im[i]);
            printf("],\"peak_bin\":%u,\"fft_valid\":%d", (unsigned)o.peak_bin, o.fft_valid);
        }
        printf("}\n");
        fflush(stdout); /* line-at-a-time for the differ's persistent session */
        free(y); free(uv); free(pool); free(mask); free(tone); free(glyph);
    }
    return 0;
}
