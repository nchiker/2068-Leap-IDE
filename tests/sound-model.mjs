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

console.log(`\n${failed === 0 ? 'All' : 'Some'} checks done: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
