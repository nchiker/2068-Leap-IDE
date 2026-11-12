"use strict";
// arcade-m4.mjs -- tests for milestone M4a of the Leap Arcade compiler (runtime API v2: arrays, sprite pools and instances, KEYDOWN, phases).
//   node tests/arcade-m4.mjs                  (all sections; R needs arcade/build/v2/runtime.json, which the runtime engineer builds)
//   ARCADE_QUICK=1 node tests/arcade-m4.mjs   (fewer fuzz games and ticks)
//
// Sections
//   1  parser and checker: positive and negative tests for every new construct
//   2  code generator and linker: the v2 header, descriptors (8 bytes, shared assets, phases), the instance table, limits, and
//      what v0 / v1 runtimes still say
//   3  array semantics (hand-written expectations, checked on the interpreter AND the compiled code on the mock)
//   4  array fuzz: random programs with nested index expressions, arrays as loop bounds, indices of other arrays, PROC / DEF FN
//      arguments, out-of-range reads and writes, compiled code on the mock runtime vs the reference interpreter
//   5  instances: pools, instance references, bounds, HIT between instances; pool games (player + bullets + enemies + shots)
//   6  KEYDOWN with a scripted key set
//   7  costs: T-states of one array read and one array write
//   8  the example arcade/examples/shooter.arc: compiles, then a scripted run of >= 1200 ticks (fire, movement, dying, game over,
//      restart) compared with the interpreter
//   R  the real v2 runtime (arcade/build/v2/runtime.json): the same fuzz, pool games, KEYDOWN and shooter, booted from the DCK on
//      a stock TS2068, plus the measured cost of the shooter's ticks
//
// ── Decisions where docs/ARCADE_RUNTIME_API_V2.md is silent (compiler, interpreter and the mock agree on these) ─────────────────
//   - Arrays: `a(0)..a(n)` are n + 1 16-bit slots in GAME_VARS (declaration order, scalars and arrays share the slot sequence).
//     An index outside 0..n (unsigned compare, so a negative index is outside) reads 0 and a write is ignored. The index is evaluated
//     first, then the value (so RND in both is consumed in that order); the value is evaluated even when the write is ignored.
//   - DIM size limit: 1..1000 with a v2 runtime (the checker is given the runtime version); the checker's general limit stays 16383.
//   - Instances: `SPRITE s = "a"` is one instance, `SPRITE s(n) = "a"` n consecutive ones. A bare pool name is instance 0. `s(i)` on a
//     single sprite is bounds-checked against 1. SHOW / HIDE with an index outside the pool do nothing, HIT gives 0 (x and y of SHOW
//     are still evaluated: index, x, y). A literal index outside the pool / array is a WARNING at build time.
//   - At most 16 instances in all and 8 different assets (the asset OBJECT: two declarations of the same asset share one descriptor;
//     two names for the same JSON asset object count once). Draw order = declaration order; a pool's instances are consecutive.
//   - The sprite descriptor's width byte stays 16 (as in v0 / v1; the pre-shifted data has 16-bit rows); `phases` comes from the
//     asset's "phases" field (1, 2, 4, 8; default 8). SPR_TAB positions are the clamped SHOW values, never rounded; only the picture
//     model rounds x down to a multiple of 8 / phases.
//   - KEYDOWN(c): c is folded at build time (a number 0..255 or a one-character string, letters upper-cased); a key the runtime does
//     not scan (not A-Z, 0-9, 32, 13, 1, 2) gives a WARNING and is never held.
//   - The contract's "bullets 6, enemies 8, shots 4 and the player" are 19 instances, more than the 16 the runtime has: the pool game of
//     section 5 runs with 19 on a mock whose cap is raised to 24, and with 16 (4 bullets, 8 enemies, 3 shots, 1 ship) on the real runtime.
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret, roundX } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { convertSfx, convertTileset, convertMap } from '../src/lang/arcade/arcade-assets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TSRUN = join(ROOT, 'tsrun');
const M_ = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
const Z_ = await import(pathToFileURL(join(TSRUN, 'z80.js')).href);

let passed = 0, failed = 0, notes = 0;
const check_ = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  ok ? passed++ : failed++;
  return ok;
};
const note = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'NOTE'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  ok ? passed++ : notes++;
};
const QUICK = !!process.env.ARCADE_QUICK;
const TMP = mkdtempSync(join(tmpdir(), 'arcade-m4-'));
const hex = (v, w = 4) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');
const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;

/** Seeded PRNG (mulberry32) so failures reproduce. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function sjasm(asmText, name) {
  const src = join(TMP, name + '.asm');
  writeFileSync(src, asmText);
  const bin = join(TMP, name + '.bin'), sym = join(TMP, name + '.sym');
  try { execFileSync('sjasmplus', ['--nologo', `--raw=${bin}`, `--sym=${sym}`, src], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { throw new Error('sjasmplus failed:\n' + (e.stdout || '') + (e.stderr || '')); }
  const syms = {};
  for (const line of readFileSync(sym, 'utf8').split('\n')) {
    const m = line.match(/^(\S+):\s+EQU\s+0x([0-9A-Fa-f]+)/);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  return { bytes: new Uint8Array(readFileSync(bin)), syms };
}

// =================================================================================================================
// Assets used by the tests
// =================================================================================================================
const ROWS = (h, bits, mask = bits) => Array.from({ length: h }, () => ({ bits, mask }));
const SPR = {
  ball: { w: 8, h: 8, rows: ROWS(8, 'FF') },
  bat: { w: 16, h: 8, rows: ROWS(8, 'FFFF') },
  big: { w: 16, h: 16, rows: ROWS(16, 'FFFF'), hot: [4, 4, 8, 8] },
  fine: { w: 16, h: 16, rows: ROWS(16, 'FFFF'), phases: 4 },
  coarse: { w: 8, h: 8, rows: ROWS(8, 'FF'), phases: 1 },
  odd: { w: 16, h: 16, rows: ROWS(16, 'FFFF'), phases: 3 },
};
for (const k of ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9']) SPR[k] = { w: 8, h: 8, rows: ROWS(8, k === 'a9' ? '81' : 'FF') };
const sfxTicks = (n, t0, dt, v0, dv, mix = 6, noise = 0) => Array.from({ length: n }, (_, k) => ({ tone: t0 + dt * k, vol: Math.max(0, Math.min(15, v0 + dv * k)), noise, mix }));
const SFX = { beep: { ticks: sfxTicks(12, 200, 20, 15, -1) }, zap: { ticks: sfxTicks(5, 50, 100, 12, 0, 5, 9) } };
const mkTile = (i) => ({ rows: Array.from({ length: 8 }, (_, y) => ({ bits: ((0x81 << (y & 1)) ^ (i * 0x11)) & 0xFF, ink: (i + 1) % 8, paper: (i * 3) % 8, bright: i % 2 })), flags: 0 });
const ASSETS = { sprites: SPR, tilesets: { ts: { tiles: Array.from({ length: 5 }, (_, i) => mkTile(i)) } }, sfx: SFX, maps: {} };

// =================================================================================================================
// The mock runtime (v2): the v0 arithmetic in Z80 (taken from tests/arcade-compile.mjs), everything else a JavaScript trap written
// from docs/ARCADE_RUNTIME_API_V1.md and _V2.md (not from the interpreter)
// =================================================================================================================
const MOCK_BASE_ASM = (() => {
  const t = readFileSync(join(HERE, 'arcade-compile.mjs'), 'utf8');
  const a = t.indexOf('const MOCK_ASM = `'), b = t.indexOf('`;', a);
  if (a < 0 || b < 0) throw new Error('cannot find MOCK_ASM in tests/arcade-compile.mjs');
  return t.slice(a + 'const MOCK_ASM = `'.length, b);
})();
const MOCK_BUILD = sjasm(MOCK_BASE_ASM, 'mockrt');
const TRAPS = { RT_AT: 0xC400, RT_PRINTS: 0xC410, RT_PRINTN: 0xC420, RT_PRINTC: 0xC430, RT_INK: 0xC440, RT_PAPER: 0xC450, RT_BRIGHT: 0xC460, RT_CLS: 0xC470,
  RT_TILE: 0xC480, RT_TILEAT: 0xC490, RT_HIT: 0xC4A0, RT_PLAY: 0xC4B0, RT_SILENCE: 0xC4C0, RT_SHOW: 0xC4D0, RT_HIDE: 0xC4E0, RT_KEYDOWN: 0xC4F0 };
const MOCK_ADDR = { CELL_TILE: 0xD000, CELL_ATTR: 0xD300, AY_SHADOW: 0xD600, SPR_TAB: 0xD700, V_TEXT_ATTR: 0xE040, V_CUR_ROW: 0xE041, V_CUR_COL: 0xE042, V_SFX_ACTIVE: 0xE043, RT_SEED: 0xE030 };
const mockImage = new Uint8Array(65536);
mockImage.set(MOCK_BUILD.bytes, 0xC000);
for (const a of Object.values(TRAPS)) mockImage[a] = 0xC9;
const MOCK_CAP = 24;                                        // the mock's SPR_TAB has room for 24 entries (the real one has 16)
const mockRuntime = (version = 2, cst = {}) => ({
  version,
  symbols: {
    RT_MUL: MOCK_BUILD.syms.RT_MUL, RT_DIV: MOCK_BUILD.syms.RT_DIV, RT_MOD: MOCK_BUILD.syms.RT_MOD, RT_RND: MOCK_BUILD.syms.RT_RND, RT_STICK: MOCK_BUILD.syms.RT_STICK,
    V_TICKS: 0xE000, ...TRAPS, ...MOCK_ADDR,
  },
  constants: { GAME_BASE: 0x8000, GAME_VARS_BASE: 0xE100, GAME_VARS_LIMIT: 0xEFFF, MAX_SPRITES: 16, MAX_ASSETS: 8, ...cst },
});
const compileM = (src, assets = ASSETS, rt = mockRuntime(2)) => compile(src, { runtime: rt, image: mockImage, assets });
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');

const HAVE_TRAP = new Set(Object.values(TRAPS));
/** Held keys at tick t -> Set of codes. `keys` is a function (tick) -> iterable of codes. */
function runMock(res, { ticks, stick = null, keys = null }) {
  const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  m.ram.set(res.memory.subarray(0x4000), 0x4000);
  m.ram.fill(0xA5, 0xE100, 0xF000);                    // variables start as garbage: the init stub clears them
  m.ram.fill(0, 0xE000, 0xE100);
  const A = MOCK_ADDR, ram = m.ram, cpu = m.cpu;
  const rd16 = (a) => ram[a] | (ram[a + 1] << 8);
  ram[0xE030] = 12345 & 0xFF; ram[0xE031] = 12345 >> 8;
  const frameDiv = ram[0x8004];
  ram.fill(32, A.CELL_TILE, A.CELL_TILE + 768); ram.fill(0x38, A.CELL_ATTR, A.CELL_ATTR + 768);
  ram[A.V_TEXT_ATTR] = 0x38;
  const tilesetPtr = rd16(0x8008), sfxTable = rd16(0x800A), mapPtr = rd16(0x800C);
  const descTab = rd16(0x8006), instTab = rd16(0x800E);
  const ninst = ram[instTab];
  const tileAttrOf = (t) => ram[tilesetPtr + 1 + t * 9 + 8];
  if (mapPtr) for (let i = 0; i < 768; i++) { const v = ram[mapPtr + i]; ram[A.CELL_TILE + i] = v; if (v & 0x80) ram[A.CELL_ATTR + i] = tileAttrOf(v & 0x7F); }
  const putChar = (code) => {
    const row = ram[A.V_CUR_ROW], col = ram[A.V_CUR_COL], i = row * 32 + col;
    ram[A.CELL_TILE + i] = code & 0x7F; ram[A.CELL_ATTR + i] = ram[A.V_TEXT_ATTR];
    let c = col + 1, r = row;
    if (c === 32) { c = 0; r = (r + 1) % 24; }
    ram[A.V_CUR_COL] = c; ram[A.V_CUR_ROW] = r;
  };
  let sfx = { index: -1, pos: 0 };
  const sfxRecords = (idx) => { const p = rd16(sfxTable + 1 + 2 * idx); let n = 0; while (ram[p + 4 * n + 1] !== 0xFF) n++; return { p, n }; };
  const ay = (r, v) => { ram[A.AY_SHADOW + r] = v; };
  const refresh = () => {
    if (!ram[A.V_SFX_ACTIVE]) return;
    const { p, n } = sfxRecords(sfx.index);
    if (sfx.pos >= n) { ram[A.V_SFX_ACTIVE] = 0; ay(8, 0); return; }
    const rec = p + 4 * sfx.pos++;
    ay(0, ram[rec]); ay(1, ram[rec + 1] & 0x0F); ay(8, ram[rec + 1] >> 4); ay(6, ram[rec + 2] & 0x1F); ay(7, 0x36 | ((ram[rec + 2] >> 5) & 1) | (((ram[rec + 2] >> 6) & 1) << 3));
  };
  const hl = () => (cpu.h << 8) | cpu.l;
  const setHL = (v) => { cpu.h = (v >> 8) & 0xFF; cpu.l = v & 0xFF; };
  let held = new Set();
  const handlers = {
    [TRAPS.RT_AT]() { ram[A.V_CUR_ROW] = Math.min(cpu.b, 23); ram[A.V_CUR_COL] = Math.min(cpu.c, 31); },
    [TRAPS.RT_PRINTS]() { const p = hl(), n = ram[p]; for (let k = 1; k <= n; k++) putChar(ram[p + k]); },
    [TRAPS.RT_PRINTN]() { for (const ch of String(s16(hl()))) putChar(ch.charCodeAt(0)); },
    [TRAPS.RT_PRINTC]() { putChar(cpu.a); },
    [TRAPS.RT_INK]() { ram[A.V_TEXT_ATTR] = (ram[A.V_TEXT_ATTR] & ~7) | (cpu.a & 7); },
    [TRAPS.RT_PAPER]() { ram[A.V_TEXT_ATTR] = (ram[A.V_TEXT_ATTR] & ~0x38) | ((cpu.a & 7) << 3); },
    [TRAPS.RT_BRIGHT]() { ram[A.V_TEXT_ATTR] = (ram[A.V_TEXT_ATTR] & ~0x40) | ((cpu.a & 1) << 6); },
    [TRAPS.RT_CLS]() { ram.fill(32, A.CELL_TILE, A.CELL_TILE + 768); ram.fill(((ram[A.V_TEXT_ATTR] >> 3) & 7) << 3, A.CELL_ATTR, A.CELL_ATTR + 768); ram[A.V_CUR_ROW] = 0; ram[A.V_CUR_COL] = 0; },
    [TRAPS.RT_TILE]() { const t = cpu.a, row = cpu.b, col = cpu.c; if (row > 23 || col > 31) return; const i = row * 32 + col; ram[A.CELL_TILE + i] = 128 + t; ram[A.CELL_ATTR + i] = tileAttrOf(t); },
    [TRAPS.RT_TILEAT]() { const row = cpu.b, col = cpu.c; if (row > 23 || col > 31) { setHL(0xFFFF); return; } const v = ram[A.CELL_TILE + row * 32 + col]; setHL(v & 0x80 ? v & 0x7F : 0xFFFF); },
    [TRAPS.RT_SHOW]() {
      const i = cpu.a; if (i >= ninst) return;
      const x = Math.min(Math.max(s16((cpu.b << 8) | cpu.c), 0), 239), y = Math.min(Math.max(s16((cpu.d << 8) | cpu.e), 0), 176);
      const e = A.SPR_TAB + 6 * i;
      ram[e] = 1; ram[e + 1] = ram[instTab + 1 + i]; ram[e + 2] = x & 255; ram[e + 3] = x >> 8; ram[e + 4] = y & 255; ram[e + 5] = y >> 8;
    },
    [TRAPS.RT_HIDE]() { const i = cpu.a; if (i < ninst) ram[A.SPR_TAB + 6 * i] = 0; },
    [TRAPS.RT_HIT]() {
      const a = cpu.a, b = cpu.e;
      if (a >= ninst || b >= ninst) { setHL(0); return; }
      const sp = (i) => ({ vis: ram[A.SPR_TAB + 6 * i], x: rd16(A.SPR_TAB + 6 * i + 2), y: rd16(A.SPR_TAB + 6 * i + 4), hot: [0, 1, 2, 3].map((k) => ram[rd16(descTab + 8 * ram[instTab + 1 + i] + 4) + k]) });
      const A_ = sp(a), B_ = sp(b);
      if (!A_.vis || !B_.vis) { setHL(0); return; }
      const [ahx, ahy, ahw, ahh] = A_.hot, [bhx, bhy, bhw, bhh] = B_.hot;
      const al = A_.x + ahx, at = A_.y + ahy, bl = B_.x + bhx, bt = B_.y + bhy;
      setHL(al < bl + bhw && bl < al + ahw && at < bt + bhh && bt < at + ahh ? 1 : 0);
    },
    [TRAPS.RT_KEYDOWN]() { setHL(held.has(cpu.a) ? 1 : 0); },
    [TRAPS.RT_PLAY]() { if (cpu.a < ram[sfxTable]) { sfx = { index: cpu.a, pos: 0 }; ram[A.V_SFX_ACTIVE] = 1; } },
    [TRAPS.RT_SILENCE]() { ram[A.V_SFX_ACTIVE] = 0; ay(8, 0); },
  };
  const SENT = 0xFFF0; ram[SENT] = 0x76;
  const call = (addr) => {
    cpu.sp = 0xFF00 - 2; ram[cpu.sp] = SENT & 0xFF; ram[cpu.sp + 1] = SENT >> 8;
    cpu.pc = addr; cpu.halted = false; cpu.iff1 = false; cpu.iff2 = false; cpu.eiDelay = false;
    let n = 0;
    while (cpu.pc !== SENT) {
      const h = handlers[cpu.pc];
      if (h && HAVE_TRAP.has(cpu.pc)) h();
      Z_.runZ80(cpu, m.bus, 1, m);
      if (++n > 6_000_000) throw new Error('runaway code');
    }
  };
  const nInstSnap = Math.max(ninst, 4);
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    arrays: Object.fromEntries(Object.entries(res.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))])),
    sprites: Array.from({ length: nInstSnap }, (_, i) => ({ visible: ram[A.SPR_TAB + 6 * i], x: rd16(A.SPR_TAB + 6 * i + 2), y: rd16(A.SPR_TAB + 6 * i + 4) })),
    cells: ram.slice(A.CELL_TILE, A.CELL_TILE + 768), attrs: ram.slice(A.CELL_ATTR, A.CELL_ATTR + 768),
    cursor: { row: ram[A.V_CUR_ROW], col: ram[A.V_CUR_COL] }, textAttr: ram[A.V_TEXT_ATTR],
    sfxActive: ram[A.V_SFX_ACTIVE], ay: ram.slice(A.AY_SHADOW, A.AY_SHADOW + 16),
  });
  const out = { init: null, ticks: [], tstates: [] };
  call(res.map.entries.init);
  out.init = snap();
  for (let t = 1; t <= ticks; t++) {
    for (let k = 0; k < frameDiv; k++) refresh();
    const sv = stick ? stick(t) : 0;
    ram[0xE034] = typeof sv === 'number' ? sv : (sv[1] | 0); ram[0xE035] = typeof sv === 'number' ? 0 : (sv[2] | 0);
    held = new Set(keys ? keys(t) : []);
    const t0 = m.tstates;
    call(res.map.entries.frame);
    out.tstates.push(m.tstates - t0);
    out.ticks.push(snap());
  }
  return out;
}

