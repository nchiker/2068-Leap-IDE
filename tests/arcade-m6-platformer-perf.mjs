#!/usr/bin/env node
"use strict";
// arcade-m6-platformer-perf.mjs -- per-tick cost of arcade/examples/platformer.arc on the REAL runtime v3 (arcade/build/v3), TSRun, real frame interrupt, no contention.
//   node tests/arcade-m6-platformer-perf.mjs               the three recorded runs (win twice, game over): distribution, ticks over budget, the hot spots
//   node tests/arcade-m6-platformer-perf.mjs --spikes N    ... and the N costliest ticks of PROC FRAME broken down by source line and runtime routine
//   node tests/arcade-m6-platformer-perf.mjs --check       exit 1 when a gameplay tick goes over the budget (3 refreshes = 176,064 T, interrupt time included)
//
// How a tick is measured (as arcade/tests/m7-runtime-perf.mjs): the instruction stream is single-stepped. A tick is WORK_START..WORK_END of the runtime's main loop; its cost
// is given with the interrupt handler's time ("t", what decides whether the tick is late) and without it ("tx"). The game's logic is PROC FRAME: entered at the game's
// frame entry, left when the runtime reaches AFTER_FRAME. The joystick of tick k is put on the machine when PROC FRAME is entered for tick k. Inside the logic every
// instruction's time goes to the source line of the last game instruction (a runtime routine called from a line is charged to that line) and to the runtime routine running.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { PLATFORMER_SRC } from './arcade-m6-platformer-harness.mjs';
import { ASSETS, WIN_STICK, TWICE_STICK, TWICE_LENGTH, OVER_STICK, OVER_LENGTH } from './arcade-m6-common.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const M_ = await import(pathToFileURL(join(ROOT, 'tsrun/machine.js')).href);
const Z_ = await import(pathToFileURL(join(ROOT, 'tsrun/z80.js')).href);
export const FRAME_T = M_.tStatesPerFrame;
export const BUDGET = 3 * FRAME_T;
const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;

export function loadRuntime(dir = 'arcade/build/v3') {
  const json = join(ROOT, dir, 'runtime.json');
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))) };
}

/** Run `ticks` ticks of the compiled game with `stick(k)` and return one record per tick. */
export function profile(src, { ticks, stick, assets = ASSETS, runtimeDir } = {}) {
  const R = loadRuntime(runtimeDir);
  const res = compile(src, { runtime: R.rt, image: R.img, assets });
  if (res.errors.length) throw new Error('compile: ' + res.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | '));
  const S = { ...R.rt.symbols, ...(R.rt.constants ?? {}) };
  const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  const ROMDIR = join(ROOT, 'tsrun/roms');
  M_.setHomeRom(m, readFileSync(join(ROMDIR, 'ts2068-0.rom')));
  M_.setExRom(m, readFileSync(join(ROMDIR, 'ts2068-1.rom')));
  M_.insertDock(m, res.dck);
  M_.resetMachine(m);
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  for (let f = 0; f < 400 && rd16(S.HO_MARK) !== S.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(S.HO_MARK) !== S.HO_MARK_VALUE) throw new Error('the runtime did not boot');
  // address -> source line (game code), address -> procedure
  const lines = res.map.lines.slice().sort((a, b) => a.addr - b.addr);
  const lineOf = (pc) => { let lo = 0, hi = lines.length - 1, r = null; while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].addr <= pc) { r = lines[mid]; lo = mid + 1; } else hi = mid - 1; } return r ? r.line : 0; };
  const rtNames = Object.entries(R.rt.symbols).filter(([k]) => /^RT_[A-Z0-9_]+$/.test(k) && !['RT_ARGS', 'RT_BASE', 'RT_END', 'RT_ENTRY', 'RT_SEED', 'RT_SEED_INIT', 'RT_VIDEO'].includes(k)).map(([k, a]) => [a, k]);
  const rtAt = new Map(rtNames);
  const fe = res.map.entries.frame;
  const out = [];
  let inIsr = false, isrT0 = 0, isrAcc = 0, w0 = null, l0 = null, entries = 0, curRt = null, curLine = 0, lastT = 0;
  let lineT = null, rtT = null, lineG = null;
  const fixed = { window_repaint: S.window_repaint, win_draw_all: S.win_draw_all, ring_repair: S.ring_repair, redraw_dirty: S.redraw_dirty };
  const sub = Object.fromEntries(Object.keys(fixed).map((k) => [k, { open: null, t: 0 }]));
  const nframes = Math.ceil((ticks + 2) * 3 * 1.6) + 20;
  for (let f = 0; f < nframes && out.length < ticks; f++) {
    const end = m.frameStart + FRAME_T;
    while (m.tstates < end) {
      const cpu = m.cpu, pc = cpu.pc;
      const isr = (pc >= S.ISR && pc < S.ISR_END) || (pc >= S.SND_S && pc < S.SND_E) || (inIsr && pc >= S.SND_XS && pc < S.SND_E);   // (the tick calls SND_SYNC / SND_OWNCLR below SND_S: music)
      if (isr && !inIsr) { inIsr = true; isrT0 = m.tstates - 13; } else if (!isr && inIsr) { inIsr = false; isrAcc += m.tstates - isrT0; }
      if (!inIsr) {
        if (pc === S.WORK_START) { w0 = { t0: m.tstates, i0: isrAcc }; for (const k of Object.keys(sub)) sub[k].t = 0; }
        if (pc === fe && w0) {
          entries++;
          const sv = stick(entries);
          m.joystick[0] = contact(typeof sv === 'number' ? sv : sv[1] | 0); m.joystick[1] = 0;
          l0 = { t0: m.tstates, i0: isrAcc }; lineT = new Map(); rtT = new Map(); lineG = new Map(); curRt = null; lastT = m.tstates;
        }
        if (l0 && pc === S.AFTER_FRAME) { l0.t = m.tstates - l0.t0; l0.tx = l0.t - (isrAcc - l0.i0); l0.lineT = lineT; l0.lineG = lineG; l0.rtT = rtT; l0.done = true; lineT = null; }
        if (w0) {
          for (const [k, a] of Object.entries(fixed)) {
            const s = sub[k];
            if (pc === a && !s.open) s.open = { t0: m.tstates, sp: cpu.sp, ret: rd16(cpu.sp), i0: isrAcc };
            else if (s.open && pc === s.open.ret && cpu.sp === s.open.sp + 2) { s.t += m.tstates - s.open.t0 - (isrAcc - s.open.i0); s.open = null; }
          }
        }
        if (pc === S.WORK_END && w0) {
          const rec = { n: entries, parts: Object.fromEntries(Object.entries(sub).map(([k, v]) => [k, v.t])), t: m.tstates - w0.t0, tx: m.tstates - w0.t0 - (isrAcc - w0.i0), logic: l0?.done ? { t: l0.t, tx: l0.tx, lines: l0.lineT, lineG: l0.lineG, rt: l0.rtT } : null };
          out.push(rec); w0 = null; l0 = null;
        }
        // attribution inside PROC FRAME
        if (lineT) {
          const dt = 0; void dt;
          if (rtAt.has(pc)) curRt = rtAt.get(pc);
          if (pc >= 0x8000 && pc < 0xC000) { curRt = null; curLine = lineOf(pc); }
        }
      }
      if (cpu.halted) break;
      const t0 = m.tstates;
      Z_.runZ80(cpu, m.bus, 1, m);
      if (lineT && !inIsr) {
        const dt = m.tstates - t0;
        lineT.set(curLine, (lineT.get(curLine) ?? 0) + dt);
        if (!curRt) lineG.set(curLine, (lineG.get(curLine) ?? 0) + dt);
        const key = curRt ?? 'game'; rtT.set(key, (rtT.get(key) ?? 0) + dt);
      }
    }
    M_.runFrame(m);
  }
  return { ticks: out, res };
}

