#!/usr/bin/env node
"use strict";
// prism.assets.gen.mjs -- draws the art, sounds and songs of prism.arc ("Prism Catch", the fine colour showcase) and writes prism.assets.json next to this file.
//   node arcade/examples/prism.assets.gen.mjs            writes prism.assets.json
//   node arcade/examples/prism.assets.gen.mjs --check    compares with the committed file and with the numbers written into prism.arc (exit 1 on a difference)
//
// The project setting that makes the play scene fine colour (SCLD mode 2, 8 x 1 colour; docs/ARCADE_FINE_COLOUR_CONTRACT.md section 1) is the top-level "scenes" key
// of the assets file: {"play": {"display": "fine"}}.  The title and game over scenes stay in the two-buffer 8 x 8 colour setup.
//
// THE ART (all of it is authored per 8 x 1 row, which is what a fine scene shows):
//   * The sky is one tile per character row (tile r = row r of the screen): each of its 8 pixel rows has its own paper and BRIGHT, a sunset gradient dithered row by row between
//     the stops of SKY below (black, blue, bright blue, magenta, bright magenta, red, bright red, a yellow horizon line), with a glow band of bright magenta rows between black ones at pixel rows
//     64..79 where, from wave 3, a gem changes colour.  Under it a dark sea (blue / black rows).  The bitmaps are empty (paper only), so a sprite's ink never recolours a
//     background pixel: the sky is made of paper rows alone.  A few star tiles (the same row colours with a white pixel) sit in the upper sky.  The two-buffer scenes show the
//     same tiles with the first row's colour per 8 x 8 cell.
//   * Sprites: in a fine scene a sprite's colour is each row's INK only (paper and BRIGHT come from the background), so a colour is a separate asset with its own row inks and the
//     shading is the inks: a white highlight on the crown, the body colour, a darker shade at the tip.  Four gems (green, cyan, yellow, white), 16 x 16, 1 phase (they fall on
//     8-aligned columns); four catchers, one per colour, 16 x 8, 4 phases (x in steps of 2).  4 x 1 + 4 x 4 = 20 phases (the cap of a fine game is 32).
//   * Bursts (tiles, cell row 20 above the catcher) for the four colours, a red "wrong" burst and a splash in the sea (cell row 22); a heart tile for the lives.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pattern, song, describe } from './songs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHECK = process.argv.includes('--check');
const mirror = (half) => half + [...half].reverse().join('');

// ── the background: paper and BRIGHT of every pixel row of the screen ────────────────────────────────────────────────────────────────
const BAYER = [0.125, 0.625, 0.375, 0.875];                  // a 4-row ordered dither: the share of the second colour that makes a row take it
const mixRow = (i, f) => (f > BAYER[i & 3] ? 1 : 0);
// sky stops: [pixel row, paper, bright]; between two stops the rows alternate between the two colours in the proportion that moves from the first to the second
const SKY = [[8, 0, 0], [40, 1, 0], [60, 1, 1], [100, 3, 0], [124, 3, 1], [140, 2, 0], [152, 2, 1]];
const GLOW = [64, 80];                                       // the glow band: pixel rows 64..79 (cell rows 8 and 9), bright magenta
const HORIZON = [152, 160];                                  // bright red, then the last two rows a bright yellow line
function skyAt(y) {
  if (y < 8) return [0, 0];
  let base;
  if (y >= HORIZON[0] && y < HORIZON[1]) base = y >= 158 ? [6, 1] : [2, 1];
  else {
    let k = 0;
    while (k < SKY.length - 2 && y >= SKY[k + 1][0]) k++;
    const [y0, p0, b0] = SKY[k], [y1, p1, b1] = SKY[k + 1];
    base = mixRow(y - y0, (y - y0) / (y1 - y0)) ? [p1, b1] : [p0, b0];
  }
  if (y >= GLOW[0] && y < GLOW[1]) {                          // the glow band: neon rows, bright magenta between rows of black, thinning out at its edges
    const w = 1 - Math.abs(y - 71.5) / 8.5;
    if (w > BAYER[(y - GLOW[0]) & 3]) return y & 1 ? [3, 1] : [0, 0];
  }
  return base;
}
function seaAt(y) {                                          // y 160..191: blue and black rows, less blue the deeper
  const f = 0.7 - 0.5 * (y - 160) / 32;
  return mixRow(y, f) ? [1, 0] : [0, 0];
}
const bgAt = (y) => (y >= 160 ? seaAt(y) : skyAt(y));
// the two-buffer scenes: the colour of cell row r is its first pixel row's
export const SKYP = Array.from({ length: 24 }, (_, r) => bgAt(8 * r)[0]);
export const SKYB = Array.from({ length: 24 }, (_, r) => bgAt(8 * r)[1]);

