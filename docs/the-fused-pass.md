# The fused pass

*Pipeline in depth. Front door: [understanding-syzygy.md](understanding-syzygy.md). Back to the [README](../README.md). Source of truth: `include/syz_fused.h` and the shard headers it includes; this article explains them and does not replace them.*

## 1. In one breath

`syz_fused()` reads one NV12 frame and, in a single per-cell loop over an arena-scratch, emits a Braille mask, a glyph, a tone character per 2×4-pixel cell plus a 16-bin spectrum of one cell row, then hands the arena back exactly as it found it.

## 2. Why it exists

Composing the stages as separate full-plane passes reads and writes memory once per stage. Invariant I2 says the irreducible cost is one read plus one write (`docs/marks/ARCHITECTURE.md`, "Work" identity). Until the fused pass existed, I2 was a design; `tests/test_fused.c` made it a checked fact by proving the fused output equals the composed one.

## 3. Mental model

### The stages, in loop order

Per frame (`include/syz_fused.h`, `syz_fused`):

1. **Mark + ingest** (`syz_arena_mark`, `syz_yuv_ingest`, shard 0004). Produces, inside the arena: a packed luma plane, de-interleaved U/V (2×2 luma per chroma sample), and a per-cell RGB buffer. Chroma uses the seed's `>>14` coefficients (22971 / -5638 / -11700 / 29032); this is where 14-bit scaling lives (SCARF-4).
2. **Per cell `(cx,cy)`** (luma origin `bx=2cx, by=4cy`):
   - **Luma** `syz_luma8(r,g,b) = (77R+150G+29B) >> 8` (BT.601, weights sum 256) of the cell's RGB → `l`.
   - **Gather** 8 taps `cell[4][2]` via `syz_yuv_luma_at`.
   - **Braille pack** (0001): bit set iff tap `> braille_thresh`. Bit layout, left column rows 0–3 → bits 0,1,2,6; right column → 3,4,5,7. Glyph = `U+2800 + mask`.
   - **Glyph select** (0003): integer 3×3 Sobel at `(bx, by+1)`; if `gx²+gy² > edge_thresh2` a line glyph `─ │ ╱ ╲` chosen by integer tangent windows (22.5°/67.5°, no `atan2`, no `sqrt`); else a ramp char from luma.
   - **Tone** (0007): features `{luma, g, 0, 0}` dot-multiplied against the static 4×4 `SYZ_STE_BASIS`, first-maximum argmax `sel`; ramp index `luma*9/255 + sel`, clamped to 9, into `" .:-=+*#%@"`. No softmax, no exponentials.
   - **FFT window**: on row `fft_row`, the first 16 cells' luma go into `re[]`.
3. **After the loop:** `syz_fft16(re, im)` (0006), then `peak_bin = argmax_{k=1..8}(re²+im²)`, first max wins, 0 if all zero. Spectrum copied to caller-owned `SyzFusedOut`.
4. **Rollback** the arena to the mark, success or failure (I1).

### The FFT, precisely

`include/syz_fft.h`: in-place radix-2 DIT, 16 points, Q14 twiddles from **one** sine table `SYZ_SIN_TABLE[16]` (`sin(2πi/16)·16384`); cosine is `SIN[(i+4)&15]` (SCARF-2). Explicit bit-reversal pass (SCARF-1; "bit-reversal-free" is *not* claimed). Twiddle products are rounded (`+2^13`) then `>>14`. Unscaled: gain 16, so caller must keep `|re|,|im| ≤ 4095`. Forward direction `e^{-j}`, unlike the seed (SCARF-7). Accuracy witnessed by `tests/test_fft.c`: worst error 2 LSB vs a double-precision DFT over 200 random vectors, bound 8.

### What "fused" means here, honestly

Fusion is a property of the loop's *shape*: taps, `l`, mask, glyph, tone live in locals and each output byte is stored once. Whether the compiler keeps them in registers is not proven; the `syz_fused.h` BETTER-WHEN asks for a `perf stat` or disassembly witness. The proof that exists is **output equality** with the staged reference.

### Known gaps in the pass (each is a SHORTCUT in the header)

