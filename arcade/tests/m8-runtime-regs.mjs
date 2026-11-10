"use strict";
// m8-runtime-regs.mjs -- runtime v4, register / interrupt discipline (the m6 / m7-runtime-regs.mjs method):
//  1. A real IM 1 interrupt is injected at EVERY instruction boundary executed in the ray code -- ray.asm / raybb.asm in ROM, the RST run switches,
//     the RAM routines (the row chain, the DDA loop, the generated multiplies) and the generated billboard rows -- and in the ray branches of main.asm /
//     api.asm / text.asm, while a ray game with billboards, VIEW, SETWALL, WALL, HIT and a sound effect runs.  The ISR runs to its RET; every register
//     (alternates, IX, IY), SP, I, IM and IFF1 must equal what they were (the chain runs with the alternate set active and its run records on the stack).
//  2. Chaos: extra interrupts at random instruction boundaries: the picture equals the model after every refresh, no write to the shown file.
//  3. Compiled code keeps IX, IY and the alternate registers across ray ticks (ray_render saves them).
//   node arcade/tests/m8-runtime-regs.mjs        (M8_QUICK=1: shorter)
import * as R from './m8-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { M, Z, hex, makeChecks, rd8, rd16, op } = R;

const QUICK = !!process.env.M8_QUICK;
const { check, finish } = makeChecks();
const S = R.runtime().syms;
console.log('Runtime v4: register discipline with injected interrupts\n');

const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl', 'sp', 'i', 'im', 'iff1'];
const snap = (cpu) => Object.fromEntries(KEYS.map((k) => [k, cpu[k]]));
const rec = (k) => [(60 + 3 * k) & 255, (((60 + 3 * k) >> 8) & 15) | ((15 - ((k >> 3) % 16)) << 4), (k % 31) | ((k % 4) << 5), 0];
const EFF = [Array.from({ length: 150 }, (_, k) => rec(k))];

function makeGame(nticks, seed, { div = 3, colw = 4 } = {}) {
  const r = rng(seed);
  const mw = 20, mh = 18, cells = R.randomCells(r, mw, mh, 0.12), map = R.loadMap(R.rleEncode(cells), mw, mh);
  const assets = [R.randomAsset(r, 16, 16, 1, 3), R.randomAsset(r, 32, 32, 1, 2), R.randomAsset(r, 8, 8, 1, 1)];
  const insts = [0, 1, 2, 0, 1];
  let pose = R.randomPose(r, map, mw, mh);
  const script = Array.from({ length: nticks }, (_, k) => {
    const t = [];
    pose = { x: Math.max(300, Math.min(mw * 256 - 300, pose.x + r.int(-60, 60))), y: Math.max(300, Math.min(mh * 256 - 300, pose.y + r.int(-60, 60))), a: (pose.a + r.int(-6, 6)) & 255 };
    t.push(op.view(pose.x, pose.y, pose.a));
    const cs = R.cosa8(pose.a), sn = R.sina8(pose.a);
    insts.forEach((_, i) => {
      const d = r.int(200, 1400), lat = r.int(-500, 500);
      t.push(op.showf(i, (pose.x + ((d * cs - lat * sn) >> 8)) & 0xFFFF, Math.max(0, pose.y + ((d * sn + lat * cs) >> 8)), (k + i) % 4));   // mostly in front
    });
    if (k % 3 === 0) t.push(op.setwall(r.int(256, (mw - 1) * 256), r.int(256, (mh - 1) * 256), r.int(0, 4)));
    t.push(op.wall(r.int(-300, 6000), r.int(-300, 6000)), op.hit(r.int(0, 4), r.int(0, 4)), op.fxmul(r.int(-30000, 30000), r.int(-300, 300)), op.cosa(k * 7), op.sina(k * 11), op.bbtab(k % 5));
    if (k === 0) t.push(op.play(0));
    if (k % 7 === 4) t.push(op.at(r.pick([0, 1, 22, 23]), r.int(0, 20)), op.prints('REGS ' + k));
    return t;
  });
  const spec = { div, view: { colw, mw, mh, cells }, assets, insts, sfx: EFF, tiles: randomTiles(r, 4), script };
  return { game: R.rayGame(spec), script, spec };
}
const romLabels = ['ray_check', 'in_image', 'ray_assets', 'ray_boot', 'ray_map', 'ray_tables', 'inc_div', 'inc_div8', 'ray_pat', 'ray_attrs', 'ray_tick', 'ray_mask_dirty', 'ray_render',
  'ray_setup', 'cos_t', 'mul_p', 'step_of', 'fx8', 'ray_cast', 'ray_one', 'dda_patch', 'axis', 'gen_muls', 'gen_mul', 'mul8x16', 'HITX', 'HITY', 'hit_c', 'rw_column', 'rw_go', 'rw_done',
  'ray_bb', 'bb_project', 'recip_a', 'tm_cs', 'tm_sn', 'abs_hl', 'bb_sort', 'bb_tx', 'bb_draw', 'bb_xc', 'mul8x16c', 'RT_VIEW', 'clamp_hl', 'RT_SINA', 'RT_COSA', 'cos_q', 'RT_FXMUL',
  'RT_WALL', 'map_addr', 'RT_SETWALL', 'show_ray', 'ray_hit', 'rh_get'].map((k) => [k, S[k]]).filter(([, a]) => a !== undefined).sort((a, b) => a[1] - b[1]);
