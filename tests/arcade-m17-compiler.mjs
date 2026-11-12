#!/usr/bin/env node
"use strict";
// arcade-m17-compiler.mjs -- tests for the compiler side of the wireframe 3D (slices W3a and W3b): docs/ARCADE_WIREFRAME_CONTRACT.md section 1 (the language), items 9 (errors and warnings) and 10 (the runtime choice), then
// the code generator and the linker (sections 3.2, 3.3, 4, 5).
//
//   node tests/arcade-m17-compiler.mjs          (ARCADE_M17_OLD=<git ref> ARCADE_M17_GIT=<repository> change the compiler section 6 compares with; default 82b1cab, the tree before the code generator)
//
// No machine is booted. Sections
//   1  parser: every form, its node shape, clauses in any order, contextual words as variable names, reserved words naming assets, parse errors
//   2  checker: every error and warning of item 9 with its line, NOVIEW in a WIRE3D / VIEW3D / plain game, COSA SINA FXMUL on v2, v3 and v4, WIRE3D on v2 only
//   3  word tables: the new entries, the help text of COSA SINA FXMUL, scan
//   4  requiredRuntime: the examples (unchanged) and small programs
//   5  code generation and the linker: the header (DIV_WIRE, wire_desc), the model images, the argument order of EYE / DRAWMODEL / LINE, the NOVIEW switch calls, COSA SINA FXMUL on v2, asset
//      errors at the MODEL line, a runtime without the entries, the 45-phase limit (on a mock of the W2 runtime where RT_WIREMODE is needed)
//   6  byte identity: every example and fixture compiles to the bytes of the compiler before the code generator (git archive)
import { readFileSync, existsSync, readdirSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse, tokenize } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { compile, requiredRuntime } from '../src/lang/arcade/arcade-compile.js';
import { ARCADE_WORDS, RESERVED, ASSET_KINDS, LIMITS, BATCH11_WORDS } from '../src/lang/arcade/arcade-words.js';
import { scanArcade } from '../src/lang/arcade/arcade-scan.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const skip_ = (name, why) => { console.log(`  SKIP  ${name}  (${why})`); skipped++; };
const eq = (name, got, want) => check_(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);

// ── source helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
const HEAD = 'GAME "w"\nFRAMERATE 20\nWIRE3D ROWS 2 TO 21 INK 5 PAPER 0 BRIGHT 1\nMODEL gate = "gate"\nMODEL rock = "rock"\n';
const game = (frame, { head = HEAD, init = '', decl = 'DIM t, x, y, z\n', mode = '' } = {}) => `${head}${decl}SCENE s${mode}\n  PROC INIT()\n${init}  ENDP\n  PROC FRAME()\n    t = t + 1\n${frame}  ENDP\nENDSCENE\n`;
const diag = (src, version) => { const p = parse(src); return [...p.errors, ...check(p.ast, version === undefined ? undefined : { version })]; };
const errs = (src, v) => diag(src, v).filter((d) => d.severity === 'error');
const warns = (src, v) => diag(src, v).filter((d) => d.severity === 'warning');
const msgs = (l) => l.map((d) => `${d.line}:${d.col} ${d.message}`).join(' | ');
const at = (src, needle, nth = 0) => {
  let from = -1;
  for (let i = 0; i <= nth; i++) { from = src.indexOf(needle, from + 1); if (from < 0) throw new Error(`test bug: "${needle}" #${nth} not in the source`); }
  const before = src.slice(0, from).split('\n');
  return { line: before.length, col: before[before.length - 1].length };
};
const okSrc = (name, src, v) => { const e = errs(src, v); check_(name, e.length === 0, msgs(e)); };
/** An error with exactly this message at the position of `needle` in the source. */
const badAt = (name, src, msg, needle, nth = 0, v) => {
  const where = at(src, needle, nth), e = errs(src, v), hit = e.find((d) => d.message === msg && d.line === where.line && d.col === where.col);
  check_(name, !!hit, hit ? '' : msgs(e) || 'no errors');
};
/** An error whose message contains `part`, on the line of `needle`. */
const badOn = (name, src, part, needle, nth = 0, v) => {
  const where = at(src, needle, nth), e = errs(src, v), hit = e.find((d) => d.message.includes(part) && d.line === where.line);
  check_(name, !!hit, hit ? '' : msgs(e) || 'no errors');
};
const warnOn = (name, src, part, needle, nth = 0, v) => {
  const where = at(src, needle, nth), w = warns(src, v), hit = w.find((d) => d.message.includes(part) && d.line === where.line);
  check_(name, !!hit && errs(src, v).length === 0, `${msgs(w)} || errors: ${msgs(errs(src, v))}`);
};
const noWarn = (name, src, v) => { const w = warns(src, v).filter((d) => !/^variable '\w+' is never used/.test(d.message)); check_(name, w.length === 0 && errs(src, v).length === 0, `${msgs(w)} || errors: ${msgs(errs(src, v))}`); };

// =================================================================================================================
// 1. Parser
// =================================================================================================================
console.log('1. parser');
{
  const src = game('    EYE x, 0, 5 * 2, t\n    DRAWMODEL gate AT x, y, z\n    DRAWMODEL rock AT 1, -2, 3 YAW t * 3 PITCH t SCALE 2\n    LINE 120, 96 TO 136, 96\n');
  const p = parse(src);
  eq('the full example parses with no error', p.errors, []);
  const w = p.ast.wires[0];
  check_('WIRE3D: node Wire3d, in program.wires and program.items', w?.type === 'Wire3d' && p.ast.items.includes(w) && p.ast.wires.length === 1);
  check_('WIRE3D: r0 r1 ink paper bright are expression nodes', w.r0.value === 2 && w.r1.value === 21 && w.ink.value === 5 && w.paper.value === 0 && w.bright.value === 1);
  eq('WIRE3D: clausePos has ink, paper and bright', Object.keys(w.clausePos), ['ink', 'paper', 'bright']);
  const m = p.ast.assets.filter((a) => a.kind === 'MODEL');
  eq('MODEL: two Asset nodes of kind MODEL with name and asset', m.map((a) => [a.type, a.name, a.asset]), [['Asset', 'gate', 'gate'], ['Asset', 'rock', 'rock']]);
  const body = p.ast.scenes[0].procs[1].body;
  const eye = body.find((s) => s.type === 'Eye'), dm = body.filter((s) => s.type === 'DrawModel'), ln = body.find((s) => s.type === 'Line');
  check_('EYE: node Eye {x, y, z, a}', !!eye && eye.x.type === 'Ident' && eye.y.value === 0 && eye.z.type === 'Binary' && eye.a.type === 'Ident');
  check_('DRAWMODEL without clauses: yaw, pitch, scale null; model is an Ident', dm[0].model.type === 'Ident' && dm[0].model.name === 'gate' && dm[0].yaw === null && dm[0].pitch === null && dm[0].scale === null && dm[0].x.type === 'Ident');
  check_('DRAWMODEL with YAW PITCH SCALE', dm[1].yaw.type === 'Binary' && dm[1].pitch.type === 'Ident' && dm[1].scale.value === 2 && dm[1].y.type === 'Unary' && Object.keys(dm[1].clausePos).join() === 'yaw,pitch,scale');
  check_('LINE: node Line {x0, y0, x1, y1}', ln?.x0.value === 120 && ln.y0.value === 96 && ln.x1.value === 136 && ln.y1.value === 96);
}
{
  const p = parse(game('    DRAWMODEL gate AT 0, 0, 0 SCALE 4 PITCH 1 YAW 2\n'));
  const d = p.ast.scenes[0].procs[1].body.find((s) => s.type === 'DrawModel');
  check_('DRAWMODEL: the clauses come in any order', p.errors.length === 0 && d.yaw.value === 2 && d.pitch.value === 1 && d.scale.value === 4, msgs(p.errors));
}
{
  const p = parse('GAME "w"\nWIRE3D ROWS 0 TO 23\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n');
  const w = p.ast.wires[0];
  check_('WIRE3D with no colour clause: ink, paper, bright null', p.errors.length === 0 && w.ink === null && w.paper === null && w.bright === null && w.clausePos && Object.keys(w.clausePos).length === 0);
  const q = parse('GAME "w"\nWIRE3D ROWS 2 TO 9 BRIGHT 0 INK 3\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n');
  check_('WIRE3D: INK PAPER BRIGHT in any order', q.errors.length === 0 && q.ast.wires[0].bright.value === 0 && q.ast.wires[0].ink.value === 3 && q.ast.wires[0].paper === null, msgs(q.errors));
}
// parse errors, with the line they are on
const perr = (name, src, part, line) => { const p = parse(src); const hit = p.errors.find((d) => d.message.includes(part) && (line === undefined || d.line === line)); check_(name, !!hit, hit ? '' : msgs(p.errors) || 'no errors'); };
perr('WIRE3D without ROWS', 'GAME "w"\nWIRE3D 2 TO 21\n', 'WIRE3D needs the rows', 2);
perr('WIRE3D ROWS without TO', 'GAME "w"\nWIRE3D ROWS 2, 21\n', 'expected TO', 2);
perr('WIRE3D with INK twice', 'GAME "w"\nWIRE3D ROWS 2 TO 21 INK 1 INK 2\n', 'at most one INK', 2);
perr('WIRE3D in a PROC', game('    WIRE3D ROWS 2 TO 21\n'), 'WIRE3D must be at the top level, outside any PROC');
perr('WIRE3D in a SCENE (outside a PROC)', 'GAME "w"\nSCENE s\n  WIRE3D ROWS 2 TO 21\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n', 'WIRE3D must be at the top level, outside any SCENE', 3);
perr('MODEL without the asset', 'GAME "w"\nMODEL gate\n', "expected '='", 2);
perr('MODEL with a pool size', 'GAME "w"\nMODEL gate(2) = "gate"\n', 'only a SPRITE can have a pool size', 2);
perr('EYE with three values', game('    EYE 1, 2, 3\n'), "expected ',' : EYE x, y, z, a");
perr('DRAWMODEL without AT', game('    DRAWMODEL gate 1, 2, 3\n'), 'expected AT');
perr('DRAWMODEL with two coordinates', game('    DRAWMODEL gate AT 1, 2\n'), "expected ',' : DRAWMODEL");
perr('DRAWMODEL with YAW twice', game('    DRAWMODEL gate AT 1, 2, 3 YAW 1 YAW 2\n'), 'at most one YAW');
perr('DRAWMODEL with a number for the model', game('    DRAWMODEL 3 AT 1, 2, 3\n'), 'expected a model name');
perr('LINE without TO', game('    LINE 1, 2, 3, 4\n'), 'expected TO: LINE');

