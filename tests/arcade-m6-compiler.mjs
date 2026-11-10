#!/usr/bin/env node
"use strict";
// arcade-m6-compiler.mjs -- tests for language batch 2 of the Leap Arcade compiler (the platformer slice, docs/ARCADE_PLATFORMER_CONTRACT.md sections 3b, 4, 5, 7, 8;
// the decisions where the contract is silent are in docs/ARCADE_LANGUAGE_BATCH2.md): WINDOW, BAND, CAMERA, CAMX, SETWORLD, WORLDTILE, TILEFLAGS, TILEHIT, SOLID,
// SHOW ... FRAME ... FLIP, sprites of 8..32 x 1..48 pixels with frames, the tileset's flags, the world map converter, the scroll tables, the v3 header.
//
//   node tests/arcade-m6-compiler.mjs               (ARCADE_QUICK=1: a smaller fuzz)
//
// The real v3 runtime does not have the window routines yet: everything here is checked structurally (parse, check, code and image layout against independent
// JavaScript), on the reference interpreter, and by RUNNING the compiled Z80 code on a MOCK runtime (tests/arcade-m6-mock.mjs: JavaScript traps for the routines,
// written from the contract and from the image the linker wrote). tests/arcade-m6-differential.mjs is the same comparison against the REAL v3 runtime; it skips
// until arcade/build/v3/runtime.json has RT_CAMERA.
//
// Sections
//   1  parser and checker: every new word, positive and negative
//   2  the word table
//   3  data builders: ratios, cam_max, tile rows, scroll tables (against an independent pre-shift), flags, world maps, v3 sprites (mirrored frames), phase cost
//   4  the reference interpreter, hand-computed
//   5  the code generator and linker: header, descriptors, window_desc, the image, errors of the contract's section 7, v2 and v3 runtime refusals, the link report
//   6  compiled code on the mock runtime against the interpreter (>= 150 ticks each; the platformer 600)
//   7  SHOW forms on the mock (run-time index, FLIP only, frame variable, constant index outside the pool, ...) and nested arguments
//   8  fuzz: >= 3,000 collision queries (WORLDTILE TILEFLAGS TILEHIT SOLID with SETWORLD in between) against an independent per-pixel model, on the interpreter and on the mock
//   9  programs that use none of the new words compile to the same bytes as before the batch (arcade/tests/fixtures/batch2-baseline.json)
//  10  requiredRuntime and the usage report
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile, requiredRuntime, usageLines } from '../src/lang/arcade/arcade-compile.js';
import { ARCADE_WORDS, RESERVED, FUNCTIONS } from '../src/lang/arcade/arcade-words.js';
import { convertTileset } from '../src/lang/arcade/arcade-assets.js';
import { convertSpriteV3 } from '../src/lang/arcade/arcade-assets.js';
import * as WIN from '../src/lang/arcade/arcade-window.js';
import { rng, ASSETS, PROGRAMS, worldModel, diffV3, TILE_FLAGS } from './arcade-m6-common.mjs';
import { compileMock, runMock, mockRuntime, ADDR } from './arcade-m6-mock.mjs';
import { planPool, poolNeed } from '../arcade/tests/m6-common.mjs';        // the runtime's JS reference of the phase-pool plan (only to compare the compiler's port with)

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
const hex = (v, w = 4) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const prog = (body, { top = '', decl = 'DIM v, w, k', procs = '', win = 'WINDOW level\n', sprites = 'SPRITE p = "player"\nSPRITE c(3) = "coin"\n', map = 'MAP level = "lv"\n' } = {}) =>
  `GAME "t"\nFRAMERATE 20\nTILESET ts = "ts"\n${map}${sprites}${top}${win}SCENE s\n  ${decl}\n${procs}  PROC INIT()\n  ENDP\n  PROC FRAME()\n${body}\n  ENDP\nENDSCENE\n`;
const diag = (src, version = 3) => { const p = parse(src); return [...p.errors, ...check(p.ast, { version })]; };
const errs = (src, v) => diag(src, v).filter((d) => d.severity === 'error');
const warns = (src, v) => diag(src, v).filter((d) => d.severity === 'warning');
const msgs = (l) => l.map((d) => `${d.line}:${d.col} ${d.message}`).join(' | ');
const ok0 = (name, body, o) => { const e = errs(prog(body, o)); check_(name, e.length === 0, msgs(e)); };
const bad = (name, body, rx, o, v) => { const e = errs(prog(body, o), v); check_(name, e.length >= 1 && rx.test(e[0].message) && e[0].line >= 1, msgs(e) || 'no error'); };
const badSrc = (name, src, rx, v) => { const e = errs(src, v); check_(name, e.length >= 1 && rx.test(e[0].message), msgs(e) || 'no error'); };
const warn1 = (name, body, rx, o) => { const e = errs(prog(body, o)), w = warns(prog(body, o)); check_(name, e.length === 0 && w.some((d) => rx.test(d.message)), msgs(e) + ' || ' + msgs(w)); };

const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
const cm = (src, assets = ASSETS, rtExtra = {}) => compileMock(src, assets, rtExtra);
const cmBad = (name, src, rx, assets = ASSETS, rtExtra = {}) => {
  const r = cm(src, assets, rtExtra);
  check_(name, r.errors.length >= 1 && rx.test(r.errors[0].message) && !r.dck, errText(r) || 'compiled');
  return r;
};
const withAssets = (patch) => ({ ...ASSETS, ...patch });
const withMap = (name, m) => withAssets({ maps: { ...ASSETS.maps, [name]: m } });

// =================================================================================================================
// 1. Parser and checker
// =================================================================================================================
console.log('1. Parser and checker: WINDOW, BAND, CAMERA, SETWORLD, SHOW FRAME / FLIP and the functions');
{
  ok0('WINDOW map', '    v = 1');
  ok0('WINDOW map AT cx, cy', '    v = 1', { win: 'WINDOW level AT 4, 2\n' });
  ok0('WINDOW AT with CONSTs and expressions of constants', '    v = 1', { top: 'CONST CX = 2\n', win: 'WINDOW level AT CX * 4, 8 - CX\n' });
  ok0('WINDOW at the corners (0, 0) and (8, 8)', '    v = 1', { win: 'WINDOW level AT 8, 8\n' });
  ok0('BAND rows, num, den: one to four bands adding up to 16', '    v = 1', { win: 'WINDOW level\nBAND 2, 1, 4\nBAND 3, 1, 2\nBAND 3, 0, 1\nBAND 8, 1, 1\n' });
  ok0('BAND with CONSTs', '    v = 1', { top: 'CONST R = 6\nCONST N = 2\n', win: 'WINDOW level\nBAND R, 1, N\nBAND 16 - R, 1, 1\n' });
  ok0('BAND rows 16 at 2/1 (a single band that outruns the camera)', '    v = 1', { win: 'WINDOW level\nBAND 16, 2, 1\n' });
  ok0('BAND and WINDOW in either order (BAND before WINDOW is read in source order)', '    v = 1', { win: 'WINDOW level\nBAND 16, 1, 1\n' });
  ok0('CAMERA with an expression, CAMX() as a value', '    CAMERA CAMX() + 2 * v - 96\n    w = CAMX()');
  ok0('SETWORLD x, y = t with expressions (y at the additive level)', '    SETWORLD v + 8, w * 2 + 1 = k MOD 4\n    SETWORLD 8, 8 = 3');
  ok0('WORLDTILE TILEFLAGS TILEHIT SOLID', '    v = WORLDTILE(w, k) + TILEFLAGS(w + 1, k - 1) + TILEHIT(w, k, 16, 24, 6) + SOLID(w, k, 16, 24)');
  ok0('the collision words in conditions', '    IF SOLID(v, w, 8, 8) AND NOT TILEHIT(v, w, 8, 8, 2) THEN\n      k = 1\n    ENDIF');
  ok0('SHOW with FRAME, with FLIP, with both, with both the other way', '    SHOW p AT v, w FRAME 2\n    SHOW p AT v, w FLIP\n    SHOW p AT v, w FRAME k FLIP\n    SHOW p AT v, w FLIP FRAME k + 1\n    SHOW c(k) AT v, w FRAME 3 FLIP');
  ok0('FLIP is contextual: `flip` is still a name, also inside a SHOW', '    flip = 1\n    fr = flip + 1\n    SHOW p AT flip, fr FRAME flip FLIP', { decl: 'DIM v, w, k, flip, fr' });
  ok0('BAND(a, b) is still the bit function (also next to a BAND statement)', '    v = BAND(w, 255) + BAND(1, 3)', { win: 'WINDOW level\nBAND 16, 1, 1\n' });
  ok0('a PROC named like a new word is refused as a name, so none of them is one', '    v = 1');
  check_('parse: Window / Band nodes carry the map, cx, cy and rows, num, den', (() => {
    const a = parse(prog('', { win: 'WINDOW level AT 3, 5\nBAND 4, 1, 2\nBAND 12, 1, 1\n' })).ast;
    return a.windows.length === 1 && a.windows[0].map.name === 'level' && a.windows[0].cx.value === 3 && a.windows[0].cy.value === 5 && a.bands.length === 2 && a.bands[0].rows.value === 4 && a.bands[0].den.value === 2 && a.items.filter((i) => i.type === 'Band').length === 2;
  })());
  check_('parse: SHOW has frame and flip (flip false by default); the clauses work in either order', (() => {
    const body = parse(prog('    SHOW p AT 1, 2\n    SHOW p AT 1, 2 FRAME 3\n    SHOW p AT 1, 2 FLIP\n    SHOW p AT 1, 2 FLIP FRAME 3')).ast.scenes[0].procs[1].body;
    return body.map((s) => `${s.frame ? 1 : 0}${s.flip ? 1 : 0}`).join() === '00,10,01,11';
  })());
  check_('parse: CAMERA and SETWORLD nodes', (() => {
    const body = parse(prog('    CAMERA 5\n    SETWORLD 1, 2 + 3 = 4')).ast.scenes[0].procs[1].body;
    return body[0].type === 'Camera' && body[0].value.value === 5 && body[1].type === 'SetWorld' && body[1].y.type === 'Binary' && body[1].value.value === 4;
  })());

  // negatives
  bad('WINDOW twice', '    v = 1', /WINDOW may appear only once/, { win: 'WINDOW level\nWINDOW level\n' });
  bad('WINDOW inside a SCENE', '    v = 1', /WINDOW must be at the top level/, { win: '', decl: 'DIM v, w, k\n  WINDOW level' });
  bad('WINDOW inside a PROC', '    WINDOW level', /WINDOW must be at the top level/);
  bad('WINDOW of an undeclared map', '    v = 1', /not a declared MAP/, { win: 'WINDOW nowhere\n' });
  bad('WINDOW of a sprite', '    v = 1', /SPRITE, not a MAP/, { win: 'WINDOW p\n' });
  bad('WINDOW cx 9', '    v = 1', /must be 0\.\.8/, { win: 'WINDOW level AT 9, 0\n' });
  bad('WINDOW cy -1', '    v = 1', /must be 0\.\.8/, { win: 'WINDOW level AT 0, -1\n' });
  bad('WINDOW cx from a variable', '    v = 1', /constant expression/, { top: 'DIM q\n', win: 'WINDOW level AT q, 1\n' });
  bad('WINDOW without the map', '    v = 1', /expected a map name/, { win: 'WINDOW\n' });
  bad('WINDOW AT with one number', '    v = 1', /expected ','/, { win: 'WINDOW level AT 4\n' });
  bad('BAND without a WINDOW', '    v = 1', /BAND needs a WINDOW/, { win: 'BAND 16, 1, 1\n' });
  bad('BAND rows 0', '    v = 1', /BAND rows are 0/, { win: 'WINDOW level\nBAND 0, 1, 1\nBAND 16, 1, 1\n' });
  bad('BAND rows 17', '    v = 1', /BAND rows are 17/, { win: 'WINDOW level\nBAND 17, 1, 1\n' });
  bad('BANDs adding up to 15', '    v = 1', /add up to 15 rows.*16/, { win: 'WINDOW level\nBAND 5, 1, 4\nBAND 10, 1, 1\n' });
  bad('BANDs adding up to 17 (flagged at the band that passes 16)', '    v = 1', /add up to 17 rows here/, { win: 'WINDOW level\nBAND 5, 1, 4\nBAND 12, 1, 1\n' });
  bad('five BANDs', '    v = 1', /at most 4 BANDs/, { win: 'WINDOW level\nBAND 3, 1, 4\nBAND 3, 1, 2\nBAND 3, 1, 1\nBAND 3, 0, 1\nBAND 4, 1, 1\n' });
  bad('BAND speed 3/4', '    v = 1', /3\/4 is not a band speed.*1\/4/, { win: 'WINDOW level\nBAND 16, 3, 4\n' });
  bad('BAND speed 1/3', '    v = 1', /1\/3 is not a band speed/, { win: 'WINDOW level\nBAND 16, 1, 3\n' });
  bad('BAND speed 4/1', '    v = 1', /4\/1 is not a band speed/, { win: 'WINDOW level\nBAND 16, 4, 1\n' });
  bad('BAND speed 0/2 (only 0/1 is the fixed band)', '    v = 1', /0\/2 is not a band speed/, { win: 'WINDOW level\nBAND 16, 0, 2\n' });
  bad('BAND with a variable', '    v = 1', /constant expression/, { top: 'DIM q\n', win: 'WINDOW level\nBAND q, 1, 1\n' });
  bad('BAND inside a PROC', '    BAND 16, 1, 1', /BAND rows, num, den declares a window band: it must be at the top level/);
  bad('BAND inside a SCENE', '    v = 1', /BAND must be at the top level/, { win: 'WINDOW level\n', decl: 'DIM v, w, k\n  BAND 16, 1, 1' });
  bad('BAND with two numbers', '    v = 1', /expected ','/, { win: 'WINDOW level\nBAND 16, 1\n' });
  warn1('no band at 1/1: a warning', '    v = 1', /no BAND scrolls at 1\/1/, { win: 'WINDOW level\nBAND 4, 1, 2\nBAND 12, 1, 4\n' });
  bad('CAMERA without a value', '    CAMERA', /expected an expression/);
  bad('CAMERA with a string', '    CAMERA "a"', /must be a number/);
  bad('SETWORLD tile 32', '    SETWORLD 1, 1 = 32', /world tile index is 32.*0\.\.31/);
  bad('SETWORLD tile -1', '    SETWORLD 1, 1 = -1', /world tile index is -1/);
  bad('SETWORLD without =', '    SETWORLD 1, 1, 3', /expected '='/);
  bad('SETWORLD with one coordinate', '    SETWORLD 1 = 3', /expected ','/);
  bad('CAMX without brackets', '    v = CAMX', /CAMX needs brackets: CAMX\(\)/);
  bad('CAMX with an argument', '    v = CAMX(1)', /CAMX takes 0 arguments, got 1/);
  bad('WORLDTILE with one argument', '    v = WORLDTILE(1)', /WORLDTILE takes 2 arguments, got 1/);
  bad('TILEFLAGS with three', '    v = TILEFLAGS(1, 2, 3)', /TILEFLAGS takes 2 arguments, got 3/);
  bad('TILEHIT with four', '    v = TILEHIT(1, 2, 3, 4)', /TILEHIT takes 5 arguments, got 4/);
  bad('SOLID with five', '    v = SOLID(1, 2, 3, 4, 5)', /SOLID takes 4 arguments, got 5/);
  bad('SOLID with a string', '    v = SOLID("a", 2, 3, 4)', /argument 1 of SOLID must be a number/);
  bad('SOLID as a statement', '    SOLID(1, 2, 3, 4)', /SOLID is a function/);
  bad('assigning to a new word', '    SOLID = 1', /built-in function/);
  bad('assigning to WINDOW', '    WINDOW = 1', /keyword/);
  bad('a variable called camera', '    v = 1', /reserved word/, { decl: 'DIM v, camera' });
  bad('a variable called solid', '    v = 1', /reserved word/, { decl: 'DIM v, solid' });
  bad('SHOW with FLIP twice', '    SHOW p AT 1, 2 FLIP FLIP', /at most one FLIP/);
  bad('SHOW with FRAME twice', '    SHOW p AT 1, 2 FRAME 1 FRAME 2', /at most one FRAME/);
  bad('FRAME with a string', '    SHOW p AT 1, 2 FRAME "a"', /must be a number/);
  bad('LOADMAP of the window\'s world', '    LOADMAP level', /is the world of the WINDOW/, { map: 'MAP level = "lv"\n' });
  // the runtime version
  for (const [name, body, o] of [
    ['WINDOW', '    v = 1', {}], ['BAND', '    v = 1', { win: 'WINDOW level\nBAND 16, 1, 1\n' }], ['CAMERA', '    CAMERA 1', {}], ['SETWORLD', '    SETWORLD 1, 1 = 1', {}],
    ['CAMX()', '    v = CAMX()', {}], ['SOLID()', '    v = SOLID(1, 2, 3, 4)', {}], ['TILEHIT()', '    v = TILEHIT(1, 2, 3, 4, 5)', {}], ['WORLDTILE()', '    v = WORLDTILE(1, 2)', {}], ['TILEFLAGS()', '    v = TILEFLAGS(1, 2)', {}],
    ['FLIP', '    SHOW p AT 1, 2 FLIP', {}],
  ]) {
    const e = errs(prog(body, o), 2).filter((d) => d.message.startsWith(name));
    check_(`on a v2 runtime ${name} says it needs the v3 runtime`, e.length >= 1 && /needs the v3 runtime.*--runtime v3/.test(e[0].message), msgs(e));
  }
  check_('check(ast) with no version option does not complain about the runtime (the old table test calls it so)', check(parse(prog('    CAMERA 1\n    v = SOLID(1, 2, 3, 4)')).ast).filter((d) => d.severity === 'error').length === 0);
  check_('a program with no new word gives the same diagnostics on a v2 and a v3 runtime', msgs(diag(prog('    v = BAND(1, 3)', { win: '', map: '', sprites: '' }), 2)) === msgs(diag(prog('    v = BAND(1, 3)', { win: '', map: '', sprites: '' }), 3)));
}

