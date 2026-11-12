#!/usr/bin/env node
"use strict";
// arcade-m13-compiler.mjs -- tests for language batch 6, Part A: `WORLD expr OF m0, m1, ...` (compiler, linker, reference interpreter, editor helper). The contract is docs/ARCADE_LANGUAGE_BATCH6.md.
//
//   node tests/arcade-m13-compiler.mjs
//   ARCADE_OLD=<dir of the previous src/lang/arcade/> node tests/arcade-m13-compiler.mjs     the byte-identity comparison (section 7) against that compiler (git archive of the commit before batch 6)
//
// No machine is booted here (tests/arcade-m13-differential.mjs runs the new form on the real v3 and v4 runtimes). The runtime tables are the tree's own arcade/build/v3|v4/runtime.json (they already
// have RT_WORLDLOAD / RT_PLANLOAD: the new form needs no runtime change).
// Sections
//   1  words and parser: both forms, OF contextual, a variable called `of`, the missing-OF error, the list
//   2  checker: non-MAP names, the map checks through the list, no WINDOW / VIEW3D, more than 64 names, the constant index warning, LOADMAP of a listed map
//   3  the reference interpreter: signed index, in range, negative, past the end, the camera, v3 and v4
//   4  code generation: constant index = the `WORLD name` bytes, the list entries (v3 5 bytes, v4 4 bytes), lib$worldidx bytes, sharing of identical lists, sizes
//   5  streams and fixups: mapped and banked (bankAll, an override), read back from the image through the fixups, each stream stored once
//   6  the editor helper (completion context after OF) and the Studio word help
//   7  byte identity with the previous compiler (ARCADE_OLD): every example, every fixture, the generated programs; programs using the new form are excluded
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse, tokenize } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile, CODEGEN_OFF } from '../src/lang/arcade/arcade-compile.js';
import { camMax } from '../src/lang/arcade/arcade-window.js';
import { scanArcade, inWorldList } from '../src/lang/arcade/arcade-scan.js';
import { ARCADE_WORDS, RESERVED } from '../src/lang/arcade/arcade-words.js';
import { ASSETS11, withBank, HEAD, scene, win3, view4 } from './arcade-m11-common.mjs';

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
const hex = (v) => '$' + v.toString(16).toUpperCase();
const rd16 = (m, a) => m[a] | (m[a + 1] << 8);

// ── runtimes: the tree's own tables ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function loadRt(v) {
  const json = join(ROOT, `arcade/build/v${v}/runtime.json`);
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))) };
}
const REAL = { 2: loadRt(2), 3: loadRt(3), 4: loadRt(4) };
if (!REAL[3] || !REAL[4] || REAL[3].rt.symbols.RT_WORLDLOAD === undefined || REAL[4].rt.symbols.RT_PLANLOAD === undefined) {
  console.log('SKIP: arcade/build/v3 and v4 (runtime.json with RT_WORLDLOAD / RT_PLANLOAD) are needed');
  process.exit(0);
}
const cmp = (src, v, assets = ASSETS11, opts = {}, R = REAL[v]) => compile(src, { runtime: R.rt, image: R.img, assets, ...opts });
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
const warnText = (r) => r.warnings.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');

// ── diagnostics helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
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
const badAt = (name, src, msg, where, v) => {
  const e = errs(src, v), hit = e.find((d) => (msg instanceof RegExp ? msg.test(d.message) : d.message === msg) && (!where || (d.line === where.line && d.col === where.col)));
  check_(name, !!hit, hit ? '' : `got: ${msgs(e) || 'no errors'}${where ? ` (wanted at ${where.line}:${where.col})` : ''}`);
};
const findWorld = (n, out = [], seen = new Set()) => { if (Array.isArray(n)) n.forEach((x) => findWorld(x, out, seen)); else if (n && typeof n === 'object' && !seen.has(n)) { seen.add(n); if (n.type === 'World') out.push(n); for (const k of Object.keys(n)) if (k !== 'type' && n[k] && typeof n[k] === 'object') findWorld(n[k], out, seen); } return out; };

// v3 worlds (WINDOW over "lv", 48 x 16) and v4 plans (VIEW3D over "maze")
// (a MAP no WORLD names is a screen map and must fit the screen, so each program declares only the maps it lists)
const W3 = 'MAP second = "w60"\nMAP third = "w24"\n', W3F = W3 + 'MAP fourth = "w128"\n';
const W4 = 'MAP other = "p8"\nMAP bigger = "p20"\n', W4H = W4 + 'MAP huge = "p32"\n';
const g3 = (frame, init = '', maps = W3) => win3(frame, maps, init);
const g4 = (frame, init = '', maps = W4) => view4(frame, maps, init);

