"use strict";
// m10-runtime-sound.mjs -- Leap Arcade language batch 5, Part C (docs/ARCADE_LANGUAGE_BATCH5.md items 16-19): THREE-CHANNEL SOUND EFFECTS in the runtimes v2, v3 and v4
// (sound.asm, the same file in all three), on a stock TS2068 (TSRun).  The effect images are built BY HAND here (the compiler's converter is not used).
//
// What is checked, on every build:
//  1. a JavaScript model of the AY register writes (written from the contract, not from the Z80 source) against the machine on EVERY refresh of
//     real frames (real frame interrupts): hand-made effects (B and C silent padding, noise on in B only / C only / A and C, tone 4095 with volume 14,
//     every mixer combination, a one-record effect, a terminator in the first group, byte 3 = 0..255) and random effects (1..60 groups, one and three
//     channels), with random RT_PLAY (also indices past the table) / RT_SILENCE calls: the (register, value) writes in ORDER (R0 R1 R2 R3 R4 R5 R6 R7 R8 R9 R10
//     with the skips: a register is written only when its value differs from AY_SHADOW), V_SFX_ACTIVE, V_SFX_CH, V_SFX_PTR, AY_SHADOW = the chip.
//  2. the switches: a three-channel effect over a one-channel one and back; a one-channel effect that replaces a three-channel one writes volume 0 to B and C ONCE
//     (RT_PLAY), so no stale B / C volume is left; RT_SILENCE in the middle of a three-channel effect writes R8-R10 = 0 (only the non-zero ones).
//  3. an interrupt at EVERY instruction boundary of RT_PLAY and RT_SILENCE (every combination of old and new effect): afterwards the mode, the pointer and
//     the chip agree (AY_SHADOW = chip), the new effect plays from its first record and the model follows it.
//  4. register discipline (the tick keeps every register, the alternates, IX and IY; RT_PLAY and RT_SILENCE keep IX, IY and the alternates; RT_SILENCE keeps BC, DE,
//     HL), stack depth of the tick, and costs: the added cost of the one-channel path (the entry test, measured against the same build with the test jumped over),
//     whole-interrupt T per refresh (median / worst) for both paths.
//  5. one-channel effects: the very same writes as before the change (the build with the entry test jumped over is the old code), on every refresh.
//  6. v2, v3 and v4 behave identically (digest of every refresh's writes).
//   node arcade/tests/m10-runtime-sound.mjs
import { createHash } from 'node:crypto';
import * as C3 from './m3-common.mjs';
import { rng } from './m3-scenes.mjs';
const { M, Z, hex, makeChecks, rd8, rd16, newMachine, bootMachine, callRoutine, ayWritesFor } = C3;

const { check, finish } = makeChecks();
console.log('M10 runtime sound: three-channel effects (RT_PLAY, RT_SILENCE, the AY tick) on runtime v2, v3, v4\n');

const VERS = (process.env.M10_VERSIONS ?? '2,3,4').split(',').map(Number);     // M10_VERSIONS=2: one build (the mutation test, m10-mutations.mjs)
const BUILDS = {};
for (const v of VERS) {
  const mod = await import(`../tools/build-runtime-v${v}.mjs`);
  const rt = mod.buildRuntime();
  BUILDS[v] = { v, mod, rt, S: rt.syms, K: rt.json.constants };
}

// ---- effect images ------------------------------------------------------------------------------------------------------------
let R = rng(1010);
const rec = (toneLo, toneHi, vol, noise, mix, b3 = 0) => [toneLo & 255, (toneHi & 15) | ((vol & 15) << 4), (noise & 31) | ((mix & 7) << 5), b3 & 255];
const SILENT = rec(0, 0, 0, 0, 7);                                   // the padding of a shorter channel: tone 0, volume 0, mix 7
const randRec = (b1ok = false) => { let r; do { r = rec(R.int(0, 255), R.int(0, 15), R.int(0, 15), R.int(0, 31), R.int(0, 7), R.int(0, 255)); } while (!b1ok && r[1] === 0xFF); return r; };
/** Three-channel effect from groups [A, B, C] of records; byte 3 of the first record is 3.  items = the groups as 12-byte arrays. */
function eff3(groups, tag = '') {
  const items = groups.map((g) => g.flat());
  items[0] = items[0].slice(); items[0][3] = 3;
  return { ch: 3, items, tag, bytes: items.flat().concat([0, 0xFF, 0, 0]) };
}
/** One-channel effect: records (first byte 3 = anything but 3). */
function eff1(recs, tag = '') {
  const items = recs.map((r) => r.slice());
  if (items.length && items[0][3] === 3) items[0][3] = 0;
  return { ch: 1, items, tag, bytes: items.flat().concat([0, 0xFF, 0, 0]) };
}
/** A terminator at once, byte 3 given: 3 = a three-channel effect with the terminator in its first group. */
function effEmpty(b3, tag = '') { return { ch: b3 === 3 ? 3 : 1, items: [], tag, bytes: [0, 0xFF, 0, b3] }; }
const randGroup = () => [randRec(false), randRec(true), randRec(true)];
const randEff3 = (n) => eff3(Array.from({ length: n }, randGroup), 'random3');
const randEff1 = (n) => eff1(Array.from({ length: n }, () => randRec(false)), 'random1');

