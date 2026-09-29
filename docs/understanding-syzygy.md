# Understanding Syzygy

*Front door. Refreshed for the production branch (suite 219, browser POC and wasm32 target on board). Written for two readers: a **visitor** with zero context, and a **practitioner** about to change something. Every claim below is either cited to a file in this repo or marked "not verified here". Companion articles: [the fused pass](the-fused-pass.md) (pipeline in depth), [the three invariants](invariants.md), [porting](porting.md), [how the claims are checked](verifying.md) and [diffuse by marks](diffuse-by-marks.md) (how the kernel was built). Back to the [README](../README.md).*

## 1. In one breath

Syzygy is a header-only, libc-free, float-free C kernel that turns an NV12 video frame into Braille/glyph/token cells plus a 16-bin spectrum in one loop over a fixed arena, with byte-identical output by construction, and a CRDT that lets replicas of those cells converge without a coordinator.

## 2. Why it exists

- **Re-executability.** The goal (README, `docs/marks/ARCHITECTURE.md`) is an output a stranger can recompute and get the *same bytes*. That rules out floats, `malloc`, and anything whose result depends on the target.
- **Performance plane, not a verifier.** Syzygy only produces measurements (the `measured` field of a verdict). Judging them belongs to a separate trust plane (README "Lineage").
- **Lineage.** Successor to Chiaroscuro, a text-art renderer; Syzygy fuses its stages. Code symbols use the `syz_` prefix (SCARF-5).

## 3. The mental model (read this part slowly)

### 3.1 The nouns

| noun | what it is | where |
|---|---|---|
| **arena** | one caller-provided buffer with a bump pointer; the only memory the kernel touches | `include/syz_arena.h` |
| **frame** | NV12 input: Y plane + interleaved UV plane, each with its own stride | `SyzNv12` in `include/syz_yuv.h` |
| **cell** | a 2×4 block of luma pixels; the unit of output. cols = w/2, rows = h/4 | `syz_yuv.h` |
| **mask** | 8 bits, one per dot of a cell; Braille glyph is `U+2800 + mask` | `syz_braille.h` |
| **glyph** | a line character (`─ │ ╱ ╲`) chosen from integer Sobel edge direction | `syz_glyph.h` |
| **tone** | a density-ramp character chosen by integer argmax against a 4×4 basis | `syz_ste.h`, `syz_fused_tone` |
| **spectrum** | 16-point FFT of one row's cell luma, plus `peak_bin` | `syz_fft.h` |
| **lattice cell** | a 12-byte `{r,g,b,code}` + Lamport clock `<t,node>`; merged by join | `syz_crdt.h` |

### 3.2 The fused pass

`syz_fused()` (`include/syz_fused.h`) does: ingest the frame under an arena *mark*, then **one** `for cy / for cx` loop that, per cell, computes luma, gathers the 8 taps into a local `cell[4][2]`, packs the Braille mask, selects the glyph, selects the tone, and (for one chosen row) collects luma for the FFT; after the loop it runs the 16-pt FFT and the peak argmax, then **rolls the arena back** to the mark. The five ingredients named in the README are: 3×3 conv, BT.601 luma `(77R+150G+29B)>>8`, 16-pt fixed-point FFT, argmax glyph, 8-dot Braille pack. Details and honest caveats (including that the 3×3 conv is *not* in the shipped loop) are in [the-fused-pass.md](the-fused-pass.md).

### 3.3 The three invariants

- **I1 — zero allocation, O(1) space.** Bump arena, `mark`/`rollback`. Witness: `tests/test_fused.c` checks arena offset equals the pre-frame mark after each frame and high-water is unchanged across 50 more frames.
- **I2 — register-resident fusion on integer math.** Two halves: (a) *integer only*, so output is target-independent; (b) *fusion*, witnessed by **fused == composed byte-for-byte** (`test_fused.c` runs the same frame through staged passes and compares). "Register-resident" is a property of the loop's shape; it is **not** proven from C (the compiler owns registers — `syz_fused.h` SHORTCUT 2).
- **I3 — CRDT convergence, no consensus.** `syz_crdt.h`: join is idempotent, commutative, associative. Witness: 40,000 random triples plus 6-replica/200-trial convergence in `tests/test_crdt.c`. In-memory only; no network shard exists yet.

