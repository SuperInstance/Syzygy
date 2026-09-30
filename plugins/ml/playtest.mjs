#!/usr/bin/env node
// =============================================================================
// playtest.mjs — the loop end to end, with REAL API calls. Every paid call is
// cached (plugins/ml/cache/) and logged (plugins/ml/logs/calls.jsonl), so a
// second run replays for free and `SYZ_ML_OFFLINE=1` re-derives every number
// below without the network.
//
//   node plugins/ml/playtest.mjs [--stage ceiling|grid|search|all]
//        [--critic-mode text|image] [--critic MODEL] [--gens N] [--per-cell N]
//        [--cells llm:deepseek,llm:kimi,llm:zai,quantum,local] [--tag NAME]
//
// Stages:
//   ceiling  the critic reads the REAL frames; compared with ground truth. This
//            is the best any projection could hope to score vs truth.
//   grid     the fixed baselines (mirror, mirror x2, syzygy, motion) scored by
//            every scorer — the lake test, in numbers.
//   search   the evolving advisor-cell search (search.mjs) from the baselines.
// Output: plugins/ml/logs/playtest-<tag>.json (+ a printed summary).
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, score, defaults } from './index.mjs';
import { SCENES, renderSequence } from './scenes.mjs';
import { describeOriginal, DEFAULT_CRITIC } from './scorers/vlm.mjs';
import { compareScenes } from './compare.mjs';
import { runSearch, pareto } from './search.mjs';
import { stats } from './apis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const stage = arg('stage', 'all'), mode = arg('critic-mode', 'image'), critic = arg('critic', DEFAULT_CRITIC);
const tag = arg('tag', `${mode}-${critic.split('/').pop()}`);
const ctx = { critic_mode: mode, critic_model: critic };
const feeds = SCENES.map((s) => renderSequence(s));
const report = { tag, critic, mode, started: new Date().toISOString() };
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const OUT = path.join(HERE, 'logs', `playtest-${tag}.json`);
const save = () => { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(report, null, 1)); };

if (stage === 'ceiling' || stage === 'all') {
  console.log(`=== ceiling: ${critic} reads the real frames, vs ground truth ===`);
  report.ceiling = [];
  for (const seq of feeds) {
    const r = await describeOriginal(seq, { model: critic });
    const c = compareScenes(seq.truth, r.desc);
    report.ceiling.push({ scene: seq.truth.scene, fidelity: c.fidelity, motion_recall: c.motion_recall, pairs: c.pairs });
    console.log(`  ${seq.truth.scene.padEnd(6)} fidelity ${c.fidelity.toFixed(3)}  motion_recall ${c.motion_recall}`);
  }
  console.log(`  MEAN ceiling ${mean(report.ceiling.map((x) => x.fidelity)).toFixed(3)}`); save();
}

if (stage === 'grid' || stage === 'all') {
  console.log(`=== grid: baselines, critic ${critic} (${mode}) ===`);
  const cands = [['mirror', {}], ['mirror', { frames: 2 }], ['syzygy', {}], ['syzygy', { field: 'braille' }], ['motion', {}], ['motion', { bg: 'fused' }]];
  report.grid = [];
  for (const [n, over] of cands) {
    const params = { ...defaults(n), ...over }, rows = [];
    for (const seq of feeds) {
      const pr = project(n, seq, params);
      const v = await score('vlm', { seq, projection: pr, ctx });
      const inv = await score('inverse', { seq, projection: pr });
      rows.push({ scene: seq.truth.scene, vlm: v.fidelity, truth: v.detail.vs_truth.fidelity, motion: v.detail.vs_vlm.motion_recall,
                  inverse: inv.fidelity, chars: pr.char_budget, ms: pr.compute_estimate.ms, rec: v.detail.reconstruction });
    }
    const jp = await score('jepa', { projection: { projector: n, params } });
    const g = { projector: n, over, vlm: mean(rows.map((r) => r.vlm)), truth: mean(rows.map((r) => r.truth)),
                motion: mean(rows.filter((r) => r.motion !== null).map((r) => r.motion)), inverse: mean(rows.map((r) => r.inverse)),
                jepa: jp.fidelity, chars: mean(rows.map((r) => r.chars)), ms: mean(rows.map((r) => r.ms)), rows };
    report.grid.push(g);
    console.log(`  ${(n + JSON.stringify(over)).padEnd(26)} vlm ${g.vlm.toFixed(3)}  truth ${g.truth.toFixed(3)}  motion ${g.motion.toFixed(2)}  jepa ${g.jepa.toFixed(3)}  inverse ${g.inverse.toFixed(3)}  chars ${g.chars}  ms ${g.ms.toFixed(1)}`);
  }
  save();
}

if (stage === 'search' || stage === 'all') {
  const gens = +arg('gens', 3), perCell = +arg('per-cell', 2);
  const cells = arg('cells', 'llm:deepseek,llm:kimi,llm:zai,quantum,local').split(',');
  console.log(`=== search: ${gens} generations x ${cells.length} cells x ${perCell} ===`);
  const r = await runSearch({ feeds, generations: gens, perCell, cells, ctx, out: OUT.replace('.json', '-search.json') });
  const seeds = r.history.filter((h) => h.cell === 'seed');
  const best = [...r.history].sort((a, b) => b.U - a.U)[0];
  const byCell = {};
  for (const h of r.history) (byCell[h.cell] ||= []).push(h.U);
  report.search = { genLog: r.genLog, best, front: r.front.map((f) => ({ id: f.id, vlm: f.vlm, chars: f.chars, ms: f.ms, projector: f.projector, params: f.params })),
                    rejected: r.rejected, byCell: Object.fromEntries(Object.entries(byCell).map(([k, v]) => [k, { n: v.length, best: Math.max(...v), mean: mean(v) }])),
                    history: r.history };
  console.log(`  seeds best U ${Math.max(...seeds.map((s) => s.U)).toFixed(3)} -> searched best U ${best.U.toFixed(3)} (#${best.id} ${best.cell} ${best.projector} ${JSON.stringify(best.params)})`);
  for (const [k, v] of Object.entries(report.search.byCell)) console.log(`  cell ${k.padEnd(13)} n=${v.n} best U ${v.best.toFixed(3)} mean U ${v.mean.toFixed(3)}`);
  console.log(`  rejected by gate: ${r.rejected.length}`);
  save();
}
report.api = stats; report.finished = new Date().toISOString(); save();
console.log(`api calls this run: ${stats.calls} (cache hits ${stats.cacheHits}) ${JSON.stringify(stats.byProvider)}`);
console.log(`report: ${path.relative(process.cwd(), OUT)}`);
const { closeRenderer } = await import('./render.mjs'); await closeRenderer();
