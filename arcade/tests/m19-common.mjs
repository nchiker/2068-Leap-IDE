"use strict";
// m19-common.mjs -- shared harness of the fine colour runtime tests (slice F2 of docs/ARCADE_FINE_COLOUR_CONTRACT.md): the test game
// (runtime/v2/test_fine.asm + data written here), the model (m5-common's Model5: cells, text, tiles, FILL / FILLC, instances; the fine picture from
// m19-fine-ref.mjs), and `run()`, which boots a game on a stock TS2068 (TSRun), steps it one instruction at a time from the cartridge entry and checks
// after every update: in a fine scene the screen ($4000 bitmap + $6000 colours, $FF = 2) against the fine picture of the state, in a two-buffer tick
// the file it drew against the model; right after RT_FINEMODE the picture it built.
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { assembleGame, linkGame, dckOf, RUNTIME_DIR, OUT as OUT_DIR } from '../tools/build-runtime-v2.mjs';
import * as C from './m4-common.mjs';
import { Model5 } from './m5-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
import { picture } from './m19-fine-ref.mjs';

export const { M, Z, FRAME_T, FIRST_PIXEL_T, hex, makeChecks, rd8, rd16, newMachine, bootSkip, randomAsset, assetBytes, fontGlyph, normPhases } = C;
export { rng, randomTiles, picture, C };
export const rt = C.runtime();
export const S = rt.syms, K = rt.json.constants;
let _game = null;
export const GAME = () => (_game ??= assembleGame(join(RUNTIME_DIR, 'test_fine.asm'), { name: 'fine' }));

export const ADDR = { SPRTAB: 0x8800, INST: 0x8860, SPRDATA: 0x8960, TILESET: 0x8B60, TROWS: 0x9300, INKS: 0x9700, MAP: 0x9780, SFXTAB: 0x9A80,
  SFXDATA: 0x9A90, SFXEND: 0x9B00, BASE: 0x9B00, END: 0xC000, DESC: 0x83F8, INIT_MODE: 0x83FC, INIT_OPS: 0x83FD, INIT_SCRIPT: 0xBF00 };
const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
export const fmt = (v) => Math.round(v).toLocaleString('en-US');

export function encodeOp(o) {
  switch (o.op) {
    case 'show': return [1, o.i, ...w16(o.x), ...w16(o.y)];
    case 'hide': return [2, o.i];
    case 'at': return [3, o.row, o.col];
    case 'prints': { const c = typeof o.s === 'string' ? [...o.s].map((ch) => ch.charCodeAt(0)) : o.s; return [4, c.length, ...c]; }
    case 'ink': return [7, o.a];
    case 'paper': return [8, o.a];
    case 'bright': return [9, o.a];
    case 'cls': return [10];
    case 'tile': return [11, o.t, o.row, o.col];
    case 'play': return [12, o.i];
    case 'silence': return [13];
    case 'burn': return [16];
    case 'fill': return [21, ...w16(o.x), ...w16(o.y), ...w16(o.w), ...w16(o.h), ...w16(o.t)];
    case 'fillc': return [22, ...w16(o.x), ...w16(o.y), ...w16(o.w), ...w16(o.h), ...w16(o.c)];
    case 'mode': return [24, o.a];
    default: throw new Error('op ' + o.op);
  }
}

/** Busy three-channel effect (type 3): one entry of all 11 registers per refresh (the deepest the sound tick goes). */
export function busyEffect(R, n) {
  const out = [0, 0, 0, 3];
  for (let k = 0; k < n; k++) {
    out.push(11);
    for (let r = 0; r <= 10; r++) out.push(r, r === 7 ? 0x38 : r >= 8 ? R.int(0, 15) : R.int(0, r === 6 ? 31 : 255));
  }
  out.push(0xFF);
  return out;
}

/** Random inks per row (16 per asset). */
export const randomInks = (R) => Array.from({ length: 16 }, () => R.int(0, 7));
/** Random tiles with eight row attributes each (no FLASH: the picture keys do not model it). */
export function randomFineTiles(R, n) {
  return randomTiles(R, n).map((t) => ({ ...t, rows: Array.from({ length: 8 }, () => R.int(0, 0x7F)) }));
}

