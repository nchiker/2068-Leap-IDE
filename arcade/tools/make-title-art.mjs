/**
 * arcade/tools/make-title-art.mjs — candidate title screens for the Arrow Rush starter, made in code and run through the Studio's picture import (stage 5).
 *
 *   node arcade/tools/make-title-art.mjs [outDir]        (default: arcade/spike/stage5/title/ ; the script writes only into that directory)
 *
 * Three 256 x 192 pictures are drawn procedurally (no image files, no decoder, no dependencies) with the 15 colours the TS2068 shows:
 *   A  "Sunset"       a 4x pixel-font logo on a banded sky (blue, magenta, red, a yellow horizon), four big arrows, a road
 *   B  "Night streak" a night city, three arrows streaking right with speed lines, the logo on top (dull colours on black)
 *   C  "Brick logo"   the logo and four arrows as 8 x 8 blocks, each block one colour with a white highlight edge (the boldest; about 10 tiles)
 * Each picture goes through pictureToAssets (src/tools/picture-import.js) with dither 'none', 'ordered' and 'diffusion' (tiles marked "sprites never
 * pass over", the title shows no sprites), the best result is rendered back as the machine would show it (tile pixels in their own ink / paper / BRIGHT),
 * and the assets are checked with checkAssets, tile-model.validateAsset, map-model.validateMap and arcade-project.validateAsset.
 *
 * Files written: title-<X>-source.png, title-<X>-import.png, title-<X>-assets.json ({tileset, map}), title-sheet.png (source above, import below, 2x),
 * title-report.json (the numbers). Every PNG is the 256 x 192 screen (the sheet is 2x), no border.
 */

"use strict";

import { mkdirSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import * as PI from '../../src/tools/picture-import.js';
import * as T from '../../src/tools/tile-model.js';
import * as M from '../../src/tools/map-model.js';
import { PALETTE } from '../../src/tools/sprite-model.js';
import * as P from '../../src/arcade-project.js';
import { scanRoles } from '../../src/lang/arcade/arcade-scan.js';
import { checkAssets } from '../../src/lang/arcade/arcade-assetcheck.js';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const outDir = process.argv[2] ? process.argv[2] : ROOT + 'arcade/spike/stage5/title/';
const W = 256, H = 192;

// ── colours: keys 0 (black), 1..7, 9..15 (bright); key 8 is black as well ─────────────────────────────────────────────────────────
const K = { black: 0, blue: 1, red: 2, magenta: 3, green: 4, cyan: 5, yellow: 6, white: 7, bblue: 9, bred: 10, bmagenta: 11, bgreen: 12, bcyan: 13, byellow: 14, bwhite: 15 };
const rgbOf = (key) => PALETTE[key === 8 ? 0 : key].rgb;

// ── a canvas of palette keys ─────────────────────────────────────────────────────────────────────────────────────────────────────
function canvas() { return { keys: new Uint8Array(W * H) }; }
const px = (c, x, y, k) => { if (x >= 0 && y >= 0 && x < W && y < H) c.keys[y * W + x] = k; };
const rect = (c, x, y, w, h, k) => { for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) px(c, x + i, y + j, k); };
const SKY = 255;     // a key that means "smooth sky" (only candidate A's experiment: a true RGB gradient, not palette colours)
const SKY_STOPS = [[0, [51, 51, 255]], [56, [255, 51, 247]], [104, [252, 56, 51]], [156, [255, 255, 51]]];
function skyRGB(y) {
  for (let i = 1; i < SKY_STOPS.length; i++) if (y <= SKY_STOPS[i][0]) { const [y0, a] = SKY_STOPS[i - 1], [y1, b] = SKY_STOPS[i], t = (y - y0) / (y1 - y0); return a.map((v, n) => v + (b[n] - v) * t); }
  return SKY_STOPS[SKY_STOPS.length - 1][1];
}
const toRGBA = (c) => { const d = new Uint8ClampedArray(W * H * 4); for (let i = 0; i < W * H; i++) { const [r, g, b] = c.keys[i] === SKY ? skyRGB((i / W) | 0) : rgbOf(c.keys[i]); d[i * 4] = r; d[i * 4 + 1] = g; d[i * 4 + 2] = b; d[i * 4 + 3] = 255; } return { width: W, height: H, data: d }; };

