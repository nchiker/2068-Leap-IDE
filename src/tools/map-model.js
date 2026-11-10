/**
 * src/tools/map-model.js — the data model of the Leap Arcade Studio map editor (pure: no DOM, Node can import it).
 * Contract: docs/ARCADE_STUDIO_S2_CONTRACT.md sections 2 and 5.
 *
 * A map is edited as a plain object ("map"):
 *
 *   { w, h, cells: number[w * h] (row-major), repr: 'array' | 'hex', tileset: string | null, extra: {unknown keys of the asset} }
 *
 *   cell   a tile index 0..254, or -1 = blank. (The stored forms of blank, 255, -1 and null, all read as -1.)
 *
 * What the stored form keeps (the round trip toAsset(fromAsset(a))):
 *   - w, h, `tileset` and every unknown key (`extra`) are kept as they were.
 *   - `cells` keeps its representation: an array stays an array, a hex string stays a hex string.
 *   - BLANK IS NORMALISED: a blank cell written as null or -1 comes back as 255, and a hex string comes back compact (no whitespace)
 *     in upper case. Those are the only differences; every example asset of the repository has neither, so for them the round trip is
 *     exact (deep equal). The compiler treats null, -1 and 255 alike (and 'ff' / 'FF'), so the compiled cartridge is byte-identical
 *     (tests/map-model.mjs compiles every example with the original and the round-tripped assets and compares the bytes).
 *
 *   fromAsset(asset) / toAsset(map)       the stored form <-> the editing form
 *   newMap(w, h, preset), cloneMap        'screen' | 'world' | 'floorplan'
 *   getCell, setCell, pencil, drawLine, rect, floodFill, copyBlock, pasteBlock, resize
 *   cellsUsing, usedTiles, tileCounts
 *   mapRoleLimits(role), validateMap(map, role, opts), mapProblems   the compiler's shape rules per role
 *   windowFrame(map, camX)                the WINDOW's 24-cell frame at a camera position
 *   line, createHistory                   re-exported from sprite-model.js
 */

"use strict";

import { line, createHistory } from './sprite-model.js';

export { line, createHistory };

export const BLANK = -1;                 // the editing form of a blank cell
export const STORED_BLANK = 255;         // what toAsset writes for it, in both representations
export const MAX_DIM = 256;              // what validateAsset (src/arcade-project.js) accepts for w and h
export const WINDOW_CELLS = 24;          // the WINDOW is 24 x 16 cells = 192 x 128 pixels
export const WINDOW_PIXELS = WINDOW_CELLS * 8;

// ── roles ─────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * What the compiler accepts, per role (convertMap in arcade-assets.js, convertWorldMap in arcade-window.js, convertViewMap in arcade-view.js).
 * `blank` says what a blank cell means to the compiler: 'space' (a font space is drawn), 'tile0' (the sky, tile 0), 'empty' (wall type 0).
 */
export const ROLE_LIMITS = Object.freeze({
  cell: Object.freeze({ role: 'cell', minW: 1, maxW: 32, minH: 1, maxH: 24, maxTile: 127, blank: 'space', ring: false }),
  world: Object.freeze({ role: 'world', minW: 24, maxW: 128, minH: 1, maxH: 16, maxTile: 31, blank: 'tile0', ring: false }),
  floorplan: Object.freeze({ role: 'floorplan', minW: 4, maxW: 32, minH: 4, maxH: 32, maxTile: 4, blank: 'empty', ring: true }),
});
/** The limits of a role: 'cell' (alias 'screen'), 'world' or 'floorplan'. */
export function mapRoleLimits(role) {
  const r = ROLE_LIMITS[role === 'screen' ? 'cell' : role];
  if (!r) throw new RangeError(`unknown map role ${JSON.stringify(role)} (cell, world or floorplan)`);
  return r;
}
/** The presets of the size menu: size and role. */
export const PRESETS = Object.freeze({
  screen: Object.freeze({ w: 32, h: 24, role: 'cell', label: 'Screen 32x24' }),
  world: Object.freeze({ w: 128, h: 16, role: 'world', label: 'World 128x16' }),
  floorplan: Object.freeze({ w: 32, h: 32, role: 'floorplan', label: 'Floor plan 32x32' }),
});

