#!/usr/bin/env node
"use strict";
// arcade-m13-differential.mjs -- language batch 6, Part A: `WORLD expr OF m0, m1, ...` (docs/ARCADE_LANGUAGE_BATCH6.md) against the REAL v3 and v4 runtimes on a stock TS2068 in TSRun: the compiled game is
// compared with the reference interpreter tick by tick, built normally (the worlds / plans mapped), with `bankAll` and with an override that banks only the maps the lists name.
//
//   node tests/arcade-m13-differential.mjs                 (ARCADE_QUICK=1: fewer random programs and ticks)
//
// Sections
//   1  hand-written programs on v3 (WINDOW) and v4 (VIEW3D): the index in range, negative, past the end, an expression, a 16-bit wrap, a list with repeated names, constant indexes, a list in a PROC;
//      equal to the interpreter on every variable, WORLD_RAM / camera (v3) or the wall array / pose (v4); the three builds equal to each other, picture included
//   2  the list form equal to the IF chain of `WORLD name` on the machine (state and picture, every tick)
//   3  random programs: random lists (1 to 8 names, repeats), random index expressions, scenes
//   4  negative controls: a wrong list order, a damaged list entry and a damaged banked stream are seen
//
// How a tick is sampled: when PROC FRAME is entered, so sample k is the state after tick k - 1 (sample 0: after INIT), as tests/arcade-m11-differential.mjs does.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { ROOT, M_, s16 } from './arcade-m5-harness.mjs';
import { diffV3 } from './arcade-m6-common.mjs';
import { diffV4 } from './arcade-m8-common.mjs';
import { rng, pick, ri } from './arcade-m9-common.mjs';
import { ASSETS11, withBank, HEAD, scene, win3, view4 } from './arcade-m11-common.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const skip_ = (name, why) => { console.log(`  SKIP  ${name}  (${why})`); skipped++; };
const info = (s) => console.log('  INFO  ' + s);
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
const asHex = (v) => '$' + (v >>> 0).toString(16);

// ── runtimes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function loadRuntime(v) {
  const json = join(resolve(ROOT, `arcade/build/v${v}`), 'runtime.json');
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))), v };
}
const RT = { 3: loadRuntime(3), 4: loadRuntime(4) };
const lacking = (R, names) => (R ? names.filter((n) => R.rt.symbols[n] === undefined && R.rt.constants?.[n] === undefined) : ['the runtime']);
const MISSING = { 3: lacking(RT[3], ['RT_WORLDLOAD', 'RT_LOADMAPPTR']), 4: lacking(RT[4], ['RT_PLANLOAD', 'RT_LOADMAPPTR']) };

// ── the machine ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Boot the cartridge (the DCK as built: chunks 2 / 3 too when banked) and sample at every entry of PROC FRAME. */
function runFramed(R, res, { ticks }) {
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
  const sceneSym = res.gen?.symbols?.scene ?? null;
  const ray = !!res.gen.view, win = !!res.gen.window;
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    arrays: Object.fromEntries(Object.entries(res.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))])),
    sprites: Array.from({ length: nInst }, (_, i) => {
      const e = SYM.SPR_TAB + ent * i;
      return hasFrame ? { visible: m.ram[e], asset: m.ram[e + 1], x: s16(rd16(e + 2)), y: s16(rd16(e + 4)), frame: m.ram[e + 6] } : { visible: m.ram[e], x: rd16(e + 2), y: rd16(e + 4) };
    }),
    // WORLD_RAM: bits 0-2 of every byte are the runtime's class bits (docs/ARCADE_WINDOW_FASTPATH.md section 2); the interpreter has none, so compare byte AND $F8
    worldRam: win ? m.ram.slice(SYM.WORLD_RAM, SYM.WORLD_RAM + 2048).map((b) => b & 0xF8) : null,
    cam: win ? rd16(SYM.V_CAM) : 0,
    wallRam: ray ? m.ram.slice(SYM.WORLD_RAM, SYM.WORLD_RAM + 1024) : null,
    pose: ray && SYM.V_POSE !== undefined ? { x: rd16(SYM.V_POSE), y: rd16(SYM.V_POSE + 2), a: m.ram[SYM.V_POSE + 4] } : null,
    scene: sceneSym ? m.ram[sceneSym.cur] : 0,
    cells: m.ram.slice(SYM.CELL_TILE, SYM.CELL_TILE + 768), attrs: m.ram.slice(SYM.CELL_ATTR, SYM.CELL_ATTR + 768),
    ram4000: m.ram.slice(0x4000, 0x8000),                       // the picture: both display files, and (v3) the window tables
    f4: SYM.V_SHADOW_F4 !== undefined ? m.ram[SYM.V_SHADOW_F4] : null,
  });
  const out = { snaps: [], error: null, machine: m };
  for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
  const fe = res.map.entries.frame;
  for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F;
  m.joystick[0] = 0xFF; m.joystick[1] = 0xFF;
  const origRead = m.bus.read;
  m.bus.read = function (a) {
    if (a === fe && out.snaps.length < ticks + 1 && m.cpu.pc === fe) out.snaps.push(snap());
    return origRead.call(this, a);
  };
  const div = res.memory[0x8004] & 0x3F;
  const maxFrames = 400 + (ticks + 3) * Math.max(div, 14) * 6;
  for (let f = 0; f < maxFrames && out.snaps.length < ticks + 1; f++) M_.runFrame(m);
  if (out.snaps.length < ticks + 1) out.error = `only ${out.snaps.length} of ${ticks + 1} samples (PROC FRAME entered ${out.snaps.length} times)`;
  return out;
}

