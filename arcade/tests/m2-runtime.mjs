"use strict";
// m2-runtime.mjs -- milestone M2 runtime test: boots the v0 runtime with a game image on a stock TS2068 (TSRun) and checks the
// contract of docs/ARCADE_RUNTIME_API.md: boot, the game header, frame_div, V_TICKS, the sprite state table, the picture of two
// overlapping sprites, tearing, an overrunning frame_entry, the stack and the variable areas.  Every instruction is observed.
//   node arcade/tests/m2-runtime.mjs
// The runtime and the games are rebuilt first.  Companion tests: m2-runtime-math.mjs (RT_MUL / DIV / MOD / RND / SHOW / HIDE /
// STICK), m2-runtime-regs.mjs (interrupt injection at every instruction of the frame loop).
import { printUsage } from '../tools/build-runtime.mjs';
import * as C from './m2-runtime-common.mjs';
const { M, Z, FRAME_T, FIRST_PIXEL_T, hex, makeChecks, rd8, rd16, int16, clamp } = C;

const { check, finish } = makeChecks();
const rt = C.runtime();
console.log('M2 runtime test: Leap Arcade runtime v0 on a stock TS2068 (TSRun)\n');
printUsage(rt.usage, rt.dck);
console.log('');

/**
 * Boot `game` and observe `nframes` frames, every instruction.  Returns everything the checks need.
 * @param opts  model: compare against a JavaScript model (default for test games); heights: the sprites' heights, from the
 *   assembled game's `ball` / `box` data in this order; calls(n, r1, r2): the RT_SHOW / RT_HIDE calls the game makes in tick n;
 *   usesRnd: the game calls RT_RND twice per tick (r1, r2)
 */
