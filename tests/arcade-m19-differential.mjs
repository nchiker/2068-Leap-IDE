#!/usr/bin/env node
"use strict";
// arcade-m19-differential.mjs -- fine colour (8 x 1 colour, SCLD mode 2), slice F3: the compiled game on the REAL v2 runtime against the reference interpreter, tick by tick, STATE AND PICTURE, with scene
// switches between fine and two-buffer scenes in every direction (docs/ARCADE_FINE_COLOUR_CONTRACT.md sections 2, 4, 6 and 9: "the differential suite compares interpreter and runtime pictures after every
// tick of scripted runs"; 4.1 to 4.4 for what a switch does).
//
//   node tests/arcade-m19-differential.mjs                (ARCADE_QUICK=1: fewer, shorter random runs)
//   ARCADE_M19D_SEEDS=a-b node tests/arcade-m19-differential.mjs     only the random programs a..b (a failing one is printed whole: its source, assets and script)
//
// THE PROGRAMS are written here (generated from a seed; the same seed gives the same program): 2 to 3 scenes, each fine or two-buffer ("scenes": {"s0": {"display": "fine"}, ...} in the assets file, as the
// project setting), a tileset whose tiles have a different colour on each of their 8 pixel rows (so a two-buffer scene shows row 0 and a fine scene all 8), sprites of several sizes and phase counts (1, 2, 4, 8;
// at most 32 phases in all: the cap of a game with a fine scene) in pools, with masks that leave bytes uncovered, a full-screen map for each scene (the first one is what every ENTER puts back), text in random
// colours, TILE / FILL / FILLC / LOADMAP at random places, and in every scene a key check per scene (A, B, C) that executes `ENTER`.  The script holds those keys on chosen ticks.  A scene's INIT is empty (the
// scene starts from the reset state) or draws; the FRAME moves the sprites at random (RND is the runtime's own xorshift in both runs) and prints, and the ENTER check is before the sprites, after them
// or after the text, so a switch can happen in a tick that moves sprites and prints text.
//
// WHAT IS COMPARED, after every tick k (the harness samples the machine at the end of the refresh in which tick k finished; record k of the interpreter = the state after tick k; record 0 = after INIT):
//   state     variables, arrays, cells, attributes, cursor, text attribute, border and every sprite's visibility and position equal the interpreter's (diffRecords, as the other differential suites)
//   fine      (a tick of a fine scene) V_FINE = 1 and $FF = 2 (the shadow V_SHADOW_FF too).  The screen ($4000 bitmap, $6000 colours) is the fine picture (finePicture of src/lang/arcade/arcade-fine.js, from the
//             interpreter's record) of record k - 1: a fine tick publishes the groups the last tick composed right after the frame interrupt and composes its own changes off screen (method BD: the one tick
//             delay of tests/arcade-starfall-fine.mjs), so at the end of the tick the screen is the picture of the previous record; a compose that wrote the screen would be seen here.  At the end of the tick that
//             switched a fine scene on (ENTER from a two-buffer scene) the screen is the picture RT_FINEMODE built from the cell map, which is the record itself when the scene's INIT draws nothing (contract 4.2);
//             the next tick's check then holds the INIT's changes to the picture
//   plain     (a two-buffer tick) V_FINE = 0, $FF = 0 or 1 (never bit 1), the file the tick finished (V_HIDDEN) holds the picture of record k in bitmap AND 8 x 8 attributes (the cells, then the sprites over
//             them; a sprite takes the colour of the cells under it: finePicture without row colours), and the file on screen is the other one, holding the picture of record k - 1 (not checked for tick 1: the boot's
//             file; after a switch out of a fine scene it is the cell map RT_FINEMODE 0 rebuilt, which is the record when the INIT draws nothing, contract 4.2)
//   frames    (the frame-level runs, section 5) every frame the beam paints around a switch is, group by group (8 x 1 pixels in their colour, as the viewer sees them), a group of one of the pictures around it
//             (records n - 3 .. n + 1; fine or two-buffer as their scenes are), black (the plain frame of a switch) or a group caught between the write of its bitmap and of its colour byte; never anything else
//             (contract 4.3: no old bitmap under new colours).  The INITs of those games are empty, so every picture the machine shows is a record of the run.
//
// Sections: 1 the programs and the runtime  2 directed switch runs (every direction: plain -> fine, fine -> plain, fine -> fine and plain -> plain, with the same scene and another, a fine first scene, several
// switches in a row, a switch in a tick that moves sprites and prints)  3 seeded random programs and scripts  4 negative controls (the comparison sees wrong pictures)  5 the frame level  6 coverage
import { performance } from 'node:perf_hooks';

import { finePicture, glyphSource } from '../src/lang/arcade/arcade-fine.js';
import { rowOff } from '../src/lang/arcade/arcade-display.js';
import { real, compileReal, runReal, interpFor, diffRecords } from './arcade-m5-harness.mjs';
import { FONT } from '../arcade/tests/m3-common.mjs';
import { rng } from '../arcade/tests/m3-scenes.mjs';
import { frameKeys, groupKey, isSplit } from '../arcade/spike/fine/fine-check.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
const ONLY = !!process.env.ARCADE_M19D_SEEDS;                  // only section 3, for the seeds named
let passed = 0, failed = 0, nChecks = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const info = (s) => console.log('  INFO  ' + s);
const T0 = performance.now();
let tSec = T0;
const lap = (name) => { const t = performance.now(); info(`${name}: ${((t - tSec) / 1000).toFixed(1)} s`); tSec = t; };

const R0 = real();
if (!R0.ok) { console.log(`  SKIP  the real v2 runtime (${R0.why})`); console.log('\nPASS: arcade-m19-differential (0 checks, 1 skipped)'); process.exit(0); }
const S = R0.SYM;
for (const n of ['RT_FINEMODE', 'FINE_FRAME', 'FINE_WORK', 'V_FINE', 'V_HIDDEN', 'V_SHADOW_FF']) {
  if (S[n] === undefined) { console.log(`  SKIP  the runtime has no ${n} (no fine colour)`); console.log('\nPASS: arcade-m19-differential (0 checks, 1 skipped)'); process.exit(0); }
}
const hex = (v, w = 2) => '$' + (v >>> 0).toString(16).padStart(w, '0');
const hex2 = (v) => (v & 255).toString(16).toUpperCase().padStart(2, '0');
const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);

