"use strict";
// m6-common.mjs -- shared helpers of the runtime v3 part 1 tests (m6-runtime*.mjs): building the v3 runtime and the script-driven test game
// (arcade/runtime/v3/test_script.asm), and the JavaScript MODEL of v3's sprites written from docs/ARCADE_PLATFORMER_CONTRACT.md (sections 1, 2, 3b)
// and docs/ARCADE_RUNTIME_API_V3.md, NOT from the Z80 sources:
//   * assets v3 (w 8/16/24/32, h 1..48, nframes 1..32, phases 8/4/2/1), their game-image bytes and the descriptor clamps;
//   * `preShift(asset, frame, s)`: an independent pre-shift (pixel by pixel into a window one byte wider);
//   * `planPool()`: the phase-pool plan the boot makes (and the linker must make): FTABs, frame slots, first fit over the three pieces;
//   * `Model6`: the cell map (M3 model) + instances with frames; `render()` composites the pre-shifted bytes onto the display-file bytes;
//   * `observe6()`: runs a game on a stock TS2068 (TSRun) one instruction at a time and compares the picture after every refresh with the model.
import { join } from 'node:path';
// ARCADE_V4=1 runs the same suites on runtime v4 in non-ray mode (arcade/tests/m8-runtime-v3compat.mjs): v4 must behave as v3 without a window.
const { buildRuntime, assembleGame, linkGame, dckOf, RUNTIME_DIR } = await import(process.env.ARCADE_V4 ? '../tools/build-runtime-v4.mjs' : '../tools/build-runtime-v3.mjs');
export const RUNTIME_VERSION = process.env.ARCADE_V4 ? 4 : 3;
import * as C3 from './m3-common.mjs';

export const { M, Z, FRAME_T, FIRST_PIXEL_T, SCR_X0, SCR_Y0, FRAME_W, hex, int16, makeChecks, rd8, rd16, newMachine, bootMachine, callRoutine,
  FONT, fontGlyph, ZERO8, rowAddr, BG_ATTR, clamp, colourPlane, shownColours, dfileOf, diffCount, glyphOfValue, avg } = C3;
export { C3 };

let _rt = null;
/** Build the v3 runtime once per process. */
export function runtime() { return (_rt ??= buildRuntime()); }

// ---- the test game: test_script.asm (v3) + data written by the test ------------------------------------------------------------
export const SCRIPT = { SPRTAB: 0x8800, HOT: 0x8840, INST: 0x8860, TILESET: 0x8880, SFXTAB: 0x8D10, SFXDATA: 0x8D40, MAP: 0x9000, ART: 0x9300, END: 0xC000, PTR: 0x8014 };
let _asm = null;
function scriptAsm() { return (_asm ??= assembleGame(join(RUNTIME_DIR, 'test_script.asm'), { name: 'script3' })); }
export const logAddrs = (S) => ({ LOGN: S.GAME_VARS_BASE + 2, LOGBUF: S.GAME_VARS_BASE + 0x100 });

const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
export const op = {
  ...C3.op,
  showf: (i, x, y, f) => ({ op: 'showf', i, x, y, f }),
  keydown: (c) => ({ op: 'keydown', c }),
  deep: (n) => ({ op: 'deep', n }),
};
function encodeOp(o) {
  switch (o.op) {
    case 'show': return o.x >= 0 && o.x < 256 && o.y >= 0 && o.y < 256 ? [19, o.i, o.x, o.y] : [1, o.i, ...w16(o.x), ...w16(o.y)];
    case 'showf': return o.x >= 0 && o.x < 256 && o.y >= 0 && o.y < 256 && o.f >= 0 && o.f < 256 ? [22, o.i, o.x, o.y, o.f] : [21, o.i, ...w16(o.x), ...w16(o.y), ...w16(o.f)];
    case 'hide': return [2, o.i];
    case 'at': return [3, o.row, o.col];
    case 'prints': { const codes = typeof o.s === 'string' ? [...o.s].map((c) => c.charCodeAt(0)) : o.s; return [4, codes.length, ...codes]; }
    case 'printn': return [5, ...w16(o.v)];
    case 'printc': return [6, o.c];
    case 'ink': return [7, o.a];
    case 'paper': return [8, o.a];
    case 'bright': return [9, o.a];
    case 'cls': return [10];
    case 'tile': return [11, o.t, o.row, o.col];
    case 'play': return [12, o.i];
    case 'silence': return [13];
    case 'hit': return [14, o.a, o.b];
    case 'tileat': return [15, o.row, o.col];
    case 'burn': return [16];
    case 'stick': return [17, o.n];
    case 'keydown': return [18, o.c];
    case 'deep': return [20, ...w16(o.n)];
    default: throw new Error('unknown op ' + o.op);
  }
}
export function encodeScript(ticks) {
  const out = [];
  for (const t of ticks) { for (const o of t) out.push(...encodeOp(o)); out.push(0); }
  return out;
}

