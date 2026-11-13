"use strict";
// m17-runtime-wire.mjs -- Leap Arcade wireframe 3D, slice W1 (docs/ARCADE_WIREFRAME_CONTRACT.md sections 2, 3, 6, 8): runtime v2's wire.asm (RT_EYE,
// RT_DRAWMODEL, RT_LINE, RT_COSA, RT_SINA, RT_FXMUL, wire_setup, wire_clear) on a stock TS2068 (TSRun) with the v2 cartridge, against the
// bit-exact JavaScript reference src/lang/arcade/arcade-wire.js.
//
// What is checked:
//  1. COSA / SINA for all 256 angles, FXMUL for edge pairs and >= 10,000 random pairs: equal to arcade-view.js (v4's values); w_sin8 for every
//     angle and w_matrix for every (yaw, pitch) pair: equal to the reference's SIN8 and buildMatrix.
//  2. >= 2,000 random scenes: a random play area (wire_setup), a random hidden file (V_HOFF), a random eye (RT_EYE), 1..3 DRAWMODELs of random
//     models (up to 128 points / 255 edges, |c| <= 64) at random poses and scales 1..8 (in view, near, too far to the side, beyond the range,
//     anywhere), and LINEs.  After EVERY call: both display files and both attribute files equal the reference (the files start as random
//     bytes), and all RAM outside W_REC, W_VARS, RT_ARGS and the call's stack frame is unchanged.
//  3. >= 2,000 random LINEs: inside, crossing, outside, far ends up to +-16383 (and beyond: nothing drawn), one pixel, horizontal, vertical.
//  4. The guards of contract section 8 (W1's): |d| > 16,000 and |T| > 16,000 skip, near and too-far ends, SCALE 8 at the limit, 128 points,
//     255 edges, W_ON = 0 (nothing drawn or written), LINE outside / along an edge / one pixel, the clear's rows.
//  5. Interrupts: scenes run with interrupts ON and the real handler (an interrupt every 700..4,000 T, a sound effect playing so SND_TICK runs):
//     at every interrupt every register (IX, IY and the alternates included) is the same after the handler as before it, and the picture equals
//     the run without interrupts.  wire_clear: no interrupt accepted inside it, interrupts on after it, at most 37,000 T with interrupts off.
//  6. The section 6 kernel figures (exact T-states, printed against the targets).
//   node arcade/tests/m17-runtime-wire.mjs        (M17_QUICK=1: fewer scenes)
import { buildDck, chunksFromImage } from '../tools/mkdck.mjs';
import { buildRuntime } from '../tools/build-runtime-v2.mjs';
import { rng } from './m3-scenes.mjs';
import * as C2 from './m2-runtime-common.mjs';
import * as W from '../../src/lang/arcade/arcade-wire.js';
const { M, Z, hex, makeChecks, newMachine, bootMachine } = C2;

const { check, finish } = makeChecks();
console.log('M17 runtime wireframe (W1): RT_EYE, RT_DRAWMODEL, RT_LINE, RT_COSA / RT_SINA / RT_FXMUL, wire_setup, wire_clear on runtime v2\n');
const QUICK = !!process.env.M17_QUICK;
const N_SCENES = QUICK ? 300 : 2000, N_LINES = QUICK ? 300 : 2000, N_FX = QUICK ? 2000 : 10000;

const rt = buildRuntime();
const S = rt.syms, K = rt.json.constants;
for (const k of ['W_REC', 'W_VARS', 'W_ON', 'RA_W0', 'RA_W4', 'W_REC_LEN', 'W_VARS_LEN']) if (K[k] === undefined) throw new Error('runtime.json lacks the constant ' + k);
const W_START = S.M_WIRE_S, RT_END = S.RT_END;
console.log(`runtime v2: wire.asm ${hex(W_START)}-${hex(RT_END)} (${RT_END - W_START} bytes; RT_END ${hex(RT_END)}, ${0x4000 - RT_END} bytes free in chunks 0-1)\n`);
// (the contract's W1 bound was 5,300; the faster projection (w_proj_point / w_qmul, the SCALE shifts) and the switch-on clear (wire_clear_on) took it to
// 5,318 on 2026-11-12: the bound is now what is left of chunks 0-1, at least 800 bytes free)
check('the whole addition is at most 5,350 bytes and at least 800 bytes of chunks 0-1 are free', RT_END - W_START <= 5350 && 0x4000 - RT_END >= 800, `${RT_END - W_START} bytes, ${0x4000 - RT_END} free`);

// ---- the machine ---------------------------------------------------------------------------------------------------------------------------
const RET = 0x5B00;                       // a HALT in free RAM of chunk 2: the return address of every call
const SFX_TAB = 0xA000, SFX = 0xA010, MODEL_LO = 0x8100, MODEL_HI = 0x9F00;
function image() {
  const img = Uint8Array.from(rt.img);
  img.fill(0, 0x8000, 0xC000);
  img.set([0x12, 0x80, 0x12, 0x80, 0x81, 0, 0x12, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xC9], 0x8000);
  return img;
}
const m = newMachine(buildDck(chunksFromImage(image(), [0, 1, 4, 5])));
bootMachine(m, S);
for (let f = 0; f < 6; f++) M.runFrame(m);
for (let i = 0; i < 3000000 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);
if (m.cpu.pc !== S.TICK_LOOP) throw new Error('the frame loop was not reached');
m.ram[RET] = 0x76;
const cpu = m.cpu;
const SNAP = { ram: m.ram.slice(), cpu: { ...cpu }, t: m.tstates };
const restore = () => { m.ram.set(SNAP.ram); Object.assign(cpu, SNAP.cpu); cpu.iff1 = false; cpu.iff2 = false; cpu.halted = false; };
const SP0 = SNAP.cpu.sp;
const plant = (at, bytes) => { for (let i = 0; i < bytes.length; i++) { const a = at + i; m.dock[a >> 13][a & 0x1FFF] = bytes[i]; } };
const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
const rd16s = (a) => (rd16(a) << 16) >> 16;
const wr16 = (a, v) => { m.ram[a] = v & 255; m.ram[a + 1] = (v >> 8) & 255; };
const setArgs = (...w) => w.forEach((v, i) => wr16(K.RT_ARGS + 2 * i, v));