/**
 * The game image.  spec: { div, assets: [{w, h, phases, rows, inks}], insts, tiles: [{bmp, attr, rows}], noTileRows (descriptor's tile_rows 0),
 * initMode (0xFF none), ticks: [[ops]], wrap, map (768 cell values), sfx (bytes) }.
 */
export function fineGame(spec) {
  const g = GAME();
  const img = linkGame(rt.img, g.bytes);
  const put = (a, bytes) => img.set(bytes, a);
  img[0x8004] = spec.div ?? 1;
  const assets = spec.assets ?? [];
  img[0x8005] = assets.length;
  let at = ADDR.SPRDATA;
  assets.forEach((a, i) => {
    const b = assetBytes(a);
    put(at, b);
    put(ADDR.SPRTAB + 8 * i, [a.w, a.h, ...w16(at), 0, 0, a.phases, 0]);
    at += b.length;
  });
  if (at > ADDR.TILESET) throw new Error('sprite art does not fit');
  const insts = spec.insts ?? [];
  put(ADDR.INST, [insts.length, ...insts]);
  const tiles = spec.tiles ?? [];
  const ts = [tiles.length];
  for (const t of tiles) ts.push(...t.bmp, t.attr);
  put(ADDR.TILESET, ts);
  const trows = new Uint8Array(1024);
  tiles.forEach((t, k) => trows.set(t.rows, 8 * k));
  put(ADDR.TROWS, trows);
  const inks = new Uint8Array(128);
  assets.forEach((a, i) => inks.set(a.inks.slice(0, 16), 16 * i));
  const inksAt = spec.inksAt ?? ADDR.INKS;
  put(inksAt, inks);
  put(ADDR.DESC, [...w16(spec.noTileRows ? 0 : ADDR.TROWS), ...w16(inksAt)]);
  img[ADDR.INIT_MODE] = spec.initMode ?? 0xFF;
  if (spec.map) put(ADDR.MAP, spec.map);
  if (spec.sfx) { if (ADDR.SFXDATA + spec.sfx.length > ADDR.SFXEND) throw new Error('effect too long'); put(ADDR.SFXTAB, [1, ...w16(ADDR.SFXDATA)]); put(ADDR.SFXDATA, spec.sfx); }
  put(0x8008, [...w16(tiles.length ? ADDR.TILESET : 0), ...w16(spec.sfx ? ADDR.SFXTAB : 0), ...w16(spec.map ? ADDR.MAP : 0)]);
  img.fill(0, ADDR.BASE, ADDR.END);
  const bytes = spec.ticks.flatMap((t) => [...t.flatMap(encodeOp), 0]);
  if (spec.wrap) bytes.push(25);
  if (bytes.length > (spec.initOps ? ADDR.INIT_SCRIPT : ADDR.END) - ADDR.BASE) throw new Error('script too long: ' + bytes.length);
  put(ADDR.BASE, bytes);
  put(ADDR.INIT_OPS, w16(spec.initOps ? ADDR.INIT_SCRIPT : 0));
  if (spec.initOps) put(ADDR.INIT_SCRIPT, [...spec.initOps.flatMap(encodeOp), 0]);
  for (const [a, v] of spec.patch ?? []) img[a] = v;
  const ops = (n) => (n < spec.ticks.length ? spec.ticks[n] : !spec.wrap ? [] : n % spec.ticks.length === 0 ? [{ op: 'wrap' }, ...spec.ticks[0]] : spec.ticks[n % spec.ticks.length]);
  return { img, dck: dckOf(img), spec, ops };
}

