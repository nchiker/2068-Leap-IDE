"use strict";
// m4-common.mjs -- shared helpers of the M4a runtime tests (m4-runtime*.mjs): building the v2 runtime and the script-driven test game, the
// JavaScript MODEL of the v2 runtime (cell map as in M3, assets with phases, instances, collision) written from docs/ARCADE_RUNTIME_API_V2.md
// and NOT from the Z80 sources, and `observe()`, which runs a game on a stock TS2068 (TSRun) one instruction at a time and compares what the
// machine shows after every refresh with the model.  The pure helpers (machine, font, display files, checks) come from the M3 helpers.
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntime, assembleGame, linkGame, dckOf, RUNTIME_DIR } from '../tools/build-runtime-v2.mjs';
import * as C3 from './m3-common.mjs';

export const { M, Z, FRAME_T, FIRST_PIXEL_T, SCR_X0, SCR_Y0, FRAME_W, hex, int16, makeChecks, rd8, rd16, newMachine, bootMachine, callRoutine, bootSkip,
  FONT, fontGlyph, ZERO8, rowAddr, BG_ATTR, clamp, colourPlane, shownColours, dfileOf, diffCount, glyphOfValue, avg, ayWritesFor } = C3;
const HERE = dirname(fileURLToPath(import.meta.url));
void HERE;

let _rt = null;
/** Build the v2 runtime once per process. */
export function runtime() { return (_rt ??= buildRuntime()); }

// ---- the test game: test_script.asm (v2) + data written by the test ------------------------------------------------------
export const SCRIPT = { SPRTAB: 0x8800, HOT: 0x8840, INST: 0x8860, SPRDATA: 0x8960, TILESET: 0x8B60, SFXTAB: 0x9300, SFXDATA: 0x9340, MAP: 0x9800,
  BASE: 0x9B00, END: 0xC000, LOGBUF: 0xE200, LOGN: 0xE102 };
let _asm = null;
function scriptAsm() { return (_asm ??= assembleGame(join(RUNTIME_DIR, 'test_script.asm'), { name: 'script2' })); }

