"use strict";
// arcade-m6-platformer-harness.mjs -- shared by tests/arcade-m6-platformer.mjs (and usable by hand): compiles arcade/examples/platformer.arc on the batch 2 MOCK runtime
// (tests/arcade-m6-mock.mjs) and runs it beside the reference interpreter.
//
// The mock of arcade-m6-mock.mjs implements only the routines of the window and the sprites (RT_SHOW/SHOWF/HIDE/HIT/CAMERA/WORLDTILE/TILEFLAGS/TILEHIT/SETWORLD, the multiplier,
// the divider, RT_STICK). The game also PLAYs sounds, prints its HUD, reads KEYDOWN and fills text cells, whose routines the mock does not have; here they are added as stubs
// that only RETURN (KEYDOWN returns HL = 0: no key is ever held, the scripts use the stick). They do not change anything the comparison reads (variables, arrays, SPR_TAB,
// WORLD_RAM, V_CAM), so the compiled code's logic is tested exactly; the picture, the cell map and the sound are the real runtime's own tests'.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { parse } from '../src/lang/arcade/arcade-parse.js';
import { interpret } from '../src/lang/arcade/arcade-interp.js';
import { compileMock, mockRuntime, runMock } from './arcade-m6-mock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EX = join(HERE, '..', 'arcade', 'examples');
export const PLATFORMER_SRC = readFileSync(join(EX, 'platformer.arc'), 'utf8');
export const PLATFORMER_ASSETS = JSON.parse(readFileSync(join(EX, 'platformer.assets.json'), 'utf8'));
export const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;

// stubs for the routines the mock lacks: address of each, and its bytes (RET, or LD HL,0 / RET for the ones that return a value)
const STUB_AT = 0xC700;
const STUB_NAMES = ['RT_PLAY', 'RT_SILENCE', 'RT_TILE', 'RT_TILEAT', 'RT_KEYDOWN', 'RT_PRINTN', 'RT_PRINTS', 'RT_AT', 'RT_INK', 'RT_PAPER', 'RT_BRIGHT', 'RT_CLS', 'RT_BORDER', 'RT_RANDOMISE', 'RT_FILLC'];
const RETURNS_VALUE = new Set(['RT_TILEAT', 'RT_KEYDOWN']);
function extended() {
  const base = mockRuntime();
  const probe = compileMock(`GAME "t"\nFRAMERATE 20\nTILESET ts = "ts"\nMAP level = "lv"\nWINDOW level\nSCENE s\n PROC INIT()\n ENDP\n PROC FRAME()\n ENDP\nENDSCENE\n`, { tilesets: { ts: { tiles: [{ rows: Array.from({ length: 8 }, () => ({ bits: 0, ink: 0, paper: 5, bright: 1 })), flags: 0 }] } }, maps: { lv: { w: 24, h: 1, cells: new Array(24).fill(0) } } });
  const image = new Uint8Array(65536);
  image.set(probe.memory.subarray(0xC000), 0xC000);
  const symbols = { ...base.symbols, V_CUR_ROW: 0xE0F0 };
  STUB_NAMES.forEach((n, i) => {
    const a = STUB_AT + 8 * i;
    if (RETURNS_VALUE.has(n)) { image[a] = 0x21; image[a + 1] = 0; image[a + 2] = 0; image[a + 3] = 0xC9; } else image[a] = 0xC9;
    symbols[n] = a;
  });
  return { runtime: { ...base, symbols }, image };
}
const EXT = extended();
export const compileOnMock = (src = PLATFORMER_SRC, assets = PLATFORMER_ASSETS) => compile(src, { runtime: EXT.runtime, image: EXT.image, assets });
export const runOnMock = (res, opts) => runMock(res, opts);
/** The reference interpreter's records for the same script. */
export const interpretPlatformer = (ticks, stick, { src = PLATFORMER_SRC, assets = PLATFORMER_ASSETS, ...o } = {}) =>
  interpret(parse(src).ast, { version: 3, ticks, assets, stick, maxSteps: 4_000_000_000, ...o });
