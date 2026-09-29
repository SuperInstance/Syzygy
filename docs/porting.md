# Porting Syzygy to new hardware

*Deep-dive. Written for two readers: a **newcomer** wondering where this can run, and a **practitioner** with a board on the desk who wants the kernel running on it and proven correct. Back to the [README](../README.md). The promise being ported is I2 in [invariants.md](invariants.md).*

## 1. In one breath

To bring Syzygy up on a new target, compile its headers with no standard library, run the built-in test frame, and compare one 32-bit number with `0x6dbdd1a8`. If it matches, that device produces the same bytes as every other device that matches.

## 2. Why porting is short

There is not much to port. The kernel is eight header files that include only `<stdint.h>` and `<stddef.h>`, never allocate, and never touch floating point. It has no operating-system calls, no threads and no I/O. What is left is the one thing that actually differs between machines: whether the C compiler computes integer arithmetic the same way. The golden hash tests exactly that.

## 3. Mental model

A port has three layers, and only the middle one is Syzygy:

```
  your host code          camera / ADC / file  →  NV12 bytes in a buffer
  ────────────────────────────────────────────────────────────────────────
  Syzygy (unchanged)      syz_fused(&arena, &frame, &params, &out)
  ────────────────────────────────────────────────────────────────────────
  your host code          out.mask / glyph / tone / spectrum  →  screen, UART, radio
```

You provide: a static buffer for the arena, the input planes, and output arrays sized `cols*rows` (where `cols = w/2`, `rows = h/4`). Syzygy provides everything in between.

### What the headers assume about the compiler

| assumption | why it matters | status |
|---|---|---|
| `uint8_t`, `int32_t`, `uint32_t`, `int64_t` exist | used throughout; 64-bit only for squared magnitudes | every C99+ compiler, including AVR and MSP430 |
| `>>` on a negative `int32_t` is an arithmetic shift | chroma (`>>14`) and FFT twiddles shift signed values | implementation-defined in C11; arithmetic on gcc, clang, MSVC, IAR, armcc. **Check your compiler's manual.** |
| `int` is at least 16 bits | loop indices and small casts | holds everywhere; products that could exceed 16 bits are done in `uint32_t`/`int32_t` |
| unsigned arithmetic wraps mod 2^32 | FNV-1a hash | guaranteed by the C standard |

## 4. Walkthrough with real output

### Step 1: does it compile with no libc?

`tools/port-probe/probe.c` is the smallest translation unit that includes every shard and runs the golden frame. `tools/port-probe/cross.sh` compiles it freestanding for six targets and fails if any object needs a symbol other than a compiler-runtime helper:

```
$ sh tools/port-probe/cross.sh
ok   Cortex-M4 (thumbv7em-none-eabi): 1575 bytes of code, no libc symbols
ok   Cortex-M0+ (thumbv6m-none-eabi): 1511 bytes of code, no libc symbols
ok   RV32 (riscv32-unknown-elf): 1881 bytes of code, no libc symbols
ok   AArch64-big-endian (aarch64_be-none-elf): 1883 bytes of code, no libc symbols
ok   AVR-ATmega2560 (avr): 4787 bytes of code, no libc symbols
ok   MSP430 (msp430): 4319 bytes of code, no libc symbols
cross: all targets compile freestanding
```

What those sizes mean in practice: the whole pass, test frame included, fits in under 5 KB of flash, and its state (about 5 KB of static buffers for the 32×16 frame) fits in the RAM of an 8-bit ATmega2560. The helpers left unresolved are things like `__aeabi_lmul` (64-bit multiply on Cortex-M0+) and `__muldi3` (AVR), which your toolchain's `libgcc` or `compiler-rt` already provides.

### Step 2: does it give the same answer?

On the build machine:

```
$ cc -std=c11 -O2 -I include tools/port-probe/probe.c tools/port-probe/host.c -o probe && ./probe
probe golden = 0x6dbdd1a8 (match)
```

On the target, link `probe.c` into your firmware, call `syz_probe_golden()`, and get the 32-bit result out by whatever you have: a UART `printf`, a debugger watch, a blinking LED. It must be `0x6dbdd1a8`.

### Step 3: the WebAssembly target, as a worked example

`wasm/` is a finished port. The same headers, a 70-line export bridge (`wasm/syz_wasm.c`), and one build line:

```
$ sh wasm/build.sh && node wasm/run.mjs
built docs/poc/syzygy.wasm (6808 bytes)
  ok  : module imports nothing (no libc, no host runtime)
  info: wasm golden fnv1a = 0x6dbdd1a8
  ok  : wasm == JS port on 20/20 seeded random host-written frames (up to 160x96)
  ok  : wasm == JS port on 25/25 frame x param cases (mask, glyph, tone, spectrum, peak)
wasm: 6 checks, 0 failures
```

Zero imports is what lets the [landing page](index.html) run the C kernel in a browser tab with no runtime; the same property is what you want on a microcontroller.

### Step 4: feed it real frames

Write NV12 into your buffers (Y plane at full resolution, interleaved U/V at half resolution in each direction) and call `syz_fused`. `wasm/syz_wasm.c` (`syz_run_frame`) and the camera path in `docs/index.html` show the host side: a canvas frame converted to NV12 with integer BT.601 weights.

## 5. Contract and receipt

A port is done when:

1. The target compiles `probe.c` with `-ffreestanding` and no libc (`cross.sh` style).
2. `syz_probe_golden()` on the target returns `0x6dbdd1a8`.
3. You append a ledger row to `docs/marks/ledger.csv` naming the target, the compiler and version, and the observed hash, so the next reader can see it was measured, not assumed.

Receipts in this repo today: native x86-64 (gcc 13, clang 18, `-O0`/`-O2`/`-O3`); wasm32 (clang 18, run in V8); a JavaScript port; compile-only for Cortex-M4, Cortex-M0+, RV32, big-endian AArch64, AVR and MSP430. CI runs all of them on every push.

## 6. Scars

- **Compiling is not running.** The six MCU targets are compile-checked only. No board or emulator has produced the hash yet, so "same bytes on a microcontroller" is designed for, not measured. The first real-board ledger row closes that.
- **Signed right shift.** C11 leaves `>>` on negative values to the implementation. Every mainstream compiler shifts arithmetically, and the golden hash would catch one that does not, but that is the first thing to check on an unusual toolchain.
- **Big-endian compiles, but is it right?** Nothing in the kernel reads multi-byte values through byte pointers, so endianness should not matter. `aarch64_be` compiles; it has not run.
- **The JS port does not validate inputs the C rejects** (odd width, height below 4, stride below width). A port should reuse the C checks in `syz_fused`, not the JS port's.

## 7. How it composes

A port reuses all eight shards unchanged; only the host layer is new. The golden hash is the same one `tests/test_fused.c` pins, V02's drift differ uses, and the landing page shows. A new target can join V02 as another column (native == wasm == JS == your board) on the full fuzz suite.

## 8. Next

- Run the probe on a real Cortex-M board or under `qemu-system-arm`, and append the ledger row.
- Add aarch64 Linux (for example, a Raspberry Pi) as a CI runner.
- [invariants.md](invariants.md) for what the hash is protecting; [verifying.md](verifying.md) for how the checks themselves are tested; [CONTRIBUTING.md](../CONTRIBUTING.md) for the change workflow.
