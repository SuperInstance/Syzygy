#!/usr/bin/env node
// selftest.mjs — proves the gauge itself is not lying (a gauge that kills
// everything, or nothing, scores any oracle as it likes). Runs in a few seconds.
import fs from 'node:fs';
import { MUTANTS } from './mutants.mjs';
import { applyMutant, baseline, judge, chain, canon, verifyChainIntegrity,
         treeHash, score, CATALOG } from './gauge.mjs';

let checks = 0, failures = 0;
const CHECK = (c, msg) => { checks++; if (c) console.log('  ok  : ' + msg); else { failures++; console.log('  FAIL: ' + msg); } };
const byId = (id) => MUTANTS.find((m) => m.id === id);

console.log('=== kernel-oracle-mutant-gauge self-test ===');

// 1. catalog well-formedness: every mutant applies to exactly one site.
let wellFormed = true;
for (const m of MUTANTS) { try { applyMutant(m); } catch (e) { wellFormed = false; console.log('    ' + e.message); } }
CHECK(wellFormed, `all ${MUTANTS.length} mutants apply to exactly one site`);
CHECK(new Set(MUTANTS.map((m) => m.id)).size === MUTANTS.length, 'mutant ids unique');
let threw = false;
try { applyMutant({ id: 'X', file: 'include/syz_fft.h', find: 'int32_t', replace: 'int64_t' }); } catch { threw = true; }
CHECK(threw, 'ambiguous find text (many sites) is refused');

// 2. the sandbox is faithful: pristine tree passes, a lethal bug is killed,
//    and the known-equivalent mutant survives (so kills are not artefacts).
CHECK(baseline().status === 'pass', 'pristine sandbox: tests/run.sh is green');
const lethal = judge(byId('B01'));
CHECK(lethal.verdict === 'KILLED' && lethal.how === 'fail', 'B01 (luma >>7) is KILLED by a failing check');
const eq = judge(byId('T05'));
CHECK(eq.verdict === 'SURVIVED', 'T05 (provably equivalent) SURVIVES: the gauge does not over-kill');

// 3. hash chain: deterministic, tamper-evident.
const fake = [{ id: 'a', verdict: 'KILLED' }, { id: 'b', verdict: 'SURVIVED' }];
const c1 = chain('g', fake), c2 = chain('g', fake);
CHECK(canon(c1) === canon(c2), 'chain is deterministic');
CHECK(verifyChainIntegrity(c1).ok, 'untampered chain verifies');
const t = c1.map((e) => ({ ...e })); t[0].verdict = 'SURVIVED';
CHECK(!verifyChainIntegrity(t).ok, 'flipping one verdict breaks the chain');
CHECK(chain('h', fake)[1].hash !== c1[1].hash, 'genesis (source tree) is bound into every hash');

// 4. the committed catalog is intact and was judged against THIS source tree.
if (fs.existsSync(CATALOG)) {
  const lines = fs.readFileSync(CATALOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const integ = verifyChainIntegrity(lines);
  CHECK(integ.ok, 'committed catalog.jsonl chain integrity');
  CHECK(lines[0].prev === treeHash(), 'catalog genesis == current include/+tests/ tree hash (not stale)');
  CHECK(lines.length === MUTANTS.length && lines.every((l, i) => l.id === MUTANTS[i].id), 'catalog covers the full mutant list in order');
  const s = score(lines);
  console.log(`  info: committed oracle-strength ${s.killed}/${s.live}; survivors: ${s.survivors.map((e) => e.id).join(',') || 'none'}`);
} else CHECK(false, 'catalog.jsonl exists (run gauge.mjs --write)');

console.log(`gauge selftest: ${checks} checks, ${failures} failures`);
process.exit(failures ? 1 : 0);
