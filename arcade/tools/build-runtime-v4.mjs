"use strict";
// build-runtime-v4.mjs -- assemble the Leap Arcade runtime v4 (arcade/runtime/v4/runtime.asm; the raycaster, docs/ARCADE_RAYCASTER_CONTRACT.md) with sjasmplus.  A copy of
// build-runtime-v3.mjs (v0-v3 untouched) pointed at the v4 sources, with the v4 constants (docs/ARCADE_RAYCASTER_CONTRACT.md section 2, docs/ARCADE_RUNTIME_API_V4.md).
//   node arcade/tools/build-runtime-v4.mjs        builds, prints chunk usage
// Writes into arcade/build/v4/ (docs/ARCADE_RUNTIME_API_V1.md):
//   runtime.bin   65,536-byte memory image: chunks 0-1 = runtime, chunks 4-5 = the placeholder game image
//   runtime.json  { version, symbols, constants, image }  (docs/ARCADE_RUNTIME_API.md)
//   runtime.inc   the symbols as EQUs, for assembling a game against this runtime (test_game.asm)
//   runtime.sym / runtime.lst / runtime.dck (the placeholder game, so the runtime boots alone)
// Importable:  buildRuntime() -> { img, syms, usage, dck, json };  assembleGame(asmFile, opts) -> { bytes, syms };
//   linkGame(runtimeImg, gameBytes) -> image with the game written at GAME_BASE;  dckOf(img).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDck, chunksFromImage, CHUNK } from './mkdck.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNTIME_DIR = join(HERE, '../runtime/v4');
export const OUT = join(HERE, '../build/v4');       // runtime.json, runtime.bin, runtime.inc, .sym, .lst, .dck
export const BUILD = OUT;
export const SHIPPED_CHUNKS = [0, 1, 4, 5];
const WORK = join(OUT, 'work');

/** Parse sjasmplus --sym output: NAME: EQU 0xHHHH. */
export function readSyms(file) {
  const syms = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^(\S+):\s+EQU\s+0x([0-9A-Fa-f]+)/);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  return syms;
}

