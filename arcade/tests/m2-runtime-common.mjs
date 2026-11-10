"use strict";
// m2-runtime-common.mjs -- shared helpers of the M2 runtime tests (m2-runtime.mjs, m2-runtime-math.mjs, m2-runtime-regs.mjs):
// building the runtime and the test game, booting a stock TS2068 (TSRun) with the cartridge, direct calls of runtime
// routines, and the JavaScript models (the test game's pattern, the expected picture, the RT_RND generator).
// Nothing here shares code with the Z80 side: the models are written from the contract and from test_game.asm's header.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildRuntime, assembleGame, linkGame, dckOf, RUNTIME_DIR } from '../tools/build-runtime.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TSRUN = join(HERE, '../../tsrun');
export const M = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
export const Z = await import(pathToFileURL(join(TSRUN, 'z80.js')).href);
export const FRAME_T = M.tStatesPerFrame;                 // 58,688 on TSRun
export const FIRST_PIXEL_T = 40 * 224 + 32;               // TSRun's raster: first pixel line, T after the frame interrupt
export const SCR_X0 = 64, SCR_Y0 = 24, FRAME_W = 640;     // frame buffer: 256 pixels doubled horizontally

export const hex = (v, w = 4) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');
export const int16 = (v) => (v << 16) >> 16;