const sameBuf = (x, y) => (x === null && y === null) || (!!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]));
const firstDiff = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return i; return -1; };
/** two runs of programs that must behave the same (the builds, or the list form and the IF chain): equal state and picture at every sample, or the first difference */
function diffRuns(a, b, la = 'a', lb = 'b') {
  const n = Math.min(a.snaps.length, b.snaps.length);
  for (let t = 0; t < n; t++) {
    const x = a.snaps[t], y = b.snaps[t], at = t === 0 ? 'after INIT' : `after tick ${t}`;
    for (const k of Object.keys(x.vars)) if (x.vars[k] !== y.vars[k]) return `${at}: ${k} = ${x.vars[k]} (${la}) / ${y.vars[k]} (${lb})`;
    if (JSON.stringify(x.sprites) !== JSON.stringify(y.sprites)) return `${at}: the sprite table differs`;
    if (!sameBuf(x.cells, y.cells)) return `${at}: the cell map differs`;
    if (!sameBuf(x.attrs, y.attrs)) return `${at}: the attributes differ`;
    if (x.cam !== y.cam || !sameBuf(x.worldRam, y.worldRam)) return `${at}: camera ${x.cam} / ${y.cam}, WORLD_RAM ${sameBuf(x.worldRam, y.worldRam) ? 'same' : 'differs at ' + firstDiff(x.worldRam, y.worldRam)}`;
    if (!sameBuf(x.wallRam, y.wallRam)) return `${at}: the wall array differs at ${firstDiff(x.wallRam, y.wallRam)}`;
    if (JSON.stringify(x.pose) !== JSON.stringify(y.pose)) return `${at}: the pose ${JSON.stringify(x.pose)} / ${JSON.stringify(y.pose)}`;
    if (!sameBuf(x.ram4000, y.ram4000)) { const i = firstDiff(x.ram4000, y.ram4000); return `${at}: the picture / window RAM differs at ${asHex(0x4000 + i)}: ${x.ram4000[i]} (${la}) / ${y.ram4000[i]} (${lb})`; }
    if (y.f4 !== null && y.f4 !== 0x33) return `${at}: V_SHADOW_F4 is ${asHex(y.f4)} at the entry of PROC FRAME (the window must be unmapped)`;
  }
  return a.snaps.length === b.snaps.length ? null : `${a.snaps.length} samples (${la}) / ${b.snaps.length} (${lb})`;
}