// ---- the model -----------------------------------------------------------------------------------------------------------------------------
export class FineModel {
  constructor(spec) {
    this.m = new Model5({ assets: spec.assets ?? [], insts: spec.insts ?? [], tiles: spec.tiles ?? [], rawMap: spec.map ?? null });
    this.slots = (spec.assets ?? []).slice(0, 8).reduce((s, a) => s + normPhases(a.phases), 0);
    this.allowed = this.slots <= 32 && !spec.wire;
    this.glyphs = new Uint8Array(2048);
    for (let v = 32; v < 128; v++) this.glyphs.set(fontGlyph(v), 8 * v);
    (spec.tiles ?? []).slice(0, 128).forEach((t, k) => this.glyphs.set(t.bmp, 8 * (128 + k)));
    this.tileRows = new Uint8Array(1024);
    (spec.tiles ?? []).forEach((t, k) => this.tileRows.set(t.rows, 8 * k));
    this.noTileRows = !!spec.noTileRows;
    this.fassets = this.m.assets.map((a, i) => ({ w: a.w, h: a.h, image: a.rows.map((r) => r.image), mask: a.rows.map((r) => r.mask),
      inks: Array.from({ length: a.h }, (_, k) => (spec.assets[i].inks[k] ?? 0) & 7) }));
    this.fine = false;
  }
  /** Apply an op; returns 'on' / 'off' when it switched fine colour. */
  apply(o) {
    if (o.op === 'mode') {
      if (o.a && !this.fine && this.allowed) { this.fine = true; return 'on'; }
      if (!o.a && this.fine) { this.fine = false; return 'off'; }
      return null;
    }
    if (o.op !== 'wrap') this.m.apply(o);
    return null;
  }
  state({ noSprites = false } = {}) {
    const m = this.m;
    // without a tileset in the descriptor a tile cell takes its cell attribute on all rows: the reference gets those rows here
    let tileRows = this.tileRows, cells = m.tile;
    if (this.noTileRows) {
      const attrs = m.attr;
      return { cells, attrs, glyphs: this.glyphs, tileRows, assets: this.fassets, noTileRows: true,
        sprites: noSprites ? [] : m.insts.map((s) => ({ asset: s.asset, x: m.drawX(s), y: s.y, hidden: !s.visible })) };
    }
    return { cells, attrs: m.attr, glyphs: this.glyphs, tileRows, assets: this.fassets,
      sprites: noSprites ? [] : m.insts.map((s) => ({ asset: s.asset, x: m.drawX(s), y: s.y, hidden: !s.visible })) };
  }
  /** The fine picture of the state now. */
  finePic(opts) {
    const st = this.state(opts);
    if (st.noTileRows) {
      // the reference takes tile colours from tileRows: give each tile cell its own attribute through a private tile table
      const cells = st.cells.slice(), rows = new Uint8Array(1024), glyphs = st.glyphs.slice(), map = new Map();
      for (let i = 0; i < 768; i++) {
        if (cells[i] < 128) continue;
        const key = cells[i] * 256 + st.attrs[i];
        if (!map.has(key)) { if (map.size >= 128) throw new Error('too many tile/attribute pairs'); const t = map.size; map.set(key, t); rows.fill(st.attrs[i], 8 * t, 8 * t + 8); glyphs.set(this.glyphs.subarray(8 * cells[i], 8 * cells[i] + 8), 8 * (128 + t)); }
        cells[i] = 128 + map.get(key);
      }
      return picture({ ...st, cells, tileRows: rows, glyphs });
    }
    return picture(st);
  }
  /** The two-buffer picture of the state (cells, then sprites): { bitmap, attrs }. */
  bufferPic({ noSprites = false } = {}) {
    if (!noSprites) return this.m.render();
    return C.C3.Model.prototype.render.call(this.m, null);
  }
}

// ---- running ---------------------------------------------------------------------------------------------------------------------------------
const entryCache = new Map();
function entryFrame(dck) {
  const key = dck.length + ':' + dck.slice(0, 2048).join(',');
  if (entryCache.has(key)) return entryCache.get(key);
  const m = newMachine(dck);
  for (let f = 1; f <= 400; f++) { M.runFrame(m); if (rd16(m, S.HO_MARK) === 0x5AA5) { const F = f + bootSkip(m); entryCache.set(key, F); return F; } }
  throw new Error('the cartridge entry was not reached');
}
export const screenBits = (m) => m.ram.subarray(0x4000, 0x5800);
export const screenCols = (m) => m.ram.subarray(0x6000, 0x7800);
/** First difference between the screen and a fine picture, or null. */
export function finediff(m, pic) {
  const b = screenBits(m), c = screenCols(m);
  let n = 0, first = null;
  for (let i = 0; i < 6144; i++) if (b[i] !== pic.bits[i] || c[i] !== pic.colours[i]) { n++; if (!first) first = `$${(0x4000 + i).toString(16)}: bitmap ${hex(b[i], 2)} colour ${hex(c[i], 2)}, want ${hex(pic.bits[i], 2)} / ${hex(pic.colours[i], 2)}`; }
  return n ? `${n} groups, first ${first}` : null;
}
/** First difference between display file f and a two-buffer picture, or null. */
export function bufdiff(m, f, pic) {
  const base = 0x4000 + 0x2000 * f;
  let n = 0, first = null;
  for (let i = 0; i < 6144; i++) if (m.ram[base + i] !== pic.bitmap[i]) { n++; if (!first) first = `bitmap ${hex(base + i)}`; }
  for (let i = 0; i < 768; i++) if (m.ram[base + 0x1800 + i] !== pic.attrs[i]) { n++; if (!first) first = `attr ${i}`; }
  return n ? `file ${f + 1}: ${n} bytes, first ${first}` : null;
}

