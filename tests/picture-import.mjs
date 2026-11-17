"use strict";
// picture-import.mjs -- tests for src/tools/picture-import.js (picture import for tiles and maps, T2 + M3).
//   node tests/picture-import.mjs
//
// Sections
//   1  one colour, two colours, four colours
//   2  dithers: error diffusion keeps the average of a ramp, ordered, none; determinism
//   3  merging: duplicates, inverted and swapped cells, an existing set
//   4  the 128-tile limit: a noise picture of 768 distinct cells, the lossy reduction, room for an append
//   5  fine mode: a colour per pixel row
//   6  the two-blacks rule, transparency, fit / crop / stretch
//   7  everything produced is valid: tile-model, map-model, arcade-project, and the asset check says nothing
//   8  the PNG export sheet and the round trip through the importer
//   9  speed: 256 x 192

import * as PI from '../src/tools/picture-import.js';
import * as T from '../src/tools/tile-model.js';
import * as M from '../src/tools/map-model.js';
import * as P from '../src/arcade-project.js';
import { PALETTE, keyRGB, colourKey } from '../src/tools/sprite-model.js';
import { checkAssets } from '../src/lang/arcade/arcade-assetcheck.js';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  cond ? passed++ : failed++;
  return cond;
};

// ── pictures built by hand ────────────────────────────────────────────────────────────────────────────────────
/** An RGBA picture w x h from a function (x, y) -> [r, g, b] or [r, g, b, a]. */
function picture(w, h, fn) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = fn(x, y); data.set([c[0], c[1], c[2], c[3] ?? 255], (y * w + x) * 4); }
  return { width: w, height: h, data };
}
const rgbOf = (key) => keyRGB(key, PALETTE);
const RED = rgbOf(2), BLUE = rgbOf(1), GREEN = rgbOf(4), YELLOW = rgbOf(6), WHITE = rgbOf(7), BLACK = [0, 0, 0], BRED = rgbOf(10), BWHITE = rgbOf(15);
/** The deterministic noise generator of the tests (an LCG): 0..255. */
function rng(seed) { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; }; }
/** The pixels a cell shows: 64 colour keys. */
const keysOf = (cell) => Array.from(cell.keys);
/** The rendering of a build result: the tile (of the combined list) for every cell, 64 keys; blank = null. */
function render(result, existing = []) {
  const all = [...existing, ...result.tiles];
  return Array.from(result.map, (v) => (v === 255 ? null : Array.from(T.tilePixels(all[v], { fine: true }))));
}
/** Mean RGB of a list of keys. */
const meanRGB = (keys) => { const m = [0, 0, 0]; for (const k of keys) { const c = rgbOf(k); m[0] += c[0]; m[1] += c[1]; m[2] += c[2]; } return m.map((v) => v / keys.length); };

// ── 1: colours ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('1  one colour, two colours, four colours');
{
  const flat = PI.quantizeToCells(picture(64, 32, () => RED), { cols: 8, rows: 4 });
  const r = PI.buildTiles(flat);
  check('a picture of one flat colour gives 1 tile for all 32 cells', r.tiles.length === 1 && r.map.every((v) => v === 0) && r.distinct === 1 && r.merged === 31 && !r.overflow, `${r.tiles.length} tiles`);
  const t = r.tiles[0];
  check('that tile shows only red (paper red, no pixel set), bright 0', t.bits.every((b) => b === 0) && t.paper === 2 && t.bright === 0 && T.tilePixels(t).every((k) => k === 2));

  // a checkerboard cell of red and blue stays exact
  const chk = picture(8, 8, (x, y) => ((x + y) & 1 ? RED : BLUE));
  const g2 = PI.quantizeToCells(chk, { cols: 1, rows: 1, dither: 'none' });
  const px = keysOf(g2.cells[0]);
  check('a red / blue checkerboard cell stays exact (every pixel the colour it had, one pair, one brightness)', px.every((k, i) => k === (((i & 7) + (i >> 3)) & 1 ? 2 : 1)), px.join(''));
  const g2d = PI.quantizeToCells(chk, { cols: 1, rows: 1 });
  check('and with error diffusion on', keysOf(g2d.cells[0]).every((k, i) => k === (((i & 7) + (i >> 3)) & 1 ? 2 : 1)));

  // four colours in a cell: two quadrants each
  const quad = picture(8, 8, (x, y) => (y < 4 ? (x < 4 ? RED : BLUE) : (x < 4 ? GREEN : YELLOW)));
  const g4 = PI.quantizeToCells(quad, { cols: 1, rows: 1, dither: 'none' });
  const ks = new Set(keysOf(g4.cells[0]));
  check('a four-colour cell is reduced to two colours of one brightness', ks.size === 2 && g4.cells[0].rows.every((c) => c.bright === g4.cells[0].rows[0].bright), [...ks].join());
  // the pair is the least-error pair: the cost of the chosen pair is no more than that of any other pair
  const cost = (pair) => { let s = 0; const rg = pair.map(rgbOf); for (const c of [RED, BLUE, GREEN, YELLOW]) s += 16 * Math.min(...rg.map((p) => 2 * (c[0] - p[0]) ** 2 + 4 * (c[1] - p[1]) ** 2 + 3 * (c[2] - p[2]) ** 2)); return s; };
  const chosen = [...ks], all = [];
  for (const a of [0, 1, 2, 3, 4, 5, 6, 7]) for (const b of [a, ...[1, 2, 3, 4, 5, 6, 7].filter((x) => x > a)]) all.push([a, b]);
  const allB = []; for (const a of [1, 2, 3, 4, 5, 6, 7]) for (const b of [a, ...[1, 2, 3, 4, 5, 6, 7].filter((x) => x > a)]) allB.push([a + 8, b + 8]);
  const bestCost = Math.min(...[...all, ...allB].map(cost));
  check('it is the best pair over the 15 colours (no other pair of one brightness has less error)', cost(chosen) <= bestCost + 1e-6, `${cost(chosen)} vs ${bestCost}`);
  // two colours of a cell the importer cannot keep: yellow-ish top and cyan-ish bottom get the nearest two
  const nearish = picture(8, 8, (x, y) => (y < 4 ? [200, 200, 10] : [10, 190, 200]));
  const gn = PI.quantizeToCells(nearish, { cols: 1, rows: 1, dither: 'none' });
  check('near-spectrum colours map to the nearest (yellow over cyan)', keysOf(gn.cells[0]).slice(0, 32).every((k) => k === 6) && keysOf(gn.cells[0]).slice(32).every((k) => k === 5));
}

// ── 2: dithers ────────────────────────────────────────────────────────────────────────────────────────────────
console.log('2  dithers');
{
  const ramp = picture(256, 24, (x) => { const v = Math.round(x * 255 / 255); return [v, v, v]; });
  const src = [0, 0, 0]; for (let x = 0; x < 256; x++) { src[0] += x; } const srcMean = src[0] / 256;
  const mean = (g) => { let m = 0, n = 0; for (const c of g.cells) for (const k of c.keys) { const v = rgbOf(k); m += (v[0] + v[1] + v[2]) / 3; n++; } return m / n; };
  const gd = PI.quantizeToCells(ramp, { cols: 32, rows: 3, dither: 'diffusion' });
  const go = PI.quantizeToCells(ramp, { cols: 32, rows: 3, dither: 'ordered' });
  const gn = PI.quantizeToCells(ramp, { cols: 32, rows: 3, dither: 'none' });
  check('error diffusion keeps the average of a grey ramp (within 6 of 255)', Math.abs(mean(gd) - srcMean) < 6, `${mean(gd).toFixed(1)} vs ${srcMean.toFixed(1)}`);
  check('ordered dither keeps the average of a grey ramp (within 8)', Math.abs(mean(go) - srcMean) < 8, `${mean(go).toFixed(1)} vs ${srcMean.toFixed(1)}`);
  check('without dither the ramp comes out in steps (fewer different cells than with a dither, far less well kept on average)', Math.abs(mean(gn) - srcMean) >= Math.abs(mean(gd) - srcMean) - 1e-9, `${mean(gn).toFixed(1)}`);
  // a flat mid-grey (between black and white): diffusion makes a mix, "none" a solid colour
  const grey = picture(8, 8, () => [102, 102, 102]);
  const dk = keysOf(PI.quantizeToCells(grey, { cols: 1, rows: 1, dither: 'diffusion' }).cells[0]);
  const nk = new Set(keysOf(PI.quantizeToCells(grey, { cols: 1, rows: 1, dither: 'none' }).cells[0]));
  check('a flat mid grey: diffusion mixes two colours, "none" gives one', new Set(dk).size === 2 && nk.size === 1, `${new Set(dk).size} / ${nk.size}`);
  const mg = meanRGB(dk);
  check('and the mix averages the grey (within 20)', Math.abs(mg[0] - 102) < 20 && Math.abs(mg[1] - 102) < 20, mg.map((v) => v.toFixed(0)).join());

  // determinism: the same picture and options give the same cells
  const noise = (seed) => { const r = rng(seed); return picture(64, 48, () => [r(), r(), r()]); };
  for (const dither of ['none', 'ordered', 'diffusion']) {
    const a = PI.buildTiles(PI.quantizeToCells(noise(7), { cols: 8, rows: 6, dither })), b = PI.buildTiles(PI.quantizeToCells(noise(7), { cols: 8, rows: 6, dither }));
    check(`determinism (${dither}): the same picture twice gives the same tiles and map`, JSON.stringify(a.tiles) === JSON.stringify(b.tiles) && Buffer.compare(Buffer.from(a.map), Buffer.from(b.map)) === 0);
  }
  const c1 = PI.pictureToAssets(noise(9), { cols: 8, rows: 6 }), c2 = PI.pictureToAssets(noise(9), { cols: 8, rows: 6 });
  check('determinism: pictureToAssets twice gives byte-equal JSON', JSON.stringify(c1.tileset) === JSON.stringify(c2.tileset) && JSON.stringify(c1.map) === JSON.stringify(c2.map));
}

