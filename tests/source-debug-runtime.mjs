#!/usr/bin/env node
"use strict";
// source-debug-runtime.mjs -- the source debugger (src/tools/source-debug.js, stage 6 item R4) on real games: Breakout, Starfall and Leap Runner, built by compile() against the real runtimes
// (arcade/build/v2, v3) and run on a stock TS2068 in TSRun, one instruction at a time where a watch is set.
//
//   node tests/source-debug-runtime.mjs          (SOURCE_DEBUG_QUICK=1: fewer ticks, 12 lines per game)
//
// The driver below is what src/emulator.js does for a pause (runWatched / stepOneInstruction / the skipWatch of resume), built here with runZ80 and runFrame so the test needs nothing
// from the emulator: before each instruction the watch is asked (true = pause, nothing executed); resume lets that one instruction run unwatched; a frame's end is finished by runFrame
// (which takes the frame interrupt).  The joystick and the frame meter are the Studio's concern, not this test's: the input is a fixed script of the frame number.
//
//   1  the build: three games compile; every line has its entries; lineOf() and the codeEnd
//   2  breakpoints on 40 lines of each game (evenly sampled from the lines that have an entry): pause with pc = the line's first address and lineOf(pc).line = the (snapped) line; a line
//      that never runs in the first 600 ticks is "not reached" (>= 20 per game must be reached); the single pass that finds them and the one-line-at-a-time runs agree to the frame
//   3  NON-PERTURBATION: 200 ticks undisturbed against 200 ticks with 5 pauses at breakpoints (continued) and 3 stepLine calls (into, over, into): RAM (all 64 KB, both screens included),
//      the AY registers, the CPU and the clock are identical
//   4  stepLine against a reference stepper (a plain loop on a second machine with the same history): the same pc, the same instruction count, the same machine
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { bootedMachine } from '../arcade/tests/fast-boot.mjs';
import { real, realInk, compileReal, ROOT, M_ } from './arcade-m5-harness.mjs';
import { requiredRuntime } from '../src/lang/arcade/arcade-compile.js';
import { completeSource } from '../src/arcade-objects.js';
import * as S from '../src/tools/source-debug.js';

const { runZ80 } = await import(pathToFileURL(join(ROOT, 'tsrun/z80.js')).href);
const QUICK = !!process.env.SOURCE_DEBUG_QUICK;
const T = M_.tStatesPerFrame;

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  cond ? passed++ : failed++;
  return cond;
};
const info = (s) => console.log('  INFO  ' + s);
const hex = (v, w = 4) => '$' + (v >>> 0).toString(16).toUpperCase().padStart(w, '0');

// ---- the games ----------------------------------------------------------------------------------------------------
const EX = join(ROOT, 'arcade/examples');
const readText = (f) => readFileSync(join(EX, f), 'utf8');
const GAMES = [
  { name: 'Breakout', arc: 'breakout.arc', assets: 'breakout.assets.json' },
  { name: 'Starfall', arc: 'shooter.arc', assets: 'shooter.assets.json' },
  { name: 'Leap Runner', arc: 'runner.arc', assets: 'runner.assets.json' },
];
const TICKS_FIND = QUICK ? 150 : 600;           // how long a breakpoint may wait
const TICKS_RUN = QUICK ? 80 : 200;             // the non-perturbation run
const LINES = QUICK ? 12 : 40;

console.log('1. The build');
for (const g of GAMES) {
  const assets = JSON.parse(readText(g.assets));
  const text = completeSource(readText(g.arc), assets).text;      // (the objects of a game with a map are put in front, as the Studio's project does: the map's lines are lines of this text)
  const need = requiredRuntime(text, assets, assets.scenes), version = need.version;
  const R = need.ink ? realInk() : real(version);      // Breakout turns sprite colour on (stage 6B): the ink variant of v2
  if (!R.ok) { console.log(`  SKIP  ${g.name} (${R.why})`); process.exit(0); }
  let res;
  try { res = compileReal(text, assets, { R }); } catch (e) { check(`${g.name} compiles for runtime v${version}${need.ink ? ' (ink)' : ''}`, false, e.message); process.exit(1); }
  res.map.codeEnd = res.gen.base + res.gen.code.length;      // what the Studio sets (lineOf's end of the code)
  Object.assign(g, { res, map: res.map, R, SYM: R.SYM, version });
  const ents = res.map.lines;
  const lines = [...new Set(ents.map((e) => e.line))].sort((a, b) => a - b);
  g.lines = lines;
  check(`${g.name} compiles for runtime v${version}: ${ents.length} entries on ${lines.length} lines, code $${res.gen.base.toString(16)}-$${(res.map.codeEnd - 1).toString(16)}`, ents.length > 50 && lines.length > 30 && ents.every((e, i) => i === 0 || ents[i - 1].addr < e.addr));
  check(`${g.name}: lineOf names every entry and nothing outside the code`, ents.every((e) => S.lineOf(res.map, e.addr)?.line === e.line) && S.lineOf(res.map, res.map.codeEnd) === null && S.lineOf(res.map, ents[0].addr - 1) === null);
}

