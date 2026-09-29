# wasm/ — freestanding WebAssembly target

- **STATE** — **HEWN** (was DRAWN). `node wasm/run.mjs`: 4 checks, 0 failures.
- **WHAT** — `syz_wasm.c` is a C-ABI export bridge over the **unchanged**
  `include/` headers; `build.sh` compiles it with plain `clang --target=wasm32
  -ffreestanding -nostdlib` + `wasm-ld`. No emscripten, no libc, no runtime.
  `syzygy.wasm` (~6.6 KB) is the committed build so the browser landing page can
  load it without a toolchain.
- **RUNS** — `sh wasm/build.sh && node wasm/run.mjs`. Receipt this session
  (clang 18.1.3): the module **imports nothing**; the 32×16 synthetic frame hashes
  to **0x6dbdd1a8**, the same golden the native suite pins in `tests/test_fused.c`;
  and every output field (mask, glyph, tone, spectrum, peak, fft_valid) equals the
  browser port `docs/poc/syzygy.js` on 25/25 frame×parameter cases. A planted
  drift (threshold +1) is caught: 10/25, exit 1.
- **SHORTCUT** — the frame is synthesized inside the module (`syz_yuv_synth`),
  not passed in from the host; one bounded frame size (≤ 64×32); the hash formula
  is duplicated from `test_fused.c`, not shared; the JS comparison sweep is 25
  cases, not the 2405-case fuzz suite V02 runs against native.
- **ASSUMES** — the header shards stay libc-free and FPU-free (they are); clang
  with the wasm32 target and `wasm-ld`; node ≥ 18 to run the check.
- **BETTER-WHEN** — the host passes real frames into linear memory; V02's differ
  gains this module as its third column (native == wasm == JS on the full fuzz
  suite); an aarch64 run joins the same hash table.
- **SEED** — `docs/seed/blob.md` 6562-6649 (wasm bridge + build), 3007-3072
  (freestanding toolchain).
