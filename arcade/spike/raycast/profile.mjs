"use strict";
// T-state profile of one frame by routine (averaged over the 16 poses).  node profile.mjs METHOD:W:H:WCOL:MAPN[:INTERP]
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assemble } from './run-raycast.mjs';
import { makePoses } from './common.mjs';
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '../../..');
const { createMachine, setHomeRom, setExRom, resetMachine } = await import(join(ROOT, 'tsrun/machine.js'));
const { runZ80 } = await import(join(ROOT, 'tsrun/z80.js'));
const [METHOD, W, H, WCOL, MAPN, INTERP] = process.argv[2].split(':').map(Number);
const cfg = { METHOD, W, H, WCOL, MAPN, INTERP: INTERP || 0 };
const a = assemble(cfg), S = a.syms;
const names = ['FRAME', 'SETUP', 'MULP', 'STEPOF', 'DIV16', 'AXIS', 'CAST', 'RAY', 'DDA0', 'DDA1', 'DDA2', 'DDA3', 'HITX', 'HITY', 'HITC', 'CLEARWIN', 'DRAWA', 'DRAWB', 'DORUN', 'CALLIX', 'INSREC', 'UCHA', 'UCHB', 'UNITA', 'UNITB'];
const starts = names.filter(n => S[n] !== undefined).map(n => [S[n], n]).sort((x, y) => x[0] - y[0]);
const lookup = pc => { let r = null; for (const [ad, n] of starts) { if (ad <= pc) r = n; else break; } return r; };
const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
setHomeRom(m, new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-0.rom')))); setExRom(m, new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-1.rom')))); resetMachine(m);
m.ram.set(a.bin, 0x8000); m.cpu.pc = S.START; m.cpu.sp = 0xFF00; m.cpu.iff1 = false;
while (m.cpu.pc !== S.INIT_DONE) runZ80(m.cpu, m.bus, 1, m);
const bucket = {}; let total = 0;
for (const p of makePoses(MAPN)) {
  m.ram[0xB000] = p.px & 255; m.ram[0xB001] = p.px >> 8; m.ram[0xB002] = p.py & 255; m.ram[0xB003] = p.py >> 8; m.ram[0xB004] = p.ang;
  m.cpu.pc = S.FRAME; m.cpu.sp = 0xFF00;
  while (m.cpu.pc !== S.FRAME_DONE) {
    const pc = m.cpu.pc, t = m.tstates; runZ80(m.cpu, m.bus, 1, m);
    const n = lookup(pc), d = m.tstates - t; bucket[n] = (bucket[n] || 0) + d; total += d;
  }
}
console.log(a.name, 'avg T/frame', Math.round(total / 16));
for (const [n, t] of Object.entries(bucket).sort((x, y) => y[1] - x[1])) console.log(n.padEnd(10), String(Math.round(t / 16)).padStart(8), (100 * t / total).toFixed(1).padStart(6) + '%');