// =================================================================================================================
// 1. Words and parser
// =================================================================================================================
console.log('1. WORLD expr OF list: the parser');
{
  const src = g3('    WORLD v OF level, second, third\n    WORLD 2 OF second, third, fourth\n    WORLD (v + 1) OF third\n    WORLD second\n    WORLD v - 1 OF fourth,second', '', W3F);
  const p = parse(src);
  check_('the program with both forms parses with no error', p.errors.length === 0, msgs(p.errors));
  const w = findWorld(p.ast.scenes);
  check_('five WORLD nodes, in source order', w.length === 5, `${w.length}`);
  check_('WORLD v OF a, b, c: World {map: null, index: Ident v, maps: [Ident x3]} at the WORLD keyword', w[0].map === null && w[0].index.type === 'Ident' && w[0].index.name === 'v' && w[0].maps.length === 3 && w[0].maps.every((m) => m.type === 'Ident') && w[0].maps.map((m) => m.name).join() === 'level,second,third' && w[0].line === at(src, 'WORLD v OF').line && w[0].col === at(src, 'WORLD v OF').col, JSON.stringify(w[0]).slice(0, 200));
  check_('every listed name keeps its own position', w[0].maps[1].line === at(src, 'second, third').line && w[0].maps[1].col === at(src, 'second, third').col && w[0].maps[2].col === at(src, 'third\n').col, JSON.stringify(w[0].maps.map((m) => [m.line, m.col])));
  check_('WORLD 2 OF ...: the index is a Number node', w[1].index.type === 'Number' && w[1].index.value === 2 && w[1].maps.length === 3);
  check_('WORLD (v + 1) OF third: a bracketed index, one name (a list of 1 is legal)', w[2].index.parens === true && w[2].maps.length === 1 && w[2].map === null);
  check_('WORLD second (a bare name, nothing after it) is the old form: World {map: Ident}, no index, no maps', w[3].map.type === 'Ident' && w[3].map.name === 'second' && w[3].index === undefined && w[3].maps === undefined);
  check_('WORLD v - 1 OF a,b: an expression with an operator; names with no spaces after the comma', w[4].index.type === 'Binary' && w[4].maps.map((m) => m.name).join() === 'fourth,second');
  // OF is contextual
  check_('OF is not a reserved word and has no word-table entry (it is contextual)', !RESERVED.has('OF') && !ARCADE_WORDS.has('OF'));
  const of1 = g3('    of = 3\n    WORLD of OF second, third\n    v = of + 1', '', W3).replace('DIM v', 'DIM v, of');
  const pof = parse(of1);
  const wof = findWorld(pof.ast.scenes);
  check_('a variable called `of` is legal: `of = 3`, `v = of + 1`, and `WORLD of OF a, b` takes it as the index', pof.errors.length === 0 && wof.length === 1 && wof[0].index.name === 'of' && wof[0].maps.length === 2, msgs(pof.errors));
  check_('... and checks and compiles (the variable `of` is read and written)', errs(of1, 3).length === 0 && cmp(of1, 3).errors.length === 0, msgs(errs(of1, 3)) + errText(cmp(of1, 3)));
  const of2 = g3('    WORLD of\n', '', 'MAP of = "w60"\n');
  const w2 = findWorld(parse(of2).ast.scenes);
  check_('a MAP called `of` is the old form `WORLD of` (a bare name that ends the statement)', parse(of2).errors.length === 0 && w2[0].map?.name === 'of' && w2[0].maps === undefined, msgs(parse(of2).errors));
  // the old form is unchanged for a reserved-word asset name (BATCH11 / BATCH3)
  const asAsset = g3('    WORLD world', '', 'MAP world = "w60"\n');
  check_('WORLD world (a MAP named like a reserved word) still parses as the old form', findWorld(parse(asAsset).ast.scenes)[0].map?.name === 'world' && parse(asAsset).errors.length === 0, msgs(parse(asAsset).errors));
  check_('the old form is followed by ELSE / ENDIF / a colon without trouble (`IF v = 1 THEN WORLD second ENDIF`)', parse(g3('    IF v = 1 THEN WORLD second ENDIF')).errors.length === 0 && parse(g3('    IF v = 1 THEN WORLD v OF second, third ENDIF')).errors.length === 0, msgs(parse(g3('    IF v = 1 THEN WORLD v OF second, third ENDIF')).errors));
  // errors
  const MSG = 'WORLD by number needs OF and the list of maps: WORLD n OF a, b, c';
  const noOf = g3('    WORLD v + 1\n');
  badAt('WORLD expr with no OF: "WORLD by number needs OF and the list of maps: WORLD n OF a, b, c" (at the first token after WORLD)', noOf, MSG, at(noOf, 'v + 1'), 3);
  const noOf2 = g3('    WORLD 2\n');
  badAt('... a number', noOf2, MSG, at(noOf2, '2\n'), 3);
  const noOf3 = g3('    WORLD v second\n');
  badAt('... an expression followed by another word, not OF', noOf3, MSG, at(noOf3, 'second\n'), 3);
  const noOf4 = g3('    WORLD (v)\n');
  badAt('... a bracketed name (not "bare"): also needs OF', noOf4, MSG, at(noOf4, '(v)'), 3);
  const emptyList = g3('    WORLD v OF\n');
  check_('WORLD v OF with no name: an error that asks for a map name', parse(emptyList).errors.some((d) => /expected a map name: WORLD n OF a, b, c but found the end of the line/.test(d.message) && d.line === at(emptyList, 'WORLD v OF').line), msgs(parse(emptyList).errors));
  const trail = g3('    WORLD v OF second,\n');
  check_('a trailing comma: an error that asks for a map name', parse(trail).errors.some((d) => /expected a map name: WORLD n OF a, b, c/.test(d.message)), msgs(parse(trail).errors));
  const junk = g3('    WORLD v OF second third\n');
  check_('a name after a name without a comma is an error (the statement ends at the list)', parse(junk).errors.length >= 1, msgs(parse(junk).errors));
  const num = g3('    WORLD v OF 3\n');
  check_('a number in the list is an error ("expected a map name")', parse(num).errors.some((d) => /expected a map name/.test(d.message)), msgs(parse(num).errors));
  check_('the parser does not throw on any of them and recovers (the next statement still parses)', findWorld(parse(g3('    WORLD v OF\n    WORLD second\n')).ast.scenes).some((n) => n.map?.name === 'second'));
}

