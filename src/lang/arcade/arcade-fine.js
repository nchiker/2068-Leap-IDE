/**
 * src/lang/arcade/arcade-fine.js — the fine picture of a Leap Arcade fine-colour scene (pure; no DOM, no CodeMirror, no node: imports; Node can import it).
 * Fine colour = 8 x 1 colour (SCLD mode 2), docs/ARCADE_FINE_COLOUR_CONTRACT.md section 2, which this module implements exactly and is the reference the runtime is tested against.
 *
 *   finePicture({cells, attrs, tileRows, sprites, instAsset, assets, glyph}) -> {bits: Uint8Array(6144), colours: Uint8Array(6144)}
 *   spriteColour(colour, ink)                   -> the colour byte after a sprite of that ink was blitted over a byte: (colour AND $F8) OR ink
 *   glyphSource({font, tileBytes})              -> glyph(v): the 8 bitmap bytes of a cell value (a font character 32..127, a tile 128 + index, else blank)
 *   fineOfRun(run, rec, font)                   -> finePicture of one record of an interpreter run (`run.fine` and the record's cells / attrs / sprites); null when the record is not in a fine scene
 *
 * THE PICTURE. While a fine scene runs, `$FF` = 2: the screen is the bitmap at $4000 and one colour byte per 8 x 1 pixel group at the same offset + $2000. Both results use the ZX layout
 * (offset of pixel row y, byte column c = rowOff(y, c), arcade-display.js): `bits` the bitmap, `colours` the colour byte of the group at the same offset (the colour byte is an attribute: ink 0-2, paper 3-5, BRIGHT 6, FLASH 7).
 *   1. Cells. Cell (r, c) holds value v and attribute a (the cell map, `cells` / `attrs`: 768 each). Its 8 pixel rows are glyph(v). Its 8 colour bytes: a font cell (v < 128): a on all 8 rows; a tile cell (v >= 128, tile t =
 *      v - 128): the tile's eight row attributes tileRows[8 t + k] (bright << 6 | paper << 3 | ink of row k), the cell's own attribute byte is not used. A tile the table does not hold (no `tileRows`, or t beyond it)
 *      falls back to a.
 *   2. Sprites, in instance order (a higher index lies on top), each at its drawn position, x rounded DOWN to the asset's phase granularity (x AND ~(8 / phases - 1), phases 8 4 2 1: 1 2 4 8 pixels). The bitmap is the
 *      masked blit of the runtime: for each pixel row k of the sprite and each of the (at most 3) screen bytes of its window (the 16-pixel row shifted right by x AND 7 inside 24 bits), bits = (bits AND mask) OR image.
 *      The colour of every such screen byte WHOSE MASK BYTE IS NOT $FF (the sprite covers at least one pixel of the byte) becomes (colour AND $F8) OR ink_k: the ink of the asset's row k as authored; the paper, BRIGHT and FLASH
 *      are the background's. A byte the sprite does not cover keeps its colour. Sprites are applied in order, so a later sprite's ink wins on a shared byte. A byte column outside 0..31 and a pixel row outside 0..191 are not drawn.
 *   3. Nothing else writes the screen (no flip, no 8 x 8 attributes).
 *
 * INPUTS.
 *   cells, attrs   768 bytes each (a record of arcade-interp.js has both)
 *   tileRows       count x 8 bytes (convertTileset(...).rowAttrs) or null / undefined
 *   sprites        [{visible, x, y, asset?}]: the record's `sprites` (instance order); `visible` falsy = not drawn
 *   instAsset      [asset index per instance] (the interpreter's result; used when a sprite has no `asset`)
 *   assets         [{h, data, inks, phases?} | null] by asset index: `data` = h x 4 bytes (mask_hi, mask_lo, image_hi, image_lo: convertSprite's format), `inks` = 16 bytes (the row inks), `phases` 8 when absent
 *   glyph          (v) -> 8 bytes (array-like): the cell value's pixel rows; see glyphSource
 */

"use strict";

import { rowOff } from './arcade-display.js';

