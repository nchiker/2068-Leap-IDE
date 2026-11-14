#!/usr/bin/env node
"use strict";
// arcade-m12-differential.mjs -- bankable per-level tables (docs/ARCADE_TABLES_CONTRACT.md, slices T2 / T3) against the REAL runtimes on a stock TS2068 in TSRun: the compiled game is compared with the
// reference interpreter tick by tick, built normally (the records mapped, or banked by the policy) and with `bankAll` (every record in the window, copied by RT_TABLELOAD).
//
//   node tests/arcade-m12-differential.mjs                 (ARCADE_QUICK=1: fewer random programs and ticks)
//
// Sections
//   1  hand-written programs (v2): every rule of contract 2.2 / 2.3 on the machine: array rows zeroing the rest, scalar rows, 2-D rows, adjacent and separated targets, the index form (negative,
//      past the end, an expression), scopes and numbering across scenes, a game-level PROC, TIMER targets, 16-bit wrap, a table that changes nothing else (cells, attributes, sprites), 255 runs,
//      a 1,807-byte record, 256 tables with an index of 255
//   2  random programs (v2): random variables, arrays (1-D and 2-D), TIMERs and CONSTs, game-level and scene tables with random rows, random LOADTABLE statements (names, indexes, expressions,
//      a PROC), scene rings; equal to the interpreter on every variable and array at every tick, normal and bankAll, and the two builds equal on the WHOLE variable block (hidden slots included)
//   3  the same random programs inside a WINDOW game (v3) and a VIEW3D game (v4)
//   4  negative controls: a damaged banked record is seen by the comparison
//
// How a tick is sampled: when PROC FRAME (or the driver's frame$entry) is entered, so sample k is the state after tick k - 1 (sample 0: after INIT), as tests/arcade-m11-differential.mjs does.
import { bootedMachine } from '../arcade/tests/fast-boot.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { ROOT, M_, s16 } from './arcade-m5-harness.mjs';
import { rng, pick, ri } from './arcade-m9-common.mjs';
import { ASSETS11, HEAD } from './arcade-m11-common.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const skip_ = (name, why) => { console.log(`  SKIP  ${name}  (${why})`); skipped++; };
const info = (s) => console.log('  INFO  ' + s);
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');

// ── runtimes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function loadRuntime(v) {
  const json = join(resolve(ROOT, `arcade/build/v${v}`), 'runtime.json');
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))), v };
}
const RT = { 2: loadRuntime(2), 3: loadRuntime(3), 4: loadRuntime(4) };
const lacking = (R) => (R ? (R.rt.symbols.RT_TABLELOAD === undefined ? ['RT_TABLELOAD'] : []) : ['the runtime']);

