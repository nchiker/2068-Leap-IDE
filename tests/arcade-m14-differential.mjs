#!/usr/bin/env node
"use strict";
// arcade-m14-differential.mjs -- language batch 7, Part A: `SCENE name NOWINDOW` / `SCENE name NOVIEW` (docs/ARCADE_LANGUAGE_BATCH7.md sections 1 and 6, "Differential").
//
//   node tests/arcade-m14-differential.mjs                 (ARCADE_QUICK=1: fewer ticks)
//
// Section 1 is the reference interpreter alone (hand-computed expectations) and always runs.
// The rest runs the compiled games on a stock TS2068 in TSRun and compares them with the interpreter tick by tick, state and picture:
//   2  a harness check that needs only the runtimes of this tree: the cycle programs with the clauses removed (window scenes only) equal the interpreter
//   3  the scenarios of the contract on v3 and v4: switching both ways many times (title -> demo -> play -> title ...), sprites shown in a NOWINDOW / NOVIEW scene and then in a window / view scene,
//      the world / view words used in the mode-less scene and seen when the window / view comes back, WORLD in such a scene, the first scene with the clause, ENTER of the same scene, every scene with the clause
//      (state against the interpreter: variables, SPR_TAB, WORLD_RAM / camera or the wall array / pose, the scene index, V_WIN / V_RAY; the cell map and attributes in every tick of a scene without the window / view)
//   4  the picture: a NOWINDOW / NOVIEW scene's display files equal those of the same scene in a game without the window / view, and the window / view back from a title equals a game that never left it
//   5  negative controls: the comparisons see a wrong mode
//
// WHAT THIS NEEDS FROM THE RUNTIME. The routines of Part B: RT_WINMODE in arcade/build/v3/runtime.json (v3) and RT_VIEWMODE in arcade/build/v4/runtime.json (v4). The runtimes of a tree that
// does not have them yet make sections 2 to 5 print a SKIP line naming them (section 2 still runs); nothing crashes. Until the real routines have run this file, the machine sections are UNVERIFIED.
//
// How a tick is sampled: when PROC FRAME is entered, so sample k is the state after tick k - 1 (sample 0: after INIT), as tests/arcade-m13-differential.mjs does.
import { bootedMachine } from '../arcade/tests/fast-boot.mjs';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { ROOT, M_, s16 } from './arcade-m5-harness.mjs';
import { diffV3 } from './arcade-m6-common.mjs';
import { diffV4 } from './arcade-m8-common.mjs';
import { ASSETS11 } from './arcade-m11-common.mjs';

const QUICK = !!process.env.ARCADE_QUICK;
let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const skip_ = (name, why) => { console.log(`  SKIP  ${name}  (${why})`); skipped++; };
const info = (s) => console.log('  INFO  ' + s);
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
const asHex = (v) => '$' + (v >>> 0).toString(16);

// ── runtimes ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function loadRuntime(v) {
  const json = join(resolve(ROOT, `arcade/build/v${v}`), 'runtime.json');
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))), v };
}
const RT = { 3: loadRuntime(3), 4: loadRuntime(4) };
const lacking = (R, names) => (R ? names.filter((n) => R.rt.symbols[n] === undefined && R.rt.constants?.[n] === undefined) : ['the runtime (arcade/build/v?/runtime.json)']);
const MISSING = { 3: lacking(RT[3], ['RT_WINMODE']), 4: lacking(RT[4], ['RT_VIEWMODE']) };

// ── the programs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const HEAD = 'GAME "t"\nFRAMERATE 12\nTILESET ts = "ts"\n';
const SC = (name, clause, decl, init, frame) => `SCENE ${name}${clause ? ' ' + clause : ''}\n  DIM t${decl ? ', ' + decl : ''}\n  PROC INIT()\n${init}  ENDP\n  PROC FRAME()\n${frame}  ENDP\nENDSCENE\n`;
const G3 = (scenes, { maps = '', globals = 'DIM lap, a, b, c, d\n' } = {}) => `${HEAD}SPRITE ship = "orb"\nMAP level = "lv"\nMAP pic = "big0"\n${maps}WINDOW level\n${globals}${scenes}`;
const G4 = (scenes, { maps = '', globals = 'DIM lap, a, b, c, d\n' } = {}) => `${HEAD}SPRITE ship = "orb"\nMAP level = "maze"\nMAP pic = "big0"\n${maps}VIEW3D level\n${globals}${scenes}`;
const G2 = (scenes, globals = 'DIM lap, a, b, c, d\n') => `${HEAD}SPRITE ship = "orb"\nMAP pic = "big0"\n${globals}${scenes}`;      // a game without the window / view: the twin of a NOWINDOW / NOVIEW scene
const stripClause = (src) => src.replace(/^(SCENE \w+) NO(WINDOW|VIEW)$/gm, '$1');
const goAfter = (n, to, extra = '') => `    IF t >= ${n} THEN\n${extra}      ENTER ${to}\n    ENDIF\n`;

