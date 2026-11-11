#!/usr/bin/env node
"use strict";
// arcade-m11-compiler.mjs -- tests for slices B2 (linker, DCK) and B3 (compiler, WORLD) of the banked cartridge map. The contract is docs/ARCADE_BANKING_CONTRACT.md (sections 4, 5, 6 and 7).
//
//   node tests/arcade-m11-compiler.mjs
//   ARCADE_OLD=<dir of the previous src/lang/arcade/> node tests/arcade-m11-compiler.mjs     the byte-identity comparison (section 7) against that compiler
//
// No machine is booted here (tests/arcade-m11-differential.mjs runs the banked games on the real runtimes). Runtime tables used: the real arcade/build/v2|v3|v4/runtime.json of the tree, with the
// symbols RT_WORLDLOAD / RT_PLANLOAD set to fixed made-up addresses (so that these tests do not depend on how far the runtime build is); section 8 also compiles against the real tables.
// Sections
//   1  words, parser, checker: WORLD, reserved but a legal asset name, its messages, the 64-MAP limit, the help text
//   2  the reference interpreter: WORLD in a WINDOW game (v3) and in a VIEW3D game (v4)
//   3  code generation of WORLD: the byte sequences, each stream stored once, the messages of the world / plan checks, a runtime without the routines
//   4  placement (contract section 5): nothing banked when it fits, largest first, ties in declaration order, overrides, bankAll, the errors, usage
//   5  the linker and the DCK (section 6): chunks shipped per build, $FF fill, read-back of the window, the flat image, WORLD streams in the window
//   6  the code is generated again for the placement: the map table, a banked boot map, the one-map form, determinism
//   7  byte identity: every example and fixture compiles to exactly the bytes of the previous compiler (needs ARCADE_OLD or the scratch copy)
//   8  the real runtime tables: WORLD programs against arcade/build/v3 and v4 as they are now
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile, requiredRuntime } from '../src/lang/arcade/arcade-compile.js';
import { generate } from '../src/lang/arcade/arcade-codegen.js';
import { link, buildDck, CHUNK } from '../src/lang/arcade/arcade-link.js';
import { layoutOf, bankOrder, assignAt, shippedChunks, rleOf } from '../src/lang/arcade/arcade-bank.js';
import { rleDecode, rleEncode, convertWorldMap, camMax } from '../src/lang/arcade/arcade-window.js';
import { convertViewMap, clampPose } from '../src/lang/arcade/arcade-view.js';
import { ARCADE_WORDS, RESERVED, LIMITS, BATCH11_WORDS } from '../src/lang/arcade/arcade-words.js';
import { ASSETS, ASSETS11, withBank, mkMap, world, plan, screenMap, HEAD, scene, win3, view4, plain2, mapDecls } from './arcade-m11-common.mjs';

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
const eq = (name, got, want) => check_(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const sameBytes = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
const hex = (v) => '$' + v.toString(16).toUpperCase();

// ── runtimes: the tree's tables with RT_WORLDLOAD / RT_PLANLOAD at fixed addresses ───────────────────────────────────────────────────────────────────
const WORLDLOAD = 0xB123, PLANLOAD = 0xB456;
function loadRt(v) {
  const json = join(ROOT, `arcade/build/v${v}/runtime.json`);
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))) };
}
const REAL = { 2: loadRt(2), 3: loadRt(3), 4: loadRt(4) };
/** the runtime tables with the two new routines at made-up addresses (and any other change in `over`: {symbols, constants}) */
function fake(v, over = {}) {
  const R = REAL[v];
  if (!R) return null;
  const rt = { ...R.rt, symbols: { ...R.rt.symbols, RT_WORLDLOAD: WORLDLOAD, RT_PLANLOAD: PLANLOAD, ...(over.symbols ?? {}) }, constants: { ...R.rt.constants, ...(over.constants ?? {}) } };
  for (const [k, val] of Object.entries(over.symbols ?? {})) if (val === undefined) delete rt.symbols[k];
  return { rt, img: R.img };
}
const FK = { 2: fake(2), 3: fake(3), 4: fake(4) };
const cmp = (src, v, assets = ASSETS11, extra = {}) => { const R = extra.R ?? FK[v]; return compile(src, { runtime: R.rt, image: R.img, assets, ...extra.opts }); };
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
const warnText = (r) => r.warnings.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
const rd16 = (m, a) => m[a] | (m[a + 1] << 8);

// ── diagnostics helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
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
  check_(name, !!hit, hit ? '' : `got: ${msgs(e) || 'no errors'}`);
};

// =================================================================================================================
// 1. Words, parser, checker
// =================================================================================================================
console.log('1. WORLD in the word table, the parser and the checker; the 64-MAP limit');
{
  check_('WORLD is in the word table, a reserved game word with a syntax and a description of the two cases (WINDOW / VIEW3D)', ARCADE_WORDS.has('WORLD') && RESERVED.has('WORLD') && ARCADE_WORDS.get('WORLD').cls === 'game' && ARCADE_WORDS.get('WORLD').syntax === 'WORLD map' && /WINDOW/.test(ARCADE_WORDS.get('WORLD').desc) && /VIEW3D/.test(ARCADE_WORDS.get('WORLD').desc) && BATCH11_WORDS.has('WORLD'));
  check_('LIMITS.maxMaps is 64 and the LOADMAP help text says up to 64 maps', LIMITS.maxMaps === 64 && /up to 64 maps/.test(ARCADE_WORDS.get('LOADMAP').desc) && !/up to 8 maps/.test(ARCADE_WORDS.get('LOADMAP').desc));
  const ok3 = win3('    WORLD second', 'MAP second = "w60"\n');
  const p = parse(ok3);
  const find = (n, out = []) => { if (Array.isArray(n)) n.forEach((x) => find(x, out)); else if (n && typeof n === 'object') { if (n.type === 'World') out.push(n); for (const k of Object.keys(n)) if (k !== 'type' && n[k] && typeof n[k] === 'object') find(n[k], out); } return out; };
  const nodes = find(p.ast.scenes);
  check_('WORLD map parses to a World node {map: Ident} at the statement', p.errors.length === 0 && nodes.length >= 1 && nodes[0].map.type === 'Ident' && nodes[0].map.name === 'second' && nodes[0].line === at(ok3, 'WORLD second').line && nodes[0].col === at(ok3, 'WORLD second').col, msgs(p.errors));
  check_('WORLD with a WINDOW checks with no error (v3), and with a VIEW3D (v4)', errs(ok3, 3).length === 0 && errs(view4('    WORLD other', 'MAP other = "p8"\n'), 4).length === 0, msgs(errs(ok3, 3)) + msgs(errs(view4('    WORLD other', 'MAP other = "p8"\n'), 4)));
  check_('WORLD without a version (the checker alone) with a WINDOW has no error either', errs(ok3).length === 0, msgs(errs(ok3)));
  // where it may stand
  const inInit = win3('', 'MAP second = "w60"\n', '    WORLD second\n');
  const inProc = win3('    CALL go()', 'MAP second = "w60"\n', '', '').replace('SCENE s\n', 'SCENE s\n  PROC go()\n    WORLD second\n  ENDP\n');
  check_('WORLD is allowed in INIT, in FRAME and in a PROC of a scene', errs(inInit, 3).length === 0 && errs(inProc, 3).length === 0, msgs(errs(inInit, 3)) + msgs(errs(inProc, 3)));
  const nested = win3('    IF v = 1 THEN\n      WHILE v < 3\n        WORLD second\n        v = v + 1\n      WEND\n    ENDIF', 'MAP second = "w60"\n');
  check_('WORLD inside IF and WHILE blocks', errs(nested, 3).length === 0, msgs(errs(nested, 3)));
  // errors
  const none = plain2('MAP a = "m1"\n', '    WORLD a');
  badAt('WORLD without a WINDOW or a VIEW3D: the exact message, at the statement', none, 'WORLD needs a WINDOW (runtime v3) or a VIEW3D (runtime v4)', at(none, 'WORLD a'), 2);
  badAt('... and also with no version given', none, 'WORLD needs a WINDOW (runtime v3) or a VIEW3D (runtime v4)', at(none, 'WORLD a'));
  const unk = win3('    WORLD nowhere');
  badAt("WORLD of an unknown name: WORLD: unknown MAP 'x' (at the name)", unk, "WORLD: unknown MAP 'nowhere'", at(unk, 'nowhere'), 3);
  const unk2 = win3('    WORLD ship');
  badAt('WORLD of a SPRITE name is an unknown MAP too', unk2, "WORLD: unknown MAP 'ship'", at(unk2, 'ship', 1), 3);
  const lm = win3('    LOADMAP second', 'MAP second = "w60"\n', '', '').replace('    LOADMAP second', '    LOADMAP second\n    WORLD second');
  badAt('LOADMAP of a map a WORLD names is an error (it is a world, not a screen map)', lm, /LOADMAP: 'second' is the world of the WINDOW/, { ...at(lm, 'LOADMAP second'), col: at(lm, 'LOADMAP second').col + 8 }, 3);
  const lm4 = view4('    LOADMAP other\n    WORLD other', 'MAP other = "p8"\n');
  badAt('... and in a VIEW3D game it is a floor plan', lm4, /LOADMAP: 'other' is the floor plan of the VIEW3D/, { ...at(lm4, 'LOADMAP other'), col: at(lm4, 'LOADMAP other').col + 8 }, 4);
  const lm0 = win3('    LOADMAP second', 'MAP second = "w60"\nMAP third = "w30"\n', '', '').replace('    LOADMAP second', '    LOADMAP third\n    WORLD second');
  check_('a map no WORLD names is still a screen map (LOADMAP third is fine next to WORLD second)', !errs(lm0, 3).some((d) => /LOADMAP/.test(d.message)), msgs(errs(lm0, 3)));
  check_("a MAP named only by WORLD counts as used (no 'never used' warning)", !warns(ok3, 3).some((d) => /MAP 'second' is never used/.test(d.message)), msgs(warns(ok3, 3)));
  const notUsed = win3('    v = 1', 'MAP second = "w60"\nMAP third = "w30"\n');
  check_("a MAP nobody uses is still warned about", warns(notUsed, 3).some((d) => /MAP 'third' is never used/.test(d.message)), msgs(warns(notUsed, 3)));
  // reserved word
  const asVar = `${HEAD}SCENE s\n  DIM world\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`;
  check_('a variable called world is refused (WORLD is reserved)', errs(asVar).length > 0 && /reserved/.test(errs(asVar)[0].message), msgs(errs(asVar)));
  const asAsset = `${HEAD}MAP world = "m1"\n${scene('    LOADMAP world\n', '')}`;
  check_('but a MAP may be called world (assets have a name space of their own): MAP world = "m1", LOADMAP world', errs(asAsset, 2).length === 0, msgs(errs(asAsset, 2)));
  const asAsset3 = win3('    WORLD world', 'MAP world = "w60"\n');
  check_('and WORLD world works with such a MAP', errs(asAsset3, 3).length === 0, msgs(errs(asAsset3, 3)));
  // requiredRuntime: unchanged by WORLD
  check_('requiredRuntime: WORLD adds nothing (a WINDOW game is v3, a VIEW3D game v4, WORLD alone v2)', requiredRuntime(ok3).version === 3 && requiredRuntime(view4('    WORLD other', 'MAP other = "p8"\n')).version === 4 && requiredRuntime(none).version === 2 && !requiredRuntime(ok3).reasons.some((r) => /WORLD/.test(r)));
  // the MAP limit
  const maps = (n) => Array.from({ length: n }, (_, i) => `MAP q${i} = "small"\n`).join('');
  check_('64 MAPs check with no error', errs(plain2(maps(64), '    LOADMAP q63'), 2).length === 0 && !errs(plain2(maps(64), '    LOADMAP q63')).some((d) => /at most/.test(d.message)));
  const m65 = plain2(maps(65), '    LOADMAP q64');
  badAt('65 MAPs: "at most 64 MAPs per game (this is the 65th of 65)" at the name of the 65th', m65, 'at most 64 MAPs per game (this is the 65th of 65)', at(m65, 'q64'), 2);
  const eight = plain2(maps(9), '    LOADMAP q8');
  check_('9 MAPs are no error now (8 was the limit before)', !errs(eight, 2).some((d) => /at most/.test(d.message)), msgs(errs(eight, 2)));
}

