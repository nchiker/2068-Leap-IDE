/**
 * src/tools/picture-import.js — picture import for the Leap Arcade Studio's tile and map editors (pure: no DOM, Node can import it).
 *
 * One engine for two jobs: the tile editor turns a picture into tiles (T2), the map editor turns a 256 x 192 picture into a tile set plus a
 * 32 x 24 cell map (M3). The steps, each a function you can call alone:
 *
 *   quantizeToCells(img, opts)   an RGBA picture -> a grid of 8 x 8 cells. A cell has TWO colours (ink and paper) and one BRIGHT, the TS2068's
 *                                attribute rule; with `fine: true` every pixel row of a cell has its own ink / paper / BRIGHT (8 x 1 colour, the fine
 *                                scenes). The colours are the 15 the machine shows (black is one colour: BRIGHT 0 and BRIGHT 1 black are the same).
 *   buildTiles(grid, opts)       cells -> tiles + a map of tile numbers: identical pictures are merged (also a cell with ink and paper swapped and the
 *                                bits inverted: the same picture), the limit (128 tiles) is respected, and when the picture needs more, the nearest
 *                                tiles are merged until it fits (the result says so: `overflow`, `needed`, `lossyCells`).
 *   pictureToAssets(img, opts)   both, then the stored forms: {tileset (the asset), map (the asset), result} for a project or a starter.
 *   tilesetToRGBA(set, opts)     a tile set as a contact sheet (RGBA) for a PNG export (the DOM side encodes it with canvas.toBlob).
 *   describeImport(result)       one plain sentence about what the import did (and what it could not keep).
 *
 * Picture: {width, height, data} with data an RGBA array (Uint8ClampedArray, as canvas getImageData gives; Node: build it by hand or decode a PNG
 * elsewhere, this module has no decoder). Pixels with alpha below `alphaThreshold` are transparent; colours are composited over black, and a cell
 * that is transparent all through becomes `blank` (a blank map cell, no tile).
 *
 * Colour choice. The pair of each cell (or pixel row) is the pair of one brightness with the least colour error over its pixels: with a dither the
 * error to the LINE between the two colours (what the dither can reach), without one the error to the nearer colour. Then each pixel takes the nearer of
 * the pair (`dither: 'none'`), or is dithered: 'diffusion' spreads each pixel's error over the next pixels (Sierra-lite, serpentine, across cell borders, always
 * against the pair of the cell a pixel is in), 'ordered' compares with a 4 x 4 Bayer pattern. All three are deterministic: the same picture and
 * options give the same bytes.
 *
 * The two-blacks rule of the project (docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md K1 to K4): TSRun draws BRIGHT black as dark grey, so black is only used with
 * BRIGHT 0. A BRIGHT pair never contains black (`brightBlack: false`, the default), and a flat black cell is paper 0, BRIGHT 0. The set an import writes
 * then raises neither black-bright-mix nor bright-black-paper in the asset check. `brightBlack: true` lifts it.
 */

"use strict";

import * as T from './tile-model.js';
import * as M from './map-model.js';
import { colourKey } from './sprite-model.js';

export const SCREEN_COLS = 32;           // a screen is 32 x 24 cells = 256 x 192 pixels
export const SCREEN_ROWS = 24;
export const MAX_CELLS_SIDE = 64;        // the engine's own limit per side (a bigger picture is scaled down to it by the caller)
export const DITHERS = Object.freeze(['none', 'ordered', 'diffusion']);
export const FITS = Object.freeze(['stretch', 'fit', 'crop']);

const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const W3 = [2, 4, 3];                    // the weights of the colour distance (the sprite editor's: green counts most)

const isImg = (img) => img && Number.isInteger(img.width) && Number.isInteger(img.height) && img.width > 0 && img.height > 0 && img.data && img.data.length >= img.width * img.height * 4;

