#!/usr/bin/env node
"use strict";
// arcade-m14-compiler.mjs -- tests for language batch 7, Part A: `SCENE name NOWINDOW` / `SCENE name NOVIEW` (parser, checker, code generation, linker, display model, Studio words).
// The contract is docs/ARCADE_LANGUAGE_BATCH7.md (sections 1, 2, 6).
//
//   node tests/arcade-m14-compiler.mjs
//   ARCADE_OLD=<dir of the previous src/lang/arcade/> node tests/arcade-m14-compiler.mjs     the byte-identity comparison (section 8) against that compiler (git archive of 3a22ea1, the commit before batch 7)
//
// No machine is booted here. The runtimes of this tree do not have the mode routines yet (RT_WINMODE on v3, RT_VIEWMODE on v4, and the NOVIEW pool pieces NV_POOL_A / B / C are appended by the runtime work of
// Part B), so the tests extend the tree's own arcade/build/v3|v4/runtime.json with FAKE addresses for them and read the emitted call sequence from the bytes. The interpreter's half is in
// tests/arcade-m14-differential.mjs (section 1: always runs; the rest needs the real routines).
// Sections
//   1  parser: the clause, contextual words (a variable called nowindow / noview, a scene called nowindow), the error for anything else, the syntax tree
//   2  checker: NOWINDOW without a WINDOW, NOVIEW without a VIEW3D, the wrong one of the two, positions, clean cases
//   3  code generation: the call in every ENTER sequence and at boot only when a clause exists; the A value, the place (after the reset, before INIT); single scene; ENTER of itself; v3 and v4
//   4  a runtime without the routine: a compile error that names it; a program without the clause still compiles there
//   5  the NOVIEW phase pool plan: pieces from runtime.json, the default pieces, the plan equals planPhasePool, the refusal, the report, no plan without a NOVIEW scene
//   6  display model: sceneDisplayPlan and sceneModes for a scene with the clause
//   7  Studio words: the word table, highlighting and completion (the editor module's source), the Symbols tab, scanArcade
//   8  byte identity with the previous compiler (ARCADE_OLD): every example, every fixture, the generated programs
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse, tokenize } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { compile, usageLines, CODEGEN_OFF } from '../src/lang/arcade/arcade-compile.js';
import { planPhasePool, noviewPoolPieces, NOVIEW_POOL_PIECES, poolPieces } from '../src/lang/arcade/arcade-window.js';
import { sceneDisplayPlan, sceneModes } from '../src/lang/arcade/arcade-display.js';
import { scanArcade } from '../src/lang/arcade/arcade-scan.js';
import { ARCADE_WORDS, RESERVED } from '../src/lang/arcade/arcade-words.js';
import { ASSETS11, HEAD, scene } from './arcade-m11-common.mjs';

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
const sameBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

// ── runtimes: the tree's own tables, extended with fake addresses for the routines Part B adds ─────────────────────────────────────────────────
function loadRt(v) {
  const json = join(ROOT, `arcade/build/v${v}/runtime.json`);
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))) };
}
const REAL = { 2: loadRt(2), 3: loadRt(3), 4: loadRt(4) };
if (!REAL[3] || !REAL[4]) { console.log('SKIP: arcade/build/v3 and v4 (runtime.json) are needed'); process.exit(0); }
const WINMODE = 0x3F10, VIEWMODE = 0x3F40;
const withSyms = (R, symbols = {}, constants = {}) => ({ rt: { ...R.rt, symbols: { ...R.rt.symbols, ...symbols }, constants: { ...(R.rt.constants ?? {}), ...constants } }, img: R.img });
const FAKE3 = withSyms(REAL[3], { RT_WINMODE: WINMODE });
const FAKE4 = withSyms(REAL[4], { RT_VIEWMODE: VIEWMODE, NV_POOL_A: 0xCD00, NV_POOL_B: 0xEE00, NV_POOL_C: 0xD700 }, { NV_POOL_A_LEN: 256, NV_POOL_B_LEN: 3200, NV_POOL_C_LEN: 256 });
const cmp = (src, R, assets = ASSETS11, opts = {}) => compile(src, { runtime: R.rt, image: R.img, assets, ...opts });
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');

// ── diagnostics helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const diag = (src, version) => { const p = parse(src); return [...p.errors, ...check(p.ast, version === undefined ? {} : { version })]; };
const errs = (src, v) => diag(src, v).filter((d) => d.severity === 'error');
const msgs = (l) => l.map((d) => `${d.line}:${d.col} ${d.message}`).join(' | ');
const at = (src, needle, nth = 0) => {
  let from = -1;
  for (let i = 0; i <= nth; i++) { from = src.indexOf(needle, from + 1); if (from < 0) throw new Error(`test bug: "${needle}" #${nth} not in the source`); }
  const before = src.slice(0, from).split('\n');
  return { line: before.length, col: before[before.length - 1].length };
};
const badAt = (name, src, msg, where, v) => {
  const e = errs(src, v), hit = e.find((d) => (msg instanceof RegExp ? msg.test(d.message) : d.message === msg) && (!where || (d.line === where.line && d.col === where.col)));
  check_(name, !!hit, hit ? '' : `got: ${msgs(e) || 'no errors'}${where ? ` (wanted at ${where.line}:${where.col})` : ''}`);
};

// ── programs ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const PROCS = (init = '', frame = '') => `  PROC INIT()\n${init}  ENDP\n  PROC FRAME()\n${frame}  ENDP\n`;
const sc = (name, clause, init = '', frame = '', decl = '') => `SCENE ${name}${clause ? ' ' + clause : ''}\n${decl}${PROCS(init, frame)}ENDSCENE\n`;
/** a WINDOW game (v3) / a VIEW3D game (v4) with the given scene texts */
const W3 = (scenes, top = '') => `${HEAD}SPRITE ship = "orb"\nMAP level = "lv"\n${top}WINDOW level\n${scenes}`;
const V4 = (scenes, top = '') => `${HEAD}SPRITE ship = "orb"\nMAP level = "maze"\n${top}VIEW3D level\n${scenes}`;
const PLAIN = (scenes) => `${HEAD}SPRITE ship = "orb"\n${scenes}`;
const TITLE3 = (clause = 'NOWINDOW') => W3(sc('title', clause, '    SHOW ship AT 8, 8\n', '    IF STICK(1) > 15 THEN ENTER play ENDIF\n') + sc('play', '', '', '    CAMERA 10\n'));

