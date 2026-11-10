#!/usr/bin/env node
"use strict";
// platformer.assets.gen.mjs -- draws the art, the level and the sounds of platformer.arc ("Leap Runner") and writes platformer.assets.json
// next to this file.   node arcade/examples/platformer.assets.gen.mjs            (writes the json; the output is the same every time)
//                       node arcade/examples/platformer.assets.gen.mjs --ascii    (prints the tiles, the sprite frames and the level)
//                       node arcade/examples/platformer.assets.gen.mjs --data     (prints the DIM lines of the level data that platformer.arc carries)
//
// Asset names all start with "pf-" (pf-hero, pf-walker, pf-bat, pf-coin, pf-tiles, pf-world, pf-jump ...), so that the tests can merge them into the shared
// ASSETS of tests/arcade-m6-common.mjs without clashing with the names of the test programs.
// ART CONVENTIONS. Everything is ASCII: '#' = a lit pixel (ink), '-' = a covered but unlit pixel (paper: it hides what is behind the sprite
// and shows the paper colour of the cell), '.' = transparent (sprites) or paper (tiles). A sprite is coloured from the screen cell under it
// (it takes that cell's ink and paper), so the heroes are one-colour silhouettes with '-' highlights; the colour of the sky tile (ink 0 black,
// paper 5 cyan, BRIGHT) is the colour every sprite has. Tiles take their attribute from the first row.
//
// WORLD (128 x 16 cells, the band layout of platformer.arc is BAND 2 / 3 / 11 at 1/4, 1/2, 1/1):
//   rows 0-1   far band: distant mountains, blue paper (ONE paper colour), cyan ink                  - tiles 10..13
//   rows 2-4   mid band: clouds, cyan paper (the sky of the gameplay band), white ink                - tiles 14..17
//   rows 5-15  gameplay band (88 px): ground rows 14-15, platforms, spikes, coins, the flag
// Gameplay tiles: 0 sky, 1 grass (solid), 2 dirt (solid), 3 brick (solid), 4 plank (one-way, flag bit 3), 5 spikes (hazard), 6 coin (pickup),
// 7 pole (goal), 8 flag (goal), 9 sign (decoration).  Flags: bit0 solid 1, bit1 hazard 2, bit2 pickup 4, bit3 one-way 8, bit4 goal 16.
// ART RULES (arcade/spike/scroll/parallax/RESULTS.md): every cell a sprite can pass over in the gameplay band has the sky's paper (cyan, BRIGHT)
// - the sky, the plank (the sky's attribute exactly), the sign, the spikes and the flag (their own ink, cyan paper); the ground, the brick and
// the island tiles have their own colours, but a sprite is never drawn over them (it stands on them, the collision stops it a pixel above).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;      // false when a test imports LEVEL

// ── tiles ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const bitsOf = (row) => { if (row.length !== 8) throw new Error(`tile row "${row}" is not 8 wide`); return parseInt([...row].map((c) => (c === '#' ? '1' : '0')).join(''), 2); };
const tile = (art, ink, paper, bright, flags = 0) => {
  if (art.length !== 8) throw new Error('tile is not 8 rows');
  return { art, flags, rows: art.map((r) => ({ bits: bitsOf(r).toString(16).toUpperCase().padStart(2, '0'), ink, paper, bright })) };
};
export const FLAG = { SOLID: 1, HAZARD: 2, PICKUP: 4, ONEWAY: 8, GOAL: 16 };

