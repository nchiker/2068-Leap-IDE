#!/usr/bin/env node
"use strict";
// arcade-codegen-exhaustive.mjs -- the code generator's fixes of the compiler size pass (slice C2: docs/ARCADE_COMPILER_SIZE_CONTRACT.md sections 4 and 6),
// each for EVERY value, on the Z80 (TSRun's CPU) with no game and no runtime: a tiny program is compiled, its PROC FRAME is called directly and its
// variables are read back.
//
//   node tests/arcade-codegen-exhaustive.mjs            everything (about two minutes)
//   ARCADE_QUICK=1 node tests/arcade-codegen-exhaustive.mjs   20 random constants for F1 instead of 200
//
//   F1  x <op> K and K <op> x for all six operators, every 16-bit x, K = the edges and 200 random constants; against the arithmetic (JS)
//   F3  SELECT CASE x for every 16-bit x against case lists with the edges; the case taken against a model, and against the old form (cg.sel off)
//   F6  FOR with a constant limit and STEP 1 (and F1's test with another constant step): starts and limits at the edges, an empty loop, a limit of
//       32767, a body that sets the variable to 32767, EXIT FOR; iterations and the final value against a model and against the old form
//   F8  BAND(x, k) as a truth value / = 0 / <> 0 for every 16-bit x against sets of k
//   F9  every array routine for EVERY 16-bit index, read and write, against the inline form (built here with the emitter, instruction for
//       instruction what the code generator emits inline): the same HL, A, F, BC, DE at return and the same memory; and whole programs on / off
//   F7  PRINT AT constant: LD BC,(row << 8) | col with the clamped values
// Each section also checks that the new form is really what was compiled (the code differs from the fix switched off), so a silently unused
// fix cannot pass.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { Emitter } from '../src/lang/arcade/z80-emit.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const M_ = await import(pathToFileURL(join(ROOT, 'tsrun/machine.js')).href);
const Z_ = await import(pathToFileURL(join(ROOT, 'tsrun/z80.js')).href);
const QUICK = !!process.env.ARCADE_QUICK;

let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// the v2 runtime's tables (only its addresses are used: no runtime routine is ever called by these programs)
const RT = (() => { const d = join(ROOT, 'arcade/build/v2'); const runtime = JSON.parse(readFileSync(join(d, 'runtime.json'), 'utf8')); return { runtime, image: new Uint8Array(readFileSync(join(d, runtime.image ?? 'runtime.bin'))) }; })();
const ALL_OFF = { cmpc: false, sel: false, for: false, at: false, band: false, arr: false };
function build(src, cg) {
  const res = compile(src, { ...RT, assets: { sprites: {} }, ...(cg ? { cg } : {}) });
  if (res.errors.length) throw new Error(`compile: ${JSON.stringify(res.errors.slice(0, 2))}\n${src}`);
  return res;
}
const prog = (dims, body) => `DIM ${dims}\nSCENE main\nPROC INIT()\nENDP\nPROC FRAME()\n${body}\nENDP\nENDSCENE\n`;

const SENT = 0xFFF0;
/** A machine with the compiled game in RAM: {call(addr), rd(name), wr(name, v), m, cpu}. PROC FRAME is called as a subroutine that returns to a HALT. */
function machine(res) {
  const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  m.ram.set(res.memory.subarray(0x4000), 0x4000);
  m.ram[SENT] = 0x76;
  const cpu = m.cpu, vars = res.map.vars;
  const call = (addr, limit = 4_000_000) => {
    cpu.sp = 0xFF00 - 2; m.ram[cpu.sp] = SENT & 0xFF; m.ram[cpu.sp + 1] = SENT >> 8;
    cpu.pc = addr; cpu.halted = false; cpu.iff1 = false; cpu.iff2 = false; cpu.eiDelay = false;
    let guard = 0;
    while (!cpu.halted) { Z_.runZ80(cpu, m.bus, 100000, m); if (++guard * 100000 > limit * 30) throw new Error('runaway code'); }
    if (cpu.pc !== SENT + 1 && cpu.pc !== SENT) throw new Error(`stopped at ${cpu.pc.toString(16)}`);
  };
  const frame = res.gen.symbols.procs.FRAME;
  return {
    m, cpu, call, frame: (limit) => call(frame, limit),
    rd: (n) => { const a = vars[n]; return s16(m.ram[a] | (m.ram[a + 1] << 8)); },
    wr: (n, v) => { const a = vars[n]; m.ram[a] = v & 255; m.ram[a + 1] = (v >> 8) & 255; },
  };
}
const EDGES = [-32768, -32767, -1, 0, 1, 255, 256, 32766, 32767];

