"use strict";
// m17-runtime-tick.mjs -- Leap Arcade wireframe 3D, slice W2 (docs/ARCADE_WIREFRAME_CONTRACT.md sections 2.4-2.6, 3.3, 3.4, 8): runtime v2's play area in
// the boot and the tick (wiretick.asm: wire_boot, wire_tick, RT_WIREMODE; main.asm's test at WORK_START), on a stock TS2068 (TSRun) with the real frame
// interrupt, one instruction at a time from the cartridge entry.
//
// The game is runtime/v2/test_wire.asm: test_script.asm's interpreter with the 20-byte header (DIV_EXT | DIV_WIRE, $8012 = wire_desc) and the ops EYE,
// DRAWMODEL, LINE, WIREMODE (they call RT_EYE / RT_DRAWMODEL / RT_LINE / RT_WIREMODE directly), plus SHOW / HIDE / AT / PRINTS / TILE / PLAY.
// The expectation is built per display file, op by op, from the contract: the cell map and the sprites from m4-common's Model2 (written from the v2
// contract), the play area from src/lang/arcade/arcade-wire.js (the clear at the tick's start when the area is on, DRAWMODEL / LINE into the hidden
// file while it is on), the rows outside the play area from the cell map, the sprites over everything, the play-area attributes written into BOTH files
// by an effective ON, which also clears the play area of the hidden file (contract 2.6 as amended).  After every refresh the file on screen must equal
// its expectation, bitmap and attributes.
//  1. scenario A (rows 2..21, HUD rows 0-1 and 22-23): sprites static in the HUD (so the skip analysis runs), static in the play area, across its edge,
//     moving; text and tiles in the HUD and in the play rows; the switch OFF / ON before, between and after the draws of a tick, twice in a row, OFF and
//     ON in one tick; a busy sound effect.  Text printed into a play row is not shown while on and appears after OFF in both files; ON restores the
//     attributes in both files.
//  2. scenario B (rows 0..23: the largest clear, a three-channel effect replayed all the time): >= 600 refreshes, every frame interrupt taken (the
//     interrupts accepted = the refreshes TSRun ran = V_FRAMES' advance = the handler entries); the clear's start after the interrupt and the end of
//     its interrupts-off span.
//  3. scenario C: a NOVIEW first scene (RT_WIREMODE 0 in init_entry, before the first tick), later ON and OFF.
//  4. games WITHOUT the play area (DIV_EXT only, the 16-byte header, DIV_WIRE with an invalid descriptor): $F4E0-$FA7F poisoned at the cartridge entry
//     stays untouched, V_WIRE stays 0, RT_WIREMODE (in the script) does nothing, the pictures are the cell map's; the cost of the test at WORK_START.
//  5. RT_WIREMODE called directly: on / off / no-op cost, IX / IY / the alternates kept, the exact RAM it writes.
//  6. negative controls: the same scenario with wire_unchanged or wire_erase taken out of wire_tick must fail the picture comparison.
//   node arcade/tests/m17-runtime-tick.mjs        (M17_QUICK=1: shorter runs)
import { join } from 'node:path';
import { assembleGame, linkGame, dckOf, RUNTIME_DIR } from '../tools/build-runtime-v2.mjs';
import * as C from './m4-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
import * as W from '../../src/lang/arcade/arcade-wire.js';
const { M, Z, FRAME_T, hex, makeChecks, rd8, rd16, newMachine, callRoutine, Model2, randomAsset, assetBytes, SCRIPT, C3 } = C;
const { rowAddr, BG_ATTR } = C3;

const QUICK = !!process.env.M17_QUICK;
const { check, finish } = makeChecks();
console.log('M17 runtime wireframe tick (W2): wire_boot, wire_tick, RT_WIREMODE on runtime v2, real frame interrupt\n');

const rt = C.runtime();
const S = rt.syms, K = rt.json.constants;
const GAME = assembleGame(join(RUNTIME_DIR, 'test_wire.asm'), { name: 'wire' });
const G = GAME.syms;
const WIRE_DESC = 0x83F8, INIT_MODE = 0x83FC, MODEL_AT = 0x8400, MODEL_END = 0x8800;
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];

console.log('--- 0. the build ---');
check('runtime.json exports DIV_WIRE = $40, GAME_WIREDESC = $8012, GAME_HEADER_WIRE_LEN = 20, V_WIRE (a VARS byte), WIRE_HAS / WIRE_ON',
  K.DIV_WIRE === 0x40 && K.GAME_WIREDESC === 0x8012 && K.GAME_HEADER_WIRE_LEN === 20 && K.V_WIRE >= 0xE000 && K.V_WIRE < 0xE0FC && K.WIRE_HAS === 2 && K.WIRE_ON === 1,
  `V_WIRE ${hex(K.V_WIRE ?? 0)}`);
check('the symbols RT_WIREMODE, wire_boot, wire_tick, wire_unchanged, wire_erase exist; test_wire.asm\'s RT_ARGS equals the runtime\'s ($FAC0)',
  ['RT_WIREMODE', 'wire_boot', 'wire_tick', 'wire_unchanged', 'wire_erase', 'TICK_DRAW'].every((k) => S[k] > 0) && K.RT_ARGS === 0xFAC0 && G['frame_entry.loop'] > 0);
console.log(`      RT_END ${hex(S.RT_END)} (${fmt(0x4000 - S.RT_END)} bytes free after it); wiretick.asm ${hex(S.M_WTICK_S)}-${hex(S.M_WTICK_E)} (${S.M_WTICK_E - S.M_WTICK_S} bytes)`);

// ---- models (written into the image at MODEL_AT) ----------------------------------------------------------------------------------------------
const MODELS = (() => {
  const cube = { points: [[-20, -20, -20], [20, -20, -20], [20, 20, -20], [-20, 20, -20], [-20, -20, 20], [20, -20, 20], [20, 20, 20], [-20, 20, 20]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]] };
  const octa = { points: [[0, 30, 0], [0, -30, 0], [30, 0, 0], [-30, 0, 0], [0, 0, 30], [0, 0, -30]],
    edges: [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [4, 3], [3, 5], [5, 2]] };
  const gate = { points: Array.from({ length: 8 }, (_, k) => [Math.round(40 * Math.cos(k * Math.PI / 4)), Math.round(40 * Math.sin(k * Math.PI / 4)), 0]),
    edges: Array.from({ length: 8 }, (_, k) => [k, (k + 1) % 8]) };
  const R = rng(1717);
  const pts = Array.from({ length: 40 }, () => [R.int(-60, 60), R.int(-60, 60), R.int(-60, 60)]);
  const big = { points: pts, edges: Array.from({ length: 80 }, (_, i) => [i % 40, (i * 7 + 3) % 40]).filter(([a, b]) => a !== b) };
  return { cube, octa, gate, big };
})();
const MODEL_ADDR = {};
const MODEL_BYTES = [];
{
  let at = MODEL_AT;
  for (const [k, md] of Object.entries(MODELS)) { const b = W.modelBytes(md); MODEL_ADDR[k] = at; MODEL_BYTES.push([at, b]); at += b.length; }
  if (at > MODEL_END) throw new Error('models do not fit');
}