/** The RGB of each of the 16 keys (key 8 is black as well) from the palette the host shows. */
function colourTable(palette) {
  const out = [];
  for (let k = 0; k < 16; k++) out.push(T.keyRGB(k === 8 ? 0 : k, palette));
  return out;
}
const dist = (a, b) => W3[0] * (a[0] - b[0]) ** 2 + W3[1] * (a[1] - b[1]) ** 2 + W3[2] * (a[2] - b[2]) ** 2;

// ── scaling ───────────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Box-resample the region (x0, y0, rw, rh) of img (fractions allowed) to w x h, colour weighted by alpha: {r, g, b, a} Float32Arrays (a 0..255).
 */
function resample(img, x0, y0, rw, rh, w, h) {
  const n = w * h, r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), a = new Float32Array(n);
  const sx = rw / w, sy = rh / h, d = img.data;
  for (let ty = 0; ty < h; ty++) for (let tx = 0; tx < w; tx++) {
    const ax = x0 + tx * sx, bx = x0 + (tx + 1) * sx, ay = y0 + ty * sy, by = y0 + (ty + 1) * sy;
    let wr = 0, wg = 0, wb = 0, wa = 0, area = 0;
    for (let yy = Math.floor(ay); yy < Math.ceil(by); yy++) for (let xx = Math.floor(ax); xx < Math.ceil(bx); xx++) {
      const cov = (Math.min(bx, xx + 1) - Math.max(ax, xx)) * (Math.min(by, yy + 1) - Math.max(ay, yy));
      if (cov <= 0) continue;
      const px = Math.max(0, Math.min(img.width - 1, xx)), py = Math.max(0, Math.min(img.height - 1, yy)), p = (py * img.width + px) * 4;
      const al = d[p + 3] / 255;
      wr += d[p] * al * cov; wg += d[p + 1] * al * cov; wb += d[p + 2] * al * cov; wa += al * cov; area += cov;
    }
    const i = ty * w + tx;
    a[i] = area ? (wa / area) * 255 : 0;
    if (wa > 0) { r[i] = wr / wa; g[i] = wg / wa; b[i] = wb / wa; }
  }
  return { r, g, b, a };
}

/**
 * The picture as W x H pixels composited over black: {rgb: Float32Array(W*H*3), alpha: Float32Array(W*H) 0..255}.
 * `mode`: 'stretch' (the whole picture over the whole box, the aspect ratio ignored), 'fit' (the whole picture, aspect kept, black bars: opaque),
 * 'crop' (the box filled, aspect kept, the edges cut). A picture already W x H is taken as it is.
 */
function toPixels(img, W, H, mode) {
  const n = W * H, rgb = new Float32Array(n * 3), alpha = new Float32Array(n);
  const put = (pl, ox, oy, pw, ph) => {
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const s = y * pw + x, t = (oy + y) * W + ox + x, al = pl.a[s] / 255;
      rgb[t * 3] = pl.r[s] * al; rgb[t * 3 + 1] = pl.g[s] * al; rgb[t * 3 + 2] = pl.b[s] * al;
      alpha[t] = pl.a[s];
    }
  };
  if (img.width === W && img.height === H) {
    const pl = { r: new Float32Array(n), g: new Float32Array(n), b: new Float32Array(n), a: new Float32Array(n) };
    for (let i = 0; i < n; i++) { pl.r[i] = img.data[i * 4]; pl.g[i] = img.data[i * 4 + 1]; pl.b[i] = img.data[i * 4 + 2]; pl.a[i] = img.data[i * 4 + 3]; }
    put(pl, 0, 0, W, H);
  } else if (mode === 'fit') {
    const s = Math.min(W / img.width, H / img.height), dw = Math.max(1, Math.min(W, Math.round(img.width * s))), dh = Math.max(1, Math.min(H, Math.round(img.height * s)));
    alpha.fill(255);                                                        // the bars are black and opaque
    put(resample(img, 0, 0, img.width, img.height, dw, dh), Math.floor((W - dw) / 2), Math.floor((H - dh) / 2), dw, dh);
  } else if (mode === 'crop') {
    const s = Math.max(W / img.width, H / img.height), sw = W / s, sh = H / s;
    put(resample(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, W, H), 0, 0, W, H);
  } else {
    put(resample(img, 0, 0, img.width, img.height, W, H), 0, 0, W, H);
  }
  return { rgb, alpha };
}