// ---- assets v3 -----------------------------------------------------------------------------------------------------------------
// An asset: { w, h, phases, nframes (raw header values), frames: [[{ m: [wb bytes], i: [wb bytes] }, ... rows], ...], hot }.
// The frame data is built for the NORMALISED w / h / nframes (what the runtime reads); the header values may be anything.
export const normW = (w) => (w <= 8 ? 8 : w <= 16 ? 16 : w <= 24 ? 24 : 32);
export const normH = (h) => (h < 1 ? 1 : h > 48 ? 48 : h);
export const normPhases = (p) => (p >= 8 ? 8 : p >= 4 ? 4 : p >= 2 ? 2 : 1);
export const normNF = (n) => (n < 1 ? 1 : n > 32 ? 32 : n);
/** A random asset: about 55 % of the pixels opaque (half of them ink), now and then an image bit under a kept background. */
export function randomAsset(r, w, h, phases, nframes = 1, { hot = null, opaque = 0.55 } = {}) {
  const wb = normW(w) / 8, frames = [];
  for (let f = 0; f < normNF(nframes); f++) {
    const rows = [];
    for (let k = 0; k < normH(h); k++) {
      const m = [], i = [];
      for (let b = 0; b < wb; b++) {
        let mb = 0, ib = 0;
        for (let bit = 0; bit < 8; bit++) {
          const cover = r.chance(opaque);
          mb = (mb << 1) | (cover ? 0 : 1);
          ib = (ib << 1) | (cover && r.chance(0.5) ? 1 : 0);
          if (!cover && r.chance(0.05)) ib |= 1;
        }
        m.push(mb); i.push(ib);
      }
      rows.push({ m, i });
    }
    frames.push(rows);
  }
  return { w, h, phases, nframes, frames, hot };
}
/** The game-image bytes of an asset: every frame, every row: wb mask bytes then wb image bytes. */
export function assetBytes(a) {
  const out = [];
  for (const rows of a.frames) for (const r of rows) out.push(...r.m, ...r.i);
  return out;
}
/** A v2-style asset ({ w 8/16, h <= 16, phases, rows: [{ mask, image }] } of m4-common) as a v3 asset with one frame and nframes 0. */
export function fromV2(a) {
  const wb = a.w > 8 ? 2 : 1;
  const rows = a.rows.map((r) => (wb === 2 ? { m: [r.mask >> 8, r.mask & 0xFF], i: [r.image >> 8, r.image & 0xFF] } : { m: [r.mask & 0xFF], i: [r.image & 0xFF] }));
  return { w: a.w, h: a.h, phases: a.phases, nframes: 0, frames: [rows], hot: a.hot };
}

/** The normalised view of an asset (what the runtime makes of the descriptor). */
export function normAsset(a) {
  const w = normW(a.w), h = normH(a.h), phases = normPhases(a.phases), nf = normNF(a.nframes), wb = w / 8;
  return { w, wb, h, phases, gran: 8 / phases, nf, frames: a.frames, hot: a.hot ?? [0, 0, w, h], clen: h * 2 * (wb + 1), slen: (phases - 1) * h * 2 * (wb + 1) };
}

/**
 * Independent pre-shift: frame f of asset `a` (normalised) at x shift s (0..7), as the bytes the blitter reads: for s > 0, h rows of wb + 1 (mask, image)
 * pairs; for s = 0, h rows of wb pairs (the window of an aligned sprite).  Pixel by pixel: window pixel p shows source pixel p - s, or (keep, no ink).
 */