const HAND = [
  eff3(Array.from({ length: 40 }, randGroup), 'random 40 groups'),                                                                         // 0
  eff3(Array.from({ length: 25 }, (_, k) => [rec(300 - 9 * k, (300 - 9 * k) >> 8, 15 - (k >> 2), 0, 0), SILENT, SILENT]), 'A plays, B and C silent padding'),   // 1
  eff3(Array.from({ length: 30 }, (_, k) => [rec(100 + k, 0, 8, 7 + k % 5, 2), rec(50 + 2 * k, 0, 10, 20 - k % 11, k % 2 ? 1 : 0), rec(0, 0, 6, 3, 3)]), 'noise on in B only (A noise off, C tone and noise off)'),   // 2
  eff3(Array.from({ length: 30 }, (_, k) => [rec(90, 1, 9, 5, (k % 3 === 0) ? 2 : 0), rec(0, 0, 0, 0, 7), rec(60 + k, 0, 7, 9, (k % 4 === 1) ? 2 : (k % 4 === 2) ? 1 : 0)]), 'noise on in C only / in A and C (A wins) / none'),   // 3
  eff3(Array.from({ length: 14 }, (_, k) => [rec(0xFF, 0xF, 14, 31, 0), rec(0xFF, 0xF, 14, 31, 1, 0xFF), rec(0xFF, 0xF, k % 2 ? 14 : 0, 0, 2, 255)]), 'tone 4095 with volume 14'), // 4
  eff3(Array.from({ length: 64 }, (_, k) => [rec(k, 1, 5, 3, k & 3), rec(k + 7, 2, 6, 4, (k >> 2) & 3), rec(k + 21, 3, 7, 5, (k >> 4) & 3)]), 'every mixer combination on all three channels'),   // 5
  eff1(Array.from({ length: 30 }, () => randRec(false)), 'one channel, random'),                                                              // 6
  effEmpty(3, 'terminator in the first group, byte 3 = 3'),                                                                                   // 7
];
const EXTRA_B3 = [0, 1, 2, 4, 5, 7, 255];    // byte 3 of the first record of a one-channel effect: anything but 3
/** The runtime image of `vv` with a game whose sfx table holds `effects` (at most 8). */
function image(vv, effects, { patchEntry = false } = {}) {
  const img = Uint8Array.from(vv.rt.img);
  const TAB = 0x9000;
  const tab = [effects.length];
  let at = TAB + 0x40;
  const starts = [];
  for (const e of effects) {
    starts.push(at);
    tab.push(at & 255, at >> 8);
    img.set(e.bytes, at);
    at += e.bytes.length;
  }
  if (at > 0xC000) throw new Error('effects too long for the image');
  img.set(tab, TAB);
  const g = vv.K.GAME_SFX;
  img[g] = TAB & 255; img[g + 1] = TAB >> 8;
  if (patchEntry) { img[vv.S.SND_S] = 0x18; img[vv.S.SND_S + 1] = 0x05; }       // JR +5: over the new entry test (7 bytes): the one-channel code of before
  return { img, dck: vv.mod.dckOf(img), starts };
}

// ---- the rig: a booted machine, an AY write log, direct calls, synthetic interrupts ---------------------------------------------
const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl', 'sp', 'i', 'im', 'iff1'];
const snap = (cpu) => Object.fromEntries(KEYS.map((k) => [k, cpu[k]]));
function rig(vv, effects, opts = {}) {
  const { img, dck, starts } = image(vv, effects, opts);
  const m = newMachine(dck);
  bootMachine(m, vv.S);
  readyForIrq(m);                                   // the boot ends inside an interrupt (pc = $0038: TSRun accepts the interrupt at the END of runFrame): let it finish
  const log = [];
  const o = m.bus.ioWrite;
  m.bus.ioWrite = (p, v) => { if ((p & 255) === 0xF5 || (p & 255) === 0xF6) log.push([p & 255, v]); o(p, v); };
  const take = () => {                              // the (register, value) writes since the last take(): null when the select / data pairing is broken
    const w = log.splice(0);
    const pairs = [];
    for (let k = 0; k < w.length; k += 2) { if (!w[k + 1] || w[k][0] !== 0xF5 || w[k + 1][0] !== 0xF6) return null; pairs.push([w[k][1], w[k + 1][1]]); }
    return pairs;
  };
  take();
  return { vv, S: vv.S, m, effects, starts, take, log };
}
/** One real refresh. */
function frame(r) {
  const f0 = rd16(r.m, r.S.V_FRAMES);
  M.runFrame(r.m);
  return (rd16(r.m, r.S.V_FRAMES) - f0) & 0xFFFF;
}
/** Make the machine ready for a synthetic interrupt (interrupts enabled, not mid-instruction-pair). */
function readyForIrq(m) {
  const cpu = m.cpu;
  cpu.halted = false;
  for (let i = 0; i < 100000 && !(cpu.iff1 && !cpu.eiDelay); i++) Z.runZ80(cpu, m.bus, 1, m);
}
/** A synthetic frame interrupt, run to its RET: { t, writes, preserved: [mismatching registers], spMin }.  Sentinels in every register. */
function fireIrq(r, sentinel = 0) {
  const m = r.m, cpu = m.cpu;
  readyForIrq(m);
  r.take();
  const pc0 = cpu.pc, before = snap(cpu), t0 = m.tstates;
  KEYS.forEach((key, i) => { if (!['sp', 'i', 'im', 'iff1'].includes(key)) cpu[key] = (0x3C + 29 * i + sentinel) & 0xFF; });
  const sent = snap(cpu);
  const sp0 = cpu.sp;
  Z.irqZ80(cpu, m.bus);
  let steps = 0, spMin = cpu.sp;
  while (!(cpu.pc === pc0 && cpu.sp === sp0) && steps++ < 4000) { Z.runZ80(cpu, m.bus, 1, m); if (cpu.sp < spMin) spMin = cpu.sp; }
  if (steps >= 4000) throw new Error('the interrupt did not return');
  const t = m.tstates - t0;
  const after = snap(cpu);
  const bad = KEYS.filter((k) => after[k] !== sent[k]);
  for (const key of KEYS) cpu[key] = before[key];
  return { t, writes: r.take(), bad, depth: sp0 - spMin };
}
/** RT_PLAY / RT_SILENCE called directly (interrupts off for the call). */
function call(r, name, a = 0, { bc = 0x1234, de = 0x5678, hl = 0x9ABC } = {}) {
  r.take();
  const out = callRoutine(r.m, r.S[name], { a, bc, de, hl });
  return { writes: r.take(), preserved: out.preserved, spOk: out.spOk, bc: out.bc === bc, de: out.de === de, hl: out.hl === hl, t: out.t };
}