// ── creation, cloning, conversion ─────────────────────────────────────────────────────────────────────────────
const isDim = (v) => Number.isInteger(v) && v >= 1 && v <= MAX_DIM;
const inb = (m, x, y) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && x < m.w && y >= 0 && y < m.h;

/** A cell value as the model keeps it: 255 -> -1; throws RangeError for anything that is not -1 or a whole number 0..254. */
function cellValue(v) {
  if (v === STORED_BLANK) return BLANK;
  if (!Number.isInteger(v) || v < BLANK || v > 254) throw new RangeError(`a cell is blank (-1) or a tile index 0..254, got ${JSON.stringify(v)}`);
  return v;
}

/**
 * A new map of w x h as the preset says (its role's limits are enforced, so a new map is valid): 'screen' is all blank, 'world' is all tile 0
 * (the sky: in a world map blank means tile 0 anyway), 'floorplan' is an empty room with walls (type 1) on the outer ring.
 * The representation is 'hex' (a new map is a hex string). Default size: the preset's (32 x 24, 128 x 16, 32 x 32).
 */
export function newMap(w, h, preset = 'screen') {
  const p = PRESETS[preset];
  if (!p) throw new RangeError(`unknown preset ${JSON.stringify(preset)} (screen, world or floorplan)`);
  w = w ?? p.w; h = h ?? p.h;
  const lim = ROLE_LIMITS[p.role];
  if (!Number.isInteger(w) || w < lim.minW || w > lim.maxW) throw new RangeError(`a ${preset} map is ${lim.minW}..${lim.maxW} wide, got ${w}`);
  if (!Number.isInteger(h) || h < lim.minH || h > lim.maxH) throw new RangeError(`a ${preset} map is ${lim.minH}..${lim.maxH} high, got ${h}`);
  const cells = new Array(w * h).fill(preset === 'world' ? 0 : BLANK);
  if (preset === 'floorplan') {
    cells.fill(0);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) cells[y * w + x] = 1;
  }
  return { w, h, cells, repr: 'hex', tileset: null, extra: {} };
}

export function cloneMap(m) {
  return { w: m.w, h: m.h, cells: m.cells.slice(), repr: m.repr, tileset: m.tileset, extra: JSON.parse(JSON.stringify(m.extra ?? {})) };
}

/** The stored asset -> the editing form. Throws an Error with a plain message when the asset cannot be read. */
export function fromAsset(asset) {
  if (!asset || typeof asset !== 'object' || Array.isArray(asset)) throw new Error('the map is not an object');
  const { w, h, cells: raw, tileset, ...rest } = asset;
  if (!isDim(w)) throw new Error(`map w must be a whole number 1..${MAX_DIM}, got ${JSON.stringify(w)}`);
  if (!isDim(h)) throw new Error(`map h must be a whole number 1..${MAX_DIM}, got ${JSON.stringify(h)}`);
  let cells, repr;
  if (typeof raw === 'string') {
    const s = raw.replace(/\s+/g, '');
    if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error('map cells as a string must be hex, two digits per cell');
    cells = (s.match(/../g) ?? []).map((x) => cellValue(parseInt(x, 16)));
    repr = 'hex';
  } else if (Array.isArray(raw)) {
    cells = raw.map((v, i) => {
      if (v === null) return BLANK;
      if (!Number.isInteger(v) || v < BLANK) throw new Error(`map cell ${i} is ${JSON.stringify(v)}: a tile index, or blank (-1, null or 255)`);
      return v === STORED_BLANK ? BLANK : v;
    });
    repr = 'array';
  } else throw new Error('a map needs "cells" (an array, or a hex string)');
  if (cells.length !== w * h) throw new Error(`the map is ${w} x ${h} = ${w * h} cells but "cells" has ${cells.length}`);
  const extra = JSON.parse(JSON.stringify(rest));
  let ts = null;
  if (typeof tileset === 'string') ts = tileset;
  else if (tileset !== undefined) extra.tileset = JSON.parse(JSON.stringify(tileset));    // not a name: kept, untouched
  return { w, h, cells, repr, tileset: ts, extra };
}