function observe(game, nframes, { model = true, kinds = ['ball', 'box'], calls: callsModel = C.gameCalls, usesRnd = true } = {}) {
  const S = game.syms, GS = game.gsyms;
  const m = C.newMachine(game.dck);
  // run (unobserved) until the cartridge entry; from there every instruction is hooked, so tick 0 is seen
  let entryFrame = -1;
  for (let f = 1; f <= 400; f++) { M.runFrame(m); if (rd16(m, S.HO_MARK) === 0x5AA5) { entryFrame = f; break; } }
  const boot = { entryFrame, bootFrames: 0 };
  const st = {
    m, boot, S, frames: [], ticks: [], isr: [], work: [], writeViolations: 0, spMin: 0xFFFF, spMax: 0, imBad: 0,
    flipWrites: [], tabBad: 0, callBad: [], seedBad: 0, snapshots: [null, null], pictureBad: 0, pictureOk: 0, unreadable: 0,
    overlapFrames: 0, firstPictureBad: null, regsBad: 0, iregs: null, eraseT: [], drawT: [], entryChecked: false,
    gameVarsDirty: 0, magicBad: 0, spans: [], skippedFlips: 0, flipMismatch: 0, shadowBad: 0, missed: 0, prevBit: m.portFF & 1,
  };
  const sprites = model ? kinds.map((k) => ({ rows: C.spriteRows(game.bytes, GS[k], k === 'ball' ? 16 : 12) })) : [];
  // JS model state
  let rnd = 0xACE1;
  const state = sprites.map(() => ({ visible: false, x: 0, y: 0 }));
  let calls = [], inFrame = false;
  let isrT0 = 0, inIsr = false, isrAcc = 0, isrSync = 0, workT0 = -1, workIsr0 = 0, tickStart = null;
  let ffWrites = [];
  const origOut = m.bus.ioWrite;
  m.bus.ioWrite = (port, v) => { if ((port & 0xFF) === 0xFF) ffWrites.push({ rel: m.tstates - m.frameStart, v }); origOut(port, v); };
  const origWrite = m.bus.write;
  m.bus.write = (addr, v) => {                                    // the displayed file's bitmap and attributes must never be written
    const a = addr & 0xFFFF;
    const base = (m.portFF & 1) ? 0x6000 : 0x4000;
    if (armed && a >= base && a < base + 0x1B00) st.writeViolations++;
    origWrite(addr, v);
  };
  const ISR = S.ISR, ISR_END = S.ISR_END, WS = S.WORK_START, WE = S.WORK_END, TR = S.TICK_REQUEST;
  const spans = [];   // { name, start, sp, ret, t0, i0 }
  const trackers = [[S.erase_all, 'erase'], [S.draw_all, 'draw']];
  let firstEntry = true;
  let armed = false;                                              // the write guard starts when boot is over (MAIN)
  function hook() {
    const cpu = m.cpu, pc = cpu.pc, sp = cpu.sp;
    if (pc === S.MAIN) armed = true;
    if (sp < st.spMin) st.spMin = sp;
    if (sp > st.spMax) st.spMax = sp;
    if (pc >= ISR && pc < ISR_END) {
      if (!inIsr) { inIsr = true; isrT0 = m.tstates - 13; isrSync = rd8(m, S.V_SYNC); }
    } else if (inIsr) { inIsr = false; st.isr.push(m.tstates - isrT0); isrAcc += m.tstates - isrT0; }
    for (const [addr, name] of trackers) {
      if (pc === addr && !inIsr) spans.push({ name, sp, ret: rd16(m, sp), t0: m.tstates, i0: isrAcc });
    }
    for (let k = spans.length - 1; k >= 0; k--) {
      const s = spans[k];
      if (pc === s.ret && sp === s.sp + 2 && !inIsr) {
        (s.name === 'erase' ? st.eraseT : st.drawT).push(m.tstates - s.t0 - (isrAcc - s.i0));
        spans.splice(k, 1);
      }
    }
    if (pc === WS) {
      workT0 = m.tstates; workIsr0 = isrAcc;
      if (!(cpu.im === 1 && cpu.iff1)) st.imBad++;
      const regs = [cpu.xh, cpu.xl, cpu.yh, cpu.yl, cpu.a2, cpu.f2, cpu.b2, cpu.c2, cpu.d2, cpu.e2, cpu.h2, cpu.l2].join(',');
      if (st.iregs === null) st.iregs = regs; else if (regs !== st.iregs) st.regsBad++;
      tickStart = { n: rd16(m, S.V_TICKS), frames: rd16(m, S.V_FRAMES), hidden: null };
      inFrame = true; calls = [];
      if (firstEntry) {                                           // the compiled-variable area is zero when the game starts
        firstEntry = false;
        let dirty = 0;
        for (let a = S.GAME_VARS_BASE; a <= S.GAME_VARS_LIMIT; a++) {
          if (rd8(m, a) !== 0 && !(model && (a === S.GAME_VARS_BASE || a === S.GAME_VARS_BASE + 1 || a === S.GAME_VARS_LIMIT - 1 || a === S.GAME_VARS_LIMIT))) dirty++;
        }
        st.gameVarsDirty = dirty;
      }
    }
    if (pc === S.RT_SHOW) {
      const rec = { op: 'show', i: cpu.a, x: int16((cpu.b << 8) | cpu.c), y: int16((cpu.d << 8) | cpu.e) };
      if (inFrame) calls.push(rec);
      applyCall(rec);
    } else if (pc === S.RT_HIDE) {
      const rec = { op: 'hide', i: cpu.a };
      if (inFrame) calls.push(rec);
      applyCall(rec);
    }
    if (pc === TR && tickStart) {
      const n = rd16(m, S.V_TICKS) - 1, hidden = rd8(m, S.V_HIDDEN);
      st.ticks.push({ n, frames: tickStart.frames, hidden, startTick: tickStart.n });
      if (model) {
        // the calls the game made against the model of test_game.asm
        let r1 = 0, r2 = 0;
        if (usesRnd) { r1 = (rnd = C.rndStep(rnd)) & 0x7FFF; r2 = (rnd = C.rndStep(rnd)) & 0x7FFF; }
        const want = callsModel(n, r1, r2);
        const same = calls.length === want.length && want.every((w, k) => calls[k].op === w.op && calls[k].i === w.i && (w.op === 'hide' || (calls[k].x === w.x && calls[k].y === w.y)));
        if (!same) st.callBad.push({ n, got: calls, want });
        if (usesRnd && rd16(m, S.RT_SEED) !== rnd) st.seedBad++;
        // SPR_TAB agrees with what the game SHOWed / HID (clamped)
        for (let i = 0; i < state.length; i++) {
          const e = S.SPR_TAB + i * 6;
          const ok = rd8(m, e) === (state[i].visible ? 1 : 0) && rd8(m, e + 1) === 0 &&
            (!state[i].visible || (rd16(m, e + 2) === state[i].x && rd16(m, e + 4) === state[i].y));
          if (!ok) st.tabBad++;
        }
        st.snapshots[hidden] = { n, sprites: state.map((s, i) => ({ visible: s.visible, x: s.x, y: s.y, rows: sprites[i].rows })) };
      }
      inFrame = false;
    }
    if (pc === WE && workT0 >= 0) { st.work.push(m.tstates - workT0 - (isrAcc - workIsr0)); st.spans.push(rd16(m, S.V_FRAMES) - tickStart.frames); workT0 = -1; }
  }
  function applyCall(rec) {
    if (rec.i >= state.length) return;
    if (rec.op === 'hide') state[rec.i].visible = false;
    else state[rec.i] = { visible: true, x: clamp(rec.x, 239), y: clamp(rec.y, 176) };
  }

  let prevFrames = rd16(m, S.V_FRAMES);
  for (let f = 0; st.frames.length < nframes && f < nframes + 100; f++) {
    ffWrites = [];
    const end = m.frameStart + FRAME_T;
    while (m.tstates < end) {
      if (m.cpu.halted) break;
      hook();
      Z.runZ80(m.cpu, m.bus, 1, m);
    }
    M.runFrame(m);
    const fr = rd16(m, S.V_FRAMES);
    if (fr === 0 || prevFrames === 0) {                            // boot still runs with interrupts off: nothing to compare yet
      if (fr === 0) st.boot.bootFrames++;
      prevFrames = fr; st.prevBit = m.portFF & 1; continue;
    }
    if (((fr - prevFrames) & 0xFFFF) !== 1) st.missed++;
    prevFrames = fr;
    const bit = m.portFF & 1;
    const flipped = bit !== st.prevBit;
    if ((isrSync >= 2) !== flipped) st.flipMismatch++;
    if (isrSync === 0) st.skippedFlips++;
    if (ffWrites.length > 0) st.flipWrites.push(ffWrites[0].rel);
    if (m.portFF !== rd8(m, S.V_SHADOW_FF)) st.shadowBad++;
    st.prevBit = bit;
    st.frames.push({ bit, flipped });
    // the picture of the frame just completed = the displayed file's last complete snapshot
    const shown = C.shownPlane(m);
    if (shown === null || shown.includes(2)) { st.unreadable++; st.pictureBad++; continue; }
    const snap = model ? st.snapshots[bit] : null;
    const exp = C.expectedPlane(snap ? snap.sprites : []);
    let bad = 0;
    for (let i = 0; i < exp.length; i++) if (exp[i] !== shown[i]) bad++;
    if (bad === 0) st.pictureOk++; else { st.pictureBad++; st.firstPictureBad ??= { frame: f, bad, tick: snap?.n, file: bit + 1 }; }
    if (snap && snap.sprites.length >= 2 && snap.sprites[0].visible && snap.sprites[1].visible) {
      const a = snap.sprites[0], b = snap.sprites[1];
      if (Math.abs(a.x - b.x) < 16 && Math.abs(a.y - b.y) < 12) st.overlapFrames++;
    }
  }
  st.finalMagic = [rd16(m, S.GAME_VARS_BASE), rd16(m, S.GAME_VARS_LIMIT - 1)];
  st.canary = rd16(m, S.STACK_CANARY);
  st.finalTicks = rd16(m, S.V_TICKS);
  st.finalFrames = rd16(m, S.V_FRAMES);
  return st;
}