// v3 (WINDOW over "lv", 48 cells wide) --------------------------------------------------------------------------------------------------
/** the title -> demo -> play -> title ring: a text and a sprite at screen positions in the title, the window scenes move the camera and show sprites at world positions */
const CYCLE3 = (c) => G3(
  SC('title', c, '', '    PRINT AT 3, 4; "TITLE"\n    SHOW ship AT 300, 300\n', '    t = t + 1\n    SHOW ship AT 8 + t * 6, 40 + t * 4\n' + goAfter(3, 'demo'))
  + SC('demo', '', '', '    SHOW ship AT 300, 100\n', '    t = t + 1\n    CAMERA 20 + t * 5\n    SHOW ship AT 60 + t * 9, 80\n' + goAfter(3, 'play'))
  + SC('play', '', 'g', '    CAMERA 70\n', '    t = t + 1\n    g = WORLDTILE(8 * 12, 8 * 13) + CAMX()\n    SHOW ship AT 100 + t, 90\n' + goAfter(3, 'title', '      lap = lap + 1\n')));
/** the world words used in the title (CAMERA, SETWORLD, WORLDTILE, TILEFLAGS, TILEHIT, CAMX), seen when the window is back; the edits persist round the ring */
const WORDS3 = (c) => G3(
  SC('title', c, '', '    CAMERA 50\n    SETWORLD 8 * 5, 8 * 13 = 2\n', '    t = t + 1\n    a = WORLDTILE(8 * 5, 8 * 13)\n    b = CAMX()\n    c = TILEFLAGS(8 * 3, 8 * 14)\n    d = TILEHIT(8 * 5, 8 * 13, 8, 8, 255)\n    SETWORLD 8 * (6 + t), 8 * 12 = 3\n    CAMERA 50 + 30 * t\n' + goAfter(3, 'play'))
  + SC('play', '', '', '    SHOW ship AT 90, 60\n', '    t = t + 1\n    a = WORLDTILE(8 * 5, 8 * 13)\n    b = CAMX()\n    d = TILEHIT(8 * 5, 8 * 13, 8, 8, 255)\n    CAMERA 120 - t\n' + goAfter(3, 'title', '      lap = lap + 1\n')));
/** WORLD in the title (and WORLD n OF), the window shows the world the title loaded */
const WORLD3 = (c) => G3(
  SC('title', c, '', '    WORLD second\n', '    t = t + 1\n    WORLD t MOD 2 OF second, level\n    a = WORLDTILE(8 * 12, 8 * 13)\n' + goAfter(3, 'play'))
  + SC('play', '', '', '    SHOW ship AT 90, 60\n', '    t = t + 1\n    a = WORLDTILE(8 * 12, 8 * 13)\n    CAMERA 10 * t\n' + goAfter(3, 'title', '      WORLD level\n      lap = lap + 1\n')),
  { maps: 'MAP second = "w60"\n' });
/** the first scene without the clause; the clause scene in the middle */
const FIRST3 = (c) => G3(
  SC('play', '', '', '    CAMERA 40\n    SHOW ship AT 90, 60\n', '    t = t + 1\n    CAMERA 40 + t * 7\n    SHOW ship AT 90 + t, 60\n' + goAfter(3, 'menu'))
  + SC('menu', c, '', '    PRINT AT 5, 5; "MENU"\n    SHOW ship AT 10, 10\n', '    t = t + 1\n    SHOW ship AT 10 + t * 20, 10 + t * 10\n    a = a + 1\n' + goAfter(2, 'play', '      lap = lap + 1\n')));
/** ENTER of the same scene: a restart in the title, in the window scene, and a ring */
const SELF3 = (c) => G3(
  SC('title', c, '', '    PRINT AT 3, 4; "AGAIN"\n    SHOW ship AT 30, 30\n    a = a + 1\n', '    t = t + 1\n    SHOW ship AT 30 + t * 8, 30\n    IF a >= 3 THEN\n      ENTER play\n    ENDIF\n' + goAfter(2, 'title'))
  + SC('play', '', '', '    CAMERA 33\n    SHOW ship AT 90, 60\n    b = b + 1\n', '    t = t + 1\n    CAMERA 33 + t * 11\n    IF b >= 2 THEN\n      a = 0 : b = 0\n      ENTER title\n    ENDIF\n' + goAfter(2, 'play')));
/** every scene has the clause: the window is never drawn, the world words still work */
const ALL3 = (c) => G3(
  SC('one', c, '', '    SHOW ship AT 20, 20\n    CAMERA 60\n', '    t = t + 1\n    SHOW ship AT 20 + t * 9, 20\n    a = CAMX()\n' + goAfter(3, 'two'))
  + SC('two', c, '', '    SHOW ship AT 200, 100\n    SETWORLD 8 * 5, 8 * 13 = 2\n', '    t = t + 1\n    SHOW ship AT 200 - t * 9, 100\n    b = WORLDTILE(8 * 5, 8 * 13)\n' + goAfter(3, 'one', '      lap = lap + 1\n')));

