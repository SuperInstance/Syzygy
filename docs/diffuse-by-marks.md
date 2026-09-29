# Diffuse by marks — a blueprint

*How this kernel was diffused from a seed by hash-marks, so the next shipwright can repeat it. Front door: [understanding-syzygy.md](understanding-syzygy.md). Pipeline: [the-fused-pass.md](the-fused-pass.md). Convention text: `docs/marks/MARKS.md`. Evidence: `docs/marks/ledger.csv` and `git log`.*

## 1. In one breath

Take a large, self-contradicting seed document you never edit; split it into numbered shards; label each with one of four marks (HEWN / SHAPED / DRAWN / SCARF); promote a shard only when a passing test earns it; and log every promotion in an append-only ledger, so a crew with no shared memory can continue from the files alone.

## 2. Why it exists

The seed (`docs/seed/blob.md`, ~9,535 lines) is three README drafts plus copy-paste code that disagrees with itself (`docs/marks/ARCHITECTURE.md`). Its status sections claim things "shipped" that were not on disk (SCARF-6). Parallel builders cannot ask each other questions. The marks make the *next move* readable from the artifact: what is proven, what is tacked, what is only chalked, what needs a ruling.

## 3. Mental model

**Nouns**

- **Seed** — the charter. Never edited. Every shard cites it by line range (`SEED:` field).
- **Shard** — one numbered unit (`0001`–`0008`) = one header in `include/`, one mark in `docs/marks/NNNN-*.md`, one test in `tests/`.
- **Mark** — the header comment: WHAT / STATE / RUNS / SHORTCUT / ASSUMES / BETTER-WHEN / SEED / NEXT.
- **Ledger** — `docs/marks/ledger.csv`: `mark_id, laid_at, shard, state, serves_invariant, depends_on, witness, better_when, seed_ref`. One row per event; a promotion is a *new row* (`m0002` DRAWN then `m0002b` HEWN), never an edit.
- **Witness** — the re-runnable receipt in the ledger row (a test line, not a claim).

**States and transitions**

```
DRAWN ──(code, compiles)──▶ SHAPED ──(test passes)──▶ HEWN
   ▲                                                     │
   └────── SCARF: seed contradicts itself; rule it in ARCHITECTURE.md first
```

In this repo shards went DRAWN → HEWN directly in one change each (ledger `m0002`→`m0002b`, `m0006`→`m0009`, etc.); SHAPED is available but was not needed.

**Three rules that carry the method**

1. *Every HEWN shard admits a SHORTCUT.* "If it claims none, distrust it" (`MARKS.md`).
2. *BETTER-WHEN is the steering field.* It names the concrete thing that would make the piece better, so the mark shapes the next decision instead of describing the last one.
3. *Every shard serves an invariant* (I1 arena / I2 fused determinism / I3 CRDT). A shard that serves none is suspect.

## 4. Walkthrough — steps for the next kernel

1. **Freeze the seed.** Commit it untouched under `docs/seed/`. Number its lines (blob:N citations depend on them).
2. **Reconcile before coding.** Read the whole seed for contradictions. Write `ARCHITECTURE.md`: one honest architecture, three or so invariants, and one **SCARF-n** per contradiction with *Timber A*, *Timber B*, and *Join* (the ruling), each cited by line. Here that produced SCARF-1…6 before any shard (SCARF-7 came later, see scars).
3. **Write `MARKS.md`** (vocabulary + the eight fields) and an empty `ledger.csv` header.
4. **Chalk the map.** Create every shard as DRAWN: `docs/marks/NNNN-name.md` with WHAT/ASSUMES/BETTER-WHEN/SEED/NEXT and a ledger row whose witness is the spec. Add `MARK.md` to each empty directory (`src/`, `wasm/`, `bench/`, `include/`, `tests/`) — no empty stubs pretending to work.
5. **Order by dependency.** Foundations first: arena (0002) underlies everything; then leaves (0001, 0003, 0004, 0006); then the keystone that composes them (0005); then peers (0007, 0008). The keystone waits until its inputs are proven, so it fuses *proven* pieces.
6. **Cut one shard per change.** Header with the hash mark → test in `tests/test_x.c` → append a block to `tests/run.sh` → run `sh tests/run.sh` → update the mark's STATE/RUNS → append a HEWN ledger row whose witness quotes the passing line and the running suite total (e.g. `m0013`: "test_crdt: 28 checks … (suite 201)").
7. **Test the property, not the example.** What earned HEWN here: brute-force oracles (2000 random cases for the argmax), double-precision reference DFT (FFT), 40,000-triple semilattice laws (CRDT), and **fused == composed** byte-equality (the I2 witness). Pin a golden hash for cross-target determinism (`0x6dbdd1a8`).
8. **Keep the header libc-free and float-free;** only tests may use libc.
9. **Replay check.** Read the ledger top to bottom. If you cannot say why each row happened and what re-checks it, a mark is under-specified.

