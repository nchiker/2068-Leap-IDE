#!/usr/bin/env node
"use strict";
// shooter-tsrun.mjs -- run the Starfall cartridge (arcade/examples/shooter.arc, runtime v2, arcade/build/shooter.dck) on TSRun's stock TS2068 and sample it at the end of every tick.
// Rewritten after language batch 4 (the game starts on a TITLE scene that waits for fire, then the PLAY scene; GAME OVER is a third scene) on the model of runner-tsrun.mjs:
// same sampling point (the runtime's WORK_END, V_TICKS just incremented, the hidden display file V_HIDDEN holds the tick's finished picture; found by running each frame one
// instruction at a time; ZEsarUX breaks at the same address).
// Input (shooter-scenario.json, made by shooter-scenario-make.mjs): `runs` is the stick value of every FRAME call, run-length coded [value, ticks] (joystick 1 bits: 1 up, 2 down,
// 4 left, 8 right, 16 fire).  Index t of the expanded list is the input the FRAME call made when V_TICKS = t reads (call t+1); it is applied at the WORK_END where V_TICKS becomes t
// (before the first tick: at the start).
// Order of the commands (details in each script's header):
//   node arcade/tools/xemu/shooter-scenario-make.mjs                   -> shooter-scenario.json (the title, fire, play, GAME OVER, fire again: 666 ticks)
//   node arcade/tools/xemu/shooter-build.mjs                           -> arcade/build/shooter.dck + arcade/build/xemu/shooter/meta.json   (needs arcade/build/v2: node arcade/tools/build-runtime-v2.mjs)
//   node arcade/tools/xemu/shooter-patch.mjs                           -> arcade/build/shooter-script.dck (keyboard reads from a per-tick table)
//   node arcade/tools/xemu/shooter-tsrun.mjs [--mode keys|joystick|script]  -> <out>/shooter-tsrun[-joystick|-script]-*
//   python3 arcade/tools/xemu/shooter-zesarux.py [--mode keys|script]  -> <out>/shooter-zesarux[-script]-*
//   sh arcade/tools/xemu/shooter-fuse.sh [CART] [OUTDIR]               -> arcade/build/xemu/fuse-shooter-script/frame-*.scr  (script cartridge; OUTDIR must be new)
//   node arcade/tools/xemu/shooter-compare.mjs [--dir arcade/build/xemu] [--fuse DIR]   (the verdicts)
//   node arcade/tools/xemu/shooter-keys-tsrun.mjs                      (TSRun only: the keyboard through TSRun's own key translation: start with SPACE, O P Q A move, SPACE fires)
//   node arcade/tools/xemu/shooter-tsrun.mjs [cart.dck] [--mode keys|joystick|script] [--out arcade/build/xemu/shooter] [--tag NAME]
//   --mode keys      (default) the stick bits are pressed as keys on TSRun's keyboard matrix: left O, right P, up Q, down A, fire SPACE
//   --mode joystick  the stick bits go to TSRun's joystick 1 (what STICK(1) reads)
//   --mode script    no input from here: the cartridge is the one patched by shooter-patch.mjs (RT_KEYDOWN reads a per-tick table)
// Writes, with prefix <out>/<tag> (default shooter-tsrun, shooter-tsrun-joystick, shooter-tsrun-script):
//   -t<N>.bin        6912 bytes: the finished hidden file at WORK_END with V_TICKS = N (the picture of FRAME call N), for every tick
//   -state-t<N>.bin  GAMEVARS (3840) + SPR_TAB (96) + CELL_TILE (768) + RT_SEED (2) at that point, at the sampled ticks
//   -log.txt         one line per tick: ticks scene score wave px py lives keys(V_KEYS[0..7]) border V_FRAMES V_SFX_ACTIVE md5(hidden screen) AY(R0..R10 from the chip)
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
export const scenario = JSON.parse(readFileSync(join(HERE, 'shooter-scenario.json'), 'utf8'));
export const meta = () => JSON.parse(readFileSync(join(ARCADE, 'build/xemu/shooter/meta.json'), 'utf8'));

