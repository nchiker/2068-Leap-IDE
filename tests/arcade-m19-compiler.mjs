#!/usr/bin/env node
"use strict";
// arcade-m19-compiler.mjs -- tests for the compiler / interpreter half of fine colour (8 x 1 colour, SCLD mode 2), slice F3 part a:
// docs/ARCADE_FINE_COLOUR_CONTRACT.md sections 1, 2, 4.1, 5.2 and 6 (without the Studio).
//
//   node tests/arcade-m19-compiler.mjs                       (--write-baseline rewrites arcade/tests/fixtures/m19-nonfine-baseline.json: only from a compiler known to be unchanged for programs without a fine scene)
//   ARCADE_M19_OLD=<git ref> node tests/arcade-m19-compiler.mjs     compares section 8 with the compiler of that ref (git archive) as well, whatever runtime the tree has
//
// No machine is booted. The runtime half (RT_FINEMODE, fine.asm) is written in parallel: the code generator is checked against the real v2 runtime table with a FAKE symbol RT_FINEMODE added.
// Sections
//   1  arcadec: the setting from the assets file's "scenes" key and from --scenes (which wins), the usage text
//   2  sceneDisplayPlan: `built`, the notes (fine has none, hires keeps its own), version and WIRE3D
//   3  compile(): the errors of section 1.2 (exact texts, on the scene's line), a scene the project does not set to fine, the runtime without RT_FINEMODE, bad row colours
//   4  assets: tileRowAttrs / convertTileset rowAttrs / convertSprite inks
//   5  code generation: the fine descriptor bytes (never banked), the RT_FINEMODE call sequence of the boot and every ENTER
//   6  finePicture: hand-made cases (font cell, tile cell, sprite colour rule, mask $FF, overlap order, phase rounding, edges) and a random comparison with a per-pixel reference
//   7  the interpreter: the `fine` key of the records and of the result, only for a game with a fine scene
//   8  byte identity: every example and fixture compiles to the same bytes as before fine colour (also with the runtime knowing RT_FINEMODE and every scene set to buffers)
import { readFileSync, existsSync, readdirSync, writeFileSync, mkdtempSync, rmSync, mkdirSync, copyFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { compile, requiredRuntime } from '../src/lang/arcade/arcade-compile.js';
import { sceneDisplayPlan, rowOff } from '../src/lang/arcade/arcade-display.js';
import { tileRowAttrs, convertTileset, tileAttr } from '../src/lang/arcade/arcade-assets.js';
import { convertSprite, generate } from '../src/lang/arcade/arcade-codegen.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { finePicture, spriteColour, phaseX, glyphSource, fineOfRun, FINE_BYTES } from '../src/lang/arcade/arcade-fine.js';
import { ASSETS11, HEAD, scene, win3, view4 } from './arcade-m11-common.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'arcade/tests/fixtures/m19-nonfine-baseline.json');
let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${!ok && detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const skip_ = (name, why) => { console.log(`  SKIP  ${name}  (${why})`); skipped++; };
const eq = (name, got, want) => check_(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── the runtimes: the tree's own v2 / v3 / v4 builds, the v2 one also with a fake RT_FINEMODE ───────────────────────────────────────────────────
function loadRt(v) {
  const json = join(ROOT, `arcade/build/v${v}/runtime.json`);
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, image: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))), dir: dirname(json) };
}
const REAL = { 2: loadRt(2), 3: loadRt(3), 4: loadRt(4) };
if (!REAL[2] || !REAL[3] || !REAL[4]) { console.log('SKIP: arcade/build/v2, v3 and v4 (runtime.json) are needed (node arcade/tools/build-runtime-v2.mjs ...)'); process.exit(0); }
const FINEMODE = 0x3300;                                   // a fake address (beyond RT_END of every build): the generator only needs the symbol to exist
const FAKE2 = { ...REAL[2], rt: { ...REAL[2].rt, symbols: { ...REAL[2].rt.symbols, RT_FINEMODE: FINEMODE } } };
// a v2 runtime WITHOUT RT_FINEMODE (as before fine.asm): the tree's build with the symbol taken out
const NOFINE2 = (() => { const { RT_FINEMODE: _drop, ...symbols } = REAL[2].rt.symbols; return { ...REAL[2], rt: { ...REAL[2].rt, symbols } }; })();
const withWire = (R) => (R.rt.symbols.RT_WIREMODE !== undefined ? R : { ...R, rt: { ...R.rt, symbols: { ...R.rt.symbols, RT_WIREMODE: 0x3B00 }, constants: { ...R.rt.constants, DIV_WIRE: R.rt.constants.DIV_WIRE ?? 0x40 } } });
const build = (src, R = FAKE2, assets = FA, scenes, extra = {}) => compile(src, { runtime: R.rt, image: R.image, assets, ...(scenes ? { scenes } : {}), ...extra });
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
const FINE = (...names) => Object.fromEntries(names.map((n) => [n, { display: 'fine' }]));

// ── assets and programs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const trow = (k, ink, paper, bright) => ({ bits: (0x0F + k).toString(16), ink: ink + (k % 3), paper, bright });
const tile = (ink, paper, bright, rows = 8) => ({ rows: Array.from({ length: rows }, (_, k) => trow(k, ink, paper, bright ?? k & 1)) });
const FA = {
  tilesets: { ts: { tiles: [tile(1, 1), tile(2, 3), tile(0, 5)] } },
  sprites: { sp: { w: 8, h: 4, rows: [2, 3, 4, 5].map((ink) => ({ bits: 'FF', mask: 'FF', ink })) }, big: { w: 16, h: 6, phases: 4, rows: [1, 2, 3, 4, 5, 6].map((ink) => ({ bits: 'FFFF', mask: 'FFFF', ink })) } },
  maps: { m: { w: 4, h: 3, cells: [0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2] } },
};
/** a two-scene game: `a` (sprite, tile in INIT, ENTER b) and `b` (nothing) */
const TWO = `GAME "f"\nFRAMERATE 20\nTILESET ts = "ts"\nSPRITE s = "sp"\nDIM n\nSCENE a\n  PROC INIT():\n    TILE 1, 1 = 0\n  ENDP\n  PROC FRAME():\n    n = n + 1\n    SHOW s AT 10 + n, 10\n    IF n = 2 THEN ENTER b ENDIF\n  ENDP\nENDSCENE\nSCENE b\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n    IF KEYDOWN("A") THEN ENTER a ENDIF\n  ENDP\nENDSCENE\n`;
const ONE = `GAME "f"\nFRAMERATE 20\nTILESET ts = "ts"\nSPRITE s = "sp"\nSCENE a\n  PROC INIT():\n    TILE 1, 1 = 0\n  ENDP\n  PROC FRAME():\n    SHOW s AT 10, 10\n  ENDP\nENDSCENE\n`;
const ONE_ENTER = ONE.replace('SHOW s AT 10, 10\n', 'SHOW s AT 10, 10\n    IF KEYDOWN("A") THEN ENTER a ENDIF\n');
const WIREG = `GAME "w"\nFRAMERATE 20\nWIRE3D ROWS 2 TO 21 INK 5 PAPER 0 BRIGHT 0\nMODEL gate = "gate"\nDIM t\nSCENE x\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n    t = t + 1\n    EYE t, 0, 5, 0\n    DRAWMODEL gate AT 0, 0, 100\n  ENDP\nENDSCENE\n`;
const WIREA = { models: { gate: { points: [[-10, 0, 0], [10, 0, 0], [0, 10, 0]], edges: [[0, 1], [1, 2], [2, 0]] } } };
const lineOf = (src, needle) => src.slice(0, src.indexOf(needle)).split('\n').length;
const colOf = (src, needle) => { const i = src.indexOf(needle); return i - src.lastIndexOf('\n', i) - 1; };
const u16 = (m, a) => m[a] | (m[a + 1] << 8);
/** the emitted code as normalised lines (a final `call X` + `ret` is emitted as `jp X`: written back as a call) */
const norm = (r) => r.gen.emitter.asm().split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith(';')).join(';').replace(/;jp (\d+)(?=;)/g, ';call $1;ret');
/** the A values of the RT_FINEMODE calls in code order: `ld a,N;ld hl,L_fine_desc;call <FINEMODE>` */
const fineCalls = (r) => [...norm(r).matchAll(new RegExp(`ld a,(\\d+);ld hl,L_fine_desc;call ${FINEMODE}(?:;|$)`, 'g'))].map((m) => Number(m[1]));
const nFineRefs = (r) => (norm(r).match(/L_fine_desc/g) ?? []).length - (norm(r).match(/^L_fine_desc:|;L_fine_desc:/g) ?? []).length;