/** Compare one sampled tick with the interpreter's record; null or a description of the first difference. */
function diffTick(label, g, w, ctx) {
  for (const [k, v] of Object.entries(w.vars)) if (g.vars[k] !== v) return `${label}: variable ${k} = ${g.vars[k]}, interpreter ${v}`;
  for (const [k, arr] of Object.entries(w.arrays ?? {})) {
    const got = g.arrays[k];
    if (!got) return `${label}: array ${k} is missing in the compiled game`;
    for (let i = 0; i < arr.length; i++) if (got[i] !== arr[i]) return `${label}: ${k}(${i}) = ${got[i]}, interpreter ${arr[i]}`;
  }
  const nSpr = Math.min(g.sprites.length, w.sprites.length);
  for (let i = 0; i < nSpr; i++) {
    const a = g.sprites[i], b = w.sprites[i];
    if (a.visible !== b.visible || (b.visible && (a.x !== b.x || a.y !== b.y))) return `${label}: instance ${i} = ${JSON.stringify(a)}, interpreter ${JSON.stringify(b)}`;
  }
  if (!ctx.skip.has('cells')) for (let i = 0; i < 768; i++) {
    if (g.cells[i] !== w.cells[i]) return `${label}: cell (row ${(i / 32) | 0}, col ${i % 32}) = ${g.cells[i]}, interpreter ${w.cells[i]}`;
  }
  if (!ctx.skip.has('attrs')) for (let i = 0; i < 768; i++) {
    if (g.attrs[i] !== w.attrs[i]) return `${label}: attribute (row ${(i / 32) | 0}, col ${i % 32}) = $${g.attrs[i].toString(16)}, interpreter $${w.attrs[i].toString(16)}`;
  }
  if (!ctx.skip.has('cursor') && (g.cursor.row !== w.cursor.row || g.cursor.col !== w.cursor.col)) return `${label}: cursor = ${g.cursor.row},${g.cursor.col}, interpreter ${w.cursor.row},${w.cursor.col}`;
  if (!ctx.skip.has('cursor') && g.textAttr !== w.textAttr) return `${label}: V_TEXT_ATTR = $${g.textAttr.toString(16)}, interpreter $${w.textAttr.toString(16)}`;
  if (!ctx.skip.has('sound')) {
    const N = w.sfx.index >= 0 ? ctx.sfxLens[w.sfx.index] : -1;
    const boundary = w.sfx.index >= 0 && w.sfx.played === N && w.sfx.active;      // a runtime may stop one refresh early: not compared
    if (!boundary && g.sfxActive !== (w.sfx.active ? 1 : 0)) return `${label}: V_SFX_ACTIVE = ${g.sfxActive}, interpreter ${w.sfx.active ? 1 : 0} (effect ${w.sfx.index}, ${w.sfx.played} refreshes played)`;
    if (g.ay && !boundary && w.sfx.rec >= 0) {
      const a = ctx.sfxBytes[w.sfx.index], r = w.sfx.rec;
      const want = [[0, a[4 * r]], [1, a[4 * r + 1] & 15], [8, a[4 * r + 1] >> 4], [6, a[4 * r + 2] & 31], [7, (a[4 * r + 2] >> 5) & 3]];
      const msk = { 0: 255, 1: 15, 8: 15, 6: 31, 7: 3 };
      const val = (reg) => (reg === 7 ? (g.ay[7] & 1) | (((g.ay[7] >> 3) & 1) << 1) : g.ay[reg] & msk[reg]);
      for (const [reg, v] of want) if (val(reg) !== v) return `${label}: AY_SHADOW[${reg}] = ${g.ay[reg]}, want ${v} (record ${r} of effect ${w.sfx.index})`;
    }
  }
  return null;
}
function diffRun(got, want, ctx) {
  let d = got.init && want.init ? diffTick('after INIT', got.init, want.init, ctx) : null;
  if (d) return d;
  for (let t = 0; t < want.ticks.length; t++) { d = diffTick(`tick ${t + 1}`, got.ticks[t], want.ticks[t], ctx); if (d) return d; }
  return null;
}
function ctxFor(src, assets, skip = [], extra = {}) {
  const p = parse(src).ast;
  const sfxLens = [], sfxBytes = [];
  for (const a of p.assets) if (a.kind === 'SFX') { const c = convertSfx(assets.sfx[a.asset]); sfxLens.push(c.records); sfxBytes.push(c.bytes); }
  const tsAsset = p.assets.find((a) => a.kind === 'TILESET');
  return { skip: new Set(skip), sfxLens, sfxBytes, tileBytes: tsAsset ? convertTileset(assets.tilesets[tsAsset.asset]).bytes : new Uint8Array(0), ...extra };
}
/** Programs that section R also runs on the real v2 runtime: {name, src, ticks, assets, keys, stick, skip}. */
const REAL = [];
let shooterCosts = null;
/** The reference interpreter for the v2 semantics. */
const interpV2 = (src, ticks, opts = {}) => interpret(parse(src).ast, { version: 2, ticks, assets: ASSETS, maxSteps: 60_000_000, ...opts });

