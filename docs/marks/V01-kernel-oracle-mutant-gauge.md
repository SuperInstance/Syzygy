# V01 — kernel-oracle-mutant-gauge (verifier cell: how strong is the oracle?)

- **WHAT** — Mutation testing of the **correctness oracle**, not the kernel: 42
  documented planted bugs in the fused pass and the shards it composes (off-by-one
  loop bounds, wrong shift, sin/cos swap, dropped clamp, transposed index, wrong
  rounding constant, tie rules, arena lifecycle), each run through the
  **unmodified** `tests/run.sh`. An un-gameable verifier is only as strong as its
  oracle; this measures the oracle.
- **STATE** — **HEWN**. `tools/kernel-oracle-mutant-gauge/selftest.mjs`: 13 checks,
  0 failures (catalog well-formed; pristine green; a lethal mutant is killed; the
  proven-equivalent mutant survives, so kills are not sandbox artefacts; hash chain
  deterministic + tamper-evident; committed catalog genesis == current tree).
- **RUNS** — `node tools/kernel-oracle-mutant-gauge/gauge.mjs [--write|--verify|--only IDS|--strict]`
  (~35 s). **Oracle-strength 41/41 = 100%** (T05 excluded: the bit-reversal
  `i < 14` bound is provably equivalent for N=16). Before hardening it was
  **35/41 = 85.4%**, survivors F12 (peak skips Nyquist bin 8), F13 (peak tie rule),
  F18 (fused-only edge-threshold off-by-one), Y02 (red chroma shift), G01
  (tan 22.5 constant), G03 (edge gate `>=`) — all closed in `tests/test_fused.c`.
  `catalog.jsonl` is hash-chained: `hash_i = sha256(hash_{i-1} || canon(entry_i))`,
  genesis = sha256 of `include/` + `tests/`; `--verify` re-derives it byte-identical.
- **SHORTCUT** — the catalog is hand-written (42 mutants), not generated from every
  operator site; a 100% score is 100% *of this catalog*. Equivalence of T05 is argued
  (data-independent permutation), not machine-proven. Verdicts assume one compiler;
  a UB mutant could in principle judge differently elsewhere.
- **ASSUMES** — 0001/0003/0004/0005/0006/0007 headers and `tests/run.sh` (the oracle
  under test); node >= 18 built-ins and a C11 `cc`. Nothing else.
- **BETTER-WHEN** — an operator-level generator (every `<`, `>>`, constant, index in
  `include/`) replaces the hand catalog; it runs in CI with `--strict` so any new
  survivor fails the build; the composed reference gets an implementation that
  shares NO code with the fused path (the root cause of the six survivors).
- **SEED** — invariant I2 (`docs/marks/ARCHITECTURE.md`); witness convention
  `tests/MARK.md`.
- **NEXT** — wire `selftest.mjs` + `gauge.mjs --strict` into CI; extend the catalog to
  0002 arena and 0008 crdt.
