"use strict";
// map-model.mjs -- tests for src/tools/map-model.js (the Leap Arcade Studio map editor's data model).
//   node tests/map-model.mjs
//
// Sections
//   1  creation, presets, the stored form (array / hex, blank), conversion errors
//   2  cells: set / get, pencil, line, rectangle, flood fill (hand-computed pictures, clipping)
//   3  blocks: copy / paste (clipping, skipBlank), resize, statistics
//   4  role limits and validateMap
//   5  windowFrame
//   6  history
//   7  the ten example assets files: round trip (deep equal) and compiled cartridges byte-identical
//   8  validateMap against the REAL compiler: tiny programs with a WINDOW, a cell map, a VIEW3D (runtimes of arcade/dist)
//   9  the object layer (stage 4, M2): round trip, snap / clamp, add / move / delete / props, hit test, sorted view, resize, kind checks
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deepStrictEqual } from 'node:assert';

import * as M from '../src/tools/map-model.js';
import * as S from '../src/tools/sprite-model.js';
import { compile, requiredRuntime } from '../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  cond ? passed++ : failed++;
  return cond;
};
const throws = (fn, rx) => { try { fn(); return false; } catch (e) { return rx ? rx.test(e.message) : true; } };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const deepEq = (a, b) => { try { deepStrictEqual(a, b); return true; } catch { return false; } };

/** A map from ASCII art: '.' blank, a digit or letter (0-9, a-z = 10..35) a tile. */
function art(rows, extra = {}) {
  const w = rows[0].length, h = rows.length;
  const m = M.newMap(w, h, 'screen');
  rows.forEach((r, y) => [...r].forEach((ch, x) => { if (ch !== '.') M.setCell(m, x, y, parseInt(ch, 36)); }));
  return Object.assign(m, extra);
}
/** The picture of a map in the same notation. */
const pic = (m) => Array.from({ length: m.h }, (_, y) => Array.from({ length: m.w }, (_, x) => { const v = m.cells[y * m.w + x]; return v < 0 ? '.' : v.toString(36); }).join(''));

// ── 1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n1. Creation and the stored form');
{
  const s = M.newMap(32, 24, 'screen');
  ok('newMap screen: 32 x 24, 768 blank cells, hex, no tileset, no extra', s.w === 32 && s.h === 24 && s.cells.length === 768 && s.cells.every((v) => v === -1) && s.repr === 'hex' && s.tileset === null && same(s.extra, {}));
  const w = M.newMap(128, 16, 'world');
  ok('newMap world: 128 x 16, every cell tile 0', w.cells.length === 2048 && w.cells.every((v) => v === 0));
  const f = M.newMap(5, 4, 'floorplan');
  ok('newMap floorplan 5 x 4: walls (1) on the outer ring, empty inside', same(pic(f), ['11111', '10001', '10001', '11111']));
  ok('the defaults of a preset are its own size', same([M.newMap(undefined, undefined, 'world').w, M.newMap(undefined, undefined, 'world').h, M.newMap(undefined, undefined, 'floorplan').w, M.newMap(undefined, undefined, 'floorplan').h, M.newMap(undefined, undefined, 'screen').h], [128, 16, 32, 32, 24]));
  ok('a new map is valid for its own role', ['screen', 'world', 'floorplan'].every((p) => M.validateMap(M.newMap(undefined, undefined, p), M.PRESETS[p].role).length === 0));
  ok('newMap refuses sizes outside its role (a 23 wide world, a 33 wide screen, a 3 high floor plan) and an unknown preset',
    throws(() => M.newMap(23, 4, 'world')) && throws(() => M.newMap(33, 4, 'screen')) && throws(() => M.newMap(8, 3, 'floorplan')) && throws(() => M.newMap(8, 8, 'nope')));
  ok('PRESETS carry the three sizes of the contract', same([M.PRESETS.screen.w, M.PRESETS.screen.h, M.PRESETS.world.w, M.PRESETS.world.h, M.PRESETS.floorplan.w, M.PRESETS.floorplan.h], [32, 24, 128, 16, 32, 32]));

  const a = M.fromAsset({ w: 3, h: 2, cells: [0, 1, 255, -1, null, 7], tileset: 'ts', note: { a: [1, 2] } });
  ok('fromAsset (array): blank in its three stored forms reads as -1', same(a.cells, [0, 1, -1, -1, -1, 7]) && a.repr === 'array' && a.tileset === 'ts' && a.w === 3 && a.h === 2);
  { const bk = M.fromAsset({ w: 2, h: 1, cells: 'FF00', bank: 'banked' });
    ok('bank (the banking override) is an unknown key: kept in extra and written back by toAsset', same(bk.extra, { bank: 'banked' }) && M.toAsset(bk).bank === 'banked' && !('bank' in M.toAsset({ ...bk, extra: {} }))); }
  ok('fromAsset keeps unknown keys in extra (a copy), tileset apart', same(a.extra, { note: { a: [1, 2] } }));
  ok('toAsset writes blank as 255 in an array and keeps tileset and the unknown keys', deepEq(M.toAsset(a), { w: 3, h: 2, cells: [0, 1, 255, 255, 255, 7], tileset: 'ts', note: { a: [1, 2] } }));
  const hx = M.fromAsset({ w: 3, h: 2, cells: '00 01 ff 02 FF 7e' });
  ok('fromAsset (hex): whitespace ignored, ff / FF read as blank, representation hex', same(hx.cells, [0, 1, -1, 2, -1, 126]) && hx.repr === 'hex');
  ok('toAsset writes a hex map compact, upper case, blank as FF', M.toAsset(hx).cells === '0001FF02FF7E' && !('tileset' in M.toAsset(hx)));
  ok('exact round trip of a map without blank forms to normalise (array and hex)',
    deepEq(M.toAsset(M.fromAsset({ w: 2, h: 2, cells: [1, 2, 255, 3] })), { w: 2, h: 2, cells: [1, 2, 255, 3] }) && deepEq(M.toAsset(M.fromAsset({ w: 2, h: 1, cells: '01FF', tileset: 'x', k: 1 })), { w: 2, h: 1, cells: '01FF', tileset: 'x', k: 1 }));
  ok('DOCUMENTED NORMALISATION: -1 / null become 255, hex becomes compact upper case; reading it again gives the same map',
    deepEq(M.toAsset(M.fromAsset({ w: 2, h: 1, cells: [-1, null] })), { w: 2, h: 1, cells: [255, 255] }) && deepEq(M.toAsset(M.fromAsset({ w: 2, h: 1, cells: '0a ff' })), { w: 2, h: 1, cells: '0AFF' }));
  ok('a tileset that is not a name is kept as an unknown key', deepEq(M.toAsset(M.fromAsset({ w: 1, h: 1, cells: [1], tileset: 5 })), { w: 1, h: 1, cells: [1], tileset: 5 }));
  ok('toAsset gives copies: editing the map afterwards does not change the asset written', (() => { const m = M.fromAsset({ w: 1, h: 1, cells: [1], k: { a: 1 } }), o = M.toAsset(m); m.extra.k.a = 2; m.cells[0] = 9; return o.cells[0] === 1 && o.k.a === 1; })());
  ok('fromAsset copies too: the asset is not touched by edits', (() => { const asset = { w: 2, h: 1, cells: [1, 2], k: { a: 1 } }, m = M.fromAsset(asset); M.setCell(m, 0, 0, 9); m.extra.k.a = 5; return asset.cells[0] === 1 && asset.k.a === 1; })());
  ok('fromAsset refuses unreadable maps with a message: not an object, bad w / h, no cells, a short cell list, odd hex, a fractional or negative cell',
    throws(() => M.fromAsset(null), /not an object/) && throws(() => M.fromAsset({ w: 0, h: 1, cells: [] }), /w must/) && throws(() => M.fromAsset({ w: 1, h: 257, cells: [] }), /h must/) && throws(() => M.fromAsset({ w: 1, h: 1 }), /needs "cells"/)
    && throws(() => M.fromAsset({ w: 2, h: 2, cells: [1] }), /4 cells but "cells" has 1/) && throws(() => M.fromAsset({ w: 1, h: 1, cells: '0' }), /hex/) && throws(() => M.fromAsset({ w: 1, h: 1, cells: [1.5] }), /cell 0/) && throws(() => M.fromAsset({ w: 1, h: 1, cells: [-2] }), /cell 0/));
  ok('a tile above 127 reads (the compiler rejects it, validateMap says so); a hex map cannot hold one on write',
    M.fromAsset({ w: 1, h: 1, cells: [200] }).cells[0] === 200 && throws(() => M.toAsset({ ...M.fromAsset({ w: 1, h: 1, cells: [300] }), repr: 'hex' }), /hex map/));
  const c = M.cloneMap(a); M.setCell(c, 0, 0, 5); c.extra.note.a.push(3);
  ok('cloneMap is deep', a.cells[0] === 0 && a.extra.note.a.length === 2 && c.cells[0] === 5);
}

