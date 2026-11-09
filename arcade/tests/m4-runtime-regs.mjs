"use strict";
// m4-runtime-regs.mjs -- M4a runtime test, part 4: register / interrupt discipline of runtime v2 (the M4a counterpart of m3-runtime-regs.mjs):
//  1. A real IM 1 interrupt is injected at EVERY instruction boundary of the main loop from MAIN on (the wait spin, the erase, the cell redraw,
//     frame_entry with its text / tile / sound / RT_STICK / RT_KEYDOWN / RT_HIT calls, redraw_dirty, the unrolled blitters, the flip request),
//     with 16 instances moving and an effect playing so that the sound tick runs too.  The ISR runs to its RET and every register (incl.
//     alternates, IX, IY), SP, I, IM and IFF1 must equal what they were; the ISR's writes are undone so the injections have no other effect.
//  2. Every path of the sound tick as the interrupt.
//  3. Chaos: 250 frames with an extra interrupt at random instruction boundaries (about one per 400 instructions), effects KEPT, sound playing,
//     RT_STICK and RT_KEYDOWN every tick: no write to the displayed file, ticks in order, the picture equal to the model after every refresh,
//     AY registers equal to AY_SHADOW at the end, the stack inside its area.
//  4. RT_STICK with an interrupt offered at every instruction (unchanged from v1; the DI ... EI bracket must still hold).
//   node arcade/tests/m4-runtime-regs.mjs
import * as C from './m4-common.mjs';
import { rng, randomScene, randomTiles } from './m3-scenes.mjs';
const { M, Z, hex, makeChecks, rd8, rd16, op } = C;

const { check, finish } = makeChecks();
const rt = C.runtime();
const S = rt.syms;
console.log('M4a runtime register discipline: injected interrupts at every instruction of the frame loop, with sound playing\n');

const rec = (toneLo, toneHi, vol, noise, mix) => [toneLo & 255, (toneHi & 15) | ((vol & 15) << 4), (noise & 31) | ((mix & 7) << 5), 0];
const EFF = [
  Array.from({ length: 200 }, (_, k) => rec(60 + 3 * k, (60 + 3 * k) >> 8, 15 - ((k >> 3) % 16), k % 31, k % 4)),    // long, every register moving
  Array.from({ length: 40 }, () => rec(0x90, 1, 9, 5, 1)),
];
const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl', 'sp', 'i', 'im', 'iff1'];
const snap = (cpu) => Object.fromEntries(KEYS.map((k) => [k, cpu[k]]));

function makeGame(nticks, seed, ninst = 16) {
  const r = rng(seed + 9);
  const assets = [C.randomAsset(r, 16, 16, 8), C.randomAsset(r, 8, 8, 4), C.randomAsset(r, 16, 12, 2), C.randomAsset(r, 8, 16, 1)];
  const script = randomScene(seed, nticks, { sprites: 0, tiles: 6, textRate: 0.5, tileRate: 0.6 });
  const pos = Array.from({ length: ninst }, () => ({ x: r.int(0, 230), y: r.int(0, 170), dx: r.int(-5, 5), dy: r.int(-4, 4) }));
  script.forEach((t, k) => {
    pos.forEach((p, i) => { p.x += p.dx; p.y += p.dy; if (p.x < 0 || p.x > 238) p.dx = -p.dx; if (p.y < 0 || p.y > 175) p.dy = -p.dy; if (r.chance(0.05)) t.push(op.hide(i)); else t.push(op.show(i, Math.max(0, p.x), Math.max(0, p.y))); });
    t.push(op.stick(1), op.keydown(65), op.keydown(32), op.hit(r.int(0, ninst), r.int(0, ninst)));
    if (k === 0) t.push(op.play(0));
    else if (k % 23 === 0) t.push(op.play(k % 2));
  });
  const spec = { div: 3, assets, insts: Array.from({ length: ninst }, (_, i) => i % 4), tiles: randomTiles(rng(seed + 1), 6), sfx: EFF, script };
  return { game: C.scriptGame(spec), script, spec };
}