// =================================================================================================================
// 1. Parser and checker
// =================================================================================================================
console.log('1. Parser and checker: arrays, sprite pools, instance references, KEYDOWN');
const prog = (body, top = '', decl = 'DIM v, w, a(10), b(3)') => `GAME "t"\nSPRITE ball = "ball"\nSPRITE bat = "bat"\nSPRITE pool(5) = "big"\nSFX snd = "beep"\n${top}SCENE s\n  ${decl}\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n${body}\n  ENDP\nENDSCENE\n`;
const BODY_LINE = 10;
const diags = (body, top, decl, version = 2) => { const p = parse(prog(body, top, decl)); return [...p.errors, ...check(p.ast, { version })]; };
const errs = (body, top, decl, version) => diags(body, top, decl, version).filter((d) => d.severity === 'error');
const warns = (body, top, decl, version) => diags(body, top, decl, version).filter((d) => d.severity === 'warning');
const stmtsOf = (body) => parse(prog(body)).ast.scenes[0].procs.find((p) => p.name.toUpperCase() === 'FRAME').body;
const msgs = (list) => list.map((d) => d.message).join(' | ');
const ok0 = (name, body, top, decl) => { const e = errs(body, top, decl); check_(name, e.length === 0, msgs(e)); };
const bad = (name, body, rx, top, decl, version) => { const e = errs(body, top, decl, version); check_(name, e.length >= 1 && rx.test(e[0].message) && e[0].line >= 1, msgs(e) || 'no error'); };
const warn1 = (name, body, rx, top, decl) => { const e = errs(body, top, decl), w = warns(body, top, decl); check_(name, e.length === 0 && w.some((d) => rx.test(d.message)), msgs(e) + ' || ' + msgs(w)); };
{
  ok0('array element as an rvalue and an lvalue', '    a(1) = 5\n    v = a(2) + b(0)');
  ok0('index expressions: nested, another array, an arithmetic expression', '    v = a(b(a(1) MOD 4) + 1)\n    a(v * 2 - w) = a(a(a(0)))');
  ok0('array elements as FOR bounds and STEP', '    FOR v = a(0) TO a(1) STEP b(1)\n    NEXT v');
  ok0('array elements as PROC and DEF FN arguments', '    CALL p(a(3))\n    v = FN f(b(2))', '', 'DIM v, w, a(10), b(3)\n  PROC p(q):\n    a(q) = q\n  ENDP\n  DEF FN f(x) = a(x) + 1');
  ok0('array elements in conditions, SELECT and PRINT', '    IF a(1) > b(2) THEN\n      v = 1\n    ENDIF\n    SELECT CASE a(2)\n      CASE b(0), 7\n        v = 2\n    ENDSEL\n    PRINT a(0); b(1)');
  ok0('DIM a(1000) is the largest array of a v2 runtime', '    a(1000) = 1', '', 'DIM a(1000)');
  ok0('sprite pool declaration and instance references', '    SHOW pool(2) AT 1, 2\n    HIDE pool(v)\n    IF HIT(pool(v), ball) OR HIT(bat, pool(w + 1)) OR HIT(pool(1), pool(2)) THEN\n      v = 1\n    ENDIF');
  ok0('a bare pool name and a bare single sprite are instances', '    SHOW pool AT 1, 2\n    HIDE ball\n    v = HIT(pool, bat)');
  ok0('a single sprite accepts name(0)', '    SHOW ball(0) AT 1, 2\n    HIDE bat(v)');
  ok0('KEYDOWN with a one-character string and a number', '    v = KEYDOWN("Q") + KEYDOWN(81) + KEYDOWN(" ") + KEYDOWN("q") + KEYDOWN(13) + KEYDOWN(1)');
  const p = stmtsOf('    SHOW pool(a(1)) AT 1, 2\n    HIDE pool(2)\n    a(3) = HIT(pool(1), ball)')[0];
  check_('parse: SHOW takes an Index node for pool(expr)', p.type === 'Show' && p.sprite.type === 'Index' && p.sprite.name === 'pool' && p.sprite.index.type === 'Index');
  const h = stmtsOf('    HIDE pool(2)\n    HIDE ball')[0];
  check_('parse: HIDE takes an Index node; a bare name stays an Ident', h.sprite.type === 'Index' && stmtsOf('    HIDE ball')[0].sprite.type === 'Ident');
  const dd = parse(prog('')).ast.assets.map((a) => `${a.name}:${a.count}`).join();
  check_('parse: SPRITE name(n) records the pool size (null for a single sprite)', dd === 'ball:null,bat:null,pool:5,snd:null', dd);
  const asg = stmtsOf('    a(1 + v) = b(2)')[0];
  check_('parse: an array element is an assignment target (Index)', asg.type === 'Assign' && asg.target.type === 'Index' && asg.target.name === 'a');

  bad('negative: an undeclared array', '    x(1) = 2', /not declared/);
  bad('negative: an undeclared array in an expression', '    v = x(1)', /array 'x' is not declared/);
  bad('negative: a scalar used as an array', '    v = w(1)', /'w' is not an array/);
  bad('negative: an array used as a scalar', '    v = a', /'a' is an array: write a\(index\)/);
  bad('negative: an array assigned as a scalar', '    a = 1', /'a' is an array/);
  bad('negative: a string index', '    v = a("x")', /an array index must be a number/);
  bad('negative: a string value in an element', '    a(1) = "x"', /cannot assign a string to a, which holds a number/);
  bad('negative: two indices', '    v = a(1, 2)', /one dimension/);
  bad('negative: DIM a(0)', '', /out of range \(1\.\.1000\)/, '', 'DIM a(0)');
  bad('negative: DIM a(1001) with a v2 runtime', '', /out of range \(1\.\.1000\)/, '', 'DIM a(1001)');
  bad('negative: a variable DIM size', '', /literal number/, '', 'DIM n, a(n)');
  check_('DIM a(1001) is only refused when the version is 2 (the checker\'s own limit stays 16383)', errs('', '', 'DIM a(1001)', 0).length === 0 && errs('', '', 'DIM a(16384)', 0).length === 1);
  bad('negative: a sprite used as an array in an expression', '    v = pool(1)', /'pool' is a SPRITE, not an array/);
  bad('negative: an sfx used as an instance', '    SHOW snd(1) AT 1, 2', /'snd' is a SFX, not a SPRITE/);
  bad('negative: SHOW of an undeclared name', '    SHOW zz(1) AT 1, 2', /'zz' is not a declared SPRITE/);
  bad('negative: SHOW of a variable element', '    SHOW a(1) AT 1, 2', /'a' is a variable, not a SPRITE/);
  bad('negative: HIT with a number', '    v = HIT(1, ball)', /expected a sprite name/);
  bad('negative: HIT with an expression index of the wrong type', '    v = HIT(pool("x"), ball)', /an instance index must be a number/);
  bad('negative: HIDE with two indices', '    HIDE pool(1, 2)', /arrays have one dimension/);
  bad('negative: SPRITE pool size 0', '', /pool of 0 sprites is out of range \(1\.\.16\)/, 'SPRITE zero(0) = "ball"\n');
  bad('negative: SPRITE pool size 17', '', /pool of 17 sprites is out of range \(1\.\.16\)/, 'SPRITE big(17) = "ball"\n');
  bad('negative: SPRITE pool size that is not a literal', '', /pool size must be a literal number/, 'SPRITE nn(v) = "ball"\n');
  bad('negative: SPRITE with two pool sizes', '', /one size/, 'SPRITE two(2, 3) = "ball"\n');
  bad('negative: SFX with a pool size', '', /only a SPRITE can have a pool size/, 'SFX sn(2) = "beep"\n');
  bad('negative: a pool name used twice', '', /already declared/, 'SPRITE pool(2) = "ball"\n');
  bad('negative: KEYDOWN of a variable', '    v = KEYDOWN(w)', /written out/);
  bad('negative: KEYDOWN of an expression', '    v = KEYDOWN(80 + 1)', /written out/);
  bad('negative: KEYDOWN of a two-character string', '    v = KEYDOWN("QA")', /one-character string/);
  bad('negative: KEYDOWN of the empty string', '    v = KEYDOWN("")', /one-character string/);
  bad('negative: KEYDOWN code 256', '    v = KEYDOWN(256)', /must be 0\.\.255/);
  bad('negative: KEYDOWN code -1', '    v = KEYDOWN(-1)', /must be 0\.\.255/);
  bad('negative: KEYDOWN without an argument', '    v = KEYDOWN()', /takes 1 argument/);
  warn1('warning: KEYDOWN of a key the runtime does not scan', '    v = KEYDOWN(99)', /never held/);
  warn1('warning: KEYDOWN(";")', '    v = KEYDOWN(";")', /never held/);
  warn1('warning: a literal index past the end of an array', '    v = a(11)\n    a(-1) = 1', /outside a\(0\.\.10\)/);
  warn1('warning: a literal index outside a pool', '    SHOW pool(5) AT 1, 2', /instance 5 is outside pool\(0\.\.4\)/);
  warn1('warning: a literal index on a single sprite other than 0', '    HIDE ball(1)', /a single sprite: only 0/);
  check_('no warning for a literal index in range', warns('    v = a(10)\n    a(0) = 1\n    SHOW pool(4) AT 1, 2\n    HIDE ball(0)').filter((d) => /outside/.test(d.message)).length === 0);
}

// =================================================================================================================
// 2. Code generator and linker
// =================================================================================================================
console.log('\n2. Code generator and linker: the v2 image');
const GAME = (top, body, decl = 'DIM a, b') => `GAME "t"\nFRAMERATE 30\n${top}SCENE s\n  ${decl}\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n${body}\n  ENDP\nENDSCENE\n`;
{
  const src = GAME('SPRITE hero = "ball"\nSPRITE pl(3) = "big"\nSPRITE foe(2) = "fine"\nSPRITE twin = "ball"\nSPRITE tiny(2) = "coarse"\nTILESET ts = "ts"\nSFX snd = "beep"\n',
    '    SHOW pl(a) AT 1, 2\n    SHOW foe(1) AT 5, 6\n    a = HIT(hero, twin) + KEYDOWN("q")');
  const r = compileM(src);
  check_('compiles', r.errors.length === 0 && !!r.dck, errText(r));
  const mem = r.memory, rd = (a) => mem[a] | (mem[a + 1] << 8);
  const nAssets = mem[0x8005];
  check_('header: sprite_count = 4 assets (ball shared by hero and twin, big, fine, coarse), frame_div 2, sprite_table = $8010', nAssets === 4 && mem[0x8004] === 2 && rd(0x8006) === 0x8010, `assets ${nAssets}, table ${hex(rd(0x8006))}`);
  check_('header: code starts after the header (16) and the 4 descriptors of 8 bytes', r.gen.base === 0x8010 + 8 * 4 && r.gen.headerLen === 16 && r.gen.descLen === 8, hex(r.gen.base));
  const inst = rd(0x800E);
  const ninst = mem[inst], assetOf = [...mem.subarray(inst + 1, inst + 1 + ninst)];
  check_('inst_table: 9 instances, each with its asset index (declaration order, pools consecutive)', ninst === 9 && assetOf.join() === [0, 1, 1, 1, 2, 2, 0, 3, 3].join(), `${ninst}: ${assetOf}`);
  const d = (i) => 0x8010 + 8 * i;
  check_('descriptors: width 16, the asset\'s height, data pointer, hot pointer, phases, 0',
    [0, 1, 2, 3].every((i) => mem[d(i)] === 16 && rd(d(i) + 2) > 0x8010 && rd(d(i) + 4) > 0x8010 && mem[d(i) + 7] === 0) && mem[d(0) + 1] === 8 && mem[d(1) + 1] === 16);
  check_('descriptors: phases default 8, the asset\'s "phases" 4 and 1 otherwise', [mem[d(0) + 6], mem[d(1) + 6], mem[d(2) + 6], mem[d(3) + 6]].join() === '8,8,4,1', [0, 1, 2, 3].map((i) => mem[d(i) + 6]).join());
  const hot = (i) => { const a = rd(d(i) + 4); return [...mem.subarray(a, a + 4)].join(); };
  check_('hot boxes per asset: ball 0,0,8,8; big 4,4,8,8; fine 0,0,16,16; coarse 0,0,8,8', [0, 1, 2, 3].map(hot).join(' ') === '0,0,8,8 4,4,8,8 0,0,16,16 0,0,8,8', [0, 1, 2, 3].map(hot).join(' '));
  check_('sprite data is stored once per asset (4 data blocks), after the code', r.usage.spriteData === 8 * 4 + 16 * 4 + 16 * 4 + 8 * 4, `${r.usage.spriteData}`);
  check_('the map has the symbols (instances, arrays) for tools', r.map.instances.PL.first === 1 && r.map.instances.PL.count === 3 && r.map.instances.TINY.first === 7 && r.map.sprites.TWIN === 6, JSON.stringify(r.map.instances));
  const code = r.gen.code;
  const ldA = [...code].findIndex((v, i) => v === 0x3E && code[i + 1] === 81 && code[i + 2] === 0xCD && (code[i + 3] | (code[i + 4] << 8)) === TRAPS.RT_KEYDOWN);
  check_('KEYDOWN("q") is folded at build time: LD A,81 / CALL RT_KEYDOWN', ldA >= 0);
  check_('usage reports assets and instances', r.gen.usage.sprites === 4 && r.gen.usage.instances === 9);

  const e1 = (s, rt, a) => errText(compileM(s, a ?? ASSETS, rt));
  check_('17 instances are refused', /at most 16 sprite instances in all \(this declaration would make 17\)/.test(e1(GAME('SPRITE p(16) = "ball"\nSPRITE q = "bat"\n', ''))), e1(GAME('SPRITE p(16) = "ball"\nSPRITE q = "bat"\n', '')));
  check_('exactly 16 instances compile', compileM(GAME('SPRITE p(15) = "ball"\nSPRITE q = "bat"\n', '    SHOW p(15) AT 1, 1\n    SHOW q AT 2, 2')).errors.length === 0);
  const nine = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'].map((k) => `SPRITE s${k} = "${k}"\n`).join('');
  check_('9 different assets are refused, 8 are fine', /at most 8 different sprite assets/.test(e1(GAME(nine, ''))) && compileM(GAME(nine.split('\n').slice(0, 8).join('\n') + '\n', '')).errors.length === 0, e1(GAME(nine, '')));
  check_('9 instances of ONE asset are fine (8 distinct assets is a limit of art, not of instances)', compileM(GAME('SPRITE many(9) = "ball"\n', '')).errors.length === 0);
  check_('phases 3 is refused', /"phases" must be 1, 2, 4 or 8, got 3/.test(e1(GAME('SPRITE o = "odd"\n', ''))), e1(GAME('SPRITE o = "odd"\n', '')));
  check_('a missing sprite asset is reported', /sprite asset "nope" is not in the project/.test(e1(GAME('SPRITE o = "nope"\n', ''))));
  check_('DIM a(1001) is refused by the checker with the v2 limit', /out of range \(1\.\.1000\)/.test(e1(GAME('', '', 'DIM a(1001)'))));
  check_('arrays that need more than the variable area are refused', /too many variables/.test(e1(GAME('', '', 'DIM a(1000), b(1000), c(1000)'))), e1(GAME('', '', 'DIM a(1000), b(1000), c(1000)')));
  check_('a string array is not supported yet', /string array/.test(e1(GAME('', '', 'DIM a$(3)'))));
  const noKey = { ...mockRuntime(2), symbols: Object.fromEntries(Object.entries(mockRuntime(2).symbols).filter(([k]) => k !== 'RT_KEYDOWN')) };
  check_('a runtime without RT_KEYDOWN is reported at the KEYDOWN', /KEYDOWN\(\.\.\.\) needs RT_KEYDOWN/.test(e1(GAME('', '    a = KEYDOWN("Q")'), noKey)));
  check_('SHOW ... FRAME is still not supported', /SHOW \.\.\. FRAME is not supported yet in M4a/.test(e1(GAME('SPRITE p = "ball"\n', '    SHOW p AT 1, 2 FRAME 1'))));
  // the old runtimes keep refusing the new words
  const v1s = [['an array', GAME('', '    a(1) = 1', 'DIM a(5)')], ['an array read', GAME('', '    b = a(1)', 'DIM a(5), b')]];
  check_('v1 runtime: arrays say "not supported yet in M3"', v1s.every(([, s]) => /not supported yet in M3/.test(e1(s, mockRuntime(1)))), v1s.map(([, s]) => e1(s, mockRuntime(1))).join(' / '));
  check_('v1 runtime: a sprite pool says "not supported yet in M3"', /a sprite pool \(SPRITE p\(3\)\) is not supported yet in M3/.test(e1(GAME('SPRITE p(3) = "ball"\n', ''), mockRuntime(1))), e1(GAME('SPRITE p(3) = "ball"\n', ''), mockRuntime(1)));
  check_('v1 runtime: SHOW p(1) and HIT(p(1), q) say "not supported yet in M3"', /instance index/.test(e1(GAME('SPRITE p = "ball"\nSPRITE q = "bat"\n', '    SHOW p(0) AT 1, 1\n    a = HIT(p(0), q)'), mockRuntime(1))));
  check_('v1 runtime: KEYDOWN says "not supported yet in M3"', /KEYDOWN\(\.\.\.\) is not supported yet in M3/.test(e1(GAME('', '    a = KEYDOWN("Q")'), mockRuntime(1))));
  check_('v0 runtime: arrays and KEYDOWN say "not supported yet in M2"', /not supported yet in M2/.test(e1(GAME('', '    a(1) = 1', 'DIM a(5)'), mockRuntime(0))) && /not supported yet in M2/.test(e1(GAME('', '    a = KEYDOWN("Q")'), mockRuntime(0))));
  const v1ok = compileM(GAME('SPRITE p = "ball"\nSPRITE q = "bat"\n', '    SHOW p AT 1, 1\n    SHOW q AT 2, 2\n    a = HIT(p, q)'), ASSETS, mockRuntime(1));
  check_('v1 runtime: an ordinary game still gets the 14-byte header and 6-byte descriptors', v1ok.errors.length === 0 && v1ok.gen.headerLen === 14 && v1ok.gen.descLen === 6 && v1ok.memory[0x8006] === 0x0E, errText(v1ok));
  // the v2 path with a v0/v1 program: same behaviour as the interpreter
  const ex = readFileSync(join(ROOT, 'arcade/tests/fixtures/breakout-v1.arc'), 'utf8'), exAssets = JSON.parse(readFileSync(join(ROOT, 'arcade/tests/fixtures/breakout-v1.assets.json'), 'utf8'));
  const rb = compileM(ex, exAssets);
  check_('breakout.arc (a v1 game) also compiles for the v2 runtime', rb.errors.length === 0, errText(rb));
  if (rb.errors.length === 0) {
    const NT = QUICK ? 120 : 300, stick = (t) => (t % 30 < 12 ? 4 : t % 30 < 24 ? 8 : 16);
    const want = interpV2(ex, NT, { assets: exAssets, stick });
    const d = diffRun(runMock(rb, { ticks: NT, stick }), want, ctxFor(ex, exAssets));
    check_(`breakout.arc on the v2 mock vs the interpreter (${NT} ticks)`, d === null, d ?? '');
  }
}

