"use strict";
// lib.mjs -- the billboard spike's TSRun harness (as arcade/spike/wire/lib.mjs): assemble bb.asm, load it at $8000 of a stock TS2068, CALL a
// kernel with interrupts off and count its T-states exactly (from the CALL to the final RET), a PC profile by address range, PNG writing.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

export const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const { createMachine, setHomeRom, setExRom, resetMachine, tStatesPerFrame } = await import(join(ROOT, 'tsrun/machine.js'));
const { runZ80 } = await import(join(ROOT, 'tsrun/z80.js'));
export { tStatesPerFrame };

const work = mkdtempSync(join(tmpdir(), 'bb-asm-'));
const stock0 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-0.rom')));
const stock1 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-1.rom')));
export const LOAD = 0x8000, STUB = 0x5B00, SP0 = 0xFF00 - 2;

/** Assemble bb.asm with -D defines; returns {bin, sym, lst}. */
export function assemble(defs = {}) {
  const tag = 'bb_' + Object.entries(defs).map(([k, v]) => k + v).join('_');
  const out = join(work, tag + '.bin'), sym = join(work, tag + '.sym'), lst = join(work, tag + '.lst');
  const args = ['--nologo', '--msg=war', '--raw=' + out, '--sym=' + sym, '--lst=' + lst];
  for (const [k, v] of Object.entries(defs)) args.push(`-D${k}=${v}`);
  execFileSync('sjasmplus', [...args, 'bb.asm'], { stdio: ['ignore', 'ignore', 'inherit'], cwd: HERE });
  const syms = {};
  for (const line of readFileSync(sym, 'utf8').split('\n')) {
    const m = /^([A-Za-z_][\w.]*):\s*EQU\s+0x([0-9A-Fa-f]+)/.exec(line);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  return { bin: new Uint8Array(readFileSync(out)), sym: syms, lst: readFileSync(lst, 'utf8') };
}

/** A stock TS2068 with the program at $8000; RAM $4000-$FFFF zero first. */
export function newMachine(prog) {
  const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
  setHomeRom(m, stock0); setExRom(m, stock1); resetMachine(m);
  m.videoOn = false;
  m.ram.fill(0, 0x4000);
  m.ram.set(prog.bin, LOAD);
  return m;
}
export const poke16 = (m, a, v) => { m.ram[a] = v & 255; m.ram[a + 1] = (v >> 8) & 255; };
export const peek16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);

/** Call a routine (CALL semantics, returns to STUB), interrupts off.  Returns the exact T-states incl. the final RET.
 *  prof (optional): { ranges: [[lo, hi, name]], t: {} } -- each instruction's T-states go to the range its address is in. */
export function callAt(m, addr, { a, prof, maxFrames = 600 } = {}) {
  m.cpu.sp = SP0; m.ram[SP0] = STUB & 255; m.ram[SP0 + 1] = STUB >> 8;
  if (a !== undefined) m.cpu.a = a;
  m.cpu.pc = addr; m.cpu.iff1 = false; m.cpu.iff2 = false;
  const t0 = m.tstates, cap = t0 + maxFrames * tStatesPerFrame;
  let minSp = SP0;
  while (m.cpu.pc !== STUB) {
    if (m.tstates >= cap) throw new Error('routine did not return at $' + addr.toString(16));
    const pc = m.cpu.pc, tb = m.tstates;
    runZ80(m.cpu, m.bus, 1, m);
    if (m.cpu.sp < minSp) minSp = m.cpu.sp;
    if (prof) {
      const dt = m.tstates - tb;
      let name = 'other';
      for (const [lo, hi, nm] of prof.ranges) if (pc >= lo && pc < hi) { name = nm; break; }
      prof.t[name] = (prof.t[name] ?? 0) + dt;
    }
  }
  callAt.minSp = minSp;
  return m.tstates - t0;
}

/** Bytes that differ between RAM and a snapshot over [lo, hi), skipping the addresses in `skip` (a Set) -> first difference text or null. */
export function ramDiff(m, snap, lo, hi, skip, what) {
  for (let a = lo; a < hi; a++) {
    if (skip.has(a)) continue;
    if (m.ram[a] !== snap[a]) return `${what}: RAM $${a.toString(16)} changed (${snap[a]} -> ${m.ram[a]})`;
  }
  return null;
}
export const rangeSet = (ranges) => { const s = new Set(); for (const [lo, hi] of ranges) for (let a = lo; a < hi; a++) s.add(a); return s; };

export const stats = (a) => {
  if (!a.length) return { n: 0, mean: 0, min: 0, max: 0, p50: 0, p95: 0 };
  const s = a.slice().sort((x, y) => x - y), q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))];
  return { n: a.length, mean: Math.round(a.reduce((x, y) => x + y, 0) / a.length), min: s[0], max: s[s.length - 1], p50: q(0.5), p95: q(0.95) };
};

// ---- PNG (8-bit RGB, no interlace; zlib from node:zlib) ----
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0); out.write(type, 4, 'ascii'); Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** Write an RGB image (rgb: Uint8Array w*h*3) as a PNG file. */
export function writePng(path, w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(path, Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
