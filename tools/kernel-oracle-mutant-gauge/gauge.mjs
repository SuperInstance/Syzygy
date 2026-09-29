#!/usr/bin/env node
// =============================================================================
// gauge.mjs — kernel-oracle-mutant-gauge: mutation-test the CORRECTNESS ORACLE.
//
// An un-gameable verifier is only as strong as its oracle. This plants each
// documented bug from mutants.mjs into a scratch copy of include/ + tests/,
// runs the REAL suite (tests/run.sh, unmodified), and records whether the
// suite catches it. Output:
//   * oracle-strength score = killed / (catalog - equivalent)
//   * the surviving mutants  = real bugs the suite would ship
//   * a hash-chained catalog (catalog.jsonl): entry_i.hash =
//       sha256(entry_{i-1}.hash || canonical(entry_i minus hash)),
//     genesis = sha256 of the pristine source tree, so a catalog is bound to
//     the exact code it judged and re-derives bit-for-bit on a rerun.
//
// Zero deps: node built-ins + the repo's own C compiler.
//
//   node tools/kernel-oracle-mutant-gauge/gauge.mjs            run, print report
//   node tools/kernel-oracle-mutant-gauge/gauge.mjs --write    ... and rewrite catalog.jsonl
//   node tools/kernel-oracle-mutant-gauge/gauge.mjs --verify   re-derive + compare to catalog.jsonl
//   node tools/kernel-oracle-mutant-gauge/gauge.mjs --only F12,Y05
//   node tools/kernel-oracle-mutant-gauge/selftest.mjs         self-test of the gauge
// =============================================================================
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUTANTS } from './mutants.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '../..');
export const CATALOG = path.join(HERE, 'catalog.jsonl');
const TREE_DIRS = ['include', 'tests'];
const TIMEOUT_MS = 120000;

const sha256 = (s) => createHash('sha256').update(s).digest('hex');

// Canonical JSON: keys sorted, no whitespace — the hash input is unambiguous.
export function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object')
    return '{' + Object.keys(v).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  return JSON.stringify(v);
}

function listTree(root) {
  const out = [];
  for (const d of TREE_DIRS) {
    for (const f of fs.readdirSync(path.join(root, d)).sort()) {
      const rel = d + '/' + f;
      if (fs.statSync(path.join(root, rel)).isFile()) out.push(rel);
    }
  }
  return out;
}

// Genesis: hash of every file the suite can see, in sorted order.
export function treeHash(root = ROOT) {
  const h = createHash('sha256');
  for (const rel of listTree(root)) {
    h.update(rel + '\0');
    h.update(fs.readFileSync(path.join(root, rel)));
    h.update('\0');
  }
  return h.digest('hex');
}

function countOccurrences(hay, needle) {
  let n = 0, i = 0;
  while ((i = hay.indexOf(needle, i)) !== -1) { n++; i += needle.length; }
  return n;
}

// Returns the mutated source text, or throws if the mutant is not well-formed.
export function applyMutant(m, root = ROOT) {
  const src = fs.readFileSync(path.join(root, m.file), 'utf8');
  const n = countOccurrences(src, m.find);
  if (n !== 1) throw new Error(`mutant ${m.id}: find text occurs ${n}x in ${m.file} (need exactly 1)`);
  if (m.find === m.replace) throw new Error(`mutant ${m.id}: replace == find`);
  return src.replace(m.find, () => m.replace);
}

