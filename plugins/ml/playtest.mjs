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

if (stage === 'run3') {
  // Run 3: the fixes the first two runs asked for, built only on DeepInfra,
  // TypeSafe and MothQuantum.
  //  - quantum-drawn splits: a held-out set (steers promotion) and a TEST set
  //    (touched once, at the end) are chosen from QRNG bytes, so no advisor,
  //    seed or person can know in advance which feeds will judge the search;
  //  - a three-VLM critic ensemble (all on DeepInfra) to cut one reader's noise;
  //  - promotion by held-out score, not search-set score;
  //  - LLM advisors hosted on DeepInfra (Kimi-K2.6, Qwen3-235B, gpt-oss-120b,
  //    MiniMax-M3) beside DeepSeek, plus the quantum and xorshift mutation cells.
  const { quantumBytes } = await import('./apis.mjs');
  const qmode = arg('qmode', 'emu');
  const draws = [];
  for (let i = 0; i < 2; i++) {
    const q = await quantumBytes(32, { mode: qmode, tag: `split:${i}`, maxWaitMs: qmode === 'qpu' ? 900000 : 60000 });
    draws.push({ job_id: q.job_id, mode: q.mode, commit: q.commit, hex: q.hex });
  }
  const bytes = Buffer.from(draws.map((d) => d.hex).join(''), 'hex');
  const oneMover = (sd) => { const sp = randomSpec(sd), mv = sp.objects.filter((o) => o.vx || o.vy);
    return mv.length === 1 && sp.objects.length >= 3 && new Set(sp.objects.map((o) => o.kind)).size === sp.objects.length; };
  const used = new Set([100, 118, 122, 125, 127, 136]), picked = [];
  for (let i = 0; i + 1 < bytes.length && picked.length < 12; i += 2) {
    let sd = 2000 + ((bytes[i] << 8) | bytes[i + 1]);                  // 2000..67535
    while (!oneMover(sd) || used.has(sd)) sd++;                         // walk to the next valid feed
    used.add(sd); picked.push(sd);
  }
  const holdSeeds = picked.slice(0, 6), testSeeds = picked.slice(6, 12);
  console.log(`=== run3: quantum split (${qmode}; jobs ${draws.map((d) => d.job_id.slice(0, 8)).join(', ')}) ===`);
  console.log(`  held-out seeds ${holdSeeds.join(',')}   test seeds ${testSeeds.join(',')}`);
  const critics = arg('critics', 'Qwen/Qwen3-VL-30B-A3B-Instruct,google/gemma-3-27b-it,mistralai/Mistral-Small-3.2-24B-Instruct-2506').split(',');
  const ectx = { critic_mode: mode, critic_models: critics };
  const holdFeeds = holdSeeds.map((s) => renderSequence(randomSpec(s))), testFeeds = testSeeds.map((s) => renderSequence(randomSpec(s)));
  const cells = arg('cells', 'llm:di:kimi,llm:di:qwen,llm:di:gptoss,llm:di:minimax,llm:deepseek,quantum,local').split(',');
  const r = await runSearch({ feeds, generations: +arg('gens', 3), perCell: +arg('per-cell', 1), cells, ctx: ectx,
    holdout: { feeds: holdFeeds, topK: +arg('topk', 3) }, out: OUT.replace('.json', '-search.json'),
    extraSeeds: [{ projector: 'motion', params: { bg: 'edges' }, why: 'warm: best held-out config of runs 1-2' },
                 { projector: 'syzygy', params: { orient: 'tangent' }, why: 'warm: tangent relabel' }] });
  const byHold = [...r.history].filter((h) => h.hold !== undefined).sort((a, b) => b.hold - a.hold);
  const byU = [...r.history].sort((a, b) => b.U - a.U);
  const finalists = [
    { label: 'mirror defaults', projector: 'mirror', params: defaults('mirror') },
    { label: 'syzygy defaults (gradient)', projector: 'syzygy', params: defaults('syzygy') },
    { label: 'syzygy tangent', projector: 'syzygy', params: { ...defaults('syzygy'), orient: 'tangent' } },
    { label: 'motion bg=edges (runs 1-2 best)', projector: 'motion', params: { ...defaults('motion'), bg: 'edges' } },
    { label: `run3 winner by HOLD #${byHold[0].id} (${byHold[0].cell})`, projector: byHold[0].projector, params: byHold[0].params, hold: byHold[0].hold },
    { label: `run3 winner by U #${byU[0].id} (${byU[0].cell})`, projector: byU[0].projector, params: byU[0].params, hold: byU[0].hold },
  ];
  console.log(`=== run3 final: ${finalists.length} configs on ${testFeeds.length} untouched TEST feeds, ${critics.length}-critic ensemble ===`);
  report.run3 = { qmode, draws: draws.map(({ hex, ...d }) => ({ ...d, hex })), holdSeeds, testSeeds, critics, cells, final: [], byCell: {} };
  for (const f of finalists) {
    const res = await Promise.all(testFeeds.map((seq) => score('vlm', { seq, projection: project(f.projector, seq, f.params), ctx: ectx })));
    const row = { ...f, test: mean(res.map((x) => x.fidelity)), test_truth: mean(res.map((x) => x.detail.vs_truth.fidelity)),
                  motion: mean(res.filter((x) => x.detail.vs_vlm.motion_recall !== null).map((x) => x.detail.vs_vlm.motion_recall)),
                  per_scene: res.map((x) => +x.fidelity.toFixed(3)),
                  per_critic: Object.fromEntries(critics.map((c) => [c, +mean(res.map((x) => x.detail.per_critic?.[c] ?? x.fidelity)).toFixed(3)])),
                  chars: project(f.projector, testFeeds[0], f.params).char_budget };
    report.run3.final.push(row);
    console.log(`  ${f.label.padEnd(44)} test ${row.test.toFixed(3)}  truth ${row.test_truth.toFixed(3)}  motion ${row.motion.toFixed(2)}  chars ${row.chars}${f.hold !== undefined ? `  (hold ${f.hold.toFixed(3)})` : ''}  critics ${Object.values(row.per_critic).join('/')}`);
  }
  for (const h of r.history) (report.run3.byCell[h.cell] ||= []).push({ id: h.id, U: h.U, vlm: h.vlm, hold: h.hold ?? null });
  for (const [c, v] of Object.entries(report.run3.byCell)) {
    const hs = v.filter((x) => x.hold !== null).map((x) => x.hold);
    console.log(`  cell ${c.padEnd(16)} n=${v.length} best vlm ${Math.max(...v.map((x) => x.vlm)).toFixed(3)}  held-out evaluated ${hs.length}${hs.length ? `, best hold ${Math.max(...hs).toFixed(3)}` : ''}`);
  }
  report.run3.rejected = r.rejected;
  save();
}

report.api = stats; report.finished = new Date().toISOString(); save();
console.log(`api calls this run: ${stats.calls} (cache hits ${stats.cacheHits}) ${JSON.stringify(stats.byProvider)}`);
console.log(`report: ${path.relative(process.cwd(), OUT)}`);
const { closeRenderer } = await import('./render.mjs'); await closeRenderer();
