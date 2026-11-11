#!/usr/bin/env node
"use strict";
// arcade-runner.mjs -- slice B5 of the banked cartridge map (docs/ARCADE_BANKING_CONTRACT.md section 10): arcade/examples/runner.arc, "Leap Runner" with four levels, a game that does not
// fit the 16 KB of the game area unless its three extra worlds are banked.
//
//   node tests/arcade-runner.mjs                  (ARCADE_QUICK=1: the real-runtime runs stop a few ticks after the first level change)
//   node tests/arcade-runner.mjs --record         search a play-through of each level on the reference interpreter (four processes, minutes), chain them, and write arcade/examples/runner.script.json
//   node tests/arcade-runner.mjs --record-level N (one level, writes arcade/examples/runner.script.<N>.json; --record does this four times and then chains)
//   node tests/arcade-runner.mjs --chain          (only the chaining of the four runner.script.<N>.json files into runner.script.json)
//
// Sections
//   1  the level data: runner.assets.json is what runner.assets.gen.mjs makes, the DIM lines of runner.arc are what it prints, every level is 128 x 16 with the start, the flag, the coins and the
//      walkers' turning points that the arrays claim (the turning points worked out again here by a second, separate rule)
//   2  the build: the game compiles with its four worlds banked (usage.mapped within 16,384, usage.banked the four MAPs) and does NOT build with every map forced `mapped` (the does-not-fit error)
//   3  the play-through on the reference interpreter (arcade/examples/runner.script.json: the title, level 1 to its flag, "LEVEL 2", level 2, ... the win screen): each level is entered in turn,
//      each coin / enemy table is read, the game ends at state 2; and game over, retry of the same level with three lives (a variant with one life), on the interpreter
//   4  the REAL runtime on a stock TS2068 in TSRun (arcade/build/v3, which must hold RT_WORLDLOAD): the same play-throughs tick by tick against the interpreter (variables, arrays, SPR_TAB, WORLD_RAM,
//      the camera), through every level change (each loads a banked world through the window)
//   5  the picture: the build as the linker places it and the build with every map, world and plan banked (bankAll) are equal tick by tick in state AND in RAM $4000-$7FFF (both display files and the
//      window tables) over the same play-through
//   6  negative control: a changed byte in a banked world (level3) is seen by the comparison of section 4
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { diffV3 } from './arcade-m6-common.mjs';
import { LEVELS, COLS, ROWS, tables, dataLines, buildRunnerAssets } from '../arcade/examples/runner.assets.gen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const EX = join(ROOT, 'arcade/examples');
const SELF = fileURLToPath(import.meta.url);
const QUICK = !!process.env.ARCADE_QUICK;
const SRC = readFileSync(join(EX, 'runner.arc'), 'utf8');
const ASSETS_TEXT = readFileSync(join(EX, 'runner.assets.json'), 'utf8');
const ASSETS = JSON.parse(ASSETS_TEXT);
const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;

// ── the level starts: the one place the source is changed for a test (a variant of GSTAGE 0, "lv = 0", and of the lives) ─────────────────────────────────────
const START_MARK = 'score = 0 : lives = 3 : hud = 0 : lv = 0';
const variant = ({ level = 0, lives = 3 } = {}) => { if (!SRC.includes(START_MARK)) throw new Error('runner.arc lost the GSTAGE 0 line the tests vary'); return SRC.replace(START_MARK, `score = 0 : lives = ${lives} : hud = 0 : lv = ${level}`); };
const RIGHT = 8, FIRE = 16, UP = 1, LEFT = 4;
const TITLE = [...new Array(13).fill(0), FIRE, ...new Array(6).fill(0)];          // the title: 7 stages a tick, fire on tick 14 (a fresh edge), the game starts in about 7 ticks
const rle = (a) => { const o = []; for (const v of a) { if (o.length && o.at(-1)[0] === v) o.at(-1)[1]++; else o.push([v, 1]); } return o; };
const unrle = (r) => { const a = []; for (const [v, n] of r) for (let i = 0; i < n; i++) a.push(v); return a; };

const astOf = new Map();
const astFor = (src) => { if (!astOf.has(src)) astOf.set(src, parse(src).ast); return astOf.get(src); };
/** the interpreter's records for a stick script (index t-1 = FRAME call t) */
const playInterp = (src, ticks, stickFn) => interpret(astFor(src), { version: 3, ticks, assets: ASSETS, stick: stickFn, maxSteps: 4_000_000_000 });

