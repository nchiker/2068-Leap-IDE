"use strict";
// m1.mjs -- milestone M1 test: boots arcade/build/m1.dck from reset on TSRun (stock ROMs) and checks the runtime.
//   node arcade/tests/m1.mjs
// The DCK is rebuilt first (arcade/tools/build-m1.mjs).  The expected screen is composed here, pixel by pixel, from
// the sprite table in the assembled image and the background rule; it shares no code with the Z80 blitter.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildM1, printUsage } from '../tools/build-m1.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TSRUN = join(HERE, '../../tsrun');
const M = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
const Z = await import(pathToFileURL(join(TSRUN, 'z80.js')).href);
const FRAME_T = M.tStatesPerFrame;                    // 58,688 on TSRun
const FIRST_PIXEL_T = 40 * 224 + 32;                  // TSRun's raster: first pixel line, T after the frame interrupt
const SCR_X0 = 64, SCR_Y0 = 24, FRAME_W = 640;        // frame buffer: 256 pixels doubled horizontally
const NFRAMES = 300;

let passed = 0, failed = 0;
const check = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  ok ? passed++ : failed++;
  return ok;
};
const hex = (v, w = 4) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

// ---- build and boot -------------------------------------------------------------------------------------------
const { dck, img, syms, usage } = buildM1();
console.log('M1 test: boot m1.dck on a stock TS2068 (TSRun)\n');
printUsage(usage, dck);
console.log('');

const keyMatrix = new Uint8Array(9).fill(0x1F);
const joystick = new Uint8Array(2).fill(0xFF);
const m = M.createMachine(keyMatrix, joystick);
const must = (e) => { if (e) throw new Error(e); };
must(M.setHomeRom(m, readFileSync(join(TSRUN, 'roms/ts2068-0.rom'))));
must(M.setExRom(m, readFileSync(join(TSRUN, 'roms/ts2068-1.rom'))));
must(M.insertDock(m, dck));
M.resetMachine(m);

const rd8 = (a) => m.ram[a];
const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
const VARS = syms.VARS, V = (n) => syms[n];

// ---- 1. entry --------------------------------------------------------------------------------------------------
console.log('Entry');
let entryFrame = -1;
for (let f = 1; f <= 400; f++) {
  M.runFrame(m);
  if (rd16(syms.HO_MARK) === 0x5AA5) { entryFrame = f; break; }
}
check('the cartridge entry is reached from reset', entryFrame > 0, `after ${entryFrame} frames (map says about 103)`);
check('entry frame is about 103 (98..110)', entryFrame >= 98 && entryFrame <= 110, `frame ${entryFrame}`);
check('hand-off: interrupts enabled (IFF2 = 1)', rd8(syms.HO_IFF) === 1);
check('hand-off: $F4 = $43 (spec $BC = DOCK chunks 0,1,6)', rd8(syms.HO_F4) === 0x43, hex(rd8(syms.HO_F4), 2));
check('hand-off: $FF = $00', rd8(syms.HO_FF) === 0x00, hex(rd8(syms.HO_FF), 2));
check('hand-off: SP = $61FE', rd16(syms.HO_SP) === 0x61FE, hex(rd16(syms.HO_SP)));

// run until the ISR variables exist and the first interrupt has been counted (boot clears the screens with DI)
let bootFrames = 0;
for (; bootFrames < 60 && rd16(syms.V_FRAMES) === 0; bootFrames++) M.runFrame(m);
check('boot finishes and the frame interrupt starts', rd16(syms.V_FRAMES) >= 1, `${bootFrames} frames of DI-protected init, FRAMES = ${rd16(syms.V_FRAMES)}`);
check('after boot: $F4 = $33 (DOCK chunks 0,1,4,5), shadow agrees',
  m.portF4 === 0x33 && rd8(syms.V_SHADOW_F4) === m.portF4, `port ${hex(m.portF4, 2)} shadow ${hex(rd8(syms.V_SHADOW_F4), 2)}`);
check('after boot: $FF bit 7 = 0 (DOCK), bit 6 = 0 (interrupt on)', (m.portFF & 0xC0) === 0, hex(m.portFF, 2));