// contextual words are ordinary names
okSrc('a variable called yaw, pitch, scale and rows is legal', game('    yaw = 1 : pitch = yaw + 1 : scale = pitch : rows = scale\n    DRAWMODEL gate AT x, y, z YAW yaw PITCH pitch SCALE 2\n', { decl: 'DIM t, x, y, z, yaw, pitch, scale, rows\n' }), 2);
{
  const p = parse('DIM yaw, pitch, scale, rows\n');
  check_('the contextual words tokenize as idents, the new words as keywords', ['YAW', 'PITCH', 'SCALE', 'ROWS'].every((w) => tokenize(w).find((t) => t.value === w).type === 'ident') && ['WIRE3D', 'MODEL', 'EYE', 'DRAWMODEL', 'LINE'].every((w) => tokenize(w).find((t) => t.value === w).type === 'keyword') && p.errors.length === 0);
}
// the new words may still name an asset in a declaration (BATCH11_WORDS), but not a variable
{
  const src = 'GAME "w"\nWIRE3D ROWS 2 TO 21\nMODEL eye = "eye"\nSFX line = "line"\nMODEL model = "m"\nSCENE s\n  PROC INIT()\n    PLAY line\n    DRAWMODEL eye AT 0, 0, 0\n    DRAWMODEL model AT 0, 0, 0\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n';
  const p = parse(src);
  eq('MODEL eye / SFX line / MODEL model, PLAY line, DRAWMODEL eye / model parse', p.errors, []);
  check_('the five new words are in BATCH11_WORDS', ['WIRE3D', 'MODEL', 'EYE', 'DRAWMODEL', 'LINE'].every((w) => BATCH11_WORDS.has(w) && RESERVED.has(w)));
  const e = errs(src, 2);
  check_('they check: the model name space is its own (eye is a MODEL, line an SFX)', e.length === 0, msgs(e));
  badOn('a variable called eye is refused', game('    eye = 1\n', { decl: 'DIM t, eye\n' }), 'reserved word', 'DIM t, eye', 0, 2);
}

// =================================================================================================================
// 2. Checker
// =================================================================================================================
console.log('\n2. checker');
okSrc('the contract example checks on the v2 runtime', game('    EYE x, 0, z, t\n    DRAWMODEL gate AT x, 0, z YAW t\n    DRAWMODEL rock AT x, y, z YAW t * 3 PITCH t SCALE 2\n    LINE 120, 96 TO 136, 96\n'), 2);
okSrc('... and with no version given', game('    EYE x, 0, z, t\n    DRAWMODEL gate AT x, 0, z YAW t\n    LINE 120, 96 TO 136, 96\n'));
noWarn('... with no warning (a MODEL used, rows drawn outside the play area)', game('    EYE x, 0, z, t\n    DRAWMODEL gate AT x, 0, z\n    DRAWMODEL rock AT x, 0, z\n    PRINT AT 0, 0; "score"\n    PRINT AT 22, 0; "lives"\n    TILE 3, 23 = 1\n'), 2);

