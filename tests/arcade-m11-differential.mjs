#!/usr/bin/env node
"use strict";
// arcade-m11-differential.mjs -- the banked cartridge map (docs/ARCADE_BANKING_CONTRACT.md sections 4, 5 and 7: B3) against the REAL runtimes on a stock TS2068 in TSRun.
//
//   node tests/arcade-m11-differential.mjs                 (ARCADE_QUICK=1: shorter runs and fewer random programs)
//
// Sections
//   1  the examples (breakout, blockfall, bounce, shooter on v2; the platformer on v3; Vaults on v4) built normally and with `bankAll` (every map, world and plan in the window, read in place by the
//      runtime's loaders): equal TICK BY TICK in the state (variables, arrays, scene, sprite table, cell map and attributes, cursor, border, WORLD_RAM, camera, wall array, pose) and in the PICTURE
//      (RAM $4000-$7FFF: both display files, and the v3 window tables $5B00-$5DFF)
//   2  the programs of the batch 4 / batch 5 differential suites (random scene programs, the hand-written rules, the v3 / v4 spot programs): the same, normal against forced banking
//   3  WORLD on v3 (a WINDOW game) and v4 (a VIEW3D game): the machine against the reference interpreter tick by tick (WORLD_RAM, camera, wall array, pose, variables that read the world back), built
//      normally, with `bankAll`, and with an override that banks only the WORLD maps; and normal against banked, picture included
//
// How a tick is sampled: when PROC FRAME (or the driver's frame$entry) is entered, so sample k is the state after tick k - 1 (sample 0: after INIT), as tests/arcade-m9-differential.mjs does for v3 / v4.
// Input: the same scripted stick / keys for both builds of a program.
import { bootedMachine } from '../arcade/tests/fast-boot.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { ROOT, M_, s16, differential } from './arcade-m5-harness.mjs';
import { diffV3 } from './arcade-m6-common.mjs';
import { diffV4 } from './arcade-m8-common.mjs';
import { genProgram, genV3, genV4, HAND, ASSETS as ASSETS9 } from './arcade-m9-common.mjs';
import { genProgram10, genV3x, genV4x, HAND10, ASSETS as ASSETS10 } from './arcade-m10-common.mjs';
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
const RT = { 2: loadRuntime(2), 3: loadRuntime(3), 4: loadRuntime(4) };
/** what the banked builds need from a runtime build (slice B1): the window mapping in the loaders, and for WORLD the two new routines */
const needs = (R, names) => (R ? names.filter((n) => R.rt.symbols[n] === undefined && R.rt.constants?.[n] === undefined) : names);
const BANK_OK = { 2: needs(RT[2], ['RT_LOADMAPPTR']), 3: needs(RT[3], ['RT_LOADMAPPTR', 'RT_WORLDLOAD']), 4: needs(RT[4], ['RT_LOADMAPPTR', 'RT_PLANLOAD']) };

// ── the machine ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const KEYROWS = ['\x01ZXCV', 'ASDFG', 'QWERT', '12345', '09876', 'POIUY', '\rLKJH', ' \x02MNB'];
const KEYPOS = new Map(); KEYROWS.forEach((r, row) => [...r].forEach((chr, bit) => KEYPOS.set(chr.charCodeAt(0), [row, bit])));
const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;

