/**
 * src/tools/tile-model.js — the data model of the Leap Arcade Studio tile editor (pure: no DOM, Node can import it).
 *
 * A tile set is edited as a plain object ("set"), different from the stored asset in three ways: the row bit masks are
 * integers, a tile has ONE colour attribute (row 0's: the compiler reads the attribute from row 0 only, and every scene but a fine one
 * draws the tile in it) plus, for a tile of a fine-colour game (8 x 1 colour), an optional colour of its own in each of the 8 pixel rows,
 * and everything the editor does not understand is kept aside and written back unchanged.
 *
 *   set  = { tiles: [tile x 1..128], tilesKey: 'tiles' | 'frames', extra?: {unknown keys of the set} }
 *   tile = { bits: [8 integers 0..255, one per row, MSB = leftmost pixel, 1 = ink], ink 0..7, paper 0..7, bright 0 | 1   (row 0's colours),
 *            rowColours?: [{ink, paper, bright} x 8]  (present only when some row differs from row 0; rowColours[0] always equals ink / paper / bright;
 *                          absent = every row carries ink / paper / bright),
 *            flags 0..255 (bit 0 solid, 1 hazard, 2 pickup, 3..7 game-defined), fg (boolean: "sprites never pass over"),
 *            extra?: {unknown keys of the tile}, rowExtra?: [object | null x 8] (unknown keys of each row),
 *            hadFlags, hadFg: whether the stored tile had those keys (a stored tile without them is written back without them) }
 *
 * Stored form (docs/ARCADE_ASSETS.md, src/lang/arcade/arcade-assets.js convertTileset):
 *   { tiles: [ { rows: [ {bits: "2-digit upper-case hex", ink, paper, bright} x 8 ], flags, fg? , ...unknown } ], ...unknown }
 * toAsset(fromAsset(x)) deep-equals x (and serialises to the same JSON text) for every tile set of the example assets, the fine-colour
 * ones (Starfall, Lumen: a different ink / paper / bright in each pixel row) included: no row colour is dropped.
 *
 *   fromAsset(asset) / toAsset(set)           stored <-> editing form (fromAsset throws an Error with a plain message)
 *   newTileset, newTile, cloneTile, cloneSet  creation
 *   addTile, duplicateTile, pasteTile, deleteLastTile    set operations (indices never move; see the contract, section 4)
 *   getPixel, setPixel, fill, line, drawLine, clearTile, invertTile, flipH, flipV, rotate90, shift     the pixels of one tile
 *   setColours, unifyRows, rowColoursOf, hasRowColours, setFlag, setFg, attrByte, rowAttrs     colours (the whole tile or chosen pixel rows), flags, the foreground mark
 *   tilePixels, projectHasFine, tileIsBlank, tileUsesBlack, tileSummary, rowsDiffer     what a tile looks like / is (tilePixels(tile, {fine}): row 0's colours, or each row's)
 *   validateTileset, validateAsset            the compiler's limits (null = fine, else a message)
 *   createHistory                             undo / redo (re-exported from sprite-model.js), PALETTE, keyRGB likewise
 */

"use strict";

import { PALETTE, keyRGB, createHistory, line, colourKey } from './sprite-model.js';

export { PALETTE, keyRGB, createHistory, line };

