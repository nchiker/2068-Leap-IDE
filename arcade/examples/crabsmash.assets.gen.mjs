#!/usr/bin/env node
"use strict";
// crabsmash.assets.gen.mjs -- draws the art of crabsmash.arc (a single-screen arena game, fine colour, runtime v2) and writes crabsmash.assets.json next to this file.
//   node arcade/examples/crabsmash.assets.gen.mjs          (--check: is the json current, and does crabsmash.arc agree with the numbers written here)
// Eight sprite assets of 16 x 16 pixels, 4 phases each (32 in all: a fine game's cap), every one with one ink per pixel row and drawn SYMMETRIC (the v2 runtime has no FLIP): the hero in front view
// (run A, run B, jump), the crab (walk A, walk B, stunned) and the fly (wing up, wing down).  The coin is a TILE (2 x 2 cells), so is everything else of the arena.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { picture, set, get, text, tiler } from './fineart.mjs';
import { pattern, song, describe } from './songs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const mirror = (half) => half + [...half].reverse().join('');

// ── sprites: the left half of each row ('#' ink, '-' covered paper, '.' transparent), mirrored
const HERO_INK = [2, 2, 2, 6, 6, 6, 6, 5, 5, 5, 1, 1, 1, 1, 7, 7];
const HERO = {
  herora: ['....####', '...#####', '..######', '..##.###', '..######', '.#######', '...#####', '..######', '.#######', '#.######', '..######', '..######', '..###...', '..###...', '.####...', '.####...'],
  herorb: ['....####', '...#####', '..######', '..##.###', '..######', '.#######', '...#####', '..######', '..######', '..######', '..######', '..######', '...#####', '...#####', '..######', '..######'],
  herojump: ['....####', '#..#####', '#.######', '#.##.###', '########', '.#######', '...#####', '..######', '.#######', '..######', '..######', '..#.####', '.##...##', '.##....#', '##......', '##......'],
};
const CRAB_INK = [2, 2, 2, 2, 3, 3, 3, 3, 2, 2, 2, 1, 1, 1, 1, 1];
const CRAB = {
  craba: ['.#......', '##......', '#.......', '#.#..###', '#.#.####', '..######', '..##.###', '.#######', '########', '########', '#.#####.', '..#####.', '.#.#..#.', '#..#..#.', '#..#..##', '........'],
  crabb: ['........', '.#......', '##......', '#.#..###', '#.#.####', '..######', '..##.###', '.#######', '########', '########', '#.#####.', '..#####.', '..#.#.#.', '.#..#.#.', '.#..#.#.', '#...#..#'],
};
const STUN_INK = [1, 1, 1, 1, 1, 5, 5, 5, 5, 5, 5, 5, 3, 3, 3, 3];
const STUN = ['........', '........', '#.#.#.#.', '#.#.#.#.', '.#.#.#.#', '..######', '.#######', '###-####', '########', '########', '.#######', '..######', '..#.....', '.#......', '.#......', '#.......'];
const FLY_INK = [7, 7, 5, 5, 5, 5, 4, 4, 4, 4, 4, 3, 3, 3, 6, 6];
const FLY = {
  flya: ['........', '#.......', '###.....', '.####...', '..####..', '...#####', '....####', '..######', '.#######', '.#######', '..######', '...#####', '....####', '....#..#', '........', '........'],
  flyb: ['........', '........', '....####', '...#####', '..######', '..######', '..######', '#.######', '##.#####', '###.####', '.###.###', '..######', '...#####', '....#..#', '........', '........'],
};
function sprite(half, ink) {
  const rows = half.map(mirror).map((r, k) => {
    let bits = 0, mask = 0;
    for (const ch of r) { bits <<= 1; mask <<= 1; if (ch === '#') { bits |= 1; mask |= 1; } else if (ch === '-') mask |= 1; }
    const hex = (v) => v.toString(16).toUpperCase().padStart(4, '0');
    return { bits: hex(bits), mask: hex(mask), ink: ink[k], paper: 0, bright: 0 };
  });
  return { w: 16, h: 16, frames: [{ rows }], hot: [2, 2, 12, 12], phases: 4 };
}
for (const [n, h] of Object.entries({ ...HERO, ...CRAB, stun: STUN, ...FLY })) if (h.length !== 16 || h.some((r) => r.length !== 8)) throw new Error(`sprite ${n}: rows must be 16 x 8`);
export const sprites = {
  herora: sprite(HERO.herora, HERO_INK), herorb: sprite(HERO.herorb, HERO_INK), herojump: sprite(HERO.herojump, HERO_INK),
  craba: sprite(CRAB.craba, CRAB_INK), crabb: sprite(CRAB.crabb, CRAB_INK), stun: sprite(STUN, STUN_INK),
  flya: sprite(FLY.flya, FLY_INK), flyb: sprite(FLY.flyb, FLY_INK),
};

