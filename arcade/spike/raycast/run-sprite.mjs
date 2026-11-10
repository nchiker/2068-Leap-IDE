"use strict";
// Cost of one column-scaled billboard (sprite.asm), verified against a JS reference.  node run-sprite.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pxAddr } from './common.mjs';
const HERE = dirname(fileURLToPath(import.meta.url)), ROOT = resolve(HERE, '../../..');
const { createMachine, setHomeRom, setExRom, resetMachine, tStatesPerFrame } = await import(join(ROOT, 'tsrun/machine.js'));
const { runZ80 } = await import(join(ROOT, 'tsrun/z80.js'));
const rom0 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-0.rom'))), rom1 = new Uint8Array(readFileSync(join(ROOT, 'tsrun/roms/ts2068-1.rom')));
// a 32x32 "monster": filled disc with two eye holes and a mouth; column-major, one byte per pixel
const src = new Uint8Array(32 * 32);
for (let u = 0; u < 32; u++) for (let v = 0; v < 32; v++) {
  const dx = u - 15.5, dy = v - 15.5;
  let on = dx * dx + dy * dy < 15.5 * 15.5;
  if (on && ((Math.abs(dx + 5) < 2.5 && Math.abs(dy + 4) < 2.5) || (Math.abs(dx - 5) < 2.5 && Math.abs(dy + 4) < 2.5))) on = false;
  if (on && v > 20 && v < 24 && Math.abs(dx) < 8) on = false;
  src[u * 32 + v] = on ? 1 : 0;
}
const dir = join(HERE, 'build', 'sprite'); mkdirSync(dir, { recursive: true });
writeFileSync(join(dir, 'spr_src.bin'), src);
const out = [];
for (const [SW, HS] of [[1, 8], [1, 16], [1, 24], [1, 32], [1, 48], [1, 64], [4, 16], [4, 24], [4, 32], [4, 48], [4, 64]]) {
  const XPIX = 48, CYROW = 96;
  writeFileSync(join(dir, 'spr_cfg.inc'), `HS EQU ${HS}\nXPIX EQU ${XPIX}\nCYROW EQU ${CYROW}\nSW EQU ${SW}\n`);
  execFileSync('sjasmplus', ['--nologo', '--msg=err', '--raw=' + join(dir, 'o.bin'), '--sym=' + join(dir, 'o.sym'), '-I' + dir, join(HERE, 'sprite.asm')], { stdio: ['ignore', 'ignore', 'inherit'], cwd: HERE });
  const bin = new Uint8Array(readFileSync(join(dir, 'o.bin')));
  const syms = {}; for (const l of readFileSync(join(dir, 'o.sym'), 'utf8').split('\n')) { const mm = /^(\w+):?\s+EQU\s+0x([0-9A-Fa-f]+)/.exec(l); if (mm) syms[mm[1]] = parseInt(mm[2], 16); }
  const m = createMachine(new Uint8Array(8).fill(0x1F), new Uint8Array(2).fill(0xFF));
  setHomeRom(m, rom0); setExRom(m, rom1); resetMachine(m); m.videoOn = false; m.ram.fill(0, 0x4000);
  m.ram.set(bin, 0x8000); m.cpu.pc = 0x8000; m.cpu.sp = 0xFF00; m.cpu.iff1 = false;
  const t0 = m.tstates; let n = 0;
  while (m.cpu.pc !== syms.DONE) { runZ80(m.cpu, m.bus, 1, m); if (++n > 20e6) throw new Error('hang'); }
  const T = m.tstates - t0;
  // reference
  const exp = new Uint8Array(6144), STEP = Math.floor(32 * 256 / HS), TOP = CYROW - HS / 2;
  let ua = 0;
  for (let i = 0; i < HS / SW; i++) {
    const u = ua >> 8; ua += STEP * SW;
    let va = 0;
    for (let k = 0; k < HS; k++) { const v = va >> 8; va += STEP; if (src[u * 32 + v]) for (let q = 0; q < SW; q++) { const x = XPIX + i * SW + q; exp[pxAddr(TOP + k) + (x >> 3)] |= 0x80 >> (x & 7); } }
  }
  const got = m.ram.subarray(0x4000, 0x5800);
  let bad = 0; for (let i = 0; i < 6144; i++) if (got[i] !== exp[i]) bad++;
  let px = 0; for (const b of exp) for (let k = 0; k < 8; k++) px += (b >> k) & 1;
  out.push({ SW, HS, T, perCol: T / (HS / SW), perRow: T / (HS * HS), px, match: bad === 0, bytes: bin.length - 0x100 - 1024 });
  console.log(`SW=${SW} HS=${HS}  total ${T} T (${(T / tStatesPerFrame).toFixed(2)} frames)  ${(T / (HS / SW)).toFixed(0)} T per drawn column  ${(T / (HS * HS)).toFixed(1)} T per destination pixel  set pixels ${px}  ${bad === 0 ? 'MATCH' : 'MISMATCH ' + bad}`);
}
writeFileSync(join(dir, 'sprite.json'), JSON.stringify(out, null, 1));
