# 0005 — The fused single pass (the syzygy proper)

- **WHAT** — `syz_fused(arena, nv12, params, out)`: one call runs Read(NV12) ->
  [ingest 0004 · glyph/edge 0003 · STE argmax · Braille pack 0001 · 16-pt FFT
  0006 · spectral-peak argmax] -> Write(mask/glyph/tone planes + spectrum). One
  per-cell loop; per-frame scratch under `syz_arena_mark`/`syz_arena_rollback`.
  Reuses the HEWN shards' functions; re-implements none of them.
- **STATE** — **HEWN**. `include/syz_fused.h`, proven by `tests/test_fused.c`.
  The I2 claim that is *witnessed*: **fused output is byte-identical to the
  composed reference** (same frame through 0004/0003/0001/0006 as separate staged
  full-plane passes). The stronger claim "provably register-resident" is NOT
  witnessed — see SHORTCUT and BETTER-WHEN.
- **ORACLE** — (m0014) hardened after `V01` mutation-tested this witness: now 61
  checks (suite 219), oracle-strength 41/41; adds `GOLDEN_FULL` 0x463de14b over
  every output field. The RUNS line below is the original 43-check receipt.
- **RUNS** — `sh tests/run.sh` -> test_fused: 43 checks, 0 failures; suite total
  149 (31+29+15+31+43). Five frame cases (synthetic padded-stride, two random
  NV12 frames, and a cols<16 case where FFT is invalid): mask, glyph, tone,
  spectrum, peak bin and fft_valid are memcmp-equal to the composed reference.
  I1: arena offset == pre-frame mark after every frame (incl. a nonzero
  pre-mark), high-water unchanged over 52 frames (O(1) space). Determinism: two
  runs byte-identical, and a pinned FNV-1a golden (0x6dbdd1a8) is identical at
  -O0 and -O2. Failure paths (exhaustion, too-small out, NULL) return -1 with the
  arena rolled back. The test caught a real bug on first run: with cols<16 the
  fused loop leaked a partial FFT window; fixed (window only when fft_valid).
- **SHORTCUT** — (1) `syz_yuv_ingest` is reused, not inlined, so luma/rgb staging
  planes still exist in the arena per frame; the "one read" is honest only at the
  cell loop, not from raw NV12. (2) "Register-resident" is the loop's shape,
  witnessed by output equality only; the C compiler owns register allocation, so
  it is not provable from C. (3) 0003/0001 are static-inline but the luma sampler
  is a function pointer. (4) Static [4][4] basis (0007 DRAWN), only columns 0,1
  scored as in the seed. (5) FFT window = first 16 cells of one cell row
  (`fft_row`); cols>=16 required. (6) The seed's 3x3 convolution is dropped (SCARF-3
  broken kernel; 0004 luma is the source). Outputs go to caller-owned planes, not
  straight to a wire buffer.
- **ASSUMES** — 0002 (scratch), 0004 (ingest + luma_fn), 0003 (glyph_select),
  0001 (pack, luma8), 0006 (fft16; cell luma <=255 meets its 12-bit bound).
- **BETTER-WHEN** — a perf-counter / instruction-count / disassembly witness
  (e.g. `perf stat` loads+stores per cell, or objdump showing no spills in the
  cell loop) turns register-residency from output-equal into proven; ingest is
  inlined into the loop (raw NV12 -> cell, no staging plane); SIMD lanes
  (blob:3294-3370, 7438-7525); 0007 supplies the learnable basis; the mask
  streams straight into the 0008 wire buffer.
- **SEED** — `docs/seed/blob.md` 8324-8420 (`chiaroscuro_fused_ste_pipeline`),
  3384-3536 (fused synergy kernel), 3312-3316 (SIMD lanes), 8171-8239 (basis).
- **NEXT** — 0007 (drop a learnable basis into the argmax slot) and 0008 (stream
  packed cells to the wire); and the perf-counter/disassembly witness so
  register-residency, not just equality, is checked.