const SKY = ['........', '........', '........', '........', '........', '........', '........', '........'];
const TILES = [
  /* 0 */ tile(SKY, 0, 5, 1),
  /* 1 grass */ tile(['########', '########', '########', '#.##.#.#', '........', '.....#..', '........', '..#.....'], 4, 2, 0, FLAG.SOLID),
  /* 2 dirt */ tile(['........', '..#...#.', '........', '#....#..', '........', '...#...#', '.#......', '........'], 6, 2, 0, FLAG.SOLID),
  /* 3 brick */ tile(['########', '...#....', '...#....', '...#....', '########', '#.......', '#.......', '#.......'], 6, 2, 1, FLAG.SOLID),
  /* 4 plank: the sky's own attribute, so a sprite crossing it keeps its colour */ tile(['########', '#.#.#.#.', '########', '.#....#.', '........', '........', '........', '........'], 0, 5, 1, FLAG.ONEWAY),
  /* 5 spikes */ tile(['........', '........', '........', '..#...#.', '..#...#.', '.###.###', '.###.###', '########'], 7, 5, 1, FLAG.HAZARD),
  /* 6 coin (the static picture; the spinning sprite is drawn over it) */ tile(['..####..', '.#.##.#.', '#..##..#', '#..##..#', '#..##..#', '#..##..#', '.#.##.#.', '..####..'], 6, 5, 1, FLAG.PICKUP),
  /* 7 pole */ tile(['...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...'], 7, 5, 1, FLAG.GOAL),
  /* 8 flag */ tile(['...#####', '...#####', '...####.', '...###..', '...##...', '...##...', '...##...', '...##...'], 2, 5, 1, FLAG.GOAL),
  /* 9 sign */ tile(['........', '..#####.', '..##..##', '..#####.', '....#...', '....#...', '....#...', '....#...'], 0, 5, 1),
  // far band: blue paper, cyan ink (a mountain is two rows of the same 45 degree slope)
  /* 10 */ tile(SKY, 5, 1, 0),
  /* 11 slope up */ tile(['.......#', '......##', '.....###', '....####', '...#####', '..######', '.#######', '########'], 5, 1, 0),
  /* 12 slope down */ tile(['#.......', '##......', '###.....', '####....', '#####...', '######..', '#######.', '########'], 5, 1, 0),
  /* 13 fill */ tile(['########', '########', '########', '########', '########', '########', '########', '########'], 5, 1, 0),
  // mid band: cyan paper (the gameplay sky), white clouds
  /* 14 */ tile(SKY, 7, 5, 1),
  /* 15 cloud left */ tile(['........', '........', '....###.', '..######', '.#######', '########', '########', '.#######'], 7, 5, 1),
  /* 16 cloud middle */ tile(['........', '........', '........', '########', '########', '########', '########', '########'], 7, 5, 1),
  /* 17 cloud right */ tile(['........', '........', '.###....', '######..', '#######.', '########', '########', '#######.'], 7, 5, 1),
];
export const T = { SKY: 0, GRASS: 1, DIRT: 2, BRICK: 3, PLANK: 4, SPIKES: 5, COIN: 6, POLE: 7, FLAG: 8, SIGN: 9, F_BLANK: 10, F_UP: 11, F_DOWN: 12, F_FILL: 13, M_BLANK: 14, CLOUD_L: 15, CLOUD_M: 16, CLOUD_R: 17 };

