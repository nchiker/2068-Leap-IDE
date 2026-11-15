"use strict";
// scene.mjs -- the F1 test scene ("Starfall-like" play, fine colour) and the data images the cartridge carries.
//   * a HUD text row (cell row 0) with a tick counter in cells 29-31 (changed every tick: dirty cells);
//   * cell rows 1-23 of sky tiles whose 8 pixel rows each have their own colour (6 bands, each plain or with a star);
//   * 16 instances: 0 ship (16x16), 1-4 bullets (8x8), 5-12 enemies (16x16; 5-8 scouts, 9-12 heavies), 13-15 shots (8x8),
//     moved by a scripted pattern (positions per tick n, period 256), with overlaps and sprites in the top rows (over the HUD).
// state(n) is the state the cartridge shows after its n-th update; picture(n) its fine picture (fine-model.mjs).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { finePicture, preshift, rowOff } from './fine-model.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const NI = 16, SCRIPT_TICKS = 256;

// ---- glyphs: the v2 font (codes 32..127) and the tiles (codes 128..) ----
export const glyphs = new Uint8Array(2048);
{
  const src = readFileSync(join(HERE, '../../runtime/v2/font.inc'), 'utf8');
  let code = 32;
  for (const line of src.split('\n')) {
    const m = line.match(/^\s*DB\s+(.*?)\s*;/);
    if (!m) continue;
    m[1].split(',').map((s) => parseInt(s.trim().replace('$', ''), 16)).forEach((b, k) => { glyphs[8 * code + k] = b; });
    code++;
  }
}
// sky bands: 8 row attributes each (bright << 6 | paper << 3 | ink); no BRIGHT black paper (the two-blacks rule)
const A = (paper, ink, bright = 0) => (bright << 6) | (paper << 3) | ink;
const BANDS = [
  [A(0, 7), A(0, 7), A(0, 6), A(0, 7), A(1, 7), A(0, 7), A(1, 7), A(1, 7)],
  [A(1, 7), A(1, 7, 1), A(1, 7), A(1, 7, 1), A(1, 6, 1), A(1, 7), A(1, 7, 1), A(1, 7, 1)],
  [A(1, 7, 1), A(3, 7), A(1, 7, 1), A(3, 7), A(3, 7), A(3, 6, 1), A(3, 7), A(3, 7, 1)],
  [A(3, 7, 1), A(2, 7), A(3, 7, 1), A(2, 7), A(2, 6), A(2, 7, 1), A(2, 7), A(2, 7, 1)],
  [A(2, 7, 1), A(6, 1), A(2, 7, 1), A(6, 1), A(6, 1, 1), A(6, 2), A(6, 1, 1), A(6, 1, 1)],
  [A(6, 1, 1), A(5, 1), A(5, 1, 1), A(5, 0), A(4, 1), A(4, 0, 1), A(4, 1), A(4, 1, 1)],
];
const STAR = [0x00, 0x10, 0x38, 0x10, 0x00, 0x00, 0x02, 0x00];
export const tileRows = new Uint8Array(1024);
export const NTILES = 12;
for (let b = 0; b < 6; b++) for (let s = 0; s < 2; s++) {
  const t = 2 * b + s;
  for (let k = 0; k < 8; k++) { tileRows[8 * t + k] = BANDS[b][k]; glyphs[8 * (128 + t) + k] = s ? STAR[k] : 0; }
}

// ---- the cell map ----
export const HUD_ATTR = A(1, 6, 1);
const HUD_TEXT = 'FINE COLOUR SPIKE F1    TICK 000';
export const initCells = new Uint8Array(768), initAttrs = new Uint8Array(768);
for (let c = 0; c < 32; c++) { initCells[c] = HUD_TEXT.charCodeAt(c) || 32; initAttrs[c] = HUD_ATTR; }
for (let r = 1; r < 24; r++) for (let c = 0; c < 32; c++) {
  const band = Math.min(5, Math.floor((r - 1) / 4)), star = ((r * 37 + c * 11) % 7) === 0 ? 1 : 0;
  initCells[32 * r + c] = 128 + 2 * band + star; initAttrs[32 * r + c] = tileRows[8 * (2 * band)];   // (row 0's, unused in fine)
}
export const HUD_DIGIT_CELLS = [29, 30, 31];
/** The cell map of state n: the HUD counter shows n mod 1000. */
export function cellsAt(n) {
  const cells = initCells.slice();
  const d = String(n % 1000).padStart(3, '0');
  HUD_DIGIT_CELLS.forEach((c, i) => { cells[c] = d.charCodeAt(i); });
  return cells;
}

