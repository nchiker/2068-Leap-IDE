"use strict";
// arcade-m8-vaults-harness.mjs -- shared by tests/arcade-m8-vaults.mjs and tests/arcade-m8-vaults-bot.mjs: compiles arcade/examples/vaults.arc on the batch 3 MOCK runtime v4
// (tests/arcade-m8-mock.mjs) and runs it beside the reference interpreter.
//
// The mock implements only the routines of the 3D view and the sprites (RT_VIEW / COSA / SINA / FXMUL / WALL / SETWALL, RT_SHOW / SHOWF / HIDE / HIT in ray mode, the multiplier,
// the divider, RT_STICK). The game also PLAYs sounds, prints its HUD, sets tiles and the border and reads KEYDOWN, whose routines the mock does not have; here they are added as
// stubs that only RETURN (KEYDOWN returns HL = 0: no key is ever held, the scripts use the stick). They change nothing the comparison reads (variables, arrays, SPR_TAB entries,
// the map array, the pose), so the compiled code's logic is tested exactly; the picture, the cell map and the sound are the real runtime's own tests'.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { mockRuntime4, MOCK_IMAGE, runMock4 } from './arcade-m8-mock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EX = join(HERE, '..', 'arcade', 'examples');
export const VAULTS_SRC = readFileSync(join(EX, 'vaults.arc'), 'utf8');
export const VAULTS_ASSETS = JSON.parse(readFileSync(join(EX, 'vaults.assets.json'), 'utf8'));
export const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;

// stubs for the routines the mock lacks (RT_VIEWMODE: the title scene's switch): address of each, and its bytes (RET, or LD HL,0 / RET for the ones that return a value)
const STUB_AT = 0xC900, PLANLOAD_AT = 0xC9C0;
const STUB_NAMES = ['RT_VIEWMODE', 'RT_PLAY', 'RT_SILENCE', 'RT_TILE', 'RT_TILEAT', 'RT_KEYDOWN', 'RT_PRINTN', 'RT_PRINTS', 'RT_AT', 'RT_INK', 'RT_PAPER', 'RT_BRIGHT', 'RT_CLS', 'RT_BORDER', 'RT_RANDOMISE', 'RT_FILLC', 'RT_FILL', 'RT_COPY', 'RT_LOADMAP'];
const RETURNS_VALUE = new Set(['RT_TILEAT', 'RT_KEYDOWN']);
function extended() {
  const base = mockRuntime4();
  const image = MOCK_IMAGE.slice();
  const symbols = { ...base.symbols, V_CUR_ROW: 0xE0F0 };
  STUB_NAMES.forEach((n, i) => {
    const a = STUB_AT + 8 * i;
    if (RETURNS_VALUE.has(n)) { image[a] = 0x21; image[a + 1] = 0; image[a + 2] = 0; image[a + 3] = 0xC9; } else image[a] = 0xC9;
    symbols[n] = a;
  });
  // language batch 7: the title is a NOVIEW scene, so ENTER calls RT_VIEWMODE (a stub here: the mock's sprite traps are ray mode only, which is also what the interpreter's records agree with
  // while the title's sprites stay inside the screen) and the linker plans the NOVIEW pool from the runtime's NV_POOL_* constants (the values of the real runtime)
  // RT_PLANLOAD (the game's `WORLD level`): HL = the plan's byte-RLE stream (pairs count, value; count 0 ends); the maze is 32 x 32, so the stream is the 1,024-byte WORLD_RAM array as it stands. A real Z80
  // routine (the mock's traps are JavaScript, this one is plain code that the compiled game calls): it decodes into WORLD_RAM, which is what the mock's WALL / SETWALL traps and the snapshots read.
  const planload = [0x11, base.constants.WORLD_RAM & 255, base.constants.WORLD_RAM >> 8,             // LD DE,WORLD_RAM
    0x7E, 0xB7, 0xC8, 0x47, 0x23, 0x7E, 0x23,                                                        // .l: LD A,(HL) / OR A / RET Z / LD B,A / INC HL / LD A,(HL) / INC HL
    0x12, 0x13, 0x10, 0xFC, 0x18, 0xF4];                                                              // .f: LD (DE),A / INC DE / DJNZ .f / JR .l
  planload.forEach((b, i) => { image[PLANLOAD_AT + i] = b; });
  symbols.RT_PLANLOAD = PLANLOAD_AT;
  const constants = { ...base.constants, BORDER_COLOUR: 1, NV_POOL_A: 0xCD00, NV_POOL_A_LEN: 256, NV_POOL_B: 0xEE00, NV_POOL_B_LEN: 3200, NV_POOL_C: 0xD700, NV_POOL_C_LEN: 256 };
  return { runtime: { ...base, symbols, constants }, image };
}
const EXT = extended();
export const compileOnMock = (src = VAULTS_SRC, assets = VAULTS_ASSETS) => compile(src, { runtime: EXT.runtime, image: EXT.image, assets });
export const runOnMock = (res, opts) => runMock4(res, opts);
/** The reference interpreter's records for the same script (`billboard(tick, instance)` -> {depth, col} | undefined is what SEEN / DEPTH read). */
export const interpretVaults = (ticks, stick, { src = VAULTS_SRC, assets = VAULTS_ASSETS, ...o } = {}) =>
  interpret(parse(src).ast, { version: 4, ticks, assets, stick, maxSteps: 4_000_000_000, ...o });

/** A digest (SHA-256, hex) of the game's state at ticks `from` .. `to` (1-based, inclusive) of an interpreter run: the play variables, every array, the visible sprites, the walls, the pose, the border, the
 *  cell and attribute maps, the text attribute and the sound. Ticks of Vaults as a game of ONE scene (the commit before the title became a scene of its own, 3a22ea1 + 34b3e4a) and of the game with
 *  the title and demo scenes give the same digest from the first tick of play on: the play did not change (tests/arcade-m8-vaults.mjs). Hidden sprites are not part of it (a reset leaves 0, 0). */
export function traceDigest(ticks, from, to) {
  const keys = ['ST', 'TT', 'FC', 'K3', 'PX', 'PY', 'PA', 'HP', 'SCORE', 'KEYS', 'GEMS', 'KILLS', 'INV', 'COOL', 'BT', 'MSG', 'MT', 'HUD', 'KA', 'KV', 'TV', 'LF', 'RG', 'FW', 'BK', 'FIRE', 'PFIRE', 'JS'];
  const arrays = ['EXS', 'EYS', 'GXS', 'GYS', 'PXS', 'PYS', 'EX', 'EY', 'EH', 'EA', 'EF', 'EV', 'GA', 'OA', 'GV', 'PV'];
  const h = createHash('sha256');
  for (let t = from; t <= to; t++) {
    const r = ticks[t - 1];
    h.update(JSON.stringify([t, keys.map((k) => r.vars[k]), arrays.map((k) => r.arrays[k]), r.sprites.map((s) => (s.visible ? s : 0)), Array.from(r.wallRam), r.view, r.border, Array.from(r.cells), Array.from(r.attrs), r.textAttr, r.sfx]));
  }
  return h.digest('hex');
}
