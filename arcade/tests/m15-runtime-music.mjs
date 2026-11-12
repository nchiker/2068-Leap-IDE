"use strict";
// m15-runtime-music.mjs -- MUSIC in the runtimes v2, v3 and v4 (sound.asm, one file in all three; docs/ARCADE_MUSIC_CONTRACT.md section 5): RT_MUSIC,
// RT_NOMUSIC, songs in the frame interrupt, and the sharing of the AY with effects (a channel-C effect borrows C, an effect of type 1 / 3 pauses the song,
// SND_SYNC gives the registers back).  On a stock TS2068 (TSRun).
//
//  1. A JavaScript MODEL of the chip, written from the contract (not from the Z80 source), against the machine after EVERY refresh (real frames) and
//     every call: the (register, value) writes in order, the chip's R0-R10, AY_SHADOW, MUS_SHADOW (while a song plays) and V_SFX_ACTIVE.
//  2. Hand scenarios: a song alone (waits, pattern changes, the loop, the end without a loop), a channel-C effect starting and ending mid-song (also in a
//     wait and on a pattern change), with and without noise, a three-channel effect pausing and resuming the song, SILENCE / NOMUSIC / PLAY / MUSIC in
//     every state, an effect replacing another during a song, a song replacing a song.
//  3. Random scripts: random tables of effects (one channel, three channels, channel C) and songs, random calls between refreshes, every build.
//  4. An interrupt at EVERY instruction boundary of RT_PLAY, RT_SILENCE, RT_MUSIC and RT_NOMUSIC while a song (and an effect) plays: the select / data
//     pairs are never split, AY_SHADOW = the chip, and two refreshes later every register no effect owns holds the song's value.
//  5. Register discipline of the tick and the routines, the tick's stack depth, the costs (whole interrupt) by case.
//   node arcade/tests/m15-runtime-music.mjs                M15_VERSIONS=3 for one build
import * as C3 from './m3-common.mjs';
import { rng } from './m3-scenes.mjs';
import { convertMusic, convertSfx, convertSfxC } from '../../src/lang/arcade/arcade-assets.js';
const { M, Z, makeChecks, rd8, rd16, newMachine, bootMachine, callRoutine } = C3;

const { check, finish } = makeChecks();
console.log('M15 runtime music: songs in the interrupt and the shared AY (RT_MUSIC, RT_NOMUSIC, RT_PLAY, RT_SILENCE) on runtime v2, v3, v4\n');

const VERS = (process.env.M15_VERSIONS ?? '2,3,4').split(',').map(Number);
const BUILDS = {};
for (const v of VERS) {
  const mod = await import(`../tools/build-runtime-v${v}.mjs`);
  const rt = mod.buildRuntime();
  BUILDS[v] = { v, mod, rt, S: rt.syms, K: rt.json.constants };
}
const SB_FX = 1, SB_MUS = 2, SB_SYNC = 4;
const QUICK = !!process.env.M15_QUICK;                       // the mutation runs: fewer random scripts, every third interrupt boundary

// ---- assets ----------------------------------------------------------------------------------------------------------------------------
let R = rng(1515);
const T = (tone, vol, mix = 6, noise = 0) => ({ tone, vol, mix, noise });
const randTick = () => { const t = T(R.int(1, 3000), R.int(0, 15), R.pick([0, 1, 2, 3, 6, 7]), R.int(0, 31)); return t; };
function randTrack(len, still) {
  const out = [];
  let cur = randTick();
  for (let i = 0; i < len; i++) { if (!still && R.chance(0.35)) cur = randTick(); out.push({ ...cur }); }
  return out;
}
function randPattern(maxLen = 40) {
  const L = R.int(1, maxLen), still = R.chance(0.3);
  return { ticks: randTrack(L, still), ticksB: R.chance(0.8) ? randTrack(R.int(0, L), still) : [], ticksC: R.chance(0.8) ? randTrack(R.int(0, L), still) : [] };
}
function randSong() {
  const np = R.int(1, 4), patterns = Array.from({ length: np }, () => randPattern(R.pick([3, 12, 40, 200])));
  const order = Array.from({ length: R.int(1, 5) }, () => R.int(0, np - 1));
  return { patterns, order, loop: R.chance(0.35) ? null : R.int(0, order.length - 1) };
}
const eff1 = (n) => ({ kind: 'one', ...convertSfx({ ticks: Array.from({ length: n }, randTick) }) });
const eff3 = (n) => ({ kind: 'three', ...convertSfx({ ticks: Array.from({ length: n }, randTick), ticksB: Array.from({ length: R.int(1, n) }, randTick), ticksC: Array.from({ length: R.int(0, n) }, randTick) }) });
const effC = (n, noise = R.chance(0.5)) => ({ kind: 'C', ...convertSfxC({ ticks: Array.from({ length: n }, () => { const t = randTick(); if (!noise) t.mix |= 2; return t; }) }) });

