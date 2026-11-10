#!/usr/bin/env node
"use strict";
// platformer-tsrun.mjs -- run the platformer cartridge (runtime v3) on TSRun's stock TS2068 and sample it at the end of every tick.
// Adapted from shooter-tsrun.mjs.  The sampling point is the runtime's WORK_END (main.asm: the instruction after V_TICKS was incremented and the
// finished file requested), found by running each frame one instruction at a time; ZEsarUX breaks at the same address.  At that point
//   * the tick's work is complete and nothing of the next tick has started, so the game state is the state "at V_TICKS = N" on any emulator;
//   * the hidden display file (V_HIDDEN) holds the finished picture of the tick, which is what the next interrupt shows.
// Input (platformer-scenario.json): the key state for tick N is applied at the WORK_END where V_TICKS becomes N, before FRAME(N) runs.
//   node arcade/tools/xemu/platformer-tsrun.mjs [cart.dck] [--mode keys|script] [--out arcade/build/xemu/platformer] [--tag NAME]
//   --mode keys    (default) the scenario's keys are pressed on TSRun's keyboard matrix (what the game's KEYDOWN reads)
//   --mode script  no keys: the cartridge is the one patched by platformer-patch.mjs (RT_KEYDOWN reads a per-tick table)
// Writes, with prefix <out>/<tag> (tag default platformer-tsrun, platformer-tsrun-script for --mode script):
//   -t<N>.bin        6912 bytes: the finished hidden file at WORK_END with V_TICKS = N (picture of "tick N-1's work")
//   -state-t<N>.bin  V3VARS (256) + GAMEVARS (2048) + SPR_TAB (128) + CELL_TILE (768) + WORLD_RAM (2048) at that point
//   -log.txt         one line per tick: ticks cam keys(V_KEYS[0..7]) hidden screen md5
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const TSRUN = join(ARCADE, '../tsrun');
const M = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
const Z = await import(pathToFileURL(join(TSRUN, 'z80.js')).href);
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v3/runtime.json'), 'utf8'));
const S = rt.symbols, C = rt.constants;
export const scenario = JSON.parse(readFileSync(join(HERE, 'platformer-scenario.json'), 'utf8'));

export const md5 = (b) => createHash('md5').update(b).digest('hex');
// Which ranges make up "the state" (the same list in platformer-zesarux.py)
export const STATE_PARTS = [['V3VARS', C.V3VARS, C.V3VARS_LEN], ['GAMEVARS', C.GAME_VARS_BASE, C.GAME_VARS_LIMIT - C.GAME_VARS_BASE + 1],
  ['SPR_TAB', S.SPR_TAB, 128], ['CELL_TILE', S.CELL_TILE, 768], ['WORLD_RAM', S.WORLD_RAM, S.WORLD_RAM_LEN]];
export const targetTicks = () => [...scenario.title_ticks, ...scenario.play_ticks];
/** keys pressed for tick n: list of {name,row,bit} */
export const keysAt = (n) => scenario.keys.filter((k) => n >= k.from && n <= k.to);

export function newMachine(dck) {
  const m = M.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  M.setHomeRom(m, readFileSync(join(TSRUN, 'roms/ts2068-0.rom')));
  M.setExRom(m, readFileSync(join(TSRUN, 'roms/ts2068-1.rom')));
  M.insertDock(m, new Uint8Array(readFileSync(dck)));
  M.resetMachine(m);
  return m;
}
const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);

/** One frame, one instruction at a time, calling onPC(m) when the PC is at `pc` (before that instruction runs). */
function runFrameWatched(m, pc, onPC) {
  const end = m.frameStart + M.tStatesPerFrame;
  const cpu = m.cpu;
  while (m.tstates < end) {
    if (cpu.halted || cpu.nmiPending) break;
    if (cpu.pc === pc) onPC(m);
    Z.runZ80(cpu, m.bus, 1, m);
  }
  M.runFrame(m);
}

/** Run until V_TICKS passes `lastTick` or `maxFrames` refreshes; call onTick(m, ticks) at every WORK_END after the entry. */
export function run(m, { lastTick = scenario.last_tick, maxFrames = 6000, onTick, onFrame = null } = {}) {
  let entered = false, frames = 0, lastSeen = -1;
  while (frames++ < maxFrames) {
    runFrameWatched(m, S.WORK_END, (mm) => {
      if (rd16(mm, S.HO_MARK) !== 0x5AA5) return;
      entered = true;
      const t = rd16(mm, S.V_TICKS);
      if (t === lastSeen) return;
      lastSeen = t;
      onTick(mm, t);
    });
    if (onFrame) onFrame(m);
    if (lastSeen >= lastTick) break;
  }
  return { entered, frames, lastSeen };
}

export const hiddenScreen = (m) => {
  const f = m.ram[S.V_HIDDEN];
  const dfile = f ? C.DFILE1 : C.DFILE0, dattr = f ? C.DATTR1 : C.DATTR0;
  return Buffer.concat([m.ram.subarray(dfile, dfile + 6144), m.ram.subarray(dattr, dattr + 768)]);
};
export const stateOf = (m) => Buffer.concat(STATE_PARTS.map(([, a, n]) => Buffer.from(m.ram.subarray(a, a + n))));

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = { dck: join(ARCADE, 'build/platformer.dck'), out: join(ARCADE, 'build/xemu/platformer'), mode: 'keys', tag: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') opt.out = resolve(args[++i]);
    else if (args[i] === '--mode') opt.mode = args[++i];
    else if (args[i] === '--tag') opt.tag = args[++i];
    else opt.dck = resolve(args[i]);
  }
  if (opt.mode === 'script' && opt.dck.endsWith('/platformer.dck')) opt.dck = join(ARCADE, 'build/platformer-script.dck');
  const tag = opt.tag || (opt.mode === 'script' ? 'platformer-tsrun-script' : 'platformer-tsrun');
  mkdirSync(opt.out, { recursive: true });
  const P = join(opt.out, tag);
  const m = newMachine(opt.dck);
  const targets = new Set(targetTicks());
  const log = ['ticks cam keys(V_KEYS[0..7]) md5(hidden file)'];
  const camAt = (mm) => rd16(mm, S.V_CAM);
  const { entered, frames, lastSeen } = run(m, {
    onTick(mm, t) {
      // the state first (the log of what the game read for the previous tick), then the keys for tick t
      const scr = hiddenScreen(mm);
      log.push(`${t} ${camAt(mm)} ${Array.from(mm.ram.subarray(S.V_KEYS, S.V_KEYS + 8)).map((v) => v.toString(16).padStart(2, '0')).join('')} ${md5(scr)}`);
      if (targets.has(t)) {
        writeFileSync(`${P}-t${t}.bin`, scr);
        writeFileSync(`${P}-state-t${t}.bin`, stateOf(mm));
      }
      if (opt.mode === 'keys') {
        for (let r = 0; r < 8; r++) mm.keyMatrix[r] = 0x1F;
        for (const k of keysAt(t)) mm.keyMatrix[k.row] &= ~(1 << k.bit);
      }
    },
  });
  writeFileSync(`${P}-log.txt`, log.join('\n') + '\n');
  console.log(`${tag}: entered ${entered}, ${frames} refreshes, last tick ${lastSeen}, ${log.length - 1} ticks logged`);
}