// ── 2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n2. Cells and drawing');
{
  const m = M.newMap(8, 6, 'screen');
  ok('getCell: blank is -1, outside is undefined', M.getCell(m, 0, 0) === -1 && M.getCell(m, 8, 0) === undefined && M.getCell(m, -1, 0) === undefined && M.getCell(m, 0, 6) === undefined);
  ok('setCell returns true on a change, false when unchanged or outside', M.setCell(m, 2, 3, 5) === true && M.setCell(m, 2, 3, 5) === false && M.setCell(m, 9, 3, 5) === false && M.getCell(m, 2, 3) === 5);
  ok('setCell(255) writes blank; setCell(-1) erases', M.setCell(m, 2, 3, 255) === true && M.getCell(m, 2, 3) === -1 && M.setCell(m, 2, 3, 4) && M.setCell(m, 2, 3, -1) && M.getCell(m, 2, 3) === -1);
  ok('setCell refuses a value that is not -1 or 0..254', throws(() => M.setCell(m, 0, 0, 256)) && throws(() => M.setCell(m, 0, 0, -2)) && throws(() => M.setCell(m, 0, 0, 1.5)) && throws(() => M.setCell(m, 0, 0, 'a')));
  ok('pencil is setCell', M.pencil === M.setCell);

  const l = M.newMap(8, 6, 'screen');
  ok('drawLine: the pixels of sprite-model line (both ends), n = their number', M.drawLine(l, 0, 0, 7, 5, 1) === S.line(0, 0, 7, 5).length && same(S.line(0, 0, 7, 5).map(([x, y]) => M.getCell(l, x, y)), new Array(8).fill(1)));
  ok('the line is exactly the cells of S.line (nothing else is set)', l.cells.filter((v) => v === 1).length === S.line(0, 0, 7, 5).length);
  ok('map-model re-exports line', M.line === S.line);
  const l2 = M.newMap(5, 5, 'screen');
  M.drawLine(l2, 0, 4, 4, 0, 2);
  ok('drawLine diagonal, hand-computed', same(pic(l2), ['....2', '...2.', '..2..', '.2...', '2....']));
  const l3 = M.newMap(4, 3, 'screen');
  ok('drawLine clipped: a line from (-3, 1) to (6, 1) paints the 4 cells inside and reports 4', M.drawLine(l3, -3, 1, 6, 1, 3) === 4 && same(pic(l3), ['....', '3333', '....']));
  ok('drawLine entirely outside changes nothing', M.drawLine(l3, 10, 10, 20, 12, 3) === 0 && M.drawLine(l3, 0, 1, 3, 1, 3) === 0);

  const r = M.newMap(6, 5, 'screen');
  ok('rect outline (1,1)-(4,3): the border only', M.rect(r, 1, 1, 4, 3, 9) === 10 && same(pic(r), ['......', '.9999.', '.9..9.', '.9999.', '......']));
  const r2 = M.newMap(6, 5, 'screen');
  ok('rect filled, corners in any order, hand-computed', M.rect(r2, 4, 3, 1, 1, 7, { filled: true }) === 12 && same(pic(r2), ['......', '.7777.', '.7777.', '.7777.', '......']));
  const r3 = M.newMap(6, 5, 'screen');
  M.rect(r3, -2, -2, 2, 2, 1);
  ok('rect outline clipped: the part of the border inside the map (right and bottom edges of the box)', same(pic(r3), ['..1...', '..1...', '111...', '......', '......']));
  const r4 = M.newMap(6, 5, 'screen');
  ok('rect filled clipped to the map, count of the cells inside', M.rect(r4, 4, 3, 10, 10, 2, { filled: true }) === 4 && same(pic(r4), ['......', '......', '......', '....22', '....22']));
  ok('rect of one cell (x0 = x1, y0 = y1) paints that cell; outline of a 1 x 3 box paints all three', M.rect(r4, 0, 0, 0, 0, 5) === 1 && M.rect(r4, 0, 1, 0, 3, 5) === 3);

  ok('the art / pic helpers of this file agree', same(pic(art(['..1.', '.1..', '1...', '....'])), ['..1.', '.1..', '1...', '....']));
  const g = art(['11.1', '1..1', '.11.', '1111']);
  ok('floodFill the blank region at (1,1): the three connected blanks (2,0) (1,1) (2,1); the blanks at (0,2) and (3,2) are separate regions',
    M.floodFill(g, 1, 1, 8) === 3 && same(pic(g), ['118' + '1', '1881', '.11.', '1111']));
  const g2 = art(['11.1', '1..1', '.11.', '1111']);
  ok('floodFill is 4-connected: blank (0,2) and blank (3,2) stay separate from the middle region', M.floodFill(g2, 2, 0, 5) === 1 + 2 && same(pic(g2), ['115' + '1', '155' + '1', '.11.', '1111']));
  const g3 = art(['aaab', 'abbb', 'aaab']);
  ok('floodFill on tiles: the 8 a-cells form one region (4-connected through the left column)', M.floodFill(g3, 0, 0, 0) === 7 && same(pic(g3), ['000b', '0bbb', '000b']));
  const g4 = M.newMap(4, 3, 'screen');
  ok('floodFill of an empty map fills every cell; filling with the same value is 0 cells; outside is 0', M.floodFill(g4, 3, 2, 6) === 12 && g4.cells.every((v) => v === 6) && M.floodFill(g4, 0, 0, 6) === 0 && M.floodFill(g4, 9, 9, 1) === 0);
  const g5 = art(['1.1', '.1.', '1.1']);
  ok('floodFill: diagonal neighbours are not connected (the centre 1 and the corners are separate regions)', M.floodFill(g5, 1, 1, 2) === 1 && same(pic(g5), ['1.1', '.2.', '1.1']));
  const g6 = art(['1.1', '.1.', '1.1']);
  ok('floodFill the blanks: blank is a value (the four edge blanks are four regions)', M.floodFill(g6, 1, 0, 3) === 1);
  const g7 = art(['ab', 'ba']);
  ok('floodFill with blank (-1 or 255) as the new value erases the region', M.floodFill(g7, 0, 0, 255) === 1 && same(pic(g7), ['.b', 'ba']) && M.floodFill(g7, 0, 0, 5) === 1);
}

