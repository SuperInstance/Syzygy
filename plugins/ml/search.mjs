// =============================================================================
// search.mjs — a System-2 for projections: advisor cells propose projector
// configs, a typed gate rejects malformed ones before any money is spent, a
// cascade of scorers backtests the survivors (free -> cheap -> paid), and the
// winners on the iron triangle {fidelity up, characters down, compute down}
// are promoted to parents for the next generation.
//
// Advisor cells (each proposes `perCell` configs per generation):
//   llm:<provider>  an LLM (deepseek | kimi | zai) reads the schema and the
//                   scored history (numbers + what the critic missed or
//                   invented) and proposes configs with a one-line rationale
//   quantum         mutates a promoted parent with bytes from a quantum RNG
//                   (MothQuantum comet-qrng; emu mode unless told otherwise)
//   local           the same mutation with a seeded xorshift PRNG — the control
//                   arm the quantum cell must be compared against
//
// Gate (in order): registry.validateParams (authoritative, deterministic,
// free) -> TypeSafe Jev noul "coherent config?" (advisory, logged; can veto
// only if ctx.jevVeto). A rejected config is logged with its reasons and never
// scored.
//
// Utility used to rank parents (all terms measured, weights stated):
//   U = vlm + 0.25 * jepa - 0.05 * (chars / 1000) - 0.002 * ms
// The Pareto front over (vlm, chars, ms) is reported separately, so a reader
// can re-rank with their own weights.
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { project, score, getProjector, listProjectors, validateParams, defaults } from './registry.mjs';
import { llm, systemOne, quantumBytes, extractJSON, extractProposals } from './apis.mjs';
import { rng } from './core.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const utility = (r) => r.vlm + 0.25 * (r.jepa ?? 0) - 0.05 * (r.chars / 1000) - 0.002 * r.ms;

export function pareto(rows) {
  return rows.filter((a) => !rows.some((b) => b !== a && b.vlm >= a.vlm && b.chars <= a.chars && b.ms <= a.ms &&
    (b.vlm > a.vlm || b.chars < a.chars || b.ms < a.ms)));
}

// ---- mutation (shared by quantum + local cells; only the byte source differs) ---
export function mutate(name, params, bytes) {
  let k = 0; const next = () => bytes[k++ % bytes.length];
  const schema = getProjector(name).params, keys = Object.keys(schema), out = { ...params };
  const n = 1 + (next() % 3);
  for (let i = 0; i < n; i++) {
    const key = keys[next() % keys.length], s = schema[key], u = next() / 255;
    if (s.type === 'enum') out[key] = s.values[next() % s.values.length];
    else if (s.type === 'bool') out[key] = !out[key];
    else {
      const span = s.max - s.min, step = (u - 0.5) * span * 0.4;
      let v = Math.min(s.max, Math.max(s.min, out[key] + step));
      out[key] = s.type === 'int' ? Math.round(v) : +v.toFixed(3);
    }
  }
  return out;
}

function schemaText() {
  return listProjectors().map((p) => `${p.name}: ${p.about}\n` + Object.entries(p.params).map(([k, s]) =>
    `  ${k}: ${s.type}${s.values ? ' ' + s.values.join('|') : s.type === 'bool' ? '' : ` [${s.min}, ${s.max}]`} (default ${JSON.stringify(s.default)})`).join('\n')).join('\n\n');
}

function historyText(history, n = 14) {
  const rows = [...history].sort((a, b) => b.U - a.U).slice(0, n);
  return rows.map((r) => `U=${r.U.toFixed(3)} vlm=${r.vlm.toFixed(3)}${r.hold !== undefined ? ` hold=${r.hold.toFixed(3)}` : ''} jepa=${(r.jepa ?? 0).toFixed(3)} motion_recall=${r.motion_recall ?? 'n/a'} chars=${r.chars} ms=${r.ms.toFixed(1)} ` +
    `${r.projector} ${JSON.stringify(r.params)}${r.notes ? ' | critic: ' + r.notes : ''}`).join('\n');
}

// Advisors hosted on DeepInfra: cell 'llm:di:<alias>'. Same prompt, different minds.
// Kimi-K2.6 and MiniMax-M3 reason at length by default: Kimi hit 3 x 120 s
// timeouts on this prompt, MiniMax spent all 4000 tokens (172 s) reasoning and
// returned no content. reasoning_effort 'none' turns that off for both.
export const DI_ADVISORS = { kimi: 'moonshotai/Kimi-K2.6', qwen: 'Qwen/Qwen3-235B-A22B-Instruct-2507',
                             gptoss: 'openai/gpt-oss-120b', minimax: 'MiniMaxAI/MiniMax-M3' };
const DI_EXTRA = { kimi: { reasoning_effort: 'none' }, minimax: { reasoning_effort: 'none' } };

