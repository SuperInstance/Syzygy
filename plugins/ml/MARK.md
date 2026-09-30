# plugins/ml — ML projection plugins (projector / scorer registry)

- **WHAT** — a plugin layer *beside* the kernel for machine-learning abilities
  on a feed: **projectors** turn a short RGB frame sequence into text
  (`{text_projection, char_budget, compute_estimate}`), **scorers** say how much
  of the scene survived (`{fidelity 0..1, detail}`), and a **search** evolves
  projector configs on the iron triangle {fidelity, characters, compute}.
  Full write-up: [docs/ml-projection-landscape.md](../../docs/ml-projection-landscape.md).
- **STATE** — HEWN for the contract (registry, typed-params gate, the three
  projectors, the free scorers, the discriminator arithmetic): `node
  plugins/ml/selftest.mjs` (offline, no keys). SHAPED for anything whose number
  comes from a paid model (the VLM critic, the LLM advisors, the Jev gate, the
  quantum cell): the code runs and its real outputs are cached and logged, but a
  model's answer is evidence, not a proof, and n = 4 scenes is small.
- **RUNS** —
  `node plugins/ml/selftest.mjs` → `plugins/ml selftest: 40 checks, 0 failures`;
  `node plugins/ml/playtest.mjs --stage all` → ceiling, baseline grid, search
  (real API calls; replays from `cache/` for free; `SYZ_ML_OFFLINE=1` forbids
  the network).
- **WHERE IT ATTACHES** — the kernel's JS port `docs/poc/syzygy.js` (byte-exact
  with the C kernel, V02). The `syzygy` projector loads it unmodified and the
  selftest re-derives the golden `0x6dbdd1a8` from the very module it loads. No
  plugin can change what the kernel emits; plugins only interpret it.
- **SHORTCUT** — feeds are synthetic (drawn scenes with rendered ground truth; no
  camera in a headless container). Four scenes, one critic sample each. The
  JEPA-lite probe is a linear map to a 16×8 pixel target, not a learned
  embedding. Quantum draws use MothQuantum's `emu` (simulator) mode, which is
  explicitly uncertified.
- **ASSUMES** — Node ≥ 18. For paid stages: `DEEPINFRA_KEY` (critic), any of
  `DEEPSEEK_KEY` / `KIMIAI_KEY` / `ZAI_KEY` (advisors), `TYPESAFEAI_KEY` (gate),
  `MOTHQUANTUM_KEY` (+ `MOTHQUANTUM_BASE`). Image-mode critic needs Playwright +
  Chromium.
- **NOT A KERNEL SHARD** — this directory is not freestanding, uses floats and
  the network. I1/I2/I3 do not apply here and nothing here feeds the golden hash.
- **BETTER-WHEN** — a real camera feed (the landing page already has one); more
  scenes and repeated critic samples with confidence intervals; a CLIP/SigLIP
  embedding target for the JEPA probe; the critic itself tuned (it reads 0.92
  from real frames but ~0.3–0.5 from the best text).
- **NEXT** — see "Where to look next" in the landscape doc.