// ── tile numbers (prism.arc's CONSTs say the same; --check compares) ──────────────────────────────────────────────────────────────────
const T = { blank: 0, star: 24, heart: 36, burst: 40 };      // tile r (0..23) is the sky / sea of cell row r; stars 24 + (r - 1) for rows 1..12; burst = 40 + 6 * kind + 2 * frame + half (kinds 0..3 gem colours, 4 = wrong, 5 = splash)
const STAR_ROWS = 12;

const tileRows = (bytes, inkOf, bgOf, y0) => ({
  rows: bytes.map((b, k) => { const [paper, bright] = bgOf(y0 + k); return { bits: b.toString(16).toUpperCase().padStart(2, '0'), ink: typeof inkOf === 'function' ? inkOf(k) : inkOf, paper, bright }; }),
  flags: 0,
});
const tiles = [];
for (let r = 0; r < 24; r++) tiles[r] = tileRows(Array(8).fill(0), 7, r === 0 ? () => [0, 0] : bgAt, 8 * r);
// star tiles: the row's colours with one white pixel (its place depends on the row, so the stars do not line up)
for (let r = 1; r <= STAR_ROWS; r++) {
  const bytes = Array(8).fill(0);
  bytes[(r * 3 + 1) & 7] = 0x80 >> ((r * 5 + 2) & 7);
  tiles[T.star + r - 1] = tileRows(bytes, 7, bgAt, 8 * r);
}
const bitsOf = (s) => parseInt([...s].map((c) => (c === '#' ? '1' : '0')).join(''), 2);
// a heart for the lives, on the black HUD row
const HEART = ['.##..##.', '########', '########', '########', '.######.', '..####..', '...##...', '........'];
tiles[T.heart] = { rows: HEART.map((r, k) => ({ bits: bitsOf(r).toString(16).toUpperCase().padStart(2, '0'), ink: k === 1 ? 7 : 2, paper: 0, bright: 0 })), flags: 0 };

// bursts: 16 x 8 pictures cut into two tiles; the ink of a row is white in the core rows, else the burst's colour
const BURST = [
  ['................', '................', '.......##.......', '......####......', '......####......', '.......##.......', '................', '................'],
  ['.......##.......', '....#..##..#....', '.....######.....', '..############..', '..############..', '.....######.....', '....#..##..#....', '.......##.......'],
  ['...#........#...', '.#....#..#....#.', '......#..#......', '#...............', '...............#', '......#..#......', '.#....#..#....#.', '...#........#...'],
];
const SPLASH = [
  ['................', '................', '.......##.......', '......#..#......', '.....#....#.....', '..####....####..', '################', '................'],
  ['................', '...#........#...', '..#..#....#..#..', '...#.#....#.#...', '....#......#....', '.####........###', '################', '................'],
  ['................', '................', '................', '.#.#........#.#.', '..#..........#..', '################', '................', '................'],
];
const GEMINK = [4, 5, 6, 7];                                   // green, cyan, yellow, white
function cutTiles(pic, inkOf, y0, base) {                      // two tiles (left half, right half) of a 16 x 8 picture at pixel row y0
  for (let h = 0; h < 2; h++) {
    const bytes = pic.map((row) => bitsOf(row.slice(8 * h, 8 * h + 8)));
    tiles[base + h] = tileRows(bytes, inkOf, bgAt, y0);
  }
}
for (let kind = 0; kind < 6; kind++) for (let f = 0; f < 3; f++) {
  const base = T.burst + 6 * kind + 2 * f;
  if (kind < 4) cutTiles(BURST[f], (k) => (k >= 2 && k <= 5 ? 7 : GEMINK[kind]), 160, base);
  else if (kind === 4) cutTiles(BURST[f], (k) => (k >= 2 && k <= 5 ? 6 : 2), 160, base);
  else cutTiles(SPLASH[f], (k) => (k < 5 ? 5 : 7), 176, base);
}

