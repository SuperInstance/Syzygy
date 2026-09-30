#!/usr/bin/env node
// E3 — guided growth of a projection by tissues that choose how to draw
// themselves. The frame is tiled 8 x 4. Each tissue is a first-person agent that
// SENSES its own patch of the real frame as numbers (brightness, texture, edge
// energy and direction, motion energy) and chooses a way to draw itself:
//   tone    shading only (the mirror)
//   edges   the kernel's edge glyphs relabelled to lie along edges (tangent)
//   braille the kernel's 8-dot braille (fine shape)
//   motion  tangent edges + motion arrows and trails
// Round 2: each tissue also hears its neighbours' choices (organs read best when
// neighbours draw a shape the same way) and chooses again. The final text is a
// mosaic: every tissue copies its characters from the rendering it chose.
// No central controller; no gradient; one Jev request per frame per round.
//
// Controls (same mosaic machinery, no Jev): a hand-written rule on the same
// numbers, a seeded random mosaic, and each single rendering on its own.
// Scored by the 3-VLM ensemble against ground truth and against the VLM reading
// of the real frames, on 10 feeds (4 search + 6 run-3 test).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, score, defaults, countChars } from '../index.mjs';
import { SCENES, renderSequence, randomSpec } from '../scenes.mjs';
import { lumaGrid, rng } from '../core.mjs';
import { systemOne, stats } from '../apis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const run3 = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'logs', 'playtest-run3.json'), 'utf8')).run3;
const feeds = [...SCENES.map((s) => renderSequence(s)), ...run3.testSeeds.map((s) => renderSequence(randomSpec(s)))];
const ctx = { critic_mode: 'image', critic_models: run3.critics };
const TW = 8, TH = 4, COLS = 64;
const ORGANS = {
  tone: ['mirror', {}],
  edges: ['syzygy', { orient: 'tangent' }],
  braille: ['syzygy', { field: 'braille' }],
  motion: ['motion', { bg: 'edges' }],
};
const DESCR = {
  tone: 'shading only: smooth brightness, best for sky, ground, walls and soft gradients',
  edges: 'outline glyphs along edges: best where a boundary or the outline of a shape crosses me',
  braille: 'fine dot texture: best for small detailed shapes that outlines would lose',
  motion: 'outlines plus motion arrows: best when something is moving through me',
};
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);

function renderings(seq) {
  const out = {};
  for (const [k, [name, over]] of Object.entries(ORGANS)) out[k] = project(name, seq, { ...defaults(name), cols: COLS, ...over }).text_projection.split('\n').map((l) => [...l]);
  return out;
}

// first-person senses of each tissue, from the REAL frames at cell resolution
function senses(seq, cols, rows) {
  const n = seq.frames.length, L = lumaGrid(seq.frames[n - 1], cols, rows), P = lumaGrid(seq.frames[Math.max(0, n - 4)], cols, rows);
  const scene = mean([...L]), out = [];
  for (let ty = 0; ty < TH; ty++) for (let tx = 0; tx < TW; tx++) {
    const y0 = Math.floor(ty * rows / TH), y1 = Math.floor((ty + 1) * rows / TH), x0 = Math.floor(tx * cols / TW), x1 = Math.floor((tx + 1) * cols / TW);
    const v = [], gx = [], gy = [], mo = [];
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
      const i = y * cols + x; v.push(L[i]); mo.push(Math.abs(L[i] - P[i]));
      if (x + 1 < cols) gx.push(Math.abs(L[i + 1] - L[i])); if (y + 1 < rows) gy.push(Math.abs(L[i + cols] - L[i]));
    }
    const m = mean(v), sd = Math.sqrt(mean(v.map((x) => (x - m) ** 2)));
    out.push({ tx, ty, x0, x1, y0, y1, sense: {
      where: `row ${ty + 1} of ${TH} (top to bottom), column ${tx + 1} of ${TW} (left to right)`,
      brightness_0to9: +(9 * m / 255).toFixed(1), contrast_vs_scene: +(9 * (m - scene) / 255).toFixed(1), texture_0to9: +(9 * sd / 128).toFixed(1),
      edge_energy_0to9: +Math.min(9, 9 * (mean(gx) + mean(gy)) / 60).toFixed(1),
      edge_direction: mean(gx) > 1.5 * mean(gy) ? 'mostly vertical boundaries' : mean(gy) > 1.5 * mean(gx) ? 'mostly horizontal boundaries' : 'mixed or none',
      motion_energy_0to9: +Math.min(9, 9 * mean(mo) / 40).toFixed(1) } });
  }
  return out;
}

const hand = (s) => s.motion_energy_0to9 >= 1.5 ? 'motion' : s.edge_energy_0to9 >= 1.5 ? (s.texture_0to9 >= 3 ? 'braille' : 'edges') : 'tone';

