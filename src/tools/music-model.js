/**
 * src/tools/music-model.js — the data model of songs in the Leap Arcade Studio sound editor (pure: no DOM, Node can import it).
 * Contract: docs/ARCADE_MUSIC_CONTRACT.md sections 3 (the asset) and 7 (the Studio).
 *
 * A song is edited as a plain object with the shape of the stored asset (project JSON `assets.music.<name>`):
 *
 *   { patterns: [ { ticks, ticksB, ticksC, name? } ... ], order: [pattern index ...], loop: order position | null, ...unknown keys kept }
 *
 * Each pattern is a three-channel sound effect in sound-model.js's editing form (ticksB / ticksC always arrays, [] when unused), so every
 * operation of sound-model.js works on `song.patterns[i]` unchanged.  `name` is an optional label of a pattern (authoring data: the compiler
 * ignores it).  `order` lists pattern indices, played in that order; `loop` is the order position the song continues from after the last
 * entry, or null (the song stops).  Limits (arcade-assets.js, the compiler's): 32 patterns, 64 order entries, 1,800 refreshes a pattern.
 *
 * Editing functions MUTATE the song and return `{message, pattern?, pos?}`: `message` is null or a sentence for the status line (a refusal
 * changes nothing); `pattern` / `pos` say which pattern / order position the editor should show afterwards.
 *
 *   fromSong(asset) / toSong(song) / cloneSong      stored <-> editing form (deep copies; unknown keys kept)
 *   newSong(), newPattern(length)                   a short default song (one pattern, order [0], loop 0) / a silent pattern
 *   addPattern, duplicatePattern, deletePattern, movePattern, labelPattern        the pattern list (the order list follows every change)
 *   orderAppend, orderInsert, orderRemove, orderMove, orderSet, setLoop           the order list and the loop (the loop follows its entry)
 *   INSTRUMENTS, noteRecords, enterNote, enterRest  note entry for one track (a sound-model trackView), filling records with toneOfNote
 *   patternLength, patternBytes, songInfo, validateSong    lengths, sizes (convertMusic), the compiler's rules
 *   songTimeline, renderSong                        the patterns in order (the loop played once more) as one effect, and its AY preview
 *   createHistory                                   undo / redo (the sprite editor's)
 */

"use strict";

import * as S from './sound-model.js';
import { convertMusic, convertPattern, MAX_PATTERNS, MAX_ORDER, MAX_PATTERN_TICKS, MAX_SONGS } from '../lang/arcade/arcade-assets.js';

export { createHistory } from './sprite-model.js';
export { MAX_PATTERNS, MAX_ORDER, MAX_PATTERN_TICKS, MAX_SONGS };

/** The length of a new pattern (refreshes): 32 is about half a second, four notes of 8. */
export const DEFAULT_PATTERN_TICKS = 32;
/** The song preview stops after this many refreshes (5 minutes), so a long song cannot exhaust the browser's memory. */
export const MAX_PREVIEW_TICKS = Math.round(300 * S.REFRESH_HZ);
const SILENT = { tone: 0, vol: 0, noise: 0, mix: 7 };            // what the compiler pads a shorter channel with (both mixer bits off)

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clampInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(v)));
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ── conversion ────────────────────────────────────────────────────────────────────────────────────────────────
/** The stored asset -> the editing form (a deep copy).  Throws an Error with a plain message when it cannot be read. */
export function fromSong(asset) {
  if (!isObj(asset)) throw new Error('the song is not an object');
  if (!Array.isArray(asset.patterns) || asset.patterns.length === 0) throw new Error('the song has no "patterns"');
  if (!Array.isArray(asset.order)) throw new Error('the song has no "order" list');
  const song = { ...asset };
  song.patterns = asset.patterns.map((p, i) => { try { return S.fromAsset(p); } catch (e) { throw new Error(`pattern ${i}: ${e.message.replace(/^the sound effect /, 'it ')}`); } });
  song.order = asset.order.slice();
  song.loop = asset.loop === undefined ? null : asset.loop;
  return song;
}
/** The editing form -> the stored asset (a deep copy; a pattern's ticksB / ticksC only when they hold ticks). */
export function toSong(song) {
  return { ...song, patterns: song.patterns.map((p) => S.toAsset(p)), order: song.order.slice(), loop: song.loop ?? null };
}
export function cloneSong(song) {
  return { ...song, patterns: song.patterns.map((p) => S.cloneSfx(p)), order: song.order.slice(), loop: song.loop ?? null };
}