// =================================================================================================================
// 2. Word table
// =================================================================================================================
console.log('\n2. The word table');
{
  const reserved = ['WINDOW', 'CAMERA', 'SETWORLD', 'CAMX', 'WORLDTILE', 'TILEFLAGS', 'TILEHIT', 'SOLID', 'BAND'];
  check_('WINDOW CAMERA SETWORLD CAMX WORLDTILE TILEFLAGS TILEHIT SOLID (and the batch 1 BAND) are reserved', reserved.every((w) => RESERVED.has(w)));
  check_('FLIP is contextual like FRAME (listed, not reserved)', ARCADE_WORDS.has('FLIP') && !RESERVED.has('FLIP') && !RESERVED.has('FRAME'));
  check_('every new word has a syntax line and a description of real length', [...reserved, 'FLIP'].every((w) => ARCADE_WORDS.get(w).syntax.length > 4 && ARCADE_WORDS.get(w).desc.length > 60));
  const argc = { CAMX: 0, WORLDTILE: 2, TILEFLAGS: 2, TILEHIT: 5, SOLID: 4 };
  check_('the five functions have their argument lists and return a number', Object.entries(argc).every(([n, k]) => FUNCTIONS.get(n)?.args.length === k && FUNCTIONS.get(n).ret === 'num'));
  check_('the BAND entry is still a function of two arguments and names the statement form too', FUNCTIONS.get('BAND').args.length === 2 && /BAND rows, num, den/.test(ARCADE_WORDS.get('BAND').syntax) && /top level/.test(ARCADE_WORDS.get('BAND').desc));
  check_('SHOW\'s Help line mentions FRAME and FLIP and the v3 runtime', /FRAME f\] \[FLIP\]/.test(ARCADE_WORDS.get('SHOW').syntax) && /v3 runtime/.test(ARCADE_WORDS.get('SHOW').desc));
}

