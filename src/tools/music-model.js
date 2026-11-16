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
 *   notesOfTrack, noteAtTick, placeNote, replaceNote, removeNote   the note view (A1): the inverse of noteRecords, and the edits of its lane, all through enterNote / enterRest
 *   NOTE_MIN, NOTE_MAX, pitchWindow, scrollWindow, xOfTick, tickOfX, rowOfMidi, midiOfRow   the geometry the note lane needs (pure)
 *   patternLength, patternBytes, songInfo, validateSong    lengths, sizes (convertMusic), the compiler's rules
 *   songTimeline, renderSong                        the patterns in order (the loop played once more) as one effect, and its AY preview
 *   createHistory                                   undo / redo (the sprite editor's, also bounded by size)
 */

"use strict";

import * as S from './sound-model.js';
import { convertMusic, convertPattern, MAX_PATTERNS, MAX_ORDER, MAX_PATTERN_TICKS, MAX_SONGS } from '../lang/arcade/arcade-assets.js';

export { MAX_PATTERNS, MAX_ORDER, MAX_PATTERN_TICKS, MAX_SONGS };

/**
 * Undo / redo for songs: the sprite editor's history (whole snapshots, `commit(doc)` / `undo()` / `redo()` / `current` / `canUndo` / `canRedo` / `reset` / `depth`),
 * but bounded by size as well as by count.  A snapshot is the whole song as JSON (Blockfall's is 184 KB, one at the format's limits several MB), so 200 of them
 * would be hundreds of MB: the oldest steps are dropped while the stored JSON exceeds `maxBytes` (default HISTORY_MAX_BYTES), always keeping the current
 * snapshot and, when there is more than one, the step before it, so one undo is always possible after an edit.
 */
export const HISTORY_MAX_BYTES = 8 * 1024 * 1024;
export function createHistory(initial, limit = 200, maxBytes = HISTORY_MAX_BYTES) {
  const snapshot = (d) => JSON.stringify(d);
  let stack = [snapshot(initial)], at = 0, bytes = stack[0].length;
  const trim = () => {
    while (stack.length > limit) { bytes -= stack[0].length; stack.shift(); at--; }
    while (stack.length > 2 && at > 0 && bytes > maxBytes) { bytes -= stack[0].length; stack.shift(); at--; }      // the oldest first; the current one and the one before it stay
  };
  return {
    commit(d) {
      const snap = snapshot(d);
      if (snap === stack[at]) return false;
      for (const dropped of stack.slice(at + 1)) bytes -= dropped.length;
      stack = stack.slice(0, at + 1);
      stack.push(snap);
      bytes += snap.length;
      at++;
      trim();
      return true;
    },
    undo() { if (at <= 0) return null; at--; return JSON.parse(stack[at]); },
    redo() { if (at >= stack.length - 1) return null; at++; return JSON.parse(stack[at]); },
    get current() { return JSON.parse(stack[at]); },
    get canUndo() { return at > 0; },
    get canRedo() { return at < stack.length - 1; },
    reset(d) { stack = [snapshot(d)]; at = 0; bytes = stack[0].length; },
    get depth() { return { undo: at, redo: stack.length - 1 - at }; },
    /** Characters of JSON held (about the bytes in memory), and the number of snapshots. */
    get size() { return { bytes, snapshots: stack.length }; },
  };
}

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
/** Why `note` (a name or MIDI number) cannot be entered with `instrument`: a string, or null when it can.  (Note entry shows it in the status line before it writes.) */
export function noteRefusal(note, instrument = 'organ') {
  if (instrument === 'drum') return null;
  return S.noteTooLow(note);
}
/**
 * The records of one note: `length` refreshes (1..1800) of `note` (a name or a MIDI number) played by `instrument` (an INSTRUMENTS id).
 * opts.peak: the loudest volume (default the instrument's).  A record that would be unstorable (tone 3840 and above with volume 15) gets volume 14.
 * Throws a RangeError ("C0 is below the AY's lowest note, A0") for a tone note the AY cannot play: below A0 the tone period would pass 4095 and every such note
 * would sound the same.  The drum plays noise (the note only picks the noise period), so it takes any note.
 */
export function noteRecords(note, length, instrument = 'organ', opts = {}) {
  const inst = INSTRUMENTS.find((x) => x.id === instrument);
  if (!inst) throw new RangeError(`unknown instrument ${instrument} (${INSTRUMENTS.map((x) => x.id).join(', ')})`);
  const midi = S.midiOfNote(note);
  const low = noteRefusal(note, instrument);
  if (low) throw new RangeError(low);
  const n = clampInt(Number.isFinite(length) ? length : 1, 1, MAX_PATTERN_TICKS);
  const peak = clampInt(Number.isFinite(opts.peak) ? opts.peak : inst.peak, 0, 15);
  const tone = S.toneOfNote(midi);
  return Array.from({ length: n }, (_, j) => recordOf(instrument, midi, tone, n, j, peak));
}
/** Record j (0-based) of a note of n refreshes: the one formula noteRecords writes and notesOfTrack reads back (so the inverse cannot drift from it). */
function recordOf(instrument, midi, tone, n, j, peak) {
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
  return r;
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
/** Enter a note in a track: the records of noteRecords from tick `at`.  -> {message, range: the note's ticks, next: the tick after it} (throws for a bad note name or one below A0). */
export function enterNote(view, at, note, length, instrument = 'organ', opts = {}) {
  return writeRecords(view, at, noteRecords(note, length, instrument, opts));
}
/** Enter a rest: `length` silent records (volume 0) from tick `at`. */
export function enterRest(view, at, length) {
  const n = clampInt(Number.isFinite(length) ? length : 1, 1, MAX_PATTERN_TICKS);
  return writeRecords(view, at, Array.from({ length: n }, () => ({ ...S.PAD_TICK })));
}

// ── the note view (A1): the inverse of noteRecords, and the edits of the note lane ─────────────────────────────────────────────────────────────────────
/** The pitches the note lane offers: C0 (MIDI 12) to B8 (MIDI 119), the octaves of the note row.  (A tone note below A0, MIDI 21, is refused by note entry.) */
export const NOTE_MIN = 12;
export const NOTE_MAX = 119;
const sameRecord = (a, b) => !!a && a.tone === b.tone && a.vol === b.vol && a.noise === b.noise && a.mix === b.mix;
const isPad = (t) => sameRecord(t, S.PAD_TICK);
/** tone period -> the MIDI notes 0..127 that noteRecords gives that tone (an inverse of toneOfNote; several only where the period rounds the same: the top and bottom of the range). */
const MIDIS_OF_TONE = (() => {
  const m = new Map();
  for (let midi = 0; midi <= 127; midi++) { const t = S.toneOfNote(midi); if (!m.has(t)) m.set(t, []); m.get(t).push(midi); }
  return m;
})();
/**
 * The inverse of noteRecords: the notes of one track.  `source` is a track's ticks (an array of records) or a sound-model trackView ({ticks}).
 * -> {notes: [{at, length, midi, note, instrument, peak, silent}], raw: [{from, to}]}
 *   notes   ascending and never overlapping.  A note is claimed ONLY where noteRecords(note, length, instrument, {peak}) reproduces those exact records (the
 *           four fields of every tick), checked against noteRecords itself; at each tick the longest such note is taken.  `note` is the sharps-only name
 *           ('C#5'), `peak` the loudest volume (re-enter with {peak}), `silent` is peak 0 (a rest that keeps its pitch, as the example songs write them).  Where
 *           several instruments, pitches or peaks write the same records (a short note: one tick is the same for pluck, organ and bass; a drum below A0 is one
 *           record whatever the note), the one whose peak is the instrument's own wins, then the order of INSTRUMENTS, then the lowest pitch in C0..B8.
 *   raw     the ticks that are neither part of a note nor exactly enterRest's silent record (S.PAD_TICK): ranges {from, to}, inclusive.  They stay editable in the
 *           tick lanes; the note view never changes them.
 */
export function notesOfTrack(source) {
  const ticks = Array.isArray(source) ? source : Array.isArray(source?.ticks) ? source.ticks : [];
  const notes = [], raw = [];
  let i = 0;
  while (i < ticks.length) {
    const t = ticks[i];
    if (isPad(t)) { i++; continue; }
    const hit = noteAt(ticks, i);
    if (hit) {
      notes.push(hit);
      i += hit.length;
    } else {
      const last = raw[raw.length - 1];
      if (last && last.to === i - 1) last.to = i; else raw.push({ from: i, to: i });
      i++;
    }
  }
  return { notes, raw };
}
/** The best note that starts exactly at tick `i` of `ticks`, or null. */
function noteAt(ticks, i) {
  const t0 = ticks[i];
  if (!t0 || !Number.isFinite(t0.tone) || !Number.isFinite(t0.vol)) return null;
  const midis = MIDIS_OF_TONE.get(t0.tone);
  if (!midis) return null;
  const avail = Math.min(ticks.length - i, MAX_PATTERN_TICKS);
  const peaks = t0.vol === 0 ? [0] : t0.vol === 14 && t0.tone >= S.UNSTORABLE_TONE_FROM ? [14, 15] : [t0.vol];
  const tonal = t0.mix === 6 && t0.noise === 0, noisy = t0.mix === 5 && t0.noise >= 1;
  let best = null;
  for (const inst of INSTRUMENTS) {
    if (inst.id === 'drum' ? !noisy : !tonal) continue;
    for (const midi of midis) {
      if (inst.id !== 'drum' && noteRefusal(midi, inst.id)) continue;
      for (const peak of peaks) {
        const n = longestMatch(ticks, i, avail, inst.id, midi, peak);
        if (!n) continue;
        const cand = { at: i, length: n, midi, note: S.noteNameOfMidi(midi), instrument: inst.id, peak, silent: peak === 0 };
        if (!best || better(cand, best)) best = cand;
      }
    }
  }
  if (!best) return null;
  // the safety net: what is claimed is what noteRecords writes, checked against noteRecords itself
  const want = noteRecords(best.midi, best.length, best.instrument, { peak: best.peak });
  return want.every((r, k) => sameRecord(ticks[i + k], r)) ? best : null;
}
/** Is candidate a a better reading than b of the same ticks?  Longer first; then the instrument's own peak; then INSTRUMENTS order; then the lowest pitch in range. */
function better(a, b) {
  if (a.length !== b.length) return a.length > b.length;
  const own = (c) => INSTRUMENTS.find((x) => x.id === c.instrument).peak === c.peak;
  if (own(a) !== own(b)) return own(a);
  const ia = INSTRUMENTS.findIndex((x) => x.id === a.instrument), ib = INSTRUMENTS.findIndex((x) => x.id === b.instrument);
  if (ia !== ib) return ia < ib;
  const inRange = (c) => c.midi >= NOTE_MIN && c.midi <= NOTE_MAX;
  if (inRange(a) !== inRange(b)) return inRange(a);
  return a.midi < b.midi;
}
/** The most refreshes of a note (instrument, midi, peak) that the records from tick i on reproduce exactly, or 0.  The candidate lengths come from each envelope's shape; each is checked in full. */
function longestMatch(ticks, i, avail, instrument, midi, peak) {
  const tone = S.toneOfNote(midi);
  const fits = (n) => {                                        // the last record first: for an organ or a bass it is the one that changes with the length
    for (let j = n - 1; j >= 0; j--) if (!sameRecord(ticks[i + j], recordOf(instrument, midi, tone, n, j, peak))) return false;
    return true;
  };
  const run = (from, same) => { let k = from; while (k < avail && same(ticks[i + k])) k++; return k; };
  let cands;
  if (instrument === 'pluck' || instrument === 'drum') {       // a prefix of one endless envelope: the longest prefix that matches is the length
    let n = 0;
    while (n < avail && sameRecord(ticks[i + n], recordOf(instrument, midi, tone, avail, n, peak))) n++;
    return n;
  } else if (instrument === 'organ') {                         // peak, peak, ... peak, peak / 2 (from 3 on); n = 1, 2: all peak
    const body = recordOf('organ', midi, tone, 1, 0, peak);
    const r = run(0, (t) => sameRecord(t, body));
    cands = [r + 1, r, 2, 1];
  } else {                                                     // bass: the first silent record of the run ends a note of 4 or more
    const r = run(0, (t) => t.tone === tone && t.noise === 0 && t.mix === 6);
    let z = 0;
    while (z < r && ticks[i + z].vol !== 0) z++;
    cands = [z + 1, r, 3, 2, 1];
  }
  const seen = new Set();
  for (const n of cands.filter((v) => v >= 1 && v <= avail).sort((a, b) => b - a)) {
    if (seen.has(n)) continue;
    seen.add(n);
    if (fits(n)) return n;
  }
  return 0;
}
/** The note of a notesOfTrack result that covers tick `tick`, or null. */
export const noteAtTick = (result, tick) => result.notes.find((n) => tick >= n.at && tick < n.at + n.length) ?? null;

/** Why the note lane may not put a note of `instrument` at pitch `midi`: a string, or null.  (Pitches are C0..B8; a tone note below A0 is refused by note entry.) */
function placeRefusal(midi, instrument) {
  if (!Number.isInteger(midi) || midi < NOTE_MIN || midi > NOTE_MAX) return `a note lies between C0 and B8 (the pitch asked for is ${Number.isInteger(midi) ? S.noteNameOfMidi(midi) : midi})`;
  return noteRefusal(midi, instrument);
}
/**
 * Place a note in a track from the lane: the same records as enterNote (this IS enterNote, after the lane's checks).  `peak` null: the instrument's own.
 * Refusals (a pitch out of range, below the AY's lowest note, a tick before the start) change nothing and say why.  -> enterNote's {message, range, next}, or {message}.
 */
export function placeNote(view, at, midi, length, instrument = 'organ', peak = null) {
  if (!Number.isInteger(at) || at < 0) return { message: 'a note starts at tick 0 or later' };
  const why = placeRefusal(midi, instrument);
  if (why) return { message: why };
  return enterNote(view, at, midi, length, instrument, peak === null || peak === undefined ? {} : { peak });
}
/**
 * Change a note the lane shows (a notesOfTrack note): its start `at`, pitch `midi`, `length`, `instrument` or `peak` (any left out stay).  Through enterRest and enterNote only:
 * the old ticks become a rest, then the note is entered anew, so a shorter or moved note frees its old ticks and a longer or moved one overwrites what is under it.
 * A refusal changes nothing.  -> {message, range, next} of the entered note.
 */
export function replaceNote(view, note, to = {}) {
  const at = to.at ?? note.at, midi = to.midi ?? note.midi, length = to.length ?? note.length, instrument = to.instrument ?? note.instrument, peak = to.peak ?? note.peak;
  if (!Number.isInteger(length) || length < 1) return { message: 'a note lasts at least one tick' };
  if (!Number.isInteger(at) || at < 0) return { message: 'a note starts at tick 0 or later' };
  const why = placeRefusal(midi, instrument);
  if (why) return { message: why };
  enterRest(view, note.at, note.length);
  return enterNote(view, at, midi, length, instrument, { peak });
}
/** Remove a note the lane shows: a rest (enterRest) over its ticks. */
export const removeNote = (view, note) => enterRest(view, note.at, note.length);

/** The lane's pitch window: the MIDI notes {lo, hi} (inclusive) it shows.  Lanes start on these (channel A, B, C: the melody, the bass, the percussion). */
export const DEFAULT_WINDOWS = [{ lo: 60, hi: 83 }, { lo: 48, hi: 71 }, { lo: 36, hi: 59 }];
/**
 * The pitch window of a lane showing `notes` (a notesOfTrack list): the first time (`prev` null) it fits the notes with `pad` rows beyond them (an empty lane starts on
 * DEFAULT_WINDOWS[opts.channel]); later `prev` is grown to hold every note, never shrunk (a note dragged to the top does not make the grid jump), unless that would pass
 * `maxRows` (then `prev` stays and scrollWindow reaches the rest).  At least `minRows` and at most `maxRows` high, inside C0..B8; the midi numbers in opts.show are
 * always inside (the window moves to them).  opts: {channel 0..2, minRows 14, maxRows 48, pad 2, show []}.
 */
export function pitchWindow(notes, prev = null, opts = {}) {
  const minRows = opts.minRows ?? 14, maxRows = opts.maxRows ?? 48, pad = opts.pad ?? 2;
  const rows = (w) => w.hi - w.lo + 1;
  const grown = (w) => {
    let { lo, hi } = w;
    for (const n of notes) { if (n.midi < lo) lo = n.midi - pad; if (n.midi > hi) hi = n.midi + pad; }
    return { lo: Math.max(NOTE_MIN, lo), hi: Math.min(NOTE_MAX, hi) };
  };
  let w;
  if (prev) { w = grown(prev); if (rows(w) > maxRows) w = prev; }
  else if (notes.length) {
    w = grown({ lo: Infinity, hi: -Infinity });
    if (rows(w) > maxRows) {
      const centre = Math.round(notes.reduce((s, n) => s + n.midi, 0) / notes.length);
      const lo = clampInt(centre - Math.floor(maxRows / 2), NOTE_MIN, NOTE_MAX - maxRows + 1);
      w = { lo, hi: lo + maxRows - 1 };
    }
  } else w = { ...(DEFAULT_WINDOWS[opts.channel ?? 0] ?? DEFAULT_WINDOWS[0]) };
  for (let k = 0; rows(w) < minRows; k++) { if (k % 2 === 0 && w.hi < NOTE_MAX) w = { ...w, hi: w.hi + 1 }; else if (w.lo > NOTE_MIN) w = { ...w, lo: w.lo - 1 }; else if (w.hi < NOTE_MAX) w = { ...w, hi: w.hi + 1 }; else break; }
  for (const m of opts.show ?? []) { if (m > w.hi) w = scrollWindow(w, m - w.hi); else if (m < w.lo) w = scrollWindow(w, m - w.lo); }
  return w;
}
/** The window moved by `rows` semitones (positive: up), kept inside C0..B8. */
export function scrollWindow(win, rows) {
  const n = win.hi - win.lo + 1;
  const hi = clampInt(win.hi + rows, NOTE_MIN + n - 1, NOTE_MAX);
  return { lo: hi - n + 1, hi };
}
/** Tick <-> x in pixels, `colW` pixels a tick (the tick lanes' own scale, so the two line up): tickOfX clamps to 0..maxTick. */
export const xOfTick = (tick, colW) => tick * colW;
export const tickOfX = (x, colW, maxTick = Infinity) => clampInt(Math.floor(x / colW), 0, maxTick);
/** Pitch <-> row in a window (row 0 is the top row, the window's `hi`).  midiOfRow clamps to the window. */
export const rowOfMidi = (midi, win) => win.hi - midi;
export const midiOfRow = (row, win) => clampInt(win.hi - row, win.lo, win.hi);

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
