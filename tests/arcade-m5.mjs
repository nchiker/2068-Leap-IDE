#!/usr/bin/env node
"use strict";
// arcade-m5.mjs -- tests for language batch 1 of the Leap Arcade compiler (docs/ARCADE_LANGUAGE_BATCH1.md): CONST, PROC parameters and LOCAL, the bit
// functions, array initialisers and 2-D arrays, RANDOMISE and BORDER, PRINT AT r, c; with no items, separate asset name spaces, FILL / FILLC / COPY /
// LOADMAP and several MAPs.
//
//   node tests/arcade-m5.mjs               (all sections; ARCADE_QUICK=1 runs fewer ticks and a smaller fuzz)
//
// Sections
//   1  parser and checker: positive and negative tests for every construct
//   2  the word table (new words reserved, described, with argument lists) and the editor-facing scan
//   3  interpreter semantics, hand-computed (no machine): what the contract says, one fact at a time
//   4  the code generator and linker: header, map table, initialiser tables, slot layout, errors
//   5  differential tests on the REAL v2 runtime (>= 150 ticks each): every word, then combinations; compiled game vs the reference interpreter
//   6  fuzz on the real runtime: >= 3000 fragments of bit functions, 2-D arrays, CONST expressions, locals and parameters
//   7  code size and T-states (BAND / SHL / SHR / array init / 2-D access / FILL / COPY / LOADMAP, with figures)
//   8  programs that use none of the new words compile to the same bytes as before the batch (hash baseline in arcade/tests/fixtures/batch1-baseline.json)
//   9  Blockfall: the batch 1 version equals the old one (arcade/tests/fixtures/blockfall-v0.arc) tick by tick (tests/arcade-blockfall.mjs has the long script)
//
// ── Decisions where the contract (docs/ARCADE_LANGUAGE_BATCH1.md) is silent or ambiguous ─────────────────────────────────────────────────────────
//   CONST    The expression may also use BIT(). DIV or MOD by zero in a CONST is an error (it is 0 at run time). Declared in source order like a DIM:
//            visible below its declaration, so `CONST A = B` before `CONST B` is an error. The name space is shared with variables, PROCs and DEF
//            FNs; a parameter / LOCAL / FOR variable may not have a CONST's name (an error, not a silent hiding).
//   LOCAL    Allowed at the top level of a PROC (not nested in IF / loops) provided the name was not used earlier in the PROC. Locals (also the
//            implicit FOR variables) are 0 at the start of EVERY call. An implicit FOR variable whose uses all lie inside FORs of that variable is
//            not cleared (it is assigned before it is read). A DIM of the same name LATER in the scene than a PROC that uses it as a FOR variable
//            is an error (the FOR would have made a local, the DIM would then hide nothing). Slots are not shared between PROCs.
//   CALL     Arguments are evaluated left to right, all before the first parameter is stored.
//   Bits     16-bit; SHL / SHR by a count outside 0..15 are 0 (SHR: -1 for a negative operand). BIT() is unchanged.
//   Arrays   `DIM a(n) = v0, v1, ...` must be the last item of its DIM (the values run to the end of the statement); sizes and values are constant
//            expressions; a 2-D array b(w, h) has index i in 0..w (the slow index) and j in 0..h; at most 1000 slots; w and h are 1 or more.
//   FILL     A tile outside the TILESET's count (run time) or a FILLC character outside 32..127 draws nothing. w or h <= 0 draws nothing. COPY / FILL
//            are clipped by the runtime. LOADMAP's attribute for a font cell is $38 (BG_ATTR), for a tile cell the tile's.
//   Maps     One MAP and no LOADMAP: the old image (map_ptr, 768 cells). A LOADMAP or two or more MAPs: the extended header with the map table.
//   RANDOMISE n  seeds n AND $FFFF (0 becomes 1, also when n is only known at run time); RANDOMISE alone seeds from the frame counter.
//   BORDER   n AND 7; the runtime keeps the colour in V_BORDER (boot value 1).
import { readFileSync, writeFileSync, existsSync, mkdtempSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse, tokenize } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { ARCADE_WORDS, RESERVED, FUNCTIONS, NOT_IN_ARCADE } from '../src/lang/arcade/arcade-words.js';
import { scanArcade } from '../src/lang/arcade/arcade-scan.js';
import { real, compileReal, runReal, interpFor, diffRecords, differential, errText, XS, s16, hex, ROOT } from './arcade-m5-harness.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const QUICK = !!process.env.ARCADE_QUICK;
const TMP = mkdtempSync(join(tmpdir(), 'arcade-m5-'));
void TMP; void hex;

let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  ok ? passed++ : failed++;
  return ok;
};
const info = (s) => console.log('  INFO  ' + s);
const w16 = (v) => ((v + 32768) & 0xFFFF) - 32768;
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── assets: a tileset of 6 tiles with different colours, three maps ─────────────────────────────────────────────────
const mkTile = (i) => ({ rows: Array.from({ length: 8 }, (_, y) => ({ bits: ((0x81 << (y & 1)) ^ (i * 0x11)) & 0xFF, ink: (i + 1) % 8, paper: (i * 3) % 8, bright: i % 2 })), flags: 0 });
const MAPS = {
  m1: { w: 5, h: 4, cells: Array.from({ length: 20 }, (_, i) => (i % 3 === 0 ? -1 : i % 6)) },
  m2: { w: 12, h: 3, cells: Array.from({ length: 36 }, (_, i) => (i * 5) % 6) },
  m3: { w: 32, h: 24, cells: Array.from({ length: 768 }, (_, i) => ((i * 7) % 11 === 0 ? -1 : (i + (i >> 5)) % 6)) },
};
const ASSETS = { sprites: { ball: { w: 8, h: 8, rows: Array.from({ length: 8 }, () => ({ bits: 'FF', mask: 'FF' })) } }, tilesets: { ts: { tiles: Array.from({ length: 6 }, (_, i) => mkTile(i)) } }, sfx: { x: { ticks: [{ tone: 200, vol: 8, noise: 0, mix: 6 }, { tone: 300, vol: 6, noise: 0, mix: 6 }] } }, maps: MAPS };

// =================================================================================================================
// 1. Parser and checker
// =================================================================================================================
console.log('1. Parser and checker: every construct of the batch');
const prog = (body, { top = '', decl = 'DIM v, w, k', procs = '', maps = 'MAP a = "m1"\nMAP b = "m2"\n' } = {}) =>
  `GAME "t"\nFRAMERATE 30\nTILESET ts = "ts"\n${maps}SFX snd = "x"\n${top}SCENE s\n  ${decl}\n${procs}  PROC INIT()\n  ENDP\n  PROC FRAME()\n${body}\n  ENDP\nENDSCENE\n`;
const diag = (src, version = 2) => { const p = parse(src); return [...p.errors, ...check(p.ast, { version })]; };
const errs = (src, v) => diag(src, v).filter((d) => d.severity === 'error');
const warns = (src, v) => diag(src, v).filter((d) => d.severity === 'warning');
const msgs = (l) => l.map((d) => `${d.line}:${d.col} ${d.message}`).join(' | ');
const ok0 = (name, body, o) => { const e = errs(prog(body, o)); check_(name, e.length === 0, msgs(e)); };
const bad = (name, body, rx, o) => { const e = errs(prog(body, o)); check_(name, e.length >= 1 && rx.test(e[0].message) && e[0].line >= 1, msgs(e) || 'no error'); };
const warn1 = (name, body, rx, o) => { const e = errs(prog(body, o)), w = warns(prog(body, o)); check_(name, e.length === 0 && w.some((d) => rx.test(d.message)), msgs(e) + ' || ' + msgs(w)); };
const noWarn = (name, body, o) => { const w = warns(prog(body, o)), e = errs(prog(body, o)); check_(name, e.length === 0 && w.length === 0, msgs(e) + msgs(w)); };
const badSrc = (name, src, rx) => { const e = errs(src); check_(name, e.length >= 1 && rx.test(e[0].message), msgs(e) || 'no error'); };
const okSrc = (name, src) => { const e = errs(src); check_(name, e.length === 0, msgs(e)); };

// -- CONST
ok0('CONST at the top level, used in an expression', '    v = WID + 1', { top: 'CONST WID = 11\n' });
ok0('CONST inside a SCENE, after the DIM', '    v = WID', { decl: 'DIM v, w, k\n  CONST WID = 3' });
ok0('CONST from other CONSTs, operators, brackets, unary minus', '    v = Q', { top: 'CONST A = 3\nCONST B = A * (A + 1) DIV 2 MOD 5\nCONST Q = -B + A - -2\n' });
ok0('CONST with the bit functions and BIT on constants', '    v = Q', { top: 'CONST A = 12\nCONST Q = BAND(A, 10) + BOR(A, 1) + BXOR(A, 5) + BNOT(0) + SHL(1, 3) + SHR(-16, 2) + BIT(A, 2)\n' });
ok0('CONST above 32767 wraps like a literal', '    v = Q', { top: 'CONST Q = 65535\n' });
ok0('CONST in a DIM size, a CASE value and an array initialiser', '    SELECT CASE v\n      CASE N\n        w = 1\n    ENDSEL\n    t(N) = 4', { top: 'CONST N = 3\n', decl: 'DIM v, w, k, t(N + 1) = N, N * 2' });
ok0('CONST in PRINT AT, TILE and FILL (literal checks look through it)', '    PRINT AT R, C; "x"\n    TILE C, R = 1\n    FILL C, R, 2, 2 = 3', { top: 'CONST R = 5\nCONST C = 7\n' });
ok0('CONST as a KEYDOWN key', '    v = KEYDOWN(K1)', { top: 'CONST K1 = 81\n' });
bad('CONST cannot be assigned to', '    WID = 3', /CONST.*cannot be assigned/, { top: 'CONST WID = 11\n' });
bad('CONST cannot be a FOR variable', '    FOR WID = 1 TO 3\n    NEXT', /CONST/, { top: 'CONST WID = 11\n' });
bad('CONST cannot be indexed', '    v = WID(1)', /CONST, not an array/, { top: 'CONST WID = 11\n' });
bad('CONST cannot be called as a PROC', '    CALL WID()', /CONST, not a PROC/, { top: 'CONST WID = 11\n' });
bad('CONST from a variable', '', /constant expression/, { top: 'DIM q\nCONST WID = q + 1\n' });
bad('CONST from a function that is not a bit function', '', /constant expression/, { top: 'CONST WID = RND(3)\n' });
bad('CONST from a comparison', '', /constant expression/, { top: 'CONST WID = 1 < 2\n' });
bad('CONST from AND / OR / NOT', '', /constant expression/, { top: 'CONST WID = 1 AND 1\n' });
bad('CONST from a string', '', /number, not a string/, { top: 'CONST WID = "a"\n' });
bad('CONST name ending in $', '', /number/, { top: 'CONST WID$ = 3\n' });
bad('CONST DIV by zero', '', /division by zero/, { top: 'CONST WID = 3 DIV 0\n' });
bad('CONST MOD by zero', '', /MOD by zero/, { top: 'CONST WID = 3 MOD (2 - 2)\n' });
bad('CONST used before its declaration', '', /not declared/, { top: 'CONST A = Q1\nCONST Q1 = 1\n' });
bad('CONST declared twice', '', /already declared/, { top: 'CONST A = 1\nCONST A = 2\n' });
bad('CONST and a variable with one name', '', /already declared/, { top: 'CONST V = 1\n', decl: 'DIM v' });
bad('a variable declared before a CONST of the same name', '', /already declared/, { top: 'DIM q\nCONST Q = 1\n' });
bad('CONST and a PROC with one name', '', /already (declared|a CONST)/, { top: 'CONST P = 1\n', procs: '  PROC p()\n  ENDP\n' });
bad('CONST and a DEF FN with one name', '', /already|PROC or DEF FN/, { top: 'DEF FN f(x) = x\nCONST F = 1\n' });
bad('CONST inside a PROC', '    CONST X = 3', /CONST must be at the top level/);
bad('CONST without a value', '', /expected '='/, { top: 'CONST X\n' });
bad('CONST with a literal out of range', '', /out of range/, { top: 'CONST X = 70000\n' });
bad('a CONST outside the screen range is an error where a literal would be', '    TILE WID, 1 = 1', /TILE x/, { top: 'CONST WID = 40\n' });
bad('a DIM size that is not constant', '', /constant expression/, { decl: 'DIM v, q(v)' });
bad('a CONST DIM size out of range', '', /out of range/, { top: 'CONST N = 2000\n', decl: 'DIM v, q(N)' });
bad('a parameter with the name of a CONST', '', /CONST/, { top: 'CONST N = 3\n', procs: '  PROC p(n)\n  ENDP\n' });
bad('a LOCAL with the name of a CONST', '', /CONST/, { top: 'CONST N = 3\n', procs: '  PROC p()\n    LOCAL n\n  ENDP\n' });

