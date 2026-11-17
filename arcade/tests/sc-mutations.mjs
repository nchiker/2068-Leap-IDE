"use strict";
// sc-mutations.mjs -- mutation test of sprite colour (SC, docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md): copies the compiler (src/), the tests, the examples, the runtime sources and builds
// (v2, v2ink, v3, v4) to a temporary directory, applies ONE deliberate bug at a time to the ink code (arcade-spriteink.js: the ink tables, the classes, the clash check and the interpreter's
// applySpriteInk; the display plan's spriteColour; requiredRuntime / compile(): the ink flag, the variant refusal and the sprite-ink-clash warning; the code generator's ink table block,
// RT_SPRITEINK calls and the interpreter's scene flags) and runs the suites below; a mutation is KILLED when one of them fails. (No runtime is rebuilt: these break JavaScript only.)
//   node arcade/tests/sc-mutations.mjs [name-fragment]     (a second or two per mutant: a mutant is usually killed by the first suite)
//   node arcade/tests/sc-mutations.mjs --check             only verifies that every pattern occurs exactly once
//   node arcade/tests/sc-mutations.mjs --shard=0/2         every second mutant (run the shards in parallel)
//   TMPDIR=<dir> to choose where the scratch copy lives.
// A mutant whose name starts with "EQUIVALENT:" changes no behaviour anyone can observe (the name says why); it is expected to survive, is counted separately, and does not fail the run.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shardArg = args.find((a) => a.startsWith('--shard='));
const [shardI, shardN] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
// the pure suites first (the setting and the display plan: no machine), then the code generator's (tables, calls, the TSRun attribute file), then the parity of the interpreter and the Z80
const TESTS = ['tests/arcade-sc-tables.mjs', 'tests/arcade-sc-setting.mjs', 'tests/arcade-sc-codegen.mjs', 'tests/arcade-sc-parity.mjs'];

