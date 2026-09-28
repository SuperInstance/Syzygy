#!/bin/sh
# =============================================================================
# run.sh — build and run the Syzygy shard tests. Zero dependencies beyond a
# C11 compiler. Exits non-zero on any failed check.
# =============================================================================
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
CC=${CC:-cc}
OUT=$(mktemp -d)
trap 'rm -rf "$OUT"' EXIT

echo "compiler: $($CC --version | head -1)"
$CC -std=c11 -O2 -Wall -Wextra -I "$DIR/include" \
    "$DIR/tests/test_braille.c" -o "$OUT/test_braille"
"$OUT/test_braille"

$CC -std=c11 -O2 -Wall -Wextra -I "$DIR/include" \
    "$DIR/tests/test_arena.c" -o "$OUT/test_arena"
"$OUT/test_arena"

$CC -std=c11 -O2 -Wall -Wextra -I "$DIR/include" \
    "$DIR/tests/test_fft.c" -o "$OUT/test_fft" -lm
"$OUT/test_fft"

$CC -std=c11 -O2 -Wall -Wextra -I "$DIR/include" \
    "$DIR/tests/test_yuv.c" -o "$OUT/test_yuv"
"$OUT/test_yuv"

$CC -std=c11 -O2 -Wall -Wextra -I "$DIR/include" \
    "$DIR/tests/test_fused.c" -o "$OUT/test_fused"
"$OUT/test_fused"