// ---- the machine and its driver -------------------------------------------------------------------------------
const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
/** The input of frame f: fire pulses (start, restart, shoot), the stick sweeps right and left, up and down now and then.  Bits as the joystick: 1 up, 2 down, 4 left, 8 right, 16 fire. */
const stickAt = (f) => ((f % 120) < 8 ? 16 : 0) | (((f >> 6) & 1) ? 8 : 4) | ((f % 50) < 6 ? 1 : 0) | ((f % 97) < 4 ? 2 : 0);

function newRun(g) {
  const m = bootedMachine(g.res.dck);
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  for (let f = 0; f < 400 && rd16(g.SYM.HO_MARK) !== g.SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(g.SYM.HO_MARK) !== g.SYM.HO_MARK_VALUE) throw new Error(`${g.name}: the runtime did not boot`);
  const ctx = { g, m, base: m.frameStart, frames: 0, skip: false, rd16, ticks: () => rd16(g.SYM.V_TICKS) };
  applyInput(ctx);
  return ctx;
}
/** The input for the frame the machine is in (idempotent). */
function applyInput(ctx) {
  const m = ctx.m;
  for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F;
  m.joystick[0] = contact(stickAt(Math.round((m.frameStart - ctx.base) / T)));
  m.joystick[1] = contact(0);
}
/** The rest of the current frame, instruction by instruction while a watch is set (src/emulator.js runWatched + stepMachine).  'paused' (before an instruction, nothing run) or 'frame' (finished). */
function advance(ctx, watch) {
  const m = ctx.m, cpu = m.cpu;
  const end = m.frameStart + T;
  applyInput(ctx);
  if (!watch) runZ80(cpu, m.bus, end - m.tstates, m);          // (what runFrame does first)
  else {
    while (m.tstates < end) {
      if (cpu.halted || cpu.nmiPending) break;      // left to runFrame, as the emulator does
      if (!ctx.skip && watch(m)) return 'paused';
      ctx.skip = false;
      runZ80(cpu, m.bus, 1, m);
    }
  }
  M_.runFrame(m);
  M_.takeAudio(m);
  ctx.frames++;
  return 'frame';
}
/** What src/emulator.js stepOneInstruction does at a frame's end while paused. */
const onFrameEnd = (ctx) => (m) => { M_.runFrame(m); M_.takeAudio(m); ctx.frames++; applyInput(ctx); };
const stepOpts = (ctx, extra = {}) => ({ step: S.instructionStepper(runZ80), onFrameEnd: onFrameEnd(ctx), ...extra });

/**
 * Run until `done(ctx)` after a frame, a `plan.watch(ctx)` (a function or null) deciding the watch of each advance and `plan.onPause(ctx)` handling a pause (it must leave ctx.skip = true).
 */
function drive(ctx, { watch = () => null, onPause = null, done, maxFrames = 20000 }) {
  while (ctx.frames < maxFrames) {
    const r = advance(ctx, watch(ctx));
    if (r === 'paused') { if (!onPause || onPause(ctx) === 'stop') return 'paused'; ctx.skip = true; continue; }
    if (done(ctx)) return 'done';
  }
  return 'maxFrames';
}