// ── the pair of one unit (a cell, or a pixel row of a cell in fine mode) ─────────────────────────────────────────
/**
 * The best (a, b, bright) for the pixels idx[0..n) of px (a, b colours 0..7, a <= b; a === b: one colour): the pair of one brightness with the least
 * error. Every distance is a lookup in D (the pixels' distances to the 8 colours of the brightness) and L (the colours' to each other): the distance
 * from a pixel to the segment between two colours follows from those by the law of cosines.
 */
function fitUnit(px, idx, n, ctx, D) {
  let best = null;
  for (const br of ctx.brights) {
    const cand = ctx.cand[br], L = ctx.L[br];
    for (let c = 0; c < 8; c++) {
      if (br === 1 && c === 0 && !ctx.brightBlack) continue;              // BRIGHT black is dark grey in TSRun: never choose it
      const cr = cand[c][0], cg = cand[c][1], cb = cand[c][2], o = c * n;
      for (let p = 0; p < n; p++) {
        const q = idx[p] * 3, dr = px[q] - cr, dg = px[q + 1] - cg, db = px[q + 2] - cb;
        D[o + p] = W3[0] * dr * dr + W3[1] * dg * dg + W3[2] * db * db;
      }
    }
    const lo = br === 1 && !ctx.brightBlack ? 1 : 0;
    for (let i = lo; i < 8; i++) for (let j = i; j < 8; j++) {
      let cost = 0;
      const oi = i * n, oj = j * n;
      if (i === j) { for (let p = 0; p < n; p++) cost += D[oi + p]; }
      else if (!ctx.segment) { for (let p = 0; p < n; p++) { const da = D[oi + p], db = D[oj + p]; cost += da < db ? da : db; } }
      else {
        const l = L[i * 8 + j];
        for (let p = 0; p < n; p++) {
          const da = D[oi + p], db = D[oj + p], dot = (da + l - db) * 0.5;
          let t = dot / l;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          cost += da - 2 * t * dot + t * t * l;
        }
        cost += 1e-6 * l;                                                  // among equal fits prefer the closer pair
      }
      if (!best || cost < best.cost - 1e-9) best = { cost, a: i, b: j, bright: br };
    }
  }
  return best;
}

/** Ink to give a flat colour (nothing is drawn in it: the bits are all paper): any colour but the paper's, white where it can. */
const flatInk = (colour, bright) => (colour === 7 ? (bright ? 1 : 0) : 7);

// ── step 1: pixels -> cells ────────────────────────────────────────────────────────────────────────────────────
/**
 * Convert a picture to cols x rows cells of 8 x 8 pixels.
 *
 * opts: {cols = 32, rows = 24, dither = 'diffusion' ('none' | 'ordered' | 'diffusion'), fine = false, fit = 'stretch' ('stretch' | 'fit' | 'crop'),
 *        palette (the host's, default the Studio's), bright = 'both' (0 | 1: use that brightness only), brightBlack = false,
 *        alphaThreshold = 128, transparentCells = true (a cell with no opaque pixel is blank)}
 *
 * Returns {cols, rows, fine, cells: [cell x cols * rows (row-major)]}; a cell is {blank: false, bits: [8 ints, 1 = ink, MSB = leftmost],
 * rows: [{ink, paper, bright} x 8] (all alike unless fine), keys: Int8Array(64) (the colour key of every pixel, row-major: 0 black, 1..7, 9..15 bright)}
 * or {blank: true}. A cell of one colour is written the one way (bits 0, paper = the colour), so two flat cells of one colour are equal.
 */