// ── 3: merging ─────────────────────────────────────────────────────────────────────────────────────────────
console.log('3  merging');
{
  // four cells: A, A again, A with the colours swapped (same picture), B
  const cellPic = (which, x, y) => {
    const on = which === 0 ? x < 4 : which === 1 ? x < 4 : which === 2 ? x >= 4 : y < 2;
    return which === 2 ? (on ? RED : BLUE) : (on ? BLUE : RED);          // 2: swapped colours and inverted bits = the same picture as 0 when "x >= 4 red" ... see below
  };
  // 0: left half blue, right half red.  1: the same.  2: left half red? -> that is a different picture; build the genuinely equal swapped one instead
  const pic = picture(32, 8, (x, y) => {
    const cx = x >> 3, lx = x & 7;
    if (cx === 0 || cx === 1) return lx < 4 ? BLUE : RED;                  // two equal cells
    if (cx === 2) return lx < 4 ? BLUE : RED;                              // a third (also equal)
    return y < 2 ? BLUE : RED;                                             // a different one
  });
  const g = PI.quantizeToCells(pic, { cols: 4, rows: 1, dither: 'none' });
  const r = PI.buildTiles(g);
  check('three equal cells and one different make 2 tiles; the map is 0 0 0 1', r.tiles.length === 2 && Array.from(r.map).join() === '0,0,0,1' && r.merged === 2, Array.from(r.map).join());
  // a cell and its inverse (ink and paper swapped, bits inverted) are the same picture: merged whichever way the pair was found
  const half = (x, y, flip) => ((x < 4) !== flip ? RED : BLUE);
  const inv = picture(16, 8, (x, y) => half(x & 7, y, x >= 8));
  // second cell: left half BLUE, right RED = the opposite picture (NOT equal). Build an equal one with swapped roles instead through the tile model:
  const sw = picture(16, 8, (x, y) => (x & 7) < 4 ? RED : BLUE);
  const rr = PI.buildTiles(PI.quantizeToCells(sw, { cols: 2, rows: 1, dither: 'none' }));
  check('two identical two-colour cells merge', rr.tiles.length === 1 && Array.from(rr.map).join() === '0,0');
  const rinv = PI.buildTiles(PI.quantizeToCells(inv, { cols: 2, rows: 1, dither: 'none' }));
  check('a cell and its mirror colours (red left / blue right against blue left / red right) are two pictures', rinv.tiles.length === 2);
  // the same picture written with ink and paper swapped IS merged: use existing tiles written both ways
  const a = T.newTile({ ink: 2, paper: 1, bright: 0 }); a.bits = [0xF0, 0xF0, 0xF0, 0xF0, 0xF0, 0xF0, 0xF0, 0xF0];
  const b = T.newTile({ ink: 1, paper: 2, bright: 0 }); b.bits = a.bits.map((v) => (~v) & 0xFF);
  check('(the model) a tile and its ink / paper swapped, bits inverted twin draw the same 64 colours', JSON.stringify(Array.from(T.tilePixels(a))) === JSON.stringify(Array.from(T.tilePixels(b))));
  const existing = { tiles: [b], tilesKey: 'tiles' };
  const re = PI.buildTiles(PI.quantizeToCells(picture(16, 8, (x) => ((x & 7) < 4 ? RED : BLUE)), { cols: 2, rows: 1, dither: 'none' }), { existing });
  check('a cell equal to an existing tile (written with ink and paper the other way round) reuses it: no new tile', re.tiles.length === 0 && Array.from(re.map).join() === '0,0' && re.reused === 2 && re.base === 1, JSON.stringify({ t: re.tiles.length, m: Array.from(re.map) }));
  // an existing tile with a flag is not reused (it has a job of its own)
  const flagged = T.cloneTile(b); flagged.flags = 1;
  const rf = PI.buildTiles(PI.quantizeToCells(picture(16, 8, (x) => ((x & 7) < 4 ? RED : BLUE)), { cols: 2, rows: 1, dither: 'none' }), { existing: { tiles: [flagged], tilesKey: 'tiles' } });
  check('an existing tile with flags is not reused: a new tile numbered after it', rf.tiles.length === 1 && Array.from(rf.map).join() === '1,1');
  // inverted cells: left half red / right half blue against its bit-inverse made by the importer from the swapped roles
  const mirror = picture(16, 8, (x) => ((x & 7) < 4 ? (x < 8 ? RED : BLUE) : (x < 8 ? BLUE : RED)));
  const gm = PI.quantizeToCells(mirror, { cols: 2, rows: 1, dither: 'none' });
  const c0 = gm.cells[0], c1 = gm.cells[1];
  check('(the importer) two cells that are mirror colours get different keys, equal cells equal keys', JSON.stringify(keysOf(c0)) !== JSON.stringify(keysOf(c1)));
  // the importer's own invariant: any two cells with the same rendering merge, however their pair was found
  const rnd = rng(3);
  const two = picture(64, 8, (x, y) => { const cx = x >> 3, v = ((cx * 7 + (x & 7) + y) % 3 === 0); return v ? RED : BLUE; });
  const rt = PI.buildTiles(PI.quantizeToCells(two, { cols: 8, rows: 1, dither: 'none' }));
  const shown = render(rt), uniq = new Set(shown.map((s) => s.join()));
  check('the tiles of an import are as many as the different pictures (never two tiles that look alike)', rt.tiles.length === uniq.size, `${rt.tiles.length} tiles, ${uniq.size} pictures`);
  void rnd; void cellPic;
}

// ── 4: the limit ───────────────────────────────────────────────────────────────────────────────────────────
console.log('4  the 128-tile limit');
{
  // 768 distinct cells: each cell has a unique bit pattern in two colours (the cell index is written in binary over 10 bits, plus a rotating pattern)
  const noise = picture(256, 192, (x, y) => {
    const cx = x >> 3, cy = y >> 3, n = cy * 32 + cx, lx = x & 7, ly = y & 7;
    const bit = (n * 2654435761 >>> 0) >>> ((ly * 8 + lx) % 24);       // a different pattern per cell
    return ((bit ^ (lx * 5 + ly * 3 + n)) & 1) ? RED : BLUE;
  });
  const g = PI.quantizeToCells(noise, { cols: 32, rows: 24, dither: 'none' });
  const r = PI.buildTiles(g);
  check('a noise picture of 768 distinct cells reports the overflow with the number needed', r.overflow && r.needed > 128 && r.needed <= 768, `needed ${r.needed}`);
  check('the reduced result fits: at most 128 tiles, every map cell names one', r.tiles.length === 128 && r.map.every((v) => v < 128), `${r.tiles.length} tiles`);
  check('it says which merges were lossy: pictures given up and cells that show another picture', r.lossyTiles === r.needed - 128 && r.lossyCells > 0 && r.lossyCells >= r.lossyTiles, `${r.lossyTiles} pictures, ${r.lossyCells} cells`);
  check('the message names the number needed and the limit', /needs \d+ tiles but the limit is 128/.test(PI.describeImport(r)), PI.describeImport(r));
  // a cell that kept its own picture is rendered exactly
  const rendered = render(r), want = g.cells.map((c) => Array.from(c.keys));
  const exact = rendered.filter((px, i) => px.join() === want[i].join()).length;
  check('cells whose picture was kept are exact, the others are the nearest kept picture', exact === 768 - r.lossyCells, `${exact} exact of 768`);
  // lossy merges move the rare pictures: more cells are exact than a random merge would leave
  check('the reduction merges rare pictures first (at least 128 cells kept exact)', exact >= 128);
  // exactly 128 distinct is not an overflow
  const exact128 = picture(128, 8, (x, y) => ((x >> 3) >> 0) % 128 === 0 || true ? ((((x >> 3) & 63) >> ((y + (x & 7)) % 6)) & 1 ? RED : BLUE) : RED);
  const g128 = PI.quantizeToCells(exact128, { cols: 16, rows: 1, dither: 'none' });
  const r128 = PI.buildTiles(g128);
  check('a picture that needs fewer than the limit does not overflow', !r128.overflow && r128.lossyCells === 0 && r128.needed === r128.tiles.length);
  // append: room of 10, 20 new pictures
  const small = picture(160, 8, (x, y) => ((((x >> 3) * 31 + ((x & 7) + y) * 7) % 5) < 2 ? RED : BLUE));
  void small;
  const base = { tiles: Array.from({ length: 118 }, (_, i) => { const t = T.newTile(); t.bits = [i, 0, 0, 0, 0, 0, 0, 0]; return t; }), tilesKey: 'tiles' };
  const gA = PI.quantizeToCells(noise, { cols: 32, rows: 4, dither: 'none' });
  const rA = PI.buildTiles(gA, { existing: base });
  check('appending to a set of 118 tiles leaves room for 10: 10 new tiles, numbers 118..127, overflow reported against the whole', rA.tiles.length === 10 && rA.base === 118 && rA.overflow && rA.needed > 128 && rA.map.every((v) => v >= 118 && v < 128), `${rA.tiles.length} tiles, needed ${rA.needed}`);
  const full = { tiles: Array.from({ length: 128 }, (_, i) => { const t = T.newTile(); t.bits = [i, 1, 0, 0, 0, 0, 0, 0]; return t; }), tilesKey: 'tiles' };
  const rF = PI.buildTiles(gA, { existing: full });
  check('appending to a full set adds no tile: every cell takes the nearest existing one, and it says so', rF.tiles.length === 0 && rF.overflow && rF.map.every((v) => v < 128) && rF.lossyCells > 0 && PI.roomIn(full) === 0);
  check('maxTiles can be lowered (a 16-tile limit)', PI.buildTiles(g, { maxTiles: 16 }).tiles.length === 16);
}

// ── 5: fine colour ───────────────────────────────────────────────────────────────────────────────────────────
console.log('5  fine colour (8 x 1)');
{
  // each pixel row of the cell has its own pair: row y: left half colour A(y), right half colour B(y)
  const A = [RED, GREEN, BLUE, YELLOW, RED, GREEN, BLUE, YELLOW], B = [BLUE, YELLOW, RED, GREEN, WHITE, BLACK, WHITE, BLACK];
  const pic = picture(8, 8, (x, y) => (x < 4 ? A[y] : B[y]));
  const fine = PI.quantizeToCells(pic, { cols: 1, rows: 1, dither: 'none', fine: true });
  const norm = PI.quantizeToCells(pic, { cols: 1, rows: 1, dither: 'none', fine: false });
  const k = keysOf(fine.cells[0]);
  const keyOf = (c) => { for (const key of [0, 1, 2, 3, 4, 5, 6, 7]) { const r = rgbOf(key); if (r[0] === c[0] && r[1] === c[1] && r[2] === c[2]) return key; } return -1; };
  check('fine mode keeps every row\'s own pair exactly (8 different pairs in one cell)', k.every((key, i) => key === keyOf((i & 7) < 4 ? A[i >> 3] : B[i >> 3])), k.join(''));
  check('a normal cell has one pair for all rows, so it cannot', new Set(keysOf(norm.cells[0])).size === 2);
  const r = PI.buildTiles(fine);
  const t = r.tiles[0];
  check('the tile carries rowColours and row 0 as its own colours', !!t.rowColours && t.rowColours.length === 8 && t.ink === t.rowColours[0].ink && t.paper === t.rowColours[0].paper && T.hasRowColours(t) && T.validateTileset({ tiles: r.tiles }) === null);
  check('and draws (per row) the picture', JSON.stringify(Array.from(T.tilePixels(t, { fine: true }))) === JSON.stringify(k));
  // fine-colour rows with the colours of different brightness
  const mixed = picture(8, 8, (x, y) => (y < 4 ? (x < 4 ? RED : BLUE) : (x < 4 ? BRED : BWHITE)));
  const fm = keysOf(PI.quantizeToCells(mixed, { cols: 1, rows: 1, dither: 'none', fine: true }).cells[0]);
  check('fine rows may differ in BRIGHT (normal above, bright below)', fm[0] === 2 && fm[7] === 1 && fm[32] === 10 && fm[39] === 15, [fm[0], fm[7], fm[32], fm[39]].join());
  // a fine picture of 6 identical coloured rows merges
  const strip = picture(64, 8, (x, y) => (y < 4 ? RED : BLUE));
  const rs = PI.buildTiles(PI.quantizeToCells(strip, { cols: 8, rows: 1, dither: 'none', fine: true }));
  check('equal fine cells merge (8 sky stripes: 1 tile)', rs.tiles.length === 1 && rs.merged === 7);
}

