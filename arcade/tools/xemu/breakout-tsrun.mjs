#!/usr/bin/env node
"use strict";
// breakout-tsrun.mjs -- run an Arcade cartridge on TSRun's stock TS2068 (tsrun/roms, no input) and record, at every
// refresh, the runtime state that the cross-emulator check needs.  Adapted from tsrun-run.mjs and tsrun-screens.mjs;
// the symbols are those of the runtime the cartridge was built against: v2 (arcade/build/v2/runtime.json), since breakout.arc uses KEYDOWN, which
// the v1 runtime refuses (v1's addresses differ: V_TICKS 57352, v2's 57464).  --runtime vN reads another build's runtime.json.
// Order of the commands (the three scripts and the compare):
//   node arcade/tools/arcadec.mjs arcade/examples/breakout.arc --assets arcade/examples/breakout.assets.json --runtime v2     -> arcade/build/breakout.dck
//   node arcade/tools/xemu/breakout-tsrun.mjs arcade/build/breakout.dck [--out DIR]             -> <out>/breakout-tsrun-*
//   python3 arcade/tools/xemu/breakout-zesarux.py arcade/build/breakout.dck [--out DIR]         -> <out>/breakout-zesarux-*
//   sh arcade/tools/xemu/breakout-fuse.sh [CART] [OUTDIR]                                       -> <out>/fuse-breakout/frame-*.scr (OUTDIR must be new)
//   node arcade/tools/xemu/breakout-compare.mjs [--dir DIR] [--fuse DIR]                        (the verdict lines)
//   node arcade/tools/xemu/breakout-tsrun.mjs <cart.dck> [--out arcade/build/xemu] [--refreshes 1500] [--ticks 300] [--runtime v2]
//
// Definitions (the same in the ZEsarUX and Fuse checks):
//   displayed tick = V_TICKS when V_SYNC < 2 (the flip of the last tick has happened: the ISR sets V_SYNC = 1 when it
//   flips, the main loop sets 0 when it starts the next tick), else V_TICKS - 1 (the request for V_TICKS is pending,
//   so the screen on show is still the previous tick's).
//   tick screen N = the displayed file at the first refresh where the displayed tick = N.
//
// Writes into --out:
//   breakout-tsrun-t<N>.bin        6912 bytes (bitmap + attributes) of tick screen N, for N = 5, 20, 60
//   breakout-tsrun-log.txt         one line per refresh: refresh, V_TICKS, V_SYNC, V_SHADOW_FF, displayed file, V_SFX_ACTIVE,
//                                  md5 of the displayed file, AY R0..R10 as read from the chip (m.ay.regs)
//   breakout-tsrun-ay.txt          the AY registers at the refreshes around the first sound effect
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const TSRUN = join(ARCADE, '../tsrun');
const M = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);

const args = process.argv.slice(2);
const opt = { dck: null, out: join(ARCADE, 'build/xemu'), refreshes: 1500, ticks: 300, runtime: 'v2' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') opt.out = resolve(args[++i]);
  else if (a === '--runtime') opt.runtime = args[++i];
  else if (a === '--refreshes') opt.refreshes = Number(args[++i]);
  else if (a === '--ticks') opt.ticks = Number(args[++i]);
  else opt.dck = a;
}
if (!opt.dck) { console.error('usage: breakout-tsrun.mjs <cart.dck> [--out DIR]'); process.exit(2); }
mkdirSync(opt.out, { recursive: true });
const rt = JSON.parse(readFileSync(join(ARCADE, 'build', opt.runtime, 'runtime.json'), 'utf8'));
const S = rt.symbols, C = rt.constants;

const rd8 = (m, a) => m.ram[a];
const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);
const hex = (v, w = 2) => '$' + v.toString(16).toUpperCase().padStart(w, '0');
const md5 = (b) => createHash('md5').update(b).digest('hex');

const m = M.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
M.setHomeRom(m, readFileSync(join(TSRUN, 'roms/ts2068-0.rom')));
M.setExRom(m, readFileSync(join(TSRUN, 'roms/ts2068-1.rom')));
M.insertDock(m, new Uint8Array(readFileSync(opt.dck)));
M.resetMachine(m);

const shownFile = () => (m.portFF & 1) ? 1 : 0;
const displayed = () => {
  const s = shownFile();
  const dfile = s ? C.DFILE1 : C.DFILE0, dattr = s ? C.DATTR1 : C.DATTR0;
  return Buffer.concat([m.ram.subarray(dfile, dfile + 6144), m.ram.subarray(dattr, dattr + 768)]);
};

