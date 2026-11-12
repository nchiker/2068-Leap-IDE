"use strict";
// m5-common.mjs -- shared helpers of the M5 runtime tests (m5-runtime*.mjs): language batch 1, the tile operations RT_FILL / RT_FILLC / RT_COPY /
// RT_LOADMAP* / RT_BORDER / RT_RANDOMISE (docs/ARCADE_RUNTIME_API_V2.md "As built: language batch 1", docs/ARCADE_LANGUAGE_BATCH1.md).
//  * the test game test_ops.asm (the M4 script game with an 18-byte header, a map table and the ops 21..29) and its linker, `opsGame()`;
//  * the JS MODEL of the new routines (`Model5`), written from the contract, NOT from the Z80 source: cells are changed exactly where the contract says and
//    the model records which cells changed (= which cells the runtime must mark dirty);
//  * `park()`/`callOp()`: a booted machine parked in the main loop, and direct calls of the routines with the argument block filled in.
import { join } from 'node:path';
import { assembleGame, linkGame, dckOf, RUNTIME_DIR } from '../tools/build-runtime-v2.mjs';
import * as C4 from './m4-common.mjs';

export const C = C4;
export const { M, Z, FRAME_T, hex, int16, makeChecks, rd8, rd16, newMachine, bootMachine, BG_ATTR } = C4;
export const rt = () => C4.runtime();

export const OPS = { SPRTAB: 0x8800, HOT: 0x8840, INST: 0x8860, SPRDATA: 0x8960, TILESET: 0x8B60, SFXTAB: 0x9300, SFXDATA: 0x9340, MAPTAB: 0x9800,
  MAPS: 0x9890, BASE: 0xA000, END: 0xC000, LOGBUF: 0xE200, LOGN: 0xE102 };
let _asm = null;
const opsAsm = () => (_asm ??= assembleGame(join(RUNTIME_DIR, 'test_ops.asm'), { name: 'ops' }));
const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];

/** Script ops (plain objects; the M4 ones are in C.op). */
export const op = {
  ...C4.op,
  fill: (x, y, w, h, t) => ({ op: 'fill', x, y, w, h, t }),
  fillc: (x, y, w, h, c) => ({ op: 'fillc', x, y, w, h, c }),
  copy: (x, y, w, h, dx, dy) => ({ op: 'copy', x, y, w, h, dx, dy }),
  loadmap: (i) => ({ op: 'loadmap', i }),
  loadmapat: (i, x, y) => ({ op: 'loadmapat', i, x, y }),
  loadmapptr: (addr, x, y) => ({ op: 'loadmapptr', addr, x, y }),
  border: (c) => ({ op: 'border', c }),
  randomise: (seed) => ({ op: 'randomise', seed }),
  rnd: () => ({ op: 'rnd' }),
};
function encodeOp(o) {
  switch (o.op) {
    case 'fill': return [21, ...w16(o.x), ...w16(o.y), ...w16(o.w), ...w16(o.h), ...w16(o.t)];
    case 'fillc': return [22, ...w16(o.x), ...w16(o.y), ...w16(o.w), ...w16(o.h), ...w16(o.c)];
    case 'copy': return [23, ...w16(o.x), ...w16(o.y), ...w16(o.w), ...w16(o.h), ...w16(o.dx), ...w16(o.dy)];
    case 'loadmap': return [24, o.i];
    case 'loadmapat': return [25, o.i, ...w16(o.x), ...w16(o.y)];
    case 'border': return [26, o.c];
    case 'randomise': return [27, ...w16(o.seed)];
    case 'rnd': return [28];
    case 'loadmapptr': return [29, ...w16(o.addr), ...w16(o.x), ...w16(o.y)];
    default: return null;
  }
}
export function encodeScript(ticks) {
  const out = [];
  for (const t of ticks) {
    for (const o of t) {
      const b = encodeOp(o);
      if (b) out.push(...b);
      else out.push(...C4.encodeScript([[o]]).slice(0, -1));       // an M4 op
    }
    out.push(0);
  }
  if (out.length > OPS.END - OPS.BASE) throw new Error('script too long: ' + out.length);
  return out;
}

/**
 * Link the ops game.  spec: as C.scriptGame (div, assets, insts, tiles, sfx, script) plus maps: [{ w, h, cells }] (the map table; `mapCount` overrides
 * the count byte, `mapPtrs` the pointers), `ext: false` writes a plain 16-byte header (frame_div without bit 7: no map table), `rawMap` (768 cells for
 * the old map_ptr).  Returns { img, dck, syms, gsyms, spec, mapAddr: [addresses of the maps] }.
 */