const avg = (a) => a.reduce((s, v) => s + v, 0) / (a.length || 1);

// ==================================================================================================================
// 1. The runtime alone (placeholder game image: init and frame are RET, 0 sprites)
// ==================================================================================================================
console.log('1. Boot and the runtime alone (placeholder game: 0 sprites)');
{
  const g = C.placeholderGame();
  const S = g.syms;
  const m0 = C.newMachine(g.dck);
  let entryFrame = -1;
  for (let f = 1; f <= 400; f++) { M.runFrame(m0); if (rd16(m0, S.HO_MARK) === 0x5AA5) { entryFrame = f; break; } }
  check('the cartridge entry is reached from reset, about 103 frames (98..110)', entryFrame >= 98 && entryFrame <= 110, `frame ${entryFrame}`);
  check('hand-off: interrupts enabled (IFF2 = 1), $F4 = $43, $FF = $00, SP = $61FE',
    rd8(m0, S.HO_IFF) === 1 && rd8(m0, S.HO_F4) === 0x43 && rd8(m0, S.HO_FF) === 0 && rd16(m0, S.HO_SP) === 0x61FE,
    `IFF ${rd8(m0, S.HO_IFF)} F4 ${hex(rd8(m0, S.HO_F4), 2)} FF ${hex(rd8(m0, S.HO_FF), 2)} SP ${hex(rd16(m0, S.HO_SP))}`);
  const st = observe(g, 300, { model: false });
  check('after boot: $F4 = $33, shadow agrees; $FF bit 7 = 0 (DOCK), bit 6 = 0 (interrupt on)',
    st.m.portF4 === 0x33 && rd8(st.m, S.V_SHADOW_F4) === 0x33 && (st.m.portFF & 0xC0) === 0, `F4 ${hex(st.m.portF4, 2)} FF ${hex(st.m.portFF, 2)}`);
  check('boot (display files, tables, DI) finishes within 12 frames of the entry', st.boot.bootFrames <= 12, `${st.boot.bootFrames} frames`);
  check('frame counter advances exactly once per refresh for 300 frames', st.missed === 0, `${st.missed} frames off`);
  check('ticks advance with frame_div 1: one tick per refresh (+-1)', Math.abs(st.finalTicks - st.finalFrames) <= 1, `V_TICKS ${st.finalTicks}, V_FRAMES ${st.finalFrames}`);
  check('the picture is the bare background in every frame (no sprites declared)', st.pictureOk === 300 && st.pictureBad === 0, `${st.pictureOk}/300`);
  check('the displayed file alternates every refresh (ticks flip every frame)', st.frames.slice(5).every((f) => f.flipped));
  check('boot zeroed the compiled-variable area $E100-$EFFF', st.gameVarsDirty === 0, `${st.gameVarsDirty} non-zero bytes`);
  check('stack canary intact; SP stays within $F002..$FF00', st.canary === 0x5AA5 && st.spMin >= S.STACK_CANARY + 2 && st.spMax <= S.STACK_TOP, `SP ${hex(st.spMin)}..${hex(st.spMax)}`);
  const w = st.work;
  console.log(`  loop overhead with 0 sprites (WORK_START..WORK_END, ISR excluded): min ${Math.min(...w)}  avg ${avg(w).toFixed(0)}  max ${Math.max(...w)} T (${(100 * avg(w) / FRAME_T).toFixed(2)} % of a frame)`);
  console.log(`  ISR ${Math.min(...st.isr)}..${Math.max(...st.isr)} T; erase_all (0 sprites) ${Math.round(avg(st.eraseT))} T, draw_all ${Math.round(avg(st.drawT))} T`);
}

