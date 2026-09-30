// =============================================================================
// registry.mjs — the contract every ML ability plugin signs.
//
// A PROJECTOR turns a feed (a short sequence of RGB frames, newest last) into
// text:
//     project(seq, params) -> { text_projection, char_budget, compute_estimate }
//   text_projection   string, rows joined by '\n'
//   char_budget       Unicode code points excluding newlines (what a terminal,
//                     a serial line or a model's context pays for)
//   compute_estimate  { ms, ops } — ms is measured by the registry around the
//                     call; ops is the plugin's own count of inner-loop work
// It declares a typed PARAMS schema, so a search can mutate it and a gate can
// reject a malformed config before any money is spent on scoring it.
//
// A SCORER judges a projection:
//     score({ seq, projection, truth, ctx }) -> { fidelity: 0..1, detail }
// Scorers are async (some call a vision model); `cost` says how dear a call is
// ('free' | 'cheap' | 'paid') so a search can spend cheap signals first.
//
// Nothing here is part of the fused kernel. The kernel measures; these plugins
// interpret. A projector MAY call into the byte-exact kernel (see
// projectors/syzygy.mjs) but no plugin can change what the kernel emits.
// =============================================================================

const projectors = new Map();
const scorers = new Map();

const TYPES = new Set(['int', 'float', 'enum', 'bool']);

function checkSchema(name, schema) {
  for (const [k, s] of Object.entries(schema)) {
    if (!TYPES.has(s.type)) throw new Error(`${name}.${k}: bad type ${s.type}`);
    if ((s.type === 'int' || s.type === 'float') && !(s.min <= s.default && s.default <= s.max))
      throw new Error(`${name}.${k}: default outside [min,max]`);
    if (s.type === 'enum' && !s.values.includes(s.default)) throw new Error(`${name}.${k}: default not in values`);
  }
}

export function registerProjector(p) {
  if (!p.name || typeof p.project !== 'function' || !p.params) throw new Error('projector needs name, params, project()');
  checkSchema(p.name, p.params);
  projectors.set(p.name, { kind: 'projector', about: '', ...p });
  return p;
}
export function registerScorer(s) {
  if (!s.name || typeof s.score !== 'function') throw new Error('scorer needs name, score()');
  scorers.set(s.name, { kind: 'scorer', cost: 'free', about: '', ...s });
  return s;
}
export const getProjector = (n) => { const p = projectors.get(n); if (!p) throw new Error('no projector ' + n); return p; };
export const getScorer = (n) => { const s = scorers.get(n); if (!s) throw new Error('no scorer ' + n); return s; };
export const listProjectors = () => [...projectors.values()];
export const listScorers = () => [...scorers.values()];

export function defaults(name) {
  const out = {}; for (const [k, s] of Object.entries(getProjector(name).params)) out[k] = s.default; return out;
}

// The cheap, deterministic typed gate: every key known, every value typed and in
// range. Returns a list of problems (empty = accept). This is the gate that runs
// before ANY paid call; a model-backed gate (TypeSafe) may run after it.
export function validateParams(name, params) {
  const schema = getProjector(name).params, errs = [];
  if (!params || typeof params !== 'object') return ['params is not an object'];
  for (const k of Object.keys(params)) if (!(k in schema)) errs.push(`unknown key ${k}`);
  for (const [k, s] of Object.entries(schema)) {
    if (!(k in params)) { errs.push(`missing ${k}`); continue; }
    const v = params[k];
    if (s.type === 'int' && !(Number.isInteger(v) && v >= s.min && v <= s.max)) errs.push(`${k}=${JSON.stringify(v)} not int in [${s.min},${s.max}]`);
    if (s.type === 'float' && !(typeof v === 'number' && Number.isFinite(v) && v >= s.min && v <= s.max)) errs.push(`${k}=${JSON.stringify(v)} not number in [${s.min},${s.max}]`);
    if (s.type === 'enum' && !s.values.includes(v)) errs.push(`${k}=${JSON.stringify(v)} not in ${s.values.join('|')}`);
    if (s.type === 'bool' && typeof v !== 'boolean') errs.push(`${k}=${JSON.stringify(v)} not bool`);
  }
  return errs;
}

// Coerce an advisor's loose proposal onto the schema (fill defaults, clamp,
// round ints). Used AFTER the gate has reported, so the log shows what the
// advisor actually asked for.
export function coerceParams(name, params) {
  const schema = getProjector(name).params, out = {};
  for (const [k, s] of Object.entries(schema)) {
    let v = params?.[k];
    if (s.type === 'int' || s.type === 'float') {
      v = Number(v); if (!Number.isFinite(v)) v = s.default;
      v = Math.min(s.max, Math.max(s.min, v)); if (s.type === 'int') v = Math.round(v);
    } else if (s.type === 'enum') { if (!s.values.includes(v)) v = s.default; }
    else if (s.type === 'bool') { v = typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : s.default; }
    out[k] = v;
  }
  return out;
}

export const countChars = (text) => [...text.replace(/\n/g, '')].length;

// Run a projector through the contract: validate params, time the call, check
// the returned shape. Throws on a contract breach (a plugin bug, not a bad score).
export function project(name, seq, params = defaults(name)) {
  const p = getProjector(name);
  const errs = validateParams(name, params);
  if (errs.length) throw new Error(`${name}: invalid params: ${errs.join('; ')}`);
  const t0 = process.hrtime.bigint();
  const out = p.project(seq, params);
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (typeof out?.text_projection !== 'string') throw new Error(`${name}: text_projection must be a string`);
  const chars = countChars(out.text_projection);
  if (out.char_budget !== chars) throw new Error(`${name}: char_budget ${out.char_budget} != counted ${chars}`);
  return { ...out, projector: name, params, compute_estimate: { ops: out.compute_estimate?.ops ?? null, ms } };
}

export async function score(name, args) {
  const s = getScorer(name);
  const r = await s.score(args);
  if (!(typeof r?.fidelity === 'number' && r.fidelity >= 0 && r.fidelity <= 1)) throw new Error(`${name}: fidelity must be in [0,1], got ${r?.fidelity}`);
  return { scorer: name, cost: s.cost, ...r };
}
