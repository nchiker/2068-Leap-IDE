// run-all.mjs -- rebuild every Leap Arcade runtime and run every Arcade test suite, then print one summary.
//
//   node arcade/tests/run-all.mjs            all suites except the slow mutation runs
//   node arcade/tests/run-all.mjs --full     also the mutation runs (m3- to m17-mutations; several minutes each)
//   node arcade/tests/run-all.mjs --quick    sets ARCADE_QUICK=1 (shorter fuzz runs in the compiler suites)
//   node arcade/tests/run-all.mjs --jobs N   runs the suites N at a time (default 1).  The runtime builds and the steps in
//                                            EXCLUSIVE (they write shared files under arcade/build) run first, alone; each
//                                            other step gets ARCADE_JOB_TAG, so assembleGame() uses its own work directory.
//                                            Output is kept per step and printed in the usual order, with the same summary.
//
// (tools/verify.mjs is the driver for everything: this file plus the Studio / editor / model tests, the IDE's suites and the checks, sharded and chosen by what changed.)
// Needs Node 20+ and sjasmplus (/usr/local/bin/sjasmplus). Exit code 1 if any step fails.
"use strict";
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { RUNTIME_BUILDS, SUITES, MUTATION_SUITES, EXCLUSIVE, SLOW_FIRST } from './steps.mjs';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const full = args.includes('--full');
const env = { ...process.env, ...(args.includes('--quick') ? { ARCADE_QUICK: '1' } : {}) };
const jobsArg = args.find((a, i) => a.startsWith('--jobs=') || args[i - 1] === '--jobs');
const jobs = Math.max(1, Number(jobsArg?.startsWith('--jobs=') ? jobsArg.slice(7) : jobsArg ?? 1) || 1);
// The step lists (builds, suites, mutation suites, EXCLUSIVE, SLOW_FIRST) live in steps.mjs, which tools/verify.mjs shares.
const builds = RUNTIME_BUILDS.map((b) => b.file);
const suites = [...SUITES, ...(full ? MUTATION_SUITES.map((m) => m.file) : [])];

function finish(file, isBuild, t0, status, out) {
  const lines = out.trim().split('\n');
  const last = lines[lines.length - 1] || '(no output)';
  return { file, ok: status === 0, last, secs: ((Date.now() - t0) / 1000).toFixed(1), out, isBuild };
}

function run(file, isBuild) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(ROOT, file)], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 3600_000 });
  return finish(file, isBuild, t0, r.status, (r.stdout || '') + (r.stderr || ''));
}

/** The same as run(), without blocking: stdout then stderr, as spawnSync gives them. */
function runAsync(file, tag) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [join(ROOT, file)], { cwd: ROOT, env: { ...env, ARCADE_JOB_TAG: tag }, stdio: ['ignore', 'pipe', 'pipe'] });
    const so = [], se = [];
    child.stdout.on('data', (d) => so.push(d));
    child.stderr.on('data', (d) => se.push(d));
    const timer = setTimeout(() => child.kill('SIGTERM'), 3600_000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(finish(file, false, t0, code, Buffer.concat(so).toString('utf8') + Buffer.concat(se).toString('utf8')));
    });
  });
}

function report(r) {
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file.padEnd(40)} ${r.secs.padStart(6)} s  ${r.last}`);
  if (!r.ok) console.log(r.out.split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 12).join('\n'));
}

const results = [];
for (const f of builds) results.push(run(f, true));
if (results.some((r) => !r.ok)) {
  for (const r of results.filter((x) => !x.ok)) console.log(`BUILD FAILED: ${r.file}\n${r.out.split('\n').slice(-15).join('\n')}`);
  process.exit(1);
}
if (jobs === 1) {
  for (const f of suites) { const r = run(f, false); results.push(r); report(r); }
} else {
  const t0 = Date.now();
  const done = new Map();
  for (const f of suites.filter((x) => EXCLUSIVE.has(x))) done.set(f, run(f, false));
  const rank = (f) => { const i = SLOW_FIRST.indexOf(f); return i < 0 ? SLOW_FIRST.length : i; };
  const rest = suites.filter((x) => !EXCLUSIVE.has(x)).sort((a, b) => rank(a) - rank(b));   // (a stable sort: the rest keep their order)
  // Print in the usual order: a step is printed once it and every step before it have finished.
  let printed = 0;
  const flush = () => { while (printed < suites.length && done.has(suites[printed])) report(done.get(suites[printed++])); };
  flush();
  let next = 0;
  async function worker() {
    while (next < rest.length) {
      const i = next++;
      done.set(rest[i], await runAsync(rest[i], `j${i}`));
      flush();
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, rest.length) }, worker));
  flush();
  for (const f of suites) results.push(done.get(f));
  console.log(`(${jobs} jobs: ${((Date.now() - t0) / 1000).toFixed(0)} s for the suites)`);
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed${failed.length ? '; FAILED: ' + failed.map((r) => r.file).join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);
