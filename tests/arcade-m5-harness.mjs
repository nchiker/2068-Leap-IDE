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
// Games with songs (MUSIC, docs/ARCADE_MUSIC_CONTRACT.md 5a, 6a): runReal also times every RT_MUSIC / RT_NOMUSIC call (`musics[t]`, as `plays[t]` for RT_PLAY / RT_SILENCE) and detects a sound call
// that a frame interrupt cut in two (`straddle` = the first tick in which one was: the interpreter cannot place such a call, so sound is compared up to that tick only); interpFor gives the interpreter
// the clock {play, music, sample}; a snapshot has sfxActive (V_SFX_ACTIVE), ay (AY_SHADOW R0..R10) and chip (the AY's R0..R10), and diffRecords compares them whenever the interpreter's record has
// `ay` (it has, exactly when the game has songs) at the level of tests/arcade-m15-differential.mjs: V_SFX_ACTIVE (all bits) = ay.flags, AY_SHADOW = ay.regs, chip = AY_SHADOW, every tick.
//
// A snapshot has: vars {NAME: value}, arrays {NAME: [flat values]}, cells, attrs (768 bytes each), cursor {row, col}, textAttr, border (V_BORDER), sprites [{visible, x, y}].
import { bootedMachine } from '../arcade/tests/fast-boot.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { compareSound, soundCoverage } from './arcade-m15-common.mjs';

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

const _reals = new Map();
/** The parsed arcade/build/v<version>/runtime.json and runtime.bin (default v2: what every caller used before; v3 / v4 are for tools/regen-baselines.mjs). */
export function real(version = 2) {
  if (_reals.has(version)) return _reals.get(version);
  const r = loadReal(version);
  _reals.set(version, r);
  return r;
}
function loadReal(version) {
  let _real;
  const json = join(ROOT, `arcade/build/v${version}/runtime.json`);
  if (!existsSync(json)) return (_real = { ok: false, why: `arcade/build/v${version}/runtime.json does not exist` });
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  const img = new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin')));
  const need = ['RT_FILL', 'RT_FILLC', 'RT_COPY', 'RT_LOADMAP', 'RT_LOADMAPAT', 'RT_BORDER', 'RT_RANDOMISE', 'V_BORDER', 'RT_ARGS'];
  const missing = need.filter((n) => rt.symbols[n] === undefined);
  _real = { rt, img, SYM: rt.symbols, ok: rt.version === version && missing.length === 0, why: missing.length ? `runtime.json lacks ${missing.join(' ')}` : '' };
  return _real;
}

export const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
export function compileReal(src, assets, { R = real(), compile: compileFn = compile } = {}) {      // (R: another runtime table, compile: another compiler; tools/regen-baselines.mjs)
  const res = compileFn(src, { runtime: R.rt, image: R.img, assets });
  if (res.errors.length) throw new Error('compile: ' + errText(res));
  return res;
}

const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
const KEYROWS = ['\x01ZXCV', 'ASDFG', 'QWERT', '12345', '09876', 'POIUY', '\rLKJH', ' \x02MNB'];
const KEYPOS = new Map(); KEYROWS.forEach((r, row) => [...r].forEach((ch, bit) => KEYPOS.set(ch.charCodeAt(0), [row, bit])));