// v4 (VIEW3D over "maze", 12 x 12) ---------------------------------------------------------------------------------------------------------
const CYCLE4 = (c) => G4(
  SC('title', c, '', '    PRINT AT 3, 4; "TITLE"\n    SHOW ship AT 300, 300\n', '    t = t + 1\n    SHOW ship AT 8 + t * 6, 40 + t * 4\n' + goAfter(3, 'demo'))
  + SC('demo', '', '', '    VIEW 3000, 2900, 70\n    SHOW ship AT 3300, 2900\n', '    t = t + 1\n    VIEW 3000, 2900, 70 + t * 9\n    SHOW ship AT 3300 + t * 40, 2900\n' + goAfter(3, 'play'))
  + SC('play', '', 'g', '    VIEW 2900, 2800, 20\n', '    t = t + 1\n    g = WALL(300, 300) + WALL(2 * 256 + 10, 3 * 256)\n    VIEW 2900 + t * 10, 2800, 20 + t * 5\n' + goAfter(3, 'title', '      lap = lap + 1\n')));
const WORDS4 = (c) => G4(
  SC('title', c, '', '    VIEW 3000, 2900, 70\n    SETWALL 2 * 256, 2 * 256 = 3\n', '    t = t + 1\n    a = WALL(300, 300)\n    b = WALL(2 * 256 + 10, 3 * 256)\n    c = WALL(1900, 1400)\n    SETWALL 5, 4 + t = 2\n    VIEW 3000 + t * 50, 2900, 70 + t * 16\n' + goAfter(3, 'play'))
  + SC('play', '', '', '    SHOW ship AT 3300, 2900\n', '    t = t + 1\n    a = WALL(300, 300)\n    d = WALL(7 * 256, 5 * 256)\n    VIEW 2800, 2700, 128 - t\n' + goAfter(3, 'title', '      lap = lap + 1\n')));
const WORLD4 = (c) => G4(
  SC('title', c, '', '    WORLD second\n', '    t = t + 1\n    WORLD t MOD 2 OF second, level\n    a = WALL(300, 300)\n' + goAfter(3, 'play'))
  + SC('play', '', '', '    VIEW 600, 700, 9\n    SHOW ship AT 3300, 2900\n', '    t = t + 1\n    a = WALL(300, 300)\n    VIEW 600 + t * 20, 700, 9 + t * 8\n' + goAfter(3, 'title', '      WORLD level\n      lap = lap + 1\n')),
  { maps: 'MAP second = "p8"\n' });
const FIRST4 = (c) => G4(
  SC('play', '', '', '    VIEW 3000, 2900, 70\n    SHOW ship AT 3300, 2900\n', '    t = t + 1\n    VIEW 3000, 2900, 70 + t * 7\n' + goAfter(3, 'menu'))
  + SC('menu', c, '', '    PRINT AT 5, 5; "MENU"\n    SHOW ship AT 10, 10\n', '    t = t + 1\n    SHOW ship AT 10 + t * 20, 10 + t * 10\n    a = a + 1\n' + goAfter(2, 'play', '      lap = lap + 1\n')));
const SELF4 = (c) => G4(
  SC('title', c, '', '    PRINT AT 3, 4; "AGAIN"\n    SHOW ship AT 30, 30\n    a = a + 1\n', '    t = t + 1\n    SHOW ship AT 30 + t * 8, 30\n    IF a >= 3 THEN\n      ENTER play\n    ENDIF\n' + goAfter(2, 'title'))
  + SC('play', '', '', '    VIEW 3000, 2900, 70\n    b = b + 1\n', '    t = t + 1\n    VIEW 3000, 2900, 70 + t * 11\n    IF b >= 2 THEN\n      a = 0 : b = 0\n      ENTER title\n    ENDIF\n' + goAfter(2, 'play')));
const ALL4 = (c) => G4(
  SC('one', c, '', '    SHOW ship AT 20, 20\n    VIEW 3000, 2900, 30\n', '    t = t + 1\n    SHOW ship AT 20 + t * 9, 20\n    a = WALL(300, 300)\n' + goAfter(3, 'two'))
  + SC('two', c, '', '    SHOW ship AT 200, 100\n    SETWALL 5, 4 = 2\n', '    t = t + 1\n    SHOW ship AT 200 - t * 9, 100\n    b = WALL(5 * 256, 4 * 256)\n' + goAfter(3, 'one', '      lap = lap + 1\n')));

const SCENARIOS = {
  3: [['title -> demo -> play -> title ring (sprites at screen positions, then at world positions)', CYCLE3, 40], ['world words used in the NOWINDOW title and seen when the window is back', WORDS3, 28],
    ['WORLD / WORLD n OF in the NOWINDOW title', WORLD3, 28], ['the first scene without the clause, then a NOWINDOW menu', FIRST3, 24], ['ENTER of the same scene (title and play)', SELF3, 30], ['every scene NOWINDOW', ALL3, 24]],
  4: [['title -> demo -> play -> title ring (sprites at screen positions, then in the view)', CYCLE4, 40], ['view words used in the NOVIEW title and seen when the view is back', WORDS4, 28],
    ['WORLD / WORLD n OF in the NOVIEW title', WORLD4, 28], ['the first scene without the clause, then a NOVIEW menu', FIRST4, 24], ['ENTER of the same scene (title and play)', SELF4, 30], ['every scene NOVIEW', ALL4, 24]],
};
const clauseOf = (v) => (v === 3 ? 'NOWINDOW' : 'NOVIEW');
const interpOpts = (R, v, ticks, assets) => ({ version: v, ticks, assets, maxSteps: 2_000_000_000, border0: R?.rt.constants?.BORDER_COLOUR ?? 1 });

