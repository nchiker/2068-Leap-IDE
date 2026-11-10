"use strict";
// arcade-m5-harness.mjs -- shared by tests/arcade-m5.mjs and tests/arcade-blockfall.mjs (language batch 1): compile a program for the REAL v2 runtime,
// boot the cartridge on a stock TS2068 in TSRun, run it tick by tick and compare each tick with the reference interpreter.
//
//   real()                     -> {rt, img, SYM, ok}   the parsed arcade/build/v2/runtime.json and runtime.bin (ok: it has the batch 1 routines)
//   compileReal(src, assets)   -> compile() result (throws with the error list when the program does not compile)
//   runReal(res, opts)         -> {ticks: [snapshot], costs, rnd, ...}   opts: {ticks, keys(t), stick(t), measure}
//   interpFor(src, assets, rt) -> (ticks, opts) -> interpreter record   (xorshift RND with the runtime's seed and RANDOMISE model)
//   diffRecords(got, want, names) -> null | message
//
// A snapshot has: vars {NAME: value}, arrays {NAME: [flat values]}, cells, attrs (768 bytes each), cursor {row, col}, textAttr, border (V_BORDER), sprites [{visible, x, y}].
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(HERE, '..');
const TSRUN = join(ROOT, 'tsrun');
export const M_ = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
export const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
export const hex = (v, w = 4) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

/** The runtime's RND: a 16-bit xorshift (docs/ARCADE_RUNTIME_API.md), 0..32767. */
export class XS {
  constructor(seed) { this.x = seed; }
  next() { if (this.x === 0) this.x = 1; this.x = (this.x ^ (this.x << 7)) & 0xFFFF; this.x ^= this.x >> 9; this.x = (this.x ^ (this.x << 8)) & 0xFFFF; return this.x & 0x7FFF; }
}

let _real = null;
export function real() {
  if (_real) return _real;
  const json = join(ROOT, 'arcade/build/v2/runtime.json');
  if (!existsSync(json)) return (_real = { ok: false, why: 'arcade/build/v2/runtime.json does not exist' });
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  const img = new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin')));
  const need = ['RT_FILL', 'RT_FILLC', 'RT_COPY', 'RT_LOADMAP', 'RT_LOADMAPAT', 'RT_BORDER', 'RT_RANDOMISE', 'V_BORDER', 'RT_ARGS'];
  const missing = need.filter((n) => rt.symbols[n] === undefined);
  _real = { rt, img, SYM: rt.symbols, ok: rt.version === 2 && missing.length === 0, why: missing.length ? `runtime.json lacks ${missing.join(' ')}` : '' };
  return _real;
}

export const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
export function compileReal(src, assets) {
  const R = real();
  const res = compile(src, { runtime: R.rt, image: R.img, assets });
  if (res.errors.length) throw new Error('compile: ' + errText(res));
  return res;
}

const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
const KEYROWS = ['\x01ZXCV', 'ASDFG', 'QWERT', '12345', '09876', 'POIUY', '\rLKJH', ' \x02MNB'];
const KEYPOS = new Map(); KEYROWS.forEach((r, row) => [...r].forEach((ch, bit) => KEYPOS.set(ch.charCodeAt(0), [row, bit])));

