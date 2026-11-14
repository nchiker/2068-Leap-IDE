"use strict";
// m3-common.mjs -- shared helpers of the M3 runtime tests (m3-runtime*.mjs): building the v1 runtime and the script-driven test game,
// the JavaScript MODEL of the runtime (cell map, text, tiles, sprites, collision, sound) written from docs/ARCADE_RUNTIME_API_V1.md and
// NOT from the Z80 sources, a renderer of the model into display-file bytes and colours, and `observe()`, which runs a game on a stock
// TS2068 (TSRun) one instruction at a time and compares what the machine shows after every refresh with the model.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntime, assembleGame, linkGame, dckOf, RUNTIME_DIR } from '../tools/build-runtime-v1.mjs';
import * as C2 from './m2-runtime-common.mjs';

export const { M, Z, FRAME_T, FIRST_PIXEL_T, SCR_X0, SCR_Y0, FRAME_W, hex, int16, makeChecks, rd8, rd16, newMachine, bootMachine, callRoutine, bootSkip } = C2;
const HERE = dirname(fileURLToPath(import.meta.url));

let _rt = null;
/** Build the v1 runtime once per process. */
export function runtime() { return (_rt ??= buildRuntime()); }

// ---- the font: parsed from the generated font.inc (the Z80 side reads the same bytes through sjasmplus; the model reads them here) ----
export const FONT = (() => {
  const g = [];
  for (const line of readFileSync(join(RUNTIME_DIR, 'font.inc'), 'utf8').split('\n')) {
    const m = line.match(/^\s*DB\s+(.*?)\s*;/);
    if (m) g.push(m[1].split(',').map((s) => parseInt(s.trim().replace('$', ''), 16)));
  }
  if (g.length !== 96) throw new Error('font.inc: expected 96 glyphs, got ' + g.length);
  return g;
})();
export const ZERO8 = [0, 0, 0, 0, 0, 0, 0, 0];
/** Glyph bytes of a font code (0..127): 32..127 from the font, 0..31 blank. */
export const fontGlyph = (code) => (code >= 32 && code <= 127 ? FONT[code - 32] : ZERO8);

// ---- screen layout helpers -----------------------------------------------------------------------------------------
export const rowAddr = (y) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);   // offset of pixel row y in a display file
export const BG_ATTR = 0x38;
export const clamp = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);

// ---- the test game: test_script.asm + data written by the test -------------------------------------------------------
export const SCRIPT = { SPRTAB: 0x8800, HOT: 0x8860, TILESET: 0x8900, SFXTAB: 0x9000, SFXDATA: 0x9040, MAP: 0x9800, BASE: 0x9B00, END: 0xC000,
  LOGBUF: 0xE200, LOGN: 0xE102 };
let _asm = null;
function scriptAsm() { return (_asm ??= assembleGame(join(RUNTIME_DIR, 'test_script.asm'), { name: 'script' })); }

/**
 * Op encoders for the script game (see test_script.asm).  An op is a plain object; a tick is an array of ops; a script an array of ticks.
 */
export const op = {
  show: (i, x, y) => ({ op: 'show', i, x, y }),
  hide: (i) => ({ op: 'hide', i }),
  at: (row, col) => ({ op: 'at', row, col }),
  prints: (s) => ({ op: 'prints', s }),                    // s: string (or array of codes), at most 255 long
  printn: (v) => ({ op: 'printn', v }),
  printc: (c) => ({ op: 'printc', c }),
  ink: (a) => ({ op: 'ink', a }),
  paper: (a) => ({ op: 'paper', a }),
  bright: (a) => ({ op: 'bright', a }),
  cls: () => ({ op: 'cls' }),
  tile: (t, row, col) => ({ op: 'tile', t, row, col }),
  play: (i) => ({ op: 'play', i }),
  silence: () => ({ op: 'silence' }),
  hit: (a, b) => ({ op: 'hit', a, b }),
  tileat: (row, col) => ({ op: 'tileat', row, col }),
  burn: () => ({ op: 'burn' }),
  stick: (n) => ({ op: 'stick', n }),
};
const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
function encodeOp(o) {
  switch (o.op) {
    case 'show': return [1, o.i, ...w16(o.x), ...w16(o.y)];
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
    default: throw new Error('unknown op ' + o.op);
  }
}
export function encodeScript(ticks) {
  const out = [];
  for (const t of ticks) { for (const o of t) out.push(...encodeOp(o)); out.push(0); }
  if (out.length > SCRIPT.END - SCRIPT.BASE) throw new Error('script too long: ' + out.length);
  return out;
}