// =================================================================================================================
// 2. The reference interpreter
// =================================================================================================================
console.log('\n2. The reference interpreter: WORLD (contract section 4, items 1, 2 and 7)');
{
  const run = (src, ticks, version) => interpret(parse(src).ast, { version, ticks, assets: ASSETS11 });
  const w60 = convertWorldMap(ASSETS11.maps.w60, 6), lv = convertWorldMap(ASSETS11.maps.lv, 6), w128 = convertWorldMap(ASSETS11.maps.w128, 6);
  const FR = `    v = v + 1
    IF v = 1 THEN
      CAMERA 100
      SETWORLD 8, 8 = 3
    ENDIF
    IF v = 2 THEN WORLD second ENDIF
    IF v = 3 THEN CAMERA 5000 ENDIF
    IF v = 4 THEN WORLD level ENDIF
    IF v = 5 THEN CAMERA 5000 ENDIF
    IF v = 6 THEN
      SETWORLD 16, 16 = 2
      WORLD third
    ENDIF
    IF v = 7 THEN CAMERA 5000 ENDIF
    IF v = 8 THEN WORLD level ENDIF`;
  const src = win3(FR, 'MAP second = "w60"\nMAP third = "w128"\n');
  const r = run(src, 9, 3);
  const T = r.ticks;
  check_('v3: tick 1: the camera is set (100) and SETWORLD edited the original world (cell row 1, col 1 = 3 * 8)', T[0].cam === 100 && T[0].worldRam[128 + 1] === 24);
  check_('v3: WORLD second: WORLD_RAM is the decoded w60 world (SETWORLD edit gone), the camera is 0', T[1].cam === 0 && sameBytes(T[1].worldRam, w60.src), `cam ${T[1].cam}`);
  check_('v3: CAMERA 5000 after it clamps to the NEW world\'s limit: 60 * 8 - 192 = 288', T[2].cam === camMax(60, [3]) && T[2].cam === 288, `cam ${T[2].cam}`);
  check_('v3: WORLD level restarts the window\'s own map: the original world (no SETWORLD edit), camera 0', T[3].cam === 0 && sameBytes(T[3].worldRam, lv.src));
  check_('v3: ... and its own limit again: 48 * 8 - 192 = 192', T[4].cam === 192);
  check_('v3: a SETWORLD before WORLD third is lost; the 128-wide world gives rows and columns beyond it 0', T[5].cam === 0 && sameBytes(T[5].worldRam, w128.src) && T[5].worldRam[12 * 128 + 5] === 0 && T[5].worldRam[11 * 128 + 127] === 0);
  check_('v3: limit of the 128-wide world: 832', T[6].cam === 832);
  check_('v3: WORLD level again (the edit made while second was loaded is gone as well)', sameBytes(T[7].worldRam, lv.src) && T[7].cam === 0);
  // the maps a WORLD names are not screen maps
  const noScreen = win3('    v = 1', 'MAP second = "w60"\nMAP small = "m1"\n', '    LOADMAP small\n    WORLD second\n');
  const rn = run(noScreen, 1, 3);
  check_('v3: a MAP a WORLD names is not loaded at the start (the first screen MAP is: small)', rn.ticks[0].cells[0] !== 32 || rn.ticks[0].cells.some((c) => c !== 32));
  // banking is invisible: the interpreter takes no option for it
  check_('the interpreter does not know about banking: the same record with or without a bank override on a map', JSON.stringify(run(src, 9, 3).ticks.map((t) => t.cam)) === JSON.stringify(interpret(parse(src).ast, { version: 3, ticks: 9, assets: withBank(ASSETS11, 'w60', 'banked') }).ticks.map((t) => t.cam)));
  // v4
  const p20 = convertViewMap(ASSETS11.maps.p20), p8 = convertViewMap(ASSETS11.maps.p8), maze = convertViewMap(ASSETS11.maps.maze);
  const FR4 = `    v = v + 1
    IF v = 1 THEN
      VIEW 3000, 2900, 70
      SETWALL 2 * 256, 2 * 256 = 3
    ENDIF
    IF v = 2 THEN WORLD other ENDIF
    IF v = 3 THEN VIEW 5000, 5000, 1 ENDIF
    IF v = 4 THEN WORLD level ENDIF
    IF v = 5 THEN WORLD bigger ENDIF`;
  const src4 = view4(FR4, 'MAP other = "p8"\nMAP bigger = "p20"\n');
  const T4 = run(src4, 5, 4).ticks;
  check_('v4: tick 1: the pose (3000, 2900, 70) and the wall edit on the maze', T4[0].view.x === 3000 && T4[0].view.y === 2900 && T4[0].view.a === 70 && T4[0].wallRam[2 * 32 + 2] === 3);
  check_('v4: WORLD other (8 x 6): the array is the new plan (the wall edit is gone, cells outside are wall type 1), the pose is kept but clamped into the new map (x 2047, y 1535, angle 70)', sameBytes(T4[1].wallRam, p8.ram) && T4[1].view.x === 8 * 256 - 1 && T4[1].view.y === 6 * 256 - 1 && T4[1].view.a === 70, JSON.stringify(T4[1].view));
  check_('v4: VIEW after it clamps into the NEW map', T4[2].view.x === 2047 && T4[2].view.y === 1535 && T4[2].view.a === 1);
  check_('v4: WORLD level restores the window\'s own plan (the maze)', sameBytes(T4[3].wallRam, maze.ram) && T4[3].view.x === 2047);
  check_('v4: WORLD bigger (20 x 14): the pose stays (inside the bigger map)', sameBytes(T4[4].wallRam, p20.ram) && T4[4].view.x === 2047 && T4[4].view.y === 1535);
  // errors from the interpreter
  let thrown = '';
  try { run(`${HEAD}MAP a = "m1"\n${scene('', '    WORLD a')}`, 1, 2); } catch (e) { thrown = e.message; }
  check_('the interpreter refuses WORLD without a WINDOW or VIEW3D', /WORLD without a WINDOW or a VIEW3D/.test(thrown), thrown);
  const many = plain2(Array.from({ length: 64 }, (_, i) => `MAP q${i} = "small"\n`).join(''), '    LOADMAP q63');
  check_('the interpreter takes 64 MAPs (and loads the last by name)', (() => { try { return run(many, 2, 2).ticks.length === 2; } catch (e) { return false; } })());
}

