#!/usr/bin/env node
"use strict";
// arcade-m10-compiler.mjs -- tests for the COMPILER half of Leap Arcade language batch 5. The contract is docs/ARCADE_LANGUAGE_BATCH5.md: Part A (TIMER, KEYPRESS, JOYPRESS, items 1-10),
// Part B (PRINT ... USING, items 11-14) and item 15 of Part C (PLAY by index). The three-channel effects (16-20) are not tested here.
//
//   node tests/arcade-m10-compiler.mjs               (ARCADE_QUICK=1: fewer generated programs)
//
// No machine is booted here (tests/arcade-m10-differential.mjs runs the code on the real runtimes). Sections
//   1  parser and checker: every message of Parts A, B and C-PLAY with its exact text and position, positives and negatives, scope rules, reserved words, the old-runtime refusals, the word table
//   2  the reference interpreter, hand-computed: timers (items 1, 2), KEYPRESS / JOYPRESS (items 5, 6), USING cells, PLAY by index (item 15)
//   3  fmtUsing (exported by arcade-interp.js) against an independent model of item 12: all 65,536 values x 8 patterns and the examples of the contract
//   4  the image on the real v2 runtime: unchanged headers without the new words, the stub with them, symbols.keys, byte sequences of items 8 and 13 / 15, sizes (reported)
//   5  everything the differential suite runs compiles (generated programs, hand programs, the v3 / v4 spot programs)
//
// Where the contract is silent the test takes the reading its text supports most literally and says so in a comment beginning "READING:".
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import * as INTERP from '../src/lang/arcade/arcade-interp.js';
import { compile, requiredRuntime } from '../src/lang/arcade/arcade-compile.js';
import { ARCADE_WORDS, RESERVED, FUNCTIONS } from '../src/lang/arcade/arcade-words.js';
import { scanArcade } from '../src/lang/arcade/arcade-scan.js';
import { ASSETS, HAND10, USING_PATTERNS, modelUsing, edgeModel, rowText, genProgram10, genV3x, genV4x, rng, sweepProgram, foldProgram } from './arcade-m10-common.mjs';
import { sceneKeys } from './arcade-m9-common.mjs';

const { interpret } = INTERP;
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const QUICK = !!process.env.ARCADE_QUICK;

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

// ── source helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TOP = 'GAME "t"\nFRAMERATE 30\nSPRITE ship = "orb"\nSFX snda = "short"\nSFX sndb = "long"\nSFX sndc = "short"\n';
/** a one-scene game (every runnable game has a SCENE): top-level declarations, then SCENE s with PROC INIT and PROC FRAME with the given bodies (lines ending in \n, indented as you like) */
const classic = (decl, frame, init = '', head = TOP) => `${head}${decl ? decl + '\n' : ''}SCENE s\n  PROC INIT()\n${init}  ENDP\n  PROC FRAME()\n${frame}  ENDP\nENDSCENE\n`;
const scene = (name, { decl = '', procs = '', init = '', frame = '' } = {}) =>
  `SCENE ${name}\n${decl ? `  ${decl.replace(/\n/g, '\n  ')}\n` : ''}${procs}  PROC INIT()\n${init ? init + '\n' : ''}  ENDP\n  PROC FRAME()\n${frame ? frame + '\n' : ''}  ENDP\nENDSCENE\n`;
const diag = (src, version = 2) => { const p = parse(src); return [...p.errors, ...check(p.ast, { version })]; };
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
const matches = (d, msg) => (msg instanceof RegExp ? msg.test(d.message) : d.message === msg);
/** an error with this message whose position is on `from.line` with a column from `from.col` to `toCol` (inclusive): where the contract names no exact column the test allows the statement / item span */
const badSpan = (name, src, msg, from, toCol, v) => {
  const e = errs(src, v), hits = e.filter((d) => matches(d, msg));
  const hit = hits.find((d) => d.line === from.line && d.col >= from.col && d.col <= toCol);
  check_(name, !!hit, hit ? '' : hits.length ? `found at ${hits.map((d) => d.line + ':' + d.col)}, want line ${from.line} col ${from.col}..${toCol}` : `no such error: ${msgs(e) || 'no errors'}`);
};
/** exactly at a position */
const badAt = (name, src, msg, where, v) => badSpan(name, src, msg, where, where.col, v);
/** any error on that line */
const badLine = (name, src, line, v) => { const e = errs(src, v); check_(name, e.some((d) => d.line === line), msgs(e) || 'no errors'); };
const warnSrc = (name, src, msg, where, v) => {
  const w = warns(src, v).filter((d) => matches(d, msg));
  check_(name, w.length >= 1 && (!where || w.some((d) => d.line === where.line && d.col === where.col)) && errs(src, v).length === 0, `${msgs(warns(src, v))} || errors: ${msgs(errs(src, v))}`);
};
const noWarn = (name, src, rx, v) => { const w = warns(src, v).filter((d) => rx.test(d.message)); check_(name, w.length === 0, msgs(w)); };

// ── real runtimes ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function loadRt(path) {
  const json = join(ROOT, path);
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))) };
}
const RT0 = loadRt('arcade/build/runtime.json'), RT1 = loadRt('arcade/build/v1/runtime.json'), RT2 = loadRt('arcade/build/v2/runtime.json'), RT3 = loadRt('arcade/build/v3/runtime.json'), RT4 = loadRt('arcade/build/v4/runtime.json');
const cmp = (src, R, assets = ASSETS) => compile(src, { runtime: R.rt, image: R.img, assets });
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');

