"use strict";
// m8-runtime-v3compat.mjs -- runtime v4 without a view (no DIV_VIEW, or a refused view_desc) must behave as v3 without a window (contract section 2,
// "Header"): runs the v3 part 1 suites (m6-runtime, m6-runtime-pic, m6-runtime-mem, m6-runtime-regs: sprites, frames, the frame cache, the cell
// map, text, tiles, the tile operations, the skip analysis, register and memory discipline) against the v4 build (ARCADE_V4=1, see m6-common.mjs).
//   node arcade/tests/m8-runtime-v3compat.mjs          (the quick forms, M6_QUICK=1)
//   node arcade/tests/m8-runtime-v3compat.mjs --full   (the full forms)
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const full = process.argv.includes('--full');
const SUITES = ['m6-runtime.mjs', 'm6-runtime-pic.mjs', 'm6-runtime-mem.mjs', 'm6-runtime-regs.mjs'];
console.log(`Runtime v4 in non-ray mode: the v3 part 1 suites${full ? '' : ' (quick forms)'} on the v4 build\n`);
let passed = 0, failed = 0;
for (const s of SUITES) {
  const env = { ...process.env, ARCADE_V4: '1', ...(full ? {} : { M6_QUICK: '1' }) };
  const r = spawnSync(process.execPath, [join(HERE, s)], { encoding: 'utf8', env, maxBuffer: 1 << 26, timeout: 3600000 });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const last = out.trim().split('\n').pop();
  const ok = r.status === 0 && /^PASS/.test(last);
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${s} on v4: ${last}`);
  if (!ok) console.log(out.split('\n').filter((l) => /FAIL|Error/.test(l)).slice(0, 8).join('\n'));
  ok ? passed++ : failed++;
}
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: runtime v4 as v3 without a window (${passed} suites passed, ${failed} failed)`);
process.exitCode = failed ? 1 : 0;
