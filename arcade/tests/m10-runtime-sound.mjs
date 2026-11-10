"use strict";
// m10-runtime-sound.mjs -- Leap Arcade language batch 5, Part C (docs/ARCADE_LANGUAGE_BATCH5.md items 16-19): THREE-CHANNEL SOUND EFFECTS in the runtimes v2, v3 and v4
// (sound.asm, the same file in all three), on a stock TS2068 (TSRun).  The three-channel image is the DELTA STREAM of item 17 (revised 2026-11-10): the header `0, 0, 0, 3`,
// one entry per refresh (n, then n pairs register, value), a single $FF at the end; a one-channel effect keeps its 4-byte records.
//
// What is checked, on every build:
//  1. a JavaScript model of the AY register writes (written from the contract, not from the Z80 source) against the machine on EVERY refresh of real frames (real frame
//     interrupts).  Streams are built three ways: by hand, by a small ENCODER IN THIS TEST from per-refresh register rows, and by `convertSfx` of src/lang/arcade/arcade-assets.js
//     from random three-channel assets (the two encoders must give the same bytes, and after every refresh the chip's R0-R10 and AY_SHADOW must equal the row of
//     `sfxRefreshRegisters(asset)`): hand-made effects (B / C padding, noise in one channel, tone 4095, every mixer combination, entries with no change, a terminator in the first
//     entry, pairs in any order and repeated, an effect of 1,000 refreshes, byte 3 = 0..255) and random effects, with random RT_PLAY (also indices past the table) / RT_SILENCE
//     calls: the (register, value) writes in ORDER (every pair of an entry is written, also when it equals the shadow; one-channel registers are written only when they
//     differ), V_SFX_ACTIVE, V_SFX_CH, V_SFX_PTR, AY_SHADOW = the chip.
//  2. the switches: a three-channel effect over a one-channel one and back; a one-channel effect that replaces a three-channel one writes volume 0 to B and C ONCE (RT_PLAY),
//     so no stale B / C volume is left; RT_SILENCE in the middle of a three-channel effect writes R8-R10 = 0 (only the non-zero ones); the end of a stream does the same.
//  3. an interrupt at EVERY instruction boundary of RT_PLAY and RT_SILENCE (every combination of old and new effect): afterwards the mode, the pointer and the chip agree
//     (AY_SHADOW = chip), the new effect plays from its first entry and the model follows it.
//  4. register discipline (the tick keeps every register, the alternates, IX and IY; RT_PLAY and RT_SILENCE keep IX, IY and the alternates; RT_SILENCE keeps BC, DE, HL),
//     stack depth of the tick, and costs: the added cost of the one-channel path (the entry test, measured against the same build with the test jumped over), whole-interrupt T
//     per refresh by the number of changes of an entry (printed against the contract's targets) and the size of the three-channel code.
//  5. one-channel effects: the very same writes as before the change (the build with the entry test jumped over is the old code), on every refresh.
//  6. v2, v3 and v4 behave identically (digest of every refresh's writes).
//  7. END TO END: a game compiled by the real compiler PLAYs a three-channel asset (and a one-channel one over it, a chord, SILENCE) on each build's cartridge; after every
//     refresh the AY_SHADOW and the chip equal the rows of `sfxRefreshRegisters`, at the end the volumes are 0.
//   node arcade/tests/m10-runtime-sound.mjs
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import * as C3 from './m3-common.mjs';
import { rng } from './m3-scenes.mjs';
import { convertSfx, sfxRefreshRegisters } from '../../src/lang/arcade/arcade-assets.js';
import { compile } from '../../src/lang/arcade/arcade-compile.js';
const { M, Z, hex, makeChecks, rd8, rd16, newMachine, bootMachine, callRoutine, ayWritesFor } = C3;

const { check, finish } = makeChecks();
console.log('M10 runtime sound: three-channel effects, delta stream (RT_PLAY, RT_SILENCE, the AY tick) on runtime v2, v3, v4\n');

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
const randRec = (b1ok = false) => { let r; do { r = rec(R.int(0, 255), R.int(0, 15), R.int(0, 15), R.int(0, 31), R.int(0, 7), R.int(0, 255)); } while (!b1ok && r[1] === 0xFF); return r; };
/** One-channel effect: records (first byte 3 = anything but 3). */
function eff1(recs, tag = '') {
  const items = recs.map((r) => r.slice());
  if (items.length && items[0][3] === 3) items[0][3] = 0;
  return { ch: 1, items, tag, bytes: items.flat().concat([0, 0xFF, 0, 0]) };
}
/** A terminator at once, byte 3 given: 3 = a three-channel effect whose stream is the single $FF; else a one-channel effect. */
function effEmpty(b3, tag = '') { return b3 === 3 ? eff3([], tag) : { ch: 1, items: [], tag, bytes: [0, 0xFF, 0, b3] }; }