// =================================================================================================================
// 1. arcadec
// =================================================================================================================
console.log('1. arcadec: the scenes setting');
{
  const tmp = mkdtempSync(join(tmpdir(), 'm19-cli-'));
  try {
    const rtDir = join(tmp, 'rt'); mkdirSync(rtDir);
    writeFileSync(join(rtDir, 'runtime.json'), JSON.stringify(FAKE2.rt));
    copyFileSync(join(REAL[2].dir, REAL[2].rt.image ?? 'runtime.bin'), join(rtDir, REAL[2].rt.image ?? 'runtime.bin'));
    const src = join(tmp, 'g.arc'); writeFileSync(src, TWO);
    const put = (name, obj) => { const p = join(tmp, name); writeFileSync(p, JSON.stringify(obj)); return p; };
    const aPlain = put('plain.json', FA), aFine = put('fine.json', { ...FA, scenes: FINE('a') }), aBuf = put('buf.json', { ...FA, scenes: { a: { display: 'buffers' } } });
    const sFine = put('s-fine.json', FINE('a')), sBuf = put('s-buf.json', { a: { display: 'buffers' } });
    const run = (assets, ...more) => {
      const out = join(tmp, `o${Math.random().toString(36).slice(2)}.dck`);
      const r = spawnSync(process.execPath, [join(ROOT, 'arcade/tools/arcadec.mjs'), src, '--assets', assets, '--runtime', rtDir, '-o', out, ...more], { encoding: 'utf8' });
      return { status: r.status, out: r.stdout + r.stderr, dck: existsSync(out) ? new Uint8Array(readFileSync(out)) : null };
    };
    const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
    const has = (d, seq) => { for (let i = 0; i + seq.length <= d.length; i++) if (seq.every((v, k) => d[i + k] === v)) return true; return false; };
    const call = [0xCD, FINEMODE & 255, FINEMODE >> 8];
    const plain = run(aPlain), fine = run(aFine), viaFile = run(aPlain, '--scenes', sFine), win = run(aFine, '--scenes', sBuf), win2 = run(aBuf, '--scenes', sFine);
    check_('no setting: builds, and the cartridge has no call of RT_FINEMODE', plain.status === 0 && plain.dck && !has(plain.dck, call), plain.out);
    check_('a top-level "scenes" key of the assets file reaches the compiler: the cartridge calls RT_FINEMODE', fine.status === 0 && fine.dck && has(fine.dck, call) && !same(fine.dck, plain.dck), fine.out);
    check_('--scenes <file> alone does the same (and the bytes equal the assets-file version)', viaFile.status === 0 && same(viaFile.dck, fine.dck), viaFile.out);
    check_('--scenes wins over the assets file: fine in the assets file, buffers in --scenes = the plain build', win.status === 0 && same(win.dck, plain.dck), win.out);
    check_('... and the other way: buffers in the assets file, fine in --scenes = the fine build', win2.status === 0 && same(win2.dck, fine.dck), win2.out);
    const noDir = join(tmp, 'rt-nofine'); mkdirSync(noDir);
    writeFileSync(join(noDir, 'runtime.json'), JSON.stringify(NOFINE2.rt));
    copyFileSync(join(REAL[2].dir, REAL[2].rt.image ?? 'runtime.bin'), join(noDir, REAL[2].rt.image ?? 'runtime.bin'));
    const real = spawnSync(process.execPath, [join(ROOT, 'arcade/tools/arcadec.mjs'), src, '--assets', aFine, '--runtime', noDir, '-o', join(tmp, 'real.dck')], { encoding: 'utf8' });
    check_('on a runtime without RT_FINEMODE the build fails with the scene error (exit 1, no cartridge)', real.status === 1 && /g\.arc:6:7: error: scene 'a': fine colour needs RT_FINEMODE, which this runtime does not provide \(rebuild the v2 runtime\)/.test(real.stdout) && !existsSync(join(tmp, 'real.dck')), real.stdout);
    const help = spawnSync(process.execPath, [join(ROOT, 'arcade/tools/arcadec.mjs'), '-h'], { encoding: 'utf8' });
    check_('the usage text names --scenes and the "scenes" key', help.status === 2 && /--scenes <scenes\.json>/.test(help.stderr) && /top-level "scenes" key of the assets file/.test(help.stderr), help.stderr);
    const noArg = spawnSync(process.execPath, [join(ROOT, 'arcade/tools/arcadec.mjs'), src, '--scenes'], { encoding: 'utf8' });
    check_('--scenes without a file is a usage error (exit 2)', noArg.status === 2 && /--scenes needs a file/.test(noArg.stderr), noArg.stderr);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

// =================================================================================================================
// 2. sceneDisplayPlan
// =================================================================================================================
console.log('\n2. sceneDisplayPlan: built');
{
  const plan = (src, scenes, version) => sceneDisplayPlan(parse(src).ast, { scenes, ...(version === undefined ? {} : { version }) });
  const p = plan(TWO, FINE('a'));
  eq('a fine scene of a v2 game: built "fine", setting "fine", no note; the other scene (no setting) "buffers"', p.map((s) => [s.name, s.override, s.built, s.notes.length]), [['a', 'fine', 'fine', 0], ['b', 'auto', 'buffers', 0]]);
  check_('... its setting is "fine"', p[0].setting === 'fine');
  eq('both scenes fine', plan(TWO, FINE('a', 'b')).map((s) => s.built), ['fine', 'fine']);
  const staticTwo = TWO.replace('SHOW s AT 10 + n, 10\n', '').replace('IF n = 2 THEN ENTER b ENDIF\n', '').replace('n = n + 1\n', '');
  eq('no setting: built "buffers" everywhere, also for a scene whose automatic choice is "fine" (a static picture) and one whose is "hires"', plan(staticTwo).map((s) => [s.auto, s.built]), [['fine', 'buffers'], ['hires', 'buffers']]);
  eq('"buffers" and "auto" as settings: built "buffers"', plan(TWO, { a: { display: 'buffers' }, b: { display: 'auto' } }).map((s) => s.built), ['buffers', 'buffers']);
  eq('the setting is read ignoring case and white space', plan(TWO, { A: { display: ' Fine ' } }).map((s) => s.built), ['fine', 'buffers']);
  const h = plan(TWO, { a: { display: 'hires' } })[0];
  check_('"hires" keeps its note and stays built "buffers"', h.built === 'buffers' && h.notes.length === 1 && h.notes[0] === "scene 'a': display 'hires' (512 x 192 hi-res) is not built into any runtime yet; the scene is built with two buffers", JSON.stringify(h));
  eq('version 3, 4, 1 and 0 build it with two buffers (the compiler reports the error)', [3, 4, 1, 0].map((v) => plan(TWO, FINE('a'), v)[0].built), ['buffers', 'buffers', 'buffers', 'buffers']);
  eq('version 2 explicitly: fine', plan(TWO, FINE('a'), 2)[0].built, 'fine');
  const w = plan(WIREG, FINE('x'));
  check_('a WIRE3D game: built "buffers"', w[0].built === 'buffers' && w[0].setting === 'fine', JSON.stringify(w[0]));
  check_('the entries have exactly the keys they had', Object.keys(p[0]).join() === 'name,line,col,auto,reason,override,setting,built,spriteColour,notes');
}

// =================================================================================================================
// 3. compile(): errors
// =================================================================================================================
console.log('\n3. compile(): fine colour needs v2 and no WIRE3D');
{
  const ok = build(TWO, FAKE2, FA, FINE('a'));
  check_('a v2 game with a fine scene builds (fake RT_FINEMODE), out.scenes says built fine, no warning about it', ok.errors.length === 0 && !!ok.dck && ok.scenes.map((s) => s.built).join() === 'fine,buffers' && ok.warnings.every((w) => !/fine|8 x 1/.test(w.message)), errText(ok) + JSON.stringify(ok.warnings));
  const w3 = win3('    CAMERA 10\n', '', '    TILE 1, 1 = 0\n').replace('SCENE s', 'SCENE xs');
  const r3 = build(w3, REAL[3], ASSETS11, FINE('xs'));
  eq('WINDOW (runtime v3): the exact error on the scene line, at the name', [r3.errors.length, r3.errors[0]?.message, r3.errors[0]?.line, r3.errors[0]?.col, r3.errors[0]?.endCol, r3.errors[0]?.severity],
    [1, "scene 'xs': fine colour (display 'fine') needs runtime v2; this game uses WINDOW (runtime v3)", lineOf(w3, 'SCENE xs'), colOf(w3, 'xs'), colOf(w3, 'xs') + 2, 'error']);
  check_('... and no cartridge, no later error', r3.dck === null && r3.memory === null);
  const v4 = view4('    VIEW 100, 100, 0\n', '', '').replace('SCENE s', 'SCENE xs');
  const r4 = build(v4, REAL[4], ASSETS11, FINE('xs'));
  eq('VIEW3D (runtime v4): the exact error', r4.errors.map((e) => [e.line, e.message]), [[lineOf(v4, 'SCENE xs'), "scene 'xs': fine colour (display 'fine') needs runtime v2; this game uses VIEW3D (runtime v4)"]]);
  const flip = `GAME "f"\nFRAMERATE 20\nSPRITE s = "sp"\nSCENE a\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n    SHOW s AT 1, 1 FLIP\n  ENDP\nENDSCENE\n`;
  const r3b = build(flip, REAL[3], FA, FINE('a'));
  eq('a v3 game by another word (FLIP): the reason is that word', r3b.errors.map((e) => e.message), ["scene 'a': fine colour (display 'fine') needs runtime v2; this game uses FLIP (runtime v3)"]);
  const r3c = build(TWO, REAL[3], FA, FINE('a'));
  eq('a plain game compiled for runtime v3 (the caller chose it): the generic form', r3c.errors.map((e) => e.message), ["scene 'a': fine colour (display 'fine') needs runtime v2; this game is built for runtime v3"]);
  const rw = build(WIREG, withWire(REAL[2]), WIREA, FINE('x'));
  eq('WIRE3D (runtime v2): the exact error', rw.errors.map((e) => [e.line, e.col, e.message]), [[lineOf(WIREG, 'SCENE x'), colOf(WIREG, 'x\n  PROC'), "scene 'x': fine colour (display 'fine') cannot be used in a WIRE3D game"]]);
  check_('the same WIRE3D game without the setting builds', build(WIREG, withWire(REAL[2]), WIREA).errors.length === 0, errText(build(WIREG, withWire(REAL[2]), WIREA)));
  const two = build(TWO.replace('SCENE b', 'SCENE b2').replace('ENTER b ', 'ENTER b2 '), REAL[3], FA, FINE('a', 'b2'));
  eq('one error per fine scene', two.errors.length, 2);
  // a scene the project does NOT set: whatever its automatic choice, it is not an error
  const staticG = win3('    CAMERA 10\n', '', '    TILE 1, 1 = 0\n');
  check_('a v3 game with no fine setting (scenes absent, {}, "auto", "buffers"): no error from this rule', [undefined, {}, { s: { display: 'auto' } }, { s: { display: 'buffers' } }].every((sc) => !build(staticG, REAL[3], ASSETS11, sc).errors.some((e) => /fine colour/.test(e.message))));
  const autoFine = `${HEAD}SPRITE ship = "orb"\nMAP level = "lv"\nWINDOW level\nSCENE title NOWINDOW\n  PROC INIT():\n    TILE 1, 1 = 1\n  ENDP\n  PROC FRAME():\n    IF STICK(1) > 15 THEN ENTER play ENDIF\n  ENDP\nENDSCENE\nSCENE play\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n    CAMERA 10\n  ENDP\nENDSCENE\n`;
  const rAuto = build(autoFine, REAL[3], ASSETS11, undefined, {});
  check_('a v3 game whose NOWINDOW scene has the automatic choice "fine" (a static picture) and no project setting: the plan says fine, built buffers, no fine error', rAuto.errors.every((e) => !/fine colour/.test(e.message)) && rAuto.scenes?.[0].auto === 'fine' && rAuto.scenes[0].built === 'buffers', errText(rAuto) + JSON.stringify(rAuto.scenes?.[0]));
  const noRt = compile(TWO, { assets: FA, scenes: FINE('a') });
  check_('with no runtime at all the error is the missing runtime, not a fine error; out.scenes still says fine', noRt.errors.length === 1 && /^no runtime image/.test(noRt.errors[0].message) && noRt.scenes[0].built === 'fine', errText(noRt));
  // the runtime without the routine
  const nr = build(TWO, NOFINE2, FA, FINE('a'));
  eq('a runtime without RT_FINEMODE: the exact error on the scene line', nr.errors.map((e) => [e.line, e.col, e.message]), [[lineOf(TWO, 'SCENE a'), colOf(TWO, 'a\n  PROC'), "scene 'a': fine colour needs RT_FINEMODE, which this runtime does not provide (rebuild the v2 runtime)"]]);
  const nr2 = build(TWO, NOFINE2, FA, FINE('a', 'b'));
  eq('... one for each fine scene', nr2.errors.map((e) => e.message.slice(0, 9) + e.line).join(), `scene 'a'${lineOf(TWO, 'SCENE a')},scene 'b'${lineOf(TWO, 'SCENE b')}`);
  check_('a runtime without RT_FINEMODE but no fine scene: builds as ever', build(TWO, NOFINE2, FA).errors.length === 0 && build(TWO, NOFINE2, FA, { a: { display: 'buffers' } }).errors.length === 0);
  // bad authoring is only an error in a fine game
  const badTile = { ...FA, tilesets: { ts: { tiles: [{ rows: tile(1, 1).rows.map((r, k) => (k === 3 ? { ...r, ink: 9 } : r)) }, tile(2, 3)] } } };
  const badSp = { ...FA, sprites: { ...FA.sprites, sp: { w: 8, h: 4, rows: [2, 3, 12, 5].map((ink) => ({ bits: 'FF', mask: 'FF', ink })) } } };
  check_('a tile row 3 with ink 9 and a sprite row with ink 12: both build without a fine scene', build(TWO, FAKE2, badTile).errors.length === 0 && build(TWO, FAKE2, badSp).errors.length === 0);
  eq('... and in a fine game the tile is an error on the TILESET line', build(TWO, FAKE2, badTile, FINE('a')).errors.map((e) => [e.line, e.message]), [[lineOf(TWO, 'TILESET'), 'tileset "ts": tile 0 row 3 ink must be a whole number 0..7, got 9']]);
  eq('... and the sprite is an error on the SPRITE line', build(TWO, FAKE2, badSp, FINE('a')).errors.map((e) => [e.line, e.message]), [[lineOf(TWO, 'SPRITE'), 'sprite "sp": row 2 ink must be a whole number 0..7, got 12']]);
  eq('requiredRuntime is unaffected (a game with a fine scene is v2 unless it uses a v3 word)', [requiredRuntime(TWO, FA), requiredRuntime(flip, FA).version], [{ version: 2, reasons: [], ink: false }, 3]);
}

// =================================================================================================================
// 4. assets
// =================================================================================================================
console.log('\n4. assets: row attributes and row inks');
{
  const t = { rows: [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ({ bits: 'FF', ink: k, paper: 7 - k, bright: k & 1 })) };
  eq('tileRowAttrs: row k = bright << 6 | paper << 3 | ink', Array.from(tileRowAttrs(t)), [0, 1, 2, 3, 4, 5, 6, 7].map((k) => ((k & 1) << 6) | ((7 - k) << 3) | k));
  eq('defaults per row: ink 0, paper 7, bright 0 (as tileAttr)', Array.from(tileRowAttrs({ rows: Array.from({ length: 8 }, () => ({ bits: 0 })) })), Array(8).fill(0x38));
  eq('bright may be true / false', Array.from(tileRowAttrs({ rows: Array.from({ length: 8 }, (_, k) => ({ bits: 0, ink: 1, paper: 2, bright: k < 4 })) })), [0x51, 0x51, 0x51, 0x51, 0x11, 0x11, 0x11, 0x11]);
  check_('row 0 of tileRowAttrs is tileAttr of row 0', tileRowAttrs(t)[0] === tileAttr(t.rows[0]));
  const bad = (f) => { try { f(); return 'no error'; } catch (e) { return e.message; } };
  eq('range checks as tileAttr: ink 8, paper -1, bright 2 name the row', [bad(() => tileRowAttrs({ rows: [{}, {}, { ink: 8 }, {}, {}, {}, {}, {}] }, 'tile 4')), bad(() => tileRowAttrs({ rows: [{}, {}, {}, {}, {}, { paper: -1 }, {}, {}] })), bad(() => tileRowAttrs({ rows: [{}, {}, {}, {}, {}, {}, {}, { bright: 2 }] }))],
    ['tile 4 row 2 ink must be a whole number 0..7, got 8', 'tile row 5 paper must be a whole number 0..7, got -1', 'tile row 7 bright must be a whole number 0..1, got 2']);
  const ts = convertTileset(FA.tilesets.ts);
  check_('convertTileset: rowAttrs is count x 8 bytes, tile t at +8t, `bytes` is still count x 9 with row 0 attribute', ts.rowAttrs.length === 24 && ts.bytes.length === 27 && [0, 1, 2].every((i) => Array.from(ts.rowAttrs.slice(8 * i, 8 * i + 8)).join() === Array.from(tileRowAttrs(FA.tilesets.ts.tiles[i])).join() && ts.bytes[9 * i + 8] === ts.rowAttrs[8 * i]));
  const tsBad = convertTileset({ tiles: [{ rows: Array.from({ length: 8 }, (_, k) => ({ bits: 1, ink: k === 4 ? 9 : 1, paper: 6 })) }] });
  check_('a bad row colour in rows 1..7 does not make convertTileset throw (only a fine game reports it): rowAttrsProblem says which, the tile gets row 0\'s attribute throughout', tsBad.rowAttrsProblem === 'tile 0 row 4 ink must be a whole number 0..7, got 9' && Array.from(tsBad.rowAttrs).every((v) => v === tsBad.bytes[8]) && ts.rowAttrsProblem === null, tsBad.rowAttrsProblem);
  const sp = convertSprite({ w: 16, h: 3, rows: [{ bits: 'FFFF', ink: 1 }, { bits: 'FFFF', ink: 6 }, { bits: 'FFFF' }] });
  eq('convertSprite inks: 16 bytes, the ink of each art row (default 7), 0 beyond the height', Array.from(sp.inks), [1, 6, 7, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const full = convertSprite({ w: 16, h: 16, rows: Array.from({ length: 16 }, (_, k) => ({ bits: 'FFFF', ink: k & 7 })) });
  eq('a 16-row sprite: all 16 inks', Array.from(full.inks), Array.from({ length: 16 }, (_, k) => k & 7));
  const before = convertSprite({ w: 8, h: 2, rows: [{ bits: 'F0', mask: 'F0' }, { bits: '0F', mask: 'FF' }] });
  check_('data, w, h, srcW are what they were (row format: mask_hi, mask_lo, image_hi, image_lo)', before.w === 16 && before.h === 2 && before.srcW === 8 && Array.from(before.data).join() === [0x0F, 0xFF, 0xF0, 0x00, 0x00, 0xFF, 0x0F, 0x00].join(), Array.from(before.data).join());
  check_('an ink out of range: inkProblem names the row, the ink is `& 7`, nothing throws', (() => { const c = convertSprite({ w: 8, h: 2, rows: [{ bits: 1, ink: 3 }, { bits: 1, ink: 12 }] }); return c.inkProblem === 'row 1 ink must be a whole number 0..7, got 12' && c.inks[1] === 4 && c.inks[0] === 3; })());
  check_('no problem when every ink is fine (null)', sp.inkProblem === null && full.inkProblem === null);
}

// =================================================================================================================
// 5. code generation
// =================================================================================================================
console.log('\n5. code generation: the descriptor and the RT_FINEMODE calls');
{
  const r = build(TWO, FAKE2, FA, FINE('a'));
  const e = r.gen.emitter, desc = e.addressOf('fine$desc'), m = r.memory;
  const tr = u16(m, desc), si = u16(m, desc + 2), ts = convertTileset(FA.tilesets.ts), MAXA = FAKE2.rt.constants.MAX_ASSETS;
  check_('the descriptor is DW tile_rows, DW sprite_inks (labels fine$rows, fine$inks)', tr === e.addressOf('fine$rows') && si === e.addressOf('fine$inks') && desc + 4 === tr, `desc ${desc.toString(16)}, rows ${tr.toString(16)}, inks ${si.toString(16)}`);
  check_('tile_rows: count x 8 bytes, tile t at +8t', Array.from(m.slice(tr, tr + 24)).join() === Array.from(ts.rowAttrs).join() && tr + 24 === si, Array.from(m.slice(tr, tr + 24)).join());
  const inks = Array.from(m.slice(si, si + 16 * MAXA));
  check_(`sprite_inks: MAX_ASSETS (${MAXA}) x 16 bytes, asset 0 at +0, the rest 0`, inks.length === 16 * MAXA && inks.slice(0, 16).join() === [2, 3, 4, 5, ...Array(12).fill(0)].join() && inks.slice(16).every((v) => v === 0), inks.slice(0, 20).join());
  const ai = r.gen.sprites.findIndex((s) => s.name === 's');
  check_('the data is part of the game image (inside the mapped game area)', desc >= 0x8000 && si + 16 * MAXA <= 0xC000, desc.toString(16));
  check_('usage.data.fine counts it', r.gen.usage.dataBytes.fine === 4 + 24 + 16 * MAXA, JSON.stringify(r.gen.usage.dataBytes));
  // two assets: asset a at +16a
  const two = { ...FA, sprites: { sp: FA.sprites.sp, big: FA.sprites.big } };
  const src2 = ONE.replace('SPRITE s = "sp"', 'SPRITE s = "sp"\nSPRITE g = "big"').replace('SHOW s AT 10, 10', 'SHOW s AT 10, 10\n    SHOW g AT 50, 50');
  const r2 = build(src2, FAKE2, two, FINE('a'));
  const si2 = u16(r2.memory, r2.gen.emitter.addressOf('fine$desc') + 2);
  check_('two assets: asset a\'s row k at sprite_inks + 16 a + k (asset order = order of first use)', r2.errors.length === 0 && r2.memory[si2 + 0] === 2 && r2.memory[si2 + 3] === 5 && r2.memory[si2 + 16] === 1 && r2.memory[si2 + 21] === 6 && r2.memory[si2 + 22] === 0 && ai === 0, errText(r2));
  // missing tables: 0
  const noTs = `GAME "f"\nFRAMERATE 20\nSPRITE s = "sp"\nSCENE a\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n    SHOW s AT 10, 10\n  ENDP\nENDSCENE\n`;
  const rn = build(noTs, FAKE2, FA, FINE('a'));
  check_('no tileset: tile_rows is 0', rn.errors.length === 0 && u16(rn.memory, rn.gen.emitter.addressOf('fine$desc')) === 0 && u16(rn.memory, rn.gen.emitter.addressOf('fine$desc') + 2) !== 0, errText(rn));
  const noSp = `GAME "f"\nFRAMERATE 20\nTILESET ts = "ts"\nSCENE a\n  PROC INIT():\n    TILE 1, 1 = 0\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n`;
  const rs = build(noSp, FAKE2, FA, FINE('a'));
  check_('no sprites: sprite_inks is 0', rs.errors.length === 0 && u16(rs.memory, rs.gen.emitter.addressOf('fine$desc') + 2) === 0 && u16(rs.memory, rs.gen.emitter.addressOf('fine$desc')) !== 0, errText(rs));
  // never banked
  const withMap = TWO.replace('SPRITE s', 'MAP lvl = "m"\nSPRITE s').replace('TILE 1, 1 = 0', 'LOADMAP lvl');
  const rb = build(withMap, FAKE2, FA, FINE('a'), { bankAll: true });
  check_('bankAll (every MAP in the banked window): the descriptor stays in the mapped game image', rb.errors.length === 0 && (rb.shipped?.length ?? 0) > 0 && (() => { const d = rb.gen.emitter.addressOf('fine$desc'); return d >= 0x8000 && d < 0xC000 && u16(rb.memory, d) === rb.gen.emitter.addressOf('fine$rows'); })(), errText(rb) + ` banked: ${JSON.stringify(rb.gen.bank?.banked?.map((b) => b.name))}`);
  // the phase cap (contract 3a.2 / 6): at most 32 sprite phases in all in a game with a fine scene
  {
    const mkGame = (phs) => {
      const sprites = Object.fromEntries(phs.map((ph, i) => [`p${i}`, { w: 8, h: 2, phases: ph, rows: [{ bits: 'FF', mask: 'FF', ink: 1 }, { bits: 'FF', mask: 'FF', ink: 2 }] }]));
      const src = `GAME "f"\nFRAMERATE 20\n${phs.map((_, i) => `SPRITE s${i} = "p${i}"\n`).join('')}SCENE a\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n${phs.map((_, i) => `    SHOW s${i} AT ${10 + 20 * i}, 10\n`).join('')}  ENDP\nENDSCENE\n`;
      return { src, assets: { sprites } };
    };
    const g32 = mkGame([8, 8, 8, 8]), g33 = mkGame([8, 8, 8, 8, 1]), mixed = mkGame([4, 4, 4, 4, 4, 4, 4, 1]);
    const ok = build(g32.src, FAKE2, g32.assets, FINE('a')), bad = build(g33.src, FAKE2, g33.assets, FINE('a'));
    check_('4 assets x 8 phases = 32: a fine game builds', ok.errors.length === 0 && !!ok.dck, errText(ok));
    eq('33 phases (4 x 8 + 1): the exact error', bad.errors.map((e) => e.message), ['sprite art too large for a fine-colour game: 33 phases, at most 32; use fewer phases']);
    check_('... and no cartridge', bad.dck === null);
    eq('8 assets x 4 phases = 32 builds, and 7 x 4 + 1 = 29 builds: the sum counts every asset', [build(mkGame([4, 4, 4, 4, 4, 4, 4, 4]).src, FAKE2, mkGame([4, 4, 4, 4, 4, 4, 4, 4]).assets, FINE('a')).errors.length, build(mixed.src, FAKE2, mixed.assets, FINE('a')).errors.length], [0, 0]);
    eq('the count is the phases of the assets, not of the instances: an asset of 8 phases used by 4 instances counts 8', build(g32.src.replace('SPRITE s0 = "p0"', 'SPRITE s0(4) = "p0"').replace('SHOW s0 AT 10, 10', 'SHOW s0(0) AT 10, 10'), FAKE2, g32.assets, FINE('a')).errors.length, 0);
    const noFine = build(g33.src, FAKE2, g33.assets), bufOnly = build(g33.src, FAKE2, g33.assets, { a: { display: 'buffers' } });
    check_('the same 33 phases with no fine scene: no error (the cap is for fine games only)', noFine.errors.length === 0 && bufOnly.errors.length === 0, errText(noFine));
    const w = (phs) => { const g = mkGame(phs); return build(g.src, FAKE2, g.assets, FINE('a')).errors.map((e) => e.message); };
    eq('default phases are 8 (an asset without "phases" counts 8): 4 such assets build, 5 give 40', [w([8, 8, 8, 8]).length, w([8, 8, 8, 8, 8])[0]], [0, 'sprite art too large for a fine-colour game: 40 phases, at most 32; use fewer phases']);
  }
  // the call sequence
  eq('two scenes, the first fine: the boot (init_entry), ENTER a, ENTER b = A 1, 1, 0', fineCalls(r), [1, 1, 0]);
  check_('... and those three calls are every reference to the descriptor (the two data words are not)', nFineRefs(r) === 3, `${nFineRefs(r)} references`);
  eq('the second scene fine: no call at the boot, ENTER a gives A = 0, ENTER b A = 1', fineCalls(build(TWO, FAKE2, FA, FINE('b'))), [0, 1]);
  eq('both fine', fineCalls(build(TWO, FAKE2, FA, FINE('a', 'b'))), [1, 1, 1]);
  eq('one scene, fine, no ENTER (no scene driver): only the boot call', fineCalls(build(ONE, FAKE2, FA, FINE('a'))), [1]);
  eq('one scene, fine, ENTER of itself (a driver): the boot call and the ENTER', fineCalls(build(ONE_ENTER, FAKE2, FA, FINE('a'))), [1, 1]);
  const lines = norm(r).split(';'), iEntry = lines.indexOf('L_entry_init:'), iEnter = lines.indexOf('L_scn_enter:');
  eq('the boot call is the first thing in init_entry: `ld a,1;ld hl,L_fine_desc;call RT_FINEMODE` right after the label', lines.slice(iEntry + 1, iEntry + 4), ['ld a,1', 'ld hl,L_fine_desc', `call ${FINEMODE}`]);
  eq('ENTER: after the reset (scn$reset has been called) and the scene\'s own set-up, before the target\'s INIT: scene a gets A = 1, then jumps to its INIT; scene b A = 0, then runs its (empty) INIT',
    [lines.slice(iEnter + 6, iEnter + 13).join(';'), lines.slice(iEnter + 13, iEnter + 18).join(';')],
    [`L_scn_go_0:;or a;jr nz,L_scn_go_1;ld a,1;ld hl,L_fine_desc;call ${FINEMODE};jr L_P_s0_INIT`, `L_scn_go_1:;ld a,0;ld hl,L_fine_desc;call ${FINEMODE};ret`]);
  check_('... and scn$enter calls scn$reset before the dispatch', lines.slice(iEnter + 1, iEnter + 6).join(';') === 'ld sp,(57604);push af;call L_scn_reset;pop af;ld (57602),a');
  // a runtime that knows RT_FINEMODE changes nothing for a game with no fine scene
  const plainReal = build(TWO, REAL[2], FA), plainFake = build(TWO, FAKE2, FA), plainBuf = build(TWO, FAKE2, FA, { a: { display: 'buffers' }, b: { display: 'buffers' } });
  const same = (a, b) => a.dck.length === b.dck.length && a.dck.every((v, i) => v === b.dck[i]);
  check_('no fine scene: the same cartridge with a runtime that has RT_FINEMODE, and with every scene set to buffers; no descriptor label, no call', same(plainReal, plainFake) && same(plainReal, plainBuf) && !/fine/.test(plainFake.gen.emitter.asm()) && fineCalls(plainFake).length === 0);
  // the fine build differs from the plain build only by the descriptor, the calls and what moved by them
  check_('a fine build is bigger than the plain build by exactly the descriptor (4 + 24 + 128 bytes) and three `ld a,n / ld hl,nn / call nn` (8 bytes each)', r.usage.codegen.codeBytes - plainFake.usage.codegen.codeBytes === (4 + 24 + 16 * FAKE2.rt.constants.MAX_ASSETS) + 3 * 8, `${r.usage.codegen.codeBytes - plainFake.usage.codegen.codeBytes}`);
}

// =================================================================================================================
// 6. finePicture
// =================================================================================================================
console.log('\n6. finePicture: the picture of contract section 2');
{
  const blank = () => ({ cells: new Uint8Array(768).fill(32), attrs: new Uint8Array(768).fill(0x38) });
  // glyphs: a font code v (33..127) is eight bytes v, v+1, ... (32, the blank, eight zeros); a tile t is eight bytes 0xA0 + t * 8 + k
  const font = Array.from({ length: 96 }, (_, i) => Array.from({ length: 8 }, (_, k) => (i === 0 ? 0 : (i + 32 + k) & 0xFF)));      // code 32 (a blank cell) is empty
  const tileBytes = new Uint8Array(3 * 9); for (let t = 0; t < 3; t++) for (let k = 0; k < 8; k++) tileBytes[9 * t + k] = (0xA0 + 8 * t + k) & 0xFF;
  const glyph = glyphSource({ font, tileBytes });
  const tileRows = Uint8Array.from([...Array(8).keys()].map((k) => 0x40 | k).concat([...Array(8).keys()].map((k) => 0x08 * (k & 7) | 1), [...Array(8).keys()].map((k) => 0x80 | (k << 3))));
  const pic = (o) => finePicture({ glyph, tileRows, assets: [], instAsset: [], sprites: [], ...blank(), ...o });
  // glyphSource
  eq('glyphSource: a font code, a tile (128 + t), a code outside 32..127 and a tile beyond the tileset', [Array.from(glyph(65)), Array.from(glyph(130)), Array.from(glyph(10)), Array.from(glyph(128 + 3))], [[65, 66, 67, 68, 69, 70, 71, 72], [0xB0, 0xB1, 0xB2, 0xB3, 0xB4, 0xB5, 0xB6, 0xB7], Array(8).fill(0), Array(8).fill(0)]);
  eq('spriteColour: the ink bits are replaced, paper, BRIGHT and FLASH stay', [spriteColour(0xFF, 0), spriteColour(0x38, 5), spriteColour(0x47, 2), spriteColour(0xC1, 7)], [0xF8, 0x3D, 0x42, 0xC7]);
  eq('phaseX: 8 phases keep x, 4 round to even, 2 to a multiple of 4, 1 to a multiple of 8', [13, 14, 15, 0, 7, 239].map((x) => [8, 4, 2, 1].map((p) => phaseX(x, p))), [[13, 12, 12, 8], [14, 14, 12, 8], [15, 14, 12, 8], [0, 0, 0, 0], [7, 6, 4, 0], [239, 238, 236, 232]]);
  // 1. cells
  {
    const c = blank(); c.cells[5 * 32 + 7] = 65; c.attrs[5 * 32 + 7] = 0x47;          // a font cell: attribute on all 8 rows
    c.cells[0] = 128 + 1; c.attrs[0] = 0x3F;                                            // a tile cell: its own attribute byte is not used
    c.cells[31] = 128 + 2; c.cells[767] = 128 + 7;                                      // a tile the table does not hold falls back to the cell attribute
    const p = pic(c);
    check_('a font cell: the glyph rows and its attribute on all 8 colour rows', Array.from({ length: 8 }, (_, k) => p.bits[rowOff(40 + k, 7)] === 65 + k && p.colours[rowOff(40 + k, 7)] === 0x47).every(Boolean));
    check_('a tile cell: the tile bitmap and the tile\'s eight row attributes (not the cell attribute)', Array.from({ length: 8 }, (_, k) => p.bits[rowOff(k, 0)] === 0xA8 + k && p.colours[rowOff(k, 0)] === tileRows[8 + k]).every(Boolean) && tileRows[8] !== 0x3F);
    check_('a tile cell at the last column: its own rows (tile 2)', Array.from({ length: 8 }, (_, k) => p.colours[rowOff(k, 31)] === tileRows[16 + k]).every(Boolean));
    check_('a tile the row table does not hold (tile 7): the cell attribute on all 8 rows; the glyph is blank', Array.from({ length: 8 }, (_, k) => p.colours[rowOff(184 + k, 31)] === 0x38 && p.bits[rowOff(184 + k, 31)] === 0).every(Boolean));
    check_('a blank cell (space, attribute $38): empty glyph, colour $38 on every row', Array.from({ length: 8 }, (_, k) => p.bits[rowOff(8 + k, 3)] === 0 && p.colours[rowOff(8 + k, 3)] === 0x38).every(Boolean));
    const none = pic({ ...c, tileRows: null });
    check_('without a row table every tile cell takes the cell attribute', Array.from({ length: 8 }, (_, k) => none.colours[rowOff(k, 0)] === 0x3F).every(Boolean));
    check_('the pictures are 6144 bytes each and a tile row fills exactly its byte column', p.bits.length === FINE_BYTES && p.colours.length === FINE_BYTES && p.colours[rowOff(0, 1)] === 0x38);
    const ws = pic({ ...c, glyph: (v) => (v === 65 ? [0xFF, 0, 0xFF, 0, 0xFF, 0, 0xFF, 0] : [0, 0, 0, 0, 0, 0, 0, 0]) });
    check_('bits come from the glyph source row by row (ZX layout: row y at the third-of-screen offsets)', ws.bits[0x0000 + rowOff(40, 7)] === 0xFF && ws.bits[rowOff(41, 7)] === 0 && rowOff(40, 7) === 0x0000 + ((40 & 0xC0) << 5 | (40 & 7) << 8 | (40 & 0x38) << 2 | 7));
  }
  // sprites: assets from convertSprite (the interpreter's form)
  const mk = (w, rows, phases = 8) => { const c = convertSprite({ w, h: rows.length, rows }); return { h: c.h, data: c.data, inks: c.inks, phases }; };
  const solid16 = mk(16, [2, 3, 4].map((ink) => ({ bits: 'FFFF', mask: 'FFFF', ink })));
  {
    const c = blank(); c.attrs.fill(0x68);                                              // paper 5, ink 0, BRIGHT 1 everywhere
    const p = pic({ ...c, assets: [solid16], instAsset: [0], sprites: [{ visible: 1, x: 8, y: 16 }] });
    const rows = [0, 1, 2].map((k) => [1, 2, 3].map((j) => [p.bits[rowOff(16 + k, j)], p.colours[rowOff(16 + k, j)]]));
    eq('a 16-wide sprite at x 8: bytes 1 and 2 hold the image and take the row ink (paper and BRIGHT stay the background\'s); byte 3 untouched', rows.map((r) => r.map(([b, col]) => [b.toString(16), col.toString(16)])),
      [[['ff', '6a'], ['ff', '6a'], ['0', '68']], [['ff', '6b'], ['ff', '6b'], ['0', '68']], [['ff', '6c'], ['ff', '6c'], ['0', '68']]].map((r) => r));
    check_('rows below the art (row 3 of a 3-row sprite) and the byte left of it are not touched', p.colours[rowOff(19, 1)] === 0x68 && p.bits[rowOff(19, 1)] === 0 && p.colours[rowOff(16, 0)] === 0x68);
  }
  {   // the mask-$FF rule: an 8-wide sprite aligned on a byte covers one byte only; the second byte of its window keeps its colour
    const c = blank(); c.attrs.fill(0x39);                                              // ink 1, paper 7
    const half = mk(8, [{ bits: 'FF', mask: 'FF', ink: 4 }]);
    const p = pic({ ...c, assets: [half], instAsset: [0], sprites: [{ visible: 1, x: 8, y: 0 }] });
    eq('an 8-wide aligned sprite: window bytes 1 (covered) and 2 (mask $FF): only byte 1 is recoloured', [p.colours[rowOff(0, 1)], p.colours[rowOff(0, 2)], p.bits[rowOff(0, 2)]], [0x3C, 0x39, 0]);
    const q = pic({ ...c, assets: [half], instAsset: [0], sprites: [{ visible: 1, x: 11, y: 0 }] });
    eq('shifted by 3: both bytes of the window are covered and recoloured, the third (mask $FF) is not', [1, 2, 3].map((j) => q.colours[rowOff(0, j)].toString(16)), ['3c', '3c', '39']);
    check_('... and the pixels: 0xFF >> 3 = $1F in byte 1, $E0 in byte 2', q.bits[rowOff(0, 1)] === 0x1F && q.bits[rowOff(0, 2)] === 0xE0, `${q.bits[rowOff(0, 1)].toString(16)} ${q.bits[rowOff(0, 2)].toString(16)}`);
    const holes = mk(16, [{ bits: 'FF00', mask: 'FF00', ink: 6 }]);                    // covers the left byte only
    const h = pic({ ...c, assets: [holes], instAsset: [0], sprites: [{ visible: 1, x: 16, y: 0 }] });
    eq('a transparent right half (mask byte $FF): its byte keeps colour and bits', [h.colours[rowOff(0, 2)], h.colours[rowOff(0, 3)], h.bits[rowOff(0, 3)]], [0x3E, 0x39, 0]);
    const bg = blank(); bg.cells[3] = 65;                                              // a star next to a sprite whose mask is $FF there keeps its glyph bits too
    const star = pic({ ...bg, assets: [holes], instAsset: [0], sprites: [{ visible: 1, x: 16, y: 0 }] });
    check_('the bitmap of an uncovered byte is the background\'s ((s AND $FF) OR 0)', star.bits[rowOff(0, 3)] === 65 && star.colours[rowOff(0, 3)] === 0x38);
  }
  {   // masks: a hole in the middle keeps the background bits; a bit set under the mask is hidden by it
    const c = blank(); c.cells[1] = 66;
    const ring = mk(16, [{ bits: 'F00F', mask: 'FFFF', ink: 1 }]);
    const p = pic({ ...c, assets: [ring], instAsset: [0], sprites: [{ visible: 1, x: 0, y: 0 }] });
    check_('image bits are drawn, the rest is "screen AND mask OR image": mask 0 where the sprite covers, so uncovered pixels keep the glyph', p.bits[rowOff(0, 1)] === (66 & 0x00 | 0x0F) && p.bits[rowOff(0, 0)] === (32 & 0 | 0xF0), `${p.bits[rowOff(0, 1)].toString(16)}`);
  }
  {   // overlap order: instance order, a later one lies on top, its ink wins on a shared byte
    const c = blank(); c.attrs.fill(0x38);
    const a0 = mk(8, [{ bits: 'F0', mask: 'F0', ink: 2 }]), a1 = mk(8, [{ bits: '3C', mask: '3C', ink: 5 }]);
    const p = pic({ ...c, assets: [a0, a1], instAsset: [0, 1], sprites: [{ visible: 1, x: 16, y: 8 }, { visible: 1, x: 16, y: 8 }] });
    const q = pic({ ...c, assets: [a0, a1], instAsset: [1, 0], sprites: [{ visible: 1, x: 16, y: 8 }, { visible: 1, x: 16, y: 8 }] });
    eq('instance order: a0 then a1 over it: bits = (((bg & m0) | i0) & m1) | i1, the ink of the later one', [p.bits[rowOff(8, 2)], p.colours[rowOff(8, 2)] & 7], [(((0 & 0x0F) | 0xF0) & 0xC3) | 0x3C, 5]);
    eq('swapped order: the other ink wins and the bits differ', [q.bits[rowOff(8, 2)], q.colours[rowOff(8, 2)] & 7], [(((0 & 0xC3) | 0x3C) & 0x0F) | 0xF0, 2]);
    const r = pic({ ...c, assets: [a0, a1], instAsset: [0, 1], sprites: [{ visible: 1, x: 16, y: 8 }, { visible: 0, x: 16, y: 8 }] });
    eq('an invisible sprite is not drawn (and does not recolour)', [r.bits[rowOff(8, 2)], r.colours[rowOff(8, 2)] & 7], [0xF0, 2]);
    const s = pic({ ...c, assets: [a0, a1], sprites: [{ visible: 1, x: 16, y: 8, asset: 1 }] });
    eq('a sprite record that names its asset (V3 records) needs no instAsset', [s.bits[rowOff(8, 2)], s.colours[rowOff(8, 2)] & 7], [0x3C, 5]);
    check_('a missing asset (null) draws nothing', pic({ ...c, assets: [null], instAsset: [0], sprites: [{ visible: 1, x: 16, y: 8 }] }).bits.every((v) => v === 0));
  }
  {   // phase rounding: x is rounded down to the asset's granularity before the blit
    const c = blank();
    const dot = (phases) => mk(8, [{ bits: '80', mask: '80', ink: 3 }], phases);
    const bitAt = (p, x, y) => (p.bits[rowOff(y, x >> 3)] >> (7 - (x & 7))) & 1;
    const at = (phases, x) => { const p = pic({ ...c, assets: [dot(phases)], instAsset: [0], sprites: [{ visible: 1, x, y: 0 }] }); for (let k = 0; k < 40; k++) if (bitAt(p, k, 0)) return k; return -1; };
    eq('the lit pixel is at x rounded down: 8 phases 13 -> 13, 4 -> 12, 2 -> 12, 1 -> 8; x 15: 15 / 14 / 12 / 8', [13, 15].map((x) => [8, 4, 2, 1].map((ph) => at(ph, x))), [[13, 12, 12, 8], [15, 14, 12, 8]]);
    eq('a sprite at 4 phases and an odd x draws like the even one below it (same pictures)', JSON.stringify(Array.from(pic({ ...c, assets: [dot(4)], instAsset: [0], sprites: [{ visible: 1, x: 21, y: 40 }] }).bits)) === JSON.stringify(Array.from(pic({ ...c, assets: [dot(4)], instAsset: [0], sprites: [{ visible: 1, x: 20, y: 40 }] }).bits)), true);
  }
  {   // edges: the last columns and rows, and nothing written outside the screen
    const c = blank();
    const sq = mk(16, Array.from({ length: 16 }, (_, k) => ({ bits: 'FFFF', mask: 'FFFF', ink: 1 + (k & 3) })));
    const at239 = pic({ ...c, assets: [sq], instAsset: [0], sprites: [{ visible: 1, x: 239, y: 176 }] });
    check_('x 239, y 176 (the last position SHOW allows): bytes 29, 30, 31 of rows 176..191 are drawn with the rows\' inks; byte 28 is not', [0, 5, 15].every((k) => at239.colours[rowOff(176 + k, 31)] === (0x38 & 0xF8 | 1 + (k & 3)) && at239.bits[rowOff(176 + k, 31)] === 0xFE) && at239.colours[rowOff(176, 28)] === 0x38 && at239.bits[rowOff(176, 29)] === 0x01);
    const off = pic({ ...c, assets: [sq], instAsset: [0], sprites: [{ visible: 1, x: 250, y: 190 }] });
    const ref = pic({ ...c });
    check_('x 250: only byte column 31 exists; nothing spills into the next pixel row; rows past 191 are not drawn', off.bits[rowOff(190, 31)] === 0x3F && off.bits[rowOff(190, 0)] === ref.bits[rowOff(190, 0)] && off.bits[rowOff(191, 0)] === ref.bits[rowOff(191, 0)] && off.bits[rowOff(0, 0)] === ref.bits[rowOff(0, 0)] && off.bits.length === FINE_BYTES);
    const neg = pic({ ...c, assets: [sq], instAsset: [0], sprites: [{ visible: 1, x: 0, y: -3 }] });
    check_('y -3: rows 0..12 of the art are drawn (art rows 3..15), the first three are cut', neg.colours[rowOff(0, 0)] === (0x38 & 0xF8 | 1 + (3 & 3)) && neg.bits[rowOff(0, 0)] === 0xFF);
  }
  // a random comparison with a per-pixel reference: what a pixel-by-pixel blit does, the colour of a byte changed iff any of its pixels is covered
  {
    let s = 0x1234567; const rnd = () => { s = (Math.imul(s, 1103515245) + 12345) & 0x7FFFFFFF; return s >>> 8; };
    let bad = '', cases = 0;
    for (let n = 0; n < 400 && !bad; n++) {
      const nA = 1 + (rnd() % 3), assets = [];
      for (let a = 0; a < nA; a++) {
        const w = [8, 16, 5, 12][rnd() % 4], h = 1 + (rnd() % 16), phases = [8, 4, 2, 1][rnd() % 4];
        const rows = Array.from({ length: h }, () => { const full = (1 << w) - 1, cover = rnd() % 5 === 0 ? 0 : rnd() % 4 === 0 ? full : rnd() & full; return { bits: (rnd() & cover).toString(16), mask: cover.toString(16), ink: rnd() & 7 }; });
        assets.push(mk(w, rows, phases));
      }
      const c = blank(); for (let i = 0; i < 768; i++) { c.cells[i] = rnd() % 3 ? 32 + (rnd() % 96) : 128 + (rnd() % 3); c.attrs[i] = rnd() & 0xFF; }
      const nS = 1 + (rnd() % 6), sprites = Array.from({ length: nS }, () => ({ visible: rnd() % 5 ? 1 : 0, x: rnd() % 240, y: rnd() % 177 }));
      const instAsset = sprites.map(() => rnd() % nA);
      const got = pic({ ...c, assets, instAsset, sprites });
      // the reference
      const bits = new Uint8Array(6144), cols = new Uint8Array(6144), P = (y, x) => rowOff(y, x >> 3);
      for (let r = 0; r < 24; r++) for (let cc = 0; cc < 32; cc++) { const v = c.cells[r * 32 + cc], g = glyph(v); for (let k = 0; k < 8; k++) { bits[rowOff(8 * r + k, cc)] = g[k]; cols[rowOff(8 * r + k, cc)] = v >= 128 && v - 128 < 3 ? tileRows[8 * (v - 128) + k] : c.attrs[r * 32 + cc]; } }
      sprites.forEach((sp, i) => {
        if (!sp.visible) return;
        const a = assets[instAsset[i]];
        const x0 = sp.x - (sp.x % (8 / a.phases));
        for (let k = 0; k < a.h; k++) {
          const y = sp.y + k; if (y > 191) continue;
          const mask = (a.data[4 * k] << 8) | a.data[4 * k + 1], image = (a.data[4 * k + 2] << 8) | a.data[4 * k + 3];
          const touched = new Set();
          for (let b = 0; b < 16; b++) {
            const x = x0 + b; if (x > 255) continue;
            if ((mask >> (15 - b)) & 1) { if ((image >> (15 - b)) & 1) bits[P(y, x)] |= 0x80 >> (x & 7); continue; }   // (image bits are 0 under mask 1 in converted art)
            touched.add(x >> 3);
            if ((image >> (15 - b)) & 1) bits[P(y, x)] |= 0x80 >> (x & 7); else bits[P(y, x)] &= ~(0x80 >> (x & 7));
          }
          for (const col of touched) cols[rowOff(y, col)] = (cols[rowOff(y, col)] & 0xF8) | a.inks[k];
        }
      });
      cases++;
      for (let i = 0; i < 6144; i++) if (got.bits[i] !== bits[i] || got.colours[i] !== cols[i]) { bad = `case ${n}: offset ${i}: bits ${got.bits[i].toString(16)}/${bits[i].toString(16)}, colour ${got.colours[i].toString(16)}/${cols[i].toString(16)}`; break; }
    }
    check_(`${cases} random scenes (cells, tiles, up to 6 sprites of random width / height / phases / masks / inks at random positions): the picture equals a per-pixel reference`, bad === '', bad);
  }
}

// =================================================================================================================
// 7. the interpreter
// =================================================================================================================
console.log('\n7. the interpreter: the fine key');
{
  const ast = parse(TWO).ast;
  const font = Array.from({ length: 96 }, (_, i) => Array(8).fill(i));
  const run = interpret(ast, { ticks: 4, assets: FA, scenes: FINE('a'), version: 2 });
  eq('the records say whether a fine scene is showing: INIT and tick 1 in scene a, then ENTER b (tick 2 on): false', [run.init.fine, ...run.ticks.map((t) => t.fine)], [true, true, false, false, false]);
  check_('the result has `fine`: the scenes, the tiles\' row attributes and bytes, the assets (h, data, inks, phases) and the instance -> asset table', JSON.stringify(Object.keys(run.fine)) === '["scenes","tileRows","tileBytes","assets","instAsset"]' && JSON.stringify(run.fine.scenes) === '[true,false]' && Array.from(run.fine.tileRows).join() === Array.from(convertTileset(FA.tilesets.ts).rowAttrs).join() && run.fine.assets[0].h === 4 && run.fine.assets[0].inks.join() === '2,3,4,5,0,0,0,0,0,0,0,0,0,0,0,0' && run.fine.assets[0].phases === 8 && run.fine.instAsset.join() === '0');
  const p = fineOfRun(run, run.ticks[0], font);
  const ts = convertTileset(FA.tilesets.ts);
  const sx = run.ticks[0].sprites[0].x, sy = run.ticks[0].sprites[0].y;
  check_('fineOfRun: the tile cell at (1, 1) shows the tile\'s own row attributes (pixel rows 8, 9, 14, 15 are not under the sprite)', p && [0, 1, 6, 7].every((k) => p.colours[rowOff(8 + k, 1)] === ts.rowAttrs[k]) && sx === 11 && sy === 10);
  check_('the sprite (4 rows, inks 2..5) over it: ink replaced row by row, paper and BRIGHT are the tile row\'s, in both bytes of its window; the byte on its right (mask $FF) keeps the cell colour', [0, 1, 2, 3].every((k) => [1, 2].every((j) => p.colours[rowOff(sy + k, j)] === ((j === 1 ? ts.rowAttrs[2 + k] : 0x38) & 0xF8 | 2 + k))) && p.colours[rowOff(sy, 3)] === 0x38);
  eq('a record of the other scene has no fine picture; neither has a run without fine scenes', [fineOfRun(run, run.ticks[2], font), fineOfRun(interpret(ast, { ticks: 2, assets: FA, version: 2 }), run.ticks[0], font)], [null, null]);
  // every other program: records and result unchanged
  const plain = interpret(ast, { ticks: 4, assets: FA, version: 2 });
  check_('no scenes option: no `fine` key anywhere (records and result)', !('fine' in plain) && [plain.init, ...plain.ticks].every((r) => !('fine' in r)));
  const bufs = interpret(ast, { ticks: 4, assets: FA, scenes: { a: { display: 'buffers' }, b: { display: 'hires' } }, version: 2 });
  check_('scenes with no fine scene: the whole result is identical to the one without', JSON.stringify(bufs) === JSON.stringify(plain));
  const v3 = interpret(ast, { ticks: 4, assets: FA, scenes: FINE('a'), version: 3 });
  check_('a fine setting in a game for runtime v3 (the compiler refuses it): no fine records either', !('fine' in v3) && !('fine' in v3.init));
  const w = interpret(parse(WIREG).ast, { ticks: 2, assets: WIREA, scenes: FINE('x'), version: 2 });
  check_('... nor in a WIRE3D game', !('fine' in w) && !('fine' in w.ticks[0]));
  eq('the fine run\'s records equal the plain run\'s apart from the `fine` key', [run.init, ...run.ticks].map((r) => { const { fine, ...rest } = r; return JSON.stringify(rest); }), [plain.init, ...plain.ticks].map((r) => JSON.stringify(r)));
  const { fine: _f, init: _i, ticks: _t, ...restRun } = run, { init: _pi, ticks: _pt, ...restPlain } = plain;
  check_('... and the other keys of the result too', JSON.stringify(restRun) === JSON.stringify(restPlain));
}

// =================================================================================================================
// 8. byte identity
// =================================================================================================================
console.log('\n8. byte identity: a program without a fine scene compiles to the bytes it had before');
{
  const RT = {}, rtSha = {};
  for (const v of [2, 3, 4]) { RT[v] = REAL[v]; rtSha[v] = sha(REAL[v].image); }
  const hashOf = (r) => (r.errors.length ? 'error:' + sha(JSON.stringify(r.errors)).slice(0, 16) : sha(r.dck).slice(0, 32) + ':' + sha(r.memory).slice(0, 32));
  const programs = [];
  for (const dir of ['arcade/examples', 'arcade/tests/fixtures']) for (const f of readdirSync(join(ROOT, dir))) {
    if (!f.endsWith('.arc')) continue;
    const base = f.replace(/\.arc$/, '');
    const ap = [`${base}.assets.json`, `${base.replace(/-.*$/, '')}.assets.json`].map((a) => join(ROOT, dir, a)).find((q) => existsSync(q)) ?? join(ROOT, 'arcade/examples', `${base.replace(/-.*$/, '')}.assets.json`);
    programs.push({ key: `${dir}/${f}`, text: readFileSync(join(ROOT, dir, f), 'utf8'), assets: existsSync(ap) ? JSON.parse(readFileSync(ap, 'utf8')) : {} });
  }
  const all = {};
  for (const pr of programs) for (const v of [2, 3, 4]) for (const bankAll of [false, true]) all[`${pr.key} v${v}${bankAll ? ' bankAll' : ''}`] = hashOf(compile(pr.text, { runtime: RT[v].rt, image: RT[v].image, assets: pr.assets, ...(bankAll ? { bankAll } : {}) }));
  if (process.argv.includes('--write-baseline')) {
    writeFileSync(BASELINE, JSON.stringify({ about: 'sha256 prefixes (dck:memory) of every example and fixture compiled by the compiler before fine colour (F3), against the runtimes whose runtime.bin hashes are in runtimeSha; regenerate with: node tests/arcade-m19-compiler.mjs --write-baseline (only from a compiler known to be unchanged for programs without a fine scene)', runtimeSha: rtSha, builds: all }, null, 1) + '\n');
    console.log(`  wrote ${BASELINE}`);
  } else if (!existsSync(BASELINE)) skip_('hashes of the compiler before fine colour', `${BASELINE} is missing`);
  else {
    const base = JSON.parse(readFileSync(BASELINE, 'utf8'));
    const stale = [2, 3, 4].filter((v) => base.runtimeSha[v] !== rtSha[v]);
    if (stale.length) skip_('hashes of the compiler before fine colour', `the runtime v${stale.join(' / v')} build differs from the one the hashes were taken against (run the old-compiler comparison: ARCADE_M19_OLD=<ref>, or arcade/tools/regen-baselines.mjs --old <ref>)`);
    else {
      const bad = Object.keys(base.builds).filter((k) => all[k] !== base.builds[k]);
      const built = Object.values(all).filter((h) => !h.startsWith('error')).length;
      check_(`${Object.keys(all).length} compilations of every example and fixture on v2 / v3 / v4 (${built} built a cartridge): DCK and memory image identical to the compiler before fine colour`, bad.length === 0 && Object.keys(base.builds).length === Object.keys(all).length && built >= 40, bad.slice(0, 4).join('; ') || `${built} builds`);
    }
  }
  // every v2 program again with a runtime that has RT_FINEMODE and every scene set to buffers: nothing moves
  let moved = '', n = 0;
  for (const pr of programs) {
    const names = [...pr.text.matchAll(/^\s*SCENE\s+(\w+)/gim)].map((m) => m[1]);
    const a = compile(pr.text, { runtime: REAL[2].rt, image: REAL[2].image, assets: pr.assets });
    const b = compile(pr.text, { runtime: FAKE2.rt, image: FAKE2.image, assets: pr.assets, scenes: Object.fromEntries(names.map((nm) => [nm, { display: 'buffers' }])) });
    n++;
    if (hashOf(a) !== hashOf(b)) moved += `${pr.key}; `;
  }
  check_(`${n} programs on v2: the same bytes with RT_FINEMODE in the symbol table and every scene set to "buffers"`, moved === '', moved);
  // optional: the compiler of a git ref (a baseline taken against another runtime build)
  const ref = process.env.ARCADE_M19_OLD;
  if (ref) {
    let tmp = null, oldCompile = null;
    try {
      tmp = mkdtempSync(join(tmpdir(), 'm19old-'));
      execFileSync('sh', ['-c', `git -C "${ROOT}" archive ${ref} src | tar -x -C "${tmp}"`], { stdio: 'ignore' });
      ({ compile: oldCompile } = await import(pathToFileURL(join(tmp, 'src/lang/arcade/arcade-compile.js')).href));
    } catch (e) { oldCompile = null; skip_(`byte identity with ${ref}`, e.message.split('\n')[0]); }
    if (oldCompile) {
      let diff = '', cnt = 0;
      for (const pr of programs) for (const v of [2, 3, 4]) {
        const a = oldCompile(pr.text, { runtime: RT[v].rt, image: RT[v].image, assets: pr.assets }), b = compile(pr.text, { runtime: RT[v].rt, image: RT[v].image, assets: pr.assets });
        cnt++;
        if (hashOf(a) !== hashOf(b)) diff += `${pr.key} v${v}; `;
      }
      check_(`${cnt} compilations equal those of the compiler of ${ref}`, diff === '', diff);
    }
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}

// =================================================================================================================
// 9. boundaries (the cases arcade/tests/m19c-mutations.mjs needs: a bug in each of them passed every check above)
// =================================================================================================================
console.log('\n9. boundaries: ink range, glyph source, sprite window, generator refusals, interpreter, arcadec precedence');
{
  const bad = (f) => { try { f(); return 'no error'; } catch (e) { return e.message; } };
  // -- assets
  eq('tileRowAttrs of a tile with no rows (or no tile): the defaults, nothing throws', [Array.from(tileRowAttrs(undefined)), Array.from(tileRowAttrs({}))], [Array(8).fill(0x38), Array(8).fill(0x38)]);
  const two = convertTileset({ tiles: [{ rows: Array.from({ length: 8 }, (_, k) => ({ bits: 1, ink: k === 4 ? 9 : 1 })) }, { rows: Array.from({ length: 8 }, (_, k) => ({ bits: 1, ink: k === 2 ? 9 : 1 })) }] });
  eq('two tiles with a bad row: the first one in tile order is the one reported', two.rowAttrsProblem, 'tile 0 row 4 ink must be a whole number 0..7, got 9');
  // -- convertSprite inks
  const ink = (v) => { const c = convertSprite({ w: 8, h: 1, rows: [{ bits: 1, ink: v }] }); return [c.inks[0], c.inkProblem]; };
  eq('ink 0 and 7 are fine; 8, -1 and 1.5 are refused (the ink is then 0 & 7 = 0, 7 and 7 for the fraction)', [ink(0), ink(7), ink(8), ink(-1), ink(1.5)],
    [[0, null], [7, null], [0, 'row 0 ink must be a whole number 0..7, got 8'], [7, 'row 0 ink must be a whole number 0..7, got -1'], [7, 'row 0 ink must be a whole number 0..7, got 1.5']]);
  eq('ink null is the default 7 (JSON null), not a problem', ink(null), [7, null]);
  eq('two bad rows: the first is the one reported; a bad ink is cut with & 7', (() => { const c = convertSprite({ w: 8, h: 3, rows: [{ bits: 1, ink: 2 }, { bits: 1, ink: 11 }, { bits: 1, ink: 13 }] }); return [c.inkProblem, Array.from(c.inks.slice(0, 3))]; })(), ['row 1 ink must be a whole number 0..7, got 11', [2, 3, 5]]);
  // -- arcade-fine.js
  eq('phaseX: the default is 8 phases (x is kept)', [phaseX(13), phaseX(15), phaseX(1)], [13, 15, 1]);
  eq('spriteColour: the ink is cut to 3 bits (an ink of 9 is 1, not 9)', [spriteColour(0x00, 9), spriteColour(0xC0, 0xFF), spriteColour(0x47, 0x0A)], [1, 0xC7, 0x42]);
  const zeros = Array(8).fill(0);
  const font = Array.from({ length: 96 }, (_, i) => Array.from({ length: 8 }, (_, k) => (i + 1) & 0xFF));              // every code has a non-empty glyph: code c is the byte c - 31
  const tb70 = new Uint8Array(70 * 9); for (let t = 0; t < 70; t++) for (let k = 0; k < 8; k++) tb70[9 * t + k] = (t * 3 + k + 1) & 0xFF;
  const g70 = glyphSource({ font, tileBytes: tb70 });
  eq('glyphSource: code 32 and 127 are the font\'s first and last glyph, 31 and 0 are blank', [Array.from(g70(32)), Array.from(g70(127)), Array.from(g70(31)), Array.from(g70(0))], [Array(8).fill(1), Array(8).fill(96), zeros, zeros]);
  eq('glyphSource: tile 64 and tile 127 (the index is v AND $7F, not AND $3F)', [Array.from(g70(128 + 64)), Array.from(g70(128 + 69))], [Array.from({ length: 8 }, (_, k) => (64 * 3 + k + 1) & 0xFF), Array.from({ length: 8 }, (_, k) => (69 * 3 + k + 1) & 0xFF)]);
  eq('glyphSource: tile 70 (beyond the 70 tiles) is blank', Array.from(g70(128 + 70)), zeros);
  eq('glyphSource: no tile bytes: a tile cell is blank (an array of 8 zeros)', glyphSource({ font })(130), zeros);
  eq('glyphSource: a font of 10 glyphs: code 60 is blank, code 41 (index 9) is the font\'s', [glyphSource({ font: font.slice(0, 10) })(60), Array.from(glyphSource({ font: font.slice(0, 10) })(41))], [zeros, Array(8).fill(10)]);
  eq('glyphSource: a tile whose bitmap is the last 8 bytes of the table (no attribute byte after it) is still read', Array.from(glyphSource({ font, tileBytes: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]) })(128)), [1, 2, 3, 4, 5, 6, 7, 8]);
  const blank = () => ({ cells: new Uint8Array(768).fill(32), attrs: new Uint8Array(768).fill(0x38) });
  const row = (ink_, bits = 'FFFF', mask = 'FFFF') => ({ bits, mask, ink: ink_ });
  const mk = (w, rows, phases) => { const c = convertSprite({ w, h: rows.length, rows }); return { h: c.h, data: c.data, inks: c.inks, ...(phases === undefined ? {} : { phases }) }; };
  const A1 = mk(16, [row(1), row(1)]), A6 = mk(16, [row(6), row(6)]);
  const pic = (o) => finePicture({ glyph: g70, tileRows: null, assets: [], instAsset: [], sprites: [], ...blank(), ...o });
  const inkAt = (p, y, c) => p.colours[rowOff(y, c)] & 7;
  check_('a sprite record\'s own `asset` wins over instAsset; instAsset serves a record without one', (() => { const p = pic({ assets: [A1, A6], instAsset: [0, 0], sprites: [{ visible: 1, x: 0, y: 0, asset: 1 }, { visible: 1, x: 64, y: 0 }] }); return inkAt(p, 0, 0) === 6 && inkAt(p, 0, 8) === 1; })());
  check_('an absent sprite record (null) is skipped, the next one is drawn', (() => { const p = pic({ assets: [A1], instAsset: [0, 0], sprites: [null, { visible: 1, x: 0, y: 0 }] }); return inkAt(p, 0, 0) === 1; })());
  check_('an asset without `phases` is drawn as 8 phases: x 5 is kept (a 4-phase sprite would be at 4)', (() => { const a = mk(16, [{ bits: '8000', mask: 'FFFF', ink: 1 }]); const p = pic({ assets: [a], instAsset: [0], sprites: [{ visible: 1, x: 5, y: 0 }] }); return p.bits[rowOff(0, 0)] === 0x04 && pic({ assets: [{ ...a, phases: 4 }], instAsset: [0], sprites: [{ visible: 1, x: 5, y: 0 }] }).bits[rowOff(0, 0)] === 0x08; })());
  check_('a sprite entirely above the screen (y -67, 6 rows: rows -67..-62) draws nothing (a negative pixel row must not wrap into the third below)', (() => { const a = mk(16, Array.from({ length: 6 }, () => row(2))); const p = pic({ assets: [a], instAsset: [0], sprites: [{ visible: 1, x: 0, y: -67 }] }); const q = pic({}); return p.bits.every((v, i) => v === q.bits[i]) && p.colours.every((v, i) => v === q.colours[i]); })());
  check_('the blit is (bits AND mask) OR image over a kept background: an image bit over a set background bit stays set (not XOR)', (() => {
    const a = { h: 1, data: Uint8Array.from([0xFF, 0xFF, 0xFF, 0xFF]), inks: Uint8Array.from([3, ...Array(15).fill(0)]), phases: 8 };      // hand-made: mask all ones AND image all ones
    const p = pic({ assets: [a], instAsset: [0], sprites: [{ visible: 1, x: 0, y: 0 }], glyph: () => Array(8).fill(0xFF) });
    return p.bits[rowOff(0, 0)] === 0xFF && p.bits[rowOff(0, 1)] === 0xFF;
  })());
  // fineOfRun with a tile cell: the tile's bitmap comes from run.fine.tileBytes
  check_('fineOfRun draws a tile cell\'s bitmap from the run\'s tileBytes and its colours from tileRows', (() => {
    const run = { fine: { tileRows: Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 1]), tileBytes: Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2, 0x38]), assets: [], instAsset: [] } };
    const rec = { fine: true, cells: new Uint8Array(768).fill(32), attrs: new Uint8Array(768).fill(0x38), sprites: [] }; rec.cells[0] = 128;
    const p = fineOfRun(run, rec, font);
    return Array.from({ length: 8 }, (_, k) => p.bits[rowOff(k, 0)] === 9 - k && p.colours[rowOff(k, 0)] === run.fine.tileRows[k]).every(Boolean);
  })());

  // -- the compiler: no runtime image, a reason without a word
  const nort = compile(TWO, { assets: FA, scenes: FINE('a') });
  eq('a fine setting with no runtime image: the usual "no runtime image" error, no crash', nort.errors.map((e) => e.message.slice(0, 23)), ['no runtime image: build']);
  const wideA = { ...FA, sprites: { ...FA.sprites, wide: { w: 24, h: 4, rows: [1, 2, 3, 4].map(() => ({ bits: 'FFFFFF', ink: 1 })) } } };
  const wideSrc = ONE.replace('SPRITE s = "sp"', 'SPRITE s = "wide"');
  eq('a v3 game for a reason that is not a word (a 24-pixel sprite): "built for runtime v3", no word named', build(wideSrc, REAL[3], wideA, FINE('a')).errors.map((e) => e.message), ["scene 'a': fine colour (display 'fine') needs runtime v2; this game is built for runtime v3"]);

  // -- the generator's own refusals and records (compile() never lets these cases through, so generate() is called directly with the plan's flags)
  const gen = (src, R, assets, fine) => generate(parse(src).ast, R.rt, assets, { fine });
  const WR = withWire(FAKE2);
  const gMsg = (g) => (g.errors ?? []).map((e) => `${e.line}:${e.message}`);
  const NEED = 'fine colour needs the v2 runtime and no WIRE3D';
  const v3fake = { ...REAL[3], rt: { ...REAL[3].rt, symbols: { ...REAL[3].rt.symbols, RT_FINEMODE: FINEMODE } } }, v4fake = { ...REAL[4], rt: { ...REAL[4].rt, symbols: { ...REAL[4].rt.symbols, RT_FINEMODE: FINEMODE } } };
  eq('generate with a fine scene for a v3 runtime, a v4 runtime and a WIRE3D game: the same error, on the first fine scene (the second scene, line of SCENE b)',
    [gen(TWO, v3fake, FA, [false, true]), gen(TWO, v4fake, FA, [false, true]), gen(WIREG, WR, WIREA, [true])].map((g) => gMsg(g).filter((m) => m.endsWith(NEED)).map((m) => m.split(':')[0]).join()),
    [String(lineOf(TWO, 'SCENE b')), String(lineOf(TWO, 'SCENE b')), String(lineOf(WIREG, 'SCENE x'))]);
  const v1fake = { ...FAKE2, rt: { ...FAKE2.rt, version: 1 } };
  check_('generate with a fine scene for a runtime of version 1: the same error (fine colour is v2 only)', gMsg(gen(TWO, v1fake, FA, [true, false])).some((m) => m.endsWith(NEED)), gMsg(gen(TWO, v1fake, FA, [true, false])).join(' | '));
  check_('generate with a fine scene for a plain v2 game: no such error', !gMsg(gen(TWO, FAKE2, FA, [true, false])).some((m) => m.endsWith(NEED)), gMsg(gen(TWO, FAKE2, FA, [true, false])).join(' | '));
  const s2 = { ...FA, sprites: { sp: { ...FA.sprites.sp, rows: FA.sprites.sp.rows.map((r) => ({ ...r, ink: 9 })) }, big: { ...FA.sprites.big, rows: FA.sprites.big.rows.map((r) => ({ ...r, ink: -1 })) } } };
  const src2 = ONE.replace('SPRITE s = "sp"', 'SPRITE s = "sp"\nSPRITE g = "big"').replace('SHOW s AT 10, 10', 'SHOW s AT 10, 10\n    SHOW g AT 50, 50');
  eq('two sprites with a bad ink in a fine game: both are reported, each at its own SPRITE line, with the first bad row', build(src2, FAKE2, s2, FINE('a')).errors.map((e) => `${e.line}:${e.message}`),
    [`${lineOf(src2, 'SPRITE s')}:sprite "sp": row 0 ink must be a whole number 0..7, got 9`, `${lineOf(src2, 'SPRITE g')}:sprite "big": row 0 ink must be a whole number 0..7, got -1`]);
  check_('a bad ink with no fine scene is no error', build(src2, FAKE2, s2).errors.length === 0 && build(src2, FAKE2, s2, { a: { display: 'buffers' } }).errors.length === 0);
  const g1 = build(TWO, FAKE2, FA, FINE('a')), desc1 = g1.gen.emitter.addressOf('fine$desc');
  eq('the generator\'s `fine` record: the per-scene flags and the descriptor address', g1.gen.fine, { scenes: [true, false], descAt: desc1 });
  check_('no tileset: no row table label in the image; no sprites: no ink table label (the pointers are 0)', !/fine_rows/.test(build(`GAME "f"\nFRAMERATE 20\nSPRITE s = "sp"\nSCENE a\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n    SHOW s AT 10, 10\n  ENDP\nENDSCENE\n`, FAKE2, FA, FINE('a')).gen.emitter.asm())
    && !/fine_inks/.test(build(`GAME "f"\nFRAMERATE 20\nTILESET ts = "ts"\nSCENE a\n  PROC INIT():\n    TILE 1, 1 = 0\n  ENDP\n  PROC FRAME():\n  ENDP\nENDSCENE\n`, FAKE2, FA, FINE('a')).gen.emitter.asm()));

  // -- the interpreter
  const ast = parse(TWO).ast;
  const rNo = interpret(ast, { ticks: 2, assets: FA, scenes: FINE('a') });
  check_('interpret without `version` is a game for runtime v2: the fine record and result are there', !!rNo.fine && rNo.init.fine === true, JSON.stringify(Object.keys(rNo)));
  eq('the result\'s tileBytes are the tileset\'s bytes (9 per tile) and its tileRows the row attributes', [Array.from(rNo.fine.tileBytes), Array.from(rNo.fine.tileRows)], [Array.from(convertTileset(FA.tilesets.ts).bytes), Array.from(convertTileset(FA.tilesets.ts).rowAttrs)]);
  const wideRun = interpret(parse(ONE.replace('SPRITE s = "sp"', 'SPRITE s = "wide"')).ast, { ticks: 1, assets: wideA, scenes: FINE('a'), version: 2 });
  eq('an asset convertSprite cannot read (24 pixels wide): its entry is null, the run still goes', [wideRun.fine.assets, wideRun.fine.instAsset], [[null], [0]]);

  // -- arcadec: --scenes replaces the assets file's scenes as a whole (no merging)
  const tmp = mkdtempSync(join(tmpdir(), 'm19-cli2-'));
  try {
    const rtDir = join(tmp, 'rt'); mkdirSync(rtDir);
    writeFileSync(join(rtDir, 'runtime.json'), JSON.stringify(FAKE2.rt));
    copyFileSync(join(REAL[2].dir, REAL[2].rt.image ?? 'runtime.bin'), join(rtDir, REAL[2].rt.image ?? 'runtime.bin'));
    const src = join(tmp, 'g.arc'); writeFileSync(src, TWO);
    const put = (name, obj) => { const p = join(tmp, name); writeFileSync(p, JSON.stringify(obj)); return p; };
    const run = (assets, ...more) => { const out = join(tmp, `o${Math.random().toString(36).slice(2)}.dck`); const r = spawnSync(process.execPath, [join(ROOT, 'arcade/tools/arcadec.mjs'), src, '--assets', assets, '--runtime', rtDir, '-o', out, ...more], { encoding: 'utf8' }); return { status: r.status, dck: existsSync(out) ? new Uint8Array(readFileSync(out)) : null, out: r.stdout + r.stderr }; };
    const same = (a, b) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);
    const bothFine = put('both.json', { ...FA, scenes: FINE('a', 'b') }), plainA = put('plain.json', FA), sBufA = put('s.json', { a: { display: 'buffers' } }), sFineA = put('sf.json', FINE('a'));
    const merged = run(bothFine, '--scenes', sBufA), onlyA = run(plainA, '--scenes', sFineA), plain = run(plainA), viaAssets = run(bothFine);
    check_('--scenes {a: buffers} with the assets file saying a and b fine: the whole file is replaced (no fine scene left: the plain build)', merged.status === 0 && same(merged.dck, plain.dck) && !same(merged.dck, viaAssets.dck), merged.out);
    check_('--scenes {a: fine} alone builds a fine game that differs from the plain one and from "a and b fine"', onlyA.status === 0 && !same(onlyA.dck, plain.dck) && !same(onlyA.dck, viaAssets.dck), onlyA.out);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
}

console.log(`\n${passed} passed, ${failed} failed${skipped ? `, ${skipped} skipped` : ''}`);
process.exit(failed ? 1 : 0);
