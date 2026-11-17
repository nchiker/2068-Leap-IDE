"use strict";
// m19c-mutations.mjs -- mutation test of the compiler half of fine colour (slice F3, docs/ARCADE_FINE_COLOUR_CONTRACT.md): copies the compiler (src/), the tests, the examples, the
// assets, the arcadec tool and the runtime builds to a temporary directory, applies ONE deliberate bug at a time to the fine code (arcade-fine.js, the display plan, the compile errors,
// the row attributes and inks, the code generator's RT_FINEMODE calls and fine descriptor, the phase cap, the interpreter's fine record, arcadec's --scenes) and runs the suites below;
// a mutation is KILLED when one of them fails. (No runtime is rebuilt: these break JavaScript only.)
//   node arcade/tests/m19c-mutations.mjs [name-fragment]     (a second or two per mutant: a mutant is usually killed by the first suite)
//   node arcade/tests/m19c-mutations.mjs --check             only verifies that every pattern occurs exactly once
//   node arcade/tests/m19c-mutations.mjs --shard=0/4         every fourth mutant (run the shards in parallel)
//   TMPDIR=<dir> to choose where the scratch copy lives.
// A mutant whose name starts with "EQUIVALENT:" changes no behaviour anyone can observe (the name says why); it is expected to survive, is counted separately, and does
// not fail the run.
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
// the fine-colour suite first (it compiles every example and checks the bytes), then the display plan and the interpreter's records
const TESTS = ['tests/arcade-m19-compiler.mjs', 'tests/arcade-display.mjs', 'tests/arcade-m17-interp.mjs'];

