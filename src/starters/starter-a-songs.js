/**
 * src/starters/starter-a-songs.js -- the note notation the starter games write their songs in (a copy of arcade/examples/songs.mjs, which src/ cannot import).
 * Pure (no DOM): it builds `assets.music` entries with the Studio's own note entry (src/tools/music-model.js), so a song made here opens in the song editor.
 *
 *   track('@organ !11 L12 A4:24 E5:24 D5 C5 B4:24 -:24')   one channel's records: @name the instrument (pluck, organ, bass, drum), !n its peak volume,
 *       Ln the length of a note written without one (refreshes, 60.115 a second), C#4:12 a note for 12 refreshes, - a rest, *n repeats a token, | a bar line
 *   pattern({A, B, C}, name)   a pattern from up to three track strings of the same length
 *   song(patterns, order, loop) the asset {patterns, order, loop}, checked with validateSong
 */

"use strict";

import * as M from '../tools/music-model.js';

/** One channel's records from a track string. */
export function track(text) {
  const view = { ticks: [] };
  let inst = 'organ', peak = null, deflen = 12, at = 0, last = null;
  for (const raw of text.trim().split(/\s+/)) {
    if (raw === '' || raw === '|') continue;
    if (raw[0] === '@') { inst = raw.slice(1); if (!M.INSTRUMENTS.some((x) => x.id === inst)) throw new Error(`unknown instrument ${raw}`); peak = null; continue; }
    if (raw[0] === '!') { peak = Number(raw.slice(1)); if (!(peak >= 1 && peak <= 15)) throw new Error(`bad peak ${raw}`); continue; }
    if (/^L\d+$/.test(raw)) { deflen = Number(raw.slice(1)); continue; }
    const m = /^([A-Ga-g][#b]?-?\d|-)(?::(\d+))?(?:\*(\d+))?$/.exec(raw);
    if (!m) throw new Error(`"${raw}" is not a note, a rest or a command`);
    const len = m[2] ? Number(m[2]) : deflen, times = m[3] ? Number(m[3]) : 1;
    for (let k = 0; k < times; k++) {
      // a rest is the last note at volume 0 (only the volume register changes: cheaper than enterRest's records)
      const r = m[1] === '-' ? (last ? M.enterNote(view, at, last, len, inst, { peak: 0 }) : M.enterRest(view, at, len))
        : M.enterNote(view, at, m[1], len, inst, peak === null ? {} : { peak });
      if (m[1] !== '-') last = m[1];
      if (r.message) throw new Error(r.message);
      at = r.next;
    }
  }
  return view.ticks;
}

/** A pattern from track strings {A, B, C} (any may be left out); `name` labels it in the Studio. */
export function pattern(tracks, name) {
  const t = { A: tracks.A ? track(tracks.A) : [], B: tracks.B ? track(tracks.B) : [], C: tracks.C ? track(tracks.C) : [] };
  const lens = Object.entries(t).filter(([, v]) => v.length > 0).map(([k, v]) => `${k} ${v.length}`);
  if (new Set(lens.map((s) => s.split(' ')[1])).size > 1) throw new Error(`pattern ${name}: the tracks differ in length (${lens.join(', ')})`);
  const p = { ticks: t.A, ticksB: t.B, ticksC: t.C };
  if (name) p.name = name;
  return p;
}

/** The asset of a song, checked with the editor's (and the compiler's) rules. */
export function song(patterns, order, loop = 0) {
  const asset = { patterns, order, loop };
  const v = M.validateSong(asset);
  if (!v.ok) throw new Error(v.errors.join('; '));
  return M.toSong(asset);
}
