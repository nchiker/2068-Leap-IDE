"use strict";
// arcade-m3.mjs -- tests for milestone M3 of the Leap Arcade compiler (runtime API v1: text, tiles, collision, sound).
//   node tests/arcade-m3.mjs              (all sections; section R needs arcade/build/v1/runtime.json)
//   ARCADE_QUICK=1 node tests/arcade-m3.mjs   (60 ticks instead of 150 in the differential games)
//
// Sections
//   1  parser and checker: positive and negative tests for every new construct
//   2  asset converters (tileset, sfx, map) and compile-time errors of the code generator
//   3  linker: the v1 header, the string pool, hot boxes, v0 runtimes still refuse the new words
//   4  differential games on a MOCK runtime (v1 routines implemented in JavaScript from the contract, the v0 arithmetic and
//      SHOW / HIDE in Z80) vs the reference interpreter: per tick the cell map and attribute map, text cursor and
//      attribute, SPR_TAB, every variable, V_SFX_ACTIVE and AY_SHADOW
//   5  the example arcade/tests/fixtures/breakout-v1.arc: compiles, size, runs on the mock
//   R  the same games on the REAL v1 runtime (arcade/build/v1/runtime.json), booted from the DCK on a stock TS2068
//
// ── Decisions where docs/ARCADE_RUNTIME_API_V1.md is silent (compiler, interpreter and the mock agree on these) ──────
//   - PRINT: a comma (also a trailing one) prints one space; ';' prints nothing; a trailing ';' or ',' keeps the cursor, else the
//     cursor goes to column 0 of row (row + 1) mod 24. `PRINT AT r, c;` alone (the ';' belongs to AT) is a newline at (r, c).
//     A character is put at the cursor, the cursor advances and moves to column 0 of the next row AT ONCE when it reaches 32
//     (so after exactly filling a row the cursor is already on the next row). Row 24 wraps to row 0.
//   - PRINT AT: row and column are clamped to 0..23 and 0..31 (the compiler does it for run-time values, 16-bit).
//   - INK / PAPER n use n AND 7, BRIGHT n uses n AND 1. Text cells get the whole current attribute (bright, paper, ink).
//   - CLS: attribute = paper << 3 for the current paper (ink 0, bright 0, flash 0); the cursor goes to 0,0.
//   - TILE: ignored when x outside 0..31, y outside 0..23 or t outside the tileset; the cell takes the tile's attribute byte
//     (from its first row's colours). TILEAT: tile index, or -1 for a text cell / outside the screen.
//   - HIT: strict overlap of [x + hx, x + hx + hw) x [y + hy, y + hy + hh) boxes, both sprites shown; the box is the asset's `hot`,
//     else (0, 0, asset width, asset height) (the compiler writes it explicitly, so an 8-wide sprite is 8 wide).
//   - Sound: PLAY at tick k, then frame_div refreshes between ticks, one record per refresh; "active" while played <= N
//     (it stops at the refresh that meets the terminator). The state right at played == N is ambiguous (a runtime may stop one
//     refresh early): it is not compared. PLAY in PROC INIT is not tested (INIT and tick 1 share a refresh).
//   - MAP: tile cells get the tile's attribute at boot (ambiguous in the contract: reported as a NOTE, not a failure, on the real runtime).
import { bootedMachine } from '../arcade/tests/fast-boot.mjs';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { parse } from '../src/lang/arcade/arcade-parse.js';
import { check } from '../src/lang/arcade/arcade-check.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { convertTileset, convertSfx, convertMap, tileAttr } from '../src/lang/arcade/arcade-assets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const TSRUN = join(ROOT, 'tsrun');
const M_ = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
const Z_ = await import(pathToFileURL(join(TSRUN, 'z80.js')).href);

