// run-all.mjs -- rebuild every Leap Arcade runtime and run every Arcade test suite, then print one summary.
//
//   node arcade/tests/run-all.mjs            all suites except the slow mutation runs
//   node arcade/tests/run-all.mjs --full     also the mutation runs (m3- to m11-mutations; several minutes each)
//   node arcade/tests/run-all.mjs --quick    sets ARCADE_QUICK=1 (shorter fuzz runs in the compiler suites)
//
// Needs Node 20+ and sjasmplus (/usr/local/bin/sjasmplus). Exit code 1 if any step fails.
"use strict";
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const args = process.argv.slice(2);
const full = args.includes('--full');
const env = { ...process.env, ...(args.includes('--quick') ? { ARCADE_QUICK: '1' } : {}) };

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
  'tests/arcade-m6-compiler.mjs',
  'tests/arcade-m6-platformer.mjs',
  'tests/arcade-runner.mjs',
  'tests/arcade-m6-differential.mjs',
  'tests/arcade-m8-compiler.mjs',
  'tests/arcade-m8-differential.mjs',
  'tests/arcade-display.mjs',
  'tests/arcade-m9-compiler.mjs',
  'tests/arcade-m9-differential.mjs',
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
  ...(full ? ['arcade/tests/m3-mutations.mjs', 'arcade/tests/m4-mutations.mjs', 'arcade/tests/m5-mutations.mjs', 'arcade/tests/m6-mutations.mjs', 'arcade/tests/m7-mutations.mjs', 'arcade/tests/m8-mutations.mjs', 'arcade/tests/m9-mutations.mjs', 'arcade/tests/m10-mutations.mjs', 'arcade/tests/m10c-mutations.mjs', 'arcade/tests/m11-mutations.mjs'] : []),
];

function run(file, isBuild) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(ROOT, file)], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 1 << 28, timeout: 3600_000 });
  const out = (r.stdout || '') + (r.stderr || '');
  const lines = out.trim().split('\n');
  const last = lines[lines.length - 1] || '(no output)';
  return { file, ok: r.status === 0, last, secs: ((Date.now() - t0) / 1000).toFixed(1), out, isBuild };
}

const results = [];
for (const f of builds) results.push(run(f, true));
if (results.some((r) => !r.ok)) {
  for (const r of results.filter((x) => !x.ok)) console.log(`BUILD FAILED: ${r.file}\n${r.out.split('\n').slice(-15).join('\n')}`);
  process.exit(1);
}
for (const f of suites) {
  const r = run(f, false);
  results.push(r);
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.file.padEnd(40)} ${r.secs.padStart(6)} s  ${r.last}`);
  if (!r.ok) console.log(r.out.split('\n').filter((l) => /FAIL|Error|error/.test(l)).slice(0, 12).join('\n'));
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} steps passed${failed.length ? '; FAILED: ' + failed.map((r) => r.file).join(', ') : ''}`);
process.exit(failed.length ? 1 : 0);