// =================================================================================================================
// 2. Checker
// =================================================================================================================
console.log('\n2. WORLD expr OF list: the checker');
{
  const ok = g3('    WORLD v OF level, second, third');
  check_('a list of the WINDOW\'s own map and two worlds checks clean (v3), also with no version', errs(ok, 3).length === 0 && errs(ok).length === 0, msgs(errs(ok, 3)));
  const ok4 = g4('    WORLD v OF level, other, bigger');
  check_('... and a list of the VIEW3D\'s plan and two plans (v4)', errs(ok4, 4).length === 0, msgs(errs(ok4, 4)));
  const bad = g3('    WORLD v OF second, nowhere, third');
  badAt("a name that is not a MAP: WORLD: unknown MAP 'x', at that name", bad, "WORLD: unknown MAP 'nowhere'", at(bad, 'nowhere'), 3);
  const bad2 = g3('    WORLD v OF second, ship');
  badAt('a SPRITE name in the list is an unknown MAP too', bad2, "WORLD: unknown MAP 'ship'", at(bad2, 'ship', 1), 3);
  const both = g3('    WORLD v OF nope1, second, nope2');
  check_('every bad name is reported (two errors, in order)', errs(both, 3).filter((d) => /unknown MAP/.test(d.message)).map((d) => d.message).join() === "WORLD: unknown MAP 'nope1',WORLD: unknown MAP 'nope2'", msgs(errs(both, 3)));
  const none = g3('    WORLD v OF second', '', W3).replace('WINDOW level\n', '');
  badAt('no WINDOW / VIEW3D: the same error as WORLD name, at the statement', none, 'WORLD needs a WINDOW (runtime v3) or a VIEW3D (runtime v4)', at(none, 'WORLD v'), 3);
  const plain2 = `${HEAD}MAP a = "w60"\n${scene('', '    WORLD v OF a')}`;
  badAt('a game with neither (v2): the same error', plain2, 'WORLD needs a WINDOW (runtime v3) or a VIEW3D (runtime v4)', at(plain2, 'WORLD v'), 2);
  check_('... and the compiler reports it once for the list statement (checker and code generator agree)', cmp(plain2, 2).errors.filter((e) => /WORLD needs a WINDOW/.test(e.message)).length >= 1, errText(cmp(plain2, 2)));
  // map checks through the list (the code generator's, prefix WORLD: )
  const small = g3('    WORLD v OF second, tiny', '', W3 + 'MAP tiny = "small"\n');
  const osm = cmp(small, 3);
  check_('a map that is not a valid world (5 x 4: width 24..128) is an error with the WORLD: prefix, at the name in the list', osm.errors.some((e) => /^WORLD: world map "small": /.test(e.message) && e.line === at(small, 'tiny', 1).line && e.col === at(small, 'tiny', 1).col), errText(osm));
  const asName = g3('    WORLD tiny', '', W3 + 'MAP tiny = "small"\n');
  check_('... the same message as `WORLD tiny` gives', cmp(asName, 3).errors.some((e) => e.message === osm.errors.find((x) => /^WORLD: world map/.test(x.message))?.message), errText(cmp(asName, 3)));
  const tooTall = g3('    WORLD v OF second, big', '', W3 + 'MAP big = "big0"\n');
  check_('a screen map of 32 x 24 is not a world either (rows 1..16)', cmp(tooTall, 3).errors.some((e) => /^WORLD: world map "big0": /.test(e.message)), errText(cmp(tooTall, 3)));
  const plan = g4('    WORLD v OF other, tiny', '', W4 + 'MAP tiny = "small"\n');
  check_('v4: a map that is not a floor plan (5 x 4 is fine in width but the ring is not walls) is an error with the WORLD: prefix', cmp(plan, 4).errors.some((e) => /^WORLD: view map "small": /.test(e.message)), errText(cmp(plan, 4)));
  // LOADMAP of a listed map
  const lm = g3('    LOADMAP second\n    WORLD v OF level, second');
  badAt('LOADMAP of a map a list names is an error (it is a world)', lm, /LOADMAP: 'second' is the world of the WINDOW/, { ...at(lm, 'LOADMAP second'), col: at(lm, 'LOADMAP second').col + 8 }, 3);
  const lm4 = g4('    LOADMAP other\n    WORLD v OF level, other');
  badAt('... and in a VIEW3D game a floor plan', lm4, /LOADMAP: 'other' is the floor plan of the VIEW3D/, { ...at(lm4, 'LOADMAP other'), col: at(lm4, 'LOADMAP other').col + 8 }, 4);
  // the same name more than once
  const dup = g3('    WORLD v OF second, third, second, second');
  check_('the same name may appear more than once (no error, no warning about it)', errs(dup, 3).length === 0 && !warns(dup, 3).some((d) => /second/.test(d.message)), msgs(diag(dup, 3)));
  // names count as uses: a map named only in a list is not "never used"
  const used = g3('    WORLD v OF second, third');
  check_('a MAP named only in a list is "used" (no "is never used" warning for it); one not named at all still warns', !warns(used, 3).some((d) => /MAP 'second'|MAP 'third'/.test(d.message)) && warns(g3('    v = 1'), 3).some((d) => /MAP 'second' is never used/.test(d.message)), msgs(warns(used, 3)));
  // more than 64
  const names = Array.from({ length: 65 }, (_, i) => `m${i}`);
  const maps65 = names.map((n) => `MAP ${n} = "w24"\n`).join('');
  const big64 = g3(`    WORLD v OF ${names.slice(0, 64).join(', ')}`, '', maps65);
  const big65 = g3(`    WORLD v OF ${names.join(', ')}`, '', maps65);
  check_('64 names are allowed (the checker; 64 MAPs are the language\'s limit)', !errs(big64, 3).some((d) => /at most 64 maps in the list/.test(d.message)), msgs(errs(big64, 3)).slice(0, 200));
  badAt('65 names: an error "WORLD ... OF: at most 64 maps in the list (65 given)" at the 65th', big65, 'WORLD ... OF: at most 64 maps in the list (65 given)', at(big65, 'm64', 1), 3);
  // the index expression
  const strIdx = g3('    WORLD "a" OF second');
  check_('a string index is an error (a number is wanted)', errs(strIdx, 3).some((d) => /number|string/i.test(d.message) && d.line === at(strIdx, '"a"').line), msgs(errs(strIdx, 3)));
  const undefIdx = g3('    WORLD nope + 1 OF second');
  check_('an undeclared variable in the index is as undeclared anywhere (error or the usual implicit rule): no crash', Array.isArray(diag(undefIdx, 3)));
  const useVar = g3('    WORLD k OF second', '', W3).replace('DIM v', 'DIM v, k');
  check_('a variable read only in the index counts as read (no "never used" for it)', !warns(useVar, 3).some((d) => /variable 'k'/.test(d.message)), msgs(warns(useVar, 3)));
  // constant index out of range: a warning
  const c9 = g3('    WORLD 9 OF second, third');
  const w9 = warns(c9, 3).find((d) => /WORLD 9 OF \.\.\.: the list has 2 maps \(0\.\.1\): this statement does nothing/.test(d.message));
  check_('a constant index past the end is a warning, at the index ("WORLD 9 OF ...: the list has 2 maps (0..1): this statement does nothing")', !!w9 && w9.line === at(c9, '9 OF').line && w9.col === at(c9, '9 OF').col && errs(c9, 3).length === 0, msgs(diag(c9, 3)));
  const cn = g3('    WORLD -1 OF second, third');
  check_('a negative constant index is the same warning (-1)', warns(cn, 3).some((d) => /WORLD -1 OF \.\.\.: the list has 2 maps/.test(d.message)), msgs(warns(cn, 3)));
  const c1 = g3('    WORLD 3 OF second');
  check_('"only 1 map" for a list of one', warns(c1, 3).some((d) => /the list has only 1 map \(0\.\.0\)/.test(d.message)), msgs(warns(c1, 3)));
  const cOk = g3('    WORLD 1 OF second, third');
  check_('a constant index in range has no warning', !warns(cOk, 3).some((d) => /does nothing/.test(d.message)), msgs(warns(cOk, 3)));
  const cc = g3('    WORLD K OF second, third', '', W3).replace('GAME "t"\n', 'GAME "t"\nCONST K = 7\n');
  check_('a CONST index is folded: out of range is a warning too', warns(cc, 3).some((d) => /WORLD 7 OF/.test(d.message)), msgs(diag(cc, 3)));
  check_('a run-time index (a variable) never warns about the range', !warns(g3('    WORLD v OF second, third'), 3).some((d) => /does nothing/.test(d.message)));
  // the warning does not stop the build and the statement compiles to nothing (section 4 checks the bytes)
  check_('... and the compiler builds the program with the warning in its list', cmp(c9, 3).errors.length === 0 && cmp(c9, 3).warnings.some((d) => /does nothing/.test(d.message)), errText(cmp(c9, 3)));
  // a world statement in a PROC nobody calls is checked like any statement
  const inProc = g3('    CALL go()', '', W3).replace('SCENE s\n', 'SCENE s\n  PROC go()\n    WORLD v OF second, nowhere\n  ENDP\n');
  badAt('a list in a PROC is checked like any statement', inProc, "WORLD: unknown MAP 'nowhere'", at(inProc, 'nowhere'), 3);
  // an old runtime
  const noRt = { rt: { ...REAL[3].rt, symbols: { ...REAL[3].rt.symbols } }, img: REAL[3].img };
  delete noRt.rt.symbols.RT_WORLDLOAD;
  const nr = cmp(g3('    WORLD v OF second, third'), 3, ASSETS11, {}, noRt);
  check_('a runtime without RT_WORLDLOAD: the same message as WORLD name ("WORLD needs RT_WORLDLOAD, which this runtime does not provide ...")', nr.errors.some((e) => /^WORLD needs RT_WORLDLOAD, which this runtime does not provide/.test(e.message)), errText(nr));
}