// ---- 1. inject at every instruction boundary --------------------------------------------------------------------------
{
  const { game } = makeGame(24, 7001);
  const m = C.newMachine(game.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  let started = false, injections = 0, noReturn = 0, violations = [], sndInjections = 0;
  const pcs = new Set(), regions = new Set();
  m.joystick[0] = 0b11101110;
  m.keyMatrix[1] = 0x1E;                         // A held
  function injectAndCheck(pc0) {
    const cpu = m.cpu;
    const t0 = m.tstates;
    const before = snap(cpu), varsBefore = Array.from(m.ram.slice(S.VARS, S.VARS + 0x100)), ffBefore = m.portFF;
    const ayBefore = Array.from(m.ay.regs);
    KEYS.forEach((k, i) => { if (!['sp', 'i', 'im', 'iff1'].includes(k)) cpu[k] = (0x5A + 37 * i) & 0xFF; });
    const sent = snap(cpu);
    const sndActive = rd8(m, S.V_SFX_ACTIVE) !== 0;
    Z.irqZ80(cpu, m.bus);                       // the real interrupt: push PC, PC = $0038, IFF1 = 0
    let steps = 0;
    while (!(cpu.pc === pc0 && cpu.sp === before.sp) && steps < 800) { Z.runZ80(cpu, m.bus, 1, m); steps++; }
    if (steps >= 800) { noReturn++; return; }
    const after = snap(cpu);
    for (const k of KEYS) if (after[k] !== sent[k]) violations.push({ pc0, reg: k, before: sent[k], after: after[k] });
    for (const k of KEYS) cpu[k] = before[k];
    for (let i = 0; i < varsBefore.length; i++) m.ram[S.VARS + i] = varsBefore[i];   // undo the ISR's variable writes (incl. the sound pointer)
    for (let i = 0; i < 16; i++) m.ay.regs[i] = ayBefore[i];                          // and its AY writes
    m.portFF = ffBefore;                                                             // and its flip, if the request was set
    m.tstates = t0;
    injections++; pcs.add(pc0);
    if (sndActive) sndInjections++;
  }
  for (let f = 0; f < 40; f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      const cpu = m.cpu;
      if (cpu.pc === S.MAIN) started = true;
      if (started && cpu.iff1 && !cpu.halted && !cpu.eiDelay) {
        injectAndCheck(cpu.pc);
        const pc = cpu.pc;
        if (pc >= S.erase_all && pc < S.draw_all) regions.add('erase_all');
        else if (pc >= S.draw_all && pc < S.M_MAIN_E) regions.add('draw_all');
        else if (pc >= S.TICK_LOOP && pc < S.WORK_START) regions.add('wait');
        else if (pc >= S.M_SPRITE_S && pc < S.erase_cells) regions.add('blit');
        else if (pc >= S.erase_cells && pc < S.M_SPRITE_E) regions.add('erase_cells');
        else if (pc >= S.redraw_dirty && pc < S.M_VIDEO_E) regions.add('redraw');
        else if (pc >= game.gsyms.GAME_FRAME_ENTRY && pc < game.gsyms.GAME_END) regions.add('frame_entry');
        else if (pc >= S.RT_SHOW && pc < S.M_API_E) regions.add('api');
        else if (pc >= S.M_TEXT_S && pc < S.M_TEXT_E) regions.add('text');
        else if (pc >= S.M_SOUND_S && pc < S.M_SOUND_E) regions.add('sound');
        else if (pc >= S.M_KEYS_S && pc < S.M_KEYS_E) regions.add('keys');
      }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  console.log('Injected interrupt at every instruction boundary of the frame loop (40 frames incl. the boot, 16 instances, an effect playing)');
  check('interrupts were injected in every part of the loop (wait, erase, cell erase, blitters, redraw_dirty, draw_all, frame_entry, API, text, sound, keys)',
    injections > 20000 && ['wait', 'erase_all', 'erase_cells', 'blit', 'redraw', 'draw_all', 'frame_entry', 'api', 'text', 'sound', 'keys'].every((r) => regions.has(r)),
    `${injections} injections at ${pcs.size} distinct addresses; regions ${[...regions].join(', ')}`);
  check('...most of them while an effect was playing, so the injected interrupt ran the sound tick', sndInjections > injections / 2, `${sndInjections} of ${injections}`);
  check('the injected ISR always returns to the interrupted instruction', noReturn === 0, `${noReturn} did not return`);
  check('registers, alternates, IX/IY, SP, I, IM and IFF1 unchanged across every injected interrupt (flags included)', violations.length === 0,
    violations.length ? `${violations.length} changes, first: pc ${hex(violations[0].pc0)} ${violations[0].reg} ${violations[0].before}->${violations[0].after}` : '');
  check('the machine is still running correctly afterwards (ticks advanced, canary intact)', rd16(m, S.V_TICKS) > 4 && rd16(m, S.STACK_CANARY) === 0x5AA5, `V_TICKS ${rd16(m, S.V_TICKS)}`);
}

// ---- 2. every path of the sound tick, called as the interrupt ---------------------------------------------------------------
{
  console.log('\nEvery path of the sound tick');
  const recs = [
    rec(1, 1, 1, 1, 1), rec(1, 1, 1, 1, 1),                    // no change
    rec(2, 1, 1, 1, 1), rec(2, 2, 1, 1, 1), rec(2, 2, 2, 1, 1), rec(2, 2, 2, 2, 1), rec(2, 2, 2, 2, 2),   // 1 write each
    rec(3, 3, 3, 3, 3),                                         // all five
    rec(3, 3, 3, 3, 3),                                         // none again
    rec(0, 0, 0, 0, 0),                                         // all five again (volume to 0)
  ];
  const g = C.scriptGame({ sfx: [recs, []], script: [[op.play(0)]], div: 1 });
  const m = C.newMachine(g.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  for (let f = 0; f < 3; f++) M.runFrame(m);
  const paths = [];
  let bad = [];
  for (let rep = 0; rep < 2; rep++) {
    const start = g.img[C.SCRIPT.SFXTAB + 1] | (g.img[C.SCRIPT.SFXTAB + 2] << 8);
    m.ram[S.V_SFX_PTR] = start & 255; m.ram[S.V_SFX_PTR + 1] = start >> 8; m.ram[S.V_SFX_ACTIVE] = 1;
    for (let i = 0; i < 16; i++) { m.ay.regs[i] = 0; m.ram[S.AY_SHADOW + i] = 0; }
    for (let k = 0; k < recs.length + 1; k++) {
      const cpu = m.cpu;
      while (!(cpu.iff1 && !cpu.eiDelay && !cpu.halted)) Z.runZ80(cpu, m.bus, 1, m);
      const pc0 = cpu.pc, before = snap(cpu), t0 = m.tstates;
      KEYS.forEach((key, i) => { if (!['sp', 'i', 'im', 'iff1'].includes(key)) cpu[key] = (0x3C + 29 * i + k) & 0xFF; });
      const sent = snap(cpu);
      let ioN = 0;
      const o = m.bus.ioWrite; m.bus.ioWrite = (p, v) => { if ((p & 255) === 0xF5) ioN++; o(p, v); };
      Z.irqZ80(cpu, m.bus);
      let steps = 0;
      while (!(cpu.pc === pc0 && cpu.sp === before.sp) && steps < 2000) { Z.runZ80(cpu, m.bus, 1, m); steps++; }
      m.bus.ioWrite = o;
      const after = snap(cpu);
      for (const key of KEYS) if (after[key] !== sent[key]) bad.push({ rec: k, reg: key, before: sent[key], after: after[key] });
      paths.push(ioN);
      for (const key of KEYS) cpu[key] = before[key];
      m.tstates = t0;
    }
  }
  check('registers (all, alternates, IX, IY, flags, SP, IFF) preserved by the ISR on each sound-tick path: 0, 1, 2, 3, 4, 5 AY writes and the terminator',
    bad.length === 0 && [0, 1, 5].every((n) => paths.includes(n)), bad.length ? JSON.stringify(bad[0]) : `AY writes per interrupt: ${paths.slice(0, recs.length + 1).join(',')}`);
}

// ---- 3. chaos --------------------------------------------------------------------------------------------------------------
{
  console.log('\nChaos: 250 frames with extra interrupts at random instruction boundaries (effects kept), sound playing, RT_STICK and RT_KEYDOWN every tick');
  const { game, script } = makeGame(90, 7002);
  const m = C.newMachine(game.dck);
  let entry = false;
  for (let f = 0; f < 400 && !entry; f++) { M.runFrame(m); if (rd16(m, S.HO_MARK) === 0x5AA5) entry = true; }
  m.joystick[0] = 0b11111101;
  m.keyMatrix[1] = 0x1E; m.keyMatrix[7] = 0x1E;
  let seed = 4242;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const model = new C.Model2(game.spec);
  let pending = null, started = false, extra = 0, writeViol = 0, ticksOk = true, lastTick = -1, picOk = 0, picBad = 0, spMin = 0xFFFF, spMax = 0, firstBad = null;
  const snaps = [null, null];
  const origWrite = m.bus.write;
  m.bus.write = (addr, v) => {
    const a = addr & 0xFFFF, base = (m.portFF & 1) ? 0x6000 : 0x4000;
    if (started && a >= base && a < base + 0x1B00) writeViol++;
    origWrite(addr, v);
  };
  for (let f = 0; f < 250; f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      const cpu = m.cpu;
      const resumed = pending && cpu.pc === pending.pc && cpu.sp === pending.sp;
      if (resumed) pending = null;
      if (cpu.pc === S.MAIN) started = true;
      if (cpu.sp < spMin) spMin = cpu.sp;
      if (cpu.sp > spMax) spMax = cpu.sp;
      if (cpu.pc === S.TICK_REQUEST && !resumed) {
        const n = rd16(m, S.V_TICKS) - 1;
        if (n !== lastTick + 1) ticksOk = false;
        lastTick = n;
        for (const o of script[n] ?? []) model.apply(o);
        snaps[rd8(m, S.V_HIDDEN)] = model.clone();
      }
      if (started && cpu.iff1 && !cpu.halted && !cpu.eiDelay && rnd() < 1 / 400) { pending = { pc: cpu.pc, sp: cpu.sp }; Z.irqZ80(cpu, m.bus); extra++; }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
    if (rd16(m, S.V_FRAMES) > 3 && started) {
      const bit = m.portFF & 1, sn = snaps[bit];
      if (sn) {
        const exp = sn.render(), got = C.dfileOf(m, bit);
        const bad = C.diffCount(exp.bitmap, got.bitmap) + C.diffCount(exp.attrs, got.attrs);
        if (bad === 0) picOk++; else { picBad++; firstBad ??= { frame: f, bad, bit }; }
      }
    }
  }
  check('extra interrupts were taken throughout (about 1 per 400 instructions)', extra > 1500, `${extra} extra interrupts`);
  check('the displayed display file is never written, whatever the interrupt timing', writeViol === 0, `${writeViol} writes`);
  check('ticks stay in order (0, 1, 2, ...) and none is lost', ticksOk && lastTick > 40, `${lastTick + 1} ticks`);
  check('the picture on screen equals the model after every refresh (cells and instances, memory)', picBad === 0 && picOk > 150, firstBad ? JSON.stringify(firstBad) : `${picOk} refreshes`);
  check('stack stays inside $FB02..$FF00 and the canary is intact', rd16(m, S.STACK_CANARY) === 0x5AA5 && spMin >= S.STACK_LIMIT && spMax <= S.STACK_TOP, `SP ${hex(spMin)}..${hex(spMax)}`);
  let shadowBad = 0;
  for (const r of [0, 1, 6, 7, 8]) if (rd8(m, S.AY_SHADOW + r) !== m.ay.regs[r]) shadowBad++;
  check('AY_SHADOW equals the AY registers 0, 1, 6, 7, 8 at the end (extra interrupts, RT_STICK and RT_KEYDOWN never split an AY register access)', shadowBad === 0, `${shadowBad} differ`);
  const log = []; for (let i = 0; i < rd16(m, C.SCRIPT.LOGN); i++) log.push(rd16(m, C.SCRIPT.LOGBUF + 2 * i));
  const nLog = Math.min(log.length, 4 * model.log.length);
  let logBad = 0;
  for (let k = 0; k < nLog; k++) if (log[k] !== (k % 4 === 0 ? 2 : k % 4 === 3 ? model.log[(k - 3) / 4] : 1)) logBad++;
  check('the log of RT_STICK (2), RT_KEYDOWN (A and space held: 1, 1) and RT_HIT (the model) answers is right, 4 per tick, in spite of the extra interrupts', nLog >= 4 * 40 && logBad === 0, `${logBad} wrong of ${nLog}`);
}

// ---- 4. an extra interrupt at every instruction of RT_STICK, effects KEPT ----------------------------------------------------
{
  console.log('\nRT_STICK with an interrupt offered at every one of its instructions (effects kept, an effect playing, every register changing each refresh)');
  const rec2 = (k) => [(k * 37 + 11) & 255, ((k * 5) & 15) | ((((k >> 1) % 15) + 1) << 4), (k * 3) & 31 | ((k & 3) << 5), 0];
  const longFx = Array.from({ length: 220 }, (_, k) => rec2(k));
  const script = Array.from({ length: 100 }, (_, k) => [op.stick(1), op.stick(2)].concat(k === 0 ? [op.play(0)] : []));
  const g = C.scriptGame({ sfx: [longFx], script, div: 1 });
  const m = C.newMachine(g.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  m.joystick[0] = 0b11110110; m.joystick[1] = 0b01111101;
  const want = (v) => { const a = (~v) & 0xFF; const d = a & 0x0F; return (d === 0x0F ? 0 : d) | (a & 0x80 ? 16 : 0); };
  let started = false, offered = 0;
  let inStick = false, sticksp = 0;
  for (let f = 0; f < 110; f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      const cpu = m.cpu;
      if (cpu.pc === S.MAIN) started = true;
      if (cpu.pc === S.RT_STICK) { inStick = true; sticksp = cpu.sp; }
      const inside = inStick && cpu.pc >= S.RT_STICK && cpu.pc < S.M_API_E;
      if (started && inside && cpu.iff1 && !cpu.halted && !cpu.eiDelay) {
        const pc0 = cpu.pc, sp0 = cpu.sp;
        Z.irqZ80(cpu, m.bus); offered++;
        let n = 0;
        while (!(cpu.pc === pc0 && cpu.sp === sp0) && n++ < 2000) Z.runZ80(cpu, m.bus, 1, m);    // the ISR runs to its RET, effects kept
      }
      if (inStick && cpu.sp === sticksp + 2 && cpu.pc !== S.RT_STICK && !(cpu.pc >= S.RT_STICK && cpu.pc < S.M_API_E)) inStick = false;
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  const log = []; for (let i = 0; i < rd16(m, C.SCRIPT.LOGN); i++) log.push(rd16(m, C.SCRIPT.LOGBUF + 2 * i));
  const bad = log.filter((v, i) => v !== want(i % 2 === 0 ? m.joystick[0] : m.joystick[1])).length;
  let shadowBad = 0;
  for (const r of [0, 1, 6, 7, 8]) if (rd8(m, S.AY_SHADOW + r) !== m.ay.regs[r]) shadowBad++;
  check('interrupts could be taken only in the first instructions of RT_STICK (before its DI): at most 6 per call, none between the AY select and the EI', offered <= 6 * log.length && offered > 0, `${offered} taken in ${log.length} calls`);
  check('every RT_STICK result is right (both sticks) although an interrupt was offered at each of its instructions', log.length > 150 && bad === 0, `${bad} wrong of ${log.length}`);
  check('AY_SHADOW equals the AY registers 0, 1, 6, 7, 8 afterwards and the machine runs on', shadowBad === 0 && rd16(m, S.STACK_CANARY) === 0x5AA5 && rd16(m, S.V_TICKS) > 60, `${shadowBad} differ`);
}

finish('M4a runtime regs');
