#!/usr/bin/env node
"use strict";
// arcade-m17-compiler.mjs -- tests for the FRONT END of the wireframe 3D (slice W3): docs/ARCADE_WIREFRAME_CONTRACT.md section 1 (the language), items 9 (errors and warnings) and 10 (the runtime choice).
//
//   node tests/arcade-m17-compiler.mjs
//
// No machine is booted and no code is generated: the parser, the checker, the word tables, requiredRuntime, and the code generator's clean refusal of the new statements (it is a later slice). Sections
//   1  parser: every form, its node shape, clauses in any order, contextual words as variable names, reserved words naming assets, parse errors
//   2  checker: every error and warning of item 9 with its line, NOVIEW in a WIRE3D / VIEW3D / plain game, COSA SINA FXMUL on v2, v3 and v4, WIRE3D on v2 only
//   3  word tables: the new entries, the help text of COSA SINA FXMUL, scan
//   4  requiredRuntime: the examples (unchanged) and small programs
//   5  the code generator refuses the new words with a clear message
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

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
// 5. The code generator (a later slice) refuses the new words cleanly
// =================================================================================================================
console.log('\n5. code generator: a clean refusal');
{
  const p = join(ROOT, 'arcade/build/v2/runtime.json');
  if (!existsSync(p)) skip_('the code generator refuses WIRE3D / MODEL / EYE / DRAWMODEL / LINE', 'arcade/build/v2 is not built');
  else {
    const rt = JSON.parse(readFileSync(p, 'utf8'));
    const image = new Uint8Array(readFileSync(join(dirname(p), rt.image ?? 'runtime.bin')));
    const build = (src) => compile(src, { runtime: rt, image, assets: { sprites: {} } });
    const texts = (r) => r.errors.map((e) => e.message).join(' | ');
    const base = 'GAME "w"\nWIRE3D ROWS 2 TO 21\n';
    const frame = (s) => `${base}SCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n${s}  ENDP\nENDSCENE\n`;
    for (const [what, src] of [['EYE', frame('    EYE 0, 0, 0, 0\n')], ['LINE', frame('    LINE 0, 0 TO 5, 5\n')]]) {
      const r = build(src);
      check_(`${what}: no output, an error "not implemented yet: ${what}"`, r.dck === null && texts(r).includes(`not implemented yet: ${what}`), texts(r) || 'no errors');
    }
    const r1 = build(`${base}MODEL gate = "gate"\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    DRAWMODEL gate AT 0, 0, 0\n  ENDP\nENDSCENE\n`);
    check_('DRAWMODEL: an error "not implemented yet: DRAWMODEL"', r1.dck === null && texts(r1).includes('not implemented yet: DRAWMODEL'), texts(r1) || 'no errors');
    check_('MODEL: an error "not implemented yet: MODEL"', texts(r1).includes('not implemented yet: MODEL'), texts(r1));
    check_('WIRE3D: an error "not implemented yet: WIRE3D"', texts(r1).includes('not implemented yet: WIRE3D'), texts(r1));
    check_('no "internal" error for the new nodes', !texts(r1).includes('internal'), texts(r1));
  }
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