// ---- 2. a breakpoint on 40 lines ------------------------------------------------------------------------------
console.log('\n2. Breakpoints on source lines');
for (const g of GAMES) {
  const lines = g.lines;
  const pick = [];
  for (let i = 0; i < LINES; i++) pick.push(lines[Math.floor(i * (lines.length - 1) / (LINES - 1))]);
  const sample = [...new Set(pick)];
  // a few blank / comment lines between them, to see the snapping on the real map as well
  const gaps = []; for (let l = 1; l < lines.at(-1) && gaps.length < 6; l++) if (!lines.includes(l) && l > lines[3]) gaps.push(l);
  const { addrs, resolved, hollow } = S.breakpointAddresses(g.map, sample);
  check(`${g.name}: ${sample.length} lines sampled, every one has code (no snapping, none hollow), ${addrs.size} addresses`, resolved.size === sample.length && hollow.length === 0 && [...resolved].every(([l, r]) => r.line === l) && addrs.size === sample.length);
  const gapR = S.breakpointAddresses(g.map, gaps);
  check(`${g.name}: ${gaps.length} lines with no code snap to the next line that has some (${gaps.map((l) => `${l}->${gapR.resolved.get(l)?.line}`).join(' ')})`, gaps.every((l) => { const r = gapR.resolved.get(l); return r && r.line > l && lines.includes(r.line) && !lines.some((x) => x >= l && x < r.line); }));

  // pass 1: every sampled address at once; a hit is noted and the address dropped, the run goes on (a pause changes nothing: section 3)
  const hit = new Map();        // addr -> {frame, tick, pc}
  const open = new Set(addrs);
  const ctx = newRun(g);
  const watch = S.watchFor(open);
  drive(ctx, {
    watch: () => (open.size ? watch : null),
    onPause: (c) => { const pc = c.m.cpu.pc; hit.set(pc, { frame: c.frames, tick: c.ticks(), pc }); open.delete(pc); },
    done: (c) => c.ticks() >= TICKS_FIND,
  });
  const reached = sample.filter((l) => hit.has(resolved.get(l).addr));
  info(`${g.name}: ${reached.length} of ${sample.length} lines reached in the first ${TICKS_FIND} ticks (${ctx.frames} frames); not reached: ${sample.filter((l) => !hit.has(resolved.get(l).addr)).join(' ') || 'none'}`);
  check(`${g.name}: at least 20 of the sampled lines run in ${TICKS_FIND} ticks`, QUICK ? reached.length >= 6 : reached.length >= 20, `${reached.length}`);

  // pass 2: one line at a time, a fresh machine each, to the frame pass 1 saw it
  let bad = [];
  for (const l of reached) {
    const want = resolved.get(l), h = hit.get(want.addr);
    const c = newRun(g);
    const w = S.watchFor(new Set([want.addr]));
    const r = drive(c, { watch: () => w, done: (cc) => cc.ticks() >= TICKS_FIND, maxFrames: h.frame + 2 });
    const pc = c.m.cpu.pc, src = S.lineOf(g.map, pc);
    if (r !== 'paused' || pc !== want.addr || src?.line !== want.line || src.addr !== want.addr || c.frames !== h.frame || c.ticks() !== h.tick) bad.push(`line ${l}: ${r} pc ${hex(pc)} line ${src?.line} frame ${c.frames}/${h.frame}`);
  }
  check(`${g.name}: a breakpoint alone on each of ${reached.length} reached lines pauses at the line's first address, lineOf(pc).line is the line, in the frame the one-pass run saw`, bad.length === 0, bad.slice(0, 3).join(' | '));
  // the lines that never ran: a few alone, to see that nothing pauses
  const never = sample.filter((l) => !hit.has(resolved.get(l).addr)).slice(0, 3);
  let paused = 0;
  for (const l of never) {
    const c = newRun(g);
    const w = S.watchFor(new Set([resolved.get(l).addr]));
    if (drive(c, { watch: () => w, done: (cc) => cc.ticks() >= TICKS_FIND }) === 'paused') paused++;
  }
  check(`${g.name}: ${never.length} of the lines that never ran, set alone, do not pause (${TICKS_FIND} ticks)`, paused === 0);
}