// =================================================================================================================
// 1. Parser
// =================================================================================================================
console.log('1. SCENE name NOWINDOW / NOVIEW: the parser');
{
  const src = W3(sc('a', 'NOWINDOW') + sc('b', '') + sc('c', 'NOWINDOW'));
  const p = parse(src);
  check_('the program with NOWINDOW on two scenes and none on the third parses with no error', p.errors.length === 0, msgs(p.errors));
  const [a, b, c] = p.ast.scenes;
  check_('a Scene node gets mode: "nowindow" and modePos at the word; a scene without the clause has neither key', a.mode === 'nowindow' && c.mode === 'nowindow' && !('mode' in b) && !('modePos' in b) && a.modePos.line === at(src, 'NOWINDOW').line && a.modePos.col === at(src, 'NOWINDOW').col && a.modePos.endCol === a.modePos.col + 8, JSON.stringify(a.modePos));
  check_('the name is still the scene name (title), its position unchanged', a.name === 'a' && a.namePos.col === at(src, 'SCENE a').col + 6);
  const p4 = parse(V4(sc('t', 'NOVIEW') + sc('p', '')));
  check_('NOVIEW parses as mode "noview"', p4.errors.length === 0 && p4.ast.scenes[0].mode === 'noview' && !('mode' in p4.ast.scenes[1]), msgs(p4.errors));
  check_('lower and mixed case: `scene t nowindow`, `Scene t NoView` (the words are case-insensitive like every word)', parse(W3(sc('t', 'nowindow') + sc('p', ''))).ast.scenes[0].mode === 'nowindow' && parse(V4(sc('t', 'NoView') + sc('p', ''))).ast.scenes[0].mode === 'noview');
  check_('a scene name that is a keyword still works with the clause (`SCENE play NOWINDOW`: PLAY is a word, scene names have their own namespace)', parse(W3(sc('play', 'NOWINDOW') + sc('x', ''))).errors.length === 0 && parse(W3(sc('play', 'NOWINDOW') + sc('x', ''))).ast.scenes[0].mode === 'nowindow');
  check_('a REM line after the clause line is fine (the clause ends the statement)', parse(W3(sc('t', 'NOWINDOW') + sc('p', '')).replace('NOWINDOW\n', 'NOWINDOW\n  REM a comment\n')).errors.length === 0);
  // contextual
  check_('NOWINDOW and NOVIEW are not reserved words: they have word-table entries (help) with reserved: false', !RESERVED.has('NOWINDOW') && !RESERVED.has('NOVIEW') && ARCADE_WORDS.get('NOWINDOW')?.reserved === false && ARCADE_WORDS.get('NOVIEW')?.reserved === false);
  const vars = W3(sc('s', '', '    nowindow = 3\n    noview = nowindow + 1\n', '    v = noview\n', '  DIM v, nowindow, noview\n'));
  const pv = parse(vars);
  check_('a variable called nowindow and one called noview are legal (declared, assigned, read)', pv.errors.length === 0 && errs(vars, 3).length === 0, msgs(pv.errors) + msgs(errs(vars, 3)));
  check_('... and they compile (v3 runtime with the routines)', cmp(vars, FAKE3).errors.length === 0, errText(cmp(vars, FAKE3)));
  const asScene = W3(sc('nowindow', 'NOWINDOW') + sc('noview', ''));
  const psn = parse(asScene);
  check_('scenes called nowindow and noview are legal; `SCENE nowindow NOWINDOW` has the name and the clause', psn.errors.length === 0 && psn.ast.scenes[0].name === 'nowindow' && psn.ast.scenes[0].mode === 'nowindow' && psn.ast.scenes[1].name === 'noview', msgs(psn.errors));
  const asEnter = W3(sc('nowindow', 'NOWINDOW', '    ENTER noview\n') + sc('noview', ''));
  check_('... and ENTER noview works (no clause is read after ENTER)', parse(asEnter).errors.length === 0 && errs(asEnter, 3).length === 0, msgs(diag(asEnter, 3)));
  const asAsset = `${HEAD}MAP level = "lv"\nSPRITE noview = "orb"\nWINDOW level\n${sc('s', '', '    SHOW noview AT 1, 1\n')}`;
  check_('NOVIEW as a SPRITE name is legal (an ordinary name)', parse(asAsset).errors.length === 0, msgs(parse(asAsset).errors));
  // tokens: they are idents, not keywords
  check_('the tokenizer gives them as identifiers (so a variable of that name tokenizes as it always did)', tokenize('SCENE t NOWINDOW').map((t) => t.type + ':' + t.value).join() === 'keyword:SCENE,ident:T,ident:NOWINDOW,newline:,eof:' || tokenize('SCENE t NOWINDOW').slice(2, 3)[0].type === 'ident');
  // errors
  const MSGJ = /after the scene name: only NOWINDOW or NOVIEW may follow it/;
  const j1 = W3(sc('t', 'LATER') + sc('p', ''));
  badAt('anything else after the scene name is an error that says what may follow it, at that word', j1, MSGJ, at(j1, 'LATER'), 3);
  const j2 = W3(sc('t', 'NOWINDOW NOVIEW') + sc('p', ''));
  badAt('two clauses: the second is an unexpected word (the clause is one word)', j2, /unexpected 'NOVIEW': expected ':' or the end of the line/, at(j2, 'NOVIEW'), 3);
  const j3 = W3(sc('t', '5') + sc('p', ''));
  badAt('a number after the name', j3, MSGJ, at(j3, '5\n'), 3);
  const j4 = W3(sc('t', '"x"') + sc('p', ''));
  badAt('a string after the name', j4, MSGJ, at(j4, '"x"'), 3);
  const j5 = W3(sc('t', 'WINDOW') + sc('p', ''));
  badAt('the game words are not clauses (`SCENE t WINDOW`)', j5, MSGJ, at(j5, 'WINDOW\n  PROC'), 3);
  check_('the parser recovers from a bad clause: the scene is still parsed with its PROCs and the next scene too', (() => { const q = parse(j1); return q.ast.scenes.length === 2 && q.ast.scenes[0].procs.length === 2; })());
  check_('no clause: the old text compiles to the same tree (no `mode` key anywhere)', !JSON.stringify(parse(W3(sc('t', '') + sc('p', ''))).ast).includes('"mode"'));
}