/** A silent pattern of `length` refreshes on channel A (B and C empty): the start of a new pattern. */
export function newPattern(length = DEFAULT_PATTERN_TICKS) {
  const n = clampInt(length, 1, MAX_PATTERN_TICKS);
  return { ticks: Array.from({ length: n }, () => ({ ...S.PAD_TICK })), ticksB: [], ticksC: [] };
}

/** A short default song: one pattern (an organ phrase C4 E4 G4 C5 of 8 refreshes each on channel A, a bass C3 on B), order [0], loop 0. */
export function newSong() {
  const p = newPattern(DEFAULT_PATTERN_TICKS);
  const a = S.trackView(p, 0), b = S.trackView(p, 1);
  ['C4', 'E4', 'G4', 'C5'].forEach((n, i) => enterNote(a, i * 8, n, 8, 'organ'));
  enterNote(b, 0, 'C3', 16, 'bass');
  enterNote(b, 16, 'G2', 16, 'bass');
  return { patterns: [p], order: [0], loop: 0 };
}

// ── the pattern list ──────────────────────────────────────────────────────────────────────────────────────────
const patIndex = (song, i) => (Number.isInteger(i) && i >= 0 && i < song.patterns.length ? i : null);

/** Add a pattern at index `at` (default: the end): `template` (copied) or a silent one of `length` refreshes.  Order entries keep their patterns. */
export function addPattern(song, at = song.patterns.length, template = null, length = DEFAULT_PATTERN_TICKS) {
  if (song.patterns.length >= MAX_PATTERNS) return { message: `a song has at most ${MAX_PATTERNS} patterns` };
  at = clampInt(at, 0, song.patterns.length);
  song.patterns.splice(at, 0, template ? S.cloneSfx(template) : newPattern(length));
  song.order = song.order.map((p) => (p >= at ? p + 1 : p));
  return { message: null, pattern: at };
}
/** Copy pattern i and insert the copy right after it (the order list still plays the original). */
export function duplicatePattern(song, i) {
  if (patIndex(song, i) === null) return { message: `there is no pattern ${i}` };
  const r = addPattern(song, i + 1, song.patterns[i]);
  if (r.message) return r;
  const label = song.patterns[i].name;
  if (typeof label === 'string' && label) song.patterns[i + 1].name = `${label} copy`.slice(0, 24);
  return r;
}
/**
 * Delete pattern i.  Its order entries go and the later patterns' indices in the order list drop by one; the loop stays on its entry, or moves to
 * the next entry kept.  The order list never empties: when every entry played this pattern, the order becomes [0].  The last pattern cannot be deleted.
 */
export function deletePattern(song, i) {
  if (patIndex(song, i) === null) return { message: `there is no pattern ${i}` };
  if (song.patterns.length === 1) return { message: 'a song needs at least one pattern' };
  song.patterns.splice(i, 1);
  const keep = [];
  song.order.forEach((p, pos) => { if (p !== i) keep.push({ p: p > i ? p - 1 : p, pos }); });
  let message = null;
  if (keep.length === 0) {
    song.order = [0];
    song.loop = song.loop === null ? null : 0;
    message = `the order list played only that pattern: it now plays pattern 0`;
  } else {
    song.loop = remapLoop(song.loop, keep.map((k) => k.pos));
    song.order = keep.map((k) => k.p);
  }
  return { message, pattern: Math.min(i, song.patterns.length - 1), pos: 0 };
}
/** Move pattern `from` to index `to` (the others shift); the order list is renumbered so it plays the same music. */
export function movePattern(song, from, to) {
  if (patIndex(song, from) === null) return { message: `there is no pattern ${from}` };
  to = clampInt(to, 0, song.patterns.length - 1);
  if (to === from) return { message: null, pattern: from };
  const ids = song.patterns.map((_, k) => k);
  const [p] = song.patterns.splice(from, 1);
  song.patterns.splice(to, 0, p);
  ids.splice(to, 0, ids.splice(from, 1)[0]);              // ids[newIndex] = oldIndex
  const newOf = new Array(ids.length);
  ids.forEach((old, nw) => { newOf[old] = nw; });
  song.order = song.order.map((q) => newOf[q] ?? q);
  return { message: null, pattern: to };
}
/** Set a pattern's label (text up to 24 characters; empty removes it).  The compiler ignores it. */
export function labelPattern(song, i, text) {
  if (patIndex(song, i) === null) return { message: `there is no pattern ${i}` };
  const t = String(text ?? '').trim().slice(0, 24);
  if (t) song.patterns[i].name = t; else delete song.patterns[i].name;
  return { message: null, pattern: i };
}
/** A pattern's display name: "2" or "2 intro". */
export const patternTitle = (song, i) => (typeof song.patterns[i]?.name === 'string' && song.patterns[i].name ? `${i} ${song.patterns[i].name}` : String(i));

