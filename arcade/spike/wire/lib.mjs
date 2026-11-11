"use strict";
// Wireframe spike: TSRun harness (assemble, load at $8000 of a stock TS2068, call with exact T-states) and the tables.
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SIN, QS, RCPT, SQU } from './ref.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const { createMachine, setHomeRom, setExRom, resetMachine, tStatesPerFrame } = await import(join(ROOT, 'tsrun/machine.js'));
const { runZ80 } = await import(join(ROOT, 'tsrun/z80.js'));
export { tStatesPerFrame };

const work = mkdtempSync(join(tmpdir(), 'wire-asm-'));
const stock0 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-0.rom')));
const stock1 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-1.rom')));
export const LOAD = 0x8000, STUB = 0x5B00, SP0 = 0xFF00 - 2;

/** Assemble wire.asm with -D defines; returns {bin, sym}. */
export function assemble(defs = {}) {
  const tag = 'wire_' + Object.entries(defs).map(([k, v]) => k + v).join('_');
  const out = join(work, tag + '.bin'), sym = join(work, tag + '.sym');
  const args = ['--nologo', '--msg=err', '--raw=' + out, '--sym=' + sym, '--lst=' + join(work, tag + '.lst')];
  for (const [k, v] of Object.entries(defs)) args.push(`-D${k}=${v}`);
  execFileSync('sjasmplus', [...args, 'wire.asm'], { stdio: ['ignore', 'ignore', 'inherit'], cwd: HERE });
  const syms = {};
  for (const line of readFileSync(sym, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][\w.]*):\s*EQU\s+0x([0-9A-Fa-f]+)/.exec(line);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  return { bin: new Uint8Array(readFileSync(out)), sym: syms };
}

/** A stock TS2068 with the program at $8000 and the tables in place; RAM $4000-$FFFF zero first. */
export function newMachine(prog) {
  const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
  setHomeRom(m, stock0); setExRom(m, stock1); resetMachine(m);
  m.videoOn = false;
  m.ram.fill(0, 0x4000);
  m.ram.set(prog.bin, LOAD);
  const S = prog.sym;
  for (let i = 0; i < 256; i++) {
    m.ram[S.QSL + i] = QS[i] & 255; m.ram[S.QSH + i] = QS[i] >> 8;
    m.ram[S.SINT + i] = SIN[i] & 255; m.ram[S.RCPT + i] = RCPT[i];
  }
  for (let n = 0; n < 512; n++) { m.ram[S.SQUL + n] = SQU[n] & 255; m.ram[S.SQUH + n] = SQU[n] >> 8; }
  return m;
}
export const poke16 = (m, a, v) => { m.ram[a] = v & 255; m.ram[a + 1] = (v >> 8) & 255; };
export const peek16s = (m, a) => { const v = m.ram[a] | (m.ram[a + 1] << 8); return v >= 0x8000 ? v - 0x10000 : v; };
export const peek8s = (m, a) => { const v = m.ram[a]; return v >= 0x80 ? v - 0x100 : v; };

/** Call a routine (CALL semantics, returns to STUB), interrupts off. Returns exact T-states incl. the final RET. */
export function callAt(m, addr, maxFrames = 400) {
  m.cpu.sp = SP0; m.ram[SP0] = STUB & 255; m.ram[SP0 + 1] = STUB >> 8;
  m.cpu.pc = addr; m.cpu.iff1 = false; m.cpu.iff2 = false;
  const t0 = m.tstates, cap = t0 + maxFrames * tStatesPerFrame;
  while (m.cpu.pc !== STUB) {
    if (m.tstates >= cap) throw new Error('routine did not return at $' + addr.toString(16));
    runZ80(m.cpu, m.bus, 1, m);
  }
  return m.tstates - t0;
}

/** First difference between two byte arrays, or null. */
export function diff(got, exp, what, base) {
  let n = 0, first = -1;
  for (let i = 0; i < exp.length; i++) if (got[i] !== exp[i]) { n++; if (first < 0) first = i; }
  return n ? `${what}: ${n} bytes differ, first at $${(base + first).toString(16)} got ${got[first]} expected ${exp[first]}` : null;
}

/** RAM outside the screens that a routine may change: the variables page and the stack. */
export function ramOutsideDiff(m, snap, what) {
  for (let a = 0x8000; a < 0x10000; a++) {
    if (a >= 0xF000 && a < 0xF100) continue;           // VARS
    if (a >= 0xFD00 && a < 0xFF00) continue;           // stack
    if (a >= 0xD400 && a < 0xD900) continue;           // projected records (checked separately)
    if (m.ram[a] !== snap[a]) return `${what}: RAM $${a.toString(16)} changed (${snap[a]} -> ${m.ram[a]})`;
  }
  for (let a = 0x5B00; a < 0x6000; a++) if (m.ram[a] !== snap[a] && a !== 0x5B00) return `${what}: RAM $${a.toString(16)} changed`;
  return null;
}

let seed = 1;
export const srand = s => { seed = s >>> 0 || 1; };
export const rnd = () => { seed ^= seed << 13; seed >>>= 0; seed ^= seed >>> 17; seed ^= seed << 5; seed >>>= 0; return seed / 4294967296; };
export const rint = (a, b) => a + Math.floor(rnd() * (b - a + 1));
export const stats = a => ({ mean: a.reduce((s, v) => s + v, 0) / a.length, max: Math.max(...a), min: Math.min(...a), n: a.length });
