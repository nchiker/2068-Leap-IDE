#!/usr/bin/env node
"use strict";
// vaults.assets.gen.mjs -- draws the art, the maze and the sounds of vaults.arc ("Vaults") and writes vaults.assets.json next to this file.
//   node arcade/examples/vaults.assets.gen.mjs            (writes the json; the output is the same every time)
//   node arcade/examples/vaults.assets.gen.mjs --ascii    (prints the maze, the sprite frames and the tiles)
//   node arcade/examples/vaults.assets.gen.mjs --data     (prints the CONST / DIM lines of the level data that vaults.arc carries)
//
// Asset names all start with "vl_" (vl_maze, vl_panel, vl_wraith, vl_gem ...), so that the tests can merge them into a shared ASSETS without clashing.
// ART CONVENTIONS (as platformer.assets.gen.mjs). '#' = a lit pixel (ink), '-' = a covered but unlit pixel (paper: it hides what is behind the sprite and shows
// the paper colour of the cell), '.' = transparent (sprites) or paper (tiles). In the 3D view a billboard is drawn in the colours of the window cell under it
// (it never writes attributes): the ink of the view (white) on the ceiling's paper in the top six cell rows and on the floor's paper in the bottom six. So every
// billboard is a one-colour shape; the '-' pixels are what make eyes and facets.
//
// THE MAZE (32 x 32 cells, the VIEW3D map): hand-drawn below as text. Wall types: 1 grey stone (the outer ring and the pillars), 2 brick (the room walls),
// 3 vault lining (the treasure vault), 4 the locked door (one cell; the game opens it with SETWALL when you have the key). Letters mark things standing on the
// floor and are turned into '.' in the map: P the start, K the key, T the treasure, E a wraith, G a gem, H a health potion.
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;      // false when a test imports LAYOUT and friends

// ── the maze ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// Nine rooms of a 3 x 3 grid (the separating walls are at columns 10 and 21 and rows 10 and 21), joined by single-cell gaps, each room with its own furniture.
// The start hall is bottom left (P); the key is in the top left room (K) behind a wraith; the vault (3-walls, the door 4 in its south wall) is in the top right,
// reached through the antechamber below it; the treasure T is inside.
export const LAYOUT = [
  '11111111111111111111111111111111',   //  0
  '1.K.......2..........2..33333331',   //  1
  '1......E..2..........2..3.....31',   //  2
  '1222222...2..1.1.1.1.2..3..T..31',   //  3
  '1.........2.............3G...G31',   //  4   (the gap at column 21 leads into the antechamber)
  '1..11................2..33343331',   //  5   (the gap at column 10 joins the key room to the colonnade; the door is the 4)
  '1..11.....2..1.1.1.1.2.........1',   //  6
  '1.........2..........2.....E...1',   //  7
  '1..G......2.....E....2.........1',   //  8
  '1.........2..1.1.1.1.2.........1',   //  9
  '12222.222222222.2222222222.22221',   // 10   (gaps at columns 5, 15, 26)
  '1.........2..........2.........1',   // 11
  '1..H......2..........2.........1',   // 12
  '1.2222222.2...2222...2..222.22.1',   // 13
  '1.........2...2..2...2.........1',   // 14
  '1.............2.G2...2.........1',   // 15   (the gap at column 10 joins the west room to the central hall; G inside the little tomb)
  '12222222..2...2..2.............1',   // 16   (the gap at column 21 joins the central hall to the east room)
  '1.........2...2..2...2.22.22.221',   // 17
  '1.......G.2...2.22...2.........1',   // 18
  '1.........2..........2...E.....1',   // 19
  '1.........2..........2.........1',   // 20
  '12222.2222222222.22222222.222221',   // 21   (gaps at columns 5, 16, 25)
  '1.........2..........2.........1',   // 22
  '1..1...1..2..........2..1...1..1',   // 23
  '1.........222222222..2.........1',   // 24
  '1.........2..........2.........1',   // 25
  '1..1...1.............2..1...1..1',   // 26   (the gap at column 10 joins the start hall to the south room)
  '1.........2....................1',   // 27   (the gap at column 21 joins the south room to the south-east room)
  '1.P.......2..222222222..H......1',   // 28
  '1.........2..........2.........1',   // 29
  '1..1...1..2.....H....2...E.....1',   // 30
  '11111111111111111111111111111111',   // 31
];