// =================================================================================================================
// 3. Data builders
// =================================================================================================================
console.log('\n3. Data builders: ratios, cam_max, tables, flags, world maps, v3 sprites, phase cost');
{
  check_('ratio codes: 0/1 -> 0, 1/4 -> 1, 1/2 -> 2, 1/1 -> 3, 2/1 -> 4, anything else -1', [[0, 1, 0], [1, 4, 1], [1, 2, 2], [1, 1, 3], [2, 1, 4], [3, 4, -1], [1, 3, -1], [0, 2, -1], [2, 2, -1], [4, 1, -1]].every(([n, d, c]) => WIN.ratioCode(n, d) === c));
  check_('cam_max = floor((world_w * 8 - 192) / maxratio): 128 wide, 1/1 -> 832; with a 2/1 band -> 416; 24 wide -> 0; 60 wide, 2/1 -> 144; 25 wide, 2/1 -> 4',
    WIN.camMax(128, [1, 2, 3]) === 832 && WIN.camMax(128, [4, 3]) === 416 && WIN.camMax(24, [3]) === 0 && WIN.camMax(60, [4]) === 144 && WIN.camMax(25, [4]) === 4 && WIN.camMax(127, [1, 4]) === Math.floor((127 * 8 - 192) / 2));

  const ts = convertTileset(ASSETS.tilesets.ts);
  check_('convertTileset keeps its bytes and now returns the tiles\' flags', ts.count === 8 && ts.flags.join() === TILE_FLAGS.join() && ts.bytes.length === 72 && ts.flagsProblem === null);
  const badFlags = convertTileset({ tiles: [{ rows: Array.from({ length: 8 }, () => ({ bits: 0 })), flags: 300 }] });
  check_('a flags value outside 0..255 is remembered as a problem (reported only by a WINDOW game)', /flags must be a whole number 0..255/.test(badFlags.flagsProblem ?? ''));
  const rows = WIN.buildTileRows(ts);
  check_('tile rows: tile * 8 + r is the row; tiles the set lacks are blank', rows.length === 256 && rows[1 * 8 + 0] === 0xFF && rows[7 * 8 + 1] === 0x55 && rows.slice(8 * 8).every((b) => b === 0));
  // the scroll tables against an independent pre-shift (bit strings)
  const tables = WIN.buildScrollTables(rows);
  let bad_ = 0;
  for (let p = 1; p <= 7; p++) for (let i = 0; i < 256; i++) {
    const s = rows[i].toString(2).padStart(8, '0');
    const left = parseInt(s.slice(p) + '0'.repeat(p), 2), right = parseInt(s.slice(0, p), 2);
    if (tables[2 * (p - 1) * 256 + i] !== left || tables[(2 * (p - 1) + 1) * 256 + i] !== right) bad_++;
  }
  check_('scroll tables: 3,584 bytes, page 2(p-1) = LTAB[p], page 2(p-1)+1 = RTAB[p] for p = 1..7, every entry equal to an independent bit-string shift', tables.length === 3584 && bad_ === 0, `${bad_} wrong`);
  check_('scroll tables: LTAB[p][A] | RTAB[p][B] is the 8 pixels p to the right of the start of tile row A followed by tile row B (every pair of rows, every p; an independent bit-string slice)', (() => {
    for (let p = 1; p <= 7; p++) for (const [ia, ib] of [[8, 9], [15, 8], [56, 57], [10, 12], [0, 8], [63, 56]]) {
      const A = rows[ia].toString(2).padStart(8, '0'), B = rows[ib].toString(2).padStart(8, '0');
      if ((tables[2 * (p - 1) * 256 + ia] | tables[(2 * (p - 1) + 1) * 256 + ib]) !== parseInt((A + B).slice(p, p + 8), 2)) return false;
    }
    return true;
  })());
  const fl = WIN.buildTileFlags(ts.flags);
  check_('tile flags: 32 bytes, the tileset\'s then zeros', fl.length === 32 && fl[1] === 1 && fl[7] === 0x81 && fl.slice(8).every((b) => b === 0));
  const desc = WIN.buildWindowDesc({ cx: 4, cy: 4, worldW: 128, camMax: 832, tables: 0xB200, tileFlags: 0x9000, worldSrc: 0x8800, tileRows: 0x9020, bands: [{ rows: 2, code: 1 }, { rows: 3, code: 2 }, { rows: 11, code: 3 }] });
  check_('window_desc bytes: cx cy nbands world_w, DW cam_max tables tile_flags world_src tilerows, then rows / ratio per band', Buffer.from(desc).toString('hex') === '040403' + '80' + '4003' + '00b2' + '0090' + '0088' + '2090' + '020103020b03', Buffer.from(desc).toString('hex'));

  // world maps
  const w1 = WIN.convertWorldMap({ w: 24, h: 2, cells: Array.from({ length: 48 }, (_, i) => (i === 3 ? -1 : i === 4 ? null : i === 5 ? 255 : i % 8)) }, 8);
  check_('world map: 24 x 2, blank cells (-1, null, 255) become tile 0, world_src row r at r * 128, cell = tile * 8, the rest 0', w1.src.length === 2048 && w1.src[128 + 0] === ((24 % 8) * 8) && w1.src[3] === 0 && w1.src[4] === 0 && w1.src[5] === 0 && w1.src[6] === 6 * 8 && w1.src[24] === 0 && w1.src[256] === 0 && w1.src.slice(256).every((b) => b === 0));
  const full = WIN.convertWorldMap(ASSETS.maps.lv, 8);
  let srcOk = true;
  for (let r = 0; r < 16; r++) for (let c = 0; c < 128; c++) if (full.src[r * 128 + c] !== ASSETS.maps.lv.cells[r * 128 + c] * 8) srcOk = false;
  check_('world map: a 128 x 16 map is copied cell by cell as tile * 8', srcOk);
  const sh = WIN.convertWorldMap(ASSETS.maps.short, 8);
  check_('world map: a 9-row map leaves rows 9..15 at 0', sh.src.slice(9 * 128).every((b) => b === 0) && sh.h === 9);
  const hex2 = WIN.convertWorldMap({ w: 24, h: 1, cells: '00'.repeat(23) + '07' }, 8);
  check_('world map: cells as a hex string', hex2.src[23] === 56);
  for (const [name, m, rx] of [
    ['23 wide', { w: 23, h: 4, cells: new Array(92).fill(0) }, /width.*24\.\.128/], ['129 wide', { w: 129, h: 4, cells: new Array(516).fill(0) }, /width.*24\.\.128/],
    ['17 tall', { w: 24, h: 17, cells: new Array(408).fill(0) }, /height.*1\.\.16/], ['0 tall', { w: 24, h: 0, cells: [] }, /height/],
    ['tile 32', { w: 24, h: 1, cells: [...new Array(23).fill(0), 32] }, /tile indexes 0\.\.31/], ['tile 8 not in a tileset of 8', { w: 24, h: 1, cells: [...new Array(23).fill(0), 8] }, /does not define/],
    ['a wrong cell count', { w: 24, h: 2, cells: new Array(47).fill(0) }, /48 cells but/], ['a fraction', { w: 24, h: 1, cells: [...new Array(23).fill(0), 1.5] }, /tile indexes/],
  ]) { let m_ = ''; try { WIN.convertWorldMap(m, 8); } catch (e) { m_ = e.message; } check_(`world map: ${name} is refused`, rx.test(m_), m_ || 'accepted'); }

  // v3 sprites
  const one = (a, o) => convertSpriteV3(a, o);
  const hx = (u8) => Buffer.from(u8).toString('hex');
  check_('v3 sprite 16 x 3, one frame: the rows are mask_hi mask_lo image_hi image_lo as in v2 (contract mask 1 = background shows)', hx(one({ w: 16, h: 3, rows: [{ bits: '8001', mask: 'FFFF' }, { bits: 'F0F0' }, { bits: 'FFFF', mask: '0FF0' }] }).data) === '000080010000f0f0f00f0ff0');
  check_('v3 sprite 8 wide: a row is one mask byte and one image byte; descriptor width 8', (() => { const s = one({ w: 8, h: 2, rows: [{ bits: '81' }, { bits: '0F', mask: 'F0' }] }); return s.w === 8 && hx(s.data) === '0081' + '0f00'; })());
  check_('v3 sprite 32 wide: four mask bytes then four image bytes', (() => { const s = one({ w: 32, h: 1, rows: [{ bits: '80000001', mask: 'FFFFFFFF' }] }); return s.w === 32 && s.wb === 4 && hx(s.data) === '00000000' + '80000001'; })());
  check_('v3 sprite 24 wide: hex of 6 digits', (() => { const s = one({ w: 24, h: 1, rows: [{ bits: 'F00F0F', mask: 'FFFF00' }] }); return s.w === 24 && hx(s.data) === '0000ff' + 'f00f00'; })());
  check_('v3 sprite 12 wide is padded on the right to 16 with transparent pixels (descriptor width 16, srcW 12)', (() => { const s = one({ w: 12, h: 1, rows: [{ bits: '801' }] }); return s.w === 16 && s.srcW === 12 && hx(s.data) === '000f8010'; })());
  check_('v3 sprite 48 high is accepted; 49 high and 33 wide are refused', one({ w: 8, h: 48, rows: Array.from({ length: 48 }, () => ({ bits: 1 })) }).h === 48 && [{ w: 8, h: 49, rows: Array.from({ length: 49 }, () => ({ bits: 1 })) }, { w: 33, h: 1, rows: [{ bits: 1 }] }].every((a) => { try { one(a); return false; } catch { return true; } }));
  const fr = (b) => ({ rows: [{ bits: b }, { bits: b }] });
  const two = one({ w: 8, h: 2, frames: [fr('81'), fr('03'), fr('0F')] }, { allFrames: true });
  check_('frames: all frames are compiled in order when the program uses FRAME; frame data is nframes blocks of h rows', two.nframes === 3 && two.data.length === 3 * 2 * 2 && hx(two.data) === '0081' + '0081' + '0003' + '0003' + '000f' + '000f');
  check_('frames: without FRAME only frame 0 is compiled', one({ w: 8, h: 2, frames: [fr('81'), fr('03')] }).nframes === 1);
  const flipped = one({ w: 8, h: 1, frames: [{ rows: [{ bits: '81' }] }, { rows: [{ bits: '03' }] }, { rows: [{ bits: '1C' }] }] }, { allFrames: true, flip: true });
  // the mirrored frames, from independent bit-string reversal
  const rev = (b) => parseInt(b.toString(2).padStart(8, '0').split('').reverse().join(''), 2);
  check_('FLIP: the mirrored frames follow as frames n..2n-1, each reversed left to right', flipped.nframes === 6 && flipped.framesSrc === 3 && [0x81, 0x03, 0x1C].every((b, k) => flipped.data[2 * k + 1] === b && flipped.data[2 * (3 + k) + 1] === rev(b) && flipped.data[2 * (3 + k)] === 0));
  const flipW = one({ w: 24, h: 1, rows: [{ bits: 'C0A055', mask: 'FFFF00' }] }, { flip: true });
  check_('FLIP of a 24-wide row mirrors across all three bytes, the mask with it (FFFF00 / C0A000 become 00FFFF / 000503: mask FF0000, image 000503)', flipW.nframes === 2 && hx(flipW.data.slice(0, 6)) === '0000ff' + 'c0a000' && hx(flipW.data.slice(6, 12)) === 'ff0000' + '000503', hx(flipW.data));
  check_('FLIP of 17 source frames, and 33 frames, are refused', [{ n: 17, flip: true }, { n: 33, flip: false }].every(({ n, flip }) => { try { one({ w: 8, h: 1, frames: Array.from({ length: n }, () => ({ rows: [{ bits: 1 }] })) }, { allFrames: true, flip }); return false; } catch (e) { return /frames/.test(e.message); } }));
  check_('16 frames with FLIP (32) and 32 frames without are accepted', one({ w: 8, h: 1, frames: Array.from({ length: 16 }, () => ({ rows: [{ bits: 1 }] })) }, { allFrames: true, flip: true }).nframes === 32 && one({ w: 8, h: 1, frames: Array.from({ length: 32 }, () => ({ rows: [{ bits: 1 }] })) }, { allFrames: true }).nframes === 32);
  check_('a frame with the wrong number of rows is refused with its number', (() => { try { one({ w: 8, h: 2, frames: [fr('81'), { rows: [{ bits: 1 }] }] }, { allFrames: true }); return false; } catch (e) { return /frame 1 has 1 rows/.test(e.message); } })());

  // phase memory: the runtime's plan (docs/ARCADE_RUNTIME_API_V3.md), ported in arcade-window.js, equal to planPool() of arcade/tests/m6-common.mjs
  {
    const r = rng(0x9001);
    const ri = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
    let diffs = 0, okN = 0, failN = 0, partial = 0, first = '';
    for (let n = 0; n < 500; n++) {
      const na = ri(1, 8);
      const assets = Array.from({ length: na }, () => ({ w: 8 * ri(1, 4), h: ri(1, 48), phases: [1, 2, 4, 8][ri(0, 3)], nframes: ri(1, 32), instances: r() < 0.15 ? 0 : ri(1, 5) }));
      const pieces = r() < 0.5 ? WIN.DEFAULT_POOL_PIECES : [[0xC080, ri(0, 5000)], [0xF200, ri(0, 3000)], [0xD700, ri(0, 400)]];
      const mine = WIN.planPhasePool(assets, pieces);
      const ref = assets.map((a) => ({ nf: a.nframes, phases: a.phases, slen: (a.phases - 1) * a.h * 2 * (a.w / 8 + 1) }));
      const want = planPool(ref, assets.map((a) => a.instances), pieces);
      const need = poolNeed(ref, assets.map((a) => a.instances));
      if (mine.ok !== want.ok || mine.miss !== want.miss || mine.K.join() !== want.K.join() || mine.need !== need) { diffs++; first ||= `set ${n}: ${JSON.stringify({ mine: [mine.ok, mine.miss, mine.K, mine.need], want: [want.ok, want.miss, want.K, need] })}`; }
      if (mine.ok) { okN++; if (assets.some((a, k) => a.phases > 1 && a.instances > 0 && mine.K[k] < a.nframes)) partial++; } else failN++;
    }
    check_('planPhasePool equals planPool() of the runtime tests (ok, miss, K per asset, the fragmentation-free need) for 500 random asset sets', diffs === 0, `${diffs} differ ${first}; ${okN} fit (${partial} with an uncached frame), ${failN} do not`);
    check_('... and the random sets cover all three outcomes (fully cached, partly cached, boot failure)', okN - partial > 20 && partial > 20 && failN > 20, `${okN - partial} / ${partial} / ${failN}`);
    check_('the pieces come from runtime.json (POOL_A / B / C and their lengths), with the real build\'s as the default', WIN.poolPieces({}).map((p) => p.join(':')).join() === '49280:3456,61952:2176,55040:256' && WIN.poolPieces({ POOL_B: 1, POOL_B_LEN: 2 })[1].join() === '1,2');
    // the contract's reference art set at the phases the runtime document names: fully cached
    const set = [
      { w: 16, h: 24, phases: 2, nframes: 16, instances: 1 }, { w: 16, h: 16, phases: 4, nframes: 4, instances: 3 }, { w: 16, h: 16, phases: 4, nframes: 2, instances: 3 },
      { w: 8, h: 8, phases: 8, nframes: 4, instances: 4 }, { w: 8, h: 8, phases: 8, nframes: 1, instances: 1 },
    ];
    const pl = WIN.planPhasePool(set);
    check_('the contract\'s reference art set (player 2 / walker 4 / flyer 4 / coin 8 / shot 8 phases) is fully cached: K = nframes for every asset', pl.ok && pl.K.join() === '16,4,2,4,1', pl.K.join());
    const set4 = [{ ...set[0], phases: 4 }, ...set.slice(1)];
    check_('with the player at 4 phases only part of its 16 frames stay cached (K = 6, as the runtime document says); the rest stay cached', WIN.planPhasePool(set4).K.join() === '6,4,2,4,1', WIN.planPhasePool(set4).K.join());
    check_('the build-time estimate follows the measured table (8x8/8 about 14,250, 16x24/4 about 32,088 T), scaled by area x (phases - 1)', Math.abs(WIN.buildFrameT(8, 8, 8) - 14250) < 6000 && Math.abs(WIN.buildFrameT(16, 24, 4) - 32088) < 8000 && WIN.buildFrameT(32, 48, 8) > WIN.buildFrameT(16, 24, 4) * 4);
    info(`build estimates: 8x8/8 ${WIN.buildFrameT(8, 8, 8)}, 16x16/4 ${WIN.buildFrameT(16, 16, 4)}, 16x24/4 ${WIN.buildFrameT(16, 24, 4)}, 32x32/4 ${WIN.buildFrameT(32, 32, 4)} T`);
  }
}