// =================================================================================================================
console.log('F1. Comparison with a constant: every 16-bit x, both operand orders, six operators');
{
  const R = rng(0xF1F1);
  const Ks = [...EDGES, 2, 127, 128, 254, -2, -255, -256, -257, 0x1200, -0x1200];
  while (Ks.length < 19 + (QUICK ? 20 : 200)) { const k = s16(Math.floor(R() * 65536)); if (!Ks.includes(k)) Ks.push(k); }
  const OPS = ['<', '<=', '>', '>=', '=', '<>'];
  const truth = (a, op, b) => (op === '<' ? a < b : op === '<=' ? a <= b : op === '>' ? a > b : op === '>=' ? a >= b : op === '=' ? a === b : a !== b);
  const lit = (k) => (k < 0 ? `-${-k}` : String(k));
  const src = (K) => prog('x, r', '  r = 0\n' + OPS.map((op, i) => `  IF x ${op} ${lit(K)} THEN r = r + ${1 << i} ENDIF\n  IF ${lit(K)} ${op} x THEN r = r + ${64 << i} ENDIF`).join('\n'));
  let bad = '', runs = 0, sameAsOff = 0;
  const t0 = Date.now();
  for (const K of Ks) {
    const res = build(src(K)), off = build(src(K), { ...ALL_OFF });
    if (res.gen.code.length === off.gen.code.length && res.gen.code.every((v, i) => v === off.gen.code[i])) sameAsOff++;
    const mc = machine(res);
    for (let x = -32768; x <= 32767 && !bad; x++) {
      mc.wr('X', x); mc.frame();
      let want = 0;
      OPS.forEach((op, i) => { if (truth(x, op, K)) want |= 1 << i; if (truth(K, op, x)) want |= 64 << i; });
      runs++;
      const got = mc.rd('R') & 0xFFFF;
      if (got !== want) { const d = got ^ want, i = Math.log2(d & -d); bad = `K = ${K}, x = ${x}: ${i < 6 ? `x ${OPS[i]} K` : `K ${OPS[i - 6]} x`} is wrong (mask ${got.toString(2)} for ${want.toString(2)})`; }
      if (mc.rd('X') !== x) bad = `K = ${K}, x = ${x}: the variable was changed`;
    }
    if (bad) break;
  }
  check_(`${Ks.length} constants (the edges ${EDGES.join(', ')}, bytes and ${Ks.length - 19} random) x 65,536 values x 12 comparisons: every result is the arithmetic's`, !bad, bad || `${runs} runs of 12 comparisons, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  check_('the constant forms are what was compiled (the code differs from the fix switched off for every constant)', sameAsOff === 0, `${sameAsOff} the same`);
  // the edge comparisons are decided at build time: no compare instruction at all
  const sizeOf = (body) => build(prog('x, r', body)).gen.code.length;
  const none = sizeOf('  r = 1'), always = sizeOf('  IF x >= -32768 THEN r = 1 ENDIF'), never = sizeOf('  IF x < -32768 THEN r = 1 ENDIF'), a2 = sizeOf('  IF x <= 32767 THEN r = 1 ENDIF'), n2 = sizeOf('  IF 32767 < x THEN r = 1 ENDIF');
  check_('x >= -32768 and x <= 32767 compile to the body alone; x < -32768 and 32767 < x to a jump over it (decided at build time)', always === none && a2 === none && never > none && never <= none + 3 && n2 === never, `${none} / ${always} ${a2} / ${never} ${n2} bytes`);
  // the value of a comparison (not only a jump), and comparisons inside AND / OR / NOT
  {
    const body = '  r = (x < 100) + 2 * (x >= -5) + 4 * (x = 7) + 8 * (NOT (x > 300)) + 16 * (x > 3 AND x <= 9) + 32 * (x < -1000 OR x >= 1000) + 64 * (x <> -1) + 128 * (x = 1) + 256 * (x = -1) + 512 * (x = 200)';
    const mc = machine(build(prog('x, r', body)));
    let bad2 = '';
    for (let x = -32768; x <= 32767 && !bad2; x++) {
      mc.wr('X', x); mc.frame();
      const want = (x < 100) + 2 * (x >= -5) + 4 * (x === 7) + 8 * !(x > 300) + 16 * (x > 3 && x <= 9) + 32 * (x < -1000 || x >= 1000) + 64 * (x !== -1) + 128 * (x === 1) + 256 * (x === -1) + 512 * (x === 200);
      if (mc.rd('R') !== want) bad2 = `x = ${x}: ${mc.rd('R')} for ${want}`;
    }
    check_('comparisons as values and inside AND / OR / NOT, every 16-bit x', !bad2, bad2);
  }
  // an expression on the other side (not a plain variable), and a CONST as the constant
  {
    const mc = machine(build('CONST LIM = 1000\n' + prog('x, r', '  r = 0\n  IF x + 1 < LIM THEN r = r + 1 ENDIF\n  IF LIM - 1 >= x * 2 THEN r = r + 2 ENDIF\n  IF x - 3 = 1 THEN r = r + 4 ENDIF')));
    let bad3 = '';
    for (let x = -32768; x <= 32767 && !bad3; x++) {
      mc.wr('X', x); mc.frame();
      const want = (s16(x + 1) < 1000 ? 1 : 0) + (999 >= s16(x * 2) ? 2 : 0) + (s16(x - 3) === 1 ? 4 : 0);
      if (mc.rd('R') !== want) bad3 = `x = ${x}: ${mc.rd('R')} for ${want}`;
    }
    check_('an expression against a CONST, every 16-bit x (the arithmetic wraps first)', !bad3, bad3);
  }
}

// =================================================================================================================
console.log('\nF3. SELECT CASE with constant values: every 16-bit selector');
{
  const lists = [
    { cases: [[0], [1], [255], [256], [-1], [-32768], [32767]], els: true },
    { cases: [[1, 2, 3], [0x1200, 0x12FF], [-256, 0x7F00], [300, -300, 5]], els: true },
    { cases: [[32767, -32768, 0], [-1, 1], [0x00FF, -255]], els: false },
    { cases: [[7]], els: false },
    { cases: [[0x0100, 0x0101, 0x0001], [0x8001], [0x80FF, 0x7FFF, 0x00FF + 1]], els: true },
  ];
  const lit = (k) => (k < 0 ? `-${-k}` : String(k));
  const src = (l, expr = 'x') => prog('x, r, y', `  r = -1\n  SELECT CASE ${expr}\n` + l.cases.map((vals, i) => `    CASE ${vals.map((v) => lit(s16(v))).join(', ')}\n      r = ${i}`).join('\n') + (l.els ? '\n    CASE ELSE\n      r = 99' : '') + '\n  ENDSEL\n  y = x');
  let n = 0;
  for (const l of lists) {
    n++;
    const on = build(src(l)), off = build(src(l), { ...ALL_OFF });
    const a = machine(on), b = machine(off);
    let bad = '';
    for (let x = -32768; x <= 32767 && !bad; x++) {
      a.wr('X', x); a.frame(); b.wr('X', x); b.frame();
      const i = l.cases.findIndex((vals) => vals.some((v) => s16(v) === x));
      const want = i >= 0 ? i : l.els ? 99 : -1;
      if (a.rd('R') !== want) bad = `x = ${x}: case ${a.rd('R')} for ${want}`;
      else if (b.rd('R') !== want) bad = `x = ${x}: the old form gives ${b.rd('R')} for ${want}`;
      else if (a.rd('Y') !== x || a.rd('X') !== x) bad = `x = ${x}: the selector's variable was changed`;
    }
    check_(`list ${n} (${l.cases.map((v) => v.map(s16).join(' ')).join(' | ')}${l.els ? ' | ELSE' : ''}): the case taken for every selector is the model's and the old form's`, !bad && on.gen.code.length < off.gen.code.length && on.usage.varBytes < off.usage.varBytes,
      bad || `${on.gen.code.length} bytes (${off.gen.code.length} before), no hidden slot`);
  }
  // an expression as the selector, and a SELECT inside a case body and after one (the selector lives only through its own tests)
  {
    const src2 = prog('x, r, q', `  r = 0\n  q = 0\n  SELECT CASE x - 1\n    CASE 4\n      SELECT CASE x\n        CASE 5\n          q = 50\n        CASE ELSE\n          q = 51\n      ENDSEL\n      r = 4\n    CASE 9, 10\n      r = 9\n    CASE ELSE\n      r = 77\n  ENDSEL\n  SELECT CASE q\n    CASE 50\n      r = r + 1000\n  ENDSEL`);
    const a = machine(build(src2));
    let bad = '';
    for (let x = -32768; x <= 32767 && !bad; x++) {
      a.wr('X', x); a.frame();
      const k = s16(x - 1), want = k === 4 ? 1004 : k === 9 || k === 10 ? 9 : 77;
      if (a.rd('R') !== want || a.rd('Q') !== (k === 4 ? 50 : 0)) bad = `x = ${x}: r = ${a.rd('R')} q = ${a.rd('Q')} for ${want}`;
    }
    check_('an expression as the selector, a SELECT nested in a case body and one after it: every 16-bit x', !bad, bad);
  }
  // a case value that is not a constant keeps the old form (same bytes as with the fix off)
  {
    const s = prog('x, r, k', '  SELECT CASE x\n    CASE 1\n      r = 1\n    CASE k\n      r = 2\n  ENDSEL');
    const on = build(s, { ...ALL_OFF, sel: true }), off = build(s, { ...ALL_OFF });
    check_('a SELECT with a case value that is not a constant keeps the old form (the same bytes)', on.gen.code.length === off.gen.code.length && on.gen.code.every((v, i) => v === off.gen.code[i]));
  }
}