// =================================================================================================================
// 1. The reference interpreter alone
// =================================================================================================================
console.log('1. The reference interpreter: the mode per scene');
{
  const run = (src, v, ticks = 20) => interpret(parse(src).ast, interpOpts(null, v, ticks, ASSETS11));
  const recs = (r) => [r.init, ...r.ticks];
  const showOf = (r) => recs(r).map((x) => `${x.scene}:${x.show}`);
  // 3 ticks per scene: tick 3 of each scene ends with the ENTER, so the record of that tick is of the next scene
  const r3 = run(CYCLE3('NOWINDOW'), 3, 20);
  check_('v3 ring: every record says what the scene shows (title: screen; demo, play: window); the record of the tick that executed ENTER is the new scene\'s', showOf(r3).slice(0, 11).join(' ') === '0:screen 0:screen 0:screen 1:window 1:window 1:window 2:window 2:window 2:window 0:screen 0:screen', showOf(r3).slice(0, 11).join(' '));
  check_('a program without the clause has no `show` key in any record (the old records are unchanged)', recs(run(CYCLE3(''), 3, 12)).every((x) => !('show' in x)));
  check_('the title scene\'s SHOW is clamped to the screen by the 2D rule (300, 300 of a 16 x 16 asset -> 240, 176), the demo scene\'s is not (300, 100 stays: world pixels of the window)', recs(r3)[0].sprites[0].x === 240 && recs(r3)[0].sprites[0].y === 176 && recs(r3)[3].sprites[0].x === 300 && recs(r3)[3].sprites[0].y === 100, JSON.stringify([recs(r3)[0].sprites[0], recs(r3)[3].sprites[0]]));
  check_('every ENTER hides the sprites first: the demo\'s first record shows the sprite visible only after its own SHOW, and the title after the lap (record 9) starts at 0, 0 with the SHOW of its INIT clamped', recs(r3)[9].sprites[0].x === 240 && recs(r3)[9].sprites[0].y === 176 && recs(r3)[9].sprites[0].visible === 1);
  check_('the title\'s text is on the cell screen (cells 3 * 32 + 4 = "T"), and gone after the switch to the demo (the reset clears it)', recs(r3)[0].cells[3 * 32 + 4] === 'T'.charCodeAt(0) && recs(r3)[3].cells[3 * 32 + 4] !== 'T'.charCodeAt(0));
  // world words in the title persist and are seen when the window is back
  const w3 = run(WORDS3('NOWINDOW'), 3, 12);
  check_('v3 world words in the NOWINDOW title act on the stored world: CAMERA 50 at INIT, the SETWORLD at (5, 13) is in WORLD_RAM, TILEHIT sees it', recs(w3)[0].cam === 50 && recs(w3)[0].worldRam[13 * 128 + 5] === 2 * 8 && recs(w3)[1].vars.D !== undefined, `cam ${recs(w3)[0].cam}`);
  check_('... and when the window scene starts (record 3) the camera and the edited world are still there (the title\'s last CAMERA 50 + 30 * 3, the SETWORLD cells)', recs(w3)[3].cam === 140 && recs(w3)[3].worldRam[13 * 128 + 5] === 16 && recs(w3)[3].worldRam[12 * 128 + 7] === 3 * 8, `cam ${recs(w3)[3].cam}`);
  const wl3 = run(WORLD3('NOWINDOW'), 3, 12);
  check_('v3 WORLD in the title loads the 60-cell world (WORLD_RAM row 15 column 50 is a brick, tile 1 x 8) at INIT and the camera is 0; the next tick\'s WORLD 1 OF second, level loads the 48-cell one back (column 50 empty)', recs(wl3)[0].worldRam[15 * 128 + 50] === 8 && recs(wl3)[0].cam === 0 && recs(wl3)[1].worldRam[15 * 128 + 50] === 0, `${recs(wl3)[0].worldRam[15 * 128 + 50]} / ${recs(wl3)[1].worldRam[15 * 128 + 50]}`);
  const f3 = run(FIRST3('NOWINDOW'), 3, 12);
  check_('the first scene without the clause: the init record is "window", the menu is "screen"', recs(f3)[0].show === 'window' && recs(f3).some((x) => x.scene === 1 && x.show === 'screen'), showOf(f3).join(' '));
  const s3 = run(SELF3('NOWINDOW'), 3, 16);
  check_('ENTER of the same scene keeps its mode (title restarts stay "screen", play restarts stay "window")', recs(s3).filter((x) => x.scene === 0).every((x) => x.show === 'screen') && recs(s3).filter((x) => x.scene === 1).every((x) => x.show === 'window'), showOf(s3).join(' '));
  const a3 = run(ALL3('NOWINDOW'), 3, 12);
  check_('every scene with the clause: always "screen", and CAMERA / CAMX / SETWORLD still act on the stored world (a = CAMX() = 60)', recs(a3).every((x) => x.show === 'screen') && recs(a3)[1].vars.A === 60, `a = ${recs(a3)[1].vars.A}`);
  // HIT: the view's radius rule against the boxes
  const hitSrc = (c) => G4(SC('s', c, 'h', '    SHOW ship AT 100, 100\n    SHOW ship2 AT 200, 100\n', '    t = t + 1\n    h = HIT(ship, ship2)\n')).replace('SPRITE ship = "orb"', 'SPRITE ship = "orb"\nSPRITE ship2 = "orb"');
  const hn = run(hitSrc('NOVIEW'), 4, 2), hv = run(hitSrc(''), 4, 2);
  check_('v4 HIT: two 16 x 16 sprites 100 pixels apart do not hit in a NOVIEW scene (boxes), and hit in a view scene (the radius 4 * h each)', hn.ticks[0].vars.H === 0 && hv.ticks[0].vars.H === 1, `${hn.ticks[0].vars.H} / ${hv.ticks[0].vars.H}`);
  const c4 = run(CYCLE4('NOVIEW'), 4, 20);
  check_('v4 ring: the title is "screen" and clamps (240, 176), the demo is "view" and keeps the 8.8 position (3300, 2900)', c4.init.show === 'screen' && c4.init.sprites[0].x === 240 && c4.init.sprites[0].y === 176 && recs(c4)[3].show === 'view' && recs(c4)[3].sprites[0].x === 3300, JSON.stringify([c4.init.show, c4.init.sprites[0], recs(c4)[3].show, recs(c4)[3].sprites[0]]));
  const w4 = run(WORDS4('NOVIEW'), 4, 12);
  check_('v4 view words in the NOVIEW title act on the stored plan and pose: SETWALL (2, 2) = 3 is in the array, VIEW moves the pose, both seen when the view is back', recs(w4)[0].wallRam[2 * 32 + 2] === 3 && recs(w4)[0].view.a === 70 && recs(w4)[3].wallRam[2 * 32 + 2] === 3 && recs(w4)[3].wallRam[5 * 32 + 5] !== undefined && recs(w4)[3].view.a === 70 + 3 * 16, JSON.stringify(recs(w4)[3].view));
  const f4 = run(FIRST4('NOVIEW'), 4, 12);
  check_('v4: the first scene without the clause shows the view, the menu the screen', recs(f4)[0].show === 'view' && recs(f4).some((x) => x.scene === 1 && x.show === 'screen'), showOf(f4).join(' '));
  check_('the interpreter is deterministic and a program with the clause runs the same state as with it removed when nothing depends on the mode (title with no SHOW, no HIT)', (() => {
    const src = (c) => G3(SC('title', c, '', '    PRINT AT 3, 4; "T"\n', '    t = t + 1\n    a = a + 2\n' + goAfter(2, 'play')) + SC('play', '', '', '    CAMERA 40\n', '    t = t + 1\n    b = b + 1\n    CAMERA 40 + t\n'));
    const x = run(src('NOWINDOW'), 3, 8), y = run(src(''), 3, 8);
    return recs(x).every((r, i) => JSON.stringify(r.vars) === JSON.stringify(recs(y)[i].vars) && JSON.stringify(r.sprites) === JSON.stringify(recs(y)[i].sprites) && r.cam === recs(y)[i].cam);
  })());
}