export { rowOff };
export const FINE_BYTES = 6144;

/** The colour byte after a sprite row of ink `ink` was blitted over a byte of colour `colour`: the ink bits are replaced, the paper, BRIGHT and FLASH stay. */
export const spriteColour = (colour, ink) => ((colour & 0xF8) | (ink & 7)) & 0xFF;

/** x as the runtime draws it for an asset with `phases` pre-shifted positions: x AND (the phase mask), i.e. rounded down to a multiple of 8 / phases. */
export const phaseX = (x, phases = 8) => x & ~((8 / phases) - 1);

/** glyph(v) over a font (96 glyphs of 8 bytes for the codes 32..127, `font[code - 32]`) and the tileset's bytes (9 per tile: 8 bitmap bytes and the attribute, convertTileset(...).bytes). */
export function glyphSource({ font, tileBytes }) {
  const blank = [0, 0, 0, 0, 0, 0, 0, 0];
  return (v) => {
    if (v & 0x80) {
      const t = v & 0x7F;
      return tileBytes && 9 * t + 8 <= tileBytes.length ? Array.from(tileBytes.slice(9 * t, 9 * t + 8)) : blank;
    }
    return v >= 32 && v <= 127 ? font[v - 32] ?? blank : blank;
  };
}

export function finePicture({ cells, attrs, tileRows, sprites, instAsset, assets, glyph }) {
  const bits = new Uint8Array(FINE_BYTES), colours = new Uint8Array(FINE_BYTES);
  // 1. the cells
  for (let r = 0; r < 24; r++) {
    for (let c = 0; c < 32; c++) {
      const v = cells[r * 32 + c], a = attrs[r * 32 + c], g = glyph(v), tile = v >= 128 ? v - 128 : -1;
      const rows = tile >= 0 && tileRows && 8 * tile + 8 <= tileRows.length ? tileRows : null;
      for (let k = 0; k < 8; k++) {
        const o = rowOff(8 * r + k, c);
        bits[o] = g[k] & 0xFF;
        colours[o] = rows ? rows[8 * tile + k] : a;
      }
    }
  }
  // 2. the sprites, in instance order
  (sprites ?? []).forEach((s, i) => {
    if (!s || !s.visible) return;
    const asset = assets?.[s.asset ?? instAsset?.[i]];
    if (!asset) return;
    const x0 = phaseX(s.x, asset.phases ?? 8), s0 = x0 & 7, byte0 = x0 >> 3, sh = 8 - s0;
    for (let k = 0; k < asset.h; k++) {
      const y = s.y + k;
      if (y < 0 || y > 191) continue;
      const mask16 = (asset.data[4 * k] << 8) | asset.data[4 * k + 1], image16 = (asset.data[4 * k + 2] << 8) | asset.data[4 * k + 3];
      const mask24 = ((mask16 << sh) | (~(0xFFFF << sh) & 0xFFFFFF)) & 0xFFFFFF, image24 = (image16 << sh) & 0xFFFFFF;
      for (let j = 0; j < 3; j++) {
        const col = byte0 + j;
        if (col < 0 || col > 31) continue;
        const mb = (mask24 >> (16 - 8 * j)) & 0xFF, ib = (image24 >> (16 - 8 * j)) & 0xFF, o = rowOff(y, col);
        bits[o] = (bits[o] & mb) | ib;
        if (mb !== 0xFF) colours[o] = spriteColour(colours[o], asset.inks[k]);
      }
    }
  });
  return { bits, colours };
}

/** The fine picture of record `rec` of `run` (an interpret() result of a game with a fine scene); `font` as in glyphSource. null when the record's scene is not fine (or the run has no fine scene). */
export function fineOfRun(run, rec, font) {
  if (!run?.fine || !rec?.fine) return null;
  return finePicture({
    cells: rec.cells, attrs: rec.attrs, tileRows: run.fine.tileRows, sprites: rec.sprites, instAsset: run.fine.instAsset, assets: run.fine.assets,
    glyph: glyphSource({ font, tileBytes: run.fine.tileBytes }),
  });
}
