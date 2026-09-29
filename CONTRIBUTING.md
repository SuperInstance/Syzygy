# Contributing to Syzygy

Syzygy is built by people (and agents) who may never talk to each other. The files have to carry everything, so a contribution is a change **plus the evidence for it**. This page is the short version; the long version is [docs/diffuse-by-marks.md](docs/diffuse-by-marks.md).

## Before you change anything

```sh
sh tools/suite-total.sh        # expect: === TOTAL: 7 suites, 219 checks, 0 failures ===
```

Any C11 compiler works (`CC=clang sh tools/suite-total.sh` for clang). Node ≥ 18 is needed only for the verifier tools and the wasm check.

## The rules

1. **Never edit `docs/seed/blob.md`.** It is the seed of record; every mark cites its line numbers. `tools/seed-guard.sh` fails CI if its hash changes. Corrections go in a shard and in `docs/marks/ARCHITECTURE.md`.
2. **Headers stay freestanding.** `include/` may use only `<stdint.h>` and `<stddef.h>`: no libc, no `malloc`, no `float`/`double`. Tests may use libc. `tools/port-probe/cross.sh` fails if a libc symbol leaks in.
3. **HEWN means a test passes now.** A shard's mark (the comment block at the top of its header, and `docs/marks/NNNN-*.md`) says WHAT / STATE / RUNS / SHORTCUT / ASSUMES / BETTER-WHEN / SEED / NEXT. Promote a state only with a passing test, and always admit a SHORTCUT.
4. **Log it in the ledger.** Append a row to `docs/marks/ledger.csv` whose witness is the exact output line that proves it (for example `test_fused: 61 checks, 0 failures (suite 219)`). Append only: a promotion or correction is a new row, never an edit.
5. **Anything that feeds the golden hash moves it.** A threshold, the tone basis, the ramp, a rounding constant. If you change `0x6dbdd1a8` or `0x463de14b` in `tests/test_fused.c`, add a ledger row saying why, and update `docs/poc/syzygy.js` (its `REF` block) and rebuild `docs/poc/syzygy.wasm` (`sh wasm/build.sh`) so all three implementations still agree.

## If you touch `include/` or `tests/`

The mutation gauge's catalog is bound to the exact bytes of those two directories. After your change is green:

```sh
node tools/kernel-oracle-mutant-gauge/gauge.mjs --write    # ~35 s; re-derives the catalog
node tools/kernel-oracle-mutant-gauge/gauge.mjs --verify --strict
```

Commit the updated `catalog.jsonl`. If `--strict` reports a **survivor**, your change weakened a check (or the mutant's target code moved); strengthen the test rather than deleting the mutant.

## If you touch `docs/poc/syzygy.js` or the fused pass

```sh
node tools/wasm-native-drift-differ/differ.mjs   # C vs JS on 2405 frames
sh wasm/build.sh && node wasm/run.mjs           # C-as-wasm vs JS; rebuilds the served .wasm
```

To see the landing page: `cd docs && python3 -m http.server`, then open http://localhost:8000/. The "Two engines, one answer" panel must show every frame identical and a 3/3 self-check.

## Porting to a new target

See [docs/porting.md](docs/porting.md). In short: compile `tools/port-probe/probe.c` freestanding, run it, and compare `syz_probe_golden()` with `0x6dbdd1a8`. Add a ledger row with the target, compiler version and observed hash.

## Writing docs

- Keep the README a general-audience read; deep material goes in `docs/` and is linked from it.
- Deep-dives follow one shape: one breath / why / mental model / walkthrough with real output / contract and receipt / scars / how it composes / next.
- Every number must come from a run you can point to, and should say what it makes possible. Say "the same bytes on any device, checkable with one number", not "fast". No superlatives.

## Commits and CI

Small commits, each saying what you tried, what you expected, what you found and what it implies. `git pull --rebase` before pushing. CI (`.github/workflows/ci.yml`) runs the C suite on gcc and clang, the wasm check, the verifier cells, the freestanding cross-compile and the seed guard. It must be green before merge.

## Publishing the landing page

The site is the static files `docs/index.html`, `docs/img/` and `docs/poc/`; no build step. It is live on Cloudflare Pages at https://syzygy-1j5.pages.dev/ (project `syzygy`). To republish after a change, with a Cloudflare API token in the environment:

```sh
mkdir -p /tmp/site && cp -r docs/index.html docs/img docs/poc /tmp/site/
npx wrangler pages deploy /tmp/site --project-name syzygy --branch main
```

GitHub Pages also works with no extra files: Settings → Pages → "Deploy from a branch" → `main`, folder `/docs` (`docs/.nojekyll` is already present).