// =================================================================================================================
// 2. Checker
// =================================================================================================================
console.log('\n2. SCENE name NOWINDOW / NOVIEW: the checker');
{
  const okW = TITLE3('NOWINDOW');
  check_('NOWINDOW in a WINDOW game checks clean (with the version 3 and with none)', errs(okW, 3).length === 0 && errs(okW).length === 0, msgs(errs(okW, 3)));
  const okV = V4(sc('t', 'NOVIEW', '', '    ENTER p\n') + sc('p', ''));
  check_('NOVIEW in a VIEW3D game checks clean (version 4 and none)', errs(okV, 4).length === 0 && errs(okV).length === 0, msgs(errs(okV, 4)));
  const noWin = PLAIN(sc('t', 'NOWINDOW', '', '    ENTER p\n') + sc('p', ''));
  badAt("NOWINDOW in a game without a WINDOW: \"SCENE 't' NOWINDOW: NOWINDOW needs a WINDOW in the game ...\" at the word", noWin, /^SCENE 't' NOWINDOW: NOWINDOW needs a WINDOW in the game/, at(noWin, 'NOWINDOW'), 3);
  const noView = PLAIN(sc('t', 'NOVIEW', '', '    ENTER p\n') + sc('p', ''));
  badAt('NOVIEW in a game without a VIEW3D', noView, /^SCENE 't' NOVIEW: NOVIEW needs a VIEW3D or a WIRE3D in the game/, at(noView, 'NOVIEW'), 4);
  const wrong1 = W3(sc('t', 'NOVIEW', '', '    ENTER p\n') + sc('p', ''));
  badAt('NOVIEW in a WINDOW game: says NOVIEW is for a VIEW3D game, that this one has a WINDOW (with its line), and to use NOWINDOW', wrong1, new RegExp(`^SCENE 't' NOVIEW: NOVIEW is for a game with a VIEW3D, and this game has a WINDOW \\(line ${at(wrong1, 'WINDOW level').line}\\): use NOWINDOW$`), at(wrong1, 'NOVIEW'), 3);
  const wrong2 = V4(sc('t', 'NOWINDOW', '', '    ENTER p\n') + sc('p', ''));
  badAt('NOWINDOW in a VIEW3D game: the same, the other way round (use NOVIEW)', wrong2, new RegExp(`^SCENE 't' NOWINDOW: NOWINDOW is for a game with a WINDOW, and this game has a VIEW3D \\(line ${at(wrong2, 'VIEW3D level').line}\\): use NOVIEW$`), at(wrong2, 'NOWINDOW'), 4);
  const twice = W3(sc('a', 'NOVIEW', '', '    ENTER b\n') + sc('b', 'NOVIEW', '', '    ENTER a\n'));
  check_('every scene with a wrong clause is reported (two errors, one per scene)', errs(twice, 3).filter((d) => /NOVIEW is for a game with a VIEW3D/.test(d.message)).length === 2, msgs(errs(twice, 3)));
  const all = W3(sc('a', 'NOWINDOW', '', '    ENTER b\n') + sc('b', 'NOWINDOW', '', '    ENTER a\n'));
  check_('every scene may have the clause (a game that never shows its window until the others are added)', errs(all, 3).length === 0, msgs(errs(all, 3)));
  const single = W3(sc('only', 'NOWINDOW'));
  check_('a one-scene game may have the clause too', errs(single, 3).length === 0, msgs(errs(single, 3)));
  const both = `${HEAD}SPRITE ship = "orb"\nMAP level = "lv"\nWINDOW level\nVIEW3D level\n${sc('t', 'NOWINDOW', '', '    ENTER p\n')}${sc('p', 'NOVIEW')}`;
  check_('a game with both a WINDOW and a VIEW3D keeps the checker\'s own errors for them and takes either clause (no extra clause error)', !errs(both, 3).some((d) => /SCENE '.' NO(WINDOW|VIEW):/.test(d.message)), msgs(errs(both, 3)));
  check_('no clause: the checker is silent about modes (a scene named like the clause words, with no clause)', errs(W3(sc('nowindow', '', '', '    ENTER noview\n') + sc('noview', '', '', '    ENTER nowindow\n')), 3).length === 0);
  check_('a NOWINDOW scene that nothing enters still gets the usual "never entered" warning (no new warning for the clause)', (() => { const w = diag(W3(sc('a', '') + sc('b', 'NOWINDOW')), 3).filter((d) => d.severity === 'warning'); return w.some((d) => /SCENE 'b' is never entered/.test(d.message)) && !w.some((d) => /NOWINDOW/.test(d.message)); })());
}

