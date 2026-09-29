# The three invariants

*Deep-dive. Written for two readers: a **newcomer** who wants to know what Syzygy promises, and a **practitioner** who is about to change a header and needs to know what must not break. Front door: [understanding-syzygy.md](understanding-syzygy.md). Back to the [README](../README.md). The resolution of the seed into these three is in [`marks/ARCHITECTURE.md`](marks/ARCHITECTURE.md).*

## 1. In one breath

Syzygy makes three promises: it never asks for memory after start-up (**I1**), it computes every output with integer arithmetic in one pass, so any machine gets the same bytes (**I2**), and copies of its state held by different devices converge when they swap updates, in any order, with no one in charge (**I3**). Each promise is held by a test that fails if it breaks.

## 2. Why these three

The seed (`docs/seed/blob.md`) lists between three and five "invariants" depending on which draft you read. These are the three the rest of the design leans on:

- **I1 lets it run where there is no allocator.** A microcontroller, a WebAssembly module with no imports, a signal handler: none of these can safely call `malloc`. A kernel that only bumps a pointer inside a buffer it was handed runs in all of them, and its whole state can be dumped and inspected byte by byte.
- **I2 lets a stranger check a result.** Floating point can round differently across CPUs, compilers and optimisation levels. Integer arithmetic with fixed shifts cannot. If two devices run the same frame, they must produce the same bytes, so comparing one hash is enough to tell whether they saw the same thing.
- **I3 lets many devices share a picture without a server.** If merging is idempotent, commutative and associative, it does not matter whether updates arrive late, twice, or out of order. Every copy that has seen the same set of updates holds the same state.

The seed's work identity puts them side by side:

```
Work = [ Read(input) + Write(output) ]   I2: one read, one write per frame
     + O(N log N)                         the FFT: the only super-linear step
     + [ S_A ⊔ S_B ]                      I3: merge is a join, not a negotiation
```

## 3. Mental model

| | I1 · zero-allocation arena | I2 · integer fusion | I3 · join-semilattice sync |
|---|---|---|---|
| **Promise** | O(1) memory; no `malloc`/`free` | same input → same bytes, everywhere | same updates → same state, any order |
| **Mechanism** | bump pointer in a caller buffer; `mark`/`rollback` per frame | fixed-point shifts (`>>8` luma, Q14 FFT/chroma), argmax instead of softmax, one loop | `merge = max clock, per-field max on ties`; Lamport clocks |
| **Lives in** | `include/syz_arena.h` (0002) | `include/syz_fused.h` (0005) and the shards it composes | `include/syz_crdt.h` (0008) |
| **Held by** | `tests/test_arena.c`, I1 checks in `tests/test_fused.c` and `tests/test_yuv.c` | `fused == composed` and two golden hashes in `tests/test_fused.c`; `wasm/run.mjs`; the V02 drift differ | `tests/test_crdt.c` |
| **What breaks it** | a hidden allocation; a path that forgets to roll back | a float, an unguarded overflow, a reordering that changes rounding | a tie rule that is not associative |

### I1 in one picture

```
pool: [ ingest planes | per-cell RGB |             free              ]
      ^ mark (pre-frame)             ^ offset during the frame
after syz_fused():  offset == mark   (rolled back, success or failure)
high_water:         the most the pass ever needed, constant frame after frame
```

`syz_arena_alloc` returns `NULL` rather than growing; every caller checks. The arena's bounds checks are written so they cannot wrap around (`size > cap - aligned`, not `aligned + size > cap`), which is a deliberate fix over the seed.

### I2 has two halves

1. **Integer only.** No header includes anything but `<stdint.h>` and `<stddef.h>`. Products that could overflow 32 bits are widened to `int64_t` (edge magnitude, spectrum power). This half is what makes the output target-independent.
2. **Fusion.** The per-cell work happens in one loop over locals, and each output byte is written once. This half is about the cost, not the answer, which is why its test is **equality**: the fused pass must produce exactly what running the stages one after another produces. Whether the compiler keeps those locals in registers is *not* proven from C; that needs a disassembly or perf-counter witness (see §6).

### I3's tie rule

Two writes with the same Lamport clock should not happen (node ids are unique per writer). If they do anyway, "pick one" is not associative, so the merge takes the per-field maximum of `r`, `g`, `b` and `code`. That keeps it a true join: the order of merging still cannot matter.

## 4. Walkthrough with real output

