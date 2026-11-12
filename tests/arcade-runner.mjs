#!/usr/bin/env node
"use strict";
// arcade-runner.mjs -- slice B5 of the banked cartridge map (docs/ARCADE_BANKING_CONTRACT.md section 10): arcade/examples/runner.arc, "Leap Runner" with four levels, a game that does not
// fit the 16 KB of the game area unless its three extra worlds are banked.  Since language batch 7 (docs/ARCADE_LANGUAGE_BATCH7.md part C) the game has three scenes: `title` (NOWINDOW: a full-screen picture and
// sprites at screen positions), `demo` (the attract mode, the window) and `play`; the play scene's variables are named PLAY.X by the compiler, and the tests below read them as X (stripPlay), as before.
//
//   node tests/arcade-runner.mjs                  (ARCADE_QUICK=1: the real-runtime runs stop a few ticks after the first level change)
//   node tests/arcade-runner.mjs --record         search a play-through of each level on the reference interpreter (four processes, minutes), chain them, and write arcade/examples/runner.script.json
//   node tests/arcade-runner.mjs --record-level N (one level, writes arcade/examples/runner.script.<N>.json; --record does this four times and then chains)
//   node tests/arcade-runner.mjs --chain          (only the chaining of the four runner.script.<N>.json files into runner.script.json)
//
// Sections
//   1  the level data: runner.assets.json is what runner.assets.gen.mjs makes, the DIM lines of runner.arc are what it prints, every level is 128 x 16 with the start, the flag, the coins and the
//      walkers' turning points that the arrays claim (the turning points worked out again here by a second, separate rule)
//   2  the build: the game compiles as the linker places it (usage.mapped within 16,384; the banker banks only what the mapped part needs: the title picture and some worlds), and with its four worlds
//      forced `banked` (usage.banked the four worlds), and does NOT build with every map forced `mapped` (the does-not-fit error)
//   3  the play-through on the reference interpreter (arcade/examples/runner.script.json: the title, level 1 to its flag, "LEVEL 2", level 2, ... the win screen): each level is entered in turn,
//      each coin / enemy table is read, the game ends at state 2; and game over, retry of the same level with three lives (a variant with one life), on the interpreter
//   4  the REAL runtime on a stock TS2068 in TSRun (arcade/build/v3, which must hold RT_WORLDLOAD): the same play-throughs tick by tick against the interpreter (variables, arrays, SPR_TAB, WORLD_RAM,
//      the camera), through every level change (each loads a banked world through the window)
//   5  the picture: the build as the linker places it and the build with every map, world and plan banked (bankAll) are equal tick by tick in state AND in RAM $4000-$7FFF (both display files and the
//      window tables) over the same play-through
//   6  negative control: a changed byte in a banked world (level3) is seen by the comparison of section 4
//   7  pause (H, language batch 6 Part B): on the interpreter and tick by tick on TSRun, the paused ticks stand still (state, text cells, both display files but for the PAUSED cells, sound silent) and the game goes
//      on as the unpaused run shifted by the paused ticks (state and both display files)
//   8  high score (HI): one session on the interpreter and on TSRun: game over (back to the title, HI kept), new game, win, title (shows HI n), new game, game over; HI keeps the higher score
//   9  the scenes (batch 7 part C): the title shows no window (V_WIN = 0) and draws its sprites, title -> demo -> title alternate by themselves, fire in the title and in the demo starts the game, the whole flow
//      on TSRun tick by tick against the interpreter (state, sprites, text cells), and the play itself unchanged: the play-through from the first playing tick on is the pre-scenes game's, tick for tick
//      (a digest of the variables, arrays, sprites and camera of every tick, and of the world from tick 26 on, taken from the game as it was before the title and demo scenes were made)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { diffV3 } from './arcade-m6-common.mjs';
import { createSoundRecorder, soundOf, clockOf, compareSound, soundCoverage } from './arcade-m15-common.mjs';
import { LEVELS, COLS, ROWS, levelTables, dataLines, buildRunnerAssets } from '../arcade/examples/runner.assets.gen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const EX = join(ROOT, 'arcade/examples');
const SELF = fileURLToPath(import.meta.url);
const QUICK = !!process.env.ARCADE_QUICK;
const SRC = readFileSync(join(EX, 'runner.arc'), 'utf8');
const ASSETS_TEXT = readFileSync(join(EX, 'runner.assets.json'), 'utf8');
const ASSETS = JSON.parse(ASSETS_TEXT);
// The banker banks only what the mapped part needs, and since the compiler size pass (docs/ARCADE_COMPILER_SIZE_CONTRACT.md) the game's code is smaller, so the build as the linker
// places it (ASSETS: every map `auto`) keeps level3 in the mapped part. The banked worlds themselves are tested on this build: the same assets with the four worlds' maps set to
// `banked` (assets.maps.<name>.bank, docs/ARCADE_BANKING_CONTRACT.md; pf_world / rn_world2 / rn_world3 / rn_world4 are the maps of level / level2 / level3 / level4).
const WORLD_MAPS = ['pf_world', 'rn_world2', 'rn_world3', 'rn_world4'];
const ASSETS_BANKED = JSON.parse(ASSETS_TEXT); for (const k of WORLD_MAPS) ASSETS_BANKED.maps[k].bank = 'banked';
const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;

// ── the level starts: the one place the source is changed for a test (a variant of GSTAGE 0, "lv = 0", and of the lives) ─────────────────────────────────────
const START_MARK = 'score = 0 : lives = 3 : hud = 0 : lv = 0';
const variant = ({ level = 0, lives = 3 } = {}) => { if (!SRC.includes(START_MARK)) throw new Error('runner.arc lost the GSTAGE 0 line the tests vary'); return SRC.replace(START_MARK, `score = 0 : lives = ${lives} : hud = 0 : lv = ${level}`); };
const RIGHT = 8, FIRE = 16, UP = 1, LEFT = 4;
const TITLE = [...new Array(13).fill(0), FIRE, ...new Array(6).fill(0)];          // the title: 7 stages a tick, fire on tick 14 (a fresh edge), the game starts in about 7 ticks
const rle = (a) => { const o = []; for (const v of a) { if (o.length && o.at(-1)[0] === v) o.at(-1)[1]++; else o.push([v, 1]); } return o; };
const unrle = (r) => { const a = []; for (const [v, n] of r) for (let i = 0; i < n; i++) a.push(v); return a; };