let passed = 0, failed = 0, notes = 0;
const check_ = (name, ok, detail = '') => {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  ok ? passed++ : failed++;
  return ok;
};
const note = (name, ok, detail = '') => {   // ambiguity probes: never fail the run
  console.log(`  ${ok ? 'PASS' : 'NOTE'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  ok ? passed++ : notes++;
};
const QUICK = !!process.env.ARCADE_QUICK;
const TICKS = QUICK ? 60 : 150;
const TMP = mkdtempSync(join(tmpdir(), 'arcade-m3-'));
const hex = (v, w = 4) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');
const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;

function sjasm(asmText, name) {
  const src = join(TMP, name + '.asm');
  writeFileSync(src, asmText);
  const bin = join(TMP, name + '.bin'), sym = join(TMP, name + '.sym');
  try { execFileSync('sjasmplus', ['--nologo', `--raw=${bin}`, `--sym=${sym}`, src], { stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { throw new Error('sjasmplus failed:\n' + (e.stdout || '') + (e.stderr || '')); }
  const syms = {};
  for (const line of readFileSync(sym, 'utf8').split('\n')) {
    const m = line.match(/^(\S+):\s+EQU\s+0x([0-9A-Fa-f]+)/);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  return { bytes: new Uint8Array(readFileSync(bin)), syms };
}

// =================================================================================================================
// Assets used by the tests
// =================================================================================================================
const mkTile = (i) => ({
  rows: Array.from({ length: 8 }, (_, y) => ({ bits: ((0x81 << (y & 1)) ^ (i * 0x11)) & 0xFF, ink: (i + 1) % 8, paper: (i * 3) % 8, bright: i % 2 })),
  flags: 0,
});
const TILESET = { tiles: Array.from({ length: 5 }, (_, i) => mkTile(i)) };
const sfxTicks = (n, t0, dt, v0, dv, mix = 6, noise = 0) => Array.from({ length: n }, (_, k) => ({ tone: t0 + dt * k, vol: Math.max(0, Math.min(15, v0 + dv * k)), noise, mix }));
const SFX = { beep: { ticks: sfxTicks(12, 200, 20, 15, -1) }, zap: { ticks: sfxTicks(5, 50, 100, 12, 0, 5, 9) }, long: { ticks: sfxTicks(40, 800, -10, 14, 0) } };
const ROWS8 = (b) => Array.from({ length: 8 }, () => ({ bits: b, mask: b }));
const SPR = {
  ball: { w: 8, h: 8, rows: ROWS8('FF') },
  bat: { w: 16, h: 8, rows: Array.from({ length: 8 }, () => ({ bits: 'FFFF', mask: 'FFFF' })) },
  big: { w: 16, h: 16, rows: Array.from({ length: 16 }, () => ({ bits: 'FFFF', mask: 'FFFF' })), hot: [4, 4, 8, 8] },
};
const MAPA = { w: 6, h: 3, cells: [0, 1, 2, 3, 4, -1, 4, 3, -1, 1, 0, 255, -1, -1, 2, 2, -1, 0] };
const ASSETS = { sprites: SPR, tilesets: { ts: TILESET }, sfx: SFX, maps: { level: MAPA } };

// =================================================================================================================
// 1. Parser and checker
// =================================================================================================================
console.log('1. Parser and checker: PRINT, INK / PAPER / BRIGHT, CLS, TILE, TILEAT, HIT, PLAY, SILENCE, TILESET, SFX, MAP');
const prog = (body, top = '') => `GAME "t"\nSPRITE ball = "ball"\nSPRITE bat = "bat"\nSFX snd = "beep"\nTILESET ts = "ts"\n${top}SCENE s\n  DIM v, w\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n${body}\n  ENDP\nENDSCENE\n`;
const BODY_LINE = 9;                                  // the line of the first statement of `body` in prog()
const errs = (body, top) => { const p = parse(prog(body, top)); return [...p.errors, ...check(p.ast)].filter((d) => d.severity === 'error'); };
const stmtsOf = (body) => parse(prog(body)).ast.scenes[0].procs.find((p) => p.name.toUpperCase() === 'FRAME').body;
const msgs = (list) => list.map((d) => d.message).join(' | ');
const ok0 = (name, body, top) => { const e = errs(body, top); check_(name, e.length === 0, msgs(e)); };
const bad = (name, body, rx, top) => { const e = errs(body, top); check_(name, e.length >= 1 && rx.test(e[0].message) && e[0].line >= BODY_LINE - 1, msgs(e) || 'no error'); };
{
  ok0('PRINT "text"', '    PRINT "hi"');
  ok0('PRINT AT r, c; items with ; and ,', '    PRINT AT 3, 4; "score"; v, w; STR$(v + 1)');
  ok0('PRINT with a trailing ; and a trailing ,', '    PRINT "a";\n    PRINT "b",');
  ok0('PRINT with no items', '    PRINT\n    PRINT AT 1, 1;');
  ok0('PRINT of an expression and a joined string', '    PRINT v * 2 - w; "x" + STR$(v)');
  ok0('PRINT AT with run-time row and column', '    PRINT AT v, w; "x"');
  ok0('INK / PAPER / BRIGHT / CLS', '    INK 7 : PAPER 0 : BRIGHT 1 : CLS\n    INK v');
  ok0('TILE x, y = t and TILEAT(x, y)', '    TILE 31, 23 = 127\n    TILE v, w = v\n    v = TILEAT(0, 0) + TILEAT(v, w)');
  ok0('HIT(a, b) with sprite names', '    IF HIT(ball, bat) THEN\n      PLAY snd\n    ENDIF');
  ok0('PLAY and SILENCE', '    PLAY snd\n    SILENCE');
  ok0('MAP declaration', '', 'MAP level = "level"\n');
  ok0('a negative literal is parsed as a unary minus (PRINT of -5)', '    PRINT -5');

  const p = stmtsOf('    PRINT AT 3, 4; "a"; v, w;')[0];
  check_('parse: PRINT AT node (row, col, items, seps, trailing)', p.type === 'Print' && p.at && p.items.length === 3 && p.seps.join('') === ';,' && p.trailing === ';', JSON.stringify([p.items.length, p.seps, p.trailing]));
  const p2 = stmtsOf('    PRINT "a", "b"')[0];
  check_('parse: comma separator and no trailing one', p2.seps.join('') === ',' && p2.trailing === null);
  const t = stmtsOf('    TILE v + 1, w * 2 = 3')[0];
  check_('parse: TILE node', t.type === 'Tile' && t.x.type === 'Binary' && t.value.value === 3);
  const c = stmtsOf('    INK 1\n    PAPER 2\n    BRIGHT 1\n    CLS\n    PLAY snd\n    SILENCE').map((x) => x.type + (x.which ?? ''));
  check_('parse: statement node types', c.join() === 'ColorINK,ColorPAPER,ColorBRIGHT,Cls,Play,Silence', c.join());
  const asset = parse(prog('', 'MAP level = "level"\n')).ast.assets.map((a) => a.kind + ':' + a.name).join();
  check_('parse: SPRITE / SFX / TILESET / MAP declarations', asset === 'SPRITE:ball,SPRITE:bat,SFX:snd,TILESET:ts,MAP:level', asset);

  bad('negative: PRINT AT row 24', '    PRINT AT 24, 0; "x"', /AT row is 24: it must be 0\.\.23/);
  bad('negative: PRINT AT column 32', '    PRINT AT 0, 32; "x"', /AT column is 32: it must be 0\.\.31/);
  bad('negative: PRINT AT negative row', '    PRINT AT -1, 0; "x"', /AT row is -1/);
  bad('negative: PRINT AT with only a row', '    PRINT AT 1; "x"', /expected ','/);
  bad('negative: AT is not a statement', '    AT 1, 2', /AT is not a statement: it only follows PRINT/);
  bad('negative: PRINT of a character the font lacks', '    PRINT "café"', /code 233/);
  bad('negative: PRINT of two items without a separator', '    PRINT "a" "b"', /unexpected a string/);
  bad('negative: PRINT of an undeclared variable', '    PRINT nope', /not declared/);
  bad('negative: INK 8', '    INK 8', /INK \(0\.\.7\) is 8/);
  bad('negative: PAPER -1', '    PAPER -1', /PAPER \(0\.\.7\) is -1/);
  bad('negative: BRIGHT 2', '    BRIGHT 2', /BRIGHT \(0\.\.1\) is 2/);
  bad('negative: INK with a string', '    INK "red"', /must be a number/);
  bad('negative: CLS with an argument', '    CLS 1', /unexpected '1'/);
  bad('negative: TILE x 32', '    TILE 32, 0 = 1', /TILE x \(the column\) is 32/);
  bad('negative: TILE y 24', '    TILE 0, 24 = 1', /TILE y \(the row\) is 24/);
  bad('negative: TILE tile 128', '    TILE 0, 0 = 128', /the tile index is 128/);
  bad('negative: TILE tile -1', '    TILE 0, 0 = -1', /the tile index is -1/);
  bad('negative: TILE without =', '    TILE 1, 2', /expected '='/);
  bad('negative: TILEAT column 32', '    v = TILEAT(32, 0)', /TILEAT x \(the column\) is 32/);
  bad('negative: TILEAT row 24', '    v = TILEAT(0, 24)', /TILEAT y \(the row\) is 24/);
  bad('negative: TILEAT with one argument', '    v = TILEAT(1)', /TILEAT takes 2 arguments, got 1/);
  bad('negative: HIT with an unknown sprite', '    v = HIT(ball, nope)', /'nope' is not a declared SPRITE/);
  bad('negative: HIT with an SFX', '    v = HIT(ball, snd)', /is a SFX, not a SPRITE/);
  bad('negative: HIT with a variable', '    v = HIT(ball, w)', /is a variable, not a SPRITE/);
  bad('negative: HIT with an expression', '    v = HIT(ball, 1)', /expected a sprite name/);
  bad('negative: PLAY an unknown effect', '    PLAY nope', /'nope' is not a declared SFX/);
  bad('negative: PLAY a SPRITE', '    PLAY ball', /is a SPRITE, not a SFX/);
  bad('negative: PLAY a tileset', '    PLAY ts', /is a TILESET, not a SFX/);
  bad('negative: PLAY without a name', '    PLAY', /expected a sound effect name/);
  bad('negative: SILENCE with an argument', '    SILENCE 1', /unexpected '1'/);
  { const e = errs('', 'SFX snd = "zap"\n'); check_('negative: SFX declared twice with one name', e.length === 1 && /already declared \(line 4\)/.test(e[0].message) && e[0].line === 6, msgs(e)); }
}
{
    const src = `GAME "t"\nSCENE s\n  SFX q = "zap"\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`;
  const e = parse(src).errors;
  check_('negative: SFX / TILESET inside a SCENE', e.some((d) => /SFX must be at the top level/.test(d.message)), msgs(e));
  const src2 = `GAME "t"\nTILESET a = "ts"\nTILESET a = "ts"\nSCENE s\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n  ENDP\nENDSCENE\n`;
  const p2 = parse(src2); const e2 = check(p2.ast);
  check_('negative: a name declared twice (TILESET)', e2.some((d) => /already declared/.test(d.message)), msgs(e2));
  const w = check(parse(prog('    PLAY snd')).ast).filter((d) => d.severity === 'warning').map((d) => d.message).join('|');
  check_('warning: SPRITE bat never used (SFX / TILESET are not reported)', /SPRITE 'bat' is never used|SPRITE 'ball' is never used/.test(w) && !/TILESET|SFX/.test(w), w);
  const q = errs('    PRINT AT v, w; "x"; v');
  check_('a run-time AT is fine', q.length === 0);
}

// =================================================================================================================
// 2. Asset converters and generator errors
// =================================================================================================================
console.log('\n2. Asset converters and code generator errors');
{
  const ts = convertTileset({ tiles: [{ rows: [{ bits: 'FF', ink: 2, paper: 5, bright: 1 }, ...Array.from({ length: 7 }, (_, i) => ({ bits: i, ink: 7, paper: 0 }))], flags: 3 }] });
  check_('tileset: count, 8 bitmap bytes + attribute from the first row (bright 1, paper 5, ink 2 = $6A)',
    ts.count === 1 && ts.bytes.length === 9 && [...ts.bytes.slice(0, 8)].join() === [255, 0, 1, 2, 3, 4, 5, 6].join() && ts.bytes[8] === 0x6A, [...ts.bytes].map((v) => v.toString(16)).join(' '));
  check_('tileset: defaults are ink 0, paper 7, bright 0 ($38)', tileAttr({}) === 0x38);
  const bt = (f) => { try { f(); return null; } catch (e) { return e.message; } };
  check_('tileset: 129 tiles refused', /at most 128/.test(bt(() => convertTileset({ tiles: Array.from({ length: 129 }, (_, i) => mkTile(i % 5)) })) ?? ''));
  check_('tileset: a tile with 7 rows refused', /exactly 8 rows/.test(bt(() => convertTileset({ tiles: [{ rows: ROWS8('FF').slice(1) }] })) ?? ''));
  check_('tileset: bits "1FF" refused', /number 0\.\.255 or one or two hex digits/.test(bt(() => convertTileset({ tiles: [{ rows: ROWS8('1FF') }] })) ?? ''));
  check_('tileset: ink 8 refused', /ink must be a whole number 0\.\.7/.test(bt(() => convertTileset({ tiles: [{ rows: [{ bits: 'FF', ink: 8 }, ...ROWS8('FF').slice(1)] }] })) ?? ''));
  const sf = convertSfx({ ticks: [{ tone: 0x123, vol: 9, noise: 17, mix: 5 }, { tone: 4095, vol: 14, noise: 0, mix: 0 }] });
  check_('sfx: record = tone_lo, tone_hi | vol << 4, noise | mix << 5, 0; then the terminator',
    [...sf.bytes].join() === [0x23, 0x91, 17 | (5 << 5), 0, 0xFF, 0xEF, 0, 0, 0, 0xFF, 0, 0].join(), [...sf.bytes].map((v) => v.toString(16)).join(' '));
  check_('sfx: tone 4000 with volume 15 refused (the byte $FF ends an effect)', /cannot be stored/.test(bt(() => convertSfx({ ticks: [{ tone: 4000, vol: 15 }] })) ?? ''));
  check_('sfx: tone 4096 / vol 16 / noise 32 / mix 8 refused', ['tone:4096', 'vol:16', 'noise:32', 'mix:8'].every((kv) => { const [k, v] = kv.split(':'); return bt(() => convertSfx({ ticks: [{ tone: 1, vol: 1, [k]: Number(v) }] })) !== null; }));
  check_('sfx: no ticks gives just the terminator', convertSfx({ ticks: [] }).bytes.length === 4);
  const mp = convertMap({ w: 3, h: 2, cells: '00 01 ff 02 ff 00' }, 3);
  check_('map: hex cells placed at the top-left (row stride 32), blank = 32, tile = 128 + index',
    mp.bytes.length === 768 && mp.bytes[0] === 128 && mp.bytes[1] === 129 && mp.bytes[2] === 32 && mp.bytes[32] === 130 && mp.bytes[33] === 32 && mp.bytes[34] === 128 && mp.bytes[3] === 32 && mp.bytes[767] === 32);
  check_('map: a tile past the tileset refused; wrong cell count refused; 33 wide refused',
    /tile index 0\.\.2/.test(bt(() => convertMap({ w: 1, h: 1, cells: [3] }, 3)) ?? '') && /cells but/.test(bt(() => convertMap({ w: 2, h: 2, cells: [0] }, 3)) ?? '') && bt(() => convertMap({ w: 33, h: 1, cells: [] }, 3)) !== null);
}
// -- the mock runtime (built in section 4); needed here for the compile-time errors
const MOCK_BASE_ASM = (() => {
  const t = readFileSync(join(HERE, 'arcade-compile.mjs'), 'utf8');
  const a = t.indexOf('const MOCK_ASM = `'), b = t.indexOf('`;', a);
  if (a < 0 || b < 0) throw new Error('cannot find MOCK_ASM in tests/arcade-compile.mjs');
  return t.slice(a + 'const MOCK_ASM = `'.length, b);
})();
const MOCK_BUILD = sjasm(MOCK_BASE_ASM, 'mockrt');
const TRAPS = { RT_AT: 0xC400, RT_PRINTS: 0xC410, RT_PRINTN: 0xC420, RT_PRINTC: 0xC430, RT_INK: 0xC440, RT_PAPER: 0xC450, RT_BRIGHT: 0xC460, RT_CLS: 0xC470,
  RT_TILE: 0xC480, RT_TILEAT: 0xC490, RT_HIT: 0xC4A0, RT_PLAY: 0xC4B0, RT_SILENCE: 0xC4C0 };
