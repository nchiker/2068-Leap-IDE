#!/usr/bin/env node
"use strict";
// blockfall.assets.gen.mjs -- draws the art and sounds of blockfall.arc and writes blockfall.assets.json next to this file.
//   node arcade/examples/blockfall.assets.gen.mjs
// Blockfall has no sprites: the whole game is tiles and text. The tileset (12 tiles, indices used by blockfall.arc):
//   0 empty well cell (a dim grid dot)   1..7 the seven block colours (I O T S Z J L)   8 flash (a line being cleared)
//   9 frame brick   10 dimmed block (game over)   11 blank black (next-piece box)
// A tile's colours come from its first row (ink, paper, bright), as in docs/ARCADE_ASSETS.md; a block has a black outline (ink 0)
// round a coloured inside (paper = the piece colour).
// The piece masks of the game itself (4 rotations of 7 pieces as 16-bit masks of a 4 x 4 box) are printed with --masks, so that the
// numbers in blockfall.arc can be checked against the drawings.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pattern, song, describe } from './songs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── the seven pieces, rotation 0, drawn in a box of 3 x 3 (4 x 4 for the I piece); '#' = a block ───────────────────────────────
export const PIECES = [
  { name: 'I', n: 4, art: ['....', '####', '....', '....'], paper: 5 },
  { name: 'O', n: 4, art: ['.##.', '.##.', '....', '....'], paper: 6, fixed: true },
  { name: 'T', n: 3, art: ['.#.', '###', '...'], paper: 3 },
  { name: 'S', n: 3, art: ['.##', '##.', '...'], paper: 4 },
  { name: 'Z', n: 3, art: ['##.', '.##', '...'], paper: 2 },
  { name: 'J', n: 3, art: ['#..', '###', '...'], paper: 1 },
  { name: 'L', n: 3, art: ['..#', '###', '...'], paper: 7 },
];
/** cells [{x, y}] of a piece in rotation r (clockwise quarter turns inside its box; the O piece does not move) */
export function cellsOf(p, r) {
  let cells = [];
  p.art.forEach((row, y) => [...row].forEach((ch, x) => { if (ch === '#') cells.push({ x, y }); }));
  if (p.fixed) return cells;
  for (let k = 0; k < r; k++) cells = cells.map(({ x, y }) => ({ x: p.n - 1 - y, y: x }));      // (x, y) -> (n - 1 - y, x)
  return cells;
}
/** bit (y * 4 + x) of a 16-bit mask per cell */
export const maskOf = (cells) => cells.reduce((m, { x, y }) => m | (1 << (y * 4 + x)), 0);
export const MASKS = PIECES.map((p) => [0, 1, 2, 3].map((r) => maskOf(cellsOf(p, r))));

const MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;      // false when a test imports PIECES / cellsOf / MASKS
if (MAIN && process.argv.includes('--masks')) {
  PIECES.forEach((p, i) => {
    console.log(`REM ${p.name}: ${MASKS[i].join(', ')}`);
    for (let r = 0; r < 4; r++) {
      const c = cellsOf(p, r);
      const rows = [0, 1, 2, 3].map((y) => [0, 1, 2, 3].map((x) => (c.some((q) => q.x === x && q.y === y) ? '#' : '.')).join(''));
      console.log(`  rot ${r} = ${MASKS[i][r]}   ${rows.join(' / ')}`);
    }
  });
  process.exit(0);
}

const tile = (bytes, ink, paper, bright) => ({ rows: bytes.map((b) => ({ bits: b.toString(16).toUpperCase().padStart(2, '0'), ink, paper, bright })), flags: 0 });
const BLOCK = [0xFF, 0x81, 0x81, 0x81, 0x81, 0x81, 0x81, 0xFF];            // black outline, coloured inside
const tiles = [
  tile([0, 0, 0, 0, 0x10, 0, 0, 0], 1, 0, 1),                                // 0 empty well cell: a dark blue dot
  ...PIECES.map((p) => tile(BLOCK, 0, p.paper, 1)),                          // 1..7 blocks (all BRIGHT 1: one black everywhere; the flash tile is a checker, so L stays told apart by its outline)
  tile([0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55], 0, 7, 1),          // 8 flash: bright white checker
  tile([0xFE, 0xFE, 0xFE, 0x00, 0xEF, 0xEF, 0xEF, 0x00], 5, 1, 1),          // 9 frame: cyan bricks on blue
  tile([0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA], 1, 0, 1),          // 10 dimmed block: blue dither (BRIGHT stays 1: bright black and plain black differ on some displays)
  tile([0, 0, 0, 0, 0, 0, 0, 0], 0, 0, 1),                                   // 11 blank (black, bright like the rest)
];

