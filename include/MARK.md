# include/ — the kernel headers

Syzygy is a single-header-style C-ABI kernel: each shard is a self-contained
`.h` with an inline HASH MARK at the top. Read a header's mark and you know its
state without reading its history.

**Here now (HEWN — functions, tested):**
- `syz_braille.h` — 8-dot Braille packer + integer luminance (shard 0001).
- `syz_glyph.h` — bivariate glyph/edge selector (shard 0003).

**Drawn for this directory (DRAWN — see `docs/marks/`):**
- `syz_arena.h` (0002), `syz_yuv.h` (0004), `syz_fused.h` (0005),
  `syz_fft.h` (0006), `syz_ste.h` (0007), `syz_crdt.h` (0008).

**Convention** — new symbols take the `syz_` prefix (the seed's `chiaroscuro_*`
names belong to the predecessor; see `docs/marks/ARCHITECTURE.md` SCARF-5).
Headers stay free of libc and floating point (invariant I2). A test harness may
use libc; a shard may not.