// ── limits ────────────────────────────────────────────────────────────────────────────────────────────────────
export const MAX_TILES = 128;          // a cell-map cell holds a 7-bit tile index (arcade-assets.js MAX_TILES)
export const TILE_SIZE = 8;
export const FLAG_NAMES = ['solid', 'hazard', 'pickup', 'bit 3', 'bit 4', 'bit 5', 'bit 6', 'bit 7'];
export const DEFAULT_COLOURS = Object.freeze({ ink: 0, paper: 7, bright: 0 });   // the compiler's defaults, and the "sky" tile

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const bitAt = (v, x) => (v >>> (7 - x)) & 1;
const withBit = (v, x, on) => ((on ? (v | (0x80 >>> x)) : (v & ~(0x80 >>> x))) & 0xFF);
const toHex2 = (v) => (v & 0xFF).toString(16).toUpperCase().padStart(2, '0');
const sameColour = (a, b) => a.ink === b.ink && a.paper === b.paper && a.bright === b.bright;
const inb = (x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < 8 && y >= 0 && y < 8;

// ── creation ──────────────────────────────────────────────────────────────────────────────────────────────────
/** A blank tile (all paper) in the given colours. */
export function newTile({ ink = DEFAULT_COLOURS.ink, paper = DEFAULT_COLOURS.paper, bright = DEFAULT_COLOURS.bright } = {}) {
  return { bits: new Array(8).fill(0), ink, paper, bright, flags: 0, fg: false, hadFlags: true, hadFg: false };
}
export function cloneTile(t) { return clone(t); }
export function cloneSet(s) { return clone(s); }

/** A new tile set: tile 0 blank, ink 0 paper 7 bright 0 (the "sky" tile; the world map treats tile 0 as blank). */
export function newTileset() {
  return { tiles: [newTile()], tilesKey: 'tiles' };
}

// ── stored <-> editing form ───────────────────────────────────────────────────────────────────────────────────
function parseBits(v, what) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255) return v;
  if (typeof v === 'string' && /^[0-9a-fA-F]{1,2}$/.test(v.trim())) return parseInt(v.trim(), 16);
  throw new Error(`${what} must be one or two hex digits (or a number 0..255), got ${JSON.stringify(v)}`);
}
function attrPart(v, lo, hi, dflt, what) {
  if (v === undefined || v === null) return dflt;
  if (!isInt(v, lo, hi)) throw new Error(`${what} must be a whole number ${lo}..${hi}, got ${JSON.stringify(v)}`);
  return v;
}

/**
 * The stored asset -> the editing form. A tile's colours are row 0's (as the compiler reads them); when the other rows carry other colours
 * (a fine-colour tile, 8 x 1 colour) they are kept in `rowColours`, so nothing is lost. Throws an Error with a plain message when the asset cannot be read.
 */
export function fromAsset(asset) {
  if (!isObj(asset)) throw new Error('the tile set is not an object');
  const tilesKey = Array.isArray(asset.tiles) ? 'tiles' : Array.isArray(asset.frames) ? 'frames' : null;
  if (!tilesKey) throw new Error('the tile set has no "tiles" array');
  const list = asset[tilesKey];
  if (list.length < 1) throw new Error('the tile set has no tiles');
  if (list.length > MAX_TILES) throw new Error(`the tile set has ${list.length} tiles; at most ${MAX_TILES} are supported`);
  const set = { tiles: [], tilesKey };
  const extra = {};
  for (const k of Object.keys(asset)) if (k !== tilesKey) extra[k] = clone(asset[k]);
  if (Object.keys(extra).length) set.extra = extra;
  list.forEach((t, i) => {
    if (!isObj(t)) throw new Error(`tile ${i} is not an object`);
    const rows = t.rows;
    if (!Array.isArray(rows) || rows.length !== 8) throw new Error(`tile ${i} needs exactly 8 rows`);
    const what = (y, f) => `tile ${i} row ${y} ${f}`;
    rows.forEach((r, y) => { if (!isObj(r)) throw new Error(`tile ${i} row ${y} is not an object`); });
    const colours = rows.map((r, y) => ({
      ink: attrPart(r.ink, 0, 7, DEFAULT_COLOURS.ink, what(y, 'ink')),
      paper: attrPart(r.paper, 0, 7, DEFAULT_COLOURS.paper, what(y, 'paper')),
      bright: r.bright === true ? 1 : r.bright === false ? 0 : attrPart(r.bright, 0, 1, DEFAULT_COLOURS.bright, what(y, 'bright')),
    }));
    const tile = {
      bits: rows.map((r, y) => parseBits(r.bits, what(y, 'bits'))),
      ink: colours[0].ink, paper: colours[0].paper, bright: colours[0].bright,
      flags: 0, fg: false, hadFlags: false, hadFg: false,
    };
    if (colours.some((c) => !sameColour(c, colours[0]))) tile.rowColours = colours;
    if (t.flags !== undefined && t.flags !== null) {
      if (!isInt(t.flags, 0, 255)) throw new Error(`tile ${i} flags must be a whole number 0..255, got ${JSON.stringify(t.flags)}`);
      tile.flags = t.flags; tile.hadFlags = true;
    }
    if (t.fg !== undefined) {
      if (typeof t.fg !== 'boolean') throw new Error(`tile ${i} fg must be true or false, got ${JSON.stringify(t.fg)}`);
      tile.fg = t.fg; tile.hadFg = true;
    }
    const tx = {};
    for (const k of Object.keys(t)) if (k !== 'rows' && k !== 'flags' && k !== 'fg') tx[k] = clone(t[k]);
    if (Object.keys(tx).length) tile.extra = tx;
    const rx = rows.map((r) => {
      const o = {};
      for (const k of Object.keys(r)) if (!['bits', 'ink', 'paper', 'bright'].includes(k)) o[k] = clone(r[k]);
      return Object.keys(o).length ? o : null;
    });
    if (rx.some(Boolean)) tile.rowExtra = rx;
    set.tiles.push(tile);
  });
  return set;
}