const MOCK_ADDR = { CELL_TILE: 0xD000, CELL_ATTR: 0xD300, AY_SHADOW: 0xD600, V_TEXT_ATTR: 0xE040, V_CUR_ROW: 0xE041, V_CUR_COL: 0xE042, V_SFX_ACTIVE: 0xE043, SPR_TAB: 0xE010, RT_SEED: 0xE030 };
const mockImage = new Uint8Array(65536);
mockImage.set(MOCK_BUILD.bytes, 0xC000);
for (const a of Object.values(TRAPS)) mockImage[a] = 0xC9;      // RET: the JavaScript handler runs when the PC gets here
const mockRuntime = (version = 1) => ({
  version,
  symbols: {
    RT_SHOW: MOCK_BUILD.syms.RT_SHOW, RT_HIDE: MOCK_BUILD.syms.RT_HIDE, RT_MUL: MOCK_BUILD.syms.RT_MUL, RT_DIV: MOCK_BUILD.syms.RT_DIV,
    RT_MOD: MOCK_BUILD.syms.RT_MOD, RT_RND: MOCK_BUILD.syms.RT_RND, RT_STICK: MOCK_BUILD.syms.RT_STICK,
    V_TICKS: 0xE000, ...(version >= 1 ? { ...TRAPS, ...MOCK_ADDR } : { SPR_TAB: 0xE010, RT_SEED: 0xE030 }),
  },
  constants: { GAME_BASE: 0x8000, GAME_VARS_BASE: 0xE100, GAME_VARS_LIMIT: 0xEFFF, MAX_SPRITES: 4 },
});
const compileM = (src, assets = ASSETS, rt = mockRuntime(1)) => compile(src, { runtime: rt, image: mockImage, assets });
const GAME = (top, body, decl = 'DIM a, b') => `GAME "t"\nSPRITE ball = "ball"\nSPRITE bat = "bat"\n${top}SCENE s\n  ${decl}\n  PROC INIT():\n  ENDP\n  PROC FRAME():\n${body}\n  ENDP\nENDSCENE\n`;
{
  const err1 = (src, assets, rt) => compileM(src, assets, rt).errors.map((e) => e.message).join(' | ');
  const T = 'TILESET ts = "ts"\n', S = 'SFX snd = "beep"\n';
  check_('TILE without a TILESET declaration is reported', /TILE needs a TILESET/.test(err1(GAME('', '    TILE 1, 1 = 0'))), err1(GAME('', '    TILE 1, 1 = 0')));
  check_('a second TILESET is refused', /second TILESET.*not supported yet in M3/.test(err1(GAME(T + 'TILESET t2 = "ts"\n', ''))));
  check_('nine SFX are refused', /at most 8 sound effects/.test(err1(GAME(Array.from({ length: 9 }, (_, i) => `SFX s${i} = "zap"\n`).join(''), ''))));
  check_('a missing SFX asset is reported', /sound effect asset "nope" is not in the project/.test(err1(GAME('SFX q = "nope"\n', ''))));
  check_('a missing TILESET asset is reported', /tileset asset "nope" is not in the project/.test(err1(GAME('TILESET q = "nope"\n', ''))));
  check_('an invalid sfx asset is reported with its reason', /sound effect "bad": tick 0: tone 4000 with volume 15 cannot be stored/.test(err1(GAME('SFX q = "bad"\n', '', ), { ...ASSETS, sfx: { bad: { ticks: [{ tone: 4000, vol: 15 }] } } })));
  check_('TILE 4 is fine with 5 tiles, TILE 5 is refused with the tileset size', err1(GAME(T, '    TILE 1, 1 = 4')) === '' && /tile 5 is not in the tileset "ts" \(it has 5 tiles, 0\.\.4\)/.test(err1(GAME(T, '    TILE 1, 1 = 5'))), err1(GAME(T, '    TILE 1, 1 = 5')));
  check_('a MAP without a TILESET is refused', /a MAP needs a TILESET/.test(err1(GAME('MAP level = "level"\n', ''))));
  check_('a MAP naming a tile the tileset lacks is refused', /tile index 0\.\.1/.test(err1(GAME(T.replace('"ts"', '"two"') + 'MAP level = "level"\n', ''), { ...ASSETS, tilesets: { two: { tiles: TILESET.tiles.slice(0, 2) } } })));
  check_('PRINT TAB is not supported yet in M3', /PRINT \.\.\. TAB is not supported yet in M3/.test(err1(GAME('', '    PRINT TAB 5; "x"'))));
  check_('STR$ outside PRINT (and LEN) is not supported yet in M3', /LEN\(\.\.\.\) is not supported yet in M3/.test(err1(GAME('', '    a = LEN(STR$(5))'))));
  check_('a string variable is still not supported', /string variable/.test(err1(GAME('', '', 'DIM a$'))));
  check_('FLASH and BORDER are not supported yet in M3', /FLASH is not supported yet in M3/.test(err1(GAME('', '    FLASH 1'))) && /BORDER is not supported yet in M3/.test(err1(GAME('', '    BORDER 1'))));
  const no = { ...mockRuntime(1), symbols: Object.fromEntries(Object.entries(mockRuntime(1).symbols).filter(([k]) => k !== 'RT_PRINTS')) };
  check_('a runtime without RT_PRINTS is reported at the PRINT line', compileM(GAME('', '    PRINT "x"'), ASSETS, no).errors.some((e) => /does not provide RT_PRINTS/.test(e.message) && e.line === 9), err1(GAME('', '    PRINT "x"'), ASSETS, no));
  check_('a v0 runtime still says "not supported yet in M2" for the new words', ['    PRINT "x"', '    CLS', '    INK 1', '    PLAY q', '    SILENCE', '    TILE 1, 1 = 0', '    a = HIT(ball, bat)', '    a = TILEAT(1, 1)']
    .every((b) => /not supported yet in M2/.test(err1(GAME('SFX q = "beep"\n', b), ASSETS, mockRuntime(0)))));
  check_('SFX / TILESET declarations on a v0 runtime: "not supported yet in M2"', /SFX \(q\) is not supported yet in M2/.test(err1(GAME('SFX q = "beep"\n', ''), ASSETS, mockRuntime(0))) && /TILESET \(t\) is not supported yet in M2/.test(err1(GAME('TILESET t = "ts"\n', ''), ASSETS, mockRuntime(0))));
}

