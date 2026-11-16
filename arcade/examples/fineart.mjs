// fineart.mjs -- drawing helpers for the fine-colour (8 x 1 colour) art of the example games (docs/ARCADE_FINE_COLOUR_CONTRACT.md section 2).
// Used by the asset generators (shooter.assets.gen.mjs, ...); Node only (it reads the runtime's font).
//
// The art is painted as a full-colour PICTURE first: 256 x 192 pixels, each a colour 0..7 (black, blue, red, magenta, green, cyan, yellow, white,
// the TS2068's order of brightness), or -1 for "nothing painted here" (black).  Shading uses RAMPS: a list of colours that are neighbours in
// brightness, and a continuous level along the ramp; a level between two colours is drawn as an ORDERED DITHER of those two colours (a 4 x 4 Bayer
// pattern, quantised to quarters, so a half step is a checkerboard and a whole step is a solid colour).  Two colours that are far apart in
// brightness are never dithered together.
// Then the picture is cut into the screen's 8 x 1 groups: each group keeps its two most used colours (the most used becomes the PAPER, the other
// the INK, so the INK pixels are the fewer: a sprite passing over a group recolours its ink), and into 8 x 8 TILES, which are de-duplicated into a
// tileset shared by all the maps of the game (at most 128 tiles).
//
//   picture()                           -> Int8Array(256 * 192) filled with -1
//   dither(x, y, level, ramp, {seam})   -> the colour of pixel (x, y) at a level 0 .. ramp.length - 1 of the ramp (seam: the dithered share of a step)
//   text(pic, str, x, y, colourOfRow, scale)  paints the runtime's font (8 x 8, or scaled 2 / 3), colourOfRow(row, col) -> colour of that pixel
//   tiler()                             -> {tiles, add(pic, r0, c0, h, w) -> cells (h * w tile indices), count}
//   groups(pic, y, c)                   -> {bits, ink, paper} of one 8 x 1 group (what a tile row holds)
"use strict";
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const W = 256, H = 192;

export const FONT = (() => {
  const g = [];
  for (const line of readFileSync(join(HERE, '../runtime/v1/font.inc'), 'utf8').split('\n')) {
    const m = line.match(/^\s*DB\s+(.*?)\s*;/);
    if (m) g.push(m[1].split(',').map((s) => parseInt(s.trim().replace('$', ''), 16)));
  }
  if (g.length !== 96) throw new Error('font.inc: expected 96 glyphs, got ' + g.length);
  return g;
})();

export const picture = () => new Int8Array(W * H).fill(-1);

// a 4 x 4 Bayer matrix: thresholds 0..15; a fraction f (quantised to quarters) lights the pixels whose threshold is below 16 f
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
export function dither(x, y, level, ramp, { seam = 0.3 } = {}) {
  const top = ramp.length - 1;
  if (level <= 0) return ramp[0];
  if (level >= top) return ramp[top];
  // seam > 0: a crisp band edge, only the middle `seam` of each step is dithered (as a checkerboard); 0 = a smooth four-step dither
  const lo = Math.floor(level), g = level - lo;
  const f = seam > 0 ? (g < 0.5 - seam / 2 ? 0 : g > 0.5 + seam / 2 ? 1 : 0.5) : Math.round(g * 4) / 4;
  return 16 * f > BAYER[y & 3][x & 3] ? ramp[lo + 1] : ramp[lo];
}

export function set(pic, x, y, c) { if (x >= 0 && x < W && y >= 0 && y < H && c !== undefined && c !== null) pic[y * W + x] = c; }
export const get = (pic, x, y) => (x >= 0 && x < W && y >= 0 && y < H ? pic[y * W + x] : -1);

/** Paint `str` in the runtime's font at pixel (x, y), each glyph pixel scaled `scale` times; colourOf(py, px) gives the colour of a lit pixel
 *  (py, px: the pixel's offset from the top-left of the text, in screen pixels); `shadow` (a colour) adds a drop shadow one pixel down-right. */
export function text(pic, str, x, y, colourOf, { scale = 1, shadow = null, bold = false } = {}) {
  [...str].forEach((ch, i) => {
    const g = FONT[ch.charCodeAt(0) - 32] ?? FONT[0];
    for (let r = 0; r < 8; r++) for (let b = 0; b < 8; b++) {
      const on = (g[r] >> (7 - b)) & 1 || (bold && b > 0 && (g[r] >> (8 - b)) & 1);
      if (!on) continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) {
        const px = x + 8 * scale * i + b * scale + sx, py = y + r * scale + sy;
        if (shadow !== null && get(pic, px + 1, py + 1) === -1) set(pic, px + 1, py + 1, -2);   // -2 marks a shadow pixel (filled in below)
        set(pic, px, py, colourOf(py - y, px - x));
      }
    }
  });
  if (shadow !== null) for (let k = 0; k < W * H; k++) if (pic[k] === -2) pic[k] = shadow;
}

/** One 8 x 1 group of the picture: {bits, ink, paper}.  The two most used colours (ties: the darker is the paper); a third colour joins the nearer
 *  of the two in brightness.  -1 (unpainted) counts as black. */
export function group(pic, y, c) {
  const px = [];
  for (let b = 0; b < 8; b++) { const v = pic[y * W + 8 * c + b]; px.push(v < 0 ? 0 : v & 7); }
  const n = new Array(8).fill(0);
  px.forEach((v) => n[v]++);
  const order = [...n.keys()].filter((k) => n[k] > 0).sort((a, b) => n[b] - n[a] || a - b);
  const paper = order[0], ink = order[1] ?? order[0];
  let bits = 0;
  px.forEach((v, b) => { if (v !== paper && (v === ink || Math.abs(v - ink) < Math.abs(v - paper))) bits |= 0x80 >> b; });
  return { bits, ink, paper };
}

/** A tileset under construction: add() cuts a block of cells out of a picture, de-duplicating tiles (the same eight rows of bits, ink, paper);
 *  a row with no lit pixel is stored with ink = paper's neighbour 7 (white) unless `inkOfEmpty` says otherwise, so equal-looking rows share. */
export function tiler(preset = []) {
  const tiles = [...preset], index = new Map();
  const keyOf = (t) => t.rows.map((r) => `${r.bits}/${r.bits === '00' ? '-' : r.ink}/${r.paper}/${r.bright}`).join(' ');
  tiles.forEach((t, i) => { if (!index.has(keyOf(t))) index.set(keyOf(t), i); });
  function tileAt(pic, r, c) {
    const rows = [];
    for (let k = 0; k < 8; k++) {
      const g = group(pic, 8 * r + k, c);
      rows.push({ bits: g.bits.toString(16).toUpperCase().padStart(2, '0'), ink: g.bits ? g.ink : 7, paper: g.paper, bright: 0 });
    }
    return { rows, flags: 0 };
  }
  function add(pic, r0, c0, h, w) {
    const cells = [];
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) {
      const t = tileAt(pic, r, c), k = keyOf(t);
      if (!index.has(k)) { index.set(k, tiles.length); tiles.push(t); }
      cells.push(index.get(k));
    }
    return cells;
  }
  return { tiles, add, get count() { return tiles.length; } };
}
