#!/usr/bin/env node
"use strict";
// arcade-m8-compiler.mjs -- tests for language batch 3 of the Leap Arcade compiler (the raycaster slice, docs/ARCADE_RAYCASTER_CONTRACT.md sections 2, 3, 6; the decisions
// where the contract is silent are in docs/ARCADE_LANGUAGE_BATCH3.md): VIEW3D (COLW INK CEIL FLOOR BRIGHT PATTERNS), VIEW, SETWALL, COSA, SINA, FXMUL, WALL, SEEN, DEPTH,
// SHOW in ray mode (unclamped 8.8), HIT in ray mode, the v4 header and view_desc.
//
//   node tests/arcade-m8-compiler.mjs               (ARCADE_QUICK=1: a smaller fuzz)
//
// The real v4 runtime is built by another engineer: everything here is checked structurally (parse, check, code and image layout against independent JavaScript), on the
// reference interpreter, and by RUNNING the compiled Z80 code on a MOCK runtime (tests/arcade-m8-mock.mjs: JavaScript traps for the routines, written from the contract and from
// the image the linker wrote). tests/arcade-m8-differential.mjs is the same comparison against the REAL v4 runtime; it skips until arcade/build/v4/runtime.json has the routines.
//
// Sections
//   1  parser and checker: every new word, positive and negative
//   2  the word table, the reserved words, batch 3 words as asset names
//   3  the data builders and the maths (COSA, SINA, FXMUL, the view map, the descriptor) against independent models
//   4  the reference interpreter, hand-computed
//   5  the code generator and linker: header, view_desc, map_src, attributes, patterns, descriptors, errors, runtime refusals, the link report
//   6  compiled code on the mock runtime against the interpreter (the maze game 720 ticks, every word, the smallest map)
//   7  argument forms and evaluation order on the mock
//   8  fuzz: >= 3,000 queries (WALL SETWALL FXMUL COSA SINA, with VIEW) against an independent model, on the interpreter and on the mock
//   9  programs that use none of the new words compile to the same bytes as before the batch (arcade/tests/fixtures/batch3-baseline.json)
//  10  requiredRuntime and the usage report
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile, requiredRuntime, usageLines } from '../src/lang/arcade/arcade-compile.js';
import { ARCADE_WORDS, RESERVED, FUNCTIONS, BATCH3_WORDS } from '../src/lang/arcade/arcade-words.js';
import * as VIEW from '../src/lang/arcade/arcade-view.js';
import { rleEncode, rleDecode } from '../src/lang/arcade/arcade-window.js';
import { rng, ASSETS, PROGRAMS, RAY, WORDS, SMALL, withMap, viewModel, cosModel, sinModel, fxmulModel, diffV4 } from './arcade-m8-common.mjs';
import { compileMock4, runMock4, mockRuntime4, ADDR, MOCK_IMAGE, COS4096 } from './arcade-m8-mock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const QUICK = !!process.env.ARCADE_QUICK;

let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  ok ? passed++ : failed++;
  return ok;
};
const info = (s) => console.log('  INFO  ' + s);

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const prog = (body, { top = '', decl = 'DIM v, w, k', procs = '', view = 'VIEW3D level\n', sprites = 'SPRITE p = "orb"\nSPRITE c(3) = "guard"\n', map = 'MAP level = "maze"\n', rate = 'FRAMERATE 12\n' } = {}) =>
  `GAME "t"\n${rate}${map}${sprites}${top}${view}SCENE s\n  ${decl}\n${procs}  PROC INIT()\n  ENDP\n  PROC FRAME()\n${body}\n  ENDP\nENDSCENE\n`;
const diag = (src, version = 4) => { const p = parse(src); return [...p.errors, ...check(p.ast, { version })]; };
const errs = (src, v) => diag(src, v).filter((d) => d.severity === 'error');
const warns = (src, v) => diag(src, v).filter((d) => d.severity === 'warning');
const msgs = (l) => l.map((d) => `${d.line}:${d.col} ${d.message}`).join(' | ');
const ok0 = (name, body, o) => { const e = errs(prog(body, o)); check_(name, e.length === 0, msgs(e)); };
const bad = (name, body, rx, o, v) => { const e = errs(prog(body, o), v); check_(name, e.length >= 1 && rx.test(e[0].message) && e[0].line >= 1, msgs(e) || 'no error'); };
const badSrc = (name, src, rx, v) => { const e = errs(src, v); check_(name, e.length >= 1 && rx.test(e[0].message), msgs(e) || 'no error'); };
const warn1 = (name, body, rx, o) => { const e = errs(prog(body, o)), w = warns(prog(body, o)); check_(name, e.length === 0 && w.some((d) => rx.test(d.message)), msgs(e) + ' || ' + msgs(w)); };
const noWarn = (name, body, rx, o) => { const w = warns(prog(body, o)); check_(name, !w.some((d) => rx.test(d.message)), msgs(w)); };

const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
const cm = (src, assets = ASSETS, rtExtra = {}, symExtra = {}) => compileMock4(src, assets, rtExtra, symExtra);
const cmBad = (name, src, rx, assets = ASSETS, rtExtra = {}) => {
  const r = cm(src, assets, rtExtra);
  check_(name, r.errors.length >= 1 && rx.test(r.errors[0].message) && !r.dck, errText(r) || 'compiled');
  return r;
};
/** compile against the mock runtime with symbols removed (a runtime that lacks a routine) or the version changed */
const compileWith = (src, mutate, assets = ASSETS) => { const rt = mockRuntime4(); mutate(rt); return compile(src, { runtime: rt, image: MOCK_IMAGE, assets }); };