// ── 3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n3. Blocks, resize, statistics');
{
  const m = art(['1234', '5678', '9abc']);
  const b = M.copyBlock(m, 1, 0, 2, 2);
  ok('copyBlock (1,0,2,2): the block, row-major', b.w === 2 && b.h === 2 && same(b.cells, [2, 3, 6, 7]));
  ok('copyBlock clipped to the map: (3,1,5,5) is the 1 x 2 corner, (-1,-1,2,2) the single cell (0,0), outside is 0 x 0', same(M.copyBlock(m, 3, 1, 5, 5), { w: 1, h: 2, cells: [8, 12] }) && same(M.copyBlock(m, -1, -1, 2, 2), { w: 1, h: 1, cells: [1] }) && same(M.copyBlock(m, 9, 9, 2, 2), { w: 0, h: 0, cells: [] }));
  ok('copyBlock copies blanks as -1 and does not alias the map', (() => { const a = art(['1.', '.2']); const bl = M.copyBlock(a, 0, 0, 2, 2); a.cells[0] = 9; return same(bl.cells, [1, -1, -1, 2]); })());
  const p = M.newMap(4, 3, 'screen');
  ok('pasteBlock at (1,1): hand-computed, count of cells changed', M.pasteBlock(p, b, 1, 1) === 4 && same(pic(p), ['....', '.23.', '.67.']));
  const p2 = M.newMap(4, 3, 'screen');
  ok('pasteBlock clipped on the right and bottom: (3,2) takes only the first cell', M.pasteBlock(p2, b, 3, 2) === 1 && same(pic(p2), ['....', '....', '...2']));
  const p3 = M.newMap(4, 3, 'screen');
  ok('pasteBlock clipped on the left and top: (-1,-1) takes the last cell at (0,0)', M.pasteBlock(p3, b, -1, -1) === 1 && same(pic(p3), ['7...', '....', '....']));
  const p4 = art(['aaa', 'aaa']), blk = { w: 2, h: 1, cells: [-1, 5] };
  ok('pasteBlock overwrites with blank by default, skipBlank leaves the map alone there', M.pasteBlock(p4, blk, 0, 0) === 2 && same(pic(p4), ['.5a', 'aaa']) && M.pasteBlock(p4, blk, 1, 1, { skipBlank: true }) === 1 && same(pic(p4), ['.5a', 'aa5']));
  ok('pasteBlock of an empty block changes nothing', M.pasteBlock(p4, { w: 0, h: 0, cells: [] }, 0, 0) === 0);
  ok('a pasted block of the same map into itself moves nothing (copy then paste at the same place)', (() => { const a = art(['12', '34']); return M.pasteBlock(a, M.copyBlock(a, 0, 0, 2, 2), 0, 0) === 0; })());

  const rs = art(['1234', '5678', '9abc']);
  M.resize(rs, 2, 2);
  ok('resize crops at the bottom-right (top-left anchored)', rs.w === 2 && rs.h === 2 && same(pic(rs), ['12', '56']));
  M.resize(rs, 4, 3);
  ok('resize pads with blank at the right and bottom, the old cells stay at the top-left', same(pic(rs), ['12..', '56..', '....']));
  const rs2 = art(['123', '456']);
  M.resize(rs2, 5, 1);
  ok('resize wider and shorter at once', same(pic(rs2), ['123..']));
  const rs3 = art(['12', '34']);
  ok('resize to the same size keeps everything; it returns the map', M.resize(rs3, 2, 2) === rs3 && same(pic(rs3), ['12', '34']));
  ok('resize refuses 0, 257 and a fraction; the map is unchanged', throws(() => M.resize(rs3, 0, 2)) && throws(() => M.resize(rs3, 2, 257)) && throws(() => M.resize(rs3, 2.5, 2)) && rs3.w === 2 && same(pic(rs3), ['12', '34']));
  ok('resize keeps representation, tileset and extra', (() => { const a = M.fromAsset({ w: 2, h: 1, cells: '0102', tileset: 'ts', k: 1 }); M.resize(a, 3, 1); return same(M.toAsset(a), { w: 3, h: 1, cells: '0102FF', tileset: 'ts', k: 1 }); })());

  const st = art(['11.2', '1.2.', '..30']);
  ok('cellsUsing: the [x, y] of the cells with a tile, row-major', same(M.cellsUsing(st, 1), [[0, 0], [1, 0], [0, 1]]) && same(M.cellsUsing(st, 0), [[3, 2]]) && same(M.cellsUsing(st, 9), []));
  ok('cellsUsing(-1) and (255) find the blanks', M.cellsUsing(st, -1).length === 5 && same(M.cellsUsing(st, 255), M.cellsUsing(st, -1)));
  ok('usedTiles: ascending, blank is not a tile', same(M.usedTiles(st), [0, 1, 2, 3]));
  ok('usedTiles with blankAs 0 counts the blanks as tile 0 (a world map)', same(M.usedTiles(art(['1.', '22']), { blankAs: 0 }), [0, 1, 2]) && same(M.usedTiles(art(['1.', '22'])), [1, 2]));
  const tc = M.tileCounts(st);
  ok('tileCounts: a Map in ascending order, blank under -1', same([...tc], [[-1, 5], [0, 1], [1, 3], [2, 2], [3, 1]]));
  ok('tileCounts with blankAs merges the blanks into that tile', same([...M.tileCounts(art(['0.', '.1']), { blankAs: 0 })], [[0, 3], [1, 1]]));
  ok('the counts add up to the number of cells', [...tc.values()].reduce((a, b) => a + b, 0) === 12);
}

