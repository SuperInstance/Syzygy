#!/usr/bin/env node
// E7 — a causal test of the E6 principle, and the track-record selector.
// Principle: consensus repairs SUBSTITUTION errors, union repairs OMISSION errors.
// Intervention: take the three VLM critics' real reconstructions (E2 cases,
// a substitution regime where consensus wins) and inject omissions by deleting
// each claimed object with probability p (seeded). If the principle is causal,
// the winning rule must flip from consensus to union as p rises.
// Track-record selector: split cases into calibration / evaluation halves. On
// calibration cases (truth known) estimate the members' mean claim ratio
// (claims / true objects); pick union if it is below 0.5, else consensus; apply
// that choice to the evaluation half. Compared with the best fixed rule.
// 0 new API calls: all reconstructions are cached from run 3 / E2.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, score, defaults } from '../index.mjs';
import { renderSequence, randomSpec } from '../scenes.mjs';
import { compareScenes, whereScore, sameWhat } from '../compare.mjs';
import { rng } from '../core.mjs';
import { stats } from '../apis.mjs';
import { boot } from './stats.mjs';
process.env.SYZ_ML_OFFLINE = '1';
const HERE = path.dirname(fileURLToPath(import.meta.url)), LOGS = path.join(HERE, '..', 'logs');
const run3 = JSON.parse(fs.readFileSync(path.join(LOGS, 'playtest-run3.json'), 'utf8')).run3;
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const testFeeds = run3.testSeeds.map((s) => renderSequence(randomSpec(s)));

const cases = [];
for (const f of run3.final) for (const seq of testFeeds) {
  const pr = project(f.projector, seq, { ...defaults(f.projector), ...f.params });
  const D = await Promise.all(run3.critics.map(async (m) => (await score('vlm', { seq, projection: pr, ctx: { critic_mode: 'image', critic_model: m } })).detail.reconstruction));
  cases.push({ truth: seq.truth, D });
}
const pair = (a, b) => (compareScenes(a, b).fidelity + compareScenes(b, a).fidelity) / 2;
const consensus = (D) => { const peer = D.map((d, i) => mean(D.filter((_, j) => j !== i).map((e) => pair(d, e)))); return D[peer.indexOf(Math.max(...peer))]; };
const union = (D) => { const objs = []; for (const d of D) for (const o of d?.objects || []) if (!objs.some((p) => sameWhat(p, o) && whereScore(p, o) >= 0.6)) objs.push(o);
  const v = {}; for (const d of D) if (d?.setting) v[d.setting] = (v[d.setting] || 0) + 1; return { setting: Object.entries(v).sort((a, b) => b[1] - a[1])[0]?.[0], objects: objs }; };
const drop = (D, p, seed) => { const R = rng(seed); return D.map((d) => ({ ...d, objects: (d?.objects || []).filter(() => R.float() >= p) })); };

const table = [], rows = {};
for (const p of [0, 0.3, 0.5, 0.7, 0.85]) {
  const cons = [], uni = [], ratio = [];
  cases.forEach((c, i) => {
    const D = drop(c.D, p, 1000 + i);
    cons.push(compareScenes(c.truth, consensus(D)).fidelity); uni.push(compareScenes(c.truth, union(D)).fidelity);
    ratio.push(mean(D.map((d) => (d.objects || []).length)) / c.truth.objects.length);
  });
  rows[p] = { cons, uni, ratio };
  const b = boot(uni, cons);
  table.push({ p, claim_ratio: mean(ratio), consensus: mean(cons), union: mean(uni), union_minus_consensus: b });
  console.log(`omission p=${p.toFixed(2)}  claim ratio x${mean(ratio).toFixed(2)}  consensus ${mean(cons).toFixed(3)}  union ${mean(uni).toFixed(3)}  union-consensus ${b.diff >= 0 ? '+' : ''}${b.diff} CI [${b.ci95}]  -> ${b.ci95[0] > 0 ? 'UNION wins' : b.ci95[1] < 0 ? 'CONSENSUS wins' : 'tie'}`);
}
// track-record selector: calibrate on even cases, evaluate on odd cases, per omission level
console.log('\ntrack-record selector (calibrate on even cases, evaluate on odd):');
const sel = [];
for (const p of Object.keys(rows)) {
  const { cons, uni, ratio } = rows[p], ev = (i) => i % 2 === 1, ca = (i) => i % 2 === 0;
  const calRatio = mean(ratio.filter((_, i) => ca(i))), pick = calRatio < 0.5 ? 'union' : 'consensus';
  const chosen = (pick === 'union' ? uni : cons).filter((_, i) => ev(i));
  const bestFixedName = mean(cons.filter((_, i) => ca(i))) >= mean(uni.filter((_, i) => ca(i))) ? 'consensus' : 'union';   // what calibration-by-fidelity would pick
  const other = (pick === 'union' ? cons : uni).filter((_, i) => ev(i));
  sel.push({ p: +p, calRatio, pick, eval: mean(chosen), alternative: mean(other), fidelity_calibrated_pick: bestFixedName });
  console.log(`  p=${(+p).toFixed(2)}  calibration claim ratio x${calRatio.toFixed(2)} -> ${pick.padEnd(9)} eval ${mean(chosen).toFixed(3)} (other rule ${mean(other).toFixed(3)})  | picking by calibration fidelity would choose ${bestFixedName}`);
}
fs.writeFileSync(path.join(LOGS, 'holarchy-e7.json'), JSON.stringify({ table, sel }, null, 1));
console.log(`api: ${stats.calls} calls, ${stats.cacheHits} cache hits`);
const { closeRenderer } = await import('../render.mjs'); await closeRenderer();
