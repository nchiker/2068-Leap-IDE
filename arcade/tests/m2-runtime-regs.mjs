"use strict";
// m2-runtime-regs.mjs -- register / interrupt discipline of the v0 frame loop (the M2 counterpart of extra-regs.mjs):
//  1. A real IM 1 interrupt is injected at EVERY instruction boundary of the main loop from MAIN on (the wait spin, the
//     period check, erase_all, frame_entry of the test game with its RT_* calls, draw_all, the flip request).  The ISR runs
//     to its RET and every register (incl. alternates, IX, IY), SP, I, IM and IFF1 must equal what they were; the ISR's
//     writes to the variables and the port are undone so the injections have no other effect.
//  2. Chaos: 200 frames with an extra interrupt at random instruction boundaries (about one per 400 instructions), effects
//     KEPT.  The handshake must still hold: the displayed display file is never written, ticks stay in order, the sprite
//     state table stays equal to the game's calls, the stack stays inside its area, the canary is intact, and the machine
//     is still running at the end.
//   node arcade/tests/m2-runtime-regs.mjs
import * as C from './m2-runtime-common.mjs';
const { M, Z, hex, makeChecks, rd8, rd16, clamp } = C;

const { check, finish } = makeChecks();
const game = C.testGame({}, 'regs');
const S = game.syms;
console.log('M2 runtime register discipline: injected interrupts at every instruction of the frame loop\n');

const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl', 'sp', 'i', 'im', 'iff1'];
const snap = (cpu) => Object.fromEntries(KEYS.map((k) => [k, cpu[k]]));

