"use strict";
// tile-model.mjs -- tests for src/tools/tile-model.js (the Leap Arcade Studio tile editor's data model).
//   node tests/tile-model.mjs
//   TILE_QUICK=1 node tests/tile-model.mjs     (fewer fuzz steps)
//
// Sections
//   1  creation and the stored form (hex, colours in all 8 rows)
//   2  round trip over every tile set of the example assets; unknown keys; reading odd stored forms
//   3  pixels: set / get, fill, line, clear, invert, flips, rotate, shift (hand-computed)
//   4  colours, flags, fg, attribute byte, tile pixels, blank / black helpers, summary
//   5  set operations: add, duplicate, paste, delete the last tile (refusals), the 128-tile limit
//   6  validation against arcade-project's validateAsset and the compiler's convertTileset
//   7  fuzz: operation identities (flip twice, rotate four times, ...)
//   8  undo / redo
//   C  the REAL compiler: every example built with its original assets and with its tile sets written back through the
//      model must give byte-identical DCKs. Skips when arcade/dist is absent.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as T from '../src/tools/tile-model.js';
import * as S from '../src/tools/sprite-model.js';
import * as P from '../src/arcade-project.js';
import { convertTileset } from '../src/lang/arcade/arcade-assets.js';
import { compile, requiredRuntime } from '../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const QUICK = !!process.env.TILE_QUICK;

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  cond ? passed++ : failed++;
  return cond;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Deep equality that ignores key order (unknown keys come back after the known ones). */
const deq = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deq(a[k], b[k]));
};
const hex = (bits) => bits.map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** A tile from 8 strings of '#' (ink) and '.' (paper). */
function art(rows, colours = {}) {
  const t = T.newTile(colours);
  rows.forEach((line, y) => { [...line].forEach((ch, x) => { if (ch === '#') T.setPixel(t, x, y, 1); }); });
  return t;
}
const stored = (bits, ink = 0, paper = 7, bright = 0) => ({ rows: bits.map((b) => ({ bits: b, ink, paper, bright })), flags: 0 });
const thrown = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

// ── 1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1. Creation and the stored form');
{
  const s = T.newTileset();
  ok('newTileset: one blank tile, ink 0 paper 7 bright 0, flags 0, no fg', s.tiles.length === 1 && same(s.tiles[0].bits, new Array(8).fill(0)) && s.tiles[0].ink === 0 && s.tiles[0].paper === 7 && s.tiles[0].bright === 0 && s.tiles[0].flags === 0 && s.tiles[0].fg === false);
  ok('toAsset(newTileset()) is exactly the stored form: 8 rows "00" with the colours, flags 0', same(T.toAsset(s), { tiles: [stored(new Array(8).fill('00'))] }));
  const t = art(['#.......', '.#......', '..#.....', '...#....', '....#...', '.....#..', '......#.', '.......#'], { ink: 4, paper: 2, bright: 1 });
  ok('bits as integers: a diagonal is 80 40 20 10 08 04 02 01', hex(t.bits) === '80 40 20 10 08 04 02 01');
  const s2 = { tiles: [t], tilesKey: 'tiles' };
  const a = T.toAsset(s2);
  ok('toAsset writes 2-digit upper-case hex and the same ink / paper / bright into all 8 rows', a.tiles[0].rows.every((r, y) => r.bits === ['80', '40', '20', '10', '08', '04', '02', '01'][y] && r.ink === 4 && r.paper === 2 && r.bright === 1 && Object.keys(r).join() === 'bits,ink,paper,bright'));
  ok('the stored tile is {rows, flags}', Object.keys(a.tiles[0]).join() === 'rows,flags' && a.tiles[0].flags === 0);
  const t2 = T.newTile(); T.setPixel(t2, 0, 0, 1); T.setPixel(t2, 7, 7, 1); T.setPixel(t2, 3, 1, 1);
  ok('hex padding: 0x80 -> "80", 0x10 -> "10", 0x01 -> "01"', T.toAsset({ tiles: [t2], tilesKey: 'tiles' }).tiles[0].rows.map((r) => r.bits).join() === '80,10,00,00,00,00,00,01');
  ok('newTile with colours; clone is independent', (() => { const c = T.cloneTile(t); T.setPixel(c, 1, 0, 1); return T.getPixel(t, 1, 0) === 0 && T.getPixel(c, 1, 0) === 1; })());
}

