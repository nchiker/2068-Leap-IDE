#!/usr/bin/env node
"use strict";
// shooter.assets.gen.mjs -- draws the art of shooter.arc and writes shooter.assets.json next to this file.
//   node arcade/examples/shooter.assets.gen.mjs
// The art is ASCII: '#' = a lit pixel (ink), '-' = a covered but unlit pixel (paper: it hides the stars behind the sprite),
// '.' = transparent. The big sprites (16 x 16) and the two small ones (8 x 8) are drawn as the LEFT half and mirrored.
// Format: docs/ARCADE_ASSETS.md (rows with bits / mask in hex, MSB = leftmost pixel; mask 1 = the sprite covers the background;
// `hot` = the collision box [x, y, w, h]; `phases` = pre-shifted horizontal positions (8, 4, 2 or 1), see
// docs/ARCADE_RUNTIME_API_V2.md). Each row also says ink / paper / bright as the Studio would author it.
// Fine colour (docs/ARCADE_FINE_COLOUR_CONTRACT.md; the top-level "scenes" key below makes the play scene 8 x 1 colour): a sprite's colour
// there is the INK of each of its pixel rows (the paper and BRIGHT under it are the background's), so every sprite is shaded per row
// (SHIP_INK ... SHOT_INK), and a tile has eight row attributes, so the sky has stars of several inks, a dithered nebula and a planet's
// horizon, and the explosions are hot at the core.  Everything is black paper, BRIGHT 0 (TSRun shows BRIGHT black grey).  The title and
// the game over scenes stay two-buffer: they show each tile's row 0 attribute.
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

function sprite(rows, { hot, phases, inks, paper = 0, bright = 0 }) {
  if (inks.length !== rows.length) throw new Error(`${inks.length} row inks for ${rows.length} rows`);
  const h = rows.length, w = rows[0].length;
  if (rows.some((r) => r.length !== w)) throw new Error('ragged sprite');
  const hex = (v) => v.toString(16).toUpperCase().padStart(w / 4, '0');
  const outRows = rows.map((r, k) => {
    const ink = inks[k];
    let bits = 0, mask = 0;
    for (const ch of r) { bits <<= 1; mask <<= 1; if (ch === '#') { bits |= 1; mask |= 1; } else if (ch === '-') mask |= 1; }
    return { bits: hex(bits), mask: hex(mask), ink, paper, bright };
  });
  return { w, h, frames: [{ rows: outRows }], hot, phases };
}

// a tile: eight row attributes (docs/ARCADE_ASSETS.md: bits, ink, paper, bright per row); `inks` / `papers` are one number or one value a row
const per = (v, k) => (Array.isArray(v) ? v[k] : v);
const tileRows = (bytes, inks, paper = 0) => ({ rows: bytes.map((b, k) => ({ bits: b.toString(16).toUpperCase().padStart(2, '0'), ink: per(inks, k), paper: per(paper, k), bright: 0 })), flags: 0 });
// a sky tile (one the map uses): its row 0 is ink 7 on paper 0 (BRIGHT 0) whatever the other rows are, because the title and the game over scenes are two-buffer and show a tile by its row 0 attribute,
// and the asset check (background-attr-mix) wants one background attribute for the cell map; the art of a sky tile therefore keeps its row 0 empty
const sky = (bytes, inks, paper = 0) => { if (bytes[0] !== 0) throw new Error('a sky tile has an empty row 0'); return tileRows(bytes, Array.from({ length: 8 }, (_, k) => (k === 0 ? 7 : per(inks, k))), Array.from({ length: 8 }, (_, k) => (k === 0 ? 0 : per(paper, k)))); };
const quad = (rows16, qx, qy) => rows16.slice(qy * 8, qy * 8 + 8).map((r) => parseInt([...r.slice(qx * 8, qx * 8 + 8)].map((c) => (c === '#' ? '1' : '0')).join(''), 2));
const tiles = [
  sky([0, 0, 0, 0, 0, 0, 0, 0], 7),                               // 0 empty sky
  sky([0, 0, 0, 0, 0, 0x04, 0, 0], 1),                            // 1 dim blue star (a single pixel)
  sky([0, 0, 0x20, 0, 0, 0, 0, 0], 5),                            // 2 dim cyan star
  sky([0, 0x10, 0x38, 0x10, 0, 0, 0, 0], [7, 5, 7, 5, 7, 7, 7, 7]),   // 3 bright star: a cross, white core and cyan arms
];
// 4 .. 15: the explosion, 3 frames of 2 x 2 tiles; each pixel row has its own ink, hot (white) at the core and cooling outwards
const expInk = (f, r) => { const d = Math.abs(r - 7.5); return f === 0 ? (d <= 2 ? 7 : 6) : f === 1 ? (d <= 2 ? 7 : d <= 4 ? 6 : d <= 6 ? 2 : 3) : (d <= 3 ? 6 : d <= 5 ? 2 : 3); };
EXPLOSION.forEach((f, k) => { for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) tiles.push(tileRows(quad(f, qx, qy), Array.from({ length: 8 }, (_, r) => expInk(k, qy * 8 + r)))); });
tiles.push(sky([0, 0, 0, 0x08, 0, 0, 0, 0], 6));                // 16 dim yellow star
tiles.push(sky([0, 0, 0, 0, 0, 0, 0x40, 0], 3));               // 17 dim magenta star
// 18 .. 29: the nebula, a dither of 3 densities in 4 colourings (blue, blue to magenta, magenta, magenta to blue: a gradient down the band)
const NEB_DENSITY = [[0, 0, 0x44, 0, 0, 0, 0x11, 0], [0, 0x44, 0, 0x11, 0, 0x44, 0, 0x11], [0, 0x88, 0x22, 0x88, 0x22, 0x88, 0x22, 0x88]];
const NEB_INKS = [Array(8).fill(1), [1, 1, 1, 1, 3, 3, 3, 3], Array(8).fill(3), [3, 3, 3, 3, 1, 1, 1, 1]];
for (const inks of NEB_INKS) for (const d of NEB_DENSITY) tiles.push(sky(d, inks));
// 30, 31: the horizon of a planet along the two lowest cell rows: the PAPER climbs from black through blue and magenta to red, line by line
tiles.push(sky([0, 0, 0, 0, 0, 0, 0, 0], 7, [0, 0, 0, 0, 0, 1, 1, 1]));
tiles.push(sky([0, 0, 0, 0, 0, 0, 0, 0], 7, [0, 1, 1, 3, 3, 3, 2, 2]));
const T_STARS = [1, 2, 3, 16, 17], T_NEB0 = 18, T_HOR = 30;