// =================================================================================================================
// 3. Linker: the v1 header, string pool, hot boxes
// =================================================================================================================
console.log('\n3. Linker: v1 header, string pool, hot boxes');
{
  const src = GAME('SPRITE big = "big"\nTILESET ts = "ts"\nSFX snd = "beep"\nSFX z = "zap"\nMAP level = "level"\n', '    PRINT AT 1, 2; "Hello"; a; ", "; STR$(7)\n    PLAY z');
  const r = compileM(src);
  check_('compiles', r.errors.length === 0 && !!r.dck, JSON.stringify(r.errors));
  const mem = r.memory, rd = (a) => mem[a] | (mem[a + 1] << 8);
  check_('v0 part of the header unchanged: init, frame, frame_div, sprite_count, sprite_table = $800E', rd(0x8000) === r.map.entries.init && rd(0x8002) === r.map.entries.frame && mem[0x8004] === 2 && mem[0x8005] === 3 && rd(0x8006) === 0x800E, `table ${hex(rd(0x8006))}`);
  const tp = rd(0x8008), sp = rd(0x800A), mp = rd(0x800C);
  check_('tileset_ptr: count 5 then 5 x 9 bytes', tp > 0x800E && mem[tp] === 5 && [...mem.subarray(tp + 1, tp + 10)].join() === [...convertTileset(TILESET).bytes.subarray(0, 9)].join());
  check_('sfx_table: count 2, two pointers, records then the terminator', sp > 0x800E && mem[sp] === 2 && (() => {
    const a0 = rd(sp + 1), a1 = rd(sp + 3);
    return [...mem.subarray(a0, a0 + 12 * 4 + 4)].join() === [...convertSfx(SFX.beep).bytes].join() && [...mem.subarray(a1, a1 + 24)].join() === [...convertSfx(SFX.zap).bytes].join();
  })());
  check_('map_ptr: 768 cell bytes (tile = 128 + index, blank = 32)', mp > 0x800E && mem[mp] === 128 && mem[mp + 1] === 129 && mem[mp + 5] === 32 && mem[mp + 32] === 132 && mem[mp + 767] === 32 && [...mem.subarray(mp, mp + 768)].join() === [...convertMap(MAPA, 5).bytes].join());
  const d0 = 0x800E;
  check_('descriptors at $800E: width 16, height, data, hot pointer', mem[d0] === 16 && mem[d0 + 1] === 8 && rd(d0 + 4) !== 0 && mem[d0 + 6 + 1] === 8 && mem[d0 + 12 + 1] === 16);
  const hot = (i) => { const a = rd(d0 + 6 * i + 4); return [...mem.subarray(a, a + 4)]; };
  check_('hot boxes: ball 8 x 8 (whole sprite, asset width), bat 16 x 8, big has the asset\'s [4, 4, 8, 8]', hot(0).join() === '0,0,8,8' && hot(1).join() === '0,0,16,8' && hot(2).join() === '4,4,8,8', `${hot(0)} ${hot(1)} ${hot(2)}`);
  // string pool: the code loads HL with the address of a [length, chars...] string
  const find = (txt) => { const pat = [txt.length, ...[...txt].map((c) => c.charCodeAt(0))]; for (let i = r.gen.base; i < r.gen.base + r.gen.code.length; i++) if (pat.every((v, k) => mem[i + k] === v)) return i; return -1; };
  const hello = find('Hello'), comma = find(', 7');
  check_('string pool: length-prefixed "Hello" and ", 7" (comma space and STR$(7) merged)', hello > 0 && comma > 0, `${hello} ${comma}`);
  check_('the PRINT code calls RT_AT with B = 1, C = 2 (one LD BC,$0102: B high, C low) then RT_PRINTS with HL = the string', (() => {
    const c = r.gen.code, b = r.gen.base;
    const at = [...c].findIndex((v, i) => v === 0x01 && c[i + 1] === 2 && c[i + 2] === 1 && c[i + 3] === 0xCD && (c[i + 4] | (c[i + 5] << 8)) === TRAPS.RT_AT);
    const ph = [...c].findIndex((v, i) => v === 0x21 && (c[i + 1] | (c[i + 2] << 8)) === hello && c[i + 3] === 0xCD && (c[i + 4] | (c[i + 5] << 8)) === TRAPS.RT_PRINTS);
    return at >= 0 && ph > at;
  })());
  check_('usage reports the data sizes', r.usage.data.tileset === 46 && r.usage.data.sfx === 81 && r.usage.data.map === 768, JSON.stringify(r.usage.data));
  // 40 characters: split into pool strings of at most 31
  const longTxt = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD';
  const r2 = compileM(GAME('', `    PRINT "${longTxt.slice(0, 31)}"; "${longTxt.slice(31)}"`));
  check_('a literal of 40 characters is stored as strings of at most 31 (merged then split)', r2.errors.length === 0 && (() => {
    const c = r2.memory; const base = r2.gen.base, end = base + r2.gen.code.length;
    const find2 = (t) => { for (let i = base; i < end; i++) if (c[i] === t.length && [...t].every((ch, k) => c[i + 1 + k] === ch.charCodeAt(0))) return true; return false; };
    return find2(longTxt.slice(0, 31)) && find2(longTxt.slice(31));
  })());
  const r3 = compileM(GAME('', '    PRINT "A"'));
  check_('a game without tileset / sfx / map has zero pointers', r3.memory[0x8008] === 0 && r3.memory[0x8009] === 0 && r3.memory[0x800A] === 0 && r3.memory[0x800C] === 0);
  const v0 = compileM(GAME('', '    a = 1'), ASSETS, mockRuntime(0));
  check_('a v0 runtime gives the v0 header (descriptors at $8008, last word 0)', v0.errors.length === 0 && (v0.memory[0x8006] | (v0.memory[0x8007] << 8)) === 0x8008 && v0.memory[0x800C] === 0 && v0.memory[0x800D] === 0);
}

// =================================================================================================================
// 4. The mock runtime and the differential harness
// =================================================================================================================
const HAVE_TRAP = new Set(Object.values(TRAPS));
/** Run a compiled game on the mock: init + n ticks. Each tick: the refreshes between ticks, the joystick, PROC FRAME. */
function runMock(res, { ticks, stick = null }) {
  const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  m.ram.set(res.memory.subarray(0x4000), 0x4000);
  m.ram.fill(0xA5, 0xE100, 0xF000);                    // variables start as garbage: the init stub clears them
  m.ram.fill(0, 0xE000, 0xE100);
  const A = MOCK_ADDR, ram = m.ram, cpu = m.cpu;
  const rd16 = (a) => ram[a] | (ram[a + 1] << 8);
  ram[0xE030] = 12345 & 0xFF; ram[0xE031] = 12345 >> 8;
  const frameDiv = ram[0x8004];
  // ---- the mock's model of runtime v1, written from docs/ARCADE_RUNTIME_API_V1.md (not from the interpreter) ----
  ram.fill(32, A.CELL_TILE, A.CELL_TILE + 768); ram.fill(0x38, A.CELL_ATTR, A.CELL_ATTR + 768);
  ram[A.V_TEXT_ATTR] = 0x38; ram[A.V_CUR_ROW] = 0; ram[A.V_CUR_COL] = 0; ram[A.V_SFX_ACTIVE] = 0;
  const tilesetPtr = rd16(0x8008), sfxTable = rd16(0x800A), mapPtr = rd16(0x800C);
  const tileAttrOf = (t) => ram[tilesetPtr + 1 + t * 9 + 8];
  if (mapPtr) for (let i = 0; i < 768; i++) { const v = ram[mapPtr + i]; ram[A.CELL_TILE + i] = v; if (v & 0x80) ram[A.CELL_ATTR + i] = tileAttrOf(v & 0x7F); }
  const putChar = (code) => {
    const row = ram[A.V_CUR_ROW], col = ram[A.V_CUR_COL], i = row * 32 + col;
    ram[A.CELL_TILE + i] = code & 0x7F; ram[A.CELL_ATTR + i] = ram[A.V_TEXT_ATTR];
    let c = col + 1, r = row;
    if (c === 32) { c = 0; r = (r + 1) % 24; }
    ram[A.V_CUR_COL] = c; ram[A.V_CUR_ROW] = r;
  };
  let sfx = { index: -1, pos: 0 };                     // pos = records consumed since PLAY
  const sfxRecords = (idx) => { const p = rd16(sfxTable + 1 + 2 * idx); let n = 0; while (ram[p + 4 * n + 1] !== 0xFF) n++; return { p, n }; };
  const ay = (r, v) => { ram[A.AY_SHADOW + r] = v; };
  const refresh = () => {                              // one frame interrupt of the sound code
    if (!ram[A.V_SFX_ACTIVE]) return;
    const { p, n } = sfxRecords(sfx.index);
    if (sfx.pos >= n) { ram[A.V_SFX_ACTIVE] = 0; ay(8, 0); return; }
    const rec = p + 4 * sfx.pos++;
    ay(0, ram[rec]); ay(1, ram[rec + 1] & 0x0F); ay(8, ram[rec + 1] >> 4); ay(6, ram[rec + 2] & 0x1F); ay(7, 0x36 | ((ram[rec + 2] >> 5) & 1) | (((ram[rec + 2] >> 6) & 1) << 3));   // contract mix bit 0 = tone A off (reg 7 bit 0), bit 1 = noise A off (reg 7 bit 3); B and C disabled
  };
  const hl = () => (cpu.h << 8) | cpu.l;
  const setHL = (v) => { cpu.h = (v >> 8) & 0xFF; cpu.l = v & 0xFF; };
  const handlers = {
    [TRAPS.RT_AT]() { ram[A.V_CUR_ROW] = Math.min(cpu.b, 23); ram[A.V_CUR_COL] = Math.min(cpu.c, 31); },
    [TRAPS.RT_PRINTS]() { const p = hl(), n = ram[p]; for (let k = 1; k <= n; k++) putChar(ram[p + k]); },
    [TRAPS.RT_PRINTN]() { for (const ch of String(s16(hl()))) putChar(ch.charCodeAt(0)); },
    [TRAPS.RT_PRINTC]() { putChar(cpu.a); },
    [TRAPS.RT_INK]() { ram[A.V_TEXT_ATTR] = (ram[A.V_TEXT_ATTR] & ~7) | (cpu.a & 7); },
    [TRAPS.RT_PAPER]() { ram[A.V_TEXT_ATTR] = (ram[A.V_TEXT_ATTR] & ~0x38) | ((cpu.a & 7) << 3); },
    [TRAPS.RT_BRIGHT]() { ram[A.V_TEXT_ATTR] = (ram[A.V_TEXT_ATTR] & ~0x40) | ((cpu.a & 1) << 6); },
    [TRAPS.RT_CLS]() { ram.fill(32, A.CELL_TILE, A.CELL_TILE + 768); ram.fill(((ram[A.V_TEXT_ATTR] >> 3) & 7) << 3, A.CELL_ATTR, A.CELL_ATTR + 768); ram[A.V_CUR_ROW] = 0; ram[A.V_CUR_COL] = 0; },
    [TRAPS.RT_TILE]() { const t = cpu.a, row = cpu.b, col = cpu.c; if (row > 23 || col > 31) return; const i = row * 32 + col; ram[A.CELL_TILE + i] = 128 + t; ram[A.CELL_ATTR + i] = tileAttrOf(t); },
    [TRAPS.RT_TILEAT]() { const row = cpu.b, col = cpu.c; if (row > 23 || col > 31) { setHL(0xFFFF); return; } const v = ram[A.CELL_TILE + row * 32 + col]; setHL(v & 0x80 ? v & 0x7F : 0xFFFF); },
    [TRAPS.RT_HIT]() {
      const a = cpu.a, b = cpu.e, d0 = rd16(0x8006);
      const sp = (i) => ({ vis: ram[A.SPR_TAB + 6 * i], x: rd16(A.SPR_TAB + 6 * i + 2), y: rd16(A.SPR_TAB + 6 * i + 4), hot: [0, 1, 2, 3].map((k) => ram[rd16(d0 + 6 * i + 4) + k]) });
      const A_ = sp(a), B_ = sp(b);
      if (!A_.vis || !B_.vis) { setHL(0); return; }
      const [ahx, ahy, ahw, ahh] = A_.hot, [bhx, bhy, bhw, bhh] = B_.hot;
      const al = A_.x + ahx, at = A_.y + ahy, bl = B_.x + bhx, bt = B_.y + bhy;
      setHL(al < bl + bhw && bl < al + ahw && at < bt + bhh && bt < at + ahh ? 1 : 0);
    },
    [TRAPS.RT_PLAY]() { if (cpu.a < ram[sfxTable]) { sfx = { index: cpu.a, pos: 0 }; ram[A.V_SFX_ACTIVE] = 1; } },
    [TRAPS.RT_SILENCE]() { ram[A.V_SFX_ACTIVE] = 0; ay(8, 0); },
  };
  const SENT = 0xFFF0; ram[SENT] = 0x76;
  const call = (addr) => {
    cpu.sp = 0xFF00 - 2; ram[cpu.sp] = SENT & 0xFF; ram[cpu.sp + 1] = SENT >> 8;
    cpu.pc = addr; cpu.halted = false; cpu.iff1 = false; cpu.iff2 = false; cpu.eiDelay = false;
    let n = 0;
    while (cpu.pc !== SENT) {
      const h = handlers[cpu.pc];
      if (h && HAVE_TRAP.has(cpu.pc)) h();
      Z_.runZ80(cpu, m.bus, 1, m);
      if (++n > 4_000_000) throw new Error('runaway code');
    }
  };
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    sprites: Array.from({ length: 4 }, (_, i) => ({ visible: ram[A.SPR_TAB + 6 * i], x: rd16(A.SPR_TAB + 6 * i + 2), y: rd16(A.SPR_TAB + 6 * i + 4) })),
    cells: ram.slice(A.CELL_TILE, A.CELL_TILE + 768), attrs: ram.slice(A.CELL_ATTR, A.CELL_ATTR + 768),
    cursor: { row: ram[A.V_CUR_ROW], col: ram[A.V_CUR_COL] }, textAttr: ram[A.V_TEXT_ATTR],
    sfxActive: ram[A.V_SFX_ACTIVE], ay: ram.slice(A.AY_SHADOW, A.AY_SHADOW + 16),
  });
  const out = { init: null, ticks: [], tstates: [] };
  call(res.map.entries.init);
  out.init = snap();
  for (let t = 1; t <= ticks; t++) {
    for (let k = 0; k < frameDiv; k++) refresh();
    const sv = stick ? stick(t) : 0;
    ram[0xE034] = typeof sv === 'number' ? sv : (sv[1] | 0); ram[0xE035] = typeof sv === 'number' ? 0 : (sv[2] | 0);
    const t0 = m.tstates;
    call(res.map.entries.frame);
    out.tstates.push(m.tstates - t0);
    out.ticks.push(snap());
  }
  return out;
}