/** Three-channel effect from ENTRIES (each a list of [register, value] pairs): the header 0,0,0,3, per entry n and its pairs, one $FF.  `rows` (optional): the 11 registers after each refresh. */
function eff3(entries, tag = '', rows = null) {
  const items = entries.map((e) => e.map((p) => p.slice()));
  return { ch: 3, items, tag, rows, bytes: [0, 0, 0, 3, ...items.flatMap((e) => [e.length, ...e.flat()]), 0xFF] };
}
/** The ENCODER of this test (item 17, written from the contract): rows of 11 registers -> entries: the first holds all 11, later ones the registers that changed, ascending. */
const encodeRows = (rows) => rows.map((row, i) => row.flatMap((v, k) => (i === 0 || v !== rows[i - 1][k] ? [[k, v]] : [])));
const eff3Rows = (rows, tag = '') => eff3(encodeRows(rows), tag, rows);
/** From an asset with convertSfx (the compiler's converter): the bytes played are convertSfx's; the items are this test's encoder's; `bytesOk` says they agree byte for byte. */
function eff3Asset(asset, tag = '') {
  const rows = sfxRefreshRegisters(asset);
  const mine = eff3Rows(rows, tag);
  const theirs = Array.from(convertSfx(asset).bytes);
  return { ...mine, bytes: theirs, bytesOk: JSON.stringify(theirs) === JSON.stringify(mine.bytes), fromAsset: true };
}
/** The offset of the stream pointer after `pos` entries (three channels: after the 4-byte header) or records (one channel). */
const ptrOff = (e, pos) => (e.ch === 3 ? 4 + e.items.slice(0, pos).reduce((s, it) => s + 1 + 2 * it.length, 0) : 4 * pos);

// random rows: every register keeps its value with probability 1 - p, else gets a random value of its legal range
const RANGE = [255, 15, 255, 15, 255, 15, 31, 63, 15, 15, 15];
const randReg = (k) => R.int(0, RANGE[k]);
function randRows(n, p = 0.3) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(Array.from({ length: 11 }, (_, k) => (i === 0 || R.chance(p) ? randReg(k) : rows[i - 1][k])));
  return rows;
}
const randEff3 = (n) => eff3Rows(randRows(n, R.pick([0.05, 0.15, 0.3, 0.6, 1])), 'random3');
const randEff1 = (n) => eff1(Array.from({ length: n }, () => randRec(false)), 'random1');
const T = (tone, vol, noise, mix) => { let v = vol; if (((tone >> 8) | (v << 4)) === 0xFF) v = 14; return { tone, vol: v, noise, mix }; };
const SIL = T(0, 0, 0, 7);                                                          // the padding record of a shorter channel
const randTick = (style) => T(style === 0 ? R.int(0, 4095) : style === 1 ? R.int(3840, 4095) : R.int(0, 2), R.chance(0.3) ? 15 : R.int(0, 15), R.int(0, 31), R.int(0, 7));
function randAsset3() {
  const style = R.int(0, 2), ch = (n) => Array.from({ length: n }, () => randTick(style));
  const a = { ticks: ch(R.int(0, 40)), ticksB: ch(R.int(0, 40)), ticksC: ch(R.int(0, 40)) };
  if (a.ticks.length + a.ticksB.length + a.ticksC.length === 0) a.ticksC = ch(1);
  if (a.ticksB.length === 0 && a.ticksC.length === 0) a.ticksB = ch(1 + R.int(0, 8));        // a three-channel asset has a B or a C track
  return a;
}
const randAssetEff = () => eff3Asset(randAsset3(), 'random asset');

