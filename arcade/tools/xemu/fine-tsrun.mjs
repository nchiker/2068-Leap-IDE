#!/usr/bin/env node
"use strict";
// fine-tsrun.mjs -- run a fine-colour sample game (Starfall = shooter, Lumen = lumen; runtime v2, arcade/build/<game>.dck) on TSRun's stock TS2068 and sample it at the start of
// the game's FRAME call of every tick.  Adapted from orbit-tsrun.mjs.
//
//   node arcade/tools/xemu/fine-tsrun.mjs shooter|lumen [--mode keys|script|joystick] [--out DIR] [--tag NAME] [--max-frames N]
//
// SAMPLING POINT: the runtime's FINE_FRAME (fine.asm: the fine tick's `LD HL,(GAME_FRAME)` right after fine_publish).  A fine tick is: wait for the frame interrupt, PUBLISH the list
// composed by the tick before (the screen then equals the fine picture of that tick's state), run the game's FRAME entry, COMPOSE the new state into the list, V_TICKS + 1.  So at
// FINE_FRAME the screen ($4000 bitmap, $6000 colours, $FF = 2) is a complete picture, the same instruction on every emulator, and V_TICKS = the number of ticks completed; the FRAME call
// that follows is the (V_TICKS + 1)th and reads input index V_TICKS of the script (as the other xemu scripts: index t is applied where V_TICKS = t, before the call that reads it).
// Input (<game>-fine-scenario.json, made by fine-scenario-make.mjs): `runs` = the stick value of every FRAME call, run-length coded [value, ticks]; joystick 1 bits 1 up, 2 down,
// 4 left, 8 right, 16 fire.
//   --mode keys      (default) the bits are pressed as keys on TSRun's matrix: left O, right P, up Q, down A, fire SPACE (both games read keys and STICK(1) and OR them)
//   --mode joystick  the bits go to TSRun's joystick 1 (what STICK(1) reads)
//   --mode script    no input from here: the cartridge is the one patched by fine-patch.mjs (RT_KEYDOWN reads a per-tick table)
// Writes, with prefix <out>/<tag> (default <game>-tsrun, -tsrun-joystick, -tsrun-script; <out> default arcade/build/xemu/<game>-fine):
//   -t<N>.bin        12,288 bytes: the bitmap $4000-$57FF then the colour plane $6000-$77FF at FINE_FRAME with V_TICKS = N, for every tick
//   -state-t<N>.bin  RT_SEED (2) + GAME_VARS (3840) + SPR_TAB (128) + CELL_TILE (768) + CELL_ATTR (768) at that point (the sampled ticks of the scenario)
//   -log.txt         one line per tick: ticks scene(index) V_FINE $FF-mode keys(V_KEYS[0..7]) border V_FRAMES the-game's-main-variables md5(picture)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { ARCADE, HERE, GAMES, gameArg, dirOf, scenarioFile, readRuntime, readMeta } from './fine-games.mjs';

const TSRUN = join(ARCADE, '../tsrun');
const M = await import(pathToFileURL(join(TSRUN, 'machine.js')).href);
const Z = await import(pathToFileURL(join(TSRUN, 'z80.js')).href);
const rt = readRuntime();
export const S = rt.symbols, C = rt.constants;
export const md5 = (b) => createHash('md5').update(b).digest('hex');
export const STICK = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, FIRE: 16 };
// the matrix position of each key the games read (row = half-row index, bit 0..4; the same table as runtime keys.asm)
export const KEYS = { LEFT: [5, 1, 'O'], RIGHT: [5, 0, 'P'], UP: [2, 0, 'Q'], DOWN: [1, 0, 'A'], FIRE: [7, 0, 'SPACE'] };
export const expand = (runs) => { const a = []; for (const [v, n] of runs) for (let i = 0; i < n; i++) a.push(v); return a; };
/** the fine picture the screen holds: bitmap then colour plane (12,288 bytes) */
export const pictureOf = (m) => Buffer.concat([m.ram.subarray(0x4000, 0x5800), m.ram.subarray(0x6000, 0x7800)]);
/** the bytes compared as "the state" (the same list in fine-zesarux.py) */
export const STATE_PARTS = [['RT_SEED', S.RT_SEED, 2], ['GAMEVARS', C.GAME_VARS_BASE, C.GAME_VARS_LIMIT - C.GAME_VARS_BASE + 1], ['SPR_TAB', C.SPR_TAB, 128], ['CELL_TILE', C.CELL_TILE, 768], ['CELL_ATTR', C.CELL_ATTR, 768]];
export const stateOf = (m) => Buffer.concat(STATE_PARTS.map(([, a, n]) => Buffer.from(m.ram.subarray(a, a + n))));
export const rd16 = (m, a) => m.ram[a] | (m.ram[a + 1] << 8);
export const sgn = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
/** the joystick-port byte for a stick value: TSRun's joystick[] is active low, bit 7 = fire */
const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;

