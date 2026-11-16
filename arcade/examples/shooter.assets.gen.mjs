#!/usr/bin/env node
"use strict";
// shooter.assets.gen.mjs -- draws the art of shooter.arc and writes shooter.assets.json next to this file.
//   node arcade/examples/shooter.assets.gen.mjs
// The art is ASCII: '#' = a lit pixel (ink), '-' = a covered but unlit pixel (paper: it hides the stars behind the sprite),
// '.' = transparent. The big sprites (16 x 16) and the two small ones (8 x 8) are drawn as the LEFT half and mirrored.
// Format: docs/ARCADE_ASSETS.md (rows with bits / mask in hex, MSB = leftmost pixel; mask 1 = the sprite covers the background;
// `hot` = the collision box [x, y, w, h]; `phases` = pre-shifted horizontal positions (8, 4, 2 or 1), see
// docs/ARCADE_RUNTIME_API_V2.md). Each row also says ink / paper / bright as the Studio would author it.
// Fine colour (docs/ARCADE_FINE_COLOUR_CONTRACT.md; the top-level "scenes" key below makes every scene 8 x 1 colour): a sprite's colour there
// is the INK of each of its pixel rows (the paper and BRIGHT under it are the background's), so every sprite is shaded per row (SHIP_INK ...
// SHOT_INK), and a tile has eight row attributes.  The sky is painted as a picture (fineart.mjs): a planet lit from the upper left, shaded
// black -> blue -> red -> magenta (neighbours in brightness) in solid bands joined by checkerboard seams, a dithered rim on its night side,
// sparse stars; the explosions are hot at the core; the title and game over show a rainbow logo and graded text (maps loaded over the sky).
// Black paper is always BRIGHT 0 (TSRun shows BRIGHT black grey).  Owner approved the look from stills, 2026-11-15.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pattern, song, describe } from './songs.mjs';
import { picture, dither, set, text, tiler } from './fineart.mjs';

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
const quad = (rows16, qx, qy) => rows16.slice(qy * 8, qy * 8 + 8).map((r) => parseInt([...r.slice(qx * 8, qx * 8 + 8)].map((c) => (c === '#' ? '1' : '0')).join(''), 2));
// 0 .. 3: the empty sky and three stars (a single dim pixel, a dim cyan one, a cross with a white core); the code knows 4 .. 15 as the explosion
const tiles = [
  tileRows([0, 0, 0, 0, 0, 0, 0, 0], 7),
  tileRows([0, 0, 0, 0, 0, 0x04, 0, 0], 1),
  tileRows([0, 0, 0x20, 0, 0, 0, 0, 0], 5),
  tileRows([0, 0x10, 0x38, 0x10, 0, 0, 0, 0], [7, 5, 7, 5, 7, 7, 7, 7]),
];
// 4 .. 15: the explosion, 3 frames of 2 x 2 tiles; each pixel row has its own ink, hot (white) at the core and cooling outwards
const expInk = (f, r) => { const d = Math.abs(r - 7.5); return f === 0 ? (d <= 2 ? 7 : 6) : f === 1 ? (d <= 2 ? 7 : d <= 4 ? 6 : d <= 6 ? 2 : 3) : (d <= 3 ? 6 : d <= 5 ? 2 : 3); };
EXPLOSION.forEach((f, k) => { for (const [qx, qy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) tiles.push(tileRows(quad(f, qx, qy), Array.from({ length: 8 }, (_, r) => expInk(k, qy * 8 + r)))); });

// ── the pictures (fineart.mjs: painted per pixel, shaded along ramps of colours that are neighbours in brightness, then cut into 8 x 8 tiles
//    with eight row colours each; the tiler shares equal tiles between the maps)
const T_STARS = [1, 2, 3];
let seed = 7;
const rnd = () => { seed = (seed * 25173 + 13849) & 0xFFFF; return seed / 65536; };
// the planet: a sphere lit from the upper left (behind it, so the lit side is a broad crescent), shaded black -> blue -> red -> magenta in crisp
// bands joined by a checkerboard seam; its night side keeps a thin blue rim (the atmosphere lit from behind), so the whole disc reads
const PLANET = { cx: 204, cy: 58, R: 36, ramp: [0, 1, 2, 3], light: [-0.85, -0.35, 0.35] };
function paintPlanet(pic) {
  const { cx, cy, R, ramp, light } = PLANET, L = Math.hypot(...light), [lx, ly, lz] = light.map((v) => v / L), top = ramp.length - 1;
  for (let y = 8; y < 192; y++) for (let x = 0; x < 256; x++) {
    const nx = (x + 0.5 - cx) / R, ny = (y + 0.5 - cy) / R, q = 1 - nx * nx - ny * ny;
    if (q < 0) continue;
    const d = Math.max(0, nx * lx + ny * ly + Math.sqrt(q) * lz);
    let lv = d * top;
    if (q < 0.09 && lv < 0.5) lv = 0.5;                        // the rim: a blue seam around the night side
    set(pic, x, y, dither(x, y, Math.min(top, lv), ramp));
  }
}
const inPlanet = (r, c) => Math.hypot(8 * c + 4 - PLANET.cx, 8 * r + 4 - PLANET.cy) < PLANET.R + 8;
// the sky: row 0 is the HUD; a few stars (a fixed pseudo-random sequence, so the file is the same every time) where the planet is not, then the planet
const skyPic = picture();
paintPlanet(skyPic);
const starAt = [];
for (let r = 1; r < 24; r++) for (let c = 0; c < 32; c++) { const v = rnd(); starAt.push(inPlanet(r, c) ? 0 : v < 0.02 ? 3 : v < 0.06 ? 1 : v < 0.09 ? 2 : 0); }
const tiler_ = tiler(tiles);
const skyCells = [...new Array(32).fill(0), ...tiler_.add(skyPic, 1, 0, 23, 32)].map((t, i) => (i >= 32 && t === 0 ? starAt[i - 32] : t));

// the title and the game over: STARFALL and GAME OVER in the font at twice its size (bold), every pixel row its own colour (white at the top, down through the brightnesses),
// and "PRESS FIRE TO PLAY" one size, graded yellow -> red row by row: maps loaded over the sky (LOADMAP ... AT), placed clear of the planet.
const RAINBOW = [7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 3, 3, 1, 1];        // a pixel row of the big letters -> its ink
const GRADE = [6, 6, 6, 6, 2, 2, 2, 2];                                  // a pixel row of graded text -> its ink (the font's rows 1..6 hold the strokes)
function textMap(str, colourOf, { scale = 1, shadow = null, bold = false } = {}) {
  const pic = picture(), w = str.length * scale, h = scale;
  text(pic, str, 0, 8, colourOf, { scale, shadow, bold });
  return { w, h, cells: tiler_.add(pic, 1, 0, h, w) };
}
const logo = textMap('STARFALL', (py) => RAINBOW[py], { scale: 2, bold: true });
const press = textMap('PRESS FIRE TO PLAY', (py) => GRADE[py]);
const gameOver = textMap('GAME OVER', (py) => RAINBOW[py], { scale: 2, bold: true });
if (tiler_.count > 128) throw new Error(`${tiler_.count} tiles: at most 128`);

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
  scenes: { title: { display: 'fine' }, play: { display: 'fine' }, over: { display: 'fine' } },   // every scene is 8 x 1 colour (docs/ARCADE_FINE_COLOUR_CONTRACT.md 1)
  sprites: {
    ship: sprite(SHIP, { hot: [3, 3, 10, 11], phases: 8, inks: SHIP_INK }),
    bullet: sprite(BULLET, { hot: [2, 0, 4, 8], phases: 4, inks: BULLET_INK }),
    scout: sprite(SCOUT, { hot: [1, 2, 14, 11], phases: 8, inks: SCOUT_INK }),
    heavy: sprite(HEAVY, { hot: [1, 0, 14, 14], phases: 8, inks: HEAVY_INK }),
    shot: sprite(SHOT, { hot: [2, 2, 4, 4], phases: 4, inks: SHOT_INK }),
  },
  tilesets: { gfx: { tiles: tiler_.tiles } },
  sfx,
  maps: {
    sky: { w: 32, h: 24, cells: skyCells },
    logo: { w: logo.w, h: logo.h, cells: logo.cells }, press: { w: press.w, h: press.h, cells: press.cells },
    gameover: { w: gameOver.w, h: gameOver.h, cells: gameOver.cells },
  },
  music,
};
writeFileSync(process.env.OUT ?? join(HERE, 'shooter.assets.json'), JSON.stringify(assets, null, 1) + '\n');
console.log(`shooter.assets.json: ${Object.keys(assets.sprites).length} sprites, ${tiler_.count} tiles, ${Object.keys(sfx).length} sound effects, ${Object.keys(assets.maps).length} maps; ${Object.entries(music).map(([k, v]) => describe(k, v)).join('; ')}`);