/** machine vs interpreter, tick by tick: variables, WORLD_RAM / camera (diffV3) or wall array / pose (diffV4) */
function vsInterp(R, res, src, { ticks, ray, assets, got: given }) {
  const got = given ?? runFramed(R, res, { ticks });
  if (got.error) return `run: ${got.error}`;
  let want;
  try { want = interpret(parse(src).ast, { version: ray ? 4 : 3, ticks, assets, maxSteps: 2_000_000_000, border0: R.rt.constants?.BORDER_COLOUR ?? 1 }); } catch (e) { return 'interpreter: ' + e.message; }
  const dv = ray ? diffV4 : diffV3;
  for (let t = 0; t <= ticks; t++) {
    const w = t === 0 ? want.init : want.ticks[t - 1], g = got.snaps[t], at = t === 0 ? 'after INIT' : `after tick ${t}`;
    const d = dv(g, w, at);
    if (d) return d;
  }
  return null;
}

const ALL_WORLD_MAPS = ['w60', 'w128', 'w24', 'w30', 'p8', 'p20', 'p32', 'p4'];
const MODES = [['normal', {}, ASSETS11], ['bankAll', { bankAll: true }, ASSETS11],
  ['only the listed maps banked', {}, ALL_WORLD_MAPS.reduce((as, n) => withBank(as, n, 'banked'), ASSETS11)]];

/** One program on one runtime in the three builds: each equal to the interpreter, and the builds equal to each other (picture included). Returns [{label, ok, detail}] and the runs. */
function runModes(R, src, ticks, { ray }) {
  const results = [], runs = [];
  for (const [mode, opts, assets] of MODES) {
    const res = compile(src, { runtime: R.rt, image: R.img, assets, ...opts });
    if (res.errors.length) { results.push({ mode, ok: false, detail: `compile: ${errText(res)}` }); continue; }
    let got;
    try { got = runFramed(R, res, { ticks }); } catch (e) { results.push({ mode, ok: false, detail: `run: ${e.message}` }); continue; }
    const d = vsInterp(R, res, src, { ticks, ray, assets, got });
    results.push({ mode, ok: d === null, detail: d ?? '', banked: res.usage.banked.assets.length, fixups: res.gen.fixups.length });
    runs.push({ mode, got, res });
  }
  const eq = runs.length > 1 ? runs.slice(1).map((r) => diffRuns(runs[0].got, r.got, runs[0].mode, r.mode)) : [];
  return { results, runs, eq };
}

// =================================================================================================================
// 1. Hand-written programs
// =================================================================================================================
console.log('1. Hand-written programs on v3 (WINDOW) and v4 (VIEW3D): equal to the interpreter, normal / bankAll / the listed maps banked');
const FRAME3 = (stmt, pre = '') => `    v = v + 1
    n = v - 4
${pre}    CAMERA 40 + v
${stmt}
    a = WORLDTILE(8 * 12, 8 * 13)
    b = CAMX()
    c = TILEFLAGS(8 * 3, 8 * 14)
    d = WORLDTILE(8 * 40, 8 * 4)
    f = WORLDTILE(8 * 8, 8 * 12)
    CAMERA 30000
    e = CAMX()
    SHOW ship AT 40 + b, 30
    IF v = 6 THEN SETWORLD 8 * 5, 8 * 13 = 2 ENDIF
`;
// (a MAP no WORLD names is a screen map and must fit the screen: each program declares the maps its text names)
const TABLE3 = [['second', 'w60'], ['third', 'w128'], ['narrow', 'w24'], ['short', 'w30']], TABLE4 = [['other', 'p8'], ['bigger', 'p20'], ['huge', 'p32'], ['tiny', 'p4']];
const mapsOf = (text, table) => table.filter(([nm]) => new RegExp(`\\b${nm}\\b`).test(text)).map(([nm, a]) => `MAP ${nm} = "${a}"\n`).join('');
const prog3 = (stmt, { pre = '', maps = mapsOf(stmt + pre, TABLE3), bands = '', procs = '' } = {}) => `${HEAD}SPRITE ship = "orb"\nMAP level = "lv"\n${maps}WINDOW level\n${bands}${scene('', FRAME3(stmt, pre), 'DIM n, a, b, c, d, e, f')}`.replace('SCENE s\n', `SCENE s\n${procs}`);
const FRAME4 = (stmt, pre = '') => `    v = v + 1
    n = v - 4
${pre}    VIEW 3000, 2900, 70
    SETWALL 2 * 256, 2 * 256 = 3
${stmt}
    a = WALL(300, 300)
    b = WALL(2 * 256 + 10, 3 * 256)
    c = WALL(1900, 1400)
    d = WALL(7 * 256, 5 * 256)
    IF v = 7 THEN VIEW 600, 700, 9 ENDIF
`;
const prog4 = (stmt, { pre = '', maps = mapsOf(stmt + pre, TABLE4), procs = '' } = {}) => `${HEAD}SPRITE ship = "orb"\nMAP level = "maze"\n${maps}VIEW3D level\n${scene('', FRAME4(stmt, pre), 'DIM n, a, b, c, d')}`.replace('SCENE s\n', `SCENE s\n${procs}`);