// ── the level ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const COLS = 128, ROWS = 16;
export function buildLevel() {
  const g = Array.from({ length: ROWS }, () => new Array(COLS).fill(T.SKY));
  const put = (c, r, t) => { if (c >= 0 && c < COLS && r >= 0 && r < ROWS) g[r][c] = t; };
  const ground = (c0, c1, top) => { for (let c = c0; c <= c1; c++) { put(c, top, T.GRASS); for (let r = top + 1; r < ROWS; r++) put(c, r, T.DIRT); } };
  const run = (c0, c1, r, t) => { for (let c = c0; c <= c1; c++) put(c, r, t); };
  // far band: mountains (rows 0-1); mid band: clouds (rows 2-4)
  for (let c = 0; c < COLS; c++) { put(c, 0, T.F_BLANK); put(c, 1, T.F_BLANK); for (let r = 2; r <= 4; r++) put(c, r, T.M_BLANK); }
  const mountain = (c, plateau) => {      // base at columns c..c+w-1: row 1 is slope-up, fill, slope-down; row 0 sits one cell inside
    const w = plateau ? 6 : 4;
    put(c, 1, T.F_UP); put(c + w - 1, 1, T.F_DOWN); for (let k = 1; k < w - 1; k++) put(c + k, 1, T.F_FILL);
    put(c + 1, 0, T.F_UP); put(c + w - 2, 0, T.F_DOWN); for (let k = 2; k < w - 2; k++) put(c + k, 0, T.F_FILL);
  };
  [[1, 0], [6, 1], [14, 0], [19, 0], [26, 1], [34, 0], [40, 1], [48, 0]].forEach(([c, p]) => mountain(c, p));      // the far band shows at most 50 columns (832 / 4 + 192 px)
  const cloud = (c, r, w) => { put(c, r, T.CLOUD_L); for (let k = 1; k < w - 1; k++) put(c + k, r, T.CLOUD_M); put(c + w - 1, r, T.CLOUD_R); };
  [[2, 2, 3], [9, 3, 4], [17, 2, 3], [24, 4, 3], [31, 2, 5], [40, 3, 3], [47, 2, 4], [56, 4, 3], [63, 2, 3], [70, 3, 4], [78, 2, 3], [84, 4, 4], [92, 3, 3], [100, 2, 5], [108, 4, 3], [114, 2, 3]].forEach(([c, r, w]) => cloud(c, r, w));   // up to column ~76 is read at 1/2
  // gameplay band: terrain (ground tops as rows: 14 = y 112; a step up is a smaller row)
  ground(0, 29, 14);
  ground(34, 55, 14);
  ground(56, 59, 13);
  ground(60, 69, 12);
  ground(70, 73, 13);
  ground(74, 75, 14);
  ground(102, 127, 14);
  // islands over the long pit (cols 76..101): brick and planks
  run(79, 82, 13, T.BRICK);
  run(86, 89, 12, T.BRICK);
  run(93, 96, 12, T.PLANK);
  run(99, 101, 13, T.BRICK);
  // platforms and hazards
  run(38, 41, 11, T.BRICK);        // a brick platform, 3 tiles up
  run(44, 47, 11, T.PLANK);        // a plank to jump onto and to drop through
  run(49, 50, 13, T.SPIKES);
  run(64, 67, 9, T.PLANK);        // a plank over the high ground, 3 tiles up
  run(108, 109, 13, T.SPIKES);
  run(114, 115, 12, T.BRICK); run(114, 115, 13, T.BRICK);              // a two-high wall
  g[13][4] = T.SIGN;
  // the flag: pole rows 8..13, flag at the top, on the ground at column 122
  put(122, 8, T.FLAG); for (let r = 9; r <= 13; r++) put(122, r, T.POLE);
  // coins (pickup tiles); the list is what platformer.arc carries as CXS / CYS
  const coins = [];
  const coin = (c, r) => { put(c, r, T.COIN); coins.push([c, r]); };
  [8, 9, 10].forEach((c) => coin(c, 13));
  coin(12, 11); coin(13, 10); coin(14, 10); coin(15, 11);
  coin(24, 13); coin(25, 13);
  [38, 39, 40, 41].forEach((c) => coin(c, 10));
  [44, 45, 46, 47].forEach((c) => coin(c, 10));
  coin(53, 12); coin(54, 11); coin(55, 12);
  coin(58, 12); coin(62, 10); coin(63, 10);
  [64, 65, 66, 67].forEach((c) => coin(c, 8));
  coin(71, 12); coin(72, 12);
  [80, 81].forEach((c) => coin(c, 12));
  coin(77, 10); coin(78, 10);
  [87, 88].forEach((c) => coin(c, 11));
  [94, 95].forEach((c) => coin(c, 11));
  coin(90, 9); coin(91, 9);
  [100, 101].forEach((c) => coin(c, 12));
  coin(104, 13); coin(105, 13); coin(106, 12); coin(111, 12); coin(112, 12);
  coin(114, 10); coin(115, 10);
  coin(118, 13); coin(119, 13);
  coins.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // enemies: [x px, y px, type] (type 0 walker, 1 flyer); a walker's y is the ground top - 16; sorted by x
  const top = (c) => { for (let r = 5; r < ROWS; r++) if (g[r][c] === T.GRASS || g[r][c] === T.BRICK) return r; return 16; };
  const walker = (c) => [c * 8, top(c) * 8 - 16, 0];
  const flyer = (c, y) => [c * 8, y, 1];
  const spawns = [walker(20), walker(36), flyer(46, 56), flyer(62, 56), walker(58), walker(66), walker(88), flyer(80, 64), flyer(100, 56), walker(110), walker(118)];
  spawns.sort((a, b) => a[0] - b[0]);
  const checkpoints = [[52 * 8, 88], [74 * 8, 88], [104 * 8, 88]];       // [x, y] of the player's sprite (feet on the ground)
  return { g, coins, spawns, checkpoints, goalX: 122 * 8, start: [24, 88] };
}
export const LEVEL = buildLevel();

