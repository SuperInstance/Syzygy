#!/bin/sh
# build.sh — compile the SAME include/ headers the native tests use to a
# freestanding wasm32 module. No libc, no emscripten, no runtime: clang + wasm-ld.
set -e
DIR=$(cd "$(dirname "$0")/.." && pwd)
CLANG=${CLANG:-clang}
OUT=${1:-"$DIR/wasm/syzygy.wasm"}
"$CLANG" --target=wasm32 -std=c11 -O2 -Wall -Wextra -Werror -ffreestanding -nostdlib \
  -I "$DIR/include" -Wl,--no-entry -Wl,--export-dynamic \
  -o "$OUT" "$DIR/wasm/syz_wasm.c"
echo "built $OUT ($(wc -c < "$OUT") bytes)"