// =================================================================================================================
// 3. Array semantics: hand-written expectations
// =================================================================================================================
console.log('\n3. Array semantics (the interpreter and the compiled code both have to give the hand-computed values)');
const bothAgree = (name, src, expect, { ticks = 1, assets = ASSETS, keys = null, stick = null } = {}) => {
  let detail = '', ok = false;
  REAL.push({ name, src, ticks, assets, keys, stick, skip: ['cells', 'attrs', 'cursor', 'sound'] });
  try {
    const res = compileM(src, assets);
    if (res.errors.length) throw new Error('compile: ' + errText(res));
    const want = interpV2(src, ticks, { assets, keys: keys ? (t, c) => keys(t).includes(c) : undefined, stick: stick ?? undefined });
    const got = runMock(res, { ticks, keys, stick });
    const d = diffRun(got, want, ctxFor(src, assets, ['cells', 'attrs', 'cursor', 'sound']));
    if (d) throw new Error(d);
    const last = want.ticks.at(-1);
    for (const [k, v] of Object.entries(expect)) {
      const have = k.includes('(') ? last.arrays[k.slice(0, k.indexOf('('))][Number(k.slice(k.indexOf('(') + 1, -1))] : last.vars[k];
      if (have !== v) throw new Error(`hand check ${k} = ${have}, expected ${v}`);
    }
    ok = true; detail = `${Object.keys(expect).length} values`;
  } catch (e) { detail = e.message; }
  check_(name, ok, detail);
};
{
  const SEM = (init, frame = '', decl = 'DIM s0, a(3), s1, r, r2, r3, i') => `GAME "sem"\nSCENE s\n  ${decl}\n  PROC INIT():\n    ${init}\n  ENDP\n  PROC FRAME():\n    ${frame}\n  ENDP\nENDSCENE\n`;
  bothAgree('elements 0..n are stored, neighbours are untouched', SEM('s0 = 11 : s1 = 22 : a(0) = 1 : a(1) = 2 : a(2) = 3 : a(3) = 4'),
    { S0: 11, S1: 22, 'A(0)': 1, 'A(1)': 2, 'A(2)': 3, 'A(3)': 4 });
  bothAgree('a write past the end (n + 1), far outside and negative is ignored; the variable after the array is not hit',
    SEM('s0 = 11 : s1 = 22 : a(3) = 9 : a(4) = 99 : a(100) = 98 : a(-1) = 97 : a(32767) = 96 : a(-32768) = 95 : i = 4 : a(i) = 94 : i = -1 : a(i) = 93 : i = 32768 : a(i) = 92'),
    { S0: 11, S1: 22, 'A(0)': 0, 'A(1)': 0, 'A(2)': 0, 'A(3)': 9 });
  bothAgree('an out-of-range read gives 0 (n + 1, huge, negative, 65535 = -1, 32768 = -32768)',
    SEM('a(0) = 5 : a(3) = 6 : s0 = 7 : s1 = 8 : r = a(4) : r2 = a(-1) + a(65535) + a(32768) + a(-32768) : r3 = a(0) + a(3) : i = 5 : i = a(i) + a(i + 100)'),
    { R: 0, R2: 0, R3: 11, I: 0 });
  bothAgree('a run-time index in range reads and writes the right slot', SEM('FOR i = 0 TO 3 : a(i) = i * 10 + 1 : NEXT i : r = 2 : r2 = a(r) : a(r) = a(r) + a(r + 1)'),
    { R2: 21, 'A(2)': 52, 'A(3)': 31 });
  bothAgree('the index is evaluated before the value: RND consumed in order', SEM('a(RND(4)) = RND(1000) : a(RND(4)) = RND(1000) : r = RND(4)'),
    {});
  bothAgree('the value is evaluated even when the write is ignored (RND still advances)', SEM('r = 7 : a(r) = RND(1000) : r2 = RND(1000)'), {});
  bothAgree('an element as a FOR bound, STEP, index of another array and a PROC argument', SEM('a(0) = 1 : a(1) = 7 : a(2) = 2 : a(3) = 0 : r = 0 : FOR i = a(0) TO a(1) STEP a(2) : r = r + i : NEXT i : r2 = a(a(2)) + a(a(0) + a(2)) : CALL P(a(1))', '', 'DIM s0, a(3), s1, r, r2, r3, i\n  PROC P(q):\n    r3 = q + a(q)\n  ENDP'),
    { R: 16, R2: 2, R3: 7 });
  bothAgree('DIM a(1000): the last element works, the 1002nd slot belongs to the next variable', SEM('s0 = 3 : a(1000) = 77 : a(1001) = 5 : r = a(1000) : s1 = 4', '', 'DIM s0, a(1000), s1, r, r2, r3, i'),
    { S0: 3, S1: 4, R: 77, 'A(1000)': 77 });
  bothAgree('DEF FN with an element and a nested index', SEM('a(0) = 3 : a(1) = 2 : a(2) = 1 : r = FN f(0) : r2 = FN f(a(0))', '', 'DIM s0, a(3), s1, r, r2, r3, i\n  DEF FN f(x) = a(x) * 10 + a(a(x))'),
    { R: 30, R2: 3 });
  bothAgree('arrays start at 0 and the whole variable area is cleared at the start', SEM('r = a(0) + a(1) + a(2) + a(3) + s0 + s1'), { R: 0 });
  bothAgree('16-bit wrap in elements', SEM('a(1) = 32767 : a(1) = a(1) + 1 : a(2) = 40000 : a(3) = a(1) - 1'), { 'A(1)': -32768, 'A(2)': -25536, 'A(3)': 32767 });
}