// ── a plain description of what is in the layout ────────────────────────────────────────────────────────────────────────────────
export const MAP_W = 32, MAP_H = 32;
/** wall types 0..4 of the 32 x 32 map (row-major) and the positions (8.8, the centre of the cell) of everything the letters mark */
export function readLayout(rows = LAYOUT) {
  if (rows.length !== MAP_H) throw new Error(`the layout has ${rows.length} rows, not ${MAP_H}`);
  const cells = [], things = { P: [], K: [], T: [], E: [], G: [], H: [] };
  rows.forEach((row, y) => {
    if (row.length !== MAP_W) throw new Error(`layout row ${y} is ${row.length} wide, not ${MAP_W}`);
    [...row].forEach((ch, x) => {
      if (ch >= '1' && ch <= '4') cells.push(Number(ch));
      else if (ch === '.') cells.push(0);
      else if (things[ch]) { things[ch].push([x * 256 + 128, y * 256 + 128]); cells.push(0); }
      else throw new Error(`layout row ${y} column ${x}: unknown character "${ch}"`);
    });
  });
  return { cells, things };
}
const readOnce = readLayout();
export const CELLS = readOnce.cells;
export const THINGS = readOnce.things;
/** the one cell of wall type 4 */
export const DOOR = (() => { const i = CELLS.indexOf(4); return [(i % MAP_W) * 256 + 128, ((i / MAP_W) | 0) * 256 + 128]; })();

