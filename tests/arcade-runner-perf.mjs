#!/usr/bin/env node
"use strict";
// arcade-runner-perf.mjs -- per-tick cost of arcade/examples/runner.arc, "Leap Runner", on the REAL runtime v3 (arcade/build/v3), TSRun, real frame interrupt, no contention,
// over its recorded play-through (arcade/examples/runner.script.json: the title, level 1 to its flag, "LEVEL 2", level 2, ... the win screen).
//   node tests/arcade-runner-perf.mjs            the distribution of the ticks, the worst tick that is not a world load, window_repaint's mean, the ticks over budget
//   node tests/arcade-runner-perf.mjs --check    exit 1 unless the worst tick that is not a world load is below 173,167 T (docs/ARCADE_WINDOW_FASTPATH.md section 4: the figure
//                                                before the window fast path) and no tick that is not a world load is over the budget (3 refreshes = 176,064 T, interrupt time included)
//   node tests/arcade-runner-perf.mjs --ticks N  only the first N ticks (a quick look)
//
// How a tick is measured (as tests/arcade-m6-platformer-perf.mjs and arcade/tests/m7-runtime-perf.mjs): the instruction stream is single-stepped; a tick is WORK_START..WORK_END of the
// runtime's main loop, given with the interrupt handler's time ("t", what decides whether the tick is late) and without it ("tx"). The joystick of tick k is put on the machine when
// PROC FRAME is entered for tick k. A tick is marked as a LOAD when, inside it, the runtime enters RT_WORLDLOAD (the WORLD statement: the new world is decoded and the whole window is
// redrawn, so it is one long tick over its refreshes) or window_boot (a scene starts); loads are reported on their own and are not in the distribution or in the bound.
// Since language batch 7 part C the game has three scenes (title without the window, demo, play), so the recorded play-through starts in the title: the first two ticks of the first scene and the tick that
// executes an ENTER with the two after it are loads too ("scene start"): a scene starts from a screen of freshly loaded cells (the title's picture is all 768 cells, drawn in both display files by the first
// two ticks, about 360,000 T each; the game's first two ticks after ENTER repaint the window in both files). They are not gameplay ticks; what the bound is about, gameplay, starts after them.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const EX = join(ROOT, 'arcade/examples');
const M_ = await import(pathToFileURL(join(ROOT, 'tsrun/machine.js')).href);
const Z_ = await import(pathToFileURL(join(ROOT, 'tsrun/z80.js')).href);
const FRAME_T = M_.tStatesPerFrame;
const BUDGET = 3 * FRAME_T;
const WORST_BEFORE = 173167;                                  // the worst tick that is not a world load, before the window fast path (batch 6 "As built")
const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
const unrle = (r) => { const a = []; for (const [v, n] of r) for (let i = 0; i < n; i++) a.push(v); return a; };
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor(a.length * p))] : 0);

const SRC = readFileSync(join(EX, 'runner.arc'), 'utf8');
const ASSETS = JSON.parse(readFileSync(join(EX, 'runner.assets.json'), 'utf8'));
const SCRIPT_FILE = join(EX, 'runner.script.json');
if (!existsSync(SCRIPT_FILE)) { console.error('arcade/examples/runner.script.json is missing: node tests/arcade-runner.mjs --record'); process.exit(2); }
const scriptInfo = JSON.parse(readFileSync(SCRIPT_FILE, 'utf8'));
const script = unrle(scriptInfo.runs);
// the game as it is, unless the recorded route needs more than its three lives (the one place tests/arcade-runner.mjs changes the source too)
const START_MARK = 'score = 0 : lives = 3 : hud = 0 : lv = 0';
let PLAY_SRC = SRC;
if (scriptInfo.lives !== 3) { if (!SRC.includes(START_MARK)) throw new Error('runner.arc lost the GSTAGE 0 line the tests vary'); PLAY_SRC = SRC.replace(START_MARK, `score = 0 : lives = ${scriptInfo.lives} : hud = 0 : lv = 0`); }

const argv = process.argv.slice(2);
const TICKS = argv.includes('--ticks') ? Math.min(script.length, Number(argv[argv.indexOf('--ticks') + 1])) : script.length;