// ── 4 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n4. Role limits and validateMap');
{
  const L = M.mapRoleLimits;
  ok('limits: cell 1..32 x 1..24 tiles 0..127', same([L('cell').minW, L('cell').maxW, L('cell').minH, L('cell').maxH, L('cell').maxTile], [1, 32, 1, 24, 127]));
  ok('limits: world 24..128 x 1..16 tiles 0..31, blank is tile 0', same([L('world').minW, L('world').maxW, L('world').minH, L('world').maxH, L('world').maxTile, L('world').blank], [24, 128, 1, 16, 31, 'tile0']));
  ok('limits: floor plan 4..32 each side, values 0..4, outer ring', same([L('floorplan').minW, L('floorplan').maxW, L('floorplan').minH, L('floorplan').maxH, L('floorplan').maxTile, L('floorplan').ring], [4, 32, 4, 32, 4, true]));
  ok('mapRoleLimits: "screen" is the cell role; an unknown role throws', L('screen') === L('cell') && throws(() => L('sprite')));

  const v = (m, role, o) => M.validateMap(m, role, o);
  ok('a valid 32 x 24 cell map, tiles 0..127 and blanks: no problems', v(M.fromAsset({ w: 32, h: 24, cells: Array.from({ length: 768 }, (_, i) => (i % 3 ? i % 128 : -1)) }), 'cell').length === 0);
  ok('cell map 33 wide / 25 high: one message each', same(v(M.newMap(8, 8, 'screen') && { w: 33, h: 1, cells: new Array(33).fill(0) }, 'cell').length, 1) && /width must be a whole number 1\.\.32, got 33/.test(v({ w: 33, h: 1, cells: new Array(33).fill(0) }, 'cell')[0]) && /height must be a whole number 1\.\.24, got 25/.test(v({ w: 1, h: 25, cells: new Array(25).fill(0) }, 'cell')[0]));
  ok('cell map: tile 128 is refused, 127 is fine, blank is fine; ONE message for several cells that name the first', (() => {
    const bad = art(['0', '0']); bad.cells = [128, 200]; bad.h = 2; bad.w = 1;
    const p = v(bad, 'cell');
    return p.length === 1 && /2 cells outside 0\.\.127/.test(p[0]) && /row 0, column 0/.test(p[0]) && v({ w: 1, h: 1, cells: [127] }, 'cell').length === 0;
  })());
  ok('world: 23 wide refused, 24 and 128 fine, 129 refused, 17 high refused', v(M.newMap(24, 1, 'world'), 'world').length === 0 && v({ w: 128, h: 16, cells: new Array(2048).fill(0) }, 'world').length === 0 && v({ w: 129, h: 1, cells: new Array(129).fill(0) }, 'world').length === 1 && v({ w: 24, h: 17, cells: new Array(24 * 17).fill(0) }, 'world').length === 1 && v({ w: 23, h: 1, cells: new Array(23).fill(0) }, 'world').length === 1);
  ok('world: tile 32 refused, 31 fine, blank fine (it is tile 0)', v({ w: 24, h: 1, cells: [...new Array(23).fill(-1), 31] }, 'world').length === 0 && /outside 0\.\.31/.test(v({ w: 24, h: 1, cells: [...new Array(23).fill(0), 32] }, 'world')[0]));
  ok('world with tileCount: a tile at or above it is undefined (its own message); without tileCount it is not checked', (() => {
    const m = { w: 24, h: 1, cells: [...new Array(22).fill(0), 7, 9] };
    const p = M.mapProblems(m, 'world', { tileCount: 8 });
    return p.length === 1 && p[0].kind === 'undefined-tile' && same(p[0].cells, [[23, 0]]) && /tile 9/.test(p[0].message) && v(m, 'world').length === 0;
  })());
  ok('cell map with tileCount 3 and tile 5: undefined', M.mapProblems({ w: 1, h: 1, cells: [5] }, 'cell', { tileCount: 3 })[0].kind === 'undefined-tile');
  const fp = (rows) => ({ w: rows[0].length, h: rows.length, cells: rows.join('').split('').map((c) => (c === '.' ? -1 : +c)) });
  ok('floor plan 4 x 4 with walls all round: fine; 3 wide and 33 wide refused', v(fp(['1111', '1001', '1001', '1111']), 'floorplan').length === 0 && v({ w: 3, h: 4, cells: new Array(12).fill(1) }, 'floorplan').length === 1 && v({ w: 33, h: 4, cells: new Array(132).fill(1) }, 'floorplan').length === 1);
  ok('floor plan: value 5 refused, 4 fine', v(fp(['1111', '1541', '1001', '1111']), 'floorplan').length === 1 && v(fp(['1111', '1441', '1001', '1111']), 'floorplan').length === 0);
  ok('floor plan: an empty (0) cell on the outer ring, and a blank one, are errors naming row and column; the interior may be empty or blank',
    /row 3, column 2/.test(v(fp(['1111', '1001', '1001', '1101']), 'floorplan')[0]) && same(M.mapProblems(fp(['1.11', '1001', '1001', '1111']), 'floorplan')[0].cells, [[1, 0]]) && v(fp(['1111', '1..1', '1001', '1111']), 'floorplan').length === 0);
  ok('floor plan: several ring cells give ONE message with all of them', (() => { const p = M.mapProblems(fp(['0110', '1001', '1001', '0110']), 'floorplan'); return p.length === 1 && p[0].kind === 'ring' && p[0].cells.length === 4; })());
  ok('a cell list of the wrong length is a problem (and nothing else is reported)', same(v({ w: 4, h: 4, cells: [1] }, 'floorplan').length, 1) && /16 cells but "cells" has 1/.test(v({ w: 4, h: 4, cells: [1] }, 'floorplan')[0]));
  ok('validateMap works on a map read from an asset and for the alias "screen"', v(M.fromAsset({ w: 2, h: 2, cells: [0, 1, 2, 3] }), 'screen').length === 0);
  ok('an unknown role throws', throws(() => v(M.newMap(4, 4, 'screen'), 'bogus')));
}

// ── 5 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n5. windowFrame');
{
  const w = M.newMap(128, 16, 'world');
  const f = (cam, m = w, o) => M.windowFrame(m, cam, o);
  ok('camera 0: cells 0..23, phase 0', same(f(0), { x0: 0, x1: 23, camX: 0, phase: 0 }));
  ok('camera 8: cells 1..24; camera 16: 2..25 (24 cells when a multiple of 8)', f(8).x0 === 1 && f(8).x1 === 24 && f(16).x0 === 2 && f(16).x1 === 25);
  ok('camera 5: cells 0..24 (25 touched, phase 5); camera 13: 1..25', same(f(5), { x0: 0, x1: 24, camX: 5, phase: 5 }) && f(13).x0 === 1 && f(13).x1 === 25 && f(13).phase === 5);
  ok('camera 7: 0..24; camera 191: 23..47', f(7).x1 === 24 && f(191).x0 === 23 && f(191).x1 === 47);
  ok('camMax of a 128 world is 128*8-192 = 832: that camera shows cells 104..127; beyond it is clamped', same(f(832), { x0: 104, x1: 127, camX: 832, phase: 0 }) && same(f(5000), { x0: 104, x1: 127, camX: 832, phase: 0 }));
  ok('negative and non-numeric cameras clamp to 0', f(-40).camX === 0 && f(NaN).camX === 0 && f(undefined).x0 === 0);
  ok('a fractional camera is cut (the camera is whole pixels)', f(9.9).camX === 9);
  const n = M.newMap(24, 4, 'world');
  ok('a 24 wide world cannot scroll: camMax 0, the frame is the whole map', same(f(100, n), { x0: 0, x1: 23, camX: 0, phase: 0 }));
  const mid = M.newMap(60, 16, 'world');
  ok('a 60 wide world: camMax 60*8-192 = 288; with a ratio-4 band (codes [3, 4]) it is halved to 144', f(9999, mid).camX === 288 && f(9999, mid, { codes: [3, 4] }).camX === 144 && f(288, mid).x1 === 59);
  const aw = await import('../src/lang/arcade/arcade-window.js');
  ok('camMax of arcade-window.js equals the clamp used (all widths 24..128, both ratio sets)', Array.from({ length: 105 }, (_, i) => 24 + i).every((ww) => f(1e6, M.newMap(ww, 1, 'world')).camX === aw.camMax(ww, [3]) && f(1e6, M.newMap(ww, 1, 'world'), { codes: [4] }).camX === aw.camMax(ww, [4])));
}