/** Boot the cartridge and run until `ticks` ticks have completed. */
export function runReal(res, { ticks, stick = null, keys = null, measure = false, hooks = null } = {}) {
  const R = real(), SYM = R.SYM;
  const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  const must = (e) => { if (e) throw new Error(e); };
  const ROMDIR = join(TSRUN, 'roms');
  must(M_.setHomeRom(m, readFileSync(join(ROMDIR, 'ts2068-0.rom'))));
  must(M_.setExRom(m, readFileSync(join(ROMDIR, 'ts2068-1.rom'))));
  must(M_.insertDock(m, res.dck));
  M_.resetMachine(m);
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const nInst = res.gen.v2 ? res.gen.v2.ninst : 4;
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    arrays: Object.fromEntries(Object.entries(res.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))])),
    sprites: Array.from({ length: Math.max(nInst, 4) }, (_, i) => ({ visible: m.ram[SYM.SPR_TAB + 6 * i], x: rd16(SYM.SPR_TAB + 6 * i + 2), y: rd16(SYM.SPR_TAB + 6 * i + 4) })),
    cells: m.ram.slice(SYM.CELL_TILE, SYM.CELL_TILE + 768), attrs: m.ram.slice(SYM.CELL_ATTR, SYM.CELL_ATTR + 768),
    cursor: { row: m.ram[SYM.V_CUR_ROW], col: m.ram[SYM.V_CUR_COL] }, textAttr: m.ram[SYM.V_TEXT_ATTR], border: m.ram[SYM.V_BORDER],
    sfxActive: m.ram[SYM.V_SFX_ACTIVE],
  });
  const out = { ticks: [], error: null, machine: m, costs: [], rnd: [[]], R: [null], S: [null], plays: [[]], frameGaps: [] };
  const div = res.memory[0x8004] & 0x7F;
  let tickStart = -1;
  if (measure) {
    const orig = m.bus.write;
    m.bus.write = function (a, v) {
      if (a === SYM.V_SYNC) {
        if (v === 0) tickStart = m.tstates;
        else if (v >= 2 && tickStart >= 0) { out.costs.push(m.tstates - tickStart); tickStart = -1; }
      }
      return orig.call(this, a, v);
    };
  }
  const codeLo = res.gen.base, codeHi = res.gen.base + res.gen.code.length;
  const maxFrames = 400 + (ticks + 2) * div * 4;
  for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
  // hooks at the entry of PROC INIT / PROC FRAME / RT_PLAY / RT_SILENCE / RT_RANDOMISE: the frame counter then (the sound model and the bare RANDOMISE need it)
  const fe = res.map.entries.frame, ie = res.map.entries.init;
  let cur = 0;
  const origRead = m.bus.read;
  m.bus.read = function (a) {
    if (a === fe) { out.R.push(rd16(SYM.V_FRAMES)); out.plays[++cur] = []; out.rnd[cur] = []; }
    else if (a === ie) { cur = 0; out.plays[0] = []; out.rnd[0] = []; }
    else if (a === SYM.RT_PLAY || a === SYM.RT_SILENCE) out.plays[cur]?.push(rd16(SYM.V_FRAMES));
    else if (a === SYM.RT_RANDOMISE && m.cpu.h === 0 && m.cpu.l === 0) bare = true;
    return origRead.call(this, a);
  };
  // the seed a bare RANDOMISE ends up with (the routine reads V_FRAMES one instruction later; the frame interrupt may fall in between): the word it stores in RT_SEED
  let bare = false, seedLo = 0;
  const origWrite = m.bus.write;
  m.bus.write = function (a, v) {
    if (a === SYM.RT_SEED) seedLo = v;
    else if (a === SYM.RT_SEED + 1 && bare) { out.rnd[cur]?.push(seedLo | (v << 8)); bare = false; }
    return origWrite.call(this, a, v);
  };
  // T-states of PROC FRAME itself (from its first fetch to the fetch at its return address; the frame interrupt's handler is included)
  out.frameT = [null];
  { const outer = m.bus.read; let t0 = -1, ret = -1;
    m.bus.read = function (a) {
      if (a === fe && t0 < 0) { t0 = m.tstates; ret = m.ram[m.cpu.sp] | (m.ram[m.cpu.sp + 1] << 8); }
      else if (t0 >= 0 && a === ret) { out.frameT.push(m.tstates - t0); t0 = -1; }
      return outer.call(this, a);
    }; }
  let lastTickFrame = -1;
  for (let f = 0; f < maxFrames && out.ticks.length < ticks; f++) {
    const k = out.ticks.length + 1;
    const held = new Set(keys ? keys(k) : []);
    for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F;
    for (const c of held) { const p = KEYPOS.get(c); if (p) m.keyMatrix[p[0]] &= ~(1 << p[1]); }
    const sv = stick ? stick(k) : 0;
    m.joystick[0] = contact(typeof sv === 'number' ? sv : sv[1] | 0);
    m.joystick[1] = contact(typeof sv === 'number' ? 0 : sv[2] | 0);
    M_.runFrame(m);
    if (rd16(SYM.V_FRAMES) === 0) continue;
    const nt = rd16(SYM.V_TICKS);
    if (nt === k - 1) continue;
    if (nt !== k) { out.error = `V_TICKS went from ${k - 1} to ${nt} in one refresh`; break; }
    if (m.cpu.pc >= codeLo && m.cpu.pc < codeHi) { out.error = `tick ${k}: compiled code still running at the end of its refresh (pc ${hex(m.cpu.pc)})`; break; }
    out.ticks.push(snap());
    out.S.push(rd16(SYM.V_FRAMES));
    if (lastTickFrame >= 0) out.frameGaps.push(rd16(SYM.V_FRAMES) - lastTickFrame);
    lastTickFrame = rd16(SYM.V_FRAMES);
    if (hooks?.afterTick) hooks.afterTick(k, m);
  }
  if (!out.error && out.ticks.length < ticks) out.error = `only ${out.ticks.length} of ${ticks} ticks ran (V_TICKS ${rd16(SYM.V_TICKS)})`;
  return out;
}