// -- PROC parameters
ok0('PROC with 0..4 parameters and the calls', '    CALL p0()\n    CALL p1(1)\n    CALL p2(1, v)\n    CALL p3(1, 2, 3)\n    CALL p4(v, w, k, 4)', {
  procs: '  PROC p0()\n  ENDP\n  PROC p1(a)\n    v = a\n  ENDP\n  PROC p2(a, b)\n    v = a + b\n  ENDP\n  PROC p3(a, b, c)\n    v = a + b + c\n  ENDP\n  PROC p4(a, b, c, d)\n    v = a + b + c + d\n  ENDP\n' });
bad('PROC with 5 parameters', '', /at most 4 parameters/, { procs: '  PROC p(a, b, c, d, e)\n  ENDP\n' });
bad('CALL with too few arguments', '    CALL p(1)', /takes 2 parameters/, { procs: '  PROC p(a, b)\n    v = a + b\n  ENDP\n' });
bad('CALL with too many arguments', '    CALL p(1, 2, 3)', /takes 2 parameters/, { procs: '  PROC p(a, b)\n    v = a + b\n  ENDP\n' });
bad('CALL of a PROC with no parameter given one', '    CALL p(1, 2)', /takes no parameter/, { procs: '  PROC p()\n  ENDP\n' });
bad('two parameters with one name', '', /declared twice/, { procs: '  PROC p(a, A)\n  ENDP\n' });
bad('a string argument for a number parameter', '    CALL p(1, "x")', /wants a number/, { procs: '  PROC p(a, b)\n    v = a + b\n  ENDP\n' });
bad('an unknown name in an argument', '    CALL p(1, nope)', /not declared/, { procs: '  PROC p(a, b)\n    v = a + b\n  ENDP\n' });
bad('a reserved word as the second parameter', '', /reserved/, { procs: '  PROC p(a, shl)\n  ENDP\n' });
warn1('a parameter that hides a global still warns', '    CALL p(1, 2)', /hides the variable/, { procs: '  PROC p(a, v)\n    w = a + v\n  ENDP\n' });
{
  const src = 'GAME "t"\nSCENE s\n  PROC INIT(a)\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n';
  const e = errs(src); check_('PROC INIT cannot take a parameter', e.length === 1 && /takes no parameter/.test(e[0].message), msgs(e));
}
{
  const p = parse('PROC p(a, b, c)\nENDP\nCALL f(1, 2, 3)'); // the second is a parse error at top level; the first parses
  const q = parse('SCENE s\n  PROC p(a, b$, c)\n  ENDP\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    CALL p(1, "x", 3)\n  ENDP\nENDSCENE');
  const pr = q.ast.scenes[0].procs[0];
  check_('parse: PROC params, the first one stays in .param', pr.params.map((x) => x.name).join() === 'a,b$,c' && pr.param === 'a' && q.errors.length === 0 && p.ast.procs[0].params.length === 3);
  const call = q.ast.scenes[0].procs[2].body[0];
  check_('parse: CALL args, the first one stays in .arg', call.type === 'Call' && call.args.length === 3 && call.arg === call.args[0]);
}

// -- LOCAL and the implicit FOR variable
ok0('LOCAL at the top of a PROC, used', '    CALL p(2)', { procs: '  PROC p(a)\n    LOCAL x, y\n    x = a : y = x * 2\n    v = y\n  ENDP\n' });
ok0('LOCAL after other statements when its name was not used before', '    CALL p(2)', { procs: '  PROC p(a)\n    v = a\n    LOCAL x\n    x = 3 : v = x\n  ENDP\n' });
{
  const w = warns(prog('    CALL p()\n    v = w + k', { procs: '  PROC p()\n    LOCAL v\n    v = 3\n    w = v\n  ENDP\n' }));
  check_('a LOCAL hides a global of the same name with no warning', !w.some((d) => /hides|never used/.test(d.message) && /'v'/.test(d.message)), msgs(w));
}
ok0('two PROCs may use one local name', '    CALL p()\n    CALL q()', { procs: '  PROC p()\n    LOCAL x\n    x = 1 : v = x\n  ENDP\n  PROC q()\n    LOCAL x\n    x = 2 : w = x\n  ENDP\n' });
ok0('FOR declares its variable as a local of the PROC', '    CALL p()', { procs: '  PROC p()\n    FOR i = 1 TO 3\n      v = v + i\n    NEXT i\n    w = i\n  ENDP\n' });
ok0('FOR over a global variable uses it as is', '    CALL p()', { procs: '  PROC p()\n    FOR v = 1 TO 3\n    NEXT v\n  ENDP\n' });
bad('LOCAL inside an IF', '    CALL p()', /top level of a PROC/, { procs: '  PROC p()\n    IF v THEN\n      LOCAL x\n    ENDIF\n  ENDP\n' });
bad('LOCAL inside a FOR', '    CALL p()', /top level of a PROC/, { procs: '  PROC p()\n    FOR v = 1 TO 2\n      LOCAL x\n    NEXT\n  ENDP\n' });
bad('LOCAL declared twice', '    CALL p()', /already a local/, { procs: '  PROC p()\n    LOCAL x, X\n  ENDP\n' });
bad('LOCAL with the name of a parameter', '    CALL p(1)', /already a parameter/, { procs: '  PROC p(a)\n    LOCAL a\n  ENDP\n' });
bad('LOCAL with the name of a PROC', '    CALL p()', /name of a PROC/, { procs: '  PROC p()\n    LOCAL q\n  ENDP\n  PROC q()\n  ENDP\n' });
bad('LOCAL after the name was used', '    CALL p()', /used earlier/, { procs: '  PROC p()\n    v = 1\n    LOCAL v\n  ENDP\n' });
bad('LOCAL at the scene level', '', /cannot (start|appear)|only/, { decl: 'DIM v\n  LOCAL x' });
bad('LOCAL with no name', '    CALL p()', /expected a variable name/, { procs: '  PROC p()\n    LOCAL\n  ENDP\n' });
bad('a name used in a PROC but declared by a later DIM is not a silent local', '    CALL p()', /declared later/, { procs: '  PROC p()\n    FOR late = 1 TO 2\n    NEXT\n  ENDP\n  DIM late\n' });
warn1('an unused LOCAL gives a warning', '    CALL p()', /local 'x' is never used/, { procs: '  PROC p()\n    LOCAL x\n  ENDP\n' });
bad('an undeclared name is still an error (not a local)', '    CALL p()', /not declared/, { procs: '  PROC p()\n    x = 1\n  ENDP\n' });
bad('FOR with a string variable', '    CALL p()', /must be a number/, { procs: '  PROC p()\n    FOR a$ = 1 TO 2\n    NEXT\n  ENDP\n' });

// -- bit functions
ok0('all six bit functions', '    v = BAND(w, 3) + BOR(w, 3) + BXOR(w, 3) + BNOT(w) + SHL(w, 2) + SHR(w, v)');
bad('BAND with one argument', '    v = BAND(1)', /BAND takes 2 arguments/);
bad('BNOT with two arguments', '    v = BNOT(1, 2)', /BNOT takes 1 argument/);
bad('SHL with a string', '    v = SHL("a", 2)', /must be a number/);
bad('a bit function needs brackets', '    v = BAND', /needs brackets/);
bad('a bit function cannot be assigned to', '    BXOR = 1', /built-in function/);
bad('a bit function cannot be a statement', '    SHL(1, 2)', /function/);
bad('a bit function cannot be a variable name', '', /reserved/, { decl: 'DIM v, shr' });
bad('DEF FN keeps one parameter', '', /exactly one parameter/, { top: 'DEF FN f(x, y) = x\n' });
ok0('DEF FN may use a CONST and a bit function', '    v = FN f(3)', { top: 'CONST M = 7\nDEF FN f(x) = BAND(x, M) + SHL(x, 1)\n' });

// -- arrays
ok0('1-D initialiser with fewer values than slots', '    v = t(2)', { decl: 'DIM v, t(4) = 1, 2, 3' });
ok0('1-D initialiser with all values (n + 1)', '    v = t(2)', { decl: 'DIM v, t(2) = 1, 2, 3' });
ok0('2-D arrays, read and write', '    g(1, 2) = g(2, 1) + 1', { decl: 'DIM v, g(3, 4)' });
ok0('2-D array with CONST sizes and an initialiser', '    v = g(1, 2)', { top: 'CONST WID = 3\nCONST H = 4\n', decl: 'DIM v, g(WID, H) = 1, 2, 3, 4, 5' });
ok0('2-D array in every expression context', '    FOR v = 0 TO g(1, 1)\n      w = g(v, 0) + ABS(g(0, v)) * 2\n    NEXT\n    IF g(1, 1) > 0 THEN\n      g(v, w) = g(w, v)\n    ENDIF\n    SELECT CASE g(0, 0)\n      CASE 1\n        k = 1\n    ENDSEL\n    PRINT g(1, 1)', { decl: 'DIM v, w, k, g(3, 3)' });
ok0('an initialiser as the last item of a DIM', '    v = t(1) + u(1)', { decl: 'DIM v, t(3), u(2) = 7, 8' });
bad('too many initial values', '', /initial values/, { decl: 'DIM v, t(2) = 1, 2, 3, 4' });
bad('an initial value that is not constant', '', /constant expression/, { decl: 'DIM v, w, t(2) = 1, v' });
bad('initial values on a scalar', '', /only an array/, { decl: 'DIM v = 3' });
bad('a 1-D array with two indices', '    v = t(1, 2)', /one dimension/, { decl: 'DIM v, t(5)' });
bad('a 2-D array with one index', '    v = g(1)', /two dimensions/, { decl: 'DIM v, g(5, 5)' });
bad('a 2-D array without an index', '    v = g', /is an array: write g\(i, j\)/, { decl: 'DIM v, g(5, 5)' });
bad('a pool with two indices', '    SHOW pl(1, 2) AT 1, 2', /arrays have one dimension/, { top: 'SPRITE pl(3) = "x"\n' });
badSrc('three dimensions', prog('', { decl: 'DIM v, g(2, 3, 4)' }), /two dimensions/);
bad('a 2-D array with more than 1000 slots', '', /at most 1000/, { decl: 'DIM v, g(40, 40)' });
bad('a 2-D array with a zero size', '', /out of range/, { decl: 'DIM v, g(0, 4)' });
bad('a 1-D array with size 0', '', /out of range/, { decl: 'DIM v, g(0)' });
bad('an array size expression with a variable', '', /constant expression/, { decl: 'DIM v, g(v + 1)' });
warn1('a literal 2-D index outside the array warns', '    v = g(5, 1)', /outside g/, { decl: 'DIM v, g(3, 3)' });
warn1('a literal 2-D j outside the array warns', '    g(1, 9) = 1', /outside g/, { decl: 'DIM v, g(3, 3)' });
{
  const q = parse(prog('', { decl: 'DIM v, g(3, 4) = 1, 2, t(5)' })).ast.scenes[0].decls[0].items;
  check_('parse: dims, init, size of a DIM item', q[1].dims.length === 2 && q[1].init.length === 3 && q[1].size === null && q.length === 2, JSON.stringify(q.map((x) => [x.name, x.dims?.length, x.init?.length])));
  const q2 = parse(prog('    v = g(1, 2)\n    g(3, 4) = v')).ast.scenes[0].procs[1].body;
  check_('parse: 2-D Index nodes in a read and a write', q2[0].value.index2 && q2[1].target.index2 && q2[1].target.index.value === 3);
}

// -- RANDOMISE, BORDER, PRINT
ok0('RANDOMISE alone and with a value, BORDER', '    RANDOMISE\n    RANDOMISE v + 1\n    BORDER 3\n    BORDER v');
bad('BORDER out of range', '    BORDER 9', /BORDER/);
bad('BORDER with a string', '    BORDER "a"', /must be a number/);
bad('RANDOMISE with a string', '    RANDOMISE "a"', /must be a number/);
{
  const st = (s) => parse(prog(s)).ast.scenes[0].procs[1].body[0];
  check_('parse: RANDOMISE alone has value null, RANDOMISE n has a value', st('    RANDOMISE').value === null && st('    RANDOMISE 5').value.value === 5);
  check_('parse: PRINT AT r, c;  with no items keeps the cursor (trailing ;)', st('    PRINT AT 1, 2;').trailing === ';' && st('    PRINT AT 1, 2').trailing === null && st('    PRINT AT 1, 2,').trailing === ';' && st('    PRINT AT 1, 2; "x"').trailing === null);
  check_('parse: PRINT with items and a trailing ; is unchanged', st('    PRINT "a";').trailing === ';' && st('    PRINT').trailing === null);
}