export function quantizeToCells(img, opts = {}) {
  if (!isImg(img)) throw new Error('the picture is empty or damaged');
  const cols = opts.cols ?? SCREEN_COLS, rows = opts.rows ?? SCREEN_ROWS;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1 || cols > MAX_CELLS_SIDE || rows > MAX_CELLS_SIDE) throw new RangeError(`the picture is 1..${MAX_CELLS_SIDE} cells wide and high`);
  const dither = opts.dither ?? 'diffusion';
  if (!DITHERS.includes(dither)) throw new RangeError(`dither must be one of ${DITHERS.join(', ')}`);
  const fine = !!opts.fine, thr = opts.alphaThreshold ?? 128;
  const tab = colourTable(opts.palette);
  const W = cols * 8, H = rows * 8, N = W * H;
  const { rgb: px, alpha } = toPixels(img, W, H, opts.fit ?? 'stretch');

  // the candidate colours of each brightness, and their distances to each other
  const cand = [0, 1].map((br) => Array.from({ length: 8 }, (_, c) => tab[colourKey(c, br)]));
  const L = cand.map((cs) => { const l = new Float64Array(64); for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) l[i * 8 + j] = dist(cs[i], cs[j]); return l; });
  const ctx = { cand, L, brights: opts.bright === 0 || opts.bright === 1 ? [opts.bright] : [0, 1], brightBlack: !!opts.brightBlack, segment: dither !== 'none' };

  // pass 1: the pair of every unit (a cell; or each pixel row of a cell when fine)
  const perCell = fine ? 8 : 1, perRow = fine ? 8 : 64;
  const units = cols * rows * perCell;
  const ua = new Uint8Array(units), ub = new Uint8Array(units), ubr = new Uint8Array(units);
  const idx = new Int32Array(64), D = new Float64Array(8 * 64);
  const blank = new Uint8Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    const cell = cy * cols + cx;
    let opaque = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (alpha[(cy * 8 + y) * W + cx * 8 + x] >= thr) opaque++;
    if (opts.transparentCells !== false && opaque === 0) { blank[cell] = 1; continue; }
    for (let u = 0; u < perCell; u++) {
      let n = 0;
      for (let k = 0; k < perRow; k++) {
        const x = fine ? k : k & 7, y = fine ? u : k >> 3;
        idx[n++] = (cy * 8 + y) * W + cx * 8 + x;
      }
      const f = fitUnit(px, idx, n, ctx, D), at = cell * perCell + u;
      ua[at] = f.a; ub[at] = f.b; ubr[at] = f.bright;
    }
  }

  // pass 2: every pixel becomes one of the two colours of its unit
  const selB = new Uint8Array(N);                                          // 1 = the pixel takes colour b of its unit
  const errA = new Float32Array((W + 2) * 3), errB = new Float32Array((W + 2) * 3);
  let cur = errA, nxt = errB;
  for (let y = 0; y < H; y++) {
    const cy = y >> 3, ry = y & 7, back = dither === 'diffusion' && (y & 1) === 1;       // serpentine: odd rows run right to left
    nxt.fill(0);
    for (let s = 0; s < W; s++) {
      const x = back ? W - 1 - s : s, cx = x >> 3, cell = cy * cols + cx;
      if (blank[cell]) continue;
      const u = cell * perCell + (fine ? ry : 0), A = cand[ubr[u]][ua[u]], B = cand[ubr[u]][ub[u]];
      const p = (y * W + x) * 3, e = (x + 1) * 3;
      let v0 = px[p], v1 = px[p + 1], v2 = px[p + 2];
      if (dither === 'diffusion') {
        v0 += cur[e]; v1 += cur[e + 1]; v2 += cur[e + 2];
        v0 = v0 < 0 ? 0 : v0 > 255 ? 255 : v0; v1 = v1 < 0 ? 0 : v1 > 255 ? 255 : v1; v2 = v2 < 0 ? 0 : v2 > 255 ? 255 : v2;
      }
      let pickB = 0;
      if (ua[u] !== ub[u]) {
        if (dither === 'ordered') {
          const ax = B[0] - A[0], ay = B[1] - A[1], az = B[2] - A[2], len = ax * ax + ay * ay + az * az;
          let t = ((v0 - A[0]) * ax + (v1 - A[1]) * ay + (v2 - A[2]) * az) / len;
          t = t < 0 ? 0 : t > 1 ? 1 : t;
          pickB = t > (BAYER4[y & 3][x & 3] + 0.5) / 16 ? 1 : 0;
        } else {
          const da = W3[0] * (v0 - A[0]) ** 2 + W3[1] * (v1 - A[1]) ** 2 + W3[2] * (v2 - A[2]) ** 2;
          const db = W3[0] * (v0 - B[0]) ** 2 + W3[1] * (v1 - B[1]) ** 2 + W3[2] * (v2 - B[2]) ** 2;
          pickB = db < da ? 1 : 0;
        }
      }
      selB[y * W + x] = pickB;
      if (dither === 'diffusion') {
        const C = pickB ? B : A, e0 = v0 - C[0], e1 = v1 - C[1], e2 = v2 - C[2];
        const f = (back ? -1 : 1) * 3;                                        // the pixel ahead (in the direction of travel), in the error rows
        cur[e + f] += e0 * 0.5; cur[e + f + 1] += e1 * 0.5; cur[e + f + 2] += e2 * 0.5;
        nxt[e - f] += e0 * 0.25; nxt[e - f + 1] += e1 * 0.25; nxt[e - f + 2] += e2 * 0.25;
        nxt[e] += e0 * 0.25; nxt[e + 1] += e1 * 0.25; nxt[e + 2] += e2 * 0.25;
      }
    }
    const t = cur; cur = nxt; nxt = t;
  }

  // pass 3: cells (ink = the colour of fewer pixels; a cell of one colour in its one written form)
  const cells = new Array(cols * rows);
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    const cell = cy * cols + cx;
    if (blank[cell]) { cells[cell] = { blank: true }; continue; }
    const bits = new Array(8).fill(0), rowc = new Array(8);
    const unitInk = [], unitPaper = [];                                    // per unit: the colours (0..7) and brightness
    for (let u = 0; u < perCell; u++) {
      const at = cell * perCell + u, a = ua[at], b = ub[at], br = ubr[at];
      let nb = 0, n = 0;
      for (let y = fine ? u : 0; y < (fine ? u + 1 : 8); y++) for (let x = 0; x < 8; x++) { nb += selB[(cy * 8 + y) * W + cx * 8 + x]; n++; }
      const inkIsB = nb * 2 <= n;                                          // the minority is the ink; a tie: b
      unitInk[u] = inkIsB ? b : a; unitPaper[u] = inkIsB ? a : b; ubr[at] = br;
      for (let y = fine ? u : 0; y < (fine ? u + 1 : 8); y++) {
        let v = 0;
        for (let x = 0; x < 8; x++) { const isB = selB[(cy * 8 + y) * W + cx * 8 + x]; if (inkIsB ? isB : !isB) v |= 0x80 >>> x; }
        bits[y] = v;
      }
    }
    for (let y = 0; y < 8; y++) {
      const u = fine ? y : 0, at = cell * perCell + u;
      rowc[y] = { ink: unitInk[u], paper: unitPaper[u], bright: ubr[at] };
    }
    cells[cell] = finishCell(bits, rowc, fine);
  }
  return { cols, rows, fine, cells };
}

