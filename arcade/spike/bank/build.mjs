"use strict";
// build.mjs -- assemble probe.asm and write the DCK cartridges into build/.
//   node build.mjs            -> build/probe.dck (the test), probe-ctl.dck (control: no copies), probe-storm.dck,
//                                probe-neg1.dck, probe-neg2.dck (negative controls)
// DOCK chunks 0,1,4,5 hold the code (from the assembled image); 2, 3, 6 are filled with the pattern
//   byte i of chunk c = (i*7 + (i>>8)*13 + c*31 + 1) & 0xFF   (E4's formula).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDck, chunksFromImage, CHUNK } from '../xip/mkdck.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const pat = (c, i) => (i * 7 + (i >> 8) * 13 + c * 31 + 1) & 0xFF;

export function assemble(defs, tag) {
  const dir = join(HERE, 'build', tag);
  mkdirSync(dir, { recursive: true });
  const args = ['--nologo', '--lstlab', `--lst=${join(dir, 'out.lst')}`, `--sym=${join(dir, 'out.sym')}`];
  for (const [k, v] of Object.entries(defs)) args.push(`-D${k}=${v}`);
  args.push(join(HERE, 'probe.asm'));
  execFileSync('sjasmplus', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const img = new Uint8Array(readFileSync(join(dir, 'mem.bin')));
  const syms = {};
  for (const line of readFileSync(join(dir, 'out.sym'), 'utf8').split('\n')) {
    const m = line.match(/^(\S+):\s+EQU\s+0x([0-9A-Fa-f]+)/);
    if (m) syms[m[1]] = parseInt(m[2], 16);
  }
  return { img, syms };
}

export function makeDck(defs, tag, out) {
  const { img, syms } = assemble(defs, tag);
  for (const c of [2, 3, 6]) for (let i = 0; i < CHUNK; i++) img[c * CHUNK + i] = pat(c, i);
  const dck = buildDck(chunksFromImage(img, [0, 1, 2, 3, 4, 5, 6]));
  writeFileSync(join(HERE, 'build', out), dck);
  return { dck, syms };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  mkdirSync(join(HERE, 'build'), { recursive: true });
  const jobs = [['probe', {}, 'probe.dck'], ['ctl', { NOTEST: 1 }, 'probe-ctl.dck'], ['storm', { STORM: 1 }, 'probe-storm.dck'],
    ['neg1', { NEG: 1 }, 'probe-neg1.dck'], ['neg2', { NEG: 2 }, 'probe-neg2.dck'], ['neg3', { NEG: 3 }, 'probe-neg3.dck']];
  for (const [tag, defs, out] of jobs) {
    const { dck, syms } = makeDck(defs, tag, out);
    console.log(`build/${out}: ${dck.length} bytes, MAINC $${syms.MAINC.toString(16)}, FINISH $${syms.FINISH.toString(16)}, STOP $${syms.STOP.toString(16)}`);
  }
}