// =================================================================================================================
// 3. The reference interpreter
// =================================================================================================================
console.log('\n3. The reference interpreter: signed index, in range, negative, past the end');
{
  const run3 = (src, ticks = 4) => interpret(parse(src).ast, { version: 3, ticks, assets: ASSETS11, maxSteps: 1e9, border0: 1 });
  const run4 = (src, ticks = 4) => interpret(parse(src).ast, { version: 4, ticks, assets: ASSETS11, maxSteps: 1e9, border0: 1 });
  const world = (r, t) => (t === 0 ? r.init : r.ticks[t - 1]);
  // each world has a distinct width: level 48, second 60, third 24, fourth 128; read the width through the camera limit: CAMERA 30000 then CAMX()
  const FR = '    n = v - 3\n    CAMERA 30000\n    a = CAMX()\n    WORLD n OF level, second, third, fourth\n    b = CAMX()\n    CAMERA 30000\n    c = CAMX()';
  const src = g3(FR, '', W3F).replace('DIM v', 'DIM v, n, a, b, c');
  const r = run3(src.replace('PROC FRAME()\n', 'PROC FRAME()\n    v = v + 1\n'), 9);
  const rows = [];
  for (let t = 1; t <= 9; t++) { const x = world(r, t); rows.push(`${x.vars.N}:${x.vars.C}`); }
  // v = 1..9 -> n = -2 .. 6; widths 48, 60, 24, 128 give camera limits (w * 8 - 192)
  const cl = (w) => w * 8 - 192;
  const want = [-2, -1, 0, 1, 2, 3, 4, 5, 6];
  // the camera limit after a valid load is that world's; after an invalid index it stays the previous world's. Track the expected one.
  let cur = 48;
  const expect = [];
  for (const n of want) { if (n >= 0 && n <= 3) cur = [48, 60, 24, 128][n]; expect.push(cl(cur)); }
  check_('v3: index -2, -1 do nothing; 0..3 load level / second / third / fourth (the camera limit shows which); 4, 5, 6 do nothing again', JSON.stringify(rows.map((x) => Number(x.split(':')[1]))) === JSON.stringify(expect), `${rows.join(' ')} vs ${expect.join(' ')}`);
  // the camera: reset to 0 by a valid load, untouched by an invalid one
  const camSrc = g3('    v = v + 1\n    CAMERA 100\n    WORLD v - 2 OF second, level\n    b = CAMX()', '', W3).replace('DIM v', 'DIM v, b');
  const rc = run3(camSrc, 4);
  check_('a valid index sets the camera to 0 (WORLD name does); an invalid one leaves the camera at 100 (no camera change, no redraw)', JSON.stringify([1, 2, 3, 4].map((t) => world(rc, t).vars.B)) === JSON.stringify([100, 0, 0, 100]), JSON.stringify([1, 2, 3, 4].map((t) => world(rc, t).vars.B)));
  // equal to the explicit form, tick by tick, everything in the record
  const lst = g3('    v = v + 1\n    SETWORLD 8 * 5, 8 * 13 = 2\n    WORLD v - 1 OF second, third, level\n    a = WORLDTILE(8 * 5, 8 * 13)', '', W3).replace('DIM v', 'DIM v, a');
  const exp = g3('    v = v + 1\n    SETWORLD 8 * 5, 8 * 13 = 2\n    IF v - 1 = 0 THEN WORLD second ENDIF\n    IF v - 1 = 1 THEN WORLD third ENDIF\n    IF v - 1 = 2 THEN WORLD level ENDIF\n    a = WORLDTILE(8 * 5, 8 * 13)', '', W3).replace('DIM v', 'DIM v, a');
  const a1 = run3(lst, 6), a2 = run3(exp, 6);
  check_('v3: WORLD n OF a, b, c gives the same record every tick as the IF chain of WORLD name (worlds, camera, variables, cells)', JSON.stringify(a1.ticks) === JSON.stringify(a2.ticks) && JSON.stringify(a1.init) === JSON.stringify(a2.init));
  // v4
  const FR4 = '    v = v + 1\n    n = v - 3\n    VIEW 3000, 2900, 70\n    WORLD n OF level, other, bigger, huge\n    a = WALL(300, 300)';
  const s4 = g4(FR4, '', W4H).replace('DIM v', 'DIM v, n, a');
  const r4 = run4(s4, 8);
  const e4 = g4('    v = v + 1\n    n = v - 3\n    VIEW 3000, 2900, 70\n    IF n = 0 THEN WORLD level ENDIF\n    IF n = 1 THEN WORLD other ENDIF\n    IF n = 2 THEN WORLD bigger ENDIF\n    IF n = 3 THEN WORLD huge ENDIF\n    a = WALL(300, 300)', '', W4H).replace('DIM v', 'DIM v, n, a');
  const r4e = run4(e4, 8);
  check_('v4: the same: the list form equals the IF chain of WORLD name on every tick (plan, pose clamped into the new map, wall reads)', JSON.stringify(r4.ticks) === JSON.stringify(r4e.ticks) && r4.ticks.length === 8);
  check_('... and the plans are different (the record changes when the list loads another plan)', JSON.stringify(r4.ticks[3]) !== JSON.stringify(r4.ticks[0]));
  // signed 16 bit
  const wrap = g3('    n = 40000\n    CAMERA 100\n    WORLD n OF second, third\n    b = CAMX()', '', W3).replace('DIM v', 'DIM v, n, b');
  check_('the index is signed 16 bit: 40000 is -25536 and does nothing', run3(wrap, 1).ticks[0].vars.B === 100 && run3(wrap, 1).ticks[0].vars.N === -25536);
  const wrap2 = g3('    n = 65535\n    CAMERA 100\n    WORLD n OF second, third\n    b = CAMX()', '', W3).replace('DIM v', 'DIM v, n, b');
  check_('65535 is -1: nothing', run3(wrap2, 1).ticks[0].vars.B === 100);
  const constRange = g3('    CAMERA 100\n    WORLD 9 OF second, third\n    b = CAMX()', '', W3).replace('DIM v', 'DIM v, b');
  check_('a constant index past the end does nothing in the interpreter too (camera stays 100)', run3(constRange, 1).ticks[0].vars.B === 100);
  // the index is evaluated once and may have side effects through FN calls: evaluated even when out of range
  const fn = g3('    CAMERA 100\n    WORLD FN pick(v) OF second, third\n    b = CAMX()', '', W3).replace('DIM v', 'DIM v, b').replace('GAME "t"\n', 'GAME "t"\nDEF FN pick(x) = x * 5\n');
  check_('the index may call a DEF FN (v = 0: FN pick(0) = 0, valid, camera 0)', run3(fn, 1).ticks[0].vars.B === 0, JSON.stringify(run3(fn, 1).ticks[0].vars));
  // no world statement in a program without a WINDOW: the interpreter refuses like WORLD name
  let threw = false;
  try { run3(`${HEAD}MAP second = "t0"\n${scene('', '    WORLD v OF second')}`); } catch (e) { threw = /WORLD without a WINDOW|WINDOW/.test(e.message); }
  check_('without a WINDOW / VIEW3D the interpreter refuses (as WORLD name)', threw);
  // a listed map is a world, not a screen map: it is not loaded at boot (the interpreter holds up to 64 MAPs)
}

