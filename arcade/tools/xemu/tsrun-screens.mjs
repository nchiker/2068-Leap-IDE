#!/usr/bin/env node
"use strict";
// tsrun-screens.mjs -- every distinct displayed screen of a cartridge's run on TSRun, after the entry, as md5 hashes
// of the displayed file's 6912 bytes (bitmap + attributes).  Prints one line per refresh: "refresh V_TICKS md5".
// Used to check that the Fuse movie's screens (fmfconv -S, one .scr per refresh, md5 per file) are a subset of TSRun's.
//   node arcade/tools/xemu/tsrun-screens.mjs <cart.dck> [--refreshes 400] [--dir <dir of .scr files>]
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const M = await import(pathToFileURL(join(ARCADE, '../tsrun/machine.js')).href);
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/runtime.json'), 'utf8'));
const S = rt.symbols, C = rt.constants;
const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);
const md5 = (b) => createHash('md5').update(b).digest('hex');

const args = process.argv.slice(2);
const dck = args.find((a) => !a.startsWith('--') && !args[args.indexOf(a) - 1]?.startsWith('--'));
const refreshes = Number(args[args.indexOf('--refreshes') + 1] ?? 400);
const dir = args.includes('--dir') ? args[args.indexOf('--dir') + 1] : null;

const m = M.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
M.setHomeRom(m, readFileSync(join(ARCADE, '../tsrun/roms/ts2068-0.rom')));
M.setExRom(m, readFileSync(join(ARCADE, '../tsrun/roms/ts2068-1.rom')));
M.insertDock(m, new Uint8Array(readFileSync(dck)));
M.resetMachine(m);
const screen = () => {
  const shown = (m.portFF & 1) ? 1 : 0;
  const dfile = shown ? C.DFILE1 : C.DFILE0, dattr = shown ? C.DATTR1 : C.DATTR0;
  return Buffer.concat([m.ram.subarray(dfile, dfile + 6144), m.ram.subarray(dattr, dattr + 768)]);
};
const seen = new Map();   // md5 -> first refresh index
for (let f = 0; f < refreshes; f++) {
  M.runFrame(m);
  const h = md5(screen());
  if (!seen.has(h)) seen.set(h, { refresh: f, ticks: rd16(m, S.V_TICKS) });
}
console.log(`TSRun: ${refreshes} refreshes, ${seen.size} distinct displayed screens`);
if (dir) {
  const files = readdirSync(dir).filter((f) => /\.scr$/.test(f)).sort();
  const fuse = files.map((f) => md5(readFileSync(join(dir, f))));
  const fuseSet = new Set(fuse);
  const inTsrun = [...fuseSet].filter((h) => seen.has(h)).length;
  console.log(`Fuse: ${files.length} frames, ${fuseSet.size} distinct screens; ${inTsrun} of them occur in the TSRun run`);
  const missing = [...fuseSet].filter((h) => !seen.has(h));
  console.log(`Fuse screens not in TSRun: ${missing.length}`);
  const badIdx = fuse.map((h, i) => (seen.has(h) ? -1 : i)).filter((i) => i >= 0);
  if (badIdx.length) console.log(`Fuse frames not in TSRun: ${badIdx.length}, from ${badIdx[0]} to ${badIdx.at(-1)}`);
  // the first run of identical frames after the boot (a screen must be complete)
  const first = fuse.findIndex((h) => seen.has(h));
  console.log(`first Fuse frame that is a cartridge screen: ${first}`);
}