export const SPRITE_H = { ball: 16, box: 12 };
/**
 * Link the script game.  spec: { div, sprites: [{ kind: 'ball'|'box', hot?: [x, y, w, h] }], tiles: [{ bmp: [8 bytes], attr }], tilesetCount (override
 * of the count byte), sfx: [[record, ...]] (a record is [tone_lo, tone_hi | vol << 4, noise | mix << 5, 0]), map: array of 768 cell bytes,
 * script: ticks, header: { addr: value } overrides of header bytes after the above, spriteCountHeader (override) }.
 * Returns { img, dck, syms, gsyms, spec }.
 */
export function scriptGame(spec = {}) {
  const rt = runtime(), g = scriptAsm();
  const img = linkGame(rt.img, g.bytes);
  const put = (a, bytes) => { img.set(bytes, a); };
  const sprites = spec.sprites ?? [];
  img[0x8004] = spec.div ?? 1;
  img[0x8005] = spec.spriteCountHeader ?? sprites.length;
  sprites.forEach((s, i) => {
    const h = s.height ?? SPRITE_H[s.kind];
    let hotPtr = 0;
    if (s.hot) { hotPtr = SCRIPT.HOT + 4 * i; put(hotPtr, s.hot); }
    put(SCRIPT.SPRTAB + 6 * i, [16, h, ...w16(g.syms[s.kind]), ...w16(hotPtr)]);
  });
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
  put(0x8008, [...w16(spec.tilesetPtr ?? tilesetPtr), ...w16(spec.sfxPtr ?? sfxPtr), ...w16(spec.mapPtr ?? mapPtr)]);
  img.fill(0, SCRIPT.BASE, SCRIPT.END);                  // a script that has run out is a run of empty ticks (op 0)
  if (spec.script) put(SCRIPT.BASE, encodeScript(spec.script));
  for (const [a, v] of Object.entries(spec.header ?? {})) img[Number(a)] = v;
  return { img, dck: dckOf(img), syms: rt.syms, gsyms: g.syms, spec, bytes: img.slice(0x8000, 0x8000 + g.bytes.length) };
}