const HAND = [
  eff3Rows(randRows(40, 0.3), 'random 40 entries'),                                                                                                  // 0
  eff3Asset({ ticks: Array.from({ length: 25 }, (_, k) => T(300 - 9 * k, 15 - (k >> 2), 0, 0)), ticksB: [], ticksC: [SIL] }, 'A plays, B and C silent padding'),                      // 1
  eff3Asset({ ticks: Array.from({ length: 30 }, (_, k) => T(100 + k, 8, 7 + k % 5, 2)), ticksB: Array.from({ length: 30 }, (_, k) => T(50 + 2 * k, 10, 20 - k % 11, k % 2 ? 1 : 0)), ticksC: Array.from({ length: 30 }, () => T(0, 6, 3, 3)) }, 'noise on in B only'),   // 2
  eff3Asset({ ticks: Array.from({ length: 30 }, (_, k) => T(346, 9, 5, (k % 3 === 0) ? 2 : 0)), ticksB: Array.from({ length: 30 }, () => SIL), ticksC: Array.from({ length: 30 }, (_, k) => T(60 + k, 7, 9, (k % 4 === 1) ? 2 : (k % 4 === 2) ? 1 : 0)) }, 'noise in C only / A and C / none'),   // 3
  eff3Asset({ ticks: Array.from({ length: 14 }, () => T(4095, 14, 31, 0)), ticksB: Array.from({ length: 14 }, () => T(4095, 14, 31, 1)), ticksC: Array.from({ length: 14 }, (_, k) => T(4095, k % 2 ? 14 : 0, 0, 2)) }, 'tone 4095 with volume 14'), // 4
  eff3Asset({ ticks: Array.from({ length: 64 }, (_, k) => T(256 + k, 5, 3, k & 3)), ticksB: Array.from({ length: 64 }, (_, k) => T(512 + k + 7, 6, 4, (k >> 2) & 3)), ticksC: Array.from({ length: 64 }, (_, k) => T(768 + k + 21, 7, 5, (k >> 4) & 3)) }, 'every mixer combination on all three channels'),   // 5
  eff1(Array.from({ length: 30 }, () => randRec(false)), 'one channel, random'),                                                                       // 6
  effEmpty(3, 'terminator in the first entry, byte 3 = 3'),                                                                                          // 7
];
// the effects that only a stream can say: no change at all, pairs in any order and repeated, the largest entry, a stream longer than a page, a very long effect
const STEADY = eff3Asset({ ticks: Array.from({ length: 20 }, () => T(300, 9, 4, 2)), ticksB: Array.from({ length: 20 }, () => T(200, 5, 4, 2)), ticksC: Array.from({ length: 20 }, () => T(100, 7, 4, 2)) }, 'steady: every entry after the first has n = 0');
const ODD = eff3([[[8, 5], [0, 1], [8, 7], [10, 3], [2, 9], [2, 4], [7, 0x38], [6, 31], [1, 15], [0, 255]], [], [[10, 0], [9, 15]], [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0], [5, 0], [6, 0], [7, 0], [8, 0], [9, 0], [10, 0], [8, 15]], [[8, 0]]], 'pairs in any order, repeated, n = 11, n = 0');
const LONG = eff3Rows(randRows(1000, 0.2), 'a long effect: 1,000 refreshes');
const FULL = eff3Rows(randRows(200, 1), 'nearly every register changes at every refresh, 200 refreshes');
const HAND2 = [STEADY, ODD, LONG, FULL];
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
  if (patchEntry) { img[vv.S.SND_S] = 0x18; img[vv.S.SND_S + 1] = 0x05; }       // JR +5: over the entry test (7 bytes): the one-channel code of before
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
    if (!item) { this.active = 0; this.silenceWrites(w, 8); return w; }      // the single $FF: stop, R8-R10 = 0 where not already
    for (const [reg, val] of item) { w.push([reg, val]); this.sh[reg] = val; }  // every pair of the entry, in order, also when it equals the shadow
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
  let nwrites = 0, ticksActive = 0, plays = 0, terms = 0, rowChecks = 0;
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
        if (o.play < Math.min(r.effects.length, 8)) {
          const want = r.starts[model.eff] + ptrOff(r.effects[model.eff], 0);          // a three-channel stream starts after its 4-byte header
          if (rd16(m, S.V_SFX_PTR) !== want) fail('V_SFX_PTR after RT_PLAY', { t, idx: o.play, got: hex(rd16(m, S.V_SFX_PTR)), want: hex(want) });
        }
      }
    }
    const wasActive = model.active;
    const eBefore = wasActive ? r.effects[model.eff] : null, posBefore = model.pos;
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
      const want = r.starts[model.eff] + ptrOff(e, model.pos);
      if (rd16(m, S.V_SFX_PTR) !== want) fail('V_SFX_PTR after the refresh', { t, got: hex(rd16(m, S.V_SFX_PTR)), want: hex(want) });
    }
    if (eBefore?.rows && eBefore.ch === 3 && posBefore < eBefore.rows.length) {       // an effect with rows: the chip's R0-R10 are exactly the row of this refresh
      rowChecks++;
      const row = eBefore.rows[posBefore];
      for (let k = 0; k < 11; k++) if (m.ay.regs[k] !== row[k] || rd8(m, S.AY_SHADOW + k) !== row[k]) { fail('registers differ from the row of sfxRefreshRegisters', { t, pos: posBefore, reg: k, chip: m.ay.regs[k], shadow: rd8(m, S.AY_SHADOW + k), want: row[k] }); break; }
    }
    if (checkEvery) {
      for (let k = 0; k < 11; k++) {
        if (rd8(m, S.AY_SHADOW + k) !== model.sh[k] || m.ay.regs[k] !== model.sh[k]) { fail('AY_SHADOW / chip register', { t, reg: k, shadow: rd8(m, S.AY_SHADOW + k), chip: m.ay.regs[k], want: model.sh[k] }); break; }
      }
    }
  }
  return { fails, digest: hash.digest('hex'), nwrites, ticksActive, plays, terms, rowChecks, model };
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
  const HANDv = [...HAND];                             // (HAND was built with the first generator state: the same on every build)

  // ---- 1. hand-made effects, a long scripted scenario -------------------------------------------------------------------------
  {
    const r = rig(vv, HANDv);
    const ops = [];
    for (let t = 0; t < 700; t++) ops.push([]);
    const at = (t, ...o) => { ops[t].push(...o); };
    at(2, { play: 0 }); at(50, { play: 1 }); at(70, { play: 2 }); at(95, { silence: true }); at(96, { silence: true });     // silence mid-effect, then when already silent
    at(100, { play: 3 }); at(140, { play: 4 }); at(160, { play: 5 }); at(200, { play: 6 });                                  // 3 -> 3 ... 3 -> 1 (a one-channel effect over a three-channel one)
    at(240, { play: 2 }); at(245, { play: 6 }); at(270, { play: 1 }); at(300, { play: 7 });                                  // 1 -> 3, 3 -> 1, a terminator in the first entry
    at(320, { play: 7 }); at(321, { play: 5 }); at(330, { play: 8 }, { play: 9 }, { play: 255 }, { play: 200 });             // past the table: ignored (the table holds 8)
    at(400, { play: 0 }, { play: 6 }); at(430, { play: 6 }, { play: 0 }); at(500, { play: 3 }); at(520, { silence: true }, { play: 4 });
    const res = runScript(r, ops, 700, 'hand');
    digests[v].push(res.digest);
    check(`v${v}: hand-made effects (B / C padding, noise in B / C / A and C, tone 4095 vol 14, all mixer combinations, 1 channel, terminator first), ${res.ticksActive} playing refreshes: every refresh's writes, V_SFX_*, shadow = chip, chip = the rows`, res.fails.length === 0 && res.ticksActive > 300 && res.terms >= 5 && res.rowChecks > 200, res.fails.length ? JSON.stringify(res.fails[0]) : `${res.nwrites} AY writes, ${res.plays} RT_PLAY calls, ${res.terms} ends, ${res.rowChecks} refreshes against sfxRefreshRegisters`);
  }
  // each effect alone to its end, from silence, then replayed over itself
  {
    let bad = null, n = 0;
    for (let i = 0; i < HANDv.length && !bad; i++) {
      const r = rig(vv, HANDv);
      const ops = Array.from({ length: 90 }, () => []);
      ops[1].push({ play: i }); ops[40].push({ play: i }); ops[41].push({ play: i });
      const res = runScript(r, ops, 90, 'alone ' + i);
      n += res.ticksActive;
      if (res.fails.length) bad = res.fails[0];
    }
    check(`v${v}: every hand-made effect alone, played again from the start, played twice in a row (${n} refreshes)`, bad === null, bad ? JSON.stringify(bad) : '');
  }
  // the streams that only the delta format can say, and long ones: n = 0 for every entry, pairs in any order, n = 11, streams of 4.6 and 5 KB, 1,000 refreshes
  {
    const r = rig(vv, HAND2);
    const ops = Array.from({ length: 1600 }, () => []);
    ops[1].push({ play: 0 }); ops[25].push({ play: 1 }); ops[40].push({ play: 1 }, { play: 0 }); ops[80].push({ play: 3 }); ops[300].push({ play: 2 }); ops[900].push({ play: 1 });
    ops[1005].push({ play: 3 }); ops[1210].push({ play: 2 }); ops[1500].push({ silence: true });
    const res = runScript(r, ops, 1600, 'streams');
    digests[v].push(res.digest);
    check(`v${v}: steady (n = 0 entries), pairs in any order and repeated, n = 11, a stream of 4.6 KB and a 1,000-refresh effect (${res.ticksActive} refreshes): the model, and the chip = the rows`, res.fails.length === 0 && res.ticksActive > 1200 && res.rowChecks > 1000, res.fails.length ? JSON.stringify(res.fails[0]) : `${res.nwrites} AY writes, ${res.rowChecks} row checks`);
    const steady = rig(vv, [STEADY]);
    const o2 = Array.from({ length: 30 }, () => []); o2[1].push({ play: 0 });
    const rs = runScript(steady, o2, 30, 'steady');
    check(`v${v}: the entries after the first of a steady effect write nothing (only the first refresh and the end write)`, rs.fails.length === 0 && rs.nwrites === 11 + 3, `${rs.nwrites} writes`);
  }
  // byte 3 of the first record: only 3 means three channels
  {
    let bad = null;
    for (const b3 of [...EXTRA_B3, 3]) {
      const recs = Array.from({ length: 6 }, (_, k) => rec(20 + k, 1, 9 - k, 4, k & 3, k === 0 ? b3 : 3));       // later records: byte 3 = 3 does nothing
      const e = b3 === 3 ? eff3Rows(randRows(6, 0.5), 'b3=3') : eff1(recs, 'b3=' + b3);
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
    const e3 = eff3Asset({ ticks: Array.from({ length: 20 }, () => T(356, 9, 2, 0)), ticksB: Array.from({ length: 20 }, (_, k) => T(712, 8 + (k & 3), 3, 0)), ticksC: Array.from({ length: 20 }, (_, k) => T(798, 7 + (k & 1), 4, 0)) }, 'loud B and C');
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
    check(`v${v}: three channels over one: no write from RT_PLAY, V_SFX_CH 3, the first entry (all 11 registers) plays at the next refresh`, up.writes.length === 0 && rd8(m, S.V_SFX_CH) === 3 && tk.length === 11 && tk.every(([reg], i) => reg === i), JSON.stringify(tk));
    for (let k = 0; k < 6; k++) frame(r);
    r.take();
    const sil = call(r, 'RT_SILENCE');
    check(`v${v}: RT_SILENCE in the middle of a three-channel effect: R8, R9, R10 = 0 (only those that were not), V_SFX_ACTIVE 0, shadow and chip 0`,
      sil.writes.length >= 1 && sil.writes.length <= 3 && sil.writes.every(([reg, val]) => [8, 9, 10].includes(reg) && val === 0) && [8, 9, 10].every((k) => m.ay.regs[k] === 0 && rd8(m, S.AY_SHADOW + k) === 0) && rd8(m, S.V_SFX_ACTIVE) === 0, JSON.stringify(sil.writes));
    frame(r);
    check(`v${v}: ...and the interrupt writes nothing afterwards; RT_SILENCE again writes nothing`, r.take().length === 0 && call(r, 'RT_SILENCE').writes.length === 0);
    // the end of a stream: the volumes that are not 0 are written 0 (R8, R9, R10 in order, only those), V_SFX_ACTIVE 0
    const e4 = eff3Rows([[1, 1, 2, 2, 3, 3, 4, 5, 9, 0, 7], [1, 1, 2, 2, 3, 3, 4, 5, 0, 0, 7]], 'ends with volumes C only');
    const r4 = rig(vv, [e4]);
    M.runFrame(r4.m);
    call(r4, 'RT_PLAY', 0);
    frame(r4); frame(r4); r4.take();
    frame(r4);
    check(`v${v}: the $FF of a stream writes R8-R10 = 0 only where the shadow is not 0 (here R10 only), V_SFX_ACTIVE 0`, JSON.stringify(r4.take()) === JSON.stringify([[10, 0]]) && rd8(r4.m, r4.S.V_SFX_ACTIVE) === 0 && r4.m.ay.regs[10] === 0 && rd8(r4.m, r4.S.AY_SHADOW + 10) === 0);
  }

  // ---- 3. random effects, random calls ----------------------------------------------------------------------------------------------
  {
    let bad = null, refreshes = 0, writes = 0, terms = 0, rows = 0, notSame = 0;
    const nBatches = 14;
    for (let b = 0; b < nBatches && !bad; b++) {
      const effects = [];
      for (let i = 0; i < 8; i++) {
        const k = R.int(0, 9);
        if (k < 3) effects.push(randEff3(R.int(1, 60)));
        else if (k < 6) effects.push(randAssetEff());
        else if (k < 9) effects.push(randEff1(R.int(1, 60)));
        else effects.push(effEmpty(R.pick([0, 3]), 'empty'));
      }
      notSame += effects.filter((e) => e.fromAsset && !e.bytesOk).length;
      const r = rig(vv, effects);
      const ops = randomOps(R, 500, 8);
      const res = runScript(r, ops, 500, 'random batch ' + b);
      refreshes += res.ticksActive; writes += res.nwrites; terms += res.terms; rows += res.rowChecks;
      digests[v].push(res.digest);
      if (res.fails.length) bad = res.fails[0];
    }
    check(`v${v}: ${nBatches} random tables of 8 effects (streams from this test's encoder and from convertSfx of random assets, one-channel, empty ones), random RT_PLAY (also past the table) and RT_SILENCE: ${refreshes} playing refreshes, ${writes} AY writes, ${terms} ends, ${rows} refreshes checked against sfxRefreshRegisters, all equal to the model`, bad === null && refreshes > 2000 && rows > 800, bad ? JSON.stringify(bad) : '');
    check(`v${v}: convertSfx's bytes equal this test's encoder's for every random asset played`, notSame === 0, `${notSame} differ`);
  }
  // an effect longer than 1 KB and the table's last slot
  {
    const effects = Array.from({ length: 8 }, (_, i) => (i === 7 ? randEff3(60) : randEff1(5)));
    const r = rig(vv, effects);
    const ops = Array.from({ length: 80 }, () => []); ops[2].push({ play: 7 });
    const res = runScript(r, ops, 80, 'last slot');
    check(`v${v}: the table's last slot (index 7) plays: 60 entries, ${res.ticksActive} refreshes`, res.fails.length === 0 && res.ticksActive === 61, res.fails.length ? JSON.stringify(res.fails[0]) : '');
  }
}
// the two encoders, on assets that never reach the machine as well
{
  let bad = 0;
  R = rng(777);
  for (let i = 0; i < 400; i++) { const e = randAssetEff(); if (!e.bytesOk) bad++; }
  check('convertSfx gives the same bytes as the encoder of this test for 400 random three-channel assets (delta stream: first entry all 11 registers, later ones the changes, ascending, one $FF)', bad === 0, `${bad} differ`);
}

