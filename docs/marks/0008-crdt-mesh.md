# 0008 — Join-semilattice CRDT mesh

- **WHAT** — Conflict-free replicated state for a fleet of nodes: each cell holds
  a value plus a Lamport clock `<t, node_id>`; merge is a join `⊔` that is
  idempotent, commutative, associative, resolving conflicts by last-write-wins.
  No coordinator, no lock. The wire format is the packed cell layout. This is
  invariant **I3**.
- **STATE** — **DRAWN**. The seed gives the exact merge equations and packet
  layout to transcribe.
- **RUNS** — nothing yet. Target surface: `include/syz_crdt.h` with
  `syz_lamport_gt(a, b)`, `syz_cell_merge(a, b) -> cell`, and a packed wire
  struct `[seq | bins | cells...]`; plus a UDP transceiver (native + a wasm shim).
- **SHORTCUT (planned)** — start with the **pure merge algebra** and an in-memory
  two-node convergence test (no sockets). That proves the semilattice laws before
  any network exists. UDP multicast is a second, separable step.
- **ASSUMES** — 0002 (arena for the state grid and packet buffers). It consumes
  packed cells produced by 0001/0005. It is otherwise independent of the compute
  path — the mesh carries whatever the pass produces.
- **BETTER-WHEN** — an **adversarial network test** (drop, reorder, duplicate)
  proves the three algebraic laws hold under real loss, turning the seed's proof
  (blob:7940-7978) into a checked receipt; and when the LWW `max(v_A, v_B)` tie
  rule is validated against a real fleet workload (the seed's tie-break may need a
  per-field merge, not a scalar max).
- **CAUTION** — the seed's LWW tie case merges equal clocks with `max(v_A, v_B)`
  (blob:7957). For a multi-field cell (r,g,b,code) a scalar `max` is ambiguous;
  decide the per-field rule when building, and record it in the ledger.
- **SEED** — `docs/seed/blob.md` 7940-7978 (the poset/semilattice + LWW proof),
  3824-3866 (`chiaroscuro_fleet.h` node/bin layout), 7707-7778
  (`chiaroscuro_udp.h` transceiver).
- **NEXT** — the merge-algebra test first (earn SHAPED→HEWN without a network),
  then the UDP transceiver, then the adversarial convergence test.