### 3.4 The diffuse-by-marks method

The repo was built by a rotating crew with no shared memory. Each piece carries a **mark** in its file header and in `docs/marks/NNNN-*.md`:

| mark | meaning | do |
|---|---|---|
| **HEWN** | cut and proven by a passing test | build on it |
| **SHAPED** | code exists, no test | prove it or fix joins |
| **DRAWN** | chalked, no code | build when its `ASSUMES` hold |
| **SCARF** | seed contradicts itself; named, both sides cited, resolved | read the resolution before crossing |

Every mark states WHAT / STATE / RUNS / SHORTCUT / ASSUMES / BETTER-WHEN / SEED / NEXT (`docs/marks/MARKS.md`). `docs/marks/ledger.csv` is the append-only log. Currently all 8 shards are HEWN (`docs/marks/ARCHITECTURE.md` map). See [diffuse-by-marks.md](diffuse-by-marks.md).

## 4. Walkthrough (copy-paste)

Requirements: any C11 compiler, `sh`. Nothing else.

```sh
git clone <this repo> && cd Syzygy
sh tests/run.sh
```

Real output from this session (gcc 13.3.0), per-suite summary lines in order:

```
=== 31 checks, 0 failures ===      # test_braille  (0001 braille + 0003 glyph)
=== 29 checks, 0 failures ===      # test_arena    (0002)
=== 15 checks, 0 failures ===      # test_fft      (0006)
=== 31 checks, 0 failures ===      # test_yuv      (0004)
  info: golden fnv1a = 0x6dbdd1a8
  info: full-output golden fnv1a = 0x463de14b
test_fused: 61 checks, 0 failures  # 0005
test_ste: 24 checks, 0 failures    # 0007
=== 28 checks, 0 failures ===      # test_crdt     (0008)
```

31+29+15+31+61+24+28 = **219 checks, 0 failures**; exit code 0. `run.sh` prints per-suite lines only; `sh tools/suite-total.sh` runs it unchanged and prints the sum (`=== TOTAL: 7 suites, 219 checks, 0 failures ===`), matching ledger row `m0014` ("suite 219"). The jump from 201 came from V01, the mutation gauge, which found six planted bugs the fused-pass test missed; `test_fused.c` grew 18 checks to catch them ([verifying.md](verifying.md)). I also compiled `test_fused.c` at `-O0` and got the same `0x6dbdd1a8`.

**Browser POC and wasm32 (`docs/poc`, `wasm/`):** both are in the repo now. `docs/poc/syzygy.js` is a hand-written JavaScript port; `docs/poc/syzygy.wasm` is the *same C headers* compiled with `clang --target=wasm32 -ffreestanding -nostdlib` (6808 bytes, zero imports). Receipts this session:

```
node wasm/run.mjs
  info: wasm golden fnv1a = 0x6dbdd1a8
  ok  : wasm == JS port on 20/20 seeded random host-written frames (up to 160x96)
  ok  : wasm == JS port on 25/25 frame x param cases (mask, glyph, tone, spectrum, peak)
wasm: 6 checks, 0 failures
```

Open `docs/index.html` through any static server (`cd docs && python3 -m http.server`) and the page runs both engines on every frame and counts agreements; in headless Chromium it reported 150/150 frames identical and a 3/3 self-check.

## 5. The contract

