/**
 * src/lang/arcade/arcade-assets.js — Leap Arcade asset converters for milestone M3 (pure; no DOM, no node: imports).
 *
 *   convertTileset(asset)   -> {count, bytes, tiles}   bytes = count x (8 bitmap bytes + 1 attribute byte), the runtime v1 format
 *   convertSfx(asset)       -> {records, bytes}        bytes = 4 bytes per tick + a 4-byte terminator (tone_hi byte $FF)
 *   convertMap(asset, n)    -> {w, h, cells, bytes}    bytes = the 768 CELL_TILE bytes (tile = 128 + index, blank = 32)
 *   lookupAsset(table, ...names) -> asset | undefined  exact name first, then case-insensitive
 *   assetTables(assets)     -> {sprites, tilesets, sfx, maps}   see below
 *
 * Asset shapes (docs/ARCADE_ASSETS.md, as extended here where that file is silent):
 *   tileset {tiles: [{rows: [8 x {bits, ink, paper, bright}], flags}]}   bits = 8-bit number or 1..2 hex digits, MSB = left pixel;
 *           the tile's attribute byte is taken from its FIRST row: bright<<6 | paper<<3 | ink (defaults ink 0, paper 7, bright 0).
 *           At most 128 tiles (the runtime's cell value has 7 bits for the index).
 *   sfx     {ticks: [{tone 0..4095, vol 0..15, noise 0..31, mix 0..7}]}   record = tone_lo, tone_hi | vol << 4, noise | mix << 5, 0.
 *           A tone of 3840..4095 with volume 15 would make the second byte $FF, the terminator: it is refused.
 *           At most 255 ticks are not enforced; the table holds at most 8 effects (checked by the code generator).
 *   map     {w, h, cells}  w <= 32, h <= 24; cells = array (or hex string, 2 digits per cell) of w*h values, each a tile index
 *           0..127 or blank (-1, null, or 255 / "FF"); placed at the top-left of the 32 x 24 cell map, the other cells are font
 *           spaces. (docs/ARCADE_ASSETS.md says "hex or run-length"; run-length is not implemented.)
 * `assets` passed to compile() is {sprites, tilesets, sfx, maps} (each a name -> asset object). For compatibility with M2 a
 * value that has none of those four keys is taken to be the sprites table itself.
 */

"use strict";

export const MAX_TILES = 128;
export const MAX_SFX = 8;
export const CELLS = 768;
export const BLANK_CELL = 32;               // font space
export const TILE_CELL = 128;               // cell value of tile 0

export function assetTables(assets) {
  const a = assets ?? {};
  const named = ['sprites', 'tilesets', 'sfx', 'maps'];
  if (named.some((k) => k in a)) {
    return { sprites: a.sprites ?? {}, tilesets: a.tilesets ?? {}, sfx: a.sfx ?? {}, maps: a.maps ?? {} };
  }
  return { sprites: a, tilesets: {}, sfx: {}, maps: {} };
}

export function lookupAsset(table, ...names) {
  if (!table) return undefined;
  for (const name of names) {
    if (name === undefined) continue;
    if (Object.hasOwn(table, name)) return table[name];
    const k = Object.keys(table).find((x) => x.toUpperCase() === String(name).toUpperCase());
    if (k !== undefined) return table[k];
  }
  return undefined;
}

