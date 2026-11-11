"use strict";
// sfx-stream.mjs -- the three-channel sound image of language batch 5 (docs/ARCADE_LANGUAGE_BATCH5.md items 16, 17, 18):
// convertSfx's delta stream against an independent STREAM PLAYER (item 18: applies the entries to an 11-register state) and against the
// registers computed directly from the channel records by the rule of item 16 (written here from the contract text, not from the encoder).
//   node tests/sfx-stream.mjs
import { convertSfx, sfxRefreshRegisters, sfxStreamLength } from '../src/lang/arcade/arcade-assets.js';
import { sfxInfo, fromAsset } from '../src/tools/sound-model.js';

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) console.log(`  FAIL  ${name}${detail ? '  (' + detail + ')' : ''}`);
  else console.log(`  PASS  ${name}`);
  cond ? passed++ : failed++;
  return cond;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── the contract, as a model ────────────────────────────────────────────────────────────────────────────────────
const SILENT = { tone: 0, vol: 0, noise: 0, mix: 7 };
/** The 11 AY registers of one refresh, from the three channels' records (item 16), written independently of the encoder. */
function modelRegisters(recs) {            // recs = [recA, recB, recC], each {tone, vol, noise, mix}
  const R = Array(11).fill(0);
  for (let c = 0; c < 3; c++) {
    R[2 * c] = recs[c].tone % 256;
    R[2 * c + 1] = Math.floor(recs[c].tone / 256) & 15;
    R[8 + c] = recs[c].vol;
  }
  // one noise generator: the noise of the lowest channel whose record has noise ON (mix bit 1 = 0), none: A's noise
  let n = recs[0].noise;
  for (let c = 0; c < 3; c++) if (((recs[c].mix >> 1) & 1) === 0) { n = recs[c].noise; break; }
  R[6] = n & 31;
  // mixer: bit c = tone off of channel c, bit 3 + c = noise off of channel c, bits 6 and 7 zero
  let m = 0;
  for (let c = 0; c < 3; c++) {
    if (recs[c].mix & 1) m += 2 ** c;
    if (recs[c].mix & 2) m += 2 ** (3 + c);
  }
  R[7] = m;
  return R;
}
/** The registers after every refresh, from an asset. */
function modelAll(asset) {
  const ch = [asset.ticks ?? [], asset.ticksB ?? [], asset.ticksC ?? []];
  const L = Math.max(...ch.map((c) => c.length));
  const out = [];
  for (let r = 0; r < L; r++) out.push(modelRegisters(ch.map((c) => (r < c.length ? c[r] : SILENT))));
  return out;
}
/** The stream player of item 18: header, then one entry per refresh applied to an 11-register state; $FF ends.  Returns {states, entries, errors}. */
function play(bytes) {
  const errors = [];
  if (!(bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 0 && bytes[3] === 3)) errors.push('header');
  const state = Array(11).fill(null), states = [], entries = [];
  let p = 4;
  while (true) {
    if (p >= bytes.length) { errors.push('ran off the end'); break; }
    const n = bytes[p++];
    if (n === 0xFF) break;
    if (n > 11) { errors.push(`entry count ${n}`); break; }
    const regs = [];
    for (let i = 0; i < n; i++) { const reg = bytes[p++], v = bytes[p++]; regs.push(reg); if (reg > 10) errors.push(`reg ${reg}`); state[reg] = v; }
    entries.push(regs);
    states.push(state.slice());
  }
  if (p !== bytes.length) errors.push('bytes after $FF');
  return { states, entries, errors };
}

const rnd = rng(20261110);
const pick = (n) => Math.floor(rnd() * n);
/** A random record that convertSfx accepts (the unstorable rule respected). */
function record(style) {
  const tone = style === 0 ? pick(4096) : style === 1 ? 3840 + pick(256) : pick(3);
  let vol = rnd() < 0.3 ? 15 : pick(16);
  if (((tone >> 8) | (vol << 4)) === 0xFF) vol = 14;
  return { tone, vol, noise: pick(32), mix: pick(8) };
}
function channel(n, style) { return Array.from({ length: n }, () => record(style)); }

