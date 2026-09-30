#!/usr/bin/env node
// ideate2.mjs — generation 2 of the research community. Every model now sees
// (a) the MEASURED results of the experiments built from generation 1 and (b)
// the whole generation-1 idea pool from all models (peer learning, no editor).
// Jev triages generation 2 on the same typed rubric plus one new question
// (does the idea use the evidence?), so "did sharing evidence raise the quality
// of the community's ideas?" becomes a number.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, systemOne, extractJSON } from '../apis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url)), LOGS = path.join(HERE, '..', 'logs');
const gen1 = JSON.parse(fs.readFileSync(path.join(LOGS, 'holarchy-ideas.json'), 'utf8'));
const RUBRIC = { ...gen1.rubric,
  evidence: { type: 'noul', instructions: 'The idea explicitly builds on the measured results listed in the context (it cites a specific number or finding and designs the next test around it) rather than ignoring them.' } };

const EVIDENCE = `MEASURED RESULTS (ground truth, bootstrap 95% CIs) from experiments built out of the community's first ideas:
E1 holarchic reader: tissues (6x3 tiles) of a character-art frame answer first-person typed questions (TypeSafe Jev), fuse into organs by a local rule, no VLM. Fidelity vs truth: 0.30 on brightness-only text (a VLM reading the same text: 0.28), about 60% of the VLM on edge-glyph text (VLM 0.49-0.51 vs swarm 0.24-0.31). Tissues recognise background well (0.87-1.0) but what object they hold poorly (0.03-0.24): information dies at tissue-level 'what', not at organ assembly. Motion arrows survive (motion recall 0.40). Letting tissues hear neighbours' claims spread object labels into empty sky: background accuracy 0.87 -> 0.63, net fidelity down (not significant).
E2 community jury: three VLM critics reconstruct the same text. Believing the reconstruction the other two agree with most (no judge, no centre) beats averaging them: 0.354 vs 0.301 (+0.053, CI [0.016, 0.089]); a Jev judge choosing among them +0.042 (CI [0.006, 0.078]); oracle 0.433.
E3 guided growth: 8x4 tissues sense their patch of the real frame as numbers and choose how to draw themselves (tone / edges / braille / motion arrows); a second round hearing neighbours' CHOICES helps (+0.066, CI [0.002, 0.128]) but the mosaic only ties drawing everything with edges (0.328 vs 0.350, n.s.): mixing styles creates seams. Jev almost never chose the motion style (6 of 320 tissues).
E4 kaleidoscope: each tissue has two independent weak senses (raw text, numeric receptors). Asserting an object only where both agree collapses fidelity to 0.10 (they rarely agree); their UNION beats the better sense (+0.046, CI [0.019, 0.076]) and ties an oracle that knows which sense to trust.
PRINCIPLE (provisional): consensus helps when members are individually competent and errors are noise; union helps when members are weak and err in different places; gossiping BELIEFS spreads errors, gossiping CHOICES coordinates.`;

const gen1Pool = gen1.ideas.map((i) => `- [${i.from}] ${i.name}: ${i.mechanism.slice(0, 220)}`).join('\n');
const ASK = `You are one member of a research community with no central editor. Here is what the community measured, and every idea proposed in the first round (by you and your peers).

${EVIDENCE}

FIRST-ROUND IDEAS FROM THE WHOLE COMMUNITY:
${gen1Pool}

Tools unchanged: TypeSafe Jev (typed noul/choice/score on text/JSON, ~150 ms, many questions per request, cannot see images), DeepInfra VLMs/LLMs/embeddings, MothQuantum random bytes, byte-exact integer projector kernel, synthetic feeds with ground truth.

Propose 3 NEXT experiments that climb to a HIGHER level of abstraction or a MORE POWERFUL lever than the first round: e.g. mechanisms that decide which aggregation regime they are in, that grow or re-organise their own structure, that let perspectives specialise, or that make the research loop itself a holarchy. Each must build explicitly on a measured result above, be runnable this week with these tools, and name the number that would refute it.

Reply with JSON only: {"ideas": [{"name": "...", "levels": ["cell"|"tissue"|"organ"|"organism"|"family"|"community"], "mechanism": "<3-5 sentences>", "jev_role": "...", "hypothesis": "<falsifiable, with the measurement>", "builds_on": "<which result, which number>", "cost": "...", "beyond_classic_ml": "..."}]}`;