/** Compare one sampled tick with the interpreter's record; null or a description of the first difference. */
function diffTick(label, g, w, ctx) {
  for (const [k, v] of Object.entries(w.vars)) if (g.vars[k] !== v) return `${label}: variable ${k} = ${g.vars[k]}, interpreter ${v}`;
  for (let i = 0; i < 4; i++) {
    const a = g.sprites[i], b = w.sprites[i];
    if (a.visible !== b.visible || (b.visible && (a.x !== b.x || a.y !== b.y))) return `${label}: sprite ${i} = ${JSON.stringify(a)}, interpreter ${JSON.stringify(b)}`;
  }
  if (!ctx.skip.has('cells')) for (let i = 0; i < 768; i++) {
    if (g.cells[i] !== w.cells[i]) return `${label}: cell (row ${(i / 32) | 0}, col ${i % 32}) = ${g.cells[i]}, interpreter ${w.cells[i]}`;
  }
  if (!ctx.skip.has('attrs')) for (let i = 0; i < 768; i++) {
    if (g.attrs[i] !== w.attrs[i]) return `${label}: attribute (row ${(i / 32) | 0}, col ${i % 32}) = $${g.attrs[i].toString(16)}, interpreter $${w.attrs[i].toString(16)}`;
  }
  if (!ctx.skip.has('cursor') && (g.cursor.row !== w.cursor.row || g.cursor.col !== w.cursor.col)) return `${label}: cursor = ${g.cursor.row},${g.cursor.col}, interpreter ${w.cursor.row},${w.cursor.col}`;
  if (!ctx.skip.has('cursor') && g.textAttr !== w.textAttr) return `${label}: V_TEXT_ATTR = $${g.textAttr.toString(16)}, interpreter $${w.textAttr.toString(16)}`;
  // sound: V_SFX_ACTIVE (not at played == N: a runtime may stop one refresh early) and the AY registers of the record just played
  const N = w.sfx.index >= 0 ? ctx.sfxLens[w.sfx.index] : -1;
  const boundary = !ctx.strictBoundary && w.sfx.index >= 0 && w.sfx.played === N && w.sfx.active;
  if (!boundary && g.sfxActive !== (w.sfx.active ? 1 : 0)) return `${label}: V_SFX_ACTIVE = ${g.sfxActive}, interpreter ${w.sfx.active ? 1 : 0} (effect ${w.sfx.index}, ${w.sfx.played} refreshes played)`;
  if (g.ay && !boundary) {
    if (w.sfx.rec >= 0) {
      const a = ctx.sfxBytes[w.sfx.index], r = w.sfx.rec;
      const want = [[0, a[4 * r]], [1, a[4 * r + 1] & 15], [8, a[4 * r + 1] >> 4], [6, a[4 * r + 2] & 31], [7, (a[4 * r + 2] >> 5) & 3]];
      const msk = { 0: 255, 1: 15, 8: 15, 6: 31, 7: 3 };
      // register 7 holds the mix as the real AY register does: channel A tone off = bit 0, channel A noise off = bit 3 (the contract's mix bits 0 and 1)
      const val = (reg) => (reg === 7 ? (g.ay[7] & 1) | (((g.ay[7] >> 3) & 1) << 1) : g.ay[reg] & msk[reg]);
      for (const [reg, v] of want) if (val(reg) !== v) return `${label}: AY_SHADOW[${reg}] = ${g.ay[reg]}, want ${v} (record ${r} of effect ${w.sfx.index})`;
    } else if (!w.sfx.active && (g.ay[8] & 15) !== 0) return `${label}: AY_SHADOW[8] = ${g.ay[8]} but no effect is playing`;
  }
  return null;
}
function diffRun(got, want, ctx) {
  let d = got.init ? diffTick('after INIT', got.init, want.init, ctx) : null;
  if (d) return d;
  for (let t = 0; t < want.ticks.length; t++) { d = diffTick(`tick ${t + 1}`, got.ticks[t], want.ticks[t], ctx); if (d) return d; }
  return null;
}
function ctxFor(src, assets, skip = [], extra = {}) {
  const p = parse(src).ast;
  const sfxLens = [], sfxBytes = [];
  for (const a of p.assets) if (a.kind === 'SFX') { const c = convertSfx(assets.sfx[a.asset]); sfxLens.push(c.records); sfxBytes.push(c.bytes); }
  const tsAsset = p.assets.find((a) => a.kind === 'TILESET');
  return { skip: new Set(skip), sfxLens, sfxBytes, tileBytes: tsAsset ? convertTileset(assets.tilesets[tsAsset.asset]).bytes : new Uint8Array(0), ...extra };
}

// ---- the games --------------------------------------------------------------------------------------------------
const GAMES = [];
const game = (name, src, opts = {}) => GAMES.push({ name, src, ...opts });
const HEAD = `GAME "m3"\nSPRITE ball = "ball"\nSPRITE bat = "bat"\nSPRITE big = "big"\nTILESET ts = "ts"\nSFX beep = "beep"\nSFX zap = "zap"\nSFX long = "long"\n`;

game('hello text (AT, items, comma, trailing ;, wrap)', `${HEAD}FRAMERATE 30
SCENE s
  DIM t, k
  PROC INIT():
    PRINT AT 2, 3; "HELLO, WORLD"
    PRINT "second line"
    PRINT AT 5, 0; "no newline ";
    PRINT "yet", "comma", "x";
    PRINT "ab" ; "cd" + "ef";
    PRINT AT 10, 20; "this text wraps at col 32, "; "goes on to the next row"
    PRINT
    PRINT AT 23, 28; "wrap to row 0: 0123456789"
    PRINT AT 12, 0; 12345; "|"; -7; "|"; 0; "|"; STR$(-32768); "|"; 3 * 3
  ENDP
  PROC FRAME():
    t = t + 1
    PRINT AT 14, 0; "tick "; t;
    PRINT "  "
    k = t MOD 7
    IF k = 3 THEN
      PRINT AT 16 + k, 10 + k; "k=", k
    ENDIF
  ENDP
ENDSCENE
`);

game('counters, negative numbers, widths (no padding)', `${HEAD}FRAMERATE 30
SCENE s
  DIM t, n, m, bg
  PROC INIT():
    bg = 32767
  ENDP
  PROC FRAME():
    t = t + 1
    n = 50 - t * 7
    m = n * n * 3
    bg = bg + 5000
    PRINT AT 1, 0; n; "   "
    PRINT AT 2, 0; m; "     "
    PRINT AT 3, 0; bg; "  ";
    PRINT AT 4, 0; "[";
    PRINT n DIV 3; "] ["; n MOD 5; "] ["; ABS(n); "]    "
    IF t MOD 40 = 0 THEN
      CLS
    ENDIF
    PRINT AT 6, t MOD 26; t, -t
  ENDP
ENDSCENE
`);