// =================================================================================================================
// --record: a greedy search over macro actions on the reference interpreter (the method of tests/arcade-m6-platformer-bot.mjs), one level at a time
// =================================================================================================================
const CANDS = (() => {
  const c = [];
  for (const k of [1, 2, 4, 8]) c.push({ name: `run ${k}`, fn: () => RIGHT, stop: k });
  for (const k of [2, 3, 6, 10]) c.push({ name: `idle ${k}`, fn: () => 0, stop: k });
  for (const k of [3, 6]) c.push({ name: `left ${k}`, fn: () => LEFT, stop: k });
  for (const h of [2, 3, 4, 5, 6, 8, 10, 12, 16]) for (const pre of [0, 1, 2, 3, 4, 6]) c.push({ name: `wait ${pre} jump ${h}`, fn: (i) => (i <= pre ? RIGHT : i <= pre + h ? RIGHT | UP : RIGHT), jump: true });
  for (const h of [4, 8, 12, 16]) for (const rel of [3, 6, 9]) c.push({ name: `hop ${h} rel ${rel}`, fn: (i) => (i <= h ? UP : 0) | (i <= rel ? RIGHT : 0), jump: true });
  for (const h of [4, 8, 12]) c.push({ name: `hop-left ${h}`, fn: (i) => (i <= h ? UP | LEFT : LEFT), jump: true });
  return c;
})();
const isDone = (v) => v.ST === 4 || v.ST === 2;                         // the flag: the level-change state, or the win screen after the fourth level
const scoreOf = (v, start) => v.PX * 4 + v.COINS * 6 + (v.SCORE - start.SCORE) / 40 - 20000 * (start.LIVES - v.LIVES) + (isDone(v) ? 1e6 : 0) - (v.ST === 3 ? 1e6 : 0);

function searchLevel(level, { width = 6, log = () => {} } = {}) {
  const ast = astFor(variant({ level }));
  const run = (script, ticks, tail) => interpret(ast, { version: 3, ticks, assets: ASSETS, stick: (t) => (t <= script.length ? script[t - 1] : tail ? tail(t - script.length) : 0), maxSteps: 4_000_000_000 }).ticks;
  const expand = (script, sv) => {
    const n = script.length, out = [];
    for (const c of CANDS) {
      const horizon = c.jump ? 50 : c.stop;
      const r = run(script, n + horizon, (i) => c.fn(i));
      let end = c.jump ? -1 : c.stop - 1, took = false;
      if (c.jump) {
        for (let i = 0; i < horizon; i++) {
          const v = r[n + i].vars;
          if (v.GND === 0) took = true;
          if (v.ST !== 1 || v.LIVES !== sv.LIVES) { end = i; break; }
          if (took && v.GND === 1) { end = i; break; }
        }
        if (end < 0 || !took) continue;
      }
      const ext = []; for (let i = 0; i <= end; i++) ext.push(c.fn(i + 1));
      out.push({ c, end, vars: r[n + end].vars, ext, sc: scoreOf(r[n + end].vars, sv) - (end + 1) * 0.5 });
    }
    return out;
  };
  let script = TITLE.slice();
  const first = run(script, 60).findIndex((x) => x.vars.ST === 1);
  if (first < 0) throw new Error(`level ${level + 1}: the game did not start`);
  const p0 = first + 1;                                                  // the record after tick p0 is the first with the game playing
  while (script.length < p0) script.push(0);
  let last = run(script, script.length).at(-1).vars;
  // depth-first over macros with a little backtracking: when the best macro of a state loses a life (the greedy choice walked into something), the macro that led here is banned at its
  // state and the state before it is searched again (a hero that is hit or falls back to a checkpoint is a route that needs another approach, not a route)
  const stack = [];                                                      // {len, vars, banned: Set of names}
  let guard = 0, back = 0;
  while (script.length < 2600 && last.ST === 1 && guard++ < 1500) {
    const top = stack.at(-1) && stack.at(-1).len === script.length ? stack.at(-1) : null;
    const entry = top ?? { len: script.length, vars: last, banned: new Set() };
    if (!top) stack.push(entry);
    const firsts = expand(script, last).filter((f) => !entry.banned.has(f.c.name)).sort((a, b) => b.sc - a.sc).slice(0, width);
    let best = null;
    for (const f of firsts) {
      let sc = f.sc;
      if (f.vars.ST === 1) { const second = expand(script.concat(f.ext), f.vars); if (second.length) sc = f.sc + second.reduce((a, x) => Math.max(a, x.sc), -Infinity); }
      if (!best || sc > best.sc2) best = { ...f, sc2: sc };
    }
    if (!best || (best.vars.LIVES < last.LIVES && back < 40)) {       // dead end or a lost life: go back one macro (to the state it started from) and ban it there
      stack.pop();
      const prev = stack.at(-1);
      if (!prev) { if (!best) throw new Error(`level ${level + 1}: no candidate at tick ${script.length}`); }
      else { back++; prev.banned.add(prev.chosen); script = script.slice(0, prev.len); last = prev.vars; log(`level ${level + 1}: backtrack to tick ${prev.len}, banning ${prev.chosen}`); continue; }
    }
    entry.chosen = best.c.name;
    script = script.concat(best.ext); last = best.vars;
    log(`level ${level + 1} tick ${script.length}: ${best.c.name} -> px ${last.PX} lives ${last.LIVES} coins ${last.COINS} st ${last.ST}`);
  }
  if (!isDone(last)) throw new Error(`level ${level + 1}: the search did not reach the flag (st ${last.ST}, px ${last.PX}, tick ${script.length})`);
  return { level, p0, runs: rle(script.slice(p0)), lives: last.LIVES, ticks: script.length };
}