/** The editing form -> the stored asset: bits as 2-digit upper-case hex, each row's colours (the tile's in all 8 rows when it has no rowColours), unknown keys written back. */
export function toAsset(set) {
  const out = {};
  out[set.tilesKey === 'frames' ? 'frames' : 'tiles'] = set.tiles.map((t) => {
    const o = {
      rows: t.bits.map((b, y) => { const c = rowColoursOf(t)[y]; return { bits: toHex2(b), ink: c.ink, paper: c.paper, bright: c.bright, ...(t.rowExtra?.[y] ? clone(t.rowExtra[y]) : {}) }; }),
    };
    if (t.flags !== 0 || t.hadFlags) o.flags = t.flags;
    if (t.fg || t.hadFg) o.fg = !!t.fg;
    if (t.extra) Object.assign(o, clone(t.extra));
    return o;
  });
  if (set.extra) Object.assign(out, clone(set.extra));
  return out;
}

/** Indices of the stored tiles whose rows do not all carry row 0's colours (fine-colour tiles: the editor keeps every row's colours in `rowColours`; it only tells the user). */
export function rowsDiffer(asset) {
  const list = asset?.tiles ?? asset?.frames;
  if (!Array.isArray(list)) return [];
  const same = (a, b) => (a?.ink ?? 0) === (b?.ink ?? 0) && (a?.paper ?? 7) === (b?.paper ?? 7) && (+(a?.bright ?? 0)) === (+(b?.bright ?? 0));
  const bad = [];
  list.forEach((t, i) => { const rows = t?.rows; if (Array.isArray(rows) && rows.some((r) => !same(r, rows[0]))) bad.push(i); });
  return bad;
}

