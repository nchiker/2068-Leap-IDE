#!/usr/bin/env node
"use strict";
// arcade-sc-perf.mjs -- sprite colour (SC) step 7: what sprite ink costs a tick, and the perf reference of an ink game.
// Starfall (classic, arcade/examples/shooter-classic.arc) on the ink build of runtime v2 (arcade/build/v2ink), recorded script of tests/arcade-starfall-script.mjs (1,340 ticks):
//   plain   the game as shipped (no spriteColour: the ink build's code is inert, RT_SPRITEINK is never called)
//   ink     the same with spriteColour 'ink' on the play scene (the assets file's top-level "scenes", set here; the sample's sources are not changed)
// Whole-tick T-states with the frame interrupt's time included, as tests/arcade-codegen-perf.mjs counts them (the first 2 ticks, which draw the map into both files, are left out); budget 3 refreshes.
// Checks (always): both runs complete the script; a plain game costs about the same on the ink build as on the default v2 build (a small bound, measured); ink never costs
// less than plain on a tick (beyond clock noise); the ink overhead per tick is bounded (and printed); ticks over the 3-refresh budget with ink are a subset of the plain run's.
// Reference (arcade/spike/sc/perf-reference.json, the format of arcade/spike/codegen/perf-reference.json): checked by default against the codegen-perf bounds
// (median not higher; 95th percentile and worst rise by at most 0.25 % of the budget; no new tick over the budget; same tick count); --save writes it.
//   node tests/arcade-sc-perf.mjs [--save]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { keysOf, stickOf, FULL_TICKS } from './arcade-starfall-script.mjs';
import { real, compileReal, runReal, ROOT } from './arcade-m5-harness.mjs';

const FRAME = 58688, BUDGET_REFRESHES = 3, BUDGET = BUDGET_REFRESHES * FRAME;
const REF = join(ROOT, 'arcade/spike/sc/perf-reference.json');
const SAVE = process.argv.slice(2).includes('--save');