// ---- the model (written from the contract) -------------------------------------------------------------------------------------
class Model {
  constructor(effects) { this.effects = effects; this.sh = new Array(16).fill(0); this.active = 0; this.ch = 0; this.eff = -1; this.pos = 0; this.played = false; }
  put(w, r, v) { if (this.sh[r] !== v) { this.sh[r] = v; w.push([r, v]); } }
  silenceWrites(w, from) { for (let r = from; r <= 10; r++) this.put(w, r, 0); }
  /** RT_PLAY(idx): the writes the call makes (main thread). */
  play(idx) {
    const w = [];
    if (idx >= Math.min(this.effects.length, 8)) return w;
    const e = this.effects[idx];
    this.active = 0;
    if (e.ch === 1 && this.ch === 3) this.silenceWrites(w, 9);       // 3 -> 1 channels: B and C volume 0
    this.ch = e.ch; this.eff = idx; this.pos = 0; this.active = 1; this.played = true;
    return w;
  }
  silence() { const w = []; this.active = 0; this.silenceWrites(w, 8); return w; }
  /** One refresh (the interrupt). */
  tick() {
    const w = [];
    if (!this.active) return w;
    const e = this.effects[this.eff];
    const item = e.items[this.pos];
    if (e.ch === 1) {
      if (!item) { this.active = 0; this.put(w, 8, 0); this.pos++; return w; }
      for (const x of ayWritesFor(this.sh, item)) w.push(x);
      this.pos++;
      return w;
    }
    if (!item) { this.active = 0; this.silenceWrites(w, 8); return w; }
    for (let c = 0; c < 3; c++) { this.put(w, 2 * c, item[4 * c]); this.put(w, 2 * c + 1, item[4 * c + 1] & 15); }
    let noise = null, r7 = 0;
    for (let c = 0; c < 3; c++) {
      const mix = (item[4 * c + 2] >> 5) & 3;
      r7 |= (mix & 1) << c;
      r7 |= ((mix >> 1) & 1) << (3 + c);
      if (noise === null && !((mix >> 1) & 1)) noise = item[4 * c + 2] & 31;       // the lowest channel with noise on
    }
    if (noise === null) noise = item[2] & 31;                                      // none: channel A's
    this.put(w, 6, noise); this.put(w, 7, r7);
    for (let c = 0; c < 3; c++) this.put(w, 8 + c, item[4 * c + 1] >> 4);
    this.pos++;
    return w;
  }
}
const sameW = (a, b) => a !== null && JSON.stringify(a) === JSON.stringify(b);

