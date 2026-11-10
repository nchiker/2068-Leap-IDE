/**
 * src/lang/arcade/arcade-view.js — Leap Arcade language batch 3: the 3D view (the raycaster slice; pure, no DOM, no node: imports).
 *
 * The data the compiler, the linker and the reference interpreter share for VIEW3D (docs/ARCADE_RAYCASTER_CONTRACT.md sections 2 and 6, docs/ARCADE_LANGUAGE_BATCH3.md):
 *   - the sine table and COSA / SINA / FXMUL exactly as contract section 2 says
 *   - the view map: asset -> wall types 0..4, 4..32 cells a side, the outer ring non-empty; its model in the runtime's 32 x 32 array (WALL / SETWALL)
 *   - the view descriptor (10 bytes) and its attribute bytes
 * Angles are 0..255 (256 to a turn), positions 8.8 fixed point (1/256 cell), direction = (cos a, sin a), angle 0 east, 64 south (down the map rows).
 */

"use strict";

import { LIMITS } from './arcade-words.js';

export const VIEW_W = 128;                  // the window: 16 x 12 cells at screen cell (8, 6)
export const VIEW_H = 96;
export const VIEW_STRIDE = 32;              // the runtime's map array: 32 x 32 bytes at WORLD_RAM, row stride 32
export const VIEW_RAM_BYTES = 1024;
export const VIEW_DESC_BYTES = 10;
export const VIEW_PATTERN_BYTES = 16;
export const VIEW_DEFAULTS = Object.freeze({ colw: 4, ink: 7, ceil: 0, floor: 1, bright: 1 });
/** Billboard half-size of the collision test in 1/256 cells: R = h * 4 (contract section 3: half the world side, h / 32 cells). */
export const billboardRadius = (h) => h * 4;

const w16 = (v) => ((v + 32768) & 0xFFFF) - 32768;

// ── the sine table: Q[k] = round(4096 * sin(k * pi / 128)), k = 0..64, mirrored to the 256 entries of the COSINE table C[a] (4.12) ──────────────────
export const Q = Object.freeze(Array.from({ length: 65 }, (_, i) => Math.round(4096 * Math.sin(i * Math.PI / 128))));
/** C[a] = 4096 * cos(a / 256 turns): C[0..64] = Q[64 - a], C[65..128] = -C[128 - a], C[129..255] = C[256 - a] (the spike's buildCos). */
export function buildCosTable() {
  const C = new Int16Array(256);
  for (let a = 0; a <= 64; a++) C[a] = Q[64 - a];
  for (let a = 65; a <= 128; a++) C[a] = -C[128 - a];
  for (let a = 129; a < 256; a++) C[a] = C[256 - a];
  return C;
}
export const COS_TABLE = buildCosTable();
/** COSA(a): the angle is taken AND 255; (C[a] + 8) >> 4 with an arithmetic shift: -256..256 in 8.8. */
export const cosa = (a) => (COS_TABLE[a & 255] + 8) >> 4;
/** SINA(a) = C[(a + 192) AND 255] converted the same way. */
export const sina = (a) => (COS_TABLE[(a + 192) & 255] + 8) >> 4;
/** FXMUL(a, b) = floor(a * b / 256) of the exact 32-bit product, wrapped to 16 bits (a, b signed 16-bit). */
export const fxmul = (a, b) => w16((a * b) >> 8);

// ── the attribute bytes ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** flash 0 | bright << 6 | paper << 3 | ink. */
export const viewAttr = (bright, paper, ink) => ((bright & 1) << 6) | ((paper & 7) << 3) | (ink & 7);

// ── the view map ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const intIn = (v, lo, hi, what) => {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} must be a whole number ${lo}..${hi}, got ${JSON.stringify(v)}`);
  return v;
};
/**
 * Convert a map asset {w, h, cells} for use as the floor plan of a VIEW3D: w and h 4..32, each cell a wall type 0..4 (blank, -1 or null, is 0: empty), the outer ring
 * (row 0, row h-1, column 0, column w-1) non-empty. Returns {w, h, cells: Uint8Array(w * h) row-major (the stream the descriptor's map_src encodes), ram: Uint8Array(1024)
 * (the runtime's array: row stride 32, cells outside w x h are wall type 1)}. Errors name the row and column.
 */
