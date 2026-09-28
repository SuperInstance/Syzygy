# 0008 — Join-semilattice CRDT mesh

- **WHAT** — Conflict-free replicated state for a fleet of nodes: each cell holds
  a packed value `{r,g,b,code}` plus a Lamport clock `<t, node>`; merge is a join
  `⊔` that is idempotent, commutative, associative, resolving conflicts by
  last-write-wins. No coordinator, no lock. Invariant **I3**.
- **STATE** — **HEWN**. `include/syz_crdt.h`, proven by `tests/test_crdt.c`.
- **RUNS** — `syz_lamport_gt`, `syz_cell_merge` (the join), `syz_cell_leq/eq`,
  `syz_lamport_tick`, arena-resident `SyzCrdtGrid` (`syz_crdt_grid_init`,
  `_write`, `_merge_cell`, `_merge_grid`, `_grid_eq`, `_digest`).
  `sh tests/run.sh` -> test_crdt: 28 checks, 0 failures (suite 201). As
  executable properties over 40,000 random triples (narrow domains to force clock
  ties, plus wide domains): idempotent, commutative, associative, join is an upper
  bound, duplicate delivery is a no-op, bottom (t==0) is identity. Convergence: 6
  replicas x 200 trials x 400 updates each applied in a different random order
  with random duplication all reach identical state, equal to a fixed-order
  reference; sharded updates + random pairwise gossip converge to the join of all.
- **TIE RULE (resolves the CAUTION)** — equal clocks merge **per field**:
  `max(r), max(g), max(b), max(code)` independently (blob:7957 scalar `max`
  extended componentwise). The join is "max clock, componentwise max of the
  values carrying it", which is associative (a lexicographic pick of one whole
  value is not guaranteed to be). Recorded in `ledger.csv`.
- **SHORTCUT** — pure in-memory algebra, no packet format, no sockets. Whole-cell
  state-based merge (no deltas). 32-bit clock saturates at `UINT32_MAX` (bounded
  lattice). Node ids must be unique per writer; two different values with the
  same clock is a protocol violation, merged deterministically anyway.
- **ASSUMES** — 0002 (cell array allocated from the arena; NULL/-1 on
  exhaustion). Cells are produced by 0001/0005 and carried opaquely.
- **BETTER-WHEN** — the real **lossy-network convergence test over UDP** with
  adversarial reorder/drop/duplicate (a later shard) turns these in-memory laws
  into a receipt under actual loss; and the per-field tie rule is validated
  against a real fleet workload.
- **SEED** — `docs/seed/blob.md` 7940-7978 (semilattice + LWW proof), 3824-3866
  (`chiaroscuro_fleet.h` node/bin layout), 7707-7778 (transceiver, not built here).
- **NEXT** — the UDP transceiver shard: packed wire `[seq | bins | cells...]`
  (12-byte cells or the 4-byte value plus clock), multicast send/recv (native +
  wasm shim), then the adversarial drop/reorder/duplicate convergence test.