// ── 6: black, transparency, scaling ─────────────────────────────────────────────────────────────────────────
console.log('6  the two-blacks rule, transparency, scaling');
{
  // bright white next to black: the BRIGHT pair may not contain black, so the cell uses normal white (204) and black at BRIGHT 0
  const wb = picture(8, 8, (x) => (x < 4 ? BWHITE : BLACK));
  const g = PI.quantizeToCells(wb, { cols: 1, rows: 1, dither: 'none' });
  const c = g.cells[0];
  check('bright white with black: black is kept with BRIGHT 0 (white goes normal); no BRIGHT black anywhere', c.rows.every((r) => r.bright === 0) && !keysOf(c).includes(8) && keysOf(c).includes(0), keysOf(c).slice(0, 8).join());
  const wb1 = PI.quantizeToCells(wb, { cols: 1, rows: 1, dither: 'none', brightBlack: true }).cells[0];
  check('with brightBlack allowed the same cell keeps bright white with black', wb1.rows[0].bright === 1 && keysOf(wb1).includes(15));
  const dark = picture(16, 8, () => BLACK);
  const gd = PI.buildTiles(PI.quantizeToCells(dark, { cols: 2, rows: 1 }));
  check('a flat black cell is paper 0, BRIGHT 0, bits clear', gd.tiles.length === 1 && gd.tiles[0].paper === 0 && gd.tiles[0].bright === 0 && gd.tiles[0].bits.every((b) => b === 0));
  // dark bright colours: bright red on black becomes red on black
  const rb = PI.quantizeToCells(picture(8, 8, (x) => (x < 4 ? BRED : BLACK)), { cols: 1, rows: 1, dither: 'none' }).cells[0];
  check('bright red on black becomes plain red on black, BRIGHT 0', rb.rows[0].bright === 0 && new Set(keysOf(rb)).size === 2 && keysOf(rb).includes(2) && keysOf(rb).includes(0));
  // the brightness lock
  const lock0 = PI.quantizeToCells(picture(8, 8, () => BRED), { cols: 1, rows: 1, dither: 'none', bright: 0 }).cells[0];
  check('bright: 0 never uses a BRIGHT colour', lock0.rows[0].bright === 0 && keysOf(lock0).every((k) => k < 8));

  // transparency
  const half = picture(16, 8, (x) => (x < 8 ? [255, 0, 0, 0] : [0, 0, 255, 255]));
  const gt = PI.quantizeToCells(half, { cols: 2, rows: 1 }), rt = PI.buildTiles(gt);
  check('a cell with no opaque pixel is blank: no tile, map value 255; the other cell is a tile', gt.cells[0].blank && !gt.cells[1].blank && rt.tiles.length === 1 && Array.from(rt.map).join() === '255,0' && rt.blankCells === 1);
  const gt2 = PI.quantizeToCells(half, { cols: 2, rows: 1, transparentCells: false });
  check('transparentCells: false keeps it as a (black) tile', !gt2.cells[0].blank && PI.buildTiles(gt2).tiles.length === 2);

  // scaling to the grid
  const wide = picture(512, 192, (x) => (x < 256 ? RED : BLUE));                // 8:3, twice as wide as the box
  const st = PI.quantizeToCells(wide, { cols: 32, rows: 24, dither: 'none', fit: 'stretch' });
  check('stretch: the whole picture over the whole screen (left half red, right half blue)', keysOf(st.cells[0])[0] === 2 && keysOf(st.cells[31])[0] === 1 && keysOf(st.cells[15])[0] === 2 && keysOf(st.cells[16])[0] === 1);
  const ft = PI.quantizeToCells(wide, { cols: 32, rows: 24, dither: 'none', fit: 'fit' });
  const mid = (cx, cy) => keysOf(ft.cells[cy * 32 + cx])[0];
  check('fit: the whole picture, aspect kept, black bars above and below', ft.cells[0].keys.every((k) => k === 0) && mid(0, 12) === 2 && mid(31, 12) === 1 && ft.cells[23 * 32].keys.every((k) => k === 0));
  const cr = PI.quantizeToCells(wide, { cols: 32, rows: 24, dither: 'none', fit: 'crop' });
  check('crop: the box filled, the edges cut (the middle stays: red | blue meet at column 16)', keysOf(cr.cells[0])[0] === 2 && keysOf(cr.cells[31])[0] === 1 && cr.cells.every((c) => !c.keys.some((k) => k === 0)));
  let threw = false; try { PI.quantizeToCells({ width: 0, height: 0, data: [] }, {}); } catch (e) { threw = /empty or damaged/.test(e.message); }
  check('an empty picture is refused with a plain message', threw);
  threw = false; try { PI.quantizeToCells(picture(8, 8, () => RED), { cols: 65, rows: 1 }); } catch (e) { threw = e instanceof RangeError; }
  check('a grid wider than 64 cells is refused', threw);
}

// ── 7: valid output, asset check silent ─────────────────────────────────────────────────────────────────────
console.log('7  valid output');
{
  // a picture with a smooth gradient, hard edges, black and colour, to make many distinct cells
  const rnd = rng(11);
  const scene = picture(256, 192, (x, y) => {
    if (y < 64) return [Math.min(255, x), Math.min(255, y * 3), 255 - x];                   // a sky gradient
    if (y < 120) return ((x >> 4) + (y >> 4)) & 1 ? YELLOW : GREEN;                         // big checks
    if (y < 150) return [rnd(), rnd(), rnd()];                                              // noise: a lot of distinct cells
    return x > 100 && x < 150 ? WHITE : BLACK;                                              // black ground
  });
  for (const dither of ['none', 'ordered', 'diffusion']) for (const fine of [false, true]) {
    const label = `${dither}${fine ? ', fine' : ''}`;
    const out = PI.pictureToAssets(scene, { dither, fine, foreground: true, tilesetName: 'pic' });
    const bad = T.validateAsset(out.tileset);
    check(`(${label}) the tile set passes tile-model.validateAsset and has at most 128 tiles`, bad === null && out.tileset.tiles.length <= 128, bad ?? `${out.tileset.tiles.length} tiles`);
    const m = M.fromAsset(out.map);
    check(`(${label}) the map passes map-model validation as a cell map with the tile set's tile count`, M.validateMap(m, 'cell', { tileCount: out.tileset.tiles.length }).length === 0 && m.w === 32 && m.h === 24);
    const project = { format: 1, name: 'p', files: { 'main.arc': '' }, assets: { sprites: {}, tilesets: { pic: out.tileset }, maps: { title: out.map }, sfx: {}, music: {} }, scenes: fine ? { main: { display: 'fine' } } : {} };
    check(`(${label}) arcade-project accepts both assets`, P.validateAsset('tilesets', out.tileset) === null && P.validateAsset('maps', out.map) === null, String(P.validateAsset('tilesets', out.tileset) ?? P.validateAsset('maps', out.map)));
    const roles = { tileset: 'pic', maps: { TITLE: 'title' }, world: null, worlds: [], floorplans: [], scenes: fine ? ['main'] : [], view: null };
    const found = checkAssets(project, roles).map((w) => w.id);
    check(`(${label}) the asset check says nothing about the set or the map`, found.length === 0, found.join());
  }
  // without foreground the map check names the colour mix (a picture has many attributes): that is the foreground mark's job
  const plain = PI.pictureToAssets(scene, { dither: 'none' });
  const pj = { format: 1, name: 'p', files: {}, assets: { sprites: {}, tilesets: { pic: plain.tileset }, maps: { title: plain.map }, sfx: {}, music: {} }, scenes: {} };
  const ids = checkAssets(pj, { tileset: 'pic', maps: { TITLE: 'title' }, worlds: [], floorplans: [], scenes: [], world: null, view: null }).map((w) => w.id);
  check('without the foreground mark only background-attr-mix is said (and no black warning)', ids.every((id) => id === 'background-attr-mix'), ids.join());
  // append result: valid when written back
  const base = { tiles: [T.newTile(), (() => { const t = T.newTile({ ink: 2, paper: 6, bright: 0 }); t.bits = [1, 2, 3, 4, 5, 6, 7, 8]; return t; })()], tilesKey: 'tiles' };
  const ap = PI.pictureToAssets(scene, { dither: 'none', existing: base, foreground: true });
  check('appended: the set keeps its first tiles and stays valid; the map numbers start after them', T.validateAsset(ap.tileset) === null && ap.tileset.tiles.length === 2 + ap.result.tiles.length && ap.result.base === 2 && Math.min(...ap.result.map) >= 0 && ap.tileset.tiles.length <= 128);
  const asm = (new Set(Array.from(ap.result.map)));
  check('(the number of every cell is a tile of the combined set)', [...asm].every((v) => v === 255 || v < ap.tileset.tiles.length));
  // tile 0 of an import is the first cell's picture (a title screen may start with any)
  check('the foreground mark is written (fg: true) on the imported tiles only', ap.tileset.tiles.slice(2).every((t) => t.fg === true) && ap.tileset.tiles[0].fg === undefined);
}

// ── 8: PNG export sheet ─────────────────────────────────────────────────────────────────────────────────────
console.log('8  the export sheet');
{
  const set = { tiles: [], tilesKey: 'tiles' };
  for (let i = 0; i < 20; i++) { const t = T.newTile({ ink: 1 + (i % 7), paper: (i * 3) % 8, bright: i % 2 }); t.bits = [i, 255 - i, 0x55, 0xAA, i * 3 & 255, 1, 2, 4]; set.tiles.push(t); }
  const fineTile = T.newTile({ ink: 2, paper: 1, bright: 0 }); fineTile.bits = [0xF0, 0xF0, 0xF0, 0xF0, 0xF0, 0xF0, 0xF0, 0xF0]; T.setColours(fineTile, { ink: 4, paper: 6, bright: 1 }, [5, 6, 7]); set.tiles[3] = fineTile;
  const sheet = PI.tilesetToRGBA(set);
  check('a 20-tile set is a sheet 16 tiles wide: 128 x 16 pixels, RGBA', sheet.width === 128 && sheet.height === 16 && sheet.data.length === 128 * 16 * 4 && sheet.cols === 16 && sheet.rows === 2);
  const pixelAt = (x, y) => Array.from(sheet.data.slice((y * sheet.width + x) * 4, (y * sheet.width + x) * 4 + 4));
  const keyAt = (t, x, y) => T.tilePixels(set.tiles[t], { fine: true })[y * 8 + x];
  let same = true;
  for (let t = 0; t < 20; t++) for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) {
    const p = pixelAt((t % 16) * 8 + x, ((t / 16) | 0) * 8 + y), w = rgbOf(keyAt(t, x, y));
    if (p[0] !== w[0] || p[1] !== w[1] || p[2] !== w[2] || p[3] !== 255) same = false;
  }
  check('every pixel of every tile is its colour (the fine tile\'s rows 5..7 in their own colours)', same);
  check('the cells after the last tile are transparent', pixelAt(8 * 8 + 3, 8 + 3)[3] === 0 && pixelAt(127, 15)[3] === 0);
  check('a smaller set is as wide as it is (3 tiles: 24 x 8); the scale option multiplies', PI.tilesetToRGBA({ tiles: set.tiles.slice(0, 3) }).width === 24 && PI.tilesetToRGBA({ tiles: set.tiles.slice(0, 3) }, { scale: 4 }).width === 96 && PI.tilesetToRGBA({ tiles: set.tiles.slice(0, 3) }, { scale: 4 }).height === 32);
  // the round trip: import the sheet (no dither, transparent cells skipped) and get the same pictures back, the same numbers
  const back = PI.buildTiles(PI.quantizeToCells(sheet, { cols: 16, rows: 2, dither: 'none', fine: true, brightBlack: true }));
  const want = set.tiles.map((t) => Array.from(T.tilePixels(t, { fine: true })).join());
  const got = back.tiles.map((t) => Array.from(T.tilePixels(t, { fine: true })).join());
  const tilesBack = Array.from(back.map).slice(0, 20).map((v) => got[v]).join('|') === want.join('|');
  check('exported and imported again (no dither, fine) every one of the 20 tiles shows the same picture', tilesBack && back.blankCells === 12, `${back.blankCells} blank cells`);
}

// ── 9: speed ─────────────────────────────────────────────────────────────────────────────────────────────────
console.log('9  speed');
{
  const rnd = rng(5);
  const scene = picture(256, 192, (x, y) => [(x * 2 + rnd() / 4) & 255, (y * 3 + rnd() / 4) & 255, ((x + y) + rnd() / 8) & 255]);
  // the CPU time of the process (a loaded machine stretches the wall clock, not this); the best of three runs after a warm-up
  const cpu = () => { const u = process.cpuUsage(); return (u.user + u.system) / 1000; };
  for (const [label, opts] of [['diffusion', {}], ['ordered', { dither: 'ordered' }], ['diffusion, fine', { fine: true }]]) {
    PI.pictureToAssets(scene, { ...opts });                                  // warm up
    let best = Infinity, out;
    for (let i = 0; i < 3; i++) { const t0 = cpu(); out = PI.pictureToAssets(scene, { ...opts }); best = Math.min(best, cpu() - t0); }
    check(`256 x 192 to tiles and map (${label}) in under 300 ms (best of 3, CPU time)`, best < 300, `${best.toFixed(0)} ms, ${out.result.needed} pictures needed${out.result.overflow ? ' (reduced)' : ''}`);
  }
  const big = picture(1024, 768, (x, y) => [x & 255, y & 255, (x ^ y) & 255]);
  const t1 = cpu(); PI.quantizeToCells(big, {}); const ms2 = cpu() - t1;
  check('a 1024 x 768 picture scales to 256 x 192 and converts in under 600 ms', ms2 < 600, `${ms2.toFixed(0)} ms`);
}

