#!/usr/bin/env node
// selftest.mjs — proves the plugin contract offline (no network, no keys):
// the registry enforces typed params, every projector keeps the contract on
// every feed and is deterministic, the syzygy projector runs the shipped port
// (which still hashes to the golden 0x6dbdd1a8), the motion projector finds the
// right direction on every moving feed and adds nothing to a still one, the
// discriminator arithmetic (compare.mjs) scores known cases exactly, the free
// scorers rank the obvious cases, mutation never emits a malformed config, and
// offline mode refuses to spend money.
process.env.SYZ_ML_OFFLINE = '1';
const { project, score, defaults, validateParams, coerceParams, registerProjector, listProjectors, countChars } = await import('./index.mjs');
const { SCENES, renderSequence } = await import('./scenes.mjs');
const { compareScenes, normBox } = await import('./compare.mjs');
const { port } = await import('./projectors/syzygy.mjs');
const { ridge, predict, probe } = await import('./scorers/jepa.mjs');
const { mutate, pareto } = await import('./search.mjs');
const { extractJSON, chat } = await import('./apis.mjs');
const { rng, hex32 } = await import('./core.mjs');

let checks = 0, failures = 0;
const CHECK = (c, msg) => { checks++; if (c) console.log('  ok  : ' + msg); else { failures++; console.log('  FAIL: ' + msg); } };
const throws = (f) => { try { f(); return false; } catch { return true; } };
console.log('=== plugins/ml self-test ===');

// 1. registry: typed params are enforced at registration and at call time
CHECK(listProjectors().map((p) => p.name).join() === 'mirror,syzygy,motion', 'three projectors registered: mirror, syzygy, motion');
CHECK(throws(() => registerProjector({ name: 'bad', params: { k: { type: 'int', min: 0, max: 1, default: 5 } }, project() {} })), 'registration rejects a default outside [min,max]');
CHECK(throws(() => registerProjector({ name: 'bad2', params: { k: { type: 'complex', default: 0 } }, project() {} })), 'registration rejects an unknown param type');
for (const p of listProjectors()) CHECK(validateParams(p.name, defaults(p.name)).length === 0, `${p.name} defaults pass the gate`);
const bad = { ...defaults('motion'), cols: 500, thresh: 'high', mark: 'glow', legend: 1, extra: 3 };
const errs = validateParams('motion', bad);
CHECK(errs.length === 5 && errs.some((e) => e.startsWith('unknown key extra')), `gate names all 5 faults in a malformed config (${errs.length})`);
CHECK(validateParams('motion', coerceParams('motion', bad)).length === 0, 'coerceParams maps a malformed config onto the schema');
CHECK(throws(() => project('motion', renderSequence(SCENES[0]), bad)), 'project() refuses to run a malformed config');

// 2. contract + determinism on every feed
const feeds = SCENES.map((s) => renderSequence(s));
for (const p of listProjectors()) {
  let ok = true, det = true;
  for (const seq of feeds) {
    const a = project(p.name, seq), b = project(p.name, seq);
    ok &&= typeof a.text_projection === 'string' && a.char_budget === countChars(a.text_projection) && a.char_budget > 0 && a.compute_estimate.ms >= 0;
    det &&= a.text_projection === b.text_projection;
  }
  CHECK(ok, `${p.name}: contract {text_projection, char_budget, compute_estimate} holds on 4 feeds`);
  CHECK(det, `${p.name}: same feed -> same text`);
}
CHECK(project('mirror', feeds[0], { ...defaults('mirror'), frames: 2 }).char_budget === 2 * project('mirror', feeds[0]).char_budget, 'mirror frames=2 costs exactly twice the characters');