export function newMachine(dck) {
  const m = M.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  M.setHomeRom(m, readFileSync(join(TSRUN, 'roms/ts2068-0.rom')));
  M.setExRom(m, readFileSync(join(TSRUN, 'roms/ts2068-1.rom')));
  M.insertDock(m, new Uint8Array(readFileSync(dck)));
  M.resetMachine(m);
  return m;
}

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

/** Run until V_TICKS reaches `lastTick` or `maxFrames` refreshes; call onTick(m, ticks) at every FINE_FRAME (once per V_TICKS value). */
export function run(m, { lastTick, maxFrames = 40000, onTick, onFrame = null } = {}) {
  let frames = 0, lastSeen = -1;
  while (frames++ < maxFrames) {
    runFrameWatched(m, S.FINE_FRAME, (mm) => {
      const t = rd16(mm, S.V_TICKS);
      if (t === lastSeen) return;
      lastSeen = t;
      onTick(mm, t);
    });
    if (onFrame) onFrame(m);
    if (lastSeen >= lastTick) break;
  }
  return { frames, lastSeen };
}

export function applyInput(m, mode, sv) {
  if (mode === 'keys') {
    for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F;
    for (const [name, bit] of Object.entries(STICK)) if (sv & bit) { const [row, b] = KEYS[name]; m.keyMatrix[row] &= ~(1 << b); }
  } else if (mode === 'joystick') {
    m.joystick[0] = contact(sv); m.joystick[1] = contact(0);
  }
}

/** the per-tick log line; `vars` = the names of the variables to print (the game's main ones, read as signed 16-bit) */
export const LOG_HEADER = 'ticks scene vfine ff keys(V_KEYS[0..7]) border V_FRAMES(refreshes since boot) vars... md5(picture)';
export function logLine(m, t, pic, meta, names) {
  const vs = names.map((n) => sgn(rd16(m, meta.vars[n]))).join(' ');
  return `${t} ${m.ram[meta.sceneAddr]} ${m.ram[S.V_FINE]} ${m.ram[S.V_SHADOW_FF]} ${Array.from(m.ram.subarray(S.V_KEYS, S.V_KEYS + 8)).map((v) => v.toString(16).padStart(2, '0')).join('')} ${m.ram[S.V_BORDER]} ${rd16(m, S.V_FRAMES)} ${vs} ${md5(pic)}`;
}
/** the variables printed in the log: the score-ish ones that exist in the game */
export const LOG_VARS = { shooter: ['SCORE', 'WV', 'PLAY.LIVES'], lumen: ['SCORE', 'CAVE', 'PLAY.LIVES', 'PLAY.WX', 'PLAY.WY', 'PLAY.ORBS'] };

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const g = gameArg();
  const args = process.argv.slice(2);
  const opt = { out: dirOf(g), mode: 'keys', tag: null, maxFrames: 40000, dck: null };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--out') opt.out = resolve(args[++i]);
    else if (args[i] === '--mode') opt.mode = args[++i];
    else if (args[i] === '--tag') opt.tag = args[++i];
    else if (args[i] === '--max-frames') opt.maxFrames = +args[++i];
    else if (args[i].endsWith('.dck')) opt.dck = resolve(args[i]);
  }
  const dck = opt.dck ?? join(ARCADE, opt.mode === 'script' ? `build/${g}-script.dck` : `build/${g}.dck`);
  const tag = opt.tag || (opt.mode === 'keys' ? `${g}-tsrun` : `${g}-tsrun-${opt.mode}`);
  const sc = JSON.parse(readFileSync(scenarioFile(g), 'utf8'));
  const script = expand(sc.runs);
  const meta = readMeta(g);
  mkdirSync(opt.out, { recursive: true });
  const P = join(opt.out, tag);
  const m = newMachine(dck);
  const targets = new Set(sc.sample_ticks);
  const names = LOG_VARS[g];
  const log = [LOG_HEADER + ' [' + names.join(' ') + ']'];
  applyInput(m, opt.mode, script[0] ?? 0);
  const { frames, lastSeen } = run(m, {
    lastTick: sc.last_tick, maxFrames: opt.maxFrames,
    onTick(mm, t) {
      const pic = pictureOf(mm);
      log.push(logLine(mm, t, pic, meta, names));
      writeFileSync(`${P}-t${t}.bin`, pic);
      if (targets.has(t)) writeFileSync(`${P}-state-t${t}.bin`, stateOf(mm));
      applyInput(mm, opt.mode, script[t] ?? 0);
    },
  });
  writeFileSync(`${P}-log.txt`, log.join('\n') + '\n');
  console.log(`${tag}: ${frames} refreshes, last tick ${lastSeen}, ${log.length - 1} ticks logged${lastSeen < sc.last_tick ? '  (DID NOT REACH the last tick ' + sc.last_tick + ')' : ''}`);
}