/** the whole game from the title: each level's segment is played from the tick at which that level begins (everything a level's play depends on is reset when it begins) */
function chainLevels(segs, src) {
  let script = TITLE.slice();
  for (let i = 0; i < segs.length; i++) {
    let p = -1;
    const r = playInterp(src, script.length + 120, (t) => script[t - 1] ?? 0).ticks;
    for (let k = script.length; k < r.length; k++) if (r[k].vars.ST === 1 && r[k].vars.LV === i) { p = k + 1; break; }
    if (p < 0) { for (let k = 0; k < r.length; k++) if (r[k].vars.ST === 1 && r[k].vars.LV === i) { p = k + 1; break; } }
    if (p < 0) throw new Error(`level ${i + 1} never began while chaining`);
    script = script.slice(0, Math.max(p, script.length)); while (script.length < p) script.push(0);
    script = script.concat(unrle(segs[i].runs));
  }
  return script;
}

const arg = (k) => process.argv.indexOf(k);
if (arg('--record-level') > 0) {
  const level = Number(process.argv[arg('--record-level') + 1]);
  const r = searchLevel(level, { log: (s) => process.stderr.write(s + '\n') });
  writeFileSync(join(EX, `runner.script.${level}.json`), JSON.stringify(r) + '\n');
  console.log(`level ${level + 1}: ${r.ticks} ticks, ${r.lives} lives left, written to arcade/examples/runner.script.${level}.json`);
  process.exit(0);
}
if (arg('--record') > 0 || arg('--chain') > 0) {
  const kids = arg('--chain') > 0 ? [] : [0, 1, 2, 3].map((l) => new Promise((res, rej) => { const p = spawn(process.execPath, [SELF, '--record-level', String(l)], { stdio: ['ignore', 'inherit', 'ignore'] }); p.on('exit', (c) => (c === 0 ? res() : rej(new Error(`level ${l + 1} search failed`)))); }));
  await Promise.all(kids);
  const segs = [0, 1, 2, 3].map((l) => JSON.parse(readFileSync(join(EX, `runner.script.${l}.json`), 'utf8')));
  // the production game (three lives) when the levels' routes lose no more than two lives in all; else a variant of the source with more lives (the route still enters every level and wins)
  let lives = 3, script;
  try { script = chainLevels(segs, SRC); } catch (e) { lives = 9; script = chainLevels(segs, variant({ lives })); }
  const r = playInterp(lives === 3 ? SRC : variant({ lives }), script.length, (t) => script[t - 1] ?? 0).ticks;
  const final = r.at(-1).vars;
  console.log(`chained: ${script.length} ticks, ${lives} lives at the start, final ST ${final.ST} LV ${final.LV} lives ${final.LIVES} score ${final.SCORE}`);
  writeFileSync(join(EX, 'runner.script.json'), JSON.stringify({
    comment: 'GENERATED by tests/arcade-runner.mjs --record: the stick values (joystick 1: 1 up, 4 left, 8 right, 16 fire) of a play-through of arcade/examples/runner.arc from the title through the four levels to the win screen, run-length coded [value, ticks]. Do not edit by hand.',
    lives, levels: segs.map((s) => ({ level: s.level + 1, searchTicks: s.ticks, livesLeft: s.lives })), ticks: script.length, runs: rle(script) }) + '\n');
  console.log('wrote arcade/examples/runner.script.json');
  process.exit(0);
}