export function convertViewMap(asset) {
  const w = intIn(asset?.w, LIMITS.minViewMap, LIMITS.maxViewMap, 'the view map width (cells)');
  const h = intIn(asset?.h, LIMITS.minViewMap, LIMITS.maxViewMap, 'the view map height (cells)');
  let cells = asset?.cells;
  if (typeof cells === 'string') {
    const s = cells.replace(/\s+/g, '');
    if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error('map cells as a string must be hex, two digits per cell');
    cells = s.match(/../g)?.map((x) => parseInt(x, 16)) ?? [];
  }
  if (!Array.isArray(cells)) throw new Error('the map has no "cells"');
  if (cells.length !== w * h) throw new Error(`the map is ${w} x ${h} = ${w * h} cells but "cells" has ${cells.length}`);
  const out = new Uint8Array(w * h), ram = new Uint8Array(VIEW_RAM_BYTES).fill(1);
  cells.forEach((v, i) => {
    const row = (i / w) | 0, col = i % w;
    let t = 0;
    if (!(v === null || v === -1 || v === 255)) {
      if (!Number.isInteger(v) || v < 0 || v > LIMITS.maxWallType) throw new Error(`map cell at row ${row}, column ${col} is ${JSON.stringify(v)}: a VIEW3D map uses the wall types 0 (empty) to ${LIMITS.maxWallType} (blank, -1 or null, is 0)`);
      t = v;
    }
    if (t === 0 && (row === 0 || row === h - 1 || col === 0 || col === w - 1)) throw new Error(`map cell at row ${row}, column ${col} is empty but it is on the outer ring: the outer ring of a VIEW3D map must be walls (1..${LIMITS.maxWallType}), or a ray could leave the map`);
    out[i] = t;
    ram[row * VIEW_STRIDE + col] = t;
  });
  return { w, h, cells: out, ram };
}

// ── the model of the runtime's map array (WALL, SETWALL, VIEW) ─────────────────────────────────────────────────────────────────
/** WALL(x, y): the wall type of the cell that holds the 8.8 position; 1 for a negative position or one beyond the 32 x 32 array. x, y are signed 16-bit. */
export function wallAt(ram, x, y) {
  if (x < 0 || y < 0 || x >= VIEW_STRIDE * 256 || y >= VIEW_STRIDE * 256) return 1;
  return ram[(y >> 8) * VIEW_STRIDE + (x >> 8)];
}
/** SETWALL x, y = t: only a cell inside the game's mapW x mapH and only the types 0..4 (a 0 on the array's outer ring is ignored too); anything else is ignored. Returns true when it wrote. */
export function setWallAt(ram, mapW, mapH, x, y, t) {
  if (x < 0 || y < 0 || t < 0 || t > LIMITS.maxWallType) return false;
  const cx = x >> 8, cy = y >> 8;
  if (cx >= mapW || cy >= mapH) return false;
  // contract section 2, clarification 7: the outer ring of the 32 x 32 array is never empty (a 32-wide or 32-high map has its own ring there)
  if (t === 0 && (cx === 0 || cy === 0 || cx === VIEW_STRIDE - 1 || cy === VIEW_STRIDE - 1)) return false;
  ram[cy * VIEW_STRIDE + cx] = t;
  return true;
}
/** VIEW x, y, a: x and y (signed 16-bit) clamped into 0..map * 256 - 1, a taken AND 255. */
export function clampPose(mapW, mapH, x, y, a) {
  const c = (v, n) => (v < 0 ? 0 : v > n * 256 - 1 ? n * 256 - 1 : v);
  return { x: c(x, mapW), y: c(y, mapH), a: a & 255 };
}

// ── the descriptor ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * view_desc, 10 bytes: +0 DB colw, +1 DB map_w, +2 DB map_h, +3 DB attr_top, +4 DB attr_bottom, +5 DW map_src, +7 DW patterns (0 = the runtime's), +9 DB flags (0).
 * @param {{colw: number, mapW: number, mapH: number, attrTop: number, attrBottom: number, mapSrc: number, patterns: number}} d
 */
export function buildViewDesc(d) {
  return Uint8Array.from([d.colw, d.mapW, d.mapH, d.attrTop, d.attrBottom, d.mapSrc & 0xFF, d.mapSrc >> 8, d.patterns & 0xFF, d.patterns >> 8, 0]);
}
