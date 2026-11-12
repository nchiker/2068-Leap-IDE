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
import { pattern, song, describe } from './songs.mjs';

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

// ── music (docs/ARCADE_MUSIC_CONTRACT.md section 8; original music): D minor, a quaver = 8 refreshes (about 225 beats a minute), bars of 64.
//   fanfare  the title: a march on A (organ), an octave bass on B, drums on C; two four-bar patterns, looped.
//   drive    the play scene: held chords on A and an octave pulse on B (organ, so a held note changes the chip twice: cheap in the tick), C left free
//            for the effects (a shot borrows C many times a second); patterns: the pulse alone, the pulse and a tune, the tune an octave up.
const bars = (s, n) => Array(n).fill(s).join(' | ');
const PULSE = (lo, hi) => `${lo} ${hi} `.repeat(4).trim();
const DRIVE_B = `@organ !10 L8 | ${PULSE('D2', 'D3')} | ${PULSE('Bb1', 'Bb2')} | ${PULSE('C2', 'C3')} | ${PULSE('A1', 'A2')}`;
const music = {
  fanfare: song([
    pattern({
      A: '@organ !12 L8 | D5 D5 D5 A4 D5:16 F5:16 | E5 E5 E5 C5 E5:16 G5:16 | F5:16 E5 D5 C5:16 A4:16 | D5:48 -:16',
      B: '@bass !12 L16 | D2 D3 D2 D3 | C2 C3 C2 C3 | Bb1 Bb2 A1 A2 | D2 D3 D2 A1',
      C: '@drum !10 ' + bars('C2:4 -:12 G5:4 -:12 C2:4 -:4 C2:4 -:4 G5:4 -:12', 4),
    }, 'call'),
    pattern({
      A: '@organ !12 L8 | F5 F5 F5 E5 F5:16 A5:16 | G5 G5 G5 F5 E5:16 C5:16 | D5:16 E5 F5 E5:16 C#5:16 | D5:48 -:16',
      B: '@bass !12 L16 | Bb1 Bb2 Bb1 Bb2 | C2 C3 C2 C3 | Bb1 Bb2 A1 A2 | D2 D3 D2 D3',
      C: '@drum !10 ' + bars('C2:4 -:12 G5:4 -:12 C2:4 -:4 C2:4 -:4 G5:4 -:12', 4),
    }, 'answer'),
  ], [0, 1], 0),
  drive: song([
    pattern({ A: '@organ !9 L32 | A4 F4 | F4 D4 | G4 E4 | E4 C#4', B: DRIVE_B }, 'pulse'),
    pattern({ A: '@organ !11 L16 | D5 C5 A4:32 | Bb4 A4 F4:32 | G4 A4 Bb4 C5 | A4:64', B: DRIVE_B }, 'tune'),
    pattern({ A: '@organ !11 L16 | F5 E5 D5:32 | D5 C5 Bb4:32 | C5 D5 E5 G5 | E5:32 C#5:32', B: DRIVE_B }, 'tune up'),
  ], [0, 1, 0, 2], 0),
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
  music,
};
writeFileSync(join(HERE, 'shooter.assets.json'), JSON.stringify(assets, null, 1) + '\n');
console.log(`shooter.assets.json: ${Object.keys(assets.sprites).length} sprites, ${tiles.length} tiles, ${Object.keys(sfx).length} sound effects, a 32 x 24 sky; ${Object.entries(music).map(([k, v]) => describe(k, v)).join('; ')}`);