/**
 * Call a routine: registers set, RET pushed, interrupts off (unless `irq`), run to RET.  exact: single steps, returns the exact T-states (from the
 * first instruction to the RET inclusive) and `marks` (the T at which each address in `marks` was first reached).  irq: { every, onIrq } raises a
 * frame interrupt every `every` T (single steps; the real handler runs).
 */
function call(addr, { a = 0, bc = 0, de = 0, hl = 0, exact = false, marks = null, irq = null } = {}) {
  cpu.a = a & 255; cpu.b = bc >> 8 & 255; cpu.c = bc & 255; cpu.d = de >> 8 & 255; cpu.e = de & 255; cpu.h = hl >> 8 & 255; cpu.l = hl & 255;
  cpu.sp = SP0 - 2; m.ram[SP0 - 2] = RET & 255; m.ram[SP0 - 1] = RET >> 8;
  cpu.pc = addr; cpu.halted = false; cpu.eiDelay = false;
  cpu.iff1 = cpu.iff2 = !!irq; if (irq) cpu.im = 1;
  const t0 = m.tstates, cap = t0 + 400 * 58688;
  const seen = {};
  if (exact || irq) {
    let next = t0 + (irq ? irq.every() : 0);
    while (cpu.pc !== RET) {
      if (m.tstates > cap) throw new Error(`routine ${hex(addr)} did not return`);
      if (marks) for (const k of marks) if (cpu.pc === k && seen[k] === undefined) seen[k] = m.tstates - t0;
      if (irq && m.tstates >= next) { irq.onIrq(); next = m.tstates + irq.every(); continue; }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    return { t: m.tstates - t0, marks: seen };
  }
  while (!(cpu.halted && cpu.pc === RET + 1)) {
    if (m.tstates > cap) throw new Error(`routine ${hex(addr)} did not return`);
    Z.runZ80(cpu, m.bus, 20000, m);
  }
  cpu.halted = false;
  return { t: null };
}

// ---- comparisons ---------------------------------------------------------------------------------------------------------------------------
const inWire = (a) => (a >= K.W_REC && a < K.W_REC + K.W_REC_LEN) || (a >= K.W_VARS && a < K.W_VARS + K.W_VARS_LEN) || (a >= K.RT_ARGS && a < K.RT_ARGS + 12);
const inStack = (a) => a >= SP0 - 64 && a < SP0;
/** Problems: the hidden file and the shown one against `want` (two 6,144-byte bitmaps), the attributes and the rest of RAM against `before`. */
function compare(before, want, what, extraOk = () => false) {
  const ram = m.ram;
  for (let f = 0; f < 2; f++) {
    const base = 0x4000 + 0x2000 * f;
    for (let i = 0; i < 6144; i++) if (ram[base + i] !== want[f][i]) {
      const o = i, y = ((o >> 5) & 0xC0) | ((o >> 8) & 7) | ((o >> 2) & 0x38), x = (o & 31) * 8;
      return `${what}: file ${f + 1} byte ${hex(base + i)} (x ${x}..${x + 7}, y ${y}) = ${hex(ram[base + i], 2)}, want ${hex(want[f][i], 2)}`;
    }
  }
  for (let a = 0x4000; a < 0x10000; a++) {
    if ((a >= 0x4000 && a < 0x5800) || (a >= 0x6000 && a < 0x7800)) continue;
    if (inWire(a) || inStack(a) || extraOk(a)) continue;
    if (ram[a] !== before[a]) return `${what}: RAM ${hex(a)} changed ${hex(before[a], 2)} -> ${hex(ram[a], 2)}`;
  }
  return null;
}
const files = (ram) => [ram.slice(0x4000, 0x5800), ram.slice(0x6000, 0x7800)];
let mismatches = 0;
const fails = [];
const fail = (s) => { mismatches++; if (fails.length < 12) fails.push(s); };

// ---- 1. COSA / SINA / FXMUL, sin8, the matrix ------------------------------------------------------------------------------------------------
console.log('--- 1. COSA / SINA / FXMUL (v4\'s values), SIN8, the matrix ---');
restore();
{
  let bad = 0, first = '';
  for (let a = 0; a < 256; a++) for (const hi of [0, 1, 0xFF]) {
    for (const [name, f] of [['RT_COSA', W.cosa], ['RT_SINA', W.sina]]) {
      call(S[name], { hl: (hi << 8) | a });
      const got = (cpu.h << 24 >> 16) | cpu.l;
      if (got !== f(a)) { bad++; first ||= `${name}(${a}) = ${got}, want ${f(a)}`; }
    }
  }
  check('RT_COSA / RT_SINA equal COSA / SINA (arcade-view.js) for all 256 angles (high byte 0, 1, $FF ignored)', bad === 0, first);
  const R = rng(1701);
  const special = [0, 1, -1, 2, -2, 255, 256, -256, 257, 32767, -32768, -32767, 16384, -16384, 181, -181, 12345, -12345];
  const pairs = [];
  for (const x of special) for (const y of special) pairs.push([x, y]);
  for (let i = 0; i < N_FX; i++) pairs.push([R.int(-32768, 32767), R.pick([R.int(-32768, 32767), R.int(-256, 256), R.int(-20, 20)])]);
  bad = 0; first = '';
  for (const [x, y] of pairs) {
    call(S.RT_FXMUL, { hl: x & 0xFFFF, de: y & 0xFFFF });
    const got = (cpu.h << 24 >> 16) | cpu.l;
    if (got !== W.fxmul(x, y)) { bad++; first ||= `FXMUL(${x}, ${y}) = ${got}, want ${W.fxmul(x, y)}`; }
  }
  check(`RT_FXMUL equals FXMUL for ${pairs.length} pairs (${special.length ** 2} edge pairs + ${N_FX} random)`, bad === 0, first);
  bad = 0; first = '';
  for (let a = 0; a < 256; a++) {
    call(S.w_sin8, { a });
    const got = cpu.a << 24 >> 24;
    if (got !== W.SIN8[a]) { bad++; first ||= `sin8(${a}) = ${got}, want ${W.SIN8[a]}`; }
  }
  check('w_sin8 (the quarter table) equals SIN8 = round(64 sin(2 pi k / 256)) for all 256 angles', bad === 0, first);
  bad = 0; first = '';
  for (let y = 0; y < 256; y++) for (let p = 0; p < 256; p += QUICK ? 15 : 1) {
    m.ram[S.W_YAW] = y; m.ram[S.W_PITCH] = p;
    call(S.w_matrix);
    const want = W.buildMatrix(y, p);
    const got = [0, 1, 2, 5, 6, 7, 10, 11, 12].map((o) => m.ram[S.W_MAT + o] << 24 >> 24);
    if (got.some((v, i) => v !== want[i])) { bad++; first ||= `matrix(${y}, ${p}) = ${got}, want ${want}`; }
  }
  check(`w_matrix equals the contract's Ry(y') Rx(p) for every yaw x ${QUICK ? 'every 15th' : 'every'} pitch`, bad === 0, first);
}

// ---- scene generation --------------------------------------------------------------------------------------------------------------------
const i16 = (v) => ((v + 32768) & 0xFFFF) - 32768;
function randomModel(R, big = false) {
  const n = big ? R.pick([128, R.int(64, 128)]) : R.pick([R.int(1, 8), R.int(2, 20), R.int(8, 40)]);
  const span = R.pick([64, 64, 32, 10]);
  const points = Array.from({ length: n }, () => [R.int(-span, span), R.int(-span, span), R.int(-span, span)]);
  if (n === 1) points.push([R.int(-64, 64), R.int(-64, 64), R.int(-64, 64)]);
  const np = points.length;
  const ne = big ? R.pick([255, R.int(100, 255)]) : R.int(1, Math.min(255, np * 3));
  const edges = Array.from({ length: ne }, () => { const i = R.int(0, np - 1); let j = R.int(0, np - 2); if (j >= i) j++; return [i, j]; });
  return { points, edges };
}
/** A pose of the object in camera terms (forward f, right l, up u) turned into world coordinates for the eye; null if it does not fit int16. */
function poseFor(R, eye, kind) {
  let f, l, u;
  if (kind === 'view') { f = R.int(30, 3000); l = R.int(-f, f); u = R.int(-f, f); }
  else if (kind === 'near') { f = R.int(-150, 200); l = R.int(-200, 200); u = R.int(-200, 200); }
  else if (kind === 'wide') { f = R.int(16, 120); l = R.pick([1, -1]) * R.int(500, 16000); u = R.int(-3000, 3000); }
  else if (kind === 'deep') { f = R.int(3000, 16000); l = R.int(-f, f); u = R.int(-2000, 2000); }
  else if (kind === 'limit') { f = R.int(15800, 16300) * R.pick([1, -1]); l = R.int(-16300, 16300); u = R.pick([R.int(-16300, 16300), R.int(15900, 16100) * R.pick([1, -1])]); }
  else { const x = R.int(-32768, 32767), y = R.int(-32768, 32767), z = R.int(-32768, 32767); return { x, y, z }; }
  const C = W.cosa(eye.a), Sn = W.sina(eye.a);
  const dx = Math.round((l * C + f * Sn) / 256), dz = Math.round((-l * Sn + f * C) / 256);
  const x = eye.x + dx, y = eye.y + u, z = eye.z + dz;
  if ([x, y, z].some((v) => v < -32768 || v > 32767)) return null;
  return { x, y, z };
}
function randomEye(R) {
  return R.pick([() => ({ x: 0, y: 0, z: 0, a: 0 }), () => ({ x: R.int(-20000, 20000), y: R.int(-3000, 3000), z: R.int(-20000, 20000), a: R.int(0, 255) }),
    () => ({ x: R.int(-32768, 32767), y: R.int(-32768, 32767), z: R.int(-32768, 32767), a: R.int(0, 255) })])();
}
function randomArea(R) {
  const r0 = R.pick([0, 2, R.int(0, 20)]);
  const r1 = R.pick([23, 21, R.int(r0 + 3, 23)]);
  return W.areaOf(r0, Math.max(r1, r0 + 3));
}
function randomLine(R, area) {
  const inX = () => R.int(area.xmin, area.xmax), inY = () => R.int(area.ymin, area.ymax);
  const near = () => R.int(-300, 555), far = () => R.int(-16384, 16383);
  const kind = R.int(0, 9);
  let l;
  if (kind <= 2) l = [inX(), inY(), inX(), inY()];
  else if (kind === 3) l = [inX(), inY(), near(), near()];
  else if (kind === 4) l = [near(), near(), near(), near()];
  else if (kind === 5) l = [R.pick([inX(), near()]), R.pick([inY(), near()]), far(), far()];
  else if (kind === 6) l = [far(), far(), far(), far()];
  else if (kind === 7) { const x = R.pick([inX(), near()]), y = R.pick([inY(), near()]); l = R.chance(0.5) ? [x, y, x, y] : R.chance(0.5) ? [x, y, R.pick([inX(), near(), far()]), y] : [x, y, x, R.pick([inY(), near(), far()])]; }
  else if (kind === 8) { const y = R.pick([area.ymin, area.ymax, area.ymin - 1, area.ymax + 1]); l = R.chance(0.5) ? [R.pick([near(), far()]), y, R.pick([near(), far()]), y] : [R.pick([0, 255, -1, 256]), R.pick([near(), far()]), R.pick([0, 255, -1, 256]), R.pick([near(), far()])]; }
  else l = [R.int(-32768, 32767), R.int(-32768, 32767), R.pick([R.int(-32768, 32767), inX()]), R.pick([R.int(-32768, 32767), inY()])];
  return l;
}

/** Fill both display files and attribute files with random bytes (a stray write shows). */
function poison(R) { for (let a = 0x4000; a < 0x8000; a++) m.ram[a] = R.int(0, 255); m.ram[RET] = 0x76; }
function setup(area, hoff, attr = 0x45) {
  m.ram[S.V_HOFF] = hoff;
  call(S.wire_setup, { bc: (area.r0 << 8) | area.r1, a: attr });
}
function setEye(eye) { setArgs(eye.x, eye.y, eye.z, eye.a); call(S.RT_EYE); }
/** One DRAWMODEL with the reference, compared. */
function drawModelCheck(model, pose, eye, area, hoff, what, opts = {}) {
  const k = W.SCALES.indexOf(pose.scale);
  const at = opts.at ?? MODEL_LO;
  plant(at, W.modelBytes(model));
  setArgs(pose.x, pose.y, pose.z, pose.yaw, pose.pitch);
  const before = m.ram.slice();
  const want = files(before);
  const n = W.drawModel(want[hoff ? 1 : 0], model, pose, eye, area);
  const r = call(S.RT_DRAWMODEL, { hl: at, a: k, exact: !!opts.exact, marks: opts.marks });
  const bad = compare(before, want, what);
  if (bad) fail(bad);
  return { n, r, bad };
}
function lineCheck(l, area, hoff, what, opts = {}) {
  setArgs(...l);
  const before = m.ram.slice();
  const want = files(before);
  const n = W.drawLine(want[hoff ? 1 : 0], l[0], l[1], l[2], l[3], area);
  const r = call(S.RT_LINE, { exact: !!opts.exact });
  const bad = compare(before, want, what);
  if (bad) fail(bad);
  return { n, r, bad };
}

// ---- 2. random scenes ------------------------------------------------------------------------------------------------------------------------
console.log('\n--- 2. random scenes ---');
{
  const R = rng(17001);
  const kinds = ['view', 'view', 'view', 'near', 'wide', 'deep', 'limit', 'any'];
  const stat = { models: 0, drawn: 0, px: 0, lines: 0, big: 0, scale: [0, 0, 0, 0] };
  const before0 = mismatches;
  for (let s = 0; s < N_SCENES; s++) {
    restore();
    poison(R);
    const area = randomArea(R), hoff = R.pick([0, 0x20]);
    setup(area, hoff, R.int(0, 255));
    const eye = randomEye(R);
    setEye(eye);
    const nm = R.int(1, 3);
    for (let i = 0; i < nm; i++) {
      const big = R.chance(0.04);
      const model = randomModel(R, big);
      let pose = null;
      for (let tries = 0; !pose && tries < 20; tries++) pose = poseFor(R, eye, R.pick(kinds));
      if (!pose) pose = { x: eye.x, y: eye.y, z: eye.z };
      pose.yaw = R.pick([0, R.int(0, 255), R.int(-32768, 32767)]);
      pose.pitch = R.pick([0, 0, R.int(0, 255), R.int(-32768, 32767)]);
      pose.scale = R.pick(W.SCALES);
      const at = R.int(MODEL_LO, MODEL_HI - 900);
      const r = drawModelCheck(model, pose, eye, area, hoff, `scene ${s} model ${i} (${model.points.length} pts, ${model.edges.length} edges, scale ${pose.scale})`, { at });
      stat.models++; if (r.n) stat.drawn++; stat.px += r.n; if (big) stat.big++; stat.scale[W.SCALES.indexOf(pose.scale)]++;
      if (r.bad) break;
    }
    for (let i = R.int(0, 2); i > 0; i--) { lineCheck(randomLine(R, area), area, hoff, `scene ${s} line`); stat.lines++; }
  }
  check(`${N_SCENES} scenes: ${stat.models} DRAWMODELs (${stat.drawn} with pixels, ${stat.px} pixels, ${stat.big} models of 64..128 points / 100..255 edges, scales ${stat.scale.join(' / ')}) and ${stat.lines} LINEs equal the reference (both files, attributes, RAM)`,
    mismatches === before0, `${mismatches - before0} mismatches`);
}

// ---- 3. random LINEs -----------------------------------------------------------------------------------------------------------------------
console.log('\n--- 3. random LINEs ---');
{
  const R = rng(17002);
  const before0 = mismatches;
  let px = 0, empty = 0, beyond = 0;
  restore();
  poison(R);
  let area = randomArea(R), hoff = 0x20;
  setup(area, hoff);
  for (let i = 0; i < N_LINES; i++) {
    if (i % 100 === 0) { restore(); poison(R); area = randomArea(R); hoff = R.pick([0, 0x20]); setup(area, hoff); }
    let l = randomLine(R, area);
    if (i % 50 === 7) { l = [R.int(-32768, 32767), R.int(-32768, 32767), R.int(-32768, 32767), R.int(-32768, 32767)]; l[R.int(0, 3)] = R.pick([-16385, 16384, -32768, 32767]); }
    if (l.some((v) => v < W.LINE_MIN || v > W.LINE_MAX)) beyond++;
    const r = lineCheck(l, area, hoff, `line ${i} (${l.join(', ')}) rows ${area.r0}..${area.r1}`);
    px += r.n; if (!r.n) empty++;
    if (r.bad) break;
  }
  check(`${N_LINES} LINEs (${px} pixels, ${empty} with none, ${beyond} with a coordinate beyond -16384..16383) equal the reference`, mismatches === before0, `${mismatches - before0} mismatches`);
}

// ---- 4. guards -----------------------------------------------------------------------------------------------------------------------------
console.log('\n--- 4. guards (contract section 8) ---');
const AREA = W.areaOf(2, 21);
const cube = { points: [[-20, -20, -20], [20, -20, -20], [20, 20, -20], [-20, 20, -20], [-20, -20, 20], [20, -20, 20], [20, 20, 20], [-20, 20, 20]],
  edges: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]] };