/** The editing form -> the stored asset, in the representation read (blank written as 255; hex as compact upper case). */
export function toAsset(m) {
  let cells;
  if (m.repr === 'hex') {
    cells = m.cells.map((v, i) => {
      const n = v === BLANK ? STORED_BLANK : v;
      if (!Number.isInteger(n) || n < 0 || n > 255) throw new RangeError(`cell ${i} is ${JSON.stringify(v)}, which a hex map cannot hold (0..254 or blank)`);
      return n.toString(16).toUpperCase().padStart(2, '0');
    }).join('');
  } else cells = m.cells.map((v) => (v === BLANK ? STORED_BLANK : v));
  const out = { w: m.w, h: m.h, cells };
  if (typeof m.tileset === 'string') out.tileset = m.tileset;
  for (const [k, v] of Object.entries(m.extra ?? {})) out[k] = JSON.parse(JSON.stringify(v));
  return out;
}

// ── cells ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** The cell at (x, y): a tile index or -1 (blank); out of the map it is undefined. */
export function getCell(m, x, y) { return inb(m, x, y) ? m.cells[y * m.w + x] : undefined; }
/** Set one cell (a tile index 0..254, or -1 / 255 for blank); returns true when it changed, false when outside the map or unchanged. */
export function setCell(m, x, y, v) {
  v = cellValue(v);
  if (!inb(m, x, y)) return false;
  const i = y * m.w + x;
  if (m.cells[i] === v) return false;
  m.cells[i] = v;
  return true;
}
/** The pencil: the same as setCell (a stroke is a series of these; the editor commits one history step per drag). */
export const pencil = setCell;

/** The cells of the line (x0, y0)-(x1, y1) (Bresenham, sprite-model's `line`), both ends included, set to v and clipped to the map. Returns how many changed. */
export function drawLine(m, x0, y0, x1, y1, v) {
  v = cellValue(v);
  let n = 0;
  for (const [x, y] of line(x0, y0, x1, y1)) if (setCell(m, x, y, v)) n++;
  return n;
}

/** A rectangle with opposite corners (x0, y0) and (x1, y1) in any order, outline or `filled`, clipped to the map. Returns how many cells changed. */
export function rect(m, x0, y0, x1, y1, v, { filled = false } = {}) {
  v = cellValue(v);
  const ax = Math.min(x0, x1), bx = Math.max(x0, x1), ay = Math.min(y0, y1), by = Math.max(y0, y1);
  let n = 0;
  for (let y = Math.max(0, ay); y <= Math.min(m.h - 1, by); y++) {
    for (let x = Math.max(0, ax); x <= Math.min(m.w - 1, bx); x++) {
      if (filled || y === ay || y === by || x === ax || x === bx) if (setCell(m, x, y, v)) n++;
    }
  }
  return n;
}

/** Flood fill (4-connected) of the cells equal to the one at (x, y) (blank is a value of its own) with v. Returns the number of cells filled (0 when v is already there or (x, y) is outside). */
export function floodFill(m, x, y, v) {
  v = cellValue(v);
  if (!inb(m, x, y)) return 0;
  const target = m.cells[y * m.w + x];
  if (target === v) return 0;
  const seen = new Uint8Array(m.w * m.h), stack = [[x, y]], region = [];
  while (stack.length) {
    const [px, py] = stack.pop();
    if (!inb(m, px, py) || seen[py * m.w + px] || m.cells[py * m.w + px] !== target) continue;
    seen[py * m.w + px] = 1;
    region.push(py * m.w + px);
    stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
  }
  for (const i of region) m.cells[i] = v;
  return region.length;
}

