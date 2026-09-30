// =============================================================================
// compare.mjs — the discriminator's arithmetic. Given a REFERENCE scene
// description (from a vision model looking at the real frames, or the generator's
// ground truth) and a RECONSTRUCTION (from a vision model looking only at the
// text projection), return how much of the scene survived the projection.
//
// A scene description is
//   { setting: 'outdoor-day'|'outdoor-night'|'indoor'|'unknown',
//     objects: [{ label, category, region, box?: [x0,y0,x1,y1] in 0..1,
//                 moving: 'left'|'right'|'up'|'down'|'none' }] }
//
// Objects are paired greedily by a pair score
//   0.4 * what (same category, or labels share a word/synonym)
// + 0.3 * where (box centre distance if both have boxes, else 3x3-region distance)
// + 0.3 * motion (same direction; 'none' == 'none' counts)
// and only pairs that agree on WHAT or sit close (where >= 0.6) may pair at all.
// fidelity = 0.85 * sum(pair scores) / max(|ref|, |rec|) + 0.15 * (setting match)
// Dividing by the larger count charges both misses and hallucinations, so a
// critic cannot score by listing everything it can think of.
// Pure and deterministic: no network, testable offline.
// =============================================================================
import { REGIONS } from './scenes.mjs';

const SYN = [
  ['car', 'vehicle', 'automobile', 'truck', 'van', 'bus', 'taxi'],
  ['person', 'human', 'man', 'woman', 'figure', 'pedestrian', 'stick', 'people', 'child', 'walker'],
  ['house', 'home', 'building', 'cottage', 'hut', 'barn', 'shed'],
  ['tower', 'skyscraper', 'building', 'high-rise', 'highrise', 'apartment', 'office', 'block'],
  ['tree', 'bush', 'plant', 'shrub'],
  ['sun', 'star', 'light', 'orb'],
  ['moon', 'crescent'],
  ['cloud', 'clouds'],
  ['ball', 'sphere', 'circle', 'orb', 'dot'],
  ['table', 'desk', 'bench', 'counter', 'furniture'],
  ['window', 'frame', 'pane', 'painting', 'picture'],
];
const words = (s) => String(s || '').toLowerCase().split(/[^a-z-]+/).filter(Boolean);
export function sameWhat(a, b) {
  if (a.category && b.category && a.category === b.category) return true;
  const wa = words(a.label), wb = words(b.label);
  if (wa.some((w) => wb.includes(w))) return true;
  return SYN.some((g) => wa.some((w) => g.includes(w)) && wb.some((w) => g.includes(w)));
}

// Boxes arrive as fractions (0..1) or, from Qwen-VL, on its native 0..1000 grid.
export function normBox(b) {
  if (!Array.isArray(b) || b.length !== 4 || !b.every(Number.isFinite)) return null;
  return Math.max(...b) > 1.5 ? b.map((v) => v / 1000) : b;
}
const centre = (o) => {
  const b = normBox(o.box);
  if (b) return [(b[0] + b[2]) / 2, (b[1] + b[3]) / 2];
  const i = REGIONS.indexOf(o.region); if (i < 0) return null;
  return [(i % 3) / 3 + 1 / 6, ((i / 3) | 0) / 3 + 1 / 6];
};
export function whereScore(a, b) {
  const ca = centre(a), cb = centre(b); if (!ca || !cb) return 0;
  return Math.max(0, 1 - Math.hypot(ca[0] - cb[0], ca[1] - cb[1]) / 0.5);
}
const norm = (m) => (['left', 'right', 'up', 'down'].includes(m) ? m : 'none');

export function pairScore(a, b) {
  const what = sameWhat(a, b) ? 1 : 0, where = whereScore(a, b), motion = norm(a.moving) === norm(b.moving) ? 1 : 0;
  return { s: 0.4 * what + 0.3 * where + 0.3 * motion, what, where, motion, ok: what === 1 || where >= 0.6 };
}

export function compareScenes(ref, rec) {
  const R = ref?.objects || [], C = Array.isArray(rec?.objects) ? rec.objects : [];
  const cand = [];
  R.forEach((a, i) => C.forEach((b, j) => { const p = pairScore(a, b); if (p.ok) cand.push({ i, j, ...p }); }));
  cand.sort((x, y) => y.s - x.s);
  const usedR = new Set(), usedC = new Set(), pairs = [];
  for (const p of cand) if (!usedR.has(p.i) && !usedC.has(p.j)) { usedR.add(p.i); usedC.add(p.j); pairs.push(p); }
  const denom = Math.max(R.length, C.length, 1);
  const objects = pairs.reduce((s, p) => s + p.s, 0) / denom;
  const setting = ref?.setting && rec?.setting === ref.setting ? 1 : 0;
  const movingRef = R.map((a, i) => ({ a, i })).filter(({ a }) => norm(a.moving) !== 'none');
  const motionHits = movingRef.filter(({ a, i }) => { const p = pairs.find((q) => q.i === i); return p && norm(C[p.j].moving) === norm(a.moving); }).length;
  return {
    fidelity: 0.85 * objects + 0.15 * setting,
    objects: +objects.toFixed(4), setting,
    recall: +(pairs.filter((p) => p.what).length / Math.max(R.length, 1)).toFixed(3),
    precision: +(pairs.filter((p) => p.what).length / Math.max(C.length, 1)).toFixed(3),
    motion_recall: movingRef.length ? +(motionHits / movingRef.length).toFixed(3) : null,
    pairs: pairs.map((p) => ({ ref: R[p.i].label, rec: C[p.j].label, s: +p.s.toFixed(3), what: p.what, where: +p.where.toFixed(2), motion: p.motion })),
    unmatched_ref: R.filter((_, i) => !usedR.has(i)).map((o) => o.label),
    hallucinated: C.filter((_, j) => !usedC.has(j)).map((o) => o.label),
  };
}
