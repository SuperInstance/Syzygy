# wasm/ — freestanding WebAssembly target

- **STATE** — **HEWN** (was DRAWN). `node wasm/run.mjs`: 6 checks, 0 failures.
- **WHAT** — `syz_wasm.c` is a C-ABI export bridge over the **unchanged**
  `include/` headers; `build.sh` compiles it with plain `clang --target=wasm32
  -ffreestanding -nostdlib` + `wasm-ld`. No emscripten, no libc, no runtime.
  The committed build lives at `docs/poc/syzygy.wasm` (~6.8 KB) so the landing
  page can load it without a toolchain. Two entry points: `syz_run` (synthetic
  test frame, in-module) and `syz_run_frame` (a frame the host writes into linear
  memory at `syz_y_ptr`/`syz_uv_ptr`, up to 160×96).
- **RUNS** — `sh wasm/build.sh && node wasm/run.mjs`. Receipt this session
  (clang 18.1.3): the module **imports nothing**; the 32×16 synthetic frame hashes
  to **0x6dbdd1a8**, the same golden the native suite pins in `tests/test_fused.c`;
  and every output field (mask, glyph, tone, spectrum, peak, fft_valid) equals the
  browser port `docs/poc/syzygy.js` on 25/25 synthetic frame×parameter cases and
  20/20 seeded random host-written frames up to 160×96; an oversize frame is
  refused with -1. A planted drift (threshold +1) is caught: 10/25, exit 1.
- **SHORTCUT** — host frames must use tight strides (stride = width) and fit
  160×96; the hash formula
  is duplicated from `test_fused.c`, not shared; the JS comparison sweep is 25
  cases, not the 2405-case fuzz suite V02 runs against native.
- **ASSUMES** — the header shards stay libc-free and FPU-free (they are); clang
  with the wasm32 target and `wasm-ld`; node ≥ 18 to run the check.
- **BETTER-WHEN** — V02's differ
  gains this module as its third column (native == wasm == JS on the full fuzz
  suite); an aarch64 run joins the same hash table.
- **SEED** — `docs/seed/blob.md` 6562-6649 (wasm bridge + build), 3007-3072
  (freestanding toolchain).