// ---- expected picture ------------------------------------------------------------------------------------------
const SPR = syms.SPRITE;
const spriteRows = Array.from({ length: 16 }, (_, r) => ({
  mask: (img[SPR + r * 4] << 8) | img[SPR + r * 4 + 1],
  image: (img[SPR + r * 4 + 2] << 8) | img[SPR + r * 4 + 3],
}));
/** Expected 256x192 pixel plane (1 = ink): checkerboard background ($AA on even rows, $55 on odd), sprite composed over it. */
function expectedPlane(sx, sy) {
  const plane = new Uint8Array(256 * 192);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) plane[y * 256 + x] = ((x + y) & 1) === 0 ? 1 : 0; // $AA = 1010...: x even = ink on even rows
  for (let r = 0; r < 16; r++) for (let i = 0; i < 16; i++) {
    const keepBg = (spriteRows[r].mask >> (15 - i)) & 1;
    const ink = (spriteRows[r].image >> (15 - i)) & 1;
    if (!keepBg) plane[(sy + r) * 256 + sx + i] = ink;
  }
  return plane;
}
/** Screen pixel plane from the frame buffer (ink colour 0 = black -> 1, paper 7 = white -> 0), or null if a pixel is neither. */
function shownPlane() {
  const plane = new Uint8Array(256 * 192);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    const a = m.pixels[(SCR_Y0 + y) * FRAME_W + SCR_X0 + 2 * x], b = m.pixels[(SCR_Y0 + y) * FRAME_W + SCR_X0 + 2 * x + 1];
    if (a !== b) return null;
    plane[y * 256 + x] = a === 0 ? 1 : a === 7 ? 0 : 2;
  }
  return plane;
}
/** Bitmap bytes of rows sy..sy+15, columns sx>>3 .. +2 in display file `file`, as a plane of 24x16 pixels. */
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
function expectedRect(plane, sx, sy) {
  const out = [];
  const x0 = (sx >> 3) * 8;
  for (let r = 0; r < 16; r++) for (let i = 0; i < 24; i++) out.push(plane[(sy + r) * 256 + x0 + i]);
  return out;
}

// ---- 2. 300 frames, stepping instruction by instruction ----------------------------------------------------------
console.log('\nRunning ' + NFRAMES + ' frames from the first interrupt (every instruction observed)');
const stats = {
  frames: 0, missed: 0, flipsAlternate: 0, flipBad: 0, fullMatch: 0, rectMatch: 0, tornSeen: 0, unreadable: 0,
  spMin: 0xFFFF, spMax: 0, spBad: 0, work: [], isr: [], flipRel: [], positions: new Set(), reversalsX: 0, reversalsY: 0,
  imBad: 0, prevFrames: rd16(syms.V_FRAMES), prevBit: -1, shadowBad: 0, firstBad: null, outOfRange: 0,
};
let inIsr = false, isrT0 = 0, workT0 = -1;
const origOut = m.bus.ioWrite;
let ffWrites = [];
m.bus.ioWrite = (port, v) => {
  if ((port & 0xFF) === 0xFF) ffWrites.push({ rel: m.tstates - m.frameStart, v });
  origOut(port, v);
};
const ISR = syms.ISR, ISR_END = syms.ISR_END, WS = syms.WORK_START, WE = syms.WORK_END;
function hook() {
  const cpu = m.cpu, pc = cpu.pc;
  const sp = cpu.sp;
  if (sp < stats.spMin) stats.spMin = sp;
  if (sp > stats.spMax) stats.spMax = sp;
  if (sp < 0xE000 || sp > 0xFF00) stats.spBad++;
  if (pc >= ISR && pc < ISR_END) { if (!inIsr) { inIsr = true; isrT0 = m.tstates - 13; } }
  else if (inIsr) { inIsr = false; stats.isr.push(m.tstates - isrT0); }
  if (pc === WS) { workT0 = m.tstates; if (!(cpu.im === 1 && cpu.iff1)) stats.imBad++; }
  else if (pc === WE && workT0 >= 0) { stats.work.push(m.tstates - workT0); workT0 = -1; }
}
let lastX = rd8(syms.V_SPR_X), lastY = rd8(syms.V_SPR_Y), lastDx = null, lastDy = null;
let sampleLog = [];
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

  // display file: bit 0 of $FF alternates every frame and the shadow agrees with the port
  const bit = m.portFF & 1;
  if (stats.prevBit >= 0 && bit === stats.prevBit) stats.flipBad++;
  stats.prevBit = bit;
  if (rd8(syms.V_SHADOW_FF) !== m.portFF) stats.shadowBad++;
  const flip = ffWrites.find((w) => (w.v & 1) === bit);
  if (flip) stats.flipRel.push(flip.rel);

  // sprite variables
  const x = rd8(syms.V_SPR_X), y = rd8(syms.V_SPR_Y);
  if (x > 239 || y > 176) stats.outOfRange++;
  stats.positions.add(x * 256 + y);
  const dx = (rd8(syms.V_SPR_DX) << 24) >> 24, dy = (rd8(syms.V_SPR_DY) << 24) >> 24;
  if (lastDx !== null && Math.sign(dx) !== Math.sign(lastDx)) stats.reversalsX++;
  if (lastDy !== null && Math.sign(dy) !== Math.sign(lastDy)) stats.reversalsY++;
  lastDx = dx; lastDy = dy;

  // what the frame showed: the file `bit` was displayed for the whole frame; V_DRAWN[bit] says where its sprite is
  const dx0 = rd8(syms.V_DRAWN + bit * 2), dy0 = rd8(syms.V_DRAWN + bit * 2 + 1);
  const exp = expectedPlane(dx0, dy0);
  const shown = shownPlane();
  let full = false;
  if (shown === null || shown.includes(2)) stats.unreadable++;
  else {
    let bad = 0;
    for (let i = 0; i < exp.length; i++) if (exp[i] !== shown[i]) bad++;
    full = bad === 0;
    if (!full && stats.firstBad === null) stats.firstBad = { f, bad, at: [dx0, dy0], bit };
  }
  if (full) stats.fullMatch++; else stats.tornSeen++;
  // the displayed file's RAM, sprite rectangle only
  const rect = ramRect(bit, dx0, dy0), erect = expectedRect(exp, dx0, dy0);
  if (rect.every((v, i) => v === erect[i])) stats.rectMatch++;
  // is the sprite really there?  (it differs from the bare background in its rectangle)
  if (f < 6 || f % 50 === 0) sampleLog.push(`f${f}: file ${bit + 1} sprite@(${dx0},${dy0}) full-screen ${full ? 'match' : 'MISMATCH'}`);
}
console.log('  ' + sampleLog.join('\n  '));
console.log('');