// =================================================================================================================
let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const skip_ = (name, why) => { console.log(`  SKIP  ${name}  (${why})`); skipped++; };
const info = (s) => console.log('  INFO  ' + s);
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');

// =================================================================================================================
console.log('1. The level data');
// =================================================================================================================
{
  check_('runner.assets.json is what runner.assets.gen.mjs makes', ASSETS_TEXT === JSON.stringify(buildRunnerAssets(), null, 1) + '\n');
  const a = SRC.indexOf('  REM @@DATA-BEGIN@@\n') + '  REM @@DATA-BEGIN@@\n'.length, b = SRC.indexOf('  REM @@DATA-END@@');
  check_('the level data of runner.arc is what runner.assets.gen.mjs --data prints', a > 30 && b > a && SRC.slice(a, b) === dataLines());
  const maps = ['pf_world', 'rn_world2', 'rn_world3', 'rn_world4'];
  const flags = ASSETS.tilesets.pf_tiles.tiles.map((t) => t.flags);
  const T = tables();
  const arrays = {};
  for (const m of SRC.slice(a, b).matchAll(/DIM (\w+)\((\d+)\) = ([-\d, ]+)/g)) arrays[m[1]] = m[3].split(',').map(Number);
  LEVELS.forEach((L, i) => {
    const m = ASSETS.maps[maps[i]], cell = (c, r) => m.cells[r * COLS + c];
    const ok = m.w === COLS && m.h === ROWS && m.cells.length === COLS * ROWS;
    check_(`level ${i + 1}: the world ${maps[i]} is 128 x 16`, ok);
    const startGround = [0, 1, 2, 3, 4].every((c) => cell(c, 14) === 1 && [11, 12, 13].every((r) => !(flags[cell(c, r)] & 3)));
    check_(`level ${i + 1}: ground at columns 0-4 and nothing solid above them (the start at x 24, y 88)`, startGround);
    const flag = cell(122, 8) === 8 && [9, 10, 11, 12, 13].every((r) => cell(122, r) === 7) && cell(122, 14) === 1;
    check_(`level ${i + 1}: the flag (tile 8 over the pole, tile 7, rows 8-13) stands on ground at column 122`, flag);
    // coins: exactly the coin tiles of the map, in the order of the list
    const coins = []; for (let c = 0; c < COLS; c++) for (let r = 5; r < ROWS; r++) if (cell(c, r) === 6) coins.push([c * 8, r * 8]);
    const lo = arrays.lcb[i], hi = arrays.lcb[i + 1];
    const listed = []; for (let k = lo; k < hi; k++) listed.push([arrays.cxs[k], arrays.cys[k]]);
    check_(`level ${i + 1}: the ${listed.length} coins of the list are the coin tiles of the map (sorted by x)`, JSON.stringify(coins.sort((p, q) => p[0] - q[0] || p[1] - q[1])) === JSON.stringify(listed));
    // enemies: sorted by x; a walker stands on a solid top (16 px above it), a bat has no turning points
    const sl = arrays.lsb[i], sh = arrays.lsb[i + 1];
    let sorted = true, standing = true, bats = 0;
    for (let k = sl; k < sh; k++) {
      if (k > sl && arrays.sx[k] < arrays.sx[k - 1]) sorted = false;
      if (arrays.whi[k] === 0) { bats++; if (arrays.wlo[k] !== 0) standing = false; } else {
        const c = arrays.sx[k] >> 3, r = (arrays.sy[k] + 16) >> 3;
        if ((flags[cell(c, r)] & 1) === 0 || (flags[cell(c, r - 1)] & 1) !== 0) standing = false;
      }
    }
    check_(`level ${i + 1}: ${sh - sl} enemies (${sh - sl - bats} walkers on solid ground, ${bats} bats), sorted by x`, sorted && standing && sh - sl >= 8);
    // the walkers' turning points again, by a second rule: step 8 px; stop where a probe 1 px in front of the box is solid at the body, or where no floor (solid or one-way) is 1 px under the next cell
    const fl = (x, y) => (x < 0 || x >= COLS * 8 ? 1 : y < 0 ? 1 : y >= 128 ? 0 : flags[cell(x >> 3, y >> 3)]);
    let bad = 0;
    for (let k = sl; k < sh; k++) {
      if (arrays.whi[k] === 0) continue;
      const walk = (dir) => { let x = arrays.sx[k]; const y = arrays.sy[k]; for (let n = 0; n < 200; n++) { const px = dir > 0 ? x + 16 : x - 1; if ((fl(px, y + 4) & 1) || (fl(px, y + 11) & 1) || !(fl(px, y + 16) & 9)) return x; x += 8 * dir; } return null; };
      if (walk(-1) !== arrays.wlo[k] || walk(1) !== arrays.whi[k]) bad++;
    }
    check_(`level ${i + 1}: the turning points (WLO / WHI) of the walkers agree with a second computation from the map`, bad === 0);
    // the checkpoints: three, on ground, at the hero's standing height, and no hazard under the hero's box there
    const cps = [0, 1, 2].map((j) => [arrays.ckx[i * 3 + j], arrays.cky[i * 3 + j]]);
    const okc = cps.every(([x, y]) => { const c0 = (x + 3) >> 3, c1 = (x + 12) >> 3, g = (y + 24) >> 3; return [c0, c1].every((c) => flags[cell(c, g)] & 1) && [c0, c1].every((c) => [y >> 3, (y >> 3) + 1, (y >> 3) + 2].every((r) => !(flags[cell(c, r)] & 3))); }) && cps[0][0] < cps[1][0] && cps[1][0] < cps[2][0];
    check_(`level ${i + 1}: three checkpoints in order, on solid ground, clear of walls and spikes`, okc);
    check_(`level ${i + 1}: the respawn tables (RCF / RNX) and the coin index (CIX) follow the lists`, JSON.stringify([arrays.rcf.slice(i * 4, i * 4 + 4), arrays.rnx.slice(i * 4, i * 4 + 4), arrays.cix.slice(i * 9, i * 9 + 9)]) === JSON.stringify([T.rcf.slice(i * 4, i * 4 + 4), T.rnx.slice(i * 4, i * 4 + 4), T.cix.slice(i * 9, i * 9 + 9)]));
  });
  info(`coins per level ${LEVELS.map((L) => L.coins.length).join(' / ')}, enemies per level ${LEVELS.map((L) => L.spawns.length).join(' / ')}`);
}