const FN = 'src/lang/arcade/arcade-fine.js', DP = 'src/lang/arcade/arcade-display.js', CM = 'src/lang/arcade/arcade-compile.js', AS = 'src/lang/arcade/arcade-assets.js';
const CG = 'src/lang/arcade/arcade-codegen.js', LK = 'src/lang/arcade/arcade-link.js', IN = 'src/lang/arcade/arcade-interp.js', AC = 'arcade/tools/arcadec.mjs';
const E = (file, from, to) => ({ file, from, to });
const SPC = 'export const spriteColour = (colour, ink) => ((colour & 0xF8) | (ink & 7)) & 0xFF;';
const PUT = '        bits[o] = (bits[o] & mb) | ib;\n        if (mb !== 0xFF) colours[o] = spriteColour(colours[o], asset.inks[k]);';
const DESC = "e.label('fine$desc'); e.dw(rowAttrs ? L('fine$rows') : 0); e.dw(sprites.length ? L('fine$inks') : 0);";
const MUTANTS = [
  // ---- arcade-fine.js: the colour byte of a sprite ----
  ['F: a sprite keeps the low 4 bits of the colour (AND $F0)', [E(FN, SPC, SPC.replace('0xF8', '0xF0'))]],
  ['F: a sprite replaces the BRIGHT bit (AND $B8)', [E(FN, SPC, SPC.replace('0xF8', '0xB8'))]],
  ['F: a sprite replaces the paper too (AND $C0)', [E(FN, SPC, SPC.replace('0xF8', '0xC0'))]],
  ['F: a sprite ORs the ink without clearing the old one (no AND)', [E(FN, SPC, 'export const spriteColour = (colour, ink) => ((colour) | (ink & 7)) & 0xFF;')]],
  ['F: the ink replaces the colour byte', [E(FN, SPC, 'export const spriteColour = (colour, ink) => ((colour & 0xF8) & (ink & 7)) & 0xFF;')]],
  ['F: the ink is not cut to 3 bits', [E(FN, SPC, SPC.replace('(ink & 7)', '(ink)'))]],
  ['EQUIVALENT: F: the colour byte is not cut to 8 bits (both operands are at most $F8 and 7: the result never exceeds $FF)', [E(FN, SPC, 'export const spriteColour = (colour, ink) => ((colour & 0xF8) | (ink & 7));')]],
  // ---- arcade-fine.js: the phase rounding ----
  ['F: the phase default is 4 (not 8)', [E(FN, 'export const phaseX = (x, phases = 8) =>', 'export const phaseX = (x, phases = 4) =>')]],
  ['F: x is rounded UP to the phase granularity', [E(FN, 'x & ~((8 / phases) - 1)', 'x + ((8 / phases) - 1) & ~((8 / phases) - 1)')]],
  ['F: the phase mask is one too small (8 / phases)', [E(FN, 'x & ~((8 / phases) - 1)', 'x & ~((8 / phases) - 2)')]],
  ['F: the phase mask is not inverted', [E(FN, 'x & ~((8 / phases) - 1)', 'x & ((8 / phases) - 1)')]],
  ['F: the phase granularity is phases / 8', [E(FN, 'x & ~((8 / phases) - 1)', 'x & ~((phases / 8) - 1)')]],
  ['F: a sprite is drawn at x, not at the rounded x', [E(FN, 'const x0 = phaseX(s.x, asset.phases ?? 8)', 'const x0 = s.x')]],
  ['F: an asset without phases rounds as 4 phases', [E(FN, 'phaseX(s.x, asset.phases ?? 8)', 'phaseX(s.x, asset.phases ?? 4)')]],
  ['F: the phases of the asset are ignored (8)', [E(FN, 'phaseX(s.x, asset.phases ?? 8)', 'phaseX(s.x, 8)')]],
  // ---- arcade-fine.js: glyphs ----
  ['F: a tile cell is v & $40', [E(FN, 'if (v & 0x80) {', 'if (v & 0x40) {')]],
  ['F: the tile index is v & $3F', [E(FN, 'const t = v & 0x7F;', 'const t = v & 0x3F;')]],
  ['F: a tile of tileBytes is 8 bytes (not 9)', [E(FN, 'Array.from(tileBytes.slice(9 * t, 9 * t + 8))', 'Array.from(tileBytes.slice(8 * t, 8 * t + 8))')]],
  ['F: the tile bitmap starts at its attribute byte', [E(FN, 'Array.from(tileBytes.slice(9 * t, 9 * t + 8))', 'Array.from(tileBytes.slice(9 * t + 1, 9 * t + 9))')]],
  ['F: the last tile of the table is blank (< instead of <=)', [E(FN, 'tileBytes && 9 * t + 8 <= tileBytes.length', 'tileBytes && 9 * t + 8 < tileBytes.length')]],
  ['F: a tile beyond the table reads on (no length test)', [E(FN, 'tileBytes && 9 * t + 8 <= tileBytes.length ? Array.from(tileBytes.slice(9 * t, 9 * t + 8)) : blank', 'tileBytes ? Array.from(tileBytes.slice(9 * t, 9 * t + 8)) : blank')]],
  ['F: without a tile table a tile cell reads the font', [E(FN, 'tileBytes && 9 * t + 8 <= tileBytes.length ? Array.from(tileBytes.slice(9 * t, 9 * t + 8)) : blank', '9 * t + 8 <= (tileBytes?.length ?? 1e9) ? Array.from((tileBytes ?? []).slice(9 * t, 9 * t + 8)) : blank')]],
  ['F: the space (32) is blank', [E(FN, 'return v >= 32 && v <= 127', 'return v > 32 && v <= 127')]],
  ['F: the character 127 is blank', [E(FN, 'return v >= 32 && v <= 127', 'return v >= 32 && v < 127')]],
  ['F: the font is indexed from 33', [E(FN, 'font[v - 32] ?? blank', 'font[v - 33] ?? blank')]],
  ['F: a character beyond a short font crashes (no blank)', [E(FN, 'font[v - 32] ?? blank', 'font[v - 32]')]],
  ['EQUIVALENT: F: a control code reads the font (code < 32 gives font[negative], undefined, then the `?? blank`; codes above 127 never get here: bit 7 is the tile branch)', [E(FN, 'return v >= 32 && v <= 127', 'return v <= 127')]],
  // ---- arcade-fine.js: the cells ----
  ['F: the tile cell test is v > 128 (tile 0 falls back)', [E(FN, 'tile = v >= 128 ? v - 128 : -1', 'tile = v > 128 ? v - 128 : -1')]],
  ['F: the tile index is v - 127', [E(FN, 'tile = v >= 128 ? v - 128 : -1', 'tile = v >= 128 ? v - 127 : -1')]],
  ['F: a tile cell is tile >= 1', [E(FN, 'const rows = tile >= 0 && tileRows', 'const rows = tile >= 1 && tileRows')]],
  ['F: the last tile of the row table falls back (< instead of <=)', [E(FN, '8 * tile + 8 <= tileRows.length', '8 * tile + 8 < tileRows.length')]],
  ['F: a tile beyond the row table reads on (no length test)', [E(FN, 'tile >= 0 && tileRows && 8 * tile + 8 <= tileRows.length ? tileRows : null', 'tile >= 0 && tileRows ? tileRows : null')]],
  ['F: without row attributes a tile cell crashes (no null test)', [E(FN, 'tile >= 0 && tileRows && 8 * tile + 8 <= tileRows.length ? tileRows : null', 'tile >= 0 && 8 * tile + 8 <= tileRows.length ? tileRows : null')]],
  ['F: every row of a tile has the attribute of its first row', [E(FN, 'colours[o] = rows ? rows[8 * tile + k] : a;', 'colours[o] = rows ? rows[8 * tile] : a;')]],
  ['F: the rows of a tile are read at 9 bytes a tile', [E(FN, 'colours[o] = rows ? rows[8 * tile + k] : a;', 'colours[o] = rows ? rows[9 * tile + k] : a;')]],
  ['F: a tile cell takes the cell\'s own attribute', [E(FN, 'colours[o] = rows ? rows[8 * tile + k] : a;', 'colours[o] = a;')]],
  ['F: a font cell takes the tile rows', [E(FN, 'colours[o] = rows ? rows[8 * tile + k] : a;', 'colours[o] = rows ? rows[8 * tile + k] : (tileRows?.[k] ?? a);')]],
  ['F: a font cell gets the attribute on the first row only', [E(FN, 'colours[o] = rows ? rows[8 * tile + k] : a;', 'colours[o] = rows ? rows[8 * tile + k] : (k === 0 ? a : 0);')]],
  ['F: the last cell row is not drawn', [E(FN, 'for (let r = 0; r < 24; r++) {', 'for (let r = 0; r < 23; r++) {')]],
  ['F: the last cell column is not drawn', [E(FN, 'for (let c = 0; c < 32; c++) {\n      const v', 'for (let c = 0; c < 31; c++) {\n      const v')]],
  ['F: the cells are read at 24 to a row', [E(FN, 'const v = cells[r * 32 + c], a = attrs[r * 32 + c]', 'const v = cells[r * 24 + c], a = attrs[r * 32 + c]')]],
  ['F: the attributes are read at the wrong cell', [E(FN, 'a = attrs[r * 32 + c], g = glyph(v)', 'a = attrs[c * 24 + r], g = glyph(v)')]],
  ['F: the glyph rows are read from the second row on', [E(FN, 'bits[o] = g[k] & 0xFF;', 'bits[o] = g[(k + 1) & 7] & 0xFF;')]],
  ['F: the pixel rows of a cell are laid out 8 + k wrongly (r * 8 + k)', [E(FN, 'const o = rowOff(8 * r + k, c);', 'const o = rowOff(8 * r + (7 - k), c);')]],
  ['EQUIVALENT: F: the glyph byte is not cut to 8 bits (the Uint8Array cuts it on the store)', [E(FN, 'bits[o] = g[k] & 0xFF;', 'bits[o] = g[k];')]],
  // ---- arcade-fine.js: the sprites ----
  ['F: a hidden sprite is drawn', [E(FN, 'if (!s || !s.visible) return;', 'if (!s) return;')]],
  ['F: an absent sprite record crashes', [E(FN, 'if (!s || !s.visible) return;', 'if (!s.visible) return;')]],
  ['F: no sprite is drawn without an `asset` field (instAsset ignored)', [E(FN, 's.asset ?? instAsset?.[i]', 's.asset')]],
  ['F: `asset` of the record never beats instAsset', [E(FN, 's.asset ?? instAsset?.[i]', 'instAsset?.[i] ?? s.asset')]],
  ['F: a sprite of an asset the table lacks crashes (no null test)', [E(FN, 'if (!asset) return;\n    const x0', 'const x0')]],
  ['F: the sprites come in reverse order (a lower index lies on top)', [E(FN, "(sprites ?? []).forEach((s, i) => {", "(sprites ?? []).map((s, i) => [s, i]).reverse().forEach(([s, i]) => {")]],
  ['F: the first sprite row is not drawn', [E(FN, 'for (let k = 0; k < asset.h; k++) {', 'for (let k = 1; k < asset.h; k++) {')]],
  ['F: the last sprite row is not drawn', [E(FN, 'for (let k = 0; k < asset.h; k++) {', 'for (let k = 0; k < asset.h - 1; k++) {')]],
  ['F: row 0 is not drawn (y > 0 only)', [E(FN, 'if (y < 0 || y > 191) continue;', 'if (y < 1 || y > 191) continue;')]],
  ['F: the last pixel row (191) is not drawn', [E(FN, 'if (y < 0 || y > 191) continue;', 'if (y < 0 || y >= 191) continue;')]],
  ['EQUIVALENT: F: pixel row 192 is drawn (rowOff(192, c) is 6144 or more: past the end of both 6144-byte arrays, the write is dropped)', [E(FN, 'if (y < 0 || y > 191) continue;', 'if (y < 0 || y > 192) continue;')]],
  ['F: a negative pixel row is drawn (wraps)', [E(FN, 'if (y < 0 || y > 191) continue;', 'if (y > 191) continue;')]],
  ['F: the sprite window is 2 bytes (not 3)', [E(FN, 'for (let j = 0; j < 3; j++) {', 'for (let j = 0; j < 2; j++) {')]],
  ['F: byte column 0 is not drawn', [E(FN, 'if (col < 0 || col > 31) continue;', 'if (col < 1 || col > 31) continue;')]],
  ['F: byte column 31 is not drawn', [E(FN, 'if (col < 0 || col > 31) continue;', 'if (col < 0 || col > 30) continue;')]],
  ['F: byte column 32 wraps into the next row', [E(FN, 'if (col < 0 || col > 31) continue;', 'if (col < 0 || col > 32) continue;')]],
  ['EQUIVALENT: F: a negative byte column is drawn (rowOff ORs the column in, so a negative column is a negative array index, which a typed array ignores on write and reads as undefined)', [E(FN, 'if (col < 0 || col > 31) continue;', 'if (col > 31) continue;')]],
  ['F: the shift is x AND 7 (not 8 - x AND 7)', [E(FN, 'sh = 8 - s0;', 'sh = s0;')]],
  ['F: the window starts one byte early', [E(FN, 'byte0 = x0 >> 3', 'byte0 = (x0 >> 3) - 1')]],
  ['F: the mask / image words are swapped', [E(FN, 'const mask16 = (asset.data[4 * k] << 8) | asset.data[4 * k + 1], image16 = (asset.data[4 * k + 2] << 8) | asset.data[4 * k + 3];', 'const image16 = (asset.data[4 * k] << 8) | asset.data[4 * k + 1], mask16 = (asset.data[4 * k + 2] << 8) | asset.data[4 * k + 3];')]],
  ['F: the mask\'s shifted-in bits are 0 (the sprite masks the neighbour pixels)', [E(FN, '(mask16 << sh) | (~(0xFFFF << sh) & 0xFFFFFF)', '(mask16 << sh)')]],
  ['F: the blit ORs the image without the mask', [E(FN, 'bits[o] = (bits[o] & mb) | ib;', 'bits[o] = bits[o] | ib;')]],
  ['F: the blit XORs the image', [E(FN, 'bits[o] = (bits[o] & mb) | ib;', 'bits[o] = (bits[o] & mb) ^ ib;')]],
  ['F: the blit ignores the background (image only)', [E(FN, 'bits[o] = (bits[o] & mb) | ib;', 'bits[o] = ib;')]],
  ['F: every byte of the window gets the ink (also those the mask leaves whole)', [E(FN, 'if (mb !== 0xFF) colours[o]', 'if (true) colours[o]')]],
  ['F: only a byte the mask clears everywhere gets the ink (mb === 0)', [E(FN, 'if (mb !== 0xFF) colours[o]', 'if (mb === 0) colours[o]')]],
  ['F: a byte the mask leaves whole gets the ink (inverted test)', [E(FN, 'if (mb !== 0xFF) colours[o]', 'if (mb === 0xFF) colours[o]')]],
  ['F: the ink of row 0 is used for every row', [E(FN, 'spriteColour(colours[o], asset.inks[k])', 'spriteColour(colours[o], asset.inks[0])')]],
  ['F: the ink is the next row\'s', [E(FN, 'spriteColour(colours[o], asset.inks[k])', 'spriteColour(colours[o], asset.inks[k + 1] ?? 0)')]],
  ['F: the sprite sets the colour byte to the ink (colour not kept)', [E(FN, 'colours[o] = spriteColour(colours[o], asset.inks[k]);', 'colours[o] = asset.inks[k] & 7;')]],
  ['F: the sprite is drawn on the colour only (the bitmap kept)', [E(FN, PUT, '        if (mb !== 0xFF) colours[o] = spriteColour(colours[o], asset.inks[k]);')]],
  // ---- arcade-fine.js: fineOfRun ----
  ['F: fineOfRun answers for a record outside a fine scene', [E(FN, 'if (!run?.fine || !rec?.fine) return null;', 'if (!run?.fine) return null;')]],
  ['F: fineOfRun answers for a run without a fine result', [E(FN, 'if (!run?.fine || !rec?.fine) return null;', 'if (!rec?.fine) return null;')]],
  ['F: fineOfRun takes the instance assets from nowhere', [E(FN, 'instAsset: run.fine.instAsset, assets: run.fine.assets,', 'assets: run.fine.assets,')]],
  ['F: fineOfRun draws no tile rows', [E(FN, 'tileRows: run.fine.tileRows, sprites: rec.sprites,', 'sprites: rec.sprites,')]],
  ['F: fineOfRun draws no tile bitmaps', [E(FN, 'glyph: glyphSource({ font, tileBytes: run.fine.tileBytes }),', 'glyph: glyphSource({ font }),')]],
  ['F: fineOfRun draws the attributes as the cells', [E(FN, 'cells: rec.cells, attrs: rec.attrs,', 'cells: rec.cells, attrs: rec.cells,')]],
  // ---- arcade-display.js: built ----
  ['D: a fine scene is built fine in a v3 game too (version not tested)', [E(DP, "const fineOk = version === 2 && !(Array.isArray(ast.wires) && ast.wires.length > 0);", "const fineOk = !(Array.isArray(ast.wires) && ast.wires.length > 0);")]],
  ['D: a fine scene is built fine in a v1 game (version <= 2)', [E(DP, "const fineOk = version === 2 &&", "const fineOk = version <= 2 &&")]],
  ['D: a fine scene is built fine in a v3 game (version >= 2)', [E(DP, "const fineOk = version === 2 &&", "const fineOk = version >= 2 &&")]],
  ['D: a fine scene is built fine beside WIRE3D', [E(DP, "const fineOk = version === 2 && !(Array.isArray(ast.wires) && ast.wires.length > 0);", "const fineOk = version === 2;")]],
  ['D: a game with WIRE3D is never fine (the wires test is inverted)', [E(DP, "const fineOk = version === 2 && !(Array.isArray(ast.wires) && ast.wires.length > 0);", "const fineOk = version === 2 && (Array.isArray(ast.wires) && ast.wires.length > 0);")]],
  ['D: a fine setting is built fine for any scene, the automatic choice counts too', [E(DP, "const built = chosen === 'fine' && fineOk ? 'fine' : 'buffers';", "const built = (chosen === 'fine' || auto === 'fine') && fineOk ? 'fine' : 'buffers';")]],
  ['D: the setting counts (not only the project\'s own): hires is built fine', [E(DP, "const built = chosen === 'fine' && fineOk ? 'fine' : 'buffers';", "const built = (chosen === 'fine' || chosen === 'hires') && fineOk ? 'fine' : 'buffers';")]],
  ['D: nothing is built fine', [E(DP, "const built = chosen === 'fine' && fineOk ? 'fine' : 'buffers';", "const built = 'buffers';")]],
  ['D: the default version is 3', [E(DP, '{ scenes, version = 2 } = {}', '{ scenes, version = 3 } = {}')]],
  // ---- arcade-compile.js: the errors ----
  ['C: a scene the project does not set to fine is checked too (setting, not override)', [E(CM, "sc.override !== 'fine' || sc.built === 'fine') continue;", "sc.setting !== 'fine' || sc.built === 'fine') continue;")]],
  ['C: a scene built fine is reported too', [E(CM, "sc.override !== 'fine' || sc.built === 'fine') continue;", "sc.override !== 'fine') continue;")]],
  ['C: a scene the project sets to buffers is reported', [E(CM, "sc.override !== 'fine' || sc.built === 'fine') continue;", "sc.built === 'fine') continue;")]],
  ['C: the error is a warning', [E(CM, "endCol: sc.col + sc.name.length, severity: 'error', message });\n  }\n  if (out.errors.length)", "endCol: sc.col + sc.name.length, severity: 'warning', message });\n  }\n  if (out.errors.length)")]],
  ['C: the error marks the scene\'s line one off', [E(CM, "out.errors.push({ line: sc.line, col: sc.col, endCol: sc.col + sc.name.length, severity: 'error', message });", "out.errors.push({ line: sc.line + 1, col: sc.col, endCol: sc.col + sc.name.length, severity: 'error', message });")]],
  ['C: the error marks the whole line (column 0)', [E(CM, "out.errors.push({ line: sc.line, col: sc.col, endCol: sc.col + sc.name.length, severity: 'error', message });", "out.errors.push({ line: sc.line, col: 0, endCol: sc.col + sc.name.length, severity: 'error', message });")]],
  ['C: the error ends one column late', [E(CM, "out.errors.push({ line: sc.line, col: sc.col, endCol: sc.col + sc.name.length, severity: 'error', message });", "out.errors.push({ line: sc.line, col: sc.col, endCol: sc.col + sc.name.length + 1, severity: 'error', message });")]],
  ['EQUIVALENT: C: the reasons are asked of a v2 game too (version >= 2) (a v2 game gets the WIRE3D message, which does not read the reasons)', [E(CM, 'const why = version >= 3 ? requiredRuntime', 'const why = version >= 2 ? requiredRuntime')]],
  ['C: the reasons are asked of v4 games only (version >= 4)', [E(CM, 'const why = version >= 3 ? requiredRuntime', 'const why = version >= 4 ? requiredRuntime')]],
  ['C: the reasons are never asked', [E(CM, 'const why = version >= 3 ? requiredRuntime(text, assets).reasons : [];', 'const why = [];')]],
  ['C: the word that decides is not WINDOW / VIEW3D first (first reason)', [E(CM, "const uses = ['WINDOW', 'VIEW3D'].find((w) => why.includes(w)) ?? why.find(", "const uses = why.find(")]],
  ['C: only WINDOW is a deciding word', [E(CM, "['WINDOW', 'VIEW3D'].find", "['WINDOW'].find")]],
  ['C: only VIEW3D is a deciding word', [E(CM, "['WINDOW', 'VIEW3D'].find", "['VIEW3D'].find")]],
  ['EQUIVALENT: C: VIEW3D is looked for first (the reasons of v4 are listed alone: WINDOW and VIEW3D are never both in the list)', [E(CM, "['WINDOW', 'VIEW3D'].find", "['VIEW3D', 'WINDOW'].find")]],
  ['C: a reason that is not a bare word counts as one (no pattern)', [E(CM, "why.find((r) => /^[A-Z][A-Z0-9]*(\\(\\))?$/.test(r))", "why[0]")]],
  ['EQUIVALENT: C: the word pattern lets a lower case reason through (every reason is an upper case word, WORD() or a sprite sentence with quotes: the looser pattern matches exactly the same ones)', [E(CM, "/^[A-Z][A-Z0-9]*(\\(\\))?$/.test(r)", "/^[A-Za-z][A-Za-z0-9 ]*(\\(\\))?$/.test(r)")]],
  ['C: the WIRE3D message is chosen for version 3', [E(CM, "const message = version === 2 ?", "const message = version === 3 ?")]],
  ['C: the WIRE3D message is chosen for every version', [E(CM, "const message = version === 2 ?", "const message = true ?")]],
  ['C: the WIRE3D message text changed', [E(CM, '`${head} cannot be used in a WIRE3D game`', '`${head} cannot be used with WIRE3D`')]],
  ['C: the v-number is dropped from the reason message', [E(CM, '`${head} needs runtime v2; this game uses ${uses} (runtime v${version})`', '`${head} needs runtime v2; this game uses ${uses}`')]],
  ['C: the "other" message names no runtime', [E(CM, '`${head} needs runtime v2; this game is built for runtime v${version}`', '`${head} needs runtime v2`')]],
  ['C: the head names no scene', [E(CM, "const head = `scene '${sc.name}': fine colour (display 'fine')`;", "const head = `fine colour (display 'fine')`;")]],
  ['EQUIVALENT: C: no `!runtime` guard before the fine error (with no runtime the plan assumes version 2, so a fine scene is built fine unless it is a WIRE3D game, which the checker, at version 0, has refused before this loop)', [E(CM, "if (!runtime || sc.override !== 'fine'", "if (sc.override !== 'fine'")]],
  ['C: the fine list given to the code generator is every scene', [E(CM, "{ fine: out.scenes.map((sc) => sc.built === 'fine') }", "{ fine: out.scenes.map(() => true) }")]],
  ['C: the fine list is given only when every scene is fine', [E(CM, "...(out.scenes.some((sc) => sc.built === 'fine') ?", "...(out.scenes.every((sc) => sc.built === 'fine') ?")]],
  ['C: the fine list is never given', [E(CM, "...(out.scenes.some((sc) => sc.built === 'fine') ?", "...(false ?")]],
  // ---- arcade-assets.js ----
  ['A: the row attributes are 7 rows', [E(AS, 'for (let k = 0; k < 8; k++) out[k] = tileAttr(rows?.[k], `${what} row ${k}`);', 'for (let k = 0; k < 7; k++) out[k] = tileAttr(rows?.[k], `${what} row ${k}`);')]],
  ['A: every row takes the first row\'s colours', [E(AS, 'out[k] = tileAttr(rows?.[k], `${what} row ${k}`);', 'out[k] = tileAttr(rows?.[0], `${what} row ${k}`);')]],
  ['A: the rows are taken in reverse', [E(AS, 'out[k] = tileAttr(rows?.[k], `${what} row ${k}`);', 'out[k] = tileAttr(rows?.[7 - k], `${what} row ${k}`);')]],
  ['A: a tile without rows crashes (no ?.)', [E(AS, 'const rows = tile?.rows;\n  const out = new Uint8Array(8);', 'const rows = tile.rows;\n  const out = new Uint8Array(8);')]],
  ['A: the row error does not name the row', [E(AS, '`${what} row ${k}`);', '`${what}`);')]],
  ['A: the row attributes of tile i are stored at 9 i', [E(AS, 'rowAttrs.set(tileRowAttrs(t, `tile ${i}`), i * 8);', 'rowAttrs.set(tileRowAttrs(t, `tile ${i}`), i * 9);')]],
  ['A: the row attributes table has 9 bytes a tile', [E(AS, 'const rowAttrs = new Uint8Array(tiles.length * 8);', 'const rowAttrs = new Uint8Array(tiles.length * 9);')]],
  ['A: a tile with a bad row falls back to zero', [E(AS, 'rowAttrs.fill(bytes[i * 9 + 8], i * 8, i * 8 + 8);', 'rowAttrs.fill(0, i * 8, i * 8 + 8);')]],
  ['A: a tile with a bad row falls back to the first row only (7 rows stay 0)', [E(AS, 'rowAttrs.fill(bytes[i * 9 + 8], i * 8, i * 8 + 8);', 'rowAttrs.fill(bytes[i * 9 + 8], i * 8, i * 8 + 1);')]],
  ['A: the first bad row is not the one reported (the last)', [E(AS, 'rowAttrsProblem ??= e.message;', 'rowAttrsProblem = e.message;')]],
  ['A: a bad row is never reported', [E(AS, 'catch (e) { rowAttrsProblem ??= e.message;', 'catch (e) { rowAttrsProblem ??= null;')]],
  ['A: convertTileset throws for a bad row 1..7 (also a plain game)', [E(AS, 'try { rowAttrs.set(tileRowAttrs(t, `tile ${i}`), i * 8); } catch (e) { rowAttrsProblem ??= e.message; rowAttrs.fill(bytes[i * 9 + 8], i * 8, i * 8 + 8); }', 'rowAttrs.set(tileRowAttrs(t, `tile ${i}`), i * 8);')]],
  ['A: the tile\'s attribute byte (bytes) comes from the last row', [E(AS, 'bytes[i * 9 + 8] = tileAttr(rows[0], `tile ${i}`);', 'bytes[i * 9 + 8] = tileAttr(rows[7], `tile ${i}`);')]],
  ['A: convertTileset does not return rowAttrs', [E(AS, 'return { count: tiles.length, bytes, tiles, flags, flagsProblem, rowAttrs, rowAttrsProblem };', 'return { count: tiles.length, bytes, tiles, flags, flagsProblem, rowAttrsProblem };')]],
  // ---- arcade-codegen.js: convertSprite inks ----
  ['G: the default ink is 0', [E(CG, 'const ink = r.ink === undefined || r.ink === null ? 7 : r.ink;', 'const ink = r.ink === undefined || r.ink === null ? 0 : r.ink;')]],
  ['G: a null ink is an error (only undefined is the default)', [E(CG, 'const ink = r.ink === undefined || r.ink === null ? 7 : r.ink;', 'const ink = r.ink === undefined ? 7 : r.ink;')]],
  ['G: ink 7 is an error', [E(CG, 'ink < 0 || ink > 7) inkProblem', 'ink < 0 || ink >= 7) inkProblem')]],
  ['G: ink 8 is accepted', [E(CG, 'ink < 0 || ink > 7) inkProblem', 'ink < 0 || ink > 8) inkProblem')]],
  ['G: ink 0 is an error', [E(CG, 'ink < 0 || ink > 7) inkProblem', 'ink <= 0 || ink > 7) inkProblem')]],
  ['G: ink -1 is accepted', [E(CG, 'ink < 0 || ink > 7) inkProblem', 'ink < -1 || ink > 7) inkProblem')]],
  ['G: a fractional ink is accepted', [E(CG, '!Number.isInteger(ink) || ink < 0 || ink > 7) inkProblem', 'ink < 0 || ink > 7) inkProblem')]],
  ['G: the last bad ink is the one reported', [E(CG, 'inkProblem ??= `row ${i} ink must', 'inkProblem = `row ${i} ink must')]],
  ['G: the ink message names no row', [E(CG, '`row ${i} ink must be a whole number 0..7, got ${JSON.stringify(r.ink)}`', '`ink must be a whole number 0..7, got ${JSON.stringify(r.ink)}`')]],
  ['G: a bad ink is taken as 0', [E(CG, 'inks[i] = Number.isInteger(ink) ? ink & 7 : 7;', 'inks[i] = Number.isInteger(ink) ? ink & 7 : 0;')]],
  ['G: an out of range ink is not cut to 3 bits', [E(CG, 'inks[i] = Number.isInteger(ink) ? ink & 7 : 7;', 'inks[i] = Number.isInteger(ink) ? ink : 7;')]],
  ['G: the inks are stored from row 1', [E(CG, 'inks[i] = Number.isInteger(ink)', 'inks[i + 1 & 15] = Number.isInteger(ink)')]],
  ['G: the inks table has 8 entries', [E(CG, 'const inks = new Uint8Array(16);', 'const inks = new Uint8Array(8);')]],
  ['G: convertSprite does not return the inks', [E(CG, 'return { w: 16, h, data, srcW: w, inks, inkProblem };', 'return { w: 16, h, data, srcW: w, inkProblem };')]],
  ['G: convertSprite does not return the ink problem', [E(CG, 'return { w: 16, h, data, srcW: w, inks, inkProblem };', 'return { w: 16, h, data, srcW: w, inks };')]],
  // ---- arcade-codegen.js: RT_FINEMODE and the descriptor ----
  ['G: a fine scene passes A = 0', [E(CG, "e.ld('a', fineScenes[k] ? 1 : 0);", "e.ld('a', fineScenes[k] ? 0 : 1);")]],
  ['G: every scene passes A = 1', [E(CG, "e.ld('a', fineScenes[k] ? 1 : 0);", "e.ld('a', 1);")]],
  ['G: every scene passes A = 0', [E(CG, "e.ld('a', fineScenes[k] ? 1 : 0);", "e.ld('a', 0);")]],
  ['G: A = 2 for a fine scene', [E(CG, "e.ld('a', fineScenes[k] ? 1 : 0);", "e.ld('a', fineScenes[k] ? 2 : 0);")]],
  ['G: HL is not loaded with the descriptor', [E(CG, "e.ld('hl', L('fine$desc'));\n    e.call(need('RT_FINEMODE'));", "e.ld('hl', 0);\n    e.call(need('RT_FINEMODE'));")]],
  ['G: the call is dropped', [E(CG, "e.ld('hl', L('fine$desc'));\n    e.call(need('RT_FINEMODE'));", "e.ld('hl', L('fine$desc'));")]],
  ['G: the call goes to RT_CLS', [E(CG, "e.call(need('RT_FINEMODE'));", "e.call(need('RT_CLS'));")]],
  ['G: a program without a fine scene emits the call (no hasFine guard)', [E(CG, '  function emitFineMode(k) {\n    if (!hasFine) return;', '  function emitFineMode(k) {')]],
  ['G: the ENTER sequence does not switch the mode', [E(CG, "      emitFineMode(k);                                                           // fine colour: the same place", "      // emitFineMode(k);                                                           // fine colour: the same place")]],
  ['G: init_entry does not switch the mode (the init_entry call dropped)', [E(CG, 'if (hasFine && fineScenes[0]) emitFineMode(0);', 'if (false) emitFineMode(0);')]],
  ['G: init_entry always switches (also when the first scene is not fine)', [E(CG, 'if (hasFine && fineScenes[0]) emitFineMode(0);', 'if (hasFine) emitFineMode(0);')]],
  ['G: init_entry looks at the second scene', [E(CG, 'if (hasFine && fineScenes[0]) emitFineMode(0);', 'if (hasFine && fineScenes[1]) emitFineMode(0);')]],
  ['G: init_entry switches to the last scene\'s mode', [E(CG, 'if (hasFine && fineScenes[0]) emitFineMode(0);', 'if (hasFine && fineScenes[0]) emitFineMode(scenes.length - 1);')]],
  ['G: the scene flags are taken from the first entry only', [E(CG, 'const fineScenes = scenes.map((_, k) => !!opts.fine?.[k]);', 'const fineScenes = scenes.map(() => !!opts.fine?.[0]);')]],
  ['G: the scene flags are shifted by one', [E(CG, 'const fineScenes = scenes.map((_, k) => !!opts.fine?.[k]);', 'const fineScenes = scenes.map((_, k) => !!opts.fine?.[k + 1]);')]],
  ['G: the descriptor holds the sprite inks first', [E(CG, DESC, "e.label('fine$desc'); e.dw(sprites.length ? L('fine$inks') : 0); e.dw(rowAttrs ? L('fine$rows') : 0);")]],
  ['G: a missing tile table is not 0 (the rows label is used)', [E(CG, DESC, "e.label('fine$desc'); e.dw(L('fine$rows')); e.dw(sprites.length ? L('fine$inks') : 0);")]],
  ['G: no tileset reads as a tile table at the descriptor itself', [E(CG, DESC, "e.label('fine$desc'); e.dw(rowAttrs ? L('fine$rows') : L('fine$desc')); e.dw(sprites.length ? L('fine$inks') : 0);")]],
  ['G: no sprites reads as an ink table at the descriptor itself', [E(CG, DESC, "e.label('fine$desc'); e.dw(rowAttrs ? L('fine$rows') : 0); e.dw(sprites.length ? L('fine$inks') : L('fine$desc'));")]],
  ['G: the ink table pointer is 0 even with sprites', [E(CG, DESC, "e.label('fine$desc'); e.dw(rowAttrs ? L('fine$rows') : 0); e.dw(0);")]],
  ['G: the row table is written even without a tileset', [E(CG, "if (rowAttrs) { e.label('fine$rows'); for (const b of rowAttrs) e.db(b); }", "e.label('fine$rows'); if (rowAttrs) { for (const b of rowAttrs) e.db(b); }")]],
  ['G: the row table holds only the first tile', [E(CG, "for (const b of rowAttrs) e.db(b); }", "for (const b of rowAttrs.slice(0, 8)) e.db(b); }")]],
  ['G: the ink table is written even without sprites', [E(CG, "if (sprites.length) { e.label('fine$inks');", "{ e.label('fine$inks');")]],
  ['G: the ink table has 8 rows per asset', [E(CG, "for (let a = 0; a < MAXASSETS; a++) for (let r = 0; r < 16; r++) e.db(sprites[a]?.inks?.[r] ?? 0);", "for (let a = 0; a < MAXASSETS; a++) for (let r = 0; r < 8; r++) e.db(sprites[a]?.inks?.[r] ?? 0);")]],
  ['G: the ink table has one asset fewer', [E(CG, "for (let a = 0; a < MAXASSETS; a++) for (let r = 0; r < 16; r++) e.db(sprites[a]?.inks?.[r] ?? 0);", "for (let a = 0; a < MAXASSETS - 1; a++) for (let r = 0; r < 16; r++) e.db(sprites[a]?.inks?.[r] ?? 0);")]],
  ['G: an asset without inks has ink 7 in the table', [E(CG, "e.db(sprites[a]?.inks?.[r] ?? 0);", "e.db(sprites[a]?.inks?.[r] ?? 7);")]],
  ['G: the ink table is in row-major order (row, asset)', [E(CG, "for (let a = 0; a < MAXASSETS; a++) for (let r = 0; r < 16; r++) e.db(sprites[a]?.inks?.[r] ?? 0);", "for (let r = 0; r < 16; r++) for (let a = 0; a < MAXASSETS; a++) e.db(sprites[a]?.inks?.[r] ?? 0);")]],
  ['G: the descriptor is written without a fine scene (no hasFine guard)', [E(CG, "    if (hasFine) {                                  // fine colour: the fine descriptor", "    if (true) {                                  // fine colour: the fine descriptor")]],
  ['G: the descriptor size is not counted', [E(CG, 'dataSize.fine = 4 + (rowAttrs ? rowAttrs.length : 0) + (sprites.length ? 16 * MAXASSETS : 0);', 'dataSize.fine = 0;')]],
  ['G: the descriptor size misses the 4 pointer bytes', [E(CG, 'dataSize.fine = 4 + (rowAttrs', 'dataSize.fine = 0 + (rowAttrs')]],
  ['G: the descriptor size misses the row table', [E(CG, 'dataSize.fine = 4 + (rowAttrs ? rowAttrs.length : 0)', 'dataSize.fine = 4 + (0)')]],
  ['G: the descriptor size misses the ink table', [E(CG, '(sprites.length ? 16 * MAXASSETS : 0);\n    }', '0;\n    }')]],
  ['G: the generator result has no fine record', [E(CG, '...(hasFine ? { fine: { scenes: fineScenes, descAt: e.addressOf(\'fine$desc\') } } : {}),', '')]],
  ['G: the fine record has no descriptor address', [E(CG, '{ fine: { scenes: fineScenes, descAt: e.addressOf(\'fine$desc\') } }', '{ fine: { scenes: fineScenes } }')]],
  ['G: the fine record says every scene is fine', [E(CG, '{ fine: { scenes: fineScenes, descAt', '{ fine: { scenes: fineScenes.map(() => true), descAt')]],
  // ---- arcade-codegen.js: the generator's own errors ----
  ['G: a v3 / WIRE3D game is not refused by the generator (the v2 test dropped)', [E(CG, "if (!v2 || v3 || wireDecl) err(scenes[fineScenes.indexOf(true)], 'fine colour needs the v2 runtime and no WIRE3D');", "if (false) err(scenes[fineScenes.indexOf(true)], 'fine colour needs the v2 runtime and no WIRE3D');")]],
  ['G: a game with a WIRE3D is accepted by the generator', [E(CG, "if (!v2 || v3 || wireDecl) err(scenes[fineScenes.indexOf(true)]", "if (!v2 || v3) err(scenes[fineScenes.indexOf(true)]")]],
  ['G: a v3 game is accepted by the generator', [E(CG, "if (!v2 || v3 || wireDecl) err(scenes[fineScenes.indexOf(true)]", "if (!v2 || wireDecl) err(scenes[fineScenes.indexOf(true)]")]],
  ['G: a v0 / v1 runtime is accepted by the generator (the `!v2` term dropped)', [E(CG, "if (!v2 || v3 || wireDecl) err(scenes[fineScenes.indexOf(true)]", "if (v3 || wireDecl) err(scenes[fineScenes.indexOf(true)]")]],
  ['G: the generator\'s error is on the first scene, not the first fine scene', [E(CG, "err(scenes[fineScenes.indexOf(true)], 'fine colour needs the v2 runtime", "err(scenes[0], 'fine colour needs the v2 runtime")]],
  ['G: a bad tile row is not refused in a fine game', [E(CG, 'if (tileset?.rowAttrsProblem) err(', 'if (false) err(')]],
  ['G: a bad tile row is refused at the sprite (not the tileset line)', [E(CG, 'err(tileset.node, `tileset "${tileset.node.asset}": ${tileset.rowAttrsProblem}`);', 'err(scenes[0], `tileset "${tileset.node.asset}": ${tileset.rowAttrsProblem}`);')]],
  ['G: the tile row error does not name the tileset', [E(CG, '`tileset "${tileset.node.asset}": ${tileset.rowAttrsProblem}`', '`${tileset.rowAttrsProblem}`')]],
  ['G: a bad sprite ink is not refused in a fine game', [E(CG, 'for (const sp of sprites) if (sp.inkProblem) err(', 'for (const sp of []) if (sp.inkProblem) err(')]],
  ['G: only the first sprite\'s ink is checked', [E(CG, 'for (const sp of sprites) if (sp.inkProblem) err(', 'for (const sp of sprites.slice(0, 1)) if (sp.inkProblem) err(')]],
  ['G: the ink error is on the scene (not the sprite line)', [E(CG, 'err(sp.node, `sprite "${sp.asset}": ${sp.inkProblem}`)', 'err(scenes[0], `sprite "${sp.asset}": ${sp.inkProblem}`)')]],
  ['G: the ink error does not name the sprite asset', [E(CG, '`sprite "${sp.asset}": ${sp.inkProblem}`', '`${sp.inkProblem}`')]],
  ['G: a bad sprite ink is refused in every game (no hasFine guard)', [E(CG, '    for (const sp of sprites) if (sp.inkProblem) err(sp.node, `sprite "${sp.asset}": ${sp.inkProblem}`);\n', '')]],
  ['G: a runtime without RT_FINEMODE is accepted', [E(CG, 'if (fineScenes[k] && sym.RT_FINEMODE === undefined) err(', 'if (false) err(')]],
  ['G: a scene not set to fine is refused when the runtime lacks RT_FINEMODE', [E(CG, 'if (fineScenes[k] && sym.RT_FINEMODE === undefined) err(', 'if (sym.RT_FINEMODE === undefined) err(')]],
  ['G: the RT_FINEMODE error is on the first scene', [E(CG, "err(sc.namePos ?? sc, `scene '${sc.name}': fine colour needs RT_FINEMODE", "err(scenes[0].namePos ?? scenes[0], `scene '${sc.name}': fine colour needs RT_FINEMODE")]],
  ['G: the RT_FINEMODE error is on the scene line, not at its name', [E(CG, "err(sc.namePos ?? sc, `scene '${sc.name}': fine colour needs RT_FINEMODE", "err(sc, `scene '${sc.name}': fine colour needs RT_FINEMODE")]],
  ['G: the RT_FINEMODE error text changed', [E(CG, '(rebuild the v2 runtime)`', '(rebuild the runtime)`')]],
  // ---- arcade-link.js: the phase cap ----
  ['L: the cap is 33 phases', [E(LK, 'export const FINE_MAX_PHASES = 32;', 'export const FINE_MAX_PHASES = 33;')]],
  ['L: the cap is 31 phases', [E(LK, 'export const FINE_MAX_PHASES = 32;', 'export const FINE_MAX_PHASES = 31;')]],
  ['L: 32 phases are refused (>=)', [E(LK, 'if (phases > FINE_MAX_PHASES) return fail', 'if (phases >= FINE_MAX_PHASES) return fail')]],
  ['L: 33 phases are accepted (> + 1)', [E(LK, 'if (phases > FINE_MAX_PHASES) return fail', 'if (phases > FINE_MAX_PHASES + 1) return fail')]],
  ['EQUIVALENT: L: an asset without phases counts as 4 (a fine game is a v2 game, whose generator always sets `phases`, default 8; the `?? 8` is only a guard)', [E(LK, "if (gen.fine) {                                  // fine colour: the sprite-art cap (the same sum as the WIRE3D one: every asset's phases, 8 when the asset does not say)\n    const phases = gen.sprites.reduce((a, sp) => a + (sp.phases ?? 8), 0);", "if (gen.fine) {                                  // fine colour: the sprite-art cap (the same sum as the WIRE3D one: every asset's phases, 8 when the asset does not say)\n    const phases = gen.sprites.reduce((a, sp) => a + (sp.phases ?? 4), 0);")]],
  ['L: the cap counts the assets, not their phases', [E(LK, "if (gen.fine) {                                  // fine colour: the sprite-art cap (the same sum as the WIRE3D one: every asset's phases, 8 when the asset does not say)\n    const phases = gen.sprites.reduce((a, sp) => a + (sp.phases ?? 8), 0);", "if (gen.fine) {                                  // fine colour: the sprite-art cap (the same sum as the WIRE3D one: every asset's phases, 8 when the asset does not say)\n    const phases = gen.sprites.length;")]],
  ['L: the cap counts the largest asset only', [E(LK, "if (gen.fine) {                                  // fine colour: the sprite-art cap (the same sum as the WIRE3D one: every asset's phases, 8 when the asset does not say)\n    const phases = gen.sprites.reduce((a, sp) => a + (sp.phases ?? 8), 0);", "if (gen.fine) {                                  // fine colour: the sprite-art cap (the same sum as the WIRE3D one: every asset's phases, 8 when the asset does not say)\n    const phases = gen.sprites.reduce((a, sp) => Math.max(a, sp.phases ?? 8), 0);")]],
  ['L: the cap is not checked for a fine game', [E(LK, 'if (phases > FINE_MAX_PHASES) return fail', 'if (false) return fail')]],
  ['L: the cap is checked for a game with a WIRE3D instead', [E(LK, 'if (gen.fine) {                                  // fine colour: the sprite-art cap', 'if (gen.wire) {                                  // fine colour: the sprite-art cap')]],
  ['L: the cap message names the WIRE3D', [E(LK, '`sprite art too large for a fine-colour game:', '`sprite art too large for a WIRE3D game:')]],
  ['L: the cap message does not say the limit', [E(LK, 'at most ${FINE_MAX_PHASES}; use fewer phases`', 'use fewer phases`')]],
  // ---- arcade-interp.js ----
  ['I: the interpreter\'s default runtime version is 3 (no fine scene is built)', [E(IN, 'version: opts.version ?? 2 }).map((sc) => sc.built', 'version: opts.version ?? 3 }).map((sc) => sc.built')]],
  ['I: the interpreter ignores the project\'s scenes (no fine record)', [E(IN, 'const fineScenes = opts.scenes ? sceneDisplayPlan', 'const fineScenes = false ? sceneDisplayPlan')]],
  ['I: every scene with a setting counts as fine', [E(IN, ".map((sc) => sc.built === 'fine') : [];", ".map((sc) => sc.override === 'fine' || sc.setting === 'fine') : [];")]],
  ['I: every scene counts as fine', [E(IN, ".map((sc) => sc.built === 'fine') : [];", ".map(() => true) : [];")]],
  ['I: the record says fine for the first scene always', [E(IN, 'fine: fineScenes[curScene] === true', 'fine: fineScenes[0] === true')]],
  ['I: the record says fine for the next scene', [E(IN, 'fine: fineScenes[curScene] === true', 'fine: fineScenes[curScene + 1] === true')]],
  ['I: the record says fine always', [E(IN, 'fine: fineScenes[curScene] === true', 'fine: true')]],
  ['I: the records of a plain game carry a fine key (no hasFine guard)', [E(IN, '...(hasFine ? { fine: fineScenes[curScene] === true } : {}),', '...({ fine: fineScenes[curScene] === true }),')]],
  ['I: the result of a plain game carries a fine key', [E(IN, 'assetPhases, ...(hasFine ? { fine: fineInfo() } : {}) };', 'assetPhases, fine: fineInfo() };')]],
  ['I: the result of a fine game has no fine key', [E(IN, 'assetPhases, ...(hasFine ? { fine: fineInfo() } : {}) };', 'assetPhases };')]],
  ['I: a game with a fine scene is "fine" only when every scene is', [E(IN, 'const hasFine = fineScenes.some(Boolean);', 'const hasFine = fineScenes.length > 0 && fineScenes.every(Boolean);')]],
  ['I: the result lists the scenes\' flags in reverse', [E(IN, 'scenes: fineScenes.slice(),', 'scenes: fineScenes.slice().reverse(),')]],
  ['I: the result has no tile rows', [E(IN, 'tileRows: tileset ? tileset.rowAttrs : null,', 'tileRows: null,')]],
  ['I: the result has no tile bytes', [E(IN, 'tileBytes: tileset ? tileset.bytes : null,', 'tileBytes: null,')]],
  ['I: the result has no phases for the assets', [E(IN, 'assets: assetObjs.map((as, a) => { try { if (!as) return null; const c = convertSprite(as); return { h: c.h, data: c.data, inks: c.inks, phases: assetPhases[a] }', 'assets: assetObjs.map((as, a) => { try { if (!as) return null; const c = convertSprite(as); return { h: c.h, data: c.data, inks: c.inks }')]],
  ['I: the result has the phases of the next asset', [E(IN, 'assets: assetObjs.map((as, a) => { try { if (!as) return null; const c = convertSprite(as); return { h: c.h, data: c.data, inks: c.inks, phases: assetPhases[a] }', 'assets: assetObjs.map((as, a) => { try { if (!as) return null; const c = convertSprite(as); return { h: c.h, data: c.data, inks: c.inks, phases: assetPhases[a + 1] }')]],
  ['I: the result has no inks', [E(IN, 'assets: assetObjs.map((as, a) => { try { if (!as) return null; const c = convertSprite(as); return { h: c.h, data: c.data, inks: c.inks, phases', 'assets: assetObjs.map((as, a) => { try { if (!as) return null; const c = convertSprite(as); return { h: c.h, data: c.data, phases')]],
  ['I: an unreadable asset is not null (crash)', [E(IN, 'catch { return null; } }),\n    instAsset', 'catch (e) { throw e; } }),\n    instAsset')]],
  ['EQUIVALENT: I: a missing asset is converted anyway (convertSprite(undefined) throws and the catch gives the same null)', [E(IN, 'assets: assetObjs.map((as, a) => { try { if (!as) return null; const c = convertSprite(as);', 'assets: assetObjs.map((as, a) => { try { const c = convertSprite(as);')]],
  ['I: the result has no instance assets', [E(IN, 'instAsset: instAsset.slice(),\n  });', '});')]],
  // ---- arcadec.mjs ----
  ['T: the assets file\'s scenes win over --scenes', [E(AC, 'const scenes = scenesFile ? JSON.parse(readFileSync(resolve(scenesFile), \'utf8\')) : assets.scenes;', 'const scenes = assets.scenes ?? (scenesFile ? JSON.parse(readFileSync(resolve(scenesFile), \'utf8\')) : undefined);')]],
  ['T: the assets file\'s "scenes" key is ignored', [E(AC, ') : assets.scenes;', ') : undefined;')]],
  ['T: --scenes is ignored', [E(AC, 'const scenes = scenesFile ? JSON.parse', 'const scenes = false ? JSON.parse')]],
  ['T: --scenes merges with the assets file (the assets file\'s other scenes stay)', [E(AC, 'const scenes = scenesFile ? JSON.parse(readFileSync(resolve(scenesFile), \'utf8\')) : assets.scenes;', 'const scenes = scenesFile ? { ...assets.scenes, ...JSON.parse(readFileSync(resolve(scenesFile), \'utf8\')) } : assets.scenes;')]],
  ['T: the scenes are not handed to the compiler', [E(AC, 'compile(text, { runtime, image, assets, scenes })', 'compile(text, { runtime, image, assets })')]],
  ['T: --scenes needs no file (no usage error)', [E(AC, "scenesFile = argv[++i] ?? usage('--scenes needs a file')", "scenesFile = argv[++i]")]],
  ['T: --scenes takes the next word as the assets file', [E(AC, "scenesFile = argv[++i] ?? usage('--scenes needs a file')", "assetsFile = argv[++i] ?? usage('--scenes needs a file')")]],
  ['T: the usage text does not name --scenes', [E(AC, "[--assets <assets.json>] [--scenes <scenes.json>] [--runtime auto|v0|v1|v2|v3|v4|<dir|runtime.json>]", "[--assets <assets.json>] [--runtime auto|v0|v1|v2|v3|v4|<dir|runtime.json>]")]],
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
    const r = spawnSync('node', [join(ROOT, t)], { encoding: 'utf8', timeout: 900000, env: { ...process.env, ARCADE_QUICK: '1' }, cwd: ROOT });
    if (r.status !== 0 || r.error) {
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      console.log(`  BASELINE FAILS: ${t} fails without any mutation; fix it before trusting the kills${r.error ? ` (${r.error.message})` : ''}`);
      for (const l of (out.match(/^.*FAIL.*$/gm) ?? out.split('\n').filter(Boolean).slice(-5)).slice(0, 8)) console.log('    ' + l.slice(0, 300));
      process.exit(2);
    }
  }
}
const tmp = mkdtempSync(join(tmpdir(), 'm19cmut-'));
let killed = 0;
const survived = [], equivalent = [], broken = [];
try {
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (mi % shardN !== shardI) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade/tests'), { recursive: true });
    cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
    cpSync(join(ROOT, 'tests'), join(root, 'tests'), { recursive: true });
    cpSync(join(ROOT, 'arcade/examples'), join(root, 'arcade/examples'), { recursive: true });
    cpSync(join(ROOT, 'arcade/tests/fixtures'), join(root, 'arcade/tests/fixtures'), { recursive: true });
    cpSync(join(ROOT, 'arcade/tools'), join(root, 'arcade/tools'), { recursive: true });                   // arcadec (its --scenes)
    for (const v of ['v2', 'v3', 'v4']) for (const f of ['runtime.json', 'runtime.bin']) {                    // the runtime builds the suite compiles with (not the 1 GB of the build directory)
      if (!existsSync(join(ROOT, 'arcade/build', v, f))) continue;
      mkdirSync(join(root, 'arcade/build', v), { recursive: true });
      cpSync(join(ROOT, 'arcade/build', v, f), join(root, 'arcade/build', v, f));
    }
    for (const v of ['v2', 'v3', 'v4']) for (const f of ['runtime.json', 'runtime.bin']) {      // the published runtimes the tests compile with
      if (!existsSync(join(ROOT, 'arcade/dist', v, f))) continue;
      mkdirSync(join(root, 'arcade/dist', v), { recursive: true });
      cpSync(join(ROOT, 'arcade/dist', v, f), join(root, 'arcade/dist', v, f));
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
      const r = spawnSync('node', [join(root, t)], { encoding: 'utf8', timeout: 900000, env: { ...process.env, ARCADE_QUICK: '1' }, cwd: root });
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