export function opsGame(spec = {}) {
  const rt_ = rt(), g = opsAsm();
  const img = linkGame(rt_.img, g.bytes);
  const put = (a, bytes) => { img.set(bytes, a); };
  const assets = spec.assets ?? [], insts = spec.insts ?? [];
  const ext = spec.ext !== false;
  img[0x8004] = (spec.div ?? 1) | (ext ? 0x80 : 0);
  img[0x8005] = spec.nassetsHeader ?? assets.length;
  let dataAt = OPS.SPRDATA;
  assets.forEach((a, i) => {
    const bytes = C4.assetBytes(a);
    put(dataAt, bytes);
    let hotPtr = 0;
    if (a.hot) { hotPtr = OPS.HOT + 4 * i; put(hotPtr, a.hot); }
    put(OPS.SPRTAB + 8 * i, [a.w, a.h, ...w16(dataAt), ...w16(hotPtr), a.phases, 0]);
    dataAt += bytes.length;
  });
  put(OPS.INST, [spec.ninstHeader ?? insts.length, ...insts]);
  let tilesetPtr = 0, sfxPtr = 0;
  if (spec.tiles) {
    tilesetPtr = OPS.TILESET;
    const bytes = [spec.tilesetCount ?? spec.tiles.length];
    for (const t of spec.tiles) bytes.push(...t.bmp, t.attr);
    put(tilesetPtr, bytes);
  }
  if (spec.sfx) {
    sfxPtr = OPS.SFXTAB;
    const tab = [spec.sfxCount ?? spec.sfx.length];
    let at = OPS.SFXDATA;
    spec.sfx.forEach((recs) => { tab.push(...w16(at)); const bytes = recs.flatMap((r) => r).concat([0, 0xFF, 0, 0]); put(at, bytes); at += bytes.length; });
    put(sfxPtr, tab);
  }
  const mapAddr = [];
  if (spec.maps) {
    let at = OPS.MAPS;
    const tab = [spec.mapCount ?? spec.maps.length];
    spec.maps.forEach((mp) => {
      const bytes = [mp.w, mp.h, ...mp.cells];
      if (at + bytes.length > OPS.BASE) throw new Error('maps do not fit');
      put(at, bytes); mapAddr.push(at); tab.push(...w16(mp.zeroPtr ? 0 : at)); at += bytes.length;
    });
    if (spec.mapPtrs) { tab.length = 1; tab.push(...spec.mapPtrs.flatMap(w16)); }
    put(OPS.MAPTAB, tab);
  }
  put(0x8006, w16(OPS.SPRTAB));
  put(0x8008, [...w16(tilesetPtr), ...w16(sfxPtr), ...w16(spec.rawMap ? 0x9000 : 0), ...w16(OPS.INST)]);
  if (spec.rawMap) put(0x9000, spec.rawMap);
  if (ext) put(0x8010, w16(spec.noMapTab ? 0 : OPS.MAPTAB));
  img.fill(0, OPS.BASE, OPS.END);
  if (spec.script) put(OPS.BASE, encodeScript(spec.script));
  for (const [a, v] of Object.entries(spec.header ?? {})) img[Number(a)] = v;
  return { img, dck: dckOf(img), syms: rt_.syms, gsyms: g.syms, spec, mapAddr, bytes: img.slice(0x8000, 0x8000 + g.bytes.length) };
}