// ── sprites ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const maskOfRow = (r) => [...r].map((c) => (c === '#' || c === '-' ? '1' : '0')).join('');
function sprite(frames, { hot, phases, ink = 0, paper = 5, bright = 1 }) {
  const h = frames[0].length, w = frames[0][0].length;
  const hex = (bin) => parseInt(bin, 2).toString(16).toUpperCase().padStart(w / 4, '0');
  for (const f of frames) { if (f.length !== h) throw new Error('frame heights differ'); for (const r of f) if (r.length !== w) throw new Error(`sprite row "${r}" is ${r.length} wide, not ${w}`); }
  return { w, h, hot, phases, frames: frames.map((f) => ({ rows: f.map((r) => ({ bits: hex([...r].map((c) => (c === '#' ? '1' : '0')).join('')), mask: hex(maskOfRow(r)), ink, paper, bright })) })) };
}

// The hero: 16 x 24, facing right; head (8 rows) + body (8 rows) + legs (8 rows); '-' = the sky colour inside the silhouette (face, shirt)
const HEAD = [
  '.....######.....',
  '....########....',
  '...##########...',
  '...###-----####.',
  '...#--#--#--##..',
  '...#----------#.',
  '....#--####--#..',
  '.....########...',
];
const HEAD_HURT = [
  '.....######.....',
  '....########....',
  '...##########...',
  '...###-----####.',
  '...#-#-#-#--##..',
  '...#--#-#---##..',
  '....#-######-#..',
  '.....########...',
];
const BODY = [      // arms hang apart from the body
  '..###########...',
  '.####-####-####.',
  '.####-####-####.',
  '.##..-####-..##.',
  '.##..######..##.',
  '.##...####...##.',
  '..#...-##-...#..',
  '.....######.....',
];
const BODY_ARMS_UP = [
  '.##.#########.##',
  '.##.#-####-#.##.',
  '.####-####-###..',
  '..###-####-##...',
  '....########....',
  '.....######.....',
  '.....-####-.....',
  '.....######.....',
];
const BODY_ARMS_OUT = [
  '##..#########..#',
  '.##.#-####-#.##.',
  '..#########.##..',
  '...#-####-#.....',
  '....########....',
  '.....######.....',
  '.....-####-.....',
  '.....######.....',
];
const LEGS = {
  stand: ['....###..###....', '....###..###....', '....###..###....', '....###..###....', '....###..###....', '....###..###....', '...####..####...', '..#####..#####..'],
  walkA: ['....###..###....', '....###...###...', '...###.....###..', '...###......##..', '..###.......###.', '..###.........#.', '.####.......####', '.####...........'],
  walkB: ['.....#####......', '.....#####......', '.....#####......', '.....#####......', '.....#####......', '.....#####......', '....######......', '....#######.....'],
  walkC: ['....###..###....', '...###..###.....', '..###....###....', '..##.....###....', '.###......###...', '.#........###...', '####.....####...', '..........####..'],
  jump: ['....#######.....', '...#########....', '...###...###....', '...###...###....', '....###.###.....', '.....#####......', '....######......', '...#######......'],
  fall: ['...###....###...', '...###....###...', '..###......###..', '..###......###..', '.###........###.', '.###........###.', '####........####', '####........####'],
};
const HERO_FRAMES = [
  [...HEAD, ...BODY, ...LEGS.stand],            // 0 idle
  [...HEAD, ...BODY, ...LEGS.walkA],            // 1..4 walk
  [...HEAD, ...BODY, ...LEGS.walkB],
  [...HEAD, ...BODY, ...LEGS.walkC],
  [...HEAD, ...BODY, ...LEGS.walkB],
  [...HEAD, ...BODY_ARMS_UP, ...LEGS.jump],     // 5 jump (rising)
  [...HEAD, ...BODY_ARMS_OUT, ...LEGS.fall],    // 6 fall
  [...HEAD_HURT, ...BODY_ARMS_UP, ...LEGS.fall], // 7 hurt
];