// =================================================================================================================
// 1. Parser and checker
// =================================================================================================================
console.log('1. Parser and checker: Part A (TIMER, KEYPRESS, JOYPRESS), Part B (USING), Part C (PLAY by index)');
{
  // -- TIMER: where it may stand
  {
    okSrc('TIMER at the top level, three names, used as numeric variables (assigned, compared, added)', classic('TIMER cooldown, blink, wait', '  cooldown = 30\n  IF cooldown = 0 THEN blink = blink + 1 ENDIF\n  wait = cooldown + blink\n'));
    // READING: the contract's own example is `TIMER cooldown, flash, wait`, but FLASH is a reserved word of the language since batch 1 (the PRINT attribute), so that exact line cannot compile: reported, not counted
    { const e = errs(classic('TIMER cooldown, flash, wait', '  cooldown = 30\n  wait = cooldown\n')); info(`the contract's example line "TIMER cooldown, flash, wait" ${e.length ? 'is REFUSED: ' + msgs(e).slice(0, 110) : 'compiles'}`); }
    okSrc('TIMER directly inside a SCENE', TOP + scene('a', { decl: 'TIMER t1, t2', frame: '    t1 = 5\n    IF t2 = 0 THEN t2 = t1 ENDIF' }));
    okSrc('a game-level TIMER and scene timers of the same names in two scenes (each scene its own)', TOP + 'TIMER gt\n' + scene('a', { decl: 'TIMER tm', frame: '    tm = gt + 1\n    ENTER b' }) + scene('b', { decl: 'TIMER tm, tb', frame: '    tm = 2 : tb = tm : gt = 4\n    ENTER a' }));
    okSrc('a timer is an ordinary variable: printed, passed to a PROC, used in DEF FN, in an array index, in a FOR bound',
      classic('TIMER cd\nDIM arr(3)\nDEF FN dbl(x) = x * 2\nPROC SHOWIT(v)\n  PRINT AT 0, 0; v\nENDP', '  PRINT AT 1, 1; cd\n  CALL SHOWIT(cd)\n  arr(BAND(cd, 3)) = FN dbl(cd)\n  FOR i = 0 TO cd\n  NEXT i\n  cd = cd - 1\n'));
    okSrc('TIMER before and after DIM, and several TIMER lines', classic('TIMER a\nDIM b\nTIMER c, d', '  a = 1 : b = 2 : c = 3 : d = 4\n'));
    okSrc('a name of exactly 31 characters', classic('TIMER abcdefghijklmnopqrstuvwxyz01234', '  abcdefghijklmnopqrstuvwxyz01234 = 1\n'));
    badSpan('a name of 32 characters is refused (names have up to 31)', classic('TIMER abcdefghijklmnopqrstuvwxyz012345', ''), /longer than 31 characters/, { line: 7, col: 6 }, 40);
    const inProc = classic('', '  TIMER x\n  x = 1\n');
    badSpan('TIMER inside PROC FRAME: the exact message, at the TIMER statement (or its name)', inProc, 'TIMER must be at the top level or directly inside a SCENE, not inside a PROC', at(inProc, 'TIMER x'), at(inProc, 'TIMER x').col + 6);
    const inScenePr = TOP + scene('a', { procs: '  PROC HELPER(n)\n    TIMER w\n  ENDP\n' });
    badSpan('... inside a scene PROC', inScenePr, 'TIMER must be at the top level or directly inside a SCENE, not inside a PROC', at(inScenePr, 'TIMER w'), at(inScenePr, 'TIMER w').col + 6);
    const nested = classic('DIM x', '  IF x = 0 THEN\n    TIMER w\n  ENDIF\n');
    badSpan('... nested in an IF inside a PROC', nested, 'TIMER must be at the top level or directly inside a SCENE, not inside a PROC', at(nested, 'TIMER w'), at(nested, 'TIMER w').col + 6);
    const inInit = TOP + scene('a', { init: '    TIMER w' });
    badSpan('... inside PROC INIT of a scene', inInit, 'TIMER must be at the top level or directly inside a SCENE, not inside a PROC', at(inInit, 'TIMER w'), at(inInit, 'TIMER w').col + 6);
  }
  // -- TIMER: what it may hold
  {
    const s = classic('TIMER s$', '  s$ = "a"\n');
    badSpan('a $ name: "a TIMER holds a number", at the timer', s, 'a TIMER holds a number', at(s, 'TIMER s$'), at(s, 'TIMER s$').col + 8);
    const s2 = classic('TIMER a, b$, c', '  a = 1\n');
    badSpan('... the second name of a list', s2, 'a TIMER holds a number', at(s2, 'TIMER a'), at(s2, 'b$').col + 2);
    const arr = classic('TIMER arr(3)', '  arr(1) = 2\n');
    badLine('an array size (TIMER arr(3)): an error on that line', arr, at(arr, 'TIMER arr').line);
    const init = classic('TIMER cd = 5', '  cd = 1\n');
    // READING: "scalars only" -- an initial value is not part of the TIMER form (a timer starts at 0 like a DIM variable): an error on that line
    badLine('READING: an initial value (TIMER cd = 5) is an error (the form lists names only)', init, at(init, 'TIMER cd').line);
  }
  // -- TIMER: names follow the DIM rules
  {
    const dup = classic('TIMER cd, cd', '  cd = 1\n');
    badAt('a name twice in one TIMER: "\'cd\' is already declared (line N)" at the second', dup, `'cd' is already declared (line ${at(dup, 'TIMER cd').line})`, at(dup, 'cd', 1));
    const dup2 = classic('TIMER cd\nTIMER cd', '  cd = 1\n');
    badAt('two TIMER lines with the same name: at the second declaration', dup2, `'cd' is already declared (line ${at(dup2, 'TIMER cd').line})`, at(dup2, 'cd', 1));
    const dimFirst = classic('DIM cd\nTIMER cd', '  cd = 1\n');
    badAt('DIM then TIMER of one name: the old DIM wins, the error is at the TIMER\'s name', dimFirst, `'cd' is already declared (line ${at(dimFirst, 'DIM cd').line})`, at(dimFirst, 'cd', 1));
    const timerFirst = classic('TIMER cd\nDIM cd', '  cd = 1\n');
    badAt('TIMER then DIM of one name: the error is at the DIM\'s name', timerFirst, `'cd' is already declared (line ${at(timerFirst, 'TIMER cd').line})`, at(timerFirst, 'cd', 1));
    const arr = classic('DIM cd(3)\nTIMER cd', '  cd(1) = 1\n');
    badAt('a TIMER with the name of a DIM array', arr, `'cd' is already declared (line ${at(arr, 'DIM cd').line})`, at(arr, 'cd', 1));
    const cnst = classic('CONST cd = 3\nTIMER cd', '');
    badAt('a TIMER with the name of a CONST', cnst, `'cd' is already declared (line ${at(cnst, 'CONST cd').line})`, at(cnst, 'cd', 1));
    const gs = TOP + 'TIMER x\n' + scene('a', { decl: 'TIMER x' });
    badAt('a scene TIMER with the name of a game-level TIMER', gs, `'x' is already declared (line ${at(gs, 'TIMER x').line})`, at(gs, 'x', 1));
    const gd = TOP + 'DIM x\n' + scene('a', { decl: 'TIMER x' });
    badAt('a scene TIMER with the name of a game-level DIM', gd, `'x' is already declared (line ${at(gd, 'DIM x').line})`, at(gd, 'x', 1));
    const sd = TOP + scene('a', { decl: 'DIM x\nTIMER x' });
    badAt('a scene TIMER with the name of a DIM of the same scene', sd, `'x' is already declared (line ${at(sd, 'DIM x').line})`, at(sd, 'x', 1));
    const gp = TOP + 'PROC GP()\nENDP\n' + scene('a', { decl: 'TIMER gp' });
    badAt('a scene TIMER with the name of a game-level PROC', gp, "'gp' is already the name of a PROC or DEF FN", at(gp, 'gp'));
    const later = TOP + 'PROC P()\n  cd = 1\nENDP\nTIMER cd\n' + scene('a', { frame: '    CALL P()' });
    check_('use before the declaration (a PROC above the TIMER line) is refused like for DIM: "declared"', errs(later).some((d) => /'cd'.*(not declared|declared later)|variable 'cd' is not declared/.test(d.message)), msgs(errs(later)) || 'no errors');
    const undeclared = classic('', '  cd = 1\n');
    check_('a timer name that is never declared: the old "not declared" error', errs(undeclared).some((d) => /'cd' is not declared/.test(d.message)), msgs(errs(undeclared)));
    // scope
    const cross = TOP + scene('a', { decl: 'TIMER mine' }) + scene('b', { frame: '    mine = 1' });
    badSpan('a scene cannot see the TIMER of another scene', cross, /'mine' is not declared/, { line: at(cross, 'mine = 1').line, col: at(cross, 'mine = 1').col }, at(cross, 'mine = 1').col + 6, 2);
    const tl = TOP + 'DIM g\nPROC GP()\n  hidden = 1\nENDP\n' + scene('a', { decl: 'TIMER hidden', frame: '    CALL GP()' });
    badSpan('a top-level PROC cannot see the TIMER of a scene', tl, /'hidden' is not declared/, at(tl, 'hidden = 1'), at(tl, 'hidden = 1').col + 6, 2);
    okSrc('a scene sees the game-level TIMER; the game-level DEF FN sees it too', TOP + 'TIMER gt\nDEF FN left(x) = gt + x\n' + scene('a', { decl: 'DIM v', frame: '    v = FN left(1) + gt\n    gt = 3' }));
    okSrc('the same TIMER name in three scenes', TOP + ['a', 'b', 'c'].map((n, k) => scene(n, { decl: 'TIMER tm', frame: `    tm = ${k + 1}\n    ENTER ${'bca'[k]}` })).join(''));
  }
  // -- TIMER: warnings
  {
    const unused = classic('TIMER idle, used', '  used = 1\n');
    warnSrc('a timer that is never used: the usual \'variable \'x\' is never used\' warning, at the name', unused, "variable 'idle' is never used", at(unused, 'idle'));
    noWarn('... and a timer that is used raises none', unused, /'used' is never used/);
    const uns = TOP + scene('a', { decl: 'TIMER idle' });
    warnSrc('... also a scene timer', uns, "variable 'idle' is never used", at(uns, 'idle'));
  }
  // -- the words: reserved TIMER KEYPRESS JOYPRESS, contextual USING
  {
    for (const w of ['timer', 'keypress', 'joypress']) {
      const d = classic(`DIM ${w}`, '');
      badSpan(`a variable called ${w} must be renamed ("reserved word")`, d, /reserved word/, at(d, `DIM ${w}`), at(d, `DIM ${w}`).col + 4 + w.length, 2);
    }
    badSpan('a TIMER called timer', classic('TIMER timer', ''), /reserved word/, { line: 7, col: 0 }, 12);
    badSpan('a CONST called joypress', classic('CONST joypress = 1', ''), /reserved word/, { line: 7, col: 0 }, 20);
    badSpan('a PROC called timer', classic('PROC timer()\nENDP', ''), /reserved word/, { line: 7, col: 0 }, 12);
    badSpan('a parameter called keypress', classic('PROC P(keypress)\nENDP', ''), /reserved word/, { line: 7, col: 0 }, 20);
    okSrc('USING is contextual: DIM using, using = 3, PRINT using', classic('DIM using', '  using = 3\n  using = using + 1\n  PRINT AT 0, 0; using\n'));
    okSrc('... and an item called using followed by the USING word', classic('DIM using', '  PRINT AT 0, 0; using USING "000"\n'));
    check_('the word table: RESERVED has TIMER, KEYPRESS, JOYPRESS and not USING', RESERVED.has('TIMER') && RESERVED.has('KEYPRESS') && RESERVED.has('JOYPRESS') && !RESERVED.has('USING'));
    check_('... ARCADE_WORDS has an entry with a syntax line and a description for all four (Help)', ['TIMER', 'KEYPRESS', 'JOYPRESS', 'USING'].every((w) => { const e = ARCADE_WORDS.get(w); return e && String(e.syntax).length > 0 && String(e.desc).length > 20; }), ['TIMER', 'KEYPRESS', 'JOYPRESS', 'USING'].map((w) => !!ARCADE_WORDS.get(w)).join());
    check_('... KEYPRESS and JOYPRESS are built-in functions (FUNCTIONS)', FUNCTIONS.has('KEYPRESS') && FUNCTIONS.has('JOYPRESS'));
    const sc = scanArcade(TOP + 'TIMER gt, gu\n' + scene('a', { decl: 'TIMER tm\nDIM v' }) + scene('b', { decl: 'TIMER tm' }));
    const names = sc.vars.map((v) => `${v.scene ?? ''}/${v.name}`);
    check_('scanArcade lists timers with the variables (game level and per scene)', ['/gt', '/gu', 'a/tm', 'a/v', 'b/tm'].every((n) => names.includes(n)), names.join());
  }
  // -- KEYPRESS
  {
    const F = (expr) => classic('DIM x', `  x = ${expr}\n`);
    okSrc('KEYPRESS("O"), KEYPRESS(79), KEYPRESS("o") and KEYPRESS(32) are fine on v2', classic('DIM x', '  x = KEYPRESS("O") + KEYPRESS(79) + KEYPRESS("o")\n  IF KEYPRESS(32) THEN x = 0 ENDIF\n  IF KEYPRESS("A") OR NOT KEYPRESS(13) THEN x = 1 ENDIF\n'));
    okSrc('KEYPRESS in INIT, in a DEF FN-less condition of a WHILE and of a SELECT is fine', classic('DIM x', '  WHILE KEYPRESS("Q") = 0 AND x < 2\n    x = x + 1\n  WEND\n', '  x = KEYPRESS("O")\n'));
    const noArg = F('KEYPRESS()');
    badSpan('KEYPRESS() without an argument: "KEYPRESS takes 1 argument, got 0"', noArg, 'KEYPRESS takes 1 argument, got 0', at(noArg, 'KEYPRESS'), at(noArg, 'KEYPRESS').col + 10);
    const two = F('KEYPRESS(1, 2)');
    badSpan('KEYPRESS(1, 2): "KEYPRESS takes 1 argument, got 2"', two, 'KEYPRESS takes 1 argument, got 2', at(two, 'KEYPRESS'), at(two, 'KEYPRESS').col + 14);
    // READING: "c is written exactly as KEYDOWN's ... an unknown key code is the same warning": the same checks and the same texts as KEYDOWN's, naming KEYPRESS
    const v = classic('DIM x, k', '  x = KEYPRESS(k)\n');
    badSpan('KEYPRESS(k) with a variable: refused like KEYDOWN(k) (the key must be written out)', v, /KEYPRESS.*written out|written out.*KEYPRESS/, at(v, 'KEYPRESS'), at(v, 'KEYPRESS').col + 16);
    const long = F('KEYPRESS("OO")');
    badSpan('KEYPRESS("OO"): a one-character string is needed (the string has 2 characters)', long, /KEYPRESS needs a one-character string.*2 characters/, at(long, 'KEYPRESS'), at(long, '"OO"').col + 4);
    const big = F('KEYPRESS(300)');
    badSpan('KEYPRESS(300): the code must be 0..255', big, /KEYPRESS code 300 must be 0\.\.255/, at(big, 'KEYPRESS'), at(big, '300').col + 3);
    const neg = F('KEYPRESS(-1)');
    badSpan('KEYPRESS(-1): the code must be 0..255', neg, /KEYPRESS code -1 must be 0\.\.255/, at(neg, 'KEYPRESS'), at(neg, '-1').col + 2);
    const unk = F('KEYPRESS("-")');
    check_('an unknown key (KEYPRESS("-")) is the KEYDOWN warning: "never held", no error', warns(unk).some((d) => /KEYPRESS|KEYDOWN/.test(d.message) && /never held/.test(d.message) && d.line === at(unk, 'KEYPRESS').line) && errs(unk).length === 0, msgs(warns(unk)));
    const unk2 = F('KEYPRESS(45)');
    check_('... and KEYPRESS(45)', warns(unk2).some((d) => /never held/.test(d.message)) && errs(unk2).length === 0, msgs(diag(unk2)));
    check_('requiredRuntime: KEYPRESS / JOYPRESS / TIMER / USING need only v2 (no v3 / v4 reason)', (() => { const r = requiredRuntime(classic('TIMER t\nDIM x', '  x = KEYPRESS("O") + JOYPRESS(1)\n  PRINT AT 0, 0; t USING "00"\n'), ASSETS); return r.version === 2 && r.reasons.length === 0; })());
  }
  // -- JOYPRESS
  {
    const F = (expr) => classic('DIM x, n', `  x = ${expr}\n`);
    okSrc('JOYPRESS(1), JOYPRESS(2), BIT(JOYPRESS(1), 4) and arithmetic on the mask are fine', classic('DIM x', '  x = JOYPRESS(1) + JOYPRESS(2) * 2\n  IF BIT(JOYPRESS(1), 4) THEN x = 0 ENDIF\n  IF JOYPRESS(2) > 0 AND x = 0 THEN x = 1 ENDIF\n'));
    const MSG = 'JOYPRESS needs the joystick number written out: 1 or 2';
    for (const bad of ['3', '0', '-1', 'n', '256']) {
      const s = F(`JOYPRESS(${bad})`);
      badSpan(`JOYPRESS(${bad}): "${MSG}"`, s, MSG, at(s, 'JOYPRESS'), at(s, `JOYPRESS(${bad})`).col + 11 + bad.length);
    }
    const s2 = F('JOYPRESS(n + 1)');
    badSpan('JOYPRESS(n + 1): the same message (anything but a literal 1 or 2)', s2, MSG, at(s2, 'JOYPRESS'), at(s2, 'JOYPRESS').col + 17);
    const noArg = F('JOYPRESS()');
    badSpan('JOYPRESS() without an argument: "JOYPRESS takes 1 argument, got 0"', noArg, 'JOYPRESS takes 1 argument, got 0', at(noArg, 'JOYPRESS'), at(noArg, 'JOYPRESS').col + 10);
  }
  // -- PRINT ... USING
  {
    const P = (items, decl = 'DIM x, y') => classic(decl, `  PRINT ${items}\n`);
    for (const [name, items] of [
      ['one number', 'AT 0, 0; x USING "000"'], ['a pattern of one #', 'x USING "#"'], ['8 characters', 'x USING "########"'], ['a mixed pattern', 'x USING "#0#0"'], ['0#', 'x USING "0#"'],
      ['a literal item', '5 USING "00"'], ['a negative literal', '-5 USING "000"'], ['a bracketed expression', '(x + 1) USING "00"'], ['an expression item (USING binds the whole item)', 'x + 1 USING "00"'],
      ['a negated variable', '-x USING "00"'], ['a function call', 'RND(9) USING "00"'], ['an item then text', 'x USING "00"; "a"'], ['text, then an item, then a trailing ;', '"T"; x USING "00";'],
      ['a comma separator and two USING items', 'x USING "00", y USING "0"'], ['AT and a trailing comma', 'AT 3, 4; x USING "000",'], ['a lower-case using', 'x using "000"'],
    ]) okSrc(`USING: ${name} (PRINT ${items})`, P(items));
    okSrc('USING after a CONST item and after a DEF FN call', classic('CONST K = 7\nDEF FN f(a) = a * 2', '  PRINT K USING "000"; FN f(2) USING "00"\n'));
    // a text item
    const T = (items, decl = 'DIM x\nDIM s$') => classic(decl, `  PRINT ${items}\n`);
    const TXT = 'USING formats a number: a text item cannot take it';
    for (const [name, items] of [['a string literal', '"abc" USING "00"'], ['STR$(x)', 'STR$(x) USING "00"'], ['a string variable', 's$ USING "00"'], ['a joined text', '"a" + "b" USING "00"'], ['a text after a number item', 'x USING "0"; "abc" USING "00"']]) {
      const s = T(items), u = at(s, 'USING', name === 'a text after a number item' ? 1 : 0);
      badSpan(`USING on ${name}: "${TXT}"`, s, TXT, { line: u.line, col: at(s, 'PRINT').col }, u.col + 14);
    }
    const BADPAT = 'USING needs a pattern of # and 0 written out, up to 8 characters';
    for (const [name, pat] of [['an empty pattern', '""'], ['9 characters', '"000000000"'], ['9 #', '"#########"'], ['a letter', '"00A"'], ['only letters', '"ab"'], ['a space', '"0 0"'], ['a point', '"0.0"'], ['a comma', '"##,#"'], ['a 9', '"9"'], ['a lower-case o', '"o"'], ['a minus', '"-0"']]) {
      const s = P(`x USING ${pat}`), u = at(s, 'USING');
      badSpan(`USING with ${name}: "${BADPAT}"`, s, BADPAT, u, u.col + 6 + pat.length);
    }
    for (const [name, tail] of [['no pattern at the end of the line', 'x USING'], ['a variable as the pattern', 'x USING y'], ['a number as the pattern', 'x USING 5'], ['no pattern before a ;', 'x USING; "a"'], ['a call as the pattern', 'x USING STR$(y)']]) {
      const s = P(tail), u = at(s, 'USING');
      badSpan(`USING with ${name}: the same message`, s, BADPAT, u, u.col + 14);
    }
    const dbl = P('x USING "00" USING "0"');
    badLine('USING twice on one item: an error on that line', dbl, at(dbl, 'PRINT').line);
    const noItem = P('USING "00"');
    badLine('USING with no item before it: an error on that line', noItem, at(noItem, 'PRINT').line);
    const unusedPat = P('x USING "000"; y');
    check_('a good USING raises no warning of its own', warns(unusedPat).filter((d) => /USING/.test(d.message)).length === 0, msgs(warns(unusedPat)));
  }
  // -- PLAY by index
  {
    const PL = (stmt, decl = 'DIM x\nCONST K = 7\nCONST J = 2') => classic(decl, `  ${stmt}\n`);
    for (const stmt of ['PLAY snda', 'PLAY sndc', 'PLAY 0', 'PLAY 1', 'PLAY 2', 'PLAY x', 'PLAY x + 1', 'PLAY (x)', 'PLAY BAND(x, 1)', 'PLAY 1 + 1', 'PLAY J', 'PLAY x MOD 3', 'SILENCE']) okSrc(`${stmt} is fine with 3 effects`, PL(stmt));
    const W = (n) => `PLAY ${n}: there are only 3 sound effects (0..2)`;
    for (const n of ['3', '9', '255', '256', '1000']) { const s = PL(`PLAY ${n}`); badSpan(`PLAY ${n}: "${W(n)}", at the PLAY (or its operand)`, s, W(n), at(s, 'PLAY'), at(s, `PLAY ${n}`).col + 5 + n.length); }
    const neg = PL('PLAY -1');
    badSpan('PLAY -1 (a negative literal): "there are only 3 sound effects (0..2)"', neg, /^PLAY -1: there are only 3 sound effects \(0\.\.2\)$/, at(neg, 'PLAY'), at(neg, 'PLAY').col + 8);
    const k = PL('PLAY K');
    badSpan('PLAY K with CONST K = 7: the same error, "there are only 3 sound effects (0..2)"', k, /there are only 3 sound effects \(0\.\.2\)/, at(k, 'PLAY'), at(k, 'PLAY K').col + 6);
    const kk = PL('PLAY K - 5');
    okSrc('PLAY K - 5 (= 2, in range) is fine', kk);
    const unk = PL('PLAY nothing');
    check_('PLAY of a name that is no effect and no variable: an error naming it', errs(unk).some((d) => /'nothing'/.test(d.message) && d.line === at(unk, 'PLAY').line), msgs(errs(unk)));
    const unk2 = PL('PLAY (nothing)');
    check_('PLAY (nothing): an error naming it', errs(unk2).some((d) => /'nothing'/.test(d.message) && d.line === at(unk2, 'PLAY').line), msgs(errs(unk2)));
    // a variable with an effect's name: PLAY name = the effect, PLAY (name) = the variable
    const both = classic('DIM snda', '  snda = 1\n  PLAY snda\n');
    check_('a variable called snda next to the effect snda: PLAY snda is the effect (no error; the SFX counts as used)', errs(both).length === 0 && !warns(both).some((d) => d.message === "SFX 'snda' is never used"), msgs(diag(both)));
    const par = classic('DIM snda', '  snda = 1\n  PLAY (snda)\n');
    check_('... PLAY (snda) is the variable (no error; the variable counts as used)', errs(par).length === 0 && !warns(par).some((d) => d.message === "variable 'snda' is never used"), msgs(diag(par)));
    const only = classic('DIM snda', '  PLAY snda\n');
    check_('... with only PLAY snda the VARIABLE is never used (warning) and the effect is used', warns(only).some((d) => d.message === "variable 'snda' is never used") && !warns(only).some((d) => d.message === "SFX 'snda' is never used"), msgs(warns(only)));
    const oneFx = classic('', '  PLAY 1\n', '', 'GAME "t"\nFRAMERATE 30\nSFX only = "short"\n');
    check_('one effect declared, PLAY 1: an error "there are only 1 sound effect..." (READING: the plural is not adjusted)', errs(oneFx).some((d) => /there are only 1 sound effect/.test(d.message) && d.line === 8), msgs(errs(oneFx)));
    const noFx = classic('', '  PLAY 0\n', '', 'GAME "t"\nFRAMERATE 30\n');
    check_('no effect declared, PLAY 0: an error "PLAY 0: there are only 0 sound effects..." or "there are no sound effects" (READING)', errs(noFx).some((d) => /^PLAY 0:/.test(d.message) && /only 0 sound effects|no sound effects/.test(d.message) && d.line === 7), msgs(errs(noFx)));
    okSrc('PLAY by index inside a scene, in INIT and in a PROC', TOP + scene('a', { decl: 'DIM v', procs: '  PROC GO(n)\n    PLAY n\n  ENDP\n', init: '    PLAY 2', frame: '    v = v + 1\n    PLAY v MOD 3\n    CALL GO(v)' }));
  }
  // -- the old runtimes (the checker is told the version; the generator refuses)
  {
    const OLD = 'GAME "t"\nFRAMERATE 30\n';
    const src = classic('TIMER cd', '  cd = 3\n', '', OLD);
    const p = parse(src);
    check_('check(ast, {version: 1}) raises no TIMER error of its own (the generator refuses, as for every v2 feature)', check(p.ast, { version: 1 }).filter((d) => d.severity === 'error').length === 0, msgs(check(p.ast, { version: 1 })));
    const T = at(src, 'TIMER cd');
    if (RT0) {
      const r = cmp(src, RT0), e = r.errors.find((d) => d.message === 'TIMER is not supported yet in M2 (build with --runtime v2)');
      check_('v0 runtime: "TIMER is not supported yet in M2 (build with --runtime v2)" on the TIMER line, no dck', !!e && e.line === T.line && e.col >= T.col && e.col <= T.col + 10 && !r.dck, errText(r));
      const k = cmp(classic('DIM x', '  x = KEYPRESS("O")\n', '', OLD), RT0);
      check_('v0 runtime: KEYPRESS is refused ("... not supported yet in M2")', k.errors.some((d) => /KEYPRESS/.test(d.message) && /not supported yet in M2/.test(d.message)) && !k.dck, errText(k));
      const j = cmp(classic('DIM x', '  x = JOYPRESS(1)\n', '', OLD), RT0);
      check_('v0 runtime: JOYPRESS is refused ("... not supported yet in M2")', j.errors.some((d) => /JOYPRESS/.test(d.message) && /not supported yet in M2/.test(d.message)) && !j.dck, errText(j));
    } else skip_('v0 runtime refusals', 'arcade/build/runtime.json does not exist');
    if (RT1) {
      const r = cmp(src, RT1), e = r.errors.find((d) => d.message === 'TIMER is not supported yet in M3 (build with --runtime v2)');
      check_('v1 runtime: "TIMER is not supported yet in M3 (build with --runtime v2)" on the TIMER line', !!e && e.line === T.line && e.col >= T.col && e.col <= T.col + 10, errText(r));
      const k = cmp(classic('DIM x', '  x = KEYPRESS("O")\n', '', OLD), RT1);
      check_('v1 runtime: KEYPRESS is refused ("... not supported yet in M3")', k.errors.some((d) => /KEYPRESS/.test(d.message) && /not supported yet in M3/.test(d.message)), errText(k));
    } else skip_('v1 runtime refusals', 'arcade/build/v1/runtime.json does not exist');
    if (RT2) check_('v2 runtime: the same game compiles', cmp(src, RT2).errors.length === 0, errText(cmp(src, RT2)));
  }
}