/** Write a cell in its one form: a flat row (all ink or all paper) is bits 0 on the colour it shows; a cell flat all through (not fine) is one colour; the keys of its 64 pixels. */
function finishCell(bits, rowc, fine) {
  const keys = new Int8Array(64);
  for (let y = 0; y < 8; y++) {
    const c = rowc[y];
    for (let x = 0; x < 8; x++) keys[y * 8 + x] = colourKey((bits[y] >>> (7 - x)) & 1 ? c.ink : c.paper, c.bright);
  }
  const flatRow = (y) => bits[y] === 0 || bits[y] === 0xFF;
  if (fine) {
    for (let y = 0; y < 8; y++) if (flatRow(y)) {
      const k = keys[y * 8], c = k === 0 ? 0 : k & 7, br = k === 0 ? 0 : k >> 3;
      bits[y] = 0; rowc[y] = { ink: flatInk(c, br), paper: c, bright: br };
    }
  } else if (keys.every((k) => k === keys[0])) {
    const k = keys[0], c = k === 0 ? 0 : k & 7, br = k === 0 ? 0 : k >> 3;
    for (let y = 0; y < 8; y++) { bits[y] = 0; rowc[y] = { ink: flatInk(c, br), paper: c, bright: br }; }
  }
  return { blank: false, bits, rows: rowc, keys };
}