const rows = [];
let entry = -1;
const shownTick = (ticks, sync) => (sync >= 2 ? (ticks - 1) & 0xFFFF : ticks);
for (let f = 1; f <= opt.refreshes; f++) {
  M.runFrame(m);
  if (entry < 0 && rd16(m, S.HO_MARK) === 0x5AA5) entry = f;
  if (entry < 0) continue;              // before the cartridge's entry V_TICKS is not a tick count
  const dump = displayed();
  rows.push({
    f,
    ticks: rd16(m, S.V_TICKS),
    sync: rd8(m, S.V_SYNC),
    shown: shownTick(rd16(m, S.V_TICKS), rd8(m, S.V_SYNC)),
    shadow: rd8(m, S.V_SHADOW_FF),
    file: shownFile() + 1,
    sfx: rd8(m, S.V_SFX_ACTIVE),
    md5: md5(dump),
    ay: Array.from(m.ay.regs.subarray(0, 11)),
    dump,
  });
  if (rows.at(-1).ticks > opt.ticks) break;
}
if (entry < 0) { console.log('entry: NOT REACHED'); process.exit(1); }
console.log(`entry (HO_MARK) at refresh ${entry}; ${rows.length} refreshes, last V_TICKS ${rows.at(-1).ticks}`);

// tick screens
const tickScreen = new Map();
for (const r of rows) {
  if (!tickScreen.has(r.shown)) tickScreen.set(r.shown, r);
}
for (const n of [5, 20, 60]) {
  const r = tickScreen.get(n);
  if (!r) { console.log(`tick ${n}: not reached`); continue; }
  writeFileSync(join(opt.out, `breakout-tsrun-t${n}.bin`), r.dump);
  console.log(`tick ${n}: refresh ${r.f} (V_TICKS ${r.ticks}, V_SYNC ${r.sync}), displayed file ${r.file}, md5 ${r.md5}`);
}

// flip: the displayed file for tick N, N = 1..12 (should alternate)
const flip = [];
for (let n = 1; n <= 12; n++) { const r = tickScreen.get(n); if (r) flip.push(`${n}:${r.file}`); }
console.log(`displayed file per tick (flip): ${flip.join(' ')}`);
const keys = [...tickScreen.keys()].sort((a, b) => a - b);
const gaps = keys.filter((n, i) => i > 0 && n !== keys[i - 1] + 1).length;
const alternates = keys.every((n, i) => i === 0 || tickScreen.get(n).file !== tickScreen.get(keys[i - 1]).file);
console.log(`displayed file alternates on every tick: ${alternates} (${keys.length} ticks seen, ${gaps} gaps)`);

// log
const logLines = ['refresh ticks sync shown shadowFF file sfx md5 AY(R0..R10)'];
for (const r of rows) {
  logLines.push(`${r.f} ${r.ticks} ${r.sync} ${r.shown} ${hex(r.shadow)} ${r.file} ${r.sfx} ${r.md5} ${r.ay.map((v) => v.toString(16).padStart(2, '0')).join(' ')}`);
}
writeFileSync(join(opt.out, 'breakout-tsrun-log.txt'), logLines.join('\n') + '\n');

// AY: the first sound effect (V_SFX_ACTIVE becomes non-zero) and the chip registers from there
const firstSfx = rows.findIndex((r) => r.sfx !== 0);
const ayLines = [];
if (firstSfx < 0) {
  ayLines.push('no sound effect in the run');
} else {
  const r0 = rows[firstSfx];
  ayLines.push(`first effect: refresh ${r0.f}, V_TICKS ${r0.ticks}, V_SFX_ACTIVE ${hex(r0.sfx)}`);
  ayLines.push('refresh ticks  sfx  R0 R1 R2 R3 R4 R5 R6 R7 R8 R9 R10 (chip, after the refresh)');
  for (let i = Math.max(0, firstSfx - 2); i < Math.min(rows.length, firstSfx + 12); i++) {
    const r = rows[i];
    ayLines.push(`${String(r.f).padStart(7)} ${String(r.ticks).padStart(5)} ${String(r.sfx).padStart(4)}  ${r.ay.map((v) => v.toString(16).padStart(2, '0')).join(' ')}`);
  }
}
writeFileSync(join(opt.out, 'breakout-tsrun-ay.txt'), ayLines.join('\n') + '\n');
console.log(ayLines.slice(0, 3).join('\n'));
const ticksAtSfx = firstSfx >= 0 ? rows[firstSfx].ticks : -1;
console.log(`first sound effect at V_TICKS ${ticksAtSfx}; AY R0..R10 in the first effect refresh: ${firstSfx >= 0 ? rows[firstSfx].ay.map((v) => hex(v)).join(' ') : '-'}`);