// =================================================================================================================
// 1. Parser and checker
// =================================================================================================================
console.log('1. Parser and checker: VIEW3D, VIEW, SETWALL and the functions');
{
  ok0('VIEW3D map', '    v = 1');
  ok0('VIEW3D with every clause, in the contract\'s order', '    v = 1', { view: 'VIEW3D level COLW 2 INK 7 CEIL 1 FLOOR 5 BRIGHT 1\n', rate: 'FRAMERATE 12\n' });
  ok0('VIEW3D clauses in any order', '    v = 1', { view: 'VIEW3D level BRIGHT 0 FLOOR 2 INK 1 COLW 4 CEIL 3\n' });
  ok0('VIEW3D with one clause at a time', '    v = 1', { view: 'VIEW3D level INK 4\n' });
  ok0('VIEW3D clause values are constant expressions (CONSTs, + - * DIV MOD, bit functions)', '    v = 1', { top: 'CONST A = 3\n', view: 'VIEW3D level COLW A - 1 INK A * 2 CEIL BAND(A, 1) FLOOR A DIV 2 BRIGHT A MOD 2\n', rate: 'FRAMERATE 12\n' });
  ok0('VIEW3D PATTERNS with 16 constant bytes', '    v = 1', { view: 'VIEW3D level PATTERNS 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 255, 0\n' });
  ok0('VIEW3D PATTERNS followed by another clause', '    v = 1', { view: 'VIEW3D level PATTERNS 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 255, 0 INK 2\n' });
  ok0('COLW CEIL FLOOR PATTERNS are contextual: they are still names', '    colw = 1 : ceil = 2 : floor = colw + ceil : patterns = floor', { decl: 'DIM v, colw, ceil, floor, patterns' });
  ok0('VIEW x, y, a with constants, variables and expressions', '    VIEW 384, 384, 0\n    VIEW v, w, k\n    VIEW v * 2 + 1, FXMUL(v, 3), k AND 255');
  ok0('SETWALL x, y = t (y at the additive level, like TILE)', '    SETWALL 256, 512 = 3\n    SETWALL v + 8, w * 2 + 1 = k MOD 5\n    SETWALL v, w = WALL(v, w)');
  ok0('COSA SINA FXMUL WALL as values', '    v = COSA(k) + SINA(k * 2) + FXMUL(w, COSA(k)) + WALL(v, w)\n    IF WALL(v, w) = 0 AND COSA(k) > 0 THEN k = 1 ENDIF');
  ok0('SEEN and DEPTH of a sprite, an element of a pool, a run-time element', '    v = SEEN(p) + DEPTH(p) + SEEN(c(1)) + DEPTH(c(w)) + SEEN(c)');
  ok0('SHOW in ray mode with FRAME and FLIP, HIDE, HIT', '    SHOW p AT v, w\n    SHOW c(k) AT v * 3, w FRAME k FLIP\n    HIDE p\n    k = HIT(p, c(1))');
  ok0('BAND(a, b) the bit function still works (it is not a view word)', '    v = BAND(w, 255)');
  ok0('a VIEW3D program does not need a TILESET', '    v = 1');
  ok0('check(ast) without a version assumes nothing: the batch 3 words pass', '    VIEW v, w, k\n    SETWALL v, w = 2\n    v = COSA(k) + WALL(v, w) + SEEN(p)');
  check_('parse: View3d node carries the map, the clauses and their positions', (() => {
    const a = parse(prog('', { view: 'VIEW3D level COLW 2 FLOOR 5 INK 6\n' })).ast;
    const v = a.views[0];
    return a.views.length === 1 && v.map.name === 'level' && v.clauses.colw.value === 2 && v.clauses.floor.value === 5 && v.clauses.ink.value === 6 && v.clauses.ceil === null && v.clauses.bright === null && v.clauses.patterns === null && v.clausePos.floor.line === v.line && a.items.some((i) => i.type === 'View3d');
  })());
  check_('parse: PATTERNS holds a list of expressions', parse(prog('', { view: 'VIEW3D level PATTERNS 1, 2 + 3, 4\n' })).ast.views[0].clauses.patterns.length === 3);
  check_('parse: View and SetWall nodes', (() => {
    const body = parse(prog('    VIEW 1, 2, 3\n    SETWALL 1, 2 + 3 = 4')).ast.scenes[0].procs[1].body;
    return body[0].type === 'View' && body[0].a.value === 3 && body[1].type === 'SetWall' && body[1].y.type === 'Binary' && body[1].value.value === 4;
  })());

  // negatives
  bad('VIEW3D twice', '    v = 1', /VIEW3D may appear only once/, { view: 'VIEW3D level\nVIEW3D level\n' });
  bad('VIEW3D inside a SCENE', '    v = 1', /VIEW3D must be at the top level/, { view: '', decl: 'DIM v, w, k\n  VIEW3D level' });
  bad('VIEW3D inside a PROC', '    VIEW3D level', /VIEW3D must be at the top level/);
  bad('VIEW3D of an undeclared map', '    v = 1', /not a declared MAP/, { view: 'VIEW3D nowhere\n' });
  bad('VIEW3D of a sprite', '    v = 1', /SPRITE, not a MAP/, { view: 'VIEW3D p\n' });
  bad('VIEW3D without the map', '    v = 1', /expected a map name/, { view: 'VIEW3D\n' });
  bad('VIEW3D COLW 3', '    v = 1', /COLW is 3: it must be 2 or 4/, { view: 'VIEW3D level COLW 3\n' });
  bad('VIEW3D COLW 0', '    v = 1', /COLW is 0: it must be 2 or 4/, { view: 'VIEW3D level COLW 0\n' });
  bad('VIEW3D COLW 8', '    v = 1', /COLW is 8/, { view: 'VIEW3D level COLW 8\n' });
  bad('VIEW3D COLW twice', '    v = 1', /at most one COLW clause/, { view: 'VIEW3D level COLW 2 COLW 4\n' });
  bad('VIEW3D INK twice', '    v = 1', /at most one INK clause/, { view: 'VIEW3D level INK 2 INK 3\n' });
  bad('VIEW3D BRIGHT twice', '    v = 1', /at most one BRIGHT clause/, { view: 'VIEW3D level BRIGHT 1 BRIGHT 0\n' });
  bad('VIEW3D INK 8', '    v = 1', /INK is 8: it must be 0\.\.7/, { view: 'VIEW3D level INK 8\n' });
  bad('VIEW3D CEIL -1', '    v = 1', /CEIL is -1: it must be 0\.\.7/, { view: 'VIEW3D level CEIL -1\n' });
  bad('VIEW3D FLOOR 9', '    v = 1', /FLOOR is 9: it must be 0\.\.7/, { view: 'VIEW3D level FLOOR 9\n' });
  bad('VIEW3D BRIGHT 2', '    v = 1', /BRIGHT is 2: it must be 0\.\.1/, { view: 'VIEW3D level BRIGHT 2\n' });
  bad('VIEW3D COLW from a variable', '    v = 1', /COLW must be a constant expression/, { top: 'DIM q\n', view: 'VIEW3D level COLW q\n' });
  bad('VIEW3D INK from a string', '    v = 1', /must be a number/, { view: 'VIEW3D level INK "a"\n' });
  bad('VIEW3D a clause with no value', '    v = 1', /expected an expression/, { view: 'VIEW3D level COLW\n' });
  bad('VIEW3D PATTERNS with 15 bytes', '    v = 1', /PATTERNS needs 16 bytes.*got 15/, { view: 'VIEW3D level PATTERNS 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15\n' });
  bad('VIEW3D PATTERNS with 17 bytes', '    v = 1', /PATTERNS needs 16 bytes.*got 17/, { view: 'VIEW3D level PATTERNS 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17\n' });
  bad('VIEW3D PATTERNS byte 256', '    v = 1', /PATTERNS byte 15 is 256: it must be 0\.\.255/, { view: 'VIEW3D level PATTERNS 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 256\n' });
  bad('VIEW3D PATTERNS twice', '    v = 1', /at most one PATTERNS clause/, { view: 'VIEW3D level PATTERNS 1, 2 PATTERNS 3\n' });
  bad('VIEW3D junk after the clauses', '    v = 1', /unexpected|expected/, { view: 'VIEW3D level COLW 2 3\n' });
  // the window words in a VIEW3D program: one message
  for (const [what, body, o] of [
    ['WINDOW', '    v = 1', { view: 'VIEW3D level\nWINDOW level\n' }],
    ['CAMERA', '    CAMERA 5', {}],
    ['SETWORLD', '    SETWORLD 1, 2 = 3', {}],
    ['CAMX()', '    v = CAMX()', {}],
    ['WORLDTILE()', '    v = WORLDTILE(1, 2)', {}],
    ['TILEFLAGS()', '    v = TILEFLAGS(1, 2)', {}],
    ['TILEHIT()', '    v = TILEHIT(1, 2, 3, 4, 5)', {}],
    ['SOLID()', '    v = SOLID(1, 2, 3, 4)', {}],
  ]) {
    const e = errs(prog(body, o));
    check_(`${what} in a VIEW3D program: one error that says it cannot be used with VIEW3D`, e.length === 1 && e[0].message.startsWith(what + ' cannot be used in a program with a VIEW3D') && /v3 runtime/.test(e[0].message), msgs(e));
  }
  { const e = errs(prog('    CAMERA 5\n    v = CAMX() + SOLID(1, 2, 3, 4)\n    SETWORLD 1, 2 = 3', { view: 'VIEW3D level\nWINDOW level\nBAND 16, 1, 1\n' })); check_('WINDOW, BAND, CAMERA, CAMX, SOLID, SETWORLD together in a VIEW3D program: still exactly one message', e.length === 1, msgs(e)); }
  { const e = errs(prog('    v = 1', { view: 'WINDOW level\nVIEW3D level\n' })); check_('WINDOW before the VIEW3D: the same one message (at the WINDOW)', e.length === 1 && /^WINDOW cannot be used/.test(e[0].message) && e[0].line === 6, msgs(e)); }
  bad('a window word on a known v4 runtime without a VIEW3D', '    v = 1', /WINDOW needs the v3 runtime \(the v4 runtime has the 3D view in place of the scrolling window\)/, { view: 'WINDOW level\n' });
  { const e = errs(prog('    CAMERA 5\n    v = CAMX()', { view: 'WINDOW level\nBAND 16, 1, 1\n' })); check_('on a v4 runtime the window words are one message too', e.length === 1, msgs(e)); }
  check_('the window words are fine when the runtime version is not known and there is no VIEW3D (check(ast))', (() => { const p = parse(prog('    CAMERA 5\n    v = CAMX()', { view: 'WINDOW level\n' })); return check(p.ast).filter((d) => d.severity === 'error').length === 0; })());
  // versions
  bad('VIEW3D on a v3 runtime', '    v = 1', /VIEW3D needs the v4 runtime.*--runtime v4/, {}, 3);
  bad('VIEW3D on a v2 runtime', '    v = 1', /VIEW3D needs the v4 runtime/, {}, 2);
  bad('VIEW on a v3 runtime', '    VIEW 1, 2, 3', /VIEW needs the v4 runtime/, { view: '' }, 3);
  bad('SETWALL on a v3 runtime', '    SETWALL 1, 2 = 3', /SETWALL needs the v4 runtime/, { view: '' }, 3);
  for (const [f, call] of [['COSA', 'COSA(v)'], ['SINA', 'SINA(v)'], ['FXMUL', 'FXMUL(v, w)'], ['WALL', 'WALL(v, w)'], ['SEEN', 'SEEN(p)'], ['DEPTH', 'DEPTH(p)']]) {
    bad(`${f}() on a v3 runtime`, `    v = ${call}`, new RegExp(`${f}\\(\\) needs the v4 runtime`), { view: '' }, 3);
    bad(`${f}() on a v2 runtime`, `    v = ${call}`, new RegExp(`${f}\\(\\) needs the v4 runtime`), { view: '' }, 2);
  }
  ok0('COSA SINA FXMUL are plain functions on v4 (no VIEW3D needed by the checker)', '    v = COSA(1) + SINA(2) + FXMUL(3, 4)', { view: '' });
  // statements and arguments
  bad('SETWALL type 5', '    SETWALL 1, 2 = 5', /the wall type is 5: it must be 0\.\.4/);
  bad('SETWALL type -1', '    SETWALL 1, 2 = -1', /the wall type is -1/);
  bad('SETWALL a CONST type 9', '    SETWALL 1, 2 = BIGT', /the wall type is 9/, { top: 'CONST BIGT = 9\n' });
  ok0('SETWALL a variable type is not checked here (it is the runtime that ignores it)', '    SETWALL 1, 2 = v');
  bad('VIEW with two arguments', '    VIEW 1, 2', /expected ','/);
  bad('VIEW with a string', '    VIEW "a", 2, 3', /x must be a number/);
  bad('SETWALL without =', '    SETWALL 1, 2', /expected '=' and the wall type/);
  bad('SETWALL with a string type', '    SETWALL 1, 2 = "a"', /the wall type must be a number/);
  bad('COSA with no argument', '    v = COSA()', /COSA takes 1 argument, got 0/);
  bad('FXMUL with one argument', '    v = FXMUL(1)', /FXMUL takes 2 arguments, got 1/);
  bad('WALL with three arguments', '    v = WALL(1, 2, 3)', /WALL takes 2 arguments, got 3/);
  bad('SEEN of a number', '    v = SEEN(3)', /expected a sprite name/);
  bad('SEEN of an undeclared sprite', '    v = SEEN(nobody)', /not a declared SPRITE/);
  bad('DEPTH of a map', '    v = DEPTH(level)', /MAP, not a SPRITE/);
  bad('VIEW is a statement: a value is an error', '    v = VIEW(1, 2, 3)', /./);
  bad('WALL is a function: not a statement', '    WALL(1, 2)', /WALL is a function/);
  bad('WALL without brackets', '    v = WALL', /WALL is a function: write WALL\(x, y\)/);
  bad('a variable called wall', '    v = 1', /reserved word/, { decl: 'DIM v, wall' });
  bad('a variable called depth', '    v = 1', /reserved word/, { decl: 'DIM v, depth' });
  bad('a PROC called view', '    v = 1', /reserved word/, { procs: '  PROC view()\n  ENDP\n' });
  bad('LOADMAP of the view\'s map', '    LOADMAP level', /LOADMAP: 'level' is the floor plan of the VIEW3D/);
  ok0('LOADMAP of a HUD map stays fine in a VIEW3D program', '    LOADMAP hud', { top: 'MAP hud = "hud"\n' });
  // the refresh budget
  warn1('FRAMERATE 30 (2 refreshes) is below the minimum 3 for 4-pixel columns', '    v = 1', /FRAMERATE 30 is 2 refreshes a tick.*FRAMERATE 20 or lower/, { rate: 'FRAMERATE 30\n' });
  warn1('no FRAMERATE means 30 a second: the same warning', '    v = 1', /without a FRAMERATE the game runs at 30 a second/, { rate: '' });
  noWarn('FRAMERATE 20 (3 refreshes) is enough for 4-pixel columns', '    v = 1', /refreshes? a tick/, { rate: 'FRAMERATE 20\n' });
  warn1('COLW 2 at FRAMERATE 20 (3 refreshes) is below the minimum 5', '    v = 1', /FRAMERATE 20 is 3 refreshes a tick.*FRAMERATE 12 or lower/, { rate: 'FRAMERATE 20\n', view: 'VIEW3D level COLW 2\n' });
  warn1('COLW 2 at FRAMERATE 15 (4 refreshes): warns', '    v = 1', /4 refreshes a tick/, { rate: 'FRAMERATE 15\n', view: 'VIEW3D level COLW 2\n' });
  noWarn('COLW 2 at FRAMERATE 12 (5 refreshes): no warning', '    v = 1', /refreshes? a tick/, { rate: 'FRAMERATE 12\n', view: 'VIEW3D level COLW 2\n' });
  noWarn('COLW 2 at FRAMERATE 10 (6 refreshes): no warning', '    v = 1', /refreshes? a tick/, { rate: 'FRAMERATE 10\n', view: 'VIEW3D level COLW 2\n' });
  warn1('FRAMERATE 60 (1 refresh) names the singular', '    v = 1', /1 refresh a tick/, { rate: 'FRAMERATE 60\n' });
  noWarn('no VIEW3D, no warning', '    v = 1', /refreshes? a tick/, { rate: 'FRAMERATE 30\n', view: '' });
}