// ── 6 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n6. History');
{
  ok('createHistory is the sprite model\'s', M.createHistory === S.createHistory);
  const m = M.newMap(4, 4, 'screen');
  const h = M.createHistory(m);
  M.setCell(m, 1, 1, 5);
  ok('commit records a change, an unchanged map is not a step', h.commit(m) === true && h.commit(m) === false && h.canUndo && !h.canRedo);
  M.drawLine(m, 0, 0, 3, 3, 2);
  h.commit(m);
  const u = h.undo();
  ok('undo returns the previous map (a plain object that reads back with the same cells)', same(u.cells, (() => { const t = M.newMap(4, 4, 'screen'); M.setCell(t, 1, 1, 5); return t.cells; })()) && u.repr === 'hex' && u.w === 4);
  const r = h.redo();
  ok('redo returns the later map; the history keeps the representation, tileset and extra', same(r.cells, m.cells) && (() => { const a = M.fromAsset({ w: 1, h: 1, cells: [1], tileset: 'q', k: 2 }), hh = M.createHistory(a); M.setCell(a, 0, 0, 2); hh.commit(a); return same(hh.undo(), { w: 1, h: 1, cells: [1], repr: 'array', tileset: 'q', extra: { k: 2 } }); })());
  const big = M.newMap(128, 16, 'world'), hb = M.createHistory(big);
  for (let i = 0; i < 250; i++) { M.setCell(big, i % 128, (i / 128) | 0, 1 + (i % 30)); hb.commit(big); }
  ok('the history is limited to 200 snapshots (createHistory of the sprite model: at most 199 undo steps)', hb.depth.undo === 199, `depth ${hb.depth.undo}`);
}

// ── 7 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n7. The example assets files: round trip and compiled cartridges');
const RT = {};
for (const v of ['v2', 'v3', 'v4']) {
  const dir = ['dist', 'build'].map((d) => join(ROOT, 'arcade', d, v)).find((d) => existsSync(join(d, 'runtime.json')));
  if (dir) RT[v] = { runtime: JSON.parse(readFileSync(join(dir, 'runtime.json'), 'utf8')), image: new Uint8Array(readFileSync(join(dir, 'runtime.bin'))) };
}
const compileWith = (text, assets) => {
  const need = requiredRuntime(text, assets), v = need.version >= 4 ? 'v4' : need.version === 3 ? 'v3' : 'v2';
  return RT[v] ? compile(text, { ...RT[v], assets }) : null;
};
{
  const dir = join(ROOT, 'arcade/examples');
  const files = readdirSync(dir).filter((f) => f.endsWith('.assets.json')).sort();
  ok(`${files.length} example assets files found`, files.length === 10, files.join(' '));
  let maps = 0, compiled = 0;
  for (const f of files) {
    const assets = JSON.parse(readFileSync(join(dir, f), 'utf8')), name = f.replace('.assets.json', '');
    const round = { ...assets, maps: Object.fromEntries(Object.entries(assets.maps ?? {}).map(([k, a]) => [k, M.toAsset(M.fromAsset(a))])) };
    const count = Object.keys(assets.maps ?? {}).length;
    maps += count;
    ok(`${name}: ${count} map(s) round trip to a deep-equal asset (and JSON-identical)`, deepEq(round.maps, assets.maps ?? {}) && JSON.stringify(round.maps) === JSON.stringify(assets.maps ?? {}));
    const text = readFileSync(join(dir, name + '.arc'), 'utf8');
    const a = compileWith(text, assets), b = compileWith(text, JSON.parse(JSON.stringify(round)));
    if (!a) { console.log(`  SKIP  ${name}: no runtime build (arcade/dist or arcade/build)`); continue; }
    compiled++;
    ok(`${name}: compiles, and the cartridge from the round-tripped assets is byte-identical`, a.errors.length === 0 && b.errors.length === 0 && !!a.dck && Buffer.compare(Buffer.from(a.dck), Buffer.from(b.dck)) === 0, `${a.dck?.length} bytes`);
  }
  ok('all nineteen maps of the examples were seen (pf_world; shooter: sky, logo, press, gameover; shooter-classic: sky; vl_maze, vl_panel, vl_title; runner: pf_world, rn_world2, rn_world3, rn_world4, rn_title: the title pictures of batch 7; lumen: maze1, maze2, logo, press, over)', maps === 19, String(maps));

  // the blank forms: the compiler treats -1, null, 255 and 'ff' alike, so the normalisation cannot change a cartridge
  const sh = JSON.parse(readFileSync(join(dir, 'shooter.assets.json'), 'utf8')), shText = readFileSync(join(dir, 'shooter.arc'), 'utf8');
  const blanks = { w: 32, h: 24, cells: Array.from({ length: 768 }, (_, i) => (i % 7 === 0 ? [-1, null, 255][i % 3] : i % 4)) };
  const hexForm = { w: 32, h: 24, cells: blanks.cells.map((v) => (v === -1 || v === null || v === 255 ? 'ff' : v.toString(16).padStart(2, '0')).toUpperCase()).join(' ').toLowerCase() };
  const mk = (map) => compileWith(shText, { ...sh, maps: { ...sh.maps, sky: map } });
  const c0 = mk(blanks), c1 = mk(M.toAsset(M.fromAsset(blanks))), c2 = mk(hexForm), c3 = mk(M.toAsset(M.fromAsset(hexForm)));
  if (!c0) console.log('  SKIP  blank forms: no runtime build');
  else {
    const eq = (x, y) => x.errors.length === 0 && y.errors.length === 0 && Buffer.compare(Buffer.from(x.dck), Buffer.from(y.dck)) === 0;
    ok('a map with blanks written as -1, null and 255: the round-tripped one (255 only) compiles byte-identical', eq(c0, c1));
    ok('the same map as a lower-case spaced hex string and as a compact upper-case one: byte-identical, and equal to the array form', eq(c2, c3) && eq(c0, c2));
  }
}