// ── the machine ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Boot the cartridge (the DCK as built: chunks 2 / 3 too when banked) and sample at every entry of PROC FRAME. */
function runFramed(R, res, { ticks }) {
  const SYM = { ...R.rt.symbols, ...(R.rt.constants ?? {}) };
  const m = bootedMachine(res.dck);                       // restored from the boot snapshot (V9), video off (V8)
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const ent = SYM.SPR_ENT ?? 6, hasFrame = ent >= 8;
  const nInst = Math.max(res.gen.v2 ? res.gen.v2.ninst : 4, 4);
  const sceneSym = res.gen?.symbols?.scene ?? null;
  const slots = res.map.slots;
  const lo = slots.length ? slots[0].addr : 0, hi = slots.length ? slots[slots.length - 1].addr + 2 : 0;
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    arrays: Object.fromEntries(Object.entries(res.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))])),
    block: m.ram.slice(lo, hi),                                  // the whole variable block, hidden slots included
    scene: sceneSym ? m.ram[sceneSym.cur] : 0,
    sprites: Array.from({ length: nInst }, (_, i) => { const e = SYM.SPR_TAB + ent * i; return hasFrame ? { visible: m.ram[e], x: s16(rd16(e + 2)), y: s16(rd16(e + 4)) } : { visible: m.ram[e], x: rd16(e + 2), y: rd16(e + 4) }; }),
    cells: m.ram.slice(SYM.CELL_TILE, SYM.CELL_TILE + 768), attrs: m.ram.slice(SYM.CELL_ATTR, SYM.CELL_ATTR + 768),
    f4: SYM.V_SHADOW_F4 !== undefined ? m.ram[SYM.V_SHADOW_F4] : null,
    port4: m.ram.slice(0x4000, 0x8000),                          // the display files: a table load touches none of them
  });
  const out = { snaps: [], error: null, machine: m };
  for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
  const fe = res.map.entries.frame;
  for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F;
  m.joystick[0] = 0xFF; m.joystick[1] = 0xFF;
  const origRead = m.bus.read;
  m.bus.read = function (a) {
    if (a === fe && out.snaps.length < ticks + 1 && m.cpu.pc === fe) out.snaps.push(snap());
    return origRead.call(this, a);
  };
  const div = res.memory[0x8004] & 0x3F;
  const maxFrames = 400 + (ticks + 3) * Math.max(div, 14) * 6;
  for (let f = 0; f < maxFrames && out.snaps.length < ticks + 1; f++) M_.runFrame(m);
  if (out.snaps.length < ticks + 1) out.error = `only ${out.snaps.length} of ${ticks + 1} samples (PROC FRAME entered ${out.snaps.length} times)`;
  return out;
}
const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** machine samples against the interpreter's records: every variable and array (and the scene); with `screen` also the cell map, attributes and sprite table */
function vsInterp(got, want, { screen }) {
  for (let t = 0; t < got.snaps.length; t++) {
    const g = got.snaps[t], w = t === 0 ? want.init : want.ticks[t - 1], at = t === 0 ? 'after INIT' : `after tick ${t}`;
    for (const [k, v] of Object.entries(w.vars)) if (g.vars[k] !== v) return `${at}: ${k} = ${g.vars[k]}, interpreter ${v}`;
    for (const [k, arr] of Object.entries(w.arrays ?? {})) for (let j = 0; j < arr.length; j++) if (g.arrays[k]?.[j] !== arr[j]) return `${at}: ${k}(${j}) = ${g.arrays[k]?.[j]}, interpreter ${arr[j]}`;
    if (g.scene !== w.scene) return `${at}: scene ${g.scene}, interpreter ${w.scene}`;
    if (screen) {
      if (!same(g.cells, w.cells)) return `${at}: the cell map differs`;
      if (!same(g.attrs, w.attrs)) return `${at}: the attributes differ`;
      for (let j = 0; j < 16; j++) { const a = g.sprites[j], b = w.sprites[j]; if (a && b && (!!a.visible !== !!b.visible || (b.visible && (a.x !== b.x || a.y !== b.y)))) return `${at}: sprite ${j} differs`; }
    }
  }
  return null;
}

/**
 * One program on one runtime: built normally and with bankAll, each run on the machine and compared with the interpreter tick by tick; the two builds are also compared on the whole variable
 * block (hidden slots included) and on the display files. Returns {ok, detail, banked: [assets of the bankAll build], mappedTables}.
 */