// =================================================================================================================
// the programs
// =================================================================================================================
const SIZES = [[8, 8], [16, 16], [8, 5], [16, 9], [16, 8], [8, 12], [16, 3]];
const KEYCODE = [65, 66, 67];                                   // A B C: ENTER s0 / s1 / s2

/**
 * A game: scenes with a fine / two-buffer setting each.  cfg: { fine: [bool per scene], initEmpty: [bool per scene] | bool, pools: number of sprite pools (1..4), maxPhases (<= 32),
 * enterAt: ['start' | 'mid' | 'end' per scene], busy: 0..1 (how much a FRAME draws), moves: 0..1, edge: sprites may leave the screen }
 */
function genGame(R, cfg) {
  const nS = cfg.fine.length, nT = R.int(7, 12), nPools = cfg.pools ?? R.int(2, 4);
  const tile = () => ({ rows: Array.from({ length: 8 }, () => ({ bits: hex2(R.chance(0.15) ? (R.chance(0.5) ? 0 : 255) : R.int(0, 255)), ink: R.int(0, 7), paper: R.int(0, 7), bright: R.chance(0.35) ? 1 : 0 })), flags: 0 });
  const assets = { tilesets: { ts: { tiles: Array.from({ length: nT }, tile) } }, sprites: {}, maps: {}, scenes: {} };
  // the sprite assets: sizes and phases; at most `maxPhases` phases in all
  let left = cfg.maxPhases ?? 32;
  const pools = [];
  for (let p = 0; p < nPools; p++) {
    const [w, h] = R.pick(SIZES);
    const phases = Math.min(R.pick([8, 8, 4, 4, 2, 1]), Math.max(1, left - (nPools - p - 1)));
    const ph = [8, 4, 2, 1].find((x) => x <= phases);
    left -= ph;
    const rows = Array.from({ length: h }, () => {
      const full = R.chance(0.3), none = R.chance(0.1);
      const mask = none ? 0 : full ? (w === 8 ? 255 : 65535) : R.int(0, w === 8 ? 255 : 65535);
      const bits = none ? 0 : (R.int(0, w === 8 ? 255 : 65535) & mask) | (R.chance(0.2) ? mask : 0);
      return { bits: bits.toString(16).toUpperCase().padStart(w / 4, '0'), mask: mask.toString(16).toUpperCase().padStart(w / 4, '0'), ink: R.int(0, 7), paper: R.int(0, 7), bright: 0 };
    });
    const name = 'sp' + p;
    assets.sprites[name] = { w, h, phases: ph, rows };
    pools.push({ name, asset: name, n: R.pick([1, 2, 2, 3]), w, h, ph });
  }
  // the maps: m0 (the first map: what every ENTER puts back), one full-screen map for each scene, and a small one
  const fullMap = (density) => ({ w: 32, h: 24, cells: Array.from({ length: 768 }, () => (R.chance(density) ? R.int(0, nT - 1) : 0)) });
  assets.maps.m0 = fullMap(0.35);
  for (let s = 0; s < nS; s++) assets.maps['mm' + s] = fullMap(0.15 + 0.5 * R.next());
  assets.maps.small = { w: 5, h: 3, cells: Array.from({ length: 15 }, () => R.int(0, nT - 1)) };
  for (let s = 0; s < nS; s++) if (cfg.fine[s]) assets.scenes['s' + s] = { display: 'fine' };
  const L = [];
  L.push('GAME "m19d"', `FRAMERATE ${cfg.rate ?? 10}`, 'TILESET ts = "ts"', 'MAP m0 = "m0"');
  for (let s = 0; s < nS; s++) L.push(`MAP mm${s} = "mm${s}"`);
  L.push('MAP small = "small"');
  for (const p of pools) L.push(`SPRITE ${p.name}(${p.n}) = "${p.asset}"`);
  L.push(`DIM ${pools.map((p) => `${p.name}x(3), ${p.name}y(3), ${p.name}v(3)`).join(', ')}, i, q`);
  const sceneSrc = [];
  const scenes = [];
  for (let s = 0; s < nS; s++) {
    const empty = Array.isArray(cfg.initEmpty) ? cfg.initEmpty[s] : !!cfg.initEmpty;
    const at = cfg.enterAt?.[s] ?? R.pick(['mid', 'end', 'end', 'mid', 'start']);
    const spread = R.pick([40, 80, 120]), cx = R.int(60, 160), cy = R.int(40, 120);
    const step = R.pick([2, 5, 9, 17]);
    const lo = cfg.edge ? -R.int(0, 20) : 0, hiX = cfg.edge ? 239 + R.int(0, 12) : 239, hiY = cfg.edge ? 175 + R.int(0, 10) : 176;
    const active = pools.filter((_, i) => i === 0 || R.chance(0.7));
    // INIT
    const init = [];
    if (!empty) {
      if (R.chance(0.6)) init.push(`LOADMAP mm${s}`);
      if (R.chance(0.5)) init.push(`LOADMAP small AT ${R.int(0, 27)}, ${R.int(0, 21)}`);
      for (let k = R.int(0, 4); k > 0; k--) init.push(`TILE ${R.int(0, 31)}, ${R.int(0, 23)} = ${R.int(0, nT - 1)}`);
      if (R.chance(0.5)) init.push(`FILL ${R.int(0, 28)}, ${R.int(0, 20)}, ${R.int(1, 5)}, ${R.int(1, 4)} = ${R.int(0, nT - 1)}`);
      if (R.chance(0.7)) init.push(`INK ${R.int(0, 7)} : PAPER ${R.int(0, 7)} : BRIGHT ${R.int(0, 1)}`, `PRINT AT ${R.int(0, 22)}, ${R.int(0, 24)}; "S${s} init"`);
      if (R.chance(0.5)) init.push(`FILLC ${R.int(0, 24)}, ${R.int(0, 20)}, ${R.int(1, 6)}, ${R.int(1, 3)} = ${R.int(33, 120)}`);
      for (const p of active.slice(0, 2)) if (R.chance(0.6)) init.push(`${p.name}v(0) = 1 : ${p.name}x(0) = ${R.int(0, 200)} : ${p.name}y(0) = ${R.int(0, 150)} : SHOW ${p.name}(0) AT ${p.name}x(0), ${p.name}y(0)`);
    }
    // FRAME
    const sprites = [];
    for (const p of active) {
      sprites.push(`    FOR i = 0 TO ${p.n - 1}`,
        `      IF RND(${R.pick([10, 16, 40])}) = 0 THEN`, `        HIDE ${p.name}(i) : ${p.name}v(i) = 0`, '      ELSE',
        `        IF ${p.name}v(i) = 0 THEN ${p.name}x(i) = ${cx} + RND(${spread}) : ${p.name}y(i) = ${cy} + RND(${spread}) : ${p.name}v(i) = 1 ENDIF`,
        `        ${p.name}x(i) = ${p.name}x(i) + RND(${2 * step + 1}) - ${step}`, `        ${p.name}y(i) = ${p.name}y(i) + RND(${2 * step + 1}) - ${step}`,
        `        IF RND(${cfg.jump ?? 14}) = 0 THEN ${p.name}x(i) = RND(${hiX - lo + 1}) + ${lo} : ${p.name}y(i) = RND(${hiY - lo + 1}) + ${lo} ENDIF`,
        `        IF ${p.name}x(i) < ${lo} THEN ${p.name}x(i) = ${lo} ENDIF`, `        IF ${p.name}x(i) > ${hiX} THEN ${p.name}x(i) = ${hiX} ENDIF`,
        `        IF ${p.name}y(i) < ${lo} THEN ${p.name}y(i) = ${lo} ENDIF`, `        IF ${p.name}y(i) > ${hiY} THEN ${p.name}y(i) = ${hiY} ENDIF`,
        `        SHOW ${p.name}(i) AT ${p.name}x(i), ${p.name}y(i)`, '      ENDIF', '    NEXT i');
    }
    const busy = cfg.busy ?? 0.5;
    const draw = [
      `    IF RND(${Math.max(1, Math.round(2 / busy))}) = 0 THEN`, '      INK RND(8) : PAPER RND(8) : BRIGHT RND(2)', `      PRINT AT RND(23), RND(22); "S${s} "; t; " "`, '    ENDIF',
      `    IF RND(${Math.max(1, Math.round(2 / busy))}) = 0 THEN TILE RND(32), RND(24) = RND(${nT}) ENDIF`,
      `    IF RND(${Math.max(1, Math.round(2 / busy))}) = 0 THEN TILE RND(32), RND(24) = RND(${nT}) : TILE RND(32), RND(24) = RND(${nT}) ENDIF`,
      `    IF RND(${Math.round(12 / busy)}) = 0 THEN FILL RND(30), RND(22), 1 + RND(5), 1 + RND(4) = RND(${nT}) ENDIF`,
      `    IF RND(${Math.round(15 / busy)}) = 0 THEN FILLC RND(30), RND(22), 1 + RND(6), 1 + RND(3) = 33 + RND(90) ENDIF`,
      `    IF RND(${Math.round(20 / busy)}) = 0 THEN LOADMAP small AT RND(27), RND(21) ENDIF`,
      `    IF RND(${Math.round(40 / busy)}) = 0 THEN LOADMAP mm${s} ENDIF`,
      ...(cfg.cls ? [`    IF RND(${cfg.cls}) = 0 THEN CLS ENDIF`] : []),
    ];
    const keysB = [0, 1, 2].slice(0, nS).map((k) => `    IF KEYDOWN("${String.fromCharCode(KEYCODE[k])}") THEN ENTER s${k} ENDIF`);
    const body = at === 'start' ? [...keysB, ...sprites, ...draw] : at === 'mid' ? [...sprites, ...keysB, ...draw] : [...sprites, ...draw, ...keysB];
    sceneSrc.push(`SCENE s${s}`, '  DIM t', '  PROC INIT():', ...init.map((x) => '    ' + x), '  ENDP', '  PROC FRAME():', '    t = t + 1', ...body, '  ENDP', 'ENDSCENE');
    scenes.push({ empty, at, active: active.map((p) => p.name), fine: cfg.fine[s] });
  }
  return { src: L.concat(sceneSrc).join('\n') + '\n', assets, scenes, pools, nS, cfg };
}

