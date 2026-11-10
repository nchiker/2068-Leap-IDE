"use strict";
// m6-runtime-regs.mjs -- runtime v3 part 1, register / interrupt discipline of the new and changed code (the m5-runtime-regs.mjs style):
//  1. A real IM 1 interrupt is injected at EVERY instruction boundary executed in draw_all (main.asm), the blitters and the erase (sprite.asm),
//     the frame cache at run time (fc_miss, build_frame, prot_bit: assets.asm), RT_SHOW / RT_SHOWF / RT_HIDE (api.asm), the skip analysis
//     (skip.asm) and hit_box (text.asm), while a scene with every sprite width, frames, cache misses, the skip and a sound effect runs.  The ISR
//     runs to its RET; every register (alternates, IX, IY), SP, I, IM and IFF1 must equal what they were; the ISR's writes are undone.
//  2. Chaos: extra interrupts at random instruction boundaries (about one per 300 instructions, many inside the new code): the picture equals
//     the model after every refresh, no write to the shown file, ticks in order, the stack inside its area.
//  3. Compiled code keeps IX, IY and the alternate registers across ticks: after every frame_entry they are set to random values, and the
//     next frame_entry sees them unchanged although draw_all built frames (fc_miss saves them) in between.
//   node arcade/tests/m6-runtime-regs.mjs        (M6_QUICK=1: shorter)
import * as C from './m6-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { M, Z, FRAME_T, hex, makeChecks, rd8, rd16, op } = C;

const QUICK = !!process.env.M6_QUICK;
const { check, finish } = makeChecks();
const S = C.runtime().syms;
console.log('Runtime v3 part 1: register discipline with injected interrupts\n');

const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl', 'sp', 'i', 'im', 'iff1'];
const snap = (cpu) => Object.fromEntries(KEYS.map((k) => [k, cpu[k]]));
const rec = (k) => [(60 + 3 * k) & 255, (((60 + 3 * k) >> 8) & 15) | ((15 - ((k >> 3) % 16)) << 4), (k % 31) | ((k % 4) << 5), 0];
const EFF = [Array.from({ length: 170 }, (_, k) => rec(k))];         // (the test image has 704 bytes of effects: 170 records play for 170 refreshes)

/** A scene: 12 instances of 6 assets (every width, a cache-mode asset), random walks with frames, static ones (the skip runs), an effect. */
function makeGame(nticks, seed, { div = 1 } = {}) {
  const r = rng(seed);
  const assets = [C.randomAsset(r, 16, 24, 4, 32), C.randomAsset(r, 8, 8, 8, 3), C.randomAsset(r, 24, 12, 2, 2), C.randomAsset(r, 32, 20, 4, 2), C.randomAsset(r, 16, 16, 8, 1), C.randomAsset(r, 8, 30, 1, 2)];
  assets[1].hot = [1, 1, 5, 6];
  const insts = [0, 1, 2, 3, 4, 5, 0, 1, 4, 4, 4, 4];
  const nfs = insts.map((a) => C.normAsset(assets[a]).nf);
  const script = Array.from({ length: nticks }, () => []);
  C.addWalk(script, 6, r, { frames: nfs.slice(0, 6), frameRate: 0.5 });
  script.forEach((t, k) => {
    for (let i = 6; i < 12; i++) t.push(k % 13 === 7 && i === 6 ? op.showf(i, 30 + 3 * k, 150, k % 32) : op.show(i, 20 + 37 * (i - 6), 40 + 9 * i));   // still ones (the skip)
    if (k % 3 === 0) t.push(op.hit(r.int(0, 11), r.int(0, 11)));
    if (k === 0) t.push(op.play(0));
    if (k % 11 === 5) t.push(op.at(r.int(0, 23), 0), op.prints('REGS ' + k));
  });
  const spec = { div, assets, insts, tiles: randomTiles(rng(61), 5), sfx: EFF, script };
  return { game: C.scriptGame(spec), script };
}
const ranges = [['main (draw_all)', S.draw_all, S.M_MAIN_E], ['sprite.asm', S.M_SPRITE_S, S.M_SPRITE_E], ['assets.asm (run time)', S.build_frame, S.M_ASSETS_E],
  ['api.asm (RT_SHOW/F, HIDE)', S.RT_SHOWF, S.RT_MUL], ['skip.asm', S.M_SKIP_S, S.M_SKIP_E], ['hit_box', S.hit_box, S.M_TEXT_E]];
