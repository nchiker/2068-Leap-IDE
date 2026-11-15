"use strict";
// fine-model.mjs -- the fine picture (docs/ARCADE_FINE_COLOUR_CONTRACT.md section 2), exactly, as pure JS.  No DOM, no TSRun.
//
// Screen layout (SCLD mode 2): bitmap byte of pixel row y, byte column c at $4000 + rowOff(y, c); its colour byte (the 8x1 group's
// attribute) at that address + $2000.  Both arrays below are indexed by rowOff (0..6143), i.e. by "address - $4000".
//
//   finePicture({cells, attrs, glyphs, tileRows, sprites, assets}) -> {bits: Uint8Array(6144), colours: Uint8Array(6144)}
//     cells    Uint8Array(768)  cell values (v < 128 font cell, v >= 128 tile v - 128), index 32 * row + col
//     attrs    Uint8Array(768)  cell attributes (used for font cells only)
//     glyphs   Uint8Array(2048) glyph of value v, row k at 8 v + k (font and tiles)
//     tileRows Uint8Array(1024) tile t's row-k attribute at 8 t + k
//     sprites  [{asset, x, y, hidden?}] in instance order (a higher index lies on top)
//     assets   [{w, h, image[], mask[], inks[]}]  (rows as w-bit numbers, bit w-1 = leftmost; mask bit 1 = keep the background)
//   preshift(asset) -> 8 phases [{wb, bytes}] with 4 bytes per screen byte: mask, image, colour mask, colour ink
//     (colour mask $F8 / ink = ink_k where the mask byte is not $FF, else $FF / 0), the table the Z80 blitters read.

export const SCREEN_BYTES = 6144;

/** Offset from $4000 of the bitmap byte of pixel row y (0..191), byte column c (0..31). */
export const rowOff = (y, c) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | c;

/** Width in screen bytes of the blit window of an asset at phase p (x AND 7). */
export const windowBytes = (asset, p) => (asset.w >> 3) + (p ? 1 : 0);

/** The 8 phases of an asset: per row, per window byte: mask, image, colour mask, colour ink. */
export function preshift(asset) {
  const phases = [];
  for (let p = 0; p < 8; p++) {
    const wb = windowBytes(asset, p), win = wb * 8, ones = 2 ** win - 1;
    const bytes = new Uint8Array(asset.h * wb * 4);
    for (let k = 0; k < asset.h; k++) {
      const sh = win - asset.w - p;                         // left shift that places the art at pixel p of the window
      const img = (asset.image[k] * 2 ** sh);
      const opaque = ((~asset.mask[k]) & (2 ** asset.w - 1)) * 2 ** sh;
      const msk = ones - opaque;                            // 1 = keep (outside the art too)
      for (let b = 0; b < wb; b++) {
        const div = 2 ** (8 * (wb - 1 - b));
        const m = Math.floor(msk / div) & 255, i = Math.floor(img / div) & 255;
        const o = (k * wb + b) * 4;
        bytes[o] = m; bytes[o + 1] = i;
        bytes[o + 2] = m === 255 ? 255 : 0xF8;
        bytes[o + 3] = m === 255 ? 0 : (asset.inks[k] & 7);
      }
    }
    phases.push({ wb, bytes });
  }
  return phases;
}

const phaseCache = new WeakMap();
const phasesOf = (a) => { let p = phaseCache.get(a); if (!p) { p = preshift(a); phaseCache.set(a, p); } return p; };

/** The fine picture of a state. */
export function finePicture({ cells, attrs, glyphs, tileRows, sprites, assets }) {
  const bits = new Uint8Array(SCREEN_BYTES), colours = new Uint8Array(SCREEN_BYTES);
  for (let idx = 0; idx < 768; idx++) {
    const r = idx >> 5, c = idx & 31, v = cells[idx];
    for (let k = 0; k < 8; k++) {
      const o = rowOff(8 * r + k, c);
      bits[o] = glyphs[8 * v + k];
      colours[o] = v < 128 ? attrs[idx] : tileRows[8 * (v - 128) + k];
    }
  }
  for (const s of sprites) {
    if (s.hidden) continue;
    const a = assets[s.asset], ph = phasesOf(a)[s.x & 7], c0 = s.x >> 3;
    for (let k = 0; k < a.h; k++) {
      for (let b = 0; b < ph.wb; b++) {
        const t = (k * ph.wb + b) * 4, o = rowOff(s.y + k, c0 + b);
        bits[o] = (bits[o] & ph.bytes[t]) | ph.bytes[t + 1];
        colours[o] = (colours[o] & ph.bytes[t + 2]) | ph.bytes[t + 3];
      }
    }
  }
  return { bits, colours };
}

/** The 8x1 groups (index y * 32 + c) of a sprite's blit window. */
export function spriteGroups(s, assets) {
  const a = assets[s.asset], wb = windowBytes(a, s.x & 7), c0 = s.x >> 3, out = [];
  for (let k = 0; k < a.h; k++) for (let b = 0; b < wb; b++) out.push((s.y + k) * 32 + c0 + b);
  return out;
}

/** Cell rectangle {c0, r0, c1, r1} (inclusive) of a sprite's blit window. */
export function spriteCells(s, assets) {
  const a = assets[s.asset], wb = windowBytes(a, s.x & 7);
  return { c0: s.x >> 3, c1: (s.x >> 3) + wb - 1, r0: s.y >> 3, r1: (s.y + a.h - 1) >> 3 };
}
