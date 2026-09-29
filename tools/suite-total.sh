#!/bin/sh
# suite-total.sh — run tests/run.sh unchanged and print the whole-suite total.
# (run.sh prints one count per suite; this sums them so the receipt is one line.)
# Exits non-zero if run.sh fails or any suite reports a failure.
DIR=$(cd "$(dirname "$0")/.." && pwd)
LOG=$(mktemp); trap 'rm -f "$LOG"' EXIT
sh "$DIR/tests/run.sh" > "$LOG" 2>&1; rc=$?
cat "$LOG"
grep -E '[0-9]+ checks, [0-9]+ failures' "$LOG" | sed -E 's/.* ([0-9]+) checks, ([0-9]+) failures.*/\1 \2/' |
  awk -v rc="$rc" '{c+=$1; f+=$2; n++} END {
    printf "=== TOTAL: %d suites, %d checks, %d failures (run.sh exit %d) ===\n", n, c, f, rc;
    exit (rc != 0 || f != 0 || n == 0) }'