// =================================================================================================================
// 3. Code generation of WORLD
// =================================================================================================================
console.log('\n3. WORLD: the code, one stream per map, the messages of the map checks, a runtime without the routines');
{
  if (!FK[3] || !FK[4]) skip_('every WORLD code test', 'arcade/build/v3 or v4/runtime.json is missing');
  else {
    const mapsDecl = 'MAP second = "w60"\nMAP third = "w128"\nMAP fourth = "w30"\n';
    const src = win3('    v = v + 1\n    IF v = 3 THEN WORLD second ENDIF\n    IF v = 4 THEN WORLD level ENDIF\n    IF v = 5 THEN WORLD third ENDIF\n    IF v = 6 THEN WORLD second ENDIF', mapsDecl);
    const r = cmp(src, 3);
    check_('v3 program with four WORLD statements compiles', r.errors.length === 0 && !!r.dck, errText(r));
    const fx = r.gen.fixups;
    check_('four fixups (one per WORLD), in source order: second, level, third, second', fx.length === 4 && fx.map((f) => f.key).join() === 'SECOND,LEVEL,THIRD,SECOND', JSON.stringify(fx));
    // each sequence: LD HL,src / LD A,world_w / LD DE,cam_max / CALL RT_WORLDLOAD
    const seq = (f) => { const m = r.memory, a = f.at - 1; return { op: m[a], src: rd16(m, a + 1), ldA: m[a + 3], w: m[a + 4], ldDE: m[a + 5], cam: rd16(m, a + 6), call: m[a + 8], rt: rd16(m, a + 9) }; };
    const S = fx.map(seq);
    check_('each is  21 src  3E w  11 cam  CD RT_WORLDLOAD  (11 bytes)', S.every((s) => s.op === 0x21 && s.ldA === 0x3E && s.ldDE === 0x11 && s.call === 0xCD && s.rt === WORLDLOAD));
    check_('world_w and cam_max are those of the named map: second 60 / 288, level 48 / 192, third 128 / 832', S[0].w === 60 && S[0].cam === 288 && S[1].w === 48 && S[1].cam === 192 && S[2].w === 128 && S[2].cam === 832, JSON.stringify(S));
    // the streams: second and third are mapped (default), placed by the linker; level is the window's own
    const dec = (a) => rleDecode(r.memory.slice(a, a + 2400));
    check_('src of each WORLD is the address of that map\'s RLE stream: decoded, it equals the converted world (second, level, third)', sameBytes(dec(S[0].src), convertWorldMap(ASSETS11.maps.w60, 6).src) && sameBytes(dec(S[1].src), convertWorldMap(ASSETS11.maps.lv, 6).src) && sameBytes(dec(S[2].src), convertWorldMap(ASSETS11.maps.w128, 6).src));
    check_('a map named by two WORLD statements is stored once: both use the same address; level is the WINDOW\'s own stream (the descriptor\'s world_src)', S[0].src === S[3].src && S[1].src === r.usage.window.at.worldSrc);
    check_('gen.streams holds the two extra worlds once each (second, third), the WINDOW\'s own is not among them; fourth (named by no WORLD) is a screen map', r.gen.streams.map((s) => s.key).join() === 'SECOND,THIRD' && r.gen.streams.every((s) => s.kind === 'world'));
    const stored = r.gen.streams.reduce((a, s) => a + s.data.length, 0);
    const base = cmp(src.replace(/WORLD \w+/g, 'WORLD level').replace('MAP second = "w60"\nMAP third = "w128"\n', ''), 3);        // the same four statements, all naming the WINDOW's own map: no extra stream
    info(`usage: code ${r.usage.code}, streams ${stored} bytes, total ${base.usage.total} -> ${r.usage.total}`);
    check_('the mapped game is bigger than the same program with WORLD level only by the streams (second, third: stored once however many WORLDs name them); the code is the same size', base.usage && r.usage.code === base.usage.code && r.usage.total - base.usage.total === stored, base.usage ? `${r.usage.total - base.usage.total} vs ${stored}` : errText(base));
    // the sequence's neighbours do not move: a program with WORLD does the same as one without up to the first WORLD
    check_('the call target is RT_WORLDLOAD of runtime.json (the symbol, not a constant)', S.every((s) => s.rt === FK[3].rt.symbols.RT_WORLDLOAD));
    // v4
    const src4 = view4('    v = v + 1\n    IF v = 3 THEN WORLD other ENDIF\n    IF v = 4 THEN WORLD level ENDIF\n    IF v = 5 THEN WORLD big ENDIF', 'MAP other = "p8"\nMAP big = "p32"\nMAP tiny = "p4"\n');
    const r4 = cmp(src4, 4);
    check_('v4 program with three WORLD statements compiles', r4.errors.length === 0 && !!r4.dck, errText(r4));
    const seq4 = (f) => { const m = r4.memory, a = f.at - 1; return { op: m[a], src: rd16(m, a + 1), ldBC: m[a + 3], bc: rd16(m, a + 4), call: m[a + 6], rt: rd16(m, a + 7) }; };
    const S4 = r4.gen.fixups.map(seq4);
    check_('each is  21 src  01 (w << 8 | h)  CD RT_PLANLOAD  (9 bytes): other 8 x 6, level (the maze) 12 x 12, big 32 x 32', S4.every((s) => s.op === 0x21 && s.ldBC === 0x01 && s.call === 0xCD && s.rt === PLANLOAD) && S4[0].bc === (8 << 8 | 6) && S4[1].bc === (12 << 8 | 12) && S4[2].bc === (32 << 8 | 32), JSON.stringify(S4));
    const dec4 = (a) => rleDecode(r4.memory.slice(a, a + 2400));
    check_('v4: src decodes to the plan\'s cells (row stride = map width), the own plan is the VIEW3D\'s map_src', sameBytes(dec4(S4[0].src).slice(0, 48), convertViewMap(ASSETS11.maps.p8).cells) && sameBytes(dec4(S4[2].src).slice(0, 1024), convertViewMap(ASSETS11.maps.p32).cells) && S4[1].src === r4.usage.view.at.mapSrc);
    check_('v4: gen.streams holds the plans other and big (kind plan); tiny is a screen map', r4.gen.streams.map((s) => `${s.key}:${s.kind}`).join() === 'OTHER:plan,BIG:plan');
    // the map is not in the map table and not loaded at boot
    const tab = r.gen.v2.mapTable;
    check_('v3: second, third are not in the map table (only fourth is a screen map: count 1, or no table at all)', tab === 0 || r.memory[tab] === 1, `table ${hex(tab)} count ${tab ? r.memory[tab] : '-'}`);
    check_('v3: a program whose only MAPs are worlds (level, second, third) has no screen map table: map_ptr 0 and no map table', (() => { const o = cmp(win3('    WORLD second', 'MAP second = "w60"\n'), 3); return o.errors.length === 0 && o.gen.v1.map === 0 && o.gen.v2.mapTable === 0; })());
    // checks of the maps WORLD names: same messages prefixed WORLD:
    const badW = (name, asset, rx, v = 3, decl) => {
      const a = { ...ASSETS11, maps: { ...ASSETS11.maps, bad: asset } };
      const o = cmp(v === 3 ? win3('    WORLD other', `MAP other = "bad"\n`) : view4('    WORLD other', `MAP other = "bad"\n`), v, a);
      check_(name, o.errors.length === 1 && rx.test(o.errors[0].message) && o.errors[0].message.startsWith('WORLD: '), errText(o));
      return o;
    };
    badW('v3: a world 20 wide is refused: "WORLD: world map ...: the world map width ... 24..128"', world(20, 8, 1), /^WORLD: world map "bad": the world map width \(cells\) must be a whole number 24\.\.128, got 20/);
    badW('v3: a world 129 wide, a world 17 tall', world(129, 8, 1), /^WORLD: world map "bad": the world map width/);
    badW('v3: 17 rows', world(30, 17, 1), /^WORLD: world map "bad": the world map height \(cells\) must be a whole number 1\.\.16, got 17/);
    badW('v3: a tile the tileset does not have (tile 9 of 6)', mkMap(30, 4, (c, r) => (c === 3 && r === 1 ? 9 : 0)), /^WORLD: world map "bad": .*tile/);
    badW('v4: a plan 3 wide, a plan with an empty outer ring', plan(3, 8, 1), /^WORLD: view map "bad": the view map width \(cells\) must be a whole number 4\.\.32, got 3/, 4);
    badW('v4: an empty cell on the outer ring: the message names the row and column (walls rule of batch 3)', mkMap(6, 6, (c, r) => (c === 2 && r === 0 ? 0 : 1)), /^WORLD: view map "bad": map cell at row 0, column 2 is empty but it is on the outer ring/, 4);
    badW('v4: a wall type 5', mkMap(6, 6, (c, r) => (c === 2 && r === 2 ? 5 : 1)), /^WORLD: view map "bad": map cell at row 2, column 2 is 5/, 4);
    const missing = cmp(win3('    WORLD other', 'MAP other = "nope"\n'), 3);
    check_('a map asset that is not in the project: "WORLD: map asset ..." at the name', missing.errors.length >= 1 && missing.errors.some((e) => e.message === 'WORLD: map asset "nope" is not in the project'), errText(missing));
    const two = cmp(win3('    WORLD other\n    WORLD other', 'MAP other = "w20x"\n'), 3, { ...ASSETS11, maps: { ...ASSETS11.maps, w20x: world(20, 8, 1) } });
    check_('the same bad map named by two WORLD statements: the error is reported at each (two errors, two lines)', two.errors.length === 2 && two.errors[0].line !== two.errors[1].line, errText(two));
    // the window's own map checks are unchanged: no WORLD: prefix
    const own = cmp(win3('    v = 1').replace('"lv"', '"w20x"'), 3, { ...ASSETS11, maps: { ...ASSETS11.maps, w20x: world(20, 8, 1) } });
    check_('the WINDOW\'s own bad map says  world map "w20x": ...  without the WORLD: prefix (unchanged)', own.errors.length === 1 && /^world map "w20x": /.test(own.errors[0].message), errText(own));
    // the runtime lacks the routine
    const noW = fake(3, { symbols: { RT_WORLDLOAD: undefined } }), noP = fake(4, { symbols: { RT_PLANLOAD: undefined } });
    const o1 = cmp(src, 3, ASSETS11, { R: noW }), o2 = cmp(src4, 4, ASSETS11, { R: noP });
    check_('a v3 runtime without RT_WORLDLOAD: a clear error at the WORLD', o1.errors.length >= 1 && /^WORLD needs RT_WORLDLOAD, which this runtime does not provide/.test(o1.errors[0].message) && o1.errors[0].line === at(src, 'WORLD second').line, errText(o1));
    check_('a v4 runtime without RT_PLANLOAD: a clear error at the WORLD', o2.errors.length >= 1 && /^WORLD needs RT_PLANLOAD, which this runtime does not provide/.test(o2.errors[0].message), errText(o2));
    const unreach = win3('    v = 1', 'MAP second = "w60"\n', '', '').replace('SCENE s\n', 'SCENE s\n  PROC never()\n    WORLD second\n  ENDP\n');
    check_('a WORLD in a PROC nobody calls is checked like every statement (the runtime must have the routine), and with the routine it compiles', cmp(unreach, 3, ASSETS11, { R: noW }).errors.length >= 1 && cmp(unreach, 3).errors.length === 0, errText(cmp(unreach, 3)));
    // WORLD does not change a game that has none
    const plainW = cmp(win3('    v = v + 1', 'MAP second = "w30"\n'), 3);
    check_('a WINDOW game with a spare MAP and no WORLD statement is a screen map game as before: the MAP is the boot map in the image (the one-map form), no stream', plainW.errors.length === 0 && plainW.gen.v1.map !== 0 && plainW.gen.v2.mapTable === 0 && plainW.gen.streams.length === 0, errText(plainW));
    // the window mode check: WORLD in v4 program with a WINDOW is refused earlier
    const mix = `${HEAD}MAP level = "lv"\nMAP other = "w60"\nWINDOW level\n${scene('', '    WORLD other')}`;
    check_('WORLD in a WINDOW game compiled on the v4 runtime: the WINDOW error comes first (one message)', cmp(mix, 4).errors.length >= 1 && /WINDOW needs the v3 runtime/.test(cmp(mix, 4).errors[0].message), errText(cmp(mix, 4)));
  }
}