// ── sprites ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
function sprite(rows, inks, { hot, phases }) {
  const h = rows.length, w = rows[0].length;
  if (rows.some((r) => r.length !== w)) throw new Error('ragged sprite');
  if (inks.length !== h) throw new Error('one ink per row');
  const hex = (v) => v.toString(16).toUpperCase().padStart(w / 4, '0');
  const outRows = rows.map((r, k) => {
    let bits = 0, mask = 0;
    for (const ch of r) { bits <<= 1; mask <<= 1; if (ch === '#') { bits |= 1; mask |= 1; } else if (ch === '-') mask |= 1; }
    return { bits: hex(bits), mask: hex(mask), ink: inks[k], paper: 0, bright: 0 };
  });
  return { w, h, frames: [{ rows: outRows }], hot, phases };
}
// the gem: a brilliant cut, '#' is lit (ink), '-' a facet line that shows the sky behind it
const GEM = ['.....###', '...#####', '..###-##', '.###-###', '########', '.#######', '.##-####', '..##-###', '..###-##', '...##-##', '...###-#', '....####', '....####', '.....###', '......##', '.......#'].map(mirror);
// the inks of its 16 rows: a white crown, the body, a shade at the tip
const gemInks = (body, shade) => [7, 7, body, body, body, body, body, body, body, body, body, shade, shade, shade, shade, shade];
const GEM_INKS = [gemInks(4, 1), gemInks(5, 1), gemInks(6, 2), [7, 7, 7, 7, 7, 7, 7, 7, 5, 5, 5, 5, 1, 1, 1, 1]];
// the catcher: a bowl, 16 x 8; a white rim, the body, a shade at the bottom
const CATCHER = ['########', '.#######', '.#######', '..######', '..######', '...#####', '....####', '.....###'].map(mirror);
const catcherInks = (body, shade) => [7, body, body, body, body, body, shade, shade];
const CAT_INKS = [catcherInks(4, 1), catcherInks(5, 1), catcherInks(6, 2), catcherInks(7, 5)];

// ── sounds ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ticks = (n, f) => Array.from({ length: n }, (_, k) => f(k));
const sfx = {
  chime: { ticks: ticks(14, (k) => ({ tone: [180, 144, 120, 90][Math.floor(k / 4)] ?? 90, vol: 13 - (k % 4) - Math.floor(k / 8), noise: 0, mix: 6 })) },
  buzz: { ticks: ticks(12, (k) => ({ tone: 640 + (k % 2 ? 70 : 0), vol: 13 - Math.floor(k / 2), noise: 0, mix: 6 })) },
  splash: { ticks: ticks(14, (k) => ({ tone: 0, vol: Math.max(0, 12 - k), noise: Math.min(31, 8 + k * 2), mix: 5 })) },
  pick: { ticks: ticks(3, (k) => ({ tone: 120 - 10 * k, vol: 11 - 2 * k, noise: 0, mix: 6 })) },
  ping: { ticks: ticks(8, (k) => ({ tone: 60 + 14 * k, vol: 12 - k, noise: 0, mix: 6 })) },
  over: { ticks: ticks(22, (k) => ({ tone: 200 + 16 * k, vol: Math.max(2, 13 - Math.floor(k / 2)), noise: 0, mix: 6 })) },
};

