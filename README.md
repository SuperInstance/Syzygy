# Syzygy

**A freestanding C-ABI execution kernel that fuses spatial convolution,
fixed-point frequency analysis, subpixel glyph packing, and wire serialization
into a single register-resident pass. System-agnostic. Zero-allocation.
Re-executable by a stranger.**

Syzygy is a **performance plane** — the deterministic substrate on which a
separate verification layer can hold a verdict. It is *not* a verifier, not a
governance layer, not a co-option ledger. It produces measurements; it does not
decide truth. *(This is the one point all three seed drafts agree on:
`docs/seed/blob.md` 14-24, 252-257, 675-681.)*

> A *syzygy* is the alignment of distinct bodies on a single line. The kernel
> collapses three domains (spatial, spectral, symbolic), two streams (in, out),
> and three targets (native, wasm, bare-metal) onto one byte layout.

Predecessor: [**Chiaroscuro**](https://github.com/SuperInstance/chiaroscuro) —
a multi-engine text-art renderer that asked "when a pixel becomes a character,
what should the character know?" Chiaroscuro drew the line between light and
dark; Syzygy fuses the stages that drew it and points them at *signal → state*.

---

## This repository is being *diffused*, not shipped

Syzygy is still being shaped. It is built by a rotating crew who share no memory
and read each other's **marks** — a small, fixed vocabulary that tells the next
builder what a piece is, what already functions, what is only a sketch, and what
it is waiting on. If you are that next builder, start here:

- **[`docs/seed/blob.md`](docs/seed/blob.md)** — the **seed of record**
  (~9,535 lines, 3 README drafts + a component matrix + copy-paste code). It is a
  charter and is **never edited**. It contradicts itself in places by design.
- **[`docs/marks/ARCHITECTURE.md`](docs/marks/ARCHITECTURE.md)** — the seed
  resolved to **one** architecture, with every contradiction named as a SCARF
  joint and reconciled (both sides cited).
- **[`docs/marks/MARKS.md`](docs/marks/MARKS.md)** — the mark convention: the
  four hash marks (HEWN / SHAPED / DRAWN / SCARF) and what every shard must state.
- **[`docs/marks/ledger.csv`](docs/marks/ledger.csv)** — the append-only log of
  every mark laid. Replay it top to bottom and you have the whole build's
  reasoning, no memory required.

---

## The three invariants

Every design decision reduces to one of three commitments. (The seed's drafts
list overlapping sets of 3-5; these are the three the name and the irreducible
work identity actually rest on — see `ARCHITECTURE.md`.)

### I1 — Zero-allocation arena · O(1) space
No `malloc`/`free`/GC. A fixed linear arena, provisioned once, bump-pointer
allocation. Every byte of state is addressable, so a stranger can reconstruct the
engine's exact state from a dump. *Verifiability first, performance second.*

### I2 — Register-resident fusion on fixed-point integer math · irreducible stride
One read, one write; everything between resolved in registers. Integer-only, no
FPU, so output is **bit-identical on x86_64, aarch64, and wasm32**. Cross-target
determinism is what makes an output "re-executable by a stranger."

### I3 — Join-semilattice CRDT sync · no consensus
Merge is idempotent, commutative, associative; Lamport last-write-wins resolves
conflicts locally. No coordinator, no lock. Packet loss, reorder, and duplication
are non-events. The wire format is the packed memory layout.

The identity the whole seed converges on:

```
Work = [ Read(input) + Write(output) ]   (I2 · memory-stride limit)
     + O(N log N)                         (the FFT · arithmetic limit)
     + [ S_A ⊔ S_B ]                      (I3 · state-sync limit)
```

---

## Architecture

```
  raw sensor bytes (NV12 / YUV 4:2:0 / hydrophone PCM / telemetry)
                            │  one read
                            ▼
  ┌───────────────────────────────────────────────────────────┐
  │           FUSED SINGLE PASS  (resident in registers)        │
  │   1. 3x3 spatial convolution        (fixed-point / SIMD)    │
  │   2. integer luminance   (77R+150G+29B) >> 8   (BT.601)     │
  │   3. 16-point radix-2 FFT            (14-bit fixed-point)    │
  │   4. straight-through argmax glyph   (no softmax)           │
  │   5. 8-dot Braille pack   U+2800 + bitmask  -> UTF-8        │
  └───────────────────────────────────────────────────────────┘
                            │  one write  (wire == memory layout)
              ┌─────────────┼─────────────┐
              ▼             ▼             ▼
          terminal        disk         mesh (UDP · CRDT)
        truecolor       mmap log      join-semilattice
```

All state lives in a fixed arena (I1). The pass never leaves registers between
stages (I2). Distributed copies converge without consensus (I3).

---

## Honest status

**As of this branch, the repository held only the seed and a LICENSE.** Both of
the seed's "status" sections describe *intent*, not on-disk fact (the drafts even
disagree — one calls the CRDT mesh "shipped," another "in progress";
`ARCHITECTURE.md` SCARF-6). The truth is the table below: a piece is **HEWN**
only when a test in `tests/` proves it right now. Everything else is a mark
pointing forward.

