"use strict";
// m1-overrun.mjs -- M1 overrun test: the slow build (arcade/build/m1-slow.dck, main loop assembled with -DM1_SLOW)
// runs 400 frames on a stock TS2068 (TSRun).  Every 5th main-loop iteration burns about 80,000 T in its draw phase,
// which is more than one 58,688 T frame, so frame interrupts arrive while the main loop is busy (V_SYNC = 0).
//   node arcade/tests/m1-overrun.mjs
// The DCK is rebuilt first (arcade/tools/build-m1.mjs, slow: true).  The expected pictures are composed here, the same
// way as in m1.mjs (copied: that file runs its checks on import and exports nothing).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildM1 } from '../tools/build-m1.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TSRUN = join(HERE, '../../tsrun');
import { M, bootedMachine, bootSkip, pixelsOf } from './fast-boot.mjs';
const Z = await import(pathToFileURL(join(TSRUN, 'z80.js')).href);
const FRAME_T = M.tStatesPerFrame;                    // 58,688 on TSRun
const FIRST_PIXEL_T = 40 * 224 + 32;                  // TSRun's raster: first pixel line, T after the frame interrupt
const SCR_X0 = 64, SCR_Y0 = 24, FRAME_W = 640;        // frame buffer: 256 pixels doubled horizontally
const NFRAMES = 400;

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  ok ? passed++ : failed++;
  return ok;
};
const hex = (v, w = 4) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

// ---- build and boot -------------------------------------------------------------------------------------------
const { dck, img, syms } = buildM1({ slow: true });
console.log('M1 overrun test: boot m1-slow.dck (every 5th iteration burns ~80,000 T) on a stock TS2068 (TSRun)\n');
console.log(`  ${dck.length} bytes; WORK_START ${hex(syms.WORK_START)}, WORK_END ${hex(syms.WORK_END)}, ISR ${hex(syms.ISR)}`);
const BURN = syms['WORK_START.m1s_burn'];
if (BURN === undefined) throw new Error('the slow build has no burn label: is -DM1_SLOW passed?');
const BURN_LD = BURN - 3;                              // the `ld de,3077` just before the burn loop: entered once per burn

const keyMatrix = new Uint8Array(9).fill(0x1F);
const joystick = new Uint8Array(2).fill(0xFF);
const m = bootedMachine(dck, { keyMatrix, joystick, video: true });      // restored from the boot snapshot (V9); this test reads m.pixels, so video is on (V8)

const rd8 = (a) => m.ram[a];
const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);

console.log('\nBoot');
let entryFrame = -1;
for (let f = 1; f <= 400; f++) {
  M.runFrame(m);
  if (rd16(syms.HO_MARK) === 0x5AA5) { entryFrame = f + bootSkip(m); break; }
}
check('the cartridge entry is reached from reset', entryFrame > 0, `after ${entryFrame} frames`);
for (let b = 0; b < 60 && rd16(syms.V_FRAMES) === 0; b++) M.runFrame(m);
check('the frame interrupt starts', rd16(syms.V_FRAMES) >= 1, `FRAMES = ${rd16(syms.V_FRAMES)}`);
if (img[BURN_LD] !== 0x11) throw new Error(`no LD DE,nn at ${hex(BURN_LD)}`);   // $11 = LD DE,nn (in the image: chunk 4 is the DOCK)

