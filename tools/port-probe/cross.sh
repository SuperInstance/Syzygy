#!/bin/sh
# cross.sh — compile probe.c freestanding (no libc, no startup files) for a set
# of microcontroller and foreign-ABI targets, print code size, and fail if any
# object needs a symbol that is not a compiler-runtime helper (names starting
# with "__", e.g. __aeabi_lmul, __muldi3). A libc call (memset, printf...) fails.
# Compile-only: running needs the board or an emulator (see docs/porting.md).
set -e
DIR=$(cd "$(dirname "$0")/../.." && pwd)
CLANG=${CLANG:-clang}
NM=${NM:-$(command -v llvm-nm || command -v llvm-nm-18 || echo nm)}
OUT=$(mktemp -d); trap 'rm -rf "$OUT"' EXIT
fail=0
for spec in thumbv7em-none-eabi:Cortex-M4 thumbv6m-none-eabi:Cortex-M0+ riscv32-unknown-elf:RV32 \
            aarch64_be-none-elf:AArch64-big-endian avr:AVR-ATmega2560 msp430:MSP430; do
  t=${spec%%:*}; name=${spec#*:}; extra=""
  [ "$t" = avr ] && extra="-mmcu=atmega2560"
  "$CLANG" --target="$t" $extra -std=c11 -Os -Wall -Wextra -Werror -ffreestanding -nostdlib \
    -I "$DIR/include" -c "$DIR/tools/port-probe/probe.c" -o "$OUT/$t.o"
  bad=$("$NM" -u "$OUT/$t.o" | awk '{print $NF}' | grep -v '^__' || true)
  text=$(size "$OUT/$t.o" 2>/dev/null | awk 'NR==2{print $1}')
  if [ -n "$bad" ]; then echo "FAIL $name ($t): needs non-runtime symbols: $bad"; fail=1
  else echo "ok   $name ($t): ${text:-?} bytes of code, no libc symbols"; fi
done
[ $fail -eq 0 ] && echo "cross: all targets compile freestanding" || exit 1
