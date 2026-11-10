/**
 * src/tools/sound-model.js — the data model of the Leap Arcade Studio sound editor, and the AY preview renderer
 * (pure: no DOM, Node can import it).  Contract: docs/ARCADE_STUDIO_S2_CONTRACT.md sections 2 and 6.
 *
 * One effect is edited as a plain object that has the same shape as the stored asset:
 *
 *   { ticks: [ { tone, vol, noise, mix } ... ], ...unknown keys kept }
 *
 *   tone   0..4095  AY channel A period (frequency = clock / (16 * tone), a period of 0 behaves as 1)
 *   vol    0..15    channel A volume
 *   noise  0..31    noise period (0 behaves as 1)
 *   mix    0..7     bit 0 = tone OFF, bit 1 = noise OFF, bit 2 unused by the runtime (written set, as the examples do)
 *
 * One record is played per refresh (58,688 T at 3.528 MHz = 60.115 per second).  A record with tone 3840..4095 and vol 15
 * cannot be stored (its byte 1 would be $FF, the terminator): every setter and operation here refuses to make one.
 *
 * Editing functions MUTATE the effect they are given and return a plain result: `{value, message}` for one field,
 * `{message, range?}` for an operation on a tick range.  `message` is null, or a sentence for the status line (a value was
 * clamped, a refusal).  A range is `(a, b)`, tick indices, INCLUSIVE, taken in either order and clipped to the effect.
 *
 *   fromAsset(asset) / toAsset(sfx)         stored <-> editing form (deep copies; unknown keys kept; missing vol / noise / mix read as 0)
 *   newSfx(preset), PRESETS                 beep laser blip explosion powerup hurt
 *   clampField, setTick, MIX_FORMS, mixOf, toneOn, noiseOn
 *   insertTicks, deleteTicks, duplicateRange, reverseRange, scaleVolume, fade, sweep, repeatRange, setRange
 *   noteOfTone, toneOfNote                  tone period <-> note name and cents
 *   sfxInfo, validateSfx                    duration, bytes on the cartridge, the compiler's limits
 *   renderSfx(asset, {rate, clock, refreshHz})   the AY model -> Float32Array (mono, -0.5..0.5)
 *   createHistory                           undo / redo (the sprite editor's)
 */

"use strict";

export { createHistory } from './sprite-model.js';

// ── constants ─────────────────────────────────────────────────────────────────────────────────────────────────
export const AY_CLOCK = 1764000;                       // CPU / 2 as TSRun has it (unconfirmed on hardware, ARCADE_HARDWARE_NOTES.md section 4)
export const REFRESH_HZ = 3528000 / 58688;             // one record per refresh, about 60.115 per second
export const MAX_SFX = 8;                              // effects per game (the code generator checks)
/** A soft cap of the editor (30 s, 7.2 KB on the cartridge); the compiler has no limit of its own. */
export const MAX_TICKS = 1800;
/** AY logarithmic volume table (contract section 6), index = vol 0..15. */
export const AY_VOLUME = [0, .0100, .0145, .0211, .0307, .0455, .0645, .1073, .1266, .2050, .2922, .3728, .4925, .6353, .8056, 1];
export const FIELDS = {
  tone: { min: 0, max: 4095 },
  vol: { min: 0, max: 15 },
  noise: { min: 0, max: 31 },
  mix: { min: 0, max: 7 },
};
export const FIELD_NAMES = ['tone', 'vol', 'noise', 'mix'];
/** The tone range that cannot go with vol 15 (the record's byte 1 would be $FF). */
export const UNSTORABLE_TONE_FROM = 3840;
export const DEFAULT_TICK = { tone: 300, vol: 12, noise: 0, mix: 6 };

