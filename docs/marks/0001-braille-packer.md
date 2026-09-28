# 0001 — Braille subpixel packer

- **WHAT** — Packs a 2×4 sub-pixel luminance macroblock into one Unicode Braille
  glyph (`U+2800 + bitmask`) and serializes it to 3-byte UTF-8. Plus integer
  BT.601 luminance. Pure integer, zero allocation, no FPU, no libc.
- **STATE** — **HEWN**. Functions now; proven by `tests/test_braille.c`.
- **RUNS** — `include/syz_braille.h`: `syz_luma8`, `syz_braille_bit`,
  `syz_braille_pack`, `syz_braille_codepoint`, `syz_braille_utf8`. Test result:
  **31 checks, 0 failures** (`sh tests/run.sh`).
- **SHORTCUT** — the threshold is a fixed scalar argument per call (exactly the
  seed's `threshold` parameter, blob:5831). It is applied strictly (`>`), so a
  subpixel whose luma *equals* the threshold does not light — this is a
  deliberate, tested choice for determinism.
- **ASSUMES** — the caller hands over an 8-point luminance macroblock already
  laid out as `cell[row0..3][col0..1]`. It makes **no** assumption about where
  those 8 points came from; a real source is shard **0004 (yuv-ingest)**, still
  DRAWN. It also assumes nothing about *where the output bytes go* — that is
  shard **0002 (arena)**.
- **BETTER-WHEN**
  - **0005 (fused)** exists: the fused pass will compute these masks straight
    from registers as it convolves, instead of materializing a `cell[][]` array
    first. Then this shard becomes the *definition* the fused loop inlines, not a
    separate staged step. This is invariant I2 made real.
  - an **adaptive threshold τ** (seed blob:8037) replaces the scalar threshold,
    so a dim scene still resolves structure instead of going all-dark (the same
    failure Chiaroscuro's Director hit — see its README "Honest ledger": a
    palette once "rendered zero photons"). The upgrade is a per-region τ.
  - a **SIMD lane** version (seed blob:3294) packs several cells per instruction.
- **SEED** — `docs/seed/blob.md`:
  - 923-959 — the JS `compileBrailleCell` reference (dot→bit mapping).
  - 5799-5900 — the C mechanics diagram and `chiaroscuro_fused_yuv_to_braille`
    (the `bitShiftTable {0,1,2,6}` / `{3,4,5,7}` this shard reproduces).
  - 8034-8053 — the bit-layout proof and UTF-8 serialization math.
- **NEXT** — 0002 (a place to write masks without malloc), 0004 (a real source
  of the 8 luminance points), then 0005 (fuse it into one pass).

**Why this shard first.** It is the most foundational testable piece in the
seed: pure integer, register-level, no GPU/sensor/network dependency, and it
sits at the *output* end of the pipeline (the Braille token is Syzygy's wire
symbol). Proving it fixes the one thing every later shard must agree on — the
exact bit→glyph mapping — so the crew can build upstream toward it from context.