const HAND3 = {
  'a sweep -3..8 over level, second, third, narrow (index in range, below 0, past the end)': prog3('    WORLD n OF level, second, third, narrow'),
  'an expression index and repeated names': prog3('    WORLD (v * 3) MOD 7 - 1 OF short, third, second, level, level, second'),
  'a 16-bit wrap: 65531 + v is -4 .. 7 as a signed number, 40000 + v is negative': prog3('    n = 65531 + v\n    WORLD n OF third, second, narrow\n    IF v = 3 THEN\n      n = 40000 + v\n      WORLD n OF level, second\n    ENDIF'),
  'constant indexes: in range (the code of WORLD name), past the end, negative': prog3('    IF v = 3 THEN WORLD 2 OF level, second, third ENDIF\n    IF v = 5 THEN WORLD 9 OF level, second ENDIF\n    IF v = 7 THEN WORLD 1 OF second, narrow, third ENDIF\n    IF v = 9 THEN WORLD -1 OF level, second ENDIF\n    IF v = 10 THEN WORLD 0 OF narrow, second, third ENDIF'),
  'a list of one name, and the index 0 / 1': prog3('    WORLD n OF second\n    IF v = 8 THEN WORLD 1 - (v MOD 2) OF short, narrow ENDIF'),
  'a list in a PROC with a parameter, called with the index': prog3('    CALL go(n)', { procs: '  PROC go(k)\n    WORLD k OF second, third, narrow, short\n  ENDP\n', maps: mapsOf('second third narrow short', TABLE3) }),
  'a DEF FN in the index': prog3('    WORLD FN pick(v) OF second, level, third, narrow, short').replace('GAME "t"\n', 'GAME "t"\nDEF FN pick(x) = x MOD 5\n'),
  'bands 2 at 1/4, 3 at 1/2, 11 at 1/1 (the camera limit of every world is worked out for them)': prog3('    WORLD n OF level, second, third, narrow', { bands: 'BAND 2, 1, 4\nBAND 3, 1, 2\nBAND 11, 1, 1\n' }),
};
const HAND4 = {
  'a sweep -3..8 over level, other, bigger, huge (index in range, below 0, past the end)': prog4('    WORLD n OF level, other, bigger, huge'),
  'an expression index and repeated names': prog4('    WORLD (v * 3) MOD 7 - 1 OF tiny, huge, other, level, level, bigger'),
  'a 16-bit wrap': prog4('    n = 65531 + v\n    WORLD n OF huge, other, tiny\n    IF v = 3 THEN\n      n = 40000 + v\n      WORLD n OF level, other\n    ENDIF'),
  'constant indexes: in range, past the end, negative': prog4('    IF v = 3 THEN WORLD 2 OF level, other, bigger ENDIF\n    IF v = 5 THEN WORLD 9 OF level, other ENDIF\n    IF v = 7 THEN WORLD 1 OF other, tiny, bigger, huge ENDIF\n    IF v = 9 THEN WORLD -1 OF level, other ENDIF'),
  'a list in a PROC with a parameter': prog4('    CALL go(n)', { procs: '  PROC go(k)\n    WORLD k OF other, bigger, huge, tiny\n  ENDP\n', maps: mapsOf('other bigger huge tiny', TABLE4) }),
};
for (const [v, HAND, ticks] of [[3, HAND3, QUICK ? 12 : 14], [4, HAND4, QUICK ? 12 : 14]]) {
  const R = RT[v];
  if (!R) { skip_(`v${v} WORLD n OF`, `arcade/build/v${v}/runtime.json is missing`); continue; }
  if (MISSING[v].length) { skip_(`v${v} WORLD n OF`, `the v${v} runtime lacks ${MISSING[v].join(' ')}`); continue; }
  for (const [label, src] of Object.entries(HAND)) {
    const { results, eq } = runModes(R, src, ticks, { ray: v === 4 });
    for (const r of results) check_(`v${v} ${label}, ${r.mode}${r.banked ? ` (${r.banked} banked)` : ''}: ${ticks} ticks equal to the interpreter`, r.ok, r.detail);
    check_(`v${v} ${label}: the builds are equal to each other in state and picture (RAM $4000-$7FFF) every tick`, eq.length === 2 && eq.every((d) => d === null), eq.filter(Boolean).join(' | '));
  }
}