/**
 * The four tone / noise combinations of the mix field.  Bit 0 of `mix` = tone OFF, bit 1 = noise OFF (AY register 7 for
 * channel A), bit 2 is ignored by the runtime and always written SET here, as the example effects do:
 *   tone only 6 (110), tone + noise 4 (100), noise only 5 (101), neither 7 (111, silent).
 * (The contract's "4 / 6 / 0 / 2" lists two combinations twice: 0 = 4 and 2 = 6, bit 2 being ignored.)
 */
export const MIX_FORMS = [
  { id: 'tone', label: 'tone only', tone: true, noise: false, mix: 6 },
  { id: 'both', label: 'tone + noise', tone: true, noise: true, mix: 4 },
  { id: 'noise', label: 'noise only', tone: false, noise: true, mix: 5 },
  { id: 'off', label: 'off', tone: false, noise: false, mix: 7 },
];
export const mixOf = (toneIsOn, noiseIsOn) => 4 | (toneIsOn ? 0 : 1) | (noiseIsOn ? 0 : 2);
export const toneOn = (mix) => ((mix ?? 0) & 1) === 0;
export const noiseOn = (mix) => ((mix ?? 0) & 2) === 0;

const isTick = (t) => t && typeof t === 'object' && !Array.isArray(t);
const num = (v, dflt) => (typeof v === 'number' && Number.isFinite(v) ? v : dflt);

// ── conversion ────────────────────────────────────────────────────────────────────────────────────────────────
/** The stored asset -> the editing form (a deep copy).  Throws an Error with a plain message when it cannot be read. */
export function fromAsset(asset) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) throw new Error('the sound effect is not an object');
  if (!Array.isArray(asset.ticks)) throw new Error('the sound effect has no "ticks" array');
  const sfx = { ...asset, ticks: asset.ticks.map((t, i) => {
    if (!isTick(t)) throw new Error(`tick ${i} is not an object`);
    if (t.tone === undefined || t.tone === null) throw new Error(`tick ${i} tone is missing`);
    return { ...t, tone: t.tone, vol: t.vol ?? 0, noise: t.noise ?? 0, mix: t.mix ?? 0 };
  }) };
  return sfx;
}
/** The editing form -> the stored asset (a deep copy, the same keys). */
export function toAsset(sfx) {
  return { ...sfx, ticks: sfx.ticks.map((t) => ({ ...t })) };
}
export const cloneSfx = toAsset;

// ── single fields ─────────────────────────────────────────────────────────────────────────────────────────────
/** Clamp one value into a field's range (whole numbers; fractions are rounded).  -> {value, message} (value null if not a number). */
export function clampField(field, value) {
  const f = FIELDS[field];
  if (!f) throw new RangeError(`unknown field ${field}`);
  if (typeof value !== 'number' || !Number.isFinite(value)) return { value: null, message: `${field} must be a number` };
  const v = Math.round(value);
  if (v < f.min) return { value: f.min, message: `${field} limited to ${f.min}..${f.max}` };
  if (v > f.max) return { value: f.max, message: `${field} limited to ${f.min}..${f.max}` };
  return { value: v, message: null };
}
const isUnstorable = (t) => t.vol === 15 && t.tone >= UNSTORABLE_TONE_FROM;
/**
 * If the tick is the unstorable combination, change the field named by `prefer` ('tone': to 3839, 'vol': to 14).
 * Returns true when it changed something.
 */
function fixCombo(t, prefer) {
  if (!isUnstorable(t)) return false;
  if (prefer === 'tone') t.tone = UNSTORABLE_TONE_FROM - 1; else t.vol = 14;
  return true;
}
const COMBO_TEXT = 'tone 3840 and above with volume 15 cannot be stored (the byte $FF ends an effect)';