// ── tiles (the HUD panel around the 3D window) ───────────────────────────────────────────────────────────────────────────────────
const bitsOf = (row) => { if (row.length !== 8) throw new Error(`tile row "${row}" is not 8 wide`); return parseInt([...row].map((c) => (c === '#' ? '1' : '0')).join(''), 2); };
const tile = (art, ink, paper, bright, flags = 0) => {
  if (art.length !== 8) throw new Error('tile is not 8 rows');
  return { art, flags, rows: art.map((r) => ({ bits: bitsOf(r).toString(16).toUpperCase().padStart(2, '0'), ink, paper, bright })) };
};
const BLANK = ['........', '........', '........', '........', '........', '........', '........', '........'];
const SOLID = ['########', '########', '########', '########', '########', '########', '########', '########'];
// the aiming marks: a triangle pointing at the centre of the window, drawn as two half tiles side by side (down: left half, right half; the sideways pair stacks)
const TRI_DOWN_L = ['........', '#.......', '###.....', '#####...', '#######.', '########', '........', '........'].map((r, i) => (i === 0 ? '########' : r));
const mirror = (art) => art.map((r) => [...r].reverse().join(''));
const transpose = (art) => art[0].split('').map((_, c) => art.map((r) => r[c]).join(''));
const TRI_DOWN_L2 = ['########', '.#######', '..######', '...#####', '....####', '.....###', '......##', '.......#'];     // the left half of a wedge pointing down
const WEDGE = {
  downL: TRI_DOWN_L2, downR: mirror(TRI_DOWN_L2),
  upL: [...TRI_DOWN_L2].reverse(), upR: mirror([...TRI_DOWN_L2].reverse()),
  rightT: transpose(TRI_DOWN_L2), rightB: [...transpose(TRI_DOWN_L2)].reverse(),
  leftT: mirror(transpose(TRI_DOWN_L2)), leftB: [...mirror(transpose(TRI_DOWN_L2))].reverse(),
};
void TRI_DOWN_L;
// the title's art. Wall textures after the renderer's four wall types (1 grey stone, 2 brick, 3 vault lining, 4 the locked door), as 8 x 8 tiles.
const BRICK = ['########', '#...#...', '#...#...', '#...#...', '########', '..#...#.', '..#...#.', '..#...#.'];
const STONE = ['#.#.#.#.', '.#.#.#.#', '#.#.#.#.', '.#.#.#.#', '#.#.#.#.', '.#.#.#.#', '#.#.#.#.', '.#.#.#.#'];
const LINING = ['########', '........', '########', '........', '########', '........', '########', '........'];
const DOOR_BARS = ['##..##..', '##..##..', '##..##..', '##..##..', '##..##..', '##..##..', '##..##..', '##..##..'];
const GEM_GLINT = ['...##...', '#..##..#', '.######.', '########', '.######.', '#..##..#', '...##...', '........'];
// The goblet is the treasure sprite's art (16 x 16, both frames) cut into four tiles; only the top left tile differs between the two frames (the glint).
const ctr = (r) => { const l = Math.floor((16 - r.length) / 2); return '.'.repeat(l) + r + '.'.repeat(16 - r.length - l); };
const GOB_ROWS = ['', '', '##############', '#-############', '#-###########-', '#-##########-#', '##--------####', '############', '########', '####', '####', '####', '######', '##########', '############', ''].map(ctr);
const GOB_GLINT_ROWS = GOB_ROWS.map((r, y) => (y === 0 ? '.....#..........' : y === 1 ? '....###.........' : r));
const GOBLET_TILES = {
  tl0: GOB_ROWS.slice(0, 8).map((r) => r.slice(0, 8)), tl1: GOB_GLINT_ROWS.slice(0, 8).map((r) => r.slice(0, 8)),
  tr: GOB_ROWS.slice(0, 8).map((r) => r.slice(8)), bl: GOB_ROWS.slice(8).map((r) => r.slice(0, 8)), br: GOB_ROWS.slice(8).map((r) => r.slice(8)),
};
export const TILES = [
  /*  0 blank black */ tile(BLANK, 7, 0, 1),
  /*  1 panel: a sparse dark-blue dot pattern, the stone of the walls around the window */ tile(['........', '..#.....', '........', '......#.', '........', '.#......', '........', '....#...'], 1, 0, 1),
  /*  2 bezel: brass bricks round the window (BRIGHT 1 like every black-paper tile: bright black and plain black differ on some displays) */ tile(['########', '#.......', '#.......', '########', '...#....', '...#....', '########', '.......#'], 6, 0, 1),
  /*  3 bar, full */ tile(['........', '########', '########', '########', '########', '########', '########', '........'], 2, 0, 1),
  /*  4 bar, half */ tile(['........', '####....', '####....', '####....', '####....', '####....', '####....', '........'], 2, 0, 1),
  /*  5 bar, empty: a dark outline */ tile(['........', '########', '#......#', '#......#', '#......#', '#......#', '########', '........'], 1, 0, 1),
  /*  6 key icon */ tile(['..####..', '.#....#.', '.#....#.', '..####..', '...##...', '...###..', '...##...', '...###..'], 6, 0, 1),
  /*  7 key slot, empty */ tile(['........', '........', '........', '..#..#..', '........', '........', '..#..#..', '........'], 1, 0, 1),
  /*  8 gem icon */ tile(['........', '..####..', '.######.', '########', '.######.', '..####..', '...##...', '........'], 5, 0, 1),
  /*  9 gem slot, empty */ tile(['........', '........', '........', '...##...', '........', '........', '........', '........'], 1, 0, 1),
  /* 10..17 the aiming marks */
  /* 10 */ tile(WEDGE.downL, 7, 0, 1), /* 11 */ tile(WEDGE.downR, 7, 0, 1),
  /* 12 */ tile(WEDGE.upL, 7, 0, 1), /* 13 */ tile(WEDGE.upR, 7, 0, 1),
  /* 14 */ tile(WEDGE.rightT, 7, 0, 1), /* 15 */ tile(WEDGE.rightB, 7, 0, 1),
  /* 16 */ tile(WEDGE.leftT, 7, 0, 1), /* 17 */ tile(WEDGE.leftB, 7, 0, 1),
  // 18..: the title screen (the SCENE title NOVIEW picture): the maze's four wall textures as tiles, the glinting gem and the goblet (the treasure's art, in cells)
  /* 18 brick: the letters of the title (the room walls of the maze) */ tile(BRICK, 5, 0, 1),
  /* 19 stone: the outer ring (grey stone: a checker) */ tile(STONE, 5, 0, 1),
  /* 20 lining: the vault's scanlines */ tile(LINING, 5, 0, 1),
  /* 21 the locked door: vertical bars, in brass */ tile(DOOR_BARS, 6, 0, 1),
  /* 22 gem with a glint (the sparkle: tile 8 and this one swap) */ tile(GEM_GLINT, 7, 0, 1),
  /* 23 goblet, top left, plain / 24 with a glint / 25 top right / 26 bottom left / 27 bottom right */
  tile(GOBLET_TILES.tl0, 6, 0, 1), tile(GOBLET_TILES.tl1, 6, 0, 1), tile(GOBLET_TILES.tr, 6, 0, 1), tile(GOBLET_TILES.bl, 6, 0, 1), tile(GOBLET_TILES.br, 6, 0, 1),
];
export const T = {
  BLANK: 0, PANEL: 1, BEZEL: 2, BAR_FULL: 3, BAR_HALF: 4, BAR_EMPTY: 5, KEY: 6, KEY_SLOT: 7, GEM: 8, GEM_SLOT: 9,
  BRICK: 18, STONE: 19, LINING: 20, DOOR: 21, GLINT: 22, GOB_TL: 23, GOB_TL_GLINT: 24, GOB_TR: 25, GOB_BL: 26, GOB_BR: 27,
};

