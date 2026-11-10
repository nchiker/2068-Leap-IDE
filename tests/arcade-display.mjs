/**
 * tests/arcade-display.mjs — the per-scene display plan (src/lang/arcade/arcade-display.js), language batch 4 section 10.
 *
 *   node tests/arcade-display.mjs
 *
 * Pure: no ROMs, no browser. One check per rule: each `auto` outcome and its reason, reachability through CALL and DEF FN, scene-level versus game-level
 * PROC shadowing, WINDOW / VIEW3D forcing two buffers, FRAME versus INIT redraw, the overrides (auto / buffers / fine / hires / garbage) with their exact
 * warning texts, never throwing, and the compile() integration (out.scenes, the warnings on the scene's line). Exits 1 on a failure.
 */

"use strict";

import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { parse } = await import(join(ROOT, 'src/lang/arcade/arcade-parse.js'));
const { sceneDisplayPlan, DISPLAY_SETUPS } = await import(join(ROOT, 'src/lang/arcade/arcade-display.js'));
const { compile } = await import(join(ROOT, 'src/lang/arcade/arcade-compile.js'));

let failed = 0, total = 0;
function check(name, ok, detail = '') {
  total++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail && !ok ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
const json = (v) => JSON.stringify(v);
const same = (name, got, want) => check(name, json(got) === json(want), `got ${json(got)}, want ${json(want)}`);

const R_SPRITES = 'two display files flipped each tick, because sprites move';
const R_WINDOW = 'two display files flipped each tick, because the window or 3D view is drawn';
const R_REDRAW = 'two display files flipped each tick, because FRAME redraws text or tiles';
const R_FINE = 'a static picture: 8 x 1 colour would give a colour per pixel row';
const R_HIRES = 'text only: 512 x 192 hi-res would give 64 columns';

/** One scene: `init` and `frame` are the PROC bodies, `extra` more scene-level declarations. */
const scene = (name, init = '', frame = '', extra = '') =>
  `SCENE ${name}\n  DIM v\n${extra}  PROC INIT()\n${init}  ENDP\n  PROC FRAME()\n${frame}  ENDP\nENDSCENE\n`;
const HEAD = 'SPRITE ball = "ball"\nTILESET gfx = "gfx"\nMAP sky = "sky"\n';
const plan = (text, scenes) => sceneDisplayPlan(parse(text).ast, { scenes });
const one = (text, scenes) => plan(text, scenes)[0];

// ── the three outcomes and their reasons ──
{
  const sprites = one(HEAD + scene('a', '', '    SHOW ball AT 10, 10\n'));
  check('SHOW in FRAME: buffers, "because sprites move"', sprites.auto === 'buffers' && sprites.reason === R_SPRITES, json(sprites));
  const hide = one(HEAD + scene('a', '    HIDE ball\n'));
  check('HIDE in INIT alone: buffers, sprites', hide.auto === 'buffers' && hide.reason === R_SPRITES, json(hide));
  const initShow = one(HEAD + scene('a', '    SHOW ball AT 1, 1\n'));
  check('SHOW in INIT only counts as sprites (the sprite stays and the flip is needed)', initShow.auto === 'buffers' && initShow.reason === R_SPRITES);
  for (const [word, line] of [['PRINT', '    PRINT "hi"\n'], ['TILE', '    TILE 1, 1 = 2\n'], ['FILL', '    FILL 0, 0, 4, 4 = 1\n'], ['COPY', '    COPY 0, 0, 2, 2 TO 4, 4\n'], ['LOADMAP', '    LOADMAP sky AT 0, 0\n'], ['CLS', '    CLS\n']]) {
    const p = one(HEAD + scene('a', '', line));
    check(`${word} reachable from FRAME: buffers, "because FRAME redraws text or tiles"`, p.auto === 'buffers' && p.reason === R_REDRAW, json(p));
  }
  for (const [word, line] of [['TILE', '    TILE 1, 1 = 2\n'], ['FILL', '    FILL 0, 0, 4, 4 = 1\n'], ['COPY', '    COPY 0, 0, 2, 2 TO 4, 4\n'], ['LOADMAP', '    LOADMAP sky AT 0, 0\n']]) {
    const p = one(HEAD + scene('a', line, ''));
    check(`${word} only in INIT: fine, "a static picture"`, p.auto === 'fine' && p.reason === R_FINE && p.setting === 'fine', json(p));
  }
  const text = one(HEAD + scene('a', '    PRINT "TITLE"\n', ''));
  check('PRINT / CLS only in INIT: hires, "text only"', text.auto === 'hires' && text.reason === R_HIRES, json(text));
  const empty = one(HEAD + scene('a'));
  check('an empty scene: hires (the else of the rule)', empty.auto === 'hires' && empty.reason === R_HIRES);
  const cls = one(HEAD + scene('a', '    CLS\n    TILE 1, 1 = 2\n', ''));
  check('CLS then TILE in INIT: fine (CLS alone does not redraw per frame)', cls.auto === 'fine');
  const rest = one(HEAD + scene('a', '    TILE 1, 1 = 2\n', '    v = v + 1\n'));
  check('a FRAME that does no drawing leaves the INIT picture static: fine', rest.auto === 'fine');
  const sp = one(HEAD + scene('a', '    TILE 1, 1 = 2\n', '    SHOW ball AT 1, 1\n'));
  check('sprites win over a tile picture: buffers, sprites', sp.auto === 'buffers' && sp.reason === R_SPRITES);
  const ord = one(HEAD + 'WINDOW sky AT 0, 0\n' + scene('a', '', '    PRINT "x"\n'));
  check('window beats FRAME redraw in the reason order', ord.auto === 'buffers' && ord.reason === R_WINDOW);
}

// ── output shape ──
{
  const text = HEAD + scene('title', '    PRINT "T"\n') + scene('play', '', '    SHOW ball AT 1, 1\n') + scene('over', '    TILE 1, 1 = 2\n');
  const p = plan(text);
  same('one entry per scene, in source order', p.map((s) => s.name), ['title', 'play', 'over']);
  same('their autos', p.map((s) => s.auto), ['hires', 'buffers', 'fine']);
  const at = parse(text).ast.scenes[1].namePos;
  check('line / col are the scene name\'s', p[1].line === at.line && p[1].col === at.col && p[1].line === text.split('\n').findIndex((l) => l.startsWith('SCENE play')) + 1 && p[1].col === 6, json(p[1]));
  check('every entry has the contract\'s fields, built "buffers", empty notes, override "auto" without a project',
    p.every((s) => json(Object.keys(s)) === json(['name', 'line', 'col', 'auto', 'reason', 'override', 'setting', 'built', 'notes']) && s.built === 'buffers' && s.notes.length === 0 && s.override === 'auto' && s.setting === s.auto));
  same('a program without scenes gives an empty plan', plan('GAME "x"\n'), []);
  same('DISPLAY_SETUPS', DISPLAY_SETUPS, ['auto', 'buffers', 'fine', 'hires']);
}

// ── reachability: CALL, DEF FN, scope ──
{
  const call = one(HEAD + 'SCENE a\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    CALL draw()\n  ENDP\n  PROC draw()\n    SHOW ball AT 1, 1\n  ENDP\nENDSCENE\n');
  check('SHOW in a scene PROC called from FRAME is reached', call.auto === 'buffers' && call.reason === R_SPRITES);
  const deep = one(HEAD + 'SCENE a\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    CALL one()\n  ENDP\n  PROC one()\n    CALL two()\n  ENDP\n  PROC two()\n    PRINT "x"\n  ENDP\nENDSCENE\n');
  check('reached through two CALLs', deep.auto === 'buffers' && deep.reason === R_REDRAW);
  const never = one(HEAD + 'SCENE a\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\n  PROC unused()\n    SHOW ball AT 1, 1\n  ENDP\nENDSCENE\n');
  check('a PROC nobody calls is not reached', never.auto === 'hires');
  const inIf = one(HEAD + 'SCENE a\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    IF v = 1 THEN\n      WHILE v < 3\n        FOR v = 1 TO 2\n          SELECT CASE v\n            CASE 1\n              CALL draw()\n          ENDSEL\n        NEXT\n      WEND\n    ENDIF\n  ENDP\n  PROC draw()\n    PRINT "x"\n  ENDP\nENDSCENE\n');
  check('a CALL nested in IF / WHILE / FOR / SELECT is reached', inIf.auto === 'buffers' && inIf.reason === R_REDRAW, json(inIf));
  const fn = one(HEAD + 'SCENE a\n  DEF FN f(x) = FN g(x) + 1\n  DEF FN g(x) = x\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    v = FN f(1)\n  ENDP\nENDSCENE\n');
  check('a DEF FN chain is followed (and a DEF FN has no statements to find)', fn.auto === 'hires');
  const cycle = one(HEAD + 'SCENE a\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    CALL x1()\n  ENDP\n  PROC x1()\n    CALL x2()\n  ENDP\n  PROC x2()\n    IF v = 0 THEN\n      CALL x1()\n    ENDIF\n    CLS\n  ENDP\nENDSCENE\n');
  check('mutually recursive PROCs terminate', cycle.auto === 'buffers' && cycle.reason === R_REDRAW);
  const top = one(HEAD + 'PROC helper()\n  SHOW ball AT 1, 1\nENDP\n' + scene('a', '', '    CALL helper()\n'));
  check('a game-level PROC called from FRAME is reached', top.auto === 'buffers' && top.reason === R_SPRITES);
  const topInit = one(HEAD + 'PROC helper()\n  TILE 1, 1 = 2\nENDP\n' + scene('a', '    CALL helper()\n'));
  check('a game-level PROC called from INIT is reached: fine', topInit.auto === 'fine');
  const topFrom = one(HEAD + 'PROC helper()\n  PRINT "x"\nENDP\n' + scene('a', '    CALL helper()\n', ''));
  check('INIT-only reach of a PRINT (no FRAME redraw): hires', topFrom.auto === 'hires');
  const topFn = one(HEAD + 'DEF FN g(x) = x\n' + scene('a', '', '    v = FN g(1)\n'));
  check('a game-level DEF FN used from FRAME does not change the plan', topFn.auto === 'hires');
}

// ── frame versus init ──
{
  const both = one(HEAD + 'PROC helper()\n  PRINT "x"\nENDP\n' + scene('a', '    CALL helper()\n', '    CALL helper()\n'));
  check('the same PROC from INIT and FRAME counts for FRAME (the redraw rule)', both.auto === 'buffers' && both.reason === R_REDRAW);
  const a = one(HEAD + 'SCENE a\n  PROC INIT()\n    CALL p()\n  ENDP\n  PROC FRAME()\n    CALL q()\n  ENDP\n  PROC p()\n    PRINT "x"\n  ENDP\n  PROC q()\n    v = 1\n  ENDP\nENDSCENE\n');
  check('a PRINT reached from INIT only is not a per-frame redraw', a.auto === 'hires');
  const b = one(HEAD + 'SCENE a\n  PROC INIT()\n    CALL p()\n  ENDP\n  PROC FRAME()\n    CALL q()\n  ENDP\n  PROC p()\n    v = 1\n  ENDP\n  PROC q()\n    TILE 1, 1 = 1\n  ENDP\nENDSCENE\n');
  check('a TILE reached from FRAME only is a redraw (buffers), not a static INIT picture', b.auto === 'buffers' && b.reason === R_REDRAW);
}

// ── scope: scene-level PROCs shadow game-level ones; scenes do not see each other ──
{
  const text = HEAD + 'PROC helper()\n  SHOW ball AT 1, 1\nENDP\n'
    + 'SCENE a\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    CALL helper()\n  ENDP\n  PROC helper()\n    v = 1\n  ENDP\nENDSCENE\n'
    + 'SCENE b\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    CALL helper()\n  ENDP\nENDSCENE\n';
  const p = plan(text);
  check('scene a: its own helper (no sprites) shadows the game-level one: hires', p[0].auto === 'hires', json(p[0]));
  check('scene b: no helper of its own, the game-level one (SHOW) is reached: buffers', p[1].auto === 'buffers' && p[1].reason === R_SPRITES, json(p[1]));
  const text2 = HEAD + 'SCENE a\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    CALL draw()\n  ENDP\n  PROC draw()\n    CLS\n  ENDP\nENDSCENE\n'
    + 'SCENE b\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    CALL draw()\n  ENDP\n  PROC draw()\n    v = 1\n  ENDP\nENDSCENE\n';
  const q = plan(text2);
  check('two scenes with a PROC of the same name: each reads its own (a CLS, b nothing)', q[0].auto === 'buffers' && q[1].auto === 'hires', json(q.map((s) => s.auto)));
  const text3 = HEAD + 'DEF FN g(x) = x\nSCENE a\n  DEF FN g(x) = x + 1\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    v = FN g(1)\n  ENDP\nENDSCENE\n';
  check('a DEF FN with the name of a game-level one resolves in the scene first', plan(text3)[0].auto === 'hires');
  const ci = one(HEAD + 'SCENE a\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    call DRAW()\n  ENDP\n  PROC Draw()\n    cls\n  ENDP\nENDSCENE\n');
  check('names are case-insensitive', ci.auto === 'buffers' && ci.reason === R_REDRAW);
}

// ── WINDOW and VIEW3D ──
{
  const win = one(HEAD + 'WINDOW sky AT 0, 0\n' + scene('a'));
  check('a WINDOW forces buffers, "because the window or 3D view is drawn"', win.auto === 'buffers' && win.reason === R_WINDOW, json(win));
  const view = one(HEAD + 'VIEW3D sky\n' + scene('a'));
  check('a VIEW3D forces buffers too', view.auto === 'buffers' && view.reason === R_WINDOW, json(view));
  check('it applies to every scene of the game', plan(HEAD + 'WINDOW sky AT 0, 0\n' + scene('a') + scene('b', '    TILE 1, 1 = 1\n')).every((s) => s.auto === 'buffers' && s.reason === R_WINDOW));
  const ast = parse(HEAD + scene('a')).ast;
  ast.windows = [{}];
  check('read from ast.windows (hand-made AST)', sceneDisplayPlan(ast)[0].reason === R_WINDOW);
  const ast2 = parse(HEAD + scene('a')).ast;
  ast2.views = [{}];
  check('read from ast.views (hand-made AST)', sceneDisplayPlan(ast2)[0].reason === R_WINDOW);
}

// ── overrides ──
{
  const text = HEAD + scene('a', '', '    SHOW ball AT 1, 1\n') + scene('b', '    TILE 1, 1 = 1\n') + scene('c', '    PRINT "x"\n');
  const none = plan(text, {});
  check('no override: override "auto", setting = auto, no notes', none.every((s) => s.override === 'auto' && s.setting === s.auto && s.notes.length === 0));
  const auto = plan(text, { a: { display: 'auto' } });
  check('explicit "auto" is the same', auto[0].override === 'auto' && auto[0].setting === 'buffers' && auto[0].notes.length === 0);
  const buf = plan(text, { b: { display: 'buffers' } });
  check('"buffers" on a scene whose auto is fine: setting buffers, no note, auto unchanged', buf[1].auto === 'fine' && buf[1].setting === 'buffers' && buf[1].override === 'buffers' && buf[1].notes.length === 0, json(buf[1]));
  const fine = plan(text, { a: { display: 'fine' } });
  check('"fine": setting fine, built stays buffers, the exact not-built note',
    fine[0].setting === 'fine' && fine[0].built === 'buffers' && fine[0].override === 'fine' && json(fine[0].notes) === json(["scene 'a': display 'fine' (8 x 1 colour) is not built into any runtime yet; the scene is built with two buffers"]), json(fine[0]));
  const hires = plan(text, { c: { display: 'hires' } });
  check('"hires": the exact not-built note with 512 x 192 hi-res',
    hires[2].setting === 'hires' && json(hires[2].notes) === json(["scene 'c': display 'hires' (512 x 192 hi-res) is not built into any runtime yet; the scene is built with two buffers"]), json(hires[2]));
  const bad = plan(text, { a: { display: 'q' } });
  check('garbage: ignored (setting = auto), override kept as written, the exact "not a display setup" note',
    bad[0].setting === 'buffers' && bad[0].override === 'q' && json(bad[0].notes) === json(["scenes.a.display: 'q' is not a display setup (auto, buffers, fine, hires); ignored"]), json(bad[0]));
  const ci = plan(text, { a: { display: 'Fine' } });
  check('the value is read ignoring case and white space', ci[0].setting === 'fine' && ci[0].override === 'fine');
  const key = plan(text, { A: { display: 'fine' } });
  check('the scene is found by its name ignoring case', key[0].setting === 'fine');
  const other = plan(text, { zzz: { display: 'fine' }, b: { display: 'fine' } });
  check('an entry for a scene that does not exist changes nothing; the others are untouched', other[0].setting === 'buffers' && other[0].notes.length === 0 && other[1].setting === 'fine');
  const nonString = plan(text, { a: { display: 5 }, b: 'fine', c: null });
  check('a non-text display, a non-object entry or null are treated as auto, silently', nonString.every((s) => s.override === 'auto' && s.setting === s.auto && s.notes.length === 0));
  const extra = plan(text, { a: { display: 'buffers', color: 'x' } });
  check('other keys of an entry are ignored here', extra[0].setting === 'buffers');
  check('scenes given as something that is not an object are ignored', [null, 3, 'x', [], undefined].every((s) => plan(text, s).every((e) => e.override === 'auto')));
  const proto = plan(text, JSON.parse('{"__proto__": {"display": "fine"}, "constructor": {"display": "fine"}}'));
  check('"__proto__" / "constructor" keys do not leak into a scene', proto.every((s) => s.override === 'auto'));
}

// ── never throws ──
{
  const junk = [undefined, null, 0, 'x', {}, { scenes: null }, { scenes: [null, 3, {}] }, { scenes: [{ name: 'a', procs: [{ name: 'INIT', body: [null, { type: 'Call' }] }] }] },
    { scenes: [{ name: 'a', procs: null, decls: 5 }], procs: 7, windows: 'x' }];
  let threw = 0;
  for (const j of junk) { try { const r = sceneDisplayPlan(j); if (!Array.isArray(r)) threw++; } catch { threw++; } }
  check('a malformed AST gives a list and never throws', threw === 0);
  same('no ast gives []', sceneDisplayPlan(undefined), []);
  const cyc = parse(HEAD + scene('a')).ast;
  cyc.scenes[0].self = cyc.scenes[0];
  let ok = true; try { sceneDisplayPlan(cyc); } catch { ok = false; }
  check('a cyclic AST does not hang or throw', ok);
  const broken = parse('SCENE a\n  PROC INIT()\n    SHOW\n').ast;
  let ok2 = true; try { sceneDisplayPlan(broken); } catch { ok2 = false; }
  check('the partial AST of a program with syntax errors is accepted', ok2);
}

// ── compile() integration ──
{
  const runtime = { version: 2, symbols: {} };
  const text = 'GAME "x"\n' + HEAD + scene('a', '', '    SHOW ball AT 1, 1\n') + scene('b', '    TILE 1, 1 = 1\n');
  const out = compile(text, { scenes: { b: { display: 'fine' }, a: { display: 'q' } } });
  check('compile: out.scenes is set when the program checks (even though no runtime is given)', Array.isArray(out.scenes) && out.scenes.length === 2, json(out.errors));
  check('compile: out.scenes carries the plan', out.scenes[0].auto === 'buffers' && out.scenes[1].auto === 'fine' && out.scenes[1].setting === 'fine');
  const w = out.warnings.filter((d) => /display/.test(d.message));
  const lineA = text.split('\n').findIndex((l) => l.startsWith('SCENE a')) + 1;
  const lineB = text.split('\n').findIndex((l) => l.startsWith('SCENE b')) + 1;
  check('compile: both display warnings, severity "warning", at the scene\'s name',
    w.length === 2 && w.every((d) => d.severity === 'warning') &&
    w.some((d) => d.line === lineA && d.col === 6 && d.endCol === 7 && d.message === "scenes.a.display: 'q' is not a display setup (auto, buffers, fine, hires); ignored") &&
    w.some((d) => d.line === lineB && d.col === 6 && d.endCol === 7 && d.message === "scene 'b': display 'fine' (8 x 1 colour) is not built into any runtime yet; the scene is built with two buffers"), json(w));
  check('compile: the warnings are sorted by position', out.warnings.every((d, i, l) => i === 0 || l[i - 1].line < d.line || (l[i - 1].line === d.line && l[i - 1].col <= d.col)));
  const noOverride = compile(text, {});
  check('compile: without scenes there is no display warning', noOverride.warnings.every((d) => !/display/.test(d.message)) && noOverride.scenes.length === 2);
  const named = compile(text, { runtime, scenes: { b: { display: 'hires' } } });
  check('compile: with a runtime that cannot link, out.scenes is still there', Array.isArray(named.scenes) && named.scenes[1].setting === 'hires');
  const bad = compile('GAME "x"\nSCENE a\n  PROC INIT()\n    v = = 1\n  ENDP\nENDSCENE\n', { scenes: { a: { display: 'fine' } } });
  check('compile: a program with errors has no out.scenes and no display warning', bad.errors.length > 0 && bad.scenes === undefined && bad.warnings.every((d) => !/display/.test(d.message)));
  const nul = compile(text);
  check('compile: no second argument at all is fine', Array.isArray(nul.scenes));
}

console.log(failed ? `\n${failed} of ${total} check(s) FAILED` : `\nAll ${total} checks passed`);
process.exit(failed ? 1 : 0);
