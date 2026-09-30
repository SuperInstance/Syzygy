// =============================================================================
// reader.mjs — a HOLARCHIC reader: reconstruct a scene from a text projection
// with no vision model and no central interpreter, only many first-person typed
// judgments (TypeSafe Jev) organised in levels, each level made of the one below.
//
//   cell      deterministic RECEPTORS: each character becomes numbers (ink, edge
//             orientation, arrow, trail). No judgment happens here.
//   tissue    the frame is tiled 6 x 3. Each tissue is a first-person agent:
//             "I am the top-left tissue; this is what my cells report." It
//             answers typed questions: what occupies me (choice), which way is
//             it moving (choice). In round 2 it also hears its four neighbours'
//             round-1 claims and may change its mind (local negotiation, no
//             centre). All tissues of one frame share a single Jev request.
//   organ     adjacent tissues that claim the same thing fuse into one object
//             (a local union rule): category, box = union of tissue boxes,
//             motion = majority of the tissues' motion claims.
//   organism  one typed question on scene-level receptors: indoor / outdoor day /
//             outdoor night.
// The output uses the same scene schema as the VLM critic, so compare.mjs scores
// both against ground truth on equal terms.
//
// sense = 'receptors' (numbers) or 'raw' (the tissue's own text patch).
// =============================================================================
import { systemOne } from '../apis.mjs';
import { ink } from '../scorers/inverse.mjs';
import { regionOf } from '../scenes.mjs';

export const TW = 6, TH = 3;
export const WHAT = {
  background: 'only background: sky, ground, road, wall or floor; no distinct object',
  building: 'a building, house, tower or window',
  vehicle: 'a car or other vehicle',
  person: 'a person or figure',
  plant: 'a tree or plant',
  celestial: 'the sun or the moon',
  weather: 'a cloud',
  furniture: 'a table or other furniture',
  shape: 'a ball or other small round object',
};
const MOTION = { none: 'nothing here is moving', left: 'something here moves left', right: 'something here moves right',
                 up: 'something here moves up', down: 'something here moves down' };
const ARROW = { '>': 'right', '→': 'right', '<': 'left', '←': 'left', '^': 'up', '↑': 'up', 'v': 'down', '↓': 'down' };
const COLS = ['far-left', 'left', 'centre-left', 'centre-right', 'right', 'far-right'], ROWS = ['top', 'middle', 'bottom'];

export function newestBlock(text) {
  const blocks = text.split('\n\n');
  return blocks[blocks.length - 1].split('\n').filter((l) => !l.startsWith('legend:')).map((l) => [...l]);
}

// cell receptors for one tissue
export function receptors(G, tx, ty, sceneInk) {
  const R = G.length, C = G[0].length;
  const y0 = Math.floor(ty * R / TH), y1 = Math.floor((ty + 1) * R / TH), x0 = Math.floor(tx * C / TW), x1 = Math.floor((tx + 1) * C / TW);
  const cells = []; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) cells.push({ x, y, ch: G[y][x] ?? ' ' });
  const inkOf = (c) => ink(c.ch);
  const mean = cells.reduce((s, c) => s + inkOf(c), 0) / cells.length;
  // a 3x4 ink map, digits 0-9
  const map = [];
  for (let my = 0; my < 3; my++) {
    let row = '';
    for (let mx = 0; mx < 4; mx++) {
      const sub = cells.filter((c) => Math.floor((c.y - y0) * 3 / (y1 - y0)) === my && Math.floor((c.x - x0) * 4 / (x1 - x0)) === mx);
      row += Math.min(9, Math.round(9 * sub.reduce((s, c) => s + inkOf(c), 0) / Math.max(1, sub.length)));
    }
    map.push(row);
  }
  const count = (set) => cells.filter((c) => set.includes(c.ch)).length;
  const arrows = {}; for (const c of cells) if (ARROW[c.ch]) arrows[ARROW[c.ch]] = (arrows[ARROW[c.ch]] || 0) + 1;
  const vals = cells.map(inkOf), sd = Math.sqrt(vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length);
  return {
    where: `${ROWS[ty]} row, ${COLS[tx]} column`,
    ink_map_0to9: map, mean_ink: +(9 * mean).toFixed(1), contrast_vs_scene: +(9 * (mean - sceneInk)).toFixed(1), texture_sd: +(9 * sd).toFixed(1),
    edge_glyphs: { horizontal: count(['─']), vertical: count(['│']), rising: count(['╱']), falling: count(['╲']) },
    motion_arrows: arrows, trail_marks: count(['~']),
    box: [x0 / C, y0 / R, x1 / C, y1 / R],
  };
}

export function rawPatch(G, tx, ty) {
  const R = G.length, C = G[0].length;
  return G.slice(Math.floor(ty * R / TH), Math.floor((ty + 1) * R / TH)).map((l) => l.slice(Math.floor(tx * C / TW), Math.floor((tx + 1) * C / TW)).join('')).join('\n');
}

const nbrs = (tx, ty) => [['north', tx, ty - 1], ['south', tx, ty + 1], ['west', tx - 1, ty], ['east', tx + 1, ty]]
  .filter(([, x, y]) => x >= 0 && y >= 0 && x < TW && y < TH);