// ---- the script ----------------------------------------------------------------------------------------------------------------------------
function enc(o) {
  switch (o.op) {
    case 'show': return [1, o.i, ...w16(o.x), ...w16(o.y)];
    case 'hide': return [2, o.i];
    case 'at': return [3, o.row, o.col];
    case 'prints': { const c = [...o.s].map((ch) => ch.charCodeAt(0)); return [4, c.length, ...c]; }
    case 'ink': return [7, o.a];
    case 'paper': return [8, o.a];
    case 'bright': return [9, o.a];
    case 'cls': return [10];
    case 'tile': return [11, o.t, o.row, o.col];
    case 'play': return [12, o.i];
    case 'eye': return [21, ...w16(o.x), ...w16(o.y), ...w16(o.z), ...w16(o.a)];
    case 'dm': return [22, ...w16(MODEL_ADDR[o.m]), o.k, ...w16(o.x), ...w16(o.y), ...w16(o.z), ...w16(o.yaw), ...w16(o.pitch)];
    case 'line': return [23, ...w16(o.x0), ...w16(o.y0), ...w16(o.x1), ...w16(o.y1)];
    case 'mode': return [24, o.a];
    default: throw new Error('op ' + o.op);
  }
}
/** The ops tick n executes: the script's tick n, with WRAP (op 25) after the last tick when `wrap`; past the end without it, nothing. */
const opsOf = (ticks, wrap) => (n) => (n < ticks.length ? ticks[n] : !wrap ? [] : n % ticks.length === 0 ? [{ op: 'wrap' }, ...ticks[0]] : ticks[n % ticks.length]);

/** Busy three-channel effect (type 3): the header 0, 0, 0, 3 and one entry of all 11 registers per refresh (the most the sound tick does). */
function busyEffect(R, n) {
  const out = [0, 0, 0, 3];
  for (let k = 0; k < n; k++) {
    out.push(11);
    for (let r = 0; r <= 10; r++) out.push(r, r === 7 ? 0x38 : r >= 8 ? R.int(0, 15) : R.int(0, r === 6 ? 31 : 255));
  }
  out.push(0xFF);
  return out;
}

const ASSET_R = rng(1718);
const ASSETS = [randomAsset(ASSET_R, 16, 16, 4), randomAsset(ASSET_R, 8, 8, 8), randomAsset(ASSET_R, 16, 12, 2)];   // 14 phases
const INSTS = [1, 1, 1, 1, 1, 1, 0, 2, 0, 1];
const TILES = randomTiles(rng(1719), 12);

/**
 * The game image.  spec: { div (the frame_div byte), desc: [r0, r1, attr] | null (null pointer), initMode (0xFF none), ticks, wrap, map, sfx (bytes) }.
 */
function wireGame(spec) {
  const img = linkGame(rt.img, GAME.bytes);
  const put = (a, bytes) => img.set(bytes, a);
  img[0x8004] = spec.div;
  img[0x8005] = ASSETS.length;
  let dataAt = SCRIPT.SPRDATA;
  ASSETS.forEach((a, i) => {
    const bytes = assetBytes(a);
    put(dataAt, bytes);
    put(SCRIPT.SPRTAB + 8 * i, [a.w, a.h, ...w16(dataAt), 0, 0, a.phases, 0]);
    dataAt += bytes.length;
  });
  const insts = spec.insts ?? INSTS;
  put(SCRIPT.INST, [insts.length, ...insts]);
  const ts = [TILES.length];
  for (const t of TILES) ts.push(...t.bmp, t.attr);
  put(SCRIPT.TILESET, ts);
  if (spec.sfx) { put(SCRIPT.SFXTAB, [1, ...w16(SCRIPT.SFXDATA)]); if (SCRIPT.SFXDATA + spec.sfx.length > SCRIPT.MAP) throw new Error('effect too long'); put(SCRIPT.SFXDATA, spec.sfx); }
  if (spec.map) put(SCRIPT.MAP, spec.map);
  put(0x8008, [...w16(SCRIPT.TILESET), ...w16(spec.sfx ? SCRIPT.SFXTAB : 0), ...w16(spec.map ? SCRIPT.MAP : 0)]);
  put(0x8012, w16(spec.desc ? WIRE_DESC : 0));
  if (spec.desc) put(WIRE_DESC, [...spec.desc, 0]);
  img[INIT_MODE] = spec.initMode ?? 0xFF;
  for (const [a, b] of MODEL_BYTES) put(a, b);
  img.fill(0, SCRIPT.BASE, SCRIPT.END);
  const bytes = spec.ticks.flatMap((t) => [...t.flatMap(enc), 0]);
  if (spec.wrap) bytes.push(25);
  if (bytes.length > SCRIPT.END - SCRIPT.BASE) throw new Error('script too long: ' + bytes.length);
  put(SCRIPT.BASE, bytes);
  for (const [a, v] of spec.patch ?? []) img[a] = v;
  return { img, dck: dckOf(img), spec, ops: opsOf(spec.ticks, spec.wrap) };
}

// ---- the expectation ---------------------------------------------------------------------------------------------------------------------
const cellsOnly = (model) => C3.Model.prototype.render.call(model, null);
/** Sprites of `model` over `bm` (Model2.render's composition: (old AND mask) OR image, a higher index on top). */
function compositeSprites(model, bm) {
  model.insts.forEach((s) => {
    if (!s.visible) return;
    const a = model.assets[s.asset], xd = model.drawX(s), nb = a.w;
    for (let rr = 0; rr < a.h; rr++) {
      const y = s.y + rr, mask = a.rows[rr].mask, image = a.rows[rr].image;
      for (let b = 0; b < nb; b++) {
        const x = xd + b, adr = rowAddr(y) + (x >> 3), bit = 0x80 >> (x & 7);
        const keep = (mask >> (nb - 1 - b)) & 1, ink = (image >> (nb - 1 - b)) & 1;
        let v = bm[adr];
        v = keep ? v : v & ~bit;
        if (ink) v |= bit;
        bm[adr] = v;
      }
    }
  });
}
class Expect {
  /** spec: { has, desc: [r0, r1, attr], initMode, map } */
  constructor(spec) {
    this.m = new Model2({ assets: ASSETS, insts: spec.insts ?? INSTS, tiles: TILES, map: spec.map ?? null });
    this.has = !!spec.has;
    this.bm = [new Uint8Array(6144), new Uint8Array(6144)];
    this.at = [new Uint8Array(768).fill(BG_ATTR), new Uint8Array(768).fill(BG_ATTR)];
    this.eye = { x: 0, y: 0, z: 0, a: 0 };
    this.on = false;
    if (this.has) {
      const [r0, r1, attr] = spec.desc;
      this.area = W.areaOf(r0, r1); this.attr = attr;
      this.setOn(true);                                       // the boot turns it on
      if ((spec.initMode ?? 0xFF) !== 0xFF) this.mode(spec.initMode);
    }
  }
  setOn(on) {
    this.on = on;
    if (on) for (const f of [0, 1]) for (let r = this.area.r0; r <= this.area.r1; r++) this.at[f].fill(this.attr, 32 * r, 32 * r + 32);
  }
  /** RT_WIREMODE A (h: the hidden file, when called in a tick): ON from off also clears the play area of the hidden file at once (wire_clear_on; the boot's switch does not). */
  mode(a, h) { if (!this.has) return; if (a && !this.on) { this.setOn(true); if (h !== undefined) W.clearArea(this.bm[h], this.area); } else if (!a && this.on) this.on = false; }
  inPlayRow(row) { return this.has && row >= this.area.r0 && row <= this.area.r1; }
  tickStart(h) { if (this.has && this.on) W.clearArea(this.bm[h], this.area); }
  apply(o, h) {
    switch (o.op) {
      case 'eye': this.eye = { x: o.x, y: o.y, z: o.z, a: o.a & 255 }; break;
      case 'dm': if (this.has && this.on) W.drawModel(this.bm[h], MODELS[o.m], { x: o.x, y: o.y, z: o.z, yaw: o.yaw, pitch: o.pitch, scale: 1 << o.k }, this.eye, this.area); break;
      case 'line': if (this.has && this.on) W.drawLine(this.bm[h], o.x0, o.y0, o.x1, o.y1, this.area); break;
      case 'mode': this.mode(o.a, h); break;
      case 'wrap': break;
      default: this.m.apply(o);
    }
  }
  /** The end of a tick that drew file h. */
  finish(h) {
    const R = cellsOnly(this.m);
    if (this.has && this.on) {
      for (let row = 0; row < 24; row++) {
        if (this.inPlayRow(row)) continue;
        for (let k = 0; k < 8; k++) { const o = rowAddr(8 * row + k); this.bm[h].set(R.bitmap.subarray(o, o + 32), o); }
        this.at[h].set(R.attrs.subarray(32 * row, 32 * row + 32), 32 * row);
      }
    } else { this.bm[h].set(R.bitmap); this.at[h].set(R.attrs); }
    compositeSprites(this.m, this.bm[h]);
  }
}

