# ARCHITECTURE — one honest reading of the seed

*The seed (`docs/seed/blob.md`, ~9,535 lines) is a charter, not a spec. It holds
three overlapping README drafts, a component matrix, and copy-paste code that
was written conversationally and **contradicts itself in places**. This document
resolves it to ONE architecture and records each contradiction as a SCARF joint
with both timbers cited and the chosen join stated. The seed is never edited;
this is where the reconciliation lives.*

---

## What Syzygy is (resolved)

Syzygy is a **freestanding C-ABI execution kernel** that fuses four operations
into a single register-resident pass over a fixed memory arena, then serializes
the result as its own wire format:

1. **Spatial convolution** — 3×3, fixed-point integer (SIMD where available,
   scalar fallback otherwise). *(seed blob:3294, 8325)*
2. **Integer perceptual luminance** — ITU-R BT.601, `(77·R + 150·G + 29·B) >> 8`.
   *(seed blob:8018, 8208)*
3. **16-point radix-2 fixed-point FFT** — 1-D, for a temporal/acoustic sample
   window, 14-bit integer trig. *(seed blob:3236, 7322)*
4. **Straight-through argmax glyph/token selection** — a dot-product against a
   compact fixed basis, no softmax, no exponentials. *(seed blob:8171)*
5. **8-dot Braille subpixel packing** — `U+2800 + bitmask` → UTF-8, the wire
   token. *(seed blob:5799, 8034)*

Distributed copies converge through a **join-semilattice CRDT** (idempotent,
commutative, associative) with Lamport last-write-wins, where the wire format is
the memory layout. *(seed blob:7940-7978)*

Syzygy is a **performance plane**. It is explicitly **not** a verifier, a
governance layer, or a co-option ledger. It fills the `measured` field of a
verdict; a separate trust plane fills `constitution`, `dissent`, `effects`.
*(seed blob:14-24, 252-257, 675-681)* — all three README drafts agree on this,
and it is the one point of total agreement in the seed.

**Lineage.** The predecessor is **Chiaroscuro**
(`github.com/SuperInstance/chiaroscuro`), a multi-engine text-art renderer
(five engines: Glyph/Tone, Pixel/Block, Braille, Shape-match, Halftone) that
answered "when a pixel becomes a character, what should the character know?"
Chiaroscuro drew the line between light and dark; Syzygy fuses the stages that
drew it into one pass and points them at *signal → state*, not just *light →
glyph*. Every C symbol in the seed is still named `chiaroscuro_*`; Syzygy is the
rename in progress (see SCARF-5).

---

## The three invariants (resolved)

The drafts list overlapping sets of three-to-five commitments. Resolved to the
three that the name and the "irreducible work identity" actually rest on:

### I1 — Zero-allocation arena, O(1) space
No `malloc`/`free`/GC. A fixed linear arena, bump-pointer allocation, 16-byte
aligned. Every byte of state is addressable, so a stranger can reconstruct the
engine's exact state from a dump. *This is a verifiability property first and a
performance property second.* *(seed blob:35-37, 262-272, 635-639)*

### I2 — Register-resident fusion on fixed-point integer math, irreducible stride
One read, one write; everything between resolved in registers. Integer-only
(no FPU) so the output is **bit-identical on x86_64, aarch64, and wasm32**.
Determinism across targets is the load-bearing consequence — it is what makes an
output "re-executable by a stranger." This fuses draft-2's separate "fixed-point"
and "single-pass fusion" invariants, because neither is load-bearing without the
other. *(seed blob:39-54, 274-302, 655-671)*

### I3 — Join-semilattice CRDT sync, no consensus
Merge is idempotent, commutative, associative; Lamport LWW resolves conflicts
locally; no coordinator, no lock. Packet loss/reorder/duplication are non-events.
The wire format is the packed memory layout. *(seed blob:56-60, 314-324, 7940-7978)*

> **Where did "no softmax / straight-through argmax" go?** Drafts 2 and 3 list it
> as an invariant. It is real and it ships (as a *static* integer argmax, shard
> 0007), but it is a property of the **tokenizer**, not of what makes the system
> re-executable-by-stranger. Demoting it from invariant to capability is a
> deliberate call — see SCARF-6. It is still a first-class shard.

The irreducible work identity the whole seed converges on:

```
Work = [ Read(input) + Write(output) ]   (I2, memory-stride limit)
     + O(N log N)                         (the FFT's arithmetic limit)
     + [ S_A ⊔ S_B ]                      (I3, state-sync limit)
```
*(seed blob:170-180, 655-671, 7980-7982, 8064-8067)*

---

## The scarf joints (contradictions in the seed, resolved)

Each joint is cited on both sides. Build across a joint only after reading its
resolution. Re-open a joint in `ledger.csv` if you disagree — do not silently
build the other draft.

### SCARF-1 — FFT bit-reversal: "free" vs. present
- **Timber A:** README drafts 1 & 3 call the FFT "no bit-reversal" /
  "bit-reversal-free" *(blob:78, 806)*.
- **Timber B:** the actual FFT kernel `chiaroscuro_fft_fixed` contains an
  explicit iterative bit-reversal permutation pass *(blob:3249-3266)*. A later
  "supersymmetric" sketch claims to replace it with a static shuffle mask
  *(blob:8028-8029)*.
- **Join (real-now):** the honest radix-2 FFT **has** a bit-reversal pass
  (Timber B). "Bit-reversal-free" is **aspirational** and requires the static
  shuffle-mask / fully-unrolled 16-point DFT that does not exist yet. Shard 0006
  is DRAWN as the bit-reversal version; a `BETTER-WHEN` note points at the
  unrolled form.