const SI = 'src/lang/arcade/arcade-spriteink.js', DP = 'src/lang/arcade/arcade-display.js', CM = 'src/lang/arcade/arcade-compile.js', CG = 'src/lang/arcade/arcade-codegen.js', IN = 'src/lang/arcade/arcade-interp.js';
const E = (file, from, to) => ({ file, from, to });
const MUTANTS = [
  // ---- arcade-spriteink.js: constants and classes ----
  ['S: LEAVE is 9 (bit 3 still set, but the table bytes differ)', [E(SI, 'export const LEAVE = 8;', 'export const LEAVE = 9;')]],
  ['S: LEAVE is 0 (an untouched cell reads as ink 0)', [E(SI, 'export const LEAVE = 8;', 'export const LEAVE = 0;')]],
  ['S: a class is 8 bytes', [E(SI, 'export const CLASS_BYTES = 9;', 'export const CLASS_BYTES = 8;')]],
  ['S: a table is 80 bytes', [E(SI, 'export const TABLE_BYTES = 81;', 'export const TABLE_BYTES = 80;')]],
  ['S: class 1 starts at shift 2', [E(SI, 'from = [0, 1, 4][c]', 'from = [0, 2, 4][c]')]],
  ['S: class 2 starts at shift 5', [E(SI, 'from = [0, 1, 4][c]', 'from = [0, 1, 5][c]')]],
  ['S: class 1 ends at shift 4', [E(SI, 'to = [0, 3, 7][c]', 'to = [0, 4, 7][c]')]],
  ['S: class 2 ends at shift 6', [E(SI, 'to = [0, 3, 7][c]', 'to = [0, 3, 6][c]')]],
  ['S: every shift counts (the asset\'s phases are ignored)', [E(SI, 'if (s % step === 0) out.push(s);', 'out.push(s);')]],
  ['S: the phase step is 8 * phases', [E(SI, 'const step = 8 / phases,', 'const step = 8 * phases,')]],
  ['EQUIVALENT: shiftsOf\'s default is never used: both callers pass the phases (classGrid) or 8: S: the phase default is 4', [E(SI, 'function shiftsOf(c, phases = 8) {', 'function shiftsOf(c, phases = 4) {')]],
  ['S: shift 4 is class 1', [E(SI, "(s & 7) < 4 ? 1 : 2);", "(s & 7) < 5 ? 1 : 2);")]],
  ['S: shift 3 is class 2', [E(SI, "(s & 7) < 4 ? 1 : 2);", "(s & 7) < 3 ? 1 : 2);")]],
  ['EQUIVALENT: every call passes a shift already cut to 3 bits (xd AND 7, y AND 7): S: a shift is not cut to 3 bits in shiftClass', [E(SI, 'export const shiftClass = (s) => ((s & 7) === 0 ? 0 : (s & 7) < 4 ? 1 : 2);', 'export const shiftClass = (s) => (s === 0 ? 0 : s < 4 ? 1 : 2);')]],
  // ---- arcade-spriteink.js: counting the covered pixels ----
  ['S: the mask bit means covered (inverted)', [E(SI, 'if (mask & (0x8000 >> p)) continue;                    // the background shows here: not covered', 'if (!(mask & (0x8000 >> p))) continue;')]],
  ['S: the mask is read from the image bytes', [E(SI, 'const mask = ((asset.data[4 * k] << 8) | asset.data[4 * k + 1]) & 0xFFFF, ink = (asset.inks?.[k] ?? 7) & 7, dr', 'const mask = ((asset.data[4 * k + 2] << 8) | asset.data[4 * k + 3]) & 0xFFFF, ink = (asset.inks?.[k] ?? 7) & 7, dr')]],
  ['S: the mask low byte is dropped', [E(SI, 'const mask = ((asset.data[4 * k] << 8) | asset.data[4 * k + 1]) & 0xFFFF, ink = (asset.inks?.[k] ?? 7) & 7, dr', 'const mask = ((asset.data[4 * k] << 8)) & 0xFFFF, ink = (asset.inks?.[k] ?? 7) & 7, dr')]],
  ['S: the pixel test starts at bit 14', [E(SI, 'if (mask & (0x8000 >> p)) continue;                    // the background shows here: not covered', 'if (mask & (0x4000 >> p)) continue;')]],
  ['S: an art row without an ink reads as ink 0', [E(SI, 'const mask = ((asset.data[4 * k] << 8) | asset.data[4 * k + 1]) & 0xFFFF, ink = (asset.inks?.[k] ?? 7) & 7, dr', 'const mask = ((asset.data[4 * k] << 8) | asset.data[4 * k + 1]) & 0xFFFF, ink = (asset.inks?.[k] ?? 0) & 7, dr')]],
  ['S: the ink is not cut to 3 bits when counting', [E(SI, 'ink = (asset.inks?.[k] ?? 7) & 7, dr', 'ink = (asset.inks?.[k] ?? 7), dr')]],
  ['S: the cell row is (ys + k) >> 2', [E(SI, 'dr = (ys0 + k) >> 3;', 'dr = (ys0 + k) >> 2;')]],
  ['S: the cell row ignores the y shift', [E(SI, 'dr = (ys0 + k) >> 3;', 'dr = k >> 3;')]],
  ['EQUIVALENT: an art is at most 16 rows high (the runtime clamps a height to 16), so (ys + k) >> 3 is at most 2 and the guard never fires: S: rows past the third cell are counted (they wrap onto the first)', [E(SI, 'if (dr > 2) continue;', 'if (dr > 2) dr = 2;')]],
  ['S: the cell column ignores the x shift', [E(SI, 'counts[dr][(xs0 + p) >> 3][ink]++;', 'counts[dr][p >> 3][ink]++;')]],
  ['S: a pixel counts twice in the cell to its right', [E(SI, 'counts[dr][(xs0 + p) >> 3][ink]++;', 'counts[dr][(xs0 + p) >> 3][ink]++; if ((xs0 + p) >> 3 < 2) counts[dr][((xs0 + p) >> 3) + 1][ink]++;')]],
  ['S: only the first x shift of a class counts', [E(SI, 'for (const ys0 of ys) for (const xs0 of xs) {', 'for (const ys0 of ys) for (const xs0 of xs.slice(0, 1)) {')]],
  ['S: only the first y shift of a class counts', [E(SI, 'for (const ys0 of ys) for (const xs0 of xs) {', 'for (const ys0 of ys.slice(0, 1)) for (const xs0 of xs) {')]],
  ['S: the art height defaults to 16', [E(SI, '  const h = asset.h ?? 0;\n  for (const ys0 of ys)', '  const h = asset.h ?? 16;\n  for (const ys0 of ys)')]],
  // ---- arcade-spriteink.js: the pick, the grid, the table ----
  ['S: a tie goes to the higher ink (>=)', [E(SI, 'if (cnt[i] > n) { n = cnt[i]; best = i; }', 'if (cnt[i] >= n && cnt[i] > 0) { n = cnt[i]; best = i; }')]],
  ['S: the least used ink wins', [E(SI, 'if (cnt[i] > n) { n = cnt[i]; best = i; }', 'if (cnt[i] > 0 && (n === 0 || cnt[i] < n)) { n = cnt[i]; best = i; }')]],
  ['S: ink 7 is not a candidate', [E(SI, 'for (let i = 0; i < 8; i++) if (cnt[i] > n)', 'for (let i = 0; i < 7; i++) if (cnt[i] > n)')]],
  ['S: an empty cell is ink 0', [E(SI, 'let best = LEAVE, n = 0;', 'let best = 0, n = 0;')]],
  ['S: the grid of a class uses the phases of the asset for y as well', [E(SI, 'shiftsOf(xc, asset.phases ?? 8), shiftsOf(yc, 8)', 'shiftsOf(xc, asset.phases ?? 8), shiftsOf(yc, asset.phases ?? 8)')]],
  ['S: the grid of a class ignores the phases of the asset', [E(SI, 'shiftsOf(xc, asset.phases ?? 8), shiftsOf(yc, 8)', 'shiftsOf(xc, 8), shiftsOf(yc, 8)')]],
  ['S: the grid swaps xc and yc', [E(SI, 'shiftsOf(xc, asset.phases ?? 8), shiftsOf(yc, 8)', 'shiftsOf(yc, asset.phases ?? 8), shiftsOf(xc, 8)')]],
  ['S: the class number is 3 * yc + xc in the table', [E(SI, 'at = CLASS_BYTES * (3 * xc + yc);', 'at = CLASS_BYTES * (3 * yc + xc);')]],
  ['S: the grid is stored column-major', [E(SI, 'out[at + 3 * dr + dc] = g[dr][dc];', 'out[at + 3 * dc + dr] = g[dr][dc];')]],
  ['S: spriteCellInks takes the shift without cutting it to 3 bits', [E(SI, 'return gridOf(countCells(asset, [xs & 7], [ys & 7]));', 'return gridOf(countCells(asset, [xs], [ys]));')]],
  ['S: spriteCellInks swaps x and y', [E(SI, 'return gridOf(countCells(asset, [xs & 7], [ys & 7]));', 'return gridOf(countCells(asset, [ys & 7], [xs & 7]));')]],
  ['S: inkAt does not round x to the phase', [E(SI, 'xd = x & ~((8 / ph) - 1);\n  return classGrid', 'xd = x;\n  return classGrid')]],
  ['S: inkAt rounds x up', [E(SI, 'xd = x & ~((8 / ph) - 1);\n  return classGrid', 'xd = (x + (8 / ph) - 1) & ~((8 / ph) - 1);\n  return classGrid')]],
  ['S: inkAt takes the class of x for y', [E(SI, 'return classGrid(asset, shiftClass(xd & 7), shiftClass(y & 7));', 'return classGrid(asset, shiftClass(xd & 7), shiftClass(x & 7));')]],
  ['S: inkAt takes the class of the unrounded x', [E(SI, 'return classGrid(asset, shiftClass(xd & 7), shiftClass(y & 7));', 'return classGrid(asset, shiftClass(x & 7), shiftClass(y & 7));')]],
  // ---- arcade-spriteink.js: the clash check ----
  ['S: a clash needs three inks', [E(SI, 'if (seen.size > 1) out.push', 'if (seen.size > 2) out.push')]],
  ['S: every block is a clash', [E(SI, 'if (seen.size > 1) out.push', 'if (seen.size > 0) out.push')]],
  ['S: the clash blocks are 7 pixels wide', [E(SI, 'for (let p = 8 * col; p < 8 * col + 8; p++) if (!(mask', 'for (let p = 8 * col; p < 8 * col + 7; p++) if (!(mask')]],
  ['S: the clash check counts the uncovered pixels', [E(SI, 'if (!(mask & (0x8000 >> p))) { seen.add(', 'if ((mask & (0x8000 >> p))) { seen.add(')]],
  ['EQUIVALENT: the break only stops adding the same ink to a Set: S: the clash check counts every pixel of the row, not the first covered one (the break is gone)', [E(SI, 'seen.add((asset.inks?.[k] ?? 7) & 7); break; }', 'seen.add((asset.inks?.[k] ?? 7) & 7); }')]],
  ['S: the clash check stops at the first row of a block', [E(SI, 'for (let k = 8 * row; k < Math.min(h, 8 * row + 8); k++) {', 'for (let k = 8 * row; k < Math.min(h, 8 * row + 1); k++) {')]],
  ['S: the clash check reads 3 columns', [E(SI, 'for (let row = 0; row * 8 < h; row++) for (let col = 0; col < 2; col++) {', 'for (let row = 0; row * 8 < h; row++) for (let col = 0; col < 3; col++) {')]],
  ['S: the clash check misses the last block row', [E(SI, 'for (let row = 0; row * 8 < h; row++) for (let col', 'for (let row = 0; row * 8 < h - 8; row++) for (let col')]],
  ['S: the clash list is not sorted', [E(SI, 'inks: [...seen].sort((a, b) => a - b) });', 'inks: [...seen].sort((a, b) => b - a) });')]],
  // ---- arcade-spriteink.js: applySpriteInk (the interpreter's half) ----
  ['A: a hidden sprite is applied', [E(SI, 'if (!s || !s.visible || !a) continue;', 'if (!s || !a) continue;')]],
  ['A: a sprite of an unknown asset takes asset 0', [E(SI, 'const s = sprites[i], a = assets[instAsset[i] ?? 0];', 'const s = sprites[i], a = assets[instAsset[i]] ?? assets[0];')]],
  ['A: an instance without an asset entry has no sprite (no default 0)', [E(SI, 'a = assets[instAsset[i] ?? 0];', 'a = assets[instAsset[i]];')]],
  ['A: x is not rounded to the phase', [E(SI, 'xd = s.x & ~((8 / ph) - 1), h =', 'xd = s.x, h =')]],
  ['A: the phase default is 4', [E(SI, 'const ph = a.phases ?? 8, xd = s.x', 'const ph = a.phases ?? 4, xd = s.x')]],
  ['EQUIVALENT: a height is at most 16, the mask only mirrors the Z80\'s AND $1F: A: the art height is not cut to 5 bits', [E(SI, 'h = (a.h ?? 0) & 0x1F, t = s.y & 7;', 'h = (a.h ?? 0), t = s.y & 7;')]],
  ['A: the y shift is x AND 7', [E(SI, 'h = (a.h ?? 0) & 0x1F, t = s.y & 7;', 'h = (a.h ?? 0) & 0x1F, t = s.x & 7;')]],
  ['A: the class is 3 * yc + xc', [E(SI, 'const cls = 3 * shiftClass(xd & 7) + shiftClass(t),', 'const cls = 3 * shiftClass(t) + shiftClass(xd & 7),')]],
  ['A: the x class takes the unrounded x', [E(SI, 'const cls = 3 * shiftClass(xd & 7) + shiftClass(t),', 'const cls = 3 * shiftClass(s.x & 7) + shiftClass(t),')]],
  ['A: one row too few (nr without the +1)', [E(SI, 'nr = Math.min(3, (((t + h - 1) >> 3) & 3) + 1);', 'nr = Math.min(3, (((t + h - 1) >> 3) & 3));')]],
  ['EQUIVALENT: (t + h - 1) >> 3 is at most 2 for an art of at most 16 rows, so nr never reaches the cap: A: nr is not capped at 3', [E(SI, 'nr = Math.min(3, (((t + h - 1) >> 3) & 3) + 1);', 'nr = ((((t + h - 1) >> 3) & 3) + 1);')]],
  ['EQUIVALENT: the table bytes of the rows past the real NR are LEAVE (inkTable writes LEAVE there), so one row more recolours nothing: A: nr counts the rows of h + 1', [E(SI, 'nr = Math.min(3, (((t + h - 1) >> 3) & 3) + 1);', 'nr = Math.min(3, (((t + h) >> 3) & 3) + 1);')]],
  ['EQUIVALENT: the table bytes of the rows past the real NR are LEAVE, so reading them recolours nothing: A: nr is always 3', [E(SI, 'nr = Math.min(3, (((t + h - 1) >> 3) & 3) + 1);', 'nr = 3;')]],
  ['A: the first cell row is y >> 4', [E(SI, 'const r0 = s.y >> 3, c0 = xd >> 3;', 'const r0 = s.y >> 4, c0 = xd >> 3;')]],
  ['EQUIVALENT: x is rounded down by less than 8 to a multiple of 8 / phases, which never crosses a byte boundary: x >> 3 equals xd >> 3: A: the first cell column is x >> 3 of the unrounded x', [E(SI, 'const r0 = s.y >> 3, c0 = xd >> 3;', 'const r0 = s.y >> 3, c0 = s.x >> 3;')]],
  ['A: only two columns are applied', [E(SI, 'for (let dr = 0; dr < nr; dr++) for (let dc = 0; dc < 3; dc++) {', 'for (let dr = 0; dr < nr; dr++) for (let dc = 0; dc < 2; dc++) {')]],
  ['A: the table byte is read column-major', [E(SI, 'const b = tab[CLASS_BYTES * cls + 3 * dr + dc];', 'const b = tab[CLASS_BYTES * cls + 3 * dc + dr];')]],
  ['A: bit 3 is tested as bit 2', [E(SI, 'if (b & 8) continue;', 'if (b & 4) continue;')]],
  ['A: the leave test is inverted', [E(SI, 'if (b & 8) continue;', 'if (!(b & 8)) continue;')]],
  ['A: a cell below row 23 wraps (no bottom guard)', [E(SI, 'if (r > 23 || c > 31) continue;', 'if (c > 31) continue;')]],
  ['A: a cell right of column 31 wraps (no right guard)', [E(SI, 'if (r > 23 || c > 31) continue;', 'if (r > 23) continue;')]],
  ['A: row 23 is guarded out', [E(SI, 'if (r > 23 || c > 31) continue;', 'if (r > 22 || c > 31) continue;')]],
  ['A: column 31 is guarded out', [E(SI, 'if (r > 23 || c > 31) continue;', 'if (r > 23 || c > 30) continue;')]],
  ['A: the paper is replaced too (AND $C0)', [E(SI, 'out[r * 32 + c] = (out[r * 32 + c] & 0xF8) | (b & 7);', 'out[r * 32 + c] = (out[r * 32 + c] & 0xC0) | (b & 7);')]],
  ['A: BRIGHT is replaced (AND $B8)', [E(SI, 'out[r * 32 + c] = (out[r * 32 + c] & 0xF8) | (b & 7);', 'out[r * 32 + c] = (out[r * 32 + c] & 0xB8) | (b & 7);')]],
  ['A: FLASH is replaced (AND $78)', [E(SI, 'out[r * 32 + c] = (out[r * 32 + c] & 0xF8) | (b & 7);', 'out[r * 32 + c] = (out[r * 32 + c] & 0x78) | (b & 7);')]],
  ['A: the ink is ORed into the old one', [E(SI, 'out[r * 32 + c] = (out[r * 32 + c] & 0xF8) | (b & 7);', 'out[r * 32 + c] = out[r * 32 + c] | (b & 7);')]],
  ['EQUIVALENT: an earlier sprite changes only the low 3 bits, which the next sprite replaces: both forms give the same byte: A: the new attribute is taken from the unmodified background (an overlap loses the lower sprite)', [E(SI, 'out[r * 32 + c] = (out[r * 32 + c] & 0xF8) | (b & 7);', 'out[r * 32 + c] = (attrs[r * 32 + c] & 0xF8) | (b & 7);')]],
  ['A: the attributes are modified in place (the caller\'s array changes)', [E(SI, 'const out = attrs.slice();', 'const out = attrs;')]],
  ['A: sprites apply in reverse order (a lower index lies on top)', [E(SI, 'for (let i = 0; i < sprites.length; i++) {\n    const s = sprites[i], a =', 'for (let i = sprites.length - 1; i >= 0; i--) {\n    const s = sprites[i], a =')]],
  ['A: the table of an asset is cached by index (two assets share one table)', [E(SI, 'const tableCache = new WeakMap();', 'const tableCache = { get: () => globalThis.__t, set: (a, t) => { globalThis.__t = t; } };')]],
  ['EQUIVALENT: A: the table cache is dropped (the table is rebuilt every call; only speed)', [E(SI, 'const tableOf = (asset) => { let t = tableCache.get(asset); if (!t) { t = inkTable(asset); tableCache.set(asset, t); } return t; };', 'const tableOf = (asset) => inkTable(asset);')]],
  ['EQUIVALENT: S: inkTables maps with an index argument (inkTable ignores a second argument)', [E(SI, 'return assets.map((a) => inkTable(a));', 'return assets.map((a, i) => inkTable(a, i));')]],
  // ---- arcade-display.js: the setting ----
  ['D: the setting is case sensitive', [E(DP, "typeof raw === 'string' ? raw.trim().toLowerCase() : ''", "typeof raw === 'string' ? raw.trim() : ''")]],
  ['D: the setting is not trimmed', [E(DP, "typeof raw === 'string' ? raw.trim().toLowerCase() : ''", "typeof raw === 'string' ? raw.toLowerCase() : ''")]],
  ['D: a non-string setting is read as text', [E(DP, "typeof raw === 'string' ? raw.trim().toLowerCase() : ''", "String(raw).trim().toLowerCase()")]],
  ['D: an unknown setting is read as ink', [E(DP, "if (!SPRITE_COLOURS.includes(v)) return { setting: 'none', built: 'none',", "if (!SPRITE_COLOURS.includes(v)) return { setting: 'ink', built: 'ink',")]],
  ['D: an unknown setting gives no note', [E(DP, "is not a sprite colour setting (none, ink); ignored` };", "is not a sprite colour setting (none, ink); ignored`.slice(0, 0) };")]],
  ['D: none is built as ink', [E(DP, "if (v === 'none') return { setting: 'none', built: 'none', note: '' };", "if (v === 'none') return { setting: 'none', built: 'ink', note: '' };")]],
  ['D: a null setting is an unknown one', [E(DP, 'if (raw === undefined || raw === null) return', 'if (raw === undefined) return')]],
  ['D: a fine scene is built as ink', [E(DP, "if (built === 'fine') return { setting: 'ink', built: 'none',", "if (built === 'fine') return { setting: 'ink', built: 'ink',")]],
  ['D: a fine scene gives no note', [E(DP, "is ignored: a fine scene already has an ink per sprite row` };", "is ignored: a fine scene already has an ink per sprite row`.slice(0, 0) };")]],
  ['D: a scene built for hi-res is built as ink (the fine test also catches the other display kinds)', [E(DP, "if (built === 'fine') return { setting: 'ink', built: 'none',", "if (built === 'hires') return { setting: 'ink', built: 'none',")]],
  ['D: v3 builds ink scenes', [E(DP, "if (version !== 2) return { setting: 'ink', built: 'none',", "if (version !== 2 && version !== 3) return { setting: 'ink', built: 'none',")]],
  ['D: v4 builds ink scenes (version > 3 only is refused)', [E(DP, "if (version !== 2) return { setting: 'ink', built: 'none',", "if (version > 3) return { setting: 'ink', built: 'none',")]],
  ['D: the ink setting is reported as none for an ignored scene', [E(DP, "if (version !== 2) return { setting: 'ink', built: 'none',", "if (version !== 2) return { setting: 'none', built: 'none',")]],
  ['D: the plan reads the setting of the next scene', [E(DP, 'const spriteColour = spriteColourOf(scenes, name, built, version);', 'const spriteColour = spriteColourOf(scenes, name + "x", built, version);')]],
  // ---- arcade-compile.js ----
  ['C: requiredRuntime never reports ink', [E(CM, "sc.spriteColour.built === 'ink');\n  return { version, reasons, ink };", "sc.spriteColour.built === 'ink') && false;\n  return { version, reasons, ink };")]],
  ['C: requiredRuntime reports ink for every game', [E(CM, "const ink = version === 2 && sceneDisplayPlan(ast, { scenes, version }).some(", "const ink = version === 2 && sceneDisplayPlan(ast, { scenes, version }).every(")]],
  ['EQUIVALENT: the display plan builds no ink scene for a v3 game, so .some is false either way: C: requiredRuntime reports ink for a v3 game too', [E(CM, "const ink = version === 2 && sceneDisplayPlan", "const ink = version <= 3 && sceneDisplayPlan")]],
  ['C: requiredRuntime reads the plan without the scenes', [E(CM, 'sceneDisplayPlan(ast, { scenes, version }).some((sc) => sc.spriteColour.built', 'sceneDisplayPlan(ast, { version }).some((sc) => sc.spriteColour.built')]],
  ['C: an ink game on a plain runtime compiles (the refusal is gone)', [E(CM, "if (runtime && runtime.variant !== 'ink') {", "if (runtime && runtime.variant !== 'ink' && false) {")]],
  ['C: a plain game on a plain runtime is refused (the scenes test is gone)', [E(CM, "if (sc.spriteColour.built !== 'ink') continue;\n      out.errors.push", "out.errors.push")]],
  ['EQUIVALENT: the two real runtimes have variant undefined (plain) or \'ink\'; the forms differ only for another variant value: C: the refusal needs the variant to be anything but plain', [E(CM, "runtime.variant !== 'ink') {\n    for", "runtime.variant === undefined) {\n    for")]],
  ['C: the refusal message does not name the variant', [E(CM, "needs the ink variant of runtime v2 (variant 'ink'); this runtime is not one`", "needs another runtime`")]],
  ['C: the code generator is not told the ink scenes', [E(CM, "...(out.scenes.some((sc) => sc.spriteColour.built === 'ink') ? { ink: out.scenes.map((sc) => sc.spriteColour.built === 'ink') } : {}) });", "});")]],
  ['C: every scene is an ink scene once one is', [E(CM, "{ ink: out.scenes.map((sc) => sc.spriteColour.built === 'ink') } : {}) });", "{ ink: out.scenes.map(() => true) } : {}) });")]],
  ['C: the ink flags are the fine flags', [E(CM, "{ ink: out.scenes.map((sc) => sc.spriteColour.built === 'ink') } : {}) });", "{ ink: out.scenes.map((sc) => sc.built === 'fine') } : {}) });")]],
  ['C: the clash warning is not given', [E(CM, 'for (const b of inkClashes(sp)) {', 'for (const b of []) {')]],
  ['C: the clash warning is given for every scene', [E(CM, 'if (!gen.ink.scenes[k]) continue;', 'if (false) continue;')]],
  ['C: the clash warning is given once per game (only the first scene)', [E(CM, 'if (!gen.ink.scenes[k]) continue;', 'if (!gen.ink.scenes[k] || k > 0) continue;')]],
  ['C: the clash warning has no id', [E(CM, "id: 'sprite-ink-clash', line: sc.line,", "line: sc.line,")]],
  ['C: the clash warning is an error', [E(CM, "endCol: sc.col + sc.name.length, severity: 'warning', message: `scene '${sc.name}': sprite \"${sp.asset}\" block", "endCol: sc.col + sc.name.length, severity: 'error', message: `scene '${sc.name}': sprite \"${sp.asset}\" block")]],
  ['C: the clash warning names the row for the column', [E(CM, 'block (row ${b.row}, column ${b.col})', 'block (row ${b.col}, column ${b.row})')]],
  ['C: the clash warning lists no inks', [E(CM, "has inks ${b.inks.join(' and ')}:", 'has inks :')]],
  ['C: the clash warning names the scene wrongly', [E(CM, "message: `scene '${sc.name}': sprite \"${sp.asset}\" block", "message: `scene 'x': sprite \"${sp.asset}\" block")]],
  ['C: the clash warning is marked at column 0', [E(CM, "id: 'sprite-ink-clash', line: sc.line, col: sc.col,", "id: 'sprite-ink-clash', line: sc.line, col: 0,")]],
  // ---- arcade-codegen.js ----
  ['G: a game with ink scenes but no sprites still gets the table', [E(CG, 'const hasInk = inkScenes.some(Boolean) && sprites.length > 0;', 'const hasInk = inkScenes.some(Boolean);')]],
  ['G: the ink table is made for a game with no ink scene when it has sprites', [E(CG, 'const hasInk = inkScenes.some(Boolean) && sprites.length > 0;', 'const hasInk = sprites.length > 0;')]],
  ['G: the ink scenes are read from the fine flags', [E(CG, 'const inkScenes = scenes.map((_, k) => !!opts.ink?.[k]);', 'const inkScenes = scenes.map((_, k) => !!opts.fine?.[k]);')]],
  ['G: the ink scene flags are shifted by one scene', [E(CG, 'const inkScenes = scenes.map((_, k) => !!opts.ink?.[k]);', 'const inkScenes = scenes.map((_, k) => !!opts.ink?.[k + 1]);')]],
  ['EQUIVALENT: unreachable through compile(): the display plan builds no ink scene for a v3 game, so hasInk is false (the guard is for direct generate() calls): G: an ink game on a v3 runtime is accepted', [E(CG, "if (!v2 || v3 || wireDecl) err(scenes[inkScenes.indexOf(true)], 'sprite colour needs the v2 runtime and no WIRE3D');", "if (false) err(scenes[inkScenes.indexOf(true)], 'sprite colour needs the v2 runtime and no WIRE3D');")]],
  ['G: WIRE3D is allowed with ink', [E(CG, 'if (!v2 || v3 || wireDecl) err(scenes[inkScenes.indexOf(true)]', 'if (!v2 || v3) err(scenes[inkScenes.indexOf(true)]')]],
  ['G: a runtime without RT_SPRITEINK is accepted', [E(CG, "else if (sym.RT_SPRITEINK === undefined) err(", "else if (false) err(")]],
  ['G: the RT_SPRITEINK refusal does not name the scene', [E(CG, "err(scenes[inkScenes.indexOf(true)], `scene '${scenes[inkScenes.indexOf(true)].name}': spriteColour 'ink' needs RT_SPRITEINK", "err(scenes[inkScenes.indexOf(true)], `scene 'x': spriteColour 'ink' needs RT_SPRITEINK")]],
  ['G: the setter is called with A = 0 in an ink scene', [E(CG, "e.ld('a', inkScenes[k] ? 1 : 0);\n    e.ld('hl', L('ink$table'));", "e.ld('a', 0);\n    e.ld('hl', L('ink$table'));")]],
  ['G: the setter is called with A = 1 in every scene (a plain scene of an ink game keeps the ink)', [E(CG, "e.ld('a', inkScenes[k] ? 1 : 0);\n    e.ld('hl', L('ink$table'));", "e.ld('a', 1);\n    e.ld('hl', L('ink$table'));")]],
  ['G: the setter gets the wrong table', [E(CG, "e.ld('hl', L('ink$table'));\n    e.call(need('RT_SPRITEINK'));", "e.ld('hl', 0);\n    e.call(need('RT_SPRITEINK'));")]],
  ['G: the setter is not called at an ENTER', [E(CG, "      emitInkMode(k);                                                            // sprite colour: the same place", "      // emitInkMode(k);")]],
  ['G: an ink first scene does not switch the ink on at the start', [E(CG, "if (hasInk && inkScenes[0]) emitInkMode(0);", "if (false) emitInkMode(0);")]],
  ['G: init_entry switches the ink for a plain first scene too', [E(CG, "if (hasInk && inkScenes[0]) emitInkMode(0);", "if (hasInk) emitInkMode(0);")]],
  ['G: the ink table is not page aligned', [E(CG, "if (hasInk) e.endAlign(256, 'ink$table');", "if (hasInk) e.endAlign(1, 'ink$table');")]],
  ['G: the ink table is aligned to 128 bytes', [E(CG, "if (hasInk) e.endAlign(256, 'ink$table');", "if (hasInk) e.endAlign(128, 'ink$table');")]],
  ['G: the word table points one asset late', [E(CG, 'tbl[2 * a] = (grids + TABLE_BYTES * a) & 0xFF;', 'tbl[2 * a] = (grids + TABLE_BYTES * (a + 1)) & 0xFF;')]],
  ['G: the word table points 80 bytes on', [E(CG, 'tbl[2 * a + 1] = (grids + TABLE_BYTES * a) >> 8;', 'tbl[2 * a + 1] = (grids + 80 * a) >> 8;')]],
  ['G: the grids start one word late (grids = table + 2n + 2)', [E(CG, 'grids = inkTableAt + 2 * n;', 'grids = inkTableAt + 2 * n + 2;')]],
  ['G: the grids are put right behind the table (no word table)', [E(CG, 'tbl.set(t, 2 * n + TABLE_BYTES * a);', 'tbl.set(t, TABLE_BYTES * a);')]],
  ['G: the ink table is made from the first asset only', [E(CG, 'const tabs = inkTables(sprites), n = sprites.length,', 'const tabs = inkTables(sprites.slice(0, 1)), n = sprites.length,')]],
  ['G: the table bytes are not appended to the code', [E(CG, 'all.set(code); all.set(tbl, code.length);', 'all.set(code);')]],
  ['G: the usage does not count the ink table', [E(CG, 'dataSize.ink = tbl.length;', 'dataSize.ink = 0;')]],
  ['G: the result does not carry the ink table address', [E(CG, '...(hasInk ? { ink: { scenes: inkScenes, tableAt: inkTableAt } } : {}),', '...(hasInk ? { ink: { scenes: inkScenes, tableAt: 0 } } : {}),')]],
  ['G: the result does not carry the ink scene flags', [E(CG, '...(hasInk ? { ink: { scenes: inkScenes, tableAt: inkTableAt } } : {}),', '...(hasInk ? { ink: { scenes: inkScenes.map(() => true), tableAt: inkTableAt } } : {}),')]],
  ['G: a game without ink carries an ink key', [E(CG, '...(hasInk ? { ink: { scenes: inkScenes, tableAt: inkTableAt } } : {}),', '...({ ink: { scenes: inkScenes, tableAt: inkTableAt } }),')]],
  // ---- arcade-interp.js ----
  ['I: the interpreter ignores the ink scenes', [E(IN, "const inkScenes = opts.scenes ? sceneDisplayPlan(ast, { scenes: opts.scenes, version: opts.version ?? 2 }).map(", "const inkScenes = false ? sceneDisplayPlan(ast, { scenes: opts.scenes, version: opts.version ?? 2 }).map(")]],
  ['I: the interpreter\'s default runtime version is 3 (no ink scene is built)', [E(IN, "const inkScenes = opts.scenes ? sceneDisplayPlan(ast, { scenes: opts.scenes, version: opts.version ?? 2 })", "const inkScenes = opts.scenes ? sceneDisplayPlan(ast, { scenes: opts.scenes, version: opts.version ?? 3 })")]],
  ['I: every scene is an ink scene', [E(IN, ".map((sc) => sc.spriteColour?.built === 'ink') : [];", ".map(() => true) : [];")]],
  ['I: the ink test reads the setting, not the built value', [E(IN, ".map((sc) => sc.spriteColour?.built === 'ink') : [];", ".map((sc) => sc.spriteColour?.setting === 'ink') : [];")]],
];

