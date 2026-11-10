#!/usr/bin/env node
"use strict";
// shooter-tsrun.mjs -- run an Arcade v2 cartridge (shooter.dck) on TSRun's stock TS2068 (tsrun/roms, no input) and record, at
// every refresh, what the cross-emulator check needs.  Adapted from breakout-tsrun.mjs; symbols from arcade/build/v2/runtime.json.
//   node arcade/tools/xemu/shooter-tsrun.mjs [cart.dck] [--out arcade/build/xemu] [--ticks 200] [--refreshes 4000] [--run-id A]
// Definitions (the same as breakout-tsrun.mjs): displayed tick = V_TICKS when V_SYNC < 2, else V_TICKS - 1.
// Writes into --out (prefix shooter-tsrun):
//   -t<N>.bin        6912 bytes of the displayed screen at the first refresh where the displayed tick = N (N = 5, 30, 90, 200)
//   -state-t<N>.bin  SPR_TAB (96 bytes) + CELL_TILE (768 bytes) at the first refresh with V_TICKS = N (the state checked in
//                    the cross-emulator comparison; ZEsarUX samples the same point, the ISR's end)
//   -log.txt         one line per refresh: refresh ticks sync shown file sfx md5 AY(R0..R10)
//   -timing.txt      frames per tick: average, worst, and the tick->refresh table for the first 20 ticks
//   -ay.txt          the AY registers around the first sound effect(s)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const TSRUN = join(ARCADE, '../tsrun');
const M = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v2/runtime.json'), 'utf8'));
const S = rt.symbols, C = rt.constants;

const args = process.argv.slice(2);
const opt = { dck: join(ARCADE, 'build/shooter.dck'), out: join(ARCADE, 'build/xemu'), refreshes: 4000, ticks: 200, runId: 'A' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out') opt.out = resolve(args[++i]);
  else if (a === '--refreshes') opt.refreshes = Number(args[++i]);
  else if (a === '--ticks') opt.ticks = Number(args[++i]);
  else if (a === '--run-id') opt.runId = args[++i];
  else opt.dck = resolve(a);
}
mkdirSync(opt.out, { recursive: true });
const PREFIX = join(opt.out, 'shooter-tsrun');
const TICK_TARGETS = [5, 30, 90, 200];

const rd8 = (m, a) => m.ram[a];
const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);
const md5 = (b) => createHash('md5').update(b).digest('hex');
const hex = (v, w = 2) => '$' + v.toString(16).toUpperCase().padStart(w, '0');

export function newMachine() {
  const m = M.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  M.setHomeRom(m, readFileSync(join(TSRUN, 'roms/ts2068-0.rom')));
  M.setExRom(m, readFileSync(join(TSRUN, 'roms/ts2068-1.rom')));
  M.insertDock(m, new Uint8Array(readFileSync(opt.dck)));
  M.resetMachine(m);
  return m;
}

// Run the cartridge; `onRefresh(m, row)` is called after each refresh once the entry is reached.  Returns the rows.
export function runCart(m, { refreshes = opt.refreshes, ticks = opt.ticks, keep = true, onRefresh = null } = {}) {
  const shownFile = () => ((m.portFF & 1) ? 1 : 0);
  const displayed = () => {
    const s = shownFile();
    const dfile = s ? C.DFILE1 : C.DFILE0, dattr = s ? C.DATTR1 : C.DATTR0;
    return Buffer.concat([m.ram.subarray(dfile, dfile + 6144), m.ram.subarray(dattr, dattr + 768)]);
  };
  const rows = [];
  let entry = -1;
  for (let f = 1; f <= refreshes; f++) {
    M.runFrame(m);
    if (entry < 0 && rd16(m, S.HO_MARK) === 0x5AA5) entry = f;
    if (entry < 0) continue;
    const sync = rd8(m, S.V_SYNC), ticksNow = rd16(m, S.V_TICKS);
    const shown = sync >= 2 ? (ticksNow - 1) & 0xFFFF : ticksNow;
    const dump = keep ? displayed() : null;
    const row = {
      f, ticks: ticksNow, sync, shown, file: shownFile() + 1, sfx: rd8(m, S.V_SFX_ACTIVE),
      md5: keep ? md5(dump) : '', ay: Array.from(m.ay.regs.subarray(0, 11)), dump,
      state: null,
    };
    if (row.ticks > 0 && TICK_TARGETS.includes(row.ticks) && !rows.some((r) => r.ticks === row.ticks)) {
      row.state = Buffer.concat([m.ram.subarray(S.SPR_TAB, S.SPR_TAB + 96), m.ram.subarray(S.CELL_TILE, S.CELL_TILE + 768)]);
    }
    rows.push(row);
    if (onRefresh) onRefresh(m, row);
    if (ticksNow > ticks) break;
  }
  return { rows, entry };
}