export async function llmAdvisor(spec, history, perCell, gen) {
  const [provider, model] = spec.startsWith('di:') ? ['deepinfra', DI_ADVISORS[spec.slice(3)]] : [spec, undefined];
  if (spec.startsWith('di:') && !model) throw new Error(`unknown DeepInfra advisor ${spec}`);
  const prompt = `You are tuning a "projector" that turns a short camera video into plain text (character art). A vision-language model then tries to reconstruct the scene (objects, positions, motion directions) from the text alone; its agreement with a reading of the real video is "vlm" fidelity (0..1). "jepa" (0..1) measures how well the text predicts where the next frame will change. Fewer characters and less compute (ms) are better. The utility is U = vlm + 0.25*jepa - 0.05*chars/1000 - 0.002*ms.

Available projectors and their typed parameters:
${schemaText()}

Scored so far (best first):
${historyText(history)}

${history.some((r) => r.hold !== undefined) ? 'IMPORTANT: "hold" is the same fidelity measured on feeds you never see, and it alone decides which configs are promoted; a high vlm with a much lower hold means overfitting.\n\n' : ''}Propose ${perCell} NEW configurations likely to raise U. Use only the parameter names and value ranges listed. Reply with JSON only:
{"proposals": [{"projector": "<name>", "params": {...every parameter...}, "why": "<one line>"}]}`;
  const r = await llm(provider, [{ role: 'user', content: prompt }], { model, max_tokens: model ? 4000 : 1500, temperature: 0.7,
    json: provider === 'deepseek', extra: DI_EXTRA[spec.slice(3)] || {}, timeoutMs: 300000, tag: `advisor:${spec}:g${gen}` });
  const proposals = extractJSON(r.text)?.proposals || extractProposals(r.text);
  if (!proposals.length) throw new Error(`no proposals parsed from ${spec}: ${String(r.text).slice(0, 120)}`);
  return proposals.slice(0, perCell).map((p) => ({ cell: `llm:${spec}`, projector: p.projector, params: p.params, why: p.why || '' }));
}

export async function mutationAdvisor(kind, parents, perCell, gen, seed) {
  let bytes, source;
  if (kind === 'quantum') {
    try { const q = await quantumBytes(32, { tag: `advisor:quantum:g${gen}` }); bytes = Buffer.from(q.hex, 'hex'); source = `qrng:${q.mode}:${q.job_id}`; }
    catch (e) { return [{ cell: 'quantum', error: String(e.message || e) }]; }
  } else { const R = rng(seed + gen * 7919); bytes = Buffer.from(Array.from({ length: 32 }, () => R.next() & 255)); source = 'xorshift32'; }
  const out = [];
  for (let i = 0; i < perCell; i++) {
    const p = parents[bytes[(i * 7) % 32] % parents.length];
    const b = Buffer.concat([bytes.subarray(i * 5 % 32), bytes.subarray(0, i * 5 % 32)]);
    out.push({ cell: kind, projector: p.projector, params: mutate(p.projector, p.params, b), why: `mutate ${source}`, parent: p.id });
  }
  return out;
}

export async function jevGate(prop) {
  try {
    const r = await systemOne({ projector: prop.projector, params: prop.params,
      schema: Object.fromEntries(Object.entries(getProjector(prop.projector).params).map(([k, s]) => [k, s.values ? s.values : s.type === 'bool' ? 'bool' : `${s.type} in [${s.min},${s.max}]`])) },
      { coherent: { type: 'noul', instructions: 'Every parameter value is legal for its declared type and range, and the combination is not self-defeating (for example, it does not render a blank or unreadable picture).' } },
      { tag: 'gate:jev' });
    return r.answers?.coherent?.noul ?? null;
  } catch (e) { return null; }
}

// Score one config on every scene: free + cheap scorers, then the paid critic.
export async function evaluate(prop, feeds, ctx) {
  const vl = [], inv = [], mot = [], notes = []; let chars = 0, ms = 0;
  const prs = feeds.map((seq) => project(prop.projector, seq, prop.params));
  const vs = await Promise.all(feeds.map((seq, i) => score('vlm', { seq, projection: prs[i], ctx })));   // feeds in parallel
  for (const [i, seq] of feeds.entries()) {
    const pr = prs[i], v = vs[i];
    chars += pr.char_budget; ms += pr.compute_estimate.ms;
    inv.push((await score('inverse', { seq, projection: pr })).fidelity);
    vl.push(v.fidelity);
    if (v.detail.vs_vlm.motion_recall !== null) mot.push(v.detail.vs_vlm.motion_recall);
    const d = v.detail.vs_vlm;
    if (d.unmatched_ref.length) notes.push(`${seq.truth.scene}: missed ${d.unmatched_ref.join('/')}`);
    if (d.hallucinated.length) notes.push(`${seq.truth.scene}: invented ${d.hallucinated.slice(0, 3).join('/')}`);
  }
  const jp = ctx.skipJepa ? null : (await score('jepa', { projection: { projector: prop.projector, params: prop.params }, ctx })).fidelity;
  const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
  const row = { ...prop, vlm: mean(vl), vlm_per_scene: vl.map((x) => +x.toFixed(3)), inverse: mean(inv), jepa: jp,
                motion_recall: mot.length ? +mean(mot).toFixed(3) : null, chars: Math.round(chars / feeds.length), ms: ms / feeds.length,
                notes: notes.slice(0, 4).join('; ') };
  row.U = utility(row);
  return row;
}