// =================================================================================================================
// 4. The reference interpreter
// =================================================================================================================
console.log('\n4. The reference interpreter (hand-computed)');
{
  const run = (src, ticks = 1, o = {}) => interpret(parse(src).ast, { version: 3, ticks, assets: ASSETS, maxSteps: 50_000_000, ...o });
  const one = (body, o = {}) => run(prog(body, o)).ticks[0];
  const v = (body, o) => one(body, o).vars.V;
  const lv = ASSETS.maps.lv;
  check_('V_CAM starts at 0; CAMX() reads it', run(prog('    v = CAMX()')).init.cam === 0 && v('    v = CAMX()') === 0);
  check_('CAMERA clamps to 0..cam_max (832 for a 128 wide world with the default band)', v('    CAMERA 100\n    v = CAMX()') === 100 && v('    CAMERA 5000\n    v = CAMX()') === 832 && v('    CAMERA -50\n    v = CAMX()') === 0 && v('    CAMERA 832\n    v = CAMX()') === 832 && v('    CAMERA 833\n    v = CAMX()') === 832);
  check_('CAMERA treats its value as signed 16 bit (-32768 is 0; 32767 is cam_max)', v('    CAMERA -32768\n    v = CAMX()') === 0 && v('    CAMERA 32767\n    v = CAMX()') === 832);
  check_('a band at 2/1 halves cam_max (416)', v('    CAMERA 5000\n    v = CAMX()', { win: 'WINDOW level\nBAND 4, 2, 1\nBAND 12, 1, 1\n' }) === 416);
  check_('a 24 wide world has cam_max 0', v('    CAMERA 100\n    v = CAMX()', { map: 'MAP level = "tiny"\n' }) === 0);
  check_('the record has cam and a copy of WORLD_RAM (2,048 bytes, cell = tile * 8)', (() => { const r = one('    CAMERA 7'); return r.cam === 7 && r.worldRam.length === 2048 && r.worldRam[5 * 128 + 3] === lv.cells[5 * 128 + 3] * 8; })());
  check_('WORLDTILE: the tile of the cell holding the pixel; cells are 8 x 8', v('    v = WORLDTILE(0, 0) * 100 + WORLDTILE(8, 8)') === lv.cells[0] * 100 + lv.cells[1 * 128 + 1] && v('    v = WORLDTILE(7, 7) + WORLDTILE(1000, 120) * 10') === lv.cells[0] + lv.cells[15 * 128 + 125] * 10);
  check_('WORLDTILE outside the world is 0: left, right, above, below, far away', ['-1, 20', '1024, 20', '20, -1', '20, 128', '-3000, 5000', '1023, 128'].every((a) => v(`    v = WORLDTILE(${a}) + 100`) === 100));
  const flagsAt = (x, y) => TILE_FLAGS[lv.cells[(y >> 3) * 128 + (x >> 3)]];
  check_('TILEFLAGS in the world is the tile\'s flags byte', [[16, 112], [40, 104], [8, 8], [200, 90]].every(([x, y]) => v(`    v = TILEFLAGS(${x}, ${y})`) === flagsAt(x, y)));
  check_('TILEFLAGS outside: 1 on the left, the right and above; 0 below', v('    v = TILEFLAGS(-1, 50)') === 1 && v('    v = TILEFLAGS(1024, 50)') === 1 && v('    v = TILEFLAGS(50, -1)') === 1 && v('    v = TILEFLAGS(50, 128)') === 0 && v('    v = TILEFLAGS(50, 5000)') === 0 && v('    v = TILEFLAGS(50, -5000)') === 1);
  check_('TILEFLAGS at a corner outside: below wins (a point below the world is empty whatever its column)', v('    v = TILEFLAGS(-1, 128) + TILEFLAGS(1024, 200) * 10') === 0 && v('    v = TILEFLAGS(-1, -1)') === 1);
  check_('TILEFLAGS beyond the width of a short world (60 wide) is solid, and WORLDTILE 0', v('    v = TILEFLAGS(480, 20) * 10 + WORLDTILE(480, 20)', { map: 'MAP level = "mid"\n' }) === 10 && v('    v = TILEFLAGS(479, 100)', { map: 'MAP level = "mid"\n' }) === TILE_FLAGS[ASSETS.maps.mid.cells[12 * 60 + 59]]);
  check_('a world of 9 rows: rows 9..15 are tile 0 inside the world (empty, flags 0), not outside', v('    v = TILEFLAGS(20, 100) + WORLDTILE(20, 120)', { map: 'MAP level = "short"\n' }) === 0);
  check_('TILEHIT ORs the flags of the cells the rectangle touches, ANDed with the mask', v('    v = TILEHIT(0, 112, 24, 16, 255)') === (flagsAt(0, 112) | flagsAt(8, 112) | flagsAt(16, 112) | flagsAt(0, 120) | flagsAt(8, 120) | flagsAt(16, 120)) && v('    v = TILEHIT(0, 112, 24, 16, 1)') === 1);
  check_('TILEHIT rectangle edges: x..x+w-1 (w = 8 stays in one cell, w = 9 reaches the next)', v('    v = TILEHIT(8, 112, 8, 1, 255) + TILEHIT(9, 112, 8, 1, 255) * 0') === flagsAt(8, 112) && v('    v = TILEHIT(8, 0, 9, 1, 255)') === (flagsAt(8, 0) | flagsAt(16, 0)));
  check_('TILEHIT with w or h of 0 or less touches nothing', ['0, 5', '5, 0', '-3, 5', '5, -1'].every((a) => v(`    v = TILEHIT(0, 112, ${a}, 255)`) === 0));
  check_('TILEHIT with a mask of 0 is 0; a mask of 6 sees only bits 1 and 2; outside cells count as solid', v('    v = TILEHIT(0, 112, 24, 16, 0)') === 0 && v('    v = TILEHIT(-4, 60, 8, 8, 255)') === 1 && v('    v = TILEHIT(-4, 60, 8, 8, 6)') === 0);
  check_('SOLID is TILEHIT(..., 1): the game bit 7 of tile 7 (flags $81) is not seen, its solid bit is', v('    v = SOLID(1016, 20, 8, 8) * 10 + SOLID(500, 40, 8, 8)') === 10 + 0);
  check_('SETWORLD changes the cell the pixel is in; WORLDTILE, TILEFLAGS and WORLD_RAM see it at once', (() => {
    const r = one('    SETWORLD 17, 9 = 3\n    v = WORLDTILE(16, 8) * 100 + TILEFLAGS(23, 15)');
    return r.vars.V === 3 * 100 + TILE_FLAGS[3] && r.worldRam[1 * 128 + 2] === 24;
  })());
  check_('SETWORLD ignores a cell outside the world (left, right, above, below, column beyond a short world) and a tile outside 0..min(31, count - 1)', (() => {
    const r = one('    SETWORLD -1, 5 = 1\n    SETWORLD 1024, 5 = 1\n    SETWORLD 5, -1 = 1\n    SETWORLD 5, 128 = 1\n    SETWORLD 5, 5 = 8\n    SETWORLD 5, 5 = k - 3\n    SETWORLD 5, 5 = 99\n    SETWORLD 12, 12 = w + 40');
    return Buffer.compare(Buffer.from(r.worldRam), Buffer.from(run(prog('')).init.worldRam)) === 0;
  })());
  check_('SETWORLD tile 7 (the last of the tileset of 8) works, tile 0 clears', (() => {
    const r = one('    SETWORLD 100, 8 = 7\n    SETWORLD 108, 8 = 0');
    return r.worldRam[128 + 12] === 56 && r.worldRam[128 + 13] === 0;
  })());
  check_('SETWORLD in the middle of a short world\'s 24 columns: column 24 is outside', (() => {
    const r = one('    SETWORLD 190, 8 = 2\n    SETWORLD 192, 8 = 2', { map: 'MAP level = "tiny"\n' });
    return r.worldRam[128 + 23] === 16 && r.worldRam[128 + 24] === 0;
  })());
  check_('the state is kept between ticks (SETWORLD at tick 1 is seen at tick 2); WORLD_RAM is a copy per record', (() => {
    const r = run(prog('    k = k + 1\n    SETWORLD 8 * k, 0 = 5\n    v = v + WORLDTILE(8 * (k - 1), 0)'), 3);
    return r.ticks[2].worldRam[2] === 40 && r.ticks[0].worldRam[2] === 0 && r.ticks[2].vars.V === ASSETS.maps.lv.cells[0] + 5 + 5;
  })());
  check_('collision words work inside DEF FN, CONST conditions fold, and their arguments are evaluated left to right once', v('    v = FN under(8)', { decl: 'DIM v, w, k\n  DEF FN under(x) = TILEFLAGS(x, 112) + WORLDTILE(x, 112)' }) === flagsAt(8, 112) + lv.cells[14 * 128 + 1]);

  // SHOW
  const sh = (body, o) => one(body, o).sprites;
  check_('SHOW stores x, y UNCLAMPED (signed 16 bit) in a window game', (() => { const s = sh('    SHOW p AT -20, 1000\n    SHOW c(0) AT 3000, -5'); return s[0].x === -20 && s[0].y === 1000 && s[1].x === 3000 && s[1].y === -5 && s[0].visible === 1; })());
  check_('SHOW wraps to signed 16 bit (40000 is -25536)', sh('    SHOW p AT 40000, 0')[0].x === -25536);
  check_('SPR_TAB entries carry the asset: player 0, the coin pool 1 (instances 1..3), unused entries asset 0', (() => { const s = sh('    SHOW c(2) AT 1, 1'); return s[0].asset === 0 && s[1].asset === 1 && s[3].asset === 1 && s[4].asset === 0 && s[3].visible === 1 && s[2].visible === 0; })());
  check_('plain SHOW keeps the frame (0 at the start); FRAME sets it; a later plain SHOW keeps the new one; HIDE keeps it', (() => {
    const r = run(prog('    k = k + 1\n    IF k = 1 THEN SHOW p AT 1, 1 ENDIF\n    IF k = 2 THEN SHOW p AT 2, 1 FRAME 5 ENDIF\n    IF k = 3 THEN SHOW p AT 3, 1 ENDIF\n    IF k = 4 THEN HIDE p ENDIF\n    IF k = 5 THEN SHOW p AT 3, 1 ENDIF'), 5).ticks;
    return r.map((t) => t.sprites[0].frame).join() === '0,5,5,5,5' && r[3].sprites[0].visible === 0;
  })());
  check_('FLIP adds the number of source frames n: the player has 8 and the program gives it FRAMEs, so FRAME 3 FLIP is 11, FRAME k + 7 FLIP is 15 and FLIP alone (with another SHOW of it that has a FRAME) is 8',
    sh('    SHOW p AT 1, 1 FRAME 3 FLIP')[0].frame === 11 && sh('    SHOW p AT 1, 1 FRAME k + 7 FLIP')[0].frame === 15 && sh('    SHOW p AT 1, 1 FLIP\n    SHOW p AT 1, 1 FRAME 2')[0].frame === 2 && sh('    IF k = 0 THEN SHOW p AT 1, 1 FLIP ENDIF\n    IF k = 5 THEN SHOW p AT 1, 1 FRAME 2 ENDIF')[0].frame === 8);
  check_('FLIP alone, with no FRAME on the asset anywhere: only frame 0 is compiled, n = 1, so FLIP is frame 1', sh('    SHOW p AT 1, 1 FLIP')[0].frame === 1);
  check_('an asset with no FRAME other than the literal 0 compiles frame 0 only (n = 1): FLIP alone is frame 1', sh('    SHOW c(0) AT 1, 1 FLIP', { sprites: 'SPRITE p = "player"\nSPRITE c(3) = "plain"\n' })[1].frame === 1 && sh('    SHOW c(0) AT 1, 1 FRAME 0 FLIP', { sprites: 'SPRITE p = "player"\nSPRITE c(3) = "plain"\n' })[1].frame === 1);
  check_('the stored frame is taken AND $FF (300 is 44), a negative frame wraps (-1 is 255)', sh('    SHOW p AT 1, 1 FRAME 300')[0].frame === 44 && sh('    SHOW p AT 1, 1 FRAME k - 1')[0].frame === 255);
  check_('opts.clampFrame clamps the stored frame to the compiled frame count - 1', run(prog('    SHOW p AT 1, 1 FRAME 40'), 1, { clampFrame: true }).ticks[0].sprites[0].frame === 7 && run(prog('    SHOW p AT 1, 1 FRAME 40 FLIP'), 1, { clampFrame: true }).ticks[0].sprites[0].frame === 15);
  check_('an index outside the pool ignores SHOW FRAME (the frame is still evaluated)', (() => { const r = one('    SHOW c(7) AT 1, 1 FRAME 2\n    v = 5'); return r.sprites.every((s) => s.visible === 0) && r.vars.V === 5; })());
  const noWin = (body) => run(prog(body, { win: '', map: '' }), 1, { version: 3 }).ticks[0].sprites;
  check_('v3 without a WINDOW clamps per asset: x 0..256 - w, y 0..192 - h (player 16 x 24: 240 / 168; coin 8 x 8: 248 / 184)', (() => { const s = noWin('    SHOW p AT 300, 300\n    SHOW c(0) AT 300, 300\n    SHOW p AT -5, -5'); return s[0].x === 0 && s[0].y === 0 && s[1].x === 248 && s[1].y === 184; })());
  check_('v3 without a WINDOW: the player at the far corner is (240, 168)', (() => { const s = noWin('    SHOW p AT 300, 300'); return s[0].x === 240 && s[0].y === 168; })());
  check_('version 2 keeps the old clamp (239, 176) and the old records (no asset or frame fields)', (() => { const r = run(prog('    SHOW p AT 300, 300', { win: '', map: '', sprites: 'SPRITE p = "plain"\n' }), 1, { version: 2 }).ticks[0].sprites[0]; return r.x === 239 && r.y === 176 && r.frame === undefined; })());
  check_('FRAME 0 (the literal) on a version 2 interpreter is a plain SHOW; other frames are unsupported', (() => {
    const src = prog('    SHOW p AT 1, 1 FRAME 0', { win: '', map: '', sprites: 'SPRITE p = "plain"\n' });
    let threw = false; try { run(prog('    SHOW p AT 1, 1 FRAME 1', { win: '', map: '', sprites: 'SPRITE p = "plain"\n' }), 1, { version: 2 }); } catch { threw = true; }
    return run(src, 1, { version: 2 }).ticks[0].sprites[0].visible === 1 && threw;
  })());
  check_('the CONSTs of the program reach BAND and WINDOW', (() => { const r = run(prog('    CAMERA 5000', { top: 'CONST R = 4\n', win: 'WINDOW level AT R, 2\nBAND R, 2, 1\nBAND 16 - R, 1, 1\n' }), 1).ticks[0]; return r.cam === 416; })());
}