// ── 8 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n8. validateMap agrees with the real compiler');
{
  const ts = { tiles: Array.from({ length: 40 }, () => ({ flags: 0, rows: Array.from({ length: 8 }, () => ({ bits: '00', ink: 0, paper: 7, bright: 0 })) })) };
  const prog = (extra) => `GAME "t"\nFRAMERATE 12\nTILESET ts = "ts"\nMAP level = "m"\n${extra}SCENE s\n  DIM v\n  PROC INIT()\n  ENDP\n  PROC FRAME()\n    v = 1\n  ENDP\nENDSCENE\n`;
  const ROLE_SRC = { world: prog('WINDOW level\n'), floorplan: prog('VIEW3D level\n'), cell: prog('') };
  const ts128 = { tiles: Array.from({ length: 128 }, () => ts.tiles[0]) };
  const compiles = (role, asset, tiles = ts) => {
    const text = ROLE_SRC[role], v = role === 'world' ? 'v3' : role === 'floorplan' ? 'v4' : 'v2';
    if (!RT[v]) return null;
    const r = compile(text, { ...RT[v], assets: { sprites: {}, tilesets: { ts: tiles }, sfx: {}, maps: { m: asset } } });
    return { ok: r.errors.length === 0 && !!r.dck, msg: r.errors.map((e) => e.message).join(' | ') };
  };
  const cases = [];
  const add = (name, role, asset, expectOk, tiles = ts) => cases.push({ name, role, asset, expectOk, tiles });
  const filled = (w, h, v) => ({ w, h, cells: new Array(w * h).fill(v) });
  add('world 24 x 1, all tile 0', 'world', filled(24, 1, 0), true);
  add('world 128 x 16 (the largest)', 'world', filled(128, 16, 1), true);
  add('world 23 wide', 'world', filled(23, 2, 0), false);
  add('world 129 wide', 'world', filled(129, 2, 0), false);
  add('world 17 high', 'world', filled(24, 17, 0), false);
  add('world with a tile 32 cell', 'world', { w: 24, h: 1, cells: [...new Array(23).fill(0), 32] }, false);
  add('world with tile 31 and blank (-1) cells', 'world', { w: 24, h: 1, cells: [...new Array(22).fill(-1), 31, null] }, true);
  add('world with a tile the tile set lacks (39 of 40 is defined)', 'world', { w: 24, h: 1, cells: [...new Array(23).fill(0), 31] }, true);
  add('cell map 32 x 24 full of tile 127', 'cell', filled(32, 24, 127), true, ts128);
  add('cell map 33 wide', 'cell', filled(33, 1, 0), false);
  add('cell map 25 high', 'cell', filled(1, 25, 0), false);
  add('cell map with tile 128', 'cell', { w: 2, h: 1, cells: [0, 128] }, false);
  add('cell map with tile 40 (tile set has 40: 0..39)', 'cell', { w: 2, h: 1, cells: [0, 40] }, false);
  add('cell map with tile 39 and blanks (-1, null, 255)', 'cell', { w: 4, h: 1, cells: [39, -1, null, 255] }, true);
  const plan = (rows) => ({ w: rows[0].length, h: rows.length, cells: rows.join('').split('').map((c) => (c === '.' ? 255 : +c)) });
  add('floor plan 4 x 4, walls all round', 'floorplan', plan(['1111', '1001', '1001', '1111']), true);
  add('floor plan 32 x 32 (the largest)', 'floorplan', { ...filled(32, 32, 1) }, true);
  add('floor plan 3 x 4', 'floorplan', filled(3, 4, 1), false);
  add('floor plan 33 x 4', 'floorplan', filled(33, 4, 1), false);
  add('floor plan with an empty outer cell (0)', 'floorplan', plan(['1111', '1001', '1001', '1101']), false);
  add('floor plan with a blank outer cell (255)', 'floorplan', plan(['11.1', '1001', '1001', '1111']), false);
  add('floor plan with blank interior and wall types 1..4', 'floorplan', plan(['1234', '4..1', '3..2', '2341']), true);
  add('floor plan with a cell of 5', 'floorplan', plan(['1111', '1501', '1001', '1111']), false);
  let agree = 0, skipped = 0;
  for (const c of cases) {
    const real = compiles(c.role, c.asset, c.tiles);
    if (!real) { skipped++; continue; }
    let problems;
    try { problems = M.validateMap(M.fromAsset(c.asset), c.role, { tileCount: c.tiles.tiles.length }); } catch (e) { problems = [e.message]; }
    const mine = problems.length === 0;
    const good = mine === real.ok && real.ok === c.expectOk;
    if (good) agree++;
    ok(`${c.name}: the compiler ${real.ok ? 'accepts' : 'refuses'} it, validateMap ${mine ? 'finds no problem' : 'finds ' + problems.length}`, good, real.ok ? '' : real.msg.slice(0, 90));
  }
  ok('every case agrees', skipped === 0 && agree === cases.length, `${agree} of ${cases.length}${skipped ? `, ${skipped} skipped (no runtime)` : ''}`);
}