export const md5 = (b) => createHash('md5').update(b).digest('hex');
export const STICK = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, FIRE: 16 };
// the matrix position of each key the game reads (row = half-row index, bit 0..4; the same table as runtime keys.asm)
export const KEYS = { LEFT: [5, 1, 'O'], RIGHT: [5, 0, 'P'], UP: [2, 0, 'Q'], DOWN: [1, 0, 'A'], FIRE: [7, 0, 'SPACE'] };
export const expand = (runs) => { const a = []; for (const [v, n] of runs) for (let i = 0; i < n; i++) a.push(v); return a; };
export const script = expand(scenario.runs);
export const stickAt = (t) => script[t] ?? 0;
export const targetTicks = () => scenario.sample_ticks;
// Which ranges make up "the state" (the same list in shooter-zesarux.py and shooter-compare.mjs)
export const STATE_PARTS = [['GAMEVARS', C.GAME_VARS_BASE, C.GAME_VARS_LIMIT - C.GAME_VARS_BASE + 1], ['SPR_TAB', S.SPR_TAB, 96], ['CELL_TILE', S.CELL_TILE, 768], ['RT_SEED', S.RT_SEED, 2]];

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

/** Run until V_TICKS reaches `lastTick` or `maxFrames` refreshes; call onTick(m, ticks) at every WORK_END after the entry. */
export function run(m, { lastTick = scenario.last_tick, maxFrames = 8000, onTick, onFrame = null } = {}) {
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
const sgn = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
/** the joystick-port byte for a stick value: TSRun's joystick[] is active low, bit 7 = fire (as tests/arcade-m8-runner-perf.mjs) */
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
export const logLine = (m, t, scr, vars, sceneAddr) => {
  const g = (name) => sgn(rd16(m, vars[name]));
  return `${t} ${rd16(m, sceneAddr)} ${g('SCORE')} ${g('WV')} ${g('PX')} ${g('PY')} ${g('LIVES')} ${Array.from(m.ram.subarray(S.V_KEYS, S.V_KEYS + 8)).map((v) => v.toString(16).padStart(2, '0')).join('')} ${m.ram[S.V_BORDER]} ${rd16(m, S.V_FRAMES)} ${m.ram[S.V_SFX_ACTIVE]} ${md5(scr)} ${Array.from(m.ay.regs.subarray(0, 11)).map((v) => v.toString(16).padStart(2, '0')).join(' ')}`;
};
export const LOG_HEADER = 'ticks scene score wave px py lives keys(V_KEYS[0..7]) border V_FRAMES(refreshes since boot) V_SFX_ACTIVE md5(hidden file) AY(R0..R10, the chip)';

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const opt = { dck: join(ARCADE, 'build/shooter.dck'), out: join(ARCADE, 'build/xemu/shooter'), mode: 'keys', tag: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') opt.out = resolve(args[++i]);
    else if (args[i] === '--mode') opt.mode = args[++i];
    else if (args[i] === '--tag') opt.tag = args[++i];
    else opt.dck = resolve(args[i]);
  }
  if (opt.mode === 'script' && opt.dck.endsWith('/shooter.dck')) opt.dck = join(ARCADE, 'build/shooter-script.dck');
  const tag = opt.tag || (opt.mode === 'keys' ? 'shooter-tsrun' : `shooter-tsrun-${opt.mode}`);
  mkdirSync(opt.out, { recursive: true });
  const P = join(opt.out, tag);
  const m = newMachine(opt.dck);
  const mt = meta();
  const targets = new Set(targetTicks());
  const log = [LOG_HEADER];
  applyInput(m, opt.mode, 0);
  const { entered, frames, lastSeen } = run(m, {
    onTick(mm, t) {
      const scr = hiddenScreen(mm);
      log.push(logLine(mm, t, scr, mt.vars, mt.scene));
      writeFileSync(`${P}-t${t}.bin`, scr);   // every tick's finished screen is kept (so a differing tick can be looked at); the state only at the sampled ticks
      if (targets.has(t)) writeFileSync(`${P}-state-t${t}.bin`, stateOf(mm));
      applyInput(mm, opt.mode, t);
    },
  });
  writeFileSync(`${P}-log.txt`, log.join('\n') + '\n');
  console.log(`${tag}: entered ${entered}, ${frames} refreshes, last tick ${lastSeen}, ${log.length - 1} ticks logged`);
}
