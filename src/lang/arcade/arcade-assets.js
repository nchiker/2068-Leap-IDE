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
  tiles.forEach((t, i) => {
    const rows = t?.rows;
    if (!Array.isArray(rows) || rows.length !== 8) throw new Error(`tile ${i} needs exactly 8 rows`);
    rows.forEach((r, y) => { bytes[i * 9 + y] = bits8(r?.bits, `tile ${i} row ${y} bits`); });
    bytes[i * 9 + 8] = tileAttr(rows[0], `tile ${i}`);
  });
  return { count: tiles.length, bytes, tiles };
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