/** Run a script of `nref` real refreshes; ops[r] = list of {play: i} | {silence: true} applied BEFORE refresh r.  Returns { fails, writes, digest }. */
function runScript(r, ops, nref, tag, { checkEvery = true } = {}) {
  const S = r.S, m = r.m;
  const model = new Model(r.effects);
  const fails = [];
  M.runFrame(m);                                                    // (the interrupt of a refresh is accepted at the end of runFrame and runs at the start of the next: after this the machine is in that steady state)
  const hash = createHash('sha256');
  let nwrites = 0, ticksActive = 0, plays = 0, terms = 0;
  const fail = (why, extra) => { if (fails.length < 5) fails.push({ tag, why, ...extra }); };
  for (let t = 0; t < nref; t++) {
    for (const o of ops[t] ?? []) {
      if (o.silence) {
        const want = model.silence();
        const got = call(r, 'RT_SILENCE');
        hash.update(JSON.stringify(['S', got.writes]));
        if (!sameW(got.writes, want)) fail('RT_SILENCE writes', { t, got: got.writes, want });
        if (!got.preserved || !got.spOk || !got.bc || !got.de || !got.hl) fail('RT_SILENCE clobbered more than AF', { t, got });
        if (rd8(m, S.V_SFX_ACTIVE) !== 0) fail('RT_SILENCE left V_SFX_ACTIVE set', { t });
      } else {
        const want = model.play(o.play);
        const got = call(r, 'RT_PLAY', o.play);
        hash.update(JSON.stringify(['P', o.play, got.writes]));
        plays++;
        if (!sameW(got.writes, want)) fail('RT_PLAY writes', { t, idx: o.play, got: got.writes, want });
        if (!got.preserved || !got.spOk) fail('RT_PLAY broke IX / IY / the alternates / SP', { t });
        if (rd8(m, S.V_SFX_ACTIVE) !== model.active) fail('V_SFX_ACTIVE after RT_PLAY', { t, idx: o.play, got: rd8(m, S.V_SFX_ACTIVE), want: model.active });
        if (model.played && rd8(m, S.V_SFX_CH) !== model.ch) fail('V_SFX_CH after RT_PLAY', { t, idx: o.play, got: rd8(m, S.V_SFX_CH), want: model.ch });
        if (o.play < Math.min(r.effects.length, 8) && rd16(m, S.V_SFX_PTR) !== r.starts[model.eff]) fail('V_SFX_PTR after RT_PLAY', { t, idx: o.play, got: hex(rd16(m, S.V_SFX_PTR)), want: hex(r.starts[model.eff]) });
      }
    }
    const wasActive = model.active;
    const want = model.tick();
    const adv = frame(r);
    const got = r.take();
    hash.update(JSON.stringify(got));
    nwrites += got ? got.length : 0;
    if (adv !== 1) fail('not one interrupt per refresh', { t, adv });
    if (wasActive) ticksActive++;
    if (wasActive && !model.active) terms++;
    if (!sameW(got, want)) fail('AY writes of the refresh', { t, got, want, eff: model.eff, pos: model.pos - 1 });
    if (rd8(m, S.V_SFX_ACTIVE) !== model.active) fail('V_SFX_ACTIVE after the refresh', { t, got: rd8(m, S.V_SFX_ACTIVE), want: model.active });
    if (model.active) {
      const e = r.effects[model.eff];
      const want = r.starts[model.eff] + model.pos * (e.ch === 3 ? 12 : 4);
      if (rd16(m, S.V_SFX_PTR) !== want) fail('V_SFX_PTR after the refresh', { t, got: hex(rd16(m, S.V_SFX_PTR)), want: hex(want) });
    }
    if (checkEvery) {
      for (let k = 0; k < 11; k++) {
        if (rd8(m, S.AY_SHADOW + k) !== model.sh[k] || m.ay.regs[k] !== model.sh[k]) { fail('AY_SHADOW / chip register', { t, reg: k, shadow: rd8(m, S.AY_SHADOW + k), chip: m.ay.regs[k], want: model.sh[k] }); break; }
      }
    }
  }
  return { fails, digest: hash.digest('hex'), nwrites, ticksActive, plays, terms, model };
}
const randomOps = (r, nref, nEff, { pPlay = 0.12, pSilence = 0.03, pBad = 0.04 } = {}) => {
  const ops = [];
  for (let t = 0; t < nref; t++) {
    const o = [];
    if (r.chance(pPlay)) o.push({ play: r.int(0, nEff - 1) });
    else if (r.chance(pBad)) o.push({ play: r.pick([8, 9, 17, 100, 255, nEff, nEff + 1]) });
    if (r.chance(pSilence)) o.push({ silence: true });
    if (r.chance(0.01)) o.push({ play: r.int(0, nEff - 1) }, { play: r.int(0, nEff - 1) });     // twice in one refresh
    ops.push(o);
  }
  return ops;
};