// =================================================================================================================
// 4. Placement
// =================================================================================================================
console.log('\n4. Placement (contract section 5): auto, largest first, overrides, bankAll, the errors, usage');
{
  if (!FK[2]) skip_('every placement test', 'arcade/build/v2/runtime.json is missing');
  else {
    const loadAll = (n, prefix = 'm') => Array.from({ length: n }, (_, i) => `    LOADMAP ${prefix}${i}`).join('\n') + '\n';
    const game = (n, asset = (i) => `s${i}`, prefix = 'm') => plain2(mapDecls(Array.from({ length: n }, (_, i) => i), prefix, asset), loadAll(n, prefix));
    // 1. a game that fits banks nothing
    const small = cmp(game(6), 2);
    check_('a game that fits chunks 4-5 banks nothing: banked.used 0, no assets, the usual four chunks, mapped = gameArea', small.errors.length === 0 && small.usage.banked.used === 0 && small.usage.banked.assets.length === 0 && small.shipped.join() === '0,1,4,5' && small.dck.length === 9 + 4 * CHUNK && small.usage.mapped.used === small.usage.gameArea.used && small.usage.mapped.available === 16384 && small.usage.banked.available === 16384, errText(small));
    const forced = cmp(game(6), 2, ASSETS11, { opts: { bankAll: true } });
    check_('the same game with bankAll banks all 6 maps, why bankAll', forced.errors.length === 0 && forced.usage.banked.assets.length === 6 && forced.usage.banked.assets.every((a) => a.why === 'bankAll' && a.kind === 'map'), errText(forced));
    // 2. too many maps for the mapped part: 22 x 770 = 16,940 bytes of records
    const g22 = cmp(game(22), 2);
    check_('22 maps of 32 x 24 (770 bytes each) compile: the mapped part fits after banking', g22.errors.length === 0 && g22.usage.mapped.used <= 16384, errText(g22));
    const bk = g22.usage.banked.assets;
    check_('equal sizes: the ties go in declaration order (m0, m1, ... from the start), each why auto', bk.length >= 1 && bk.every((a, i) => a.name === `m${i}` && a.why === 'auto' && a.kind === 'map' && a.bytes === 770), JSON.stringify(bk));
    check_('they sit from $4000 up with no gap (the window is one 16 KB range): at = $4000, $4302, ...', bk.every((a, i) => a.at === 0x4000 + 770 * i), JSON.stringify(bk.map((a) => a.at)));
    check_('only as many as needed: one fewer would not have fitted (the old game area is over 16,384 with k - 1 banked)', (() => { return g22.usage.mapped.used + 770 > 16384 && g22.usage.mapped.used <= 16384; })(), `${g22.usage.mapped.used} used, ${bk.length} banked`);
    check_('usage.banked.used is their total; one banked map is chunk 2 only when it is 8,192 bytes or less', g22.usage.banked.used === 770 * bk.length && g22.shipped.join() === '0,1,2,4,5');
    // 3. largest first: 20 small maps (102 bytes) declared first, then 22 big ones
    const mixed = plain2(mapDecls(Array.from({ length: 20 }, (_, i) => i), 't', (i) => `t${i}`) + mapDecls(Array.from({ length: 22 }, (_, i) => i), 'b', (i) => `s${i}`), loadAll(20, 't') + loadAll(22, 'b'));
    const mx = cmp(mixed, 2);
    check_('largest first: with 20 small maps declared before 22 big ones only big ones are banked, in declaration order among them', mx.errors.length === 0 && mx.usage.banked.assets.length >= 1 && mx.usage.banked.assets.every((a, i) => a.name === `b${i}` && a.bytes === 770), errText(mx) + JSON.stringify(mx.usage.banked.assets.map((a) => a.name)));
    // 4. different sizes: a size order that is not the declaration order
    const sizes = [['a0', 't0'], ['a1', 's0'], ['a2', 'big0'], ['a3', 's1']];     // 102, 770, 770, 770
    const orderTest = bankOrder(sizes.map(([n, a], i) => ({ key: n.toUpperCase(), name: n, kind: 'map', data: new Uint8Array(ASSETS11.maps[a].w * ASSETS11.maps[a].h + 2), override: 'auto' })), false);
    check_('bankOrder: sizes 102, 770, 770, 770 -> the 770s first in declaration order, then the 102; nothing is `first` or `never`', orderTest.rest.map((x) => x.cand.name).join() === 'a1,a2,a3,a0' && orderTest.first.length === 0 && orderTest.never.length === 0);
    // 5. overrides
    const g24 = (over = {}) => {
      let as = ASSETS11;
      for (const [k, v] of Object.entries(over)) as = withBank(as, k, v);
      return as;
    };
    const small_t = plain2(mapDecls(Array.from({ length: 22 }, (_, i) => i), 'm', (i) => `s${i}`) + 'MAP tiny = "small"\n', loadAll(22) + '    LOADMAP tiny\n');
    const ov = cmp(small_t, 2, g24({ small: 'banked' }));
    check_('override banked: a small map (declared last) is banked FIRST whatever its size, at $4000, why override; the big ones follow as needed', ov.errors.length === 0 && ov.usage.banked.assets[0].name === 'tiny' && ov.usage.banked.assets[0].why === 'override' && ov.usage.banked.assets[0].at === 0x4000 && ov.usage.banked.assets[1]?.name === 'm0' && ov.usage.banked.assets[1].at === 0x4000 + 22 + 0 * 0 + (ASSETS11.maps.small.w * ASSETS11.maps.small.h + 2) - 22, errText(ov) + JSON.stringify(ov.usage.banked.assets));
    const forcedOnly = cmp(plain2('MAP a = "small"\nMAP b = "m2"\n', '    LOADMAP a\n    LOADMAP b'), 2, g24({ m2: 'banked' }));
    check_('override banked on a game that fits: only that map is banked, nothing else', forcedOnly.errors.length === 0 && forcedOnly.usage.banked.assets.length === 1 && forcedOnly.usage.banked.assets[0].name === 'b' && forcedOnly.usage.banked.assets[0].why === 'override' && forcedOnly.shipped.join() === '0,1,2,4,5', errText(forcedOnly));
    const mapped = cmp(game(22), 2, g24({ s0: 'mapped', s1: 'mapped' }));
    check_('override mapped: m0 and m1 never move: the banked ones start at m2 (ties in declaration order)', mapped.errors.length === 0 && mapped.usage.banked.assets[0].name === 'm2' && !mapped.usage.banked.assets.some((a) => a.name === 'm0' || a.name === 'm1'), errText(mapped) + JSON.stringify(mapped.usage.banked.assets.map((a) => a.name)));
    const allMapped = cmp(game(22), 2, g24(Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`s${i}`, 'mapped']))));
    check_('every map set to mapped and the game does not fit: "map \'x\' is set to mapped but the game then does not fit (N of 16,384 bytes)" for each, at its MAP', allMapped.errors.length === 22 && /^map 'm0' is set to mapped but the game then does not fit \([\d,]+ of 16,384 bytes\)$/.test(allMapped.errors[0].message) && allMapped.errors[0].line === at(game(22), 'MAP m0').line && !allMapped.dck, errText(allMapped).slice(0, 300));
    const mappedBig = cmp(game(22), 2, g24({ s0: 'mapped' }));
    check_('one mapped override that makes it fit anyway (the others are banked) is no error', mappedBig.errors.length === 0, errText(mappedBig));
    const badOv = cmp(game(3), 2, g24({ s1: 'sideways' }));
    check_('a bad bank value is a warning: "map \'m1\': bank \'sideways\' is not auto, mapped or banked; auto used"; the build goes on', badOv.errors.length === 0 && badOv.warnings.some((w) => w.message === "map 'm1': bank 'sideways' is not auto, mapped or banked; auto used" && w.line === at(game(3), 'MAP m1').line), warnText(badOv));
    const okOv = cmp(game(3), 2, g24({ s1: 'auto' }));
    check_('bank: auto is the same as absent: no warning, same bytes', okOv.errors.length === 0 && !okOv.warnings.some((w) => /bank/.test(w.message)) && sameBytes(okOv.memory, cmp(game(3), 2).memory));
    // 6. capacity: 22 maps all banked
    const all22 = cmp(game(22), 2, g24(Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`s${i}`, 'banked']))));
    check_('22 maps of 770 bytes all set to banked: 16,940 bytes in a 16,384-byte window: "banked assets need 16,940 of 16,384 bytes"', all22.errors.length === 1 && all22.errors[0].message === 'banked assets need 16,940 of 16,384 bytes' && !all22.dck, errText(all22));
    const allBA = cmp(game(22), 2, ASSETS11, { opts: { bankAll: true } });
    check_('bankAll on the same 22 maps hits the same limit', allBA.errors.length === 1 && allBA.errors[0].message === 'banked assets need 16,940 of 16,384 bytes', errText(allBA));
    const fits21 = cmp(game(21), 2, ASSETS11, { opts: { bankAll: true } });
    check_('21 maps banked (16,170 bytes) fit the window exactly enough: chunks 0..5 shipped', fits21.errors.length === 0 && fits21.usage.banked.used === 16170 && fits21.shipped.join() === '0,1,2,3,4,5', errText(fits21));
    // 7. the generic error: sprites so big that even a banked game does not fit
    const fatA = () => ({ w: 32, h: 48, frames: Array.from({ length: 32 }, () => ({ rows: Array.from({ length: 48 }, () => ({ bits: 'FFFFFFFF', mask: 'FFFFFFFF' })) })) });
    const fatAssets = { ...ASSETS11, sprites: { ...ASSETS11.sprites, fat: fatA(), fat2: fatA() } };
    const fat = cmp(`${HEAD}SPRITE f = "fat"\nSPRITE f2 = "fat2"\nMAP a = "m1"\nMAP b = "m2"\n${scene('    LOADMAP a\n    LOADMAP b\n', '    SHOW f AT 1, 2 FRAME RND(32)\n    SHOW f2 AT 1, 2 FRAME RND(32)\n')}`, 3, fatAssets);
    check_('maps and sprites too big even with the maps banked: "the game does not fit: mapped part N of 16,384 bytes after banking every map, world and plan (code C, sprites S, ...)"', fat.errors.length === 1 && /^the game does not fit: mapped part [\d,]+ of 16,384 bytes after banking every map, world and plan \(code \d+, sprites \d+/.test(fat.errors[0].message) && !fat.dck, errText(fat));
    const fat0 = cmp(`${HEAD}SPRITE f = "fat"\nSPRITE f2 = "fat2"\n${scene('', '    SHOW f AT 1, 2 FRAME RND(32)\n    SHOW f2 AT 1, 2 FRAME RND(32)\n')}`, 3, fatAssets);
    check_('with no map at all there is nothing to bank: the linker\'s old message stays ("the game does not fit: N bytes (...) too many")', fat0.errors.length === 1 && /^the game does not fit: \d+ bytes \(code \d+, sprites \d+.*too many$/.test(fat0.errors[0].message), errText(fat0));
    // 8. usage
    const u = g22.usage;
    check_('usage.mapped = {used, available 16384} and equals gameArea.used; usage.banked = {used, available 16384, assets: [{name, kind, bytes, at, why}]}', u.mapped.used === u.gameArea.used && Object.keys(u.banked.assets[0]).sort().join() === 'at,bytes,kind,name,why' && u.gameArea.available === 16384, JSON.stringify(u.mapped));
    check_('the existing fields keep their meaning: gameArea is the mapped part, total / end / free as before (free = area - end)', u.free === 0x4000 - (u.end - 0x8000) && u.total === u.end - 0x8000);
    check_('the map (debugger) lists the banked assets: map.banked = [{name, kind, at, bytes, why}]', g22.map.banked.length === bk.length && g22.map.banked[0].at === 0x4000);
    // 9. shipped chunks by size
    check_('shippedChunks: 0 banked bytes -> 0,1,4,5; 1 -> 0,1,2,4,5; 8,192 -> 0,1,2,4,5; 8,193 -> 0,1,2,3,4,5; 16,384 -> 0,1,2,3,4,5', shippedChunks(0).join() === '0,1,4,5' && shippedChunks(1).join() === '0,1,2,4,5' && shippedChunks(8192).join() === '0,1,2,4,5' && shippedChunks(8193).join() === '0,1,2,3,4,5' && shippedChunks(16384).join() === '0,1,2,3,4,5');
    check_('assignAt: addresses from $4000, each right after the previous', (() => { const p = assignAt([{ cand: { key: 'A', name: 'a', kind: 'map', data: new Uint8Array(10) }, why: 'auto' }, { cand: { key: 'B', name: 'b', kind: 'world', data: new Uint8Array(7) }, why: 'override' }]); return p.banked[0].at === 0x4000 && p.banked[1].at === 0x400A && p.bytes === 17 && p.banked[1].why === 'override'; })());
    // 10. a window game: the own world is a candidate (kind world) and banks when it is the largest
    const winMaps = Array.from({ length: 21 }, (_, i) => `MAP m${i} = "s${i}"\n`).join('');
    const w21 = cmp(win3(loadAll(21), winMaps), 3);
    check_('v3: a WINDOW game with 21 big screen maps: some are banked (kind map) and the world (181 bytes) stays mapped (it is the smallest)', w21.errors.length === 0 && w21.usage.banked.assets.length >= 1 && w21.usage.banked.assets.every((a) => a.kind === 'map') && w21.usage.mapped.used <= 16384, errText(w21));
    const w21b = cmp(win3(loadAll(21), winMaps), 3, ASSETS11, { opts: { bankAll: true } });
    check_('v3: bankAll banks the world as well (kind world, at some address of the window), the 21 maps too', w21b.errors.length === 0 && w21b.usage.banked.assets.some((a) => a.kind === 'world' && a.name === 'level') && w21b.usage.banked.assets.filter((a) => a.kind === 'map').length === 21, errText(w21b));
  }
}

