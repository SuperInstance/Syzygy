# 0004 — YUV / NV12 ingest

- **WHAT** — Decode a raw planar NV12 / YUV 4:2:0 frame into the luminance points
  and chroma the rest of the kernel consumes: the Y-plane gives the 8 subpixel
  luma values 0001 packs; the interleaved UV-plane gives 14-bit fixed-point
  chroma for truecolor. No `malloc`, no FPU.
- **STATE** — **HEWN**. `include/syz_yuv.h`, proven by `tests/test_yuv.c`.
- **RUNS** — `syz_yuv_ingest(arena, nv12, frame)` copies Y (stride stripped),
  de-interleaves UV into U/V planes (2x2 luma -> 1 chroma), and builds a per-cell
  RGB buffer (cell = 2x4 luma, seed centre-luma + `>>14` BT.601 chroma). Also
  `syz_yuv_luma_at`, `syz_yuv_luma_fn` (a `syz_luma_fn`, drops into 0003),
  `syz_yuv_chroma`, and `syz_yuv_synth` (closed-form test pattern). All four
  buffers come from the 0002 arena (16-byte aligned, NULL/-1 + rollback on
  exhaustion). `sh tests/run.sh` -> test_yuv: 31 checks, 0 failures; suite total
  106 checks (31+29+15+31).
- **SHORTCUT** — synthetic frames only; NV12 only (no I420/NV21/10-bit); even
  w/h, cols=w/2, rows=h/4 (partial rows dropped); nearest chroma (no bilinear);
  full-range YUV assumed; luma reuses `syz_luma8` (>>8, SCARF-4) — chroma keeps
  the seed's `>>14` coefficients.
- **ASSUMES** — 0002 (arena) for all buffers; 0001 `syz_luma8`; 0003
  `syz_luma_fn` type. Feeds 0001 (luma -> braille), 0003 (sampler -> glyph),
  0006 (luma window -> FFT), 0005 (fused).
- **BETTER-WHEN** — 0005 fuses ingest into the same pass so a pixel is decoded
  and packed without this RAM round-trip; a real V4L2 / WebRTC source replaces
  synthetic frames (blob:2588-2617, 5930-5997).
- **SEED** — `docs/seed/blob.md` 5814-5900 (`chiaroscuro_fused_yuv_to_braille`,
  chroma coefficients, uvOffset, centre luma), 5541-5615, 2588-2617.
- **NEXT** — **0005 (fused, now unblocked: all of 0001/0002/0003/0004/0006 are
  HEWN)**: call `syz_yuv_ingest` per frame under `syz_arena_mark/rollback`, feed
  cell luma to 0001/0003 and a luma window to 0006, then fuse the passes.
