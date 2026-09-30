// =============================================================================
// vlm — the GAN-style check. The projector is the generator; a vision-language
// model is the critic. The critic is shown ONLY the text projection and asked to
// reconstruct the scene as structured data (objects, where, which way they move,
// plus a normalized bounding box per object — a 2-D "wireframe"). Separately, a
// vision model is shown the ORIGINAL frames and asked the same question. The
// agreement between the two (compare.mjs) is the projection's fidelity: a
// projection is good when a vision model can recover the scene from the text.
//
// Two references are reported side by side:
//   vs_vlm    reconstruction vs the VLM's reading of the real frames (the
//             mission's definition; needs no ground truth, works on a real feed)
//   vs_truth  reconstruction vs the generator's ground truth (only possible on
//             synthetic feeds; it audits the critic itself)
// `fidelity` is vs_vlm unless ctx.reference === 'truth'.
//
// Critic modes: 'text' puts the characters in the prompt; 'image' renders the
// text to a PNG first (render.mjs, headless Chromium) so the model SEES it the
// way a person at a terminal would — chiaroscuro's lake test, automated.
// =============================================================================
import { pngDataURL } from '../core.mjs';
import { registerScorer } from '../registry.mjs';
import { vlm, extractJSON } from '../apis.mjs';
import { compareScenes } from '../compare.mjs';
import { CATEGORIES, REGIONS } from '../scenes.mjs';

export const DEFAULT_CRITIC = 'Qwen/Qwen3-VL-30B-A3B-Instruct';

const SCHEMA = `Return ONLY a JSON object, no prose:
{"setting": "outdoor-day" | "outdoor-night" | "indoor" | "unknown",
 "scene": "<one short sentence>",
 "objects": [{"label": "<noun>", "category": ${CATEGORIES.map((c) => `"${c}"`).join(' | ')},
   "region": ${REGIONS.map((r) => `"${r}"`).join(' | ')},
   "box": [x0, y0, x1, y1],
   "moving": "left" | "right" | "up" | "down" | "none"}]}
box is the object's bounding box as fractions of the image width/height (0 = left/top, 1 = right/bottom).
List each distinct object once (at most 8). Do not list ground, sky, walls, floor or other background surfaces as objects.`;

export const REFERENCE_PROMPT = `You are looking at two frames from the same fixed camera, a moment apart (the first image is earlier, the second is the latest).
Describe the scene as it is in the LATEST frame, and for each object say which way it moved between the frames ("none" if it did not move).
${SCHEMA}`;

export const RECON_PROMPT = `The text below is a character-art rendering of ONE view from a fixed camera. Each character stands for a small patch of the image: denser characters are brighter or darker patches depending on the renderer, lines may mark edges, and some renderings mark motion with arrow characters (> < ^ v or → ← ↑ ↓) and '~' for where something just was. It may contain several frames of the same view separated by blank lines, oldest first.
Reconstruct the scene in the latest frame: what objects are there, where, and which way each is moving ("none" if you cannot tell or it is still).
${SCHEMA}`;

const refCache = new Map();
export async function describeOriginal(seq, { model = DEFAULT_CRITIC, gap = seq.frames.length - 1 } = {}) {
  const n = seq.frames.length, a = seq.frames[Math.max(0, n - 1 - gap)], b = seq.frames[n - 1];
  const messages = [{ role: 'user', content: [
    { type: 'text', text: REFERENCE_PROMPT },
    { type: 'image_url', image_url: { url: pngDataURL(a) } },
    { type: 'image_url', image_url: { url: pngDataURL(b) } } ] }];
  const r = await vlm(messages, { model, max_tokens: 900, tag: `ref:${seq.truth?.scene}` });
  return { desc: extractJSON(r.text), raw: r.text, usage: r.usage, cached: r.cached, model };
}

export async function reconstruct(text, { model = DEFAULT_CRITIC, mode = 'text', tag = '' } = {}) {
  let content;
  if (mode === 'image') {
    const { renderTextPNG } = await import('../render.mjs');
    content = [{ type: 'text', text: RECON_PROMPT.replace('The text below is', 'The image shows') },
               { type: 'image_url', image_url: { url: 'data:image/png;base64,' + (await renderTextPNG(text)).toString('base64') } }];
  } else content = RECON_PROMPT + '\n\n```\n' + text + '\n```';
  const r = await vlm([{ role: 'user', content }], { model, max_tokens: 900, tag });
  return { desc: extractJSON(r.text), raw: r.text, usage: r.usage, cached: r.cached, model };
}

registerScorer({
  name: 'vlm',
  cost: 'paid',
  about: 'GAN-check: a VLM reconstructs the scene from the text; agreement with a VLM reading of the real frames',
  async score({ seq, projection, truth = seq.truth, ctx = {} }) {
    const model = ctx.critic_model || DEFAULT_CRITIC;
    const key = `${model}:${seq.truth?.scene}:${seq.frames.length}`;
    if (!refCache.has(key)) refCache.set(key, await describeOriginal(seq, { model: ctx.reference_model || model }));
    const ref = refCache.get(key);
    const rec = await reconstruct(projection.text_projection, { model, mode: ctx.critic_mode || 'text',
      tag: `rec:${seq.truth?.scene}:${projection.projector}` });
    const vs_vlm = compareScenes(ref.desc, rec.desc);
    const vs_truth = truth ? compareScenes(truth, rec.desc) : null;
    const fidelity = ctx.reference === 'truth' && vs_truth ? vs_truth.fidelity : vs_vlm.fidelity;
    return { fidelity: Math.max(0, Math.min(1, fidelity)),
             detail: { vs_vlm, vs_truth, parse_ok: !!rec.desc, reconstruction: rec.desc, reference: ref.desc,
                       usage: rec.usage, cached: rec.cached, model } };
  },
});
