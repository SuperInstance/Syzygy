// =============================================================================
// scenes.mjs — synthetic "camera feeds" with GROUND TRUTH. There is no camera in
// a headless container, so every feed here is drawn: a background plus a few
// objects (house, tree, car, person, sun, ...), some of them moving at a known
// velocity. Because we drew them, we know exactly what is where and which way it
// moves — which lets us audit the vision-model critic, not just trust it.
//
//   renderSequence(spec, n) -> { frames: [RGB frame x n], truth }
//   SCENES                  -> four hand-authored feeds used by the playtest
//   randomSpec(seed)        -> a random feed (for training the JEPA-lite probe)
// =============================================================================
import { makeFrame, rng } from './core.mjs';

export const W = 320, H = 192;

// ---- raster primitives -------------------------------------------------------
function put(f, x, y, c) {
  x |= 0; y |= 0; if (x < 0 || y < 0 || x >= f.w || y >= f.h) return;
  const o = 3 * (y * f.w + x); f.data[o] = c[0]; f.data[o+1] = c[1]; f.data[o+2] = c[2];
}
function rect(f, x0, y0, x1, y1, c) { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) put(f, x, y, c); }
function disc(f, cx, cy, r, c) {
  for (let y = Math.floor(cy - r); y <= cy + r; y++)
    for (let x = Math.floor(cx - r); x <= cx + r; x++) if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) put(f, x, y, c);
}
function tri(f, ax, ay, bx, by, cx, cy, c) {
  const minx = Math.min(ax, bx, cx), maxx = Math.max(ax, bx, cx), miny = Math.min(ay, by, cy), maxy = Math.max(ay, by, cy);
  const e = (px, py, qx, qy, x, y) => (qx - px) * (y - py) - (qy - py) * (x - px);
  for (let y = Math.floor(miny); y <= maxy; y++)
    for (let x = Math.floor(minx); x <= maxx; x++) {
      const a = e(ax, ay, bx, by, x, y), b = e(bx, by, cx, cy, x, y), d = e(cx, cy, ax, ay, x, y);
      if ((a >= 0 && b >= 0 && d >= 0) || (a <= 0 && b <= 0 && d <= 0)) put(f, x, y, c);
    }
}
function line(f, x0, y0, x1, y1, t, c) {
  const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0)) + 1;
  for (let i = 0; i <= n; i++) disc(f, x0 + (x1 - x0) * i / n, y0 + (y1 - y0) * i / n, t / 2, c);
}

// ---- backgrounds ---------------------------------------------------------------
const BG = {
  day(f) {
    for (let y = 0; y < f.h; y++) {
      const k = y / f.h;
      const c = y < 0.66 * f.h ? [110 + 80 * k, 160 + 60 * k, 235] : [70, 150, 60];
      rect(f, 0, y, f.w, y + 1, c.map(Math.round));
    }
  },
  night(f) {
    for (let y = 0; y < f.h; y++) rect(f, 0, y, f.w, y + 1, y < 0.75 * f.h ? [12, 14, 40 + (y >> 3)] : [40, 40, 45]);
  },
  room(f) { rect(f, 0, 0, f.w, f.h, [200, 190, 170]); rect(f, 0, Math.round(0.72 * f.h), f.w, f.h, [120, 80, 50]); },
};