export function preShift(a, f, s) {
  const n = s ? a.wb + 1 : a.wb, out = [];
  for (const row of a.frames[f]) {
    const keep = (p) => (p < 0 || p >= a.w ? 1 : (row.m[p >> 3] >> (7 - (p & 7))) & 1);
    const ink = (p) => (p < 0 || p >= a.w ? 0 : (row.i[p >> 3] >> (7 - (p & 7))) & 1);
    for (let b = 0; b < n; b++) {
      let mb = 0, ib = 0;
      for (let bit = 0; bit < 8; bit++) { const p = 8 * b + bit - s; mb = (mb << 1) | keep(p); ib = (ib << 1) | ink(p); }
      out.push(mb, ib);
    }
  }
  return out;
}

// ---- the phase-pool plan (layout.inc "THE PHASE POOL"; docs/ARCADE_RUNTIME_API_V3.md: the linker repeats it) -----------------------------
export const POOL_PIECES = (S) => [[S.POOL_A, S.POOL_A_LEN], [S.POOL_B, S.POOL_B_LEN], [S.POOL_C, S.POOL_C_LEN]];
/**
 * assets: normalised assets; ninst[a] = instances of asset a.  Returns { ok, miss (bytes of steps 1-2 that did not fit), ftab[a] (address or 0),
 * slots[a] (addresses; slot k starts as frame k's), K[a] }.
 */
export function planPool(assets, ninst, pieces) {
  const next = pieces.map(([a]) => a), end = pieces.map(([a, l]) => a + l);
  const alloc = (n) => { for (let p = 0; p < next.length; p++) if (next[p] + n <= end[p]) { const at = next[p]; next[p] += n; return at; } return -1; };
  const used = assets.map((_, a) => (ninst[a] ?? 0) > 0);
  const ftab = assets.map(() => 0), slots = assets.map(() => []);
  let miss = 0;
  assets.forEach((a, k) => { if (!used[k]) return; const at = alloc(4 * a.nf); if (at < 0) miss += 4 * a.nf; else ftab[k] = at; });
  assets.forEach((a, k) => {
    if (!used[k] || a.phases === 1) return;
    for (let j = 0; j < Math.min(a.nf, ninst[k]); j++) { const at = alloc(a.slen); if (at < 0) miss += a.slen; else slots[k].push(at); }
  });
  if (miss) return { ok: false, miss, ftab, slots, K: slots.map((s) => s.length) };
  assets.forEach((a, k) => {
    if (!used[k] || a.phases === 1) return;
    while (slots[k].length < a.nf) { const at = alloc(a.slen); if (at < 0) break; slots[k].push(at); }
  });
  return { ok: true, miss: 0, ftab, slots, K: slots.map((s) => s.length) };
}
/** Bytes the plan needs at least (steps 1-2), ignoring fragmentation: the linker's quick estimate. */
export function poolNeed(assets, ninst) {
  let n = 0;
  assets.forEach((a, k) => { if (!(ninst[k] > 0)) return; n += 4 * a.nf; if (a.phases > 1) n += Math.min(a.nf, ninst[k]) * a.slen; });
  return n;
}

/**
 * Link the script game.  spec: { div, assets (v3 assets), insts: [asset index per instance], tiles, sfx, map, script, nassetsHeader / ninstHeader,
 * spriteTable0 / instTable0, header: { addr: value }, noSkip, divBits (OR-ed into frame_div), winDesc (address for $8012) }.
 */
