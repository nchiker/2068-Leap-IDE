/**
 * src/lang/arcade/arcade-window.js — Leap Arcade language batch 2: the pure data side of the scrolling window and of sprite frames
 * (no DOM, no node: imports; the code generator, the linker, the reference interpreter and the tests all use it).
 * Contract: docs/ARCADE_PLATFORMER_CONTRACT.md sections 3, 3b, 4, 7; decisions: docs/ARCADE_LANGUAGE_BATCH2.md.
 *
 *   ratioCode(num, den)          -> 0..4 | -1   BAND ratio -> the header's ratio_code (0 fixed, 1 = 1/4, 2 = 1/2, 3 = 1, 4 = 2)
 *   camMax(worldW, codes)        -> pixels      floor((world_w * 8 - 192) / maxratio), maxratio 2 when a band is ratio 4, else 1
 *   buildTileRows(tileset)       -> Uint8Array(256)    tile * 8 + r = the tile's row r (tiles 0..31; a tile the set lacks is blank)
 *   buildScrollTables(tileRows)  -> Uint8Array(3584)   14 pages of 256: page 2(p-1) = LTAB[p], page 2(p-1)+1 = RTAB[p], p = 1..7
 *   buildTileFlags(flags)        -> Uint8Array(32)
 *   buildWindowDesc(w)           -> Uint8Array          the window_desc record of section 3b (bands included)
 *   rleEncode(src) / rleDecode(bytes)  world_src as byte-RLE pairs (count 1..255, value), 0 ends; the expansion is exactly 2,048 bytes
 *   scanSpriteUse(ast, resolve)  -> Map(asset -> {frames, flip})   which assets a SHOW gives FRAME (other than the literal 0) or FLIP
 *   noviewPoolPieces(sym, cst)   -> pieces              the pool pieces of a NOVIEW scene (batch 7)
 *   planPhasePool(...)           -> plan                the runtime's phase-pool plan (FTABs, frame slots, first fit); buildFrameT(...) the cost of one cache miss
 *   collision model              -> worldTile / tileFlags / tileHit on a 2,048-byte WORLD_RAM (the reference interpreter's)
 */

"use strict";

export const WIN_COLS = 24;
export const WIN_ROWS = 16;
export const WORLD_ROWS = 16;
export const WORLD_STRIDE = 128;
export const WORLD_RAM_BYTES = 2048;
export const TILE_COUNT = 32;               // the window uses tiles 0..31 (a cell is tile * 8 in one byte)
export const TABLES_BYTES = 14 * 256;       // LTAB / RTAB for p = 1..7
export const TILEROWS_BYTES = 256;
export const TILEFLAGS_BYTES = 32;
export const WINDOW_DESC_FIXED = 14;        // +14: nbands x (rows, ratio_code)

/** BAND num/den -> ratio_code. The five ratios the contract allows; anything else is -1. */
export const RATIO_CODES = Object.freeze([[0, 1, 0], [1, 4, 1], [1, 2, 2], [1, 1, 3], [2, 1, 4]]);
export function ratioCode(num, den) {
  const r = RATIO_CODES.find(([n, d]) => n === num && d === den);
  return r ? r[2] : -1;
}
/** ratio_code -> [num, den] */
export const RATIO_OF = Object.freeze([[0, 1], [1, 4], [1, 2], [1, 1], [2, 1]]);
export const RATIO_TEXT = '0/1 (fixed), 1/4, 1/2, 1/1 or 2/1';

/** cam_max in pixels: floor((world_w * 8 - 192) / maxratio); maxratio is 2 when any band has ratio_code 4, else 1. */
export function camMax(worldW, codes) {
  const maxRatio = codes.includes(4) ? 2 : 1;
  return Math.floor((worldW * 8 - WIN_COLS * 8) / maxRatio);
}

