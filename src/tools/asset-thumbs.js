/**
 * src/tools/asset-thumbs.js — small pictures of Studio assets, for the gallery strip of the Sprites, Tiles, Maps and Models tabs
 * (stage 5, S1). Pure: no DOM, Node can import it.
 *
 *   thumbSprite(asset, opts)        the sprite's first frame (opts.frame), in its own colours; transparent where the mask is clear
 *   thumbTileset(asset, opts)       the tiles in a near-square grid (all of them: a set holds at most 128, which is 12 x 11 tiles)
 *   thumbMap(asset, ctx, opts)      the whole map, one 8 x 8 cell per tile of the map's tile set
 *   thumbModel(asset, opts)         the wireframe at a fixed yaw (model-preview.js previewSegments), light lines on a dark ground
 *   placeholder(box)                what every function returns for an asset it cannot read (never throws)
 *
 * Every function returns { w, h, rgba, placeholder? } where `rgba` is a Uint8ClampedArray of w * h * 4 bytes, row-major, straight
 * (not premultiplied) alpha: new ImageData(t.rgba, t.w, t.h) draws it. The picture is scaled to fit a square box (opts.box, default
 * DEFAULT_BOX = 48 pixels; opts.box is clamped to 4..256) keeping its aspect: a small picture is enlarged by a whole number
 * (nearest neighbour), a big one is sampled down (nearest neighbour; a map whose cells come out under 3 pixels is drawn as flat
 * cells in each tile's average colour, so that its layout stays readable). Sprites and tile sets are drawn from the colour model of
 * sprite-model.js / tile-model.js (opts.palette: the host's 16-entry palette, default sprite-model's PALETTE); a sprite is transparent
 * where its mask is clear, the other three are opaque.
 *
 * thumbMap's second argument is the context the editor resolves (the tile set that goes with the map is the editor's business: the
 * program's roles decide it): { tileset: the tile set ASSET or null, fine: true when a scene is 8 x 1 colour, role: 'cell' | 'world' |
 * 'floorplan' }. A map whose tile set is missing is still drawn, in flat greys (a shade per tile number), with `noTileset: true`;
 * a floor plan is drawn from its wall codes 0..4. A cell the tile set does not define is a dark red cell.
 */

"use strict";

import * as S from './sprite-model.js';
import * as T from './tile-model.js';
import * as M from './map-model.js';
import { previewSegments } from './model-preview.js';

export const DEFAULT_BOX = 48;
const MODEL_YAW = 0.6;                                   // radians: a three-quarter view
const FP_COLOURS = [null, 13, 12, 9, 11];                // floor plan wall codes 1..4 as palette indices (the map editor's)
const BLANK_RGB = [38, 42, 49];                          // a blank cell of a cell map
const UNDEFINED_RGB = [58, 29, 29];                      // a cell whose tile the tile set does not define
const FLAT_RGB = [85, 85, 85];                           // the base of the greys of a map without a tile set
const FLOOR_EMPTY_RGB = [20, 22, 28];
const FLOOR_ODD_RGB = [122, 60, 255];
const MODEL_BG = [24, 28, 36];
const MODEL_FG = [140, 200, 255];

const pack = (r, g, b) => (r << 16) | (g << 8) | b;
const boxOf = (opts) => { const b = Math.round(+opts?.box); return Number.isFinite(b) ? Math.max(4, Math.min(256, b)) : DEFAULT_BOX; };
const rgbOfKey = (key, pal) => S.keyRGB(key, pal);

/** A plain box with a cross: the picture of an asset that cannot be read (or has nothing to show). */
export function placeholder(box = DEFAULT_BOX) {
  const n = Math.max(4, Math.min(256, Math.round(+box) || DEFAULT_BOX));
  const rgba = new Uint8ClampedArray(n * n * 4);
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const edge = x === 0 || y === 0 || x === n - 1 || y === n - 1;
      const diag = x === y || x + y === n - 1;
      if (edge || diag) rgba.set([120, 128, 140, 255], (y * n + x) * 4);
    }
  }
  return { w: n, h: n, rgba, placeholder: true };
}

/**
 * sw x sh source pixels, read through sample(x, y) -> packed 0xRRGGBB, or -1 for transparent, scaled into the box.
 * Whole-number enlargement when it fits, nearest-neighbour sampling when it does not.
 */
function render(sw, sh, sample, box) {
  if (!(sw >= 1 && sh >= 1)) return placeholder(box);
  const s = Math.min(box / sw, box / sh);
  const ow = s >= 1 ? sw * Math.floor(s) : Math.max(1, Math.round(sw * s));
  const oh = s >= 1 ? sh * Math.floor(s) : Math.max(1, Math.round(sh * s));
  const rgba = new Uint8ClampedArray(ow * oh * 4);
  for (let oy = 0; oy < oh; oy++) {
    const sy = Math.min(sh - 1, Math.floor((oy + 0.5) * sh / oh));
    for (let ox = 0; ox < ow; ox++) {
      const v = sample(Math.min(sw - 1, Math.floor((ox + 0.5) * sw / ow)), sy);
      if (v < 0) continue;
      const i = (oy * ow + ox) * 4;
      rgba[i] = (v >> 16) & 255; rgba[i + 1] = (v >> 8) & 255; rgba[i + 2] = v & 255; rgba[i + 3] = 255;
    }
  }
  return { w: ow, h: oh, rgba };
}