// ==================================================================================================================
// 2. The test game, frame_div 1 and 3
// ==================================================================================================================
function gameChecks(label, st, game, div, nframes) {
  const S = game.syms, GS = game.gsyms;
  console.log(`\n${label}`);
  check('the game header was read: frame_div, sprite_count, heights', rd8(st.m, S.V_DIV) === div && rd8(st.m, S.V_SPRN) === 2 &&
    rd8(st.m, S.SPR_HGT) === 16 && rd8(st.m, S.SPR_HGT + 1) === 12, `div ${rd8(st.m, S.V_DIV)} sprites ${rd8(st.m, S.V_SPRN)} heights ${rd8(st.m, S.SPR_HGT)},${rd8(st.m, S.SPR_HGT + 1)}`);
  check(`frame counter advances exactly once per refresh for ${nframes} frames`, st.missed === 0, `${st.missed} off`);
  const gaps = st.ticks.slice(1).map((t, k) => t.frames - st.ticks[k].frames);
  const expectedTicks = Math.floor(nframes / div);
  check(`ticks advance every frame_div (${div}) refreshes: ${expectedTicks} +-1 ticks after ${nframes} frames`, Math.abs(st.finalTicks - expectedTicks) <= 2,
    `V_TICKS ${st.finalTicks}`);
  check(`every tick starts exactly ${div} refresh${div > 1 ? 'es' : ''} after the previous one`, gaps.length > 20 && gaps.every((g) => g === div),
    `gaps ${[...new Set(gaps)].join(',')}`);
  check('V_TICKS during frame_entry counts 0, 1, 2, ... (tick n sees n)', st.ticks.every((t, k) => t.startTick === k && t.n === k));
  check('the calls frame_entry made equal the JS model of the game (RT_MUL / DIV / MOD / RND, clamps, hide), every tick',
    st.callBad.length === 0 && st.seedBad === 0, st.callBad.length ? JSON.stringify(st.callBad[0]) : `${st.ticks.length} ticks, RT_SEED tracked ${st.seedBad === 0}`);
  check('the sprite state table equals what the game SHOWed / HID (clamped) at the end of every tick', st.tabBad === 0, `${st.tabBad} mismatches in ${st.ticks.length} ticks`);
  check('the displayed picture equals the expected composition of the 2 sprites in 100 % of frames',
    st.pictureOk === nframes && st.pictureBad === 0, st.firstPictureBad ? JSON.stringify(st.firstPictureBad) : `${st.pictureOk}/${nframes}`);
  check('the sprites overlap in most sampled frames (the overlap case is really tested)', st.overlapFrames >= 0.6 * nframes / div, `${st.overlapFrames} of ${nframes} frames`);
  check('no tearing: no instruction ever writes the displayed file', st.writeViolations === 0, `${st.writeViolations} writes`);
  check('every flip request is honoured at the next interrupt and nowhere else (display changes iff V_SYNC >= 2 at the ISR)', st.flipMismatch === 0 && st.shadowBad === 0, `${st.flipMismatch} mismatches`);
  check('the flip (OUT $FF) executes before the first pixel line', st.flipWrites.length > 0 && Math.max(...st.flipWrites) < FIRST_PIXEL_T,
    `${st.flipWrites.length} flips, latest ${Math.max(...st.flipWrites)} T after the interrupt (first pixel ${FIRST_PIXEL_T})`);
  check('interrupt mode 1 and interrupts enabled whenever a tick starts', st.imBad === 0 && st.work.length > 0, `${st.imBad} violations`);
  check('IX, IY and the alternate set are never touched by the frame loop or the ISR (same at every tick start)', st.regsBad === 0);
  check('the compiled-variable area: boot zeroed it, the runtime never wrote it (game words intact)', st.gameVarsDirty === 0 && st.finalMagic[0] === 0x1234 && st.finalMagic[1] === 0x4321,
    `dirty ${st.gameVarsDirty}, last word ${hex(st.finalMagic[1])}`);
  check('stack canary intact; SP stays within $F002..$FF00', st.canary === 0x5AA5 && st.spMin >= S.STACK_CANARY + 2 && st.spMax <= S.STACK_TOP,
    `SP ${hex(st.spMin)}..${hex(st.spMax)}, deepest use ${0xFF00 - st.spMin} bytes, ${st.spMin - (S.STACK_CANARY + 2)} bytes to spare`);
  void GS;
}