// ── 9 ───────────────────────────────────────────────────────────────────────────────────────────────────────────
console.log('\n9. The object layer');
{
  const kinds = { coin: { colour: 14, props: ['value'] }, enemy: { colour: 10, sprite: 'bug', props: ['hp', 'speed'] }, start: { colour: 12, props: [] } };
  const base = () => M.newMap(32, 24, 'screen');
  ok('a map without objects has no `objects` key in its editing form and its stored form (exactly as before)', !('objects' in base()) && !('objects' in M.toAsset(base())) && !('objects' in M.cloneMap(base())));
  const a0 = { w: 2, h: 1, cells: [1, 2], objects: [{ kind: 'coin', x: 3, y: 4, props: { value: 5 }, note: 'keep' }, { kind: 'start', x: 0, y: 0 }], flag: 7 };
  const m0 = M.fromAsset(a0);
  ok('fromAsset reads objects and the round trip deep-equals the asset (unknown keys of the map and of an object kept)', deepEq(M.toAsset(m0), a0) && m0.objects.length === 2 && m0.extra.flag === 7);
  ok('an empty objects list round-trips as an empty list (the key stays)', deepEq(M.toAsset(M.fromAsset({ w: 1, h: 1, cells: [1], objects: [] })), { w: 1, h: 1, cells: [1], objects: [] }));
  const m0c = M.cloneMap(m0); m0c.objects[0].props.value = 99; m0c.objects.pop();
  ok('cloneMap copies the objects (editing the copy leaves the original)', m0.objects[0].props.value === 5 && m0.objects.length === 2);
  ok('fromAsset refuses unreadable objects with a plain message',
    throws(() => M.fromAsset({ w: 1, h: 1, cells: [0], objects: 3 }), /must be a list/) && throws(() => M.fromAsset({ w: 1, h: 1, cells: [0], objects: [{ kind: 'a', x: 1.5, y: 0 }] }), /whole-number/)
    && throws(() => M.fromAsset({ w: 1, h: 1, cells: [0], objects: [{ x: 1, y: 0 }] }), /kind/) && throws(() => M.fromAsset({ w: 1, h: 1, cells: [0], objects: [{ kind: 'a', x: 1, y: 0, props: [] }] }), /props/));
  // every example map: untouched by the object layer
  const dir = join(ROOT, 'arcade/examples');
  let maps = 0, equal = 0;
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.assets.json'))) {
    const j = JSON.parse(readFileSync(join(dir, f), 'utf8'));
    for (const a of Object.values(j.maps ?? {})) { maps++; try { if (deepEq(M.toAsset(M.fromAsset(a)), a) && !('objects' in M.fromAsset(a)) === !('objects' in a)) equal++; } catch { /* counted as unequal */ } }
  }
  ok('every example map still round-trips (deep equal) with the object layer in the model', maps > 0 && equal === maps, `${equal} of ${maps}`);

  // snap and clamp
  const sz = { w: 4, h: 3 };                                       // 32 x 24 pixels
  ok('snap floors to the grid: 8 gives the cell corner, 4 and 16 and 1 likewise', same([M.snap(13, 21, 8, sz), M.snap(13, 21, 4, sz), M.snap(13, 21, 16, sz), M.snap(13, 21, 1, sz)], [[8, 16], [12, 20], [0, 16], [13, 21]]));
  ok('snap clamps into the map (0..w*8-1, 0..h*8-1) and cuts fractions', same([M.snap(-5, 99, 8, sz), M.snap(31.9, 23.9, 1, sz), M.snap(100, 100, 16, sz)], [[0, 16], [31, 23], [16, 16]]));
  ok('snap takes a map as well and refuses a grid that is not 1, 4, 8 or 16 and a non-number', same(M.snap(9, 9, 8, base()), [8, 8]) && throws(() => M.snap(1, 1, 3, sz), /1, 4, 8, 16/) && throws(() => M.snap(NaN, 1, 8, sz)));
  ok('clampToMap: whole pixels inside the map', same([M.clampToMap(sz, -1, 40), M.clampToMap(sz, 5.7, 5.2), M.clampToMap(sz, 32, 24)], [[0, 23], [5, 5], [31, 23]]));
  ok('pixelSize is 8 pixels a cell', same(M.pixelSize(sz), { w: 32, h: 24 }));

  // add, move, delete, props
  const m = M.newMap(4, 3, 'screen');
  const i0 = M.addObject(m, 'coin', 10, 5, { value: 3 }), i1 = M.addObject(m, 'start', 99, 99), i2 = M.addObject(m, 'coin', 2, 5, { value: 0 });
  ok('addObject returns the index, clamps into the map, writes props only when given', same([i0, i1, i2], [0, 1, 2]) && same(m.objects[1], { kind: 'start', x: 31, y: 23 }) && same(m.objects[0], { kind: 'coin', x: 10, y: 5, props: { value: 3 } }));
  ok('addObject refuses a bad kind, a prop that is not a whole number or is out of range', throws(() => M.addObject(m, '', 1, 1)) && throws(() => M.addObject(m, 'coin', 1, 1, { value: 1.5 }), /whole number/) && throws(() => M.addObject(m, 'coin', 1, 1, { value: 40000 }), /-32768\.\.32767/) && m.objects.length === 3);
  ok('the stored form carries the objects', deepEq(M.toAsset(m).objects, m.objects) && M.toAsset(m).objects !== m.objects);
  ok('moveObject moves (clamped), returns false when nothing changes, refuses a missing index', M.moveObject(m, 0, 12, 6) && same([m.objects[0].x, m.objects[0].y], [12, 6]) && !M.moveObject(m, 0, 12, 6) && M.moveObject(m, 0, -9, 500) && same([m.objects[0].x, m.objects[0].y], [0, 23]) && throws(() => M.moveObject(m, 7, 0, 0), /no object/));
  ok('setObjectProp sets, returns false when unchanged (a missing prop reads as 0), refuses a non-integer', M.setObjectProp(m, 0, 'value', 9) && !M.setObjectProp(m, 0, 'value', 9) && m.objects[0].props.value === 9
    && M.setObjectProp(m, 1, 'value', 4) && same(m.objects[1].props, { value: 4 }) && !M.setObjectProp(m, 1, 'value', 4) && throws(() => M.setObjectProp(m, 0, 'value', 0.5)) && throws(() => M.setObjectProp(m, 0, 'value', 32768)));
  const x0 = M.addObject(m, 'enemy', 0, 0);
  ok('setObjectProp of 0 on a missing prop is no change (it reads as 0); a non-zero is written; back to 0 writes the explicit 0', !M.setObjectProp(m, x0, 'hp', 0) && !('props' in m.objects[x0]) && M.setObjectProp(m, x0, 'hp', 2) && M.setObjectProp(m, x0, 'hp', 0) && same(m.objects[x0].props, { hp: 0 }));
  const gone = M.deleteObject(m, x0);
  ok('deleteObject returns the object and removes it; later indices shift down', gone.kind === 'enemy' && m.objects.length === 3 && throws(() => M.deleteObject(m, 9)));
  ok('deleteObjects removes several (any order, duplicates ignored) and returns the count', M.deleteObjects(m, [2, 0, 0]) === 2 && m.objects.length === 1 && m.objects[0].kind === 'start' && M.deleteObjects(m, []) === 0);
  M.deleteObject(m, 0);
  ok('deleting the last object removes the `objects` key (the stored form is the old one again)', !('objects' in m) && !('objects' in M.toAsset(m)));

  // hit test
  const h = M.newMap(8, 4, 'screen');
  M.addObject(h, 'coin', 8, 8); M.addObject(h, 'enemy', 12, 8); M.addObject(h, 'start', 40, 8);
  ok('objectsAt: the 8 x 8 box of an object, topmost (latest) first', same(M.objectsAt(h, 8, 8), [0]) && same(M.objectsAt(h, 13, 9), [1, 0]) && same(M.objectsAt(h, 16, 8), [1]) && same(M.objectsAt(h, 20, 8), []) && same(M.objectsAt(h, 7, 8), []));
  ok('objectsAt: the kinds filter and a size function (a sprite 16 x 16)', same(M.objectsAt(h, 13, 9, ['coin']), [0]) && same(M.objectsAt(h, 13, 9, new Set(['enemy'])), [1]) && same(M.objectsAt(h, 50, 20, null, (k) => (k === 'start' ? { w: 16, h: 16 } : null)), [2]) && same(M.objectsAt(h, 50, 20), []));
  ok('objectCounts counts per kind', same([...M.objectCounts(h)], [['coin', 1], ['enemy', 1], ['start', 1]]) && M.objectCounts(base()).size === 0);

  // sorted view
  const sv = M.newMap(16, 4, 'screen');
  M.addObject(sv, 'coin', 40, 0); M.addObject(sv, 'enemy', 8, 0); M.addObject(sv, 'coin', 8, 16); M.addObject(sv, 'coin', 8, 0); M.addObject(sv, 'coin', 8, 0);
  const view = M.sortedView(sv, { kinds: ['enemy', 'coin'] });
  ok('sortedView: kinds in the given order, each kind by x, then y, then insertion; rank is the position in the kind', same(view.map((e) => [e.obj.kind, e.obj.x, e.obj.y, e.index, e.rank]), [['enemy', 8, 0, 1, 0], ['coin', 8, 0, 3, 0], ['coin', 8, 0, 4, 1], ['coin', 8, 16, 2, 2], ['coin', 40, 0, 0, 3]]));
  ok('sortedView without kinds: alphabetical; by "x" sorts the whole list by x, y; indices point at the real objects',
    same(M.sortedView(sv).map((e) => e.obj.kind), ['coin', 'coin', 'coin', 'coin', 'enemy']) && same(M.sortedView(sv, { by: 'x' }).map((e) => e.index), [1, 3, 4, 2, 0]) && M.sortedView(sv).every((e) => sv.objects[e.index] === e.obj) && same(M.sortedView(base()), []));
  const snapBefore = JSON.stringify(sv);
  M.sortedView(sv);
  ok('sortedView does not reorder the map\'s own list (insertion order is the identity)', JSON.stringify(sv) === snapBefore);

  // resize
  const r = M.newMap(8, 4, 'screen');
  M.addObject(r, 'coin', 60, 30, { value: 1 }); M.addObject(r, 'coin', 10, 10);
  ok('objectsOutside counts the objects a resize would move', M.objectsOutside(r, 4, 2) === 1 && M.objectsOutside(r, 8, 4) === 0 && M.objectsOutside(r, 7, 4) === 1 && M.objectsOutside(M.newMap(4, 4, 'screen'), 1, 1) === 0);
  M.resize(r, 4, 2);
  ok('resize smaller clamps objects into the new box (to the last cell column / row), never drops one, keeps props', r.objects.length === 2 && same([r.objects[0].x, r.objects[0].y], [24, 8]) && r.objects[0].props.value === 1 && same([r.objects[1].x, r.objects[1].y], [10, 10]) && M.objectProblems(r).length === 0);
  M.resize(r, 16, 8);
  ok('resize larger leaves the objects where they are', same([r.objects[0].x, r.objects[0].y], [24, 8]) && r.objects.length === 2);

  // checks against the kinds
  const chk = M.newMap(4, 3, 'screen');
  chk.objects = [{ kind: 'coin', x: 1, y: 1, props: { value: 2 } }, { kind: 'ghost', x: 2, y: 2 }, { kind: 'coin', x: 99, y: 1 }, { kind: 'coin', x: 1, y: 1, props: { hp: 1 } }, { kind: 'coin', x: 1, y: 1, props: { value: 1.5 } }];
  const pr = M.objectProblems(chk, kinds);
  ok('objectProblems: unknown kind, out of the map, undeclared prop, bad prop value (each with the object index); the good object has none',
    same(pr.map((p) => [p.kind, p.index]), [['unknown-kind', 1], ['range', 2], ['prop', 3], ['prop-value', 4]]) && pr.every((p) => typeof p.message === 'string' && p.message.length > 10));
  ok('objectProblems without kinds only checks the range; validateObjects gives the messages', same(M.objectProblems(chk).map((p) => p.kind), ['range']) && M.validateObjects(chk, kinds).length === 4 && M.validateObjects(base(), kinds).length === 0);

  // kind tables
  ok('a good kinds table has no problems (an empty one too)', M.kindProblems(kinds).length === 0 && M.kindProblems({}).length === 0 && M.kindProblems(kinds, { sprites: ['bug'] }).length === 0);
  const bad = (k, rx, opts) => M.validateKinds(k, opts).some((t) => rx.test(t));
  ok('kind names: lower case letter then letters / digits, at most 12', bad({ Coin: { colour: 1, props: [] } }, /lower-case/) && bad({ '1a': { colour: 1, props: [] } }, /lower-case/) && bad({ a_b: { colour: 1, props: [] } }, /lower-case/) && bad({ abcdefghijklm: { colour: 1, props: [] } }, /at most 12/) && !bad({ abcdefghijkl: { colour: 1, props: [] } }, /./));
  ok('colour 0..15, a sprite that exists, at most 8 props, at most 16 kinds', bad({ a: { colour: 16, props: [] } }, /0\.\.15/) && bad({ a: { colour: 1.5, props: [] } }, /0\.\.15/) && bad({ a: { colour: 1, sprite: 'nope', props: [] } }, /does not have/, { sprites: ['bug'] })
    && bad({ a: { colour: 1, props: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'] } }, /at most 8/) && bad(Object.fromEntries(Array.from({ length: 17 }, (_, i) => ['k' + i, { colour: 1, props: [] }])), /at most 16/) && !bad(Object.fromEntries(Array.from({ length: 16 }, (_, i) => ['k' + i, { colour: 1, props: [] }])), /./));
  ok('property names: same rule, no duplicates', bad({ a: { colour: 1, props: ['Hp'] } }, /property name/) && bad({ a: { colour: 1, props: ['hp', 'hp'] } }, /twice/));
  ok('generated names must not collide: kind "c" with prop "x" (cx twice); kinds "a" + prop "bx" and "ab" + prop "x" (abx); and no collision for a fine table', bad({ c: { colour: 1, props: ['x'] } }, /twice|clashes/) && bad({ a: { colour: 1, props: ['bx'] }, ab: { colour: 2, props: ['x'] } }, /also used by kind/));
  ok('kindArrayNames lists the generated arrays of a kind', same(M.kindArrayNames('coin', ['value']), ['coinx', 'coiny', 'coinvalue', 'ncoin', 'coinix']));

  // kind edits on a map
  const ke = M.newMap(8, 4, 'screen');
  M.addObject(ke, 'coin', 0, 0, { value: 2 }); M.addObject(ke, 'enemy', 8, 0, { hp: 1, speed: 2 }); M.addObject(ke, 'coin', 16, 0, { value: 3 });
  ok('renameKindIn renames on every object of the kind and counts them', M.renameKindIn(ke, 'coin', 'gem') === 2 && same(ke.objects.map((o) => o.kind), ['gem', 'enemy', 'gem']) && M.renameKindIn(ke, 'nope', 'x') === 0);
  ok('dropPropIn removes a property from the kind\'s objects (an emptied props goes too)', M.dropPropIn(ke, 'enemy', 'speed') === 1 && same(ke.objects[1].props, { hp: 1 }) && M.dropPropIn(ke, 'gem', 'value') === 2 && !('props' in ke.objects[0]) && M.dropPropIn(ke, 'gem', 'value') === 0);
  ok('deleteKindIn deletes the kind\'s objects (the key goes with the last)', M.deleteKindIn(ke, 'gem') === 2 && ke.objects.length === 1 && M.deleteKindIn(ke, 'enemy') === 1 && !('objects' in ke));
}


console.log(`\n${failed === 0 ? 'All' : 'Some'} checks done: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
