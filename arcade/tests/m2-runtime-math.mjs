"use strict";
// m2-runtime-math.mjs -- unit tests of the runtime routines of docs/ARCADE_RUNTIME_API.md, called directly (registers set, a return
// address pushed, run to the RET) on a booted machine: RT_MUL / RT_DIV / RT_MOD against JavaScript references over thousands of
// operand pairs, RT_RND (reference sequence, range, uniformity, period), RT_SHOW / RT_HIDE (clamps, indexes), RT_STICK (the AY
// register 14 protocol of Leap V2's STICK), and IX / IY / alternate-register preservation by every routine.
//   node arcade/tests/m2-runtime-math.mjs
import * as C from './m2-runtime-common.mjs';
const { hex, makeChecks, rd8, rd16, int16 } = C;

const { check, finish } = makeChecks();
const game = C.testGame({}, 'math');             // 2 sprites; the main loop is paused while a routine is called directly
const S = game.syms;
const m = C.newMachine(game.dck);
C.bootMachine(m, S);
for (let f = 0; f < 15; f++) C.M.runFrame(m);
console.log('M2 runtime math/API unit test (routines called directly on a booted machine)\n');

const u16 = (v) => v & 0xFFFF;
function mulberry32(a) { return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const rnd = mulberry32(20261109);
const SPECIAL = [-32768, -32767, -16385, -257, -256, -255, -129, -128, -127, -100, -10, -7, -3, -2, -1, 0, 1, 2, 3, 7, 10, 100, 127, 128, 129,
  255, 256, 257, 1000, 16384, 32766, 32767];
const pairs = [];
for (const a of SPECIAL) for (const b of SPECIAL) pairs.push([a, b]);
for (let k = 0; k < 3000; k++) {
  const bits = (n) => { const w = 1 + Math.floor(rnd() * n); const v = Math.floor(rnd() * (1 << w)); return rnd() < 0.5 ? -v : v; };
  pairs.push([int16(bits(16)), int16(bits(16))]);
}

// ---- RT_MUL / RT_DIV / RT_MOD -------------------------------------------------------------------------------------
const ROUTINES = [['RT_MUL', C.refMul], ['RT_DIV', C.refDiv], ['RT_MOD', C.refMod]];
const memBefore = Array.from(m.ram.slice(0xE000, 0xF000));
console.log(`Arithmetic: ${pairs.length} operand pairs per routine (${SPECIAL.length}x${SPECIAL.length} special values incl. -32768, 32767, 0, 1, -1, plus 3000 random)`);
const timing = {};
for (const [name, ref] of ROUTINES) {
  let bad = 0, first = null, badPres = 0, badSp = 0, badMem = 0;
  const ts = [];
  pairs.forEach(([a, b], k) => {
    const r = C.callRoutine(m, S[name], { hl: u16(a), de: u16(b) });
    const want = u16(ref(a, b));
    if (r.hl !== want) { bad++; first ??= { a, b, got: int16(r.hl), want: int16(want) }; }
    if (!r.preserved) badPres++;
    if (!r.spOk) badSp++;
    if (k % 7 === 0) {                                            // memory untouched (sampled)
      for (let i = 0; i < memBefore.length; i++) if (m.ram[0xE000 + i] !== memBefore[i]) { badMem++; break; }
    }
    ts.push(r.t);
  });
  timing[name] = { min: Math.min(...ts), avg: ts.reduce((s, v) => s + v, 0) / ts.length, max: Math.max(...ts) };
  check(`${name}: result equals the JS reference for all ${pairs.length} pairs`, bad === 0, first ? JSON.stringify(first) : `${pairs.length} pairs`);
  check(`${name}: IX, IY and the alternate registers are preserved, SP balanced, no memory written`, badPres === 0 && badSp === 0 && badMem === 0,
    `${badPres} register, ${badSp} stack, ${badMem} memory`);
}
// the contract's own examples and edge cases, spelled out
const call = (name, a, b) => int16(C.callRoutine(m, S[name], { hl: u16(a), de: u16(b) }).hl);
check('RT_DIV truncates toward zero: -7 DIV 2 = -3, 7 DIV -2 = -3, -7 DIV -2 = 3, 7 DIV 2 = 3',
  call('RT_DIV', -7, 2) === -3 && call('RT_DIV', 7, -2) === -3 && call('RT_DIV', -7, -2) === 3 && call('RT_DIV', 7, 2) === 3);
check('RT_MOD takes the sign of the dividend (V2: MOD(-7,3) = -1): -7 MOD 3 = -1, 7 MOD -3 = 1, -7 MOD -3 = -1, 7 MOD 3 = 1',
  call('RT_MOD', -7, 3) === -1 && call('RT_MOD', 7, -3) === 1 && call('RT_MOD', -7, -3) === -1 && call('RT_MOD', 7, 3) === 1);
check('division by zero gives 0 for DIV and MOD (v0 rule), incl. -32768 and 32767 as dividend',
  [0, 1, -1, -32768, 32767, 12345].every((a) => call('RT_DIV', a, 0) === 0 && call('RT_MOD', a, 0) === 0));
check('-32768 DIV -1 wraps to -32768; -32768 MOD -1 = 0; -32768 DIV 1 = -32768; 32767 DIV -1 = -32767',
  call('RT_DIV', -32768, -1) === -32768 && call('RT_MOD', -32768, -1) === 0 && call('RT_DIV', -32768, 1) === -32768 && call('RT_DIV', 32767, -1) === -32767);
check('(a DIV b) * b + a MOD b = a for every pair with b <> 0 (the Z80 results satisfy the identity, wrapping)',
  pairs.filter(([, b]) => b !== 0).every(([a, b]) => int16(call('RT_DIV', a, b) * b + call('RT_MOD', a, b)) === a));
check('RT_MUL wraps: 32767 * 2 = -2, -32768 * -1 = -32768, 256 * 256 = 0, -1 * -1 = 1',
  call('RT_MUL', 32767, 2) === -2 && call('RT_MUL', -32768, -1) === -32768 && call('RT_MUL', 256, 256) === 0 && call('RT_MUL', -1, -1) === 1);
console.log('  T-states per call (CALL excluded, RET included):');
for (const [name] of ROUTINES) console.log(`    ${name}: min ${timing[name].min}  avg ${timing[name].avg.toFixed(0)}  max ${timing[name].max} over all pairs`);
const typ = (name, a, b) => C.callRoutine(m, S[name], { hl: a, de: b }).t;
console.log(`    typical game operands: RT_MUL 300*3 = ${typ('RT_MUL', 300, 3)} T, RT_MUL 7*5 = ${typ('RT_MUL', 7, 5)} T, RT_DIV 200/3 = ${typ('RT_DIV', 200, 3)} T, RT_DIV 3000/7 = ${typ('RT_DIV', 3000, 7)} T, RT_MOD 600 MOD 200 = ${typ('RT_MOD', 600, 200)} T`);

// ---- RT_RND --------------------------------------------------------------------------------------------------------
console.log('\nRT_RND');
{
  const seed0 = S.RT_SEED_INIT;
  check('RT_SEED_INIT = $ACE1 (the boot value; m2-runtime.mjs tracks RT_SEED through the game from tick 0)', seed0 === 0xACE1);
  // write the seed, call 65535 times, compare every output and the state with the JS reference
  m.ram[S.RT_SEED] = 0xE1; m.ram[S.RT_SEED + 1] = 0xAC;
  let x = 0xACE1, bad = 0, out = new Uint16Array(65535), stateBad = 0, first = null, preserved = true;
  const hist = new Array(16).fill(0), mod5 = new Array(5).fill(0), bits = new Array(15).fill(0);
  let tsum = 0, tmax = 0, tmin = 1e9;
  for (let k = 0; k < 65535; k++) {
    const r = C.callRoutine(m, S.RT_RND, { sentinels: k % 64 === 0 });
    x = C.rndStep(x);
    if (r.hl !== (x & 0x7FFF)) { bad++; first ??= { k, got: r.hl, want: x & 0x7FFF }; }
    if (rd16(m, S.RT_SEED) !== x) stateBad++;
    if (!r.preserved) preserved = false;
    out[k] = r.hl;
    hist[r.hl >> 11]++; mod5[r.hl % 5]++;
    for (let b = 0; b < 15; b++) bits[b] += (r.hl >> b) & 1;
    tsum += r.t; tmax = Math.max(tmax, r.t); tmin = Math.min(tmin, r.t);
  }
  check('65,535 consecutive RT_RND results and the RT_SEED state equal the JS xorshift reference', bad === 0 && stateBad === 0, first ? JSON.stringify(first) : '65,535 calls');
  check('RT_RND preserves IX, IY and the alternates', preserved);
  check('every result is in 0..32767', out.every((v) => v <= 0x7FFF));
  check('the reference generator has full period: the 65,535 states of one cycle are all distinct', (() => { const seen = new Set(); let s = 0xACE1; for (let k = 0; k < 65535; k++) { seen.add(s); s = C.rndStep(s); } return seen.size === 65535 && s === 0xACE1; })());
  const expected = 65535 / 16;
  const chi = hist.reduce((s, v) => s + (v - expected) ** 2 / expected, 0);
  check('uniform over 16 equal bins of 0..32767 (chi-square < 30.6 for 15 d.o.f. at p = 0.01)', chi < 30.6, `chi2 ${chi.toFixed(2)}, bins ${Math.min(...hist)}..${Math.max(...hist)} (mean ${expected.toFixed(0)})`);
  const e5 = 65535 / 5, chi5 = mod5.reduce((s, v) => s + (v - e5) ** 2 / e5, 0);
  check('RND MOD 5 (the game idiom) is uniform (chi-square < 13.3 for 4 d.o.f. at p = 0.01)', chi5 < 13.3, `chi2 ${chi5.toFixed(2)}, counts ${mod5.join(',')}`);
  check('each of the 15 output bits is set in 49.5-50.5 % of the results', bits.every((n) => Math.abs(n / 65535 - 0.5) < 0.005), bits.map((n) => (100 * n / 65535).toFixed(1)).join(' '));
  // serial correlation of consecutive outputs
  const mean = out.reduce((s, v) => s + v, 0) / out.length;
  let num = 0, den = 0;
  for (let k = 0; k < out.length - 1; k++) num += (out[k] - mean) * (out[k + 1] - mean);
  for (let k = 0; k < out.length; k++) den += (out[k] - mean) ** 2;
  check('serial correlation of consecutive results is small (|r| < 0.02)', Math.abs(num / den) < 0.02, `r = ${(num / den).toFixed(4)}`);
  // seed handling
  m.ram[S.RT_SEED] = 0; m.ram[S.RT_SEED + 1] = 0;
  const r0 = C.callRoutine(m, S.RT_RND);
  check('seed 0 (which would stay 0) is read as 1', r0.hl === (C.rndStep(1) & 0x7FFF) && rd16(m, S.RT_SEED) === C.rndStep(1));
  m.ram[S.RT_SEED] = 0x34; m.ram[S.RT_SEED + 1] = 0x12;
  check('RT_SEED is writable: seed $1234 gives the reference result', C.callRoutine(m, S.RT_RND).hl === (C.rndStep(0x1234) & 0x7FFF));
  console.log(`  RT_RND: ${tmin}..${tmax} T, avg ${(tsum / 65535).toFixed(0)} T`);
}

// ---- RT_SHOW / RT_HIDE ---------------------------------------------------------------------------------------------
console.log('\nRT_SHOW / RT_HIDE');
{
  const ent = (i) => ({ vis: rd8(m, S.SPR_TAB + i * 6), z: rd8(m, S.SPR_TAB + i * 6 + 1), x: rd16(m, S.SPR_TAB + i * 6 + 2), y: rd16(m, S.SPR_TAB + i * 6 + 4) });
  const xs = [-32768, -1000, -1, 0, 1, 7, 8, 100, 238, 239, 240, 255, 256, 300, 1000, 32767];
  const ys = [-32768, -1, 0, 5, 100, 175, 176, 177, 191, 192, 255, 256, 32767];
  let bad = 0, first = null, pres = true;
  for (let i = 0; i < 2; i++) for (const x of xs) for (const y of ys) {
    const r = C.callRoutine(m, S.RT_SHOW, { a: i, bc: u16(x), de: u16(y) });
    const e = ent(i);
    const want = { vis: 1, z: 0, x: C.clamp(x, 239), y: C.clamp(y, 176) };
    if (e.vis !== want.vis || e.z !== 0 || e.x !== want.x || e.y !== want.y) { bad++; first ??= { i, x, y, got: e, want }; }
    if (!r.preserved || !r.spOk) pres = false;
  }
  check(`RT_SHOW: visible = 1 and x clamped to 0..239, y to 0..176, for ${2 * xs.length * ys.length} (index, x, y) combinations incl. negatives and 16-bit extremes`, bad === 0, first ? JSON.stringify(first) : '');
  check('RT_SHOW preserves IX, IY and the alternates, balances SP', pres);
  const other = ent(1);
  C.callRoutine(m, S.RT_SHOW, { a: 0, bc: 77, de: 66 });
  check('RT_SHOW of sprite 0 does not change sprite 1\'s entry', JSON.stringify(ent(1)) === JSON.stringify(other));
  const snapshot = JSON.stringify([ent(0), ent(1)]);
  const tabBytes = Array.from(m.ram.slice(S.SPR_TAB, S.SPR_TAB + 24));
  for (const idx of [2, 3, 4, 5, 127, 255]) {
    C.callRoutine(m, S.RT_SHOW, { a: idx, bc: 10, de: 10 });
    C.callRoutine(m, S.RT_HIDE, { a: idx });
  }
  check('an index >= sprite_count (2 here) is ignored by RT_SHOW and RT_HIDE: SPR_TAB (all 4 entries) unchanged',
    JSON.stringify([ent(0), ent(1)]) === snapshot && Array.from(m.ram.slice(S.SPR_TAB, S.SPR_TAB + 24)).every((v, k) => v === tabBytes[k]));
  C.callRoutine(m, S.RT_HIDE, { a: 1 });
  check('RT_HIDE clears the visible flag and keeps the position', ent(1).vis === 0 && ent(1).x === other.x && ent(0).vis === 1);
  const rs = C.callRoutine(m, S.RT_SHOW, { a: 1, bc: 5, de: 6 });
  check('RT_SHOW after RT_HIDE shows again at the new position', ent(1).vis === 1 && ent(1).x === 5 && ent(1).y === 6 && rs.preserved);
  console.log(`  RT_SHOW ${C.callRoutine(m, S.RT_SHOW, { a: 0, bc: 100, de: 100 }).t} T (in range), ${C.callRoutine(m, S.RT_SHOW, { a: 0, bc: u16(-5), de: 9999 }).t} T (clamped), RT_HIDE ${C.callRoutine(m, S.RT_HIDE, { a: 0 }).t} T`);
}

// ---- RT_STICK ------------------------------------------------------------------------------------------------------
console.log('\nRT_STICK (Leap V2 BUILTIN_FN_STICK: AY register 7 bit 6 = 0, register 14, A8 / A9 strobe, invert)');
{
  // TSRun's stick bytes are active low: bit 0 up, 1 down, 2 left, 3 right, 7 fire; the unused bits read high.
  const v2 = (bits) => {                                          // Leap V2's result for an active-low byte read from AY register 14
    let a = (~bits) & 0x0F;
    if (a === 0x0F) a = 0;
    if (((~bits) & 0x80) !== 0) a |= 0x10;
    return a;
  };
  let bad = 0, first = null, pres = true, cross = 0;
  for (let n = 1; n <= 2; n++) {
    for (let v = 0; v < 256; v++) {
      m.joystick[n - 1] = v; m.joystick[2 - n] = 0xFF;            // the other stick idle
      const r = C.callRoutine(m, S.RT_STICK, { a: n });
      if (r.hl !== v2(v)) { bad++; first ??= { stick: n, bits: v, got: r.hl, want: v2(v) }; }
      if (!r.preserved || !r.spOk) pres = false;
    }
    m.joystick[0] = 0xFF; m.joystick[1] = 0xFF;
  }
  check('RT_STICK(1) and RT_STICK(2) equal the V2 result for all 256 input bytes each (0..31; all four directions set read as none)', bad === 0, first ? JSON.stringify(first) : '512 reads');
  check('RT_STICK preserves IX, IY and the alternates', pres);
  m.joystick[0] = 0b11111110; m.joystick[1] = 0b01111011;         // stick 1 up; stick 2 fire + left
  const s1 = C.callRoutine(m, S.RT_STICK, { a: 1 }).hl, s2 = C.callRoutine(m, S.RT_STICK, { a: 2 }).hl;
  check('the sticks are independent (A8 vs A9): stick 1 up = 1, stick 2 left + fire = 20', s1 === 1 && s2 === 20, `${s1}, ${s2}`);
  check('bit values: up 1, down 2, left 4, right 8, fire 16', [[0b11111110, 1], [0b11111101, 2], [0b11111011, 4], [0b11110111, 8], [0b01111111, 16], [0xFF, 0]].every(([b, w]) => { m.joystick[0] = b; return C.callRoutine(m, S.RT_STICK, { a: 1 }).hl === w; }));
  m.joystick[0] = 0xFF; m.joystick[1] = 0xFF;
  check('A other than 1 or 2 gives 0', [0, 3, 255].every((a) => { m.joystick[0] = 0xFE; m.joystick[1] = 0xFE; const r = C.callRoutine(m, S.RT_STICK, { a }).hl === 0; return r; }));
  m.joystick[0] = 0xFE;
  m.ay.regs[7] = 0xFF;                                            // a sound routine left port A an output (V2 v2.1.1's bug): RT_STICK must make it an input
  const r = C.callRoutine(m, S.RT_STICK, { a: 1 });
  check('AY register 7 bit 6 is cleared first (port A an input), so a mixer left with bit 6 = 1 still reads the stick', r.hl === 1 && (m.ay.regs[7] & 0x40) === 0, `result ${r.hl}, R7 ${hex(m.ay.regs[7], 2)}`);
  console.log(`  RT_STICK ${r.t} T`);
  m.joystick[0] = 0xFF; m.joystick[1] = 0xFF;
}

finish('M2 runtime math/API');