| shard | file | serves | state | what is true right now |
|---|---|---|---|---|
| 0001 braille packer | `include/syz_braille.h` | I2 | **HEWN** | Packs 2×4 → `U+2800`+mask → UTF-8; integer BT.601 luma. **Tested: 31 checks, 0 failures.** |
| 0003 glyph engine | `include/syz_glyph.h` | I2 | **HEWN** | Integer Sobel → 4 line glyphs + tone ramp, atan2/sqrt-free. **Tested (same suite).** |
| 0002 arena | `include/syz_arena.h` | I1 | DRAWN | Bump allocator; seed has the exact code to transcribe. |
| 0004 yuv ingest | `include/syz_yuv.h` | I2 | DRAWN | NV12 → luma/chroma; start on synthetic frames. |
| 0005 **fused pass** | `include/syz_fused.h` | I2 | DRAWN | The syzygy proper — the one register-resident pass. **Until this exists, I2 is a design, not a fact:** 0001/0003/0006 are staged, not fused. |
| 0006 fft | `include/syz_fft.h` | I2 | DRAWN | 16-pt radix-2 fixed-point (with bit-reversal; "bit-reversal-free" is aspirational — SCARF-1). |
| 0007 tokenizer | `include/syz_ste.h` | I2 | DRAWN | Static integer argmax now; **trainable/differentiable is aspirational** — the seed's biggest real-vs-claimed gap (SCARF-6). |
| 0008 crdt mesh | `include/syz_crdt.h` | I3 | DRAWN | Join-semilattice + Lamport LWW; prove the algebra before the network. |

What is **aspirational** and should not be mistaken for working: the "shipped"
lists in the seed drafts (blob:193-201, 805-816); the "bit-reversal-free" FFT
(SCARF-1); the *learnable* tokenizer (SCARF-6); the performance figures
(blob:503-516 are draft claims, not measurements — `bench/` exists to replace
them with receipts); and any single copy-paste block compiling as-is (it does
not — SCARF-3).

---

## Run the proof-of-concept

```sh
sh tests/run.sh
```

Builds and runs the shard suite with any C11 compiler, zero dependencies. Expect
`=== 31 checks, 0 failures ===`. That is the whole current claim, and it is
re-checkable — which is the point.

---

## Repository layout (each directory carries a mark, never an empty stub)

```
syzygy/
├── README.md                 this file — one architecture, honest status
├── LICENSE
├── docs/
│   ├── seed/blob.md          SEED OF RECORD — never edited
│   └── marks/                the hash-mark substrate
│       ├── MARKS.md          the mark vocabulary
│       ├── ARCHITECTURE.md   the seed resolved; SCARF joints reconciled
│       ├── ledger.csv        append-only log of every mark laid
│       └── NNNN-*.md         one mark per shard (0001..0008)
├── include/                  the C-ABI header kernel  (MARK.md)
│   ├── syz_braille.h         HEWN · shard 0001
│   └── syz_glyph.h           HEWN · shard 0003
├── tests/                    the receipts that earn HEWN  (MARK.md)
│   ├── test_braille.c
│   └── run.sh
├── src/                      native orchestrators — DRAWN  (MARK.md)
├── wasm/                     freestanding wasm target — DRAWN  (MARK.md)
└── bench/                    jitter harness + proof receipts — DRAWN  (MARK.md)
```

---

## For the next shipwright

Recommended build order, each with the mark that points to it:

1. **0002 arena** (`docs/marks/0002-arena.md`) — the foundation everything writes
   through; the seed has correct code to transcribe.
2. **0004 yuv ingest** (`0004-yuv-ingest.md`) — a real source of pixels, starting
   synthetic so the pipeline is testable without a camera.
3. **0006 fft** (`0006-fft.md`) — self-contained and testable (impulse → flat
   spectrum); watch SCARF-1 and SCARF-2.
4. **0005 fused pass** (`0005-fused.md`) — the keystone; build it only after
   0001/0003/0004/0006 are at least SHAPED, so it fuses *proven* pieces. This is
   where invariant I2 stops being a design and becomes a fact.
5. **0008 crdt mesh** (`0008-crdt-mesh.md`) — prove the merge algebra in memory
   before adding UDP.

Read the mark, know the move. That is how this hull gets built.

---

## Lineage

- **Chiaroscuro** — the predecessor renderer; five text-art engines, the receipt
  of where Syzygy came from. Not superseded quietly — kept as provenance.
- **Syzygy** — this repo; the fused single-pass kernel. Signal → state.
- A separate **trust plane** (Pudd'nhead / Quilt-style verification) wraps Syzygy
  outputs in verdicts, tracks co-option, and holds dissent. Syzygy fills only the
  `measured` field. *(seed blob:408-433, 543-545.)*

## License

See [`LICENSE`](LICENSE).

---

*"The evidence was always there. Syzygy is how you hold up the slides."*
*(seed blob:226)*