- **The seed's separate 3×3 smoothing convolution is not in the loop.** The seed's fused kernel had one; `syz_fused.h` drops it (SCARF-3 note) and the 0004 luma is the source. The only 3×3 convolution the loop runs is the Sobel pair inside glyph selection, and that is what the README diagram labels "3×3 Sobel convolution". Do not assume a smoothed-image output exists.
- Ingest is reused, so NV12 → planes staging is still materialized in the arena; "one read" is honest only at the cell loop.
- Inner calls are static-inline; the luma sampler is a function pointer the compiler may or may not devirtualize.
- Only basis columns 0 and 1 are scored (features 2,3 are zero).
- FFT window is one row; `cols >= 16` required else `fft_valid = 0`.

## 4. Walkthrough

```sh
sh tools/suite-total.sh  # runs tests/run.sh; 219 checks in total
```

To run just the fused witness (same flags as `run.sh`):

```sh
cc -std=c11 -O2 -Wall -Wextra -I include tests/test_fused.c -o /tmp/tf && /tmp/tf | tail -6
```

Real result this session (`-O2`; `-O0` gave the identical hash):

```
  info: golden fnv1a = 0x6dbdd1a8
  ok  : golden FNV-1a of mask+tone+spectrum matches pinned value
test_fused: 61 checks, 0 failures
```

Minimal call shape, mirroring `tests/test_fused.c`:

```c
static uint8_t y[32*16], uv[32*8], pool[65536], m[512], t[512]; static uint32_t g[512];
SyzArena a; syz_arena_init(&a, pool, sizeof pool);
syz_yuv_synth(y, uv, 32, 16, 32, 32);                       // synthetic NV12, no camera
SyzNv12 s = { .y=y, .uv=uv, .w=32, .h=16, .y_stride=32, .uv_stride=32 };
SyzFusedParams p = { .braille_thresh=100, .edge_thresh2=4000, .fft_row=1 };
SyzFusedOut o = { .cap=512, .mask=m, .glyph=g, .tone=t };
int rc = syz_fused(&a, &s, &p, &o);                          // 0 ok, -1 failure
```
(This snippet is adapted from the test's setup; I ran the test, not this exact snippet. `test_fused.c` uses larger buffers for its bigger cases; check field names in `include/syz_yuv.h` before pasting.)

## 5. Contract

- **fused == composed**, byte-identical for mask, glyph, tone, spectrum, peak on 5 frames (synthetic and random, padded strides) — `run_case` in `tests/test_fused.c`.
- **I1:** `syz_arena_used == pre-mark` after every call; high-water constant across frames.
- **Determinism:** two runs byte-identical; golden FNV-1a `0x6dbdd1a8` over mask + tone + spectrum (32×16 synthetic, `braille_thresh=100`, `edge_thresh2=4000`, `fft_row=1`).
- Outputs are caller-owned so they survive the rollback.

## 6. Scars

- Seed FFT sign bug (SCARF-7) — fixed in 0006, not in the seed.
- Seed "production" header doesn't compile (SCARF-3) — that's why the conv weights were dropped rather than transcribed.
- The luma-scale confusion (SCARF-4) leaked into drafts; a wrong scale here silently shifts every mask.
- Changing *anything* that feeds the hash (threshold, basis, ramp, rounding) moves `0x6dbdd1a8`; update `GOLDEN_HASH` only with a ledger row saying why.

## 7. How it composes

Upstream: 0002 arena, 0004 ingest. Peers: 0001, 0003, 0006, 0007. Downstream: 0008 CRDT carries cells; a UDP transceiver (0009) is unbuilt (`syz_crdt.h` NEXT). The wasm32 target is HEWN (`wasm/MARK.md`): the same pass, compiled freestanding, hashes to `0x6dbdd1a8` and matches the JS port field for field. aarch64 and `bench/` are still DRAWN; byte-exactness there is designed for, not yet measured. See [porting.md](porting.md).

## 8. Next links

- [understanding-syzygy.md](understanding-syzygy.md)
- [diffuse-by-marks.md](diffuse-by-marks.md)
- [invariants.md](invariants.md), [verifying.md](verifying.md), [porting.md](porting.md)
- The live version of this pass: [`docs/index.html`](index.html) (landing page) and [`docs/poc/`](poc/)
- `docs/marks/0005-fused.md`, `tests/test_fused.c`