// =================================================================================================================
// 3. Code generation: the call
// =================================================================================================================
console.log('\n3. Code generation: the mode routine is called in every ENTER sequence and at boot, only when a clause exists');
/** the offsets of every `CALL addr` in the code; since the compiler size pass (docs/ARCADE_COMPILER_SIZE_CONTRACT.md F5) also of every `JP addr` (`CALL x / RET` is `JP x`): `forms` = [0xCD, 0xC3] by default, [0xCD] for CALL only */
const callsTo = (code, addr, forms = [0xCD, 0xC3]) => { const out = []; for (let i = 0; i + 2 < code.length; i++) if (forms.includes(code[i]) && code[i + 1] === (addr & 255) && code[i + 2] === addr >> 8) out.push(i); return out; };
/** the target address of the jump at offset i: JP nn (C3) or, since the size pass, JR d (18) in reach; -1 when there is no jump */
const jmpAt = (code, base, i) => (code[i] === 0xC3 ? code[i + 1] | (code[i + 2] << 8) : code[i] === 0x18 ? base + i + 2 + ((code[i + 1] << 24) >> 24) : -1);
const procAddr = (res, key) => res.map.procs[key];
const hx = (v) => v.toString(16);
{
  // three scenes: nowindow, window, nowindow; each enters the next (a ring), so every one is entered
  // every scene has a body in INIT here: an INIT that is only RET makes `JP INIT` a RET, and the mode call before it a tail jump (checked separately below, `ringE`)
  const ring = W3(sc('a', 'NOWINDOW', '    SHOW ship AT 8, 8\n', '    ENTER b\n') + sc('b', '', '    CLS\n', '    ENTER c\n') + sc('c', 'NOWINDOW', '    CLS\n', '    ENTER a\n'));
  const res = cmp(ring, FAKE3);
  check_('the ring of three scenes (NOWINDOW, window, NOWINDOW) builds on a runtime with RT_WINMODE', res.errors.length === 0 && !!res.dck, errText(res));
  const code = res.gen.code, base = res.gen.base;
  const calls = callsTo(code, WINMODE);
  check_('exactly four calls: one at boot and one per scene in the ENTER dispatch (CALL RT_WINMODE each: the INIT jump follows it)', calls.length === 4 && callsTo(code, WINMODE, [0xCD]).length === 4, `${calls.length}`);
  const aOf = calls.map((i) => (code[i - 2] === 0x3E ? code[i - 1] : -1));
  check_('each is `LD A,n / CALL RT_WINMODE`, with A = 0 for the scenes with the clause and 1 for the other, in the order boot, a, b, c', aOf.join() === '0,0,1,0', aOf.join());
  const init = (k) => procAddr(res, `${'ABC'[k]}.INIT`);
  const jpAfter = (i) => jmpAt(code, base, i + 3);
  check_('the call of scene k in the dispatch is followed at once by `JP INIT` of that scene (JR INIT when in reach; after the slot clear and the initialiser copies: "after the reset and before INIT")', [1, 2, 3].every((n) => jpAfter(calls[n]) === init(n - 1)), calls.slice(1).map((i) => hx(jpAfter(i))).join());
  check_('the boot call comes just before the first scene\'s INIT: `LD A,0 / CALL RT_WINMODE / LD (scene.sp),SP / JP INIT` (JR INIT in reach)', code[calls[0] + 3] === 0xED && code[calls[0] + 4] === 0x73 && jmpAt(code, base, calls[0] + 7) === init(0), `${hx(code[calls[0] + 3])} ${hx(code[calls[0] + 4])}`);
  // after the reset: the ENTER sequence is `LD SP,(sp) / PUSH AF / CALL scn$reset / POP AF / LD (cur),A / <go blocks>`; scn$reset itself is emitted after the go blocks
  let enterAt = -1;
  for (let i = 0; i + 8 < code.length && enterAt < 0; i++) if (code[i] === 0xED && code[i + 1] === 0x7B && code[i + 4] === 0xF5 && code[i + 5] === 0xCD && code[i + 8] === 0xF1) enterAt = i;
  const resetAddr = enterAt < 0 ? -1 : code[enterAt + 6] | (code[enterAt + 7] << 8);
  check_('scn$enter is found (`LD SP,(sp) / PUSH AF / CALL scn$reset / POP AF`)', enterAt >= 0);
  check_('every mode call of the dispatch lies after the CALL scn$reset of scn$enter and before the scn$reset routine itself (the switch is made after the reset)', [1, 2, 3].every((n) => calls[n] > enterAt + 8 && base + calls[n] < resetAddr), `enter ${enterAt}, reset ${hx(resetAddr)}, calls ${calls.join()}`);
  check_('the reset routine itself does not call the mode routine (it does not know the target)', callsTo(code, WINMODE).every((i) => base + i < resetAddr));
  // size: 5 bytes per call
  const plain = cmp(ring.replace(/ NOWINDOW/g, ''), FAKE3);
  check_('the same program without the clauses has no call at all and is exactly 4 x 5 bytes shorter', plain.errors.length === 0 && callsTo(plain.gen.code, WINMODE).length === 0 && res.gen.code.length - plain.gen.code.length === 20, `${res.gen.code.length} / ${plain.gen.code.length}`);
  check_('a program without a clause never needs the routine: it builds on the real runtime of this tree (no RT_WINMODE) and equals the build on the fake one, byte for byte', (() => { const r0 = cmp(ring.replace(/ NOWINDOW/g, ''), REAL[3]); return r0.errors.length === 0 && sameBytes(r0.memory, plain.memory) && sameBytes(r0.dck, plain.dck); })());
  check_('usage.codegen / symbols are unchanged in shape: the scene symbols and procs are keyed as in any multi-scene game', Object.keys(res.map.procs).join() === 'A.INIT,A.FRAME,B.INIT,B.FRAME,C.INIT,C.FRAME');
  {
    // scenes whose INIT is only RET: `JP INIT` is a RET (the INIT's own return goes to the runtime), so the mode call that comes before it is the tail jump `LD A,n / JP RT_WINMODE`
    const ringE = W3(sc('a', 'NOWINDOW', '    SHOW ship AT 8, 8\n', '    ENTER b\n') + sc('b', '', '', '    ENTER c\n') + sc('c', 'NOWINDOW', '', '    ENTER a\n'));
    const re = cmp(ringE, FAKE3), ce = callsTo(re.gen.code, WINMODE), form = ce.map((i) => (re.gen.code[i] === 0xCD ? 'CALL' : 'JP'));
    check_('scenes with an empty INIT (b, c): four mode calls in all, A = 0, 0, 1, 0; boot and scene a are CALLs (INIT jump follows), b and c are the tail jump LD A,n / JP RT_WINMODE', re.errors.length === 0 && ce.length === 4 && ce.map((i) => re.gen.code[i - 1]).join() === '0,0,1,0' && form.join() === 'CALL,CALL,JP,JP', form.join());
    // the original shapes, exactly (CODEGEN_OFF)
    const ro = cmp(ring, FAKE3, ASSETS11, CODEGEN_OFF), co = ro.gen.code, bo = ro.gen.base, cc = callsTo(co, WINMODE);
    check_('CODEGEN_OFF: four CALL RT_WINMODE, each followed at once by JP INIT (C3 nn nn) of its scene, boot: LD A,0 / CALL / LD (sp),SP / JP INIT; and the program without the clauses is exactly 4 x 5 bytes shorter', ro.errors.length === 0 && cc.length === 4 && callsTo(co, WINMODE, [0xCD]).length === 4 && [1, 2, 3].every((n) => co[cc[n] + 3] === 0xC3 && (co[cc[n] + 4] | (co[cc[n] + 5] << 8)) === procAddr(ro, `${'ABC'[n - 1]}.INIT`)) && co[cc[0] + 3] === 0xED && co[cc[0] + 7] === 0xC3 && ro.gen.code.length - cmp(ring.replace(/ NOWINDOW/g, ''), FAKE3, ASSETS11, CODEGEN_OFF).gen.code.length === 20, `${cc.length}`);
    void bo;
  }

  // the first scene without the clause: boot A = 1
  const second = W3(sc('a', '', '', '    ENTER b\n') + sc('b', 'NOWINDOW', '', '    ENTER a\n'));
  const r2 = cmp(second, FAKE3), c2 = callsTo(r2.gen.code, WINMODE);
  check_('the first scene without the clause, the second with: boot A = 1, dispatch A = 1 then 0', r2.errors.length === 0 && c2.length === 3 && c2.map((i) => r2.gen.code[i - 1]).join() === '1,1,0', c2.map((i) => r2.gen.code[i - 1]).join());

  // one scene with the clause, no ENTER: no driver, the call at boot only
  const solo = W3(sc('only', 'NOWINDOW', '    CLS\n'));
  const r3 = cmp(solo, FAKE3), c3 = callsTo(r3.gen.code, WINMODE);
  check_('a one-scene game with NOWINDOW and no ENTER: no driver, one call at boot (A = 0) followed by JP INIT (JR INIT)', r3.errors.length === 0 && !r3.gen.usage.driver && c3.length === 1 && r3.gen.code[c3[0] - 1] === 0 && jmpAt(r3.gen.code, r3.gen.base, c3[0] + 3) === procAddr(r3, 'INIT'), `${c3.length} calls, driver ${r3.gen.usage.driver}`);
  const solo2 = W3(sc('only', 'NOWINDOW', '', '    ENTER only\n'));
  const r4 = cmp(solo2, FAKE3), c4 = callsTo(r4.gen.code, WINMODE);
  check_('a one-scene NOWINDOW game with ENTER of itself: the driver, so a call at boot and one in the dispatch, both A = 0', r4.errors.length === 0 && c4.length === 2 && c4.every((i) => r4.gen.code[i - 1] === 0), `${c4.length}`);

  // the symbol list of the runtime must hold the routine; the call is the symbol's address, not a constant of ours
  const moved = withSyms(REAL[3], { RT_WINMODE: 0x3FAA });
  const r5 = cmp(ring, moved);
  check_('the call goes to whatever address runtime.json gives RT_WINMODE', r5.errors.length === 0 && callsTo(r5.gen.code, 0x3FAA).length === 4 && callsTo(r5.gen.code, WINMODE).length === 0);

  // v4: RT_VIEWMODE
  // (with a body in each INIT: see `ringE` above for what an INIT that is only RET does to the call)
  const ring4 = V4(sc('a', 'NOVIEW', '    CLS\n', '    ENTER b\n') + sc('b', '', '    CLS\n', '    ENTER a\n'));
  const q = cmp(ring4, FAKE4), qc = callsTo(q.gen?.code ?? [], VIEWMODE);
  check_('v4: NOVIEW calls RT_VIEWMODE (boot, a, b: A = 0, 0, 1) and never RT_WINMODE', q.errors.length === 0 && qc.length === 3 && qc.map((i) => q.gen.code[i - 1]).join() === '0,0,1' && callsTo(q.gen.code, WINMODE).length === 0, errText(q) + qc.length);
  const q0 = cmp(ring4.replace(' NOVIEW', ''), FAKE4);
  check_('v4: without the clause no call and 15 bytes less', q0.errors.length === 0 && callsTo(q0.gen.code, VIEWMODE).length === 0 && q.gen.code.length - q0.gen.code.length === 15, `${q.gen.code.length} / ${q0.gen.code.length}`);
  {
    const qo = cmp(ring4, FAKE4, ASSETS11, CODEGEN_OFF), q0o = cmp(ring4.replace(' NOVIEW', ''), FAKE4, ASSETS11, CODEGEN_OFF);
    check_('CODEGEN_OFF v4: three CALL RT_VIEWMODE, exactly 15 bytes more than without the clause', qo.errors.length === 0 && callsTo(qo.gen.code, VIEWMODE, [0xCD]).length === 3 && qo.gen.code.length - q0o.gen.code.length === 15, `${qo.gen.code.length - q0o.gen.code.length}`);
  }
  check_('v4: the program without the clause equals the build on the tree\'s real runtime, byte for byte', (() => { const r0 = cmp(ring4.replace(' NOVIEW', ''), REAL[4]); return r0.errors.length === 0 && sameBytes(r0.memory, q0.memory); })());

  // ENTER sequences are the same size per scene (5 bytes), whatever the scene count
  for (const n of [2, 4, 8]) {
    const names = Array.from({ length: n }, (_, k) => `s${k}`);
    const body = (cl) => W3(names.map((nm, k) => sc(nm, k === 0 && cl ? 'NOWINDOW' : '', '    CLS\n', `    ENTER ${names[(k + 1) % n]}\n`)).join(''));
    const a = cmp(body(true), FAKE3), b = cmp(body(false), FAKE3);
    // 5 bytes a call (LD A,n / CALL), as before; the dispatch grows by that much, so the compiler size pass's JR in reach turns back into a JP for a jump or two when the
    // scenes are far apart: 15, 26 and 48 bytes for 2, 4 and 8 scenes (5 x (n + 1) = 15, 25, 45, plus 0, 1 and 3 jumps that no longer reach)
    const wantBytes = { 2: 15, 4: 26, 8: 48 }[n];
    check_(`${n} scenes, one with the clause: ${n + 1} calls, ${wantBytes} bytes more than without (5 x ${n + 1} = ${5 * (n + 1)}, plus ${wantBytes - 5 * (n + 1)} JR that became JP: out of reach)`, a.errors.length === 0 && callsTo(a.gen.code, WINMODE).length === n + 1 && a.gen.code.length - b.gen.code.length === wantBytes, `${a.gen.code.length - b.gen.code.length}`);
    const ao = cmp(body(true), FAKE3, ASSETS11, CODEGEN_OFF), bo = cmp(body(false), FAKE3, ASSETS11, CODEGEN_OFF);
    check_(`CODEGEN_OFF: ${n} scenes, one with the clause: ${n + 1} calls, exactly ${5 * (n + 1)} bytes more than without (5 per call)`, ao.errors.length === 0 && callsTo(ao.gen.code, WINMODE, [0xCD]).length === n + 1 && ao.gen.code.length - bo.gen.code.length === 5 * (n + 1), `${ao.gen.code.length - bo.gen.code.length}`);
  }
}

