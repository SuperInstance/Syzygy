# 0004 — YUV / NV12 ingest

- **WHAT** — Decode a raw planar NV12 / YUV 4:2:0 frame into the luminance points
  and chroma the rest of the kernel consumes: the Y-plane gives the 8 subpixel
  luma values 0001 packs; the interleaved UV-plane gives 14-bit fixed-point
  chroma for truecolor. No `malloc`, no FPU.
- **STATE** — **DRAWN**. The seed has the full chroma math to transcribe.
- **RUNS** — nothing yet. Target surface: `include/syz_yuv.h` with a
  `syz_luma_fn`-compatible sampler over a Y-plane (so it drops straight into
  0003's `syz_glyph_select`) plus `syz_yuv_chroma(y, uv, x, y) -> (r,g,b)`.
- **SHORTCUT (planned)** — start from **synthetic frames** (the seed's spinning
  sphere / test pattern, blob:1167-1205) so the whole pipeline is testable with
  no camera. A real device source (V4L2 native, WebRTC in wasm) is the upgrade.
- **ASSUMES** — 0002 (arena) for any staging buffer. Feeds 0001 (luma → braille),
  0003 (luma sampler → glyph), and 0006 (a luma/audio window → FFT).
- **BETTER-WHEN** — a **real V4L2 / WebRTC** source replaces synthetic frames
  (seed blob:2588-2617 V4L2, 5930-5997 device node); and when 0005 fuses ingest
  into the same pass so a pixel is decoded and packed without a RAM round-trip.
- **SEED** — `docs/seed/blob.md` 5814-5900 (`chiaroscuro_fused_yuv_to_braille`,
  the `22971/‑5638/‑11700/29032 >> 14` chroma coefficients and the UV offset
  math), 5541-5615 (fixed-point YUV→RGB), 2588-2617 (V4L2 frame grabber).
- **NEXT** — 0006 (feed a window to the FFT), 0005 (fuse ingest into the pass).
