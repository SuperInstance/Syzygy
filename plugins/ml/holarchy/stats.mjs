#!/usr/bin/env node
// stats.mjs — paired bootstrap for the holarchy experiments: is a difference
// real, or noise across n cases? Prints mean difference, 95% CI, P(diff <= 0).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { rng } from '../core.mjs';
const L = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'logs');
const J = (f) => JSON.parse(fs.readFileSync(path.join(L, f), 'utf8'));
export function boot(a, b, B = 20000, seed = 12345) {
  const d = a.map((x, i) => x - b[i]), n = d.length, R = rng(seed), m = d.reduce((s, x) => s + x, 0) / n, bs = [];
  for (let k = 0; k < B; k++) { let s = 0; for (let i = 0; i < n; i++) s += d[R.next() % n]; bs.push(s / n); }
  bs.sort((x, y) => x - y);
  return { n, diff: +m.toFixed(4), ci95: [+bs[Math.floor(0.025 * B)].toFixed(4), +bs[Math.floor(0.975 * B)].toFixed(4)], p_le0: +(bs.filter((x) => x <= 0).length / B).toFixed(4) };
}
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
const out = {};
const e2 = J('holarchy-e2.json').rows, col = (k) => e2.map((r) => r[k]);
out['E2 peer - mean'] = boot(col('peerPick'), col('mean'));
out['E2 jev - mean'] = boot(col('jev'), col('mean'));
out['E2 peer - jev'] = boot(col('peerPick'), col('jev'));
const e3 = J('holarchy-e3.json').res, v = (c) => e3[c].map((x) => x.vs_vlm);
out['E3 jev_r2 - jev_r1'] = boot(v('jev_r2'), v('jev_r1'));
out['E3 edges - jev_r2'] = boot(v('edges'), v('jev_r2'));
out['E3 hand - random'] = boot(v('hand'), v('random'));
const e1 = J('holarchy-e1.json').rows, f = (k) => e1.map((r) => r[k].fidelity);
out['E1 receptors_r2 - receptors_r1'] = boot(f('receptors_r2'), f('receptors_r1'));
out['E1 raw_r2 - raw_r1'] = boot(f('raw_r2'), f('raw_r1'));
const edges = e1.filter((r) => r.projector !== 'mirror');
out['E1 VLM - best swarm (non-mirror)'] = boot(edges.map((r) => r.vlm_truth), edges.map((r) => Math.max(r.receptors_r1.fidelity, r.raw_r1.fidelity)));
for (const [k, r] of Object.entries(out)) console.log(`${k.padEnd(34)} n=${r.n}  diff ${r.diff >= 0 ? '+' : ''}${r.diff}  95% CI [${r.ci95.join(', ')}]  P(<=0) ${r.p_le0}`);
fs.writeFileSync(path.join(L, 'holarchy-stats.json'), JSON.stringify(out, null, 1));
}