// ── music (docs/ARCADE_MUSIC_CONTRACT.md section 8; original): A minor / C major, a bar = 96 refreshes (a beat 24, about 150 beats a minute)
//   twilight  the title: a slow tune on A (organ), a bass on B, a pluck arpeggio on C; two four-bar patterns, looped
//   tide      the play scene: A and B only (the effects borrow C); a pluck tune over a bass, two patterns, looped
//   jingle    between the waves: a short rising fanfare on all three channels, not looped (the game starts `tide` again when the banner ends)
const ARP = (a, b, c) => `${a} ${b} ${c} ${b} `.repeat(2).trim();     // 8 notes of 12 refreshes = one bar
const music = {
  twilight: song([
    pattern({
      A: '@organ !11 L24 | E5 G5 A5 G5 | E5 D5 C5:48 | D5 F5 A5 G5 | E5:96',
      B: '@bass !11 L48 | A2 E3 | F2 C3 | D2 A2 | E2 B2',
      C: `@pluck !8 L12 | ${ARP('A3', 'C4', 'E4')} | ${ARP('F3', 'A3', 'C4')} | ${ARP('D3', 'F3', 'A3')} | ${ARP('E3', 'G#3', 'B3')}`,
    }, 'dusk'),
    pattern({
      A: '@organ !11 L24 | C6 B5 A5 G5 | A5 G5 E5:48 | F5 A5 C6 B5 | A5:96',
      B: '@bass !11 L48 | A2 E3 | F2 C3 | D2 A2 | A2 E3',
      C: `@pluck !8 L12 | ${ARP('A3', 'C4', 'E4')} | ${ARP('F3', 'A3', 'C4')} | ${ARP('D3', 'F3', 'A3')} | ${ARP('A3', 'C4', 'E4')}`,
    }, 'dawn'),
  ], [0, 1], 0),
  tide: song([
    pattern({
      A: '@pluck !10 L24 | A4 C5 E5 C5 | F4 A4 C5 A4 | D5 C5 A4 F4 | E4 G#4 B4 E5',
      B: '@bass !10 L48 | A2 E3 | F2 C3 | D2 A2 | E2 B2',
    }, 'rise'),
    pattern({
      A: '@pluck !10 L12 | E5 A5 E5 A5 C6 A5 E5 A5 | C5 F5 C5 F5 A5 F5 C5 F5 | D5 F5 D5 F5 A5 F5 D5 F5 | E5 G#5 E5 G#5 B5 G#5 E5 G#5',
      B: '@bass !10 L48 | A2 E3 | F2 C3 | D2 A2 | E2 B2',
    }, 'shimmer'),
  ], [0, 1, 0, 1], 0),
  jingle: song([
    pattern({
      A: '@organ !12 L12 | C5 E5 G5 C6 -:12 G5 C6:36',
      B: '@bass !12 L24 | C3 G3 C4 -:12 C3:24',
      C: '@pluck !9 L12 | E4 G4 C5 E5 -:12 C5 E5:36',
    }, 'fanfare'),
  ], [0], null),
};

// ── the sky map (cell row r = tile r; a few stars in rows 1..12) ───────────────────────────────────────────────────────────────────────
let seed = 11;
const rnd = () => { seed = (seed * 25173 + 13849) & 0xFFFF; return seed / 65536; };
const cells = [];
for (let r = 0; r < 24; r++) for (let c = 0; c < 32; c++) {
  const v = rnd();
  cells.push(r >= 1 && r <= STAR_ROWS && v < 0.05 + 0.012 * (STAR_ROWS - r) ? T.star + r - 1 : r);
}