/** The interpreter set up as the real runtime behaves: RND = xorshift from the boot seed, RANDOMISE reseeds it, the bare one reads the frame counter the machine showed. */
export function interpFor(src, assets, got = null, extra = {}) {
  const R = real();
  let xs = new XS(R.rt.constants?.RT_SEED_INIT ?? 0xACE1);
  return (ticks, opts = {}) => {
    xs = new XS(R.rt.constants?.RT_SEED_INIT ?? 0xACE1);
    return interpret(parse(src).ast, {
      version: 2, ticks, assets, maxSteps: 400_000_000, rnd: () => xs.next(), reseed: (sd) => { xs = new XS(sd); return () => xs.next(); },
      frames: got ? (t, n) => got.rnd[t]?.[n - 1] ?? 0 : undefined, border0: R.rt.constants?.BORDER_COLOUR ?? 1,
      clock: got ? { play: (t, n) => got.plays[t]?.[n - 1] ?? 0, sample: (t) => got.S[t] } : undefined,
      ...opts, ...extra,
    });
  };
}

/** Compare the real snapshots with the interpreter's records. Returns null when equal, else the first difference. */
export function diffRecords(got, want, { skip = [], sprites = false } = {}) {
  const n = Math.min(got.length, want.ticks.length);
  for (let i = 0; i < n; i++) {
    const g = got[i], w = want.ticks[i], at = `tick ${i + 1}`;
    for (const [k, v] of Object.entries(w.vars)) if (g.vars[k] !== v) return `${at}: ${k} = ${g.vars[k]}, interpreter ${v}`;
    for (const [k, arr] of Object.entries(w.arrays ?? {})) {
      const ga = g.arrays[k];
      if (!ga) return `${at}: array ${k} missing in the compiled game`;
      for (let j = 0; j < arr.length; j++) if (ga[j] !== arr[j]) return `${at}: ${k}(${j}) = ${ga[j]}, interpreter ${arr[j]}`;
    }
    if (!skip.includes('cells')) {
      for (let c = 0; c < 768; c++) if (g.cells[c] !== w.cells[c]) return `${at}: cell (row ${(c / 32) | 0}, col ${c % 32}) = $${g.cells[c].toString(16)}, interpreter $${w.cells[c].toString(16)}`;
      for (let c = 0; c < 768; c++) if (g.attrs[c] !== w.attrs[c]) return `${at}: attribute (row ${(c / 32) | 0}, col ${c % 32}) = $${g.attrs[c].toString(16)}, interpreter $${w.attrs[c].toString(16)}`;
      if (g.cursor.row !== w.cursor.row || g.cursor.col !== w.cursor.col) return `${at}: cursor (${g.cursor.row}, ${g.cursor.col}), interpreter (${w.cursor.row}, ${w.cursor.col})`;
      if (g.textAttr !== w.textAttr) return `${at}: text attribute $${g.textAttr.toString(16)}, interpreter $${w.textAttr.toString(16)}`;
    }
    if (!skip.includes('border') && g.border !== w.border) return `${at}: border ${g.border}, interpreter ${w.border}`;
    if (sprites) for (let j = 0; j < 16; j++) {
      const a = g.sprites[j], b = w.sprites[j];
      if (!a || !b) continue;
      if (!!a.visible !== !!b.visible || (b.visible && (a.x !== b.x || a.y !== b.y))) return `${at}: sprite ${j} = (${a.visible} ${a.x},${a.y}), interpreter (${b.visible} ${b.x},${b.y})`;
    }
  }
  return got.length < want.ticks.length ? `only ${got.length} ticks ran` : null;
}

/** Compile, run on the real runtime and on the interpreter, compare. Returns {ok, detail, res, got, want}. */
export function differential(src, assets, { ticks = 150, keys = null, stick = null, measure = false, sprites = false, skip = [] } = {}) {
  let res, got;
  try {
    res = compileReal(src, assets);
    got = runReal(res, { ticks, keys, stick, measure });
    if (got.error) throw new Error(got.error);
  } catch (e) { return { ok: false, detail: e.message, res, got }; }
  let want;
  try {
    want = interpFor(src, assets, got)(ticks, { keys: keys ? (t, c) => keys(t).includes(c) : undefined, stick: stick ?? undefined });
  } catch (e) { return { ok: false, detail: 'interpreter: ' + e.message, res, got }; }
  const d = diffRecords(got.ticks, want, { sprites, skip });
  return { ok: d === null, detail: d ?? `${ticks} ticks`, res, got, want };
}
