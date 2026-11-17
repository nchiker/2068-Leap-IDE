/**
 * src/lang/arcade/arcade-spriteink.js — the sprite ink tables of a classic scene with `spriteColour = 'ink'` (SC; pure: no DOM, no node: imports; Node can import it).
 * Contract: docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md "SC"; the runtime that reads them is arcade/runtime/v2/spritecol.asm (the "ink" build, RT_SPRITEINK).
 *
 *   inkTables(assets)               -> Uint8Array(81)[]   one table per asset (what the compiler puts in the game image)
 *   inkTable(asset)                 -> Uint8Array(81)
 *   classGrid(asset, xc, yc)        -> 3 x 3 grid (array of 3 rows of 3): ink 0..7, or LEAVE (8) for a cell the sprite does not touch; the class's 9 cells
 *   spriteCellInks(asset, xs, ys)   -> the same grid for ONE draw shift (xs, ys = x and y AND 7): what the sprite recolours at that position
 *   inkAt(asset, x, y)              -> the grid the runtime uses at a draw position (x rounded down to the asset's phase, then its class grid): the interpreter and the Studio's preview
 *   inkClashes(asset)               -> [{row, col, inks}]  the 8 x 8 blocks of the art whose opaque pixels have more than one ink (the lost detail; the sprite-ink-clash warning)
 *   LEAVE (8), TABLE_BYTES (81), CLASS_BYTES (9)
 *
 * An `asset` is {h, data, inks, phases?}: convertSprite's result (arcade-codegen.js) or arcade-interp's `assets[a]`: `data` = h x 4 bytes (mask_hi, mask_lo, image_hi, image_lo; the
 * mask bit is 1 where the BACKGROUND shows, so a pixel the sprite covers has mask bit 0, whatever its image bit: a paper pixel of a sprite covers the background too), `inks` = the
 * ink 0..7 of each art row as authored (frame 0 only: the compiler's v2 sprites have one frame), `phases` 8 when absent.
 *
 * THE LAYOUT, from spritecol.asm (sc_draw2), not guessed:
 *   * sc_draw2 takes the drawn position of the instance, x already rounded to the asset's phase (xd = x AND ~(8 / phases - 1)), and the cell of its top-left corner (HL = CELL_ATTR of the first cell).
 *     class = 3 * xc + yc;  xc = 0 when xd AND 7 = 0, 1 when it is 1..3, 2 when it is 4..7;  yc likewise from y AND 7 (every y 0..191 is possible, an x only the multiples of 8 / phases).
 *   * the asset's grid starts at base + 9 * class (the word table: word 2 * asset at the table, the table on a 256-byte page); 9 bytes = 3 rows x 3 columns, row-major: byte 3 * dr + dc is
 *     the cell dr rows down and dc columns right of the first cell (CELL_ATTR + 32 * dr + dc). The blit covers NR rows (((y AND 7) + h - 1) / 8 + 1) and N columns; the runtime always reads 3 columns
 *     per row, so a column the blit does not cover MUST hold a byte with bit 3 set; rows past NR are not read (we still write LEAVE there).
 *   * byte: bit 3 set (LEAVE = 8) = leave the cell's attribute alone, else the ink 0..7: attr = (attr AND $F8) OR ink.
 *
 * THE INK OF A CELL. A class holds several draw shifts (xc 1: 1..3, xc 2: 4..7, yc likewise), and the sprite's pixels land in different cells at each. For one shift (xs, ys) the pixel at column p, row k of
 * the 16 x h art falls in cell (dr, dc) = ((ys + k) >> 3, (xs + p) >> 3) of the first cell's neighbourhood. A class's cell takes: the ink most used (pixel count; a tie goes to the lower ink) among the
 * covered pixels (mask bit 0) that land in it, counted over EVERY shift of the class that the asset can really be drawn at (an asset with 2 phases is only drawn at x shifts 0 and 4, so its class 1 is empty
 * and class 2 is the shift 4 alone); a cell no covered pixel lands in at any of those shifts is LEAVE. For the aligned class (shift 0) that is exactly the most used ink of each 8 x 8 block of the art.
 * The ink of a pixel is the ink of its art row (the same data fine colour uses: `inks`).
 */

"use strict";

export const LEAVE = 8;
export const CLASS_BYTES = 9;
export const TABLE_BYTES = 81;

