# 0007 — Straight-through argmax tokenizer

- **WHAT** — Glyph/token selection by a dot-product against a compact fixed basis
  followed by `argmax` — no softmax, no exponentials. Integer, register-level.
  During (future) training a straight-through estimator would pass gradients back
  unchanged; **that half does not exist yet.**
- **STATE** — **HEWN**. `tests/test_ste.c`: 24 checks, 0 failures (suite 173). Wired into 0005; fused == composed still byte-identical.
- **RUNS** — `include/syz_ste.h`: `syz_ste_select(feat, basis, n, k)`, `syz_ste_select4(feat[4], basis[4][4])`, `syz_ste_forward` (index + scores + one-hot), `syz_ste_backward` (STE gradients), `syz_ste_backward_identity`. Tie rule: first max wins. 0005 call site: `syz_fused_tone` -> `syz_ste_select4(feat, SYZ_STE_BASIS)`.
- **SHORTCUT** — the basis is the seed's **hardcoded** `[4][4]` (blob:8184), not learned (SCARF-6). Backward functions are the STE arithmetic only: no loss, no optimizer, no basis update; tested for algebra, not convergence. 0005 scores only columns 0,1 (features `{luma,g,0,0}`).
- **ASSUMES** — 0003 for the feature extraction it selects over; no arena needed. Consumed inside 0005.
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
- **NEXT** — a training harness (loss + basis update via `syz_ste_backward`) to earn "learnable"; then 0008 carries tokens over the wire.