// =================================================================================================================
// the machine
// =================================================================================================================
/** Boot the cartridge and sample at every entry of PROC FRAME (state and the picture: both display files). */
function runFramed(R, res, { ticks }) {
  const SYM = { ...R.rt.symbols, ...(R.rt.constants ?? {}) };
  const m = bootedMachine(res.dck);                       // restored from the boot snapshot (V9), video off (V8)
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const ent = SYM.SPR_ENT ?? 6, hasFrame = ent >= 8;
  const nInst = Math.max(res.gen.v2 ? res.gen.v2.ninst : 4, 4);
  const sceneSym = res.gen?.symbols?.scene ?? null;
  const ray = !!res.gen.view, win = !!res.gen.window;
  const modeAddr = ray ? SYM.V_RAY : win ? SYM.V_WIN : undefined;
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    arrays: Object.fromEntries(Object.entries(res.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))])),
    sprites: Array.from({ length: nInst }, (_, i) => {
      const e = SYM.SPR_TAB + ent * i;
      return hasFrame ? { visible: m.ram[e], asset: m.ram[e + 1], x: s16(rd16(e + 2)), y: s16(rd16(e + 4)), frame: m.ram[e + 6] } : { visible: m.ram[e], x: rd16(e + 2), y: rd16(e + 4) };
    }),
    worldRam: win ? m.ram.slice(SYM.WORLD_RAM, SYM.WORLD_RAM + 2048).map((b) => b & 0xF8) : null,      // bits 0-2 are the runtime's class bits (docs/ARCADE_WINDOW_FASTPATH.md section 2)
    cam: win ? rd16(SYM.V_CAM) : 0,
    wallRam: ray ? m.ram.slice(SYM.WORLD_RAM, SYM.WORLD_RAM + 1024) : null,
    pose: ray && SYM.V_POSE !== undefined ? { x: rd16(SYM.V_POSE), y: rd16(SYM.V_POSE + 2), a: m.ram[SYM.V_POSE + 4] } : null,
    scene: sceneSym ? m.ram[sceneSym.cur] : 0,
    mode: modeAddr !== undefined ? m.ram[modeAddr] : null,                      // V_WIN / V_RAY: 1 = the window / view is shown
    cells: m.ram.slice(SYM.CELL_TILE, SYM.CELL_TILE + 768), attrs: m.ram.slice(SYM.CELL_ATTR, SYM.CELL_ATTR + 768),
    files: [m.ram.slice(0x4000, 0x5B00), m.ram.slice(0x6000, 0x7B00)],         // the picture: both display files (bitmap and attributes)
    f4: SYM.V_SHADOW_F4 !== undefined ? m.ram[SYM.V_SHADOW_F4] : null,
  });
  const out = { snaps: [], error: null };
  for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
  const fe = res.map.entries.frame;
  for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F;
  m.joystick[0] = 0xFF; m.joystick[1] = 0xFF;
  const origRead = m.bus.read;
  m.bus.read = function (a) {
    if (a === fe && out.snaps.length < ticks + 1 && m.cpu.pc === fe) out.snaps.push(snap());
    return origRead.call(this, a);
  };
  const div = res.memory[0x8004] & 0x3F;
  const maxFrames = 400 + (ticks + 3) * Math.max(div, 14) * 6;
  for (let f = 0; f < maxFrames && out.snaps.length < ticks + 1; f++) M_.runFrame(m);
  if (out.snaps.length < ticks + 1) out.error = `only ${out.snaps.length} of ${ticks + 1} samples (PROC FRAME entered ${out.snaps.length} times)`;
  return out;
}
const sameBuf = (x, y) => (x === null && y === null) || (!!x && !!y && x.length === y.length && x.every((v, i) => v === y[i]));
const firstDiff = (x, y) => { for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return i; return -1; };
const compileFor = (R, src, assets = ASSETS11) => compile(src, { runtime: R.rt, image: R.img, assets });