// ── blocks ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Copy the rectangle (x, y, w, h), clipped to the map: {w, h, cells} (the clipped size; 0 x 0 when nothing is inside). */
export function copyBlock(m, x, y, w, h) {
  const x0 = Math.max(0, x), y0 = Math.max(0, y), x1 = Math.min(m.w, x + w), y1 = Math.min(m.h, y + h);
  if (!(x1 > x0 && y1 > y0)) return { w: 0, h: 0, cells: [] };
  const cells = [];
  for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) cells.push(m.cells[yy * m.w + xx]);
  return { w: x1 - x0, h: y1 - y0, cells };
}
/** Paste a block with its top-left corner at (x, y), clipped to the map (x and y may be negative). `skipBlank`: blank cells of the block leave the map alone. Returns how many cells changed. */
export function pasteBlock(m, block, x, y, { skipBlank = false } = {}) {
  let n = 0;
  for (let by = 0; by < block.h; by++) for (let bx = 0; bx < block.w; bx++) {
    const v = block.cells[by * block.w + bx];
    if (skipBlank && v === BLANK) continue;
    if (setCell(m, x + bx, y + by, v)) n++;
  }
  return n;
}

/** Change the size to w x h (whole numbers 1..256), anchored at the top-left: cells outside the new box are dropped, new ones are blank. Returns the map. */
export function resize(m, w, h) {
  if (!isDim(w)) throw new RangeError(`width must be a whole number 1..${MAX_DIM}, got ${JSON.stringify(w)}`);
  if (!isDim(h)) throw new RangeError(`height must be a whole number 1..${MAX_DIM}, got ${JSON.stringify(h)}`);
  const cells = new Array(w * h).fill(BLANK);
  for (let y = 0; y < Math.min(h, m.h); y++) for (let x = 0; x < Math.min(w, m.w); x++) cells[y * w + x] = m.cells[y * m.w + x];
  m.w = w; m.h = h; m.cells = cells;
  return m;
}

// ── tile statistics ───────────────────────────────────────────────────────────────────────────────────────────
/** The [x, y] of every cell holding `tile` (row-major); tile -1 (or 255) finds the blanks. */
export function cellsUsing(m, tile) {
  const t = tile === STORED_BLANK ? BLANK : tile, out = [];
  m.cells.forEach((v, i) => { if (v === t) out.push([i % m.w, (i / m.w) | 0]); });
  return out;
}
/** Tile -> number of cells (a Map in ascending tile order; blank is key -1 and comes first, or is counted as tile `blankAs` when given). */
export function tileCounts(m, { blankAs = null } = {}) {
  const raw = new Map();
  for (const v of m.cells) { const t = v === BLANK && blankAs !== null ? blankAs : v; raw.set(t, (raw.get(t) ?? 0) + 1); }
  return new Map([...raw.entries()].sort((a, b) => a[0] - b[0]));
}
/** The tile indices the map uses, ascending; blank is not a tile unless `blankAs` says it counts as one (a world map: 0). */
export function usedTiles(m, opts = {}) { return [...tileCounts(m, opts).keys()].filter((t) => t !== BLANK); }

// ── validation: the compiler's shape rules ────────────────────────────────────────────────────────────────────
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const spot = ([x, y]) => `row ${y}, column ${x}`;

/**
 * The problems of a map for a role, structured: [{kind, message, cells?: [[x, y], ...]}], empty when the compiler accepts the shape.
 * kind: 'width' | 'height' | 'cell-count' | 'tile' | 'undefined-tile' | 'ring'. One entry per rule (cells lists every offending cell).
 * opts.tileCount: how many tiles the tile set defines (a tile at or above it is an 'undefined-tile'); default: not checked.
 * A blank cell is a font space in a cell map, tile 0 in a world map and an empty cell (wall type 0) in a floor plan.
 */