export function scriptGame(spec = {}) {
  const rt = runtime(), g = scriptAsm();
  const img = linkGame(rt.img, g.bytes);
  const put = (a, bytes) => { img.set(bytes, a); };
  const assets = spec.assets ?? [];
  const insts = spec.insts ?? [];
  img[0x8004] = (spec.div ?? 1) | (spec.divBits ?? 0);
  img[0x8005] = spec.nassetsHeader ?? assets.length;
  let dataAt = SCRIPT.ART;
  assets.forEach((a, i) => {
    const bytes = assetBytes(a);
    if (dataAt + bytes.length > SCRIPT.END) throw new Error('sprite art does not fit the test image');
    put(dataAt, bytes);
    let hotPtr = 0;
    if (a.hot) { hotPtr = SCRIPT.HOT + 4 * i; put(hotPtr, a.hot); }
    put(SCRIPT.SPRTAB + 8 * i, [a.w, a.h, ...w16(dataAt), ...w16(hotPtr), a.phases, a.nframes]);
    dataAt += bytes.length;
  });
  const ninstBytes = [spec.ninstHeader ?? insts.length, ...insts];
  put(SCRIPT.INST, ninstBytes.slice(0, 0x20));
  let tilesetPtr = 0, sfxPtr = 0, mapPtr = 0;
  if (spec.tiles) {
    tilesetPtr = SCRIPT.TILESET;
    const bytes = [spec.tilesetCount ?? spec.tiles.length];
    for (const t of spec.tiles) bytes.push(...t.bmp, t.attr);
    if (tilesetPtr + bytes.length > SCRIPT.SFXTAB) throw new Error('tileset too big for the test image');
    put(tilesetPtr, bytes);
  }
  if (spec.sfx) {
    sfxPtr = SCRIPT.SFXTAB;
    const tab = [spec.sfxCount ?? spec.sfx.length];
    let at = SCRIPT.SFXDATA;
    spec.sfx.forEach((recs) => { tab.push(...w16(at)); const bytes = recs.flatMap((r) => r).concat([0, 0xFF, 0, 0]); put(at, bytes); at += bytes.length; });
    if (at > SCRIPT.MAP) throw new Error('effects too big for the test image (704 bytes)');
    put(sfxPtr, tab);
  }
  if (spec.map) { mapPtr = SCRIPT.MAP; put(mapPtr, spec.map); }
  put(0x8006, w16(spec.spriteTable0 ? 0 : SCRIPT.SPRTAB));
  put(0x8008, [...w16(spec.tilesetPtr ?? tilesetPtr), ...w16(spec.sfxPtr ?? sfxPtr), ...w16(spec.mapPtr ?? mapPtr), ...w16(spec.instTable0 ? 0 : SCRIPT.INST)]);
  put(0x8010, [0, 0, ...w16(spec.winDesc ?? 0)]);
  const scriptAt = (dataAt + 15) & ~15;
  const sc = encodeScript(spec.script ?? []);
  if (scriptAt + sc.length + 1 > SCRIPT.END) throw new Error(`script too long: ${sc.length} bytes from ${hex(scriptAt)}`);
  img.fill(0, scriptAt, SCRIPT.END);                      // a script that has run out is a run of empty ticks (op 0)
  put(scriptAt, sc);
  put(SCRIPT.PTR, w16(scriptAt));
  for (const [a, v] of Object.entries(spec.header ?? {})) img[Number(a)] = v;
  if (spec.noSkip) img.fill(0, rt.syms.SKIP_CALL, rt.syms.SKIP_CALL + 3);
  return { img, dck: dckOf(img), syms: rt.syms, gsyms: g.syms, spec, scriptAt };
}