// ── 2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2. Round trip over the example tile sets; unknown keys; odd stored forms');
const EXAMPLES = readdirSync(join(ROOT, 'arcade/examples')).filter((f) => f.endsWith('.assets.json')).map((f) => f.replace('.assets.json', '')).sort();
const exAssets = Object.fromEntries(EXAMPLES.map((id) => [id, JSON.parse(readFileSync(join(ROOT, `arcade/examples/${id}.assets.json`), 'utf8'))]));
{
  let sets = 0, tiles = 0, deep = true, text = true, attrs = true, bytes = true;
  for (const [id, a] of Object.entries(exAssets)) for (const [name, ts] of Object.entries(a.tilesets ?? {})) {
    sets++; tiles += ts.tiles.length;
    const m = T.fromAsset(ts), back = T.toAsset(m);
    if (!same(back, ts)) deep = false;
    if (JSON.stringify(back, null, 1) !== JSON.stringify(ts, null, 1)) text = false;
    const conv = convertTileset(ts);
    m.tiles.forEach((t, i) => {
      if (T.attrByte(t) !== conv.bytes[i * 9 + 8]) attrs = false;
      if (hex(t.bits) !== [...conv.bytes.slice(i * 9, i * 9 + 8)].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' ')) bytes = false;
      if (t.flags !== conv.flags[i]) attrs = false;
    });
  }
  ok(`toAsset(fromAsset(x)) deep-equals x for all ${sets} tile sets (${tiles} tiles) of the ${EXAMPLES.length} example assets files`, deep && sets === 5, `${sets} sets`);
  ok('... and serialises to the same JSON text (key order kept)', text);
  ok('attrByte and flags equal the compiler\'s (convertTileset) for every tile; bits equal its bitmap bytes', attrs && bytes);
  ok('an assets file without tile sets (bounce) has nothing to round-trip', !exAssets.bounce.tilesets);
}
{
  // unknown keys at the set, tile and row level, the "frames" spelling, fg, absent flags
  const asset = {
    name: 'my set', meta: { author: ['a', 'b'], n: 3 },
    tiles: [
      { rows: [{ bits: 'FF', ink: 1, paper: 2, bright: 1, note: 'top' }, ...Array.from({ length: 7 }, () => ({ bits: '81', ink: 1, paper: 2, bright: 1 }))], flags: 5, fg: true, anim: { frames: [1, 2], speed: 4 }, label: 'wall' },
      { rows: Array.from({ length: 8 }, () => ({ bits: '00', ink: 0, paper: 7, bright: 0 })), flags: 0, fg: false },
      { rows: Array.from({ length: 8 }, () => ({ bits: '18', ink: 0, paper: 7, bright: 0 })) },
    ],
  };
  const m = T.fromAsset(asset);
  ok('fromAsset reads fg, flags and the first row\'s colours', m.tiles[0].fg === true && m.tiles[0].flags === 5 && m.tiles[0].ink === 1 && m.tiles[0].paper === 2 && m.tiles[0].bright === 1);
  ok('unknown keys of the set, tile and row are kept aside', m.extra.name === 'my set' && m.extra.meta.n === 3 && m.tiles[0].extra.label === 'wall' && m.tiles[0].extra.anim.speed === 4 && m.tiles[0].rowExtra[0].note === 'top' && m.tiles[0].rowExtra[1] === null);
  ok('they survive toAsset verbatim (deep equal, fg:false and a missing flags key too; the order of unknown keys among themselves is kept)', deq(T.toAsset(m), asset) && same(Object.keys(T.toAsset(m).tiles[0]), ['rows', 'flags', 'fg', 'anim', 'label']));
  const m2 = T.fromAsset(JSON.parse(JSON.stringify(asset)));
  T.setPixel(m2.tiles[0], 3, 3, 1); T.setColours(m2.tiles[0], { ink: 6 }); T.flipH(m2.tiles[2]);
  const back = T.toAsset(m2);
  ok('after edits the unknown keys are still written back; edited fields change', back.name === 'my set' && back.tiles[0].label === 'wall' && back.tiles[0].anim.frames.length === 2 && back.tiles[0].rows[0].note === 'top' && back.tiles[0].rows[3].bits === '91' && back.tiles[0].rows[5].ink === 6);
  ok('a tile that had no flags key is written without one until a flag is set', !('flags' in back.tiles[2]) && (T.setFlag(m2.tiles[2], 0, true), T.toAsset(m2).tiles[2].flags === 1));
  const fr = T.fromAsset({ frames: asset.tiles });
  ok('the "frames" spelling (accepted by the compiler) is written back as "frames"', Array.isArray(T.toAsset(fr).frames) && !('tiles' in T.toAsset(fr)));
  ok('fromAsset does not alias the stored object (mutating the set leaves the asset alone)', (() => { const c = JSON.parse(JSON.stringify(asset)); const mm = T.fromAsset(c); mm.extra.meta.n = 9; mm.tiles[0].extra.anim.speed = 1; mm.tiles[0].bits[0] = 0; return same(c, asset); })());
}
{
  const r = (b) => stored(new Array(8).fill(b));
  ok('bits may be one hex digit ("F" = 15), lower case, or a number', (() => { const m = T.fromAsset({ tiles: [{ rows: [{ bits: 'F' }, { bits: 'f0' }, { bits: 255 }, { bits: '0' }, { bits: 'aB' }, { bits: 1 }, { bits: ' 3C ' }, { bits: '00' }] }] }); return hex(m.tiles[0].bits) === '0F F0 FF 00 AB 01 3C 00'; })());
  ok('missing ink / paper / bright take the compiler\'s defaults 0, 7, 0; bright may be true / false', (() => { const m = T.fromAsset({ tiles: [{ rows: new Array(8).fill({ bits: '00' }) }] }); const n = T.fromAsset({ tiles: [{ rows: new Array(8).fill({ bits: '00', bright: true }) }] }); return m.tiles[0].ink === 0 && m.tiles[0].paper === 7 && m.tiles[0].bright === 0 && n.tiles[0].bright === 1; })());
  ok('rows with other colours than row 0 are reduced to row 0 (the compiler ignores them), rowsDiffer lists the tile', (() => {
    const a = { tiles: [stored(new Array(8).fill('00'), 1, 2, 0), stored(new Array(8).fill('00'), 1, 2, 0)] };
    a.tiles[1].rows[3].ink = 6; a.tiles[1].rows[7].bright = 1;
    const m = T.fromAsset(a);
    return same(T.rowsDiffer(a), [1]) && T.toAsset(m).tiles[1].rows.every((x) => x.ink === 1 && x.bright === 0) && T.attrByte(m.tiles[1]) === convertTileset(a).bytes[9 + 8];
  })());
  const bad = (what, a, re) => ok(`fromAsset refuses ${what}`, re.test(thrown(() => T.fromAsset(a)) ?? ''), thrown(() => T.fromAsset(a)));
  bad('a non-object', null, /not an object/);
  bad('no tiles array', {}, /no "tiles"/);
  bad('an empty tile list', { tiles: [] }, /no tiles/);
  bad('7 rows', { tiles: [{ rows: new Array(7).fill({ bits: '00' }) }] }, /exactly 8 rows/);
  bad('bits "123"', { tiles: [{ rows: [{ bits: '123' }, ...new Array(7).fill({ bits: '00' })] }] }, /row 0 bits/);
  bad('ink 8', { tiles: [{ rows: [{ bits: '00', ink: 8 }, ...new Array(7).fill({ bits: '00' })] }] }, /ink/);
  bad('paper -1', { tiles: [{ rows: [{ bits: '00', paper: -1 }, ...new Array(7).fill({ bits: '00' })] }] }, /paper/);
  bad('bright 2', { tiles: [{ rows: [{ bits: '00', bright: 2 }, ...new Array(7).fill({ bits: '00' })] }] }, /bright/);
  bad('flags 256', { tiles: [{ rows: new Array(8).fill({ bits: '00' }), flags: 256 }] }, /flags/);
  bad('fg "yes"', { tiles: [{ rows: new Array(8).fill({ bits: '00' }), fg: 'yes' }] }, /fg/);
  bad('129 tiles', { tiles: new Array(129).fill(r('00')) }, /at most 128/);
  ok('128 tiles are read', T.fromAsset({ tiles: new Array(128).fill(r('00')) }).tiles.length === 128);
}