// ---- 3. non-perturbation --------------------------------------------------------------------------------------
console.log('\n3. Non-perturbation: pausing, continuing and stepping do not change the game');
const SCREEN = [[0x4000, 0x5AFF], [0x6000, 0x7AFF]];
function stateOf(ctx) {
  const m = ctx.m;
  return { ram: Uint8Array.from(m.ram), ay: Array.from(m.ay.regs), latch: m.ayLatch, cpu: JSON.stringify(m.cpu), tstates: m.tstates, frameStart: m.frameStart, frames: ctx.frames, ticks: ctx.ticks(), ports: [m.portF4, m.portFF, m.ulaOut] };
}
function diffStates(a, b) {
  const out = [];
  if (a.frames !== b.frames) out.push(`frames ${a.frames} / ${b.frames}`);
  if (a.ticks !== b.ticks) out.push(`ticks ${a.ticks} / ${b.ticks}`);
  if (a.cpu !== b.cpu) out.push(`cpu ${a.cpu} / ${b.cpu}`);
  if (a.tstates !== b.tstates || a.frameStart !== b.frameStart) out.push(`clock ${a.tstates}/${a.frameStart} / ${b.tstates}/${b.frameStart}`);
  if (JSON.stringify(a.ay) !== JSON.stringify(b.ay) || a.latch !== b.latch) out.push(`AY ${a.ay} / ${b.ay}`);
  if (JSON.stringify(a.ports) !== JSON.stringify(b.ports)) out.push(`ports ${a.ports} / ${b.ports}`);
  let n = 0, first = -1;
  for (let i = 0; i < a.ram.length; i++) if (a.ram[i] !== b.ram[i]) { n++; if (first < 0) first = i; }
  if (n) out.push(`${n} RAM bytes differ, first at ${hex(first)}`);
  return out;
}
for (const g of GAMES) {
  const allAddrs = S.breakpointAddresses(g.map, g.lines).addrs;
  // undisturbed: no watch at all
  const a = newRun(g);
  const ra = drive(a, { done: (c) => c.ticks() >= TICKS_RUN });
  const A = stateOf(a);
  // disturbed: from frame 30 on, every 25th frame arms the watch (every statement is a breakpoint) until it pauses; five pauses, the first three followed by a Step line (into, over, into)
  const b = newRun(g);
  const live = new Set(allAddrs);      // the set the watch holds: an address already paused at is taken out, so the five pauses are at five places (a spin loop would take all five)
  const watch = S.watchFor(live);
  let pauses = 0;
  const steps = [], seenPcs = [];
  const rb = drive(b, {
    watch: (c) => (pauses < 5 && c.frames >= 30 + 25 * pauses ? watch : null),
    onPause: (c) => {
      pauses++;
      seenPcs.push(c.m.cpu.pc);
      live.delete(c.m.cpu.pc);
      if (pauses <= 3) {
        const r = S.stepLine(c.m, g.map, stepOpts(c, { over: pauses === 2, breakpoints: pauses === 2 ? allAddrs : null }));
        steps.push(r);
      }
    },
    done: (c) => c.ticks() >= TICKS_RUN,
  });
  const B = stateOf(b);
  info(`${g.name}: ${pauses} pauses at ${seenPcs.map((p) => hex(p)).join(' ')}; step lines: ${steps.map((s) => `${s.stopped} ${hex(s.pc)} line ${s.line} (${s.instructions})`).join('; ')}`);
  check(`${g.name}: the undisturbed run reaches tick ${TICKS_RUN} in ${A.frames} frames`, ra === 'done' && A.ticks >= TICKS_RUN);
  check(`${g.name}: 5 pauses at breakpoints (5 different addresses) and 3 Step lines happened, all pausing on a statement with a source line`, pauses === 5 && new Set(seenPcs).size === 5 && steps.length === 3 && seenPcs.every((p) => allAddrs.has(p) && S.lineOf(g.map, p) !== null) && steps.every((s) => s.stopped !== 'limit' && s.instructions > 0));
  const d = diffStates(A, B);
  check(`${g.name}: at tick ${TICKS_RUN} RAM (all 64 KB, both screens), the AY registers, the CPU, the clock and the ports are identical`, rb === 'done' && d.length === 0, d.join(' | '));
  const scr = SCREEN.every(([lo, hi]) => A.ram.subarray(lo, hi + 1).every((v, i) => v === B.ram[lo + i]));
  check(`${g.name}: the screen bytes ($4000-$5AFF, $6000-$7AFF) are equal on their own`, scr);
}