/** The loop after the order list kept only the old positions `kept` (ascending): it stays on its entry, or moves to the next one kept (else the last). */
function remapLoop(loop, kept) {
  if (loop === null || loop === undefined) return null;
  let at = kept.findIndex((pos) => pos >= loop);
  if (at < 0) at = kept.length - 1;
  return kept.length ? at : null;
}

// ── the order list and the loop ───────────────────────────────────────────────────────────────────────────────
const posIndex = (song, pos) => (Number.isInteger(pos) && pos >= 0 && pos < song.order.length ? pos : null);
const fullOrder = () => ({ message: `the order list has at most ${MAX_ORDER} entries` });
/** Append pattern p to the order list. */
export function orderAppend(song, p) {
  if (patIndex(song, p) === null) return { message: `there is no pattern ${p}` };
  if (song.order.length >= MAX_ORDER) return fullOrder();
  song.order.push(p);
  return { message: null, pos: song.order.length - 1, pattern: p };
}
/** Insert pattern p at order position pos (0..length); the entries from pos on move one later, and so does the loop when it is among them. */
export function orderInsert(song, pos, p) {
  if (patIndex(song, p) === null) return { message: `there is no pattern ${p}` };
  if (song.order.length >= MAX_ORDER) return fullOrder();
  pos = clampInt(pos, 0, song.order.length);
  song.order.splice(pos, 0, p);
  if (song.loop !== null && song.loop >= pos) song.loop++;
  return { message: null, pos, pattern: p };
}
/** Remove the entry at pos; the order list keeps at least one entry.  A loop on the removed entry moves to the entry after it (or the last). */
export function orderRemove(song, pos) {
  if (posIndex(song, pos) === null) return { message: `there is no order position ${pos}` };
  if (song.order.length === 1) return { message: 'the order list needs at least one entry' };
  const kept = song.order.map((_, k) => k).filter((k) => k !== pos);
  song.loop = remapLoop(song.loop, kept);
  song.order.splice(pos, 1);
  const at = Math.min(pos, song.order.length - 1);
  return { message: null, pos: at, pattern: song.order[at] };
}
/** Move the entry at `from` to position `to`; the loop stays on the entry it marks. */
export function orderMove(song, from, to) {
  if (posIndex(song, from) === null) return { message: `there is no order position ${from}` };
  to = clampInt(to, 0, song.order.length - 1);
  if (to === from) return { message: null, pos: from };
  const ids = song.order.map((_, k) => k);
  ids.splice(to, 0, ids.splice(from, 1)[0]);
  const [p] = song.order.splice(from, 1);
  song.order.splice(to, 0, p);
  if (song.loop !== null) song.loop = ids.indexOf(song.loop);
  return { message: null, pos: to, pattern: p };
}
/** Make the entry at pos play pattern p. */
export function orderSet(song, pos, p) {
  if (posIndex(song, pos) === null) return { message: `there is no order position ${pos}` };
  if (patIndex(song, p) === null) return { message: `there is no pattern ${p}` };
  song.order[pos] = p;
  return { message: null, pos, pattern: p };
}
/** The loop: an order position, or null for none (the song stops after its last entry). */
export function setLoop(song, pos) {
  if (pos === null || pos === undefined || pos === 'none' || pos === '') { song.loop = null; return { message: null }; }
  const n = typeof pos === 'string' ? Number(pos) : pos;
  if (posIndex(song, n) === null) return { message: `the loop must be an order position 0..${song.order.length - 1}, or none` };
  song.loop = n;
  return { message: null, pos: n };
}