// ── 3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3. Pixels');
const DIAG = ['#.......', '.#......', '..#.....', '...#....', '....#...', '.....#..', '......#.', '.......#'];
{
  const t = T.newTile();
  ok('setPixel returns true when it changes, false when not; getPixel reads it', T.setPixel(t, 2, 3, 1) && !T.setPixel(t, 2, 3, 1) && T.getPixel(t, 2, 3) === 1 && T.getPixel(t, 3, 3) === 0 && t.bits[3] === 0x20);
  ok('MSB is the leftmost pixel: (0,0) = 0x80, (7,0) = 0x01', (() => { const u = T.newTile(); T.setPixel(u, 0, 0, 1); T.setPixel(u, 7, 1, 1); return u.bits[0] === 0x80 && u.bits[1] === 0x01; })());
  ok('clearing a pixel', T.setPixel(t, 2, 3, 0) && t.bits[3] === 0);
  ok('out of range: setPixel false, getPixel 0, nothing changes', !T.setPixel(t, 8, 0, 1) && !T.setPixel(t, -1, 0, 1) && !T.setPixel(t, 0, 8, 1) && T.getPixel(t, 9, 9) === 0 && hex(t.bits) === '00 00 00 00 00 00 00 00');
}
{
  const box = () => art(['########', '#......#', '#......#', '#......#', '#......#', '#......#', '#......#', '########']);
  const t = box();
  ok('the box is FF 81 81 81 81 81 81 FF', hex(t.bits) === 'FF 81 81 81 81 81 81 FF');
  ok('fill inside the box with ink: 36 pixels, all FF', T.fill(t, 3, 3, 1) === 36 && hex(t.bits) === 'FF FF FF FF FF FF FF FF');
  const u = box();
  ok('fill the outline with paper: 28 pixels, the inside stays', T.fill(u, 0, 0, 0) === 28 && hex(u.bits) === '00 00 00 00 00 00 00 00');
  const w = box();
  ok('fill with the value already there changes nothing (0)', T.fill(w, 3, 3, 0) === 0 && T.fill(w, 0, 0, 1) === 0 && hex(w.bits) === 'FF 81 81 81 81 81 81 FF');
  const d = art(DIAG);
  ok('flood fill is 4-connected: the ink diagonal pixel (0,0) alone is one pixel', T.fill(d, 0, 0, 0) === 1 && d.bits[0] === 0);
  const e = art(DIAG);
  ok('the diagonal splits the paper into two triangles of 28: fill (7,0) leaves the lower one', T.fill(e, 7, 0, 1) === 28 && hex(e.bits) === 'FF 7F 3F 1F 0F 07 03 01');
  ok('fill outside the tile does nothing', T.fill(e, 8, 8, 1) === 0);
}
{
  const t = T.newTile();
  ok('line is sprite-model\'s own function', T.line === S.line);
  ok('drawLine(0,0 -> 7,7) is the diagonal (8 pixels)', T.drawLine(t, 0, 0, 7, 7, 1) === 8 && hex(t.bits) === '80 40 20 10 08 04 02 01');
  const u = T.newTile();
  ok('drawLine along the top row: FF 00 ...', T.drawLine(u, 0, 0, 7, 0, 1) === 8 && hex(u.bits) === 'FF 00 00 00 00 00 00 00');
  ok('a line is clipped to the tile: (-3,0)-(3,0) sets x 0..3 (4 pixels), same as sprite-model\'s pixel list', (() => { const v = T.newTile(); const n = T.drawLine(v, -3, 0, 3, 0, 1); return n === 4 && v.bits[0] === 0xF0 && S.line(-3, 0, 3, 0).length === 7; })());
  ok('drawLine with 0 erases', T.drawLine(t, 0, 0, 7, 7, 0) === 8 && hex(t.bits) === '00 00 00 00 00 00 00 00');
  const v = T.newTile(); T.drawLine(v, 0, 0, 7, 3, 1);
  ok('a shallow line (0,0)-(7,3) follows sprite-model\'s pixels exactly', S.line(0, 0, 7, 3).every(([x, y]) => T.getPixel(v, x, y) === 1) && S.line(0, 0, 7, 3).length === 8);
}
{
  const t = art(['########', '.......#', '........', '#.......', '........', '........', '........', '........']);   // FF 01 00 80 00 00 00 00
  ok('clearTile makes all paper', (() => { const u = T.cloneTile(t); T.clearTile(u); return hex(u.bits) === '00 00 00 00 00 00 00 00'; })());
  ok('invertTile: FF 01 00 80 .. -> 00 FE FF 7F FF FF FF FF', (() => { const u = T.cloneTile(t); T.invertTile(u); return hex(u.bits) === '00 FE FF 7F FF FF FF FF'; })());
  ok('flipH reverses each row: FF 80 00 01 00 ...', (() => { const u = T.cloneTile(t); T.flipH(u); return hex(u.bits) === 'FF 80 00 01 00 00 00 00'; })());
  ok('flipV reverses the rows: 00 00 00 00 80 00 01 FF', (() => { const u = T.cloneTile(t); T.flipV(u); return hex(u.bits) === '00 00 00 00 80 00 01 FF'; })());
  ok('flips leave the colours alone', (() => { const u = art(DIAG, { ink: 3, paper: 5, bright: 1 }); T.flipH(u); T.flipV(u); return u.ink === 3 && u.paper === 5 && u.bright === 1; })());
  const bar = art(['####....', '........', '........', '........', '........', '........', '........', '........']);   // F0 at row 0
  ok('rotate90 clockwise: the top-left bar becomes the right-hand column rows 0..3 (01 01 01 01 00 ...)', (() => { const u = T.cloneTile(bar); T.rotate90(u, true); return hex(u.bits) === '01 01 01 01 00 00 00 00'; })());
  ok('rotate90 counter-clockwise: the bar becomes the left-hand column rows 4..7 (00 00 00 00 80 80 80 80)', (() => { const u = T.cloneTile(bar); T.rotate90(u, false); return hex(u.bits) === '00 00 00 00 80 80 80 80'; })());
  ok('rotate90 defaults to clockwise', (() => { const u = T.cloneTile(bar); T.rotate90(u); return hex(u.bits) === '01 01 01 01 00 00 00 00'; })());
  const asym = art(['##......', '#.......', '........', '........', '........', '........', '........', '.......#']);   // C0 80 .. 01
  ok('rotate90 cw of a corner piece: 00 00 00 00 00 00 01 ... computed by hand', (() => {
    // pixels (0,0) (1,0) (0,1) (7,7); cw: (x,y) -> (7-y, x): (7,0) (7,1) (6,0) (0,7)
    const u = T.cloneTile(asym); T.rotate90(u, true);
    return hex(u.bits) === '03 01 00 00 00 00 00 80';
  })());
  const seq = art(['#.......', '.#......', '..#.....', '...#....', '....#...', '.....#..', '......#.', '.......#']);
  seq.bits = [1, 2, 3, 4, 5, 6, 7, 8];
  ok('shift down 1 with wrap: the last row comes round to the top', (() => { const u = T.cloneTile(seq); T.shift(u, 0, 1, true); return hex(u.bits) === '08 01 02 03 04 05 06 07'; })());
  ok('shift up 1 with wrap: the top row goes to the bottom', (() => { const u = T.cloneTile(seq); T.shift(u, 0, -1, true); return hex(u.bits) === '02 03 04 05 06 07 08 01'; })());
  ok('shift down 1 without wrap: a blank row comes in', (() => { const u = T.cloneTile(seq); T.shift(u, 0, 1, false); return hex(u.bits) === '00 01 02 03 04 05 06 07'; })());
  ok('shift up 2 without wrap', (() => { const u = T.cloneTile(seq); T.shift(u, 0, -2, false); return hex(u.bits) === '03 04 05 06 07 08 00 00'; })());
  const h = art(['####....', '#......#', '........', '........', '........', '........', '........', '........']);    // F0 81
  ok('shift right 1 with wrap: F0 -> 78, 81 -> C0', (() => { const u = T.cloneTile(h); T.shift(u, 1, 0, true); return u.bits[0] === 0x78 && u.bits[1] === 0xC0; })());
  ok('shift left 1 with wrap: F0 -> E1, 81 -> 03', (() => { const u = T.cloneTile(h); T.shift(u, -1, 0, true); return u.bits[0] === 0xE1 && u.bits[1] === 0x03; })());
  ok('shift right 1 without wrap: F0 -> 78, 81 -> 40', (() => { const u = T.cloneTile(h); T.shift(u, 1, 0, false); return u.bits[0] === 0x78 && u.bits[1] === 0x40; })());
  ok('shift left 1 without wrap: F0 -> E0, 81 -> 02', (() => { const u = T.cloneTile(h); T.shift(u, -1, 0, false); return u.bits[0] === 0xE0 && u.bits[1] === 0x02; })());
  ok('shift 4 right with wrap swaps the nibbles (0x12 -> 0x21); 8 is the identity; -1 equals 7', (() => {
    const u = T.newTile(); u.bits = [0x12, 0x34, 0, 0, 0, 0, 0, 0x81];
    const a = T.cloneTile(u); T.shift(a, 4, 0); const b = T.cloneTile(u); T.shift(b, 8, 0); const c = T.cloneTile(u); T.shift(c, -1, 0); const d = T.cloneTile(u); T.shift(d, 7, 0);
    return hex(a.bits) === '21 43 00 00 00 00 00 18' && same(b.bits, u.bits) && same(c.bits, d.bits);
  })());
  ok('shift wraps by default (the contract\'s tile tool) and moves both axes: dx 1, dy 1', (() => { const u = T.newTile(); u.bits = [0, 0, 0, 0, 0, 0, 0, 0x01]; T.shift(u, 1, 1); return hex(u.bits) === '80 00 00 00 00 00 00 00'; })());
}