game('tiles written in loops, out-of-range writes ignored', `${HEAD}FRAMERATE 30
SCENE s
  DIM t, i, j, x, y, n
  PROC INIT():
    FOR j = 0 TO 4
      FOR i = 0 TO 9
        TILE i + 5, j + 3 = (i + j) MOD 5
      NEXT i
    NEXT j
  ENDP
  PROC FRAME():
    t = t + 1
    x = t MOD 40 - 4
    y = t DIV 6 MOD 28 - 2
    n = t MOD 7 - 1
    TILE x, y = n
    TILE 31, 23 = t MOD 5
    TILE 0, 0 = 4
    FOR i = 0 TO 2
      TILE 20 + i, 10 + i = i + 1
    NEXT i
    IF t MOD 25 = 0 THEN
      x = 40 : TILE x, 3 = 1
      x = 0 - 1 : TILE x, 3 = 1
      y = 30 : TILE 3, y = 1
      n = 9 : TILE 3, 3 = n
    ENDIF
  ENDP
ENDSCENE
`);

game('TILEAT readback (tile, text, out of range)', `${HEAD}FRAMERATE 30
SCENE s
  DIM t, a, b, c, d, e, sum, x
  PROC INIT():
    PRINT AT 4, 4; "text"
    TILE 8, 8 = 3
  ENDP
  PROC FRAME():
    t = t + 1
    x = t MOD 12
    TILE x, 8 = t MOD 5
    a = TILEAT(x, 8)
    b = TILEAT(4, 4)
    c = TILEAT(x + 30, 8)
    d = TILEAT(8, 8)
    e = TILEAT(5, 0 - t MOD 3)
    sum = sum + a + d
    IF a = t MOD 5 THEN
      PRINT AT 10, 0; "ok ";
    ELSE
      PRINT AT 10, 0; "BAD";
    ENDIF
    PRINT AT 11, 0; a; " "; b; " "; c; " "; d; " "; e; "   "
    IF TILEAT(0, 11) = 0 - 1 THEN
      PRINT AT 12, 0; "cell is text"
    ENDIF
  ENDP
ENDSCENE
`);

game('collision between two moving sprites (HIT, hot boxes, HIDE)', `${HEAD}FRAMERATE 30
SCENE s
  DIM t, ax, ay, bx, by, h1, h2, h3, hits
  PROC INIT():
    ax = 10 : ay = 60 : bx = 200 : by = 60
  ENDP
  PROC FRAME():
    t = t + 1
    ax = ax + 1
    bx = bx - 1
    ay = 60 + t MOD 9
    by = 64
    SHOW ball AT ax, ay
    SHOW bat AT bx, by
    SHOW big AT 100, 100 + t MOD 40
    h1 = HIT(ball, bat)
    h2 = HIT(bat, ball)
    h3 = HIT(ball, big) + HIT(big, bat) * 2
    hits = hits + h1
    IF t = 90 THEN
      HIDE bat
    ENDIF
    IF t = 120 THEN
      SHOW bat AT ax, ay
    ENDIF
    IF h1 = 1 THEN
      PRINT AT 2, 2; "HIT ";
    ELSE
      PRINT AT 2, 2; "    ";
    ENDIF
    PRINT AT 3, 2; hits; " "; h3; "  "
  ENDP
ENDSCENE
`, { stick: null });

game('PLAY at events, replacing an effect, SILENCE', `${HEAD}FRAMERATE 30
SCENE s
  DIM t
  PROC INIT():
  ENDP
  PROC FRAME():
    t = t + 1
    IF t = 5 THEN
      PLAY beep
    ENDIF
    IF t = 12 THEN
      PLAY long
    ENDIF
    IF t = 20 THEN
      PLAY zap
    ENDIF
    IF t = 30 THEN
      PLAY long
    ENDIF
    IF t = 34 THEN
      SILENCE
    ENDIF
    IF t = 50 THEN
      PLAY zap
    ENDIF
    IF t = 51 THEN
      PLAY beep
    ENDIF
    IF t = 60 THEN
      PLAY long
    ENDIF
    PRINT AT 0, 0; t;
  ENDP
ENDSCENE
`);

game('PLAY at 20 frames per second (frame_div 3)', `${HEAD}FRAMERATE 20
SCENE s
  DIM t
  PROC INIT():
  ENDP
  PROC FRAME():
    t = t + 1
    IF t MOD 20 = 3 THEN
      PLAY beep
    ENDIF
    IF t MOD 20 = 11 THEN
      PLAY zap
    ENDIF
    IF t MOD 50 = 40 THEN
      SILENCE
    ENDIF
  ENDP
ENDSCENE
`);

game('INK / PAPER / BRIGHT combinations', `${HEAD}FRAMERATE 30
SCENE s
  DIM t, c
  PROC INIT():
    INK 7 : PAPER 0
    PRINT AT 0, 0; "white on black"
    INK 2 : PAPER 6 : BRIGHT 1
    PRINT "red on yellow bright"
    BRIGHT 0
    PRINT "red on yellow"
    INK 0 : PAPER 7
    PRINT "default again"
  ENDP
  PROC FRAME():
    t = t + 1
    c = t MOD 8
    INK c
    PAPER 7 - c
    BRIGHT t DIV 8 MOD 2
    PRINT AT 8 + c, c * 3; "colour "; c;
    IF t MOD 50 = 49 THEN
      INK c + 9 : PAPER c + 15 : BRIGHT c + 3
      PRINT AT 20, 0; "masked values"
    ENDIF
    IF t = 70 THEN
      PAPER 5
      BRIGHT 0
      CLS
      PRINT AT 0, 0; "after CLS (paper 5)"
    ENDIF
  ENDP
ENDSCENE
`);

game('PRINT AT clamping and cursor wrap', `${HEAD}FRAMERATE 30
SCENE s
  DIM t, r, c
  PROC INIT():
  ENDP
  PROC FRAME():
    t = t + 1
    r = t * 3 - 20
    c = t * 5 - 50
    PRINT AT r, c; "X";
    PRINT AT r MOD 24, 30; "wrap"
    IF t MOD 3 = 0 THEN
      PRINT AT 22, 31; "ab"; t
    ENDIF
    PRINT AT 0, 0; r; " "; c; "  "
  ENDP
ENDSCENE
`);

game('Breakout-like: bricks (tiles), score text, bat (STICK script), ball, HIT, sounds', `${HEAD}FRAMERATE 30
SCENE s
  DIM bx, by, dx, dy, px, score, lives, t, i, j, c, cx, cy, left
  PROC INIT():
    PRINT AT 0, 1; "SCORE";
    PRINT AT 0, 22; "LIVES 3";
    FOR j = 3 TO 6
      FOR i = 4 TO 27
        TILE i, j = (j - 3) MOD 3
      NEXT i
    NEXT j
    left = 96 : lives = 3
    px = 100 : bx = 120 : by = 120 : dx = 2 : dy = -2
  ENDP
  PROC FRAME():
    t = t + 1
    IF BIT(STICK(1), 2) THEN
      px = px - 4
    ENDIF
    IF BIT(STICK(1), 3) THEN
      px = px + 4
    ENDIF
    IF px < 0 THEN
      px = 0
    ENDIF
    IF px > 240 THEN
      px = 240
    ENDIF
    bx = bx + dx
    by = by + dy
    IF bx < 0 OR bx > 248 THEN
      dx = -dx
      bx = bx + dx
      PLAY zap
    ENDIF
    IF by < 8 THEN
      dy = -dy
      by = 8
    ENDIF
    cx = (bx + 4) DIV 8
    cy = (by + 4) DIV 8
    c = TILEAT(cx, cy)
    IF c >= 0 AND c < 3 THEN
      TILE cx, cy = 4
      dy = -dy
      score = score + 10 * (3 - c)
      left = left - 1
      PLAY beep
      PRINT AT 0, 7; score
    ENDIF
    SHOW bat AT px, 176
    SHOW ball AT bx, by
    IF HIT(ball, bat) AND dy > 0 THEN
      dy = -dy
      PLAY long
    ENDIF
    IF by > 184 THEN
      lives = lives - 1
      by = 100 : dy = -2
      PRINT AT 0, 28; lives
    ENDIF
  ENDP
ENDSCENE
`, { stick: (t) => (t % 40 < 18 ? 4 : t % 40 < 24 ? 0 : 8) });

game('MAP preload and TILEAT over it', `${HEAD}MAP level = "level"
FRAMERATE 30
SCENE s
  DIM t, a, b, c
  PROC INIT():
    PRINT AT 1, 8; "over the map"
  ENDP
  PROC FRAME():
    t = t + 1
    a = TILEAT(t MOD 8, 1)
    b = TILEAT(2, 2)
    c = TILEAT(5, 0)
    TILE t MOD 6, 2 = 2
    PRINT AT 6, 0; a; " "; b; " "; c; "  "
  ENDP
ENDSCENE
`, { soft: true });

game('score HUD with sprites hidden and shown, 60 fps', `${HEAD}FRAMERATE 60
SCENE s
  DIM t, x, score
  PROC INIT():
    x = 0
  ENDP
  PROC FRAME():
    t = t + 1
    x = (x + 3) MOD 230
    SHOW ball AT x, 90
    SHOW bat AT 100, 90
    IF HIT(ball, bat) THEN
      score = score + 1
      PLAY zap
    ENDIF
    IF t MOD 2 = 0 THEN
      PRINT AT 0, 0; "SCORE "; score; " "
    ENDIF
    IF t = 100 THEN
      HIDE ball
    ENDIF
  ENDP
ENDSCENE
`);

