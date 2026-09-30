#!/usr/bin/env node
// E5 — a regime selector: the idea the research community converged on in
// generation 2. E2 and E4 disagree about how to combine perspectives (E2:
// consensus wins among three competent VLM critics; E4: union wins between two
// weak senses). Can a holarchy decide PER CASE which regime it is in?
//   agreement a  how much the perspectives agree (free to compute):
//                E2: mean pairwise scene agreement of the three reconstructions
//                E4: of tissues where either sense sees an object, the fraction
//                    where both senses name the same thing
//   rules        fixed consensus | fixed union | threshold on a (tau fitted on
//                the OTHER dataset: transfer) | Jev chooses per case (typed
//                choice, told the agreement and what the members are)
// Scored against ground truth. New API calls: only the Jev regime questions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, score, defaults } from '../index.mjs';
import { SCENES, renderSequence, randomSpec } from '../scenes.mjs';
import { compareScenes, whereScore, sameWhat } from '../compare.mjs';
import { readScene, organs, TW, TH } from './reader.mjs';
import { systemOne, stats } from '../apis.mjs';
import { boot } from './stats.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), LOGS = path.join(HERE, '..', 'logs');
const run3 = JSON.parse(fs.readFileSync(path.join(LOGS, 'playtest-run3.json'), 'utf8')).run3;
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);

// ---- E2 cases: three critic reconstructions ----------------------------------
function unionScenes(descs) {
  const objs = [];
  for (const d of descs) for (const o of d?.objects || [])
    if (!objs.some((p) => sameWhat(p, o) && whereScore(p, o) >= 0.6)) objs.push(o);
  const votes = {}; for (const d of descs) if (d?.setting) votes[d.setting] = (votes[d.setting] || 0) + 1;
  return { setting: Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'unknown', objects: objs };
}
const e2 = [];
const testFeeds = run3.testSeeds.map((s) => renderSequence(randomSpec(s)));
for (const f of run3.final) for (const seq of testFeeds) {
  const pr = project(f.projector, seq, { ...defaults(f.projector), ...f.params });
  const recs = await Promise.all(run3.critics.map((m) => score('vlm', { seq, projection: pr, ctx: { critic_mode: 'image', critic_model: m } })));
  const D = recs.map((r) => r.detail.reconstruction);
  const pair = (i, j) => (compareScenes(D[i], D[j]).fidelity + compareScenes(D[j], D[i]).fidelity) / 2;
  const peer = D.map((_, i) => mean(D.map((__, j) => (j === i ? null : pair(i, j))).filter((x) => x !== null)));
  const agreement = mean([pair(0, 1), pair(0, 2), pair(1, 2)]);
  e2.push({ agreement, consensus: compareScenes(seq.truth, D[peer.indexOf(Math.max(...peer))]).fidelity,
            union: compareScenes(seq.truth, unionScenes(D)).fidelity, n_members: 3, member: 'a vision-language model (strong reader)' });
}

// ---- E4 readings: two weak Jev senses per tissue (cached) --------------------
const e4 = [];
const feeds10 = [...SCENES.map((s) => renderSequence(s)), ...testFeeds];
const PROJ = [['mirror', 'mirror', {}], ['syzygy tangent', 'syzygy', { orient: 'tangent' }], ['motion edges', 'motion', { bg: 'edges' }], ['braille', 'syzygy', { field: 'braille' }]];
for (const [label, name, over] of PROJ) for (const seq of feeds10) {
  const text = project(name, seq, { ...defaults(name), ...over }).text_projection, tag = `${label}:${seq.truth.scene}`;
  const A = await readScene(text, { sense: 'receptors', rounds: 2, tag }), B = await readScene(text, { sense: 'raw', rounds: 2, tag });
  const a = A.rounds[0].claims, b = B.rounds[0].claims, keys = Object.keys(a);
  const active = keys.filter((k) => a[k].what !== 'background' || b[k].what !== 'background');
  const agreement = active.length ? active.filter((k) => a[k].what === b[k].what).length / active.length : 1;
  const mk = (pick) => ({ ...organs(A.tissues, Object.fromEntries(keys.map((k) => [k, pick(k)]))), setting: B.setting });
  const mot = (k) => (a[k].motion !== 'none' ? a[k].motion : b[k].motion), BG = (k) => ({ what: 'background', conf: 1, motion: mot(k) });
  e4.push({ agreement,
    consensus: compareScenes(seq.truth, mk((k) => (a[k].what === b[k].what && a[k].what !== 'background' ? { ...a[k], motion: mot(k) } : BG(k)))).fidelity,
    union: compareScenes(seq.truth, mk((k) => (a[k].what !== 'background' ? { ...a[k], motion: mot(k) } : b[k].what !== 'background' ? { ...b[k], motion: mot(k) } : BG(k)))).fidelity,
    n_members: 2, member: 'a weak typed reader of one sense (raw text or numeric receptors)' });
}