// ── the 5 x 7 font (rows as 5-bit hex), upper case, digits and a few signs ─────────────────────────────────────────────────────
const FONT_SRC = {
  A: '0E 11 11 1F 11 11 11', B: '1E 11 11 1E 11 11 1E', C: '0E 11 10 10 10 11 0E', D: '1E 11 11 11 11 11 1E', E: '1F 10 10 1E 10 10 1F',
  F: '1F 10 10 1E 10 10 10', G: '0E 11 10 17 11 11 0F', H: '11 11 11 1F 11 11 11', I: '0E 04 04 04 04 04 0E', J: '07 02 02 02 02 12 0C',
  K: '11 12 14 18 14 12 11', L: '10 10 10 10 10 10 1F', M: '11 1B 15 15 11 11 11', N: '11 11 19 15 13 11 11', O: '0E 11 11 11 11 11 0E',
  P: '1E 11 11 1E 10 10 10', Q: '0E 11 11 11 15 12 0D', R: '1E 11 11 1E 14 12 11', S: '0F 10 10 0E 01 01 1E', T: '1F 04 04 04 04 04 04',
  U: '11 11 11 11 11 11 0E', V: '11 11 11 11 11 0A 04', W: '11 11 11 15 15 15 0A', X: '11 11 0A 04 0A 11 11', Y: '11 11 0A 04 04 04 04',
  Z: '1F 01 02 04 08 10 1F',
  0: '0E 11 13 15 19 11 0E', 1: '04 0C 04 04 04 04 0E', 2: '0E 11 01 02 04 08 1F', 3: '1F 02 04 02 01 11 0E', 4: '02 06 0A 12 1F 02 02',
  5: '1F 10 1E 01 01 11 0E', 6: '06 08 10 1E 11 11 0E', 7: '1F 01 02 04 08 08 08', 8: '0E 11 11 0E 11 11 0E', 9: '0E 11 11 0F 01 02 0C',
  '-': '00 00 00 1F 00 00 00', ':': '00 04 00 00 00 04 00', '.': '00 00 00 00 00 00 04', '/': '01 01 02 04 08 10 10', ',': '00 00 00 00 0C 04 08',
  '%': '19 19 02 04 08 13 13', '<': '02 04 08 10 08 04 02', '>': '08 04 02 01 02 04 08', '=': '00 00 1F 00 1F 00 00', '(': '02 04 08 08 08 04 02', ')': '08 04 02 02 02 04 08',
};
const FONT = Object.fromEntries(Object.entries(FONT_SRC).map(([ch, s]) => [ch, s.split(' ').map((h) => parseInt(h, 16))]));
/** The glyph's 7 rows of 5 bits; null for a space or an unknown character. */
const glyph = (ch) => FONT[ch] ?? null;
/** Draw a string: each font pixel is a scale x scale square, `adv` pixels from one character to the next (default 6 * scale). */
function text(c, str, x, y, scale, k, adv = 6 * scale) {
  [...str.toUpperCase()].forEach((ch, n) => {
    const g = glyph(ch);
    if (!g) return;
    g.forEach((bits, r) => { for (let b = 0; b < 5; b++) if ((bits >> (4 - b)) & 1) rect(c, x + n * adv + b * scale, y + r * scale, scale, scale, k); });
  });
}

// ── arrows ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ARROW8 = ['...##...', '..####..', '.######.', '########', '...##...', '...##...', '...##...', '...##...'];
const ARROW6 = ['..##..', '.####.', '######', '..##..', '..##..', '..##..'];
const flipRows = (rows) => [...rows].reverse();
const flipCols = (rows) => rows.map((r) => [...r].reverse().join(''));
const transpose = (rows) => rows[0].split('').map((_, i) => rows.map((r) => r[i]).join(''));
/** The four directions of an up-pointing arrow (rows of '.' and '#'). */
const arrowSet = (up) => ({ up, down: flipRows(up), left: transpose(up), right: flipCols(transpose(up)) });
function pixelArt(c, rows, x, y, scale, k) {
  rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === '#') rect(c, x + i * scale, y + j * scale, scale, scale, k); });
}

