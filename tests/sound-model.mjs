"use strict";
// sound-model.mjs -- tests for src/tools/sound-model.js (the Leap Arcade Studio sound editor's data model and AY renderer).
//   node tests/sound-model.mjs
//
// Sections
//   1  conversion and the round trip of every example effect (deep equality and byte-identical convertSfx output)
//   2  fields: clamping, the $FF combination, mix forms, MIX_FORMS against the runtime's register 7 rule
//   3  operations on tick ranges, hand-computed
//   4  notes, presets, info, validation (against convertSfx)
//   5  renderSfx: length, frequency, silence, noise, mixer bits, tick timing, volume table
//   6  history
//   7  three tracks (language batch 5): the editing form, track operations, info, validation, the mixing renderer
//   8  convertSfx: one channel unchanged against a copy of the old function, the three-channel image
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as S from '../src/tools/sound-model.js';
import { convertSfx } from '../src/lang/arcade/arcade-assets.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  cond ? passed++ : failed++;
  return cond;
};
const throws = (fn) => { try { fn(); return false; } catch { return true; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tk = (tone, vol = 10, noise = 0, mix = 6) => ({ tone, vol, noise, mix });
const fx = (...ticks) => ({ ticks: ticks.map((t) => ({ ...t })) });
const vols = (s) => s.ticks.map((t) => t.vol);
const tones = (s) => s.ticks.map((t) => t.tone);
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── 1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1. Conversion and the example effects');
{
  let all = 0, exact = 0, bytesSame = 0, independent = 0, validOk = 0;
  for (const f of readdirSync(join(ROOT, 'arcade/examples')).filter((n) => n.endsWith('.assets.json'))) {
    const doc = JSON.parse(readFileSync(join(ROOT, 'arcade/examples', f), 'utf8'));
    for (const [name, asset] of Object.entries(doc.sfx ?? {})) {
      all++;
      const model = S.fromAsset(asset);
      const back = S.toAsset(model);
      if (same(back, asset)) exact++; else console.log('    differs:', f, name);
      if (same(convertSfx(back).bytes, convertSfx(asset).bytes) && convertSfx(back).records === asset.ticks.length) bytesSame++;
      model.ticks[0].tone = (model.ticks[0].tone + 1) & 4095;      // editing the model must not touch the asset
      if (asset.ticks[0].tone !== model.ticks[0].tone) independent++;
      if (S.validateSfx(S.fromAsset(asset)).ok) validOk++;
    }
  }
  ok(`${all} example effects: toAsset(fromAsset(x)) deep-equals x`, all >= 20 && exact === all, `${exact}/${all}`);
  ok('... and convertSfx gives byte-identical output', bytesSame === all);
  ok('... fromAsset is a deep copy (editing the model leaves the asset alone)', independent === all);
  ok('... every example validates', validOk === all);
  const odd = { ticks: [{ tone: 5, vol: 3, noise: 1, mix: 6, label: 'x' }], note: 'kept', extra: { a: 1 } };
  ok('unknown keys on the effect and on a tick survive the round trip', same(S.toAsset(S.fromAsset(odd)), odd));
  ok('missing vol / noise / mix read as 0 (convertSfx defaults), tone is required',
    same(S.fromAsset({ ticks: [{ tone: 9 }] }).ticks[0], { tone: 9, vol: 0, noise: 0, mix: 0 }) && throws(() => S.fromAsset({ ticks: [{ vol: 1 }] })));
  ok('fromAsset refuses what is not an effect', throws(() => S.fromAsset(null)) && throws(() => S.fromAsset({})) && throws(() => S.fromAsset({ ticks: [1] })) && throws(() => S.fromAsset([])));
}

// ── 2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2. Fields, clamping and the $FF rule');
{
  ok('clampField limits each field to its range', same(S.clampField('tone', 5000), { value: 4095, message: 'tone limited to 0..4095' }) && S.clampField('vol', -3).value === 0 && S.clampField('noise', 99).value === 31 && S.clampField('mix', 8).value === 7);
  ok('clampField rounds fractions and says nothing; refuses non-numbers', S.clampField('vol', 7.6).value === 8 && S.clampField('vol', 7.6).message === null && S.clampField('vol', NaN).value === null && S.clampField('vol', '3').value === null);
  const s = fx(tk(100, 15), tk(4000, 14));
  let r = S.setTick(s, 0, 'tone', 3840);
  ok('setTick: tone 3840 on a volume-15 tick is limited to 3839 with a message', r.value === 3839 && s.ticks[0].tone === 3839 && /\$FF/.test(r.message));
  r = S.setTick(s, 1, 'vol', 15);
  ok('setTick: volume 15 on a tone-4000 tick is limited to 14', r.value === 14 && s.ticks[1].vol === 14 && /\$FF/.test(r.message));
  r = S.setTick(s, 1, 'tone', 3839);
  ok('setTick: tone 3839 with volume 14 is fine, no message', r.value === 3839 && r.message === null);
  r = S.setTick(s, 0, 'vol', 15);
  ok('setTick: volume 15 at tone 3839 is fine', r.value === 15 && s.ticks[0].vol === 15 && r.message === null);
  r = S.setTick(s, 0, 'tone', 99999);
  ok('setTick: tone past the range goes to 4095 then 3839 at volume 15', r.value === 3839);
  ok('setTick: a non-number changes nothing; a bad index throws', S.setTick(s, 0, 'vol', 'x').value === null && s.ticks[0].vol === 15 && throws(() => S.setTick(s, 9, 'vol', 1)) && throws(() => S.setTick(s, 0, 'colour', 1)));
  // exhaustive: setTick never leaves an unstorable tick, whatever it is asked
  let bad = 0;
  for (const tone of [0, 1, 3839, 3840, 4095]) for (const vol of [0, 14, 15]) for (const field of ['tone', 'vol']) for (const v of [0, 14, 15, 3839, 3840, 4095, 5000]) {
    const e = fx(tk(tone, vol));
    S.setTick(e, 0, field, v);
    if (!S.validateSfx(e).ok || throws(() => convertSfx(e))) bad++;
  }
  ok('setTick never leaves a tick convertSfx would refuse (exhaustive over 210 cases)', bad === 0);

  ok('mixOf: the four forms with bit 2 set: tone only 6, both 4, noise only 5, neither 7', S.mixOf(true, false) === 6 && S.mixOf(true, true) === 4 && S.mixOf(false, true) === 5 && S.mixOf(false, false) === 7);
  ok('toneOn / noiseOn read bits 0 and 1 (inverted: a set bit is OFF), bit 2 ignored', S.toneOn(6) && !S.noiseOn(6) && S.toneOn(4) && S.noiseOn(4) && !S.toneOn(5) && S.noiseOn(5) && !S.toneOn(7) && !S.noiseOn(7) && S.toneOn(0) && S.noiseOn(0) && S.toneOn(2) && !S.noiseOn(2));
  ok('MIX_FORMS agree with mixOf and with toneOn / noiseOn; the four values are 6, 4, 5, 7',
    same(S.MIX_FORMS.map((m) => m.mix), [6, 4, 5, 7]) && S.MIX_FORMS.every((m) => S.mixOf(m.tone, m.noise) === m.mix && S.toneOn(m.mix) === m.tone && S.noiseOn(m.mix) === m.noise));
  // the runtime rule: R7 = %00110110 | mix bit 0 | (mix bit 1) << 3; the examples' own forms: shooter boom is noise only (5), most are tone only (6)
  const boom = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/shooter.assets.json'), 'utf8')).sfx.boom.ticks[0];
  ok('the examples agree: shooter "boom" (mix 5) is noise only, "pew" (6) is tone only', !S.toneOn(boom.mix) && S.noiseOn(boom.mix));
}

// ── 3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3. Operations on tick ranges');
{
  let s = fx(tk(1, 1), tk(2, 2), tk(3, 3));
  let r = S.insertTicks(s, 1, 2);
  ok('insertTicks(1, 2): two copies of the tick before, at index 1 and 2', same(tones(s), [1, 1, 1, 2, 3]) && same(vols(s), [1, 1, 1, 2, 3]) && same(r.range, [1, 2]));
  s.ticks[1].tone = 77;
  ok('... the inserted ticks are separate objects', s.ticks[2].tone === 1);
  s = fx(tk(1, 1), tk(2, 2));
  S.insertTicks(s, 0, 1);
  ok('insertTicks at 0 copies the first tick; at the end copies the last', same(tones(s), [1, 1, 2]) && (S.insertTicks(s, 3, 1), same(tones(s), [1, 1, 2, 2])));
  s = fx(tk(1, 1));
  S.insertTicks(s, 1, 1, tk(9, 9, 3, 4));
  ok('insertTicks with a template', same(s.ticks[1], tk(9, 9, 3, 4)));
  ok('insertTicks past MAX_TICKS is clipped with a message', (() => { const e = fx(tk(1, 1)); const x = S.insertTicks(e, 1, S.MAX_TICKS + 50); return e.ticks.length === S.MAX_TICKS && /at most/.test(x.message); })());
  s = fx(tk(1), tk(2), tk(3), tk(4), tk(5));
  r = S.deleteTicks(s, 1, 2);
  ok('deleteTicks(1, 2) removes the two ticks and returns the new cursor', same(tones(s), [1, 4, 5]) && same(r.range, [1, 1]));
  r = S.deleteTicks(s, 2, 1);
  ok('deleteTicks takes the range in either order and clips the cursor at the end', same(tones(s), [1]) && r.message === null || same(tones(s), [1, 4, 5]));
  s = fx(tk(1), tk(2));
  r = S.deleteTicks(s, 0, 1);
  ok('deleteTicks of every tick is refused', s.ticks.length === 2 && /at least one/.test(r.message));
  s = fx(tk(1), tk(2), tk(3));
  r = S.deleteTicks(s, 2, 9);
  ok('deleteTicks clips an over-long range', same(tones(s), [1, 2]));

  s = fx(tk(1, 1), tk(2, 2), tk(3, 3));
  r = S.duplicateRange(s, 0, 1);
  ok('duplicateRange(0, 1): the pair follows itself', same(tones(s), [1, 2, 1, 2, 3]) && same(r.range, [2, 3]));
  s.ticks[2].vol = 9;
  ok('... the copy is independent', s.ticks[0].vol === 1);

  s = fx(tk(1), tk(2), tk(3), tk(4));
  r = S.reverseRange(s, 1, 3);
  ok('reverseRange(1, 3) reverses whole ticks', same(tones(s), [1, 4, 3, 2]) && same(r.range, [1, 3]));
  S.reverseRange(s, 2, 2);
  ok('reverseRange of one tick changes nothing', same(tones(s), [1, 4, 3, 2]));

  s = fx(tk(1, 10), tk(2, 4), tk(3, 15), tk(4, 7));
  S.scaleVolume(s, 0, 3, 0.5);
  ok('scaleVolume 0.5 rounds: 10 4 15 7 -> 5 2 8 4 (7.5 rounds up, 3.5 rounds up)', same(vols(s), [5, 2, 8, 4]));
  s = fx(tk(1, 10), tk(2, 10), tk(3, 10));
  S.scaleVolume(s, 1, 2, 2);
  ok('scaleVolume 2 clamps at 15, only inside the range', same(vols(s), [10, 15, 15]));
  s = fx(tk(4000, 8), tk(100, 8));
  r = S.scaleVolume(s, 0, 1, 2);
  ok('scaleVolume avoids the $FF combination (15 -> 14 at tone 4000) and says so', same(vols(s), [14, 15]) && /1 tick adjusted/.test(r.message) && S.validateSfx(s).ok);
  ok('scaleVolume refuses a negative factor', (() => { const e = fx(tk(1, 5)); const x = S.scaleVolume(e, 0, 0, -1); return e.ticks[0].vol === 5 && x.message; })());

  s = fx(...[12, 12, 12, 12, 12].map((v) => tk(100, v)));
  S.fade(s, 0, 4, 'out');
  ok('fade out over 5 ticks of 12: factors 1, 3/4, 1/2, 1/4, 0 -> 12 9 6 3 0', same(vols(s), [12, 9, 6, 3, 0]));
  s = fx(...[12, 12, 12, 12, 12].map((v) => tk(100, v)));
  S.fade(s, 0, 4, 'in');
  ok('fade in over 5 ticks of 12: 0 3 6 9 12', same(vols(s), [0, 3, 6, 9, 12]));
  s = fx(...[10, 10, 10, 10].map((v) => tk(100, v)));
  S.fade(s, 1, 3, 'out');
  ok('fade of a sub-range leaves the rest: 10 10 5 0', same(vols(s), [10, 10, 5, 0]));
  s = fx(tk(100, 9));
  S.fade(s, 0, 0, 'out');
  ok('fade of one tick leaves it alone', same(vols(s), [9]) && throws(() => S.fade(s, 0, 0, 'up')));

  s = fx(tk(0), tk(0), tk(0), tk(0), tk(0));
  S.sweep(s, 0, 4, 100, 500, 'tone');
  ok('sweep linear in tone 100 -> 500 over 5 ticks: 100 200 300 400 500', same(tones(s), [100, 200, 300, 400, 500]));
  s = fx(tk(0), tk(0), tk(0), tk(0), tk(0));
  S.sweep(s, 0, 4, 100, 1600, 'semitones');
  ok('sweep in semitones 100 -> 1600 (4 octaves) over 5 ticks: 100 200 400 800 1600', same(tones(s), [100, 200, 400, 800, 1600]));
  s = fx(tk(0), tk(0), tk(0));
  S.sweep(s, 2, 0, 90, 10, 'tone');
  ok('sweep takes the range in either order and can fall: 90 50 10', same(tones(s), [90, 50, 10]));
  s = fx(tk(0, 15), tk(0, 15), tk(0, 15));
  r = S.sweep(s, 0, 2, 3000, 4095, 'tone');
  ok('sweep avoids the $FF combination: tone 3000 3548 (3547.5 rounds up) 4095 at vol 15 -> 3000 3548 3839', same(tones(s), [3000, 3548, 3839]) && /1 tick adjusted/.test(r.message) && S.validateSfx(s).ok);
  s = fx(tk(0), tk(0));
  r = S.sweep(s, 0, 1, -50, 9999, 'tone');
  ok('sweep clamps its ends to 0..4095 and says so', same(tones(s), [0, 4095]) && /limited/.test(r.message));
  s = fx(tk(0, 5, 0), tk(0, 5, 0), tk(0, 5, 0));
  S.sweep(s, 0, 2, 4, 30, 'tone', 'noise');
  ok('sweep of the noise field: 4 17 30', same(s.ticks.map((t) => t.noise), [4, 17, 30]) && same(tones(s), [0, 0, 0]));
  s = fx(tk(0), tk(0));
  S.sweep(s, 0, 1, 0, 8, 'semitones');
  ok('semitone sweep treats a period of 0 as 1: 0 -> 8 gives 1, 8 (clamped from 1)', same(tones(s), [1, 8]));

  s = fx(tk(1), tk(2), tk(3));
  r = S.repeatRange(s, 0, 1, 3);
  ok('repeatRange(0, 1, 3): the pair plays 3 times in all', same(tones(s), [1, 2, 1, 2, 1, 2, 3]) && same(r.range, [0, 5]));
  s = fx(tk(1), tk(2));
  S.repeatRange(s, 1, 1, 1);
  ok('repeatRange n = 1 changes nothing', same(tones(s), [1, 2]));
  s = fx(tk(1), tk(2));
  r = S.repeatRange(s, 0, 1, 5000);
  ok('repeatRange stops at MAX_TICKS with a message', s.ticks.length <= S.MAX_TICKS && s.ticks.length > S.MAX_TICKS - 2 && /at most/.test(r.message));

  s = fx(tk(1, 1, 0, 6), tk(2, 2, 0, 6), tk(3, 3, 0, 6));
  r = S.setRange(s, 0, 1, 'noise', 20);
  ok('setRange noise 20 on 0..1', same(s.ticks.map((t) => t.noise), [20, 20, 0]) && r.value === 20 && r.message === null);
  S.setRange(s, 1, 2, 'mix', S.mixOf(false, true));
  ok('setRange mix to noise only (5) on 1..2', same(s.ticks.map((t) => t.mix), [6, 5, 5]));
  r = S.setRange(s, 0, 2, 'vol', 99);
  ok('setRange clamps: vol 99 -> 15', same(vols(s), [15, 15, 15]) && r.message === 'vol limited to 0..15');
  r = S.setRange(s, 0, 2, 'tone', 4000);
  ok('setRange tone 4000 at volume 15 -> 3839 on all three with a message', same(tones(s), [3839, 3839, 3839]) && r.value === 3839 && /3 ticks adjusted/.test(r.message));
  s = fx(tk(4000, 3), tk(4000, 3));
  r = S.setRange(s, 0, 1, 'vol', 15);
  ok('setRange vol 15 at tone 4000 -> 14', same(vols(s), [14, 14]) && r.value === 14);

  // fuzz: no operation ever leaves a tick convertSfx refuses (starting from valid effects)
  const rnd = rng(7);
  let bad = 0, steps = 0;
  const pick = (n) => Math.floor(rnd() * n);
  for (let round = 0; round < 60; round++) {
    const e = S.newSfx(S.PRESETS[pick(6)]);
    for (let k = 0; k < 40; k++) {
      const n = e.ticks.length, a = pick(n), b = pick(n);
      switch (pick(10)) {
        case 0: S.insertTicks(e, pick(n + 1), 1 + pick(3)); break;
        case 1: S.deleteTicks(e, a, b); break;
        case 2: S.duplicateRange(e, a, b); break;
        case 3: S.reverseRange(e, a, b); break;
        case 4: S.scaleVolume(e, a, b, rnd() * 3); break;
        case 5: S.fade(e, a, b, rnd() < 0.5 ? 'in' : 'out'); break;
        case 6: S.sweep(e, a, b, pick(5000), pick(5000), rnd() < 0.5 ? 'tone' : 'semitones'); break;
        case 7: S.repeatRange(e, a, b, 1 + pick(3)); break;
        case 8: S.setRange(e, a, b, ['tone', 'vol', 'noise', 'mix'][pick(4)], pick(6000) - 100); break;
        default: S.setTick(e, a, ['tone', 'vol', 'noise', 'mix'][pick(4)], pick(6000)); break;
      }
      steps++;
      if (!S.validateSfx(e).ok || e.ticks.length < 1 || throws(() => convertSfx(e))) bad++;
    }
  }
  ok(`fuzz: ${steps} random operations never leave an effect convertSfx refuses or an empty one`, bad === 0);
}

// ── 4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4. Notes, presets, info, validation');
{
  const a4 = S.noteOfTone(251);
  ok('noteOfTone(251) is A4 within a cent (1764000 / (16 * 251) = 439.24 Hz, -3 cents)', a4.name === 'A4' && a4.midi === 69 && a4.cents === -3 && Math.abs(a4.freq - 439.24) < 0.01, JSON.stringify(a4));
  ok('noteOfTone: 125.6 gives A5 an octave up (tone 125 = 882 Hz = A5, +3 cents); tone 502 is A3', S.noteOfTone(125).name === 'A5' && S.noteOfTone(502).name === 'A3');
  ok('noteOfTone: 0 counts as 1 (110.25 kHz: a very high note, finite)', Number.isFinite(S.noteOfTone(0).freq) && S.noteOfTone(0).freq === S.noteOfTone(1).freq);
  ok('noteOfTone: C4 = tone 421 (261.6 Hz), name C4', S.noteOfTone(421).name === 'C4' && Math.abs(S.noteOfTone(421).cents) <= 2);
  ok('toneOfNote: A4 = 251, 69 = 251, C4 = 421, "Bb3" = "A#3", lowest notes clamp to 4095', S.toneOfNote('A4') === 251 && S.toneOfNote(69) === 251 && S.toneOfNote('C4') === 421 && S.toneOfNote('Bb3') === S.toneOfNote('A#3') && S.toneOfNote('C0') === 4095 && S.toneOfNote(200) === 1 && S.toneOfNote(130) === 7);
  ok('toneOfNote refuses a bad name', throws(() => S.toneOfNote('H4')) && throws(() => S.toneOfNote('A')));
  let rt = 0;
  for (let tone = 20; tone <= 3000; tone += 7) { const n = S.noteOfTone(tone); const back = S.toneOfNote(n.midi); if (Math.abs(S.noteOfTone(back).midi - n.midi) === 0) rt++; }
  ok('note -> tone -> note returns the same note across the range', rt === Math.floor((3000 - 20) / 7) + 1);
  ok('a different clock moves the note (1,773,400 Hz is about +7 cents)', S.noteOfTone(251, 1773400).cents !== S.noteOfTone(251).cents);

  ok('PRESETS lists beep laser blip explosion powerup hurt', same(S.PRESETS, ['beep', 'laser', 'blip', 'explosion', 'powerup', 'hurt']));
  for (const p of S.PRESETS) {
    const e = S.newSfx(p);
    const v = S.validateSfx(e);
    let conv = true;
    try { convertSfx(e); } catch { conv = false; }
    ok(`preset ${p}: ${e.ticks.length} ticks, valid under convertSfx, short (2..40 ticks), audible, renders non-silent`,
      v.ok && conv && e.ticks.length >= 2 && e.ticks.length <= 40 && e.ticks.some((t) => t.vol >= 8) && S.renderSfx(e).some((x) => x !== 0));
  }
  ok('explosion is noise only and its volume never rises', S.newSfx('explosion').ticks.every((t, i, a) => t.mix === 5 && (i === 0 || t.vol <= a[i - 1].vol)));
  ok('laser falls in pitch (the period rises), powerup rises (the period falls)', tones(S.newSfx('laser')).every((v, i, a) => i === 0 || v >= a[i - 1]) && tones(S.newSfx('powerup')).every((v, i, a) => i === 0 || v <= a[i - 1]));
  ok('newSfx() is a beep; an unknown preset throws; two calls give separate objects', same(S.newSfx(), S.newSfx('beep')) && throws(() => S.newSfx('wobble')) && S.newSfx('beep') !== S.newSfx('beep'));

  const info = S.sfxInfo(fx(tk(1), tk(2), tk(3)));
  ok('sfxInfo: 3 ticks = 16 bytes ((3 + 1) * 4), 3 / 60.115 s', info.ticks === 3 && info.bytes === 16 && Math.abs(info.seconds - 3 / (3528000 / 58688)) < 1e-12);
  ok('sfxInfo bytes equal convertSfx bytes for every preset', S.PRESETS.every((p) => S.sfxInfo(S.newSfx(p)).bytes === convertSfx(S.newSfx(p)).bytes.length));
  ok('sfxInfo with another refresh rate: 60 ticks at 50 Hz = 1.2 s', Math.abs(S.sfxInfo({ ticks: Array(60).fill(tk(1)) }, 50).seconds - 1.2) < 1e-12);

  // validateSfx against the compiler's own verdict, on random (also malformed) effects
  const rnd = rng(99);
  const wild = () => { const r = rnd(); return r < 0.05 ? undefined : r < 0.1 ? 1.5 : r < 0.15 ? -1 : r < 0.2 ? 'x' : null; };
  let agree = 0, cases = 0;
  for (let i = 0; i < 600; i++) {
    const ticks = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => ({
      tone: rnd() < 0.15 ? wild() : rnd() < 0.3 ? 3840 + Math.floor(rnd() * 256) : Math.floor(rnd() * 4300),
      vol: rnd() < 0.1 ? wild() : rnd() < 0.5 ? 15 : Math.floor(rnd() * 17),
      noise: rnd() < 0.1 ? wild() : Math.floor(rnd() * 34),
      mix: rnd() < 0.1 ? wild() : Math.floor(rnd() * 9),
    }));
    const e = { ticks };
    let conv = true;
    try { convertSfx(e); } catch { conv = false; }
    cases++;
    if (S.validateSfx(e).ok === conv) agree++;
  }
  ok(`validateSfx agrees with convertSfx on ${cases} random effects, malformed fields included`, agree === cases, `${agree}/${cases}`);
  const u = S.validateSfx(fx(tk(100, 10), tk(3900, 15), tk(4095, 15), tk(3839, 15)));
  ok('validateSfx lists the unstorable ticks (1 and 2) and says why', !u.ok && same(u.unstorable, [1, 2]) && /\$FF/.test(u.errors[0]) && /tick 1/.test(u.errors[0]));
  ok('validateSfx: an empty effect is valid with a warning; no ticks array is an error', S.validateSfx({ ticks: [] }).ok && S.validateSfx({ ticks: [] }).warnings.length === 1 && !S.validateSfx({}).ok);
  ok('MAX_SFX is 8 (the code generator\'s limit)', S.MAX_SFX === 8);
}

// ── 5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n5. renderSfx');
{
  const REFRESH = 3528000 / 58688;
  const RATE = 44100;
  const rep = (n, t) => Array.from({ length: n }, () => ({ ...t }));
  const crossings = (x, from = 0, to = x.length) => { let c = 0; for (let i = from + 1; i < to; i++) if ((x[i - 1] < 0) !== (x[i] < 0)) c++; return c; };

  for (const n of [1, 6, 60, 133]) {
    const out = S.renderSfx(fx(...rep(n, tk(300))));
    ok(`${n} ticks: length ${out.length} = ticks * rate / refreshHz (${(n * RATE / REFRESH).toFixed(2)}) within one sample`, out instanceof Float32Array && Math.abs(out.length - n * RATE / REFRESH) <= 1);
  }
  ok('other rates: 22050 Hz and a 50 Hz refresh (60 ticks = 1.2 s = 26460 samples)', S.renderSfx(fx(...rep(60, tk(300))), { rate: 22050, refreshHz: 50 }).length === 26460);
  ok('an empty effect renders as an empty array', S.renderSfx({ ticks: [] }).length === 0);

  // frequency: tone 251 -> 1764000 / (16 * 251) = 439.24 Hz; 0.5 s
  const tone = S.renderSfx(fx(...rep(30, tk(251, 15 - 1))));
  const secs = tone.length / RATE;
  const f = crossings(tone) / 2 / secs;
  ok(`a tone of period 251 measures ${f.toFixed(1)} Hz by zero crossings (expected 439.2 within 1 %)`, Math.abs(f - 1764000 / (16 * 251)) / (1764000 / (16 * 251)) < 0.01);
  for (const p of [60, 120, 500, 1200]) {
    const o = S.renderSfx(fx(...rep(60, tk(p, 10))));
    const ff = crossings(o) / 2 / (o.length / RATE), exp = 1764000 / (16 * p);
    ok(`period ${p}: ${ff.toFixed(1)} Hz, expected ${exp.toFixed(1)} (1 %)`, Math.abs(ff - exp) / exp < 0.01);
  }
  ok('another clock scales the pitch: clock 3,528,000 doubles the frequency', (() => { const o = S.renderSfx(fx(...rep(60, tk(500, 10))), { clock: 3528000 }); return Math.abs(crossings(o) / 2 / (o.length / RATE) - 2 * 1764000 / (16 * 500)) / (2 * 1764000 / (16 * 500)) < 0.01; })());
  ok('a period of 0 sounds as 1 (identical samples at the same rate)', same(Array.from(S.renderSfx(fx(tk(0, 10)), { rate: 4000 })), Array.from(S.renderSfx(fx(tk(1, 10)), { rate: 4000 }))));
  ok('it is a square wave: only the two levels +-0.5 * AY_VOLUME[vol]', (() => { const o = S.renderSfx(fx(...rep(10, tk(251, 10)))); const a = 0.5 * S.AY_VOLUME[10]; return o.every((x) => Math.abs(Math.abs(x) - a) < 1e-6); })());
  ok('full volume peaks at 0.5 (volume 14 at 0.4028)', (() => { const o = S.renderSfx(fx(...rep(10, tk(251, 15)))); const m = Math.max(...o), p = Math.max(...S.renderSfx(fx(...rep(10, tk(251, 14))))); return Math.abs(m - 0.5) < 1e-6 && Math.abs(p - 0.4028) < 1e-4; })());
  ok('the volume table steps: peak of vol v = 0.5 * AY_VOLUME[v] for every v 0..15 (tone below 3840 at 15)', Array.from({ length: 16 }, (_, v) => v).every((v) => Math.abs(Math.max(...S.renderSfx(fx(tk(251, v)))) - 0.5 * S.AY_VOLUME[v]) < 1e-6));
  ok('AY_VOLUME is the contract table: 16 entries, 0 first, 1 last, rising', S.AY_VOLUME.length === 16 && S.AY_VOLUME[0] === 0 && S.AY_VOLUME[15] === 1 && S.AY_VOLUME.every((v, i, a) => i === 0 || v > a[i - 1]));

  // silence
  ok('volume 0 gives exact silence, with tone, with noise, with both', [6, 5, 4].every((mix) => S.renderSfx(fx(...rep(8, tk(200, 0, 10, mix)))).every((x) => x === 0)));
  ok('tone and noise both off (mix 7) is silent whatever the volume', S.renderSfx(fx(...rep(8, tk(200, 15 - 1, 10, 7)))).every((x) => x === 0));

  // noise
  const nz = S.renderSfx(fx(...rep(30, tk(0, 14, 12, 5))));
  const energy = nz.reduce((s, x) => s + x * x, 0) / nz.length;
  const full = (0.5 * S.AY_VOLUME[14]) ** 2;       // mean square of a square wave of vol 14
  ok(`noise only has energy (mean square ${energy.toFixed(4)} of ${full.toFixed(4)} for a square wave of volume 14; a fair LFSR is half high)`, energy > 0.99 * full);
  const ac = (x, lag) => { let s = 0, n = x.length - lag; for (let i = 0; i < n; i++) s += x[i] * x[i + lag]; return s / n; };
  const zero = ac(nz, 0);
  const periodSamples = RATE * 16 * 251 / 1764000;     // what a tone of period 251 would repeat at
  const lags = [Math.round(periodSamples), Math.round(2 * periodSamples)];
  ok('noise is not periodic at the tone period: autocorrelation at that lag (and twice it) is below 0.2 of the energy', lags.every((l) => Math.abs(ac(nz, l)) < 0.2 * zero), lags.map((l) => (ac(nz, l) / zero).toFixed(3)).join(' '));
  ok('... whereas the tone IS periodic there (autocorrelation above 0.9)', (() => { const t = S.renderSfx(fx(...rep(30, tk(251, 14)))); return ac(t, Math.round(periodSamples)) / ac(t, 0) > 0.9; })());
  ok('noise is deterministic (two renders are identical)', same(Array.from(nz), Array.from(S.renderSfx(fx(...rep(30, tk(0, 14, 12, 5)))))));
  ok('a slower noise period (31) is lower in pitch than a fast one (2): fewer sign changes', crossings(S.renderSfx(fx(...rep(30, tk(0, 14, 31, 5))))) < crossings(S.renderSfx(fx(...rep(30, tk(0, 14, 2, 5))))));
  ok('noise period 0 sounds as 1', same(Array.from(S.renderSfx(fx(tk(0, 14, 0, 5)), { rate: 8000 })), Array.from(S.renderSfx(fx(tk(0, 14, 1, 5)), { rate: 8000 }))));
  ok('the LFSR is the AY\'s: with noise period 1 at the 110 kHz clock, 17-bit sequence of 131071 shifts repeats (checked by running the register)', (() => {
    let l = 1, n = 0; do { l = (l >> 1) | (((l ^ (l >> 3)) & 1) << 16); n++; } while (l !== 1 && n < 300000); return n === 131071;
  })());

  // mixer bits switch tone / noise
  const tonePure = S.renderSfx(fx(...rep(30, tk(251, 14, 12, 6))));
  const toneNoise = S.renderSfx(fx(...rep(30, tk(251, 14, 12, 4))));
  const noisePure = S.renderSfx(fx(...rep(30, tk(251, 14, 12, 5))));
  ok('mix 6 (tone only) is periodic; mix 5 (noise only) is not; mix 4 (both) is in between: gated by noise, never louder than the tone',
    ac(tonePure, Math.round(periodSamples)) / ac(tonePure, 0) > 0.9 && Math.abs(ac(noisePure, Math.round(periodSamples)) / ac(noisePure, 0)) < 0.2 && ac(toneNoise, Math.round(periodSamples)) / ac(toneNoise, 0) < ac(tonePure, Math.round(periodSamples)) / ac(tonePure, 0));
  ok('mix 6 differs from mix 4 and from mix 5; the noise bit changes nothing at mix 6 (noise 1 vs 31)', !same(Array.from(tonePure), Array.from(toneNoise)) && !same(Array.from(tonePure), Array.from(noisePure)) && same(Array.from(tonePure), Array.from(S.renderSfx(fx(...rep(30, tk(251, 14, 31, 6)))))));
  ok('mix bit 2 does nothing: 6 = 2 and 4 = 0, 5 = 1', [[6, 2], [4, 0], [5, 1], [7, 3]].every(([a, b]) => same(Array.from(S.renderSfx(fx(...rep(5, tk(251, 9, 7, a))))), Array.from(S.renderSfx(fx(...rep(5, tk(251, 9, 7, b))))))));
  ok('the tone changes nothing at mix 5 (noise only): tone 100 vs 3000', same(Array.from(S.renderSfx(fx(...rep(5, tk(100, 9, 7, 5))))), Array.from(S.renderSfx(fx(...rep(5, tk(3000, 9, 7, 5)))))));

  // tick timing
  const two = S.renderSfx({ ticks: [tk(251, 5), tk(251, 12)] });
  const step = Math.ceil(RATE / REFRESH - 1e-9);
  const firstLoud = two.findIndex((x) => Math.abs(x) > 0.5 * S.AY_VOLUME[5] + 1e-6);
  ok(`a volume step lands on the expected sample: tick 1 starts at sample ${step} (ceil(rate / refreshHz) = ${(RATE / REFRESH).toFixed(3)}), first louder sample is ${firstLoud}`, firstLoud === step && two.length === Math.round(2 * RATE / REFRESH));
  const ramp = S.renderSfx({ ticks: Array.from({ length: 6 }, (_, i) => tk(60, i + 1)) }, { rate: 6000, refreshHz: 60 });
  const peaks = Array.from({ length: 6 }, (_, i) => Math.max(...ramp.slice(i * 100, (i + 1) * 100)));
  ok('at 6000 Hz / 60 Hz records are exactly 100 samples: each block peaks at 0.5 * AY_VOLUME[i + 1]; the boundaries are sharp', ramp.length === 600 && peaks.every((p, i) => Math.abs(p - 0.5 * S.AY_VOLUME[i + 1]) < 1e-6));
  const gap = S.renderSfx({ ticks: [tk(60, 10), tk(60, 0), tk(60, 10)] }, { rate: 6000, refreshHz: 60 });
  ok('a silent middle tick is exactly 100 silent samples at 100..199', gap.slice(100, 200).every((x) => x === 0) && gap.slice(0, 100).some((x) => x !== 0) && gap.slice(200).some((x) => x !== 0));
  // phase continues across a record change with the same period (no click: crossings count equals one long tone's)
  const split = S.renderSfx(fx(...rep(30, tk(251, 10)))), cont = S.renderSfx(fx(...rep(15, tk(251, 10)), ...rep(15, tk(251, 10))));
  ok('records of the same tone join without a phase jump', same(Array.from(split), Array.from(cont)));
  ok('it accepts the stored form (an asset object) as well as the model', same(Array.from(S.renderSfx({ ticks: [{ tone: 251, vol: 9, noise: 0, mix: 6 }] })), Array.from(S.renderSfx(S.fromAsset({ ticks: [{ tone: 251, vol: 9, noise: 0, mix: 6 }] })))));
  ok('every example effect renders to a finite signal inside -0.5..0.5 of the expected length', (() => {
    let good = 0, n = 0;
    for (const file of readdirSync(join(ROOT, 'arcade/examples')).filter((x) => x.endsWith('.assets.json'))) {
      const doc = JSON.parse(readFileSync(join(ROOT, 'arcade/examples', file), 'utf8'));
      for (const a of Object.values(doc.sfx ?? {})) { n++; const o = S.renderSfx(a); if (Math.abs(o.length - a.ticks.length * RATE / REFRESH) <= 1 && o.every((x) => Number.isFinite(x) && Math.abs(x) <= 0.5)) good++; }
    }
    return n >= 20 && good === n;
  })());
}

// ── 6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n6. History');
{
  const sprite = await import('../src/tools/sprite-model.js');
  ok('createHistory is the sprite editor\'s', S.createHistory === sprite.createHistory);
  const e = S.newSfx('blip');
  const h = S.createHistory(e);
  S.setTick(e, 0, 'vol', 3);
  const committed = h.commit(e);
  const undone = h.undo();
  ok('commit, undo and redo carry effects', committed && undone.ticks[0].vol === 13 && h.redo().ticks[0].vol === 3);
  ok('an unchanged effect is not a step; undo goes back to the original', (() => { const x = S.newSfx('blip'); const hh = S.createHistory(x); const no = hh.commit(x); S.setRange(x, 0, 3, 'vol', 1); hh.commit(x); return no === false && hh.undo().ticks[0].vol === 13 && hh.canRedo; })());
}

// ── 7 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// Three-channel effects (language batch 5, Part C items 16 to 20): tracks, the editing form, info and validation, and the mixing renderer.
console.log('\n7. Three tracks: model, info, validation, rendering');
{
  // verbatim copies of the one-channel functions as they were before batch 5, to prove the one-channel results did not change
  const num = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);
  function oldRenderSfx(asset, { rate = 44100, clock = S.AY_CLOCK, refreshHz = S.REFRESH_HZ } = {}) {
    const ticks = Array.isArray(asset?.ticks) ? asset.ticks : [];
    const total = Math.round(ticks.length * rate / refreshHz);
    const out = new Float32Array(total);
    if (total === 0) return out;
    const cyc = clock / 16 / rate;                       // tone / noise counter steps per output sample, before dividing by the period
    const startOf = (i) => Math.min(total, Math.ceil(i * rate / refreshHz - 1e-9));
    let phase = 0, nphase = 0, lfsr = 1;
    for (let i = 0; i < ticks.length; i++) {
      const t = ticks[i] ?? {};
      const tone = Math.max(1, Math.round(num(t.tone, 0)) & 4095 || 1);
      const np = Math.max(1, Math.round(num(t.noise, 0)) & 31 || 1);
      const mix = Math.round(num(t.mix, 0)) & 7;
      const vol = Math.max(0, Math.min(15, Math.round(num(t.vol, 0))));
      const tOn = (mix & 1) === 0, nOn = (mix & 2) === 0;
      const amp = 0.5 * S.AY_VOLUME[vol];
      const dTone = cyc / tone, dNoise = cyc / np;
      const s = i === 0 ? 0 : startOf(i), e = i === ticks.length - 1 ? total : startOf(i + 1);
      for (let n = s; n < e; n++) {
        phase += dTone; phase -= Math.floor(phase);
        nphase += dNoise;
        while (nphase >= 1) { nphase -= 1; lfsr = (lfsr >> 1) | (((lfsr ^ (lfsr >> 3)) & 1) << 16); }
        if (!tOn && !nOn) { out[n] = 0; continue; }
        const level = (tOn ? (phase < 0.5 ? 1 : 0) : 1) & (nOn ? (lfsr & 1) : 1);
        out[n] = level ? amp : -amp;
      }
    }
    return out;
  }
  
  const RATE = 22050;
  const rnd = rng(5150);
  const pick = (n) => Math.floor(rnd() * n);
  const randTick = () => ({ tone: pick(4096) % (rnd() < 0.3 ? 4096 : 600), vol: pick(15), noise: pick(32), mix: pick(8) });
  const randTrack = (n) => Array.from({ length: n }, randTick);

  // one-channel effects render exactly as before, also with empty / null B and C
  let identical = 0, cases = 0;
  for (let i = 0; i < 40; i++) {
    const e = { ticks: randTrack(1 + pick(30)) };
    const variants = [e, { ...e, ticksB: [] }, { ...e, ticksC: null }, { ...e, ticksB: [], ticksC: [] }, S.fromAsset(e)];
    const want = oldRenderSfx(e, { rate: RATE });
    for (const v of variants) { cases++; const got = S.renderSfx(v, { rate: RATE }); if (got.length === want.length && got.every((x, k) => x === want[k])) identical++; }
  }
  ok(`renderSfx of a one-channel effect is byte-identical to the old renderer (${cases} effects, empty / null ticksB / ticksC included)`, identical === cases, `${identical}/${cases}`);

  // the editing form
  const asset3 = { ticks: [tk(100)], ticksB: [tk(200, 5), tk(210, 6)], ticksC: [tk(300, 7, 3, 4)], extra: { k: 1 } };
  const m3 = S.fromAsset(asset3);
  ok('fromAsset keeps ticksB / ticksC (deep copies) and toAsset writes them back unchanged', same(S.toAsset(m3), asset3) && m3.ticksB !== asset3.ticksB && (() => { m3.ticksB[0].vol = 1; return asset3.ticksB[0].vol === 5; })());
  ok('the editing form always has all three arrays; ticksB / ticksC are written only when non-empty',
    same(S.fromAsset({ ticks: [tk(1)] }).ticksB, []) && same(S.fromAsset({ ticks: [tk(1)], ticksB: null, ticksC: null }).ticksC, [])
    && same(S.toAsset(S.fromAsset({ ticks: [tk(1)], ticksB: [], ticksC: null })), { ticks: [tk(1)] })
    && same(S.toAsset(S.fromAsset({ ticks: [tk(1)], ticksC: [tk(2)] })), { ticks: [tk(1)], ticksC: [tk(2)] }));
  ok('fromAsset refuses a ticksB that is not an array, naming the channel, and a bad tick of channel C',
    throws(() => S.fromAsset({ ticks: [], ticksB: 'x' })) && /channel B/.test((() => { try { S.fromAsset({ ticks: [], ticksB: {} }); } catch (e) { return e.message; } })())
    && /channel C tick 1/.test((() => { try { S.fromAsset({ ticks: [], ticksC: [tk(1), 5] }); } catch (e) { return e.message; } })()));
  ok('cloneSfx is a deep copy that keeps empty tracks', (() => { const c = S.cloneSfx(S.fromAsset({ ticks: [tk(1)] })); return same(c.ticksB, []) && same(c.ticksC, []) && c.ticks[0] !== undefined; })());
  ok('the history snapshots all three tracks (undo restores track B)', (() => {
    const e = S.fromAsset(asset3), h = S.createHistory(e);
    S.setTick(S.trackView(e, 1), 0, 'vol', 9);
    const c = h.commit(e);
    return c && h.undo().ticksB[0].vol === 5 && h.redo().ticksB[0].vol === 9;
  })());

  // tracks
  ok('trackLengths, effectLength (the longest) and isMulti', same(S.trackLengths(m3), [1, 2, 1]) && S.effectLength(m3) === 2 && S.isMulti(m3) && !S.isMulti(S.fromAsset({ ticks: [tk(1)] })) && S.effectLength({ ticks: [] }) === 0);
  const e1 = S.fromAsset({ ticks: [tk(100), tk(110), tk(120)] });
  const vB = S.trackView(e1, 1);
  ok('trackView shares the channel\'s array: an edit through it changes the effect', (() => { S.insertTicks(vB, 0, 2); return e1.ticksB.length === 2 && vB.ticks === e1.ticksB && vB.allowEmpty === true && S.trackView(e1, 0).allowEmpty === false; })());
  ok('every operation works on a track: setTick, scaleVolume, reverseRange, sweep, setRange, duplicateRange, repeatRange', (() => {
    const e = S.fromAsset({ ticks: [tk(100, 9)], ticksC: [tk(10, 8), tk(20, 8), tk(30, 8)] });
    const v = S.trackView(e, 2);
    S.setTick(v, 0, 'tone', 11); S.reverseRange(v, 0, 2); S.scaleVolume(v, 0, 2, 0.5); S.setRange(v, 1, 1, 'noise', 7);
    const a = same(e.ticksC.map((t) => [t.tone, t.vol, t.noise]), [[30, 4, 0], [20, 4, 7], [11, 4, 0]]);
    S.sweep(v, 0, 2, 100, 300, 'tone'); S.duplicateRange(v, 0, 0); S.repeatRange(v, 3, 3, 2);
    return a && same(e.ticksC.map((t) => t.tone), [100, 100, 200, 300, 300]) && e.ticks.length === 1 && e.ticks[0].vol === 9;
  })());
  ok('deleting every tick is refused for channel A and allowed for B and C (that removes the track)', (() => {
    const e = S.fromAsset({ ticks: [tk(1), tk(2)], ticksB: [tk(3), tk(4)] });
    const a = S.deleteTicks(S.trackView(e, 0), 0, 1), b = S.deleteTicks(S.trackView(e, 1), 0, 1);
    return /at least one/.test(a.message) && e.ticks.length === 2 && b.message === null && e.ticksB.length === 0 && !('ticksB' in S.toAsset(e));
  })());
  ok('the unstorable rule applies to B and C: setTick, scaleVolume, sweep, setRange all avoid $FF', (() => {
    const e = S.fromAsset({ ticks: [tk(1)], ticksB: [tk(4000, 14), tk(100, 10)] });
    const v = S.trackView(e, 1);
    S.setTick(v, 0, 'vol', 15); const a = e.ticksB[0].vol === 14;
    S.setRange(v, 1, 1, 'tone', 4000); S.setTick(v, 1, 'vol', 15);
    return a && e.ticksB[1].vol === 14 && S.validateSfx(e).ok;
  })());
  ok('padTrack extends a track with silent ticks to a length (never shortens, capped at MAX_TICKS)', (() => {
    const e = S.fromAsset({ ticks: [tk(1)] });
    const n = S.padTrack(e, 1, 4), again = S.padTrack(e, 1, 2), cap = S.padTrack(e, 2, 99999);
    return n === 4 && again === 0 && e.ticksB.length === 4 && e.ticksB.every((t) => t.vol === 0 && t.mix === 6) && cap === S.MAX_TICKS && same(S.PAD_TICK, { tone: 200, vol: 0, noise: 0, mix: 6 });
  })());
  ok('sliceRange cuts every track (a track shorter than the start is empty) and leaves the effect alone', (() => {
    const e = S.fromAsset({ ticks: [tk(1), tk(2), tk(3)], ticksB: [tk(4)] });
    const r = S.sliceRange(e, 1, 2);
    return same(r.ticks.map((t) => t.tone), [2, 3]) && same(r.ticksB, []) && same(r.ticksC, []) && e.ticks.length === 3 && e.ticksB.length === 1;
  })());

  // info and validation
  const i3 = S.sfxInfo(m3);
  ok('sfxInfo of a three-channel effect: longest track ticks, ticks * 12 + 4 bytes, channels 3, the track lengths', i3.ticks === 2 && i3.bytes === 28 && i3.channels === 3 && same(i3.tracks, [1, 2, 1]) && Math.abs(i3.seconds - 2 / S.REFRESH_HZ) < 1e-12);
  ok('sfxInfo of a one-channel effect is as before: (ticks + 1) * 4, channels 1', (() => { const i = S.sfxInfo(fx(tk(1), tk(2))); return i.bytes === 12 && i.channels === 1 && i.ticks === 2; })());
  ok('sfxInfo bytes equal convertSfx bytes for 200 random effects of one to three channels', (() => {
    let good = 0;
    for (let i = 0; i < 200; i++) {
      const e = { ticks: randTrack(pick(6)).map((t) => ({ ...t, vol: Math.min(t.vol, 14) })) };
      if (rnd() < 0.7) e.ticksB = randTrack(pick(7)).map((t) => ({ ...t, vol: Math.min(t.vol, 14) }));
      if (rnd() < 0.5) e.ticksC = randTrack(pick(7)).map((t) => ({ ...t, vol: Math.min(t.vol, 14) }));
      const info = S.sfxInfo(S.fromAsset(e)), c = convertSfx(e);
      if (info.bytes === c.bytes.length && info.ticks === c.records && info.channels === c.channels) good++;
    }
    return good === 200;
  })(), 'bytes, records and channels against convertSfx');
  let agree = 0, total = 0;
  const wild = () => { const r = rnd(); return r < 0.05 ? undefined : r < 0.1 ? 1.5 : r < 0.15 ? -1 : r < 0.2 ? 'x' : null; };
  const wildTick = () => ({
    tone: rnd() < 0.1 ? wild() : rnd() < 0.3 ? 3840 + pick(256) : pick(4300),
    vol: rnd() < 0.1 ? wild() : rnd() < 0.5 ? 15 : pick(17),
    noise: rnd() < 0.1 ? wild() : pick(34), mix: rnd() < 0.1 ? wild() : pick(9),
  });
  for (let i = 0; i < 600; i++) {
    const e = { ticks: Array.from({ length: pick(3) }, wildTick) };
    if (rnd() < 0.7) e.ticksB = Array.from({ length: pick(4) }, wildTick);
    if (rnd() < 0.5) e.ticksC = Array.from({ length: pick(4) }, wildTick);
    let conv = true;
    try { convertSfx(e); } catch { conv = false; }
    total++;
    if (S.validateSfx(e).ok === conv) agree++;
  }
  ok(`validateSfx agrees with convertSfx on ${total} random effects of one to three channels, malformed fields included`, agree === total, `${agree}/${total}`);
  const v3 = S.validateSfx({ ticks: [tk(1)], ticksB: [tk(100), tk(4000, 15)], ticksC: [tk(3900, 15)] });
  ok('validateSfx lists the unstorable ticks per channel and names the channel in the message', !v3.ok && same(v3.byChannel, { A: [], B: [1], C: [0] }) && same(v3.unstorable, []) && v3.errors.some((e) => /^channel B tick 1: .*\$FF/.test(e)) && v3.errors.some((e) => /^channel C tick 0: /.test(e)));
  ok('a one-channel effect keeps the old message ("tick 1: ...") and byChannel.A', (() => { const v = S.validateSfx(fx(tk(100), tk(4000, 15))); return /^tick 1: /.test(v.errors[0]) && same(v.unstorable, [1]) && same(v.byChannel.A, [1]); })());
  ok('validateSfx: an empty effect with a track B is not "empty"; a ticksB that is not an array is an error', S.validateSfx({ ticks: [], ticksB: [tk(1)] }).warnings.length === 0 && !S.validateSfx({ ticks: [tk(1)], ticksB: 5 }).ok && /ticksB/.test(S.validateSfx({ ticks: [tk(1)], ticksB: 5 }).errors[0]));

  // rendering: three tone generators, one shared noise generator, per-channel volume
  const rep = (n, t) => Array.from({ length: n }, () => ({ ...t }));
  const arr = (x) => Array.from(x);
  const half = (x) => arr(x).map((v) => v * 0.5);
  const silentB = rep(20, tk(77, 0));
  ok('A with a silent track B renders as half of A alone (one channel of two tracks: scale 1 / 2)', (() => {
    const a = rep(20, { tone: 130, vol: 11, noise: 9, mix: 4 });
    return same(arr(S.renderSfx({ ticks: a, ticksB: silentB }, { rate: RATE })), half(S.renderSfx({ ticks: a }, { rate: RATE })));
  })());
  ok('only channel C holding ticks renders as the same ticks in channel A (one used track: scale 1; A empty is silent)', (() => {
    const c = randTrack(15).map((t) => ({ ...t, vol: Math.min(t.vol, 14), noise: (t.mix & 2) === 0 ? t.noise : 0 }));   // A is silent padding: with no noise on anywhere R6 is A's (period 1)
    return same(arr(S.renderSfx({ ticks: [], ticksC: c }, { rate: RATE })), arr(S.renderSfx({ ticks: c }, { rate: RATE })));
  })());
  ok('the length is the longest track (A 10, B 25, C 5 ticks)', (() => {
    const o = S.renderSfx({ ticks: rep(10, tk(100)), ticksB: rep(25, tk(200)), ticksC: rep(5, tk(300)) }, { rate: RATE });
    return o.length === Math.round(25 * RATE / S.REFRESH_HZ);
  })());
  ok('a track past its end is silent: after A ends, the output is B alone at the three-track scale', (() => {
    const a = rep(10, tk(97, 12)), b = rep(30, tk(211, 9));
    const o = S.renderSfx({ ticks: a, ticksB: b }, { rate: RATE }), bOnly = S.renderSfx({ ticks: [], ticksB: b }, { rate: RATE });
    const from = Math.ceil(10 * RATE / S.REFRESH_HZ - 1e-9);
    // B alone is one used track (scale 1); with A it is scale 1/2, and past A's end A adds exactly 0
    return o.length === bOnly.length && arr(o).slice(from).every((v, k) => v === bOnly[from + k] * 0.5);
  })());
  ok('the noise generator is shared: the lowest channel with noise ON sets its period (B when A has noise off; A when both do)', (() => {
    const n20 = { tone: 0, vol: 10, noise: 20, mix: 5 };
    const aQuiet = rep(20, { tone: 90, vol: 0, noise: 3, mix: 6 });             // A: tone only, noise OFF, its noise field must not count
    const viaB = S.renderSfx({ ticks: aQuiet, ticksB: rep(20, n20) }, { rate: RATE });
    const alone = S.renderSfx({ ticks: rep(20, n20) }, { rate: RATE });
    const aNoise = rep(20, { tone: 0, vol: 0, noise: 3, mix: 5 });               // A: noise ON (silent, volume 0): period 3 wins over B's 20
    const viaA = S.renderSfx({ ticks: aNoise, ticksB: rep(20, n20) }, { rate: RATE });
    const at3 = S.renderSfx({ ticks: rep(20, { tone: 0, vol: 10, noise: 3, mix: 5 }) }, { rate: RATE });
    return same(arr(viaB), half(alone)) && same(arr(viaA), half(at3)) && !same(arr(viaA), arr(viaB));
  })());
  ok('three channels at full volume stay inside -0.5..0.5 and differ from any one of them', (() => {
    const t = (tone) => rep(40, { tone, vol: 15 - 1, noise: 0, mix: 6 });
    const o = S.renderSfx({ ticks: t(100), ticksB: t(150), ticksC: t(231) }, { rate: RATE });
    const a = S.renderSfx({ ticks: t(100) }, { rate: RATE });
    return o.every((x) => Math.abs(x) <= 0.5 + 1e-6) && Math.max(...o) > 0.3 && !same(arr(o), arr(a));
  })());
  ok('the mixer: a channel with tone and noise both off is silent in the mix', (() => {
    const a = rep(10, tk(120, 10));
    const off = S.renderSfx({ ticks: a, ticksB: rep(10, { tone: 100, vol: 15 - 1, noise: 0, mix: 7 }) }, { rate: RATE });
    return same(arr(off), half(S.renderSfx({ ticks: a }, { rate: RATE })));
  })());
  ok('rendering never throws on damaged records in B and C, and an effect with only empty tracks renders nothing', (() => {
    const o = S.renderSfx({ ticks: [tk(1)], ticksB: [{}, null, { tone: 'x', vol: 99 }], ticksC: 'bad' }, { rate: RATE });
    return o instanceof Float32Array && o.every(Number.isFinite) && S.renderSfx({ ticks: [], ticksB: [], ticksC: [] }).length === 0;
  })());
}