export const op = {
  ...C3.op,
  keydown: (c) => ({ op: 'keydown', c }),
  deep: (n) => ({ op: 'deep', n }),
};
const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
function encodeOp(o) {
  switch (o.op) {
    case 'show': return o.x >= 0 && o.x < 256 && o.y >= 0 && o.y < 256 ? [19, o.i, o.x, o.y] : [1, o.i, ...w16(o.x), ...w16(o.y)];
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
  if (out.length > SCRIPT.END - SCRIPT.BASE) throw new Error('script too long: ' + out.length);
  return out;
}

// ---- assets -------------------------------------------------------------------------------------------------------------------
/** Rows of an asset as the data bytes the runtime reads: width 16 -> mask_hi, mask_lo, image_hi, image_lo; width 8 -> mask, image. */
export function assetBytes(a) {
  const out = [];
  for (const r of a.rows) out.push(...(a.w > 8 ? [r.mask >> 8, r.mask & 0xFF, r.image >> 8, r.image & 0xFF] : [r.mask & 0xFF, r.image & 0xFF]));
  return out;
}
/** A random asset: width, height, phases as given (raw header values); random mask / image rows (about 50 % opaque pixels). */
export function randomAsset(r, w, h, phases, { hot = null } = {}) {
  const wide = w > 8, rows = [];
  const nbits = wide ? 16 : 8;
  for (let k = 0; k < normH(h); k++) {                   // (the runtime reads at most 16 rows, and one for a height of 0)
    let mask = 0, image = 0;
    for (let b = 0; b < nbits; b++) {
      const cover = r.chance(0.55);                       // sprite covers the background here
      mask = (mask << 1) | (cover ? 0 : 1);
      image = (image << 1) | (cover && r.chance(0.5) ? 1 : 0);
      if (!cover && r.chance(0.05)) image |= 1;           // and now and then an image bit under a kept background (the formula must still hold)
    }
    rows.push({ mask, image });
  }
  return { w, h, phases, rows, hot };
}

// ---- header normalisation (the contract's clamps, written from docs/ARCADE_RUNTIME_API_V2.md "As built") -------------------------------
export const normW = (w) => (w <= 8 ? 8 : 16);
export const normH = (h) => (h < 1 ? 1 : h > 16 ? 16 : h);
export const normPhases = (p) => (p >= 8 ? 8 : p >= 4 ? 4 : p >= 2 ? 2 : 1);

/**
 * Link the script game.  spec: { div, assets: [{ w, h, phases, rows, hot }], insts: [asset index per instance], tiles, sfx, map, script,
 * nassetsHeader / ninstHeader / header overrides, spriteTable0 / instTable0 (null pointers) }.  Returns { img, dck, syms, gsyms, spec }.
 */
export function scriptGame(spec = {}) {
  const rt = runtime(), g = scriptAsm();
  const img = linkGame(rt.img, g.bytes);
  const put = (a, bytes) => { img.set(bytes, a); };
  const assets = spec.assets ?? [];
  const insts = spec.insts ?? [];
  img[0x8004] = spec.div ?? 1;
  img[0x8005] = spec.nassetsHeader ?? assets.length;
  let dataAt = SCRIPT.SPRDATA;
  assets.forEach((a, i) => {
    const bytes = assetBytes(a);
    if (dataAt + bytes.length > SCRIPT.TILESET) throw new Error('sprite art does not fit');
    put(dataAt, bytes);
    let hotPtr = 0;
    if (a.hot) { hotPtr = SCRIPT.HOT + 4 * i; put(hotPtr, a.hot); }
    put(SCRIPT.SPRTAB + 8 * i, [a.w, a.h, ...w16(dataAt), ...w16(hotPtr), a.phases, 0]);
    dataAt += bytes.length;
  });
  const ninstBytes = [spec.ninstHeader ?? insts.length, ...insts];
  if (SCRIPT.INST + ninstBytes.length > SCRIPT.SPRDATA) throw new Error('instance table too long');
  put(SCRIPT.INST, ninstBytes);
  let tilesetPtr = 0, sfxPtr = 0, mapPtr = 0;
  if (spec.tiles) {
    tilesetPtr = SCRIPT.TILESET;
    const bytes = [spec.tilesetCount ?? spec.tiles.length];
    for (const t of spec.tiles) bytes.push(...t.bmp, t.attr);
    put(tilesetPtr, bytes);
  }
  if (spec.sfx) {
    sfxPtr = SCRIPT.SFXTAB;
    const tab = [spec.sfxCount ?? spec.sfx.length];
    let at = SCRIPT.SFXDATA;
    spec.sfx.forEach((recs) => {
      tab.push(...w16(at));
      const bytes = recs.flatMap((r) => r).concat([0, 0xFF, 0, 0]);
      put(at, bytes);
      at += bytes.length;
    });
    put(sfxPtr, tab);
  }
  if (spec.map) { mapPtr = SCRIPT.MAP; put(mapPtr, spec.map); }
  put(0x8006, w16(spec.spriteTable0 ? 0 : SCRIPT.SPRTAB));
  put(0x8008, [...w16(spec.tilesetPtr ?? tilesetPtr), ...w16(spec.sfxPtr ?? sfxPtr), ...w16(spec.mapPtr ?? mapPtr), ...w16(spec.instTable0 ? 0 : SCRIPT.INST)]);
  img.fill(0, SCRIPT.BASE, SCRIPT.END);                  // a script that has run out is a run of empty ticks (op 0)
  if (spec.script) put(SCRIPT.BASE, encodeScript(spec.script));
  for (const [a, v] of Object.entries(spec.header ?? {})) img[Number(a)] = v;
  if (spec.noSkip) img.fill(0, rt.syms.SKIP_CALL, rt.syms.SKIP_CALL + 3);     // the call of skip_analysis becomes three NOPs: no instance is ever skipped
  return { img, dck: dckOf(img), syms: rt.syms, gsyms: g.syms, spec, bytes: img.slice(0x8000, 0x8000 + g.bytes.length) };
}

// ---- the model ---------------------------------------------------------------------------------------------------------------
/** What the v2 runtime should hold: M3's cell map / text / tile model plus assets, instances, collision, drawn from the header values. */
export class Model2 extends C3.Model {
  constructor(spec = {}) {
    super({ ...spec, sprites: [] });
    const rawAssets = (spec.assets ?? []).slice(0, spec.nassetsHeader ?? (spec.assets ?? []).length);
    const na = spec.spriteTable0 ? 0 : Math.min(spec.nassetsHeader ?? (spec.assets ?? []).length, 8);
    this.assets = rawAssets.slice(0, na).map((a) => {
      const w = normW(a.w), h = normH(a.h), phases = normPhases(a.phases), gran = 8 / phases;
      return { w, h, phases, gran, rows: a.rows, hot: a.hot ?? [0, 0, w, h] };
    });
    const ni = spec.instTable0 || this.assets.length === 0 ? 0 : Math.min(spec.ninstHeader ?? (spec.insts ?? []).length, 16);
    this.insts = Array.from({ length: ni }, (_, i) => ({ asset: Math.min((spec.insts ?? [])[i] ?? 0, this.assets.length - 1), visible: false, x: 0, y: 0 }));
  }
  clone() {
    const m = Object.create(Model2.prototype);
    Object.assign(m, this);
    m.tile = this.tile.slice(); m.attr = this.attr.slice();
    m.insts = this.insts.map((s) => ({ ...s }));
    m.log = [];
    return m;
  }
  box(i) {
    const s = this.insts[i];
    if (!s || !s.visible) return null;
    const [hx, hy, hw, hh] = this.assets[s.asset].hot;
    if (hw === 0 || hh === 0) return null;
    return { x0: s.x + hx, x1: s.x + hx + hw, y0: s.y + hy, y1: s.y + hy + hh };
  }
  apply(o) {
    switch (o.op) {
      case 'show': if (o.i >= 0 && o.i < this.insts.length) Object.assign(this.insts[o.i], { visible: true, x: clamp(int16(o.x), 239), y: clamp(int16(o.y), 176) }); break;
      case 'hide': if (o.i >= 0 && o.i < this.insts.length) this.insts[o.i].visible = false; break;
      default: super.apply(o);
    }
  }
  /** The x the blit uses: the stored x rounded down to the asset's granularity. */
  drawX(s) { return s.x & ~(this.assets[s.asset].gran - 1); }
  /** The expected display file: cells first, then the visible instances in index order (a higher index on top). */
  render() {
    const { bitmap, attrs } = super.render(null);
    this.insts.forEach((s) => {
      if (!s.visible) return;
      const a = this.assets[s.asset], xd = this.drawX(s), nb = a.w;
      for (let rr = 0; rr < a.h; rr++) {
        const y = s.y + rr, mask = a.rows[rr].mask, image = a.rows[rr].image;
        for (let b = 0; b < nb; b++) {
          const x = xd + b, adr = rowAddr(y) + (x >> 3), bit = 0x80 >> (x & 7);
          const keep = (mask >> (nb - 1 - b)) & 1, ink = (image >> (nb - 1 - b)) & 1;
          let v = bitmap[adr];
          v = keep ? v : v & ~bit;                         // (old AND mask) ...
          if (ink) v |= bit;                               // ... OR image
          bitmap[adr] = v;
        }
      }
    });
    return { bitmap, attrs };
  }
}

// ---- observing a run ---------------------------------------------------------------------------------------------------------
/**
 * Run `game` on a stock TS2068, one instruction at a time from the cartridge entry, `nframes` refreshes after boot, and compare the picture
 * after every refresh with the model (advanced tick by tick through the game's script).  Same as M3's observe(), with the v2 model.
 */
export function observe(game, nframes, { script = null, checkPicture = true, pixels = true, hooks = null, keyMatrix = null } = {}) {
  const S = game.syms;
  const m = newMachine(game.dck, { video: pixels && checkPicture });         // the picture check reads m.pixels
  let entryFrame = -1;
  for (let f = 1; f <= 400; f++) { M.runFrame(m); if (rd16(m, S.HO_MARK) === 0x5AA5) { entryFrame = f + bootSkip(m); break; } }
  const model = new Model2(game.spec);
  const st = {
    m, entryFrame, bootFrames: 0, frames: 0, ticks: [], isr: [], sndIsr: [], work: [], eraseT: [], redrawT: [], drawT: [], writeViolations: 0, spMin: 0xFFFF,
    spMax: 0, pictureOk: 0, pictureBad: 0, pixelBad: 0, firstBad: null, snapshots: [null, null], flipMismatch: 0, missed: 0, skippedFlips: 0,
    logOk: true, imBad: 0, model, ayWrites: [], dirtyMax: 0, spans: [], shadowBad: 0, flipWrites: [],
  };
  let armed = false, inIsr = false, isrT0 = 0, isrAcc = 0, isrSync = 0, workT0 = -1, workIsr0 = 0, tickStart = null;
  let ffWrites = [];
  let sndEntryT = -1;
  const origOut = m.bus.ioWrite;
  m.bus.ioWrite = (port, v) => {
    const p = port & 0xFF;
    if (p === 0xFF) ffWrites.push({ rel: m.tstates - m.frameStart, v });
    if (p === 0xF5 || p === 0xF6) st.ayWrites.push({ port: p, v, inIsr, frame: rd16(m, S.V_FRAMES), t: m.tstates });
    origOut(port, v);
  };
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
    const inRange = (pc >= ISR && pc < ISR_END) || (pc >= SND_S && pc < SND_E) || (inIsr && pc >= S.SND_XS && pc < SND_E);   // (the tick calls SND_SYNC / SND_OWNCLR below SND_S: music)
    if (inRange) {
      if (!inIsr) { inIsr = true; isrT0 = m.tstates - 13; isrSync = rd8(m, S.V_SYNC); }
      if (pc === SND_S) sndEntryT = m.tstates;
    } else if (inIsr) {
      inIsr = false;
      const dt = m.tstates - isrT0;
      st.isr.push(dt); isrAcc += dt;
      if (sndEntryT >= 0) { st.sndIsr.push(dt); sndEntryT = -1; }
    }
    for (const [addr, name] of trackers) if (pc === addr && !inIsr) spans.push({ name, sp, ret: rd16(m, sp), t0: m.tstates, i0: isrAcc });
    for (let k = spans.length - 1; k >= 0; k--) {
      const s = spans[k];
      if (pc === s.ret && sp === s.sp + 2 && !inIsr) {
        (s.name === 'erase' ? st.eraseT : s.name === 'redraw' ? st.redrawT : st.drawT).push(m.tstates - s.t0 - (isrAcc - s.i0));
        spans.splice(k, 1);
      }
    }
    if (pc === S.WORK_START) {
      workT0 = m.tstates; workIsr0 = isrAcc;
      if (!(cpu.im === 1 && cpu.iff1)) st.imBad++;
      tickStart = { n: rd16(m, S.V_TICKS), frames: rd16(m, S.V_FRAMES) };
    }
    if (pc === S.TICK_REQUEST && tickStart) {
      const n = rd16(m, S.V_TICKS) - 1, hidden = rd8(m, S.V_HIDDEN);
      st.ticks.push({ n, frames: tickStart.frames, hidden });
      if (script) {
        for (const o of script[n] ?? []) model.apply(o);
        st.snapshots[hidden] = { n, model: model.clone() };
      }
      let dirty = 0;
      for (let i = 0; i < 96; i++) dirty += rd8(m, S.DIRTY0 + i) !== 0 ? 1 : 0;
      st.dirtyMax = Math.max(st.dirtyMax, dirty);
    }
    if (pc === S.WORK_END && workT0 >= 0) { st.work.push(m.tstates - workT0 - (isrAcc - workIsr0)); st.spans.push(rd16(m, S.V_FRAMES) - tickStart.frames); workT0 = -1; }
    if (hooks) hooks(pc, { m, st, inIsr });
  }
  st.spans = [];
  if (keyMatrix) m.keyMatrix.set(keyMatrix);
  let prevFrames = rd16(m, S.V_FRAMES), prevBit = m.portFF & 1;
  for (let f = 0; st.frames < nframes && f < nframes + 200; f++) {
    ffWrites = [];
    const end = m.frameStart + FRAME_T;
    while (m.tstates < end) {
      if (m.cpu.halted) break;
      hook();
      Z.runZ80(m.cpu, m.bus, 1, m);
    }
    M.runFrame(m);
    const fr = rd16(m, S.V_FRAMES);
    if (fr === 0 || prevFrames === 0) { if (fr === 0) st.bootFrames++; prevFrames = fr; prevBit = m.portFF & 1; continue; }
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
      const base = snap ? snap.model : new Model2({ ...game.spec, script: null, map: null });
      const exp = base.render();
      const got = dfileOf(m, bit);
      const bad = diffCount(exp.bitmap, got.bitmap) + diffCount(exp.attrs, got.attrs);
      let pbad = 0;
      if (pixels) {
        const sc = shownColours(m), ec = colourPlane(exp);
        pbad = sc === null ? -1 : diffCount(ec, sc);
        if (pbad !== 0) st.pixelBad++;
      }
      if (bad === 0) st.pictureOk++;
      else {
        st.pictureBad++;
        if (!st.firstBad) {
          const where = [];
          for (let i = 0; i < exp.bitmap.length && where.length < 12; i++) if (exp.bitmap[i] !== got.bitmap[i]) where.push(`${hex(i, 4)}:${hex(got.bitmap[i], 2)}/${hex(exp.bitmap[i], 2)}`);
          st.firstBad = { frame: st.frames, bad, tick: snap?.n, file: bit + 1, pbad, where: where.join(' ') };
        }
      }
    }
  }
  const logN = rd16(m, SCRIPT.LOGN);
  const got = [];
  for (let i = 0; i < logN; i++) got.push(rd16(m, SCRIPT.LOGBUF + 2 * i));
  st.gameLog = got; st.modelLog = model.log;
  st.canary = rd16(m, S.STACK_CANARY);
  st.finalTicks = rd16(m, S.V_TICKS);
  st.finalFrames = rd16(m, S.V_FRAMES);
  return st;
}

export { C3 };