// ---- results ---------------------------------------------------------------------------------------------------
console.log('Frame interrupt and flip');
check(`frame counter advanced exactly once per frame for ${NFRAMES} frames`, stats.missed === 0, `${stats.missed} frames off`);
check('$FF bit 0 alternates every frame', stats.flipBad === 0, `${stats.flipBad} non-alternating frames`);
check('shadow of $FF equals the port after every frame', stats.shadowBad === 0);
check('interrupt mode 1 and interrupts enabled whenever the main loop runs', stats.imBad === 0 && stats.work.length > 0, `${stats.imBad} violations`);
check('the flip (OUT $FF) executes before the first pixel line',
  stats.flipRel.length >= NFRAMES - 2 && Math.max(...stats.flipRel) < FIRST_PIXEL_T,
  `${stats.flipRel.length} flips, latest ${Math.max(...stats.flipRel)} T after the interrupt, first pixel at ${FIRST_PIXEL_T}`);
const isrMax = Math.max(...stats.isr), isrMin = Math.min(...stats.isr);
const isrSorted = [...stats.isr].sort((p, q) => p - q), isrMed = isrSorted[isrSorted.length >> 1];
check('ISR cost: typical < 170 T, worst (the 1-in-256 frame with the counter carry) < 210 T', isrMed < 170 && isrMax < 210,
  `median ${isrMed}, range ${isrMin}..${isrMax} T including the 13 T acknowledge`);

console.log('Sprite');
check('sprite position changes (more than 100 distinct positions)', stats.positions.size > 100, `${stats.positions.size} positions`);
check('sprite bounces in both axes', stats.reversalsX >= 2 && stats.reversalsY >= 2, `x reversals ${stats.reversalsX}, y reversals ${stats.reversalsY}`);
check('position stays in range (x <= 239, y <= 176)', stats.outOfRange === 0);
const pct = (n) => (100 * n / NFRAMES).toFixed(1) + ' %';
check('sprite visible at its position in the DISPLAYED file in >= 95 % of frames (bitmap RAM, masked composition)',
  stats.rectMatch / NFRAMES >= 0.95, `${stats.rectMatch}/${NFRAMES} = ${pct(stats.rectMatch)}`);
check('whole screen image equals background + masked sprite in >= 95 % of frames (frame buffer)',
  stats.fullMatch / NFRAMES >= 0.95, `${stats.fullMatch}/${NFRAMES} = ${pct(stats.fullMatch)}`);
check('no tearing: no frame shows a half-erased or half-drawn sprite (every frame matches)',
  stats.tornSeen === 0 && stats.unreadable === 0,
  stats.firstBad ? `first bad frame ${JSON.stringify(stats.firstBad)}` : `${stats.tornSeen} bad frames`);

console.log('Stack');
check('SP stays within chunk 7 ($E000-$FF00) for every instruction', stats.spBad === 0,
  `min ${hex(stats.spMin)} max ${hex(stats.spMax)}, deepest use ${0xFF00 - stats.spMin} bytes`);
check('stack never grows into the variable block', stats.spMin >= VARS + 0x100);

console.log('\nCPU use (TSRun, 58,688 T per frame)');
const avg = (a) => a.reduce((s, v) => s + v, 0) / a.length;
const work = stats.work;
console.log(`  main loop work per frame: min ${Math.min(...work)}  avg ${avg(work).toFixed(0)}  max ${Math.max(...work)} T  (${work.length} frames measured)`);
console.log(`  ISR: ${isrMin}..${isrMax} T`);
const totalMax = Math.max(...work) + isrMax, totalAvg = avg(work) + avg(stats.isr);
console.log(`  main loop ${(100 * avg(work) / FRAME_T).toFixed(1)} % of a frame (max ${(100 * Math.max(...work) / FRAME_T).toFixed(1)} %), with the ISR ${(100 * totalAvg / FRAME_T).toFixed(1)} % (max ${(100 * totalMax / FRAME_T).toFixed(1)} %)`);
check('main loop + ISR fit in a frame with room to spare (< 50 %)', totalMax < FRAME_T / 2);

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: M1 (${passed} checks passed, ${failed} failed)`);
process.exitCode = failed === 0 ? 0 : 1;