// =================================================================================================================
// 4. Array fuzz
// =================================================================================================================
function fuzzArrays(label, runGame, { games, perGame, seed, ticks = 2 }) {
  console.log(`\n${label}`);
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const INTERESTING = [-32768, 32767, 0, 1, -1, 2, 3, 4, 5, 8, 9, 10, 11, 100, 255, 256, 1000, 1001, -2, -100, 20000];
  const lit = (v) => (v < 0 ? `(-${-v})` : String(v));
  const SCALARS = ['a', 'b', 'c', 'd'];
  const CMP = ['=', '<>', '<', '>', '<=', '>='];
  let total = 0, outOfRange = 0, nested = 0, bad = 0, withBig = 0;
  for (let g = 0; g < games; g++) {
    const big = g % 8 === 7;
    const ARR = [['x', 9], ['y', 4], ['w', 1], ...(big ? [['z', 1000]] : [])];
    if (big) withBig++;
    const arr = () => pick(ARR);
    const index = (d) => {                       // an index expression, often near the boundary
      const r = rand();
      if (r < 0.3) return lit(Math.floor(rand() * 13) - 2);
      if (r < 0.4) return lit(pick(INTERESTING));
      if (r < 0.65) return pick(SCALARS);
      return ex(d - 1);
    };
    function ex(d) {
      if (d <= 0 || rand() < 0.16) {
        const r = rand();
        if (r < 0.4) return pick(SCALARS);
        if (r < 0.45) return `RND(${pick([2, 3, 5, 9, 10, 17])})`;
        return lit(pick(INTERESTING.concat([Math.floor(rand() * 40) - 20])));
      }
      const r = rand(), sub = () => ex(d - 1);
      if (r < 0.36) { const [n, size] = arr(); const ix = index(d); total++; if (ix.includes('(')) nested++; return `${n}(${ix})`; }
      if (r < 0.46) return `(${sub()} + ${sub()})`;
      if (r < 0.54) return `(${sub()} - ${sub()})`;
      if (r < 0.60) return `(${sub()} * ${sub()})`;
      if (r < 0.64) return `(${sub()} DIV ${rand() < 0.5 ? lit(pick([2, 3, 7, -2, 0, 16])) : sub()})`;
      if (r < 0.69) return `(${sub()} MOD ${rand() < 0.5 ? lit(pick([2, 3, 7, 10, -3, 1])) : sub()})`;
      if (r < 0.77) return `(${sub()} ${pick(CMP)} ${sub()})`;
      if (r < 0.81) return `(${sub()} AND ${sub()})`;
      if (r < 0.85) return `(${sub()} OR ${sub()})`;
      if (r < 0.88) return `(NOT ${sub()})`;
      if (r < 0.91) return `BIT(${sub()}, ${rand() < 0.6 ? lit(pick([0, 1, 7, 8, 15])) : sub()})`;
      if (r < 0.94) return `ABS(${sub()})`;
      if (r < 0.96) return `SGN(${sub()})`;
      if (r < 0.98) return `FN f(${sub()})`;
      return `(-${sub()})`;
    }
    const fragment = (k) => {
      const r = rand(), d = 1 + Math.floor(rand() * 3);
      const [an] = arr(), [bn] = arr();
      if (r < 0.22) return `${pick(['r0', 'r1', 'r2', 'r3', ...SCALARS])} = ${ex(d + 1)}`;
      if (r < 0.50) return `${an}(${index(d)}) = ${ex(d)}`;
      if (r < 0.58) return `IF ${ex(d)} THEN ${an}(${index(d)}) = ${ex(d)} ELSE ${bn}(${index(d)}) = ${ex(d)} ENDIF`;
      if (r < 0.66) return `FOR i = ${pick(['0', '1', `ABS(${ex(1)}) MOD 3`])} TO ABS(${ex(d)}) MOD 7 : ${an}(i) = ${an}(i + ${pick(['0', '1', '-1'])}) + ${ex(d)} : NEXT i`;
      if (r < 0.70) return `FOR i = ${pick(['6', '4'])} TO ${pick(['0', '1', '-1'])} STEP -${pick(['1', '2'])} : ${bn}(i) = ${ex(d)} : NEXT i`;
      if (r < 0.74) return `FOR i = ${an}(${index(1)}) MOD 3 TO ${bn}(${index(1)}) MOD 5 STEP ${pick(['1', '2'])} : r0 = r0 + ${an}(i) : NEXT i`;
      if (r < 0.80) return `CALL p(${ex(d)})`;
      if (r < 0.84) return `r1 = FN f(${an}(${index(d)}))`;
      if (r < 0.90) return `SELECT CASE ${ex(d)}\n      CASE ${bn}(${index(1)}), ${lit(pick(INTERESTING))}\n        ${an}(${index(1)}) = 1\n      CASE ${ex(1)}\n        r2 = r2 + 1\n      CASE ELSE\n        ${bn}(${index(1)}) = ${ex(1)}\n    ENDSEL`;
      if (r < 0.95) return `c = 0 : WHILE c < 5 AND ${an}(${index(1)}) <> ${lit(pick([0, 7, 1000]))} : c = c + 1 : ${an}(c) = ${an}(c) + ${ex(1)} : WEND`;
      return `${an}(${an}(${an}(${index(1)}))) = ${bn}(${bn}(${index(1)}))`;
    };
    const init = SCALARS.map((v) => `${v} = ${lit(pick(INTERESTING.concat([Math.floor(rand() * 40) - 20])))}`);
    const initFrags = [], frameFrags = [];
    for (let k = 0; k < perGame; k++) (k < perGame / 2 ? initFrags : frameFrags).push(fragment(k));
    const decl = ['a', 'b', 'c', 'd', 'r0', 'r1', 'r2', 'r3', 'i', ...ARR.map(([n, s]) => `${n}(${s})`)].join(', ');
    const src = `GAME "fuzz"\nSCENE s\n  DIM ${decl}\n  DEF FN f(p) = x(p) + y(p MOD 3) * 2 - w(p) + 1\n  PROC p(q):\n    x(q) = q + y(q MOD 5)\n    a = a + w(q - 1)\n    y(1) = x(q + 1)\n  ENDP\n  PROC INIT():\n    ${init.join(' : ')}\n    ${initFrags.join('\n    ')}\n  ENDP\n  PROC FRAME():\n    ${frameFrags.join('\n    ')}\n  ENDP\nENDSCENE\n`;
    const parsed = parse(src), chk = check(parsed.ast, { version: 2 }).filter((d) => d.severity === 'error');
    if (parsed.errors.length || chk.length) { bad++; check_(`fuzz game ${g} is valid`, false, (parsed.errors[0] ?? chk[0]).message + '\n' + src); break; }
    if (g % 3 === 0) REAL.push({ name: `fuzz game ${g}`, src, ticks, skip: ['cells', 'attrs', 'cursor', 'sound'], fuzz: true });
    let detail = null;
    try {
      const want = interpV2(src, ticks);
      const got = runGame(src);
      detail = diffRun(got, want, ctxFor(src, ASSETS, ['cells', 'attrs', 'cursor', 'sound']));
      for (const rec of [want.init, ...want.ticks]) for (const arrv of Object.values(rec.arrays)) void arrv;
    } catch (e) { detail = e.message; }
    if (detail) { bad++; console.log(`   mismatch in fuzz game ${g}: ${detail}\n${src}`); break; }
  }
  void outOfRange;
  check_(`${total} array accesses in ${perGame * games} random fragments (${nested} with a nested index; ${withBig} games with a 1001-element array) match the interpreter`,
    bad === 0 && perGame * games >= (QUICK ? 200 : 3000), `${games} programs x ${perGame} fragments, INIT + ${ticks} ticks each`);
}
const FUZZ_GAMES = QUICK ? 12 : 90, FUZZ_PER = 40;
fuzzArrays('4. Array fuzz on the mock runtime (nested indices, arrays as bounds, indices of other arrays, PROC / DEF FN arguments, out-of-range reads and writes)',
  (src) => { const res = compileM(src); if (res.errors.length) throw new Error('compile: ' + errText(res) + '\n' + src); return runMock(res, { ticks: 2 }); },
  { games: FUZZ_GAMES, perGame: FUZZ_PER, seed: 20261109 });

// =================================================================================================================
// 5. Instances and pools
// =================================================================================================================
console.log('\n5. Instances: references, bounds, HIT between instances, pool games');
{
  const PSRC = (top, body, decl = 'DIM i, j, h0, h1, h2, h3, h4, h5') => `GAME "pool"\nFRAMERATE 30\nSPRITE solo = "ball"\nSPRITE pa(4) = "big"\nSPRITE pb(3) = "bat"\nSPRITE last = "ball"\n${top}SCENE s\n  ${decl}\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n${body}\n  ENDP\nENDSCENE\n`;
  const sprRun = (name, src, ticks = 3) => {
    let detail = '', ok = false;
    REAL.push({ name, src, ticks, skip: ['cells', 'attrs', 'cursor', 'sound'] });
    try {
      const res = compileM(src);
      if (res.errors.length) throw new Error('compile: ' + errText(res));
      const want = interpV2(src, ticks);
      const d = diffRun(runMock(res, { ticks }), want, ctxFor(src, ASSETS, ['cells', 'attrs', 'cursor', 'sound']));
      if (d) throw new Error(d);
      ok = true; detail = `${ticks} ticks`;
      return { ok, want, res };
    } catch (e) { detail = e.message; }
    finally { check_(name, ok, detail); }
    return { ok, want: null };
  };
  // directed: instance numbers are declaration order: solo 0, pa 1..4, pb 5..7, last 8
  let r = sprRun('SHOW pa(i) at run-time indices: in range lands on the right instance, outside is ignored',
    PSRC('', '    i = 0\n    SHOW pa(i) AT 10, 20\n    SHOW pa(3) AT 30, 40\n    i = 4\n    SHOW pa(i) AT 50, 60\n    i = -1\n    SHOW pa(i) AT 70, 80\n    SHOW pa(i + 2) AT 90, 100\n    SHOW pb(2) AT 11, 12\n    SHOW pb(3) AT 13, 14\n    SHOW solo(0) AT 1, 2\n    i = 1\n    SHOW solo(i) AT 3, 4\n    SHOW last AT 5, 6'));
  if (r.want) {
    const s = r.want.ticks.at(-1).sprites;
    check_('  hand check: pa(0) = instance 1 at (10,20), pa(3) = instance 4, pa(1) (via pa(i + 2) with i = -1) = instance 2 at (90,100), pa(2) hidden, pb(2) = instance 7, solo and last placed, nothing else',
      s[1].visible && s[1].x === 10 && s[4].visible && s[4].y === 40 && s[2].visible && s[2].x === 90 && s[3].visible === 0 && s[7].visible && s[7].x === 11 && s[5].visible === 0 && s[6].visible === 0 && s[0].visible && s[0].x === 1 && s[8].visible && s[8].x === 5, JSON.stringify(s.map((q) => q.visible)));
  }
  r = sprRun('HIDE pool(i) and HIDE of a constant; hidden instances stay hidden; outside the pool does nothing',
    PSRC('', '    SHOW pb(0) AT 0, 100\n    SHOW pb(1) AT 20, 100\n    SHOW last AT 40, 100\n    SHOW solo AT 60, 100\n    FOR i = 0 TO 3\n      SHOW pa(i) AT i * 20, 10\n    NEXT i\n    HIDE pa(1)\n    j = 2\n    HIDE pa(j)\n    j = 4\n    HIDE pa(j)\n    j = -1\n    HIDE pa(j)\n    HIDE pa(0)\n    SHOW pa(0) AT 5, 5'));
  if (r.want) {
    const s = r.want.ticks.at(-1).sprites;
    check_('  hand check: only pa(0) (shown again) and pa(3) of the pool remain visible; the neighbours pb(0), pb(1), last and solo are untouched by HIDE pa(4) / pa(-1)',
      s[1].visible === 1 && s[2].visible === 0 && s[3].visible === 0 && s[4].visible === 1 && s[1].x === 5 && s[5].visible === 1 && s[6].visible === 1 && s[8].visible === 1 && s[0].visible === 1);
  }
  r = sprRun('HIT between instances: a bare name, a name(expr), pool vs pool, outside gives 0',
    PSRC('', '    SHOW solo AT 40, 40\n    SHOW pa(0) AT 38, 38\n    SHOW pa(1) AT 200, 100\n    SHOW pb(0) AT 40, 40\n    SHOW last AT 41, 41\n    i = 0\n    j = 1\n    h0 = HIT(solo, pa(0))\n    h1 = HIT(pa(i), pa(j))\n    h2 = HIT(pa(i), solo) + HIT(pb(i), solo) * 2\n    h3 = HIT(pa(j), pa(i + 1)) + HIT(pa(i - 1), solo) + HIT(solo, pa(7))\n    h4 = HIT(pb(i), last) + HIT(last, pb(j + 3))\n    h5 = HIT(pa(i), pa(j + 3)) + HIT(pa(j + 3), pa(i)) + HIT(pa(j + 3), pa(j + 3)) + HIT(pa(j), pb(j)) + HIT(pb(j + 2), solo) + HIT(solo, pb(j + 2))'),
    4);
  if (r.want) {
    const v = r.want.ticks.at(-1).vars;
    check_('  hand check: HIT(solo, pa(0)) = 1; pa(0)/pa(1) apart = 0; pa vs solo 1 + pb vs solo 2 = 3; an instance with itself 1, outside 0; pb(0)/last = 1; hidden or outside 0',
      v.H0 === 1 && v.H1 === 0 && v.H2 === 3 && v.H3 === 1 && v.H4 === 1 && v.H5 === 0, JSON.stringify(v));
  }
  sprRun('instance index expressions with side effects (RND) are evaluated: SHOW p(RND(9)) AT RND(200), RND(100)',
    PSRC('', '    SHOW pa(RND(9) - 2) AT RND(200), RND(100)\n    HIDE pa(RND(7))\n    h0 = HIT(pa(RND(5)), pb(RND(4)))\n    h1 = RND(10)'), 30);
  sprRun('SHOW with an index outside the pool still evaluates x and y (RND advances the same)',
    PSRC('', '    SHOW pa(9) AT RND(200), RND(100)\n    h0 = RND(1000)\n    i = 9\n    SHOW pa(i) AT RND(200), RND(100)\n    h1 = RND(1000)\n    HIDE pa(i + RND(2))'), 5);

  // ---- pool games: ship + bullets + enemies + shots, all in arrays, compared tick by tick ----
  const poolGame = (nb, ne, ns, { phasesAssets = false } = {}) => `GAME "pools"
FRAMERATE 30
SPRITE ship = "big"
SPRITE bul(${nb}) = "${phasesAssets ? 'fine' : 'ball'}"
SPRITE foe(${ne}) = "bat"
SPRITE shot(${ns}) = "${phasesAssets ? 'coarse' : 'ball'}"
TILESET ts = "ts"
SFX beep = "beep"
SFX zap = "zap"
SCENE play
  DIM px, py, i, j, k, score, hits, cool, lives, t
  DIM bx(${nb - 1}), by(${nb - 1}), bon(${nb - 1})
  DIM ex(${ne - 1}), ey(${ne - 1}), eon(${ne - 1}), edx(${ne - 1})
  DIM sx(${ns - 1}), sy(${ns - 1}), son(${ns - 1})
  PROC INIT():
    px = 120 : py = 150 : lives = 9
    FOR i = 0 TO ${ne - 1}
      ex(i) = 20 + i * 25 : ey(i) = 10 + (i MOD 3) * 14 : eon(i) = 1 : edx(i) = 1 + (i MOD 3)
    NEXT i
    SHOW ship AT px, py
  ENDP
  PROC FRAME():
    t = t + 1
    IF KEYDOWN("O") OR BIT(STICK(1), 2) THEN px = px - 4 ENDIF
    IF KEYDOWN("P") OR BIT(STICK(1), 3) THEN px = px + 4 ENDIF
    IF px < 0 THEN px = 0 ENDIF
    IF px > 240 THEN px = 240 ENDIF
    SHOW ship AT px, py
    IF cool > 0 THEN cool = cool - 1 ENDIF
    IF (KEYDOWN(" ") OR BIT(STICK(1), 4)) AND cool = 0 THEN
      FOR i = 0 TO ${nb - 1}
        IF bon(i) = 0 THEN
          bon(i) = 1 : bx(i) = px + 4 : by(i) = py - 4 : cool = 4
          PLAY beep
          EXIT FOR
        ENDIF
      NEXT i
    ENDIF
    FOR i = 0 TO ${nb - 1}
      IF bon(i) = 1 THEN
        by(i) = by(i) - 6
        IF by(i) < 0 THEN
          bon(i) = 0
          HIDE bul(i)
        ELSE
          SHOW bul(i) AT bx(i), by(i)
          FOR j = 0 TO ${ne - 1}
            IF eon(j) = 1 AND HIT(bul(i), foe(j)) THEN
              eon(j) = 0 : bon(i) = 0 : score = score + 10 + j
              HIDE foe(j) : HIDE bul(i)
              PLAY zap
              TILE ex(j) DIV 8, ey(j) DIV 8 = j MOD 5
              EXIT FOR
            ENDIF
          NEXT j
        ENDIF
      ENDIF
    NEXT i
    FOR j = 0 TO ${ne - 1}
      IF eon(j) = 1 THEN
        ex(j) = ex(j) + edx(j)
        IF ex(j) > 230 OR ex(j) < 4 THEN edx(j) = -edx(j) ENDIF
        ey(j) = ey(j) + (t MOD 4 = 0)
        SHOW foe(j) AT ex(j), ey(j)
        IF RND(40) = 0 THEN
          FOR k = 0 TO ${ns - 1}
            IF son(k) = 0 THEN
              son(k) = 1 : sx(k) = ex(j) + 6 : sy(k) = ey(j) + 8
              EXIT FOR
            ENDIF
          NEXT k
        ENDIF
        IF HIT(foe(j), ship) THEN
          eon(j) = 0 : HIDE foe(j) : lives = lives - 1
        ENDIF
      ELSE
        IF RND(60) = 0 THEN
          eon(j) = 1 : ex(j) = RND(200) : ey(j) = 0
        ENDIF
      ENDIF
    NEXT j
    FOR k = 0 TO ${ns - 1}
      IF son(k) = 1 THEN
        sy(k) = sy(k) + 4
        IF sy(k) > 180 THEN
          son(k) = 0
          HIDE shot(k)
        ELSE
          SHOW shot(k) AT sx(k), sy(k)
          IF HIT(shot(k), ship) THEN
            son(k) = 0 : HIDE shot(k) : lives = lives - 1 : hits = hits + 1
          ENDIF
        ENDIF
      ENDIF
    NEXT k
  ENDP
ENDSCENE
`;
  const poolStick = (t) => ((t % 60 < 25 ? 4 : t % 60 < 45 ? 8 : 0) | (t % 7 < 5 ? 16 : 0));
  const poolKeys = (t) => [...(t % 90 < 30 ? [79] : t % 90 < 60 ? [80] : []), ...(t % 5 < 3 ? [32] : [])];
  const NP = QUICK ? 150 : 200;
  const runPool = (name, nb, ne, ns, rt, opts = {}) => {
    let detail = '', ok = false;
    try {
      const src = poolGame(nb, ne, ns, opts);
      if (nb + ne + ns + 1 <= 16) REAL.push({ name, src, ticks: NP, stick: opts.useStick ? poolStick : null, keys: opts.useStick ? null : poolKeys, skip: [], pictures: true });
      const res = compileM(src, ASSETS, rt);
      if (res.errors.length) throw new Error('compile: ' + errText(res));
      const maxInstances = nb + ne + ns + 1;
      const want = interpV2(src, NP, { stick: opts.useStick ? poolStick : undefined, keys: opts.useStick ? undefined : (t, c) => poolKeys(t).includes(c), maxInstances });
      const got = runMock(res, { ticks: NP, stick: opts.useStick ? poolStick : null, keys: opts.useStick ? null : poolKeys });
      const d = diffRun(got, want, ctxFor(src, ASSETS, []));
      if (d) throw new Error(d);
      const last = want.ticks.at(-1).vars, shown = want.ticks.reduce((n, q) => n + q.sprites.filter((s) => s.visible).length, 0);
      ok = shown > NP * 2 && last.SCORE > 0;
      detail = `${maxInstances} instances, ${NP} ticks, SPR_TAB-equivalent + ${Object.keys(want.init.vars).length} variables + ${Object.keys(want.init.arrays).length} arrays + cell map per tick; score ${last.SCORE}, lives ${last.LIVES}, ${(shown / NP).toFixed(1)} visible per tick`;
      if (!ok) detail = 'the game did not do anything: ' + detail;
    } catch (e) { detail = e.message; }
    check_(name, ok, detail);
  };
  runPool('pool game with the contract\'s sizes: 1 ship + 6 bullets + 8 enemies + 4 shots = 19 instances (mock with 24 slots), keys', 6, 8, 4, mockRuntime(2, { MAX_SPRITES: 24 }));
  runPool('pool game, 16 instances (1 + 4 + 8 + 3), keys', 4, 8, 3, mockRuntime(2));
  runPool('pool game, 16 instances, joystick', 4, 8, 3, mockRuntime(2), { useStick: true });
  runPool('pool game with phases (bullets 4, shots 1), 16 instances', 4, 8, 3, mockRuntime(2), { phasesAssets: true });
  check_('the 19-instance game is refused by a runtime with 16 instances', /at most 16 sprite instances/.test(errText(compileM(poolGame(6, 8, 4), ASSETS, mockRuntime(2)))));
}