/** The script: Map tick -> scene index to enter (held for that tick only). */
const keysFor = (script) => (k) => (script.has(k) ? [KEYCODE[script.get(k)]] : []);

// =================================================================================================================
// running one game and comparing
// =================================================================================================================
const picCache = new WeakMap();
/** Both pictures of an interpreter record: fine (null when the record is two-buffer) and plain ({bits, attrs}). */
function picsOf(want, info, isFine, rec, rid) {
  let c = picCache.get(want);
  if (!c) { c = new Map(); picCache.set(want, c); }
  let p = c.get(rid);
  if (p) return p;
  const glyph = glyphSource({ font: FONT, tileBytes: info.tileBytes });
  const plain = finePicture({ cells: rec.cells, attrs: rec.attrs, tileRows: null, sprites: rec.sprites, instAsset: info.instAsset, assets: info.assets, glyph });
  const fine = isFine ? finePicture({ cells: rec.cells, attrs: rec.attrs, tileRows: info.tileRows, sprites: rec.sprites, instAsset: info.instAsset, assets: info.assets, glyph }) : null;
  p = { fine, plain: { bits: plain.bits, attrs: Uint8Array.from(rec.attrs) }, rec };
  c.set(rid, p);
  return p;
}
/** The pictures after tick n (0 = after the first INIT): `ctx` = {want, info (the interpreter's fine info: tile rows, tile bytes, assets), isFine(scene index)}. */
const pictureAt = (ctx, n) => { const rec = n === 0 ? ctx.want.init : ctx.want.ticks[n - 1]; return picsOf(ctx.want, ctx.info, ctx.isFine(rec.scene), rec, n); };