// ---- the runner --------------------------------------------------------------------------------------------------------------------------
function entryFrame(dck) {
  const m = newMachine(dck);
  for (let f = 1; f <= 400; f++) { M.runFrame(m); if (rd16(m, S.HO_MARK) === 0x5AA5) return f; }
  throw new Error('the cartridge entry was not reached');
}
/**
 * Run `game` for `nframes` refreshes after the boot; compare the file on screen with `exp` after every refresh.  opts: { poison(m) at the cartridge
 * entry, onTick(st, cur) at the end of each tick (TICK_REQUEST, the tick's file in cur.h) }.
 */
function run(game, exp, nframes, { poison = null, onTick = null, onStart = null } = {}) {
  const F = entryFrame(game.dck);
  const m = newMachine(game.dck);
  for (let f = 1; f < F; f++) M.runFrame(m);
  const cpu = m.cpu;
  const st = { m, refreshes: 0, accepted: 0, isrEntries: 0, framesAdv: 0, bad: 0, skipped: 0, firstBad: [], ticks: 0, clearStart: [], clearEnd: [],
    clearOff: [], workToFrame: [], anySkip: 0, onTicks: 0, offTicks: 0, opsBad: 0 };
  let armed = false, cur = null, clr = null, workT = -1, watching = false;
  // from wire_unchanged to draw_all of a tick with the area on (skip_analysis, wire_erase, redraw_dirty): no write may reach a play-area pixel row or
  // attribute of either display file
  st.playWrites = 0; st.watchedTicks = 0;
  const origWrite = m.bus.write;
  m.bus.write = (addr, v) => {
    const a = addr & 0xFFFF;
    if (watching && a >= 0x4000 && a < 0x8000 && (a & 0x1FFF) < 0x1B00) {
      const o = a & 0x1FFF;
      const row = o >= 0x1800 ? (o - 0x1800) >> 5 : (((o >> 5) & 0xC0) | ((o >> 8) & 7) | ((o >> 2) & 0x38)) >> 3;
      if (exp.inPlayRow(row)) st.playWrites++;
    }
    origWrite(addr, v);
  };
  const hook = () => {
    const pc = cpu.pc;
    if (pc === S.wire_unchanged) { watching = true; st.watchedTicks++; }
    if (pc === S.draw_all || pc === S.TICK_REQUEST) watching = false;
    if (pc === S.ENTRY && poison) poison(m);
    if (pc === S.MAIN) armed = true;
    if (!armed) return;
    if (pc === 0x0038) st.isrEntries++;
    if (pc === S.WORK_START) {
      const n = rd16(m, S.V_TICKS), h = (rd8(m, S.V_SHADOW_FF) & 1) ^ 1;
      cur = { n, h, ops: game.ops(n), k: 0, started: false, executing: null, vwire: rd8(m, K.V_WIRE) };
      onStart?.(st, cur);
      exp.tickStart(h);
      workT = m.tstates;
    }
    if (pc === G.frame_entry && workT >= 0) { st.workToFrame.push(m.tstates - workT); workT = -1; }
    if (cur && pc === G['frame_entry.loop']) {
      if (cur.started) exp.apply(cur.ops[cur.k++], cur.h);
      cur.started = true;
      cur.executing = cur.ops[cur.k] ?? null;
    }
    if (cur && pc === G['frame_entry.end']) { if (cur.k !== cur.ops.length) st.opsBad++; cur.executing = null; }
    if (cur && pc === S.TICK_REQUEST) {
      exp.finish(cur.h);
      st.ticks++;
      if (rd8(m, S.V_ANYSKIP)) st.anySkip++;
      if (exp.on) st.onTicks++; else st.offTicks++;
      onTick?.(st, cur);
      cur = null;
    }
    if (pc === S.wire_clear) { clr = { t0: m.tstates, fs: m.frameStart, di: null }; st.clearStart.push(m.tstates - m.frameStart); }
    if (clr) {
      if (!cpu.iff1 && clr.di === null) clr.di = m.tstates;
      if (cpu.iff1 && clr.di !== null) { st.clearOff.push(m.tstates - clr.di); st.clearEnd.push(m.tstates - clr.fs); clr = null; }
    }
  };
  const tStart = Date.now();
  let prevFrames = null;
  for (let f = 0; st.refreshes < nframes && f < nframes + 400; f++) {
    const end = m.frameStart + FRAME_T;
    while (m.tstates < end) { if (cpu.halted) break; hook(); Z.runZ80(cpu, m.bus, 1, m); }
    M.runFrame(m);
    if (!armed) continue;
    const fr = rd16(m, S.V_FRAMES);
    if (prevFrames === null) { prevFrames = fr; continue; }
    st.refreshes++;
    if (cpu.pc === 0x0038) st.accepted++;
    st.framesAdv += (fr - prevFrames) & 0xFFFF;
    prevFrames = fr;
    if (fr === 0 || st.ticks === 0) continue;
    if (cur?.executing?.op === 'mode') { st.skipped++; continue; }    // RT_WIREMODE ON may be writing the attributes of the file on screen right now
    const bit = m.portFF & 1, base = bit ? 0x6000 : 0x4000;
    let bad = 0, where = '';
    for (let i = 0; i < 6144; i++) if (m.ram[base + i] !== exp.bm[bit][i]) { if (!bad) where = `bitmap ${hex(base + i)} = ${hex(m.ram[base + i], 2)} want ${hex(exp.bm[bit][i], 2)}`; bad++; }
    for (let i = 0; i < 768; i++) if (m.ram[base + 0x1800 + i] !== exp.at[bit][i]) { if (!bad) where = `attr row ${i >> 5} col ${i & 31} = ${hex(m.ram[base + 0x1800 + i], 2)} want ${hex(exp.at[bit][i], 2)}`; bad++; }
    if (bad) { st.bad++; if (st.firstBad.length < 3) st.firstBad.push(`refresh ${st.refreshes} (ticks ${st.ticks}) file ${bit + 1}: ${bad} bytes, first ${where}`); }
  }
  st.ms = Date.now() - tStart;
  return st;
}