// ── 8 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
// convertSfx: the one-channel image is unchanged; the multi-channel image of language batch 5 item 17.
console.log('\n8. convertSfx: one channel unchanged, three channels');
{
  const int = (v, lo, hi, what, dflt) => {
    if (v === undefined || v === null) { if (dflt !== undefined) return dflt; throw new Error(`${what} is missing`); }
    if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} must be a whole number ${lo}..${hi}, got ${JSON.stringify(v)}`);
    return v;
  };
  function oldConvertSfx(asset) {
    const ticks = asset?.ticks;
    if (!Array.isArray(ticks)) throw new Error('the sound effect has no "ticks" array');
    const bytes = new Uint8Array((ticks.length + 1) * 4);
    ticks.forEach((t, i) => {
      const tone = int(t?.tone, 0, 4095, `tick ${i} tone`);
      const vol = int(t?.vol, 0, 15, `tick ${i} vol`, 0);
      const noise = int(t?.noise, 0, 31, `tick ${i} noise`, 0);
      const mix = int(t?.mix, 0, 7, `tick ${i} mix`, 0);
      const hi = (tone >> 8) | (vol << 4);
      if (hi === 0xFF) throw new Error(`tick ${i}: tone ${tone} with volume 15 cannot be stored (the byte $FF ends an effect); lower the volume or the tone`);
      bytes.set([tone & 0xFF, hi, noise | (mix << 5), 0], i * 4);
    });
    bytes.set([0, 0xFF, 0, 0], ticks.length * 4);       // terminator record
    return { records: ticks.length, bytes };
  }
  
  const rnd = rng(31337);
  const pick = (n) => Math.floor(rnd() * n);
  const wild = () => { const r = rnd(); return r < 0.05 ? undefined : r < 0.1 ? 1.5 : r < 0.15 ? -1 : r < 0.2 ? 'x' : null; };
  const tick = () => ({
    tone: rnd() < 0.1 ? wild() : rnd() < 0.3 ? 3840 + pick(256) : pick(4300),
    vol: rnd() < 0.1 ? wild() : rnd() < 0.5 ? 15 : pick(17),
    noise: rnd() < 0.1 ? wild() : pick(34), mix: rnd() < 0.1 ? wild() : pick(9),
  });
  let same1 = 0, cases = 0;
  for (let i = 0; i < 1500; i++) {
    const e = { ticks: Array.from({ length: pick(12) }, tick) };
    if (rnd() < 0.2) e.ticksB = []; if (rnd() < 0.2) e.ticksC = null; if (rnd() < 0.1) e.ticksB = undefined;
    let o, n;
    try { o = oldConvertSfx(e); } catch (x) { o = x.message; }
    try { n = convertSfx(e); } catch (x) { n = x.message; }
    cases++;
    if (typeof o === 'string' ? o === n : (typeof n !== 'string' && n.records === o.records && n.channels === 1 && n.bytes.length === o.bytes.length && n.bytes.every((b, k) => b === o.bytes[k]))) same1++;
  }
  ok(`a one-channel asset gives exactly the old bytes and records, plus channels: 1, or exactly the old error message (${cases} random assets, malformed ones included)`, same1 === cases, `${same1}/${cases}`);
  ok('the examples\' effects (all one channel) convert to the old bytes', (() => {
    let n = 0, good = 0;
    for (const f of readdirSync(join(ROOT, 'arcade/examples')).filter((x) => x.endsWith('.assets.json'))) {
      for (const a of Object.values(JSON.parse(readFileSync(join(ROOT, 'arcade/examples', f), 'utf8')).sfx ?? {})) { n++; const o = oldConvertSfx(a), c = convertSfx(a); if (c.channels === 1 && c.bytes.every((b, k) => b === o.bytes[k]) && c.bytes.length === o.bytes.length) good++; }
    }
    return n >= 20 && good === n;
  })());

  // the three-channel image, by hand
  const A = [{ tone: 0x123, vol: 5, noise: 3, mix: 6 }, { tone: 0x045, vol: 15, noise: 0, mix: 6 }];
  const B = [{ tone: 0x0FF, vol: 2, noise: 31, mix: 5 }];
  const C = [{ tone: 0xE01, vol: 14, noise: 1, mix: 4 }, { tone: 1, vol: 1, noise: 2, mix: 3 }, { tone: 4095, vol: 0, noise: 0, mix: 0 }];
  const r = convertSfx({ ticks: A, ticksB: B, ticksC: C });
  // spelled out explicitly (tone_lo, tone_hi | vol << 4, noise | mix << 5, 0): refresh 0 = A0 B0 C0
  const g0 = [0x23, 0x01 | (5 << 4), 3 | (6 << 5), 3, 0xFF, 0x00 | (2 << 4), 31 | (5 << 5), 0, 0x01, 0x0E | (14 << 4), 1 | (4 << 5), 0];
  const g1 = [0x45, 0x00 | (15 << 4), 0 | (6 << 5), 0, 0, 0, 0xE0, 0, 1, 0 | (1 << 4), 2 | (3 << 5), 0];
  const g2 = [0, 0, 0xE0, 0, 0, 0, 0xE0, 0, 0xFF, 0x0F | (0 << 4), 0 | (0 << 5), 0];
  const img = [...g0, ...g1, ...g2, 0, 0xFF, 0, 0];
  ok('three channels: groups of 12 bytes (A, B, C records), shorter channels padded with tone 0 / vol 0 / noise 0 / mix 7, byte 3 of the first record = 3, one terminator',
    r.channels === 3 && r.records === 3 && same(Array.from(r.bytes), img) && r.bytes.length === 3 * 12 + 4, Array.from(r.bytes).slice(0, 14).join(','));
  ok('only the FIRST record carries the channel count: byte 3 of every other record is 0', r.bytes.every((b, k) => k === 3 ? b === 3 : (k % 4 !== 3 || b === 0)));
  ok('channel B alone (A given): A is the first record of each group, B the second, C silent padding', (() => {
    const o = convertSfx({ ticks: [{ tone: 10, vol: 1, noise: 0, mix: 6 }], ticksB: [{ tone: 20, vol: 2, noise: 0, mix: 6 }, { tone: 21, vol: 3, noise: 0, mix: 6 }] });
    return o.records === 2 && o.channels === 3 && o.bytes.length === 28 && same(Array.from(o.bytes.slice(0, 12)), [10, 0x10, 6 << 5, 3, 20, 0x20, 6 << 5, 0, 0, 0, 0xE0, 0])
      && same(Array.from(o.bytes.slice(12, 24)), [0, 0, 0xE0, 0, 21, 0x30, 6 << 5, 0, 0, 0, 0xE0, 0]) && same(Array.from(o.bytes.slice(24)), [0, 0xFF, 0, 0]);
  })());
  ok('an empty channel A with a track B is allowed: A is all silent padding, records = B\'s length', (() => {
    const o = convertSfx({ ticks: [], ticksB: [{ tone: 20, vol: 2, noise: 0, mix: 6 }] });
    return o.records === 1 && o.channels === 3 && same(Array.from(o.bytes.slice(0, 4)), [0, 0, 0xE0, 3]) && o.bytes.length === 16;
  })());
  ok('the terminator\'s second byte is $FF and no record of the effect has it (every channel: the unstorable rule)', (() => {
    const o = convertSfx({ ticks: A, ticksB: B, ticksC: C });
    for (let k = 0; k < o.records; k++) for (let c = 0; c < 3; c++) if (o.bytes[k * 12 + c * 4 + 1] === 0xFF) return false;
    return o.bytes[o.bytes.length - 3] === 0xFF;
  })());
  const msg = (e) => { try { convertSfx(e); return null; } catch (x) { return x.message; } };
  ok('errors name the channel: "channel B tick 1 tone ...", "channel C tick 0: tone 3900 with volume 15 cannot be stored", channel A in a multi-channel effect too',
    /^channel B tick 1 tone must be a whole number 0\.\.4095/.test(msg({ ticks: [], ticksB: [tk(1), { tone: 5000 }] }))
    && /^channel C tick 0: tone 3900 with volume 15 cannot be stored/.test(msg({ ticks: [tk(1)], ticksC: [tk(3900, 15)] }))
    && /^channel A tick 2 vol must be/.test(msg({ ticks: [tk(1), tk(2), { tone: 1, vol: 16 }], ticksB: [tk(1)] }))
    && /^tick 2 vol must be/.test(msg({ ticks: [tk(1), tk(2), { tone: 1, vol: 16 }] })));
  ok('a ticksB / ticksC that is not an array is refused naming the channel (null, undefined and [] mean none)',
    /ticksB.*channel B.*array/.test(msg({ ticks: [], ticksB: 'x' })) && /ticksC.*channel C/.test(msg({ ticks: [], ticksC: 7 })) && msg({ ticks: [], ticksB: null, ticksC: undefined }) === null && msg({ ticks: [tk(1)], ticksB: [], ticksC: [] }) === null);
  ok('records is the longest channel (the interpreter\'s sound-length model) and the image length is records * 12 + 4', (() => {
    for (const [a, b, c] of [[3, 0, 5], [7, 2, 1], [0, 4, 0], [1, 1, 1]]) {
      const o = convertSfx({ ticks: Array(a).fill(tk(5)), ticksB: Array(b).fill(tk(6)), ticksC: Array(c).fill(tk(7)) });
      if (o.records !== Math.max(a, b, c) || o.bytes.length !== o.records * 12 + 4 || o.channels !== 3) return false;
    }
    return true;
  })());
}

console.log(`\n${failed === 0 ? 'All' : 'Some'} checks done: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