async function jevChoose(tissues, prev, tag) {
  const qs = {};
  for (const t of tissues) {
    let heard = '';
    if (prev) {
      const nb = [['north', t.tx, t.ty - 1], ['south', t.tx, t.ty + 1], ['west', t.tx - 1, t.ty], ['east', t.tx + 1, t.ty]]
        .filter(([, x, y]) => x >= 0 && y >= 0 && x < TW && y < TH).map(([d, x, y]) => `${d} chose ${prev[y * TW + x]}`);
      heard = ` My neighbours chose: ${nb.join(', ')}. A shape reads best when the tissues it spans draw it the same way, but I should not copy a neighbour whose situation is unlike mine.`;
    }
    qs[`t_${t.tx}_${t.ty}`] = { type: 'choice',
      instructions: `I am one tissue of a camera frame that will be drawn as character art, tiled ${TW} x ${TH}. I choose how to draw my own patch so that a viewer can recognise what is in the whole picture. What my own patch of the real frame looks like: ${JSON.stringify(t.sense)}.${heard} How should I draw myself?`,
      criteria: DESCR };
  }
  const r = await systemOne({ task: 'tissues choosing their own rendering' }, qs, { tag });
  return tissues.map((t) => r.answers[`t_${t.tx}_${t.ty}`]?.choice ?? 'tone');
}

function mosaic(R, tissues, pick) {
  const G = R.tone.map((row) => [...row]);
  tissues.forEach((t, i) => { for (let y = t.y0; y < t.y1; y++) for (let x = t.x0; x < t.x1; x++) G[y][x] = R[pick[i]][y][x]; });
  return G.map((r) => r.join('')).join('\n');
}

const conds = ['jev_r1', 'jev_r2', 'hand', 'random', 'tone', 'edges', 'braille', 'motion'];
const res = Object.fromEntries(conds.map((c) => [c, []])), picks = { jev_r1: {}, jev_r2: {}, hand: {} };
for (const seq of feeds) {
  const R = renderings(seq), rows = R.tone.length, tissues = senses(seq, COLS, rows);
  const p1 = await jevChoose(tissues, null, `growth:${seq.truth.scene}:r1`);
  const p2 = await jevChoose(tissues, p1, `growth:${seq.truth.scene}:r2`);
  const ph = tissues.map((t) => hand(t.sense)), Rr = rng(seq.truth.scene.length * 7919 + 1), keys = Object.keys(ORGANS);
  const pr = tissues.map(() => keys[Rr.next() % keys.length]);
  const texts = { jev_r1: mosaic(R, tissues, p1), jev_r2: mosaic(R, tissues, p2), hand: mosaic(R, tissues, ph), random: mosaic(R, tissues, pr) };
  for (const k of keys) texts[k] = R[k].map((r) => r.join('')).join('\n');
  for (const [k, pick] of [['jev_r1', p1], ['jev_r2', p2], ['hand', ph]]) for (const c of pick) picks[k][c] = (picks[k][c] || 0) + 1;
  const scored = await Promise.all(conds.map((c) => score('vlm', { seq, projection: { text_projection: texts[c], projector: `mosaic:${c}` }, ctx })));
  conds.forEach((c, i) => res[c].push({ feed: seq.truth.scene, vs_vlm: scored[i].fidelity, vs_truth: scored[i].detail.vs_truth.fidelity,
    motion: scored[i].detail.vs_vlm.motion_recall, chars: countChars(texts[c]) }));
  console.log(`${seq.truth.scene.padEnd(10)} ${conds.map((c, i) => `${c} ${scored[i].fidelity.toFixed(2)}`).join('  ')}`);
  if (seq.truth.scene === 'street') fs.writeFileSync(path.join(HERE, '..', 'logs', 'holarchy-e3-street.txt'), `jev_r2 picks:\n${[0, 1, 2, 3].map((ty) => p2.slice(ty * TW, ty * TW + TW).map((p) => p[0]).join(' ')).join('\n')}\n\n${texts.jev_r2}\n`);
}
console.log('\n=== E3 guided growth (10 feeds; 3-VLM ensemble) ===');
for (const c of conds) {
  const r = res[c], mr = r.filter((x) => x.motion !== null).map((x) => x.motion);
  console.log(`  ${c.padEnd(8)} vs VLM-ref ${mean(r.map((x) => x.vs_vlm)).toFixed(3)}  vs truth ${mean(r.map((x) => x.vs_truth)).toFixed(3)}  motion ${mean(mr).toFixed(2)}`);
}
console.log('  choices:', JSON.stringify(picks));
fs.writeFileSync(path.join(HERE, '..', 'logs', 'holarchy-e3.json'), JSON.stringify({ res, picks }, null, 1));
console.log(`api: ${stats.calls} calls, ${stats.cacheHits} cache hits ${JSON.stringify(stats.byProvider)}`);
const { closeRenderer } = await import('../render.mjs'); await closeRenderer();