// ---- scenario generation -----------------------------------------------------------------------------------------------------------------
const STATIC = [[0, 10, 0], [1, 40, 2], [2, 70, 0], [3, 120, 176], [4, 160, 176], [5, 200, 170], [6, 100, 80], [7, 200, 10]];   // [i, x, y]
/** Ticks of a scene.  opts: { area (null: no wire ops), L, modes: {tick: [[where, a], ...]} (pre / mid / post), effectEvery, nModels: [lo, hi] }. */
function genTicks(R, L, { area = null, modes = {}, effectEvery = 0, nModels = [1, 3], texts = {}, noSprites = false } = {}) {
  const ticks = [];
  const eye = { x: 0, y: 0, z: 0, a: 0 };
  const mov = [{ i: 8, x: 30, y: 60 }, { i: 9, x: 180, y: 120 }];
  for (let n = 0; n < L; n++) {
    const t = [];
    const md = modes[n] ?? [];
    for (const [w, a] of md) if (w === 'pre') t.push({ op: 'mode', a });
    if (n === 0 && !noSprites) for (const [i, x, y] of STATIC) t.push({ op: 'show', i, x, y });
    for (const s of noSprites ? [] : mov) {
      if (R.chance(0.07)) { t.push({ op: 'hide', i: s.i }); continue; }
      if (R.chance(0.1)) { s.x = R.int(-10, 250); s.y = R.int(-10, 190); } else { s.x += R.int(-6, 6); s.y += R.int(-6, 6); }
      t.push({ op: 'show', i: s.i, x: s.x, y: s.y });
    }
    if (area) {
      if (n % 2 === 0) { eye.a = (eye.a + R.int(-4, 4)) & 255; eye.x += R.int(-30, 30); eye.z += R.int(-10, 40); t.push({ op: 'eye', ...eye }); }
      const nm = R.int(nModels[0], nModels[1]);
      for (let k = 0; k < nm; k++) {
        const f = R.int(120, 1400), l = R.int(-f >> 1, f >> 1), u = R.int(-(f >> 2), f >> 2);
        const C0 = W.cosa(eye.a), S0 = W.sina(eye.a);
        const x = eye.x + Math.round((l * C0 + f * S0) / 256), z = eye.z + Math.round((-l * S0 + f * C0) / 256);
        t.push({ op: 'dm', m: R.pick(['cube', 'octa', 'gate', 'gate', 'big']), k: R.int(0, 2), x, y: eye.y + u, z, yaw: R.int(0, 255), pitch: R.pick([0, R.int(0, 255)]) });
        if (k === 0) for (const [w, a] of md) if (w === 'mid') t.push({ op: 'mode', a });
      }
      for (let k = R.int(0, 2); k > 0; k--) {
        const y0 = R.int(area.ymin - 20, area.ymax + 20), y1 = R.int(area.ymin - 20, area.ymax + 20);
        t.push({ op: 'line', x0: R.int(-30, 285), y0, x1: R.int(-30, 285), y1 });
      }
    } else for (const [w, a] of md) if (w === 'mid') t.push({ op: 'mode', a });
    if (n % 5 === 0) { t.push({ op: 'at', row: 0, col: 20 }, { op: 'prints', s: 'T' + n }, { op: 'at', row: 23, col: 2 }, { op: 'ink', a: n & 7 }, { op: 'prints', s: 'HUD' + (n % 97) }, { op: 'ink', a: 0 }); }
    if (texts[n]) t.push({ op: 'at', row: texts[n][0], col: texts[n][1] }, { op: 'paper', a: 6 }, { op: 'prints', s: texts[n][2] }, { op: 'paper', a: 7 });
    if (R.chance(0.15)) t.push({ op: 'tile', t: R.int(0, 11), row: R.int(0, 23), col: R.int(0, 31) });
    if (effectEvery && n % effectEvery === 0) t.push({ op: 'play', i: 0 });
    for (const [w, a] of md) if (w === 'post') t.push({ op: 'mode', a });
    ticks.push(t);
  }
  return ticks;
}
const randomMap = (R) => Array.from({ length: 768 }, () => (R.chance(0.25) ? 0x80 | R.int(0, 11) : R.chance(0.3) ? R.int(33, 126) : 32));

