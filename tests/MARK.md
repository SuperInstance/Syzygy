# tests/ — the receipts that earn a HEWN mark

A shard is only HEWN when a test here proves it. A test is a **witness**: a thing
a stranger can re-run to check a claim, not a claim itself.

**Here now:**
- `test_braille.c` — 31 checks over shards 0001 (braille) + 0003 (glyph).
  Current result: **31 checks, 0 failures.**
- `run.sh` — builds and runs the suite with any C11 compiler, zero deps.
  `sh tests/run.sh`.

**Convention** — the shards under test use no libc; only the harness does. When
you promote a DRAWN shard toward HEWN, add its test here, run it, and record the
result line as the `witness` in `docs/marks/ledger.csv`. Cross-platform
determinism (invariant I2) is proven by comparing output hashes across targets —
a `test_cross_platform.sh` is the DRAWN next step here (seed blob:485, 4962).