// ── 1. random assets against the player and the model ─────────────────────────────────────────────────────────────
console.log('1. Random three-channel assets: the stream player against the register model');
{
  const N = 3500;
  const bad = {};
  const flag = (k) => { bad[k] = (bad[k] ?? 0) + 1; };
  let sizes = 0, onlyChanges = 0, emptyChan = 0;
  for (let i = 0; i < N; i++) {
    const style = pick(3);
    const a = 1 + pick(60);
    const asset = { ticks: channel(a, style), ticksB: channel(pick(61), style), ticksC: channel(pick(61), style) };
    if (i % 7 === 0) asset.ticks = [];          // A empty: all padding
    if (asset.ticksB.length === 0 && asset.ticksC.length === 0) {                // keep it a three-channel asset
      if (i % 7 === 0) asset.ticksB = channel(1 + pick(5), style); else asset.ticksC = channel(1 + pick(60), style);
    }
    if (i % 11 === 0) asset.ticksB = [];
    if (asset.ticksB.length === 0 && asset.ticksC.length === 0) asset.ticksC = channel(1 + pick(9), style);
    const expect = modelAll(asset);
    const L = expect.length;
    if (asset.ticksB.length === 0 || asset.ticksC.length === 0 || asset.ticks.length === 0) emptyChan++;
    const r = convertSfx(asset);
    const { states, entries, errors } = play(r.bytes);
    if (r.channels !== 3) flag('channels');
    if (r.records !== L) flag('records');
    if (errors.length) flag('player: ' + errors[0]);
    if (states.length !== L) flag('entry count');
    if (!states.every((st, k) => same(st, expect[k]))) flag('registers differ');
    if (entries.length && entries[0].length !== 11) flag('first entry not 11 pairs');
    if (entries.length && !same(entries[0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10])) flag('first entry order');
    let good = true;
    for (let k = 1; k < L; k++) {
      const changed = [];
      for (let reg = 0; reg < 11; reg++) if (expect[k][reg] !== expect[k - 1][reg]) changed.push(reg);
      if (!same(entries[k], changed)) good = false;           // exactly the changed registers, ascending, no repeats
    }
    if (!good) flag('later entries are not exactly the changed registers'); else onlyChanges++;
    // byte count: 4 + 1 + sum of (1 + 2 n)
    const expLen = 5 + entries.reduce((s, e) => s + 1 + 2 * e.length, 0);
    if (r.bytes.length !== expLen) flag('byte count');
    if (sfxStreamLength(sfxRefreshRegisters(asset)) !== r.bytes.length) flag('sfxStreamLength');
    if (!same(sfxRefreshRegisters(asset), expect)) flag('sfxRefreshRegisters');
    if (sfxInfo(fromAsset(asset)).bytes !== r.bytes.length) flag('sound-model sfxInfo bytes');
    sizes++;
  }
  ok(`${N} random assets: the register state after entry r equals the registers computed from the records`, !bad['registers differ'] && !bad['entry count'], JSON.stringify(bad));
  ok('... header 0,0,0,3, channels 3, records = the longest channel, the stream ends with exactly one $FF and nothing follows', !bad.channels && !bad.records && !Object.keys(bad).some((k) => k.startsWith('player')), JSON.stringify(bad));
  ok('... the first entry has 11 pairs R0..R10 in order, every later entry exactly the changed registers in ascending order', !bad['first entry not 11 pairs'] && !bad['first entry order'] && onlyChanges === N, `${onlyChanges}/${N}`);
  ok('... byte counts: 4 + sum(1 + 2n) + 1, the same as sfxStreamLength, sfxRefreshRegisters equals the model, sfxInfo bytes equal', !bad['byte count'] && !bad.sfxStreamLength && !bad.sfxRefreshRegisters && !bad['sound-model sfxInfo bytes'], JSON.stringify(bad));
  ok('... the mix included assets with an empty channel A, B or C (padding from refresh 0)', emptyChan > 500 && sizes === N, String(emptyChan));
}