/** Boot the cartridge and run until `ticks` ticks have completed. */
export function runReal(res, { ticks, stick = null, keys = null, measure = false, hooks = null, R: Rov = null } = {}) {
  const R = Rov ?? real(), SYM = R.SYM;
  const m = bootedMachine(res.dck);                       // restored from the boot snapshot (V9), video off (V8)
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const nInst = res.gen.v2 ? res.gen.v2.ninst : 4;
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    arrays: Object.fromEntries(Object.entries(res.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))])),
    sprites: Array.from({ length: Math.max(nInst, 4) }, (_, i) => ({ visible: m.ram[SYM.SPR_TAB + 6 * i], x: rd16(SYM.SPR_TAB + 6 * i + 2), y: rd16(SYM.SPR_TAB + 6 * i + 4) })),
    cells: m.ram.slice(SYM.CELL_TILE, SYM.CELL_TILE + 768), attrs: m.ram.slice(SYM.CELL_ATTR, SYM.CELL_ATTR + 768),
    cursor: { row: m.ram[SYM.V_CUR_ROW], col: m.ram[SYM.V_CUR_COL] }, textAttr: m.ram[SYM.V_TEXT_ATTR], border: m.ram[SYM.V_BORDER],
    sfxActive: m.ram[SYM.V_SFX_ACTIVE], ay: Array.from(m.ram.slice(SYM.AY_SHADOW, SYM.AY_SHADOW + 11)), chip: Array.from({ length: 11 }, (_, k) => m.ay.regs[k]),
  });
  const out = { ticks: [], error: null, machine: m, costs: [], rnd: [[]], R: [null], S: [null], plays: [[]], musics: [[]], frameGaps: [], straddle: null, cuts: [], cutInfo: [], soundCalls: 0 };
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
  // (RT_MUSIC / RT_NOMUSIC exist in a runtime of the music build: a call's return is watched too: it is `straddle`d when V_FRAMES changed between its entry and its return)
  let cur = 0, open = [];
  const SOUND = new Map([[SYM.RT_PLAY, 'plays'], [SYM.RT_SILENCE, 'plays'], [SYM.RT_MUSIC, 'musics'], [SYM.RT_NOMUSIC, 'musics']]);
  SOUND.delete(undefined);
  const origRead = m.bus.read;
  m.bus.read = function (a) {
    if (a === fe) { out.R.push(rd16(SYM.V_FRAMES)); out.plays[++cur] = []; out.musics[cur] = []; out.rnd[cur] = []; }
    else if (a === ie) { cur = 0; out.plays[0] = []; out.musics[0] = []; out.rnd[0] = []; }
    else if (SOUND.has(a) && m.cpu.pc === a) {
      const f0 = rd16(SYM.V_FRAMES);
      out[SOUND.get(a)][cur]?.push(f0);
      const listLen = out[SOUND.get(a)][cur]?.length ?? 0;
      out.soundCalls++;
      open.push({ ret: rd16(m.cpu.sp), sp: m.cpu.sp, f0, t: cur, list: SOUND.get(a), n: listLen, name: [...SOUND.keys()].map((k) => [k, ['RT_PLAY', 'RT_SILENCE', 'RT_MUSIC', 'RT_NOMUSIC'].find((n) => SYM[n] === k)]).find(([k]) => k === a)[1] });
    }
    else if (open.length && m.cpu.pc === a) {
      const o = open[open.length - 1];
      if (a === o.ret && m.cpu.sp === ((o.sp + 2) & 0xFFFF)) { open.pop(); if (rd16(SYM.V_FRAMES) !== o.f0) { out.cutInfo.push({ t: o.t, list: o.list, n: o.n, f0: o.f0, f1: rd16(SYM.V_FRAMES) }); out.cuts.push(`tick ${o.t} ${o.name}: entered at refresh ${o.f0}, returned at ${rd16(SYM.V_FRAMES)}`); out.straddle ??= o.t; } }
    }
    if (a === SYM.RT_RANDOMISE && m.cpu.h === 0 && m.cpu.l === 0) bare = true;
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
      clock: got ? { play: (t, n) => got.plays[t]?.[n - 1] ?? 0, music: (t, n) => got.musics[t]?.[n - 1] ?? 0, sample: (t) => got.S[t] } : undefined,
      ...opts, ...extra,
    });
  };
}