// ---- the model ---------------------------------------------------------------------------------------------------------
const SEED_INIT = 0xACE1;
/** The v2 model plus the new operations.  Every operation records the cell indices whose byte or attribute changed in `this.changed` (a Set). */
export class Model5 extends C4.Model2 {
  constructor(spec = {}) {
    super({ ...spec, map: null });
    this.maps = (spec.maps ?? []).slice(0, Math.min(spec.mapCount ?? (spec.maps ?? []).length, 64)).map((m) => ({ w: m.w, h: m.h, cells: m.cells, zero: !!m.zeroPtr }));
    this.noTable = spec.ext === false || spec.noMapTab;
    if (this.noTable) this.maps = [];
    this.seed = SEED_INIT;
    this.border = 1;
    this.changed = new Set();
    if (spec.noBoot) { /* the blank screen of the first refreshes */ }
    else if (this.maps.length && !this.maps[0].zero) this.loadRecord(this.maps[0], 0, 0);
    else if (spec.rawMap) {
      this.tile.set(spec.rawMap);
      for (let i = 0; i < 768; i++) this.attr[i] = this.tile[i] & 0x80 ? this.tileAttr[this.tile[i] & 0x7F] : BG_ATTR;
    }
    this.changed = new Set();
  }
  clone() { const m = super.clone(); m.maps = this.maps; m.changed = new Set(); return m; }
  set(idx, v, a) {
    if (this.tile[idx] !== v || this.attr[idx] !== a) this.changed.add(idx);
    this.tile[idx] = v; this.attr[idx] = a;
  }
  /** FILL / FILLC: the cells of the rectangle (true integer arithmetic, no wrap) that are on screen. */
  fill(x, y, w, h, v, a) {
    for (let cy = 0; cy < 24; cy++) for (let cx = 0; cx < 32; cx++) {
      const i = cx - x, j = cy - y;
      if (i >= 0 && i < w && j >= 0 && j < h) this.set(cy * 32 + cx, v, a);
    }
  }
  /** COPY: cell (i, j) of the w x h rectangle goes from (x+i, y+j) to (dx+i, dy+j) when both are on screen; every read comes before any write. */
  copy(x, y, w, h, dx, dy) {
    const t0 = this.tile.slice(), a0 = this.attr.slice();
    for (let ty = 0; ty < 24; ty++) for (let tx = 0; tx < 32; tx++) {
      const i = tx - dx, j = ty - dy;
      if (i < 0 || i >= w || j < 0 || j >= h) continue;
      const sx = x + i, sy = y + j;
      if (sx >= 0 && sx < 32 && sy >= 0 && sy < 24) this.set(ty * 32 + tx, t0[sy * 32 + sx], a0[sy * 32 + sx]);
    }
  }
  loadRecord(m, x, y) {
    for (let j = 0; j < m.h; j++) for (let i = 0; i < m.w; i++) {
      const cx = x + i, cy = y + j;
      if (cx < 0 || cx >= 32 || cy < 0 || cy >= 24) continue;
      const c = m.cells[j * m.w + i];
      this.set(cy * 32 + cx, c, c & 0x80 ? this.tileAttr[c & 0x7F] : BG_ATTR);
    }
  }
  rndStep() {
    let x = this.seed || 1;
    x ^= (x << 7) & 0xFFFF; x ^= x >> 9; x ^= (x << 8) & 0xFFFF;
    this.seed = x & 0xFFFF;
    return x & 0x7FFF;
  }
  apply(o) {
    switch (o.op) {
      case 'fill': this.fill(int16(o.x), int16(o.y), int16(o.w), int16(o.h), 0x80 | (o.t & 0x7F), this.tileAttr[o.t & 0x7F]); break;
      case 'fillc': this.fill(int16(o.x), int16(o.y), int16(o.w), int16(o.h), o.c & 0x7F, this.textAttr); break;
      case 'copy': this.copy(int16(o.x), int16(o.y), int16(o.w), int16(o.h), int16(o.dx), int16(o.dy)); break;
      case 'loadmap': case 'loadmapat': {
        const m = this.maps[o.i];
        if (m && !m.zero) this.loadRecord(m, o.op === 'loadmap' ? 0 : int16(o.x), o.op === 'loadmap' ? 0 : int16(o.y));
        break;
      }
      case 'loadmapptr': this.loadRecord(o.rec, int16(o.x), int16(o.y)); break;
      case 'border': this.border = o.c & 7; break;
      case 'randomise': this.seed = (o.seed & 0xFFFF) || 1; break;
      case 'rnd': this.log.push(this.rndStep()); break;
      case 'cls': super.apply(o); break;
      default: super.apply(o);
    }
  }
}