// ── set operations (indices never move) ───────────────────────────────────────────────────────────────────────
/** Append a blank tile with the colours (every row's) of tile `like` (an index; default: the default "sky" colours). Returns its index. Throws RangeError at 128. */
export function addTile(set, { like } = {}) {
  if (set.tiles.length >= MAX_TILES) throw new RangeError(`at most ${MAX_TILES} tiles`);
  const src = Number.isInteger(like) ? set.tiles[like] : null;
  const t = newTile(src ? { ink: src.ink, paper: src.paper, bright: src.bright } : DEFAULT_COLOURS);
  if (src?.rowColours) t.rowColours = clone(src.rowColours);          // a fine-colour tile's blank copy keeps the rows' colours (a sky gradient stays a gradient)
  set.tiles.push(t);
  return set.tiles.length - 1;
}
/** Append a copy of tile `index` (flags, fg and unknown keys included). Returns the new index. Throws RangeError at 128 or for a bad index. */
export function duplicateTile(set, index) {
  if (!set.tiles[index]) throw new RangeError(`no tile ${index}`);
  if (set.tiles.length >= MAX_TILES) throw new RangeError(`at most ${MAX_TILES} tiles`);
  set.tiles.push(cloneTile(set.tiles[index]));
  return set.tiles.length - 1;
}
/** Overwrite tile `index` with a copy of `tile` (bitmap, colours, flags, fg). Returns true. Throws RangeError for a bad index. */
export function pasteTile(set, index, tile) {
  if (!set.tiles[index]) throw new RangeError(`no tile ${index}`);
  set.tiles[index] = cloneTile(tile);
  return true;
}
/**
 * Delete the last tile. `usage` is how many map cells use it (a number) or a list [{name, cells}] of the maps that do; it is not
 * looked up here. `index` (optional) is the tile the user asked to delete: any but the last is refused (numbers must not change meaning).
 * Returns {ok: true, index} (done) or {ok: false, message} (refused; the set is unchanged).
 */
export function deleteLastTile(set, usage = 0, index = set.tiles.length - 1) {
  const last = set.tiles.length - 1;
  if (index !== last) return { ok: false, message: `Only the last tile (${last}) can be deleted: the program names tiles by number, so no number may change its meaning.` };
  if (set.tiles.length <= 1) return { ok: false, message: 'A tile set needs at least one tile.' };
  const list = Array.isArray(usage) ? usage.filter((u) => u && u.cells > 0) : [];
  const total = Array.isArray(usage) ? list.reduce((n, u) => n + u.cells, 0) : (Number(usage) || 0);
  if (total > 0) {
    const where = list.length ? ` (${list.map((u) => `${u.name}: ${u.cells}`).join(', ')})` : '';
    return { ok: false, message: `Tile ${last} is used by ${total} map cell${total === 1 ? '' : 's'}${where}; change those cells first.` };
  }
  set.tiles.pop();
  return { ok: true, index: last };
}

// ── pixels of one tile ────────────────────────────────────────────────────────────────────────────────────────
/** 1 = ink, 0 = paper; out of range reads 0. */
export function getPixel(tile, x, y) { return inb(x, y) ? bitAt(tile.bits[y], x) : 0; }
/** Set one pixel; returns true when it changed. */
export function setPixel(tile, x, y, v) {
  if (!inb(x, y)) return false;
  const nv = withBit(tile.bits[y], x, v ? 1 : 0);
  if (nv === tile.bits[y]) return false;
  tile.bits[y] = nv;
  return true;
}
/** Flood fill (4-connected) of the pixels equal to the one at (x, y) with `v`. Returns the pixel count changed (0 when already v). */
export function fill(tile, x, y, v = 1) {
  if (!inb(x, y)) return 0;
  const target = getPixel(tile, x, y), val = v ? 1 : 0;
  if (target === val) return 0;
  const seen = new Uint8Array(64), stack = [[x, y]];
  let n = 0;
  while (stack.length) {
    const [px, py] = stack.pop();
    if (!inb(px, py) || seen[py * 8 + px] || getPixel(tile, px, py) !== target) continue;
    seen[py * 8 + px] = 1;
    setPixel(tile, px, py, val); n++;
    stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
  }
  return n;
}
/** Draw the line (sprite-model's Bresenham, both ends included, clipped to the tile) with `v`. Returns the pixel count changed. */
export function drawLine(tile, x0, y0, x1, y1, v = 1) {
  let n = 0;
  for (const [x, y] of line(x0, y0, x1, y1)) if (setPixel(tile, x, y, v)) n++;
  return n;
}
export function clearTile(tile) { tile.bits.fill(0); }
export function invertTile(tile) { tile.bits = tile.bits.map((b) => (~b) & 0xFF); }
const reverse8 = (v) => { let o = 0; for (let x = 0; x < 8; x++) if (bitAt(v, x)) o |= 0x80 >>> (7 - x); return o; };
/** Mirror left-right. */
export function flipH(tile) { tile.bits = tile.bits.map(reverse8); }
/** Mirror top-bottom (a fine tile's row colours mirror with the pixels; rotate and shift leave the colours in their rows). */
export function flipV(tile) { tile.bits.reverse(); if (tile.rowColours) { tile.rowColours.reverse(); syncRow0(tile); } }
/** Rotate by 90 degrees (clockwise when cw, default). */
export function rotate90(tile, cw = true) {
  const old = tile.bits.slice();
  for (let y = 0; y < 8; y++) {
    let b = 0;
    for (let x = 0; x < 8; x++) {
      const [sx, sy] = cw ? [y, 7 - x] : [7 - y, x];             // the source pixel that lands on (x, y)
      if (bitAt(old[sy], sx)) b |= 0x80 >>> x;
    }
    tile.bits[y] = b;
  }
}
/** Move the picture by dx, dy pixels (right / down positive); wrap (default true, as the contract's tool) or leave paper behind. */
export function shift(tile, dx = 0, dy = 0, wrap = true) {
  const old = tile.bits.slice();
  for (let y = 0; y < 8; y++) {
    let sy = y - dy;
    if (wrap) sy = ((sy % 8) + 8) % 8; else if (sy < 0 || sy > 7) { tile.bits[y] = 0; continue; }
    let b = 0;
    for (let x = 0; x < 8; x++) {
      let sx = x - dx;
      if (wrap) sx = ((sx % 8) + 8) % 8; else if (sx < 0 || sx > 7) continue;
      if (bitAt(old[sy], sx)) b |= 0x80 >>> x;
    }
    tile.bits[y] = b;
  }
}