const diffFine = (m, pic) => {
  const b = m.ram, n0 = 0x4000, c0 = 0x6000;
  let n = 0, first = null;
  for (let i = 0; i < 6144; i++) if (b[n0 + i] !== pic.bits[i] || b[c0 + i] !== pic.colours[i]) { n++; first ??= `$${(n0 + i).toString(16)}: bitmap ${hex(b[n0 + i])} colour ${hex(b[c0 + i])}, picture ${hex(pic.bits[i])} / ${hex(pic.colours[i])}`; }
  return n ? `${n} groups differ, first ${first}` : null;
};
const diffPlain = (m, file, pic) => {
  const base = 0x4000 + 0x2000 * file;
  for (let i = 0; i < 6144; i++) if (m.ram[base + i] !== pic.bits[i]) { const y = ((i >> 11) << 6) | (((i >> 5) & 7) << 3) | ((i >> 8) & 7); return `file ${file + 1}: pixel row ${y}, byte column ${i & 31}: ${hex(m.ram[base + i])}, picture ${hex(pic.bits[i])}`; }
  for (let i = 0; i < 768; i++) if (m.ram[base + 0x1800 + i] !== pic.attrs[i]) return `file ${file + 1}: attribute row ${i >> 5}, column ${i & 31}: ${hex(m.ram[base + 0x1800 + i])}, picture ${hex(pic.attrs[i])}`;
  return null;
};

/**
 * Compile `game`, run it `ticks` ticks on the real runtime and on the interpreter, compare state and pictures.  Returns {ok, problems[], stats, ...}.
 * opts: { frames: the frame-level check of contract 4.3 (needs a game whose INITs are empty), label }.
 */
function runCase(game, script, ticks, opts = {}) {
  const problems = [], stats = { checks: 0, ticks, fineTicks: 0, plainTicks: 0, switches: {}, onBuilt: 0, offBuilt: 0, publishes: 0, shownChecks: 0, frames: 0, frameBad: 0, frameSplit: 0, splitMax: 0, splitNotes: [], switchWithSprites: 0, first: null };
  const bad = (m) => { if (problems.length < 8) problems.push(m); };
  let res;
  try { res = compileReal(game.src, game.assets); } catch (e) { return { ok: false, problems: ['compile: ' + e.message], stats }; }
  const keys = keysFor(script);
  let want;
  try { want = interpFor(game.src, game.assets, null, { scenes: game.assets.scenes })(ticks, { keys: (t, c) => keys(t).includes(c) }); } catch (e) { return { ok: false, problems: ['interpreter: ' + e.message], stats }; }
  // `info`: tile rows / bytes and the sprite art for the pictures; a game with no fine scene has none in its interpreter run, so it is read from a run with every scene set to fine (the same states)
  let info = want.fine;
  if (!info) { const all = Object.fromEntries(game.scenes.map((_, i) => ['s' + i, { display: 'fine' }])); try { info = interpFor(game.src, game.assets, null, { scenes: all })(1, {}).fine; } catch (e) { return { ok: false, problems: ['interpreter (fine info): ' + e.message], stats }; } }
  const ctx = { want, info, isFine: (sc) => game.scenes[sc].fine };
  const fineOf = (n) => ctx.isFine((n === 0 ? want.init : want.ticks[n - 1]).scene);
  for (const rec of [want.init, ...want.ticks]) if (want.fine && rec.fine !== ctx.isFine(rec.scene)) bad(`the interpreter's record of tick ${rec.tick} says fine = ${rec.fine}, the setting says ${ctx.isFine(rec.scene)}`);
  const entered = (k) => script.has(k);
  const emptyOf = (n) => game.scenes[(n === 0 ? want.init : want.ticks[n - 1]).scene].empty;
  const fineScenesInRun = want.ticks.filter((r) => ctx.isFine(r.scene)).length;
  stats.first = fineOf(0) ? 'fine' : 'plain';
  const frameHook = opts.frames ? makeFrameCheck(ctx, script, stats, bad) : null;

  const hooks = {
    afterFrame(m, f) { frameHook?.(m, f); },
    afterTick(k, m) {
      const fk = fineOf(k), pf = fineOf(k - 1), rec = pictureAt(ctx, k), prev = pictureAt(ctx, k - 1);
      const sw = `${pf ? 'F' : 'P'}->${fk ? 'F' : 'P'}${entered(k) ? '' : ' (no ENTER)'}`;
      if (entered(k)) { stats.switches[sw] = (stats.switches[sw] ?? 0) + 1; if (prev.rec.sprites.some((s) => s.visible)) stats.switchWithSprites++; }
      stats.checks += 2;
      const vf = m.ram[S.V_FINE];
      if (vf !== (fk ? 1 : 0)) bad(`tick ${k} (${sw}): V_FINE ${vf}, the interpreter's scene is ${fk ? 'fine' : 'two-buffer'}`);
      if (fk) {
        stats.fineTicks++;
        if (m.portFF !== 2 || m.ram[S.V_SHADOW_FF] !== 2) bad(`tick ${k} (${sw}): port $FF ${m.portFF}, shadow ${m.ram[S.V_SHADOW_FF]}, a fine scene needs 2`);
        stats.checks++;
        if (!pf && entered(k)) {
          // plain -> fine: RT_FINEMODE built the fine picture of the cell map (no sprites) and the compose of this tick has not been published yet
          if (emptyOf(k)) { stats.onBuilt++; stats.checks++; const d = diffFine(m, rec.fine); if (d) bad(`tick ${k} (${sw}, INIT empty): the picture RT_FINEMODE built differs from the record's: ${d}`); }
        } else if (pf) {
          const d = diffFine(m, prev.fine); stats.checks++; stats.publishes++;
          if (d) bad(`tick ${k} (${sw}): at the end of the tick the screen is not the fine picture of the state the last tick left (the publish, and nothing written by the compose): ${d}`);
        }
      } else {
        stats.plainTicks++;
        const hid = m.ram[S.V_HIDDEN] & 1, shown = m.portFF & 1;
        if (m.portFF & ~1) bad(`tick ${k} (${sw}): port $FF ${m.portFF}: a two-buffer scene shows file 1 or 2 only`);
        if (shown !== (hid ^ 1)) bad(`tick ${k} (${sw}): file ${shown + 1} is shown but the file the tick finished is ${hid + 1} (V_HIDDEN)`);
        let d = diffPlain(m, hid, rec.plain); stats.checks++;
        if (d) bad(`tick ${k} (${sw}): the file the tick finished: ${d}`);
        if (!pf && k > 1) { d = diffPlain(m, shown, prev.plain); stats.checks++; stats.shownChecks++; if (d) bad(`tick ${k} (${sw}): the file on screen is not the previous picture: ${d}`); }
        else if (entered(k) && emptyOf(k)) { stats.offBuilt++; stats.checks++; d = diffPlain(m, shown, rec.plain); if (d) bad(`tick ${k} (${sw}, INIT empty): the file RT_FINEMODE 0 left on screen is not the cell map: ${d}`); }
      }
    },
  };
  let got;
  try { got = runReal(res, { ticks, keys, video: !!opts.frames, hooks }); } catch (e) { return { ok: false, problems: [...problems, 'run: ' + e.message], stats }; }
  if (got.error) bad('the cartridge ran into: ' + got.error);
  const d = diffRecords(got.ticks, want, { sprites: true, skip: ['sound'] });
  stats.checks += ticks;
  if (d) bad('state against the interpreter: ' + d);
  stats.fineRecs = fineScenesInRun;
  stats.checks += stats.frames;
  return { ok: problems.length === 0, problems, stats, res, want, got, ctx };
}