// ── 4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4. Colours, flags, fg, summary');
{
  const t = T.newTile();
  ok('setColours patches ink / paper / bright and returns true', T.setColours(t, { ink: 4 }) && T.setColours(t, { paper: 2, bright: 1 }) && t.ink === 4 && t.paper === 2 && t.bright === 1);
  ok('setColours refuses out-of-range values and changes nothing', !T.setColours(t, { ink: 8 }) && !T.setColours(t, { paper: -1 }) && !T.setColours(t, { bright: 2 }) && !T.setColours(t, { ink: 1.5 }) && t.ink === 4 && t.paper === 2 && t.bright === 1);
  ok('attrByte = bright<<6 | paper<<3 | ink: ink 4 paper 2 bright 1 = 64 + 16 + 4 = 84', T.attrByte(t) === 84);
  ok('attrByte of the defaults (ink 0 paper 7) = 56; of ink 7 paper 0 bright 1 = 71', T.attrByte(T.newTile()) === 56 && T.attrByte(T.newTile({ ink: 7, paper: 0, bright: 1 })) === 71);
  ok('setFlag sets and clears single bits: solid 1, hazard 2, pickup 4, bit 3 = 8, bit 7 = 128', (() => {
    const u = T.newTile();
    T.setFlag(u, 0, true); const a = u.flags; T.setFlag(u, 1, true); const b = u.flags; T.setFlag(u, 2, true); T.setFlag(u, 3, true); T.setFlag(u, 7, true); const c = u.flags;
    T.setFlag(u, 1, false); const d = u.flags; T.setFlag(u, 7, false);
    return a === 1 && b === 3 && c === 143 && d === 141 && u.flags === 13;
  })());
  ok('setFlag refuses a bit outside 0..7', !T.setFlag(T.newTile(), 8, true) && !T.setFlag(T.newTile(), -1, true));
  ok('setFg toggles the foreground mark; a tile that never had it writes no fg until it is on, and fg:false once it has been on', (() => {
    const u = T.newTile(); const before = 'fg' in T.toAsset({ tiles: [u], tilesKey: 'tiles' }).tiles[0];
    T.setFg(u, true); const on = T.toAsset({ tiles: [u], tilesKey: 'tiles' }).tiles[0].fg; T.setFg(u, false);
    return !before && on === true && T.toAsset({ tiles: [u], tilesKey: 'tiles' }).tiles[0].fg === false && u.fg === false;
  })());
  const p = T.newTile({ ink: 4, paper: 2, bright: 1 }); T.setPixel(p, 0, 0, 1); T.setPixel(p, 7, 7, 1);
  const px = T.tilePixels(p);
  ok('tilePixels: 64 colour keys; ink 4 bright = 12, paper 2 bright = 10', px.length === 64 && px[0] === 12 && px[63] === 12 && px[1] === 10 && px.filter((k) => k === 12).length === 2 && px.filter((k) => k === 10).length === 62);
  ok('tilePixels: black is key 0 in both brightnesses', (() => { const u = T.newTile({ ink: 0, paper: 0, bright: 1 }); return T.tilePixels(u).every((k) => k === 0); })());
  ok('keyRGB (re-exported) turns a key into the TS2068 colour: key 12 is bright green', same(T.keyRGB(12), [51, 255, 59]) && T.PALETTE === S.PALETTE);
  ok('tileIsBlank: true for a new tile, false after one pixel, colours do not matter', T.tileIsBlank(T.newTile({ ink: 1, paper: 3 })) && !T.tileIsBlank(art(['.......#', '', '', '', '', '', '', ''].map((r) => r.padEnd(8, '.')))));
  ok('tileUsesBlack: ink 0 paper 7 blank = no; with a pixel = yes; ink 7 paper 0 blank = yes; all ink = no; paper 0 ink 0 = yes', (() => {
    const a = T.newTile(), b = T.newTile(); T.setPixel(b, 4, 4, 1);
    const c = T.newTile({ ink: 7, paper: 0 }), d = T.newTile({ ink: 7, paper: 0 }); d.bits.fill(255);
    const e = T.newTile({ ink: 3, paper: 5 });
    return !T.tileUsesBlack(a) && T.tileUsesBlack(b) && T.tileUsesBlack(c) && !T.tileUsesBlack(d) && !T.tileUsesBlack(e);
  })());
  const sum = (() => { const u = T.newTile({ ink: 4, paper: 2, bright: 1 }); T.setFlag(u, 0, true); T.setFlag(u, 2, true); T.setFg(u, true); T.setPixel(u, 1, 1, 1); T.setPixel(u, 2, 2, 1); return T.tileSummary(u, 5); })();
  ok('tileSummary: pixel count, attribute, flag names, fg, text', sum.pixels === 2 && !sum.blank && sum.attr === 84 && same(sum.flagNames, ['solid', 'pickup']) && sum.fg === true && /^tile 5: ink green, paper red, bright; 2 pixels; solid \+ pickup; foreground/.test(sum.text), sum.text);
  ok('tileSummary of a blank tile says blank', (() => { const s = T.tileSummary(T.newTile()); return s.blank && s.pixels === 0 && /blank/.test(s.text) && !/foreground/.test(s.text); })());
}