// ── colours, flags ────────────────────────────────────────────────────────────────────────────────────────────
const validColours = (c) => isInt(c.ink, 0, 7) && isInt(c.paper, 0, 7) && (c.bright === 0 || c.bright === 1);
/** The colours of the 8 pixel rows as [{ink, paper, bright} x 8] (a fresh array; a tile without rowColours repeats its own colours). */
export function rowColoursOf(tile) {
  return tile.rowColours ? tile.rowColours.map((c) => ({ ink: c.ink, paper: c.paper, bright: c.bright }))
    : Array.from({ length: 8 }, () => ({ ink: tile.ink, paper: tile.paper, bright: tile.bright }));
}
/** True when some pixel row has colours other than row 0's (a fine-colour tile). */
export function hasRowColours(tile) { return !!tile.rowColours && tile.rowColours.some((c) => !sameColour(c, tile.rowColours[0])); }
/** Keep ink / paper / bright equal to row 0's and drop rowColours when every row is alike (the one-colour form). */
function syncRow0(tile) {
  const rc = tile.rowColours;
  if (!rc) return;
  tile.ink = rc[0].ink; tile.paper = rc[0].paper; tile.bright = rc[0].bright;
  if (rc.every((c) => sameColour(c, rc[0]))) delete tile.rowColours;
}
/**
 * Set (a part of) the tile's colours: patch = {ink?, paper?, bright?}. `rows` (optional) is a list of pixel rows 0..7; without it the patch applies to
 * the whole tile (every row, so a tile that had colours of its own in each row becomes one-colour). With it only those rows change; the tile keeps
 * rowColours while the rows differ, and the tile's ink / paper / bright stay row 0's. Returns true when valid (and applied).
 */
