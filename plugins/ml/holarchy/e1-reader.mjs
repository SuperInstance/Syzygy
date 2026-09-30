#!/usr/bin/env node
// E1 — can a holarchy of first-person typed judgments (no VLM, no centre) read a
// scene out of a text projection? And at which level of organisation does the
// information die? 2 senses (receptors | raw text) x 2 rounds (alone | after
// hearing neighbours) x 4 projectors x 10 feeds, scored against ground truth
// next to the VLM critic (Qwen3-VL-30B, image mode) on the same text.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, score, defaults } from '../index.mjs';
import { SCENES, renderSequence, randomSpec } from '../scenes.mjs';
import { compareScenes } from '../compare.mjs';
import { readScene, tissueTruth } from './reader.mjs';
import { stats } from '../apis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run3 = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'logs', 'playtest-run3.json'), 'utf8')).run3;
const feeds = [...SCENES.map((s) => renderSequence(s)), ...run3.testSeeds.map((s) => renderSequence(randomSpec(s)))];
const PROJ = [['mirror', {}], ['syzygy tangent', { projector: 'syzygy', orient: 'tangent' }], ['motion edges', { projector: 'motion', bg: 'edges' }], ['braille', { projector: 'syzygy', field: 'braille' }]];
const vctx = { critic_mode: 'image', critic_model: 'Qwen/Qwen3-VL-30B-A3B-Instruct' };
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);

const rows = [];
for (const [label, o] of PROJ) {
  const name = o.projector || 'mirror', { projector, ...over } = o, params = { ...defaults(name), ...over };
  for (const seq of feeds) {
    const pr = project(name, seq, params);
    const vlm = await score('vlm', { seq, projection: pr, ctx: vctx });
    const row = { projector: label, feed: seq.truth.scene, vlm_truth: vlm.detail.vs_truth.fidelity, vlm_motion: vlm.detail.vs_truth.motion_recall };
    for (const sense of ['receptors', 'raw']) {
      const r = await readScene(pr.text_projection, { sense, rounds: 2, tag: `${label}:${seq.truth.scene}` });
      const tt = tissueTruth(seq.truth, r.tissues);
      for (const rd of r.rounds) {
        const c = compareScenes(seq.truth, rd.scene);
        const keys = Object.keys(tt), acc = keys.filter((k) => rd.claims[k].what === tt[k]).length / keys.length;
        const objT = keys.filter((k) => tt[k] !== 'background'), objAcc = objT.filter((k) => rd.claims[k].what === tt[k]).length / Math.max(1, objT.length);
        const bgT = keys.filter((k) => tt[k] === 'background'), bgAcc = bgT.filter((k) => rd.claims[k].what === 'background').length / Math.max(1, bgT.length);
        row[`${sense}_r${rd.round}`] = { fidelity: c.fidelity, tissue_acc: acc, object_tissue_acc: objAcc, background_acc: bgAcc,
          organ_recall: c.recall, organ_precision: c.precision, setting: rd.scene.setting === seq.truth.setting ? 1 : 0, motion_recall: c.motion_recall };
      }
    }
    rows.push(row);
    const f = (k) => row[k].fidelity.toFixed(3);
    console.log(`${label.padEnd(15)} ${seq.truth.scene.padEnd(10)} vlm ${row.vlm_truth.toFixed(3)} | receptors ${f('receptors_r1')} -> ${f('receptors_r2')} | raw ${f('raw_r1')} -> ${f('raw_r2')}`);
  }
}
const summary = {};
for (const [label] of PROJ) {
  const rs = rows.filter((r) => r.projector === label), s = { vlm: mean(rs.map((r) => r.vlm_truth)) };
  for (const k of ['receptors_r1', 'receptors_r2', 'raw_r1', 'raw_r2'])
    s[k] = Object.fromEntries(['fidelity', 'tissue_acc', 'object_tissue_acc', 'background_acc', 'organ_recall', 'organ_precision', 'setting']
      .map((m) => [m, +mean(rs.map((r) => r[k][m])).toFixed(3)]).concat([['motion_recall', +mean(rs.filter((r) => r[k].motion_recall !== null).map((r) => r[k].motion_recall)).toFixed(3)]]));
  summary[label] = s;
}
console.log('\n=== E1 summary (means over 10 feeds; all vs ground truth) ===');
for (const [label, s] of Object.entries(summary)) {
  console.log(`${label}: VLM ${s.vlm.toFixed(3)}`);
  for (const k of ['receptors_r1', 'receptors_r2', 'raw_r1', 'raw_r2']) console.log(`   ${k.padEnd(13)} fidelity ${s[k].fidelity.toFixed(3)}  tissue ${s[k].tissue_acc}  obj-tissue ${s[k].object_tissue_acc}  bg ${s[k].background_acc}  organ R/P ${s[k].organ_recall}/${s[k].organ_precision}  setting ${s[k].setting}  motion ${s[k].motion_recall}`);
}
fs.writeFileSync(path.join(HERE, '..', 'logs', 'holarchy-e1.json'), JSON.stringify({ summary, rows }, null, 1));
console.log(`api: ${stats.calls} calls, ${stats.cacheHits} cache hits ${JSON.stringify(stats.byProvider)}`);
const { closeRenderer } = await import('../render.mjs'); await closeRenderer();