// =================================================================================================================
// 6. KEYDOWN
// =================================================================================================================
console.log('\n6. KEYDOWN with a scripted key set');
const KEYS_SRC = `GAME "keys"
SCENE s
  DIM q, a, o, p, sp, en, sh, sy, d0, d9, up, dn, n, pq
  PROC INIT():
  ENDP
  PROC FRAME():
    q = KEYDOWN("Q") : a = KEYDOWN("A") : o = KEYDOWN("O") : p = KEYDOWN("P") : sp = KEYDOWN(" ") : en = KEYDOWN(13)
    sh = KEYDOWN(1) : sy = KEYDOWN(2) : d0 = KEYDOWN("0") : d9 = KEYDOWN("9")
    up = KEYDOWN("q") + KEYDOWN(81) * 2
    dn = KEYDOWN(65) + KEYDOWN("a") * 2
    pq = KEYDOWN(99) + KEYDOWN(0) + KEYDOWN(";")
    IF KEYDOWN("Z") AND KEYDOWN("X") THEN
      n = n + 1
    ENDIF
  ENDP
ENDSCENE
`;
const ALLKEYS = [81, 65, 79, 80, 32, 13, 1, 2, 48, 57, 90, 88];
const keyScript = (t) => ALLKEYS.filter((c, i) => ((t * 7 + i * 13 + (t >> 2) * i) % 5) < (i < 6 ? 2 : 1));
{
  const NK = QUICK ? 60 : 120;
  REAL.push({ name: 'KEYDOWN game: the scripted key matrix', src: KEYS_SRC, ticks: NK, keys: keyScript, skip: ['cells', 'attrs', 'cursor', 'sound'] });
  const res = compileM(KEYS_SRC);
  check_('compiles (the unscanned keys 99, 0 and ";" are warnings)', res.errors.length === 0 && res.warnings.length === 3 && res.warnings.every((w) => /never held/.test(w.message)), errText(res) + ' / ' + res.warnings.length);
  const want = interpV2(KEYS_SRC, NK, { keys: (t, c) => keyScript(t).includes(c) });
  const got = runMock(res, { ticks: NK, keys: keyScript });
  const d = diffRun(got, want, ctxFor(KEYS_SRC, ASSETS, ['cells', 'attrs', 'cursor', 'sound']));
  check_(`${NK} ticks of a scripted key set: every variable matches the interpreter`, d === null, d ?? '');
  // the script itself: hand-model each variable from the held set
  let handOk = true, why = '';
  want.ticks.forEach((rec, i) => {
    const t = i + 1, h = keyScript(t), has = (c) => (h.includes(c) ? 1 : 0), v = rec.vars;
    const exp = { Q: has(81), A: has(65), O: has(79), P: has(80), SP: has(32), EN: has(13), SH: has(1), SY: has(2), D0: has(48), D9: has(57), UP: has(81) * 3, DN: has(65) * 3, PQ: 0 };
    for (const [k, e] of Object.entries(exp)) if (v[k] !== e && handOk) { handOk = false; why = `tick ${t}: ${k} = ${v[k]}, hand model ${e}`; }
  });
  check_('  hand model: each variable is the held-ness of its key (letters upper-cased, "q" = 81, unknown keys never held)', handOk, why);
  const pressed = new Set(); want.ticks.forEach((rec, i) => { for (const k of ['Q', 'A', 'O', 'P', 'SP', 'EN', 'SH', 'SY', 'D0', 'D9']) if (rec.vars[k]) pressed.add(k); });
  check_('  the script presses and releases every key', pressed.size === 10 && want.ticks.some((r) => r.vars.Q === 1) && want.ticks.some((r) => r.vars.Q === 0), [...pressed].join());
  check_('  KEYDOWN("Z") AND KEYDOWN("X") counts the ticks both are held', want.ticks.at(-1).vars.N === want.ticks.filter((_, i) => keyScript(i + 1).includes(90) && keyScript(i + 1).includes(88)).length, `${want.ticks.at(-1).vars.N}`);
}

// =================================================================================================================
// 7. Costs
// =================================================================================================================
console.log('\n7. Costs: T-states of one array read and one array write (mock runtime, TSRun\'s Z80)');
const costs = {};
{
  const bench = (body, decl = 'DIM i, j, r, v, x(9)') => {
    const src = `GAME "cost"\nSCENE s\n  ${decl}\n  PROC INIT():\n    v = 5\n  ENDP\n  PROC FRAME():\n    FOR j = 1 TO 20\n      FOR i = 0 TO 9\n${body}\n      NEXT i\n    NEXT j\n  ENDP\nENDSCENE\n`;
    const res = compileM(src);
    if (res.errors.length) throw new Error(errText(res));
    return runMock(res, { ticks: 1 }).tstates[0];
  };
  const base = bench('        r = i'), empty = bench('');
  const read = bench('        r = x(i)'), write = bench('        x(i) = v'), writeExpr = bench('        x(i) = v + i');
  const baseW = bench('        r = v'), baseE = bench('        r = v + i');
  const N = 200;
  costs.readTotal = (read - base) / N + 32;                 // r = i is LD HL,(i) / LD (r),HL = 32 T
  costs.read = (read - base) / N;                           // `r = i` and `r = x(i)` both start with LD HL,(i) and end with LD (r),HL, so the difference is the array part
  costs.writeTotal = (write - empty) / N;
  costs.writeOverBase = (write - baseW) / N;
  costs.writeExpr = (writeExpr - baseE) / N;
  console.log(`  INFO  r = x(i): ${(read - empty) / N} T per iteration incl. the loop-free statement; the array part (index in HL -> value in HL) = ${costs.read} T; x(i) = v: ${(write - empty) / N} T (index load 16 + address 64 + value load 20 + store 18 = 118)`);
  check_('measured: an array read (index already in HL -> element in HL) costs 86 T, in range', Math.abs(costs.read - 86) < 0.01, `${costs.read}`);
  check_('measured: r = x(i) is 118 T (index 16 + read 86 + store 16); x(i) = v is 118 T (index 16 + address 64 + value 20 + store 18)', Math.abs((read - empty) / N - 118) < 0.01 && Math.abs((write - empty) / N - 118) < 0.01, `${(read - empty) / N} / ${(write - empty) / N}`);
  // out of range: the stub path
  const oob = bench('        r = x(i + 10)'), oobW = bench('        x(i + 10) = v');
  console.log(`  INFO  out of range: r = x(i + 10) ${(oob - empty) / N} T, x(i + 10) = v ${(oobW - empty) / N} T`);
  const sizeSrc = (b) => `GAME "size"\nSCENE s\n  DIM i, r, x(9)\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    ${b}\n  ENDP\nENDSCENE\n`;
  const sz = (b) => compileM(sizeSrc(b)).gen.code.length;
  const s0 = sz(''), sRead = sz('r = x(i)') - sz('r = i'), sWrite = sz('x(i) = r') - sz('r = i');
  console.log(`  INFO  code size: r = x(i) is ${sRead} bytes more than r = i (incl. the 6-byte out-of-line stub); x(i) = r ${sWrite}; a constant index is a plain LD (nn),HL`);
  check_('code size of one read / write is small (<= 30 bytes over a plain variable access)', sRead <= 30 && sWrite <= 30, `${sRead} / ${sWrite}`);
  void s0;
}