const json = join(ROOT, 'arcade/build/v3/runtime.json');
const rt = JSON.parse(readFileSync(json, 'utf8'));
const img = new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin')));
const res = compile(PLAY_SRC, { runtime: rt, image: img, assets: ASSETS });
const SCENE_CUR = res.gen?.symbols?.scene?.cur ?? null;
if (res.errors.length) throw new Error('compile: ' + res.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
const S = { ...rt.symbols, ...(rt.constants ?? {}) };
for (const k of ['RT_WORLDLOAD', 'window_boot', 'window_repaint', 'WORK_START', 'WORK_END', 'AFTER_FRAME', 'ISR', 'ISR_END', 'SND_S', 'SND_E']) if (S[k] === undefined) throw new Error(`the runtime has no symbol ${k}`);

const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
const ROMDIR = join(ROOT, 'tsrun/roms');
M_.setHomeRom(m, readFileSync(join(ROMDIR, 'ts2068-0.rom')));
M_.setExRom(m, readFileSync(join(ROMDIR, 'ts2068-1.rom')));
M_.insertDock(m, res.dck);
M_.resetMachine(m);
const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
for (let f = 0; f < 400 && rd16(S.HO_MARK) !== S.HO_MARK_VALUE; f++) M_.runFrame(m);
if (rd16(S.HO_MARK) !== S.HO_MARK_VALUE) throw new Error('the runtime did not boot');

const fe = res.map.entries.frame;
const div = res.memory[0x8004] & 0x3F;
const ticks = [];
let inIsr = false, isrT0 = 0, isrAcc = 0, w0 = null, entries = 0, load = null, rep = null, repT = 0;
let prevScene = SCENE_CUR !== null ? 0 : -1, grace = SCENE_CUR !== null ? 2 : 0;          // scene start: the first scene's first two ticks, and the tick that ENTERs a scene with the two after it
const nframes = (TICKS + 3) * Math.max(div, 3) * 4 + 400;
for (let f = 0; f < nframes && ticks.length < TICKS; f++) {
  const end = m.frameStart + FRAME_T;
  while (m.tstates < end) {
    const cpu = m.cpu, pc = cpu.pc;
    const isr = (pc >= S.ISR && pc < S.ISR_END) || (pc >= S.SND_S && pc < S.SND_E);
    if (isr && !inIsr) { inIsr = true; isrT0 = m.tstates - 13; } else if (!isr && inIsr) { inIsr = false; isrAcc += m.tstates - isrT0; }
    if (!inIsr) {
      if (pc === S.WORK_START) { w0 = { t0: m.tstates, i0: isrAcc }; load = null; repT = 0; rep = null; }
      if (pc === fe && w0) { entries++; m.joystick[0] = contact(script[entries - 1] ?? 0); m.joystick[1] = 0; }
      if (w0) {
        if (pc === S.RT_WORLDLOAD) load = 'WORLD';
        else if (pc === S.window_boot && !load) load = 'scene';
        if (pc === S.window_repaint && !rep) rep = { t0: m.tstates, sp: cpu.sp, ret: rd16(cpu.sp), i0: isrAcc };
        else if (rep && pc === rep.ret && cpu.sp === rep.sp + 2) { repT += m.tstates - rep.t0 - (isrAcc - rep.i0); rep = null; }
      }
      if (pc === S.WORK_END && w0) {
        if (SCENE_CUR !== null && m.ram[SCENE_CUR] !== prevScene) { prevScene = m.ram[SCENE_CUR]; grace = 3; }
        if (grace > 0) { if (!load) load = 'scene start'; grace--; }
        ticks.push({ n: entries, load, t: m.tstates - w0.t0, tx: m.tstates - w0.t0 - (isrAcc - w0.i0), repaint: repT });
        w0 = null;
      }
    }
    if (cpu.halted) break;
    Z_.runZ80(cpu, m.bus, 1, m);
  }
  M_.runFrame(m);
}

const loads = ticks.filter((x) => x.load), play = ticks.filter((x) => !x.load);
const sorted = play.map((x) => x.t).sort((a, b) => a - b);
const worst = play.reduce((a, x) => (x.t > a.t ? x : a), { t: 0, n: 0 });
const over = ticks.filter((x) => x.t > BUDGET), overPlay = play.filter((x) => x.t > BUDGET);
console.log(`Leap Runner, the recorded play-through: ${ticks.length} ticks (${TICKS < script.length ? `first ${TICKS} of ${script.length}` : 'all'}), frame_div ${div}, runtime ${rt.version}; budget ${fmt(BUDGET)} T (3 refreshes), interrupt time included`);
console.log(`  ticks that are not a world load: ${play.length}: median ${fmt(pct(sorted, 0.5))}, 95th ${fmt(pct(sorted, 0.95))}, 99th ${fmt(pct(sorted, 0.99))}, worst ${fmt(worst.t)} (tick ${worst.n}; ${fmt(worst.tx)} without the interrupt), mean ${fmt(mean(play.map((x) => x.t)))}`);
console.log(`  window_repaint: mean ${fmt(mean(ticks.map((x) => x.repaint)))} T a tick over all ticks, ${fmt(mean(play.map((x) => x.repaint)))} over the ticks that are not loads (max ${fmt(Math.max(...ticks.map((x) => x.repaint)))})`);
console.log(`  loads (ticks that call RT_WORLDLOAD or are a scene start): ${loads.length}: ${loads.map((x) => `tick ${x.n} ${x.load} ${fmt(x.t)}`).join(', ') || 'none'}`);
console.log(`  ticks over ${fmt(BUDGET)}: ${over.length} in all (${overPlay.length} that are not loads${overPlay.length ? ': ' + overPlay.map((x) => `tick ${x.n} ${fmt(x.t)}`).join(', ') : ''})`);
console.log(`  the 5 costliest ticks that are not loads: ${play.slice().sort((a, b) => b.t - a.t).slice(0, 5).map((x) => `tick ${x.n} ${fmt(x.t)} (repaint ${fmt(x.repaint)})`).join(', ')}`);
const ok = worst.t < WORST_BEFORE && overPlay.length === 0;
console.log(`  worst tick that is not a world load ${fmt(worst.t)} ${worst.t < WORST_BEFORE ? '<' : '>='} ${fmt(WORST_BEFORE)} (the figure before the window fast path): ${worst.t < WORST_BEFORE ? 'below' : 'NOT below'}`);
if (argv.includes('--check')) { console.log(ok ? 'PASS' : 'FAIL'); process.exit(ok ? 0 : 1); }