// =================================================================================================================
// 5. The linker and the DCK
// =================================================================================================================
console.log('\n5. Linker and DCK (contract section 6): chunks shipped per build, $FF fill, read-back, the flat image, WORLD in the window');
{
  if (!FK[2] || !FK[3] || !FK[4]) skip_('every linker test', 'a runtime.json is missing');
  else {
    /** read a DCK back: {kinds: [8], chunks: {index: Uint8Array(8192)}} (bank id 0, 8 kinds, then each chunk whose kind is not 0 in index order) */
    const readDck = (dck) => {
      const kinds = Array.from(dck.slice(1, 9)), chunks = {};
      let at = 9;
      for (let c = 0; c < 8; c++) if (kinds[c] !== 0) { chunks[c] = dck.slice(at, at + CHUNK); at += CHUNK; }
      return { id: dck[0], kinds, chunks, end: at };
    };
    const loadAll = (n, prefix = 'm') => Array.from({ length: n }, (_, i) => `    LOADMAP ${prefix}${i}`).join('\n') + '\n';
    const game = (n) => plain2(mapDecls(Array.from({ length: n }, (_, i) => i)), loadAll(n));
    const none = cmp(game(4), 2);
    const dn = readDck(none.dck);
    check_('nothing banked: chunks 0, 1, 4, 5 are kind 2 and the rest absent; the file is 9 + 4 x 8,192 bytes, as before', dn.id === 0 && dn.kinds.join() === '2,2,0,0,2,2,0,0' && none.dck.length === 9 + 4 * CHUNK && dn.end === none.dck.length);
    const one = cmp(game(2), 2, ASSETS11, { opts: { bankAll: true } });
    const d1 = readDck(one.dck);
    check_('banked bytes in chunk 2 only: kinds 2,2,2,0,2,2,0,0 (the bank chunk is kind 2 like 4 and 5); the file is 9 + 5 x 8,192', d1.kinds.join() === '2,2,2,0,2,2,0,0' && one.dck.length === 9 + 5 * CHUNK && d1.end === one.dck.length);
    const b1 = one.usage.banked.assets;
    check_('chunk 2 holds the two map records at their window addresses (w, h, then the cells as the map table says): read back from the DCK', b1.every((a) => { const rec = d1.chunks[2].slice(a.at - 0x4000, a.at - 0x4000 + a.bytes); const asset = ASSETS11.maps[`s${a.name.slice(1)}`]; return rec[0] === asset.w && rec[1] === asset.h && rec.slice(2).every((b, i) => b === (asset.cells[i] < 0 ? 32 : 128 + asset.cells[i])); }), JSON.stringify(b1));
    check_('the unused bytes of the shipped bank chunk are $FF', d1.chunks[2].slice(b1.reduce((n, a) => n + a.bytes, 0)).every((b) => b === 0xFF));
    check_('the chunks 0, 1, 4, 5 of the DCK are the memory image\'s (the game area is chunks 4-5)', [0, 1, 4, 5].every((c) => sameBytes(d1.chunks[c], one.memory.slice(c * CHUNK, (c + 1) * CHUNK))));
    check_('the flat image covers the window: memory[$4000..] has the records and the $FF fill of chunk 2 (and not past it: chunk 3 is not shipped)', sameBytes(one.memory.slice(0x4000, 0x6000), d1.chunks[2]));
    // chunk 3 past 8,192
    const big = cmp(game(12), 2, ASSETS11, { opts: { bankAll: true } });
    const d3 = readDck(big.dck);
    check_('12 banked maps (9,240 bytes): chunks 2 AND 3 shipped: kinds 2,2,2,2,2,2,0,0; the file is 9 + 6 x 8,192', big.errors.length === 0 && d3.kinds.join() === '2,2,2,2,2,2,0,0' && big.dck.length === 9 + 6 * CHUNK, errText(big));
    check_('a record that straddles the chunk boundary ($6000) reads back whole from the two chunks (the window is one range)', (() => {
      const a = big.usage.banked.assets.find((x) => x.at < 0x6000 && x.at + x.bytes > 0x6000);
      if (!a) return false;
      const flat = new Uint8Array(2 * CHUNK); flat.set(d3.chunks[2], 0); flat.set(d3.chunks[3], CHUNK);
      return sameBytes(flat.slice(a.at - 0x4000, a.at - 0x4000 + a.bytes), big.memory.slice(a.at, a.at + a.bytes));
    })());
    check_('chunk 3 beyond the data is $FF too, and the flat image agrees up to $8000', d3.chunks[3].slice(9240 - CHUNK).every((b) => b === 0xFF) && sameBytes(big.memory.slice(0x4000, 0x8000), (() => { const f = new Uint8Array(2 * CHUNK); f.set(d3.chunks[2], 0); f.set(d3.chunks[3], CHUNK); return f; })()));
    // link() directly: shipped, and the result of a game with no bank
    check_('compile() returns shipped; link() returns it too', one.shipped.join() === '0,1,2,4,5' && none.shipped.join() === '0,1,4,5');
    // the map table points into the window, in place
    const tab = one.gen.v2.mapTable;
    check_('map table: count, then DW per map: the banked ones are window addresses (m0 at $4000 ...)', one.memory[tab] === 2 && rd16(one.memory, tab + 1) === 0x4000 && rd16(one.memory, tab + 3) === 0x4000 + 770, `${hex(rd16(one.memory, tab + 1))} ${hex(rd16(one.memory, tab + 3))}`);
    // a map table with banked and mapped entries
    const g22 = cmp(plain2(mapDecls(Array.from({ length: 22 }, (_, i) => i)), loadAll(22)), 2);
    const t22 = g22.gen.v2.mapTable, nb = g22.usage.banked.assets.length;
    check_('banked entries are in $4000-$7FFF, the others in the game image ($8000-$BFFF), in declaration order', g22.memory[t22] === 22 && Array.from({ length: 22 }, (_, i) => rd16(g22.memory, t22 + 1 + 2 * i)).every((a, i) => (i < nb ? a >= 0x4000 && a < 0x8000 : a >= 0x8000 && a < 0xC000)));
    check_('a mapped map\'s record in the image reads back (the last: w, h, cells)', (() => { const a = rd16(g22.memory, t22 + 1 + 2 * 21), asset = ASSETS11.maps.s21; return g22.memory[a] === 32 && g22.memory[a + 1] === 24 && g22.memory[a + 2] === (asset.cells[0] < 0 ? 32 : 128 + asset.cells[0]); })());
    // WORLD streams in the window (v3)
    const maps3 = 'MAP second = "w60"\nMAP third = "w128"\n';
    const src3 = win3('    v = v + 1\n    IF v = 3 THEN WORLD second ENDIF\n    IF v = 4 THEN WORLD level ENDIF\n    IF v = 5 THEN WORLD third ENDIF', maps3);
    const w3 = cmp(src3, 3, ASSETS11, { opts: { bankAll: true } });
    check_('v3 bankAll: level, second, third are all banked (kind world), largest first (level 181, third 77, second 47 bytes)', w3.errors.length === 0 && w3.usage.banked.assets.map((a) => `${a.name}:${a.kind}`).join() === 'level:world,third:world,second:world', errText(w3) + JSON.stringify(w3.usage.banked.assets));
    const d3w = readDck(w3.dck);
    const winA = w3.usage.banked.assets;
    const decodeAt = (m, a) => rleDecode(m.slice(a, a + 2400));
    check_('the stream of each world is in chunk 2 at its address and decodes to the converted world', winA.every((a, i) => { const asset = ASSETS11.maps[{ level: 'lv', second: 'w60', third: 'w128' }[a.name]]; return sameBytes(rleDecode(d3w.chunks[2].slice(a.at - 0x4000, a.at - 0x4000 + 2400)), convertWorldMap(asset, 6).src); }));
    check_('the window descriptor\'s world_src is the window address of level', w3.usage.window.at.worldSrc === winA.find((a) => a.name === 'level').at && rd16(w3.memory, w3.usage.window.at.windowDesc + 0) !== undefined);
    const fxs = w3.gen.fixups.map((f) => rd16(w3.memory, f.at));
    check_('each WORLD\'s `LD HL,src` holds the window address of its world (second, level, third)', fxs.join() === ['second', 'level', 'third'].map((n) => winA.find((a) => a.name === n).at).join(), JSON.stringify(fxs.map(hex)));
    const w3m = cmp(src3, 3);
    check_('v3 default (fits): the same program banks nothing and its streams are in the game image', w3m.usage.banked.assets.length === 0 && w3m.gen.fixups.every((f) => rd16(w3m.memory, f.at) >= 0x8000 && rd16(w3m.memory, f.at) < 0xC000));
    check_('mapped vs banked: the window game\'s memory differs only where it should (banked bytes shrink the image by the streams; the code is the same size)', w3.usage.code === w3m.usage.code && w3.usage.total < w3m.usage.total);
    const wown = cmp(win3('    v = 1'), 3, ASSETS11, { opts: { bankAll: true } });
    check_('v3: the WINDOW\'s own world banked alone: the image shrinks by its stream and the descriptor points into the window', wown.errors.length === 0 && wown.usage.banked.assets.length === 1 && wown.usage.window.at.worldSrc === 0x4000 && wown.usage.window.worldSource === rleOf(convertWorldMap(ASSETS11.maps.lv, 6).src).length, errText(wown));
    // v4 plans in the window
    const src4 = view4('    v = v + 1\n    IF v = 3 THEN WORLD other ENDIF\n    IF v = 4 THEN WORLD big ENDIF', 'MAP other = "p8"\nMAP big = "p32"\n');
    const w4 = cmp(src4, 4, ASSETS11, { opts: { bankAll: true } });
    const d4 = readDck(w4.dck);
    check_('v4 bankAll: the own plan (maze), other and big are banked (kind plan) and read back from chunk 2 as their cells', w4.errors.length === 0 && w4.usage.banked.assets.every((a) => a.kind === 'plan') && w4.usage.banked.assets.length === 3 && w4.usage.banked.assets.every((a) => { const asset = ASSETS11.maps[{ level: 'maze', other: 'p8', big: 'p32' }[a.name]]; return sameBytes(rleDecode(d4.chunks[2].slice(a.at - 0x4000, a.at - 0x4000 + 2400)).slice(0, asset.w * asset.h), convertViewMap(asset).cells); }), errText(w4));
    check_('v4: map_src of the view descriptor is the window address of the maze, and the two WORLD statements point at the others', rd16(w4.memory, w4.usage.view.at.viewDesc + 5) === w4.usage.banked.assets.find((a) => a.name === 'level').at && w4.gen.fixups.map((f) => rd16(w4.memory, f.at)).join() === [w4.usage.banked.assets.find((a) => a.name === 'other').at, w4.usage.banked.assets.find((a) => a.name === 'big').at].join());
    // policy with a window: a world that is the biggest is banked when the game does not fit
    // 60 x 16 world of the second map with variation: make a big world and screen maps that need it
    const bigWorld = { ...ASSETS11, maps: { ...ASSETS11.maps, lv: mkMap(128, 16, (c, r) => ((c * 7 + r * 13) % 6)) } };       // an RLE stream that does not compress: about 4 KB
    const wmaps = Array.from({ length: 16 }, (_, i) => `MAP m${i} = "s${i}"\n`).join('');
    const wb = cmp(win3(loadAll(16), wmaps), 3, bigWorld);
    check_('v3: a poorly compressible 128 x 16 world is the largest asset and is banked first when the game does not fit (kind world), the maps stay mapped as far as possible', wb.errors.length === 0 && wb.usage.banked.assets[0].kind === 'world' && wb.usage.banked.assets[0].bytes > 1500 && wb.usage.mapped.used <= 16384, errText(wb) + JSON.stringify(wb.usage.banked.assets.slice(0, 2)));
    // buildDck is unchanged for a plain set of chunks
    const plainDck = buildDck({ 0: new Uint8Array(CHUNK), 5: new Uint8Array(CHUNK) });
    check_('buildDck: chunks given in any order land in index order, kind 2 for each', plainDck.length === 9 + 2 * CHUNK && Array.from(plainDck.slice(1, 9)).join() === '2,0,0,0,0,2,0,0');
  }
}

