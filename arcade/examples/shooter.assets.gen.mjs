#!/usr/bin/env node
"use strict";
// shooter.assets.gen.mjs -- draws the art of shooter.arc and writes shooter.assets.json next to this file.
//   node arcade/examples/shooter.assets.gen.mjs
// The art is ASCII: '#' = a lit pixel (ink), '-' = a covered but unlit pixel (paper: it hides the stars behind the sprite),
// '.' = transparent. The big sprites (16 x 16) and the two small ones (8 x 8) are drawn as the LEFT half and mirrored.
// Format: docs/ARCADE_ASSETS.md (rows with bits / mask in hex, MSB = leftmost pixel; mask 1 = the sprite covers the background;
// `hot` = the collision box [x, y, w, h]; `phases` = pre-shifted horizontal positions (8, 4, 2 or 1), see
// docs/ARCADE_RUNTIME_API_V2.md). Each row also says ink / paper / bright as the Studio would author it; the v2 build takes the
// colour of a sprite from the screen cell under it (all the playfield cells are white on black), so these are for the Studio.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const mirror = (half) => half + [...half].reverse().join('');

const SHIP = ['.......#', '.......#', '......##', '......##', '.....###', '.....##-', '..#..##-', '..#.###-',
  '.##.####', '.####-##', '######-#', '########', '###..###', '##....##', '#......#', '.......#'].map(mirror);
const SCOUT = ['........', '.....###', '...#####', '..######', '.####--#', '###--###', '########', '########',
  '.##.####', '..#..###', '..#...##', '...#..#.', '...#....', '..##....', '........', '........'].map(mirror);
const HEAVY = ['..##....', '..##..##', '..##.###', '..######', '.#######', '#######-', '###--##-', '###-####',
  '########', '########', '#.######', '#..#####', '#..#..##', '##.#...#', '.#.#....', '........'].map(mirror);
const BULLET = ['...#', '...#', '..##', '..##', '..##', '..##', '...#', '....'].map(mirror);
const SHOT = ['....', '..##', '.###', '.###', '.###', '.###', '..##', '....'].map(mirror);

const EXPLOSION = [
  [ // frame 0: a small burst
    '................', '................', '................', '................', '......#..#......', '.......##.......', '.....######.....',
    '....#######.#...', '.....######.....', '......####.#....', '.......##.......', '......#..#......', '................', '................',
    '................', '................'],
  [ // frame 1: the fireball
    '................', '.......#........', '...#...##...#...', '....######.#....', '..#.########....', '...##########.#.', '..############..',
    '.#############..', '..############.#', '.#.##########...', '...##########.#.', '....########....', '..#..######..#..', '.....#.##.......',
    '......#..#......', '................'],
  [ // frame 2: scattering sparks
    '..#.......#.....', '.......#........', '....#.....#..#..', '.#........#.....', '.....#..#.......', '..#...#....#....', '......#.....#...',
    '.#.....#.....#..', '....#.....#.....', '.........#..#...', '..#...#.........', '......#...#...#.', '.#.........#....', '.....#....#.....',
    '...#........#...', '.........#......'],
];
for (const f of EXPLOSION) if (f.length !== 16 || f.some((r) => r.length !== 16)) throw new Error('explosion frame is not 16 x 16');

function sprite(rows, { hot, phases, ink = 7, paper = 0, bright = 1 }) {
  const h = rows.length, w = rows[0].length;
  if (rows.some((r) => r.length !== w)) throw new Error('ragged sprite');
  const hex = (v) => v.toString(16).toUpperCase().padStart(w / 4, '0');
  const outRows = rows.map((r) => {
    let bits = 0, mask = 0;
    for (const ch of r) { bits <<= 1; mask <<= 1; if (ch === '#') { bits |= 1; mask |= 1; } else if (ch === '-') mask |= 1; }
    return { bits: hex(bits), mask: hex(mask), ink, paper, bright };
  });
  return { w, h, frames: [{ rows: outRows }], hot, phases };
}

