#!/usr/bin/env node
"use strict";
// arcade-m8-vaults-perf.mjs -- per-tick cost of arcade/examples/vaults.arc on the REAL runtime v4 (arcade/build/v4), TSRun, real frame interrupt, no contention.
//   node tests/arcade-m8-vaults-perf.mjs               the two recorded runs (win, lose): distribution of the whole tick and of PROC FRAME, ticks over the budget
//   node tests/arcade-m8-vaults-perf.mjs --sweep       ... and a SWEEP: the same maze and all 16 billboards at their posts, the viewer on every empty cell at 8 angles
//                                                       (one pose a tick): the worst picture of this maze with 4-pixel columns
//   node tests/arcade-m8-vaults-perf.mjs --spikes N    ... and the N costliest ticks of PROC FRAME broken down by source line and runtime routine
//   node tests/arcade-m8-vaults-perf.mjs --check       exit 1 when a tick of the recorded runs or of the sweep goes over the budget
//
// How a tick is measured (as arcade/tests/m7-runtime-perf.mjs and tests/arcade-m6-platformer-perf.mjs): the instruction stream is single-stepped. A tick is WORK_START..WORK_END of the
// runtime's main loop (in ray mode the picture is part of it: ray_tick jumps back to TICK_COUNT); its cost is given with the interrupt handler's time ("t", what decides whether
// the tick is late) and without it ("tx"). The game's logic is PROC FRAME: entered at the game's frame entry, left when the runtime reaches AFTER_FRAME. Inside the logic every
// instruction's time goes to the source line of the last game instruction (a runtime routine called from a line is charged to that line) and to the runtime routine running.
// The picture is ray_render (cast and walls, then the billboards: ray_bb), the cell-map repaint of the HUD is redraw_dirty.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile } from '../src/lang/arcade/arcade-compile.js';
import { VAULTS_SRC, VAULTS_ASSETS } from './arcade-m8-vaults-harness.mjs';
import { WIN_RUNS, LOSE_RUNS } from './arcade-m8-vaults-script.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const M_ = await import(pathToFileURL(join(ROOT, 'tsrun/machine.js')).href);
const Z_ = await import(pathToFileURL(join(ROOT, 'tsrun/z80.js')).href);
export const FRAME_T = M_.tStatesPerFrame;
export const BUDGET = 4 * FRAME_T;
const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
export const runsToStick = (runs) => { const a = []; for (const [v, n] of runs) for (let i = 0; i < n; i++) a.push(v); return (t) => a[t - 1] ?? 0; };

export function loadRuntime(dir = 'arcade/build/v4') {
  const json = join(ROOT, dir, 'runtime.json');
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))) };
}

