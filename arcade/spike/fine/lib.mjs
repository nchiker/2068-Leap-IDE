"use strict";
// lib.mjs -- F1 harness: assemble fine.asm (sjasmplus) with the scene data, build the DCK, boot it on TSRun's stock TS2068.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDck, chunksFromImage } from '../xip/mkdck.mjs';
import { placeData } from './scene.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
const TSRUN = join(HERE, '../../../tsrun');
export const M = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
export const Z = await import(pathToFileURL(join(TSRUN, 'z80.js')).href);
export const FRAME_T = M.tStatesPerFrame;            // 58,688
export const FIRST_PIXEL_T = 40 * 224 + 32;           // 8,992 T after the interrupt (TSRun's geometry)

/** The builds the spike measures: name -> sjasmplus defines. */
export const BUILDS = {
  A: { METHOD: 0 },                                   // direct, per instance in y order: erase the old cells, draw, repair overlaps
  B0: { METHOD: 1, BUFCELLS: 0 },                     // direct, per cell: each cell composed in one slot and written at once, top to bottom
  B80: { METHOD: 1, BUFCELLS: 80 },                   // compose and publish, 80 slots: PREFIX + slots = 1,536 bytes (MARK in a dirty map)
  B: { METHOD: 1, BUFCELLS: 254 },                    // compose and publish, buffer big enough for every tick of the scene
  BD: { METHOD: 1, BUFCELLS: 254, DIFF: 1 },          // as B, publishing only the groups that change (diffed against the screen at compose)
};

/** Assemble with the defines; returns {img (64 KB), syms, dck, dir}.  Writes build/<tag>/fine.dck. */
export function build(tag, defs = {}) {
  const dir = join(HERE, 'build', tag);
  mkdirSync(dir, { recursive: true });
  const args = ['--nologo', '--msg=war', `--lst=${join(dir, 'out.lst')}`, `--sym=${join(dir, 'out.sym')}`];
  for (const [k, v] of Object.entries(defs)) args.push(`-D${k}=${v}`);
  args.push(join(HERE, 'fine.asm'));
  try { execFileSync('sjasmplus', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { throw new Error('sjasmplus failed:\n' + (e.stdout || '') + (e.stderr || '')); }
  const img = new Uint8Array(readFileSync(join(dir, 'mem.bin')));
  const syms = {};
  for (const line of readFileSync(join(dir, 'out.sym'), 'utf8').split('\n')) {
    const m = line.match(/^(\S+):\s+EQU\s+0x([0-9A-Fa-f]+)/);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  placeData(img);
  const dck = buildDck(chunksFromImage(img, [0, 1, 4, 5]));
  writeFileSync(join(dir, 'fine.dck'), dck);
  return { img, syms, dck, dir };
}

/** A stock TS2068 (TSRun) with the DCK, reset. */
export function boot(dck) {
  const m = M.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  const err = (e) => { if (e) throw new Error(e); };
  err(M.setHomeRom(m, readFileSync(join(TSRUN, 'roms/ts2068-0.rom'))));
  err(M.setExRom(m, readFileSync(join(TSRUN, 'roms/ts2068-1.rom'))));
  err(M.insertDock(m, dck));
  M.resetMachine(m);
  return m;
}

/** Hooks writes to the harness marker; returns the list of {t (absolute T), v}. */
export function watchMarker(m, addr) {
  const log = [];
  const orig = m.bus.write;
  m.bus.write = (a, v) => { if (a === addr) log.push({ t: m.tstates, v, rel: m.tstates - m.frameStart }); orig(a, v); };
  return log;
}

/** Run frames until the cartridge is ready (marker 9); returns the frame count. */
export function runToReady(m, syms, max = 400) {
  for (let f = 1; f <= max; f++) { M.runFrame(m); if (m.ram[syms.V_MARKER] === 9 || m.ram[syms.V_MARKER] === 1 || m.ram[syms.V_MARKER] === 2) return f; }
  throw new Error('cartridge did not get ready');
}

/** Screen memory as {bits, colours} (indexed by address - $4000). */
export const screenOf = (m) => ({ bits: m.ram.slice(0x4000, 0x5800), colours: m.ram.slice(0x6000, 0x7800) });

/** Call a routine with registers set (interrupts off); returns T-states including the final RET. */
export function callAt(m, addr, regs = {}, stub = 0xFE80) {
  const sp = 0xFE00;
  m.cpu.sp = sp; m.ram[sp] = stub & 255; m.ram[sp + 1] = stub >> 8;
  for (const [k, v] of Object.entries(regs)) m.cpu[k] = v;
  m.cpu.pc = addr; m.cpu.iff1 = false; m.cpu.iff2 = false; m.cpu.halted = false;
  const t0 = m.tstates, cap = t0 + 50 * FRAME_T;
  while (m.cpu.pc !== stub) {
    if (m.tstates >= cap) throw new Error('routine did not return: $' + addr.toString(16));
    Z.runZ80(m.cpu, m.bus, 1, m);
  }
  return m.tstates - t0;
}
export { buildDck };