// ---- objects: draw(f, x, y, s, t, o) with (x,y) the object's centre ------------
const KIND = {
  house:   { category: 'building', draw(f, x, y, s) {
    rect(f, x - s, y - 0.4 * s, x + s, y + 0.8 * s, [205, 120, 80]);
    tri(f, x - 1.2 * s, y - 0.4 * s, x + 1.2 * s, y - 0.4 * s, x, y - 1.3 * s, [120, 40, 40]);
    rect(f, x - 0.2 * s, y + 0.2 * s, x + 0.2 * s, y + 0.8 * s, [70, 45, 30]);
    rect(f, x + 0.45 * s, y - 0.1 * s, x + 0.8 * s, y + 0.25 * s, [240, 240, 180]); } },
  tree:    { category: 'plant', draw(f, x, y, s) {
    rect(f, x - 0.15 * s, y, x + 0.15 * s, y + 1.1 * s, [100, 65, 30]); disc(f, x, y - 0.3 * s, 0.75 * s, [30, 110, 40]); } },
  car:     { category: 'vehicle', draw(f, x, y, s, t, o) {
    const d = Math.sign(o.vx || 1);
    rect(f, x - s, y - 0.25 * s, x + s, y + 0.3 * s, [200, 30, 30]);
    rect(f, x - 0.5 * s - 0.2 * d * s, y - 0.65 * s, x + 0.5 * s - 0.2 * d * s, y - 0.25 * s, [170, 25, 25]);
    rect(f, x - 0.35 * s - 0.2 * d * s, y - 0.58 * s, x + 0.35 * s - 0.2 * d * s, y - 0.3 * s, [170, 210, 240]);
    disc(f, x - 0.6 * s, y + 0.35 * s, 0.25 * s, [20, 20, 20]); disc(f, x + 0.6 * s, y + 0.35 * s, 0.25 * s, [20, 20, 20]); } },
  person:  { category: 'person', draw(f, x, y, s, t) {
    const c = [30, 30, 90], sw = (t % 2 ? 1 : -1) * 0.35 * s;
    disc(f, x, y - 0.95 * s, 0.22 * s, [230, 190, 160]);
    line(f, x, y - 0.7 * s, x, y + 0.2 * s, 0.14 * s, c);
    line(f, x, y + 0.2 * s, x - sw, y + 1.0 * s, 0.12 * s, c); line(f, x, y + 0.2 * s, x + sw, y + 1.0 * s, 0.12 * s, c);
    line(f, x, y - 0.5 * s, x + sw, y, 0.1 * s, c); line(f, x, y - 0.5 * s, x - sw, y, 0.1 * s, c); } },
  sun:     { category: 'celestial', draw(f, x, y, s) { disc(f, x, y, 0.6 * s, [255, 220, 60]); } },
  moon:    { category: 'celestial', draw(f, x, y, s) { disc(f, x, y, 0.5 * s, [235, 235, 210]); disc(f, x + 0.25 * s, y - 0.1 * s, 0.42 * s, [12, 14, 44]); } },
  tower:   { category: 'building', draw(f, x, y, s) {
    rect(f, x - 0.4 * s, y - 1.6 * s, x + 0.4 * s, y + 1.6 * s, [70, 70, 80]);
    for (let wy = y - 1.4 * s; wy < y + 1.4 * s; wy += 0.35 * s)
      for (const wx of [x - 0.25 * s, x + 0.08 * s]) if (((wx + wy) | 0) % 3) rect(f, wx, wy, wx + 0.16 * s, wy + 0.18 * s, [250, 220, 120]); } },
  ball:    { category: 'shape', draw(f, x, y, s) { disc(f, x, y, 0.35 * s, [240, 120, 20]); } },
  table:   { category: 'furniture', draw(f, x, y, s) {
    rect(f, x - s, y - 0.1 * s, x + s, y + 0.05 * s, [90, 55, 30]);
    rect(f, x - 0.9 * s, y, x - 0.75 * s, y + 0.8 * s, [90, 55, 30]); rect(f, x + 0.75 * s, y, x + 0.9 * s, y + 0.8 * s, [90, 55, 30]); } },
  window:  { category: 'building', draw(f, x, y, s) {
    rect(f, x - 0.6 * s, y - 0.5 * s, x + 0.6 * s, y + 0.5 * s, [60, 60, 60]);
    rect(f, x - 0.5 * s, y - 0.4 * s, x + 0.5 * s, y + 0.4 * s, [150, 200, 250]);
    rect(f, x - 0.03 * s, y - 0.4 * s, x + 0.03 * s, y + 0.4 * s, [60, 60, 60]); rect(f, x - 0.5 * s, y - 0.03 * s, x + 0.5 * s, y + 0.03 * s, [60, 60, 60]); } },
  cloud:   { category: 'weather', draw(f, x, y, s) {
    disc(f, x - 0.4 * s, y, 0.35 * s, [245, 245, 250]); disc(f, x, y - 0.15 * s, 0.45 * s, [245, 245, 250]); disc(f, x + 0.45 * s, y, 0.33 * s, [245, 245, 250]); } },
};
export const KINDS = Object.keys(KIND);
export const CATEGORIES = ['person', 'animal', 'vehicle', 'building', 'plant', 'celestial', 'furniture', 'shape', 'weather', 'other'];

// 3x3 region names shared by truth, reference and reconstruction.
export const REGIONS = ['top-left', 'top', 'top-right', 'left', 'center', 'right', 'bottom-left', 'bottom', 'bottom-right'];
export function regionOf(nx, ny) {
  const c = nx < 1 / 3 ? 0 : nx < 2 / 3 ? 1 : 2, r = ny < 1 / 3 ? 0 : ny < 2 / 3 ? 1 : 2;
  return REGIONS[3 * r + c];
}
export function directionOf(vx, vy, eps = 0.25) {
  const ax = Math.abs(vx), ay = Math.abs(vy);
  if (ax < eps && ay < eps) return 'none';
  if (ax >= ay) return vx > 0 ? 'right' : 'left';
  return vy > 0 ? 'down' : 'up';
}