function bits8(v, what) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255) return v;
  if (typeof v === 'string' && /^[0-9a-fA-F]{1,2}$/.test(v.trim())) return parseInt(v.trim(), 16);
  throw new Error(`${what} must be a number 0..255 or one or two hex digits, got ${JSON.stringify(v)}`);
}
function int(v, lo, hi, what, dflt) {
  if (v === undefined || v === null) { if (dflt !== undefined) return dflt; throw new Error(`${what} is missing`); }
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} must be a whole number ${lo}..${hi}, got ${JSON.stringify(v)}`);
  return v;
}

/** The attribute byte of a tile: bright<<6 | paper<<3 | ink from its first row. */
export function tileAttr(row0, what = 'tile') {
  const ink = int(row0?.ink, 0, 7, `${what} ink`, 0);
  const paper = int(row0?.paper, 0, 7, `${what} paper`, 7);
  const bright = int(row0?.bright === true ? 1 : row0?.bright === false ? 0 : row0?.bright, 0, 1, `${what} bright`, 0);
  return (bright << 6) | (paper << 3) | ink;
}

export function convertTileset(asset) {
  const tiles = asset?.tiles ?? asset?.frames;
  if (!Array.isArray(tiles)) throw new Error('the tileset has no "tiles" array');
  if (tiles.length < 1) throw new Error('the tileset has no tiles');
  if (tiles.length > MAX_TILES) throw new Error(`the tileset has ${tiles.length} tiles; at most ${MAX_TILES} are supported`);
  const bytes = new Uint8Array(tiles.length * 9);
  const flags = new Array(tiles.length).fill(0);
  let flagsProblem = null;                     // language batch 2: a tile's flags (0..255); only a WINDOW game needs them, so a bad value is reported there
  tiles.forEach((t, i) => {
    const f = t?.flags;
    if (f !== undefined && f !== null) { if (Number.isInteger(f) && f >= 0 && f <= 255) flags[i] = f; else flagsProblem ??= `tile ${i} flags must be a whole number 0..255, got ${JSON.stringify(f)}`; }
    const rows = t?.rows;
    if (!Array.isArray(rows) || rows.length !== 8) throw new Error(`tile ${i} needs exactly 8 rows`);
    rows.forEach((r, y) => { bytes[i * 9 + y] = bits8(r?.bits, `tile ${i} row ${y} bits`); });
    bytes[i * 9 + 8] = tileAttr(rows[0], `tile ${i}`);
  });
  return { count: tiles.length, bytes, tiles, flags, flagsProblem };
}

export function convertSfx(asset) {
  const ticks = asset?.ticks;
  if (!Array.isArray(ticks)) throw new Error('the sound effect has no "ticks" array');
  const bytes = new Uint8Array((ticks.length + 1) * 4);
  ticks.forEach((t, i) => {
    const tone = int(t?.tone, 0, 4095, `tick ${i} tone`);
    const vol = int(t?.vol, 0, 15, `tick ${i} vol`, 0);
    const noise = int(t?.noise, 0, 31, `tick ${i} noise`, 0);
    const mix = int(t?.mix, 0, 7, `tick ${i} mix`, 0);
    const hi = (tone >> 8) | (vol << 4);
    if (hi === 0xFF) throw new Error(`tick ${i}: tone ${tone} with volume 15 cannot be stored (the byte $FF ends an effect); lower the volume or the tone`);
    bytes.set([tone & 0xFF, hi, noise | (mix << 5), 0], i * 4);
  });
  bytes.set([0, 0xFF, 0, 0], ticks.length * 4);       // terminator record
  return { records: ticks.length, bytes };
}

export function convertMap(asset, tileCount = MAX_TILES) {
  const w = int(asset?.w, 1, 32, 'map w'), h = int(asset?.h, 1, 24, 'map h');
  let cells = asset?.cells;
  if (typeof cells === 'string') {
    const s = cells.replace(/\s+/g, '');
    if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error('map cells as a string must be hex, two digits per cell');
    cells = s.match(/../g)?.map((x) => parseInt(x, 16)) ?? [];
  }
  if (!Array.isArray(cells)) throw new Error('the map has no "cells"');
  if (cells.length !== w * h) throw new Error(`the map is ${w} x ${h} = ${w * h} cells but "cells" has ${cells.length}`);
  const bytes = new Uint8Array(CELLS).fill(BLANK_CELL);
  cells.forEach((v, i) => {
    let b = BLANK_CELL;
    if (!(v === null || v === -1 || v === 255)) {
      if (!Number.isInteger(v) || v < 0 || v >= tileCount) throw new Error(`map cell ${i} is ${JSON.stringify(v)}: a tile index 0..${tileCount - 1}, or blank (-1, null or 255)`);
      b = TILE_CELL + v;
    }
    bytes[(Math.floor(i / w)) * 32 + (i % w)] = b;
  });
  return { w, h, cells, bytes };
}

// ── Language batch 2: sprites of runtime v3 (widths 8..32, heights up to 48, frames, mirrored copies) ──────────────────────────────

function parseWide(v, what) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF) return v;
  if (typeof v === 'string' && /^[0-9a-fA-F]{1,8}$/.test(v.trim())) return parseInt(v.trim(), 16);
  throw new Error(`${what} must be a number or a hex string of up to 8 digits, got ${JSON.stringify(v)}`);
}
/** Reverse the lowest `n` bits of v (n <= 32). */
function reverseBits(v, n) {
  let r = 0;
  for (let i = 0; i < n; i++) { r = r * 2 + (v % 2); v = Math.floor(v / 2); }
  return r;
}
const byteOf = (v, k) => Math.floor(v / 2 ** (8 * k)) % 256;

/** The frames of a sprite asset as lists of rows: its `frames` array, else its single `rows`. */
export function assetFrames(asset) {
  if (Array.isArray(asset?.frames) && asset.frames.length) return asset.frames.map((f) => f?.rows);
  return [asset?.rows];
}
/** How many frames the compiler compiles from the asset: all of them when the program gives it a FRAME, else frame 0 only. */
export const compiledFrameCount = (asset, allFrames) => (allFrames ? assetFrames(asset).length : 1);

/**
 * Asset sprite -> runtime v3 frame data: `nframes` blocks (the compiled frames, then, with `flip`, the same frames mirrored left to right) of `h` rows;
 * a row is `wb` mask bytes then `wb` image bytes, `wb` = ceil(w / 8), leftmost pixel = bit 7 of the first byte, contract mask 1 = the background shows
 * (the asset's mask is 1 where the sprite covers; a row with no mask covers its whole width). A width that is not a multiple of 8 is padded on the right
 * with transparent pixels (descriptor width = 8 * wb); the mirrored copy is mirrored within the sprite's own width.
 *   opts: {allFrames, flip}
 *   -> {w: 8 * wb, srcW, h, wb, framesSrc, nframes, data}   framesSrc = compiled source frames (n), nframes = n or 2n
 * Limits: w 1..32, h 1..48, at most 32 frames after mirroring (16 source frames with flip).
 */
export function convertSpriteV3(asset, { allFrames = false, flip = false } = {}) {
  const w = asset.w ?? 16;
  const frames = assetFrames(asset);
  const first = allFrames ? frames[0] : (asset.rows ?? frames[0]);
  if (!Array.isArray(first)) throw new Error('the sprite has no rows');
  const h = asset.h ?? first.length;
  if (!(Number.isInteger(w) && w >= 1 && w <= 32)) throw new Error(`width ${w} is not supported (1..32 pixels; 8, 16, 24 or 32 are the natural widths)`);
  if (!(Number.isInteger(h) && h >= 1 && h <= 48)) throw new Error(`height ${h} is not supported (1..48 rows)`);
  const list = allFrames ? frames : [first];
  const n = list.length;
  if (n > 32 || (flip && n > 16)) throw new Error(flip ? `${n} frames and FLIP: the mirrored copies make ${2 * n}, at most 32 frames fit (16 frames with FLIP)` : `${n} frames: at most 32 frames per sprite`);
  const wb = Math.ceil(w / 8), W = 8 * wb;
  const wmask = 2 ** w - 1;
  const rowsOf = list.map((rows, k) => {
    if (!Array.isArray(rows)) throw new Error(`frame ${k} has no rows`);
    if (rows.length !== h) throw new Error(`the sprite says h = ${h} but ${n > 1 ? `frame ${k} has` : 'it has'} ${rows.length} rows`);
    return rows.map((r, i) => {
      const bits = parseWide(r?.bits, `frame ${k} row ${i} bits`) % (wmask + 1);
      const covers = (r?.mask === undefined || r?.mask === null ? wmask : parseWide(r.mask, `frame ${k} row ${i} mask`) % (wmask + 1));
      return { bits: Number(BigInt(bits) & BigInt(covers)), covers };
    });
  });
  const emit = (rows, mirror) => {
    const out = [];
    for (const { bits, covers } of rows) {
      const b = mirror ? reverseBits(bits, w) : bits, c = mirror ? reverseBits(covers, w) : covers;
      // left-align in W bits: pixel 0 is the top bit of the W-bit word
      const cw = c * 2 ** (W - w), bw = b * 2 ** (W - w);
      const maskW = (2 ** W - 1) - cw;                 // the contract mask: 1 = background shows (also outside the sprite's own width)
      for (let k = wb - 1; k >= 0; k--) out.push(byteOf(maskW, k));
      for (let k = wb - 1; k >= 0; k--) out.push(byteOf(bw, k));
    }
    return out;
  };
  const bytes = [];
  for (const rows of rowsOf) bytes.push(...emit(rows, false));
  if (flip) for (const rows of rowsOf) bytes.push(...emit(rows, true));
  return { w: W, srcW: w, h, wb, framesSrc: n, nframes: flip ? 2 * n : n, data: Uint8Array.from(bytes) };
}