export async function readScene(text, { sense = 'receptors', rounds = 2, tag = '' } = {}) {
  const G = newestBlock(text);
  const sceneInk = G.flat().reduce((s, c) => s + ink(c), 0) / G.flat().length;
  const tissues = [];
  for (let ty = 0; ty < TH; ty++) for (let tx = 0; tx < TW; tx++) {
    const rc = receptors(G, tx, ty, sceneInk);
    const { box, ...state } = rc;
    tissues.push({ tx, ty, box, state, raw: rawPatch(G, tx, ty) });
  }
  const perRound = [];
  let claims = null, setting = 'unknown';
  for (let round = 1; round <= rounds; round++) {
    const qs = {};
    for (const t of tissues) {
      const me = sense === 'raw' ? `my own patch of the character art:\n${t.raw}` : `what my cells report: ${JSON.stringify(t.state)}`;
      let heard = '';
      if (claims) heard = ` My neighbours said in the last round: ${nbrs(t.tx, t.ty).map(([d, x, y]) => {
        const c = claims[`${x}_${y}`]; return `${d}: ${c.what} (${c.conf.toFixed(2)}), motion ${c.motion}`; }).join('; ')}. Objects usually span several neighbouring tissues; weigh their view against yours.`;
      const intro = `I am one tissue (the ${ROWS[t.ty]} row, ${COLS[t.tx]} column) of a camera frame that has been rendered as character art and tiled into 6 columns x 3 rows. Denser characters mean brighter patches; line glyphs mark edges; arrows (> < ^ v) mark motion and ~ marks where something just was.`;
      qs[`w_${t.tx}_${t.ty}`] = { type: 'choice', instructions: `${intro} Here is ${me}.${heard} What occupies most of me?`, criteria: WHAT };
      qs[`m_${t.tx}_${t.ty}`] = { type: 'choice', instructions: `${intro} Here is ${me}.${heard} Is anything in me moving, and which way?`, criteria: MOTION };
    }
    if (round === 1) {
      const rowInk = [0, 1, 2].map((ty) => +(9 * tissues.filter((t) => t.ty === ty).reduce((s, t) => s + t.state.mean_ink / 9, 0) / TW).toFixed(1));
      qs.setting = { type: 'choice', instructions: `A camera frame rendered as character art (denser = brighter). Mean brightness 0-9 by row, top to bottom: ${rowInk.join(', ')}. Overall ${(9 * sceneInk).toFixed(1)}. Where was this taken?`,
                     criteria: { 'outdoor-day': 'outdoors in daylight: bright sky above', 'outdoor-night': 'outdoors at night: dark sky', indoor: 'indoors: a wall and a floor, no sky' } };
    }
    const r = await systemOne({ task: 'first-person tissues of a character-art camera frame' }, qs, { tag: `holarchy:${tag}:${sense}:r${round}` });
    const next = {};
    for (const t of tissues) {
      const w = r.answers[`w_${t.tx}_${t.ty}`], m = r.answers[`m_${t.tx}_${t.ty}`];
      next[`${t.tx}_${t.ty}`] = { what: w?.choice ?? 'background', conf: w?.confidence ?? 0, motion: m?.choice ?? 'none', mconf: m?.confidence ?? 0 };
    }
    if (round === 1) setting = r.answers.setting?.choice ?? 'unknown';
    claims = next;
    perRound.push({ round, claims: next, scene: { ...organs(tissues, next), setting }, usage: r.usage, cached: r.cached });
  }
  return { ...organs(tissues, claims), setting, tissues: tissues.map((t) => ({ tx: t.tx, ty: t.ty, box: t.box })), rounds: perRound };
}

// organ level: fuse adjacent tissues that claim the same non-background thing
export function organs(tissues, claims) {
  const key = (t) => `${t.tx}_${t.ty}`, seen = new Set(), objects = [];
  for (const t of tissues) {
    const c = claims[key(t)];
    if (c.what === 'background' || seen.has(key(t))) continue;
    const comp = [], stack = [t]; seen.add(key(t));
    while (stack.length) {
      const u = stack.pop(); comp.push(u);
      for (const [, x, y] of nbrs(u.tx, u.ty)) {
        const v = tissues.find((q) => q.tx === x && q.ty === y);
        if (v && !seen.has(key(v)) && claims[key(v)].what === c.what) { seen.add(key(v)); stack.push(v); }
      }
    }
    const box = [Math.min(...comp.map((u) => u.box[0])), Math.min(...comp.map((u) => u.box[1])), Math.max(...comp.map((u) => u.box[2])), Math.max(...comp.map((u) => u.box[3]))];
    const votes = {}; for (const u of comp) { const m = claims[key(u)].motion; if (m !== 'none') votes[m] = (votes[m] || 0) + 1; }
    const moving = Object.entries(votes).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'none';
    objects.push({ label: c.what, category: c.what, box, region: regionOf((box[0] + box[2]) / 2, (box[1] + box[3]) / 2), moving, tissues: comp.length });
  }
  return { objects };
}

// tissue-level truth: which truth object covers most of each tissue (>= 15 %), else background
export function tissueTruth(truth, tissues) {
  const out = {};
  for (const t of tissues) {
    const [a0, b0, a1, b1] = t.box, area = (a1 - a0) * (b1 - b0);
    let best = 'background', bestF = 0.15;
    for (const o of truth.objects) {
      const [c0, d0, c1, d1] = o.box, ov = Math.max(0, Math.min(a1, c1) - Math.max(a0, c0)) * Math.max(0, Math.min(b1, d1) - Math.max(b0, d0));
      if (ov / area > bestF) { bestF = ov / area; best = o.category; }
    }
    out[`${t.tx}_${t.ty}`] = best;
  }
  return out;
}