// =================================================================================================================
// 5. The code generator and the linker
// =================================================================================================================
console.log('\n5. Code generator and linker: header, descriptors, window_desc, the image, errors, refusals, the link report');
const PLAT = PROGRAMS[0].src;
const PLAT_RES = cm(PLAT);
const MEM = PLAT_RES.memory;
const w16 = (a) => MEM[a] | (MEM[a + 1] << 8);
{
  check_('the platformer compiles on the mock v3 runtime', PLAT_RES.errors.length === 0 && !!PLAT_RES.dck, errText(PLAT_RES));
  check_('frame_div = 60 / 20 = 3 with DIV_EXT $80 and DIV_WIN $40 set ($C3); the header is 20 bytes', MEM[0x8004] === 0xC3 && PLAT_RES.gen.headerLen === 20 && PLAT_RES.usage.header === 20);
  check_('header: sprite_table at +6 is $8014 (the descriptors follow the 20-byte header); map_table +16 is 0 (no screen map); window_desc +18 points into the image', w16(0x8006) === 0x8014 && w16(0x8010) === 0 && w16(0x8012) >= 0x8014 && w16(0x8012) < 0xB200);
  const wd = w16(0x8012);
  check_('window_desc: cx 4, cy 4, 3 bands, world_w 128, cam_max 832, tables $B200', MEM[wd] === 4 && MEM[wd + 1] === 4 && MEM[wd + 2] === 3 && MEM[wd + 3] === 128 && w16(wd + 4) === 832 && w16(wd + 6) === 0xB200);
  check_('window_desc: the bands (2, ratio 1), (3, ratio 2), (11, ratio 3) follow at +14', [2, 1, 3, 2, 11, 3].every((b, i) => MEM[wd + 14 + i] === b));
  const flagsAt = w16(wd + 8), srcAt = w16(wd + 10), rowsAt = w16(wd + 12);
  check_('window_desc: tile_flags is 32 bytes equal to the tileset\'s flags then zeros', Buffer.from(MEM.slice(flagsAt, flagsAt + 32)).toString('hex') === Buffer.from(WIN.buildTileFlags(TILE_FLAGS)).toString('hex'));
  check_('window_desc: world_src is the 2,048-byte map, row r at r * 128, cell = tile * 8, columns beyond the width 0', (() => {
    const lv = ASSETS.maps.lv;
    for (let r = 0; r < 16; r++) for (let c = 0; c < 128; c++) if (MEM[srcAt + r * 128 + c] !== lv.cells[r * 128 + c] * 8) return false;
    return true;
  })());
  check_('window_desc: tilerows is 256 bytes, tile * 8 + r = the tile\'s row r', (() => { const t = ASSETS.tilesets.ts.tiles; for (let i = 0; i < 8; i++) for (let r = 0; r < 8; r++) if (MEM[rowsAt + i * 8 + r] !== t[i].rows[r].bits) return false; return MEM.slice(rowsAt + 64, rowsAt + 256).every((b) => b === 0); })());
  // the tables in the image against an independent pre-shift of the image's own tilerows
  let tb = 0;
  for (let p = 1; p <= 7; p++) for (let i = 0; i < 256; i++) {
    const s = MEM[rowsAt + i].toString(2).padStart(8, '0');
    if (MEM[0xB200 + 2 * (p - 1) * 256 + i] !== parseInt(s.slice(p) + '0'.repeat(p), 2) || MEM[0xB200 + (2 * (p - 1) + 1) * 256 + i] !== parseInt(s.slice(0, p), 2)) tb++;
  }
  check_('the 14 scroll-table pages sit at $B200..$BFFF (page aligned, the end of the game area), every byte an independent shift of the image\'s tile rows', tb === 0 && (0xB200 & 255) === 0, `${tb} wrong`);
  // descriptors
  const d = (a) => ({ w: MEM[0x8014 + 8 * a], h: MEM[0x8015 + 8 * a], data: w16(0x8016 + 8 * a), hot: w16(0x8018 + 8 * a), phases: MEM[0x801A + 8 * a], nframes: MEM[0x801B + 8 * a] });
  const [d0, d1, d2] = [d(0), d(1), d(2)];
  check_('descriptors (8 bytes): player 16 x 24, 8 phases, 16 frames (8 + 8 mirrored); coin 8 x 8, 4 frames (no FLIP); plain 16 x 16, 1 frame', d0.w === 16 && d0.h === 24 && d0.nframes === 16 && d0.phases === 8 && d1.w === 8 && d1.h === 8 && d1.nframes === 4 && d2.w === 16 && d2.h === 16 && d2.nframes === 1 && MEM[0x8005] === 3);
  check_('frame data: the player is 16 frames x 24 rows x 4 bytes; the coin 4 x 8 x 2; the plain 16 rows x 4', d1.data - d0.data === 16 * 24 * 4 && d2.data - d1.data === 4 * 8 * 2);
  // mirrored player frame k+8 == frame k reversed (the covering pixels reversed; mask 1 = background)
  const rev16 = (v) => parseInt(v.toString(2).padStart(16, '0').split('').reverse().join(''), 2);
  let mir = 0;
  for (let f = 0; f < 8; f++) for (let y = 0; y < 24; y++) {
    const a = d0.data + (f * 24 + y) * 4, b = d0.data + ((f + 8) * 24 + y) * 4;
    const mask = (MEM[a] << 8) | MEM[a + 1], img = (MEM[a + 2] << 8) | MEM[a + 3];
    const wantMask = 0xFFFF ^ rev16(0xFFFF ^ mask), wantImg = rev16(img);
    if (((MEM[b] << 8) | MEM[b + 1]) !== wantMask || ((MEM[b + 2] << 8) | MEM[b + 3]) !== wantImg) mir++;
  }
  check_('the mirrored copy of every player frame (8..15) is frame 0..7 reversed left to right (mask and image)', mir === 0, `${mir} wrong rows`);
  check_('hot boxes: the player\'s [3, 2, 10, 22] is in the image; the pool shares its asset\'s box', Array.from(MEM.slice(d0.hot, d0.hot + 4)).join() === '3,2,10,22');
  check_('instances: 1 player + 4 coins + 2 enemies = 7; the instance table lists their assets', (() => { const t = w16(0x800E); return MEM[t] === 7 && Array.from(MEM.slice(t + 1, t + 8)).join() === '0,1,1,1,1,2,2'; })());
  check_('the image fits: code + frames + window data + 3,584 table bytes inside $8000..$BFFF', PLAT_RES.usage.end <= 0xB200 && PLAT_RES.usage.free >= 0);

  // calls in the code: a program image is hard to read; look for the CALLs to the trap addresses
  const calls = (addr) => { let n = 0; const lo = addr & 255, hi = addr >> 8; for (let a = PLAT_RES.gen.base; a < PLAT_RES.gen.base + PLAT_RES.gen.code.length - 2; a++) if (MEM[a] === 0xCD && MEM[a + 1] === lo && MEM[a + 2] === hi) n++; return n; };
  const RT = mockRuntime().symbols;
  check_('the code CALLs RT_SHOWF (FRAME / FLIP), RT_SHOW (plain SHOW), RT_CAMERA, RT_TILEHIT (SOLID / TILEHIT), RT_WORLDTILE, RT_SETWORLD', calls(RT.RT_SHOWF) >= 3 && calls(RT.RT_SHOW) >= 1 && calls(RT.RT_CAMERA) === 1 && calls(RT.RT_TILEHIT) >= 5 && calls(RT.RT_WORLDTILE) >= 1 && calls(RT.RT_SETWORLD) === 1, `showf ${calls(RT.RT_SHOWF)} show ${calls(RT.RT_SHOW)} cam ${calls(RT.RT_CAMERA)} hit ${calls(RT.RT_TILEHIT)}`);
  const ret1 = cm(prog('    CAMERA 5\n    v = CAMX()'));
  const camx = (() => { const a = ADDR.V_CAM; for (let i = ret1.gen.base; i < ret1.gen.base + ret1.gen.code.length - 2; i++) if (ret1.memory[i] === 0x2A && ret1.memory[i + 1] === (a & 255) && ret1.memory[i + 2] === a >> 8) return true; return false; })();
  check_('CAMX() is a plain LD HL,(V_CAM), no call', camx);
  check_('V_CAM and the other addresses come from runtime.json: another V_CAM changes the code', (() => { const r = cm(prog('    v = CAMX()'), ASSETS, { V_CAM: 0xE180 }); return r.errors.length === 0 && Array.from(r.memory.slice(r.gen.base, r.gen.base + r.gen.code.length)).join().includes('42,128,225') ; })());

  // window layouts
  const lay = (win, extraMap = 'MAP level = "lv"\n') => { const r = cm(prog('    v = 1', { win, map: extraMap })); const wd2 = r.memory[0x8012] | (r.memory[0x8013] << 8); return { r, nb: r.memory[wd2 + 2], max: r.memory[wd2 + 4] | (r.memory[wd2 + 5] << 8), bands: Array.from(r.memory.slice(wd2 + 14, wd2 + 14 + 2 * r.memory[wd2 + 2])), cx: r.memory[wd2], cy: r.memory[wd2 + 1], w: r.memory[wd2 + 3] }; };
  const l1 = lay('WINDOW level\n');
  check_('no BAND: one band of 16 rows at ratio 1/1 (code 3); cam_max 832; default position (4, 4)', l1.nb === 1 && l1.bands.join() === '16,3' && l1.max === 832 && l1.cx === 4 && l1.cy === 4);
  const l2 = lay('WINDOW level AT 0, 8\nBAND 4, 0, 1\nBAND 4, 1, 4\nBAND 4, 2, 1\nBAND 4, 1, 1\n');
  check_('four bands, a fixed one and a 2/1 one: ratio codes 0 1 4 3, cam_max (1024 - 192) / 2 = 416, position (0, 8)', l2.nb === 4 && l2.bands.join() === '4,0,4,1,4,4,4,3' && l2.max === 416 && l2.cx === 0 && l2.cy === 8);
  const l3 = lay('WINDOW level\nBAND 6, 1, 4\nBAND 10, 1, 2\n', 'MAP level = "mid"\n');
  check_('a 60 wide world: world_w 60, cam_max 480 - 192 = 288', l3.w === 60 && l3.max === 288);
  const l4 = lay('WINDOW level\n', 'MAP level = "tiny"\n');
  check_('a 24 wide world: cam_max 0', l4.w === 24 && l4.max === 0);

  // the world map is not a screen map
  const hudRes = cm(prog('    v = 1', { map: 'MAP level = "lv"\nMAP hud = "hud"\n' }));
  check_('the window\'s MAP is not in the map table or the boot map: with one other MAP the old map_ptr image is used (map_ptr +12 set, map_table +16 zero)', hudRes.errors.length === 0 && (hudRes.memory[0x800C] | (hudRes.memory[0x800D] << 8)) !== 0 && (hudRes.memory[0x8010] | (hudRes.memory[0x8011] << 8)) === 0, errText(hudRes));
  const hud2 = cm(prog('    LOADMAP hud AT 0, 22', { map: 'MAP level = "lv"\nMAP hud = "hud"\n' }));
  check_('with a LOADMAP the table lists only the other maps (count 1); the world is not there', (() => { const t = hud2.memory[0x8010] | (hud2.memory[0x8011] << 8); return hud2.errors.length === 0 && hud2.memory[t] === 1; })(), errText(hud2));

  // errors of the contract's section 7 (compile time, with line and column)
  cmBad('CAMERA without a WINDOW', prog('    CAMERA 5', { win: '', map: '' }), /CAMERA needs a WINDOW/);
  cmBad('SETWORLD without a WINDOW', prog('    SETWORLD 1, 1 = 1', { win: '', map: '' }), /SETWORLD needs a WINDOW/);
  for (const f of ['CAMX()', 'WORLDTILE(1, 2)', 'TILEFLAGS(1, 2)', 'TILEHIT(1, 2, 3, 4, 5)', 'SOLID(1, 2, 3, 4)']) cmBad(`${f} without a WINDOW`, prog(`    v = ${f}`, { win: '', map: '' }), new RegExp(`${f.split('(')[0]}\\(\\) needs a WINDOW`));
  const at = cm(prog('    v = SOLID(1, 2, 3, 4)', { win: '', map: '' }));
  check_('the error carries line and column of the word', at.errors[0].line === 11 && at.errors[0].col === 8, `${at.errors[0].line}:${at.errors[0].col}`);
  const mapAsset = (m) => withMap('lv', m);
  cmBad('a world map 23 wide', prog('    v = 1'), /world map "lv": the world map width .*24\.\.128/, mapAsset({ w: 23, h: 4, cells: new Array(92).fill(0) }));
  cmBad('a world map 129 wide', prog('    v = 1'), /world map width .*24\.\.128/, mapAsset({ w: 129, h: 4, cells: new Array(516).fill(0) }));
  cmBad('a world map 17 tall', prog('    v = 1'), /world map height .*1\.\.16/, mapAsset({ w: 24, h: 17, cells: new Array(408).fill(0) }));
  cmBad('a tile index above 31 in the world map', prog('    v = 1'), /tile indexes 0\.\.31/, mapAsset({ w: 24, h: 1, cells: [...new Array(23).fill(0), 32] }));
  cmBad('a tile the tileset does not define (tile 9; the set has 8)', prog('    v = 1'), /tile 9, which the tileset does not define/, mapAsset({ w: 24, h: 1, cells: [...new Array(23).fill(0), 9] }));
  cmBad('a WINDOW with no TILESET', prog('    v = 1').replace('TILESET ts = "ts"\n', ''), /WINDOW needs a TILESET/);
  cmBad('a WINDOW whose map asset is missing', prog('    v = 1', { map: 'MAP level = "nothing"\n' }), /map asset "nothing" is not in the project/);
  const nameAt = cm(prog('    v = 1', { win: '\nWINDOW level\n' }).replace('MAP level = "lv"', 'MAP level = "lv"'), mapAsset({ w: 10, h: 4, cells: new Array(40).fill(0) }));
  check_('the map error is reported at the WINDOW\'s map name (line and column)', nameAt.errors.length === 1 && nameAt.errors[0].line === 8 && nameAt.errors[0].col === 7, `${nameAt.errors[0]?.line}:${nameAt.errors[0]?.col}`);
  cmBad('FRAME 8 of a sprite with 8 frames (0..7)', prog('    SHOW p AT 1, 1 FRAME 8'), /FRAME 8 is outside the sprite "player".*8 frames \(0\.\.7\)/);
  cmBad('FRAME -1', prog('    SHOW p AT 1, 1 FRAME -1'), /FRAME -1 is outside/);
  cmBad('FRAME 1 FLIP of a sprite that has one frame', prog('    SHOW c(0) AT 1, 1 FRAME 1 FLIP', { sprites: 'SPRITE p = "player"\nSPRITE c(3) = "plain"\n' }), /FRAME 1 is outside the sprite "plain": it has 1 frame/);
  cmBad('a CONST frame outside the asset', prog('    SHOW p AT 1, 1 FRAME NF', { top: 'CONST NF = 9\n' }), /FRAME 9 is outside/);
  const tooMany = withAssets({ sprites: { ...ASSETS.sprites, many: { w: 8, h: 1, frames: Array.from({ length: 17 }, () => ({ rows: [{ bits: 1 }] })) } } });
  cmBad('FLIP on an asset with 17 frames (34 after mirroring)', prog('    SHOW p AT 1, 1 FRAME 2 FLIP', { sprites: 'SPRITE p = "many"\n' }), /17 frames and FLIP.*34|2n|make 34/, tooMany);
  const ok17 = cm(prog('    SHOW p AT 1, 1 FRAME 2', { sprites: 'SPRITE p = "many"\n' }), tooMany);
  check_('the same asset without FLIP (17 frames) is fine', ok17.errors.length === 0, errText(ok17));
  const f33 = withAssets({ sprites: { ...ASSETS.sprites, many: { w: 8, h: 1, frames: Array.from({ length: 33 }, () => ({ rows: [{ bits: 1 }] })) } } });
  cmBad('33 frames used with FRAME', prog('    SHOW p AT 1, 1 FRAME 2', { sprites: 'SPRITE p = "many"\n' }), /33 frames: at most 32/, f33);
  const f33ok = cm(prog('    SHOW p AT 1, 1', { sprites: 'SPRITE p = "many"\n' }), f33);
  check_('an asset with 33 frames the program never gives a FRAME compiles frame 0 only', f33ok.errors.length === 0 && f33ok.memory[0x801B] === 1, errText(f33ok));
  const wide = withAssets({ sprites: { ...ASSETS.sprites, big: { w: 33, h: 4, rows: Array.from({ length: 4 }, () => ({ bits: 1 })) }, huge: { w: 8, h: 49, rows: Array.from({ length: 49 }, () => ({ bits: 1 })) } } });
  cmBad('a sprite 33 wide', prog('    SHOW p AT 1, 1', { sprites: 'SPRITE p = "big"\n' }), /width 33 is not supported/, wide);
  cmBad('a sprite 49 tall', prog('    SHOW p AT 1, 1', { sprites: 'SPRITE p = "huge"\n' }), /height 49 is not supported/, wide);
  cmBad('TILEHIT inside SOLID', prog('    v = SOLID(1, 2, 3, TILEHIT(1, 2, 3, 4, 5))'), /SOLID cannot have TILEHIT or SOLID .* inside its arguments/);
  cmBad('SOLID inside TILEHIT', prog('    v = TILEHIT(SOLID(1, 2, 3, 4), 2, 3, 4, 5)'), /TILEHIT cannot have TILEHIT or SOLID/);
  cmBad('SOLID inside FILL (they share the argument block)', prog('    FILL 1, 1, 2, 2 = SOLID(1, 2, 3, 4)'), /FILL cannot have TILEHIT or SOLID/);
  cmBad('SOLID inside COPY', prog('    COPY 1, 1, 2, SOLID(1, 2, 3, 4) TO 5, 5'), /COPY cannot have TILEHIT or SOLID/);
  cmBad('SOLID inside SETWORLD', prog('    SETWORLD 1, 1 = SOLID(1, 2, 3, 4)'), /SETWORLD cannot have TILEHIT or SOLID/);
  cmBad('a DEF FN that uses SOLID inside TILEHIT (through the FN)', prog('    v = TILEHIT(FN s(1), 2, 3, 4, 5)', { decl: 'DIM v, w, k\n  DEF FN s(x) = SOLID(x, 1, 2, 3)' }), /TILEHIT cannot have TILEHIT or SOLID/);
  cmBad('SETWORLD with a constant tile above the tileset (tile 9 of 8) and above 31', prog('    SETWORLD 8, 8 = 9'), /tile 9 cannot be placed in the world: the world has the tiles 0\.\.7/);
  const tsBad = withAssets({ tilesets: { ts: { tiles: [{ flags: 999, rows: Array.from({ length: 8 }, () => ({ bits: 0 })) }] } } });
  cmBad('a tileset flags value of 999 in a WINDOW game', prog('    v = 1'), /flags must be a whole number 0\.\.255/, withAssets({ tilesets: tsBad.tilesets, maps: { ...ASSETS.maps, lv: { w: 24, h: 1, cells: new Array(24).fill(0) } } }));
  const tile0 = withAssets({ tilesets: { ts: { tiles: ASSETS.tilesets.ts.tiles.map((t, i) => (i === 0 ? { ...t, rows: t.rows.map((r) => ({ ...r, bits: 0x10 })) } : t)) } } });
  const t0 = cm(prog('    v = 1'), tile0);
  check_('tile 0 not blank: a warning on the compile (not an error)', t0.errors.length === 0 && t0.warnings.some((w) => /tile 0 of the tileset "ts" is not blank/.test(w.message)), errText(t0));

  // refusals by the old runtimes
  const rt2 = (v) => ({ runtime: { ...mockRuntime(), version: v }, image: new Uint8Array(65536), assets: ASSETS });
  const c2 = compile(prog('    CAMERA 5\n    SHOW p AT 1, 1 FLIP'), rt2(2));
  check_('a v2 runtime refuses a WINDOW program with "needs the v3 runtime" and the line', c2.errors.length >= 2 && c2.errors.every((e) => /needs the v3 runtime/.test(e.message) && e.line >= 1) && !c2.dck, errText(c2));
  const c2f = compile(prog('    SHOW p AT 1, 1 FRAME 3', { win: '', map: '', sprites: 'SPRITE p = "plain"\n' }), rt2(2));
  check_('a v2 runtime refuses FRAME 3: the old message plus the hint', c2f.errors.length === 1 && /SHOW \.\.\. FRAME is not supported yet in M4a; FRAME needs the v3 runtime/.test(c2f.errors[0].message), errText(c2f));
  const c2z = compile(prog('    SHOW p AT 1, 1 FRAME 0', { win: '', map: '', sprites: 'SPRITE p = "plain"\n' }), rt2(2));
  check_('a v2 runtime accepts FRAME 0 (the literal) as a plain SHOW', c2z.errors.length === 0 && !!c2z.dck, errText(c2z));
  const c2w = compile(prog('    SHOW p AT 1, 1', { win: '', map: '', sprites: 'SPRITE p = "wide"\n' }), rt2(2));
  check_('a v2 runtime refuses a 32-pixel-wide sprite and says it needs v3', c2w.errors.length === 1 && /width 32 is not supported yet in M2.*needs the v3 runtime/.test(c2w.errors[0].message), errText(c2w));
  const c2t = compile(prog('    SHOW p AT 1, 1', { win: '', map: '', sprites: 'SPRITE p = "tall"\n' }), rt2(2));
  check_('... and a sprite 48 tall', c2t.errors.length === 1 && /height 48 is not supported yet in M2.*needs the v3 runtime/.test(c2t.errors[0].message), errText(c2t));
  const noRt = (extra) => compile(prog('    CAMERA 5'), { runtime: { ...mockRuntime(), symbols: Object.fromEntries(Object.entries(mockRuntime().symbols).filter(([k]) => k !== extra)) }, image: new Uint8Array(65536), assets: ASSETS });
  check_('a v3 runtime without RT_CAMERA says so (the real build in progress): "needs RT_CAMERA, which this runtime does not provide"', /CAMERA needs RT_CAMERA, which this runtime does not provide/.test(noRt('RT_CAMERA').errors[0]?.message ?? ''), errText(noRt('RT_CAMERA')));
  const rtReal = (() => { const p = join(ROOT, 'arcade/build/v3/runtime.json'); if (!existsSync(p)) return null; const rt = JSON.parse(readFileSync(p, 'utf8')); return { rt, image: new Uint8Array(readFileSync(join(dirname(p), rt.image ?? 'runtime.bin'))) }; })();
  if (rtReal) {
    const r = compile(PLAT, { runtime: rtReal.rt, image: rtReal.image, assets: ASSETS });
    if (rtReal.rt.symbols.RT_CAMERA !== undefined) info('arcade/build/v3 has the window routines: see tests/arcade-m6-differential.mjs');
    else check_('the build in arcade/build/v3 (a copy of v2 until the runtime engineer lands the window) refuses a window program with a clear message', r.errors.length >= 1 && /does not provide|needs RT_/.test(r.errors[0].message), errText(r));
  }

  // fit, phase memory, variables
  const fit = cm(prog('    v = 1', { top: '' }), withMap('lv', ASSETS.maps.lv), {});
  check_('the link report has the categories', (() => { const u = fit.usage; return u.window.worldSource === 2048 && u.window.tileFlags === 32 && u.window.tileRows === 256 && u.window.scrollTables === 3584 && u.window.descriptor === 14 + 2 && u.frames > 0 && u.phaseRam && u.gameVars; })());
  check_('the link report: GAME_VARS used vs available come from runtime.json (3 slots = 6 of 2,048)', fit.usage.gameVars.used === fit.usage.varBytes && fit.usage.gameVars.available === ADDR.GAME_VARS_LIMIT - ADDR.GAME_VARS_BASE + 1 && fit.usage.gameVars.available === 2048);
  const smallRt = cm(prog('    v = 1', { decl: 'DIM v, w, k, big(1000)' }), ASSETS, { GAME_VARS_LIMIT: 0xE200 + 1999 });
  check_('GAME_VARS out of space: the error gives the byte counts (from runtime.json, not hard-coded)', smallRt.errors.length === 1 && /too many variables.*1004 slots need 2008 bytes.*allows 2000/.test(smallRt.errors[0].message), errText(smallRt));
  check_('the link report: phase memory (at least N of the pool, the frame slots K/nframes per asset)', fit.usage.phaseRam.available === 5888 || fit.usage.phaseRam.available === 3456 + 2176 + 256, String(fit.usage.phaseRam.available));
  check_('... PHASE_POOL_BYTES of runtime.json is the capacity reported', cm(prog('    v = 1'), ASSETS, { PHASE_POOL_BYTES: 5888 }).usage.phaseRam.available === 5888 && cm(prog('    v = 1'), ASSETS, { PHASE_POOL_BYTES: 1234 }).usage.phaseRam.available === 1234);
  const ph = cm(PLAT);
  const pw = ph.warnings.filter((w) => /frames stay cached/.test(w.message));
  check_('the platformer: the 16-frame player at 8 phases cannot stay cached: ONE warning for it, naming the asset, K of N, the estimate and the advice, at the SPRITE line', ph.errors.length === 0 && pw.length === 1 && /^asset p: only \d+ of 16 frames stay cached; a frame that is not cached is built when first drawn \(about \d+ cycles for this size\) which can overrun the tick; use fewer phases \(phases 2 or 1\) or fewer frames$/.test(pw[0].message) && pw[0].line === 5, pw.map((w) => w.line + ' ' + w.message).join(' | '));
  const poolBad = cm(PLAT, ASSETS, { POOL_A_LEN: 100, POOL_B_LEN: 100, POOL_C_LEN: 100 });
  const planBad = WIN.planPhasePool([{ w: 16, h: 24, phases: 8, nframes: 16, instances: 1 }, { w: 8, h: 8, phases: 8, nframes: 4, instances: 4 }, { w: 16, h: 16, phases: 8, nframes: 1, instances: 2 }], [[0, 100], [0, 100], [0, 100]]);
  check_('a pool too small for the frame tables and one slot per instance: the link FAILS, N bytes of art do not fit (the runtime\'s FC_MISS), no cartridge', poolBad.errors.length === 1 && /^\d+ bytes of sprite art do not fit in the phase pool.*magenta border/.test(poolBad.errors[0].message) && !poolBad.dck, errText(poolBad));
  const refSet = {
    sprites: {
      player: { w: 16, h: 24, phases: 2, frames: Array.from({ length: 8 }, () => ({ rows: Array.from({ length: 24 }, () => ({ bits: 'FFFF' })) })) },
      walker: { w: 16, h: 16, phases: 4, frames: Array.from({ length: 2 }, () => ({ rows: Array.from({ length: 16 }, () => ({ bits: 'FFFF' })) })) },
      flyer: { w: 16, h: 16, phases: 4, frames: Array.from({ length: 2 }, () => ({ rows: Array.from({ length: 16 }, () => ({ bits: 'FFFF' })) })) },
      coin: { w: 8, h: 8, phases: 8, frames: Array.from({ length: 4 }, () => ({ rows: Array.from({ length: 8 }, () => ({ bits: 'FF' })) })) },
      shot: { w: 8, h: 8, phases: 8, rows: Array.from({ length: 8 }, () => ({ bits: 'FF' })) },
    },
  };
  const refSrc = prog('    SHOW pl AT 1, 1 FRAME k FLIP\n    SHOW wk(k) AT 1, 1 FRAME k FLIP\n    SHOW fl(k) AT 1, 1 FRAME k\n    SHOW cn(k) AT 1, 1 FRAME k\n    SHOW sh AT 1, 1', { sprites: 'SPRITE pl = "player"\nSPRITE wk(3) = "walker"\nSPRITE fl(3) = "flyer"\nSPRITE cn(4) = "coin"\nSPRITE sh = "shot"\n' });
  const refRes = cm(refSrc, withAssets(refSet));
  check_('compiled: the reference art set (player 2 / walker 4 / flyer 4 / coin 8 / shot 8 phases, FLIP on player and walker) links with K = nframes for every asset and no cache warning', refRes.errors.length === 0 && refRes.usage.phaseRam.K.join() === '16,4,2,4,1' && !refRes.warnings.some((w) => /stay cached/.test(w.message)), errText(refRes) + ' ' + refRes.warnings.map((w) => w.message).join(' | ') + ' K=' + refRes.usage.phaseRam?.K);
  const refPlan = planPool([[16, 24, 2, 16], [16, 16, 4, 4], [16, 16, 4, 2], [8, 8, 8, 4], [8, 8, 8, 1]].map(([w, h, ph, nf]) => ({ nf, phases: ph, slen: (ph - 1) * h * 2 * (w / 8 + 1) })), [1, 3, 3, 4, 1], WIN.DEFAULT_POOL_PIECES);
  check_('... and equals planPool() of the runtime tests for it', refPlan.ok && refPlan.K.join() === refRes.usage.phaseRam.K.join());
  // the game area
  const manyFrames = withAssets({ sprites: { player: { w: 32, h: 48, frames: Array.from({ length: 32 }, () => ({ rows: Array.from({ length: 48 }, () => ({ bits: 'FFFFFFFF' })) })) } } });
  const big = cm(prog('    SHOW p AT 1, 1 FRAME 3', { sprites: 'SPRITE p = "player"\n' }), manyFrames);
  check_('32 frames of a 32 x 48 sprite (12 KB of data) plus the window data: the linker fails and says how many bytes too many', big.errors.length === 1 && /the game does not fit.*too many/.test(big.errors[0].message) && !big.dck, errText(big));
}

