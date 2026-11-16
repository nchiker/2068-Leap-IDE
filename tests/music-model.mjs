"use strict";
// music-model.mjs -- tests for src/tools/music-model.js (songs in the Leap Arcade Studio sound editor, docs/ARCADE_MUSIC_CONTRACT.md sections 3 and 7),
// for validateAsset('music') in src/arcade-project.js and for the song checks of src/lang/arcade/arcade-assetcheck.js.
//   node tests/music-model.mjs
//
// Sections
//   1  conversion: fromSong / toSong round trip, unknown keys and pattern labels kept, unreadable songs
//   2  the default song (newSong) and a new pattern
//   3  the pattern list: add, duplicate, delete, move, label; the order list and the loop follow (the music played stays the same where it should)
//   4  the order list and the loop: append, insert, remove, move, set, setLoop; limits
//   5  note entry: instruments, tones from toneOfNote, peaks, the unstorable rule, padding / overwriting / extending a track, the pattern cap
//   6  validation: validateSong's messages, ok <=> convertMusic accepts (random songs), validateAsset('music'), the asset checks
//   7  size and length against convertMusic / convertPattern (random songs)
//   8  the preview: songTimeline sections and padding, the loop played once, renderSong against renderSfx, the cut
//   9  undo / redo of song edits through createHistory
//   10 review fixes: octave 0, the size-bounded history, one copy of the limits
//   11 A1, the note view: notesOfTrack is the inverse of noteRecords (every instrument, pitch, length, peak), never claims a note the records do not reproduce, the example
//      songs re-entered note by note convert to identical bytes, placeNote / replaceNote / removeNote, the lane's geometry helpers
import * as MM from '../src/tools/music-model.js';
import * as S from '../src/tools/sound-model.js';
import { convertMusic, convertPattern } from '../src/lang/arcade/arcade-assets.js';
import { validateAsset, validateProject, newProject, assetReferences } from '../src/arcade-project.js';
import { checkAssets } from '../src/lang/arcade/arcade-assetcheck.js';

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  cond ? passed++ : failed++;
  return cond;
};
const section = (t) => console.log(`\n${t}`);
const throws = (fn, re = /./) => { try { fn(); return false; } catch (e) { return re.test(e.message); } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const tk = (tone, vol = 10, noise = 0, mix = 6) => ({ tone, vol, noise, mix });
/** A pattern of `n` ticks on A (tone base + i), optional B / C lengths. */
const pt = (n, base = 100, nb = 0, nc = 0) => ({
  ticks: Array.from({ length: n }, (_, i) => tk(base + i)), ticksB: Array.from({ length: nb }, (_, i) => tk(base + 50 + i, 8)), ticksC: Array.from({ length: nc }, (_, i) => tk(base + 90 + i, 6)),
});
const song = (pats, order, loop = null) => ({ patterns: pats, order, loop });
/** What the song plays, pattern by pattern, as the patterns' own content (so a renumbering that keeps the music is "the same"). */
const played = (s) => s.order.map((p) => JSON.stringify(S.toAsset(s.patterns[p])));
let seed = 7;
const rnd = () => { seed = (seed * 1103515245 + 12345) >>> 0; return seed / 4294967296; };
const int = (a, b) => a + Math.floor(rnd() * (b - a + 1));
const pick = (a) => a[int(0, a.length - 1)];
function randomSong(valid = true) {
  const np = int(1, 5);
  const pats = Array.from({ length: np }, () => {
    const rec = () => ({ tone: pick([int(0, 4095), int(50, 900), 300, 300]), vol: pick([0, 8, 12, 15, int(0, 15)]), noise: int(0, 31), mix: pick([4, 5, 6, 7, int(0, 7)]) });
    const len = int(1, 40);
    const run = (n) => { const out = []; while (out.length < n) { const r = rec(); for (let k = int(1, 200); k > 0 && out.length < n; k--) out.push({ ...r }); } return out; };
    return { ticks: run(len), ticksB: rnd() < 0.5 ? run(int(0, len)) : [], ticksC: rnd() < 0.4 ? run(int(0, len + 5)) : [] };
  });
  if (valid) for (const p of pats) for (const k of ['ticks', 'ticksB', 'ticksC']) for (const t of p[k]) if (t.vol === 15 && t.tone >= 3840) t.vol = 14;
  const order = Array.from({ length: int(1, 6) }, () => int(0, np - 1));
  return { patterns: pats, order, loop: rnd() < 0.3 ? null : int(0, order.length - 1) };
}

// ═══ 1 ════════════════════════════════════════════════════════════════════════════════════════════════════════
section('1  conversion');
{
  const a = { patterns: [{ ticks: [tk(100)], name: 'intro', x: 1 }, { ticks: [tk(200)], ticksB: [tk(300)] }], order: [0, 1, 1], loop: 1, tempo: 'kept' };
  const e = MM.fromSong(a);
  ok('fromSong: every pattern has all three tracks, unknown keys and labels kept', same(e.patterns[0].ticksB, []) && same(e.patterns[0].ticksC, []) && e.patterns[0].name === 'intro' && e.patterns[0].x === 1 && e.tempo === 'kept');
  ok('toSong(fromSong(a)) is a: empty B / C dropped, everything else as stored', same(MM.toSong(e), a));
  e.patterns[0].ticks[0].tone = 999;
  ok('fromSong copies deeply (the asset is untouched by edits)', a.patterns[0].ticks[0].tone === 100);
  ok('a missing loop reads as null (no loop)', MM.fromSong({ patterns: [{ ticks: [tk(1)] }], order: [0] }).loop === null);
  ok('unreadable songs throw a plain message', throws(() => MM.fromSong(null), /not an object/) && throws(() => MM.fromSong({ order: [0] }), /no "patterns"/)
    && throws(() => MM.fromSong({ patterns: [{ ticks: [tk(1)] }] }), /no "order"/) && throws(() => MM.fromSong({ patterns: [{ ticksB: [] }], order: [0] }), /pattern 0: it has no "ticks"/));
  const c = MM.cloneSong(e);
  c.patterns[1].ticksB[0].vol = 1;
  ok('cloneSong is deep', e.patterns[1].ticksB[0].vol === 10);
}

// ═══ 2 ════════════════════════════════════════════════════════════════════════════════════════════════════════
section('2  the default song');
{
  const s = MM.newSong();
  ok('newSong: one pattern, order [0], loop 0', s.patterns.length === 1 && same(s.order, [0]) && s.loop === 0);
  ok('it is valid: validateAsset, validateSong and convertMusic accept it', validateAsset('music', MM.toSong(s)) === null && MM.validateSong(s).ok && !throws(() => convertMusic(s)));
  ok(`it is short (${MM.patternLength(s.patterns[0])} refreshes) and uses channels A and B`, MM.patternLength(s.patterns[0]) === MM.DEFAULT_PATTERN_TICKS && s.patterns[0].ticks.length === 32 && s.patterns[0].ticksB.length === 32 && s.patterns[0].ticksC.length === 0);
  ok('its notes are C4 E4 G4 C5 (8 refreshes each) on A', [0, 8, 16, 24].map((i) => S.noteOfTone(s.patterns[0].ticks[i].tone).name).join() === 'C4,E4,G4,C5');
  const p = MM.newPattern(10);
  ok('newPattern(10): 10 silent records on A (volume 0), B and C empty', p.ticks.length === 10 && p.ticks.every((t) => t.vol === 0) && same(p.ticksB, []) && same(p.ticksC, []));
  ok('newPattern clamps its length to 1..1800', MM.newPattern(0).ticks.length === 1 && MM.newPattern(5000).ticks.length === 1800);
}

// ═══ 3 ════════════════════════════════════════════════════════════════════════════════════════════════════════
section('3  the pattern list');
{
  const base = () => MM.fromSong(song([pt(4, 100), pt(5, 200), pt(6, 300)], [0, 1, 2, 1, 0], 3));
  let s = base(), before = played(s);
  let r = MM.addPattern(s, 1);
  ok('addPattern(1): the new pattern is at 1, the order list is renumbered and plays the same music', r.message === null && r.pattern === 1 && same(s.order, [0, 2, 3, 2, 0]) && same(played(s), before) && s.loop === 3);
  ok('the new pattern is silent and 32 refreshes long by default', MM.patternLength(s.patterns[1]) === 32 && s.patterns[1].ticks.every((t) => t.vol === 0));
  s = base(); r = MM.addPattern(s, undefined, null, 7);
  ok('addPattern at the end with a length', s.patterns.length === 4 && MM.patternLength(s.patterns[3]) === 7 && same(s.order, [0, 1, 2, 1, 0]));
  s = base(); r = MM.duplicatePattern(s, 1);
  ok('duplicatePattern(1): a copy at 2, the order list still plays the original', r.pattern === 2 && same(S.toAsset(s.patterns[2]), S.toAsset(s.patterns[1])) && same(s.order, [0, 1, 3, 1, 0]) && same(played(s), before));
  s.patterns[2].ticks[0].tone = 1;
  ok('the copy is independent', s.patterns[1].ticks[0].tone === 200);
  s = base(); s.patterns[0].name = 'verse'; MM.duplicatePattern(s, 0);
  ok('a labelled pattern\'s copy is labelled "... copy"', s.patterns[1].name === 'verse copy');
  // delete
  s = base(); r = MM.deletePattern(s, 1);
  ok('deletePattern(1): its entries go, later indices drop by one', r.message === null && same(s.order, [0, 1, 0]) && s.patterns.length === 2);
  ok('the loop (on position 3, an entry of pattern 1) moves to the next entry kept (position 4, now 2)', s.loop === 2, String(s.loop));
  s = base(); s.loop = 4; MM.deletePattern(s, 2);
  ok('a loop after the removed entries moves down with its entry', same(s.order, [0, 1, 1, 0]) && s.loop === 3);
  s = base(); s.loop = 4; MM.deletePattern(s, 0);
  ok('deleting the pattern of the last entry, which held the loop: the loop goes to the last entry kept', same(s.order, [0, 1, 0]) && s.loop === 2, `${s.order} ${s.loop}`);
  s = MM.fromSong(song([pt(2), pt(3)], [1, 1], 1)); r = MM.deletePattern(s, 1);
  ok('deleting the only pattern the order list plays: the order becomes [0], the loop 0, with a message', same(s.order, [0]) && s.loop === 0 && /now plays pattern 0/.test(r.message));
  s = MM.fromSong(song([pt(2), pt(3)], [1], null)); MM.deletePattern(s, 1);
  ok('... and with no loop it stays without one', same(s.order, [0]) && s.loop === null);
  s = MM.fromSong(song([pt(2)], [0], 0)); r = MM.deletePattern(s, 0);
  ok('the last pattern cannot be deleted', /at least one pattern/.test(r.message) && s.patterns.length === 1);
  ok('deleting a pattern that does not exist is refused', /no pattern 9/.test(MM.deletePattern(base(), 9).message));
  // move
  s = base(); r = MM.movePattern(s, 0, 2);
  ok('movePattern(0 -> 2): the pattern list is [1, 2, 0], the order list renumbered, the music the same', r.pattern === 2 && same(s.order, [2, 0, 1, 0, 2]) && same(played(s), before) && same(S.toAsset(s.patterns[2]), S.toAsset(base().patterns[0])));
  s = base(); MM.movePattern(s, 2, 0);
  ok('movePattern(2 -> 0) also keeps the music', same(played(s), before) && same(s.order, [1, 2, 0, 2, 1]));
  s = base(); r = MM.movePattern(s, 1, 99);
  ok('a move past the end goes to the end', r.pattern === 2 && same(played(s), before));
  // random moves / adds / duplicates / deletes never break the song
  let good = true;
  for (let n = 0; n < 400; n++) {
    s = MM.fromSong(randomSong());
    const op = int(0, 3), i = int(0, s.patterns.length - 1), was = played(s);
    if (op === 0) { MM.movePattern(s, i, int(0, s.patterns.length - 1)); if (!same(played(s), was)) good = false; }
    if (op === 1) { MM.addPattern(s, int(0, s.patterns.length)); if (!same(played(s), was)) good = false; }
    if (op === 2) { MM.duplicatePattern(s, i); if (!same(played(s), was)) good = false; }
    if (op === 3) MM.deletePattern(s, i);
    if (validateAsset('music', MM.toSong(s)) !== null || !MM.validateSong(s).ok) good = false;
  }
  ok('400 random pattern operations: moves, adds and duplicates keep the music, and every result stays a valid song', good);
  // label
  s = base(); MM.labelPattern(s, 1, '  chorus  ');
  ok('labelPattern sets a trimmed label; patternTitle shows it', s.patterns[1].name === 'chorus' && MM.patternTitle(s, 1) === '1 chorus' && MM.patternTitle(s, 0) === '0');
  MM.labelPattern(s, 1, '');
  ok('an empty label removes the key', !('name' in s.patterns[1]));
  ok('a label does not change the image', same(convertMusic(MM.toSong(base())).patterns.map((p) => [...p.bytes]), (() => { const t = base(); MM.labelPattern(t, 0, 'x'); return convertMusic(MM.toSong(t)).patterns.map((p) => [...p.bytes]); })()));
  // limit
  s = MM.fromSong(song(Array.from({ length: 32 }, () => pt(1)), [0], 0));
  ok('a song has at most 32 patterns: add and duplicate are refused at 32', /at most 32 patterns/.test(MM.addPattern(s).message) && /at most 32/.test(MM.duplicatePattern(s, 0).message) && s.patterns.length === 32);
}

// ═══ 4 ════════════════════════════════════════════════════════════════════════════════════════════════════════
section('4  the order list and the loop');
{
  const base = () => MM.fromSong(song([pt(2, 100), pt(3, 200), pt(4, 300)], [0, 1, 2], 1));
  let s = base(), r = MM.orderAppend(s, 2);
  ok('orderAppend', r.pos === 3 && same(s.order, [0, 1, 2, 2]) && s.loop === 1);
  s = base(); r = MM.orderInsert(s, 1, 2);
  ok('orderInsert at the loop position: the loop moves with its entry', r.pos === 1 && same(s.order, [0, 2, 1, 2]) && s.loop === 2);
  s = base(); MM.orderInsert(s, 2, 0);
  ok('orderInsert after the loop leaves it', same(s.order, [0, 1, 0, 2]) && s.loop === 1);
  s = base(); MM.orderInsert(s, 0, 1);
  ok('orderInsert before the loop moves it', same(s.order, [1, 0, 1, 2]) && s.loop === 2);
  s = base(); r = MM.orderRemove(s, 0);
  ok('orderRemove before the loop: the loop follows its entry', same(s.order, [1, 2]) && s.loop === 0 && r.pos === 0);
  s = base(); MM.orderRemove(s, 1);
  ok('orderRemove of the loop entry: the loop is on the entry after it', same(s.order, [0, 2]) && s.loop === 1);
  s = MM.fromSong(song([pt(2)], [0, 0, 0], 2)); MM.orderRemove(s, 2);
  ok('orderRemove of the last entry holding the loop: the loop is on the new last entry', same(s.order, [0, 0]) && s.loop === 1);
  s = MM.fromSong(song([pt(2)], [0], 0)); r = MM.orderRemove(s, 0);
  ok('the last order entry cannot be removed', /at least one entry/.test(r.message) && same(s.order, [0]));
  s = base(); r = MM.orderMove(s, 1, 2);
  ok('orderMove: the entry moves, the loop stays on it', same(s.order, [0, 2, 1]) && s.loop === 2 && r.pos === 2);
  s = base(); MM.orderMove(s, 0, 2);
  ok('orderMove of another entry over the loop: the loop stays on its own entry', same(s.order, [1, 2, 0]) && s.loop === 0);
  s = base(); r = MM.orderMove(s, 0, -5);
  ok('orderMove clamps the target', same(s.order, [0, 1, 2]) && r.pos === 0);
  s = base(); r = MM.orderSet(s, 2, 0);
  ok('orderSet', same(s.order, [0, 1, 0]) && r.pattern === 0);
  ok('orderSet / orderAppend / orderInsert refuse a pattern that does not exist', /no pattern 3/.test(MM.orderSet(base(), 0, 3).message) && /no pattern -1/.test(MM.orderAppend(base(), -1).message) && /no pattern 7/.test(MM.orderInsert(base(), 0, 7).message));
  ok('orderRemove / orderMove / orderSet refuse a position that does not exist', /no order position 3/.test(MM.orderRemove(base(), 3).message) && /no order position 5/.test(MM.orderMove(base(), 5, 0).message) && /no order position -1/.test(MM.orderSet(base(), -1, 0).message));
  s = base();
  ok('setLoop: a position, "none" / null, and a refusal outside the list', MM.setLoop(s, 2).message === null && s.loop === 2 && MM.setLoop(s, null).message === null && s.loop === null
    && MM.setLoop(s, '1').message === null && s.loop === 1 && /0\.\.2, or none/.test(MM.setLoop(s, 3).message) && s.loop === 1 && MM.setLoop(s, 'none').message === null && s.loop === null);
  s = MM.fromSong(song([pt(1)], Array(64).fill(0), 0));
  ok('the order list has at most 64 entries: append and insert are refused', /at most 64/.test(MM.orderAppend(s, 0).message) && /at most 64/.test(MM.orderInsert(s, 0, 0).message) && s.order.length === 64);
  // random order operations keep a valid song and the loop on an entry
  let good = true;
  for (let n = 0; n < 400; n++) {
    s = MM.fromSong(randomSong());
    const op = int(0, 4), pos = int(0, s.order.length - 1), p = int(0, s.patterns.length - 1);
    [() => MM.orderAppend(s, p), () => MM.orderInsert(s, int(0, s.order.length), p), () => MM.orderRemove(s, pos), () => MM.orderMove(s, pos, int(0, s.order.length - 1)), () => MM.orderSet(s, pos, p)][op]();
    if (validateAsset('music', MM.toSong(s)) !== null || !MM.validateSong(s).ok) good = false;
  }
  ok('400 random order operations: every result is a valid song (the loop within the list)', good);
}

// ═══ 5 ════════════════════════════════════════════════════════════════════════════════════════════════════════
section('5  note entry');
{
  ok('the instruments: pluck, organ, bass, drum', same(MM.INSTRUMENTS.map((x) => x.id), ['pluck', 'organ', 'bass', 'drum']));
  const pl = MM.noteRecords('A4', 6, 'pluck');
  ok('pluck A4 x 6: the tone of A4 (toneOfNote), volume 14 falling by a fifth each refresh, tone only', pl.every((r) => r.tone === S.toneOfNote('A4') && r.mix === 6 && r.noise === 0) && same(pl.map((r) => r.vol), [14, 11, 9, 7, 6, 5]));
  ok('organ: the peak held, the last refresh at half', same(MM.noteRecords('C4', 5, 'organ').map((r) => r.vol), [11, 11, 11, 11, 6]) && same(MM.noteRecords('C4', 2, 'organ').map((r) => r.vol), [11, 11]));
  ok('bass: two refreshes at the peak, falling to 60 %, the last one silent', same(MM.noteRecords('C2', 6, 'bass').map((r) => r.vol), [13, 13, 11, 10, 8, 0]) && same(MM.noteRecords('C2', 3, 'bass').map((r) => r.vol), [13, 13, 8]));
  const dr = MM.noteRecords('C4', 4, 'drum');
  ok('drum: noise only (mix 5), falling by 30 %, the note picks the noise period (C4 -> 18, higher notes shorter)', dr.every((r) => r.mix === 5 && r.noise === 18) && same(dr.map((r) => r.vol), [14, 10, 7, 5])
    && MM.noteRecords('C6', 1, 'drum')[0].noise === 6 && MM.noteRecords('C1', 1, 'drum')[0].noise === 31);
  ok('a peak volume overrides the instrument\'s', same(MM.noteRecords('C4', 3, 'organ', { peak: 6 }).map((r) => r.vol), [6, 6, 3]));
  ok('a note can be a MIDI number, a sharp or a flat', MM.noteRecords(69, 1)[0].tone === S.toneOfNote('A4') && MM.noteRecords('C#5', 1)[0].tone === MM.noteRecords('Db5', 1)[0].tone);
  ok('every note of octaves 0..8 (below A0 only the drum) of every instrument at peak 15 is storable (tone 3840+ gets volume 14)', MM.INSTRUMENTS.every((x) => MM.NOTE_LETTERS.every((n) => [0, 1, 4, 8].every((o) => MM.noteRefusal(`${n}${o}`, x.id) || MM.noteRecords(`${n}${o}`, 3, x.id, { peak: 15 }).every((r) => !(r.vol === 15 && r.tone >= 3840))))) && MM.noteRecords('A0', 1, 'organ', { peak: 15 })[0].vol === 14);
  ok('a bad note name or instrument throws', throws(() => MM.noteRecords('H4', 1), /not a note name/) && throws(() => MM.noteRecords('C4', 1, 'tuba'), /unknown instrument/));
  ok('the length is clamped to 1..1800', MM.noteRecords('C4', 0).length === 1 && MM.noteRecords('C4', 9999).length === 1800);
  // writing into a track
  const p = { ticks: [tk(1), tk(2), tk(3)], ticksB: [], ticksC: [] };
  let r = MM.enterNote(S.trackView(p, 0), 1, 'E4', 4, 'organ');
  ok('enterNote at tick 1 of a 3-tick track: overwrites 1..2 and extends to 5 ticks; range and next', same(r.range, [1, 4]) && r.next === 5 && r.message === null && p.ticks.length === 5 && p.ticks[0].tone === 1 && p.ticks.slice(1).every((t) => t.tone === S.toneOfNote('E4')));
  r = MM.enterNote(S.trackView(p, 1), 3, 'G2', 2, 'bass');
  ok('enterNote on an empty channel B at tick 3: pads 0..2 with silent records', p.ticksB.length === 5 && p.ticksB.slice(0, 3).every((t) => t.vol === 0) && p.ticksB[3].tone === S.toneOfNote('G2') && same(r.range, [3, 4]));
  r = MM.enterRest(S.trackView(p, 0), 0, 2);
  ok('enterRest writes silent records', p.ticks[0].vol === 0 && p.ticks[1].vol === 0 && p.ticks[2].vol !== 0 && r.next === 2);
  const q = { ticks: [tk(1)], ticksB: [], ticksC: [] };
  r = MM.enterNote(S.trackView(q, 2), 1795, 'C4', 10, 'pluck');
  ok('a note past the 1800-refresh cap is cut, with a message', q.ticksC.length === 1800 && same(r.range, [1795, 1799]) && /at most 1800 ticks: the note was cut to 5 ticks/.test(r.message));
  ok('notes entered make a valid pattern (convertPattern accepts it)', !throws(() => convertPattern(q)) && validateAsset('sfx', S.toAsset(q)) === null);
}

// ═══ 6 ════════════════════════════════════════════════════════════════════════════════════════════════════════
section('6  validation');
{
  const v = (s) => MM.validateSong(s);
  const good = song([pt(3), pt(2)], [0, 1], 0);
  ok('a good song: ok, no errors, no warnings', v(good).ok && v(good).errors.length === 0 && v(good).warnings.length === 0);
  ok('an empty order list', !v(song([pt(1)], [], null)).ok && /order list is empty/.test(v(song([pt(1)], [], null)).errors[0]));
  ok('an order entry naming no pattern', /order position 1 plays pattern 2, which does not exist \(patterns 0\.\.1\)/.test(v(song([pt(1), pt(1)], [0, 2])).errors[0]));
  ok('a loop outside the order list', /the loop is 2: an order position 0\.\.1, or none/.test(v(song([pt(1)], [0, 0], 2)).errors[0]));
  ok('too many patterns', /33 patterns \(at most 32\)/.test(v(song(Array.from({ length: 33 }, () => pt(1)), [0])).errors[0]));
  ok('too long an order list', /65 entries \(at most 64\)/.test(v(song([pt(1)], Array(65).fill(0))).errors[0]));
  ok('a pattern with no ticks', /pattern 1 has no ticks/.test(v(song([pt(1), { ticks: [], ticksB: [], ticksC: [] }], [0])).errors.join()));
  ok('a pattern too long', /pattern 0 is 1801 refreshes long \(at most 1800\)/.test(v(song([pt(1801)], [0])).errors.join()));
  const bad = song([pt(2), { ticks: [tk(100)], ticksB: [tk(3900, 15)], ticksC: [] }], [0, 1]);
  const vb = v(bad);
  ok('an unstorable record: named by pattern and channel, listed in `unstorable`', !vb.ok && /^pattern 1: channel B tick 0: tone 3840/.test(vb.errors[0]) && same(vb.unstorable, [{ pattern: 1, channel: 'B', ticks: [0] }]));
  ok('a field out of range', /pattern 0: tick 0 vol must be a whole number 0\.\.15/.test(v(song([{ ticks: [tk(1, 16)] }], [0])).errors[0]));
  ok('a pattern never played is a warning (with its bytes), not an error', (() => { const r = v(song([pt(1), pt(2)], [0])); return r.ok && /pattern 1 is not in the order list: it is never played, but its \d+ bytes are stored/.test(r.warnings[0]); })());
  // ok <=> convertMusic accepts, on random songs and random breakages
  let agree = 0, total = 0, firstBad = '';
  for (let n = 0; n < 1500; n++) {
    const s = randomSong(n % 3 !== 0);
    const k = int(0, 9);
    if (k === 0) s.order.push(int(-1, s.patterns.length + 1));
    if (k === 1) s.loop = int(-1, s.order.length + 1);
    if (k === 2) s.order = [];
    if (k === 3) s.patterns[0].ticks = [];
    if (k === 4) s.patterns[0].ticks.push({ tone: 4000, vol: 15, noise: 0, mix: 6 });
    if (k === 5) s.patterns[0].ticks.push({ tone: 10, vol: 3.5, noise: 0, mix: 6 });
    let accepts = true;
    try { convertMusic(s); } catch { accepts = false; }
    total++;
    if (v(s).ok === accepts) agree++; else if (!firstBad) firstBad = JSON.stringify(s).slice(0, 300) + ' ' + v(s).errors.join('; ');
  }
  ok(`validateSong(s).ok === convertMusic accepts s, on ${total} random songs (a third with unstorable records, many broken)`, agree === total, `${agree}/${total} ${firstBad}`);
  // validateAsset('music')
  const va = (x) => validateAsset('music', x);
  ok('validateAsset: a good song, with and without loop, with null channels', va(MM.toSong(MM.fromSong(good))) === null && va({ patterns: [{ ticks: [tk(1)], ticksB: null }], order: [0] }) === null && va({ ...good, loop: null }) === null);
  ok('validateAsset: no patterns / an empty pattern list', /needs "patterns"/.test(va({ order: [0] })) && /needs "patterns"/.test(va({ patterns: [], order: [] })));
  ok('validateAsset: more than 32 patterns', /at most 32 patterns \(this one has 33\)/.test(va(song(Array.from({ length: 33 }, () => pt(1)), [0]))));
  ok('validateAsset: a pattern that is not an object, has no ticks array, a bad tone, too many ticks, no ticks at all',
    /pattern 1 is not an object/.test(va(song([pt(1), 5], [0]))) && /pattern 0: a pattern needs "ticks"/.test(va(song([{ ticksB: [] }], [0])))
    && /pattern 0: channel B tick 0: "tone" must be 0\.\.4095/.test(va(song([{ ticks: [tk(1)], ticksB: [tk(5000)] }], [0])))
    && /pattern 0: a pattern has at most 1800 ticks/.test(va(song([pt(1801)], [0]))) && /pattern 0 has no ticks/.test(va(song([{ ticks: [] }], [0]))));
  ok('validateAsset: an empty / missing order list, more than 64 entries, an index outside the list',
    /non-empty "order"/.test(va({ patterns: [pt(1)], order: [] })) && /non-empty "order"/.test(va({ patterns: [pt(1)] })) && /at most 64 entries \(this one has 65\)/.test(va(song([pt(1)], Array(65).fill(0))))
    && /order entry 1 is 1: a pattern index 0\.\.0/.test(va(song([pt(1)], [0, 1]))) && /order entry 0 is "0"/.test(va(song([pt(1)], ['0']))));
  ok('validateAsset: a loop outside the order list', /"loop" is 2: an order position 0\.\.1/.test(va(song([pt(1)], [0, 0], 2))) && /"loop" is -1/.test(va(song([pt(1)], [0], -1))));
  ok('validateAsset: an unstorable record passes (the asset checks report it, as for effects)', va(bad) === null);
  // the project validator and asset references
  const proj = newProject('m'); proj.assets.music = { tune: MM.toSong(MM.newSong()) }; proj.files['main.arc'] += '\nMUSIC tune = "tune"\n';
  ok('validateProject keeps a song; a bad one is refused with its name', validateProject(proj).ok && same(validateProject(proj).project.assets.music.tune, proj.assets.music.tune)
    && /assets\.music\.x: order entry 0/.test(validateProject({ ...proj, assets: { ...proj.assets, music: { x: song([pt(1)], [3]) } } }).errors?.[0] ?? ''));
  ok('assetReferences finds MUSIC lines', same(assetReferences(proj, 'music', 'tune').map((r) => r.file), ['main.arc']));
  // the asset checks
  const cp = (music) => ({ format: 1, files: { 'main.arc': '' }, assets: { sprites: {}, tilesets: {}, maps: {}, sfx: {}, music } });
  const f1 = checkAssets(cp({ s: bad }), null);
  ok('checkAssets: music-unstorable with the pattern, the channel and the ticks', f1.length === 1 && f1[0].id === 'music-unstorable' && f1[0].kind === 'music' && f1[0].asset === 's' && f1[0].pattern === 1 && f1[0].channel === 'B' && same(f1[0].ticks, [0]) && f1[0].severity === 'error' && /pattern 1 channel B tick 0 has a tone of 3840/.test(f1[0].message), JSON.stringify(f1));
  const f2 = checkAssets(cp({ s: song([pt(1), pt(1)], [0]) }), null);
  ok('checkAssets: music-unused-pattern is a warning the compiler does not give', f2.length === 1 && f2[0].id === 'music-unused-pattern' && f2[0].severity === 'warning' && f2[0].pattern === 1 && f2[0].compilerAlso === false);
  const f3 = checkAssets(cp({ a: song([pt(1)], []), b: song([pt(1)], [0, 4], 7), c: { order: [0] }, d: song([{ ticks: [] }], [0]) }), null);
  ok('checkAssets: music-shape for an empty order list, an entry naming no pattern, a bad loop, an empty pattern; asset-malformed without patterns',
    has(f3, 'music-shape', 'a', /empty order list/) && has(f3, 'music-shape', 'b', /order position 1 names no pattern/) && has(f3, 'music-shape', 'b', /the loop 7/) && has(f3, 'music-shape', 'd', /pattern 0 has no ticks/) && has(f3, 'asset-malformed', 'c', /no "patterns"/), JSON.stringify(f3.map((f) => [f.id, f.asset, f.message])));
  ok('checkAssets: a good song has no findings', checkAssets(cp({ g: MM.toSong(MM.newSong()) }), null).length === 0);
  function has(fs, id, asset, re) { return fs.some((f) => f.id === id && f.asset === asset && re.test(f.message)); }
}

// ═══ 7 ════════════════════════════════════════════════════════════════════════════════════════════════════════
section('7  size and length');
{
  let agree = true, why = '';
  for (let n = 0; n < 600; n++) {
    const s = MM.fromSong(randomSong());
    const info = MM.songInfo(s), c = convertMusic(s);
    const lens = s.patterns.map((p) => Math.max(p.ticks.length, p.ticksB.length, p.ticksC.length));
    const one = s.order.reduce((a, p) => a + lens[p], 0);
    const loopPart = s.loop === null ? 0 : s.order.slice(s.loop).reduce((a, p) => a + lens[p], 0);
    if (!(info.bytes === c.bytes && info.refreshes === c.refreshes && info.refreshes === one && info.loopRefreshes === loopPart && Math.abs(info.seconds - one / S.REFRESH_HZ) < 1e-9
      && same(info.patternBytes, c.patterns.map((p) => p.bytes.length)) && same(info.lengths, lens) && info.error === null)) { agree = false; why = JSON.stringify(info); break; }
  }
  ok('songInfo on 600 random songs: bytes = convertMusic(...).bytes, refreshes, loop refreshes, seconds, per-pattern bytes = convertPattern', agree, why);
  const s = MM.fromSong(song([{ ticks: [tk(4000, 15)], ticksB: [], ticksC: [] }], [0], 0));
  const info = MM.songInfo(s);
  ok('a song convertMusic refuses still has a size (the record clamped) and its error', /cannot be stored/.test(info.error) && info.bytes === convertMusic(song([{ ticks: [tk(4000, 14)] }], [0], 0)).bytes);
  const held = MM.fromSong(song([{ ticks: Array(300).fill(tk(500)), ticksB: [], ticksC: [] }], [0], null));
  ok('a held note is cheap: 300 equal refreshes are 1 + 22 + 3 wait bytes + the end in the pattern', MM.patternBytes(held.patterns[0]) === 1 + 22 + 3 + 1 && MM.songInfo(held).bytes === 1 + 2 * 2 + 27);
}

// ═══ 8 ════════════════════════════════════════════════════════════════════════════════════════════════════════
section('8  the preview');
{
  const s = MM.fromSong(song([pt(3, 100), pt(2, 200, 4)], [0, 1, 0], 1));
  const tl = MM.songTimeline(s);
  ok('songTimeline: the order, then from the loop to the end once more', same(tl.sections.map((x) => [x.pos, x.pattern, x.start, x.length, x.again]), [[0, 0, 0, 3, false], [1, 1, 3, 4, false], [2, 0, 7, 3, false], [1, 1, 10, 4, true], [2, 0, 14, 3, true]]) && tl.refreshes === 17);
  ok('each pattern is padded to its length with silent records (both mixer bits off, volume 0)', tl.asset.ticks.length === 17 && tl.asset.ticksB.length === 17 && same(tl.asset.ticks[5], { tone: 0, vol: 0, noise: 0, mix: 7 }) && tl.asset.ticks[3].tone === 200 && tl.asset.ticksB[0].mix === 7 && tl.asset.ticksB[3].tone === 250);
  ok('a channel no pattern uses stays empty', same(tl.asset.ticksC, []));
  ok('no loop: one pass', MM.songTimeline({ ...s, loop: null }).refreshes === 10 && MM.songTimeline(s, { loopOnce: false }).refreshes === 10);
  const cut = MM.songTimeline(s, { maxTicks: 5 });
  ok('the preview is cut at maxTicks', cut.truncated && cut.refreshes === 5 && cut.asset.ticks.length === 5 && same(cut.sections.map((x) => x.length), [3, 2]));
  const one = MM.fromSong(song([pt(6, 300)], [0], null));
  const a = MM.renderSong(one, { rate: 8000 }), b = S.renderSfx(one.patterns[0], { rate: 8000 });
  ok('renderSong of a one-pattern song without a loop is renderSfx of its pattern, sample for sample', a.length === b.length && a.every((x, i) => x === b[i]));
  const r = MM.renderSong(s, { rate: 8000 });
  ok('renderSong: as long as the timeline, the same samples as renderSfx of it, and sound in it', r.length === Math.round(17 * 8000 / S.REFRESH_HZ) && same([...r], [...S.renderSfx(tl.asset, { rate: 8000 })]) && r.some((x) => x !== 0));
  ok('a default song renders without error', MM.renderSong(MM.newSong(), { rate: 8000 }).length === Math.round(64 * 8000 / S.REFRESH_HZ));
  ok('MAX_PREVIEW_TICKS is five minutes', MM.MAX_PREVIEW_TICKS === Math.round(300 * S.REFRESH_HZ));
}

// ═══ 9 ════════════════════════════════════════════════════════════════════════════════════════════════════════
section('9  undo / redo');
{
  const s = MM.newSong();
  const h = MM.createHistory(s, 50);
  const snaps = [JSON.stringify(MM.toSong(s))];
  const step = (fn) => { fn(); h.commit(s); snaps.push(JSON.stringify(MM.toSong(s))); };
  step(() => MM.addPattern(s, 1));
  step(() => MM.enterNote(S.trackView(s.patterns[1], 2), 0, 'D5', 8, 'pluck'));
  step(() => MM.orderAppend(s, 1));
  step(() => MM.setLoop(s, 1));
  step(() => S.setTick(S.trackView(s.patterns[0], 0), 3, 'vol', 2));
  step(() => MM.movePattern(s, 1, 0));
  step(() => MM.deletePattern(s, 1));
  let back = true;
  for (let k = snaps.length - 2; k >= 0; k--) { const u = h.undo(); if (JSON.stringify(MM.toSong(u)) !== snaps[k]) back = false; }
  ok(`undo steps back through ${snaps.length - 1} song edits (patterns, notes, order, loop, a field, a move, a delete), each exactly`, back && !h.canUndo);
  let fwd = true;
  for (let k = 1; k < snaps.length; k++) { const u = h.redo(); if (JSON.stringify(MM.toSong(u)) !== snaps[k]) fwd = false; }
  ok('redo steps forward through them again', fwd && !h.canRedo);
  ok('an operation that was refused changes nothing, so it records no step', (() => { const t = MM.fromSong(song([pt(1)], [0], 0)); const hh = MM.createHistory(t); MM.deletePattern(t, 0); MM.orderRemove(t, 0); return hh.commit(t) === false; })());
}

// ═══ 10 ═══════════════════════════════════════════════════════════════════════════════════════════════════════
section('10  review fixes: octave 0, the size-bounded history, one copy of the limits');
{
  // octave 0: toneOfNote clamps silently (its other callers keep that), note entry refuses
  const lowNames = ['C0', 'C#0', 'D0', 'D#0', 'E0', 'F0', 'F#0', 'G0', 'G#0'];
  ok('toneOfNote still clamps C0..G#0 to 4095 (unchanged for its other callers) and A0 is 4009', lowNames.every((n) => S.toneOfNote(n) === 4095) && S.toneOfNote('A0') === 4009 && S.toneOfNote('A#0') === 3784);
  ok('noteTooLow: every note C0..G#0 (and flats, MIDI numbers) is too low, A0 and up is not', lowNames.every((n) => /^\S+ is below the AY's lowest note, A0$/.test(S.noteTooLow(n))) && S.noteTooLow('A0') === null && S.noteTooLow('Bb0') === null && S.noteTooLow(21) === null && S.noteTooLow(20) === "G#0 is below the AY's lowest note, A0");
  ok('the message names the note as typed: C0 is below the AY\'s lowest note, A0', S.noteTooLow('C0') === "C0 is below the AY's lowest note, A0" && S.noteTooLow('c0') === "C0 is below the AY's lowest note, A0" && S.noteTooLow('Ab0') === "Ab0 is below the AY's lowest note, A0");
  ok('noteRecords refuses C0 .. G#0 for pluck / organ / bass with that message (a RangeError)', lowNames.every((n) => ['pluck', 'organ', 'bass'].every((i) => throws(() => MM.noteRecords(n, 4, i), /^[A-G]#?0 is below the AY's lowest note, A0$/))) && throws(() => MM.noteRecords(0, 4, 'organ'), /^C-1 is below|is below the AY's lowest note, A0$/));
  ok('noteRecords takes A0 (tone 4009) and A1', MM.noteRecords('A0', 2, 'organ')[0].tone === 4009 && MM.noteRecords('A1', 2, 'organ')[0].tone === S.toneOfNote('A1'));
  ok('the drum plays noise, so a low note is fine there (it picks the noise period)', MM.noteRecords('C0', 3, 'drum').every((r) => r.mix === 5 && r.noise === 31) && MM.noteRefusal('C0', 'drum') === null && MM.noteRefusal('C0', 'organ') === "C0 is below the AY's lowest note, A0");
  const view = { ticks: [{ tone: 100, vol: 3, noise: 0, mix: 6 }] };
  ok('enterNote with C0 throws and leaves the track untouched', throws(() => MM.enterNote(view, 0, 'C0', 4, 'pluck'), /lowest note, A0/) && view.ticks.length === 1 && view.ticks[0].tone === 100);
  // one note-name grammar: sound-model's midiOfNote
  ok('midiOfNote: A4 = 69, C#5, Bb3, a number as it is, a bad name throws', S.midiOfNote('A4') === 69 && S.midiOfNote('C#5') === 73 && S.midiOfNote('Bb3') === 58 && S.midiOfNote('c4') === 60 && S.midiOfNote(60) === 60 && throws(() => S.midiOfNote('H4'), /not a note name/) && S.noteNameOfMidi(73) === 'C#5');
  ok('music-model keeps no second grammar: noteRecords rejects a bad name with the same message', throws(() => MM.noteRecords('X9', 1), /"X9" is not a note name such as A4, C#5 or Bb3/));

  // the history is bounded by size as well as by count
  const big = MM.fromSong(song([pt(1800, 100, 1800, 1800), pt(1800, 200, 1800, 1800)], [0, 1], 0));
  const one = JSON.stringify(MM.toSong(big)).length;
  const budget = Math.round(4.5 * one), h = MM.createHistory(big, 201, budget);
  let n = 0;
  for (let k = 0; k < 40; k++) { big.patterns[0].ticks[k % 1800].vol = 1 + (k % 9); if (h.commit(big)) n++; }
  ok(`40 edits of a ${(one / 1e6).toFixed(2)} MB song under a ${(budget / 1e6).toFixed(1)} MB budget: committed, but only the newest steps are kept (${h.size.snapshots} snapshots, ${(h.size.bytes / 1e6).toFixed(1)} MB)`, n === 40 && h.size.snapshots <= 4 && h.size.bytes <= budget && h.canUndo);
  let steps = 0; while (h.undo()) steps++;
  ok('undo goes back through exactly the kept steps and stops, each a valid song', steps === h.depth.redo && steps >= 1 && steps <= 3 && !h.canUndo);
  let again = 0; let last = null; for (let u; (u = h.redo());) { again++; last = u; }
  ok('redo returns to the newest edit, exactly', again === steps && JSON.stringify(MM.toSong(last)) === JSON.stringify(MM.toSong(big)));
  const small = MM.createHistory(MM.newSong(), 201), sm = MM.newSong();
  for (let k = 0; k < 250; k++) { sm.order = [0]; MM.setLoop(sm, null); sm.patterns[0].ticks[0].vol = k % 15; small.commit(sm); }
  ok('a small song keeps the count limit (200 snapshots: 200 undo steps), as the sprite history does', small.depth.undo === 200, JSON.stringify(small.depth));
  const one1 = MM.createHistory(big, 201, 10);
  big.patterns[0].ticks[0].vol = 2; one1.commit(big); big.patterns[0].ticks[0].vol = 3; one1.commit(big);
  ok('even a budget smaller than one snapshot keeps the current one and one undo step', one1.canUndo && one1.size.snapshots === 2);
  one1.reset(MM.newSong());
  ok('reset starts over (one snapshot, nothing to undo)', one1.size.snapshots === 1 && !one1.canUndo && !one1.canRedo);

  // one copy of the limits: the project's and the checker's come from arcade-assets.js
  const limitsOk = import('../src/arcade-project.js').then(({ MUSIC_LIMITS }) => MUSIC_LIMITS.patterns === MM.MAX_PATTERNS && MUSIC_LIMITS.order === MM.MAX_ORDER && MUSIC_LIMITS.ticks === MM.MAX_PATTERN_TICKS && MM.MAX_SONGS === 8);
  ok('MUSIC_LIMITS and the model\'s limits are arcade-assets.js\'s (32 / 64 / 1800 / 8)', await limitsOk && MM.MAX_PATTERNS === 32 && MM.MAX_ORDER === 64 && MM.MAX_PATTERN_TICKS === 1800);
  const fs = await import('node:fs');
  const src = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  ok('no second copy: arcade-project.js and arcade-assetcheck.js hold no 32 / 64 / 1800 literals for the song limits', !/patterns: 32|MUSIC_MAX_PATTERNS = 32|MUSIC_MAX_ORDER = 64|MUSIC_MAX_TICKS = 1800/.test(src('src/arcade-project.js') + src('src/lang/arcade/arcade-assetcheck.js')));
}

// ═══ 11 ═══════════════════════════════════════════════════════════════════════════════════════════════════════
section('11  A1, the note view: notesOfTrack, the inverse of noteRecords');
{
  const fs = await import('node:fs');
  const recsSame = (a, b) => a.length === b.length && a.every((r, k) => r.tone === b[k].tone && r.vol === b[k].vol && r.noise === b[k].noise && r.mix === b[k].mix);
  const clone = (v) => JSON.parse(JSON.stringify(v));
  /** What the cartridge holds of a song: the loop, the order and every pattern's stream, byte for byte (convertMusic's `bytes` alone is only the size). */
  const image = (asset) => { const c = convertMusic(asset); return JSON.stringify({ loop: c.loop, order: c.order, size: c.bytes, patterns: c.patterns.map((q) => Array.from(q.bytes)) }); };
  /** Every claim of a notesOfTrack result is true: the note's records are exactly noteRecords of it; ordered, disjoint; notes + raw + silent-record ticks cover every tick once. */
  function verified(ticks, r) {
    let prevEnd = 0;
    const owner = new Array(ticks.length).fill(null);
    for (const n of r.notes) {
      if (n.at < prevEnd || n.length < 1 || n.at + n.length > ticks.length) return `note at ${n.at} (${n.length}) overlaps or runs off the track`;
      prevEnd = n.at + n.length;
      let want;
      try { want = MM.noteRecords(n.midi, n.length, n.instrument, { peak: n.peak }); } catch (e) { return `noteRecords refuses the claimed note at ${n.at}: ${e.message}`; }
      if (!recsSame(want, ticks.slice(n.at, n.at + n.length))) return `the note at ${n.at} (${n.note} ${n.instrument} ${n.length} peak ${n.peak}) is not what the records say`;
      if (n.note !== S.noteNameOfMidi(n.midi) || n.silent !== (n.peak === 0)) return `the note at ${n.at} is described wrongly`;
      for (let k = n.at; k < n.at + n.length; k++) owner[k] = 'n';
    }
    for (const q of r.raw) for (let k = q.from; k <= q.to; k++) { if (owner[k]) return `raw tick ${k} is also in a note`; owner[k] = 'r'; }
    for (let k = 0; k < ticks.length; k++) if (!owner[k] && !recsSame([ticks[k]], [S.PAD_TICK])) return `tick ${k} is neither a note, raw nor a rest`;
    for (let k = 1; k < r.raw.length; k++) if (r.raw[k].from <= r.raw[k - 1].to + 1) return 'raw ranges touch or overlap (they should be maximal)';
    return null;
  }

  // 1. the inverse, for every instrument, every pitch the lane offers, lengths and peaks
  const lengths = [1, 2, 3, 4, 5, 6, 7, 8, 12, 16, 20, 24, 33, 64, 200, 1800];
  let combos = 0, found = 0, exact = 0, exactCases = 0, why = '';
  for (const inst of MM.INSTRUMENTS) {
    for (let midi = inst.id === 'drum' ? MM.NOTE_MIN : 21; midi <= MM.NOTE_MAX; midi++) {
      for (const n of lengths) {
        if (n > 200 && midi % 7) continue;                                   // the longest only on some pitches (they cost the most)
        for (const peak of [inst.peak, 0, 1, 2, 3, 5, 8, 11, 14, 15]) {
          combos++;
          const recs = MM.noteRecords(midi, n, inst.id, { peak });
          const pad = [{ ...S.PAD_TICK }, ...recs, { ...S.PAD_TICK }];       // a rest on each side: the note is found in the middle
          const r = MM.notesOfTrack(pad);
          const f = r.notes[0];
          const one = r.notes.length === 1 && r.raw.length === 0 && f.at === 1 && f.length === n && recsSame(MM.noteRecords(f.midi, f.length, f.instrument, { peak: f.peak }), recs);
          if (one) found++; else if (why.length < 300) why += ` ${inst.id}/${midi}/${n}/${peak}`;
          // a note whose records no other instrument / pitch / peak writes comes back as itself: from 8 ticks, a real peak, and not the 14 / 15 pair above tone 3840
          if (n >= 8 && peak >= 3 && (inst.id !== 'drum' || midi >= 21) && !(peak >= 14 && S.toneOfNote(midi) >= S.UNSTORABLE_TONE_FROM)) { exactCases++; if (one && f.instrument === inst.id && f.midi === midi && f.peak === peak) exact++; else if (why.length < 300) why += ` [${inst.id}/${midi}/${n}/${peak} -> ${f?.instrument}/${f?.midi}/${f?.peak}]`; }
        }
      }
    }
  }
  ok(`notesOfTrack(noteRecords(...)) gives back one note covering exactly those records: ${combos} cases (every instrument, pitch C0..B8 / A0..B8, lengths 1..1800, peaks 0..15)`, found === combos, `${found}/${combos}${why}`);
  ok(`and when no other reading writes the same records (8+ ticks, peak 3+, a drum from A0 up: below it every drum note is one record) it is the very note entered: instrument, pitch, length and peak (${exactCases} cases)`, exact === exactCases, `${exact}/${exactCases}${why}`);
  ok('a short note several instruments write alike (1 tick of pluck, organ or bass) is read as the one whose own peak it is, then in INSTRUMENTS order',
    MM.notesOfTrack(MM.noteRecords('C4', 1, 'organ'))?.notes[0].instrument === 'organ' && MM.notesOfTrack(MM.noteRecords('C4', 1, 'pluck')).notes[0].instrument === 'pluck' && MM.notesOfTrack(MM.noteRecords('C4', 1, 'bass')).notes[0].instrument === 'bass'
    && MM.notesOfTrack(MM.noteRecords('C4', 1, 'organ', { peak: 3 })).notes[0].instrument === 'pluck');
  ok('the note carries what re-entering needs: {at, length, midi, note (sharps name), instrument, peak, silent}', same(MM.notesOfTrack([...MM.noteRecords('C#5', 8, 'organ')]).notes, [{ at: 0, length: 8, midi: 73, note: 'C#5', instrument: 'organ', peak: 11, silent: false }]));
  ok('a silent note (peak 0: how the example songs write a rest, the last pitch at volume 0) is a note with silent: true', (() => { const r = MM.notesOfTrack(MM.noteRecords('E3', 12, 'organ', { peak: 0 })).notes[0]; return r.silent && r.peak === 0 && r.midi === 52 && r.length === 12; })());
  ok('the drum below A0 (one record whatever the note) is read as the lowest note of the lane, C0', (() => { const r = MM.notesOfTrack(MM.noteRecords('G#0', 6, 'drum')).notes[0]; return r.instrument === 'drum' && r.midi === MM.NOTE_MIN && recsSame(MM.noteRecords(r.midi, 6, 'drum'), MM.noteRecords('G#0', 6, 'drum')); })());
  ok('a tick record is never read as two notes\' worth: a note and the next of the same pitch stay two (organ 8 + organ 8: the half-volume last tick ends the first)', (() => { const a = [...MM.noteRecords('A3', 8, 'organ'), ...MM.noteRecords('A3', 8, 'organ')]; const r = MM.notesOfTrack(a); return r.notes.length === 2 && r.notes[0].length === 8 && r.notes[1].at === 8 && r.raw.length === 0; })());

  // 2. exact means exact: one field off and it is not that note
  const base = MM.noteRecords('G4', 8, 'organ');
  const off = (k, f, d) => base.map((r, i) => (i === k ? { ...r, [f]: r[f] + d } : { ...r }));
  const claims = (ticks) => MM.notesOfTrack(ticks).notes.map((n) => `${n.at}:${n.length}`).join(' ');
  ok('one record of an organ note changed (tone, volume, noise or mix): the note is no longer shown as 8 ticks, and what is shown is still exactly noteRecords',
    [off(3, 'tone', 1), off(2, 'vol', 1), off(5, 'noise', 1), off(0, 'mix', 1), off(7, 'vol', 1)].every((t) => !MM.notesOfTrack(t).notes.some((n) => n.at === 0 && n.length === 8) && verified(t, MM.notesOfTrack(t)) === null));
  ok('the changed tick itself is raw', MM.notesOfTrack(off(3, 'tone', 1)).raw.some((q) => q.from <= 3 && q.to >= 3) && MM.notesOfTrack(off(2, 'noise', 3)).raw.some((q) => q.from <= 2 && q.to >= 2));
  ok('silence made by enterRest (the pad record) is neither a note nor raw', same(MM.notesOfTrack(Array.from({ length: 20 }, () => ({ ...S.PAD_TICK }))), { notes: [], raw: [] }));
  ok('a track, or a view, with nothing in it gives nothing; a trackView works as the ticks do', same(MM.notesOfTrack([]), { notes: [], raw: [] }) && same(MM.notesOfTrack({ ticks: base }), MM.notesOfTrack(base)) && same(MM.notesOfTrack(null), { notes: [], raw: [] }));
  const frozen = JSON.stringify(base);
  MM.notesOfTrack(base);
  ok('notesOfTrack never changes the ticks it reads', JSON.stringify(base) === frozen);

  // 3. what is written by note entry and rests reads back whole: random tracks, rebuilt tick for tick
  seed = 1101;
  let comps = 0, compOk = 0, compWhy = '';
  for (let c = 0; c < 400; c++) {
    const view = { ticks: [] };
    let at = 0;
    const steps = int(1, 14);
    for (let k = 0; k < steps; k++) {
      const inst = pick(MM.INSTRUMENTS), len = pick([1, 2, 3, 4, 6, 8, 8, 12, 16, 24, 32, int(1, 40)]);
      const midi = inst.id === 'drum' ? int(12, 100) : int(21, 100);
      const peak = pick([null, null, inst.peak, 0, int(1, 15)]);
      if (rnd() < 0.2) { MM.enterRest(view, at, len); at += len; } else { MM.enterNote(view, at, midi, len, inst.id, peak === null ? {} : { peak }); at += len; }
      if (rnd() < 0.1) at += int(1, 5);                                      // a gap: padded with the pad record
    }
    comps++;
    const r = MM.notesOfTrack(view.ticks);
    const rebuilt = { ticks: [] };
    for (const n of r.notes) MM.enterNote(rebuilt, n.at, n.midi, n.length, n.instrument, { peak: n.peak });
    while (rebuilt.ticks.length < view.ticks.length) rebuilt.ticks.push({ ...S.PAD_TICK });
    const v = verified(view.ticks, r);
    if (v === null && r.raw.length === 0 && same(rebuilt.ticks, view.ticks)) compOk++; else if (compWhy.length < 200) compWhy += ` #${c}: ${v ?? (r.raw.length ? 'raw ' + JSON.stringify(r.raw) : 'rebuild differs')}`;
  }
  ok(`${comps} random tracks written with enterNote and enterRest (all four instruments, peaks 0..15, gaps): no raw ticks, and the notes re-entered with enterNote give the same ticks, record for record`, compOk === comps, `${compOk}/${comps}${compWhy}`);

  // 4. ticks written by something else never come out as a wrong note
  seed = 4242;
  let foreign = 0, foreignOk = 0, claimed = 0, foreignWhy = '';
  const noteTones = [S.toneOfNote('C4'), S.toneOfNote('E4'), S.toneOfNote('G4'), S.toneOfNote('A2'), 300, 200, 4095, 1];
  for (let c = 0; c < 1500; c++) {
    const n = int(1, 60);
    const ticks = Array.from({ length: n }, () => {
      const kind = int(0, 5);
      if (kind === 0) return { ...S.PAD_TICK };
      if (kind <= 3) { const t = pick(noteTones); return { tone: t, vol: pick([0, 14, 11, 13, int(0, 15)]), noise: pick([0, 0, 0, int(0, 31)]), mix: pick([6, 6, 5, 4, int(0, 7)]) }; }
      return { tone: int(0, 4095), vol: int(0, 15), noise: int(0, 31), mix: int(0, 7) };
    });
    // sometimes splice a real note in, so a note with foreign ticks around it and inside it is tried
    if (rnd() < 0.5) { const inst = pick(MM.INSTRUMENTS); const at = int(0, n - 1); const view = { ticks: ticks.slice() }; try { MM.enterNote(view, at, inst.id === 'drum' ? int(12, 100) : int(21, 100), int(1, 20), inst.id); } catch { /* none */ } ticks.splice(0, ticks.length, ...view.ticks); if (rnd() < 0.5 && ticks.length > 2) ticks[int(0, ticks.length - 1)].vol = int(0, 15); }
    foreign++;
    const before = JSON.stringify(ticks);
    const r = MM.notesOfTrack(ticks);
    claimed += r.notes.length;
    const v = verified(ticks, r);
    if (v === null && JSON.stringify(ticks) === before) foreignOk++; else if (foreignWhy.length < 300) foreignWhy += ` #${c}: ${v ?? 'the input changed'}`;
  }
  ok(`${foreign} tracks of random and half-note ticks (${claimed} notes claimed): every claimed note is exactly noteRecords of it, notes / raw / rests cover each tick once, the input is untouched`, foreignOk === foreign, `${foreignOk}/${foreign}${foreignWhy}`);

  // 5. the example games: their sound effects (not notes) and their songs
  const exDir = new URL('../arcade/examples/', import.meta.url);
  const files = fs.readdirSync(exDir).filter((f) => f.endsWith('.assets.json')).sort();
  let sfxTracks = 0, sfxNotes = 0, sfxBad = '';
  let songs = 0, songTracks = 0, songNotes = 0, songRaw = 0, songTicks = 0, songBad = '', songBytes = 0;
  const first = { name: null };
  for (const f of files) {
    const a = JSON.parse(fs.readFileSync(new URL(f, exDir), 'utf8'));
    for (const [name, e] of Object.entries(a.sfx ?? {})) {
      for (const key of ['ticks', 'ticksB', 'ticksC']) {
        const ticks = e[key] ?? [];
        if (!ticks.length) continue;
        sfxTracks++;
        const r = MM.notesOfTrack(ticks);
        sfxNotes += r.notes.length;
        const v = verified(ticks, r);
        if (v !== null && sfxBad.length < 300) sfxBad += ` ${f}/${name}/${key}: ${v}`;
      }
    }
    for (const [name, m] of Object.entries(a.music ?? {})) {
      songs++;
      const sg = MM.fromSong(m), out = MM.cloneSong(sg);
      sg.patterns.forEach((p, pi) => {
        for (const key of ['ticks', 'ticksB', 'ticksC']) {
          const ticks = p[key];
          if (!ticks.length) continue;
          songTracks++; songTicks += ticks.length;
          const r = MM.notesOfTrack(ticks);
          songNotes += r.notes.length; songRaw += r.raw.reduce((n, q) => n + q.to - q.from + 1, 0);
          const v = verified(ticks, r);
          if (v !== null && songBad.length < 300) songBad += ` ${f}/${name}/${pi}/${key}: ${v}`;
          const view = { ticks: [] };
          for (const n of r.notes) MM.enterNote(view, n.at, n.midi, n.length, n.instrument, { peak: n.peak });
          while (view.ticks.length < ticks.length) view.ticks.push({ ...S.PAD_TICK });
          out.patterns[pi][key] = view.ticks;
        }
        for (const key of ['ticksB', 'ticksC']) if (!p[key].length) out.patterns[pi][key] = [];
      });
      const want = image(MM.toSong(sg)), got = image(MM.toSong(out));
      if (want === got) songBytes++; else songBad += ` ${f}/${name}: converted bytes differ`;
    }
  }
  ok(`sound effects of the example games are not notes: ${sfxTracks} tracks, ${sfxNotes} short runs happen to be exact notes; nothing claimed is wrong, everything else stays raw`, sfxTracks > 20 && sfxBad === '', sfxBad);
  ok(`every example song (${songs} songs, ${songTracks} tracks, ${songTicks} ticks) is shown whole: ${songNotes} notes, ${songRaw} raw ticks`, songs >= 12 && songRaw === 0 && songBad === '', songBad);
  ok(`each of them re-entered note by note (enterNote from what the note view shows) converts to IDENTICAL bytes (convertMusic: the loop, the order and every pattern's stream, byte for byte), ${songBytes}/${songs}`, songBytes === songs && songs >= 12);

  // 6. the lane's edits: placeNote, replaceNote, removeNote are enterNote / enterRest and nothing else
  const fresh = (n = 32) => ({ ticks: Array.from({ length: n }, () => ({ ...S.PAD_TICK })) });
  {
    const v = fresh(), w = fresh();
    const r = MM.placeNote(v, 4, 60, 8, 'organ');
    const e = MM.enterNote(w, 4, 60, 8, 'organ');
    ok('placeNote is enterNote (same ticks, same result: range, next)', same(v, w) && same(r, e) && r.range[0] === 4 && r.next === 12);
    const x = fresh(); x.ticks[10] = { tone: 1234, vol: 9, noise: 3, mix: 5 };
    const o = MM.placeNote(x, 6, 67, 8, 'pluck', 7);
    const n = MM.notesOfTrack(x);
    ok('a note placed over foreign ticks replaces them (as enterNote does) and is shown as that note with that peak', n.notes.length === 1 && n.notes[0].at === 6 && n.notes[0].length === 8 && n.notes[0].peak === 7 && n.raw.length === 0 && o.range[0] === 6);
    ok('placed past the end of the track, it extends the track (padded with the rest record)', (() => { const t = fresh(4); MM.placeNote(t, 10, 60, 3, 'organ'); return t.ticks.length === 13 && same(t.ticks[5], S.PAD_TICK) && MM.notesOfTrack(t).notes[0].at === 10; })());
    const before = JSON.stringify(v);
    const refused = [MM.placeNote(v, 0, 20, 4, 'organ'), MM.placeNote(v, 0, 11, 4, 'drum'), MM.placeNote(v, 0, 120, 4, 'drum'), MM.placeNote(v, -1, 60, 4, 'organ'), MM.placeNote(v, 0, 60.5, 4, 'organ')];
    ok('refusals say why and change nothing (below the AY\'s lowest note, outside C0..B8, before tick 0)', JSON.stringify(v) === before && refused.every((q) => typeof q.message === 'string' && !q.range) && /lowest note, A0/.test(refused[0].message) && /between C0 and B8/.test(refused[1].message), JSON.stringify(refused.map((q) => q.message)));
  }
  {
    // replaceNote: move, lengthen, shorten, change the pitch; equal to enterRest then enterNote
    const mk = () => { const v = fresh(40); MM.placeNote(v, 8, 64, 8, 'organ'); MM.placeNote(v, 20, 71, 6, 'pluck', 9); return v; };
    const v = mk(), note = MM.notesOfTrack(v).notes[0];
    const m = MM.replaceNote(v, note, { at: 12, midi: 66 });
    const w = mk(); MM.enterRest(w, 8, 8); MM.enterNote(w, 12, 66, 8, 'organ', { peak: 11 });
    ok('replaceNote (move in time and pitch) = enterRest over the old ticks, then enterNote: the same ticks', same(v, w) && same(m.range, [12, 19]));
    const n2 = MM.notesOfTrack(v);
    ok('and the lane then shows the note there, same instrument and peak, the other note untouched', n2.notes.length === 2 && n2.notes[0].at === 12 && n2.notes[0].midi === 66 && n2.notes[0].instrument === 'organ' && n2.notes[0].peak === 11 && n2.notes[1].at === 20 && n2.notes[1].midi === 71);
    const l = mk(); MM.replaceNote(l, MM.notesOfTrack(l).notes[0], { length: 16 });
    ok('lengthening overwrites what is under the new end (the other note\'s first 4 ticks: it is no longer that 6-tick note), and what is shown is still exact', (() => { const r = MM.notesOfTrack(l); return r.notes[0].at === 8 && r.notes[0].length === 16 && !r.notes.some((q) => q.at === 20) && l.ticks.length === 40 && verified(l.ticks, r) === null; })());
    const sh = mk(); MM.replaceNote(sh, MM.notesOfTrack(sh).notes[0], { length: 3 });
    ok('shortening frees the old ticks (rest records), the note is now 3 ticks', (() => { const r = MM.notesOfTrack(sh); return r.notes[0].length === 3 && same(sh.ticks[11], S.PAD_TICK) && same(sh.ticks[15], S.PAD_TICK); })());
    const bad = mk(), bj = JSON.stringify(bad), nb = MM.notesOfTrack(bad).notes[0];
    const rr = [MM.replaceNote(bad, nb, { midi: 20 }), MM.replaceNote(bad, nb, { at: -1 }), MM.replaceNote(bad, nb, { length: 0 }), MM.replaceNote(bad, nb, { midi: 200 })];
    ok('a refused replace leaves the track as it was (no half-done rest)', JSON.stringify(bad) === bj && rr.every((q) => typeof q.message === 'string' && !q.range));
    const rm = mk(); const nr = MM.removeNote(rm, MM.notesOfTrack(rm).notes[0]);
    const rw = mk(); MM.enterRest(rw, 8, 8);
    ok('removeNote is enterRest over the note\'s ticks (the note is gone, the other stays, the track keeps its length)', same(rm, rw) && MM.notesOfTrack(rm).notes.length === 1 && rm.ticks.length === 40 && same(nr.range, [8, 15]));
    const sil = fresh(); MM.placeNote(sil, 2, 60, 4, 'drum', 0); const sn = MM.notesOfTrack(sil).notes[0];
    ok('a silent note moves as a silent note (peak 0 is kept)', (() => { MM.replaceNote(sil, sn, { at: 10 }); const r = MM.notesOfTrack(sil).notes; return r.length === 1 && r[0].at === 10 && r[0].silent && r[0].instrument === 'drum'; })());
  }
  // 7. the geometry helpers
  {
    const W = MM.pitchWindow([], null, { channel: 1 });
    ok('an empty lane starts on its channel\'s default window (A C4..B5, B C3..B4, C C2..B3)', same(MM.pitchWindow([], null, { channel: 0 }), { lo: 60, hi: 83 }) && same(W, { lo: 48, hi: 71 }) && same(MM.pitchWindow([], null, { channel: 2 }), { lo: 36, hi: 59 }));
    const fit = MM.pitchWindow([{ midi: 62 }, { midi: 71 }]);
    ok('a lane with notes fits them with 2 rows to spare and at least 14 rows', fit.lo <= 60 && fit.hi >= 73 && fit.hi - fit.lo + 1 >= 14 && MM.pitchWindow([{ midi: 70 }]).hi - MM.pitchWindow([{ midi: 70 }]).lo + 1 === 14);
    const grown = MM.pitchWindow([{ midi: 62 }, { midi: 90 }], fit);
    ok('it grows to hold a new note and never shrinks (a lower note later keeps the old top)', grown.hi >= 92 && grown.lo === fit.lo && MM.pitchWindow([{ midi: 62 }], grown).hi === grown.hi);
    const huge = MM.pitchWindow([{ midi: 12 }, { midi: 119 }]);
    ok('notes more than 48 semitones apart: a window of 48 rows inside C0..B8 (scrollWindow reaches the rest); a grown window stays put instead of passing 48', huge.hi - huge.lo + 1 === 48 && huge.lo >= 12 && huge.hi <= 119 && same(MM.pitchWindow([{ midi: 119 }], { lo: 12, hi: 59 }), { lo: 12, hi: 59 }));
    ok('opts.show moves the window to a midi number outside it', (() => { const w = MM.pitchWindow([], { lo: 60, hi: 83 }, { show: [100] }); const x = MM.pitchWindow([], { lo: 60, hi: 83 }, { show: [40] }); return w.hi === 100 && w.hi - w.lo === 23 && x.lo === 40 && x.hi - x.lo === 23; })());
    ok('scrollWindow keeps the height and stays inside C0..B8', same(MM.scrollWindow({ lo: 60, hi: 83 }, 12), { lo: 72, hi: 95 }) && same(MM.scrollWindow({ lo: 12, hi: 35 }, -50), { lo: 12, hi: 35 }) && same(MM.scrollWindow({ lo: 100, hi: 119 }, 50), { lo: 100, hi: 119 }));
    ok('tick <-> x are inverse at the tick lanes\' scale (colW pixels a tick), clamped; row <-> pitch likewise inside a window', [3, 8, 24].every((c) => [0, 1, 17, 63].every((t) => MM.tickOfX(MM.xOfTick(t, c) + c - 1, c) === t && MM.tickOfX(MM.xOfTick(t, c), c) === t)) && MM.tickOfX(-5, 8, 9) === 0 && MM.tickOfX(999, 8, 9) === 9
      && [60, 70, 83].every((m) => MM.midiOfRow(MM.rowOfMidi(m, { lo: 60, hi: 83 }), { lo: 60, hi: 83 }) === m) && MM.midiOfRow(-4, { lo: 60, hi: 83 }) === 83 && MM.midiOfRow(99, { lo: 60, hi: 83 }) === 60);
    ok('noteAtTick finds the note covering a tick', (() => { const r = MM.notesOfTrack([...MM.noteRecords('C4', 4, 'organ'), ...MM.noteRecords('D4', 4, 'organ')]); return MM.noteAtTick(r, 3).at === 0 && MM.noteAtTick(r, 4).at === 4 && MM.noteAtTick(r, 8) === null; })());
  }
}

console.log(`\nAll checks done: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