// ---- machines ----------------------------------------------------------------------------------------------------------------
/** Boot `game`, run a few refreshes and park the CPU at the tick loop's wait (no tick in progress), like m4-runtime-api's park(). */
export function park(game, frames = 6) {
  const S = game.syms;
  const m = C4.newMachine(game.dck);
  C4.bootMachine(m, S);
  for (let f = 0; f < frames; f++) M.runFrame(m);
  for (let i = 0; i < 400000 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);
  return m;
}
/** Call a routine without advancing the machine's clock. */
export const call = (m, addr, regs) => { const t0 = m.tstates; const r = C4.callRoutine(m, addr, regs); m.tstates = t0; return r; };
const wr16 = (m, a, v) => { m.ram[a] = v & 0xFF; m.ram[a + 1] = (v >> 8) & 0xFF; };
/** Fill the argument block (signed words as given; truncated to 16 bits). */
export function setArgs(m, S, args) {
  args.forEach((v, k) => wr16(m, S.RT_ARGS + 2 * k, v & 0xFFFF));
}
export const cellsOf = (m, S) => ({ tile: Uint8Array.from(m.ram.subarray(S.CELL_TILE, S.CELL_TILE + 768)), attr: Uint8Array.from(m.ram.subarray(S.CELL_ATTR, S.CELL_ATTR + 768)) });
/** The set of cells marked dirty in a dirty map (file 0 or 1) as a sorted array. */
export function dirtyCells(m, base) {
  const out = [];
  for (let i = 0; i < 96; i++) for (let b = 0; b < 8; b++) if (m.ram[base + i] & (1 << b)) out.push(8 * i + b);
  return out;
}
export function clearDirty(m, S) { m.ram.fill(0, S.DIRTY0, S.DIRTY0 + 96); m.ram.fill(0, S.DIRTY1, S.DIRTY1 + 96); }
/** Write a cell state (tile bytes + attributes) into the machine's cell map. */
export function setCells(m, S, tile, attr) { m.ram.set(tile, S.CELL_TILE); m.ram.set(attr, S.CELL_ATTR); }

// ---- observing a run (a trimmed copy of m4-common's observe(), with the M5 model) ------------------------------------------------
/**
 * Run `game` on a stock TS2068 one instruction at a time from the cartridge entry for `nframes` refreshes after boot and compare the picture shown after
 * every refresh with Model5 advanced tick by tick through `script` (the same script the game runs).  `hooks(pc, ctx)` is called before every instruction.
 * Returns { m, frames, pictureOk, pictureBad, firstBad, pixelBad, flipMismatch, missed, skippedFlips, writeViolations, work: [T per tick], ticks, gameLog, modelLog,
 * canary, finalTicks, model, spMin, spMax, dirtyAtRequest }.
 */
