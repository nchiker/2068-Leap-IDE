"use strict";
// m5-runtime-regs.mjs -- M5 runtime test, part 3: register / interrupt discipline of the tile operations (the M5 counterpart of m4-runtime-regs.mjs):
//  1. A real IM 1 interrupt is injected at EVERY instruction boundary of tileops.asm (clip, walk_setup, the group functions, the unrolled whole-byte
//     loops, the alternate-set save and restore, the dirty marking, BORDER, RANDOMISE) while a script runs every operation on a screen with 6 moving
//     instances and an effect playing.  The ISR runs to its RET and every register (incl. the alternates the operations use, IX, IY), SP, I, IM and IFF1
//     must equal what they were; the ISR's writes are undone so the injections have no other effect.
//  2. Chaos: 200 frames with an extra interrupt at random instruction boundaries (about one per 300 instructions, inside the operations too): the
//     picture equals the model after every refresh, no write to the displayed file, ticks in order, the stack inside its area.
//  3. The overrun: FILL of the whole screen every tick at frame_div 1 (the work exceeds a refresh): no tearing, no lost flip.
//   node arcade/tests/m5-runtime-regs.mjs
import * as C from './m5-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { M, Z, FRAME_T, hex, makeChecks, rd8, rd16, op } = C;

const { check, finish } = makeChecks();
const S = C.rt().syms;
console.log('M5 runtime register discipline: injected interrupts at every instruction of the tile operations\n');

const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl', 'sp', 'i', 'im', 'iff1'];
const snap = (cpu) => Object.fromEntries(KEYS.map((k) => [k, cpu[k]]));
const rec = (k) => [(60 + 3 * k) & 255, (((60 + 3 * k) >> 8) & 15) | ((15 - ((k >> 3) % 16)) << 4), (k % 31) | ((k % 4) << 5), 0];
const EFF = [Array.from({ length: 300 }, (_, k) => rec(k))];

const tiles = randomTiles(rng(61), 7);
const randMap = (r, w, h) => ({ w, h, cells: Array.from({ length: w * h }, () => (r.chance(0.6) ? 0x80 | r.int(0, 6) : r.int(32, 126))) });
function makeGame(nticks, seed, { div = 1, ninst = 6 } = {}) {
  const r = rng(seed);
  const maps = [randMap(r, 32, 24), randMap(r, 14, 9), randMap(r, 20, 10)];
  const assets = [C.C.randomAsset(r, 16, 16, 8), C.C.randomAsset(r, 8, 8, 4), C.C.randomAsset(r, 16, 10, 2)];
  // fixed ticks that reach every path (head / whole bytes / tail / a short middle group, direct and buffered COPY, LOADMAP cut on all sides), then random ones
  const script = [
    [op.fill(0, 0, 32, 24, 1)], [op.fill(3, 2, 10, 6, 2)], [op.fill(5, 3, 3, 4, 3)], [op.fill(2, 9, 4, 3, 4), op.fill(13, 12, 19, 1, 5)], [op.fill(-3, 20, 10, 9, 6)],
    [op.fillc(0, 0, 32, 3, 65), op.fillc(30, 22, 9, 9, 66)], [op.fillc(8, 8, 16, 8, 67)],
    [op.copy(0, 0, 32, 23, 0, 1)], [op.copy(0, 5, 32, 19, 0, -2)], [op.copy(2, 2, 12, 8, 14, 9)], [op.copy(0, 0, 31, 24, 1, 0)], [op.copy(1, 0, 31, 24, 0, 0)],
    [op.copy(3, 3, 20, 15, 5, 6)], [op.copy(10, 10, 20, 10, 8, 8)], [op.copy(-4, -4, 12, 12, 2, 2)], [op.copy(25, 20, 12, 12, 20, 15)],
    [op.loadmap(0)], [op.loadmap(1)], [op.loadmapat(2, 5, 3)], [op.loadmapat(0, -10, -8)], [op.loadmapat(0, 20, 15)], [op.loadmapat(1, 27, 17)],
    [op.border(5), op.randomise(77), op.rnd(), op.rnd(), op.randomise(0), op.rnd(), op.border(1)],
  ];
  for (let k = 0; k < nticks; k++) script.push(C.randomTileOps(r, { maps: 3, tiles: 7 }));
  const pos = Array.from({ length: ninst }, () => ({ x: r.int(0, 230), y: r.int(0, 170), dx: r.int(-5, 5), dy: r.int(-4, 4) }));
  script.forEach((t, k) => {
    pos.forEach((p, i) => { p.x += p.dx; p.y += p.dy; if (p.x < 0 || p.x > 238) p.dx = -p.dx; if (p.y < 0 || p.y > 175) p.dy = -p.dy; t.push(op.show(i, Math.max(0, p.x), Math.max(0, p.y))); });
    if (k === 0) t.push(op.play(0));
  });
  const spec = { div, tiles, maps, assets, insts: Array.from({ length: ninst }, (_, i) => i % 3), sfx: EFF, script };
  return { game: C.opsGame(spec), script, spec };
}