Copy-paste to replay this repo's receipt:

```sh
sh tests/run.sh     # 7 suites; per-suite counts 31,29,15,31,43,24,28 = 201, all 0 failures (run this session)
column -s, -t docs/marks/ledger.csv | cut -c1-120 | head    # or just open the CSV
```

## 5. Contract

- The seed is never edited; corrections live in shards and `ARCHITECTURE.md` (e.g. SCARF-7's FFT fix lives in `include/syz_fft.h`).
- HEWN means *a test in `tests/` passes now*, and `sh tests/run.sh` exits non-zero on any failed check (`set -e`).
- Marks are append-only in spirit; disagree by **re-opening the joint in the ledger**, not by silently building the other draft.
- Receipt for this repo: 201 checks, 0 failures.

## 6. Scars (what went wrong, so you avoid it)

- **Seed bugs are real.** The seed FFT swaps sine/cosine and rotates the wrong way (SCARF-7); the "production" header does not compile (SCARF-3). Transcribing seed code verbatim is not a plan — every HEWN shard here needed hardening, e.g. the arena's overflow-safe capacity check (`syz_arena.h`, "Deviations from the seed").
- **Status claims drift.** Seed drafts said "shipped" for absent code (SCARF-6). Same failure recurred locally: the top-level `README.md` still shows 0002/0004–0008 as DRAWN and "31 checks" while the ledger says all HEWN and 201. Update the README in the same change that lays a ledger row.
- **Shared-checkout collisions in `run.sh`/ledger.** History shows it: commits "drop stray 0008 block from run.sh", "remove stray 0008 run.sh block", "resolve run.sh/ledger union", "dedup shared-checkout collision". Parallel shards each append to the same two files. Mitigation: append-only blocks, pull/rebase before push, and re-run the full suite after any merge.
- **DRAWN vs HEWN gaps that hide inside HEWN.** A HEWN shard can still be short of its name: the tokenizer (0007) is HEWN but has no training, so "learnable" is false; 0005 is HEWN but drops the 3×3 conv and doesn't prove register residency; 0008 is HEWN but has no wire transport. Read SHORTCUT before trusting a state word.
- **A weaker witness than the claim.** I2's cross-target claim is pinned by a golden hash but only exercised on the native compiler; `tests/test_cross_platform.sh` and the wasm/aarch64 runs are still DRAWN (`tests/MARK.md`, `wasm/MARK.md`). Say "designed for" until a second target hashes the same.
- **Stray tie-break decisions.** The CRDT tie rule (per-field max on equal clocks) was a ruling made in the shard and recorded in the ledger, because a lexicographic pick is not associative. Record such rulings where the next hand will look.

## 7. How it composes

The method is what the fleet's append-only dispatch log does (`MARKS.md` cites `SuperInstance/AI-Writings`, `situations/dispatch-ledger.csv`) with the unit changed from a dispatch to a shard and the mark traveling *with the file*. Kernel-side consumers named in the brief (federated-tinyml-vessel byte-exact contract, the P1 browser POC, the P4 optimization-agent plan) are outside this repo and not verified here; what they can rely on is the pinned golden hash and the ledger's witnesses.

## 8. Next links

- Open next hauls, from the marks' NEXT fields: a UDP transceiver (0009, `syz_crdt.h`), a cross-target hash test (`tests/MARK.md`), a perf/disassembly witness for register residency (`syz_fused.h`), a tokenizer training harness (`syz_ste.h`), the bit-reversal-free FFT closing SCARF-1 (`syz_fft.h`), and refreshing the README status table.
- [understanding-syzygy.md](understanding-syzygy.md), [the-fused-pass.md](the-fused-pass.md), `docs/marks/MARKS.md`.