// =================================================================================================================
console.log('\nF6. FOR with a constant limit (and F1\'s limit test with a constant step)');
{
  // the language's FOR, as the old code and the interpreter do it: {n: iterations, v: the variable after the loop}; `poke` = [iteration, value]: the body sets the variable there;
  // `exitAt`: EXIT FOR in that iteration
  const model = (a, K, step, poke, exitAt) => {
    let v = a, n = 0;
    if (step >= 0 ? v > K : v < K) return { n, v };
    for (;;) {
      n++;
      if (poke && n === poke[0]) v = poke[1];
      if (exitAt && n === exitAt) return { n, v };
      const sum = v + step;
      v = s16(sum);
      if (sum > 32767 || sum < -32768) return { n, v };
      if (step >= 0 ? v > K : v < K) return { n, v };
      if (n > 200000) return { n: -1, v };
    }
  };
  const lit = (k) => (k < 0 ? `-${-k}` : String(k));
  const E = [-32768, -32767, -1, 0, 1, 5, 32766, 32767];
  const cases = [];
  // near pairs only (a loop from -32768 to 32767 is run once, below): |limit - start| small or the loop empty
  for (const a of E) for (const K of E) if (K - a < 12) cases.push({ a, K, step: 1 });
  for (const a of E) for (const d of [0, 1, 2, 7]) if (a + d <= 32767) cases.push({ a, K: a + d, step: 1 });
  cases.push({ a: -32768, K: 32767, step: 1 }, { a: 32760, K: 32767, step: 1 }, { a: 0, K: 32767, step: 1, exitAt: 9 }, { a: -5, K: 5, step: 1, exitAt: 3 });
  cases.push({ a: 0, K: 10, step: 1, poke: [3, 32767] }, { a: 0, K: 32767, step: 1, poke: [3, 32767] }, { a: 0, K: 10, step: 1, poke: [2, 32766] }, { a: 0, K: 10, step: 1, poke: [2, -32768] },
    { a: 0, K: 10, step: 1, poke: [4, 9] }, { a: 0, K: 10, step: 1, poke: [4, 10] }, { a: 0, K: 10, step: 1, poke: [4, 0] }, { a: 0, K: -32768, step: 1 }, { a: -32768, K: -32768, step: 1, poke: [1, 32767] });
  for (const step of [2, 3, 300, -1, -2, -300]) for (const a of E) for (const K of E) { const r = model(a, K, step); if (r.n >= 0 && r.n < 3000) cases.push({ a, K, step }); }
  const src = (c, varStart) => prog('i, n, s', `  n = 0\n  FOR i = ${varStart ? 's' : lit(c.a)} TO ${lit(c.K)}${c.step !== 1 ? ` STEP ${lit(c.step)}` : ''}\n    n = n + 1\n` +
    (c.poke ? `    IF n = ${c.poke[0]} THEN i = ${lit(c.poke[1])} ENDIF\n` : '') + (c.exitAt ? `    IF n = ${c.exitAt} THEN EXIT FOR ENDIF\n` : '') + '  NEXT i');
  let bad = '', runs = 0, shorter = 0, step1 = 0;
  for (const c of cases) {
    const want = model(c.a, c.K, c.step, c.poke, c.exitAt);
    for (const varStart of [false, true]) {
      const on = build(src(c, varStart)), off = build(src(c, varStart), { ...ALL_OFF });
      if (c.step === 1) { step1++; if (on.gen.code.length < off.gen.code.length) shorter++; }
      for (const [tag, res] of [['new', on], ['old', off]]) {
        const mc = machine(res);
        mc.wr('S', c.a); mc.wr('I', 12345);
        try { mc.frame(80_000_000); } catch (x) { bad = `${JSON.stringify(c)} ${varStart ? 'variable start' : 'constant start'} (${tag}): ${x.message}`; break; }
        runs++;
        if (mc.rd('N') !== s16(want.n) || mc.rd('I') !== want.v) { bad = `${JSON.stringify(c)} ${varStart ? 'variable start' : 'constant start'} (${tag}): ${mc.rd('N')} iterations, variable ${mc.rd('I')}; the model has ${want.n}, ${want.v}`; break; }
      }
      if (bad) break;
    }
    if (bad) break;
  }
  check_(`${cases.length} loops (starts and limits at the edges, empty loops, a limit of 32767, -32768 TO 32767, a body that sets the variable, EXIT FOR; STEP 1, 2, 3, 300, -1, -2, -300), each with a constant and a variable start: iterations and the final value are the model's, for the new and the old code`, !bad, bad || `${runs} runs`);
  check_('every STEP 1 loop with a constant limit is shorter than before', shorter === step1 && step1 > 0, `${shorter} of ${step1}`);
  // the first test is decided at build time when start and limit are constants
  const len = (s) => build(prog('i, n', s)).gen.code.length;
  const full = len('  FOR i = 0 TO 9\n    n = n + 1\n  NEXT i'), vs = build(prog('i, n, s', '  FOR i = s TO 9\n    n = n + 1\n  NEXT i')).gen.code.length;
  const empty = build(prog('i, n', '  n = 5\n  FOR i = 3 TO 2\n    n = n + 1\n  NEXT i')), mE = machine(empty); mE.frame();
  check_('constant start and limit: no first test (shorter than with a variable start); an empty loop jumps over its body and still assigns the variable', full < vs && mE.rd('N') === 5 && mE.rd('I') === 3, `${full} / ${vs} bytes`);
  // a run-time step keeps the old form
  const rs = prog('i, n, d', '  FOR i = 0 TO 9 STEP d\n    n = n + 1\n  NEXT i');
  const a1 = build(rs, { ...ALL_OFF, for: true, cmpc: true }), a0 = build(rs, { ...ALL_OFF });
  check_('a FOR with a run-time step keeps the old form (the same bytes)', a1.gen.code.length === a0.gen.code.length && a1.gen.code.every((v, i) => v === a0.gen.code[i]));
}

