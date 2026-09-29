#!/bin/sh
# seed-guard.sh — docs/seed/blob.md is the seed of record and is never edited.
# Every blob:N citation in the marks depends on its exact bytes. Fail if it moved.
DIR=$(cd "$(dirname "$0")/.." && pwd)
PINNED=c5781354b5ded35730a8f070379325e7622242b751332bc61829741fe2d62654
GOT=$(sha256sum "$DIR/docs/seed/blob.md" | cut -d' ' -f1)
if [ "$GOT" = "$PINNED" ]; then echo "seed-guard: blob.md unchanged ($PINNED)"; else
  echo "seed-guard: docs/seed/blob.md changed (got $GOT, pinned $PINNED). The seed is immutable."; exit 1; fi