/**
 * Run `game` for `nframes` refreshes after the cartridge entry.  Checks (counted in the returned st): `pubBad` (screen after a publish against the
 * fine picture), `bufBad` (a two-buffer tick's file against the model), `onBad` / `offBad` (right after RT_FINEMODE), `fineFlag` (V_FINE against
 * the model), `opsBad`.  opts: { video, onWrite(m, addr, v, pc, armed), onStep(m, st) (every instruction, before it), onPublish(st, rec), poison(m) (at MAIN, after the boot) }.
 */
export function run(game, nframes, opts = {}) {
  const spec = game.spec;
  const F = entryFrame(game.dck);
  const m = newMachine(game.dck, { video: !!opts.video });
  for (let f = 1 + bootSkip(m); f < F; f++) M.runFrame(m);
  const model = new FineModel(spec);
  const G = GAME().syms;
  const cpu = m.cpu;
  const st = { m, model, refreshes: 0, ticks: 0, publishes: 0, pubBad: 0, bufBad: 0, onBad: 0, offBad: 0, fineFlag: 0, opsBad: 0, bad: [], ons: 0, offs: 0,
    fineTicks: 0, bufTicks: 0, pub: [], comp: [], recs: [], firstFine: null };
  const fail = (kind, msg) => { st[kind]++; if (st.bad.length < 6) st.bad.push(`${kind} (tick ${st.ticks}): ${msg}`); };
  let armed = false, cur = null, pubT = -1, compT = -1, initDone = false;
  if (opts.onWrite) {
    const orig = m.bus.write;
    m.bus.write = (addr, v) => { opts.onWrite(m, addr & 0xFFFF, v, cpu.pc, armed); orig(addr, v); };
  }
  let ffWrites = 0, ffAtOp = 0;
  st.listBad = 0; st.listGroups = 0; st.spLow = 0; st.noopBad = 0; st.ovfCalls = 0;
  const origOut = m.bus.ioWrite;
  m.bus.ioWrite = (port, v) => { if ((port & 0xFF) === 0xFF) ffWrites++; origOut(port, v); };
  const afterSwitch = (sw) => {
    if (sw === 'on') {
      st.ons++;
      const d = finediff(m, model.finePic({ noSprites: true }));
      if (d || m.portFF !== 2 || rd8(m, S.V_SHADOW_FF) !== 2) fail('onBad', d ?? `port $FF ${m.portFF}, shadow ${rd8(m, S.V_SHADOW_FF)}`);
    } else if (sw === 'off') {
      st.offs++;
      const p = model.bufferPic({ noSprites: true });
      const d = bufdiff(m, 0, p) ?? bufdiff(m, 1, p);
      if (d || m.portFF !== 0 || rd8(m, S.V_SHADOW_FF) !== 0 || rd8(m, S.V_HIDDEN) !== 1 || rd8(m, S.V_HOFF) !== 0x20) fail('offBad', d ?? `port $FF ${m.portFF}`);
    }
  };
  const hook = () => {
    const pc = cpu.pc;
    if (pc === S.MAIN && !armed) { armed = true; opts.poison?.(m); }
    if (!armed) return;
    opts.onStep?.(m, st);
    if (!initDone && (pc === S.TICK_LOOP || pc === S.FINE_RES_INIT)) {
      initDone = true;
      if (spec.initMode !== undefined && spec.initMode !== 0xFF) {
        afterSwitch(model.apply({ op: 'mode', a: spec.initMode }));
        for (const o of spec.initOps ?? []) model.apply(o);          // (shows / hides only: the picture ON built stays the cell map's)
      }
    }
    if (pc === S.WORK_START || pc === S.FINE_WORK) {
      const n = rd16(m, S.V_TICKS);
      cur = { n, ops: game.ops(n), k: 0, started: false, fine: pc === S.FINE_WORK };
      if (rd8(m, S.V_FINE) !== (model.fine ? 1 : 0)) fail('fineFlag', `V_FINE ${rd8(m, S.V_FINE)} at the tick's start`);
      if (pc === S.FINE_WORK) { pubT = m.tstates; st.curPubStart = m.tstates; }
    }
    if (pc === S.FINE_FRAME && pubT >= 0) {
      const rec = { start: pubT, end: m.tstates, frameStart: m.frameStart, pic: model.finePic(), sprites: model.state().sprites, ovf: rd16(m, S.F_NOVF) };
      st.pub.push(m.tstates - pubT); pubT = -1; st.publishes++; st.fineTicks++;
      if (!st.firstFine) st.firstFine = st.publishes;
      const d = finediff(m, rec.pic);
      if (d || m.portFF !== 2) fail('pubBad', d ?? `port $FF ${m.portFF}`);
      opts.onPublish?.(st, rec);
      if (opts.keepRecs) st.recs.push(rec);
    }
    if (pc === S.fine_compose) compT = m.tstates;
    if (pc === S.fine_wait && compT >= 0) { st.comp.push(m.tstates - compT); compT = -1; }
    if (cur && pc === G['frame_entry.loop']) {
      if (cur.started) {
        const o = cur.ops[cur.k++], sw = model.apply(o);
        if (o.op === 'mode' && !sw && ffWrites !== ffAtOp) fail('noopBad', `RT_FINEMODE ${o.a} changed nothing but wrote port $FF`);
        afterSwitch(sw);
      }
      cur.started = true;
      ffAtOp = ffWrites;
    }
    if (pc >= S.M_FINE_S && pc < S.M_FINE_E && cpu.sp < K.F_LLOW && cpu.sp > 0xE000) { if (!st.spLow) fail('spLow', `SP ${hex(cpu.sp)} below the list area at ${hex(pc)}`); st.spLow++; }
    if (pc === S.fine_ovf) st.ovfCalls++;
    if (pc === S.FINE_WORK && !opts.noListCheck) {
      // every entry of the list differs from the screen (method BD: only the groups that change are published)
      let a = rd16(m, S.F_LIST), n = 0;
      for (; n < 4000; n++, a += 4) {
        const adr = rd16(m, a);
        if ((adr >> 8) === 0) break;
        if (m.ram[adr] === m.ram[a + 2] && m.ram[adr + 0x2000] === m.ram[a + 3]) { fail('listBad', `list entry ${hex(adr)} = the screen`); break; }
      }
      st.listGroups += n;
    }
    if (cur && pc === G['frame_entry.end']) { if (cur.k !== cur.ops.length) fail('opsBad', `${cur.k} of ${cur.ops.length} ops`); }
    if (pc === S.fine_after || pc === S.SKIP_CALL) { if (cur) { st.ticks++; } cur = null; }
    if (pc === S.TICK_REQUEST) {
      st.bufTicks++;
      const h = rd8(m, S.V_HIDDEN);
      const d = bufdiff(m, h, model.bufferPic());
      if (d) fail('bufBad', d);
    }
  };
  for (let f = 0; st.refreshes < nframes && f < nframes + 400; f++) {
    const end = m.frameStart + FRAME_T;
    while (m.tstates < end) { if (cpu.halted) break; hook(); Z.runZ80(cpu, m.bus, 1, m); }
    M.runFrame(m);
    if (armed) st.refreshes++;
    opts.onFrame?.(m, st);
  }
  return st;
}