const results = {};
// =====================================================================================================================================
// 1. Scenario A
// =====================================================================================================================================
console.log('\n--- 1. scenario A: rows 2..21, HUD, sprites, text, the switch in every position ---');
{
  const R = rng(17101);
  const desc = [2, 21, 0x45];
  const area = W.areaOf(2, 21);
  const modes = { 40: [['post', 0]], 70: [['pre', 1]], 71: [['pre', 1]], 100: [['mid', 0]], 101: [['pre', 0]], 120: [['mid', 1]], 140: [['mid', 0], ['post', 1]], 150: [['pre', 0]] };
  const texts = { 30: [10, 4, 'PLAY'], 31: [21, 0, 'EDGE'], 80: [12, 20, 'AGAIN'] };
  const L = 160;
  const ticks = genTicks(R, L, { area, modes, effectEvery: 25, texts, nModels: [1, 2] });
  const map = randomMap(R);
  const game = wireGame({ div: 0xC2, desc, ticks, map, sfx: busyEffect(R, 40) });
  const exp = new Expect({ has: true, desc, map });
  const textCheck = { hiddenWhileOn: 0, hiddenTicks: 0, shownAfterOff: new Set(), attrsOn: new Set(), bootOn: null, staleRec: 0, hiddenRecs: 0 };
  const glyphRows = (idx) => exp.m.glyph(idx);
  const spriteOver = (row, col) => exp.m.insts.some((sp) => { if (!sp.visible) return false; const a = exp.m.assets[sp.asset], x = exp.m.drawX(sp); return x < 8 * col + 8 && x + a.w + 8 > 8 * col && sp.y < 8 * row + 8 && sp.y + a.h > 8 * row; });
  const cellBytes = (m, f, row, col) => Array.from({ length: 8 }, (_, k) => m.ram[(f ? 0x6000 : 0x4000) + rowAddr(8 * row + k) + col]);
  const st = run(game, exp, QUICK ? 400 : 1200, {
    onStart: (s, cur) => { if (textCheck.bootOn === null) textCheck.bootOn = cur.vwire; },
    onTick: (s, cur) => {
      const m = s.m, idx = 10 * 32 + 4;
      if (cur.n >= 3) for (let i = 0; i < INSTS.length; i++) if (!exp.m.insts[i].visible) { textCheck.hiddenRecs++; if (m.ram[S.SPR_DRAWN + 64 * cur.h + 4 * i] !== 0) textCheck.staleRec++; }   // an instance that is not shown has no record in the file just drawn
      if (cur.n >= 31 && cur.n < 40) {        // on: the PLAY text (row 10) is in the cell map but neither its glyphs nor its attribute are in the file just drawn
        textCheck.hiddenTicks++;
        const g = glyphRows(idx), got = cellBytes(m, cur.h, 10, 4);
        if (exp.m.tile[idx] === 'P'.charCodeAt(0) && m.ram[(cur.h ? 0x7800 : 0x5800) + idx] === 0x45 && got.some((v, k) => v !== g[k])) textCheck.hiddenWhileOn++;
      }
      if (cur.n >= 42 && cur.n < 46) {        // off since tick 40: both files (each drawn twice since) show the glyphs (unless a sprite is over the cell) and the text's attribute
        const g = glyphRows(idx), got = cellBytes(m, cur.h, 10, 4);
        if ((spriteOver(10, 4) || got.every((v, k) => v === g[k])) && m.ram[(cur.h ? 0x7800 : 0x5800) + idx] === exp.m.attr[idx] && exp.m.attr[idx] === 0x30) textCheck.shownAfterOff.add(cur.h);
      }
      if (cur.n === 70) {                     // ON before the draws: the play-area attributes of both files are the area's
        let ok = 0;
        for (const f of [0, 1]) { let all = true; for (let r = 2; r <= 21; r++) for (let c = 0; c < 32; c++) if (m.ram[(f ? 0x7800 : 0x5800) + 32 * r + c] !== 0x45) all = false; if (all) ok++; }
        if (ok === 2) textCheck.attrsOn.add(70);
      }
    },
  });
  results.A = st;
  check(`scenario A: ${st.refreshes} refreshes, ${st.ticks} ticks (${st.onTicks} with the play area on, ${st.offTicks} off): the file on screen equals the expectation after every refresh (bitmap and attributes)`,
    st.bad === 0 && st.ticks > 150 && st.onTicks > 50 && st.offTicks > 30, st.firstBad.join(' | ') || `${st.skipped} refreshes inside a WIREMODE op not compared`);
  check(`  ... skip_analysis, wire_erase and redraw_dirty wrote no play-area pixel or attribute in the ${st.watchedTicks} ticks with the area on`, st.playWrites === 0 && st.watchedTicks > 50, `${st.playWrites} writes`);
  check('  ... the boot turned the area on (V_WIRE = 3 at the first tick), every op of every tick ran', textCheck.bootOn === 3 && st.opsBad === 0, `V_WIRE ${textCheck.bootOn}, ${st.opsBad}`);
  check('  ... the skip analysis marked instances (HUD sprites) in ticks with the play area on and off', st.anySkip > 20, `${st.anySkip} ticks`);
  check(`  ... wire_erase clears the drawn flag of the record of an instance that is no longer shown (${textCheck.hiddenRecs} hidden-instance records looked at, ${textCheck.staleRec} stale)`, textCheck.staleRec === 0 && textCheck.hiddenRecs > 10, `${textCheck.staleRec} / ${textCheck.hiddenRecs}`);
  check(`  ... text PRINTed into a play row is not shown while on (${textCheck.hiddenWhileOn} of ${textCheck.hiddenTicks} ticks: neither glyph nor attribute) and appears after OFF in both files`,
    textCheck.hiddenWhileOn === textCheck.hiddenTicks && textCheck.hiddenTicks === 9 && textCheck.shownAfterOff.size === 2, `files ${[...textCheck.shownAfterOff]}`);
  check('  ... ON again writes the area\'s attribute into the play rows of both files', textCheck.attrsOn.has(70));
  check(`  ... no frame interrupt lost: ${st.accepted} accepted of ${st.refreshes} refreshes, V_FRAMES +${st.framesAdv}, ${st.isrEntries} handler entries`,
    st.accepted === st.refreshes && st.framesAdv === st.refreshes && Math.abs(st.isrEntries - st.refreshes) <= 1);
  console.log(`      (${(st.ms / 1000).toFixed(1)} s; clear start after the interrupt: max ${fmt(Math.max(...st.clearStart))} T; interrupts off ${fmt(Math.max(...st.clearOff))} T max)`);
}

// =====================================================================================================================================
// 2. Scenario B: the near-worst clear, interrupts counted
// =====================================================================================================================================
console.log('\n--- 2. scenario B: rows 0..23 (the largest clear), a busy three-channel effect replayed, >= 600 refreshes ---');
{
  const R = rng(17102);
  const desc = [0, 23, 0x07];
  const area = W.areaOf(0, 23);
  const ticks = genTicks(R, 90, { area, effectEvery: 8, nModels: [1, 2] });
  const game = wireGame({ div: 0xC1, desc, ticks, wrap: true, sfx: busyEffect(R, 50) });
  const exp = new Expect({ has: true, desc });
  const st = run(game, exp, QUICK ? 620 : 1200);
  results.B = st;
  const cs = Math.max(...st.clearStart), ce = Math.max(...st.clearEnd), co = Math.max(...st.clearOff);
  check(`scenario B: ${st.refreshes} refreshes, ${st.ticks} ticks, ${st.clearStart.length} clears of 24 rows: every frame interrupt taken (${st.accepted} accepted, V_FRAMES +${st.framesAdv}, ${st.isrEntries} handler entries)`,
    st.refreshes >= 600 && st.accepted === st.refreshes && st.framesAdv === st.refreshes && Math.abs(st.isrEntries - st.refreshes) <= 1 && st.clearStart.length > 100);
  check(`  ... the pictures equal the expectation after every refresh; nothing but the clear, the lines and the sprites wrote the play area (${st.watchedTicks} ticks watched)`, st.bad === 0 && st.playWrites === 0 && st.watchedTicks > 100, st.firstBad.join(' | ') || `${st.playWrites} writes`);
  check(`  ... the clear starts within ${fmt(cs)} T of the interrupt (contract: about 100 T after the handler) and its interrupts-off span (max ${fmt(co)} T <= 37,000) ends ${fmt(ce)} T after it (< ${fmt(FRAME_T)})`,
    co <= 37000 && ce < FRAME_T, '');
  console.log(`      (${(st.ms / 1000).toFixed(1)} s; the wrap of the 90-tick script happened ${Math.floor(st.ticks / 90)} times)`);
  results.clearStart = cs; results.clearEnd = ce; results.clearOff = co;
}

// =====================================================================================================================================
// 3. Scenario C: a NOVIEW first scene
// =====================================================================================================================================
console.log('\n--- 3. scenario C: a NOVIEW first scene (RT_WIREMODE 0 in init_entry, before the first tick) ---');
{
  const R = rng(17103);
  const desc = [3, 18, 0x46];
  const area = W.areaOf(3, 18);
  const ticks = genTicks(R, 80, { area, modes: { 30: [['pre', 1]], 60: [['post', 0]] }, texts: { 5: [6, 3, 'TITLE'] } });
  const map = randomMap(R);
  const game = wireGame({ div: 0xC1, desc, ticks, map, initMode: 0 });
  const exp = new Expect({ has: true, desc, initMode: 0, map });
  let first = null;
  const st = run(game, exp, QUICK ? 220 : 500, { onStart: (s, cur) => { first ??= { vwire: cur.vwire, won: s.m.ram[K.W_ON] }; } });
  check(`scenario C: the first tick finds the area off (V_WIRE = 2, W_ON = 0); ${st.refreshes} refreshes (${st.offTicks} ticks off, ${st.onTicks} on) equal the expectation`,
    first?.vwire === 2 && first?.won === 0 && st.bad === 0 && st.onTicks > 20 && st.offTicks > 40, st.firstBad.join(' | ') || JSON.stringify(first));
}