// ---- the image: effects at $9000 (table) / $9040, songs from $A000 (layout of the contract: loop, DW patterns, DW 0, the pattern streams) ----
function layoutSong(c, base) {
  const out = [c.loop];
  let at = base + 1 + 2 * (c.order.length + 1);
  const pat = c.patterns.map((p) => { const a = at; at += p.bytes.length; return a; });
  c.order.forEach((p) => out.push(pat[p] & 255, pat[p] >> 8));
  out.push(0, 0);
  c.patterns.forEach((p) => out.push(...p.bytes));
  return out;
}
function image(vv, effects, songs) {
  const img = Uint8Array.from(vv.rt.img);
  const TAB = 0x9000, tab = [effects.length];
  let at = TAB + 0x40;
  for (const e of effects) { tab.push(at & 255, at >> 8); img.set(e.bytes, at); at += e.bytes.length; }
  if (at > 0xA000) throw new Error('effects too long');
  img.set(tab, TAB);
  img[vv.K.GAME_SFX] = TAB & 255; img[vv.K.GAME_SFX + 1] = TAB >> 8;
  let sa = 0xA000;
  const songAt = songs.map((c) => { const bytes = layoutSong(c, sa); img.set(bytes, sa); const a = sa; sa += bytes.length; return a; });
  if (sa > 0xC000) throw new Error('songs too long');
  return { img, dck: vv.mod.dckOf(img), songAt };
}

// ---- the rig -----------------------------------------------------------------------------------------------------------------------------
const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl', 'sp', 'i', 'im', 'iff1'];
const snap = (cpu) => Object.fromEntries(KEYS.map((k) => [k, cpu[k]]));
function readyForIrq(m) {
  const cpu = m.cpu;
  cpu.halted = false;
  for (let i = 0; i < 100000 && !(cpu.iff1 && !cpu.eiDelay); i++) Z.runZ80(cpu, m.bus, 1, m);
}
function rig(vv, effects, songs) {
  const { dck, songAt } = image(vv, effects, songs);
  const m = newMachine(dck);
  bootMachine(m, vv.S);
  // RAM above the stack is not cleared by the boot (the hand-off record aside): fill the music page's state with junk, as a real machine may have it
  for (let a = vv.S.MUS_SHADOW; a < vv.S.MUS_OWN + 16; a++) m.bus.write(a, (0xA5 + 37 * a) & 0xFF);
  readyForIrq(m);
  const log = [];
  const o = m.bus.ioWrite;
  m.bus.ioWrite = (p, v) => { if ((p & 255) === 0xF5 || (p & 255) === 0xF6) log.push([p & 255, v]); o(p, v); };
  const take = () => {
    const w = log.splice(0), pairs = [];
    for (let k = 0; k < w.length; k += 2) { if (!w[k + 1] || w[k][0] !== 0xF5 || w[k + 1][0] !== 0xF6) return null; pairs.push([w[k][1], w[k + 1][1]]); }
    return pairs;
  };
  take();
  return { vv, S: vv.S, m, songAt, take, log };
}
function frame(r) {
  const f0 = rd16(r.m, r.S.V_FRAMES);
  M.runFrame(r.m);
  return (rd16(r.m, r.S.V_FRAMES) - f0) & 0xFFFF;
}
function call(r, name, { a = 0, bc = 0x1234, de = 0x5678, hl = 0x9ABC } = {}) {
  r.take();
  const out = callRoutine(r.m, r.S[name], { a, bc, de, hl });
  return { writes: r.take(), preserved: out.preserved, spOk: out.spOk, bc: out.bc === bc, de: out.de === de, hl: out.hl === hl, t: out.t };
}
/** A synthetic frame interrupt run to its RET: {t, writes, bad (registers not kept), depth}. */
function fireIrq(r, sentinel = 0) {
  const m = r.m, cpu = m.cpu;
  readyForIrq(m);
  r.take();
  const pc0 = cpu.pc, before = snap(cpu), t0 = m.tstates;
  KEYS.forEach((key, i) => { if (!['sp', 'i', 'im', 'iff1'].includes(key)) cpu[key] = (0x3C + 29 * i + sentinel) & 0xFF; });
  const sent = snap(cpu), sp0 = cpu.sp;
  Z.irqZ80(cpu, m.bus);
  let steps = 0, spMin = cpu.sp;
  while (!(cpu.pc === pc0 && cpu.sp === sp0) && steps++ < 20000) { Z.runZ80(cpu, m.bus, 1, m); if (cpu.sp < spMin) spMin = cpu.sp; }
  if (steps >= 20000) throw new Error('the interrupt did not return');
  const t = m.tstates - t0, after = snap(cpu);
  const bad = KEYS.filter((k) => after[k] !== sent[k]);
  for (const key of KEYS) cpu[key] = before[key];
  return { t, writes: r.take(), bad, depth: sp0 - spMin };
}