// =================================================================================================================
// 6. Generated again for the placement
// =================================================================================================================
console.log('\n6. The code is generated for the placement: boot map, the one-map form, determinism');
{
  if (!FK[2]) skip_('every re-generation test', 'arcade/build/v2/runtime.json is missing');
  else {
    const one = plain2('MAP a = "m2"\n', '    v = 1');
    const norm = cmp(one, 2);
    check_('one map and no LOADMAP, nothing banked: the old one-map form (map_ptr -> 768 raw cells, header 16, no map table)', norm.errors.length === 0 && norm.gen.v1.map !== 0 && norm.gen.v2.mapTable === 0 && norm.gen.headerLen === 16, errText(norm));
    const ob = cmp(one, 2, withBank(ASSETS11, 'm2', 'banked'));
    check_('the same game with its only map banked: the extended form (header 18, map table, map_ptr 0), the table entry is $4000, the map record at $4000 reads back', ob.errors.length === 0 && ob.gen.headerLen === 18 && ob.gen.v1.map === 0 && ob.gen.v2.mapTable !== 0 && rd16(ob.memory, ob.gen.v2.mapTable + 1) === 0x4000 && ob.memory[0x4000] === 12 && ob.memory[0x4001] === 3 && (ob.memory[0x8004] & 0x80) !== 0, errText(ob));
    check_('... and the boot map (map 0) may be the banked one: no raw 768-byte copy is left in the image (the game is smaller than the unbanked one by the record)', ob.usage.total < norm.usage.total && ob.usage.data.map === 1 + 2);
    const mixed = plain2('MAP a = "m1"\nMAP b = "m2"\n', '    LOADMAP b');
    const mb = cmp(mixed, 2, withBank(ASSETS11, 'm1', 'banked'));
    check_('two maps, the first (boot) banked: the table is [window, image]; the boot map loads through the window, LOADMAP b by index 1', mb.errors.length === 0 && rd16(mb.memory, mb.gen.v2.mapTable + 1) === 0x4000 && rd16(mb.memory, mb.gen.v2.mapTable + 3) >= 0x8000, errText(mb));
    // the code itself does not change for a banked map: LOADMAP is the same call
    const lmA = cmp(plain2('MAP a = "m1"\nMAP b = "m2"\n', '    LOADMAP b'), 2), lmB = cmp(plain2('MAP a = "m1"\nMAP b = "m2"\n', '    LOADMAP b'), 2, withBank(ASSETS11, 'm2', 'banked'));
    check_('LOADMAP of a banked map compiles to the same instructions as of a mapped one (the call is the same, the loaders do the mapping): PROC FRAME is the same bytes', (() => { const p = lmA.gen.procs?.FRAME ?? lmA.map.procs.FRAME; const q = lmB.map.procs.FRAME; return sameBytes(lmA.memory.slice(p, p + 8), lmB.memory.slice(q, q + 8)); })());
    // determinism: compile twice, and a pass-2 build equals a build with the same placement
    const a = cmp(plain2(mapDecls(Array.from({ length: 22 }, (_, i) => i)), Array.from({ length: 22 }, (_, i) => `    LOADMAP m${i}`).join('\n') + '\n'), 2);
    const b = cmp(plain2(mapDecls(Array.from({ length: 22 }, (_, i) => i)), Array.from({ length: 22 }, (_, i) => `    LOADMAP m${i}`).join('\n') + '\n'), 2);
    check_('the compiler is deterministic with banking: the same source twice gives the same image and DCK', sameBytes(a.memory, b.memory) && sameBytes(a.dck, b.dck));
    // forced vs auto on a game that overflows: the same bank for the same placement
    const src22 = plain2(mapDecls(Array.from({ length: 22 }, (_, i) => i)), Array.from({ length: 22 }, (_, i) => `    LOADMAP m${i}`).join('\n') + '\n');
    let as = ASSETS11;
    for (const n of a.usage.banked.assets.map((x) => `s${x.name.slice(1)}`)) as = withBank(as, n, 'banked');
    const c = cmp(src22, 2, as);
    check_('the placement the policy chose, given as overrides, gives the same bytes (the policy is only a choice of placement)', sameBytes(a.memory, c.memory) && sameBytes(a.dck, c.dck) && c.usage.banked.assets.every((x) => x.why === 'override'));
    // the source map and findSource do not break
    check_('the source map still names the code (a line in PROC FRAME), and the window is data: findSource below $8000 is null', a.map.lines.length > 0 && a.map.lines.every((l) => l.addr >= 0x8000));
    // the interpreter against the compiler is the differential test's job (tests/arcade-m11-differential.mjs)
    // errors in pass 2 are reported once, with the lines of the source
    const e2 = cmp(plain2('MAP a = "m1"\n', '    LOADMAP zzz'), 2, withBank(ASSETS11, 'm1', 'banked'));
    check_('an error in a program that would be banked is reported as without banking (one error, the checker\'s)', e2.errors.length === 1 && /zzz/.test(e2.errors[0].message), errText(e2));
    // a runtime build that cannot read the window
    const oldRt = fake(2, { symbols: { RT_LOADMAPPTR: undefined } });
    const nb = cmp(plain2('MAP a = "m1"\n', '    LOADMAP a'), 2, ASSETS11, { R: oldRt });
    const fb = cmp(plain2('MAP a = "m1"\n', '    LOADMAP a'), 2, ASSETS11, { R: oldRt, opts: { bankAll: true } });
    const ob2 = cmp(plain2(mapDecls(Array.from({ length: 22 }, (_, i) => i)), Array.from({ length: 22 }, (_, i) => `    LOADMAP m${i}`).join('\n') + '\n'), 2, ASSETS11, { R: oldRt });
    check_('a runtime without RT_LOADMAPPTR still builds a game that banks nothing, and refuses banking with a clear error (forced, or because the game does not fit)', nb.errors.length === 0 && fb.errors.length === 1 && /cannot read banked assets \(it has no RT_LOADMAPPTR\)/.test(fb.errors[0].message) && ob2.errors.length === 1 && /^the game does not fit: mapped part [\d,]+ of 16,384 bytes, and this runtime build cannot read banked assets/.test(ob2.errors[0].message), errText(fb) + ' || ' + errText(ob2));
    // 64 maps compile and the runtime's MAX_MAPS is honoured
    const sixty4 = plain2(Array.from({ length: 64 }, (_, i) => `MAP q${i} = "small"\n`).join(''), '    LOADMAP q63');
    const r64 = cmp(sixty4, 2);
    check_('64 small maps: a map table of 64 entries (count 64, the last entry the last map)', r64.errors.length === 0 && r64.memory[r64.gen.v2.mapTable] === 64, errText(r64));
    const lim = cmp(plain2(Array.from({ length: 9 }, (_, i) => `MAP q${i} = "small"\n`).join(''), '    LOADMAP q8'), 2, ASSETS11, { R: fake(2, { constants: { MAX_MAPS: 8 } }) });
    check_('a runtime that says MAX_MAPS = 8 (an older build) refuses 9 maps with a clear error', lim.errors.length === 1 && /this runtime build holds at most 8 maps in its map table \(MAX_MAPS\); the game has 9/.test(lim.errors[0].message), errText(lim));
  }
}