/** The screen cell map at boot: the panel stone everywhere, a bezel round the 16 x 12 window (cells 8..23 x 6..17), aiming marks in the middle of its four sides,
 *  a full health bar at (0..6, 8), the key slot at (3, 13) and the five gem slots at (25..29, 13). The window's own cells are never drawn from the map. */
export function buildPanel() {
  const W = 32, H = 24, g = Array.from({ length: H }, () => new Array(W).fill(T.PANEL));
  for (let y = 6; y <= 17; y++) for (let x = 8; x <= 23; x++) g[y][x] = T.BLANK;
  for (let x = 7; x <= 24; x++) { g[5][x] = T.BEZEL; g[18][x] = T.BEZEL; }
  for (let y = 6; y <= 17; y++) { g[y][7] = T.BEZEL; g[y][24] = T.BEZEL; }
  g[5][15] = 10; g[5][16] = 11; g[18][15] = 12; g[18][16] = 13; g[11][7] = 14; g[12][7] = 15; g[11][24] = 16; g[12][24] = 17;
  for (let x = 0; x < 7; x++) g[8][x] = T.BAR_FULL;
  g[13][3] = T.KEY_SLOT;
  for (let x = 25; x <= 29; x++) g[13][x] = T.GEM_SLOT;
  return { w: W, h: H, cells: g.flat() };
}