```sh
sh tools/suite-total.sh     # runs tests/run.sh unchanged, then sums
```

I1 (from `test_arena`, 29 checks, and `test_fused`):

```
[over] over-allocation detected
  ok  : size > capacity -> NULL
  ok  : failed alloc does not move offset
  ok  : SIZE_MAX does not wrap
  ok  : near-SIZE_MAX does not wrap
...
  ok  : I1: offset == pre-frame mark after frame 1
  ok  : I1: high-water unchanged frame 1 -> 2 (O(1) space)
  ok  : 50 more frames: offset and high-water unchanged
  ok  : arena exhaustion -> -1, arena rolled back
```

I2 (from `test_fused`, 61 checks):

```
  ok  : random 48x24 padded: fused mask == composed (144 cells)
  ok  : random 48x24 padded: fused glyph == composed
  ok  : random 48x24 padded: spectrum + peak + valid == composed
  info: full-output golden fnv1a = 0x463de14b
  info: golden fnv1a = 0x6dbdd1a8
  ok  : determinism: two runs byte-identical
```

and across implementations:

```
node wasm/run.mjs
  info: wasm golden fnv1a = 0x6dbdd1a8
  ok  : wasm == JS port on 20/20 seeded random host-written frames (up to 160x96)
```

I3 (from `test_crdt`, 28 checks):

```
[laws] semilattice laws on 40000 random triples (narrow + wide domains)
  ok  : idempotent: a join a == a
  ok  : commutative: a join b == b join a
  ok  : associative: (a join b) join c == a join (b join c)
  ok  : duplicate delivery is a no-op: (a join b) join a == a join b
[converge] random order / duplication / gossip grouping
  ok  : 200 trials: all 6 replicas reach identical state under different random orders
```

## 5. Contract and receipt

What each number is for:

- **I1: the high-water mark is constant across 50 extra frames.** Memory use is fixed after the first frame, so you can size a static buffer once, at build time, and a long-running device never runs out mid-stream.
- **I2: `0x6dbdd1a8` on gcc and clang at `-O0`/`-O2`/`-O3`, on wasm32, and in the JS port.** A result produced on a phone's browser can be checked on a desktop, or on a microcontroller once one is brought up ([porting.md](porting.md)), by comparing one 32-bit number.
- **I3: six replicas, 200 random delivery orders, identical final state.** Devices can trade updates over a lossy, reordering link and still agree, with no server deciding who is right.

Receipt: `sh tools/suite-total.sh` → `=== TOTAL: 7 suites, 219 checks, 0 failures ===`. CI re-runs it on every push (`.github/workflows/ci.yml`).

## 6. Scars

- **"Register-resident" is the loop's shape, not a proven fact.** The equality test proves fusion is *correct*, not that values stay in registers. Ledger row `m0011`'s BETTER-WHEN asks for a disassembly or `perf stat` witness.
- **The composed reference shares code with the fused path.** That is why six planted bugs once survived (V01 found them, see [verifying.md](verifying.md)). A reference that shares nothing with the fused path is the open fix.
- **I1 is checked by offsets, not by static analysis.** A test proves the paths it exercises roll back. A static "no heap" check is still a BETTER-WHEN in `syz_arena.h`.
- **I3 is proven in memory only.** There is no UDP transceiver yet (shard 0009 is unbuilt), so convergence under real packet loss has not been measured.
- **Seed claims that were wrong.** The seed's luma used a 14-bit scale in one draft (SCARF-4: it is `>>8`), and its FFT rotated the wrong way (SCARF-7). Both would have silently broken I2's golden hash if transcribed.

## 7. How it composes

I1 is underneath everything: 0004 ingest, 0005 fused and 0008 grids all allocate from the arena and check for `NULL`. I2 is carried by 0001, 0003, 0004, 0006 and 0007 as the pieces, with 0005 as the loop that joins them. I3 carries 0005's output cells between devices. The wasm32 target, the port probe and the JS port are all ways of testing I2 on a new host.

## 8. Next

- [the-fused-pass.md](the-fused-pass.md): the loop that I2 is about, stage by stage.
- [porting.md](porting.md): take I2 to new hardware and prove it with the golden hash.
- [verifying.md](verifying.md): how the tests behind these invariants are themselves tested.
- Open work: a disassembly witness for register residency; a composed reference with no shared code; a UDP shard for I3 under loss.