// =================================================================================================================
// 4. Code generation
// =================================================================================================================
console.log('\n4. Code: constant index = WORLD name, the list entries, lib$worldidx');
{
  const only = (frame, table) => table.filter(([n]) => new RegExp(`\\b${n}\\b`).test(frame)).map(([n, a]) => `MAP ${n} = "${a}"\n`).join('');
  const base3 = (frame, opts = {}) => cmp(g3(frame, '', only(frame, [['second', 'w60'], ['third', 'w24'], ['fourth', 'w128']])), 3, undefined, opts);
  const base4 = (frame, opts = {}) => cmp(g4(frame, '', only(frame, [['other', 'p8'], ['bigger', 'p20'], ['huge', 'p32']])), 4, undefined, opts);
  const o0 = base3('    v = 1'), n0 = o0.gen.code.length;
  // a constant index in range compiles to the WORLD name code
  for (const [v, mk, base, names] of [[3, g3, base3, ['level', 'second', 'third', 'fourth']], [4, g4, base4, ['level', 'other', 'bigger', 'huge']]]) {
    // every program names every map (in a dead IF block), so that the maps are worlds in both; only the first statement differs
    const dead = names.slice(1).map((n) => `      WORLD ${n}\n`).join('');
    const tail = `\n    IF v = 99 THEN\n${dead}    ENDIF`;
    const full = (stmt) => cmp(mk(stmt + tail, '', v === 3 ? W3F : W4H), v);
    let same = true, why = '';
    for (let k = 0; k < 4; k++) {
      const a = full(`    WORLD ${k} OF ${names.join(', ')}`), b = full(`    WORLD ${names[k]}`);
      if (a.errors.length || b.errors.length || !sameBytes(a.gen.code, b.gen.code) || a.memory.length !== b.memory.length || JSON.stringify(a.gen.fixups) !== JSON.stringify(b.gen.fixups)) { same = false; why += `${k}: ${errText(a)}${errText(b)} `; }
    }
    check_(`v${v}: WORLD k OF ... with a constant k in range is byte for byte \`WORLD name\` (the code and the fixups; the image has the same size, the streams may be placed in another order), k = 0..3`, same, why);
    const oc = cmp(mk(`    WORLD K OF ${names.join(', ')}` + tail, '', v === 3 ? W3F : W4H).replace('GAME "t"\n', 'GAME "t"\nCONST K = 2\n'), v);
    check_(`v${v}: a CONST index folds the same way (K = 2 is \`WORLD ${names[2]}\`)`, oc.errors.length === 0 && sameBytes(oc.gen.code, full(`    WORLD ${names[2]}`).gen.code), errText(oc));
    const out = full(`    WORLD 4 OF ${names.join(', ')}`), outN = full(`    WORLD -1 OF ${names.join(', ')}`), nothing = full('');
    check_(`v${v}: a constant index outside the list compiles to nothing (past the end, and -1): code, image and fixups are those of the program without the statement`, sameBytes(out.gen.code, nothing.gen.code) && sameBytes(outN.gen.code, nothing.gen.code) && sameBytes(out.memory, nothing.memory) && JSON.stringify(out.gen.fixups) === JSON.stringify(nothing.gen.fixups) && out.errors.length === 0, `${out.gen.code.length} ${outN.gen.code.length} ${nothing.gen.code.length}`);
  }
  // the variable index: the call site and the helper
  const v3 = (frame) => base3(frame);
  const one = v3('    WORLD v OF level, second, third'), noStmt = v3('    v = v');
  const code = one.gen.code;
  const helper3 = [0xE5, 0xB7, 0xED, 0x42, 0xE1, 0xD0, 0x44, 0x4D, 0x29, 0x29, 0x09, 0x19, 0x5E, 0x23, 0x56, 0x23, 0x7E, 0x23, 0xD5, 0x5E, 0x23, 0x56, 0xE1, 0xC3];
  const idxOf = (hay, needle) => { for (let i = 0; i + needle.length <= hay.length; i++) { let k = 0; while (k < needle.length && hay[i + k] === needle[k]) k++; if (k === needle.length) return i; } return -1; };
  const hAt = idxOf(code, helper3);
  check_('v3: lib$worldidx = PUSH HL / OR A / SBC HL,BC / POP HL / RET NC / LD B,H / LD C,L / ADD HL,HL / ADD HL,HL / ADD HL,BC / ADD HL,DE / LD E,(HL) / INC HL / LD D,(HL) / INC HL / LD A,(HL) / INC HL / PUSH DE / LD E,(HL) / INC HL / LD D,(HL) / POP HL / JP RT_WORLDLOAD (26 bytes)', hAt >= 0 && rd16(code, hAt + 24) === REAL[3].rt.symbols.RT_WORLDLOAD, hAt < 0 ? 'helper not found' : `${hex(rd16(code, hAt + 24))} vs ${hex(REAL[3].rt.symbols.RT_WORLDLOAD)}`);
  // Compiler size pass (docs/ARCADE_COMPILER_SIZE_CONTRACT.md): the call site is LD HL,(v) / LD DE,list / LD BC,3 and then lib$worldidx is reached by a CALL, or, as the last
  // statement of the PROC (`CALL x / RET` is a tail jump), by a JR (lib$worldidx is in reach; a JP when it is not)
  const hop = (cc, base_, i) => (cc[i] === 0xCD || cc[i] === 0xC3 ? { len: 3, to: cc[i + 1] | (cc[i + 2] << 8), how: cc[i] === 0xCD ? 'CALL' : 'JP' } : cc[i] === 0x18 ? { len: 2, to: base_ + i + 2 + ((cc[i + 1] << 24) >> 24), how: 'JR' } : null);
  const siteOf = (cc, base_, target) => { for (let i = 0; i + 9 < cc.length; i++) if (cc[i] === 0x2A && cc[i + 3] === 0x11 && cc[i + 6] === 0x01 && cc[i + 7] === 3 && cc[i + 8] === 0) { const h = hop(cc, base_, i + 9); if (h && h.to === target) return { at: i, how: h.how, len: h.len }; } return null; };
  const st = hAt < 0 ? null : siteOf(code, one.gen.base, one.gen.base + hAt);
  check_('... called once as LD HL,(v) / LD DE,list / LD BC,3 / then lib$worldidx: the last statement of the PROC, so the tail jump JR lib$worldidx (index in HL, list in DE, count in BC)', !!st && st.how === 'JR' && [...code.keys()].filter((i) => code[i] === 0x2A && code[i + 3] === 0x11 && code[i + 6] === 0x01 && code[i + 7] === 3 && code[i + 8] === 0 && hop(code, one.gen.base, i + 9)?.to === one.gen.base + hAt).length === 1, !st ? 'call not found' : `${st.how}`);
  {
    const oo = base3('    WORLD v OF level, second, third', CODEGEN_OFF), noo = base3('    v = v', CODEGEN_OFF), ho = idxOf(oo.gen.code, helper3);
    const so = ho < 0 ? null : siteOf(oo.gen.code, oo.gen.base, oo.gen.base + ho);
    check_('CODEGEN_OFF: the original call site LD HL,(v) / LD DE,list / LD BC,3 / CALL lib$worldidx / RET, and the first list statement costs 12 + 26 + 15 - 6 = 47 bytes over `v = v`', !!so && so.how === 'CALL' && oo.gen.code[so.at + 12] === 0xC9 && oo.gen.code.length - noo.gen.code.length === 12 + 26 + 15 - 6, so ? `${so.how} ${oo.gen.code.length - noo.gen.code.length}` : 'helper / site not found');
  }
  const entries3 = one.gen.fixups.length;
  check_('the list has one entry per name: 3 fixups (the DW src of each, nothing else)', entries3 === 3, `${entries3}`);
  const stride = one.gen.fixups[1].at - one.gen.fixups[0].at;
  check_('v3: an entry is 5 bytes (DW src, DB world_w, DW cam_max): the fixups are 5 apart', stride === 5 && one.gen.fixups[2].at - one.gen.fixups[1].at === 5, `${stride}`);
  // the entries read back from the image
  const win = one.gen.window;
  const bandCodes = win.bands.map((b) => b.code);
  const widthOf = { level: 48, second: 60, third: 24, fourth: 128 };
  const names3 = ['level', 'second', 'third'];
  let entryOk = true, entryWhy = '';
  one.gen.fixups.forEach((f, i) => {
    const w = widthOf[names3[i]], src = rd16(one.memory, f.at), ww = one.memory[f.at + 2], cm = rd16(one.memory, f.at + 3);
    if (ww !== w || cm !== camMax(w, bandCodes) || src < 0x8000) { entryOk = false; entryWhy += `${names3[i]}: src ${hex(src)} w ${ww} cam ${cm} (want ${w}, ${camMax(w, bandCodes)}); `; }
  });
  check_('v3: each entry in the image holds world_w and cam_max of its map (camMax(world_w, bands)), and a source address in the mapped part', entryOk, entryWhy);
  // the size: the list statement costs 3 + 3 + 3 + 3 = 12 at the call site, once the helper (26) and the list (5 per name)
  const d1 = one.gen.code.length - noStmt.gen.code.length;
  check_('v3: the first list statement costs LD HL,(v) 3 + LD DE 3 + LD BC 3 + JR 2 (the tail jump: no CALL, no RET after it) + helper 26 + list 15 = 52 bytes, over `v = v` (LD HL,(v) 3 + LD (v),HL 3 + the PROC\'s RET 1 = 7 bytes) 45', d1 === 11 + 26 + 15 - 7, `${d1}`);
  const two = v3('    WORLD v OF level, second, third\n    WORLD v + 1 OF level, second, third');
  const dd = two.gen.code.length - one.gen.code.length;
  check_('v3: a second statement with the SAME list shares the helper and the list: it costs only its call site (index expression + 9 bytes)', dd > 0 && dd <= 9 + 8 && two.gen.fixups.length === 3, `${dd}, ${two.gen.fixups.length} fixups`);
  const diff = v3('    WORLD v OF level, second, third\n    WORLD v OF third, second, level');
  check_('v3: a different order is a different list (2 x 3 fixups)', diff.gen.fixups.length === 6, `${diff.gen.fixups.length}`);
  const sub = v3('    WORLD v OF level, second, third\n    WORLD v OF level, second');
  check_('v3: a shorter list is a different list too (3 + 2 fixups)', sub.gen.fixups.length === 5);
  const dupList = v3('    WORLD v OF second, second, second');
  check_('v3: the same name three times is a list of 3 entries (three fixups to one stream)', dupList.gen.fixups.length === 3 && new Set(dupList.gen.fixups.map((f) => rd16(dupList.memory, f.at))).size === 1);
  const mixed = v3('    WORLD v OF level, second\n    WORLD 1 OF level, second\n    WORLD second');
  check_('v3: a constant-index list statement adds no list and no helper (only the direct WORLD code): 2 fixups for the list + 2 direct', mixed.gen.fixups.length === 4);
  const direct = v3('    WORLD 1 OF level, second, third');
  check_('v3: with only constant indexes there is no helper and no list at all (the helper bytes are absent)', idxOf(direct.gen.code, helper3) < 0 && direct.gen.fixups.length === 1);
  // v4
  const o4 = base4('    WORLD v OF level, other, bigger'), n4 = base4('    v = v');
  const helper4 = [0xE5, 0xB7, 0xED, 0x42, 0xE1, 0xD0, 0x29, 0x29, 0x19, 0x5E, 0x23, 0x56, 0x23, 0x46, 0x23, 0x4E, 0xEB, 0xC3];
  const h4 = idxOf(o4.gen.code, helper4);
  check_('v4: lib$worldidx = PUSH HL / OR A / SBC HL,BC / POP HL / RET NC / ADD HL,HL / ADD HL,HL / ADD HL,DE / LD E,(HL) / INC HL / LD D,(HL) / INC HL / LD B,(HL) / INC HL / LD C,(HL) / EX DE,HL / JP RT_PLANLOAD (20 bytes)', h4 >= 0 && rd16(o4.gen.code, h4 + 18) === REAL[4].rt.symbols.RT_PLANLOAD, h4 < 0 ? 'helper not found' : `${hex(rd16(o4.gen.code, h4 + 18))}`);
  check_('v4: an entry is 4 bytes (DW src, DB map_w, DB map_h): fixups 4 apart', o4.gen.fixups.length === 3 && o4.gen.fixups[1].at - o4.gen.fixups[0].at === 4 && o4.gen.fixups[2].at - o4.gen.fixups[1].at === 4);
  const plans = { level: [12, 12], other: [8, 6], bigger: [20, 14] };
  let pOk = true, pWhy = '';
  ['level', 'other', 'bigger'].forEach((nm, i) => { const f = o4.gen.fixups[i]; if (o4.memory[f.at + 2] !== plans[nm][0] || o4.memory[f.at + 3] !== plans[nm][1]) { pOk = false; pWhy += `${nm}: ${o4.memory[f.at + 2]}x${o4.memory[f.at + 3]}; `; } });
  check_('v4: each entry holds map_w and map_h of its plan (12 x 12, 8 x 6, 20 x 14)', pOk, pWhy);
  const d4 = o4.gen.code.length - n4.gen.code.length;
  check_('v4: the first list statement costs 11 + 20 + 12 - 7 = 36 bytes over `v = v` (the call site is LD HL,(v) 3 + LD DE 3 + LD BC 3 + JR 2, the PROC\'s RET is not needed after the tail jump; 38 with CALL and RET)', d4 === 11 + 20 + 12 - 7, `${d4}`);
  {
    const d4o = base4('    WORLD v OF level, other, bigger', CODEGEN_OFF).gen.code.length - base4('    v = v', CODEGEN_OFF).gen.code.length;
    check_('CODEGEN_OFF v4: the first list statement costs 12 + 20 + 12 - 6 = 38 bytes over `v = v` (CALL lib$worldidx / RET, the original)', d4o === 12 + 20 + 12 - 6, `${d4o}`);
  }
  // no helper without the form, in a program with WORLD name
  const plainW = base3('    WORLD second');
  check_('a program with only `WORLD name` has no lib$worldidx (the helper is present only when used)', idxOf(plainW.gen.code, helper3) < 0);
  // the variable index in other positions
  const prc = g3('    CALL go(v)', '', W3).replace('SCENE s\n', 'SCENE s\n  PROC go(n)\n    WORLD n OF second, third\n  ENDP\n');
  check_('a list in a PROC with a parameter as the index compiles', cmp(prc, 3).errors.length === 0, errText(cmp(prc, 3)));
  const arr = g3('    WORLD a(1) OF second, third', '', W3).replace('DIM v', 'DIM v, a(3)');
  check_('an array element as the index compiles', cmp(arr, 3).errors.length === 0, errText(cmp(arr, 3)));
  const complex = g3('    WORLD (v * 3 + 1) MOD 4 OF level, second, third, fourth', '', W3F);
  check_('a complex index compiles (it is evaluated to HL before the call)', cmp(complex, 3).errors.length === 0, errText(cmp(complex, 3)));
  // a list in a scene a game enters: lists shared across scenes by their names
  const sc2 = `${HEAD}SPRITE ship = "orb"\nMAP level = "lv"\n${W3}WINDOW level\nSCENE a\n  DIM v\n  PROC INIT()\n    WORLD v OF second, third\n  ENDP\n  PROC FRAME()\n    ENTER b\n  ENDP\nENDSCENE\nSCENE b\n  DIM v\n  PROC INIT()\n    WORLD v OF second, third\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`;
  const osc = cmp(sc2, 3);
  check_('the same list in two scenes is one list (2 fixups, the helper once)', osc.errors.length === 0 && osc.gen.fixups.length === 2, errText(osc) + osc.gen.fixups.length);
  // determinism and the usage figures
  const again = base3('    WORLD v OF level, second, third');
  check_('the same source compiles to the same image twice', sameBytes(one.memory, again.memory) && sameBytes(one.dck, again.dck));
  check_('the program builds a cartridge (a DCK) and fits', !!one.dck && one.errors.length === 0, errText(one));
  // statement order: the index is evaluated at the statement (side effects of an FN), the helper after the call
  const fn = g3('    WORLD FN pick(v) OF second, third', '', W3).replace('GAME "t"\n', 'GAME "t"\nDEF FN pick(x) = x + 1\n');
  check_('a DEF FN in the index is followed for reachability and compiles', cmp(fn, 3).errors.length === 0, errText(cmp(fn, 3)));
  // header comment block
  const gsrc = readFileSync(join(ROOT, 'src/lang/arcade/arcade-codegen.js'), 'utf8');
  check_('arcade-codegen.js has the header block "Batch 6" that records the decisions (B6-1)', /Batch 6 \(docs\/ARCADE_LANGUAGE_BATCH6\.md Part A\)/.test(gsrc) && /B6-1\./.test(gsrc));
}

