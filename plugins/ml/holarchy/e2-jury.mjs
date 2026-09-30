#!/usr/bin/env node
// E2 — a community jury instead of an average. Three VLM critics each
// reconstructed every run-3 finalist on every test feed (all cached). Instead of
// averaging them, who should be believed, case by case?
//   mean      the run-3 practice: average the three fidelities (a central rule)
//   peer      no centre, no judge: each reconstruction scores its agreement with
//             the other two (compare.mjs), the most-agreed-with one is believed
//   jev       a typed judge: TypeSafe Jev sees the three reconstructions (never
//             the truth) and chooses the most credible one (choice question)
//   jev+peer  Jev is shown the peer-agreement numbers too
//   oracle    the best of the three against truth (an upper bound no jury can see)
//   random    the expected value of picking one at random
// All scored against ground truth. Cost: one Jev request per case, 0 new VLM calls.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, score, defaults } from '../index.mjs';
import { renderSequence, randomSpec } from '../scenes.mjs';
import { compareScenes } from '../compare.mjs';
import { systemOne, stats } from '../apis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run3 = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'logs', 'playtest-run3.json'), 'utf8')).run3;
const feeds = run3.testSeeds.map((s) => renderSequence(randomSpec(s)));
const critics = run3.critics, mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const strip = (d) => d ? { setting: d.setting, scene: d.scene, objects: (d.objects || []).map(({ label, category, region, moving }) => ({ label, category, region, moving })) } : null;

const rows = [];
for (const f of run3.final) {
  for (const seq of feeds) {
    const pr = project(f.projector, seq, { ...defaults(f.projector), ...f.params });
    const recs = await Promise.all(critics.map((m) => score('vlm', { seq, projection: pr, ctx: { critic_mode: 'image', critic_model: m } })));
    const truthF = recs.map((r) => r.detail.vs_truth.fidelity), descs = recs.map((r) => r.detail.reconstruction);
    const peer = descs.map((d, i) => mean(descs.filter((_, j) => j !== i).map((e) => (compareScenes(e, d).fidelity + compareScenes(d, e).fidelity) / 2)));
    const names = ['A', 'B', 'C'];
    const state = Object.fromEntries(names.map((n, i) => [`reconstruction_${n}`, strip(descs[i])]));
    const q = (withPeer) => ({ believe: { type: 'choice',
      instructions: 'Three independent readers looked at the same character-art rendering of a camera frame and each reconstructed the scene. They cannot all be right. Which reconstruction is most likely to be accurate? Prefer plausible, internally consistent scenes (objects that belong together, sensible positions and settings) over long or imaginative ones.'
        + (withPeer ? ` How much each reconstruction agrees with the other two (0-1): ${names.map((n, i) => `${n} ${peer[i].toFixed(2)}`).join(', ')}.` : ''),
      criteria: Object.fromEntries(names.map((n) => [n, `reconstruction_${n} is the most accurate`])) } });
    const j1 = await systemOne({ task: 'jury', ...state }, q(false), { tag: 'jury:plain' });
    const j2 = await systemOne({ task: 'jury', ...state }, q(true), { tag: 'jury:peer' });
    const pick = (r) => names.indexOf(r.answers?.believe?.choice);
    const pj = pick(j1), pjp = pick(j2), pp = peer.indexOf(Math.max(...peer));
    rows.push({ config: f.label, feed: seq.truth.scene, truth: truthF, peer,
                mean: mean(truthF), oracle: Math.max(...truthF), random: mean(truthF),
                peerPick: truthF[pp], jev: pj >= 0 ? truthF[pj] : mean(truthF), jevPeer: pjp >= 0 ? truthF[pjp] : mean(truthF),
                jevChoice: critics[pj], jevPeerChoice: critics[pjp] });
  }
}
const M = (k) => mean(rows.map((r) => r[k]));
// "mean" and "random" have the same expectation; mean is the scorer run 3 used, random is the chance baseline for a single pick.
console.log(`=== E2 community jury: ${rows.length} cases (6 run-3 finalists x 6 test feeds), fidelity vs ground truth ===`);
for (const [k, lab] of [['mean', 'average of 3 (run-3 practice) / random pick'], ['peerPick', 'peer consensus: most-agreed-with reconstruction'],
                        ['jev', 'Jev chooses (reconstructions only)'], ['jevPeer', 'Jev chooses (+ peer-agreement numbers)'], ['oracle', 'oracle: best of 3 vs truth']])
  console.log(`  ${lab.padEnd(50)} ${M(k).toFixed(3)}`);
const share = (k) => Object.fromEntries(critics.map((c) => [c.split('/').pop(), rows.filter((r) => r[k] === c).length]));
console.log('  Jev picked:', JSON.stringify(share('jevChoice')), ' with peer info:', JSON.stringify(share('jevPeerChoice')));
const gap = M('oracle') - M('mean');
console.log(`  share of the (oracle - average) gap closed: peer ${((M('peerPick') - M('mean')) / gap * 100).toFixed(0)}%, jev ${((M('jev') - M('mean')) / gap * 100).toFixed(0)}%, jev+peer ${((M('jevPeer') - M('mean')) / gap * 100).toFixed(0)}%`);
fs.writeFileSync(path.join(HERE, '..', 'logs', 'holarchy-e2.json'), JSON.stringify({ rows }, null, 1));
console.log(`api: ${stats.calls} calls, ${stats.cacheHits} cache hits ${JSON.stringify(stats.byProvider)}`);
const { closeRenderer } = await import('../render.mjs'); await closeRenderer();