if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    const n = readFileSync(join(ROOT, e.file), 'utf8').split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
    if (e.from === e.to) { console.log(`  ?? ${name}: the mutation changes nothing`); bad++; }
  }
  console.log(bad ? `${bad} pattern(s) not found exactly once` : `all ${MUTANTS.length} mutants' patterns occur exactly once`);
  process.exit(bad ? 1 : 0);
}

// The unmutated suites must pass first, else every "kill" would be the suite's own failure.
if (!only && shardI === 0 || args.includes('--baseline')) {
  for (const t of TESTS) {
    const r = spawnSync('node', [join(ROOT, t)], { encoding: 'utf8', timeout: 900000, cwd: ROOT });
    if (r.status !== 0 || r.error) {
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      console.log(`  BASELINE FAILS: ${t} fails without any mutation; fix it before trusting the kills${r.error ? ` (${r.error.message})` : ''}`);
      for (const l of (out.match(/^.*FAIL.*$/gm) ?? out.split('\n').filter(Boolean).slice(-5)).slice(0, 8)) console.log('    ' + l.slice(0, 300));
      process.exit(2);
    }
  }
}
const tmp = mkdtempSync(join(tmpdir(), 'scmut-'));
let killed = 0;
const survived = [], equivalent = [], broken = [];
try {
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (mi % shardN !== shardI) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade'), { recursive: true });
    cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
    cpSync(join(ROOT, 'tests'), join(root, 'tests'), { recursive: true });
    for (const d of ['tests', 'tools', 'examples', 'runtime', 'dist']) cpSync(join(ROOT, 'arcade', d), join(root, 'arcade', d), { recursive: true });      // (the published runtimes are arcade/dist: the suites compile with them)
    for (const v of ['v2', 'v2ink', 'v3', 'v4']) for (const f of ['runtime.json', 'runtime.bin']) {                    // the runtime builds the suites run on (not the 1 GB of the build directory)
      if (!existsSync(join(ROOT, 'arcade/build', v, f))) continue;
      mkdirSync(join(root, 'arcade/build', v), { recursive: true });
      cpSync(join(ROOT, 'arcade/build', v, f), join(root, 'arcade/build', v, f));
    }
    symlinkSync(join(ROOT, 'tsrun'), join(root, 'tsrun'));
    let bad = false;
    for (const e of edits) {
      const p = join(root, e.file);
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    if (bad) { broken.push(name); continue; }
    let failedBy = null;
    for (const t of TESTS) {
      const r = spawnSync('node', [join(root, t)], { encoding: 'utf8', timeout: 900000, cwd: root });
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      if (r.status !== 0 || r.error) { failedBy = t.replace('tests/', '') + ': ' + ((out.match(/FAIL  .*/g) ?? [out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110); break; }
    }
    if (failedBy) { killed++; console.log(`  killed       ${name}  <- ${failedBy}`); }
    else if (name.startsWith('EQUIVALENT:')) { equivalent.push(name); console.log(`  equivalent   ${name}  (survived, as expected)`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
const ran = killed + survived.length + equivalent.length + broken.length;
console.log(`\n${ran} mutants run: ${killed} killed, ${equivalent.length} equivalent (expected to survive), ${survived.length} survived${broken.length ? `, ${broken.length} with a bad pattern` : ''}`);
for (const s of survived) console.log('  survivor: ' + s);
process.exit(survived.length || broken.length ? 1 : 0);