// ---- the model ---------------------------------------------------------------------------------------------------------
/** What the runtime should hold, from docs/ARCADE_RUNTIME_API_V1.md.  Mutable; ops are applied in the order the game makes its calls. */
export class Model {
  constructor(spec = {}) {
    this.tile = new Uint8Array(768).fill(32);
    this.attr = new Uint8Array(768).fill(BG_ATTR);
    this.tileBmp = Array.from({ length: 128 }, () => ZERO8.slice());
    this.tileAttr = new Array(128).fill(BG_ATTR);
    const tiles = spec.tiles ?? [];
    tiles.slice(0, Math.min(128, spec.tilesetCount ?? tiles.length)).forEach((t, k) => { this.tileBmp[k] = t.bmp.slice(); this.tileAttr[k] = t.attr; });
    if (spec.map) {
      this.tile.set(spec.map);
      for (let i = 0; i < 768; i++) this.attr[i] = this.tile[i] & 0x80 ? this.tileAttr[this.tile[i] & 0x7F] : BG_ATTR;
    }
    this.textAttr = BG_ATTR; this.row = 0; this.col = 0;
    this.sprites = (spec.sprites ?? []).slice(0, 4).map((s) => {
      const h = clamp(s.height ?? SPRITE_H[s.kind], 16) || 1;
      return { kind: s.kind, h: Math.max(1, h), hot: s.hot ?? [0, 0, 16, Math.max(1, h)], visible: false, x: 0, y: 0 };
    });
    this.log = [];
  }
  clone() {
    const m = Object.create(Model.prototype);
    Object.assign(m, this);
    m.tile = this.tile.slice(); m.attr = this.attr.slice();
    m.sprites = this.sprites.map((s) => ({ ...s }));
    m.log = []; // snapshots carry no log
    return m;
  }
  put(code) {
    const idx = this.row * 32 + this.col;
    this.tile[idx] = code & 0x7F; this.attr[idx] = this.textAttr;
    if (++this.col === 32) { this.col = 0; if (++this.row === 24) this.row = 0; }
  }
  tileSet(t, row, col) {
    if (row < 0 || row > 23 || col < 0 || col > 31) return;
    t &= 0x7F;
    this.tile[row * 32 + col] = 0x80 | t; this.attr[row * 32 + col] = this.tileAttr[t];
  }
  tileAt(row, col) {
    if (row < 0 || row > 23 || col < 0 || col > 31) return -1;
    const v = this.tile[row * 32 + col];
    return v & 0x80 ? v & 0x7F : -1;
  }
  box(i) {
    const s = this.sprites[i];
    if (!s || !s.visible) return null;
    const [hx, hy, hw, hh] = s.hot;
    if (hw === 0 || hh === 0) return null;
    return { x0: s.x + hx, x1: s.x + hx + hw, y0: s.y + hy, y1: s.y + hy + hh };
  }
  hit(a, b) {
    const A = this.box(a), B = this.box(b);
    return A && B && A.x0 < B.x1 && B.x0 < A.x1 && A.y0 < B.y1 && B.y0 < A.y1 ? 1 : 0;
  }
  /** Apply one script op (the tests' own model of what the runtime does). */
  apply(o) {
    switch (o.op) {
      case 'show': if (o.i < this.sprites.length) Object.assign(this.sprites[o.i], { visible: true, x: clamp(int16(o.x), 239), y: clamp(int16(o.y), 176) }); break;
      case 'hide': if (o.i < this.sprites.length) this.sprites[o.i].visible = false; break;
      case 'at': this.row = Math.min(o.row, 23); this.col = Math.min(o.col, 31); break;
      case 'prints': {
        const codes = typeof o.s === 'string' ? [...o.s].map((c) => c.charCodeAt(0)) : o.s;
        for (const c of codes.slice(0, Math.min(31, codes.length))) this.put(c);
        break;
      }
      case 'printn': for (const ch of String(int16(o.v))) this.put(ch.charCodeAt(0)); break;
      case 'printc': this.put(o.c); break;
      case 'ink': this.textAttr = (this.textAttr & 0xF8) | (o.a & 7); break;
      case 'paper': this.textAttr = (this.textAttr & 0xC7) | ((o.a & 7) << 3); break;
      case 'bright': this.textAttr = (this.textAttr & 0xBF) | ((o.a & 1) << 6); break;
      case 'cls': this.tile.fill(32); this.attr.fill(this.textAttr & 0x38); this.row = 0; this.col = 0; break;
      case 'tile': this.tileSet(o.t, o.row, o.col); break;
      case 'hit': this.log.push(this.hit(o.a, o.b)); break;
      case 'tileat': this.log.push(this.tileAt(o.row, o.col) & 0xFFFF); break;
      default: break;   // play / silence / burn: not part of the picture
    }
  }
  /** Cell glyph bytes (8 rows). */
  glyph(idx) {
    const v = this.tile[idx];
    return v & 0x80 ? this.tileBmp[v & 0x7F] : fontGlyph(v);
  }
  /** The expected display file: { bitmap: 6144 bytes in screen layout, attrs: 768 bytes }; cells first, then the sprites in index order. */
  render(spriteRows) {
    const bitmap = new Uint8Array(6144), attrs = this.attr.slice();
    for (let r = 0; r < 24; r++) for (let c = 0; c < 32; c++) {
      const g = this.glyph(r * 32 + c);
      for (let k = 0; k < 8; k++) bitmap[rowAddr(r * 8 + k) + c] = g[k];
    }
    if (spriteRows) this.sprites.forEach((s, i) => {
      if (!s.visible) return;
      const rows = spriteRows[s.kind];
      for (let rr = 0; rr < s.h; rr++) {
        const y = s.y + rr, mask = rows[rr].mask, image = rows[rr].image;
        for (let b = 0; b < 16; b++) {
          const x = s.x + b, a = rowAddr(y) + (x >> 3), bit = 0x80 >> (x & 7);
          const keep = (mask >> (15 - b)) & 1, ink = (image >> (15 - b)) & 1;
          let v = bitmap[a];
          if (keep) { /* background shows (the image bit must be 0 there for the data used) */ if (ink) v |= bit; } else v = ink ? v | bit : v & ~bit;
          bitmap[a] = v;
        }
      }
      void i;
    });
    return { bitmap, attrs };
  }
}

/** Sprite pixel rows ({mask, image} words) of the two test shapes, read from the assembled game image. */
export function spriteRowsOf(game) {
  const out = {};
  for (const k of ['ball', 'box']) out[k] = C2.spriteRows(game.bytes, game.gsyms[k], SPRITE_H[k]);
  return out;
}

/** Colour index (0..15) of every pixel of a rendered display file: (bitmap bit ? ink : paper) + 8 if bright.  Flash is not modelled. */
export function colourPlane({ bitmap, attrs }) {
  const out = new Uint8Array(256 * 192);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const a = attrs[(y >> 3) * 32 + (x >> 3)], bit = (bitmap[rowAddr(y) + (x >> 3)] >> (7 - (x & 7))) & 1;
    out[y * 256 + x] = (bit ? a & 7 : (a >> 3) & 7) + (a & 0x40 ? 8 : 0);
  }
  return out;
}
/** The frame buffer as a 256x192 colour plane, or null when a pixel pair is uneven. */
export function shownColours(m) {
  const px = C2.pixelsOf(m);                                // throws when the machine was made with video off (V8)
  const out = new Uint8Array(256 * 192);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const a = px[(SCR_Y0 + y) * FRAME_W + SCR_X0 + 2 * x], b = px[(SCR_Y0 + y) * FRAME_W + SCR_X0 + 2 * x + 1];
    if (a !== b) return null;
    out[y * 256 + x] = a;
  }
  return out;
}
/** The display file `bit` (0/1) of the machine: { bitmap, attrs } copied out of RAM. */
export function dfileOf(m, bit) {
  const base = bit ? 0x6000 : 0x4000;
  return { bitmap: m.ram.slice(base, base + 6144), attrs: m.ram.slice(base + 0x1800, base + 0x1B00) };
}
export function diffCount(a, b) { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; }