const CREW = [
  ['deepinfra', 'moonshotai/Kimi-K2.6', { reasoning_effort: 'none' }],
  ['deepinfra', 'Qwen/Qwen3-235B-A22B-Instruct-2507', {}],
  ['deepinfra', 'openai/gpt-oss-120b', {}],
  ['deepinfra', 'MiniMaxAI/MiniMax-M3', { reasoning_effort: 'none' }],
  ['deepseek', undefined, {}],
  ['zai', undefined, {}],
];
const ideas = [];
await Promise.all(CREW.map(async ([provider, model, extra]) => {
  const who = model ? model.split('/').pop() : provider;
  try {
    const r = await chat(provider, [{ role: 'user', content: ASK }], { model, max_tokens: 4000, temperature: 0.9, extra, timeoutMs: 300000, tag: `ideate2:${who}` });
    const got = extractJSON(r.text)?.ideas;
    for (const i of got || []) ideas.push({ from: who, ...i });
    console.log(`${who}: ${(got || []).length} ideas`);
  } catch (e) { console.log(`${who}: ERROR ${String(e.message).slice(0, 160)}`); }
}));

async function triage(list, withEvidence) {
  for (const idea of list) {
    const { from, jev, merit, ...state } = idea;
    const rub = withEvidence ? RUBRIC : gen1.rubric;
    const r = await systemOne({ context: 'Research idea for a camera-to-text projection system with typed system-one judgments, VLMs, LLMs and quantum randomness.', ...(withEvidence ? { evidence_available: EVIDENCE } : {}), idea: state }, rub, { tag: `triage2:${from}` });
    const a = r.answers || {};
    idea.jev = { novelty: a.novelty?.score ?? null, testable: a.testable?.noul ?? null, leverage: a.leverage?.score ?? null, decentral: a.decentral?.score ?? null, evidence: a.evidence?.noul ?? null };
    const J = idea.jev;
    idea.merit = J.novelty === null ? 0 : ((J.novelty / 4 + J.leverage / 4 + J.decentral / 4) / 3) * (0.25 + 0.75 * (J.testable ?? 0));
  }
}
await triage(ideas, true);
// re-triage generation 1 WITH the same evidence in view, so both generations are judged by one yardstick
const g1 = gen1.ideas.map((i) => ({ ...i }));
await triage(g1, true);
ideas.sort((a, b) => b.merit - a.merit);
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);
const sum = (L) => Object.fromEntries(['novelty', 'leverage', 'decentral', 'testable', 'evidence'].map((k) => [k, +mean(L.map((i) => i.jev[k] ?? 0)).toFixed(3)]).concat([['merit', +mean(L.map((i) => i.merit)).toFixed(3)]]));
const S1 = sum(g1), S2 = sum(ideas);
fs.writeFileSync(path.join(LOGS, 'holarchy-ideas-gen2.json'), JSON.stringify({ at: new Date().toISOString(), evidence: EVIDENCE, gen1_rejudged: S1, gen2: S2, ideas, gen1: g1 }, null, 1));
console.log(`\ngen 1 (n=${g1.length}, re-judged with evidence in view): ${JSON.stringify(S1)}`);
console.log(`gen 2 (n=${ideas.length}):                             ${JSON.stringify(S2)}`);
for (const i of ideas) console.log(`${i.merit.toFixed(3)}  nov ${i.jev.novelty?.toFixed(2)} lev ${i.jev.leverage?.toFixed(2)} dec ${i.jev.decentral?.toFixed(2)} test ${i.jev.testable?.toFixed(2)} evid ${i.jev.evidence?.toFixed(2)}  [${i.from}] ${i.name}`);