// =================================================================================================================
console.log('\n2. The build: it needs the banked cartridge map');
// =================================================================================================================
function loadRuntime(v) {
  const json = join(ROOT, `arcade/build/v${v}/runtime.json`);
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))), v };
}
const R3 = loadRuntime(3);
const bankNeeds = R3 ? ['RT_LOADMAPPTR', 'RT_WORLDLOAD'].filter((n) => R3.rt.symbols[n] === undefined && R3.rt.constants?.[n] === undefined) : ['everything'];
let normal = null;
if (!R3 || bankNeeds.length) skip_('the banked build', !R3 ? 'arcade/build/v3/runtime.json is missing' : `arcade/build/v3/runtime.json lacks ${bankNeeds.join(' ')} (slice B1 not built)`);
else {
  normal = compile(SRC, { runtime: R3.rt, image: R3.img, assets: ASSETS });
  check_('the game compiles against runtime v3 with no errors and no warnings', normal.errors.length === 0 && normal.warnings.length === 0, errText(normal));
  const u = normal.usage;
  check_(`usage.mapped ${u.mapped.used} of ${u.mapped.available} bytes (fits)`, u.mapped.used <= u.mapped.available);
  const names = u.banked.assets.map((x) => x.name).sort().join(',');
  check_(`usage.banked: the four worlds (${names}), ${u.banked.used} bytes, in the window`, names === 'level,level2,level3,level4' && u.banked.assets.every((x) => x.kind === 'world'));
  check_(`the cartridge ships chunks ${normal.shipped.join(' ')} (0 1 runtime, 2 the banked worlds, 4 5 the mapped part)`, JSON.stringify(normal.shipped) === '[0,1,2,4,5]');
  const forced = JSON.parse(ASSETS_TEXT); for (const k of Object.keys(forced.maps)) forced.maps[k].bank = 'mapped';
  const f = compile(SRC, { runtime: R3.rt, image: R3.img, assets: forced });
  check_(`with every map forced mapped the build fails: ${f.errors.length ? f.errors[0].message : 'it compiled'}`, f.errors.length > 0 && f.errors.every((e) => /does not fit/.test(e.message)));
  const m2 = f.errors.length ? (f.errors[0].message.match(/\(([\d,]+) of 16,384/) ?? [])[1] : null;
  info(`all four worlds mapped would need ${m2 ?? '?'} of 16,384 bytes; banked, the mapped part is ${u.mapped.used} (${u.mapped.available - u.mapped.used} bytes to spare)`);
}

// =================================================================================================================
// the real runtime
// =================================================================================================================
const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
const M_ = await import(pathToFileURL(join(ROOT, 'tsrun/machine.js')).href);

/** Boot the cartridge (DCK as built: chunk 2 with the banked worlds too) on a stock TS2068 and sample at every entry of PROC FRAME (sample k = the state after tick k - 1; sample 0 after INIT). */
function runFramed(R, res, { ticks, stick }) {
  const SYM = { ...R.rt.symbols, ...(R.rt.constants ?? {}) };
  const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  const must = (e) => { if (e) throw new Error(e); };
  const ROMDIR = join(ROOT, 'tsrun/roms');
  must(M_.setHomeRom(m, readFileSync(join(ROMDIR, 'ts2068-0.rom'))));
  must(M_.setExRom(m, readFileSync(join(ROMDIR, 'ts2068-1.rom'))));
  must(M_.insertDock(m, res.dck));
  M_.resetMachine(m);
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const ent = SYM.SPR_ENT ?? 6, hasFrame = ent >= 8;
  const nInst = Math.max(res.gen.v2 ? res.gen.v2.ninst : 4, 4);
  const snap = (picture) => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    arrays: Object.fromEntries(Object.entries(res.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))])),
    sprites: Array.from({ length: nInst }, (_, i) => { const e = SYM.SPR_TAB + ent * i; return hasFrame ? { visible: m.ram[e], asset: m.ram[e + 1], x: s16(rd16(e + 2)), y: s16(rd16(e + 4)), frame: m.ram[e + 6] } : { visible: m.ram[e], x: rd16(e + 2), y: rd16(e + 4) }; }),
    worldRam: m.ram.slice(SYM.WORLD_RAM, SYM.WORLD_RAM + 2048), cam: rd16(SYM.V_CAM),
    cells: m.ram.slice(SYM.CELL_TILE, SYM.CELL_TILE + 768), attrs: m.ram.slice(SYM.CELL_ATTR, SYM.CELL_ATTR + 768),
    ram4000: picture ? m.ram.slice(0x4000, 0x8000) : null,
    f4: SYM.V_SHADOW_F4 !== undefined ? m.ram[SYM.V_SHADOW_F4] : null,
  });
  const out = { snaps: [], error: null };
  for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
  const fe = res.map.entries.frame;
  const setInput = (k) => { m.joystick[0] = contact(stick ? stick(k) : 0); m.joystick[1] = contact(0); for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F; };
  setInput(1);
  const origRead = m.bus.read;
  m.bus.read = function (a) {
    if (a === fe && out.snaps.length < ticks + 1 && m.cpu.pc === fe) { out.snaps.push(snap(R.picture)); setInput(out.snaps.length); }
    return origRead.call(this, a);
  };
  const div = res.memory[0x8004] & 0x3F;
  const maxFrames = 400 + (ticks + 3) * Math.max(div, 14) * 6;
  for (let f = 0; f < maxFrames && out.snaps.length < ticks + 1; f++) M_.runFrame(m);
  if (out.snaps.length < ticks + 1) out.error = `only ${out.snaps.length} of ${ticks + 1} samples`;
  return out;
}

