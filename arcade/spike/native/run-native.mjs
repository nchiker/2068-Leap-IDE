"use strict";
// Native Z80 harness for the Phase 1 spike (arcade/spike/SPEC.md).
//
//   node run-native.mjs b1_generic.asm [more.asm ...]    assemble, run, compare with reference.mjs
//   node run-native.mjs --all                             every b*.asm in this directory
//
// The program is assembled with sjasmplus (--raw), loaded at $8000 of a stock TS2068 machine (TSRun), PC=$8000,
// SP=$FF00, interrupts disabled. The CPU is stepped one instruction at a time until RAM[$5B00] == $A5, so the
// T-state count is exact (m.tstates delta, including the instruction that stores the marker). No frame
// interrupts are delivered (the code runs DI and never calls runFrame). Frames = T-states / 58688.
// The run is capped at 5000 frames; a program that does not finish by then is reported as DID NOT FINISH.
import { readFileSync, readdirSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const { createMachine, setHomeRom, setExRom, resetMachine, tStatesPerFrame } = await import(join(ROOT, 'tsrun/machine.js'));
const { runZ80 } = await import(join(ROOT, 'tsrun/z80.js'));
const ref = await import(join(HERE, '../reference.mjs'));

const LOAD = 0x8000, MARK = 0x5B00, MAX_FRAMES = 5000;
const sha = u8 => createHash('sha256').update(u8).digest('hex');
const stock0 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-0.rom')));
const stock1 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-1.rom')));
const work = mkdtempSync(join(tmpdir(), 'native-asm-'));

/** Assemble with sjasmplus; returns the raw binary (code and data from the first ORG). */
function assemble(src) {
  const out = join(work, basename(src, '.asm') + '.bin');
  execFileSync('sjasmplus', ['--nologo', '--msg=err', '--raw=' + out, '--lst=' + out.replace(/\.bin$/, '.lst'), src],
    { stdio: ['ignore', 'ignore', 'inherit'], cwd: HERE });
  return new Uint8Array(readFileSync(out));
}

function runBinary(bin) {
  const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
  setHomeRom(m, stock0); setExRom(m, stock1); resetMachine(m);
  m.videoOn = false;                                  // no painting needed; the beam is not run
  m.ram.fill(0, 0x4000);                              // cleared bitmap, attributes and work area
  m.ram.set(bin, LOAD);
  m.cpu.pc = LOAD; m.cpu.sp = 0xFF00; m.cpu.iff1 = false; m.cpu.iff2 = false;
  const t0 = m.tstates, cap = t0 + MAX_FRAMES * tStatesPerFrame;
  while (m.ram[MARK] !== 0xA5) {
    if (m.tstates >= cap) return { ok: false, tstates: m.tstates - t0, m };
    runZ80(m.cpu, m.bus, 1, m);                       // budget 1 = exactly one instruction
  }
  return { ok: true, tstates: m.tstates - t0, m };
}

const w16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);

function firstDiff(got, exp) {
  let n = 0, first = -1;
  for (let i = 0; i < 6144; i++) if (got[i] !== exp[i]) { n++; if (first < 0) first = i; }
  return `${n} bytes differ, first at $${(0x4000 + first).toString(16)} got ${got[first]} expected ${exp[first]}`;
}

function compare(name, m) {
  const bm = m.ram.subarray(0x4000, 0x5800);
  if (/^b1/.test(name)) { const e = ref.b1(); return sha(bm) === sha(e) ? [true, 'bitmap'] : [false, firstDiff(bm, e)]; }
  if (/^b2/.test(name)) { const e = ref.b2(); return sha(bm) === sha(e) ? [true, 'bitmap'] : [false, firstDiff(bm, e)]; }
  if (/^b3/.test(name)) {
    const e = ref.b3(), g = { primes: w16(m, 0x5B02), x: w16(m, 0x5B04), s: w16(m, 0x5B06) };
    const ok = g.primes === e.primes && g.x === e.x && g.s === e.s;
    return [ok, ok ? JSON.stringify(g) : `got ${JSON.stringify(g)} expected ${JSON.stringify(e)}`];
  }
  return [null, 'no reference for this name'];
}

const args = process.argv.slice(2);
const files = args.includes('--all') || !args.some(a => !a.startsWith('--'))
  ? readdirSync(HERE).filter(f => /^b\d.*\.asm$/.test(f)).sort() : args.filter(a => !a.startsWith('--'));
let bad = 0;
console.log('program'.padEnd(18) + 'bytes'.padStart(7) + 'T-states'.padStart(12) + 'frames'.padStart(9) + '  result');
for (const f of files) {
  const bin = assemble(resolve(HERE, f));
  const r = runBinary(bin);
  const label = basename(f).padEnd(18) + String(bin.length).padStart(7);
  if (!r.ok) { console.log(`${label}${String(r.tstates).padStart(12)}  DID NOT FINISH within ${MAX_FRAMES} frames`); bad++; continue; }
  const [ok, note] = compare(basename(f), r.m);
  if (ok === false) bad++;
  console.log(label + String(r.tstates).padStart(12) + (r.tstates / tStatesPerFrame).toFixed(1).padStart(9) + '  ' +
    (ok ? 'MATCH ' : ok === false ? 'MISMATCH ' : '') + note);
}
process.exit(bad ? 1 : 0);
