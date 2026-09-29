# How the claims are checked

*Deep-dive. Written for two readers: a **newcomer** asking "why should I believe any of this?", and a **practitioner** deciding which check to run after a change. Back to the [README](../README.md). The verifier cells are marked in [`marks/V01-kernel-oracle-mutant-gauge.md`](marks/V01-kernel-oracle-mutant-gauge.md) and [`marks/V02-wasm-native-drift-differ.md`](marks/V02-wasm-native-drift-differ.md).*

## 1. In one breath

Every claim in this repository is tied to a command that a stranger can run, and the commands are themselves tested: planted bugs check that the tests would notice a mistake, and independent implementations check that the "same bytes everywhere" claim holds outside the one compiler that wrote them.

## 2. Why test the tests

A passing test suite only tells you the code agrees with the tests. If the tests are weak, a real bug passes too. Syzygy's central promise is that a result can be checked by comparing one number, and that is only worth something if the checks that pin the number are strong. So this repo goes one level further than "the tests pass" and measures how much the tests can catch.

## 3. Mental model: four layers of evidence

```
  layer 4  seed guard        the charter the marks cite has not moved          tools/seed-guard.sh
  layer 3  cross-impl        C == wasm32 == JS, field for field                wasm/run.mjs, V02 differ
  layer 2  oracle strength   planted bugs are caught by layer 1                V01 mutant gauge
  layer 1  shard tests       each header does what its mark says               tests/run.sh (219 checks)
```

- **Layer 1: the shard suite.** One C file per shard under `tests/`, 219 checks in total. The strongest ones are property tests rather than examples: brute-force oracles (2000 cases for the argmax tokenizer), a double-precision reference DFT for the FFT, 40,000 random triples for the CRDT laws, and **fused == composed** byte equality for the pass.
- **Layer 2: V01, the mutant gauge.** `tools/kernel-oracle-mutant-gauge/` holds 42 hand-written, documented bugs (off-by-one loop bounds, a swapped sine and cosine, a wrong rounding constant, a dropped clamp, a transposed index, arena lifecycle slips). It copies `include/` and `tests/` into a sandbox, plants one bug at a time, runs the **unmodified** `tests/run.sh`, and records which check caught it.
- **Layer 3: independent implementations.** V02 (`tools/wasm-native-drift-differ/`) runs the native C and the hand-written JavaScript port on 2405 seeded frames and reports the first field that differs, then shrinks the frame to a minimal repro. `wasm/run.mjs` does the same between the wasm32 build of the C and the JS port.
- **Layer 4: the seed guard.** Every mark cites line numbers in `docs/seed/blob.md`. `tools/seed-guard.sh` pins its sha256 so those citations cannot silently drift.

## 4. Walkthrough with real output

The gauge, re-deriving its whole catalog from scratch (~35 s):

```
$ node tools/kernel-oracle-mutant-gauge/gauge.mjs --verify
kernel-oracle-mutant-gauge: 42 mutants vs sh tests/run.sh
  F01  KILLED   fail   off-by-one syz_fused.h  <- "synth 32x16 padded: fused glyph == composed"
  F12  KILLED   fail   off-by-one syz_fused.h  <- "peak: Nyquist bin 8 is searched (8 is the max)"
  T01  KILLED   fail   swap       syz_fft.h    <- "bin0 == 16*100 = 1600+-2"
  ...
no surviving mutants: every planted bug is caught
verify: chain integrity ok; re-derivation IDENTICAL
```

The differ:

```
$ node tools/wasm-native-drift-differ/differ.mjs
drift-differ: 2405 cases (seed 0x5eed), 2405 valid, 0 rejected by C (invalid input)
  golden 32x16 synth: native 0x6dbdd1a8  port 0x6dbdd1a8  (pinned 0x6dbdd1a8)
  PASS: port is byte-exact vs native on every case
```

Everything at once, the way CI runs it:

```sh
sh tools/suite-total.sh                              # layer 1
node tools/kernel-oracle-mutant-gauge/selftest.mjs   # layer 2, fast (13 checks)
node tools/kernel-oracle-mutant-gauge/gauge.mjs --verify --strict
node tools/wasm-native-drift-differ/selftest.mjs     # layer 3 (27 checks)
node tools/wasm-native-drift-differ/differ.mjs
node wasm/run.mjs                                    # layer 3, wasm (6 checks)
sh tools/port-probe/cross.sh                         # compiles for six MCU targets
sh tools/seed-guard.sh                               # layer 4
```

## 5. Contract and receipt

- **Oracle strength 41/41 of the catalog** (one mutant, T05, is provably equivalent for N = 16 and excluded). Before the gauge existed it was 35/41: six real gaps, which is why `test_fused.c` grew from 43 to 61 checks. A mistake of the kinds in the catalog cannot reach a release without a named check failing.
- **The catalog is hash-chained.** Each entry's hash covers the previous one, and the chain's first link is the sha256 of `include/` + `tests/`. If someone edits a verdict by hand, or the tests change without re-running the gauge, `--verify` fails. Anyone can confirm the 41/41 figure is real rather than asserted.
- **2405 cases byte-exact between C and JS, and 45 between wasm and JS.** A browser, a desktop and anything else that matches the golden hash will draw the same picture from the same frame.
- **CI** (`.github/workflows/ci.yml`) runs all of the above on every push and pull request, on gcc and clang. The gauge runs with `--strict`, so a change that lets any catalogued bug slip through fails the build.

## 6. Scars

- **A 100% score is 100% of this catalog.** The 42 mutants were written by hand. An operator-level generator that mutates every `<`, `>>` and constant is V01's BETTER-WHEN.
- **The six survivors had one root cause.** The composed reference in `test_fused.c` calls some of the same helpers as the fused path, so a bug in a shared helper moves both sides together. The six were closed with independent checks (unit spectra with known peaks, boundary thresholds, a full-output golden hash); a reference that shares no code is still open.
- **One drift hid from 20,000 random cases.** V02's planted D4 (FFT rounding 8192 → 8191) only shows when a Q14 product lands exactly on a half-LSB, about 1 window in 12,000. It is now covered by four pinned witness windows and a 2000-window sweep. That is coverage, not a proof.
- **Verdicts assume one compiler.** A mutant that triggers undefined behaviour could in principle be judged differently elsewhere.

## 7. How it composes

Layer 1 is what the marks' HEWN states rest on ([diffuse-by-marks.md](diffuse-by-marks.md)); layer 2 measures layer 1; layer 3 is how I2 is held across targets ([invariants.md](invariants.md), [porting.md](porting.md)); the landing page ([`index.html`](index.html)) is layer 3 running live on a visitor's own device.

## 8. Next

- Extend the mutant catalog to the arena (0002) and the CRDT (0008); replace the hand catalog with an operator-level generator.
- Add the wasm build as a third column in V02's full fuzz suite.
- Write a composed reference that shares no code with the fused path.