const sameBuf = (x, y) => !!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]);
/** machine against interpreter at every tick: the first difference, or null */
function vsInterp(got, want, ticks) {
  for (let t = 0; t <= ticks; t++) {
    const d = diffV3(got.snaps[t], t === 0 ? want.init : want.ticks[t - 1], t === 0 ? 'after INIT' : `after tick ${t}`);
    if (d) return d;
  }
  return null;
}

// the recorded play-through
const SCRIPT_FILE = join(EX, 'runner.script.json');
let script = null, scriptInfo = null;
if (existsSync(SCRIPT_FILE)) { scriptInfo = JSON.parse(readFileSync(SCRIPT_FILE, 'utf8')); script = unrle(scriptInfo.runs); }
const PLAY_SRC = scriptInfo && scriptInfo.lives !== 3 ? variant({ lives: scriptInfo.lives }) : SRC;       // the game as it is, unless the recorded route needs more than its three lives
const stickOf = (arr) => (t) => arr[t - 1] ?? 0;

// =================================================================================================================
console.log('\n3. The play-through on the reference interpreter');
// =================================================================================================================
let full = null;
if (!script) skip_('the recorded play-through', 'arcade/examples/runner.script.json is missing: node tests/arcade-runner.mjs --record');
else {
  const t0 = Date.now();
  full = playInterp(PLAY_SRC, script.length, stickOf(script));
  const recs = full.ticks.map((x) => x.vars);
  const lvAt = [0, 1, 2, 3].map((l) => recs.findIndex((v) => v.ST === 1 && v.LV === l) + 1);
  check_(`the game starts from the title and each level is entered in turn (first playing tick of level 1 to 4: ${lvAt.join(', ')})`, lvAt.every((x, i) => x > 0 && (i === 0 || x > lvAt[i - 1])));
  const msgs = [1, 2, 3].map((l) => recs.findIndex((v, k) => v.ST === 4 && v.NL === l && (k === 0 || recs[k - 1].ST === 1)) + 1);
  check_(`the flag of level 1, 2 and 3 starts the level change (state 4 at ticks ${msgs.join(', ')}), the world of the next level is loaded 39 ticks later`, msgs.every((x, i) => x > 0 && lvAt[i + 1] - x >= 36 && lvAt[i + 1] - x <= 44));
  const fin = recs.at(-1);
  check_(`the game ends at the win screen (ST ${fin.ST}, LV ${fin.LV}, score ${fin.SCORE}, lives ${fin.LIVES}; ${script.length} ticks)`, fin.ST === 2 && fin.LV === 3);
  // the world is the right one: WORLD_RAM of the interpreter at the start of each level holds that level's map
  let worldsOk = true;
  for (let l = 0; l < 4; l++) { const w = full.ticks[lvAt[l] - 1].worldRam; const m = ASSETS.maps[['pf_world', 'rn_world2', 'rn_world3', 'rn_world4'][l]]; for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const x = w[r * 128 + c] >> 3, y = m.cells[r * COLS + c], coin = (t) => t === 6 || t === 18 || t === 19; if (x !== y && !(coin(x) && coin(y))) worldsOk = false; } }     // WORLD_RAM holds the tile in its high five bits; a coin may be in any frame of its spin
  check_('at the start of every level WORLD_RAM holds that level\'s map (the coins in any frame of their spin)', worldsOk);
  info(`recorded script: ${scriptInfo.levels.map((x) => `level ${x.level}: ${x.searchTicks} ticks, ${x.livesLeft} of 3 lives left in its own search`).join('; ')}; interpreter ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
// game over and the retry of the same level: a variant with one life; the hero stands still until a walker reaches him
const RETRY_SRC = variant({ level: 0, lives: 1 });
const retryStick = (t) => (t === 14 ? FIRE : t > 150 && t % 2 === 0 ? FIRE : 0);
const RETRY_TICKS = 260;
{
  const r = playInterp(RETRY_SRC, RETRY_TICKS, retryStick).ticks.map((x) => x.vars);
  const over = r.findIndex((v) => v.ST === 3) + 1, retry = r.findIndex((v, k) => k > over && v.ST === 4) + 1, again = r.findIndex((v, k) => k > retry && v.ST === 1) + 1;
  check_(`one life: the hero is hit (game over at tick ${over}), fire starts "LEVEL 1" again (tick ${retry}) and the same level is played again with 3 lives (tick ${again}: LV ${r[again - 1]?.LV}, LIVES ${r[again - 1]?.LIVES}, COINS ${r[again - 1]?.COINS})`,
    over > 0 && retry > over && again > retry && r[again - 1].LV === 0 && r[again - 1].LIVES === 3 && r[again - 1].COINS === 0);
}

// =================================================================================================================
console.log('\n4. The real runtime on a stock TS2068 (TSRun): tick by tick against the interpreter, through the level changes');
// =================================================================================================================
const realOk = !!normal && normal.errors.length === 0;
const play = !realOk ? null : PLAY_SRC === SRC ? normal : compile(PLAY_SRC, { runtime: R3.rt, image: R3.img, assets: ASSETS });
const FIRST_CHANGE = full ? full.ticks.findIndex((x, k) => x.vars.ST === 4 && (k === 0 || full.ticks[k - 1].vars.ST === 1)) + 1 : 0;
const REAL_TICKS = script ? (QUICK ? Math.min(script.length, FIRST_CHANGE + 60) : script.length) : 0;
let realRun = null;
if (!realOk || !script) skip_('the real runtime', !realOk ? 'the banked build is missing' : 'no recorded play-through');
else {
  const t0 = Date.now();
  realRun = runFramed(R3, play, { ticks: REAL_TICKS, stick: stickOf(script) });
  if (realRun.error) check_('the cartridge runs', false, realRun.error);
  else {
    const d = vsInterp(realRun, full, REAL_TICKS);
    const lv = [...new Set(realRun.snaps.map((s) => s.vars.LV))];
    check_(`${REAL_TICKS} ticks of the recorded play-through (levels ${lv.map((x) => x + 1).join(', ')} entered; ${[1, 2, 3].filter((l) => realRun.snaps.some((s) => s.vars.LV === l)).length} banked worlds loaded through the window): variables, arrays, SPR_TAB, WORLD_RAM and camera equal to the interpreter at every tick`, d === null, `${d ?? ''} ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  }
  const rt = RETRY_TICKS;
  const rr = runFramed(R3, compile(RETRY_SRC, { runtime: R3.rt, image: R3.img, assets: ASSETS }), { ticks: rt, stick: retryStick });
  const wantR = playInterp(RETRY_SRC, rt, retryStick);
  check_(`game over and the retry of the level (a variant with one life): ${rt} ticks equal to the interpreter`, !rr.error && vsInterp(rr, wantR, rt) === null, rr.error ?? vsInterp(rr, wantR, rt) ?? '');
}