// the compiler keys a scene's variables SCENE.NAME in a game with several scenes (PLAY.ST); the play scene's are read here under their plain names, as the game had them before it had scenes
const stripPlay = (o) => (o ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k.replace(/^PLAY\./, ''), v])) : o);
const normRec = (r) => { if (r) { r.vars = stripPlay(r.vars); if (r.arrays) r.arrays = stripPlay(r.arrays); } return r; };
const normRun = (run) => { normRec(run.init); run.ticks.forEach(normRec); return run; };
const astOf = new Map();
const astFor = (src) => { if (!astOf.has(src)) astOf.set(src, parse(src).ast); return astOf.get(src); };
/** the interpreter's records for a stick script (index t-1 = FRAME call t) */
const playInterp = (src, ticks, stickFn, keys) => normRun(interpret(astFor(src), { version: 3, ticks, assets: ASSETS, stick: stickFn, keys, maxSteps: 4_000_000_000 }));

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
  const run = (script, ticks, tail) => normRun(interpret(ast, { version: 3, ticks, assets: ASSETS, stick: (t) => (t <= script.length ? script[t - 1] : tail ? tail(t - script.length) : 0), maxSteps: 4_000_000_000 })).ticks;
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
  const T = levelTables();
  // the four TABLE blocks of the data (TABLE lv1 .. lv4): one object a level, row name -> its values (level-relative lists, and the counts ce / se as one value)
  const blocks = [...SRC.slice(a, b).matchAll(/ {2}TABLE (\w+)\n([\s\S]*?) {2}ENDTABLE/g)];
  const level = blocks.map((m) => { const o = {}; for (const r of m[2].matchAll(/^ {4}(\w+) = ([-\d, ]+)$/gm)) o[r[1]] = r[2].split(',').map(Number); return o; });
  check_(`the data are four tables lv1 .. lv4 (${blocks.map((m) => m[1]).join(' ')}), in level order`, blocks.map((m) => m[1]).join(' ') === 'lv1 lv2 lv3 lv4' && level.every((o) => o.ce.length === 1 && o.se.length === 1));
  LEVELS.forEach((L, i) => {
    const arrays = level[i];
    const m = ASSETS.maps[maps[i]], cell = (c, r) => m.cells[r * COLS + c];
    const ok = m.w === COLS && m.h === ROWS && m.cells.length === COLS * ROWS;
    check_(`level ${i + 1}: the world ${maps[i]} is 128 x 16`, ok);
    const startGround = [0, 1, 2, 3, 4].every((c) => cell(c, 14) === 1 && [11, 12, 13].every((r) => !(flags[cell(c, r)] & 3)));
    check_(`level ${i + 1}: ground at columns 0-4 and nothing solid above them (the start at x 24, y 88)`, startGround);
    const flag = cell(122, 8) === 8 && [9, 10, 11, 12, 13].every((r) => cell(122, r) === 7) && cell(122, 14) === 1;
    check_(`level ${i + 1}: the flag (tile 8 over the pole, tile 7, rows 8-13) stands on ground at column 122`, flag);
    // coins: exactly the coin tiles of the map, in the order of the list
    const coins = []; for (let c = 0; c < COLS; c++) for (let r = 5; r < ROWS; r++) if (cell(c, r) === 6) coins.push([c * 8, r * 8]);
    const listed = []; for (let k = 0; k < arrays.ce[0]; k++) listed.push([arrays.cxs[k], arrays.cys[k]]);
    check_(`level ${i + 1}: cxs / cys list exactly ce = ${arrays.ce[0]} coins (the array row is as long as the count)`, arrays.cxs.length === arrays.ce[0] && arrays.cys.length === arrays.ce[0]);
    check_(`level ${i + 1}: the ${listed.length} coins of the list are the coin tiles of the map (sorted by x)`, JSON.stringify(coins.sort((p, q) => p[0] - q[0] || p[1] - q[1])) === JSON.stringify(listed));
    // enemies: sorted by x; a walker stands on a solid top (16 px above it), a bat has no turning points
    const sl = 0, sh = arrays.se[0];
    check_(`level ${i + 1}: sx / sy / wlo / whi list exactly se = ${sh} enemies`, [arrays.sx, arrays.sy, arrays.wlo, arrays.whi].every((r) => r.length === sh));
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
    const cps = [0, 1, 2].map((j) => [arrays.ckx[j], arrays.cky[j]]);
    const okc = cps.every(([x, y]) => { const c0 = (x + 3) >> 3, c1 = (x + 12) >> 3, g = (y + 24) >> 3; return [c0, c1].every((c) => flags[cell(c, g)] & 1) && [c0, c1].every((c) => [y >> 3, (y >> 3) + 1, (y >> 3) + 2].every((r) => !(flags[cell(c, r)] & 3))); }) && cps[0][0] < cps[1][0] && cps[1][0] < cps[2][0];
    check_(`level ${i + 1}: three checkpoints in order, on solid ground, clear of walls and spikes`, okc);
    check_(`level ${i + 1}: the respawn tables (RCF / RNX) and the coin index (CIX) follow the lists`, JSON.stringify([arrays.rcf, arrays.rnx, arrays.cix]) === JSON.stringify([T[i].rcf, T[i].rnx, T[i].cix]) && arrays.rcf.every((v) => v >= 0 && v <= arrays.ce[0]) && arrays.rnx.every((v) => v >= 0 && v < arrays.se[0]));
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
let normal = null, bankedFour = null;
if (!R3 || bankNeeds.length) skip_('the banked build', !R3 ? 'arcade/build/v3/runtime.json is missing' : `arcade/build/v3/runtime.json lacks ${bankNeeds.join(' ')} (slice B1 not built)`);
else {
  normal = compile(SRC, { runtime: R3.rt, image: R3.img, assets: ASSETS });
  check_('the game compiles against runtime v3 with no errors and no warnings', normal.errors.length === 0 && normal.warnings.length === 0, errText(normal));
  const u = normal.usage;
  check_(`usage.mapped ${u.mapped.used} of ${u.mapped.available} bytes (fits)`, u.mapped.used <= u.mapped.available);
  const names = u.banked.assets.map((x) => x.name).sort().join(',');
  const worlds = u.banked.assets.filter((x) => x.kind === 'world').map((x) => x.name).sort().join(',');
  const bankedKinds = (b) => b.assets.every((x) => x.kind === 'world' || x.kind === 'table' || (x.kind === 'map' && x.name === 'titlepic'));
  check_(`usage.banked as the linker places it: the title picture and ${worlds.split(',').length} worlds (${names}), ${u.banked.used} bytes, in the window; nothing but worlds, tables and the title picture; the banker banks only what the mapped part needs (the smaller code of the compiler size pass leaves ${['level', 'level2', 'level3', 'level4'].filter((n) => !worlds.split(',').includes(n)).join(', ') || 'none'} mapped)`, worlds.split(',').length >= 1 && bankedKinds(u.banked) && u.banked.assets.some((x) => x.name === 'titlepic'));
  const b4 = compile(SRC, { runtime: R3.rt, image: R3.img, assets: ASSETS_BANKED });
  check_('the game compiles with the four worlds forced banked (assets.maps.<name>.bank = "banked"), no errors and no warnings', b4.errors.length === 0 && b4.warnings.length === 0, errText(b4));
  const names4 = b4.usage.banked.assets.map((x) => x.name).sort().join(','), worlds4 = b4.usage.banked.assets.filter((x) => x.kind === 'world').map((x) => x.name).sort().join(',');
  check_(`usage.banked with the four worlds banked: the four worlds, and nothing but tables and the title picture besides (${names4}), ${b4.usage.banked.used} bytes, in the window; usage.mapped ${b4.usage.mapped.used} of ${b4.usage.mapped.available}`, worlds4 === 'level,level2,level3,level4' && bankedKinds(b4.usage.banked) && b4.usage.mapped.used <= b4.usage.mapped.available);
  check_(`the cartridge ships chunks ${b4.shipped.join(' ')} with the four worlds banked too`, JSON.stringify(b4.shipped) === '[0,1,2,4,5]');
  bankedFour = b4;
  check_('the three scenes are there: title (the first), demo and play, with the title picture as the game\'s first screen MAP', JSON.stringify(normal.gen.symbols.scene.names) === '["title","demo","play"]' && u.banked.assets.some((x) => x.name === 'titlepic'));
  check_(`the cartridge ships chunks ${normal.shipped.join(' ')} (0 1 runtime, 2 the banked worlds, 4 5 the mapped part)`, JSON.stringify(normal.shipped) === '[0,1,2,4,5]');
  const forced = JSON.parse(ASSETS_TEXT); for (const k of Object.keys(forced.maps)) forced.maps[k].bank = 'mapped';
  const f = compile(SRC, { runtime: R3.rt, image: R3.img, assets: forced });
  check_(`with every map forced mapped the build fails: ${f.errors.length ? f.errors[0].message : 'it compiled'}`, f.errors.length > 0 && f.errors.every((e) => /does not fit/.test(e.message)));
  const m2 = f.errors.length ? (f.errors[0].message.match(/\(([\d,]+) of 16,384/) ?? [])[1] : null;
  info(`the compile: mapped part ${u.mapped.used} of ${u.mapped.available} bytes, banked part ${u.banked.used} bytes (${u.banked.assets.map((x) => `${x.name} ${x.bytes}`).join(', ')})`);
  info(`all four worlds mapped would need ${m2 ?? '?'} of 16,384 bytes; banked, the mapped part is ${u.mapped.used} (${u.mapped.available - u.mapped.used} bytes to spare)`);
}

// =================================================================================================================
// the real runtime
// =================================================================================================================
const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
const M_ = await import(pathToFileURL(join(ROOT, 'tsrun/machine.js')).href);

/** Boot the cartridge (DCK as built: chunk 2 with the banked worlds too) on a stock TS2068 and sample at every entry of PROC FRAME (sample k = the state after tick k - 1; sample 0 after INIT). */
function runFramed(R, res, { ticks, stick, keys }) {
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
  const sceneCur = res.gen?.symbols?.scene?.cur ?? null;
  const nInst = Math.max(res.gen.v2 ? res.gen.v2.ninst : 4, 4);
  const snap = (picture) => ({
    vars: stripPlay(Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))]))),
    arrays: stripPlay(Object.fromEntries(Object.entries(res.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))]))),
    scene: sceneCur !== null ? m.ram[sceneCur] : 0, vwin: SYM.V_WIN !== undefined ? m.ram[SYM.V_WIN] : null,
    sprites: Array.from({ length: nInst }, (_, i) => { const e = SYM.SPR_TAB + ent * i; return hasFrame ? { visible: m.ram[e], asset: m.ram[e + 1], x: s16(rd16(e + 2)), y: s16(rd16(e + 4)), frame: m.ram[e + 6] } : { visible: m.ram[e], x: rd16(e + 2), y: rd16(e + 4) }; }),
    // WORLD_RAM: bits 0-2 of every byte are the runtime's class bits (docs/ARCADE_WINDOW_FASTPATH.md section 2); the interpreter has none, so compare byte AND $F8
    worldRam: m.ram.slice(SYM.WORLD_RAM, SYM.WORLD_RAM + 2048).map((b) => b & 0xF8), cam: rd16(SYM.V_CAM),
    cells: m.ram.slice(SYM.CELL_TILE, SYM.CELL_TILE + 768), attrs: m.ram.slice(SYM.CELL_ATTR, SYM.CELL_ATTR + 768),
    ram4000: picture ? m.ram.slice(0x4000, 0x8000) : null,
    f4: SYM.V_SHADOW_F4 !== undefined ? m.ram[SYM.V_SHADOW_F4] : null,
    sfxActive: SYM.V_SFX_ACTIVE !== undefined ? m.ram[SYM.V_SFX_ACTIVE] : null,
    ay: soundOf(m, SYM).ay, chip: soundOf(m, SYM).chip,      // (AY_SHADOW R0..R10 and the chip: the song-level comparison of `soundVs`)
  });
  const out = { snaps: [], error: null };
  for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
  const fe = res.map.entries.frame;
  const setInput = (k) => { m.joystick[0] = contact(stick ? stick(k) : 0); m.joystick[1] = contact(0); for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F; if (keys && keys(k)) m.keyMatrix[6] &= ~0x10; };    // H is bit 4 of half-row 6 (H J K L ENTER); a held key reads 0
  setInput(1);
  const origRead = m.bus.read;
  const rec = out.rec = createSoundRecorder(m, SYM, res);      // times every RT_PLAY / RT_SILENCE / RT_MUSIC / RT_NOMUSIC call (V_FRAMES at its entry) and sees the ones a frame interrupt cut
  m.bus.read = function (a) {
    rec.fetch(a);
    if (a === fe && out.snaps.length < ticks + 1 && m.cpu.pc === fe) { out.snaps.push(snap(R.picture)); rec.sample(); setInput(out.snaps.length); }
    return origRead.call(this, a);
  };
  const div = res.memory[0x8004] & 0x3F;
  const maxFrames = 400 + (ticks + 3) * Math.max(div, 14) * 6;
  for (let f = 0; f < maxFrames && out.snaps.length < ticks + 1; f++) M_.runFrame(m);
  if (out.snaps.length < ticks + 1) out.error = `only ${out.snaps.length} of ${ticks + 1} samples`;
  return out;
}

