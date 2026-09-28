# 0003 — Bivariate glyph / edge selector

- **WHAT** — Chooses a glyph for a cell from two axes at once: edge **direction**
  picks a line glyph (`─ │ ╱ ╲`), flat **luminance** picks a tone-ramp char.
  Integer Sobel; no `atan2`, no `sqrt`, no FPU.
- **STATE** — **HEWN**. Functions now; proven by `tests/test_braille.c`.
- **RUNS** — `include/syz_glyph.h`: `syz_sobel_gx/gy`, `syz_edge_mag2`,
  `syz_ramp_char`, `syz_glyph_direction`, `syz_glyph_select`. Test result:
  **31 checks, 0 failures** (`sh tests/run.sh`).
- **SHORTCUT** — fixed 3×3 Sobel weights, a fixed 10-step ramp `" .:-=+*#%@"`,
  and direction quantized to 4 line glyphs — exactly the seed draft. The
  direction classifier reproduces the seed's `atan2` angle windows (22.5°/67.5°)
  with integer tangent comparisons (`4142/10000`, `24142/10000`) so the result
  is FPU-free and deterministic. Edge strength uses **squared** magnitude vs a
  squared threshold, avoiding `sqrt`.
- **ASSUMES** — the caller provides a **luminance sampler** callback
  `uint8_t L(x, y, ctx)` (OOB reads as 0), so this shard makes no decision about
  frame layout — that belongs to the fused pass (0005). It depends on **0001**
  only for `syz_luma8`.
- **BETTER-WHEN**
  - **0007 (tokenizer)** exists: the learnable straight-through argmax tokenizer
    replaces the fixed Sobel + ramp with a small trained basis
    (`chiaroscuro_ste.h`, seed blob:8171 is the real-now static form;
    blob:8080-8145 is the aspirational trainable form). This shard's fixed
    weights are the honest placeholder for that basis.
  - **0005 (fused)** exists: today the sampler is called ~9× per cell (a Sobel
    stencil re-reads neighbors); the fused pass keeps the 3 rows resident in
    registers and computes the gradient once per stride — the register-resident
    win of invariant I2.
- **NOTE on semantics (read this, it surprises people)** — the seed renders the
  **gradient direction**, not the edge tangent. A *vertical brightness boundary*
  produces a *horizontal gradient* and therefore a `─` glyph. This is faithful
  to the seed's `renderBivariateGrid` (blob:903-916) and is pinned in the test
  (`vertical boundary -> horizontal-gradient glyph`). If a future shard wants the
  glyph to trace the edge *tangent* instead, that is a new decision — open it in
  the ledger, do not just flip it.
- **SEED** — `docs/seed/blob.md`:
  - 862-921 — the JS `renderBivariateGrid` (Sobel + angle windows + ramp).
  - 8013-8021 — integer luminance and the parallel-gradient formulation.
  - 8171-8239 — `chiaroscuro_ste.h`, the static straight-through selector this
    shard's fixed basis stands in for.
- **NEXT** — 0007 (swap fixed weights for a learnable basis), 0005 (fuse the
  gradient into the single register pass).
