# Understanding Syzygy

*Front door. Written for two readers: a **visitor** with zero context, and a **practitioner** about to change something. Every claim below is either cited to a file in this repo or marked "not verified here". Companion articles: [the fused pass](the-fused-pass.md) (pipeline in depth) and [diffuse by marks](diffuse-by-marks.md) (how the kernel was built).*

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
test_fused: 43 checks, 0 failures  # 0005
test_ste: 24 checks, 0 failures    # 0007
=== 28 checks, 0 failures ===      # test_crdt     (0008)
```

31+29+15+31+43+24+28 = **201 checks, 0 failures**; exit code 0. Note `run.sh` does not print the total; that sum is mine, and matches ledger row `m0013` ("suite 201"). I also compiled `test_fused.c` at `-O0` and got the same `0x6dbdd1a8`.

**Browser POC (`docs/poc`): does not exist in this repository at this commit.** `ls docs` shows only `marks/` and `seed/`; `wasm/` is a DRAWN placeholder (`wasm/MARK.md`). I have not run a browser build and make no claim about one. Where the P1 browser POC lives, if anywhere, is not verifiable from this repo.

## 5. The contract

1. **Byte-exact across targets.** Headers use only `<stdint.h>`/`<stddef.h>`, no FPU. Pinned by the golden FNV-1a `0x6dbdd1a8` over mask + tone + spectrum for the 32×16 synthetic frame (`tests/test_fused.c`, `GOLDEN_HASH`). *Verified here:* x86_64 gcc at `-O2` and `-O0`. *Not verified here:* aarch64, wasm32 — the claim rests on the integer-only design, and `tests/MARK.md` lists the cross-target hash test as still to be written.
2. **Invariants I1/I2/I3** as above, each with the named test.
3. **Receipt = 201 checks green** from `sh tests/run.sh`, plus the golden hash line.
4. **Failure behaviour:** `syz_fused` returns `-1` on bad args, arena exhaustion, or too-small output, and always restores the arena mark.
5. **Preconditions that bite:** FFT input ≤ 4095 (cell luma ≤ 255 is safe); even width/height; FFT needs `cols >= 16` else `fft_valid = 0`; equal Lamport clocks from different values are a protocol violation (still merged deterministically).

## 6. Scars

- **SCARF-7, the seed's FFT rotates the wrong way.** The seed kernel swaps sine/cosine names and so computes `e^{+j}` (inverse) while its math says forward. `syz_fft.h` implements forward and checks against a double-precision DFT: worst error 2 LSB, bound 8 (`docs/marks/ARCHITECTURE.md`). Reimplementing from raw seed code inherits the bug.
- **SCARF-3, the seed does not compile.** Scalar declarations where arrays were meant. No seed block is `cc`-ready.
- **SCARF-4, luma is `>>8`, not 14-bit.** `>>14` belongs to FFT trig and YUV chroma. Green truncates to 149, not 150.
- **SCARF-1, "bit-reversal-free" FFT is aspirational;** the shipped FFT has an explicit bit-reversal pass.
- **SCARF-6 / DRAWN-vs-HEWN gaps.** Seed drafts say "shipped" for things that were not on disk. Also: the tokenizer is a *static* argmax; no training harness exists, so "learnable" is not true yet (`syz_ste.h` SHORTCUT).
- **Doc drift.** The top-level `README.md` still shows only 0001/0003 as HEWN and "31 checks"; the ledger and `ARCHITECTURE.md` say all eight are HEWN and the suite is 201. Trust the ledger and the test run. (I did not edit the README; this task was new files under `docs/` only.)
- **Fused-pass caveats** (all from `syz_fused.h`): ingest is reused, so the NV12→plane staging still exists; 3×3 conv dropped; FFT window is one row; only basis columns 0,1 scored.

## 7. How it composes

- **Downstream users** (`federated-tinyml-vessel` byte-exact contract, the P1 browser POC, the P4 optimization-agent plan): these are named in the task brief for this documentation, **not present in this repo**, so I cannot cite their code. What this repo *does* provide for them: a deterministic output with a pinned golden hash they can compare against, and a CRDT that merges cell grids order-independently. Treat any integration statement beyond that as a plan, not a fact.
- **Internal composition:** 0002 arena underlies all; 0004 feeds 0001/0003/0006; 0005 fuses them; 0007 supplies the tone argmax inside 0005; 0008 carries cells (transport, UDP, is the unbuilt 0009).

## 8. Next links

- [the-fused-pass.md](the-fused-pass.md) — stage-by-stage, with the code and its shortcuts.
- [diffuse-by-marks.md](diffuse-by-marks.md) — the blueprint for building the next kernel this way.
- `docs/marks/ARCHITECTURE.md` and `docs/marks/ledger.csv` — the reconciliation and the reasoning log.