// ── sounds: one record per refresh (60 per second), on one AY channel; mix 6 = tone, 5 = noise, 4 = both ───────────────────────────
const ticks = (n, f) => Array.from({ length: n }, (_, k) => f(k));
const note = (tone, n, vol) => ticks(n, (k) => ({ tone, vol: Math.max(1, vol - (k >> 1)), noise: 0, mix: 6 }));
const sfx = {
  tick: { ticks: note(300, 3, 9) },                                                           // a move or a turn
  lock: { ticks: ticks(5, (k) => ({ tone: 700 + 120 * k, vol: 12 - 2 * k, noise: 12 + 3 * k, mix: 4 })) },   // a piece lands
  clear1: { ticks: [...note(250, 5, 13), ...note(188, 5, 13)] },                              // one line: two notes
  clear2: { ticks: [...note(250, 4, 13), ...note(188, 4, 13), ...note(150, 4, 13)] },         // two lines: three notes up
  clear3: { ticks: [...note(250, 4, 13), ...note(188, 4, 13), ...note(150, 4, 13), ...note(125, 4, 13)] },
  clear4: { ticks: [...note(250, 4, 14), ...note(188, 4, 14), ...note(150, 4, 14), ...note(125, 4, 14), ...note(94, 10, 14), ...ticks(8, (k) => ({ tone: 0, vol: Math.max(1, 12 - k), noise: 4 + 3 * k, mix: 5 }))] },
  lvlup: { ticks: [...note(200, 4, 12), ...note(160, 4, 12), ...note(133, 4, 12), ...note(100, 8, 13)] },   // a level up
  over: { ticks: ticks(36, (k) => ({ tone: 150 + 14 * k, vol: Math.max(2, 13 - (k >> 2)), noise: 0, mix: 6 })) },
};

// ── music: "Stones", the in-game song (docs/ARCADE_MUSIC_CONTRACT.md section 8: the v2 showcase; original music).  A minor, a quaver = 12 refreshes
// (about 150 beats a minute), bars of 96.  Melody on A (organ), bass on B, drums on C: a one-channel effect borrows C, so the drums are the part a move
// or a line clear silences for a moment.  Two sections of eight bars (A minor, then a C major bridge), four patterns of four bars: A1 A2 A1 A2 B1 B2, loop.
const DRUMS = '@drum !9 C2:4 -:20 G5:5 -:19 C2:4 -:20 G5:5 -:19 '.repeat(4);
const music = {
  stones: song([
    pattern({
      A: '@organ !11 L12 | A4:24 E5:24 D5 C5 B4:24 | C5 D5 E5:24 A4:48 | F5:24 E5 D5 C5:24 D5 E5 | B4:72 -:24',
      B: '@bass !12 L24 | A2 E3 A2 E3 | A2 E3 A2 C3 | D3 A2 D3 A2 | E2 B2 E2 G#2',
      C: DRUMS,
    }, 'A1'),
    pattern({
      A: '@organ !11 L12 | C5:24 B4 A4 G4:24 A4 B4 | C5:24 E5:24 G5:24 F5 E5 | D5:24 F5 E5 D5:24 C5 B4 | A4:48 E4:24 -:24',
      B: '@bass !12 L24 | C3 G3 G2 D3 | C3 G3 C3 E3 | D3 A2 E2 B2 | A2 E3 A2 E2',
      C: DRUMS,
    }, 'A2'),
    pattern({
      A: '@organ !11 L12 | E5 F5 G5:24 E5:24 C5:24 | D5 E5 F5:24 D5:48 | C5 D5 E5:24 C5:24 A4:24 | B4:24 G4:24 B4:24 D5:24',
      B: '@bass !12 L24 | C3 G3 C3 G3 | D3 A2 D3 A2 | A2 E3 A2 E3 | G2 D3 G2 B2',
      C: DRUMS,
    }, 'B1'),
    pattern({
      A: '@organ !11 L12 | E5 F5 G5:24 A5:24 G5 F5 | E5:24 C5:24 A4:48 | B4 C5 D5:24 E5:24 G#4:24 | A4:72 -:24',
      B: '@bass !12 L24 | C3 G3 F2 C3 | A2 E3 A2 E3 | E2 B2 E2 G#2 | A2 E3 A2 E2',
      C: DRUMS,
    }, 'B2'),
  ], [0, 1, 0, 1, 2, 3], 0),
};

export const ASSETS = { sprites: {}, tilesets: { gfx: { tiles } }, sfx, music };
if (MAIN) {
  writeFileSync(join(HERE, 'blockfall.assets.json'), JSON.stringify(ASSETS, null, 1) + '\n');
  console.log(`blockfall.assets.json: ${tiles.length} tiles, ${Object.keys(sfx).length} sound effects, no sprites; ${Object.entries(music).map(([k, v]) => describe(k, v)).join('; ')}`);
}