export function setColours(tile, patch, rows) {
  const next = { ink: tile.ink, paper: tile.paper, bright: tile.bright, ...patch };
  if (rows === undefined || rows === null) {
    if (!validColours(next)) return false;
    tile.ink = next.ink; tile.paper = next.paper; tile.bright = next.bright;
    delete tile.rowColours;
    return true;
  }
  if (!Array.isArray(rows) || !rows.length || !rows.every((y) => isInt(y, 0, 7))) return false;
  const rc = rowColoursOf(tile);
  for (const y of new Set(rows)) {
    const c = { ...rc[y], ...patch };
    if (!validColours(c)) return false;
    rc[y] = c;
  }
  tile.rowColours = rc;
  syncRow0(tile);
  return true;
}
/** Give every pixel row the colours of row `from` (default 0): the one-colour form. Returns true when valid. */
export function unifyRows(tile, from = 0) {
  if (!isInt(from, 0, 7)) return false;
  const c = rowColoursOf(tile)[from];
  tile.ink = c.ink; tile.paper = c.paper; tile.bright = c.bright;
  delete tile.rowColours;
  return true;
}
/** Turn flag bit 0..7 on or off. Returns true when valid. */
export function setFlag(tile, bit, on) {
  if (!isInt(bit, 0, 7)) return false;
  tile.flags = on ? (tile.flags | (1 << bit)) : (tile.flags & ~(1 << bit) & 0xFF);
  tile.hadFlags = true;
  return true;
}
/** The "sprites never pass over this tile" mark. */
export function setFg(tile, on) { tile.fg = !!on; if (on) tile.hadFg = true; }
/** The attribute byte the compiler makes: bright << 6 | paper << 3 | ink. */
export function attrByte(tile) { return (tile.bright << 6) | (tile.paper << 3) | tile.ink; }
/** The attribute bytes of the 8 pixel rows (what a fine scene draws; the first is attrByte). */
export function rowAttrs(tile) { return rowColoursOf(tile).map((c) => (c.bright << 6) | (c.paper << 3) | c.ink); }

/** True when some scene of the project (project.scenes, {name: {display}}) is set to fine colour (any case), so its tiles are drawn row by row. */
export function projectHasFine(project) {
  const sc = isObj(project) ? project.scenes : null;
  return isObj(sc) && Object.values(sc).some((e) => isObj(e) && typeof e.display === 'string' && e.display.trim().toLowerCase() === 'fine');
}

// ── what a tile looks like ────────────────────────────────────────────────────────────────────────────────────
/**
 * 64 colour keys (row-major; the keys of sprite-model: 0 black, 1..7 normal, 9..15 bright), for rendering with keyRGB(key, palette).
 * `fine: true` colours every pixel row with its own ink / paper / BRIGHT (8 x 1 colour, what a fine scene draws: arcade-fine.js finePicture);
 * otherwise the tile has row 0's colours throughout (what every other scene draws).
 */
export function tilePixels(tile, { fine = false } = {}) {
  const out = new Int8Array(64), rc = fine ? rowColoursOf(tile) : null;
  for (let y = 0; y < 8; y++) {
    const c = rc ? rc[y] : tile, ik = colourKey(c.ink, c.bright), pk = colourKey(c.paper, c.bright);
    for (let x = 0; x < 8; x++) out[y * 8 + x] = bitAt(tile.bits[y], x) ? ik : pk;
  }
  return out;
}
/** True when no pixel is set (the bitmap is all paper). */
export function tileIsBlank(tile) { return tile.bits.every((b) => b === 0); }
/** True when black shows in any pixel row: paper 0 and a clear bit, or ink 0 and a set bit (the black-bright-mix rule, per row for a fine-colour tile). */
export function tileUsesBlack(tile) {
  const rc = rowColoursOf(tile);
  return tile.bits.some((b, y) => (rc[y].paper === 0 && b !== 0xFF) || (rc[y].ink === 0 && b !== 0));
}
const popcount = (b) => { let n = 0; for (let v = b & 0xFF; v; v &= v - 1) n++; return n; };
/** {pixels (set), blank, attr, flagNames, fg, text}: a one-line description for the tile strip's tooltip. */
export function tileSummary(tile, index) {
  const pixels = tile.bits.reduce((n, b) => n + popcount(b), 0);
  const flagNames = FLAG_NAMES.filter((_, i) => tile.flags & (1 << i));
  const colour = (c) => PALETTE[c].name;
  const parts = [`${index === undefined ? 'tile' : 'tile ' + index}: ink ${colour(tile.ink)}, paper ${colour(tile.paper)}${tile.bright ? ', bright' : ''}`,
    pixels === 0 ? 'blank' : `${pixels} pixel${pixels === 1 ? '' : 's'}`];
  if (hasRowColours(tile)) parts.push('8 x 1 colour (each pixel row has its own colours; row 0\'s are shown above)');
  if (flagNames.length) parts.push(flagNames.join(' + '));
  if (tile.fg) parts.push('foreground (sprites never pass over)');
  return { pixels, blank: pixels === 0, attr: attrByte(tile), flagNames, fg: !!tile.fg, text: parts.join('; ') };
}