// ---- expected pictures (as m1.mjs) ------------------------------------------------------------------------------
const SPR = syms.SPRITE;
const spriteRows = Array.from({ length: 16 }, (_, r) => ({
  mask: (img[SPR + r * 4] << 8) | img[SPR + r * 4 + 1],
  image: (img[SPR + r * 4 + 2] << 8) | img[SPR + r * 4 + 3],
}));
/** Expected 256x192 pixel plane (1 = ink): checkerboard background, sprite composed over it. */
function expectedPlane(sx, sy) {
  const plane = new Uint8Array(256 * 192);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) plane[y * 256 + x] = ((x + y) & 1) === 0 ? 1 : 0;
  for (let r = 0; r < 16; r++) for (let i = 0; i < 16; i++) {
    const keepBg = (spriteRows[r].mask >> (15 - i)) & 1;
    const ink = (spriteRows[r].image >> (15 - i)) & 1;
    if (!keepBg) plane[(sy + r) * 256 + sx + i] = ink;
  }
  return plane;
}
/** Screen pixel plane from the frame buffer (ink 0 -> 1, paper 7 -> 0), or null if a pixel is neither or doubled unevenly. */
function shownPlane() {
  const px = pixelsOf(m);                                   // throws when the machine was made with video off (V8)
  const plane = new Uint8Array(256 * 192);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const a = px[(SCR_Y0 + y) * FRAME_W + SCR_X0 + 2 * x], b = px[(SCR_Y0 + y) * FRAME_W + SCR_X0 + 2 * x + 1];
    if (a !== b) return null;
    plane[y * 256 + x] = a === 0 ? 1 : a === 7 ? 0 : 2;
  }
  return plane;
}
/** Bitmap bits of rows sy..sy+15, byte columns sx>>3 .. +2 in display file `file` (24 x 16 pixels, 1 = ink). */
function ramRect(file, sx, sy) {
  const out = [];
  const base = file ? 0x6000 : 0x4000;
  for (let r = 0; r < 16; r++) {
    const y = sy + r;
    const rowAddr = base + ((y & 0xC0) << 5) + ((y & 7) << 8) + ((y & 0x38) << 2) + (sx >> 3);
    for (let c = 0; c < 3; c++) for (let b = 7; b >= 0; b--) out.push((rd8(rowAddr + c) >> b) & 1);
  }
  return out;
}
/** The same 24 x 16 rectangle of the expected picture for a sprite drawn at (sx, sy). Cached per position. */
const rectCache = new Map();
function expectedRectAt(sx, sy) {
  const key = sx * 256 + sy;
  let out = rectCache.get(key);
  if (out) return out;
  out = [];
  const x0 = (sx >> 3) * 8;
  for (let r = 0; r < 16; r++) for (let i = 0; i < 24; i++) {
    const X = x0 + i, Y = sy + r;
    let v = ((X + Y) & 1) === 0 ? 1 : 0;
    const dx = X - sx, dy = Y - sy;
    if (dx >= 0 && dx < 16 && dy >= 0 && dy < 16 && !((spriteRows[dy].mask >> (15 - dx)) & 1)) v = (spriteRows[dy].image >> (15 - dx)) & 1;
    out.push(v);
  }
  rectCache.set(key, out);
  return out;
}