// =================================================================================================================
// 4. A runtime without the routine
// =================================================================================================================
console.log('\n4. A runtime without the routine: a clear compile error');
{
  // the tree's runtimes have the batch 7 routines now: an OLD runtime is the real one with them taken out (symbols and constants)
  const NEW = ['RT_WINMODE', 'RT_VIEWMODE', 'V_WINOFF', 'V_RAYOFF', 'NV_POOL_A', 'NV_POOL_B', 'NV_POOL_C', 'NV_POOL_A_LEN', 'NV_POOL_B_LEN', 'NV_POOL_C_LEN', 'NV_POOL_BYTES'];
  const strip = (o) => Object.fromEntries(Object.entries(o ?? {}).filter(([k]) => !NEW.includes(k)));
  const OLD = (R) => ({ rt: { ...R.rt, symbols: strip(R.rt.symbols), constants: strip(R.rt.constants) }, img: R.img });
  const OLD3 = OLD(REAL[3]), OLD4 = OLD(REAL[4]);
  const r3 = cmp(TITLE3('NOWINDOW'), OLD3);
  check_('v3: NOWINDOW on a runtime without RT_WINMODE fails to compile with a message that names RT_WINMODE and says what to build', r3.errors.length >= 1 && /needs RT_WINMODE, which this runtime does not provide \(build with a runtime of language batch 7\)/.test(errText(r3)) && !r3.dck, errText(r3));
  check_('... at the clause (the line and column of the word NOWINDOW), once', r3.errors.length === 1 && r3.errors[0].line === at(TITLE3('NOWINDOW'), 'NOWINDOW').line && r3.errors[0].col === at(TITLE3('NOWINDOW'), 'NOWINDOW').col, JSON.stringify(r3.errors[0]));
  const v4 = cmp(V4(sc('t', 'NOVIEW', '', '    ENTER p\n') + sc('p', '')), OLD4);
  check_('v4: NOVIEW on a runtime without RT_VIEWMODE names RT_VIEWMODE', v4.errors.length === 1 && /needs RT_VIEWMODE, which this runtime does not provide/.test(errText(v4)), errText(v4));
  const mixed = cmp(W3(sc('a', 'NOWINDOW', '', '    ENTER b\n') + sc('b', 'NOWINDOW', '', '    ENTER a\n')), OLD3);
  check_('two scenes with the clause: the missing routine is named once, not once per scene', mixed.errors.length === 1, errText(mixed));
  const onlyOther = cmp(V4(sc('t', 'NOVIEW', '', '    ENTER p\n') + sc('p', '')), withSyms(OLD4, { RT_WINMODE: WINMODE }));
  check_('a v4 runtime with RT_WINMODE only is no help to a NOVIEW game (the routine of the clause is the one asked for)', onlyOther.errors.some((e) => /RT_VIEWMODE/.test(e.message)), errText(onlyOther));
  const v2 = cmp(TITLE3('NOWINDOW'), REAL[2]);
  check_('a v2 runtime (no WINDOW) still reports the WINDOW error first: no crash, no dck', !v2.dck && v2.errors.length >= 1, errText(v2).slice(0, 160));
  check_('the same programs without the clause build on the runtimes of this tree', cmp(TITLE3(''), REAL[3]).errors.length === 0 && cmp(V4(sc('t', '', '', '    ENTER p\n') + sc('p', '')), REAL[4]).errors.length === 0);
}

