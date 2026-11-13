"use strict";
// build-runtime-v1.mjs -- assemble the Leap Arcade runtime v1 (arcade/runtime/v1/runtime.asm) with sjasmplus.  A copy of
// build-runtime.mjs (v0, untouched) pointed at the v1 sources, with the v1 constants.
//   node arcade/tools/build-runtime-v1.mjs        builds, prints chunk usage
// Writes into arcade/build/v1/ (docs/ARCADE_RUNTIME_API_V1.md):
//   runtime.bin   65,536-byte memory image: chunks 0-1 = runtime, chunks 4-5 = the placeholder game image
//   runtime.json  { version, symbols, constants, image }  (docs/ARCADE_RUNTIME_API.md)
//   runtime.inc   the symbols as EQUs, for assembling a game against this runtime (test_game.asm)
//   runtime.sym / runtime.lst / runtime.dck (the placeholder game, so the runtime boots alone)
// Importable:  buildRuntime() -> { img, syms, usage, dck, json };  assembleGame(asmFile, opts) -> { bytes, syms };
//   linkGame(runtimeImg, gameBytes) -> image with the game written at GAME_BASE;  dckOf(img).
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDck, chunksFromImage, CHUNK } from './mkdck.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNTIME_DIR = join(HERE, '../runtime/v1');
export const OUT = join(HERE, '../build/v1');       // runtime.json, runtime.bin, runtime.inc, .sym, .lst, .dck
export const BUILD = OUT;
export const SHIPPED_CHUNKS = [0, 1, 4, 5];
const WORK = join(OUT, 'work');

// Atomic write: a unique temp name in the same directory, then rename over the target, so a parallel reader sees the old or the new complete file.
let tmpCounter = 0;
function writeAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${tmpCounter++}`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

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
  'SPR_XMAX', 'SPR_YMAX', 'SPR_W', 'SPR_H', 'RT_SEED_INIT', 'F4_PLAY', 'DFILE0', 'DFILE1', 'DATTR0', 'DATTR1', 'ROW_TAB',
  'PHASE_TAB', 'PHASE_SPR_LEN', 'PHASE_LEN', 'FREE_RAM6', 'BG_ATTR', 'GAME_HEADER_LEN', 'SD_LEN', 'GAME_INIT',
  'GAME_FRAME', 'GAME_DIV', 'GAME_NSPR', 'GAME_SPRTAB', 'GAME_TILESET', 'GAME_SFX', 'GAME_MAP', 'SD_DATA', 'SD_HOT',
  'CELL_TILE', 'CELL_ATTR', 'CELL_COUNT', 'CELL_ROWS', 'CELL_COLS', 'DIRTY0', 'DIRTY1', 'DIRTY_LEN', 'TILE_ATTR', 'GLYPH_TAB',
  'MAX_TILES', 'MAX_SFX', 'CELL_BLANK'];

export function buildRuntime({ quiet = true } = {}) {
  // run-all --jobs: one work directory per step (the lst / sym are assembled there and copied over OUT afterwards)
  const tag = process.env.ARCADE_JOB_TAG;
  const work = tag ? join(WORK, 'rt-' + tag) : WORK;
  mkdirSync(work, { recursive: true });
  const lstFile = tag ? join(work, 'runtime.lst') : join(OUT, 'runtime.lst');
  const symFile = tag ? join(work, 'runtime.sym') : join(OUT, 'runtime.sym');
  const args = ['--nologo', `--lst=${lstFile}`, `--sym=${symFile}`, `-I${RUNTIME_DIR}`,
    join(RUNTIME_DIR, 'runtime.asm')];
  sjasm(args, work);                                   // SAVEBIN's mem.bin lands in build/v0/
  const img = new Uint8Array(readFileSync(join(work, 'mem.bin')));
  const all = readSyms(symFile);
  if (tag) { writeAtomic(join(OUT, 'runtime.sym'), readFileSync(symFile)); writeAtomic(join(OUT, 'runtime.lst'), readFileSync(lstFile)); }
  const syms = {};
  for (const [k, v] of Object.entries(all)) if (!k.includes('.') && !/^M_\w+_[SE]$/.test(k)) syms[k] = v;
  const constants = {};
  for (const k of CONSTANTS) { if (all[k] === undefined) throw new Error('missing constant ' + k); constants[k] = all[k]; }
  const json = { version: 1, symbols: syms, constants, image: 'runtime.bin' };
  writeAtomic(join(BUILD, 'runtime.bin'), img);
  writeAtomic(join(BUILD, 'runtime.json'), JSON.stringify(json, null, 2) + '\n');
  const inc = ['; runtime.inc -- GENERATED by arcade/tools/build-runtime.mjs from the runtime build; never hand-edit.']
    .concat(Object.entries(syms).map(([k, v]) => `${k} EQU $${v.toString(16).toUpperCase().padStart(4, '0')}`));
  writeAtomic(join(BUILD, 'runtime.inc'), inc.join('\n') + '\n');
  const dck = dckOf(img);
  writeAtomic(join(BUILD, 'runtime.dck'), dck);
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
  const dir = join(WORK, 'game-' + name + (process.env.ARCADE_JOB_TAG ? '-' + process.env.ARCADE_JOB_TAG : ''));   // run-all --jobs: one directory per step
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
  console.log(`arcade/build/v1/runtime.dck: ${dck.length} bytes (9 header + ${SHIPPED_CHUNKS.length} x ${CHUNK})`);
  console.log('  module           from    to    bytes');
  for (const m of mods) console.log(`  ${m.name.padEnd(14)} ${h(m.from)} ${h(m.to)}  ${String(m.size).padStart(5)}`);
  console.log(`  runtime (chunks 0-1): ${(per[0] ?? 0) + (per[1] ?? 0)} of 16384 bytes;  placeholder game (chunks 4-5): ${(per[4] ?? 0) + (per[5] ?? 0)} bytes`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildRuntime({ quiet: false });
