#!/usr/bin/env node
"use strict";
// arcade-codegen-perf.mjs -- before / after tick costs for the compiler size pass (docs/ARCADE_COMPILER_SIZE_CONTRACT.md section 5, "Time", and C4).
// The games must stay tick-for-tick identical in behaviour, so tick k of a recorded run is the same tick before and after, and its cost in T-states can be compared.
//
//   node tests/arcade-codegen-perf.mjs                          measure the five games with the working tree's compiler and print the figures
//   node tests/arcade-codegen-perf.mjs --save before.json       ... and write them (with every tick's cost) to a file
//   node tests/arcade-codegen-perf.mjs --old <git ref>          compile with the src/ of that ref (git archive <ref> src, as arcade/tools/regen-baselines.mjs does) against the SAME runtimes
//   node tests/arcade-codegen-perf.mjs --compare before.json    check the contract's bounds per run against a saved file, print before / after and exit 1 on a breach:
//                                                                 * the median is not higher;
//                                                                 * the 95th percentile and the worst tick rise by at most 0.25 % of that game's budget (rounded down);
//                                                                 * no tick that was within the budget goes over it (the ticks over the budget stay a subset of the before's);
//                                                                 * the run has the same number of measured ticks (else it is not the same game).
//   node tests/arcade-codegen-perf.mjs --games runner,vaults    only these (runner, platformer, vaults, starfall, blockfall)
//
// The measurements are the existing suites' own, not new ones (each takes a `compile` function for this):
//   runner      tests/arcade-runner-perf.mjs measure(): Leap Runner (runner.arc, v3, runner.script.json); the ticks that are not a world load or a scene start; budget 3 refreshes
//   platformer  tests/arcade-m6-platformer-perf.mjs profile(): platformer.arc, v3, "win twice" and "game over" (the suite's two runs); every tick; PROC FRAME mean; budget 3 refreshes
//   vaults      tests/arcade-m8-vaults-perf.mjs profile(): vaults.arc, v4, the win and the lose run; without the first 3 ticks (the boot HUD paint); PROC FRAME mean; budget 4 refreshes
//   starfall    tests/arcade-starfall.mjs section 4: shooter.arc, v2, its script (tests/arcade-starfall-script.mjs), runReal() costs without the first 2 ticks (the map drawn into both files); budget 3 refreshes
//   blockfall   tests/arcade-blockfall.mjs section 7: the shipped blockfall.arc with CONST FREESEED = 0 (the variant the suite runs on the script: with the shipped FREESEED = 1 the piece order, and so the
//               play the script was made for, is different) on the 3,595-tick script (node tests/arcade-blockfall.mjs --dump-script), v2, costs without the first 2 ticks; budget 2 refreshes
// A tick's cost is the whole tick with the frame interrupt's time included (what decides whether it is late), exactly as the suites count it. Tick numbers are 1-based, as in the suites.
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile as workingCompile } from '../src/lang/arcade/arcade-compile.js';
import * as runnerPerf from './arcade-runner-perf.mjs';
import * as platformerPerf from './arcade-m6-platformer-perf.mjs';
import * as vaultsPerf from './arcade-m8-vaults-perf.mjs';
import { PLATFORMER_SRC } from './arcade-m6-platformer-harness.mjs';
import { VAULTS_SRC } from './arcade-m8-vaults-harness.mjs';
import { keysOf, stickOf, FULL_TICKS as STARFALL_TICKS } from './arcade-starfall-script.mjs';
import { real, runReal } from './arcade-m5-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const FRAME = 58688;                       // T-states per refresh (TSRun's tStatesPerFrame)
const ALL = ['runner', 'platformer', 'vaults', 'starfall', 'blockfall'];

const argv = process.argv.slice(2);
const opt = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
if (argv.includes('--help') || argv.includes('-h')) { console.log(readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(2, 15).map((l) => l.replace(/^\/\/ ?/, '')).join('\n')); process.exit(0); }
const games = opt('--games') ? opt('--games').split(',').map((s) => s.trim()) : ALL;
for (const g of games) if (!ALL.includes(g)) { console.error(`unknown game "${g}" (${ALL.join(', ')})`); process.exit(2); }
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const sgn = (v) => (v > 0 ? '+' : v < 0 ? '-' : ' ') + fmt(Math.abs(v));

// ── the compiler ──────────────────────────────────────────────────────────────────────────────────
let tmp = null, compileFn = workingCompile, compilerLabel = 'working tree';
if (opt('--old')) {
  const ref = opt('--old');
  tmp = mkdtempSync(join(tmpdir(), 'codegen-perf-'));
  execFileSync('sh', ['-c', `git -C "${ROOT}" archive ${ref} src | tar -x -C "${tmp}"`]);
  compileFn = (await import(pathToFileURL(join(tmp, 'src/lang/arcade/arcade-compile.js')).href)).compile;
  compilerLabel = `src/ of ${ref}`;
}
const cleanup = () => { if (tmp) rmSync(tmp, { recursive: true, force: true }); tmp = null; };
process.on('exit', cleanup);