/** Boot the cartridge (the DCK as built: chunks 2 / 3 too when banked) and sample at every entry of PROC FRAME. */
function runFramed(R, res, { ticks, stick, keys }) {
  const SYM = { ...R.rt.symbols, ...(R.rt.constants ?? {}) };
  const m = bootedMachine(res.dck);                       // restored from the boot snapshot (V9), video off (V8)
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
    cursor: { row: m.ram[SYM.V_CUR_ROW], col: m.ram[SYM.V_CUR_COL] }, textAttr: m.ram[SYM.V_TEXT_ATTR], border: m.ram[SYM.V_BORDER],
    ram4000: m.ram.slice(0x4000, 0x8000),                       // the picture: both display files, and (v3) the window tables
    f4: SYM.V_SHADOW_F4 !== undefined ? m.ram[SYM.V_SHADOW_F4] : null,
  });
  const out = { snaps: [], error: null, machine: m };
  for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
  const fe = res.map.entries.frame;
  const setInput = (k) => {
    const sv = stick ? stick(k) : 0;
    m.joystick[0] = contact(typeof sv === 'number' ? sv : sv[1] | 0);
    m.joystick[1] = contact(typeof sv === 'number' ? 0 : sv[2] | 0);
    for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F;
    for (const c of keys ? keys(k) : []) { const p = KEYPOS.get(c); if (p) m.keyMatrix[p[0]] &= ~(1 << p[1]); }
  };
  setInput(1);
  const origRead = m.bus.read;
  m.bus.read = function (a) {
    if (a === fe && out.snaps.length < ticks + 1 && m.cpu.pc === fe) { out.snaps.push(snap()); setInput(out.snaps.length); }
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
/** two runs of the same program (normal / banked): equal state and picture at every sample, or the first difference */
function diffRuns(a, b) {
  const n = Math.min(a.snaps.length, b.snaps.length);
  for (let t = 0; t < n; t++) {
    const x = a.snaps[t], y = b.snaps[t], at = t === 0 ? 'after INIT' : `after tick ${t}`;
    for (const k of Object.keys(x.vars)) if (x.vars[k] !== y.vars[k]) return `${at}: ${k} = ${x.vars[k]} (normal) / ${y.vars[k]} (banked)`;
    for (const k of Object.keys(x.arrays)) for (let j = 0; j < x.arrays[k].length; j++) if (x.arrays[k][j] !== y.arrays[k]?.[j]) return `${at}: ${k}(${j}) = ${x.arrays[k][j]} / ${y.arrays[k]?.[j]}`;
    if (x.scene !== y.scene) return `${at}: scene ${x.scene} / ${y.scene}`;
    if (JSON.stringify(x.sprites) !== JSON.stringify(y.sprites)) return `${at}: the sprite table differs`;
    if (!sameBuf(x.cells, y.cells)) return `${at}: cell (row ${(firstDiff(x.cells, y.cells) / 32) | 0}, col ${firstDiff(x.cells, y.cells) % 32}) = ${asHex(x.cells[firstDiff(x.cells, y.cells)])} / ${asHex(y.cells[firstDiff(x.cells, y.cells)])}`;
    if (!sameBuf(x.attrs, y.attrs)) return `${at}: attributes differ at ${firstDiff(x.attrs, y.attrs)}`;
    if (JSON.stringify([x.cursor, x.textAttr, x.border]) !== JSON.stringify([y.cursor, y.textAttr, y.border])) return `${at}: cursor / text attribute / border differ`;
    if (x.cam !== y.cam || !sameBuf(x.worldRam, y.worldRam)) return `${at}: camera ${x.cam} / ${y.cam}, WORLD_RAM ${sameBuf(x.worldRam, y.worldRam) ? 'same' : 'differs at ' + firstDiff(x.worldRam, y.worldRam)}`;
    if (!sameBuf(x.wallRam, y.wallRam)) return `${at}: the wall array differs at ${firstDiff(x.wallRam, y.wallRam)}`;
    if (JSON.stringify(x.pose) !== JSON.stringify(y.pose)) return `${at}: the pose ${JSON.stringify(x.pose)} / ${JSON.stringify(y.pose)}`;
    if (!sameBuf(x.ram4000, y.ram4000)) { const i = firstDiff(x.ram4000, y.ram4000); return `${at}: the picture / window RAM differs at ${asHex(0x4000 + i)}: ${x.ram4000[i]} (normal) / ${y.ram4000[i]} (banked)`; }
    if (y.f4 !== null && y.f4 !== 0x33) return `${at}: V_SHADOW_F4 is ${asHex(y.f4)} at the entry of PROC FRAME (the window must be unmapped)`;
  }
  return a.snaps.length === b.snaps.length ? null : `${a.snaps.length} samples (normal) / ${b.snaps.length} (banked)`;
}

/** Build a program normally and with bankAll and (optional) `over` overrides; run both; compare. Returns {ok, detail, banked: [assets], shipped}. */
function bankedVsNormal(R, src, assets, { ticks, stick = null, keys = null, bankAll = true, label = '' }) {
  let a, b, ra, rb;
  try {
    a = compile(src, { runtime: R.rt, image: R.img, assets });
    if (a.errors.length) return { ok: false, detail: 'compile (normal): ' + errText(a) };
    b = compile(src, { runtime: R.rt, image: R.img, assets, bankAll });
    if (b.errors.length) return { ok: false, detail: 'compile (banked): ' + errText(b) };
    ra = runFramed(R, a, { ticks, stick, keys });
    if (ra.error) return { ok: false, detail: 'run (normal): ' + ra.error };
    rb = runFramed(R, b, { ticks, stick, keys });
    if (rb.error) return { ok: false, detail: 'run (banked): ' + rb.error };
  } catch (e) { return { ok: false, detail: `${label} ${e.message}` }; }
  const d = diffRuns(ra, rb);
  return { ok: d === null, detail: d ?? `${ticks} ticks`, banked: b.usage.banked.assets, shipped: b.shipped, a, b };
}

const fmtKeys = (keys) => (keys ? (t, c) => keys(t).includes(c) : undefined);
const SCRIPT = (seed) => { let s = seed * 2654435761 >>> 0; return (t) => { const k = (t / 9) | 0; const h = Math.imul(k + s, 0x9E3779B1) >>> 0; return [0, 1, 2, 4, 8, 16, 8 | 16, 1 | 16][h % 8]; }; };

// =================================================================================================================
// 1. The examples
// =================================================================================================================
console.log('1. The examples: built normally and with bankAll, equal tick by tick (state and picture)');
{
  const EX = join(ROOT, 'arcade/examples');
  const list = [['breakout', 2, 120], ['blockfall', 2, 120], ['bounce', 2, 100], ['shooter', 2, 120], ['platformer', 3, 150], ['vaults', 4, 70]];
  for (const [name, v, t] of list) {
    const R = RT[v];
    const file = join(EX, `${name}.arc`);
    if (!R || !existsSync(file)) { skip_(`${name} (v${v})`, 'the example or the runtime is missing'); continue; }
    if (BANK_OK[v].length) { skip_(`${name} (v${v}) banked`, `arcade/build/v${v}/runtime.json lacks ${BANK_OK[v].join(' ')} (slice B1 not built yet)`); continue; }
    const assets = JSON.parse(readFileSync(join(EX, `${name}.assets.json`), 'utf8'));
    const ticks = QUICK ? Math.min(t, v === 4 ? 40 : 80) : t * 2;
    const r = bankedVsNormal(R, readFileSync(file, 'utf8'), assets, { ticks, stick: SCRIPT(name.length), label: name });
    check_(`${name} on v${v}: ${ticks} ticks, normal vs every map / world / plan banked (${(r.banked ?? []).map((a) => `${a.kind} ${a.name}`).join(', ') || 'nothing to bank'}), state and picture equal`, r.ok && (r.banked ?? []).length >= (name === 'bounce' || name === 'breakout' || name === 'blockfall' ? 0 : 1), r.detail);
  }
}

// =================================================================================================================
// 2. The programs of the batch 4 / 5 suites
// =================================================================================================================
console.log('\n2. The batch 4 / 5 programs: normal vs forced banking');
{
  const total = { n: 0, bank: 0 };
  const bank2 = BANK_OK[2], bank3 = BANK_OK[3], bank4 = BANK_OK[4];
  const runSet = (name, R, items, assets) => {
    let bad = 0, why = '', first = '', nb = 0;
    for (const it of items) {
      const r = bankedVsNormal(R, it.src, it.assets ?? assets, { ticks: it.ticks, stick: it.stick, keys: it.keys, label: it.label });
      total.n++; if ((r.banked ?? []).length) { nb++; total.bank++; }
      if (!r.ok) { bad++; why ||= `${it.label}: ${r.detail}`; first ||= it.src; }
    }
    check_(`${name}: ${items.length} programs x their ticks, normal vs banked equal (${nb} had something to bank)`, bad === 0 && items.length > 0, `${bad} failed; ${why}`);
    if (bad && first) console.log(`  ---- first failing program:\n${first.split('\n').map((l) => '  | ' + l).join('\n')}`);
  };
  if (!RT[2] || bank2.length) skip_('v2 programs', !RT[2] ? 'no v2 runtime' : `v2 runtime lacks ${bank2.join(' ')}`);
  else {
    const T = QUICK ? 30 : 50, N = QUICK ? 8 : 40;
    runSet('batch 4 random scene programs (genProgram, maps ma / mb through LOADMAP)', RT[2], Array.from({ length: N }, (_, i) => { const g = genProgram(i + 1); return { src: g.src, ticks: T, stick: g.stick, keys: g.keys, label: `genProgram(${i + 1})` }; }), ASSETS9);
    runSet('batch 5 random programs (genProgram10: timers, key edges, USING, PLAY by index)', RT[2], Array.from({ length: N }, (_, i) => { const g = genProgram10(i + 1); return { src: g.src, ticks: T, stick: g.stick, keys: g.keys, label: `genProgram10(${i + 1})` }; }), ASSETS10);
    runSet('batch 4 hand-written programs (HAND)', RT[2], Object.entries(HAND).map(([k, src]) => ({ src, ticks: 20, label: `HAND.${k}` })), ASSETS9);
    runSet('batch 5 hand-written programs (HAND10), with their scripted input', RT[2], Object.entries(HAND10).map(([k, h]) => ({ src: h.src, ticks: Math.min(h.ticks, QUICK ? 30 : 60), keys: h.keys, stick: h.stick, label: `HAND10.${k}` })), ASSETS10);
  }
  if (!RT[3] || bank3.length) skip_('v3 programs', !RT[3] ? 'no v3 runtime' : `v3 runtime lacks ${bank3.join(' ')}`);
  else {
    const N = QUICK ? 3 : 10, T = QUICK ? 40 : 60;
    runSet('batch 4 v3 programs (WINDOW with bands, frames, scenes; the window\'s world banked)', RT[3], Array.from({ length: N }, (_, i) => { const g = genV3(i + 1); return { src: g.src, ticks: T, stick: g.stick, keys: g.keys, label: `genV3(${i + 1})` }; }), ASSETS9);
    runSet('batch 5 v3 programs (genV3x: timers, edges, USING)', RT[3], Array.from({ length: N }, (_, i) => { const g = genV3x(i + 1); return { src: g.src, ticks: T, stick: g.stick, keys: g.keys, label: `genV3x(${i + 1})` }; }), ASSETS10);
  }
  if (!RT[4] || bank4.length) skip_('v4 programs', !RT[4] ? 'no v4 runtime' : `v4 runtime lacks ${bank4.join(' ')}`);
  else {
    const N = QUICK ? 3 : 10, T = QUICK ? 30 : 50;
    runSet('batch 4 v4 programs (VIEW3D, SETWALL; the plan banked)', RT[4], Array.from({ length: N }, (_, i) => { const g = genV4(i + 1); return { src: g.src, ticks: T, stick: g.stick, keys: g.keys, label: `genV4(${i + 1})` }; }), ASSETS9);
    runSet('batch 5 v4 programs (genV4x)', RT[4], Array.from({ length: N }, (_, i) => { const g = genV4x(i + 1); return { src: g.src, ticks: T, stick: g.stick, keys: g.keys, label: `genV4x(${i + 1})` }; }), ASSETS10);
  }
  info(`${total.n} programs compared, ${total.bank} of them with at least one asset banked`);
}

// =================================================================================================================
// 3. WORLD against the interpreter
// =================================================================================================================
console.log('\n3. WORLD on v3 (WINDOW) and v4 (VIEW3D): the machine against the interpreter, normal / banked / WORLD maps banked');
{
  const WIN_FRAME = `    v = v + 1
    a = WORLDTILE(8 * 12, 8 * 13)
    b = CAMX()
    c = TILEFLAGS(8 * 3, 8 * 14)
    d = WORLDTILE(8 * 40, 8 * 4)
    SHOW ship AT 40 + b, 30
    IF v = 2 THEN CAMERA 120 ENDIF
    IF v = 4 THEN WORLD second ENDIF
    IF v = 6 THEN CAMERA 5000 ENDIF
    IF v = 8 THEN SETWORLD 8 * 5, 8 * 13 = 2 ENDIF
    IF v = 9 THEN WORLD third ENDIF
    IF v = 10 THEN CAMERA 5000 ENDIF
    IF v = 12 THEN WORLD level ENDIF
    IF v = 13 THEN CAMERA 77 ENDIF
    IF v = 14 THEN WORLD narrow ENDIF
    IF v = 15 THEN CAMERA 500 ENDIF
    IF v = 16 THEN WORLD short ENDIF
    IF v = 18 THEN WORLD second ENDIF
    IF v = 19 THEN WORLD second ENDIF`;
  const WIN_MAPS = 'MAP second = "w60"\nMAP third = "w128"\nMAP narrow = "w24"\nMAP short = "w30"\n';
  const winSrc = (bands = '') => `${HEAD}SPRITE ship = "orb"\nMAP level = "lv"\n${WIN_MAPS}WINDOW level\n${bands}${scene('', WIN_FRAME, 'DIM a, b, c, d')}`;
  const VIEW_FRAME = `    v = v + 1
    a = WALL(300, 300)
    b = WALL(2 * 256 + 10, 3 * 256)
    c = WALL(1900, 1400)
    d = WALL(7 * 256, 5 * 256)
    IF v = 2 THEN
      VIEW 3000, 2900, 70
      SETWALL 2 * 256, 2 * 256 = 3
    ENDIF
    IF v = 4 THEN WORLD other ENDIF
    IF v = 5 THEN VIEW 600, 700, 9 ENDIF
    IF v = 6 THEN SETWALL 2 * 256, 2 * 256 = 4 ENDIF
    IF v = 8 THEN WORLD bigger ENDIF
    IF v = 9 THEN VIEW 4000, 3500, 200 ENDIF
    IF v = 11 THEN WORLD level ENDIF
    IF v = 13 THEN WORLD huge ENDIF
    IF v = 15 THEN WORLD tiny ENDIF
    IF v = 17 THEN WORLD other ENDIF
    IF v = 18 THEN WORLD other ENDIF`;
  const VIEW_MAPS = 'MAP other = "p8"\nMAP bigger = "p20"\nMAP huge = "p32"\nMAP tiny = "p4"\n';
  const viewSrc = `${HEAD}SPRITE ship = "orb"\nMAP level = "maze"\n${VIEW_MAPS}VIEW3D level\n${scene('', VIEW_FRAME, 'DIM a, b, c, d')}`;

  /** machine vs interpreter, tick by tick: variables, WORLD_RAM / camera (diffV3) or wall array / pose (diffV4) */
  function vsInterp(R, res, src, { ticks, ray, assets }) {
    const got = runFramed(R, res, { ticks, stick: null, keys: null });
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
  const modes = [['normal', {}, ASSETS11], ['bankAll', { bankAll: true }, ASSETS11],
    ['only the WORLD maps banked', {}, ['w60', 'w128', 'w24', 'w30', 'p8', 'p20', 'p32', 'p4'].reduce((as, n) => withBank(as, n, 'banked'), ASSETS11)]];
  for (const [v, srcs, ticks] of [[3, [['one band', winSrc()], ['bands 2 at 1/4, 3 at 1/2, 11 at 1/1 (the camera limit of every world is worked out for them)', winSrc('BAND 2, 1, 4\nBAND 3, 1, 2\nBAND 11, 1, 1\n')]], QUICK ? 20 : 24], [4, [['the maze, COLW 4', viewSrc]], QUICK ? 20 : 24]]) {
    const R = RT[v];
    if (!R) { skip_(`v${v} WORLD`, `arcade/build/v${v}/runtime.json is missing`); continue; }
    if (BANK_OK[v].length) { skip_(`v${v} WORLD`, `arcade/build/v${v}/runtime.json lacks ${BANK_OK[v].join(' ')} (slice B1 not built yet)`); continue; }
    for (const [label, src] of srcs) {
      const runs = [];
      for (const [mode, opts, assets] of modes) {
        const res = compile(src, { runtime: R.rt, image: R.img, assets, ...opts });
        if (res.errors.length) { check_(`v${v} WORLD (${label}), ${mode}: compiles`, false, errText(res)); continue; }
        const d = vsInterp(R, res, src, { ticks, ray: v === 4, assets });
        check_(`v${v} WORLD (${label}), ${mode}${res.usage.banked.assets.length ? ` (${res.usage.banked.assets.length} banked: ${res.usage.banked.assets.map((a) => a.name).join(' ')})` : ''}: ${ticks} ticks equal to the interpreter (${v === 3 ? 'WORLD_RAM, camera, variables read back with WORLDTILE / TILEFLAGS / CAMX' : 'wall array, pose, variables read back with WALL'})`, d === null, d ?? '');
        runs.push([mode, res]);
      }
      // the same program, normal against banked, picture included
      const r = bankedVsNormal(R, src, ASSETS11, { ticks, label });
      check_(`v${v} WORLD (${label}): normal vs bankAll equal in state and picture (RAM $4000-$7FFF) tick by tick`, r.ok, r.detail);
    }
  }
}

// =================================================================================================================
// 3b. Automatic placement on the machine: a game whose maps do not fit
// =================================================================================================================
console.log('\n3b. Automatic banking (policy auto): 22 screen maps of 770 bytes do not fit chunks 4-5; the machine loads banked and mapped ones against the interpreter');
{
  const R = RT[2];
  if (!R || BANK_OK[2].length) skip_('automatic banking on the machine', 'the v2 runtime with the banked loaders is needed');
  else {
    const decl = Array.from({ length: 22 }, (_, k) => `MAP m${k} = "s${k}"\n`).join('');
    const frame = '    v = v + 1\n' + Array.from({ length: 22 }, (_, k) => `    IF v = ${k + 1} THEN LOADMAP m${k} AT ${k % 4}, ${k % 3} ENDIF`).join('\n') + '\n';
    const src = `${HEAD}${decl}${scene('', frame)}`;
    const res = compile(src, { runtime: R.rt, image: R.img, assets: ASSETS11 });
    check_('the game compiles with some maps banked by the policy (auto) and the rest mapped', res.errors.length === 0 && res.usage.banked.assets.length >= 1 && res.usage.banked.assets.length < 22 && res.usage.mapped.used <= 16384, errText(res));
    const r = differential(src, ASSETS11, { ticks: QUICK ? 24 : 30 });
    check_(`${QUICK ? 24 : 30} ticks of LOADMAP m0 .. m21 (banked: ${(res.usage.banked?.assets ?? []).map((a) => a.name).join(' ')}): cells and attributes equal to the interpreter every tick`, r.ok, r.detail);
  }
}

// =================================================================================================================
// 4. Negative controls: the comparisons see a damaged window
// =================================================================================================================
console.log('\n4. Negative controls: a banked build whose window is damaged must FAIL the comparisons above');
{
  const R3 = RT[3];
  if (!R3 || BANK_OK[3].length) skip_('negative controls', 'the v3 runtime with the banked loaders is needed');
  else {
    const src = win3('    v = v + 1\n    a = WORLDTILE(8 * 12, 8 * 13)\n    IF v = 3 THEN WORLD second ENDIF', 'MAP second = "w60"\n', '').replace('DIM v', 'DIM v, a');
    const ok = compile(src, { runtime: R3.rt, image: R3.img, assets: ASSETS11, bankAll: true });
    const hit = (res, name) => { const a = res.usage.banked.assets.find((x) => x.name === name); return 9 + 2 * 8192 + (a.at - 0x4000); };       // the file offset of an asset: chunks 0, 1, 2 come first
    const damaged = (name, delta) => { const res = { ...ok, dck: ok.dck.slice() }; res.dck[hit(ok, name) + 1] ^= delta; return res; };     // the value of the first run of the RLE stream
    const interp = interpret(parse(src).ast, { version: 3, ticks: 10, assets: ASSETS11, maxSteps: 2_000_000_000, border0: R3.rt.constants?.BORDER_COLOUR ?? 1 });
    const same = (res) => { const got = runFramed(R3, res, { ticks: 10 }); let d = null; for (let t = 0; !d && t <= 10; t++) d = diffV3(got.snaps[t], t === 0 ? interp.init : interp.ticks[t - 1], `t${t}`); return d; };
    check_('control: the undamaged banked build equals the interpreter', same(ok) === null);
    check_('control: a changed byte in the banked world of the WINDOW (level) is seen (WORLD_RAM differs from the interpreter)', same(damaged('level', 0x30)) !== null);
    check_('control: a changed byte in the banked world a WORLD loads (second) is seen', same(damaged('second', 0x30)) !== null);
    // and a window that is not $FF-filled / mapped: the banked build with the chunk shipped but the map table pointing elsewhere is not meaningful here; the picture comparison is checked on the pictures
    const a = runFramed(R3, compile(src, { runtime: R3.rt, image: R3.img, assets: ASSETS11 }), { ticks: 10 }), b = runFramed(R3, damaged('second', 0x30), { ticks: 10 });
    check_('control: diffRuns reports the damaged build against the normal one (world RAM or picture)', diffRuns(a, b) !== null);
  }
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}: ${passed} checks passed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed === 0 ? 0 : 1);