// ── 5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n5. Set operations');
{
  const s = T.newTileset();
  T.setColours(s.tiles[0], { ink: 0, paper: 5, bright: 1 });
  T.setPixel(s.tiles[0], 1, 1, 1); T.setFlag(s.tiles[0], 0, true); T.setFg(s.tiles[0], true);
  const i1 = T.addTile(s, { like: 0 });
  ok('addTile appends a BLANK tile with the colours of tile `like`, no flags, no fg; returns its index', i1 === 1 && s.tiles.length === 2 && T.tileIsBlank(s.tiles[1]) && s.tiles[1].paper === 5 && s.tiles[1].bright === 1 && s.tiles[1].flags === 0 && s.tiles[1].fg === false);
  const i2 = T.addTile(s);
  ok('addTile without `like` makes the default sky colours (ink 0 paper 7 bright 0)', i2 === 2 && s.tiles[2].ink === 0 && s.tiles[2].paper === 7 && s.tiles[2].bright === 0);
  const i3 = T.duplicateTile(s, 0);
  ok('duplicateTile appends an exact copy (pixels, colours, flags, fg); indices 0..2 do not move', i3 === 3 && same(s.tiles[3], s.tiles[0]) && s.tiles[3] !== s.tiles[0] && s.tiles[1].paper === 5);
  T.setPixel(s.tiles[3], 5, 5, 1);
  ok('the copy is independent', T.getPixel(s.tiles[0], 5, 5) === 0);
  const src = art(DIAG, { ink: 6, paper: 1, bright: 1 }); src.flags = 4;
  ok('pasteTile overwrites tile 2 with a copy (bitmap, colours, flags) and nothing else moves', T.pasteTile(s, 2, src) && hex(s.tiles[2].bits) === '80 40 20 10 08 04 02 01' && s.tiles[2].ink === 6 && s.tiles[2].flags === 4 && s.tiles[2] !== src && s.tiles.length === 4 && s.tiles[3].bits[5] === 0x04);
  ok('pasteTile onto a tile that does not exist throws RangeError', /no tile 9/.test(thrown(() => T.pasteTile(s, 9, src)) ?? ''));
  ok('duplicateTile of a missing tile throws', /no tile 7/.test(thrown(() => T.duplicateTile(s, 7)) ?? ''));
  const before = JSON.stringify(s);
  const r0 = T.deleteLastTile(s, 0, 1);
  ok('delete refuses a tile that is not the last, and says why', !r0.ok && /Only the last tile \(3\)/.test(r0.message) && JSON.stringify(s) === before, r0.message);
  const r1 = T.deleteLastTile(s, 12);
  ok('delete refuses while 12 map cells use the last tile, and says how many', !r1.ok && /Tile 3 is used by 12 map cells/.test(r1.message) && JSON.stringify(s) === before, r1.message);
  const r1b = T.deleteLastTile(s, 1);
  ok('... singular for one cell', !r1b.ok && /1 map cell;/.test(r1b.message), r1b.message);
  const r1c = T.deleteLastTile(s, [{ name: 'level1', cells: 7 }, { name: 'level2', cells: 5 }, { name: 'title', cells: 0 }]);
  ok('... a list of maps is named, with the total; maps using no cell are left out', !r1c.ok && /12 map cells \(level1: 7, level2: 5\)/.test(r1c.message) && JSON.stringify(s) === before, r1c.message);
  const r2 = T.deleteLastTile(s, 0);
  ok('delete works for the last tile when no cell uses it: {ok, index 3}, 3 tiles left', r2.ok && r2.index === 3 && s.tiles.length === 3);
  ok('delete with an empty usage list also works (the map list is empty)', T.deleteLastTile(s, []).ok && s.tiles.length === 2);
  const one = T.newTileset();
  const r3 = T.deleteLastTile(one, 0);
  ok('the only tile cannot be deleted', !r3.ok && /at least one tile/.test(r3.message) && one.tiles.length === 1, r3.message);
  const big = T.newTileset();
  while (big.tiles.length < 128) T.addTile(big);
  ok('a set of 128 tiles is valid', big.tiles.length === 128 && T.validateTileset(big) === null);
  ok('addTile refuses the 129th tile (RangeError)', /at most 128/.test(thrown(() => T.addTile(big)) ?? '') && big.tiles.length === 128);
  ok('duplicateTile refuses the 129th tile', /at most 128/.test(thrown(() => T.duplicateTile(big, 0)) ?? '') && big.tiles.length === 128);
  ok('a set of 128 tiles round-trips and the compiler takes it', same(T.toAsset(T.fromAsset(T.toAsset(big))), T.toAsset(big)) && convertTileset(T.toAsset(big)).count === 128);
  ok('delete at 128 takes it to 127 (after which add works again)', T.deleteLastTile(big, 0).ok && big.tiles.length === 127 && T.addTile(big) === 127);
}