/**
 * The frame check of contract 4.3.  Every frame TSRun paints is read as 6,144 group keys.  Around a switch (the tick that executed an ENTER, and the 20 refreshes after it) a group's key must be the
 * same group of: one of the pictures the run shows around it (the pictures of the records k - 2 .. k + 1, fine or plain as their scenes are), or black (the plain frame RT_FINEMODE shows, ink = paper = 0).
 */
function makeFrameCheck(ctx, script, stats, bad) {
  const want = ctx.want;
  const cache = new Map();
  /** per group (y * 32 + c) of the picture after tick n: its key, bitmap byte and colour byte (a two-buffer picture: the 8 x 8 attribute of the cell) */
  const groupsOf = (n) => {
    n = Math.max(0, Math.min(n, want.ticks.length));
    let k = cache.get(n);
    if (!k) {
      const p = pictureAt(ctx, n);
      k = { keys: new Uint32Array(6144), bits: new Uint8Array(6144), cols: new Uint8Array(6144) };
      for (let y = 0; y < 192; y++) for (let c = 0; c < 32; c++) {
        const g = y * 32 + c, o = rowOff(y, c);
        k.bits[g] = p.fine ? p.fine.bits[o] : p.plain.bits[o];
        k.cols[g] = p.fine ? p.fine.colours[o] : p.plain.attrs[(y >> 3) * 32 + c];
        k.keys[g] = groupKey(k.bits[g], k.cols[g]);
      }
      cache.set(n, k);
    }
    return k;
  };
  let refresh = 0, lastSwitchTick = -100, since = 1000;
  return (m) => {
    refresh++;
    const n = rd16(m, S.V_TICKS);
    if (script.has(n + 1) || script.has(n)) { if (lastSwitchTick !== n) { lastSwitchTick = n; since = 0; } }
    since++;
    if (since > 24 || refresh < 8) return;
    // the frame this refresh painted (m.pixels) as group keys; the pictures around it are those of the records n - 3 .. n + 1
    const shown = frameKeys(m.pixels);
    const cands = [];
    for (let j = n - 3; j <= n + 1; j++) cands.push(groupsOf(j));
    let broken = 0, split = 0, first = null;
    for (let g = 0; g < 6144; g++) {
      const s = shown[g];
      if (s === 0) continue;                                                    // black: the plain frame of a switch
      let ok = false;
      for (const c of cands) if (c.keys[g] === s) { ok = true; break; }
      if (ok) continue;
      // a group caught between the write of its bitmap byte and of its colour byte (or inside TSRun's 4 T paint of it): bitmap and colour of two neighbouring pictures
      let sp = false;
      for (let a = 0; a + 1 < cands.length && !sp; a++) sp = isSplit(s, cands[a].bits[g], cands[a].cols[g], cands[a + 1].bits[g], cands[a + 1].cols[g]);
      if (sp) split++; else broken++;
      first ??= `y ${g >> 5}, byte ${g & 31}: key ${(s >>> 0).toString(16)}`;
    }
    stats.frames++;
    if (broken) { stats.frameBad++; bad(`frame at refresh ${refresh} (tick ${n}, switch tick ${lastSwitchTick + 1}): ${broken} groups are neither a picture around the switch, a split write of two of them, nor black, first ${first}`); }
    else if (split) { stats.frameSplit++; stats.splitMax = Math.max(stats.splitMax, split); if (stats.splitNotes.length < 4) stats.splitNotes.push(`refresh ${refresh} (tick ${n}): ${split} group(s) caught mid-write, ${first}`); }
  };
}

// =================================================================================================================
// output helpers
// =================================================================================================================
const totals = { checks: 0, runs: 0, ticks: 0, switches: {}, fineTicks: 0, plainTicks: 0, onBuilt: 0, offBuilt: 0, publishes: 0, switchWithSprites: 0, shown: 0, firstFine: 0, frames: 0, frameSplit: 0, frameSplitMax: 0 };
function account(st) {
  totals.checks += st.checks; totals.runs++; totals.ticks += st.ticks; totals.fineTicks += st.fineTicks; totals.plainTicks += st.plainTicks; totals.onBuilt += st.onBuilt;
  totals.frameSplit += st.frameSplit; totals.frameSplitMax = Math.max(totals.frameSplitMax, st.splitMax); totals.offBuilt += st.offBuilt; totals.publishes += st.publishes; totals.switchWithSprites += st.switchWithSprites; totals.shown += st.shownChecks; totals.frames += st.frames;
  if (st.first === 'fine') totals.firstFine++;
  for (const [k, v] of Object.entries(st.switches)) totals.switches[k] = (totals.switches[k] ?? 0) + v;
}
const sw = (st) => Object.entries(st.switches).map(([k, v]) => `${k} ${v}`).join(', ') || 'no switch';
function report(name, r, game, script) {
  account(r.stats);
  nChecks += r.stats.checks;
  const msg = r.ok ? `${r.stats.ticks} ticks, ${r.stats.fineTicks} fine and ${r.stats.plainTicks} two-buffer; ${sw(r.stats)}` : r.problems.join(' | ');
  check_(name, r.ok, msg + (r.ok || ONLY || !/^seed /.test(name) ? '' : `; rerun alone with ARCADE_M19D_SEEDS=${name.match(/^seed (\d+)/)[1]}-${name.match(/^seed (\d+)/)[1]} to print the program`));
  if (!r.ok && game && (process.env.ARCADE_M19D_SEEDS || process.env.ARCADE_M19D_PRINT)) {
    console.log('--- source ---\n' + game.src + '--- assets ---\n' + JSON.stringify(game.assets) + '\n--- script (tick: scene) ---\n' + JSON.stringify([...script]));
  }
  return r.ok;
}