// =================================================================================================================
// 2. The word table
// =================================================================================================================
console.log('\n2. The word table: reserved words, contextual words, assets with batch 3 names');
{
  const NEW = ['VIEW3D', 'VIEW', 'SETWALL', 'COSA', 'SINA', 'FXMUL', 'WALL', 'SEEN', 'DEPTH'];
  check_('the nine words are in the table and reserved', NEW.every((w) => ARCADE_WORDS.has(w) && RESERVED.has(w)));
  check_('BATCH3_WORDS lists exactly those nine', BATCH3_WORDS.size === 9 && NEW.every((w) => BATCH3_WORDS.has(w)));
  check_('COSA SINA FXMUL WALL SEEN DEPTH are functions (return numbers); VIEW3D VIEW SETWALL are game words', ['COSA', 'SINA', 'FXMUL', 'WALL', 'SEEN', 'DEPTH'].every((w) => FUNCTIONS.has(w) && FUNCTIONS.get(w).ret === 'num') && ['VIEW3D', 'VIEW', 'SETWALL'].every((w) => ARCADE_WORDS.get(w).cls === 'game'));
  check_('argument lists: COSA(a) SINA(a) FXMUL(a, b) WALL(x, y) SEEN(sprite) DEPTH(sprite)', FUNCTIONS.get('COSA').args.length === 1 && FUNCTIONS.get('FXMUL').args.length === 2 && FUNCTIONS.get('WALL').args.length === 2 && FUNCTIONS.get('SEEN').args[0].type === 'sprite' && FUNCTIONS.get('DEPTH').args[0].type === 'sprite');
  check_('COLW CEIL FLOOR PATTERNS are in the table (for Help and completion) but contextual', ['COLW', 'CEIL', 'FLOOR', 'PATTERNS'].every((w) => ARCADE_WORDS.has(w) && !RESERVED.has(w)));
  check_('every new entry has a syntax and a description', [...NEW, 'COLW', 'CEIL', 'FLOOR', 'PATTERNS'].every((w) => ARCADE_WORDS.get(w).syntax.length > 0 && ARCADE_WORDS.get(w).desc.length > 40));
  check_('INK and BRIGHT stay the existing words (the VIEW3D clauses reuse them)', ARCADE_WORDS.get('INK').cls === 'statement' && RESERVED.has('INK') && RESERVED.has('BRIGHT'));
  // assets with batch 3 names
  const SRC = `GAME "t"\nFRAMERATE 12\nSFX wall = "wall"\nSPRITE depth = "orb"\nSPRITE seen = "guard"\nMAP view = "maze"\nVIEW3D view\nSCENE s\n  DIM v\n  PROC INIT()\n    PLAY wall\n    SHOW depth AT 1, 2\n    SHOW seen AT 3, 4\n    v = HIT(depth, seen) + SEEN(depth) + DEPTH(seen)\n    HIDE depth\n    VIEW 300, 300, 0\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`;
  const e = errs(SRC);
  check_('an asset may be called wall, depth, seen, view (they have a name space of their own): SFX wall, PLAY wall, SPRITE depth, SHOW, HIDE, HIT, SEEN, DEPTH, MAP view', e.length === 0, msgs(e));
  { const as = withMap('maze', ASSETS.maps.maze); void as; }
  const e2 = errs(`GAME "t"\nSFX wall = "wall"\nSCENE s\n  DIM wall\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`);
  check_('but a VARIABLE called wall is still refused', e2.some((d) => /reserved word/.test(d.message)), msgs(e2));
  const e3 = errs(`GAME "t"\nSCENE s\n  DIM v\n  PROC INIT()\n    v = WALL + 1\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`);
  check_('WALL used as a plain name says it is a function and shows the form', e3.some((d) => /WALL is a function: write WALL\(x, y\)/.test(d.message)), msgs(e3));
  // the old behaviour of breakout.arc: SFX wall
  const bo = readFileSync(join(ROOT, 'arcade/examples/breakout.arc'), 'utf8');
  check_('breakout.arc (SFX wall = "wall", PLAY wall) still parses and checks with no errors', errs(bo, 1).length === 0, msgs(errs(bo, 1)));
}

// =================================================================================================================
// 3. Data builders and the maths
// =================================================================================================================
console.log('\n3. The maths and the data builders against independent models');
{
  check_('the cosine table: 256 entries equal round(4096 * cos(2 pi a / 256)) (the mirrored Q[k] of the contract)', COS4096.every((c, a) => VIEW.COS_TABLE[a] === c), COS4096.map((c, a) => (VIEW.COS_TABLE[a] === c ? '' : `${a}: ${VIEW.COS_TABLE[a]} vs ${c}`)).filter(Boolean).slice(0, 3).join('; '));
  check_('Q[k] = round(4096 sin(k pi / 128)), k = 0..64 (65 values, Q[0] = 0, Q[64] = 4096)', VIEW.Q.length === 65 && VIEW.Q[0] === 0 && VIEW.Q[64] === 4096 && VIEW.Q.every((q, k) => q === Math.round(4096 * Math.sin(k * Math.PI / 128))));
  check_('COSA(a) and SINA(a) for all 256 angles equal the independent model', Array.from({ length: 256 }, (_, a) => a).every((a) => VIEW.cosa(a) === cosModel(a) && VIEW.sina(a) === sinModel(a)));
  check_('COSA / SINA take the angle AND 255 for any 16-bit value (negative, > 255)', [-1, -256, -300, 256, 257, 511, 1000, 32767, -32768].every((a) => VIEW.cosa(a) === cosModel(a & 255) && VIEW.sina(a) === sinModel(a & 255)));
  check_('COSA/SINA hand values: COSA(0)=256 COSA(64)=0 COSA(128)=-256 COSA(192)=0 SINA(0)=0 SINA(64)=256 SINA(128)=0 SINA(192)=-256', [[VIEW.cosa(0), 256], [VIEW.cosa(64), 0], [VIEW.cosa(128), -256], [VIEW.cosa(192), 0], [VIEW.sina(0), 0], [VIEW.sina(64), 256], [VIEW.sina(128), 0], [VIEW.sina(192), -256]].every(([g, w]) => g === w));
  check_('COSA(32) = 181 and SINA(32) = 181 (4096 cos 45 = 2896, +8, >> 4), COSA(96) = -181', VIEW.cosa(32) === 181 && VIEW.sina(32) === 181 && VIEW.cosa(96) === -181);
  check_('range -256..256 and COSA(a)^2 + SINA(a)^2 within 2% of 65536 for every angle', Array.from({ length: 256 }, (_, a) => a).every((a) => Math.abs(VIEW.cosa(a)) <= 256 && Math.abs(VIEW.sina(a)) <= 256 && Math.abs(VIEW.cosa(a) ** 2 + VIEW.sina(a) ** 2 - 65536) < 65536 * 0.02));
  const r = rng(0xF00D);
  let bad1 = 0;
  for (let i = 0; i < 20000; i++) {
    const a = Math.floor(r() * 65536) - 32768, b = Math.floor(r() * 65536) - 32768;
    if (VIEW.fxmul(a, b) !== fxmulModel(a, b)) bad1++;
  }
  check_('FXMUL on 20,000 random 16-bit pairs equals the BigInt model', bad1 === 0, `${bad1} differ`);
  check_('FXMUL hand values: (256,256)=256, (-1,1)=-1 (floor), (3,-128)=-2, (32767,32767)=-256 (wrapped), (-32768,-32768)=0 (2^30 >> 8 = 2^22 wraps), (1,1)=0, (0,-5)=0, (300,3)=3', [[256, 256, 256], [-1, 1, -1], [3, -128, -2], [32767, 32767, -256], [-32768, -32768, 0], [1, 1, 0], [0, -5, 0], [300, 3, 3]].every(([a, b, w]) => VIEW.fxmul(a, b) === w && fxmulModel(a, b) === w));
  // the view map
  const m = VIEW.convertViewMap(ASSETS.maps.maze);
  check_('convertViewMap: 12 x 12, row-major cells, the 32-stride array with wall type 1 outside', m.w === 12 && m.h === 12 && m.cells.length === 144 && m.ram.length === 1024 && ASSETS.maps.maze.cells.every((v, i) => m.cells[i] === v && m.ram[((i / 12) | 0) * 32 + (i % 12)] === v) && m.ram[12] === 1 && m.ram[11 * 32 + 12] === 1 && m.ram[12 * 32] === 1 && m.ram[31 * 32 + 31] === 1);
  check_('convertViewMap: -1 / null / 255 are blank = 0 inside; hex strings work; sizes 4..32', (() => {
    const mm = VIEW.convertViewMap({ w: 4, h: 4, cells: [1, 1, 1, 1, 1, -1, null, 1, 1, 255, 0, 1, 1, 1, 1, 1] });
    const h = VIEW.convertViewMap(ASSETS.maps.hexmap);
    return mm.cells[5] === 0 && mm.cells[6] === 0 && mm.cells[9] === 0 && mm.cells[10] === 0 && h.cells[5] === 0 && h.cells[0] === 1 && VIEW.convertViewMap(ASSETS.maps.big).w === 32 && VIEW.convertViewMap(ASSETS.maps.small).h === 4;
  })());
  const throws = (fn, rx) => { try { fn(); return false; } catch (e) { return rx.test(e.message); } };
  check_('convertViewMap refuses 3 wide, 33 wide, a cell of 5, an empty ring cell (with its row and column), a blank ring cell, wrong cell count, non-hex text', throws(() => VIEW.convertViewMap(ASSETS.maps.tiny3), /width.*4\.\.32/) && throws(() => VIEW.convertViewMap(ASSETS.maps.huge33), /width.*4\.\.32/) && throws(() => VIEW.convertViewMap(ASSETS.maps.cell5), /row 2, column 2 is 5/) && throws(() => VIEW.convertViewMap(ASSETS.maps.emptyring), /row 5, column 2 is empty.*outer ring/) && throws(() => VIEW.convertViewMap(ASSETS.maps.blankring), /row 0, column 3 is empty/) && throws(() => VIEW.convertViewMap({ w: 4, h: 4, cells: [1] }), /16 cells but/) && throws(() => VIEW.convertViewMap({ w: 4, h: 4, cells: 'xyz' }), /hex/));
  const mod = viewModel(12, 12, ASSETS.maps.maze.cells);
  check_('the array model: WALL at the edges (negative, 8192, the 32 x 32 array, map interior)', [[-1, 0], [0, -1], [8192, 0], [0, 8192], [8191, 8191], [300, 300], [1000, 1000], [3071, 3071], [3072, 100], [11 * 256, 5 * 256]].every(([x, y]) => VIEW.wallAt(m.ram, x, y) === mod.wall(x, y)));
  check_('WALL hand values on the maze: (300,300)=0, (0,0)=1, (2*256+10, 2*256+10)=2, (6*256, 4*256)=4... row 2 col 6 is 4', VIEW.wallAt(m.ram, 300, 300) === 0 && VIEW.wallAt(m.ram, 0, 0) === 1 && VIEW.wallAt(m.ram, 2 * 256 + 10, 2 * 256 + 10) === 2 && VIEW.wallAt(m.ram, 6 * 256, 2 * 256) === 4 && VIEW.wallAt(m.ram, -1, 300) === 1 && VIEW.wallAt(m.ram, 12 * 256, 300) === 1);
  const ram2 = m.ram.slice();
  check_('setWallAt writes inside the map only: (1,1) inside, x < 0, (12,0) outside the 12 x 12 though inside the array, t 5 and -1 ignored', VIEW.setWallAt(ram2, 12, 12, 256, 256, 3) && ram2[32 + 1] === 3 && !VIEW.setWallAt(ram2, 12, 12, -1, 0, 3) && !VIEW.setWallAt(ram2, 12, 12, 12 * 256, 0, 3) && ram2[12] === 1 && !VIEW.setWallAt(ram2, 12, 12, 256, 256, 5) && !VIEW.setWallAt(ram2, 12, 12, 256, 256, -1) && ram2[33] === 3 && VIEW.setWallAt(ram2, 12, 12, 11 * 256 + 255, 11 * 256 + 255, 0) && ram2[11 * 32 + 11] === 0);
  check_('clampPose: inside kept, negative to 0, beyond to map * 256 - 1, the angle AND 255', (() => {
    const p = VIEW.clampPose(12, 8, 100, 200, 77), q = VIEW.clampPose(12, 8, -5, 9999, 300), s = VIEW.clampPose(12, 8, 12 * 256, 8 * 256 - 1, -1);
    return p.x === 100 && p.y === 200 && p.a === 77 && q.x === 0 && q.y === 8 * 256 - 1 && q.a === 44 && s.x === 3071 && s.y === 2047 && s.a === 255 && mod.pose(-5, 9999, 300).a === q.a;
  })());
  check_('viewAttr: bright << 6 | paper << 3 | ink (defaults 0x47 and 0x4F; BRIGHT 0 INK 3 CEIL 4 FLOOR 6 gives 0x23 and 0x33)', VIEW.viewAttr(1, 0, 7) === 0x47 && VIEW.viewAttr(1, 1, 7) === 0x4F && VIEW.viewAttr(0, 4, 3) === 0x23 && VIEW.viewAttr(0, 6, 3) === 0x33 && VIEW.viewAttr(1, 7, 7) === 0x7F);
  const vd = VIEW.buildViewDesc({ colw: 2, mapW: 12, mapH: 9, attrTop: 0x47, attrBottom: 0x4F, mapSrc: 0x9234, patterns: 0x91A0 });
  check_('buildViewDesc: 10 bytes colw, map_w, map_h, attr_top, attr_bottom, map_src, patterns, flags', vd.length === 10 && [...vd].join() === [2, 12, 9, 0x47, 0x4F, 0x34, 0x92, 0xA0, 0x91, 0].join());
  const rl = rleEncode(m.cells);
  check_('the map\'s byte-RLE round trip (count 1..255, value, a count of 0 ends); the 32 x 32 big map splits runs over 255', (() => { const d = rleDecode(rl); return m.cells.every((v, i) => d[i] === v) && rl[rl.length - 1] === 0 && rleEncode(new Uint8Array(1024).fill(1)).join() === [255, 1, 255, 1, 255, 1, 255, 1, 4, 1, 0].join(); })());
}