function runBoth(R, src, assets, { ticks, v = 2, screen = false, modes = [false, true] }) {
  let want;
  try { want = interpret(parse(src).ast, { version: v, ticks, assets, maxSteps: 2_000_000_000, border0: R.rt.constants?.BORDER_COLOUR ?? 1 }); } catch (e) { return { ok: false, detail: 'interpreter: ' + e.message }; }
  const runs = [];
  for (const bankAll of modes) {
    const res = compile(src, { runtime: R.rt, image: R.img, assets, bankAll });
    if (res.errors.length) return { ok: false, detail: `compile${bankAll ? ' (bankAll)' : ''}: ${errText(res)}` };
    let got;
    try { got = runFramed(R, res, { ticks }); } catch (e) { return { ok: false, detail: `run${bankAll ? ' (bankAll)' : ''}: ${e.message}` }; }
    if (got.error) return { ok: false, detail: `run${bankAll ? ' (bankAll)' : ''}: ${got.error}` };
    const d = vsInterp(got, want, { screen });
    if (d) return { ok: false, detail: `${bankAll ? 'bankAll' : 'normal'}: ${d}` };
    if (bankAll) for (const s of got.snaps) if (s.f4 !== null && s.f4 !== 0x33) return { ok: false, detail: `bankAll: V_SHADOW_F4 is ${s.f4} at the entry of PROC FRAME (the window must be unmapped)` };
    runs.push({ res, got });
  }
  for (let t = 0; t < (runs.length > 1 ? runs[0].got.snaps.length : 0); t++) {
    if (!same(runs[0].got.snaps[t].block, runs[1].got.snaps[t].block)) return { ok: false, detail: `after tick ${t}: the variable block (hidden slots included) differs between the normal and the bankAll build` };
    if (!same(runs[0].got.snaps[t].port4, runs[1].got.snaps[t].port4)) return { ok: false, detail: `after tick ${t}: the display files differ between the normal and the bankAll build` };
  }
  const nT = (runs[0].res.gen.tables ?? []).length;
  return { ok: true, detail: `${ticks} ticks`, banked: runs[runs.length - 1].res.usage.banked.assets, tables: nT, mappedTables: runs[0].res.usage.tables ?? 0, normalBanked: runs[0].res.usage.banked.assets.filter((b) => b.kind === 'table').length };
}