// ── candidate A: Sunset ────────────────────────────────────────────────────────────────────────────────────────────────────────
function drawA(smooth = false) {
  const c = canvas();
  // sky bands, in whole cell rows; a row of checker between two bands (the Spectrum's way of a smooth step: one tile)
  const band = (r0, r1, k) => rect(c, 0, r0 * 8, W, (r1 - r0 + 1) * 8, k);
  const checker = (row, k1, k2) => { for (let y = 0; y < 8; y++) for (let x = 0; x < W; x++) px(c, x, row * 8 + y, (x + y) & 1 ? k2 : k1); };
  if (smooth) rect(c, 0, 0, W, 160, SKY);          // the experiment: a photographic gradient instead of bands (what a pasted picture would look like)
  else {
    band(0, 6, K.bblue); checker(7, K.bblue, K.bmagenta);
    band(8, 11, K.bmagenta); checker(12, K.bmagenta, K.bred);
    band(13, 17, K.bred); checker(18, K.bred, K.byellow);
    band(19, 19, K.byellow);
  }
  // stars in the blue band: one white pixel in a cell, at two fixed places in the cell (so two tiles)
  if (!smooth) [[2, 0], [9, 1], [14, 0], [21, 1], [27, 0], [5, 6], [17, 6], [30, 6]].forEach(([cx, cy], n) => { const o = n % 2 ? [3, 3] : [5, 2]; px(c, cx * 8 + o[0], cy * 8 + o[1], K.bwhite); });
  // the logo: 5 x 7 font at 4x, 24 pixels a letter = 3 cells, so every letter starts on a cell edge; rows 2 to 5
  text(c, 'ARROW RUSH', 8, 18, 4, K.byellow);
  // four big arrows (8 x 8 blocks of 4 pixels = 32 x 32) on the red band, cells 2, 10, 18 and 26
  const a = arrowSet(ARROW8), at = [[16, 'up', K.bwhite], [80, 'down', K.bcyan], [144, 'left', K.bgreen], [208, 'right', K.byellow]];
  at.forEach(([x, d, k]) => pixelArt(c, a[d], x, 104, 4, k));
  // the road: a green edge line and perspective bars on black (dull colours on black: the two-blacks rule)
  rect(c, 0, 160, W, 2, K.green);
  for (let x = 0; x < W; x += 32) rect(c, x, 160, 2, 32, K.green);
  return c;
}

// ── candidate B: Night streak ─────────────────────────────────────────────────────────────────────────────────────────────────────
function drawB() {
  const c = canvas();
  // stars
  [[3, 0], [11, 5], [19, 0], [26, 6], [31, 6], [7, 6], [23, 5]].forEach(([cx, cy], n) => px(c, cx * 8 + (n % 2 ? 2 : 5), cy * 8 + (n % 2 ? 6 : 3), K.white));
  // the logo: yellow over red, two cell rows each
  text(c, 'ARROW RUSH', 8, 10, 4, K.yellow);
  for (let y = 24; y < 40; y++) for (let x = 0; x < W; x++) if (c.keys[y * W + x] === K.yellow) c.keys[y * W + x] = K.red;   // rows 3 and 4 (y 24..39)
  // three arrows pointing right, each with speed lines behind it (cell-aligned lengths); dull colours on black
  const right = arrowSet(ARROW8).right;
  [[160, 56, K.yellow], [208, 88, K.red], [120, 120, K.cyan]].forEach(([x, y, k]) => {
    pixelArt(c, right, x, y, 4, k);
    rect(c, x - 96, y + 4, 96 + 16, 2, k);          // above the stem, ends before the head (x + 16)
    rect(c, x - 56, y + 26, 56 + 16, 2, k);         // below
    rect(c, x - 136, y + 14, 136, 2, k);            // the stem's own trail, longest
  });
  // the skyline: dull blue buildings from row 19 down, a few lit yellow windows (two cell kinds: lit and dark)
  const tops = [21, 19, 22, 20, 21, 19, 22, 20];     // a building is 4 cells (32 pixels) wide
  tops.forEach((top, b) => {
    rect(c, b * 32, top * 8, 32, (24 - top) * 8, K.blue);
    for (let cy = top + 1; cy < 24; cy++) for (let cx = b * 4; cx < b * 4 + 4; cx++) if ((cx * 7 + cy * 13 + b) % 3 === 0) rect(c, cx * 8 + 2, cy * 8 + 2, 3, 4, K.yellow);
  });
  return c;
}