// The golden table of section 10 (printed by `node tests/picture-import.mjs --print-golden`; see there).
const GOLDEN_TABLE = {
  "q noise none": "ec7013a7f4",
  "q smooth none": "0a292f6623",
  "q dark none": "cd47ed8105",
  "q alpha none": "b01b834f47",
  "q noise ordered": "f8486a8845",
  "q smooth ordered": "89e0db0fcb",
  "q dark ordered": "f897549948",
  "q alpha ordered": "f4240486eb",
  "q noise diffusion": "7d2ffebcd6",
  "q smooth diffusion": "8cae9dc8a7",
  "q dark diffusion": "cfe330cf59",
  "q alpha diffusion": "f7ce14210f",
  "q exact none": "62da8f2762",
  "q exact fine none": "9984de43e5",
  "q fine none": "5a69e75e81",
  "q dark fine none": "d02b871dd6",
  "q smooth fine none": "c1959afbe2",
  "q exact ordered": "2e5b55067c",
  "q exact fine ordered": "57fbd6f6f8",
  "q fine ordered": "5a69e75e81",
  "q dark fine ordered": "abf4833ea5",
  "q smooth fine ordered": "0e74949b47",
  "q exact diffusion": "14aa2211f8",
  "q exact fine diffusion": "5d6216020f",
  "q fine diffusion": "5a69e75e81",
  "q dark fine diffusion": "4ed0b7cb46",
  "q smooth fine diffusion": "d3595f430d",
  "q big stretch none": "1cd87a00c5",
  "q big stretch diffusion": "00979d28f6",
  "q wide stretch none": "d9ccf3cbd0",
  "q wide stretch diffusion": "c7ccbbc0c8",
  "q tall stretch none": "be0a999abe",
  "q tall stretch diffusion": "5ea1453f1c",
  "q alpha stretch none": "8109a894b7",
  "q alpha stretch diffusion": "970e747cc9",
  "q big fit none": "f9e58c4778",
  "q big fit diffusion": "64ce836f70",
  "q wide fit none": "cf39feb819",
  "q wide fit diffusion": "915f847451",
  "q tall fit none": "5eb1b00ff0",
  "q tall fit diffusion": "d0a7f5f4a5",
  "q alpha fit none": "f5ebcd3c9d",
  "q alpha fit diffusion": "3d0ed7e44c",
  "q big crop none": "97a56c5656",
  "q big crop diffusion": "c3198cefa5",
  "q wide crop none": "07ae1dcb47",
  "q wide crop diffusion": "5eee2f397e",
  "q tall crop none": "0fa6509021",
  "q tall crop diffusion": "033ac7dd07",
  "q alpha crop none": "1e50e3ab9c",
  "q alpha crop diffusion": "3bffb60141",
  "q dark bright undefined bb false": "ecdedb2817",
  "q smooth bright undefined bb false": "e9d98ad635",
  "q noise bright undefined bb false": "ee89a797b5",
  "q dark bright undefined bb true": "781d9d491e",
  "q smooth bright undefined bb true": "e8c774030d",
  "q noise bright undefined bb true": "a5c924531e",
  "q dark bright 0 bb false": "ecdedb2817",
  "q smooth bright 0 bb false": "50659cb291",
  "q noise bright 0 bb false": "ee89a797b5",
  "q dark bright 0 bb true": "ecdedb2817",
  "q smooth bright 0 bb true": "50659cb291",
  "q noise bright 0 bb true": "ee89a797b5",
  "q dark bright 1 bb false": "95f7984fdc",
  "q smooth bright 1 bb false": "dd04a039c1",
  "q noise bright 1 bb false": "bee47b4af3",
  "q dark bright 1 bb true": "94b852c17a",
  "q smooth bright 1 bb true": "7bc4b7ec85",
  "q noise bright 1 bb true": "f8e5e992fc",
  "q dark none bb false": "f78e30fbd2",
  "q dark none bb true": "f78e30fbd2",
  "q alpha thr 40": "7e7ed09556",
  "q alpha thr 128": "ea3dcb5c1c",
  "q alpha thr 129": "b60b49b47a",
  "q alpha thr 255": "b60b49b47a",
  "q alpha solid": "caaaf51da8",
  "q alphaN solid": "20144ff3a5",
  "q alphaN": "20144ff3a5",
  "q alphaN fine": "5f33e2c0ca",
  "q alpha exact size": "ea3dcb5c1c",
  "q alphaN exact size": "0c9e37ddbb",
  "q noise palette": "e4759cae95",
  "q smooth palette none": "a88c3d81f0",
  "q one": "f725fee7f0",
  "q one none": "c9deaa6022",
  "q big default": "0adfe7abdd",
  "q smooth default grid": "7cce22ef80",
  "q noise 1x1": "3027b7b758",
  "q noise 64 x 2": "bf893d61cb",
  "q noise 2 x 64": "17c0d0a76f",
  "b noise plain": "c49b0b5201",
  "d noise plain": "55920063a0",
  "b noise fg": "1ceb517d3b",
  "d noise fg": "55920063a0",
  "b noise max 16": "045e8308e2",
  "d noise max 16": "ba05942b29",
  "b noise max 4": "eacd078b39",
  "d noise max 4": "3e1fb03031",
  "b noise max 1": "347a03f38d",
  "d noise max 1": "2c33d6eaa1",
  "b noise max 2 fg": "d2cc4e736c",
  "d noise max 2 fg": "3f28b2c9a9",
  "b noise palette": "db5d2edd62",
  "d noise palette": "42b1351b7f",
  "b dark plain": "fe5ea9aae7",
  "d dark plain": "443a326dc0",
  "b dark fg": "86235f931b",
  "d dark fg": "443a326dc0",
  "b dark max 16": "57daa47b63",
  "d dark max 16": "443a326dc0",
  "b dark max 4": "5f42b010ed",
  "d dark max 4": "204857b2f9",
  "b dark max 1": "738165b6ec",
  "d dark max 1": "391401cae3",
  "b dark max 2 fg": "fc550e0187",
  "d dark max 2 fg": "8dcd463a3d",
  "b dark palette": "047f92c6aa",
  "d dark palette": "443a326dc0",
  "b alpha plain": "7b4a6ddeda",
  "d alpha plain": "2444cd5048",
  "b alpha fg": "ac17fb6b88",
  "d alpha fg": "2444cd5048",
  "b alpha max 16": "ae04904be3",
  "d alpha max 16": "2444cd5048",
  "b alpha max 4": "accb49c381",
  "d alpha max 4": "f580c39fef",
  "b alpha max 1": "cc1a1f3fcf",
  "d alpha max 1": "353d9285e8",
  "b alpha max 2 fg": "f38483453b",
  "d alpha max 2 fg": "e5576b5805",
  "b alpha palette": "3c898e9676",
  "d alpha palette": "d313814fb7",
  "b fine plain": "d9d02a8494",
  "d fine plain": "ba51a7abf0",
  "b fine fg": "53474644ee",
  "d fine fg": "ba51a7abf0",
  "b fine max 16": "4727ae3a21",
  "d fine max 16": "ba51a7abf0",
  "b fine max 4": "4a8989fdc3",
  "d fine max 4": "07991ad717",
  "b fine max 1": "c316fa88cb",
  "d fine max 1": "247df4150a",
  "b fine max 2 fg": "24dd2f5d9e",
  "d fine max 2 fg": "d8c3610a63",
  "b fine palette": "21f2863320",
  "d fine palette": "ba51a7abf0",
  "b big plain": "22ca535f9f",
  "d big plain": "6fe1958b62",
  "b big fg": "b6a66d138b",
  "d big fg": "6fe1958b62",
  "b big max 16": "da1f27f414",
  "d big max 16": "329a25f3d3",
  "b big max 4": "3501d95a30",
  "d big max 4": "7ccc65ab13",
  "b big max 1": "1da4851e3b",
  "d big max 1": "786f5962d3",
  "b big max 2 fg": "069eac44ab",
  "d big max 2 fg": "d58cb8f401",
  "b big palette": "1021832b41",
  "d big palette": "b12ab1b7df",
  "b flat plain": "40b593ab69",
  "d flat plain": "0525b69335",
  "b flat fg": "51c4373028",
  "d flat fg": "0525b69335",
  "b flat max 16": "1b68e39342",
  "d flat max 16": "0525b69335",
  "b flat max 4": "d00ce160fb",
  "d flat max 4": "0525b69335",
  "b flat max 1": "c9d71e1458",
  "d flat max 1": "39f8f8a468",
  "b flat max 2 fg": "0ab48d9bb0",
  "d flat max 2 fg": "0525b69335",
  "b flat palette": "f0b3a8a7ba",
  "d flat palette": "0525b69335",
  "e none noise": "c49b0b5201",
  "ed none noise": "55920063a0",
  "ro none": "128",
  "e none dark": "fe5ea9aae7",
  "ed none dark": "443a326dc0",
  "e none big": "22ca535f9f",
  "ed none big": "6fe1958b62",
  "e none fine": "d9d02a8494",
  "ed none fine": "ba51a7abf0",
  "e own noise": "f92f3e08af",
  "ed own noise": "0c563145d7",
  "ro own": "122",
  "e own dark": "bc86811b4b",
  "ed own dark": "443a326dc0",
  "e own big": "8bf9413e0d",
  "ed own big": "6b90d8f480",
  "e own fine": "8d88dacffc",
  "ed own fine": "ba51a7abf0",
  "e own flags noise": "118b6a8a24",
  "ed own flags noise": "6cde52cb02",
  "ro own flags": "120",
  "e own flags dark": "ed6aaf142e",
  "ed own flags dark": "443a326dc0",
  "e own flags big": "6e64a110f2",
  "ed own flags big": "812c64f93b",
  "e own flags fine": "8fb42f8670",
  "ed own flags fine": "ba51a7abf0",
  "e own fg noise": "118b6a8a24",
  "ed own fg noise": "6cde52cb02",
  "ro own fg": "120",
  "e own fg dark": "ed6aaf142e",
  "ed own fg dark": "443a326dc0",
  "e own fg big": "6e64a110f2",
  "ed own fg big": "812c64f93b",
  "e own fg fine": "8fb42f8670",
  "ed own fg fine": "ba51a7abf0",
  "e unrelated 3 noise": "f6896323b1",
  "ed unrelated 3 noise": "55920063a0",
  "ro unrelated 3": "125",
  "e unrelated 3 dark": "2d20c4d9cc",
  "ed unrelated 3 dark": "443a326dc0",
  "e unrelated 3 big": "8b95ce2512",
  "ed unrelated 3 big": "8040849e6b",
  "e unrelated 3 fine": "9f264f82c8",
  "ed unrelated 3 fine": "ba51a7abf0",
  "e unrelated 20 noise": "ecf35ceeea",
  "ed unrelated 20 noise": "55920063a0",
  "ro unrelated 20": "108",
  "e unrelated 20 dark": "bb8713c66b",
  "ed unrelated 20 dark": "443a326dc0",
  "e unrelated 20 big": "975bfe0377",
  "ed unrelated 20 big": "0263ed1338",
  "e unrelated 20 fine": "6038faa7b1",
  "ed unrelated 20 fine": "ba51a7abf0",
  "e unrelated 125 noise": "74de35f3ef",
  "ed unrelated 125 noise": "9a91c11f4f",
  "ro unrelated 125": "3",
  "e unrelated 125 dark": "d03f26e830",
  "ed unrelated 125 dark": "02b226d414",
  "e unrelated 125 big": "e9c194f982",
  "ed unrelated 125 big": "5d4f7d2ebc",
  "e unrelated 125 fine": "b4a577234c",
  "ed unrelated 125 fine": "3875b9a3b0",
  "e unrelated 128 noise": "478264157f",
  "ed unrelated 128 noise": "88f65000cf",
  "ro unrelated 128": "0",
  "e unrelated 128 dark": "5b380a7a81",
  "ed unrelated 128 dark": "c96392dd70",
  "e unrelated 128 big": "7bbaba5a85",
  "ed unrelated 128 big": "8c050c1ab7",
  "e unrelated 128 fine": "2da29a1e5a",
  "ed unrelated 128 fine": "00545f79b6",
  "e unrelated 126 fg noise": "1514e2576b",
  "ed unrelated 126 fg noise": "1c2cfbfbaa",
  "ro unrelated 126 fg": "2",
  "e unrelated 126 fg dark": "365c6ed9c7",
  "ed unrelated 126 fg dark": "81bcf1fa9c",
  "e unrelated 126 fg big": "70c203467f",
  "ed unrelated 126 fg big": "86e89e1b7e",
  "e unrelated 126 fg fine": "430932a325",
  "ed unrelated 126 fg fine": "220468fdac",
  "e max 10 noise": "27e2c0bb78",
  "e max 3 below base": "e4d9a627d6",
  "a plain": "4d5d79817c",
  "a named": "3367663ac8",
  "a existing": "a981a85af8",
  "a fine": "0eece7fc49",
  "a over": "05fae908cd",
  "a nonstring": "a234db26f8",
  "m plain": "3c182ec224",
  "m blank": "943b5cab3d",
  "m small": "f0b7fb693d",
  "s default": "033d0ed028",
  "s cols 4": "3a069551fd",
  "s cols 100": "033d0ed028",
  "s scale 3": "64a9737335",
  "s scale 2.9": "fae5e99f0c",
  "s scale 0": "033d0ed028",
  "s no fine": "79bb1ce511",
  "s palette": "191d7a5287",
  "s cols 5 scale 2 palette": "50786bbb33",
  "s cols 1": "0db5d0562d",
  "s cols 0": "0db5d0562d",
  "s empty": "6fd58ea279",
  "s one": "f76d335497",
  "t one tile": "10 cells became 1 new tile.",
  "t two tiles": "10 cells became 2 new tiles.",
  "t zero tiles": "10 cells became 0 new tiles.",
  "t reused 1": "10 cells became 1 new tile; 1 cell uses a tile the set already has.",
  "t reused 3": "10 cells became 1 new tile; 3 cells use a tile the set already has.",
  "t merged 1": "10 cells became 1 new tile; 1 repeated cell merged.",
  "t merged 5": "10 cells became 1 new tile; 5 repeated cells merged.",
  "t blank 1": "9 cells became 1 new tile; 1 transparent cell left blank.",
  "t blank 4": "6 cells became 1 new tile; 4 transparent cells left blank.",
  "t all": "8 cells became 3 new tiles; 2 cells use a tile the set already has; 4 repeated cells merged; 2 transparent cells left blank.",
  "t over": "10 cells became 1 new tile. It needs 200 tiles but the limit is 128: 50 cells (72 pictures) now use the nearest tile by colour.",
  "t over 1": "10 cells became 1 new tile. It needs 129 tiles but the limit is 128: 1 cell (1 picture) now use the nearest tile by colour.",
  "t over all": "9 cells became 4 new tiles; 1 cell uses a tile the set already has; 2 repeated cells merged; 1 transparent cell left blank. It needs 300 tiles but the limit is 64: 7 cells (2 pictures) now use the nearest tile by colour.",
  "x stripes none": "18d1c6ec3b",
  "xb stripes none": "a59a0fadf3",
  "xd stripes none": "637d0a55c5",
  "x stripes fine none": "c33b5b075a",
  "xb stripes fine none": "b52f2203cc",
  "xd stripes fine none": "637d0a55c5",
  "x stripes2 none": "d48d55dc14",
  "xb stripes2 none": "9c99d958e2",
  "xd stripes2 none": "cac98d3d08",
  "x stripes2 fine none": "ebc896a4f8",
  "xb stripes2 fine none": "71f5f79cf3",
  "xd stripes2 fine none": "cac98d3d08",
  "x share none": "0fc61dd69f",
  "xb share none": "2f44d7083b",
  "xd share none": "618e657838",
  "x shareB none": "0bd3f1a990",
  "xb shareB none": "09f2bf7e1a",
  "xd shareB none": "618e657838",
  "x shareB bb none": "0bd3f1a990",
  "xb shareB bb none": "09f2bf7e1a",
  "xd shareB bb none": "618e657838",
  "x brightApart none": "9a35f4daf4",
  "xb brightApart none": "c36d153f06",
  "xd brightApart none": "3bba70fd95",
  "x brightApart fine none": "82e296821e",
  "xb brightApart fine none": "44ae8578bb",
  "xd brightApart fine none": "3bba70fd95",
  "x lastPixel none": "7016c8e80b",
  "xb lastPixel none": "ee7aa41ff4",
  "xd lastPixel none": "060f8f92e5",
  "x firstPixel none": "d0ac64460d",
  "xb firstPixel none": "4bae108477",
  "xd firstPixel none": "060f8f92e5",
  "x dots none": "d11658013e",
  "xb dots none": "f5fb0f5b63",
  "xd dots none": "6bfa02d4a1",
  "x dots solid none": "6d1bd27f21",
  "xb dots solid none": "fef63da115",
  "xd dots solid none": "060f8f92e5",
  "x dots thr 1 none": "d11658013e",
  "xb dots thr 1 none": "f5fb0f5b63",
  "xd dots thr 1 none": "6bfa02d4a1",
  "x tie pal none": "1c32fa037c",
  "xb tie pal none": "348cee5cfe",
  "xd tie pal none": "618e657838",
  "x stripes ordered": "4210aac41a",
  "xb stripes ordered": "17b129d003",
  "xd stripes ordered": "637d0a55c5",
  "x stripes fine ordered": "c33b5b075a",
  "xb stripes fine ordered": "b52f2203cc",
  "xd stripes fine ordered": "637d0a55c5",
  "x stripes2 ordered": "51fb0f5375",
  "xb stripes2 ordered": "255ced1b24",
  "xd stripes2 ordered": "cac98d3d08",
  "x stripes2 fine ordered": "ebc896a4f8",
  "xb stripes2 fine ordered": "71f5f79cf3",
  "xd stripes2 fine ordered": "cac98d3d08",
  "x share ordered": "0fc61dd69f",
  "xb share ordered": "2f44d7083b",
  "xd share ordered": "618e657838",
  "x shareB ordered": "296ced9133",
  "xb shareB ordered": "73190dd245",
  "xd shareB ordered": "618e657838",
  "x shareB bb ordered": "296ced9133",
  "xb shareB bb ordered": "73190dd245",
  "xd shareB bb ordered": "618e657838",
  "x brightApart ordered": "9a35f4daf4",
  "xb brightApart ordered": "c36d153f06",
  "xd brightApart ordered": "3bba70fd95",
  "x brightApart fine ordered": "82e296821e",
  "xb brightApart fine ordered": "44ae8578bb",
  "xd brightApart fine ordered": "3bba70fd95",
  "x lastPixel ordered": "7016c8e80b",
  "xb lastPixel ordered": "ee7aa41ff4",
  "xd lastPixel ordered": "060f8f92e5",
  "x firstPixel ordered": "d0ac64460d",
  "xb firstPixel ordered": "4bae108477",
  "xd firstPixel ordered": "060f8f92e5",
  "x dots ordered": "d11658013e",
  "xb dots ordered": "f5fb0f5b63",
  "xd dots ordered": "6bfa02d4a1",
  "x dots solid ordered": "6d1bd27f21",
  "xb dots solid ordered": "fef63da115",
  "xd dots solid ordered": "060f8f92e5",
  "x dots thr 1 ordered": "d11658013e",
  "xb dots thr 1 ordered": "f5fb0f5b63",
  "xd dots thr 1 ordered": "6bfa02d4a1",
  "x tie pal ordered": "1c32fa037c",
  "xb tie pal ordered": "348cee5cfe",
  "xd tie pal ordered": "618e657838",
  "x stripes diffusion": "2492a085af",
  "xb stripes diffusion": "2feb319454",
  "xd stripes diffusion": "637d0a55c5",
  "x stripes fine diffusion": "c33b5b075a",
  "xb stripes fine diffusion": "b52f2203cc",
  "xd stripes fine diffusion": "637d0a55c5",
  "x stripes2 diffusion": "9a8acf1142",
  "xb stripes2 diffusion": "f4b21ab3de",
  "xd stripes2 diffusion": "cac98d3d08",
  "x stripes2 fine diffusion": "ebc896a4f8",
  "xb stripes2 fine diffusion": "71f5f79cf3",
  "xd stripes2 fine diffusion": "cac98d3d08",
  "x share diffusion": "0fc61dd69f",
  "xb share diffusion": "2f44d7083b",
  "xd share diffusion": "618e657838",
  "x shareB diffusion": "aeb5cf23c8",
  "xb shareB diffusion": "ea8d42aa17",
  "xd shareB diffusion": "618e657838",
  "x shareB bb diffusion": "aeb5cf23c8",
  "xb shareB bb diffusion": "ea8d42aa17",
  "xd shareB bb diffusion": "618e657838",
  "x brightApart diffusion": "9a35f4daf4",
  "xb brightApart diffusion": "c36d153f06",
  "xd brightApart diffusion": "3bba70fd95",
  "x brightApart fine diffusion": "82e296821e",
  "xb brightApart fine diffusion": "44ae8578bb",
  "xd brightApart fine diffusion": "3bba70fd95",
  "x lastPixel diffusion": "7016c8e80b",
  "xb lastPixel diffusion": "ee7aa41ff4",
  "xd lastPixel diffusion": "060f8f92e5",
  "x firstPixel diffusion": "d0ac64460d",
  "xb firstPixel diffusion": "4bae108477",
  "xd firstPixel diffusion": "060f8f92e5",
  "x dots diffusion": "d11658013e",
  "xb dots diffusion": "f5fb0f5b63",
  "xd dots diffusion": "6bfa02d4a1",
  "x dots solid diffusion": "6d1bd27f21",
  "xb dots solid diffusion": "fef63da115",
  "xd dots solid diffusion": "060f8f92e5",
  "x dots thr 1 diffusion": "d11658013e",
  "xb dots thr 1 diffusion": "f5fb0f5b63",
  "xd dots thr 1 diffusion": "6bfa02d4a1",
  "x tie pal diffusion": "1c32fa037c",
  "xb tie pal diffusion": "348cee5cfe",
  "xd tie pal diffusion": "618e657838",
  "l line none": "3640440192",
  "lb line none": "cb40e6176c",
  "l line fine none": "b1efc7010a",
  "lb line fine none": "ea115824ea",
  "l line ordered": "3640440192",
  "lb line ordered": "cb40e6176c",
  "l line fine ordered": "b1efc7010a",
  "lb line fine ordered": "ea115824ea",
  "l line diffusion": "3640440192",
  "lb line diffusion": "cb40e6176c",
  "l line fine diffusion": "b1efc7010a",
  "lb line fine diffusion": "ea115824ea",
  "br none": "e7341e8aef",
  "brb none": "4e11dac9f6",
  "brt none": "62aaa57bcc",
  "br diffusion": "e7341e8aef",
  "brb diffusion": "4e11dac9f6",
  "brt diffusion": "62aaa57bcc",
  "rc fine reuse": "8c111f5a81",
  "rcg fine reuse": "125c7b8966",
  "rc plain reuse": "8c111f5a81",
  "rcg plain reuse": "a1d67f86da",
  "rc fine reuse rc second": "88818fb592",
  "rcg fine reuse rc second": "125c7b8966",
  "rc plain reuse rc second": "d5c2f8e443",
  "rcg plain reuse rc second": "a1d67f86da",
  "rc fine nearest": "cfa5d9e22a",
  "rcg fine nearest": "33ef0ce5cb",
  "rc plain nearest": "b86820465b",
  "rcg plain nearest": "3e53d91ebe",
  "rc fine nearest first": "b86820465b",
  "rcg fine nearest first": "33ef0ce5cb",
  "rc plain nearest second": "b86820465b",
  "rcg plain nearest second": "3e53d91ebe",
  "e2 flat own flat": "18e803d6d9",
  "e2d flat own flat": "6072391205",
  "e2 flat own fine": "f5ea856fcd",
  "e2d flat own fine": "ba51a7abf0",
  "e2 flat own noise": "e6fd86f11f",
  "e2d flat own noise": "55920063a0",
  "e2 flat own stripes fine": "7bd26600bb",
  "e2d flat own stripes fine": "637d0a55c5",
  "e2 flat own stripes": "72e61e62fb",
  "e2d flat own stripes": "637d0a55c5",
  "e2 flat own brightApart": "187f29be23",
  "e2d flat own brightApart": "3bba70fd95",
  "e2 flat dup flat": "048b6ba94d",
  "e2d flat dup flat": "bd8eec820e",
  "e2 flat dup fine": "9f264f82c8",
  "e2d flat dup fine": "ba51a7abf0",
  "e2 flat dup noise": "f6896323b1",
  "e2d flat dup noise": "55920063a0",
  "e2 flat dup stripes fine": "3af33e39d9",
  "e2d flat dup stripes fine": "637d0a55c5",
  "e2 flat dup stripes": "e3bcf5d768",
  "e2d flat dup stripes": "637d0a55c5",
  "e2 flat dup brightApart": "8045828b44",
  "e2d flat dup brightApart": "3bba70fd95",
  "e2 flat two dup flat": "94eb387f5d",
  "e2d flat two dup flat": "6072391205",
  "e2 flat two dup fine": "4ea07aa33d",
  "e2d flat two dup fine": "ba51a7abf0",
  "e2 flat two dup noise": "7fa5e12d87",
  "e2d flat two dup noise": "55920063a0",
  "e2 flat two dup stripes fine": "6ded5ef62d",
  "e2d flat two dup stripes fine": "637d0a55c5",
  "e2 flat two dup stripes": "1395d01f2e",
  "e2d flat two dup stripes": "637d0a55c5",
  "e2 flat two dup brightApart": "15dfa75fc4",
  "e2d flat two dup brightApart": "3bba70fd95",
  "e2 row colours flat": "9132ef2bcf",
  "e2d row colours flat": "0525b69335",
  "e2 row colours fine": "9f264f82c8",
  "e2d row colours fine": "ba51a7abf0",
  "e2 row colours noise": "f6896323b1",
  "e2d row colours noise": "55920063a0",
  "e2 row colours stripes fine": "3af33e39d9",
  "e2d row colours stripes fine": "637d0a55c5",
  "e2 row colours stripes": "e3bcf5d768",
  "e2d row colours stripes": "637d0a55c5",
  "e2 row colours brightApart": "8045828b44",
  "e2d row colours brightApart": "3bba70fd95",
  "e2 row colours full flat": "948a118094",
  "e2d row colours full flat": "6072391205",
  "e2 row colours full fine": "81c4f77af0",
  "e2d row colours full fine": "00545f79b6",
  "e2 row colours full noise": "163bbb43f7",
  "e2d row colours full noise": "88f65000cf",
  "e2 row colours full stripes fine": "da84227574",
  "e2d row colours full stripes fine": "806ecefe11",
  "e2 row colours full stripes": "da84227574",
  "e2d row colours full stripes": "806ecefe11",
  "e2 row colours full brightApart": "41883ffc8b",
  "e2d row colours full brightApart": "0dbe25995f",
  "e3 full noise": "d8a1315b8a",
  "e3 full fine": "667727c601",
  "e3 full stripes fine": "6d423692bf",
  "e3 full flat": "c9b5a95e5f",
  "e3 full fg noise": "94eab05be2",
  "e3 full fg fine": "0be11b35d7",
  "e3 full fg stripes fine": "b6d04c17e2",
  "e3 full fg flat": "c4e60b40fa",
  "e3 rc 128 noise": "12d908b64a",
  "e3 rc 128 fine": "17866f34be",
  "e3 rc 128 stripes fine": "b6d04c17e2",
  "e3 rc 128 flat": "5444b9ae4e",
  "mfr 254": "a9ed4dc2a8",
};

