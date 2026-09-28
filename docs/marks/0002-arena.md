# 0002 — Zero-allocation arena

- **WHAT** — A fixed linear bump-pointer allocator: provision one backing buffer
  at boot, hand out 16-byte-aligned offsets into it, never `malloc`/`free`.
  This is invariant **I1** made concrete.
- **STATE** — **HEWN**. `include/syz_arena.h` cut and proven.
- **RUNS** — `syz_arena_init/alloc/alloc16/reset/used/high_water/mark/rollback`.
  `sh tests/run.sh` -> `tests/test_arena.c`: 29 checks, 0 failures (distinct,
  16-aligned, in-bounds, reset, over-allocation, SIZE_MAX no-wrap, rollback).
- **SHORTCUT** — a single monotonic bump pointer with no free list;
  reset is all-or-nothing. That is the seed's design and it is the right POC. Failure returns NULL, arena unchanged; alignment must be a power of two. Hardened vs seed: wrap-safe capacity check. mark/rollback and high-water were added early.
- **ASSUMES** — nothing. This is the foundation: everything that writes output
  (0001's masks, 0004's decoded planes, 0005's fused frame, 0008's wire buffers)
  allocates from here. It depends on no other shard.
- **BETTER-WHEN** — a **scoped/marked** arena (save offset, roll back to it) lets
  the fused pass reuse scratch per-frame without a full reset; and a **bounds
  witness** (record high-water mark) turns "no heap" from a claim into a checked
  receipt — the verifiability half of I1.
- **SEED** — `docs/seed/blob.md` 8309-8323 (the exact `core_arena_alloc` with the
  `(current + alignMask) & ~alignMask` alignment and the capacity check), and
  262-272 (the invariant statement: "every byte of state is addressable").
- **NEXT** — 0004 (planes allocate here), 0005 (the fused pass allocates its src/dst frames here), then a
  static-analysis / high-water witness so I1 is *checked*, not asserted.