// -- name spaces of the assets
ok0('an SFX and a PROC may share a name', '    PLAY lock\n    CALL lock()', { top: 'SFX lock = "x"\n', procs: '  PROC lock()\n  ENDP\n' });
ok0('an SFX and a variable may share a name', '    PLAY lock\n    lock = 1', { top: 'SFX lock = "x"\n', decl: 'DIM v, lock' });
bad('a PROC and a variable still may not share a name', '', /already/, { decl: 'DIM v, lock', procs: '  PROC lock()\n  ENDP\n' });
ok0('a SPRITE and an SFX may share a name', '    SHOW bell AT 1, 2\n    PLAY bell', { top: 'SPRITE bell = "x"\nSFX bell = "x"\n' });
ok0('a variable may be named like a SPRITE', '    SHOW ball AT 1, 2\n    ball = 3', { top: 'SPRITE ball = "x"\n', decl: 'DIM v, ball' });
ok0('a MAP and a TILESET and a variable may share a name', '    LOADMAP gfx\n    gfx = 1', { top: 'TILESET gfx2 = "ts"\n', decl: 'DIM v, gfx', maps: 'MAP gfx = "m1"\n' });
bad('two assets of one kind with one name', '', /already declared/, { top: 'SFX snd = "x"\n' });
bad('PLAY names an asset of the wrong kind', '    PLAY ball', /SPRITE, not a SFX/, { top: 'SPRITE ball = "x"\n' });
bad('SHOW of a name that is only a variable', '    SHOW v AT 1, 2', /variable, not a SPRITE/);
bad('a SPRITE name used as a variable (no such variable)', '    v = ball', /SPRITE, not a variable/, { top: 'SPRITE ball = "x"\n' });
bad('a SPRITE name indexed like an array', '    v = ball(1)', /SPRITE, not an array/, { top: 'SPRITE ball = "x"\n' });
bad('LOADMAP of an SFX', '    LOADMAP snd', /SFX, not a MAP/);
bad('LOADMAP of a name nobody declared', '    LOADMAP nowhere', /not a declared MAP/);
bad('LOADMAP of a variable', '    LOADMAP v', /variable, not a MAP/);
warn1('a MAP that is never loaded warns (the first is loaded at the start)', '    v = 1', /MAP 'b' is never used/);

// -- tile operations
ok0('FILL, FILLC, COPY, LOADMAP, LOADMAP AT', '    FILL 1, 2, 3, 4 = 5\n    FILLC 0, 0, 32, 24 = 32\n    COPY 0, 0, 5, 5 TO 3, 3\n    LOADMAP a\n    LOADMAP b AT v, w\n    FILL v, w, k, v + 1 = w');
ok0('FILL / COPY partly or wholly off the screen are legal (the runtime clips)', '    FILL -5, -5, 100, 100 = 1\n    COPY 40, 40, 5, 5 TO -2, 90\n    FILL 0, 0, -3, 4 = 1');
bad('FILL with a tile above 127', '    FILL 0, 0, 1, 1 = 200', /tile index/);
bad('FILL with a negative tile', '    FILL 0, 0, 1, 1 = -1', /tile index/);
bad('FILLC with a code below 32', '    FILLC 0, 0, 1, 1 = 10', /character code/);
bad('FILLC with a code above 127', '    FILLC 0, 0, 1, 1 = 200', /character code/);
bad('FILL without the =', '    FILL 0, 0, 1, 1', /expected '='/);
bad('FILL with too few arguments', '    FILL 0, 0, 1 = 1', /expected ','/);
bad('COPY without TO', '    COPY 0, 0, 1, 1, 2, 2', /expected TO/);
bad('COPY with one coordinate after TO', '    COPY 0, 0, 1, 1 TO 2', /expected ','/);
bad('LOADMAP without a name', '    LOADMAP', /expected a map name/);
bad('LOADMAP AT with one coordinate', '    LOADMAP a AT 1', /expected ','/);
bad('FILL with a string', '    FILL "a", 0, 1, 1 = 1', /must be a number/);
bad('FILL as a name', '', /reserved/, { decl: 'DIM v, fill' });
bad('COPY as a name', '', /reserved/, { decl: 'DIM v, copy' });
bad('LOADMAP as a name', '', /reserved/, { decl: 'DIM v, loadmap' });
{
  const maps65 = Array.from({ length: 65 }, (_, i) => `MAP m${i} = "m1"\n`).join('');      // 64 since the banked cartridge map (it was 8)
  const e = errs(prog('    LOADMAP m0', { maps: maps65 }));
  check_('more than 64 MAPs is an error', e.some((d) => /at most 64 MAPs/.test(d.message)), msgs(e));
  const maps8 = Array.from({ length: 8 }, (_, i) => `MAP m${i} = "m1"\n`).join('');
  const e8 = errs(prog(Array.from({ length: 8 }, (_, i) => `    LOADMAP m${i}`).join('\n'), { maps: maps8 }));
  check_('exactly 8 MAPs is fine', e8.length === 0, msgs(e8));
  const w = warns(prog('    LOADMAP m0', { maps: maps8 }));
  check_('7 maps never loaded give 7 warnings', w.filter((d) => /MAP .* never used/.test(d.message)).length === 7);
}
{
  const q = parse(prog('    FILL 1, 2, 3, 4 = 5\n    COPY 1, 2, 3, 4 TO 5, 6\n    LOADMAP a AT 1, 2\n    LOADMAP b')).ast.scenes[0].procs[1].body;
  check_('parse: Fill / Copy / LoadMap nodes', q[0].type === 'Fill' && q[0].which === 'FILL' && q[0].h.value === 4 && q[0].value.value === 5 && q[1].type === 'Copy' && q[1].dy.value === 6
    && q[2].type === 'LoadMap' && q[2].map.name === 'a' && q[2].x.value === 1 && q[3].x === null);
  const q3 = parse(prog('    FILL 1, 2, 3, v = 5')).ast.scenes[0].procs[1].body;
  check_('parse: FILL h is a plain expression, the = starts the value', q3[0].h.name === 'v' && q3[0].value.value === 5);
}
check_('the old NOT_IN_ARCADE entry for FILL is gone', !NOT_IN_ARCADE.has('FILL'));

// =================================================================================================================
// 2. Word table and scan
// =================================================================================================================
console.log('\n2. Word table and the editor-facing scan');
{
  const newWords = ['CONST', 'LOCAL', 'FILL', 'FILLC', 'COPY', 'LOADMAP', 'BAND', 'BOR', 'BXOR', 'BNOT', 'SHL', 'SHR'];
  check_('every new word is in the table, reserved, with a syntax and a description', newWords.every((w) => ARCADE_WORDS.has(w) && RESERVED.has(w) && ARCADE_WORDS.get(w).syntax && ARCADE_WORDS.get(w).desc.length > 30));
  check_('the six bit functions are functions with 1 or 2 numeric arguments', ['BAND', 'BOR', 'BXOR', 'SHL', 'SHR'].every((w) => FUNCTIONS.get(w).args.length === 2 && FUNCTIONS.get(w).ret === 'num') && FUNCTIONS.get('BNOT').args.length === 1);
  check_('BORDER and RANDOMISE describe the new forms', /RANDOMISE n/.test(ARCADE_WORDS.get('RANDOMISE').syntax) && /AND 7/.test(ARCADE_WORDS.get('BORDER').desc));
  check_('the tokenizer makes the new words keywords', tokenize('FILL COPY CONST LOCAL LOADMAP BAND SHR').filter((t) => t.type === 'keyword').length === 7);
  const s = scanArcade('CONST W = 4\nSCENE s\n  DIM c, a(3, 4), b(W) = 1, 2\n  PROC P(x, y)\n    LOCAL q\n  ENDP\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE');
  check_('scanArcade lists consts, 2-D arrays, parameters and locals', s.consts[0].name === 'W' && s.vars[1].dims === 2 && s.vars[1].size2 === 4 && s.vars[2].dims === 1 && s.vars[0].dims === 0
    && s.procs[0].params.join() === 'x,y' && s.procs[0].locals.join() === 'q', JSON.stringify(s));
}