const sameBuf = (x, y) => !!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]);
/**
 * The sound of a run of a game with songs, at song level (docs/ARCADE_MUSIC_CONTRACT.md 6a; the level of tests/arcade-m15-differential.mjs): the interpreter runs the same script with the clock the machine
 * showed (the refresh of every RT_PLAY / RT_SILENCE / RT_MUSIC / RT_NOMUSIC call and of every sample) and every sample's V_SFX_ACTIVE (all bits), AY_SHADOW R0..R10 and the chip are compared with its
 * `ay`, exactly; the comparison stops at the first call a frame interrupt cut.  `need` names the counts that must be above 0 (song, effect, cOver): a run that never plays music cannot pass.
 * Returns {ok, detail}; the detail always has the sample counts.
 */
function soundVs(got, src, ticks, stickFn, keys, need) {
  if (got.error) return { ok: false, detail: got.error };
  const want = normRun(interpret(astFor(src), { version: 3, ticks, assets: ASSETS, stick: stickFn, keys, maxSteps: 4_000_000_000, clock: clockOf(got.rec) }));
  const pairs = [];
  for (let t = 0; t <= ticks; t++) { if (got.rec.straddle !== null && t >= got.rec.straddle) break; pairs.push({ at: t === 0 ? 'after INIT' : `after tick ${t}`, g: got.snaps[t], w: t === 0 ? want.init : want.ticks[t - 1] }); }
  const { d, stats } = compareSound(pairs), cov = soundCoverage(stats, need, got.rec.cuts);
  return { ok: d === null && cov.ok && got.rec.calls.length > 0, detail: d ?? `${cov.text}; ${got.rec.calls.length} sound calls${cov.ok ? '' : '; MISSING: a count that must be above 0 is 0'}` };
}
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
const PLAY_DIGEST = { state: 'f21d5e0511bcb3044d5b70ca55be93be694b0afbecd6fdeaa74895a648312ba5', world: '9f6305a5ce042a3895b42c7b56dff9af7ff42a2c8c3c2fbca6de95f2a417d745' };

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
  // C5: the in-game song (run) starts with the play scene, plays through the level changes (state 4) and is stopped by the win (state 2), so that the jingle is heard alone
  { const play0 = full.ticks.findIndex((x) => x.scene === 2), winAt = recs.findIndex((v) => v.ST === 2) + 1;
    const during = full.ticks.slice(play0, winAt - 1), after = full.ticks.slice(winAt - 1);
    check_(`the in-game song: playing from the play scene's first tick (${play0 + 1}) to the tick before the win (${winAt}), through the ${msgs.length} level changes (${during.filter((x) => x.vars.ST === 4).length} ticks in state 4), song index ${during[0]?.music.index}; silent from the win (${after.length} ticks)`,
      play0 >= 0 && winAt > 0 && during.length > 0 && during.every((x) => x.music.active && x.music.index === during[0].music.index) && during.some((x) => x.vars.ST === 4) && after.every((x) => !x.music.active)); }
  // the world is the right one: WORLD_RAM of the interpreter at the start of each level holds that level's map
  let worldsOk = true;
  for (let l = 0; l < 4; l++) { const w = full.ticks[lvAt[l] - 1].worldRam; const m = ASSETS.maps[['pf_world', 'rn_world2', 'rn_world3', 'rn_world4'][l]]; for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) { const x = w[r * 128 + c] >> 3, y = m.cells[r * COLS + c], coin = (t) => t === 6 || t === 18 || t === 19; if (x !== y && !(coin(x) && coin(y))) worldsOk = false; } }     // WORLD_RAM holds the tile in its high five bits; a coin may be in any frame of its spin
  check_('at the start of every level WORLD_RAM holds that level\'s map (the coins in any frame of their spin)', worldsOk);
  // the play itself is unchanged: from the first playing tick (21: the fire was tick 14) on, the game is tick for tick the one that had its title as a state of its own scene.  PLAY_DIGEST was taken from that game (the
  // source before the title and demo scenes, run on this interpreter over this recorded play-through): a SHA-256 of [variables, arrays, sprites, camera] of ticks 21..end (the variables as they were named then: TI, the
  // start's stage counter, is left out, and the scenes' own TITLE.* / DEMO.* variables did not exist), and one of the world (WORLD_RAM) of ticks 26..end: the coin that the old title's last tick left half turned
  // (tile 19 instead of 6, at column 14, row 10) is back to the spin's own phase from tick 26 on, so ticks 22..25 differ in that one cell only, the one visible difference of the new start.
  if (PLAY_SRC !== SRC) skip_('the play is the pre-scenes game\'s', 'the recorded route needed a variant of the game (more lives)');
  else {
    const keep = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !/^(TITLE|DEMO)\./.test(k) && k !== 'TI' && k !== 'SC0').sort((a, b) => (a[0] < b[0] ? -1 : 1)));
    const hs = createHash('sha256'), hw = createHash('sha256');
    for (let t = 21; t <= script.length; t++) { const r = full.ticks[t - 1]; hs.update(JSON.stringify([keep(r.vars), keep(r.arrays), r.sprites, r.cam])); if (t >= 26) hw.update(Buffer.from(r.worldRam)); }
    const state = hs.digest('hex'), world = hw.digest('hex');
    check_(`the play from tick 21 to ${script.length} (variables, arrays, sprites, camera of ${script.length - 20} ticks) is the pre-scenes game's, tick for tick (digest ${state.slice(0, 12)}...)`, state === PLAY_DIGEST.state);
    check_(`... and so is the world (WORLD_RAM of ${script.length - 25} ticks, from tick 26: digest ${world.slice(0, 12)}...)`, world === PLAY_DIGEST.world);
  }
  info(`recorded script: ${scriptInfo.levels.map((x) => `level ${x.level}: ${x.searchTicks} ticks, ${x.livesLeft} of 3 lives left in its own search`).join('; ')}; interpreter ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
// game over goes back to the title (batch 7): a variant with one life; the hero stands still until a walker reaches him, fire (a fresh edge, once the end text is up) leaves for the title
const RETRY_SRC = variant({ level: 0, lives: 1 });
const retryOver = playInterp(RETRY_SRC, 260, (t) => (t === 14 ? FIRE : 0)).ticks.findIndex((x) => x.vars.ST === 3) + 1;
const retryStick = (t) => (t === 14 || t === retryOver + 16 ? FIRE : 0);
const RETRY_TICKS = retryOver + 60;
{
  const r = playInterp(RETRY_SRC, RETRY_TICKS, retryStick).ticks;
  const over = retryOver, back = r.findIndex((x, k) => k >= over && x.scene === 0) + 1;
  check_(`one life: the hero is hit (game over at tick ${over}: ST ${r[over - 1]?.vars.ST}, END text up by tick ${over + 5}), fire at tick ${over + 16} goes back to the title (scene 0 from tick ${back}, the window off: ${r[back - 1]?.show}), HI kept (${r[back - 1]?.vars.HI} = the game's score ${r[over - 1]?.vars.SCORE})`,
    over > 0 && r[over - 1].vars.ST === 3 && back === over + 16 && r[back - 1].show === 'screen' && r[back - 1].vars.HI === r[over - 1].vars.SCORE && r.slice(over, back - 1).every((x) => x.scene === 2));
  { const play0 = r.findIndex((x) => x.scene === 2), songRun = r.slice(play0, over - 1).every((x) => x.music.active), silentOver = r.slice(over - 1, back - 1).every((x) => !x.music.active);
    check_(`one life: the in-game song plays from the play scene's first tick (${play0 + 1}) to the tick before game over (${over}) and is stopped by the game over (silent from tick ${over} to the title at ${back}), the title starts its own song again (${r[back - 1]?.music.active ? 'playing' : 'SILENT'} at tick ${back})`, play0 >= 0 && songRun && silentOver && r[back - 1].music.active); }
  check_(`the title that game over returns to waits for a new press of fire (the fire still down is let go first): the ${RETRY_TICKS - retryOver - 16} ticks after it are all the title`, r.slice(back - 1).every((x) => x.scene === 0));
}