/** The 16 (15 distinct) colours of a palette as packed numbers, by key. */
function packedPalette(pal) {
  const out = new Int32Array(16);
  for (let k = 0; k < 16; k++) { const c = rgbOfKey(k, pal); out[k] = pack(c[0], c[1], c[2]); }
  return out;
}

// ── sprite ────────────────────────────────────────────────────────────────────────────────────────────────────
export function thumbSprite(asset, opts = {}) {
  const box = boxOf(opts);
  try {
    const sprite = S.fromAsset(asset);
    const f = Math.max(0, Math.min(sprite.frames.length - 1, Number.isInteger(opts.frame) ? opts.frame : 0));
    const keys = S.framePixels(sprite, f), pk = packedPalette(opts.palette);
    return render(sprite.w, sprite.h, (x, y) => { const k = keys[y * sprite.w + x]; return k < 0 ? -1 : pk[S.normKey(k)]; }, box);
  } catch { return placeholder(box); }
}

// ── tile set ──────────────────────────────────────────────────────────────────────────────────────────────────
/** One tile as 64 packed colours. */
function tileRgb(tile, fine, pk) {
  const keys = T.tilePixels(tile, { fine: fine || T.hasRowColours(tile) });
  const out = new Int32Array(64);
  for (let i = 0; i < 64; i++) out[i] = pk[S.normKey(keys[i])];
  return out;
}
export function thumbTileset(asset, opts = {}) {
  const box = boxOf(opts);
  try {
    const set = T.fromAsset(asset), n = Math.min(set.tiles.length, 128);
    if (!n) return placeholder(box);
    const pk = packedPalette(opts.palette), px = set.tiles.slice(0, n).map((t) => tileRgb(t, !!opts.fine, pk));
    const cols = Math.min(16, Math.ceil(Math.sqrt(n))), rows = Math.ceil(n / cols);
    return render(cols * 8, rows * 8, (x, y) => {
      const i = (y >> 3) * cols + (x >> 3);
      return i < n ? px[i][(y & 7) * 8 + (x & 7)] : -1;
    }, box);
  } catch { return placeholder(box); }
}

// ── map ───────────────────────────────────────────────────────────────────────────────────────────────────────
const grey = (t) => { const v = Math.min(235, FLAT_RGB[0] + ((t * 37) % 120)); return pack(v, v, v); };
export function thumbMap(asset, ctx = {}, opts = {}) {
  const box = boxOf(opts);
  try {
    const m = M.fromAsset(asset), role = ctx?.role === 'world' || ctx?.role === 'floorplan' ? ctx.role : 'cell';
    const pal = opts.palette ?? ctx?.palette, pk = packedPalette(pal);
    let tiles = null;
    if (role !== 'floorplan' && ctx?.tileset) { try { tiles = T.fromAsset(ctx.tileset).tiles.map((t) => tileRgb(t, !!ctx.fine, pk)); } catch { tiles = null; } }
    const avg = tiles ? tiles.map((px) => {
      let r = 0, g = 0, b = 0;
      for (const v of px) { r += (v >> 16) & 255; g += (v >> 8) & 255; b += v & 255; }
      return pack(Math.round(r / 64), Math.round(g / 64), Math.round(b / 64));
    }) : null;
    const flat = (v) => {
      if (role === 'floorplan') {
        const code = v < 0 ? 0 : v;
        if (code === 0) return pack(...FLOOR_EMPTY_RGB);
        return code <= 4 ? pk[FP_COLOURS[code]] : pack(...FLOOR_ODD_RGB);
      }
      const t = v === M.BLANK ? (role === 'world' ? 0 : null) : v;
      if (t === null) return pack(...BLANK_RGB);
      if (!tiles) return grey(t);
      return t < tiles.length ? avg[t] : pack(...UNDEFINED_RGB);
    };
    const sw = m.w * 8, sh = m.h * 8, cellOut = 8 * Math.min(box / sw, box / sh);
    const useAvg = cellOut < 3 || role === 'floorplan' || !tiles;
    const out = render(sw, sh, (x, y) => {
      const v = m.cells[(y >> 3) * m.w + (x >> 3)];
      if (useAvg) return flat(v);
      const t = v === M.BLANK ? (role === 'world' ? 0 : null) : v;
      return t !== null && t < tiles.length ? tiles[t][(y & 7) * 8 + (x & 7)] : flat(v);
    }, box);
    if (role !== 'floorplan' && !tiles) out.noTileset = true;
    return out;
  } catch { return placeholder(box); }
}

// ── model ─────────────────────────────────────────────────────────────────────────────────────────────────────
export function thumbModel(asset, opts = {}) {
  const box = boxOf(opts);
  try {
    const segs = previewSegments(asset, MODEL_YAW, box, box);
    if (!segs.length) return placeholder(box);
    const bg = opts.bg ?? MODEL_BG, fg = opts.fg ?? MODEL_FG;
    const rgba = new Uint8ClampedArray(box * box * 4);
    for (let i = 0; i < box * box; i++) rgba.set([bg[0], bg[1], bg[2], 255], i * 4);
    const plot = (x, y) => { if (x >= 0 && y >= 0 && x < box && y < box) rgba.set([fg[0], fg[1], fg[2], 255], (y * box + x) * 4); };
    for (const seg of segs) {
      if (!seg.every(Number.isFinite)) continue;
      let [x0, y0, x1, y1] = seg.map(Math.round);
      const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      for (let guard = 0; guard < 2000; guard++) {            // Bresenham; the guard keeps a runaway coordinate from looping
        plot(x0, y0);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
    }
    return { w: box, h: box, rgba };
  } catch { return placeholder(box); }
}