// ── 6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n6. Validation against arcade-project and the compiler');
{
  ok('validateTileset accepts a new set and the example sets', T.validateTileset(T.newTileset()) === null && Object.values(exAssets).every((a) => Object.values(a.tilesets ?? {}).every((ts) => T.validateAsset(ts) === null)));
  const bad = (what, mutate, re) => { const s = T.newTileset(); mutate(s); const m = T.validateTileset(s); ok(`validateTileset refuses ${what}`, m !== null && re.test(m), String(m)); };
  bad('no tiles', (s) => { s.tiles = []; }, /no tiles/);
  bad('129 tiles', (s) => { s.tiles = new Array(129).fill(0).map(() => T.newTile()); }, /at most 128/);
  bad('7 rows', (s) => { s.tiles[0].bits.pop(); }, /8 rows/);
  bad('a row value 256', (s) => { s.tiles[0].bits[2] = 256; }, /0\.\.255/);
  bad('a fractional row value', (s) => { s.tiles[0].bits[2] = 1.5; }, /0\.\.255/);
  bad('ink 8', (s) => { s.tiles[0].ink = 8; }, /ink/);
  bad('paper -1', (s) => { s.tiles[0].paper = -1; }, /paper/);
  bad('bright 2', (s) => { s.tiles[0].bright = 2; }, /bright/);
  bad('flags 300', (s) => { s.tiles[0].flags = 300; }, /flags/);
  bad('fg 1', (s) => { s.tiles[0].fg = 1; }, /fg/);
  bad('a non-object set', (s) => { s.tiles = null; }, /list of tiles/);
  // consistency with validateAsset('tilesets', ...) of src/arcade-project.js, and with the compiler, on random stored assets
  const r = rng(77);
  const pick = (a) => a[Math.floor(r() * a.length)];
  const mutate = (a) => {
    const t = pick(a.tiles), row = pick(t.rows);
    switch (Math.floor(r() * 14)) {
      case 0: row.bits = pick(['', '123', 'GG', 256, -1, 1.5, null, 'F', 'ff', 7, '0']); break;
      case 1: row.ink = pick([8, -1, 2.5, '3', null, 0, 7]); break;
      case 2: row.paper = pick([8, -1, 'x', null, 7]); break;
      case 3: row.bright = pick([2, true, false, '1', null, 1]); break;
      case 4: t.flags = pick([256, -1, 1.5, '1', null, 255, 0]); break;
      case 5: t.fg = pick([true, false, 1, 'x']); break;
      case 6: t.rows = t.rows.slice(0, pick([0, 3, 7])); break;
      case 7: t.rows = [...t.rows, row]; break;
      case 8: a.tiles = pick([[], null, {}, 'x']); break;
      case 9: a.tiles.push(...new Array(pick([1, 50, 130])).fill(0).map(() => JSON.parse(JSON.stringify(t)))); break;
      case 10: delete row.bits; break;
      case 11: a.tiles[a.tiles.length - 1] = pick([null, 5, 'x', []]); break;
      case 12: t.extra = { any: 1 }; row.mask = 'FF'; break;
      default: break;
    }
  };
  let n = 0, agree = 0, mineOnly = 0, theirsOnlyRefusal = 0, compilerBroke = 0;
  const reasons = new Set();
  const N = QUICK ? 400 : 2500;
  for (let i = 0; i < N; i++) {
    const a = JSON.parse(JSON.stringify(exAssets[pick(['blockfall', 'breakout', 'platformer', 'shooter', 'vaults'])].tilesets));
    const asset = a[Object.keys(a)[0]];
    const k = 1 + Math.floor(r() * 3);
    for (let j = 0; j < k; j++) { try { mutate(asset); } catch { /* a mutation of a broken asset */ } }
    n++;
    const mine = T.validateAsset(asset), theirs = P.validateAsset('tilesets', asset);
    if (mine === null) {
      if (theirs !== null) theirsOnlyRefusal++;
      let compiled = true;
      try { convertTileset(asset); } catch { compiled = false; }
      if (!compiled) compilerBroke++;
    }
    if ((mine === null) === (theirs === null)) agree++;
    else if (theirs === null) { mineOnly++; reasons.add(mine.replace(/\d+/g, 'N')); }
  }
  ok(`${n} random stored tile sets: when validateAsset (tile-model) says fine, arcade-project's validateAsset says fine and convertTileset takes it`, theirsOnlyRefusal === 0 && compilerBroke === 0, `${theirsOnlyRefusal} / ${compilerBroke} violations`);
  ok(`... and where the model is stricter it is only for the documented reasons (>128 tiles, flags, fg, unreadable pixel values arcade-project does not look at): ${[...reasons].join(' | ') || 'none'}`,
    [...reasons].every((m) => /at most N|flags|fg must|row N bits|tile N needs exactly 8|is not an object|no tiles/.test(m)), `${mineOnly} of ${n} differ, ${agree} agree`);
}