// =================================================================================================================
// 5. Streams and fixups: mapped and banked
// =================================================================================================================
console.log('\n5. Streams and fixups: each listed world / plan is stored once, mapped or banked, and the list points at it');
{
  const rleBytes = (o, key) => { const st = o.gen.streams.find((s) => s.key === key); return st ? [...st.data] : null; };
  const srcMapped = g3('    WORLD v OF level, second, third, second');
  const o = cmp(srcMapped, 3);
  check_('v3: compiles; gen.streams holds second and third once each (the WINDOW\'s own map is the window\'s, not a stream), though `second` is listed twice', o.errors.length === 0 && o.gen.streams.map((s) => s.key).sort().join() === 'SECOND,THIRD', errText(o) + JSON.stringify(o.gen.streams.map((s) => s.key)));
  const addr = (f) => rd16(o.memory, f.at);
  const f = o.gen.fixups;
  check_('the list has 4 fixups; the two entries for `second` point to the same address', f.length === 4 && addr(f[1]) === addr(f[3]) && addr(f[0]) !== addr(f[1]) && addr(f[1]) !== addr(f[2]));
  check_('the bytes at the fixup addresses are the RLE streams of second and third, read back from the image', sameBytes([...o.memory.slice(addr(f[1]), addr(f[1]) + rleBytes(o, 'SECOND').length)], rleBytes(o, 'SECOND')) && sameBytes([...o.memory.slice(addr(f[2]), addr(f[2]) + rleBytes(o, 'THIRD').length)], rleBytes(o, 'THIRD')));
  // the window's own map: the list entry points to the stream in the window data
  const winSrcAddr = o.usage.window?.at?.worldSrc;
  check_('the entry for the WINDOW\'s own map (level) points to the world source the window descriptor uses (window.at.worldSrc)', winSrcAddr !== undefined && addr(f[0]) === winSrcAddr, `${hex(addr(f[0]))} vs ${winSrcAddr === undefined ? 'undefined' : hex(winSrcAddr)}`);
  // banked: bankAll
  const ob = cmp(srcMapped, 3, ASSETS11, { bankAll: true });
  check_('bankAll: compiles; level (the window\'s), second and third are banked', ob.errors.length === 0 && ob.usage.banked.assets.map((a) => a.name).sort().join() === 'level,second,third', errText(ob) + JSON.stringify(ob.usage.banked.assets));
  const fb = ob.gen.fixups;
  const bAddr = fb.map((x) => rd16(ob.memory, x.at));
  check_('... every entry points into the window ($4000..$7FFF); the two `second` entries to the same record', bAddr.every((a) => a >= 0x4000 && a < 0x8000) && bAddr[1] === bAddr[3] && new Set(bAddr).size === 3, JSON.stringify(bAddr.map(hex)));
  const secBank = ob.usage.banked.assets.find((a) => a.name === 'second'), thBank = ob.usage.banked.assets.find((a) => a.name === 'third');
  check_('... and they are the addresses the banked list of the usage gives (second, third)', bAddr[1] === secBank.at && bAddr[2] === thBank.at, `${hex(bAddr[1])} ${hex(secBank.at)}`);
  check_('... the RLE streams are at those addresses in the image (the window)', sameBytes([...ob.memory.slice(bAddr[1], bAddr[1] + rleBytes(ob, 'SECOND').length)], rleBytes(ob, 'SECOND')));
  check_('... the entries\' world_w and cam_max bytes are the same as in the mapped build (only the source address differs)', f.every((x, i) => sameBytes([...o.memory.slice(x.at + 2, x.at + 5)], [...ob.memory.slice(fb[i].at + 2, fb[i].at + 5)])));
  check_('... the code is the same bytes (the streams were never in it)', sameBytes(o.gen.code, ob.gen.code));
  // an override: bank only the maps the list names
  const ov = ['w60', 'w24'].reduce((as, n) => withBank(as, n, 'banked'), ASSETS11);
  const oo = cmp(srcMapped, 3, ov);
  check_('an override banks only the two listed worlds (bank: "banked" on w60, w24); the window\'s map stays mapped', oo.errors.length === 0 && oo.usage.banked.assets.map((a) => a.name).sort().join() === 'second,third', errText(oo) + JSON.stringify(oo.usage.banked.assets));
  const ob2 = oo.gen.fixups.map((x) => rd16(oo.memory, x.at));
  check_('... the window\'s own entry is a mapped address, the others are window addresses', ob2[0] >= 0x8000 && ob2[1] >= 0x4000 && ob2[1] < 0x8000 && ob2[2] >= 0x4000 && ob2[2] < 0x8000, JSON.stringify(ob2.map(hex)));
  const dckSize = (r) => r.dck.length;
  check_('the DCK ships the window chunk when something is banked and not otherwise', dckSize(ob) > dckSize(o));
  // v4
  const o4 = cmp(g4('    WORLD v OF level, other, bigger, other'), 4), b4 = cmp(g4('    WORLD v OF level, other, bigger, other'), 4, ASSETS11, { bankAll: true });
  const a4 = o4.gen.fixups.map((x) => rd16(o4.memory, x.at)), c4 = b4.gen.fixups.map((x) => rd16(b4.memory, x.at));
  check_('v4: four entries (4 bytes apart); the two `other` entries share one plan; streams: other and bigger once each', o4.errors.length === 0 && a4.length === 4 && a4[1] === a4[3] && o4.gen.streams.map((s) => s.key).sort().join() === 'BIGGER,OTHER', errText(o4));
  check_('v4 bankAll: the entries point into the window and the streams are there byte for byte', b4.errors.length === 0 && c4.every((a) => a >= 0x4000 && a < 0x8000) && sameBytes([...b4.memory.slice(c4[1], c4[1] + rleBytes(b4, 'OTHER').length)], rleBytes(b4, 'OTHER')), errText(b4));
  check_('v4: the entries\' map_w / map_h are read back (8 x 6 for other, 20 x 14 for bigger)', o4.memory[o4.gen.fixups[1].at + 2] === 8 && o4.memory[o4.gen.fixups[1].at + 3] === 6 && o4.memory[o4.gen.fixups[2].at + 2] === 20 && o4.memory[o4.gen.fixups[2].at + 3] === 14);
  // a map named both by a list and by WORLD name is stored once
  const both = cmp(g3('    WORLD v OF second, third\n    WORLD second\n    WORLD 1 OF level, third, second'), 3);
  check_('a map named by a list and by WORLD name (and a constant index) is stored once', both.errors.length === 0 && both.gen.streams.filter((s) => s.key === 'SECOND').length === 1 && both.gen.streams.length === 2, errText(both));
  // placement: a map only a list names is a world, not a screen map (it is not in the map table)
  check_('a map only a list names is a world, not a screen map: w60 (60 x 16) would be an invalid screen map, and the game builds; the same MAP unlisted is the error "map w must be a whole number 1..32"', cmp(g3('    WORLD v OF second, third'), 3).errors.length === 0 && /map w must be a whole number 1\.\.32/.test(errText(cmp(g3('    v = 1'), 3))));
  // the DCK holds the list: nothing else moves between mapped and banked (the cartridge tests on the machine are in the differential)
  check_('the program with a list and the program with the IF chain have the same world streams (placement by the same policy)', JSON.stringify(cmp(g3('    WORLD v OF second, third'), 3).gen.streams.map((s) => [s.key, s.data.length])) === JSON.stringify(cmp(g3('    IF v = 0 THEN WORLD second ENDIF\n    IF v = 1 THEN WORLD third ENDIF'), 3).gen.streams.map((s) => [s.key, s.data.length])));
  // 64 worlds in one list (the language's limit)
  const names = Array.from({ length: 63 }, (_, i) => `m${i}`);
  const maps63 = names.map((n, i) => `MAP ${n} = "${i % 2 ? 'w24' : 'w30'}"\n`).join('');
  const l64 = cmp(g3(`    WORLD v OF level, ${names.join(', ')}`, '', maps63), 3);
  check_('a list of 64 names (the window\'s own map and 63 more) compiles and has 64 fixups', l64.errors.length === 0 && l64.gen.fixups.length === 64, errText(l64).slice(0, 200));
  const l64b = cmp(g3(`    WORLD v OF level, ${names.join(', ')}`, '', maps63), 3, ASSETS11, { bankAll: true });
  check_('... also with bankAll (64 banked worlds: 2 distinct streams plus the window\'s)', l64b.errors.length === 0 && l64b.gen.fixups.length === 64, errText(l64b).slice(0, 200));
}