// ---- scenes ----------------------------------------------------------------------------------------------------------------------------------
/** A random asset set of at most `maxSlots` phases in all (8x8 / 16x16 mostly, some other heights; 1/2/4/8 phases). */
export function randomAssets(R, n, maxSlots = 32) {
  const out = [];
  let slots = 0;
  for (let i = 0; i < n; i++) {
    const w = R.chance(0.5) ? 16 : 8;
    const h = R.chance(0.7) ? w : R.int(1, 16);
    let phases = R.pick([1, 2, 4, 8]);
    while (slots + phases > maxSlots && phases > 1) phases >>= 1;
    if (slots + phases > maxSlots) break;
    slots += phases;
    out.push({ ...randomAsset(R, w, h, phases), inks: randomInks(R) });
  }
  return out;
}

/**
 * Ticks of a random scene.  opts: { n (instances), L (ticks), modes: probability of a FINEMODE op per tick, text, tiles (count), fills, edges, hide,
 * play (effect index to replay every tick), jump }.
 */
export function randomTicks(R, { n, L, modes = 0.06, text = 0.3, tiles = 0, tileRate = 0.4, fills = 0.04, edges = 0.15, hide = 0.06, play = -1, jump = 0.06, speed = 6 }) {
  const pos = Array.from({ length: n }, () => ({ x: R.int(0, 239), y: R.int(0, 176), vis: false }));
  const edge = () => R.pick([[0, R.int(0, 176)], [239, R.int(0, 176)], [R.int(0, 239), 0], [R.int(0, 239), 176], [0, 0], [239, 176], [R.int(-40, -1), R.int(0, 200)], [R.int(240, 300), R.int(-30, 200)]]);
  const ticks = [];
  for (let k = 0; k < L; k++) {
    const t = [];
    const mode = () => t.push({ op: 'mode', a: R.chance(0.5) ? 0 : R.pick([1, 2, 255]) });
    if (R.chance(modes)) mode();
    pos.forEach((p, i) => {
      if (p.vis && R.chance(hide)) { t.push({ op: 'hide', i }); p.vis = false; return; }
      if (!p.vis && !R.chance(0.6)) return;
      if (R.chance(edges)) { const [x, y] = edge(); p.x = x; p.y = y; }
      else if (R.chance(jump)) { p.x = R.int(0, 239); p.y = R.int(0, 176); }
      else { p.x = Math.max(0, Math.min(239, p.x + R.int(-speed, speed))); p.y = Math.max(0, Math.min(176, p.y + R.int(-speed, speed))); }
      p.vis = true;
      t.push({ op: 'show', i, x: p.x, y: p.y });
    });
    if (R.chance(text)) {
      t.push({ op: 'at', row: R.int(0, 23), col: R.int(0, 31) });
      if (R.chance(0.5)) t.push({ op: R.pick(['ink', 'paper', 'bright']), a: R.int(0, 7) });
      t.push({ op: 'prints', s: Array.from({ length: R.int(1, 8) }, () => R.int(32, 126)) });
    }
    if (tiles) for (let j = 0; j < 4; j++) if (R.chance(tileRate)) t.push({ op: 'tile', t: R.int(0, tiles - 1), row: R.int(0, 23), col: R.int(0, 31) });
    if (R.chance(fills)) t.push(R.chance(0.5) ? { op: 'fill', x: R.int(-3, 30), y: R.int(-3, 22), w: R.int(1, 12), h: R.int(1, 8), t: R.int(0, Math.max(0, tiles - 1)) }
      : { op: 'fillc', x: R.int(-3, 30), y: R.int(-3, 22), w: R.int(1, 12), h: R.int(1, 8), c: R.int(32, 126) });
    if (R.chance(modes)) mode();
    if (play >= 0) t.push({ op: 'play', i: play });
    ticks.push(t);
  }
  return ticks;
}

/** The addresses of the instructions of fine.asm (from the build's listing; data lines left out). */
export function fineInstructions() {
  const out = new Set();
  const lst = readFileSync(join(C.runtime() && OUT_DIR, 'runtime.lst'), 'utf8');
  for (const line of lst.split('\n')) {
    const m = line.match(/^\s*\d+\+*\s+([0-9A-F]{4})\s+((?:[0-9A-F]{2}\s?)+)\s+(\S+)/);
    if (!m) continue;
    const a = parseInt(m[1], 16);
    if (a < S.M_FINE_S || a >= S.M_FINE_E || /^(DB|DW|DEFB|DEFW)$/i.test(m[3])) continue;
    out.add(a);
  }
  return out;
}
/** The label (nearest at or below) of an address in fine.asm. */
export function fineLabel(a) {
  let best = null;
  for (const [k, v] of Object.entries(S)) if (v <= a && v >= S.M_FINE_S && v < S.M_FINE_E && !k.startsWith('M_') && (!best || v > best[1])) best = [k, v];
  return best ? `${best[0]}+${a - best[1]}` : hex(a);
}
