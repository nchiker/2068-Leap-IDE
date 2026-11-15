"use strict";
// fine-check.mjs -- the flicker measure of docs/ARCADE_FINE_COLOUR_CONTRACT.md section 3, reusable by F2's tests.  Pure JS (no TSRun import).
//
// A displayed frame is compared, per 8x1 group (pixels + colour, as the viewer sees them), with the fine picture before this tick's update
// (P_old) and after it (P_new):
//   clean  every group equals P_old or P_new, and no sprite is shown partly old, partly new;
//   torn   every group equals P_old or P_new, but some sprite is shown partly at its old and partly at its new state;
//   broken some group equals neither (a blink, a half erase, a wrong colour).  A broken group that is exactly "new bitmap + old colour" or
//          "old bitmap + new colour" (or, pixel by pixel, a mix of old / new bitmap and colour: TSRun paints a group in 4 T, so a write
//          can land inside it) is a split write of that group (isSplit); the contract allows those at <= 1 frame in 1,000.
//
// API
//   pictureKeys({bits, colours})       -> Uint32Array(6144): per group (y * 32 + c) the 8 pixels as 4-bit palette indices (TSRun's palette:
//                                         ink / paper 0..7, +8 when BRIGHT; FLASH is treated as off)
//   frameKeys(pixels)                  -> the same from TSRun's m.pixels (640 x 240 buffer, screen at x 64, y 24, 2 columns a pixel)
//   classifyFrame(shown, oldPic, newPic, spritesOld, spritesNew, assets[, canon])   (canon: a key map applied to every key, e.g. blackCanon)
//       oldPic / newPic: {bits, colours} (finePicture); spritesOld / spritesNew: the instances [{asset, x, y, hidden?}] of both states
//       -> {kind: 'clean' | 'torn' | 'broken', broken: n groups matching neither, split: n of them that are split writes,
//           splitOnly: true when every broken group is a split write, tornSprites: [instance indices], firstBroken: {y, c} | null}
//   tally()                            -> an accumulator: add(result), and summary(perFrames = 1000)
import { rowOff, spriteGroups } from './fine-model.mjs';

/** Key of one group: 8 pixels, 4 bits each (bit 7 of the bitmap first). */
export function groupKey(bitmap, attr) {
  let ink = attr & 7, paper = (attr >> 3) & 7;
  if (attr & 0x40) { ink += 8; paper += 8; }
  let k = 0;
  for (let i = 0; i < 8; i++) k = (k << 4) | ((bitmap << i) & 0x80 ? ink : paper);
  return k >>> 0;
}

/** Group keys of a picture {bits, colours} (indexed by rowOff). */
export function pictureKeys(pic) {
  const out = new Uint32Array(6144);
  for (let y = 0; y < 192; y++) for (let c = 0; c < 32; c++) {
    const o = rowOff(y, c);
    out[y * 32 + c] = groupKey(pic.bits[o], pic.colours[o]);
  }
  return out;
}

/** Group keys of the frame TSRun painted (m.pixels: 640 x 240, screen at x 64, y 24; one Spectrum pixel = 2 columns). */
export function frameKeys(pixels, frameW = 640, scrX = 64, scrY = 24) {
  const out = new Uint32Array(6144);
  for (let y = 0; y < 192; y++) {
    const row = (scrY + y) * frameW + scrX;
    for (let c = 0; c < 32; c++) {
      let k = 0;
      for (let i = 0; i < 8; i++) k = (k << 4) | (pixels[row + 16 * c + 2 * i] & 15);
      out[y * 32 + c] = k >>> 0;
    }
  }
  return out;
}

/** A group caught while its own write was in progress: every pixel is that pixel of one of old / new bitmap x old / new colour (the
 *  beam read the group between its bitmap write and its colour write, or, in TSRun, painted part of the group before a write). */
export function isSplit(shown, ob, oc, nb, nc, canon = (k) => k) {
  const ks = [groupKey(ob, oc), groupKey(nb, oc), groupKey(ob, nc), groupKey(nb, nc)].map(canon);
  for (let i = 0; i < 8; i++) {
    const sh = 28 - 4 * i, p = (shown >>> sh) & 15;
    if (!ks.some((k) => ((k >>> sh) & 15) === p)) return false;
  }
  return true;
}