export function mapProblems(m, role, { tileCount = null } = {}) {
  const lim = mapRoleLimits(role), out = [], what = { cell: 'map', world: 'the world map', floorplan: 'the view map' }[lim.role];
  const wideOk = Number.isInteger(m.w) && m.w >= lim.minW && m.w <= lim.maxW, highOk = Number.isInteger(m.h) && m.h >= lim.minH && m.h <= lim.maxH;
  if (!wideOk) out.push({ kind: 'width', message: `${what} width must be a whole number ${lim.minW}..${lim.maxW}, got ${JSON.stringify(m.w)}` });
  if (!highOk) out.push({ kind: 'height', message: `${what} height must be a whole number ${lim.minH}..${lim.maxH}, got ${JSON.stringify(m.h)}` });
  if (!Array.isArray(m.cells) || m.cells.length !== m.w * m.h) {
    out.push({ kind: 'cell-count', message: `the map is ${m.w} x ${m.h} = ${m.w * m.h} cells but "cells" has ${m.cells?.length}` });
    return out;
  }
  const at = (i) => [i % m.w, (i / m.w) | 0];
  const high = [], undef = [], ring = [];
  m.cells.forEach((v, i) => {
    if (v === BLANK) {
      if (lim.ring) { const [x, y] = at(i); if (x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1) ring.push([x, y]); }
      return;
    }
    if (!Number.isInteger(v) || v < 0 || v > lim.maxTile) { high.push(at(i)); return; }
    if (tileCount !== null && lim.role !== 'floorplan' && v >= tileCount) { undef.push(at(i)); return; }
    if (lim.ring && v === 0) { const [x, y] = at(i); if (x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1) ring.push([x, y]); }
  });
  if (high.length) {
    const hint = { cell: 'a tile index 0..127', world: 'a window map uses the tile indexes 0..31', floorplan: 'a VIEW3D map uses the wall types 0 (empty) to 4' }[lim.role];
    out.push({ kind: 'tile', cells: high, message: `${plural(high.length, 'cell')} outside 0..${lim.maxTile}: the first, at ${spot(high[0])}, is ${m.cells[high[0][1] * m.w + high[0][0]]} (${hint}, or blank)` });
  }
  if (undef.length) out.push({ kind: 'undefined-tile', cells: undef, message: `${plural(undef.length, 'cell')} use a tile the tile set does not define (it has ${tileCount} tiles): the first, at ${spot(undef[0])}, is tile ${m.cells[undef[0][1] * m.w + undef[0][0]]}` });
  if (ring.length) out.push({ kind: 'ring', cells: ring, message: `${plural(ring.length, 'cell')} on the outer ring ${ring.length === 1 ? 'is' : 'are'} empty (the first at ${spot(ring[0])}): the outer ring of a VIEW3D map must be walls (1..4), or a ray could leave the map` });
  return out;
}
/** The messages of mapProblems: a list of strings, empty when the compiler would accept the map's shape for that role. */
export function validateMap(m, role, opts) { return mapProblems(m, role, opts).map((p) => p.message); }

// ── the WINDOW's frame ────────────────────────────────────────────────────────────────────────────────────────
/**
 * The cells of a world map the WINDOW shows with the camera at camX pixels (arcade-window.js: the window is 24 cells = 192 pixels wide, the
 * camera is clamped to 0..camMax = w * 8 - 192 for the usual ratio-1 band; opts.codes lists the bands' ratio codes, a 4 halves the maximum).
 * x0 is the first and x1 the last cell the window touches (inclusive, clipped to the map): 24 cells when camX is a multiple of 8, else 25
 * (the first and last are partly shown). Returns {x0, x1, camX (clamped), phase (camX mod 8)}.
 */
export function windowFrame(m, camX, { codes = [3] } = {}) {
  const maxRatio = codes.includes(4) ? 2 : 1;
  const max = Math.max(0, Math.floor((m.w * 8 - WINDOW_PIXELS) / maxRatio));
  const cam = Math.max(0, Math.min(max, Math.trunc(Number.isFinite(camX) ? camX : 0)));
  return { x0: cam >> 3, x1: Math.min(m.w - 1, (cam + WINDOW_PIXELS - 1) >> 3), camX: cam, phase: cam & 7 };
}