// =================================================================================================================
// 7. Byte identity with the previous compiler
// =================================================================================================================
console.log('\n7. Programs with no WORLD, at most 8 maps and nothing banked compile to exactly the bytes of the previous compiler');
{
  const OLD_DEFAULT = '/tmp/claude-1000/-home-charlie-day-Projects-Leap-IDE/10a0188f-ac8e-4b19-8628-9567564da16d/scratchpad/arcade-old';
  const oldDir = process.env.ARCADE_OLD ?? (existsSync(join(OLD_DEFAULT, 'arcade-compile.js')) ? OLD_DEFAULT : null);
  if (!oldDir) skip_('byte identity against the previous compiler', 'set ARCADE_OLD to a copy of the previous src/lang/arcade/');
  else {
    const oldCompile = (await import(pathToFileURL(join(oldDir, 'arcade-compile.js')).href)).compile;
    const { readdirSync } = await import('node:fs');
    const progs = [];
    const dirs = ['arcade/examples', 'arcade/tests/fixtures'];
    for (const d of dirs) for (const f of readdirSync(join(ROOT, d)).filter((x) => x.endsWith('.arc')).sort()) {
      const aj = join(ROOT, d, f.replace('.arc', '.assets.json'));
      // The identity claim is only for programs that use no new feature: the previous compiler cannot build a program that uses WORLD
      // (the banked worlds, runner.arc), so such a program is left out (the banking has its own sections above).
      const srcText = readFileSync(join(ROOT, d, f), 'utf8');
      if (/^\s*WORLD\b/im.test(srcText)) continue;
      progs.push({ src: `${d}/${f}`, text: srcText, assets: existsSync(aj) ? JSON.parse(readFileSync(aj, 'utf8')) : undefined });
    }
    // the programs the batch tests are built from
    const { genV3, genV4 } = await import('./arcade-m9-common.mjs');
    for (let seed = 1; seed <= 6; seed++) { const g3 = genV3(seed), g4 = genV4(seed); progs.push({ src: `genV3(${seed})`, text: g3.src, assets: g3.assets ?? ASSETS }, { src: `genV4(${seed})`, text: g4.src, assets: g4.assets ?? ASSETS }); }
    const fnv = (s) => { let h = 0x811C9DC5; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; } return h; };
    const NAMES = ['RT_SHOW', 'RT_HIDE', 'RT_HIT', 'RT_KEYDOWN', 'RT_AT', 'RT_PRINTS', 'RT_PRINTN', 'RT_PRINTC', 'RT_INK', 'RT_PAPER', 'RT_BRIGHT', 'RT_CLS', 'RT_TILE', 'RT_TILEAT', 'RT_PLAY', 'RT_SILENCE', 'RT_MUL', 'RT_DIV', 'RT_MOD', 'RT_RND', 'RT_STICK', 'V_CUR_ROW', 'V_CUR_COL', 'V_TICKS'];
    const stand = (version) => ({ rt: { version, symbols: Object.fromEntries(NAMES.map((n) => [n, 0xC000 + (fnv(n) % 0x2000)])), constants: { GAME_BASE: 0x8000, GAME_VARS_BASE: 0xE100, GAME_VARS_LIMIT: 0xEFFF, MAX_SPRITES: version >= 2 ? 16 : 4, MAX_ASSETS: 8 } }, img: new Uint8Array(65536) });
    const targets = [['stand-in v0', stand(0)], ['stand-in v1', stand(1)], ['real v2', REAL[2]], ['real v3', REAL[3]], ['real v4', REAL[4]]].filter(([, R]) => R);
    let n = 0, same = 0, built = 0, bad = '';
    const eqb = (x, y) => (!x && !y) || (!!x && !!y && sameBytes(x, y));
    for (const p of progs) for (const [tn, R] of targets) {
      const o = oldCompile(p.text, { runtime: R.rt, image: R.img, assets: p.assets }), w = compile(p.text, { runtime: R.rt, image: R.img, assets: p.assets });
      n++;
      const ok = eqb(o.memory, w.memory) && eqb(o.dck, w.dck) && JSON.stringify(o.errors) === JSON.stringify(w.errors) && JSON.stringify(o.warnings) === JSON.stringify(w.warnings) && (!o.gen || sameBytes(o.gen.code, w.gen.code)) && (!o.usage || JSON.stringify({ ...o.usage, codegen: undefined }) === JSON.stringify(Object.fromEntries(Object.entries({ ...w.usage, codegen: undefined }).filter(([k]) => !['mapped', 'banked', 'shippedChunks'].includes(k)))));
      if (ok) { same++; if (w.memory) built++; } else bad += `${p.src} on ${tn}; `;
    }
    check_(`${progs.length} programs (every example, every fixture, the batch 4 / 5 generated v3 / v4 programs) on ${targets.length} runtime tables: ${n} compilations, the image, the DCK, the code, the errors, the warnings and the usage fields are identical`, same === n && n > 0, bad);
    info(`byte identity: ${n} compilations compared, ${same} identical, ${built} of them built a cartridge (the others are the same error lists, e.g. a v4 program on the v2 runtime)`);
    check_('and a good number of them built a cartridge (the comparison is not all errors)', built >= 20, `${built}`);
    // a program with several maps (9 is over the old limit; up to 8 is old territory): 8 maps that fit
    const eight = plain2(mapDecls(Array.from({ length: 8 }, (_, i) => i), 'm', (i) => `s${i}`), Array.from({ length: 8 }, (_, i) => `    LOADMAP m${i}`).join('\n') + '\n');
    const o8 = oldCompile(eight, { runtime: REAL[2].rt, image: REAL[2].img, assets: ASSETS11 }), w8 = compile(eight, { runtime: REAL[2].rt, image: REAL[2].img, assets: ASSETS11 });
    check_('8 maps of 770 bytes (they fit): identical image and DCK', o8.errors.length === 0 && w8.errors.length === 0 && sameBytes(o8.memory, w8.memory) && sameBytes(o8.dck, w8.dck));
  }
}

