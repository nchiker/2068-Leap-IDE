"use strict";
// Shared by the scroll spike: the world (map, tiles, attributes), the JS reference renderer, the TSRun harness.
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const { createMachine, setHomeRom, setExRom, resetMachine, tStatesPerFrame } = await import(join(ROOT, 'tsrun/machine.js'));
const { runZ80 } = await import(join(ROOT, 'tsrun/z80.js'));
export { tStatesPerFrame };

export const WW = 128, WH = 24, NTILES = 32;          // world cells; distinct tiles
export const CAM_MAX = WW * 8 - 256;                    // 768

// ---- the world: deterministic, so every variant and the reference see the same data -------------------------------
let seed = 0x1234;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >>> 8;
export function makeWorld(kind = 'dense') {
  seed = 0x1234;
  const tiles = new Uint8Array(256);                    // index tile*8 + row
  const tattr = new Uint8Array(256);                    // index tile*8 (other entries unused)
  for (let t = 0; t < NTILES; t++) {
    for (let r = 0; r < 8; r++) tiles[t * 8 + r] = t === 0 ? 0 : t === 1 ? 0xFF : rnd() & 0xFF;
    tattr[t * 8] = t === 0 ? 0x38 : ((rnd() & 0x3F) | 0x00) | (rnd() & 1 ? 0x40 : 0);
  }
  const map = new Uint8Array(WW * WH);                  // byte = tile*8
  for (let y = 0; y < WH; y++) for (let x = 0; x < WW; x++) {
    let t;
    if (kind === 'solid') t = 1 + (rnd() % 31);       // worst case for the blank-cell path: no blank cell anywhere
    else if (kind === 'level') {                             // a plausible platformer level: open sky, a few features, platforms, ground
      if (y >= 20) t = 1 + (rnd() % 31);
      else if (y >= 16) t = (rnd() % 4 === 0) ? 1 + (rnd() % 31) : 0;
      else if (y >= 8) t = (rnd() % 8 === 0) ? 1 + (rnd() % 31) : 0;
      else t = (rnd() % 50 === 0) ? 1 + (rnd() % 31) : 0;
    } else
    if (y >= 20) t = 1 + (rnd() % 31);                  // ground: all kinds
    else if (y >= 14) t = (rnd() % 3 === 0) ? 1 + (rnd() % 31) : 0;
    else t = (rnd() % 8 === 0) ? 1 + (rnd() % 31) : 0;  // sky with scatter
    map[y * WW + x] = t * 8;
  }
  return { map, tiles, tattr };
}

// ---- reference renderer ---------------------------------------------------------------------------------------------
export const scrAddr = (y, c) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | c;   // offset in a 6144 file
/** win = {x0, y0, nc, nr} in cells (default the whole screen). Returns {bm: 6144, at: 768}; cells outside are 0. */
export function refRender(world, cam, win = { x0: 0, y0: 0, nc: 32, nr: 24 }) {
  const bm = new Uint8Array(6144), at = new Uint8Array(768);
  const col0 = cam >> 3, p = cam & 7;
  for (let cy = win.y0; cy < win.y0 + win.nr; cy++) for (let c = win.x0; c < win.x0 + win.nc; c++) {
    const m0 = world.map[cy * WW + col0 + c];
    const m1 = col0 + c + 1 < WW ? world.map[cy * WW + col0 + c + 1] : 0;
    for (let r = 0; r < 8; r++) {
      const a = world.tiles[m0 + r], b = world.tiles[m1 + r];
      bm[scrAddr(cy * 8 + r, c)] = ((a << p) | (b >> (8 - p))) & 0xFF;
    }
    at[cy * 32 + c] = world.tattr[m0];
  }
  return { bm, at };
}

// ---- harness ----------------------------------------------------------------------------------------------------------
const work = mkdtempSync(join(tmpdir(), 'scroll-asm-'));
const stock0 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-0.rom')));
const stock1 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-1.rom')));
export const LOAD = 0x8000, STUB = 0x5B00;

/** Assemble src (relative to HERE) with -D defines; returns {bin, sym: {NAME: addr}, size}. */
export function assemble(src, defs = {}) {
  const tag = basename(src, '.asm') + '_' + Object.entries(defs).map(([k, v]) => k + v).join('_');
  const out = join(work, tag + '.bin'), sym = join(work, tag + '.sym');
  const args = ['--nologo', '--msg=err', '--raw=' + out, '--sym=' + sym, '--lst=' + join(work, tag + '.lst')];
  for (const [k, v] of Object.entries(defs)) args.push(`-D${k}=${v}`);
  execFileSync('sjasmplus', [...args, src], { stdio: ['ignore', 'ignore', 'inherit'], cwd: HERE });
  const syms = {};
  for (const line of readFileSync(sym, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][\w.]*):\s*EQU\s+0x([0-9A-Fa-f]+)/.exec(line);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  return { bin: new Uint8Array(readFileSync(out)), sym: syms, lst: join(work, tag + '.lst') };
}

export function newMachine(prog, world) {
  const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
  setHomeRom(m, stock0); setExRom(m, stock1); resetMachine(m);
  m.videoOn = false;
  m.ram.fill(0, 0x4000);
  m.ram.set(prog.bin, LOAD);
  const S = prog.sym;
  if (S.MAP !== undefined) m.ram.set(world.map, S.MAP);
  if (S.TILES !== undefined) m.ram.set(world.tiles, S.TILES);
  if (S.TATTR !== undefined) m.ram.set(world.tattr, S.TATTR);
  return m;
}
export const poke16 = (m, a, v) => { m.ram[a] = v & 255; m.ram[a + 1] = (v >> 8) & 255; };

/** Call a routine (CALL semantics, returns to STUB). Returns exact T-states, including the final RET. */
export function callAt(m, addr, maxFrames = 200) {
  m.cpu.sp = 0xFF00 - 2; m.ram[m.cpu.sp] = STUB & 255; m.ram[m.cpu.sp + 1] = STUB >> 8;
  m.cpu.pc = addr; m.cpu.iff1 = false; m.cpu.iff2 = false;
  const t0 = m.tstates, cap = t0 + maxFrames * tStatesPerFrame;
  while (m.cpu.pc !== STUB) {
    if (m.tstates >= cap) throw new Error('routine did not return at $' + addr.toString(16));
    runZ80(m.cpu, m.bus, 1, m);
  }
  return m.tstates - t0;
}

export function diff(got, exp, what, base) {
  let n = 0, first = -1;
  for (let i = 0; i < exp.length; i++) if (got[i] !== exp[i]) { n++; if (first < 0) first = i; }
  return n ? `${what}: ${n} bytes differ, first at +$${first.toString(16)} (abs $${(base + first).toString(16)}) got ${got[first]} expected ${exp[first]}` : null;
}
export const stats = a => ({ mean: a.reduce((s, v) => s + v, 0) / a.length, max: Math.max(...a), min: Math.min(...a) });

/** Fraction of the cells of a 32x24 screen at this camera whose cell and right-hand neighbour are both tile 0 (cost-free to clear). */
export function blankPairs(world, cam) {
  const col0 = cam >> 3; let n = 0;
  for (let y = 0; y < 24; y++) for (let c = 0; c < 32; c++) if (world.map[y * WW + col0 + c] === 0 && world.map[y * WW + col0 + c + 1] === 0) n++;
  return n / 768;
}