// ── candidate C: Brick logo ──────────────────────────────────────────────────────────────────────────────────────────────────────
function drawC() {
  const c = canvas();
  const brick = (col, row, k) => {                   // one cell: the colour with a white highlight on its top and left edge
    rect(c, col * 8, row * 8, 8, 8, k);
    rect(c, col * 8, row * 8, 8, 1, K.bwhite); rect(c, col * 8, row * 8, 1, 8, K.bwhite);
  };
  const block = (rows, col0, row0, k) => rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === '#' || (typeof r[i] === 'number')) brick(col0 + i, row0 + j, k); });
  const word = (str, col0, row0, k) => [...str].forEach((ch, n) => { const g = glyph(ch); if (g) block(g.map((bits) => [...Array(5)].map((_, b) => ((bits >> (4 - b)) & 1 ? '#' : '.')).join('')), col0 + n * 6, row0, k); });
  word('ARROW', 2, 1, K.bred);
  word('RUSH', 5, 9, K.byellow);
  const a = arrowSet(ARROW6);
  [[1, 'up', K.byellow], [9, 'down', K.bgreen], [17, 'left', K.bmagenta], [25, 'right', K.bcyan]].forEach(([col, d, k]) => block(a[d], col, 17, k));
  // stars in the black cells (single dull pixels at one fixed place: one tile)
  [[0, 0], [31, 1], [1, 9], [30, 10], [0, 16], [31, 17], [14, 23], [27, 23], [4, 23]].forEach(([cx, cy]) => px(c, cx * 8 + 3, cy * 8 + 4, K.white));
  return c;
}

const CANDIDATES = [
  { id: 'A', name: 'SUNSET LOGO', about: 'a 4x pixel-font logo on a banded sky (blue, magenta, red, a yellow horizon, checker steps between the bands), four big arrows, a road', draw: drawA },
  { id: 'B', name: 'NIGHT STREAK', about: 'a night city under stars, three arrows streaking right with speed lines, the logo in yellow and red on top (dull colours on black)', draw: drawB },
  { id: 'C', name: 'BRICK LOGO', about: 'the logo and four arrows built of 8 x 8 blocks, one colour each with a white highlight edge, on black: bold and almost free in tiles', draw: drawC },
];

// ── the import and its rendering ─────────────────────────────────────────────────────────────────────────────────────────────────
/** What the machine shows of the import: the tile set (stored asset) and the map (stored asset) as 256 x 192 palette keys. A blank cell is black. */
function renderImport(tileset, map) {
  const set = T.fromAsset(tileset), m = M.fromAsset(map), c = canvas();
  for (let cy = 0; cy < m.h; cy++) for (let cx = 0; cx < m.w; cx++) {
    const v = m.cells[cy * m.w + cx];
    if (v === M.BLANK) continue;
    const keys = T.tilePixels(set.tiles[v], { fine: false });       // a plain (not fine) scene: row 0's colours for the whole tile
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) px(c, cx * 8 + x, cy * 8 + y, keys[y * 8 + x]);
  }
  return c;
}
const firstDiff = (a, b) => { for (let i = 0; i < W * H; i++) if ((a.keys[i] === 8 ? 0 : a.keys[i]) !== (b.keys[i] === 8 ? 0 : b.keys[i])) return { x: i % W, y: (i / W) | 0, cell: [(i % W) >> 3, ((i / W) | 0) >> 3], source: a.keys[i], import: b.keys[i] }; return null; };
const differing = (a, b) => { let n = 0; for (let i = 0; i < W * H; i++) if ((a.keys[i] === 8 ? 0 : a.keys[i]) !== (b.keys[i] === 8 ? 0 : b.keys[i])) n++; return n; };