// =================================================================================================================
// 2. The list form against the IF chain of WORLD name
// =================================================================================================================
console.log('\n2. WORLD n OF a, b, c equals the IF chain of `WORLD name` on the machine (state and picture, every tick)');
{
  const chain = (idx, names) => `${names.map((nm, k) => `    IF ${idx} = ${k} THEN WORLD ${nm} ENDIF\n`).join('')}`.replace(/\n$/, '');
  const cases = [
    [3, 'v3, 4 names', (s) => prog3(s), ['level', 'second', 'third', 'narrow'], 'n'],
    [3, 'v3, a repeat and a short list', (s) => prog3(s), ['short', 'second', 'short'], 'n'],
    [4, 'v4, 4 names', (s) => prog4(s), ['level', 'other', 'bigger', 'huge'], 'n'],
    [4, 'v4, with a repeat', (s) => prog4(s), ['tiny', 'other', 'tiny', 'bigger'], 'n'],
  ];
  for (const [v, label, mk, names, idx] of cases) {
    const R = RT[v];
    if (!R || MISSING[v].length) { skip_(`${label}`, `the v${v} runtime lacks ${MISSING[v].join(' ') || 'its table'}`); continue; }
    const ticks = QUICK ? 12 : 14;
    const a = compile(mk(`    WORLD ${idx} OF ${names.join(', ')}`), { runtime: R.rt, image: R.img, assets: ASSETS11 });
    const b = compile(mk(chain(idx, names)), { runtime: R.rt, image: R.img, assets: ASSETS11 });
    if (a.errors.length || b.errors.length) { check_(`${label}: both compile`, false, errText(a) + errText(b)); continue; }
    const d = diffRuns(runFramed(R, a, { ticks }), runFramed(R, b, { ticks }), 'list', 'IF chain');
    check_(`${label}: the list form and the IF chain are equal in state and picture for ${ticks} ticks (index -3 .. ${ticks - 4}: below 0, in range, past the end)`, d === null, d ?? '');
    const ab = compile(mk(`    WORLD ${idx} OF ${names.join(', ')}`), { runtime: R.rt, image: R.img, assets: ASSETS11, bankAll: true }), bb = compile(mk(chain(idx, names)), { runtime: R.rt, image: R.img, assets: ASSETS11, bankAll: true });
    const d2 = ab.errors.length || bb.errors.length ? 'compile: ' + errText(ab) + errText(bb) : diffRuns(runFramed(R, ab, { ticks }), runFramed(R, bb, { ticks }), 'list', 'IF chain');
    check_(`${label}, bankAll: the same`, d2 === null, d2 ?? '');
  }
}

