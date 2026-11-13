#!/usr/bin/env node
"use strict";
// orbit-tsrun.mjs -- run the Orbit Gates cartridge (runtime v2, arcade/build/orbit.dck) on TSRun's stock TS2068 and sample it at the end of every tick.
// Adapted from platformer-tsrun.mjs (same sampling point: the runtime's WORK_END, V_TICKS just incremented, the hidden display file V_HIDDEN holds the
// tick's finished picture; found by running each frame one instruction at a time; ZEsarUX breaks at the same address).
// Input (orbit-scenario.json): `runs` is the stick value of every FRAME call, run-length coded [value, ticks] (joystick 1 bits: 1 up, 2 down, 4 left, 8 right,
// 16 fire; the format of tests/arcade-orbit.mjs).  Index t of the expanded list is the input the FRAME call made when V_TICKS = t reads (call t+1; the
// game's tick number fc = t+1); it is applied at the WORK_END where V_TICKS becomes t (before the first tick: at the start).
//   node arcade/tools/xemu/orbit-tsrun.mjs [cart.dck] [--mode keys|joystick|script] [--out arcade/build/xemu/orbit] [--tag NAME]
//   --mode keys      (default) the stick bits are pressed as keys on TSRun's keyboard matrix: left O, right P, up Q, down A, fire SPACE (the game reads both)
//   --mode joystick  the stick bits go to TSRun's joystick 1 (what STICK(1) reads: the way the recorded scripts were made)
//   --mode script    no input from here: the cartridge is the one patched by orbit-patch.mjs (RT_KEYDOWN reads a per-tick table)
// Writes, with prefix <out>/<tag> (default orbit-tsrun, orbit-tsrun-joystick, orbit-tsrun-script):
//   -t<N>.bin        6912 bytes: the finished hidden file at WORK_END with V_TICKS = N (the picture of FRAME call N), for every tick
//   -state-t<N>.bin  RT_SEED (2) + WIREVARS (W_VARS, 128) + GAMEVARS (3840) + SPR_TAB (128) + CELL_TILE (768) + CELL_ATTR (768) + W_REC (1280: the wireframe record) at that point
//   -log.txt         one line per tick: ticks scene(0 title, 1 play, 2 over) px pz ea spd fuel shd gates score keys(V_KEYS[0..7]) border V_FRAMES md5(hidden screen)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ARCADE = resolve(HERE, '../..');
const TSRUN = join(ARCADE, '../tsrun');
const M = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
const Z = await import(pathToFileURL(join(TSRUN, 'z80.js')).href);
const rt = JSON.parse(readFileSync(join(ARCADE, 'build/v2/runtime.json'), 'utf8'));
const S = rt.symbols, C = rt.constants;
export const scenario = JSON.parse(readFileSync(join(HERE, 'orbit-scenario.json'), 'utf8'));
export const meta = () => JSON.parse(readFileSync(join(ARCADE, 'build/xemu/orbit/meta.json'), 'utf8'));