/** Set one field of one tick, clamped, refusing the $FF combination.  Mutates; -> {value (what was stored, null if nothing was), message}. */
export function setTick(sfx, i, field, value) {
  const t = sfx.ticks[i];
  if (!t) throw new RangeError(`no tick ${i}`);
  const c = clampField(field, value);
  if (c.value === null) return c;
  t[field] = c.value;
  let message = c.message;
  if (isUnstorable(t) && (field === 'tone' || field === 'vol')) {
    fixCombo(t, field);
    message = `${COMBO_TEXT}: ${field} limited to ${t[field]}`;
  }
  return { value: t[field], message };
}

// ── ranges ────────────────────────────────────────────────────────────────────────────────────────────────────
/** (a, b) in either order, clipped to the effect; null when the effect has no ticks. */
function span(sfx, a, b) {
  const n = sfx.ticks.length;
  if (n === 0) return null;
  let lo = Math.min(a, b ?? a), hi = Math.max(a, b ?? a);
  lo = Math.max(0, Math.min(n - 1, Math.round(lo)));
  hi = Math.max(0, Math.min(n - 1, Math.round(hi)));
  return [lo, hi];
}
const fixedMessage = (n, what) => (n ? `${n} tick${n === 1 ? '' : 's'} adjusted: ${what} (${COMBO_TEXT})` : null);

/** Insert `n` ticks at index `at` (0..length).  They are copies of `template`, by default the tick before `at` (the first tick if `at` is 0). */
export function insertTicks(sfx, at, n = 1, template = null) {
  const len = sfx.ticks.length;
  at = Math.max(0, Math.min(len, Math.round(at)));
  n = Math.max(0, Math.round(n));
  const room = MAX_TICKS - len;
  let message = null;
  if (n > room) { n = Math.max(0, room); message = `an effect has at most ${MAX_TICKS} ticks`; }
  const src = template ?? sfx.ticks[at - 1] ?? sfx.ticks[at] ?? DEFAULT_TICK;
  const fresh = Array.from({ length: n }, () => ({ ...src }));
  sfx.ticks.splice(at, 0, ...fresh);
  return { message, range: n ? [at, at + n - 1] : null };
}
/** Delete the ticks a..b.  An effect keeps at least one tick: deleting all of them is refused. */
export function deleteTicks(sfx, a, b) {
  const r = span(sfx, a, b);
  if (!r) return { message: 'nothing to delete', range: null };
  if (r[1] - r[0] + 1 >= sfx.ticks.length) return { message: 'an effect needs at least one tick', range: [r[0], r[1]] };
  sfx.ticks.splice(r[0], r[1] - r[0] + 1);
  const at = Math.min(r[0], sfx.ticks.length - 1);
  return { message: null, range: [at, at] };
}
/** Copy the range a..b and insert the copy right after it.  -> {range: the new copy} */
export function duplicateRange(sfx, a, b) {
  const r = span(sfx, a, b);
  if (!r) return { message: 'nothing to duplicate', range: null };
  const len = r[1] - r[0] + 1;
  if (sfx.ticks.length + len > MAX_TICKS) return { message: `an effect has at most ${MAX_TICKS} ticks`, range: r };
  sfx.ticks.splice(r[1] + 1, 0, ...sfx.ticks.slice(r[0], r[1] + 1).map((t) => ({ ...t })));
  return { message: null, range: [r[1] + 1, r[1] + len] };
}
/** Play the range a..b `n` times in all: n - 1 copies are inserted after it (n = 1 changes nothing).  -> {range: the whole repeated run} */
export function repeatRange(sfx, a, b, n) {
  const r = span(sfx, a, b);
  if (!r) return { message: 'nothing to repeat', range: null };
  n = Math.max(1, Math.round(n));
  const len = r[1] - r[0] + 1;
  let message = null;
  if (sfx.ticks.length + (n - 1) * len > MAX_TICKS) {
    n = Math.max(1, 1 + Math.floor((MAX_TICKS - sfx.ticks.length) / len));
    message = `an effect has at most ${MAX_TICKS} ticks: repeated ${n} times`;
  }
  const unit = sfx.ticks.slice(r[0], r[1] + 1);
  const extra = [];
  for (let k = 1; k < n; k++) for (const t of unit) extra.push({ ...t });
  sfx.ticks.splice(r[1] + 1, 0, ...extra);
  return { message, range: [r[0], r[0] + n * len - 1] };
}
/** Reverse the order of the ticks a..b. */
export function reverseRange(sfx, a, b) {
  const r = span(sfx, a, b);
  if (!r) return { message: 'nothing to reverse', range: null };
  const part = sfx.ticks.slice(r[0], r[1] + 1).reverse();
  sfx.ticks.splice(r[0], part.length, ...part);
  return { message: null, range: r };
}
/** Multiply the volume of a..b by `factor` (rounded, clamped 0..15; 15 becomes 14 where the tone could not go with it). */
export function scaleVolume(sfx, a, b, factor) {
  const r = span(sfx, a, b);
  if (!r) return { message: 'nothing to scale', range: null };
  if (typeof factor !== 'number' || !Number.isFinite(factor) || factor < 0) return { message: 'the factor must be a number, 0 or more', range: r };
  let fixed = 0;
  for (let i = r[0]; i <= r[1]; i++) {
    const t = sfx.ticks[i];
    t.vol = clampField('vol', t.vol * factor).value;
    if (fixCombo(t, 'vol')) fixed++;
  }
  return { message: fixedMessage(fixed, 'volume limited to 14'), range: r };
}
/**
 * Fade a..b: 'out' multiplies the volume by a factor falling linearly from 1 at the first tick to 0 at the last, 'in' rises
 * from 0 at the first tick to 1 at the last (factor = j / (n - 1) for tick j of n; a range of one tick is left alone).
 */
