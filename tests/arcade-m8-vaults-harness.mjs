"use strict";
// arcade-m8-vaults-harness.mjs -- shared by tests/arcade-m8-vaults.mjs and tests/arcade-m8-vaults-bot.mjs: compiles arcade/examples/vaults.arc on the batch 3 MOCK runtime v4
// (tests/arcade-m8-mock.mjs) and runs it beside the reference interpreter.
//
// The mock implements only the routines of the 3D view and the sprites (RT_VIEW / COSA / SINA / FXMUL / WALL / SETWALL, RT_SHOW / SHOWF / HIDE / HIT in ray mode, the multiplier,
// the divider, RT_STICK). The game also PLAYs sounds, prints its HUD, sets tiles and the border and reads KEYDOWN, whose routines the mock does not have; here they are added as
// stubs that only RETURN (KEYDOWN returns HL = 0: no key is ever held, the scripts use the stick). They change nothing the comparison reads (variables, arrays, SPR_TAB entries,
// the map array, the pose), so the compiled code's logic is tested exactly; the picture, the cell map and the sound are the real runtime's own tests'.
import { readFileSync } from 'node:fs';
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

// stubs for the routines the mock lacks: address of each, and its bytes (RET, or LD HL,0 / RET for the ones that return a value)
const STUB_AT = 0xC900;
const STUB_NAMES = ['RT_PLAY', 'RT_SILENCE', 'RT_TILE', 'RT_TILEAT', 'RT_KEYDOWN', 'RT_PRINTN', 'RT_PRINTS', 'RT_AT', 'RT_INK', 'RT_PAPER', 'RT_BRIGHT', 'RT_CLS', 'RT_BORDER', 'RT_RANDOMISE', 'RT_FILLC', 'RT_FILL', 'RT_COPY', 'RT_LOADMAP'];
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
  return { runtime: { ...base, symbols }, image };
}
const EXT = extended();
export const compileOnMock = (src = VAULTS_SRC, assets = VAULTS_ASSETS) => compile(src, { runtime: EXT.runtime, image: EXT.image, assets });
export const runOnMock = (res, opts) => runMock4(res, opts);
/** The reference interpreter's records for the same script (`billboard(tick, instance)` -> {depth, col} | undefined is what SEEN / DEPTH read). */
export const interpretVaults = (ticks, stick, { src = VAULTS_SRC, assets = VAULTS_ASSETS, ...o } = {}) =>
  interpret(parse(src).ast, { version: 4, ticks, assets, stick, maxSteps: 4_000_000_000, ...o });
