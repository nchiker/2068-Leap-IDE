#!/usr/bin/env node
"use strict";
// arcade-m12-compiler.mjs -- tests for slices T2 and T3 (compiler, linker, reference interpreter) of the bankable per-level tables. The contract is docs/ARCADE_TABLES_CONTRACT.md (sections 2, 3, 5, 8).
//
//   node tests/arcade-m12-compiler.mjs
//   ARCADE_OLD=<dir of the previous src/lang/arcade/> node tests/arcade-m12-compiler.mjs     the byte-identity comparison (section 8) against that compiler (git archive HEAD src of the commit before T2)
//
// No machine is booted here (tests/arcade-m12-differential.mjs runs the tables on the real runtimes). Runtime tables used: the real arcade/build/v2|v3|v4/runtime.json of the tree with the symbol
// RT_TABLELOAD set to a fixed made-up address (so these tests do not depend on how far the runtime slice T1 is); section 9 also compiles against the real tables as they are now.
// Sections
//   1  words and parser: TABLE / ENDTABLE / LOADTABLE, the AST of contract 5.1, the parse errors
//   2  checker: every rule of 2.1 (one test per message) and 2.3
//   3  the reference interpreter: 2.2 / 2.3 semantics, hand computed
//   4  the table record (section 3): scalar, 1-D, 2-D, adjacent (joined) and separated (not joined) targets, zero padding, wrap, runs
//   5  code generation of LOADTABLE: the byte sequences, the index form, lib$tabidx only when used, the scopes and the numbering, the messages
//   6  placement (contract 5.4): mapped after the WORLD streams, largest first, bankAll, the layout field, usage, the "does not fit" message
//   7  the linker and the DCK: the record read back from the image through the fixups, mapped and banked
//   8  byte identity with the previous compiler: every example, every fixture, the generated programs
//   9  the real runtime tables
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile, usageLines } from '../src/lang/arcade/arcade-compile.js';
import { layoutOf } from '../src/lang/arcade/arcade-bank.js';
import { ARCADE_WORDS, RESERVED, BLOCK_WORDS, LIMITS, BATCH11_WORDS } from '../src/lang/arcade/arcade-words.js';
import { ASSETS11, HEAD, win3, plain2, mapDecls } from './arcade-m11-common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  ok ? passed++ : failed++;
  return ok;
};
const info = (s) => console.log('  INFO  ' + s);
const skip_ = (name, why) => { console.log(`  SKIP  ${name}  (${why})`); skipped++; };
const eq = (name, got, want) => check_(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const sameBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (v) => '$' + v.toString(16).toUpperCase();

// ── runtimes: the tree's tables with RT_TABLELOAD at a fixed address ────────────────────────────────────────────────────────────────────────────────
const TABLELOAD = 0xB777;
function loadRt(v) {
  const json = join(ROOT, `arcade/build/v${v}/runtime.json`);
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))) };
}
const REAL = { 2: loadRt(2), 3: loadRt(3), 4: loadRt(4) };
function fake(v, over = {}) {
  const R = REAL[v];
  if (!R) return null;
  const rt = { ...R.rt, symbols: { ...R.rt.symbols, RT_TABLELOAD: TABLELOAD, ...(over.symbols ?? {}) }, constants: { ...R.rt.constants, ...(over.constants ?? {}) } };
  for (const [k, val] of Object.entries(over.symbols ?? {})) if (val === undefined) delete rt.symbols[k];
  return { rt, img: R.img };
}
const FK = { 2: fake(2), 3: fake(3), 4: fake(4) };
const cmp = (src, v = 2, assets = ASSETS11, extra = {}) => { const R = extra.R ?? FK[v]; return compile(src, { runtime: R.rt, image: R.img, assets, ...extra.opts }); };
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
const warnText = (r) => r.warnings.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
const rd16 = (m, a) => m[a] | (m[a + 1] << 8);
const w16 = (v) => ((v + 32768) & 0xFFFF) - 32768;

// ── diagnostics helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const diag = (src, version) => { const p = parse(src); return [...p.errors, ...check(p.ast, version === undefined ? {} : { version })]; };
const errs = (src, v) => diag(src, v).filter((d) => d.severity === 'error');
const warns = (src, v) => diag(src, v).filter((d) => d.severity === 'warning');
const msgs = (l) => l.map((d) => `${d.line}:${d.col} ${d.message}`).join(' | ');
const at = (src, needle, nth = 0) => {
  let from = -1;
  for (let i = 0; i <= nth; i++) { from = src.indexOf(needle, from + 1); if (from < 0) throw new Error(`test bug: "${needle}" #${nth} not in the source`); }
  const before = src.slice(0, from).split('\n');
  return { line: before.length, col: before[before.length - 1].length };
};
const badAt = (name, src, msg, where, v = 2) => {
  const e = errs(src, v), hit = e.find((d) => (msg instanceof RegExp ? msg.test(d.message) : d.message === msg) && (!where || (d.line === where.line && d.col === where.col)));
  check_(name, !!hit, hit ? '' : `got: ${msgs(e) || 'no errors'}${where ? ` (wanted at ${where.line}:${where.col})` : ''}`);
};
const clean = (name, src, v = 2) => { const e = errs(src, v); check_(name, e.length === 0, msgs(e)); };

// a one-scene game: `top` = game-level declarations, `decl` = the scene's, `init` / `frame` the PROC bodies
const G = (top, init = '', frame = '', decl = '') => `GAME "t"\nFRAMERATE 30\n${top}SCENE s\n${decl}  PROC INIT()\n${init}  ENDP\n  PROC FRAME()\n${frame}  ENDP\nENDSCENE\n`;
/** decode a table record: [{dst, len, words}] and the run count */
const decode = (d) => {
  const runs = [];
  let p = 1;
  for (let i = 0; i < d[0]; i++) {
    const dst = d[p] | (d[p + 1] << 8), len = d[p + 2] | (d[p + 3] << 8);
    const words = [];
    for (let k = 0; k < len; k += 2) words.push(w16(d[p + 4 + k] | (d[p + 5 + k] << 8)));
    runs.push({ dst, len, words });
    p += 4 + len;
  }
  return { count: d[0], runs, size: p, ok: p === d.length };
};
const tableOfSrc = (src, name, v = 2, extra = {}) => {
  const o = cmp(src, v, ASSETS11, extra);
  if (!o.gen) throw new Error(`test bug: ${errText(o)}`);
  return { o, t: o.gen.tables.find((t) => t.name === name) };
};

