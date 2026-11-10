"use strict";
// m3-scenes.mjs -- random scene generators of the M3 runtime tests (seeded; the same seed gives the same scene).
import { op } from './m3-common.mjs';

export function rng(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));      // inclusive
  const pick = (a) => a[int(0, a.length - 1)];
  return { next, int, pick, chance: (p) => next() < p };
}

/** A random tileset of n tiles: 8 random bitmap bytes and an attribute (no flash bit: the model does not render flash). */
export function randomTiles(r, n) {
  return Array.from({ length: n }, () => ({ bmp: Array.from({ length: 8 }, () => r.int(0, 255)), attr: r.int(0, 0x7F) }));
}

/** A random string of printable ASCII (and now and then a control or high code), length 0..max. */
export function randomText(r, max, wild = false) {
  const n = r.int(0, max);
  return Array.from({ length: n }, () => (wild && r.chance(0.08) ? r.pick([0, 7, 31, 127, 128, 200, 255]) : r.int(32, 126)));
}

/**
 * A random scene of `nTicks` ticks.  opts: { sprites: n (<= 4), tiles: n (tile indexes used), textRate, tileRate, clsEvery, wild, hits, spread }.
 * Sprites random-walk (with now and then a far jump or an out-of-range position so the clamps are exercised); text is printed at random
 * places with random attributes; tiles are set at random cells (sometimes out of range).
 */
export function randomScene(seed, nTicks, { sprites = 4, tiles = 8, textRate = 0.5, tileRate = 0.8, clsEvery = 0, wild = false, hits = false, maxText = 12, tileBurst = 3 } = {}) {
  const r = rng(seed);
  const pos = Array.from({ length: sprites }, () => ({ x: r.int(0, 230), y: r.int(0, 170), dx: r.int(-5, 5), dy: r.int(-4, 4) }));
  const ticks = [];
  for (let t = 0; t < nTicks; t++) {
    const ops = [];
    if (clsEvery && t > 0 && t % clsEvery === 0) { ops.push(op.paper(r.int(0, 7))); ops.push(op.cls()); }
    if (r.chance(textRate)) {
      if (r.chance(0.5)) ops.push(op.ink(r.int(0, 9)));          // 8 and 9 test the AND 7
      if (r.chance(0.4)) ops.push(op.paper(r.int(0, 7)));
      if (r.chance(0.3)) ops.push(op.bright(r.int(0, 1)));
      ops.push(op.at(r.chance(0.05) ? r.int(24, 255) : r.int(0, 23), r.chance(0.05) ? r.int(32, 255) : r.int(0, 31)));
      const k = r.int(0, 4);
      if (k === 0) ops.push(op.printn(r.chance(0.5) ? r.int(-32768, 32767) : r.int(-300, 300)));
      else if (k === 1) ops.push(op.printc(r.chance(0.2) ? r.int(0, 255) : r.int(32, 126)));
      else ops.push(op.prints(randomText(r, maxText, wild)));
    }
    if (tiles && r.chance(tileRate)) for (let k = r.int(1, tileBurst); k > 0; k--) ops.push(op.tile(r.int(0, tiles - 1 + (r.chance(0.05) ? 200 : 0)), r.chance(0.04) ? r.int(24, 255) : r.int(0, 23), r.chance(0.04) ? r.int(32, 255) : r.int(0, 31)));
    sprites && pos.forEach((p, i) => {
      if (r.chance(0.04)) { p.x = r.int(-40, 300); p.y = r.int(-40, 230); }
      else { p.x += p.dx; p.y += p.dy; if (p.x < -3 || p.x > 245) p.dx = -p.dx; if (p.y < -3 || p.y > 185) p.dy = -p.dy; }
      if (r.chance(0.03)) ops.push(op.hide(i)); else ops.push(op.show(i, p.x, p.y));
    });
    if (hits && sprites > 1) { ops.push(op.hit(r.int(0, sprites - 1), r.int(0, sprites + 1))); ops.push(op.tileat(r.int(0, 25), r.int(0, 33))); }
    // shuffle a little: ops are applied in order, so a random rotation of the tick still is a valid scene
    ticks.push(ops);
  }
  return ticks;
}