// =================================================================================================================
// 1. Hand-written programs
// =================================================================================================================
console.log('1. Hand-written programs (v2): the contract on the machine, equal to the interpreter, normal and bankAll');
{
  const R = RT[2];
  const G = (top, init, frame, decl = '') => `${HEAD}${top}SCENE s\n${decl}  PROC INIT()\n${init}  ENDP\n  PROC FRAME()\n${frame}  ENDP\nENDSCENE\n`;
  const HAND = {};
  HAND.rows = [G('DIM a(4), b, c(2), d, g(1, 2)\nTABLE one\n  a = 1, 2\n  b = 7\nENDTABLE\nTABLE two\n  a = 9, 8, 7, 6, 5\n  c = 3\n  d = -4\n  g = 1, 2, 3, 4\nENDTABLE\nTABLE three\n  g = 40000\n  b = 65535\nENDTABLE\n',
    '    a(3) = 99\n    a(4) = 98\n    c(0) = 11\n    c(2) = 12\n    d = 55\n    g(1, 2) = 500\n    LOADTABLE one\n',
    '    t = t + 1\n    IF t = 2 THEN LOADTABLE two ENDIF\n    IF t = 3 THEN LOADTABLE one ENDIF\n    IF t = 4 THEN LOADTABLE three ENDIF\n    IF t = 5 THEN\n      d = 1\n      c(1) = 2\n      LOADTABLE 1\n    ENDIF\n    IF t = 6 THEN LOADTABLE 0 ENDIF\n', '  DIM t\n'), 12];
  HAND.adjacent = [G('DIM a(1), b, x, e(2), f, y(1)\nTABLE adj\n  b = 3\n  a = 1, 2\nENDTABLE\nTABLE sep\n  a = 4, 5\n  e = 6\nENDTABLE\nTABLE mix\n  a = 7\n  b = 8\n  x = 9\n  e = 1, 2, 3\n  f = 5\n  y = 6\nENDTABLE\n',
    '    x = 100\n    f = 101\n    y(1) = 102\n',
    '    t = t + 1\n    IF t = 1 THEN LOADTABLE adj ENDIF\n    IF t = 2 THEN LOADTABLE sep ENDIF\n    IF t = 3 THEN LOADTABLE mix ENDIF\n    IF t = 4 THEN LOADTABLE adj ENDIF\n    IF t = 5 THEN\n      x = 200\n      LOADTABLE sep\n    ENDIF\n', '  DIM t\n'), 8];
  HAND.sweep = [G('DIM a, b(2), n\nTABLE t0\n  a = 10\n  b = 1, 1, 1\nENDTABLE\nTABLE t1\n  a = 11\n  b = 2\nENDTABLE\nTABLE t2\n  a = 12\nENDTABLE\n',
    '', '    t = t + 1\n    n = t - 4\n    LOADTABLE n\n    IF t = 12 THEN LOADTABLE t - 11 ENDIF\n    IF t = 13 THEN LOADTABLE 2 ENDIF\n    IF t = 14 THEN LOADTABLE n - 14 ENDIF\n', '  DIM t\n'), 16];
  HAND.wrap = [G('CONST K = 300\nDIM a(5), b\nTABLE w\n  a = 40000, -1, 65535, 32768, 32767, -32768\n  b = K * K\nENDTABLE\nTABLE w2\n  a = K * 100, K DIV 7, K MOD 7\n  b = -K\nENDTABLE\n',
    '', '    t = t + 1\n    IF t = 1 THEN LOADTABLE w ENDIF\n    IF t = 3 THEN LOADTABLE w2 ENDIF\n', '  DIM t\n'), 5];
  HAND.timer = [G('TIMER cd\nDIM q, r(1)\nTABLE a\n  cd = 5\n  q = 1\n  r = 2, 3\nENDTABLE\nTABLE b\n  cd = -3\nENDTABLE\n',
    '', '    t = t + 1\n    IF t = 1 THEN LOADTABLE a ENDIF\n    IF t = 9 THEN LOADTABLE b ENDIF\n    IF t = 10 THEN LOADTABLE a ENDIF\n', '  DIM t\n'), 18];
  HAND.scenes = [`${HEAD}DIM g, ga(2), n
TABLE g0
  g = 1
  ga = 1, 1, 1
ENDTABLE
TABLE g1
  g = 2
  ga = 2
ENDTABLE
SCENE one
  DIM x, xa(1), t
  TABLE tb
    x = 5
    xa = 6, 7
    g = 8
  ENDTABLE
  TABLE tc
    ga = 4, 4
  ENDTABLE
  PROC INIT()
    LOADTABLE 2
  ENDP
  PROC FRAME()
    t = t + 1
    n = t MOD 4
    LOADTABLE n
    CALL glob(t MOD 3)
    IF t = 6 THEN ENTER two ENDIF
  ENDP
ENDSCENE
SCENE two
  DIM x, xa(1), t
  TABLE tb
    x = 50
    xa = 60
    ga = 70
  ENDTABLE
  PROC INIT()
    LOADTABLE tb
  ENDP
  PROC FRAME()
    t = t + 1
    LOADTABLE t - 1
    IF t = 5 THEN CALL glob(0) ENDIF
    IF t = 8 THEN ENTER one ENDIF
  ENDP
ENDSCENE
PROC glob(k)
  LOADTABLE k
  LOADTABLE g0
  IF k = 2 THEN LOADTABLE 99 ENDIF
ENDP
`, 22];
  HAND.screen = [`${HEAD}SPRITE ship = "orb"
SFX beep = "short"
DIM a(3), px, py, n
TABLE lv
  a = 3, 5, 7
  px = 40
  py = 80
ENDTABLE
SCENE s
  PROC INIT()
    PRINT AT 2, 3; "hello"
    TILE 4, 4 = 3
    PLAY beep
  ENDP
  PROC FRAME()
    n = n + 1
    IF n = 3 THEN LOADTABLE lv ENDIF
    SHOW ship AT px + n, py
    PRINT AT 5, 5; a(0)
    IF n = 6 THEN
      px = px + 8
      LOADTABLE 0
    ENDIF
  ENDP
ENDSCENE
`, 10, true];
  const manyVars = 560;
  const names = Array.from({ length: manyVars }, (_, i) => `v${i}`);
  HAND.runs255 = [G(`DIM ${names.join(', ')}\nTABLE wide\n${names.filter((_, i) => i % 2 === 0).slice(0, 255).map((n, i) => `  ${n} = ${i + 1000}\n`).join('')}ENDTABLE\nTABLE adjacent\n${names.slice(0, 300).map((n, i) => `  ${n} = ${i + 1}\n`).join('')}ENDTABLE\n`,
    '    v1 = 77\n    v559 = 31\n', '    t = t + 1\n    IF t = 1 THEN LOADTABLE wide ENDIF\n    IF t = 2 THEN LOADTABLE adjacent ENDIF\n    IF t = 3 THEN\n      v299 = 0\n      LOADTABLE 0\n    ENDIF\n', '  DIM t\n'), 5];
  const bigVals = (k) => Array.from({ length: 901 }, (_, i) => ((i * 31 + k * 7) % 2001) - 1000).join(', ');
  HAND.big = [G(`DIM big(900), s\nTABLE b0\n  big = ${bigVals(0)}\n  s = 5\nENDTABLE\nTABLE b1\n  big = ${bigVals(1)}\nENDTABLE\nTABLE b2\n  big = 7\nENDTABLE\n`,
    '', '    t = t + 1\n    IF t = 1 THEN LOADTABLE b0 ENDIF\n    IF t = 2 THEN LOADTABLE b1 ENDIF\n    IF t = 3 THEN LOADTABLE b2 ENDIF\n    IF t = 4 THEN LOADTABLE b0 ENDIF\n', '  DIM t\n'), 6];
  const t256 = Array.from({ length: 256 }, (_, i) => `TABLE n${i}\n  a = ${i + 1000}\nENDTABLE\n`).join('');
  HAND.t256 = [G(`DIM a, b(1)\n${t256}`, '', '    t = t + 1\n    LOADTABLE t - 1\n    b(t MOD 2) = t\n', '  DIM t\n'), QUICK ? 40 : 262];
  const maps20 = Array.from({ length: 19 }, (_, i) => `MAP m${i} = "s${i}"\n`).join('');
  HAND.policy = [`${HEAD}${maps20}DIM big(900), n\nTABLE bt\n  big = ${bigVals(3)}\nENDTABLE\nTABLE bs\n  big = 4, 5, 6\nENDTABLE\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    n = n + 1\n    IF n = 1 THEN LOADMAP m3 ENDIF\n    IF n = 2 THEN LOADTABLE bt ENDIF\n    IF n = 3 THEN LOADMAP m7 AT 2, 2 ENDIF\n    IF n = 4 THEN LOADTABLE bs ENDIF\n    IF n = 5 THEN LOADMAP m18 ENDIF\n  ENDP\nENDSCENE\n`, 7, true, true];
  for (const [name, [src, ticks, screen, mustBank]] of Object.entries(HAND)) {
    if (!R || lacking(R).length) { skip_(`hand-written program ${name}`, `the v2 runtime lacks ${lacking(R).join(' ')} (slice T1 not built yet)`); continue; }
    const r = runBoth(R, src, ASSETS11, { ticks, v: 2, screen: !!screen, modes: mustBank ? [false] : [false, true] });
    if (mustBank) check_(`${name}: the policy (auto) banked a table by itself: the 19 maps and the 1,807-byte table do not fit mapped`, r.ok && r.normalBanked >= 1, `${r.normalBanked} banked in the normal build`);
    check_(`${name}: ${ticks} ticks equal to the interpreter, normal and bankAll (${r.ok ? `${r.tables} tables, ${r.banked.length} banked in the last build, ${r.normalBanked} banked by the policy` : ''}), the two builds equal on the whole variable block and the display files`, r.ok, r.detail);
  }
}