// The walker: a round-headed creature with two feet, 16 x 16, facing right (frame 0 and 1: the feet alternate)
const WALKER = [
  [
    '................',
    '................',
    '.....######.....',
    '...##########...',
    '..############..',
    '.####--##--####.',
    '.####-#-##-#-##.',
    '.##############.',
    '..############..',
    '...##########...',
    '...##########...',
    '....########....',
    '...###....###...',
    '..####....####..',
    '..###......###..',
    '................',
  ],
  [
    '................',
    '................',
    '.....######.....',
    '...##########...',
    '..############..',
    '.####--##--####.',
    '.####-#-##-#-##.',
    '.##############.',
    '..############..',
    '...##########...',
    '...##########...',
    '....########....',
    '....###..###....',
    '...####..####...',
    '...###....###...',
    '................',
  ],
];
// The flyer: a bat, 16 x 16, wings up (0) and down (1)
const FLYER = [
  [
    '#..............#',
    '##............##',
    '###...####...###',
    '####.######.####',
    '#####-####-#####',
    '######-##-######',
    '.#####.##.#####.',
    '..###########...',
    '...#########....',
    '....#######.....',
    '.....#####......',
    '......###.......',
    '................',
    '................',
    '................',
    '................',
  ],
  [
    '................',
    '................',
    '................',
    '.....#....#.....',
    '....###..###....',
    '.#.#-####-#.#...',
    '###########-###.',
    '#############-##',
    '.#####.##.#####.',
    '..###########...',
    '...#########....',
    '....#######.....',
    '.....#####......',
    '......###.......',
    '................',
    '................',
  ],
];
// The spinning coin, 8 x 8, four frames over the coin tile: it covers the whole cell (mask = 8 x 8) so that the tile's picture does not show
const COIN_ART = [
  ['..####..', '.#.##.#.', '#..##..#', '#..##..#', '#..##..#', '#..##..#', '.#.##.#.', '..####..'],
  ['..####..', '.#-##-#.', '.#-##-#.', '.#-##-#.', '.#-##-#.', '.#-##-#.', '.#-##-#.', '..####..'],
  ['...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...', '...##...'],
  ['..####..', '.#-##-#.', '.#-##-#.', '.#-##-#.', '.#-##-#.', '.#-##-#.', '.#-##-#.', '..####..'],
].map((f, k) => (k === 0 ? f : f.map((r) => [...r].map((c) => (c === '.' ? '-' : c)).join(''))));
// frame 0: the mask is the full 8 x 8 too (paper pixels '-' where the coin is hollow or the cell is empty)
COIN_ART[0] = COIN_ART[0].map((r) => [...r].map((c) => (c === '.' ? '-' : c)).join(''));
const COIN_WHOLE = COIN_ART.map((f) => f.map((r) => [...r].map((c) => (c === '#' ? '#' : '-')).join('')));

// ── sound ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ticks = (n, f) => Array.from({ length: n }, (_, k) => f(k));
const sfx = {
  jump: { ticks: ticks(7, (k) => ({ tone: 300 - 28 * k, vol: 12 - k, noise: 0, mix: 6 })) },
  coin: { ticks: [...ticks(3, (k) => ({ tone: 120, vol: 13 - k, noise: 0, mix: 6 })), ...ticks(7, (k) => ({ tone: 80, vol: 12 - k, noise: 0, mix: 6 }))] },
  stomp: { ticks: ticks(8, (k) => ({ tone: 0, vol: Math.max(0, 14 - 2 * k), noise: 6 + 2 * k, mix: 5 })) },
  hurt: { ticks: ticks(12, (k) => ({ tone: 200 + 30 * k, vol: 13 - Math.floor(k / 2), noise: 0, mix: 6 })) },
  win: { ticks: ticks(16, (k) => ({ tone: [200, 160, 135, 100][Math.floor(k / 2) % 4] - (k >= 8 ? 20 : 0), vol: 13 - Math.floor(k / 3), noise: 0, mix: 6 })) },
  over: { ticks: ticks(16, (k) => ({ tone: 120 + 20 * k, vol: Math.max(2, 13 - k), noise: 0, mix: 6 })) },
};