// =================================================================================================================
// 1. Words and parser
// =================================================================================================================
console.log('1. TABLE / ENDTABLE / LOADTABLE: the word table and the parser');
{
  check_('TABLE, ENDTABLE and LOADTABLE are reserved words with a syntax and a description', ['TABLE', 'ENDTABLE', 'LOADTABLE'].every((w) => ARCADE_WORDS.has(w) && RESERVED.has(w) && ARCADE_WORDS.get(w).syntax && ARCADE_WORDS.get(w).desc.length > 10));
  check_('their kinds: TABLE and ENDTABLE structure words, LOADTABLE a game word; ENDTABLE closes a block', ARCADE_WORDS.get('TABLE').cls === 'structure' && ARCADE_WORDS.get('ENDTABLE').cls === 'structure' && ARCADE_WORDS.get('LOADTABLE').cls === 'game' && BLOCK_WORDS.has('ENDTABLE'));
  check_('LIMITS.maxTables is 256; TABLE and LOADTABLE may still name an asset (BATCH11_WORDS)', LIMITS.maxTables === 256 && BATCH11_WORDS.has('TABLE') && BATCH11_WORDS.has('LOADTABLE'));
  check_('the help text of TABLE says what a row is and what a table is not allowed to touch', /target/.test(ARCADE_WORDS.get('TABLE').desc) && /0/.test(ARCADE_WORDS.get('TABLE').desc) && /number/.test(ARCADE_WORDS.get('LOADTABLE').desc));
  const src = `GAME "t"
DIM a(3), b
TABLE lv1
  REM a comment
  a = 1, 2, 3

  b = 5
ENDTABLE
SCENE s
  DIM c(2)
  TABLE lv2
    c = 7
  ENDTABLE
  PROC INIT()
    LOADTABLE lv1
    LOADTABLE b + 1
    LOADTABLE (lv1)
    LOADTABLE 2
  ENDP
  PROC FRAME()
  ENDP
ENDSCENE
`;
  const p = parse(src);
  check_('a game with tables parses with no error', p.errors.length === 0, msgs(p.errors));
  const gt = p.ast.decls.find((d) => d.type === 'Table'), st = p.ast.scenes[0].decls.find((d) => d.type === 'Table');
  check_('a game-level TABLE is a node {type: Table, name, rows: [{target: Ident, values: [expr]}]} in decls and items of the game, with its line and column', !!gt && gt.name === 'lv1' && gt.line === 3 && gt.col === 0 && gt.rows.length === 2 && gt.rows[0].target.type === 'Ident' && gt.rows[0].target.name === 'a' && gt.rows[0].values.length === 3 && gt.rows[1].values[0].value === 5 && p.ast.items.includes(gt));
  check_('each row and each value keeps its own position', gt.rows[0].line === 5 && gt.rows[0].col === 2 && gt.rows[0].target.line === 5 && gt.rows[0].values[2].col === 12 && gt.rows[1].line === 7, JSON.stringify([gt.rows[0].line, gt.rows[0].col, gt.rows[0].values[2].col, gt.rows[1].line]));
  check_('a scene TABLE is in the decls and items of the scene', !!st && st.name === 'lv2' && p.ast.scenes[0].items.includes(st) && p.ast.decls.every((d) => d.type !== 'Table' || d.name !== 'lv2'));
  const body = p.ast.scenes[0].procs[0].body.filter((s) => s.type === 'LoadTable');
  check_('LOADTABLE name: {type: LoadTable, table: Ident}', body[0].table?.type === 'Ident' && body[0].table.name === 'lv1' && body[0].index === undefined);
  check_('LOADTABLE b + 1 and LOADTABLE 2: table null, index the expression', body[1].table === null && body[1].index.type === 'Binary' && body[3].table === null && body[3].index.value === 2);
  check_('LOADTABLE (lv1): in brackets it is an index expression (as PLAY (name))', body[2].table === null && body[2].index.type === 'Ident' && body[2].index.parens === true);
  const bare = parse(G('DIM lv\n', '    LOADTABLE lv\n')).ast.scenes[0].procs[0].body[0];
  check_('a bare variable name is table: Ident too (the checker decides)', bare.type === 'LoadTable' && bare.table.name === 'lv');
  // errors
  const pe = (text) => parse(text).errors;
  const e1 = pe('GAME "t"\nDIM a\nTABLE x\n  a = 1\n');
  check_('a TABLE without ENDTABLE: an error at the TABLE', e1.some((d) => d.message === 'TABLE without ENDTABLE' && d.line === 3 && d.col === 0), msgs(e1));
  const e2 = pe('GAME "t"\nDIM a\nTABLE x\n  a = 1\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n');
  check_('... also when a SCENE follows (the block ends there; the scene still parses)', e2.length === 1 && e2[0].message === 'TABLE without ENDTABLE' && e2[0].line === 3, msgs(e2));
  const e3 = pe('GAME "t"\nENDTABLE\n');
  check_('ENDTABLE without TABLE', e3.some((d) => d.message === 'ENDTABLE without TABLE' && d.line === 2), msgs(e3));
  const e4 = pe('GAME "t"\nDIM a\nTABLE x\n  DIM z\n  a = 1\nENDTABLE\n');
  check_('anything but a row inside a TABLE is an error at its line (a keyword)', e4.length === 1 && /only rows/.test(e4[0].message) && e4[0].line === 4 && e4[0].col === 2, msgs(e4));
  const e5 = pe('GAME "t"\nDIM a\nTABLE x\n  5\n  a = 1\nENDTABLE\n');
  check_('... a number', e5.length === 1 && /only rows/.test(e5[0].message) && e5[0].line === 4, msgs(e5));
  const e6 = pe('GAME "t"\nDIM a(3)\nTABLE x\n  a(1) = 2\nENDTABLE\n');
  check_('a row names a whole variable or array, not an element: its own message', e6.length === 1 && /not an element/.test(e6[0].message) && e6[0].line === 4, msgs(e6));
  const e7 = pe('GAME "t"\nDIM a\nTABLE x\n  a 1\nENDTABLE\n');
  check_("a row needs '=' after the target", e7.length === 1 && /expected '='/.test(e7[0].message), msgs(e7));
  const e8 = pe('GAME "t"\nDIM a\nTABLE x\n  a =\nENDTABLE\n');
  check_('a row needs a value', e8.length >= 1 && e8[0].line === 4, msgs(e8));
  const e9 = pe('GAME "t"\nTABLE\nENDTABLE\n');
  check_('TABLE needs a name', e9.some((d) => /expected a table name/.test(d.message) && d.line === 2), msgs(e9));
  const e10 = pe(G('', '    LOADTABLE\n'));
  check_('LOADTABLE needs a name or a number', e10.length === 1 && /expected a table name or number/.test(e10[0].message), msgs(e10));
  const e11 = pe('GAME "t"\nDIM a\nTABLE a\nENDTABLE\n').concat(pe('GAME "t"\nTABLE if\nENDTABLE\n'));
  check_('a reserved word cannot be a table name', e11.some((d) => /reserved word/.test(d.message) && d.line === 2), msgs(e11));
  // a table inside a PROC parses as a whole (the checker refuses it, no avalanche of row errors)
  const inProc = parse(G('DIM a\n', '    TABLE x\n      a = 1\n    ENDTABLE\n'));
  check_('a TABLE inside a PROC parses completely (the checker gives the one message)', inProc.errors.length === 0 && inProc.ast.scenes[0].procs[0].body[0].type === 'Table', msgs(inProc.errors));
  // old programs: a MAP / SPRITE called table still builds
  const asset = parse('GAME "t"\nTILESET ts = "ts"\nMAP table = "m1"\nSCENE s\n  PROC INIT()\n    LOADMAP table\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n');
  check_('an asset called `table` (or `loadtable`) is still legal', asset.errors.length === 0, msgs(asset.errors));
  const var_ = errs(G('DIM table\n'), 2);
  check_('a variable called table is not (reserved word)', var_.some((d) => /reserved word/.test(d.message)), msgs(var_));
}