// ---- ambiguity probes: the mock must agree (they are hard there); on the real runtime a difference is only a NOTE ----
const PROBES = [];
const probe = (name, src, opts = {}) => PROBES.push({ name, src, ...opts });
probe('CLS keeps no bright: attribute after CLS with BRIGHT 1, PAPER 3 is paper << 3', `${HEAD}FRAMERATE 30
SCENE s
  DIM t
  PROC INIT():
  ENDP
  PROC FRAME():
    t = t + 1
    IF t = 3 THEN
      BRIGHT 1 : PAPER 3 : INK 6
      CLS
      PRINT "x"
    ENDIF
  ENDP
ENDSCENE
`);
probe('cursor right after exactly filling a row is already on the next row (eager wrap)', `${HEAD}FRAMERATE 30
SCENE s
  DIM t
  PROC INIT():
  ENDP
  PROC FRAME():
    t = t + 1
    IF t = 2 THEN
      PRINT AT 3, 0; "0123456789012345678901234567890"; "1";
    ENDIF
    IF t = 4 THEN
      PRINT "next"
    ENDIF
  ENDP
ENDSCENE
`);
probe('V_SFX_ACTIVE and AY_SHADOW at the very refresh that plays the last record', GAMES.find((g) => g.name.startsWith('PLAY at events')).src, { strictBoundary: true });
probe('PLAY then SILENCE in the same tick, and PLAY twice', `${HEAD}FRAMERATE 30
SCENE s
  DIM t
  PROC INIT():
  ENDP
  PROC FRAME():
    t = t + 1
    IF t = 3 THEN
      PLAY long
      SILENCE
    ENDIF
    IF t = 6 THEN
      PLAY zap
      PLAY beep
    ENDIF
  ENDP
ENDSCENE
`);

const gameAssets = ASSETS;
const interpFor = (g, ticks, stick) => {
  const { ast } = parse(g.src);
  return interpret(ast, { ticks, stick: stick ?? g.stick ?? (() => 0), assets: gameAssets });
};