// =================================================================================================================
// 4. The reference interpreter, hand-computed
// =================================================================================================================
console.log('\n4. The reference interpreter, hand-computed');
{
  const run = (body, o = {}, ticks = 0, assets = ASSETS, extra = {}) => interpret(parse(prog(body, { decl: 'DIM v, w, k, r(20)', ...o })).ast, { version: 4, ticks, assets, ...extra });
  const I = (body, o) => run(body, o, 1).ticks[0];
  let i = I('    v = COSA(0) : w = COSA(64) : k = COSA(128)\n    r(0) = COSA(192) : r(1) = SINA(0) : r(2) = SINA(64) : r(3) = SINA(128) : r(4) = SINA(192) : r(5) = COSA(32) : r(6) = SINA(96) : r(7) = COSA(-64) : r(8) = SINA(320)');
  check_('COSA / SINA by hand: 256 0 -256 | 0 0 256 0 -256 | COSA(32)=181 SINA(96)=181 COSA(-64)=0 SINA(320)=SINA(64)=256', i.vars.V === 256 && i.vars.W === 0 && i.vars.K === -256 && [0, 0, 256, 0, -256, 181, 181, 0, 256].every((x, n) => i.arrays.R[n] === x), JSON.stringify(i.vars) + JSON.stringify(i.arrays.R));
  i = I('    v = FXMUL(256, 256) : w = FXMUL(-1, 1) : k = FXMUL(3, -128)\n    r(0) = FXMUL(300, 3) : r(1) = FXMUL(-300, 3) : r(2) = FXMUL(32767, 32767) : r(3) = FXMUL(-32768, 128) : r(4) = FXMUL(1000, 1000)');
  check_('FXMUL by hand: 256 -1 -2 | 3, -4 (floor of -3.5), -256 (wrapped), -16384, 3906 (1000000 >> 8)', i.vars.V === 256 && i.vars.W === -1 && i.vars.K === -2 && [3, -4, -256, -16384, 3906].every((x, n) => i.arrays.R[n] === x), JSON.stringify(i.vars) + JSON.stringify(i.arrays.R.slice(0, 5)));
  // WALL on the 12 x 12 maze: row 2 = '1.22..4444.1', row 0 all 1
  i = I('    v = WALL(300, 300) : w = WALL(2 * 256 + 5, 2 * 256 + 5) : k = WALL(6 * 256, 2 * 256)\n    r(0) = WALL(-1, 300) : r(1) = WALL(300, -256) : r(2) = WALL(12 * 256, 300) : r(3) = WALL(300, 12 * 256) : r(4) = WALL(8191, 8191) : r(5) = WALL(100, 100) : r(6) = WALL(4 * 256 + 1, 4 * 256) : r(7) = WALL(5 * 256 - 1, 6 * 256 - 1)');
  check_('WALL by hand: (300,300)=0 floor, (2.02, 2.02)=2, (6,2)=4 | negative 1, east of the 12-wide map 1, south 1, the array corner 1, (100,100)=1 ring, row 4 col 4 empty, row 5 col 4 empty', i.vars.V === 0 && i.vars.W === 2 && i.vars.K === 4 && [1, 1, 1, 1, 1, 1, 0, 0].every((x, n) => i.arrays.R[n] === x), JSON.stringify(i.vars) + JSON.stringify(i.arrays.R.slice(0, 8)));
  // SETWALL
  i = I('    SETWALL 300, 300 = 3\n    r(0) = WALL(256, 256)\n    SETWALL 300, 300 = 9\n    r(1) = WALL(300, 300)\n    SETWALL 12 * 256, 256 = 4\n    r(2) = WALL(12 * 256, 256)\n    SETWALL -5, 300 = 4\n    r(3) = WALL(5, 300)\n    SETWALL 300, 300 = -1\n    r(4) = WALL(300, 300)\n    SETWALL 100, 100 = 0\n    r(5) = WALL(100, 100)\n    SETWALL 11 * 256 + 255, 11 * 256 + 255 = 2\n    r(6) = WALL(11 * 256, 11 * 256)\n    k = 7 : SETWALL 300, 300 = k\n    r(7) = WALL(300, 300) : r(8) = WALL(0, 0)');
  check_('SETWALL by hand: (1,1)=3 | t 9 ignored | beyond the map ignored (stays 1) | negative x ignored | t -1 ignored | the ring cell may be emptied | the last cell | a run-time 7 ignored', [3, 3, 1, 1, 3, 0, 2, 3, 0].every((x, n) => i.arrays.R[n] === x), JSON.stringify(i.arrays.R.slice(0, 9)));
  // VIEW pose
  const ps = (body) => run(body, {}, 1).ticks[0].view;
  const eq = (p, x, y, a) => p.x === x && p.y === y && p.a === a;
  check_('VIEW by hand: stored as given; x, y clamped into 0..map * 256 - 1 (12 cells: 3071); a AND 255', eq(ps('    VIEW 300, 400, 77'), 300, 400, 77) && eq(ps('    VIEW -5, 9999, 300'), 0, 3071, 44) && eq(ps('    VIEW 3071, 3072, -1'), 3071, 3071, 255) && eq(ps('    VIEW 0, 0, 256'), 0, 0, 0));
  check_('the pose starts at 0, 0, 0; the last VIEW wins; VIEW evaluates x, y, a in that order', (() => { const w = interpret(parse(prog('    VIEW v, w, k\n    v = v + 100 : w = w + 200 : k = k + 3', { decl: 'DIM v, w, k' })).ast, { version: 4, ticks: 2, assets: ASSETS }); return eq(w.init.view, 0, 0, 0) && eq(w.ticks[0].view, 0, 0, 0) && eq(w.ticks[1].view, 100, 200, 3); })());
  // SHOW in ray mode
  const sh = run('    SHOW p AT 40000, -5\n    SHOW c(1) AT 300, 800 FRAME 2', {}, 1).ticks[0];
  check_('SHOW in ray mode stores x, y as signed 16-bit, NOT clamped (40000 = -25536, -5)', sh.sprites[0].x === -25536 && sh.sprites[0].y === -5 && sh.sprites[0].visible === 1 && sh.sprites[2].x === 300 && sh.sprites[2].y === 800 && sh.sprites[2].frame === 2, JSON.stringify(sh.sprites.slice(0, 3)));
  // HIT in ray mode: R = 4 h; 16-high sprites: R = 64 + 64 = 128; the hot box is ignored; hidden never hit
  const hit = (ax, ay, bx, by, mid = '') => run(`    SHOW p AT ${ax}, ${ay}\n    SHOW c(0) AT ${bx}, ${by}\n${mid}    v = HIT(p, c(0))`, {}, 1).ticks[0].vars.V;
  check_('HIT in ray mode: 16-high sprites hit when |dx| < 128 and |dy| < 128 (127 yes, 128 no, in both axes, both signs)', hit(1000, 1000, 1127, 1127) === 1 && hit(1000, 1000, 1128, 1000) === 0 && hit(1000, 1000, 1000, 1128) === 0 && hit(1000, 1000, 873, 873) === 1 && hit(1000, 1000, 872, 1000) === 0 && hit(1000, 1000, 1000, 1000) === 1);
  check_('HIT: a hidden instance never hits; an instance outside its pool gives 0', hit(1000, 1000, 1000, 1000, '    HIDE c(0)\n') === 0 && run('    SHOW p AT 1, 1\n    v = HIT(p, c(5)) + HIT(p, c(-1))', {}, 1).ticks[0].vars.V === 0);
  { const big = run('    SHOW g AT 1000, 1000\n    SHOW p AT 1000, 1000 + 300\n    v = HIT(g, p) : k = HIT(g, pl)', { sprites: 'SPRITE g = "giant"\nSPRITE p = "orb"\nSPRITE pl = "pill"\n' }, 1).ticks[0]; check_('HIT uses each sprite\'s own h: giant (32 high, R 128) + orb (16, R 64) = 192: dy 300 misses; with dy 191 it hits', big.vars.V === 0 && run('    SHOW g AT 1000, 1000\n    SHOW p AT 1000, 1191\n    v = HIT(g, p)', { sprites: 'SPRITE g = "giant"\nSPRITE p = "orb"\n' }, 1).ticks[0].vars.V === 1); }
  check_('HIT compares the unsigned 16-bit positions (a sprite stored at 40000 and one at 40100 hit; 40000 and 100 do not)', hit(40000, 0, 40100, 0) === 1 && hit(40000, 0, 100, 0) === 0);
  // SEEN / DEPTH
  const bb = (t, n) => (t === 1 && n === 0 ? { depth: 700, col: 64 } : t === 1 && n === 2 ? { depth: 4096, col: 0 } : t === 2 && n === 0 ? { depth: 33, col: 127 } : undefined);
  const sd = interpret(parse(prog('    v = SEEN(p) : w = DEPTH(p) : k = SEEN(c(1)) : r(0) = DEPTH(c(1)) : r(1) = SEEN(c(0)) : r(2) = SEEN(c(7)) : r(3) = DEPTH(c(7)) : r(4) = SEEN(c(-1)) : r(5) = DEPTH(c(k + 2))', { decl: 'DIM v, w, k, r(20)' })).ast, { version: 4, ticks: 2, assets: ASSETS, billboard: bb });
  check_('SEEN / DEPTH read what the harness injects for the tick: tick 1: p seen at 64, depth 700; c(1) (instance 2) col 0 depth 4096; c(0) not seen; c(7) / c(-1) (outside the pool) -1 and 0', sd.ticks[0].vars.V === 64 && sd.ticks[0].vars.W === 700 && sd.ticks[0].vars.K === 0 && sd.ticks[0].arrays.R[0] === 4096 && sd.ticks[0].arrays.R[1] === -1 && sd.ticks[0].arrays.R[2] === -1 && sd.ticks[0].arrays.R[3] === 0 && sd.ticks[0].arrays.R[4] === -1, JSON.stringify(sd.ticks[0].vars) + JSON.stringify(sd.ticks[0].arrays.R.slice(0, 6)));
  check_('SEEN / DEPTH tick 2 uses that tick\'s values; with nothing injected nothing is seen (-1, 0)', sd.ticks[1].vars.V === 127 && sd.ticks[1].vars.W === 33 && sd.ticks[1].vars.K === -1 && I('    v = SEEN(p) : w = DEPTH(p) : k = SEEN(c(2))').vars.V === -1 && I('    v = SEEN(p) : w = DEPTH(p)').vars.W === 0);
  check_('a col above 32767 reads as the signed value ($FFFF is -1); a billboard function may return col 65535', (() => { const w = interpret(parse(prog('    v = SEEN(p)', { decl: 'DIM v' })).ast, { version: 4, ticks: 1, assets: ASSETS, billboard: () => ({ depth: 5, col: 0xFFFF }) }); return w.ticks[0].vars.V === -1; })());
  // record
  const rec = run('    SETWALL 300, 300 = 4\n    VIEW 1, 2, 3', {}, 1).ticks[0];
  check_('the record carries view {x, y, a} and a copy of the 1,024-byte array', rec.view.x === 1 && rec.wallRam.length === 1024 && rec.wallRam[32 + 1] === 4 && ASSETS.maps.maze.cells[13] === 0);
  check_('a game without a VIEW3D has no view in its record', (() => { const w = interpret(parse(prog('    v = COSA(64)', { view: '', decl: 'DIM v' })).ast, { version: 4, ticks: 1, assets: ASSETS }); return w.ticks[0].view === undefined && w.ticks[0].vars.V === 0 || w.ticks[0].vars.V === 256 ? w.ticks[0].view === undefined : false; })());
  check_('WALL / VIEW / SETWALL / SEEN without a VIEW3D are "unsupported" in the interpreter (the compiler refuses them first)', ['v = WALL(1, 2)', 'VIEW 1, 2, 3', 'SETWALL 1, 2 = 3', 'v = SEEN(p)', 'v = DEPTH(p)'].every((s) => { try { interpret(parse(prog('    ' + s, { view: '', decl: 'DIM v' })).ast, { version: 4, ticks: 1, assets: ASSETS }); return false; } catch (e) { return /unsupported/.test(e.message); } }));
  // a window game is unchanged by the batch: the batch 2 clamp still applies without a VIEW3D (v3, no window)
  const v3c = interpret(parse('GAME "t"\nSPRITE p = "orb"\nSCENE s\n PROC INIT()\n  SHOW p AT 1000, -5\n ENDP\n PROC FRAME()\n ENDP\nENDSCENE\n').ast, { version: 3, ticks: 0, assets: ASSETS }).init;
  check_('without a VIEW3D SHOW keeps its per-asset clamp on v3 (240, 0)', v3c.sprites[0].x === 240 && v3c.sprites[0].y === 0);
}