// ---- 400 frames, every instruction observed ----------------------------------------------------------------------
console.log(`\nRunning ${NFRAMES} frames from the first interrupt (every instruction observed)`);
const stats = {
  frames: 0, missed: 0, pcBad: 0, spBad: 0, spMin: 0xFFFF, spMax: 0,
  iters: [], inWork: false, cur: null, burns: 0, workChecks: 0, workTorn: 0, firstWorkTorn: null,
  fullMatch: 0, fullBad: 0, firstFullBad: null, unreadable: 0,
  displayChanges: 0, flipMismatch: 0, positions: new Set(), reversalsX: 0, reversalsY: 0, outOfRange: 0,
  prevFrames: rd16(syms.V_FRAMES), prevBit: m.portFF & 1, prevPos: null, notMoved: 0, shadowBad: 0,
};
let ffWrites = [];
const origOut = m.bus.ioWrite;
m.bus.ioWrite = (port, v) => {
  if ((port & 0xFF) === 0xFF) ffWrites.push({ rel: m.tstates - m.frameStart, v });
  origOut(port, v);
};
const ISR = syms.ISR, ISR_END = syms.ISR_END, WS = syms.WORK_START, WE = syms.WORK_END;
const isCart = (pc) => pc < 0x4000 || (pc >= 0x8000 && pc < 0xC000);   // DOCK chunks 0,1 and 4,5 (F4 = $33)
let lastIsrT = -1;
function hook() {
  const cpu = m.cpu, pc = cpu.pc, sp = cpu.sp;
  if (!isCart(pc)) stats.pcBad++;
  if (sp < 0xE000 || sp > 0xFF00) stats.spBad++;
  if (sp < stats.spMin) stats.spMin = sp;
  if (sp > stats.spMax) stats.spMax = sp;
  if (pc === WS) {
    stats.cur = { c0: rd16(syms.V_FRAMES), t0: m.tstates, pos0: [rd8(syms.V_SPR_X), rd8(syms.V_SPR_Y)] };
    stats.inWork = true;
  }
  if (pc === BURN_LD) stats.burns++;
  if (stats.inWork) {
    // the displayed file (bit 0 of the port, unchanged during work) must show its last COMPLETE sprite, at every instruction
    const bit = m.portFF & 1;
    const sx = rd8(syms.V_DRAWN + bit * 2), sy = rd8(syms.V_DRAWN + bit * 2 + 1);
    const got = ramRect(bit, sx, sy), exp = expectedRectAt(sx, sy);
    let ok = true;
    for (let i = 0; i < exp.length; i++) if (got[i] !== exp[i]) { ok = false; break; }
    stats.workChecks++;
    if (!ok) {
      stats.workTorn++;
      if (!stats.firstWorkTorn) stats.firstWorkTorn = { pc: hex(pc), frame: stats.frames, file: bit + 1, at: [sx, sy] };
    }
  }
  if (pc === WE && stats.cur) {
    const fr = rd16(syms.V_FRAMES);
    const span = (fr - stats.cur.c0) & 0xFFFF;             // frame interrupts during this iteration
    const x = rd8(syms.V_SPR_X), y = rd8(syms.V_SPR_Y);
    stats.iters.push({ span, t: m.tstates - stats.cur.t0, frame: stats.frames });
    if (stats.prevPos && stats.prevPos[0] === x && stats.prevPos[1] === y) stats.notMoved++;
    stats.prevPos = [x, y];
    stats.cur = null;
    stats.inWork = false;
  }
}

for (let f = 0; f < NFRAMES; f++) {
  ffWrites = [];
  // step to just before the frame end, then let runFrame finish (it also raises the frame interrupt)
  const end = m.frameStart + FRAME_T;
  while (m.tstates < end - 64) {
    if (m.cpu.halted) break;
    hook();
    Z.runZ80(m.cpu, m.bus, 1, m);
  }
  M.runFrame(m);
  stats.frames++;

  // frame counter: exactly one more than the previous frame
  const fr = rd16(syms.V_FRAMES);
  if (((fr - stats.prevFrames) & 0xFFFF) !== 1) stats.missed++;
  stats.prevFrames = fr;

  // display file: changes exactly when this frame's interrupt carried a flip request (the ISR's OUT $FF)
  const bit = m.portFF & 1;
  const flipped = ffWrites.length > 0;
  if (bit !== stats.prevBit) stats.displayChanges++;
  if ((bit !== stats.prevBit) !== flipped) stats.flipMismatch++;
  stats.prevBit = bit;
  if (rd8(syms.V_SHADOW_FF) !== m.portFF) stats.shadowBad++;

  // sprite variables
  const x = rd8(syms.V_SPR_X), y = rd8(syms.V_SPR_Y);
  if (x > 239 || y > 176) stats.outOfRange++;
  stats.positions.add(x * 256 + y);
  const dx = (rd8(syms.V_SPR_DX) << 24) >> 24;
  const dy = (rd8(syms.V_SPR_DY) << 24) >> 24;
  if (stats.lastDx !== undefined && Math.sign(dx) !== Math.sign(stats.lastDx)) stats.reversalsX++;
  if (stats.lastDy !== undefined && Math.sign(dy) !== Math.sign(stats.lastDy)) stats.reversalsY++;
  stats.lastDx = dx; stats.lastDy = dy;

  // whole screen at the frame end: the displayed file's sprite at the position it was last completely drawn
  const dx0 = rd8(syms.V_DRAWN + bit * 2), dy0 = rd8(syms.V_DRAWN + bit * 2 + 1);
  const shown = shownPlane();
  if (shown === null || shown.includes(2)) { stats.unreadable++; stats.fullBad++; continue; }
  const exp = expectedPlane(dx0, dy0);
  let bad = 0;
  for (let i = 0; i < exp.length; i++) if (exp[i] !== shown[i]) bad++;
  if (bad === 0) stats.fullMatch++;
  else { stats.fullBad++; if (!stats.firstFullBad) stats.firstFullBad = { frame: f, bad, at: [dx0, dy0], file: bit + 1 }; }
}