// 3. the syzygy projector is the golden kernel
const S = port.syz_yuv_synth(32, 16, 32, 32);
const golden = port.fnv1a_fused(port.syz_fused(S, { braille_thresh: 100, edge_thresh2: 4000, fft_row: 1 }));
CHECK(golden === 0x6dbdd1a8, `the port the syzygy projector loads hashes to golden ${hex32(golden)}`);
const sz = project('syzygy', feeds[0]).text_projection;
CHECK([...sz].some((c) => '─│╱╲'.includes(c)), 'syzygy glyph field emits Sobel edge glyphs on a real scene');
CHECK(sz.split('\n').every((l) => l[0] === '─'), 'known scar: column 0 is always ─ (Sobel zero-padding at the frame edge)');
const tg = [...project('syzygy', feeds[0], { ...defaults('syzygy'), orient: 'tangent' }).text_projection], gr = [...sz];
CHECK(tg.length === gr.length && tg.every((c, i) => c === gr[i] || (c === '│' && gr[i] === '─') || (c === '─' && gr[i] === '│')) && tg.some((c, i) => c !== gr[i]),
      'orient=tangent relabels only ─<->│; every other kernel byte is unchanged');
const mb = project('motion', feeds[0], { ...defaults('motion'), bg: 'braille' }).text_projection;
CHECK([...mb].some((c) => c >= '⠀' && c <= '⣿') && mb.includes('>'), 'motion bg=braille: kernel braille background with arrows on top');

// 4. motion: right direction on every moving feed, nothing added to a still one
for (const seq of feeds) {
  const want = seq.truth.objects.find((o) => o.moving !== 'none').moving;
  const out = project('motion', seq);
  const dirs = out.motion.filter((b) => b.n >= 4).map((b) => b.dir);
  CHECK(dirs.includes(want), `motion finds the ${want}-moving object in ${seq.truth.scene} (blobs: ${out.motion.map((b) => b.dir + '/' + b.n).join(' ')})`);
}
const still = renderSequence({ ...SCENES[0], objects: SCENES[0].objects.map((o) => ({ ...o, vx: 0, vy: 0 })) });
const mo = project('motion', still), mi = project('mirror', still);
CHECK(mo.motion.length === 0 && mo.text_projection === mi.text_projection, 'still feed: motion projector == mirror, byte for byte');
{ // motion bg=edges on a still feed == syzygy orient=tangent: the edges layer IS the relabelled kernel
  const a = project('motion', still, { ...defaults('motion'), bg: 'edges' }).text_projection;
  const b = project('syzygy', still, { ...defaults('syzygy'), orient: 'tangent' }).text_projection;
  CHECK(a === b, 'still feed: motion bg=edges == syzygy orient=tangent, byte for byte');
}

// 5. the discriminator arithmetic
const T = feeds[0].truth;
CHECK(Math.abs(compareScenes(T, T).fidelity - 1) < 1e-9, 'truth vs itself = 1.000');
CHECK(compareScenes(T, { setting: 'unknown', objects: [] }).fidelity === 0, 'empty reconstruction = 0');
const extra = { ...T, objects: [...T.objects, ...['a', 'b', 'c', 'd'].map((l) => ({ label: 'blob ' + l, category: 'other', region: 'center', moving: 'none' }))] };
CHECK(compareScenes(T, extra).fidelity < 0.6, `hallucinating 4 extra objects is charged (${compareScenes(T, extra).fidelity.toFixed(3)})`);
const flipped = { ...T, objects: T.objects.map((o) => ({ ...o, moving: o.moving === 'right' ? 'left' : o.moving })) };
CHECK(compareScenes(T, flipped).motion_recall === 0 && compareScenes(T, T).motion_recall === 1, 'motion_recall: wrong direction 0, right direction 1');
CHECK(normBox([500, 200, 700, 400]).join() === '0.5,0.2,0.7,0.4' && normBox([0.1, 0.2, 0.3, 0.4])[0] === 0.1, 'boxes on Qwen\'s 0..1000 grid are normalized');
const k = { ...T, objects: T.objects.map((o) => ({ ...o, box: o.box.map((v) => Math.round(v * 1000)) })) };
CHECK(Math.abs(compareScenes(T, k).fidelity - 1) < 0.01, '0..1000 boxes score the same as 0..1 boxes');

