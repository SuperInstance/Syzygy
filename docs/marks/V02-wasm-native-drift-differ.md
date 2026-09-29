# V02 — wasm-native-drift-differ (verifier cell: regression alarm for the POC)

- **WHAT** — Differential tester: native C fused pass (GOLDEN) vs the shipped
  browser port `docs/poc/syzygy.js`, on a seeded fuzz suite of NV12 frames. On drift
  it names the **first divergent output field** in pipeline order (cols, rows, mask,
  glyph, tone, spec_re, spec_im, peak_bin, fft_valid), the index and both values,
  and **shrinks** (dims -> params -> ddmin byte zeroing) to a minimal repro that
  still drifts in that same field.
- **STATE** — **HEWN**. `tools/wasm-native-drift-differ/selftest.mjs`: 27 checks,
  0 failures, ~3 s.
- **RUNS** — `node tools/wasm-native-drift-differ/differ.mjs [--cases N] [--sweep N]
  [--seed S] [--perturb ID] [--out repro.json] [--port file]`. Today: **PASS**,
  2405 default cases byte-exact (+15k extra fuzz over 3 seeds), golden **0x6dbdd1a8
  on both sides**. Planted one-op drifts (in memory; the shipped file is verified
  unmodified): D1 braille `>`->`>=` -> `mask`; D2 ramp /255->/256 -> `glyph`;
  D3 chroma >>14->>>13 -> `tone`; D4 FFT tr rounding 8192->8191 -> `spec_re`;
  D6 ti rounding -> `spec_im`; D5 peak `k<=8`->`k<8` -> `peak_bin`. Each repro
  drifts only with the planted op (clean on the pristine port).
- **SHORTCUT** — the "wasm" side is today the hand-written JS port; the C is built
  native. A sub-LSB drift (D4) evaded 20k plain fuzz cases (needs a Q14 product
  exactly on the half-LSB, ~1 in 12k windows); it is covered by four pinned
  half-LSB witness windows + a 2000-window FFT sweep, not by a proof. Inputs the C
  rejects (odd w, h<4, stride<w) are not generated, and the JS port does not
  validate them (a known behavioural gap, outside the byte-exact contract).
- **ASSUMES** — 0005 `syz_fused` via `native_harness.c` (harness owns I/O only);
  `docs/poc/syzygy.js` exports `syz_fused`, `fnv1a_fused`; node >= 18, C11 `cc`.
- **BETTER-WHEN** — the `wasm/` target (DRAWN) exists: add it as a third
  implementation so native == wasm == JS is checked on the same suite; run in CI on
  every change to `include/` or `docs/poc/`; the shrinker learns translation so a
  repro also moves toward the origin.
- **SEED** — invariant I2 cross-target determinism (`wasm/MARK.md`,
  `tests/MARK.md` "test_cross_platform.sh").
- **NEXT** — wasm32 build as the third column; CI hook.
