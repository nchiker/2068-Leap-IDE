// songs.mjs -- the note notation the example games' asset generators write their songs in (docs/ARCADE_MUSIC_CONTRACT.md section 8, slice M5).
// Pure (no DOM): it builds `assets.music` entries with the Studio's own note entry and instruments (src/tools/music-model.js: enterNote, INSTRUMENTS), so a
// song made here opens in the Studio's song editor like one drawn there.
//
//   track('@organ !11 L12 A4:24 E5:24 D5 C5 B4:24 -:24', length?)   one channel's records
//       @name     the instrument from here on (pluck, organ, bass, drum; music-model.js INSTRUMENTS)
//       !n        its peak volume (1..15) from here on (default: the instrument's)
//       Ln        the length of a note written without one (refreshes, 60.115 a second)
//       C#4:12    a note (name and octave, as noteRecords takes) for 12 refreshes; `-` is a rest (the last note at volume 0); `*n` after a token
//                 repeats it n times
//       |         a bar line (ignored: it only helps the reader)
//   pattern({A, B, C}, name)   a pattern from up to three track strings; every track given must have the same length (a mismatch is an error)
//   song(patterns, order, loop) the asset {patterns, order, loop}, checked with validateSong (an error throws)
//   describe(name, asset)      one line: patterns, order, seconds, bytes on the cartridge
"use strict";

import * as M from '../../src/tools/music-model.js';

/** One channel's records from a track string (see the header). */
export function track(text) {
  const view = { ticks: [] };                                  // a trackView: enterNote / enterRest write into view.ticks
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
      // a rest is the last note at volume 0 (same tone, instrument and noise): only the volume register changes, where enterRest's records would
      // also change the tone (to its pad value) and so cost two more pairs
      const r = m[1] === '-' ? (last ? M.enterNote(view, at, last, len, inst, { peak: 0 }) : M.enterRest(view, at, len))
        : M.enterNote(view, at, m[1], len, inst, peak === null ? {} : { peak });
      if (m[1] !== '-') last = m[1];
      if (r.message) throw new Error(r.message);
      at = r.next;
    }
  }
  return view.ticks;
}

/** A pattern from track strings {A, B, C} (any of them may be left out); `name` labels it in the Studio. */
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

/** "name: 4 patterns, order 6, 25.5 s (loop from 0), 1,234 bytes" */
export function describe(name, asset) {
  const i = M.songInfo(M.fromSong(asset));
  return `${name}: ${i.patterns} patterns, order ${i.orderLength}, ${i.seconds.toFixed(1)} s${i.loop === null ? ' (no loop)' : ` (loop from ${i.loop})`}, ${i.bytes} bytes`;
}
