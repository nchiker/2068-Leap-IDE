"use strict";
// m20-picture-mutations.mjs -- mutation test of src/tools/picture-import.js (Studio completion stage 6, item C3: the picture import engine of the tile and map editors): copies src/, tests/ and the
// examples to a temporary directory, applies ONE deliberate bug at a time to picture-import.js (comparison flips, off-by-one, swapped operands, removed guards, changed constants, && / ||)
// and runs tests/picture-import.mjs; a mutation is KILLED when it fails.
//   node tests/m20-picture-mutations.mjs [name-fragment]     (about 2 seconds per mutant)
//   node tests/m20-picture-mutations.mjs --check             only verifies that every pattern occurs exactly once (and changes something)
//   node tests/m20-picture-mutations.mjs --shard=0/4         every fourth mutant (run the shards in parallel)
//   TMPDIR=<dir> to choose where the scratch copy lives.
// A mutant whose name starts with "EQUIVALENT:" changes no behaviour anyone can observe (the name says why); it is expected to survive, is counted separately, and does not fail the run.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shardArg = args.find((a) => a.startsWith('--shard='));
const [shardI, shardN] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
const TIMEOUT = 120000;                       // a mutant that loops is killed by the timeout
const E = (file, from, to) => ({ file, from, to });
const TESTS = ['tests/picture-import.mjs'];
const COPY_DIRS = ['src', 'tests', 'arcade/examples'];     // what the test reads (section 7 runs the asset check on what an import writes)
const BUILT_RUNTIMES = [];

