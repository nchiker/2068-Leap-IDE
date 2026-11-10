"use strict";
// m7-runtime-regs.mjs -- runtime v3 part 2, register / interrupt discipline (the m6-runtime-regs.mjs method):
//  1. A real IM 1 interrupt is injected at EVERY instruction boundary executed in scroll.asm (the window tick: dirty mask, repaint, row loops, attribute
//     pass, sprites, ring repair; the routines compiled code calls: RT_CAMERA, RT_WORLDTILE / TILEFLAGS / TILEHIT / SETWORLD, SHOW and HIT in window
//     mode) and in the window branches of main.asm / api.asm / text.asm, while a window game with sprites crossing the window border, frames with cache
//     misses, collision queries, SETWORLD and a sound effect runs.  The ISR runs to its RET; every register (alternates, IX, IY), SP, I, IM and IFF1
//     must equal what they were.
//  2. Chaos: extra interrupts at random instruction boundaries: the picture equals the model after every refresh, no write to the shown file.
//  3. Compiled code keeps IX, IY and the alternate registers across ticks (window_repaint uses IX and saves it; fc_miss from win_draw_all).
//   node arcade/tests/m7-runtime-regs.mjs        (M7_QUICK=1: shorter)
import * as W from './m7-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { M, Z, hex, makeChecks, rd8, rd16, op } = W;

const QUICK = !!process.env.M7_QUICK;
const { check, finish } = makeChecks();
const S = W.runtime().syms;
console.log('Runtime v3 part 2: register discipline with injected interrupts\n');

const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl', 'sp', 'i', 'im', 'iff1'];
const snap = (cpu) => Object.fromEntries(KEYS.map((k) => [k, cpu[k]]));
const rec = (k) => [(60 + 3 * k) & 255, (((60 + 3 * k) >> 8) & 15) | ((15 - ((k >> 3) % 16)) << 4), (k % 31) | ((k % 4) << 5), 0];
const EFF = [Array.from({ length: 150 }, (_, k) => rec(k))];

function makeGame(nticks, seed, { div = 3 } = {}) {
  const r = rng(seed);
  const tiles = [...W.randomWinTiles(r, 32), ...randomTiles(r, 6)];
  tiles[1].attr = 0x0F; tiles[2].attr = 0x31;
  const ram = W.randomWorld(r, 128, 32, { sky: 0.6 });
  for (let y = 0; y < 16; y++) for (let x = 0; x < 128; x++) ram[y * 128 + x] = ram[y * 128 + (x & ~7)];
  const win = { cx: 4, cy: 3, worldW: 128, bands: [{ rows: 2, code: 1 }, { rows: 3, code: 2 }, { rows: 10, code: 3 }, { rows: 1, code: 4 }], ram, flags: Array.from({ length: 32 }, () => r.int(0, 255)) };
  const assets = [W.randomAsset(r, 16, 24, 4, 32), W.randomAsset(r, 8, 8, 8, 3), W.randomAsset(r, 32, 20, 4, 2), W.randomAsset(r, 24, 12, 2, 2)];
  const insts = [0, 1, 2, 3, 1, 0];
  const script = Array.from({ length: nticks }, () => []);
  let cam = 0;
  script.forEach((t, k) => {
    cam = Math.max(0, cam + r.int(-3, 8));
    t.push(op.camera(cam));
    for (let i = 0; i < 6; i++) {
      const edge = r.chance(0.5);
      const sx = edge ? r.pick([32, 224]) + r.int(-20, 4) : r.int(20, 220), sy = edge ? r.pick([24, 152]) + r.int(-30, 4) : r.int(10, 160);
      t.push(i === 5 ? op.showf(i, sx + cam - 32, sy - 24, ((k >> 1) * 7) % 32) : k % 4 === 0 || i > 0 ? op.showf(i, sx + cam - 32, sy - 24, (k >> 2) + i) : op.show(i, sx + cam - 32, sy - 24));
    }
    if (k % 3 === 0) t.push(op.setworld(r.int(0, 1023), r.int(0, 127), 1 + (k & 1)));
    t.push(op.tilehit(r.int(-30, 1050), r.int(-20, 140), r.int(1, 40), r.int(1, 40), r.int(0, 255)), op.tileflags(r.int(-30, 1050), r.int(-20, 140)), op.worldtile(r.int(0, 1023), r.int(0, 127)));
    t.push(op.hit(r.int(0, 5), r.int(0, 5)));
    if (k === 0) t.push(op.play(0));
    if (k % 9 === 4) t.push(op.at(r.pick([0, 1, 22, 23]), r.int(0, 20)), op.prints('REGS ' + k));
  });
  const spec = { div, tiles, win, assets, insts, sfx: EFF, script };
  return { game: W.winGame(spec), script, spec };
}
const labels = ['win_tick', 'win_mask_dirty', 'window_repaint', 'band_pos', 'rows_pn', 'rows_p0', 'attr_rows', 'win_draw_all', 'ring_repair', 'show_win', 'RT_CAMERA',
  'world_cell', 'RT_WORLDTILE', 'RT_TILEFLAGS', 'RT_SETWORLD', 'RT_TILEHIT', 'th_zero', 'win_hit', 'lt24', 'wbox', 'axis24'].map((k) => [k, S[k]]).sort((a, b) => a[1] - b[1]);