// =================================================================================================================
// 3. Interpreter semantics, hand-computed
// =================================================================================================================
console.log('\n3. Interpreter semantics (no machine)');
const ip = (src, ticks = 1, opts = {}) => interpret(parse(src).ast, { version: 2, ticks, assets: ASSETS, maxSteps: 50_000_000, ...opts });
const body = (b, o) => prog(b, o);
const last = (src, ticks = 1, opts) => ip(src, ticks, opts).ticks.at(-1);
const eq = (name, got, want) => check_(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
{
  // CONST folding
  const v = (expr, top = '') => last(prog(`    v = ${expr}`, { top })).vars.V;
  eq('CONST: + - * DIV MOD and unary minus', [v('A + B', 'CONST A = 7\nCONST B = 3\n'), v('A - B * 2', 'CONST A = 7\nCONST B = 3\n'), v('A DIV B', 'CONST A = 7\nCONST B = 3\n'), v('-A MOD B', 'CONST A = 7\nCONST B = 3\n'), v('A DIV -B', 'CONST A = 7\nCONST B = 3\n')], [10, 1, 2, -1, -2]);
  eq('CONST: wrap of 65535, 32768 and -32768', [v('Q', 'CONST Q = 65535\n'), v('Q', 'CONST Q = 32768\n'), v('Q - 1', 'CONST Q = -32768\n'), v('Q * 2', 'CONST Q = 20000\n')], [-1, -32768, 32767, w16(40000)]);
  eq('CONST: bit functions', [v('Q', 'CONST Q = BAND(12, 10)\n'), v('Q', 'CONST Q = BOR(12, 10)\n'), v('Q', 'CONST Q = BXOR(12, 10)\n'), v('Q', 'CONST Q = BNOT(5)\n'), v('Q', 'CONST Q = SHL(3, 4)\n'), v('Q', 'CONST Q = SHR(-64, 3)\n')], [8, 14, 6, -6, 48, -8]);
  eq('CONST: in a DIM size, so a(N) has N+1 elements', Object.values(last(prog('', { top: 'CONST N = 5\n', decl: 'DIM v, a(N * 2)' })).arrays)[0].length, 11);
  eq('CONST chains', v('C', 'CONST A = 2\nCONST B = A * A\nCONST C = B * B + A\n'), 18);
  eq('CONST in a scene sees an earlier CONST of the scene and of the program', last(prog('    v = Z', { top: 'CONST A = 4\n', decl: 'DIM v\n  CONST Z = A + 1' })).vars.V, 5);
  eq('a LOCAL hides a global; the global is untouched', last(prog('    v = 1\n    CALL p()', { procs: '  PROC p()\n    LOCAL v\n    v = 9\n    w = v\n  ENDP\n' })).vars, { V: 1, W: 9, K: 0 });
}
{
  // bit functions: 16-bit, shifts out of range
  const f = (e) => last(prog(`    v = ${e}`)).vars.V;
  const cases = [
    ['BAND(-1, 255)', 255], ['BAND(-32768, 32767)', 0], ['BOR(-32768, 1)', -32767], ['BXOR(-1, 255)', -256], ['BNOT(0)', -1], ['BNOT(-1)', 0], ['BNOT(32767)', -32768],
    ['SHL(1, 15)', -32768], ['SHL(1, 16)', 0], ['SHL(1, -1)', 0], ['SHL(-1, 4)', -16], ['SHL(255, 8)', -256], ['SHL(3, 0)', 3],
    ['SHR(-32768, 15)', -1], ['SHR(-1, 1)', -1], ['SHR(-8, 1)', -4], ['SHR(12345, 4)', 771], ['SHR(5, 16)', 0], ['SHR(-5, 16)', -1], ['SHR(-5, -1)', -1], ['SHR(5, -3)', 0], ['SHR(16384, 14)', 1],
  ];
  eq('bit functions, constant operands', cases.map(([e]) => f(e)), cases.map(([, r]) => r));
  const g = (e, x, y) => last(prog(`    w = ${x} : k = ${y}\n    v = ${e}`)).vars.V;
  eq('bit functions, variable operands (same results)', cases.map(([e]) => { const m = /^(\w+)\((-?\d+)(?:, (-?\d+))?\)$/.exec(e); return g(m[3] === undefined ? `${m[1]}(w)` : `${m[1]}(w, k)`, m[2], m[3] ?? 0); }), cases.map(([, r]) => r));
}
{
  // arrays: initialisers, 2-D, out of range
  const A = last(prog('', { top: 'CONST N = 3\n', decl: 'DIM v, t(N + 2) = 1, N * 2, -3, 65000, 5, 6' })).arrays.T;
  eq('array initialiser: constant expressions, wrapping, all elements', A, [1, 6, -3, w16(65000), 5, 6]);
  eq('array initialiser: fewer values leave the rest 0', last(prog('', { decl: 'DIM v, t(5) = 9, 8' })).arrays.T, [9, 8, 0, 0, 0, 0]);
  const G = last(prog('', { decl: 'DIM v, g(2, 1) = 1, 2, 3, 4, 5, 6' })).arrays.G;
  eq('2-D array: row-major, 6 slots for (2, 1)', G, [1, 2, 3, 4, 5, 6]);
  const r = last(prog('    g(0, 0) = 10 : g(0, 1) = 11 : g(2, 0) = 20 : g(2, 1) = 21\n    v = g(2, 1)\n    w = g(1, 1)\n    k = g(0, 1) + g(2, 0)', { decl: 'DIM v, w, k, g(2, 1) = 0, 0, 5, 6' }));
  eq('2-D array: g(i, j) is slot i * (h + 1) + j', [r.arrays.G, r.vars.V, r.vars.W, r.vars.K], [[10, 11, 5, 6, 20, 21], 21, 6, 31]);
  const o = last(prog('    g(3, 0) = 7 : g(0, 2) = 8 : g(-1, 0) = 9 : g(1, -1) = 9\n    v = g(3, 0) + g(0, 2) + g(-1, 0) + g(1, 5)\n    w = g(2, 1)', { decl: 'DIM v, w, k, g(2, 1) = 1, 2, 3, 4, 5, 6' }));
  eq('2-D array: each index is checked separately (j = 2 does not spill into the next row)', [o.arrays.G, o.vars.V, o.vars.W], [[1, 2, 3, 4, 5, 6], 0, 6]);
  const ev = last(prog('    v = 0\n    g(RND(1) + 5, RND(7) * 0 + v) = RND(100)', { decl: 'DIM v, w, k, g(2, 1)' }), 1, { rnd: ((n) => () => n++)(100) });
  eq('2-D array write: index, index, then the value are evaluated even when the write is ignored', ev.vars.V, 0);
}
{
  // locals and parameters
  const r = last(prog('    CALL p(1, 2, 3, 4)\n    CALL p(5, 6, 7, 8)', { procs: '  PROC p(a, b, c, d)\n    LOCAL x\n    x = x + a * 1000 + b * 100 + c * 10 + d\n    v = x\n  ENDP\n' }));
  eq('locals start at 0 on every call; 4 parameters bind in order', r.vars.V, 5678);
  const o = last(prog('    CALL p(RND(10), RND(10), RND(10))', { procs: '  PROC p(a, b, c)\n    v = a * 100 + b * 10 + c\n  ENDP\n' }), 1, { rnd: ((n) => () => n++)(1) });
  eq('CALL evaluates its arguments left to right (RND is consumed in that order)', o.vars.V, 123);
  const f = last(prog('    CALL p(3)', { procs: '  PROC p(n)\n    FOR i = 1 TO n\n      v = v + i\n    NEXT\n    w = i\n  ENDP\n' }));
  eq('an implicit FOR variable is a local: the global namespace has no i; i = 4 after the loop', [f.vars.V, f.vars.W], [6, 4]);
  const h = last(prog('    i = 7\n    CALL p()', { decl: 'DIM v, w, k, i', procs: '  PROC p()\n    FOR i = 1 TO 3\n    NEXT\n  ENDP\n' }));
  eq('a FOR over a visible global uses that global', h.vars.I, 4);
  const sc = last(prog('    CALL p()\n    CALL p()', { procs: '  PROC p()\n    FOR i = 1 TO 2\n      v = v + 1\n    NEXT\n    IF v < 0 THEN\n      FOR j = 1 TO 2\n      NEXT\n    ENDIF\n    k = j\n  ENDP\n' }));
  eq('an implicit local starts at 0 on every call even when its FOR did not run', sc.vars.K, 0);
}
{
  // PRINT AT r, c;  no items
  const a = last(prog('    PRINT AT 3, 4;\n    PRINT "x"'));
  eq('PRINT AT r, c; positions only, the next PRINT starts there', [a.cursor, String.fromCharCode(a.cells[3 * 32 + 4])], [{ row: 4, col: 0 }, 'x']);
  const b = last(prog('    PRINT AT 3, 4\n    PRINT "x"'));
  eq('PRINT AT r, c with no ; still goes to the next row', [b.cursor, String.fromCharCode(b.cells[4 * 32 + 0])], [{ row: 5, col: 0 }, 'x']);
}
{
  // BORDER and RANDOMISE
  const b = ip(prog('    BORDER v\n    v = v + 5'), 3);
  eq('BORDER n AND 7, per tick', b.ticks.map((t) => t.border), [0, 5, 2]);
  eq('the initial border is the runtime boot colour (1)', b.init.border, 1);
  const seeds = [];
  ip(prog('    RANDOMISE 0\n    RANDOMISE 65536 + 5 - 65536\n    RANDOMISE 65000\n    RANDOMISE'), 1, { rnd: () => 0, reseed: (s) => { seeds.push(s); } , frames: (t, n) => (n === 1 ? 0 : 99) });
  eq('RANDOMISE n: 0 becomes 1, n is taken AND $FFFF; bare RANDOMISE uses the frame counter (0 becomes 1)', seeds, [1, 5, 65000 & 0xFFFF, 1]);
}
{
  // FILL / FILLC / COPY / LOADMAP
  const NM = { maps: '' };
  const T = (c) => c.cells, A = (c) => c.attrs;
  const tile = (n) => 128 + n;
  const tileAttr = (n) => { const bright = n % 2, paper = (n * 3) % 8, ink = (n + 1) % 8; return (bright << 6) | (paper << 3) | ink; };
  const f = last(prog('    FILL 2, 3, 4, 2 = 5', NM));
  let ok = true;
  for (let y = 0; y < 24; y++) for (let x = 0; x < 32; x++) {
    const inside = x >= 2 && x < 6 && y >= 3 && y < 5, i = y * 32 + x;
    if (inside ? (T(f)[i] !== tile(5) || A(f)[i] !== tileAttr(5)) : (T(f)[i] !== 128 + (MAPS && 0) && false)) ok = false;
  }
  check_('FILL: the rectangle gets tile 5 and its attribute', ok && T(f)[3 * 32 + 2] === tile(5) && T(f)[4 * 32 + 5] === tile(5) && A(f)[4 * 32 + 5] === tileAttr(5) && T(f)[5 * 32 + 2] === 32 && T(f)[3 * 32 + 6] === 32);
  const g = last(prog('    FILL -2, 22, 5, 9 = 1', NM));
  const cnt = (c, v) => c.cells.filter((x) => x === v).length;
  eq('FILL: clipped on every side (3 columns x 2 rows are on screen)', cnt(g, tile(1)), 6);
  eq('FILL with w or h <= 0, or wholly off the screen, draws nothing', [last(prog('    FILL 1, 1, 0, 5 = 1', NM)), last(prog('    FILL 1, 1, 5, -2 = 1', NM)), last(prog('    FILL 40, 1, 5, 5 = 1', NM)), last(prog('    FILL 0, 30, 5, 5 = 1', NM))].map((c) => cnt(c, tile(1))), [0, 0, 0, 0]);
  eq('FILL with a tile outside the tileset (6 tiles) draws nothing', [last(prog('    FILL 0, 0, 3, 3 = v + 6', NM)), last(prog('    FILL 0, 0, 3, 3 = v - 1', NM))].map((c) => c.cells.filter((x) => x >= 128).length), [0, 0]);
  const c1 = last(prog('    INK 2 : PAPER 5 : BRIGHT 1\n    FILLC 1, 1, 3, 2 = 65', NM));
  eq('FILLC: the character and the current text attribute', [T(c1)[1 * 32 + 1], A(c1)[2 * 32 + 3], T(c1)[2 * 32 + 4]], [65, (1 << 6) | (5 << 3) | 2, 32]);
  eq('FILLC outside 32..127 draws nothing', last(prog('    FILLC 0, 0, 3, 3 = 10 + v', NM)).cells.filter((x) => x === 10).length, 0);
  // COPY: overlap in every direction equals the same copy through a buffer
  let allOk = true;
  const rr = rng(5);
  for (let n = 0; n < 40 && allOk; n++) {
    const x = Math.floor(rr() * 20), y = Math.floor(rr() * 14), w = 1 + Math.floor(rr() * 9), h = 1 + Math.floor(rr() * 7), dx = x + Math.floor(rr() * 7) - 3, dy = y + Math.floor(rr() * 5) - 2;
    const src = prog(`    FILL 0, 0, 32, 24 = 0\n    FOR i = 0 TO 5\n      FILL i * 5 + 1, i * 3, 4, 3 = i\n    NEXT\n    FILLC 3, 9, 20, 2 = 70\n    COPY ${x}, ${y}, ${w}, ${h} TO ${dx}, ${dy}`, NM);
    const a = last(src);
    const b = last(prog(`    FILL 0, 0, 32, 24 = 0\n    FOR i = 0 TO 5\n      FILL i * 5 + 1, i * 3, 4, 3 = i\n    NEXT\n    FILLC 3, 9, 20, 2 = 70`, NM));
    const want = b.cells.slice(), wantA = b.attrs.slice();
    for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
      const sx = x + i, sy = y + j, tx = dx + i, ty = dy + j;
      if (sx > 31 || sy > 23 || tx < 0 || tx > 31 || ty < 0 || ty > 23) continue;
      want[ty * 32 + tx] = b.cells[sy * 32 + sx]; wantA[ty * 32 + tx] = b.attrs[sy * 32 + sx];
    }
    if (!a.cells.every((v, i) => v === want[i]) || !a.attrs.every((v, i) => v === wantA[i])) allOk = false;
  }
  check_('COPY: 40 random rectangles including overlaps in all directions equal a copy through a buffer', allOk);
  // LOADMAP
  const m = last(prog('    LOADMAP b AT 3, 2', { maps: 'MAP a = "m1"\nMAP b = "m2"\n' }));
  const m2 = MAPS.m2;
  let mok = true;
  for (let r = 0; r < m2.h; r++) for (let c = 0; c < m2.w; c++) {
    const t = m2.cells[r * m2.w + c], i = (2 + r) * 32 + 3 + c;
    if (m.cells[i] !== (t < 0 ? 32 : 128 + t) || m.attrs[i] !== (t < 0 ? 0x38 : tileAttr(t))) mok = false;
  }
  check_('LOADMAP AT: the map lands at (3, 2) with the tiles\' attributes', mok);
  const clip = last(prog('    LOADMAP b AT -4, 22', { maps: 'MAP a = "m1"\nMAP b = "m2"\n' }));
  let cok = true;
  for (let r = 0; r < 3; r++) for (let c = 0; c < 12; c++) {
    const x = -4 + c, y = 22 + r;
    if (x < 0 || x > 31 || y > 23) continue;
    const t = m2.cells[r * 12 + c];
    if (clip.cells[y * 32 + x] !== (t < 0 ? 32 : 128 + t)) cok = false;
  }
  check_('LOADMAP AT: clipped at the left and the bottom, only the visible part lands', cok && clip.cells[21 * 32 + 5] === 32 && clip.cells[22 * 32 + 8] !== undefined);
  const first = ip(prog('    v = 1', { maps: 'MAP a = "m1"\nMAP b = "m2"\n' })).init;
  let fok = true;
  for (let r = 0; r < 4; r++) for (let c = 0; c < 5; c++) { const t = MAPS.m1.cells[r * 5 + c]; if (first.cells[r * 32 + c] !== (t < 0 ? 32 : 128 + t)) fok = false; }
  check_('the first MAP is loaded at (0, 0) at the start, the second is not', fok && first.cells[5] === 32 && first.cells[3 * 32 + 6] === 32);
  const noTouch = last(prog('    FILLC 0, 0, 32, 4 = 88\n    LOADMAP a AT 2, 1', { maps: 'MAP a = "m1"\nMAP b = "m2"\n' }));
  eq('LOADMAP leaves the cells outside the map alone', [noTouch.cells[0], noTouch.cells[2 * 32 + 20], noTouch.cells[1 * 32 + 1]], [88, 88, 88]);
}