const base = C.testGame({}, 'div1');
const stA = observe(base, 300);
gameChecks('2a. Test game, frame_div 1 (300 frames)', stA, base, 1, 300);
{
  const w = stA.work, e = stA.eraseT.filter((t) => t > 0), d = stA.drawT.filter((t) => t > 0);
  console.log(`  tick work (ISR excluded): min ${Math.min(...w)}  avg ${avg(w).toFixed(0)}  max ${Math.max(...w)} T (${(100 * avg(w) / FRAME_T).toFixed(1)} % of a frame; max ${(100 * Math.max(...w) / FRAME_T).toFixed(1)} %)`);
  console.log(`  of it: erase_all avg ${Math.round(avg(e))} T, draw_all avg ${Math.round(avg(d))} T (2 sprites); the rest is frame_entry (RT_MUL/DIV/MOD/RND/SHOW) and the loop`);
  check('2 visible sprites + the game fit in a frame with room to spare (max tick work < 50 %)', Math.max(...w) < FRAME_T / 2);
}
const div3 = C.testGame({ FRAME_DIV: 3 }, 'div3');
const stB = observe(div3, 450);
gameChecks('2b. Test game, frame_div 3 (450 frames)', stB, div3, 3, 450);

// ==================================================================================================================
// 3. frame_entry overrunning a refresh (every 5th tick burns ~80,000 T)
// ==================================================================================================================
const slow = C.testGame({ BURN: 1 }, 'burn');
const stC = observe(slow, 400);
console.log('\n3. frame_entry overruns a refresh (BURN: every 5th tick takes ~80,000 T, longer than one 58,688 T frame)');
{
  const over = stC.spans.filter((s) => s > 0);
  const maxWork = Math.max(...stC.work);
  check('the overrun happened: some ticks took more than one refresh', over.length > 5 && maxWork > FRAME_T, `${over.length} ticks overran, longest work ${maxWork} T`);
  check('interrupts that arrived during the work flipped nothing (V_SYNC = 0 at the ISR) and were skipped cleanly', stC.skippedFlips > 5 && stC.flipMismatch === 0,
    `${stC.skippedFlips} flips skipped, ${stC.flipMismatch} mismatches`);
  check('frame counter advanced exactly once per refresh through the overruns', stC.missed === 0, `${stC.missed} off`);
  check('no tearing: no instruction writes the displayed file, during the burn or anywhere', stC.writeViolations === 0, `${stC.writeViolations} writes`);
  check('the displayed picture equals the last COMPLETE composition in 100 % of frames (whole screen, every frame end)',
    stC.pictureOk === 400 && stC.pictureBad === 0, stC.firstPictureBad ? JSON.stringify(stC.firstPictureBad) : `${stC.pictureOk}/400`);
  check('the calls and the sprite table still equal the model every tick (an overrun loses no tick)', stC.callBad.length === 0 && stC.tabBad === 0 && stC.seedBad === 0);
  check('ticks are never skipped: V_TICKS counts 0, 1, 2, ... in order', stC.ticks.every((t, k) => t.n === k), `${stC.ticks.length} ticks`);
  check('stack canary intact', stC.canary === 0x5AA5 && stC.spMin >= slow.syms.STACK_CANARY + 2);
}