// ---- regime rules -----------------------------------------------------------
const byTau = (cases, tau) => cases.map((c) => (c.agreement >= tau ? c.consensus : c.union));
const fitTau = (cases) => { let best = 0, bv = -1; for (let t = 0; t <= 1.0001; t += 0.01) { const v = mean(byTau(cases, t)); if (v > bv) { bv = v; best = t; } } return +best.toFixed(2); };
async function jevRegime(cases, tag) {
  const out = [];
  for (let i = 0; i < cases.length; i += 20) {
    const chunk = cases.slice(i, i + 20), qs = {};
    chunk.forEach((c, j) => { qs[`c${j}`] = { type: 'choice',
      instructions: `${c.n_members} independent perspectives, each ${c.member}, each tried to identify the objects in the same scene. Their agreement with each other is ${c.agreement.toFixed(2)} (0 = none, 1 = identical). Should the group keep only what they agree on (consensus), or keep everything any of them saw (union)? Consensus is better when members are individually reliable and their mistakes are random noise; union is better when members are individually weak and each misses different things.`,
      criteria: { consensus: 'keep only what the perspectives agree on', union: 'keep everything any perspective saw' } }; });
    const r = await systemOne({ task: 'choose an aggregation regime per case' }, qs, { tag });
    chunk.forEach((c, j) => out.push(r.answers[`c${j}`]?.choice === 'union' ? c.union : c.consensus));
  }
  return out;
}
const report = {};
for (const [name, cases, other] of [['E2 (3 VLM critics)', e2, e4], ['E4 (2 weak Jev senses)', e4, e2]]) {
  const tauOther = fitTau(other), tauSelf = fitTau(cases), jev = await jevRegime(cases, `regime:${name.slice(0, 2)}`);
  const cons = cases.map((c) => c.consensus), uni = cases.map((c) => c.union), best = cases.map((c) => Math.max(c.consensus, c.union));
  const transfer = byTau(cases, tauOther);
  report[name] = { n: cases.length, mean_agreement: +mean(cases.map((c) => c.agreement)).toFixed(3), consensus: mean(cons), union: mean(uni),
    tau_transfer: tauOther, transfer: mean(transfer), tau_insample: tauSelf, insample: mean(byTau(cases, tauSelf)), jev: mean(jev), oracle: mean(best),
    jev_vs_bestfixed: boot(jev, mean(cons) >= mean(uni) ? cons : uni), transfer_vs_bestfixed: boot(transfer, mean(cons) >= mean(uni) ? cons : uni) };
  const R = report[name];
  console.log(`=== ${name}: n=${R.n}, mean agreement ${R.mean_agreement} ===`);
  console.log(`  fixed consensus ${R.consensus.toFixed(3)} | fixed union ${R.union.toFixed(3)} | oracle per case ${R.oracle.toFixed(3)}`);
  console.log(`  threshold fitted on the OTHER dataset (tau ${R.tau_transfer}) ${R.transfer.toFixed(3)} | in-sample tau ${R.tau_insample}: ${R.insample.toFixed(3)} (optimistic)`);
  console.log(`  Jev chooses per case ${R.jev.toFixed(3)}`);
  console.log(`  Jev - best fixed rule: ${R.jev_vs_bestfixed.diff} CI [${R.jev_vs_bestfixed.ci95}] | transfer - best fixed: ${R.transfer_vs_bestfixed.diff} CI [${R.transfer_vs_bestfixed.ci95}]`);
}
fs.writeFileSync(path.join(LOGS, 'holarchy-e5.json'), JSON.stringify({ report, e2, e4 }, null, 1));
console.log(`api: ${stats.calls} calls, ${stats.cacheHits} cache hits ${JSON.stringify(stats.byProvider)}`);
const { closeRenderer } = await import('../render.mjs'); await closeRenderer();