const ARC = 'GAME "Arrow Rush"\nTILESET gfx = "title"\nMAP pic = "title"\nSCENE title\n  PROC INIT():\n    LOADMAP pic\n  ENDP\nENDSCENE\n';
function checks(tileset, map) {
  const set = T.fromAsset(tileset), m = M.fromAsset(map);
  const project = { format: 1, name: 'Arrow Rush', framerate: 30, files: { 'main.arc': ARC }, assets: { sprites: {}, tilesets: { title: tileset }, maps: { title: map }, sfx: {}, music: {} }, scenes: {} };
  const roles = scanRoles(ARC);
  return {
    roles,
    findings: checkAssets(project, roles).map((f) => `${f.id}: ${f.message}`),
    tileValidate: T.validateAsset(tileset),
    mapValidate: M.validateMap(m, 'cell', { tileCount: set.tiles.length }),
    projectTileset: P.validateAsset('tilesets', tileset),
    projectMap: P.validateAsset('maps', map),
  };
}

// ── PNG: 8-bit RGB, one IDAT, filter 0 ───────────────────────────────────────────────────────────────────────────────────────
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length), t = Buffer.from(type, 'latin1');
  out.writeUInt32BE(data.length, 0); t.copy(out, 4); Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(Buffer.concat([t, Buffer.from(data)])), 8 + data.length);
  return out;
}
/** rgb: Uint8Array(w * h * 3) */
function png(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}
const keysToRGB = (c) => { const o = new Uint8Array(W * H * 3); for (let i = 0; i < W * H; i++) o.set(rgbOf(c.keys[i]), i * 3); return o; };

// ── the contact sheet ────────────────────────────────────────────────────────────────────────────────────────────────────────────
function sheet(items) {
  const S = 2, gap = 16, cw = W * S, ch = H * S, capH = 22;
  const sw = gap + items.length * (cw + gap), sh = gap + (capH + ch + 6) * 2 + gap;
  const rgb = new Uint8Array(sw * sh * 3).fill(28);
  const put = (x, y, [r, g, b]) => { if (x >= 0 && y >= 0 && x < sw && y < sh) { const o = (y * sw + x) * 3; rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b; } };
  const label = (str, x, y) => [...str.toUpperCase()].forEach((chr, n) => { const g = glyph(chr); if (g) g.forEach((bits, r) => { for (let b = 0; b < 5; b++) if ((bits >> (4 - b)) & 1) for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) put(x + n * 12 + b * 2 + i, y + r * 2 + j, [235, 235, 235]); }); });
  items.forEach((it, n) => {
    const x0 = gap + n * (cw + gap);
    label(`${it.id} ${it.name}`, x0, gap);
    label(`IMPORT ${it.tiles} TILES ${it.diffPx} PIXELS OFF`, x0, gap + capH + ch + 6);
    [[it.source, gap + capH], [it.import, gap + capH + ch + 6 + capH]].forEach(([c, y0]) => {
      for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) put(x0 + x, y0 + y, rgbOf(c.keys[((y / S) | 0) * W + ((x / S) | 0)]));
    });
  });
  return png(sw, sh, rgb);
}