// =================================================================================================================
console.log('\n4. The real runtime on a stock TS2068 (TSRun): tick by tick against the interpreter, through the level changes');
// =================================================================================================================
const realOk = !!normal && normal.errors.length === 0 && !!bankedFour && bankedFour.errors.length === 0;
// `play`: the build whose four worlds are banked (every level change loads one through the window: sections 4 and 6); `playAuto`: the build as the linker places it (section 5)
const play = !realOk ? null : PLAY_SRC === SRC ? bankedFour : compile(PLAY_SRC, { runtime: R3.rt, image: R3.img, assets: ASSETS_BANKED });
const playAuto = !realOk ? null : PLAY_SRC === SRC ? normal : compile(PLAY_SRC, { runtime: R3.rt, image: R3.img, assets: ASSETS });
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
  {
    const sv = soundVs(realRun, PLAY_SRC, REAL_TICKS, stickOf(script), undefined, ['song', 'effect', 'cOver']);
    check_(`the recorded play-through, sound at song level (the title's song \`hop\`, then \`run\` from the start of play, pause, game over and win stop it, the effects as channel-C streams): V_SFX_ACTIVE, AY_SHADOW and the chip equal the interpreter's chip model on every sample`, sv.ok, sv.detail);
  }
  const rt = RETRY_TICKS;
  const rr = runFramed(R3, compile(RETRY_SRC, { runtime: R3.rt, image: R3.img, assets: ASSETS }), { ticks: rt, stick: retryStick });
  const wantR = playInterp(RETRY_SRC, rt, retryStick);
  check_(`game over and back to the title (a variant with one life): ${rt} ticks equal to the interpreter`, !rr.error && vsInterp(rr, wantR, rt) === null, rr.error ?? vsInterp(rr, wantR, rt) ?? '');
  { const sv = soundVs(rr, RETRY_SRC, rt, retryStick, undefined, ['song', 'effect', 'cOver']); check_(`game over and back to the title (a variant with one life), sound at song level: V_SFX_ACTIVE, AY_SHADOW and the chip equal the interpreter's on every sample`, sv.ok, sv.detail); }
}