// =================================================================================================================
// 5. The code generator and the linker
// =================================================================================================================
console.log('\n5. The code generator and the linker: header, view_desc, map_src, attributes, descriptors, errors, refusals');
const dckArea = (res) => res.dck.slice(9 + 2 * 8192, 9 + 4 * 8192);        // chunks 4-5: $8000-$BFFF
{
  const MIN = (extra = '', view = 'VIEW3D level') => `GAME "t"\nFRAMERATE 12\nMAP level = "maze"\nSPRITE o = "orb"\n${extra}${view}\nSCENE s\n  DIM v\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    VIEW 300, 300, v\n  ENDP\nENDSCENE\n`;
  const res = cm(MIN());
  check_('the minimal VIEW3D game compiles on the mock v4 runtime', res.errors.length === 0 && !!res.dck, errText(res));
  const m = res.memory, rd = (a) => m[a] | (m[a + 1] << 8);
  check_('header: frame_div | DIV_EXT | DIV_VIEW = 5 | $80 | $40 = $C5 at +4', m[0x8004] === (5 | 0x80 | 0x40), `$${m[0x8004].toString(16)}`);
  check_('header: 20 bytes: sprite_count +5, sprite_table +6 = $8014, map_table +16 = 0, view_desc +18, inst_table +14', m[0x8005] === 1 && rd(0x8006) === 0x8014 && rd(0x8010) === 0 && rd(0x8012) > 0x8014 && rd(0x800E) > 0x8014);
  const vd = rd(0x8012);
  const maze = ASSETS.maps.maze;
  check_('view_desc: colw 4, map_w 12, map_h 12, attr_top $47, attr_bottom $4F, patterns 0, flags 0', [m[vd], m[vd + 1], m[vd + 2], m[vd + 3], m[vd + 4], rd(vd + 7), m[vd + 9]].join() === [4, 12, 12, 0x47, 0x4F, 0, 0].join(), [...m.slice(vd, vd + 10)].join());
  check_('map_src points at the byte-RLE of the 144-cell map in row-major order (stride = map_w) and the descriptor follows it', (() => {
    const at = rd(vd + 5), stream = []; let p = at;
    while (m[p] !== 0) { stream.push(m[p], m[p + 1]); p += 2; }
    const d = rleDecode(Uint8Array.from([...stream, 0])).slice(0, 144);
    return maze.cells.every((v, i) => d[i] === v) && p + 1 === vd && rleDecode(Uint8Array.from([...stream, 0])).slice(144).every((x) => x === 0);
  })());
  check_('the DCK carries the same game area as the memory image', Buffer.compare(Buffer.from(dckArea(res)), Buffer.from(m.slice(0x8000, 0xC000))) === 0 && res.dck.length === 9 + 4 * 8192);
  check_('no phase pool and no scroll tables in a ray-mode image: the report has a view, no window, no phaseRam', !!res.usage.view && !res.usage.window && !res.usage.phaseRam && res.usage.view.mapW === 12 && res.usage.view.mapExpanded === 1024 && res.usage.view.descriptor === 10 && res.usage.view.mapSource === rleEncode(Uint8Array.from(maze.cells)).length);
  check_('ray mode plans no phase pool: the generator result has phase null', res.gen.phase === null && res.gen.view.colw === 4);
  // clauses
  const c2 = cm(MIN('', 'VIEW3D level COLW 2 INK 3 CEIL 4 FLOOR 6 BRIGHT 0'));
  const v2 = c2.memory[0x8012] | (c2.memory[0x8013] << 8);
  check_('clauses: COLW 2 INK 3 CEIL 4 FLOOR 6 BRIGHT 0 gives colw 2, attr_top $23, attr_bottom $33', [c2.memory[v2], c2.memory[v2 + 3], c2.memory[v2 + 4]].join() === [2, 0x23, 0x33].join(), errText(c2));
  const c3 = cm(MIN('CONST K = 5\n', 'VIEW3D level FLOOR K INK K + 1 CEIL K - 4'));
  const v3 = c3.memory[0x8012] | (c3.memory[0x8013] << 8);
  check_('clause values are folded constants: FLOOR 5, INK 6, CEIL 1 with BRIGHT 1 gives $4E and $6E', c3.memory[v3 + 3] === (0x40 | 8 | 6) && c3.memory[v3 + 4] === (0x40 | 5 << 3 | 6), errText(c3));
  const pat = [255, 255, 170, 85, 238, 187, 136, 34, 255, 0, 170, 0, 204, 204, 136, 136];
  const c4 = cm(MIN('', `VIEW3D level PATTERNS ${pat.join(', ')} COLW 2`));
  const v4 = c4.memory[0x8012] | (c4.memory[0x8013] << 8), pp = c4.memory[v4 + 7] | (c4.memory[v4 + 8] << 8);
  check_('PATTERNS: view_desc +7 points at the 16 bytes, which sit between map_src and the descriptor', pp !== 0 && pat.every((b, i) => c4.memory[pp + i] === b) && pp + 16 === v4 && c4.usage.view.patterns === 16, errText(c4));
  // the hex map and the biggest and smallest
  for (const [name, w, h] of [['hexmap', 4, 4], ['small', 4, 4], ['big', 32, 32], ['wide', 32, 5], ['strip', 5, 32]]) {
    const r = cm(MIN().replace('"maze"', `"${name}"`));
    const a = r.memory[0x8012] | (r.memory[0x8013] << 8);
    check_(`a ${name} map (${w} x ${h}) compiles with map_w ${w}, map_h ${h} in the descriptor and the whole map in map_src`, r.errors.length === 0 && r.memory[a + 1] === w && r.memory[a + 2] === h && (() => {
      const cells = VIEW.convertViewMap(ASSETS.maps[name]).cells, at = r.memory[a + 5] | (r.memory[a + 6] << 8), st = [];
      for (let p = at; r.memory[p] !== 0; p += 2) st.push(r.memory[p], r.memory[p + 1]);
      const d = rleDecode(Uint8Array.from([...st, 0]));
      return cells.every((v, i) => d[i] === v);
    })(), errText(r));
  }
  // sprites in ray mode: frames, FLIP, descriptors, no pool
  const sp = cm(`GAME "t"\nFRAMERATE 12\nMAP level = "maze"\nSPRITE g(2) = "guard"\nSPRITE b = "big48"\nSPRITE gi = "giant"\nVIEW3D level\nSCENE s\n  DIM v\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    SHOW g(v) AT 1, 2 FRAME v\n    SHOW b AT 5, 6\n    SHOW gi AT 5, 6 FLIP\n    VIEW 300, 300, v\n  ENDP\nENDSCENE\n`);
  check_('sprites compile as v3 frames without a pool: guard 3 frames, big48 (32 x 48) 1 frame, giant FLIP 2 + 2 mirrored; 3 assets 4 instances', sp.errors.length === 0 && sp.gen.sprites.length === 3 && sp.gen.sprites[0].nframes === 3 && sp.gen.sprites[1].nframes === 1 && sp.gen.sprites[1].h === 48 && sp.gen.sprites[2].nframes === 2 && sp.gen.v2.ninst === 4, errText(sp));
  check_('the sprite descriptors in the image: width, height, nframes at +7', (() => { const d = 0x8014; return [0, 1, 2].every((i) => sp.memory[d + 8 * i] === sp.gen.sprites[i].w && sp.memory[d + 8 * i + 1] === sp.gen.sprites[i].h && sp.memory[d + 8 * i + 7] === sp.gen.sprites[i].nframes); })());
  check_('a pool miss cannot happen in ray mode: many sprite assets with many frames fill only the game image (no phase-pool error)', (() => {
    const big = { ...ASSETS, sprites: { ...ASSETS.sprites, many: { w: 32, h: 48, phases: 8, frames: Array.from({ length: 16 }, () => ({ rows: Array.from({ length: 48 }, () => ({ bits: 'FFFFFFFF', mask: 'FFFFFFFF' })) })) } } };
    const r = cm(`GAME "t"\nFRAMERATE 12\nMAP level = "maze"\nSPRITE m(6) = "many"\nVIEW3D level\nSCENE s\n  DIM v\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    SHOW m(v) AT 1, 2 FRAME v\n  ENDP\nENDSCENE\n`, big);
    return r.errors.length === 0 || !/phase pool/.test(errText(r));
  })(), '');
  // the cell-map words around the window
  const hud = cm(`GAME "t"\nFRAMERATE 12\nTILESET ts = "ts"\nMAP level = "maze"\nMAP hud = "hud"\nVIEW3D level\nSCENE s\n  PROC INIT()\n    LOADMAP hud\n    TILE 1, 1 = 2\n    FILL 0, 0, 32, 2 = 1\n  ENDP\n  PROC FRAME()\n    VIEW 300, 300, 0\n  ENDP\nENDSCENE\n`, ASSETS, {}, { RT_LOADMAP: 0xC660, RT_TILE: 0xC670, RT_FILL: 0xC680 });
  check_('the cell-map words (TILE, FILL, LOADMAP of another MAP) compile in a VIEW3D program, the HUD map keeping the map table of the extended header', hud.errors.length === 0 && (hud.memory[0x8004] & 0xC0) === 0xC0, errText(hud));
  check_('the view\'s MAP is not in the map table: only the HUD map is (count 1)', (() => { const mt = hud.memory[0x8010] | (hud.memory[0x8011] << 8); return mt !== 0 && hud.memory[mt] === 1; })());
  // errors of the contract's section 6
  const NO = `GAME "t"\nFRAMERATE 12\nTILESET ts = "ts"\nMAP level = "hud"\nSPRITE o = "orb"\nSCENE s\n  DIM v\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    BODY\n  ENDP\nENDSCENE\n`;
  for (const [what, body, rx] of [
    ['VIEW', 'VIEW 1, 2, 3', /VIEW needs a VIEW3D/], ['SETWALL', 'SETWALL 1, 2 = 3', /SETWALL needs a VIEW3D/], ['WALL()', 'v = WALL(1, 2)', /WALL\(\) needs a VIEW3D/],
    ['SEEN()', 'v = SEEN(o)', /SEEN\(\) needs a VIEW3D/], ['DEPTH()', 'v = DEPTH(o)', /DEPTH\(\) needs a VIEW3D/],
  ]) cmBad(`${what} without a VIEW3D is an error (reported by the code generator, with line and column)`, NO.replace('BODY', body).replace('DIM v', 'DIM v'), rx);
  { const r = cm(NO.replace('BODY', 'v = COSA(64) + SINA(64) + FXMUL(256, 256)')); check_('COSA / SINA / FXMUL need no VIEW3D', r.errors.length === 0, errText(r)); }
  { const r = cm(NO.replace('BODY', 'VIEW 1, 2, 3')); check_('the error has the statement\'s line and column', r.errors.length === 1 && r.errors[0].line === 11 && r.errors[0].col === 4, JSON.stringify(r.errors[0])); }
  cmBad('a map outside the project', MIN().replace('"maze"', '"nothing"'), /map asset "nothing" is not in the project/);
  cmBad('a map 3 cells wide', MIN().replace('"maze"', '"tiny3"'), /view map "tiny3": the view map width.*4\.\.32/);
  cmBad('a map 33 cells wide', MIN().replace('"maze"', '"huge33"'), /view map "huge33": the view map width/);
  cmBad('a cell of 5', MIN().replace('"maze"', '"cell5"'), /row 2, column 2 is 5/);
  cmBad('an empty cell on the outer ring (row 5, column 2)', MIN().replace('"maze"', '"emptyring"'), /row 5, column 2 is empty but it is on the outer ring/);
  for (const [side, idx] of [['top', 2], ['bottom', 6 * 5 + 3], ['left', 6 * 3], ['right', 6 * 3 + 5]]) {
    const m = { w: 6, h: 6, cells: ASSETS.maps.emptyring.cells.map((v, i) => (i === 6 * 5 + 2 ? 1 : i === idx ? 0 : v)) };
    cmBad(`an empty cell on the ${side} edge of the outer ring is refused`, MIN().replace('"maze"', '"edge"'), /is empty but it is on the outer ring/, withMap('edge', m));
  }
  cmBad('a blank cell on the outer ring', MIN().replace('"maze"', '"blankring"'), /row 0, column 3 is empty/);
  cmBad('the view error is reported on the VIEW3D line at the map name', MIN().replace('"maze"', '"emptyring"'), /outer ring/);
  { const r = cm(MIN().replace('"maze"', '"cell5"')); check_('...with the line and column of the map name in the VIEW3D statement', r.errors[0].line === 5 && r.errors[0].col === 7, JSON.stringify(r.errors[0])); }
  // runtime refusals
  for (const sym of ['RT_VIEW', 'RT_SETWALL']) {
    const src = MIN().replace('VIEW 300, 300, v', sym === 'RT_VIEW' ? 'VIEW 300, 300, v' : 'SETWALL 300, 300 = v');
    const r = compileWith(src, (rt) => { delete rt.symbols[sym]; });
    check_(`a runtime without ${sym} says so, with the line`, r.errors.length === 1 && new RegExp(`needs ${sym}, which this runtime does not provide`).test(r.errors[0].message) && r.errors[0].line === 11, errText(r));
  }
  for (const [sym, body] of [['RT_COSA', 'v = COSA(1)'], ['RT_SINA', 'v = SINA(1)'], ['RT_FXMUL', 'v = FXMUL(1, 2)'], ['RT_WALL', 'v = WALL(1, 2)'], ['BB_TAB', 'v = SEEN(o)'], ['BB_TAB', 'v = DEPTH(o)']]) {
    const r = compileWith(MIN().replace('VIEW 300, 300, v', body), (rt) => { delete rt.symbols[sym]; delete rt.constants[sym]; });
    check_(`a runtime without ${sym} refuses ${body.slice(4)}`, r.errors.length >= 1 && new RegExp(`${sym}`).test(r.errors[0].message), errText(r));
  }
  { const r = compileWith(MIN().replace('VIEW 300, 300, v', 'SETWALL 1, 2 = v'), (rt) => { delete rt.constants.RA_V; }); check_('SETWALL needs the runtime argument block (RA_*)', r.errors.length === 1 && /argument block/.test(r.errors[0].message), errText(r)); }
  { const r = compileWith(MIN(), (rt) => { rt.version = 3; }); check_('VIEW3D compiled for a v3 runtime: the checker refuses it ("needs the v4 runtime")', r.errors.length >= 1 && /VIEW3D needs the v4 runtime/.test(r.errors[0].message), errText(r)); }
  { const r = compileWith(MIN().replace('VIEW 300, 300, v', 'v = COSA(v)').replace('VIEW3D level', ''), (rt) => { rt.version = 2; }); check_('COSA on a v2 runtime: "needs the v4 runtime"', r.errors.length >= 1 && /COSA\(\) needs the v4 runtime/.test(r.errors[0].message), errText(r)); }
  { const rt = mockRuntime4(); rt.constants.DIV_VIEW = 0x20; const r = compile(MIN(), { runtime: rt, image: MOCK_IMAGE, assets: ASSETS }); check_('DIV_VIEW comes from runtime.json (a different value is written into the header)', r.errors.length === 0 && (r.memory[0x8004] & 0x20) === 0x20, errText(r)); }
  { const rt = mockRuntime4(); delete rt.constants.DIV_VIEW; const r = compile(MIN(), { runtime: rt, image: MOCK_IMAGE, assets: ASSETS }); check_('without DIV_VIEW in runtime.json the default $40 is used', r.errors.length === 0 && (r.memory[0x8004] & 0x40) === 0x40, errText(r)); }
  { const rt = mockRuntime4(); rt.constants.BB_ENT = 8; rt.symbols.BB_TAB = 0xE180; const src = MIN().replace('VIEW 300, 300, v', 'v = SEEN(o) + DEPTH(o)'); const r = compile(src, { runtime: rt, image: MOCK_IMAGE, assets: ASSETS }); check_('BB_TAB / BB_ENT come from runtime.json: with entry size 8 at $E180 the reads are LD HL,($E182) and LD HL,($E180)', r.errors.length === 0 && (() => { const c = r.gen.code; const has = (lo, hi) => { for (let i = 0; i + 2 < c.length; i++) if (c[i] === 0x2A && c[i + 1] === lo && c[i + 2] === hi) return true; return false; }; return has(0x82, 0xE1) && has(0x80, 0xE1); })(), errText(r)); }
  { const rt = mockRuntime4(); delete rt.constants.BB_ENT; const src = MIN().replace('SPRITE o = "orb"', 'SPRITE o = "orb"\nSPRITE o2(3) = "guard"').replace('VIEW 300, 300, v', 'v = SEEN(o2(2))'); const r = compile(src, { runtime: rt, image: MOCK_IMAGE, assets: ASSETS }); check_('without BB_ENT in runtime.json the contract\'s 4 bytes an instance are used (o2(2) = instance 3: BB_TAB + 12 + 2)', r.errors.length === 0 && (() => { const c = r.gen.code, a = ADDR.BB_TAB + 14; for (let i = 0; i + 2 < c.length; i++) if (c[i] === 0x2A && c[i + 1] === (a & 255) && c[i + 2] === (a >> 8)) return true; return false; })(), errText(r)); }
  // the link report
  const u = res.usage, lines = usageLines(u);
  check_('the link report: game total includes the view data; free = area - total; view lines name the map source, 1,024 expanded, the descriptor and the runtime-owned memory', u.view && lines.some((l) => /3D view 12 x 12, 4-pixel columns: map source \d+ bytes \(1024 expanded by the runtime\), view descriptor 10/.test(l)) && lines.some((l) => /3D view memory:.*not part of the game image/.test(l)) && u.total + u.free === 16384 && u.gameVars.used >= 0, lines.join(' | '));
  info(lines.join('\n        '));
  // a game that does not fit
  const fatA = () => ({ w: 32, h: 48, frames: Array.from({ length: 32 }, () => ({ rows: Array.from({ length: 48 }, () => ({ bits: 'FFFFFFFF', mask: 'FFFFFFFF' })) })) });
  const fat = { ...ASSETS, sprites: { ...ASSETS.sprites, fat: fatA(), fat2: fatA() } };
  const r = cm(`GAME "t"\nFRAMERATE 12\nMAP level = "maze"\nSPRITE f = "fat"\nSPRITE f2 = "fat2"\nVIEW3D level\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    SHOW f AT 1, 2 FRAME RND(32)\n    SHOW f2 AT 1, 2 FRAME RND(32)\n  ENDP\nENDSCENE\n`, fat);
  check_('a game too big for the 16 KB area fails to link and says how many bytes (including the 3D view data)', r.errors.length === 1 && /the game does not fit.*3D view data \d+.*too many/.test(r.errors[0].message), errText(r));
  // v4 without a VIEW3D: the runtime behaves as v3 without a window
  const nv = cm(`GAME "t"\nFRAMERATE 20\nSPRITE g = "guard"\nSCENE s\n  DIM v\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    v = v + 1\n    SHOW g AT v, 20 FRAME v MOD 3 FLIP\n  ENDP\nENDSCENE\n`);
  check_('a v4 program without a VIEW3D: header without DIV_VIEW (frame_div only), a phase plan as v3, no view in the report', nv.errors.length === 0 && nv.memory[0x8004] === 3 && nv.gen.phase !== null && !nv.usage.view && nv.gen.view === null, errText(nv));
  const nvr = runMock4(nv, { ticks: 6 });
  check_('...and it runs on the mock with the v3 clamp (no view in the descriptor: x clamped to 256 - w)', nvr.view === null && nvr.ticks[5].sprites[0].x === 6 && nvr.ticks[5].sprites[0].visible === 1);
}