// ===================================================================================================================================
// 4. an interrupt at every instruction boundary of RT_PLAY and RT_SILENCE
// ===================================================================================================================================
R = rng(555);
const chaosRows = (k0, n) => Array.from({ length: n }, (_, k) => [(100 + k + k0) & 255, 1 + (k & 3), (200 - k) & 255, 2, (30 + k) & 255, 3, 4 + (k & 1), k & 7, 9 - (k & 1), 8 + (k & 3), 7 + (k & 1)]);
const E3 = eff3Rows(chaosRows(0, 30), 'chaos 3a');
const E3b = eff3Rows(randRows(30, 0.5), 'chaos 3b');
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
  for (const old of [-1, 0, 1, 2, 3]) for (const act of [{ play: 0 }, { play: 1 }, { play: 2 }, { play: 3 }, { silence: true }]) combos.push({ old, act });
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
      const ptrNow = rd16(m, S.V_SFX_PTR) - r.starts[act.play];
      const posNow = [0, 1].find((p) => ptrOff(e, p) === ptrNow);                   // 0, or 1 when the interrupt came after the last store of RT_PLAY and played the first entry
      if (rd8(m, S.V_SFX_ACTIVE) !== 1 || rd8(m, S.V_SFX_CH) !== e.ch || posNow === undefined) { bad = { combo: { old, act }, k, why: 'mode / pointer / active after RT_PLAY', active: rd8(m, S.V_SFX_ACTIVE), ch: rd8(m, S.V_SFX_CH), ptr: hex(rd16(m, S.V_SFX_PTR)) }; break; }
      if (e.ch === 1 && old >= 0 && CHAOS[old].ch === 3 && (m.ay.regs[9] !== 0 || m.ay.regs[10] !== 0)) { bad = { combo: { old, act }, k, why: 'stale B / C volume after 3 -> 1' }; break; }
      // then the new effect plays from its first entry, as the model says, starting from the machine's shadow
      model.sh = sh; model.effects = CHAOS; model.eff = act.play; model.pos = posNow; model.active = 1; model.ch = e.ch;
      for (let t = 0; t < 8 && !bad; t++) {
        const want = model.tick();
        const f = fireIrq(r, t);
        if (!sameW(f.writes, want)) bad = { combo: { old, act }, k, why: 'tick after the call', t, got: f.writes, want };
      }
    }
    if (bad) break;
  }
  check(`v${v}: an interrupt at every instruction boundary of RT_PLAY / RT_SILENCE (${combos.length} combinations of old and new effect, ${trials} trials, ${injected} injected): shadow = chip, mode, pointer, no stale B / C, the new effect plays from its first entry`, bad === null && trials > 600, bad ? JSON.stringify(bad) : `${trials} trials`);
}

