"use strict";
// build-m1.mjs -- assemble arcade/runtime/m1.asm with sjasmplus and build arcade/build/m1.dck.
//   node arcade/tools/build-m1.mjs             builds, prints chunk usage
//   import { buildM1 } from './build-m1.mjs'   returns { dck, img, syms, usage }
// The DCK is one bank-0 block with chunks 0, 1, 4, 5 (kind 2); the other four chunks are absent (kind 0).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDck, chunksFromImage, CHUNK } from './mkdck.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const RUNTIME = join(HERE, '../runtime');
export const BUILD = join(HERE, '../build');
export const SHIPPED_CHUNKS = [0, 1, 4, 5];

/** Parse sjasmplus --sym output: NAME: EQU 0xHHHH. */
function readSyms(file) {
  const syms = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^(\S+):\s+EQU\s+0x([0-9A-Fa-f]+)/);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  return syms;
}

/** Bytes used per 8 KB chunk: the modules are labelled M_<name>_S / M_<name>_E in the sources. */
function chunkUsage(syms) {
  const mods = [];
  for (const k of Object.keys(syms)) {
    const m = k.match(/^M_(\w+)_S$/);
    if (m && syms[`M_${m[1]}_E`] !== undefined) {
      mods.push({ name: m[1].toLowerCase(), from: syms[k], to: syms[`M_${m[1]}_E`] });
    }
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

/** slow: true assembles with -DM1_SLOW (the overrun test's main loop) into build/m1-slow.dck; the default output is m1.dck. */
export function buildM1({ quiet = true, slow = false } = {}) {
  mkdirSync(BUILD, { recursive: true });
  const tag = slow ? 'm1-slow' : 'm1';
  // sjasmplus writes SAVEBIN's mem.bin to the working directory, so the slow build gets its own one.
  const work = slow ? join(BUILD, 'slow') : BUILD;
  mkdirSync(work, { recursive: true });
  const args = ['--nologo', `--lst=${join(BUILD, tag + '.lst')}`, `--sym=${join(BUILD, tag + '.sym')}`];
  if (slow) args.push('-DM1_SLOW');
  args.push(`-I${RUNTIME}`, join(RUNTIME, 'm1.asm'));
  try { execFileSync('sjasmplus', args, { cwd: work, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { throw new Error('sjasmplus failed:\n' + (e.stdout || '') + (e.stderr || '')); }
  const img = new Uint8Array(readFileSync(join(work, 'mem.bin')));
  const syms = readSyms(join(BUILD, tag + '.sym'));
  const dck = buildDck(chunksFromImage(img, SHIPPED_CHUNKS));
  writeFileSync(join(BUILD, tag + '.dck'), dck);
  const usage = chunkUsage(syms);
  if (!quiet) printUsage(usage, dck);
  return { dck, img, syms, usage };
}

export function printUsage({ mods, per }, dck) {
  const h = (v) => '$' + v.toString(16).padStart(4, '0');
  console.log(`arcade/build/m1.dck: ${dck.length} bytes (9 header + ${SHIPPED_CHUNKS.length} x ${CHUNK})`);
  console.log('  module           from    to    bytes');
  for (const m of mods) console.log(`  ${m.name.padEnd(14)} ${h(m.from)} ${h(m.to)}  ${String(m.size).padStart(5)}`);
  console.log('  chunk  CPU range        used / 8192');
  for (const c of SHIPPED_CHUNKS) {
    console.log(`  ${c}      ${h(c * CHUNK)}-${h((c + 1) * CHUNK - 1)}    ${String(per[c] ?? 0).padStart(5)}`);
  }
  console.log(`  runtime (chunks 0-1): ${(per[0] ?? 0) + (per[1] ?? 0)} of 16384 bytes;  game (chunks 4-5): ${(per[4] ?? 0) + (per[5] ?? 0)} of 16384 bytes`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) buildM1({ quiet: false });