export function fade(sfx, a, b, direction) {
  const r = span(sfx, a, b);
  if (!r) return { message: 'nothing to fade', range: null };
  if (direction !== 'in' && direction !== 'out') throw new RangeError("direction must be 'in' or 'out'");
  const n = r[1] - r[0] + 1;
  if (n > 1) {
    for (let j = 0; j < n; j++) {
      const k = direction === 'in' ? j / (n - 1) : (n - 1 - j) / (n - 1);
      const t = sfx.ticks[r[0] + j];
      t.vol = clampField('vol', t.vol * k).value;
    }
  }
  return { message: null, range: r };
}
/**
 * Sweep a field over a..b from `from` at the first tick to `to` at the last (a range of one tick gets `from`).
 * mode 'tone' = linear in the value, 'semitones' = linear in pitch (geometric in the period, a period of 0 counting as 1;
 * only for the tone field).  Values are rounded and clamped; the $FF combination is avoided by limiting the tone to 3839.
 */
export function sweep(sfx, a, b, from, to, mode = 'tone', field = 'tone') {
  const r = span(sfx, a, b);
  if (!r) return { message: 'nothing to sweep', range: null };
  if (!Number.isFinite(from) || !Number.isFinite(to)) return { message: 'from and to must be numbers', range: r };
  if (mode !== 'tone' && mode !== 'semitones') throw new RangeError("mode must be 'tone' or 'semitones'");
  if (!FIELDS[field]) throw new RangeError(`unknown field ${field}`);
  const n = r[1] - r[0] + 1;
  let fixed = 0, clamped = 0;
  for (let j = 0; j < n; j++) {
    const k = n === 1 ? 0 : j / (n - 1);
    let v;
    if (mode === 'semitones' && field === 'tone') { const f0 = Math.max(from, 1), f1 = Math.max(to, 1); v = f0 * Math.pow(f1 / f0, k); }
    else v = from + (to - from) * k;
    const t = sfx.ticks[r[0] + j];
    const c = clampField(field, v);
    if (c.message) clamped++;
    t[field] = c.value;
    if (fixCombo(t, 'tone')) fixed++;
  }
  const message = fixedMessage(fixed, 'tone limited to 3839') ?? (clamped ? `${field} limited to ${FIELDS[field].min}..${FIELDS[field].max} on ${clamped} tick${clamped === 1 ? '' : 's'}` : null);
  return { message, range: r };
}
/** Set one field of every tick of a..b to a value (clamped; the $FF combination is refused).  -> {value, message, range} */
export function setRange(sfx, a, b, field, value) {
  const r = span(sfx, a, b);
  if (!r) return { value: null, message: 'nothing to set', range: null };
  const c = clampField(field, value);
  if (c.value === null) return { ...c, range: r };
  let fixed = 0;
  for (let i = r[0]; i <= r[1]; i++) {
    const t = sfx.ticks[i];
    t[field] = c.value;
    if ((field === 'tone' || field === 'vol') && fixCombo(t, field)) fixed++;
  }
  const message = fixedMessage(fixed, `${field} limited to ${field === 'tone' ? 3839 : 14}`) ?? c.message;
  return { value: fixed ? (field === 'tone' ? UNSTORABLE_TONE_FROM - 1 : 14) : c.value, message, range: r };
}