// ── note entry ────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Instruments: a volume envelope (and for the drum, noise instead of tone) over a note's records.  `peak` is the loudest volume (1..15).
 *   pluck  starts at the peak and falls by a fifth every refresh (a plucked string, a harpsichord)
 *   organ  holds the peak; the last refresh at half, so repeated notes are heard apart
 *   bass   the peak for two refreshes, then falls to 60 % of it; the last refresh silent (a short gap), from 4 refreshes on
 *   drum   noise only, no tone; falls by 30 % every refresh; the note picks the noise period (higher notes = shorter period, a brighter hiss)
 */
export const INSTRUMENTS = [
  { id: 'pluck', label: 'pluck', peak: 14 },
  { id: 'organ', label: 'organ', peak: 11 },
  { id: 'bass', label: 'bass', peak: 13 },
  { id: 'drum', label: 'drum (noise)', peak: 14 },
];
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
export const NOTE_LETTERS = NOTE_NAMES.slice();
/** The MIDI number of a note name ('C#4', 'Bb3') or a number. Throws for anything else. */
function midiOf(note) {
  if (typeof note === 'number' && Number.isInteger(note)) return note;
  const m = /^([A-Ga-g])([#b]?)(-?\d)$/.exec(String(note).trim());
  if (!m) throw new Error(`"${note}" is not a note name such as A4, C#5 or Bb3`);
  return { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12 * (Number(m[3]) + 1);
}
/**
 * The records of one note: `length` refreshes (1..1800) of `note` (a name or a MIDI number) played by `instrument` (an INSTRUMENTS id).
 * opts.peak: the loudest volume (default the instrument's).  A record that would be unstorable (tone 3840 and above with volume 15) gets volume 14.
 */
export function noteRecords(note, length, instrument = 'organ', opts = {}) {
  const inst = INSTRUMENTS.find((x) => x.id === instrument);
  if (!inst) throw new RangeError(`unknown instrument ${instrument} (${INSTRUMENTS.map((x) => x.id).join(', ')})`);
  const midi = midiOf(note);
  const n = clampInt(Number.isFinite(length) ? length : 1, 1, MAX_PATTERN_TICKS);
  const peak = clampInt(Number.isFinite(opts.peak) ? opts.peak : inst.peak, 0, 15);
  const tone = S.toneOfNote(midi);
  const out = [];
  for (let j = 0; j < n; j++) {
    let vol, mix = 6, noise = 0;
    switch (instrument) {
      case 'pluck': vol = peak * Math.pow(0.8, j); break;
      case 'organ': vol = j === n - 1 && n >= 3 ? peak / 2 : peak; break;
      case 'bass': vol = n >= 4 && j === n - 1 ? 0 : j < 2 ? peak : peak * (1 - 0.4 * (j - 1) / Math.max(1, n - 3)); break;
      case 'drum': vol = peak * Math.pow(0.7, j); mix = 5; noise = clampInt((96 - midi) / 2, 1, 31); break;
      default: vol = peak;
    }
    const r = { tone, vol: clampInt(vol, 0, 15), noise, mix };
    if (r.vol === 15 && r.tone >= S.UNSTORABLE_TONE_FROM) r.vol = 14;
    out.push(r);
  }
  return out;
}
/** Write `records` into the track `view` (a sound-model trackView) from tick `at`, padding the track up to `at` and overwriting / extending after it. */
function writeRecords(view, at, records) {
  at = clampInt(Number.isFinite(at) ? at : 0, 0, MAX_PATTERN_TICKS - 1);
  let recs = records, message = null;
  if (at + recs.length > MAX_PATTERN_TICKS) { recs = recs.slice(0, MAX_PATTERN_TICKS - at); message = `a pattern has at most ${MAX_PATTERN_TICKS} ticks: the note was cut to ${plural(recs.length, 'tick')}`; }
  const list = view.ticks;
  while (list.length < at) list.push({ ...S.PAD_TICK });
  recs.forEach((r, k) => { list[at + k] = { ...r }; });
  return { message, range: [at, at + recs.length - 1], next: at + recs.length };
}
/** Enter a note in a track: the records of noteRecords from tick `at`.  -> {message, range: the note's ticks, next: the tick after it} (throws for a bad note name). */
export function enterNote(view, at, note, length, instrument = 'organ', opts = {}) {
  return writeRecords(view, at, noteRecords(note, length, instrument, opts));
}
/** Enter a rest: `length` silent records (volume 0) from tick `at`. */
export function enterRest(view, at, length) {
  const n = clampInt(Number.isFinite(length) ? length : 1, 1, MAX_PATTERN_TICKS);
  return writeRecords(view, at, Array.from({ length: n }, () => ({ ...S.PAD_TICK })));
}

// ── lengths, sizes and validation ────────────────────────────────────────────────────────────────────────────
/** A pattern's length in refreshes: its longest track. */
export const patternLength = (p) => S.effectLength(p);

/** Fields convertMusic would refuse clamped (as sound-model's size does), so a size can always be shown. */
function fixPattern(p) {
  const fix = (list) => (Array.isArray(list) ? list : []).map((t) => {
    const f = (k) => Math.max(S.FIELDS[k].min, Math.min(S.FIELDS[k].max, Math.round(typeof t?.[k] === 'number' && Number.isFinite(t[k]) ? t[k] : 0)));
    const r = { tone: f('tone'), vol: f('vol'), noise: f('noise'), mix: f('mix') };
    if (((r.tone >> 8) | (r.vol << 4)) === 0xFF) r.vol = 14;
    return r;
  });
  return { ticks: fix(p?.ticks), ticksB: fix(p?.ticksB), ticksC: fix(p?.ticksC) };
}
/** The bytes of one pattern's stream on the cartridge (fields clamped first); 0 for an empty pattern. */
export function patternBytes(p) {
  try { return convertPattern(fixPattern(p)).bytes.length; } catch { return 0; }
}
/**
 * Size and length of a song: {patterns, orderLength, loop, refreshes (one pass of the order list), seconds, loopRefreshes / loopSeconds (from the
 * loop position to the end; 0 without a loop), bytes on the cartridge (convertMusic, with refused fields clamped; null when the song's structure
 * cannot be converted), patternBytes: [per pattern], error (convertMusic's message for the song as it is, or null)}.
 */
export function songInfo(song, refreshHz = S.REFRESH_HZ) {
  const lens = song.patterns.map(patternLength);
  const refreshes = song.order.reduce((n, p) => n + (lens[p] ?? 0), 0);
  const loop = song.loop ?? null;
  const loopRefreshes = loop === null ? 0 : song.order.slice(loop).reduce((n, p) => n + (lens[p] ?? 0), 0);
  let bytes = null, error = null;
  try { convertMusic(song); } catch (e) { error = e.message; }
  try { bytes = convertMusic({ ...song, patterns: song.patterns.map(fixPattern) }).bytes; } catch { bytes = null; }
  return {
    patterns: song.patterns.length, orderLength: song.order.length, loop, refreshes, seconds: refreshes / refreshHz,
    loopRefreshes, loopSeconds: loopRefreshes / refreshHz, bytes, patternBytes: song.patterns.map(patternBytes), lengths: lens, error,
  };
}
/**
 * The compiler's rules (convertMusic) with the editor's wording.  -> {ok, errors: [string], warnings: [string], unstorable: [{pattern, channel, ticks}]}.
 * `ok` is true exactly when convertMusic accepts the song.  Warnings: a pattern the order list never plays (it is still stored).
 */
export function validateSong(song) {
  const errors = [], warnings = [], unstorable = [];
  const done = () => ({ ok: errors.length === 0, errors, warnings, unstorable });
  if (!isObj(song) || !Array.isArray(song.patterns)) { errors.push('the song has no "patterns"'); return done(); }
  const pats = song.patterns, order = song.order;
  if (pats.length === 0) errors.push('the song has no patterns');
  if (pats.length > MAX_PATTERNS) errors.push(`the song has ${pats.length} patterns (at most ${MAX_PATTERNS})`);
  if (!Array.isArray(order) || order.length === 0) errors.push('the order list is empty: a song plays at least one pattern');
  else {
    if (order.length > MAX_ORDER) errors.push(`the order list has ${order.length} entries (at most ${MAX_ORDER})`);
    order.forEach((p, i) => { if (!Number.isInteger(p) || p < 0 || p >= pats.length) errors.push(`order position ${i} plays pattern ${JSON.stringify(p)}, which does not exist (patterns 0..${pats.length - 1})`); });
    const loop = song.loop ?? null;
    if (loop !== null && !(Number.isInteger(loop) && loop >= 0 && loop < order.length)) errors.push(`the loop is ${JSON.stringify(loop)}: an order position 0..${order.length - 1}, or none`);
  }
  pats.forEach((p, i) => {
    const v = S.validateSfx(p);
    for (const e of v.errors) errors.push(`pattern ${i}: ${e}`);
    for (const [ch, ticks] of Object.entries(v.byChannel)) if (ticks.length) unstorable.push({ pattern: i, channel: ch, ticks });
    const len = isObj(p) ? patternLength(p) : 0;
    if (isObj(p) && len === 0) errors.push(`pattern ${i} has no ticks`);
    if (len > MAX_PATTERN_TICKS) errors.push(`pattern ${i} is ${len} refreshes long (at most ${MAX_PATTERN_TICKS})`);
  });
  if (errors.length === 0) { try { convertMusic(song); } catch (e) { errors.push(e.message); } }      // anything the rules above missed
  if (Array.isArray(order)) {
    const played = new Set(order);
    pats.forEach((p, i) => { if (!played.has(i)) warnings.push(`pattern ${i} is not in the order list: it is never played, but its ${patternBytes(p)} bytes are stored`); });
  }
  return done();
}

// ── the preview ───────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The song as one three-channel effect: the patterns in order, each channel padded to its pattern's length with silent records (as the compiler
 * pads); with a loop, the entries from the loop position to the end are played once more.  A channel no pattern uses stays empty, so a song on
 * channel A alone renders as a one-channel effect.  Stops after opts.maxTicks refreshes (default MAX_PREVIEW_TICKS).
 * -> {asset: {ticks, ticksB, ticksC}, sections: [{pos, pattern, start, length, again}], refreshes, truncated}
 */
export function songTimeline(song, { loopOnce = true, maxTicks = MAX_PREVIEW_TICKS } = {}) {
  const used = S.TRACKS.map(({ key }) => song.patterns.some((p) => Array.isArray(p?.[key]) && p[key].length > 0));
  const out = S.TRACKS.map(() => []);
  const sections = [];
  let t = 0, truncated = false;
  const positions = song.order.map((p, pos) => ({ p, pos, again: false }));
  if (loopOnce && song.loop !== null && song.loop !== undefined) for (let pos = song.loop; pos < song.order.length; pos++) positions.push({ p: song.order[pos], pos, again: true });
  for (const { p, pos, again } of positions) {
    const pat = song.patterns[p];
    if (!pat) continue;
    let len = patternLength(pat);
    if (t + len > maxTicks) { len = Math.max(0, maxTicks - t); truncated = true; }
    if (len === 0) { if (truncated) break; continue; }
    S.TRACKS.forEach(({ key }, c) => {
      if (!used[c]) return;
      const list = Array.isArray(pat[key]) ? pat[key] : [];
      for (let k = 0; k < len; k++) out[c].push(k < list.length ? { ...list[k] } : { ...SILENT });
    });
    sections.push({ pos, pattern: p, start: t, length: len, again });
    t += len;
    if (truncated) break;
  }
  return { asset: { ticks: out[0], ticksB: out[1], ticksC: out[2] }, sections, refreshes: t, truncated };
}
/** The AY preview of the whole song (sound-model renderSfx over songTimeline): mono samples in -0.5..0.5. */
export function renderSong(song, opts = {}) {
  return S.renderSfx(songTimeline(song, opts).asset, opts);
}