// =================================================================================================================
// 6. Compiled code on the mock runtime against the interpreter
// =================================================================================================================
console.log('\n6. Compiled code on the mock runtime against the interpreter');
for (const p of PROGRAMS) {
  const ticks = QUICK ? Math.min(p.ticks, 240) : p.ticks;
  const t0 = Date.now();
  const res = cm(p.src);
  if (!check_(`${p.name.split(' (')[0]}: compiles`, res.errors.length === 0 && !!res.dck, errText(res))) continue;
  const got = runMock4(res, { ticks, stick: p.stick, billboard: p.billboard });
  const want = interpret(parse(p.src).ast, { version: 4, ticks, assets: ASSETS, stick: p.stick, billboard: p.billboard, maxSteps: 2_000_000_000 });
  let d = diffV4(got.init, want.init, 'after INIT');
  for (let t = 1; !d && t <= ticks; t++) d = diffV4(got.ticks[t - 1], want.ticks[t - 1], `after tick ${t}`);
  check_(`${p.name}: ${ticks} ticks equal to the interpreter (variables, arrays, SPR_TAB entries, the map array, the pose)`, d === null, `${d ?? ''} code ${res.usage.codegen.codeBytes} bytes, worst tick ${Math.max(...got.tstates)} T, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
}
{
  // coverage of the maze game: the run must actually exercise the words
  const p = PROGRAMS[0], ticks = QUICK ? 240 : p.ticks;
  const want = interpret(parse(p.src).ast, { version: 4, ticks, assets: ASSETS, stick: p.stick, billboard: p.billboard, maxSteps: 2_000_000_000 });
  const poses = new Set(want.ticks.map((t) => `${t.view.x},${t.view.y},${t.view.a}`));
  const maps = new Set(want.ticks.map((t) => Buffer.from(t.wallRam).toString('hex')));
  const last = want.ticks[ticks - 1].vars;
  check_('the maze game exercises the words: hundreds of poses, the map changed by SETWALL, the door opened, guards shot (SEEN / DEPTH), hits taken (HIT), sprites shown and hidden', poses.size > (QUICK ? 100 : 300) && maps.size >= 2 && last.DOOR === 1 && last.SCORE >= 10 && last.HP < 20 && want.ticks.some((t) => t.sprites.some((s) => !s.visible)) && want.ticks.some((t) => t.vars.SEENMASK > 0), `poses ${poses.size} maps ${maps.size} ${JSON.stringify(last)}`);
}

// =================================================================================================================
// 7. Argument forms and evaluation order
// =================================================================================================================
console.log('\n7. Argument forms and evaluation order on the mock');
{
  const same = (name, src, { ticks = 3, assets = ASSETS, billboard = null, extra = {} } = {}) => {
    const res = cm(src, assets, extra);
    if (!check_(`${name}: compiles`, res.errors.length === 0 && !!res.dck, errText(res))) return;
    const got = runMock4(res, { ticks, billboard });
    const want = interpret(parse(src).ast, { version: 4, ticks, assets, billboard, maxSteps: 50_000_000 });
    let d = diffV4(got.init, want.init, 'init');
    for (let t = 1; !d && t <= ticks; t++) d = diffV4(got.ticks[t - 1], want.ticks[t - 1], `tick ${t}`);
    check_(`${name}: the mock equals the interpreter`, d === null, d ?? '');
  };
  const wrap = (decl, init, frame, sprites = 'SPRITE p = "orb"\nSPRITE c(3) = "guard"\nSPRITE d = "giant"\n') => `GAME "t"\nFRAMERATE 12\nMAP level = "maze"\n${sprites}VIEW3D level\nSCENE s\n  ${decl}\n  PROC INIT()\n${init}\n  ENDP\n  PROC FRAME()\n${frame}\n  ENDP\nENDSCENE\n`;
  // VIEW: every mix of simple (a variable or a constant) and complex (an expression) arguments
  for (let mask = 0; mask < 8; mask++) {
    const arg = (i, v) => ((mask >> i) & 1 ? `v${i} * 2 + 7` : (i === 1 ? '1000' : `v${i}`));
    same(`VIEW with the ${['x', 'y', 'a'].filter((_, i) => (mask >> i) & 1).join(' and ') || 'no'} argument${mask === 0 || mask === 1 || mask === 2 || mask === 4 ? '' : 's'} an expression`, wrap('DIM v0, v1, v2', '    v0 = 300 : v1 = 500 : v2 = 90', `    VIEW ${arg(0)}, ${arg(1)}, ${arg(2)}\n    v0 = v0 + 111 : v1 = v1 + 77 : v2 = v2 + 5`));
  }
  same('VIEW with constants only', wrap('DIM v', '    v = 0', '    VIEW 1000, 2000, 33'));
  same('VIEW arguments that are function calls (the order of evaluation shows in RND)', wrap('DIM v', '    v = 0', '    VIEW RND(3000), RND(3000), RND(256)\n    v = RND(100)'), { ticks: 6 });
  same('VIEW with out-of-map and negative values (the pose is clamped), the angle above 255 and negative', wrap('DIM v, w', '    v = 0', '    w = w + 1\n    VIEW 0 - w * 900, w * 1100, w * 77 - 300'), { ticks: 12 });
  same('VIEW with FXMUL / COSA in the arguments (nested registers)', wrap('DIM v, k', '    v = 0', '    k = k + 9\n    VIEW 1500 + FXMUL(COSA(k), 300), 1500 + FXMUL(SINA(k), 300), FXMUL(k, 3) + COSA(k)'), { ticks: 10 });
  // SETWALL: evaluation order x, y, t with side effects
  same('SETWALL with RND in x, y and t (evaluated in that order)', wrap('DIM v', '    v = 0', '    SETWALL RND(3200), RND(3200) = RND(6) - 1\n    v = RND(9)'), { ticks: 40 });
  same('SETWALL with constants, variables, expressions; types out of range', wrap('DIM v, w, t', '    v = 0', '    t = t + 1\n    SETWALL 300 + t * 20, 300 = t MOD 7\n    SETWALL 2, 2 = 3\n    SETWALL v, w = t - 3\n    w = w + 200\n    v = v + 100'), { ticks: 30 });
  // FXMUL / WALL / COSA operand forms
  same('FXMUL, WALL: simple/complex operand mixes', wrap('DIM v, w, k, r(5)', '    v = 3', '    k = k + 1\n    r(0) = FXMUL(v, w) : r(1) = FXMUL(k * 3, w) : r(2) = FXMUL(v, k * 5 - 40) : r(3) = FXMUL(k * 77, k * -99) : r(4) = FXMUL(300, 700)\n    v = v * 3 + 1 : w = w - 4\n    r(5) = WALL(k * 257, 600) + 2 * WALL(v, k * 200) + 4 * WALL(300, 300)'), { ticks: 25 });
  same('COSA / SINA of constants, variables, expressions, negative and large angles', wrap('DIM k, r(8)', '    k = 0', '    k = k + 37\n    r(0) = COSA(k) : r(1) = SINA(k * 7) : r(2) = COSA(0 - k) : r(3) = SINA(k + 1000) : r(4) = COSA(192) : r(5) = SINA(-1) : r(6) = COSA(k * 1000) : r(7) = SINA(32767) : r(8) = COSA(-32768)'), { ticks: 14 });
  // SEEN / DEPTH of every kind of reference
  const bbf = (t, i) => (i === 0 ? { depth: 300 + t, col: 10 + t } : i === 3 ? { depth: 65535, col: 0xFFFF } : i === 4 ? { depth: 1, col: 127 } : i === 5 ? undefined : { depth: 7 * i + t, col: 100 - i });
  same('SEEN / DEPTH: a single sprite, a pool element by constant and by run-time index, the bare pool name, an index outside the pool (constant and run-time), negative', wrap('DIM v, i, r(14)', '    v = 0', '    i = i + 1\n    r(0) = SEEN(p) : r(1) = DEPTH(p) : r(2) = SEEN(c(0)) : r(3) = DEPTH(c(2)) : r(4) = SEEN(c(i MOD 4)) : r(5) = DEPTH(c(i MOD 4)) : r(6) = SEEN(c) : r(7) = DEPTH(c)\n    r(8) = SEEN(c(3)) : r(9) = DEPTH(c(7)) : r(10) = SEEN(c(-1)) : r(11) = DEPTH(c(i - 5)) : r(12) = SEEN(d) : r(13) = DEPTH(d) : r(14) = SEEN(c(i))'), { ticks: 9, billboard: bbf });
  same('SEEN in a condition, in arithmetic and as a FOR bound', wrap('DIM v, i, n', '    v = 0', '    FOR i = 0 TO 3\n      IF SEEN(c(i)) >= 0 THEN n = n + 1 ENDIF\n      IF DEPTH(c(i)) > 100 AND SEEN(c(i)) < 100 THEN n = n + 10 ENDIF\n    NEXT i\n    FOR i = SEEN(p) TO SEEN(p) + 1\n      v = v + 1\n    NEXT i\n    v = v + DEPTH(d) * 2'), { ticks: 10, billboard: bbf });
  // SHOW forms in ray mode
  same('SHOW in ray mode: large and negative coordinates stay as written; FLIP only; a run-time index; HIDE; a frame variable', wrap('DIM v, i', '    v = 0', '    i = i + 1\n    SHOW p AT 30000 + i * 700, 0 - i * 900\n    SHOW c(i MOD 4) AT i * 100, 2000 FRAME i MOD 3 FLIP\n    SHOW c(1) AT 1, 2 FLIP\n    SHOW d AT 5 * i, i FRAME i MOD 2\n    IF i > 4 THEN HIDE p ENDIF\n    IF i > 6 THEN HIDE c(i MOD 4) ENDIF\n    v = HIT(p, d) + 2 * HIT(c(1), c(i MOD 4))'), { ticks: 12 });
  same('HIT in ray mode at the boundaries (|d| = R - 1, R, R + 1 on each axis) with sprites of height 16, 32 and 8', wrap('DIM v, i, r(5)', '    v = 0', '    i = i + 1\n    SHOW c(0) AT 3000, 3000\n    SHOW p AT 3000 + 110 + i * 4, 3000\n    SHOW d AT 3000, 3000 + 140 + i * 5\n    r(0) = HIT(c(0), p) : r(1) = HIT(c(0), d) : r(2) = HIT(p, d) : r(3) = HIT(d, d) : r(4) = HIT(c(0), c(0))', 'SPRITE p = "orb"\nSPRITE c(3) = "guard"\nSPRITE d = "giant"\n'), { ticks: 14 });
  same('HIT with a pill (8 high, R 32)', wrap('DIM i, r(2)', '    i = 0', '    i = i + 1\n    SHOW pl AT 1000, 1000\n    SHOW p AT 1000 + 94 + i, 1000\n    r(0) = HIT(pl, p) : r(1) = HIT(p, pl)', 'SPRITE p = "orb"\nSPRITE pl = "pill"\n'), { ticks: 8 });
  same('a user function around the new words: DEF FN with WALL / FXMUL, called with different arguments', wrap('DIM v, i, r(3)', '    v = 0', '    i = i + 1\n    r(0) = FN cell(i * 90) : r(1) = FN scale(i * 40) : r(2) = FN cell(FN scale(i)) : v = r(0) + r(1)').replace('  PROC INIT()', '  DEF FN cell(x) = WALL(x, 700) + WALL(700, x)\n  DEF FN scale(x) = FXMUL(x, COSA(x)) + SINA(x)\n  PROC INIT()'), { ticks: 12 });
  same('a PROC with parameters calling VIEW / SETWALL', wrap('DIM v', '    v = 0', '    CALL go(v * 30 + 300, 640, v * 3)\n    CALL put(v MOD 6 * 256 + 20, 300, v MOD 5)\n    v = v + 1').replace('  PROC INIT()', '  PROC go(x, y, a)\n    VIEW x, y, a\n  ENDP\n  PROC put(x, y, t)\n    SETWALL x, y = t\n  ENDP\n  PROC INIT()'), { ticks: 10 });
}

// =================================================================================================================
// 8. Fuzz: queries against an independent model
// =================================================================================================================
console.log('\n8. Fuzz: WALL, SETWALL, FXMUL, COSA, SINA and VIEW against an independent model (interpreter and compiled code on the mock)');
{
  const NPROG = QUICK ? 60 : 170, NQ = 30;
  const r = rng(0xBA11);
  const ri = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (a) => a[Math.floor(r() * a.length)];
  let queries = 0, bad = 0, interpBad = 0, mockBad = 0, firstBad = '';
  const kinds = new Set();
  for (let pi = 0; pi < NPROG; pi++) {
    const W = pick([4, 5, 12, 16, 31, 32, ri(4, 32)]), H = pick([4, 7, 12, 20, 32, ri(4, 32)]);
    const mapName = 'fz' + pi;
    const cells = Array.from({ length: W * H }, (_, i) => { const rr = (i / W) | 0, c = i % W; return rr === 0 || c === 0 || rr === H - 1 || c === W - 1 ? ri(1, 4) : (r() < 0.4 ? 0 : ri(0, 4)); });
    const assets = withMap(mapName, { w: W, h: H, cells });
    const model = viewModel(W, H, cells);
    const lines = [], expect = [];
    let nvar = 0;
    const form = (v) => {                  // an argument form: literal, variable, expression
      const t = r();
      if (t < 0.4) return v < 0 ? `(0 - ${-v})` : String(v);
      if (t < 0.7) { const name = 'v' + (nvar++ % 6); lines.push(`    ${name} = ${v}`); return name; }
      const d = ri(-9, 9), name = 'v' + (nvar++ % 6);
      if (v - d < -32768 || v - d > 32767) { lines.push(`    ${name} = ${v}`); return name; }
      lines.push(`    ${name} = ${v - d}`);
      return d >= 0 ? `${name} + ${d}` : `${name} - ${-d}`;
    };
    const lit = (v) => (v < 0 ? `-${-v}` : String(v));
    const coord = (n) => { const q = r(); return q < 0.2 ? ri(-3000, 300) : q < 0.3 ? ri(n * 256 - 50, n * 256 + 700) : q < 0.38 ? pick([0, 255, 256, 257, n * 256 - 1, n * 256, 8191, 8192, 5000, 12000, 32767]) : ri(0, n * 256 - 1); };
    for (let qi = 0; qi < NQ; qi++) {
      const kind = pick(['wall', 'wall', 'wall', 'set', 'set', 'fxmul', 'cosa', 'sina', 'view']);
      kinds.add(kind);
      if (kind === 'set') {
        const x = coord(W), y = coord(H), t = pick([0, 1, 2, 3, 4, 4, 5, 6, 9, -1, 255]);
        const ts = t >= 0 && t <= 4 ? String(t) : (() => { const name = 'v' + (nvar++ % 6); lines.push(`    ${name} = ${t}`); return name; })();       // a literal type outside 0..4 is a compile error: reach the runtime through a variable
        lines.push(`    SETWALL ${form(x)}, ${form(y)} = ${ts}`);
        model.set(x, y, t);
        continue;
      }
      let text, want;
      if (kind === 'wall') { const x = coord(W), y = coord(H); text = `WALL(${form(x)}, ${form(y)})`; want = model.wall(x, y); }
      else if (kind === 'fxmul') { const a = pick([ri(-32768, 32767), ri(-300, 300), 256, -256, 32767, -32768, 0, 1, -1]), b = pick([ri(-32768, 32767), ri(-300, 300), 256, 4096, 32767, -32768, 0]); text = `FXMUL(${form(a)}, ${form(b)})`; want = Number(BigInt.asIntN(16, (BigInt(a) * BigInt(b)) >> 8n)); }
      else if (kind === 'view') {
        const x = coord(W), y = coord(H), a = pick([ri(-400, 700), ri(0, 255), 255, 256, -1, 32767, -32768]);
        lines.push(`    VIEW ${form(x)}, ${form(y)}, ${form(a)}`);
        model.lastPose = model.pose(x, y, a);
        continue;
      } else { const a = pick([ri(0, 255), ri(-500, 500), ri(-32768, 32767), 0, 64, 128, 192, 255, 256]); text = `${kind === 'cosa' ? 'COSA' : 'SINA'}(${form(a)})`; want = kind === 'cosa' ? cosModel(a) : sinModel(a); }
      lines.push(`    r(${expect.length}) = ${text}`);
      expect.push(want);
    }
    queries += expect.length;
    void lit;
    const src = `GAME "fz"\nFRAMERATE 12\nMAP level = "${mapName}"\nVIEW3D level\nSCENE s\n  DIM r(${Math.max(expect.length, 1)}), v0, v1, v2, v3, v4, v5\n  PROC INIT()\n${lines.join('\n')}\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`;
    const comp = cm(src, assets);
    if (comp.errors.length) { bad++; firstBad ||= `program ${pi}: compile: ${errText(comp)}\n${src.slice(0, 700)}`; continue; }
    const want = interpret(parse(src).ast, { version: 4, ticks: 0, assets, maxSteps: 50_000_000 });
    const gotM = runMock4(comp, { ticks: 0 }).init;
    const gotI = want.init.arrays.R;
    for (let i = 0; i < expect.length; i++) {
      if (gotI[i] !== expect[i]) { interpBad++; firstBad ||= `program ${pi} query ${i}: interpreter ${gotI[i]}, model ${expect[i]}\n${lines.filter((l) => l.includes(`r(${i})`)).join('\n')}`; }
      if (gotM.arrays.R[i] !== expect[i]) { mockBad++; firstBad ||= `program ${pi} query ${i}: compiled code on the mock ${gotM.arrays.R[i]}, model ${expect[i]}\n${lines.filter((l) => l.includes(`r(${i})`)).join('\n')}`; }
    }
    // the final array of the interpreter and of the compiled code equal the model's grid (SETWALL included), and so does the pose
    const flat = model.flat();
    for (const [who, ram] of [['interpreter', want.init.wallRam], ['compiled code', gotM.wallRam]]) {
      for (let i = 0; i < 1024; i++) if (ram[i] !== flat[i]) { (who === 'interpreter' ? interpBad++ : mockBad++); firstBad ||= `program ${pi}: ${who} map array [row ${i >> 5}, col ${i & 31}] = ${ram[i]}, model ${flat[i]}`; break; }
    }
    if (model.lastPose) for (const [who, p] of [['interpreter', want.init.view], ['compiled code', gotM.pose]]) if (p.x !== model.lastPose.x || p.y !== model.lastPose.y || p.a !== model.lastPose.a) { (who === 'interpreter' ? interpBad++ : mockBad++); firstBad ||= `program ${pi}: ${who} pose ${JSON.stringify(p)}, model ${JSON.stringify(model.lastPose)}`; }
  }
  info(`${NPROG} programs, ${queries} value queries (WALL, FXMUL, COSA, SINA) among SETWALLs and VIEWs; maps 4..32 cells a side, positions inside, outside and negative, the array of 1,024 cells and the pose compared at the end`);
  check_(`>= ${QUICK ? 800 : 3000} queries: every program compiles`, bad === 0 && queries >= (QUICK ? 800 : 3000), `${bad} did not compile; ${queries} queries; ${firstBad}`);
  check_('the interpreter equals the independent model on every query, on the final map array and on the pose', interpBad === 0, `${interpBad} differences; ${firstBad}`);
  check_('the compiled code on the mock runtime equals the model on every query, the map array and the pose', mockBad === 0, `${mockBad} differences; ${firstBad}`);
  check_('the fuzz covers WALL, SETWALL, FXMUL, COSA, SINA and VIEW', ['wall', 'set', 'fxmul', 'cosa', 'sina', 'view'].every((k) => kinds.has(k)));
}

// =================================================================================================================
// 9. Old programs compile to identical bytes
// =================================================================================================================
console.log('\n9. Programs that use none of the new words compile to the same bytes as before the batch');
{
  const fx = join(ROOT, 'arcade/tests/fixtures/batch3-baseline.json');
  if (!existsSync(fx)) info('SKIP: arcade/tests/fixtures/batch3-baseline.json does not exist');
  else {
    const base = JSON.parse(readFileSync(fx, 'utf8'));
    const cache = {};
    const load = (v) => {
      if (cache[v]) return cache[v];
      const jsonPath = join(ROOT, `arcade/build/${v}/runtime.json`);
      if (!existsSync(jsonPath)) return (cache[v] = null);
      const rt = JSON.parse(readFileSync(jsonPath, 'utf8'));
      return (cache[v] = { rt, image: new Uint8Array(readFileSync(join(dirname(jsonPath), rt.image ?? 'runtime.bin'))) });
    };
    let same = 0, n = 0, why = '';
    for (const p of base.programs) {
      const R = load(p.runtime === 2 ? 'v2' : 'v3');
      if (!R) { why += `${p.src}: no runtime v${p.runtime}; `; continue; }
      n++;
      const res = compile(readFileSync(join(ROOT, p.src), 'utf8'), { runtime: R.rt, image: R.image, assets: JSON.parse(readFileSync(join(ROOT, p.assets), 'utf8')) });
      const dck = res.dck ? createHash('sha256').update(res.dck).digest('hex') : '', area = res.memory ? createHash('sha256').update(res.memory.slice(0x8000, 0xC000)).digest('hex') : '';
      if (res.errors.length || dck !== p.dckSha256 || area !== p.areaSha256 || res.gen.code.length !== p.bytes) why += `${p.src} on v${p.runtime}: ${res.errors[0]?.message ?? 'bytes differ'}; `;
      else same++;
    }
    check_(`${base.programs.length} programs (the five of batch 1/2 on v2 and v3, platformer.arc on v3): the DCK (SHA-256) and the game area are byte-identical to the build made before this batch`, n === base.programs.length && same === n, why);
  }
}

// =================================================================================================================
// 10. requiredRuntime and the usage report
// =================================================================================================================
console.log('\n10. requiredRuntime');
{
  const rr = (src, a = ASSETS) => requiredRuntime(src, a);
  check_('VIEW3D needs v4 (and names why)', rr(RAY).version === 4 && rr(RAY).reasons.includes('VIEW3D') && rr(RAY).reasons.includes('VIEW') && rr(RAY).reasons.includes('SETWALL') && rr(RAY).reasons.includes('WALL()') && rr(RAY).reasons.includes('COSA()'));
  for (const w of ['COSA(1)', 'SINA(1)', 'FXMUL(1, 2)', 'WALL(1, 2)', 'SEEN(p)', 'DEPTH(p)']) check_(`${w.split('(')[0]}() alone needs v4`, rr(prog(`    v = ${w}`, { view: '' })).version === 4 && rr(prog(`    v = ${w}`, { view: '' })).reasons.join() === `${w.split('(')[0]}()`);
  check_('VIEW alone, SETWALL alone, VIEW3D alone need v4', rr(prog('    VIEW 1, 2, 3', { view: '' })).reasons.join() === 'VIEW' && rr(prog('    SETWALL 1, 2 = 3', { view: '' })).reasons.join() === 'SETWALL' && rr(prog('    v = 1')).reasons.join() === 'VIEW3D');
  check_('a v3 program is still v3 (WINDOW, FLIP) and a plain one v2', rr(prog('    CAMERA 5', { view: 'WINDOW level\n' })).version === 3 && rr(prog('    SHOW p AT 1, 1 FLIP', { view: '' })).version === 3 && rr(prog('    SHOW p AT 1, 1', { view: '', map: '', sprites: 'SPRITE p = "pill"\n' })).version === 2);
  check_('FLIP in a VIEW3D program: v4, the reasons are the v4 ones only', (() => { const r = rr(prog('    SHOW p AT 1, 1 FLIP')); return r.version === 4 && r.reasons.join() === 'VIEW3D'; })());
  check_('a program that fails to parse is still read as far as it goes', rr('VIEW3D lv\nSCENE s\nPROC FRAME()\n VIEW 1,').version === 4);
  check_('BAND(a, b), the bit function, does not make a program v3', rr(prog('    v = BAND(w, 3)', { view: '', map: '', sprites: 'SPRITE p = "pill"\n' })).version === 2);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: arcade-m8-compiler (${passed} checks passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