/** machine vs interpreter, every sample: the state (diffV3 / diffV4), the scene index, the mode, and the cell map and attributes while the scene shows no window / view */
function vsInterp(R, v, src, { ticks, assets = ASSETS11, got: given, res: givenRes }) {
  const res = givenRes ?? compileFor(R, src, assets);
  if (res.errors.length) return `compile: ${errText(res)}`;
  const got = given ?? runFramed(R, res, { ticks });
  if (got.error) return `run: ${got.error}`;
  let want;
  try { want = interpret(parse(src).ast, interpOpts(R, v, ticks, assets)); } catch (e) { return 'interpreter: ' + e.message; }
  const dv = v === 4 ? diffV4 : diffV3;
  for (let t = 0; t <= ticks; t++) {
    const w = t === 0 ? want.init : want.ticks[t - 1], g = got.snaps[t], at = t === 0 ? 'after INIT' : `after tick ${t}`;
    const d = dv(g, w, at);
    if (d) return d;
    if (g.scene !== w.scene) return `${at}: scene ${g.scene}, interpreter ${w.scene}`;
    if (w.show !== undefined && g.mode !== null) {
      const on = w.show === 'screen' ? 0 : 1;
      if (g.mode !== on) return `${at}: ${v === 4 ? 'V_RAY' : 'V_WIN'} = ${g.mode}, interpreter says the scene shows ${w.show}`;
    }
    if (w.show === 'screen') {
      for (let c = 0; c < 768; c++) if (g.cells[c] !== w.cells[c]) return `${at}: cell (row ${(c / 32) | 0}, col ${c % 32}) = ${asHex(g.cells[c])}, interpreter ${asHex(w.cells[c])}`;
      for (let c = 0; c < 768; c++) if (g.attrs[c] !== w.attrs[c]) return `${at}: attribute (row ${(c / 32) | 0}, col ${c % 32}) = ${asHex(g.attrs[c])}, interpreter ${asHex(w.attrs[c])}`;
    }
    if (g.f4 !== null && g.f4 !== 0x33) return `${at}: V_SHADOW_F4 is ${asHex(g.f4)} at the entry of PROC FRAME (the window must be unmapped)`;
  }
  return null;
}
/** the picture of sample a (run A) against sample b (run B): both display files, the sprite table and the cell map (what the cell map has outside the window is shown) */
/** `swap`: compare A's display file f with B's file 1 - f (the two games are an odd number of drawn ticks apart: every tick draws into the other file). */
function samePicture(A, a, B, b, { cells = true, swap = false } = {}) {
  const x = A.snaps[a], y = B.snaps[b];
  if (!x || !y) return `no sample (${a} / ${b})`;
  for (let f = 0; f < 2; f++) {
    const yf = y.files[swap ? 1 - f : f];
    if (!sameBuf(x.files[f], yf)) { const i = firstDiff(x.files[f], yf); return `display file ${f + 1} differs at ${asHex((f ? 0x6000 : 0x4000) + i)}: ${x.files[f][i]} / ${yf[i]}${swap ? ` (against file ${2 - f} of the other game)` : ''}`; }
  }
  if (JSON.stringify(x.sprites) !== JSON.stringify(y.sprites)) return 'the sprite table differs';
  if (cells && (!sameBuf(x.cells, y.cells) || !sameBuf(x.attrs, y.attrs))) return 'the cell map or the attributes differ';
  return null;
}