// ── the arena: platforms (surface y, x0, x1: the program's PYS / PX0 / PX1 say the same; --check compares), the floor, the pipes and a sprinkle of stars
export const PLATFORMS = [[176, 0, 256], [144, 0, 80], [144, 176, 256], [104, 48, 208], [64, 0, 104], [64, 152, 256]];
const COIN = ['.....####.....', '...########...', '..##########..', '.####.##.####.', '.###.####.###.', '.###.####.###.', '.###.####.###.', '.###.####.###.', '.####.##.####.', '..##########..', '...########...', '.....####.....'];
const COIN_INK = [7, 6, 6, 6, 6, 6, 6, 6, 6, 6, 2, 2];
const tiles0 = [{ rows: Array.from({ length: 8 }, () => ({ bits: '00', ink: 7, paper: 0, bright: 0 })), flags: 0 }];
const T = tiler(tiles0);
{ // the coin: tiles 1..4 (TL TR BL BR), fixed: the program's CONST TCOIN = 1 says so
  const pic = picture();
  COIN.forEach((r, k) => [...r].forEach((ch, j) => { if (ch === '#') set(pic, 1 + j, 2 + k, COIN_INK[k]); }));
  const got = T.add(pic, 0, 0, 2, 2);
  if (got.join() !== '1,2,3,4') throw new Error(`coin tiles: ${got}`);
}
export const arena = picture();
const slab = (x, y, w, h, top, face, mort) => { for (let k = 0; k < h; k++) for (let i = 0; i < w; i++) { const m = (k === h / 2 - 1 || k === h - 1) || ((i + (k < h / 2 ? 0 : 4)) % 8 === 0 && k !== 0); set(arena, x + i, y + k, k === 0 ? top : m ? mort : face); } };
for (const [y, x0, x1] of PLATFORMS) { if (y === 176) slab(0, 176, 256, 16, 7, 3, 1); else slab(x0, y, x1 - x0, 8, 6, 2, 1); }
const pipe = (x0) => { for (let y = 16; y < 44; y++) { const lip = y >= 36; const xs = lip ? x0 - 2 : x0 + 2, w = lip ? 36 : 28; for (let i = 0; i < w; i++) { const rel = i / w; const cc = (lip && (y === 36 || y === 43)) ? 7 : (rel < 0.15 ? 7 : rel < 0.8 ? 4 : 1); set(arena, Math.max(0, Math.min(255, xs + i)), y, cc); } } };
pipe(0); pipe(224);
// stars: one blue pixel in some cells of the rows that no coin or actor stands in (rows 2..5 hold the pipes at the corners)
const STAR_ROWS = [3, 4, 9, 10, 14, 15, 19];
for (const r of STAR_ROWS) for (let c = 4; c < 28; c += 4) if ((r * 7 + c * 3) % 5 < 2 && get(arena, 8 * c, 8 * r) < 0) set(arena, 8 * c + ((r + c) % 5) + 1, 8 * r + ((r * c) % 6) + 1, 1);
const maps = {};
maps.arena = { w: 32, h: 24, cells: T.add(arena, 0, 0, 24, 32) };
// ── text maps (the title's logo, PRESS FIRE, GAME OVER)
const RAINBOW = [7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 3, 3, 1, 1];
const GRADE = [6, 6, 6, 6, 2, 2, 2, 2];
function textMap(str, colourOf, opts = {}) {
  const pic = picture(), s = opts.scale ?? 1;
  text(pic, str, 0, 8, colourOf, opts);
  return { w: str.length * s, h: s, cells: T.add(pic, 1, 0, s, str.length * s) };
}
maps.logo = textMap('CRABSMASH', (py) => RAINBOW[py], { scale: 2, bold: true });
maps.press = textMap('PRESS FIRE TO PLAY', (py) => GRADE[py]);
maps.over = textMap('GAME OVER', (py) => RAINBOW[py], { scale: 2, bold: true });
if (T.count > 128) throw new Error(`${T.count} tiles: at most 128`);

