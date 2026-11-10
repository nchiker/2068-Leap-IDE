"use strict";
// arcade-m8-mock.mjs -- a MOCK runtime v4 for language batch 3 (the raycaster slice): the compiled Z80 code runs on TSRun's Z80 against JavaScript traps that implement the
// routines of docs/ARCADE_RAYCASTER_CONTRACT.md sections 2 and 3 (RT_VIEW, RT_COSA, RT_SINA, RT_FXMUL, RT_WALL, RT_SETWALL, and the ray-mode rules of RT_SHOW, RT_SHOWF, RT_HIDE,
// RT_HIT), written from the contract and from the DATA THE LINKER WROTE (the mock reads the header, view_desc, the descriptors and the instance table out of the image, as the
// real runtime does), NOT from arcade-view.js or the interpreter: the sine table here is computed from the definition (4096 * cos), the model of the array is per cell.
// It lets the code generator be tested before the real v4 runtime exists.
//   mockRuntime4()            -> the runtime.json-shaped object for compile()
//   compileMock4(src, assets)
//   runMock4(res, {ticks, stick, billboard}) -> {init, ticks: [snapshot], tstates}   snapshot = {vars, arrays, sprites, wallRam, pose, bb}
//     billboard(tick, instance) -> {depth, col} or undefined: written into BB_TAB when PROC FRAME of `tick` starts (the previous tick's draw, as the runtime leaves it)
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

const TMP = mkdtempSync(join(tmpdir(), 'arcade-m8-'));
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
const MOCK_BASE_ASM = (() => {          // RT_MUL / RT_DIV / RT_MOD / RT_RND / RT_STICK as in the earlier mocks
  const t = readFileSync(join(HERE, 'arcade-compile.mjs'), 'utf8');
  const a = t.indexOf('const MOCK_ASM = `'), b = t.indexOf('`;', a);
  return t.slice(a + 'const MOCK_ASM = `'.length, b);
})();
const BUILD = sjasm(MOCK_BASE_ASM, 'mockrt4');

const TRAPS = { RT_SHOW: 0xC4D0, RT_HIDE: 0xC4E0, RT_HIT: 0xC4A0, RT_SHOWF: 0xC600, RT_VIEW: 0xC700, RT_COSA: 0xC710, RT_SINA: 0xC720, RT_FXMUL: 0xC730, RT_WALL: 0xC740, RT_SETWALL: 0xC750 };
export const ADDR = { SPR_TAB: 0xD700, V_POSE: 0xE100, BB_TAB: 0xE140, BB_ENT: 4, WORLD_RAM: 0xEA00, RT_ARGS: 0xE060, RT_SEED: 0xE030, STICK_IN: 0xE034, GAME_VARS_BASE: 0xE200, GAME_VARS_LIMIT: 0xE9FF };
const image = new Uint8Array(65536);
image.set(BUILD.bytes, 0xC000);
for (const a of Object.values(TRAPS)) image[a] = 0xC9;
const HAVE_TRAP = new Set(Object.values(TRAPS));
export const MOCK_IMAGE = image;

export function mockRuntime4(extra = {}, symExtra = {}) {
  return {
    version: 4,
    symbols: { RT_MUL: BUILD.syms.RT_MUL, RT_DIV: BUILD.syms.RT_DIV, RT_MOD: BUILD.syms.RT_MOD, RT_RND: BUILD.syms.RT_RND, RT_STICK: BUILD.syms.RT_STICK, V_TICKS: 0xE000, ...TRAPS, SPR_TAB: ADDR.SPR_TAB, BB_TAB: ADDR.BB_TAB, ...symExtra },
    constants: {
      GAME_BASE: 0x8000, GAME_VARS_BASE: ADDR.GAME_VARS_BASE, GAME_VARS_LIMIT: ADDR.GAME_VARS_LIMIT, MAX_SPRITES: 16, MAX_ASSETS: 8, MAX_FRAMES: 32,
      SPR_ENT: 8, SPR_FRAME_OFF: 6, DIV_EXT: 0x80, DIV_VIEW: 0x40, GAME_HEADER_EXT_LEN: 18, GAME_MAPTAB: 0x8010, BB_ENT: ADDR.BB_ENT,
      WORLD_RAM: ADDR.WORLD_RAM, RT_ARGS: ADDR.RT_ARGS, RA_X: ADDR.RT_ARGS, RA_Y: ADDR.RT_ARGS + 2, RA_W: ADDR.RT_ARGS + 4, RA_H: ADDR.RT_ARGS + 6, RA_V: ADDR.RT_ARGS + 8, RA_DX: ADDR.RT_ARGS + 8, RA_DY: ADDR.RT_ARGS + 10,
      VIEW_W: 128, VIEW_H: 96,
      ...extra,
    },
  };
}
export const compileMock4 = (src, assets, rtExtra = {}, symExtra = {}) => compile(src, { runtime: mockRuntime4(rtExtra, symExtra), image, assets });

