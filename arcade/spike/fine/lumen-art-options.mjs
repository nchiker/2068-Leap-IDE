#!/usr/bin/env node
"use strict";
// lumen-art-options.mjs -- stills of LUMEN's play scene with the CURRENT wall art and three alternative wall / corridor treatments that make the corridors readable at a glance.
//   node arcade/spike/fine/lumen-art-options.mjs        writes arcade/spike/fine/lumen-art/*.png (each still at 2x) and lumen-art/contact-sheet.png
// NOTHING in the game changes: the current art is read from arcade/examples/lumen.assets.json; the alternatives are painted here with the rules of fineart.mjs (a 256 x 192 picture, cut into
// 8 x 8 tiles whose rows keep the two most used colours of each 8 x 1 group; BRIGHT 0 on black paper; at most 128 tiles in all, counted with the fixed tiles and the three text maps of the game),
// then drawn with finePicture (the reference the runtime is tested against), the sprites and the HUD on top.
//   1 CURRENT   rainbow / ice tubes joined into pipes (what the game shows now)
//   2 SOLID     walls are solid blue blocks with a 1-pixel bright rim only where they face a corridor; the corridors are plain black
//   3 BRICKS    every wall block is a raised block: bright top and left edges, dark bottom and right edges, a blue face; corridors black (the block grid shows the maze)
//   4 BLUE FLOOR corridors have a dark blue floor, the walls are black with a 1-pixel bright rim (the rim is the same for both caves' colours); the actors' blue ink is lifted to cyan on it
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';
import { picture, set, text, tiler, FONT } from '../../examples/fineart.mjs';
import { MAZES, PALETTES } from '../../examples/lumen.assets.gen.mjs';
import { finePicture, glyphSource, rowOff } from '../../../src/lang/arcade/arcade-fine.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'lumen-art');
const ASSETS = JSON.parse(readFileSync(join(HERE, '../../examples/lumen.assets.json'), 'utf8'));
const BUDGET = 128;

// ---- the pieces of the game's art that every option shares (copied from lumen.assets.gen.mjs: it does not export them) --------------------------------------------------------------------
const ORB = ['.##.', '####', '####', '.##.'], ORB_INK = [7, 6, 6, 2];
const PRISM = ['....##....', '...####...', '..######..', '.########.', '##########', '##########', '.########.', '..######..', '...####...', '....##....'];
const PRISM_INK = [7, 7, 6, 6, 5, 4, 3, 3, 2, 1];
const RAINBOW = [7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 3, 3, 1, 1];
const GRADE = [6, 6, 6, 6, 2, 2, 2, 2];
const mirror = (half) => half + [...half].reverse().join('');
void mirror;
const isWall = (m, bx, by) => by >= 0 && by < 11 && bx >= 0 && bx < 16 && (m[by][bx] === '#');
const isWallOrDoor = (m, bx, by) => by >= 0 && by < 11 && bx >= 0 && bx < 16 && (m[by][bx] === '#' || m[by][bx] === '=');

// ---- the options -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
// each: {id, title, note, floor (the floor's colour: paper of tile 0), lift (a colour the options' art must not paint on its floor, mapped to another), wall(pic, m, bx, by, cave)}
// A wall painter paints one wall block ('#') of the maze m; orbs, prisms and the door are painted by paintMaze below, the same in every option except for the floor colour under them.
const px = (pic, x0, y0, x, y, c) => set(pic, x0 + x, y0 + y, c);

// 1 CURRENT: the tubes of lumen.assets.gen.mjs
function wallCurrent(pic, m, bx, by, cave) {
  const pal = PALETTES[cave], x0 = 16 * bx, y0 = 8 + 16 * by;
  const wall = (x, y) => isWallOrDoor(m, x, y);
  const L = wall(bx - 1, by), R = wall(bx + 1, by), U = wall(bx, by - 1), D = wall(bx, by + 1);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    const inH = y >= 3 && y <= 12 && (x >= 3 && x <= 12 || (L && x < 3) || (R && x > 12));
    const inV = x >= 3 && x <= 12 && ((U && y < 3) || (D && y > 12));
    if (!inH && !inV) continue;
    const horiz = inH && (L || R || !(U || D));
    px(pic, x0, y0, x, y, horiz ? pal.rows[y - 3] : (x < 8 ? pal.left : pal.right));
  }
}