// =================================================================================================================
console.log('\nF8. BAND with a constant as a truth value: every 16-bit x');
{
  const ks = [0, 1, 2, 0x80, 0xFF, 0x55, 0x100, 0x8000, 0xFF00, 0x1200, 0x0101, 0xFFFF, 0x7FFF, 0x00F0, 0xF000, 0x8001];
  const lit = (k) => { const v = s16(k); return v < 0 ? `-${-v}` : String(v); };
  let bad = '', smaller = 0, one = 0;
  for (const k of ks) {
    const body = `  r = 0\n  IF BAND(x, ${lit(k)}) THEN r = r + 1 ENDIF\n  IF BAND(${lit(k)}, x) <> 0 THEN r = r + 2 ENDIF\n  IF BAND(x, ${lit(k)}) = 0 THEN r = r + 4 ENDIF\n  IF NOT BAND(x, ${lit(k)}) THEN r = r + 8 ENDIF\n  IF 0 = BAND(x + 1, ${lit(k)}) THEN r = r + 16 ENDIF\n  r = r + 32 * (BAND(x, ${lit(k)}) <> 0)\n  y = BAND(x, ${lit(k)})`;
    const on = build(prog('x, r, y', body)), off = build(prog('x, r, y', body), { ...ALL_OFF });
    const lo = k & 255, hi = k >> 8, oneByte = !(lo && hi);
    if (oneByte) { one++; if (on.gen.code.length < off.gen.code.length) smaller++; }
    const mc = machine(on);
    for (let x = -32768; x <= 32767 && !bad; x++) {
      mc.wr('X', x); mc.frame();
      const t = (x & k & 0xFFFF) !== 0, t1 = ((x + 1) & k & 0xFFFF) !== 0;
      const want = (t ? 1 + 2 + 32 : 4 + 8) + (t1 ? 0 : 16);
      if (mc.rd('R') !== want) bad = `k = ${k}, x = ${x}: ${mc.rd('R')} for ${want}`;
      else if ((mc.rd('Y') & 0xFFFF) !== (x & k & 0xFFFF)) bad = `k = ${k}, x = ${x}: the value BAND(x, k) is ${mc.rd('Y')}`;
    }
    if (bad) break;
  }
  check_(`${ks.length} constants x 65,536 values: BAND(x, k) as a condition, <> 0, = 0, NOT, 0 = and as a value`, !bad, bad);
  check_('a constant with bits in one byte only (or none) compiles shorter than before', smaller === one, `${smaller} of ${one}`);
  // BOR and BXOR are left as they are
  const o = prog('x, r', '  IF BOR(x, 4) THEN r = 1 ENDIF\n  IF BXOR(x, 4) = 0 THEN r = 2 ENDIF');
  const b1 = build(o, { ...ALL_OFF, band: true }), b0 = build(o, { ...ALL_OFF });
  check_('BOR and BXOR keep the old form (the same bytes)', b1.gen.code.length === b0.gen.code.length && b1.gen.code.every((v, i) => v === b0.gen.code[i]));
}

