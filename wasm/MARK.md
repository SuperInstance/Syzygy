# wasm/ — freestanding WebAssembly target

- **STATE** — DRAWN. This mark holds the space; no build cut yet.
- **WILL HOLD** — a C-ABI export bridge (`bridge.c`, seed blob:6585-6624) and a
  build script (`clang --target=wasm32 -O3 -nostdlib -Wl,--no-entry
  -Wl,--export-all`, seed blob:6626-6649). The point of invariant **I2** is that
  **the same source** compiles here and emits **byte-identical** output to the
  native build — no conditional compilation, no FPU.
- **DEPENDS ON** — the header shards being libc-free and FPU-free (they are, by
  convention). 0001 and 0003 already qualify: they include only `<stdint.h>`
  (a freestanding header) and do no allocation.
- **BETTER-WHEN** — a `test_cross_platform.sh` (see `tests/MARK.md`) hashes the
  native and wasm outputs of the same input and asserts they match — that is how
  I2's "re-executable by a stranger on any target" stops being a claim.
- **SEED** — `docs/seed/blob.md` 6562-6649 (wasm bridge + build), 3007-3072
  (freestanding toolchain script), 3391-6151 (the WebGPU shaders that the wasm
  dashboard hosts — a separate, later haul).