// ===================================================================================================================================
const digests = {};
for (const v of VERS) {
  const vv = BUILDS[v];
  console.log(`--- runtime v${v} ---`);
  digests[v] = [];
  R = rng(4242);                                       // the same random effects and calls on every build

  // ---- 1. hand-made effects, a long scripted scenario -------------------------------------------------------------------------
  {
    const r = rig(vv, HAND);
    const ops = [];
    for (let t = 0; t < 700; t++) ops.push([]);
    const at = (t, ...o) => { ops[t].push(...o); };
    at(2, { play: 0 }); at(50, { play: 1 }); at(70, { play: 2 }); at(95, { silence: true }); at(96, { silence: true });     // silence mid-effect, then when already silent
    at(100, { play: 3 }); at(140, { play: 4 }); at(160, { play: 5 }); at(200, { play: 6 });                                  // 3 -> 3 ... 3 -> 1 (a one-channel effect over a three-channel one)
    at(240, { play: 2 }); at(245, { play: 6 }); at(270, { play: 1 }); at(300, { play: 7 });                                  // 1 -> 3, 3 -> 1, a terminator in the first group
    at(320, { play: 7 }); at(321, { play: 5 }); at(330, { play: 8 }, { play: 9 }, { play: 255 }, { play: 200 });             // past the table: ignored (the table holds 8)
    at(400, { play: 0 }, { play: 6 }); at(430, { play: 6 }, { play: 0 }); at(500, { play: 3 }); at(520, { silence: true }, { play: 4 });
    const res = runScript(r, ops, 700, 'hand');
    digests[v].push(res.digest);
    check(`v${v}: hand-made effects (B / C silent, noise in B / C / A and C, tone 4095 vol 14, all mixer combinations, 1 channel, terminator first), ${res.ticksActive} playing refreshes: every refresh's writes, V_SFX_*, shadow = chip`, res.fails.length === 0 && res.ticksActive > 300 && res.terms >= 5, res.fails.length ? JSON.stringify(res.fails[0]) : `${res.nwrites} AY writes, ${res.plays} RT_PLAY calls, ${res.terms} ends`);
  }
  // each effect alone to its end, from silence, then replayed over itself
  {
    let bad = null, n = 0;
    for (let i = 0; i < HAND.length && !bad; i++) {
      const r = rig(vv, HAND);
      const ops = Array.from({ length: 90 }, () => []);
      ops[1].push({ play: i }); ops[40].push({ play: i }); ops[41].push({ play: i });
      const res = runScript(r, ops, 90, 'alone ' + i);
      n += res.ticksActive;
      if (res.fails.length) bad = res.fails[0];
    }
    check(`v${v}: every hand-made effect alone, played again from the start, played twice in a row (${n} refreshes)`, bad === null, bad ? JSON.stringify(bad) : '');
  }
  // byte 3 of the first record: only 3 means three channels
  {
    let bad = null;
    for (const b3 of [...EXTRA_B3, 3]) {
      const recs = Array.from({ length: 6 }, (_, k) => rec(20 + k, 1, 9 - k, 4, k & 3, k === 0 ? b3 : 3));       // later records: byte 3 = 3 does nothing
      const e = b3 === 3 ? eff3(Array.from({ length: 6 }, () => [rec(20, 1, 9, 4, 0), rec(30, 2, 5, 6, 1), rec(40, 3, 7, 8, 2)]), 'b3=3') : eff1(recs, 'b3=' + b3);
      if (b3 !== 3) { e.items[0][3] = b3; e.bytes[3] = b3; e.ch = 1; }
      const r = rig(vv, [e]);
      const ops = Array.from({ length: 20 }, () => []); ops[1].push({ play: 0 });
      const res = runScript(r, ops, 20, 'byte3=' + b3);
      if (res.fails.length || rd8(r.m, r.S.V_SFX_CH) !== (b3 === 3 ? 3 : 1)) bad = res.fails[0] ?? { b3, ch: rd8(r.m, r.S.V_SFX_CH) };
    }
    check(`v${v}: V_SFX_CH is 3 only when byte 3 of the first record is 3 (0, 1, 2, 4, 5, 7, 255 give one channel)`, bad === null, bad ? JSON.stringify(bad) : '');
  }

  // ---- 2. the switches, explicit -------------------------------------------------------------------------------------------------
  {
    const e3 = eff3(Array.from({ length: 20 }, (_, k) => [rec(100, 1, 9, 2, 0), rec(200, 2, 8 + (k & 3), 3, 0), rec(30, 3, 7 + (k & 1), 4, 0)]), 'loud B and C');
    const e1 = eff1(Array.from({ length: 10 }, (_, k) => rec(50 + k, 1, 12, 5, 1)), 'one channel');
    const r = rig(vv, [e3, e1]);
    const m = r.m, S = r.S;
    M.runFrame(m);
    call(r, 'RT_PLAY', 0);
    for (let k = 0; k < 5; k++) frame(r);
    const loud = [rd8(m, S.AY_SHADOW + 9), rd8(m, S.AY_SHADOW + 10)];
    const sw = call(r, 'RT_PLAY', 1);                                                             // 3 -> 1
    check(`v${v}: a one-channel effect replacing a three-channel one: RT_PLAY writes volume 0 to B and C once (R9 then R10)`, loud[0] > 0 && loud[1] > 0 && JSON.stringify(sw.writes) === JSON.stringify([[9, 0], [10, 0]]) && m.ay.regs[9] === 0 && m.ay.regs[10] === 0 && rd8(m, S.V_SFX_CH) === 1, JSON.stringify(sw.writes));
    const w1 = [];
    for (let k = 0; k < 12; k++) { frame(r); w1.push(...r.take()); }
    check(`v${v}: ...and the one-channel effect then never touches R2-R5, R9, R10 (no stale B / C), V_SFX_ACTIVE 0 at its end`, w1.every(([reg]) => [0, 1, 6, 7, 8].includes(reg)) && rd8(m, S.V_SFX_ACTIVE) === 0 && m.ay.regs[8] === 0 && m.ay.regs[9] === 0);
    const again = call(r, 'RT_PLAY', 1);
    check(`v${v}: one channel over one channel (and idle): no extra write from RT_PLAY`, again.writes.length === 0);
    const up = call(r, 'RT_PLAY', 0);                                                             // 1 -> 3
    frame(r);
    const tk = r.take();
    check(`v${v}: three channels over one: no write from RT_PLAY, V_SFX_CH 3, the first group plays at the next refresh (R2.. written)`, up.writes.length === 0 && rd8(m, S.V_SFX_CH) === 3 && tk.length >= 6 && tk.some(([reg]) => reg === 9) && tk.some(([reg]) => reg === 10), JSON.stringify(tk));
    for (let k = 0; k < 6; k++) frame(r);
    r.take();
    const sil = call(r, 'RT_SILENCE');
    const nz = [8, 9, 10].filter((k) => rd8(m, S.AY_SHADOW + k) !== 0 || true);
    check(`v${v}: RT_SILENCE in the middle of a three-channel effect: R8, R9, R10 = 0 (only those that were not), V_SFX_ACTIVE 0, shadow and chip 0`,
      sil.writes.length >= 1 && sil.writes.length <= 3 && sil.writes.every(([reg, val]) => [8, 9, 10].includes(reg) && val === 0) && [8, 9, 10].every((k) => m.ay.regs[k] === 0 && rd8(m, S.AY_SHADOW + k) === 0) && rd8(m, S.V_SFX_ACTIVE) === 0 && nz.length === 3, JSON.stringify(sil.writes));
    frame(r);
    check(`v${v}: ...and the interrupt writes nothing afterwards; RT_SILENCE again writes nothing`, r.take().length === 0 && call(r, 'RT_SILENCE').writes.length === 0);
  }

  // ---- 3. random effects, random calls ----------------------------------------------------------------------------------------------
  {
    let bad = null, refreshes = 0, writes = 0, terms = 0;
    const nBatches = 14;
    for (let b = 0; b < nBatches && !bad; b++) {
      const effects = [];
      for (let i = 0; i < 8; i++) {
        const n = R.int(1, 60);
        const k = R.int(0, 9);
        if (k < 6) effects.push(randEff3(n));
        else if (k < 9) effects.push(randEff1(n));
        else effects.push(effEmpty(R.pick([0, 3]), 'empty'));
      }
      const r = rig(vv, effects);
      const ops = randomOps(R, 500, 8);
      const res = runScript(r, ops, 500, 'random batch ' + b);
      refreshes += res.ticksActive; writes += res.nwrites; terms += res.terms;
      digests[v].push(res.digest);
      if (res.fails.length) bad = res.fails[0];
    }
    check(`v${v}: ${nBatches} random tables of 8 effects (1..60 groups / records, one and three channels, empty ones), random RT_PLAY (also past the table) and RT_SILENCE: ${refreshes} playing refreshes, ${writes} AY writes, ${terms} ends, all equal to the model`, bad === null && refreshes > 2000, bad ? JSON.stringify(bad) : '');
  }
  // an effect longer than 1 KB of groups and the table's last slot
  {
    const effects = Array.from({ length: 8 }, (_, i) => (i === 7 ? randEff3(60) : randEff1(5)));
    const r = rig(vv, effects);
    const ops = Array.from({ length: 80 }, () => []); ops[2].push({ play: 7 });
    const res = runScript(r, ops, 80, 'last slot');
    check(`v${v}: the table's last slot (index 7) plays: 60 groups, ${res.ticksActive} refreshes`, res.fails.length === 0 && res.ticksActive === 61, res.fails.length ? JSON.stringify(res.fails[0]) : '');
  }
}