// =================================================================================================================
// 8. The example: arcade/examples/shooter.arc
// =================================================================================================================
console.log('\n8. Example: the shooter as it was before language batch 4 (arcade/tests/fixtures/shooter-v1.arc: one scene and a state variable; arcade/examples/shooter.arc now has three scenes and is tested by tests/arcade-m9-*.mjs)');
const SH_FILE = join(ROOT, 'arcade/tests/fixtures/shooter-v1.arc');
const SH_SRC = readFileSync(SH_FILE, 'utf8');
const SH_ASSETS = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/shooter.assets.json'), 'utf8'));
const SH_TICKS = 1300;
/** The scripted player: keys (Q up, A down, O left, P right, space fire) or joystick 1; fire to restart. Pure function of the tick. */
const shooterInput = (t) => {
  const keys = [];
  let stick = 0;
  // 1..679 play (the joystick in 120..199); 680.. the ship stands still and the player stops shooting until it is shot down; the fire
  // key is pressed at 940 and held, so at the game over (tick 975) it is still down: no restart until it is released (1000) and
  // pressed again (1010); then play again (the joystick in 1100..1199) until 1300
  const playing = t < 680 || t >= 1010;
  if (t >= 940 && t < 1000) keys.push(32);
  if (playing) {
    const useStick = (t >= 120 && t < 200) || (t >= 1100 && t < 1200);
    const ph = Math.floor(t / 23) % 4, left = ph === 0 || ph === 3, right = ph === 1 || ph === 2;
    const up = Math.floor(t / 61) % 3 === 0, dn = Math.floor(t / 97) % 3 === 1;
    if (useStick) stick = (left ? 4 : 0) | (right ? 8 : 0) | (up ? 1 : 0) | (dn ? 2 : 0) | 16;
    else { keys.push(32); if (left) keys.push(79); if (right) keys.push(80); if (up) keys.push(81); if (dn) keys.push(65); }
  }
  return { keys, stick };
};
const shKeys = (t) => shooterInput(t).keys, shStick = (t) => shooterInput(t).stick;
const shRnd = (rt) => { let x = rt?.constants?.RT_SEED_INIT ?? 0xACE1; return () => { if (x === 0) x = 1; x = (x ^ (x << 7)) & 0xFFFF; x ^= x >> 9; x = (x ^ (x << 8)) & 0xFFFF; return x & 0x7FFF; }; };
{
  const r = compileM(SH_SRC, SH_ASSETS);
  check_('shooter.arc compiles for the v2 runtime with no errors and no warnings', r.errors.length === 0 && r.warnings.length === 0, errText(r) + ' ' + r.warnings.map((w) => w.message).join(' | '));
  const u = r.usage;
  console.log(`  INFO  size: code ${u.codegen.codeBytes} bytes (incl. ${u.data.strings} strings + hot boxes, ${u.data.tileset} tileset, ${u.data.sfx} sound, ${u.data.map} map), ${u.varBytes} bytes of variables and arrays (${u.codegen.varSlots} slots), ${u.spriteData} bytes of sprite art in ${u.codegen.sprites} assets for ${u.codegen.instances} instances; game total ${u.total} of ${u.total + u.free} bytes`);
  check_('shooter.arc uses all 16 instances of 5 assets (ship, 4 bullets, 4 scouts, 4 heavies, 3 shots)', u.codegen.instances === 16 && u.codegen.sprites === 5, `${u.codegen.instances} / ${u.codegen.sprites}`);
  const want = interpV2(SH_SRC, SH_TICKS, { assets: SH_ASSETS, keys: (t, c) => shKeys(t).includes(c), stick: shStick });
  const V = (i) => want.ticks[i].vars;
  const over = want.ticks.filter((q) => q.vars.STATE === 1).length;
  const firstOver = want.ticks.findIndex((q) => q.vars.STATE === 1) + 1;
  const restarts = want.ticks.reduce((n, q, i) => n + (i > 0 && want.ticks[i - 1].vars.STATE === 1 && q.vars.STATE === 0 ? 1 : 0), 0);
  const maxWave = Math.max(...want.ticks.map((q) => q.vars.WV)), maxScore = Math.max(...want.ticks.map((q) => q.vars.SCORE));
  const types = new Set(), shown = new Set();
  want.ticks.forEach((q) => { q.arrays.ES.forEach((e, k) => { if (e) types.add(q.arrays.ET[k]); }); q.sprites.forEach((sp, k) => { if (sp.visible) shown.add(k); }); });
  const tileCells = want.ticks.filter((q) => q.cells.some((c) => c >= 132)).length;
  const lostLife = want.ticks.filter((q, i) => i > 0 && q.vars.LIVES < want.ticks[i - 1].vars.LIVES).length;
  const sfxSeen = new Set(want.ticks.filter((q) => q.sfx.active).map((q) => q.sfx.index));
  console.log(`  INFO  scripted run: game over at tick ${firstOver} (${over} ticks in the game over state; the fire key is held through it, the restart comes when it is pressed again), ${restarts} restart(s), best wave ${maxWave}, best score ${maxScore}, ${lostLife} life(s) lost, enemy types seen ${[...types].sort().join(',')}, ${shown.size} of 16 instances shown at some time, ${tileCells} ticks with explosion tiles, sound effects heard ${[...sfxSeen].sort().join(',')}`);
  check_('the script covers fire, movement, enemies of all four patterns, explosions, losing lives, game over and restarts', over > 30 && restarts === 1 && maxWave >= 4 && maxScore > 200 && types.size === 4 && shown.size === 16 && tileCells > 20 && lostLife >= 5 && sfxSeen.size === 5, `types ${types.size}, shown ${shown.size}, sfx ${sfxSeen.size}`);
  check_('the script uses the keyboard and the joystick (px moves in both windows)', V(150).PX !== V(130).PX && V(1150).PX !== V(1110).PX && V(250).PX !== V(230).PX && V(1250).PX !== V(1230).PX);
  const got = runMock(r, { ticks: SH_TICKS, stick: shStick, keys: shKeys });
  const d = diffRun(got, want, ctxFor(SH_SRC, SH_ASSETS, []));
  const ts = got.tstates.slice().sort((a, b) => a - b);
  if (process.env.ARCADE_TOP) console.log('  top ticks (mock, T):', got.tstates.map((t, i) => [t, i + 1]).sort((a, b) => b[0] - a[0]).slice(0, 12).map(([t, i]) => `${i}:${t}`).join(' '));
  check_(`${SH_TICKS} ticks on the mock: SPR_TAB-equivalent (16 instances), all ${want.init ? Object.keys(want.init.vars).length : 0} variables, every array, cell and attribute map, cursor, sound`, d === null, d ?? `frame_entry median ${ts[ts.length >> 1]} T, worst ${ts.at(-1)} T on the mock (its RT_* calls cost nothing)`);
}
REAL.push({ name: 'shooter.arc', src: SH_SRC, assets: SH_ASSETS, ticks: SH_TICKS, keys: shKeys, stick: shStick, skip: [], pictures: true, measure: true, shooter: true });

