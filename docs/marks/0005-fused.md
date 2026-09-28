# 0005 — The fused single pass (the syzygy proper)

- **WHAT** — The one register-resident loop that *is* Syzygy: for each cell,
  convolve (3×3), compute integer luminance, feed the temporal window to the FFT
  (0006), select a glyph/token (0003/0007), pack the Braille mask (0001), and
  write the packed cell **once** — no intermediate RAM write-back between stages.
  This is invariant **I2** made real.
- **STATE** — **DRAWN**. This is the keystone; it should be built only after the
  pieces it fuses are HEWN, so their behavior is pinned before they are inlined.
- **RUNS** — nothing yet. Target surface: `include/syz_fused.h` with
  `syz_fused_pass(const SyzFrame *src, SyzFrame *dst, const SyzKernel *k, ...)`,
  modeled on the seed's `chiaroscuro_fused_ste_pipeline`.
- **SHORTCUT (planned)** — the first cut may still stage a `dst` frame (one write
  per cell) rather than streaming straight to the wire; that already achieves the
  "one write" stride. True zero-copy to the UDP/serializer buffer is the upgrade.
- **ASSUMES** — 0001 (braille pack), 0003 (glyph), 0004 (ingest), 0006 (fft),
  and 0002 (arena for src/dst). **Do not build this before those are at least
  SHAPED** — fusing unproven pieces hides which one is wrong.
- **BETTER-WHEN** — the SIMD lane kernels (seed blob:3294-3370, 7438-7525) turn
  the scalar per-cell loop into vector strides; and when 0004 ingest is fused in,
  so a raw NV12 byte becomes a packed Braille cell in a single register pass.
- **CAUTION (SCARF-3)** — the seed's "production" fused header does **not**
  compile as written (`ConvKernel.weights` is scalar but indexed as an array;
  `ULTIMATE_STE_BASIS_WEIGHTS` misses its `[4][4]`). Use the corrected forms:
  a 9-element convolution weight array (blob:8348) and `[4][4]` basis
  (blob:8184). See `ARCHITECTURE.md` SCARF-3.
- **SEED** — `docs/seed/blob.md` 3384-3536 (the fused synergy kernel),
  8324-8420 (`chiaroscuro_fused_ste_pipeline`), 3312-3316 (SIMD lanes).
- **NEXT** — this is where a downstream shipwright makes the invariant true;
  after it is HEWN, the arena high-water witness (0002 BETTER-WHEN) can *check*
  the one-read/one-write claim instead of asserting it.