/** The cosine table from its definition: C[a] = round(4096 * cos(2 pi a / 256)) (the contract builds it from Q[k] = round(4096 sin(k pi / 128)) mirrored: the same numbers). */
export const COS4096 = Array.from({ length: 256 }, (_, a) => Math.round(4096 * Math.cos(2 * Math.PI * a / 256)));

/** Run the compiled game on the mock: PROC INIT, then `ticks` times PROC FRAME. */
export function runMock4(res, { ticks, stick = null, billboard = null }) {
  const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  m.ram.set(res.memory.subarray(0x4000), 0x4000);
  const ram = m.ram, cpu = m.cpu;
  ram.fill(0xA5, ADDR.GAME_VARS_BASE, ADDR.GAME_VARS_LIMIT + 1);     // the init stub clears the variables
  ram.fill(0, 0xE000, 0xE200);
  ram.fill(0, ADDR.SPR_TAB, ADDR.SPR_TAB + 128);
  const rd16 = (a) => ram[a] | (ram[a + 1] << 8);
  const wr16 = (a, v) => { ram[a] = v & 255; ram[a + 1] = (v >> 8) & 255; };
  ram[ADDR.RT_SEED] = 12345 & 255; ram[ADDR.RT_SEED + 1] = 12345 >> 8;
  // the header, as the runtime reads it
  const hdr = ram[0x8004];
  const descTab = rd16(0x8006), instTab = rd16(0x800E), ninst = ram[instTab];
  const vd = (hdr & 0x40) ? rd16(0x8012) : 0;
  const V = vd ? { colw: ram[vd], mapW: ram[vd + 1], mapH: ram[vd + 2], attrTop: ram[vd + 3], attrBottom: ram[vd + 4], srcAt: rd16(vd + 5), patAt: rd16(vd + 7), flags: ram[vd + 9] } : null;
  if (V) {            // the scene start: map_src (byte-RLE pairs count 1..255 / value, a count of 0 ends) expands to w x h cells, which go into the 32-stride array; everything else is wall type 1
    const flat = new Uint8Array(V.mapW * V.mapH);
    let o = 0;
    for (let p = V.srcAt; ram[p] !== 0 && o < flat.length; p += 2) for (let k = 0; k < ram[p] && o < flat.length; k++) flat[o++] = ram[p + 1];
    ram.fill(1, ADDR.WORLD_RAM, ADDR.WORLD_RAM + 1024);
    for (let r = 0; r < V.mapH; r++) for (let c = 0; c < V.mapW; c++) ram[ADDR.WORLD_RAM + r * 32 + c] = flat[r * V.mapW + c];
  }
  for (let i = 0; i < ninst; i++) ram[ADDR.SPR_TAB + 8 * i + 1] = ram[instTab + 1 + i];  // the asset of each instance, set at boot
  const hl = () => (cpu.h << 8) | cpu.l;
  const setHL = (v) => { cpu.h = (v >> 8) & 0xFF; cpu.l = v & 0xFF; };
  const bc = () => (cpu.b << 8) | cpu.c, de = () => (cpu.d << 8) | cpu.e;
  const arg = (k) => s16(rd16(ADDR.RT_ARGS + 2 * k));
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
    if (!V) { const d = descOf(asset(i)); x = Math.min(Math.max(x, 0), 256 - ram[d]); y = Math.min(Math.max(y, 0), 192 - ram[d + 1]); }      // non-view: per asset clamp
    store(i, x, y, frame);                                                                                                           // ray mode: the raw 16 bits
  };
  const cellAt = (cx, cy) => ram[ADDR.WORLD_RAM + cy * 32 + cx];
  const handlers = {
    [TRAPS.RT_SHOW]() { place(cpu.a, s16(bc()), s16(de()), null); },
    [TRAPS.RT_SHOWF]() { place(cpu.a, s16(bc()), s16(de()), hl() & 0xFF); },
    [TRAPS.RT_HIDE]() { if (cpu.a < ninst) ram[ADDR.SPR_TAB + 8 * cpu.a] = 0; },
    [TRAPS.RT_HIT]() {
      const a = cpu.a, b = cpu.e;
      if (a >= ninst || b >= ninst) { setHL(0); return; }
      const sp = (i) => ({ vis: ram[ADDR.SPR_TAB + 8 * i], x: rd16(ADDR.SPR_TAB + 8 * i + 2), y: rd16(ADDR.SPR_TAB + 8 * i + 4), h: ram[descOf(asset(i)) + 1], hot: [0, 1, 2, 3].map((k) => ram[rd16(descOf(asset(i)) + 4) + k]) });
      const A = sp(a), B = sp(b);
      if (!A.vis || !B.vis) { setHL(0); return; }
      if (V) {                                                  // ray mode: R = 4 h, |dx| < Ra + Rb and |dy| < Ra + Rb, the unsigned 16-bit positions
        const R = 4 * A.h + 4 * B.h;
        setHL(Math.abs(A.x - B.x) < R && Math.abs(A.y - B.y) < R ? 1 : 0);
        return;
      }
      const [ahx, ahy, ahw, ahh] = A.hot, [bhx, bhy, bhw, bhh] = B.hot;
      const ax = s16(A.x), ay = s16(A.y), bx = s16(B.x), by = s16(B.y);
      const al = ax + ahx, at = ay + ahy, bl = bx + bhx, bt = by + bhy;
      setHL(al < bl + bhw && bl < al + ahw && at < bt + bhh && bt < at + ahh ? 1 : 0);
    },
    [TRAPS.RT_VIEW]() {
      const clamp = (v, n) => Math.max(0, Math.min(v, n * 256 - 1));
      wr16(ADDR.V_POSE, clamp(s16(hl()), V.mapW)); wr16(ADDR.V_POSE + 2, clamp(s16(de()), V.mapH)); ram[ADDR.V_POSE + 4] = bc() & 0xFF;
    },
    [TRAPS.RT_COSA]() { setHL(((COS4096[hl() & 255] + 8) >> 4) & 0xFFFF); },
    [TRAPS.RT_SINA]() { setHL(((COS4096[((hl() & 255) + 192) & 255] + 8) >> 4) & 0xFFFF); },
    [TRAPS.RT_FXMUL]() { setHL(Math.floor(s16(hl()) * s16(de()) / 256) & 0xFFFF); },
    [TRAPS.RT_WALL]() {
      const x = s16(hl()), y = s16(de());
      setHL(x < 0 || y < 0 || x >= 8192 || y >= 8192 ? 1 : cellAt(x >> 8, y >> 8));
    },
    [TRAPS.RT_SETWALL]() {
      const x = arg(0), y = arg(1), t = arg(4);               // RA_V is the fifth word of the argument block (RA_X RA_Y RA_W RA_H RA_V)
      if (x >= 0 && y >= 0 && x < V.mapW * 256 && y < V.mapH * 256 && t >= 0 && t <= 4
          && !(t === 0 && ((x >> 8) === 0 || (y >> 8) === 0 || (x >> 8) === 31 || (y >> 8) === 31))) ram[ADDR.WORLD_RAM + (y >> 8) * 32 + (x >> 8)] = t;   // contract 2, clarification 7: a 0 on the array's ring is ignored
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
    wallRam: V ? ram.slice(ADDR.WORLD_RAM, ADDR.WORLD_RAM + 1024) : null,
    pose: V ? { x: rd16(ADDR.V_POSE), y: rd16(ADDR.V_POSE + 2), a: ram[ADDR.V_POSE + 4] } : null,
  });
  for (let i = 0; i < 16; i++) wr16(ADDR.BB_TAB + ADDR.BB_ENT * i + 2, 0xFFFF);       // nothing drawn yet: depth 0, col $FFFF (-1)
  const out = { init: null, ticks: [], tstates: [], view: V };
  call(res.map.entries.init);
  out.init = snap();
  for (let t = 1; t <= ticks; t++) {
    const sv = stick ? stick(t) : 0;
    ram[ADDR.STICK_IN] = typeof sv === 'number' ? sv : (sv[1] | 0); ram[ADDR.STICK_IN + 1] = typeof sv === 'number' ? 0 : (sv[2] | 0);
    if (billboard) for (let i = 0; i < 16; i++) { const b = billboard(t, i); wr16(ADDR.BB_TAB + ADDR.BB_ENT * i, b ? b.depth : 0); wr16(ADDR.BB_TAB + ADDR.BB_ENT * i + 2, b ? b.col : 0xFFFF); }
    const t0 = m.tstates;
    call(res.map.entries.frame);
    out.tstates.push(m.tstates - t0);
    out.ticks.push(snap());
  }
  return out;
}