// ── assets ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function buildAssets() {
  const cells = [];
  for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) cells.push(LEVEL.g[r][c]);
  return {
    sprites: {
      'pf-hero': sprite(HERO_FRAMES, { hot: [3, 2, 10, 22], phases: 2 }),
      'pf-walker': sprite(WALKER, { hot: [1, 4, 14, 12], phases: 4 }),
      'pf-bat': sprite(FLYER, { hot: [2, 3, 12, 10], phases: 4 }),
      'pf-coin': sprite(COIN_WHOLE, { hot: [0, 0, 8, 8], phases: 8, ink: 6 }),
    },
    tilesets: { 'pf-tiles': { tiles: TILES.map((t) => ({ rows: t.rows, flags: t.flags })) } },
    sfx: Object.fromEntries(Object.entries(sfx).map(([k, v]) => ['pf-' + k, v])),
    maps: { 'pf-world': { w: COLS, h: ROWS, cells } },
  };
}

if (MAIN) {
  if (process.argv.includes('--ascii')) {
    const show = (name, rows) => { console.log(`-- ${name}`); rows.forEach((r) => console.log(r)); };
    HERO_FRAMES.forEach((f, i) => show(`hero ${i}`, f));
    WALKER.forEach((f, i) => show(`walker ${i}`, f));
    FLYER.forEach((f, i) => show(`flyer ${i}`, f));
    TILES.forEach((t, i) => show(`tile ${i} (flags ${t.flags}, ink ${t.rows[0].ink} paper ${t.rows[0].paper})`, t.art));
    console.log('-- level (rows 5..15, columns in tens)');
    const ch = { [T.SKY]: ' ', [T.GRASS]: 'G', [T.DIRT]: 'd', [T.BRICK]: 'B', [T.PLANK]: '=', [T.SPIKES]: '^', [T.COIN]: 'o', [T.POLE]: '|', [T.FLAG]: 'F', [T.SIGN]: 'S' };
    for (let r = 5; r < ROWS; r++) console.log(String(r).padStart(2) + ' ' + LEVEL.g[r].map((t) => ch[t] ?? '?').join(''));
    console.log('   ' + Array.from({ length: COLS }, (_, c) => (c % 10 === 0 ? String(c / 10 % 10) : ' ')).join(''));
    console.log('spawns', JSON.stringify(LEVEL.spawns), 'checkpoints', JSON.stringify(LEVEL.checkpoints));
    process.exit(0);
  }
  if (process.argv.includes('--data')) {
    const arr = (name, vals) => console.log(`  DIM ${name}(${vals.length - 1}) = ${vals.join(', ')}`);
    arr('cxs', LEVEL.coins.map(([c]) => c * 8)); arr('cys', LEVEL.coins.map(([, r]) => r * 8));
    arr('sx', LEVEL.spawns.map((s) => s[0])); arr('sy', LEVEL.spawns.map((s) => s[1])); arr('sty', LEVEL.spawns.map((s) => s[2]));
    arr('ckx', LEVEL.checkpoints.map((c) => c[0])); arr('cky', LEVEL.checkpoints.map((c) => c[1]));
    console.log(`  REM ${LEVEL.coins.length} coins, ${LEVEL.spawns.length} enemies, goal at x ${LEVEL.goalX}`);
    process.exit(0);
  }
  const assets = buildAssets();
  writeFileSync(join(HERE, 'platformer.assets.json'), JSON.stringify(assets, null, 1) + '\n');
  console.log(`platformer.assets.json: ${Object.keys(assets.sprites).length} sprites (hero ${assets.sprites['pf-hero'].frames.length} frames), ${TILES.length} tiles, ${Object.keys(assets.sfx).length} sound effects, a ${COLS} x ${ROWS} world with ${LEVEL.coins.length} coins and ${LEVEL.spawns.length} enemies`);
}
