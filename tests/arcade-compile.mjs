"use strict";
// arcade-compile.mjs -- tests for the Leap Arcade compiler back end (milestone M2).
//   node tests/arcade-compile.mjs            (everything that can run; end-to-end sections need arcade/build/runtime.json)
//   ARCADE_QUICK=1 node tests/arcade-compile.mjs   (fewer fuzz games)
//
// Sections
//   1  Z80 emitter: every instruction encoding against sjasmplus (the emitter's optimisations off: it is a plain assembler)
//   1b the emitter's optimisations (compiler size pass F2 / F4 / F5; tests/arcade-emitter-opt.mjs): unit checks, random code and every
//      example game's whole compiled code against sjasmplus, the HL model over the control flow graph, the tail-call exclusions
//   2  reference interpreter: the contract's arithmetic table
//   3  expression fuzz: random expressions compiled and run on a Z80 (TSRun's CPU) vs the interpreter
//   4  differential games: >= 8 programs, per tick SPR_TAB + every variable vs the interpreter
//   5  errors: statements outside the M2 subset
//   6  size report
//   E  (when arcade/build/runtime.json exists) the same fuzz and games on the real runtime, booted from the DCK
//
// The mock runtime used for 3 and 4 is assembled here with sjasmplus (RT_SHOW/HIDE/MUL/DIV/MOD/RND/STICK at
// arbitrary addresses); it is a stand-in for the contract in docs/ARCADE_RUNTIME_API.md, not the real runtime.
import { bootedMachine } from '../arcade/tests/fast-boot.mjs';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { Emitter, L, M } from '../src/lang/arcade/z80-emit.js';
import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret, wrap16 } from '../src/lang/arcade/arcade-interp.js';
import { generate } from '../src/lang/arcade/arcade-codegen.js';
import { link, findSource } from '../src/lang/arcade/arcade-link.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { emitterOptChecks } from './arcade-emitter-opt.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TSRUN = join(ROOT, 'tsrun');
const M_ = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
const Z_ = await import(pathToFileURL(join(TSRUN, 'z80.js')).href);

let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  ok ? passed++ : failed++;
  return ok;
};
const QUICK = !!process.env.ARCADE_QUICK;
const TMP = mkdtempSync(join(tmpdir(), 'arcade-compile-'));
const hex = (v, w = 4) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