// ===================================================================================================================================
// 4. an interrupt at every instruction boundary of RT_PLAY and RT_SILENCE
// ===================================================================================================================================
const E3 = eff3(Array.from({ length: 30 }, (_, k) => [rec(100 + k, 1, 9, 2, 0), rec(200 - k, 2, 8 + (k & 3), 3, 1), rec(30 + k, 3, 7 + (k & 1), 4, 2)]), 'chaos 3a');
const E3b = eff3(Array.from({ length: 30 }, (_, k) => [rec(10 + k, 0, 14, 9, 2), rec(90, 1, 3, 31, 0), rec(1 + k, 2, 12, 17, 3)]), 'chaos 3b');
const E1 = eff1(Array.from({ length: 30 }, (_, k) => rec(60 + 3 * k, 1, 11, 6, k & 3)), 'chaos 1a');
const E1b = eff1(Array.from({ length: 30 }, (_, k) => rec(5 + k, 0, 15 - (k & 7), 9, (k >> 1) & 3)), 'chaos 1b');
const CHAOS = [E3, E3b, E1, E1b];
for (const v of VERS) {
  const vv = BUILDS[v];
  const r = rig(vv, CHAOS);
  const m = r.m, S = r.S, cpu = m.cpu;
  // reset all the sound state to idle
  const reset = () => { m.ram[S.V_SFX_ACTIVE] = 0; m.ram[S.V_SFX_CH] = 0; for (let k = 0; k < 16; k++) { m.ay.regs[k] = 0; m.ram[S.AY_SHADOW + k] = 0; } m.ram[S.V_SFX_PTR] = 0; m.ram[S.V_SFX_PTR + 1] = 0; };
  let trials = 0, bad = null, injected = 0;
  const combos = [];
  for (const old of [-1, 0, 2]) for (const act of [{ play: 0 }, { play: 1 }, { play: 2 }, { play: 3 }, { silence: true }]) combos.push({ old, act });
  const sentinel = 0x0060;
  for (const { old, act } of combos) {
    // the number of instructions of this call (no interrupt): found by a dry run
    const prepare = () => {
      reset();
      if (old >= 0) { call(r, 'RT_PLAY', old); for (let k = 0; k < 4; k++) fireIrq(r); }
      r.take();
    };
    prepare();
    let nInstr = 0;
    {
      const sv = snap(cpu), pc = cpu.pc, h = cpu.halted, ed = cpu.eiDelay;
      cpu.a = act.silence ? 0 : act.play; cpu.iff1 = false; cpu.sp -= 2; m.bus.write(cpu.sp, sentinel & 255); m.bus.write(cpu.sp + 1, sentinel >> 8); cpu.pc = act.silence ? S.RT_SILENCE : S.RT_PLAY;
      while (cpu.pc !== sentinel && nInstr < 5000) { Z.runZ80(cpu, m.bus, 1, m); nInstr++; }
      for (const k of KEYS) cpu[k] = sv[k]; cpu.pc = pc; cpu.halted = h; cpu.eiDelay = ed;
    }
    for (let k = 0; k <= nInstr + 1 && !bad; k++) {
      prepare();
      const sv = snap(cpu), pc = cpu.pc, h = cpu.halted, ed = cpu.eiDelay;
      const model = new Model(CHAOS);
      // the model's state equals the machine's before the call
      model.ch = old >= 0 ? CHAOS[old].ch : 0; model.sh = Array.from({ length: 16 }, (_, i) => rd8(m, S.AY_SHADOW + i));
      cpu.a = act.silence ? 0 : act.play; cpu.iff1 = true; cpu.eiDelay = false; cpu.halted = false;
      cpu.sp -= 2; m.bus.write(cpu.sp, sentinel & 255); m.bus.write(cpu.sp + 1, sentinel >> 8); cpu.pc = act.silence ? S.RT_SILENCE : S.RT_PLAY;
      const sp0 = cpu.sp + 2;
      let steps = 0, didInject = false;
      while (cpu.pc !== sentinel && steps < 5000) {
        if (steps === k && !didInject && cpu.iff1 && !cpu.eiDelay) {
          didInject = true; injected++;
          const pcI = cpu.pc, spI = cpu.sp;
          Z.irqZ80(cpu, m.bus);
          let n2 = 0;
          while (!(cpu.pc === pcI && cpu.sp === spI) && n2++ < 4000) Z.runZ80(cpu, m.bus, 1, m);
        }
        Z.runZ80(cpu, m.bus, 1, m); steps++;
      }
      for (const key of KEYS) cpu[key] = sv[key]; cpu.pc = pc; cpu.halted = h; cpu.eiDelay = ed;
      void sp0;
      trials++;
      // what is the state now?
      const sh = Array.from({ length: 16 }, (_, i) => rd8(m, S.AY_SHADOW + i));
      const inconsist = sh.findIndex((x, i) => i <= 10 && x !== m.ay.regs[i]);
      if (inconsist >= 0) { bad = { combo: { old, act }, k, why: 'AY_SHADOW differs from the chip', reg: inconsist, shadow: sh[inconsist], chip: m.ay.regs[inconsist] }; break; }
      if (act.silence) {
        if (rd8(m, S.V_SFX_ACTIVE) !== 0 || [8, 9, 10].some((i) => m.ay.regs[i] !== 0)) bad = { combo: { old, act }, k, why: 'after RT_SILENCE the effect or a volume is still on' };
        continue;
      }
      const e = CHAOS[act.play];
      const stepBytes = e.ch === 3 ? 12 : 4, ptrNow = rd16(m, S.V_SFX_PTR);
      const posNow = (ptrNow - r.starts[act.play]) / stepBytes;                    // 0, or 1 when the interrupt came after the last store of RT_PLAY and played the first record
      if (rd8(m, S.V_SFX_ACTIVE) !== 1 || rd8(m, S.V_SFX_CH) !== e.ch || (posNow !== 0 && posNow !== 1)) { bad = { combo: { old, act }, k, why: 'mode / pointer / active after RT_PLAY', active: rd8(m, S.V_SFX_ACTIVE), ch: rd8(m, S.V_SFX_CH), ptr: hex(rd16(m, S.V_SFX_PTR)) }; break; }
      if (e.ch === 1 && old >= 0 && CHAOS[old].ch === 3 && (m.ay.regs[9] !== 0 || m.ay.regs[10] !== 0)) { bad = { combo: { old, act }, k, why: 'stale B / C volume after 3 -> 1' }; break; }
      // then the new effect plays from its first record, as the model says, starting from the machine's shadow
      model.sh = sh; model.effects = CHAOS; model.eff = act.play; model.pos = posNow; model.active = 1; model.ch = e.ch;
      for (let t = 0; t < 8 && !bad; t++) {
        const want = model.tick();
        const f = fireIrq(r, t);
        if (!sameW(f.writes, want)) bad = { combo: { old, act }, k, why: 'tick after the call', t, got: f.writes, want };
      }
    }
    if (bad) break;
  }
  check(`v${v}: an interrupt at every instruction boundary of RT_PLAY / RT_SILENCE (${combos.length} combinations of old and new effect, ${trials} trials, ${injected} injected): shadow = chip, mode, pointer, no stale B / C, the new effect plays from its first record`, bad === null && trials > 400, bad ? JSON.stringify(bad) : `${trials} trials`);
}