// =================================================================================================================
// 2. The reference interpreter, hand-computed
// =================================================================================================================
console.log('\n2. Interpreter: timers (items 1, 2), key edges (items 5, 6), USING cells, PLAY by index (item 15)');
const fmtKeys = (keys) => (keys ? (t, c) => keys(t).includes(c) : undefined);
const ip = (src, ticks, opts = {}) => interpret(parse(src).ast, { version: 2, ticks, assets: ASSETS, maxSteps: 50_000_000, ...opts });
const tryIp = (name, fn) => { try { return fn(); } catch (e) { check_(name, false, `interpreter threw: ${e.message}`); return null; } };
const runHand = (h) => ip(h.src, h.ticks, { keys: fmtKeys(h.keys), stick: h.stick });
const seriesOf = (r, key) => r.ticks.map((t) => t.vars[key]);
{
  // 1 / 2: the timers
  const h = HAND10.timer, r = tryIp('timer', () => runHand(h));
  if (r) {
    eq('timer: record keys (a timer is a variable): CD N S2 SAW', Object.keys(r.init.vars).sort(), ['CD', 'N', 'S2', 'SAW']);
    eq('timer: INIT assigns 3 and INIT never counts: after INIT cd = 3, s2 = 3', [r.init.vars.CD, r.init.vars.S2], [3, 3]);
    eq('timer: "the first FRAME already sees n - 1": SAW at tick 1 = 2, then 1, 0, and it stays 0 (it never counts below 0)', seriesOf(r, 'SAW').slice(0, 6), [2, 1, 0, 0, 0, 0]);
    eq('timer: assigned 4 at tick 6: reads 3 at tick 7, 2, 1 and 0 from tick 10 = 6 + 4 on', seriesOf(r, 'SAW').slice(6, 12), [3, 2, 1, 0, 0, 0]);
    eq('timer: a negative value assigned by the game stays (-5 at tick 12; read -5 in ticks 13 and 14)', seriesOf(r, 'SAW').slice(12, 14), [-5, -5]);
    eq('timer: assigned 1 at tick 14 reads 0 in the next FRAME; assigned 0 stays 0', seriesOf(r, 'SAW').slice(14, 17), [0, 0, 0]);
    for (const [k, want] of Object.entries(h.series)) eq(`timer: the whole series of ${k}, ticks 1..${h.ticks}`, seriesOf(r, k), want);
  }
  {
    const h2 = HAND10.timerScenes, r2 = tryIp('timerScenes', () => runHand(h2));
    if (r2) {
      eq('timerScenes: record keys: game level GT N LOG plain, scene level A.TM A.SEENA B.TM B.TB (the same name tm in two scenes)', Object.keys(r2.init.vars).sort(), ['A.SEENA', 'A.TM', 'B.TB', 'B.TM', 'GT', 'LOG', 'N']);
      for (const [k, want] of Object.entries(h2.series)) eq(`timerScenes: series of ${k} (scene timers zeroed on entry, INIT sets them uncounted, they count only in their scene; the game timer counts through both switches)`, seriesOf(r2, k), want);
      eq('timerScenes: the scene index after each tick', r2.ticks.map((t) => t.scene), h2.scene);
      eq('timerScenes: after INIT the first scene\'s timer is 5 (uncounted) and the other scene\'s are 0', [r2.init.vars['A.TM'], r2.init.vars['B.TM'], r2.init.vars['B.TB']], [5, 0, 0]);
    }
  }
  {
    // a game timer assigned in the INIT of the later scene and a timer assigned in a top-level PROC; the timer is also a plain variable (cd = cd + 1)
    const src = TOP + `TIMER gt
DIM n
PROC SETIT(v)
  gt = v
ENDP
SCENE a
  PROC INIT()
  ENDP
  PROC FRAME()
    n = n + 1
    IF n = 2 THEN CALL SETIT(6) : ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  PROC INIT()
    gt = gt + 10
  ENDP
  PROC FRAME()
    n = n + 1
  ENDP
ENDSCENE
`;
    const r = tryIp('timer in PROC / INIT', () => ip(src, 6));
    // tick 2: gt = 6 by SETIT, ENTER b: INIT b adds 10 (INIT never counts) -> 16; tick 3 b's FRAME: 15, 14, 13, 12
    if (r) eq('a timer assigned in a top-level PROC and changed by the next scene\'s INIT: 16 after the switch tick, then one less per tick', seriesOf(r, 'GT'), [0, 16, 15, 14, 13, 12]);
  }
  {
    // a timer that is also an array index / argument is just a number; a timer going past 32767 wraps to a negative (and then stays)
    const src = TOP + `TIMER cd
DIM n, wrapped
SCENE s
  PROC INIT()
  ENDP
  PROC FRAME()
    n = n + 1
    IF n = 1 THEN cd = 32767 ENDIF
    IF n = 3 THEN cd = cd + 1 : wrapped = cd ENDIF
  ENDP
ENDSCENE
`;
    const r = tryIp('timer wrap', () => ip(src, 5));
    // tick 1: 32767 assigned; tick 2: 32766; tick 3: 32765, +1 = 32766; READING: the count is "greater than 0 -> decrement", so 32766 goes on counting down; no wrap involved
    if (r) eq('a big timer just counts down (32767 at tick 1, 32766 at tick 2, +1 in tick 3 gives 32766, then 32765, 32764)', seriesOf(r, 'CD'), [32767, 32766, 32766, 32765, 32764]);
  }
}
{
  // 5 / 6: KEYPRESS and JOYPRESS
  const h = HAND10.keypress, r = tryIp('keypress', () => runHand(h));
  if (r) {
    eq('keypress: record keys (the edge state is hidden: no new fields, no new keys)', Object.keys(r.init.vars).sort(), ['B.BINIT', 'B.BP', 'I0', 'N', 'P', 'PRESSES', 'Q', 'SUM2']);
    eq('keypress: INIT at boot sees 0 even though the key is held from boot (nothing has been read)', r.init.vars.I0, 0);
    eq('keypress: held from boot is a press in tick 1; a key held for two ticks gives ONE edge', seriesOf(r, 'P').slice(0, 3), [1, 0, 0]);
    for (const [k, want] of Object.entries(h.series)) eq(`keypress: series of ${k}`, seriesOf(r, k), want);
    eq('keypress: the scene index after each tick (a -> b at tick 3, b -> a at 5, a -> b at 8)', r.ticks.map((t) => t.scene), h.scene);
    check_('keypress: "O", 79 and "o" are one key and the value is the same however often it is read in the tick (SUM2 = 2 on a press tick)', r.ticks[0].vars.SUM2 === 2 && r.ticks[0].vars.P === r.ticks[0].vars.Q);
  }
  const hj = HAND10.joypress, rj = tryIp('joypress', () => runHand(hj));
  if (rj) {
    eq('joypress: edges of the model for stick 1 equal the hand-worked list', edgeModel([16, 24, 8, 0, 17, 4, 20, 0, 0, 16]), [16, 8, 0, 0, 17, 4, 16, 0, 0, 16]);
    for (const [k, want] of Object.entries(hj.series)) eq(`joypress: series of ${k} (bits that went down: STICK(n) AND NOT the previous tick's value; the two sticks are independent)`, seriesOf(rj, k), want);
  }
  const hs = HAND10.switchEdge, rs = tryIp('switchEdge', () => runHand(hs));
  if (rs) {
    for (const [k, want] of Object.entries(hs.series)) eq(`switchEdge: series of ${k} (INIT of the new scene sees the edge of the switching tick; ENTER does not touch the edge state)`, seriesOf(rs, k), want);
    eq('switchEdge: the scene index after each tick', rs.ticks.map((t) => t.scene), hs.scene);
  }
  {
    // an unknown key is never held: KEYPRESS(45) is always 0 whatever the key function says (the same as KEYDOWN)
    const src = classic('DIM x', '  x = x + KEYPRESS(45) + KEYPRESS("A")\n', '', 'GAME "t"\nFRAMERATE 12\n');
    const r = tryIp('unknown key', () => ip(src, 4, { keys: () => true }));
    if (r) eq('KEYPRESS of an unknown key adds nothing; KEYPRESS("A") with the key held from boot adds 1 once (tick 1)', seriesOf(r, 'X'), [1, 1, 1, 1]);
  }
  {
    // a key function that holds a key exactly at ticks 2 and 4 (one tick apart): two edges; the same program with the array form of opts.keys
    const src = classic('DIM c', '  c = c + KEYPRESS("A")\n', '', 'GAME "t"\nFRAMERATE 12\n');
    const r = tryIp('keys as arrays', () => ip(src, 5, { keys: [[], [65], [], [65], [65]] }));
    if (r) eq('opts.keys as an array of held codes per tick: edges at ticks 2 and 4 (tick 5 is a hold)', seriesOf(r, 'C'), [0, 1, 1, 2, 2]);
  }
}
{
  // USING: the cells of the hand program (run-time values, literals, expression items, overflow, -32768, wrap)
  const h = HAND10.using, r = tryIp('using', () => runHand(h));
  if (r) {
    for (const [row, want] of h.rows) eq(`using: row ${row} of the screen reads "${want.trim()}"`, rowText(r.ticks[0], row), want);
    check_('using: the same on every tick (FRAME draws the same rows)', h.rows.every(([row, want]) => rowText(r.ticks[2], row) === want));
    // wrapping through the cursor: the third character of "007" at (7, 30) lands at (8, 0) (eager wrap, no scrolling)
    eq('using: a field that runs over the right edge continues on the next row ("007" at column 30: 0 0 then 7 on the next row)', [rowText(r.ticks[0], 7).slice(30), rowText(r.ticks[0], 8)], ['00', '7']);
  }
  const hh = HAND10.hud, rh = tryIp('hud', () => runHand(hh));
  if (rh) {
    for (const [k, row, want] of hh.rowsAt) eq(`hud: tick ${k} row ${row}: the countdown and the tick counter as USING fields`, rowText(rh.ticks[k - 1], row), want);
    for (const [k, v] of hh.vis) eq(`hud: tick ${k}: the ship is ${v ? 'shown' : 'not shown'} (cd = ${v ? 0 : '> 0'})`, !!rh.ticks[k - 1].sprites[0].visible, v);
    for (const [k, want] of Object.entries(hh.series)) eq(`hud: series of ${k}`, seriesOf(rh, k), want);
  }
}
{
  // 15: PLAY by index
  const h = HAND10.playidx, r = tryIp('playidx', () => runHand(h));
  if (r) {
    eq('playidx: K and SNDA series (the variable named like an effect is an ordinary variable)', [seriesOf(r, 'K'), seriesOf(r, 'SNDA')], [h.series.K, h.series.SNDA]);
    eq('playidx: the effect index after each tick (PLAY 1 -> 1, PLAY (0) -> 0, PLAY snda -> the EFFECT 0, out-of-range values change nothing, PLAY k - 18 -> 0)', r.ticks.map((t) => t.sfx.index), h.sfxIndex);
    check_('playidx: an out-of-range index does not stop what plays: ticks 14 (-1) and 16 (257) the long effect is still active', r.ticks[13].sfx.active && r.ticks[15].sfx.active, `${r.ticks[13].sfx.active} ${r.ticks[15].sfx.active}`);
    check_('playidx: PLAY (7) at tick 12 with nothing playing starts nothing', !r.ticks[11].sfx.active);
    check_('playidx: SILENCE at tick 4 stops the long effect', r.ticks[2].sfx.active && !r.ticks[3].sfx.active);
  }
  {
    // an index that is a value 256 or more, negative, or past the last effect does nothing (the low byte must not be used: 257 is not 1)
    const mk = (v) => classic('DIM n', `  n = ${v}\n  PLAY n\n`, '', 'GAME "t"\nFRAMERATE 12\nSFX snda = "short"\nSFX sndb = "long"\n');
    for (const [v, play] of [[0, true], [1, true], [2, false], [255, false], [256, false], [257, false], [-1, false], [-32768, false], [32767, false], [65536 - 255, false]]) {
      const r2 = tryIp(`index ${v}`, () => ip(mk(v), 1));
      if (r2) check_(`PLAY n with n = ${v} ${play ? 'starts effect ' + v : 'does nothing'}`, play ? (r2.ticks[0].sfx.active && r2.ticks[0].sfx.index === v) : !r2.ticks[0].sfx.active, JSON.stringify(r2.ticks[0].sfx));
    }
    // opts.clock numbers the CALLS of RT_PLAY (and SILENCE): an index 0..255 past the table is a call that does nothing but still counts; outside 0..255 is no call (m10c mutation run:
    // "interp: PLAY past the table not counted"). The program plays 5 (past the table, a call), 300 (no call), then effect 1: the effect's start must be asked for as call number 2.
    {
      const asked = [];
      const clock = { play: (tick, n) => { asked.push(n); return 100 * n; }, sample: () => 0 };
      const src = classic('DIM n', '  n = 5\n  PLAY n\n  n = 300\n  PLAY n\n  PLAY 1\n', '', 'GAME "t"\nFRAMERATE 12\nSFX snda = "short"\nSFX sndb = "long"\n');
      const r3 = tryIp('clock numbering', () => interpret(parse(src).ast, { version: 2, ticks: 1, assets: ASSETS, clock }));
      if (r3) eq('with a clock, PLAY of an index past the table counts as call 1, PLAY 300 is no call, PLAY 1 is call 2 (the clock is asked for start number 2 only)', asked, [2]);
    }
  }
}

