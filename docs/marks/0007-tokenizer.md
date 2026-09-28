# 0007 — Straight-through argmax tokenizer

- **WHAT** — Glyph/token selection by a dot-product against a compact fixed basis
  followed by `argmax` — no softmax, no exponentials. Integer, register-level.
  During (future) training a straight-through estimator would pass gradients back
  unchanged; **that half does not exist yet.**
- **STATE** — **DRAWN**. The real-now static form is fully specified in the seed
  (`chiaroscuro_ste.h`); shard 0003 already carries a fixed-basis placeholder.
- **RUNS** — nothing standalone yet. Target surface: `include/syz_ste.h` with
  `syz_ste_select(features, basis[N][K]) -> glyph_index` and the `[4][4]` basis.
- **SHORTCUT (planned / SCARF-6)** — the basis is a **hardcoded** `[4][4]`
  integer table (blob:8184), not learned. Argmax is a plain integer scan. This is
  honest: it is the inference path only.
- **ASSUMES** — 0002 (arena) for any feature staging; 0003 for the feature
  extraction it selects over. Consumed inside 0005.
- **BETTER-WHEN** — a **training harness with gradients** makes the basis
  learnable (seed blob:8080-8145: softmax-gated embeddings during training,
  argmax at inference, `∂Y/∂X ≈ 1` STE). Only then does "differentiable
  tokenizer" become true rather than aspirational. This is the seed's biggest
  real-vs-aspirational gap — the drafts describe a trainable encoder; what ships
  is a fixed lookup. Marked loudly so no one mistakes one for the other.
- **NOTE** — this is why the top-level invariant list demotes "no softmax" from
  an *invariant* to a *capability* (ARCHITECTURE.md SCARF-6): it is a real and
  valuable property of the tokenizer, but it is not what makes an output
  re-executable by a stranger (that is I1+I2).
- **SEED** — `docs/seed/blob.md` 8171-8239 (`chiaroscuro_ste.h`, the static
  selector), 8080-8145 (the differentiable/trainable model), 304-312 (the STE
  invariant claim).
- **NEXT** — 0005 (use it as the selection step in the fused pass), then a
  training harness to earn the "learnable" claim.