/** Compare the real snapshots with the interpreter's records. Returns null when equal, else the first difference. */
export function diffRecords(got, want, { skip = [], sprites = false, straddle = null } = {}) {
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
    if (w.ay && !skip.includes('sound') && (straddle === null || i + 1 < straddle)) {      // a game with songs: the sound at the level of the m15 differential (no comparison of a tick at or after a call a frame interrupt cut)
      if (g.sfxActive !== w.ay.flags) return `${at}: V_SFX_ACTIVE = ${g.sfxActive}, interpreter ${w.ay.flags}`;
      if (JSON.stringify(g.ay) !== JSON.stringify(w.ay.regs)) return `${at}: AY_SHADOW = ${g.ay}, interpreter ${w.ay.regs}`;
      if (JSON.stringify(g.chip) !== JSON.stringify(g.ay)) return `${at}: the chip ${g.chip} differs from AY_SHADOW ${g.ay}`;
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
  const d = diffRecords(got.ticks, want, { sprites, skip, straddle: got.straddle });
  return { ok: d === null, detail: d ?? `${ticks} ticks`, res, got, want };
}

/**
 * The sound of a whole run of a game with songs, at song level (V_SFX_ACTIVE all bits = ay.flags, AY_SHADOW R0..R10 = ay.regs, the chip = AY_SHADOW, every tick), counts included.
 * `runInterp(clock, n)` gives the interpreter's run of n ticks with that clock ({play, music, sample}: the refresh each call and each sample was made at, as the machine showed).
 * A call that a frame interrupt cut in two (RT_PLAY / RT_SILENCE / RT_MUSIC / RT_NOMUSIC entered at refresh f0 and returned at f1 = f0 + 1) has no single refresh to be placed at: the runtime's own contract
 * (arcade/tests/m15-runtime-music.mjs section 4: an interrupt in the middle of one of the four routines leaves the state of a run without the interrupt, or of that run one refresh later) lets it take
 * effect at the refresh it was entered at or at the one it returned at.  Each cut call is therefore tried at f0, then at f1 (in order of the run, each against every tick up to the next cut call), and the whole run is then
 * compared exactly with the placements found; a cut call that fits neither is a failure (reported with the first difference of the f0 placement).  Without a cut call this is the plain comparison.
 * Returns {d, stats, cuts: [text], ...}; `ok` also needs the counts of `need` above 0.
 */
export function compareSoundRun(got, ticks, runInterp, need = ['song', 'effect', 'cOver']) {
  const cuts = [...(got.cutInfo ?? [])].sort((a, b) => a.t - b.t || a.n - b.n);
  const base = { play: (t, n) => got.plays[t]?.[n - 1] ?? 0, music: (t, n) => got.musics[t]?.[n - 1] ?? 0, sample: (t) => got.S[t] };
  const clockWith = (placed) => {
    const at = (list) => (t, n) => { const c = placed.find((x) => x.c.list === list && x.c.t === t && x.c.n === n); return c ? c.f : base[list === 'plays' ? 'play' : 'music'](t, n); };
    return { play: at('plays'), music: at('musics'), sample: base.sample };
  };
  const compareTo = (want, upTo) => {
    const pairs = [];
    for (let k = 1; k <= upTo; k++) pairs.push({ at: `tick ${k}`, g: got.ticks[k - 1], w: want.ticks[k - 1] });
    return compareSound(pairs);
  };
  const placed = [], notes = [];
  for (let i = 0; i < cuts.length; i++) {
    const c = cuts[i], limit = i + 1 < cuts.length ? cuts[i + 1].t - 1 : ticks;      // (the ticks before the next cut call's tick)
    if (limit < c.t) { placed.push({ c, f: c.f0 }); notes.push(`tick ${c.t}: another cut call in the same tick, placed at its entry`); continue; }
    let ok = null, firstD = null;
    for (const f of [c.f0, c.f1]) {
      const r = compareTo(runInterp(clockWith([...placed, { c, f }]), limit), limit);
      if (r.d === null) { ok = f; break; }
      firstD ??= r.d;
    }
    if (ok === null) return { d: `a call cut by a frame interrupt (tick ${c.t}, entered at refresh ${c.f0}, returned at ${c.f1}) fits neither placement; at its entry: ${firstD}`, stats: { compared: 0 }, cov: { ok: false, text: '' }, ok: false, notes };
    placed.push({ c, f: ok });
    notes.push(`tick ${c.t} ${c.list === 'plays' ? 'RT_PLAY / RT_SILENCE' : 'RT_MUSIC / RT_NOMUSIC'} call cut by a frame interrupt (entered at refresh ${c.f0}, returned at ${c.f1}): took effect at the refresh it ${ok === c.f0 ? 'was entered at' : 'returned at'}`);
  }
  const { d, stats } = compareTo(runInterp(clockWith(placed), ticks), ticks);
  const cov = soundCoverage(stats, need, []);
  return { d, stats, cov, ok: d === null && cov.ok && got.soundCalls > 0, notes, text: `${cov.text}; ${got.soundCalls} sound calls${notes.length ? '; ' + notes.join('; ') : ''}${cov.ok ? '' : '; MISSING: a count that must be above 0 is 0'}` };
}