// =================================================================================================================
console.log('\n5. The picture: the linker\'s placement against everything banked, tick by tick');
// =================================================================================================================
if (!realOk || !script) skip_('normal vs bankAll', 'the banked build or the recorded play-through is missing');
else {
  const ticks = QUICK ? Math.min(REAL_TICKS, FIRST_CHANGE + 60) : Math.min(script.length, 900);
  const all = compile(PLAY_SRC, { runtime: R3.rt, image: R3.img, assets: ASSETS, bankAll: true });
  const RP = { ...R3, picture: true };
  const a = runFramed(RP, play, { ticks, stick: stickOf(script) }), b = runFramed(RP, all, { ticks, stick: stickOf(script) });
  let d = a.error ?? b.error ?? null;
  for (let t = 0; !d && t <= ticks; t++) {
    const x = a.snaps[t], y = b.snaps[t], at = t === 0 ? 'after INIT' : `after tick ${t}`;
    if (JSON.stringify([x.vars, x.arrays, x.sprites]) !== JSON.stringify([y.vars, y.arrays, y.sprites])) d = `${at}: state differs`;
    else if (!sameBuf(x.cells, y.cells) || !sameBuf(x.attrs, y.attrs)) d = `${at}: cell map / attributes differ`;
    else if (!sameBuf(x.worldRam, y.worldRam) || x.cam !== y.cam) d = `${at}: WORLD_RAM / camera differ`;
    else if (!sameBuf(x.ram4000, y.ram4000)) d = `${at}: the picture (RAM $4000-$7FFF) differs`;
    else if (y.f4 !== null && y.f4 !== 0x33) d = `${at}: V_SHADOW_F4 is $${y.f4.toString(16)} at the entry of PROC FRAME (the window must be unmapped)`;
  }
  check_(`${ticks} ticks, normal build vs bankAll: state, cell map, WORLD_RAM and both display files (RAM $4000-$7FFF) equal at every tick (${all.usage.banked.assets.length} assets banked in the second)`, d === null, d ?? '');
}

// =================================================================================================================
console.log('\n6. Negative control: a changed byte in a banked world');
// =================================================================================================================
if (!realOk || !script || !full) skip_('negative control', 'the banked build or the recorded play-through is missing');
else {
  const w = play.usage.banked.assets.find((x) => x.name === 'level3');
  const dck = play.dck.slice();
  dck[9 + 2 * 8192 + (w.at - 0x4000) + 1] ^= 0x30;                    // the value of the first run of level3's RLE stream: chunks 0, 1 and 2 come first in the file
  const damaged = { ...play, dck };
  const upTo = (full.ticks.findIndex((x) => x.vars.LV === 2) + 1) + 3;      // a few ticks after level 3 is loaded
  const g = runFramed(R3, damaged, { ticks: upTo, stick: stickOf(script) });
  const d = g.error ? g.error : vsInterp(g, full, upTo);
  check_(`with a byte of the banked world level3 changed the comparison fails at the level change (${d ?? 'it did not fail'})`, d !== null && /WORLD_RAM/.test(d));
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: arcade-runner (${passed} checks passed, ${failed} failed, ${skipped} skipped)`);
process.exit(failed === 0 ? 0 : 1);
