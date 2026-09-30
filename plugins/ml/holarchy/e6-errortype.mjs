#!/usr/bin/env node
// E6 — what actually sets the regime? E5 showed agreement does not. Hypothesis:
// the members' ERROR TYPE does. Over-claimers (low precision: they invent
// objects) are fixed by consensus; under-claimers (low recall: they miss
// objects) are fixed by union. Measured per member against ground truth, then a
// TRUTH-FREE proxy is tested: a member's claim rate relative to its peers.
// 0 new API calls (everything is cached from E1, E2, run 3).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, score, defaults } from '../index.mjs';
import { SCENES, renderSequence, randomSpec } from '../scenes.mjs';
import { compareScenes } from '../compare.mjs';
import { readScene } from './reader.mjs';
import { stats } from '../apis.mjs';
process.env.SYZ_ML_OFFLINE = '1';
const HERE = path.dirname(fileURLToPath(import.meta.url)), LOGS = path.join(HERE, '..', 'logs');
const run3 = JSON.parse(fs.readFileSync(path.join(LOGS, 'playtest-run3.json'), 'utf8')).run3;
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const testFeeds = run3.testSeeds.map((s) => renderSequence(randomSpec(s)));

const members = {};
const add = (who, truth, d) => { const c = compareScenes(truth, d); (members[who] ||= []).push({ P: c.precision, R: c.recall, n: (d?.objects || []).length, nt: truth.objects.length }); };
for (const f of run3.final) for (const seq of testFeeds) {
  const pr = project(f.projector, seq, { ...defaults(f.projector), ...f.params });
  for (const m of run3.critics) add(`E2 critic ${m.split('/').pop()}`, seq.truth, (await score('vlm', { seq, projection: pr, ctx: { critic_mode: 'image', critic_model: m } })).detail.reconstruction);
}
const feeds10 = [...SCENES.map((s) => renderSequence(s)), ...testFeeds];
for (const [label, name, over] of [['mirror', 'mirror', {}], ['syzygy tangent', 'syzygy', { orient: 'tangent' }], ['motion edges', 'motion', { bg: 'edges' }], ['braille', 'syzygy', { field: 'braille' }]])
  for (const seq of feeds10) {
    const text = project(name, seq, { ...defaults(name), ...over }).text_projection, tag = `${label}:${seq.truth.scene}`;
    for (const sense of ['receptors', 'raw']) add(`E4 Jev sense ${sense}`, seq.truth, (await readScene(text, { sense, rounds: 2, tag })).rounds[0].scene);
  }
console.log('member                                   precision  recall   objects claimed / true   P-R   verdict');
const out = {};
for (const [who, rs] of Object.entries(members)) {
  const P = mean(rs.map((r) => r.P)), R = mean(rs.map((r) => r.R)), n = mean(rs.map((r) => r.n)), nt = mean(rs.map((r) => r.nt));
  out[who] = { precision: P, recall: R, claimed: n, true: nt, claim_ratio: n / nt };
  console.log(`${who.padEnd(40)} ${P.toFixed(3)}      ${R.toFixed(3)}    ${n.toFixed(2)} / ${nt.toFixed(2)} (x${(n / nt).toFixed(2)})   ${(P - R >= 0 ? '+' : '') + (P - R).toFixed(2)}   ${n / nt > 1 ? 'over-claims -> consensus' : 'under-claims -> union'}`);
}
fs.writeFileSync(path.join(LOGS, 'holarchy-e6.json'), JSON.stringify(out, null, 1));
console.log(`api: ${stats.calls} calls, ${stats.cacheHits} cache hits`);
const { closeRenderer } = await import('../render.mjs'); await closeRenderer();
