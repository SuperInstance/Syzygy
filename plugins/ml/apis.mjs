// =============================================================================
// apis.mjs — the crew of external models, each behind one small function. Every
// call is (a) cached on disk by a hash of its request, so a re-run of a playtest
// replays for free and is reproducible, and (b) appended to a call log with its
// latency and token usage, so every number in the docs can point to the raw
// response that produced it.
//
//   vlm(messages, opts)        DeepInfra OpenAI-compatible chat (vision models)
//   llm(provider, messages)    deepseek | kimi | zai | deepinfra text models
//   systemOne(state, questions) TypeSafe Jev typed answers (noul/choice/score)
//   quantumBytes(n)            MothQuantum comet-qrng-v1 (emu mode by default)
//
// Keys come only from the environment; nothing here writes a key to disk.
// Set SYZ_ML_OFFLINE=1 to forbid network calls (cache hits still work).
// =============================================================================
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const CACHE_DIR = process.env.SYZ_ML_CACHE || path.join(HERE, 'cache');
export const LOG_FILE = process.env.SYZ_ML_LOG || path.join(HERE, 'logs', 'calls.jsonl');
const OFFLINE = () => process.env.SYZ_ML_OFFLINE === '1';

export const PROVIDERS = {
  deepinfra: { url: 'https://api.deepinfra.com/v1/openai/chat/completions', key: 'DEEPINFRA_KEY', model: 'Qwen/Qwen3-VL-30B-A3B-Instruct' },
  deepseek:  { url: 'https://api.deepseek.com/chat/completions', key: 'DEEPSEEK_KEY', model: 'deepseek-chat' },
  kimi:      { url: 'https://api.moonshot.ai/v1/chat/completions', key: 'KIMIAI_KEY', model: 'kimi-k2.6' },
  zai:       { url: 'https://api.z.ai/api/paas/v4/chat/completions', key: 'ZAI_KEY', model: 'glm-4.5-flash',
               extra: { thinking: { type: 'disabled' } } },
};

export const stats = { calls: 0, cacheHits: 0, byProvider: {} };

function cacheKey(obj) { return createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 24); }
function logCall(rec) {
  fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  fs.appendFileSync(LOG_FILE, JSON.stringify(rec) + '\n');
}
// Strip base64 image payloads from what we log (they are reproducible from the scene).
function redactImages(messages) {
  return JSON.parse(JSON.stringify(messages, (k, v) =>
    typeof v === 'string' && v.startsWith('data:image') ? `<image ${v.length}B sha=${cacheKey(v)}>` : v));
}

async function cached(kind, request, doFetch, { tag = '', nocache = false } = {}) {
  const key = cacheKey({ kind, request });
  const file = path.join(CACHE_DIR, kind, key + '.json');
  if (!nocache && fs.existsSync(file)) { stats.cacheHits++; return { ...JSON.parse(fs.readFileSync(file, 'utf8')), cached: true }; }
  if (OFFLINE()) throw new Error(`offline: no cache for ${kind} ${key}`);
  const t0 = Date.now();
  const out = await doFetch();
  out.ms = Date.now() - t0;
  stats.calls++; stats.byProvider[kind] = (stats.byProvider[kind] || 0) + 1;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out));
  logCall({ at: new Date().toISOString(), kind, tag, key, ms: out.ms, usage: out.usage || null,
            model: out.model || null, text: out.text?.slice(0, 4000) ?? null, error: out.error || null });
  return { ...out, cached: false };
}

async function postJSON(url, headers, body, timeoutMs = 120000, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      const txt = await r.text();
      if (r.status === 429 || r.status >= 500) { last = new Error(`${r.status} ${txt.slice(0, 200)}`); await new Promise((s) => setTimeout(s, 2000 * (i + 1))); continue; }
      if (!r.ok) throw new Error(`${r.status} ${txt.slice(0, 400)}`);
      return JSON.parse(txt);
    } catch (e) { last = e; if (i < tries - 1) await new Promise((s) => setTimeout(s, 2000 * (i + 1))); }
  }
  throw last;
}

// OpenAI-compatible chat. Returns { text, usage, model }.
export async function chat(provider, messages, { model, max_tokens = 800, temperature = 0, tag, nocache, json = false, extra = {}, timeoutMs = 120000 } = {}) {
  const p = PROVIDERS[provider];
  if (!p) throw new Error('unknown provider ' + provider);
  const key = process.env[p.key];
  const body = { model: model || p.model, messages, max_tokens, temperature, ...(p.extra || {}), ...extra,
                 ...(json ? { response_format: { type: 'json_object' } } : {}) };
  return cached(provider, { ...body, messages: body.messages }, async () => {
    if (!key) throw new Error(`missing ${p.key}`);
    const d = await postJSON(p.url, { Authorization: `Bearer ${key}` }, body, timeoutMs);
    const text = d.choices?.[0]?.message?.content ?? '';
    return { text, usage: d.usage || null, model: d.model || body.model, request: redactImages(messages) };
  }, { tag, nocache });
}

