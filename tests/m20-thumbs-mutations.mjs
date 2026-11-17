"use strict";
// m20-thumbs-mutations.mjs -- mutation test of src/tools/asset-thumbs.js (Studio completion stage 6, item C3: the gallery thumbnails): copies src/, tests/ and the examples to a temporary
// directory, applies ONE deliberate bug at a time to asset-thumbs.js (comparison flips, off-by-one, swapped operands, removed guards, changed constants, && / ||) and runs
// tests/asset-thumbs.mjs; a mutation is KILLED when it fails.
//   node tests/m20-thumbs-mutations.mjs [name-fragment]     (a fraction of a second per mutant)
//   node tests/m20-thumbs-mutations.mjs --check             only verifies that every pattern occurs exactly once (and changes something)
//   node tests/m20-thumbs-mutations.mjs --shard=0/2         every second mutant (run the shards in parallel)
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
const TESTS = ['tests/asset-thumbs.mjs'];
const COPY_DIRS = ['src', 'tests', 'arcade/examples'];     // what the test reads
const BUILT_RUNTIMES = [];

const AT = 'src/tools/asset-thumbs.js';
const MUTANTS = [
  // ---- constants ----
  ['constants: DEFAULT_BOX 48 -> 47', [E(AT, 'DEFAULT_BOX = 48;', 'DEFAULT_BOX = 47;')]],
  ['constants: MODEL_YAW 0.6 -> 0.7', [E(AT, 'MODEL_YAW = 0.6;', 'MODEL_YAW = 0.7;')]],
  ['constants: FP_COLOURS wall 1 is palette 12', [E(AT, 'FP_COLOURS = [null, 13, 12, 9, 11]', 'FP_COLOURS = [null, 12, 12, 9, 11]')]],
  ['constants: FP_COLOURS wall 2 is palette 13', [E(AT, 'FP_COLOURS = [null, 13, 12, 9, 11]', 'FP_COLOURS = [null, 13, 13, 9, 11]')]],
  ['constants: FP_COLOURS wall 3 is palette 10', [E(AT, 'FP_COLOURS = [null, 13, 12, 9, 11]', 'FP_COLOURS = [null, 13, 12, 10, 11]')]],
  ['constants: FP_COLOURS wall 4 is palette 12', [E(AT, 'FP_COLOURS = [null, 13, 12, 9, 11]', 'FP_COLOURS = [null, 13, 12, 9, 12]')]],
  ['constants: BLANK_RGB changed', [E(AT, 'BLANK_RGB = [38, 42, 49]', 'BLANK_RGB = [38, 42, 50]')]],
  ['constants: UNDEFINED_RGB changed', [E(AT, 'UNDEFINED_RGB = [58, 29, 29]', 'UNDEFINED_RGB = [58, 29, 30]')]],
  ['constants: FLAT_RGB base 85 -> 86', [E(AT, 'FLAT_RGB = [85, 85, 85]', 'FLAT_RGB = [86, 85, 85]')]],
  ['constants: FLOOR_EMPTY_RGB changed', [E(AT, 'FLOOR_EMPTY_RGB = [20, 22, 28]', 'FLOOR_EMPTY_RGB = [20, 22, 29]')]],
  ['constants: FLOOR_ODD_RGB changed', [E(AT, 'FLOOR_ODD_RGB = [122, 60, 255]', 'FLOOR_ODD_RGB = [122, 60, 254]')]],
  ['constants: MODEL_BG changed', [E(AT, 'MODEL_BG = [24, 28, 36]', 'MODEL_BG = [24, 28, 37]')]],
  ['constants: MODEL_FG changed', [E(AT, 'MODEL_FG = [140, 200, 255]', 'MODEL_FG = [140, 200, 254]')]],
  // ---- pack, boxOf ----
  ['pack: the red and blue channels are swapped', [E(AT, 'const pack = (r, g, b) => (r << 16) | (g << 8) | b;', 'const pack = (r, g, b) => (b << 16) | (g << 8) | r;')]],
  ['pack: green is shifted 7', [E(AT, '(g << 8) | b;', '(g << 7) | b;')]],
  ['boxOf: the lower clamp is 5', [E(AT, 'Math.max(4, Math.min(256, b)) : DEFAULT_BOX', 'Math.max(5, Math.min(256, b)) : DEFAULT_BOX')]],
  ['boxOf: the upper clamp is 255', [E(AT, 'Math.max(4, Math.min(256, b)) : DEFAULT_BOX', 'Math.max(4, Math.min(255, b)) : DEFAULT_BOX')]],
  ['boxOf: a box is not rounded', [E(AT, 'const b = Math.round(+opts?.box);', 'const b = Math.floor(+opts?.box);')]],
  ['boxOf: a non-number box is 4', [E(AT, ': DEFAULT_BOX; };\nconst rgbOfKey', ': 4; };\nconst rgbOfKey')]],
  // ---- placeholder ----
  ['placeholder: the default box is 47', [E(AT, 'export function placeholder(box = DEFAULT_BOX)', 'export function placeholder(box = 47)')]],
  ['placeholder: the lower clamp is 5', [E(AT, 'const n = Math.max(4, Math.min(256, Math.round(+box) || DEFAULT_BOX));', 'const n = Math.max(5, Math.min(256, Math.round(+box) || DEFAULT_BOX));')]],
  ['placeholder: the upper clamp is 255', [E(AT, 'const n = Math.max(4, Math.min(256, Math.round(+box) || DEFAULT_BOX));', 'const n = Math.max(4, Math.min(255, Math.round(+box) || DEFAULT_BOX));')]],
  ['placeholder: a zero box is 4', [E(AT, 'Math.round(+box) || DEFAULT_BOX));', 'Math.round(+box) || 4));')]],
  ['placeholder: the right edge is not drawn', [E(AT, 'x === 0 || y === 0 || x === n - 1 || y === n - 1;', 'x === 0 || y === 0 || x === n || y === n - 1;')]],
  ['placeholder: the bottom edge is not drawn', [E(AT, 'x === 0 || y === 0 || x === n - 1 || y === n - 1;', 'x === 0 || y === 0 || x === n - 1 || y === n;')]],
  ['placeholder: the top edge is not drawn', [E(AT, 'x === 0 || y === 0 || x === n - 1', 'x === 0 || y === 1 || x === n - 1')]],
  ['placeholder: the left edge is not drawn', [E(AT, 'const edge = x === 0 ||', 'const edge = x === 1 ||')]],
  ['placeholder: the anti-diagonal is not drawn', [E(AT, 'x === y || x + y === n - 1;', 'x === y || x + y === n;')]],
  ['placeholder: the diagonal is not drawn', [E(AT, 'const diag = x === y ||', 'const diag = x === y + 1 ||')]],
  ['placeholder: only the diagonals are drawn when they are on the edge', [E(AT, 'if (edge || diag) rgba.set', 'if (edge && diag) rgba.set')]],
  ['placeholder: the colour is changed', [E(AT, 'rgba.set([120, 128, 140, 255], (y * n + x) * 4);', 'rgba.set([120, 128, 141, 255], (y * n + x) * 4);')]],
  ['placeholder: the lines are transparent', [E(AT, 'rgba.set([120, 128, 140, 255],', 'rgba.set([120, 128, 140, 254],')]],
  ['placeholder: not flagged as a placeholder', [E(AT, 'return { w: n, h: n, rgba, placeholder: true };', 'return { w: n, h: n, rgba };')]],
  // ---- render ----
  ['EQUIVALENT: render: a picture of width 0 is drawn (every caller has sw >= 8: sprite-model needs w >= 1, map-model w >= 1, a tile grid has 8 columns at least; the guard is defensive)', [E(AT, 'if (!(sw >= 1 && sh >= 1)) return placeholder(box);', 'if (!(sw >= 0 && sh >= 1)) return placeholder(box);')]],
  ['EQUIVALENT: render: a picture of height 0 is drawn (every caller has sh >= 8, as for the width)', [E(AT, 'if (!(sw >= 1 && sh >= 1)) return placeholder(box);', 'if (!(sw >= 1 && sh >= 0)) return placeholder(box);')]],
  ['render: the scale uses the larger ratio', [E(AT, 'const s = Math.min(box / sw, box / sh);', 'const s = Math.max(box / sw, box / sh);')]],
  ['EQUIVALENT: render: an exact fit (scale 1) is sampled, not copied (at scale 1 the sampled size is round(sw * 1) = sw and the sampling is the identity)', [E(AT, 'const ow = s >= 1 ?', 'const ow = s > 1 ?')]],
  ['render: the width of an enlarged picture is not a whole multiple', [E(AT, 'sw * Math.floor(s) :', 'Math.round(sw * s) :')]],
  ['render: the height of an enlarged picture is not a whole multiple', [E(AT, 'const oh = s >= 1 ? sh * Math.floor(s) :', 'const oh = s >= 1 ? Math.round(sh * s) :')]],
  ['render: a reduced width is cut, not rounded', [E(AT, 'Math.max(1, Math.round(sw * s));', 'Math.max(1, Math.floor(sw * s));')]],
  ['render: a reduced height is cut, not rounded', [E(AT, 'Math.max(1, Math.round(sh * s));', 'Math.max(1, Math.floor(sh * s));')]],
  ['render: a reduced width may be 0', [E(AT, 'Math.max(1, Math.round(sw * s));', 'Math.round(sw * s);')]],
  ['render: a reduced height may be 0', [E(AT, 'Math.max(1, Math.round(sh * s));', 'Math.round(sh * s);')]],
  ['render: the source row is the output row (no scaling)', [E(AT, 'const sy = Math.min(sh - 1, Math.floor((oy + 0.5) * sh / oh));', 'const sy = Math.min(sh - 1, oy);')]],
  ['render: the source row is taken at the top of the output pixel', [E(AT, 'Math.floor((oy + 0.5) * sh / oh)', 'Math.floor(oy * sh / oh)')]],
  ['render: the source column is taken at the top of the output pixel', [E(AT, 'Math.floor((ox + 0.5) * sw / ow)', 'Math.floor(ox * sw / ow)')]],
  ['render: the source column uses the height', [E(AT, 'Math.floor((ox + 0.5) * sw / ow)', 'Math.floor((ox + 0.5) * sh / ow)')]],
  ['EQUIVALENT: render: the source row is clamped to sh, not sh - 1 ((oy + 0.5) * sh / oh is below sh for every oy < oh, so the clamp never binds; the column clamp is the same)', [E(AT, 'const sy = Math.min(sh - 1, Math.floor', 'const sy = Math.min(sh, Math.floor')]],
  ['render: a source pixel of 0 (black) is transparent', [E(AT, 'if (v < 0) continue;', 'if (v <= 0) continue;')]],
  ['render: a transparent pixel is drawn black', [E(AT, 'if (v < 0) continue;', 'if (v < -1) continue;')]],
  ['render: the red byte is the blue one', [E(AT, 'rgba[i] = (v >> 16) & 255;', 'rgba[i] = v & 255;')]],
  ['render: the green byte is shifted 7', [E(AT, 'rgba[i + 1] = (v >> 8) & 255;', 'rgba[i + 1] = (v >> 7) & 255;')]],
  ['render: the blue byte is the red one', [E(AT, 'rgba[i + 2] = v & 255; rgba[i + 3] = 255;', 'rgba[i + 2] = (v >> 16) & 255; rgba[i + 3] = 255;')]],
  ['render: the alpha is 254', [E(AT, 'rgba[i + 3] = 255;\n    }\n  }\n  return { w: ow', 'rgba[i + 3] = 254;\n    }\n  }\n  return { w: ow')]],
  ['render: the rows are written one pixel off', [E(AT, 'const i = (oy * ow + ox) * 4;', 'const i = (oy * ow + ox + 1) * 4;')]],
  // ---- packedPalette ----
  ['packedPalette: only 15 colours', [E(AT, 'for (let k = 0; k < 16; k++) { const c = rgbOfKey', 'for (let k = 0; k < 15; k++) { const c = rgbOfKey')]],
  ['packedPalette: the palette is ignored', [E(AT, 'const c = rgbOfKey(k, pal);', 'const c = rgbOfKey(k);')]],
  ['packedPalette: key 15 is key 14', [E(AT, 'const c = rgbOfKey(k, pal);', 'const c = rgbOfKey(k === 15 ? 14 : k, pal);')]],
  // ---- thumbSprite ----
  ['thumbSprite: frame 1 is never reached', [E(AT, 'sprite.frames.length - 1, Number.isInteger(opts.frame)', 'sprite.frames.length - 2, Number.isInteger(opts.frame)')]],
  ['thumbSprite: a frame past the end is not clamped', [E(AT, 'Math.max(0, Math.min(sprite.frames.length - 1, Number.isInteger(opts.frame) ? opts.frame : 0))', 'Math.max(0, Number.isInteger(opts.frame) ? opts.frame : 0)')]],
  ['thumbSprite: a negative frame is not clamped', [E(AT, 'const f = Math.max(0, Math.min(', 'const f = Math.max(-1, Math.min(')]],
  ['thumbSprite: a fractional frame is rounded', [E(AT, 'Number.isInteger(opts.frame) ? opts.frame : 0', 'Number.isFinite(opts.frame) ? Math.round(opts.frame) : 0')]],
  ['thumbSprite: the default frame is the last', [E(AT, 'Number.isInteger(opts.frame) ? opts.frame : 0', 'Number.isInteger(opts.frame) ? opts.frame : 99')]],
  ['thumbSprite: the pixel is read with the wrong stride', [E(AT, 'const k = keys[y * sprite.w + x];', 'const k = keys[y * sprite.h + x];')]],
  ['thumbSprite: a masked pixel (key < 0) is drawn', [E(AT, 'return k < 0 ? -1 : pk[S.normKey(k)];', 'return pk[S.normKey(k < 0 ? 0 : k)];')]],
  ['thumbSprite: key 0 is transparent too', [E(AT, 'return k < 0 ? -1 : pk[S.normKey(k)];', 'return k <= 0 ? -1 : pk[S.normKey(k)];')]],
  ['EQUIVALENT: thumbSprite: the key is not normalised (pk[k] is keyRGB(k), which normalises the key itself: pk[k] equals pk[normKey(k)] for k 0..15)', [E(AT, 'return k < 0 ? -1 : pk[S.normKey(k)];', 'return k < 0 ? -1 : pk[k];')]],
  ['thumbSprite: the sprite is drawn with its height as width', [E(AT, 'return render(sprite.w, sprite.h, (x, y) => { const k', 'return render(sprite.h, sprite.w, (x, y) => { const k')]],
  ['thumbSprite: the host palette is not passed', [E(AT, 'pk = packedPalette(opts.palette);\n    return render(sprite.w', 'pk = packedPalette();\n    return render(sprite.w')]],
  // ---- tileRgb, thumbTileset ----
  ['tileRgb: a tile with row colours is drawn in row 0\'s colours', [E(AT, "{ fine: fine || T.hasRowColours(tile) }", "{ fine: fine }")]],
  ['EQUIVALENT: tileRgb: every tile is drawn fine (a tile without colours of its own in each row has the same colours in every row, so fine or not gives the same pixels)', [E(AT, "{ fine: fine || T.hasRowColours(tile) }", "{ fine: true }")]],
  ['tileRgb: only the first 63 pixels are converted', [E(AT, 'for (let i = 0; i < 64; i++) out[i] = pk[S.normKey(keys[i])];', 'for (let i = 0; i < 63; i++) out[i] = pk[S.normKey(keys[i])];')]],
  ['thumbTileset: the set is limited to 127 tiles', [E(AT, 'n = Math.min(set.tiles.length, 128);', 'n = Math.min(set.tiles.length, 127);')]],
  ['EQUIVALENT: thumbTileset: the set is limited to 129 tiles, not 128 (tile-model fromAsset refuses a set of more than 128, so the min never binds; 127 is killed)', [E(AT, 'n = Math.min(set.tiles.length, 128);', 'n = Math.min(set.tiles.length, 129);')]],
  ['EQUIVALENT: thumbTileset: an empty set is drawn (tile-model fromAsset throws for a set without tiles, so n is never 0 here)', [E(AT, 'if (!n) return placeholder(box);', 'if (n < 0) return placeholder(box);')]],
  ['EQUIVALENT: thumbTileset: the grid is at most 15 tiles wide (ceil(sqrt(128)) is 12: the min with 16 never binds)', [E(AT, 'cols = Math.min(16, Math.ceil(Math.sqrt(n)))', 'cols = Math.min(15, Math.ceil(Math.sqrt(n)))')]],
  ['thumbTileset: the grid is 1 column too narrow', [E(AT, 'cols = Math.min(16, Math.ceil(Math.sqrt(n)))', 'cols = Math.min(16, Math.floor(Math.sqrt(n)))')]],
  ['thumbTileset: the rows are rounded down', [E(AT, 'rows = Math.ceil(n / cols);', 'rows = Math.floor(n / cols);')]],
  ['thumbTileset: the tile index takes the row from y >> 2', [E(AT, 'const i = (y >> 3) * cols + (x >> 3);', 'const i = (y >> 2) * cols + (x >> 3);')]],
  ['thumbTileset: the tile index uses rows as the stride', [E(AT, 'const i = (y >> 3) * cols + (x >> 3);', 'const i = (y >> 3) * rows + (x >> 3);')]],
  ['thumbTileset: the cell after the last tile is drawn', [E(AT, 'return i < n ? px[i][(y & 7) * 8 + (x & 7)] : -1;', 'return px[Math.min(i, n - 1)][(y & 7) * 8 + (x & 7)];')]],
  ['thumbTileset: the last tile is cut off', [E(AT, 'return i < n ? px[i]', 'return i < n - 1 ? px[i]')]],
  ['thumbTileset: the pixel within the tile is read with a stride of 7', [E(AT, 'px[i][(y & 7) * 8 + (x & 7)]', 'px[i][(y & 7) * 7 + (x & 7)]')]],
  ['EQUIVALENT: thumbTileset: the fine option is ignored (hasRowColours already makes a tile with row colours fine; tested in section 6)', [E(AT, 'tileRgb(t, !!opts.fine, pk)', 'tileRgb(t, false, pk)')]],
  ['thumbTileset: the palette is ignored', [E(AT, 'const pk = packedPalette(opts.palette), px = set.tiles', 'const pk = packedPalette(), px = set.tiles')]],
  // ---- thumbMap ----
  ['thumbMap: the grey of tile 1 uses 36', [E(AT, 'FLAT_RGB[0] + ((t * 37) % 120)', 'FLAT_RGB[0] + ((t * 36) % 120)')]],
  ['thumbMap: the grey wraps at 119', [E(AT, '((t * 37) % 120)', '((t * 37) % 119)')]],
  ['EQUIVALENT: thumbMap: the grey is capped at 236, not 235 (85 + (t * 37 mod 120) is at most 204: the cap never binds)', [E(AT, 'Math.min(235, FLAT_RGB[0]', 'Math.min(236, FLAT_RGB[0]')]],
  ['thumbMap: the role "world" is not known', [E(AT, "ctx?.role === 'world' || ctx?.role === 'floorplan' ? ctx.role : 'cell'", "ctx?.role === 'floorplan' ? ctx.role : 'cell'")]],
  ['thumbMap: the role "floorplan" is not known', [E(AT, "ctx?.role === 'world' || ctx?.role === 'floorplan' ? ctx.role : 'cell'", "ctx?.role === 'world' ? ctx.role : 'cell'")]],
  ['thumbMap: the palette of the context is not used', [E(AT, 'const pal = opts.palette ?? ctx?.palette,', 'const pal = opts.palette,')]],
  ['thumbMap: the palette of the options is not used', [E(AT, 'const pal = opts.palette ?? ctx?.palette,', 'const pal = ctx?.palette,')]],
  ['EQUIVALENT: thumbMap: a floor plan loads the tile set too (flat() of a floor plan never reads the tiles, and the flat path is taken for a floor plan either way)', [E(AT, "if (role !== 'floorplan' && ctx?.tileset) { try", "if (ctx?.tileset) { try")]],
  ['thumbMap: the tile set is ignored', [E(AT, "if (role !== 'floorplan' && ctx?.tileset) { try", "if (false) { try")]],
  ['EQUIVALENT: thumbMap: the tile set is read as fine from the options, not the context (the flag changes nothing: see the fine option above)', [E(AT, 'tileRgb(t, !!ctx.fine, pk)', 'tileRgb(t, !!opts.fine, pk)')]],
  ['EQUIVALENT: thumbMap: the fine flag of the context is ignored (as above)', [E(AT, 'tileRgb(t, !!ctx.fine, pk)', 'tileRgb(t, false, pk)')]],
  ['thumbMap: a damaged tile set throws instead of being dropped', [E(AT, 'tiles = T.fromAsset(ctx.tileset).tiles.map((t) => tileRgb(t, !!ctx.fine, pk)); } catch { tiles = null; } }', 'tiles = T.fromAsset(ctx.tileset).tiles.map((t) => tileRgb(t, !!ctx.fine, pk)); } finally { } }')]],
  ['thumbMap: the average divides by 63', [E(AT, 'pack(Math.round(r / 64), Math.round(g / 64), Math.round(b / 64))', 'pack(Math.round(r / 63), Math.round(g / 64), Math.round(b / 64))')]],
  ['thumbMap: the average is cut, not rounded (green)', [E(AT, 'Math.round(g / 64)', 'Math.floor(g / 64)')]],
  ['thumbMap: the average is cut, not rounded (blue)', [E(AT, 'Math.round(b / 64)', 'Math.floor(b / 64)')]],
  ['thumbMap: the average is cut, not rounded (red)', [E(AT, 'pack(Math.round(r / 64),', 'pack(Math.floor(r / 64),')]],
  ['thumbMap: the average takes the green of the wrong byte', [E(AT, 'g += (v >> 8) & 255;', 'g += (v >> 16) & 255;')]],
  ['thumbMap: the average ignores blue', [E(AT, 'b += v & 255; }', 'b += 0; }')]],
  ['thumbMap: floor plan code 0 is not the empty colour', [E(AT, 'if (code === 0) return pack(...FLOOR_EMPTY_RGB);', 'if (code === 0) return pack(...BLANK_RGB);')]],
  ['thumbMap: a floor plan code 4 is the odd colour', [E(AT, 'return code <= 4 ? pk[FP_COLOURS[code]]', 'return code < 4 ? pk[FP_COLOURS[code]]')]],
  ['thumbMap: a floor plan code 5 is a wall colour', [E(AT, 'return code <= 4 ? pk[FP_COLOURS[code]]', 'return code <= 5 ? pk[FP_COLOURS[code]]')]],
  ['thumbMap: a blank floor plan cell (negative) is not empty', [E(AT, 'const code = v < 0 ? 0 : v;', 'const code = v < 0 ? 1 : v;')]],
  ['thumbMap: a blank cell of a cell map is tile 0', [E(AT, "const t = v === M.BLANK ? (role === 'world' ? 0 : null) : v;\n      if (t === null) return pack(...BLANK_RGB);", "const t = v === M.BLANK ? 0 : v;\n      if (t === null) return pack(...BLANK_RGB);")]],
  ['thumbMap: a blank cell of a world map is blank', [E(AT, "const t = v === M.BLANK ? (role === 'world' ? 0 : null) : v;\n      if (t === null) return pack(...BLANK_RGB);", "const t = v === M.BLANK ? null : v;\n      if (t === null) return pack(...BLANK_RGB);")]],
  ['thumbMap: without a tile set a cell is the blank colour', [E(AT, 'if (!tiles) return grey(t);', 'if (!tiles) return pack(...BLANK_RGB);')]],
  ['thumbMap: tile number = tile count is defined', [E(AT, 'return t < tiles.length ? avg[t] : pack(...UNDEFINED_RGB);', 'return t <= tiles.length ? avg[t] : pack(...UNDEFINED_RGB);')]],
  ['thumbMap: the cell size uses the larger side', [E(AT, 'cellOut = 8 * Math.min(box / sw, box / sh);', 'cellOut = 8 * Math.max(box / sw, box / sh);')]],
  ['thumbMap: flat cells are used below 4 pixels', [E(AT, 'const useAvg = cellOut < 3 ||', 'const useAvg = cellOut < 4 ||')]],
  ['thumbMap: flat cells are used only below 2 pixels', [E(AT, 'const useAvg = cellOut < 3 ||', 'const useAvg = cellOut < 2 ||')]],
  ['thumbMap: flat cells are used at exactly 3 pixels', [E(AT, 'const useAvg = cellOut < 3 ||', 'const useAvg = cellOut <= 3 ||')]],
  ['EQUIVALENT: thumbMap: the floor plan is not drawn flat by its own rule (tiles is null for a floor plan, so !tiles gives the same decision)', [E(AT, "|| role === 'floorplan' || !tiles;", '|| !tiles;')]],
  ['thumbMap: a map without tiles is not drawn flat', [E(AT, "role === 'floorplan' || !tiles;", "role === 'floorplan';")]],
  ['thumbMap: the cell is read with the wrong stride', [E(AT, 'const v = m.cells[(y >> 3) * m.w + (x >> 3)];', 'const v = m.cells[(y >> 3) * m.h + (x >> 3)];')]],
  ['thumbMap: the pixel of a tile is read mirrored', [E(AT, 'tiles[t][(y & 7) * 8 + (x & 7)] : flat(v);', 'tiles[t][(y & 7) * 8 + 7 - (x & 7)] : flat(v);')]],
  ['thumbMap: a blank cell of a world map is not tile 0 in the full picture', [E(AT, "const t = v === M.BLANK ? (role === 'world' ? 0 : null) : v;\n      return t !== null", "const t = v === M.BLANK ? null : v;\n      return t !== null")]],
  ['thumbMap: an undefined tile is drawn from the last tile in the full picture', [E(AT, 'return t !== null && t < tiles.length ? tiles[t]', 'return t !== null && t <= tiles.length ? tiles[t]')]],
  ['thumbMap: the noTileset note is given for a floor plan', [E(AT, "if (role !== 'floorplan' && !tiles) out.noTileset = true;", 'if (!tiles) out.noTileset = true;')]],
  ['thumbMap: the noTileset note is never given', [E(AT, "if (role !== 'floorplan' && !tiles) out.noTileset = true;", 'if (false) out.noTileset = true;')]],
  ['thumbMap: the noTileset note is given with a tile set', [E(AT, "if (role !== 'floorplan' && !tiles) out.noTileset = true;", "if (role !== 'floorplan') out.noTileset = true;")]],
  // ---- thumbModel ----
  ['thumbModel: the background is the line colour', [E(AT, 'const bg = opts.bg ?? MODEL_BG, fg = opts.fg ?? MODEL_FG;', 'const bg = opts.bg ?? MODEL_FG, fg = opts.fg ?? MODEL_FG;')]],
  ['thumbModel: the option fg is ignored', [E(AT, 'fg = opts.fg ?? MODEL_FG;', 'fg = MODEL_FG;')]],
  ['thumbModel: the option bg is ignored', [E(AT, 'const bg = opts.bg ?? MODEL_BG,', 'const bg = MODEL_BG,')]],
  ['thumbModel: the preview is made at a different size', [E(AT, 'previewSegments(asset, MODEL_YAW, box, box)', 'previewSegments(asset, MODEL_YAW, box, box - 2)')]],
  ['thumbModel: a model without segments is drawn', [E(AT, 'if (!segs.length) return placeholder(box);', 'if (segs.length < 0) return placeholder(box);')]],
  ['EQUIVALENT: thumbModel: the plot stops one pixel early on the right (previewSegments keeps every end within 0.89 * (box / 2 - 2) of the centre, tested in section 6: no pixel is in the last column)', [E(AT, 'x >= 0 && y >= 0 && x < box && y < box', 'x >= 0 && y >= 0 && x < box - 1 && y < box')]],
  ['EQUIVALENT: thumbModel: the plot stops one pixel early at the bottom (as above: the last row is never reached)', [E(AT, 'x >= 0 && y >= 0 && x < box && y < box', 'x >= 0 && y >= 0 && x < box && y < box - 1')]],
  ['EQUIVALENT: thumbModel: the plot does not stop at the left (x = -1 is never plotted: no line leaves the box)', [E(AT, 'if (x >= 0 && y >= 0 && x < box', 'if (x >= -1 && y >= 0 && x < box')]],
  ['EQUIVALENT: thumbModel: the plot skips column 0 (no line reaches the first column)', [E(AT, 'if (x >= 0 && y >= 0 && x < box', 'if (x >= 1 && y >= 0 && x < box')]],
  ['EQUIVALENT: thumbModel: the plot skips row 0 (no line reaches the first row)', [E(AT, 'if (x >= 0 && y >= 0 && x < box', 'if (x >= 0 && y >= 1 && x < box')]],
  ['thumbModel: the pixel is written with the wrong stride', [E(AT, '(y * box + x) * 4);', '(y * (box - 1) + x) * 4);')]],
  ['EQUIVALENT: thumbModel: a segment with a non-finite end is drawn (a NaN end plots no pixel and Bresenham gives up after the 2000 guard steps; previewSegments gives only NaN, never Infinity)', [E(AT, 'if (!seg.every(Number.isFinite)) continue;', 'if (false) continue;')]],
  ['thumbModel: the Bresenham error starts with dx - dy', [E(AT, 'let err = dx + dy;', 'let err = dx - dy;')]],
  ['thumbModel: the x step runs the wrong way', [E(AT, 'sx = x0 < x1 ? 1 : -1,', 'sx = x0 < x1 ? -1 : 1,')]],
  ['thumbModel: the y step runs the wrong way', [E(AT, 'sy = y0 < y1 ? 1 : -1;', 'sy = y0 < y1 ? -1 : 1;')]],
  ['thumbModel: dy is positive', [E(AT, 'dy = -Math.abs(y1 - y0)', 'dy = Math.abs(y1 - y0)')]],
  ['thumbModel: the end point is not plotted', [E(AT, 'plot(x0, y0);\n        if (x0 === x1 && y0 === y1) break;', 'if (x0 === x1 && y0 === y1) break;\n        plot(x0, y0);')]],
  ['thumbModel: the x test is e2 > dy', [E(AT, 'if (e2 >= dy) { err += dy; x0 += sx; }', 'if (e2 > dy) { err += dy; x0 += sx; }')]],
  ['thumbModel: the y test is e2 < dx', [E(AT, 'if (e2 <= dx) { err += dx; y0 += sy; }', 'if (e2 < dx) { err += dx; y0 += sy; }')]],
  ['thumbModel: the line ends are not rounded', [E(AT, 'let [x0, y0, x1, y1] = seg.map(Math.round);', 'let [x0, y0, x1, y1] = seg.map(Math.floor);')]],
  ['thumbModel: the x error update is wrong', [E(AT, '{ err += dy; x0 += sx; }', '{ err += dx; x0 += sx; }')]],
  ['thumbModel: the guard of 2000 steps is 5', [E(AT, 'guard < 2000', 'guard < 5')]],
  ['thumbModel: the box is 3 pixels larger', [E(AT, 'return { w: box, h: box, rgba };', 'return { w: box + 3, h: box, rgba };')]],
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