// the sky: row 0 is the HUD; a few stars (a fixed pseudo-random sequence, so the file is the same every time), the nebula in cell rows 5 .. 13, the horizon in 22, 23
let seed = 7;
const rnd = () => { seed = (seed * 25173 + 13849) & 0xFFFF; return seed / 65536; };
const NEB_ZONE = (r) => (r <= 6 ? 0 : r === 7 ? 1 : r <= 10 ? 2 : r === 11 ? 3 : 0);
const cells = [];
for (let r = 0; r < 24; r++) for (let c = 0; c < 32; c++) {
  const v = rnd(), w = rnd(), n = rnd();
  let t = 0;
  if (r === 22 || r === 23) t = T_HOR + (r - 22);
  else if (r >= 5 && r <= 13 && n < 0.8 * (1 - Math.abs(r - 9) / 5)) t = T_NEB0 + 3 * NEB_ZONE(r) + (w < 0.45 ? 0 : w < 0.85 ? 1 : 2);
  else if (r > 0) t = v < 0.025 ? 3 : v < 0.07 ? 1 : v < 0.12 ? 2 : v < 0.15 ? 16 : v < 0.18 ? 17 : 0;
  cells.push(t);
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

// the ink of each pixel row of a sprite (a fine scene colours a sprite by its rows): lit from above, so the light rows are the top ones
const SHIP_INK = [7, 7, 7, 7, 5, 5, 5, 5, 5, 5, 1, 1, 1, 2, 6, 6];
const SCOUT_INK = [4, 4, 4, 4, 4, 4, 6, 6, 6, 6, 2, 2, 2, 2, 2, 2];
const HEAVY_INK = [7, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 6, 6, 6, 6, 6];
const BULLET_INK = [7, 7, 6, 6, 6, 2, 2, 2];
const SHOT_INK = [6, 6, 2, 2, 2, 2, 3, 3];
const assets = {
  scenes: { play: { display: 'fine' } },          // the play scene is 8 x 1 colour (docs/ARCADE_FINE_COLOUR_CONTRACT.md 1); the title and over scenes are two-buffer
  sprites: {
    ship: sprite(SHIP, { hot: [3, 3, 10, 11], phases: 8, inks: SHIP_INK }),
    bullet: sprite(BULLET, { hot: [2, 0, 4, 8], phases: 4, inks: BULLET_INK }),
    scout: sprite(SCOUT, { hot: [1, 2, 14, 11], phases: 8, inks: SCOUT_INK }),
    heavy: sprite(HEAVY, { hot: [1, 0, 14, 14], phases: 8, inks: HEAVY_INK }),
    shot: sprite(SHOT, { hot: [2, 2, 4, 4], phases: 4, inks: SHOT_INK }),
  },
  tilesets: { gfx: { tiles } },
  sfx,
  maps: { sky: { w: 32, h: 24, cells } },
  music,
};
writeFileSync(join(HERE, 'shooter.assets.json'), JSON.stringify(assets, null, 1) + '\n');
console.log(`shooter.assets.json: ${Object.keys(assets.sprites).length} sprites, ${tiles.length} tiles, ${Object.keys(sfx).length} sound effects, a 32 x 24 sky; ${Object.entries(music).map(([k, v]) => describe(k, v)).join('; ')}`);