// ---- the model -----------------------------------------------------------------------------------------------------------------
/** What runtime v3 should hold (non-window mode): the M3 cell model plus assets with frames, instances with frames, the clamps per asset. */
export class Model6 extends C3.Model {
  constructor(spec = {}) {
    super({ ...spec, sprites: [] });
    const raw = spec.assets ?? [];
    const na = spec.spriteTable0 ? 0 : Math.min(spec.nassetsHeader ?? raw.length, 8);
    this.assets = raw.slice(0, na).map(normAsset);
    const ni = spec.instTable0 || this.assets.length === 0 ? 0 : Math.min(spec.ninstHeader ?? (spec.insts ?? []).length, 16);
    this.insts = Array.from({ length: ni }, (_, i) => ({ asset: Math.min((spec.insts ?? [])[i] ?? 0, this.assets.length - 1), visible: false, x: 0, y: 0, frame: 0 }));
    this._copies = new Map();
  }
  clone() {
    const m = Object.create(Object.getPrototypeOf(this));
    Object.assign(m, this);
    m.tile = this.tile.slice(); m.attr = this.attr.slice();
    m.insts = this.insts.map((s) => ({ ...s }));
    m.log = [];
    return m;
  }
  ninstOf() { const n = this.assets.map(() => 0); for (const s of this.insts) n[s.asset]++; return n; }
  box(i) {
    const s = this.insts[i];
    if (!s || !s.visible) return null;
    const [hx, hy, hw, hh] = this.assets[s.asset].hot;
    if (hw === 0 || hh === 0) return null;
    return { x0: s.x + hx, x1: s.x + hx + hw, y0: s.y + hy, y1: s.y + hy + hh };
  }
  show(i, x, y, f) {
    if (i < 0 || i >= this.insts.length) return;
    const s = this.insts[i], a = this.assets[s.asset];
    Object.assign(s, { visible: true, x: clamp(int16(x), 256 - a.w), y: clamp(int16(y), 192 - a.h) });
    if (f !== undefined) s.frame = f & 0xFF;
  }
  apply(o) {
    switch (o.op) {
      case 'show': this.show(o.i, o.x, o.y); break;
      case 'showf': this.show(o.i, o.x, o.y, o.f); break;
      case 'hide': if (o.i >= 0 && o.i < this.insts.length) this.insts[o.i].visible = false; break;
      default: super.apply(o);
    }
  }
  shifted(ai, f, s) {
    const k = `${ai}/${f}/${s}`;
    if (!this._copies.has(k)) this._copies.set(k, preShift(this.assets[ai], f, s));
    return this._copies.get(k);
  }
  /** The expected display file: cells first, then the visible instances in index order (the pre-shifted bytes: screen = (screen AND m) OR i). */
  render() {
    const { bitmap, attrs } = super.render(null);
    this.insts.forEach((s) => {
      if (!s.visible) return;
      const a = this.assets[s.asset], f = Math.min(s.frame, a.nf - 1), xd = s.x & ~(a.gran - 1), sh = xd & 7, n = sh ? a.wb + 1 : a.wb;
      const bytes = this.shifted(s.asset, f, sh);
      for (let r = 0; r < a.h; r++) for (let b = 0; b < n; b++) {
        const adr = rowAddr(s.y + r) + (xd >> 3) + b, m = bytes[2 * (r * n + b)], im = bytes[2 * (r * n + b) + 1];
        bitmap[adr] = (bitmap[adr] & m) | im;
      }
    });
    return { bitmap, attrs };
  }
  /** The same picture composited pixel by pixel from the source rows (a cross-check of preShift + render). */
  renderPixels() {
    const { bitmap, attrs } = super.render(null);
    this.insts.forEach((s) => {
      if (!s.visible) return;
      const a = this.assets[s.asset], f = Math.min(s.frame, a.nf - 1), xd = s.x & ~(a.gran - 1);
      a.frames[f].forEach((row, r) => {
        for (let p = 0; p < a.w; p++) {
          const keep = (row.m[p >> 3] >> (7 - (p & 7))) & 1, ink = (row.i[p >> 3] >> (7 - (p & 7))) & 1;
          const x = xd + p, adr = rowAddr(s.y + r) + (x >> 3), bit = 0x80 >> (x & 7);
          bitmap[adr] = ((keep ? bitmap[adr] : bitmap[adr] & ~bit) | (ink ? bit : 0)) & 0xFF;
        }
      });
    });
    return { bitmap, attrs };
  }
}

// ---- observing a run ---------------------------------------------------------------------------------------------------------
/**
 * Run `game` on a stock TS2068, one instruction at a time from the cartridge entry, `nframes` refreshes after boot, and compare the picture
 * after every refresh with the model (advanced tick by tick through the script).  Same as m4-common's observe() with the v3 model.
 */