// =================================================================================================================
console.log('\nF9. Array access through one routine per array: every 16-bit index against the inline form');
{
  // a program with two reads and two writes of `a` at a run-time index (so both routines exist), and one read and one write of `b` (inline)
  const src = (n) => prog(`a(${n}), b(${n}), i, j, v, r`, '  a(i) = v\n  a(j) = v + 1\n  r = a(i) + a(j)\n  b(i) = r\n  r = r + b(j)\n  r = r + a(2) + b(1)\n  a(1) = 5');
  for (const n of [1, 2, 9, 255, 256, 300, 900]) {
    const res = build(src(n)), em = res.gen.emitter, arr = res.gen.symbols.arrays.A;
    const labels = em.listing().flatMap((it) => it.labels);
    const have = ['lib$ar$A', 'lib$aw$A'].every((l) => labels.includes(l)) && !labels.some((l) => /^lib\$a[rw]\$B/.test(l));
    const sink = res.gen.symbols.slots.find((s) => s.name === 'arr.sink')?.addr;
    // the inline form, as arrayRead / arrayWrite emit it (arrayAddr, the load, the out-of-line stub), made callable: ... back: RET
    const REF = 0x7000;
    const ref = new Emitter(REF);
    const lim = arr.n + 1;
    ref.label('rd'); ref.ld('a', 'l'); ref.sub(lim & 255); ref.ld('a', 'h'); ref.sbc('a', lim >> 8); ref.jp('nc', 'roob'); ref.add('hl', 'hl'); ref.ld('de', arr.addr); ref.add('hl', 'de');
    ref.ld('a', '(hl)'); ref.inc('l'); ref.ld('h', '(hl)'); ref.ld('l', 'a'); ref.label('rback'); ref.ret(); ref.label('roob'); ref.ld('hl', 0); ref.jp('rback');
    ref.label('wr'); ref.ld('a', 'l'); ref.sub(lim & 255); ref.ld('a', 'h'); ref.sbc('a', lim >> 8); ref.jp('nc', 'woob'); ref.add('hl', 'hl'); ref.ld('de', arr.addr); ref.add('hl', 'de');
    ref.label('wback'); ref.ret(); ref.label('woob'); ref.ld('hl', sink); ref.jp('wback');
    const refBytes = ref.finish();
    const mc = machine(res);
    mc.m.ram.set(refBytes, REF);
    for (let k = 0; k <= arr.n; k++) { const v = (k * 2654435761 >>> 7) & 0xFFFF; mc.m.ram[arr.addr + 2 * k] = v & 255; mc.m.ram[arr.addr + 2 * k + 1] = v >> 8; }
    const before = mc.m.ram.slice(0x8000, 0xFF00 - 16);
    const cpu = mc.cpu;
    const run = (addr, idx) => { cpu.a = 0x5A; cpu.f = 0xFF; cpu.b = 0x12; cpu.c = 0x34; cpu.d = 0x56; cpu.e = 0x78; cpu.h = (idx >> 8) & 255; cpu.l = idx & 255; mc.call(addr); return [cpu.h, cpu.l, cpu.a, cpu.f, cpu.b, cpu.c, cpu.d, cpu.e, cpu.sp]; };
    let bad = have ? '' : `the routines are not as expected (${labels.filter((l) => /^lib\$a/.test(l)).join(' ')})`;
    for (const [mode, lab, refLab] of [['read', 'lib$ar$A', 'rd'], ['write', 'lib$aw$A', 'wr']]) {
      if (bad) break;
      const at = em.addressOf(lab), rat = ref.addressOf(refLab);
      for (let idx = 0; idx < 65536 && !bad; idx++) {
        const g = run(at, idx), w = run(rat, idx);
        if (g.join() !== w.join()) bad = `${mode}, index ${s16(idx)}: registers H L A F B C D E SP ${g.map((v) => v.toString(16)).join(' ')}, the inline form ${w.map((v) => v.toString(16)).join(' ')}`;
        // and the meaning, stated on its own: the element / its address inside 0..n, 0 / the sink slot outside
        const hl = (g[0] << 8) | g[1], inside = idx <= arr.n;
        const want = mode === 'read' ? (inside ? mc.m.ram[arr.addr + 2 * idx] | (mc.m.ram[arr.addr + 2 * idx + 1] << 8) : 0) : (inside ? arr.addr + 2 * idx : sink);
        if (!bad && hl !== want) bad = `${mode}, index ${s16(idx)}: HL = ${hl.toString(16)}, expected ${want.toString(16)}`;
      }
    }
    const after = mc.m.ram.slice(0x8000, 0xFF00 - 16);
    if (!bad && !after.every((v, i) => v === before[i])) bad = 'a routine changed memory';
    check_(`DIM a(${n}): lib$ar$A and lib$aw$A for every 16-bit index (0, n, n + 1, -1, -32768, 32767 among them): the registers at return are the inline form's, the value / address is right, memory is untouched; b (one place each) stays inline`, !bad, bad);
  }
  // whole programs, the fix on and off: the same variables and arrays after every call
  {
    const R = rng(0xF9);
    const n = 20;
    const s = prog(`a(${n}), b(${n}), i, j, v, r`, '  a(i) = v\n  a(j) = a(i) + 1\n  r = a(i) + a(j) * 2\n  b(j) = r\n  b(i) = b(j) - a(j)\n  r = r + b(i)\n  a(a(i)) = r\n  r = r + a(b(j))');
    const on = build(s), off = build(s, { cmpc: true, sel: true, for: true, at: true, band: true, arr: false });
    const A = machine(on), B = machine(off);
    const mem = (mc, res) => { const g = res.gen.symbols; return [...Object.values(g.vars), ...Object.values(g.arrays).flatMap((a) => Array.from({ length: a.n + 1 }, (_, k) => a.addr + 2 * k))].map((a) => mc.m.ram[a] | (mc.m.ram[a + 1] << 8)).join(); };
    let bad = '';
    const idx = () => { const p = R(); return p < 0.7 ? Math.floor(R() * (n + 1)) : p < 0.8 ? n + 1 : p < 0.9 ? -1 : s16(Math.floor(R() * 65536)); };
    for (let t = 0; t < 20000 && !bad; t++) {
      const i = idx(), j = idx(), v = t % 7 ? Math.floor(R() * 30) - 5 : s16(Math.floor(R() * 65536));
      for (const mc of [A, B]) { mc.wr('I', i); mc.wr('J', j); mc.wr('V', v); mc.frame(); }
      if (mem(A, on) !== mem(B, off)) bad = `call ${t} (i = ${i}, j = ${j}, v = ${v}): the variables or arrays differ`;
    }
    check_('a program of array reads and writes (indexes in range, at the edges, anywhere; nested a(a(i))), 20,000 calls: every variable and element as with the inline form', !bad && on.gen.code.length < off.gen.code.length, bad || `${on.gen.code.length} bytes (${off.gen.code.length} inline)`);
  }
  // single place, constant index and 2-D: unchanged
  {
    const s = prog('a(9), g(3, 3), i, r', '  r = a(i)\n  a(3) = r\n  r = r + a(4) + g(i, 1)\n  g(1, i) = r');
    const on = build(s, { ...ALL_OFF, arr: true }), off = build(s, { ...ALL_OFF });
    check_('an array read at one place, constant indexes and 2-D arrays keep the old form (the same bytes)', on.gen.code.length === off.gen.code.length && on.gen.code.every((v, i) => v === off.gen.code[i]));
  }
}