// =================================================================================================================
// 2 and 3. Random programs
// =================================================================================================================
/**
 * A random game with tables (a scene ring of 1..3 scenes). Returns {src, ticks, nScenes}. Game level: 2..4 scalars, 1..3 arrays (one may be 2-D), maybe a TIMER and a CONST or two; a scene: 1..3 scalars
 * and 0..2 arrays. Each scope gets 1..4 tables of 1..4 rows over the variables it sees, random order and value counts (values: small, negative, wrapped, CONST expressions). FRAME: a tick
 * counter, scribbles on variables, and at chosen ticks LOADTABLEs by name, by a variable index, by an expression, through a game-level PROC; a scene ring by ENTER.
 */
function genTables(seed, { prefix = '' } = {}) {
  const r = rng(seed * 7919 + 13);
  const R_ = (a, b) => ri(r, a, b);
  const nScenes = R_(1, 3);
  const consts = [['K1', R_(2, 9)], ['K2', -R_(10, 400)], ['K3', R_(100, 700)]].slice(0, R_(1, 3));
  const value = () => {
    const c = R_(0, 9);
    if (c < 4) return String(R_(0, 20));
    if (c === 4) return String(-R_(1, 99));
    if (c === 5) return pick(r, ['40000', '65535', '32768', '32767', '-32768', '-1']);
    if (c === 6) return `${pick(r, consts)[0]} * ${R_(1, 5)} - ${R_(0, 9)}`;
    if (c === 7) return pick(r, consts)[0];
    if (c === 8) return `${R_(100, 300)} MOD ${R_(2, 9)}`;
    return String(R_(-500, 500));
  };
  const mkScope = (tag, nScalar, nArr, timer) => {
    const items = [];
    for (let i = 0; i < nScalar; i++) items.push({ kind: 'v', name: `${tag}v${i}`, total: 1 });
    for (let i = 0; i < nArr; i++) {
      if (R_(0, 3) === 0) { const w = R_(1, 3), h = R_(1, 3); items.push({ kind: 'g', name: `${tag}g${i}`, dims: `${w}, ${h}`, total: (w + 1) * (h + 1) }); }
      else { const n = R_(1, 12); items.push({ kind: 'a', name: `${tag}a${i}`, dims: String(n), total: n + 1 }); }
    }
    if (timer) items.push({ kind: 't', name: `${tag}cd`, total: 1 });
    // shuffled declaration order, one to three per DIM line
    const order = items.slice().sort(() => r() - 0.5);
    const lines = [];
    for (let i = 0; i < order.length;) {
      const k = R_(1, 3), grp = order.slice(i, i + k);
      i += k;
      if (grp.every((x) => x.kind === 't')) lines.push(`TIMER ${grp.map((x) => x.name).join(', ')}`);
      else { const plain = grp.filter((x) => x.kind !== 't'), tm = grp.filter((x) => x.kind === 't'); if (plain.length) lines.push(`DIM ${plain.map((x) => (x.dims ? `${x.name}(${x.dims})` : x.name)).join(', ')}`); if (tm.length) lines.push(`TIMER ${tm.map((x) => x.name).join(', ')}`); }
    }
    return { items, decl: lines.map((l) => `${l}\n`).join('') };
  };
  const mkTable = (name, visible) => {
    const k = R_(1, Math.min(4, visible.length)), pool = visible.slice().sort(() => r() - 0.5).slice(0, k);
    const rows = pool.map((it) => {
      const nv = it.total === 1 ? 1 : R_(0, 3) === 0 ? it.total : R_(1, Math.min(it.total, 8));
      return `    ${it.name} = ${Array.from({ length: nv }, value).join(', ')}\n`;
    });
    return `  TABLE ${name}\n${rows.join('')}  ENDTABLE\n`;
  };
  const game = mkScope(`${prefix}g`, R_(2, 4), R_(1, 3), R_(0, 2) === 0);
  const nGameTabs = R_(1, 3);
  const gameTabs = Array.from({ length: nGameTabs }, (_, i) => `${prefix}tg${i}`);
  let src = `${HEAD}${consts.map(([n, v]) => `CONST ${n} = ${v}\n`).join('')}${game.decl}`;
  src += gameTabs.map((n) => mkTable(n, game.items).replace(/^ {2}/gm, '')).join('');
  src += `DIM ${prefix}ix\n`;
  src += `PROC ${prefix}gl(n)\n  LOADTABLE n\n  LOADTABLE ${gameTabs[0]}\nENDP\n`;
  const scenes = [];
  for (let s = 0; s < nScenes; s++) {
    const sc = mkScope(`${prefix}s${s}`, R_(1, 3), R_(0, 2), R_(0, 3) === 0);
    const nTabs = R_(0, 3);
    const tabs = Array.from({ length: nTabs }, (_, i) => `${prefix}ts${s}x${i}`);
    const visList = [...gameTabs, ...tabs];
    const visVars = [...game.items, ...sc.items];
    const tabSrc = tabs.map((n) => mkTable(n, visVars)).join('');
    const gv = pick(r, game.items.filter((x) => x.kind === 'v'));
    const sv = pick(r, [...sc.items.filter((x) => x.kind === 'v'), gv]);
    const arr = visVars.filter((x) => x.kind === 'a');
    const stmts = [];
    const nStm = R_(4, 9);
    for (let i = 0; i < nStm; i++) {
      const at = R_(1, 14), c = R_(0, 9);
      let body;
      if (c < 3 && visList.length) body = `LOADTABLE ${pick(r, visList)}`;
      else if (c === 3) body = `LOADTABLE ${R_(-1, visList.length)}`;
      else if (c === 4) body = `${prefix}ix = ${R_(-2, visList.length + 1)}\n      LOADTABLE ${prefix}ix`;
      else if (c === 5) body = `LOADTABLE ${prefix}cnt MOD ${visList.length + 2} - 1`;
      else if (c === 6) body = `CALL ${prefix}gl(${prefix}cnt MOD ${gameTabs.length + 2} - 1)`;
      else if (c === 7 && arr.length) { const a = pick(r, arr); body = `${a.name}(${prefix}cnt MOD ${a.total}) = ${prefix}cnt * ${R_(1, 5)}`; }
      else if (c === 8) body = `${sv.name} = ${sv.name} + ${R_(1, 50)}`;
      else body = `${gv.name} = ${R_(-30, 30)}`;
      stmts.push(`    IF ${prefix}cnt = ${at} THEN\n      ${body}\n    ENDIF\n`);
    }
    const ring = s < nScenes - 1 ? `    IF ${prefix}cnt = ${R_(8, 16)} THEN ENTER ${prefix}sc${s + 1} ENDIF\n` : (nScenes > 1 && R_(0, 1) ? `    IF ${prefix}cnt = ${R_(10, 18)} THEN ENTER ${prefix}sc0 ENDIF\n` : '');
    const initBody = R_(0, 1) && visList.length ? `    LOADTABLE ${pick(r, visList)}\n` : '';
    scenes.push(`SCENE ${prefix}sc${s}\n${sc.decl.replace(/^/gm, '  ')}  DIM ${prefix}cnt\n${tabSrc}  PROC INIT()\n${initBody}  ENDP\n  PROC FRAME()\n    ${prefix}cnt = ${prefix}cnt + 1\n${stmts.join('')}${ring}  ENDP\nENDSCENE\n`);
  }
  src += scenes.join('');
  return { src, ticks: QUICK ? 26 : 40, nScenes };
}
const randomSet = (name, R, v, wrap, n, ticksOf) => {
  if (!R || lacking(R).length) { skip_(name, `the v${v} runtime lacks ${lacking(R).join(' ')} (slice T1 not built yet)`); return; }
  let bad = 0, why = '', first = '', tabs = 0, bankedTabs = 0, auto = 0;
  for (let seed = 1; seed <= n; seed++) {
    const g = genTables(seed);
    const src = wrap(g.src);
    const cc = compile(src, { runtime: R.rt, image: R.img, assets: ASSETS11 });
    if (cc.errors.length) { bad++; why ||= `seed ${seed}: compile: ${errText(cc)}`; first ||= src; continue; }
    const r = runBoth(R, src, ASSETS11, { ticks: ticksOf(g), v, screen: v === 2 });
    if (!r.ok) { bad++; why ||= `seed ${seed}: ${r.detail}`; first ||= src; } else { tabs += r.tables; bankedTabs += r.banked.filter((b) => b.kind === 'table').length; auto += r.normalBanked; }
  }
  check_(`${name}: ${n} random programs, equal to the interpreter on every variable and array at every tick, normal and bankAll`, bad === 0, `${bad} failed; ${why}`);
  info(`${tabs} tables built, ${bankedTabs} banked in the bankAll builds`);
  if (bad && first) console.log(`  ---- first failing program:\n${first.split('\n').map((l) => '  | ' + l).join('\n')}`);
};
console.log('\n2. Random programs (v2): scenes, scopes, arrays, TIMERs, every form of LOADTABLE');
randomSet('v2', RT[2], 2, (s) => s, QUICK ? 12 : 120, (g) => g.ticks);