// ── validation ────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Check an editing-form set against the compiler's limits (1..128 tiles, 8 bytes of bitmap each, colours 0..7 / 0..1 (each row's, for a tile with rowColours), flags 0..255).
 * Returns null when fine, else a message. Whatever it accepts, validateAsset('tilesets', toAsset(set)) in src/arcade-project.js
 * accepts (that one allows up to 256 tiles, the compiler 128, so this one is the stricter).
 */
export function validateTileset(set) {
  if (!isObj(set) || !Array.isArray(set.tiles)) return 'a tile set needs a list of tiles';
  if (set.tiles.length < 1) return 'the tile set has no tiles';
  if (set.tiles.length > MAX_TILES) return `the tile set has ${set.tiles.length} tiles; at most ${MAX_TILES} are supported`;
  for (let i = 0; i < set.tiles.length; i++) {
    const t = set.tiles[i];
    if (!isObj(t)) return `tile ${i} is not an object`;
    if (!Array.isArray(t.bits) || t.bits.length !== 8) return `tile ${i} needs exactly 8 rows`;
    if (!t.bits.every((b) => isInt(b, 0, 255))) return `tile ${i}: each row's bits must be a whole number 0..255`;
    if (!isInt(t.ink, 0, 7)) return `tile ${i}: ink must be 0..7`;
    if (!isInt(t.paper, 0, 7)) return `tile ${i}: paper must be 0..7`;
    if (!(t.bright === 0 || t.bright === 1)) return `tile ${i}: bright must be 0 or 1`;
    if (!isInt(t.flags, 0, 255)) return `tile ${i}: flags must be a whole number 0..255`;
    if (typeof t.fg !== 'boolean') return `tile ${i}: fg must be true or false`;
    if (t.rowColours !== undefined) {
      const rc = t.rowColours;
      if (!Array.isArray(rc) || rc.length !== 8 || !rc.every((c) => isObj(c) && validColours(c))) return `tile ${i}: rowColours needs 8 rows of ink 0..7, paper 0..7 and bright 0 or 1`;
      if (!sameColour(rc[0], t)) return `tile ${i}: rowColours[0] must equal the tile's own colours`;
    }
  }
  return null;
}
/**
 * The same check for a STORED asset: the colours of EVERY row (as arcade-project's validateAsset does), then fromAsset, then validateTileset. null = fine, else a message.
 */
export function validateAsset(asset) {
  const list = isObj(asset) ? (asset.tiles ?? asset.frames) : null;
  if (Array.isArray(list)) {
    for (let i = 0; i < list.length; i++) {
      const rows = list[i]?.rows;
      if (!Array.isArray(rows)) continue;
      for (let y = 0; y < rows.length; y++) {
        const r = rows[y];
        if (!isObj(r)) continue;
        for (const k of ['ink', 'paper']) if (r[k] !== undefined && !isInt(r[k], 0, 7)) return `tile ${i} row ${y} ${k} must be a whole number 0..7, got ${JSON.stringify(r[k])}`;
        if (r.bright !== undefined && !(r.bright === 0 || r.bright === 1 || typeof r.bright === 'boolean')) return `tile ${i} row ${y} bright must be 0 or 1, got ${JSON.stringify(r.bright)}`;
      }
    }
  }
  let set;
  try { set = fromAsset(asset); } catch (e) { return e.message; }
  return validateTileset(set);
}
