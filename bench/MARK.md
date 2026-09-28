# bench/ — jitter harness and the irreducible-work receipts

- **STATE** — DRAWN. This mark holds the space; no harness cut yet.
- **WILL HOLD** — a microsecond jitter harness (`syz_bench.c`, seed
  blob:4743-4788), a fault injector (blob:5062-5107), and the proof-reproduction
  runner that re-measures instruction counts and memory strides against a fixed
  seed (`make proofs`, seed blob:766-772).
- **DEPENDS ON** — 0005 (fused) being HEWN. You cannot benchmark the single-pass
  stride claim before the single pass exists; benchmarking the staged shards
  would measure the thing invariant I2 is meant to remove.
- **BETTER-WHEN** — the bench emits a **signed receipt** (a hash of the measured
  stride/instruction counts) rather than a printed number, so the "irreducible
  work bound" (seed blob:170-180, 8064-8067) becomes a re-checkable witness — the
  same posture the fleet uses for its rungs. Note: the seed's performance table
  (blob:503-516, "1.4 ms", "0.2 ms jitter") is a **claim from the drafts**, not a
  measurement taken here; the bench exists to replace those claims with receipts.
- **SEED** — `docs/seed/blob.md` 4743-4788 (jitter harness), 5062-5107 (fault
  injection), 7784-7865 (`profile_core.py` latency monitor), 766-772 (proofs).