export async function runSearch({ feeds, generations = 3, perCell = 2, cells = ['llm:deepseek', 'llm:kimi', 'llm:zai', 'quantum', 'local'],
                                  ctx = {}, seed = 7, log = console.log, out, extraSeeds = [], holdout = null } = {}) {
  // holdout = { feeds, topK }: after each generation the topK new configs by U
  // are re-scored on feeds the advisors never see (row.hold), and parents and
  // the final winner are ranked by hold, not by U. Without it, rank by U.
  const rankKey = (r) => (holdout ? (r.hold ?? -1) : r.U);
  const scoreHold = async (rows) => {
    if (!holdout) return;
    for (const r of rows) {
      const h = await Promise.all(holdout.feeds.map((seq) => score('vlm', { seq, projection: project(r.projector, seq, r.params), ctx })));
      r.hold = h.reduce((a, x) => a + x.fidelity, 0) / h.length; r.hold_per_scene = h.map((x) => +x.fidelity.toFixed(3));
      log(`   hold #${r.id} ${r.hold.toFixed(3)} [${r.hold_per_scene.join(' ')}] (search-set vlm ${r.vlm.toFixed(3)})`);
    }
  };
  const history = [], rejected = [], genLog = [];
  let id = 0;
  const seen = new Set();
  const addRow = (r) => { r.id = id++; history.push(r); return r; };
  // generation 0: every projector at its defaults, plus any warm-start configs
  const g0 = [...listProjectors().map((p) => ({ projector: p.name, params: defaults(p.name), why: 'defaults' })),
              ...extraSeeds.map((e) => ({ projector: e.projector, params: { ...defaults(e.projector), ...e.params }, why: e.why || 'warm start' }))];
  for (const s0 of g0) {
    const r = addRow(await evaluate({ cell: 'seed', ...s0 }, feeds, ctx));
    seen.add(JSON.stringify([r.projector, r.params]));
    log(`g0 seed      ${fmt(r)}`);
  }
  await scoreHold([...history]);
  for (let g = 1; g <= generations; g++) {
    const parents = [...history].sort((a, b) => rankKey(b) - rankKey(a)).slice(0, 4);
    const props = [];
    for (const c of cells) {
      try {
        if (c.startsWith('llm:')) props.push(...await llmAdvisor(c.slice(4), history, perCell, g));  // 'llm:deepseek' or 'llm:di:kimi'
        else props.push(...await mutationAdvisor(c, parents, perCell, g, seed));
      } catch (e) { props.push({ cell: c, error: String(e.message || e).slice(0, 200) }); }
    }
    const genRows = [];
    for (const p of props) {
      if (p.error) { rejected.push({ gen: g, ...p, reasons: ['advisor error'] }); log(`g${g} ${p.cell.padEnd(12)} ERROR ${p.error}`); continue; }
      const known = listProjectors().some((q) => q.name === p.projector);
      const errs = known ? validateParams(p.projector, p.params) : [`unknown projector ${p.projector}`];
      const jev = known && !errs.length ? await jevGate(p) : null;
      if (errs.length || (ctx.jevVeto && jev !== null && jev < 0.15)) {
        rejected.push({ gen: g, ...p, reasons: errs.length ? errs : [`jev noul ${jev}`], jev });
        log(`g${g} ${p.cell.padEnd(12)} REJECT ${errs.join('; ') || 'jev ' + jev}`);
        continue;
      }
      const k = JSON.stringify([p.projector, p.params]);
      if (seen.has(k)) { log(`g${g} ${p.cell.padEnd(12)} duplicate, skipped`); continue; }
      seen.add(k);
      const r = addRow(await evaluate({ ...p, gen: g, jev }, feeds, ctx));
      genRows.push(r); log(`g${g} ${p.cell.padEnd(12)} ${fmt(r)}  jev=${jev} | ${p.why}`);
    }
    await scoreHold([...genRows].sort((a, b) => b.U - a.U).slice(0, holdout?.topK ?? 0));
    const best = [...history].sort((a, b) => rankKey(b) - rankKey(a))[0];
    genLog.push({ gen: g, proposed: props.length, scored: genRows.length, best_U: best.U, best_hold: best.hold ?? null, best_id: best.id });
    log(`g${g} best so far: #${best.id} U=${best.U.toFixed(3)} vlm=${best.vlm.toFixed(3)}${best.hold !== undefined ? ` hold=${best.hold.toFixed(3)}` : ''} ${best.projector} ${JSON.stringify(best.params)}`);
    if (out) fs.writeFileSync(out, JSON.stringify({ history, rejected, genLog, front: pareto(history).map((r) => r.id) }, null, 1));
  }
  return { history, rejected, genLog, front: pareto(history) };
}

const fmt = (r) => `#${r.id} U=${r.U.toFixed(3)} vlm=${r.vlm.toFixed(3)} [${r.vlm_per_scene.join(' ')}] jepa=${r.jepa?.toFixed(3)} mot=${r.motion_recall} inv=${r.inverse.toFixed(3)} chars=${r.chars} ms=${r.ms.toFixed(1)} ${r.projector} ${JSON.stringify(r.params)}`;