// ── notes ─────────────────────────────────────────────────────────────────────────────────────────────────────
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const freqOfTone = (tone, clock) => clock / (16 * Math.max(tone, 1));
/** The nearest equal-tempered note (A4 = 440 Hz) of a tone period. -> {name: 'A4', midi, cents (-50..50, whole), freq} */
export function noteOfTone(tone, clock = AY_CLOCK) {
  const freq = freqOfTone(tone, clock);
  const exact = 69 + 12 * Math.log2(freq / 440);
  const midi = Math.round(exact);
  return { name: NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1), midi, cents: Math.round((exact - midi) * 100), freq };
}
/** The tone period (whole, clamped 1..4095) of a note: a MIDI number (69 = A4) or a name such as 'A4', 'C#5', 'Bb3'. */
export function toneOfNote(note, clock = AY_CLOCK) {
  let midi = note;
  if (typeof note === 'string') {
    const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(note.trim());
    if (!m) throw new Error(`"${note}" is not a note name such as A4, C#5 or Bb3`);
    midi = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12 * (Number(m[3]) + 1);
  }
  const freq = 440 * Math.pow(2, (midi - 69) / 12);
  return Math.max(1, Math.min(4095, Math.round(clock / (16 * freq))));
}

// ── presets ───────────────────────────────────────────────────────────────────────────────────────────────────
export const PRESETS = ['beep', 'laser', 'blip', 'explosion', 'powerup', 'hurt'];
const lerp = (a, b, k) => Math.round(a + (b - a) * k);
const ramp = (n, f) => Array.from({ length: n }, (_, j) => f(n === 1 ? 0 : j / (n - 1), j));
/** A new effect from a preset (default 'beep'): a short, valid, sensible effect to edit. */
export function newSfx(preset = 'beep') {
  let ticks;
  switch (preset) {
    case 'beep':        // A4 for 8 refreshes, then a short tail
      ticks = [...ramp(8, () => ({ tone: toneOfNote('A4'), vol: 12, noise: 0, mix: 6 })), { tone: toneOfNote('A4'), vol: 8, noise: 0, mix: 6 }, { tone: toneOfNote('A4'), vol: 4, noise: 0, mix: 6 }];
      break;
    case 'laser':       // pitch falls fast, volume fades
      ticks = ramp(12, (k) => ({ tone: lerp(60, 520, k), vol: lerp(14, 3, k), noise: 0, mix: 6 }));
      break;
    case 'blip':        // one short high tick pattern
      ticks = [13, 13, 9, 5].map((vol) => ({ tone: 180, vol, noise: 0, mix: 6 }));
      break;
    case 'explosion':   // noise only, the noise period lengthens while the volume decays
      ticks = ramp(24, (k) => ({ tone: 0, vol: lerp(15, 0, k * k), noise: lerp(6, 31, k), mix: 5 }));
      break;
    case 'powerup':     // a rising arpeggio C4 E4 G4 C5 E5 G5, each note held two refreshes
      ticks = ramp(12, (k, j) => ({ tone: toneOfNote(['C4', 'E4', 'G4', 'C5', 'E5', 'G5'][Math.floor(j / 2)]), vol: lerp(12, 8, k), noise: 0, mix: 6 }));
      break;
    case 'hurt':        // a buzzy falling tone: tone gated by noise
      ticks = ramp(10, (k) => ({ tone: lerp(240, 620, k), vol: lerp(14, 5, k), noise: 14, mix: 4 }));
      break;
    default: throw new RangeError(`unknown preset ${preset} (${PRESETS.join(', ')})`);
  }
  return { ticks };
}

