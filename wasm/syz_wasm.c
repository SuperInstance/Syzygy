/* =============================================================================
 * syz_wasm.c — the wasm32 export bridge for the Syzygy fused pass.
 * HASH MARK: HEWN — wasm/run.mjs rebuilds nothing and trusts nothing: it loads
 * the .wasm that wasm/build.sh produced from the SAME include/ headers the
 * native tests compile, runs the 32x16 synthetic frame, and requires the golden
 * FNV-1a 0x6dbdd1a8 (tests/test_fused.c GOLDEN_HASH). No libc, no FPU, no
 * allocation: every buffer below is a static array in linear memory.
 * SHORTCUT — one fixed frame size (up to MAXW x MAXH); the frame is synthesized
 * in-module (syz_yuv_synth) rather than passed in; the hash formula is copied
 * from test_fused.c rather than shared with it.
 * ========================================================================== */
#include "syz_fused.h"

#define MAXW 64
#define MAXH 32
#define MAXC ((MAXW / 2) * (MAXH / 4))

static uint8_t  y_plane[MAXW * MAXH], uv_plane[MAXW * (MAXH / 2)];
static uint8_t  pool[4 * MAXW * MAXH + 4096];
static uint8_t  mask[MAXC], tone[MAXC];
static uint32_t glyph[MAXC];
static SyzFusedOut out;

/* Run the fused pass on a synthetic w x h frame. Returns 0 ok, -1 failure. */
__attribute__((export_name("syz_run")))
int syz_run(uint32_t w, uint32_t h, uint32_t braille_thresh, int32_t edge_thresh2, uint32_t fft_row) {
    SyzArena a; SyzNv12 s; SyzFusedParams p;
    if (w > MAXW || h > MAXH) return -1;
    syz_yuv_synth(y_plane, uv_plane, w, h, w, w);
    s.y = y_plane; s.uv = uv_plane; s.w = w; s.h = h; s.y_stride = w; s.uv_stride = w;
    p.braille_thresh = (uint8_t)braille_thresh; p.edge_thresh2 = edge_thresh2; p.fft_row = fft_row;
    out.cap = MAXC; out.mask = mask; out.glyph = glyph; out.tone = tone;
    syz_arena_init(&a, pool, sizeof pool);
    return syz_fused(&a, &s, &p, &out);
}

/* FNV-1a over mask+tone (interleaved per cell) then spec_re/spec_im — the
 * exact formula of tests/test_fused.c GOLDEN_HASH. */
__attribute__((export_name("syz_golden")))
uint32_t syz_golden(void) {
    uint32_t h = 2166136261u, i, n = out.cols * out.rows;
    for (i = 0; i < n; i++) { h = (h ^ mask[i]) * 16777619u; h = (h ^ tone[i]) * 16777619u; }
    for (i = 0; i < 16; i++) { h = (h ^ (uint32_t)out.spec_re[i]) * 16777619u;
                               h = (h ^ (uint32_t)out.spec_im[i]) * 16777619u; }
    return h;
}

__attribute__((export_name("syz_cols")))     uint32_t syz_cols(void)     { return out.cols; }
__attribute__((export_name("syz_rows")))     uint32_t syz_rows(void)     { return out.rows; }
__attribute__((export_name("syz_peak_bin"))) uint32_t syz_peak_bin(void) { return out.peak_bin; }
__attribute__((export_name("syz_mask_ptr"))) uint8_t  *syz_mask_ptr(void)  { return mask; }
__attribute__((export_name("syz_tone_ptr"))) uint8_t  *syz_tone_ptr(void)  { return tone; }
__attribute__((export_name("syz_glyph_ptr")))uint32_t *syz_glyph_ptr(void) { return glyph; }
__attribute__((export_name("syz_spec_re_ptr"))) int32_t *syz_spec_re_ptr(void) { return out.spec_re; }
__attribute__((export_name("syz_spec_im_ptr"))) int32_t *syz_spec_im_ptr(void) { return out.spec_im; }
__attribute__((export_name("syz_fft_valid")))   int      syz_fft_valid(void)   { return out.fft_valid; }