// ── the title screen (SCENE title NOVIEW): a full 32 x 24 cell picture, built from the tiles above ───────────────────────────────────────────────────────
// A vault room (stone ceiling and floor, walls from the lintel down; rows 0..19) with "VAULTS" in brick letters 4 x 5 cells, the goblet on a pedestal with gems round it (the
// sparkle swaps tile T.GEM and T.GLINT; the goblet's top left tile swaps with its glint), and a corridor below them where the game puts sprites (the key,
// two gems and a potion bob, a wraith patrols) in front of the locked vault door. Rows 20..23 are black for the text the game prints (the tagline is in
// the room, row 8). The cells the game animates are exported (GEM_CELLS, GOBLET_CELL) and printed by --data.
const LETTERS = {
  V: ['#..#', '#..#', '#..#', '.##.', '.##.'], A: ['.##.', '#..#', '####', '#..#', '#..#'], U: ['#..#', '#..#', '#..#', '#..#', '.##.'],
  L: ['#...', '#...', '#...', '#...', '####'], T: ['####', '.##.', '.##.', '.##.', '.##.'], S: ['.###', '#...', '.##.', '...#', '###.'],
};
export const GEM_CELLS = [[9, 12], [11, 11], [12, 13], [19, 13], [20, 11], [22, 12]];       // [column, row] of the six glinting gems round the goblet
export const GOBLET_CELL = [15, 10];                                                     // top left of the goblet (2 x 2 cells)
export function buildTitle() {
  const W = 32, H = 24, g = Array.from({ length: H }, () => new Array(W).fill(T.BLANK));
  for (let x = 0; x < W; x++) { g[0][x] = T.STONE; g[19][x] = T.STONE; }
  for (let y = 7; y <= 19; y++) { g[y][0] = T.STONE; g[y][31] = T.STONE; }        // the side walls start at the lintel: the letters have the whole width
  for (const [i, ch] of [...'VAULTS'].entries()) LETTERS[ch].forEach((row, r) => [...row].forEach((c, k) => { if (c === '#') g[2 + r][2 + 5 * i + k] = T.BRICK; }));
  for (let x = 1; x <= 30; x++) g[7][x] = T.LINING;                                       // a lintel under the letters
  const [gx, gy] = GOBLET_CELL;
  g[gy][gx] = T.GOB_TL; g[gy][gx + 1] = T.GOB_TR; g[gy + 1][gx] = T.GOB_BL; g[gy + 1][gx + 1] = T.GOB_BR;
  for (let x = 14; x <= 17; x++) g[12][x] = T.BRICK;                                     // the pedestal
  for (let x = 13; x <= 18; x++) g[13][x] = T.BRICK;
  for (const [x, y] of GEM_CELLS) g[y][x] = T.GEM;
  for (let y = 13; y <= 18; y++) { g[y][30] = T.DOOR; g[y][31] = T.DOOR; }                 // the locked vault door, set in the right wall
  return { w: W, h: H, cells: g.flat() };
}

// ── sprites ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const maskOfRow = (r) => [...r].map((c) => (c === '#' || c === '-' ? '1' : '0')).join('');
function sprite(frames, extra = {}) {
  const h = frames[0].length, w = frames[0][0].length;
  const hex = (bin) => parseInt(bin, 2).toString(16).toUpperCase().padStart(w / 4, '0');
  for (const f of frames) { if (f.length !== h) throw new Error('frame heights differ'); for (const r of f) if (r.length !== w) throw new Error(`sprite row "${r}" is ${r.length} wide, not ${w}`); }
  // ray mode ignores the hot box and the phases; they are kept at the asset format's defaults
  return { w, h, hot: [0, 0, w, h], phases: 1, ...extra, frames: frames.map((f) => ({ rows: f.map((r) => ({ bits: hex([...r].map((c) => (c === '#' ? '1' : '0')).join('')), mask: hex(maskOfRow(r)), ink: 7, paper: 0, bright: 1 })) })) };
}
/** a full row from its left half (the right half is the mirror image) */
const sym = (half) => half + [...half].reverse().join('');

// A billboard costs about 100 T-states for every 4-pixel column and pixel row it covers on the screen plus about 10,000 T-states whenever it is in view at all
// (docs/ARCADE_RUNTIME_API_V4.md, and tests/arcade-m8-vaults-perf.mjs): a 16 x 16 sprite closer than one cell takes 72,000 T-states, a 24 x 24 one 137,000, an 8 x 8 one
// 25,000. The wraiths are therefore 16 x 16 and the small things (gems, potions, the key) 8 x 8; the game hides what is more than 7 cells away.
//
// The wraith: 16 x 16, a hooded sheet with two eyes and a mouth, the hem torn differently in the two floating frames (the game swaps them as it moves).
// Frame 2 is hurt (the body flickers, half of it dithered away), frame 3 is the burst when it dies (sparks).
const WRAITH_HEAD = ['................', '.....######.....', '...##########...', '..############..', '..###--##--###..', '.####--##--####.', '.##############.', '.######--######.', '.##############.', '################', '################', '################'];
const WRAITH_HEM_A = ['################', '##.####..####.##', '#...###..###...#', '....##....##....'];
const WRAITH_HEM_B = ['################', '#.####....####.#', '..###......###..', '..##........##..'];
const dither = (rows) => rows.map((r, y) => [...r].map((c, x) => (c === '#' && (x + y) % 2 === 0 ? '-' : c)).join(''));
const BURST = [
  '................', '..#..........#..', '................', '....#....#......', '.........#......', '.#.....#.....#..', '................', '......#..#......',
  '....#.....#.....', '..............#.', '.#..#...........', '.........#......', '...#.........#..', '................', '.....#.....#....', '................',
];
const WRAITH = [
  [...WRAITH_HEAD, ...WRAITH_HEM_A],
  [...WRAITH_HEAD, ...WRAITH_HEM_B],
  dither([...WRAITH_HEAD, ...WRAITH_HEM_A]),
  BURST,
];

