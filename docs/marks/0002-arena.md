# 0002 — Zero-allocation arena

- **WHAT** — A fixed linear bump-pointer allocator: provision one backing buffer
  at boot, hand out 16-byte-aligned offsets into it, never `malloc`/`free`.
  This is invariant **I1** made concrete.
- **STATE** — **DRAWN**. No code cut yet; the seed already contains a correct,
  tiny implementation to transcribe (`core_arena_init` / `core_arena_alloc`).
- **RUNS** — nothing yet. Target surface: `include/syz_arena.h` with
  `syz_arena_init(a, buf, cap)`, `syz_arena_alloc(a, size, align) -> void*|NULL`,
  and `syz_arena_reset(a)`.
- **SHORTCUT (planned)** — a single monotonic bump pointer with no free list;
  reset is all-or-nothing. That is the seed's design and it is the right POC.
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
- **NEXT** — 0005 (the fused pass allocates its src/dst frames here), then a
  static-analysis / high-water witness so I1 is *checked*, not asserted.