function boot() {
  const m = C.newMachine(game.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  return m;
}

// ---- 1. inject at every instruction boundary ------------------------------------------------------------------------
{
  const m = boot();
  let started = false, injections = 0, noReturn = 0, violations = [];
  const pcs = new Set();
  const regions = new Set();
  function injectAndCheck(pc0) {
    const cpu = m.cpu;
    // Sentinels in every register the ISR might touch, so a register it clobbers with a constant shows up.
    const t0 = m.tstates;
    const before = snap(cpu), varsBefore = Array.from(m.ram.slice(S.VARS, S.VARS + 0x10)), ffBefore = m.portFF;
    KEYS.forEach((k, i) => { if (!['sp', 'i', 'im', 'iff1'].includes(k)) cpu[k] = (0x5A + 37 * i) & 0xFF; });
    const sent = snap(cpu);
    Z.irqZ80(cpu, m.bus);                       // the real interrupt: push PC, PC = $0038, IFF1 = 0
    let steps = 0;
    while (!(cpu.pc === pc0 && cpu.sp === before.sp) && steps < 500) { Z.runZ80(cpu, m.bus, 1, m); steps++; }
    if (steps >= 500) { noReturn++; return; }
    const after = snap(cpu);
    for (const k of KEYS) if (after[k] !== sent[k]) violations.push({ pc0, reg: k, before: sent[k], after: after[k] });
    for (const k of KEYS) cpu[k] = before[k];
    for (let i = 0; i < varsBefore.length; i++) m.ram[S.VARS + i] = varsBefore[i];   // undo the ISR's variable writes
    m.portFF = ffBefore;                                                             // and its flip, if the request was set
    m.tstates = t0;                                                                  // and its time, so the run keeps its pace
    injections++; pcs.add(pc0);
  }
  for (let f = 0; f < 40; f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      const cpu = m.cpu;
      if (cpu.pc === S.MAIN) started = true;
      if (started && cpu.iff1 && !cpu.halted && !cpu.eiDelay) {
        injectAndCheck(cpu.pc);
        if (cpu.pc >= S.erase_all && cpu.pc < S.draw_all) regions.add('erase_all');
        else if (cpu.pc >= S.draw_all && cpu.pc < S.M_MAIN_E) regions.add('draw_all');
        else if (cpu.pc >= S.TICK_LOOP && cpu.pc < S.WORK_START) regions.add('wait');
        else if (cpu.pc >= game.gsyms.GAME_FRAME_ENTRY && cpu.pc < game.gsyms.ball) regions.add('frame_entry');
        else if (cpu.pc >= S.RT_SHOW && cpu.pc < S.M_API_E) regions.add('api');
        else if (cpu.pc >= S.WORK_START && cpu.pc < S.WORK_END) regions.add('loop');
      }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  console.log('Injected interrupt at every instruction boundary of the frame loop (40 frames)');
  check('interrupts were injected in the wait loop, erase_all, draw_all, the loop body, frame_entry and the RT_* routines',
    injections > 20000 && ['wait', 'erase_all', 'draw_all', 'loop', 'frame_entry', 'api'].every((r) => regions.has(r)),
    `${injections} injections at ${pcs.size} distinct addresses; regions ${[...regions].join(', ')}`);
  check('the injected ISR always returns to the interrupted instruction', noReturn === 0, `${noReturn} did not return`);
  check('registers, alternates, IX/IY, SP, I, IM and IFF1 unchanged across every injected interrupt', violations.length === 0,
    violations.length ? `${violations.length} changes, first: pc ${hex(violations[0].pc0)} ${violations[0].reg} ${violations[0].before}->${violations[0].after}` : '');
  check('the machine is still running correctly afterwards (ticks advanced, canary intact)', rd16(m, S.V_TICKS) > 20 && rd16(m, S.STACK_CANARY) === 0x5AA5,
    `V_TICKS ${rd16(m, S.V_TICKS)}`);
}

// ---- 2. chaos: extra interrupts at random instants, effects kept ------------------------------------------------------
{
  console.log('\nChaos: 200 frames with extra interrupts at random instruction boundaries (effects kept)');
  const m = boot();
  let seed = 12345;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let pending = null, firstTickBad = null, firstTab = null, started = false, extra = 0, writeViol = 0, spMin = 0xFFFF, spMax = 0, ticksOk = true, lastTick = -1, tabBad = 0, calls = [], inFrame = false;
  const state = [{ visible: false, x: 0, y: 0 }, { visible: false, x: 0, y: 0 }];
  const origWrite = m.bus.write;
  m.bus.write = (addr, v) => {
    const a = addr & 0xFFFF, base = (m.portFF & 1) ? 0x6000 : 0x4000;
    if (started && a >= base && a < base + 0x1B00) writeViol++;
    origWrite(addr, v);
  };
  let frames = 0;
  for (let f = 0; f < 200; f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      const cpu = m.cpu;
      const resumed = pending && cpu.pc === pending.pc && cpu.sp === pending.sp;   // back at an instruction already seen before the extra interrupt
      if (resumed) pending = null;
      if (cpu.pc === S.MAIN) started = true;
      if (cpu.sp < spMin) spMin = cpu.sp;
      if (cpu.sp > spMax) spMax = cpu.sp;
      if (cpu.pc === S.WORK_START && !resumed) inFrame = true;
      if (cpu.pc === S.RT_SHOW && inFrame && !resumed) {
        const i = cpu.a, x = (cpu.b << 8) | cpu.c, y = (cpu.d << 8) | cpu.e;
        if (i < 2) state[i] = { visible: true, x: clamp((x << 16) >> 16, 239), y: clamp((y << 16) >> 16, 176) };
      }
      if (cpu.pc === S.RT_HIDE && inFrame && !resumed && cpu.a < 2) state[cpu.a].visible = false;
      if (cpu.pc === S.TICK_REQUEST && !resumed) {
        const n = rd16(m, S.V_TICKS) - 1;
        if (n !== lastTick + 1) { ticksOk = false; firstTickBad ??= { n, lastTick }; }
        lastTick = n;
        for (let i = 0; i < 2; i++) {
          const e = S.SPR_TAB + i * 6;
          if (rd8(m, e) !== (state[i].visible ? 1 : 0) || (state[i].visible && (rd16(m, e + 2) !== state[i].x || rd16(m, e + 4) !== state[i].y))) { tabBad++; firstTab ??= { n, i, state: state[i], tab: [rd8(m, e), rd16(m, e + 2), rd16(m, e + 4)] }; }
        }
        inFrame = false;
      }
      if (started && cpu.iff1 && !cpu.halted && !cpu.eiDelay && rnd() < 1 / 400) { pending = { pc: cpu.pc, sp: cpu.sp }; Z.irqZ80(cpu, m.bus); extra++; }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
    frames++;
  }
  void calls;
  check('extra interrupts were taken throughout (about 1 per 400 instructions)', extra > 1000, `${extra} extra interrupts`);
  check('the displayed display file is never written, whatever the interrupt timing', writeViol === 0, `${writeViol} writes`);
  check('ticks stay in order (0, 1, 2, ...) and none is lost', ticksOk && lastTick > 30, firstTickBad ? JSON.stringify(firstTickBad) : `${lastTick + 1} ticks`);
  check('the sprite state table equals what the game SHOWed at the end of every tick', tabBad === 0, firstTab ? JSON.stringify(firstTab) : `${tabBad} mismatches`);
  check('stack stays inside $F002..$FF00 and the canary is intact', rd16(m, S.STACK_CANARY) === 0x5AA5 && spMin >= S.STACK_CANARY + 2 && spMax <= S.STACK_TOP,
    `SP ${hex(spMin)}..${hex(spMax)}`);
  check('the compiled-variable area words survive', rd16(m, S.GAME_VARS_BASE) === 0x1234 && rd16(m, S.GAME_VARS_LIMIT - 1) === 0x4321);
}

finish('M2 runtime regs');
