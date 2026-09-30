// jev — a system-one critic: TypeSafe's Jev reads the text projection (as text;
// it cannot see images) and answers one typed `score` question: how clearly
// does this character art show distinct objects and where they are? The
// expected score (0..4, probability-weighted) / 4 is the fidelity.
//
// It is ~150 ms and fractions of a cent per call, so if it tracks the VLM
// critic it can sit in the cascade between the free scorers and the paid one.
// Whether it does is measured, not assumed: `node plugins/ml/jevcheck.mjs`.
import { registerScorer } from '../registry.mjs';
import { systemOne } from '../apis.mjs';

export const JEV_QUESTION = {
  legible: {
    type: 'score',
    instructions: 'This is character art (ASCII, box-drawing or braille characters) rendered from one camera frame. How clearly could a viewer make out distinct objects (buildings, vehicles, people, trees, sky objects) and where each one is in the frame?',
    criteria: [
      'No objects can be made out; noise or a uniform texture.',
      'Vague blobs; maybe one shape, unclear what it is.',
      'Some shapes with rough positions, but most are ambiguous.',
      'Most objects are recognisable with clear positions.',
      'Every object is clearly recognisable and placed; motion marks, if any, are clear.',
    ],
  },
};

export async function jevLegibility(text, tag = '') {
  const r = await systemOne({ projection: text }, JEV_QUESTION, { tag: `jev-critic:${tag}` });
  const a = r.answers?.legible;
  return { score: a?.score ?? null, confidence: a?.confidence ?? null, usage: r.usage, cached: r.cached };
}

registerScorer({
  name: 'jev',
  cost: 'cheap',
  about: 'TypeSafe Jev typed score: how legible are objects and layout in the text (system-one critic)',
  async score({ seq, projection }) {
    const r = await jevLegibility(projection.text_projection, `${seq.truth?.scene}:${projection.projector}`);
    return { fidelity: r.score === null ? 0 : Math.max(0, Math.min(1, r.score / 4)), detail: r };
  },
});