// =================================================================================================================
// R. The real v2 runtime
// =================================================================================================================
const RT_JSON = join(ROOT, 'arcade/build/v2/runtime.json');
if (existsSync(RT_JSON)) {
  console.log('\nR. End to end on the REAL v2 runtime (boot the DCK on a stock TS2068, ticks compared with the interpreter)');
  const rt = JSON.parse(readFileSync(RT_JSON, 'utf8'));
  const img = new Uint8Array(readFileSync(join(dirname(RT_JSON), rt.image ?? 'runtime.bin')));
  const SYM = rt.symbols;
  const need = ['RT_SHOW', 'RT_HIDE', 'RT_HIT', 'RT_KEYDOWN', 'RT_AT', 'RT_PRINTS', 'RT_PRINTN', 'RT_INK', 'RT_PAPER', 'RT_BRIGHT', 'RT_CLS', 'RT_TILE', 'RT_TILEAT', 'RT_PLAY', 'RT_SILENCE', 'RT_MUL', 'RT_DIV', 'RT_MOD', 'RT_RND', 'RT_STICK',
    'CELL_TILE', 'CELL_ATTR', 'V_TEXT_ATTR', 'V_CUR_ROW', 'V_CUR_COL', 'V_SFX_ACTIVE', 'SPR_TAB', 'V_TICKS', 'V_FRAMES', 'V_SYNC', 'HO_MARK', 'HO_MARK_VALUE', 'V_SHADOW_FF', 'DFILE0', 'DATTR0', 'DFILE1', 'DATTR1'];
  const missing = need.filter((n) => SYM[n] === undefined);
  const C = rt.constants ?? {};
  check_('runtime.json has version 2 and every symbol the compiler and these tests use', rt.version === 2 && missing.length === 0, missing.join(' ') || `version ${rt.version}, ${Object.keys(SYM).length} symbols`);
  check_('runtime.json agrees with the compiler on the image: header 16 bytes, descriptors 8 bytes (phases at +6), inst_table at $800E, 16 instances, 8 assets',
    C.GAME_HEADER_LEN === 16 && C.SD_LEN === 8 && C.SD_PHASES === 6 && C.GAME_INSTTAB === 0x800E && C.MAX_SPRITES === 16 && C.MAX_ASSETS === 8, JSON.stringify([C.GAME_HEADER_LEN, C.SD_LEN, C.SD_PHASES, C.GAME_INSTTAB, C.MAX_SPRITES, C.MAX_ASSETS]));
  if (rt.version === 2 && missing.length === 0) {
    const ROMDIR = join(TSRUN, 'roms');
    const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
    // the keyboard as the hardware wires it (rows = port high byte $FE, $FD, ... $7F; bit 0 = the outer key); independent of the runtime
    const KEYROWS = ['\x01ZXCV', 'ASDFG', 'QWERT', '12345', '09876', 'POIUY', '\rLKJH', ' \x02MNB'];
    const KEYPOS = new Map(); KEYROWS.forEach((r, row) => [...r].forEach((ch, bit) => KEYPOS.set(ch.charCodeAt(0), [row, bit])));
    const ZX_ROW = (y) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);
    const FONT = (() => {
      const t = readFileSync(join(ROOT, 'arcade/runtime/v1/font.inc'), 'utf8');
      const bytes = [];
      for (const line of t.slice(t.indexOf('FONT_GLYPHS:')).split('\n').slice(1)) {
        const m = line.split(';')[0].match(/DB\s+(.*)/i);
        if (m) for (const v of m[1].split(',')) bytes.push(parseInt(v.trim().replace('$', ''), 16));
        if (bytes.length >= 768) break;
      }
      return bytes.slice(0, 768);
    })();
    /** cells + attributes + sprites (in instance order, x rounded down for fewer phases) -> a 256 x 192 ink plane (row-major bytes) */
    function compose(rec, ctx, res) {
      const plane = new Uint8Array(192 * 32);
      for (let cell = 0; cell < 768; cell++) {
        const v = rec.cells[cell], cr = (cell / 32) | 0, cc = cell % 32;
        for (let y = 0; y < 8; y++) plane[(cr * 8 + y) * 32 + cc] = v & 0x80 ? ctx.tileBytes[(v & 0x7F) * 9 + y] : (v >= 32 && v < 128 ? FONT[(v - 32) * 8 + y] : 0);
      }
      const insts = res.gen.v2.instAssets, assets = res.gen.sprites;
      rec.sprites.forEach((sp, i) => {
        if (!sp.visible || i >= insts.length) return;
        const a = assets[insts[i]], d = a.data, x0 = roundX(sp.x, a.phases ?? 8);
        for (let r = 0; r < a.h; r++) {
          const mask = (d[4 * r] << 8) | d[4 * r + 1], image = (d[4 * r + 2] << 8) | d[4 * r + 3];
          for (let b = 0; b < 16; b++) {
            if ((mask >> (15 - b)) & 1) continue;
            const px = x0 + b, py = sp.y + r;
            if (px > 255 || py > 191) continue;
            const bit = 0x80 >> (px & 7), at = py * 32 + (px >> 3);
            plane[at] = (image >> (15 - b)) & 1 ? plane[at] | bit : plane[at] & ~bit;
          }
        }
      });
      return plane;
    }
    function displayed(m) {
      const file = m.ram[SYM.V_SHADOW_FF] & 7;
      const bmp = file === 0 ? SYM.DFILE0 : SYM.DFILE1, att = file === 0 ? SYM.DATTR0 : SYM.DATTR1;
      const plane = new Uint8Array(192 * 32);
      for (let y = 0; y < 192; y++) for (let x = 0; x < 32; x++) plane[y * 32 + x] = m.ram[bmp + ZX_ROW(y) + x];
      return { plane, attrs: m.ram.slice(att, att + 768), file };
    }
    function diffPicture(label, got, want, wantPlane) {
      if (process.env.ARCADE_DUMP) {
        const bad = [];
        for (let y = 0; y < 192; y++) for (let x = 0; x < 32; x++) if (got.plane[y * 32 + x] !== wantPlane[y * 32 + x]) bad.push(`(${y},${x}) got $${got.plane[y * 32 + x].toString(16)} want $${wantPlane[y * 32 + x].toString(16)}`);
        if (bad.length) console.log(`   ${label}: ${bad.length} differing bytes: ${bad.slice(0, 14).join('; ')}`);
      }
      for (let i = 0; i < 768; i++) if (got.attrs[i] !== want.attrs[i]) return `${label}: displayed attribute (row ${(i / 32) | 0}, col ${i % 32}) = $${got.attrs[i].toString(16)}, expected $${want.attrs[i].toString(16)}`;
      for (let y = 0; y < 192; y++) for (let x = 0; x < 32; x++) {
        const a = got.plane[y * 32 + x], b = wantPlane[y * 32 + x];
        if (a !== b) return `${label}: displayed pixel byte at row ${y}, byte column ${x} = $${a.toString(16)}, compositor $${b.toString(16)}`;
      }
      return null;
    }
    /** Boot the DCK and run until `ticks` ticks have completed; one snapshot per tick, optional displayed pictures and tick costs. */
    function runReal(res, { ticks, stick = null, keys = null, pictures = false, measure = false }) {
      const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
      const must = (e) => { if (e) throw new Error(e); };
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
        cursor: { row: m.ram[SYM.V_CUR_ROW], col: m.ram[SYM.V_CUR_COL] }, textAttr: m.ram[SYM.V_TEXT_ATTR],
        sfxActive: m.ram[SYM.V_SFX_ACTIVE], ay: SYM.AY_SHADOW !== undefined ? m.ram.slice(SYM.AY_SHADOW, SYM.AY_SHADOW + 16) : null,
      });
      const out = { ticks: [], error: null, machine: m, pictures: new Map(), costs: [], frameGaps: [] };
      const div = res.memory[0x8004];
      // tick cost: T-states from the main loop taking V_SYNC to 0 (the tick starts) to its writing the flip request (2 or 3)
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
      let pending = -1, lastTickFrame = -1, ffAtPending = 0;
      const codeLo = res.gen.base, codeHi = res.gen.base + res.gen.code.length;
      const maxFrames = 400 + (ticks + 2) * div * 4;
      for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
      if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
      // V_FRAMES at INIT's and each FRAME's first instruction fetch: the sound model needs to know in which refresh a PLAY happened
      const fe = res.map.entries.frame, ie = res.map.entries.init;
      // A call that a frame interrupt cut in two (entered at refresh f0, returned at f1 = f0 + 1) may take effect at either refresh (the runtime's contract,
      // arcade/tests/m15-runtime-music.mjs section 4: an effect is posted and installed by the next refresh): out.cuts lists them, the comparison below tries both
      // (as tests/arcade-m5-harness.mjs compareSoundRun does). out.plays[t][n] is the refresh the n-th call of tick t is placed at (its entry, f0, by default).
      out.R = [null]; out.S = [null]; out.plays = [[]]; out.cuts = [];
      let cur = 0;
      const open = [];
      const origRead = m.bus.read;
      m.bus.read = function (a) {
        if (a === fe) { out.R.push(rd16(SYM.V_FRAMES)); out.plays[++cur] = []; }
        else if (a === ie) { cur = 0; out.plays[0] = []; }
        else if (a === SYM.RT_PLAY || a === SYM.RT_SILENCE) {
          out.plays[cur].push(rd16(SYM.V_FRAMES));
          open.push({ t: cur, n: out.plays[cur].length - 1, f0: rd16(SYM.V_FRAMES), ret: rd16(m.cpu.sp), sp: m.cpu.sp });
        } else if (open.length) {
          const o = open[open.length - 1];
          if (a === o.ret && m.cpu.sp === ((o.sp + 2) & 0xFFFF)) { open.pop(); const f1 = rd16(SYM.V_FRAMES); if (f1 !== o.f0) out.cuts.push({ t: o.t, n: o.n, f0: o.f0, f1 }); }
        }
        return origRead.call(this, a);
      };
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
        // the picture of tick `pending` is on the screen once the shown file changes (the flip request can come a refresh after V_TICKS moved)
        if (pending >= 0 && nt === pending && (m.ram[SYM.V_SHADOW_FF] & 7) !== ffAtPending) { out.pictures.set(pending, displayed(m)); pending = -1; }
        else if (pending >= 0 && nt !== pending) pending = -1;
        if (nt === k - 1) continue;
        if (nt !== k) { out.error = `V_TICKS went from ${k - 1} to ${nt} in one refresh`; break; }
        if (m.cpu.pc >= codeLo && m.cpu.pc < codeHi) { out.error = `tick ${k}: compiled code still running at the end of its refresh (pc ${hex(m.cpu.pc)})`; break; }
        out.ticks.push(snap());
        out.S.push(rd16(SYM.V_FRAMES));
        if (lastTickFrame >= 0) out.frameGaps.push(rd16(SYM.V_FRAMES) - lastTickFrame);
        lastTickFrame = rd16(SYM.V_FRAMES);
        if (pictures && div >= 2 && k % 5 === 0) { pending = k; ffAtPending = m.ram[SYM.V_SHADOW_FF] & 7; }
      }
      if (!out.error && out.ticks.length < ticks) out.error = `only ${out.ticks.length} of ${ticks} ticks ran (V_TICKS ${rd16(SYM.V_TICKS)})`;
      return out;
    }
    const REAL_ASSETS = (c) => c.assets ?? ASSETS;
    for (const c of REAL) {
      let detail = '', ok = false;
      try {
        const assets = REAL_ASSETS(c);
        const res = compile(c.src, { runtime: rt, image: img, assets });
        if (res.errors.length) throw new Error('compile: ' + res.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
        const got = runReal(res, { ticks: c.ticks, stick: c.stick, keys: c.keys, pictures: !!c.pictures, measure: !!c.measure });
        if (got.error) throw new Error(got.error);
        if (process.env.ARCADE_DEBUG && c.name.includes(process.env.ARCADE_DEBUG)) { const a = +(process.env.ARCADE_FROM ?? 1); console.log('   R', got.R.slice(a, a + 14).join(','), ' S', got.S.slice(a, a + 14).join(','), ' active', got.ticks.slice(a - 1, a + 13).map((q) => q.sfxActive + ':' + q.ay[0]).join(',')); }
        const ctx = ctxFor(c.src, assets, c.skip ?? []);
        const runWith = () => {
          const clock = { play: (t, n) => got.plays[t][n - 1] ?? 0, sample: (t) => got.S[t] };
          const w = interpret(parse(c.src).ast, { version: 2, ticks: c.ticks, assets, maxSteps: 200_000_000, rnd: shRnd(rt), keys: c.keys ? (t, k) => c.keys(t).includes(k) : undefined, stick: c.stick ?? undefined, clock });
          const dd = diffRun({ init: null, ticks: got.ticks }, w, ctx);
          return { want: w, d: dd, at: dd === null ? Infinity : +(/tick (\d+)/.exec(dd)?.[1] ?? 0) };
        };
        // the cut calls in order: each at its entry refresh, else at its return refresh, whichever agrees up to the next cut call's tick (the last one: the whole run)
        let r = runWith();
        const cuts = got.cuts.sort((a, b) => a.t - b.t || a.n - b.n), placedLate = [];
        for (let i = 0; i < cuts.length && r.d !== null; i++) {
          const q = cuts[i], limit = i + 1 < cuts.length ? cuts[i + 1].t : Infinity;
          if (r.at >= limit) continue;                                        // this cut call agrees at its entry refresh as far as it can be judged
          got.plays[q.t][q.n] = q.f1;
          const r1 = runWith();
          if (r1.at > r.at) { r = r1; placedLate.push(`tick ${q.t}`); } else got.plays[q.t][q.n] = q.f0;
        }
        const want = r.want;
        let d = r.d;
        let pics = 0;
        if (d === null && c.pictures) for (const [k, pic] of got.pictures) {
          d = diffPicture(`picture after tick ${k} (file ${pic.file})`, pic, want.ticks[k - 1], compose(want.ticks[k - 1], ctx, res));
          if (d) break;
          pics++;
        }
        if (d && process.env.ARCADE_DEBUG2) { const m = d.match(/after tick (\d+)/); if (m) { const k = +m[1]; for (const kk of [k - 1, k, k + 1]) console.log('   tick', kk, 'R/S', got.R[kk], got.S[kk], 'sprites', want.ticks[kk - 1].sprites.map((q, i) => (q.visible ? `${i}@${q.x},${q.y}` : '')).filter(Boolean).join(' '), ' real', got.ticks[kk - 1].sprites.map((q, i) => (q.visible ? `${i}@${q.x},${q.y}` : '')).filter(Boolean).join(' ')); } }
        ok = d === null;
        detail = d ?? `${c.ticks} ticks${c.pictures ? `, ${pics} displayed pictures compared with the compositor (x rounded for phases)` : ''}${cuts.length ? `; ${cuts.length} sound call(s) cut by a frame interrupt${placedLate.length ? `, placed at their return refresh: ${placedLate.join(', ')}` : ''}` : ''}`;
        if (ok && c.measure) {
          const cs = got.costs.slice(2).sort((a, b) => a - b);        // the first two ticks draw the whole map into both files
          const frame = 58688, div = res.memory[0x8004];
          const med = cs[cs.length >> 1], worst = cs.at(-1), p95 = cs[Math.floor(cs.length * 0.95)];
          const gaps = got.R.slice(4).map((r, i) => r - got.R[i + 3]);           // refreshes between consecutive PROC FRAME calls, after the map-drawing ticks
          console.log(`  INFO  ${c.name}: tick cost on the real runtime over ${cs.length} ticks (after the 2 map-drawing ones: ${got.costs.slice(0, 2).join(', ')} T): median ${med} T, 95% ${p95} T, worst ${worst} T = ${(worst / frame).toFixed(2)} refreshes; frame_div ${div} = ${div * frame} T available; ticks that overran: ${cs.filter((x) => x > div * frame).length}; refreshes between PROC FRAME calls: min ${Math.min(...gaps)}, max ${Math.max(...gaps)} (frame_div ${div})`);
          if (c.shooter) shooterCosts = { med, worst, p95, div, over: cs.filter((x) => x > div * frame).length, maxGap: Math.max(...gaps), first: got.costs.slice(0, 2) };
        }
      } catch (e) { detail = e.message; }
      check_(`real runtime: ${c.name}`, ok, detail);
    }
    {   // the command line tool: arcadec --runtime v2 gives the same cartridge as compile()
      let ok = false, detail = '';
      try {
        const out = join(TMP, 'shooter-cli.dck');
        const txt = execFileSync('node', [join(ROOT, 'arcade/tools/arcadec.mjs'), SH_FILE, '--assets', join(ROOT, 'arcade/examples/shooter.assets.json'), '--runtime', 'v2', '-o', out], { encoding: 'utf8' });
        const want = compile(SH_SRC, { runtime: rt, image: img, assets: SH_ASSETS });
        const same = Buffer.compare(Buffer.from(readFileSync(out)), Buffer.from(want.dck)) === 0;
        ok = same && /0 errors/.test(txt) && /16 instances/.test(txt);
        detail = ok ? `${want.dck.length} bytes; ${txt.split('\n').find((l) => /game total/.test(l)).trim()}` : txt;
      } catch (e) { detail = e.message; }
      check_('arcadec.mjs --runtime v2 compiles shooter.arc to the same cartridge as compile()', ok, detail);
    }
  }
} else {
  console.log('\nR. End-to-end tests on the real v2 runtime: PENDING (arcade/build/v2/runtime.json does not exist yet).');
  console.log('   Build it (arcade/runtime/v2/) and run:  node tests/arcade-m4.mjs');
}

// ---------------------------------------------------------------------------------------------------------------------
// 9. The playable examples breakout.arc and bounce.arc (v2 runtime, keyboard O / P / space and joystick): compile clean, and 240
//    ticks of a scripted player on the mock match the interpreter (the paddle moves with the keys and with the stick).
// ---------------------------------------------------------------------------------------------------------------------
console.log('\n9. Examples breakout.arc and bounce.arc (v2): keyboard and joystick');
for (const name of ['breakout', 'bounce']) {
  const src = readFileSync(join(ROOT, `arcade/examples/${name}.arc`), 'utf8');
  const assets = JSON.parse(readFileSync(join(ROOT, `arcade/examples/${name}.assets.json`), 'utf8'));
  const r = compileM(src, assets);
  check_(`${name}.arc compiles for the v2 runtime with no errors and no warnings`, r.errors.length === 0 && r.warnings.length === 0, errText(r) + ' ' + r.warnings.map((w) => w.message).join(' | '));
  const keys = (t) => (t >= 20 && t < 60 ? [79] : t >= 80 && t < 140 ? [80] : t >= 200 ? [32] : []);   // O, then P, then space
  const stick = (t) => (t >= 150 && t < 190 ? 4 : 0);                                                      // joystick left
  const want = interpV2(src, 240, { assets, keys: (t, c) => keys(t).includes(c), stick });
  const px = (t) => want.ticks[t - 1].vars.PX;
  check_(`${name}.arc: the paddle moves left with O, right with P and left with the joystick`, px(55) < px(21) && px(135) > px(85) && px(185) < px(152), `${px(21)} ${px(55)} ${px(85)} ${px(135)} ${px(152)} ${px(185)}`);
  const got = runMock(r, { ticks: 240, stick, keys });
  const d = diffRun(got, want, ctxFor(src, assets, []));
  check_(`${name}.arc: 240 ticks on the mock match the interpreter`, d === null, d ?? '');
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-m4 (${passed} checks passed, ${failed} failed${notes ? `, ${notes} notes` : ''})`);
process.exitCode = failed ? 1 : 0;