// 2 SOLID: a blue block with a rim of 1 pixel on every side that faces a corridor (and on the corner of a notch).  The rim's colour goes by pixel row (rainbow: white to red; ice: white, then cyan),
// so a group of 8 pixels holds the blue and one rim colour: two colours.
const RIM_RAINBOW = [7, 7, 6, 6, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 2];
const RIM_ICE = [7, 7, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5];
function wallSolid(pic, m, bx, by, cave, { fill = 1, rim = cave === 0 ? RIM_RAINBOW : RIM_ICE } = {}) {
  const x0 = 16 * bx, y0 = 8 + 16 * by, W = (x, y) => isWall(m, x, y);
  const L = !W(bx - 1, by), R = !W(bx + 1, by), U = !W(bx, by - 1), D = !W(bx, by + 1);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    let rimmed = (x === 0 && L) || (x === 15 && R) || (y === 0 && U) || (y === 15 && D);
    if (!rimmed) {                                                    // a notch: a floor block touching only at the corner
      if (x === 0 && y === 0 && !W(bx - 1, by - 1) && !L && !U) rimmed = true;
      if (x === 15 && y === 0 && !W(bx + 1, by - 1) && !R && !U) rimmed = true;
      if (x === 0 && y === 15 && !W(bx - 1, by + 1) && !L && !D) rimmed = true;
      if (x === 15 && y === 15 && !W(bx + 1, by + 1) && !R && !D) rimmed = true;
    }
    px(pic, x0, y0, x, y, rimmed ? rim[y] : fill);
  }
}

// 3 BRICKS: a raised block, bright top and left edge, dark right and bottom edge, a blue face (the face is a block of its own even next to another wall block, so the grid shows)
const BRICK = {
  rainbow: { light: [7, 7, 6, 6, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 2], dark: 0, face: 1 },
  ice: { light: [7, 7, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5, 5], dark: 0, face: 1 },
};
function wallBricks(pic, m, bx, by, cave) {
  const B = cave === 0 ? BRICK.rainbow : BRICK.ice, x0 = 16 * bx, y0 = 8 + 16 * by;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    let c = B.face;
    if (x === 0 || y === 0) c = B.light[y];
    if (y === 15 || (x === 15 && y !== 0)) c = B.dark;
    px(pic, x0, y0, x, y, c);
  }
}

// 4 BLUE FLOOR: black walls with a 1-pixel bright rim where they face a corridor; the corridors' floor is blue
function wallBlack(pic, m, bx, by, cave) { wallSolid(pic, m, bx, by, cave, { fill: 0 }); }

const OPTIONS = [
  { id: 'current', title: '1 CURRENT', floor: 0, wall: wallCurrent, lift: null },
  { id: 'solid', title: '2 SOLID WALLS + RIM', floor: 0, wall: (p, m, bx, by, c) => wallSolid(p, m, bx, by, c), lift: null },
  { id: 'bricks', title: '3 RAISED BLOCKS', floor: 0, wall: wallBricks, lift: null },
  { id: 'bluefloor', title: '4 BLUE FLOOR', floor: 1, wall: wallBlack, lift: 5 },
];

// the floor, the objects: painted over the floor colour of the option (the floor of every block that is not a wall is `floor`)
function paintMaze(pic, m, opt, cave) {
  const lift = (c) => (opt.lift && c === 1 ? opt.lift : c);
  for (let by = 0; by < 11; by++) for (let bx = 0; bx < 16; bx++) {
    const ch = m[by][bx], x0 = 16 * bx, y0 = 8 + 16 * by;
    if (ch !== '#') for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) if (opt.floor) set(pic, x0 + x, y0 + y, opt.floor);
    if (ch === '#') opt.wall(pic, m, bx, by, cave);
    else if (ch === '=') for (let x = 0; x < 16; x++) for (const y of [7, 8]) set(pic, x0 + x, y0 + y, y === 7 ? 3 : 2);
    else if (ch === '.') ORB.forEach((row, k) => [...row].forEach((p, j) => { if (p === '#') set(pic, x0 + 6 + j, y0 + 6 + k, lift(ORB_INK[k])); }));
    else if (ch === 'o') PRISM.forEach((row, k) => [...row].forEach((p, j) => { if (p === '#') set(pic, x0 + 3 + j, y0 + 3 + k, lift(PRISM_INK[k])); }));
  }
}

