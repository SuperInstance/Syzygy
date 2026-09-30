#!/usr/bin/env node
// =============================================================================
// ideate.mjs — send the crew out to ideate, then let a typed system-one judge
// (TypeSafe Jev) triage what comes back. No single model decides: six LLMs
// propose from their own angle, Jev scores every idea on the same typed rubric,
// and the ranking is the aggregate of many small typed judgments.
//
//   node plugins/ml/holarchy/ideate.mjs      -> logs/holarchy-ideas.json (+ printed table)
// =============================================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chat, systemOne, extractJSON } from '../apis.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'logs', 'holarchy-ideas.json');

const CONTEXT = `We have a working research harness that turns a camera feed (short frame sequences) into plain text ("projections": character art with edge glyphs, braille, motion arrows). A vision-language model reconstructs the scene (objects, positions, motion) from the text alone; agreement with ground truth is the projection's fidelity. We measured: brightness-only text 0.18, edge glyphs following edges 0.34, motion arrows over edges 0.33 with motion recall 0.27, a VLM reading the real frames 0.92. Search over projector configs is noise-limited; averaging three VLM critics and promoting on held-out feeds fixed overfitting.

Tools available right now, all via API:
- TypeSafe "Jev": a SYSTEM-ONE model that answers TYPED questions about any state (text or JSON) in ~150 ms: noul (probability yes/no), choice (pick one named option, with probabilities), score (expected value on a rubric of levels). Many named questions can be asked in ONE request about the same state. Very cheap. It cannot see images.
- DeepInfra: vision-language models (Qwen3-VL, Gemma-3, Mistral-Small), large LLMs (Kimi-K2.6, Qwen3-235B, gpt-oss-120b, MiniMax-M3, DeepSeek), CLIP / text embeddings.
- MothQuantum: certified quantum random bytes (slow on real hardware, fast in simulator).
- Everything deterministic in the projector kernel is byte-exact integer C, so any device reproduces it.

The research vision: go beyond classic RL / neural nets / backprop. Learning as a HOLARCHY of first-person perspectives — cells -> tissues -> organs -> organisms -> families -> communities — with no central authority: a murmuration or kaleidoscope of many cheap viewpoints that see reality from different angles, help each other locally, and grow structure (guided growth) rather than being trained end-to-end. Typed system-one judgments are the "nerve impulses"; expensive models are rare "deliberations".`;

const ASK = `${CONTEXT}

Propose 4 CONCRETE, NOVEL experiments that can be run THIS WEEK with exactly these tools on this projection problem (we have ground truth, so results are measurable). Each must use Jev in an essential, non-trivial way, name the level(s) of organization it lives at, and state a falsifiable hypothesis with the number that would confirm or refute it. Prefer ideas where many cheap local typed judgments replace one expensive global one, where structure grows, or where perspectives negotiate without a center.

Reply with JSON only:
{"ideas": [{"name": "<short>", "levels": ["cell"|"tissue"|"organ"|"organism"|"family"|"community"], "mechanism": "<3-5 sentences>", "jev_role": "<what Jev is asked, typed>", "hypothesis": "<falsifiable, with the measurement>", "cost": "<API calls estimate>", "beyond_classic_ml": "<one sentence: why this is not just RL/NN/backprop>"}]}`;

const CREW = [
  ['deepinfra', 'moonshotai/Kimi-K2.6', { reasoning_effort: 'none' }],
  ['deepinfra', 'Qwen/Qwen3-235B-A22B-Instruct-2507', {}],
  ['deepinfra', 'openai/gpt-oss-120b', {}],
  ['deepinfra', 'MiniMaxAI/MiniMax-M3', { reasoning_effort: 'none' }],
  ['deepseek', undefined, {}],
  ['zai', undefined, {}],
];

const RUBRIC = {
  novelty: { type: 'score', instructions: 'How novel is this research idea relative to standard reinforcement learning, neural-network training, evolutionary search and ensemble methods?',
    criteria: ['A standard, well-known technique.', 'A minor variant of a known technique.', 'A new combination of known parts.', 'A genuinely new mechanism.', 'A new paradigm.'] },
  testable: { type: 'noul', instructions: 'This experiment can actually be run this week using only the listed tools (a typed yes/no/choice/score model, vision-language and language models over an API, quantum random bytes) on synthetic camera feeds with ground truth, and yields a clear number.' },
  leverage: { type: 'score', instructions: 'If the hypothesis holds, how much does it change what can be learned or built (leverage)?',
    criteria: ['Nothing beyond this one problem.', 'A small, local improvement.', 'A reusable method for this project.', 'A reusable method for many learning systems.', 'A new lever on how learning systems are organized.'] },
  decentral: { type: 'score', instructions: 'How much does the mechanism rely on many local perspectives cooperating without a central authority (versus one central model or controller)?',
    criteria: ['Fully central.', 'Mostly central.', 'Mixed.', 'Mostly local and peer-to-peer.', 'Fully local; structure emerges.'] },
};

const ideas = [];
await Promise.all(CREW.map(async ([provider, model, extra]) => {
  const who = model ? model.split('/').pop() : provider;
  try {
    const r = await chat(provider, [{ role: 'user', content: ASK }], { model, max_tokens: 4000, temperature: 0.9, extra, timeoutMs: 300000, tag: `ideate:${who}` });
    const j = extractJSON(r.text);
    for (const i of j?.ideas || []) ideas.push({ from: who, ...i });
    console.log(`${who}: ${(j?.ideas || []).length} ideas`);
  } catch (e) { console.log(`${who}: ERROR ${String(e.message).slice(0, 160)}`); }
}));

// Jev triage: one request per idea, four typed questions each.
for (const idea of ideas) {
  const { from, ...state } = idea;
  const r = await systemOne({ context: 'Research idea for a camera-to-text projection system with typed system-one judgments, VLMs, LLMs and quantum randomness.', idea: state }, RUBRIC, { tag: `triage:${from}` });
  const a = r.answers || {};
  idea.jev = { novelty: a.novelty?.score ?? null, testable: a.testable?.noul ?? null, leverage: a.leverage?.score ?? null, decentral: a.decentral?.score ?? null };
  // aggregate: normalized mean of the four typed judgments, testability as a gate-weight
  const J = idea.jev;
  idea.merit = J.novelty === null ? 0 : ((J.novelty / 4 + J.leverage / 4 + J.decentral / 4) / 3) * (0.25 + 0.75 * (J.testable ?? 0));
}
ideas.sort((a, b) => b.merit - a.merit);
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), rubric: RUBRIC, ideas }, null, 1));
console.log(`\n${ideas.length} ideas triaged by Jev (merit = mean(novelty, leverage, decentral)/4 x (0.25 + 0.75 testable))`);
for (const i of ideas) console.log(`${i.merit.toFixed(3)}  nov ${i.jev.novelty?.toFixed(2)} lev ${i.jev.leverage?.toFixed(2)} dec ${i.jev.decentral?.toFixed(2)} test ${i.jev.testable?.toFixed(2)}  [${i.from}] ${i.name} (${(i.levels || []).join('/')})`);