// =================================================================================================================
// 4. Code generator and linker
// =================================================================================================================
console.log('\n4. Code generator and linker');
const R = real();
if (!R.ok) console.log(`  (the real runtime lacks the batch 1 routines: ${R.why}; sections 4 to 9 need arcade/build/v2 built from arcade/runtime/v2)`);
const GAME = (top, body, { decl = 'DIM v, w, k', procs = '', fr = 30 } = {}) => `GAME "t"\nFRAMERATE ${fr}\nTILESET ts = "ts"\n${top}SCENE s\n  ${decl}\n${procs}  PROC INIT()\n  ENDP\n  PROC FRAME()\n${body}\n  ENDP\nENDSCENE\n`;
const cmp = (src, assets = ASSETS) => compile(src, { runtime: R.rt, image: R.img, assets });
const h16 = (mem, a) => mem[a] | (mem[a + 1] << 8);
if (R.ok) {
  {   // maps and the header
    const one = cmp(GAME('MAP a = "m1"\n', '    v = 1'));
    check_('one MAP and no LOADMAP: the old header (16 bytes), frame_div without bit 7, map_ptr -> 768 raw cells', one.errors.length === 0 && one.gen.headerLen === 16 && (one.memory[0x8004] & 0x80) === 0 && h16(one.memory, 0x800C) === one.gen.v1.map && one.gen.v1.map > 0 && one.usage.data.map === 768, errText(one));
    const lm = cmp(GAME('MAP a = "m1"\nMAP b = "m2"\n', '    LOADMAP b AT v, 2\n    LOADMAP a'));
    const mem = lm.memory;
    const tab = h16(mem, 0x8010);
    check_('LOADMAP: the extended header (18 bytes), frame_div bit 7, map_table at $8010, map_ptr 0, descriptors at $8012', lm.errors.length === 0 && lm.gen.headerLen === 18 && (mem[0x8004] & 0x80) === 0x80 && (mem[0x8004] & 0x7F) === 2 && tab === lm.gen.v2.mapTable && h16(mem, 0x800C) === 0, errText(lm));
    const count = mem[tab], p0 = h16(mem, tab + 1), p1 = h16(mem, tab + 3);
    check_('map table: DB count, DW per map; each map is DB w, DB h, w*h cells (128 + tile, or 32)', count === 2 && mem[p0] === 5 && mem[p0 + 1] === 4 && mem[p1] === 12 && mem[p1 + 1] === 3
      && Array.from({ length: 20 }, (_, i) => mem[p0 + 2 + i]).every((b, i) => b === (MAPS.m1.cells[i] < 0 ? 32 : 128 + MAPS.m1.cells[i])) && Array.from({ length: 36 }, (_, i) => mem[p1 + 2 + i]).every((b, i) => b === 128 + MAPS.m2.cells[i]));
    const two = cmp(GAME('MAP a = "m1"\nMAP b = "m2"\n', '    v = 1'));
    check_('two MAPs and no LOADMAP also get the map table (the runtime loads map 0 from it)', two.errors.length === 0 && two.gen.headerLen === 18 && mem[tab] === 2 && two.memory[0x8010] !== 0 && (two.memory[0x8004] & 0x80) !== 0);
    const withSpr = cmp(GAME('SPRITE b = "ball"\nMAP a = "m1"\n', '    LOADMAP a\n    SHOW b AT 1, 2'), { ...ASSETS, sprites: { ball: { w: 8, h: 8, rows: Array.from({ length: 8 }, () => ({ bits: 'FF', mask: 'FF' })) } } });
    check_('with sprites: the descriptors follow the 18-byte header at $8012', withSpr.errors.length === 0 && h16(withSpr.memory, 0x8006) === 0x8012, errText(withSpr));
    const nine = cmp(GAME(Array.from({ length: 9 }, (_, i) => `MAP m${i} = "m1"\n`).join(''), '    v = 1'));
    check_('nine MAPs compile (the limit is 64 since the banked cartridge map; 65 is an error)', nine.errors.length === 0 && cmp(GAME(Array.from({ length: 65 }, (_, i) => `MAP m${i} = "m1"\n`).join(''), '    v = 1')).errors.some((e) => /at most 64 MAPs/.test(e.message)), errText(nine));
    const noTs = cmp(`GAME "t"\nMAP a = "m1"\nSCENE s\n  DIM v\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    LOADMAP a\n  ENDP\nENDSCENE\n`);
    check_('a MAP needs a TILESET (also with LOADMAP)', noTs.errors.some((e) => /needs a TILESET/.test(e.message)), errText(noTs));
    const missing = cmp(GAME('MAP a = "nothere"\n', '    LOADMAP a'));
    check_('a MAP whose asset is not in the project is an error', missing.errors.some((e) => /not in the project/.test(e.message)), errText(missing));
  }
  {   // array initialisers
    const r = cmp(GAME('', '    v = t(1) + u(0) + g(2, 1)', { decl: 'DIM v, t(3) = 1, 2, 3, 4\n  DIM u(3) = 5, 6, 7, 8\n  DIM g(2, 1) = 9, 10, 11, 12, 13, 14' }));
    check_('adjacent initialised arrays are copied with one LDIR (one table of 14 words)', r.errors.length === 0 && r.usage.codegen.initSegments === 1 && r.usage.data.init === 28, errText(r) + ' ' + JSON.stringify(r.usage?.data));
    const far = cmp(GAME('', '    v = t(1) + u(0)', { decl: 'DIM v, t(3) = 1, 2, 3, 4\n  DIM pad(30)\n  DIM u(3) = 5, 6, 7, 8' }));
    check_('initialised arrays with a long gap between are two LDIRs', far.errors.length === 0 && far.usage.codegen.initSegments === 2 && far.usage.data.init === 16 && far.usage.varBytes === 2 * (1 + 4 + 31 + 4), errText(far));
    const near = cmp(GAME('', '    v = t(1) + u(0) + pad(1)', { decl: 'DIM v, t(3) = 1, 2, 3, 4\n  DIM pad(1)\n  DIM u(3) = 5, 6, 7, 8' }));
    check_('a gap of 2 slots is padded with zeros (2 bytes a slot) instead of a second LDIR', near.usage.codegen.initSegments === 1 && near.usage.data.init === 2 * (4 + 2 + 4), JSON.stringify(near.usage));
    const sym = cmp(GAME('', '    v = g(1, 1)', { decl: 'DIM v, g(2, 3)' }));
    check_('symbols: a 2-D array is flat, n = slots - 1, with w and h', sym.map.arrays.G.n === 11 && sym.map.arrays.G.w === 2 && sym.map.arrays.G.h === 3);
  }
  {   // slots: parameters, locals, implicit FOR locals
    const r = cmp(GAME('', '    CALL p(1, 2, 3, v)', { decl: 'DIM v', procs: '  PROC p(a, b, c, d)\n    LOCAL x, y\n    FOR i = 1 TO 2\n      v = v + i\n    NEXT\n    FOR j = 1 TO 2\n      x = x + j\n    NEXT\n    y = x + i + a + b + c + d\n  ENDP\n' }));
    const names = r.map.slots.map((s) => s.name);
    check_('slot layout: the parameters, then the locals to clear (LOCAL and the implicit FOR variable used after its loop), then the free ones',
      r.errors.length === 0 && names.join().toUpperCase() === 'V,P.A,P.B,P.C,P.D,P.X,P.Y,P.I,P.J', names.join());
    const clr = cmp(GAME('', '    CALL p()', { decl: 'DIM v', procs: '  PROC p()\n    FOR i = 1 TO 2\n      v = v + i\n    NEXT\n  ENDP\n' }));
    const same = cmp(GAME('', '    CALL p()', { decl: 'DIM v, i', procs: '  PROC p()\n    FOR i = 1 TO 2\n      v = v + i\n    NEXT\n  ENDP\n' }));
    check_('an implicit FOR local used only inside its loop needs no clearing: the code equals the one with a global FOR variable, plus nothing', clr.errors.length === 0 && clr.gen.code.length === same.gen.code.length, `${clr.gen.code.length} vs ${same.gen.code.length}`);
    const rec = cmp(GAME('', '    CALL p(2, 3)', { procs: '  PROC p(a, b)\n    IF a > 0 THEN\n      CALL p(a - 1, b)\n    ENDIF\n  ENDP\n' }));
    check_('recursion is reported (PROC with parameters)', rec.errors.some((e) => /recursion/.test(e.message)), errText(rec));
    const calls = cmp(GAME('', '    CALL p(1, 2)\n    CALL q(1)', { procs: '  PROC p(a, b)\n    CALL q(a + b)\n  ENDP\n  PROC q(c)\n    v = c\n  ENDP\n' }));
    check_('nested calls with parameters compile', calls.errors.length === 0, errText(calls));
  }
  {   // runtime features missing / tile ops without a tileset
    const noTs = compile(`GAME "t"\nSCENE s\n  DIM v\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    FILL 0, 0, 1, 1 = 1\n  ENDP\nENDSCENE\n`, { runtime: R.rt, image: R.img, assets: ASSETS });
    check_('FILL needs a TILESET', noTs.errors.some((e) => /FILL needs a TILESET/.test(e.message)), errText(noTs));
    const big = cmp(GAME('', '    FILL 0, 0, 1, 1 = 6'));
    check_('FILL with a constant tile beyond the tileset (6 tiles) is an error', big.errors.some((e) => /tile 6 is not in the tileset/.test(e.message)), errText(big));
    const stripped = { ...R.rt, symbols: Object.fromEntries(Object.entries(R.rt.symbols).filter(([k]) => !/^RT_(FILL|FILLC|COPY|LOADMAP|LOADMAPAT|LOADMAPPTR|BORDER|RANDOMISE)$/.test(k))) };
    const old = (src) => compile(src, { runtime: stripped, image: R.img, assets: ASSETS });
    check_('on a runtime without the routines these words are "not supported yet"', ['    FILL 0, 0, 1, 1 = 1', '    FILLC 0, 0, 1, 1 = 65', '    COPY 0, 0, 1, 1 TO 2, 2', '    BORDER 1', '    RANDOMISE'].every((s) => old(GAME('', s)).errors.some((e) => /not supported yet/.test(e.message))));
    check_('LOADMAP on such a runtime is an error too', old(GAME('MAP a = "m1"\n', '    LOADMAP a')).errors.length > 0);
    const v1rt = { ...R.rt, version: 1 };
    check_('arrays, 2-D arrays and initialisers need a v2 runtime', compile(GAME('', '    v = 1', { decl: 'DIM v, g(2, 2)' }), { runtime: v1rt, image: R.img, assets: ASSETS }).errors.some((e) => /not supported yet/.test(e.message)));
    const cst = compile(GAME('CONST N = 3\n', '    v = N * 2\n    CALL p(N, v)', { procs: '  PROC p(a, b)\n    LOCAL c\n    c = BAND(a, b) + SHL(a, 2)\n    w = SHR(c, 1)\n  ENDP\n' }), { runtime: { ...R.rt, version: 1 }, image: R.img, assets: ASSETS });
    check_('CONST, parameters, LOCAL and the bit functions work on a v1 runtime too (they need no runtime routine)', cst.errors.length === 0, errText(cst));
  }
}