// =================================================================================================================
// 6. Editor helper and word help
// =================================================================================================================
console.log('\n6. The editor: completion context after OF, the listed names, the word help');
{
  check_('inWorldList: true right after OF, after OF and a name and a comma, with and without spaces', ['WORLD lv OF', 'WORLD lv OF a,', 'WORLD lv OF a, b,', '  WORLD n + 1 OF  a ,', 'WORLD (v MOD 4) OF a,b,'].every((h) => inWorldList(h)));
  check_('... false elsewhere: before OF, after a name with no comma, in another statement, in a line that only has the word `of`', ['WORLD lv', 'WORLD lv OF a, b c', 'x = 1', 'LOADMAP', 'of = 3', 'v = of +'].every((h) => !inWorldList(h)));
  check_('... a label before the statement on the same line does not matter (name: WORLD ...)', inWorldList('lbl: WORLD v OF a,'));
  const src = g3('    WORLD v OF second, third');
  const s = scanArcade(src);
  check_('scanArcade lists the MAP declarations a list names (the editor offers them after OF, and finds their definitions: definitionOf looks them up by name)', ['second', 'third'].every((n) => s.assets.some((a) => a.kind === 'MAP' && a.name === n)), JSON.stringify(s.assets.map((a) => a.name)));
  // occurrences (rename / go to definition): the listed names are identifier tokens like any other use
  const toks = tokenize('    WORLD v OF second, third').filter((t) => t.type === 'ident');
  check_('the listed names and `OF` are identifier tokens (a list name is found by the editor\'s occurrence scan; OF is not a keyword, so it is not highlighted as one)', toks.map((t) => t.value).join() === 'V,OF,SECOND,THIRD');
  check_('the WORLD word help says what the new form does (n OF a, b, c, 0-based, outside the list nothing)', /WORLD n OF a, b, c/.test(ARCADE_WORDS.get('WORLD').desc) && /below 0 or past the last does nothing/.test(ARCADE_WORDS.get('WORLD').desc) && ARCADE_WORDS.get('WORLD').syntax === 'WORLD map');
  const ed = readFileSync(join(ROOT, 'src/lang/arcade/editor.js'), 'utf8');
  check_('editor.js completion uses inWorldList (the MAP names after OF)', /inWorldList\(head\)/.test(ed) && /prevWord === 'WORLD' \|\| worldList/.test(ed));
}