1. **Byte-exact across targets.** Headers use only `<stdint.h>`/`<stddef.h>`, no FPU. Pinned by the golden FNV-1a `0x6dbdd1a8` over mask + tone + spectrum for the 32×16 synthetic frame (`tests/test_fused.c`, `GOLDEN_HASH`). *Verified here:* x86_64 gcc 13 and clang 18 at `-O0`/`-O2`/`-O3`; wasm32 (clang 18, run in Node's V8); an independent JavaScript port. *Not verified here:* aarch64 or a real microcontroller: the claim there rests on the integer-only design. [porting.md](porting.md) is the checklist for adding one.
2. **Invariants I1/I2/I3** as above, each with the named test.
3. **Receipt = 219 checks green** from `sh tests/run.sh` (summed by `tools/suite-total.sh`), plus the golden hash line, plus `node wasm/run.mjs`.
4. **Failure behaviour:** `syz_fused` returns `-1` on bad args, arena exhaustion, or too-small output, and always restores the arena mark.
5. **Preconditions that bite:** FFT input ≤ 4095 (cell luma ≤ 255 is safe); even width/height; FFT needs `cols >= 16` else `fft_valid = 0`; equal Lamport clocks from different values are a protocol violation (still merged deterministically).

## 6. Scars

- **SCARF-7, the seed's FFT rotates the wrong way.** The seed kernel swaps sine/cosine names and so computes `e^{+j}` (inverse) while its math says forward. `syz_fft.h` implements forward and checks against a double-precision DFT: worst error 2 LSB, bound 8 (`docs/marks/ARCHITECTURE.md`). Reimplementing from raw seed code inherits the bug.
- **SCARF-3, the seed does not compile.** Scalar declarations where arrays were meant. No seed block is `cc`-ready.
- **SCARF-4, luma is `>>8`, not 14-bit.** `>>14` belongs to FFT trig and YUV chroma. Green truncates to 149, not 150.
- **SCARF-1, "bit-reversal-free" FFT is aspirational;** the shipped FFT has an explicit bit-reversal pass.
- **SCARF-6 / DRAWN-vs-HEWN gaps.** Seed drafts say "shipped" for things that were not on disk. Also: the tokenizer is a *static* argmax; no training harness exists, so "learnable" is not true yet (`syz_ste.h` SHORTCUT).
- **Doc drift (fixed).** Until the production pass the top-level `README.md` still showed only 0001/0003 as HEWN and "31 checks" while the ledger said all eight and 201. The README was rebuilt; CI (`.github/workflows/ci.yml`) now re-runs every number it cites. If a number here and a test run disagree, trust the run.
- **Fused-pass caveats** (all from `syz_fused.h`): ingest is reused, so the NV12→plane staging still exists; 3×3 conv dropped; FFT window is one row; only basis columns 0,1 scored.

## 7. How it composes

- **Downstream users.** The P1 browser POC is now in this repo (`docs/poc/`, plus the landing page `docs/index.html`). Other consumers (`federated-tinyml-vessel`'s byte-exact contract, the P4 optimization-agent plan) are **not present in this repo**, so I cannot cite their code. What this repo *does* provide for them: a deterministic output with a pinned golden hash they can compare against, and a CRDT that merges cell grids order-independently. Treat any integration statement beyond that as a plan, not a fact.
- **Internal composition:** 0002 arena underlies all; 0004 feeds 0001/0003/0006; 0005 fuses them; 0007 supplies the tone argmax inside 0005; 0008 carries cells (transport, UDP, is the unbuilt 0009).

## 8. Next links

- [the-fused-pass.md](the-fused-pass.md) — stage-by-stage, with the code and its shortcuts.
- [invariants.md](invariants.md) — I1/I2/I3, each with the test that holds it.
- [porting.md](porting.md) — bringing the kernel up on new hardware.
- [verifying.md](verifying.md) — how the tests themselves are tested.
- [diffuse-by-marks.md](diffuse-by-marks.md) — the blueprint for building the next kernel this way.
- `docs/marks/ARCHITECTURE.md` and `docs/marks/ledger.csv` — the reconciliation and the reasoning log.