// A gem: 8 x 8, a cut diamond standing on the floor; frame 1 has a glint.
const GEM = [
  ['........', '..####..', '.##-####', '########', '.######.', '..####..', '...##...', '........'],
  ['......#.', '..###.#.', '.##-####', '########', '.######.', '..####..', '...##...', '........'],
];
// A health potion: 8 x 8, a round flask with a cork and a bubbling liquid.
const POTION = [['...##...', '...##...', '..####..', '.######.', '.#-##-#.', '.######.', '.######.', '..####..']];
// The key: 8 x 8, upright, the ring on top and two teeth.
const KEY = [['.####...', '.#--#...', '.#--#...', '.####...', '..##....', '..##.##.', '..##.##.', '..##....']];
// The treasure: 16 x 16, a goblet (GOB_ROWS above, also cut into tiles for the title); frame 1 adds a glint.
const TREASURE = [GOB_ROWS, GOB_GLINT_ROWS];
// The marker of the player for HIT (never drawn: it stands at the viewer): 16 x 16, so that its half size (64 units) plus a pickup's (32) reaches 96.
const MARKER = [Array.from({ length: 16 }, () => '################')];

// ── sound ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ticks = (n, f) => Array.from({ length: n }, (_, k) => f(k));
const note = (tone, n, vol) => ticks(n, (k) => ({ tone, vol: Math.max(1, vol - (k >> 1)), noise: 0, mix: 6 }));
const sfx = {
  shot: { ticks: ticks(7, (k) => ({ tone: 50 + 40 * k, vol: Math.max(2, 15 - 2 * k), noise: 3 + 3 * k, mix: 4 })) },                       // a zap: a falling tone over noise
  thud: { ticks: ticks(5, (k) => ({ tone: 380 + 30 * k, vol: Math.max(2, 13 - 2 * k), noise: 9, mix: 4 })) },                                 // a thud: the wraith is hurt
  kill: { ticks: [...ticks(5, (k) => ({ tone: 0, vol: 14 - k, noise: 4 + 3 * k, mix: 5 })), ...ticks(10, (k) => ({ tone: 120 + 24 * k, vol: Math.max(1, 12 - k), noise: 0, mix: 6 }))] },
  pick: { ticks: [...note(100, 3, 13), ...note(80, 3, 13), ...note(60, 7, 13)] },                                                          // a gem, a potion, the key: three notes up
  door: { ticks: ticks(18, (k) => ({ tone: 300 + 10 * k, vol: Math.max(2, 13 - (k >> 1)), noise: 18 - (k >> 1), mix: 4 })) },               // the vault door grinding open
  hurt: { ticks: ticks(10, (k) => ({ tone: 500 - 20 * k, vol: Math.max(2, 14 - k), noise: 14, mix: 4 })) },
  win: { ticks: [...note(200, 4, 14), ...note(160, 4, 14), ...note(135, 4, 14), ...note(100, 4, 14), ...note(135, 3, 13), ...note(100, 12, 14)] },
  lose: { ticks: ticks(30, (k) => ({ tone: 180 + 22 * k, vol: Math.max(2, 13 - (k >> 2)), noise: 0, mix: 6 })) },
};