// ── 10: golden digests (added with the mutation suite tests/m20-picture-mutations.mjs) ──────────────────────────────────────────────────
// A fixed set of pictures and options is run through every stage and the output is reduced to a short SHA-1. The table below was produced by this
// file itself (`node tests/picture-import.mjs --print-golden`) from the module as reviewed on 2026-11-16 (the checks above state what the engine must do; these
// pin down EXACTLY what it does today: every pixel the dither puts, every pair it picks, every merge). A deliberate change to picture-import.js changes digests: read
// the diff of the picture, then print the table again and paste it here.
console.log('10 golden digests (what the engine does today, pixel for pixel)');
{
  const { createHash } = await import('node:crypto');
  const J2 = JSON.stringify;
  const dig = (text) => createHash('sha1').update(text).digest('hex').slice(0, 10);
  const cellText = (c) => (c.blank ? 'B' : `${c.bits.join(',')}|${c.rows.map((r) => `${r.ink}${r.paper}${r.bright}`).join(' ')}|${Array.from(c.keys).join('')}`);
  const gridDigest = (g) => dig(`${g.cols}x${g.rows}${g.fine ? 'f' : ''}:${g.cells.map(cellText).join(';')}`);
  const tileText = (t) => JSON.stringify(t);
  const resultDigest = (r) => dig([r.tiles.map(tileText).join(';'), Array.from(r.map).join(','), r.base, r.cols, r.rows, r.cells, r.distinct, r.merged, r.reused, r.blankCells, r.needed, r.overflow, r.maxTiles, r.lossyTiles, r.lossyCells].join('|'));
  const lcg = (seed) => { let s = seed >>> 0; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s >>> 24; }; };
  const noiseP = (w, h, seed, a = false) => { const r = lcg(seed); return picture(w, h, () => (a ? [r(), r(), r(), r()] : [r(), r(), r()])); };
  const smoothP = (w, h) => picture(w, h, (x, y) => [Math.floor(x * 255 / Math.max(1, w - 1)), Math.floor(y * 255 / Math.max(1, h - 1)), (x * 5 + y * 3) & 255]);
  const alphaP = (w, h) => picture(w, h, (x, y) => [200 - x * 3 & 255, 40 + y * 4 & 255, 120, x < 8 ? 0 : x < 16 ? 127 : x < 24 ? 128 : y > h - 6 ? 40 : 255]);
  const darkP = (w, h) => picture(w, h, (x, y) => { const q = ((x >> 2) + (y >> 2)) % 5; return q === 0 ? [0, 0, 0] : q === 1 ? [255, 0, 0] : q === 2 ? [255, 255, 255] : q === 3 ? [30, 30, 90] : [0, 0, 200]; });
  const fineP = (w, h) => picture(w, h, (x, y) => { const row = [[255, 0, 0], [0, 0, 255], [0, 255, 0], [255, 255, 0], [255, 255, 255], [0, 0, 0], [205, 0, 205], [0, 205, 205]][y & 7]; return (x * 3 + y) % 7 < 3 ? row : [0, 0, 0]; });
  const bigP = noiseP(100, 70, 21), wideP = smoothP(90, 20), tallP = smoothP(20, 90);
  const customPal = Array.from({ length: 16 }, (_, i) => ({ name: 'c' + i, rgb: [(i * 53 + 20) & 255, (i * 97 + 60) & 255, (i * 29 + 140) & 255] }));
  const PICS = { noise: noiseP(48, 40, 1), exact: noiseP(64, 48, 2), smooth: smoothP(64, 48), alpha: alphaP(40, 32), alphaN: noiseP(32, 16, 3, true), dark: darkP(40, 24), fine: fineP(32, 16), big: bigP, wide: wideP, tall: tallP, one: picture(8, 8, () => [10, 200, 90]) };
  const cases = [];
  const add = (id, pic, opts) => cases.push([id, () => PI.quantizeToCells(PICS[pic], opts), opts]);
  // every option value, on pictures that make it matter
  for (const dither of ['none', 'ordered', 'diffusion']) for (const pic of ['noise', 'smooth', 'dark', 'alpha']) add(`q ${pic} ${dither}`, pic, { cols: 6, rows: 5, dither });
  for (const dither of ['none', 'ordered', 'diffusion']) { add(`q exact ${dither}`, 'exact', { cols: 8, rows: 6, dither }); add(`q exact fine ${dither}`, 'exact', { cols: 8, rows: 6, dither, fine: true }); add(`q fine ${dither}`, 'fine', { cols: 4, rows: 2, dither, fine: true }); add(`q dark fine ${dither}`, 'dark', { cols: 5, rows: 3, dither, fine: true }); add(`q smooth fine ${dither}`, 'smooth', { cols: 8, rows: 6, dither, fine: true }); }
  for (const fit of ['stretch', 'fit', 'crop']) for (const pic of ['big', 'wide', 'tall', 'alpha']) for (const dither of ['none', 'diffusion']) add(`q ${pic} ${fit} ${dither}`, pic, { cols: 7, rows: 6, dither, fit });
  for (const bright of [undefined, 0, 1]) for (const bb of [false, true]) for (const pic of ['dark', 'smooth', 'noise']) add(`q ${pic} bright ${bright} bb ${bb}`, pic, { cols: 5, rows: 4, bright, brightBlack: bb });
  for (const bb of [false, true]) add(`q dark none bb ${bb}`, 'dark', { cols: 5, rows: 3, dither: 'none', brightBlack: bb });
  add('q alpha thr 40', 'alpha', { cols: 5, rows: 4, alphaThreshold: 40 }); add('q alpha thr 128', 'alpha', { cols: 5, rows: 4, alphaThreshold: 128 }); add('q alpha thr 129', 'alpha', { cols: 5, rows: 4, alphaThreshold: 129 }); add('q alpha thr 255', 'alpha', { cols: 5, rows: 4, alphaThreshold: 255 });
  add('q alpha solid', 'alpha', { cols: 5, rows: 4, transparentCells: false }); add('q alphaN solid', 'alphaN', { cols: 4, rows: 2, transparentCells: false }); add('q alphaN', 'alphaN', { cols: 4, rows: 2 }); add('q alphaN fine', 'alphaN', { cols: 4, rows: 2, fine: true });
  add('q alpha exact size', 'alpha', { cols: 5, rows: 4 }); add('q alphaN exact size', 'alphaN', { cols: 4, rows: 2, dither: 'none' });
  add('q noise palette', 'noise', { cols: 6, rows: 5, palette: customPal }); add('q smooth palette none', 'smooth', { cols: 8, rows: 6, palette: customPal, dither: 'none' });
  add('q one', 'one', { cols: 1, rows: 1 }); add('q one none', 'one', { cols: 1, rows: 1, dither: 'none' }); add('q big default', 'big', {}); add('q smooth default grid', 'smooth', {});
  add('q noise 1x1', 'noise', { cols: 1, rows: 1 }); add('q noise 64 x 2', 'noise', { cols: 64, rows: 2, dither: 'none' }); add('q noise 2 x 64', 'noise', { cols: 2, rows: 64, dither: 'ordered' });
  const results = {};
  for (const [id, fn] of cases) results[id] = gridDigest(fn());
  // buildTiles on grids: limits, existing sets, the foreground mark, the palette
  const gNoise = PI.quantizeToCells(noiseP(64, 48, 7), { cols: 8, rows: 6 }), gDark = PI.quantizeToCells(darkP(40, 24), { cols: 5, rows: 3, dither: 'none' }), gAlpha = PI.quantizeToCells(alphaP(40, 32), { cols: 5, rows: 4 });
  const gFine = PI.quantizeToCells(fineP(32, 16), { cols: 4, rows: 2, dither: 'none', fine: true }), gBig = PI.quantizeToCells(noiseP(256, 192, 5), { cols: 32, rows: 24, dither: 'diffusion' }), gFlat = PI.quantizeToCells(picture(64, 32, (x) => (x < 32 ? RED : BLUE)), { cols: 8, rows: 4, dither: 'none' });
  const mkSet = (n, seed, extra = {}) => { const r = lcg(seed); return { tiles: Array.from({ length: n }, (_, i) => { const t = T.newTile({ ink: 1 + (r() % 7), paper: r() % 8, bright: r() & 1 }); t.bits = Array.from({ length: 8 }, () => r()); Object.assign(t, extra.each?.(i) ?? {}); return t; }), tilesKey: 'tiles' }; };
  const ofGrid = (gr, id) => {
    const set = (name, o) => { results[`b ${id} ${name}`] = resultDigest(PI.buildTiles(gr, o)); results[`d ${id} ${name}`] = dig(PI.describeImport(PI.buildTiles(gr, o))); };
    set('plain', {}); set('fg', { foreground: true }); set('max 16', { maxTiles: 16 }); set('max 4', { maxTiles: 4 }); set('max 1', { maxTiles: 1 }); set('max 2 fg', { maxTiles: 2, foreground: true }); set('palette', { palette: customPal, maxTiles: 6 });
  };
  ofGrid(gNoise, 'noise'); ofGrid(gDark, 'dark'); ofGrid(gAlpha, 'alpha'); ofGrid(gFine, 'fine'); ofGrid(gBig, 'big'); ofGrid(gFlat, 'flat');
  // an existing set: a picture's own tiles come back (reused), a flagged / foreground tile is not reused, a set with no room, little room, room for all
  const own = PI.buildTiles(gNoise).tiles;
  const withOwn = (extra) => ({ tiles: [...own.slice(0, 5).map((t, i) => Object.assign(T.cloneTile(t), extra(i))), ...mkSet(3, 9).tiles], tilesKey: 'tiles' });
  const ex = {
    'none': null, 'own': { tiles: own.slice(0, 6), tilesKey: 'tiles' }, 'own flags': withOwn((i) => (i % 2 ? { flags: 1 } : {})), 'own fg': withOwn((i) => (i % 2 ? { fg: true } : {})), 'unrelated 3': mkSet(3, 11), 'unrelated 20': mkSet(20, 12), 'unrelated 125': mkSet(125, 13), 'unrelated 128': mkSet(128, 14), 'unrelated 126 fg': mkSet(126, 15, { each: () => ({ fg: true }) }),
  };
  for (const [name, set] of Object.entries(ex)) for (const [gid, gr] of [['noise', gNoise], ['dark', gDark], ['big', gBig], ['fine', gFine]]) {
    const o = { existing: set ?? undefined }, r = PI.buildTiles(gr, o);
    results[`e ${name} ${gid}`] = resultDigest(r); results[`ed ${name} ${gid}`] = dig(PI.describeImport(r)); results[`ro ${name}`] = String(PI.roomIn(set ?? undefined));
  }
  results['e max 10 noise'] = resultDigest(PI.buildTiles(gNoise, { existing: mkSet(6, 21), maxTiles: 10 })); results['e max 3 below base'] = resultDigest(PI.buildTiles(gNoise, { existing: mkSet(6, 21), maxTiles: 3 }));
  // the whole path to stored assets
  for (const [id, pic, o] of [['plain', 'noise', { cols: 6, rows: 5 }], ['named', 'noise', { cols: 6, rows: 5, tilesetName: 'tiles1', foreground: true }], ['existing', 'smooth', { cols: 8, rows: 6, existing: mkSet(4, 31), tilesetName: 'ts' }], ['fine', 'fine', { cols: 4, rows: 2, fine: true, dither: 'none' }], ['over', 'big', { cols: 32, rows: 24, maxTiles: 20 }], ['nonstring', 'one', { cols: 1, rows: 1, tilesetName: 5 }]]) {
    const out = PI.pictureToAssets(PICS[pic], o);
    results[`a ${id}`] = dig(JSON.stringify({ tileset: out.tileset, map: out.map, r: resultDigest(out.result), g: gridDigest(out.grid) }));
  }
  for (const [id, r] of [['plain', PI.buildTiles(gNoise)], ['blank', PI.buildTiles(gAlpha)], ['small', PI.buildTiles(gNoise, { maxTiles: 3 })]]) results[`m ${id}`] = dig(JSON.stringify([PI.mapFromResult(r), PI.mapFromResult(r, 'ts'), PI.mapFromResult(r, 7)]));
  // the contact sheet
  const sheetSet = { tiles: [...own.slice(0, 7), ...PI.buildTiles(gFine).tiles], tilesKey: 'tiles' };
  const sheetOf = (o) => { const s = PI.tilesetToRGBA(sheetSet, o); return dig(`${s.width}x${s.height} ${s.cols}x${s.rows} ${Buffer.from(s.data).toString('base64')}`); };
  for (const [id, o] of [['default', undefined], ['cols 4', { cols: 4 }], ['cols 100', { cols: 100 }], ['scale 3', { scale: 3 }], ['scale 2.9', { scale: 2.9 }], ['scale 0', { scale: 0 }], ['no fine', { fine: false }], ['palette', { palette: customPal }], ['cols 5 scale 2 palette', { cols: 5, scale: 2, palette: customPal }], ['cols 1', { cols: 1 }], ['cols 0', { cols: 0 }]]) results[`s ${id}`] = sheetOf(o);
  results['s empty'] = dig(JSON.stringify((() => { const s = PI.tilesetToRGBA({ tiles: [] }); return [s.width, s.height, s.cols, s.rows, s.data.length]; })()));
  results['s one'] = sheetOf.call(null, { cols: 3 }) && dig(JSON.stringify((() => { const s = PI.tilesetToRGBA({ tiles: [own[0]] }, { scale: 2 }); return [s.width, s.height, s.cols, s.rows, Buffer.from(s.data).toString('base64')]; })()));
  // describeImport on hand-made results: every branch and plural
  const mkR = (o) => ({ tiles: Array.from({ length: o.nt ?? 1 }), cells: 10, blankCells: 0, reused: 0, merged: 0, overflow: false, needed: 0, maxTiles: 128, lossyCells: 0, lossyTiles: 0, ...o });
  for (const [id, o] of [['one tile', { nt: 1 }], ['two tiles', { nt: 2 }], ['zero tiles', { nt: 0 }], ['reused 1', { reused: 1 }], ['reused 3', { reused: 3 }], ['merged 1', { merged: 1 }], ['merged 5', { merged: 5 }], ['blank 1', { blankCells: 1 }], ['blank 4', { blankCells: 4 }], ['all', { nt: 3, reused: 2, merged: 4, blankCells: 2 }],
    ['over', { overflow: true, needed: 200, maxTiles: 128, lossyCells: 50, lossyTiles: 72 }], ['over 1', { overflow: true, needed: 129, maxTiles: 128, lossyCells: 1, lossyTiles: 1 }], ['over all', { nt: 4, reused: 1, merged: 2, blankCells: 1, overflow: true, needed: 300, maxTiles: 64, lossyCells: 7, lossyTiles: 2 }]]) results[`t ${id}`] = PI.describeImport(mkR(o));
  // pictures made of exact palette colours: ties, flat rows, rows that share an ink or a paper, BRIGHT apart, one-pixel differences
  const PAL = [BLACK, BLUE, RED, rgbOf(3), GREEN, rgbOf(5), YELLOW, WHITE, BLACK, rgbOf(9), BRED, rgbOf(11), rgbOf(12), rgbOf(13), rgbOf(14), BWHITE];
  const stripes = picture(32, 8, (x, y) => PAL[[2, 0, 15, 10, 7, 1, 6, 4][y]]);                     // one flat colour a row (black, bright white, bright red among them)
  const stripes2 = picture(32, 8, (x, y) => PAL[[8 + 2, 3, 7, 0, 12, 14, 9, 5][(y + (x >> 3)) & 7]]);
  const share = picture(8, 8, (x, y) => (x < 3 ? RED : ((y & 1) ? BLUE : GREEN)));               // ink red on rows with paper blue / green: rows differ in the paper only
  const shareB = picture(8, 8, (x, y) => (x < 3 ? RED : (y < 4 ? BLUE : BRED)));                    // rows 4..7: bright red, bright ... : same ink index, other brightness
  const brightApart = picture(16, 8, (x, y) => (x < 8 ? (y < 4 ? RED : BLUE) : (y < 4 ? BRED : rgbOf(9))));
  const lastPixel = picture(24, 8, (x, y) => { const c = x >> 3, lx = x & 7; return lx === 7 && y === 7 ? (c === 1 ? BLUE : c === 2 ? GREEN : RED) : RED; });
  const firstPixel = picture(24, 8, (x, y) => { const c = x >> 3, lx = x & 7; return lx === 0 && y === 0 ? (c === 1 ? BLUE : c === 2 ? GREEN : RED) : RED; });
  const dots = picture(24, 8, (x, y) => { const c = x >> 3, lx = x & 7; return (c === 0 && lx === 3 && y === 4) || (c === 1 && lx < 2 && y < 2) ? [255, 255, 0, 255] : [255, 255, 0, 0]; });
  const tie = picture(8, 8, () => [2, 0, 0]);
  const tiePal = Array.from({ length: 16 }, (_, i) => ({ name: 'c' + i, rgb: i === 0 ? [0, 0, 0] : i === 2 ? [64, 0, 0] : [255 - i * 8, 200, 50 + i * 10] }));
  for (const dither of ['none', 'ordered', 'diffusion']) {
    for (const [id, pic, o] of [['stripes', stripes, { cols: 4, rows: 1 }], ['stripes fine', stripes, { cols: 4, rows: 1, fine: true }], ['stripes2', stripes2, { cols: 4, rows: 1 }], ['stripes2 fine', stripes2, { cols: 4, rows: 1, fine: true }], ['share', share, { cols: 1, rows: 1, fine: true }], ['shareB', shareB, { cols: 1, rows: 1, fine: true }], ['shareB bb', shareB, { cols: 1, rows: 1, fine: true, brightBlack: true }],
      ['brightApart', brightApart, { cols: 2, rows: 1 }], ['brightApart fine', brightApart, { cols: 2, rows: 1, fine: true }], ['lastPixel', lastPixel, { cols: 3, rows: 1 }], ['firstPixel', firstPixel, { cols: 3, rows: 1 }], ['dots', dots, { cols: 3, rows: 1 }], ['dots solid', dots, { cols: 3, rows: 1, transparentCells: false }], ['dots thr 1', dots, { cols: 3, rows: 1, alphaThreshold: 1 }], ['tie pal', tie, { cols: 1, rows: 1, palette: tiePal }]]) {
      const g = PI.quantizeToCells(pic, { ...o, dither }); results[`x ${id} ${dither}`] = gridDigest(g);
      const r = PI.buildTiles(g); results[`xb ${id} ${dither}`] = resultDigest(r); results[`xd ${id} ${dither}`] = dig(PI.describeImport(r));
    }
  }
  const gFlatOwn = PI.buildTiles(gFlat).tiles, gBA = PI.quantizeToCells(brightApart, { cols: 2, rows: 1, dither: 'none' });
  const rcTile = (() => { const t = T.newTile({ ink: 2, paper: 1, bright: 0 }); t.bits = [0xF0, 0xF0, 0xF0, 0xF0, 0x0F, 0x0F, 0x0F, 0x0F]; T.setColours(t, { ink: 4, paper: 6, bright: 1 }, [5, 6, 7]); return t; })();     // rows 5..7 in their own colours: a fine-colour tile
  const dupSet = (t) => ({ tiles: [t, T.cloneTile(t), T.cloneTile(t)], tilesKey: 'tiles' });
  const ex2 = { 'flat own': { tiles: gFlatOwn, tilesKey: 'tiles' }, 'flat dup': dupSet(gFlatOwn[0]), 'flat two dup': { tiles: [gFlatOwn[0], gFlatOwn[1], gFlatOwn[0], gFlatOwn[1]], tilesKey: 'tiles' }, 'row colours': { tiles: [rcTile, ...mkSet(2, 41).tiles], tilesKey: 'tiles' }, 'row colours full': { tiles: [rcTile, ...mkSet(127, 42).tiles], tilesKey: 'tiles' } };
  // a palette with three colours on one line (black, 64 and 128 red): the tie between pairs that fit equally is decided by the shorter pair
  const linePal = Array.from({ length: 16 }, (_, i) => ({ name: 'c' + i, rgb: i === 0 ? [0, 0, 0] : i === 1 ? [128, 0, 0] : i === 2 ? [64, 0, 0] : [(i * 71) & 255, 255 - ((i * 37) & 127), 90 + i * 9] }));
  const lineP = picture(8, 8, (x) => (x < 3 ? [0, 0, 0] : [64, 0, 0])), lineF = picture(8, 8, (x, y) => (x < 3 ? [0, 0, 0] : y < 4 ? [64, 0, 0] : [0, 0, 0]));
  for (const dither of ['none', 'ordered', 'diffusion']) for (const [id, pic, fine] of [['line', lineP, false], ['line fine', lineF, true]]) { const g = PI.quantizeToCells(pic, { cols: 1, rows: 1, dither, fine, palette: linePal }); results[`l ${id} ${dither}`] = gridDigest(g); results[`lb ${id} ${dither}`] = resultDigest(PI.buildTiles(g, { palette: linePal })); }
  // rows that differ in BRIGHT alone (the same ink and paper colours): a fine tile with row colours
  const brightRows = picture(8, 8, (x, y) => (x < 3 ? (y < 4 ? RED : BRED) : (y < 4 ? BLUE : rgbOf(9))));
  for (const dither of ['none', 'diffusion']) { const g = PI.quantizeToCells(brightRows, { cols: 1, rows: 1, dither, fine: true }); results[`br ${dither}`] = gridDigest(g); results[`brb ${dither}`] = resultDigest(PI.buildTiles(g)); results[`brt ${dither}`] = dig(JSON.stringify(PI.buildTiles(g).tiles)); }
  // an existing fine-colour tile: a cell that shows it is reused (fine grid: its rows' own colours; normal grid: row 0's colours), and the nearest one is found by the same rendering
  const sheetOf1 = (t, fine) => PI.tilesetToRGBA({ tiles: [t] }, { fine });
  const plainX = (() => { const x = T.cloneTile(rcTile); T.setColours(x, { ink: 2, paper: 1, bright: 0 }, [0, 1, 2, 3, 4, 5, 6, 7]); return x; })();
  const bumped = (sheet) => { const d = Uint8ClampedArray.from(sheet.data); const o = (3 * 8 + 3) * 4; d[o] = 0; d[o + 1] = 0; d[o + 2] = 205; return { width: sheet.width, height: sheet.height, data: d }; };
  const fineSheet = sheetOf1(rcTile, true), plainSheet = sheetOf1(rcTile, false);
  const filler = (n, seed) => mkSet(n, seed).tiles;
  for (const [name, o] of [['fine reuse', { img: fineSheet, fine: true, set: [rcTile] }], ['plain reuse', { img: plainSheet, fine: false, set: [rcTile] }], ['fine reuse rc second', { img: fineSheet, fine: true, set: [plainX, rcTile] }], ['plain reuse rc second', { img: plainSheet, fine: false, set: [plainX, rcTile] }],
    ['fine nearest', { img: bumped(fineSheet), fine: true, set: [plainX, rcTile, ...filler(126, 61)] }], ['plain nearest', { img: bumped(plainSheet), fine: false, set: [rcTile, plainX, ...filler(126, 62)] }], ['fine nearest first', { img: bumped(fineSheet), fine: true, set: [rcTile, plainX, ...filler(126, 63)] }], ['plain nearest second', { img: bumped(plainSheet), fine: false, set: [plainX, rcTile, ...filler(126, 64)] }]]) {
    const g = PI.quantizeToCells(o.img, { cols: 1, rows: 1, dither: 'none', fine: o.fine, brightBlack: true }), r = PI.buildTiles(g, { existing: { tiles: o.set, tilesKey: 'tiles' } });
    results[`rc ${name}`] = resultDigest(r); results[`rcg ${name}`] = gridDigest(g);
  }
  for (const [name, set] of Object.entries(ex2)) for (const [gid, gr] of [['flat', gFlat], ['fine', gFine], ['noise', gNoise], ['stripes fine', PI.quantizeToCells(stripes, { cols: 4, rows: 1, fine: true, dither: 'none' })], ['stripes', PI.quantizeToCells(stripes, { cols: 4, rows: 1, dither: 'none' })], ['brightApart', gBA]]) {
    const r = PI.buildTiles(gr, { existing: set }); results[`e2 ${name} ${gid}`] = resultDigest(r); results[`e2d ${name} ${gid}`] = dig(PI.describeImport(r));
  }
  for (const [name, set] of [['full', mkSet(128, 51)], ['full fg', mkSet(128, 52, { each: () => ({ fg: true }) })], ['rc 128', { tiles: [rcTile, ...mkSet(127, 53).tiles], tilesKey: 'tiles' }]]) for (const [gid, gr] of [['noise', gNoise], ['fine', gFine], ['stripes fine', PI.quantizeToCells(stripes, { cols: 4, rows: 1, fine: true, dither: 'none' })], ['flat', gFlat]]) {
    const r = PI.buildTiles(gr, { existing: set }); results[`e3 ${name} ${gid}`] = resultDigest(r);
  }
  results['mfr 254'] = dig(JSON.stringify(PI.mapFromResult({ map: Uint8Array.from([254, 255, 0, 127]), cols: 4, rows: 1 })));
  const FINAL = results;
  if (process.argv.includes('--print-golden')) { console.log('const GOLDEN = ' + JSON.stringify(FINAL, null, 1) + ';'); }
  const GOLDEN = GOLDEN_TABLE;
  const ids = Object.keys(FINAL), badIds = ids.filter((id) => GOLDEN[id] !== FINAL[id]), missing = Object.keys(GOLDEN).filter((id) => !(id in FINAL));
  check(`${ids.length} golden digests (grids, builds, existing sets, assets, sheets, sentences) equal the table`, badIds.length === 0 && missing.length === 0 && ids.length === Object.keys(GOLDEN).length, badIds.slice(0, 6).join('; ') + (badIds.length > 6 ? ` ... ${badIds.length} in all` : '') + (missing.length ? ` missing: ${missing.slice(0, 3).join('; ')}` : ''));
  // a few of the golden facts as plain statements, so a failure names what went wrong
  check('describeImport: the sentences are exactly the ones written (singular and plural)', PI.describeImport(mkR({ nt: 1 })) === '10 cells became 1 new tile.' && PI.describeImport(mkR({ nt: 2, reused: 1, merged: 1, blankCells: 1 })) === '9 cells became 2 new tiles; 1 cell uses a tile the set already has; 1 repeated cell merged; 1 transparent cell left blank.' &&
    PI.describeImport(mkR({ nt: 0, reused: 3, merged: 5, blankCells: 4, overflow: true, needed: 200, maxTiles: 128, lossyCells: 50, lossyTiles: 1 })) === '6 cells became 0 new tiles; 3 cells use a tile the set already has; 5 repeated cells merged; 4 transparent cells left blank. It needs 200 tiles but the limit is 128: 50 cells (1 picture) now use the nearest tile by colour.');
  check('roomIn: 128 minus the tiles, never below 0, no set is 128, the limit can be given', PI.roomIn({ tiles: new Array(5) }) === 123 && PI.roomIn({ tiles: new Array(128) }) === 0 && PI.roomIn({ tiles: new Array(130) }) === 0 && PI.roomIn(undefined) === 128 && PI.roomIn(null) === 128 && PI.roomIn({}) === 128 && PI.roomIn({ tiles: new Array(5) }, 10) === 5 && PI.roomIn({ tiles: new Array(50) }, 10) === 0);
  check('mapFromResult: 255 is the only blank cell (254 is a tile number), the size and the set name are kept, a non-string name is null', J2(PI.mapFromResult({ map: Uint8Array.from([254, 255, 0, 127]), cols: 4, rows: 1 }, 'ts')) === J2({ w: 4, h: 1, cells: [254, -1, 0, 127], repr: 'hex', tileset: 'ts', extra: {} }) && PI.mapFromResult({ map: Uint8Array.from([1]), cols: 1, rows: 1 }, 7).tileset === null && PI.mapFromResult({ map: Uint8Array.from([1]), cols: 1, rows: 1 }).tileset === null && PI.mapFromResult({ map: Uint8Array.from([1, 2, 3, 4, 5, 6]), cols: 3, rows: 2 }).w === 3);
  check('constants: a screen is 32 x 24 cells, at most 64 a side, three dithers and three fits', PI.SCREEN_COLS === 32 && PI.SCREEN_ROWS === 24 && PI.MAX_CELLS_SIDE === 64 && PI.DITHERS.join() === 'none,ordered,diffusion' && PI.FITS.join() === 'stretch,fit,crop');
  const fails = (img, o) => { try { PI.quantizeToCells(img, o); return null; } catch (e) { return `${e.constructor.name}: ${e.message}`; } };
  const ok1 = picture(8, 8, () => RED);
  check('quantizeToCells refuses: a damaged picture (no data, short data, 0 or fractional size, null) with the plain message; 0, fractional or over-64 sides and an unknown dither with a RangeError; accepts 1 and 64',
    [null, undefined, {}, { width: 8, height: 8 }, { width: 8, height: 8, data: new Uint8ClampedArray(255) }, { width: 0, height: 8, data: new Uint8ClampedArray(0) }, { width: 8, height: 0, data: new Uint8ClampedArray(0) }, { width: 8.5, height: 8, data: new Uint8ClampedArray(512) }, { width: 8, height: 8.5, data: new Uint8ClampedArray(512) }].every((img) => fails(img, {}) === 'Error: the picture is empty or damaged') &&
    fails({ width: 8, height: 8, data: new Uint8ClampedArray(256) }, { cols: 1, rows: 1 }) === null && fails({ width: 8, height: 8, data: new Uint8ClampedArray(300) }, { cols: 1, rows: 1 }) === null &&
    [{ cols: 0 }, { rows: 0 }, { cols: 65 }, { rows: 65 }, { cols: 1.5 }, { rows: 2.5 }, { cols: -1 }, { cols: '4' }].every((o) => /^RangeError: the picture is 1\.\.64 cells wide and high$/.test(fails(ok1, o))) && /^RangeError: dither must be one of none, ordered, diffusion$/.test(fails(ok1, { dither: 'x' })) &&
    fails(ok1, { cols: 64, rows: 64 }) === null && fails(ok1, { cols: 1, rows: 1 }) === null && fails(ok1, { dither: 'ordered' }) === null);
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
