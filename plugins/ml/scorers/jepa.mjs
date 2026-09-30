// =============================================================================
// jepa — a JEPA-flavoured, self-supervised proxy: how much does the text tell
// you about the FUTURE of the feed?
//
// For a given projector config, a linear (ridge) predictor is trained to map
// features of the projection of frames 0..T-1 to a target computed from frame T,
// which the projector never saw. No labels: the feed supervises itself. Held-out
// R^2 is the score.
//
//   features  the text read back as ink, pooled to 16x8; plus four 8x4 channels
//             counting each arrow direction, one for '~' trails, and (for
//             multi-frame projections) one of |ink change| between the oldest
//             and newest block, so stacking frames gets credit too
//   target    'energy' (default): |next-frame luma - current luma| at 16x8 —
//             WHERE the next change will happen. Predicting it needs to know
//             where things are and which way they move, which is what
//             "understanding over time" should mean. Sign-free on purpose: a
//             dark car on grass and a bright ball on a floor move the same way
//             with opposite-signed deltas, which a linear probe cannot untangle.
//             'delta': the signed change (measured: a linear probe gets R^2 <= 0.02)
//             'next': the next frame's luma itself (mostly static; R^2 ~0.98 for all)
//
// Honest scope: this is a linear probe on a 16x8 pixel target, not a learned
// joint embedding. The real JEPA (predict a frozen image encoder's embedding of
// frame T, e.g. CLIP via DeepInfra) is the proposed next step; the harness is
// the same with a different target function.
// =============================================================================
import { lumaGrid } from '../core.mjs';
import { registerScorer, project } from '../registry.mjs';
import { renderSequence, randomSpec } from '../scenes.mjs';
import { textGrid } from './inverse.mjs';

const TW = 16, TH = 8, AW = 8, AH = 4;
const ARROW = { '>': 0, '→': 0, '<': 1, '←': 1, '^': 2, '↑': 2, 'v': 3, '↓': 3, '~': 4 };

export function features(text) {
  const blocks = text.split('\n\n'), lines = blocks[blocks.length - 1].split('\n').filter((l) => !l.startsWith('legend:'));
  const t = textGrid(text), f = new Float64Array(TW * TH + 6 * AW * AH + 1), cnt = new Float64Array(TW * TH);
  // multi-frame projections: |ink(newest) - ink(oldest block)| pooled to 8x4
  if (blocks.length > 1) {
    const o = textGrid(blocks[0]);
    for (let y = 0; y < Math.min(t.rows, o.rows); y++) for (let x = 0; x < Math.min(t.cols, o.cols); x++) {
      const ax = Math.min(AW - 1, Math.floor(x * AW / t.cols)), ay = Math.min(AH - 1, Math.floor(y * AH / t.rows));
      f[TW * TH + 5 * AW * AH + ay * AW + ax] += Math.abs(t.grid[y * t.cols + x] - o.grid[y * o.cols + x]);
    }
  }
  for (let y = 0; y < t.rows; y++) for (let x = 0; x < t.cols; x++) {
    const X = Math.min(TW - 1, Math.floor(x * TW / t.cols)), Y = Math.min(TH - 1, Math.floor(y * TH / t.rows));
    f[Y * TW + X] += t.grid[y * t.cols + x]; cnt[Y * TW + X]++;
    const ch = [...(lines[y] || '')][x], a = ARROW[ch];
    if (a !== undefined) {
      const ax = Math.min(AW - 1, Math.floor(x * AW / t.cols)), ay = Math.min(AH - 1, Math.floor(y * AH / t.rows));
      f[TW * TH + a * AW * AH + ay * AW + ax] += 1;
    }
  }
  for (let i = 0; i < TW * TH; i++) f[i] = cnt[i] ? f[i] / cnt[i] : 0;
  f[f.length - 1] = 1;
  return f;
}

export function target(seq, kind = 'delta') {
  const n = seq.frames.length, next = lumaGrid(seq.frames[n - 1], TW, TH);
  if (kind === 'next') return Float64Array.from(next, (v) => v / 255);
  const cur = lumaGrid(seq.frames[n - 2], TW, TH);
  if (kind === 'energy') return Float64Array.from(next, (v, i) => Math.abs(v - cur[i]) / 255);
  return Float64Array.from(next, (v, i) => (v - cur[i]) / 255);
}