// =================================================================================================================
// 1. the programs and the runtime
// =================================================================================================================
console.log('1. The programs and the runtime');
{
  const R = rng(1);
  const g = genGame(R, { fine: [true, false, true], initEmpty: false, pools: 3 });
  let res;
  try { res = compileReal(g.src, g.assets); } catch (e) { check_('a generated game compiles for the real v2 runtime', false, e.message); process.exit(1); }
  check_('the setting makes s0 and s2 fine and s1 two-buffer (sceneDisplayPlan)', JSON.stringify(res.scenes.map((s) => s.built)) === JSON.stringify(['fine', 'buffers', 'fine']), JSON.stringify(res.scenes.map((s) => s.built)));
  const phases = Object.values(g.assets.sprites).reduce((n, a) => n + a.phases, 0);
  check_(`the sprite art has ${phases} phases in all (the cap of a game with a fine scene is 32)`, phases <= 32);
  check_('the runtime has the fine tick (RT_FINEMODE, FINE_FRAME)', S.RT_FINEMODE > 0 && S.FINE_FRAME > 0);
  nChecks += 3;
}

// =================================================================================================================
// 2. directed runs: every direction of a switch
// =================================================================================================================
console.log('\n2. Directed runs: fine and two-buffer scenes switched in every direction, interpreter against the real runtime, picture after every tick');
const seq = (...pairs) => new Map(pairs);                                // (tick, scene) pairs
const DIRECTED = [
  // name, cfg, script
  ['plain -> fine -> plain (INIT empty), the switch in a tick that moves sprites and prints', { fine: [false, true], initEmpty: true, pools: 3, enterAt: ['end', 'end'], busy: 0.9 }, seq([12, 1], [26, 0], [40, 1], [54, 0])],
  ['plain -> fine -> plain (INITs draw)', { fine: [false, true], initEmpty: false, pools: 3, enterAt: ['mid', 'end'], busy: 0.7 }, seq([12, 1], [26, 0], [40, 1], [54, 0])],
  ['fine -> fine (another scene and the same scene again)', { fine: [true, true, true], initEmpty: false, pools: 3, enterAt: ['end', 'mid', 'end'], busy: 0.8 }, seq([10, 1], [20, 2], [30, 2], [40, 0], [41, 0], [50, 1])],
  ['fine -> fine with empty INITs', { fine: [true, true], initEmpty: true, pools: 4, enterAt: ['end', 'end'], busy: 0.9 }, seq([9, 1], [18, 0], [27, 0], [36, 1])],
  ['plain -> plain (another scene and the same scene again)', { fine: [false, false, false], initEmpty: false, pools: 3, enterAt: ['end', 'mid', 'end'], busy: 0.8 }, seq([10, 1], [20, 2], [30, 2], [40, 0])],
  ['a fine FIRST scene (the switch at init_entry), then out and back', { fine: [true, false, true], initEmpty: false, pools: 3, enterAt: ['end', 'end', 'mid'], busy: 0.8 }, seq([10, 1], [24, 2], [40, 0], [55, 1])],
  ['a fine first scene with an empty INIT', { fine: [true, false], initEmpty: true, pools: 2, enterAt: ['end', 'end'], busy: 0.9 }, seq([8, 1], [20, 0], [32, 1], [44, 0])],
  ['several switches in a row (every tick, then every second tick), fine and two-buffer alternating', { fine: [true, false, true], initEmpty: false, pools: 3, enterAt: ['start', 'start', 'start'], busy: 0.8 }, (() => { const m = new Map(); let t = 8, s = 1; for (let i = 0; i < 6; i++, t++) { m.set(t, s); s = (s + 1) % 3; } for (let i = 0; i < 6; i++, t += 2) { m.set(t, s); s = (s + 1) % 3; } return m; })()],
  ['several switches in a row at the end of the tick (sprites and text drawn first)', { fine: [false, true, false], initEmpty: false, pools: 4, enterAt: ['end', 'end', 'end'], busy: 1 }, (() => { const m = new Map(); let t = 8, s = 1; for (let i = 0; i < 10; i++, t++) { m.set(t, s); s = (s + 1) % 3; } return m; })()],
  ['a switch in a tick that CLSes and fills; sprites at the screen edges', { fine: [true, false], initEmpty: false, pools: 4, enterAt: ['mid', 'end'], busy: 1, cls: 3, edge: true, jump: 5 }, seq([11, 1], [23, 0], [35, 1], [47, 0], [48, 1])],
];
const QUICK_DIRECTED = new Set([0, 2, 4, 5, 7, 9]);       // (one of each direction, a fine first scene, the switch in a row, the edges)
for (let i = 0; i < DIRECTED.length; i++) {
  if (ONLY) break;
  if (QUICK && !QUICK_DIRECTED.has(i)) continue;
  const [name, cfg, script] = DIRECTED[i];
  const R = rng(1000 + i);
  const g = genGame(R, cfg);
  const r = runCase(g, script, Math.max(...script.keys()) + 12);
  report(name, r, g, script);
}