// ── assets ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export function buildAssets() {
  return {
    sprites: {
      'vl_marker': sprite(MARKER),
      'vl_wraith': sprite(WRAITH, { phases: 4 }),   // 4 phases: the title scene's wraith drifts in 2-pixel steps (ray mode ignores phases)
      'vl_gem': sprite(GEM),
      'vl_potion': sprite(POTION),
      'vl_key': sprite(KEY),
      'vl_treasure': sprite(TREASURE),
    },
    tilesets: { 'vl_tiles': { tiles: TILES.map((t) => ({ rows: t.rows, flags: t.flags })) } },
    sfx: Object.fromEntries(Object.entries(sfx).map(([k, v]) => ['vl_' + k, v])),
    maps: { 'vl_maze': { w: MAP_W, h: MAP_H, cells: CELLS }, 'vl_panel': buildPanel(), 'vl_title': buildTitle() },
  };
}

if (MAIN) {
  if (process.argv.includes('--ascii')) {
    const show = (name, rows) => { console.log(`-- ${name}`); rows.forEach((r) => console.log(r)); };
    console.log('-- maze (. empty, 1 2 3 4 walls; P start K key T treasure E wraith G gem H potion)');
    console.log('   ' + Array.from({ length: MAP_W }, (_, c) => String(c % 10)).join(''));
    LAYOUT.forEach((r, y) => console.log(String(y).padStart(2) + ' ' + r));
    WRAITH.forEach((f, i) => show(`wraith ${i}`, f));
    GEM.forEach((f, i) => show(`gem ${i}`, f));
    show('potion', POTION[0]); show('key', KEY[0]); show('marker', MARKER[0].slice(0, 2));
    TREASURE.forEach((f, i) => show(`treasure ${i}`, f));
    { const tl = buildTitle(); const glyph = (v) => (v === T.BLANK ? ' ' : v === T.STONE ? '+' : v === T.BRICK ? '#' : v === T.LINING ? '=' : v === T.DOOR ? '|' : v === T.GEM ? '*' : v >= T.GOB_TL ? 'U' : '?'); show('title screen (# brick letters, + stone, = lining, | door, * gem, U goblet)', Array.from({ length: tl.h }, (_, y) => Array.from({ length: tl.w }, (_, x) => glyph(tl.cells[y * tl.w + x])).join(''))); }
    TILES.forEach((t, i) => show(`tile ${i} (ink ${t.rows[0].ink} paper ${t.rows[0].paper})`, t.art));
    process.exit(0);
  }
  if (process.argv.includes('--data')) {
    const arr = (name, vals) => console.log(`  DIM ${name}(${vals.length - 1}) = ${vals.join(', ')}`);
    const con = (name, v) => console.log(`CONST ${name} = ${v}`);
    con('SX0', THINGS.P[0][0]); con('SY0', THINGS.P[0][1]);
    con('KX', THINGS.K[0][0]); con('KY', THINGS.K[0][1]);
    con('TX', THINGS.T[0][0]); con('TY', THINGS.T[0][1]);
    con('DX0', DOOR[0]); con('DY0', DOOR[1]);
    arr('exs', THINGS.E.map((p) => p[0])); arr('eys', THINGS.E.map((p) => p[1]));
    arr('gxs', THINGS.G.map((p) => p[0])); arr('gys', THINGS.G.map((p) => p[1]));
    arr('pxs', THINGS.H.map((p) => p[0])); arr('pys', THINGS.H.map((p) => p[1]));
    arr('tgx', GEM_CELLS.map((p) => p[0])); arr('tgy', GEM_CELLS.map((p) => p[1]));
    console.log(`REM ${THINGS.E.length} wraiths, ${THINGS.G.length} gems, ${THINGS.H.length} potions, 1 key, 1 treasure`);
    process.exit(0);
  }
  const assets = buildAssets();
  writeFileSync(join(HERE, 'vaults.assets.json'), JSON.stringify(assets, null, 1) + '\n');
  console.log(`vaults.assets.json: ${Object.keys(assets.sprites).length} sprites (wraith ${assets.sprites['vl_wraith'].frames.length} frames), ${TILES.length} tiles, ${Object.keys(assets.sfx).length} sound effects, a ${MAP_W} x ${MAP_H} maze (${THINGS.E.length} wraiths, ${THINGS.G.length} gems, ${THINGS.H.length} potions) the HUD panel and the title screen`);
}