const PI = 'src/tools/picture-import.js';
const MUTANTS = [
  // ---- constants ----
  ['constants: SCREEN_COLS 32 -> 31', [E(PI, 'SCREEN_COLS = 32;', 'SCREEN_COLS = 31;')]],
  ['constants: SCREEN_ROWS 24 -> 25', [E(PI, 'SCREEN_ROWS = 24;', 'SCREEN_ROWS = 25;')]],
  ['constants: MAX_CELLS_SIDE 64 -> 63', [E(PI, 'MAX_CELLS_SIDE = 64;', 'MAX_CELLS_SIDE = 63;')]],
  ['constants: MAX_CELLS_SIDE 64 -> 65', [E(PI, 'MAX_CELLS_SIDE = 64;', 'MAX_CELLS_SIDE = 65;')]],
  ['constants: DITHERS lose "ordered"', [E(PI, "DITHERS = Object.freeze(['none', 'ordered', 'diffusion'])", "DITHERS = Object.freeze(['none', 'diffusion'])")]],
  ['constants: FITS lose "crop"', [E(PI, "FITS = Object.freeze(['stretch', 'fit', 'crop'])", "FITS = Object.freeze(['stretch', 'fit'])")]],
  ['constants: BAYER4 first row changed', [E(PI, 'BAYER4 = [[0, 8, 2, 10],', 'BAYER4 = [[0, 8, 2, 11],')]],
  ['constants: BAYER4 second row changed', [E(PI, '[12, 4, 14, 6]', '[12, 4, 14, 7]')]],
  ['constants: BAYER4 third row changed', [E(PI, '[3, 11, 1, 9]', '[3, 11, 1, 8]')]],
  ['constants: BAYER4 last row changed', [E(PI, '[15, 7, 13, 5]]', '[15, 7, 13, 6]]')]],
  ['constants: the colour weights W3 are 1, 1, 1', [E(PI, 'W3 = [2, 4, 3];', 'W3 = [1, 1, 1];')]],
  ['constants: the red weight is 3', [E(PI, 'W3 = [2, 4, 3];', 'W3 = [3, 4, 3];')]],
  ['constants: the blue weight is 4', [E(PI, 'W3 = [2, 4, 3];', 'W3 = [2, 4, 4];')]],
  // ---- isImg ----
  ['isImg: a picture of width 0 is accepted', [E(PI, 'img.width > 0 && img.height > 0 && img.data', 'img.width >= 0 && img.height > 0 && img.data')]],
  ['isImg: a picture of height 0 is accepted', [E(PI, 'img.width > 0 && img.height > 0 && img.data', 'img.width > 0 && img.height >= 0 && img.data')]],
  ['isImg: data one byte short is accepted', [E(PI, 'img.data.length >= img.width * img.height * 4', 'img.data.length >= img.width * img.height * 4 - 1')]],
  ['isImg: data of the right length is refused', [E(PI, 'img.data.length >= img.width * img.height * 4', 'img.data.length > img.width * img.height * 4')]],
  ['isImg: a fractional width is accepted', [E(PI, 'Number.isInteger(img.width) && Number.isInteger(img.height)', 'Number.isFinite(img.width) && Number.isInteger(img.height)')]],
  ['isImg: a missing data array is accepted', [E(PI, 'img.height > 0 && img.data && img.data.length', 'img.height > 0 && img.data?.length ?? 1e9')]],
  // ---- colourTable ----
  ['EQUIVALENT: colourTable: key 8 is asked of the palette as key 8 (the palette\'s keyRGB maps key 8 to black itself)', [E(PI, 'T.keyRGB(k === 8 ? 0 : k, palette)', 'T.keyRGB(k, palette)')]],
  ['colourTable: only 15 colours', [E(PI, 'for (let k = 0; k < 16; k++) out.push(T.keyRGB', 'for (let k = 0; k < 15; k++) out.push(T.keyRGB')]],
  ['colourTable: the palette is ignored', [E(PI, 'T.keyRGB(k === 8 ? 0 : k, palette)', 'T.keyRGB(k === 8 ? 0 : k)')]],
  // ---- dist ----
  ['dist: the green difference is not squared', [E(PI, 'W3[1] * (a[1] - b[1]) ** 2 + W3[2] * (a[2] - b[2]) ** 2;\n\n', 'W3[1] * (a[1] - b[1]) + W3[2] * (a[2] - b[2]) ** 2;\n\n')]],
  ['dist: blue is not counted', [E(PI, ' + W3[2] * (a[2] - b[2]) ** 2;\n\n// ── scaling', ';\n\n// ── scaling')]],
  ['dist: red and blue swapped', [E(PI, 'W3[0] * (a[0] - b[0]) ** 2 + W3[1] * (a[1] - b[1]) ** 2 + W3[2] * (a[2] - b[2]) ** 2;\n\n// ── scaling', 'W3[0] * (a[2] - b[2]) ** 2 + W3[1] * (a[1] - b[1]) ** 2 + W3[2] * (a[0] - b[0]) ** 2;\n\n// ── scaling')]],
  // ---- resample ----
  ['resample: the x extent of a target pixel is one source pixel', [E(PI, 'bx = x0 + (tx + 1) * sx,', 'bx = ax + 1,')]],
  ['resample: the y extent of a target pixel is one source pixel', [E(PI, 'by = y0 + (ty + 1) * sy;', 'by = ay + 1;')]],
  ['resample: the x step is the height ratio', [E(PI, 'const sx = rw / w, sy = rh / h,', 'const sx = rh / h, sy = rh / h,')]],
  ['resample: the y step is the width ratio', [E(PI, 'const sx = rw / w, sy = rh / h,', 'const sx = rw / w, sy = rw / w,')]],
  ['resample: the coverage is the sum of the overlaps (not the product)', [E(PI, 'const cov = (Math.min(bx, xx + 1) - Math.max(ax, xx)) * (Math.min(by, yy + 1) - Math.max(ay, yy));', 'const cov = (Math.min(bx, xx + 1) - Math.max(ax, xx)) + (Math.min(by, yy + 1) - Math.max(ay, yy));')]],
  ['EQUIVALENT: resample: a pixel of zero coverage is counted (it adds 0 to every sum)', [E(PI, 'if (cov <= 0) continue;', 'if (cov < 0) continue;')]],
  ['EQUIVALENT: resample: the picture edge is clamped to width, not width - 1 on the right (the region ends at or before the picture\'s edge for every caller: stretch, fit and crop, so ceil(bx) - 1 is a pixel of the picture)', [E(PI, 'const px = Math.max(0, Math.min(img.width - 1, xx)),', 'const px = Math.max(0, Math.min(img.width, xx)),')]],
  ['EQUIVALENT: resample: the picture edge is clamped to -1 at the top, not 0 (the region starts at y0 >= 0 for every caller, so floor(ay) is never negative)', [E(PI, 'py = Math.max(0, Math.min(img.height - 1, yy)),', 'py = Math.max(-1, Math.min(img.height - 1, yy)),')]],
  ['resample: the colours are not weighted by alpha', [E(PI, 'wr += d[p] * al * cov;', 'wr += d[p] * cov;')]],
  ['resample: the green is not weighted by alpha', [E(PI, 'wg += d[p + 1] * al * cov;', 'wg += d[p + 1] * cov;')]],
  ['resample: the blue is not weighted by alpha', [E(PI, 'wb += d[p + 2] * al * cov;', 'wb += d[p + 2] * cov;')]],
  ['resample: alpha is read from the blue byte', [E(PI, 'const al = d[p + 3] / 255;', 'const al = d[p + 2] / 255;')]],
  ['resample: alpha is not scaled to 0..1', [E(PI, 'const al = d[p + 3] / 255;', 'const al = d[p + 3];')]],
  ['resample: the alpha result is not scaled back to 0..255', [E(PI, 'a[i] = area ? (wa / area) * 255 : 0;', 'a[i] = area ? (wa / area) : 0;')]],
  ['resample: the colour is divided by the area, not the alpha weight', [E(PI, 'if (wa > 0) { r[i] = wr / wa; g[i] = wg / wa; b[i] = wb / wa; }', 'if (wa > 0) { r[i] = wr / area; g[i] = wg / area; b[i] = wb / area; }')]],
  ['resample: a transparent target pixel gets colour too', [E(PI, 'if (wa > 0) { r[i]', 'if (wa >= 0) { r[i]')]],
  ['resample: the pixel is stored with the wrong stride', [E(PI, 'const i = ty * w + tx;\n    a[i]', 'const i = tx * h + ty;\n    a[i]')]],
  // ---- toPixels ----
  ['toPixels: the alpha is not kept for the pixels', [E(PI, 'alpha[t] = pl.a[s];', 'alpha[t] = 255;')]],
  ['toPixels: the colour is not premultiplied by alpha', [E(PI, 'rgb[t * 3] = pl.r[s] * al;', 'rgb[t * 3] = pl.r[s];')]],
  ['toPixels: the green is not premultiplied by alpha', [E(PI, 'rgb[t * 3 + 1] = pl.g[s] * al;', 'rgb[t * 3 + 1] = pl.g[s];')]],
  ['toPixels: the blue is not premultiplied by alpha', [E(PI, 'rgb[t * 3 + 2] = pl.b[s] * al;', 'rgb[t * 3 + 2] = pl.b[s];')]],
  ['toPixels: the target pixel is offset one to the right', [E(PI, 't = (oy + y) * W + ox + x,', 't = (oy + y) * W + ox + x + 1,')]],
  ['EQUIVALENT: toPixels: a picture of the exact size goes through resample (a box of one source pixel per target pixel gives the same colours and alpha)', [E(PI, 'if (img.width === W && img.height === H) {', 'if (false) {')]],
  ['toPixels: the exact-size copy swaps green and blue', [E(PI, 'pl.g[i] = img.data[i * 4 + 1]; pl.b[i] = img.data[i * 4 + 2];', 'pl.g[i] = img.data[i * 4 + 2]; pl.b[i] = img.data[i * 4 + 1];')]],
  ['toPixels: the exact-size copy loses the alpha', [E(PI, 'pl.a[i] = img.data[i * 4 + 3];', 'pl.a[i] = 255;')]],
  ['toPixels: "fit" keeps the bars transparent', [E(PI, 'alpha.fill(255);', 'alpha.fill(0);')]],
  ['toPixels: "fit" scales by the larger ratio', [E(PI, "const s = Math.min(W / img.width, H / img.height), dw", "const s = Math.max(W / img.width, H / img.height), dw")]],
  ['toPixels: "fit" widths are cut, not rounded', [E(PI, 'Math.min(W, Math.round(img.width * s))', 'Math.min(W, Math.floor(img.width * s))')]],
  ['toPixels: "fit" heights are cut, not rounded', [E(PI, 'Math.min(H, Math.round(img.height * s))', 'Math.min(H, Math.floor(img.height * s))')]],
  ['toPixels: "fit" is not centred horizontally', [E(PI, 'Math.floor((W - dw) / 2), Math.floor((H - dh) / 2), dw, dh);', '0, Math.floor((H - dh) / 2), dw, dh);')]],
  ['toPixels: "fit" is not centred vertically', [E(PI, 'Math.floor((W - dw) / 2), Math.floor((H - dh) / 2), dw, dh);', 'Math.floor((W - dw) / 2), 0, dw, dh);')]],
  ['toPixels: "fit" centres with rounding up', [E(PI, 'Math.floor((W - dw) / 2), Math.floor((H - dh) / 2), dw, dh);', 'Math.ceil((W - dw) / 2), Math.floor((H - dh) / 2), dw, dh);')]],
  ['toPixels: "crop" scales by the smaller ratio', [E(PI, 'const s = Math.max(W / img.width, H / img.height), sw = W / s', 'const s = Math.min(W / img.width, H / img.height), sw = W / s')]],
  ['toPixels: "crop" cuts from the left edge', [E(PI, 'resample(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, W, H)', 'resample(img, 0, (img.height - sh) / 2, sw, sh, W, H)')]],
  ['toPixels: "crop" cuts from the top edge', [E(PI, 'resample(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, W, H)', 'resample(img, (img.width - sw) / 2, 0, sw, sh, W, H)')]],
  ['toPixels: "crop" does not fill the box', [E(PI, 'resample(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, W, H), 0, 0, W, H);', 'resample(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, W, H), 0, 0, W, H - 1);')]],
  ['toPixels: "stretch" is the default for an unknown mode and is cropped instead', [E(PI, '  } else {\n    put(resample(img, 0, 0, img.width, img.height, W, H), 0, 0, W, H);', '  } else {\n    put(resample(img, 0, 0, img.width - 1, img.height, W, H), 0, 0, W, H);')]],
  // ---- fitUnit ----
  ['EQUIVALENT: fitUnit: the distances of bright black are computed (the pair loop starts at colour 1 for BRIGHT, so colour 0 is in no pair; the skip only saves the distances)', [E(PI, 'if (br === 1 && c === 0 && !ctx.brightBlack) continue;', 'if (false) continue;')]],
  ['fitUnit: black is never allowed', [E(PI, 'if (br === 1 && c === 0 && !ctx.brightBlack) continue;', 'if (c === 0) continue;')]],
  ['fitUnit: bright black is skipped even when asked for', [E(PI, 'if (br === 1 && c === 0 && !ctx.brightBlack) continue;', 'if (br === 1 && c === 0) continue;')]],
  ['fitUnit: the pair loop starts at 1 for bright 0 too', [E(PI, 'const lo = br === 1 && !ctx.brightBlack ? 1 : 0;', 'const lo = !ctx.brightBlack ? 1 : 0;')]],
  ['fitUnit: the pair loop always starts at 1', [E(PI, 'const lo = br === 1 && !ctx.brightBlack ? 1 : 0;', 'const lo = 1;')]],
  ['fitUnit: the pair loop always starts at 0', [E(PI, 'const lo = br === 1 && !ctx.brightBlack ? 1 : 0;', 'const lo = 0;')]],
  ['fitUnit: a pair is (i, i) only below the diagonal', [E(PI, 'for (let j = i; j < 8; j++) {\n      let cost = 0;', 'for (let j = i + 1; j < 8; j++) {\n      let cost = 0;')]],
  ['EQUIVALENT: fitUnit: the pair loop does not make the pair (7, 7) (any pair (i, 7) costs no more and gives the same picture; a unit that only white fits is flat, and a flat unit is rewritten in one form)', [E(PI, 'for (let i = lo; i < 8; i++) for (let j = i; j < 8; j++) {', 'for (let i = lo; i < 7; i++) for (let j = i; j < 8; j++) {')]],
  ['fitUnit: the second colour never reaches 7', [E(PI, 'for (let i = lo; i < 8; i++) for (let j = i; j < 8; j++) {', 'for (let i = lo; i < 8; i++) for (let j = i; j < 7; j++) {')]],
  ['fitUnit: a one-colour cost is the minimum, not the sum', [E(PI, 'if (i === j) { for (let p = 0; p < n; p++) cost += D[oi + p]; }', 'if (i === j) { for (let p = 1; p < n; p++) cost += D[oi + p]; }')]],
  ['fitUnit: without a dither a pixel takes the farther colour', [E(PI, 'cost += da < db ? da : db; } }', 'cost += da < db ? db : da; } }')]],
  ['fitUnit: without a dither the segment is used', [E(PI, 'else if (!ctx.segment) {', 'else if (false) {')]],
  ['fitUnit: with a dither the nearer colour is used (no segment)', [E(PI, 'else if (!ctx.segment) {', 'else if (true) {')]],
  ['fitUnit: the projection is (da - l - db) / 2', [E(PI, 'dot = (da + l - db) * 0.5;', 'dot = (da - l - db) * 0.5;')]],
  ['fitUnit: the projection is not halved', [E(PI, 'dot = (da + l - db) * 0.5;', 'dot = (da + l - db);')]],
  ['fitUnit: t is not clamped above', [E(PI, 't = t < 0 ? 0 : t > 1 ? 1 : t;\n          cost += da', 't = t < 0 ? 0 : t;\n          cost += da')]],
  ['fitUnit: t is not clamped below', [E(PI, 't = t < 0 ? 0 : t > 1 ? 1 : t;\n          cost += da', 't = t > 1 ? 1 : t;\n          cost += da')]],
  ['fitUnit: the distance to the segment is da - 2 t dot - t t l', [E(PI, 'cost += da - 2 * t * dot + t * t * l;', 'cost += da - 2 * t * dot - t * t * l;')]],
  ['fitUnit: the distance to the segment drops the t t l term', [E(PI, 'cost += da - 2 * t * dot + t * t * l;', 'cost += da - 2 * t * dot;')]],
  ['fitUnit: the tie-break prefers the farther pair', [E(PI, 'cost += 1e-6 * l;', 'cost -= 1e-6 * l;')]],
  ['fitUnit: there is no tie-break', [E(PI, 'cost += 1e-6 * l;', 'cost += 0;')]],
  ['fitUnit: a cost equal within 1e-9 replaces the best', [E(PI, 'if (!best || cost < best.cost - 1e-9)', 'if (!best || cost <= best.cost + 1e-9)')]],
  ['fitUnit: the best is the most expensive', [E(PI, 'if (!best || cost < best.cost - 1e-9)', 'if (!best || cost > best.cost + 1e-9)')]],
  ['fitUnit: the pair is returned as (b, a)', [E(PI, 'best = { cost, a: i, b: j, bright: br };', 'best = { cost, a: j, b: i, bright: br };')]],
  ['fitUnit: the brightness is not recorded', [E(PI, 'best = { cost, a: i, b: j, bright: br };', 'best = { cost, a: i, b: j, bright: 0 };')]],
  ['fitUnit: the distance uses the blue weight for green', [E(PI, 'D[o + p] = W3[0] * dr * dr + W3[1] * dg * dg + W3[2] * db * db;', 'D[o + p] = W3[0] * dr * dr + W3[2] * dg * dg + W3[1] * db * db;')]],
  ['fitUnit: the pixel is read with a stride of 2', [E(PI, 'const q = idx[p] * 3, dr', 'const q = idx[p] * 2, dr')]],
  // ---- flatInk ----
  ['flatInk: a white flat cell gets white ink', [E(PI, 'const flatInk = (colour, bright) => (colour === 7 ? (bright ? 1 : 0) : 7);', 'const flatInk = (colour, bright) => (colour === 7 ? 7 : 7);')]],
  ['flatInk: a bright white flat cell gets ink black', [E(PI, '(colour === 7 ? (bright ? 1 : 0) : 7)', '(colour === 7 ? 0 : 7)')]],
  ['flatInk: a white flat cell gets ink 1 in both brightnesses', [E(PI, '(colour === 7 ? (bright ? 1 : 0) : 7)', '(colour === 7 ? 1 : 7)')]],
  ['flatInk: another colour gets ink 0', [E(PI, '(colour === 7 ? (bright ? 1 : 0) : 7)', '(colour === 7 ? (bright ? 1 : 0) : 0)')]],
  // ---- quantizeToCells: options, validation ----
  ['quantize: an empty picture is not refused', [E(PI, "if (!isImg(img)) throw new Error('the picture is empty or damaged');", '')]],
  ['quantize: cols 0 is accepted', [E(PI, 'cols < 1 || rows < 1', 'cols < 0 || rows < 1')]],
  ['quantize: rows 0 is accepted', [E(PI, 'cols < 1 || rows < 1', 'cols < 1 || rows < 0')]],
  ['quantize: cols 64 is refused', [E(PI, 'cols > MAX_CELLS_SIDE || rows > MAX_CELLS_SIDE', 'cols >= MAX_CELLS_SIDE || rows > MAX_CELLS_SIDE')]],
  ['quantize: rows 64 is refused', [E(PI, 'cols > MAX_CELLS_SIDE || rows > MAX_CELLS_SIDE', 'cols > MAX_CELLS_SIDE || rows >= MAX_CELLS_SIDE')]],
  ['quantize: a fractional cols is accepted', [E(PI, '!Number.isInteger(cols) || !Number.isInteger(rows)', '!Number.isFinite(cols) || !Number.isInteger(rows)')]],
  ['quantize: a fractional rows is accepted', [E(PI, '!Number.isInteger(cols) || !Number.isInteger(rows)', '!Number.isInteger(cols) || !Number.isFinite(rows)')]],
  ['quantize: the default dither is none', [E(PI, "const dither = opts.dither ?? 'diffusion';", "const dither = opts.dither ?? 'none';")]],
  ['quantize: an unknown dither is accepted', [E(PI, 'if (!DITHERS.includes(dither)) throw', 'if (false) throw')]],
  ['quantize: the default alpha threshold is 129', [E(PI, 'thr = opts.alphaThreshold ?? 128;', 'thr = opts.alphaThreshold ?? 129;')]],
  ['quantize: the default alpha threshold is 127', [E(PI, 'thr = opts.alphaThreshold ?? 128;', 'thr = opts.alphaThreshold ?? 127;')]],
  ['quantize: the default fit is "fit"', [E(PI, "opts.fit ?? 'stretch'", "opts.fit ?? 'fit'")]],
  ['quantize: the fine option is ignored', [E(PI, 'const fine = !!opts.fine,', 'const fine = false,')]],
  ['quantize: the palette is ignored', [E(PI, 'const tab = colourTable(opts.palette);\n  const W = cols * 8', 'const tab = colourTable();\n  const W = cols * 8')]],
  ['quantize: the picture is W = cols * 4', [E(PI, 'const W = cols * 8, H = rows * 8, N = W * H;', 'const W = cols * 4, H = rows * 8, N = W * H;')]],
  ['quantize: bright black candidates use brightness 0 for both', [E(PI, 'tab[colourKey(c, br)]', 'tab[colourKey(c, 0)]')]],
  ['quantize: the colour distance table L is always 0', [E(PI, 'l[i * 8 + j] = dist(cs[i], cs[j]);', 'l[i * 8 + j] = 0;')]],
  ['quantize: a brightness option 0 is ignored', [E(PI, 'brights: opts.bright === 0 || opts.bright === 1 ? [opts.bright] : [0, 1]', 'brights: opts.bright === 1 ? [opts.bright] : [0, 1]')]],
  ['quantize: a brightness option 1 is ignored', [E(PI, 'brights: opts.bright === 0 || opts.bright === 1 ? [opts.bright] : [0, 1]', 'brights: opts.bright === 0 ? [opts.bright] : [0, 1]')]],
  ['quantize: the brights are tried bright first', [E(PI, ': [0, 1], brightBlack:', ': [1, 0], brightBlack:')]],
  ['quantize: bright black is always allowed', [E(PI, 'brightBlack: !!opts.brightBlack,', 'brightBlack: true,')]],
  ['quantize: the segment rule applies without a dither too', [E(PI, "segment: dither !== 'none' }", 'segment: true }')]],
  ['quantize: the segment rule is off for the ordered dither', [E(PI, "segment: dither !== 'none' }", "segment: dither === 'diffusion' }")]],
  ['quantize: a fine picture has 4 units a cell', [E(PI, 'const perCell = fine ? 8 : 1, perRow = fine ? 8 : 64;', 'const perCell = fine ? 4 : 1, perRow = fine ? 8 : 64;')]],
  ['quantize: a fine unit has 7 pixels', [E(PI, 'perRow = fine ? 8 : 64;', 'perRow = fine ? 7 : 64;')]],
  ['quantize: a cell with an opaque pixel exactly at the threshold is transparent', [E(PI, 'alpha[(cy * 8 + y) * W + cx * 8 + x] >= thr) opaque++', 'alpha[(cy * 8 + y) * W + cx * 8 + x] > thr) opaque++')]],
  ['quantize: transparent cells are always blank', [E(PI, 'if (opts.transparentCells !== false && opaque === 0)', 'if (opaque === 0)')]],
  ['quantize: transparent cells are never blank', [E(PI, 'if (opts.transparentCells !== false && opaque === 0)', 'if (false)')]],
  ['quantize: a cell with one opaque pixel is blank', [E(PI, 'opaque === 0) { blank[cell] = 1; continue; }', 'opaque <= 1) { blank[cell] = 1; continue; }')]],
  ['EQUIVALENT: quantize: the unit pixels of a normal cell are listed column by column (the same 64 pixels; the costs are sums, and the order of adding does not change a result)', [E(PI, 'const x = fine ? k : k & 7, y = fine ? u : k >> 3;', 'const x = fine ? k : k >> 3, y = fine ? u : k & 7;')]],
  ['quantize: a fine unit reads row 0 always', [E(PI, 'const x = fine ? k : k & 7, y = fine ? u : k >> 3;', 'const x = fine ? k : k & 7, y = fine ? 0 : k >> 3;')]],
  ['quantize: the unit pixel index uses the cell column twice', [E(PI, 'idx[n++] = (cy * 8 + y) * W + cx * 8 + x;', 'idx[n++] = (cy * 8 + y) * W + cy * 8 + x;')]],
  ['quantize: the unit pair is stored at the cell index only', [E(PI, 'const f = fitUnit(px, idx, n, ctx, D), at = cell * perCell + u;', 'const f = fitUnit(px, idx, n, ctx, D), at = cell;')]],
  ['quantize: the stored brightness is lost', [E(PI, 'ua[at] = f.a; ub[at] = f.b; ubr[at] = f.bright;', 'ua[at] = f.a; ub[at] = f.b;')]],
  // ---- pass 2 ----
  ['quantize: the diffusion is not serpentine', [E(PI, "back = dither === 'diffusion' && (y & 1) === 1;", 'back = false;')]],
  ['quantize: the serpentine turns on even rows', [E(PI, "back = dither === 'diffusion' && (y & 1) === 1;", "back = dither === 'diffusion' && (y & 1) === 0;")]],
  ['EQUIVALENT: quantize: the serpentine turns for the ordered dither too (the ordered dither keeps no error: the order of the pixels of a row does not matter)', [E(PI, "back = dither === 'diffusion' && (y & 1) === 1;", "back = dither !== 'none' && (y & 1) === 1;")]],
  ['quantize: the next error row is not cleared', [E(PI, 'nxt.fill(0);', '')]],
  ['quantize: a blank cell is dithered too', [E(PI, 'if (blank[cell]) continue;\n      const u', 'if (false) continue;\n      const u')]],
  ['quantize: a fine pixel row uses the first unit of its cell', [E(PI, 'const u = cell * perCell + (fine ? ry : 0),', 'const u = cell * perCell + 0,')]],
  ['quantize: the error is added after the diffusion clamp', [E(PI, 'v0 += cur[e]; v1 += cur[e + 1]; v2 += cur[e + 2];', 'v0 += cur[e]; v1 += cur[e + 1];')]],
  ['quantize: the diffused value is not clamped to 0 below', [E(PI, 'v0 = v0 < 0 ? 0 : v0 > 255 ? 255 : v0;', 'v0 = v0 > 255 ? 255 : v0;')]],
  ['quantize: the diffused value is not clamped to 255 above', [E(PI, 'v0 = v0 < 0 ? 0 : v0 > 255 ? 255 : v0;', 'v0 = v0 < 0 ? 0 : v0;')]],
  ['quantize: the diffused green is not clamped', [E(PI, 'v1 = v1 < 0 ? 0 : v1 > 255 ? 255 : v1;', '')]],
  ['quantize: the diffused blue is not clamped', [E(PI, 'v2 = v2 < 0 ? 0 : v2 > 255 ? 255 : v2;', '')]],
  ['quantize: a two-colour pair is always colour A (no pick)', [E(PI, 'if (ua[u] !== ub[u]) {\n        if (dither', 'if (false) {\n        if (dither')]],
  ['EQUIVALENT: quantize: a unit of one colour runs the pick too (both colours are the same: the distances are equal, a tie takes A; the ordered projection is 0 / 0 = NaN, which is never above a threshold)', [E(PI, 'if (ua[u] !== ub[u]) {', 'if (ua[u] === ub[u] || true) {')]],
  ['EQUIVALENT: quantize: the ordered dither projection is not clamped above 1 (every threshold is below 1, so t > 1 and t = 1 both pick B)', [E(PI, 't = t < 0 ? 0 : t > 1 ? 1 : t;\n          pickB = t >', 't = t < 0 ? 0 : t;\n          pickB = t >')]],
  ['EQUIVALENT: quantize: the ordered dither projection is not clamped below 0 (every threshold is above 0, so t < 0 and t = 0 both pick A)', [E(PI, 't = t < 0 ? 0 : t > 1 ? 1 : t;\n          pickB = t >', 't = t > 1 ? 1 : t;\n          pickB = t >')]],
  ['quantize: the ordered threshold has no 0.5 offset', [E(PI, 'pickB = t > (BAYER4[y & 3][x & 3] + 0.5) / 16 ? 1 : 0;', 'pickB = t > (BAYER4[y & 3][x & 3]) / 16 ? 1 : 0;')]],
  ['quantize: the ordered threshold uses >= ', [E(PI, 'pickB = t > (BAYER4[y & 3][x & 3] + 0.5) / 16 ? 1 : 0;', 'pickB = t >= (BAYER4[y & 3][x & 3] + 0.5) / 16 ? 1 : 0;')]],
  ['quantize: the ordered threshold reads the matrix transposed', [E(PI, 'BAYER4[y & 3][x & 3]', 'BAYER4[x & 3][y & 3]')]],
  ['quantize: the ordered threshold divides by 15', [E(PI, '(BAYER4[y & 3][x & 3] + 0.5) / 16', '(BAYER4[y & 3][x & 3] + 0.5) / 15')]],
  ['quantize: the projection ignores the blue axis', [E(PI, '+ (v2 - A[2]) * az) / len;', ') / len;')]],
  ['quantize: the projection ignores the green axis', [E(PI, '(v1 - A[1]) * ay + (v2', '(v2')]],
  ['quantize: the projection length ignores green', [E(PI, 'len = ax * ax + ay * ay + az * az;', 'len = ax * ax + az * az;')]],
  ['quantize: the nearest-colour pick is the farther', [E(PI, 'pickB = db < da ? 1 : 0;', 'pickB = db > da ? 1 : 0;')]],
  ['quantize: a tie in the nearest-colour pick takes B', [E(PI, 'pickB = db < da ? 1 : 0;', 'pickB = db <= da ? 1 : 0;')]],
  ['quantize: the nearest-colour distance uses the unweighted green', [E(PI, 'const da = W3[0] * (v0 - A[0]) ** 2 + W3[1] * (v1 - A[1]) ** 2', 'const da = W3[0] * (v0 - A[0]) ** 2 + 1 * (v1 - A[1]) ** 2')]],
  ['quantize: the nearest-colour distance to B uses the weights of blue for red', [E(PI, 'const db = W3[0] * (v0 - B[0]) ** 2', 'const db = W3[2] * (v0 - B[0]) ** 2')]],
  ['quantize: the error is not diffused ahead (half)', [E(PI, 'cur[e + f] += e0 * 0.5;', 'cur[e + f] += e0 * 0.25;')]],
  ['quantize: the error ahead loses green', [E(PI, 'cur[e + f + 1] += e1 * 0.5;', 'cur[e + f + 1] += 0;')]],
  ['quantize: the error ahead loses blue', [E(PI, 'cur[e + f + 2] += e2 * 0.5;', 'cur[e + f + 2] += 0;')]],
  ['quantize: the error below-behind is a half', [E(PI, 'nxt[e - f] += e0 * 0.25;', 'nxt[e - f] += e0 * 0.5;')]],
  ['quantize: the error below loses red', [E(PI, 'nxt[e] += e0 * 0.25;', 'nxt[e] += 0;')]],
  ['quantize: the error below-behind goes the same way as ahead', [E(PI, 'nxt[e - f] += e0 * 0.25; nxt[e - f + 1]', 'nxt[e + f] += e0 * 0.25; nxt[e - f + 1]')]],
  ['quantize: the error is taken against the other colour', [E(PI, 'const C = pickB ? B : A, e0', 'const C = pickB ? A : B, e0')]],
  ['quantize: the error direction is not reversed on a back row', [E(PI, 'const f = (back ? -1 : 1) * 3;', 'const f = 3;')]],
  ['quantize: the error rows are not swapped', [E(PI, 'const t = cur; cur = nxt; nxt = t;', '')]],
  ['EQUIVALENT: quantize: the error buffers are one pixel short (the border entries are written by the first and last pixel of a row and never read; a write past the end of a typed array is dropped)', [E(PI, 'errA = new Float32Array((W + 2) * 3), errB = new Float32Array((W + 2) * 3);', 'errA = new Float32Array((W + 1) * 3), errB = new Float32Array((W + 1) * 3);')]],
  // ---- pass 3 ----
  ['quantize: the ink is the majority colour', [E(PI, 'const inkIsB = nb * 2 <= n;', 'const inkIsB = nb * 2 > n;')]],
  ['quantize: a tie makes A the ink', [E(PI, 'const inkIsB = nb * 2 <= n;', 'const inkIsB = nb * 2 < n;')]],
  ['quantize: the bits count the other colour', [E(PI, 'if (inkIsB ? isB : !isB) v |= 0x80 >>> x;', 'if (inkIsB ? !isB : isB) v |= 0x80 >>> x;')]],
  ['quantize: the leftmost pixel is bit 0', [E(PI, 'v |= 0x80 >>> x;', 'v |= 1 << x;')]],
  ['quantize: a fine cell counts the pixels of all rows', [E(PI, 'for (let y = fine ? u : 0; y < (fine ? u + 1 : 8); y++) for (let x = 0; x < 8; x++) { nb +=', 'for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { nb +=')]],
  ['quantize: the paper and ink of a unit are swapped', [E(PI, 'unitInk[u] = inkIsB ? b : a; unitPaper[u] = inkIsB ? a : b;', 'unitInk[u] = inkIsB ? a : b; unitPaper[u] = inkIsB ? b : a;')]],
  ['quantize: the row colours use unit 0 in fine mode', [E(PI, 'const u = fine ? y : 0, at = cell * perCell + u;\n      rowc[y]', 'const u = 0, at = cell * perCell + u;\n      rowc[y]')]],
  ['quantize: the brightness of a row comes from unit 0', [E(PI, 'bright: ubr[at] };\n    }\n    cells[cell]', 'bright: ubr[cell * perCell] };\n    }\n    cells[cell]')]],
  ['quantize: a blank cell is not marked blank', [E(PI, 'if (blank[cell]) { cells[cell] = { blank: true }; continue; }', 'if (blank[cell]) { cells[cell] = { blank: false }; continue; }')]],
  ['quantize: the cell grid is returned transposed', [E(PI, 'return { cols, rows, fine, cells };', 'return { cols: rows, rows: cols, fine, cells };')]],
  ['quantize: the fine flag is not returned', [E(PI, 'return { cols, rows, fine, cells };', 'return { cols, rows, fine: false, cells };')]],
  // ---- finishCell ----
  ['finishCell: the keys use the other colour for a set bit', [E(PI, 'colourKey((bits[y] >>> (7 - x)) & 1 ? c.ink : c.paper, c.bright)', 'colourKey((bits[y] >>> (7 - x)) & 1 ? c.paper : c.ink, c.bright)')]],
  ['finishCell: the keys are mirrored', [E(PI, '(bits[y] >>> (7 - x)) & 1', '(bits[y] >>> x) & 1')]],
  ['EQUIVALENT: finishCell: a row of all ink is not flat (the ink is the colour of the fewer pixels, so a row never has more than half of its pixels set: bits 0xFF cannot occur)', [E(PI, 'const flatRow = (y) => bits[y] === 0 || bits[y] === 0xFF;', 'const flatRow = (y) => bits[y] === 0;')]],
  ['finishCell: a row of all paper is not flat', [E(PI, 'const flatRow = (y) => bits[y] === 0 || bits[y] === 0xFF;', 'const flatRow = (y) => bits[y] === 0xFF;')]],
  ['EQUIVALENT: finishCell: a flat fine row keeps its bits (a flat row has bits 0 already: see above)', [E(PI, 'bits[y] = 0; rowc[y] = { ink: flatInk(c, br), paper: c, bright: br };\n    }\n  } else if', 'rowc[y] = { ink: flatInk(c, br), paper: c, bright: br };\n    }\n  } else if')]],
  ['EQUIVALENT: finishCell: a flat fine row reads the key of its last pixel (the row is flat: all eight keys are the same)', [E(PI, 'const k = keys[y * 8], c = k === 0 ? 0 : k & 7, br = k === 0 ? 0 : k >> 3;\n      bits[y] = 0;', 'const k = keys[y * 8 + 7], c = k === 0 ? 0 : k & 7, br = k === 0 ? 0 : k >> 3;\n      bits[y] = 0;')]],
  ['EQUIVALENT: finishCell: a black flat row is read with k >> 3 (black is key 0 in every cell: colourKey makes BRIGHT black key 0, so k >> 3 is 0 as well)', [E(PI, 'const k = keys[y * 8], c = k === 0 ? 0 : k & 7, br = k === 0 ? 0 : k >> 3;', 'const k = keys[y * 8], c = k & 7, br = k >> 3;')]],
  ['finishCell: a flat row is not written with its flat ink', [E(PI, 'bits[y] = 0; rowc[y] = { ink: flatInk(c, br), paper: c, bright: br };\n    }\n  } else if', 'bits[y] = 0; rowc[y] = { ink: c, paper: c, bright: br };\n    }\n  } else if')]],
  ['finishCell: a cell of one colour is not made flat', [E(PI, '} else if (keys.every((k) => k === keys[0])) {', '} else if (false) {')]],
  ['finishCell: a cell of two colours is made flat (any key equal to the first)', [E(PI, '} else if (keys.every((k) => k === keys[0])) {', '} else if (keys.some((k) => k === keys[0])) {')]],
  ['EQUIVALENT: finishCell: the flat cell reads the key of pixel 1 (the test is that all 64 keys are equal, so every key is the same)', [E(PI, 'const k = keys[0], c = k === 0 ? 0 : k & 7, br = k === 0 ? 0 : k >> 3;\n    for', 'const k = keys[1], c = k === 0 ? 0 : k & 7, br = k === 0 ? 0 : k >> 3;\n    for')]],
  ['finishCell: a fine cell is made flat as a whole', [E(PI, 'if (fine) {\n    for (let y = 0; y < 8; y++) if (flatRow(y)) {', 'if (false) {\n    for (let y = 0; y < 8; y++) if (flatRow(y)) {')]],
  ['finishCell: the flat cell colours only 7 rows', [E(PI, 'for (let y = 0; y < 8; y++) { bits[y] = 0; rowc[y] = { ink: flatInk(c, br), paper: c, bright: br }; }', 'for (let y = 0; y < 7; y++) { bits[y] = 0; rowc[y] = { ink: flatInk(c, br), paper: c, bright: br }; }')]],
  // ---- keyString, tileOfCell ----
  ['keyString: the key is not offset (key 0 is the same as key 65)', [E(PI, 'String.fromCharCode(65 + keys[i])', 'String.fromCharCode(65 + (keys[i] & 7))')]],
  ['keyString: only 63 pixels are compared', [E(PI, 'for (let i = 0; i < 64; i++) s += String.fromCharCode', 'for (let i = 0; i < 63; i++) s += String.fromCharCode')]],
  ['tileOfCell: the tile has the colours of the last row', [E(PI, 'const c0 = cell.rows[0],', 'const c0 = cell.rows[7],')]],
  ['EQUIVALENT: tileOfCell: the tile\'s bits are the cell\'s array, not a copy (nothing writes to a cell after the build; only aliasing differs)', [E(PI, 't.bits = cell.bits.slice();', 't.bits = cell.bits;')]],
  ['tileOfCell: a cell with row colours has none', [E(PI, 'if (cell.rows.some((c) => c.ink !== c0.ink || c.paper !== c0.paper || c.bright !== c0.bright)) t.rowColours', 'if (false) t.rowColours')]],
  ['tileOfCell: every cell gets row colours', [E(PI, 'if (cell.rows.some((c) => c.ink !== c0.ink || c.paper !== c0.paper || c.bright !== c0.bright)) t.rowColours', 'if (true) t.rowColours')]],
  ['tileOfCell: a difference in ink alone is not noticed', [E(PI, 'c.ink !== c0.ink || c.paper !== c0.paper || c.bright !== c0.bright', 'c.paper !== c0.paper || c.bright !== c0.bright')]],
  ['tileOfCell: a difference in paper alone is not noticed', [E(PI, 'c.ink !== c0.ink || c.paper !== c0.paper || c.bright !== c0.bright', 'c.ink !== c0.ink || c.bright !== c0.bright')]],
  ['tileOfCell: a difference in brightness alone is not noticed', [E(PI, 'c.ink !== c0.ink || c.paper !== c0.paper || c.bright !== c0.bright', 'c.ink !== c0.ink || c.paper !== c0.paper')]],
  ['tileOfCell: the foreground mark is not set', [E(PI, 'if (foreground) { t.fg = true; t.hadFg = true; }', 'if (foreground) { t.fg = true; }')]],
  ['tileOfCell: the foreground mark is always set', [E(PI, 'if (foreground) { t.fg = true; t.hadFg = true; }', 'if (true) { t.fg = true; t.hadFg = true; }')]],
  // ---- reducePictures ----
  ['EQUIVALENT: reduce: the colour distance table is cut, not rounded (the weights and the 8-bit palette colours make every distance a whole number; a palette with fractional colours would differ)', [E(PI, 'dk[a * 16 + b] = Math.round(dist(tab[a], tab[b]));', 'dk[a * 16 + b] = Math.floor(dist(tab[a], tab[b]));')]],
  ['reduce: the distance table is indexed a * 15', [E(PI, 'dk[a * 16 + b]', 'dk[a * 15 + b]')]],
  ['reduce: the distance of a pair is not symmetric', [E(PI, 'd[i * n + j] = d[j * n + i] = s;', 'd[i * n + j] = s;')]],
  ['reduce: the sum stops at 63 pixels', [E(PI, 'for (let k = 0; k < 64; k++) s += dk[pi[k] + pj[k]];', 'for (let k = 0; k < 63; k++) s += dk[pi[k] + pj[k]];')]],
  ['reduce: the cost is the distance only (no weight)', [E(PI, 'cost = (w[i] * w[u] / (w[i] + w[u])) * nd[i];', 'cost = nd[i];')]],
  ['reduce: the cost uses the sum of weights as a product', [E(PI, 'cost = (w[i] * w[u] / (w[i] + w[u])) * nd[i];', 'cost = (w[i] * w[u]) * nd[i];')]],
  ['reduce: the picture of the highest cost is merged', [E(PI, 'if (cost < bc) { bc = cost; v = i; }', 'if (cost > bc || bc === Infinity) { bc = cost; v = i; }')]],
  ['reduce: the merged picture does not pass its weight on', [E(PI, 'w[u] += w[v]; left--;', 'left--;')]],
  ['reduce: the loop stops one picture early', [E(PI, 'while (left > target) {', 'while (left > target + 1) {')]],
  ['reduce: the loop goes one picture too far', [E(PI, 'while (left > target) {', 'while (left >= target) {')]],
  ['reduce: nearest neighbours are not recomputed after a merge', [E(PI, 'for (let i = 0; i < n; i++) if (alive[i] && nn[i] === v) nearest(i);', '')]],
  ['reduce: the nearest search accepts itself', [E(PI, 'if (alive[j] && j !== i && d[o + j] < bd)', 'if (alive[j] && d[o + j] < bd)')]],
  ['reduce: the nearest search accepts a merged picture', [E(PI, 'if (alive[j] && j !== i && d[o + j] < bd)', 'if (j !== i && d[o + j] < bd)')]],
  ['reduce: the nearest search takes a tie', [E(PI, 'j !== i && d[o + j] < bd) { bd', 'j !== i && d[o + j] <= bd) { bd')]],
  ['reduce: a merged picture does not point to its target', [E(PI, 'alive[v] = 0; rep[v] = u;', 'alive[v] = 0;')]],
  ['reduce: the final picture is not followed through the chain', [E(PI, 'const final = (i) => { while (rep[i] !== i) i = rep[i]; return i; };', 'const final = (i) => rep[i];')]],
  // ---- buildTiles ----
  ['buildTiles: the default limit is 127', [E(PI, 'const maxTiles = opts.maxTiles ?? T.MAX_TILES;', 'const maxTiles = opts.maxTiles ?? 127;')]],
  ['buildTiles: the default limit is 129', [E(PI, 'const maxTiles = opts.maxTiles ?? T.MAX_TILES;', 'const maxTiles = opts.maxTiles ?? 129;')]],
  ['buildTiles: the existing tiles are ignored', [E(PI, 'const existing = opts.existing?.tiles ?? [], base = existing.length;', 'const existing = [], base = 0;')]],
  ['buildTiles: a flagged tile may be reused', [E(PI, 'if (t.flags === 0 && !t.fg) {', 'if (!t.fg) {')]],
  ['buildTiles: a foreground tile may be reused', [E(PI, 'if (t.flags === 0 && !t.fg) {', 'if (t.flags === 0) {')]],
  ['buildTiles: the existing tile is read with the wrong fine flag', [E(PI, 'keyString(T.tilePixels(t, { fine: grid.fine }))', 'keyString(T.tilePixels(t, { fine: !grid.fine }))')]],
  ['buildTiles: the last of equal existing tiles is used', [E(PI, 'if (!have.has(k)) have.set(k, i);', 'have.set(k, i);')]],
  ['buildTiles: a blank cell is counted as a picture', [E(PI, 'if (c.blank) { blankCells++; return; }', 'if (c.blank) { blankCells++; }')]],
  ['buildTiles: a reused cell is not counted', [E(PI, 'if (have.has(k)) { cellOld[i] = have.get(k); reused++; return; }', 'if (have.has(k)) { cellOld[i] = have.get(k); return; }')]],
  ['buildTiles: a reused cell is also a new picture', [E(PI, 'if (have.has(k)) { cellOld[i] = have.get(k); reused++; return; }', 'if (have.has(k)) { cellOld[i] = have.get(k); reused++; }')]],
  ['buildTiles: the first appearance does not order the pictures', [E(PI, 'p = pics.length; seen.set(k, p); pics.push(c.keys);', 'p = 0; seen.set(k, p); pics.push(c.keys);')]],
  ['buildTiles: the weight of a repeated cell is not counted', [E(PI, 'weight[p]++;', '')]],
  ['buildTiles: the distinct count ignores reused tiles', [E(PI, 'const distinct = seen.size + new Set(cellOld.filter((v) => v >= 0)).size;', 'const distinct = seen.size;')]],
  ['buildTiles: the distinct count counts each reused cell', [E(PI, 'new Set(cellOld.filter((v) => v >= 0)).size', 'cellOld.filter((v) => v >= 0).length')]],
  ['buildTiles: the merged count includes the blanks', [E(PI, 'const merged = (total - blankCells) - distinct;', 'const merged = total - distinct;')]],
  ['buildTiles: the needed count ignores the existing tiles', [E(PI, 'const needed = base + pics.length;', 'const needed = pics.length;')]],
  ['buildTiles: exactly the limit overflows', [E(PI, 'const overflow = needed > maxTiles;', 'const overflow = needed >= maxTiles;')]],
  ['buildTiles: one over the limit does not overflow', [E(PI, 'const overflow = needed > maxTiles;', 'const overflow = needed > maxTiles + 1;')]],
  ['buildTiles: the room is the limit', [E(PI, 'const room = Math.max(0, maxTiles - base);', 'const room = maxTiles;')]],
  ['buildTiles: the room can be negative', [E(PI, 'const room = Math.max(0, maxTiles - base);', 'const room = maxTiles - base;')]],
  ['buildTiles: no room and existing tiles: the reduce is used anyway', [E(PI, 'if (overflow && room === 0 && existing.length) {', 'if (false) {')]],
  ['EQUIVALENT: buildTiles: no room and no existing tiles takes the nearest existing tile (only for maxTiles 0 with no set, which no editor offers; the result there is already not a usable set: one tile of a limit of 0)', [E(PI, 'if (overflow && room === 0 && existing.length) {', 'if (overflow && room === 0) {')]],
  ['buildTiles: with some room the picture is not reduced', [E(PI, '} else if (overflow) final = reducePictures(pics, weight, room, tab);', '} else if (false) final = reducePictures(pics, weight, room, tab);')]],
  ['buildTiles: the reduction targets the limit, not the room', [E(PI, 'final = reducePictures(pics, weight, room, tab);', 'final = reducePictures(pics, weight, maxTiles, tab);')]],
  ['buildTiles: the nearest existing tile is the farthest', [E(PI, 'if (s < bd) { bd = s; bi = i; } });', 'if (s > bd || bd === Infinity) { bd = s; bi = i; } });')]],
  ['buildTiles: the nearest existing tile is the first', [E(PI, 'if (s < bd) { bd = s; bi = i; } });', 'if (bd === Infinity) { bd = s; bi = i; } });')]],
  ['buildTiles: the nearest existing tile uses the fine flag the other way', [E(PI, 'const tk = T.tilePixels(t, { fine: grid.fine }); let s = 0;', 'const tk = T.tilePixels(t, { fine: !grid.fine }); let s = 0;')]],
  ['buildTiles: the nearest existing tile compares 63 pixels', [E(PI, 'for (let k = 0; k < 64; k++) s += dist(tab[keys[k]], tab[tk[k]]);', 'for (let k = 0; k < 63; k++) s += dist(tab[keys[k]], tab[tk[k]]);')]],
  ['buildTiles: the new tiles are numbered from 0', [E(PI, 'number[p] = base + tiles.length;', 'number[p] = tiles.length;')]],
  ['buildTiles: a merged picture still gets a tile', [E(PI, 'if (final[p] === p) { number[p]', 'if (true) { number[p]')]],
  ['buildTiles: the foreground flag is not passed', [E(PI, 'tileOfCell(first[p], !!opts.foreground)', 'tileOfCell(first[p], false)')]],
  ['buildTiles: the blank cells are tile 0', [E(PI, 'const map = new Uint8Array(total).fill(255);', 'const map = new Uint8Array(total).fill(0);')]],
  ['buildTiles: a reused cell takes tile 0', [E(PI, 'if (cellOld[i] >= 0) map[i] = cellOld[i];', 'if (cellOld[i] >= 0) map[i] = 0;')]],
  ['buildTiles: a merged cell takes its own picture\'s number', [E(PI, 'else { map[i] = number[final[p]]; if (final[p] !== p) lossyCells++; }', 'else { map[i] = number[p]; if (final[p] !== p) lossyCells++; }')]],
  ['buildTiles: a merged cell is not counted as lossy', [E(PI, 'if (final[p] !== p) lossyCells++; }', '}')]],
  ['buildTiles: every cell is counted as lossy', [E(PI, 'if (final[p] !== p) lossyCells++; }', 'lossyCells++; }')]],
  ['buildTiles: a cell of the nearest-existing path is not counted as lossy', [E(PI, 'map[i] = nearestOld[p]; lossyCells++; }', 'map[i] = nearestOld[p]; }')]],
  ['buildTiles: the lossy tiles are counted from the new tiles', [E(PI, 'const lossyTiles = nearestOld ? pics.length : pics.length - tiles.length;', 'const lossyTiles = nearestOld ? pics.length : tiles.length;')]],
  ['buildTiles: the lossy tiles of the nearest-existing path are 0', [E(PI, 'const lossyTiles = nearestOld ? pics.length :', 'const lossyTiles = nearestOld ? 0 :')]],
  ['buildTiles: the grid size is swapped in the result', [E(PI, 'cols: grid.cols, rows: grid.rows, cells: total', 'cols: grid.rows, rows: grid.cols, cells: total')]],
  // ---- describeImport ----
  ['describeImport: one cell is "cells"', [E(PI, "`${n} ${w}${n === 1 ? '' : 's'}`", "`${n} ${w}s`")]],
  ['describeImport: zero is singular', [E(PI, "n === 1 ? '' : 's'}`;\n  const parts", "n <= 1 ? '' : 's'}`;\n  const parts")]],
  ['describeImport: the cell count includes the blanks', [E(PI, "s(r.cells - r.blankCells, 'cell')", "s(r.cells, 'cell')")]],
  ['describeImport: the tile count is the base', [E(PI, "became ${s(nt, 'new tile')}", "became ${s(r.base, 'new tile')}")]],
  ['describeImport: the reused sentence is always there', [E(PI, 'if (r.reused) parts.push(', 'if (true) parts.push(')]],
  ['describeImport: a single reused cell says "use"', [E(PI, "use${r.reused === 1 ? 's' : ''}", "use${r.reused === 1 ? '' : 's'}")]],
  ['describeImport: the merged sentence needs two', [E(PI, 'if (r.merged > 0) parts.push', 'if (r.merged > 1) parts.push')]],
  ['describeImport: the merged sentence is always there', [E(PI, 'if (r.merged > 0) parts.push', 'if (true) parts.push')]],
  ['describeImport: the blank sentence is missing', [E(PI, "if (r.blankCells) parts.push(`${s(r.blankCells, 'transparent cell')} left blank`);", '')]],
  ['describeImport: the parts are joined with commas', [E(PI, "let text = parts.join('; ') + '.';", "let text = parts.join(', ') + '.';")]],
  ['describeImport: the overflow sentence is always there', [E(PI, 'if (r.overflow) text +=', 'if (true) text +=')]],
  ['describeImport: the overflow sentence is missing', [E(PI, 'if (r.overflow) text +=', 'if (false) text +=')]],
  ['describeImport: the overflow names the limit as needed', [E(PI, 'It needs ${r.needed} tiles but the limit is ${r.maxTiles}:', 'It needs ${r.maxTiles} tiles but the limit is ${r.needed}:')]],
  ['describeImport: the lossy cells and pictures are swapped', [E(PI, "${s(r.lossyCells, 'cell')} (${s(r.lossyTiles, 'picture')})", "${s(r.lossyTiles, 'cell')} (${s(r.lossyCells, 'picture')})")]],
  // ---- roomIn, pictureToAssets, mapFromResult ----
  ['roomIn: the default limit is 127', [E(PI, 'export const roomIn = (set, maxTiles = T.MAX_TILES) =>', 'export const roomIn = (set, maxTiles = 127) =>')]],
  ['roomIn: a full set has -1 room', [E(PI, 'Math.max(0, maxTiles - (set?.tiles?.length ?? 0))', 'maxTiles - (set?.tiles?.length ?? 0)')]],
  ['roomIn: no set has no room', [E(PI, '(set?.tiles?.length ?? 0)', '(set?.tiles?.length ?? maxTiles)')]],
  ['pictureToAssets: the existing tiles are dropped from the set', [E(PI, '{ ...opts.existing, tiles: [...opts.existing.tiles, ...result.tiles] }', '{ ...opts.existing, tiles: [...result.tiles] }')]],
  ['pictureToAssets: the new tiles come first', [E(PI, 'tiles: [...opts.existing.tiles, ...result.tiles]', 'tiles: [...result.tiles, ...opts.existing.tiles]')]],
  ['pictureToAssets: a new set is not marked "tiles"', [E(PI, "{ tiles: result.tiles, tilesKey: 'tiles' }", "{ tiles: result.tiles, tilesKey: 'frames' }")]],
  ['pictureToAssets: the map does not name its tile set', [E(PI, 'mapFromResult(result, opts.tilesetName)', 'mapFromResult(result)')]],
  ['mapFromResult: a blank cell is tile 255', [E(PI, 'v === 255 ? M.BLANK : v', 'v === 255 ? 255 : v')]],
  ['mapFromResult: cell 254 is blank', [E(PI, 'v === 255 ? M.BLANK : v', 'v >= 254 ? M.BLANK : v')]],
  ['mapFromResult: the map is stored as decimal', [E(PI, "repr: 'hex'", "repr: 'dec'")]],
  ['mapFromResult: the tile set name is kept for a non-string', [E(PI, "tileset: typeof tileset === 'string' ? tileset : null", 'tileset: tileset ?? null')]],
  ['mapFromResult: the width and height are swapped', [E(PI, 'return { w: result.cols, h: result.rows, cells,', 'return { w: result.rows, h: result.cols, cells,')]],
  // ---- tilesetToRGBA ----
  ['tilesetToRGBA: the default columns are 15', [E(PI, 'tilesetToRGBA(set, { cols = 16, scale = 1, palette, fine = true } = {})', 'tilesetToRGBA(set, { cols = 15, scale = 1, palette, fine = true } = {})')]],
  ['tilesetToRGBA: the default scale is 2', [E(PI, 'cols = 16, scale = 1, palette', 'cols = 16, scale = 2, palette')]],
  ['tilesetToRGBA: the default is not fine', [E(PI, 'palette, fine = true } = {})', 'palette, fine = false } = {})')]],
  ['tilesetToRGBA: columns are not limited to the tile count', [E(PI, 'c = Math.max(1, Math.min(cols, n || 1)),', 'c = Math.max(1, cols),')]],
  ['tilesetToRGBA: the rows are rounded down', [E(PI, 'r = Math.max(1, Math.ceil(n / c)),', 'r = Math.max(1, Math.floor(n / c)),')]],
  ['tilesetToRGBA: the scale is not cut to an integer', [E(PI, 'sc = Math.max(1, scale | 0);', 'sc = Math.max(1, scale);')]],
  ['tilesetToRGBA: the scale can be 0', [E(PI, 'sc = Math.max(1, scale | 0);', 'sc = scale | 0;')]],
  ['tilesetToRGBA: the width is not scaled', [E(PI, 'const width = c * 8 * sc, height = r * 8 * sc,', 'const width = c * 8, height = r * 8 * sc,')]],
  ['tilesetToRGBA: the height is not scaled', [E(PI, 'const width = c * 8 * sc, height = r * 8 * sc,', 'const width = c * 8 * sc, height = r * 8,')]],
  ['tilesetToRGBA: the tile is placed by row-major index swapped', [E(PI, 'ox = (i % c) * 8 * sc, oy = ((i / c) | 0) * 8 * sc;', 'oy = (i % c) * 8 * sc, ox = ((i / c) | 0) * 8 * sc;')]],
  ['tilesetToRGBA: the pixel is not divided by the scale (x)', [E(PI, '((x / sc) | 0)]', '(x % 8)]')]],
  ['tilesetToRGBA: the pixel is not divided by the scale (y)', [E(PI, 'keys[((y / sc) | 0) * 8', 'keys[(y % 8) * 8')]],
  ['tilesetToRGBA: the palette is ignored', [E(PI, 'const tab = colourTable(palette);\n  set.tiles', 'const tab = colourTable();\n  set.tiles')]],
  ['tilesetToRGBA: the fine option is ignored', [E(PI, 'T.tilePixels(t, { fine })', 'T.tilePixels(t, { fine: true })')]],
  ['tilesetToRGBA: the alpha is 254', [E(PI, 'data[o + 2] = rgb[2]; data[o + 3] = 255;', 'data[o + 2] = rgb[2]; data[o + 3] = 254;')]],
  ['tilesetToRGBA: green and blue are swapped', [E(PI, 'data[o + 1] = rgb[1]; data[o + 2] = rgb[2];', 'data[o + 1] = rgb[2]; data[o + 2] = rgb[1];')]],
];

