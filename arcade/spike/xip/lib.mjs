"use strict";
// Shared harness for the xip experiments: assemble with sjasmplus, build a DCK, boot TSRun with the stock ROMs.
import { readFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildDck, chunksFromImage } from './mkdck.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
const TSRUN = join(HERE, '../../../tsrun');
export const M = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
export const Z = await import(pathToFileURL(join(TSRUN, 'z80.js')).href);
export const FRAME_T = M.tStatesPerFrame; // 58,688 on TSRun
export const hex = (v, w = 4) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

/** Assemble src (sjasmplus) with -D defines; returns the 64 KB memory image (the source SAVEBINs "mem.bin"). */
export function assemble(src, defs = {}, tag = 'x') {
  const dir = join(HERE, 'build', tag);
  mkdirSync(dir, { recursive: true });
  const args = ['--nologo', '--lstlab', `--lst=${join(dir, 'out.lst')}`, `--sym=${join(dir, 'out.sym')}`];
  for (const [k, v] of Object.entries(defs)) args.push(`-D${k}=${v}`);
  args.push(join(HERE, src));
  try { execFileSync('sjasmplus', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] }); }
  catch (e) { throw new Error('sjasmplus failed:\n' + (e.stdout || '') + (e.stderr || '')); }
  const img = new Uint8Array(readFileSync(join(dir, 'mem.bin')));
  const syms = {};
  for (const line of readFileSync(join(dir, 'out.sym'), 'utf8').split('\n')) {
    const m = line.match(/^(\S+):\s+EQU\s+0x([0-9A-Fa-f]+)/);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  return { img, syms, dir };
}

/** New stock TS2068 with the DCK inserted and reset. */
export function boot(dck) {
  const keyMatrix = new Uint8Array(9).fill(0x1F);
  const joystick = new Uint8Array(2).fill(0xFF);
  const m = M.createMachine(keyMatrix, joystick);
  const err = (e) => { if (e) throw new Error(e); };
  err(M.setHomeRom(m, readFileSync(join(TSRUN, 'roms/ts2068-0.rom'))));
  err(M.setExRom(m, readFileSync(join(TSRUN, 'roms/ts2068-1.rom'))));
  err(M.insertDock(m, dck));
  M.resetMachine(m);
  return m;
}

/** Is the byte at addr currently read from the DOCK (not HOME ROM/RAM, not EXROM)? */
export const isDock = (m, addr) => (m.portF4 & (1 << (addr >>> 13))) !== 0 && (m.portFF & 0x80) === 0;

/** Run whole frames until pred(m) is true after a frame; returns the number of frames run (or -1). */
export function runFramesUntil(m, pred, max = 400) {
  for (let f = 1; f <= max; f++) { M.runFrame(m); if (pred(m)) return f; }
  return -1;
}

/**
 * One frame with per-instruction visibility. Steps with runZ80(budget 1) until close to the frame end, calling
 * onInstr(m) before each instruction, then lets runFrame finish the frame (it also raises the frame interrupt).
 * Do not use while the CPU is halted (a budget of 1 cannot advance a halted CPU).
 */
export function stepFrame(m, onInstr, tail = 64) {
  const end = m.frameStart + FRAME_T;
  while (m.tstates < end - tail) {
    if (m.cpu.halted) break;
    if (onInstr) onInstr(m);
    Z.runZ80(m.cpu, m.bus, 1, m);
  }
  M.runFrame(m);
}

let passed = 0, failed = 0;
export function check(name, ok, detail = '') {
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`);
  ok ? passed++ : failed++;
  return ok;
}
export function summary(title) {
  console.log(`${failed === 0 ? 'PASS' : 'FAIL'}: ${title} (${passed} checks passed, ${failed} failed)`);
  process.exitCode = failed === 0 ? 0 : 1;
  return failed === 0;
}
export { buildDck, chunksFromImage };