// ---- 1. inject at every instruction boundary of the module ----------------------------------------------------------------------
{
  const { game } = makeGame(10, 6001);
  const m = C.newMachine(game.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  let started = false, injections = 0, noReturn = 0, inModule = 0;
  const violations = [], pcs = new Set(), routines = new Set(), perPc = new Map();
  const names = ['RT_FILL', 'RT_FILLC', 'RT_COPY', 'RT_LOADMAP', 'RT_LOADMAPAT', 'RT_LOADMAPPTR', 'RT_BORDER', 'RT_RANDOMISE', 'walk_setup', 'clip_axis', 'g_fill', 'g_copy', 'g_load', 'mask_done'];
  const bounds = names.map((n) => [n, S[n]]).sort((a, b) => a[1] - b[1]);
  const where = (pc) => { let nm = null; for (const [n, a] of bounds) if (a <= pc) nm = n; return nm; };
  const T0 = S.M_TILEOPS_S, T1 = S.M_TILEOPS_E;
  function injectAndCheck(pc0) {
    const cpu = m.cpu, t0 = m.tstates;
    const before = snap(cpu), varsBefore = Array.from(m.ram.slice(S.VARS, S.VARS + 0x100)), ffBefore = m.portFF;
    const ayBefore = Array.from(m.ay.regs);
    KEYS.forEach((k, i) => { if (!['sp', 'i', 'im', 'iff1'].includes(k)) cpu[k] = (0x5A + 37 * i) & 0xFF; });
    const sent = snap(cpu);
    Z.irqZ80(cpu, m.bus);
    let steps = 0;
    while (!(cpu.pc === pc0 && cpu.sp === before.sp) && steps < 800) { Z.runZ80(cpu, m.bus, 1, m); steps++; }
    if (steps >= 800) { noReturn++; return; }
    const after = snap(cpu);
    for (const k of KEYS) if (after[k] !== sent[k]) violations.push({ pc0, reg: k, before: sent[k], after: after[k] });
    for (const k of KEYS) cpu[k] = before[k];
    for (let i = 0; i < varsBefore.length; i++) m.ram[S.VARS + i] = varsBefore[i];
    for (let i = 0; i < 16; i++) m.ay.regs[i] = ayBefore[i];
    m.portFF = ffBefore;
    m.tstates = t0;
    injections++; pcs.add(pc0);
  }
  // the routines' own state (registers of the operation) must survive the interrupt; so do the cells: nothing but the ISR is run
  let rnd = 99;
  const next = () => { rnd = (Math.imul(rnd, 1664525) + 1013904223) >>> 0; return rnd / 4294967296; };
  for (let f = 0; f < 420; f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      const cpu = m.cpu;
      if (cpu.pc === S.MAIN) started = true;
      if (started && cpu.iff1 && !cpu.halted && !cpu.eiDelay) {
        const pc = cpu.pc;
        if (pc >= T0 && pc < T1) { const n = (perPc.get(pc) ?? 0) + 1; perPc.set(pc, n); routines.add(where(pc)); if (n <= 10 || n % 25 === 0) { inModule++; injectAndCheck(pc); } }
        else if (next() < 1 / 60) injectAndCheck(pc);
      }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  const modulePcs = [...pcs].filter((p) => p >= T0 && p < T1).length;
  console.log('Interrupt injected at every instruction boundary executed inside tileops.asm (420 frames: every operation, an effect playing, 6 moving instances; each address up to 10 times and then every 25th time)');
  check('interrupts were injected in every routine of the module (FILL, FILLC, COPY, LOADMAP, LOADMAPAT, BORDER, RANDOMISE, walk_setup, clip_axis, g_fill, g_copy, g_load, mask_done)',
    ['RT_FILL', 'RT_FILLC', 'RT_COPY', 'RT_LOADMAP', 'RT_LOADMAPAT', 'RT_BORDER', 'RT_RANDOMISE', 'walk_setup', 'clip_axis', 'g_fill', 'g_copy', 'g_load', 'mask_done'].every((n) => routines.has(n)) && inModule > 8000,
    `${inModule} injections inside the module at ${modulePcs} distinct addresses (of ${T1 - T0} bytes)`);
  check('the injected ISR always returns to the interrupted instruction', noReturn === 0, `${noReturn} did not return`);
  check('registers, alternates (the operations keep their state in them), IX/IY, SP, I, IM and IFF1 unchanged across every injected interrupt (flags included)', violations.length === 0,
    violations.length ? `${violations.length} changes, first: pc ${hex(violations[0].pc0)} ${violations[0].reg} ${violations[0].before}->${violations[0].after}` : '');
  check('the machine is still running correctly afterwards (ticks advanced, canary intact)', rd16(m, S.V_TICKS) > 30 && rd16(m, S.STACK_CANARY) === 0x5AA5, `V_TICKS ${rd16(m, S.V_TICKS)}`);
}

// ---- 2. chaos ------------------------------------------------------------------------------------------------------------------
{
  console.log('\nChaos: extra interrupts at random instruction boundaries, inside the operations as well (about one per 300 instructions)');
  const { game, script } = makeGame(60, 6002, { div: 2 });
  const m = C.newMachine(game.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  const model = new C.Model5(game.spec);
  let seed = 4343;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let pending = null, started = false, extra = 0, extraIn = 0, writeViol = 0, ticksOk = true, lastTick = -1, picOk = 0, picBad = 0, spMin = 0xFFFF, spMax = 0, firstBad = null;
  const snaps = [null, null];
  const origWrite = m.bus.write;
  m.bus.write = (addr, v) => { const a = addr & 0xFFFF, base = (m.portFF & 1) ? 0x6000 : 0x4000; if (started && a >= base && a < base + 0x1B00) writeViol++; origWrite(addr, v); };
  const T0 = S.M_TILEOPS_S, T1 = S.M_TILEOPS_E;
  for (let f = 0; f < 200 + 40; f++) {
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
      if (started && cpu.iff1 && !cpu.halted && !cpu.eiDelay && rnd() < 1 / 300) { pending = { pc: cpu.pc, sp: cpu.sp }; if (cpu.pc >= T0 && cpu.pc < T1) extraIn++; Z.irqZ80(cpu, m.bus); extra++; }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
    if (rd16(m, S.V_FRAMES) > 3 && started) {
      const bit = m.portFF & 1, sn = snaps[bit];
      if (sn) {
        const exp = sn.render(), got = C.C.dfileOf(m, bit);
        const bad = C.C.diffCount(exp.bitmap, got.bitmap) + C.C.diffCount(exp.attrs, got.attrs);
        if (bad === 0) picOk++; else { picBad++; firstBad ??= { frame: f, bad, bit }; }
      }
    }
  }
  check('extra interrupts were taken throughout, many of them inside the tile operations', extra > 2000 && extraIn > 300, `${extra} extra interrupts, ${extraIn} inside tileops.asm`);
  check('the displayed display file is never written, whatever the interrupt timing', writeViol === 0, `${writeViol} writes`);
  check('ticks stay in order and none is lost', ticksOk && lastTick > 60, `${lastTick + 1} ticks`);
  check('the picture on screen equals the model after every refresh (cells and instances)', picBad === 0 && picOk > 100, firstBad ? JSON.stringify(firstBad) : `${picOk} refreshes`);
  check('stack stays inside $FB02..$FF00 and the canary is intact', rd16(m, S.STACK_CANARY) === 0x5AA5 && spMin >= S.STACK_LIMIT && spMax <= S.STACK_TOP, `SP ${hex(spMin)}..${hex(spMax)}`);
  const log = []; for (let i = 0; i < rd16(m, C.OPS.LOGN); i++) log.push(rd16(m, C.OPS.LOGBUF + 2 * i));
  check('the RT_RND values logged equal the model\'s (RANDOMISE 77, then HL = 0 from the frame counter is the one value the model cannot know: skipped)', log.slice(0, 2).join() === model.log.slice(0, 2).join() && log.length >= 3, `${log.join()} / ${model.log.join()}`);
}

// ---- 3. a FILL of the whole screen every tick: the overrun --------------------------------------------------------------------------
{
  console.log('\nThe overrun: FILL 32 x 24 every tick at frame_div 1 (about 80,000 T of FILL + the redraw of 768 cells per tick)');
  const r = rng(63);
  const script = Array.from({ length: 30 }, (_, k) => [op.fill(0, 0, 32, 24, 1 + (k % 6)), op.show(0, 20 + 5 * k, 30 + 3 * k)]);
  const game = C.opsGame({ div: 1, tiles, assets: [C.C.randomAsset(r, 16, 16, 8)], insts: [0], script });
  const st = C.observe5(game, 200, { script });
  const worst = Math.max(...st.work);
  console.log(`  (tick work: max ${worst} T = ${(worst / FRAME_T).toFixed(2)} refreshes)`);
  check('the tick overruns the refresh (the case is exercised)', worst > 1.5 * FRAME_T, `${worst} T`);
  check('the picture equals the model after every refresh (the last complete picture stays on screen while the tick works)', st.pictureBad === 0 && st.pixelBad === 0 && st.pictureOk >= 195, JSON.stringify(st.firstBad));
  check('no tearing, no lost frame: nothing written to the displayed file, flips right, frame counter in order', st.writeViolations === 0 && st.flipMismatch === 0 && st.missed === 0 && st.shadowBad === 0 && st.skippedFlips > 0, `${st.skippedFlips} interrupts flipped nothing`);
}

finish('M5 runtime register discipline');
void rd8;
