# tests/ — the receipts that earn a HEWN mark

A shard is only HEWN when a test here proves it. A test is a **witness**: a thing
a stranger can re-run to check a claim, not a claim itself.

**Here now** (`sh tests/run.sh`; `sh tools/suite-total.sh` prints the sum):

| suite | shards | result |
|---|---|---|
| `test_braille.c` | 0001 braille + 0003 glyph | 31 checks, 0 failures |
| `test_arena.c` | 0002 arena (I1) | 29 checks, 0 failures |
| `test_fft.c` | 0006 fft (vs double-precision DFT) | 15 checks, 0 failures |
| `test_yuv.c` | 0004 yuv ingest | 31 checks, 0 failures |
| `test_fused.c` | 0005 fused pass (I2 witness, golden hashes) | 61 checks, 0 failures |
| `test_ste.c` | 0007 argmax tokenizer | 24 checks, 0 failures |
| `test_crdt.c` | 0008 crdt mesh (I3) | 28 checks, 0 failures |
| **total** | | **219 checks, 0 failures** |

**Convention** — the shards under test use no libc; only the harness does. When
you promote a DRAWN shard toward HEWN, add its test here, append its block to
`run.sh`, run it, and record the result line as the `witness` in
`docs/marks/ledger.csv`.

**Cross-target determinism** (invariant I2), once the DRAWN `test_cross_platform.sh`
here, now lives beside the suite rather than in it: `wasm/run.mjs` (wasm32 ==
native golden == JS port), `tools/wasm-native-drift-differ/` (C vs JS, 2405
frames) and `tools/port-probe/` (freestanding compile for six MCU targets).

**This directory is hashed.** The mutation gauge's catalog
(`tools/kernel-oracle-mutant-gauge/catalog.jsonl`) is bound to the bytes of
`include/` and `tests/`. After any change here, re-run
`node tools/kernel-oracle-mutant-gauge/gauge.mjs --write` and commit the catalog.