// 6. free scorers rank the obvious cases
for (const seq of feeds) {
  const pr = project('mirror', seq), inv = await score('inverse', { seq, projection: pr });
  const R = rng(5), chars = [...pr.text_projection.replace(/\n/g, '')];
  for (let i = chars.length - 1; i > 0; i--) { const j = R.next() % (i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
  const cols = pr.text_projection.indexOf('\n'), shuf = chars.join('').match(new RegExp(`.{1,${cols}}`, 'gu')).join('\n');
  const inv2 = await score('inverse', { seq, projection: { ...pr, text_projection: shuf } });
  CHECK(inv.fidelity > 0.85 && inv2.fidelity < 0.2, `inverse: mirror ${inv.fidelity.toFixed(3)} vs shuffled ${inv2.fidelity.toFixed(3)} on ${seq.truth.scene}`);
}
{ // ridge recovers a planted linear map
  const R = rng(11), Wt = [[2, -1], [0.5, 3], [1, 1]];
  const X = Array.from({ length: 200 }, () => [R.float(), R.float(), 1]);
  const Y = X.map((x) => [0, 1].map((c) => x.reduce((s, v, i) => s + v * Wt[i][c], 0)));
  const W = ridge(X, Y, 1e-6), p = predict(W, [0.3, 0.7, 1]);
  CHECK(Math.abs(p[0] - (0.6 + 0.35 + 1)) < 1e-4 && Math.abs(p[1] - (-0.3 + 2.1 + 1)) < 1e-4, 'ridge recovers a planted linear map');
}
const jm = probe('motion', defaults('motion'), { train: 300, test: 80 }), jr = probe('mirror', defaults('mirror'), { train: 300, test: 80 });
CHECK(jm.r2_test > jr.r2_test + 0.05, `jepa: motion predicts next-frame change better than mirror (R^2 ${jm.r2_test.toFixed(3)} vs ${jr.r2_test.toFixed(3)})`);

// 7. search plumbing
let malformed = 0;
for (let i = 0; i < 1000; i++) {
  const R = rng(1000 + i), bytes = Array.from({ length: 32 }, () => R.next() & 255);
  const name = ['mirror', 'syzygy', 'motion'][i % 3];
  if (validateParams(name, mutate(name, defaults(name), bytes)).length) malformed++;
}
CHECK(malformed === 0, 'mutation cell: 1000 random mutations, 0 malformed configs');
const rows = [{ vlm: 0.5, chars: 100, ms: 1 }, { vlm: 0.4, chars: 200, ms: 1 }, { vlm: 0.3, chars: 50, ms: 1 }];
CHECK(pareto(rows).length === 2 && !pareto(rows).includes(rows[1]), 'pareto keeps the non-dominated, drops the dominated');
CHECK(extractJSON('Sure!\n```json\n{"a": {"b": "}"}}\n```\nthanks')?.a?.b === '}', 'extractJSON pulls a JSON object out of prose and fences');
{ // the Qwen3-235B failure seen in run 3 prep: valid proposals inside broken outer JSON
  const { extractProposals } = await import('./apis.mjs');
  const broken = '{"proposals": [{"projector": "motion", "params": {"cols": 80}, "why": "a"}, {"projector": "syzygy", "params": {"cols": 64, "field": "braille"}, "why": "b"}}]}';
  const got = extractProposals(broken);
  CHECK(extractJSON(broken) === null && got.length === 2 && got[1].params.field === 'braille', 'extractProposals salvages both proposals from JSON with a stray brace');
  const { DI_ADVISORS } = await import('./search.mjs');
  CHECK(['kimi', 'qwen', 'gptoss', 'minimax'].every((k) => typeof DI_ADVISORS[k] === 'string'), 'four DeepInfra-hosted advisors are configured');
}
let refused = false; try { await chat('deepseek', [{ role: 'user', content: 'selftest-never-cached ' + Date.now() }]); } catch (e) { refused = /offline/.test(e.message); }
CHECK(refused, 'SYZ_ML_OFFLINE=1 refuses an uncached paid call');

console.log(`plugins/ml selftest: ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