// =================================================================================================================
// 3. Random programs
// =================================================================================================================
console.log('\n3. Random programs: random lists, index expressions, constant indexes, scenes');
{
  const NAMES3 = ['second', 'third', 'narrow', 'short'], NAMES4 = ['other', 'bigger', 'huge', 'tiny'];
  /** a random WORLD statement list for the frame: `n` is the tick-driven index variable (v - 4, so -3 .. ticks - 4) */
  function genStmts(r, own, names) {
    const out = [];
    const pool = [own, ...names];
    const used = new Set();
    for (let i = 0, k = ri(r, 1, 4); i < k; i++) {
      const list = Array.from({ length: ri(r, 1, 8) }, () => pick(r, pool));
      list.forEach((x) => used.add(x));
      const form = ri(r, 0, 5);
      const expr = form === 0 ? 'n' : form === 1 ? `(v * ${ri(r, 2, 5)}) MOD ${ri(r, 3, 9)} - ${ri(r, 0, 2)}` : form === 2 ? `n + ${ri(r, -2, 2)}` : form === 3 ? `65530 + v + ${ri(r, 0, 3)}` : form === 4 ? `(n * ${ri(r, 1, 3)}) MOD ${ri(r, 2, 7)}` : `${ri(r, -2, list.length + 1)}`;
      const guard = ri(r, 0, 2);
      const stmt = `WORLD ${expr} OF ${list.join(', ')}`;
      out.push(guard === 0 ? `    ${stmt}` : guard === 1 ? `    IF v MOD ${ri(r, 2, 4)} = ${ri(r, 0, 1)} THEN\n      ${stmt}\n    ENDIF` : `    IF v >= ${ri(r, 2, 9)} THEN ${stmt} ENDIF`);
    }
    return { text: out.join('\n'), used };
  }
  const run = (v, n, wrap) => {
    const R = RT[v];
    if (!R || MISSING[v].length) { skip_(`v${v} random programs`, `the v${v} runtime lacks ${MISSING[v].join(' ') || 'its table'}`); return; }
    let bad = 0, why = '', first = '', lists = 0, banked = 0;
    for (let seed = 1; seed <= n; seed++) {
      const r = rng(seed * 7919 + v);
      const g = genStmts(r, 'level', v === 3 ? NAMES3 : NAMES4), stmts = g.text;
      const decl = (v === 3 ? TABLE3 : TABLE4).filter(([nm]) => g.used.has(nm)).map(([nm, a]) => `MAP ${nm} = "${a}"\n`).join('');
      const src = (v === 3 ? prog3 : prog4)(stmts, { maps: decl });
      const ticks = QUICK ? 12 : 14;
      const { results, eq } = runModes(RT[v], src, ticks, { ray: v === 4 });
      lists += (stmts.match(/WORLD /g) ?? []).length;
      banked += results.reduce((a, x) => a + (x.banked ?? 0), 0);
      const fail = results.find((x) => !x.ok) ?? null, fe = eq.find(Boolean);
      if (fail || fe) { bad++; why ||= `seed ${seed}: ${fail ? `${fail.mode}: ${fail.detail}` : `builds differ: ${fe}`}`; first ||= src; }
    }
    check_(`v${v}: ${n} random programs in three builds each: equal to the interpreter every tick, and the builds equal to each other`, bad === 0, `${bad} failed; ${why}`);
    info(`v${v}: ${lists} WORLD statements, ${banked} banked assets over the builds`);
    if (bad && first) console.log(`  ---- first failing program:\n${first.split('\n').map((l) => '  | ' + l).join('\n')}`);
    void wrap;
  };
  run(3, QUICK ? 4 : 24);
  run(4, QUICK ? 4 : 24);
}