export function observe5(game, nframes, { script = null, hooks = null, pixels = true, keyMatrix = null, picEvery = 1 } = {}) {
  const S = game.syms;
  const m = C4.newMachine(game.dck);
  let entryFrame = -1;
  for (let f = 1; f <= 400; f++) { M.runFrame(m); if (rd16(m, S.HO_MARK) === 0x5AA5) { entryFrame = f; break; } }
  const model = new Model5(game.spec);
  const st = { m, entryFrame, frames: 0, pictureOk: 0, pictureBad: 0, pixelBad: 0, firstBad: null, flipMismatch: 0, missed: 0, skippedFlips: 0, writeViolations: 0,
    work: [], snapshots: [null, null], spMin: 0xFFFF, spMax: 0, ticksSeen: [], model, shadowBad: 0 };
  let armed = false, inIsr = false, isrSync = 0, workT0 = -1, workIsr0 = 0, isrT0 = 0, isrAcc = 0;
  const origWrite = m.bus.write;
  m.bus.write = (addr, v) => {
    const a = addr & 0xFFFF, base = (m.portFF & 1) ? 0x6000 : 0x4000;
    if (armed && a >= base && a < base + 0x1B00) st.writeViolations++;
    origWrite(addr, v);
  };
  function hook() {
    const cpu = m.cpu, pc = cpu.pc, sp = cpu.sp;
    if (pc === S.MAIN) armed = true;
    if (armed) { if (sp < st.spMin) st.spMin = sp; if (sp > st.spMax) st.spMax = sp; }
    const inRange = pc >= S.ISR && pc < S.ISR_END || (pc >= S.SND_S && pc < S.SND_E) || (inIsr && pc >= S.SND_XS && pc < S.SND_E);   // (the tick calls SND_SYNC / SND_OWNCLR below SND_S: music)
    if (inRange) { if (!inIsr) { inIsr = true; isrT0 = m.tstates - 13; isrSync = rd8(m, S.V_SYNC); } }
    else if (inIsr) { inIsr = false; isrAcc += m.tstates - isrT0; }
    if (pc === S.WORK_START) { workT0 = m.tstates; workIsr0 = isrAcc; }
    if (pc === S.TICK_REQUEST && workT0 >= 0) {
      const n = rd16(m, S.V_TICKS) - 1, hidden = rd8(m, S.V_HIDDEN);
      st.ticksSeen.push(n);
      if (script) { for (const o of script[n] ?? []) model.apply(o); st.snapshots[hidden] = { n, model: model.clone() }; }
    }
    if (pc === S.WORK_END && workT0 >= 0) { st.work.push(m.tstates - workT0 - (isrAcc - workIsr0)); workT0 = -1; }
    if (hooks) hooks(pc, { m, st, inIsr });
  }
  if (keyMatrix) m.keyMatrix.set(keyMatrix);
  let prevFrames = rd16(m, S.V_FRAMES), prevBit = m.portFF & 1;
  for (let f = 0; st.frames < nframes && f < nframes + 200; f++) {
    const end = m.frameStart + FRAME_T;
    while (m.tstates < end) { if (m.cpu.halted) break; hook(); Z.runZ80(m.cpu, m.bus, 1, m); }
    M.runFrame(m);
    const fr = rd16(m, S.V_FRAMES);
    if (fr === 0 || prevFrames === 0) { prevFrames = fr; prevBit = m.portFF & 1; continue; }
    if (((fr - prevFrames) & 0xFFFF) !== 1) st.missed++;
    prevFrames = fr;
    const bit = m.portFF & 1, flipped = bit !== prevBit;
    if ((isrSync >= 2) !== flipped) st.flipMismatch++;
    if (isrSync === 0) st.skippedFlips++;
    if (m.portFF !== rd8(m, S.V_SHADOW_FF)) st.shadowBad++;
    prevBit = bit;
    st.frames++;
    if (st.frames % picEvery === 0) {
      const snap = st.snapshots[bit];
      const base = snap ? snap.model : new Model5({ ...game.spec, script: null, noBoot: true });
      const exp = base.render(), got = C4.dfileOf(m, bit);
      const bad = C4.diffCount(exp.bitmap, got.bitmap) + C4.diffCount(exp.attrs, got.attrs);
      if (pixels) { const sc = C4.shownColours(m), ec = C4.colourPlane(exp); if (sc === null || C4.diffCount(ec, sc) !== 0) st.pixelBad++; }
      if (bad === 0) st.pictureOk++;
      else { st.pictureBad++; st.firstBad ??= { frame: st.frames, bad, tick: snap?.n, file: bit + 1 }; }
    }
  }
  const logN = rd16(m, OPS.LOGN);
  st.gameLog = []; for (let i = 0; i < logN; i++) st.gameLog.push(rd16(m, OPS.LOGBUF + 2 * i));
  st.modelLog = model.log;
  st.canary = rd16(m, S.STACK_CANARY);
  st.finalTicks = rd16(m, S.V_TICKS);
  return st;
}

/** A random tick of tile operations (and a little else), for the frame-loop tests.  `kinds` limits the ops. */
export function randomTileOps(r, { maps = 0, tiles = 6, kinds = ['fill', 'fillc', 'copy', 'loadmap', 'tile', 'prints'], size = 'mixed' } = {}) {
  const ops = [];
  const n = r.int(1, 4);
  const co = () => r.chance(0.12) ? r.int(-40, 70) : r.int(-3, 33);
  const sz = () => (size === 'small' ? r.int(0, 8) : r.chance(0.2) ? r.int(20, 40) : r.int(0, 14));
  for (let k = 0; k < n; k++) {
    const kind = r.pick(kinds);
    if (kind === 'fill') ops.push(op.fill(co(), co(), sz(), sz(), r.chance(0.9) ? r.int(0, tiles + 1) : r.int(0, 300)));
    else if (kind === 'fillc') ops.push(op.fillc(co(), co(), sz(), sz(), r.chance(0.9) ? r.int(32, 127) : r.int(0, 255)));
    else if (kind === 'copy') { const x = co(), y = co(); ops.push(op.copy(x, y, sz(), sz(), x + r.int(-4, 4), y + r.int(-3, 3))); }
    else if (kind === 'loadmap' && maps) ops.push(r.chance(0.5) ? op.loadmap(r.int(0, maps)) : op.loadmapat(r.int(0, maps), co(), co()));
    else if (kind === 'tile') ops.push(op.tile(r.int(0, tiles), r.int(0, 23), r.int(0, 31)));
    else if (kind === 'prints') { ops.push(op.ink(r.int(0, 7)), op.paper(r.int(0, 7)), op.at(r.int(0, 23), r.int(0, 20)), op.prints('ab' + r.int(0, 99))); }
  }
  return ops;
}