// ---- the driver (the same in the four m20 suites) -------------------------------------------------------------------------------------------------------
if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) {
    for (const e of edits) {
      const n = readFileSync(join(ROOT, e.file), 'utf8').split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
      else if (e.from === e.to) { console.log(`  ?? ${name}: the mutation changes nothing`); bad++; }
    }
  }
  const names = new Set(MUTANTS.map((m) => m[0]));
  if (names.size !== MUTANTS.length) { console.log('  ?? two mutants have the same name'); bad++; }
  console.log(bad ? `${bad} pattern(s) not found exactly once` : `all ${MUTANTS.length} mutants' patterns occur exactly once`);
  process.exit(bad ? 1 : 0);
}

// One scratch copy (what the tests read) per run; each mutant rewrites the module in it and the original text is put back after the run.
function makeRoot(tmp) {
  const root = join(tmp, 'root');
  for (const d of COPY_DIRS) { mkdirSync(join(root, d), { recursive: true }); cpSync(join(ROOT, d), join(root, d), { recursive: true }); }
  for (const v of BUILT_RUNTIMES) for (const f of ['runtime.json', 'runtime.bin']) {          // the built runtimes the machine tests boot
    if (!existsSync(join(ROOT, 'arcade/build', v, f))) continue;
    mkdirSync(join(root, 'arcade/build', v), { recursive: true });
    cpSync(join(ROOT, 'arcade/build', v, f), join(root, 'arcade/build', v, f));
  }
  symlinkSync(join(ROOT, 'tsrun'), join(root, 'tsrun'));
  return root;
}
const runTests = (root) => {
  for (const t of TESTS) {
    const r = spawnSync('node', [join(root, t)], { encoding: 'utf8', timeout: TIMEOUT, env: { ...process.env, ARCADE_QUICK: '1' }, cwd: root });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    if (r.status !== 0 || r.error) return { t, out, error: r.error };
  }
  return null;
};