// =================================================================================================================
// 7. Byte identity with the previous compiler
// =================================================================================================================
console.log('\n7. Programs without the new form compile to exactly the bytes of the previous compiler');
{
  const oldDir = process.env.ARCADE_OLD ?? null;
  if (!oldDir) skip_('byte identity against the previous compiler', 'set ARCADE_OLD to a copy of the previous src/lang/arcade/ (git archive of the commit before batch 6)');
  else {
    const oldCompile = (await import(pathToFileURL(join(oldDir, 'arcade-compile.js')).href)).compile;
    const NEW_FORM = /\bWORLD\b[^\n:]*\bOF\b/i;
    const progs = [];
    let excluded = 0;
    for (const d of ['arcade/examples', 'arcade/tests/fixtures']) {
      if (!existsSync(join(ROOT, d))) continue;
      for (const f of readdirSync(join(ROOT, d)).filter((x) => x.endsWith('.arc')).sort()) {
        const text = readFileSync(join(ROOT, d, f), 'utf8');
        if (NEW_FORM.test(text.replace(/^\s*REM.*$/gim, ''))) { excluded++; continue; }      // a program that uses the new form is not one this section is about
        const aj = join(ROOT, d, f.replace('.arc', '.assets.json'));
        progs.push({ src: `${d}/${f}`, text, assets: existsSync(aj) ? JSON.parse(readFileSync(aj, 'utf8')) : undefined });
      }
    }
    const { genV3, genV4, ASSETS: A9 } = await import('./arcade-m9-common.mjs');
    for (let seed = 1; seed <= 6; seed++) { const a = genV3(seed), b = genV4(seed); progs.push({ src: `genV3(${seed})`, text: a.src, assets: a.assets ?? A9 }, { src: `genV4(${seed})`, text: b.src, assets: b.assets ?? A9 }); }
    // programs with WORLD name and with tables / lists of old forms, written here
    progs.push({ src: 'WORLD name (v3)', text: g3('    v = v + 1\n    IF v = 2 THEN WORLD second ENDIF\n    IF v = 3 THEN WORLD third ENDIF\n    IF v = 4 THEN WORLD level ENDIF'), assets: ASSETS11 });
    progs.push({ src: 'WORLD name (v4)', text: g4('    v = v + 1\n    IF v = 2 THEN WORLD other ENDIF\n    IF v = 3 THEN WORLD bigger ENDIF'), assets: ASSETS11 });
    progs.push({ src: 'a variable called of', text: g3('    of = of + 1\n    IF of = 2 THEN WORLD second ENDIF').replace('DIM v', 'DIM v, of'), assets: ASSETS11 });
    progs.push({ src: 'a MAP called of', text: g3('    WORLD of', '', 'MAP of = "w60"\n'), assets: ASSETS11 });
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
    check_(`${progs.length} programs (every example and fixture without the new form, the generated v3 / v4 programs, WORLD name, a variable and a MAP called of) on ${targets.length} runtime tables, normal and bankAll: ${n} compilations: image, DCK, code, errors, warnings, usage, fixups and the banked list are identical`, same === n && n > 0, bad);
    info(`byte identity: ${n} compilations compared, ${same} identical, ${built} of them built a cartridge; ${excluded} example / fixture file(s) use the new form and are excluded`);
    check_('and a good number of them built a cartridge (the comparison is not all errors)', built >= 20, `${built}`);
    const exs = progs.filter((p) => p.src.startsWith('arcade/examples/'));
    check_('the examples are among them (bounce, breakout, shooter, platformer, vaults, blockfall ...)', exs.length >= 6, `${exs.length}`);
  }
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}: ${passed} checks passed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed === 0 ? 0 : 1);