// ---- the main run ------------------------------------------------------------------------------------------------
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const m = newMachine();
  const { rows, entry } = runCart(m);
  if (entry < 0) { console.log('entry: NOT REACHED'); process.exit(1); }
  console.log(`entry (HO_MARK) at refresh ${entry}; ${rows.length} refreshes, last V_TICKS ${rows.at(-1).ticks}`);

  const tickScreen = new Map();
  for (const r of rows) if (!tickScreen.has(r.shown)) tickScreen.set(r.shown, r);
  for (const n of TICK_TARGETS) {
    const r = tickScreen.get(n);
    if (!r) { console.log(`displayed tick ${n}: not reached`); continue; }
    writeFileSync(`${PREFIX}-t${n}.bin`, r.dump);
    console.log(`displayed tick ${n}: refresh ${r.f} (V_TICKS ${r.ticks}, V_SYNC ${r.sync}), file ${r.file}, md5 ${r.md5}`);
  }
  for (const n of TICK_TARGETS) {
    const r = rows.find((x) => x.ticks === n);
    if (r) writeFileSync(`${PREFIX}-state-t${n}.bin`, r.state);
  }

  // timing: refreshes between successive V_TICKS changes
  const changes = [];
  for (let i = 1; i < rows.length; i++) if (rows[i].ticks !== rows[i - 1].ticks) changes.push({ tick: rows[i].ticks, at: rows[i].f });
  const gaps = changes.slice(1).map((c, i) => c.at - changes[i].at);
  const avg = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const worst = Math.max(...gaps);
  const hist = {}; for (const g of gaps) hist[g] = (hist[g] || 0) + 1;
  const timing = [
    `ticks observed ${changes.length}; refreshes per tick: average ${avg.toFixed(3)}, worst ${worst}, histogram ${JSON.stringify(hist)}`,
    `first ticks (tick: refresh): ${changes.slice(0, 20).map((c) => `${c.tick}:${c.at}`).join(' ')}`,
    `ticks per second of emulated time (TSRun: ${M.cpuHz} T/s, ${M.tStatesPerFrame} T per refresh): ${(M.cpuHz / M.tStatesPerFrame / avg).toFixed(3)}`,
  ];
  writeFileSync(`${PREFIX}-timing.txt`, timing.join('\n') + '\n');
  console.log(timing.join('\n'));

  const log = ['refresh ticks sync shown file sfx md5 AY(R0..R10)'];
  for (const r of rows) log.push(`${r.f} ${r.ticks} ${r.sync} ${r.shown} ${r.file} ${r.sfx} ${r.md5} ${r.ay.map((v) => v.toString(16).padStart(2, '0')).join(' ')}`);
  writeFileSync(`${PREFIX}-log.txt`, log.join('\n') + '\n');

  // AY: the first sound effect(s)
  const ayLines = [];
  const starts = rows.map((r, i) => (i > 0 && r.sfx !== 0 && rows[i - 1].sfx === 0 ? i : -1)).filter((i) => i >= 0);
  if (!starts.length) ayLines.push('no sound effect in the run');
  for (const si of starts.slice(0, 3)) {
    ayLines.push(`effect starts: refresh ${rows[si].f}, V_TICKS ${rows[si].ticks}, V_SFX_ACTIVE ${hex(rows[si].sfx)}`);
    ayLines.push('refresh ticks  sfx  R0 R1 R2 R3 R4 R5 R6 R7 R8 R9 R10 (chip, after the refresh)');
    for (let i = Math.max(0, si - 2); i < Math.min(rows.length, si + 6); i++) {
      const r = rows[i];
      ayLines.push(`${String(r.f).padStart(7)} ${String(r.ticks).padStart(5)} ${String(r.sfx).padStart(4)}  ${r.ay.map((v) => v.toString(16).padStart(2, '0')).join(' ')}`);
    }
    ayLines.push('');
  }
  writeFileSync(`${PREFIX}-ay.txt`, ayLines.join('\n') + '\n');
  console.log(`sound effects start at ticks: ${starts.map((i) => rows[i].ticks).join(' ') || '-'}`);
}