// ── 7 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n7. Fuzz: identities of the operations');
{
  const r = rng(2026);
  const rnd = () => { const t = T.newTile({ ink: Math.floor(r() * 8), paper: Math.floor(r() * 8), bright: r() < 0.5 ? 1 : 0 }); t.bits = t.bits.map(() => Math.floor(r() * 256)); return t; };
  const pop = (t) => t.bits.reduce((n, b) => { let c = 0; for (let v = b; v; v &= v - 1) c++; return n + c; }, 0);
  const N = QUICK ? 150 : 600;
  let bad = null;
  for (let i = 0; i < N && !bad; i++) {
    const t = rnd(), o = T.cloneTile(t);
    const run = (fn, times = 1) => { const u = T.cloneTile(t); for (let k = 0; k < times; k++) fn(u); return u; };
    if (!same(run(T.flipH, 2).bits, o.bits)) bad = 'flipH twice';
    else if (!same(run(T.flipV, 2).bits, o.bits)) bad = 'flipV twice';
    else if (!same(run((u) => T.rotate90(u, true), 4).bits, o.bits)) bad = 'rotate cw x4';
    else if (!same(run((u) => { T.rotate90(u, true); T.rotate90(u, false); }).bits, o.bits)) bad = 'rotate cw + ccw';
    else if (!same(run((u) => { T.rotate90(u, true); T.rotate90(u, true); }).bits, run((u) => { T.flipH(u); T.flipV(u); }).bits)) bad = 'rotate 180 = flipH + flipV';
    else if (!same(run(T.invertTile, 2).bits, o.bits)) bad = 'invert twice';
    else if (pop(run(T.invertTile)) !== 64 - pop(o)) bad = 'invert pop';
    else if (pop(run(T.flipH)) !== pop(o) || pop(run((u) => T.rotate90(u))) !== pop(o)) bad = 'pop preserved';
    else {
      const dx = Math.floor(r() * 17) - 8, dy = Math.floor(r() * 17) - 8;
      const u = T.cloneTile(t); T.shift(u, dx, dy, true); const wrapPop = pop(u); T.shift(u, -dx, -dy, true);
      if (!same(u.bits, o.bits) || wrapPop !== pop(o)) bad = `shift ${dx},${dy} wrap and back`;
      const v = T.cloneTile(t); T.shift(v, dx, dy, false);
      if (pop(v) > pop(o)) bad = `shift ${dx},${dy} no wrap adds pixels`;
    }
    for (const op of [T.flipH, T.flipV, T.invertTile, (u) => T.rotate90(u), (u) => T.shift(u, 3, -2), T.clearTile, (u) => T.fill(u, 3, 3, 1), (u) => T.drawLine(u, 0, 7, 7, 0, 1)]) {
      const u = T.cloneTile(t); op(u);
      if (!(u.bits.length === 8 && u.bits.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) && !bad) bad = 'bits left the 0..255 range';
      if ((u.ink !== t.ink || u.paper !== t.paper || u.bright !== t.bright || u.flags !== t.flags) && !bad) bad = 'an operation changed colours or flags';
    }
  }
  ok(`${N} random tiles: flips, rotations, invert and wrapped shifts obey their identities; bits stay 0..255; colours and flags are untouched`, bad === null, bad ?? '');
  // fill vs a plain reference: the filled region is exactly the 4-connected component
  let fbad = 0;
  for (let i = 0; i < (QUICK ? 100 : 400); i++) {
    const t = rnd(), x = Math.floor(r() * 8), y = Math.floor(r() * 8), v = r() < 0.5 ? 1 : 0;
    const comp = new Set(), stack = [[x, y]], target = T.getPixel(t, x, y);
    while (stack.length) { const [a, b] = stack.pop(); const key = b * 8 + a; if (a < 0 || b < 0 || a > 7 || b > 7 || comp.has(key) || T.getPixel(t, a, b) !== target) continue; comp.add(key); stack.push([a + 1, b], [a - 1, b], [a, b + 1], [a, b - 1]); }
    const u = T.cloneTile(t), n = T.fill(u, x, y, v);
    let good = n === (v === target ? 0 : comp.size);
    for (let yy = 0; yy < 8; yy++) for (let xx = 0; xx < 8; xx++) good = good && T.getPixel(u, xx, yy) === (comp.has(yy * 8 + xx) ? v : T.getPixel(t, xx, yy));
    if (!good) fbad++;
  }
  ok('fill agrees with a reference 4-connected flood on random tiles', fbad === 0, `${fbad} differ`);
  // anything the model writes is something the compiler accepts, with the bytes the model says
  let cbad = 0;
  for (let i = 0; i < (QUICK ? 40 : 150); i++) {
    const s = T.newTileset(); const count = 1 + Math.floor(r() * 20);
    for (let k = 1; k < count; k++) T.addTile(s, { like: Math.floor(r() * k) });
    s.tiles.forEach((t) => { t.bits = t.bits.map(() => Math.floor(r() * 256)); T.setColours(t, { ink: Math.floor(r() * 8), paper: Math.floor(r() * 8), bright: r() < 0.5 ? 1 : 0 }); t.flags = Math.floor(r() * 256); });
    const a = JSON.parse(JSON.stringify(T.toAsset(s)));
    let conv; try { conv = convertTileset(a); } catch { cbad++; continue; }
    const back = T.fromAsset(a);
    if (!same(back.tiles.map((t) => t.bits), s.tiles.map((t) => t.bits)) || !s.tiles.every((t, k) => conv.bytes[k * 9 + 8] === T.attrByte(t) && conv.flags[k] === t.flags && hex(t.bits) === [...conv.bytes.slice(k * 9, k * 9 + 8)].map((b) => b.toString(16).toUpperCase().padStart(2, '0')).join(' '))) cbad++;
  }
  ok('random sets written with toAsset are accepted by convertTileset and give the bitmap, attribute and flags the model holds', cbad === 0, `${cbad} differ`);
}