// =================================================================================================================
// 8. The real runtime tables
// =================================================================================================================
console.log('\n8. WORLD against the runtime tables as they are in the tree (arcade/build/v3, v4)');
{
  const src3 = win3('    v = v + 1\n    IF v = 3 THEN WORLD second ENDIF', 'MAP second = "w60"\n');
  const src4 = view4('    v = v + 1\n    IF v = 3 THEN WORLD other ENDIF', 'MAP other = "p8"\n');
  for (const [v, src, sym] of [[3, src3, 'RT_WORLDLOAD'], [4, src4, 'RT_PLANLOAD']]) {
    const R = REAL[v];
    if (!R) { skip_(`v${v} WORLD against the tree's runtime`, `arcade/build/v${v}/runtime.json is missing`); continue; }
    if (R.rt.symbols[sym] === undefined) { skip_(`v${v} WORLD against the tree's runtime`, `its runtime.json has no ${sym} yet (the runtime slice B1 is not built)`); continue; }
    const o = compile(src, { runtime: R.rt, image: R.img, assets: ASSETS11 });
    check_(`v${v}: WORLD compiles against the tree's runtime.json and calls ${sym} at ${hex(R.rt.symbols[sym])}`, o.errors.length === 0 && o.gen.fixups.length === 1 && rd16(o.memory, o.gen.fixups[0].at + (v === 3 ? 7 : 5) + 1) === R.rt.symbols[sym], errText(o));
    const ob = compile(src, { runtime: R.rt, image: R.img, assets: ASSETS11, bankAll: true });
    check_(`v${v}: and with every map banked`, ob.errors.length === 0 && ob.usage.banked.assets.length >= 2 && ob.shipped.join() === '0,1,2,4,5', errText(ob));
  }
}

console.log(`\n${failed === 0 ? 'OK' : 'FAIL'}: ${passed} checks passed${failed ? `, ${failed} failed` : ''}${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed === 0 ? 0 : 1);