// Solve (X^T X + lam I) W = X^T Y by Cholesky. X: n x d, Y: n x k.
export function ridge(X, Y, lam = 1e-1) {
  const n = X.length, d = X[0].length, k = Y[0].length;
  const A = Array.from({ length: d }, () => new Float64Array(d)), B = Array.from({ length: d }, () => new Float64Array(k));
  for (let r = 0; r < n; r++) {
    const x = X[r], y = Y[r];
    for (let i = 0; i < d; i++) { if (!x[i]) continue; const xi = x[i];
      for (let j = i; j < d; j++) A[i][j] += xi * x[j];
      for (let j = 0; j < k; j++) B[i][j] += xi * y[j]; }
  }
  for (let i = 0; i < d; i++) { for (let j = 0; j < i; j++) A[i][j] = A[j][i]; A[i][i] += lam; }
  const L = Array.from({ length: d }, () => new Float64Array(d));
  for (let i = 0; i < d; i++) for (let j = 0; j <= i; j++) {
    let s = A[i][j]; for (let q = 0; q < j; q++) s -= L[i][q] * L[j][q];
    L[i][j] = i === j ? Math.sqrt(Math.max(s, 1e-12)) : s / L[j][j];
  }
  const W = Array.from({ length: d }, () => new Float64Array(k));
  for (let c = 0; c < k; c++) {
    const z = new Float64Array(d);
    for (let i = 0; i < d; i++) { let s = B[i][c]; for (let q = 0; q < i; q++) s -= L[i][q] * z[q]; z[i] = s / L[i][i]; }
    for (let i = d - 1; i >= 0; i--) { let s = z[i]; for (let q = i + 1; q < d; q++) s -= L[q][i] * W[q][c]; W[i][c] = s / L[i][i]; }
  }
  return W;
}

export function predict(W, x) {
  const k = W[0].length, out = new Float64Array(k);
  for (let i = 0; i < x.length; i++) if (x[i]) for (let c = 0; c < k; c++) out[c] += x[i] * W[i][c];
  return out;
}

export function r2(P, Y) {
  const k = Y[0].length, mean = new Float64Array(k);
  for (const y of Y) for (let c = 0; c < k; c++) mean[c] += y[c] / Y.length;
  let sse = 0, sst = 0;
  for (let r = 0; r < Y.length; r++) for (let c = 0; c < k; c++) { sse += (P[r][c] - Y[r][c]) ** 2; sst += (Y[r][c] - mean[c]) ** 2; }
  return sst ? 1 - sse / sst : 0;
}

// Train + evaluate the probe for one projector config. Deterministic (seeded feeds).
const memo = new Map();
export function probe(projector, params, { train = 600, test = 150, kind = 'energy', frames = 12, lam = 10 } = {}) {
  const key = JSON.stringify([projector, params, train, test, kind, frames, lam]);
  if (memo.has(key)) return memo.get(key);
  const sample = (seed) => {
    const seq = renderSequence(randomSpec(seed), frames + 1);
    const past = { frames: seq.frames.slice(0, frames), truth: seq.truth };
    return { x: features(project(projector, past, params).text_projection), y: target(seq, kind) };
  };
  const tr = Array.from({ length: train }, (_, i) => sample(1000 + i));
  const te = Array.from({ length: test }, (_, i) => sample(900000 + i));
  const W = ridge(tr.map((s) => s.x), tr.map((s) => s.y), lam);
  const res = { r2_test: r2(te.map((s) => predict(W, s.x)), te.map((s) => s.y)),
                r2_train: r2(tr.map((s) => predict(W, s.x)), tr.map((s) => s.y)), train, test, kind };
  memo.set(key, res);
  return res;
}

registerScorer({
  name: 'jepa',
  cost: 'cheap',
  about: 'self-supervised: held-out R^2 of a ridge probe predicting the next frame\'s change from the text',
  async score({ projection, ctx = {} }) {
    const r = probe(projection.projector, projection.params, ctx.jepa || {});
    return { fidelity: Math.max(0, Math.min(1, r.r2_test)), detail: r };
  },
});