const keyCache = new WeakMap();
const keysOf = (pic, canon) => {
  let c = keyCache.get(pic); if (!c) { c = new Map(); keyCache.set(pic, c); }
  let k = c.get(canon || null);
  if (!k) { k = pictureKeys(pic); if (canon) k = k.map(canon); c.set(canon || null, k); }
  return k;
};
/** canon for emulators that draw BRIGHT black as black (Fuse, ZEsarUX): palette index 8 read as 0 in every key. */
export const blackCanon = (k) => { let o = 0; for (let i = 0; i < 8; i++) { const n = (k >>> (4 * i)) & 15; o |= (n === 8 ? 0 : n) << (4 * i); } return o >>> 0; };

/** Classify one displayed frame (keys from frameKeys, or any source of group keys). */
export function classifyFrame(shown, oldPic, newPic, spritesOld, spritesNew, assets, canon) {
  const ko = keysOf(oldPic, canon), kn = keysOf(newPic, canon);
  let broken = 0, split = 0, firstBroken = null;
  for (let g = 0; g < 6144; g++) {
    const s = shown[g];
    if (s === ko[g] || s === kn[g]) continue;
    broken++;
    if (!firstBroken) firstBroken = { y: g >> 5, c: g & 31 };
    const o = rowOff(g >> 5, g & 31);
    if (isSplit(s, oldPic.bits[o], oldPic.colours[o], newPic.bits[o], newPic.colours[o], canon)) split++;
  }
  // torn: per instance, the groups of its old and new windows that change between the pictures; some shown old, some shown new
  const tornSprites = [];
  const n = Math.max(spritesOld.length, spritesNew.length);
  for (let j = 0; j < n; j++) {
    const gs = new Set();
    if (spritesOld[j] && !spritesOld[j].hidden) for (const g of spriteGroups(spritesOld[j], assets)) gs.add(g);
    if (spritesNew[j] && !spritesNew[j].hidden) for (const g of spriteGroups(spritesNew[j], assets)) gs.add(g);
    let sawOld = false, sawNew = false;
    for (const g of gs) {
      if (ko[g] === kn[g]) continue;
      if (shown[g] === ko[g]) sawOld = true; else if (shown[g] === kn[g]) sawNew = true;
    }
    if (sawOld && sawNew) tornSprites.push(j);
  }
  const kind = broken ? 'broken' : tornSprites.length ? 'torn' : 'clean';
  return { kind, broken, split, splitOnly: broken > 0 && split === broken, tornSprites, firstBroken };
}

/** Accumulates frame results; summary() gives counts and rates per `per` frames. */
export function tally() {
  const t = { frames: 0, clean: 0, torn: 0, broken: 0, splitOnly: 0, tornSprites: 0, brokenGroups: 0, tornPer100: [], _win: 0, _cnt: 0, examples: [] };
  return {
    add(r, tag) {
      t.frames++; t[r.kind]++;
      if (r.kind === 'broken' && r.splitOnly) t.splitOnly++;
      t.tornSprites += r.tornSprites.length; t.brokenGroups += r.broken;
      if (r.kind === 'broken' && t.examples.length < 8) t.examples.push({ tag, broken: r.broken, split: r.split, at: r.firstBroken });
      t._cnt++; if (r.kind === 'torn') t._win++;
      if (t._cnt === 100) { t.tornPer100.push(t._win); t._cnt = 0; t._win = 0; }
    },
    summary(per = 1000) {
      const s = [...t.tornPer100].sort((a, b) => a - b);
      const f = per / Math.max(1, t.frames);
      return {
        frames: t.frames, clean: t.clean, torn: t.torn, broken: t.broken, brokenSplitOnly: t.splitOnly,
        perK: { clean: +(t.clean * f).toFixed(1), torn: +(t.torn * f).toFixed(1), broken: +(t.broken * f).toFixed(1),
          brokenNotSplit: +((t.broken - t.splitOnly) * f).toFixed(1) },
        tornPer100: { median: s.length ? s[s.length >> 1] : 0, worst: s.length ? s[s.length - 1] : 0 },
        brokenGroups: t.brokenGroups, examples: t.examples,
      };
    },
  };
}