/** Seeded PRNG (mulberry32) so failures reproduce. */
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function sjasm(asmText, name, extra = []) {
  const src = join(TMP, name + '.asm');
  writeFileSync(src, asmText);
  const bin = join(TMP, name + '.bin'), sym = join(TMP, name + '.sym');
  try {
    execFileSync('sjasmplus', ['--nologo', `--raw=${bin}`, `--sym=${sym}`, ...extra, src], { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) { throw new Error('sjasmplus failed:\n' + (e.stdout || '') + (e.stderr || '')); }
  const syms = {};
  for (const line of readFileSync(sym, 'utf8').split('\n')) {
    const m = line.match(/^(\S+):\s+EQU\s+0x([0-9A-Fa-f]+)/);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  return { bytes: new Uint8Array(readFileSync(bin)), syms };
}

// =================================================================================================================
// 1. Emitter
// =================================================================================================================
console.log('1. Z80 emitter against sjasmplus');
{
  const R8 = ['b', 'c', 'd', 'e', 'h', 'l', '(hl)', 'a'];
  const R16 = ['bc', 'de', 'hl', 'sp'];
  const CCS = ['nz', 'z', 'nc', 'c', 'po', 'pe', 'p', 'm'];
  const lines = [];
  const add = (s) => lines.push(s);
  for (const d of R8) for (const s of R8) if (!(d === '(hl)' && s === '(hl)')) add(`ld ${d},${s}`);
  for (const d of R8) for (const n of [0, 1, 127, 128, 255]) add(`ld ${d},${n}`);
  for (const n of [0, 1, 0x1234, 0xFFFF, 32768]) for (const d of R16) add(`ld ${d},${n}`);
  for (const a of [0, 0x8123, 0xE100]) {
    add(`ld a,(${a})`); add(`ld (${a}),a`);
    for (const r of R16) { add(`ld ${r},(${a})`); add(`ld (${a}),${r}`); }
  }
  add('ld a,(bc)'); add('ld a,(de)'); add('ld (bc),a'); add('ld (de),a'); add('ld sp,hl');
  add('ld hl,label1'); add('ld de,label1'); add('ld bc,label1+3'); add('ld hl,(label1)'); add('ld (label1),hl'); add('ld a,(label1)');
  for (const r of ['bc', 'de', 'hl', 'af']) { add(`push ${r}`); add(`pop ${r}`); }
  add('ex de,hl'); add("ex af,af'"); add('ex (sp),hl'); add('exx');
  for (const op of ['add', 'adc', 'sbc']) for (const r of R16) add(`${op} hl,${r}`);
  for (const op of ['add', 'adc', 'sub', 'sbc', 'and', 'xor', 'or', 'cp']) {
    for (const r of R8) add(op === 'sub' || op === 'and' || op === 'xor' || op === 'or' || op === 'cp' ? `${op} ${r}` : `${op} a,${r}`);
    for (const n of [0, 1, 0x7F, 0x80, 0xFF]) add(op === 'sub' || op === 'and' || op === 'xor' || op === 'or' || op === 'cp' ? `${op} ${n}` : `${op} a,${n}`);
  }
  for (const r of R8) { add(`inc ${r}`); add(`dec ${r}`); }
  for (const r of R16) { add(`inc ${r}`); add(`dec ${r}`); }
  for (const op of ['rlc', 'rrc', 'rl', 'rr', 'sla', 'sra', 'srl']) for (const r of R8) add(`${op} ${r}`);
  for (const op of ['bit', 'res', 'set']) for (let n = 0; n < 8; n++) for (const r of R8) add(`${op} ${n},${r}`);
  add('label1:');
  add('jp label1'); add('jp label2'); add('jp 0x1234'); add('jp (hl)');
  for (const c of CCS) { add(`jp ${c},label1`); add(`jp ${c},label2`); add(`call ${c},label2`); add(`ret ${c}`); }
  add('call label1'); add('call label2'); add('call 0xC000'); add('ret');
  add('jr label1'); add('jr label2');
  for (const c of ['nz', 'z', 'nc', 'c']) { add(`jr ${c},label1`); add(`jr ${c},label2`); }
  add('djnz label1'); add('djnz label2');
  for (let n = 0; n <= 0x38; n += 8) add(`rst ${n}`);
  for (const i of ['nop', 'halt', 'di', 'ei', 'cpl', 'neg', 'scf', 'ccf', 'rlca', 'rrca', 'rla', 'rra', 'ldi', 'ldir', 'ldd', 'lddr']) add(i);
  add('label2:');
  add('ld (hl),0x55'); add('ld (hl),a');

  const regs = new Set([...R8, ...R16, 'af', "af'"]);
  const parseOperand = (tok, mnem) => {
    tok = tok.trim();
    if (regs.has(tok) || tok === '(bc)' || tok === '(de)' || tok === '(sp)' || CCS.includes(tok)) return tok;
    let m = tok.match(/^\((\w+)\)$/);
    if (m) return M(/^\d+$/.test(m[1]) ? Number(m[1]) : /^0x[0-9a-f]+$/i.test(m[1]) ? parseInt(m[1], 16) : m[1]);
    if (/^-?\d+$/.test(tok)) return Number(tok);
    if (/^0x[0-9a-f]+$/i.test(tok)) return parseInt(tok, 16);
    m = tok.match(/^(\w+)\+(\d+)$/);
    if (m) return L(m[1], Number(m[2]));
    if (['jp', 'jr', 'call', 'djnz'].includes(mnem)) return tok;
    return L(tok);
  };
  const emitLine = (e, line) => {
    if (line.endsWith(':')) { e.label(line.slice(0, -1)); return; }
    const sp = line.indexOf(' ');
    const mnem = sp < 0 ? line : line.slice(0, sp);
    const ops = sp < 0 ? [] : line.slice(sp + 1).split(',').map((t) => parseOperand(t, mnem));
    // a leading condition for jp/jr/call/ret is a string operand like 'nz'
    if (typeof e[mnem] !== 'function') throw new Error(`emitter has no ${mnem}`);
    e[mnem](...ops);
  };
  const ORG = 0x8000;
  const asm = `  org ${ORG}\n` + lines.map((l) => (l.endsWith(':') ? l : '  ' + l)).join('\n') + '\n';
  const ref = sjasm(asm, 'emit').bytes;
  const e = new Emitter(ORG);
  let threw = null;
  try { for (const l of lines) emitLine(e, l); } catch (x) { threw = x; }
  check_('every instruction form is accepted by the emitter', !threw, threw ? String(threw.message) : `${lines.length} lines`);
  if (!threw) {
    const got = e.finish();
    let first = -1;
    for (let i = 0; i < Math.max(got.length, ref.length); i++) if (got[i] !== ref[i]) { first = i; break; }
    let detail = `${got.length} bytes`;
    if (first >= 0) {
      // find which source line the first differing byte belongs to
      const e2 = new Emitter(ORG); let at = '?';
      for (const l of lines) { const before = e2.size; emitLine(e2, l); if (first >= before && first < e2.size) { at = l; break; } }
      detail = `first difference at offset ${first} (${at}): ours ${got[first]?.toString(16)} sjasmplus ${ref[first]?.toString(16)}`;
    }
    check_('emitter output is byte-identical to sjasmplus', first < 0 && got.length === ref.length, detail);
    // the other direction: the text the emitter writes for what it emitted (Emitter.asm(), the basis of section 1b), for every instruction form
    const back = sjasm(e.asm(), 'emit-back').bytes;
    check_('the emitter\'s own assembly text of every instruction form assembles to the same bytes', back.length === got.length && back.every((v, i) => v === got[i]), `${back.length} bytes`);
    check_('with no option the emitter changes nothing (no instruction replaced or left out)', e.listing().every((it) => !it.dead && !it.was) && e.listing().filter((it) => !it.data).length === lines.filter((l) => !l.endsWith(':')).length);
  }
  // range checks and errors
  const bad = (f) => { try { f(); return false; } catch { return true; } };
  check_('JR out of range is an error', bad(() => { const x = new Emitter(0); x.label('a'); x.ds(200); x.jr('a'); x.finish(); }));
  check_('JR just in range (-128) works', !bad(() => { const x = new Emitter(0); x.label('a'); x.ds(126); x.jr('a'); x.finish(); }));
  check_('DJNZ forward 127 works, 128 fails', !bad(() => { const x = new Emitter(0); x.djnz('b'); x.ds(127); x.label('b'); x.finish(); }) && bad(() => { const x = new Emitter(0); x.djnz('b'); x.ds(128); x.label('b'); x.finish(); }));
  check_('undefined label is an error', bad(() => { const x = new Emitter(0); x.jp('nowhere'); x.finish(); }));
  check_('duplicate label is an error', bad(() => { const x = new Emitter(0); x.label('a'); x.label('a'); }));
  check_('8-bit immediate range is checked', bad(() => new Emitter(0).ld('a', 256)) && bad(() => new Emitter(0).ld('a', -129)));
  check_('16-bit immediate range is checked', bad(() => new Emitter(0).ld('hl', 65536)) && bad(() => new Emitter(0).ld('hl', -32769)));
  check_('ld (hl),(hl) is refused', bad(() => new Emitter(0).ld('(hl)', '(hl)')));
  const x2 = new Emitter(0x9000); x2.dw(L('t', 2)); x2.label('t'); x2.db(1);
  check_('dw with a label reference and offset', x2.finish().join() === [0x04, 0x90, 1].join());
}

// =================================================================================================================
// 1b. The emitter's optimisations (F2 JP -> JR, F4 HL tracking, F5 RET folding and tail calls)
// =================================================================================================================
console.log('\n1b. Emitter optimisations (F2, F4, F5)');
emitterOptChecks(check_);

// =================================================================================================================
// 2. Interpreter arithmetic (the contract's semantics table)
// =================================================================================================================
console.log('\n2. Reference interpreter');
{
  const run1 = (expr, init = '') => {
    const src = `GAME "t"\nSCENE s\n DIM r, a, b\n PROC INIT():\n ${init}\n r = ${expr}\n ENDP\n PROC FRAME():\n ENDP\nENDSCENE\n`;
    const { ast, errors } = parse(src);
    if (errors.some((x) => x.severity === 'error')) throw new Error(JSON.stringify(errors));
    return interpret(ast, { ticks: 0 }).init.vars.R;
  };
  const cases = [
    ['32767 + 1', -32768], ['-32768 - 1', 32767], ['-32768 * -1', -32768], ['300 * 300', wrap16(90000)],
    ['-7 DIV 2', -3], ['7 DIV -2', -3], ['-7 MOD 3', -1], ['7 MOD -3', 1], ['-7 MOD -3', -1],
    ['5 DIV 0', 0], ['5 MOD 0', 0], ['-32768 DIV -1', -32768], ['-32768 MOD -1', 0],
    ['(-1) < 1', 1], ['32767 > (-32768)', 1], ['(3 > 2) + (2 > 3)', 1],
    ['NOT 0', 1], ['NOT 5', 0], ['(2 AND 3)', 1], ['(2 AND 0)', 0], ['(0 OR 7)', 1],
    ['BIT(5, 0)', 1], ['BIT(5, 1)', 0], ['BIT(-1, 15)', 1], ['BIT(5, 16)', 0], ['BIT(5, -1)', 0],
    ['ABS(-5)', 5], ['ABS(-32768)', -32768], ['SGN(-9)', -1], ['SGN(0)', 0], ['SGN(44)', 1],
    ['40000', wrap16(40000)],
  ];
  for (const [expr, want] of cases) {
    let got; try { got = run1(expr); } catch (x) { got = String(x.message); }
    if (got !== want) check_(`interp: ${expr}`, false, `got ${got}, want ${want}`);
    else passed++;
  }
  console.log(`  PASS  ${cases.length} arithmetic cases from the contract's semantics`);
  // short circuit: the right side must not run (division by zero would be 0 anyway, so use a counter FN-free test via RND consumption)
  const sc = (() => {
    const src = `GAME "t"\nSCENE s\n DIM r, n\n PROC INIT():\n r = (0 AND RND(10)) + (1 OR RND(10))\n ENDP\n PROC FRAME():\n ENDP\nENDSCENE\n`;
    const { ast } = parse(src); let calls = 0;
    interpret(ast, { ticks: 0, rnd: () => { calls++; return 1; } });
    return calls;
  })();
  check_('AND / OR short-circuit in the interpreter', sc === 0, `${sc} RND calls`);
}

// =================================================================================================================
// the mock runtime (sections 3, 4) -- a stand-in for the contract, at arbitrary addresses
// =================================================================================================================
const MOCK_ASM = `
  org 0xC000
SPR_TAB     equ 0xE010
MOCK_SEED   equ 0xE030
STICK_IN    equ 0xE034

RT_SHOW:                       ; A = index, BC = x, DE = y
    push af
    push de
    ld h,b
    ld l,c
    ld de,239
    call clamp
    ld (tmpx),hl
    pop hl
    ld de,176
    call clamp
    pop af
    ld e,a
    ld d,0
    push hl
    ld h,d
    ld l,e
    add hl,hl
    ld d,h
    ld e,l
    add hl,hl
    add hl,de
    ld de,SPR_TAB
    add hl,de
    ld (hl),1
    inc hl
    ld (hl),0
    inc hl
    ld de,(tmpx)
    ld (hl),e
    inc hl
    ld (hl),d
    inc hl
    pop de
    ld (hl),e
    inc hl
    ld (hl),d
    ret
tmpx: dw 0

RT_HIDE:                       ; A = index
    ld l,a
    ld h,0
    add hl,hl
    ld d,h
    ld e,l
    add hl,hl
    add hl,de
    ld de,SPR_TAB
    add hl,de
    ld (hl),0
    ret

clamp:                         ; HL value, DE max (>= 0) -> HL in 0..max
    bit 7,h
    jr z,cl1
    ld hl,0
    ret
cl1: ld a,e
    sub l
    ld a,d
    sbc a,h
    ret nc
    ex de,hl
    ret

RT_MUL:                        ; HL = HL * DE (low 16 bits)
    ld b,h
    ld c,l
    ld hl,0
    ld a,16
mu1: add hl,hl
    rl e
    rl d
    jr nc,mu2
    add hl,bc
mu2: dec a
    jr nz,mu1
    ret

abs_hl:
    bit 7,h
    ret z
    xor a
    sub l
    ld l,a
    sbc a,a
    sub h
    ld h,a
    ret

udiv:                          ; HL / DE unsigned (DE <> 0, HL <= 32768, DE <= 32768) -> BC = quotient, HL = remainder
    ld c,l
    ld b,h
    ld hl,0
    ld a,16
    or a
ud1: rl c
    rl b
    adc hl,hl
    sbc hl,de
    jr nc,ud2
    add hl,de
    or a
    jr ud3
ud2: scf
ud3: dec a
    jr nz,ud1
    rl c
    rl b
    ret

RT_DIV:
    ld a,d
    or e
    jr nz,dv1
    ld hl,0
    ret
dv1: ld a,h
    xor d
    push af
    call abs_hl
    ex de,hl
    call abs_hl
    ex de,hl
    call udiv
    ld h,b
    ld l,c
    pop af
    bit 7,a
    ret z
    xor a
    sub l
    ld l,a
    sbc a,a
    sub h
    ld h,a
    ret

RT_MOD:
    ld a,d
    or e
    jr nz,md1
    ld hl,0
    ret
md1: ld a,h
    push af
    call abs_hl
    ex de,hl
    call abs_hl
    ex de,hl
    call udiv
    pop af
    bit 7,a
    ret z
    xor a
    sub l
    ld l,a
    sbc a,a
    sub h
    ld h,a
    ret

RT_RND:
    ld hl,(MOCK_SEED)
    ld de,25173
    call RT_MUL
    ld de,13849
    add hl,de
    ld (MOCK_SEED),hl
    res 7,h
    ret

RT_STICK:                      ; A = 1 or 2
    ld hl,STICK_IN
    dec a
    ld e,a
    ld d,0
    add hl,de
    ld l,(hl)
    ld h,0
    ret
`;
const MOCK_SENT = 0xFFF0;
const mockBuild = sjasm(MOCK_ASM, 'mockrt');
const mockImage = new Uint8Array(65536);
mockImage.set(mockBuild.bytes, 0xC000);
const mockRuntime = {
  version: 0,
  symbols: {
    RT_SHOW: mockBuild.syms.RT_SHOW, RT_HIDE: mockBuild.syms.RT_HIDE, RT_MUL: mockBuild.syms.RT_MUL, RT_DIV: mockBuild.syms.RT_DIV,
    RT_MOD: mockBuild.syms.RT_MOD, RT_RND: mockBuild.syms.RT_RND, RT_STICK: mockBuild.syms.RT_STICK,
    V_TICKS: 0xE000, SPR_TAB: 0xE010, RT_SEED: 0xE030,
  },
  constants: { GAME_BASE: 0x8000, GAME_VARS_BASE: 0xE100, GAME_VARS_LIMIT: 0xEFFF, MAX_SPRITES: 4 },
};
const MOCK_STICK_IN = 0xE034;

// ---- shared helpers for sections 3, 4, E ----
const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
const SPRITE16 = {
  w: 16, h: 16,
  rows: Array.from({ length: 16 }, (_, i) => ({ bits: (0xFFFF >> (i >> 1)).toString(16).padStart(4, '0'), mask: 'FFFF' })),
};
const SPRITE8 = { w: 8, h: 8, rows: Array.from({ length: 8 }, (_, i) => ({ bits: (0xFF >> i).toString(16).padStart(2, '0'), mask: i % 2 ? 'FF' : '7E' })) };
const ASSETS = { sprites: { ball: SPRITE16, bat: SPRITE8, ship: SPRITE16, rock: SPRITE8 } };

function compileGame(src, runtime = mockRuntime, image = mockImage, assets = ASSETS) {
  const r = compile(src, { runtime, image, assets });
  return r;
}

/** Run a compiled game on TSRun's Z80 with the mock runtime: no interrupts, init + n ticks, STICK values per tick. */
function runMock(res, { ticks = 0, stick = null, exact = false } = {}) {
  const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  m.ram.set(res.memory.subarray(0x4000), 0x4000);
  m.ram.fill(0xA5, 0xE100, 0xF000);                     // variables start as garbage: the init stub must clear them
  m.ram.fill(0, 0xE000, 0xE100);
  m.ram[0xE030] = 12345 & 0xFF; m.ram[0xE031] = 12345 >> 8;
  m.ram[MOCK_SENT] = 0x76;
  const cpu = m.cpu;
  const call = (addr) => {
    cpu.sp = 0xFF00 - 2; m.ram[cpu.sp] = MOCK_SENT & 0xFF; m.ram[cpu.sp + 1] = MOCK_SENT >> 8;
    cpu.pc = addr; cpu.halted = false; cpu.iff1 = false; cpu.iff2 = false; cpu.eiDelay = false;
    const t0 = m.tstates;
    if (exact) {
      let n = 0;
      while (cpu.pc !== MOCK_SENT) { Z_.runZ80(cpu, m.bus, 1, m); if (++n > 3_000_000) throw new Error('runaway code'); }
      return m.tstates - t0;
    }
    let guard = 0;
    while (!cpu.halted) { Z_.runZ80(cpu, m.bus, 100000, m); if (++guard > 400) throw new Error('runaway code'); }
    return 0;
  };
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    sprites: Array.from({ length: 4 }, (_, i) => ({ visible: m.ram[0xE010 + 6 * i], x: rd16(0xE010 + 6 * i + 2), y: rd16(0xE010 + 6 * i + 4) })),
  });
  const out = { init: null, ticks: [], tstates: [] };
  call(res.map.entries.init);
  out.init = snap();
  for (let t = 1; t <= ticks; t++) {
    const sv = stick ? stick(t) : 0;
    const sv1 = typeof sv === 'number' ? sv : (sv[1] | 0), sv2 = typeof sv === 'number' ? 0 : (sv[2] | 0);
    m.ram[MOCK_STICK_IN] = sv1; m.ram[MOCK_STICK_IN + 1] = sv2;
    out.tstates.push(call(res.map.entries.frame));
    out.ticks.push(snap());
  }
  out.machine = m;
  return out;
}

/** Compare a run (init + ticks of {vars, sprites}) with the interpreter's; returns null or a description of the first difference. */
function diffRuns(got, want, { sprites = true, skipVars = [] } = {}) {
  const cmp = (label, g, w) => {
    for (const [k, v] of Object.entries(w.vars)) {
      if (skipVars.includes(k)) continue;
      if (g.vars[k] !== v) return `${label}: variable ${k} = ${g.vars[k]}, interpreter ${v}`;
    }
    if (sprites) {
      for (let i = 0; i < 4; i++) {
        const a = g.sprites[i], b = w.sprites[i];
        if (a.visible !== b.visible || (b.visible && (a.x !== b.x || a.y !== b.y))) {
          return `${label}: sprite ${i} = ${JSON.stringify(a)}, interpreter ${JSON.stringify(b)}`;
        }
      }
    }
    return null;
  };
  let d = got.init ? cmp('after INIT', got.init, want.init) : null;
  if (d) return d;
  for (let t = 0; t < want.ticks.length; t++) { d = cmp(`tick ${t + 1}`, got.ticks[t], want.ticks[t]); if (d) return d; }
  return null;
}

function interpretSource(src, ticks, stick) {
  const { ast } = parse(src);
  return interpret(ast, { ticks, stick });
}

// =================================================================================================================
// 3. Expression fuzz
// =================================================================================================================
function fuzzExpressions(label, runtime, image, runner, { games, perGame, seed }) {
  console.log(`\n${label}`);
  const rand = rng(seed);
  const pick = (a) => a[Math.floor(rand() * a.length)];
  const INTERESTING = [-32768, 32767, 0, 1, -1, 2, -2, 3, 7, 8, 10, 100, 255, 256, -100, 4, 16, 32766, -32767, 1000, 12345, -12345];
  const lit = (v) => (v < 0 ? `(-${-v})` : String(v));
  const VARS = ['a', 'b', 'c', 'd'];
  const CMP = ['=', '<>', '<', '>', '<=', '>='];
  const gen = (depth) => {
    if (depth <= 0 || rand() < 0.18) {
      const r = rand();
      if (r < 0.55) return pick(VARS);
      if (r < 0.9) return lit(pick(INTERESTING));
      return lit(Math.floor(rand() * 600) - 300);
    }
    const r = rand();
    const sub = () => gen(depth - 1);
    if (r < 0.18) return `(${sub()} + ${sub()})`;
    if (r < 0.34) return `(${sub()} - ${sub()})`;
    if (r < 0.46) return `(${sub()} * ${sub()})`;
    if (r < 0.54) return `(${sub()} DIV ${rand() < 0.3 ? lit(pick([2, 4, 8, 16, 3, 10, -2, 1, -1, 0, 256, 16384])) : sub()})`;
    if (r < 0.62) return `(${sub()} MOD ${rand() < 0.3 ? lit(pick([2, 3, 10, -3, 1, 0, 256, 7])) : sub()})`;
    if (r < 0.72) return `(${sub()} ${pick(CMP)} ${rand() < 0.2 ? '0' : sub()})`;
    if (r < 0.78) return `(${sub()} AND ${sub()})`;
    if (r < 0.84) return `(${sub()} OR ${sub()})`;
    if (r < 0.88) return `(NOT ${sub()})`;
    if (r < 0.92) return `BIT(${sub()}, ${rand() < 0.6 ? lit(pick([0, 1, 7, 8, 15, 16, -1, 3])) : sub()})`;
    if (r < 0.95) return `ABS(${sub()})`;
    if (r < 0.97) return `SGN(${sub()})`;
    if (r < 0.985) return `(-${sub()})`;
    return `(${sub()} * ${lit(pick([2, 4, 8, 16, 3, 0, 1, -1, 1024, 5]))})`;
  };
  let total = 0, ifForms = 0, bad = 0;
  for (let g = 0; g < games; g++) {
    const init = VARS.map((v) => `${v} = ${lit(pick(INTERESTING.concat([Math.floor(rand() * 2000) - 1000])))}`);
    const body = [];
    const rs = [];
    for (let k = 0; k < perGame; k++) {
      const ex = gen(1 + Math.floor(rand() * 4));
      rs.push(`r${k}`);
      if (rand() < 0.45) { body.push(`IF ${ex} THEN r${k} = 1 ELSE r${k} = 0 ENDIF`); ifForms++; } else body.push(`r${k} = ${ex}`);
    }
    const src = `GAME "fuzz"\nSCENE s\n  DIM a, b, c, d, ${rs.join(', ')}\n  PROC INIT():\n    ${init.join(' : ')}\n    ${body.join('\n    ')}\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n`;
    const res = compile(src, { runtime, image, assets: ASSETS });
    if (res.errors.length) { bad++; check_(`fuzz game ${g} compiles`, false, res.errors[0].message + ' @' + res.errors[0].line + '\n' + src); break; }
    const want = interpretSource(src, 0);
    let got;
    try { got = runner(res); } catch (x) { bad++; check_(`fuzz game ${g} runs`, false, x.message); break; }
    const d = diffRuns(got, want, { sprites: false });
    total += perGame;
    if (d) {
      bad++;
      const name = d.match(/variable (\w+)/)?.[1];
      const idx = name && /^R\d+$/.test(name) ? Number(name.slice(1)) : -1;
      console.log(`   mismatch in fuzz game ${g}: ${d}`);
      if (idx >= 0) console.log(`   statement: ${body[idx]}\n   variables: ${init.join(' : ')}`);
      break;
    }
  }
  check_(`${total} random expressions (${ifForms} as IF conditions) match the interpreter`, bad === 0 && total >= (QUICK ? 200 : 3000), `${total} checked`);
}

fuzzExpressions('3. Expression fuzz on the mock runtime (Z80 on TSRun)', mockRuntime, mockImage,
  (res) => runMock(res, { ticks: 0 }), { games: QUICK ? 10 : 100, perGame: 40, seed: 20261109 });

// =================================================================================================================
// 4. Differential games
// =================================================================================================================
const GAMES = [];
const game = (name, src, opts = {}) => GAMES.push({ name, src, ...opts });

game('bouncing sprite', `
GAME "bounce"
FRAMERATE 30
SPRITE ball = "ball"
SCENE play
  DIM bx, by, dx, dy
  PROC INIT():
    bx = 100 : by = 50 : dx = 3 : dy = -2
  ENDP
  PROC FRAME():
    bx = bx + dx
    by = by + dy
    IF bx < 0 OR bx > 240 THEN
      dx = -dx
    ENDIF
    IF by < 0 OR by > 176 THEN
      dy = -dy
    ENDIF
    SHOW ball AT bx, by
  ENDP
ENDSCENE
`, { perf: true });

game('two sprites on separate paths', `
GAME "two"
SPRITE ball = "ball"
SPRITE ship = "ship"
SCENE play
  DIM x1, y1, x2, y2, t
  PROC INIT():
    x1 = 0 : y1 = 20 : x2 = 200 : y2 = 0
  ENDP
  PROC FRAME():
    t = t + 1
    x1 = x1 + 2
    IF x1 > 230 THEN
      x1 = 0
    ENDIF
    y2 = y2 + 3
    IF y2 >= 170 THEN
      y2 = 0 : x2 = x2 - 10
      IF x2 < 20 THEN
        x2 = 220
      ENDIF
    ENDIF
    SHOW ball AT x1, y1
    SHOW ship AT x2, y2
    IF t MOD 50 = 0 THEN
      HIDE ship
    ENDIF
  ENDP
ENDSCENE
`);

game('nested loops, STEP, EXIT FOR', `
GAME "loops"
SCENE s
  DIM i, j, k, sum, cnt, last, lim
  PROC INIT():
    lim = 5
  ENDP
  PROC FRAME():
    sum = 0 : cnt = 0
    FOR i = 1 TO lim
      FOR j = i TO 12 STEP 3
        sum = sum + i * j
        cnt = cnt + 1
        IF sum > 400 THEN
          EXIT FOR
        ENDIF
      NEXT j
      last = j
    NEXT i
    FOR k = 10 TO 1 STEP -4
      sum = sum - k
    NEXT
    k = 32760
    FOR k = 32760 TO 32767 STEP 3
      cnt = cnt + 1
    NEXT k
    lim = lim + 1
    IF lim > 8 THEN
      lim = 2
    ENDIF
  ENDP
ENDSCENE
`);

game('SELECT CASE state machine', `
GAME "select"
SPRITE ball = "ball"
SCENE s
  DIM state, t, x, y, hits
  PROC INIT():
    x = 10 : y = 10
  ENDP
  PROC FRAME():
    t = t + 1
    SELECT CASE state
      CASE 0
        x = x + 4
        IF x >= 200 THEN
          state = 1
        ENDIF
      CASE 1, 2
        y = y + 5
        IF y > 150 THEN
          state = state + 1 : y = 10
        ENDIF
        IF state > 2 THEN
          state = 3
        ENDIF
      CASE 3
        x = x - 7
        IF x < 12 THEN
          state = 0 : hits = hits + 1
        ENDIF
      CASE ELSE
        state = 0
    ENDSEL
    SELECT CASE t MOD 7
      CASE 0 : hits = hits + 100
      CASE 3, 5 : hits = hits + 1000
    ENDSEL
    SHOW ball AT x, y
  ENDP
ENDSCENE
`);

game('PROC calls with parameters', `
GAME "procs"
SPRITE ball = "ball"
SPRITE ship = "ship"
SCENE s
  DIM px, py, qx, qy, n, total
  PROC INIT():
    px = 20 : py = 30 : qx = 100 : qy = 100
  ENDP
  PROC advance(d):
    px = px + d
    IF px > 230 THEN
      CALL wrap(1)
    ENDIF
    IF px < 0 THEN
      CALL wrap(2)
    ENDIF
  ENDP
  PROC wrap(w):
    SELECT CASE w
      CASE 1
        px = 0
      CASE 2
        px = 230
    ENDSEL
    total = total + w
  ENDP
  PROC bump():
    n = n + 1
    qy = qy + 1
  ENDP
  PROC FRAME():
    CALL advance(n MOD 9 - 3)
    CALL advance(5)
    CALL bump()
    IF n MOD 11 = 0 THEN
      CALL advance(-60)
    ENDIF
    qx = qx + FN twice(n MOD 4)
    SHOW ball AT px, py
    SHOW ship AT qx MOD 240, qy MOD 170
  ENDP
  DEF FN twice(v) = v * 2 + 1
ENDSCENE
`);

game('DEF FN', `
GAME "fn"
SPRITE ball = "ball"
DEF FN sq(x) = x * x
DEF FN clampv(v) = (v > 200) * 200 + (v <= 200) * v
SCENE s
  DIM t, x, y, acc
  DEF FN avg(a) = (a + FN sq(t MOD 5)) DIV 2
  PROC INIT():
    acc = 7
  ENDP
  PROC FRAME():
    t = t + 1
    x = FN clampv(FN sq(t MOD 20) + 3)
    y = FN avg(FN avg(t * 3))
    acc = acc + FN sq(FN sq(t MOD 4)) - FN sq(2)
    SHOW ball AT x, y MOD 170
  ENDP
ENDSCENE
`);

game('WHILE, EXIT WHILE, EXIT FOR inside WHILE', `
GAME "while"
SCENE s
  DIM i, j, n, found, steps, acc
  PROC INIT():
    n = 1
  ENDP
  PROC FRAME():
    steps = 0 : i = n
    WHILE i <> 1 AND steps < 50
      IF i MOD 2 = 0 THEN
        i = i DIV 2
      ELSE
        i = 3 * i + 1
      ENDIF
      steps = steps + 1
    WEND
    found = 0
    FOR j = 2 TO 40
      WHILE 1
        IF j * j > n + 100 THEN
          EXIT WHILE
        ENDIF
        found = found + 1
        EXIT FOR
      WEND
    NEXT j
    acc = acc + steps
    n = n + 1
  ENDP
ENDSCENE
`);

game('Breakout-like (paddle, ball, bricks, no text)', `
GAME "breakout"
FRAMERATE 30
SPRITE ball = "ball"
SPRITE bat = "bat"
SCENE play
  DIM bx, by, dx, dy, px, score, bricks, row, lives
  PROC INIT():
    bx = 120 : by = 100 : dx = 2 : dy = -2 : px = 100 : lives = 3
    bricks = 255
  ENDP
  PROC FRAME():
    IF BIT(STICK(1), 2) THEN
      px = px - 4
    ENDIF
    IF BIT(STICK(1), 3) THEN
      px = px + 4
    ENDIF
    IF px < 0 THEN
      px = 0
    ENDIF
    IF px > 232 THEN
      px = 232
    ENDIF
    bx = bx + dx : by = by + dy
    IF bx < 0 OR bx > 240 THEN
      dx = -dx
    ENDIF
    IF by < 0 THEN
      dy = -dy
    ENDIF
    row = by DIV 8
    IF by < 64 AND row < 8 THEN
      IF BIT(bricks, row) THEN
        bricks = bricks - 2 * 2 * 2 * (row = 3) - (row <> 3) * (1 + row * 0)
        dy = ABS(dy)
        score = score + 10
      ENDIF
    ENDIF
    IF by >= 160 THEN
      IF bx + 16 >= px AND bx <= px + 24 THEN
        dy = -ABS(dy)
        dx = SGN(bx - px - 8) * 2 + (dx = 0)
      ELSE
        IF by > 176 THEN
          lives = lives - 1
          by = 100 : dy = -2
          IF lives < 0 THEN
            lives = 3 : score = 0 : bricks = 255
          ENDIF
        ENDIF
      ENDIF
    ENDIF
    SHOW ball AT bx, by
    SHOW bat AT px, 172
  ENDP
ENDSCENE
`, { stick: (t) => ((t * 7) % 11 < 4 ? 4 : (t * 5) % 13 < 5 ? 8 : 0) | (t % 17 === 0 ? 16 : 0) });

game('RND walk', `
GAME "rnd"
SPRITE ball = "ball"
SCENE s
  DIM x, y, r, hist, n
  PROC INIT():
    x = 100 : y = 80
  ENDP
  PROC FRAME():
    r = RND(4)
    SELECT CASE r
      CASE 0
        x = x + 3
      CASE 1
        x = x - 3
      CASE 2
        y = y + 3
      CASE ELSE
        y = y - 3
    ENDSEL
    hist = hist + RND(10) - RND(1000) MOD 3
    n = n + RND(3 + n MOD 5)
    SHOW ball AT x, y
  ENDP
ENDSCENE
`, { rnd: true });

game('arithmetic with wrap across ticks', `
GAME "wrap"
SCENE s
  DIM h, a, b, c, t
  PROC INIT():
    h = 1 : a = 32000 : b = -32000 : c = 77
  ENDP
  PROC FRAME():
    t = t + 1
    h = h * 31 + t
    a = a + 1234
    b = b - 4321
    c = (h DIV 7) MOD 1000 - (a MOD 13) * (b DIV 5)
    IF c < 0 AND NOT BIT(h, 3) OR a > b THEN
      h = h - c
    ENDIF
    IF SGN(c) = ABS(SGN(h)) THEN
      t = t + 2
    ENDIF
  ENDP
ENDSCENE
`);

game('dynamic FOR steps and limits, parameter hiding a variable, STICK(n)', `
GAME "dyn"
SPRITE ship = "ship"
SCENE s
  DIM i, st, lim, acc, n, x, c, k, big
  PROC INIT():
    st = 1 : lim = 6 : n = 3
  ENDP
  PROC bump(n):
    n = n + 10
    acc = acc + n
  ENDP
  PROC FRAME():
    c = c + 1
    st = (c MOD 6) - 3
    IF st = 0 THEN
      st = 2
    ENDIF
    lim = 6
    FOR i = c MOD 5 TO lim
      acc = acc + i
      lim = lim - 1
    NEXT i
    FOR i = 0 TO 20 STEP st
      acc = acc + 1
      IF acc MOD 50 = 49 THEN
        EXIT FOR
      ENDIF
    NEXT
    FOR i = 20 TO 0 STEP st
      acc = acc - 1
      CALL bump(i)
    NEXT i
    k = 0
    FOR big = 32760 TO 32767 STEP st * 3 + 1
      k = k + 1
      IF k > 40 THEN
        EXIT FOR
      ENDIF
    NEXT
    x = STICK(1 + c MOD 3) + STICK(2) * 32
    SHOW ship AT x, n + acc MOD 100
  ENDP
ENDSCENE
`, { stick: (t) => ({ 1: ((t * 3) % 16) & 0x13, 2: (t % 5) & 0x11 }) });

game('global PROC / DEF FN / DIM mixed with scene ones, three sprites', `
GAME "mix"
FRAMERATE 20
SPRITE ball = "ball"
SPRITE ship = "ship"
SPRITE rock = "rock"
DIM g1, g2
DEF FN gdbl(v) = v * 2 + g1
PROC gset(v):
  g1 = v MOD 9
  g2 = g2 + FN gdbl(v)
ENDP
SCENE s
  DIM t, r
  PROC INIT():
    g1 = 3
  ENDP
  PROC FRAME():
    t = t + 1
    CALL gset(t * 3 - 40)
    r = (r + g2) MOD 200
    SHOW ball AT r, 20
    SHOW ship AT g1 * 20, 60 + t MOD 50
    SHOW rock AT 100, 100
    IF t MOD 13 = 0 THEN
      HIDE rock
    ENDIF
    IF t MOD 29 = 0 THEN
      HIDE ball
      HIDE ship
    ENDIF
  ENDP
ENDSCENE
`);

function diffGameTests(label, runner, runtime, image, { makeRnd = null } = {}) {
  console.log(`\n${label}`);
  const TICKS = 150;
  for (const g of GAMES) {
    const res = compile(g.src, { runtime, image, assets: ASSETS });
    if (res.errors.length) { check_(`${g.name}: compiles`, false, `${res.errors[0].message} (line ${res.errors[0].line})`); continue; }
    const stickFn = g.stick ?? (() => 0);
    const want = interpret(parse(g.src).ast, { ticks: TICKS, stick: stickFn, rnd: makeRnd ? makeRnd() : undefined });
    let got;
    try { got = runner(res, { ticks: TICKS, stick: g.stick ?? null, game: g }); } catch (x) { check_(`${g.name}: runs`, false, x.message); continue; }
    const d = diffRuns(got, want, { skipVars: [] });
    check_(`${g.name}: ${TICKS} ticks, ${Object.keys(want.init.vars).length} variables and 4 sprites per tick`, d === null, d ?? `${res.usage.code} code bytes`);
  }
}

diffGameTests('4. Differential games on the mock runtime', (res, o) => runMock(res, o), mockRuntime, mockImage);

// =================================================================================================================
// 5. Errors
// =================================================================================================================
console.log('\n5. Errors for statements outside the M2 subset');
{
  const wrapG = (body, decl = '') => `GAME "e"\nSPRITE ball = "ball"\n${decl}SCENE s\n  DIM a, b\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n${body}\n  ENDP\nENDSCENE\n`;
  const cases = [
    // [name, statement, the word the message starts with, column]
    ['PRINT', '    PRINT AT 0, 0; "hi"', 'PRINT', 4],
    ['TILE', '    TILE 1, 2 = 3', 'TILE', 4],
    ['PLAY', '    PLAY beep', 'PLAY', 4, 'SFX beep = "beep"\n'],
    ['PLOT', '    PLOT 1, 2', 'PLOT', 4],
    ['CLS', '    CLS', 'CLS', 4],
    ['BORDER', '    BORDER 2', 'BORDER', 4],
    ['INK', '    INK 2', 'INK', 4],
    ['POKE', '    POKE 40000, 1', 'POKE', 4],
    ['SILENCE', '    SILENCE', 'SILENCE', 4],
    ['RANDOMISE', '    RANDOMISE 5', 'RANDOMISE', 4],
    ['END', '    END', 'END', 4],
    ['ENTER', '    ENTER s', 'ENTER', 4],
    ['SHOW ... FRAME', '    SHOW ball AT 1, 2 FRAME 1', 'SHOW ... FRAME', 28],
    ['HIT()', '    a = HIT(ball, ball)', 'HIT(', 8],
    ['KEYDOWN()', '    a = KEYDOWN(5)', 'KEYDOWN(', 8],
    ['PEEK()', '    a = PEEK(5)', 'PEEK(', 8],
    ['LEN()', '    a = LEN("x")', 'LEN(', 8],
  ];
  for (const [name, body, word, col, decl] of cases) {
    const r = compileGame(wrapG(body, decl));
    const line = 8 + (decl ? 1 : 0);
    const hit = r.errors.find((e) => e.line === line && /not supported yet in M2/.test(e.message));
    check_(`${name}: "not supported yet in M2" at line ${line}, column ${col}`, !!hit && hit.col === col && hit.message.startsWith(word) && !r.dck,
      hit ? `${hit.message} @${hit.line}:${hit.col}` : JSON.stringify(r.errors.slice(0, 2)));
  }
  { // LINE is a wireframe statement now (docs/ARCADE_WIREFRAME_CONTRACT.md 1.5): without a WIRE3D the checker says so, at the word, and there is no cartridge
    const r = compileGame(wrapG('    LINE 1, 2 TO 3, 4'));
    const hit = r.errors.find((e) => e.line === 8 && /^LINE needs a WIRE3D/.test(e.message));
    check_('LINE without a WIRE3D: "LINE needs a WIRE3D" at line 8, column 4', !!hit && hit.col === 4 && !r.dck, hit ? `${hit.message} @${hit.line}:${hit.col}` : JSON.stringify(r.errors.slice(0, 2)));
  }
  const rec = compileGame(`GAME "r"\nSCENE s\n  DIM a\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n    CALL f(1)\n  ENDP\n  PROC f(n):\n    CALL f(n - 1)\n  ENDP\nENDSCENE\n`);
  check_('recursion is refused', rec.errors.some((e) => /recursion.*not supported yet in M2/.test(e.message)), rec.errors[0]?.message);
  const rec2 = compileGame(`GAME "r"\nSCENE s\n  DIM a\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n    a = FN f(1)\n  ENDP\n  DEF FN f(n) = FN g(n)\n  DEF FN g(n) = FN f(n)\nENDSCENE\n`);
  check_('mutually recursive DEF FNs are refused', rec2.errors.some((e) => /recursion/.test(e.message)), rec2.errors[0]?.message);
  const two = compileGame(`GAME "r"\nSCENE a\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\nSCENE b\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n`);
  check_('a second SCENE is refused', two.errors.some((e) => /SCENE.*not supported yet in M2/.test(e.message)), two.errors[0]?.message);
  const arr = compileGame(`GAME "r"\nSCENE a\n  DIM q(10)\n  PROC INIT():\n    q(1) = 2\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n`);
  check_('arrays are refused', arr.errors.some((e) => /not supported yet in M2/.test(e.message)), arr.errors[0]?.message);
  const five = compileGame(`GAME "r"\nSPRITE a1 = "ball"\nSPRITE a2 = "ball"\nSPRITE a3 = "ball"\nSPRITE a4 = "ball"\nSPRITE a5 = "ball"\nSCENE s\n  PROC INIT():\n    SHOW a1 AT 1, 1 : SHOW a2 AT 1, 1 : SHOW a3 AT 1, 1 : SHOW a4 AT 1, 1 : SHOW a5 AT 1, 1\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n`);
  check_('a fifth sprite is refused', five.errors.some((e) => /at most 4 sprites/.test(e.message)), five.errors[0]?.message);
  const nostick = compile(`GAME "r"\nSCENE s\n  DIM a\n  PROC INIT():\n    a = STICK(1)\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n`,
    { runtime: { ...mockRuntime, symbols: Object.fromEntries(Object.entries(mockRuntime.symbols).filter(([k]) => k !== 'RT_STICK')) }, image: mockImage, assets: ASSETS });
  check_('STICK without RT_STICK is reported', nostick.errors.some((e) => /RT_STICK/.test(e.message)), nostick.errors[0]?.message);
  const noasset = compileGame(`GAME "r"\nSPRITE q = "missing"\nSCENE s\n  PROC INIT():\n    SHOW q AT 1, 1\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n`);
  check_('a missing sprite asset is reported', noasset.errors.some((e) => /missing/.test(e.message)), noasset.errors[0]?.message);
  const bigspr = compile(`GAME "r"\nSPRITE q = "big"\nSCENE s\n  PROC INIT():\n    SHOW q AT 1, 1\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n`,
    { runtime: mockRuntime, image: mockImage, assets: { sprites: { big: { w: 24, h: 8, rows: Array.from({ length: 8 }, () => ({ bits: 'FFFFFF', mask: 'FFFFFF' })) } } } });
  check_('a 24-pixel-wide sprite is "not supported yet in M2"', bigspr.errors.some((e) => /not supported yet in M2/.test(e.message)), bigspr.errors[0]?.message);
  const syn = compileGame('GAME "x"\nSCENE s\n  PROC INIT()\n    a = \nENDSCENE\n');
  check_('syntax errors are passed through and stop the build', syn.errors.length > 0 && !syn.dck);
}

// =================================================================================================================
// linker and image checks (mock runtime)
// =================================================================================================================
console.log('\nLinker and image layout');
{
  const g = GAMES[0];
  const r = compileGame(g.src);
  const mem = r.memory;
  const rd = (a) => mem[a] | (mem[a + 1] << 8);
  check_('header: init, frame, frame_div, sprite_count, sprite_table', rd(0x8000) === r.map.entries.init && rd(0x8002) === r.map.entries.frame && mem[0x8004] === 2 && mem[0x8005] === 1 && rd(0x8006) === 0x8008,
    `init ${hex(rd(0x8000))} frame ${hex(rd(0x8002))} div ${mem[0x8004]} count ${mem[0x8005]} table ${hex(rd(0x8006))}`);
  check_('descriptor: width 16, height 16, data pointer, 0', mem[0x8008] === 16 && mem[0x8009] === 16 && rd(0x800C) === 0 && rd(0x800A) >= 0x8000 + 14 + r.usage.code - 1, `data ${hex(rd(0x800A))}`);
  // sprite row conversion: asset mask FFFF (covers everything) -> contract mask 0000; image = bits
  const dp = rd(0x800A);
  check_('sprite rows converted to mask_hi, mask_lo, image_hi, image_lo', mem[dp] === 0 && mem[dp + 1] === 0 && mem[dp + 2] === 0xFF && mem[dp + 3] === 0xFF && mem[dp + 4 * 8 + 2] === 0x0F && mem[dp + 4 * 8 + 3] === 0xFF,
    [...mem.subarray(dp, dp + 4)].join(','));
  // 8x8 sprite: width 8 left-aligned in 16 bits, mask inverted inside the width, 1 outside
  const r2 = compileGame(GAMES.find((x) => x.name.startsWith('Breakout')).src);   // sprite 1 is `bat`, 8 x 8
  const d2 = r2.memory[0x800A + 6] | (r2.memory[0x800A + 7] << 8);
  check_('an 8-pixel sprite is left-aligned in 16 bits, mask 1 outside it and where the asset does not cover', r2.memory[0x8008 + 6] === 16 && r2.memory[0x8008 + 7] === 8 &&
    [...r2.memory.subarray(d2, d2 + 8)].join() === [0x81, 0xFF, 0x7E, 0x00, 0x00, 0xFF, 0x7F, 0x00].join(),
    [...r2.memory.subarray(d2, d2 + 8)].map((v) => v.toString(16)).join(' '));
  check_('DCK: one bank-0 block, kinds 0 and 2 only, chunks 0, 1, 4, 5', r.dck.length === 9 + 4 * 8192 && r.dck[0] === 0 && [0, 1, 0, 0, 2, 2, 0, 0].every((_, i) => true) &&
    r.dck.slice(1, 9).join() === [2, 2, 0, 0, 2, 2, 0, 0].join(), r.dck.slice(0, 9).join());
  check_('DCK chunks hold the memory image', r.dck.subarray(9 + 2 * 8192, 9 + 3 * 8192).every((v, i) => v === r.memory[0x8000 + i]));
  const s = findSource(r.map, r.map.procs.FRAME + 3);
  check_('source map: an address in PROC FRAME maps to a source line', s && s.line >= 10 && s.line <= 25, JSON.stringify(s));
  const divOf = (fr) => compileGame(`GAME "d"\n${fr}SCENE s\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n`).memory[0x8004];
  check_('frame_div = 60 / FRAMERATE (60 -> 1, 20 -> 3, 5 -> 12; none -> 2)', divOf('FRAMERATE 60\n') === 1 && divOf('FRAMERATE 20\n') === 3 && divOf('FRAMERATE 5\n') === 12 && divOf('') === 2);
  check_('variable symbols are in GAME_VARS', r.map.vars.BX >= 0xE100 && r.map.vars.DY < 0xF000 && Object.keys(r.map.vars).join() === 'BX,BY,DX,DY');
}

// =================================================================================================================
// 6. Size report
// =================================================================================================================
console.log('\n6. Size report (bytes of generated code; mock runtime)');
{
  for (const g of GAMES) {
    const r = compileGame(g.src);
    if (r.errors.length) continue;
    const u = r.usage;
    console.log(`  ${g.name.padEnd(48)} code ${String(u.code).padStart(5)}  sprites ${String(u.spriteData).padStart(4)}  variables ${String(u.varBytes).padStart(3)}  image ${String(u.total).padStart(5)} of 16384`);
  }
  const b = compileGame(GAMES[0].src);
  const run = runMock(b, { ticks: 60, exact: true });
  const ts = run.tstates.slice(1);
  const avg = Math.round(ts.reduce((a, v) => a + v, 0) / ts.length);
  console.log(`  bouncing sprite: PROC FRAME takes ${Math.min(...ts)}..${Math.max(...ts)} T-states per tick (average ${avg}), RT_SHOW included (mock, about ${Math.round(avg / 2)} of ${58688} per refresh x div 2 => ${(avg / (2 * 58688) * 100).toFixed(1)}% of the tick budget)`);
  check_('bouncing sprite fits a 30 fps tick comfortably', avg < 20000, `${avg} T-states`);
}

// =================================================================================================================
// E. End to end on the real runtime
// =================================================================================================================
const RT_JSON = join(ROOT, 'arcade/build/runtime.json');
if (existsSync(RT_JSON)) {
  console.log('\nE. End to end on the real runtime (boot the DCK on a stock TS2068)');
  const rt = JSON.parse(readFileSync(RT_JSON, 'utf8'));
  const img = new Uint8Array(readFileSync(join(dirname(RT_JSON), rt.image)));
  const hasStick = rt.symbols.RT_STICK !== undefined;
  const ROMDIR = join(TSRUN, 'roms');

  /** x -> the TSRun contact byte (active low) for STICK value v: bits 0-3 are directions, 16 is fire (bit 7 of the contact byte). */
  const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
  /**
   * Boot the DCK from reset and run refresh by refresh. A tick runs between one refresh interrupt and the end of its
   * refresh, so after each runFrame V_TICKS tells whether exactly one tick finished; the sample is then the state
   * after that tick's PROC FRAME (the next tick cannot begin before the next interrupt). The joystick contact byte for
   * tick k is set before the refresh in which tick k runs. `init` is null: PROC INIT and tick 1 can share a refresh.
   */
  function runReal(res, { ticks, stick = null }) {
    const m = bootedMachine(res.dck);                       // restored from the boot snapshot (V9), video off (V8)
    const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
    const SYM = rt.symbols;
    const snap = () => ({
      vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
      sprites: Array.from({ length: 4 }, (_, i) => ({ visible: m.ram[SYM.SPR_TAB + 6 * i], x: rd16(SYM.SPR_TAB + 6 * i + 2), y: rd16(SYM.SPR_TAB + 6 * i + 4) })),
    });
    const out = { init: null, ticks: [], error: null };
    const div = res.memory[0x8004];
    const codeLo = res.gen.base, codeHi = res.gen.base + res.gen.code.length;
    const maxFrames = 250 + (ticks + 2) * div * 2;
    // boot: to the cartridge entry; the boot clears memory with interrupts off (V_FRAMES stays 0 until the ISR is live)
    for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
    for (let f = 0; f < maxFrames && out.ticks.length < ticks; f++) {
      const k = out.ticks.length + 1;
      const sv = stick ? stick(k) : 0;
      m.joystick[0] = contact(typeof sv === 'number' ? sv : sv[1] | 0);
      m.joystick[1] = contact(typeof sv === 'number' ? 0 : sv[2] | 0);
      M_.runFrame(m);
      if (rd16(SYM.V_FRAMES) === 0) continue;                       // still booting
      const nt = rd16(SYM.V_TICKS);
      if (nt === k - 1) continue;                                   // no tick finished in this refresh
      if (nt !== k) { out.error = `V_TICKS went from ${k - 1} to ${nt} in one refresh`; break; }
      if (m.cpu.pc >= codeLo && m.cpu.pc < codeHi) { out.error = `tick ${k}: compiled code still running at the end of its refresh (pc ${hex(m.cpu.pc)})`; break; }
      out.ticks.push(snap());
    }
    if (!out.error && out.ticks.length < ticks) out.error = `only ${out.ticks.length} of ${ticks} ticks ran (V_TICKS ${rd16(SYM.V_TICKS)})`;
    out.machine = m;
    return out;
  }
  console.log('  (real-runtime runner present; see arcade/build/runtime.json)');
  fuzzExpressions('E1. Expression fuzz on the real runtime', rt, img, (res) => { const o = runReal(res, { ticks: 1 }); if (o.error) throw new Error(o.error); return { init: o.ticks[0], ticks: [] }; }, { games: QUICK ? 5 : 100, perGame: 40, seed: 77 });
  const realRnd = () => {
    let x = rt.constants.RT_SEED_INIT ?? 0xACE1;
    return () => { if (x === 0) x = 1; x = (x ^ (x << 7)) & 0xFFFF; x ^= x >> 9; x = (x ^ (x << 8)) & 0xFFFF; return x & 0x7FFF; };
  };
  diffGameTests('E2. Differential games on the real runtime', (res, o) => {
    const r = runReal(res, o);
    if (r.error) throw new Error(r.error);
    return r;
  }, rt, img, { makeRnd: realRnd });

  // E3: cycles of one PROC FRAME of the bouncing sprite on the real runtime (RT_SHOW included), stepping instructions
  {
    const res = compile(GAMES[0].src, { runtime: rt, image: img, assets: ASSETS });
    const o = runReal(res, { ticks: 30 });
    const m = o.machine, cpu = m.cpu;
    const fe = res.map.entries.frame;
    const times = [];
    for (let f = 0; f < 30 && times.length < 10; f++) {
      const end = m.frameStart + M_.tStatesPerFrame;
      let t0 = -1, sp0 = 0;
      while (m.tstates < end) {
        if (t0 < 0 && cpu.pc === fe) { t0 = m.tstates; sp0 = cpu.sp; }
        Z_.runZ80(cpu, m.bus, 1, m);
        if (t0 >= 0 && cpu.sp === sp0 + 2 && cpu.pc !== fe) { times.push(m.tstates - t0); t0 = -1; }
      }
      M_.runFrame(m);
    }
    const avg = Math.round(times.reduce((a, v) => a + v, 0) / Math.max(times.length, 1));
    console.log(`  bouncing sprite on the real runtime: PROC FRAME takes ${Math.min(...times)}..${Math.max(...times)} T-states per tick (average ${avg}; ${times.length} ticks measured, RT_SHOW included)`);
    check_('bouncing sprite: frame_entry measured on the real runtime', times.length >= 5 && avg < 20000, `${avg} T-states`);
  }
} else {
  console.log('\nE. End-to-end tests on the real runtime: PENDING (arcade/build/runtime.json does not exist yet)');
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-compile (${passed} checks passed, ${failed} failed)`);
process.exitCode = failed ? 1 : 0;