const assets = {
  scenes: { play: { display: 'fine' } },
  sprites: {
    gem0: sprite(GEM, GEM_INKS[0], { hot: [2, 0, 12, 16], phases: 1 }),
    gem1: sprite(GEM, GEM_INKS[1], { hot: [2, 0, 12, 16], phases: 1 }),
    gem2: sprite(GEM, GEM_INKS[2], { hot: [2, 0, 12, 16], phases: 1 }),
    gem3: sprite(GEM, GEM_INKS[3], { hot: [2, 0, 12, 16], phases: 1 }),
    cat0: sprite(CATCHER, CAT_INKS[0], { hot: [0, 0, 16, 8], phases: 4 }),
    cat1: sprite(CATCHER, CAT_INKS[1], { hot: [0, 0, 16, 8], phases: 4 }),
    cat2: sprite(CATCHER, CAT_INKS[2], { hot: [0, 0, 16, 8], phases: 4 }),
    cat3: sprite(CATCHER, CAT_INKS[3], { hot: [0, 0, 16, 8], phases: 4 }),
  },
  tilesets: { prism: { tiles: Array.from({ length: Math.max(...Object.keys(tiles).map(Number)) + 1 }, (_, i) => tiles[i] ?? tileRows(Array(8).fill(0), 7, () => [0, 0], 0)) } },
  sfx,
  maps: { sky: { w: 32, h: 24, cells } },
  music,
};
const json = JSON.stringify(assets, null, 1) + '\n';

// what prism.arc repeats by hand: the tile numbers and the sky's per-row paper and BRIGHT
const ARC = join(HERE, 'prism.arc');
const arcTruths = { TSTAR: T.star, THEART: T.heart, TBURST: T.burst };
const arcLists = { SKYP, SKYB };
function checkArc() {
  if (!existsSync(ARC)) return [];
  const text = readFileSync(ARC, 'utf8'), bad = [];
  for (const [k, v] of Object.entries(arcTruths)) {
    const m = new RegExp(`^\\s*CONST ${k} = (\\d+)`, 'm').exec(text);
    if (!m || Number(m[1]) !== v) bad.push(`prism.arc: CONST ${k} should be ${v}${m ? `, is ${m[1]}` : ' (missing)'}`);
  }
  for (const [k, v] of Object.entries(arcLists)) {
    const m = new RegExp(`^\\s*DIM ${k.toLowerCase()}\\(23\\) = ([0-9, ]+)`, 'm').exec(text);
    const want = v.join(', ');
    if (!m || m[1].replace(/\s+/g, '').trim() !== want.replace(/\s+/g, '')) bad.push(`prism.arc: DIM ${k.toLowerCase()}(23) should be ${want}${m ? `, is ${m[1].trim()}` : ' (missing)'}`);
  }
  return bad;
}
const OUT = join(HERE, 'prism.assets.json');
if (CHECK) {
  const bad = checkArc();
  if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== json) bad.push('prism.assets.json is out of date: node arcade/examples/prism.assets.gen.mjs');
  if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
  console.log('prism.assets.json is current; prism.arc agrees with the generator');
} else {
  writeFileSync(OUT, json);
  const bad = checkArc();
  const phases = Object.values(assets.sprites).reduce((n, s) => n + s.phases, 0);
  console.log(`prism.assets.json: ${Object.keys(assets.sprites).length} sprites (${phases} phases), ${assets.tilesets.prism.tiles.length} tiles, ${Object.keys(sfx).length} effects, a 32 x 24 sky; ${Object.entries(music).map(([k, v]) => describe(k, v)).join('; ')}`);
  console.log(`SKYP = ${SKYP.join(', ')}\nSKYB = ${SKYB.join(', ')}`);
  if (bad.length) console.log('NOTE (prism.arc to be updated):\n' + bad.join('\n'));
}
