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
  ...PIECES.map((p) => tile(BLOCK, 0, p.paper, 1)),                          // 1..7 blocks (L is white, not bright: the flash tile is bright)
  tile([0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55], 0, 7, 1),          // 8 flash: bright white checker
  tile([0xFE, 0xFE, 0xFE, 0x00, 0xEF, 0xEF, 0xEF, 0x00], 5, 1, 1),          // 9 frame: cyan bricks on blue
  tile([0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA], 7, 0, 0),          // 10 dimmed block: grey dither
  tile([0, 0, 0, 0, 0, 0, 0, 0], 0, 0, 0),                                   // 11 blank
];
tiles[7].rows.forEach((r) => { r.bright = 0; });                              // L: white, normal brightness

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

export const ASSETS = { sprites: {}, tilesets: { gfx: { tiles } }, sfx };
if (MAIN) {
  writeFileSync(join(HERE, 'blockfall.assets.json'), JSON.stringify(ASSETS, null, 1) + '\n');
  console.log(`blockfall.assets.json: ${tiles.length} tiles, ${Object.keys(sfx).length} sound effects, no sprites`);
}