export const md5 = (b) => createHash('md5').update(b).digest('hex');
export const STICK = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, FIRE: 16 };
// the matrix position of each key the game reads (row = half-row index, bit 0..4; the same table as runtime keys.asm)
export const KEYS = { LEFT: [5, 1, 'O'], RIGHT: [5, 0, 'P'], UP: [2, 0, 'Q'], DOWN: [1, 0, 'A'], FIRE: [7, 0, 'SPACE'] };
export const expand = (runs) => { const a = []; for (const [v, n] of runs) for (let i = 0; i < n; i++) a.push(v); return a; };
export const script = expand(scenario.runs);
export const stickAt = (t) => script[t] ?? 0;
export const targetTicks = () => scenario.sample_ticks;
// Which ranges make up "the state" (the same list in orbit-zesarux.py)
export const STATE_PARTS = (m) => [['RT_SEED', S.RT_SEED, 2], ['WIREVARS', C.W_VARS, C.W_VARS_LEN], ['GAMEVARS', C.GAME_VARS_BASE, C.GAME_VARS_LIMIT - C.GAME_VARS_BASE + 1],
  ['SPR_TAB', C.SPR_TAB, 128], ['CELL_TILE', C.CELL_TILE, 768], ['CELL_ATTR', C.CELL_ATTR, 768], ['W_REC', C.W_REC, C.W_REC_LEN]];

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
export function run(m, { lastTick = scenario.last_tick, maxFrames = 20000, onTick, onFrame = null } = {}) {
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
export const stateOf = (m) => Buffer.concat(STATE_PARTS(m).map(([, a, n]) => Buffer.from(m.ram.subarray(a, a + n))));
const sgn = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
/** the joystick-port byte for a stick value: TSRun's joystick[] is active low, bit 7 = fire (as tests/arcade-m8-orbit-perf.mjs) */
const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
export function applyInput(m, mode, t) {
  const sv = stickAt(t);
  if (mode === 'keys') {
    for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F;
    for (const [name, bit] of Object.entries(STICK)) if (sv & bit) { const [row, b] = KEYS[name]; m.keyMatrix[row] &= ~(1 << b); }
  } else if (mode === 'joystick') {
    m.joystick[0] = contact(sv); m.joystick[1] = contact(0);
  }
}
export const logLine = (m, t, scr, vars) => {
  const g = (name) => sgn(rd16(m, vars[name]));
  return `${t} ${m.ram[vars.sceneAddr]} ${g('PX')} ${g('PZ')} ${g('EA')} ${g('SPD')} ${g('FUEL')} ${g('SHD')} ${g('GATES')} ${g('SCORE')} ${Array.from(m.ram.subarray(S.V_KEYS, S.V_KEYS + 8)).map((v) => v.toString(16).padStart(2, '0')).join('')} ${m.ram[S.V_BORDER]} ${rd16(m, S.V_FRAMES)} ${md5(scr)}`;
};
export const LOG_HEADER = 'ticks scene px pz ea spd fuel shd gates score keys(V_KEYS[0..7]) border V_FRAMES(refreshes since boot) md5(hidden file)';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = { dck: join(ARCADE, 'build/orbit.dck'), out: join(ARCADE, 'build/xemu/orbit'), mode: 'keys', tag: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') opt.out = resolve(args[++i]);
    else if (args[i] === '--mode') opt.mode = args[++i];
    else if (args[i] === '--tag') opt.tag = args[++i];
    else opt.dck = resolve(args[i]);
  }
  if (opt.mode === 'script' && opt.dck.endsWith('/orbit.dck')) opt.dck = join(ARCADE, 'build/orbit-script.dck');
  const tag = opt.tag || (opt.mode === 'keys' ? 'orbit-tsrun' : `orbit-tsrun-${opt.mode}`);
  mkdirSync(opt.out, { recursive: true });
  const P = join(opt.out, tag);
  const m = newMachine(opt.dck);
  const vars = { ...meta().vars, sceneAddr: meta().sceneAddr };
  const targets = new Set(targetTicks());
  const log = [LOG_HEADER];
  applyInput(m, opt.mode, 0);
  const { entered, frames, lastSeen } = run(m, {
    onTick(mm, t) {
      const scr = hiddenScreen(mm);
      log.push(logLine(mm, t, scr, vars));
      writeFileSync(`${P}-t${t}.bin`, scr);   // every tick's finished screen is kept (so a differing tick can be looked at); the state only at the sampled ticks
      if (targets.has(t)) writeFileSync(`${P}-state-t${t}.bin`, stateOf(mm));
      applyInput(mm, opt.mode, t);
    },
  });
  writeFileSync(`${P}-log.txt`, log.join('\n') + '\n');
  console.log(`${tag}: entered ${entered}, ${frames} refreshes, last tick ${lastSeen}, ${log.length - 1} ticks logged`);
}