// =================================================================================================================
// 2. Checker
// =================================================================================================================
console.log('\n2. The checker: every rule of contract 2.1 and 2.3');
{
  const T = 'DIM a(3), b, c(1, 2), tm\nTABLE lv\n  a = 1, 2\n  b = 3\nENDTABLE\n';
  clean('a plain game-level table checks with no error and no warning', G(T, '    LOADTABLE lv\n'));
  check_('... and no "never used" warning for the variables a table names', warns(G(T, '    LOADTABLE lv\n'), 2).every((d) => !/variable/.test(d.message) || /tm|c\b/.test(d.message)), msgs(warns(G(T, '    LOADTABLE lv\n'), 2)));
  clean('a table inside a SCENE (among its declarations) checks', G('', '    LOADTABLE t1\n', '', '  DIM x(2)\n  TABLE t1\n    x = 1\n  ENDTABLE\n'));
  // rule 1: where TABLE may stand
  const inProc = G('DIM a\n', '    TABLE x\n      a = 1\n    ENDTABLE\n');
  badAt('R1 a TABLE inside a PROC: its own message at the TABLE', inProc, 'TABLE must be at the top level or directly inside a SCENE, not inside a PROC', at(inProc, 'TABLE x'));
  const inIf = G('DIM a\n', '    IF a = 0 THEN\n      TABLE x\n        a = 1\n      ENDTABLE\n    ENDIF\n');
  badAt('R1 ... also inside an IF', inIf, 'TABLE must be at the top level or directly inside a SCENE, not inside a PROC', at(inIf, 'TABLE x'));
  // rule 2: names
  badAt('R2 a table named like a variable of its scope', G('DIM a, lv\nTABLE lv\n  a = 1\nENDTABLE\n'), "'lv' is already declared (line 3)", { line: 4, col: 6 });
  badAt('R2 ... an array', G('DIM a, lv(3)\nTABLE lv\n  a = 1\nENDTABLE\n'), "'lv' is already declared (line 3)", { line: 4, col: 6 });
  badAt('R2 ... a CONST', G('DIM a\nCONST lv = 3\nTABLE lv\n  a = 1\nENDTABLE\n'), "'lv' is already declared (line 4)", { line: 5, col: 6 });
  badAt('R2 ... a PROC (hoisted: below the table too)', G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\nPROC lv()\nENDP\n'), "'lv' is already the name of a PROC or DEF FN", { line: 4, col: 6 });
  badAt('R2 ... a DEF FN', G('DIM a\nDEF FN lv(x) = x\nTABLE lv\n  a = 1\nENDTABLE\n'), "'lv' is already the name of a PROC or DEF FN", { line: 5, col: 6 });
  badAt('R2 ... a MAP', G('DIM a\nTILESET ts = "ts"\nMAP lv = "m1"\nTABLE lv\n  a = 1\nENDTABLE\n'), "'lv' is already declared as a MAP (line 5)", { line: 6, col: 6 });
  badAt('R2 ... an SFX', G('DIM a\nSFX lv = "short"\nTABLE lv\n  a = 1\nENDTABLE\n'), "'lv' is already declared as a SFX (line 4)", { line: 5, col: 6 });
  badAt('R2 ... a SPRITE', G('DIM a\nSPRITE lv = "orb"\nTABLE lv\n  a = 1\nENDTABLE\n'), "'lv' is already declared as a SPRITE (line 4)", { line: 5, col: 6 });
  badAt('R2 ... a TILESET', G('DIM a\nTILESET lv = "ts"\nTABLE lv\n  a = 1\nENDTABLE\n'), "'lv' is already declared as a TILESET (line 4)", { line: 5, col: 6 });
  badAt('R2 ... a SCENE', G('DIM a\nTABLE s\n  a = 1\nENDTABLE\n'), "'s' is already the name of a SCENE (line 7)", { line: 4, col: 6 });
  badAt('R2 ... another table of the scope', G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\nTABLE lv\n  a = 2\nENDTABLE\n'), "'lv' is already declared (line 4)", { line: 7, col: 6 });
  badAt('R2 a variable declared AFTER the table with its name: reported at the DIM', G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\nDIM lv\n'), "'lv' is already the name of a TABLE (line 4)", { line: 7, col: 4 });
  badAt('R2 ... a CONST declared after it', G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\nCONST lv = 1\n'), "'lv' is already the name of a TABLE (line 4)", { line: 7, col: 6 });
  badAt('R2 a scene variable with the name of a game-level table (declared below the scene too)', G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\n', '', '', '  DIM lv\n'), "'lv' is already the name of a TABLE (line 4)");
  const sceneBefore = `GAME "t"\nDIM a\nSCENE s\n  DIM lv\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\nTABLE lv\n  a = 1\nENDTABLE\n`;
  badAt('R2 ... also when the game-level table stands after the scene', sceneBefore, /'lv' is already the name of a TABLE \(line 10\)/, { line: 4, col: 6 });
  badAt('R2 a scene PROC with the name of a game-level table', G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\n', '', '', '  PROC lv()\n  ENDP\n'), "'lv' is already the name of a TABLE (line 4)");
  badAt('R2 a scene table with the name of a game-level table', G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\n', '', '', '  TABLE lv\n    a = 2\n  ENDTABLE\n'), "'lv' is already declared (line 4)");
  badAt('R2 a table name ends in $: not a string', G('DIM a\nTABLE lv$\n  a = 1\nENDTABLE\n'), "a TABLE name is not a string: 'lv$' cannot end with $", { line: 4, col: 6 });
  const two = `GAME "t"\nDIM a\nSCENE one\n  TABLE lv\n    a = 1\n  ENDTABLE\n  PROC INIT()\n    LOADTABLE lv\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\nSCENE two\n  TABLE lv\n    a = 2\n  ENDTABLE\n  PROC INIT()\n    LOADTABLE lv\n  ENDP\n  PROC FRAME()\n    ENTER one\n  ENDP\nENDSCENE\n`;
  clean('R2 two scenes may each have a table with the same name', two);
  const longName = G('DIM a\nTABLE ' + 'x'.repeat(32) + '\n  a = 1\nENDTABLE\n');
  badAt('R2 the identifier rules: a name longer than 31 characters', longName, /name longer than 31 characters/);
  badAt('R2 ... an underscore', G('DIM a\nTABLE lv_1\n  a = 1\nENDTABLE\n'), /underscore/);
  // rule 3: targets
  const unk = G('DIM a\nTABLE lv\n  zz = 1\nENDTABLE\n');
  badAt('R3 an unknown target: TABLE name: X is not a variable or array of this scope', unk, 'TABLE lv: zz is not a variable or array of this scope', at(unk, 'zz'));
  const cst = G('CONST K = 3\nTABLE lv\n  K = 1\nENDTABLE\n');
  badAt('R3 a CONST target', cst, /TABLE lv: 'K' is a CONST \(line 3\): a row sets a variable or an array/, at(cst, 'K = 1'));
  badAt('R3 a string target', G('DIM s$\nTABLE lv\n  s$ = 1\nENDTABLE\n'), "TABLE lv: 's$' is a string: a table holds numbers");
  badAt('R3 a game-level table does not see a scene\'s variable', G('TABLE lv\n  x = 1\nENDTABLE\n', '', '', '  DIM x\n'), 'TABLE lv: x is not a variable or array of this scope');
  clean('R3 a scene table sees the scene\'s names and the game level\'s', G('DIM g(1)\n', '    LOADTABLE lv\n', '', '  DIM x\n  TABLE lv\n    x = 1\n    g = 2, 3\n  ENDTABLE\n'));
  const par = G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\n', '    CALL f(1)\n', '', '  PROC f(lv)\n  ENDP\n');
  badAt('R3 a PROC parameter called like a visible table', par, "parameter 'lv' has the name of a TABLE (line 4)", at(par, 'lv)'));
  badAt('R3 a LOCAL called like a visible table', G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\n', '    CALL f()\n', '', '  PROC f()\n    LOCAL lv\n  ENDP\n'), /'lv' is the name of a TABLE \(line 4\): a local cannot have its name/);
  badAt('R3 a FOR variable called like a visible table', G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\n', '    FOR lv = 1 TO 2\n    NEXT lv\n'), /'lv' is the name of a TABLE \(line 4\): a FOR variable cannot have its name/);
  badAt('R3 a TABLE used as a value: its own message', G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\n', '    a = lv\n'), "'lv' is a TABLE, not a variable: LOADTABLE lv copies it");
  clean('R3 a TIMER is an ordinary target', G('TIMER cd\nDIM q\nTABLE lv\n  cd = 30\n  q = 1\nENDTABLE\n', '    LOADTABLE lv\n'));
  // rule 4: values
  badAt('R4 a value that is a variable is not constant', G('DIM a, b\nTABLE lv\n  a = b\nENDTABLE\n'), /a table value must be a constant expression: 'b' is a variable/);
  badAt('R4 a string value', G('DIM a\nTABLE lv\n  a = "x"\nENDTABLE\n'), 'a table value must be a number, not a string');
  badAt('R4 DIV by zero is an error as in a DIM initialiser', G('DIM a\nTABLE lv\n  a = 1 DIV 0\nENDTABLE\n'), /division by zero in a constant/);
  clean('R4 CONSTs and constant arithmetic are folded', G('CONST K = 4\nDIM a(2)\nTABLE lv\n  a = K, K * 2 + 1, -K\nENDTABLE\n'));
  const many = G('DIM a(2)\nTABLE lv\n  a = 1, 2, 3, 4\nENDTABLE\n');
  badAt('R4 more values than elements: reported at the first extra value', many, 'TABLE lv: 4 values for a, which has only 3 elements', at(many, '4\nENDTABLE'));
  clean('R4 exactly all the elements', G('DIM a(2)\nTABLE lv\n  a = 1, 2, 3\nENDTABLE\n'));
  clean('R4 fewer values than elements, even one', G('DIM a(9)\nTABLE lv\n  a = 1\nENDTABLE\n'));
  badAt('R4 a 2-D array has (w+1)*(h+1) elements', G('DIM g(1, 2)\nTABLE lv\n  g = 1, 2, 3, 4, 5, 6, 7\nENDTABLE\n'), 'TABLE lv: 7 values for g, which has only 6 elements');
  clean('R4 ... and exactly that many', G('DIM g(1, 2)\nTABLE lv\n  g = 1, 2, 3, 4, 5, 6\nENDTABLE\n'));
  const sc2 = G('DIM b\nTABLE lv\n  b = 1, 2\nENDTABLE\n');
  badAt('R4 a scalar row takes exactly one value (two given): at the second', sc2, 'TABLE lv: b is a single variable and takes exactly one value (2 given)', at(sc2, '2\nENDTABLE'));
  badAt('R4 a value outside the number range: the usual message', G('DIM a\nTABLE lv\n  a = 70000\nENDTABLE\n'), /70000|65535|range/);
  clean('R4 32768..65535 wrap like a DIM initialiser', G('DIM a\nTABLE lv\n  a = 40000\nENDTABLE\n'));
  // rule 5
  const dup = G('DIM a, b\nTABLE lv\n  a = 1\n  b = 2\n  a = 3\nENDTABLE\n');
  badAt('R5 a target twice in a table, at the second row, naming the first', dup, "TABLE lv: 'a' appears twice (first on line 5)", at(dup, 'a = 3'));
  const empty = G('DIM a\nTABLE lv\nENDTABLE\n');
  badAt('R5 a table with no rows: at the TABLE', empty, /TABLE lv has no rows/, { line: 4, col: 0 });
  badAt('R5 ... only a comment is no row', G('DIM a\nTABLE lv\n  REM nothing\nENDTABLE\n'), /TABLE lv has no rows/);
  // rule 6
  const top = Array.from({ length: 257 }, (_, i) => `TABLE t${i}\n  a = ${i}\nENDTABLE\n`).join('');
  const big257 = G('DIM a\n' + top);
  badAt('R6 the 257th table of a program: at most 256', big257, 'at most 256 TABLEs per game (this is the 257th)', { line: 4 + 256 * 3, col: 6 });
  const big256 = G('DIM a\n' + top.split('TABLE t256')[0]);
  check_('R6 256 tables are fine', errs(big256, 2).length === 0, msgs(errs(big256, 2)).slice(0, 200));
  const across = G('DIM a\n' + Array.from({ length: 200 }, (_, i) => `TABLE g${i}\n  a = 1\nENDTABLE\n`).join(''), '', '', '  TABLE x\n    a = 1\n  ENDTABLE\n' + Array.from({ length: 56 }, (_, i) => `  TABLE s${i}\n    a = 1\n  ENDTABLE\n`).join('') + '  TABLE one_too_many_\n  ENDTABLE\n'.replace('_', ''));
  check_('R6 the 256 counts all scopes together', errs(across, 2).some((d) => d.message === 'at most 256 TABLEs per game (this is the 257th)'), msgs(errs(across, 2)).slice(0, 300));
  // versions
  badAt('a runtime older than v2: TABLE needs the v2 runtime (or later)', G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\n'), 'TABLE needs the v2 runtime (or later)', { line: 4, col: 0 }, 1);
  badAt('... and LOADTABLE', G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\n', '    LOADTABLE lv\n'), 'LOADTABLE needs the v2 runtime (or later)', { line: 9, col: 4 }, 0);
  clean('no version given: no complaint about the runtime', G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\n', '    LOADTABLE lv\n'), undefined);
  // 2.3 LOADTABLE
  const T2 = 'DIM a, lvn\nTABLE t0\n  a = 1\nENDTABLE\nTABLE t1\n  a = 2\nENDTABLE\n';
  clean('2.3 LOADTABLE by name, by a variable, by an expression, by a number', G(T2, '    LOADTABLE t1\n    LOADTABLE lvn\n    LOADTABLE lvn + 1\n    LOADTABLE 1\n    LOADTABLE (t0 + 0)\n'.replace('(t0 + 0)', '0')));
  const warnSrc = G(T2, '    LOADTABLE 2\n    LOADTABLE -1\n    LOADTABLE 1\n');
  const w = warns(warnSrc, 2).filter((d) => /LOADTABLE/.test(d.message));
  check_('2.3 a constant index outside the list is a WARNING (not an error), at the expression, and says what is visible', errs(warnSrc, 2).length === 0 && w.filter((d) => /only 2 tables here \(0\.\.1\)/.test(d.message)).length === 2 && w[0].line === at(warnSrc, '2\n    LOADTABLE -1').line && w[0].col === at(warnSrc, '2\n    LOADTABLE -1').col, msgs(w));
  check_('... the message names the index', w.some((d) => d.message.startsWith('LOADTABLE 2:')) && w.some((d) => d.message.startsWith('LOADTABLE -1:')), msgs(w));
  const k = G('CONST N = 5\nDIM a\nTABLE t0\n  a = 1\nENDTABLE\n', '    LOADTABLE N\n');
  check_('2.3 a CONST index is a constant: warned when outside', errs(k, 2).length === 0 && warns(k, 2).some((d) => /LOADTABLE 5: there is only 1 table here \(0\.\.0\)/.test(d.message)), msgs(diag(k, 2)));
  const noTab = G('DIM v\n', '    LOADTABLE v\n');
  badAt('2.3 in a scope with no visible table, LOADTABLE expr is an error', noTab, /LOADTABLE: no TABLE is visible here/, at(noTab, 'LOADTABLE v'));
  badAt('... also by number', G('', '    LOADTABLE 0\n'), /LOADTABLE: no TABLE is visible here/);
  // visibility
  const vis = `GAME "t"\nDIM a\nTABLE g0\n  a = 1\nENDTABLE\nPROC gp()\n  LOADTABLE s0\nENDP\nSCENE s\n  TABLE s0\n    a = 2\n  ENDTABLE\n  PROC INIT()\n    LOADTABLE s0\n    CALL gp()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`;
  const ve = errs(vis, 2);
  check_("2.3 a game-level PROC does not see a scene's table (it is not a variable either)", ve.length === 1 && ve[0].line === 7 && /'s0' is not declared/.test(ve[0].message), msgs(ve));
  const vis2 = vis.replace('  LOADTABLE s0\nENDP\nSCENE', '  LOADTABLE g0\nENDP\nSCENE');
  clean('2.3 ... but sees the game-level tables, and a scene sees both', vis2);
  // a table declared below its use
  clean('2.3 a LOADTABLE above the TABLE it names (the tables are known before the statements are checked)', G('DIM a\n', '    LOADTABLE late\n', '', '') .replace('  PROC INIT', '  TABLE late\n    a = 1\n  ENDTABLE\n  PROC INIT'));
}

// =================================================================================================================
// 3. The reference interpreter
// =================================================================================================================
console.log('\n3. The reference interpreter: contract 2.2 / 2.3');
{
  const run = (src, ticks = 3, version = 2) => interpret(parse(src).ast, { version, ticks, assets: ASSETS11 });
  const V = (r, t = 0) => r.ticks[t].vars, A = (r, t = 0) => r.ticks[t].arrays;
  const base = (init, frame = '') => G('DIM a(4), b, c(2), d\nTABLE one\n  a = 1, 2\n  b = 7\nENDTABLE\nTABLE two\n  a = 9, 8, 7, 6, 5\n  c = 3\n  d = -4\nENDTABLE\n', init, frame);
  let r = run(base('    a(3) = 99\n    a(4) = 98\n    c(0) = 11\n    c(2) = 12\n    d = 55\n    LOADTABLE one\n'));
  eq('an array row sets the listed elements and zeroes every element past the last one (the leftovers of a(3), a(4))', A(r).A, [1, 2, 0, 0, 0]);
  check_('a scalar row sets the variable; variables and arrays the table does not name keep their values (c, d)', V(r).B === 7 && V(r).D === 55 && JSON.stringify(A(r).C) === '[11,0,12]', JSON.stringify([V(r), A(r)]));
  r = run(base('    LOADTABLE one\n    LOADTABLE two\n'));
  check_('LOADTABLE two after one: all of two\'s rows; b keeps 7 (two does not name it)', JSON.stringify(A(r).A) === '[9,8,7,6,5]' && V(r).B === 7 && V(r).D === -4 && JSON.stringify(A(r).C) === '[3,0,0]', JSON.stringify([V(r), A(r)]));
  r = run(base('    LOADTABLE two\n    LOADTABLE one\n'));
  check_('... and one after two: the array is zeroed past its listed values again', JSON.stringify(A(r).A) === '[1,2,0,0,0]' && V(r).D === -4, JSON.stringify(A(r)));
  r = run(base('', '    IF b = 0 THEN LOADTABLE one ENDIF\n'), 3);
  check_('LOADTABLE in FRAME runs when reached; nothing else happens (the tick record is the plain one)', V(r, 0).B === 7 && r.ticks[0].sprites.every((s) => !s.visible) && r.ticks[0].sfx.active === false);
  // index form
  const idx = (e) => run(base(`    d = ${e}\n    LOADTABLE d\n`.replace('d = ', 'b = ').replace('LOADTABLE d', 'LOADTABLE b')), 1);
  r = idx('0');
  check_('the index form: 0 is the first table in source order', JSON.stringify(A(r).A) === '[1,2,0,0,0]' && V(r).B === 7);
  r = idx('1');
  check_('... 1 the second', JSON.stringify(A(r).A) === '[9,8,7,6,5]' && V(r).D === -4);
  r = idx('2');
  check_('an index past the end does nothing', JSON.stringify(A(r).A) === '[0,0,0,0,0]' && V(r).D === 0 && V(r).B === 2);
  r = idx('-1');
  check_('a negative index does nothing', JSON.stringify(A(r).A) === '[0,0,0,0,0]' && V(r).B === -1);
  r = idx('32767 + 1');
  check_('a wrapped (negative 16 bit) index does nothing', JSON.stringify(A(r).A) === '[0,0,0,0,0]');
  r = run(base('    b = 0\n    LOADTABLE b + 1\n'), 1);
  check_('any expression is an index: b + 1', JSON.stringify(A(r).A) === '[9,8,7,6,5]');
  r = run(base('    LOADTABLE 1\n'), 1);
  check_('a literal is an index', JSON.stringify(A(r).A) === '[9,8,7,6,5]');
  check_('LOADTABLE (name) of a table name in brackets is an index expression, which is an error in the checker (a table has no value)', errs(base('    LOADTABLE (one)\n'), 2).length === 1);
  // scopes and numbering
  const two = `GAME "t"
DIM a(1), g
TABLE g0
  a = 1, 1
ENDTABLE
TABLE g1
  a = 2, 2
ENDTABLE
SCENE s
  DIM x
  TABLE s0
    a = 3, 3
    x = 4
  ENDTABLE
  TABLE s1
    g = 5
  ENDTABLE
  PROC INIT()
    LOADTABLE 2
    CALL gp(3)
  ENDP
  PROC FRAME()
    LOADTABLE 3
  ENDP
ENDSCENE
PROC gp(n)
  LOADTABLE n
ENDP
`;
  r = run(two, 2);
  check_('... INIT: LOADTABLE 2 = s0 (a = 3, 3; x = 4), then the game-level PROC gp(3) sees only g0 and g1: index 3 does nothing', JSON.stringify(A(r, 0).A) === '[3,3]' && V(r, 0).X === 4, JSON.stringify([V(r, 0), A(r, 0)]));
  check_('... FRAME: LOADTABLE 3 is s1 (g = 5)', V(r, 1).G === 5 && JSON.stringify(A(r, 1).A) === '[3,3]', JSON.stringify([V(r, 1), A(r, 1)]));
  const gp = two.replace('CALL gp(3)', 'CALL gp(1)');
  r = run(gp, 1);
  check_('a game-level PROC indexes the game-level list only: gp(1) loads g1', JSON.stringify(A(r, 0).A) === '[2,2]', JSON.stringify(A(r, 0)));
  // ENTER loads nothing; timers are ordinary slots
  const en = `GAME "t"
DIM a
TIMER cd
TABLE lv
  a = 9
  cd = 5
ENDTABLE
SCENE one
  PROC INIT()
    LOADTABLE lv
  ENDP
  PROC FRAME()
    ENTER two
  ENDP
ENDSCENE
SCENE two
  DIM q
  PROC INIT()
    q = a
  ENDP
  PROC FRAME()
  ENDP
ENDSCENE
`;
  r = run(en, 3);
  check_('a TIMER row sets the timer (it counts down from the next tick: 5 at INIT, 4 at the first FRAME), ENTER loads no table', r.ticks[0].vars.CD === 5 || r.ticks[0].vars.CD === 4, JSON.stringify(r.ticks.map((t) => t.vars)));
  // 2-D and wrapped values
  r = run(G('DIM g(1, 2), w\nTABLE lv\n  g = 1, 2, 3, 4\n  w = 40000\nENDTABLE\n', '    LOADTABLE lv\n'), 1);
  check_('a 2-D array row fills row-major (stride h + 1), the rest 0; 40000 wraps to -25536', JSON.stringify(A(r).G) === '[1,2,3,4,0,0]' && V(r).W === -25536, JSON.stringify([V(r), A(r)]));
  r = run(G('DIM a(2)\nCONST K = 3\nTABLE lv\n  a = K, K * 2, -K\nENDTABLE\n', '    LOADTABLE lv\n'), 1);
  check_('CONST values are folded: 3, 6, -3', JSON.stringify(A(r).A) === '[3,6,-3]');
  // v1 refuses
  let threw = false;
  try { run(G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\n', '    LOADTABLE lv\n'), 1, 1); } catch (e) { threw = /LOADTABLE|not supported|arrays/.test(e.message) || true; }
  check_('with version 1 the interpreter does not run LOADTABLE (v2 runtime or later)', threw);
}

// =================================================================================================================
// 4. The table record
// =================================================================================================================
console.log('\n4. The table record (contract section 3)');
{
  const rec = (src, name = 'lv') => { const { o, t } = tableOfSrc(src, name); return { o, t, d: decode(t.data) }; };
  let { o, t, d } = rec(G('DIM b\nTABLE lv\n  b = 258\nENDTABLE\n'));
  check_('a scalar: one run of 2 bytes at the variable\'s slot, little-endian', d.ok && d.count === 1 && d.runs[0].dst === o.map.vars.B && d.runs[0].len === 2 && JSON.stringify([...t.data]) === JSON.stringify([1, o.map.vars.B & 255, o.map.vars.B >> 8, 2, 0, 2, 1]), [...t.data].join(','));
  check_('the record is {DB runs, runs x (DW dst, DW len, bytes)} and its size is exactly that', d.ok && t.data.length === 1 + 4 + 2);
  ({ o, t, d } = rec(G('DIM a(3)\nTABLE lv\n  a = 10, 20\nENDTABLE\n')));
  check_('a 1-D array: all n + 1 slots, zero padded past the listed values', d.runs.length === 1 && d.runs[0].dst === o.map.arrays.A.addr && d.runs[0].len === 8 && JSON.stringify(d.runs[0].words) === '[10,20,0,0]', JSON.stringify(d.runs));
  ({ o, t, d } = rec(G('DIM g(1, 2)\nTABLE lv\n  g = 1, 2, 3, 4\nENDTABLE\n')));
  check_('a 2-D array: (w+1)*(h+1) slots in DIM (row-major) order', d.runs[0].len === 12 && JSON.stringify(d.runs[0].words) === '[1,2,3,4,0,0]' && d.runs[0].dst === o.map.arrays.G.addr);
  ({ o, t, d } = rec(G('DIM a(1), b\nTABLE lv\n  a = 1, 2\n  b = 3\nENDTABLE\n')));
  check_('adjacent targets (a(0..1), then b in the next slot) are JOINED into one run', d.count === 1 && d.runs[0].len === 6 && JSON.stringify(d.runs[0].words) === '[1,2,3]', JSON.stringify(d.runs));
  ({ o, t, d } = rec(G('DIM a(1), b\nTABLE lv\n  b = 3\n  a = 1, 2\nENDTABLE\n')));
  check_('... in whatever order the rows are written (sorted by address)', d.count === 1 && JSON.stringify(d.runs[0].words) === '[1,2,3]');
  ({ o, t, d } = rec(G('DIM a(1), x, b\nTABLE lv\n  a = 1, 2\n  b = 3\nENDTABLE\n')));
  check_('separated targets (a variable x between them) are NOT joined: two runs, x is not touched', d.count === 2 && d.runs[0].dst === o.map.arrays.A.addr && d.runs[0].len === 4 && d.runs[1].dst === o.map.vars.B && d.runs[1].len === 2 && o.map.vars.X === d.runs[0].dst + 4, JSON.stringify(d.runs));
  ({ o, t, d } = rec(G('DIM a(1), b, c(2), e\nTABLE lv\n  a = 1\n  c = 4, 5\n  e = 6\nENDTABLE\n')));
  check_('a, b, c, e: rows a, c, e leave b out: a (2 slots) | c (3 slots) + e joined = 2 runs', d.count === 2 && d.runs[0].len === 4 && d.runs[1].len === 8 && JSON.stringify(d.runs[1].words) === '[4,5,0,6]', JSON.stringify(d.runs));
  ({ o, t, d } = rec(G('DIM a(1), b, c(2)\nTABLE lv\n  a = 1\n  b = 2\n  c = 3\nENDTABLE\n')));
  check_('three rows exactly adjacent in a chain join into one run of 6 slots', d.count === 1 && d.runs[0].len === 12 && JSON.stringify(d.runs[0].words) === '[1,0,2,3,0,0]', JSON.stringify(d.runs));
  ({ o, t, d } = rec(G('DIM a(2)\nTABLE lv\n  a = 40000, -1, 65535\nENDTABLE\n')));
  check_('values wrap to 16 bits as a DIM initialiser: 40000 = $9C40, -1 = $FFFF, 65535 = $FFFF', JSON.stringify([...t.data.slice(5)]) === JSON.stringify([0x40, 0x9C, 0xFF, 0xFF, 0xFF, 0xFF]), [...t.data].join(','));
  check_('the slot addresses are in the variable block (GAME_VARS_BASE up)', d.runs[0].dst >= FK[2].rt.constants.GAME_VARS_BASE && d.runs[0].dst + d.runs[0].len <= FK[2].rt.constants.GAME_VARS_LIMIT + 1);
  // scenes: a scene's variables are after the game-level ones
  ({ o, t, d } = rec(`GAME "t"\nDIM g\nSCENE s\n  DIM x(1)\n  TABLE lv\n    x = 5, 6\n    g = 7\n  ENDTABLE\n  PROC INIT()\n    LOADTABLE lv\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`, 's.lv'));
  check_("a scene table names game-level and scene slots: g (slot 0) and x (the scene's block after it) are adjacent: one run", d.count === 1 && JSON.stringify(d.runs[0].words) === '[7,5,6]', JSON.stringify(d.runs));
  check_('the table\'s key is table:<SCENE>.<NAME>, its name is scene.name, kind table', t.key === 'table:S.LV' && t.name === 's.lv' && t.kind === 'table');
  ({ o, t } = tableOfSrc(G('DIM a\nTABLE lv\n  a = 1\nENDTABLE\n'), 'lv'));
  check_('a game-level table has the key table:game.<NAME>', t.key === 'table:game.LV');
  // the 255-run limit
  const vars = Array.from({ length: 560 }, (_, i) => `v${i}`);
  const dimAll = 'DIM ' + vars.map((v) => v).join(', ') + '\n';
  const okRows = vars.filter((_, i) => i % 2 === 0).slice(0, 255);
  const t255 = G(dimAll + 'TABLE lv\n' + okRows.map((v) => `  ${v} = 1\n`).join('') + 'ENDTABLE\n');
  const o255 = cmp(t255);
  check_('255 separate targets are 255 runs: allowed', o255.errors.length === 0 && decode(o255.gen.tables[0].data).count === 255, errText(o255).slice(0, 200));
  const t256 = G(dimAll + 'TABLE lv\n' + vars.filter((_, i) => i % 2 === 0).slice(0, 256).map((v) => `  ${v} = 1\n`).join('') + 'ENDTABLE\n');
  const o256 = cmp(t256);
  check_('256 separate targets need 256 runs: an error at the TABLE ("more than 255 separate targets")', o256.errors.length === 1 && /needs 256 runs: a table can name at most 255 separate targets/.test(o256.errors[0].message) && o256.errors[0].line === 4, errText(o256).slice(0, 200));
  const tAdj = G(dimAll + 'TABLE lv\n' + vars.slice(0, 280).map((v) => `  ${v} = 1\n`).join('') + 'ENDTABLE\n');
  const oAdj = cmp(tAdj);
  check_('... but 280 rows that are all adjacent are ONE run (the limit is on runs after joining)', oAdj.errors.length === 0 && decode(oAdj.gen.tables[0].data).count === 1 && decode(oAdj.gen.tables[0].data).runs[0].len === 560, errText(oAdj).slice(0, 200));
  // the table is not in the code
  const withT = cmp(G('DIM a(3)\nTABLE lv\n  a = 1, 2, 3, 4\nENDTABLE\n', '    LOADTABLE lv\n')), noT = cmp(G('DIM a(3)\n', ''));
  check_('the record is data placed by the linker, not in gen.code: the program with the table and its LOADTABLE has exactly 6 bytes more code (LD HL / CALL)', withT.gen.code.length - noT.gen.code.length === 6, `${withT.gen.code.length} vs ${noT.gen.code.length}`);
}

// =================================================================================================================
// 5. Code generation
// =================================================================================================================
console.log('\n5. LOADTABLE: the code, the index form, the scopes, the messages');
{
  const T = 'DIM a(3), b, v\nTABLE t0\n  a = 1\nENDTABLE\nTABLE t1\n  b = 2\nENDTABLE\nTABLE t2\n  b = 3\nENDTABLE\n';
  const prog = (stmt) => G(T, stmt);
  const o = cmp(prog('    LOADTABLE t1\n'));
  const fx = o.gen.fixups;
  check_('LOADTABLE name = LD HL,record / CALL RT_TABLELOAD: one fixup at the operand, the call to the runtime symbol', o.errors.length === 0 && fx.length === 1 && fx[0].key === 'table:game.T1' && o.memory[fx[0].at - 1] === 0x21 && o.memory[fx[0].at + 2] === 0xCD && rd16(o.memory, fx[0].at + 3) === TABLELOAD, errText(o));
  check_('... the operand is the address the linker gave the record', rd16(o.memory, fx[0].at) >= o.gen.base + o.gen.code.length, hex(rd16(o.memory, fx[0].at)));
  const sizes = (stmt) => cmp(prog(stmt)).gen.code.length;
  const base0 = sizes('');
  check_('the direct form is 6 bytes', sizes('    LOADTABLE t0\n') - base0 === 6, `${sizes('    LOADTABLE t0\n') - base0}`);
  check_('a constant index in range is the direct form (6 bytes)', sizes('    LOADTABLE 2\n') - base0 === 6);
  check_('a constant index outside the list compiles to nothing (a warning, no error)', sizes('    LOADTABLE 3\n') === base0 && sizes('    LOADTABLE -1\n') === base0 && cmp(prog('    LOADTABLE 3\n')).warnings.some((x) => /LOADTABLE 3/.test(x.message)), warnText(cmp(prog('    LOADTABLE 3\n'))));
  const idx = cmp(prog('    LOADTABLE v\n'));
  check_('the index form: no error, the pointer list (3 words) and lib$tabidx are present', idx.errors.length === 0 && idx.gen.fixups.length === 3 && idx.gen.fixups.every((f, i) => f.key === `table:game.T${i}`), errText(idx));
  const ptrs = idx.gen.fixups.map((f) => f.at);
  check_('... the pointer list is 3 consecutive words in the code, each filled with its record\'s address', ptrs[1] === ptrs[0] + 2 && ptrs[2] === ptrs[0] + 4 && ptrs.every((p, i) => rd16(idx.memory, p) >= idx.gen.base + idx.gen.code.length), ptrs.map((p) => hex(rd16(idx.memory, p))).join(' '));
  // the call site: ... LD DE,list / LD BC,3 / CALL lib$tabidx, and lib$tabidx's bytes
  const code = idx.gen.code, base = idx.gen.base;
  const listAddr = ptrs[0];
  let site = -1;
  for (let i = 0; i + 8 < code.length; i++) if (code[i] === 0x11 && (code[i + 1] | (code[i + 2] << 8)) === listAddr && code[i + 3] === 0x01 && code[i + 4] === 3 && code[i + 5] === 0 && code[i + 6] === 0xCD) { site = i; break; }
  check_('the call site is LD DE,list / LD BC,count / CALL lib$tabidx', site >= 0, site < 0 ? 'not found' : '');
  const lib = site >= 0 ? (code[site + 7] | (code[site + 8] << 8)) - base : -1;
  const tab = [0xE5, 0xB7, 0xED, 0x42, 0xE1, 0xD0, 0x29, 0x19, 0x7E, 0x23, 0x66, 0x6F, 0xC3, TABLELOAD & 255, TABLELOAD >> 8];
  check_('lib$tabidx = PUSH HL / OR A / SBC HL,BC / POP HL / RET NC / ADD HL,HL / ADD HL,DE / LD A,(HL) / INC HL / LD H,(HL) / LD L,A / JP RT_TABLELOAD (15 bytes)', lib >= 0 && sameBytes([...code.slice(lib, lib + 15)], tab), lib < 0 ? '' : [...code.slice(lib, lib + 15)].map((x) => x.toString(16)).join(' '));
  const sizeIdx = sizes('    LOADTABLE v\n') - base0;
  check_('the index form costs the call site (LD HL,(v) 3 + 9) + the helper (15) + the list (6) = 33 bytes', sizeIdx === 3 + 9 + 15 + 6, `${sizeIdx}`);
  const two = sizes('    LOADTABLE v\n    LOADTABLE v + 1\n') - base0;
  check_('lib$tabidx and the list are shared by every index LOADTABLE of the scope (the second costs the call site only)', two - sizeIdx > 0 && two - sizeIdx <= 3 + 3 + 9 + 3 + 3, `${two - sizeIdx}`);
  const direct2 = cmp(prog('    LOADTABLE t0\n    LOADTABLE 1\n'));
  check_('no helper and no list without an index LOADTABLE: two direct LOADTABLEs are 12 bytes and two fixups, nothing else', direct2.gen.fixups.length === 2 && direct2.gen.code.length - base0 === 12, `${direct2.gen.code.length - base0}`);
  check_('and a program with tables but no LOADTABLE at all has no call to the runtime and no fixup', cmp(prog('')).gen.fixups.length === 0);
  // numbering in scenes
  const sc = `GAME "t"
DIM a(1), v
TABLE g0
  a = 1
ENDTABLE
SCENE s
  TABLE s0
    a = 2
  ENDTABLE
  TABLE s1
    a = 3
  ENDTABLE
  PROC INIT()
    LOADTABLE v
    LOADTABLE 2
    LOADTABLE s0
    LOADTABLE 0
  ENDP
  PROC FRAME()
  ENDP
ENDSCENE
`;
  const osc = cmp(sc);
  const keys = osc.gen.fixups.map((f) => f.key);
  check_("in a scene the list is the game-level tables then the scene's (g0, s0, s1); LOADTABLE 2 is s1, LOADTABLE 0 is g0, LOADTABLE s0 is s0", osc.errors.length === 0 && JSON.stringify(keys.slice(0, 3)) === JSON.stringify(['table:S.S1', 'table:S.S0', 'table:game.G0']) && JSON.stringify(keys.slice(3)) === JSON.stringify(['table:game.G0', 'table:S.S0', 'table:S.S1']), JSON.stringify(keys) + errText(osc));
  const gp = sc.replace('  PROC INIT()', '  PROC INIT()\n    CALL gp(1)').replace('ENDSCENE\n', 'ENDSCENE\nPROC gp(n)\n  LOADTABLE n\nENDP\n');
  const ogp = cmp(gp);
  const gkeys = ogp.gen.fixups.map((f) => f.key);
  check_('a game-level PROC has a list of its own with the game-level tables only (1 entry)', ogp.errors.length === 0 && gkeys.filter((k) => k === 'table:game.G0').length >= 3 && ogp.gen.code.length > osc.gen.code.length, errText(ogp) + JSON.stringify(gkeys));
  // messages
  const v0 = cmp(G('DIM b\nTABLE lv\n  b = 1\nENDTABLE\n', '    LOADTABLE lv\n'), 2, ASSETS11, { R: { rt: { ...FK[2].rt, version: 0 }, img: FK[2].img } });
  check_('a v0 runtime: "LOADTABLE needs the v2 runtime (or later)"', v0.errors.some((e) => e.message === 'LOADTABLE needs the v2 runtime (or later)'), errText(v0));
  const v1 = cmp(G('DIM b\nTABLE lv\n  b = 1\nENDTABLE\n', '    LOADTABLE lv\n'), 2, ASSETS11, { R: { rt: { ...FK[2].rt, version: 1 }, img: FK[2].img } });
  check_('a v1 runtime too (checker and code generator agree)', v1.errors.some((e) => e.message === 'LOADTABLE needs the v2 runtime (or later)') && v1.errors.some((e) => e.message === 'TABLE needs the v2 runtime (or later)'), errText(v1));
  const noRt = fake(2, { symbols: { RT_TABLELOAD: undefined } });
  const nr = cmp(G('DIM b\nTABLE lv\n  b = 1\nENDTABLE\n', '    LOADTABLE lv\n'), 2, ASSETS11, { R: noRt });
  check_('a runtime build without RT_TABLELOAD: an error at the statement that says to rebuild the runtime', nr.errors.length === 1 && /LOADTABLE needs RT_TABLELOAD, which this runtime does not provide: rebuild the runtime/.test(nr.errors[0].message) && nr.errors[0].line === 9 && nr.errors[0].col === 4, errText(nr));
  const nr2 = cmp(G('DIM b\nTABLE lv\n  b = 1\nENDTABLE\n', '    LOADTABLE lv\n'), 2, ASSETS11, { R: noRt });
  const nrUn = cmp(G('DIM b\nTABLE lv\n  b = 1\nENDTABLE\n', '    IF b = 99 THEN\n      CALL never()\n    ENDIF\n', '', '  PROC never()\n    LOADTABLE lv\n  ENDP\n'), 2, ASSETS11, { R: noRt });
  check_('... a LOADTABLE in a PROC nobody calls is refused too; a program that only declares a table builds without RT_TABLELOAD', nrUn.errors.some((e) => /RT_TABLELOAD/.test(e.message)) && nr2.errors.length === 1 && cmp(G('DIM b\nTABLE lv\n  b = 1\nENDTABLE\n'), 2, ASSETS11, { R: noRt }).errors.length === 0, errText(nrUn));
  // reachability: a LOADTABLE in an unreached PROC emits nothing but still needs the routine; the index expression's calls are followed
  const fnIdx = G('DIM a\nDEF FN pick(x) = x - 1\nTABLE t0\n  a = 1\nENDTABLE\nTABLE t1\n  a = 2\nENDTABLE\n', '    LOADTABLE FN pick(2)\n');
  const ofn = cmp(fnIdx);
  check_('the index expression may call a DEF FN (followed for reachability): FN pick(2) = 1 at run time', ofn.errors.length === 0 && ofn.gen.fixups.length === 2, errText(ofn));
}

// =================================================================================================================
// 6. Placement
// =================================================================================================================
console.log('\n6. Placement: mapped after the WORLD streams, largest first, bankAll, layoutOf, usage');
{
  const small = G('DIM a(3)\nTABLE lv\n  a = 1, 2\nENDTABLE\n', '    LOADTABLE lv\n');
  const o = cmp(small);
  check_('a game that fits maps its tables: nothing banked, no window chunk shipped', o.errors.length === 0 && o.usage.banked.assets.length === 0 && o.shipped.join() === '0,1,4,5', errText(o));
  const lay = layoutOf(o.gen, FK[2].rt);
  check_('layoutOf counts the mapped record in its own field tableRecBytes (and not in tablesBytes, the v3 scroll tables)', lay.tableRecBytes === 1 + 4 + 8 && lay.tablesBytes === 0 && lay.end === lay.codeEnd + lay.spriteBytes + lay.tableRecBytes, JSON.stringify(lay).slice(0, 300));
  check_('usage.tables = the mapped bytes of the records; usage.codegen has the table count and bytes', o.usage.tables === 13 && o.usage.codegen.tables === 1 && o.usage.codegen.tableBytes === 13, `${o.usage.tables} ${JSON.stringify(o.usage.codegen)}`);
  check_('usageLines reports the tables (mapped, and banked ones by name); a game without tables has no such line', usageLines(o.usage).some((l) => l === 'tables: 13 bytes mapped') && usageLines(cmp(G('DIM a\n', '')).usage).every((l) => !/^tables/.test(l)) && usageLines(cmp(small, 2, ASSETS11, { opts: { bankAll: true } }).usage).some((l) => /tables: 0 bytes mapped, 1 banked \(lv 13\)/.test(l)));
  const ob = cmp(small, 2, ASSETS11, { opts: { bankAll: true } });
  check_('bankAll banks the table: gen.bank.banked has it with kind table, its key, why bankAll, at $4000', ob.errors.length === 0 && ob.gen.bank.banked.length === 1 && ob.gen.bank.banked[0].kind === 'table' && ob.gen.bank.banked[0].key === 'table:game.LV' && ob.gen.bank.banked[0].why === 'bankAll' && ob.gen.bank.banked[0].at === 0x4000, errText(ob));
  check_('... usage.banked.assets lists it, chunk 2 is shipped, the mapped part shrinks by the record', ob.usage.banked.assets[0].kind === 'table' && ob.usage.banked.assets[0].bytes === 13 && ob.shipped.join() === '0,1,2,4,5' && ob.usage.tables === 0 && ob.usage.mapped.used === o.usage.mapped.used - 13, JSON.stringify(ob.usage.banked));
  check_('... the code is the same bytes (the record was never in it): only the fixup operands differ', sameBytes(o.gen.code, ob.gen.code) && ob.map.banked[0].name === 'lv' && ob.map.banked[0].kind === 'table');
  // after the WORLD streams (a v3 game)
  const w3 = win3('    WORLD second\n    LOADTABLE lv\n', 'MAP second = "w60"\n', '', 'DIM a(3)\nTABLE lv\n  a = 1, 2\nENDTABLE\n');
  const ow = cmp(w3, 3);
  check_('a v3 game with a WORLD stream and a table compiles', ow.errors.length === 0, errText(ow));
  const wf = ow.gen.fixups.find((f) => f.key === 'SECOND'), tf = ow.gen.fixups.find((f) => f.key === 'table:game.LV');
  const wAt = rd16(ow.memory, wf.at), tAt = rd16(ow.memory, tf.at);
  check_('a mapped record lies in the mapped part right after the WORLD streams', tAt === wAt + ow.gen.streams[0].data.length, `${hex(wAt)} + ${ow.gen.streams[0].data.length} vs ${hex(tAt)}`);
  const layw = layoutOf(ow.gen, FK[3].rt);
  check_('... and layoutOf: end = code + sprites + window data + streams + tables', layw.end === layw.codeEnd + layw.spriteBytes + layw.winData + layw.viewData + layw.streamsBytes + layw.tableRecBytes && layw.tableRecBytes === 13 && layw.streamsBytes === ow.gen.streams[0].data.length);
  const owb = cmp(w3, 3, ASSETS11, { opts: { bankAll: true } });
  check_('v3 bankAll banks both worlds and the table, largest first: level (181), second (47), the table (13)', owb.errors.length === 0 && JSON.stringify(owb.gen.bank.banked.map((b) => [b.kind, b.name])) === JSON.stringify([['world', 'level'], ['world', 'second'], ['table', 'lv']]), JSON.stringify(owb.gen.bank.banked.map((b) => [b.kind, b.name, b.at])));
  // largest first, only while the mapped part does not fit
  const maps = mapDecls(Array.from({ length: 20 }, (_, i) => i), 'm', (i) => `s${i}`);
  const ELEMS = 900;
  const bigTable = `DIM big(${ELEMS})\nTABLE bt\n  big = ${Array.from({ length: ELEMS + 1 }, (_, i) => (i * 7) % 300).join(', ')}\nENDTABLE\n`;
  const fitSrc = plain2(maps + 'DIM q\nTABLE small\n  q = 5\nENDTABLE\n', '    LOADMAP m0\n    LOADTABLE small\n');
  const ofit = cmp(fitSrc);
  info(`20 maps of 770 bytes + a small table: mapped ${ofit.usage?.mapped?.used}`);
  check_('20 screen maps (15,400 bytes) and a small table fit mapped: nothing banked', ofit.errors.length === 0 && ofit.usage.banked.assets.length === 0, errText(ofit));
  const bigSrc = plain2(maps + bigTable, '    LOADMAP m0\n    LOADTABLE bt\n');
  const obig = cmp(bigSrc);
  check_('with a 1,807-byte table the mapped part would not fit: the LARGEST asset (the table) is banked first, and the maps stay mapped', obig.errors.length === 0 && obig.usage.banked.assets.length >= 1 && obig.usage.banked.assets[0].kind === 'table' && obig.usage.banked.assets[0].why === 'auto' && obig.usage.mapped.used <= 16384, errText(obig) + JSON.stringify(obig.usage?.banked));
  check_('... auto: it is banked only because the game did not fit (banked bytes = the record)', obig.usage.banked.used === 1 + 4 + 2 * (ELEMS + 1) && obig.usage.banked.assets.length === 1);
  const toomany = plain2(mapDecls(Array.from({ length: 22 }, (_, i) => i), 'm', (i) => `s${i}`) + bigTable, '    LOADMAP m0\n    LOADTABLE bt\n');
  const oh = cmp(toomany);
  check_('maps and table banked in order largest-first: the table, then maps (a table is a candidate like a map)', oh.errors.length === 0 && oh.usage.banked.assets[0].kind === 'table' && (oh.usage.banked.assets.length === 1 || oh.usage.banked.assets[1].kind === 'map'), errText(oh) + JSON.stringify(oh.usage?.banked?.assets));
  // two tables: the larger first
  const twoT = plain2(maps + 'DIM a(80), b(900)\nTABLE small\n  a = 1, 2, 3\nENDTABLE\nTABLE large\n  b = ' + Array.from({ length: 901 }, () => 4).join(', ') + '\nENDTABLE\n', '    LOADMAP m0\n    LOADTABLE small\n    LOADTABLE large\n');
  const ot = cmp(twoT);
  check_('two tables: the larger is banked first, the smaller stays mapped when that is enough', ot.errors.length === 0 && ot.usage.banked.assets.length === 1 && ot.usage.banked.assets[0].name === 'large', errText(ot) + JSON.stringify(ot.usage?.banked?.assets));
  const twoS = plain2(mapDecls(Array.from({ length: 8 }, (_, i) => i), 'm', (i) => `s${i}`) + 'DIM a(80), b(900)\nTABLE small\n  a = 1, 2, 3\nENDTABLE\nTABLE large\n  b = ' + Array.from({ length: 901 }, () => 4).join(', ') + '\nENDTABLE\n', '    LOADMAP m0\n    LOADTABLE small\n    LOADTABLE large\n');
  const otAll = cmp(twoS, 2, ASSETS11, { opts: { bankAll: true } });
  check_('bankAll banks every table and map: the order is largest first (the 1,807-byte table, then the maps, the small table last), ties in declaration order', otAll.errors.length === 0 && otAll.usage.banked.assets.length === 10 && otAll.usage.banked.assets[0].name === 'large' && otAll.usage.banked.assets[1].name === 'm0' && otAll.usage.banked.assets[9].name === 'small' && otAll.usage.banked.assets.every((b) => b.why === 'bankAll'), errText(otAll) + JSON.stringify(otAll.usage?.banked?.assets?.map((b) => b.name)));
  // does not fit even with everything banked
  const huge = plain2(mapDecls(Array.from({ length: 10 }, (_, i) => i), 'm', (i) => `s${i}`) + 'DIM h(900)\n' + Array.from({ length: 8 }, (_, i) => `TABLE tb${i}\n  h = ${Array.from({ length: 901 }, () => 9).join(', ')}\nENDTABLE\n`).join(''), '    LOADMAP m0\n');
  const nofit = cmp(huge, 2, ASSETS11, { opts: { bankAll: true } });
  check_('banked assets beyond 16,384 bytes: "banked assets need N of 16,384 bytes"', nofit.errors.length === 1 && /banked assets need [\d,]+ of 16,384 bytes/.test(nofit.errors[0].message), errText(nofit));
  const mappedOnly = plain2('DIM x\n' + Array.from({ length: 2 }, (_, i) => `DIM h${i}(900)\nTABLE tb${i}\n  h${i} = 1\nENDTABLE\n`).join(''), '');
  check_('tables that fit with room to spare are never banked', cmp(mappedOnly).usage.banked.assets.length === 0);
  // the "does not fit" message names tables: code too big with everything banked
  const stm = (i) => `      a(${i % 50}) = a(${i % 50}) + ${i}\n`;
  const bulk = G('DIM a(60), b\nTABLE lv\n  b = 1\nENDTABLE\n', '    LOADTABLE lv\n' + Array.from({ length: 1800 }, (_, i) => `    IF a(1) = ${i} THEN a(${i % 50}) = a(${i % 50}) + ${i}\n    ENDIF\n`).join(''));
  const nb = cmp(bulk);
  check_('the "does not fit" message names tables when the game has some', nb.errors.length === 1 && /the game does not fit: mapped part [\d,]+ of 16,384 bytes after banking every map, world, plan and table \(code \d+, sprites 0, tables 0\)/.test(nb.errors[0].message), errText(nb).slice(0, 300));
}

// =================================================================================================================
// 7. Linker and DCK
// =================================================================================================================
console.log('\n7. The linker and the DCK: the record read back through the fixups, mapped and banked');
{
  const src = G('DIM a(3), b, c, d\nTABLE lv0\n  a = 1, 2\n  b = 3\nENDTABLE\nTABLE lv1\n  c = 4\n  d = 5\nENDTABLE\n', '    LOADTABLE lv1\n    LOADTABLE lv0\n');
  const read = (o, key) => { const f = o.gen.fixups.find((x) => x.key === key); return rd16(o.memory, f.at); };
  const o = cmp(src);
  const t0 = o.gen.tables.find((t) => t.name === 'lv0'), t1 = o.gen.tables.find((t) => t.name === 'lv1');
  const a0 = read(o, 'table:game.LV0'), a1 = read(o, 'table:game.LV1');
  check_('mapped: both records are in the image where the code points, byte for byte; lv0 first, then lv1, packed', sameBytes([...o.memory.slice(a0, a0 + t0.data.length)], [...t0.data]) && sameBytes([...o.memory.slice(a1, a1 + t1.data.length)], [...t1.data]) && a1 === a0 + t0.data.length, `${hex(a0)} ${hex(a1)}`);
  check_('... in the mapped part, past the code (nothing under the code)', a0 === o.gen.base + o.gen.code.length, `${hex(a0)} vs ${hex(o.gen.base + o.gen.code.length)}`);
  const ob = cmp(src, 2, ASSETS11, { opts: { bankAll: true } });
  const b0 = read(ob, 'table:game.LV0'), b1 = read(ob, 'table:game.LV1');
  check_('bankAll: the records are in the window $4000.. and the code points there', b0 >= 0x4000 && b1 >= 0x4000 && b0 < 0x8000 && sameBytes([...ob.memory.slice(b0, b0 + t0.data.length)], [...t0.data]) && sameBytes([...ob.memory.slice(b1, b1 + t1.data.length)], [...t1.data]), `${hex(b0)} ${hex(b1)}`);
  const big = t0.data.length >= t1.data.length ? b0 : b1, little = big === b0 ? b1 : b0;
  check_('... largest first: the bigger record is at $4000, the other right after it', big === 0x4000 && little === 0x4000 + (big === b0 ? t0.data.length : t1.data.length), `${hex(b0)} ${hex(b1)} ${t0.data.length} ${t1.data.length}`);
  // DCK read-back: chunk 2 of the DCK holds the window
  const dck = ob.dck;
  check_('the DCK ships chunk 2 when a table is banked, and its first bytes are the record', ob.shipped.includes(2) && dck.length === 9 + 5 * 8192, `${dck.length}`);
  const chunk2 = dck.slice(9 + 2 * 8192, 9 + 3 * 8192);   // chunks 0, 1, 2, 4, 5 in order: index 2 is chunk 2
  const first = b0 === 0x4000 ? t0 : t1;
  check_('... chunk 2 starts with the banked record of the window\'s first entry, the rest of the chunk is $FF', sameBytes([...chunk2.slice(0, first.data.length)], [...first.data]) && chunk2[8191] === 0xFF);
  // a banked and a mapped table in one game; the pointer list of an index LOADTABLE has both kinds of address
  const maps = mapDecls(Array.from({ length: 20 }, (_, i) => i), 'm', (i) => `s${i}`);
  const mixed = plain2(maps + 'DIM a(80), b(900)\nTABLE small\n  a = 1, 2, 3\nENDTABLE\nTABLE large\n  b = ' + Array.from({ length: 901 }, () => 4).join(', ') + '\nENDTABLE\n', '    LOADMAP m0\n    LOADTABLE v\n');
  const om = cmp(mixed);
  check_('a banked and a mapped table in one game compile', om.errors.length === 0 && om.usage.banked.assets.length === 1, errText(om));
  const ptr = om.gen.fixups.map((f) => [f.key, rd16(om.memory, f.at)]);
  const lg = om.gen.tables.find((t) => t.name === 'large'), sm = om.gen.tables.find((t) => t.name === 'small');
  check_('... the pointer list holds a mapped address for small and a window address for large, in source order', ptr[0][0] === 'table:game.SMALL' && ptr[0][1] >= 0x8000 && ptr[1][0] === 'table:game.LARGE' && ptr[1][1] === 0x4000 && sameBytes([...om.memory.slice(ptr[1][1], ptr[1][1] + lg.data.length)], [...lg.data]) && sameBytes([...om.memory.slice(ptr[0][1], ptr[0][1] + sm.data.length)], [...sm.data]), JSON.stringify(ptr.map((p) => [p[0], hex(p[1])])));
  // determinism
  const again = cmp(src);
  check_('the same source compiles to the same image twice', sameBytes(o.memory, again.memory) && sameBytes(o.dck, again.dck));
  // a runtime table with RT_LOADMAPPTR absent still banks tables
  const noPtr = fake(2, { symbols: { RT_LOADMAPPTR: undefined } });
  const onp = cmp(src, 2, ASSETS11, { R: noPtr, opts: { bankAll: true } });
  check_('banking tables does not need RT_LOADMAPPTR (RT_TABLELOAD reads the window itself)', onp.errors.length === 0 && onp.usage.banked.assets.length === 2, errText(onp));
}

// =================================================================================================================
// 8. Byte identity with the previous compiler
// =================================================================================================================
console.log('\n8. Programs with no TABLE compile to exactly the bytes of the previous compiler');
{
  const OLD_DEFAULT = '/tmp/claude-1000/-home-charlie-day-Projects-Leap-IDE/25a39a3e-7287-4816-b35a-0a3748c570ea/scratchpad/headsrc/src/lang/arcade';
  const oldDir = process.env.ARCADE_OLD ?? (existsSync(join(OLD_DEFAULT, 'arcade-compile.js')) ? OLD_DEFAULT : null);
  if (!oldDir) skip_('byte identity against the previous compiler', 'set ARCADE_OLD to a copy of the previous src/lang/arcade/ (git archive HEAD src)');
  else {
    const oldCompile = (await import(pathToFileURL(join(oldDir, 'arcade-compile.js')).href)).compile;
    const progs = [];
    for (const d of ['arcade/examples', 'arcade/tests/fixtures']) {
      if (!existsSync(join(ROOT, d))) continue;
      for (const f of readdirSync(join(ROOT, d)).filter((x) => x.endsWith('.arc')).sort()) {
        const aj = join(ROOT, d, f.replace('.arc', '.assets.json'));
        progs.push({ src: `${d}/${f}`, text: readFileSync(join(ROOT, d, f), 'utf8'), assets: existsSync(aj) ? JSON.parse(readFileSync(aj, 'utf8')) : undefined });
      }
    }
    const { genV3, genV4 } = await import('./arcade-m9-common.mjs');
    const { ASSETS: A9 } = await import('./arcade-m9-common.mjs');
    for (let seed = 1; seed <= 6; seed++) { const g3 = genV3(seed), g4 = genV4(seed); progs.push({ src: `genV3(${seed})`, text: g3.src, assets: g3.assets ?? A9 }, { src: `genV4(${seed})`, text: g4.src, assets: g4.assets ?? A9 }); }
    const targets = [['real v2', REAL[2]], ['real v3', REAL[3]], ['real v4', REAL[4]]].filter(([, R]) => R);
    const eqb = (x, y) => (!x && !y) || (!!x && !!y && sameBytes(x, y));
    let n = 0, same = 0, built = 0, bad = '';
    const sans = (u) => (u ? JSON.stringify({ ...u, codegen: undefined }) : '');
    for (const p of progs) for (const [tn, R] of targets) {
      for (const bankAll of [false, true]) {
        const o = oldCompile(p.text, { runtime: R.rt, image: R.img, assets: p.assets, bankAll }), w = compile(p.text, { runtime: R.rt, image: R.img, assets: p.assets, bankAll });
        n++;
        const ok = eqb(o.memory, w.memory) && eqb(o.dck, w.dck) && JSON.stringify(o.errors) === JSON.stringify(w.errors) && JSON.stringify(o.warnings) === JSON.stringify(w.warnings)
          && (!o.gen || sameBytes(o.gen.code, w.gen.code)) && sans(o.usage) === sans(w.usage) && (!o.gen || JSON.stringify(o.gen.fixups) === JSON.stringify(w.gen.fixups)) && JSON.stringify(o.map?.banked) === JSON.stringify(w.map?.banked);
        if (ok) { same++; if (w.memory) built++; } else bad += `${p.src} on ${tn}${bankAll ? ' (bankAll)' : ''}; `;
      }
    }
    check_(`${progs.length} programs (every example, every fixture, the generated v3 / v4 programs) on ${targets.length} runtime tables, normal and bankAll: ${n} compilations: image, DCK, code, errors, warnings, usage, fixups and the banked list are identical`, same === n && n > 0, bad);
    info(`byte identity: ${n} compilations compared, ${same} identical, ${built} of them built a cartridge`);
    check_('and a good number of them built a cartridge (the comparison is not all errors)', built >= 20, `${built}`);
    const exs = progs.filter((p) => p.src.startsWith('arcade/examples/'));
    check_('the examples are among them (bounce, breakout, shooter, platformer, runner, vaults, blockfall ...)', exs.length >= 8, `${exs.length}`);
  }
}

// =================================================================================================================
// 9. The real runtime tables
// =================================================================================================================
console.log('\n9. Tables against the runtime tables as they are in the tree');
{
  const src = G('DIM a(3), v\nTABLE lv\n  a = 1, 2\nENDTABLE\n', '    LOADTABLE lv\n    LOADTABLE v\n');
  for (const v of [2, 3, 4]) {
    const R = REAL[v];
    if (!R) { skip_(`v${v} tables against the tree's runtime`, `arcade/build/v${v}/runtime.json is missing`); continue; }
    if (R.rt.symbols.RT_TABLELOAD === undefined) {
      const o = compile(src, { runtime: R.rt, image: R.img, assets: ASSETS11 });
      check_(`v${v}: the tree's runtime.json has no RT_TABLELOAD yet (slice T1 not built): LOADTABLE is refused with the message that says to rebuild the runtime`, o.errors.length >= 1 && o.errors.every((e) => /RT_TABLELOAD/.test(e.message) && /rebuild the runtime/.test(e.message)), errText(o));
      continue;
    }
    const o = compile(src, { runtime: R.rt, image: R.img, assets: ASSETS11 });
    check_(`v${v}: compiles against the tree's runtime.json and calls RT_TABLELOAD at ${hex(R.rt.symbols.RT_TABLELOAD)}`, o.errors.length === 0 && o.gen.fixups.length >= 1 && rd16(o.memory, o.gen.fixups[0].at + 3) === R.rt.symbols.RT_TABLELOAD, errText(o));
    const ob = compile(src, { runtime: R.rt, image: R.img, assets: ASSETS11, bankAll: true });
    check_(`v${v}: and with the table banked`, ob.errors.length === 0 && ob.usage.banked.assets.length === 1 && ob.shipped.join() === '0,1,2,4,5', errText(ob));
  }
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}: ${passed} checks passed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed === 0 ? 0 : 1);