// ── statistics (the suites': sorted ascending, index floor(n * p)) ─────────────────────────────────
const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
/** `ticks`: [{k, t}] (k the 1-based tick number); `procFrame`: [t] of the logic or null. */
function stats(game, run, runtime, budgetRefreshes, ticks, procFrame = null) {
  const budget = budgetRefreshes * FRAME;
  const sorted = ticks.map((x) => x.t).sort((a, b) => a - b);
  const worst = ticks.reduce((a, x) => (x.t > a.t ? x : a), { t: -1, k: 0 });
  return {
    game, run, runtime, budget, n: ticks.length,
    median: pct(sorted, 0.5), p95: pct(sorted, 0.95), worst: worst.t, worstTick: worst.k,
    mean: sorted.reduce((s, v) => s + v, 0) / sorted.length,
    over: ticks.filter((x) => x.t > budget).map((x) => x.k),
    procFrameMean: procFrame && procFrame.length ? procFrame.reduce((s, v) => s + v, 0) / procFrame.length : null,
    ticks: ticks.map((x) => [x.k, x.t]),
  };
}

// ── the five games ───────────────────────────────────────────────────────────────────────────────
const measurers = {
  runner() {
    const { ticks } = runnerPerf.measure({ compile: compileFn, ticks: runnerPerf.SCRIPT.length });
    const play = ticks.filter((x) => !x.load).map((x) => ({ k: x.n, t: x.t }));        // not a world load, not a scene start
    return [stats('runner', 'play-through', 'v3', 3, play)];
  },
  platformer() {
    return platformerPerf.RUNS.map(([name, stick, n]) => {
      const { ticks } = platformerPerf.profile(PLATFORMER_SRC, { ticks: n, stick, compile: compileFn });
      return stats('platformer', name, 'v3', 3, ticks.map((x) => ({ k: x.n, t: x.t })), ticks.filter((x) => x.logic).map((x) => x.logic.t));
    });
  },
  vaults() {
    return vaultsPerf.RUNS.map(([name, runs]) => {
      const n = runs.reduce((a, [, k]) => a + k, 0);
      const { ticks: every } = vaultsPerf.profile(VAULTS_SRC, { ticks: n, stick: vaultsPerf.runsToStick(runs), compile: compileFn });
      const ticks = every.slice(3);                                                  // the first 3 ticks paint the boot HUD map: the runtime's own cost
      return stats('vaults', name, 'v4', 4, ticks.map((x) => ({ k: x.n, t: x.t })), ticks.filter((x) => x.logic).map((x) => x.logic.t));
    });
  },
  starfall() {
    const R = real();
    if (!R.ok) throw new Error('the v2 runtime: ' + R.why);
    const res = compileFn(readFileSync(join(ROOT, 'arcade/examples/shooter.arc'), 'utf8'), { runtime: R.rt, image: R.img, assets: JSON.parse(readFileSync(join(ROOT, 'arcade/examples/shooter.assets.json'), 'utf8')) });
    if (res.errors.length) throw new Error('starfall compile: ' + res.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
    const got = runReal(res, { ticks: STARFALL_TICKS, keys: keysOf, stick: stickOf, measure: true });
    if (got.error) throw new Error('starfall run: ' + got.error);
    const div = res.memory[0x8004] & 0x3F;
    return [stats('starfall', 'script', 'v2', div, got.costs.map((t, i) => ({ k: i + 1, t })).slice(2))];
  },
  blockfall() {
    const dir = mkdtempSync(join(tmpdir(), 'codegen-perf-bf-'));
    let script;
    try {
      execFileSync('node', [join(HERE, 'arcade-blockfall.mjs'), '--dump-script', join(dir, 'script.json')], { stdio: 'ignore' });
      script = JSON.parse(readFileSync(join(dir, 'script.json'), 'utf8'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
    const R = real();
    if (!R.ok) throw new Error('the v2 runtime: ' + R.why);
    const src = readFileSync(join(ROOT, 'arcade/examples/blockfall.arc'), 'utf8').replace('CONST FREESEED = 1', 'CONST FREESEED = 0');
    if (!src.includes('CONST FREESEED = 0')) throw new Error('blockfall.arc lost its CONST FREESEED line');
    const res = compileFn(src, { runtime: R.rt, image: R.img, assets: JSON.parse(readFileSync(join(ROOT, 'arcade/examples/blockfall.assets.json'), 'utf8')) });
    if (res.errors.length) throw new Error('blockfall compile: ' + res.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
    const got = runReal(res, { ticks: script.ticks, keys: (t) => script.keys[t - 1] ?? [], stick: (t) => script.stick[t - 1] ?? 0, measure: true });
    if (got.error) throw new Error('blockfall run: ' + got.error);
    const div = res.memory[0x8004] & 0x7F;
    return [stats('blockfall', 'script', 'v2', div, got.costs.map((t, i) => ({ k: i + 1, t })).slice(2))];
  },
};

// ── run ──────────────────────────────────────────────────────────────────────────────────────────
const t0 = Date.now();
const runs = [];
for (const g of games) {
  const t1 = Date.now();
  runs.push(...measurers[g]());
  console.log(`measured ${g} (${((Date.now() - t1) / 1000).toFixed(0)} s)`);
}
const rows = (r) => `${r.game} / ${r.run}`;
const head = ['run', 'ticks', 'median', '95th', 'worst', 'mean', 'PROC FRAME mean', 'over'];
console.log(`\ncompiler: ${compilerLabel}; whole-tick T-states, interrupt included; budget = refreshes * ${FRAME}`);
const printTable = (cols) => {
  const w = cols[0].map((_, i) => Math.max(...cols.map((r) => String(r[i]).length)));
  for (const r of cols) console.log('  ' + r.map((c, i) => (i === 0 ? String(c).padEnd(w[i]) : String(c).padStart(w[i]))).join('  '));
};
printTable([head, ...runs.map((r) => [rows(r), r.n, fmt(r.median), fmt(r.p95), fmt(r.worst) + ` (tick ${r.worstTick})`, fmt(r.mean), r.procFrameMean === null ? '-' : fmt(r.procFrameMean), `${r.over.length}${r.over.length ? ': ' + r.over.join(',') : ''}`])]);

if (opt('--save')) {
  writeFileSync(opt('--save'), JSON.stringify({ tool: 'tests/arcade-codegen-perf.mjs', compiler: compilerLabel, frameT: FRAME, runs }) + '\n');
  console.log(`\nsaved ${runs.length} runs to ${opt('--save')}`);
}

let breaches = 0;
if (opt('--compare')) {
  const before = JSON.parse(readFileSync(opt('--compare'), 'utf8'));
  console.log(`\ncomparison: before = ${opt('--compare')} (compiler: ${before.compiler}), after = ${compilerLabel}`);
  const bad = (r, msg) => { breaches++; console.log(`  BREACH  ${rows(r)}: ${msg}`); };
  const table = [['run', 'measure', 'before', 'after', 'difference', 'bound']];
  for (const a of runs) {
    const b = before.runs.find((x) => x.game === a.game && x.run === a.run);
    if (!b) { bad(a, 'no such run in the before file'); continue; }
    const tol = Math.floor(a.budget * 0.0025);
    if (a.n !== b.n || a.budget !== b.budget) bad(a, `not the same run: ${b.n} ticks and budget ${b.budget} before, ${a.n} and ${a.budget} after`);
    if (a.median > b.median) bad(a, `median ${fmt(b.median)} -> ${fmt(a.median)} (higher)`);
    if (a.p95 - b.p95 > tol) bad(a, `95th ${fmt(b.p95)} -> ${fmt(a.p95)}: +${fmt(a.p95 - b.p95)} T, more than ${fmt(tol)} T (0.25 % of the budget)`);
    if (a.worst - b.worst > tol) bad(a, `worst ${fmt(b.worst)} -> ${fmt(a.worst)}: +${fmt(a.worst - b.worst)} T, more than ${fmt(tol)} T (0.25 % of the budget)`);
    const newOver = a.over.filter((k) => !b.over.includes(k));
    if (newOver.length) bad(a, `tick(s) ${newOver.join(', ')} were within the budget of ${fmt(a.budget)} T and are over it now`);
    table.push([rows(a), 'median', fmt(b.median), fmt(a.median), sgn(a.median - b.median), '<= 0'],
      ['', '95th', fmt(b.p95), fmt(a.p95), sgn(a.p95 - b.p95), `<= +${fmt(tol)}`],
      ['', 'worst', fmt(b.worst), fmt(a.worst), sgn(a.worst - b.worst), `<= +${fmt(tol)}`],
      ['', 'mean', fmt(b.mean), fmt(a.mean), sgn(a.mean - b.mean), ''],
      ...(a.procFrameMean !== null && b.procFrameMean !== null ? [['', 'PROC FRAME mean', fmt(b.procFrameMean), fmt(a.procFrameMean), sgn(a.procFrameMean - b.procFrameMean), '']] : []),
      ['', 'ticks over budget', String(b.over.length), String(a.over.length), String(a.over.length - b.over.length), 'no new ones']);
    if (b.ticks && a.ticks && b.ticks.length === a.ticks.length) {
      const diff = a.ticks.map(([k, t], i) => [k, t - b.ticks[i][1], b.ticks[i][0]]);
      const changed = diff.filter(([, d]) => d !== 0), moved = diff.filter(([k, , kb]) => k !== kb).length;
      table.push(['', 'ticks that differ', '', '', `${changed.length} of ${a.n}`, moved ? `${moved} tick numbers moved` : '']);
      if (changed.length) { const big = changed.reduce((m, x) => (Math.abs(x[1]) > Math.abs(m[1]) ? x : m)); table.push(['', 'largest per-tick change', '', '', `${sgn(big[1])} (tick ${big[0]})`, '']); }
    }
  }
  console.log('');
  printTable(table);
  console.log(`\n${breaches ? 'FAIL' : 'PASS'}: arcade-codegen-perf (${runs.length} runs compared, ${breaches} breach${breaches === 1 ? '' : 'es'})`);
}
console.log(`(${((Date.now() - t0) / 1000).toFixed(0)} s)`);
process.exit(breaches ? 1 : 0);