/** A tiny check recorder: const t = makeChecks(); t.check(name, ok, detail); t.finish('label'). */
export function makeChecks() {
  let passed = 0, failed = 0;
  const check = (name, ok, detail = '') => {
    console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
    ok ? passed++ : failed++;
    return ok;
  };
  const finish = (label) => {
    console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${label} (${passed} checks passed, ${failed} failed)`);
    process.exitCode = failed === 0 ? 0 : 1;
  };
  return { check, finish, get failed() { return failed; } };
}

// ---- builds ---------------------------------------------------------------------------------------------------
let _rt = null;
/** Build the runtime once per process. */
export function runtime() { return (_rt ??= buildRuntime()); }

/** Assemble test_game.asm with the options and link it into the runtime image: { img, dck, bytes, gsyms, syms }. */
export function testGame(defines = {}, name = 'test') {
  const rt = runtime();
  const g = assembleGame(join(RUNTIME_DIR, 'test_game.asm'), { name, defines });
  const img = linkGame(rt.img, g.bytes);
  return { img, dck: dckOf(img), bytes: g.bytes, gsyms: g.syms, syms: rt.syms };
}

/** test_game4.asm (four sprites) linked into the runtime image; same result shape as testGame(). */
export function testGame4(defines = {}, name = 'four') {
  const rt = runtime();
  const g = assembleGame(join(RUNTIME_DIR, 'test_game4.asm'), { name, defines });
  const img = linkGame(rt.img, g.bytes);
  return { img, dck: dckOf(img), bytes: g.bytes, gsyms: g.syms, syms: rt.syms };
}

/** The runtime booting alone, with its placeholder game image. */
export function placeholderGame() {
  const rt = runtime();
  return { img: rt.img, dck: rt.dck, bytes: rt.img.slice(0x8000, 0x8010), gsyms: {}, syms: rt.syms };
}

/** A stock TS2068 (TSRun) with the DCK inserted and reset. */
export function newMachine(dck) {
  const keyMatrix = new Uint8Array(9).fill(0x1F);
  const joystick = new Uint8Array(2).fill(0xFF);
  const m = M.createMachine(keyMatrix, joystick);
  const must = (e) => { if (e) throw new Error(e); };
  must(M.setHomeRom(m, readFileSync(join(TSRUN, 'roms/ts2068-0.rom'))));
  must(M.setExRom(m, readFileSync(join(TSRUN, 'roms/ts2068-1.rom'))));
  must(M.insertDock(m, dck));
  M.resetMachine(m);
  m.joystick = joystick;
  return m;
}

export const rd8 = (m, a) => m.ram[a];
export const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);

/** Run frames until the cartridge entry was reached and the frame interrupt counts (the boot is DI-protected). */
export function bootMachine(m, syms) {
  let entry = -1;
  for (let f = 1; f <= 400; f++) {
    M.runFrame(m);
    if (rd16(m, syms.HO_MARK) === 0x5AA5) { entry = f; break; }
  }
  let bootFrames = 0;
  for (; bootFrames < 60 && rd16(m, syms.V_FRAMES) === 0; bootFrames++) M.runFrame(m);
  return { entryFrame: entry, bootFrames };
}

// ---- direct calls ----------------------------------------------------------------------------------------------
const SENTINEL_RET = 0x0060;          // unused address in the runtime's chunk 0 (between the ISR and the NMI vector)
const CPU_KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl', 'sp', 'i', 'im', 'iff1'];
/**
 * Call a runtime routine directly: set the registers, push a return address, run until it returns.  Interrupts stay
 * off for the call.  IX, IY and the alternate set get sentinel values; the result says whether they survived.
 * @returns {{ hl, de, bc, a, t, preserved, spOk }}  t = T-states from the first instruction to the RET inclusive
 */
export function callRoutine(m, addr, { a = 0, hl = 0, de = 0, bc = 0, sentinels = true } = {}) {
  const cpu = m.cpu;
  const saved = Object.fromEntries(CPU_KEYS.map((k) => [k, cpu[k]]));
  const savedPc = cpu.pc, savedHalted = cpu.halted, savedEi = cpu.eiDelay;
  cpu.a = a & 0xFF; cpu.h = (hl >> 8) & 0xFF; cpu.l = hl & 0xFF; cpu.d = (de >> 8) & 0xFF; cpu.e = de & 0xFF;
  cpu.b = (bc >> 8) & 0xFF; cpu.c = bc & 0xFF;
  const sent = { a2: 0x11, f2: 0x22, b2: 0x33, c2: 0x44, d2: 0x55, e2: 0x66, h2: 0x77, l2: 0x88, xh: 0x99, xl: 0xAA, yh: 0xBB, yl: 0xCC };
  if (sentinels) Object.assign(cpu, sent);
  cpu.iff1 = false;
  cpu.halted = false; cpu.eiDelay = false;
  const sp0 = cpu.sp;
  cpu.sp = (sp0 - 2) & 0xFFFF;
  m.bus.write(cpu.sp, SENTINEL_RET & 0xFF);
  m.bus.write(cpu.sp + 1, SENTINEL_RET >> 8);
  cpu.pc = addr;
  const t0 = m.tstates;
  let steps = 0;
  while (cpu.pc !== SENTINEL_RET && steps++ < 200000) Z.runZ80(cpu, m.bus, 1, m);
  if (cpu.pc !== SENTINEL_RET) throw new Error(`routine at ${hex(addr)} did not return`);
  const t = m.tstates - t0;
  const out = { hl: (cpu.h << 8) | cpu.l, de: (cpu.d << 8) | cpu.e, bc: (cpu.b << 8) | cpu.c, a: cpu.a, t,
    spOk: cpu.sp === sp0 };
  out.preserved = !sentinels || Object.keys(sent).every((k) => cpu[k] === sent[k]);
  // put the machine back as it was
  for (const k of CPU_KEYS) cpu[k] = saved[k];
  cpu.pc = savedPc; cpu.halted = savedHalted; cpu.eiDelay = savedEi;
  return out;
}

// ---- JavaScript models -----------------------------------------------------------------------------------------
/** RT_RND reference: x ^= x << 7; x ^= x >> 9; x ^= x << 8 (16 bit); the result is the new state AND $7FFF. */
export function rndStep(x) {
  x = (x ^ (x << 7)) & 0xFFFF;
  x ^= x >> 9;
  x = (x ^ (x << 8)) & 0xFFFF;
  return x;
}
export const refMul = (a, b) => int16(Math.imul(a, b));
export const refDiv = (a, b) => (b === 0 ? 0 : int16(Math.trunc(a / b)));
export const refMod = (a, b) => (b === 0 ? 0 : (a % b) | 0);
export const clamp = (v, hi) => (v < 0 ? 0 : v > hi ? hi : v);

/** The test game (test_game.asm header): the calls frame_entry makes at tick t, given the two RT_RND outputs. */
export function gameCalls(t, r1, r2) {
  const x0 = 8 + refMod(refMul(t, 3), 200);
  const y0 = 20 + refMod(refDiv(t, 2), 140);
  let x1 = x0 + 6 + (refMod(r1, 5) - 2);
  let y1 = y0 + 3 + (refMod(r2, 5) - 2);
  if (t % 16 === 15) x1 = x0 + 400;
  if (t % 20 === 19) y1 = -30;
  const calls = [{ op: 'show', i: 0, x: x0, y: y0 }];
  if (t % 32 === 31) calls.push({ op: 'hide', i: 1 });
  else calls.push({ op: 'show', i: 1, x: x1, y: y1 });
  return calls;
}

/** Sprite pixel data read from the assembled game image (bytes from GAME_BASE): rows of { mask, image } words. */
export function spriteRows(bytes, addr, height) {
  const o = addr - 0x8000;
  return Array.from({ length: height }, (_, r) => ({
    mask: (bytes[o + r * 4] << 8) | bytes[o + r * 4 + 1],
    image: (bytes[o + r * 4 + 2] << 8) | bytes[o + r * 4 + 3],
  }));
}

/** Expected 256x192 ink plane (1 = ink): the checkerboard background ($AA on even rows) with the sprites composed in index order. */
export function expectedPlane(sprites) {
  const plane = new Uint8Array(256 * 192);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) plane[y * 256 + x] = ((x + y) & 1) === 0 ? 1 : 0;
  for (const s of sprites) {
    if (!s || !s.visible) continue;
    for (let r = 0; r < s.rows.length; r++) for (let i = 0; i < 16; i++) {
      const keep = (s.rows[r].mask >> (15 - i)) & 1;
      if (!keep) plane[(s.y + r) * 256 + s.x + i] = (s.rows[r].image >> (15 - i)) & 1;
    }
  }
  return plane;
}

/** The frame buffer as a 256x192 plane (ink colour 0 -> 1, paper 7 -> 0), or null if a pixel is neither / unevenly doubled. */
export function shownPlane(m) {
  const plane = new Uint8Array(256 * 192);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const a = m.pixels[(SCR_Y0 + y) * FRAME_W + SCR_X0 + 2 * x], b = m.pixels[(SCR_Y0 + y) * FRAME_W + SCR_X0 + 2 * x + 1];
    if (a !== b) return null;
    plane[y * 256 + x] = a === 0 ? 1 : a === 7 ? 0 : 2;
  }
  return plane;
}