// ---- the model (from the contract) ------------------------------------------------------------------------------------------------------
class Model {
  constructor(effects, songs) {
    this.effects = effects; this.songs = songs;
    this.chip = new Array(11).fill(0);                       // = AY_SHADOW (the boot zeroed both)
    this.mus = new Array(11).fill(0);
    this.own = new Array(11).fill(0);
    this.fx = null; this.song = null; this.pending = false; this.fxType = 1;
  }
  get flags() { return (this.fx ? SB_FX : 0) | (this.song ? SB_MUS : 0) | (this.pending ? SB_SYNC : 0); }
  put(w, r, v) { this.chip[r] = v; w.push([r, v]); }
  putIf(w, r, v) { if (this.chip[r] !== v) this.put(w, r, v); }
  ownFor(type) {
    const o = new Array(11).fill(0);
    const set = type === 0 ? [] : type === 1 ? [0, 1, 6, 7, 8] : type === 3 ? [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : type === 4 ? [4, 5, 10] : [4, 5, 6, 10];
    set.forEach((r) => { o[r] = 1; });
    if (type >= 4) o[7] = 2;
    return o;
  }
  sync(w) {
    if (this.song) {
      for (let r = 0; r <= 10; r++) {
        if (this.own[r] === 1) continue;
        const v = this.own[r] === 2 ? (this.mus[r] & 0xDB) | (this.chip[7] & 0x24) : this.mus[r];
        this.putIf(w, r, v);
      }
    } else for (let r = 8; r <= 10; r++) if (this.own[r] === 0) this.putIf(w, r, 0);
  }
  // main-thread calls -> the writes they make
  play(i) {
    const w = [];
    if (i >= Math.min(this.effects.length, 8)) return w;
    const e = this.effects[i], b = e.bytes;
    const type = b[3] === 3 ? 3 : b[3] === 4 ? 4 + b[2] : 1;
    this.fx = { e, type, pos: type === 1 ? 0 : 4 }; this.fxType = type;
    this.own = this.ownFor(type);
    const busy = this.song || this.pending;
    this.fx = null;                                           // (RT_PLAY looks at the other bits with SB_FX cleared)
    if (busy) this.pending = true; else this.sync(w);
    this.fx = { e, type, pos: type === 1 ? 0 : 4 };
    return w;
  }
  silence() {
    const w = [];
    this.fx = null; this.own = this.ownFor(0);
    if (this.song || this.pending) this.pending = true; else this.sync(w);
    return w;
  }
  music(k) {
    if (!this.fx) this.own = this.ownFor(0);
    this.mus = this.chip.slice();
    const s = this.songs[k];
    this.song = { s, ord: 0, at: 0, pat: s.order[0], wait: 0 };
    return [];
  }
  nomusic() {
    const w = [];
    if (!this.song) return w;
    this.song = null;
    if (this.fx || this.pending) this.pending = true; else this.sync(w);
    return w;
  }
  // one refresh (the interrupt) -> its writes
  refresh() {
    const w = [];
    if (!this.flags) return w;
    if (this.pending) { this.pending = false; this.sync(w); }
    if (this.fx) this.fxStep(w);
    if (this.song && !(this.fx && this.fxType < 4)) this.songStep(w);
    return w;
  }
  fxEnd(w) { this.fx = null; this.own = this.ownFor(0); this.sync(w); }
  fxStep(w) {
    const f = this.fx, b = f.e.bytes;
    if (f.type === 1) {
      const p = f.pos; f.pos += 4;
      if (b[p + 1] === 0xFF) return this.fxEnd(w);
      const tone = b[p] | ((b[p + 1] & 15) << 8), mix = b[p + 2] >> 5;
      let r7 = 0x36 | (mix & 1) | ((mix & 2) << 2);
      this.putIf(w, 0, tone & 255); this.putIf(w, 1, tone >> 8); this.putIf(w, 6, b[p + 2] & 31); this.putIf(w, 7, r7); this.putIf(w, 8, b[p + 1] >> 4);
      return;
    }
    const n = b[f.pos++];
    if (n === 0xFF) return this.fxEnd(w);
    for (let k = 0; k < n; k++) {
      const r = b[f.pos++]; let v = b[f.pos++];
      if (f.type >= 4 && r === 7) v = (v & 0x24) | (this.chip[7] & 0xDB);
      this.put(w, r, v);
    }
  }
  songStep(w) {
    const g = this.song, c = g.s;
    if (g.wait > 0) { g.wait--; return; }
    for (;;) {
      const bytes = c.patterns[g.pat].bytes, x = bytes[g.at++];
      if (x === 0xFF) {
        g.ord++;
        if (g.ord >= c.order.length) {
          if (c.loop === 0xFF) { this.song = null; this.sync(w); return; }
          g.ord = c.loop;
        }
        g.pat = c.order[g.ord]; g.at = 0;
        continue;
      }
      if (x >= 0x80) { g.wait = x - 0x80; return; }
      for (let k = 0; k < x; k++) {
        const r = bytes[g.at++], v = bytes[g.at++];
        this.mus[r] = v;
        if (this.own[r] === 1) continue;
        this.put(w, r, this.own[r] === 2 ? (v & 0xDB) | (this.chip[7] & 0x24) : v);
      }
      return;
    }
  }
}

// ---- running a script: ops[t] = calls before refresh t; checks after every call and every refresh ------------------------------------------
const sameW = (a, b) => a !== null && JSON.stringify(a) === JSON.stringify(b);
function runScript(r, model, ops, nref, tag) {
  const { m, S } = r, fails = [];
  const fail = (why, extra) => { if (fails.length < 3) fails.push({ tag, why, ...extra }); };
  const state = (t, when) => {
    for (let k = 0; k < 11; k++) {
      if (m.ay.regs[k] !== model.chip[k] || rd8(m, S.AY_SHADOW + k) !== model.chip[k]) { fail('chip / AY_SHADOW', { t, when, reg: k, chip: m.ay.regs[k], shadow: rd8(m, S.AY_SHADOW + k), want: model.chip[k] }); return; }
      if (model.song && rd8(m, S.MUS_SHADOW + k) !== model.mus[k]) { fail('MUS_SHADOW', { t, when, reg: k, got: rd8(m, S.MUS_SHADOW + k), want: model.mus[k] }); return; }
    }
    if (rd8(m, S.V_SFX_ACTIVE) !== model.flags) fail('V_SFX_ACTIVE', { t, when, got: rd8(m, S.V_SFX_ACTIVE), want: model.flags });
  };
  M.runFrame(m);                       // (the interrupt of a refresh is accepted at the end of runFrame and runs at the start of the next: the steady state)
  r.take();
  let nwrites = 0;
  for (let t = 0; t < nref; t++) {
    for (const o of ops[t] ?? []) {
      let got, want;
      if ('play' in o) { got = call(r, 'RT_PLAY', { a: o.play }); want = model.play(o.play); }
      else if ('music' in o) { got = call(r, 'RT_MUSIC', { hl: r.songAt[o.music] }); want = model.music(o.music); }
      else if (o.nomusic) { got = call(r, 'RT_NOMUSIC'); want = model.nomusic(); }
      else { got = call(r, 'RT_SILENCE'); want = model.silence(); }
      if (!sameW(got.writes, want)) fail('call writes', { t, op: o, got: got.writes, want });
      if (!got.preserved || !got.spOk) fail('call registers', { t, op: o });
      state(t, 'after ' + JSON.stringify(o));
    }
    const fr = frame(r), want = model.refresh(), got = r.take();
    if (fr !== 1) fail('frames', { t, fr });
    if (!sameW(got, want)) fail('refresh writes', { t, got, want });
    nwrites += want.length;
    state(t, 'refresh');
    if (fails.length) break;
  }
  return { fails, nwrites };
}

// ===================================================================================================================================
for (const v of VERS) {
  const vv = BUILDS[v], S = vv.S;
  console.log(`v${v}:`);
  R = rng(1500 + v);
  // ---- 2. hand scenarios ----
  const held = { patterns: [{ ticks: Array.from({ length: 30 }, () => T(400, 12)), ticksB: Array.from({ length: 30 }, (_, k) => T(800, 9 - (k >> 3))), ticksC: Array.from({ length: 30 }, () => T(600, 10)) },
    { ticks: Array.from({ length: 8 }, (_, k) => T(300 + k, 13, 6)), ticksB: [T(200, 0, 7)], ticksC: Array.from({ length: 8 }, (_, k) => T(150, 8, k & 1 ? 2 : 0, 5 + k)) }], order: [0, 1, 0], loop: 1 };
  const once = { patterns: [{ ticks: [T(100, 5), T(100, 5), T(101, 6)], ticksB: [T(90, 4)], ticksC: [T(80, 3, 6)] }], order: [0, 0], loop: null };
  const songs = [held, once].map(convertMusic);
  const effs = [effC(12, false), effC(9, true), eff3(10), eff1(7), effC(1, false), eff3(1)];
  const scenarios = [
    ['a song alone: waits, pattern changes, the loop to order position 1', [[0, { music: 0 }]], 200],
    ['a song that does not loop ends: its volumes go to 0, SB_MUS clears', [[0, { music: 1 }]], 20],
    ['a channel-C effect (no noise) mid-song, in a wait', [[0, { music: 0 }], [5, { play: 0 }]], 60],
    ['a channel-C effect with noise mid-song, on a pattern change (refresh 30)', [[0, { music: 0 }], [30, { play: 1 }]], 70],
    ['a three-channel effect pauses the song; it resumes where it stopped', [[0, { music: 0 }], [10, { play: 2 }]], 70],
    ['a one-channel (type 1) effect pauses the song', [[0, { music: 0 }], [10, { play: 3 }]], 50],
    ['SILENCE during a channel-C effect: the song gets C back at the next refresh', [[0, { music: 0 }], [4, { play: 0 }], [7, {}]], 30],
    ['SILENCE during a three-channel effect: the song resumes', [[0, { music: 0 }], [4, { play: 2 }], [7, {}]], 30],
    ['SILENCE with only a song: nothing changes', [[0, { music: 0 }], [6, {}]], 20],
    ['NOMUSIC during a channel-C effect: A and B volumes to 0, the effect plays on', [[0, { music: 0 }], [4, { play: 0 }], [6, { nomusic: true }]], 30],
    ['NOMUSIC while paused by a three-channel effect, then the effect ends', [[0, { music: 0 }], [4, { play: 2 }], [6, { nomusic: true }]], 30],
    ['NOMUSIC with nothing else: the volumes to 0 at once', [[0, { music: 0 }], [6, { nomusic: true }]], 12],
    ['an effect replaces another during a song (C -> 3 -> C -> 1)', [[0, { music: 0 }], [3, { play: 0 }], [6, { play: 2 }], [9, { play: 1 }], [12, { play: 3 }]], 40],
    ['a song replaces a song, also during an effect', [[0, { music: 0 }], [8, { music: 1 }], [9, { play: 0 }], [11, { music: 0 }]], 50],
    ['MUSIC while a three-channel effect plays: the song starts when it ends', [[0, { play: 2 }], [2, { music: 0 }]], 40],
    ['MUSIC while a channel-C effect plays: A and B at once, C after it', [[0, { play: 0 }], [2, { music: 0 }]], 40],
    ['a one-refresh C effect and a one-refresh three-channel effect', [[0, { music: 0 }], [2, { play: 4 }], [5, { play: 5 }]], 20],
    ['effects with no song (C, then 3, then C, then SILENCE): the volumes they do not own go to 0', [[0, { play: 0 }], [3, { play: 2 }], [5, { play: 1 }], [8, {}]], 30],
    ['MUSIC twice in the same refresh, NOMUSIC twice, SILENCE twice', [[0, { music: 0 }, { music: 0 }], [3, { nomusic: true }, { nomusic: true }], [4, {}, {}], [5, { music: 1 }]], 30],
  ];
  let sOk = 0, sFirst = '';
  for (const [name, list, n] of scenarios) {
    const r = rig(vv, effs, songs), model = new Model(effs, songs), ops = [];
    for (const [t, ...os] of list) (ops[t] ??= []).push(...os);
    const res = runScript(r, model, ops, n, name);
    if (res.fails.length) sFirst ||= `${name}: ${JSON.stringify(res.fails[0])}`; else sOk++;
  }
  check(`v${v}: ${sOk}/${scenarios.length} hand scenarios equal the model on every call and refresh (writes in order, chip, AY_SHADOW, MUS_SHADOW, V_SFX_ACTIVE)`, sOk === scenarios.length, sFirst);

  // ---- 3. random scripts ----
  let rOk = 0, rFirst = '', rW = 0, rRef = 0;
  const NR = Number(process.env.M15_RANDOM ?? (QUICK ? 8 : 24));
  for (let k = 0; k < NR; k++) {
    const effects = Array.from({ length: R.int(1, 8) }, () => R.pick([eff1, eff3, effC])(R.int(1, 30)));
    const ss = Array.from({ length: R.int(1, 3) }, randSong).map(convertMusic);
    const r = rig(vv, effects, ss), model = new Model(effects, ss), ops = [], n = 160;
    for (let t = 0; t < n; t++) {
      if (!R.chance(0.15)) continue;
      const list = (ops[t] = []);
      for (let j = R.int(1, 2); j > 0; j--) {
        const x = R.next();
        list.push(x < 0.4 ? { play: R.int(0, 9) } : x < 0.65 ? { music: R.int(0, ss.length - 1) } : x < 0.8 ? { nomusic: true } : {});
      }
    }
    (ops[0] ??= []).unshift({ music: 0 });
    const res = runScript(r, model, ops, n, 'random ' + k);
    rW += res.nwrites; rRef += n;
    if (res.fails.length) rFirst ||= JSON.stringify(res.fails[0]); else rOk++;
  }
  check(`v${v}: ${rOk}/${NR} random scripts (effects of all three kinds, 1-3 songs, random calls also past the table; ${rRef} refreshes, ${rW} AY writes) equal the model`, rOk === NR, rFirst);

  // ---- 4. an interrupt at every instruction boundary of the four routines ----
  {
    let trials = 0, bad = 0, first = '';
    const cases = [
      ['RT_PLAY C over a song', [{ music: 0 }], { play: 0 }], ['RT_PLAY 3 over a song and a C effect', [{ music: 0 }, { play: 1 }], { play: 2 }],
      ['RT_SILENCE of a C effect', [{ music: 0 }, { play: 0 }], {}], ['RT_SILENCE of a 3 effect', [{ music: 0 }, { play: 2 }], {}],
      ['RT_MUSIC over a song and a C effect', [{ music: 0 }, { play: 1 }], { music: 1 }], ['RT_MUSIC with nothing', [], { music: 0 }],
      ['RT_NOMUSIC with a C effect', [{ music: 0 }, { play: 0 }], { nomusic: true }], ['RT_NOMUSIC alone', [{ music: 0 }], { nomusic: true }],
    ];
    for (const [name, setup, op] of cases) {
      // the routine's length in instructions, from a run without interrupts
      const probe = rig(vv, effs, songs);
      const doOp = (r, o) => ('play' in o ? callRoutine(r.m, S.RT_PLAY, { a: o.play }) : 'music' in o ? callRoutine(r.m, S.RT_MUSIC, { hl: r.songAt[o.music] }) : o.nomusic ? callRoutine(r.m, S.RT_NOMUSIC, {}) : callRoutine(r.m, S.RT_SILENCE, {}));
      for (const o of setup) { doOp(probe, o); frame(probe); frame(probe); }
      const name2 = 'play' in op ? 'RT_PLAY' : 'music' in op ? 'RT_MUSIC' : op.nomusic ? 'RT_NOMUSIC' : 'RT_SILENCE';
      const steps = 3000;                                    // (the loop stops at the first trial whose interrupt comes after the routine has returned)
      for (let at = 0; at < steps; at += QUICK ? 3 : 1) {
        const r = rig(vv, effs, songs);
        for (const o of setup) { doOp(r, o); frame(r); frame(r); }
        r.take();
        // run the routine by hand, with one synthetic interrupt after `at` instructions
        const m = r.m, cpu = m.cpu;
        readyForIrq(m);
        const pc0 = cpu.pc, sp0 = cpu.sp;
        cpu.sp = (cpu.sp - 2) & 0xFFFF; m.bus.write(cpu.sp, pc0 & 255); m.bus.write((cpu.sp + 1) & 0xFFFF, pc0 >> 8);
        cpu.a = 'play' in op ? op.play : 0;
        if ('music' in op) { cpu.h = r.songAt[op.music] >> 8; cpu.l = r.songAt[op.music] & 255; }
        cpu.pc = S[name2];
        let n = 0, done = false, fired = false;
        while (n++ < 100000) {
          if (cpu.pc === pc0 && cpu.sp === sp0) { done = true; break; }
          if (!fired && n > at && cpu.iff1 && !cpu.eiDelay) {
            fired = true;
            Z.irqZ80(cpu, m.bus);
            const spI = cpu.sp, pcI = m.bus.read(spI) | (m.bus.read(spI + 1) << 8);
            let k = 0; while (!(cpu.pc === pcI && cpu.sp === spI + 2) && k++ < 20000) Z.runZ80(cpu, m.bus, 1, m);
            continue;
          }
          Z.runZ80(cpu, m.bus, 1, m);
        }
        trials++;
        const w = r.take();
        frame(r); frame(r);
        const w2 = r.take();
        let why = '';
        if (!done) why = 'did not return';
        else if (w === null || w2 === null) why = 'a select / data pair was split';
        else {
          for (let k = 0; k < 11 && !why; k++) if (m.ay.regs[k] !== rd8(m, S.AY_SHADOW + k)) why = `AY_SHADOW R${k} differs from the chip`;
          const flags = rd8(m, S.V_SFX_ACTIVE);
          if (!why && (flags & SB_MUS) && !((flags & SB_FX) && rd8(m, S.V_SFX_CH) < 4)) {
            for (let k = 0; k < 11 && !why; k++) {
              const own = rd8(m, S.MUS_OWN + k), mus = rd8(m, S.MUS_SHADOW + k), chip = m.ay.regs[k];
              const want = own === 2 ? (mus & 0xDB) | (chip & 0x24) : mus;
              if (own !== 1 && chip !== want) why = `R${k} = ${chip}, the song's ${want} (owner ${own})`;
            }
          }
          if (!why && !(flags & SB_MUS) && !(flags & SB_FX)) for (let k = 8; k <= 10 && !why; k++) if (m.ay.regs[k]) why = `R${k} = ${m.ay.regs[k]} with nothing playing`;
        }
        if (why) { bad++; first ||= `${name}, interrupt after ${at} instructions: ${why}`; }
        if (!fired) break;                                    // past the routine's end
      }
    }
    check(`v${v}: an interrupt at every instruction boundary of RT_PLAY, RT_SILENCE, RT_MUSIC, RT_NOMUSIC with a song playing (${cases.length} situations, ${trials} trials): no split select / data pair, AY_SHADOW = chip, two refreshes later every register no effect owns holds the song's value (none playing: volumes 0)`,
      bad === 0 && trials > 100, first || `${trials} trials`);
  }

  // ---- 5. registers, stack, costs ----
  {
    const stat = (a) => { const s = [...a].sort((x, y) => x - y); return { min: s[0], med: s[s.length >> 1], max: s[s.length - 1] }; };
    const measure = (setup, n) => {
      const r = rig(vv, effs, songs);
      for (const o of setup) ('play' in o ? call(r, 'RT_PLAY', { a: o.play }) : call(r, 'RT_MUSIC', { hl: r.songAt[o.music] }));
      const ts = [], bad = [], depth = [];
      for (let k = 0; k < n; k++) { const f = fireIrq(r, k); ts.push(f.t); bad.push(...f.bad); depth.push(f.depth); }
      return { ts, bad, depth: Math.max(...depth) };
    };
    const songOnly = measure([{ music: 0 }], 120), withC = measure([{ music: 0 }, { play: 0 }], 12), paused = measure([{ music: 0 }, { play: 2 }], 9);
    // a wait refresh vs a refresh with pairs: from the song's own items (pattern 0 of `held` holds for 7, 7, 7 refreshes after changes in B)
    const sw = stat(songOnly.ts.slice(1));
    const regsOk = [songOnly, withC, paused].every((x) => x.bad.length === 0);
    const depth = Math.max(songOnly.depth, withC.depth, paused.depth);
    console.log(`  v${v} whole interrupt with a song (T): min ${sw.min} (a wait), median ${sw.med}, max ${sw.max} (a pattern change: 11 pairs);  song + channel-C effect: ${stat(withC.ts.slice(1)).med} median, ${Math.max(...withC.ts)} max;  paused: ${stat(paused.ts.slice(1)).med};  stack ${depth} bytes`);
    check(`v${v}: the tick keeps every register (the alternates, IX, IY, I, IM, IFF1) with a song, with a song and a C effect, and while paused; stack depth ${depth} bytes (<= 16)`, regsOk && depth <= 16);
    const r = rig(vv, effs, songs);
    const mu = call(r, 'RT_MUSIC', { hl: r.songAt[0] }), nm = call(r, 'RT_NOMUSIC');
    check(`v${v}: RT_MUSIC (${mu.t} T) and RT_NOMUSIC (${nm.t} T) keep IX, IY and the alternates and leave SP alone`, mu.preserved && mu.spOk && nm.preserved && nm.spOk);
    const r0 = rig(vv, effs, songs), z = call(r0, 'RT_MUSIC', { hl: 0 });
    check(`v${v}: RT_MUSIC with HL = 0 does nothing (V_SFX_ACTIVE ${rd8(r0.m, S.V_SFX_ACTIVE)}, no writes)`, rd8(r0.m, S.V_SFX_ACTIVE) === 0 && z.writes.length === 0);
    console.log(`  v${v} the sound module: ${S.M_SOUND_E - S.M_SOUND_S} bytes`);
  }
}

finish('M15 runtime music');