export function renderFrame(spec, t) {
  const f = makeFrame(W, H); BG[spec.bg](f);
  for (const o of spec.objects) KIND[o.kind].draw(f, o.x + o.vx * t, o.y + o.vy * t, o.s, t, o);
  return f;
}

// Exact normalized bounding box of one object at time t: draw it alone on a
// sentinel frame and take the extent of the pixels it touched.
export function objectBox(o, t) {
  const f = makeFrame(W, H, [1, 2, 3]);
  KIND[o.kind].draw(f, o.x + o.vx * t, o.y + o.vy * t, o.s, t, o);
  let x0 = W, y0 = H, x1 = -1, y1 = -1;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = 3 * (y * W + x);
    if (f.data[i] !== 1 || f.data[i + 1] !== 2 || f.data[i + 2] !== 3) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
  }
  return [x0 / W, y0 / H, (x1 + 1) / W, (y1 + 1) / H].map((v) => +v.toFixed(3));
}

export const SETTING = { day: 'outdoor-day', night: 'outdoor-night', room: 'indoor' };

// Truth is stated for the NEWEST frame (the one a projection depicts).
export function truthOf(spec, n) {
  const t = n - 1;
  return {
    scene: spec.name, setting: SETTING[spec.bg],
    objects: spec.objects.map((o) => {
      const box = objectBox(o, t);
      return { label: o.kind, category: KIND[o.kind].category,
               region: regionOf((box[0] + box[2]) / 2, (box[1] + box[3]) / 2), box, moving: directionOf(o.vx, o.vy) };
    }),
  };
}

export function renderSequence(spec, n = 12) {
  const frames = []; for (let t = 0; t < n; t++) frames.push(renderFrame(spec, t));
  return { frames, truth: truthOf(spec, n), spec };
}

// ---- the four playtest feeds ----------------------------------------------------
export const SCENES = [
  { name: 'street', bg: 'day', objects: [
    { kind: 'sun', x: 275, y: 30, s: 34, vx: 0, vy: 0 },
    { kind: 'house', x: 75, y: 95, s: 42, vx: 0, vy: 0 },
    { kind: 'tree', x: 250, y: 100, s: 38, vx: 0, vy: 0 },
    { kind: 'car', x: 90, y: 160, s: 30, vx: 14, vy: 0 } ] },
  { name: 'park', bg: 'day', objects: [
    { kind: 'cloud', x: 70, y: 35, s: 40, vx: 0, vy: 0 },
    { kind: 'tree', x: 60, y: 100, s: 40, vx: 0, vy: 0 },
    { kind: 'person', x: 250, y: 125, s: 40, vx: -10, vy: 0 } ] },
  { name: 'night', bg: 'night', objects: [
    { kind: 'moon', x: 50, y: 35, s: 44, vx: 0, vy: 0 },
    { kind: 'tower', x: 170, y: 90, s: 32, vx: 0, vy: 0 },
    { kind: 'tower', x: 260, y: 95, s: 30, vx: 0, vy: 0 },
    { kind: 'car', x: 230, y: 165, s: 28, vx: -14, vy: 0 } ] },
  { name: 'room', bg: 'room', objects: [
    { kind: 'window', x: 240, y: 55, s: 50, vx: 0, vy: 0 },
    { kind: 'table', x: 90, y: 125, s: 45, vx: 0, vy: 0 },
    { kind: 'ball', x: 150, y: 170, s: 32, vx: 12, vy: 0 } ] },
];

// ---- random feeds (self-supervised training data; no labels are used) ----------
export function randomSpec(seed) {
  const R = rng(seed), bg = R.pick(['day', 'night', 'room']);
  const pool = { day: ['sun', 'house', 'tree', 'car', 'person', 'cloud', 'ball'],
                 night: ['moon', 'tower', 'car', 'person'], room: ['window', 'table', 'ball', 'person'] }[bg];
  const n = R.int(2, 4), objects = [];
  for (let i = 0; i < n; i++) {
    const kind = R.pick(pool), moves = ['car', 'person', 'ball'].includes(kind) && R.float() < 0.8;
    const sp = moves ? R.pick([-14, -10, -6, 6, 10, 14]) : 0, vert = kind === 'ball' && R.float() < 0.4;
    objects.push({ kind, x: R.int(40, W - 40), y: R.int(35, H - 35), s: R.int(24, 44),
                   vx: vert ? 0 : sp, vy: vert ? sp * 0.6 : 0 });
  }
  return { name: 'rand' + seed, bg, objects };
}