function sjasm(args, cwd) {
  try { execFileSync('sjasmplus', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { throw new Error('sjasmplus failed:\n' + (e.stdout || '') + (e.stderr || '')); }
}

/** Bytes used per 8 KB chunk: the modules are labelled M_<name>_S / M_<name>_E in the sources. */
function chunkUsage(syms) {
  const mods = [];
  for (const k of Object.keys(syms)) {
    const m = k.match(/^M_(\w+)_S$/);
    if (m && syms[`M_${m[1]}_E`] !== undefined) mods.push({ name: m[1].toLowerCase(), from: syms[k], to: syms[`M_${m[1]}_E`] });
  }
  mods.sort((a, b) => a.from - b.from);
  const per = {};
  for (const c of SHIPPED_CHUNKS) per[c] = 0;
  for (const mod of mods) {
    mod.size = mod.to - mod.from;
    for (let a = mod.from; a < mod.to; a++) per[a >> 13] = (per[a >> 13] ?? 0) + 1;
  }
  return { mods, per };
}

/** Constants the contract names (docs/ARCADE_RUNTIME_API.md) plus the ones tests and the linker need. */
const CONSTANTS = ['GAME_BASE', 'GAME_VARS_BASE', 'GAME_VARS_LIMIT', 'MAX_SPRITES', 'STACK_TOP', 'STACK_CANARY', 'CANARY_VALUE',
  'SPR_XMAX', 'SPR_YMAX', 'SPR_W', 'SPR_H', 'RT_SEED_INIT', 'F4_PLAY', 'DFILE0', 'DFILE1', 'DATTR0', 'DATTR1',
  'BG_ATTR', 'GAME_HEADER_LEN', 'SD_LEN', 'GAME_INIT',
  'GAME_FRAME', 'GAME_DIV', 'GAME_NSPR', 'GAME_SPRTAB', 'GAME_TILESET', 'GAME_SFX', 'GAME_MAP', 'SD_DATA', 'SD_HOT',
  'CELL_TILE', 'CELL_ATTR', 'CELL_COUNT', 'CELL_ROWS', 'CELL_COLS', 'DIRTY0', 'DIRTY1', 'DIRTY_LEN', 'TILE_ATTR', 'GLYPH_TAB',
  'MAX_TILES', 'MAX_SFX', 'CELL_BLANK',
  // v2
  'MAX_ASSETS', 'SPR_ENT', 'SPR_ASSET_OFF', 'SPR_DRAWN_FILE', 'GAME_INSTTAB', 'STACK_LIMIT', 'POOL_A', 'POOL_A_LEN',
  'POOL_B', 'POOL_B_LEN', 'POOL_C', 'POOL_C_LEN', 'AST', 'AST_LEN', 'AST_H', 'AST_WB', 'AST_XMASK', 'AST_PHASES', 'AST_HOT',
  'SPR_TAB', 'INST_ASSET', 'SPR_DRAWN', 'T2_FREE', 'T2_FREE_LEN', 'T3', 'T3_LEN', 'SD_W', 'SD_H', 'SD_PHASES',
  // v3 part 1 (docs/ARCADE_PLATFORMER_CONTRACT.md sections 1, 2, 3b; docs/ARCADE_RUNTIME_API_V3.md)
  'DIV_WIN', 'GAME_WINDESC', 'GAME_HEADER_WIN_LEN', 'V3VARS', 'V3VARS_LEN', 'V_CAM', 'WORLD_RAM', 'WORLD_RAM_LEN', 'MAX_FRAMES', 'MAX_H',
  'SPR_FRAME_OFF', 'SPR_X_OFF', 'SPR_Y_OFF', 'SD_NFRAMES', 'PHASE_OFF', 'PHASE_OFF_LEN', 'PHASE_POOL_BYTES', 'POOL_FAIL_BORDER', 'FTE_LEN',
  'AST_NF', 'AST_NINST', 'AST_FTAB', 'AST_CLEN', 'AST_RR', 'AST_K', 'FC_MISS', 'FC_MISSES', 'T4_FREE', 'T4_FREE_LEN', 'VARS_CLEAR_LEN',
  // language batch 1 (tile operations)
  'RT_ARGS', 'RA_X', 'RA_Y', 'RA_W', 'RA_H', 'RA_V', 'RA_DX', 'RA_DY', 'GAME_MAPTAB', 'GAME_HEADER_EXT_LEN', 'DIV_EXT', 'MAX_MAPS', 'V_BORDER', 'V_NMAP', 'V_MAPTAB',
  'TO_BUFT', 'TO_BUFA', 'TO_VARS', 'RT_SEED', 'V_FRAMES',
  // v4 (the raycaster, docs/ARCADE_RAYCASTER_CONTRACT.md section 2; docs/ARCADE_RUNTIME_API_V4.md)
  'DIV_VIEW', 'GAME_VIEWDESC', 'VD_LEN', 'BB_TAB', 'BB_ENT', 'VIEW_W', 'VIEW_H', 'VIEW_CX', 'VIEW_CY', 'V_RAY', 'V4VARS', 'R4_END', 'RV_X', 'RV_Y', 'RV_A',
  'VD_COLW', 'VD_MAPW', 'VD_MAPH', 'MAP_RAM', 'RAY_BREC', 'RAY_COS', 'RAY_RECIP', 'RAY_HGT', 'RAY_HGT_LEN', 'RAY_PATM', 'RAY_HHR', 'RAY_PIR', 'RAY_DISTL',
  'RAY_DISTH', 'RAY_BLIST', 'RAY_BCODE', 'RAY_BCODE_LEN', 'RAY_RAM', 'RAY_RAM_LIMIT', 'RAY_RAM_END', 'WORLD_RAM_LEN'];

export function buildRuntime({ quiet = true } = {}) {
  mkdirSync(WORK, { recursive: true });
  const args = ['--nologo', `--lst=${join(OUT, 'runtime.lst')}`, `--sym=${join(OUT, 'runtime.sym')}`, `-I${RUNTIME_DIR}`,
    join(RUNTIME_DIR, 'runtime.asm')];
  sjasm(args, WORK);                                   // SAVEBIN's mem.bin lands in work/
  const img = new Uint8Array(readFileSync(join(WORK, 'mem.bin')));
  const all = readSyms(join(OUT, 'runtime.sym'));
  const syms = {};
  for (const [k, v] of Object.entries(all)) if (!k.includes('.') && !/^M_\w+_[SE]$/.test(k)) syms[k] = v;
  const constants = {};
  for (const k of CONSTANTS) { if (all[k] === undefined) throw new Error('missing constant ' + k); constants[k] = all[k]; }
  const json = { version: 4, symbols: syms, constants, image: 'runtime.bin' };
  writeFileSync(join(BUILD, 'runtime.bin'), img);
  writeFileSync(join(BUILD, 'runtime.json'), JSON.stringify(json, null, 2) + '\n');
  const inc = ['; runtime.inc -- GENERATED by arcade/tools/build-runtime.mjs from the runtime build; never hand-edit.']
    .concat(Object.entries(syms).map(([k, v]) => `${k} EQU $${v.toString(16).toUpperCase().padStart(4, '0')}`));
  writeFileSync(join(BUILD, 'runtime.inc'), inc.join('\n') + '\n');
  const dck = dckOf(img);
  writeFileSync(join(BUILD, 'runtime.dck'), dck);
  const usage = chunkUsage(all);
  if (!quiet) printUsage(usage, dck);
  return { img, syms: all, usage, dck, json };
}

/**
 * Assemble a game (a hand-written test game; the compiler's linker does not use this) against the runtime's symbols.
 * The source includes "runtime.inc" and ends with GAME_END and a SAVEBIN of $8000..GAME_END.  defines: { NAME: value }.
 * @returns {{ bytes: Uint8Array, syms: Record<string, number> }} bytes = the image from GAME_BASE
 */
export function assembleGame(asmFile, { name = basename(asmFile, '.asm'), defines = {} } = {}) {
  const dir = join(WORK, 'game-' + name);
  mkdirSync(dir, { recursive: true });
  const args = ['--nologo', `--lst=${join(dir, 'game.lst')}`, `--sym=${join(dir, 'game.sym')}`, `-I${BUILD}`, `-I${RUNTIME_DIR}`];
  for (const [k, v] of Object.entries(defines)) args.push(`-D${k}=${v}`);
  args.push(asmFile);
  sjasm(args, dir);
  return { bytes: new Uint8Array(readFileSync(join(dir, 'game.bin'))), syms: readSyms(join(dir, 'game.sym')) };
}

/** Copy of the runtime image with `gameBytes` written at GAME_BASE (the rest of chunks 4-5 filled with $FF). */
export function linkGame(runtimeImg, gameBytes, gameBase = 0x8000) {
  const out = new Uint8Array(runtimeImg);
  out.fill(0xFF, gameBase, gameBase + 2 * CHUNK);
  if (gameBytes.length > 2 * CHUNK) throw new Error('game image larger than DOCK chunks 4-5');
  out.set(gameBytes, gameBase);
  return out;
}

export function dckOf(img) { return buildDck(chunksFromImage(img, SHIPPED_CHUNKS)); }

export function printUsage({ mods, per }, dck) {
  const h = (v) => '$' + v.toString(16).padStart(4, '0');
  console.log(`arcade/build/v4/runtime.dck: ${dck.length} bytes (9 header + ${SHIPPED_CHUNKS.length} x ${CHUNK})`);
  console.log('  module           from    to    bytes');
  for (const m of mods) console.log(`  ${m.name.padEnd(14)} ${h(m.from)} ${h(m.to)}  ${String(m.size).padStart(5)}`);
  console.log(`  runtime (chunks 0-1): ${(per[0] ?? 0) + (per[1] ?? 0)} of 16384 bytes;  placeholder game (chunks 4-5): ${(per[4] ?? 0) + (per[5] ?? 0)} bytes`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildRuntime({ quiet: false });