function makeSandbox(root) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'syz-mutant-'));
  for (const rel of listTree(root)) {
    fs.mkdirSync(path.join(dir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(path.join(root, rel), path.join(dir, rel));
  }
  return dir;
}

// Run the unmodified suite inside `dir`. Verdict is purely the suite's.
export function runSuite(dir) {
  const r = spawnSync('sh', [path.join(dir, 'tests/run.sh')], {
    encoding: 'utf8', timeout: TIMEOUT_MS, env: { ...process.env, CC: process.env.CC || 'cc' },
  });
  const out = (r.stdout || '') + (r.stderr || '');
  const fails = out.split('\n').filter((l) => /^\s*FAIL:/.test(l)).map((l) => l.replace(/^\s*FAIL:\s*/, '').trim());
  let status;
  if (r.error && r.error.code === 'ETIMEDOUT') status = 'timeout';
  else if (r.status === 0) status = 'pass';
  else if (fails.length) status = 'fail';
  else if (/error:/.test(out)) status = 'compile-error';
  else status = 'crash';
  return { status, fails, out };
}

// Judge one mutant: 'KILLED' (by failing check / crash / timeout) or 'SURVIVED'.
export function judge(m, root = ROOT) {
  const mutated = applyMutant(m, root);
  const dir = makeSandbox(root);
  try {
    fs.writeFileSync(path.join(dir, m.file), mutated);
    const r = runSuite(dir);
    const verdict = r.status === 'pass' ? 'SURVIVED' : 'KILLED';
    return { verdict, how: r.status, killed_by: r.fails.slice(0, 3), fail_count: r.fails.length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export function baseline(root = ROOT) {
  const dir = makeSandbox(root);
  try { return runSuite(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Build the chained catalog from judged results (pure; used by run and verify).
export function chain(genesis, entries) {
  let prev = genesis;
  return entries.map((e) => {
    const body = { ...e, prev };
    const hash = sha256(prev + canon(body));
    prev = hash;
    return { ...body, hash };
  });
}

export function verifyChainIntegrity(lines) {
  if (!lines.length) return { ok: false, why: 'empty catalog' };
  let prev = lines[0].prev;
  for (const [i, l] of lines.entries()) {
    const { hash, ...body } = l;
    if (body.prev !== prev) return { ok: false, why: `entry ${i} (${l.id}): prev link broken` };
    if (sha256(prev + canon(body)) !== hash) return { ok: false, why: `entry ${i} (${l.id}): hash mismatch` };
    prev = hash;
  }
  return { ok: true, head: prev };
}

export function score(entries) {
  const live = entries.filter((e) => e.expect !== 'equivalent');
  const killed = live.filter((e) => e.verdict === 'KILLED');
  const survivors = live.filter((e) => e.verdict === 'SURVIVED');
  const refuted = entries.filter((e) => e.expect === 'equivalent' && e.verdict === 'KILLED');
  return { live: live.length, killed: killed.length, survivors, refuted,
           rate: live.length ? killed.length / live.length : 0 };
}

export function gauge({ root = ROOT, only = null, log = console.log } = {}) {
  const base = baseline(root);
  if (base.status !== 'pass') throw new Error('baseline suite is not green; refusing to gauge:\n' + base.out);
  const genesis = treeHash(root);
  const list = only ? MUTANTS.filter((m) => only.includes(m.id)) : MUTANTS;
  const judged = [];
  for (const m of list) {
    const j = judge(m, root);
    log(`  ${m.id.padEnd(4)} ${j.verdict.padEnd(8)} ${j.how.padEnd(13)} ${m.class.padEnd(10)} ${m.file.replace('include/', '')}` +
        (j.killed_by.length ? `  <- "${j.killed_by[0]}"` : ''));
    judged.push({ id: m.id, class: m.class, file: m.file, find: m.find, replace: m.replace,
                  why: m.why, expect: m.expect, verdict: j.verdict, how: j.how,
                  killed_by: j.killed_by, fail_count: j.fail_count });
  }
  return { genesis, entries: chain(genesis, judged) };
}

function report(res) {
  const s = score(res.entries);
  console.log(`\noracle-strength score: ${s.killed}/${s.live} = ${(100 * s.rate).toFixed(1)}%` +
              `  (${res.entries.length - s.live} equivalent excluded)`);
  console.log(`genesis (source tree): ${res.genesis}`);
  console.log(`catalog head        : ${res.entries.length ? res.entries[res.entries.length - 1].hash : '-'}`);
  if (s.survivors.length) {
    console.log(`\nSURVIVING MUTANTS (holes in the oracle): ${s.survivors.length}`);
    for (const e of s.survivors) console.log(`  ${e.id} [${e.class}] ${e.file}: ${e.why}`);
  } else console.log('\nno surviving mutants: every planted bug is caught');
  if (s.refuted.length)
    console.log(`\nWARNING: equivalence claim refuted for ${s.refuted.map((e) => e.id).join(',')}`);
  return s;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const oi = args.indexOf('--only');
  const only = oi >= 0 ? args[oi + 1].split(',') : null;
  console.log(`kernel-oracle-mutant-gauge: ${only ? only.length : MUTANTS.length} mutants vs sh tests/run.sh`);
  const res = gauge({ only });
  const s = report(res);
  const text = res.entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
  if (args.includes('--write')) {
    if (only) { console.error('--write needs the full catalog (drop --only)'); process.exit(2); }
    fs.writeFileSync(CATALOG, text);
    console.log(`wrote ${path.relative(ROOT, CATALOG)}`);
  }
  if (args.includes('--verify')) {
    const committed = fs.readFileSync(CATALOG, 'utf8');
    const lines = committed.trim().split('\n').map((l) => JSON.parse(l));
    const integ = verifyChainIntegrity(lines);
    const same = committed === text;
    console.log(`verify: chain integrity ${integ.ok ? 'ok' : 'BROKEN: ' + integ.why}; re-derivation ${same ? 'IDENTICAL' : 'DIFFERS'}`);
    if (!integ.ok || !same) process.exit(1);
  }
  if (args.includes('--strict') && (s.survivors.length || s.refuted.length)) process.exit(1);
}
