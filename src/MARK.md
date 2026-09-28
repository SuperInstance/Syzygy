# src/ — native orchestrators and .c translation units

- **STATE** — DRAWN. Empty of code on purpose; this mark is the placeholder, not
  a stub pretending to work.
- **WILL HOLD** — the native entry points that drive the header kernel: a main
  orchestrator loop (`syz_main.c`, seed blob:6284-6359), device ingest nodes
  (V4L2, seed blob:5930-5997), and any `.c` that must exist as a real translation
  unit rather than an inline header (e.g. the mmap logger, seed blob:4117-4178).
- **DEPENDS ON** — the header shards in `include/` reaching at least SHAPED.
  There is nothing to orchestrate until 0005 (fused) exists; building a `main`
  before then would orchestrate nothing.
- **CURRENT STATE** — the whole pipeline is still header-only and testable
  without a `main`. The first `.c` here should be the harness that runs 0005 end
  to end on synthetic frames (0004's SHORTCUT), so it can be seen, not just
  unit-tested.
- **SEED** — `docs/seed/blob.md` 6284-6359 (orchestrator), 5930-5997 (V4L2),
  4117-4178 (logger).
