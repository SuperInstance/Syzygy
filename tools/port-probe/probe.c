/* probe.c — the smallest freestanding translation unit that pulls in every
 * kernel shard and runs the golden frame. Used by porting.md: compile it for a
 * new target (-ffreestanding, no libc) to prove the headers build there, then,
 * on real hardware or an emulator, read syz_probe_golden() and compare it with
 * 0x6dbdd1a8. No I/O on purpose: how you read one uint32 back is board-specific. */
#include "syz_fused.h"
#include "syz_crdt.h"

static uint8_t  y_plane[32 * 16], uv_plane[32 * 8], pool[4096];
static uint8_t  mask[64], tone[64];
static uint32_t glyph[64];

uint32_t syz_probe_golden(void) {
    SyzArena a; SyzNv12 s; SyzFusedParams p; SyzFusedOut o;
    uint32_t h = 2166136261u, i, n;
    syz_yuv_synth(y_plane, uv_plane, 32, 16, 32, 32);
    s.y = y_plane; s.uv = uv_plane; s.w = 32; s.h = 16; s.y_stride = 32; s.uv_stride = 32;
    p.braille_thresh = 100; p.edge_thresh2 = 4000; p.fft_row = 1;
    o.cap = 64; o.mask = mask; o.glyph = glyph; o.tone = tone;
    syz_arena_init(&a, pool, sizeof pool);
    if (syz_fused(&a, &s, &p, &o) != 0) return 0;
    n = o.cols * o.rows;
    for (i = 0; i < n; i++) { h = (h ^ mask[i]) * 16777619u; h = (h ^ tone[i]) * 16777619u; }
    for (i = 0; i < 16; i++) { h = (h ^ (uint32_t)o.spec_re[i]) * 16777619u;
                               h = (h ^ (uint32_t)o.spec_im[i]) * 16777619u; }
    return h;
}