// ── step 2: cells -> tiles + map ───────────────────────────────────────────────────────────────────────────────
const keyString = (keys) => { let s = ''; for (let i = 0; i < 64; i++) s += String.fromCharCode(65 + keys[i]); return s; };

/** A tile (tile-model's editing form) of a cell: colours of row 0, the rows' own colours when they differ. */
function tileOfCell(cell, foreground) {
  const c0 = cell.rows[0], t = T.newTile({ ink: c0.ink, paper: c0.paper, bright: c0.bright });
  t.bits = cell.bits.slice();
  if (cell.rows.some((c) => c.ink !== c0.ink || c.paper !== c0.paper || c.bright !== c0.bright)) t.rowColours = cell.rows.map((c) => ({ ink: c.ink, paper: c.paper, bright: c.bright }));
  if (foreground) { t.fg = true; t.hadFg = true; }
  return t;
}

/**
 * Merge down to `target` pictures: the one that costs least is merged into its nearest (cost = the pixel colour distance x the cells it moves, Ward style).
 * `pics` are Int8Array(64) key lists, `weight` the cells each stands for. Returns `rep`: for each picture the picture that stands for it (itself when kept).
 */
function reducePictures(pics, weight, target, tab) {
  const n = pics.length, dk = new Int32Array(256);
  for (let a = 0; a < 16; a++) for (let b = 0; b < 16; b++) dk[a * 16 + b] = Math.round(dist(tab[a], tab[b]));
  const hi = pics.map((p) => { const o = new Uint8Array(64); for (let k = 0; k < 64; k++) o[k] = p[k] * 16; return o; });     // key * 16: one add per lookup
  const d = new Float32Array(n * n);
  for (let i = 0; i < n; i++) {
    const pi = hi[i];
    for (let j = i + 1; j < n; j++) {
      const pj = pics[j];
      let s = 0;
      for (let k = 0; k < 64; k++) s += dk[pi[k] + pj[k]];
      d[i * n + j] = d[j * n + i] = s;
    }
  }
  const alive = new Uint8Array(n).fill(1), w = Float64Array.from(weight), nn = new Int32Array(n), nd = new Float64Array(n), rep = Int32Array.from({ length: n }, (_, i) => i);
  const nearest = (i) => {
    let bj = -1, bd = Infinity;
    const o = i * n;
    for (let j = 0; j < n; j++) if (alive[j] && j !== i && d[o + j] < bd) { bd = d[o + j]; bj = j; }
    nn[i] = bj; nd[i] = bd;
  };
  for (let i = 0; i < n; i++) nearest(i);
  let left = n;
  while (left > target) {
    let v = -1, bc = Infinity;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const u = nn[i], cost = (w[i] * w[u] / (w[i] + w[u])) * nd[i];
      if (cost < bc) { bc = cost; v = i; }
    }
    const u = nn[v];
    alive[v] = 0; rep[v] = u; w[u] += w[v]; left--;
    for (let i = 0; i < n; i++) if (alive[i] && nn[i] === v) nearest(i);
  }
  const final = (i) => { while (rep[i] !== i) i = rep[i]; return i; };
  return Int32Array.from({ length: n }, (_, i) => final(i));
}