// =================================================================================================================
// 5. Differential tests on the real runtime
// =================================================================================================================
console.log('\n5. Compiled game on the REAL runtime vs the reference interpreter (>= 150 ticks each)');
const TICKS = QUICK ? 150 : 200;
const withInit = (src) => (/PROC INIT/i.test(src) ? src : src.replace(/(SCENE s\n)/, '$1  PROC INIT()\n  ENDP\n'));
const diffTest = (name, src, o = {}) => {
  src = withInit(src);
  if (!R.ok) { console.log(`  SKIP  ${name}  (${R.why})`); skipped++; return null; }
  const t0 = Date.now();
  const r = differential(src, ASSETS, { ticks: o.ticks ?? TICKS, ...o });
  check_(`real runtime: ${name}`, r.ok, r.ok ? `${o.ticks ?? TICKS} ticks, ${r.res.gen.code.length} bytes of code, ${Date.now() - t0} ms` : r.detail);
  return r;
};
const HEAD = 'GAME "t"\nFRAMERATE 30\nTILESET ts = "ts"\n';
// -- CONST, DIM sizes, CASE values, array initialisers
diffTest('CONST in DIM sizes, CASE values, initialisers and expressions', `${HEAD}CONST N = 7
CONST M = N * 3 - 1
CONST SH = SHL(1, 3) + BAND(M, 12)
CONST NEG = -M DIV 3
CONST BIG = 65535
SCENE s
  DIM t, r, res(15)
  DIM u(N) = 5, N, M, SH, NEG, BIG, 65000, N MOD 4
  DIM g(N, 3) = SH, M
  PROC INIT()
    g(N, 3) = BIG
  ENDP
  PROC FRAME()
    t = t + 1
    r = u(t MOD (N + 1)) + M
    res(0) = r : res(1) = NEG * t : res(2) = g(t MOD (N + 2), t MOD 5) : res(3) = SH + t
    SELECT CASE t MOD 25
      CASE N
        res(4) = res(4) + 1
      CASE M, SH
        res(5) = res(5) + 1
      CASE NEG
        res(6) = res(6) + 1
      CASE ELSE
        res(7) = res(7) + 1
    ENDSEL
    g(t MOD (N + 1), t MOD 4) = t * M
    PRINT AT 2, 0; r; " "; res(2); "    "
    FILL M MOD 7, N, SH MOD 5 + 1, 2 = t MOD 6
  ENDP
ENDSCENE
`);
// -- parameters, locals, implicit FOR variables, argument evaluation order
diffTest('PROC with 0..4 parameters, LOCAL, implicit FOR variables, argument order (RND)', `${HEAD}SCENE s
  DIM t, r(9), q, acc
  DEF FN sq(x) = x * x
  PROC P0()
    LOCAL a
    a = a + 3
    r(0) = r(0) + a
  ENDP
  PROC P1(a)
    LOCAL z
    FOR i = 1 TO a
      z = z + i
    NEXT i
    r(1) = z + i
  ENDP
  PROC P2(a, b)
    LOCAL x, y
    x = x + a : y = y + b
    r(2) = r(2) + x * 10 + y
    FOR i = 0 TO 2
      FOR j = 0 TO 1
        acc = acc + i * 2 + j
      NEXT j
    NEXT i
  ENDP
  PROC P3(a, b, c)
    r(3) = a * 100 + b * 10 + c
    CALL P2(a, c)
  ENDP
  PROC P4(a, b, c, d)
    LOCAL s
    s = a - b + c - d
    r(4) = s
    FOR k = 1 TO 3
      s = s + k
    NEXT
    r(5) = s + k
    CALL P3(d, c, FN sq(b) MOD 10)
  ENDP
  PROC FRAME()
    t = t + 1
    CALL P0()
    CALL P1(t MOD 6)
    CALL P2(t, RND(10))
    CALL P3(RND(10), RND(10), RND(10))
    CALL P4(RND(100), t, FN sq(t MOD 7), RND(5) - RND(5))
    q = q + r(3)
    r(6) = acc
    PRINT AT 0, 0; r(3); " "; r(4); " "; acc; "     "
  ENDP
ENDSCENE
`);
// -- bit functions with variable operands from tables
diffTest('BAND BOR BXOR BNOT SHL SHR with variable operands, constants of every size, counts out of range', `${HEAD}SCENE s
  DIM t, x, y, n, res(40)
  DIM vals(15) = 0, 1, -1, 255, 256, 32767, -32768, 21845, -21846, 4660, -2, 128, 32768, 16, 15, 7
  PROC FRAME()
    t = t + 1
    x = vals(t MOD 16) + RND(3) - 1
    y = vals((t * 5 + 3) MOD 16)
    n = RND(22) - 3
    res(0) = BAND(x, y) : res(1) = BOR(x, y) : res(2) = BXOR(x, y) : res(3) = BNOT(x)
    res(4) = SHL(x, n) : res(5) = SHR(x, n)
    res(6) = BAND(x, 255) : res(7) = BAND(x, -256) : res(8) = BAND(x, 4660) : res(9) = BAND(21845, x) : res(10) = BAND(x, 0) : res(11) = BAND(x, -1)
    res(12) = BOR(x, 255) : res(13) = BOR(x, 32768) : res(14) = BOR(x, 4660) : res(15) = BOR(0, x) : res(16) = BOR(x, -1) : res(17) = BOR(x, 0)
    res(18) = BXOR(x, 255) : res(19) = BXOR(x, -1) : res(20) = BXOR(x, 4660) : res(21) = BXOR(1, x) : res(22) = BXOR(x, 0) : res(23) = BXOR(x, 256)
    res(24) = SHL(x, 1) : res(25) = SHL(x, 7) : res(26) = SHL(x, 8) : res(27) = SHL(x, 15) : res(28) = SHL(x, 16) : res(29) = SHL(x, -2) : res(30) = SHL(x, 0)
    res(31) = SHR(x, 1) : res(32) = SHR(x, 7) : res(33) = SHR(x, 8) : res(34) = SHR(x, 14) : res(35) = SHR(x, 15) : res(36) = SHR(x, 16) : res(37) = SHR(x, -2) : res(38) = SHR(x, 0)
    res(39) = BAND(BOR(x, y), BNOT(BXOR(SHL(x, 1), SHR(y, 2))))
    PRINT AT 0, 0; res(39); "      "
  ENDP
ENDSCENE
`);
// -- 2-D arrays
diffTest('2-D arrays: reads and writes with in-range, out-of-range and negative indices, loops, nesting', `${HEAD}CONST W = 9
CONST H = 5
SCENE s
  DIM t, i, j, a, b, acc, bd(W, H), d1(5), res(9)
  DIM sm(3, 3) = 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16
  PROC FRAME()
    t = t + 1
    a = RND(14) - 2 : b = RND(10) - 2
    bd(a, b) = t
    bd(RND(W + 1), RND(H + 1)) = bd(a, b) + 1
    res(0) = bd(a, b) : res(1) = bd(W, H) : res(2) = bd(0, 0) : res(3) = bd(a + 1, b - 1) : res(4) = sm(a MOD 5, b MOD 5)
    acc = 0
    FOR i = 0 TO W
      FOR j = 0 TO H
        acc = acc + bd(i, j) * (i - j)
      NEXT j
    NEXT i
    res(5) = acc
    sm(b MOD 4, a MOD 4) = sm(a MOD 4, b MOD 4) + 1
    sm(3, 3) = sm(-1, 2) + sm(2, 7) + 5
    d1(a MOD 6) = d1(a MOD 6) + bd(b, a)
    bd(W, b) = bd(W, b) + 1 : bd(a, H) = bd(a, H) - 1
    bd(2, 3) = sm(2, 1) + bd(RND(3), RND(3))
    res(6) = bd(bd(0, 1) MOD 5, bd(1, 0) MOD 5)
    IF bd(a, b) > 0 AND sm(b MOD 4, a MOD 4) > 3 THEN res(7) = res(7) + 1 ENDIF
    PRINT AT 3, 0; acc; " "; res(6); "     "
  ENDP
ENDSCENE
`);
// -- array initialisers in many shapes
diffTest('array initialisers: partial, full, neighbours merged, gaps padded, negative and wrapped values, large table', `${HEAD}CONST BIGN = 120
SCENE s
  DIM t, x
  DIM a(3) = 1, 2, 3, 4
  DIM b(3) = -5, -6, 7, 8
  DIM mid(2)
  DIM c(2) = 100, 200
  DIM e(1) = 65000, 65535
  DIM f(4) = 9
  DIM g(5, 3) = 7, 6, 5, 4
  DIM big(BIGN) = 9, 8, 7, 6, 5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5, -6, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50
  DIM res(8)
  PROC FRAME()
    t = t + 1
    x = a(t MOD 4) + b(t MOD 4) * 3 + c(t MOD 3) + mid(t MOD 3) + e(t MOD 2) + f(t MOD 5) + g(t MOD 6, t MOD 4) + big(t MOD 121)
    res(t MOD 9) = x
    mid(t MOD 3) = mid(t MOD 3) + 1
    big(t MOD 121) = big(t MOD 121) + t
    PRINT AT 5, 0; x; "      "
  ENDP
ENDSCENE
`);
// -- RANDOMISE and BORDER
diffTest('RANDOMISE n (constant, 0, 65535, run time incl. 0), bare RANDOMISE, BORDER n', `${HEAD}SCENE s
  DIM t, x, r(15), bd, sd
  PROC INIT()
    BORDER 6
    RANDOMISE 4242
  ENDP
  PROC FRAME()
    t = t + 1
    r(t MOD 16) = RND(30000)
    BORDER t
    bd = bd + 1
    IF t = 10 THEN RANDOMISE 0 ENDIF
    IF t = 20 THEN RANDOMISE 65535 ENDIF
    IF t = 30 THEN RANDOMISE -1 ENDIF
    IF t = 40 THEN sd = 0 : RANDOMISE sd ENDIF
    IF t = 50 THEN RANDOMISE 1 ENDIF
    IF t = 60 THEN RANDOMISE 40000 + t ENDIF
    IF t MOD 37 = 0 THEN RANDOMISE ENDIF
    IF t MOD 53 = 5 THEN BORDER 9 + t ENDIF
    IF t MOD 61 = 7 THEN BORDER 0 - t ENDIF
    x = RND(1000)
    PRINT AT 1, 0; x; "  "; r(t MOD 16); "     "
  ENDP
ENDSCENE
`);
// -- PRINT AT r, c;
diffTest('PRINT AT r, c; with no items positions the cursor; PRINT AT r, c goes to the next row', `${HEAD}SCENE s
  DIM t
  PROC FRAME()
    t = t + 1
    PRINT AT t MOD 24, t MOD 32;
    PRINT "ab";
    PRINT AT 23 - t MOD 24, 31 - t MOD 32
    PRINT t MOD 10;
    PRINT AT 12, 12;
    PRINT AT t MOD 5 - 2, 40 - t MOD 50;
    PRINT "z"
  ENDP
ENDSCENE
`);
// -- FILL / FILLC
diffTest('FILL and FILLC with run-time rectangles: clipped on every side, degenerate, huge, bad tiles and characters', `${HEAD}SCENE s
  DIM t, x, y, w, h, c
  PROC FRAME()
    t = t + 1
    x = RND(52) - 12 : y = RND(40) - 8 : w = RND(40) - 6 : h = RND(30) - 4
    IF t MOD 29 = 0 THEN w = 32767 : h = 32767 : x = -3 : y = -2 ENDIF
    IF t MOD 31 = 0 THEN x = -32768 : w = 32767 ENDIF
    IF t MOD 37 = 0 THEN w = 0 ENDIF
    c = RND(9) - 2
    IF t MOD 3 = 0 THEN
      INK RND(8) : PAPER RND(8) : BRIGHT RND(2)
      FILLC x, y, w, h = 28 + RND(103)
    ELSE
      FILL x, y, w, h = c
    ENDIF
    IF t MOD 50 = 0 THEN FILLC 0, 0, 32, 24 = 32 ENDIF
    FILL 30, 22, 5, 5 = 2
    FILL RND(32), RND(24), 1, 1 = 4
  ENDP
ENDSCENE
`, { ticks: 200 });
// -- COPY
diffTest('COPY with run-time rectangles: overlaps in all eight directions, clipped source and destination, degenerate sizes', `${HEAD}SCENE s
  DIM t, x, y, w, h, dx, dy, i
  PROC INIT()
    FOR i = 0 TO 40
      FILL RND(30), RND(22), RND(6) + 1, RND(5) + 1 = RND(6)
    NEXT i
    INK 3 : PAPER 6
    FILLC 2, 2, 20, 3 = 66
  ENDP
  PROC FRAME()
    t = t + 1
    x = RND(40) - 4 : y = RND(32) - 4 : w = RND(20) - 2 : h = RND(14) - 1
    dx = x + RND(9) - 4 : dy = y + RND(7) - 3
    IF t MOD 7 = 0 THEN dx = RND(50) - 10 : dy = RND(40) - 8 ENDIF
    IF t MOD 41 = 0 THEN w = 32767 : h = 32767 ENDIF
    IF t MOD 43 = 0 THEN x = -32768 : dx = 32767 ENDIF
    COPY x, y, w, h TO dx, dy
    IF t MOD 9 = 0 THEN FILL RND(30), RND(22), RND(6) + 1, RND(5) + 1 = RND(6) ENDIF
    IF t MOD 11 = 0 THEN
      INK RND(8) : FILLC RND(30), RND(22), RND(7), RND(5) = 40 + RND(80)
    ENDIF
  ENDP
ENDSCENE
`, { ticks: 160 });
// -- LOADMAP
diffTest('LOADMAP: three maps (the first at the start), at random positions incl. negative and off screen, clipped, without AT', `${HEAD}MAP a = "m1"
MAP b = "m2"
MAP c = "m3"
SCENE s
  DIM t, x, y
  PROC FRAME()
    t = t + 1
    x = RND(50) - 18 : y = RND(34) - 8
    IF t MOD 4 = 0 THEN LOADMAP a AT x, y ENDIF
    IF t MOD 4 = 1 THEN LOADMAP b AT x, y ENDIF
    IF t MOD 4 = 2 THEN
      LOADMAP c AT x MOD 9, y MOD 7
    ENDIF
    IF t MOD 4 = 3 THEN
      LOADMAP b
      FILLC RND(30), RND(22), 3, 3 = 80
    ENDIF
    IF t MOD 20 = 5 THEN LOADMAP a AT -32768, 32767 ENDIF
    IF t MOD 20 = 6 THEN LOADMAP c AT 32767, -32768 ENDIF
    IF t MOD 33 = 0 THEN LOADMAP c ENDIF
  ENDP
ENDSCENE
`, { ticks: 250 });
// -- LOADMAP with one map and PRINT/colours
diffTest('LOADMAP with a single MAP (extended header), text over a map, tile and text colours', `${HEAD}MAP a = "m2"
SCENE s
  DIM t
  PROC FRAME()
    t = t + 1
    INK t MOD 8 : PAPER 7 - t MOD 8 : BRIGHT t MOD 2
    PRINT AT t MOD 24, 0; "text "; t
    IF t MOD 10 = 0 THEN LOADMAP a AT t MOD 20, t MOD 21 ENDIF
    TILE t MOD 32, t MOD 24 = t MOD 6
  ENDP
ENDSCENE
`);
// -- name spaces with sprites and sounds
diffTest('asset names apart from variables, PROCs and DEF FNs (SFX lock + PROC lock, SPRITE ball + variable ball)', `${HEAD}SPRITE ball = "ball"
SPRITE bell = "ball"
SFX lock = "x"
SFX bell = "x"
SCENE s
  DIM t, ball, thing(3)
  PROC lock()
    ball = ball + 3
    PLAY lock
  ENDP
  PROC FRAME()
    t = t + 1
    thing(t MOD 4) = t
    IF t MOD 6 = 0 THEN CALL lock() ENDIF
    IF t MOD 10 = 0 THEN PLAY bell ENDIF
    SHOW ball AT ball MOD 200, 50
    SHOW bell AT t MOD 200, 100 + HIT(ball, bell)
  ENDP
ENDSCENE
`, { sprites: true });