console.log(`\n4. Differential games on the MOCK runtime (${TICKS} ticks each: cell map, attribute map, cursor, SPR_TAB, variables, V_SFX_ACTIVE, AY_SHADOW)`);
for (const g of GAMES) {
  let detail, ok = false;
  try {
    const res = compileM(g.src);
    if (res.errors.length) throw new Error('compile: ' + res.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
    const want = interpFor(g, TICKS);
    const got = runMock(res, { ticks: TICKS, stick: g.stick });
    const d = diffRun(got, want, ctxFor(g.src, ASSETS));
    ok = d === null;
    const text = want.ticks.reduce((n, r) => n + r.cells.reduce((a, c) => a + (c !== 32 ? 1 : 0), 0), 0);
    detail = d ?? `${TICKS} ticks, ${Object.keys(want.init.vars).length} variables, ${res.usage.code} code bytes, ${Math.max(...got.tstates)} T worst tick; ${text} non-blank cell samples`;
  } catch (e) { detail = e.message; }
  check_(g.name, ok, detail);
}
// the games must exercise what they claim to: spot checks on the interpreter
{
  const rec = (name) => { const g = GAMES.find((x) => x.name.startsWith(name)); return interpFor(g, TICKS); };
  const hit = rec('collision');
  check_('collision game: HIT is 0 before, 1 during and 0 after the crossing', hit.ticks.some((r) => r.vars.H1 === 1) && hit.ticks[0].vars.H1 === 0 && hit.ticks.at(-1).vars.H1 === 0 || TICKS < 150, `hits ${hit.ticks.at(-1).vars.HITS}`);
  const sfxg = rec('PLAY at events');
  check_('sound game: effects start, get replaced and stop (V_SFX_ACTIVE both 0 and 1 are seen)', sfxg.ticks.some((r) => r.sfx.active) && sfxg.ticks.some((r) => !r.sfx.active && r.tick > 6) || TICKS < 150);
  const tl = rec('TILEAT');
  check_('TILEAT game: reads tiles back, text -1, out of range -1', tl.ticks.some((r) => r.vars.B === -1 && r.vars.C === -1 && r.vars.A >= 0));
  const br = rec('Breakout-like');
  check_('Breakout-like game: bricks are removed and the score grows', br.ticks.at(-1).vars.SCORE > 0 || TICKS < 150, `score ${br.ticks.at(-1).vars.SCORE}`);
}

console.log('\n4b. Ambiguity probes on the mock (hard here; on the real runtime a difference is a NOTE)');
for (const g of PROBES) {
  let detail, ok = false;
  try {
    const res = compileM(g.src);
    if (res.errors.length) throw new Error('compile: ' + res.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
    const want = interpFor(g, 40);
    const d = diffRun(runMock(res, { ticks: 40 }), want, ctxFor(g.src, ASSETS, [], { strictBoundary: !!g.strictBoundary }));
    ok = d === null; detail = d ?? '40 ticks';
  } catch (e) { detail = e.message; }
  check_(g.name, ok, detail);
}

// =================================================================================================================
// 5. The example game
// =================================================================================================================
console.log('\n5. Example: arcade/tests/fixtures/breakout-v1.arc');
const EX_STICK = (t) => (t < 700 ? 8 : t % 30 < 3 ? 16 : 0);
const EX_SRC = join(ROOT, 'arcade/tests/fixtures/breakout-v1.arc'), EX_ASSETS = join(ROOT, 'arcade/tests/fixtures/breakout-v1.assets.json');
let exampleSrc = null, exampleAssets = null;
if (existsSync(EX_SRC) && existsSync(EX_ASSETS)) {
  exampleSrc = readFileSync(EX_SRC, 'utf8'); exampleAssets = JSON.parse(readFileSync(EX_ASSETS, 'utf8'));
  const r = compileM(exampleSrc, exampleAssets);
  check_('breakout.arc compiles with no errors and no warnings', r.errors.length === 0 && r.warnings.length === 0, msgs(r.errors) + msgs(r.warnings));
  if (r.usage) console.log(`  size: code+data ${r.usage.code} bytes (strings and hot boxes ${r.usage.data.strings}, tileset ${r.usage.data.tileset}, sound ${r.usage.data.sfx}), sprites ${r.usage.spriteData}, variables ${r.usage.varBytes}, image ${r.usage.total} of 16384 bytes`);
  // the bat is held to the right so the ball is missed: three lives are lost (GAME OVER at tick 311), fire pulses from tick 700 restart the game
  const stick = EX_STICK;
  const NT = QUICK ? 350 : 1000;
  const want = (() => { const { ast } = parse(exampleSrc); return interpret(ast, { ticks: NT, stick, assets: exampleAssets }); })();
  const got = runMock(r, { ticks: NT, stick });
  const d = diffRun(got, want, ctxFor(exampleSrc, exampleAssets));
  check_(`breakout.arc: ${NT} ticks on the mock match the interpreter`, d === null, d ?? `final score ${want.ticks.at(-1).vars.SCORE}, lives ${want.ticks.at(-1).vars.LIVES}, bricks left ${want.ticks.at(-1).vars.LEFT}`);
  const ts = got.tstates;
  const sorted = [...ts].sort((a, b) => a - b);
  console.log(`  PROC FRAME on the mock (runtime calls cost 0 here): min ${sorted[0]} T, median ${sorted[sorted.length >> 1]} T, max ${sorted.at(-1)} T per tick (a 30 fps tick is 117,376 T)`);
  check_('the game plays: bricks removed, lives lost, game over reached and restarted by fire', want.ticks.some((r) => r.vars.LEFT < 180) && want.ticks.some((r) => r.vars.LIVES < 3) || QUICK, `left ${want.ticks.at(-1).vars.LEFT}`);
  // game over: screen shows the text
  const goTick = want.ticks.findIndex((r) => r.vars.STATE === 1);
  if (goTick >= 0) {
    const row = (rec, r) => String.fromCharCode(...rec.cells.slice(r * 32, r * 32 + 32).map((c) => (c >= 32 && c < 128 ? c : 46)));
    check_('after the last life the screen says GAME OVER (cells of the interpreter and of the compiled game)', /GAME OVER/.test(row(want.ticks[goTick], 11)) && /GAME OVER/.test(row(got.ticks[goTick], 11)), row(got.ticks[goTick], 11));
  } else console.log('  (the scripted run does not reach GAME OVER within this many ticks)');
} else console.log('  breakout.arc / breakout.assets.json not found: skipped');

// ---- the JavaScript compositor: cells (font glyphs, tiles) + attributes + sprites -> 256 x 192 ink plane and 768 attributes ----
const FONT = (() => {            // the glyphs come from the generated font source, not from the runtime image
  const t = readFileSync(join(ROOT, 'arcade/runtime/v1/font.inc'), 'utf8');
  const bytes = [];
  for (const line of t.slice(t.indexOf('FONT_GLYPHS:')).split('\n').slice(1)) {
    const m = line.split(';')[0].match(/DB\s+(.*)/i);
    if (m) for (const v of m[1].split(',')) bytes.push(parseInt(v.trim().replace('$', ''), 16));
    if (bytes.length >= 768) break;
  }
  return bytes.slice(0, 768);
})();
function compose(rec, ctx, sprites) {
  const plane = new Uint8Array(192 * 32);                 // row-major bytes, bit 7 = leftmost pixel
  for (let cell = 0; cell < 768; cell++) {
    const v = rec.cells[cell], cr = (cell / 32) | 0, cc = cell % 32;
    for (let y = 0; y < 8; y++) {
      plane[(cr * 8 + y) * 32 + cc] = v & 0x80 ? ctx.tileBytes[(v & 0x7F) * 9 + y] : (v >= 32 && v < 128 ? FONT[(v - 32) * 8 + y] : 0);
    }
  }
  rec.sprites.forEach((sp, i) => {
    if (!sp.visible || !sprites[i]) return;
    const d = sprites[i].data;
    for (let r = 0; r < sprites[i].h; r++) {
      const mask = (d[4 * r] << 8) | d[4 * r + 1], image = (d[4 * r + 2] << 8) | d[4 * r + 3];
      for (let b = 0; b < 16; b++) {
        if ((mask >> (15 - b)) & 1) continue;               // background shows
        const px = sp.x + b, py = sp.y + r;
        const bit = 0x80 >> (px & 7), at = py * 32 + (px >> 3);
        plane[at] = (image >> (15 - b)) & 1 ? plane[at] | bit : plane[at] & ~bit;
      }
    }
  });
  return plane;
}
const ZX_ROW = (y) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);
/** The displayed display file of a real machine as the same row-major plane and the 768 attributes. */
function displayed(m, SYM) {
  const file = m.ram[SYM.V_SHADOW_FF] & 7;
  const bmp = file === 0 ? SYM.DFILE0 : SYM.DFILE1, att = file === 0 ? SYM.DATTR0 : SYM.DATTR1;
  const plane = new Uint8Array(192 * 32);
  for (let y = 0; y < 192; y++) for (let x = 0; x < 32; x++) plane[y * 32 + x] = m.ram[bmp + ZX_ROW(y) + x];
  return { plane, attrs: m.ram.slice(att, att + 768), file };
}
function diffPicture(label, got, want, wantPlane) {
  for (let i = 0; i < 768; i++) if (got.attrs[i] !== want.attrs[i]) return `${label}: displayed attribute (row ${(i / 32) | 0}, col ${i % 32}) = $${got.attrs[i].toString(16)}, expected $${want.attrs[i].toString(16)}`;
  for (let y = 0; y < 192; y++) for (let x = 0; x < 32; x++) {
    const a = got.plane[y * 32 + x], b = wantPlane[y * 32 + x];
    if (a !== b) return `${label}: displayed pixel byte at row ${y}, byte column ${x} (cell row ${y >> 3}, col ${x}) = $${a.toString(16)}, compositor $${b.toString(16)}`;
  }
  return null;
}

// =================================================================================================================
// R. The real v1 runtime
// =================================================================================================================
const RT_JSON = join(ROOT, 'arcade/build/v1/runtime.json');
if (existsSync(RT_JSON)) {
  console.log('\nR. End to end on the REAL v1 runtime (boot the DCK on a stock TS2068)');
  const rt = JSON.parse(readFileSync(RT_JSON, 'utf8'));
  const img = new Uint8Array(readFileSync(join(dirname(RT_JSON), rt.image ?? 'runtime.bin')));
  const SYM = rt.symbols;
  const need = ['RT_AT', 'RT_PRINTS', 'RT_PRINTN', 'RT_INK', 'RT_PAPER', 'RT_BRIGHT', 'RT_CLS', 'RT_TILE', 'RT_TILEAT', 'RT_HIT', 'RT_PLAY', 'RT_SILENCE', 'CELL_TILE', 'CELL_ATTR', 'V_TEXT_ATTR', 'V_CUR_ROW', 'V_CUR_COL', 'V_SFX_ACTIVE', 'SPR_TAB', 'V_TICKS', 'V_FRAMES'];
  const missing = need.filter((n) => SYM[n] === undefined);
  check_('runtime.json has version 1 and every symbol the compiler and tests use', rt.version === 1 && missing.length === 0, missing.join(' ') || `version ${rt.version}`);
  if (rt.version === 1 && missing.length === 0) {
    const ROMDIR = join(TSRUN, 'roms');
    const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
    function runReal(res, { ticks, stick = null }) {
      const m = bootedMachine(res.dck);                       // restored from the boot snapshot (V9), video off (V8)
      const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
      const snap = () => ({
        vars: Object.fromEntries(Object.entries(res.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
        sprites: Array.from({ length: 4 }, (_, i) => ({ visible: m.ram[SYM.SPR_TAB + 6 * i], x: rd16(SYM.SPR_TAB + 6 * i + 2), y: rd16(SYM.SPR_TAB + 6 * i + 4) })),
        cells: m.ram.slice(SYM.CELL_TILE, SYM.CELL_TILE + 768), attrs: m.ram.slice(SYM.CELL_ATTR, SYM.CELL_ATTR + 768),
        cursor: { row: m.ram[SYM.V_CUR_ROW], col: m.ram[SYM.V_CUR_COL] }, textAttr: m.ram[SYM.V_TEXT_ATTR],
        sfxActive: m.ram[SYM.V_SFX_ACTIVE], ay: SYM.AY_SHADOW !== undefined ? m.ram.slice(SYM.AY_SHADOW, SYM.AY_SHADOW + 16) : null,
      });
      const out = { init: null, ticks: [], error: null, machine: m, pictures: new Map() };
      const div = res.memory[0x8004];
      let pending = -1;                                          // a tick whose displayed picture is due after the next refresh
      const codeLo = res.gen.base, codeHi = res.gen.base + res.gen.code.length;
      const maxFrames = 400 + (ticks + 2) * div * 3;
      for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
      for (let f = 0; f < maxFrames && out.ticks.length < ticks; f++) {
        const k = out.ticks.length + 1;
        const sv = stick ? stick(k) : 0;
        m.joystick[0] = contact(typeof sv === 'number' ? sv : sv[1] | 0);
        m.joystick[1] = contact(typeof sv === 'number' ? 0 : sv[2] | 0);
        M_.runFrame(m);
        if (rd16(SYM.V_FRAMES) === 0) continue;
        const nt = rd16(SYM.V_TICKS);
        if (pending >= 0 && nt === pending) { out.pictures.set(pending, displayed(m, SYM)); pending = -1; }   // the refresh after tick `pending`: its picture is shown by now
        else if (pending >= 0) pending = -1;
        if (nt === k - 1) continue;
        if (nt !== k) { out.error = `V_TICKS went from ${k - 1} to ${nt} in one refresh`; break; }
        if (m.cpu.pc >= codeLo && m.cpu.pc < codeHi) { out.error = `tick ${k}: compiled code still running at the end of its refresh (pc ${hex(m.cpu.pc)})`; break; }
        out.ticks.push(snap());
        if (div >= 2 && k % 5 === 0) pending = k;
      }
      if (!out.error && out.ticks.length < ticks) out.error = `only ${out.ticks.length} of ${ticks} ticks ran (V_TICKS ${rd16(SYM.V_TICKS)})`;
      return out;
    }
    const realCompile = (src, assets) => compile(src, { runtime: rt, image: img, assets });
    const rtGames = [...GAMES, ...(exampleSrc ? [{ name: 'breakout.arc (example; lives lost, GAME OVER, restart by fire)', src: exampleSrc, stick: EX_STICK, assets: exampleAssets, ticks: QUICK ? 350 : 1000 }] : [])];
    for (const g of rtGames) {
      let detail, ok = false;
      const assets = g.assets ?? ASSETS;
      try {
        const res = realCompile(g.src, assets);
        if (res.errors.length) throw new Error('compile: ' + res.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
        const nT = g.ticks ?? TICKS;
        const want = (() => { const { ast } = parse(g.src); return interpret(ast, { ticks: nT, stick: g.stick ?? (() => 0), assets }); })();
        const got = runReal(res, { ticks: nT, stick: g.stick });
        if (got.error) throw new Error(got.error);
        // There is no INIT sample on the real runtime (INIT and tick 1 can share a refresh): compare the ticks only.
        const ctx = ctxFor(g.src, assets, [], { strictBoundary: !!g.strictBoundary });
        let d = diffRun({ init: null, ticks: got.ticks }, want, ctx);
        let pics = 0;
        if (d === null) for (const [k, pic] of got.pictures) {
          d = diffPicture(`picture after tick ${k} (file ${pic.file})`, pic, want.ticks[k - 1], compose(want.ticks[k - 1], ctx, res.gen.sprites));
          if (d) break;
          pics++;
        }
        ok = d === null; detail = d ?? `${nT} ticks, ${pics} displayed pictures compared with the compositor`;
      } catch (e) { detail = e.message; }
      if (g.soft) note(`real runtime: ${g.name}`, ok, detail); else check_(`real runtime: ${g.name}`, ok, detail);
    }
    for (const g of PROBES) {
      let detail, ok = false;
      try {
        const res = realCompile(g.src, ASSETS);
        if (res.errors.length) throw new Error('compile: ' + res.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
        const want = interpFor(g, 40);
        const got = runReal(res, { ticks: 40 });
        if (got.error) throw new Error(got.error);
        const d = diffRun({ init: null, ticks: got.ticks }, want, ctxFor(g.src, ASSETS, [], { strictBoundary: !!g.strictBoundary }));
        ok = d === null; detail = d ?? '40 ticks';
      } catch (e) { detail = e.message; }
      note(`real runtime, probe: ${g.name}`, ok, detail);
    }
  }
} else {
  console.log('\nR. End-to-end tests on the real v1 runtime: PENDING (arcade/build/v1/runtime.json does not exist yet).');
  console.log('   Build it (arcade/runtime/v1/) and run:  node tests/arcade-m3.mjs');
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: arcade-m3 (${passed} checks passed, ${failed} failed${notes ? `, ${notes} notes` : ''})`);
process.exitCode = failed ? 1 : 0;