const tileRows = (bytes, ink, paper = 0, bright = 1) => ({ rows: bytes.map((b) => ({ bits: b.toString(16).toUpperCase().padStart(2, '0'), ink, paper, bright })), flags: 0 });
const quad = (rows16, qx, qy) => rows16.slice(qy * 8, qy * 8 + 8).map((r) => parseInt([...r.slice(qx * 8, qx * 8 + 8)].map((c) => (c === '#' ? '1' : '0')).join(''), 2));
const tiles = [
  tileRows([0, 0, 0, 0, 0, 0, 0, 0], 7, 0, 1),                    // 0 empty sky
  tileRows([0, 0, 0, 0, 0, 0x04, 0, 0], 7, 0, 1),                 // 1 dim star (a single pixel). Every sky tile has the SAME attribute (ink 7, paper 0, BRIGHT 1): a sprite is coloured from the cell under it, so a different ink or bright here would recolour sprites passing over the star; and bright black and normal black paper are different blacks on some displays
  tileRows([0, 0, 0x20, 0, 0, 0, 0, 0], 7, 0, 1),                 // 2 dim star (same attribute as every sky tile: see tile 1)
  tileRows([0, 0x10, 0x38, 0x10, 0, 0, 0, 0], 7, 0, 1),           // 3 bright star
];
const EXP_INK = [7, 6, 2];
EXPLOSION.forEach((f, k) => { for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) tiles.push(tileRows(quad(f, qx, qy), EXP_INK[k], 0, 1)); });

// the sky: row 0 is the HUD; a few stars (a fixed pseudo-random sequence, so the file is the same every time)
let seed = 7;
const rnd = () => { seed = (seed * 25173 + 13849) & 0xFFFF; return seed / 65536; };
const cells = [];
for (let r = 0; r < 24; r++) for (let c = 0; c < 32; c++) {
  const v = rnd();
  cells.push(r === 0 ? 0 : v < 0.025 ? 3 : v < 0.07 ? 1 : v < 0.12 ? 2 : 0);
}

const ticks = (n, f) => Array.from({ length: n }, (_, k) => f(k));
const sfx = {
  pew: { ticks: ticks(6, (k) => ({ tone: 90 + 45 * k, vol: 13 - k, noise: 0, mix: 6 })) },
  boom: { ticks: ticks(14, (k) => ({ tone: 0, vol: Math.max(0, 14 - k), noise: Math.min(31, 6 + 2 * k), mix: 5 })) },
  hurt: { ticks: ticks(10, (k) => ({ tone: 420 + (k % 2 ? 60 : 0) + 25 * k, vol: 13 - Math.floor(k / 2), noise: 0, mix: 6 })) },
  wave: { ticks: ticks(12, (k) => ({ tone: [300, 240, 200][Math.floor(k / 4)], vol: 12 - (k % 4), noise: 0, mix: 6 })) },
  over: { ticks: ticks(22, (k) => ({ tone: 200 + 16 * k, vol: Math.max(2, 13 - Math.floor(k / 2)), noise: 0, mix: 6 })) },
};

const assets = {
  sprites: {
    ship: sprite(SHIP, { hot: [3, 3, 10, 11], phases: 8, ink: 7 }),
    bullet: sprite(BULLET, { hot: [2, 0, 4, 8], phases: 4, ink: 6 }),
    scout: sprite(SCOUT, { hot: [1, 2, 14, 11], phases: 8, ink: 5 }),
    heavy: sprite(HEAVY, { hot: [1, 0, 14, 14], phases: 8, ink: 3 }),
    shot: sprite(SHOT, { hot: [2, 2, 4, 4], phases: 4, ink: 2 }),
  },
  tilesets: { gfx: { tiles } },
  sfx,
  maps: { sky: { w: 32, h: 24, cells } },
};
writeFileSync(join(HERE, 'shooter.assets.json'), JSON.stringify(assets, null, 1) + '\n');
console.log(`shooter.assets.json: ${Object.keys(assets.sprites).length} sprites, ${tiles.length} tiles, ${Object.keys(sfx).length} sound effects, a 32 x 24 sky`);