// ── information and validation ────────────────────────────────────────────────────────────────────────────────
/** Size of an effect: {ticks, seconds (at refreshHz), bytes on the cartridge = (ticks + 1) * 4}. */
export function sfxInfo(sfx, refreshHz = REFRESH_HZ) {
  const ticks = sfx.ticks.length;
  return { ticks, seconds: ticks / refreshHz, bytes: (ticks + 1) * 4 };
}
/**
 * The compiler's rules (arcade-assets.js convertSfx) plus the editor's notes.
 * -> {ok, errors: [string], warnings: [string], unstorable: [tick indices]}.  `ok` is true exactly when convertSfx accepts it.
 */
export function validateSfx(sfx) {
  const errors = [], warnings = [], unstorable = [];
  if (!sfx || !Array.isArray(sfx.ticks)) return { ok: false, errors: ['the sound effect has no "ticks" array'], warnings, unstorable };
  const whole = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  sfx.ticks.forEach((t, i) => {
    let bad = false;
    for (const f of FIELD_NAMES) {
      const v = t?.[f];
      const { min, max } = FIELDS[f];
      if (v === undefined || v === null) { if (f === 'tone') { errors.push(`tick ${i} tone is missing`); bad = true; } continue; }
      if (!whole(v, min, max)) { errors.push(`tick ${i} ${f} must be a whole number ${min}..${max}, got ${JSON.stringify(v)}`); bad = true; }
    }
    if (!bad && (((t.tone >> 8) | ((t.vol ?? 0) << 4)) === 0xFF)) { errors.push(`tick ${i}: ${COMBO_TEXT}`); unstorable.push(i); }
  });
  if (sfx.ticks.length === 0) warnings.push('the effect has no ticks and plays nothing');
  if (sfx.ticks.length > MAX_TICKS) warnings.push(`the effect has more than ${MAX_TICKS} ticks`);
  return { ok: errors.length === 0, errors, warnings, unstorable };
}

// ── the AY preview ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Render an effect as mono samples in -0.5..0.5 (full volume peaks at 0.5).  `asset` is the stored or the editing form.
 *
 *   length      round(ticks * rate / refreshHz) samples; record i is heard from sample ceil(i * rate / refreshHz) on
 *   tone        square wave, frequency clock / (16 * period), phase continuous across records, period 0 taken as 1
 *   noise       the AY's 17-bit LFSR (feedback bit 0 xor bit 3), shifted at clock / (16 * period), period 0 taken as 1
 *   mixer       channel = (tone square OR tone off) AND (noise bit OR noise off); a channel with tone and noise both off
 *               is a constant level on the chip, rendered here as silence (no DC)
 *   volume      AY_VOLUME[vol]; the output is bipolar: +-0.5 * AY_VOLUME[vol]
 *
 * No band limiting: tones above half the sample rate alias (a preview, not a reference).
 */
export function renderSfx(asset, { rate = 44100, clock = AY_CLOCK, refreshHz = REFRESH_HZ } = {}) {
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
    const amp = 0.5 * AY_VOLUME[vol];
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