// ── 8 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n8. Undo / redo (sprite-model\'s createHistory)');
{
  ok('createHistory is the same function', T.createHistory === S.createHistory);
  const s = T.newTileset();
  const h = T.createHistory(s);
  ok('nothing to undo at the start', !h.canUndo && !h.canRedo && h.undo() === null);
  T.setPixel(s.tiles[0], 0, 0, 1);
  ok('commit records a change (true) and ignores an identical state (false)', h.commit(s) === true && h.commit(s) === false);
  T.addTile(s, { like: 0 }); T.setFlag(s.tiles[1], 1, true); T.setFg(s.tiles[1], true);
  h.commit(s);
  const u = h.undo();
  ok('undo returns the previous set: 2 -> 1 tile, pixel kept', u.tiles.length === 1 && u.tiles[0].bits[0] === 0x80 && h.canRedo);
  const u2 = h.undo();
  ok('undo again: back to the blank set', u2.tiles[0].bits[0] === 0 && !h.canUndo);
  const rd = h.redo(); h.redo();
  ok('redo twice restores the final set including flags, fg and the tile count (JSON-safe snapshots)', h.current.tiles.length === 2 && h.current.tiles[1].flags === 2 && h.current.tiles[1].fg === true && same(T.toAsset(h.current), T.toAsset(s)) && rd.tiles.length === 1);
  ok('undo depth is bounded by the history limit (createHistory keeps 200 snapshots: 199 undo steps; 201 gives the contract\'s 200 steps)', (() => {
    const run = (lim) => { const q = T.newTileset(), hh = T.createHistory(q, lim); for (let i = 0; i < 250; i++) { q.tiles[0].bits[i % 8] ^= (1 << (i % 7)); hh.commit(q); } return hh.depth.undo; };
    return run(200) === 199 && run(201) === 200;
  })());
}

// ── C ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\nC. The real compiler: byte-identical cartridges from assets written back through the model');
{
  const dist = join(ROOT, 'arcade/dist/');
  if (!existsSync(dist + 'v2/runtime.json') || !existsSync(dist + 'v3/runtime.json') || !existsSync(dist + 'v4/runtime.json')) {
    console.log('  (skipped: arcade/dist runtimes not found)');
  } else {
    const builds = {};
    for (const v of [2, 3, 4]) builds[v] = { runtime: JSON.parse(readFileSync(dist + `v${v}/runtime.json`, 'utf8')), image: new Uint8Array(readFileSync(dist + `v${v}/runtime.bin`)) };
    const build = (id, assets) => {
      const text = readFileSync(join(ROOT, `arcade/examples/${id}.arc`), 'utf8');
      const b = builds[requiredRuntime(text, assets).version];
      return compile(text, { runtime: b.runtime, image: b.image, assets });
    };
    const rewrite = (assets) => {
      const out = JSON.parse(JSON.stringify(assets));
      for (const name of Object.keys(out.tilesets ?? {})) out.tilesets[name] = JSON.parse(JSON.stringify(T.toAsset(T.fromAsset(out.tilesets[name]))));
      return out;
    };
    let withSets = 0;
    for (const id of EXAMPLES) {
      if (!existsSync(join(ROOT, `arcade/examples/${id}.arc`))) continue;
      const assets = exAssets[id];
      const nSets = Object.keys(assets.tilesets ?? {}).length;
      if (!nSets) continue;
      withSets++;
      const a = build(id, assets), a2 = build(id, assets), b = build(id, rewrite(assets));
      ok(`${id}: ${nSets} tile set${nSets === 1 ? '' : 's'} written back through the model: the DCK is byte-identical (${a.dck?.length} bytes), and the build is deterministic`,
        a.errors.length === 0 && b.errors.length === 0 && !!a.dck && Buffer.compare(Buffer.from(a.dck), Buffer.from(a2.dck)) === 0 && Buffer.compare(Buffer.from(a.dck), Buffer.from(b.dck)) === 0 && same(a.warnings.map((w) => w.message), b.warnings.map((w) => w.message)),
        a.errors.concat(b.errors).map((e) => e.message).join('; '));
    }
    ok('all five example projects with tile sets were built', withSets === 5, `${withSets}`);
    // the model reduces odd stored forms to what the compiler reads, so the cartridge does not change
    {
      const odd = JSON.parse(JSON.stringify(exAssets.platformer));
      const set = odd.tilesets.pf_tiles;
      set.tiles[5].rows.forEach((r, y) => { if (y) { r.ink = (r.ink + y) % 8; r.paper = (r.paper + 3) % 8; r.bright ^= 1; } });
      set.tiles[6].rows.forEach((r) => { r.bits = r.bits.toLowerCase(); });
      const a = build('platformer', odd), b = build('platformer', rewrite(odd)), c = build('platformer', exAssets.platformer);
      ok('platformer with rows 1..7 of a tile in other colours (ignored by the compiler) and lower-case hex: the model reduces them and the DCK is unchanged', !a.errors.length && Buffer.compare(Buffer.from(a.dck), Buffer.from(b.dck)) === 0 && Buffer.compare(Buffer.from(a.dck), Buffer.from(c.dck)) === 0 && T.rowsDiffer(set).includes(5));
    }
    // and an edit through the model does change the cartridge (so the comparison above can fail)
    {
      const edited = JSON.parse(JSON.stringify(exAssets.platformer));
      const m = T.fromAsset(edited.tilesets.pf_tiles);
      T.setPixel(m.tiles[3], 0, 7, T.getPixel(m.tiles[3], 0, 7) ? 0 : 1);
      edited.tilesets.pf_tiles = T.toAsset(m);
      const a = build('platformer', exAssets.platformer), b = build('platformer', edited);
      ok('an edited pixel changes the DCK (the check can fail)', !b.errors.length && Buffer.compare(Buffer.from(a.dck), Buffer.from(b.dck)) !== 0);
      const m2 = T.fromAsset(exAssets.platformer.tilesets.pf_tiles);
      T.setFg(m2.tiles[1], true); m2.extra = { note: 'x' };
      const withFg = JSON.parse(JSON.stringify(exAssets.platformer)); withFg.tilesets.pf_tiles = T.toAsset(m2);
      const c = build('platformer', withFg);
      ok('the authoring-only fg flag and unknown keys do not change the DCK (the compiler ignores them)', !c.errors.length && Buffer.compare(Buffer.from(a.dck), Buffer.from(c.dck)) === 0);
    }
  }
}

console.log(`\n${failed === 0 ? 'All' : 'Some'} checks done: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