// =================================================================================================================
// 4. Negative controls
// =================================================================================================================
console.log('\n4. Negative controls: the comparisons see a wrong list, a damaged entry and a damaged banked stream');
{
  const R = RT[3];
  if (!R || MISSING[3].length) skip_('negative controls', `the v3 runtime lacks ${MISSING[3].join(' ') || 'its table'}`);
  else {
    const ticks = 12;
    const base = prog3('    WORLD n OF level, second, third, narrow');
    const interp = (src) => interpret(parse(src).ast, { version: 3, ticks, assets: ASSETS11, maxSteps: 2_000_000_000, border0: R.rt.constants?.BORDER_COLOUR ?? 1 });
    const want = interp(base);
    const cmpWith = (res) => { const got = runFramed(R, res, { ticks }); let d = null; for (let t = 0; !d && t <= ticks; t++) d = diffV3(got.snaps[t], t === 0 ? want.init : want.ticks[t - 1], `t${t}`); return d; };
    const ok = compile(base, { runtime: R.rt, image: R.img, assets: ASSETS11 });
    check_('control: the unmodified program equals the interpreter', ok.errors.length === 0 && cmpWith(ok) === null, errText(ok));
    const swapped = compile(prog3('    WORLD n OF level, third, second, narrow'), { runtime: R.rt, image: R.img, assets: ASSETS11 });
    check_('control: a list with two names swapped is seen against the interpreter of the original', swapped.errors.length === 0 && cmpWith(swapped) !== null, errText(swapped));
    const shorter = compile(prog3('    WORLD n OF level, second, third'), { runtime: R.rt, image: R.img, assets: ASSETS11 });
    check_('control: a list one name shorter is seen', shorter.errors.length === 0 && cmpWith(shorter) !== null, errText(shorter));
    // a damaged entry of the list in the cartridge: the file offset of a mapped address (chunks 0, 1, 4, 5 are shipped: the mapped part starts at file offset 9 + 2 * 8192 for $8000)
    const entryAt = (res, i) => res.gen.fixups[i].at;
    const dmg = (res, addr, mask) => { const r2 = { ...res, dck: res.dck.slice() }; r2.dck[9 + 2 * 8192 + (addr - 0x8000)] ^= mask; return r2; };
    check_('control: the undamaged image: the entry of `third` (index 2) is where the fixup says (world_w 128)', ok.memory[entryAt(ok, 2) + 2] === 128 && ok.dck[9 + 2 * 8192 + (entryAt(ok, 2) + 2 - 0x8000)] === 128, `${ok.memory[entryAt(ok, 2) + 2]}`);
    check_('control: a changed cam_max in the list entry of `third` is seen (CAMX after CAMERA 30000 differs from the interpreter)', cmpWith(dmg(ok, entryAt(ok, 2) + 3, 0x20)) !== null);
    check_('control: a changed world_w in the list entry of `second` (60 becomes 0) is seen (the collision reads see no world)', cmpWith(dmg(ok, entryAt(ok, 1) + 2, 0x3C)) !== null);
    check_('control: a changed source address in the list entry of `narrow` (its low byte) is seen', cmpWith(dmg(ok, entryAt(ok, 3), 0x04)) !== null);
    // a damaged banked stream: the list leads the machine to a damaged world
    const okb = compile(base, { runtime: R.rt, image: R.img, assets: ASSETS11, bankAll: true });
    const sec = okb.usage.banked.assets.find((a) => a.name === 'second');
    const dmgB = { ...okb, dck: okb.dck.slice() }; dmgB.dck[9 + 2 * 8192 + (sec.at - 0x4000) + 1] ^= 0x30;
    check_('control: the undamaged banked build equals the interpreter', okb.errors.length === 0 && cmpWith(okb) === null, errText(okb));
    check_('control: a changed value byte in the banked stream of `second` (reached only through the list) is seen', cmpWith(dmgB) !== null);
  }
  const R4 = RT[4];
  if (!R4 || MISSING[4].length) skip_('v4 negative controls', `the v4 runtime lacks ${MISSING[4].join(' ') || 'its table'}`);
  else {
    const ticks = 12;
    const base = prog4('    WORLD n OF level, other, bigger, huge');
    const want = interpret(parse(base).ast, { version: 4, ticks, assets: ASSETS11, maxSteps: 2_000_000_000, border0: R4.rt.constants?.BORDER_COLOUR ?? 1 });
    const cmpWith = (res) => { const got = runFramed(R4, res, { ticks }); let d = null; for (let t = 0; !d && t <= ticks; t++) d = diffV4(got.snaps[t], t === 0 ? want.init : want.ticks[t - 1], `t${t}`); return d; };
    const ok = compile(base, { runtime: R4.rt, image: R4.img, assets: ASSETS11 });
    check_('v4 control: the unmodified program equals the interpreter', ok.errors.length === 0 && cmpWith(ok) === null, errText(ok));
    const swapped = compile(prog4('    WORLD n OF level, bigger, other, huge'), { runtime: R4.rt, image: R4.img, assets: ASSETS11 });
    check_('v4 control: a list with two names swapped is seen', swapped.errors.length === 0 && cmpWith(swapped) !== null, errText(swapped));
    const dmg = (res, addr, mask) => { const r2 = { ...res, dck: res.dck.slice() }; r2.dck[9 + 2 * 8192 + (addr - 0x8000)] ^= mask; return r2; };
    check_('v4 control: a changed map_w in the list entry of `other` is seen', cmpWith(dmg(ok, ok.gen.fixups[1].at + 2, 0x01)) !== null);
  }
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}: ${passed} checks passed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed === 0 ? 0 : 1);
