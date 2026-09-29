#!/usr/bin/env node
// selftest.mjs — proves the drift alarm both stays quiet on the byte-exact port
// AND rings on a planted one-op drift, naming exactly the field that op feeds,
// with a minimal repro that isolates the planted op (clean on the pristine
// port). The shipped docs/poc/syzygy.js is verified unmodified at the end.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { differ, DRIFTS, GOLDEN, PORT, FIELDS, firstDiff, loadPort, runNative, runPort,
         portSource } from './differ.mjs';

let checks = 0, failures = 0;
const CHECK = (c, msg) => { checks++; if (c) console.log('  ok  : ' + msg); else { failures++; console.log('  FAIL: ' + msg); } };
const quiet = () => {};
const sha = (p) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const fromHex = (h) => Uint8Array.from(Buffer.from(h, 'hex'));

console.log('=== wasm-native-drift-differ self-test ===');
const portHash = sha(PORT);

// 1. firstDiff reports in pipeline order, not array order of discovery.
CHECK(firstDiff({ cols: 1, rows: 1, mask: [1], glyph: [2], tone: [3], spec_re: [], spec_im: [], peak_bin: 0, fft_valid: 0 },
                { cols: 1, rows: 1, mask: [1], glyph: [9], tone: [9], spec_re: [], spec_im: [], peak_bin: 5, fft_valid: 0 }).field === 'glyph',
      'firstDiff names the earliest field in pipeline order');
CHECK(FIELDS.join() === 'cols,rows,mask,glyph,tone,spec_re,spec_im,peak_bin,fft_valid', 'field order pinned');

// 2. the shipped port: byte-exact on the whole suite, golden on both sides.
const clean = await differ({ log: quiet });
CHECK(clean.drift === null, `shipped port byte-exact vs native on ${clean.valid} cases`);
CHECK(clean.skipped === 0, 'every generated case is a valid input for the C kernel');
CHECK(clean.goldenNative === GOLDEN && clean.goldenPort === GOLDEN, 'golden 0x6dbdd1a8 on native AND port');
const again = await differ({ log: quiet });
CHECK(again.suiteDigest === clean.suiteDigest, 'suite is deterministic (native digest re-derives)');

// 3. every planted one-op drift is caught and localized to its field.
for (const d of DRIFTS) {
  const r = await differ({ drift: d, log: quiet });
  CHECK(!!r.drift, `${d.id} (${d.why}) is detected`);
  if (!r.drift) continue;
  CHECK(r.drift.first.field === d.expect, `${d.id} first divergent field '${r.drift.first.field}' == planted '${d.expect}'`);
  const m = r.drift.minimal;
  const c = { w: m.w, h: m.h, ys: m.y_stride, uvs: m.uv_stride, bt: m.params.braille_thresh,
              e2: m.params.edge_thresh2, row: m.params.fft_row, y: fromHex(m.y_hex), uv: fromHex(m.uv_hex) };
  const nat = runNative([c])[0];
  const bad = firstDiff(nat, runPort(await loadPort(PORT, d), c));
  const good = firstDiff(nat, runPort(await loadPort(PORT), c));
  CHECK(bad && bad.field === d.expect && good === null,
        `${d.id} minimal repro ${m.w}x${m.h} diverges at '${d.expect}' ONLY with the planted op (pristine port exact)`);
}

// 4. the same catch through a real on-disk perturbed copy (--port path), then revert.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'syz-port-'));
try {
  const copy = path.join(tmp, 'syzygy.js');
  fs.writeFileSync(copy, portSource(PORT, DRIFTS[0]));
  const r = await differ({ portPath: copy, log: quiet });
  CHECK(r.drift && r.drift.first.field === DRIFTS[0].expect, 'on-disk perturbed copy caught at the same field');
  fs.writeFileSync(copy, fs.readFileSync(PORT));                   // revert
  const r2 = await differ({ portPath: copy, log: quiet });
  CHECK(r2.drift === null, 'reverted copy is byte-exact again');
} finally { fs.rmSync(tmp, { recursive: true, force: true }); }

CHECK(sha(PORT) === portHash, 'shipped docs/poc/syzygy.js unmodified by the self-test');
console.log(`differ selftest: ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
