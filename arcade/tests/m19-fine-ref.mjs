"use strict";
// m19-fine-ref.mjs -- the reference picture of docs/ARCADE_FINE_COLOUR_CONTRACT.md section 2 for the m19 runtime tests, through ONE import line:
// the compiler side's src/lang/arcade/arcade-fine.js (the same function the Studio previews and the interpreter's pictures use).
import { finePicture } from '../../src/lang/arcade/arcade-fine.js';

/**
 * The fine picture of a state -> { bits, colours } (6,144 bytes each, indexed by screen address - $4000 / - $6000).
 * state: { cells (768), attrs (768), glyphs (2,048: value v row k at 8 v + k), tileRows (1,024), sprites: [{ asset, x (rounded to the asset's
 * phases), y, hidden }] in instance order, assets: [{ w, h, image: [rows], mask: [rows], inks: [rows] }] }.
 * The test assets carry each row as a w-bit number (mask bit 1 = transparent); arcade-fine.js takes the compiler's form, 4 bytes a row: the
 * mask and the image as 16-bit words, left-aligned (the columns past w transparent).
 */
const dataCache = new WeakMap();
function compilerAsset(a) {
  let c = dataCache.get(a);
  if (!c) {
    const data = [], pad = 16 - a.w;
    for (let k = 0; k < a.h; k++) {
      const mask16 = ((a.mask[k] << pad) | ((1 << pad) - 1)) & 0xFFFF, image16 = (a.image[k] << pad) & 0xFFFF;
      data.push(mask16 >> 8, mask16 & 0xFF, image16 >> 8, image16 & 0xFF);
    }
    c = { w: a.w, h: a.h, phases: 8, data, inks: a.inks };
    dataCache.set(a, c);
  }
  return c;
}

export function picture(state) {
  const glyphs = state.glyphs;
  return finePicture({
    cells: state.cells, attrs: state.attrs, tileRows: state.tileRows,
    sprites: state.sprites.map((s) => ({ asset: s.asset, x: s.x, y: s.y, visible: !s.hidden })),
    assets: state.assets.map(compilerAsset),
    glyph: (v) => glyphs.subarray(8 * v, 8 * v + 8),
  });
}