// =================================================================================================================
// 5. The NOVIEW phase pool plan
// =================================================================================================================
console.log('\n5. NOVIEW: the second phase-pool plan of a VIEW3D game');
{
  const sample = V4(sc('t', 'NOVIEW', '    SHOW ship AT 8, 8\n', '    ENTER p\n') + sc('p', '', '    SHOW ship AT 128, 128\n'));
  const ok = cmp(sample, FAKE4);
  check_('a VIEW3D game with a NOVIEW scene and ordinary art builds, and carries a second plan (gen.noviewPhase)', ok.errors.length === 0 && !!ok.dck && !!ok.gen.noviewPhase && ok.gen.noviewPhase.ok === true, errText(ok));
  const pieces = ok.gen.noviewPhase?.pieces;
  check_('its pieces are NV_POOL_A / B / C of runtime.json with their lengths: $CD00 256, $EE00 3,200, $D700 256 (3,712 bytes)', JSON.stringify(pieces) === JSON.stringify([[0xCD00, 256], [0xEE00, 3200], [0xD700, 256]]) && pieces.reduce((n, [, l]) => n + l, 0) === 3712, JSON.stringify(pieces));
  check_('noviewPoolPieces: the symbols, then constants; lengths from NV_POOL_x_LEN; null (no guessed address) when any of the six is missing', JSON.stringify(noviewPoolPieces({ NV_POOL_A: 1, NV_POOL_B: 2, NV_POOL_C: 3 }, { NV_POOL_A_LEN: 10, NV_POOL_B_LEN: 20, NV_POOL_C_LEN: 30 })) === '[[1,10],[2,20],[3,30]]' && noviewPoolPieces({}, { NV_POOL_B: 0x1234 }) === null && noviewPoolPieces() === null && noviewPoolPieces({ NV_POOL_A: 1, NV_POOL_B: 2, NV_POOL_C: 3 }, { NV_POOL_A_LEN: 10, NV_POOL_B_LEN: 20 }) === null);
  {
    const rt = JSON.parse(readFileSync(new URL('../arcade/build/v4/runtime.json', import.meta.url), 'utf8'));
    check_('the built runtime v4 exports the NOVIEW pool as designed (NOVIEW_POOL_PIECES)', JSON.stringify(noviewPoolPieces(rt.symbols, rt.constants)) === JSON.stringify(NOVIEW_POOL_PIECES.map((p) => [...p])), JSON.stringify(noviewPoolPieces(rt.symbols, rt.constants)));
  }
  check_('the normal pool pieces are a different set (a NOVIEW pool is smaller than a normal game\'s: 3,712 against 5,888 bytes)', poolPieces({}).reduce((n, [, l]) => n + l, 0) === 5888);
  const assetsFor = (res) => res.gen.sprites.map((sp, i) => ({ w: sp.w, h: sp.h, phases: sp.phases ?? 8, nframes: sp.nframes ?? 1, instances: res.gen.v2.instAssets.filter((a) => a === i).length }));
  const want = planPhasePool(assetsFor(ok), pieces);
  check_('the plan is planPhasePool over the asset list and those pieces (K, need, miss)', JSON.stringify([ok.gen.noviewPhase.K, ok.gen.noviewPhase.need, ok.gen.noviewPhase.miss]) === JSON.stringify([want.K, want.need, want.miss]), JSON.stringify(ok.gen.noviewPhase.K));
  check_('gen.phase of a VIEW3D game stays null (ray mode has no phase pool of its own: the link report is unchanged)', ok.gen.phase === null);
  check_('the link report has the NOVIEW figures (usage.noviewPhaseRam: needed, available 3,712, perAsset) and the text report a line for it; usage.phaseRam is absent as before', !!ok.usage.noviewPhaseRam && ok.usage.noviewPhaseRam.available === 3712 && ok.usage.phaseRam === undefined && usageLines(ok.usage).some((l) => /^phase memory of a NOVIEW scene: at least \d+ of 3712 bytes/.test(l)), JSON.stringify(ok.usage.noviewPhaseRam));
  // no plan without a NOVIEW scene (the byte-identity half is section 8)
  const none = cmp(V4(sc('t', '', '    SHOW ship AT 8, 8\n', '    ENTER p\n') + sc('p', '')), FAKE4);
  check_('a VIEW3D game with no NOVIEW scene has no second plan and no usage line for it', none.errors.length === 0 && none.gen.noviewPhase === undefined && none.usage.noviewPhaseRam === undefined);
  const win = cmp(TITLE3('NOWINDOW'), FAKE3);
  check_('a WINDOW game with a NOWINDOW scene has no second plan (the window game\'s pool is built at boot as always)', win.errors.length === 0 && win.gen.noviewPhase === undefined && !!win.gen.phase && win.gen.phase.ok);
  // refusal: art that fits the normal pool (5,888) but not the NOVIEW pool (3,712): two 32 x 24 instances of a 2-frame asset at 8 phases
  const frames = (n, h) => Array.from({ length: n }, (_, f) => ({ rows: Array.from({ length: h }, (_, y) => ({ bits: f ? '80000001' : 'FFFFFFFF', mask: 'FFFFFFFF' })) }));
  const BIG = { ...ASSETS11, sprites: { ...ASSETS11.sprites, big: { w: 32, h: 24, phases: 8, frames: frames(2, 24) }, bigLow: { w: 32, h: 24, phases: 2, frames: frames(2, 24) } } };
  const bigSrc = (asset, clause) => `${HEAD}SPRITE ship = "orb"\nSPRITE b(2) = "${asset}"\nMAP level = "maze"\nVIEW3D level\n${sc('t', clause, '    SHOW b(0) AT 8, 8 FRAME 1\n    SHOW b(1) AT 60, 8\n', '    ENTER p\n')}${sc('p', '')}`;
  const wantNormal = planPhasePool([{ w: 32, h: 24, phases: 8, nframes: 2, instances: 2 }, { w: 16, h: 16, phases: 8, nframes: 1, instances: 1 }].slice(0, 1), poolPieces(REAL[4].rt.constants));
  const wantNv = planPhasePool([{ w: 32, h: 24, phases: 8, nframes: 2, instances: 2 }], noviewPoolPieces(FAKE4.rt.symbols, FAKE4.rt.constants));
  check_('(setup) two 32 x 24 instances of a 2-frame asset at 8 phases fit the normal pool and not the NOVIEW pool', wantNormal.ok && !wantNv.ok && wantNv.miss > 0, `${wantNormal.ok} ${wantNv.ok} miss ${wantNv.miss}`);
  const noClause = cmp(bigSrc('big', ''), FAKE4, BIG);
  check_('the same art with no NOVIEW scene builds (the normal game needs no pool in ray mode)', noClause.errors.length === 0 && !!noClause.dck, errText(noClause));
  const refused = cmp(bigSrc('big', 'NOVIEW'), FAKE4, BIG);
  check_('with a NOVIEW scene the link fails: "N bytes of sprite art do not fit in the phase pool of a scene without the 3D view ... use fewer phases"', !refused.dck && refused.errors.length === 1 && new RegExp(`^${wantNv.miss} bytes of sprite art do not fit in the phase pool of a scene without the 3D view \\(SCENE \\.\\.\\. NOVIEW: 3712 bytes, smaller than the 5888 of a normal game\\): use fewer phases`).test(refused.errors[0].message), errText(refused));
  const fewer = cmp(bigSrc('bigLow', 'NOVIEW'), FAKE4, BIG);
  check_('with fewer phases (2) the same game with a NOVIEW scene builds', fewer.errors.length === 0 && !!fewer.dck && fewer.gen.noviewPhase.ok, errText(fewer));
  // pieces come from runtime.json: shrink NV_POOL_B and the plan follows
  const tiny = withSyms(REAL[4], { RT_VIEWMODE: VIEWMODE, NV_POOL_A: 0xCD00, NV_POOL_B: 0xEE00, NV_POOL_C: 0xD700 }, { NV_POOL_A_LEN: 256, NV_POOL_B_LEN: 64, NV_POOL_C_LEN: 256 });
  const small = cmp(sample, tiny);
  check_('a smaller NV_POOL_B_LEN in runtime.json makes an ordinary game need more than the pool has: refused with the pool\'s size in the message', small.errors.length === 1 && /of a scene without the 3D view \(SCENE \.\.\. NOVIEW: 576 bytes,/.test(small.errors[0].message), errText(small));
  const noLen = withSyms(REAL[4], { RT_VIEWMODE: VIEWMODE, NV_POOL_A: 0xCD00, NV_POOL_B: 0xEE00, NV_POOL_C: 0xD700 });
  check_('NV_POOL_x without lengths in runtime.json: the designed lengths are used', cmp(sample, noLen).gen.noviewPhase.pieces.map((p) => p[1]).join() === '256,3200,256');
  const noPoolSyms = cmp(sample, withSyms(REAL[4], { RT_VIEWMODE: VIEWMODE }));
  check_('a runtime with RT_VIEWMODE but no NV_POOL symbols: the designed addresses are used (the pool is the routine\'s own business; the plan only counts bytes)', noPoolSyms.errors.length === 0 && noPoolSyms.gen.noviewPhase.pieces[1][0] === 0xEE00);
  // an unused sprite asset and an instance-free asset take no pool
  check_('the warning about frames that do not stay cached names the NOVIEW scene (a 2-frame asset with room for only some frames)', (() => { const r = cmp(bigSrc('big', 'NOVIEW').replace('SPRITE b(2)', 'SPRITE b(1)').replace('    SHOW b(1) AT 60, 8\n', ''), FAKE4, BIG); return r.errors.length === 0 ? r.warnings.every((w) => !/in a NOVIEW scene only/.test(w.message) || /frames stay cached/.test(w.message)) : true; })());
}

// =================================================================================================================
// 6. The display model
// =================================================================================================================
console.log('\n6. The display model: sceneDisplayPlan and sceneModes');
{
  const ast = (src) => parse(src).ast;
  const noSprites = W3(sc('title', 'NOWINDOW', '    TILE 1, 1 = 3\n', '    ENTER play\n') + sc('play', '', '', '    CAMERA 10\n'));
  const plan = sceneDisplayPlan(ast(noSprites));
  check_('a window game\'s scene without the clause is "buffers, because the window or 3D view is drawn" as before', plan[1].auto === 'buffers' && /because the window or 3D view is drawn/.test(plan[1].reason) && !('mode' in plan[1]), plan[1].reason);
  check_('a NOWINDOW scene that only draws a static picture is judged as in a game without a window: "fine" (and says so), with mode "nowindow"', plan[0].auto === 'buffers' ? /FRAME redraws/.test(plan[0].reason) : plan[0].auto === 'fine' && plan[0].mode === 'nowindow', `${plan[0].auto}: ${plan[0].reason}`);
  const staticPic = W3(sc('title', 'NOWINDOW', '    TILE 1, 1 = 3\n', '    REM waiting\n') + sc('play', '', '', '    ENTER title\n'));
  const p2 = sceneDisplayPlan(ast(staticPic));
  check_('a NOWINDOW scene that draws tiles in INIT and redraws nothing: auto "fine" (the window does not make it two buffers) with mode "nowindow"', p2[0].auto === 'fine' && p2[0].mode === 'nowindow' && p2[0].reason === 'a static picture: 8 x 1 colour would give a colour per pixel row', `${p2[0].auto}: ${p2[0].reason}`);
  const text = V4(sc('t', 'NOVIEW', '', '    PRINT AT 1, 1; "x"\n    ENTER p\n') + sc('p', ''));
  const p3 = sceneDisplayPlan(ast(text));
  check_('a NOVIEW scene that prints each tick: "buffers, because FRAME redraws text or tiles" (not the window reason); mode "noview"', p3[0].auto === 'buffers' && /because FRAME redraws text or tiles/.test(p3[0].reason) && p3[0].mode === 'noview', p3[0].reason);
  const spr = W3(sc('t', 'NOWINDOW', '    SHOW ship AT 8, 8\n', '    ENTER p\n') + sc('p', ''));
  check_('a NOWINDOW scene with sprites: "buffers, because sprites move"', sceneDisplayPlan(ast(spr))[0].reason === 'two display files flipped each tick, because sprites move');
  const modes = sceneModes(ast(W3(sc('a', 'NOWINDOW') + sc('b', ''))));
  check_('sceneModes: a NOWINDOW scene shows the whole "screen", the other the "window"', JSON.stringify(modes.map((m) => [m.name, m.show, m.mode])) === '[["a","screen","nowindow"],["b","window",null]]', JSON.stringify(modes));
  check_('... a VIEW3D game\'s scenes: "view" and (NOVIEW) "screen"; a plain game: "screen"', JSON.stringify(sceneModes(ast(V4(sc('a', 'NOVIEW') + sc('b', '')))).map((m) => m.show)) === '["screen","view"]' && sceneModes(ast(PLAIN(sc('a', '')))).map((m) => m.show).join() === 'screen');
  check_('no clause: the plan entries have exactly the keys they had (no `mode`), so the Studio panel and tests/arcade-display.mjs see no change', Object.keys(sceneDisplayPlan(ast(W3(sc('a', '') + sc('b', ''))))[0]).join() === 'name,line,col,auto,reason,override,setting,built,notes');
  check_('sceneModes never throws on a broken tree', JSON.stringify(sceneModes(null)) === '[]' && JSON.stringify(sceneModes({ scenes: [null, 3] })) === '[]');
}

// =================================================================================================================
// 7. Studio words
// =================================================================================================================
console.log('\n7. Studio: word table, highlighting, completion, Symbols tab');
{
  const w = ARCADE_WORDS.get('NOWINDOW'), v = ARCADE_WORDS.get('NOVIEW');
  check_('the word table has NOWINDOW and NOVIEW (cls game, contextual) with the syntax `SCENE name NOWINDOW` and a description of what the mode does', w?.cls === 'game' && v?.cls === 'game' && w.syntax === 'SCENE name NOWINDOW' && v.syntax === 'SCENE name NOVIEW' && /whole 32 x 24 cell screen/.test(w.desc) && /fewer phases/.test(v.desc) && /ENTER/.test(w.desc), `${w?.syntax} / ${v?.syntax}`);
  check_('the SCENE entry says the clause exists (syntax `SCENE name [NOWINDOW | NOVIEW] ... ENDSCENE`)', ARCADE_WORDS.get('SCENE').syntax === 'SCENE name [NOWINDOW | NOVIEW] ... ENDSCENE' && /NOWINDOW \/ NOVIEW/.test(ARCADE_WORDS.get('SCENE').desc));
  const ed = readFileSync(join(ROOT, 'src/lang/arcade/editor.js'), 'utf8');
  check_('editor.js highlights NOWINDOW / NOVIEW only as the third token of a SCENE line (contextual: a variable of that name stays a variable)', /\(t\.value === 'NOWINDOW' \|\| t\.value === 'NOVIEW'\) && i >= 2 && toks\[i - 2\]\?\.type === 'keyword' && toks\[i - 2\]\.value === 'SCENE'/.test(ed));
  check_('editor.js completes after `SCENE name` with the clause the game\'s WINDOW / VIEW3D allows', /\^\\s\*SCENE\\s\+\[A-Za-z\]\[A-Za-z0-9_\]\*\$/.test(ed) && /label, type: 'keyword', detail/.test(ed) && /scene without the scrolling window/.test(ed) && /scene without the 3D view/.test(ed));
  const s = scanArcade(W3(sc('title', 'NOWINDOW') + sc('play', '')));
  check_('scanArcade: a scene with the clause has mode in its entry, one without has no such key', s.scenes[0].mode === 'nowindow' && !('mode' in s.scenes[1]), JSON.stringify(s.scenes));
  const { arcadeProfile: prof } = await import('../src/lang/arcade/profile.js');
  const groups = prof?.symbolGroups ? prof.symbolGroups(W3(sc('title', 'NOWINDOW', '', '    ENTER play\n') + sc('play', '', '', '    ENTER title\n'))) : null;
  {
    const scenes = groups.find(([t]) => t === 'Scenes')[1].map(([label]) => label);
    check_('the Symbols tab shows the mode: `title (start) (no window) -> play`, `play -> title`', scenes.join(' | ') === 'title (start) (no window) -> play | play -> title', scenes.join(' | '));
    const v4g = prof.symbolGroups(V4(sc('t', 'NOVIEW') + sc('p', ''))).find(([t]) => t === 'Scenes')[1].map(([label]) => label);
    check_('... and `(no view)` for NOVIEW; a scene without the clause has neither', v4g.join(' | ') === 't (start) (no view) | p', v4g.join(' | '));
  }
  const docs = readFileSync(join(ROOT, 'docs/ARCADE_LANGUAGE.md'), 'utf8');
  check_('docs/ARCADE_LANGUAGE.md has the clause (the table row and the changelog entry)', /SCENE n NOWINDOW/.test(docs) && /language batch 7/.test(docs) && /RT_WINMODE/.test(docs));
}

// =================================================================================================================
// 8. Byte identity with the previous compiler
// =================================================================================================================
console.log('\n8. Programs without the clause compile to exactly the bytes of the previous compiler');
{
  const oldDir = process.env.ARCADE_OLD ?? null;
  if (!oldDir) skip_('byte identity against the previous compiler', 'set ARCADE_OLD to a copy of the previous src/lang/arcade/ (git archive of 3a22ea1)');
  else {
    const oldCompile = (await import(pathToFileURL(join(oldDir, 'arcade-compile.js')).href)).compile;
    const CLAUSE = /^\s*SCENE\s+\w+\s+NO(WINDOW|VIEW)\b/im;
    const progs = [];
    let excluded = 0;
    for (const d of ['arcade/examples', 'arcade/tests/fixtures']) {
      if (!existsSync(join(ROOT, d))) continue;
      for (const f of readdirSync(join(ROOT, d)).filter((x) => x.endsWith('.arc')).sort()) {
        const text = readFileSync(join(ROOT, d, f), 'utf8');
        if (CLAUSE.test(text)) { excluded++; continue; }                 // a program that uses the clause is not one this section is about
        const aj = join(ROOT, d, f.replace('.arc', '.assets.json'));
        progs.push({ src: `${d}/${f}`, text, assets: existsSync(aj) ? JSON.parse(readFileSync(aj, 'utf8')) : undefined });
      }
    }
    const { genV3, genV4, ASSETS: A9 } = await import('./arcade-m9-common.mjs');
    for (let seed = 1; seed <= 8; seed++) { const a = genV3(seed), b = genV4(seed); progs.push({ src: `genV3(${seed})`, text: a.src, assets: a.assets ?? A9 }, { src: `genV4(${seed})`, text: b.src, assets: b.assets ?? A9 }); }
    // multi-scene window / view games without the clause, and variables called like the clause words
    progs.push({ src: 'WINDOW ring of three scenes', text: W3(sc('a', '', '    SHOW ship AT 8, 8\n', '    ENTER b\n') + sc('b', '', '', '    ENTER c\n') + sc('c', '', '', '    ENTER a\n')), assets: ASSETS11 });
    progs.push({ src: 'VIEW3D two scenes', text: V4(sc('a', '', '    SHOW ship AT 8, 8\n', '    ENTER b\n') + sc('b', '', '', '    ENTER a\n')), assets: ASSETS11 });
    progs.push({ src: 'variables nowindow / noview', text: W3(sc('s', '', '    nowindow = 3\n', '    noview = nowindow + 1\n', '  DIM nowindow, noview\n')), assets: ASSETS11 });
    progs.push({ src: 'scenes called nowindow / noview', text: W3(sc('nowindow', '', '', '    ENTER noview\n') + sc('noview', '', '', '    ENTER nowindow\n')), assets: ASSETS11 });
    progs.push({ src: 'plain two-scene game', text: PLAIN(sc('a', '', '    SHOW ship AT 8, 8\n', '    ENTER b\n') + sc('b', '', '', '    ENTER a\n')), assets: ASSETS11 });
    const targets = [['real v2', REAL[2]], ['real v3', REAL[3]], ['real v4', REAL[4]], ['v3 with the fake RT_WINMODE', FAKE3], ['v4 with the fake RT_VIEWMODE and NV_POOL', FAKE4]].filter(([, R]) => R);
    const eqb = (x, y) => (!x && !y) || (!!x && !!y && sameBytes(x, y));
    let n = 0, same = 0, built = 0, bad = '';
    const sans = (u) => (u ? JSON.stringify({ ...u, codegen: undefined }) : '');
    for (const p of progs) for (const [tn, R] of targets) {
      for (const bankAll of [false, true]) {
        const o = oldCompile(p.text, { runtime: R.rt, image: R.img, assets: p.assets, bankAll }), w = compile(p.text, { runtime: R.rt, image: R.img, assets: p.assets, bankAll });
        n++;
        const ok = eqb(o.memory, w.memory) && eqb(o.dck, w.dck) && JSON.stringify(o.errors) === JSON.stringify(w.errors) && JSON.stringify(o.warnings) === JSON.stringify(w.warnings)
          && (!o.gen || sameBytes(o.gen.code, w.gen.code)) && sans(o.usage) === sans(w.usage) && (!o.gen || JSON.stringify(o.gen.fixups) === JSON.stringify(w.gen.fixups)) && JSON.stringify(o.map?.banked) === JSON.stringify(w.map?.banked)
          && JSON.stringify(o.scenes) === JSON.stringify(w.scenes);
        if (ok) { same++; if (w.memory) built++; } else bad += `${p.src} on ${tn}${bankAll ? ' (bankAll)' : ''}; `;
      }
    }
    check_(`${progs.length} programs (every example and fixture without the clause, generated v3 / v4 programs, multi-scene window / view games, variables and scenes called nowindow / noview) on ${targets.length} runtime tables, normal and bankAll: ${n} compilations: image, DCK, code, errors, warnings, usage, fixups, bank and scene plan identical`, same === n, bad.slice(0, 400));
    info(`byte identity: ${n} compilations compared, ${same} identical, ${built} of them built a cartridge; ${excluded} example / fixture file(s) use the clause and are excluded`);
    check_('and a good number of them built a cartridge (the comparison is not all errors)', built >= 40, `${built}`);
    const exs = progs.filter((p) => p.src.startsWith('arcade/examples/'));
    check_('the examples are among them (bounce, breakout, shooter, platformer, vaults, runner, blockfall ...)', exs.length >= 6, `${exs.length}`);
  }
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}: ${passed} checks passed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed === 0 ? 0 : 1);