const ranges = romLabels.map(([k, a], i) => [k, a, i + 1 < romLabels.length ? romLabels[i + 1][1] : S.M_RAY_E]);
ranges.push(['RST_EVEN', S.RST_EVEN, S.RST_EVEN + 11], ['RST_ODD', S.RST_ODD, S.RST_ODD + 11], ['RAM: the row chain', S.CHAIN, S.DDA], ['RAM: the DDA loop', S.DDA, S.RAY_RAM_END],
  ['RAM: the generated multiplies', S.RAY_MULXN, S.RAY_MUL_END], ['the generated billboard rows', S.RAY_BCODE, S.RAY_BCODE + S.RAY_BCODE_LEN],
  ['main: AFTER_FRAME', S.AFTER_FRAME, S.SKIP_CALL], ['api: show_f ray test', S.show_f, S.show_f + 7], ['api: show_w', S.show_w, S.show_w + 3], ['text: RT_HIT ray test', S.RT_HIT, S.RT_HIT + 7], ['text: hit_w', S.hit_w, S.hit_w + 3]);
const inRanges = (pc) => ranges.findIndex(([, a, b]) => pc >= a && pc < b);
const bootOnly = new Set(['ray_check', 'in_image', 'ray_assets', 'ray_boot', 'ray_map', 'ray_tables', 'inc_div', 'inc_div8', 'ray_pat', 'ray_attrs']);