// =====================================================================================================================================
// 3b. Scenarios D, E, F (W6, the mutation test): no sprite instance at all; the smallest play area (4 rows); the lowest rows
// =====================================================================================================================================
console.log('\n--- 3b. scenario D: no sprite instance (NINST = 0), rows 2..21; scenarios E, F: rows 5..8 (4 rows) and 20..23 ---');
{
  const R = rng(17106);
  const desc = [2, 21, 0x45];
  const area = W.areaOf(2, 21);
  const ticks = genTicks(R, 60, { area, noSprites: true, modes: { 20: [['mid', 0]], 30: [['pre', 1]], 40: [['post', 0]], 50: [['mid', 1]] }, texts: { 3: [10, 4, 'NOSPR'], 22: [10, 4, 'AGAIN'] } });
  const map = randomMap(R);
  const game = wireGame({ div: 0xC1, desc, ticks, map, insts: [] });
  const exp = new Expect({ has: true, desc, map, insts: [] });
  const st = run(game, exp, QUICK ? 150 : 300);
  check(`scenario D: no instance: ${st.refreshes} refreshes (${st.onTicks} ticks on, ${st.offTicks} off) equal the expectation (wire_unchanged and wire_erase with NINST = 0)`, st.bad === 0 && st.onTicks > 20 && st.offTicks > 10 && st.accepted === st.refreshes, st.firstBad.join(' | '));
  for (const [r0, r1, attr] of [[5, 8, 0x4A], [20, 23, 0x43]]) {
    const d = [r0, r1, attr], ar = W.areaOf(r0, r1);
    const R2 = rng(17107 + r0);
    const ticks2 = genTicks(R2, 70, { area: ar, modes: { 25: [['mid', 0]], 40: [['pre', 1]], 55: [['post', 0]], 60: [['pre', 1]] }, nModels: [1, 2], texts: { 4: [r0 + 1, 8, 'IN'], 30: [r0, 0, 'TOP'] } });
    const map2 = randomMap(R2);
    const g2 = wireGame({ div: 0xC1, desc: d, ticks: ticks2, map: map2 });
    const e2 = new Expect({ has: true, desc: d, map: map2 });
    const s2 = run(g2, e2, QUICK ? 150 : 300);
    check(`scenario ${r0 === 5 ? 'E' : 'F'}: rows ${r0}..${r1} (${r1 - r0 + 1} rows, attribute $${attr.toString(16)}): ${s2.refreshes} refreshes (${s2.onTicks} ticks on, ${s2.offTicks} off) equal the expectation`,
      s2.bad === 0 && s2.onTicks > 20 && s2.offTicks > 5 && s2.playWrites === 0, s2.firstBad.join(' | ') || `${s2.playWrites} play writes`);
  }
}

// =====================================================================================================================================
// 4. Games without the play area
// =====================================================================================================================================
console.log('\n--- 4. games without the play area: $F4E0-$FA7F untouched, V_WIRE 0, RT_WIREMODE a no-op, the cost at WORK_START ---');
{
  const POISON = (a) => (a * 13 + 0x5B) & 0xFF;
  const LO = 0xF4E0, HI = 0xFA80;
  for (const [name, div, desc] of [['DIV_EXT only (18-byte header)', 0x81, [2, 21, 0x45]], ['the 16-byte header (frame_div 2)', 0x02, [2, 21, 0x45]],
    ['DIV_EXT | DIV_WIRE, r1 = 24', 0xC1, [2, 24, 0x45]], ['DIV_EXT | DIV_WIRE, 3 rows (r1 = r0 + 2)', 0xC1, [5, 7, 0x45]], ['DIV_EXT | DIV_WIRE, r1 < r0 (10, 5)', 0xC1, [10, 5, 0x45]],
    ['DIV_EXT | DIV_WIRE, r1 < r0 by one (10, 9)', 0xC1, [10, 9, 0x45]], ['DIV_EXT | DIV_WIRE, r0 = r1 = 0', 0xC1, [0, 0, 0x45]], ['DIV_EXT | DIV_WIRE, r1 = 255', 0xC1, [200, 255, 0x45]],
    ['DIV_EXT | DIV_WIRE, a null descriptor', 0xC1, null]]) {
    const R = rng(17104 + div + (desc?.[1] ?? 0));
    const ticks = genTicks(R, 60, { modes: { 10: [['pre', 1]], 20: [['mid', 0]], 30: [['post', 1]] }, texts: { 4: [10, 4, 'NOWIRE'] } });
    const map = randomMap(R);
    const game = wireGame({ div, desc, ticks, map, initMode: 0 });
    const exp = new Expect({ has: false, map });
    let vw = new Set();
    const st = run(game, exp, QUICK ? 120 : 300, {
      poison: (m) => { for (let a = LO; a < HI; a++) m.ram[a] = POISON(a); },
      onStart: (s, cur) => vw.add(cur.vwire),
    });
    let changed = 0, firstAt = -1;
    for (let a = LO; a < HI; a++) if (st.m.ram[a] !== POISON(a)) { changed++; if (firstAt < 0) firstAt = a; }
    check(`${name}: ${st.refreshes} refreshes, $F4E0-$FA7F (poisoned at the entry) untouched, V_WIRE 0 at every tick, pictures = the cell map and sprites`,
      changed === 0 && vw.size === 1 && vw.has(0) && st.bad === 0 && st.accepted === st.refreshes, `${changed} bytes changed${firstAt >= 0 ? ' from ' + hex(firstAt) : ''}; ${st.firstBad.join(' | ')}`);
    if (div === 0x81) results.work = st.workToFrame;
  }
  // WORK_START -> frame_entry: before W2 ld a,(nn) 13, and n 7, xor n 7, ld (nn),a 13, 3 x rrca 12, ld (nn),a 13, ld hl,(nn) 16, call 17, jp (hl) 4 = 102 T
  const w = results.work, wmin = Math.min(...w), wmax = Math.max(...w);
  check(`the cost of the tick for a game without the play area: WORK_START -> frame_entry takes ${wmin}..${wmax} T (102 before W2): +${wmax - 102} T <= 40`, wmin === wmax && wmax - 102 <= 40 && wmax - 102 > 0);
  results.addedT = wmax - 102;
}

