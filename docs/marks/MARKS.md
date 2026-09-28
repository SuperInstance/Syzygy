# MARKS — how a shard leaves a mark for the next shipwright

*Syzygy is built the way a hull is built: by a rotating crew of shipwrights who
never share a memory. A plank is cut, fitted, and **marked** — a few chalk and
gouge marks that tell the next hand what this piece is, what it already does,
where it is only tacked in place, and what it is waiting on. Nobody asks "who
cut this and why"; they **read the mark and know the next move.** These docs are
those marks. Read one and continue from context alone.*

This convention is modeled on the fleet's append-only decision log and its
"situations" substrate: *replay ≡ live* — the ledger tells you exactly why any
piece of work happened, and a stranger reads a row and knows what to do next
(`SuperInstance/AI-Writings` → `situations/dispatch-ledger.csv`,
`situations/README.md`). Here the unit is a **shard**, not a dispatch, and the
mark travels **with the piece** (in the file's header and in `docs/marks/`).

---

## The four hash marks (a shard's STATE)

Every shard carries exactly one state mark. This is the first thing you read.

| mark | name | what it means | what you do with it |
|---|---|---|---|
| **HEWN** | cut and proven | Functions now. Has a passing test. Load-bearing. | Build **on** it. Trust its behavior; do not re-derive it. |
| **SHAPED** | fitted, not fastened | Code exists (transcribed/adapted from the seed), compiles or is close, but no test proves it yet. | **Prove it** (add a test → promote to HEWN) or fix its joins before depending on it. |
| **DRAWN** | chalked, no wood cut | A mark only. The piece's shape, purpose, and dependencies are named; no code yet. | This is a **next haul**. Build it when its `ASSUMES` are satisfied. |
| **SCARF** | a joint to reconcile | A place where the seed's drafts **contradict each other** (a scarf joint fuses two timbers). Named, with both sides cited, so it is resolved on purpose, not by accident. | Read the resolution in `ARCHITECTURE.md` before you build across this joint. Do not silently pick one draft. |

A shard is promoted (DRAWN → SHAPED → HEWN) only by the work that earns it, and
the promotion is recorded as a new row in `ledger.csv`. Marks are **append-only**
in spirit: you add a truer mark, you do not quietly erase the old one.

---

## What every shard mark must state

A mark is worthless if it hides what is not done. Every shard — in its file
header comment **and** in its `docs/marks/NNNN-name.md` — states these fields.
(The shape is fixed so a stranger scans it in seconds; see 0001/0003 for HEWN
examples and 0002/0004/0005/0006/0007 for DRAWN examples.)

- **WHAT** — one line: what this piece is.
- **STATE** — one of `HEWN` / `SHAPED` / `DRAWN` / `SCARF`.
- **RUNS** — what actually works *right now*. For HEWN, name the test and its
  result. For SHAPED, say "compiles, untested". For DRAWN, "nothing yet".
- **SHORTCUT** — the POC shortcut taken. The honest "this is the cheap version"
  admission. (Every HEWN shard has at least one; if it claims none, distrust it.)
- **ASSUMES** — what this piece assumes of **downstream/upstream** shards: its
  dependencies, named by shard id. This is how the crew coordinates without
  meeting.
- **BETTER-WHEN** — the load-bearing honesty: *"this will work better once X
  exists."* X is a concrete downstream shard or capability. This field is what
  makes the mark **shape the next decision** instead of just describing the past.
- **SEED** — citation into `docs/seed/blob.md` by line range. The seed is the
  charter and is **never edited**; every shard says which lines it descends from.
- **NEXT** — the mark(s) that point to the next move (shard ids).

---

## How to read a joint (SCARF) mark

The seed contradicts itself across its three README drafts and its copy-paste
code (it is a working document, not a spec). A SCARF mark does not hide that; it
**names both timbers and the chosen join**. The full list of joints and how each
was resolved to *one honest architecture* lives in
[`ARCHITECTURE.md`](ARCHITECTURE.md). When you build across a joint, read that
resolution first. If you disagree, you re-open the joint **in the ledger** with
your reasoning — you do not just build the other draft and leave the crew split.

---

## The ledger

[`ledger.csv`](ledger.csv) is the append-only log of every mark laid, in the
fleet's `dispatch-ledger` shape. One row per shard-event. Columns:

`mark_id, laid_at, shard, state, serves_invariant, depends_on, witness, better_when, seed_ref`

- **witness** — the receipt: for HEWN, the passing-test line; for DRAWN, the
  spec/plan; for SCARF, the resolution ref. A witness is a thing a stranger can
  re-check, not a claim.
- **serves_invariant** — which of the three invariants (I1 arena / I2 fused
  determinism / I3 CRDT) this shard serves. A shard that serves none is suspect.

Replay the ledger top to bottom and you have the whole build's reasoning, with
no memory required. That is the point.