// =================================================================================================================
// 3. fmtUsing against the independent model of contract item 12
// =================================================================================================================
console.log('\n3. fmtUsing (exported by arcade-interp.js) against an independent model of item 12');
{
  const f = INTERP.fmtUsing;
  if (typeof f !== 'function') check_('arcade-interp.js exports fmtUsing(value, pattern)', false, `typeof ${typeof f}`);
  else {
    check_('arcade-interp.js exports fmtUsing(value, pattern)', true);
    const ex = [
      ['0000', 7, '0007'], ['0000', -5, '-005'], ['0000', 12345, '****'], ['####', 7, '   7'], ['####', -5, '  -5'], ['##00', 7, '  07'], ['##00', -7, ' -07'], ['#', 0, '0'], ['#', 10, '*'],
      ['######', -32768, '-32768'], ['#####', -32768, '*****'], ['########', -32768, '  -32768'], ['0', 0, '0'], ['0', 7, '7'], ['0', -7, '*'], ['00000000', 32767, '00032767'], ['00000000', -32768, '-0032768'],
      ['###', 999, '999'], ['###', 1000, '***'], ['###', -99, '-99'.padStart(3)], ['###', -100, '***'], ['0#', 5, '05'], ['0#', -5, '-5'], ['#0#0', 7, ' 007'], ['#0#0', -7, '-007'], ['0000', -1234, '****'], ['0000', -123, '-123'], ['00', -5, '-5'], ['00', -50, '**'], ['000', -5, '-05']
    ];
    // "#0#0": z = 3 (from the leftmost 0 to the right end), w = 4: -7 -> digits "007" -> "-007" (4 characters, fits). "0000" -5 is the contract's own example ("-005": the sign takes the first 0 position)
    let bad = '';
    for (const [pat, v, want] of ex) { const got = f(v, pat); if (got !== want) bad += `fmtUsing(${v}, "${pat}") = "${got}", want "${want}"; `; }
    check_(`the ${ex.length} worked examples (the contract's and their neighbours) are exact`, bad === '', bad);
    check_('the examples are consistent with the model', ex.every(([pat, v, want]) => modelUsing(v, pat) === want), ex.filter(([pat, v, want]) => modelUsing(v, pat) !== want).join(' / '));
    let nBad = 0, first = '';
    const t0 = Date.now();
    for (const pat of USING_PATTERNS) {
      let badP = 0;
      for (let v = -32768; v <= 32767; v++) {
        const got = f(v, pat), want = modelUsing(v, pat);
        if (got !== want) { badP++; if (!first) first = `fmtUsing(${v}, "${pat}") = "${got}", model "${want}"`; }
      }
      nBad += badP;
      check_(`pattern "${pat}": all 65,536 values equal the model`, badP === 0, badP ? `${badP} differ; first: ${first}` : '');
    }
    info(`8 x 65,536 values checked in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
    let wBad = 0;
    for (const pat of USING_PATTERNS) for (let v = -32768; v <= 32767; v += 7) if (f(v, pat).length !== pat.length) wBad++;
    check_('every field is exactly as wide as its pattern (the layout never moves)', wBad === 0, `${wBad}`);
    // other patterns: every pattern of 1..4 characters over {#, 0}
    let all = 0, allBad = '';
    for (let len = 1; len <= 4; len++) for (let bits = 0; bits < (1 << len); bits++) {
      const pat = Array.from({ length: len }, (_, i) => ((bits >> i) & 1 ? '0' : '#')).join('');
      for (const v of [-32768, -12345, -1000, -100, -10, -9, -1, 0, 1, 9, 10, 99, 100, 999, 1000, 9999, 10000, 32767]) { all++; if (f(v, pat) !== modelUsing(v, pat)) allBad = `fmtUsing(${v}, "${pat}") = "${f(v, pat)}", model "${modelUsing(v, pat)}"`; }
    }
    check_(`every pattern of 1 to 4 characters over # and 0 (${all} samples) equals the model`, allBad === '', allBad);
    // an 8-character pattern of every kind of shape
    const shapes = ['########', '00000000', '0#######', '#######0', '#0#0#0#0', '0#0#0#0#', '##0#0##0', '0000####'];
    let sBad = '';
    for (const pat of shapes) for (let v = -32768; v <= 32767; v += 13) if (f(v, pat) !== modelUsing(v, pat)) sBad = `fmtUsing(${v}, "${pat}") = "${f(v, pat)}"`;
    check_('eight-character patterns of mixed shape (every 13th value) equal the model', sBad === '', sBad);
  }
}

// =================================================================================================================
// 4. The image on the real v2 runtime
// =================================================================================================================
console.log('\n4. Code generation on the real v2 runtime: headers, the tick prologue, symbols.keys, lib$fmt, PLAY by index');
if (!RT2) skip_('image checks', 'arcade/build/v2/runtime.json does not exist (node arcade/tools/build-runtime-v2.mjs)');
else {
  const C = RT2.rt.constants, S = RT2.rt.symbols;
  const rd16 = (m, a) => m[a] | (m[a + 1] << 8);
  const build = (src) => { const r = cmp(src, RT2); if (r.errors.length) throw new Error(errText(r)); return r; };
  const code = (r) => r.memory.slice(r.gen.base, r.gen.base + r.gen.code.length);
  const hdr = (r) => ({ init: rd16(r.memory, C.GAME_BASE), frame: rd16(r.memory, C.GAME_BASE + 2) });
  const keysym = (r) => r.gen?.symbols?.keys ?? r.map?.keys ?? r.map?.symbols?.keys ?? null;
  const w = (a) => [a & 255, a >> 8];
  const find = (c, bytes, from = 0, to = c.length) => { for (let i = from; i <= Math.min(c.length - bytes.length, to - bytes.length); i++) if (bytes.every((b, k) => c[i + k] === b)) return i; return -1; };
  const count = (c, bytes) => { let n = 0; for (let i = 0; i <= c.length - bytes.length; i++) if (bytes.every((b, k) => c[i + k] === b)) n++; return n; };
  const BASE = 'GAME "n"\nFRAMERATE 30\nSPRITE ship = "orb"\nSFX snda = "short"\nSFX sndb = "long"\n';
  const cl = (decl, frame, init = '') => classic(decl, frame, init, BASE);
  const clen = (src) => { try { return build(src).gen.code.length; } catch (e) { return NaN; } };

  // -- without the new words: unchanged header entries
  {
    const r = build(cl('DIM x', '  x = x + 1\n  PRINT AT 0, 0; x\n'));
    check_('a game without the new words: the header\'s frame entry IS PROC FRAME (entries.frame = P$FRAME), no keys symbols', hdr(r).frame === r.map.entries.frame && r.map.entries.frame === r.map.procs.FRAME && !keysym(r), `${hdr(r).frame.toString(16)} ${r.map.entries.frame.toString(16)} ${r.map.procs.FRAME?.toString(16)}`);
    const k = build(cl('DIM x', '  IF KEYDOWN("Q") THEN x = STICK(1) ENDIF\n  PLAY snda\n'));
    check_('... also with KEYDOWN, STICK and PLAY by name (the old words)', hdr(k).frame === k.map.procs.FRAME && k.map.entries.frame === k.map.procs.FRAME && !keysym(k));
    check_('... and it calls neither RT_KEYDOWN beyond KEYDOWN\'s own single call nor RT_STICK more than once', count(code(k), [0xCD, ...w(S.RT_KEYDOWN)]) === 1 && count(code(k), [0xCD, ...w(S.RT_STICK)]) === 1);
    const sc = build(TOP + scene('a', { decl: 'DIM x', frame: '    x = x + 1' }));
    check_('a one-scene game without ENTER and without the words: no driver, the frame entry is PROC FRAME', hdr(sc).frame === sc.map.procs.FRAME);
  }
  // -- a single game-level timer: the stub
  // READING: item 8 sketches the step as LD HL,(slot) / LD A,H / OR L / JR Z / DEC HL / LD (slot),HL, which would also count a NEGATIVE value down; item 1 says a value of 0 or below is left alone.
  // The semantics (item 1) win, so the test does not pin the step's exact bytes: it looks for the load of the slot (LD HL,(slot) = 2A nn nn) followed by the store back (LD (slot),HL = 22 nn nn)
  // within 20 bytes, and measures the step's size from the distance between consecutive steps.
  const stepAt = (c, slot, from, to) => { for (let i = from; i < Math.min(to, c.length - 3); i++) if (c[i] === 0x2A && rd16(c, i + 1) === slot) { for (let j = i + 3; j < Math.min(i + 24, c.length - 2); j++) if (c[j] === 0x22 && rd16(c, j + 1) === slot) return i; } return -1; };
  {
    const r = build(cl('TIMER cd\nDIM x', '  x = cd\n  cd = 5\n'));
    const c = code(r), fe = r.map.entries.frame - r.gen.base, slot = r.map.vars.CD;
    check_('a TIMER: the header\'s frame entry is the stub frame$entry, not PROC FRAME', hdr(r).frame === r.map.entries.frame && r.map.entries.frame !== r.map.procs.FRAME, `${r.map.entries.frame.toString(16)} vs FRAME ${r.map.procs.FRAME?.toString(16)}`);
    check_('the stub starts with the timer step: LD HL,(slot) (2A nn nn) ... LD (slot),HL (22 nn nn) within 24 bytes', c[fe] === 0x2A && rd16(c, fe + 1) === slot && stepAt(c, slot, fe, fe + 1) === fe, `got ${Array.from(c.slice(fe, fe + 12), (b) => b.toString(16)).join(' ')}`);
    info(`the step of one timer in this build: ${Array.from(c.slice(fe, fe + 14), (b) => b.toString(16)).join(' ')} ...`);
    check_('... and the stub ends by running PROC FRAME: a JP (C3) to it within 40 bytes, or a fall-through into it', find(c, [0xC3, ...w(r.map.procs.FRAME)], fe, fe + 40) >= 0 || (r.map.procs.FRAME > r.map.entries.frame && r.map.procs.FRAME - r.map.entries.frame < 40), `FRAME at +${r.map.procs.FRAME - r.map.entries.frame}`);
    check_('a game without keys has no extra RT_KEYDOWN / RT_STICK call', count(c, [0xCD, ...w(S.RT_KEYDOWN)]) === 0 && count(c, [0xCD, ...w(S.RT_STICK)]) === 0);
  }
  // -- three timers, in the order of declaration; sizes
  {
    const names = ['t1', 't2', 't3'];
    const use = (extra) => '  x = t1 + t2 + t3\n' + extra;
    const r3 = build(cl('TIMER t1, t2, t3\nDIM x', use('')));
    const c = code(r3), fe = r3.map.entries.frame - r3.gen.base;
    const slots = names.map((n) => r3.map.vars[n.toUpperCase()]);
    const at3 = slots.map((sl) => stepAt(c, sl, fe, fe + 120));
    check_('three timers: one step per slot in the stub (each LD HL,(slot) ... LD (slot),HL), in the order of declaration, back to back from the start of the stub', at3.every((i) => i >= 0) && at3[0] === fe && at3[0] < at3[1] && at3[1] < at3[2], `steps at +${at3.map((i) => i - fe)}`);
    const stepLen = at3[1] - at3[0];
    const d0 = clen(cl('DIM t1, t2, t3, x', use(''))), d1 = clen(cl('TIMER t1\nDIM t2, t3, x', use(''))), d3 = clen(cl('TIMER t1, t2, t3\nDIM x', use('')));
    info(`tick prologue bytes: 0 timers 0 (${d0} bytes of code in all), 1 timer ${d1 - d0} bytes (one ${stepLen}-byte step + the stub's jump), 3 timers ${d3 - d0} bytes`);
    check_('each further timer costs exactly one step (the distance between two consecutive steps)', d3 - d1 === 2 * stepLen && at3[2] - at3[1] === stepLen, `1 timer +${d1 - d0}, 3 timers +${d3 - d0}, step ${stepLen}`);
    check_('the first timer costs its step plus the stub (step + 0..6 bytes)', d1 - d0 >= stepLen && d1 - d0 <= stepLen + 6, `${d1 - d0} vs step ${stepLen}`);
    check_('a step is small: 11 to 20 bytes (the contract\'s sketch is 11)', stepLen >= 11 && stepLen <= 20, `${stepLen}`);
  }
  // -- a TIMER declared inside the ONE scene of a game (no driver): counted in the stub, like a game-level one (added by the m10c mutation run: "stub: scene timers not counted (one scene)")
  {
    const r = build(TOP + scene('a', { decl: 'TIMER tm\nDIM x', frame: '    x = tm\n    tm = 5' }));
    const c = code(r), fe = r.map.entries.frame - r.gen.base, slot = r.map.vars['A.TM'] ?? r.map.vars.TM;
    check_('a one-scene game with a scene-level TIMER: its slot is known and the frame entry is the stub, not PROC FRAME', Number.isInteger(slot) && r.map.entries.frame !== r.map.procs.FRAME, `slot ${slot}`);
    check_('... and the stub counts it: the step (LD HL,(slot) ... LD (slot),HL) is the first thing at the frame entry', stepAt(c, slot, fe, fe + 1) === fe, `got ${Array.from(c.slice(fe, fe + 12), (b) => b.toString(16)).join(' ')}`);
    const g = build(TOP + 'TIMER gt\n' + scene('a', { decl: 'TIMER tm\nDIM x', frame: '    x = tm + gt\n    tm = 5\n    gt = 5' }));
    const gc = code(g), gfe = g.map.entries.frame - g.gen.base;
    check_('a game timer and a scene timer in one scene: two steps, the game timer\'s first, then the scene timer\'s, both before the jump to PROC FRAME', stepAt(gc, g.map.vars.GT, gfe, gfe + 1) === gfe && stepAt(gc, g.map.vars['A.TM'] ?? g.map.vars.TM, gfe + 10, gfe + 60) > gfe, `step at +${stepAt(gc, g.map.vars['A.TM'] ?? g.map.vars.TM, gfe + 10, gfe + 60) - gfe}`);
  }
  // -- KEYPRESS / JOYPRESS: the snapshot, symbols.keys
  {
    const r = build(cl('DIM x', '  x = KEYPRESS("O") + KEYPRESS(79) + KEYPRESS("o")\n  IF KEYPRESS("P") THEN x = 0 ENDIF\n'));
    const c = code(r), fe = r.map.entries.frame - r.gen.base, sym = keysym(r);
    check_('KEYPRESS: the frame entry is the stub; symbols.keys.press has one entry per DISTINCT key (79 and 80) with before / edge addresses', r.map.entries.frame !== r.map.procs.FRAME && !!sym?.press && Object.keys(sym.press).sort().join() === '79,80' && Object.values(sym.press).every((e) => Number.isInteger(e.before) && Number.isInteger(e.edge) && e.before !== e.edge), JSON.stringify(sym));
    if (sym?.press) {
      const addrs = Object.values(sym.press).flatMap((e) => [e.before, e.edge]);
      check_('... the four words are distinct and lie in the game\'s variable area, outside the named variables', new Set(addrs).size === 4 && addrs.every((a) => a >= C.GAME_VARS_BASE && a + 1 <= C.GAME_VARS_LIMIT && a !== r.map.vars.X), addrs.map((a) => a.toString(16)).join());
      check_('... one RT_KEYDOWN call per key in all: "O" used three times still reads the key once (2 calls for 2 keys)', count(c, [0xCD, ...w(S.RT_KEYDOWN)]) === 2, `${count(c, [0xCD, ...w(S.RT_KEYDOWN)])} calls`);
      for (const code_ of [79, 80]) check_(`the stub reads key ${code_}: LD A,${code_} / CALL RT_KEYDOWN (3E ${code_.toString(16)} CD nn nn)`, find(c, [0x3E, code_, 0xCD, ...w(S.RT_KEYDOWN)], fe, fe + 200) >= 0);
      check_('KEYPRESS(c) is LD HL,(edge) (2A nn nn) in PROC FRAME', Object.values(sym.press).every((e) => count(c, [0x2A, ...w(e.edge)]) >= 1));
      check_('the stub\'s two snapshots store before = now (LD (before),HL / LD (before),A... : some store to each "before" word)', Object.values(sym.press).every((e) => find(c, w(e.before), fe, fe + 200) >= 0), 'no reference to a before word in the stub');
    }
    const one = build(cl('DIM x', '  x = KEYPRESS("O")\n'));
    check_('a game with KEYPRESS only reads no stick: no RT_STICK call', count(code(one), [0xCD, ...w(S.RT_STICK)]) === 0);
    const j = build(cl('DIM x', '  x = JOYPRESS(1) + BIT(JOYPRESS(1), 4) + JOYPRESS(2)\n')), jc = code(j), jfe = j.map.entries.frame - j.gen.base, js = keysym(j);
    check_('JOYPRESS: symbols.keys.joy has "1" and "2" (before, edge); no press entries', !!js?.joy && Object.keys(js.joy).sort().join() === '1,2' && (!js.press || Object.keys(js.press).length === 0) && Object.values(js.joy).every((e) => Number.isInteger(e.before) && Number.isInteger(e.edge)), JSON.stringify(js));
    check_('... the stub reads each stick once: LD A,n / CALL RT_STICK for n = 1 and 2, two RT_STICK calls in all', count(jc, [0xCD, ...w(S.RT_STICK)]) === 2 && [1, 2].every((n) => find(jc, [0x3E, n, 0xCD, ...w(S.RT_STICK)], jfe, jfe + 200) >= 0), `${count(jc, [0xCD, ...w(S.RT_STICK)])}`);
    check_('... and no RT_KEYDOWN call', count(jc, [0xCD, ...w(S.RT_KEYDOWN)]) === 0);
    // order inside the prologue: game timers, then the snapshots
    const m = build(cl('TIMER cd\nDIM x', '  x = cd + KEYPRESS("O") + JOYPRESS(1)\n')), mc = code(m), mfe = m.map.entries.frame - m.gen.base;
    const stAt = stepAt(mc, m.map.vars.CD, mfe, mfe + 60), kAt = find(mc, [0xCD, ...w(S.RT_KEYDOWN)], mfe, mfe + 200);
    check_('order of the prologue: the timer step comes first, then the key snapshot', stAt === mfe && kAt > stAt, `step at +${stAt - mfe}, RT_KEYDOWN at +${kAt - mfe}`);
    // sizes
    const x0 = clen(cl('DIM x', '  x = 0\n')), k1 = clen(cl('DIM x', '  x = KEYPRESS("O")\n')), k2 = clen(cl('DIM x', '  x = KEYPRESS("O") + KEYPRESS("P")\n')), k3 = clen(cl('DIM x', '  x = KEYPRESS("O") + KEYPRESS("P") + KEYPRESS("Q")\n'));
    info(`code bytes of a one-statement game: ${x0}; with 1 KEYPRESS ${k1}, 2 keys ${k2}, 3 keys ${k3}: the prologue costs (reads and the stub) about ${k1 - x0} bytes for 1 key, ${k3 - x0} for 3`);
    check_('keys cost the same each (the prologue is linear in the keys named), and each key adds a snapshot of at least LD A,code + CALL (5 bytes)', k3 - k2 === k2 - k1 && k2 - k1 >= 5, `${k1} ${k2} ${k3}`);
    const j1 = clen(cl('DIM x', '  x = JOYPRESS(1)\n')), j2 = clen(cl('DIM x', '  x = JOYPRESS(1) + JOYPRESS(2)\n'));
    info(`one stick ${j1 - x0} bytes, two sticks ${j2 - x0} bytes`);
    check_('a second stick adds a snapshot too (> 5 bytes)', j2 - j1 >= 5, `${j1} ${j2}`);
  }
  // -- scenes with a driver: the prologue goes in after the stack pointer is saved; scene timers just before the scene's FRAME
  {
    const src = TOP + 'TIMER gt\n' + scene('a', { decl: 'TIMER tm\nDIM v', frame: '    v = gt + tm + KEYPRESS("O")\n    ENTER b' }) + scene('b', { decl: 'TIMER tb', frame: '    ENTER a' });
    const r = build(src), c = code(r), fe = r.map.entries.frame - r.gen.base;
    check_('scenes + TIMER: the stub is frame$entry: LD (scn$sp),SP first (ED 73 nn nn), then the game timer step (LD HL,(gt) at +4)', c[fe] === 0xED && c[fe + 1] === 0x73 && c[fe + 4] === 0x2A && rd16(c, fe + 5) === r.map.vars.GT && stepAt(c, r.map.vars.GT, fe, fe + 8) === fe + 4, `got ${Array.from(c.slice(fe, fe + 12), (b) => b.toString(16)).join(' ')}`);
    const kAt = find(c, [0xCD, ...w(S.RT_KEYDOWN)], fe, fe + 300);
    check_('... then the key snapshot (RT_KEYDOWN) after the game timers', kAt > fe + 4, `${kAt - fe}`);
    const a = stepAt(c, r.map.vars['A.TM'], fe, fe + 400), b = stepAt(c, r.map.vars['B.TB'], fe, fe + 400);
    check_('each scene timer has its own step (A.TM and B.TB), after the key snapshot (per scene, "just before its FRAME")', a > kAt && b > kAt, `A.TM step at +${a - fe}, B.TB step at +${b - fe}, key at +${kAt - fe}`);
    let nGt = 0; for (let i = fe; i < fe + 400; i++) if (c[i] === 0x2A && rd16(c, i + 1) === r.map.vars.GT && stepAt(c, r.map.vars.GT, i, i + 1) === i) nGt++;
    check_('the game timer has exactly one step in the stub region (not one per scene)', nGt === 1, `${nGt}`);
    const sy = r.gen.symbols.scene ?? r.map.scene ?? r.map.symbols?.scene;
    check_('the scene driver is still there (symbols.scene) and map keys are SCENE.NAME for the scene timers', !!sy && r.map.vars['A.TM'] !== undefined && r.map.vars['B.TB'] !== undefined && r.map.vars.GT !== undefined);
  }
  // -- USING: folded at build time, lib$fmt at run time
  {
    const noFmt = build(cl('DIM x', '  PRINT AT 0, 0; "a005b"\n  x = 1\n'));
    const folded = build(cl('DIM x', '  PRINT AT 0, 0; "a"; 5 USING "000"; "b"\n  x = 1\n'));
    check_('a literal item with USING is formatted at build time and joins the neighbouring text: the image equals the one for PRINT "a005b"', sameBytes(noFmt.memory, folded.memory), `code ${noFmt.gen.code.length} vs ${folded.gen.code.length}`);
    const cnst = build(cl('CONST K = 7\nDIM x', '  PRINT AT 0, 0; "a"; K USING "000"; "b"\n  x = 1\n')), cexp = build(cl('CONST K = 7\nDIM x', '  PRINT AT 0, 0; "a007b"\n  x = 1\n'));
    check_('a CONST item folds too (CONST K = 7; K USING "000" is "007")', sameBytes(cnst.memory, cexp.memory), `${cnst.gen.code.length} vs ${cexp.gen.code.length}`);
    const expr = build(cl('DIM x', '  PRINT AT 0, 0; (3 + 4) USING "000"; "!"\n  x = 1\n')), eexp = build(cl('DIM x', '  PRINT AT 0, 0; "007!"\n  x = 1\n'));
    check_('a constant expression folds ((3 + 4) USING "000")', sameBytes(expr.memory, eexp.memory), `${expr.gen.code.length} vs ${eexp.gen.code.length}`);
    const neg = build(cl('DIM x', '  PRINT AT 0, 0; -5 USING "0000"; 12345 USING "####"; -32768 USING "########"\n  x = 1\n')), nexp = build(cl('DIM x', '  PRINT AT 0, 0; "-005****  -32768"\n  x = 1\n'));
    check_('folded overflow and -32768: "-005", "****", "  -32768"', sameBytes(neg.memory, nexp.memory), `${neg.gen.code.length} vs ${nexp.gen.code.length}`);
    const none = clen(cl('DIM x', '  PRINT AT 0, 0; x\n  PRINT AT 1, 0; x\n')), one = clen(cl('DIM x', '  PRINT AT 0, 0; x USING "000"\n  PRINT AT 1, 0; x\n')), two = clen(cl('DIM x', '  PRINT AT 0, 0; x USING "000"\n  PRINT AT 1, 0; x USING "00"\n')), three = clen(cl('DIM x', '  PRINT AT 0, 0; x USING "000"\n  PRINT AT 1, 0; x USING "00"\n  PRINT AT 2, 0; x USING "#"\n'));
    info(`PRINT of a run-time value: without USING ${none} bytes of code in all, one USING item ${one} (lib$fmt about ${one - none} bytes with its call), two ${two}, three ${three}`);
    check_('a run-time USING item adds lib$fmt, a routine of a few hundred bytes at most (30..220 with its call; 182 when the digit chain, the sign rule, the stars and the zero fill were all in)', one - none >= 30 && one - none <= 220, `${one - none}`);
    check_('a second and a third use call the SAME routine (each adds well under 30 bytes)', two - one < 30 && three - two < 30 && two - one > 0, `${two - one} ${three - two}`);
    const fold = clen(cl('DIM x', '  PRINT AT 0, 0; 5 USING "000"\n  PRINT AT 1, 0; x\n'));
    check_('a game whose only USING items are constants has no lib$fmt (its code is no bigger than the plain-text version\'s)', fold <= none + 6, `${fold} vs ${none}`);
    const rt = build(cl('DIM x', '  PRINT AT 0, 0; x USING "00"\n')), rc = code(rt);
    check_('a run-time item calls a routine of the game image: a CALL to an address inside the game code that is not RT_PRINTC', (() => { for (let i = 0; i < rc.length - 2; i++) if (rc[i] === 0xCD) { const a = rd16(rc, i + 1); if (a >= rt.gen.base && a < rt.gen.base + rc.length) return true; } return false; })());
    check_('... and lib$fmt prints with RT_PRINTC (the code calls RT_PRINTC)', count(rc, [0xCD, ...w(S.RT_PRINTC)]) >= 1);
  }
  // -- PLAY by index
  {
    const r = build(cl('DIM x', '  PLAY x\n')), c = code(r);
    check_('PLAY x: LD A,H / OR A / JR NZ,+4 / LD A,L / CALL RT_PLAY (7C B7 20 04 7D CD nn nn) after the expression', find(c, [0x7C, 0xB7, 0x20, 0x04, 0x7D, 0xCD, ...w(S.RT_PLAY)]) >= 0);
    const e = build(cl('DIM x', '  PLAY (x + 1)\n  PLAY x MOD 2\n')), ec = code(e);
    check_('PLAY (expression) and PLAY x MOD 2 use the same sequence (two copies)', count(ec, [0x7C, 0xB7, 0x20, 0x04, 0x7D, 0xCD, ...w(S.RT_PLAY)]) === 2, `${count(ec, [0x7C, 0xB7, 0x20, 0x04, 0x7D, 0xCD, ...w(S.RT_PLAY)])}`);
    const n = build(cl('DIM x', '  PLAY sndb\n')), nc = code(n);
    check_('PLAY by name (an effect): no range-check sequence', find(nc, [0x7C, 0xB7, 0x20, 0x04, 0x7D, 0xCD, ...w(S.RT_PLAY)]) < 0 && count(nc, [0xCD, ...w(S.RT_PLAY)]) === 1);
    const lit = build(cl('DIM x', '  PLAY 1\n')), lc = code(lit);
    check_('PLAY with a literal index in range plays (a CALL RT_PLAY is generated)', count(lc, [0xCD, ...w(S.RT_PLAY)]) >= 1);
    const par = build(cl('DIM snda\nDIM y', '  snda = y\n  PLAY (snda)\n  PLAY snda\n')), pc = code(par);
    // a folded index outside 0..255 that the checker does not fold (a sum of literals) plays nothing: no RT_PLAY call at all ("PLAY: constant 256 still calls", m10c mutation run)
    for (const expr of ['100 + 156', '200 + 100', '0 - 1']) {
      const o = cmp(cl('DIM x', `  PLAY ${expr}\n  x = 1\n`), RT2);
      if (o.errors.length) { check_(`PLAY ${expr}: compiles (the checker does not fold a sum of literals)`, false, errText(o)); continue; }
      check_(`PLAY ${expr} (a constant outside 0..255): no RT_PLAY call at all`, count(code(o), [0xCD, ...w(S.RT_PLAY)]) === 0, `${count(code(o), [0xCD, ...w(S.RT_PLAY)])} calls`);
    }
    const inR = cmp(cl('DIM x', '  PLAY 100 + 55\n  x = 1\n'), RT2);
    check_('PLAY 100 + 55 (= 155, in 0..255 though past the table): the call is generated, the runtime ignores the index', !inR.errors.length && count(code(inR), [0xCD, ...w(S.RT_PLAY)]) === 1, inR.errors.length ? errText(inR) : '');
    check_('PLAY (snda) with a variable snda is the index form; PLAY snda is the effect: one range-check sequence and two RT_PLAY calls', count(pc, [0x7C, 0xB7, 0x20, 0x04, 0x7D, 0xCD, ...w(S.RT_PLAY)]) === 1 && count(pc, [0xCD, ...w(S.RT_PLAY)]) === 2, `${count(pc, [0x7C, 0xB7, 0x20, 0x04, 0x7D, 0xCD, ...w(S.RT_PLAY)])} / ${count(pc, [0xCD, ...w(S.RT_PLAY)])}`);
  }
}

// =================================================================================================================
// 5. Everything the differential suite runs compiles
// =================================================================================================================
console.log('\n5. The generated and hand-written programs compile');
{
  const N = QUICK ? 60 : 300;
  if (!RT2) skip_('compiling the generated programs', 'no v2 runtime');
  else {
    let bad = 0, why = '', keyBad = 0, kwhy = '';
    const use = { timer: 0, keypress: 0, joypress: 0, using: 0, playIdx: 0, playParen: 0, scenes: 0 };
    for (let s = 1; s <= N; s++) {
      const g = genProgram10(s);
      const e = errs(g.src, 2), r = cmp(g.src, RT2);
      if (e.length || r.errors.length) { bad++; why ||= `seed ${s}: ${msgs(e) || errText(r)}`; continue; }
      if (/\bTIMER\b/.test(g.src)) use.timer++;
      if (/KEYPRESS\(/.test(g.src)) use.keypress++;
      if (/JOYPRESS\(/.test(g.src)) use.joypress++;
      if (/ USING "/.test(g.src)) use.using++;
      if (/PLAY \(snda\)/.test(g.src)) use.playParen++;
      if (/PLAY (BAND|\d|g3|u|t)/.test(g.src)) use.playIdx++;
      use.scenes += g.scenes.length;
      const kk = sceneKeys(g.src, parse);
      if (Object.keys(r.map.vars).length !== kk.vars.length) { keyBad++; kwhy ||= `seed ${s}: ${Object.keys(r.map.vars).length} vars, sceneKeys ${kk.vars.length}`; }
    }
    check_(`${N} generated programs of 2 to 4 scenes with timers, key edges, USING and PLAY by index parse, check and compile on the v2 runtime`, bad === 0, `${bad} failed; ${why}`);
    check_('... and map.vars holds the contract keys for every one (timers are variables: game level plain, scene level SCENE.NAME)', keyBad === 0, `${keyBad}: ${kwhy}`);
    info(`generator coverage over ${N} programs: TIMER in ${use.timer}, KEYPRESS in ${use.keypress}, JOYPRESS in ${use.joypress}, USING in ${use.using}, PLAY by index in ${use.playIdx}, PLAY (snda) in ${use.playParen}; ${(use.scenes / N).toFixed(1)} scenes on average`);
    check_('the generator really exercises every new word (each in at least 3 of 4 programs)', [use.timer, use.keypress, use.joypress, use.using, use.playIdx].every((n) => n >= N * 0.75), JSON.stringify(use));
    let hb = 0, hw = '';
    for (const [k, h] of Object.entries(HAND10)) { const r = cmp(h.src, RT2); if (r.errors.length) { hb++; hw += `${k}: ${errText(r)}; `; } }
    check_(`${Object.keys(HAND10).length} hand-written programs compile on the v2 runtime`, hb === 0, hw);
    // the sweep programs and the folding programs
    let sb = 0, sw = '';
    for (const pat of USING_PATTERNS) {
      const sp = sweepProgram(pat, { accumulate: true }), sp2 = sweepProgram(pat, { bases: [0, 100, -100, 32000] }), fp = foldProgram(pat, [0, 1, -1, 99, -99, 12345, -32768, 32767]);
      for (const [n, src] of [['sweep', sp.src], ['table sweep', sp2.src], ['fold', fp.src]]) { const r = cmp(src, RT2); if (r.errors.length) { sb++; sw += `${n} "${pat}": ${errText(r)}; `; } }
    }
    check_('the USING sweep programs (run-time and folded) compile for all 8 patterns', sb === 0, sw);
  }
  for (const [label, R, gen] of [['v3', RT3, genV3x], ['v4', RT4, genV4x]]) {
    if (!R || R.rt.symbols.RT_SHOWF === undefined) { skip_(`${label} spot programs compile`, `arcade/build/${label}/runtime.json missing or lacks RT_SHOWF`); continue; }
    let bad = 0, why = '';
    for (let s = 1; s <= (QUICK ? 6 : 20); s++) { const g = gen(s), r = cmp(g.src, R); if (r.errors.length) { bad++; why ||= `variant ${s}: ${errText(r)}`; } }
    check_(`${QUICK ? 6 : 20} ${label} spot programs (TIMER, KEYPRESS, JOYPRESS, USING, scenes + ${label === 'v3' ? 'WINDOW' : 'VIEW3D'}) compile on the real ${label} runtime`, bad === 0, why);
  }
  check_('the generator is deterministic per seed', genProgram10(7).src === genProgram10(7).src && genProgram10(7).src !== genProgram10(8).src && rng(1)() === rng(1)());
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(failed === 0 ? 0 : 1);