// =================================================================================================================
console.log('\nF7. PRINT AT with a constant row and column');
{
  const s = prog('r', '  PRINT AT 5, 7; "A";\n  PRINT AT 0, 0; "B";\n  PRINT AT 23, 31; "C";');
  const on = build(s), off = build(s, { ...ALL_OFF, cmpc: true });
  const items = on.gen.emitter.listing().filter((it) => !it.dead && it.mn === 'ld' && it.args[0] === 'bc' && typeof it.args[1] === 'number').map((it) => it.args[1]);
  const offItems = off.gen.emitter.listing().filter((it) => !it.dead && it.mn === 'ld' && (it.args[0] === 'b' || it.args[0] === 'c')).map((it) => `${it.args[0]}=${it.args[1]}`);
  check_('LD BC,(row << 8) | col (the checker refuses a constant outside the screen), one byte shorter each than LD B / LD C', items.join() === [(5 << 8) | 7, 0, (23 << 8) | 31].join() && offItems.join() === 'b=5,c=7,b=0,c=0,b=23,c=31' && on.gen.code.length === off.gen.code.length - 3,
    `${items.map((v) => v.toString(16)).join(' ')}; ${on.gen.code.length} / ${off.gen.code.length} bytes`);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: arcade-codegen-exhaustive (${passed} checks passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