// ---- 4. stepLine against a reference stepper ------------------------------------------------------------------
console.log('\n4. Step line against a plain reference loop');
/** A stepper that knows nothing of the module: one instruction at a time to the next entry of another line (into) or, over, the call's return. */
function referenceStep(ctx, map, over) {
  const m = ctx.m, cpu = m.cpu;
  const entries = new Map(map.lines.map((e) => [e.addr, e.line]));
  const own = S.lineOf(map, cpu.pc);
  const startLine = own ? own.line : null;
  let n = 0, back = false;
  const frameEnd = () => { M_.runFrame(m); M_.takeAudio(m); ctx.frames++; applyInput(ctx); };
  const one = () => {      // one instruction, or the frame's end for a halted CPU
    if (cpu.halted) frameEnd(); else { runZ80(cpu, m.bus, 1, m); if (m.tstates >= m.frameStart + T) frameEnd(); }
    n++;
  };
  for (;;) {
    const op = m.bus.read(cpu.pc), pc0 = cpu.pc, sp0 = cpu.sp;
    const isCall3 = op === 0xCD || (op & 0xC7) === 0xC4, isRst = (op & 0xC7) === 0xC7;
    const isJump = op === 0x18 || (op & 0xE7) === 0x20 || op === 0x10 || op === 0xC3 || (op & 0xC7) === 0xC2 || op === 0xE9;
    const fromGame = S.lineOf(map, pc0) !== null;      // (a call made from runtime code is never stepped over: the tick loop's call of PROC FRAME is where the next statement is)
    const retPc = over && fromGame && isCall3 ? pc0 + 3 : over && fromGame && isRst ? pc0 + 1 : -1;
    one();
    if (retPc >= 0) {
      while (!(cpu.pc === retPc && cpu.sp === sp0)) { one(); if (n >= 200000) return { stopped: 'limit', n }; }
    } else if (isJump && cpu.pc < pc0 && cpu.sp === sp0) back = true;
    if (entries.has(cpu.pc) && (entries.get(cpu.pc) !== startLine || back)) return { stopped: 'line', n };
    if (n >= 200000) return { stopped: 'limit', n };
  }
}
for (const g of GAMES) {
  const allAddrs = S.breakpointAddresses(g.map, g.lines).addrs;
  const arriveDistinct = (nth) => {      // paused at the nth DIFFERENT statement reached after frame 30
    const c = newRun(g);
    const live = new Set(allAddrs), watch = S.watchFor(live);
    let k = 0;
    c.paused = drive(c, { watch: (cc) => (cc.frames >= 30 ? watch : null), onPause: (cc) => { live.delete(cc.m.cpu.pc); return ++k >= nth ? 'stop' : undefined; }, done: () => false }) === 'paused';
    return c;
  };
  const arrive = (nth) => {      // a machine paused at its nth breakpoint hit after frame 30 (the same history every time)
    const c = newRun(g);
    const watch = S.watchFor(allAddrs);
    let k = 0;
    c.paused = drive(c, { watch: (cc) => (cc.frames >= 30 ? watch : null), onPause: () => (++k >= nth ? 'stop' : undefined), done: () => false }) === 'paused';
    return c;
  };
  let tested = 0, bad = [], allPaused = true;
  for (const nth of QUICK ? [1, 40] : [1, 7, 40, 300, 1200, 4000]) {
    for (const over of [false, true]) {
      const x = arrive(nth), y = arrive(nth);
      allPaused = allPaused && x.paused && y.paused;
      const ref = referenceStep(y, g.map, over);
      const got = S.stepLine(x.m, g.map, stepOpts(x, { over }));
      tested++;
      const d = diffStates(stateOf(x), stateOf(y));
      if (ref.stopped !== got.stopped && !(ref.stopped === 'line' && got.stopped === 'line')) bad.push(`nth ${nth} over ${over}: ${ref.stopped} / ${got.stopped}`);
      else if (ref.n !== got.instructions) bad.push(`nth ${nth} over ${over}: ${ref.n} / ${got.instructions} instructions`);
      else if (d.length) bad.push(`nth ${nth} over ${over}: ${d[0]}`);
    }
  }
  check(`${g.name}: every one of those machines was paused at its breakpoint when stepping began`, allPaused);
  check(`${g.name}: ${tested} Step lines (into and over, at hits from the 1st to the late ones) end where a plain reference loop ends: same instruction count, same machine state`, bad.length === 0, bad.slice(0, 3).join(' | '));
  // the order of statements: from a pause, six Step overs; where the code runs straight on, each stop is the map's next entry (of another line) in address order.  The first start (of the first twelve
  // different statements reached) whose six steps hold at least 3 such stops is the sequence; a game's tick may be a single IF (Breakout's title), which loops to itself.
  {
    let best = null;
    for (let nth = 1; nth <= 12 && !(best && best.straight >= 3); nth++) {
      const x = arriveDistinct(nth);
      let straight = 0, trail = [];
      for (let k = 0; k < 6; k++) {
        const from = x.m.cpu.pc, fromLine = S.lineOf(g.map, from)?.line;
        if (fromLine === undefined) break;
        const next = g.map.lines.find((e) => e.addr > from && e.line !== fromLine);
        const r = S.stepLine(x.m, g.map, stepOpts(x, { over: true }));
        trail.push(`${hex(from)}>${hex(r.pc)}${r.stopped === 'line' ? '' : ' ' + r.stopped}`);
        if (r.stopped === 'line' && next && r.pc === next.addr) straight++;
      }
      if (!best || straight > best.straight) best = { straight, trail, nth };
    }
    check(`${g.name}: six Step overs from the different statement #${best.nth} reached: ${best.straight} go straight to the next statement of the source map (${best.trail.join(' ')})`, best.straight >= 3);
  }
  check(`${g.name}: an address in the runtime ($1000) has no source line`, S.lineOf(g.map, 0x1000) === null);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: source-debug-runtime (${passed} passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
