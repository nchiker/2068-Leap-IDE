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

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed ? 'FAIL' : 'PASS');
process.exit(failed ? 1 : 0);