const ranges = labels.map(([k, a], i) => [k, a, i + 1 < labels.length ? labels[i + 1][1] : S.M_SCROLL_E]);
ranges.push(['main: AFTER_FRAME', S.AFTER_FRAME, S.SKIP_CALL], ['api: show_f window test', S.show_f, S.show_f + 7], ['api: show_w', S.show_w, S.show_w + 3], ['text: RT_HIT window test', S.RT_HIT, S.RT_HIT + 7], ['text: hit_w', S.hit_w, S.hit_w + 3]);
const inRanges = (pc) => ranges.findIndex(([, a, b]) => pc >= a && pc < b);

// ---- 1. inject at every instruction boundary ------------------------------------------------------------------------------------
{
  const { game } = makeGame(QUICK ? 40 : 50, 7001);
  const m = W.newMachine(game.dck);
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
  for (let f = 0; f < (QUICK ? 140 : 360); f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      const cpu = m.cpu;
      if (cpu.pc === S.MAIN) started = true;
      if (started && cpu.iff1 && !cpu.halted && !cpu.eiDelay) {
        const pc = cpu.pc, k = inRanges(pc);
        if (k >= 0) { const n = (perPc.get(pc) ?? 0) + 1; perPc.set(pc, n); hitRange.add(k); if (n <= 4 || n % 60 === 0) { inCode++; injectAndCheck(pc); } }
      }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  console.log('1. Interrupt injected at every instruction boundary executed in the window code');
  const missed = ranges.filter((_, k) => !hitRange.has(k)).map(([n]) => n);
  check(`interrupts were injected in every part of scroll.asm and the window branches (${ranges.length} ranges)`, missed.length === 0 && inCode > (QUICK ? 5000 : 15000),
    `${inCode} injections at ${perPc.size} distinct addresses; not reached: ${missed.join(', ') || 'none'}`);
  check('the cache was exercised from win_draw_all (frames built during play), and ring repair ran', rd16(m, S.FC_MISSES) > 5 && perPc.has(S.ring_repair + 0) && [...perPc.keys()].some((pc) => pc >= S.ring_repair && pc < S.show_win && perPc.get(pc) > 10),
    `${rd16(m, S.FC_MISSES)} misses`);
  check('the injected ISR always returns to the interrupted instruction', noReturn === 0, `${noReturn} did not return`);
  check('registers, alternates, IX / IY, SP, I, IM and IFF1 unchanged across every injected interrupt (flags included)', violations.length === 0,
    violations.length ? `${violations.length} changes, first: pc ${hex(violations[0].pc0)} ${violations[0].reg}` : `${injections} injections`);
  check('the machine still runs in window mode (ticks advanced, canary intact)', rd8(m, S.V_WIN) === 1 && rd16(m, S.V_TICKS) > 20 && rd16(m, S.STACK_CANARY) === 0x5AA5, `V_TICKS ${rd16(m, S.V_TICKS)}`);
}

// ---- 2. chaos -------------------------------------------------------------------------------------------------------------------
{
  console.log('\n2. Chaos: extra interrupts at random instruction boundaries');
  const { game, script, spec } = makeGame(QUICK ? 30 : 50, 7002);
  const m = W.newMachine(game.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  const model = new W.Model7(spec);
  let seed = 4343;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let pending = null, started = false, extra = 0, extraIn = 0, writeViol = 0, ticksOk = true, lastTick = -1, picOk = 0, picBad = 0, spMin = 0xFFFF, firstBad = null;
  const snaps = [null, null];
  const origWrite = m.bus.write;
  m.bus.write = (addr, v) => { const a = addr & 0xFFFF, base = (m.portFF & 1) ? 0x6000 : 0x4000; if (started && a >= base && a < base + 0x1B00) writeViol++; origWrite(addr, v); };
  for (let f = 0; f < script.length * 4 + 60; f++) {
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
      if (started && cpu.iff1 && !cpu.halted && !cpu.eiDelay && rnd() < 1 / 250) { pending = { pc: cpu.pc, sp: cpu.sp }; if (inRanges(cpu.pc) >= 0) extraIn++; Z.irqZ80(cpu, m.bus); extra++; }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
    if (rd16(m, S.V_FRAMES) > 3 && started) {
      const bit = m.portFF & 1, sn = snaps[bit];
      if (sn) { const exp = sn.render(), got = W.dfileOf(m, bit); const bad = W.diffCount(exp.bitmap, got.bitmap) + W.diffCount(exp.attrs, got.attrs); if (bad === 0) picOk++; else { picBad++; firstBad ??= { f, bad, bit }; } }
    }
  }
  check('extra interrupts were taken throughout, many inside the window code', extra > 1000 && extraIn > 500, `${extra} extra, ${extraIn} inside`);
  check('the shown display file is never written', writeViol === 0, `${writeViol} writes`);
  check('ticks stay in order and none is lost', ticksOk && lastTick >= script.length - 1, `${lastTick + 1} ticks`);
  check('the picture equals the model after every refresh', picBad === 0 && picOk > script.length, firstBad ? JSON.stringify(firstBad) : `${picOk} refreshes`);
  check('stack inside $FB02..$FF00, canary intact', rd16(m, S.STACK_CANARY) === 0x5AA5 && spMin >= S.STACK_LIMIT, `SP min ${hex(spMin)}`);
}

// ---- 3. IX, IY and the alternate set survive the window tick ---------------------------------------------------------------------
{
  console.log('\n3. Compiled code keeps IX, IY and the alternates across window ticks (repaint with IX, cache misses)');
  const { game } = makeGame(QUICK ? 30 : 50, 7003, { div: 2 });
  const m = W.newMachine(game.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  const ALT = ['a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl'];
  let set = null, checked = 0, bad = 0, missesBetween = 0, missAt = 0, n = 0;
  const fe = game.gsyms.frame_entry;
  for (let f = 0; f < (QUICK ? 100 : 220); f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      const cpu = m.cpu;
      if (cpu.pc === fe) {
        if (set) { checked++; if (ALT.some((k) => cpu[k] !== set[k])) bad++; if (rd16(m, S.FC_MISSES) > missAt) missesBetween++; }
        missAt = rd16(m, S.FC_MISSES);
      }
      if (cpu.pc === S.AFTER_FRAME) {                             // frame_entry has returned: "compiled code" leaves its values
        n++; set = Object.fromEntries(ALT.map((k, i) => [k, (n * 29 + i * 53) & 0xFF]));
        Object.assign(cpu, set);
      }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  check('IX, IY, AF\', BC\', DE\', HL\' set after frame_entry are what the next frame_entry sees, in every window tick', checked >= 10 && bad === 0, `${checked} ticks, ${bad} changed`);
  check('...including ticks in which win_draw_all built frames into the cache', missesBetween > 3, `${missesBetween} ticks with misses`);
}

finish('runtime v3 part 2, register discipline');
