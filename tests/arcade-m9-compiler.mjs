#!/usr/bin/env node
"use strict";
// arcade-m9-compiler.mjs -- tests for language batch 4 of the Leap Arcade compiler: scenes (SCENE ... ENDSCENE, ENTER). The contract is docs/ARCADE_LANGUAGE_BATCH4.md (sections 1 to 8, 13).
//
//   node tests/arcade-m9-compiler.mjs               (ARCADE_QUICK=1: fewer generated programs)
//
// No machine is booted here (tests/arcade-m9-differential.mjs runs the code on the real runtimes). Sections
//   1  parser and checker: every row of contract section 6, ENTER where it may and may not stand, scope rules, the old-runtime refusals
//   2  the reference interpreter, hand-computed: contract sections 2, 3, 4 and 8 (the machine after a switch, scene variables, RND, depth, restart, INIT chain, record keys, v3 / v4 models)
//   3  the image on the real v2 runtime: driver size for 1, 2, 4, 8 scenes, header entries, symbols.scene, slot ranges, the dispatch and ENTER bytes of contract section 5, the reset, qualified labels
//   4  everything the differential suite runs compiles (the generated programs, the hand programs, the v3 and v4 templates)
//
// Where the contract is silent the test takes the reading its text supports most literally and says so in a comment beginning "READING:".
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile, requiredRuntime } from '../src/lang/arcade/arcade-compile.js';
import { ASSETS, HAND, genProgram, genV3, genV4, sceneKeys, rng } from './arcade-m9-common.mjs';

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
const sameBytes = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);

// ── source helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const TOP = 'GAME "t"\nFRAMERATE 30\nSPRITE ship = "orb"\n';
/** a scene: header, optional decl lines, extra PROCs, INIT and FRAME bodies (lines already indented by 4) */
const scene = (name, { decl = '', procs = '', init = '', frame = '' } = {}) =>
  `SCENE ${name}\n${decl ? `  ${decl.replace(/\n/g, '\n  ')}\n` : ''}${procs}  PROC INIT()\n${init ? init + '\n' : ''}  ENDP\n  PROC FRAME()\n${frame ? frame + '\n' : ''}  ENDP\nENDSCENE\n`;