// ── main ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
mkdirSync(outDir, { recursive: true });
const report = [], sheetItems = [];
for (const cand of CANDIDATES) {
  const src = cand.draw(), img = toRGBA(src);
  const tries = ['none', 'ordered', 'diffusion'].map((dither) => {
    const r = PI.pictureToAssets(img, { dither, foreground: true, maxTiles: 128, tilesetName: 'title' });
    const rendered = renderImport(r.tileset, r.map);
    return { dither, r, rendered, diff: differing(src, rendered), tiles: r.result.tiles.length };
  });
  const best = tries.slice().sort((a, b) => a.diff - b.diff || a.tiles - b.tiles || (a.dither === 'none' ? -1 : 1))[0];
  const chk = checks(best.r.tileset, best.r.map);
  // the same import without "sprites never pass over": what the asset check says then (the colour attribute of a sprite's background)
  const plain = PI.pictureToAssets(img, { dither: best.dither, foreground: false, maxTiles: 128, tilesetName: 'title' });
  const plainFindings = checks(plain.tileset, plain.map).findings.map((f) => f.split(':')[0]);
  writeFileSync(outDir + `title-${cand.id}-source.png`, png(W, H, keysToRGB(src)));
  writeFileSync(outDir + `title-${cand.id}-import.png`, png(W, H, keysToRGB(best.rendered)));
  writeFileSync(outDir + `title-${cand.id}-assets.json`, JSON.stringify({ tileset: best.r.tileset, map: best.r.map }, null, 1) + '\n');
  sheetItems.push({ id: cand.id, name: cand.name, source: src, import: best.rendered, tiles: best.tiles, diffPx: best.diff });
  const row = {
    id: cand.id, name: cand.name, about: cand.about, chosenDither: best.dither,
    options: tries.map((t) => ({ dither: t.dither, needed: t.r.result.needed, overflow: t.r.result.overflow, lossyCells: t.r.result.lossyCells, tiles: t.tiles, differingPixels: t.diff, differingPct: +(t.diff * 100 / (W * H)).toFixed(2) })),
    firstDiff: firstDiff(src, best.rendered), withoutForegroundFlag: plainFindings, describe: PI.describeImport(best.r.result), jsonBytes: JSON.stringify({ tileset: best.r.tileset, map: best.r.map }).length,
    check: { findings: chk.findings, tileValidate: chk.tileValidate, mapValidate: chk.mapValidate, projectTileset: chk.projectTileset, projectMap: chk.projectMap, roles: { tileset: chk.roles.tileset, maps: chk.roles.maps } },
  };
  report.push(row);
  console.log(`\n${cand.id}  ${cand.name}: ${cand.about}`);
  for (const o of row.options) console.log(`   dither ${o.dither.padEnd(9)} needed ${String(o.needed).padStart(3)}  overflow ${o.overflow}  lossyCells ${o.lossyCells}  tiles ${String(o.tiles).padStart(3)}  differing pixels ${o.differingPixels} (${o.differingPct}%)`);
  console.log(`   chosen: ${best.dither}.  ${row.describe}`);
  console.log(`   without the foreground flag checkAssets says: ${plainFindings.length ? plainFindings.join(', ') : 'nothing'}`);
  console.log(`   checkAssets findings: ${chk.findings.length ? chk.findings.join(' | ') : 'none'};  tile-model.validateAsset: ${chk.tileValidate ?? 'ok'};  map-model.validateMap: ${chk.mapValidate.length ? chk.mapValidate.join('; ') : 'ok'};  arcade-project.validateAsset tilesets / maps: ${chk.projectTileset ?? 'ok'} / ${chk.projectMap ?? 'ok'}`);
}

// An experiment, not a candidate: A with a smooth RGB sky (a pasted picture). What each dither costs in tiles and what it shows (mean colour error per pixel).
{
  const src = drawA(true), img = toRGBA(src), exp = [];
  const meanErr = (rendered) => { let e = 0; for (let i = 0; i < W * H; i++) { const [r, g, b] = rgbOf(rendered.keys[i]); e += Math.abs(r - img.data[i * 4]) + Math.abs(g - img.data[i * 4 + 1]) + Math.abs(b - img.data[i * 4 + 2]); } return +(e / (W * H * 3)).toFixed(1); };
  writeFileSync(outDir + 'title-A-smooth-source.png', png(W, H, (() => { const o = new Uint8Array(W * H * 3); for (let i = 0; i < W * H * 3; i += 3) { o[i] = img.data[i / 3 * 4]; o[i + 1] = img.data[i / 3 * 4 + 1]; o[i + 2] = img.data[i / 3 * 4 + 2]; } return o; })()));
  console.log('\nExperiment: A with a smooth RGB sky instead of bands');
  for (const dither of ['none', 'ordered', 'diffusion']) {
    const r = PI.pictureToAssets(img, { dither, foreground: true, maxTiles: 128, tilesetName: 'title' }), rendered = renderImport(r.tileset, r.map);
    writeFileSync(outDir + `title-A-smooth-${dither}.png`, png(W, H, keysToRGB(rendered)));
    const row = { dither, needed: r.result.needed, overflow: r.result.overflow, lossyCells: r.result.lossyCells, tiles: r.result.tiles.length, meanColourError: meanErr(rendered) };
    exp.push(row);
    console.log(`   dither ${dither.padEnd(9)} needed ${String(row.needed).padStart(4)}  overflow ${row.overflow}  lossyCells ${row.lossyCells}  tiles ${String(row.tiles).padStart(3)}  mean colour error ${row.meanColourError}`);
  }
  report.push({ id: 'A-smooth-experiment', options: exp });
}
writeFileSync(outDir + 'title-sheet.png', sheet(sheetItems));
writeFileSync(outDir + 'title-report.json', JSON.stringify(report, null, 1) + '\n');
console.log(`\nwrote ${outDir}`);