/** The 256 bytes `tile * 8 + r` of the first 32 tiles of a converted tileset ({count, bytes: 9 per tile: 8 rows + attribute}). */
export function buildTileRows(tileset) {
  const out = new Uint8Array(TILEROWS_BYTES);
  const n = Math.min(tileset?.count ?? 0, TILE_COUNT);
  for (let t = 0; t < n; t++) for (let r = 0; r < 8; r++) out[t * 8 + r] = tileset.bytes[t * 9 + r];
  return out;
}

/**
 * The scroll tables (contract 3b): for each phase p = 1..7 two pages, LTAB[p][i] = (row << p) & $FF and RTAB[p][i] = row >> (8 - p), i = tile * 8 + r,
 * row = TILEROWS[i]. Page 2(p-1) is LTAB[p], page 2(p-1)+1 is RTAB[p] (p = 1: pages 0 and 1; p = 7: pages 12 and 13).
 */
export function buildScrollTables(tileRows) {
  const out = new Uint8Array(TABLES_BYTES);
  for (let p = 1; p <= 7; p++) {
    for (let i = 0; i < 256; i++) {
      const row = tileRows[i];
      out[2 * (p - 1) * 256 + i] = (row << p) & 0xFF;
      out[(2 * (p - 1) + 1) * 256 + i] = row >> (8 - p);
    }
  }
  return out;
}

/** 32 flag bytes (tiles the tileset lacks: 0). `flags` is the converted tileset's per-tile flags array. */
export function buildTileFlags(flags) {
  const out = new Uint8Array(TILEFLAGS_BYTES);
  for (let t = 0; t < Math.min(flags?.length ?? 0, TILE_COUNT); t++) out[t] = flags[t] & 0xFF;
  return out;
}

/**
 * The window_desc record (section 3b): cx, cy, nbands, world_w, DW cam_max, DW tables, DW tile_flags, DW world_src, DW tilerows,
 * then nbands x (rows, ratio_code).
 * @param {{cx, cy, worldW, camMax, tables, tileFlags, worldSrc, tileRows, bands: {rows: number, code: number}[]}} w
 */
export function buildWindowDesc(w) {
  const b = [w.cx, w.cy, w.bands.length, w.worldW, w.camMax & 0xFF, (w.camMax >> 8) & 0xFF, w.tables & 0xFF, w.tables >> 8,
    w.tileFlags & 0xFF, w.tileFlags >> 8, w.worldSrc & 0xFF, w.worldSrc >> 8, w.tileRows & 0xFF, w.tileRows >> 8];
  for (const band of w.bands) b.push(band.rows, band.code);
  return Uint8Array.from(b);
}

// ── world_src: byte-RLE (contract 3b) ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Encode the 2,048 expanded bytes of WORLD_RAM as pairs `count (1..255), value` in row-major order, ended by a count of 0 (runs longer than 255 are split).
 * @param {Uint8Array} src
 */
export function rleEncode(src) {
  const out = [];
  for (let i = 0; i < src.length;) {
    let j = i;
    while (j < src.length && src[j] === src[i] && j - i < 255) j++;
    out.push(j - i, src[i]);
    i = j;
  }
  out.push(0);
  return Uint8Array.from(out);
}
/** What the runtime's decoder does: expand pairs until a count of 0, stop at 2,048 bytes, zero the rest. */
export function rleDecode(bytes) {
  const out = new Uint8Array(WORLD_RAM_BYTES);
  let o = 0;
  for (let i = 0; i + 1 < bytes.length && bytes[i] !== 0 && o < WORLD_RAM_BYTES; i += 2) for (let k = 0; k < bytes[i] && o < WORLD_RAM_BYTES; k++) out[o++] = bytes[i + 1];
  return out;
}