export const vlm = (messages, opts = {}) => chat('deepinfra', messages, opts);
export const llm = (provider, messages, opts = {}) => chat(provider, messages, opts);

// DeepInfra embeddings (OpenAI-compatible). Returns an array of vectors.
export async function embed(texts, { model = 'Qwen/Qwen3-Embedding-0.6B', tag } = {}) {
  const body = { model, input: texts, encoding_format: 'float' };
  const r = await cached('embed', body, async () => {
    const d = await postJSON('https://api.deepinfra.com/v1/openai/embeddings', { Authorization: `Bearer ${process.env.DEEPINFRA_KEY}` }, body);
    return { vectors: d.data.map((x) => x.embedding), usage: d.usage, model, text: `${texts.length} embeddings` };
  }, { tag });
  return r.vectors;
}

// TypeSafe Jev: typed answers. questions = { name: {type:'noul'|'choice'|'score', instructions, criteria?} }
export async function systemOne(state, questions, { model = 'jev-latest', tag, nocache } = {}) {
  const body = { model, state, questions };
  return cached('typesafe', body, async () => {
    const key = process.env.TYPESAFEAI_KEY; if (!key) throw new Error('missing TYPESAFEAI_KEY');
    const d = await postJSON('https://api.typesafe.ai/v1/systemone', { Authorization: `Bearer ${key}` }, body, 60000);
    return { answers: d.answers, usage: d.usage, model: d.model, text: JSON.stringify(d.answers) };
  }, { tag, nocache });
}

// MothQuantum comet-qrng-v1. mode 'emu' = Aer simulator (uncertified); 'qpu' = IBM hardware.
// Draws are never cached (a replayed random stream would defeat the point), but are logged.
export async function quantumBytes(n = 32, { mode = 'emu', tag, maxWaitMs = 60000 } = {}) {
  if (OFFLINE()) throw new Error('offline: quantum draws are never cached');
  const base = process.env.MOTHQUANTUM_BASE || 'https://api.mothquantum.com/api/v1';
  const H = { Authorization: `Bearer ${process.env.MOTHQUANTUM_KEY}` };
  const t0 = Date.now();
  const sub = await postJSON(`${base}/engines/comet-qrng-v1/process`, H,
    { mode, params: { num_qubits: 12, shots: Math.max(256, n * 8), output_bytes: n, bell_witness: false } }, 60000);
  for (const t0w = Date.now(); Date.now() - t0w < maxWaitMs;) {
    await new Promise((s) => setTimeout(s, 1500));
    const st = await (await fetch(`${base}/jobs/${sub.job_id}/status`, { headers: H })).json();
    if (st.status === 'failed') throw new Error('qrng job failed: ' + JSON.stringify(st.error));
    if (st.status === 'completed') {
      const res = await (await fetch(`${base}/jobs/${sub.job_id}/result`, { headers: H })).json();
      const out = res.result.output;
      const rec = { hex: out.random.hex, bytes: out.random.bytes, job_id: sub.job_id, mode,
                    commit: out.commitment?.commit, certificate: out.certificate ?? null, backend: out.provenance?.backend ?? null, ms: Date.now() - t0 };
      stats.calls++; stats.byProvider.quantum = (stats.byProvider.quantum || 0) + 1;
      logCall({ at: new Date().toISOString(), kind: 'quantum', tag, key: sub.job_id, ms: rec.ms, text: rec.hex, mode });
      return rec;
    }
  }
  throw new Error('qrng job timed out');
}

// Salvage every well-formed {"projector": ..., "params": {...}} object from a reply
// whose outer JSON is broken (seen: Qwen3-235B emitting one stray '}').
export function extractProposals(text) {
  const out = [], t = String(text || '');
  for (let s = t.indexOf('{'); s >= 0; s = t.indexOf('{', s + 1)) {
    let depth = 0, inStr = false, esc = false;
    for (let i = s; i < t.length; i++) {
      const c = t[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true; else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        try { const o = JSON.parse(t.slice(s, i + 1)); if (o && typeof o.projector === 'string' && o.params && typeof o.params === 'object') out.push(o); } catch {}
        break;
      }
    }
  }
  return out;
}

// Pull the first JSON object out of a model reply (models wrap JSON in prose/fences).
export function extractJSON(text) {
  if (!text) return null;
  const t = text.replace(/```(?:json)?/g, '');
  const s = t.indexOf('{'); if (s < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = s; i < t.length; i++) {
    const c = t[i];
    if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true; else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return JSON.parse(t.slice(s, i + 1)); } catch { return null; } }
  }
  return null;
}