// =================================================================================================================
// 2. A harness check that needs only the runtimes of this tree
// =================================================================================================================
console.log('\n2. Harness check on the runtimes of this tree: the programs without the clauses (window / view scenes only) equal the interpreter');
for (const v of [3, 4]) {
  const R = RT[v];
  if (!R) { skip_(`v${v} harness check`, `arcade/build/v${v}/runtime.json is missing`); continue; }
  const ticks = QUICK ? 12 : 20;
  for (const [label, mk] of [['the ring', v === 3 ? CYCLE3 : CYCLE4], ['ENTER of the same scene', v === 3 ? SELF3 : SELF4]]) {
    const src = mk('');
    const d = vsInterp(R, v, src, { ticks });
    check_(`v${v} ${label} with no clause: ${ticks} ticks equal to the interpreter (state, scene index)`, d === null, d ?? '');
  }
}

// =================================================================================================================
// 3. The scenarios of the contract
// =================================================================================================================
console.log('\n3. NOWINDOW / NOVIEW scenes against the interpreter, tick by tick (state, mode, cells)');
for (const v of [3, 4]) {
  const R = RT[v];
  if (!R || MISSING[v].length) { skip_(`v${v} NOWINDOW / NOVIEW scenarios`, `the v${v} runtime lacks ${MISSING[v].join(' ')}: Part B has not landed in this tree (the machine sections need it)`); continue; }
  for (const [label, mk, ticks0] of SCENARIOS[v]) {
    const ticks = QUICK ? Math.min(ticks0, 14) : ticks0;
    const d = vsInterp(R, v, mk(clauseOf(v)), { ticks });
    check_(`v${v} ${label}: ${ticks} ticks equal to the interpreter`, d === null, d ?? '');
  }
}

