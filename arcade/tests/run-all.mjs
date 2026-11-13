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
// Needs Node 20+ and sjasmplus (/usr/local/bin/sjasmplus). Exit code 1 if any step fails.
"use strict";
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const full = args.includes('--full');
const env = { ...process.env, ...(args.includes('--quick') ? { ARCADE_QUICK: '1' } : {}) };
const jobsArg = args.find((a, i) => a.startsWith('--jobs=') || args[i - 1] === '--jobs');
const jobs = Math.max(1, Number(jobsArg?.startsWith('--jobs=') ? jobsArg.slice(7) : jobsArg ?? 1) || 1);
// Steps that write shared files (arcade/build/*.dck; blockfall also builds v2 if it is missing): never beside another step.
const EXCLUSIVE = new Set(['tests/arcade-blockfall.mjs']);
// The slowest steps (sequential run, 2026-11-11: 270, 198, 139, 114, 53, 44, 42, 37 s) start first, so none of them is the tail.
const SLOW_FIRST = ['tests/arcade-m10-differential.mjs', 'tests/arcade-m9-differential.mjs', 'tests/arcade-m11-differential.mjs',
  'arcade/tests/m7-runtime-perf.mjs', 'tests/arcade-m12-differential.mjs', 'arcade/tests/m10-runtime-sound.mjs', 'arcade/tests/m15-runtime-music.mjs', 'tests/arcade-m5.mjs',
  'arcade/tests/m7-runtime.mjs', 'tests/arcade-m15-differential.mjs'];

const builds = [
  'arcade/tools/build-runtime.mjs',
  'arcade/tools/build-runtime-v1.mjs',
  'arcade/tools/build-runtime-v2.mjs',
  'arcade/tools/build-runtime-v3.mjs',
  'arcade/tools/build-runtime-v4.mjs',
];
const suites = [
  'tests/arcade-parse.mjs',
  'tests/arcade-compile.mjs',
  'tests/arcade-m3.mjs',
  'tests/arcade-m4.mjs',
  'tests/arcade-m5.mjs',
  'tests/arcade-blockfall.mjs',
  'tests/arcade-starfall.mjs',
  'tests/arcade-m6-compiler.mjs',
  'tests/arcade-m6-platformer.mjs',
  'tests/arcade-runner.mjs',
  'tests/arcade-m6-differential.mjs',
  'tests/arcade-m8-compiler.mjs',
  'tests/arcade-m8-differential.mjs',
  'tests/arcade-display.mjs',
  'tests/arcade-m9-compiler.mjs',
  'tests/arcade-m9-differential.mjs',
  'tests/arcade-m10-compiler.mjs',
  'tests/arcade-m10-differential.mjs',
  'tests/arcade-m11-compiler.mjs',
  'tests/arcade-m11-differential.mjs',
  'tests/arcade-m12-compiler.mjs',
  'tests/arcade-m12-differential.mjs',
  'tests/arcade-m13-compiler.mjs',
  'tests/arcade-m13-differential.mjs',
  'tests/arcade-m14-compiler.mjs',
  'tests/arcade-m14-differential.mjs',
  'tests/arcade-m15-compiler.mjs',
  'tests/arcade-m17-compiler.mjs',
  'tests/arcade-m17-interp.mjs',
  'tests/arcade-orbit.mjs',                      // the wireframe sample game "Orbit Gates" on the reference interpreter (the runtime part is a TODO in the file)
  'tests/arcade-emitter-opt.mjs',               // compiler size pass: the emitter's F2 / F4 / F5 (sjasmplus on every example, the F4 path check)
  'tests/arcade-codegen-exhaustive.mjs',        // compiler size pass: F1 / F3 / F6 / F8 / F9 for every 16-bit value
  'tests/arcade-m15-differential.mjs',
  'arcade/tests/m1.mjs',
  'tests/arcade-m8-vaults.mjs',
  'arcade/tests/m1-overrun.mjs',
  'arcade/tests/extra-regs.mjs',
  'arcade/tests/m2-runtime.mjs',
  'arcade/tests/m2-runtime-math.mjs',
  'arcade/tests/m2-runtime-regs.mjs',
  'arcade/tests/m3-runtime.mjs',
  'arcade/tests/m3-runtime-text.mjs',
  'arcade/tests/m3-runtime-sound.mjs',
  'arcade/tests/m3-runtime-regs.mjs',
  'arcade/tests/m3-runtime-perf.mjs',
  'arcade/tests/m4-runtime.mjs',
  'arcade/tests/m4-runtime-api.mjs',
  'arcade/tests/m4-runtime-mem.mjs',
  'arcade/tests/m4-runtime-regs.mjs',
  'arcade/tests/m4-runtime-skip.mjs',
  'arcade/tests/m4-runtime-perf.mjs',
  'arcade/tests/m4-runtime-stick.mjs',
  'arcade/tests/m5-runtime.mjs',
  'arcade/tests/m5-runtime-pic.mjs',
  'arcade/tests/m5-runtime-mem.mjs',
  'arcade/tests/m5-runtime-regs.mjs',
  'arcade/tests/m5-runtime-perf.mjs',
  'arcade/tests/m6-runtime.mjs',
  'arcade/tests/m6-runtime-pic.mjs',
  'arcade/tests/m6-runtime-mem.mjs',
  'arcade/tests/m6-runtime-regs.mjs',
  'arcade/tests/m6-runtime-perf.mjs',
  'arcade/tests/m7-runtime.mjs',
  'arcade/tests/m7-runtime-api.mjs',
  'arcade/tests/m7-runtime-mem.mjs',
  'arcade/tests/m7-runtime-regs.mjs',
  'arcade/tests/m7-runtime-perf.mjs',
  'arcade/tests/m8-runtime.mjs',
  'arcade/tests/m8-runtime-api.mjs',
  'arcade/tests/m8-runtime-mem.mjs',
  'arcade/tests/m8-runtime-regs.mjs',
  'arcade/tests/m8-runtime-perf.mjs',
  'arcade/tests/m8-runtime-v3compat.mjs',
  'arcade/tests/m10-runtime-sound.mjs',
  'arcade/tests/m11-runtime-bank.mjs',
  'arcade/tests/m12-runtime-table.mjs',
  'arcade/tests/m14-runtime-mode.mjs',
  'arcade/tests/m15-runtime-music.mjs',
  'arcade/tests/m17-runtime-wire.mjs',
  'arcade/tests/m17-runtime-tick.mjs',
  ...(full ? ['arcade/tests/m3-mutations.mjs', 'arcade/tests/m4-mutations.mjs', 'arcade/tests/m5-mutations.mjs', 'arcade/tests/m6-mutations.mjs', 'arcade/tests/m7-mutations.mjs', 'arcade/tests/m8-mutations.mjs', 'arcade/tests/m9-mutations.mjs', 'arcade/tests/m10c-mutations.mjs', 'arcade/tests/m11-mutations.mjs', 'arcade/tests/m12-mutations.mjs', 'arcade/tests/m14-mutations.mjs', 'arcade/tests/m15-mutations.mjs', 'arcade/tests/m17-mutations.mjs', 'arcade/tests/m15c-mutations.mjs', 'arcade/tests/m16c-mutations.mjs'] : []),
];

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