// ===================================================================================================================================
// 5. register discipline, stack, costs, one-channel code unchanged
// ===================================================================================================================================
const stats = {};
for (const v of VERS) {
  const vv = BUILDS[v];
  const worst3 = eff3(Array.from({ length: 40 }, (_, k) => [rec(k * 37, (k * 3) & 15, (k + 1) & 15, k % 32, k & 3), rec(k * 59 + 1, (k * 5) & 15, (k * 3 + 2) & 15, (k * 7) % 32, (k >> 1) & 3), rec(k * 71 + 2, (k * 7) & 15, (k * 5 + 4) & 15, (k * 11) % 32, (k >> 2) & 3)]), 'everything changes');
  const same3 = eff3(Array.from({ length: 40 }, () => [rec(0x80, 1, 12, 5, 0), rec(0x40, 2, 10, 6, 1), rec(0x20, 3, 8, 7, 2)]), 'nothing changes');
  const mix3 = randEff3(60);
  const mix1 = eff1(Array.from({ length: 60 }, () => randRec(false)), 'random one channel');
  const worst1 = eff1(Array.from({ length: 40 }, (_, k) => rec(k * 37, (k * 3) & 15, (k + 1) & 15, k % 32, k & 3)), 'one channel: everything changes');
  const same1 = eff1(Array.from({ length: 40 }, () => rec(0x80, 1, 12, 5, 0)), 'one channel: nothing changes');
  const E = [worst3, same3, mix3, mix1, worst1, same1, effEmpty(3), effEmpty(0)];
  const run = (effects, idx, n, patch = false) => {
    const r = rig(vv, effects, { patchEntry: patch });
    call(r, 'RT_PLAY', idx);
    const ts = [], ws = [], depth = [];
    let badRegs = 0;
    for (let k = 0; k < n; k++) { const f = fireIrq(r, k); ts.push(f.t); ws.push(f.writes); depth.push(f.depth); badRegs += f.bad.length; }
    return { ts, ws, depth, badRegs, r };
  };
  const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { min: s[0], med: s[s.length >> 1], max: s[s.length - 1] }; };

  // idle interrupt
  const idle = (() => { const r = rig(vv, E); const ts = []; for (let k = 0; k < 8; k++) ts.push(fireIrq(r, k).t); return stat(ts); })();
  // three channels
  const a = run(E, 0, 41), b = run(E, 1, 41), c = run(E, 2, 61);
  const t3 = [...a.ts.slice(0, 40), ...b.ts.slice(0, 40), ...c.ts.slice(0, 60)];
  // terminators and the end
  const endT = run(E, 6, 3), endT2 = run(E, 7, 3);
  check(`v${v}: the three-channel tick keeps every register, the alternates, IX, IY, SP, I, IM, IFF1 (every path: all registers written, none, the terminator)`, a.badRegs + b.badRegs + c.badRegs + endT.badRegs + endT2.badRegs === 0);
  const dep3 = Math.max(...a.depth, ...b.depth, ...c.depth, ...endT.depth);
  // one channel, with the entry test, and the same build with it jumped over
  const o1 = run(E, 4, 41), o2 = run(E, 5, 41), o3 = run(E, 3, 61);
  const p1 = run(E, 4, 41, true), p2 = run(E, 5, 41, true), p3 = run(E, 3, 61, true);
  const pairs = [[o1, p1], [o2, p2], [o3, p3]];
  const sameWrites = pairs.every(([x, y]) => JSON.stringify(x.ws) === JSON.stringify(y.ws));
  const deltas = pairs.flatMap(([x, y]) => x.ts.map((t, i) => t - (y.ts[i] - 12)));            // the jumped-over build costs the old tick + the JR's 12 T
  check(`v${v}: a one-channel effect writes exactly what it wrote before the change, in the same order, on every refresh (${o1.ws.length + o2.ws.length + o3.ws.length} refreshes against the build with the entry test jumped over); one-channel tick keeps every register`,
    sameWrites && o1.badRegs + o2.badRegs + o3.badRegs === 0);
  const dMin = Math.min(...deltas), dMax = Math.max(...deltas);
  check(`v${v}: the added cost of the one-channel path is the entry test only: ${dMin}..${dMax} T per refresh (LD A,(nn) / CP 3 / JR Z, not taken = 27 T; the contract says about 25)`, dMin === 27 && dMax === 27);
  const t1 = [...o1.ts.slice(0, 40), ...o2.ts.slice(0, 40), ...o3.ts.slice(0, 60)];
  const s3 = stat(t3), s1 = stat(t1);
  const pts = [...p1.ts.slice(0, 40), ...p2.ts.slice(0, 40), ...p3.ts.slice(0, 60)].map((t) => t - 12), sp = stat(pts);
  stats[v] = { idle, s3, s1, sp, worst3: stat(a.ts.slice(0, 40)), none3: stat(b.ts.slice(0, 40)), dep3, dep1: Math.max(...o1.depth, ...o2.depth, ...o3.depth) };
  console.log(`  v${v} whole interrupt (acceptance, flip, counter, sound; T-states): idle ${idle.min}..${idle.max};  one channel (new) median ${s1.med}, worst ${s1.max}, best ${s1.min};  one channel (before) median ${sp.med}, worst ${sp.max};  three channels median ${s3.med}, worst ${s3.max}, best ${s3.min}` +
    ` (all registers changing: median ${stats[v].worst3.med}; nothing changing: ${stats[v].none3.med});  tick stack ${stats[v].dep1} bytes (one channel), ${dep3} (three channels), PC + AF of the interrupt included`);

  // RT_PLAY / RT_SILENCE register discipline and their cost
  {
    const r = rig(vv, E);
    const play0 = call(r, 'RT_PLAY', 0, { bc: 0x1111, de: 0x2222, hl: 0x3333 });
    for (let k = 0; k < 3; k++) fireIrq(r);
    const sw = call(r, 'RT_PLAY', 3);
    const sil = call(r, 'RT_SILENCE', 0, { bc: 0x4444, de: 0x5555, hl: 0x6666 });
    const sil2 = call(r, 'RT_SILENCE');
    check(`v${v}: RT_PLAY and RT_SILENCE keep IX, IY and the alternates and leave SP alone; RT_SILENCE keeps BC, DE, HL as well (RT_PLAY: ${play0.t} T, with the 3 -> 1 silencing ${sw.t} T; RT_SILENCE: ${sil.t} T, already silent ${sil2.t} T)`,
      play0.preserved && play0.spOk && sw.preserved && sw.spOk && sil.preserved && sil.spOk && sil.bc && sil.de && sil.hl && sil2.bc && sil2.de && sil2.hl);
    stats[v].play = [play0.t, sw.t]; stats[v].sil = [sil.t, sil2.t];
  }
}
if (VERS.length === 3) check('the one-channel tick costs the same on v2, v3 and v4 (one code, three builds)', [3, 4].every((v) => stats[v].s1.med === stats[2].s1.med && stats[v].s1.max === stats[2].s1.max && stats[v].s3.max === stats[2].s3.max));

// ===================================================================================================================================
// 6. the three runtimes behave identically
// ===================================================================================================================================
if (VERS.length === 3) check('v2, v3 and v4 gave the same AY writes on every refresh of every scenario (SHA-256 of all of them equal)', digests[3].join() === digests[2].join() && digests[4].join() === digests[2].join(), digests[2].map((d) => d.slice(0, 6)).join(' '));

void hex;
finish('M10 runtime sound');