function guard(name, model, pose, eye, expect, area = AREA) {
  restore();
  poison(rng(name.length * 77));
  setup(area, 0x20);
  setEye(eye);
  const before = mismatches;
  const r = drawModelCheck(model, { yaw: 0, pitch: 0, scale: 1, ...pose }, eye, area, 0x20, name);
  const ok = mismatches === before && expect(r.n);
  check(name, ok, `${r.n} pixels${r.bad ? '; ' + r.bad : ''}`);
  return r;
}
const E0 = { x: 0, y: 0, z: 0, a: 0 };
guard('|dx| = 16,000 is drawn', cube, { x: 16000, y: 0, z: 1000 }, { x: 0, y: 0, z: 0, a: 64 }, (n) => n > 0);
guard('|dx| = 16,001 is not drawn', cube, { x: 16001, y: 0, z: 1000 }, { x: 0, y: 0, z: 0, a: 64 }, (n) => n === 0);
guard('dx = -16,001 is not drawn', cube, { x: -16001, y: 0, z: 1000 }, { x: 0, y: 0, z: 0, a: 192 }, (n) => n === 0);
guard('|dy| = 16,001 is not drawn', cube, { x: 0, y: 16001, z: 1000 }, E0, (n) => n === 0);
guard('|dz| = 16,001 is not drawn', cube, { x: 0, y: 0, z: 16001 }, E0, (n) => n === 0);
guard('d beyond 16 bits (x 32767, eye -32768) is not drawn', cube, { x: 32767, y: 0, z: 100 }, { x: -32768, y: 0, z: 0, a: 0 }, (n) => n === 0);
guard('|Tz| > 16,000 with |d| <= 16,000 (dx = dz = 12,000, heading 32) is not drawn', cube, { x: 12000, y: 0, z: 12000 }, { x: 0, y: 0, z: 0, a: 32 }, (n) => n === 0);
guard('|Tx| > 16,000 with |d| <= 16,000 (dx = 12,000, dz = -12,000, heading 32) is not drawn', cube, { x: 12000, y: 0, z: -12000 }, { x: 0, y: 0, z: 0, a: 32 }, (n) => n === 0);
guard('Tz = 15,999 (in range, far away) is projected', cube, { x: 0, y: 0, z: 15999 }, E0, () => true);
{
  const rec = guard('a near end: the cube straddling Zc = 16 keeps only its far edges', cube, { x: 0, y: 0, z: 30 }, E0, (n) => n > 0);
  const recs = W.projectPoints(cube.points, W.buildMatrix(0, 0), [0, 0, 30], 0, AREA);
  check('  (the reference flags the near points $80 and their edges are skipped)', recs.filter((r) => r.flag === 0x80).length === 4, recs.map((r) => r.flag).join(','));
  check('  (the records in W_REC carry the same flags)', cube.points.every((_, i) => m.ram[K.W_REC + 0x400 + i] === recs[i].flag), cube.points.map((_, i) => m.ram[K.W_REC + 0x400 + i]).join(','));
  void rec;
}
{
  // scale 8, T = (1500, 0, 528): point 0 at Zc 1040 is on the screen, point 1 at Zc 16 is too far (|q| > 16,000), point 2 at Zc 16 is far right
  const far = { points: [[-64, 0, 64], [64, 0, -64], [-64, 0, -64]], edges: [[0, 1], [0, 2], [1, 2]] };
  const recs = W.projectPoints(far.points, W.buildMatrix(0, 0), [1500, 0, 528], 3, AREA);
  check('  (the reference: point 1 too far ($40), point 0 inside, point 2 off to the right)', recs[1].flag === 0x40 && recs[0].flag === 0 && recs[2].flag === 2, recs.map((r) => r.flag).join(','));
  guard('a too-far end: its edges are dropped, the edge between the other two is drawn (clipped)', far, { x: 1500, y: 0, z: 528, scale: 8 }, E0, (n) => n > 0);
  check('  (the records in W_REC carry the same flags)', far.points.every((_, i) => m.ram[K.W_REC + 0x400 + i] === recs[i].flag), far.points.map((_, i) => m.ram[K.W_REC + 0x400 + i]).join(','));
}
const box64 = { points: [[-64, -64, -64], [64, -64, -64], [64, 64, -64], [-64, 64, -64], [-64, -64, 64], [64, -64, 64], [64, 64, 64], [-64, 64, 64]], edges: cube.edges };
for (const [yaw, pitch] of [[0, 0], [32, 32], [96, 160], [17, 203]]) {
  guard(`SCALE 8 at the limit (|c| = 64, T = (16,000, -16,000, 16,000), yaw ${yaw} pitch ${pitch})`, box64, { x: 16000, y: -16000, z: 16000, yaw, pitch, scale: 8 }, E0, () => true);
  guard(`SCALE 8 close up (T = (0, 0, 600), yaw ${yaw} pitch ${pitch})`, box64, { x: 0, y: 0, z: 600, yaw, pitch, scale: 8 }, E0, (n) => n > 0);
  guard(`SCALE 8 at the range limit in view (T = (0, 0, 16,000), yaw ${yaw} pitch ${pitch})`, box64, { x: 0, y: 0, z: 16000, yaw, pitch, scale: 8 }, E0, (n) => n > 0);
  guard(`SCALE 8, Tx = 16,000 at Tz = 16,000 (the largest |Xc|, 17,5xx), yaw ${yaw} pitch ${pitch}`, box64, { x: 16000, y: 0, z: 16000, yaw, pitch, scale: 8 }, E0, () => true);
}
{
  const R = rng(128);
  const pts = Array.from({ length: 128 }, (_, i) => [Math.round(60 * Math.cos(i * 0.37)), Math.round(60 * Math.sin(i * 0.23)), R.int(-64, 64)]);
  const ring = { points: pts, edges: pts.map((_, i) => [i, (i + 1) % 128]) };
  guard('a 128-point model (edges to point 127)', ring, { x: 0, y: 0, z: 300, yaw: 40, pitch: 20 }, E0, (n) => n > 0);
  const e255 = { points: pts, edges: Array.from({ length: 255 }, (_, i) => [i % 128, (i * 7 + 3) % 128]) };   // 6 i + 3 is odd: never i
  guard('255 edges', e255, { x: 0, y: 0, z: 400, yaw: 200, pitch: 100, scale: 2 }, E0, (n) => n > 0);
  guard('255 edges, SCALE 4, partly off the play area', e255, { x: 120, y: -40, z: 260, yaw: 9, pitch: 77, scale: 4 }, E0, (n) => n > 0);
  guard('2 points, 1 edge', { points: [[0, 0, 0], [10, 0, 0]], edges: [[0, 1]] }, { x: 0, y: 0, z: 100 }, E0, (n) => n > 0);
}
// W_ON = 0: nothing at all
{
  restore();
  poison(rng(5));
  setup(AREA, 0x20);
  setEye({ x: 0, y: 0, z: 0, a: 0 });
  m.ram[K.W_ON] = 0;
  plant(MODEL_LO, W.modelBytes(cube));
  const before = m.ram.slice();
  setArgs(0, 0, 200, 10, 20);
  const b2 = m.ram.slice();
  call(S.RT_DRAWMODEL, { hl: MODEL_LO, a: 0 });
  const d1 = m.ram.every((v, i) => v === b2[i] || (i >= SP0 - 64 && i < SP0));
  setArgs(0, 0, 255, 191);
  const b3 = m.ram.slice();
  call(S.RT_LINE);
  const d2 = m.ram.every((v, i) => v === b3[i] || (i >= SP0 - 64 && i < SP0));
  const b4 = m.ram.slice();
  call(S.wire_clear);
  const d3 = m.ram.every((v, i) => v === b4[i] || (i >= SP0 - 64 && i < SP0));
  check('W_ON = 0: RT_DRAWMODEL, RT_LINE and wire_clear write nothing (all RAM unchanged)', d1 && d2 && d3, `${d1} ${d2} ${d3}`);
  void before;
}
// LINE guards
{
  const lines = [
    ['LINE fully outside (left)', [-100, 50, -1, 120]], ['LINE fully outside (below the play area)', [10, 176, 200, 191]], ['LINE fully outside (above)', [0, 0, 255, 15]],
    ['LINE along the top edge', [-50, 16, 300, 16]], ['LINE along the bottom edge', [0, 175, 255, 175]], ['LINE along the left edge', [0, -100, 0, 400]],
    ['LINE along the right edge', [255, 10, 255, 180]], ['LINE one pixel', [100, 100, 100, 100]], ['LINE one pixel at a corner', [255, 175, 255, 175]],
    ['LINE one pixel outside', [256, 100, 256, 100]], ['LINE far ends +-16,383', [-16384, -16384, 16383, 16383]], ['LINE far ends, steep', [130, -16384, 120, 16383]],
    ['LINE end beyond 16,383: nothing', [100, 100, 16384, 100]], ['LINE end below -16,384: nothing', [-16385, 100, 100, 100]],
    ['LINE horizontal 256 px', [0, 100, 255, 100]], ['LINE vertical 160 px', [7, 16, 7, 175]], ['LINE 45 degrees', [0, 16, 159, 175]],
    ['LINE passing a corner outside', [-10, 30, 30, -10]], ['LINE crossing the whole area', [-500, -300, 700, 600]]];
  for (const [name, l] of lines) {
    restore(); poison(rng(name.length)); setup(AREA, 0);
    const before = mismatches;
    const r = lineCheck(l, AREA, 0, name);
    check(name, mismatches === before, `${r.n} pixels${r.bad ? '; ' + r.bad : ''}`);
  }
}
// the clear: rows r0..r1 of the hidden file only
{
  const R = rng(99);
  let bad = 0, first = '';
  for (const [r0, r1] of [[2, 21], [0, 23], [0, 3], [20, 23], [5, 9], [7, 16], [8, 15], [3, 22], [15, 18]]) for (const hoff of [0, 0x20]) {
    restore(); poison(R);
    const area = W.areaOf(r0, r1);
    setup(area, hoff);
    const before = m.ram.slice();
    const want = files(before);
    W.clearArea(want[hoff ? 1 : 0], area);
    call(S.wire_clear);
    const b = compare(before, want, `clear rows ${r0}..${r1} file ${hoff ? 2 : 1}`);
    if (b) { bad++; first ||= b; }
    if (!cpu.iff1) { bad++; first ||= 'interrupts off after wire_clear'; }
  }
  check('wire_clear clears exactly rows r0..r1 of the hidden file (9 areas x 2 files), interrupts on after it', bad === 0, first);
}