// ── 2. hand-computed cases ────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2. Hand-computed cases');
{
  const T = (tone, vol, noise, mix) => ({ tone, vol, noise, mix });
  const regs = (asset) => sfxRefreshRegisters(asset);
  // mix: bit 0 = tone off, bit 1 = noise off.  mix 0 = tone and noise both on, 1 = noise only, 2 = tone only, 3 = both off
  ok('mix bit mapping: A mix 1 (tone off) -> R7 bit 0; B mix 2 (noise off) -> bit 4; C mix 3 -> bits 2 and 5; one refresh, the three channels',
    same(regs({ ticks: [T(0, 0, 0, 1)], ticksB: [T(0, 0, 0, 2)], ticksC: [T(0, 0, 0, 3)] })[0].slice(7, 8), [1 + 16 + 4 + 32]));
  ok('mix 0 on all three channels: R7 = 0', regs({ ticks: [T(1, 1, 5, 0)], ticksB: [T(1, 1, 6, 0)], ticksC: [T(1, 1, 7, 0)] })[0][7] === 0);
  ok('mix 7 on all three: R7 = 63 (bits 6 and 7 stay zero)', regs({ ticks: [T(1, 1, 5, 7)], ticksB: [T(1, 1, 6, 7)], ticksC: [T(1, 1, 7, 7)] })[0][7] === 63);
  ok('noise rule: only B has noise on -> R6 = B\'s noise (A has a different noise value)', regs({ ticks: [T(100, 5, 9, 2)], ticksB: [T(100, 5, 17, 0)], ticksC: [T(100, 5, 25, 2)] })[0][6] === 17);
  ok('noise rule: only C has noise on -> R6 = C\'s noise', regs({ ticks: [T(100, 5, 9, 6)], ticksB: [T(100, 5, 17, 7)], ticksC: [T(100, 5, 25, 4)] })[0][6] === 25);
  ok('noise rule: A and C on -> the LOWEST (A) wins; B and C on -> B wins', regs({ ticks: [T(1, 1, 3, 4), ], ticksB: [T(1, 1, 4, 2)], ticksC: [T(1, 1, 5, 0)] })[0][6] === 3
    && regs({ ticks: [T(1, 1, 3, 2)], ticksB: [T(1, 1, 4, 0)], ticksC: [T(1, 1, 5, 0)] })[0][6] === 4);
  ok('noise rule: no channel has noise on -> A\'s noise value (even when A is mix 7)', regs({ ticks: [T(1, 1, 12, 7)], ticksB: [T(1, 1, 4, 2)], ticksC: [T(1, 1, 5, 3)] })[0][6] === 12);
  ok('noise rule: A shorter (padded): after its end A is silent (mix 7, noise 0), so B\'s noise on wins; none on -> R6 = 0 (the padding\'s noise)', (() => {
    const r = regs({ ticks: [T(1, 1, 8, 7)], ticksB: [T(1, 1, 8, 7), T(1, 1, 20, 0)], ticksC: [T(1, 1, 8, 7), T(1, 1, 21, 7)] });
    return r[0][6] === 8 && r[1][6] === 20 && r.length === 2;
  })());
  ok('a channel past its end is tone 0, vol 0, noise 0, mix 7: B goes on for 2 refreshes, A and C stop after 1', (() => {
    const r = regs({ ticks: [T(300, 9, 4, 0)], ticksB: [T(300, 9, 4, 0), T(301, 8, 4, 0)], ticksC: [T(300, 9, 4, 0)] })[1];
    // R0 R1 = A silent, R2 R3 = B 301 = 0x2D 0x01, R4 R5 = C silent, R6 = 4 (B's noise is on), R7 = A both off (1 + 8) + B tone and noise on (0) + C both off (4 + 32) = 45,
    // R8 = 0, R9 = 8, R10 = 0
    return same(r, [0, 0, 0x2D, 1, 0, 0, 4, 45, 0, 8, 0]);
  })());
  // tone 4095 vol 14 (the highest storable volume with the top tone)
  ok('tone 4095, vol 14: R0 = $FF, R1 = $0F (the high nibble only), the volume register 14', (() => {
    const r = regs({ ticks: [T(4095, 14, 0, 6)], ticksB: [T(4095, 14, 0, 6)], ticksC: [T(0, 0, 0, 7)] })[0];
    return r[0] === 0xFF && r[1] === 0x0F && r[2] === 0xFF && r[3] === 0x0F && r[8] === 14 && r[9] === 14 && r[10] === 0;
  })());
  // a full image by hand: two refreshes, the second changes only A's tone and C's volume
  const img = convertSfx({ ticks: [T(0x123, 5, 0, 6), T(0x124, 5, 0, 6)], ticksB: [T(0x200, 6, 0, 6), T(0x200, 6, 0, 6)], ticksC: [T(0x0A, 7, 0, 6), T(0x0A, 3, 0, 6)] });
  const exp = [0, 0, 0, 3, 11, 0, 0x23, 1, 1, 2, 0, 3, 2, 4, 0x0A, 5, 0, 6, 0, 7, 56, 8, 5, 9, 6, 10, 7, 2, 0, 0x24, 10, 3, 0xFF];
  // R7: A mix 6 -> tone on, noise off: bit 3 = 8; B the same: bit 4 = 16; C: bit 5 = 32  ->  56
  ok('hand image, exact bytes: entry 0 = 11 pairs (R7 = 8 + 16 + 32 = 56), entry 1 = 2 pairs: R0 -> $24 (A tone 0x124, the high nibble is unchanged) and R10 -> 3; 33 bytes', same(Array.from(img.bytes), exp) && img.bytes.length === 33, Array.from(img.bytes).join(','));
  ok('one channel: no ticksB / ticksC (or both empty) gives the one-channel image (4 bytes per record + the terminator), channels 1', (() => {
    const a = convertSfx({ ticks: [T(100, 5, 0, 6)] }), b = convertSfx({ ticks: [T(100, 5, 0, 6)], ticksB: [], ticksC: null });
    return a.channels === 1 && a.bytes.length === 8 && same(Array.from(a.bytes), Array.from(b.bytes)) && same(Array.from(a.bytes), [100, 5 << 4, 6 << 5, 0, 0, 0xFF, 0, 0]);
  })());
  ok('an unstorable record is refused on every channel, naming the channel', (() => {
    const e = (a) => { try { convertSfx(a); return ''; } catch (x) { return x.message; } };
    return /^channel A tick 0: tone 3900 with volume 15/.test(e({ ticks: [T(3900, 15, 0, 6)], ticksB: [T(1, 1, 0, 6)] }))
      && /^channel B tick 1: tone 4095 with volume 15/.test(e({ ticks: [T(1, 1, 0, 6), T(1, 1, 0, 6)], ticksB: [T(1, 1, 0, 6), T(4095, 15, 0, 6)] }))
      && /^channel C tick 0: tone 3840 with volume 15/.test(e({ ticks: [T(1, 1, 0, 6)], ticksC: [T(3840, 15, 0, 6)] }))
      && e({ ticks: [T(3839, 15, 0, 6)], ticksB: [T(1, 1, 0, 6)] }) === '';
  })());
  ok('a long effect (1800 ticks on three channels) encodes and plays back', (() => {
    const r2 = rng(5), p = (n) => Math.floor(r2() * n);
    const mk = () => Array.from({ length: 1800 }, () => { const tone = p(3000); return { tone, vol: p(15), noise: p(32), mix: p(8) }; });
    const asset = { ticks: mk(), ticksB: mk(), ticksC: mk() };
    const out = play(convertSfx(asset).bytes);
    return out.errors.length === 0 && out.states.length === 1800 && same(out.states, modelAll(asset));
  })());
}

console.log(`\n${failed === 0 ? 'All' : 'Some'} checks done: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