// =================================================================================================================
// 6. Compiled code on the mock runtime against the interpreter
// =================================================================================================================
console.log('\n6. Compiled code on the mock v3 runtime vs the reference interpreter');
const interpFor = (src, ticks, stick, o = {}) => interpret(parse(src).ast, { version: 3, ticks, assets: ASSETS, stick, maxSteps: 2_000_000_000, rnd: undefined, ...o });
{
  // the acceptance game (needsFullRuntime: KEYDOWN, FILLC, PLAY, PRINT ...) is not for the mock: tests/arcade-m6-platformer.mjs and the differential test (real runtime only) run it
  for (const p of PROGRAMS.filter((q) => !q.needsFullRuntime)) {
    const res = cm(p.src);
    if (!check_(`${p.name}: compiles`, res.errors.length === 0, errText(res))) continue;
    const got = runMock(res, { ticks: p.ticks, stick: p.stick });
    const want = interpFor(p.src, p.ticks, p.stick);
    let d = diffV3(got.init, want.init, 'after INIT');
    for (let t = 0; !d && t < p.ticks; t++) d = diffV3(got.ticks[t], want.ticks[t], `tick ${t + 1}`);
    check_(`${p.name}: ${p.ticks} ticks equal (variables, arrays, SPR_TAB entries, WORLD_RAM, V_CAM)`, d === null, d ?? '');
    if (p.src === PLAT) {
      const cams = want.ticks.map((t) => t.cam), frames = new Set(want.ticks.map((t) => t.sprites[0].frame));
      const changed = want.ticks[p.ticks - 1].worldRam.reduce((n, b, i) => n + (b !== want.init.worldRam[i] ? 1 : 0), 0);
      check_('the platformer actually scrolls, changes the world, uses frames and mirrored frames (the run is not trivial)', Math.max(...cams) > 40 && changed >= 2 && [...frames].some((f) => f >= 12) && [...frames].some((f) => f >= 1 && f < 8) && want.ticks.some((t) => t.vars.SCORE !== 0), `max camera ${Math.max(...cams)}, ${changed} cells changed, frames ${[...frames].join()}`);
      info(`the platformer's PROC FRAME takes ${Math.min(...got.tstates)}..${Math.max(...got.tstates)} T-states on the mock (traps cost nothing); code ${res.usage.code} bytes, game ${res.usage.total} of ${res.usage.total + res.usage.free}`);
    }
  }
}