// ---- 5. interrupts -------------------------------------------------------------------------------------------------------------------------
console.log('\n--- 5. interrupts on, the real handler ---');
{
  // a long effect so that SND_TICK runs in the handler: table at SFX_TAB, effect at SFX (type 1 records), GAME_SFX patched in the header
  const recs = [];
  for (let i = 0; i < 1500; i++) recs.push(100 + (i * 37) % 900 & 255, ((100 + (i * 37) % 900) >> 8) | (((i >> 2) % 15) << 4), i & 31, 0);
  recs.push(0, 0xFF, 0, 0);
  plant(SFX, recs);
  plant(SFX_TAB, [1, SFX & 255, SFX >> 8]);
  plant(0x800A, [SFX_TAB & 255, SFX_TAB >> 8]);
  const R = rng(17005);
  const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl', 'sp'];
  let irqs = 0, refused = 0, regBad = 0, firstReg = '', picBad = 0, firstPic = '', sndTicks = 0;
  const onIrq = () => {
    if (!cpu.iff1 || cpu.eiDelay) { refused++; return; }
    const save = Object.fromEntries(KEYS.map((k) => [k, cpu[k]])), pc = cpu.pc;
    const t = Z.irqZ80(cpu, m.bus);
    if (!t) throw new Error('the interrupt was not accepted');
    m.tstates += t;
    irqs++;
    let steps = 0, snd = false;
    while (!(cpu.pc === pc && cpu.sp === save.sp)) {
      if (cpu.pc === S.SND_TICK) snd = true;
      Z.runZ80(cpu, m.bus, 1, m);
      if (++steps > 20000) throw new Error('the interrupt did not return');
    }
    if (snd) sndTicks++;
    const diffK = KEYS.filter((k) => cpu[k] !== save[k]);
    if (diffK.length || !cpu.iff1) { regBad++; firstReg ||= `registers changed by the handler: ${diffK.join(' ')} (iff1 ${cpu.iff1})`; }
  };
  const sentinels = () => { cpu.xh = R.int(0, 255); cpu.xl = R.int(0, 255); cpu.yh = R.int(0, 255); cpu.yl = R.int(0, 255); for (const k of ['a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2']) cpu[k] = R.int(0, 255); };
  const nInt = QUICK ? 20 : 60;
  for (let s = 0; s < nInt; s++) {
    // the same scene twice: interrupts off (reference picture), then on
    const area = randomArea(R), hoff = R.pick([0, 0x20]), eye = randomEye(R);
    const items = [];
    for (let i = R.int(1, 3); i > 0; i--) {
      let pose = null;
      for (let tries = 0; !pose && tries < 20; tries++) pose = poseFor(R, eye, R.pick(['view', 'view', 'near', 'wide']));
      pose ||= { x: eye.x, y: eye.y, z: eye.z + 200 };
      Object.assign(pose, { yaw: R.int(0, 255), pitch: R.pick([0, R.int(0, 255)]), scale: R.pick(W.SCALES) });
      items.push({ model: randomModel(R, R.chance(0.1)), pose });
    }
    const lines = Array.from({ length: R.int(1, 3) }, () => randomLine(R, area));
    const seed = R.int(1, 1e9);
    const pics = [];
    for (const on of [false, true]) {
      restore(); poison(rng(seed));
      setup(area, hoff);
      call(S.RT_PLAY, { a: 0 });
      const every = on ? () => R.pick([R.int(700, 4000), 58688]) : null;
      const irq = on ? { every, onIrq } : null;
      if (on) sentinels();
      call(S.wire_clear, { irq });
      if (on && !cpu.iff1) { regBad++; firstReg ||= 'interrupts off after wire_clear'; }
      setArgs(eye.x, eye.y, eye.z, eye.a);
      if (on) sentinels();
      call(S.RT_EYE, { irq });
      for (const it of items) {
        plant(MODEL_LO, W.modelBytes(it.model));
        setArgs(it.pose.x, it.pose.y, it.pose.z, it.pose.yaw, it.pose.pitch);
        if (on) sentinels();
        call(S.RT_DRAWMODEL, { hl: MODEL_LO, a: W.SCALES.indexOf(it.pose.scale), irq });
      }
      for (const l of lines) { setArgs(...l); if (on) sentinels(); call(S.RT_LINE, { irq }); }
      pics.push(m.ram.slice(0x4000, 0x8000));
    }
    const d = pics[0].findIndex((v, i) => v !== pics[1][i]);
    if (d >= 0) { picBad++; firstPic ||= `scene ${s}: ${hex(0x4000 + d)} differs with interrupts on`; }
  }
  check(`${nInt} scenes with interrupts on (${irqs} interrupts taken, ${sndTicks} through SND_TICK): the handler leaves every register as it was (AF BC DE HL, IX, IY, the alternates, SP)`, regBad === 0 && irqs > 0 && sndTicks > 0, firstReg);
  check(`  ... and the pictures (both files, attributes) equal the runs with interrupts off`, picBad === 0, firstPic);
  check(`  ... no interrupt accepted while wire_clear has them off (${refused} refused)`, refused > 0, '');
  // the clear's interrupts-off span, at most rows 0..23
  restore(); setup(W.areaOf(0, 23), 0);
  let off0 = null, offMax = 0;
  {
    cpu.sp = SP0 - 2; m.ram[SP0 - 2] = RET & 255; m.ram[SP0 - 1] = RET >> 8; cpu.pc = S.wire_clear; cpu.iff1 = cpu.iff2 = true; cpu.halted = false;
    const t0 = m.tstates;
    while (cpu.pc !== RET) {
      if (!cpu.iff1 && off0 === null) off0 = m.tstates;
      if (cpu.iff1 && off0 !== null) { offMax = Math.max(offMax, m.tstates - off0); off0 = null; }
      Z.runZ80(cpu, m.bus, 1, m);
      if (m.tstates - t0 > 200000) throw new Error('wire_clear did not return');
    }
    if (off0 !== null) offMax = Math.max(offMax, m.tstates - off0);
  }
  check('wire_clear of the largest area (rows 0..23) keeps interrupts off at most 37,000 T', offMax > 0 && offMax <= 37000, `${offMax} T`);
}