// ---- 1. inject at every instruction boundary ------------------------------------------------------------------------------------
for (const colw of [4, 2]) {
  const { game } = makeGame(QUICK ? 14 : 24, 8001 + colw, { colw });
  const m = R.newMachine(game.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  let started = false, injections = 0, noReturn = 0;
  const violations = [], perPc = new Map(), hitRange = new Set();
  function injectAndCheck(pc0) {
    const cpu = m.cpu, t0 = m.tstates;
    const before = snap(cpu), varsBefore = Array.from(m.ram.slice(S.VARS, S.VARS + 0x100)), ffBefore = m.portFF, ayBefore = Array.from(m.ay.regs);
    KEYS.forEach((k, i) => { if (!['sp', 'i', 'im', 'iff1'].includes(k)) cpu[k] = (0x5A + 37 * i) & 0xFF; });
    const sent = snap(cpu);
    const stackBefore = Array.from(m.ram.slice(cpu.sp, cpu.sp + 24));
    Z.irqZ80(cpu, m.bus);
    let steps = 0;
    while (!(cpu.pc === pc0 && cpu.sp === before.sp) && steps < 800) { Z.runZ80(cpu, m.bus, 1, m); steps++; }
    if (steps >= 800) { noReturn++; return; }
    const after = snap(cpu);
    for (const k of KEYS) if (after[k] !== sent[k]) violations.push({ pc0, reg: k, before: sent[k], after: after[k] });
    if (Array.from(m.ram.slice(cpu.sp, cpu.sp + 24)).some((v, i) => v !== stackBefore[i])) violations.push({ pc0, reg: 'the stack above SP' });
    for (const k of KEYS) cpu[k] = before[k];
    for (let i = 0; i < varsBefore.length; i++) m.ram[S.VARS + i] = varsBefore[i];
    for (let i = 0; i < 16; i++) m.ay.regs[i] = ayBefore[i];
    m.portFF = ffBefore; m.tstates = t0;
    injections++;
  }
  for (let f = 0; f < (QUICK ? 60 : 130); f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      const cpu = m.cpu;
      if (cpu.pc === S.MAIN) started = true;
      if (started && cpu.iff1 && !cpu.halted && !cpu.eiDelay) {
        const pc = cpu.pc, k = inRanges(pc);
        if (k >= 0) { const n = (perPc.get(pc) ?? 0) + 1; perPc.set(pc, n); hitRange.add(k); if (n <= 3 || n % 40 === 0) injectAndCheck(pc); }
      }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  console.log(`1. colw ${colw}: interrupt injected at every instruction boundary executed in the ray code`);
  const missed = ranges.filter(([n], k) => !hitRange.has(k) && !bootOnly.has(n)).map(([n]) => n);
  check(`colw ${colw}: interrupts were injected in every part of the ray code that runs in play (${ranges.length - bootOnly.size} ranges)`, missed.length === 0 && injections > (QUICK ? 4000 : 9000),
    `${injections} injections at ${perPc.size} distinct addresses; not reached: ${missed.join(', ') || 'none'}`);
  check(`colw ${colw}: the injected ISR always returns to the interrupted instruction`, noReturn === 0, `${noReturn} did not return`);
  check(`colw ${colw}: registers, alternates, IX / IY, SP, I, IM, IFF1 and the stack above SP unchanged across every injected interrupt`, violations.length === 0,
    violations.length ? `${violations.length} changes, first: pc ${hex(violations[0].pc0)} ${violations[0].reg}` : `${injections} injections`);
  check(`colw ${colw}: the machine still runs in ray mode (ticks advanced, canary intact)`, rd8(m, S.V_RAY) === 1 && rd16(m, S.V_TICKS) > 4 && rd16(m, S.STACK_CANARY) === 0x5AA5, `V_TICKS ${rd16(m, S.V_TICKS)}`);
}

// ---- 2. chaos -------------------------------------------------------------------------------------------------------------------
for (const colw of [4, 2]) {
  console.log(`\n2. colw ${colw}: chaos, extra interrupts at random instruction boundaries`);
  const { game, script, spec } = makeGame(QUICK ? 14 : 30, 8011 + colw, { colw, div: colw === 4 ? 3 : 5 });
  const m = R.newMachine(game.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  const model = new R.Model8(spec);
  let seed = 4343 + colw;
  const rnd = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  let pending = null, started = false, extra = 0, extraIn = 0, writeViol = 0, ticksOk = true, lastTick = -1, picOk = 0, picBad = 0, spMin = 0xFFFF, firstBad = null;
  const snaps = [null, null];
  const origWrite = m.bus.write;
  m.bus.write = (addr, v) => { const a = addr & 0xFFFF, base = (m.portFF & 1) ? 0x6000 : 0x4000; if (started && a >= base && a < base + 0x1B00) writeViol++; origWrite(addr, v); };
  for (let f = 0; f < script.length * 10 + 60; f++) {
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
        model.renderTick();
        snaps[rd8(m, S.V_HIDDEN)] = model.clone();
      }
      if (started && cpu.iff1 && !cpu.halted && !cpu.eiDelay && rnd() < 1 / 250) { pending = { pc: cpu.pc, sp: cpu.sp }; if (inRanges(cpu.pc) >= 0) extraIn++; Z.irqZ80(cpu, m.bus); extra++; }
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
    if (rd16(m, S.V_FRAMES) > 3 && started) {
      const bit = m.portFF & 1, sn = snaps[bit];
      if (sn) { const exp = sn.render(), got = R.dfileOf(m, bit); const bad = R.diffCount(exp.bitmap, got.bitmap) + R.diffCount(exp.attrs, got.attrs); if (bad === 0) picOk++; else { picBad++; firstBad ??= { f, bad, bit }; } }
    }
  }
  check(`colw ${colw}: extra interrupts were taken throughout, most inside the ray code`, extra > 500 && extraIn > 300, `${extra} extra, ${extraIn} inside`);
  check(`colw ${colw}: the shown display file is never written`, writeViol === 0, `${writeViol} writes`);
  check(`colw ${colw}: ticks stay in order and none is lost`, ticksOk && lastTick >= script.length - 1, `${lastTick + 1} ticks`);
  check(`colw ${colw}: the picture equals the model after every refresh`, picBad === 0 && picOk > script.length, firstBad ? JSON.stringify(firstBad) : `${picOk} refreshes`);
  check(`colw ${colw}: stack inside $FB02..$FF00, canary intact`, rd16(m, S.STACK_CANARY) === 0x5AA5 && spMin >= S.STACK_LIMIT, `SP min ${hex(spMin)}`);
}

// ---- 3. IX, IY and the alternate set survive the ray tick ------------------------------------------------------------------------
{
  console.log('\n3. Compiled code keeps IX, IY and the alternates across ray ticks');
  const { game } = makeGame(QUICK ? 16 : 30, 8003, { div: 2 });
  const m = R.newMachine(game.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  const ALT = ['a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl'];
  let set = null, checked = 0, bad = 0, n = 0, bbTicks = 0;
  const fe = game.gsyms.frame_entry;
  for (let f = 0; f < (QUICK ? 90 : 160); f++) {
    const end = m.frameStart + M.tStatesPerFrame;
    while (m.tstates < end) {
      const cpu = m.cpu;
      if (cpu.pc === fe) { if (set) { checked++; if (ALT.some((k) => cpu[k] !== set[k])) bad++; } }
      if (cpu.pc === S.AFTER_FRAME) { n++; set = Object.fromEntries(ALT.map((k, i) => [k, (n * 29 + i * 53) & 0xFF])); Object.assign(cpu, set); }
      if (cpu.pc === S.RAY_BCODE) bbTicks++;
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  check('IX, IY, AF\', BC\', DE\', HL\' set after frame_entry are what the next frame_entry sees, in every ray tick (the chain, the DDA, billboards ran)', checked >= 10 && bad === 0 && bbTicks > 5,
    `${checked} ticks, ${bad} changed, ${bbTicks} billboard rows runs`);
}

finish('runtime v4, register discipline');