const tmp = mkdtempSync(join(tmpdir(), 'm20mut-'));
let killed = 0;
const survived = [], equivalent = [], broken = [];
try {
  const root = makeRoot(tmp);
  // The unmutated tests must pass first, else every "kill" would be the tests' own failure.
  if (!only && shardI === 0 || args.includes('--baseline')) {
    const f = runTests(root);
    if (f) {
      console.log(`  BASELINE FAILS: ${f.t} fails without any mutation; fix it before trusting the kills${f.error ? ` (${f.error.message})` : ''}`);
      for (const l of (f.out.match(/^.*FAIL.*$/gm) ?? f.out.split('\n').filter(Boolean).slice(-5)).slice(0, 8)) console.log('    ' + l.slice(0, 300));
      process.exit(2);
    }
  }
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (mi % shardN !== shardI) continue;
    const originals = new Map();
    let bad = false;
    for (const e of edits) {
      const p = join(root, e.file);
      if (!originals.has(p)) originals.set(p, readFileSync(p, 'utf8'));
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    let failed = null;
    if (!bad) failed = runTests(root);
    for (const [p, text] of originals) writeFileSync(p, text);
    if (bad) { broken.push(name); continue; }
    if (failed) {
      killed++;
      const why = failed.error ? 'timed out / did not run' : ((failed.out.match(/FAIL  .*/g) ?? [failed.out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110);
      console.log(`  killed       ${name}  <- ${failed.t.replace('tests/', '')}: ${why}`);
    }
    else if (name.startsWith('EQUIVALENT:')) { equivalent.push(name); console.log(`  equivalent   ${name}  (survived, as expected)`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
const ran = killed + survived.length + equivalent.length + broken.length;
console.log(`\n${ran} mutants run: ${killed} killed, ${equivalent.length} equivalent (expected to survive), ${survived.length} survived${broken.length ? `, ${broken.length} with a bad pattern` : ''}`);
for (const s of survived) console.log('  survivor: ' + s);
process.exit(survived.length || broken.length ? 1 : 0);