// ── sound effects (one tone and/or noise a refresh) and music (original; docs/ARCADE_MUSIC_CONTRACT.md section 8)
const ticks = (n, f) => Array.from({ length: n }, (_, k) => f(k));
const sfx = {
  jump: { ticks: ticks(6, (k) => ({ tone: 260 - 22 * k, vol: 12 - k, noise: 0, mix: 6 })) },                                            // a rising chirp
  bump: { ticks: ticks(7, (k) => ({ tone: 500 + 20 * k, vol: 14 - 2 * k, noise: 20 - 2 * k, mix: k < 4 ? 0 : 6 })) },                    // a thud: tone and noise
  smash: { ticks: ticks(12, (k) => ({ tone: 140 + 26 * k, vol: 14 - Math.floor(k / 2), noise: k < 4 ? 10 : 0, mix: k < 4 ? 4 : 6 })) },    // a crunch, then a falling blip
  coin: { ticks: [...ticks(3, (k) => ({ tone: 120, vol: 13 - k, noise: 0, mix: 6 })), ...ticks(8, (k) => ({ tone: 80, vol: 13 - k, noise: 0, mix: 6 }))] },  // two notes
  die: { ticks: ticks(28, (k) => ({ tone: 90 + 14 * k + (k % 3 ? 0 : 30), vol: Math.max(2, 14 - Math.floor(k / 2)), noise: 0, mix: 6 })) },
  phase: { ticks: ticks(20, (k) => ({ tone: [250, 200, 166, 125, 100][Math.floor(k / 4)], vol: 13 - (k % 4), noise: 0, mix: 6 })) },       // a rising arpeggio
  over: { ticks: ticks(26, (k) => ({ tone: 140 + 17 * k, vol: Math.max(2, 13 - Math.floor(k / 2)), noise: 0, mix: 6 })) },
};
// C major, a quaver = 8 refreshes (bars of 64).  "scuttle", the title song: a pluck tune over a bass; "arena", the game song: a quick organ line and a bass (channel C is left for the effects)
const music = {
  scuttle: song([
    pattern({ A: '@pluck !12 L8 | C5 E5 G5 E5 C5 E5 G5 - | A4 C5 E5 C5 A4 C5 E5 - | F4 A4 C5 A4 F4 A4 C5 - | G4 B4 D5 B4 G4 B4 D5 -', B: '@bass !11 L32 | C2 G2 | A1 E2 | F1 C2 | G1 D2' }, 'scuttle'),
    pattern({ A: '@pluck !12 L8 | E5 G5 C6 G5 E5 G5 C6 - | D5 F5 A5 F5 D5 F5 A5 - | C5 E5 G5 E5 D5 F5 B5 - | C6:32 -:32', B: '@bass !11 L32 | C2 G2 | D2 A2 | G1 D2 | C2:64' }, 'claw'),
  ], [0, 1], 0),
  arena: song([
    pattern({ A: '@organ !10 L8 | G4 - G4 B4 D5 - B4 - | F4 - F4 A4 C5 - A4 - | E4 - E4 G4 C5 - G4 - | D4 - D4 F4 A4 - F4 -', B: '@bass !10 L16 | C2 G2 C2 G2 | F1 C2 F1 C2 | C2 G2 C2 G2 | G1 D2 G1 D2' }, 'scurry'),
    pattern({ A: '@organ !10 L8 | E5 - D5 - C5 - D5 - | E5 - E5 - E5:32 | D5 - D5 - D5:32 | E5 - G5 - G5:32', B: '@bass !10 L16 | C2 G2 C2 G2 | A1 E2 A1 E2 | F1 C2 F1 C2 | G1 D2 G1 D2' }, 'chase'),
  ], [0, 1], 0),
};

const assets = {
  scenes: { title: { display: 'fine' }, play: { display: 'fine' }, over: { display: 'fine' } },
  sprites,
  tilesets: { gfx: { tiles: T.tiles } },
  sfx,
  maps,
  music,
};
const json = JSON.stringify(assets, null, 1) + '\n';
// what crabsmash.arc repeats by hand: the platforms and the coin's first tile
const ARC = join(HERE, 'crabsmash.arc');
function checkArc() {
  if (!existsSync(ARC)) return [];
  const src = readFileSync(ARC, 'utf8'), bad = [];
  const arr = (n) => { const m = new RegExp(`^\\s*DIM ${n}\\(\\d+\\) = ([-\\d, ]+)`, 'mi').exec(src); return m ? m[1].split(',').map(Number) : null; };
  const want = { PYS: PLATFORMS.map((p) => p[0]), PX0: PLATFORMS.map((p) => p[1]), PX1: PLATFORMS.map((p) => p[2]) };
  for (const [k, v] of Object.entries(want)) { const got = arr(k); if (!got || got.join() !== v.join()) bad.push(`crabsmash.arc: DIM ${k} should be ${v.join(', ')}${got ? `, is ${got.join(', ')}` : ' (missing)'}`); }
  const m = /^\s*CONST TCOIN = (\d+)/m.exec(src);
  if (!m || Number(m[1]) !== 1) bad.push('crabsmash.arc: CONST TCOIN should be 1');
  return bad;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const OUT = process.env.OUT ?? join(HERE, 'crabsmash.assets.json');
  if (process.argv.includes('--check')) {
    const bad = checkArc();
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== json) bad.push('crabsmash.assets.json is out of date: node arcade/examples/crabsmash.assets.gen.mjs');
    if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
    console.log('crabsmash.assets.json is current; crabsmash.arc agrees with the generator');
  } else {
    writeFileSync(OUT, json);
    console.log(`crabsmash.assets.json: ${Object.keys(sprites).length} sprites (${Object.values(sprites).reduce((n, s) => n + s.phases, 0)} phases), ${T.count} tiles, ${Object.keys(sfx).length} effects, ${Object.entries(music).map(([k, v]) => describe(k, v)).join('; ')}`);
    const bad = checkArc();
    if (bad.length) console.log('NOTE (crabsmash.arc to be updated):\n' + bad.join('\n'));
  }
}