// =================================================================================================================
// 3. seeded random programs and scripts
// =================================================================================================================
lap('section 2');
console.log('\n3. Random programs: 2 or 3 scenes, random fine / two-buffer, sprites of every size and phase count, ENTER at random ticks');
{
  const [lo, hi] = process.env.ARCADE_M19D_SEEDS ? process.env.ARCADE_M19D_SEEDS.split('-').map(Number) : [1, QUICK ? 5 : 60];
  let okAll = 0, runs = 0;
  const t1 = performance.now();
  for (let seed = lo; seed <= (hi ?? lo); seed++) {
    const R = rng(7_000 + seed);
    const nS = R.pick([2, 3, 3]);
    const fine = Array.from({ length: nS }, () => R.chance(0.55));
    if (fine.every((x) => x) || fine.every((x) => !x)) fine[R.int(0, nS - 1)] = !fine[0];
    const cfg = { rate: R.pick([12, 20, 20, 30]), fine, initEmpty: Array.from({ length: nS }, () => R.chance(0.4)), pools: R.int(1, 4), busy: 0.3 + 0.7 * R.next(), edge: R.chance(0.4), jump: R.pick([6, 14, 30]), cls: R.chance(0.2) ? 7 : 0, maxPhases: R.pick([32, 32, 20, 12]) };
    const g = genGame(R, cfg);
    const ticks = QUICK ? 45 : R.int(70, 110);
    const script = new Map();
    for (let t = 6; t <= ticks; t++) if (R.chance(R.pick([0.08, 0.15, 0.3]) )) script.set(t, R.int(0, nS - 1));
    runs++;
    const r = runCase(g, script, ticks);
    if (report(`seed ${seed}: ${nS} scenes (${fine.map((x) => (x ? 'fine' : 'plain')).join(', ')}), ${g.pools.length} pools, ${ticks} ticks, ${script.size} ENTERs`, r, g, script)) okAll++;
  }
  info(`${okAll} of ${runs} random programs equal the interpreter in state and picture on every tick (${((performance.now() - t1) / 1000).toFixed(1)} s)`);
}

// =================================================================================================================
// 4. negative controls
// =================================================================================================================
lap('section 3');
console.log('\n4. Negative controls: the comparisons do see a wrong picture');
if (!ONLY) {
  const R = rng(4242);
  const g = genGame(R, { fine: [false, true], initEmpty: true, pools: 3, enterAt: ['end', 'end'], busy: 0.9 });
  const rPlain = runCase(g, seq([10, 1], [25, 0]), 40);       // ends in the two-buffer scene
  const rFine = runCase(g, seq([10, 1]), 40);                 // ends in the fine scene
  check_('the reference runs are equal to the interpreter', rPlain.ok && rFine.ok, [...rPlain.problems, ...rFine.problems].join(' | '));
  if (rPlain.ok && rFine.ok) {
    // the machines are left as the last tick left them: the right picture is equal, a changed byte or another tick's picture is seen
    const mF = rFine.got.machine, mP = rPlain.got.machine;
    const good = pictureAt(rFine.ctx, 39).fine;
    check_('fine: the picture of the last state equals the screen, and a copy with one bitmap bit, one colour byte or one group moved is told apart',
      diffFine(mF, good) === null
      && diffFine(mF, { bits: good.bits.map((v, i) => (i === 2000 ? v ^ 1 : v)), colours: good.colours }) !== null
      && diffFine(mF, { bits: good.bits, colours: good.colours.map((v, i) => (i === 5000 ? v ^ 8 : v)) }) !== null
      && diffFine(mF, pictureAt(rFine.ctx, 30).fine) !== null);
    const hid = mP.ram[S.V_HIDDEN] & 1, pl = pictureAt(rPlain.ctx, 40).plain;
    check_('two-buffer: the finished file equals the picture of the last state, and a changed bitmap byte, attribute or the previous tick\'s picture is seen',
      diffPlain(mP, hid, pl) === null
      && diffPlain(mP, hid, { bits: pl.bits.map((v, i) => (i === 3000 ? v ^ 0x10 : v)), attrs: pl.attrs }) !== null
      && diffPlain(mP, hid, { bits: pl.bits, attrs: pl.attrs.map((v, i) => (i === 700 ? v ^ 1 : v)) }) !== null
      && diffPlain(mP, hid, pictureAt(rPlain.ctx, 38).plain) !== null);
    // a fine scene shows colours per row: the 8 x 8 picture of the same state is different
    let rowsDiffer = false;
    const fp = pictureAt(rFine.ctx, 30);
    for (let i = 0; i < 6144 && !rowsDiffer; i++) if (fp.fine.colours[i] !== fp.plain.attrs[(((i >> 11) << 3) | ((i >> 5) & 7)) * 32 + (i & 31)]) rowsDiffer = true;
    check_('the fine picture of a state differs from the 8 x 8 attribute picture of the same state (the tiles carry a colour on each pixel row)', rowsDiffer);
    // the script matters: the interpreter without the ENTERs is not the machine
    const want2 = interpFor(g.src, g.assets, null, { scenes: g.assets.scenes })(40, { keys: () => false });
    check_('the interpreter run without the ENTERs differs from the machine', diffRecords(rFine.got.ticks, want2, { sprites: true, skip: ['sound'] }) !== null);
    // the frame check on made-up frames: a frame that is a picture around the switch is clean, black is clean, old bitmap under new colours is told
    const st = { frames: 0, frameBad: 0, frameSplit: 0, splitMax: 0, splitNotes: [] }, msgs = [];
    const fc = makeFrameCheck(rFine.ctx, seq([21, 1]), st, (x) => msgs.push(x));
    const fake = { ram: new Uint8Array(65536), pixels: new Uint8Array(640 * 240) };
    fake.ram[S.V_TICKS] = 20;
    const paint = (keyOf) => { for (let y = 0; y < 192; y++) for (let c = 0; c < 32; c++) { const k = keyOf(y, c); for (let i = 0; i < 8; i++) { const v = (k >>> (28 - 4 * i)) & 15, o = (24 + y) * 640 + 64 + 16 * c + 2 * i; fake.pixels[o] = v; fake.pixels[o + 1] = v; } } };
    const pa = pictureAt(rFine.ctx, 20).fine, pb = pictureAt(rFine.ctx, 10).fine;           // 20 = the state now, 10 = long gone
    for (let i = 0; i < 9; i++) fc(fake);
    const clean0 = st.frames;
    paint((y, c) => groupKey(pa.bits[rowOff(y, c)], pa.colours[rowOff(y, c)]));
    fc(fake);
    paint(() => 0);
    fc(fake);
    const okFrames = msgs.length === 0 && st.frames === clean0 + 2;
    paint((y, c) => groupKey(pa.bits[rowOff(y, c)], pb.colours[rowOff(y, c)]));
    fc(fake);
    check_(`the frame check passes a picture of the run and a black frame (2 frames) and sees an old bitmap under other colours (${msgs.length} report)`, okFrames && msgs.length === 1 && /neither a picture/.test(msgs[0]), okFrames ? '' : msgs.join(' | '));
    nChecks += 5;
  }
}