// ── the world map (a MAP used by WINDOW) ────────────────────────────────────────────────────────────────────────────────────────
function intIn(v, lo, hi, what) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} must be a whole number ${lo}..${hi}, got ${JSON.stringify(v)}`);
  return v;
}

/**
 * Convert a map asset {w, h, cells} for use as a window world: w 24..128, h 1..16, cells a tile index 0..31 (blank: -1, null or 255 = tile 0, the sky);
 * a tile the tileset does not define is an error. Returns {w, h, cells (normalised tile indexes, row-major), src: Uint8Array(2048)}: `src` has the row r
 * at r * 128, each cell tile * 8, everything else (columns beyond w, rows beyond h) 0 (WORLD_RAM as the scene starts).
 */
export function convertWorldMap(asset, tileCount) {
  const w = intIn(asset?.w, 24, 128, 'the world map width (cells)'), h = intIn(asset?.h, 1, 16, 'the world map height (cells)');
  let cells = asset?.cells;
  if (typeof cells === 'string') {
    const s = cells.replace(/\s+/g, '');
    if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error('map cells as a string must be hex, two digits per cell');
    cells = s.match(/../g)?.map((x) => parseInt(x, 16)) ?? [];
  }
  if (!Array.isArray(cells)) throw new Error('the map has no "cells"');
  if (cells.length !== w * h) throw new Error(`the map is ${w} x ${h} = ${w * h} cells but "cells" has ${cells.length}`);
  const out = new Array(w * h), src = new Uint8Array(WORLD_RAM_BYTES);
  cells.forEach((v, i) => {
    const row = (i / w) | 0, col = i % w;
    let t = 0;
    if (!(v === null || v === -1 || v === 255)) {
      if (!Number.isInteger(v) || v < 0 || v > 31) throw new Error(`map cell at row ${row}, column ${col} is ${JSON.stringify(v)}: a window map uses the tile indexes 0..31 (blank, -1 or null, is tile 0)`);
      if (v >= tileCount) throw new Error(`map cell at row ${row}, column ${col} is tile ${v}, which the tileset does not define (it has ${tileCount} tiles)`);
      t = v;
    }
    out[i] = t;
    src[row * WORLD_STRIDE + col] = t * 8;
  });
  return { w, h, cells: out, src };
}

// ── sprite frames ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isZeroLiteral = (e) => e?.type === 'Number' && e.value === 0;

/**
 * Which sprite assets does the program give a FRAME (anything but the literal 0) or FLIP? `resolve(decl)` maps a SPRITE declaration (an Asset node) to its
 * asset object (or undefined). Every SHOW in every PROC counts (reachable or not). Returns Map(asset object -> {frames: boolean, flip: boolean}).
 * The compiler compiles all frames of an asset only when `frames` is set, else just frame 0 (see docs/ARCADE_LANGUAGE_BATCH2.md).
 */
export function scanSpriteUse(ast, resolve) {
  const byName = new Map();
  for (const a of ast.assets ?? []) if (a.kind === 'SPRITE') { const as = resolve(a); if (as !== undefined) byName.set(String(a.name).toUpperCase(), as); }
  const use = new Map();
  const get = (as) => { let u = use.get(as); if (!u) use.set(as, (u = { frames: false, flip: false })); return u; };
  const walk = (list) => {
    for (const s of list ?? []) {
      if (!s) continue;
      if (s.type === 'Show') {
        const as = byName.get(String(s.sprite?.name).toUpperCase());
        if (as !== undefined) {
          const u = get(as);
          if (s.frame && !isZeroLiteral(s.frame)) u.frames = true;
          if (s.flip) u.flip = true;
        }
      } else if (s.type === 'If') { walk(s.then); walk(s.else); }
      else if (s.type === 'While' || s.type === 'For') walk(s.body);
      else if (s.type === 'Select') { for (const c of s.cases ?? []) walk(c.body); if (s.else) walk(s.else.body); }
    }
  };
  for (const p of ast.procs ?? []) walk(p.body);
  for (const sc of ast.scenes ?? []) for (const p of sc.procs ?? []) walk(p.body);
  return use;
}

// ── the phase pool (runtime v3: docs/ARCADE_RUNTIME_API_V3.md "The phase memory: a frame cache per asset") ────────────────────────────────
/** The pool pieces of the real v3 build ($C080 3,456 / $F200 2,176 / $D700 256 = 5,888); runtime.json's POOL_A / POOL_A_LEN ... override them. */
export const DEFAULT_POOL_PIECES = Object.freeze([[0xC080, 3456], [0xF200, 2176], [0xD700, 256]]);
export function poolPieces(constants = {}) {
  const c = constants, p = (n, d) => [c[`POOL_${n}`] ?? d[0], c[`POOL_${n}_LEN`] ?? d[1]];
  return [p('A', DEFAULT_POOL_PIECES[0]), p('B', DEFAULT_POOL_PIECES[1]), p('C', DEFAULT_POOL_PIECES[2])];
}

/**
 * Language batch 7 (docs/ARCADE_LANGUAGE_BATCH7.md section 3): the pool of a VIEW3D game's NOVIEW scenes, built when such a scene is entered, in RAM ray mode only uses within a tick:
 * runtime.json's NV_POOL_A / B / C (addresses) and NV_POOL_A_LEN / B_LEN / C_LEN, with the designed values ($CD00 256, $EE00 3,200, $D700 256 = 3,712 bytes) as the default for a missing one.
 */
export const NOVIEW_POOL_PIECES = Object.freeze([[0xCD00, 256], [0xEE00, 3200], [0xD700, 256]]);
/** The NOVIEW pool pieces exported by the runtime (symbols, then constants), or null when the runtime does not export all six values: the
 *  compiler then refuses the program instead of guessing addresses (NOVIEW_POOL_PIECES is the design's value, used by tests only). */
export function noviewPoolPieces(symbols = {}, constants = {}) {
  const pieces = ['A', 'B', 'C'].map((n) => [symbols[`NV_POOL_${n}`] ?? constants[`NV_POOL_${n}`], constants[`NV_POOL_${n}_LEN`] ?? symbols[`NV_POOL_${n}_LEN`]]);
  return pieces.every(([a, l]) => Number.isInteger(a) && Number.isInteger(l)) ? pieces : null;
}

/**
 * A faithful port of the runtime's boot plan (assets.asm plan_pool; the JS reference is planPool() in arcade/tests/m6-common.mjs). Every allocation is first fit
 * over the pieces in order and never straddles two. 1. for every asset with an instance, in index order: its FTAB (4 x nframes); 2. for every such asset with
 * phases > 1: min(nframes, its instances) slots of (phases - 1) x h x 2 x (w/8 + 1) bytes; 3. more slots, asset by asset in index order, one at a time while
 * one fits, up to nframes. If anything of steps 1-2 does not fit the runtime stops at boot (magenta border) with the missing bytes in FC_MISS.
 * @param {{w: number, h: number, phases: number, nframes: number, instances: number}[]} assets  w is the descriptor width (8, 16, 24, 32)
 * @param {number[][]} pieces  [[address, length], ...]
 * @returns {{ok: boolean, miss: number, K: number[], need: number, perAsset: {ftab: number, slot: number, K: number, nframes: number, built: number}[]}}
 *   K[a] = frame slots of asset a (0 for a 1-phase or unused asset); need = the fragmentation-free minimum of steps 1-2 (the runtime's poolNeed)
 */
export function planPhasePool(assets, pieces = DEFAULT_POOL_PIECES) {
  const next = pieces.map(([a]) => a), end = pieces.map(([a, l]) => a + l);
  const alloc = (n) => { for (let p = 0; p < next.length; p++) if (next[p] + n <= end[p]) { const at = next[p]; next[p] += n; return at; } return -1; };
  const slen = assets.map((a) => (a.phases - 1) * a.h * 2 * (a.w / 8 + 1));
  const used = assets.map((a) => a.instances > 0);
  const K = assets.map(() => 0);
  let miss = 0, need = 0;
  assets.forEach((a, k) => { if (!used[k]) return; need += 4 * a.nframes; if (alloc(4 * a.nframes) < 0) miss += 4 * a.nframes; });
  assets.forEach((a, k) => {
    if (!used[k] || a.phases === 1) return;
    need += Math.min(a.nframes, a.instances) * slen[k];
    for (let j = 0; j < Math.min(a.nframes, a.instances); j++) { if (alloc(slen[k]) < 0) miss += slen[k]; else K[k]++; }
  });
  if (!miss) {
    assets.forEach((a, k) => {
      if (!used[k] || a.phases === 1) return;
      while (K[k] < a.nframes) { if (alloc(slen[k]) < 0) break; K[k]++; }
    });
  }
  return { ok: miss === 0, miss, K, need, perAsset: assets.map((a, k) => ({ ftab: used[k] ? 4 * a.nframes : 0, slot: slen[k], K: K[k], nframes: a.nframes, built: a.phases > 1 ? K[k] : a.nframes })) };
}

/** TSRun measurements of one frame's build (docs/ARCADE_RUNTIME_API_V3.md "A cache miss"): [w, h, phases, T-states]. */
const BUILD_T = [[8, 8, 8, 14250], [16, 16, 4, 21512], [16, 16, 8, 34824], [16, 24, 4, 32088], [24, 16, 4, 25494], [32, 32, 4, 59488], [32, 48, 2, 52176]];
const BUILD_K = (() => { let num = 0, den = 0; for (const [w, h, p, t] of BUILD_T) { const x = w * h * (p - 1); num += t * x; den += x * x; } return num / den; })();
/** About how many T-states building one frame's copies takes: the measured table scaled by area x (phases - 1) (a least-squares fit), to the nearest 100. */
export const buildFrameT = (w, h, phases) => Math.round((BUILD_K * w * h * (phases - 1)) / 100) * 100;

// ── the collision model on WORLD_RAM (the reference interpreter's; tests use an independent per-pixel model) ─────────────────────────
/**
 * World geometry for the collision words: `ram` is WORLD_RAM (2,048 bytes; row r, column c at r * 128 + c, a cell = tile * 8), `worldW` the width in
 * cells, `flags` the 32 tile flags. x is a world pixel from the left of the world, y a pixel from the top of the window (row y >> 3, 16 rows).
 * Outside the world: tile 0 for WORLDTILE; flags 1 (solid) on the left, the right and above, 0 below (BELOW WINS at a corner: a point below the world
 * is empty whatever its column).
 */
export function worldTile(ram, worldW, x, y) {
  const c = x >> 3, r = y >> 3;
  if (c < 0 || c >= worldW || r < 0 || r >= WORLD_ROWS) return 0;
  return ram[r * WORLD_STRIDE + c] >> 3;
}
export function tileFlags(ram, worldW, flags, x, y) {
  const c = x >> 3, r = y >> 3;
  if (r >= WORLD_ROWS) return 0;
  if (c < 0 || c >= worldW || r < 0) return 1;
  return flags[(ram[r * WORLD_STRIDE + c] >> 3) & 31] & 0xFF;
}
/** OR of (flags AND mask) over the cells x..x+w-1, y..y+h-1 touch; w or h <= 0 touches nothing. The sums are exact (not wrapped to 16 bits). */
export function tileHit(ram, worldW, flags, x, y, w, h, mask) {
  if (w <= 0 || h <= 0) return 0;
  let acc = 0;
  for (let r = y >> 3; r <= (y + h - 1) >> 3; r++) {
    for (let c = x >> 3; c <= (x + w - 1) >> 3; c++) acc |= tileFlags(ram, worldW, flags, c * 8, r * 8) & mask;
  }
  return acc & 0xFFFF;
}