// =====================================================================================================================================
// 5. RT_WIREMODE called directly
// =====================================================================================================================================
console.log('\n--- 5. RT_WIREMODE called directly: cost, registers, exactly what it writes ---');
function bootTo(game) {
  const m = newMachine(game.dck);
  const F = entryFrame(game.dck);
  for (let f = 0; f < F + 4; f++) M.runFrame(m);
  for (let i = 0; i < 3000000 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);
  if (m.cpu.pc !== S.TICK_LOOP) throw new Error('TICK_LOOP not reached');
  return m;
}
{
  const R = rng(17105);
  const desc = [2, 21, 0x45];
  const game = wireGame({ div: 0xC1, desc, ticks: genTicks(R, 1, {}), initMode: 0xFF });
  const m = bootTo(game);
  const STACK = (a) => a >= 0xFB00 && a < 0xFF00;
  const writes = (before) => { const out = []; for (let a = 0x4000; a < 0x10000; a++) if (m.ram[a] !== before[a] && !STACK(a)) out.push(a); return out; };
  const inRows = (a, base, r0, r1, per) => a >= base + per * r0 && a < base + per * (r1 + 1);
  let b = m.ram.slice();
  const off = callRoutine(m, S.RT_WIREMODE, { a: 0 });
  let wr = writes(b);
  const offOk = wr.every((a) => inRows(a, K.DIRTY0, 2, 21, 4) || inRows(a, K.DIRTY1, 2, 21, 4) || a === K.V_WIRE || a === K.W_ON) && m.ram[K.V_WIRE] === 2 && m.ram[K.W_ON] === 0 &&
    Array.from({ length: 80 }, (_, i) => m.ram[K.DIRTY0 + 8 + i] === 0xFF && m.ram[K.DIRTY1 + 8 + i] === 0xFF).every(Boolean);
  check(`RT_WIREMODE 0 (on -> off): ${fmt(off.t)} T; writes V_WIRE = 2, W_ON = 0 and the play rows' dirty bytes (all $FF) of both maps, nothing else; IX, IY, alternates kept`, offOk && off.preserved && off.spOk, `${wr.length} bytes`);
  for (let i = 0; i < 80; i++) { m.ram[K.DIRTY0 + 8 + i] = 0; m.ram[K.DIRTY1 + 8 + i] = 0; }   // so that a second OFF writing $FF again would show
  b = m.ram.slice();
  const offAgain = callRoutine(m, S.RT_WIREMODE, { a: 0 });
  check(`RT_WIREMODE 0 when off: ${offAgain.t} T, nothing written (the play rows' dirty bytes, set to 0 first, stay 0)`, writes(b).length === 0);
  b = m.ram.slice();
  for (const f of [0x5800, 0x7800]) for (let i = 0; i < 768; i++) m.ram[f + i] = 0x38;
  b = m.ram.slice();
  // the switch on clears the play rows of the hidden file ($40 + V_HOFF) with interrupts on: both bitmaps are filled with a pattern first
  const hid = m.ram[S.V_HOFF] ? 0x6000 : 0x4000, shown = hid ^ 0x2000;
  const playByte = (o) => { const y = ((o >> 5) & 0xC0) | ((o >> 8) & 7) | ((o >> 2) & 0x38); return y >= 16 && y < 176; };
  for (const f of [0x4000, 0x6000]) for (let i = 0; i < 6144; i++) m.ram[f + i] = 0x5A ^ (i & 0xFF);
  b = m.ram.slice();
  const on = callRoutine(m, S.RT_WIREMODE, { a: 7 });
  wr = writes(b);
  const onOk = wr.every((a) => inRows(a, 0x5800, 2, 21, 32) || inRows(a, 0x7800, 2, 21, 32) || (a >= hid && a < hid + 6144 && playByte(a - hid)) || a === K.V_WIRE || a === K.W_ON || a === S.W_HIDHI) && m.ram[K.V_WIRE] === 3 && m.ram[K.W_ON] === 1 &&
    [0x5800, 0x7800].every((f) => Array.from({ length: 768 }, (_, i) => m.ram[f + i] === ((i >> 5) >= 2 && (i >> 5) <= 21 ? 0x45 : 0x38)).every(Boolean));
  const clearedOk = Array.from({ length: 6144 }, (_, i) => playByte(i) ? m.ram[hid + i] === 0 : m.ram[hid + i] === (0x5A ^ (i & 0xFF))).every(Boolean) &&
    Array.from({ length: 6144 }, (_, i) => m.ram[shown + i] === (0x5A ^ (i & 0xFF))).every(Boolean);
  check(`RT_WIREMODE 7 (off -> on): ${fmt(on.t)} T; writes V_WIRE = 3, W_ON = 1, the attribute $45 into rows 2..21 of both attribute files and 0 into the play rows (pixel rows 16..175) of the hidden file's bitmap (${hex(hid)}), nothing else (the file on screen untouched); registers kept`, onOk && clearedOk && on.preserved && on.spOk, `${wr.length} bytes`);
  {
    // the same switch again with interrupts ON (IM 1; TSRun raises none while single-stepping): IFF1 must stay set at every instruction
    callRoutine(m, S.RT_WIREMODE, { a: 0 });
    for (let i = 0; i < 6144; i++) m.ram[hid + i] = 0xA5;
    const cpu = m.cpu, saved = { ...cpu }, sp0 = cpu.sp;
    cpu.a = 1; cpu.iff1 = cpu.iff2 = true; cpu.im = 1; cpu.halted = false; cpu.eiDelay = false;
    cpu.sp = (sp0 - 2) & 0xFFFF; m.bus.write(cpu.sp, 0x00); m.bus.write(cpu.sp + 1, 0x5B);   // return to $5B00
    cpu.pc = S.RT_WIREMODE;
    let steps = 0, off = 0, inClear = 0;
    while (cpu.pc !== 0x5B00 && steps++ < 400000) { Z.runZ80(cpu, m.bus, 1, m); if (!cpu.iff1) off++; if (cpu.pc === S.wire_clear_on) inClear++; }
    const zero = Array.from({ length: 6144 }, (_, i) => !playByte(i) || m.ram[hid + i] === 0).every(Boolean);
    Object.assign(cpu, saved);
    check(`  ... with interrupts on, the switch (and its clear, wire_clear_on) never turns them off: ${steps} instructions, ${off} with IFF1 = 0; the play rows cleared again`, cpu && steps < 400000 && inClear === 1 && off === 0 && zero);
  }
  for (const f of [0x5800, 0x7800]) for (let i = 64; i < 704; i++) m.ram[f + i] = 0x3A;      // so that a second ON writing the area's attribute again would show
  for (let i = 0; i < 6144; i++) if (playByte(i)) m.ram[hid + i] = 0x77;                      // ... nor the clear of the hidden file's play rows (only a switch from off clears)
  b = m.ram.slice();
  const onAgain = callRoutine(m, S.RT_WIREMODE, { a: 1 });
  check(`RT_WIREMODE 1 when on: ${onAgain.t} T, nothing written (the play rows' attributes, set to $3A, and the hidden bitmap's, set to $77, first: they stay)`, writes(b).length === 0);
  results.on = on.t; results.off = off.t;
  // the largest area
  const g24 = wireGame({ div: 0xC1, desc: [0, 23, 0x07], ticks: genTicks(R, 1, {}) });
  const m24 = bootTo(g24);
  const off24 = callRoutine(m24, S.RT_WIREMODE, { a: 0 }), on24 = callRoutine(m24, S.RT_WIREMODE, { a: 1 });
  console.log(`      rows 0..23: off ${fmt(off24.t)} T, on ${fmt(on24.t)} T`);
  results.on24 = on24.t; results.off24 = off24.t;
  // a game without the play area
  const g0 = wireGame({ div: 0x81, desc: [2, 21, 0x45], ticks: genTicks(R, 1, {}) });
  const m0 = bootTo(g0);
  for (let a = 0xF4E0; a < 0xFA80; a++) m0.ram[a] = 0xA5;
  let bad = 0, tt = [];
  for (const a of [0, 1, 0xFF]) { const bb = m0.ram.slice(); const r = callRoutine(m0, S.RT_WIREMODE, { a }); tt.push(r.t); for (let k = 0x4000; k < 0x10000; k++) if (m0.ram[k] !== bb[k] && !STACK(k)) bad++; }
  check(`a game without the play area: RT_WIREMODE 0 / 1 / $FF write nothing (${tt.join(' / ')} T)`, bad === 0);
}