// ==================================================================================================================
// 4. Image and table checks
// ==================================================================================================================
console.log('\n4. Boot tables');
{
  const S = base.syms, m = stA.m;
  const rows = [C.spriteRows(base.bytes, base.gsyms.ball, 16), C.spriteRows(base.bytes, base.gsyms.box, 12)];
  let phaseBad = 0, firstBad = null;
  for (let i = 0; i < 2; i++) for (let p = 0; p < 8; p++) for (let r = 0; r < 16; r++) {
    const row = rows[i][r] ?? { mask: 0xFFFF, image: 0 };
    // 24-bit window: the 16-bit row at bits 23..8, mask padded with 1s, image with 0s, shifted right by p (mask fills with 1s)
    let mask = ((row.mask << 8) | 0xFF) >>> 0, image = (row.image << 8) >>> 0;
    mask = ((mask >>> p) | ((0xFFFFFF << (24 - p)) & 0xFFFFFF)) & 0xFFFFFF;
    image = (image >>> p) & 0xFFFFFF;
    const want = [mask >> 16, image >> 16, (mask >> 8) & 0xFF, (image >> 8) & 0xFF, mask & 0xFF, image & 0xFF];
    const at = S.PHASE_TAB + i * 768 + p * 96 + r * 6;
    for (let k = 0; k < 6; k++) if (rd8(m, at + k) !== want[k]) { phaseBad++; firstBad ??= { sprite: i, phase: p, row: r, byte: k, got: rd8(m, at + k), want: want[k] }; }
  }
  check('the pre-shifted phase tables of both sprites (8 phases x 16 rows x 6 bytes) equal a JS reference shift', phaseBad === 0, firstBad ? JSON.stringify(firstBad) : '2 x 768 bytes');
  let rowBad = 0;
  for (let y = 0; y < 192; y++) {
    const a = 0x4000 + ((y & 0xC0) << 5) + ((y & 7) << 8) + ((y & 0x38) << 2);
    if (rd16(m, S.ROW_TAB + y * 2) !== a) rowBad++;
  }
  check('ROW_TAB: 192 row addresses equal the Spectrum screen layout formula', rowBad === 0, `${rowBad} wrong`);
  check('chunk 6 plan: ROW_TAB $C000, PHASE_TAB $C200, room for 4 sprites below $CE00; compiled variables $E100-$EFFF',
    S.ROW_TAB === 0xC000 && S.PHASE_TAB === 0xC200 && S.FREE_RAM6 === 0xCE00 && S.GAME_VARS_BASE === 0xE100 && S.GAME_VARS_LIMIT === 0xEFFF,
    `FREE_RAM6 ${hex(S.FREE_RAM6)}`);
  // all four sprites at once: the tables fit and the runtime clamps counts above 4
  const rtc = rt.json.constants;
  check('runtime.json carries the contract constants', rtc.GAME_BASE === 0x8000 && rtc.GAME_VARS_BASE === 0xE100 && rtc.GAME_VARS_LIMIT === 0xEFFF && rtc.MAX_SPRITES === 4);
  const sy = rt.json.symbols;
  check('runtime.json carries the RT_* entries and the state symbols', ['RT_SHOW', 'RT_HIDE', 'RT_MUL', 'RT_DIV', 'RT_MOD', 'RT_RND', 'RT_STICK', 'V_TICKS', 'V_FRAMES', 'SPR_TAB', 'RT_SEED'].every((k) => Number.isInteger(sy[k])));
  const used = rt.usage.per[0] + rt.usage.per[1];
  check('the runtime fits chunks 0-1 (16 KB) with room to grow', used < 4096, `${used} bytes`);
}