### SCARF-2 — the trig table has two phasings
- **Timber A:** `CU_SIN_TABLE` starts at `0` (sine-phased) *(blob:3240-3243)*.
- **Timber B:** `ULTIMATE_TRIG_TABLE` starts at `16384` (cosine-phased)
  *(blob:8305-8308)*.
- **Join:** use **one** 16-entry sine-phased table (Timber A) and derive cosine
  by the `+4` (quarter-period) index offset the FFT already uses
  (`CU_SIN_TABLE[(i+4)%16]` as cos) *(blob:3275-3276)*. Timber B is a duplicate
  written in a different phase and is treated as a transcription variant, not a
  second source of truth.

### SCARF-3 — the "production" header does not compile
- The unified header declares `ULTIMATE_STE_BASIS_WEIGHTS` and
  `ULTIMATE_TRIG_TABLE` as **scalar** `u_i32 X = { ...nested braces... }`
  (missing `[4][4]` / `[16]`) *(blob:8299-8308)*, and `ConvKernel` as
  `u_i32 weights;` (scalar) while every user indexes `kernel->weights[i]`
  *(blob:8288-8291, 8348)*.
- **Join:** these are **seed transcription errors**. The correct forms exist
  elsewhere in the same seed: `ST_LEARNABLE_BASIS_WEIGHTS[4][4]` *(blob:8184)*
  and a 9-element convolution weight array used by the fused pipeline
  *(blob:8348)*. Shards use the correct forms; the "production" header is not a
  buildable source, it is a sketch. **The copy-paste seed does not compile
  as-is** — do not treat any single seed block as ready to `cc`.

### SCARF-4 — luminance scale: "14-bit" vs. `>>8`
- **Timber A:** draft 2 says luminance uses "14-bit scaled integer weights"
  *(blob:276)*.
- **Timber B:** every luminance formula is `(77R+150G+29B) >> 8` — 8-bit scaled,
  weights summing to 256 *(blob:8019, 8208)*.
- **Join:** **luminance is 8-bit scaled** (`>>8`, Timber B). The 14-bit scaling
  is real but belongs to the **FFT trig table** and the **YUV→RGB chroma
  coefficients** (`>>14`) *(blob:5880-5882)*, not to luminance. The drafts
  conflated the two. Shard 0001 implements `>>8` and its test pins the honest
  truncated outputs (green = 149, not 150).

### SCARF-5 — the name: Chiaroscuro vs. Syzygy
- The prose is renamed to **Syzygy**; every code symbol is still
  `chiaroscuro_*` *(blob throughout)*.
- **Join:** **Syzygy** is the kernel/repo; new symbols take a `syz_` prefix
  (see shards 0001/0003). **Chiaroscuro** is the named predecessor and is not
  erased — it is the receipt of where this came from *(blob:184-187, 790-797)*.

### SCARF-6 — what is actually shipped
- **Timber A:** draft 1 lists arena, fused kernel, NV12, UDP CRDT mesh, mmap
  logger, WASM export as **shipped** *(blob:193-201)*.
- **Timber B:** draft 3's checklist marks CRDT/logger/verification hooks as
  **in progress** and bare-metal/WebGPU as **planned** *(blob:805-816)*.
- **Join (the honest one):** **nothing was in the repo but the seed and a
  LICENSE.** Both draft status sections describe intent, not on-disk fact. The
  true status is the status table in the top-level `README.md`, and the only
  HEWN pieces are the ones with a passing test in this branch (0001, 0003).
  Everything else is DRAWN. A draft that says "shipped" is a *plan*, and the
  mark says so.

### SCARF-7 — the seed FFT rotates the wrong way (a seed bug)
- **Timber A:** the math section defines the **forward** DFT, `e^{-j2πkn/N}` *(blob:3236-3292)*.
- **Timber B:** the seed kernel swaps the sine/cosine names at *(blob:3275-3276)*, so it actually rotates by `e^{+j}` — the inverse direction — contradicting its own math.
- **Join:** shard 0006 (`syz_fft.h`) implements the **forward** transform the math defines and verifies it against a double-precision reference DFT (worst error 2 LSB over 200 random full-scale vectors, bound 8). The seed's swapped names are a **bug in the seed of record**; we do not edit the seed — we correct it in the shard and witness the correction here. Anyone reimplementing from the raw seed code alone would inherit the sign error — read this joint first.

---

## The map of shards

| id | shard | serves | state |
|---|---|---|---|
| 0001 | `syz_braille.h` — 8-dot Braille packer | I2 | **HEWN** |
| 0002 | `syz_arena.h` — zero-allocation arena | I1 | **HEWN** |
| 0003 | `syz_glyph.h` — bivariate glyph/edge selector | I2 | **HEWN** |
| 0004 | `syz_yuv.h` — NV12/YUV 4:2:0 → luma/chroma ingest | I2 | **HEWN** |
| 0005 | `syz_fused.h` — the single register-resident pass | I2 | **HEWN** |
| 0006 | `syz_fft.h` — 16-point radix-2 fixed-point FFT | I2 | **HEWN** |
| 0007 | `syz_ste.h` — straight-through argmax tokenizer | I2 | DRAWN |
| 0008 | `syz_crdt.h` — join-semilattice mesh + Lamport LWW | I3 | DRAWN |

The dependency spine: **0002 (arena)** underlies everything that writes output;
**0004 (yuv)** feeds **0001/0003/0006**; **0005 (fused)** is the syzygy proper —
the one pass that makes 0001+0003+0006 *register-resident* instead of staged;
**0008 (crdt)** carries the packed cells over the wire. Build order recommended
in the top-level `README.md` status table and in each DRAWN mark's `NEXT`.
