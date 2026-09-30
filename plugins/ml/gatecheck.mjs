#!/usr/bin/env node
// gatecheck.mjs — measures the TypeSafe Jev gate against the deterministic
// validator on 8 hand-labelled configs (4 legal, 4 malformed). Real API calls,
// cached. Prints each verdict and the agreement. The deterministic validator is
// authoritative in search.mjs; this measures whether Jev could stand in for it.
import { defaults, validateParams } from './index.mjs';
import { jevGate } from './search.mjs';
const D = (n, o = {}) => ({ projector: n, params: { ...defaults(n), ...o } });
const cases = [
  ['legal: mirror defaults', D('mirror'), true],
  ['legal: syzygy braille 96 cols', D('syzygy', { field: 'braille', cols: 96 }), true],
  ['legal: motion fused bg, unicode', D('motion', { bg: 'fused', arrows: 'unicode' }), true],
  ['legal: motion blank bg, fill', D('motion', { bg: 'blank', mark: 'fill' }), true],
  ['bad: cols 400 (max 160)', D('mirror', { cols: 400 }), false],
  ['bad: enum field "sobel"', D('syzygy', { field: 'sobel' }), false],
  ['bad: thresh as string', D('motion', { thresh: 'high' }), false],
  ['bad: negative window', D('motion', { window: -3 }), false],
];
let agree = 0;
for (const [name, p, legal] of cases) {
  const errs = validateParams(p.projector, p.params), noul = await jevGate(p);
  const jevSays = noul === null ? null : noul >= 0.5;
  if (jevSays === legal) agree++;
  console.log(`${name.padEnd(34)} validator ${errs.length ? 'REJECT' : 'accept'}  jev noul ${noul}  ${jevSays === legal ? 'agrees' : 'DISAGREES'}`);
}
console.log(`jev gate agreement with labels: ${agree}/${cases.length}`);