// =====================================================================================================================================
// 5b. wire_unchanged and wire_erase called directly (W6)
// =====================================================================================================================================
console.log('\n--- 5b. wire_unchanged on every y of the three asset heights; wire_unchanged / wire_erase with no instance ---');
{
  const R = rng(17108);
  const game = wireGame({ div: 0xC1, desc: [2, 21, 0x45], ticks: genTicks(R, 1, {}), initMode: 0xFF });
  const m = bootTo(game);
  const STACKR = (a) => a >= 0xFB00 && a < 0xFF00;
  const YMIN = 16, YMAX = 175;                                     // rows 2..21
  let bad = 0, first = '', n = 0;
  for (const k of [0, 1, 2]) {
    const i = INSTS.indexOf(k), h = ASSETS[k].h, e = S.SPR_TAB + 6 * i;
    for (let y = 0; y <= 176; y++) for (const vis of [1, 0]) for (const chg of [0, 2]) {
      for (let j = 0; j < 16; j++) m.ram[S.V_CHG + j] = 0;
      m.ram[e] = vis; m.ram[e + 4] = y; m.ram[e + 5] = 0;
      m.ram[S.V_CHG + i] = chg;
      callRoutine(m, S.wire_unchanged);
      n++;
      const touches = y <= YMAX && y + h > YMIN;
      const want = chg || (vis && touches ? 1 : 0);
      let others = 0;
      for (let j = 0; j < 16; j++) if (j !== i) others += m.ram[S.V_CHG + j];
      if (m.ram[S.V_CHG + i] !== want || others) { bad++; first ||= `asset ${k} (h ${h}) y ${y} visible ${vis} V_CHG ${chg}: V_CHG = ${m.ram[S.V_CHG + i]}, want ${want}${others ? ' (another instance changed)' : ''}`; }
    }
    m.ram[e] = 0; m.ram[e + 4] = 0;
  }
  check(`wire_unchanged marks (V_CHG = 1) exactly the visible, unchanged instances whose rows y .. y + h - 1 meet pixel rows ${YMIN}..${YMAX}: ${n} cases (assets of height ${ASSETS.map((a) => a.h)}, y = 0..176, visible or not, V_CHG 0 or 2 kept)`, bad === 0, first);
  // no instance: a loop over 256 entries of whatever SPR_TAB holds would write; poisoned tables must stay as they are
  m.ram[S.V_NINST] = 0;
  for (let j = 0; j < 96; j++) m.ram[S.SPR_TAB + j] = [1, 0, 0, 0, 50, 0][j % 6];
  for (let j = 0; j < 16; j++) m.ram[S.V_CHG + j] = 0;
  let b = m.ram.slice();
  callRoutine(m, S.wire_unchanged);
  const wu = []; for (let a = 0x4000; a < 0x10000; a++) if (m.ram[a] !== b[a] && !STACKR(a)) wu.push(a);
  check(`wire_unchanged with no instance writes nothing (SPR_TAB poisoned with visible instances in the play area)`, wu.length === 0, `${wu.length} bytes, first ${hex(wu[0] ?? 0)}`);
  for (const f of [0, 1]) for (let j = 0; j < 16; j++) { m.ram[S.SPR_DRAWN + 64 * f + 4 * j] = 1; m.ram[S.SPR_DRAWN + 64 * f + 4 * j + 1] = 0x40; m.ram[S.SPR_DRAWN + 64 * f + 4 * j + 2] = 0x40; m.ram[S.SPR_DRAWN + 64 * f + 4 * j + 3] = 4; }
  for (let a = S.SPR_DRAWN + 128; a < 0xD600; a++) m.ram[a] = 1;
  for (let j = 0; j < 96; j++) { m.ram[S.DIRTY0 + j] = 0xFF; m.ram[S.DIRTY1 + j] = 0xFF; }
  m.ram[S.V_HIDDEN] = 0;
  b = m.ram.slice();
  callRoutine(m, S.wire_erase);
  const we = []; for (let a = 0x4000; a < 0x10000; a++) if (m.ram[a] !== b[a] && !STACKR(a)) we.push(a);
  check(`wire_erase with no instance writes only the play rows' dirty bytes of the hidden map (80 bytes cleared; SPR_DRAWN poisoned with drawn flags)`,
    we.length === 80 && we.every((a) => a >= S.DIRTY0 + 8 && a < S.DIRTY0 + 88 && m.ram[a] === 0), `${we.length} bytes, first ${hex(we[0] ?? 0)}`);
}

// =====================================================================================================================================
// 6. Negative controls
// =====================================================================================================================================
console.log('\n--- 6. negative controls: wire_tick without wire_unchanged / with erase_all instead of wire_erase ---');
{
  const findCall = (img, target) => { for (let a = S.wire_tick; a < S.wire_tick + 40; a++) if (img[a] === 0xCD && img[a + 1] === (target & 0xFF) && img[a + 2] === target >> 8) return a; return -1; };
  const R = rng(17101);
  const desc = [2, 21, 0x45];
  const area = W.areaOf(2, 21);
  const ticks = genTicks(R, 60, { area, texts: { 3: [10, 4, 'PLAY'] } });
  const map = randomMap(R);
  const base = wireGame({ div: 0xC2, desc, ticks, map });
  const at1 = findCall(base.img, S.wire_unchanged), at2 = findCall(base.img, S.wire_erase);
  if (at1 < 0 || at2 < 0) throw new Error('calls not found in wire_tick');
  const g1 = wireGame({ div: 0xC2, desc, ticks, map, patch: [[at1, 0], [at1 + 1, 0], [at1 + 2, 0]] });
  const g2 = wireGame({ div: 0xC2, desc, ticks, map, patch: [[at2 + 1, S.erase_all & 0xFF], [at2 + 2, S.erase_all >> 8]] });
  const s1 = run(g1, new Expect({ has: true, desc, map }), 120), s2 = run(g2, new Expect({ has: true, desc, map }), 120);
  check(`without wire_unchanged (a static sprite in the play area is skipped, the clear removes it) the comparison fails (${s1.bad} refreshes)`, s1.bad > 0);
  check(`with erase_all instead of wire_erase (play rows redrawn from the cell map) the comparison fails (${s2.bad} refreshes)`, s2.bad > 0);
}

console.log('\nfigures (TSRun, exact T-states, no contention):');
console.log(`  added to the tick of a game without the play area: ${results.addedT} T (one test at WORK_START)`);
console.log(`  the clear's start after the interrupt (scenario B, rows 0..23, busy effect): max ${fmt(results.clearStart)} T; interrupts off max ${fmt(results.clearOff)} T, ending ${fmt(results.clearEnd)} T after the interrupt`);
console.log(`  RT_WIREMODE rows 2..21: on ${fmt(results.on)} T, off ${fmt(results.off)} T; rows 0..23: on ${fmt(results.on24)} T, off ${fmt(results.off24)} T`);
finish('m17 runtime wireframe tick (W2)');