// WIRE3D itself
{
  const s = HEAD + 'WIRE3D ROWS 3 TO 20\n' + 'SCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n  ENDP\nENDSCENE\n';
  badAt('WIRE3D twice', s, 'WIRE3D may appear only once (the first is on line 3)', 'WIRE3D ROWS 3', 0, 2);
}
const W = (rows) => game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n', { head: `GAME "w"\nFRAMERATE 20\nWIRE3D ${rows}\nMODEL gate = "gate"\nMODEL rock = "rock"\n` });
okSrc('WIRE3D ROWS 0 TO 23', W('ROWS 0 TO 23'), 2);
okSrc('WIRE3D ROWS 20 TO 23 (4 rows)', W('ROWS 20 TO 23'), 2);
okSrc('WIRE3D ROWS 2 TO 5 (4 rows)', W('ROWS 2 TO 5'), 2);
okSrc('WIRE3D rows from CONSTs', game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n', { head: 'GAME "w"\nCONST top = 2\nWIRE3D ROWS top TO top + 19\nMODEL gate = "gate"\nMODEL rock = "rock"\n' }), 2);
badOn('rows: first row negative', W('ROWS -1 TO 10'), 'first row is -1', 'WIRE3D ROWS -1', 0, 2);
badOn('rows: first row 21 (fewer than 4 rows fit)', W('ROWS 21 TO 23'), 'first row is 21', 'WIRE3D ROWS 21', 0, 2);
badOn('rows: last row 24', W('ROWS 2 TO 24'), 'last row is 24', 'WIRE3D ROWS 2', 0, 2);
badAt('rows: fewer than 4 rows (2 TO 4)', W('ROWS 2 TO 4'), 'WIRE3D ROWS 2 TO 4: the play area needs at least 4 rows (the last row must be at least 5)', '4\nMODEL gate', 0, 2);
badOn('rows: last row before the first', W('ROWS 10 TO 3'), 'at least 4 rows', 'WIRE3D ROWS 10', 0, 2);
badOn('rows: not constant', game('', { head: 'GAME "w"\nDIM n\nWIRE3D ROWS n TO 21\n' }), 'constant', 'WIRE3D ROWS n', 0, 2);
badOn('colour: INK 8', W('ROWS 2 TO 21 INK 8'), 'INK is 8: it must be 0..7', 'WIRE3D ROWS 2 TO 21 INK 8', 0, 2);
badOn('colour: PAPER -1', W('ROWS 2 TO 21 PAPER -1'), 'PAPER is -1: it must be 0..7', 'WIRE3D ROWS 2 TO 21 PAPER', 0, 2);
badOn('colour: BRIGHT 2', W('ROWS 2 TO 21 BRIGHT 2'), 'BRIGHT is 2: it must be 0..1', 'WIRE3D ROWS 2 TO 21 BRIGHT', 0, 2);
okSrc('colours INK 0 PAPER 7 BRIGHT 0', W('ROWS 2 TO 21 INK 0 PAPER 7 BRIGHT 0'), 2);

// with a WINDOW or a VIEW3D
{
  const mapAsset = 'MAP level = "level"\n';
  const win = game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n', { head: HEAD + mapAsset + 'WINDOW level\n' });
  badOn('WIRE3D with a WINDOW', win, 'WIRE3D cannot be used in a program with a WINDOW (line 7)', 'WIRE3D ROWS', 0, 3);
  const view = game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n', { head: HEAD + mapAsset + 'VIEW3D level\n' });
  badOn('WIRE3D with a VIEW3D', view, 'WIRE3D cannot be used in a program with a VIEW3D (line 7)', 'WIRE3D ROWS', 0, 4);
  badOn('WIRE3D with a WINDOW (no version given)', win, 'WIRE3D cannot be used in a program with a WINDOW', 'WIRE3D ROWS');
  badOn('WIRE3D with a VIEW3D (no version given)', view, 'WIRE3D cannot be used in a program with a VIEW3D', 'WIRE3D ROWS');
}

// MODEL
badOn('MODEL without WIRE3D', game('', { head: 'GAME "w"\nMODEL gate = "gate"\n' }), "MODEL 'gate' needs a WIRE3D", 'MODEL gate', 0, 2);
badOn('MODEL declared twice', game('    DRAWMODEL gate AT 0, 0, 0\n', { head: HEAD + 'MODEL gate = "other"\n' }), "'gate' is already declared (line 4)", 'MODEL gate = "other"', 0, 2);
{
  const many = (n) => 'GAME "w"\nWIRE3D ROWS 2 TO 21\n' + Array.from({ length: n }, (_, i) => `MODEL m${i} = "m${i}"\n`).join('') + 'SCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n' + Array.from({ length: n }, (_, i) => `    DRAWMODEL m${i} AT 0, 0, 0\n`).join('') + '  ENDP\nENDSCENE\n';
  check_(`${LIMITS.maxModels} models are fine`, errs(many(32), 2).length === 0, msgs(errs(many(32), 2)));
  badOn('the 33rd model is refused', many(33), 'too many models (at most 32)', 'MODEL m32', 0, 2);
}
warnOn('a MODEL never drawn', game('    DRAWMODEL gate AT 0, 0, 0\n'), "MODEL 'rock' is never used", 'MODEL rock', 0, 2);

// DRAWMODEL / EYE / LINE without WIRE3D
{
  const plain = (stmt) => `GAME "w"\nDIM t\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n${stmt}  ENDP\nENDSCENE\n`;
  badOn('EYE without WIRE3D', plain('    EYE 0, 0, 0, 0\n'), 'EYE needs a WIRE3D', 'EYE 0', 0, 2);
  badOn('DRAWMODEL without WIRE3D', plain('    DRAWMODEL gate AT 0, 0, 0\n'), 'DRAWMODEL needs a WIRE3D', 'DRAWMODEL gate', 0, 2);
  badOn('LINE without WIRE3D', plain('    LINE 0, 0 TO 8, 8\n'), 'LINE needs a WIRE3D', 'LINE 0', 0, 2);
  badOn('EYE without WIRE3D (no version given)', plain('    EYE 0, 0, 0, 0\n'), 'EYE needs a WIRE3D', 'EYE 0');
}
// DRAWMODEL of what is not a model
{
  const s = (name) => game(`    DRAWMODEL ${name} AT 0, 0, 0\n`, { head: HEAD + 'SFX boom = "boom"\n' });
  badOn('DRAWMODEL of an undeclared name', s('nothing'), "'nothing' is not a declared MODEL: add MODEL nothing = \"...\"", 'DRAWMODEL nothing', 0, 2);
  badOn('DRAWMODEL of an SFX', s('boom'), "'boom' is a SFX, not a MODEL", 'DRAWMODEL boom', 0, 2);
  badOn('DRAWMODEL of a variable', s('x'), "'x' is a variable, not a MODEL", 'DRAWMODEL x', 0, 2);
  badOn('DRAWMODEL with a model index in brackets', game('    DRAWMODEL gate(1) AT 0, 0, 0\n'), 'AT', 'DRAWMODEL gate(1)', 0, 2);
}
// SCALE
okSrc('SCALE 1 2 4 8', game([1, 2, 4, 8].map((k) => `    DRAWMODEL gate AT 0, 0, 0 SCALE ${k}\n`).join('') + '    DRAWMODEL rock AT 0, 0, 0\n'), 2);
okSrc('SCALE from a CONST', game('    DRAWMODEL gate AT 0, 0, 0 SCALE big\n    DRAWMODEL rock AT 0, 0, 0\n', { decl: 'CONST big = 4\nDIM t\n' }), 2);
for (const k of [0, 3, 16]) badOn(`SCALE ${k} is refused`, game(`    DRAWMODEL gate AT 0, 0, 0 SCALE ${k}\n    DRAWMODEL rock AT 0, 0, 0\n`), `SCALE is ${k}: it must be a constant 1, 2, 4 or 8`, 'DRAWMODEL gate', 0, 2);
badOn('SCALE a variable is refused', game('    DRAWMODEL gate AT 0, 0, 0 SCALE t\n    DRAWMODEL rock AT 0, 0, 0\n'), 'SCALE must be a constant expression', 'DRAWMODEL gate', 0, 2);
badOn('DRAWMODEL with a string coordinate', game('    DRAWMODEL gate AT "a", 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n'), 'x must be a number', 'DRAWMODEL gate', 0, 2);
badOn('EYE with an undeclared variable', game('    EYE nothing, 0, 0, 0\n    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n'), "'nothing' is not declared", 'EYE nothing', 0, 2);

// warnings: DRAWMODEL / LINE directly in INIT
warnOn('DRAWMODEL in a scene INIT', game('    DRAWMODEL rock AT 0, 0, 0\n', { init: '    DRAWMODEL gate AT 0, 0, 0\n' }), 'DRAWMODEL in PROC INIT is wiped', '    DRAWMODEL gate', 0, 2);
warnOn('LINE in a scene INIT', game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n', { init: '    IF t = 0 THEN\n      LINE 0, 0 TO 5, 5\n    ENDIF\n' }), 'LINE in PROC INIT is wiped', 'LINE 0', 0, 2);
noWarn('EYE in INIT is fine (it is stored)', game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n', { init: '    EYE 0, 0, 0, 0\n' }), 2);
noWarn('DRAWMODEL in FRAME is fine', game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n'), 2);
// warnings: PRINT AT / TILE inside the play area
warnOn('PRINT AT with a row inside the play area', game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n    PRINT AT 10, 3; "hi"\n'), 'PRINT AT row 10 is inside the WIRE3D play area (rows 2..21)', 'PRINT AT 10', 0, 2);
warnOn('PRINT AT on the first row of the play area', game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n    PRINT AT 2, 3; "hi"\n'), 'row 2 is inside', 'PRINT AT 2', 0, 2);
warnOn('PRINT AT on the last row of the play area', game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n    PRINT AT 21, 3; "hi"\n'), 'row 21 is inside', 'PRINT AT 21', 0, 2);
warnOn('TILE with a row inside the play area', game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n    TILE 4, 12 = 1\n'), 'TILE row 12 is inside the WIRE3D play area', 'TILE 4', 0, 2);
warnOn('PRINT AT with a CONST row inside the play area', game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n    PRINT AT mid, 3; "hi"\n', { decl: 'CONST mid = 9\nDIM t\n' }), 'row 9 is inside', 'PRINT AT mid', 0, 2);
noWarn('PRINT AT with a row outside, and with a variable row', game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n    PRINT AT 1, 3; "hi"\n    PRINT AT 22, 3; "hi"\n    PRINT AT t, 0; "hi"\n'), 2);
noWarn('PRINT AT inside the area is fine in a NOVIEW scene', game('    PRINT AT 10, 3; "menu"\n    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n', { mode: ' NOVIEW' }), 2);
noWarn('PRINT AT with a row in a game without a WIRE3D', 'GAME "w"\nDIM t\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    PRINT AT 10, 3; "hi"\n  ENDP\nENDSCENE\n', 2);

// NOVIEW
console.log('  -- NOVIEW');
{
  const body = '    EYE 0, 0, 0, 0\n    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n';
  const scenes = `SCENE title NOVIEW\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    IF KEYDOWN(13) THEN\n      ENTER play\n    ENDIF\n  ENDP\nENDSCENE\nSCENE play\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n${body}    IF KEYDOWN(1) THEN\n      ENTER title\n    ENDIF\n  ENDP\nENDSCENE\n`;
  okSrc('SCENE name NOVIEW in a WIRE3D game', HEAD + scenes, 2);
  check_('... the Scene node has mode noview and a modePos', (() => { const sc = parse(HEAD + scenes).ast.scenes[0]; return sc.mode === 'noview' && sc.modePos?.line === 6; })());
  const vmap = 'GAME "v"\nMAP level = "level"\nVIEW3D level\n';
  okSrc('SCENE name NOVIEW in a VIEW3D game (unchanged)', vmap + 'SCENE s NOVIEW\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n', 4);
  const plain = 'GAME "p"\nSCENE s NOVIEW\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n';
  badAt('NOVIEW in a plain game', plain, "SCENE 's' NOVIEW: NOVIEW needs a VIEW3D or a WIRE3D in the game (a scene without the 3D view only makes sense where the other scenes have one)", 'NOVIEW', 0, 2);
  const win = 'GAME "p"\nMAP level = "level"\nWINDOW level\nSCENE s NOVIEW\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n';
  badAt('NOVIEW in a WINDOW game (unchanged)', win, "SCENE 's' NOVIEW: NOVIEW is for a game with a VIEW3D, and this game has a WINDOW (line 3): use NOWINDOW", 'NOVIEW', 0, 3);
  badAt('NOWINDOW in a WIRE3D game', HEAD.replace('MODEL rock = "rock"\n', '') + 'SCENE s NOWINDOW\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    DRAWMODEL gate AT 0, 0, 0\n  ENDP\nENDSCENE\n', "SCENE 's' NOWINDOW: NOWINDOW is for a game with a WINDOW, and this game has a WIRE3D (line 3): use NOVIEW", 'NOWINDOW', 0, 2);
  badAt('NOWINDOW in a VIEW3D game (unchanged)', vmap + 'SCENE s NOWINDOW\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n', "SCENE 's' NOWINDOW: NOWINDOW is for a game with a WINDOW, and this game has a VIEW3D (line 3): use NOVIEW", 'NOWINDOW', 0, 4);
  badAt('NOWINDOW in a plain game (unchanged)', plain.replace('NOVIEW', 'NOWINDOW'), "SCENE 's' NOWINDOW: NOWINDOW needs a WINDOW in the game (a scene without the window only makes sense where the other scenes have one)", 'NOWINDOW', 0, 2);
  eq('a variable called noview stays legal', errs('GAME "p"\nDIM noview, nowindow\nSCENE s\n  PROC INIT()\n    noview = 1 : nowindow = noview\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n', 2).map((d) => d.message), []);
}

// the version
console.log('  -- runtime versions');
{
  const s = game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n');
  for (const v of [3, 4]) badOn(`WIRE3D is refused on the v${v} runtime`, s, `WIRE3D needs the v2 runtime (the v${v} runtime has no wireframe 3D)`, 'WIRE3D ROWS', 0, v);
  okSrc('WIRE3D is fine on v2', s, 2);
  okSrc('WIRE3D is fine when no version is given', s);
  const c = (call) => `GAME "c"\nDIM a\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    a = ${call}\n  ENDP\nENDSCENE\n`;
  for (const call of ['COSA(a)', 'SINA(a + 3)', 'FXMUL(a, 7)']) {
    okSrc(`${call} is allowed on v2`, c(call), 2);
    okSrc(`${call} is allowed on v4`, c(call), 4);
    okSrc(`${call} is allowed when no version is given`, c(call));
    badOn(`${call} is refused on v3: needs the v2 or v4 runtime`, c(call), `${call.slice(0, call.indexOf('('))}() needs the v2 or v4 runtime`, 'a = ', 0, 3);
  }
  check_('the VIEW3D words still need v4 (v2: VIEW refused)', errs('GAME "c"\nDIM a\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    VIEW 1, 2, 3\n  ENDP\nENDSCENE\n', 2).some((d) => d.message.includes('VIEW needs the v4 runtime')));
  check_('... and WALL() too', errs('GAME "c"\nDIM a\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    a = WALL(1, 2)\n  ENDP\nENDSCENE\n', 2).some((d) => d.message.includes('WALL() needs the v4 runtime')));
}

// =================================================================================================================
// 3. Word tables, scan
// =================================================================================================================
console.log('\n3. word tables');
{
  for (const w of ['WIRE3D', 'MODEL', 'EYE', 'DRAWMODEL', 'LINE']) { const e = ARCADE_WORDS.get(w); check_(`${w}: a reserved entry with syntax and help`, !!e && e.reserved && e.syntax.startsWith(w) && e.desc.length > 40); }
  for (const w of ['ROWS', 'YAW', 'PITCH', 'SCALE']) { const e = ARCADE_WORDS.get(w); check_(`${w}: a contextual entry (not reserved)`, !!e && !e.reserved && !RESERVED.has(w)); }
  eq('MODEL is an asset kind', ASSET_KINDS.MODEL, 'model');
  for (const w of ['COSA', 'SINA', 'FXMUL']) { const d = ARCADE_WORDS.get(w).desc; check_(`${w}: help says "Needs the v2 or v4 runtime"`, d.includes('Needs the v2 or v4 runtime') && !d.includes('Needs the v4 runtime'), d.slice(-40)); }
  check_('NOVIEW help mentions WIRE3D', ARCADE_WORDS.get('NOVIEW').desc.includes('WIRE3D'));
  check_('SCENE help mentions WIRE3D', ARCADE_WORDS.get('SCENE').desc.includes('WIRE3D'));
  const sc = scanArcade(game('    DRAWMODEL gate AT 0, 0, 0\n    DRAWMODEL rock AT 0, 0, 0\n'));
  eq('scanArcade lists the MODEL assets', sc.assets.filter((a) => a.kind === 'MODEL').map((a) => [a.name, a.asset]), [['gate', 'gate'], ['rock', 'rock']]);
}

// =================================================================================================================
// 4. requiredRuntime
// =================================================================================================================
console.log('\n4. requiredRuntime');
{
  const expectExample = { bounce: 2, 'bounce-static': 2, breakout: 2, shooter: 2, blockfall: 2, platformer: 3, runner: 3, vaults: 4 };
  const dir = join(ROOT, 'arcade/examples');
  const names = readdirSync(dir).filter((f) => f.endsWith('.arc')).map((f) => f.slice(0, -4)).sort();
  eq('the examples are the ones this test knows', names, Object.keys(expectExample).sort());
  for (const n of names) {
    const text = readFileSync(join(dir, n + '.arc'), 'utf8');
    const af = join(dir, n + '.assets.json');
    const assets = existsSync(af) ? JSON.parse(readFileSync(af, 'utf8')) : { sprites: {} };
    const r = requiredRuntime(text, assets);
    check_(`example ${n} needs v${expectExample[n]}`, r.version === expectExample[n], `got v${r.version}: ${r.reasons.join(', ')}`);
    if (n === 'vaults') check_('... and vaults names VIEW3D as a reason (not COSA / SINA / FXMUL)', r.reasons.includes('VIEW3D') && !r.reasons.some((x) => /COSA|SINA|FXMUL/.test(x)), r.reasons.join(', '));
    const e = errs(text, r.version);
    check_(`example ${n} checks with no error on v${r.version}`, e.length === 0, msgs(e));
  }
  const rr = (src) => requiredRuntime(src, { sprites: {} });
  const body = (s) => `GAME "r"\nDIM a\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n${s}  ENDP\nENDSCENE\n`;
  eq('a WIRE3D game needs v2', rr(game('    EYE 0, 0, 0, 0\n    DRAWMODEL gate AT 0, 0, 0\n    LINE 0, 0 TO 9, 9\n')).version, 2);
  eq('... its reasons name nothing of v3 / v4', rr(game('    DRAWMODEL gate AT 0, 0, 0\n')).reasons, []);
  eq('COSA alone needs v2 now', rr(body('    a = COSA(a)\n')).version, 2);
  eq('SINA alone needs v2 now', rr(body('    a = SINA(a)\n')).version, 2);
  eq('FXMUL alone needs v2 now', rr(body('    a = FXMUL(a, 2)\n')).version, 2);
  eq('a WIRE3D game with COSA / SINA / FXMUL needs v2', rr(game('    x = FXMUL(5, SINA(t)) + COSA(t)\n    DRAWMODEL gate AT x, 0, 0\n')).version, 2);
  eq('VIEW3D still needs v4', rr('GAME "r"\nMAP level = "level"\nVIEW3D level\n').version, 4);
  eq('VIEW3D with COSA needs v4 (VIEW3D is the reason)', rr('GAME "r"\nMAP level = "level"\nVIEW3D level\nDIM a\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    a = COSA(a)\n  ENDP\nENDSCENE\n'), { version: 4, reasons: ['VIEW3D'] });
  eq('WALL() still needs v4', rr(body('    a = WALL(1, 2)\n')).version, 4);
  eq('SETWALL / VIEW still need v4', [rr(body('    SETWALL 1, 2 = 1\n')).version, rr(body('    VIEW 1, 2, 3\n')).version], [4, 4]);
  eq('a WINDOW game with COSA needs v3 (the checker then refuses COSA)', rr('GAME "r"\nMAP level = "level"\nWINDOW level\nDIM a\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    a = COSA(a)\n  ENDP\nENDSCENE\n').version, 3);
  eq('a WIRE3D game with a WINDOW needs v3 (the checker then refuses WIRE3D)', rr(game('', { head: HEAD + 'MAP level = "level"\nWINDOW level\n' })).version, 3);
  eq('a WIRE3D game with a VIEW3D needs v4 (the checker then refuses WIRE3D)', rr(game('', { head: HEAD + 'MAP level = "level"\nVIEW3D level\n' })).version, 4);
}

// =================================================================================================================
// 5. The code generator and the linker (slice W3b): docs/ARCADE_WIREFRAME_CONTRACT.md sections 3.2 and 3.3, 4 and 5
// =================================================================================================================
console.log('\n5. code generator and linker');
{
  const p = join(ROOT, 'arcade/build/v2/runtime.json');
  if (!existsSync(p)) skip_('code generation of WIRE3D / MODEL / EYE / DRAWMODEL / LINE', 'arcade/build/v2 is not built');
  else {
    const rt = JSON.parse(readFileSync(p, 'utf8'));
    const image = new Uint8Array(readFileSync(join(dirname(p), rt.image ?? 'runtime.bin')));
    // the runtime of slice W2 (RT_WIREMODE, DIV_WIRE) is not in every tree: a mock is the real runtime with the two names added (the code generator only needs them to exist)
    const MOCK_WIREMODE = 0x3B00;
    const mock = JSON.parse(JSON.stringify(rt));
    mock.symbols.RT_WIREMODE = MOCK_WIREMODE; mock.constants.DIV_WIRE = 0x40;
    const cst = rt.constants, sym = rt.symbols;
    const MODELS = {
      gate: { points: [[-10, 0, 0], [10, 0, 0], [0, 10, 0]], edges: [[0, 1], [1, 2], [2, 0]] },
      rock: { points: [[0, 0, 0], [5, 5, 5], [-64, 64, -64]], edges: [[0, 1], [1, 2]] },
    };
    const u16 = (m, a) => m[a] | (m[a + 1] << 8);
    const build = (src, { runtime = rt, assets = { models: MODELS }, ...more } = {}) => compile(src, { runtime, image, assets, ...more });
    const texts = (r) => r.errors.map((e) => e.message).join(' | ');
    // the emitter turns a final `call X` + `ret` into `jp X`: written back as a call, so a test reads the same whatever the statement stands before
    const norm = (r) => r.gen.emitter.asm().split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith(';')).join(';').replace(/;jp (\d+)(?=;)/g, ';call $1;ret');
    const R = (n) => cst[`RA_W${n}`];
    const wprog = (frame, { head = 'GAME "w"\nFRAMERATE 20\nWIRE3D ROWS 2 TO 21\nMODEL gate = "gate"\nMODEL rock = "rock"\nDIM t, x\n', init = '' } = {}) => `${head}SCENE s\n  PROC INIT()\n${init}  ENDP\n  PROC FRAME()\n${frame}  ENDP\nENDSCENE\n`;
    const setW = (n, v) => `ld hl,${v};ld (${R(n)}),hl`;

    console.log('  -- the header, wire_desc and the model images');
    {
      const r = build(wprog('    DRAWMODEL gate AT 1, 2, 3\n    DRAWMODEL rock AT 1, 2, 3\n'));
      check_('a WIRE3D game compiles and links on the real v2 runtime (no NOVIEW scene needs nothing new)', r.errors.length === 0 && !!r.dck, texts(r));
      const m = r.memory, G = cst.GAME_BASE ?? 0x8000, div = (cst.DIV_WIRE ?? 0x40) | (cst.DIV_EXT ?? 0x80);
      check_('the header is 20 bytes: frame_div | DIV_EXT | DIV_WIRE (bit 6), the sprite descriptors and the code follow', r.gen.headerLen === 20 && m[G + 4] === (3 | div) && r.gen.base === G + 20, `frame_div byte ${m[G + 4]}, base ${r.gen.base}`);
      check_('DIV_WIRE is bit 6 ($40) in the real runtime (or the constant is absent: $40 is assumed)', (cst.DIV_WIRE ?? 0x40) === 0x40);
      const d = u16(m, G + 18);
      check_('+18 is DW wire_desc: DB r0, DB r1, DB attr, DB 0 (defaults INK 7 PAPER 0 BRIGHT 1 = $47)', d === r.gen.wire.descAt && Array.from(m.slice(d, d + 4)).join() === '2,21,71,0', Array.from(m.slice(d, d + 4)).join());
      check_('+16 (the map table) is 0 when the game has no maps', u16(m, G + 16) === 0);
      const c = build(wprog('    DRAWMODEL gate AT 1, 2, 3\n    DRAWMODEL rock AT 1, 2, 3\n', { head: 'GAME "w"\nFRAMERATE 30\nWIRE3D ROWS 0 TO 23 INK 5 PAPER 1 BRIGHT 0\nMODEL gate = "gate"\nMODEL rock = "rock"\nDIM t, x\n' }));
      const d2 = u16(c.memory, G + 18);
      check_('wire_desc of ROWS 0 TO 23 INK 5 PAPER 1 BRIGHT 0: 0, 23, 13, 0; FRAMERATE 30', Array.from(c.memory.slice(d2, d2 + 4)).join() === '0,23,13,0' && c.memory[G + 4] === (2 | div), Array.from(c.memory.slice(d2, d2 + 4)).join());
      const e1 = build(wprog('', { head: 'GAME "w"\nWIRE3D ROWS 4 TO 7 BRIGHT 1 INK 2\nMODEL gate = "gate"\n' }).replace('MODEL gate = "gate"\n', 'MODEL gate = "gate"\n'));
      const d3 = u16(e1.memory, G + 18);
      check_('the clauses come in any order and a missing one takes its default: BRIGHT 1 INK 2 -> $42', Array.from(e1.memory.slice(d3, d3 + 4)).join() === '4,7,66,0', Array.from(e1.memory.slice(d3, d3 + 4)).join());
      const mods = r.gen.wire.models;
      const { modelBytes } = await import('../src/lang/arcade/arcade-wire.js');
      check_('each model image (DB npts, DB nedges, points, edges) is in the game image, once, in declaration order', mods.length === 2 && mods.every((x) => Array.from(r.memory.slice(x.at, x.at + x.bytes)).join() === modelBytes(MODELS[x.name]).join()) && mods[1].at === mods[0].at + mods[0].bytes, JSON.stringify(mods));
      check_('... inside the mapped game area ($8000-$BFFF), after the code (never in the bank window)', mods.every((x) => x.at >= r.gen.base && x.at + x.bytes <= G + 0x4000) && (r.gen.bank?.banked ?? []).length === 0);
      const ba = build(wprog('    DRAWMODEL gate AT 1, 2, 3\n'), { bankAll: true });
      check_('bankAll (the test option that banks everything bankable) leaves the models mapped', ba.errors.length === 0 && ba.gen.wire.models.every((x) => x.at < 0xC000 && x.at >= 0x8000) && (ba.gen.bank?.banked ?? []).length === 0, texts(ba));
      check_('usage.codegen reports the wire bytes: wire 4, models 2 + 2 + 3 * 3 + 3 * 2 ... as the images say', r.usage.codegen.dataBytes.wire === 4 && r.usage.codegen.dataBytes.models === mods.reduce((n, x) => n + x.bytes, 0));
      // a game with maps too: the map table stays at +16, wire_desc at +18
      const tiles = { tiles: [{ rows: Array.from({ length: 8 }, () => ({ bits: 0x55, ink: 2, paper: 7 })) }] };
      const mp = build(wprog('    DRAWMODEL gate AT 1, 2, 3\n    LOADMAP m\n', { head: 'GAME "w"\nWIRE3D ROWS 2 TO 21\nTILESET ts = "ts"\nMAP m = "m"\nMODEL gate = "gate"\n' }), { assets: { models: MODELS, tilesets: { ts: tiles }, maps: { m: { w: 2, h: 2, cells: [0, 0, 0, 0] } } } });
      check_('a LOADMAP in a WIRE3D game: the map table at +16 and wire_desc at +18 are both set', mp.errors.length === 0 && u16(mp.memory, G + 16) !== 0 && u16(mp.memory, G + 18) === mp.gen.wire.descAt, texts(mp));
    }

    console.log('  -- the statements');
    {
      const r = build(wprog('    DRAWMODEL gate AT 1, 2, 3 YAW 4 PITCH 5 SCALE 4\n'));
      const a = norm(r);
      const want = [setW(0, 1), setW(1, 2), setW(2, 3), setW(3, 4), setW(4, 5), `ld hl,L_model_0;ld a,2;call ${sym.RT_DRAWMODEL}`].join(';');       // (consecutive equal values would share one LD HL: the emitter drops the repeat)
      check_('DRAWMODEL m AT x, y, z YAW a PITCH p SCALE 4: x, y, z, yaw, pitch into RA_W0..RA_W4, HL = the model, A = log2 SCALE, CALL RT_DRAWMODEL', a.includes(want), a.slice(a.indexOf('L_P_FRAME'), a.indexOf('L_P_FRAME') + 400));
      const r2 = build(wprog('    DRAWMODEL rock AT 1, 2, 3\n'));
      check_('absent YAW / PITCH are stored as 0, SCALE defaults to 1 (A = 0); the second model is L_model_1', norm(r2).includes([setW(0, 1), setW(1, 2), setW(2, 3), setW(3, 0), `ld (${R(4)}),hl`, `ld hl,L_model_1;ld a,0;call ${sym.RT_DRAWMODEL}`].join(';')));
      for (const [s, k] of [[1, 0], [2, 1], [4, 2], [8, 3]]) check_(`SCALE ${s}: A = ${k}`, norm(build(wprog(`    DRAWMODEL gate AT 1, 2, 3 SCALE ${s}\n`))).includes(`ld hl,L_model_0;ld a,${k};call ${sym.RT_DRAWMODEL}`));
      const ord = (src) => build(src).gen.code;
      const sameCode = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
      check_('the clauses may come in any order: the same bytes', sameCode(ord(wprog('    DRAWMODEL gate AT 1, 2, 3 YAW 4 PITCH 5 SCALE 2\n')), ord(wprog('    DRAWMODEL gate AT 1, 2, 3 SCALE 2 PITCH 5 YAW 4\n'))) && sameCode(ord(wprog('    DRAWMODEL gate AT 1, 2, 3 PITCH 5 YAW 4\n')), ord(wprog('    DRAWMODEL gate AT 1, 2, 3 YAW 4 PITCH 5\n'))));
      // evaluation order: x, y, z, yaw, pitch, each stored as soon as it is evaluated
      const e = norm(build(wprog('    DRAWMODEL gate AT t + 1, t + 2, t + 3 PITCH t + 5 YAW t + 4\n')));
      const at = [0, 1, 2, 3, 4].map((n) => e.indexOf(`ld (${R(n)}),hl`));
      check_('non-constant operands: stored in the order x, y, z, yaw, pitch (the pitch clause written first is still stored last)', at.every((v, i) => v >= 0 && (i === 0 || v > at[i - 1])) && e.indexOf('ld hl,(', e.indexOf('inc hl')) >= 0, JSON.stringify(at));
      const ey = norm(build(wprog('    EYE t, 0, t + 1, 3\n')));
      check_('EYE x, y, z, a: four words in order into RA_W0..RA_W3, then CALL RT_EYE', ey.includes(`ld (${R(0)}),hl;ld hl,0;ld (${R(1)}),hl;`) && ey.includes(`${setW(3, 3)};call ${sym.RT_EYE}`), ey.slice(ey.indexOf('L_P_FRAME'), ey.indexOf('L_P_FRAME') + 300));
      const ln = norm(build(wprog('    LINE 1, 2 TO 3, 4\n')));
      check_('LINE x0, y0 TO x1, y1: four words in order into RA_W0..RA_W3, then CALL RT_LINE', ln.includes([setW(0, 1), setW(1, 2), setW(2, 3), setW(3, 4), `call ${sym.RT_LINE}`].join(';')));
      const nested = norm(build(wprog('    LINE t, COSA(t) TO FXMUL(t, SINA(t)), 4\n')));
      check_('a COSA / SINA / FXMUL inside an argument does not disturb the words already stored (they use no RA_W word)', nested.includes(`call ${sym.RT_COSA}`) && nested.includes(`call ${sym.RT_SINA}`) && nested.includes(`call ${sym.RT_FXMUL}`) && nested.includes(`ld (${R(3)}),hl;call ${sym.RT_LINE}`));
      // reachability: the statements reach their procs' calls, and a PROC call inside an operand's DEF FN is generated
      const f = build(wprog('    EYE FN k(t), 0, 0, 0\n', { head: 'GAME "w"\nWIRE3D ROWS 2 TO 21\nDIM t\nDEF FN k(a) = a * 2\n' }));
      check_('a DEF FN used only inside an EYE operand is reachable and generated', f.errors.length === 0 && Object.keys(f.map.fns).length === 1, texts(f));
      const lc = build(wprog('    EYE 1, 2, 3, 4\n', { head: 'GAME "w"\nWIRE3D ROWS 2 TO 21\nDIM t\n' }));
      check_('EYE and LINE need no MODEL (a WIRE3D game with no MODEL compiles)', lc.errors.length === 0 && Object.keys(lc.gen.wire).includes('models') && lc.gen.wire.models.length === 0, texts(lc));
      // locals: an implicit FOR variable used in an operand is a local of the PROC
      const fl = build(wprog('    FOR i = 0 TO 3\n      LINE i, i TO 9, 9\n      DRAWMODEL gate AT i, i, i YAW i PITCH i\n      EYE i, i, i, i\n    NEXT i\n'));
      check_('an implicit FOR variable used in EYE / LINE / DRAWMODEL operands gets its slot', fl.errors.length === 0 && !!fl.dck, texts(fl));
    }

    console.log('  -- COSA / SINA / FXMUL on v2');
    {
      const c = (call) => `GAME "c"\nDIM a, t\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    a = ${call}\n  ENDP\nENDSCENE\n`;
      const a = norm(build(c('COSA(t)'), { assets: {} })), b = norm(build(c('SINA(t + 1)'), { assets: {} })), d = norm(build(c('FXMUL(t, 7)'), { assets: {} }));
      check_('COSA(t) on a v2 game with no WIRE3D compiles to ld hl,(t); call RT_COSA', build(c('COSA(t)'), { assets: {} }).errors.length === 0 && a.includes(`call ${sym.RT_COSA};`), texts(build(c('COSA(t)'), { assets: {} })));
      check_('SINA(t + 1) calls RT_SINA, FXMUL(t, 7) calls RT_FXMUL with HL = t, DE = 7 (v4\'s register contract)', b.includes(`call ${sym.RT_SINA};`) && d.includes(`ld de,7;`) && d.includes(`call ${sym.RT_FXMUL};`), d);
      const noSym = JSON.parse(JSON.stringify(rt)); delete noSym.symbols.RT_COSA;
      check_('a runtime without RT_COSA says so (no "needs the v4 runtime")', texts(build(c('COSA(t)'), { runtime: noSym, assets: {} })).includes('COSA(...) needs RT_COSA, which this runtime does not provide'), texts(build(c('COSA(t)'), { runtime: noSym, assets: {} })));
    }

    console.log('  -- NOVIEW scenes: the switch calls');
    {
      const sc = (name, mode, body) => `SCENE ${name}${mode}\n  PROC INIT()\n    t = 0\n  ENDP\n  PROC FRAME()\n${body}  ENDP\nENDSCENE\n`;
      const head = 'GAME "w"\nFRAMERATE 20\nWIRE3D ROWS 2 TO 21\nMODEL gate = "gate"\nDIM t\n';
      const slice = (a, from, to) => { const i = a.indexOf(from), j = a.indexOf(to, i + 1); return a.slice(i, j < 0 ? a.length : j); };
      const MODE = `call ${MOCK_WIREMODE}`;
      // the first scene shows the play area: the boot makes no call; every ENTER sequence has one per scene
      const p1 = head + sc('play', '', '    DRAWMODEL gate AT 0, 0, 100\n    IF t > 9 THEN\n      ENTER title\n    ENDIF\n') + sc('title', ' NOVIEW', '    DRAWMODEL gate AT 0, 0, 100\n    ENTER play\n');
      const r1 = build(p1, { runtime: mock });
      check_('first scene with the play area, one NOVIEW scene: compiles on the mock runtime', r1.errors.length === 0 && !!r1.dck, texts(r1));
      const a1 = norm(r1);
      const boot = slice(a1, 'L_entry_init:', 'L_frame_entry:');
      check_('boot: no RT_WIREMODE call (the header turns the play area on)', !boot.includes(MODE), boot);
      const go0 = slice(a1, 'L_scn_go_0:', 'L_scn_go_1:'), go1 = slice(a1, 'L_scn_go_1:', 'L_scn_reset:');
      check_('ENTER sequence of the play scene: ld a,1; call RT_WIREMODE, then its INIT', new RegExp(`ld a,1;${MODE};j[pr] L_P_`).test(go0), go0);
      check_('ENTER sequence of the NOVIEW scene: ld a,0; call RT_WIREMODE, then its INIT', new RegExp(`ld a,0;${MODE};j[pr] L_P_`).test(go1), go1);
      check_('exactly two RT_WIREMODE calls in the whole program', a1.split(MODE).length - 1 === 2);
      const reset = slice(a1, 'L_scn_reset:', 'L_P_');
      check_('the machine reset of ENTER ends with the eye back to 0, 0, 0, 0 (four zero words into RA_W0..RA_W3, CALL RT_EYE)', reset.includes(`${setW(0, 0)};ld (${R(1)}),hl;ld (${R(2)}),hl;ld (${R(3)}),hl;call ${sym.RT_EYE};ret`), reset);
      check_('DRAWMODEL in a NOVIEW scene is still emitted (the runtime ignores it while the play area is off)', a1.split(`call ${sym.RT_DRAWMODEL}`).length - 1 === 2);
      // the first scene is NOVIEW: the boot call with A = 0
      const p2 = head + sc('title', ' NOVIEW', '    ENTER play\n') + sc('play', '', '    DRAWMODEL gate AT 0, 0, 100\n    ENTER title\n');
      const r2 = build(p2, { runtime: mock }), a2 = norm(r2);
      const boot2 = slice(a2, 'L_entry_init:', 'L_frame_entry:');
      check_('first scene NOVIEW: the boot sets the mode first: ld a,0; call RT_WIREMODE before its INIT', r2.errors.length === 0 && boot2.includes(`ld a,0;${MODE};`), texts(r2) || boot2);
      check_('... and the ENTER sequences have one call each: three in all', a2.split(MODE).length - 1 === 3);
      // no NOVIEW scene: no call at all, even on a runtime that has RT_WIREMODE; the eye reset stays for ENTER
      const p3 = head + sc('a', '', '    ENTER b\n') + sc('b', '', '    DRAWMODEL gate AT 0, 0, 100\n    ENTER a\n');
      const r3 = build(p3, { runtime: mock }), a3 = norm(r3);
      check_('no NOVIEW scene: no RT_WIREMODE call, with scenes or without', r3.errors.length === 0 && !a3.includes(MODE) && !norm(build(wprog('    DRAWMODEL gate AT 0, 0, 100\n'), { runtime: mock })).includes(MODE));
      check_('... but ENTER still resets the eye', a3.includes(`call ${sym.RT_EYE};ret`));
      check_('a program without ENTER or scenes has no eye reset code at all (the boot starts the eye at 0)', !norm(build(wprog('    DRAWMODEL gate AT 0, 0, 100\n'), { runtime: mock })).includes(`call ${sym.RT_EYE};`));
      // the real runtime of this tree has no RT_WIREMODE yet: a NOVIEW scene fails cleanly, naming it
      const rr = build(p1);
      check_('a NOVIEW scene on a runtime without RT_WIREMODE: a clean error naming RT_WIREMODE, at the SCENE line', rr.dck === null && (sym.RT_WIREMODE !== undefined || rr.errors.some((x) => x.message.includes('needs RT_WIREMODE, which this runtime does not provide') && x.line === 1 + p1.slice(0, p1.indexOf('SCENE title')).split('\n').length - 1)), texts(rr));
    }

    console.log('  -- asset errors, missing runtime parts');
    {
      const src = wprog('    DRAWMODEL gate AT 1, 2, 3\n');
      const at = (needle) => src.slice(0, src.indexOf(needle)).split('\n').length;
      const none = build(src, { assets: {} });
      check_('a MODEL whose asset is not in the project: an error at the MODEL line', none.dck === null && none.errors.some((e) => e.message === 'model asset "gate" is not in the project' && e.line === at('MODEL gate')) && none.errors.some((e) => e.message === 'model asset "rock" is not in the project' && e.line === at('MODEL rock')), texts(none));
      check_('... and no cascade at the DRAWMODEL', none.errors.length === 2, texts(none));
      const bad = (model) => build(src, { assets: { models: { gate: model, rock: MODELS.rock } } });
      for (const [what, model, msg] of [
        ['a coordinate beyond 64', { points: [[65, 0, 0]], edges: [[0, 0]] }, 'a point is three integers -64..64'],
        ['no points', { points: [], edges: [[0, 1]] }, 'a model has 1..128 points'],
        ['no edges', { points: [[0, 0, 0]], edges: [] }, 'a model has 1..255 edges'],
        ['129 points', { points: Array.from({ length: 129 }, () => [0, 0, 0]), edges: [[0, 1]] }, 'a model has 1..128 points'],
        ['256 edges', { points: [[0, 0, 0], [1, 1, 1]], edges: Array.from({ length: 256 }, () => [0, 1]) }, 'a model has 1..255 edges'],
        ['an edge to a point that does not exist', { points: [[0, 0, 0]], edges: [[0, 3]] }, 'an edge joins two different points of the model'],
        ['an edge from a point to itself', { points: [[0, 0, 0], [1, 1, 1]], edges: [[1, 1]] }, 'an edge joins two different points of the model'],
        ['a fractional coordinate', { points: [[0.5, 0, 0]], edges: [[0, 0]] }, 'a point is three integers -64..64'],
      ]) {
        const r = bad(model);
        check_(`${what}: an error "model "gate": ${msg}" at the MODEL line`, r.dck === null && r.errors.some((e) => e.message === `model "gate": ${msg}` && e.line === at('MODEL gate')), texts(r));
      }
      const ok = bad({ points: Array.from({ length: 128 }, (_, i) => [i % 64, -(i % 64), 64]), edges: Array.from({ length: 255 }, (_, i) => [i % 128, (i + 1) % 128]) });
      check_('128 points and 255 edges at the limits compile', ok.errors.length === 0 && ok.gen.wire.models[0].bytes === 2 + 128 * 3 + 255 * 2, texts(ok));
      const lower = build(src, { assets: { models: { GATE: MODELS.gate, Rock: MODELS.rock } } });
      check_('the model asset is found ignoring case (as every asset)', lower.errors.length === 0, texts(lower));
      for (const name of ['RT_EYE', 'RT_DRAWMODEL', 'RT_LINE']) {
        const no = JSON.parse(JSON.stringify(rt)); delete no.symbols[name];
        const stmt = { RT_EYE: 'EYE 1, 2, 3, 4', RT_DRAWMODEL: 'DRAWMODEL gate AT 1, 2, 3', RT_LINE: 'LINE 1, 2 TO 3, 4' }[name];
        const r = build(wprog(`    ${stmt}\n`), { runtime: no });
        check_(`a runtime without ${name}: a clean error "needs ${name}, which this runtime does not provide"`, r.dck === null && r.errors.some((e) => e.message.includes(`needs ${name}, which this runtime does not provide`)), texts(r));
      }
      const nra = JSON.parse(JSON.stringify(rt)); delete nra.constants.RA_W4;
      check_('a runtime without the argument words RA_W0..RA_W4: a clean error', texts(build(wprog('    LINE 1, 2 TO 3, 4\n'), { runtime: nra })).includes('needs the runtime argument words RA_W0..RA_W4'));
      check_('no "internal" error anywhere above', !texts(none).includes('internal'));
    }

    console.log('  -- the linker: at most 45 sprite phases in a WIRE3D game');
    {
      const sp = (ph) => ({ w: 8, h: 8, phases: ph, frames: [{ rows: Array.from({ length: 8 }, () => ({ bits: 'FF', mask: 'FF' })) }] });
      const mk = (phases) => {
        const sprites = {}; phases.forEach((ph, i) => { sprites[`s${i}`] = sp(ph); });
        const decl = phases.map((_, i) => `SPRITE q${i} = "s${i}"\n`).join('');
        return { sprites, src: (wire) => `GAME "w"\n${wire ? 'WIRE3D ROWS 2 TO 21\nMODEL gate = "gate"\n' : ''}${decl}DIM t\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n${phases.map((_, i) => `    SHOW q${i} AT t, ${8 * i}\n`).join('')}${wire ? '    DRAWMODEL gate AT 0, 0, 100\n' : ''}  ENDP\nENDSCENE\n` };
      };
      const a45 = mk([8, 8, 8, 8, 8, 4, 1]), a46 = mk([8, 8, 8, 8, 8, 4, 2]), a64 = mk([8, 8, 8, 8, 8, 8, 8, 8]);
      const b = (g, wire) => build(g.src(wire), { assets: { sprites: g.sprites, models: MODELS } });
      const r45 = b(a45, true), r46 = b(a46, true);
      check_('45 phases in all (5 x 8 + 4 + 1): links', r45.errors.length === 0 && !!r45.dck, texts(r45));
      check_('46 phases in all: the exact error "sprite art too large for a WIRE3D game: 46 phases, at most 45; use fewer phases"', r46.dck === null && r46.errors.length === 1 && r46.errors[0].message === 'sprite art too large for a WIRE3D game: 46 phases, at most 45; use fewer phases', texts(r46));
      const r64 = b(a64, true);
      check_('eight assets of 8 phases (64): refused with the count', r64.errors.some((e) => e.message === 'sprite art too large for a WIRE3D game: 64 phases, at most 45; use fewer phases'), texts(r64));
      const c46 = b(a46, false), c64 = b(a64, false);
      check_('the same sprites in a game without WIRE3D: no such limit (46 and 64 phases link)', c46.errors.length === 0 && !!c46.dck && c64.errors.length === 0 && !!c64.dck, texts(c46) + texts(c64));
      check_('two instances of one asset count its phases once (a pool of 8 of a 8-phase asset: 8 phases)', (() => { const r = build(`GAME "w"\nWIRE3D ROWS 2 TO 21\nMODEL gate = "gate"\nSPRITE q(8) = "a"\nDIM t\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    SHOW q(0) AT 1, 2\n    DRAWMODEL gate AT 0, 0, 100\n  ENDP\nENDSCENE\n`, { assets: { sprites: { a: sp(8) }, models: MODELS } }); return r.errors.length === 0; })());
    }
  }
}

// =================================================================================================================
// 6. Byte identity: a program without WIRE3D / COSA / SINA / FXMUL compiles to the bytes of the compiler before slice W3b
// =================================================================================================================
console.log('\n6. byte identity with the compiler before the code generator (contract section 5)');
{
  const ref = process.env.ARCADE_M17_OLD ?? '82b1cab';
  let tmp = null, oldCompile = null;
  try {
    tmp = mkdtempSync(join(tmpdir(), 'm17old-'));
    execFileSync('sh', ['-c', `git -C "${process.env.ARCADE_M17_GIT ?? ROOT}" archive ${ref} src | tar -x -C "${tmp}"`], { stdio: 'ignore' });
    ({ compile: oldCompile } = await import(pathToFileURL(join(tmp, 'src/lang/arcade/arcade-compile.js')).href));
  } catch (e) { oldCompile = null; console.log(`  (the compiler of ${ref} could not be extracted: ${e.message.split('\n')[0]})`); }
  if (!oldCompile) skip_('byte identity', `git archive ${ref} failed`);
  else {
    const RT = {};
    for (const v of [2, 3, 4]) {
      const q = join(ROOT, `arcade/build/v${v}/runtime.json`);
      if (existsSync(q)) { const j = JSON.parse(readFileSync(q, 'utf8')); RT[v] = { runtime: j, image: new Uint8Array(readFileSync(join(dirname(q), j.image ?? 'runtime.bin'))) }; }
    }
    let n = 0, bad = '', built = 0;
    const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
    for (const dir of ['arcade/examples', 'arcade/tests/fixtures']) for (const f of readdirSync(join(ROOT, dir))) {
      if (!f.endsWith('.arc')) continue;
      const base = f.replace(/\.arc$/, '');
      const ap = [`${base}.assets.json`, `${base.replace(/-.*$/, '')}.assets.json`].map((a) => join(ROOT, dir, a)).find((q) => existsSync(q)) ?? join(ROOT, 'arcade/examples', `${base.replace(/-.*$/, '')}.assets.json`);
      const assets = existsSync(ap) ? JSON.parse(readFileSync(ap, 'utf8')) : {}, text = readFileSync(join(ROOT, dir, f), 'utf8');
      for (const v of [2, 3, 4]) {
        if (!RT[v]) continue;
        if ((v === 2 || v === 3) && /\b(COSA|SINA|FXMUL)\s*\(/i.test(text)) continue;      // COSA / SINA / FXMUL changed on v2 (allowed) and v3 (new message) on purpose
        for (const variant of [{}, { bankAll: true }]) {
          const a = oldCompile(text, { ...RT[v], assets, ...variant }), b = compile(text, { ...RT[v], assets, ...variant });
          n++;
          if (a.errors.length || b.errors.length) { if (JSON.stringify(a.errors) !== JSON.stringify(b.errors)) bad += `${dir}/${f} v${v}: errors differ; `; continue; }
          built++;
          if (!same(a.dck, b.dck) || !same(a.memory, b.memory) || JSON.stringify(a.warnings) !== JSON.stringify(b.warnings)) bad += `${dir}/${f} v${v}${variant.bankAll ? ' bankAll' : ''}: bytes differ; `;
        }
      }
    }
    check_(`${n} compilations of every example and fixture on v2 / v3 / v4 (${built} built a cartridge): DCK, memory image and warnings identical to the compiler of ${ref}`, bad === '' && built >= 15, bad || `${built} builds`);
  }
  if (tmp) rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