// =================================================================================================================
// 4. The picture
// =================================================================================================================
console.log('\n4. The picture: a scene without the window / view looks like the same scene in a game without one; the window / view back looks like one that never left');
// a title whose code uses no world word, so the same text runs in a plain game
const TITLE_BODY = { init: '    PRINT AT 3, 4; "TITLE"\n    TILE 10, 10 = 2\n    SHOW ship AT 8, 40\n', frame: '    t = t + 1\n    SHOW ship AT 8 + t * 14, 40 + t * 6\n    a = a + 1\n    PRINT AT 6, 6; a\n' };
const WINSCENE3 = SC('play', '', '', '    CAMERA 70\n    SHOW ship AT 90, 60\n', '    t = t + 1\n    CAMERA 70 + t * 3\n    SHOW ship AT 90 + t * 5, 60\n');
const VIEWSCENE4 = SC('play', '', '', '    VIEW 3000, 2900, 70\n    SHOW ship AT 3300, 2900\n', '    t = t + 1\n    VIEW 3000, 2900, 70 + t * 5\n    SHOW ship AT 3300 + t * 5, 2900\n');
for (const v of [3, 4]) {
  const R = RT[v];
  if (!R || MISSING[v].length) { skip_(`v${v} pictures`, `the v${v} runtime lacks ${MISSING[v].join(' ')}`); continue; }
  const G = v === 3 ? G3 : G4, play = v === 3 ? WINSCENE3 : VIEWSCENE4;
  const ticks = QUICK ? 10 : 14;
  // (a) the first scene with the clause, against the same scene in a plain game (no window / view)
  const stay = SC('title', clauseOf(v), '', TITLE_BODY.init, TITLE_BODY.frame + goAfter(ticks + 3, 'play'));
  const A = G(stay + play), B = G2(SC('title', '', '', TITLE_BODY.init, TITLE_BODY.frame));
  const ra = compileFor(R, A), rb = compile(B, { runtime: R.rt, image: R.img, assets: ASSETS11 });
  if (ra.errors.length || rb.errors.length) { check_(`v${v} the title picture compares with the plain game`, false, errText(ra) + errText(rb)); }
  else {
    const ga = runFramed(R, ra, { ticks }), gb = runFramed(R, rb, { ticks });
    let bad = ga.error ?? gb.error ?? null;
    for (let k = 0; !bad && k <= ticks; k++) { const d = samePicture(ga, k, gb, k); if (d) bad = `sample ${k}: ${d}`; }
    check_(`v${v}: the ${clauseOf(v)} title (text, a tile, a moving sprite, a counter) equals the same scene of a game without the ${v === 3 ? 'WINDOW' : 'VIEW3D'}: both display files, sprite table and cell map at every sample 0..${ticks}`, bad === null, bad ?? '');
  }
  // (b) the window / view back from a title equals a game that never left it: A2 = title (3 ticks) -> play, B2 = play from the start; A2 sample 3 + k is B2 sample k
  const A2 = G(SC('title', clauseOf(v), '', '    PRINT AT 3, 4; "TITLE"\n    SHOW ship AT 8, 40\n', '    t = t + 1\n    SHOW ship AT 8 + t * 14, 40\n' + goAfter(3, 'play')) + play);
  const B2 = G(play);
  const r2a = compileFor(R, A2), r2b = compileFor(R, B2);
  if (r2a.errors.length || r2b.errors.length) check_(`v${v} the picture after the return compares`, false, errText(r2a) + errText(r2b));
  else {
    const n = QUICK ? 6 : 8;
    const ga = runFramed(R, r2a, { ticks: 3 + n }), gb = runFramed(R, r2b, { ticks: n });
    let bad = ga.error ?? gb.error ?? null, from = 2;           // the first two ticks after switching on repaint the window in both files (batch 7 section 1.6): compare from the third
    // the tick that ENTERs play also runs play's INIT and draws it, so the switched game is 3 drawn ticks after the reference: an odd number, so its
    // display file f holds what the reference's file 1 - f holds (found by the runtime engineer, batch 7 part B; the game logic is aligned, the files are not)
    for (let k = from; !bad && k <= n; k++) { const d = samePicture(ga, 3 + k, gb, k, { swap: true }); if (d) bad = `play tick ${k}: ${d}`; }
    check_(`v${v}: the ${v === 3 ? 'window' : '3D view'} back from a ${clauseOf(v)} title equals a game that never left it (both files, sprites, cell map; ticks ${from}..${n} after the return)`, bad === null, bad ?? '');
  }
}

// =================================================================================================================
// 5. Negative controls
// =================================================================================================================
console.log('\n5. Negative controls: the comparisons see a wrong mode');
{
  const v = 3, R = RT[v];
  if (!R || MISSING[v].length) skip_('negative controls', `the v3 runtime lacks ${MISSING[v].join(' ') || 'the runtime'}`);
  else {
    const ticks = 10;
    // (a) the interpreter of the program without the clause against the machine with it: a title SHOW at 300, 300 is clamped by the machine and not by that interpreter
    const withClause = CYCLE3('NOWINDOW');
    const res = compileFor(R, withClause);
    const got = runFramed(R, res, { ticks });
    const wrongInterp = interpret(parse(CYCLE3('')).ast, interpOpts(R, 3, ticks, ASSETS11));
    const d = diffV3(got.snaps[0], wrongInterp.init, 'init');
    check_('control: the machine with NOWINDOW differs from the interpreter without it (the clamped SHOW of the title)', d !== null, d ?? 'no difference seen');
    // (b) a program whose title says NOWINDOW but whose twin keeps the window: the pictures of the title differ (the window is drawn over the picture)
    const keep = compileFor(R, CYCLE3(''));
    const gk = runFramed(R, keep, { ticks });
    check_('control: the title picture with NOWINDOW differs from the same title with the window shown', samePicture(got, 2, gk, 2) !== null);
    // (c) a damaged mode call: A = 1 for the title (the window stays on): the state comparison with the interpreter must see it
    const dmg = { ...res, dck: res.dck.slice() };
    const code = res.gen.code; let hit = -1;
    const WM = R.rt.symbols.RT_WINMODE;
    for (let i = 2; i + 2 < code.length; i++) if (code[i] === 0xCD && code[i + 1] === (WM & 255) && code[i + 2] === WM >> 8 && code[i - 2] === 0x3E && code[i - 1] === 0) { hit = i - 1; break; }
    if (hit < 0) check_('control: a damaged mode call (A = 0 -> 1 at boot) is seen', false, 'the call was not found in the code');
    else {
      dmg.dck[9 + 2 * 8192 + (res.gen.base + hit - 0x8000)] = 1;
      const dd = vsInterp(R, 3, withClause, { ticks, res: dmg });
      check_('control: a damaged mode call (A = 0 -> 1 at boot) is seen against the interpreter', dd !== null, dd ?? 'no difference seen');
    }
  }
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}: ${passed} checks passed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}`);
if (skipped && MISSING[3].length + MISSING[4].length) console.log(`NOTE: the machine sections were skipped because the runtime lacks ${[...MISSING[3], ...MISSING[4]].join(' ')} (Part B). Run this file again when they land.`);
process.exit(failed === 0 ? 0 : 1);