// =================================================================================================================
// 5. the frame level (contract 4.3)
// =================================================================================================================
lap('section 4');
console.log('\n5. The frames during a switch: old picture, plain colour or new picture, never garbage colours');
{
  // the INITs are empty here, so the state RT_FINEMODE builds (the cell map after the reset) is a picture of the run (the record of the switch tick)
  const R = rng(5150);
  const cases = [
    ['two-buffer -> fine -> two-buffer', { fine: [false, true], initEmpty: true, pools: 3, enterAt: ['end', 'end'], busy: 0.9 }, seq([14, 1], [34, 0], [54, 1], [74, 0])],
    ['fine -> fine and the same scene again, then out', { fine: [true, true, false], initEmpty: true, pools: 3, enterAt: ['end', 'end', 'end'], busy: 0.9 }, seq([14, 1], [34, 1], [54, 2], [74, 0])],
    ['all four directions in a row, sprites and text busy', { fine: [true, false, true], initEmpty: true, pools: 4, enterAt: ['end', 'end', 'end'], busy: 1 }, seq([14, 1], [32, 1], [50, 2], [68, 2], [86, 0])],
  ];
  for (const [name, cfg, script] of ONLY ? [] : cases.slice(0, QUICK ? 1 : 3)) {
    const g = genGame(R, cfg);
    const r = runCase(g, script, QUICK ? 60 : script.size ? Math.max(...script.keys()) + 18 : 90, { frames: true });
    report(`frames: ${name}: ${r.stats.frames} frames checked around ${script.size} switches`, r, g, script);
    for (const n of r.stats.splitNotes) info('split write: ' + n);
  }
  // seeded random programs at the frame level too (empty INITs, random fine / two-buffer scenes and ENTER ticks, the video on)
  for (let seed = 1; seed <= (ONLY ? 0 : QUICK ? 1 : 6); seed++) {
    const R2 = rng(9_100 + seed);
    const nS = R2.pick([2, 3]);
    const fine = Array.from({ length: nS }, () => R2.chance(0.55));
    if (fine.every((x) => x) || fine.every((x) => !x)) fine[R2.int(0, nS - 1)] = !fine[0];
    const g = genGame(R2, { rate: R2.pick([10, 12, 20]), fine, initEmpty: true, pools: R2.int(1, 4), busy: 0.4 + 0.6 * R2.next(), edge: R2.chance(0.4), jump: R2.pick([6, 14]), enterAt: Array.from({ length: nS }, () => R2.pick(['mid', 'end', 'end'])) });
    const script = new Map();
    const ticks = QUICK ? 50 : 75;
    for (let t = 12; t <= ticks - 12; t += R2.int(5, 12)) script.set(t, R2.int(0, nS - 1));
    const r = runCase(g, script, ticks, { frames: true });
    report(`frames, seed ${seed}: ${nS} scenes (${fine.map((x) => (x ? 'fine' : 'plain')).join(', ')}), ${ticks} ticks, ${script.size} ENTERs: ${r.stats.frames} frames checked`, r, g, script);
    for (const n of r.stats.splitNotes) info('split write: ' + n);
  }
  // A group is written as two bytes (bitmap, then colour), so a frame the beam paints while the publish is under way can catch ONE group between the two (a "split write": contract 3 allows it at most
  // 1 frame in 1,000 during play).  During a switch the publish is a whole screen (more than a frame) and the beam is in it, so the rate is higher there; it is reported, and what is asserted is that
  // every such frame holds at most 2 such groups (one write in flight) and that no group is anything else (a non-split broken group fails the run itself).
  info(`${totals.frames} frames checked around the switches; frames with a group caught between its bitmap and its colour write: ${totals.frameSplit} (${(1000 * totals.frameSplit / Math.max(1, totals.frames)).toFixed(1)} per 1,000; contract 3's target for play is 1 per 1,000)`);
  if (!ONLY) check_(`${totals.frames} frames were checked, ${totals.frameSplit} of them held a split group (at most ${Math.max(2, Math.ceil(totals.frames * 0.02))}: 2 % of the frames)`, totals.frames > 20 && totals.frameSplit <= Math.max(2, Math.ceil(totals.frames * 0.02)) && totals.frameSplitMax <= 2);
  nChecks++;
}

// =================================================================================================================
// 6. coverage
// =================================================================================================================
lap('section 5');
console.log('\n6. What the runs covered');
{
  const K = (k) => totals.switches[k] ?? 0;
  if (!ONLY) {
  info(`${totals.runs} runs, ${totals.ticks} ticks: ${totals.fineTicks} in fine scenes, ${totals.plainTicks} in two-buffer scenes; ${totals.publishes} publishes compared with the fine picture; ${totals.frames} beam frames`);
  info(`switches: ${Object.entries(totals.switches).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  check_(`every kind of switch ran: plain -> fine ${K('P->F')}, fine -> plain ${K('F->P')}, fine -> fine ${K('F->F')}, plain -> plain ${K('P->P')}`, K('P->F') > 5 && K('F->P') > 5 && K('F->F') > 5 && K('P->P') > 5);
  check_(`a fine first scene started ${totals.firstFine} runs`, totals.firstFine >= 3);
  check_(`switches in a tick whose previous state had sprites on screen: ${totals.switchWithSprites}`, totals.switchWithSprites > 10);
  check_(`the picture RT_FINEMODE built was compared exactly for ${totals.onBuilt} switches on and ${totals.offBuilt} switches off`, totals.onBuilt >= 3 && totals.offBuilt >= 3);
  check_(`${totals.shown} shown-file checks of two-buffer ticks`, totals.shown > 50);
  nChecks += 5;
  }
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-m19-differential (${nChecks} checks${failed ? `, ${failed} failed` : ''}; ${((performance.now() - T0) / 1000).toFixed(0)} s)`);
process.exit(failed ? 1 : 0);
