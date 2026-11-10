"use strict";
// arcade-m6-mock.mjs -- a MOCK runtime v3 for language batch 2: the compiled Z80 code runs on TSRun's Z80 against JavaScript traps that implement the routines
// of docs/ARCADE_PLATFORMER_CONTRACT.md 3b / 4 / 5 (RT_SHOW, RT_SHOWF, RT_HIDE, RT_HIT, RT_CAMERA, RT_WORLDTILE, RT_TILEFLAGS, RT_TILEHIT, RT_SETWORLD), written
// from the contract and from the DATA THE LINKER WROTE (the mock reads window_desc, the descriptors and the instance table out of the image, as the real
// runtime does), NOT from arcade-window.js or the interpreter. It lets the code generator be tested before the real v3 runtime has these routines.
//   mockRuntime()          -> {runtime, image}   for compile()
//   compileMock(src, assets)
//   runMock(res, {ticks, stick}) -> {init, ticks: [snapshot]}   snapshot = {vars, arrays, sprites: [{visible, asset, x, y, frame, pad}], worldRam, cam}
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const M_ = await import(pathToFileURL(join(ROOT, 'tsrun/machine.js')).href);
const Z_ = await import(pathToFileURL(join(ROOT, 'tsrun/z80.js')).href);
export const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;