// ---- results ---------------------------------------------------------------------------------------------------
const iters = stats.iters;
const overruns = iters.filter((it) => it.span > 0);
const skipped = iters.reduce((s, it) => s + it.span, 0);
const hist = {};
for (const it of overruns) hist[it.span] = (hist[it.span] ?? 0) + 1;
const maxWork = Math.max(...iters.map((it) => it.t));
const avgWork = iters.reduce((s, it) => s + it.t, 0) / iters.length;

console.log('Crash');
check('PC stays in cartridge code ($0000-$3FFF, $8000-$BFFF) for every instruction', stats.pcBad === 0, `${stats.pcBad} instructions outside`);
check('SP stays within chunk 7 ($E000-$FF00) for every instruction', stats.spBad === 0,
  `min ${hex(stats.spMin)} max ${hex(stats.spMax)}`);
check('the main loop ran', iters.length > 0, `${iters.length} iterations`);

console.log('Overrun');
check('the overrun happened: some iteration took more than one frame', overruns.length > 0 && maxWork > FRAME_T,
  `${overruns.length} overrunning iterations, longest work ${maxWork} T (frame ${FRAME_T} T)`);
check('the burn ran in every 5th iteration (about iterations / 5 passes)', Math.abs(stats.burns - Math.floor(iters.length / 5)) <= 1,
  `${stats.burns} burn passes in ${iters.length} iterations`);

console.log('Frame counter and flips');
check(`frame counter advanced exactly once per frame for ${NFRAMES} frames`, stats.missed === 0, `${stats.missed} frames off`);
check('the displayed file changes exactly in the frames whose interrupt flipped',
  stats.flipMismatch === 0 && stats.shadowBad === 0, `${stats.flipMismatch} mismatched frames`);
check('every interrupt during an overrun skipped its flip (skipped flips = refreshes taken during work)',
  NFRAMES - stats.displayChanges === skipped, `${NFRAMES - stats.displayChanges} frames without a flip, ${skipped} refreshes during work`);

console.log('Tearing');
check('no frame shows a half-drawn or half-erased sprite (whole screen at every frame end)',
  stats.fullMatch === NFRAMES && stats.unreadable === 0,
  stats.firstFullBad ? `first bad frame ${JSON.stringify(stats.firstFullBad)}` : `${stats.fullMatch}/${NFRAMES} frames match`);
check('the displayed sprite is complete at every instruction of the main loop (incl. the burn)', stats.workTorn === 0,
  stats.firstWorkTorn ? `first bad ${JSON.stringify(stats.firstWorkTorn)}` : `${stats.workChecks} instruction checks`);

console.log('Sprite');
check('the sprite moved in every iteration (no iteration left it in place)', stats.notMoved === 0 && iters.length > 0,
  `${stats.notMoved} iterations without a move`);
check('the sprite keeps moving: more than 100 distinct positions', stats.positions.size > 100, `${stats.positions.size} positions`);
check('the sprite bounces in both axes', stats.reversalsX >= 2 && stats.reversalsY >= 2,
  `x reversals ${stats.reversalsX}, y reversals ${stats.reversalsY}`);
check('position stays in range (x <= 239, y <= 176)', stats.outOfRange === 0);

console.log('\nRefreshes per iteration');
console.log(`  iterations ${iters.length}, overrunning ${overruns.length}; refreshes (frame interrupts) taken during the overrunning iterations: ${JSON.stringify(hist)} (span -> count)`);
console.log(`  flips skipped: ${NFRAMES - stats.displayChanges} of ${NFRAMES} frames; work per iteration avg ${avgWork.toFixed(0)} T, longest ${maxWork} T`);

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: M1 overrun (${passed} checks passed, ${failed} failed)`);
process.exitCode = failed === 0 ? 0 : 1;