let total = 0, failed = 0;
function check(name, ok, detail = '') { total++; console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`); if (!ok) failed++; }
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const pct = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(s.length * p))]; };

const SRC = readFileSync(join(ROOT, 'arcade/examples/shooter-classic.arc'), 'utf8');
const A0 = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/shooter-classic.assets.json'), 'utf8'));
// the sample now carries spriteColour 'ink' on its play scene (stage 6B): the plain runs take the assets without it
const { scenes: sampleScenes, ...A } = A0;
const inkAssets = { ...A, scenes: { ...(sampleScenes ?? {}), play: { spriteColour: 'ink' } } };

const dirInk = join(ROOT, 'arcade/build/v2ink');
if (!existsSync(join(dirInk, 'runtime.json'))) { console.log('FAIL  arcade/build/v2ink is not built (node arcade/tools/build-runtime-v2ink.mjs)'); process.exit(1); }
const rtI = JSON.parse(readFileSync(join(dirInk, 'runtime.json'), 'utf8'));
const RI = { rt: rtI, img: new Uint8Array(readFileSync(join(dirInk, 'runtime.bin'))), SYM: rtI.symbols, ok: true };
const RD = real(2);

function measure(label, assets, R) {
  const res = compileReal(SRC, assets, { R });
  const got = runReal(res, { ticks: FULL_TICKS, keys: keysOf, stick: stickOf, measure: true, R });
  if (got.error) throw new Error(`${label}: ${got.error}`);
  return { costs: got.costs.slice(2), res };
}
const stats = (run, costs) => {
  const worst = costs.reduce((a, t, i) => (t > costs[a] ? i : a), 0);
  return { game: 'starfall-classic', run, runtime: 'v2ink', budget: BUDGET, n: costs.length, median: pct(costs, 0.5), p95: pct(costs, 0.95), worst: costs[worst], worstTick: worst + 3,
    mean: costs.reduce((s, v) => s + v, 0) / costs.length, over: costs.map((t, i) => (t > BUDGET ? i + 3 : -1)).filter((k) => k >= 0), procFrameMean: null, ticks: costs.map((t, i) => [i + 3, t]) };
};

const t0 = Date.now();
const plainD = measure('plain on the default v2 build', A, RD);
const plainI = measure('plain on the ink build', A, RI);
const ink = measure('ink on the ink build', inkAssets, RI);
console.log(`measured in ${((Date.now() - t0) / 1000).toFixed(0)} s: ${plainI.costs.length} ticks each\n`);

check('the ink build compiles Starfall with spriteColour ink: the ink tables are in the game (more code than the plain one)', ink.res.gen.code.length > plainI.res.gen.code.length, `${ink.res.gen.code.length} vs ${plainI.res.gen.code.length}`);
check('the plain game has the same code length and tick divisor on the ink build as on the default build (the runtime addresses move, the program does not: tools/regen-baselines.mjs --build v2ink)', plainI.res.gen.code.length === plainD.res.gen.code.length && plainI.res.memory[0x8004] === plainD.res.memory[0x8004]);

const sP = stats('plain', plainI.costs), sI = stats('ink', ink.costs);
const delta = ink.costs.map((t, i) => t - plainI.costs[i]);
const dBuild = plainI.costs.map((t, i) => t - plainD.costs[i]);
const dMed = pct(delta, 0.5), dMax = Math.max(...delta), dMin = Math.min(...delta), dMean = delta.reduce((s, v) => s + v, 0) / delta.length;
console.log('whole-tick T-states, interrupt included, budget 3 refreshes = ' + fmt(BUDGET));
for (const [n, s] of [['plain (ink build)', sP], ['ink (ink build)', sI]]) console.log(`  ${n.padEnd(18)} median ${fmt(s.median)}  95th ${fmt(s.p95)}  worst ${fmt(s.worst)} (tick ${s.worstTick})  mean ${fmt(s.mean)}  over budget ${s.over.length}`);
console.log(`  ink minus plain: min ${fmt(dMin)}  median ${fmt(dMed)}  mean ${fmt(dMean)}  max ${fmt(dMax)} T per tick;  ink build minus default build (both plain): min ${fmt(Math.min(...dBuild))}, max ${fmt(Math.max(...dBuild))} T\n`);

check(`all three runs completed the script (${FULL_TICKS - 2} measured ticks each)`, plainI.costs.length === FULL_TICKS - 2 && ink.costs.length === FULL_TICKS - 2 && plainD.costs.length === FULL_TICKS - 2);
check('a plain game on the ink build costs at most 4,000 T more, or 2,000 T less, than on the default build on any tick (the inert checks in the sprite loop)', Math.max(...dBuild) <= 4000 && Math.min(...dBuild) >= -2000, `${fmt(Math.min(...dBuild))}..${fmt(Math.max(...dBuild))}`);
check('ink costs no tick less than the plain game minus 2,000 T of clock noise (a tick can end in another refresh; ink only adds work)', dMin >= -2000, fmt(dMin));
check('ink overhead: median at most 12,000 T and no tick more than 26,000 T over plain (measured: median 9,984, max 22,229)', dMed <= 12000 && dMax <= 26000, `median ${fmt(dMed)}, max ${fmt(dMax)}`);
const newOver = sI.over.filter((k) => !sP.over.includes(k));
check('ticks over the 3-refresh budget with ink: none that the plain game keeps within it', newOver.length === 0, `tick(s) ${newOver.join(', ')}`);

if (SAVE) {
  mkdirSync(join(ROOT, 'arcade/spike/sc'), { recursive: true });
  writeFileSync(REF, JSON.stringify({ tool: 'tests/arcade-sc-perf.mjs', compiler: 'working tree', frameT: FRAME, runs: [sP, sI] }) + '\n');
  console.log(`\nsaved 2 runs to ${REF}`);
} else if (!existsSync(REF)) {
  check('the reference arcade/spike/sc/perf-reference.json exists (--save writes it)', false);
} else {
  const before = JSON.parse(readFileSync(REF, 'utf8'));
  const tol = Math.floor(BUDGET * 0.0025);
  for (const a of [sP, sI]) {
    const b = before.runs.find((x) => x.run === a.run);
    if (!b) { check(`the reference has run ${a.run}`, false); continue; }
    const why = [];
    if (a.n !== b.n || a.budget !== b.budget) why.push(`not the same run (${b.n} ticks before, ${a.n} now)`);
    if (a.median > b.median) why.push(`median ${fmt(b.median)} -> ${fmt(a.median)}`);
    if (a.p95 - b.p95 > tol) why.push(`95th ${fmt(b.p95)} -> ${fmt(a.p95)} (> +${fmt(tol)})`);
    if (a.worst - b.worst > tol) why.push(`worst ${fmt(b.worst)} -> ${fmt(a.worst)} (> +${fmt(tol)})`);
    const nw = a.over.filter((k) => !b.over.includes(k));
    if (nw.length) why.push(`new tick(s) over the budget: ${nw.join(', ')}`);
    check(`${a.run}: no breach of the reference (median ${fmt(b.median)} -> ${fmt(a.median)}, 95th ${fmt(b.p95)} -> ${fmt(a.p95)}, worst ${fmt(b.worst)} -> ${fmt(a.worst)})`, why.length === 0, why.join('; '));
  }
}
console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-sc-perf (${total - failed}/${total})`);
process.exit(failed ? 1 : 0);