// ===================================================================================================================================
// 5. register discipline, stack, costs, one-channel code unchanged
// ===================================================================================================================================
const stats = {};
const TARGET = { n0: 250, typical: 600, n11: 900, bytes: 100 };            // docs/ARCADE_LANGUAGE_BATCH5.md item 18 (whole interrupt, TSRun)
/** An effect of 41 entries: the first writes all 11 registers, the 40 after it exactly `n` pairs each (a random ascending subset, values that always change). */
function costEff(n) {
  const entries = [Array.from({ length: 11 }, (_, k) => [k, randReg(k)])];
  let prev = entries[0].map(([, v]) => v);
  for (let i = 0; i < 40; i++) {
    const regs = [...Array(11).keys()].sort(() => R.next() - 0.5).slice(0, n).sort((a, b) => a - b);
    entries.push(regs.map((k) => { let v; do { v = randReg(k); } while (v === prev[k]); prev[k] = v; return [k, v]; }));
  }
  return eff3(entries, 'cost n=' + n);
}
for (const v of VERS) {
  const vv = BUILDS[v];
  R = rng(909);
  const NS = [0, 1, 2, 3, 4, 5, 6, 8, 11];
  const costs = NS.map(costEff);
  const worst1 = eff1(Array.from({ length: 40 }, (_, k) => rec(k * 37, (k * 3) & 15, (k + 1) & 15, k % 32, k & 3)), 'one channel: everything changes');
  const same1 = eff1(Array.from({ length: 40 }, () => rec(0x80, 1, 12, 5, 0)), 'one channel: nothing changes');
  const mix1 = eff1(Array.from({ length: 60 }, () => randRec(false)), 'random one channel');
  const run = (effect, n, patch = false) => {              // one effect in a table of its own
    const r = rig(vv, [effect], { patchEntry: patch });
    call(r, 'RT_PLAY', 0);
    const ts = [], ws = [], depth = [];
    let badRegs = 0;
    for (let k = 0; k < n; k++) { const f = fireIrq(r, k); ts.push(f.t); ws.push(f.writes); depth.push(f.depth); badRegs += f.bad.length; }
    return { ts, ws, depth, badRegs, r };
  };
  const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { min: s[0], med: s[s.length >> 1], max: s[s.length - 1] }; };

  // idle interrupt
  const idle = (() => { const r = rig(vv, [costs[0]]); const ts = []; for (let k = 0; k < 8; k++) ts.push(fireIrq(r, k).t); return stat(ts); })();
  // three channels: by the number of pairs of an entry (entries 1..40; the first one writes all 11 registers)
  const runs = costs.map((e) => run(e, 42));
  const byN = {};
  NS.forEach((n, i) => { byN[n] = stat(runs[i].ts.slice(1, 41)); });
  const first = stat(runs.map((x) => x.ts[0]));
  const endT = run(effEmpty(3), 3), endT2 = run(effEmpty(0), 3);
  const modelOk = runs.every((x, i) => x.ws.slice(1, 41).every((w, k) => sameW(w, costs[i].items[k + 1])));
  check(`v${v}: the three-channel tick writes exactly the pairs of every entry (n = ${NS.join(', ')}; 40 entries each) with every register kept: all registers, the alternates, IX, IY, SP, I, IM, IFF1 (also at the first entry and the $FF)`, modelOk && runs.every((x) => x.badRegs === 0) && endT.badRegs + endT2.badRegs === 0);
  const dep3 = Math.max(...runs.flatMap((x) => x.depth), ...endT.depth);
  // one channel, with the entry test, and the same build with it jumped over
  const o1 = run(worst1, 41), o2 = run(same1, 41), o3 = run(mix1, 61);
  const p1 = run(worst1, 41, true), p2 = run(same1, 41, true), p3 = run(mix1, 61, true);
  const pairs = [[o1, p1], [o2, p2], [o3, p3]];
  const sameWrites = pairs.every(([x, y]) => JSON.stringify(x.ws) === JSON.stringify(y.ws));
  const deltas = pairs.flatMap(([x, y]) => x.ts.map((t, i) => t - (y.ts[i] - 12)));            // the jumped-over build costs the old tick + the JR's 12 T
  check(`v${v}: a one-channel effect writes exactly what it wrote before the change, in the same order, on every refresh (${o1.ws.length + o2.ws.length + o3.ws.length} refreshes against the build with the entry test jumped over); one-channel tick keeps every register`,
    sameWrites && o1.badRegs + o2.badRegs + o3.badRegs === 0);
  const dMin = Math.min(...deltas), dMax = Math.max(...deltas);
  check(`v${v}: the added cost of the one-channel path is the entry test only: ${dMin}..${dMax} T per refresh (LD A,(nn) / CP 3 / JR Z, not taken = 27 T; the contract says about 25)`, dMin === 27 && dMax === 27);
  const t1 = [...o1.ts.slice(0, 40), ...o2.ts.slice(0, 40), ...o3.ts.slice(0, 60)];
  const s1 = stat(t1);
  const pts = [...p1.ts.slice(0, 40), ...p2.ts.slice(0, 40), ...p3.ts.slice(0, 60)].map((t) => t - 12), sp = stat(pts);
  const typ = stat([3, 4, 5, 6].flatMap((n) => runs[NS.indexOf(n)].ts.slice(1, 41)));
  // the size of the three-channel code: .three .. .end (before the one-channel terminator) and .some .. SND_E
  const S = vv.S;
  const bytes3 = (S['SND_S.end'] - S['SND_S.three']) + (S.SND_E - S['SND_S.some']);
  stats[v] = { idle, s1, sp, byN, first, typ, dep3, dep1: Math.max(...o1.depth, ...o2.depth, ...o3.depth), bytes3, endT: endT.ts[1], endT0: endT.ts[0] };
  console.log(`  v${v} whole interrupt (acceptance, flip, counter, sound; T-states): idle ${idle.min}..${idle.max};  one channel (new) median ${s1.med}, worst ${s1.max}, best ${s1.min};  one channel (before) median ${sp.med}, worst ${sp.max};  tick stack ${stats[v].dep1} bytes (one channel), ${dep3} (three channels), PC + AF of the interrupt included`);
  console.log(`  v${v} three channels by the pairs of the entry (median / worst, T): ` + NS.map((n) => `n=${n}: ${byN[n].med}/${byN[n].max}`).join(', ') + `;  the first entry (all 11 registers) ${first.med};  the $FF (RT_SILENCE inside) ${stats[v].endT0};  the code: ${bytes3} bytes (the group tick it replaces: 142 + SND_W 14)`);
  console.log(`  v${v} contract targets (item 18): no change <= ${TARGET.n0} T [${byN[0].max}], typical 3 to 6 changes <= ${TARGET.typical} T [median ${typ.med}, worst ${typ.max}], 11 changes <= ${TARGET.n11} T [${byN[11].max}], code <= ${TARGET.bytes} bytes [${bytes3}]   (the group tick: median 2,162)`);
  // the numbers this design reaches: the cost is 323 + 72 n T (n >= 1) and 260 T (n = 0) (regression bounds; the contract's targets are in the line above)
  check(`v${v}: cost bounds of the delta tick: n = 0 at most 260 T (${byN[0].max}), n = 3 at most 539 T (${byN[3].max}), n = 6 at most 755 T (${byN[6].max}), n = 11 at most 1,115 T (${byN[11].max}): every entry of at most 6 changes costs under 40% of the group tick's 2,162 median`, byN[0].max <= 260 && byN[3].max <= 539 && byN[6].max <= 755 && byN[11].max <= 1115 && byN[6].max < 0.4 * 2162);
  check(`v${v}: the three-channel code is ${bytes3} bytes (target: at most ${TARGET.bytes}); SND_TICK3 and its gap placement are gone (no symbol SND_TICK3 / SND_W, nothing at $0068 but v4's KEY_ROWSEL)`, bytes3 <= TARGET.bytes && S.SND_TICK3 === undefined && S.SND_W === undefined && S.M_SND3_S === undefined);

  // RT_PLAY / RT_SILENCE register discipline and their cost
  {
    const r = rig(vv, [costs[3], same1]);
    const play0 = call(r, 'RT_PLAY', 0, { bc: 0x1111, de: 0x2222, hl: 0x3333 });
    for (let k = 0; k < 3; k++) fireIrq(r);
    const sw = call(r, 'RT_PLAY', 1);
    const sil = call(r, 'RT_SILENCE', 0, { bc: 0x4444, de: 0x5555, hl: 0x6666 });
    const sil2 = call(r, 'RT_SILENCE');
    check(`v${v}: RT_PLAY and RT_SILENCE keep IX, IY and the alternates and leave SP alone; RT_SILENCE keeps BC, DE, HL as well (RT_PLAY: ${play0.t} T, with the 3 -> 1 silencing ${sw.t} T; RT_SILENCE: ${sil.t} T, already silent ${sil2.t} T)`,
      play0.preserved && play0.spOk && sw.preserved && sw.spOk && sil.preserved && sil.spOk && sil.bc && sil.de && sil.hl && sil2.bc && sil2.de && sil2.hl);
    stats[v].play = [play0.t, sw.t]; stats[v].sil = [sil.t, sil2.t];
  }
}
if (VERS.length === 3) check('the one-channel and three-channel ticks cost the same on v2, v3 and v4 (one code, three builds)', [3, 4].every((v) => stats[v].s1.med === stats[2].s1.med && stats[v].s1.max === stats[2].s1.max && JSON.stringify(stats[v].byN) === JSON.stringify(stats[2].byN) && stats[v].bytes3 === stats[2].bytes3));