export function observe6(game, nframes, { script = null, checkPicture = true, pixels = true, hooks = null, onTick = null, untilTicks = 0, ModelClass = Model6 } = {}) {
  const S = game.syms;
  const m = newMachine(game.dck);
  let entryFrame = -1;
  for (let f = 1; f <= 400; f++) { M.runFrame(m); if (rd16(m, S.HO_MARK) === 0x5AA5) { entryFrame = f; break; } }
  const model = new ModelClass(game.spec);
  const st = {
    m, entryFrame, frames: 0, ticks: [], work: [], eraseT: [], drawT: [], redrawT: [], writeViolations: 0, spMin: 0xFFFF, spMax: 0, pictureOk: 0, pictureBad: 0,
    pixelBad: 0, firstBad: null, snapshots: [null, null], flipMismatch: 0, missed: 0, skippedFlips: 0, imBad: 0, model, shadowBad: 0, flipWrites: [],
  };
  let armed = false, inIsr = false, isrT0 = 0, isrAcc = 0, isrSync = 0, workT0 = -1, workIsr0 = 0, tickStart = null;
  let ffWrites = [];
  const origOut = m.bus.ioWrite;
  m.bus.ioWrite = (port, v) => { if ((port & 0xFF) === 0xFF) ffWrites.push({ rel: m.tstates - m.frameStart, v }); origOut(port, v); };
  const origWrite = m.bus.write;
  m.bus.write = (addr, v) => {
    const a = addr & 0xFFFF, base = (m.portFF & 1) ? 0x6000 : 0x4000;
    if (armed && a >= base && a < base + 0x1B00) st.writeViolations++;
    origWrite(addr, v);
  };
  const trackers = [[S.erase_all, 'erase'], [S.redraw_dirty, 'redraw'], [S.draw_all, 'draw']];
  const spans = [];
  const ISR = S.ISR, ISR_END = S.ISR_END, SND_S = S.SND_S, SND_E = S.SND_E;
  function hook() {
    const cpu = m.cpu, pc = cpu.pc, sp = cpu.sp;
    if (pc === S.MAIN) armed = true;
    if (sp < st.spMin) st.spMin = sp;
    if (sp > st.spMax) st.spMax = sp;
    const inRange = (pc >= ISR && pc < ISR_END) || (pc >= SND_S && pc < SND_E);
    if (inRange) { if (!inIsr) { inIsr = true; isrT0 = m.tstates - 13; isrSync = rd8(m, S.V_SYNC); } }
    else if (inIsr) { inIsr = false; isrAcc += m.tstates - isrT0; }
    for (const [addr, name] of trackers) if (pc === addr && !inIsr) spans.push({ name, sp, ret: rd16(m, sp), t0: m.tstates, i0: isrAcc });
    for (let k = spans.length - 1; k >= 0; k--) {
      const s = spans[k];
      if (pc === s.ret && sp === s.sp + 2 && !inIsr) { (s.name === 'erase' ? st.eraseT : s.name === 'redraw' ? st.redrawT : st.drawT).push(m.tstates - s.t0 - (isrAcc - s.i0)); spans.splice(k, 1); }
    }
    if (pc === S.WORK_START) { workT0 = m.tstates; workIsr0 = isrAcc; if (!(cpu.im === 1 && cpu.iff1)) st.imBad++; tickStart = { n: rd16(m, S.V_TICKS), frames: rd16(m, S.V_FRAMES) }; }
    if (pc === S.TICK_REQUEST && tickStart) {
      const n = rd16(m, S.V_TICKS) - 1, hidden = rd8(m, S.V_HIDDEN);
      st.ticks.push({ n, frames: tickStart.frames, hidden });
      if (script) { for (const o of script[n] ?? []) model.apply(o); st.snapshots[hidden] = { n, model: model.clone() }; }
      if (onTick) onTick(m, n, model);
    }
    if (pc === S.WORK_END && workT0 >= 0) { st.work.push(m.tstates - workT0 - (isrAcc - workIsr0)); workT0 = -1; }
    if (hooks) hooks(pc, { m, st, inIsr });
  }
  let prevFrames = rd16(m, S.V_FRAMES), prevBit = m.portFF & 1;
  for (let f = 0; (st.frames < nframes || st.ticks.length < untilTicks + 2) && f < nframes + 200 + 40 * untilTicks; f++) {
    ffWrites = [];
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
    if (ffWrites.length) st.flipWrites.push(ffWrites[0].rel);
    if (m.portFF !== rd8(m, S.V_SHADOW_FF)) st.shadowBad++;
    prevBit = bit;
    st.frames++;
    if (checkPicture) {
      const snap = st.snapshots[bit];
      const base = snap ? snap.model : new ModelClass({ ...game.spec, script: null, map: null, noBoot: true });
      const exp = base.render();
      const got = dfileOf(m, bit);
      const bad = diffCount(exp.bitmap, got.bitmap) + diffCount(exp.attrs, got.attrs);
      if (pixels) { const sc = shownColours(m), ec = colourPlane(exp); if ((sc === null ? -1 : diffCount(ec, sc)) !== 0) st.pixelBad++; }
      if (bad === 0) st.pictureOk++;
      else {
        st.pictureBad++;
        if (!st.firstBad) {
          const where = [];
          for (let i = 0; i < exp.bitmap.length && where.length < 8; i++) if (exp.bitmap[i] !== got.bitmap[i]) where.push(`${hex(i, 4)}:${hex(got.bitmap[i], 2)}/${hex(exp.bitmap[i], 2)}`);
          st.firstBad = { frame: st.frames, bad, tick: snap?.n, file: bit + 1, where: where.join(' ') };
        }
      }
    }
  }
  const { LOGN, LOGBUF } = logAddrs(S);
  st.gameLog = Array.from({ length: rd16(m, LOGN) }, (_, i) => rd16(m, LOGBUF + 2 * i));
  st.modelLog = model.log;
  st.canary = rd16(m, S.STACK_CANARY);
  st.finalTicks = rd16(m, S.V_TICKS);
  return st;
}

