#!/usr/bin/env node
"use strict";
// tsrun-run.mjs -- boot a cartridge (.dck) on TSRun's stock TS2068 (the IDE's tsrun/ submodule, stock ROMs) and dump
// the DISPLAYED display file (6144 bytes of bitmap + 768 of attributes) after N refreshes past the cartridge entry.
//   node arcade/tools/xemu/tsrun-run.mjs <cart.dck> [--frames 300] [--out dump.bin] [--frames-max 1500]
// Prints one line per fact: entry (the runtime's HO_MARK = $5AA5, the hand-off state), the displayed file, the frame
// counters.  The dump file is 6912 bytes: bitmap $4000/$6000 (whichever file is shown), then attributes.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const TSRUN = join(ARCADE, '../tsrun');
const M = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);

const args = process.argv.slice(2);
const opt = { dck: null, frames: 300, out: null, max: 1500, ticks: null };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--frames') opt.frames = Number(args[++i]);
  else if (a === '--out') opt.out = args[++i];
  else if (a === '--frames-max') opt.max = Number(args[++i]);
  else if (a === '--ticks') opt.ticks = Number(args[++i]);   // stop at the first refresh where V_TICKS = N (absolute)
  else opt.dck = a;
}
if (!opt.dck) { console.error('usage: tsrun-run.mjs <cart.dck> [--frames N] [--out dump.bin]'); process.exit(2); }

const rt = JSON.parse(readFileSync(join(ARCADE, 'build/runtime.json'), 'utf8'));
const S = rt.symbols, C = rt.constants;
const rd8 = (m, a) => m.ram[a];
const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);
const hex = (v, w = 2) => '$' + v.toString(16).toUpperCase().padStart(w, '0');

const keyMatrix = new Uint8Array(9).fill(0x1F);
const joystick = new Uint8Array(2).fill(0xFF);
const m = M.createMachine(keyMatrix, joystick);
const must = (e) => { if (e) throw new Error(e); };
must(M.setHomeRom(m, readFileSync(join(TSRUN, 'roms/ts2068-0.rom'))));
must(M.setExRom(m, readFileSync(join(TSRUN, 'roms/ts2068-1.rom'))));
must(M.insertDock(m, new Uint8Array(readFileSync(opt.dck))));
M.resetMachine(m);
m.joystick = joystick;

// 1. the hand-off: run until the cartridge's entry has written its marker
let entry = -1;
for (let f = 1; f <= 400; f++) {
  M.runFrame(m);
  if (rd16(m, S.HO_MARK) === 0x5AA5) { entry = f; break; }
}
if (entry < 0) {
  console.log(`entry: NOT REACHED in 400 frames (HO_MARK ${hex(rd16(m, S.HO_MARK), 4)}, PC ${hex(m.cpu.pc, 4)})`);
  process.exit(1);
}
const hand = { iff: rd8(m, S.HO_IFF), f4: rd8(m, S.HO_F4), ff: rd8(m, S.HO_FF), sp: rd16(m, S.HO_SP) };
console.log(`entry: reached at refresh ${entry}; hand-off IFF ${hand.iff} F4 ${hex(hand.f4)} FF ${hex(hand.ff)} SP ${hex(hand.sp, 4)}`);
const f0 = rd16(m, S.V_FRAMES);
const t0 = rd16(m, S.V_TICKS);

// 2. N refreshes past the entry
let n = 0;
if (opt.ticks !== null) {
  // compare at a given tick: the screen is a function of the tick count, not of the frame length
  while (rd16(m, S.V_TICKS) < opt.ticks && n < opt.max) { M.runFrame(m); n++; }
} else {
  while (n < opt.frames && n < opt.max) { M.runFrame(m); n++; }
}
const frames = (rd16(m, S.V_FRAMES) - f0) & 0xFFFF, ticks = (rd16(m, S.V_TICKS) - t0) & 0xFFFF;
const shown = (m.portFF & 1) ? 1 : 0;
const dfile = shown ? C.DFILE1 : C.DFILE0, dattr = shown ? C.DATTR1 : C.DATTR0;
const dump = new Uint8Array(6912);
dump.set(m.ram.subarray(dfile, dfile + 6144), 0);
dump.set(m.ram.subarray(dattr, dattr + 768), 6144);
console.log(`${opt.ticks !== null ? `at V_TICKS ${rd16(m, S.V_TICKS)} (target ${opt.ticks}), ` : ''}after ${n} refreshes past entry: V_FRAMES +${frames}, V_TICKS +${ticks}; $F4 ${hex(m.portF4)} $FF ${hex(m.portFF)}; displayed file ${shown + 1} ($${dfile.toString(16)})`);
if (opt.out) {
  mkdirSync(dirname(resolve(opt.out)), { recursive: true });
  writeFileSync(opt.out, dump);
  console.log(`dump: ${resolve(opt.out)} (6912 bytes: bitmap + attributes of the displayed file)`);
}
// a blank-screen check: ink/paper counts, to tell an empty screen from a drawn one
const attrs = new Map();
for (let i = 0; i < 768; i++) attrs.set(dump[6144 + i], (attrs.get(dump[6144 + i]) ?? 0) + 1);
console.log(`attributes: ${[...attrs].map(([a, c]) => `${hex(a)}x${c}`).join(' ')}`);
