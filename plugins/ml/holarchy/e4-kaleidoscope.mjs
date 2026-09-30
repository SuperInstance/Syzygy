#!/usr/bin/env node
// E4 — the kaleidoscope rule, tested inside the E1 holarchy at zero API cost.
// E2 found that agreement between INDEPENDENT readers is a free credibility
// signal; E1 found that gossip between neighbours spreads object labels into
// empty sky. So: each tissue has two independent senses (its raw text patch, and
// its cell receptors), judged separately by Jev in E1 (all cached). A tissue
// asserts an object only where
//   agree      both senses name the same thing (else: background)
//   agree+nbr  both agree, OR one sense agrees with the majority of neighbours
//              that themselves had agreeing senses (evidence-weighted gossip)
//   either     either sense's non-background claim (the permissive union)
// and the organs grow from those tissues exactly as in E1. Scored vs truth.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, defaults } from '../index.mjs';
import { SCENES, renderSequence, randomSpec } from '../scenes.mjs';
import { compareScenes } from '../compare.mjs';
import { readScene, organs, tissueTruth, TW, TH } from './reader.mjs';
import { stats } from '../apis.mjs';
import { boot } from './stats.mjs';

process.env.SYZ_ML_OFFLINE = '1';   // every Jev answer needed was cached by E1
const HERE = path.dirname(fileURLToPath(import.meta.url));
const run3 = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'logs', 'playtest-run3.json'), 'utf8')).run3;
const feeds = [...SCENES.map((s) => renderSequence(s)), ...run3.testSeeds.map((s) => renderSequence(randomSpec(s)))];
const PROJ = [['mirror', 'mirror', {}], ['syzygy tangent', 'syzygy', { orient: 'tangent' }], ['motion edges', 'motion', { bg: 'edges' }], ['braille', 'syzygy', { field: 'braille' }]];
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const BG = { what: 'background', conf: 1, motion: 'none', mconf: 1 };

const out = { rec: [], raw: [], either: [], agree: [], agreeNbr: [] }, bgAcc = { rec: [], raw: [], either: [], agree: [], agreeNbr: [] };
for (const [label, name, over] of PROJ) for (const seq of feeds) {
  const text = project(name, seq, { ...defaults(name), ...over }).text_projection;
  const tag = `${label}:${seq.truth.scene}`;
  const A = await readScene(text, { sense: 'receptors', rounds: 2, tag }), B = await readScene(text, { sense: 'raw', rounds: 2, tag });
  const a = A.rounds[0].claims, b = B.rounds[0].claims, tissues = A.tissues, setting = B.setting;
  const k = (x, y) => `${x}_${y}`;
  const motion = (i) => (a[i].motion !== 'none' ? a[i].motion : b[i].motion);
  const agreeC = {}, eitherC = {};
  for (const t of tissues) {
    const i = k(t.tx, t.ty);
    agreeC[i] = a[i].what === b[i].what && a[i].what !== 'background' ? { ...a[i], motion: motion(i) } : { ...BG, motion: motion(i) };
    eitherC[i] = a[i].what !== 'background' ? { ...a[i], motion: motion(i) } : b[i].what !== 'background' ? { ...b[i], motion: motion(i) } : { ...BG, motion: motion(i) };
  }
  const nbrC = { ...agreeC };
  for (const t of tissues) {
    const i = k(t.tx, t.ty); if (agreeC[i].what !== 'background') continue;
    const votes = {};
    for (const [x, y] of [[t.tx, t.ty - 1], [t.tx, t.ty + 1], [t.tx - 1, t.ty], [t.tx + 1, t.ty]])
      if (x >= 0 && y >= 0 && x < TW && y < TH && agreeC[k(x, y)].what !== 'background') votes[agreeC[k(x, y)].what] = (votes[agreeC[k(x, y)].what] || 0) + 1;
    const top = Object.entries(votes).sort((p, q) => q[1] - p[1])[0];
    if (top && (a[i].what === top[0] || b[i].what === top[0])) nbrC[i] = { what: top[0], conf: 0.5, motion: motion(i), mconf: 0.5 };
  }
  const tt = tissueTruth(seq.truth, tissues), bgKeys = Object.keys(tt).filter((x) => tt[x] === 'background');
  for (const [key, claims] of [['rec', a], ['raw', b], ['either', eitherC], ['agree', agreeC], ['agreeNbr', nbrC]]) {
    out[key].push(compareScenes(seq.truth, { ...organs(tissues, claims), setting }).fidelity);
    bgAcc[key].push(bgKeys.filter((x) => claims[x].what === 'background').length / Math.max(1, bgKeys.length));
  }
}
console.log('=== E4 kaleidoscope rule (40 readings: 4 projectors x 10 feeds; 0 new API calls) ===');
for (const [k, lab] of [['rec', 'receptors sense alone (E1)'], ['raw', 'raw-text sense alone (E1)'], ['either', 'union: either sense'], ['agree', 'kaleidoscope: both senses agree'], ['agreeNbr', 'kaleidoscope + evidence-weighted neighbours']])
  console.log(`  ${lab.padEnd(46)} fidelity ${mean(out[k]).toFixed(3)}   background kept ${mean(bgAcc[k]).toFixed(3)}`);
const best1 = out.rec.map((x, i) => Math.max(x, out.raw[i]));
for (const [k, r] of Object.entries({ 'agree - receptors': boot(out.agree, out.rec), 'agree - raw': boot(out.agree, out.raw), 'agreeNbr - agree': boot(out.agreeNbr, out.agree),
                                      'agree - either': boot(out.agree, out.either), 'either - raw (union vs better sense)': boot(out.either, out.raw), 'either - best single (oracle pick)': boot(out.either, best1), 'agree - best single (oracle pick)': boot(out.agree, best1) }))
  console.log(`  ${k.padEnd(34)} diff ${r.diff >= 0 ? '+' : ''}${r.diff}  95% CI [${r.ci95.join(', ')}]  P(<=0) ${r.p_le0}`);
fs.writeFileSync(path.join(HERE, '..', 'logs', 'holarchy-e4.json'), JSON.stringify({ out, bgAcc }, null, 1));
console.log(`api: ${stats.calls} calls, ${stats.cacheHits} cache hits`);