/** The draw shifts (x AND 7) of class `c` (0: 0; 1: 1..3; 2: 4..7) that an asset with `phases` pre-shifted positions is ever drawn at (x is rounded down to a multiple of 8 / phases). */
function shiftsOf(c, phases = 8) {
  const step = 8 / phases, from = [0, 1, 4][c], to = [0, 3, 7][c], out = [];
  for (let s = from; s <= to; s++) if (s % step === 0) out.push(s);
  return out;
}

/** The class of a draw shift (0..7): 0 aligned, 1 for 1..3, 2 for 4..7. */
export const shiftClass = (s) => ((s & 7) === 0 ? 0 : (s & 7) < 4 ? 1 : 2);

/** counts[dr][dc][ink 0..7] of the covered pixels of `asset` landing in each cell when drawn at the shifts `xs` x `ys` (lists), summed over all of them. */
function countCells(asset, xs, ys) {
  const counts = Array.from({ length: 3 }, () => Array.from({ length: 3 }, () => new Array(8).fill(0)));
  const h = asset.h ?? 0;
  for (const ys0 of ys) for (const xs0 of xs) {
    for (let k = 0; k < h; k++) {
      const mask = ((asset.data[4 * k] << 8) | asset.data[4 * k + 1]) & 0xFFFF, ink = (asset.inks?.[k] ?? 7) & 7, dr = (ys0 + k) >> 3;
      if (dr > 2) continue;
      for (let p = 0; p < 16; p++) {
        if (mask & (0x8000 >> p)) continue;                    // the background shows here: not covered
        counts[dr][(xs0 + p) >> 3][ink]++;
      }
    }
  }
  return counts;
}

/** The most used ink of a cell's counts (ties to the lower ink), or LEAVE when nothing lands in it. */
function pick(cnt) {
  let best = LEAVE, n = 0;
  for (let i = 0; i < 8; i++) if (cnt[i] > n) { n = cnt[i]; best = i; }
  return best;
}

const gridOf = (counts) => counts.map((row) => row.map(pick));

/** The 3 x 3 grid of ONE draw shift: what the sprite recolours when drawn at x AND 7 = xs, y AND 7 = ys (`asset` as above). */
export function spriteCellInks(asset, xs, ys) {
  return gridOf(countCells(asset, [xs & 7], [ys & 7]));
}

/** The 3 x 3 grid the table holds for class (xc, yc): see the header. */
export function classGrid(asset, xc, yc) {
  return gridOf(countCells(asset, shiftsOf(xc, asset.phases ?? 8), shiftsOf(yc, 8)));
}

/** The grid the runtime uses for a sprite drawn at (x, y): x rounded to the asset's phase, then the class grid of (x AND 7, y AND 7). Row-major 3 x 3, the first cell being (y >> 3, xd >> 3). */
export function inkAt(asset, x, y) {
  const ph = asset.phases ?? 8, xd = x & ~((8 / ph) - 1);
  return classGrid(asset, shiftClass(xd & 7), shiftClass(y & 7));
}

/** One asset's 81 bytes: class 3 * xc + yc, 9 bytes each (row-major 3 x 3). */
export function inkTable(asset) {
  const out = new Uint8Array(TABLE_BYTES);
  for (let xc = 0; xc < 3; xc++) for (let yc = 0; yc < 3; yc++) {
    const g = classGrid(asset, xc, yc), at = CLASS_BYTES * (3 * xc + yc);
    for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) out[at + 3 * dr + dc] = g[dr][dc];
  }
  return out;
}

export function inkTables(assets) {
  return assets.map((a) => inkTable(a));
}

/** The 8 x 8 blocks (aligned, row / col of the 2 x 2 blocks of a 16 x 16 art) holding covered pixels of more than one ink: [{row, col, inks: [ascending]}]. */
export function inkClashes(asset) {
  const out = [], h = asset.h ?? 0;
  for (let row = 0; row * 8 < h; row++) for (let col = 0; col < 2; col++) {
    const seen = new Set();
    for (let k = 8 * row; k < Math.min(h, 8 * row + 8); k++) {
      const mask = ((asset.data[4 * k] << 8) | asset.data[4 * k + 1]) & 0xFFFF;
      for (let p = 8 * col; p < 8 * col + 8; p++) if (!(mask & (0x8000 >> p))) { seen.add((asset.inks?.[k] ?? 7) & 7); break; }
    }
    if (seen.size > 1) out.push({ row, col, inks: [...seen].sort((a, b) => a - b) });
  }
  return out;
}