const pct = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
export function summarise(ticks, key = 't') {
  const v = ticks.map((x) => x[key]).sort((a, b) => a - b);
  return { median: pct(v, 0.5), p95: pct(v, 0.95), worst: v[v.length - 1], over: ticks.filter((x) => x.t > BUDGET).length, n: v.length };
}
const fmt = (v) => Math.round(v).toLocaleString('en-US');

const fixed0 = { window_repaint: 0, win_draw_all: 0, ring_repair: 0, redraw_dirty: 0 };
export const RUNS = [['win twice', TWICE_STICK, TWICE_LENGTH], ['game over', OVER_STICK, OVER_LENGTH]];

if (MAIN) {
  const spikes = process.argv.includes('--spikes') ? Number(process.argv[process.argv.indexOf('--spikes') + 1]) : 0;
  let bad = 0;
  for (const [name, stick, n] of RUNS) {
    const { ticks } = profile(PLATFORMER_SRC, { ticks: n, stick });
    const whole = summarise(ticks, 't'), wholeX = summarise(ticks, 'tx');
    const lg = ticks.filter((x) => x.logic).map((x) => ({ t: x.logic.t, tx: x.logic.tx }));
    const logic = summarise(lg.map((x) => ({ ...x })), 't');
    console.log(`${name}: ${whole.n} ticks. Whole tick (interrupt time included): median ${fmt(whole.median)}, 95th ${fmt(whole.p95)}, worst ${fmt(whole.worst)}, ${whole.over} over ${fmt(BUDGET)} (without the interrupt: worst ${fmt(wholeX.worst)}, ${ticks.filter((x) => x.tx > BUDGET).length} over)`);
    console.log(`        PROC FRAME (the game's logic, runtime calls included): median ${fmt(logic.median)}, 95th ${fmt(logic.p95)}, worst ${fmt(logic.worst)}, mean ${fmt(lg.reduce((s, x) => s + x.t, 0) / lg.length)}`);
    bad += whole.over;
    const mean = (f) => ticks.reduce((a, x) => a + f(x), 0) / ticks.length;
    console.log(`        mean per tick (no interrupt time): ${Object.keys(fixed0).map((k) => `${k} ${fmt(mean((x) => x.parts[k]))}`).join(', ')}; PROC FRAME ${fmt(mean((x) => x.logic?.tx ?? 0))}`);
    {
      const hot = new Map();
      const which = process.env.HOTG ? 'lineG' : 'lines';
      for (const x of ticks) if (x.logic) for (const [l, t] of x.logic[which]) hot.set(l, (hot.get(l) ?? 0) + t);
      const srcLines = PLATFORMER_SRC.split('\n');
      const top = [...hot].sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.HOT ?? 0));
      for (const [l, t] of top) console.log(`        hot line ${l}: ${fmt(t / ticks.length)} T/tick: ${srcLines[l - 1]?.trim().slice(0, 80)}`);
    }
    if (spikes) {
      const top = ticks.filter((x) => x.logic).sort((a, b) => b.logic.t - a.logic.t).slice(0, spikes);
      for (const x of top) {
        const lines = [...x.logic.lines].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, t]) => `line ${l}: ${fmt(t)}`).join(', ');
        const rts = [...x.logic.rt].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, t]) => `${k} ${fmt(t)}`).join(', ');
        console.log(`   tick ${x.n}: whole ${fmt(x.t)}, logic ${fmt(x.logic.t)}  | ${lines}  | ${rts}`);
      }
    }
  }
  if (process.argv.includes('--check')) process.exit(bad === 0 ? 0 : 1);
}