// ===================================================================================================================================
// 7. END TO END: a game compiled by the real compiler plays three-channel assets on each build's cartridge
// ===================================================================================================================================
const E2E_ASSETS = {
  sfx: {
    boom: { ticks: Array.from({ length: 24 }, (_, k) => T(300 + 7 * k, 12 - (k >> 2), 5, k % 7 === 0 ? 0 : 1)), ticksB: Array.from({ length: 18 }, (_, k) => T(150 + 3 * k, 9, 3 + (k & 3), (k >> 1) & 3)), ticksC: Array.from({ length: 31 }, (_, k) => T(2000 - 30 * k, 4 + (k & 7), 20 - (k % 9), k & 3)) },
    blip: { ticks: Array.from({ length: 9 }, (_, k) => T(200 + 10 * k, 8, 0, 2)) },
    chord: { ticks: Array.from({ length: 12 }, () => T(400, 10, 0, 2)), ticksB: Array.from({ length: 12 }, () => T(500, 10, 0, 2)), ticksC: Array.from({ length: 12 }, () => T(600, 10, 0, 2)) },
  },
};
const E2E_SRC = `GAME "snd"
FRAMERATE 60
SFX boom = "boom"
SFX blip = "blip"
SFX chord = "chord"
SCENE play
  DIM t
  PROC INIT():
    t = 0
  ENDP
  PROC FRAME():
    t = t + 1
    IF t = 5 THEN PLAY boom ENDIF
    IF t = 20 THEN PLAY blip ENDIF
    IF t = 40 THEN PLAY chord ENDIF
    IF t = 50 THEN PLAY boom ENDIF
    IF t = 58 THEN SILENCE ENDIF
    IF t = 70 THEN PLAY 2 ENDIF
    IF t = 90 THEN PLAY boom ENDIF
  ENDP
ENDSCENE
`;
{
  const rowsOf = { 0: sfxRefreshRegisters(E2E_ASSETS.sfx.boom), 2: sfxRefreshRegisters(E2E_ASSETS.sfx.chord) };
  const digestsE2E = {};
  for (const v of VERS) {
    const vv = BUILDS[v];
    const res = compile(E2E_SRC, { runtime: vv.rt.json, image: vv.rt.img, assets: E2E_ASSETS });
    if (res.errors.length) { check(`v${v}: end to end: the game compiles`, false, JSON.stringify(res.errors[0])); continue; }
    const S = vv.S;
    const m = M.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
    const rom = (f) => readFileSync(join(new URL('../../tsrun/roms', import.meta.url).pathname, f));
    M.setHomeRom(m, rom('ts2068-0.rom')); M.setExRom(m, rom('ts2068-1.rom'));
    M.insertDock(m, res.dck);
    M.resetMachine(m);
    for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
    for (let f = 0; f < 4; f++) M.runFrame(m);                                          // (boot: the runtime zeroes the AY and AY_SHADOW)
    // RT_PLAY's entry: remember the interrupt count and the effect index (A), so the entries applied since are known
    let playing = null, fails = [], playsSeen = 0, refreshesChecked = 0, ends = 0;
    const origRead = m.bus.read;
    m.bus.read = function (a) {
      if (a === S.RT_PLAY) { playsSeen++; playing = { idx: m.cpu.a, f0: rd16(m, S.V_FRAMES), prevCh: rd8(m, S.V_SFX_CH) }; }
      else if (a === S.RT_SILENCE) { const ret = rd16(m, m.cpu.sp); if (!(ret >= S.SND_S && ret < S.SND_E)) playing = null; }      // the game's SILENCE (the tick's own call returns into the sound code)
      return origRead.call(this, a);
    };
    const hash = createHash('sha256');
    let lastSh = '';
    for (let f = 0; f < 700; f++) {
      M.runFrame(m);
      const sh = Array.from({ length: 11 }, (_, k) => rd8(m, S.AY_SHADOW + k)), chip = Array.from({ length: 11 }, (_, k) => m.ay.regs[k]);
      if (JSON.stringify(sh) !== lastSh) { hash.update(JSON.stringify(sh)); lastSh = JSON.stringify(sh); }      // (the sequence of distinct states: the builds boot at different frames)
      if (JSON.stringify(sh) !== JSON.stringify(chip)) fails.push({ f, why: 'AY_SHADOW differs from the chip', sh, chip });
      if (playing && rowsOf[playing.idx]) {
        const rows = rowsOf[playing.idx], applied = ((rd16(m, S.V_FRAMES) - playing.f0) & 0xFFFF);
        if (applied >= 1 && applied <= rows.length) { refreshesChecked++; if (JSON.stringify(sh) !== JSON.stringify(rows[applied - 1])) fails.push({ f, idx: playing.idx, applied, why: 'registers differ from sfxRefreshRegisters', sh, want: rows[applied - 1] }); }
        else if (applied === rows.length + 1) { ends++; if (rd8(m, S.V_SFX_ACTIVE) !== 0 || sh[8] !== 0 || sh[9] !== 0 || sh[10] !== 0) fails.push({ f, idx: playing.idx, why: 'the end of the stream left the effect on or a volume up', sh }); }
      }
      if (playing && playing.idx === 1 && ((rd16(m, S.V_FRAMES) - playing.f0) & 0xFFFF) >= 1 && ((rd16(m, S.V_FRAMES) - playing.f0) & 0xFFFF) <= 9 && (sh[9] || sh[10])) fails.push({ f, why: 'a one-channel effect over a three-channel one left B or C on', sh });
    }
    digestsE2E[v] = hash.digest('hex');
    check(`v${v}: end to end: the compiled game PLAYs a three-channel asset, a one-channel one over it, a chord (by name and by index 2), SILENCE: ${playsSeen} RT_PLAY calls, ${refreshesChecked} refreshes equal to the rows of sfxRefreshRegisters, ${ends} ends with the volumes 0, AY_SHADOW = chip on every refresh`,
      fails.length === 0 && playsSeen >= 6 && refreshesChecked >= 24 + 12 + 12 + 24 && ends >= 2, fails.length ? JSON.stringify(fails[0]) : '');
  }
  if (VERS.length === 3) check('end to end: the sequence of AY states (the shadow after every refresh, repeats collapsed) is the same on v2, v3 and v4', digestsE2E[2] === digestsE2E[3] && digestsE2E[3] === digestsE2E[4]);
}

// ===================================================================================================================================
// 6. the three runtimes behave identically
// ===================================================================================================================================
if (VERS.length === 3) check('v2, v3 and v4 gave the same AY writes on every refresh of every scenario (SHA-256 of all of them equal)', digests[3].join() === digests[2].join() && digests[4].join() === digests[2].join(), digests[2].map((d) => d.slice(0, 6)).join(' '));

void hex;
finish('M10 runtime sound');