/**
 * Cells -> tiles and a map. opts: {maxTiles = 128, existing (a tile-model set: its tiles are reused where a cell equals one, and new tiles are numbered after
 * them), foreground = false (mark the new tiles "sprites never pass over"), palette}.
 *
 * Returns {tiles (the NEW tiles, tile-model form), base (how many tiles come before them: existing.tiles.length), map (Uint8Array(cols * rows): the tile
 * number of each cell, `base` and up for the new tiles; 255 = blank), cols, rows, cells, distinct (different pictures), merged (cells that repeat an earlier
 * picture), reused (cells that took an existing tile), needed (the tiles the set needs for all of them: base + new pictures), overflow (needed > maxTiles),
 * maxTiles, lossyTiles (pictures given up to fit), lossyCells (cells that show another picture than theirs), blankCells}.
 * When it does not fit, the nearest pictures are merged (rarely used, closest first), so the map and the tiles are always valid.
 */
export function buildTiles(grid, opts = {}) {
  const maxTiles = opts.maxTiles ?? T.MAX_TILES;
  const existing = opts.existing?.tiles ?? [], base = existing.length;
  const tab = colourTable(opts.palette);
  const total = grid.cells.length;

  // the pictures of the existing tiles that a cell may take: no flags, not foreground-marked (a flagged tile has a job of its own)
  const have = new Map();
  existing.forEach((t, i) => { if (t.flags === 0 && !t.fg) { const k = keyString(T.tilePixels(t, { fine: grid.fine })); if (!have.has(k)) have.set(k, i); } });

  // the distinct new pictures, in order of first appearance
  const seen = new Map();                                                  // key -> index in `pics`
  const pics = [], weight = [], first = [];
  const cellPic = new Int32Array(total).fill(-1), cellOld = new Int32Array(total).fill(-1);
  let reused = 0, blankCells = 0;
  grid.cells.forEach((c, i) => {
    if (c.blank) { blankCells++; return; }
    const k = keyString(c.keys);
    if (have.has(k)) { cellOld[i] = have.get(k); reused++; return; }
    let p = seen.get(k);
    if (p === undefined) { p = pics.length; seen.set(k, p); pics.push(c.keys); weight.push(0); first.push(c); }
    weight[p]++;
    cellPic[i] = p;
  });
  const distinct = seen.size + new Set(cellOld.filter((v) => v >= 0)).size;
  const merged = (total - blankCells) - distinct;
  const needed = base + pics.length;
  const overflow = needed > maxTiles;
  const room = Math.max(0, maxTiles - base);

  let final = Int32Array.from({ length: pics.length }, (_, i) => i);      // the picture that stands for each
  let nearestOld = null;
  if (overflow && room === 0 && existing.length) {                        // no room at all: every new picture takes the nearest existing tile
    nearestOld = pics.map((keys) => {
      let bi = 0, bd = Infinity;
      existing.forEach((t, i) => { const tk = T.tilePixels(t, { fine: grid.fine }); let s = 0; for (let k = 0; k < 64; k++) s += dist(tab[keys[k]], tab[tk[k]]); if (s < bd) { bd = s; bi = i; } });
      return bi;
    });
  } else if (overflow) final = reducePictures(pics, weight, room, tab);

  // number the pictures that stay, in order of first appearance
  const number = new Int32Array(pics.length).fill(-1), tiles = [];
  if (!nearestOld) for (let p = 0; p < pics.length; p++) if (final[p] === p) { number[p] = base + tiles.length; tiles.push(tileOfCell(first[p], !!opts.foreground)); }
  const map = new Uint8Array(total).fill(255);
  let lossyCells = 0;
  for (let i = 0; i < total; i++) {
    if (cellOld[i] >= 0) map[i] = cellOld[i];
    else if (cellPic[i] >= 0) {
      const p = cellPic[i];
      if (nearestOld) { map[i] = nearestOld[p]; lossyCells++; }
      else { map[i] = number[final[p]]; if (final[p] !== p) lossyCells++; }
    }
  }
  const lossyTiles = nearestOld ? pics.length : pics.length - tiles.length;
  return { tiles, base, map, cols: grid.cols, rows: grid.rows, cells: total, distinct, merged, reused, blankCells, needed, overflow, maxTiles, lossyTiles, lossyCells };
}