// ---- the tileset of an option: the fixed tiles, both mazes, and the game's three text maps (their tiles count against the 128) -------------------------------------------------------------
// the cutter keeps two colours per 8 x 1 group: a group painted with three or more would be altered; count them (rows 8..183 hold the maze)
function threeColourGroups(pic) {
  let n = 0;
  for (let y = 8; y < 184; y++) for (let c = 0; c < 32; c++) {
    const seen = new Set();
    for (let b = 0; b < 8; b++) { const v = pic[y * 256 + 8 * c + b]; seen.add(v < 0 ? 0 : v); }
    if (seen.size > 2) n++;
  }
  return n;
}
function buildOption(opt) {
  const floorTile = { rows: Array.from({ length: 8 }, () => ({ bits: '00', ink: 7, paper: opt.floor, bright: 0 })), flags: 0 };
  const T = tiler([floorTile]);
  {
    const pic = picture();
    paintMaze(pic, ['.o=#############', ...Array(10).fill('################')].map((r) => r), opt, 0);
    T.add(pic, 1, 0, 2, 2); T.add(pic, 1, 2, 2, 2); T.add(pic, 1, 4, 2, 2);                   // an orb, a prism, the door: tiles 1..10 as the game needs them
  }
  const blackIdx = T.add(picture(), 1, 0, 1, 1)[0];                  // a black cell for the HUD rows (the floor tile itself when the floor is black)
  const caves = [], bad = [];
  MAZES.forEach((m, cave) => {
    const pic = picture();
    paintMaze(pic, m, opt, cave);
    bad.push(threeColourGroups(pic));
    const cells = [...new Array(32).fill(blackIdx), ...T.add(pic, 1, 0, 22, 32), ...new Array(32).fill(blackIdx)];
    caves.push(cells);
  });
  for (const [str, colourOf, o] of [['LUMEN', (py) => RAINBOW[py], { scale: 2, bold: true }], ['PRESS FIRE TO PLAY', (py) => GRADE[py], {}], ['GAME OVER', (py) => RAINBOW[py], { scale: 2, bold: true }]]) {
    const pic = picture(), s = o.scale ?? 1;
    text(pic, str, 0, 8, colourOf, o);
    T.add(pic, 1, 0, s, str.length * s);
  }
  return { T, caves, bad };
}

// ---- drawing a still: the cells through finePicture, the actors and the HUD -------------------------------------------------------------------------------------------------------------------
const hex = (h) => h.match(/../g).map((x) => parseInt(x, 16));
function spriteAsset(name, lift) {
  const a = ASSETS.sprites[name], rows = a.frames[0].rows, data = [], inks = [];
  for (const r of rows) {
    const bits = hex(r.bits), mask = hex(r.mask);
    data.push((~mask[0]) & 255, (~mask[1]) & 255, bits[0], bits[1]);
    inks.push(lift && r.ink === 1 ? lift : r.ink);
  }
  return { h: rows.length, data, inks, phases: a.phases };
}
const PAL = [[0, 0, 0], [0, 0, 0xD7], [0xD7, 0, 0], [0xD7, 0, 0xD7], [0, 0xD7, 0], [0, 0xD7, 0xD7], [0xD7, 0xD7, 0], [0xD7, 0xD7, 0xD7]];

function still(T, cells, cave, opt) {
  const tiles = T.tiles, tileBytes = new Uint8Array(9 * tiles.length), tileRows = new Uint8Array(8 * tiles.length);
  tiles.forEach((t, i) => t.rows.forEach((r, k) => { tileBytes[9 * i + k] = parseInt(r.bits, 16); tileRows[8 * i + k] = (r.bright << 6) | (r.paper << 3) | r.ink; }));
  const cv = new Uint8Array(768), at = new Uint8Array(768);
  cells.forEach((t, i) => { cv[i] = 128 + t; });
  const put = (r, c, str, attr) => [...str].forEach((ch, i) => { cv[r * 32 + c + i] = ch.charCodeAt(0); at[r * 32 + c + i] = attr; });
  put(0, 1, 'SCORE', 6); put(0, 7, '1240', 6); put(0, 25, 'CAVE', 6); put(0, 30, String(cave + 1), 6);
  put(23, 1, 'LIVES', 6); put(23, 7, '3', 6); put(23, 24, 'BEST 540', 6);
  const lift = opt.lift;
  const assets = { wispa: spriteAsset('wispa', lift), ember: spriteAsset('ember', lift), bloom: spriteAsset('bloom', lift), moss: spriteAsset('moss', lift), pale: spriteAsset('pale', lift) };
  // the wisp on its start block, Ember and Bloom out, Moss at a corner, one pale shade
  const sprites = [['wispa', 112, 120], ['ember', 32, 24], ['bloom', 176, 24], ['moss', 48, 152], ['pale', 192, 152]].map(([a, x, y]) => ({ visible: 1, x, y, asset: a }));
  const { bits, colours } = finePicture({ cells: cv, attrs: at, tileRows, sprites, assets, glyph: glyphSource({ font: FONT, tileBytes }) });
  const rgb = new Uint8Array(256 * 192 * 3);
  for (let y = 0; y < 192; y++) for (let c = 0; c < 32; c++) {
    const o = rowOff(y, c), a = colours[o], br = (a >> 6) & 1;
    for (let b = 0; b < 8; b++) {
      const col = PAL[(bits[o] >> (7 - b)) & 1 ? a & 7 : (a >> 3) & 7].map((v) => (v && br ? 0xFF : v)), p = (y * 256 + 8 * c + b) * 3;
      rgb[p] = col[0]; rgb[p + 1] = col[1]; rgb[p + 2] = col[2];
    }
  }
  return { rgb, bits, colours };
}