/**
 * The frame cache, simulated from the documented rule (layout.inc, docs/ARCADE_RUNTIME_API_V3.md): per asset with phases > 1 the cached frames
 * (0..K-1 at boot) and the round-robin pointer.  draw(insts) = one draw_all: every visible instance in index order whose rounded x is not a
 * multiple of 8 (shift 0 is drawn from the game image) needs its clamped frame in the cache; a miss evicts the first cached frame from RR on that
 * no visible instance of the asset shows, RR = that frame + 1 (mod nframes).
 */
export class CacheSim {
  constructor(assets, plan) {
    this.assets = assets;
    this.c = assets.map((a, k) => ({ cached: new Set(Array.from({ length: plan.K[k] }, (_, f) => f)), rr: 0 }));
    this.misses = 0;
  }
  draw(insts) {
    insts.forEach((s) => {
      if (!s.visible) return;
      const a = this.assets[s.asset], c = this.c[s.asset];
      if (a.phases === 1 || ((s.x & ~(a.gran - 1)) & 7) === 0) return;
      const f = Math.min(s.frame, a.nf - 1);
      if (c.cached.has(f)) return;
      const prot = new Set(insts.filter((t) => t.visible && t.asset === s.asset).map((t) => Math.min(t.frame, a.nf - 1)));
      for (let k = 0; k < a.nf; k++) {
        const g = (c.rr + k) % a.nf;
        if (c.cached.has(g) && !prot.has(g)) { c.cached.delete(g); c.rr = (g + 1) % a.nf; c.cached.add(f); this.misses++; return; }
      }
    });
  }
}

/** Boot a game and run `frames` refreshes; returns the machine. */
export function run(game, frames = 20) { const m = newMachine(game.dck); bootMachine(m, game.syms); for (let f = 0; f < frames; f++) M.runFrame(m); return m; }

/** A random walk of `n` instances (x / y ranges per instance from the asset sizes are the model's business: ops may ask for anything). */
export function addWalk(script, n, r, { hideRate = 0.03, jumpRate = 0.04, frames = null, frameRate = 0.3 } = {}) {
  const pos = Array.from({ length: n }, () => ({ x: r.int(0, 230), y: r.int(0, 170), dx: r.int(-5, 5), dy: r.int(-4, 4), f: 0 }));
  script.forEach((t) => {
    pos.forEach((p, i) => {
      if (r.chance(jumpRate)) { p.x = r.int(-40, 300); p.y = r.int(-40, 230); }
      else { p.x += p.dx; p.y += p.dy; if (p.x < -3 || p.x > 250) p.dx = -p.dx; if (p.y < -3 || p.y > 190) p.dy = -p.dy; }
      if (r.chance(hideRate)) t.push(op.hide(i));
      else if (frames && r.chance(frameRate)) { p.f = r.chance(0.1) ? r.int(0, 255) : r.int(0, frames[i] - 1); t.push(op.showf(i, p.x, p.y, p.f)); }
      else t.push(op.show(i, p.x, p.y));
    });
  });
  return script;
}

/** The phase pool as the machine holds it: per asset the FTAB address, K, and per frame the (rom, slot) pair. */
export function poolState(m, S, nassets) {
  return Array.from({ length: nassets }, (_, a) => {
    const rec = S.AST + S.AST_LEN * a, ftab = rd16(m, rec + S.AST_FTAB), nf = rd8(m, rec + S.AST_NF);
    const fte = ftab ? Array.from({ length: nf }, (_, f) => ({ rom: rd16(m, ftab + 4 * f), slot: rd16(m, ftab + 4 * f + 2) })) : [];
    return { ftab, K: rd8(m, rec + S.AST_K), nf, fte, rr: rd8(m, rec + S.AST_RR) };
  });
}