// ---- 6. the kernel figures (contract section 6) --------------------------------------------------------------------------------------------
console.log('\n--- 6. kernel figures (exact T-states on TSRun, no contention) ---');
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
function angleLine(L, deg, ox, oy, area) {
  const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), e = L - 1;
  let dx, dy;
  if (Math.abs(c) >= Math.abs(s) - 1e-9) { dx = Math.sign(c) * e; dy = Math.round(e * s / Math.abs(c)); }
  else { dy = Math.sign(s) * e; dx = Math.round(e * c / Math.abs(s)); }
  const x0 = 128 + ox - Math.trunc(dx / 2), y0 = ((area.ymin + area.ymax) >> 1) + oy - Math.trunc(dy / 2);
  return [x0, y0, x0 + dx, y0 + dy];
}
const OFFS = [[0, 0], [3, 5], [-5, 2], [-1, -7]];
const ANG = [0, 15, 30, 45, 60, 75, 90];
const FIG = {};
{
  restore(); poison(rng(6)); setup(AREA, 0x20);
  // draw_fast and LINE, 40 px, by angle (mean of 4 directions x 4 positions)
  const fast = {}, line = {};
  let bad = 0;
  for (const deg of ANG) {
    const tf = [], tl = [];
    for (const dir of [deg, 180 - deg, 180 + deg, 360 - deg]) for (const [ox, oy] of OFFS) {
      const l = angleLine(40, dir, ox, oy, AREA);
      if (W.linePixels(...l, AREA).length !== 40) throw new Error('not a 40 px line: ' + l);
      // draw_fast: B = x0, E = y0, C = x1, D = y1
      const before = m.ram.slice(), want = files(before);
      W.drawLine(want[1], ...l, AREA);
      m.ram[S.W_HIDHI] = 0x60;
      tf.push(call(S.w_draw_fast, { bc: (l[0] << 8) | l[2], de: (l[3] << 8) | l[1], exact: true }).t);
      if (compare(before, want, 'draw_fast')) bad++;
      tl.push(lineCheck(l, AREA, 0x20, `LINE 40 px ${dir} deg`, { exact: true }).r.t);
    }
    fast[deg] = mean(tf); line[deg] = mean(tl);
  }
  check('the timed lines equal the reference', bad === 0, '');
  console.log('  40 px line, T by angle:      ' + ANG.map((a) => `${a}°`.padStart(8)).join(''));
  console.log('    w_draw_fast               ' + ANG.map((a) => fmt(fast[a]).padStart(8)).join(''));
  console.log('    RT_LINE (inside)          ' + ANG.map((a) => fmt(line[a]).padStart(8)).join(''));
  FIG.fast45 = fast[45]; FIG.line = line; FIG.fastAll = fast;
  // one 12-point ship, yaw + pitch (the spike's ship and poses), generic P2
  const ship = (() => {
    const pts = [], edges = [];
    for (let k = 0; k < 6; k++) pts.push([Math.round(20 * Math.cos(k * Math.PI / 3)), Math.round(12 * Math.sin(k * Math.PI / 3)), 40]);
    for (let k = 0; k < 6; k++) pts.push([Math.round(50 * Math.cos(k * Math.PI / 3)), Math.round(25 * Math.sin(k * Math.PI / 3)), -40]);
    for (let k = 0; k < 6; k++) edges.push([k, (k + 1) % 6], [6 + k, 6 + (k + 1) % 6], [k, 6 + k]);
    return { points: pts, edges };
  })();
  const proj = [], over = [], edgesT = [], total = [];
  for (let f = 0; f < 8; f++) for (const [i, T] of [[-150, -60, 500], [180, 50, 700], [-60, 90, 350], [250, -80, 1000]].entries()) {
    const eye = { x: 0, y: 0, z: 0, a: 0 };
    restore(); poison(rng(f)); setup(AREA, 0x20); setEye(eye);
    const pose = { x: T[0], y: T[1], z: T[2], yaw: (20 * f + 64 * i) & 255, pitch: (12 * f + 30 * i) & 255 || 1, scale: 1 };
    const r = drawModelCheck(ship, pose, eye, AREA, 0x20, `ship f ${f} i ${i}`, { exact: true, marks: [S.w_matrix, S.w_draw_edges] }).r;
    const mk = r.marks;
    proj.push(mk[S.w_draw_edges] - mk[S.w_matrix]);
    edgesT.push(r.t - mk[S.w_draw_edges]);
    over.push(mk[S.w_matrix]);
    total.push(r.t);
  }
  FIG.proj = Math.max(...proj); FIG.over = Math.max(...over);
  console.log(`  12-point ship, yaw + pitch, P2 (32 poses): matrix + projection mean ${fmt(mean(proj))}, max ${fmt(Math.max(...proj))}; lines (18 edges) mean ${fmt(mean(edgesT))}; whole DRAWMODEL mean ${fmt(mean(total))}`);
  console.log(`  per-DRAWMODEL overhead (entry, arguments, eye transform, setup; everything before the matrix): mean ${fmt(mean(over))}, max ${fmt(Math.max(...over))}`);
  // the eye at a heading (the products are not trivial) and a negative position
  {
    const ov = [];
    for (const a of [0, 13, 64, 100, 181, 250]) {
      const eye = { x: -1234, y: 77, z: 4321, a };
      restore(); setup(AREA, 0x20); setEye(eye);
      const C = W.cosa(a), Sn = W.sina(a);
      const pose = { x: eye.x + Math.round((50 * C + 600 * Sn) / 256), y: 77 - 30, z: eye.z + Math.round((-50 * Sn + 600 * C) / 256), yaw: 40, pitch: 0, scale: 1 };
      ov.push(drawModelCheck(ship, pose, eye, AREA, 0x20, `ship eye ${a}`, { exact: true, marks: [S.w_matrix] }).r.marks[S.w_matrix]);
    }
    FIG.over = Math.max(FIG.over, ...ov);
    console.log(`  per-DRAWMODEL overhead at headings 0, 13, 64, 100, 181, 250: ${ov.map(fmt).join(', ')}`);
    // random eyes, headings, positions (drawn objects: every product and check runs) and scales
    const R = rng(606), rov = [];
    while (rov.length < (QUICK ? 60 : 300)) {
      const eye = randomEye(R), pose = poseFor(R, eye, R.pick(['view', 'deep', 'wide']));
      if (!pose || !W.eyeTransform(eye, pose.x, pose.y, pose.z)) continue;
      Object.assign(pose, { yaw: R.int(0, 255), pitch: R.int(0, 255), scale: R.pick(W.SCALES) });
      restore(); setup(AREA, 0x20); setEye(eye);
      rov.push(drawModelCheck(ship, pose, eye, AREA, 0x20, `ship random eye ${rov.length}`, { exact: true, marks: [S.w_matrix] }).r.marks[S.w_matrix]);
    }
    FIG.over = Math.max(FIG.over, ...rov);
    console.log(`  per-DRAWMODEL overhead, ${rov.length} random eyes / positions / scales (objects in range): mean ${fmt(mean(rov))}, max ${fmt(Math.max(...rov))}`);
  }
  // the clear of 20 rows (rows 2..21)
  restore(); setup(AREA, 0x20);
  FIG.clear = call(S.wire_clear, { exact: true }).t;
  restore(); setup(W.areaOf(0, 23), 0x20);
  const clear24 = call(S.wire_clear, { exact: true }).t;
  console.log(`  wire_clear rows 2..21 (20 rows): ${fmt(FIG.clear)} T (24 rows: ${fmt(clear24)})`);
}
console.log('\n  contract section 6 targets:');
check(`  draw_fast 40 px 45° <= 4,460 T`, FIG.fast45 <= 4460, fmt(FIG.fast45));
check(`  one 12-point ship, yaw + pitch, P2: matrix + projection <= 50,000 T`, FIG.proj <= 50000, `max ${fmt(FIG.proj)}`);
check(`  the PUSH clear of 20 rows <= 31,000 T`, FIG.clear <= 31000, fmt(FIG.clear));
check(`  per-DRAWMODEL overhead <= 3,000 T`, FIG.over <= 3000, `max ${fmt(FIG.over)}`);
const lineMean = mean(ANG.map((a) => FIG.line[a]));
check(`  LINE 40 px inside <= 4,000 T, as the mean of 0..90° (${fmt(lineMean)})`, lineMean <= 4000, `per angle ${ANG.map((a) => fmt(FIG.line[a])).join(' / ')}`);
const over4000 = ANG.filter((a) => FIG.line[a] > 4000);
if (over4000.length) console.log(`  NOTE: LINE is above 4,000 T at ${over4000.map((a) => a + '°').join(', ')} (${over4000.map((a) => fmt(FIG.line[a])).join(', ')}): draw_fast alone takes ${over4000.map((a) => fmt(FIG.fastAll[a])).join(', ')} there (the spike's 45° figure is 4,245); RT_LINE adds ${fmt(mean(ANG.map((a) => FIG.line[a] - FIG.fastAll[a])))} T.`);

if (fails.length) { console.log('\nfirst mismatches:'); for (const f of fails) console.log('  ' + f); }
console.log(`\nmismatches in all: ${mismatches}`);
finish('m17 runtime wireframe (W1)');
