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
//        [--warm '[{"projector":..., "params":{...}}]']
//
// Stages:
//   ceiling  the critic reads the REAL frames; compared with ground truth. This
//            is the best any projection could hope to score vs truth.
//   grid     the fixed baselines (mirror, mirror x2, syzygy, motion) scored by
//            every scorer — the lake test, in numbers.
//   search   the evolving advisor-cell search (search.mjs) from the baselines.
//   holdout  (explicit only) re-score the search's top configs + variants on
//            unseen random feeds: the winner's-curse check.
// Output: plugins/ml/logs/playtest-<tag>.json (+ a printed summary).
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, score, defaults } from './index.mjs';
import { SCENES, renderSequence, randomSpec } from './scenes.mjs';
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
// Merge into the existing report so running one stage never erases another's results.
const save = () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  let prev = {}; try { prev = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch {}
  fs.writeFileSync(OUT, JSON.stringify({ ...prev, ...report }, null, 1));
};

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
  const cands = [['mirror', {}], ['mirror', { frames: 2 }], ['syzygy', {}], ['syzygy', { field: 'braille' }], ['motion', {}], ['motion', { bg: 'fused' }],
                 ['syzygy', { orient: 'tangent' }], ['motion', { bg: 'braille' }], ['motion', { bg: 'edges' }]];
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
  // --warm '[{"projector":"syzygy","params":{"field":"braille"}}]' adds warm-start configs to generation 0
  const extraSeeds = JSON.parse(arg('warm', '[]'));
  const r = await runSearch({ feeds, generations: gens, perCell, cells, ctx, extraSeeds, out: OUT.replace('.json', '-search.json') });
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
if (stage === 'holdout') {
  // Re-score configs on feeds the search never saw: the winner of a best-of-N
  // pick on 4 noisy scenes is optimistically biased (winner's curse).
  const seeds = arg('holdout-seeds', '100,118,122,125,127,136').split(',').map(Number);
  const hold = seeds.map((s) => renderSequence(randomSpec(s)));
  const src = JSON.parse(fs.readFileSync(arg('from', OUT.replace('.json', '-search.json')), 'utf8'));
  const top = [...src.history].sort((a, b) => b.U - a.U).slice(0, +arg('top', 3));
  const best = top[0];
  const cands = [
    ...['mirror', 'syzygy', 'motion'].map((n) => ({ label: `${n} defaults`, projector: n, params: defaults(n) })),
    { label: 'syzygy braille defaults', projector: 'syzygy', params: { ...defaults('syzygy'), field: 'braille' } },
    ...top.map((t) => ({ label: `search #${t.id} (${t.cell}), search-set vlm ${t.vlm.toFixed(3)}`, projector: t.projector, params: { ...defaults(t.projector), ...t.params }, searchVlm: t.vlm })),
    { label: 'syzygy glyph, orient tangent', projector: 'syzygy', params: { ...defaults('syzygy'), orient: 'tangent' } },
    { label: 'motion on tangent-edge bg (bg: edges)', projector: 'motion', params: { ...defaults('motion'), bg: 'edges' } },
    { label: 'motion on braille bg (defaults: 64 cols, thresh 100)', projector: 'motion', params: { ...defaults('motion'), bg: 'braille' } },
    { label: 'motion on braille bg (winner cols/thresh)', projector: 'motion',
      params: { ...defaults('motion'), bg: 'braille', cols: best.params.cols ?? 84, braille_thresh: best.params.braille_thresh ?? 149 } },
  ];
  console.log(`=== holdout: ${cands.length} configs on ${hold.length} unseen feeds (seeds ${seeds.join(',')}), critic ${critic} (${mode}) ===`);
  report.holdout = { seeds, rows: [] };
  for (const c of cands) {
    const rows = [];
    for (const seq of hold) {
      const pr = project(c.projector, seq, c.params);
      const v = await score('vlm', { seq, projection: pr, ctx });
      rows.push({ scene: seq.truth.scene, vlm: v.fidelity, truth: v.detail.vs_truth.fidelity, motion: v.detail.vs_vlm.motion_recall, chars: pr.char_budget });
    }
    const r = { ...c, vlm: mean(rows.map((x) => x.vlm)), truth: mean(rows.map((x) => x.truth)),
                motion: mean(rows.filter((x) => x.motion !== null).map((x) => x.motion)), chars: mean(rows.map((x) => x.chars)),
                per_scene: rows.map((x) => +x.vlm.toFixed(3)) };
    report.holdout.rows.push(r);
    console.log(`  ${c.label.padEnd(58)} vlm ${r.vlm.toFixed(3)}  truth ${r.truth.toFixed(3)}  motion ${r.motion.toFixed(2)}  chars ${Math.round(r.chars)}  [${r.per_scene.join(' ')}]`);
  }
  const ceil = [];
  for (const seq of hold) ceil.push(compareScenes(seq.truth, (await describeOriginal(seq, { model: critic })).desc).fidelity);
  report.holdout.ceiling = mean(ceil);
  console.log(`  ceiling on these feeds (critic reads real frames vs truth): ${mean(ceil).toFixed(3)} [${ceil.map((x) => x.toFixed(3)).join(' ')}]`);
  save();
}

report.api = stats; report.finished = new Date().toISOString(); save();
console.log(`api calls this run: ${stats.calls} (cache hits ${stats.cacheHits}) ${JSON.stringify(stats.byProvider)}`);
console.log(`report: ${path.relative(process.cwd(), OUT)}`);
const { closeRenderer } = await import('./render.mjs'); await closeRenderer();