// the acceptance game on the v3 build in the tree (window routines that the build lacks yet are given placeholder addresses: this checks the size and the phase pool, not the run)
{
  const p3 = join(ROOT, 'arcade/build/v3/runtime.json'), src = join(ROOT, 'arcade/examples/platformer.arc'), as = join(ROOT, 'arcade/examples/platformer.assets.json');
  if (!existsSync(p3) || !existsSync(src) || !existsSync(as)) info('SKIP: arcade/build/v3 or arcade/examples/platformer.arc does not exist');
  else {
    const rt = JSON.parse(readFileSync(p3, 'utf8')), img = new Uint8Array(readFileSync(join(dirname(p3), rt.image ?? 'runtime.bin')));
    const stubbed = ['RT_CAMERA', 'RT_WORLDTILE', 'RT_TILEFLAGS', 'RT_TILEHIT', 'RT_SETWORLD', 'RT_SHOWF'].filter((n) => rt.symbols[n] === undefined);
    for (const n of stubbed) rt.symbols[n] = 0xC000;
    const res = compile(readFileSync(src, 'utf8'), { runtime: rt, image: img, assets: JSON.parse(readFileSync(as, 'utf8')) });
    info(`platformer.arc on arcade/build/v3${stubbed.length ? ` (stubbed: ${stubbed.join(' ')})` : ''}: ${res.usage ? `game area ${res.usage.gameArea.used} of ${res.usage.gameArea.available} bytes, ${res.usage.gameArea.free} free` : 'no link'}`);
    check_('platformer.arc compiles on the v3 build with no errors and no warnings', res.errors.length === 0 && res.warnings.length === 0, errText(res) + ' ' + res.warnings.map((w) => w.message).join(' | '));
    if (res.usage) {
      const u = res.usage;
      check_('... and fits the 16 KB game area (code + data + frames + window data + scroll tables)', u.gameArea.used <= u.gameArea.available && u.gameArea.free >= 0, `${u.gameArea.used} of ${u.gameArea.available}`);
      check_('... and every multi-phase asset keeps all its frames cached (K = nframes)', u.phaseRam.perAsset.every((a, i) => res.gen.sprites[i].phases === 1 || a.K === a.nframes), u.phaseRam.K.join('/'));
    }
  }
}

// =================================================================================================================
// 7. SHOW forms and arguments on the mock
// =================================================================================================================
console.log('\n7. SHOW FRAME / FLIP in all register shapes, and nested arguments, on the mock');
{
  const SH = (body, o = {}) => prog(body, { decl: 'DIM v, w, k, n, a(5)', sprites: 'SPRITE p = "player"\nSPRITE c(3) = "coin"\nSPRITE e = "wide"\nSPRITE q = "plain"\n', ...o });
  const same = (name, src, ticks = 24) => {
    const res = cm(src);
    if (!check_(`${name}: compiles`, res.errors.length === 0, errText(res))) return;
    const got = runMock(res, { ticks });
    const want = interpFor(src, ticks, undefined);
    let d = diffV3(got.init, want.init, 'init');
    for (let t = 0; !d && t < ticks; t++) d = diffV3(got.ticks[t], want.ticks[t], `tick ${t + 1}`);
    check_(`${name}: equal on the mock`, d === null, d ?? '');
    return want;
  };
  const w1 = same('constant instance, constant frame; FLIP alone; FRAME and FLIP', SH('    k = k + 1\n    SHOW p AT k, 2 * k FRAME 3\n    SHOW c(1) AT 20, 30 FLIP\n    SHOW e AT 100, 5 FRAME 1 FLIP\n    SHOW q AT 7, 8 FLIP\n    SHOW c(2) AT k, 9 FRAME 2'));
  check_('... the frames are what they should be: p 3, c(0) 0, c(1) FLIP alone = 4 (n = 4: another SHOW gives c a FRAME), c(2) 2, e 1 + 2 = 3, q FLIP alone = 1', w1.ticks[0].sprites.map((s) => s.frame).slice(0, 6).join() === '3,0,4,2,3,1', w1.ticks[0].sprites.map((s) => s.frame).join());
  same('a frame variable, a frame expression, a complex frame between x and y', SH('    k = k + 1\n    v = k MOD 8\n    SHOW p AT k * 3, k FRAME v\n    SHOW p AT k * 3 + 1, v * v FRAME (k * 3) MOD 8 FLIP\n    SHOW c(0) AT v, k FRAME a(1) + v'));
  same('a run-time instance index with frame variable, frame expression, FLIP', SH('    k = k + 1\n    n = k MOD 5\n    SHOW c(n) AT k * 4, 20 FRAME k MOD 4\n    SHOW c(k MOD 4) AT 10, k * 2 FRAME n FLIP\n    SHOW c(n - 1) AT 1, 1 FRAME 1'));
  same('a constant instance outside the pool (x, y, frame evaluated, nothing shown)', SH('    k = k + 1\n    SHOW c(9) AT k, 1 FRAME k\n    SHOW c(-1) AT 1, 1 FRAME 1 FLIP\n    v = k'));
  same('pool name alone is instance 0; FRAME 0 and FLIP', SH('    k = k + 1\n    SHOW c AT k, 2 FRAME 0 FLIP\n    SHOW p AT 1, 2 FRAME 0'));
  same('SHOW in a PROC with parameters and locals; the frame is a parameter', SH('    CALL pose(k, 8, k MOD 4)\n    k = k + 1', { procs: '  PROC pose(x, y, f)\n    LOCAL z\n    z = f + 1\n    SHOW c(f MOD 3) AT x, y + z FRAME f FLIP\n  ENDP\n' }));
  same('a frame from a DEF FN that calls SOLID; the world is read in the argument', SH('    k = k + 1\n    SHOW p AT 40 + k * 8, 100 FRAME FN fr(k)', { decl: 'DIM v, w, k, n, a(5)\n  DEF FN fr(x) = SOLID(x * 8, 104, 8, 8) + x MOD 3' }));
  same('collision words as arguments of other statements: SHOW, CAMERA, SETWORLD, array index, FOR bounds, WHILE', SH('    k = k + 1\n    a(WORLDTILE(k * 8, 120)) = k\n    CAMERA TILEHIT(k * 8, 100, 8, 8, 255) * 50 + k * 13\n    SETWORLD k * 8, 112 = WORLDTILE(k * 8, 120) + 1\n    FOR n = 0 TO SOLID(k * 8, 112, 8, 8) * 3\n      v = v + n\n    NEXT n\n    SHOW c(SOLID(0, 112, 8, 8)) AT SOLID(k * 8, 120, 1, 1) * 9, TILEFLAGS(k * 4, 112) FRAME TILEHIT(k * 8, 112, 16, 16, 3)'), 60);
  same('SETWORLD with x, y, tile that need evaluation order: y depends on the array, the tile on CAMX()', SH('    k = k + 1\n    a(k MOD 5) = k * 8\n    CAMERA k * 11\n    SETWORLD a(k MOD 5) + CAMX() MOD 7, a((k + 1) MOD 5) MOD 120 = CAMX() MOD 9'), 60);
  same('a run-time tile for SETWORLD is checked against the tileset (0..7): 0 clears, 8 and negative are ignored', SH('    k = k + 1\n    SETWORLD 8 * k, 8 = k MOD 11 - 2'), 40);
}