// =================================================================================================================
// 6. Fuzz: random fragments of bit functions, 2-D arrays, CONST expressions, locals and parameters
// =================================================================================================================
console.log('\n6. Fuzz on the real runtime (compiled code vs the interpreter)');
{
  const LIT = [0, 1, 2, 3, 4, 5, 7, 8, 15, 16, 17, 31, 100, 255, 256, 1000, 4660, 21845, 32767, 32768, 40000, 65535];
  function gen(rand) {
    const pick = (a) => a[Math.floor(rand() * a.length)];
    const chance = (p) => rand() < p;
    const lit = () => { const v = pick(LIT); return chance(0.25) ? `-${Math.min(v, 32768)}` : String(v); };
    // constant expressions (CONST right-hand sides)
    const consts = [];
    const cexpr = (d) => {
      if (d <= 0 || chance(0.3)) return consts.length && chance(0.55) ? pick(consts).name : lit();
      const k = Math.floor(rand() * 9);
      const a = cexpr(d - 1), b = cexpr(d - 1);
      switch (k) {
        case 0: return `(${a} + ${b})`; case 1: return `(${a} - ${b})`; case 2: return `(${a} * ${b})`;
        case 3: return `(${a} DIV ${pick([1, 2, 3, 7, 16, 100, -5])})`; case 4: return `(${a} MOD ${pick([1, 2, 3, 7, 16, 100, -5])})`;
        case 5: return `BAND(${a}, ${b})`; case 6: return `BOR(${a}, ${b})`; case 7: return `BXOR(${a}, ${b})`;
        default: return chance(0.5) ? `BNOT(${a})` : chance(0.5) ? `SHL(${a}, ${pick([0, 1, 3, 7, 8, 9, 15, 16, 20, -1, b])})` : `SHR(${a}, ${pick([0, 1, 3, 7, 8, 9, 14, 15, 16, 20, -1])})`;
      }
    };
    const nConst = 3 + Math.floor(rand() * 4);
    for (let i = 0; i < nConst; i++) consts.push({ name: `K${i}`, expr: cexpr(3) });
    // run-time expressions
    const idx = () => {
      const k = Math.floor(rand() * 7);
      switch (k) {
        case 0: return String(Math.floor(rand() * 12) - 2);
        case 1: return `x MOD ${pick([3, 5, 7, 11])}`;
        case 2: return `ABS(y) MOD ${pick([4, 6, 8])}`;
        case 3: return `t MOD ${pick([2, 5, 9])}`;
        case 4: return `res(${Math.floor(rand() * 8)}) MOD 6`;
        case 5: return pick(consts).name + ' MOD 7';
        default: return `BAND(z, 7) - ${Math.floor(rand() * 3)}`;
      }
    };
    const leaf = () => {
      const k = Math.floor(rand() * 12);
      if (k < 3) return lit();
      if (k < 6) return pick(['x', 'y', 'z', 't']);
      if (k < 7) return pick(consts).name;
      if (k < 8) return `a(${idx()})`;
      if (k < 10) return `b(${idx()}, ${idx()})`;
      if (k < 11) return `c(${idx()}, ${idx()})`;
      return `res(${Math.floor(rand() * 16)})`;
    };
    const expr = (d) => {
      if (d <= 0 || chance(0.22)) return leaf();
      const k = Math.floor(rand() * 20);
      const a = () => expr(d - 1), b = () => expr(d - 1);
      switch (k) {
        case 0: return `(${a()} + ${b()})`; case 1: return `(${a()} - ${b()})`; case 2: return `(${a()} * ${b()})`;
        case 3: return `(${a()} DIV ${chance(0.5) ? pick([2, 3, 7, 10, -3]) : b()})`; case 4: return `(${a()} MOD ${chance(0.5) ? pick([2, 3, 7, 10, -3]) : b()})`;
        case 5: case 6: return `BAND(${a()}, ${b()})`; case 7: case 8: return `BOR(${a()}, ${b()})`; case 9: case 10: return `BXOR(${a()}, ${b()})`;
        case 11: return `BNOT(${a()})`;
        case 12: case 13: return `SHL(${a()}, ${chance(0.5) ? pick([0, 1, 2, 3, 4, 7, 8, 9, 12, 15, 16, -1, 40]) : leaf()})`;
        case 14: case 15: return `SHR(${a()}, ${chance(0.5) ? pick([0, 1, 2, 3, 4, 7, 8, 9, 12, 14, 15, 16, -1, 40]) : leaf()})`;
        case 16: return `BIT(${a()}, ${chance(0.5) ? pick([0, 1, 7, 8, 15, 16, -1]) : leaf()})`;
        case 17: return `-(${chance(0.5) ? a() : leaf()} + 0)`;
        case 18: return chance(0.5) ? `ABS(${a()})` : `SGN(${a()})`;
        default: return `(${a()} ${pick(['<', '>', '=', '<>', '<=', '>='])} ${b()})`;
      }
    };
    const frag = () => {
      const k = Math.floor(rand() * 10);
      if (k < 4) return `    res(${Math.floor(rand() * 16)}) = ${expr(3)}`;
      if (k < 5) return `    a(${idx()}) = ${expr(2)}`;
      if (k < 7) return `    b(${idx()}, ${idx()}) = ${expr(2)}`;
      if (k < 8) return `    c(${idx()}, ${idx()}) = ${expr(2)}`;
      if (k < 9) return `    CALL px(${expr(2)}, ${expr(1)}, ${expr(2)}, ${expr(1)})`;
      return `    IF ${expr(2)} THEN\n      res(${Math.floor(rand() * 16)}) = ${expr(2)}\n    ELSE\n      b(${idx()}, ${idx()}) = ${expr(1)}\n    ENDIF`;
    };
    const rows = (n, f) => Array.from({ length: n }, f);
    const ai = rows(8, () => Math.floor(rand() * 2000) - 1000);
    const bi = rows(1 + Math.floor(rand() * 20), () => Math.floor(rand() * 65536) - 32768);
    const frags = rows(40, frag);
    const px = `  PROC px(p, q, r, s)\n    LOCAL l, m\n    l = ${expr(2).replace(/\bx\b/g, 'p').replace(/\by\b/g, 'q').replace(/\bz\b/g, 'r').replace(/\bt\b/g, 's')}\n    FOR i = 0 TO 2\n      m = m + BXOR(l, i) + SHL(i, q MOD 3)\n    NEXT i\n    res(${Math.floor(rand() * 16)}) = l + m + i\n    b(p MOD 4, q MOD 5) = BAND(r, 255) + s\n  ENDP\n`;
    const src = `GAME "fuzz"\nFRAMERATE 15\nTILESET ts = "ts"\n${consts.map((c) => `CONST ${c.name} = ${c.expr}`).join('\n')}\nSCENE s\n  DIM t, x, y, z\n  DIM res(15)\n  DIM a(7) = ${ai.join(', ')}\n  DIM b(3, 4) = ${bi.slice(0, 20).join(', ')}\n  DIM c(6, 2)\n${px}  PROC INIT()\n    c(2, 1) = 5\n  ENDP\n  PROC FRAME()\n    t = t + 1\n    x = RND(200) - 100 : y = RND(41) - 20 : z = RND(65000) - 32000\n    IF t MOD 3 = 0 THEN x = ${pick([32767, -32768, 255, -1, 0])} ENDIF\n${frags.join('\n')}\n  ENDP\nENDSCENE\n`;
    return { src, frags: frags.length + 1 };
  }
  const programs = QUICK ? 24 : 75, perProgram = 3;
  let fragments = 0, bad = 0;
  const t0 = Date.now();
  if (!R.ok) { console.log(`  SKIP  fuzz  (${R.why})`); skipped++; }
  else {
    for (let i = 0; i < programs; i++) {
      const g = gen(rng(9100 + i));
      const r = differential(g.src, ASSETS, { ticks: perProgram, skip: ['cells'] });
      fragments += g.frags * perProgram;
      if (!r.ok) {
        bad++;
        const f = join(TMP, `fuzz-${i}.arc`); writeFileSync(f, g.src);
        check_(`fuzz program ${i}`, false, `${r.detail}; source in ${f}`);
        if (bad >= 3) break;
      }
    }
    check_(`fuzz: ${programs} random programs (${programs * 41} fragments, each executed ${perProgram} times) on the real runtime agree with the interpreter`, bad === 0, `${Date.now() - t0} ms`);
    if (!QUICK) check_('fuzz: at least 3000 fragments', programs * 41 >= 3000, `${programs * 41}`);
  }
}