/** One plain sentence about an import result: how many tiles, what was merged, and what did not fit. */
export function describeImport(r) {
  const nt = r.tiles.length, s = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
  const parts = [`${s(r.cells - r.blankCells, 'cell')} became ${s(nt, 'new tile')}`];
  if (r.reused) parts.push(`${s(r.reused, 'cell')} use${r.reused === 1 ? 's' : ''} a tile the set already has`);
  if (r.merged > 0) parts.push(`${s(r.merged, 'repeated cell')} merged`);
  if (r.blankCells) parts.push(`${s(r.blankCells, 'transparent cell')} left blank`);
  let text = parts.join('; ') + '.';
  if (r.overflow) text += ` It needs ${r.needed} tiles but the limit is ${r.maxTiles}: ${s(r.lossyCells, 'cell')} (${s(r.lossyTiles, 'picture')}) now use the nearest tile by colour.`;
  return text;
}

/** How many tiles a set can still take. */
export const roomIn = (set, maxTiles = T.MAX_TILES) => Math.max(0, maxTiles - (set?.tiles?.length ?? 0));

// ── both steps, to stored assets ────────────────────────────────────────────────────────────────────────────────
/**
 * A picture to a tile set and a cell map, as stored assets (what a project or a starter holds): {tileset, map, result, grid}.
 * opts: those of quantizeToCells and buildTiles, plus {tilesetName (the map's `tileset` key; left out when absent)}. The picture is cols x rows cells
 * (default 32 x 24 = 256 x 192 pixels; at most 32 x 24 for a map the compiler takes).
 * For a project: project.assets.tilesets[name] = tileset; project.assets.maps[name] = map. In Node, build `img` from a decoded PNG: {width, height, data: RGBA}.
 */
export function pictureToAssets(img, opts = {}) {
  const grid = quantizeToCells(img, opts), result = buildTiles(grid, opts);
  const set = opts.existing ? { ...opts.existing, tiles: [...opts.existing.tiles, ...result.tiles] } : { tiles: result.tiles, tilesKey: 'tiles' };
  const map = mapFromResult(result, opts.tilesetName);
  return { tileset: T.toAsset(set), map: M.toAsset(map), result, grid };
}

/** The editing-form map of a build result (blank cells stay blank); `tileset` names the tile set it is drawn with (optional). */
export function mapFromResult(result, tileset = null) {
  const cells = Array.from(result.map, (v) => (v === 255 ? M.BLANK : v));
  return { w: result.cols, h: result.rows, cells, repr: 'hex', tileset: typeof tileset === 'string' ? tileset : null, extra: {} };
}

// ── export: a tile set as a picture ────────────────────────────────────────────────────────────────────────────────
/**
 * A contact sheet of the set for a PNG: `cols` tiles a row (default 16; fewer when the set is smaller), each tile 8 x 8 pixels x `scale`, in its own colours
 * (each pixel row in its own, for a fine-colour tile; `fine: false` draws row 0's colours as every other scene does). The cells after the last tile are
 * transparent. Returns {width, height, data: Uint8ClampedArray RGBA, cols, rows}.
 */
export function tilesetToRGBA(set, { cols = 16, scale = 1, palette, fine = true } = {}) {
  const n = set.tiles.length, c = Math.max(1, Math.min(cols, n || 1)), r = Math.max(1, Math.ceil(n / c)), sc = Math.max(1, scale | 0);
  const width = c * 8 * sc, height = r * 8 * sc, data = new Uint8ClampedArray(width * height * 4);
  const tab = colourTable(palette);
  set.tiles.forEach((t, i) => {
    const keys = T.tilePixels(t, { fine }), ox = (i % c) * 8 * sc, oy = ((i / c) | 0) * 8 * sc;
    for (let y = 0; y < 8 * sc; y++) for (let x = 0; x < 8 * sc; x++) {
      const rgb = tab[keys[((y / sc) | 0) * 8 + ((x / sc) | 0)]], o = ((oy + y) * width + ox + x) * 4;
      data[o] = rgb[0]; data[o + 1] = rgb[1]; data[o + 2] = rgb[2]; data[o + 3] = 255;
    }
  });
  return { width, height, data, cols: c, rows: r };
}