const inRanges = (pc) => ranges.findIndex(([, a, b]) => pc >= a && pc < b);

// ---- 1. inject at every instruction boundary of the new code -----------------------------------------------------------------
{
  const { game } = makeGame(QUICK ? 40 : 120, 6001, { div: 2 });
  const m = C.newMachine(game.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  let started = false, injections = 0, noReturn = 0, inCode = 0;
  const violations = [], perPc = new Map(), hitRange = new Set();
  function injectAndCheck(pc0) {
    const cpu = m.cpu, t0 = m.tstates;
    const before = snap(cpu), varsBefore = Array.from(m.ram.slice(S.VARS, S.VARS + 0x100)), ffBefore = m.portFF, ayBefore = Array.from(m.ay.regs);
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
    m.portFF = ffBefore; m.tstates = t0;
    injections++;
  }
  for (let f = 0; f < (QUICK ? 100 : 300); f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      const cpu = m.cpu;
      if (cpu.pc === S.MAIN) started = true;
      if (started && cpu.iff1 && !cpu.halted && !cpu.eiDelay) {
        const pc = cpu.pc, k = inRanges(pc);
        if (k >= 0) { const n = (perPc.get(pc) ?? 0) + 1; perPc.set(pc, n); hitRange.add(k); if (n <= 6 || n % 40 === 0) { inCode++; injectAndCheck(pc); } }
      }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  console.log('1. Interrupt injected at every instruction boundary executed in the new / changed code');
  check(`interrupts were injected in every changed module (${ranges.map(([n]) => n).join(', ')})`, hitRange.size === ranges.length && inCode > (QUICK ? 3000 : 10000),
    `${inCode} injections at ${perPc.size} distinct addresses; modules hit: ${[...hitRange].map((k) => ranges[k][0]).join(', ')}`);
  check('the cache was exercised (frames built during play) and every builder width ran', rd16(m, S.FC_MISSES) > 10 && [S.bf_w1, S.bf_w2, S.bf_w3, S.bf_w4].filter((a) => perPc.has(a)).length >= 2,
    `${rd16(m, S.FC_MISSES)} misses; builders entered: ${[S.bf_w1, S.bf_w2, S.bf_w3, S.bf_w4].map((a) => perPc.has(a) ? 1 : 0).join('')}`);
  check('the injected ISR always returns to the interrupted instruction', noReturn === 0, `${noReturn} did not return`);
  check('registers, alternates, IX / IY, SP, I, IM and IFF1 unchanged across every injected interrupt (flags included)', violations.length === 0,
    violations.length ? `${violations.length} changes, first: pc ${hex(violations[0].pc0)} ${violations[0].reg}` : `${injections} injections`);
  check('the machine still runs (ticks advanced, canary intact)', rd16(m, S.V_TICKS) > 20 && rd16(m, S.STACK_CANARY) === 0x5AA5, `V_TICKS ${rd16(m, S.V_TICKS)}`);
}

// ---- 2. chaos -------------------------------------------------------------------------------------------------------------------
{
  console.log('\n2. Chaos: extra interrupts at random instruction boundaries');
  const { game, script } = makeGame(QUICK ? 30 : 80, 6002, { div: 2 });
  const m = C.newMachine(game.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  const model = new C.Model6(game.spec);
  let seed = 4343;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let pending = null, started = false, extra = 0, extraIn = 0, writeViol = 0, ticksOk = true, lastTick = -1, picOk = 0, picBad = 0, spMin = 0xFFFF, firstBad = null;
  const snaps = [null, null];
  const origWrite = m.bus.write;
  m.bus.write = (addr, v) => { const a = addr & 0xFFFF, base = (m.portFF & 1) ? 0x6000 : 0x4000; if (started && a >= base && a < base + 0x1B00) writeViol++; origWrite(addr, v); };
  for (let f = 0; f < script.length * 2 + 40; f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      const cpu = m.cpu;
      const resumed = pending && cpu.pc === pending.pc && cpu.sp === pending.sp;
      if (resumed) pending = null;
      if (cpu.pc === S.MAIN) started = true;
      if (cpu.sp < spMin) spMin = cpu.sp;
      if (cpu.pc === S.TICK_REQUEST && !resumed) {
        const n = rd16(m, S.V_TICKS) - 1;
        if (n !== lastTick + 1) ticksOk = false;
        lastTick = n;
        for (const o of script[n] ?? []) model.apply(o);
        snaps[rd8(m, S.V_HIDDEN)] = model.clone();
      }
      if (started && cpu.iff1 && !cpu.halted && !cpu.eiDelay && rnd() < 1 / 300) { pending = { pc: cpu.pc, sp: cpu.sp }; if (inRanges(cpu.pc) >= 0) extraIn++; Z.irqZ80(cpu, m.bus); extra++; }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
    if (rd16(m, S.V_FRAMES) > 3 && started) {
      const bit = m.portFF & 1, sn = snaps[bit];
      if (sn) { const exp = sn.render(), got = C.dfileOf(m, bit); const bad = C.diffCount(exp.bitmap, got.bitmap) + C.diffCount(exp.attrs, got.attrs); if (bad === 0) picOk++; else { picBad++; firstBad ??= { f, bad, bit }; } }
    }
  }
  check('extra interrupts were taken throughout, many inside the new code', extra > 1000 && extraIn > 300, `${extra} extra, ${extraIn} inside`);
  check('the shown display file is never written', writeViol === 0, `${writeViol} writes`);
  check('ticks stay in order and none is lost', ticksOk && lastTick >= script.length - 1, `${lastTick + 1} ticks`);
  check('the picture equals the model after every refresh', picBad === 0 && picOk > script.length, firstBad ? JSON.stringify(firstBad) : `${picOk} refreshes`);
  check('stack inside $FB02..$FF00, canary intact', rd16(m, S.STACK_CANARY) === 0x5AA5 && spMin >= S.STACK_LIMIT, `SP min ${hex(spMin)}`);
}

// ---- 3. IX, IY and the alternate set survive the runtime's tick work ---------------------------------------------------------------
{
  console.log('\n3. Compiled code keeps IX, IY and the alternates across ticks (cache misses in between)');
  const { game } = makeGame(QUICK ? 30 : 80, 6003, { div: 1 });
  const m = C.newMachine(game.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  const ALT = ['a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl'];
  let set = null, checked = 0, bad = 0, missesBetween = 0, missAt = 0, n = 0;
  const fe = game.gsyms.frame_entry;
  for (let f = 0; f < (QUICK ? 40 : 100); f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      const cpu = m.cpu;
      if (cpu.pc === fe) {
        if (set) { checked++; if (ALT.some((k) => cpu[k] !== set[k])) bad++; if (rd16(m, S.FC_MISSES) > missAt) missesBetween++; }
        missAt = rd16(m, S.FC_MISSES);
      }
      if (cpu.pc === S.SKIP_CALL) {                               // frame_entry has returned: "compiled code" leaves its values
        n++; set = Object.fromEntries(ALT.map((k, i) => [k, (n * 29 + i * 53) & 0xFF]));
        Object.assign(cpu, set);
      }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  check('IX, IY, AF\', BC\', DE\', HL\' set after frame_entry are what the next frame_entry sees, in every tick', checked >= 6 && bad === 0, `${checked} ticks, ${bad} changed`);
  check('...including the ticks in which draw_all built frames into the cache (fc_miss uses IX, IY and the alternate set)', missesBetween > 5, `${missesBetween} ticks with misses`);
}

finish('runtime v3 part 1, register discipline');
void FRAME_T;
