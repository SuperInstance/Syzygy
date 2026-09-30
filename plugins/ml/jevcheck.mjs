#!/usr/bin/env node
// jevcheck.mjs — does a cheap system-one critic (TypeSafe Jev, text only) track
// the paid VLM critic? Takes every config the searches scored, re-reads its VLM
// fidelity per feed from the cache (no new VLM calls), asks Jev for a
// legibility score on the same text, and reports rank correlation at the
// (config, feed) level and at the config level, next to the free scorers.
//   node plugins/ml/jevcheck.mjs [search.json ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, score, defaults, validateParams } from './index.mjs';
import { SCENES, renderSequence } from './scenes.mjs';
import { pearson } from './scorers/inverse.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const files = process.argv.slice(2).length ? process.argv.slice(2)
  : ['playtest-image-Qwen3-VL-30B-A3B-Instruct-search.json', 'playtest-run2-edges-search.json'].map((f) => path.join(HERE, 'logs', f));
const ctx = { critic_mode: 'image', critic_model: 'Qwen/Qwen3-VL-30B-A3B-Instruct' };

export function ranks(a) {
  const idx = a.map((v, i) => [v, i]).sort((x, y) => x[0] - y[0]), r = new Array(a.length);
  for (let i = 0; i < idx.length;) { let j = i; while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2; i = j + 1; }
  return r;
}
export const spearman = (a, b) => pearson(ranks(a), ranks(b));

const feeds = SCENES.map((s) => renderSequence(s));
const seen = new Set(), configs = [];
for (const f of files) for (const h of JSON.parse(fs.readFileSync(f, 'utf8')).history) {
  const params = { ...defaults(h.projector), ...h.params }, k = JSON.stringify([h.projector, params]);
  if (seen.has(k) || validateParams(h.projector, params).length) continue;
  seen.add(k); configs.push({ projector: h.projector, params });
}
console.log(`=== jevcheck: ${configs.length} configs x ${feeds.length} feeds ===`);
const pairs = [], perConfig = [];
for (const c of configs) {
  const rows = [];
  for (const seq of feeds) {
    const pr = project(c.projector, seq, c.params);
    const v = await score('vlm', { seq, projection: pr, ctx });
    const j = await score('jev', { seq, projection: pr });
    const inv = await score('inverse', { seq, projection: pr });
    rows.push({ vlm: v.fidelity, jev: j.fidelity, inv: inv.fidelity, chars: pr.char_budget });
  }
  pairs.push(...rows);
  const m = (k) => rows.reduce((s, r) => s + r[k], 0) / rows.length;
  perConfig.push({ ...c, vlm: m('vlm'), jev: m('jev'), inv: m('inv'), chars: m('chars') });
  console.log(`  vlm ${m('vlm').toFixed(3)}  jev ${m('jev').toFixed(3)}  inv ${m('inv').toFixed(3)}  ${c.projector} ${JSON.stringify(c.params).slice(0, 90)}`);
}
const col = (a, k) => a.map((r) => r[k]);
const out = {
  n_pairs: pairs.length, n_configs: perConfig.length,
  pair: { jev_spearman: spearman(col(pairs, 'jev'), col(pairs, 'vlm')), inv_spearman: spearman(col(pairs, 'inv'), col(pairs, 'vlm')) },
  config: { jev_spearman: spearman(col(perConfig, 'jev'), col(perConfig, 'vlm')), inv_spearman: spearman(col(perConfig, 'inv'), col(perConfig, 'vlm')),
            jev_pearson: pearson(col(perConfig, 'jev'), col(perConfig, 'vlm')) },
};
// as a filter: if the cascade only sent Jev's top half to the VLM, how many of the VLM's top 5 survive?
const byJev = [...perConfig].sort((a, b) => b.jev - a.jev).slice(0, Math.ceil(perConfig.length / 2));
const top5 = [...perConfig].sort((a, b) => b.vlm - a.vlm).slice(0, 5);
out.filter = { kept: byJev.length, vlm_top5_survive: top5.filter((t) => byJev.includes(t)).length };
console.log(JSON.stringify(out, null, 1));
fs.writeFileSync(path.join(HERE, 'logs', 'jevcheck.json'), JSON.stringify({ ...out, perConfig }, null, 1));
const { closeRenderer } = await import('./render.mjs'); await closeRenderer();   // else Chromium keeps node alive