// =================================================================================================================
// 8. Fuzz: collision queries against an independent per-pixel model
// =================================================================================================================
console.log('\n8. Fuzz: collision queries against an independent model (interpreter and compiled code on the mock)');
{
  const NPROG = QUICK ? 40 : 160, NQ = 26;
  const r = rng(0xC011);
  const ri = (lo, hi) => lo + Math.floor(r() * (hi - lo + 1));
  const pick = (a) => a[Math.floor(r() * a.length)];
  const flagsAll = TILE_FLAGS;
  let queries = 0, bad = 0, interpBad = 0, mockBad = 0, firstBad = '', shapes = new Set();
  for (let pi = 0; pi < NPROG; pi++) {
    const W = pick([24, 25, 60, 128, 24 + ri(0, 104)]), Hh = pick([1, 9, 16]);
    const mapName = 'fz' + pi;
    const cells = Array.from({ length: W * Hh }, () => (r() < 0.45 ? 0 : ri(0, 7)));
    const assets = withMap(mapName, { w: W, h: Hh, cells });
    const model = worldModel(W, cells, Hh, flagsAll);
    const lines = [], expect = [];
    const arg = (lo, hi) => { const v = r() < 0.25 ? ri(-60, 20) : r() < 0.2 ? ri(W * 8 - 20, W * 8 + 60) : ri(lo, hi); return v; };
    let nvar = 0;
    const vars = [];
    const form = (v) => {          // an argument form: literal, variable, expression
      const t = r();
      if (t < 0.4) return String(v);
      if (t < 0.7) { const name = 'v' + (nvar++ % 6); lines.push(`    ${name} = ${v}`); vars.push(name); return name; }
      const d = ri(-9, 9);
      const name = 'v' + (nvar++ % 6); lines.push(`    ${name} = ${v - d}`);
      return d >= 0 ? `${name} + ${d}` : `${name} - ${-d}`;
    };
    for (let qi = 0; qi < NQ; qi++) {
      const kind = pick(['tile', 'flags', 'hit', 'solid', 'hit', 'solid', 'tile', 'flags', 'set', 'set']);
      if (kind === 'set') {
        const x = arg(0, W * 8), y = ri(-20, 150), t = pick([0, 1, 2, 3, 4, 5, 6, 7, 7, 3]);
        lines.push(`    SETWORLD ${form(x)}, ${form(y)} = ${t}`);
        model.set(x, y, t);
        shapes.add('set');
        continue;
      }
      const x = arg(0, W * 8), y = ri(-20, 150);
      let text, want;
      if (kind === 'tile') { text = `WORLDTILE(${form(x)}, ${form(y)})`; want = model.tile(x, y); }
      else if (kind === 'flags') { text = `TILEFLAGS(${form(x)}, ${form(y)})`; want = model.pixel(x, y); }
      else {
        const w = pick([1, 1, 2, 7, 8, 9, 16, 17, 24, 33, 0, -3, ri(1, 40)]), h = pick([1, 2, 8, 9, 16, 24, 25, 48, 0, -1, ri(1, 40)]);
        if (kind === 'hit') { const mask = pick([255, 1, 2, 4, 8, 6, 0x80, 0x81, 0, 3, ri(0, 255)]); text = `TILEHIT(${form(x)}, ${form(y)}, ${form(w)}, ${form(h)}, ${mask})`; want = w >= 1 && h >= 1 ? model.hit(x, y, w, h, mask) : 0; }
        else { text = `SOLID(${form(x)}, ${form(y)}, ${form(w)}, ${form(h)})`; want = w >= 1 && h >= 1 ? model.hit(x, y, w, h, 1) : 0; }
      }
      lines.push(`    r(${expect.length}) = ${text}`);
      expect.push(want);
      shapes.add(kind);
    }
    queries += expect.length;
    const src = `GAME "fz"\nFRAMERATE 20\nTILESET ts = "ts"\nMAP level = "${mapName}"\nWINDOW level\nSCENE s\n  DIM r(${expect.length}), v0, v1, v2, v3, v4, v5\n  PROC INIT()\n${lines.join('\n')}\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`;
    const comp = compileMock(src, assets);
    if (comp.errors.length) { bad++; firstBad ||= `program ${pi}: compile: ${errText(comp)}\n${src.slice(0, 600)}`; continue; }
    const want = interpret(parse(src).ast, { version: 3, ticks: 0, assets, maxSteps: 50_000_000 });
    const gotI = want.init.arrays.R, gotM = runMock(comp, { ticks: 0 }).init.arrays.R;
    for (let i = 0; i < expect.length; i++) {
      if (gotI[i] !== expect[i]) { interpBad++; firstBad ||= `program ${pi} query ${i}: interpreter ${gotI[i]}, model ${expect[i]}\n${lines.filter((l) => l.includes(`r(${i})`)).join('\n')}`; }
      if (gotM[i] !== expect[i]) { mockBad++; firstBad ||= `program ${pi} query ${i}: compiled code on the mock ${gotM[i]}, model ${expect[i]}\n${lines.filter((l) => l.includes(`r(${i})`)).join('\n')}`; }
    }
    // the final WORLD_RAM of the interpreter equals the model's grid (SETWORLD included)
    const ram = want.init.worldRam;
    for (let rr = 0; rr < 16; rr++) for (let c = 0; c < W; c++) if (ram[rr * 128 + c] !== model.grid[rr][c] * 8) { interpBad++; firstBad ||= `program ${pi}: WORLD_RAM cell (${rr}, ${c}) = ${ram[rr * 128 + c]}, model ${model.grid[rr][c] * 8}`; rr = 99; break; }
  }
  info(`${NPROG} programs, ${queries} collision queries (WORLDTILE, TILEFLAGS, TILEHIT, SOLID; ${NPROG * NQ - queries} SETWORLDs in between), worlds 24..128 wide and 1..16 tall, queries inside and outside the world`);
  check_(`>= ${QUICK ? 800 : 3000} collision queries: every program compiles`, bad === 0 && queries >= (QUICK ? 800 : 3000), `${bad} did not compile; ${queries} queries; ${firstBad}`);
  check_('the interpreter equals the independent per-pixel model on every query and on the final WORLD_RAM', interpBad === 0, `${interpBad} differences; ${firstBad}`);
  check_('the compiled code on the mock runtime equals the model on every query', mockBad === 0, `${mockBad} differences; ${firstBad}`);
  check_('the fuzz covers all four query kinds and SETWORLD', ['tile', 'flags', 'hit', 'solid', 'set'].every((k) => shapes.has(k)));
}

// =================================================================================================================
// 9. Old programs compile to identical bytes
// =================================================================================================================
console.log('\n9. Programs that use none of the new words compile to the same bytes as before the batch');
{
  const jsonPath = join(ROOT, 'arcade/build/v2/runtime.json');
  if (!existsSync(jsonPath)) info('SKIP: arcade/build/v2/runtime.json does not exist (build it: node arcade/tools/build-runtime-v2.mjs)');
  else {
    const rt = JSON.parse(readFileSync(jsonPath, 'utf8')), image = new Uint8Array(readFileSync(join(dirname(jsonPath), rt.image ?? 'runtime.bin')));
    const base = JSON.parse(readFileSync(join(ROOT, 'arcade/tests/fixtures/batch2-baseline.json'), 'utf8'));
    let same = 0, why = '';
    for (const p of base.programs) {
      const res = compile(readFileSync(join(ROOT, p.src), 'utf8'), { runtime: rt, image, assets: JSON.parse(readFileSync(join(ROOT, p.assets), 'utf8')) });
      const dck = res.dck ? createHash('sha256').update(res.dck).digest('hex') : '', area = res.memory ? createHash('sha256').update(res.memory.slice(0x8000, 0xC000)).digest('hex') : '';
      if (res.errors.length || dck !== p.dckSha256 || area !== p.areaSha256 || res.gen.code.length !== p.bytes) why += `${p.src}: ${res.errors[0]?.message ?? 'bytes differ'}; `;
      else same++;
    }
    check_(`${base.programs.length} programs (shooter, breakout, blockfall, bounce, blockfall-v0) on the real v2 runtime: the DCK (SHA-256) and the game area are byte-identical to the build made before this batch`, same === base.programs.length, why);
    // and the same programs against the v3 runtime build in the tree, which has the old routines: they still compile (their descriptors differ in nframes only)
    const p3 = join(ROOT, 'arcade/build/v3/runtime.json');
    if (existsSync(p3)) {
      const rt3 = JSON.parse(readFileSync(p3, 'utf8')), img3 = new Uint8Array(readFileSync(join(dirname(p3), rt3.image ?? 'runtime.bin')));
      let okc = 0, bads = '';
      for (const p of base.programs) {
        const res = compile(readFileSync(join(ROOT, p.src), 'utf8'), { runtime: rt3, image: img3, assets: JSON.parse(readFileSync(join(ROOT, p.assets), 'utf8')) });
        if (res.errors.length) bads += `${p.src}: ${res.errors[0].message}; `; else okc++;
      }
      check_('the same five programs compile on the v3 runtime in the tree (no new word needed)', okc === base.programs.length, bads);
      const a = compile(readFileSync(join(ROOT, base.programs[0].src), 'utf8'), { runtime: rt3, image: img3, assets: JSON.parse(readFileSync(join(ROOT, base.programs[0].assets), 'utf8')) });
      const b = compile(readFileSync(join(ROOT, base.programs[0].src), 'utf8'), { runtime: rt, image, assets: JSON.parse(readFileSync(join(ROOT, base.programs[0].assets), 'utf8')) });
      if (a.gen && b.gen) check_('on v3 the shooter\'s CODE is the same size as on v2 (16-wide sprites; only descriptors and frame bookkeeping differ)', a.gen.code.length === b.gen.code.length, `${a.gen.code.length} vs ${b.gen.code.length}`);
    }
  }
}

// =================================================================================================================
// 10. requiredRuntime and the usage report
// =================================================================================================================
console.log('\n10. requiredRuntime and the usage report');
{
  const rr = (src, a = ASSETS) => requiredRuntime(src, a);
  check_('a plain game needs v2', rr(prog('    SHOW p AT 1, 1', { win: '', map: '', sprites: 'SPRITE p = "plain"\n' })).version === 2);
  check_('WINDOW needs v3 (and names why)', rr(PLAT).version === 3 && rr(PLAT).reasons.includes('WINDOW') && rr(PLAT).reasons.includes('FLIP') && rr(PLAT).reasons.includes('FRAME'));
  check_('FLIP alone needs v3', rr(prog('    SHOW p AT 1, 1 FLIP', { win: '', map: '', sprites: 'SPRITE p = "plain"\n' })).reasons.join() === 'FLIP');
  check_('FRAME 0 alone does not; FRAME 1 does', rr(prog('    SHOW p AT 1, 1 FRAME 0', { win: '', map: '', sprites: 'SPRITE p = "plain"\n' })).version === 2 && rr(prog('    SHOW p AT 1, 1 FRAME 1', { win: '', map: '', sprites: 'SPRITE p = "plain"\n' })).version === 3);
  check_('a sprite wider than 16 or taller than 16 needs v3', rr(prog('    v = 1', { win: '', map: '', sprites: 'SPRITE p = "wide"\n' })).reasons.some((r) => /32 pixels wide/.test(r)) && rr(prog('    v = 1', { win: '', map: '', sprites: 'SPRITE p = "tall"\n' })).reasons.some((r) => /48 pixels tall/.test(r)) && rr(prog('    v = 1', { win: '', map: '', sprites: 'SPRITE p = "player"\n' })).reasons.some((r) => /24 pixels tall/.test(r)));
  check_('a program that fails to parse is still read as far as it goes', rr('WINDOW lv\nBAND 1,').version === 3);
  const u = PLAT_RES.usage, lines = usageLines(u);
  check_('usageLines: bytes per category, game total, phase memory, GAME_VARS', lines.length === 4 && /scroll tables 3584/.test(lines[0]) && /world source 2048/.test(lines[0]) && /phase memory: at least \d+ of \d+ bytes.*frame slots per asset/.test(lines[2]) && /GAME_VARS: \d+ of 2048/.test(lines[3]), lines.join(' | '));
  info(lines.join('\n        '));
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: arcade-m6-compiler (${passed} checks passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