// =================================================================================================================
console.log('\n5. The picture: the linker\'s placement against everything banked, tick by tick');
// =================================================================================================================
if (!realOk || !script) skip_('normal vs bankAll', 'the banked build or the recorded play-through is missing');
else {
  const ticks = QUICK ? Math.min(REAL_TICKS, FIRST_CHANGE + 60) : Math.min(script.length, 900);
  const all = compile(PLAY_SRC, { runtime: R3.rt, image: R3.img, assets: ASSETS, bankAll: true });
  const RP = { ...R3, picture: true };
  const a = runFramed(RP, playAuto, { ticks, stick: stickOf(script) }), b = runFramed(RP, all, { ticks, stick: stickOf(script) });
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

// =================================================================================================================
console.log('\n7. Pause (H): the paused game stands still, and goes on exactly where it was');
// =================================================================================================================
// the paused ticks are P (H goes down: PAUSED up) to Q (H goes down again: PAUSED cleared), none of them runs the game's logic; the tick after Q plays what an unpaused game plays at tick P, so
// the paused run is the unpaused run shifted by D = Q + 1 - P ticks. The stick is held at right + fire for the paused ticks (it must not matter). P is the first tick after the first sound of level 1
// so that the silencing can be seen (a sound that goes on for the two ticks after it). D is even: the runtime draws into the two display files in turn, so a game shifted by an odd number of ticks
// would have the files' roles swapped, and the picture comparison needs the same parity.
const H_CODE = 72, JUNK = RIGHT | FIRE;
const interpWith = (src, ticks, stick, keys) => playInterp(src, ticks, stick, keys);
const rowCells = (rec, row, c0, c1) => Array.from(rec.cells.slice(row * 32 + c0, row * 32 + c1));
const PAUSED_CELLS = [...'PAUSED'].map((c) => c.charCodeAt(0));
// the interpreter's record of a tick compared with another: variables, arrays, sprites, world, camera, text cells and attributes; `mask` = [row, c0, c1] cells left out
const sameRec = (a, b, { mask = null, skipVars = [] } = {}) => {
  for (const [k, v] of Object.entries(a.vars)) if (!skipVars.includes(k) && b.vars[k] !== v) return `${k} = ${v} against ${b.vars[k]}`;
  if (JSON.stringify(a.arrays) !== JSON.stringify(b.arrays)) return 'arrays differ';
  if (JSON.stringify(a.sprites) !== JSON.stringify(b.sprites)) return 'sprites differ';
  if (!sameBuf(a.worldRam, b.worldRam) || a.cam !== b.cam) return 'WORLD_RAM / camera differ';
  for (let i = 0; i < a.cells.length; i++) if (!(mask && i >= mask[0] * 32 + mask[1] && i < mask[0] * 32 + mask[2]) && (a.cells[i] !== b.cells[i] || a.attrs[i] !== b.attrs[i])) return `text cell ${i} (row ${i >> 5}, col ${i & 31}) differs`;
  return null;
};
let pauseCase = null;
if (!full) skip_('pause', 'no recorded play-through');
else {
  const rec = full.ticks;                                                // rec[t - 1] = the state after tick t
  let P = 0; for (let t = 70; t < 380 && !P; t++) if (rec[t - 1].vars.ST === 1 && rec[t - 2].sfx.active && rec[t - 1].sfx.active && rec[t].sfx.active) P = t;     // a sound is playing at the end of ticks P - 1, P and P + 1
  if (!P) P = 100;
  const Q = P + 11, D = Q + 1 - P, N = Q + 90;
  const sOrig = stickOf(script);
  const pStick = (t) => (t < P ? sOrig(t) : t <= Q ? JUNK : sOrig(t - D));
  const pKeys = (t, code) => code === H_CODE && (t === P || t === Q);
  const pr = interpWith(PLAY_SRC, N, pStick, pKeys).ticks;
  pauseCase = { P, Q, D, N, pStick, pKeys, pr };
  const A = (t) => pr[t - 1];
  let d = null;
  for (let t = 1; t < P && !d; t++) { const e = sameRec(A(t), rec[t - 1], { skipVars: [] }); if (e) d = `tick ${t} before the pause: ${e}`; }
  check_(`interpreter: the ${P - 1} ticks before the first H are the unpaused run's (no H, no difference)`, d === null, d ?? '');
  d = null;
  const ref = rec[P - 2];                                              // the state after tick P - 1: what stands still
  for (let t = P; t < Q && !d; t++) {
    const e = sameRec(A(t), ref, { mask: [21, 13, 19], skipVars: ['PAUSED'] });
    if (e) d = `tick ${t}: ${e}`; else if (A(t).vars.PAUSED !== 1) d = `tick ${t}: PAUSED = ${A(t).vars.PAUSED}`;
    else if (JSON.stringify(rowCells(A(t), 21, 13, 19)) !== JSON.stringify(PAUSED_CELLS)) d = `tick ${t}: row 21 does not read PAUSED`;
  }
  check_(`interpreter: H at tick ${P} pauses: for the ${Q - P} paused ticks (${P}..${Q - 1}, the stick held at right + fire) every variable, array, sprite, the world, the camera and the text equal the state after tick ${P - 1}, except PAUSED = 1 and the word PAUSED in row 21`, d === null, d ?? '');
  const sfxRef = rec[P - 2].sfx.active && rec[P - 1].sfx.active, sfxNow = A(P).sfx.active;
  // C5 (in-game song): the pause stops the effect (SILENCE) and the song (NOMUSIC), and going on starts the song again from its top (PLAY run).  The clockless interpreter's chip model sees the
  // effect's end one sample after the call (the call is placed at the tick's refresh count; the real machine's V_SFX_ACTIVE is 0 right after tick P, checked below with the cartridge), so the effect is
  // required silent from tick P + 1; the song, which NOMUSIC stops at once, from tick P.  (Before C5 the check was `!sfx.active` from tick P on and there was no song in the play scene.)
  const songRef = rec[P - 2].music.active, songNow = A(P).music.active;
  check_(`interpreter: the sound that was playing (${sfxRef ? 'it goes on in the unpaused run' : 'NO SOUND PLAYING'}; the song ${songRef ? 'plays' : 'DOES NOT PLAY'}) is silenced by the pause (the effect ${sfxNow ? 'ends one sample later' : 'silent'}, the song ${songNow ? 'still playing' : 'silent'}) and both stay silent while paused`,
    sfxRef && songRef && !songNow && pr.slice(P, Q).every((x) => !x.sfx.active) && pr.slice(P - 1, Q - 1).every((x) => !x.music.active));
  check_(`interpreter: H again at tick ${Q} starts the song again (music.active after tick ${Q}: ${A(Q).music.active})`, A(Q).music.active === true);
  const eq = sameRec(A(Q), ref, { skipVars: [] });
  check_(`interpreter: H again at tick ${Q} unpauses: PAUSED = ${A(Q).vars.PAUSED}, the PAUSED text is gone, everything is the state after tick ${P - 1} again`, A(Q).vars.PAUSED === 0 && eq === null, eq ?? '');
  d = null;
  for (let t = Q + 1; t <= N && !d; t++) { const e = sameRec(A(t), rec[t - D - 1]); if (e) d = `tick ${t} (the unpaused run's tick ${t - D}): ${e}`; }
  check_(`interpreter: after the unpause the game plays exactly as the unpaused run shifted by ${D} ticks (ticks ${Q + 1}..${N} against ${Q + 1 - D}..${N - D}: variables, arrays, sprites, world, camera, text)`, d === null, d ?? '');
  // H outside the playing state does nothing: on the title (tick 10) and on the win / game over screens
  const t0 = interpWith(PLAY_SRC, 40, (t) => (t === 14 ? FIRE : 0), (t, code) => code === H_CODE && (t === 3 || t === 12)).ticks;
  const t1 = interpWith(PLAY_SRC, 40, (t) => (t === 14 ? FIRE : 0)).ticks;
  check_('interpreter: H on the title does nothing (the game starts as without it)', t0.every((x, i) => x.vars.PAUSED === 0 && sameRec(x, t1[i]) === null));
}

// the same on the cartridge in TSRun, tick by tick
if (!pauseCase || !realOk) skip_('pause on the real runtime', 'the interpreter case or the banked build is missing');
else {
  const { P, Q, D, N, pStick, pKeys, pr } = pauseCase;
  const t0 = Date.now();
  const RP = { ...R3, picture: true };
  const keysOf = (t) => pKeys(t, H_CODE);
  const a = runFramed(RP, play, { ticks: N, stick: pStick, keys: keysOf });
  const b = runFramed(RP, play, { ticks: N - D, stick: stickOf(script) });         // the unpaused run, long enough for the shifted comparison
  const wantP = { init: full.init, ticks: pr };
  let d = a.error ?? b.error ?? null;
  if (!d) d = vsInterp(a, wantP, N);
  check_(`the cartridge with H at ticks ${P} and ${Q}: ${N} ticks equal to the interpreter (variables, arrays, SPR_TAB, WORLD_RAM, camera), PAUSED included  (${((Date.now() - t0) / 1000).toFixed(0)} s)`, d === null, d ?? '');
  // text cells on the machine against the interpreter's
  d = null;
  for (let t = 1; t <= N && !d; t++) { if (!sameBuf(a.snaps[t].cells, Uint8Array.from(pr[t - 1].cells)) || !sameBuf(a.snaps[t].attrs, Uint8Array.from(pr[t - 1].attrs))) d = `tick ${t}: the cell map / attributes differ from the interpreter's`; }
  check_('the cartridge\'s text cells (CELL_TILE / CELL_ATTR) equal the interpreter\'s at every tick, the PAUSED text included', d === null, d ?? '');
  // the display files: before the pause equal to the unpaused run; paused: the same at every tick but for the PAUSED cells; after: the unpaused run shifted
  const mask = (img) => { const o = img.slice(); for (const base of [0x0000, 0x2000]) { for (let y = 168; y < 176; y++) for (let c = 13; c < 19; c++) o[base + (((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2)) + c] = 0; for (let c = 13; c < 19; c++) o[base + 0x1800 + 21 * 32 + c] = 0; } return o; };
  d = null;
  for (let t = 0; t < P && !d; t++) if (!sameBuf(a.snaps[t].ram4000, b.snaps[t].ram4000)) d = `sample ${t}: the display files differ from the unpaused run's before the pause`;
  check_(`before the pause both display files (RAM $4000-$7FFF) are the unpaused run's, tick by tick (samples 0..${P - 1})`, d === null, d ?? '');
  d = null;
  const base = mask(a.snaps[P + 2].ram4000);
  for (let t = P + 2; t < Q && !d; t++) if (!sameBuf(mask(a.snaps[t].ram4000), base)) d = `sample ${t}: the display files moved while paused`;
  const stateStill = a.snaps.slice(P, Q).every((x, i) => JSON.stringify([x.sprites, x.cam, x.f4]) === JSON.stringify([a.snaps[P].sprites, a.snaps[P].cam, a.snaps[P].f4]));
  check_(`while paused (samples ${P + 2}..${Q - 1}) both display files are identical from tick to tick except the 6 PAUSED cells of row 21; the sprites and camera stand still`, d === null && stateStill, d ?? '');
  // the word is really drawn: ink in the 6 cells of row 21 in both display files while paused, none after the unpause
  const ink = (img) => [0x0000, 0x2000].map((base) => { let n = 0; for (let y = 168; y < 176; y++) for (let c = 13; c < 19; c++) n += img[base + (((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2)) + c] ? 1 : 0; return n; });
  const inkPaused = ink(a.snaps[P + 3].ram4000), inkAfter = ink(a.snaps[Q + 3].ram4000), inkBefore = ink(a.snaps[P - 1].ram4000);
  check_(`PAUSED is on the screen while paused (bitmap bytes with ink in row 21, columns 13-18, in the two display files: ${inkPaused.join(' / ')}) and gone again after the unpause (${inkAfter.join(' / ')}; before the pause ${inkBefore.join(' / ')})`, inkPaused.every((n) => n > 10) && inkAfter.every((n) => n === 0) && inkBefore.every((n) => n === 0));
  d = null;
  for (let t = Q + 1; t <= N && !d; t++) if (!sameBuf(a.snaps[t].ram4000, b.snaps[t - D].ram4000)) d = `sample ${t}: the display files differ from the unpaused run's sample ${t - D}`;
  check_(`after the unpause both display files equal the unpaused run's shifted by ${D} ticks (samples ${Q + 1}..${N} against ${Q + 1 - D}..${N - D}): the text was cleared and the game went on where it was`, d === null, d ?? '');
  check_(`the sound is silenced on the machine: V_SFX_ACTIVE is ${a.snaps[P].sfxActive} after tick ${P} and while paused (the unpaused run: ${b.snaps[P].sfxActive})`, a.snaps[P - 1].sfxActive !== 0 && a.snaps[P].sfxActive === 0 && b.snaps[P].sfxActive !== 0 && a.snaps.slice(P, Q).every((x) => x.sfxActive === 0));
  check_(`the song starts again when the pause ends: V_SFX_ACTIVE is ${a.snaps[Q + 3].sfxActive} three ticks after tick ${Q}`, a.snaps[Q + 3].sfxActive !== 0);
}

// =================================================================================================================
console.log('\n8. High score (HI): kept across games, the higher wins, the title shows it');
// =================================================================================================================
// One session with a one-life variant: game over on a short play (score s0 > 0, so HI = s0), fire goes back to the title (which shows "HI s0"), fire starts a new game, the recorded route wins (HI = the final
// score, higher), fire goes to the title ("HI n"), a new game left standing is over at once (a lower score: HI stays) -- on the interpreter, then on the cartridge tick by tick.
let hiCase = null;
if (!full) skip_('high score', 'no recorded play-through');
else {
  const HI_SRC = variant({ lives: 1 });
  const lvStart = 21;                                                     // the record after which level 1 plays (the recorded run's first with ST 1): the fire that starts the game is tick 14
  // the title's high score text: row 21, from column 13 ("HI n", on the black bar above PRESS SPACE OR FIRE)
  const hiRow = (r) => String.fromCharCode(...rowCells(r, 21, 13, 21)).trimEnd();
  // seg A: the recorded start, then standing still: the first K (60..140) after which the hero is hit with a score above 0
  let seg = null;
  for (let K = 60; K <= 140 && !seg; K += 4) {
    const stickA = (t) => (t <= K ? script[t - 1] : 0);
    const r = interpWith(HI_SRC, K + 300, stickA).ticks;
    const over = r.findIndex((x) => x.vars.ST === 3) + 1;
    if (over > 0 && r[over - 1].vars.SCORE > 0) seg = { K, over, score: r[over - 1].vars.SCORE };
  }
  if (!seg) check_('a short play with a score above 0 ends in game over (one life)', false, 'none of K = 60..140 did');
  else {
    // seg B: fire (a fresh edge) once game over has been up a while: the title; 14 ticks later fire starts a new game, 7 ticks after which level 1 plays; the recorded route from that level start on
    // then: win, wait, fire (title), fire (new game), stand still until game over
    const plan = [];                                                   // stick value by tick
    for (let t = 1; t <= seg.K; t++) plan.push(script[t - 1]);
    while (plan.length < seg.over + 20) plan.push(0);
    plan.push(FIRE);                                                   // game over to the title
    const toTitle1 = plan.length;
    while (plan.length < toTitle1 + 14) plan.push(0);
    plan.push(FIRE);                                                   // the title to a new game
    const start2 = plan.length;
    // run to find when the new game's level starts playing, then append the route with the recorded offsets
    let r = interpWith(HI_SRC, plan.length + 120, (t) => plan[t - 1] ?? 0).ticks;
    const t1 = r.findIndex((x, k) => k >= start2 && x.vars.ST === 1) + 1;     // first tick with the new game's level playing
    const off = t1 - lvStart;                                          // new-game tick t plays what the recorded run played at tick t - off
    while (plan.length < t1) plan.push(0);
    for (let t = t1 + 1; t - off <= script.length; t++) plan.push(script[t - off - 1]);
    r = interpWith(HI_SRC, plan.length + 40, (t) => plan[t - 1] ?? 0).ticks;
    const win = r.findIndex((x, k) => k >= t1 && x.vars.ST === 2) + 1;
    check_(`after the game over (tick ${seg.over}, score ${seg.score}) fire goes to the title (tick ${toTitle1}), fire again starts a new game (tick ${start2}: level 1 playing from tick ${t1}) and the recorded route wins from there (win screen at tick ${win}; ${win > 0 ? 'score ' + r[win - 1].vars.SCORE : ''})`, win > 0 && t1 === start2 + 7 && r[toTitle1 - 1].scene === 0);
    if (win > 0) {
      while (plan.length < win + 30) plan.push(0);
      plan.push(FIRE);                                                 // the win screen to the title
      const toTitle = plan.length;
      while (plan.length < toTitle + 14) plan.push(0);
      plan.push(FIRE);                                                 // the title to a new game
      const newGame = plan.length;
      while (plan.length < newGame + 160) plan.push(0);
      const ticks = plan.length;
      const sess = interpWith(HI_SRC, ticks, (t) => plan[t - 1] ?? 0).ticks;
      const V = (t) => sess[t - 1].vars;
      const titleAt = sess.findIndex((x, k) => k >= win && x.scene === 0) + 1;
      const over2 = sess.findIndex((x, k) => k >= newGame && x.vars.ST === 3) + 1;
      const hiAtOver0 = V(seg.over).HI, hiAtWin = V(win).HI, finalScore = V(win).SCORE;
      check_(`HI is 0 until a game ends and the first title (tick 12) shows "${hiRow(sess[11])}"`, V(seg.over - 1).HI === 0 && hiRow(sess[11]) === 'HI 0' && sess.slice(0, seg.over - 1).every((x) => x.vars.HI === 0));
      check_(`the first game over (score ${seg.score}) makes HI ${hiAtOver0}`, hiAtOver0 === seg.score);
      check_(`game over returns to the title with HI kept: the title from tick ${toTitle1} (scene ${sess[toTitle1 - 1].scene}, window ${sess[toTitle1 - 1].show === 'screen' ? 'off' : 'ON'}) shows "${hiRow(sess[toTitle1 + 11])}" (HI ${V(toTitle1 + 11).HI}) and a new game from it starts with SCORE ${V(start2 + 8).SCORE}, HI ${V(start2 + 8).HI}`, sess[toTitle1 - 1].scene === 0 && sess[toTitle1 - 1].show === 'screen' && hiRow(sess[toTitle1 + 11]) === `HI ${seg.score}` && V(start2 + 8).SCORE === 0 && V(start2 + 8).HI === seg.score);
      check_(`the win (score ${finalScore}) is higher and makes HI ${hiAtWin}`, finalScore > seg.score && hiAtWin === finalScore);
      check_(`the title after the win shows "${hiRow(sess[titleAt + 11])}" (HI ${V(titleAt + 11).HI}) and a new game starts from it with a score of 0 (tick ${newGame + 9}: SCORE ${V(newGame + 9).SCORE}, HI ${V(newGame + 9).HI}; the new game is not clearing it)`, titleAt > 0 && hiRow(sess[titleAt + 11]) === `HI ${finalScore}` && V(newGame + 9).SCORE === 0 && V(newGame + 9).HI === finalScore);
      check_(`a lower score does not take it: the new game is over at tick ${over2} with score ${over2 > 0 ? V(over2).SCORE : '?'} and HI stays ${over2 > 0 ? V(over2).HI : '?'}`, over2 > 0 && V(over2).SCORE < finalScore && V(over2).HI === finalScore && V(ticks).HI === finalScore);
      hiCase = { HI_SRC, plan, ticks, sess, titleAt, win, over2, seg, finalScore };
    }
  }
}
if (!hiCase || !realOk) skip_('the high score on the real runtime', 'the interpreter case or the banked build is missing');
else {
  const { HI_SRC, plan, ticks, sess, finalScore } = hiCase;
  const t0 = Date.now();
  const hiRes = compile(HI_SRC, { runtime: R3.rt, image: R3.img, assets: ASSETS });
  const g = runFramed(R3, hiRes, { ticks, stick: (t) => plan[t - 1] ?? 0 });
  let d = g.error ?? vsInterp(g, { init: full.init, ticks: sess }, ticks);
  for (let t = 1; t <= ticks && !d; t++) if (!sameBuf(g.snaps[t].cells, Uint8Array.from(sess[t - 1].cells))) d = `tick ${t}: the text cells differ from the interpreter's`;
  check_(`the whole session on the cartridge (${ticks} ticks: game over, title, new game, win, title with HI ${finalScore}, new game, game over; one-life variant): variables (HI among them), arrays, sprites, world, camera and text cells equal to the interpreter at every tick  (${((Date.now() - t0) / 1000).toFixed(0)} s)`, d === null, d ?? '');
  check_(`on the machine HI is ${g.snaps[ticks]?.vars.HI} at the end (the interpreter ${sess.at(-1).vars.HI})`, g.snaps[ticks]?.vars.HI === finalScore);
}

// =================================================================================================================
console.log('\n9. The scenes: the title shows no window, the title and the demo take turns, fire starts the game from either');
// =================================================================================================================
// The title (scene 0, NOWINDOW) lasts 170 ticks, then the demo (scene 1) 170 ticks, then the title again: 8.5 seconds each at the game's 20 ticks a second. The record of the tick that executes ENTER is the new scene's.
const SCENE_AT = (t) => (t <= 170 ? 0 : t <= 341 ? 1 : 0);
{
  const N9 = 350;
  const flow = playInterp(SRC, N9, () => 0).ticks;
  const bad = flow.findIndex((x, k) => x.scene !== SCENE_AT(k + 1) || x.show !== (x.scene === 0 ? 'screen' : 'window'));
  check_(`no input: the title (window off: "screen") for ticks 1..170, the demo (window) for 171..341, the title again from tick 342, every record says which${bad >= 0 ? `: first wrong record ${bad + 1}` : ''}`, bad < 0);
  // the sprites of the title are at screen positions: hero x = 4 + 1.5 t, hopping every 40 ticks, a walker 56 behind (y 136), a bat from the right (x = 250 - 2 t, y 104 + the sine)
  const sp = (t, i) => flow[t - 1].sprites[i];
  const SN = [0, 5, 9, 11, 12, 11, 9, 5, 0, -5, -9, -11, -12, -11, -9, -5];
  const hero = sp(40, 6), walker = sp(60, 0), bat = sp(40, 4);
  check_(`title tick 40: the hero (instance 6) is at (${hero.x}, ${hero.y}), tick 60 the walker (instance 0) at (${walker.x}, ${walker.y}) and tick 40 the bat (instance 4) at (${bat.x}, ${bat.y}): the screen positions of the title`,
    hero.visible && hero.x === 4 + ((40 * 3) >> 1) && hero.y === 128 && walker.visible && walker.x === 4 + ((60 * 3) >> 1) - 56 && walker.y === 136 && bat.visible && bat.x === 250 - 80 && bat.y === 104 + SN[(40 >> 1) & 15]);
  check_('the hero hops (y 128 - (p (16 - p)) div 3 for p = tick mod 40 below 16: 107 at p = 8), is hidden past the right edge (tick 160), and the walker is not there yet at tick 10', sp(48, 6).y === 128 - 21 && sp(160, 6).visible === 0 && sp(10, 0).visible === 0);
  const cell = (t, c, r) => flow[t - 1].cells[r * 32 + c];
  check_(`the hero eats the coins over his hops: the cell (2, 14) holds a coin at tick 1 (${cell(1, 2, 14)}) and sky at tick 100 (${cell(100, 2, 14)} = the cell (5, 14): ${cell(100, 5, 14)}), the pair under the last hop (25, 14) is still there at tick 100 (${cell(100, 25, 14)}) and gone at tick 160 (${cell(160, 25, 14)})`,
    cell(1, 2, 14) !== cell(100, 5, 14) && cell(100, 2, 14) === cell(100, 5, 14) && cell(100, 25, 14) !== cell(100, 5, 14) && cell(160, 25, 14) === cell(100, 5, 14));
  // fire in the demo starts the game; the game starts playing 7 ticks after the fire, as it did from the old title
  const fd = playInterp(SRC, 260, (t) => (t === 200 ? FIRE : 0)).ticks;
  const playAt = fd.findIndex((x) => x.vars.ST === 1) + 1;
  check_(`fire in the demo (tick 200) starts the game: the demo runs to tick 199, scene 2 (window) from tick 200, level 1 playing at tick ${playAt} (LV ${fd[playAt - 1]?.vars.LV}, LIVES ${fd[playAt - 1]?.vars.LIVES})`, fd.slice(170, 199).every((x) => x.scene === 1) && fd.slice(199).every((x) => x.scene === 2 && x.show === 'window') && playAt === 207 && fd[playAt - 1].vars.LIVES === 3);
  const ft = playInterp(SRC, 60, (t) => (t === 14 ? FIRE : 0)).ticks;
  check_('fire in the title (tick 14) starts the game: the title for ticks 1..13, scene 2 from tick 14, level 1 playing at tick 21', ft.slice(0, 13).every((x) => x.scene === 0) && ft.slice(13).every((x) => x.scene === 2) && ft.findIndex((x) => x.vars.ST === 1) + 1 === 21);
  // a fire still held when a game ends does not start the next one: game over -> the title with fire held for 8 ticks, then a new press
  const held = (t) => (t === 14 || (t >= retryOver + 16 && t <= retryOver + 23) || t === retryOver + 30 ? FIRE : 0);
  const hh = playInterp(RETRY_SRC, retryOver + 60, held).ticks;
  const over8 = retryOver + 16, press = retryOver + 30;
  check_(`fire held through game over (ticks ${over8}..${over8 + 7}) leaves for the title and does not start a game: the title for ticks ${over8}..${press - 1}, a new press at tick ${press} starts one (scene 2 from tick ${press})`,
    hh.slice(over8 - 1, press - 1).every((x) => x.scene === 0) && hh.slice(press - 1).every((x) => x.scene === 2));
}
{
  const R9 = { ...R3, picture: true };
  if (!realOk) skip_('the scenes on the real runtime', 'the banked build is missing');
  else {
    // the real runtime, tick by tick against the interpreter: variables, arrays, SPR_TAB, WORLD_RAM, camera, and the text cells; the scene index and V_WIN (0 in the title, 1 in the demo and the game)
    const runScene = (label, ticks, stickFn, need = ['song', 'effect', 'cOver']) => {
      const t0 = Date.now();
      const g = runFramed(R9, normal, { ticks, stick: stickFn });
      const want = playInterp(SRC, ticks, stickFn);
      let d = g.error ?? vsInterp(g, want, ticks);
      for (let t = 0; t <= ticks && !d; t++) {
        const w = t === 0 ? want.init : want.ticks[t - 1], sn = g.snaps[t];
        if (sn.scene !== w.scene) d = `sample ${t}: scene ${sn.scene}, interpreter ${w.scene}`;
        else if (sn.vwin !== (w.show === 'screen' ? 0 : 1)) d = `sample ${t}: V_WIN = ${sn.vwin}, the interpreter says the scene shows ${w.show}`;
        else if (!sameBuf(sn.cells, Uint8Array.from(w.cells)) || !sameBuf(sn.attrs, Uint8Array.from(w.attrs))) d = `sample ${t}: the text cells / attributes differ`;
      }
      check_(`${label}: ${ticks} ticks equal to the interpreter (variables, arrays, SPR_TAB, WORLD_RAM, camera, text cells, scene index, V_WIN)  (${((Date.now() - t0) / 1000).toFixed(0)} s)`, d === null, d ?? '');
      const sv = soundVs(g, SRC, ticks, stickFn, undefined, need);
      check_(`${label}: sound at song level (V_SFX_ACTIVE, AY_SHADOW, the chip against the interpreter's chip model, every sample)`, sv.ok, sv.detail);
      return { g, want };
    };
    const a = runScene('no input: title, demo, title', 350, () => 0);
    // the title draws its sprites: ink in the box of the hero (tick 21), the walker (tick 61) and the bat (tick 41) over the sky of the picture, in both display files; and the window is off there
    const inkBox = (img, base, x, y, w, h) => { let n = 0; for (let yy = y; yy < y + h; yy++) for (let c = x >> 3; c <= (x + w - 1) >> 3; c++) { const bits = img[base + (((yy & 0xC0) << 5) | ((yy & 7) << 8) | ((yy & 0x38) << 2)) + c]; for (let b = 0; b < 8; b++) if (bits & (1 << b) && c * 8 + (7 - b) >= x && c * 8 + (7 - b) < x + w) n++; } return n; };
    const boxes = [['hero', 21, 6], ['walker', 61, 0], ['bat', 41, 4]].map(([name, k, i]) => { const sp0 = a.want.ticks[k - 2].sprites[i]; const r = (base) => inkBox(a.g.snaps[k].ram4000, base, sp0.x + 2, sp0.y + 4, 12, 8); return [name, k, r(0x0000), r(0x2000)]; });
    check_(`the title's sprites are drawn: ink in a 12 x 8 pixel box of the hero, walker and bat over the blank sky, in the two display files (${boxes.map(([n, k, x, y]) => `${n} at sample ${k}: ${x} / ${y}`).join('; ')})`, boxes.every(([, , x, y]) => x > 15 && y > 15));
    check_(`the window is off in the title (V_WIN = ${a.g.snaps[20].vwin} at sample 20), on in the demo (${a.g.snaps[250].vwin}) and in the title again (${a.g.snaps[345].vwin})`, a.g.snaps[20].vwin === 0 && a.g.snaps[250].vwin === 1 && a.g.snaps[345].vwin === 0);
    runScene('fire in the demo (tick 200): the game starts from it', 330, (t) => (t === 200 ? FIRE : 0));
    runScene('fire in the title (tick 14), then the game to tick 120', 120, (t) => (t === 14 ? FIRE : 0));
  }
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: arcade-runner (${passed} checks passed, ${failed} failed, ${skipped} skipped)`);
process.exit(failed === 0 ? 0 : 1);