// ---- the sound model -------------------------------------------------------------------------------------------------------
/** AY registers 0..15 as the sound code leaves them after playing a record: returns the (reg, value) writes in order, updating `regs`. */
export function ayWritesFor(regs, rec) {
  const [b0, b1, b2] = rec;
  const mix = (b2 >> 5) & 3;
  const want = { 0: b0, 1: b1 & 0x0F, 6: b2 & 0x1F, 7: 0x36 | (mix & 1) | ((mix & 2) << 2), 8: b1 >> 4 };
  const writes = [];
  for (const r of [0, 1, 6, 7, 8]) if (regs[r] !== want[r]) { regs[r] = want[r]; writes.push([r, want[r]]); }
  return writes;
}

// ---- observing a run -------------------------------------------------------------------------------------------------------
/**
 * Run `game` on a stock TS2068, one instruction at a time from the cartridge entry, `nframes` refreshes after boot, and compare the picture
 * after every refresh with `model` (a Model built from the same spec, advanced tick by tick through the game's script).
 * opts: { model: Model|null, script: ticks (for the model), onHook(pc, ctx), wantAy, perFrame(ctx) }.
 * Returns a state object; see the field list below.
 */
export function observe(game, nframes, { script = null, checkPicture = true, pixels = true, hooks = null } = {}) {
  const S = game.syms, GS = game.gsyms;
  const m = newMachine(game.dck, { video: pixels && checkPicture });         // the picture check reads m.pixels
  let entryFrame = -1;
  for (let f = 1; f <= 400; f++) { M.runFrame(m); if (rd16(m, S.HO_MARK) === 0x5AA5) { entryFrame = f + bootSkip(m); break; } }
  const rows = spriteRowsOf(game);
  const model = new Model(game.spec);
  const st = {
    m, entryFrame, bootFrames: 0, frames: 0, ticks: [], isr: [], sndIsr: [], work: [], eraseT: [], redrawT: [], drawT: [], writeViolations: 0, spMin: 0xFFFF,
    spMax: 0, pictureOk: 0, pictureBad: 0, pixelBad: 0, firstBad: null, snapshots: [null, null], flipMismatch: 0, missed: 0, skippedFlips: 0,
    logOk: true, imBad: 0, model, ayWrites: [], dirtyMax: 0, spans: [], shadowBad: 0, flipWrites: [],
  };
  let armed = false, inIsr = false, isrT0 = 0, isrAcc = 0, isrSync = 0, workT0 = -1, workIsr0 = 0, tickStart = null, logPos = 0;
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
  let prevFrames = rd16(m, S.V_FRAMES), prevBit = m.portFF & 1;
  const needSpriteRows = true;
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
      const base = snap ? snap.model : new Model({ sprites: game.spec.sprites ?? [] });
      const exp = base.render(needSpriteRows ? rows : null);
      const got = dfileOf(m, bit);
      const bad = diffCount(exp.bitmap, got.bitmap) + diffCount(exp.attrs, got.attrs);
      let pbad = 0;
      if (pixels) {
        const sc = shownColours(m), ec = colourPlane(exp);
        pbad = sc === null ? -1 : diffCount(ec, sc);
        if (pbad !== 0) st.pixelBad++;
      }
      if (bad === 0) st.pictureOk++; else { st.pictureBad++; st.firstBad ??= { frame: st.frames, bad, tick: snap?.n, file: bit + 1, pbad }; }
    }
  }
  // game's log vs model log
  const logN = rd16(m, SCRIPT.LOGN);
  const got = [];
  for (let i = 0; i < logN; i++) got.push(rd16(m, SCRIPT.LOGBUF + 2 * i));
  st.gameLog = got; st.modelLog = model.log;
  void logPos; void GS;
  st.canary = rd16(m, S.STACK_CANARY);
  st.finalTicks = rd16(m, S.V_TICKS);
  st.finalFrames = rd16(m, S.V_FRAMES);
  return st;
}

/** The 8 rows of the glyph of cell value v in the machine's GLYPH_TAB (row k at GLYPH_TAB + 256 k + v). */
export const glyphOfValue = (m, S, v) => Array.from({ length: 8 }, (_, k) => m.ram[S.GLYPH_TAB + 256 * k + v]);

export const avg = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);
export { C2 };