const TMP = mkdtempSync(join(tmpdir(), 'arcade-m6-'));
function sjasm(asmText, name) {
  const src = join(TMP, name + '.asm');
  writeFileSync(src, asmText);
  const bin = join(TMP, name + '.bin'), sym = join(TMP, name + '.sym');
  execFileSync('sjasmplus', ['--nologo', `--raw=${bin}`, `--sym=${sym}`, src], { stdio: ['ignore', 'pipe', 'pipe'] });
  const syms = {};
  for (const line of readFileSync(sym, 'utf8').split('\n')) {
    const m = line.match(/^(\S+):\s+EQU\s+0x([0-9A-Fa-f]+)/);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  return { bytes: new Uint8Array(readFileSync(bin)), syms };
}
const MOCK_BASE_ASM = (() => {
  const t = readFileSync(join(HERE, 'arcade-compile.mjs'), 'utf8');
  const a = t.indexOf('const MOCK_ASM = `'), b = t.indexOf('`;', a);
  return t.slice(a + 'const MOCK_ASM = `'.length, b);
})();
const BUILD = sjasm(MOCK_BASE_ASM, 'mockrt');

const TRAPS = { RT_SHOW: 0xC4D0, RT_HIDE: 0xC4E0, RT_HIT: 0xC4A0, RT_SHOWF: 0xC600, RT_CAMERA: 0xC610, RT_WORLDTILE: 0xC620, RT_TILEFLAGS: 0xC630, RT_TILEHIT: 0xC640, RT_SETWORLD: 0xC650 };
const STUBS = { RT_LOADMAP: 0xC660, RT_LOADMAPAT: 0xC670, RT_FILL: 0xC680, RT_COPY: 0xC690 };      // RET only: games that compile with them are not run
export const ADDR = { SPR_TAB: 0xD700, V_CAM: 0xE110, WORLD_RAM: 0xEA00, RT_ARGS: 0xE060, RT_SEED: 0xE030, STICK_IN: 0xE034, GAME_VARS_BASE: 0xE200, GAME_VARS_LIMIT: 0xE9FF };
const image = new Uint8Array(65536);
image.set(BUILD.bytes, 0xC000);
for (const a of [...Object.values(TRAPS), ...Object.values(STUBS)]) image[a] = 0xC9;
const HAVE_TRAP = new Set(Object.values(TRAPS));

export function mockRuntime(extra = {}) {
  return {
    version: 3,
    symbols: { RT_MUL: BUILD.syms.RT_MUL, RT_DIV: BUILD.syms.RT_DIV, RT_MOD: BUILD.syms.RT_MOD, RT_RND: BUILD.syms.RT_RND, RT_STICK: BUILD.syms.RT_STICK, V_TICKS: 0xE000, ...TRAPS, ...STUBS, SPR_TAB: ADDR.SPR_TAB },
    constants: {
      GAME_BASE: 0x8000, GAME_VARS_BASE: ADDR.GAME_VARS_BASE, GAME_VARS_LIMIT: ADDR.GAME_VARS_LIMIT, MAX_SPRITES: 16, MAX_ASSETS: 8, MAX_FRAMES: 32,
      SPR_ENT: 8, SPR_FRAME_OFF: 6, DIV_EXT: 0x80, DIV_WIN: 0x40, GAME_HEADER_EXT_LEN: 18, GAME_MAPTAB: 0x8010,
      WORLD_RAM: ADDR.WORLD_RAM, V_CAM: ADDR.V_CAM, RT_ARGS: ADDR.RT_ARGS, RA_X: ADDR.RT_ARGS, RA_Y: ADDR.RT_ARGS + 2, RA_W: ADDR.RT_ARGS + 4, RA_H: ADDR.RT_ARGS + 6, RA_V: ADDR.RT_ARGS + 8, RA_DX: ADDR.RT_ARGS + 8, RA_DY: ADDR.RT_ARGS + 10,
      ...extra,
    },
  };
}
export const compileMock = (src, assets, rtExtra = {}) => compile(src, { runtime: mockRuntime(rtExtra), image, assets });

/** Run the compiled game on the mock: PROC INIT, then `ticks` times PROC FRAME. */
export function runMock(res, { ticks, stick = null }) {
  const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  m.ram.set(res.memory.subarray(0x4000), 0x4000);
  const ram = m.ram, cpu = m.cpu;
  ram.fill(0xA5, ADDR.GAME_VARS_BASE, ADDR.GAME_VARS_LIMIT + 1);     // the init stub clears the variables
  ram.fill(0, 0xE000, 0xE200);
  ram.fill(0, ADDR.SPR_TAB, ADDR.SPR_TAB + 128);
  const rd16 = (a) => ram[a] | (ram[a + 1] << 8);
  const wr16 = (a, v) => { ram[a] = v & 255; ram[a + 1] = (v >> 8) & 255; };
  ram[ADDR.RT_SEED] = 12345 & 255; ram[ADDR.RT_SEED + 1] = 12345 >> 8;
  const frameDiv = ram[0x8004];
  void frameDiv;
  // the header, as the runtime reads it
  const hdr = ram[0x8004];
  const descTab = rd16(0x8006), instTab = rd16(0x800E), ninst = ram[instTab];
  const win = (hdr & 0x40) ? rd16(0x8012) : 0;
  const W = win ? { cx: ram[win], cy: ram[win + 1], nbands: ram[win + 2], worldW: ram[win + 3], camMax: rd16(win + 4), tables: rd16(win + 6), flagsAt: rd16(win + 8), srcAt: rd16(win + 10), rowsAt: rd16(win + 12) } : null;
  if (W) {                                                                                  // decoded into WORLD_RAM when the scene starts: byte-RLE pairs (count 1..255, value), a count of 0 ends, at most 2,048 bytes, the rest 0
    let o = 0;
    for (let p = W.srcAt; ram[p] !== 0 && o < 2048; p += 2) for (let k = 0; k < ram[p] && o < 2048; k++) ram[ADDR.WORLD_RAM + o++] = ram[p + 1];
    while (o < 2048) ram[ADDR.WORLD_RAM + o++] = 0;
  }
  for (let i = 0; i < ninst; i++) ram[ADDR.SPR_TAB + 8 * i + 1] = ram[instTab + 1 + i];  // the asset of each instance, set at boot
  const hl = () => (cpu.h << 8) | cpu.l;
  const setHL = (v) => { cpu.h = (v >> 8) & 0xFF; cpu.l = v & 0xFF; };
  const bc = () => (cpu.b << 8) | cpu.c, de = () => (cpu.d << 8) | cpu.e;
  const arg = (k) => s16(rd16(ADDR.RT_ARGS + 2 * k));
  // ── the collision routines, per contract section 4, written per pixel ──
  const flagOfCell = (c, r) => {
    if (r >= 16) return 0;                                  // below the world: empty
    if (c < 0 || c >= W.worldW || r < 0) return 1;          // left, right, above: solid
    return ram[W.flagsAt + (ram[ADDR.WORLD_RAM + r * 128 + c] >> 3)];
  };
  const asset = (i) => ram[instTab + 1 + i];
  const descOf = (a) => descTab + 8 * a;
  const store = (i, x, y, frame) => {
    const e = ADDR.SPR_TAB + 8 * i;
    ram[e] = 1; ram[e + 1] = asset(i); wr16(e + 2, x); wr16(e + 4, y);
    if (frame !== null) ram[e + 6] = frame & 0xFF;
    ram[e + 7] = 0;
  };
  const place = (i, x, y, frame) => {
    if (i >= ninst) return;
    if (!W) { const d = descOf(asset(i)); x = Math.min(Math.max(x, 0), 256 - ram[d]); y = Math.min(Math.max(y, 0), 192 - ram[d + 1]); }      // non-window: per asset clamp
    store(i, x, y, frame);
  };
  const handlers = {
    [TRAPS.RT_SHOW]() { place(cpu.a, s16(bc()), s16(de()), null); },
    [TRAPS.RT_SHOWF]() { place(cpu.a, s16(bc()), s16(de()), hl() & 0xFF); },
    [TRAPS.RT_HIDE]() { if (cpu.a < ninst) ram[ADDR.SPR_TAB + 8 * cpu.a] = 0; },
    [TRAPS.RT_HIT]() {
      const a = cpu.a, b = cpu.e;
      if (a >= ninst || b >= ninst) { setHL(0); return; }
      const sp = (i) => ({ vis: ram[ADDR.SPR_TAB + 8 * i], x: s16(rd16(ADDR.SPR_TAB + 8 * i + 2)), y: s16(rd16(ADDR.SPR_TAB + 8 * i + 4)), hot: [0, 1, 2, 3].map((k) => ram[rd16(descOf(asset(i)) + 4) + k]) });
      const A = sp(a), B = sp(b);
      if (!A.vis || !B.vis) { setHL(0); return; }
      const [ahx, ahy, ahw, ahh] = A.hot, [bhx, bhy, bhw, bhh] = B.hot;
      const al = A.x + ahx, at = A.y + ahy, bl = B.x + bhx, bt = B.y + bhy;
      setHL(al < bl + bhw && bl < al + ahw && at < bt + bhh && bt < at + ahh ? 1 : 0);
    },
    [TRAPS.RT_CAMERA]() { wr16(ADDR.V_CAM, Math.max(0, Math.min(s16(hl()), W.camMax))); },
    [TRAPS.RT_WORLDTILE]() {
      const x = s16(hl()), y = s16(de()), c = Math.floor(x / 8), r = Math.floor(y / 8);
      setHL(c >= 0 && c < W.worldW && r >= 0 && r < 16 ? ram[ADDR.WORLD_RAM + r * 128 + c] >> 3 : 0);
    },
    [TRAPS.RT_TILEFLAGS]() { setHL(flagOfCell(Math.floor(s16(hl()) / 8), Math.floor(s16(de()) / 8))); },
    [TRAPS.RT_TILEHIT]() {
      const x = arg(0), y = arg(1), w = arg(2), h = arg(3), mask = rd16(ADDR.RT_ARGS + 8);
      let acc = 0;
      if (w >= 1 && h >= 1) for (let r = Math.floor(y / 8); r <= Math.floor((y + h - 1) / 8); r++) for (let c = Math.floor(x / 8); c <= Math.floor((x + w - 1) / 8); c++) acc |= flagOfCell(c, r) & mask & 0xFF;
      setHL(acc);
    },
    [TRAPS.RT_SETWORLD]() {
      const x = arg(0), y = arg(1), t = rd16(ADDR.RT_ARGS + 8), c = Math.floor(x / 8), r = Math.floor(y / 8);
      if (c >= 0 && c < W.worldW && r >= 0 && r < 16) ram[ADDR.WORLD_RAM + r * 128 + c] = (t * 8) & 0xFF;
    },
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
      if (++n > 12_000_000) throw new Error('runaway code');
    }
  };
  const nInst = Math.max(ninst, 4);
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    arrays: Object.fromEntries(Object.entries(res.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))])),
    sprites: Array.from({ length: nInst }, (_, i) => { const e = ADDR.SPR_TAB + 8 * i; return { visible: ram[e], asset: ram[e + 1], x: s16(rd16(e + 2)), y: s16(rd16(e + 4)), frame: ram[e + 6], pad: ram[e + 7] }; }),
    worldRam: W ? ram.slice(ADDR.WORLD_RAM, ADDR.WORLD_RAM + 2048) : null,
    cam: W ? rd16(ADDR.V_CAM) : 0,
  });
  const out = { init: null, ticks: [], tstates: [] };
  call(res.map.entries.init);
  out.init = snap();
  for (let t = 1; t <= ticks; t++) {
    const sv = stick ? stick(t) : 0;
    ram[ADDR.STICK_IN] = typeof sv === 'number' ? sv : (sv[1] | 0); ram[ADDR.STICK_IN + 1] = typeof sv === 'number' ? 0 : (sv[2] | 0);
    const t0 = m.tstates;
    call(res.map.entries.frame);
    out.tstates.push(m.tstates - t0);
    out.ticks.push(snap());
  }
  return out;
}