console.log('\n3. The same random programs in a WINDOW game (v3) and a VIEW3D game (v4)');
const inWindow = (s) => s.replace('TILESET ts = "ts"\n', 'TILESET ts = "ts"\nSPRITE ship = "orb"\nMAP level = "lv"\nWINDOW level\n');
const inView = (s) => s.replace('TILESET ts = "ts"\n', 'TILESET ts = "ts"\nSPRITE ship = "orb"\nMAP level = "maze"\nVIEW3D level\n');
randomSet('v3', RT[3], 3, inWindow, QUICK ? 4 : 30, (g) => Math.min(g.ticks, QUICK ? 20 : 30));
randomSet('v4', RT[4], 4, inView, QUICK ? 4 : 30, (g) => Math.min(g.ticks, QUICK ? 20 : 30));

// =================================================================================================================
// 4. Negative controls
// =================================================================================================================
console.log('\n4. Negative controls: the comparisons see a damaged record, an unloaded table and a wrong index');
{
  const R = RT[2];
  if (!R || lacking(R).length) skip_('negative controls', `the v2 runtime lacks ${lacking(R).join(' ')}`);
  else {
    const src = `${HEAD}DIM a(3), b\nTABLE one\n  a = 1, 2, 3, 4\n  b = 9\nENDTABLE\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    LOADTABLE one\n  ENDP\nENDSCENE\n`;
    const want = interpret(parse(src).ast, { version: 2, ticks: 4, assets: ASSETS11, maxSteps: 1e9, border0: R.rt.constants?.BORDER_COLOUR ?? 1 });
    const ok = compile(src, { runtime: R.rt, image: R.img, assets: ASSETS11, bankAll: true });
    const run = (res) => vsInterp(runFramed(R, res, { ticks: 4 }), want, { screen: false });
    check_('control: the undamaged banked build equals the interpreter', ok.errors.length === 0 && run(ok) === null, errText(ok));
    const off = 9 + 2 * 8192;                                  // chunks 0, 1, 2: the window (chunk 2) is the third in the file
    const flip = (at, mask) => { const res = { ...ok, dck: ok.dck.slice() }; res.dck[off + at] ^= mask; return res; };
    check_('control: a changed value byte in the banked record is seen (the first value of a)', run(flip(1 + 4, 0x10)) !== null);
    check_('control: a changed destination in the banked record is seen (the run writes elsewhere)', run(flip(1, 0x02)) !== null);
    check_('control: a shortened run (len 10 becomes 2) leaves the other elements stale and is seen', run(flip(3, 0x08)) !== null);
    const mappedBad = compile(src.replace('a = 1, 2, 3, 4', 'a = 1, 2, 3, 5'), { runtime: R.rt, image: R.img, assets: ASSETS11 });
    check_('control: a program that differs by one table value is seen against the interpreter of the original', run(mappedBad) !== null);
    const idxSrc = `${HEAD}DIM a, k\nTABLE t0\n  a = 1\nENDTABLE\nTABLE t1\n  a = 2\nENDTABLE\nSCENE s\n  PROC INIT()\n    k = 1\n  ENDP\n  PROC FRAME()\n    LOADTABLE k\n  ENDP\nENDSCENE\n`;
    const idxWant = interpret(parse(idxSrc).ast, { version: 2, ticks: 3, assets: ASSETS11, maxSteps: 1e9, border0: R.rt.constants?.BORDER_COLOUR ?? 1 });
    const idxRes = compile(idxSrc.replace('k = 1', 'k = 0'), { runtime: R.rt, image: R.img, assets: ASSETS11 });
    check_('control: the wrong index (0 for 1) is seen', vsInterp(runFramed(R, idxRes, { ticks: 3 }), idxWant, { screen: false }) !== null);
  }
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}: ${passed} checks passed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed === 0 ? 0 : 1);