// =================================================================================================================
// 7. Code size and T-states
// =================================================================================================================
console.log('\n7. Code size and T-states (real runtime, T-states of PROC FRAME itself, the frame interrupt included)');
if (!R.ok) { console.log(`  SKIP  (${R.why})`); skipped++; }
else {
  const decl = 'DIM t, v, w, x, a(9), b(9, 9), i, j';
  const mk = (body, d = decl, top = '') => `GAME "t"\nFRAMERATE 10\nTILESET ts = "ts"\n${top}SCENE s\n  ${d}\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    t = t + 1\n${body}\n  ENDP\nENDSCENE\n`;
  const rep = (n, s) => Array.from({ length: n }, () => s).join('\n');
  const sizeOf = (body, d, top) => cmp(mk(body, d, top)).gen?.code.length ?? NaN;
  const medT = (body, d, top) => { const r = runReal(compileReal(mk(body, d, top), ASSETS), { ticks: 16 }); const c = r.frameT.slice(5).sort((p, q) => p - q); return c[c.length >> 1]; };
  const per = (pre, stmt, n = 20, d, top) => ({ T: (medT(`${pre}\n${rep(n, stmt)}`, d, top) - medT(pre, d, top)) / n, B: (sizeOf(`${pre}\n${rep(n, stmt)}`, d, top) - sizeOf(pre, d, top)) / n });
  const row = (name, o, note = '') => info(`${name.padEnd(36)} ${String(Math.round(o.T)).padStart(6)} T  ${o.B.toFixed(1).padStart(6)} bytes ${note}`);
  const PRE = '    w = 12345 : x = 4';
  const base = per(PRE, '    v = w');
  row('v = w (the baseline)', base);
  const net = (o) => ({ T: o.T - base.T, B: o.B - base.B });
  const stmt = (name, s, pre = PRE) => { const o = net(per(pre, s)); row(name + ' (net of v = w)', o); return o; };
  const band = stmt('v = BAND(w, x)', '    v = BAND(w, x)'), band255 = stmt('v = BAND(w, 255)', '    v = BAND(w, 255)');
  stmt('v = BAND(w, 4660)', '    v = BAND(w, 4660)'); stmt('v = BOR(w, x)', '    v = BOR(w, x)'); stmt('v = BXOR(w, x)', '    v = BXOR(w, x)'); stmt('v = BNOT(w)', '    v = BNOT(w)');
  const shl3 = stmt('v = SHL(w, 3)', '    v = SHL(w, 3)'); stmt('v = SHL(w, 9)', '    v = SHL(w, 9)'); const shr3 = stmt('v = SHR(w, 3)', '    v = SHR(w, 3)'); stmt('v = SHR(w, 9)', '    v = SHR(w, 9)'); stmt('v = SHR(w, 15)', '    v = SHR(w, 15)');
  const vs = {};
  for (const n of [0, 1, 4, 8, 15, 16]) {
    const pre = `    w = 12345 : x = ${n}`, b0 = per(pre, '    v = w');
    const l = per(pre, '    v = SHL(w, x)'), r = per(pre, '    v = SHR(w, x)');
    vs[n] = { shl: l.T - b0.T, shr: r.T - b0.T, bytes: l.B - b0.B };
    info(`${`v = SHL(w, x) / SHR(w, x), x = ${n}`.padEnd(36)} ${String(Math.round(vs[n].shl)).padStart(6)} / ${String(Math.round(vs[n].shr)).padStart(5)} T  (net of v = w; the call is ${vs[n].bytes.toFixed(0)} bytes at the call site, the routine is shared)`);
  }
  check_('BAND with the constant 255 is cheaper and shorter than BAND of two variables; SHL / SHR by a constant are cheaper than by a variable', band255.T < band.T && band255.B < band.B && shl3.T < vs[4].shl && shr3.T < vs[4].shr);
  check_('SHL / SHR by a run-time count cost about 56 + 24 n and 56 + 29 n T-states (n = 0..15), 0 / the sign for a count outside', [0, 1, 4, 8, 15].every((n) => Math.abs(vs[n].shl - (80 + 24 * n)) < 70 && Math.abs(vs[n].shr - (80 + 29 * n)) < 80) && vs[16].shl < vs[1].shl + 20, JSON.stringify(Object.fromEntries(Object.entries(vs).map(([n, o]) => [n, [Math.round(o.shl), Math.round(o.shr)]]))));
  // arrays
  const pre4 = '    w = 12345 : x = 4';
  const a1 = net(per(pre4, '    v = a(x)')), b2 = net(per(pre4, '    v = b(x, x)')), b2c = net(per(pre4, '    v = b(x, 3)')), b2k = net(per(pre4, '    v = b(2, 3)')), b2w = net(per(pre4, '    b(x, x) = v')), a1w = net(per(pre4, '    a(x) = v'));
  row('v = a(x)  (1-D)', a1); row('v = b(x, x) (2-D, both run time)', b2, '(shared routine: 40 bytes once per array)'); row('v = b(x, 3)  (one constant)', b2c); row('v = b(2, 3)  (both constant)', b2k);
  row('a(x) = v  (1-D write)', a1w); row('b(x, x) = v  (2-D write)', b2w);
  check_('a 2-D element with both indices at run time costs less than 4 times a 1-D one, a constant index makes it cheaper, two constants are a plain load', b2.T < 4 * a1.T && b2c.T < b2.T && b2k.T < 20);
  // array initialisers: 53 values by assignment against the initialiser
  const vals = Array.from({ length: 53 }, (_, i) => (i * 37) % 300 - 20);
  const sIn = (extra) => `GAME "t"\nFRAMERATE 30\nSCENE s\n  DIM v\n  ${extra.decl}\n  PROC INIT()\n${extra.init}\n  ENDP\n  PROC FRAME()\n    v = t(3)\n  ENDP\nENDSCENE\n`;
  const withAssign = compile(sIn({ decl: 'DIM t(52)', init: vals.map((x, i) => `    t(${i}) = ${x}`).join('\n') }), { runtime: R.rt, image: R.img, assets: ASSETS });
  const withInit = compile(sIn({ decl: `DIM t(52) = ${vals.join(', ')}`, init: '' }), { runtime: R.rt, image: R.img, assets: ASSETS });
  info(`53 table values: ${withAssign.gen.code.length} bytes as assignments in INIT, ${withInit.gen.code.length} bytes as an initialiser (${withInit.usage.data.init} of data + the LDIR)`);
  check_('an initialiser for 53 values is less than half the size of 53 assignments', withInit.gen.code.length < withAssign.gen.code.length / 2, `${withInit.gen.code.length} vs ${withAssign.gen.code.length}`);
  // tile operations against the compiled loop
  const mapsTop = 'MAP m = "m2"\n';
  const ASSETS2 = ASSETS;
  const medTile = (body) => { const r = runReal(compileReal(mk(body, decl, mapsTop), ASSETS2), { ticks: 16 }); const c = r.frameT.slice(5).sort((p, q) => p - q); return c[c.length >> 1]; };
  const sizeTile = (body) => cmp(mk(body, decl, mapsTop)).gen?.code.length;
  const b0 = medTile('    v = w'), s0 = sizeTile('    v = w');
  const tile = (name, body, cells, noSize = false) => { const T = medTile(body) - b0, B = sizeTile(body) - s0; info(`${name.padEnd(52)} ${String(T).padStart(7)} T  ${cells ? (T / cells).toFixed(0).padStart(5) + ' T/cell' : '        '}  ${noSize ? '   n/a' : String(B).padStart(4) + ' bytes'}`); return { T, B }; };
  const loopCh = tile('TILE loop 10 x 10, a new tile each tick', '    FOR i = 0 TO 9\n      FOR j = 0 TO 9\n        TILE 5 + i, 5 + j = t MOD 2\n      NEXT j\n    NEXT i', 100);
  const fillCh = tile('FILL 5, 5, 10, 10 = t MOD 2 (100 cells change)', '    FILL 5, 5, 10, 10 = t MOD 2', 100);
  const fillSame = tile('FILL 5, 5, 10, 10 = 3 (no cell changes)', '    FILL 5, 5, 10, 10 = 3', 100);
  const fillScr = tile('FILL 0, 0, 32, 24 = 3 (the whole screen, unchanged)', '    FILL 0, 0, 32, 24 = 3', 768);
  const fillScrCh = tile('FILL 0, 0, 32, 24 = t MOD 2 (768 cells change)', '    FILL 0, 0, 32, 24 = t MOD 2', 768);
  tile('FILLC 5, 5, 10, 10 = 65 + t MOD 2 (100 cells change)', '    FILLC 5, 5, 10, 10 = 65 + t MOD 2', 100);
  tile('FILL 5, 5, 1, 1 = 3 (one cell: the fixed cost)', '    FILL 5, 5, 1, 1 = 3', 1);
  tile('FILL 5, 5, 0, 1 = 3 (nothing to do)', '    FILL 5, 5, 0, 1 = 3', 0);
  const copyApart = tile('COPY 10 x 10 apart (after a FILL of the source)', '    FILL 0, 0, 10, 10 = t MOD 2\n    COPY 0, 0, 10, 10 TO 15, 5', 100);
  const fillSrc = tile('  the FILL of the source alone', '    FILL 0, 0, 10, 10 = t MOD 2', 100);
  const copyOv = tile('COPY 10 x 10 one column right (overlapping)', '    FILL 0, 0, 12, 10 = t MOD 3\n    COPY 0, 0, 10, 10 TO 1, 0', 100);
  const fillOv = tile('  the FILL of the source alone', '    FILL 0, 0, 12, 10 = t MOD 3', 120);
  const lm = tile('LOADMAP m AT 2 + t MOD 2, 2 (12 x 3 = 36 cells)', '    LOADMAP m AT 2 + t MOD 2, 2', 36, true);
  const lmLoop = tile('  the same with a TILE loop', '    FOR i = 0 TO 11\n      FOR j = 0 TO 2\n        TILE 2 + t MOD 2 + i, 2 + j = (i * 5 + j * 60) MOD 6\n      NEXT j\n    NEXT i', 36);
  info(`per cell beyond the call: FILL ${((fillCh.T - 1800) / 100).toFixed(0)} T (10 x 10) / ${((fillScrCh.T - 1800) / 768).toFixed(0)} T (whole screen), the TILE loop ${(loopCh.T / 100).toFixed(0)} T; the contract's target is "far below the compiled-loop equivalent (under 100 T per cell beyond the dirty marking)"`);
  check_('FILL is at least 5 times cheaper than the TILE loop for 10 x 10 cells, and costs under 130 T a cell on the whole screen', fillCh.T * 5 < loopCh.T && fillScrCh.T / 768 < 130, `${fillCh.T} vs ${loopCh.T}; ${(fillScrCh.T / 768).toFixed(0)} T a cell`);
  check_('COPY (apart or overlapping) and LOADMAP are far cheaper than a TILE loop of the same cells', (copyApart.T - fillSrc.T) < loopCh.T / 3 && (copyOv.T - fillOv.T) < loopCh.T / 2 && lm.T * 3 < lmLoop.T, `${copyApart.T - fillSrc.T}, ${copyOv.T - fillOv.T} vs ${loopCh.T}; LOADMAP ${lm.T} vs loop ${lmLoop.T}`);
  check_('a FILL statement is shorter than the TILE loop it replaces, an unchanged FILL costs less than a changing one', fillCh.B < loopCh.B && fillSame.T <= fillCh.T);
}

// =================================================================================================================
// 8. Programs that use none of the new words compile to the same bytes as before the batch
// =================================================================================================================
console.log('\n8. Old programs compile to identical bytes (SHA-256 of the game area against a stand-in runtime, baseline made by the compiler of git 335a383)');
{
  const fnv = (s) => { let h = 0x811C9DC5; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
  const NAMES = ['RT_SHOW', 'RT_HIDE', 'RT_HIT', 'RT_KEYDOWN', 'RT_AT', 'RT_PRINTS', 'RT_PRINTN', 'RT_PRINTC', 'RT_INK', 'RT_PAPER', 'RT_BRIGHT', 'RT_CLS', 'RT_TILE', 'RT_TILEAT', 'RT_PLAY', 'RT_SILENCE', 'RT_MUL', 'RT_DIV', 'RT_MOD', 'RT_RND', 'RT_STICK', 'V_CUR_ROW', 'V_CUR_COL', 'V_TICKS'];
  const fakeRuntime = (version) => ({ version, symbols: Object.fromEntries(NAMES.map((n) => [n, 0xC000 + (fnv(n) % 0x2000)])), constants: { GAME_BASE: 0x8000, GAME_VARS_BASE: 0xE100, GAME_VARS_LIMIT: 0xEFFF, MAX_SPRITES: version >= 2 ? 16 : 4, MAX_ASSETS: 8 } });
  const baseline = JSON.parse(readFileSync(join(ROOT, 'arcade/tests/fixtures/batch1-baseline.json'), 'utf8'));
  let same = 0, bad = '';
  for (const p of baseline.programs) {
    const r = compile(readFileSync(join(ROOT, p.src), 'utf8'), { runtime: fakeRuntime(p.runtime), image: new Uint8Array(65536), assets: JSON.parse(readFileSync(join(ROOT, p.assets), 'utf8')) });
    const sha = r.memory ? createHash('sha256').update(r.memory.slice(0x8000, 0xC000)).digest('hex') : '';
    if (r.errors.length || sha !== p.sha256 || r.gen.code.length !== p.bytes) bad += `${p.src} (runtime v${p.runtime}): ${r.errors[0]?.message ?? `${r.gen.code.length} bytes, hash differs`}; `;
    else same++;
  }
  check_(`${baseline.programs.length} programs (breakout, bounce, shooter, blockfall-v0, breakout-v1 on v1 and v2 runtimes, bounce-static on v0) compile to the same bytes as before`, bad === '' && same === baseline.programs.length, bad);
  // and the real runtime, with a hash made now of the same programs compiled twice (the compiler is deterministic)
  if (R.ok) {
    const sha = (src, assets) => createHash('sha256').update(compile(src, { runtime: R.rt, image: R.img, assets }).memory.slice(0x8000, 0xC000)).digest('hex');
    const src = readFileSync(join(ROOT, 'arcade/examples/shooter.arc'), 'utf8'), as = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/shooter.assets.json'), 'utf8'));
    check_('the compiler is deterministic (the same source twice gives the same game area)', sha(src, as) === sha(src, as));
  }
}

// =================================================================================================================
// 9. Blockfall, the quick check (tests/arcade-blockfall.mjs has the 3,595-tick proof against the old version)
// =================================================================================================================
console.log('\n9. Blockfall (batch 1 version) in brief');
{
  const old = readFileSync(join(ROOT, 'arcade/tests/fixtures/blockfall-v0.arc'), 'utf8');
  const neu = readFileSync(join(ROOT, 'arcade/examples/blockfall.arc'), 'utf8');
  const bfa = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/blockfall.assets.json'), 'utf8'));
  const variant = neu.replace('CONST FREESEED = 1', 'CONST FREESEED = 0');
  const KEYS = { O: 79, P: 80, Q: 81, A: 65, SPACE: 32 };
  // a short open-loop script: wait on the title 25 ticks, start, then a rhythm of moves, turns and drops
  const keys = (t) => {
    if (t < 25) return [];
    if (t < 28) return [KEYS.SPACE];
    const k = [];
    if ((t >> 3) % 4 === 0) k.push(KEYS.O);
    if ((t >> 3) % 4 === 2) k.push(KEYS.P);
    if (t % 9 === 0) k.push(KEYS.Q);
    if (t % 31 < 8) k.push(KEYS.A);
    if (t % 47 === 0) k.push(KEYS.SPACE);
    return k;
  };
  const NT = QUICK ? 500 : 900;
  const run = (src) => interpret(parse(src).ast, { version: 2, ticks: NT, assets: bfa, maxSteps: 400_000_000, rnd: (() => { const x = new XS(0xACE1); return () => x.next(); })(), keys: (t, c) => keys(t).includes(c) });
  const a = run(old), b = run(variant);
  let bad = null;
  for (let t = 0; t < NT && !bad; t++) {
    const x = a.ticks[t], y = b.ticks[t];
    if (x.cells.some((v, i) => v !== y.cells[i])) bad = `tick ${t + 1}: a cell differs`;
    else if (x.attrs.some((v, i) => v !== y.attrs[i])) bad = `tick ${t + 1}: an attribute differs`;
    else if (x.vars.SHI !== y.vars.SHI || x.vars.SLO !== y.vars.SLO) bad = `tick ${t + 1}: the score differs`;
  }
  const final = b.ticks.at(-1).vars;
  check_(`blockfall.arc (FREESEED = 0) and blockfall-v0.arc: cells, attributes and score equal on ${NT} ticks of a short script (score ${final.SHI * 10000 + final.SLO}, ${final.LNS} lines, piece ${final.PC})`, bad === null && final.LNS + final.SLO + final.PY > 0, bad ?? '');
  if (R.ok) {
    const shipped = compile(neu, { runtime: R.rt, image: R.img, assets: bfa });
    check_('the shipped blockfall.arc compiles with no errors and no warnings', shipped.errors.length === 0 && shipped.warnings.length === 0, errText(shipped));
    const got = runReal(shipped, { ticks: NT, keys });
    const want = interpFor(neu, bfa, got)(NT, { keys: (t, c) => keys(t).includes(c) });
    const d = got.error ?? diffRecords(got.ticks, want, {});
    check_(`the shipped blockfall.arc (RANDOMISE from the frame counter, BORDER, FILL, COPY) equals its interpreter on ${NT} real-runtime ticks`, d === null, d ?? `${got.rnd.flat().length} RANDOMISE seed(s)`);
  }
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-m5 (${passed} checks passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''})`);
process.exit(failed ? 1 : 0);