const diag = (src, version = 2) => { const p = parse(src); return [...p.errors, ...check(p.ast, { version })]; };
const errs = (src, v) => diag(src, v).filter((d) => d.severity === 'error');
const warns = (src, v) => diag(src, v).filter((d) => d.severity === 'warning');
const msgs = (l) => l.map((d) => `${d.line}:${d.col} ${d.message}`).join(' | ');
/** line (1-based) and column (0-based) of the n-th occurrence of `needle` in `src` */
const at = (src, needle, nth = 0) => {
  let from = -1;
  for (let i = 0; i <= nth; i++) { from = src.indexOf(needle, from + 1); if (from < 0) throw new Error(`test bug: "${needle}" #${nth} not in the source`); }
  const before = src.slice(0, from).split('\n');
  return { line: before.length, col: before[before.length - 1].length };
};
const okSrc = (name, src, v) => { const e = errs(src, v); check_(name, e.length === 0, msgs(e)); };
const badSrc = (name, src, msg, where, v) => {
  const e = errs(src, v);
  const hit = e.find((d) => (msg instanceof RegExp ? msg.test(d.message) : d.message === msg));
  check_(name, !!hit && (!where || (hit.line === where.line && hit.col === where.col)), hit ? `at ${hit.line}:${hit.col}, want ${where ? where.line + ':' + where.col : 'any'}` : `no such error: ${msgs(e) || 'no errors'}`);
};
const warnSrc = (name, src, msg, where, v) => {
  const w = warns(src, v).filter((d) => d.message === msg);
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
console.log('1. Parser and checker: contract section 6, ENTER, scope');
{
  // -- ENTER of an unknown scene (existing row)
  {
    const src = TOP + scene('a', { frame: '    ENTER nowhere' });
    badSrc('ENTER of an unknown scene: the exact message, at the name', src, "ENTER: unknown SCENE 'nowhere'", at(src, 'nowhere'));
    const s2 = TOP + scene('a', { init: '    ENTER nowhere' });
    badSrc('... also in INIT', s2, "ENTER: unknown SCENE 'nowhere'", at(s2, 'nowhere'));
    const s3 = TOP + 'PROC GO()\n  ENTER nope\nENDP\n' + scene('a');
    badSrc('... and in a top-level PROC', s3, "ENTER: unknown SCENE 'nope'", at(s3, 'nope'));
    okSrc('ENTER names a scene case-insensitively (ENTER SB for scene sb)', TOP + scene('a', { frame: '    ENTER SB' }) + scene('sb'));
  }
  // -- forward and backward references
  {
    const fwd = TOP + scene('a', { frame: '    IF 1 = 1 THEN ENTER b ENDIF' }) + scene('b', { frame: '    ENTER a' });
    okSrc('ENTER forward (a names the later b) and backward (b names the earlier a)', fwd);
    noWarn('... no "never entered" warning for either', fwd, /never entered/);
    okSrc('a scene entered from a scene declared AFTER it, and a top-level PROC declared before every scene',
      TOP + 'PROC GO()\n  ENTER c\nENDP\n' + scene('a', { frame: '    CALL GO()' }) + scene('b', { frame: '    ENTER c' }) + scene('c', { frame: '    ENTER a' }));
  }
  // -- never entered (warning)
  {
    const W = (n) => `SCENE '${n}' is never entered: only the first scene starts by itself`;
    const src = TOP + scene('a', { frame: '    ENTER b' }) + scene('b') + scene('lonely');
    warnSrc('a scene no ENTER names: the exact warning, at the scene name', src, W('lonely'), at(src, 'lonely'));
    check_('... only that one scene is warned about (a is the first, b is entered)', warns(src).filter((d) => /never entered/.test(d.message)).length === 1, msgs(warns(src)));
    check_('the first scene is never warned about, entered or not (a is entered by nobody)', !warns(TOP + scene('a', { frame: '    ENTER b' }) + scene('b')).some((d) => d.message.includes("'a'")), msgs(warns(TOP + scene('a', { frame: '    ENTER b' }) + scene('b'))));
    noWarn('... and entered by the later scene: also quiet', TOP + scene('a', { frame: '    ENTER b' }) + scene('b', { frame: '    ENTER a' }), /never entered/);
    noWarn('one scene alone: no warning', TOP + scene('a'), /never entered/);
    noWarn('ENTER in a top-level PROC counts as naming the scene', TOP + 'PROC GO()\n  ENTER b\nENDP\n' + scene('a', { frame: '    CALL GO()' }) + scene('b'), /never entered/);
    noWarn('ENTER in INIT counts', TOP + scene('a', { init: '    ENTER b' }) + scene('b'), /never entered/);
    noWarn('ENTER in a nested PROC and in a branch counts', TOP + scene('a', { procs: '  PROC GO(n)\n    IF n > 1 THEN\n      ENTER b\n    ENDIF\n  ENDP\n', frame: '    CALL GO(2)' }) + scene('b'), /never entered/);
    // READING: "a scene (not the first) that no ENTER names" -- a scene that only ENTERs ITSELF is named by an ENTER, so it is not warned about (the checker does not do a reachability analysis).
    noWarn('READING: a scene that only names itself is "entered" (no reachability analysis)', TOP + scene('a') + scene('b', { frame: '    ENTER b' }), /never entered/);
    const three = TOP + scene('a', { frame: '    ENTER b' }) + scene('b') + scene('c') + scene('d');
    check_('two never-entered scenes: two warnings, at their names', warns(three).filter((d) => /never entered/.test(d.message)).length === 2 && warns(three).some((d) => d.message === W('c') && d.line === at(three, 'SCENE c').line) && warns(three).some((d) => d.message === W('d')), msgs(warns(three)));
  }
  // -- unreachable after ENTER (warning)
  {
    const U = 'unreachable statement';
    const src = TOP + scene('a', { decl: 'DIM x', frame: '    ENTER b\n    x = 1' }) + scene('b');
    warnSrc('a statement after ENTER in the same block: "unreachable statement", at the statement', src, U, at(src, 'x = 1'));
    const rem = TOP + scene('a', { frame: '    ENTER b\n    REM done' }) + scene('b');
    check_('a REM after ENTER is not flagged', !warns(rem).some((d) => d.message === U), msgs(warns(rem)));
    const cond = TOP + scene('a', { decl: 'DIM x', frame: '    IF x = 0 THEN\n      ENTER b\n    ENDIF\n    x = 1' }) + scene('b');
    check_('ENTER inside an IF: the statement after the ENDIF is reachable', !warns(cond).some((d) => d.message === U), msgs(warns(cond)));
    const inBranch = TOP + scene('a', { decl: 'DIM x', frame: '    IF x = 0 THEN\n      ENTER b\n      x = 5\n    ENDIF' }) + scene('b');
    warnSrc('a statement after ENTER inside the same IF branch is flagged', inBranch, U, at(inBranch, 'x = 5'));
    const elseB = TOP + scene('a', { decl: 'DIM x', frame: '    IF x = 0 THEN\n      x = 1\n    ELSE\n      ENTER b\n      x = 7\n    ENDIF' }) + scene('b');
    warnSrc('... and in the ELSE branch', elseB, U, at(elseB, 'x = 7'));
    const loop = TOP + scene('a', { decl: 'DIM x', frame: '    FOR i = 1 TO 3\n      ENTER b\n      x = 9\n    NEXT i' }) + scene('b');
    warnSrc('... and in a loop body', loop, U, at(loop, 'x = 9'));
    const proc = TOP + scene('a', { decl: 'DIM x', procs: '  PROC GO()\n    ENTER b\n    x = 2\n  ENDP\n', frame: '    CALL GO()' }) + scene('b');
    warnSrc('... and in a PROC other than FRAME', proc, U, at(proc, 'x = 2'));
    const init = TOP + scene('a', { decl: 'DIM x', init: '    ENTER b\n    x = 3' }) + scene('b');
    warnSrc('... and in INIT', init, U, at(init, 'x = 3'));
    const two = TOP + scene('a', { decl: 'DIM x', frame: '    ENTER b\n    x = 1\n    x = 2' }) + scene('b');
    check_('as for EXIT: one warning per ENTER (the first statement after it)', warns(two).filter((d) => d.message === U).length === 1 && warns(two).some((d) => d.message === U && d.line === at(two, 'x = 1').line), msgs(warns(two)));
    noWarn('ENTER as the last statement: nothing after it, no warning', TOP + scene('a', { frame: '    ENTER b' }) + scene('b'), /unreachable/);
  }
  // -- where ENTER may stand
  {
    const b = scene('b');
    okSrc('ENTER in INIT', TOP + scene('a', { init: '    ENTER b' }) + b);
    okSrc('ENTER in FRAME', TOP + scene('a', { frame: '    ENTER b' }) + b);
    okSrc('ENTER in a PROC three deep', TOP + scene('a', { procs: '  PROC L3()\n    ENTER b\n  ENDP\n  PROC L2()\n    CALL L3()\n  ENDP\n  PROC L1()\n    CALL L2()\n  ENDP\n', frame: '    CALL L1()' }) + b);
    okSrc('ENTER in a PROC with parameters and locals', TOP + scene('a', { procs: '  PROC GO(n, m)\n    LOCAL q\n    q = n + m\n    IF q > 1 THEN ENTER b ENDIF\n  ENDP\n', frame: '    CALL GO(1, 2)' }) + b);
    okSrc('ENTER in a top-level PROC (it names a scene by name)', TOP + 'PROC GO()\n  ENTER b\nENDP\n' + scene('a', { frame: '    CALL GO()' }) + b);
    okSrc('ENTER in a branch (IF ... ELSE)', TOP + scene('a', { decl: 'DIM x', frame: '    IF x THEN\n      ENTER b\n    ELSE\n      ENTER a\n    ENDIF' }) + b);
    okSrc('ENTER in a FOR, a WHILE and a SELECT CASE', TOP + scene('a', { decl: 'DIM x', frame: '    FOR i = 0 TO 2\n      IF i = x THEN ENTER b ENDIF\n    NEXT i\n    WHILE x < 3\n      x = x + 1\n      IF x = 2 THEN ENTER b ENDIF\n    WEND\n    SELECT CASE x\n      CASE 1\n        ENTER b\n    ENDSEL' }) + b);
    okSrc('ENTER of the scene itself (a restart)', TOP + scene('a', { frame: '    ENTER a' }));
  }
  // -- ENTER in a DEF FN: the parser refuses (an expression has no statements)
  {
    const defAt = (src, needle) => at(src, needle);
    const g = TOP + 'DEF FN f(x) = ENTER b\n' + scene('a') + scene('b');
    const p = parse(g);
    check_('ENTER in a top-level DEF FN is refused by the parser, at the ENTER', p.errors.length >= 1 && p.errors[0].line === defAt(g, 'ENTER').line && p.errors[0].col === defAt(g, 'ENTER').col && /ENTER/.test(p.errors[0].message), msgs(p.errors) || 'no error');
    const s = TOP + scene('a', { decl: 'DEF FN f(x) = ENTER b' }) + scene('b');
    check_('... in a scene-level DEF FN', parse(s).errors.some((d) => d.line === defAt(s, 'ENTER').line && /ENTER/.test(d.message)), msgs(parse(s).errors));
    const e = TOP + scene('a', { decl: 'DIM x', frame: '    x = 1 + ENTER b' }) + scene('b');
    check_('... and ENTER as an operand of any expression', errs(e).length >= 1 && errs(e).some((d) => d.line === defAt(e, 'ENTER').line), msgs(errs(e)));
    check_('a DEF FN with ENTER makes compile() fail too (no dck)', (() => { if (!RT2) return true; const r = cmp(g, RT2); return r.errors.length >= 1 && !r.dck; })());
  }
  // -- scope: same names in several scenes, redeclaring a game-level name
  {
    const mk = (n) => scene(n, { decl: 'DIM t, arr(2) = 1, 2, 3\nCONST K = 4\nDEF FN f(x) = x + K', procs: '  PROC UPDATE()\n    t = t + FN f(t) + arr(1)\n  ENDP\n', frame: '    CALL UPDATE()\n    IF t > 50 THEN ENTER ' + (n === 'a' ? 'b' : 'a') + ' ENDIF' });
    okSrc('two scenes with the same DIM, array, CONST, PROC and DEF FN names', TOP + mk('a') + mk('b'));
    okSrc('three scenes, each with its own PROC UPDATE and DEF FN f', TOP + mk('a') + mk('b').replace('ENTER a', 'ENTER c') + mk('c').replace('ENTER a', 'ENTER b'));
    const redeclare = (what, game, sceneDecl, msg, needle, extra = {}) => {
      const src = TOP + game + scene('a', { decl: sceneDecl, ...extra }) + scene('b');
      badSrc(`a scene redeclaring a game-level ${what} is an error`, src, msg, needle === null ? null : at(src, needle, 1), 2);
    };
    redeclare('variable', 'DIM x\n', 'DIM x', /'x' is already declared \(line 4\)/, 'x');
    redeclare('array', 'DIM arr(3)\n', 'DIM arr(2)', /'arr' is already declared \(line 4\)/, 'arr');
    redeclare('variable by a scene array', 'DIM x\n', 'DIM x(2)', /'x' is already declared/, 'x');
    redeclare('CONST (by a scene CONST)', 'CONST K = 1\n', 'CONST K = 2', /'K' is already declared \(line 4\)/, null);
    redeclare('variable (by a scene CONST)', 'DIM x\n', 'CONST x = 2', /'x' is already declared/, null);
    {
      const src = TOP + 'PROC P()\nENDP\n' + scene('a', { procs: '  PROC P()\n  ENDP\n' }) + scene('b');
      badSrc('a scene PROC with the name of a game-level PROC', src, /'P' is already defined \(line 4\)/, null, 2);
      const s2 = TOP + 'DEF FN f(x) = x\n' + scene('a', { decl: 'DEF FN f(x) = x + 1' }) + scene('b');
      badSrc('a scene DEF FN with the name of a game-level DEF FN', s2, /'f' is already defined \(line 4\)/, null, 2);
      const s3 = TOP + 'DIM p\n' + scene('a', { procs: '  PROC P()\n  ENDP\n' }) + scene('b');
      badSrc('a scene PROC with the name of a game-level variable', s3, /'P' is already a variable/, null, 2);
      const s4 = TOP + 'PROC GP()\nENDP\n' + scene('a', { decl: 'DIM gp' }) + scene('b');
      badSrc('a scene variable with the name of a game-level PROC', s4, /'gp' is already the name of a PROC or DEF FN/, null, 2);
    }
    okSrc('the game level and a scene may use one name when the scene\'s own is NOT redeclared (g read in scene b)', TOP + 'DIM g\n' + scene('a', { frame: '    g = g + 1' }) + scene('b', { frame: '    g = g + 2' }));
    badSrc('a scene name declared twice', TOP + scene('a') + scene('a'), /SCENE 'a' is already defined \(line 4\)/, null, 2);
    // top-level PROCs and DEF FNs see only top-level names
    const tl = TOP + 'DIM g\nPROC GP()\n  hidden = 1\nENDP\n' + scene('a', { decl: 'DIM hidden', frame: '    CALL GP()' }) + scene('b');
    badSrc('a top-level PROC cannot see a scene\'s variable', tl, /'hidden' is not declared/, null, 2);
    const tf = TOP + 'DEF FN f(x) = x + hidden\n' + scene('a', { decl: 'DIM hidden', frame: '    hidden = FN f(1)' }) + scene('b');
    badSrc('a top-level DEF FN cannot see a scene\'s variable', tf, /'hidden' is not declared/, null, 2);
    const cross = TOP + scene('a', { decl: 'DIM mine' }) + scene('b', { frame: '    mine = 1' });
    badSrc('a scene cannot see another scene\'s variable', cross, /'mine' is not declared/, null, 2);
    const crossProc = TOP + scene('a', { procs: '  PROC ONLYA()\n  ENDP\n' }) + scene('b', { frame: '    CALL ONLYA()' });
    badSrc('a scene cannot CALL another scene\'s PROC', crossProc, /ONLYA|onlya/i, null, 2);
    const crossFn = TOP + scene('a', { decl: 'DEF FN fa(x) = x' }) + scene('b', { decl: 'DIM v', frame: '    v = FN fa(2)' });
    badSrc('a scene cannot use another scene\'s DEF FN', crossFn, /fa/i, null, 2);
    okSrc('a scene sees the game level and its own names', TOP + 'DIM g\nCONST GK = 3\nDEF FN gf(x) = x * GK\n' + scene('a', { decl: 'DIM v', frame: '    v = FN gf(g) + GK' }));
    // scene CONST names and an ARRAY of the same name in two scenes with different sizes
    okSrc('two scenes with an array of the same name and different sizes', TOP + scene('a', { decl: 'DIM q(3)', frame: '    q(3) = 1' }) + scene('b', { decl: 'DIM q(9)', frame: '    q(9) = 1\n    ENTER a' }));
  }
  // -- the FOR-variable row
  {
    // READING of the row: a PROC's implicit FOR variable is checked against the names visible to the PROC (the game level plus its own scene), not against another scene's.
    const other = TOP + scene('a', { procs: '  PROC P()\n    FOR i = 1 TO 2\n    NEXT i\n  ENDP\n', frame: '    CALL P()' }) + scene('b', { decl: 'DIM i', frame: '    i = 1\n    ENTER a' });
    okSrc('a FOR variable named like a DIM of ANOTHER scene (declared later) is a plain local: no error', other, 2);
    const own = TOP + scene('a', { decl: 'DIM x', procs: '  PROC P()\n    FOR i = 1 TO 2\n    NEXT i\n  ENDP\n', frame: '    CALL P()' }).replace('  PROC INIT()', '  DIM i\n  PROC INIT()') + scene('b');
    badSrc('... but a DIM of its OWN scene declared later is the old error, same text, at the variable', own, /^'i' is declared later \(line \d+\) than this PROC: /, at(own, 'i = 1'), 2);
    check_('... and the message names the DIM\'s line', (() => { const e = errs(own, 2).find((d) => /declared later/.test(d.message)); return !!e && e.message.includes(`line ${at(own, 'DIM i').line})`); })());
    const game = TOP + scene('a', { procs: '  PROC P()\n    FOR i = 1 TO 2\n    NEXT i\n  ENDP\n', frame: '    CALL P()' }) + 'DIM i\n' + scene('b');
    badSrc('a game-level DIM declared (below) later than the PROC is still the error', game, /^'i' is declared later \(line \d+\) than this PROC: /, at(game, 'i = 1'), 2);
    const above = TOP + scene('a', { procs: '  PROC P()\n    FOR i = 1 TO 2\n    NEXT i\n  ENDP\n', frame: '    CALL P()' }) + scene('b', { decl: 'DIM i' });
    okSrc('the same FOR name in two scenes, each with the DIM below the other', above, 2);
  }
  // -- the old runtimes: generator refusals (the checker stays quiet, contract section 6)
  {
    const two = TOP + scene('a', { frame: '    ENTER b' }) + scene('b');
    const p = parse(two);
    check_('check(ast, {version: 1}) has no scene / ENTER error of its own (the generator refuses)', check(p.ast, { version: 1 }).filter((d) => d.severity === 'error').length === 0, msgs(check(p.ast, { version: 1 })));
    check_('check(ast) without a version assumes nothing', check(p.ast).filter((d) => d.severity === 'error').length === 0);
    const second = p.ast.scenes[1], enter = p.ast.scenes[0].procs[1].body[0];
    const hint = (what, m) => `${what} is not supported yet in ${m} (build with --runtime v2)`;
    const msg0s = 'a second SCENE (M2 has exactly one) is not supported yet in M2 (build with --runtime v2)';
    if (RT0) {
      const r = cmp(two, RT0);
      const s = r.errors.find((d) => d.message === msg0s), e = r.errors.find((d) => d.message === hint('ENTER', 'M2'));
      check_('v0 runtime: the second SCENE is refused with the exact message, at the scene', !!s && s.line === second.line && s.col === second.col && !r.dck, errText(r));
      check_('v0 runtime: ENTER is refused with the exact message, at the ENTER', !!e && e.line === enter.line && e.col === enter.col, errText(r));
      const one = cmp(TOP + scene('a', { frame: '    ENTER a' }), RT0);
      check_('v0 runtime: ENTER in a ONE-scene game is refused (same message)', one.errors.some((d) => d.message === hint('ENTER', 'M2')) && !one.dck, errText(one));
    } else skip_('v0 runtime refusals', 'arcade/build/runtime.json does not exist');
    if (RT1) {
      const r = cmp(two, RT1);
      // READING: on a v1 runtime only the "yet in M2" part of the second-SCENE message becomes "yet in M3" ("(M2 has exactly one)" is the old fixed text), as `notYet` has always done
      check_('v1 runtime: the second SCENE is refused ("... (M2 has exactly one) is not supported yet in M3 (build with --runtime v2)")', r.errors.some((d) => d.message === 'a second SCENE (M2 has exactly one) is not supported yet in M3 (build with --runtime v2)') && !r.dck, errText(r));
      check_('v1 runtime: ENTER is refused with M3', r.errors.some((d) => d.message === hint('ENTER', 'M3')), errText(r));
    } else skip_('v1 runtime refusals', 'arcade/build/v1/runtime.json does not exist');
    if (RT2) check_('v2 runtime: the same program compiles', cmp(two, RT2).errors.length === 0, errText(cmp(two, RT2)));
    check_('requiredRuntime: a scene program needs at least v2 (it names no v3 / v4 reason)', (() => { const r = requiredRuntime(two, ASSETS); return r.version === 2 && r.reasons.length === 0; })());
  }
  // -- structure errors stay (the checker's existing rows)
  {
    badSrc('a scene without PROC FRAME', TOP + 'SCENE a\n  PROC INIT()\n  ENDP\nENDSCENE\n', "SCENE 'a' has no PROC FRAME()");
    badSrc('a scene without PROC INIT', TOP + 'SCENE a\n  PROC FRAME()\n  ENDP\nENDSCENE\n', "SCENE 'a' has no PROC INIT()");
    const src = TOP + scene('a') + 'SCENE b\n  PROC FRAME()\n  ENDP\nENDSCENE\n';
    badSrc('the second scene without INIT: the error names that scene, at its name', src, "SCENE 'b' has no PROC INIT()", { line: at(src, 'SCENE b').line, col: at(src, 'SCENE b').col + 6 });
  }
}

// =================================================================================================================
// 2. The reference interpreter, hand-computed
// =================================================================================================================
console.log('\n2. Interpreter: contract sections 2, 3, 4 and 8');
const GH = 'GAME "t"\nFRAMERATE 12\nTILESET ts = "ts"\nMAP ma = "m1"\nMAP mb = "m2"\nSFX snda = "short"\nSFX sndb = "long"\nSPRITE ship = "orb"\nSPRITE rock(4) = "dot"\n';
const GH_NOMAP = GH.replace('MAP ma = "m1"\nMAP mb = "m2"\n', '');
const ip = (src, ticks, opts = {}) => interpret(parse(src).ast, { version: 2, ticks, assets: ASSETS, maxSteps: 50_000_000, ...opts });
const tryIp = (name, fn) => { try { return fn(); } catch (e) { check_(name, false, `interpreter threw: ${e.message}`); return null; } };
const vv = (rec, ...keys) => keys.map((k) => rec.vars[k]);
const aa = (rec, k) => Array.from(rec.arrays[k]);
{
  // 4.4 / 2.3 / 2.6: the timeline of a two-scene game; keys SCENE.NAME; the switch tick shows INIT's work
  const src = GH + `DIM g
SCENE a
  DIM t, arr(2) = 4, 5, 6
  PROC INIT()
  ENDP
  PROC FRAME()
    t = t + 1 : g = g + 1
    IF t = 2 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  DIM t, arr(1)
  PROC INIT()
    g = g + 10
    t = t + 5
  ENDP
  PROC FRAME()
    t = t + 1
  ENDP
ENDSCENE
`;
  const r = tryIp('two-scene timeline', () => ip(src, 4));
  if (r) {
    eq('record keys: game-level plain, scene-level SCENE.NAME in upper case', [Object.keys(r.init.vars).sort(), Object.keys(r.init.arrays).sort()], [['A.T', 'B.T', 'G'], ['A.ARR', 'B.ARR']]);
    eq('init record: scene 0, game variable 0, first scene\'s array initialised, the other scene\'s variables 0 until entered', [r.init.scene, r.init.vars.G, r.init.vars['A.T'], aa(r.init, 'A.ARR'), r.init.vars['B.T'], aa(r.init, 'B.ARR')], [0, 0, 0, [4, 5, 6], 0, [0, 0]]);
    eq('tick 1 (scene a): A.T 1, G 1, scene 0', [r.ticks[0].scene, r.ticks[0].vars['A.T'], r.ticks[0].vars.G], [0, 1, 1]);
    eq('tick 2 (the switch): scene 1; G = 2 + 10 (b\'s INIT ran in the same tick); B.T = 5; b\'s FRAME has not run', [r.ticks[1].scene, r.ticks[1].vars.G, r.ticks[1].vars['B.T']], [1, 12, 5]);
    eq('tick 3 (b\'s first FRAME): B.T 6, G kept', [r.ticks[2].scene, r.ticks[2].vars['B.T'], r.ticks[2].vars.G], [1, 6, 12]);
    // READING: the variables of a scene that has been left keep their last values in the records (the real machine does not clear them when it leaves; a record is a copy of that memory)
    eq('READING: the left scene\'s variables keep their last values in the record (A.T stays 2)', [r.ticks[1].vars['A.T'], r.ticks[2].vars['A.T'], r.ticks[3].vars['A.T']], [2, 2, 2]);
  }
  // 4.3: zero and initialisers on EVERY entry; game variables keep their value
  const src2 = GH + `DIM g
SCENE a
  DIM t, arr(2) = 5, 6, 7
  PROC INIT()
    arr(1) = arr(1) + 100
  ENDP
  PROC FRAME()
    t = t + 1 : g = g + 1 : arr(0) = arr(0) + t
    IF t = 2 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  DIM t, arr(2) = 1, 1, 1
  PROC INIT()
    arr(2) = 9
  ENDP
  PROC FRAME()
    t = t + 1
    IF t = 2 THEN ENTER a ENDIF
  ENDP
ENDSCENE
`;
  const s = tryIp('re-entry', () => ip(src2, 5));
  if (s) {
    eq('init: a\'s array = initialiser with INIT\'s change; b\'s array 0 (not entered yet)', [aa(s.init, 'A.ARR'), aa(s.init, 'B.ARR')], [[5, 106, 7], [0, 0, 0]]);
    eq('tick 2 (a -> b): b\'s variables zeroed, its initialisers copied, then INIT: B.T 0, B.ARR [1, 1, 9]; G 2', [s.ticks[1].scene, s.ticks[1].vars['B.T'], aa(s.ticks[1], 'B.ARR'), s.ticks[1].vars.G], [1, 0, [1, 1, 9], 2]);
    eq('tick 4 (b -> a): a\'s variables are zero again and its initialiser is re-applied (A.T 0, A.ARR [5, 6, 7] then INIT: [5, 106, 7]); G kept (2)', [s.ticks[3].scene, s.ticks[3].vars['A.T'], aa(s.ticks[3], 'A.ARR'), s.ticks[3].vars.G], [0, 0, [5, 106, 7], 2]);
    eq('tick 5: a runs again from its start state: A.T 1, A.ARR [6, 106, 7], G 3', [s.ticks[4].vars['A.T'], aa(s.ticks[4], 'A.ARR'), s.ticks[4].vars.G], [1, [6, 106, 7], 3]);
  }
}
{
  // ENTER of itself restarts; one scene: names stay plain
  const src = GH + `DIM g
SCENE a
  DIM n, arr(2) = 1, 2, 3
  PROC INIT()
    g = g + 1
    n = n + 7
    arr(2) = arr(2) + g
  ENDP
  PROC FRAME()
    n = n + 1
    arr(0) = arr(0) + 1
    IF n = 9 THEN ENTER a ENDIF
  ENDP
ENDSCENE
`;
  const r = tryIp('ENTER of itself', () => ip(src, 4));
  if (r) {
    eq('one scene with ENTER of itself: every name stays plain', [Object.keys(r.init.vars).sort(), Object.keys(r.init.arrays)], [['G', 'N'], ['ARR']]);
    eq('init: G 1, N 7, ARR [1, 2, 4]', [r.init.vars.G, r.init.vars.N, aa(r.init, 'ARR')], [1, 7, [1, 2, 4]]);
    eq('tick 2: n reached 9 -> restart: scene variables zero, initialiser copied, INIT again: G 2, N 7, ARR [1, 2, 5]', [r.ticks[1].vars.G, r.ticks[1].vars.N, aa(r.ticks[1], 'ARR')], [2, 7, [1, 2, 5]]);
    eq('tick 3 runs the restarted scene: N 8, ARR [2, 2, 5]', [r.ticks[2].vars.N, aa(r.ticks[2], 'ARR')], [8, [2, 2, 5]]);
    eq('tick 4 restarts again: G 3, N 7, ARR [1, 2, 6]; the scene index stays 0', [r.ticks[3].vars.G, r.ticks[3].vars.N, aa(r.ticks[3], 'ARR'), r.ticks.map((t) => t.scene)], [3, 7, [1, 2, 6], [0, 0, 0, 0]]);
  }
}
{
  // 2.2: ENTER from depth 3 abandons everything (loops, calling PROCs, the rest of FRAME)
  const src = GH + `DIM g, h1, h2, h3
SCENE a
  DIM t
  PROC INIT()
  ENDP
  PROC L3()
    h3 = h3 + 1
    FOR i = 0 TO 5
      g = g + 1
      IF t = 2 AND i = 3 THEN ENTER b ENDIF
    NEXT i
    h3 = h3 + 100
  ENDP
  PROC L2()
    CALL L3()
    h2 = h2 + 1
  ENDP
  PROC L1()
    CALL L2()
    h1 = h1 + 1
  ENDP
  PROC FRAME()
    t = t + 1
    CALL L1()
    g = g + 1000
  ENDP
ENDSCENE
SCENE b
  DIM t
  PROC INIT()
    g = g + 10000
  ENDP
  PROC FRAME()
    t = t + 1
  ENDP
ENDSCENE
`;
  const r = tryIp('depth 3', () => ip(src, 3));
  if (r) {
    eq('tick 1 (no switch): every level finishes: H3 = 101, H2 = 1, H1 = 1, G = 6 + 1000', vv(r.ticks[0], 'H3', 'H2', 'H1', 'G'), [101, 1, 1, 1006]);
    eq('tick 2: ENTER inside a FOR inside L3 (depth 3): the loop, the +100, H2, H1 and the +1000 never run; b\'s INIT adds 10000', vv(r.ticks[1], 'H3', 'H2', 'H1', 'G'), [102, 1, 1, 1006 + 4 + 10000]);
    eq('... and the scene is b', r.ticks[1].scene, 1);
    eq('tick 3: b\'s FRAME (its own t), a\'s PROCs not run again', [r.ticks[2].vars['B.T'], r.ticks[2].vars.G, r.ticks[2].vars.H3], [1, 11010, 102]);
  }
  // a top-level PROC, a WHILE
  const src2 = GH + `DIM g, k
PROC GO(n)
  g = g + n
  IF g > 20 THEN ENTER b ENDIF
ENDP
SCENE a
  DIM t
  PROC INIT()
  ENDP
  PROC FRAME()
    t = t + 1
    k = 0
    WHILE k < 10
      k = k + 1
      CALL GO(k)
    WEND
    g = 777
  ENDP
ENDSCENE
SCENE b
  DIM t
  PROC INIT()
    g = g * 2
  ENDP
  PROC FRAME()
    t = t + 1
  ENDP
ENDSCENE
`;
  const q = tryIp('top-level PROC', () => ip(src2, 2));
  if (q) eq('ENTER in a top-level PROC inside a WHILE: g 1+2+..+6 = 21 > 20 at k = 6 -> b; G = 21 * 2, K 6, the `g = 777` after the loop never runs', [q.ticks[0].scene, q.ticks[0].vars.G, q.ticks[0].vars.K, q.ticks[0].vars['A.T']], [1, 42, 6, 1]);
}
{
  // 2.4 / 2.6: INIT chain A -> B -> C, at the boot, and its record
  const src = GH + `DIM log
SCENE a
  PROC INIT()
    log = log * 10 + 1
    PRINT AT 1, 1; "A"
    ENTER b
  ENDP
  PROC FRAME()
  ENDP
ENDSCENE
SCENE b
  PROC INIT()
    log = log * 10 + 2
    PRINT AT 3, 3; "B"
    ENTER c
  ENDP
  PROC FRAME()
  ENDP
ENDSCENE
SCENE c
  DIM t
  PROC INIT()
    log = log * 10 + 3
    PRINT AT 5, 5; "C"; log
  ENDP
  PROC FRAME()
    t = t + 1
  ENDP
ENDSCENE
`;
  const r = tryIp('INIT chain', () => ip(src, 2));
  if (r) {
    eq('the init record is the state after the whole chain: scene 2, LOG 123', [r.init.scene, r.init.vars.LOG], [2, 123]);
    const ch = (rec, row, col) => String.fromCharCode(rec.cells[row * 32 + col]);
    eq('only the last INIT\'s text remains (every switch clears the screen): "A" and "B" are gone, "C123" is at (5, 5)', [ch(r.init, 1, 1), ch(r.init, 3, 3), ch(r.init, 5, 5), ch(r.init, 5, 6) + ch(r.init, 5, 7) + ch(r.init, 5, 8)], [' ', ' ', 'C', '123']);
    eq('tick 1: c\'s FRAME runs first, scene 2, C.T 1', [r.ticks[0].scene, r.ticks[0].vars['C.T']], [2, 1]);
  }
}
{
  // 3: the machine after a switch is the first scene's start state (the probe: an empty first INIT, a messy tick 1, the switch at tick 2)
  const probe = (head, extra = '') => head + `SCENE a
  DIM t
  PROC INIT()
  ENDP
  PROC FRAME()
    t = t + 1
    IF t = 1 THEN
      INK 3 : PAPER 1 : BRIGHT 1 : BORDER 5
      PRINT AT 5, 5; "hello"; 42
      SHOW ship AT 40, 50
      SHOW rock(2) AT 100, 90
      TILE 3, 3 = 2
      FILL 10, 10, 4, 3 = 4
      FILLC 0, 20, 8, 2 = 66
${extra}      PLAY sndb
    ENDIF
    IF t = 2 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  PROC INIT()
  ENDP
  PROC FRAME()
  ENDP
ENDSCENE
`;
  const props = (name, head, extra = '', opts = {}) => {
    const r = tryIp(name, () => ip(probe(head, extra), 3, opts));
    if (!r) return null;
    const a = r.ticks[0], b = r.ticks[1];
    check_(`${name}: tick 1 really made a mess (so the test can fail)`, !sameBytes(a.cells, r.init.cells) && a.textAttr !== r.init.textAttr && a.border !== r.init.border && a.sprites.some((s) => s.visible) && a.sfx.active, `border ${a.border} vs ${r.init.border}`);
    check_(`${name}: after the switch the cells and attributes equal the game start state`, sameBytes(b.cells, r.init.cells) && sameBytes(b.attrs, r.init.attrs));
    eq(`${name}: cursor (0, 0), text attribute $38 (INK 0, PAPER 7, BRIGHT 0)`, [b.cursor, b.textAttr], [{ row: 0, col: 0 }, 0x38]);
    eq(`${name}: border back to the boot colour`, b.border, r.init.border);
    check_(`${name}: sound stopped (tick 1 had the effect running)`, a.sfx.active === true && b.sfx.active === false);
    check_(`${name}: every sprite instance hidden`, b.sprites.length > 0 && b.sprites.every((s) => !s.visible), JSON.stringify(b.sprites.slice(0, 2)));
    return r;
  };
  const withMaps = props('machine reset, game with MAPs', GH, '      LOADMAP mb AT 8, 12\n');
  if (withMaps) {
    const c = withMaps.ticks[1].cells, at_ = withMaps.ticks[1].attrs;
    const tile = (n) => 128 + n, tileAttr = (n) => ((n % 2) << 6) | (((n * 3) % 8) << 3) | ((n + 1) % 8);
    eq('first MAP reloaded at (0, 0): m1 cell (0, 1) = tile 1, cell (1, 0) = tile 5, (0, 0) blank', [c[1], c[32], c[0]], [tile(1), tile(5), 32]);
    eq('... with the tiles\' attributes (tile 1: $5A... computed), the rest blank on paper 7', [at_[1], at_[32], at_[20 * 32 + 20]], [tileAttr(1), tileAttr(5), 0x38]);
    eq('... and nothing of the second map (LOADMAP mb AT 8, 12) or of the text remains', [c[12 * 32 + 8], c[5 * 32 + 5], c[3 * 32 + 3], c[10 * 32 + 10]], [32, 32, 32, 32]);
  }
  const noMap = props('machine reset, game with no MAP', GH_NOMAP);
  if (noMap) eq('no MAP: every cell is a blank on paper 7 (nothing is loaded)', [noMap.ticks[1].cells.every((v) => v === 32), noMap.ticks[1].attrs.every((v) => v === 0x38)], [true, true]);
  props('machine reset, border0 = 4 (the boot colour is the runtime\'s)', GH, '', { border0: 4 });
  const bd = tryIp('border0', () => ip(probe(GH), 3, { border0: 4 }));
  if (bd) eq('border: tick 1 BORDER 5, the switch gives opts.border0 (4), not a fixed 1', [bd.ticks[0].border, bd.ticks[1].border], [5, 4]);
  // the reset is "defined as a sequence of ordinary statements": a single scene doing the same by hand ends in the same state
  const ctl = GH + `SCENE a
  DIM t
  PROC INIT()
  ENDP
  PROC FRAME()
    t = t + 1
    IF t = 1 THEN
      INK 3 : PAPER 1 : BRIGHT 1 : BORDER 5
      PRINT AT 5, 5; "hello"; 42
      SHOW ship AT 40, 50
      SHOW rock(2) AT 100, 90
      TILE 3, 3 = 2
      FILL 10, 10, 4, 3 = 4
      FILLC 0, 20, 8, 2 = 66
      PLAY sndb
    ENDIF
    IF t = 2 THEN
      SILENCE
      HIDE ship
      HIDE rock(0) : HIDE rock(1) : HIDE rock(2) : HIDE rock(3)
      INK 0 : PAPER 7 : BRIGHT 0 : BORDER 1
      CLS
      LOADMAP ma
    ENDIF
  ENDP
ENDSCENE
`;
  const c1 = tryIp('control', () => ip(ctl, 3)), m1 = tryIp('control (scenes)', () => ip(probe(GH), 3));
  if (c1 && m1) {
    const a = c1.ticks[1], b = m1.ticks[1];
    check_('the same steps written by hand (SILENCE, HIDE, INK 0 : PAPER 7 : BRIGHT 0, BORDER, CLS, LOADMAP) give the switch\'s state (cells, attributes, cursor, text attribute, border, sprites, sound)',
      sameBytes(a.cells, b.cells) && sameBytes(a.attrs, b.attrs) && a.cursor.row === b.cursor.row && a.cursor.col === b.cursor.col && a.textAttr === b.textAttr && a.border === b.border && JSON.stringify(a.sprites) === JSON.stringify(b.sprites) && a.sfx.active === b.sfx.active);
  }
  // the switch tick shows what INIT made; FRAME of the new scene runs from the next tick
  const sw = GH_NOMAP + `SCENE a
  DIM t
  PROC INIT()
  ENDP
  PROC FRAME()
    t = t + 1
    PRINT AT 2, 2; "a"
    IF t = 2 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  PROC INIT()
    PRINT AT 3, 3; "B"
  ENDP
  PROC FRAME()
    PRINT AT 4, 4; "C"
  ENDP
ENDSCENE
`;
  const r = tryIp('switch tick', () => ip(sw, 3));
  if (r) {
    const ch = (rec, row, col) => String.fromCharCode(rec.cells[row * 32 + col]);
    eq('tick 1: "a" at (2, 2) (the first scene\'s FRAME); tick 2 (the switch): its "a" is gone, b\'s INIT\'s "B" is there, FRAME\'s "C" is not; tick 3: "C" appears', [ch(r.ticks[0], 2, 2), ch(r.ticks[1], 2, 2), ch(r.ticks[1], 3, 3), ch(r.ticks[1], 4, 4), ch(r.ticks[2], 4, 4)], ['a', ' ', 'B', ' ', 'C']);
    eq('tick 2: the text attribute of INIT\'s "B" is the reset\'s $38', r.ticks[1].attrs[3 * 32 + 3], 0x38);
  }
}
{
  // 3: RND continues; no re-seed at the switch
  const src = GH + `DIM r1, r2, r3
SCENE a
  DIM t
  PROC INIT()
    r1 = RND(1000)
  ENDP
  PROC FRAME()
    t = t + 1
    r2 = RND(1000)
    IF t = 2 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  PROC INIT()
    r3 = RND(1000)
  ENDP
  PROC FRAME()
    r1 = RND(1000)
  ENDP
ENDSCENE
`;
  let c = 0;
  const r = tryIp('RND', () => ip(src, 3, { rnd: () => ++c }));
  if (r) {
    eq('RND(1000) with a counting generator: INIT 1, tick 1 2, tick 2 3, b\'s INIT 4, tick 3 5 (the sequence runs through the switch)', [r.init.vars.R1, r.ticks[0].vars.R2, r.ticks[1].vars.R2, r.ticks[1].vars.R3, r.ticks[2].vars.R1], [1, 2, 3, 4, 5]);
  }
  // RANDOMISE n then ENTER: the generator is the re-seeded one, and the switch does not seed again
  const rs = GH + `DIM r3
SCENE a
  DIM t
  PROC INIT()
  ENDP
  PROC FRAME()
    t = t + 1
    IF t = 2 THEN RANDOMISE 77 : ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  PROC INIT()
    r3 = RND(1000)
  ENDP
  PROC FRAME()
  ENDP
ENDSCENE
`;
  const seeds = []; let c2 = 500;
  const q = tryIp('RANDOMISE', () => ip(rs, 3, { rnd: () => 0, reseed: (s) => { seeds.push(s); return () => ++c2; } }));
  if (q) eq('RANDOMISE 77 in a, then a switch: exactly one re-seed (77); b\'s INIT draws the next value of the re-seeded generator (501)', [seeds, q.ticks[1].vars.R3], [[77], 501]);
}
{
  // 3: sprites. v2 model: hidden. v3 / v4 model: shown at (0, 0) frame 0, then hidden
  const v2 = GH_NOMAP + `SCENE a
  DIM t
  PROC INIT()
    SHOW ship AT 40, 50
    SHOW rock(2) AT 100, 90
  ENDP
  PROC FRAME()
    t = t + 1
    IF t = 2 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  PROC INIT()
  ENDP
  PROC FRAME()
  ENDP
ENDSCENE
`;
  const r = tryIp('sprites v2', () => ip(v2, 2));
  if (r) {
    check_('v2 model: after INIT and tick 1 two instances are visible; after the switch none', r.ticks[0].sprites.filter((s) => s.visible).length === 2 && r.ticks[1].sprites.every((s) => !s.visible), JSON.stringify(r.ticks[1].sprites));
  }
  const v3 = `GAME "t"\nFRAMERATE 20\nSPRITE g(3) = "guard"\nSPRITE b = "big"\nSCENE a
  DIM t
  PROC INIT()
    SHOW g(1) AT 30, 40 FRAME 2
    SHOW b AT 100, 20 FLIP
  ENDP
  PROC FRAME()
    t = t + 1
    SHOW g(2) AT 50 + t, 60 FRAME 1
    IF t = 2 THEN ENTER z ENDIF
  ENDP
ENDSCENE
SCENE z
  PROC INIT()
  ENDP
  PROC FRAME()
  ENDP
ENDSCENE
`;
  for (const version of [3, 4]) {
    const q = tryIp(`sprites v${version}`, () => ip(v3, 2, { version }));
    if (q) {
      const before = q.ticks[0].sprites, after = q.ticks[1].sprites;
      check_(`v${version} model: before the switch some instance is shown away from (0, 0) with a frame`, before.some((s) => s.visible && s.frame > 0 && (s.x !== 0 || s.y !== 0)), JSON.stringify(before.slice(0, 4)));
      check_(`v${version} model: after it EVERY instance is hidden at (0, 0) with frame 0 (a later SHOW without FRAME draws frame 0)`, after.length > 0 && after.every((s) => !s.visible && s.x === 0 && s.y === 0 && s.frame === 0), JSON.stringify(after.slice(0, 5)));
    }
  }
}
{
  // 3: sound -- stopped by the switch; the new scene's INIT can start its own
  const src = GH_NOMAP + `SCENE a
  DIM t
  PROC INIT()
    PLAY sndb
  ENDP
  PROC FRAME()
    t = t + 1
    IF t = 2 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  PROC INIT()
  ENDP
  PROC FRAME()
  ENDP
ENDSCENE
`;
  const r = tryIp('sound', () => ip(src, 3));
  if (r) eq('a long effect started in INIT plays in tick 1 and is stopped by the switch of tick 2 (and stays stopped)', [r.init.sfx.active, r.ticks[0].sfx.active, r.ticks[1].sfx.active, r.ticks[2].sfx.active], [true, true, false, false]);
  const src2 = src.replace('  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n', '  PROC INIT()\n    PLAY sndb\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n');
  const q = tryIp('sound in the new INIT', () => ip(src2, 3));
  if (q) eq('an effect started by the NEW scene\'s INIT in the switch tick is playing after it', [q.ticks[1].sfx.active, q.ticks[1].sfx.index], [true, 1]);
}
{
  // 3 "Not touched": the window (v3) and the 3D view (v4) are game-wide
  const w = `GAME "w"\nFRAMERATE 20\nTILESET ts = "ts"\nMAP level = "lv"\nSPRITE g(3) = "guard"\nWINDOW level\nSCENE a
  DIM t
  PROC INIT()
    CAMERA 40
    SETWORLD 8, 8 = 3
    SHOW g(1) AT 30, 40 FRAME 2
  ENDP
  PROC FRAME()
    t = t + 1
    IF t = 2 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  PROC INIT()
  ENDP
  PROC FRAME()
  ENDP
ENDSCENE
`;
  const r = tryIp('window survives', () => ip(w, 3, { version: 3 }));
  if (r) {
    eq('WINDOW: the camera is the same before and after the switch (40)', [r.init.cam, r.ticks[0].cam, r.ticks[1].cam, r.ticks[2].cam], [40, 40, 40, 40]);
    check_('WINDOW: the world edit (SETWORLD 8, 8 = 3: cell row 1, col 1 = 3 * 8) survives, the whole world is unchanged by the switch', r.ticks[1].worldRam[1 * 128 + 1] === 24 && sameBytes(r.ticks[0].worldRam, r.ticks[1].worldRam));
    check_('WINDOW game: the sprite is back at (0, 0) frame 0, hidden', r.ticks[1].sprites.every((s) => !s.visible && s.x === 0 && s.y === 0 && s.frame === 0), JSON.stringify(r.ticks[1].sprites.slice(0, 3)));
  }
  const v = `GAME "v"\nFRAMERATE 12\nMAP level = "maze"\nSPRITE g(3) = "guard"\nVIEW3D level\nSCENE a
  DIM t
  PROC INIT()
    VIEW 700, 800, 40
    SETWALL 300, 300 = 2
    SHOW g(0) AT 900, 900 FRAME 1
  ENDP
  PROC FRAME()
    t = t + 1
    IF t = 2 THEN ENTER b ENDIF
  ENDP
ENDSCENE
SCENE b
  PROC INIT()
  ENDP
  PROC FRAME()
  ENDP
ENDSCENE
`;
  const q = tryIp('view survives', () => ip(v, 3, { version: 4 }));
  if (q) {
    eq('VIEW3D: the pose (700, 800, 40) is the same after the switch', [q.ticks[0].view, q.ticks[1].view], [{ x: 700, y: 800, a: 40 }, { x: 700, y: 800, a: 40 }]);
    check_('VIEW3D: the SETWALL edit (row 1, col 1 = 2) survives and the array is unchanged by the switch', q.ticks[1].wallRam[1 * 32 + 1] === 2 && sameBytes(q.ticks[0].wallRam, q.ticks[1].wallRam));
    check_('VIEW3D game: the sprite is hidden at (0, 0) frame 0', q.ticks[1].sprites.every((s) => !s.visible && s.x === 0 && s.y === 0 && s.frame === 0), JSON.stringify(q.ticks[1].sprites.slice(0, 3)));
  }
}
{
  // 4.4: reports of the generated names; sceneKeys on the AST equals what the interpreter reports
  const keysOf = (src) => { const r = ip(src, 1); return { vars: Object.keys(r.init.vars).sort(), arrays: Object.keys(r.init.arrays).sort() }; };
  let okAll = true, why = '';
  for (const [k, src] of Object.entries(HAND)) {
    const want = sceneKeys(src, parse);
    const got = tryIp(`keys ${k}`, () => keysOf(src));
    if (!got) { okAll = false; continue; }
    if (JSON.stringify(got.vars) !== JSON.stringify([...want.vars].sort()) || JSON.stringify(got.arrays) !== JSON.stringify([...want.arrays].sort())) { okAll = false; why += `${k}: vars ${got.vars} / want ${want.vars.sort()}; `; }
  }
  check_('every hand-written program: the interpreter\'s record keys are exactly the contract\'s SCENE.NAME / plain names', okAll, why);
  const single = keysOf(HAND.selfOnly);
  eq('one scene with ENTER of itself: plain keys', single, { vars: ['G', 'N'], arrays: ['ARR'] });
}

// =================================================================================================================
// 3. The image on the real v2 runtime
// =================================================================================================================
console.log('\n3. Code generation and linking on the real v2 runtime');
if (!RT2) skip_('image checks', 'arcade/build/v2/runtime.json does not exist (node arcade/tools/build-runtime-v2.mjs)');
else {
  const C = RT2.rt.constants, S = RT2.rt.symbols;
  const rd16 = (m, a) => m[a] | (m[a + 1] << 8);
  /** n scenes with the same names; scene k enters scene (k + 1) mod n from its FRAME; the first has `extra` too */
  const nScenes = (n, { vars = true, maps = false } = {}) => {
    let s = `GAME "n"\nFRAMERATE 30\nSPRITE ship = "orb"\n${maps ? 'TILESET ts = "ts"\nMAP ma = "m1"\n' : ''}DIM g\n`;
    for (let k = 0; k < n; k++) s += scene('s' + k, { decl: vars ? `DIM x, y, z\nDIM q(${k + 1})` : '', procs: '  PROC UPDATE()\n    g = g + ' + (k + 1) + '\n  ENDP\n', frame: `    CALL UPDATE()\n    ENTER s${(k + 1) % n}` });
    return s;
  };
  const build = (src) => { const r = cmp(src, RT2); if (r.errors.length) throw new Error(errText(r)); return r; };
  const code = (r) => r.memory.slice(r.gen.base, r.gen.base + r.gen.code.length);
  const hdr = (r) => ({ init: rd16(r.memory, C.GAME_BASE), frame: rd16(r.memory, C.GAME_BASE + 2) });
  const sym = (r) => r.gen.symbols.scene ?? r.map.scene ?? r.map.symbols?.scene;
  // -- driver size for 1, 2, 4, 8 scenes
  {
    const sizes = {};
    let allOk = true, why = '';
    for (const n of [1, 2, 4, 8]) { try { sizes[n] = build(nScenes(n)).gen.code.length; } catch (e) { allOk = false; why += `${n} scenes: ${e.message}; `; } }
    check_('1, 2, 4 and 8 scene programs (each scene with variables, a PROC UPDATE and an ENTER) compile', allOk, why);
    if (allOk) {
      info(`code bytes (all code of the game, driver included): 1 scene + ENTER of itself ${sizes[1]}, 2 scenes ${sizes[2]}, 4 scenes ${sizes[4]}, 8 scenes ${sizes[8]}`);
      check_('the code grows with the number of scenes (1 < 2 < 4 < 8)', sizes[1] < sizes[2] && sizes[2] < sizes[4] && sizes[4] < sizes[8], JSON.stringify(sizes));
      const triv = (n) => build(`GAME "n"\nFRAMERATE 30\nSPRITE ship = "orb"\n` + Array.from({ length: n }, (_, k) => scene('s' + k, { frame: `    ENTER s${(k + 1) % n}` })).join('')).gen.code.length;
      const tr = { 1: triv(1), 2: triv(2), 4: triv(4), 8: triv(8) };
      info(`the same with EMPTY scenes (INIT empty, FRAME = one ENTER): ${JSON.stringify(tr)} bytes in all`);
      check_('the code of 1, 2, 4, 8 empty scenes grows monotonically', tr[1] < tr[2] && tr[2] < tr[4] && tr[4] < tr[8], JSON.stringify(tr));
      check_('8 empty scenes (driver + 8 ENTERs + 8 variable-less scenes) take less than 400 bytes of code in all', tr[8] < 400, `${tr[8]} bytes`);
      const base = build(`GAME "n"\nFRAMERATE 30\nSPRITE ship = "orb"\nDIM g\n` + scene('s0', { decl: 'DIM x, y, z\nDIM q(1)', procs: '  PROC UPDATE()\n    g = g + 1\n  ENDP\n', frame: '    CALL UPDATE()' })).gen.code.length;
      const driver1 = sizes[1] - base - 5;
      info(`driver of ONE scene: ${sizes[1]} - ${base} (the same scene without ENTER, no driver) - 5 (the ENTER) = ${driver1} bytes; per added scene: ${((sizes[8] - sizes[1]) / 7).toFixed(1)} bytes including its PROC UPDATE, its ENTER and its dispatch`);
      check_('the driver of a one-scene game is "roughly 90 bytes" (contract section 7): between 40 and 180', driver1 >= 40 && driver1 <= 180, `${driver1}`);
      const perScene = (sizes[8] - sizes[2]) / 6;
      check_('each further scene costs "about 14 bytes" for the driver + 5 per ENTER + its own PROC UPDATE (about 12 bytes): less than 60', perScene > 0 && perScene < 60, perScene.toFixed(1));
    }
  }
  // -- header, symbols.scene, usage
  {
    const r = build(nScenes(3));
    const h = hdr(r), p = r.map.procs;
    check_('header init / frame are the driver\'s entries (map.entries), not the first scene\'s PROC INIT / FRAME', h.init === r.map.entries.init && h.frame === r.map.entries.frame && h.init !== p['S0.INIT'] && h.frame !== p['S0.FRAME'], `${h.init.toString(16)} ${h.frame.toString(16)} vs ${p['S0.INIT']?.toString(16)} ${p['S0.FRAME']?.toString(16)}`);
    const sy = sym(r);
    check_('symbols.scene exists with cur, count and names', !!sy && typeof sy.cur === 'number' && sy.count === 3 && Array.isArray(sy.names) && sy.names.map((x) => String(x).toUpperCase()).join() === 'S0,S1,S2', JSON.stringify(sy));
    if (sy) check_('symbols.scene.cur lies in the game\'s variable area (hidden slot)', sy.cur >= C.GAME_VARS_BASE && sy.cur <= C.GAME_VARS_LIMIT, `0x${sy.cur.toString(16)}`);
    check_('usage.codegen.scenes is the scene count', r.usage.codegen.scenes === 3, JSON.stringify(r.usage.codegen));
    check_('the PROCs, variables and arrays are keyed SCENE.NAME (S0.INIT, S1.UPDATE, S2.X, S1.Q), game level plain (G)', ['S0.INIT', 'S0.FRAME', 'S1.UPDATE', 'S2.UPDATE'].every((k) => p[k] !== undefined) && ['S2.X', 'S1.Y', 'G'].every((k) => r.map.vars[k] !== undefined) && ['S0.Q', 'S1.Q', 'S2.Q'].every((k) => r.map.arrays?.[k]), JSON.stringify({ procs: Object.keys(p), vars: Object.keys(r.map.vars), arrays: Object.keys(r.map.arrays ?? {}) }));
    const want = sceneKeys(nScenes(3), parse);
    check_('map.vars / map.arrays / map.procs hold exactly the contract keys (sceneKeys of the source)', JSON.stringify(Object.keys(r.map.vars).sort()) === JSON.stringify([...want.vars].sort()) && JSON.stringify(Object.keys(r.map.arrays ?? {}).sort()) === JSON.stringify([...want.arrays].sort()) && JSON.stringify(Object.keys(p).sort()) === JSON.stringify([...want.procs].sort()), `vars ${Object.keys(r.map.vars)} procs ${Object.keys(p)}`);
    const one = build(`GAME "n"\nFRAMERATE 30\nSPRITE ship = "orb"\n` + scene('s0', { decl: 'DIM x', frame: '    x = x + 1' }));
    check_('a one-scene game without ENTER has no driver: the header\'s frame entry IS PROC FRAME, there is no symbols.scene, and the keys stay plain', hdr(one).frame === one.map.procs.FRAME && !sym(one) && one.map.vars.X !== undefined && Object.keys(one.map.procs).join() === 'INIT,FRAME', JSON.stringify(Object.keys(one.map.procs)));
    const self = build(`GAME "n"\nFRAMERATE 30\nSPRITE ship = "orb"\n` + scene('s0', { decl: 'DIM x', frame: '    x = x + 1\n    IF x > 5 THEN ENTER s0 ENDIF' }));
    check_('a one-scene game WITH ENTER of itself gets the driver (the header\'s frame entry is not PROC FRAME) and keeps plain keys', hdr(self).frame !== self.map.procs.FRAME && !!sym(self) && self.map.vars.X !== undefined && self.map.procs.INIT !== undefined && !Object.keys(self.map.vars).some((k) => k.includes('.')), JSON.stringify(Object.keys(self.map.vars)));
  }
  // -- slots: each scene's variables in one block, in scene order, after the game level; no overlap
  {
    const src = `GAME "n"\nFRAMERATE 30\nSPRITE ship = "orb"\nDIM g1, g2\nDIM ga(3)\n` + [0, 1, 2, 3].map((k) => scene('s' + k, { decl: `DIM x, y\nDIM q(${k + 2}) = 1, 2\nDIM z`, frame: `    x = x + 1\n    ENTER s${(k + 1) % 4}` })).join('');
    const r = build(src);
    const size = (key) => (r.map.arrays?.[key] ? 2 * (r.map.arrays[key].n + 1) : 2);
    const addr = (key) => r.map.arrays?.[key]?.addr ?? r.map.vars[key];
    const gameKeys = ['G1', 'G2', 'GA'], sceneKeysOf = (k) => [`S${k}.X`, `S${k}.Y`, `S${k}.Q`, `S${k}.Z`];
    const range = (keys) => { const lo = Math.min(...keys.map(addr)), hi = Math.max(...keys.map((x) => addr(x) + size(x))); return { lo, hi, sum: keys.reduce((s, x) => s + size(x), 0) }; };
    const g = range(gameKeys), sc = [0, 1, 2, 3].map((k) => range(sceneKeysOf(k)));
    info(`slot ranges: game 0x${g.lo.toString(16)}..0x${g.hi.toString(16)}; scenes ${sc.map((x, k) => `s${k} 0x${x.lo.toString(16)}..0x${x.hi.toString(16)}`).join(', ')}`);
    check_('each scene\'s variables and arrays form ONE contiguous block (the span equals the sum of the sizes)', sc.every((x) => x.hi - x.lo === x.sum), JSON.stringify(sc));
    check_('the blocks of different scenes do not overlap and run in scene order', sc.every((x, k) => k === 0 || sc[k - 1].hi <= x.lo), JSON.stringify(sc));
    check_('every scene block lies after the game-level slots', sc.every((x) => x.lo >= g.hi), `${g.hi} vs ${sc[0].lo}`);
    const all = [...gameKeys, ...[0, 1, 2, 3].flatMap(sceneKeysOf)];
    const spans = all.map((k) => [addr(k), addr(k) + size(k)]).sort((a, b) => a[0] - b[0]);
    check_('no two named slots overlap anywhere', spans.every((s, i) => i === 0 || spans[i - 1][1] <= s[0]));
    check_('all of them lie inside GAME_VARS', spans.every(([a, b]) => a >= C.GAME_VARS_BASE && b - 1 <= C.GAME_VARS_LIMIT));
    const sy = sym(r);
    if (sy) check_('the hidden scene index is outside every named slot', !spans.some(([a, b]) => sy.cur >= a && sy.cur < b), `0x${sy.cur.toString(16)}`);
    // READING: contract section 4.5 says three hidden slots (scene, saved SP, a scratch); section 14 (as built) says two were enough. The test asks for at least the two that every design needs.
    const named = spans.reduce((s, [a, b]) => s + (b - a), 0), hidden = r.usage.varBytes - named;
    info(`hidden driver slots: ${hidden / 2} (${hidden} bytes; section 4.5 of the contract says 3, section 14 says 2 were built)`);
    check_('the variables count in GAME_VARS like any variable: usage.varBytes covers the named slots plus at least the 2 hidden ones (scene index, saved SP)', hidden >= 4, `varBytes ${r.usage.varBytes}, named ${named}`);
  }
  // -- the bytes of the driver (contract section 5's listing)
  {
    const N = 3, src = nScenes(N);
    const r = build(src), c = code(r), base = r.gen.base;
    const sy = sym(r), p = r.map.procs;
    const o = (a) => a - base;
    const w = (a) => [a & 255, a >> 8];
    // frame$entry: LD (scn$sp),SP ; LD A,(scn$cur) ; OR A ; JP Z,s0 ; DEC A ; JP Z,s1 ... ; JP s(n-1)
    const fe = o(r.map.entries.frame);
    const spAddr = c[fe + 2] | (c[fe + 3] << 8);
    check_('frame$entry begins LD (scn$sp),SP (ED 73 nn nn) with nn a hidden slot', c[fe] === 0xED && c[fe + 1] === 0x73 && spAddr >= C.GAME_VARS_BASE && spAddr <= C.GAME_VARS_LIMIT, `${c[fe].toString(16)} ${c[fe + 1].toString(16)} -> 0x${spAddr.toString(16)}`);
    if (sy) {
      const want = [0xED, 0x73, ...w(spAddr), 0x3A, ...w(sy.cur), 0xB7, 0xCA, ...w(p['S0.FRAME']), 0x3D, 0xCA, ...w(p['S1.FRAME']), 0xC3, ...w(p['S2.FRAME'])];
      check_('frame$entry dispatch (contract listing for 3 scenes): LD A,(scn$cur); OR A; JP Z,s0; DEC A; JP Z,s1; JP s2 -- tail jumps to each scene\'s FRAME', want.every((b, i) => c[fe + i] === b), `got ${Array.from(c.slice(fe, fe + want.length), (b) => b.toString(16)).join(' ')}`);
      check_('scn$sp and scn$cur are different slots', spAddr !== sy.cur);
    }
    // entry$init: ... LD (scn$sp),SP ; JP P$s0$INIT
    const ie = o(r.map.entries.init);
    const tail = [0xED, 0x73, ...w(spAddr), 0xC3, ...w(p['S0.INIT'])];
    let found = -1;
    for (let i = ie; i < Math.min(c.length - tail.length, ie + 400); i++) if (tail.every((b, k) => c[i + k] === b)) { found = i; break; }
    check_('entry$init ends with LD (scn$sp),SP ; JP P$s0$INIT (the INIT\'s RET returns to the runtime)', found >= 0, 'sequence not found within 400 bytes of the init entry');
    // ENTER k = LD A,k ; JP scn$enter (5 bytes)
    const targets = new Set(), seen = [];
    for (let k = 0; k < N; k++) {
      let at_ = -1;
      for (let i = 0; i < c.length - 4; i++) if (c[i] === 0x3E && c[i + 1] === k && c[i + 2] === 0xC3 && (c[i + 3] | (c[i + 4] << 8)) >= base && (c[i + 3] | (c[i + 4] << 8)) < base + c.length) { at_ = i; break; }
      seen.push(at_);
      if (at_ >= 0) targets.add(c[at_ + 3] | (c[at_ + 4] << 8));
    }
    check_('each ENTER k is LD A,k ; JP scn$enter (3E k C3 nn nn): found for k = 0, 1, 2, all jumping to ONE routine', seen.every((x) => x >= 0) && targets.size === 1, `positions ${seen}, targets ${[...targets].map((t) => t.toString(16))}`);
    if (targets.size === 1) {
      const e = o([...targets][0]);
      const sp2 = c[e + 2] | (c[e + 3] << 8);
      check_('scn$enter begins LD SP,(scn$sp) (ED 7B nn nn, the same slot) ; PUSH AF ; CALL scn$reset ; POP AF ; LD (scn$cur),A', c[e] === 0xED && c[e + 1] === 0x7B && sp2 === spAddr && c[e + 4] === 0xF5 && c[e + 5] === 0xCD && c[e + 8] === 0xF1 && c[e + 9] === 0x32 && sy && (c[e + 10] | (c[e + 11] << 8)) === sy.cur, `got ${Array.from(c.slice(e, e + 12), (b) => b.toString(16)).join(' ')}`);
      const reset = o(c[e + 6] | (c[e + 7] << 8));
      // scn$reset: CALL RT_SILENCE ; hide loop (CALL RT_HIDE) ; XOR A / CALL RT_INK ; XOR A / CALL RT_BRIGHT ; LD A,7 / CALL RT_PAPER ; LD A,BORDER_COLOUR / CALL RT_BORDER ; CALL RT_CLS ; RET
      const seqAt = (from, bytes, lim = 400) => { for (let i = from; i < Math.min(c.length - bytes.length, from + lim); i++) if (bytes.every((b, k) => c[i + k] === b)) return i; return -1; };
      const bc = C.BORDER_COLOUR ?? S.BORDER_COLOUR ?? 1;
      const callAt = (a) => seqAt(reset, [0xCD, ...w(a)]);
      const iSil = callAt(S.RT_SILENCE), iHide = callAt(S.RT_HIDE);
      const iInk = seqAt(reset, [0xAF, 0xCD, ...w(S.RT_INK)]), iBr = seqAt(reset, [0xAF, 0xCD, ...w(S.RT_BRIGHT)]), iPap = seqAt(reset, [0x3E, 0x07, 0xCD, ...w(S.RT_PAPER)]);
      const iBor = seqAt(reset, [0x3E, bc, 0xCD, ...w(S.RT_BORDER)]), iCls = callAt(S.RT_CLS), iMap = callAt(S.RT_LOADMAP);
      check_('scn$reset: every routine of contract section 3 is called: RT_SILENCE, RT_HIDE, XOR A/RT_INK, XOR A/RT_BRIGHT, LD A,7/RT_PAPER, LD A,BORDER_COLOUR/RT_BORDER, RT_CLS', [iSil, iHide, iInk, iBr, iPap, iBor, iCls].every((x) => x >= 0), JSON.stringify({ iSil, iHide, iInk, iBr, iPap, iBor, iCls }));
      check_('... in the order sound, sprites, text state, border, screen (RT_INK / RT_BRIGHT / RT_PAPER among themselves in either order: section 3 and 5 list them differently)', iSil < iHide && iHide < Math.min(iInk, iBr, iPap) && Math.max(iInk, iBr, iPap) < iBor && iBor < iCls, JSON.stringify({ iSil, iHide, iInk, iBr, iPap, iBor, iCls }));
      check_('no map declared: RT_LOADMAP is not called by the reset', iMap < 0, `at ${iMap}`);
      check_('the reset does not call RT_SHOWF on the v2 runtime (no frames)', S.RT_SHOWF === undefined);
      // with a map
      const rm = build(nScenes(2, { maps: true })), cm_ = code(rm), em = rm.map.entries.frame - rm.gen.base;
      void em;
      const loadmapCalls = []; for (let i = 0; i < cm_.length - 2; i++) if (cm_[i] === 0xCD && (cm_[i + 1] | (cm_[i + 2] << 8)) === S.RT_LOADMAP) loadmapCalls.push(i);
      check_('a game with a screen MAP: the reset calls RT_LOADMAP (XOR A before it: map 0 at the first map) after RT_CLS', loadmapCalls.length >= 1 && cm_[loadmapCalls[0] - 1] === 0xAF, `calls at ${loadmapCalls}`);
      check_('... and the image uses the extended header and map table (as if the program had a LOADMAP): header length 20; the same game with ONE scene and no ENTER has the 16-byte header', rm.usage.header === C.GAME_HEADER_EXT_LEN && build(`GAME "n"\nFRAMERATE 30\nSPRITE ship = "orb"\nTILESET ts = "ts"\nMAP ma = "m1"\n` + scene('s0')).usage.header === C.GAME_HEADER_LEN, `${rm.usage.header} / ext ${C.GAME_HEADER_EXT_LEN}`);
    }
  }
  // -- qualified labels: two scenes with PROC UPDATE call their own
  {
    const src = `GAME "n"\nFRAMERATE 30\nSPRITE ship = "orb"\nDIM g\nPROC GP()\n  g = g + 100\nENDP\n` + ['a', 'b', 'c'].map((n, k) => scene(n, { decl: `DEF FN f(x) = x + ${k}`, procs: '  PROC UPDATE()\n    g = g + FN f(1)\n  ENDP\n', frame: `    CALL UPDATE()\n    CALL GP()\n    ENTER ${'bca'[k]}` })).join('');
    const r = build(src), p = r.map.procs, c = code(r), base = r.gen.base;
    check_('PROC UPDATE in three scenes: three different addresses, keyed A.UPDATE B.UPDATE C.UPDATE; the game-level PROC GP keeps its plain key', ['A.UPDATE', 'B.UPDATE', 'C.UPDATE'].every((k) => p[k] !== undefined) && new Set([p['A.UPDATE'], p['B.UPDATE'], p['C.UPDATE']]).size === 3 && p.GP !== undefined && p['A.GP'] === undefined, JSON.stringify(p));
    const calls = (from, to) => { const out = []; for (let i = from - base; i < to - base - 2; i++) if (c[i] === 0xCD) out.push(c[i + 1] | (c[i + 2] << 8)); return out; };
    const order = ['A', 'B', 'C'].map((n) => p[`${n}.FRAME`]);
    const frameRange = (n) => { const addr = p[`${n}.FRAME`], next = Object.values(p).filter((x) => x > addr).sort((x, y) => x - y)[0] ?? base + c.length; return [addr, next]; };
    let ok = true, why = '';
    for (const n of ['A', 'B', 'C']) {
      const [lo, hi] = frameRange(n), cs = calls(lo, hi);
      for (const m of ['A', 'B', 'C']) if ((cs.includes(p[`${m}.UPDATE`])) !== (m === n)) { ok = false; why += `${n}.FRAME ${cs.includes(p[`${m}.UPDATE`]) ? 'calls' : 'does not call'} ${m}.UPDATE; `; }
      if (!cs.includes(p.GP)) { ok = false; why += `${n}.FRAME does not call GP; `; }
    }
    void order;
    check_('each scene\'s FRAME contains a CALL of ITS OWN UPDATE and not the other scenes\', and a CALL of the game-level GP', ok, why);
    const fnk = Object.keys(r.map.fns ?? {}).sort().join();
    check_('the DEF FNs are keyed A.F B.F C.F', fnk === 'A.F,B.F,C.F', fnk);
  }
  // -- a program with a driver and the arithmetic of INIT clearing: a scene variable block bigger than 255 bytes (LDIR with BC > 255)
  {
    const src = `GAME "n"\nFRAMERATE 30\nSPRITE ship = "orb"\nDIM g\n` + scene('a', { decl: 'DIM big(400) = 1, 2, 3\nDIM x', frame: '    big(400) = g\n    ENTER b' }) + scene('b', { decl: 'DIM small(2) = 7', frame: '    ENTER a' });
    const r = cmp(src, RT2);
    check_('a scene with a 401-element array (802 bytes: its clear and its initialiser copy are longer than 255) compiles', r.errors.length === 0, errText(r));
  }
}

// =================================================================================================================
// 4. Everything the differential suite runs compiles
// =================================================================================================================
console.log('\n4. The generated and hand-written programs compile');
{
  const N = QUICK ? 40 : 300;
  if (!RT2) skip_('compiling the generated programs', 'no v2 runtime');
  else {
    let bad = 0, why = '', warnBad = 0, wwhy = '';
    for (let s = 1; s <= N; s++) {
      const g = genProgram(s);
      const e = errs(g.src, 2);
      const r = cmp(g.src, RT2);
      if (e.length || r.errors.length) { bad++; why ||= `seed ${s}: ${msgs(e) || errText(r)}`; }
      const kk = sceneKeys(g.src, parse);
      if (r.map && (Object.keys(r.map.vars).length !== kk.vars.length || Object.keys(r.map.arrays ?? {}).length !== kk.arrays.length)) { warnBad++; wwhy ||= `seed ${s}: ${Object.keys(r.map.vars).length} vars, sceneKeys ${kk.vars.length}`; }
    }
    check_(`${N} generated 2-4 scene programs parse, check and compile on the v2 runtime`, bad === 0, `${bad} failed; ${why}`);
    check_('... and map.vars / map.arrays hold the contract\'s keys for every one of them (count)', warnBad === 0, `${warnBad}: ${wwhy}`);
    let hb = 0, hw = '';
    for (const [k, src] of Object.entries(HAND)) { const r = cmp(src, RT2); if (r.errors.length) { hb++; hw += `${k}: ${errText(r)}; `; } }
    check_(`${Object.keys(HAND).length} hand-written programs compile`, hb === 0, hw);
  }
  for (const [label, R, gen] of [['v3', RT3, genV3], ['v4', RT4, genV4]]) {
    if (!R || (R.rt.symbols.RT_SHOWF === undefined)) { skip_(`${label} templates compile`, `arcade/build/${label}/runtime.json missing or lacks RT_SHOWF`); continue; }
    let bad = 0, why = '';
    for (let s = 1; s <= (QUICK ? 6 : 20); s++) { const g = gen(s); const r = cmp(g.src, R); if (r.errors.length) { bad++; why ||= `variant ${s}: ${errText(r)}`; } }
    check_(`${QUICK ? 6 : 20} ${label} template variants (scenes + ${label === 'v3' ? 'WINDOW and frames' : 'VIEW3D'}) compile on the real ${label} runtime`, bad === 0, why);
    if (!bad) {
      const g = gen(1), r = cmp(g.src, R), c = r.memory.slice(r.gen.base, r.gen.base + r.gen.code.length), S = R.rt.symbols;
      let n = 0; for (let i = 0; i < c.length - 2; i++) if (c[i] === 0xCD && (c[i + 1] | (c[i + 2] << 8)) === S.RT_SHOWF) n++;
      check_(`${label}: the reset calls RT_SHOWF (shown at 0, 0 frame 0 before RT_HIDE); the code has at least one call`, n >= 1, `${n} calls`);
    }
  }
  // the RNG helper is the one the other suites use (a guard against an accidental change of the generator's seeds)
  check_('the generator is deterministic per seed', genProgram(7).src === genProgram(7).src && genProgram(7).src !== genProgram(8).src && rng(1)() === rng(1)());
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? ` (${skipped} skipped)` : ''}`);
process.exit(failed === 0 ? 0 : 1);