// ---- sprite assets (rows: strings, '#' ink, '.' transparent; mask = transparent outside the art) ----
function asset(rows, inks) {
  const w = rows[0].length, h = rows.length;
  const image = rows.map((r) => parseInt(r.replace(/[^#]/g, '0').replace(/#/g, '1'), 2));
  const mask = rows.map((r) => parseInt(r.replace(/\./g, '1').replace(/[^1]/g, '0'), 2));   // 'o' = opaque paper (outline)
  return { w, h, image, mask, inks };
}
export const assets = [
  asset([ // 0 ship
    '.......##.......', '......o##o......', '......####......', '.....o####o.....', '.....######.....', '....o##oo##o....',
    '..o###o##o###o..', '.o############o.', 'o##############o', '###.########.###', '##..o######o..##', '#....######....#',
    '.....o#oo#o.....', '.....##..##.....', '....o##..##o....', '.....#....#.....'],
  [7, 7, 7, 5, 5, 5, 5, 5, 4, 4, 4, 4, 6, 6, 2, 2]),
  asset([ // 1 scout
    '...o##oo##o.....'.padEnd(16, '.'), '..o########o....', '.o##########o...', 'o##o##oo##o##o..', '##############..', '##.########.##..',
    '.o#.o#oo#o.#o...', '..#..#..#..#....', '................', '................', '................', '................',
    '................', '................', '................', '................'].slice(0, 16),
  [2, 2, 3, 3, 6, 6, 3, 2, 0, 0, 0, 0, 0, 0, 0, 0]),
  asset([ // 2 heavy
    '....o######o....', '..o##########o..', '.o###o####o###o.', 'o####.####.####o', '################', '##o##########o##',
    '##.o########o.##', '##..########..##', '.#..o######o..#.', '....##o##o##....', '...o##.##.##o...', '..o##..##..##o..',
    '..##...##...##..', '..#....##....#..', '.......##.......', '.......#........'],
  [6, 6, 6, 6, 4, 4, 4, 4, 5, 5, 5, 1, 1, 1, 7, 7]),
  asset(['..##....', '..##....', '.o##o...', '.o##o...', '..##....', '..##....', '...#....', '........'], [7, 7, 6, 6, 6, 2, 2, 0]),   // 3 bullet
  asset(['...#....', '..###...', '.##o##..', '###o###.', '.##o##..', '..###...', '...#....', '........'], [2, 2, 3, 6, 3, 2, 2, 0]),  // 4 shot
];
export const instAsset = [0, 3, 3, 3, 3, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4];

// ---- the script: positions of every instance at tick n (period 256) ----
const S = (n, period, amp, ph = 0) => Math.round(amp * Math.sin(2 * Math.PI * (n + ph) / period));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function positions(n) {
  n = ((n % SCRIPT_TICKS) + SCRIPT_TICKS) % SCRIPT_TICKS;
  const p = [];
  p.push({ x: 120 + S(n, 128, 100), y: 168 - Math.abs(S(n, 64, 8)) });                                    // ship
  for (let k = 1; k <= 4; k++) p.push({ x: 24 + 52 * k + S(n, 32, 6, 8 * k), y: 4 + ((176 - ((n * 6 + k * 44) % 176)) % 176) });   // bullets
  for (let k = 0; k < 2; k++) p.push({ x: 60 + 110 * k + S(n, 128, 40, 30 * k), y: 6 + S(n, 64, 10, 20 * k) });  // scouts in the top rows (over the HUD)
  p.push({ x: 120 + S(n, 96, 100), y: 56 + S(n, 48, 20) });                                                 // two scouts crossing
  p.push({ x: 120 - S(n, 96, 100), y: 60 + S(n, 48, 18, 12) });
  for (let k = 0; k < 4; k++) p.push({ x: 24 + 56 * k + S(n, 64, 16), y: 96 + S(n, 80, 30, 8 * k) });      // heavies
  for (let k = 0; k < 3; k++) p.push({ x: 40 + 80 * k + S(n, 40, 30, 10 * k), y: (n * 5 + 61 * k) % 176 });  // shots falling
  return p.map((q, j) => {
    const a = assets[instAsset[j]];
    return { asset: instAsset[j], x: clamp(q.x, 0, 256 - a.w), y: clamp(q.y, 0, 192 - a.h) };
  });
}
export const stateSprites = (n) => positions(n);
export function picture(n) {
  return finePicture({ cells: cellsAt(n), attrs: initAttrs, glyphs, tileRows, sprites: positions(n), assets });
}

// ---- data images for the cartridge (addresses must match fine.asm) ----
export const ADDR = { GLYPH: 0x2000, TILE_ROWS: 0x2800, ASSET_TAB: 0x2C00, ROW_TAB: 0x2D00, INST_ASSET: 0x2F00, INIT_CELLS: 0x3000,
  INIT_ATTRS: 0x3300, PHASES: 0x8000, SCRIPT: 0xA000 };
/** Writes the data into a 64 KB image (the DOCK chunks 1, 4 and 5). */
export function placeData(img) {
  for (let v = 0; v < 256; v++) for (let k = 0; k < 8; k++) img[ADDR.GLYPH + 256 * k + v] = glyphs[8 * v + k];   // planes
  img.set(tileRows, ADDR.TILE_ROWS);
  let p = ADDR.PHASES;
  assets.forEach((a, ai) => {
    const rec = ADDR.ASSET_TAB + 32 * ai;
    img[rec] = a.h; img[rec + 1] = a.w >> 3; img[rec + 2] = a.w;
    preshift(a).forEach((ph, k) => {
      img[rec + 4 + 2 * k] = p & 255; img[rec + 5 + 2 * k] = p >> 8;
      img.set(ph.bytes, p); p += ph.bytes.length;
    });
  });
  if (p > ADDR.SCRIPT) throw new Error('phase tables overflow chunk 4');
  for (let y = 0; y < 192; y++) { const a = 0x4000 + rowOff(y, 0); img[ADDR.ROW_TAB + 2 * y] = a & 255; img[ADDR.ROW_TAB + 2 * y + 1] = a >> 8; }
  img.set(instAsset, ADDR.INST_ASSET);
  img.set(initCells, ADDR.INIT_CELLS); img.set(initAttrs, ADDR.INIT_ATTRS);
  for (let n = 0; n < SCRIPT_TICKS; n++) positions(n).forEach((q, j) => { img[ADDR.SCRIPT + 32 * n + 2 * j] = q.x; img[ADDR.SCRIPT + 32 * n + 2 * j + 1] = q.y; });
  return p - ADDR.PHASES;
}