// ---- png ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
const crcT = new Uint32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (buf) => { let c = 0xFFFFFFFF; for (const x of buf) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function png(path, rgb, W, H) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) Buffer.from(rgb.buffer, rgb.byteOffset + y * W * 3, W * 3).copy(raw, y * (W * 3 + 1) + 1);
  const chunk = (type, data) => { const t = Buffer.from(type), len = Buffer.alloc(4), cr = Buffer.alloc(4); len.writeUInt32BE(data.length); cr.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, cr]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  writeFileSync(path, Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]));
}
const scale2 = (rgb) => { const o = new Uint8Array(512 * 384 * 3); for (let y = 0; y < 384; y++) for (let x = 0; x < 512; x++) { const s = ((y >> 1) * 256 + (x >> 1)) * 3, d = (y * 512 + x) * 3; o[d] = rgb[s]; o[d + 1] = rgb[s + 1]; o[d + 2] = rgb[s + 2]; } return o; };
function label(canvas, W, str, x, y, rgbc = [230, 230, 230], z = 2) {
  [...str].forEach((ch, i) => {
    const g = FONT[ch.charCodeAt(0) - 32] ?? FONT[0];
    for (let r = 0; r < 8; r++) for (let b = 0; b < 8; b++) if ((g[r] >> (7 - b)) & 1) for (let sy = 0; sy < z; sy++) for (let sx = 0; sx < z; sx++) {
      const p = ((y + z * r + sy) * W + x + 8 * z * i + z * b + sx) * 3; canvas[p] = rgbc[0]; canvas[p + 1] = rgbc[1]; canvas[p + 2] = rgbc[2];
    }
  });
}

// ---- main --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
mkdirSync(OUT, { recursive: true });
const CAVE_NAMES = ['rainbow cave', 'ice cave'];
const shots = [], over = {};
for (const opt of OPTIONS) {
  const built = buildOption(opt);
  let cells2 = built.caves;
  if (opt.id === 'current') {
    // the game's own maps (exact): the generator's tiles and cells
    const tiles = ASSETS.tilesets.gfx.tiles;
    built.T.tiles.length = 0; tiles.forEach((t) => built.T.tiles.push(t));
    cells2 = [ASSETS.maps.maze1.cells, ASSETS.maps.maze2.cells];
    // (the count of the rebuilt current art must agree with the game's: a sanity check of this script's pipeline)
    const rebuilt = buildOption(opt).T.count;
    if (rebuilt !== tiles.length) throw new Error(`the rebuilt current art has ${rebuilt} tiles, the game's has ${tiles.length}`);
  }
  over[opt.id] = built.bad;
  const count = opt.id === 'current' ? ASSETS.tilesets.gfx.tiles.length : built.T.count;
  for (let cave = 0; cave < 2; cave++) {
    const s = still(built.T, cells2[cave], cave, opt);
    const big = scale2(s.rgb);
    png(join(OUT, `${opt.id}-${cave === 0 ? 'rainbow' : 'ice'}.png`), big, 512, 384);
    shots.push({ opt, cave, big, count });
  }
  console.log(`${opt.title}: ${count} tiles of ${BUDGET}${count > BUDGET ? '  OVER BUDGET' : ''}; groups of 8 x 1 with more than two colours: ${built.bad.join(' / ')}`);
}
{
  const PAD = 10, LAB = 36, cw = 512, ch = 384, cols = OPTIONS.length, rows = 2;
  const W = PAD + cols * (cw + PAD), H = PAD + rows * (LAB + ch + PAD), sheet = new Uint8Array(W * H * 3).fill(46);
  shots.forEach(({ opt, cave, big, count }) => {
    const ox = PAD + OPTIONS.indexOf(opt) * (cw + PAD), oy = PAD + cave * (LAB + ch + PAD);
    for (let y = 0; y < ch; y++) sheet.set(big.subarray(y * cw * 3, (y + 1) * cw * 3), ((oy + LAB + y) * W + ox) * 3);
    label(sheet, W, `${opt.title}`, ox, oy + 2);
    label(sheet, W, `${CAVE_NAMES[cave]}  ${count}/${BUDGET} tiles  (${over[opt.id][cave]} bad groups)`, ox, oy + 22, [170, 170, 170], 1);
  });
  png(join(OUT, 'contact-sheet.png'), sheet, W, H);
  console.log(`wrote ${shots.length} stills and contact-sheet.png (${W} x ${H}) in ${OUT}`);
}