// ==================================================================================================================
// 5. Four sprites (the maximum), sprite_count above 4 clamped
// ==================================================================================================================
console.log('\n5. Four sprites (test_game4.asm: ball, box, ball, box; all visible, overlapping, frame_div 2)');
{
  const assemble4 = (defines, name) => {
    const g = C.testGame4(defines, name);
    return g;
  };
  const g4 = assemble4({}, 'four');
  const kinds = ['ball', 'box', 'ball', 'box'];
  const calls4 = (n) => kinds.map((_, i) => ({ op: 'show', i, x: 20 + 13 * i + (n % 50), y: 30 + 9 * i + (n % 40) }));
  const st4 = observe(g4, 300, { kinds, calls: calls4, usesRnd: false });
  const S = g4.syms;
  check('the header was read: 4 sprites, frame_div 2, heights 16,12,16,12',
    rd8(st4.m, S.V_SPRN) === 4 && rd8(st4.m, S.V_DIV) === 2 && [16, 12, 16, 12].every((h, i) => rd8(st4.m, S.SPR_HGT + i) === h));
  check('4 sprites: every call equals the model and SPR_TAB equals what was SHOWed, every tick', st4.callBad.length === 0 && st4.tabBad === 0,
    st4.callBad.length ? JSON.stringify(st4.callBad[0]) : `${st4.ticks.length} ticks`);
  check('4 overlapping sprites: the displayed picture equals the expected composition (higher index on top) in 100 % of frames',
    st4.pictureOk === 300 && st4.pictureBad === 0, st4.firstPictureBad ? JSON.stringify(st4.firstPictureBad) : `${st4.pictureOk}/300`);
  check('4 sprites: no tearing (no write to the displayed file), frame counter exact, ticks every 2 refreshes',
    st4.writeViolations === 0 && st4.missed === 0 && st4.ticks.slice(1).every((t, k) => t.frames - st4.ticks[k].frames === 2));
  // the tables of all four sprites against the JS reference shift
  let bad4 = 0;
  const rows4 = kinds.map((k) => C.spriteRows(g4.bytes, g4.gsyms[k], k === 'ball' ? 16 : 12));
  for (let i = 0; i < 4; i++) for (let p = 0; p < 8; p++) for (let r = 0; r < 16; r++) {
    const row = rows4[i][r] ?? { mask: 0xFFFF, image: 0 };
    let mask = ((row.mask << 8) | 0xFF) >>> 0, image = (row.image << 8) >>> 0;
    mask = ((mask >>> p) | ((0xFFFFFF << (24 - p)) & 0xFFFFFF)) & 0xFFFFFF;
    image = (image >>> p) & 0xFFFFFF;
    const want = [mask >> 16, image >> 16, (mask >> 8) & 0xFF, (image >> 8) & 0xFF, mask & 0xFF, image & 0xFF];
    for (let k = 0; k < 6; k++) if (rd8(st4.m, S.PHASE_TAB + i * 768 + p * 96 + r * 6 + k) !== want[k]) bad4++;
  }
  check('all four sprites\' phase tables (4 x 768 bytes at $C200-$CDFF) equal the JS reference shift', bad4 === 0, `${bad4} wrong bytes`);
  const w = st4.work;
  console.log(`  tick work with 4 visible sprites (ISR excluded): avg ${avg(w).toFixed(0)}  max ${Math.max(...w)} T (${(100 * Math.max(...w) / FRAME_T).toFixed(1)} % of a frame); erase_all ${Math.round(avg(st4.eraseT.filter((t) => t > 0)))} T, draw_all ${Math.round(avg(st4.drawT.filter((t) => t > 0)))} T`);
  // a header that claims 7 sprites: clamped to 4
  const g7 = assemble4({ NSPR: 7 }, 'seven');
  const m7 = C.newMachine(g7.dck);
  C.bootMachine(m7, g7.syms);
  for (let f = 0; f < 30; f++) M.runFrame(m7);
  check('sprite_count 7 in the header is clamped to MAX_SPRITES (4); the machine runs on without damage',
    rd8(m7, g7.syms.V_SPRN) === 4 && rd16(m7, g7.syms.V_TICKS) > 5 && rd16(m7, g7.syms.STACK_CANARY) === 0x5AA5);
}

finish('M2 runtime');