/** Run `ticks` ticks of the compiled game with `stick(k)` and return one record per tick. */
export function profile(src, { ticks, stick, assets = VAULTS_ASSETS, runtimeDir, compile: compileFn = compile } = {}) {      // compileFn: another compiler (tests/arcade-codegen-perf.mjs --old)
  const R = loadRuntime(runtimeDir);
  const res = compileFn(src, { runtime: R.rt, image: R.img, assets });
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
  const lines = res.map.lines.slice().sort((a, b) => a.addr - b.addr);
  const lineOf = (pc) => { let lo = 0, hi = lines.length - 1, r = null; while (lo <= hi) { const mid = (lo + hi) >> 1; if (lines[mid].addr <= pc) { r = lines[mid]; lo = mid + 1; } else hi = mid - 1; } return r ? r.line : 0; };
  const rtNames = Object.entries(R.rt.symbols).filter(([k]) => /^RT_[A-Z0-9_]+$/.test(k) && !['RT_ARGS', 'RT_BASE', 'RT_END', 'RT_ENTRY', 'RT_SEED', 'RT_SEED_INIT', 'RT_VIDEO'].includes(k)).map(([k, a]) => [a, k]);
  const rtAt = new Map(rtNames);
  const fe = res.map.entries.frame;
  const out = [];
  let inIsr = false, isrT0 = 0, isrAcc = 0, w0 = null, l0 = null, entries = 0, curRt = null, curLine = 0;
  let lineT = null, rtT = null;
  const fixed = { ray_render: S.ray_render, ray_bb: S.ray_bb, ray_cast: S.ray_cast, redraw_dirty: S.redraw_dirty };
  const sub = Object.fromEntries(Object.keys(fixed).map((k) => [k, { open: null, t: 0 }]));
  const nframes = Math.ceil((ticks + 2) * 4 * 1.6) + 40;
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
          m.joystick[0] = contact(sv); m.joystick[1] = contact(0);
          l0 = { t0: m.tstates, i0: isrAcc }; lineT = new Map(); rtT = new Map(); curRt = null;
        }
        if (l0 && pc === S.AFTER_FRAME) { l0.t = m.tstates - l0.t0; l0.tx = l0.t - (isrAcc - l0.i0); l0.lineT = lineT; l0.rtT = rtT; l0.done = true; lineT = null; }
        if (w0) {
          for (const [k, a] of Object.entries(fixed)) {
            const s = sub[k];
            if (pc === a && !s.open) s.open = { t0: m.tstates, sp: cpu.sp, ret: rd16(cpu.sp), i0: isrAcc };
            else if (s.open && pc === s.open.ret && cpu.sp === s.open.sp + 2) { s.t += m.tstates - s.open.t0 - (isrAcc - s.open.i0); s.open = null; }
          }
        }
        if (pc === S.WORK_END && w0) {
          out.push({ n: entries, parts: Object.fromEntries(Object.entries(sub).map(([k, v]) => [k, v.t])), t: m.tstates - w0.t0, tx: m.tstates - w0.t0 - (isrAcc - w0.i0), logic: l0?.done ? { t: l0.t, tx: l0.tx, lines: l0.lineT, rt: l0.rtT } : null });
          w0 = null; l0 = null;
        }
        if (lineT) {
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

/** The sweep program: the header, assets and game-level declarations of vaults.arc (everything before its first scene), a scene that shows every instance at its post and moves the viewer one pose a tick over every empty cell and 8 angles. */
export function sweepSource(billboards = true) {
  const head = VAULTS_SRC.slice(0, VAULTS_SRC.indexOf('\nSCENE ') + 1);        // everything before the first scene: the game-level declarations (the post arrays among them), the assets, the shared PROCs
  return head + `SCENE sweep
  DIM n, x, y, a, i
  PROC INIT()
${billboards ? `    FOR i = 0 TO 4
      SHOW wr(i) AT exs(i), eys(i) FRAME BAND(i, 1)
      SHOW gem(i) AT gxs(i), gys(i)
    NEXT i
    FOR i = 0 TO 2
      SHOW pot(i) AT pxs(i), pys(i)
    NEXT i
    SHOW kk AT KX, KY
    SHOW tr AT TX, TY
` : ''}    n = 0
  ENDP
  PROC FRAME()
    LOCAL ok
    ok = 0
    WHILE ok = 0
      x = (BAND(SHR(n, 3), 31)) * 256 + 128
      y = SHR(n, 8) * 256 + 128
      IF y > 7936 THEN n = 0 : x = 128 : y = 128 ENDIF
      IF WALL(x, y) = 0 THEN ok = 1 ELSE n = n + 8 ENDIF
    WEND
    a = BAND(n, 7) * 32 + 5
    VIEW x, y, a
    n = n + 1
  ENDP
ENDSCENE
`;
}

export const RUNS = [['win run', WIN_RUNS], ['lose run', LOSE_RUNS]];

if (MAIN) {
  const spikes = process.argv.includes('--spikes') ? Number(process.argv[process.argv.indexOf('--spikes') + 1]) : 0;
  let bad = 0;
  const mean = (ticks, f) => ticks.reduce((a, x) => a + f(x), 0) / ticks.length;
  for (const [name, runs] of RUNS) {
    const n = runs.reduce((a, [, k]) => a + k, 0);
    const { ticks: every } = profile(VAULTS_SRC, { ticks: n, stick: runsToStick(runs) });
    // the first ticks paint the boot HUD map (all 576 cells outside the window, twice, once into each display file): the runtime's own cost, not the game's
    const boot = every.slice(0, 3), ticks = every.slice(3);
    const whole = summarise(ticks, 't'), wholeX = summarise(ticks, 'tx');
    const lg = ticks.filter((x) => x.logic).map((x) => ({ t: x.logic.t, tx: x.logic.tx }));
    const logic = summarise(lg, 't');
    console.log(`${name}: ${every.length} ticks (the first 3, with the boot HUD paint, cost ${boot.map((x) => fmt(x.t)).join(' / ')}). The other ${whole.n}: whole tick (interrupt time included): median ${fmt(whole.median)}, 95th ${fmt(whole.p95)}, worst ${fmt(whole.worst)}, ${whole.over} over ${fmt(BUDGET)} = ${(100 * whole.over / whole.n).toFixed(2)} % (without the interrupt: worst ${fmt(wholeX.worst)})`);
    console.log(`        PROC FRAME (the game's logic, runtime calls included): median ${fmt(logic.median)}, 95th ${fmt(logic.p95)}, worst ${fmt(logic.worst)}, mean ${fmt(lg.reduce((s, x) => s + x.t, 0) / lg.length)}`);
    console.log(`        mean per tick (no interrupt time): ${Object.keys(ticks[0].parts).map((k) => `${k} ${fmt(mean(ticks, (x) => x.parts[k]))}`).join(', ')}; PROC FRAME ${fmt(mean(ticks, (x) => x.logic?.tx ?? 0))}`);
    console.log(`        worst picture: ray_render ${fmt(Math.max(...ticks.map((x) => x.parts.ray_render)))} (billboards ${fmt(Math.max(...ticks.map((x) => x.parts.ray_bb)))}), redraw_dirty ${fmt(Math.max(...ticks.map((x) => x.parts.redraw_dirty)))}`);
    const overList = ticks.filter((x) => x.t > BUDGET);
    if (overList.length) console.log(`        over the budget: ticks ${overList.map((x) => x.n).join(', ')} (${overList.map((x) => (x.t / FRAME_T).toFixed(2)).join(', ')} refreshes: a tick that overruns takes the next refresh boundary, 5 instead of 4)`);
    bad += whole.over;
    if (spikes) {
      const top = ticks.filter((x) => x.logic).sort((a, b) => b.logic.t - a.logic.t).slice(0, spikes);
      for (const x of top) {
        const lines = [...x.logic.lines].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([l, t]) => `line ${l}: ${fmt(t)}`).join(', ');
        const rts = [...x.logic.rt].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, t]) => `${k} ${fmt(t)}`).join(', ');
        console.log(`   tick ${x.n}: whole ${fmt(x.t)}, logic ${fmt(x.logic.t)}  | ${lines}  | ${rts}`);
      }
    }
  }
  if (process.argv.includes('--sweep')) {
    const quick = process.env.ARCADE_QUICK ? 6 : 1;
    for (const [label, bb] of [['walls only (no billboards)', false], ['all 16 billboards at their posts (what the game never shows: it hides what is farther than 7 cells)', true]]) {
      const { ticks: all } = profile(sweepSource(bb), { ticks: Math.floor(5600 / quick), stick: () => 0 });
      const ticks = all.slice(3);
      const w = summarise(ticks, 't');
      console.log(`sweep, ${label}: ${ticks.length} poses (every empty cell, 8 angles). Whole tick: median ${fmt(w.median)}, 95th ${fmt(w.p95)}, worst ${fmt(w.worst)}, ${w.over} over ${fmt(BUDGET)}; ray_render worst ${fmt(Math.max(...ticks.map((x) => x.parts.ray_render)))} (cast ${fmt(Math.max(...ticks.map((x) => x.parts.ray_cast)))}, billboards ${fmt(Math.max(...ticks.map((x) => x.parts.ray_bb)))}); the sweep's own PROC FRAME ${fmt(mean(ticks, (x) => x.logic?.tx ?? 0))} on average`);
      if (!bb) bad += w.over;
    }
  }
  if (process.argv.includes('--check')) process.exit(bad === 0 ? 0 : 1);
}
