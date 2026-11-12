/**
 * tests/arcade-assetcheck.mjs — Leap Arcade Studio slice S2, section 3 of docs/ARCADE_STUDIO_S2_CONTRACT.md, in Node (no browser, no dependencies):
 * `scanRoles` (src/lang/arcade/arcade-scan.js) and `checkAssets` with its helpers (src/lang/arcade/arcade-assetcheck.js).
 *
 *   node tests/arcade-assetcheck.mjs
 *
 *   1  scanRoles: the example sources, hand-written sources (CONST in a clause, case, no VIEW3D), broken text
 *   2  helpers: tileAttr, isForeground, tileUsesBlack, effectiveTileset, mapRole, readCells
 *   3  every rule of the contract table, positive and negative, on hand-built projects
 *   4  the example projects: the warnings each really produces (listed) and each one recomputed from the raw JSON
 *   5  agreement with the compiler (tile 0, shapes, undefined tiles, unstorable ticks) when arcade/dist/ is published
 *   6  fuzz: random mutations of the assets (and of the roles, and of the source text) never throw
 */

"use strict";

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as P from '../src/arcade-project.js';
import { scanRoles } from '../src/lang/arcade/arcade-scan.js';
import { checkAssets, tileAttr, isForeground, tileUsesBlack, effectiveTileset, mapRole, readCells } from '../src/lang/arcade/arcade-assetcheck.js';
import { convertSfx, convertMusic } from '../src/lang/arcade/arcade-assets.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
let failed = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failed++;
}
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const clone = (v) => JSON.parse(JSON.stringify(v));

// ── builders ──
/** o: {bits: 'FF' | [8 values], ink, paper, bright, flags, fg} */
const tile = (o = {}) => ({
  rows: Array.from({ length: 8 }, (_, y) => ({ bits: Array.isArray(o.bits) ? o.bits[y] : (o.bits ?? '00'), ink: o.ink ?? 0, paper: o.paper ?? 7, bright: o.bright ?? 0 })),
  flags: o.flags ?? 0, ...(o.fg ? { fg: true } : {}),
});
const mkProject = (assets = {}) => ({ format: 1, name: 't', framerate: 30, files: { 'main.arc': '' }, assets: { sprites: {}, tilesets: {}, maps: {}, sfx: {}, music: {}, ...assets }, scenes: {} });
const roles = (o = {}) => ({ tileset: null, maps: {}, world: null, floorplans: [], view: null, ...o });
const grid = (w, h, f) => Array.from({ length: w * h }, (_, i) => f(i % w, Math.floor(i / w)));
const ids = (fs) => fs.map((f) => f.id);
const has = (fs, id, asset) => fs.some((f) => f.id === id && (asset === undefined || f.asset === asset));
const ringWalls = (w, h, inner = 0) => grid(w, h, (x, y) => (x === 0 || y === 0 || x === w - 1 || y === h - 1 ? 1 : inner));

// ═══ 1  scanRoles ═══════════════════════════════════════════════════════════════════════════════════════════════
const EX = ['bounce', 'shooter', 'platformer', 'vaults', 'blockfall', 'breakout'];
const examples = {};
for (const id of EX) {
  const arc = readFileSync(ROOT + `arcade/examples/${id}.arc`, 'utf8').replace(/\r\n?/g, '\n');
  const assets = existsSync(ROOT + `arcade/examples/${id}.assets.json`) ? JSON.parse(readFileSync(ROOT + `arcade/examples/${id}.assets.json`, 'utf8')) : {};
  const project = P.exampleProject(id, arc, assets);
  examples[id] = { arc, assets, project, text: P.buildSource(project).text };
}
// Leap Runner (four worlds loaded by WORLD ... OF): its own entry, not in EX (the per-example loops below have expectations per example)
{
  const arc = readFileSync(ROOT + 'arcade/examples/runner.arc', 'utf8').replace(/\r\n?/g, '\n');
  const assets = JSON.parse(readFileSync(ROOT + 'arcade/examples/runner.assets.json', 'utf8'));
  const project = P.exampleProject('runner', arc, assets);
  examples.runner = { arc, assets, project, text: P.buildSource(project).text };
}
{
  const r = (id) => scanRoles(examples[id].text);
  check('scanRoles shooter: a cell map "sky", tile set gfx, no world, no floor plan, no view', eq(r('shooter'), { tileset: 'gfx', maps: { sky: 'sky' }, world: null, worlds: [], floorplans: [], view: null }), JSON.stringify(r('shooter')));
  check('scanRoles platformer: world pf_world (MAP level, WINDOW level), tile set pf_tiles', eq(r('platformer'), { tileset: 'pf_tiles', maps: { level: 'pf_world' }, world: 'pf_world', worlds: ['pf_world'], floorplans: [], view: null }), JSON.stringify(r('platformer')));
  check('scanRoles vaults: floor plan vl_maze, cell maps vl_panel and vl_title (the NOVIEW title picture), view BRIGHT 1 (default) CEIL 0 FLOOR 1',
    eq(r('vaults'), { tileset: 'vl_tiles', maps: { panel: 'vl_panel', level: 'vl_maze', splash: 'vl_title' }, world: null, worlds: [], floorplans: ['vl_maze'], view: { bright: 1, ceil: 0, floor: 1 } }), JSON.stringify(r('vaults')));
  check('scanRoles blockfall / breakout: a tile set and nothing else; bounce: nothing', eq(r('blockfall'), { tileset: 'gfx', maps: {}, world: null, worlds: [], floorplans: [], view: null }) && eq(r('breakout'), { tileset: 'bricks', maps: {}, world: null, worlds: [], floorplans: [], view: null }) && eq(r('bounce'), { tileset: null, maps: {}, world: null, worlds: [], floorplans: [], view: null }));
  const src = [
    'CONST dark = 0', 'CONST lite = 5 + 1', 'TILESET t = "ts"', 'MAP m = "m1"', 'MAP Maze = "mz"', 'MAP other = "o"',
    'VIEW3D maze FLOOR lite CEIL dark BRIGHT 0 COLW 2', 'WINDOW OTHER',
  ].join('\n');
  check('scanRoles: names are case-insensitive, CONSTs and + fold, BRIGHT 0 is read, WINDOW and VIEW3D together are both reported',
    eq(scanRoles(src), { tileset: 'ts', maps: { m: 'm1', Maze: 'mz', other: 'o' }, world: 'o', worlds: ['o'], floorplans: ['mz'], view: { bright: 0, ceil: 0, floor: 6 } }), JSON.stringify(scanRoles(src)));
  const v2 = scanRoles('TILESET t = "ts"\nMAP m = "m1"\nVIEW3D m CEIL FLOOR2 FLOOR 9 BRIGHT 7\n');
  check('scanRoles: a clause that is not a constant 0..7 (or BRIGHT 0..1) is null for that field, the others keep their defaults', eq(v2.view, { bright: null, ceil: null, floor: null }) || (v2.view !== null && v2.view.bright === null && v2.view.floor === null), JSON.stringify(v2));
  check('scanRoles: WINDOW / VIEW3D naming an undeclared MAP give world null / no floor plan (the view is still read)', eq(scanRoles('WINDOW nowhere\nVIEW3D nowhere CEIL 3'), { tileset: null, maps: {}, world: null, worlds: [], floorplans: [], view: { bright: 1, ceil: 3, floor: 1 } }), JSON.stringify(scanRoles('WINDOW nowhere\nVIEW3D nowhere CEIL 3')));
  let threw = false, junk;
  try { junk = [scanRoles(''), scanRoles(undefined), scanRoles(null), scanRoles('TILESET'), scanRoles('\u0000"""((('), scanRoles('MAP = "x"\nWINDOW\nVIEW3D'), scanRoles(5)]; } catch { threw = true; }
  // maps a WORLD statement loads (banking contract section 4, batch 6): worlds with a WINDOW, floor plans with a VIEW3D, as the compiler's checker says
  const wsrc = 'MAP a = "wa"\nMAP b = "wb"\nMAP c = "wc"\nMAP d = "wd"\nWINDOW a\nPROC FRAME\n  IF 1 THEN\n    WORLD b\n  ENDIF\n  WORLD n OF c, A, d\nENDP\n';
  check('scanRoles: the maps WORLD and WORLD ... OF load are worlds of a WINDOW game (the WINDOW\'s first, each once, nested statements found)', eq(scanRoles(wsrc).worlds, ['wa', 'wb', 'wc', 'wd']) && scanRoles(wsrc).world === 'wa', JSON.stringify(scanRoles(wsrc)));
  const vsrc = 'MAP a = "pa"\nMAP b = "pb"\nVIEW3D a\nPROC FRAME\n  WORLD n OF a, b\nENDP\n';
  check('scanRoles: in a VIEW3D game they are floor plans, and no world', eq(scanRoles(vsrc).floorplans, ['pa', 'pb']) && eq(scanRoles(vsrc).worlds, []), JSON.stringify(scanRoles(vsrc)));
  check('scanRoles: without a WINDOW or VIEW3D a WORLD statement makes no world', eq(scanRoles('MAP a = "x"\nPROC FRAME\n  WORLD a\nENDP\n').worlds, []));
  const rr = r('runner');
  check('scanRoles runner: the four level maps are worlds (WINDOW level, WORLD lv OF level, level2, level3, level4)', eq(rr.worlds, ['pf_world', 'rn_world2', 'rn_world3', 'rn_world4']), JSON.stringify(rr.worlds));
  const rw = checkAssets(examples.runner.project, rr);
  check('runner: no map-shape error for its 128 x 16 level maps (they were checked as cell maps before), each world has its background-attr-mix warning, no error at all',
    !rw.some((w) => w.severity === 'error') && ['pf_world', 'rn_world2', 'rn_world3', 'rn_world4'].every((m) => mapRole(m, rr) === 'world' && rw.some((w) => w.id === 'background-attr-mix' && w.asset === m)), JSON.stringify(rw.map((w) => [w.id, w.asset])));
  check('mapRole: roles without `worlds` (the older shape) still give the WINDOW\'s map the world role', mapRole('o', { world: 'o' }) === 'world' && mapRole('p', { world: 'o' }) === 'cell');
  check('scanRoles never throws on empty / broken / non-string input and always has the five fields', !threw && junk.every((x) => ['tileset', 'maps', 'world', 'worlds', 'floorplans', 'view'].every((k) => k in x)));
}

// ═══ 2  helpers ═════════════════════════════════════════════════════════════════════════════════════════════════
{
  check('tileAttr: bright << 6 | paper << 3 | ink from row 0; defaults ink 0 paper 7 bright 0; bright may be a boolean', tileAttr(tile({ ink: 2, paper: 5, bright: 1 })) === 0x6A && tileAttr({ rows: [{ bits: '00' }] }) === 0x38 && tileAttr({ rows: [{ bits: '00', bright: true, ink: 1 }] }) === 0x79);
  const t = tile({ ink: 1, paper: 2 }); t.rows[3].ink = 7; t.rows[7].bright = 1;
  check('tileAttr looks at row 0 only', tileAttr(t) === ((2 << 3) | 1));
  check('tileAttr: malformed gives null, never throws', [null, undefined, 5, {}, { rows: [] }, { rows: [null] }, { rows: [{ ink: 9 }] }, { rows: [{ paper: 'x' }] }, { rows: [{ bright: 2 }] }].every((x) => tileAttr(x) === null));
  check('isForeground: solid flag (bit 0) or fg: true; hazard / pickup alone are not', isForeground(tile({ flags: 1 })) && isForeground(tile({ flags: 3 })) && isForeground(tile({ fg: true })) && !isForeground(tile({ flags: 2 })) && !isForeground(tile({ flags: 4 })) && !isForeground(tile()) && !isForeground(null) && !isForeground({ fg: 'yes' }));
  check('tileUsesBlack: paper 0 with a clear bit', tileUsesBlack(tile({ paper: 0, bits: '00', ink: 3 })) && tileUsesBlack(tile({ paper: 0, bits: 'FE', ink: 3 })));
  check('tileUsesBlack: paper 0 but every bit set is NOT black (only ink shows)', !tileUsesBlack(tile({ paper: 0, bits: 'FF', ink: 3 })));
  check('tileUsesBlack: ink 0 with a set bit; ink 0 and bitmap clear is not', tileUsesBlack(tile({ ink: 0, paper: 6, bits: '01' })) && !tileUsesBlack(tile({ ink: 0, paper: 6, bits: '00' })));
  check('tileUsesBlack: bits as numbers, a clear bit in a later row counts, ink = paper = 0 uses it', tileUsesBlack(tile({ paper: 0, ink: 2, bits: ['FF', 'FF', 'FF', 'FF', 'FF', 'FF', 'FF', 'FD'] })) && tileUsesBlack(tile({ paper: 0, ink: 0, bits: 'FF' })));
  check('tileUsesBlack: malformed is false', !tileUsesBlack(null) && !tileUsesBlack({ rows: [] }) && !tileUsesBlack({ rows: Array(8).fill({ bits: 'ZZ', ink: 0, paper: 0 }) }));
  const proj = mkProject({ tilesets: { a: { tiles: [tile()] }, B: { tiles: [tile()] } } });
  check('effectiveTileset: the map\'s own existing tile set wins', effectiveTileset(proj, { tileset: 'B' }, roles({ tileset: 'a' })) === 'B');
  check('effectiveTileset: case-insensitive, returns the project\'s spelling', effectiveTileset(proj, { tileset: 'b' }, null) === 'B');
  check('effectiveTileset: a map tile set that does not exist falls to roles.tileset', effectiveTileset(proj, { tileset: 'ghost' }, roles({ tileset: 'a' })) === 'a');
  check('effectiveTileset: roles.tileset that does not exist falls to the only tile set, else null',
    effectiveTileset(mkProject({ tilesets: { only: { tiles: [tile()] } } }), {}, roles({ tileset: 'ghost' })) === 'only' && effectiveTileset(proj, {}, roles({ tileset: 'ghost' })) === null && effectiveTileset(proj, null, null) === null && effectiveTileset(mkProject(), null, null) === null);
  const R = roles({ world: 'W', floorplans: ['fp'] });
  check('mapRole: world, floorplan (case-insensitive), cell; roles null and junk give cell', mapRole('W', R) === 'world' && mapRole('w', R) === 'world' && mapRole('FP', R) === 'floorplan' && mapRole('x', R) === 'cell' && mapRole('W', null) === 'cell' && mapRole(5, R) === 'cell' && mapRole('W', { world: 5, floorplans: 'W' }) === 'cell');
  const a = readCells({ w: 3, h: 1, cells: [0, 255, null] }), b = readCells({ w: 3, h: 1, cells: '00FF0A' }), c = readCells({ w: 2, h: 1, cells: [-1, 1.5] });
  check('readCells: array and hex string agree, blank is -1, garbage is NaN', eq(a.cells, [0, -1, -1]) && eq(b.cells, [0, -1, 10]) && c.cells[0] === -1 && Number.isNaN(c.cells[1]));
  check('readCells: wrong length, bad hex, no cells, non-object give null cells with a reason (no throw)', [[{ w: 2, h: 2, cells: [0] }], [{ w: 1, h: 1, cells: 'G0' }], [{ w: 1, h: 1 }], [null], [{ w: 0, h: 1, cells: [] }], [{ w: 'a', h: 1, cells: [] }]].every(([m]) => { const r = readCells(m); return r.cells === null && typeof r.problem === 'string'; }));
}

// ═══ 3  the rules ═══════════════════════════════════════════════════════════════════════════════════════════════
const blackA = (bright, extra = {}) => tile({ paper: 0, bits: '00', ink: 7, bright, ...extra });      // a tile that uses black
const plain = (extra = {}) => tile({ paper: 6, ink: 1, bits: 'AA', ...extra });                        // no black anywhere
{
  // black-bright-mix
  const mix = (tiles, rl = null) => checkAssets(mkProject({ tilesets: { ts: { tiles } } }), rl);
  let f = mix([blackA(0), blackA(1), plain()]);
  check('black-bright-mix: one BRIGHT 0 and one BRIGHT 1 black tile warn (warning, not compilerAlso, kind tilesets)', f.length === 1 && f[0].id === 'black-bright-mix' && f[0].severity === 'warning' && f[0].asset === 'ts' && f[0].kind === 'tilesets' && f[0].compilerAlso === false && eq(f[0].bright0, [0]) && eq(f[0].bright1, [1]), JSON.stringify(f.map((x) => x.id)));
  check('black-bright-mix: the text says why (TSRun dark grey, Fuse and ZEsarUX black)', /dark grey/.test(f[0].message) && /Fuse/.test(f[0].message) && /ZEsarUX/.test(f[0].message));
  check('black-bright-mix: all black tiles BRIGHT 0 (or all BRIGHT 1) is quiet', mix([blackA(0), blackA(0), plain()]).length === 0 && mix([blackA(1), blackA(1)]).length === 0);
  check('black-bright-mix: black only by a full-ink paper-0 tile (no clear bit) is not black', mix([tile({ paper: 0, bits: 'FF', ink: 5, bright: 1 }), blackA(0)]).length === 0);
  check('black-bright-mix: ink 0 with set bits counts as black; ink 0 with blank bitmap does not',
    has(mix([tile({ ink: 0, paper: 6, bits: '18', bright: 1 }), blackA(0)]), 'black-bright-mix') && mix([tile({ ink: 0, paper: 6, bits: '00', bright: 1 }), blackA(0)]).length === 0);
  f = mix(Array.from({ length: 20 }, (_, i) => blackA(i < 10 ? 0 : 1)));
  check('black-bright-mix: names at most 6 tiles of each kind in the text, all of them in the details', f.length === 1 && /tiles 0, 1, 2, 3, 4, 5 and 4 more/.test(f[0].message) && f[0].bright0.length === 10 && f[0].bright1.length === 10, f[0]?.message.slice(0, 160));
  const withView = (tiles, view, tileset = 'ts') => checkAssets(mkProject({ tilesets: { ts: { tiles } } }), roles({ tileset, view }));
  check('black-bright-mix + VIEW3D: CEIL 0 with BRIGHT 1 counts as a BRIGHT 1 black, so a BRIGHT 0 black tile makes the mix', has(withView([blackA(0), plain()], { bright: 1, ceil: 0, floor: 1 }), 'black-bright-mix') && withView([blackA(0), plain()], { bright: 1, ceil: 0, floor: 1 })[0].view === true);
  check('black-bright-mix + VIEW3D: FLOOR 0 with BRIGHT 0 counts as a BRIGHT 0 black', has(withView([blackA(1)], { bright: 0, ceil: 3, floor: 0 }), 'black-bright-mix'));
  check('black-bright-mix + VIEW3D: the same brightness is quiet; neither CEIL nor FLOOR 0 is quiet; null fields are quiet',
    withView([blackA(1)], { bright: 1, ceil: 0, floor: 1 }).length === 0 && withView([blackA(0)], { bright: 1, ceil: 2, floor: 1 }).length === 0 && withView([blackA(0)], { bright: null, ceil: 0, floor: 1 }).length === 0 && withView([blackA(0)], { bright: 1, ceil: null, floor: null }).length === 0);
  check('black-bright-mix + VIEW3D: only the program\'s tile set takes the view into account', mix([blackA(0), plain()], roles({ tileset: 'other', view: { bright: 1, ceil: 0, floor: 1 } })).length === 0);

  // background-attr-mix
  const bg1 = plain({ ink: 1, paper: 6 }), bg2 = plain({ ink: 2, paper: 6 }), solid = plain({ ink: 3, paper: 6, flags: 1 });
  const cm = (tiles, cells, w = (Array.isArray(cells) ? cells.length : cells.length / 2), h = 1, extra = {}, rl) => checkAssets(mkProject({ tilesets: { ts: { tiles } }, maps: { m: { w, h, cells, ...extra } } }), rl === undefined ? roles({ tileset: 'ts', maps: { m: 'm' } }) : rl);
  f = cm([bg1, bg2], [0, 1, 1, 0]);
  check('background-attr-mix: a cell map with two background attributes warns (each attribute, its tiles, its cell count)', f.length === 1 && f[0].id === 'background-attr-mix' && f[0].kind === 'maps' && f[0].asset === 'm' && f[0].severity === 'warning' && f[0].groups.length === 2 &&
    eq(f[0].groups.map((g) => [g.ink, g.paper, g.bright, g.tiles, g.cells]), [[1, 6, 0, [0], 2], [2, 6, 0, [1], 2]]) && /ink 1, paper 6, BRIGHT 0/.test(f[0].message) && /sprites never pass over/.test(f[0].message), JSON.stringify(f.map((x) => x.id)));
  check('background-attr-mix: the same attribute in both tiles is quiet', cm([bg1, plain({ ink: 1, paper: 6, bits: '55' })], [0, 1, 1, 0]).length === 0);
  check('background-attr-mix: attribute is row 0 only (a different later row does not matter)', (() => { const t = plain({ ink: 1, paper: 6, bits: '55' }); t.rows[5].ink = 4; return cm([bg1, t], [0, 1, 0, 1]).length === 0; })());
  check('background-attr-mix: a solid tile (flags bit 0) is foreground, so ignored', cm([bg1, solid], [0, 1, 0, 1]).length === 0);
  check('background-attr-mix: fg: true is foreground, ignored; a hazard-only tile is background', cm([bg1, plain({ ink: 2, paper: 6, fg: true })], [0, 1]).length === 0 && has(cm([bg1, plain({ ink: 2, paper: 6, flags: 2 })], [0, 1]), 'background-attr-mix'));
  check('background-attr-mix: a tile the map does not use is ignored', cm([bg1, bg2], [0, 0, 0, 0]).length === 0);
  check('background-attr-mix: the BRIGHT bit and paper both make a different attribute', has(cm([bg1, plain({ ink: 1, paper: 6, bright: 1 })], [0, 1]), 'background-attr-mix') && has(cm([bg1, plain({ ink: 1, paper: 5 })], [0, 1]), 'background-attr-mix'));
  check('background-attr-mix: cell map blank cells are ignored (blank is not tile 0), also null and -1 and 255 in an array', cm([bg1, bg2], [1, 255, null, -1]).length === 0);
  const wmap = (cells, tiles, w = 24, h = 1) => checkAssets(mkProject({ tilesets: { ts: { tiles } }, maps: { w: { w, h, cells } } }), roles({ tileset: 'ts', maps: { w: 'w' }, world: 'w' }));
  check('background-attr-mix: in a WORLD map a blank cell is tile 0 (so tile 0 and tile 1 mix) ...', has(wmap(grid(24, 1, (x) => (x === 0 ? 1 : 255)), [bg1, bg2]), 'background-attr-mix', 'w'));
  check('... while the same cells in a cell map would not (blank ignored)', cm([bg1, bg2], [1, 255, 255, 255]).length === 0);
  check('background-attr-mix: a floor plan is not checked (tile attributes mean nothing there)', checkAssets(mkProject({ tilesets: { ts: { tiles: [bg1, bg2] } }, maps: { f: { w: 4, h: 4, cells: ringWalls(4, 4, 0) } } }), roles({ tileset: 'ts', maps: { f: 'f' }, floorplans: ['f'] })).length === 0);
  check('background-attr-mix: a hex-string map gives the same answer as an array', eq(ids(cm([bg1, bg2], '00010100')), ids(cm([bg1, bg2], [0, 1, 1, 0]))) && has(cm([bg1, bg2], '00010100'), 'background-attr-mix'));
  check('background-attr-mix: `cells` of the finding are the minority cells', eq(cm([bg1, bg2], [0, 0, 0, 1])[0].cells, [3]) && cm([bg1, bg2], [0, 0, 0, 1])[0].majorityAttr === tileAttr(bg1));
  check('background-attr-mix: three attributes list three groups', cm([bg1, bg2, plain({ ink: 4, paper: 6 })], [0, 1, 2, 2])[0].groups.length === 3);
  check('background-attr-mix: uses the map\'s own tileset when it exists', checkAssets(mkProject({ tilesets: { a: { tiles: [bg1, bg1] }, b: { tiles: [bg1, bg2] } }, maps: { m: { w: 2, h: 1, cells: [0, 1], tileset: 'b' } } }), roles({ tileset: 'a', maps: { m: 'm' } })).some((x) => x.id === 'background-attr-mix'));
  check('with roles null every map check is skipped, never guessed (tile-set checks still run)', cm([bg1, bg2], [0, 1], 2, 1, {}, null).length === 0 && has(checkAssets(mkProject({ tilesets: { ts: { tiles: [blackA(0), blackA(1)] } }, maps: { m: { w: 1, h: 1, cells: [99] } } }), null), 'black-bright-mix') && !has(checkAssets(mkProject({ tilesets: { ts: { tiles: [plain()] } }, maps: { m: { w: 1, h: 1, cells: [99] } } }), null), 'map-undefined-tile'));

  // tile0-not-blank
  const t0 = (tiles, rl, extraMaps = {}) => checkAssets(mkProject({ tilesets: { ts: { tiles } }, maps: { w: { w: 24, h: 1, cells: grid(24, 1, () => 0) }, ...extraMaps } }), rl);
  const R0 = roles({ tileset: 'ts', maps: { w: 'w' }, world: 'w' });
  f = t0([plain({ bits: '10' }), plain()], R0);
  check('tile0-not-blank: a set pixel in tile 0 warns (warning, tile 0, compilerAlso)', f.length === 1 && f[0].id === 'tile0-not-blank' && f[0].tile === 0 && f[0].compilerAlso === true && f[0].asset === 'ts' && f[0].severity === 'warning' && /tile 0 of the tile set "ts" is not blank/.test(f[0].message), JSON.stringify(ids(f)));
  check('tile0-not-blank: a blank tile 0 is quiet, whatever its colours (bits as numbers too)', t0([plain({ bits: '00', ink: 4 }), plain()], R0).length === 0 && t0([plain({ bits: [0, 0, 0, 0, 0, 0, 0, 0] })], R0).length === 0);
  check('tile0-not-blank: a pixel in the last row counts; tile 1 does not matter', has(t0([plain({ bits: [0, 0, 0, 0, 0, 0, 0, 1] })], R0), 'tile0-not-blank') && t0([plain({ bits: '00' }), plain({ bits: 'FF' })], R0).length === 0);
  check('tile0-not-blank: without a WINDOW (no world) it is not checked', t0([plain({ bits: 'FF' }), plain()], roles({ tileset: 'ts' })).length === 0);
  check('tile0-not-blank: checks the tile set the world is drawn with (the map\'s own `tileset`)', checkAssets(mkProject({ tilesets: { ts: { tiles: [plain()] }, own: { tiles: [plain({ bits: '80' })] } }, maps: { w: { w: 24, h: 1, cells: grid(24, 1, () => 0), tileset: 'own' } } }), R0).some((x) => x.id === 'tile0-not-blank' && x.asset === 'own'));

  // world-shape
  const ws = (w, h, cells, tiles = Array(40).fill(0).map(() => plain())) => checkAssets(mkProject({ tilesets: { ts: { tiles } }, maps: { w: { w, h, cells } } }), R0).filter((x) => x.id === 'world-shape');
  check('world-shape: 24 x 1 and 128 x 16 (the limits) are fine, with tile 31 and blank', ws(24, 1, grid(24, 1, () => 31)).length === 0 && ws(128, 16, grid(128, 16, (x) => (x % 2 ? 255 : 0))).length === 0 && ws(24, 1, grid(24, 1, (x) => (x === 3 ? null : -1))).length === 0);
  f = ws(23, 16, grid(23, 16, () => 0));
  check('world-shape: width 23 is an error (error, compilerAlso)', f.length === 1 && f[0].severity === 'error' && f[0].compilerAlso === true && /width must be 24\.\.128/.test(f[0].message), f[0]?.message);
  check('world-shape: width 129, height 17, height 0 are errors', ws(129, 1, grid(129, 1, () => 0)).length === 1 && ws(24, 17, grid(24, 17, () => 0)).length === 1 && ws(24, 0, []).length === 1);
  f = ws(24, 1, grid(24, 1, (x) => (x === 5 ? 32 : 0)));
  check('world-shape: tile 32 is an error naming the cell', f.length === 1 && eq(f[0].cells, [5]) && /row 0, column 5/.test(f[0].message), f[0]?.message);
  check('world-shape: a non-number cell and a hex string with tile 0x20 are errors', ws(24, 1, grid(24, 1, (x) => (x === 2 ? 'a' : 0))).length === 1 && ws(24, 1, '00'.repeat(23) + '20').length === 1 && ws(24, 1, '00'.repeat(23) + 'FF').length === 0);
  check('world-shape: cells of the wrong count / bad hex are errors with a message', ws(24, 1, [0, 1]).length === 1 && ws(24, 1, 'zz').length === 1 && ws(24, 1, undefined).length === 1);
  check('world-shape: a cell map of the same size is not held to the world rules', checkAssets(mkProject({ tilesets: { ts: { tiles: Array(60).fill(0).map(() => plain()) } }, maps: { c: { w: 5, h: 5, cells: grid(5, 5, () => 50) } } }), roles({ tileset: 'ts', maps: { c: 'c' } })).filter((x) => x.id === 'world-shape').length === 0);

  // floorplan-shape
  const RF = roles({ tileset: 'ts', maps: { f: 'f' }, floorplans: ['f'] });
  const fp = (w, h, cells) => checkAssets(mkProject({ tilesets: { ts: { tiles: [plain()] } }, maps: { f: { w, h, cells } } }), RF).filter((x) => x.id === 'floorplan-shape');
  check('floorplan-shape: 4 x 4 and 32 x 32 with a wall ring and codes 0..4 are fine', fp(4, 4, ringWalls(4, 4)).length === 0 && fp(32, 32, ringWalls(32, 32, 4)).length === 0 && fp(5, 4, ringWalls(5, 4)).length === 0);
  check('floorplan-shape: 3 x 4, 4 x 3, 33 x 4 are errors', fp(3, 4, ringWalls(3, 4)).length >= 1 && fp(4, 3, ringWalls(4, 3)).length >= 1 && fp(33, 4, ringWalls(33, 4)).length >= 1 && fp(3, 4, ringWalls(3, 4)).every((x) => x.severity === 'error' && x.compilerAlso));
  f = fp(5, 5, ringWalls(5, 5, 2).map((v, i) => (i === 12 ? 5 : v)));
  check('floorplan-shape: wall code 5 is an error naming the cell', f.length === 1 && eq(f[0].cells, [12]) && /row 2, column 2/.test(f[0].message), f[0]?.message);
  f = fp(5, 5, ringWalls(5, 5, 1).map((v, i) => (i === 2 ? 0 : v)));
  check('floorplan-shape: an empty cell on the top row (outer ring) is an error', f.length === 1 && eq(f[0].cells, [2]) && /outer ring/.test(f[0].message), f[0]?.message);
  check('floorplan-shape: ring cells that are blank (255, null, -1) are empty; one in each of the four sides is found', (() => {
    const c = ringWalls(6, 6, 1); c[1] = 255; c[6 * 5 + 2] = null; c[6 * 2] = -1; c[6 * 3 + 5] = 0;
    const r = fp(6, 6, c); return r.length === 1 && eq(r[0].cells, [1, 12, 23, 32]);
  })());
  check('floorplan-shape: an empty interior cell is fine; code 4 is fine; blank interior is fine', fp(5, 5, ringWalls(5, 5, 255)).length === 0 && fp(5, 5, ringWalls(5, 5, 4)).length === 0);
  check('floorplan-shape: the same plan as a hex string (empty ring cell) is found', (() => { const c = ringWalls(5, 5, 0); c[0] = 0; return fp(5, 5, c.map((v) => v.toString(16).padStart(2, '0')).join('')).length === 1; })());
  check('floorplan-shape: a floor plan\'s tile numbers are not checked against the tile set (codes 0..4)', !has(checkAssets(mkProject({ tilesets: { ts: { tiles: [plain()] } }, maps: { f: { w: 4, h: 4, cells: ringWalls(4, 4, 3) } } }), RF), 'map-undefined-tile'));

  // map-tileset-mismatch
  const mt = (own, rl, role = 'cell') => checkAssets(mkProject({ tilesets: { a: { tiles: [plain()] }, b: { tiles: [plain()] } }, maps: { m: { w: 2, h: 1, cells: [0, 0], ...(own === undefined ? {} : { tileset: own }) } } }), rl).filter((x) => x.id === 'map-tileset-mismatch');
  f = mt('b', roles({ tileset: 'a', maps: { m: 'm' } }));
  check('map-tileset-mismatch: a map drawn with b while the program uses a warns (warning, not compilerAlso)', f.length === 1 && f[0].severity === 'warning' && f[0].compilerAlso === false && /"b"/.test(f[0].message) && /"a"/.test(f[0].message));
  check('map-tileset-mismatch: same name (any case), no own tileset, no program tile set: quiet', mt('A', roles({ tileset: 'a', maps: { m: 'm' } })).length === 0 && mt(undefined, roles({ tileset: 'a', maps: { m: 'm' } })).length === 0 && mt('b', roles({ tileset: null, maps: { m: 'm' } })).length === 0);
  check('map-tileset-mismatch: applies to a world map too, not to a floor plan', mt('b', roles({ tileset: 'a', world: 'm', maps: { m: 'm' } })).length === 1 && mt('b', roles({ tileset: 'a', floorplans: ['m'], maps: { m: 'm' } })).length === 0);

  // map-undefined-tile
  const ut = (cells, nt, rl, w = 4) => checkAssets(mkProject({ tilesets: { ts: { tiles: Array(nt).fill(0).map(() => plain()) } }, maps: { m: { w, h: cells.length / w, cells } } }), rl ?? roles({ tileset: 'ts', maps: { m: 'm' } })).filter((x) => x.id === 'map-undefined-tile');
  f = ut([0, 1, 5, 6], 3);
  check('map-undefined-tile: tiles 5 and 6 in a 3-tile set are an error (cells listed, tiles listed, compilerAlso)', f.length === 1 && f[0].severity === 'error' && f[0].compilerAlso === true && eq(f[0].cells, [2, 3]) && eq(f[0].tiles, [5, 6]) && /"ts"/.test(f[0].message), JSON.stringify(f));
  check('map-undefined-tile: index = tile count is the first undefined one; count - 1 is fine; blank is not a tile', ut([0, 1, 2, 3], 3).length === 1 && ut([0, 1, 2, 255], 3).length === 0 && ut([0, null, -1, 2], 3).length === 0);
  check('map-undefined-tile: also on a WORLD map (the red cross), 20..31 are valid for the world but not defined', ut(grid(24, 1, (x) => (x === 1 ? 25 : 0)), 20, roles({ tileset: 'ts', maps: { m: 'm' }, world: 'm' }), 24).length === 1);
  check('map-undefined-tile: a map the source does not declare is shown but not compilerAlso', ut([9, 0, 0, 0], 3, roles({ tileset: 'ts', maps: {} }))[0]?.compilerAlso === false);
  check('map-undefined-tile: no tile set to compare with (none, or two and no roles.tileset) is quiet', ut([9, 9], 3, roles({ tileset: 'ghost' }), 2).length === 1 &&
    checkAssets(mkProject({ tilesets: { a: { tiles: [plain()] }, b: { tiles: [plain()] } }, maps: { m: { w: 1, h: 1, cells: [9] } } }), roles({ maps: { m: 'm' } })).length === 0 && checkAssets(mkProject({ maps: { m: { w: 1, h: 1, cells: [9] } } }), roles({ maps: { m: 'm' } })).length === 0);
  check('map-shape (extra id): a cell map wider than 32 or taller than 24 is an error', has(checkAssets(mkProject({ tilesets: { ts: { tiles: [plain()] } }, maps: { m: { w: 33, h: 1, cells: grid(33, 1, () => 0) } } }), roles({ tileset: 'ts', maps: { m: 'm' } })), 'map-shape') && has(checkAssets(mkProject({ tilesets: { ts: { tiles: [plain()] } }, maps: { m: { w: 1, h: 25, cells: grid(1, 25, () => 0) } } }), roles({ tileset: 'ts', maps: { m: 'm' } })), 'map-shape'));

  // sfx-unstorable
  const sx = (ticks) => checkAssets(mkProject({ sfx: { s: { ticks } } }), null).filter((x) => x.id === 'sfx-unstorable');
  f = sx([{ tone: 100, vol: 15, noise: 0, mix: 6 }, { tone: 3840, vol: 15, noise: 0, mix: 6 }, { tone: 4095, vol: 15, noise: 0, mix: 6 }]);
  check('sfx-unstorable: tone 3840 and 4095 with vol 15 are an error (ticks listed, compilerAlso)', f.length === 1 && f[0].severity === 'error' && f[0].compilerAlso === true && f[0].kind === 'sfx' && f[0].asset === 's' && eq(f[0].ticks, [1, 2]), JSON.stringify(f));
  check('sfx-unstorable: tone 3839 with vol 15, tone 4095 with vol 14, vol 0, missing vol are fine', sx([{ tone: 3839, vol: 15 }, { tone: 4095, vol: 14 }, { tone: 4095, vol: 0 }, { tone: 4095 }]).length === 0);
  check('sfx-unstorable agrees with convertSfx over every tone / vol boundary', (() => {
    for (const tone of [0, 1, 255, 256, 3583, 3839, 3840, 3841, 4094, 4095]) for (const vol of [0, 1, 14, 15]) {
      const mine = sx([{ tone, vol, noise: 0, mix: 6 }]).length === 1;
      let theirs = false; try { convertSfx({ ticks: [{ tone, vol, noise: 0, mix: 6 }] }); } catch { theirs = true; }
      if (mine !== theirs) return false;
    }
    return true;
  })());

  // songs (docs/ARCADE_MUSIC_CONTRACT.md section 7): music-unstorable per pattern and channel, music-shape, music-unused-pattern; agrees with convertMusic
  {
    const T = (tone, vol = 10) => ({ tone, vol, noise: 0, mix: 6 });
    const ms = (song) => checkAssets(mkProject({ music: { m: song } }), null);
    let g = ms({ patterns: [{ ticks: [T(100), T(3840, 15)], ticksB: [T(4095, 15)] }, { ticks: [T(1)] }], order: [0, 1], loop: 0 });
    check('music-unstorable: one finding per pattern and channel, with pattern / channel / ticks, an error the compiler also gives',
      g.length === 2 && g.every((x) => x.id === 'music-unstorable' && x.kind === 'music' && x.asset === 'm' && x.severity === 'error' && x.compilerAlso === true && x.pattern === 0)
      && g[0].channel === 'A' && eq(g[0].ticks, [1]) && g[1].channel === 'B' && eq(g[1].ticks, [0]) && /pattern 0 channel A tick 1 has a tone of 3840/.test(g[0].message), JSON.stringify(g));
    g = ms({ patterns: [{ ticks: [T(1)] }, { ticks: [T(2)] }], order: [0, 0], loop: null });
    check('music-unused-pattern: a warning of the Studio only (pattern 1 never played)', g.length === 1 && g[0].id === 'music-unused-pattern' && g[0].severity === 'warning' && g[0].compilerAlso === false && g[0].pattern === 1);
    g = ms({ patterns: [{ ticks: [T(1)] }], order: [0, 3], loop: 5 });
    check('music-shape: an order entry naming no pattern and a loop outside the list', g.filter((x) => x.id === 'music-shape').length === 2 && /order position 1 names no pattern/.test(g[0].message) && /the loop 5/.test(g[1].message), JSON.stringify(g));
    check('music-shape: an empty order list; asset-malformed: no patterns', ms({ patterns: [{ ticks: [T(1)] }], order: [] }).some((x) => x.id === 'music-shape' && /empty order list/.test(x.message)) && ms({ order: [0] })[0]?.id === 'asset-malformed');
    check('songs: an error finding exactly when convertMusic refuses (records over the tone / vol boundary, orders, loops)', (() => {
      for (const tone of [0, 3839, 3840, 4095]) for (const vol of [14, 15]) for (const order of [[0], [1], []]) for (const loop of [null, 0, 1]) {
        const song = { patterns: [{ ticks: [T(tone, vol)] }], order, loop };
        const mine = ms(song).some((x) => x.severity === 'error');
        let theirs = false; try { convertMusic(song); } catch { theirs = true; }
        if (mine !== theirs) return false;
      }
      return true;
    })());
  }

  // sfx-unstorable on channels B and C (language batch 5): one finding per channel, the message names it, `ticks` are that channel's
  const sx3 = (extra) => checkAssets(mkProject({ sfx: { s: { ticks: [{ tone: 100, vol: 15, noise: 0, mix: 6 }], ...extra } } }), null).filter((x) => x.id === 'sfx-unstorable');
  const BAD = { tone: 3900, vol: 15, noise: 0, mix: 6 }, OK = { tone: 100, vol: 10, noise: 0, mix: 6 };
  f = sx3({ ticksB: [OK, OK, OK, OK, BAD] });
  check('sfx-unstorable: a bad tick in channel B is an error naming channel B (ticks = [4], channel "B", compilerAlso)', f.length === 1 && f[0].channel === 'B' && eq(f[0].ticks, [4]) && f[0].severity === 'error' && f[0].compilerAlso === true && /channel B tick 4 has a tone of 3840\.\.4095 with volume 15/.test(f[0].message), JSON.stringify(f));
  f = sx3({ ticksB: [BAD, OK, BAD], ticksC: [OK, BAD] });
  check('sfx-unstorable: bad ticks in B and C give one finding each, with their own tick lists and messages', f.length === 2 && f[0].channel === 'B' && eq(f[0].ticks, [0, 2]) && /channel B ticks 0, 2 have/.test(f[0].message) && f[1].channel === 'C' && eq(f[1].ticks, [1]) && /channel C tick 1 has/.test(f[1].message), JSON.stringify(f));
  f = [{ tone: 3840, vol: 15 }, { tone: 4095, vol: 15 }];
  const fa = checkAssets(mkProject({ sfx: { s: { ticks: [OK, ...f], ticksB: [BAD] } } }), null).filter((x) => x.id === 'sfx-unstorable');
  check('sfx-unstorable: channel A of a multi-channel effect is named too ("channel A ticks 1, 2"); `channel` is absent on a one-channel effect',
    fa.length === 2 && fa[0].channel === 'A' && eq(fa[0].ticks, [1, 2]) && /channel A ticks 1, 2 have/.test(fa[0].message) && fa[1].channel === 'B'
    && !('channel' in sx([{ tone: 3840, vol: 15 }])[0]) && !/channel/.test(sx([{ tone: 3840, vol: 15 }])[0].message));
  check('sfx-unstorable: B and C with ticks that are fine, empty, null or absent: no finding', sx3({ ticksB: [OK], ticksC: [] }).length === 0 && sx3({ ticksB: null, ticksC: null }).length === 0 && sx3({ ticksB: [], ticksC: [] }).length === 0);
  const mal = checkAssets(mkProject({ sfx: { s: { ticks: [OK], ticksB: 'x', ticksC: [BAD] } } }), null);
  check('a ticksB that is not an array: asset-malformed naming channel B; channel C is still checked', mal.some((x) => x.id === 'asset-malformed' && x.channel === 'B' && /ticksB/.test(x.message)) && mal.some((x) => x.id === 'sfx-unstorable' && x.channel === 'C'), JSON.stringify(mal));
  check('sfx-unstorable agrees with convertSfx for channels B and C over every tone / vol boundary', (() => {
    for (const ch of ['ticksB', 'ticksC']) for (const tone of [0, 255, 3583, 3839, 3840, 4094, 4095]) for (const vol of [0, 14, 15]) {
      const t = { tone, vol, noise: 0, mix: 6 };
      const mine = sx3({ [ch]: [t] }).length === 1;
      let theirs = false; try { convertSfx({ ticks: [OK], [ch]: [t] }); } catch { theirs = true; }
      if (mine !== theirs) return false;
    }
    return true;
  })());
  check('the unstorable tick of channel B is also marked unstorable by the compiler path (convertSfx message names channel B)', (() => { try { convertSfx({ ticks: [OK], ticksB: [OK, BAD] }); return false; } catch (e) { return /^channel B tick 1: tone 3900 with volume 15/.test(e.message); } })());

  // tileset-size
  const sz = (n, rl) => checkAssets(mkProject({ tilesets: { ts: { tiles: Array(n).fill(0).map(() => plain()) } }, maps: { w: { w: 24, h: 1, cells: grid(24, 1, () => 0) } } }), rl).filter((x) => x.id === 'tileset-size');
  check('tileset-size: 33 tiles with a WINDOW is a warning (tiles above 31 cannot be used in the world)', (() => { const r = sz(33, R0); return r.length === 1 && r[0].severity === 'warning' && r[0].count === 33 && /32\.\.32|tiles 32/.test(r[0].message) && r[0].compilerAlso === false; })());
  check('tileset-size: 32 tiles with a WINDOW is fine; 33 without a WINDOW is fine; 128 is fine', sz(32, R0).length === 0 && sz(33, roles({ tileset: 'ts' })).length === 0 && sz(33, null).length === 0 && sz(128, roles({ tileset: 'ts' })).length === 0);
  check('tileset-size: 129 tiles is an error anywhere, also with roles null (and no extra warning)', (() => { const r = sz(129, null); return r.length === 1 && r[0].severity === 'error' && r[0].compilerAlso === true; })() && sz(129, R0).length === 1);

  // malformed assets
  const junk = checkAssets(mkProject({ tilesets: { a: 5, b: { tiles: 'x' }, c: { tiles: [null, 5, { rows: 3 }] } }, maps: { m: null, n: { w: 'a' }, o: 7 }, sfx: { s: null, t: { ticks: [null, 5, { tone: 'x' }] } } }), roles({ tileset: 'c', maps: { m: 'm', n: 'n', o: 'o' }, world: 'n', floorplans: ['o'], view: { bright: 1, ceil: 0, floor: 1 } }));
  check('malformed assets give messages, not exceptions', Array.isArray(junk) && junk.every((x) => typeof x.message === 'string' && x.message.length > 0 && typeof x.id === 'string'), JSON.stringify(ids(junk)));
  check('checkAssets on junk projects and junk roles returns an array', [null, undefined, 5, {}, { assets: null }, { assets: { tilesets: [] } }].every((p) => Array.isArray(checkAssets(p, null)) && Array.isArray(checkAssets(p, { world: 5 }))));
  check('every finding has id, severity (warning | error), kind, asset, message, compilerAlso', [...junk, ...cm([bg1, bg2], [0, 1]), ...mix([blackA(0), blackA(1)])].every((x) => x.id && ['warning', 'error'].includes(x.severity) && typeof x.kind === 'string' && typeof x.asset === 'string' && typeof x.message === 'string' && typeof x.compilerAlso === 'boolean'));
  const pj = mkProject({ tilesets: { ts: { tiles: [blackA(0), blackA(1)] } } }); const before = JSON.stringify(pj);
  checkAssets(pj, null);
  check('checkAssets does not modify the project', JSON.stringify(pj) === before);
}

// ═══ 4  the example projects ════════════════════════════════════════════════════════════════════════════════════
const hexb = (b) => (typeof b === 'number' ? b : parseInt(b, 16));
// An independent reading of the raw JSON (written separately from the module under test).
const raw = (t) => {
  const r0 = t.rows[0];
  const ink = r0.ink ?? 0, paper = r0.paper ?? 7, bright = r0.bright ? 1 : 0;
  const bytes = t.rows.map((r) => hexb(r.bits));
  const pop = (n) => { let c = 0; for (; n; n >>= 1) c += n & 1; return c; };
  const setBits = bytes.reduce((a, b) => a + pop(b), 0);
  return { attr: bright * 64 + paper * 8 + ink, ink, paper, bright, set: setBits, clear: 64 - setBits, solid: (t.flags ?? 0) % 2 === 1 || t.fg === true };
};
const usesBlackRaw = (t) => { const r = raw(t); return (r.paper === 0 && r.clear > 0) || (r.ink === 0 && r.set > 0); };
const cellsRaw = (m) => (typeof m.cells === 'string' ? m.cells.match(/../g).map((x) => parseInt(x, 16)) : m.cells);
{
  const out = {};
  for (const id of EX) {
    const { project, text } = examples[id];
    const rl = scanRoles(text);
    out[id] = checkAssets(project, rl);
  }
  console.log('\nWhat the example projects really produce:');
  for (const id of EX) {
    if (!out[id].length) console.log(`  ${id}: no warnings`);
    for (const f of out[id]) console.log(`  ${id}: [${f.severity}${f.compilerAlso ? ', compilerAlso' : ''}] ${f.id} ${f.kind}/${f.asset}: ${f.message}`);
  }
  console.log('');
  const summary = EX.flatMap((id) => out[id].map((f) => `${id}: ${f.id} ${f.asset}`));
  const EXPECTED = [
    'platformer: background-attr-mix pf_world',
    'vaults: background-attr-mix vl_panel',
    'vaults: background-attr-mix vl_title',
  ];
  check('the examples produce exactly the expected warnings (no errors, no tile0-not-blank, no shape or undefined-tile findings)', eq(summary, EXPECTED), JSON.stringify(summary));
  check('no example finding is an error or a compilerAlso finding', EX.every((id) => out[id].every((f) => f.severity === 'warning' && !f.compilerAlso)));

  // each one is TRUE, recomputed from the raw JSON
  const black = (id, ts) => { const o = { 0: [], 1: [] }; examples[id].assets.tilesets[ts].tiles.forEach((t, i) => { if (usesBlackRaw(t)) o[raw(t).bright].push(i); }); return o; };
  // black-bright-mix: the examples were fixed (breakout tile 2 BRIGHT 0, blockfall tiles 7 / 10 / 11 BRIGHT 1, vaults tile 2 BRIGHT 1); recompute from the JSON that no mix is left
  const noMix = (id, ts) => { const bb = black(id, ts); return !(bb[0].length && bb[1].length); };
  check('breakout bricks / blockfall gfx / vaults vl_tiles: no tile set mixes BRIGHT 0 and BRIGHT 1 black, recomputed from the JSON',
    noMix('breakout', 'bricks') && noMix('blockfall', 'gfx') && noMix('vaults', 'vl_tiles'), JSON.stringify([black('breakout', 'bricks'), black('blockfall', 'gfx'), black('vaults', 'vl_tiles')]));
  const vb = black('vaults', 'vl_tiles');
  check('vaults vl_tiles: every black tile is BRIGHT 1 like the VIEW3D (CEIL 0, default BRIGHT 1), so the view does not mix either',
    vb[0].length === 0 && vb[1].length > 0 && /VIEW3D/.test(examples.vaults.arc) && /CEIL 0/.test(examples.vaults.arc) && !/BRIGHT 0/.test(examples.vaults.arc.split('\n').filter((l) => /VIEW3D/.test(l)).join('')));
  check('no example reports black-bright-mix', EX.every((id) => !out[id].some((f) => f.id === 'black-bright-mix')));
  // background-attr-mix, independently: the used non-foreground tiles of the map grouped by attribute
  const groupsOf = (id, tsName, mapName, world) => {
    const ts = examples[id].assets.tilesets[tsName].tiles, cells = cellsRaw(examples[id].assets.maps[mapName]);
    const byAttr = new Map();
    for (const raw0 of cells) {
      const t = (raw0 === 255 || raw0 === null || raw0 === -1) ? (world ? 0 : null) : raw0;
      if (t === null || raw(ts[t]).solid) continue;
      const a = raw(ts[t]).attr;
      if (!byAttr.has(a)) byAttr.set(a, { tiles: new Set(), cells: 0 });
      byAttr.get(a).tiles.add(t); byAttr.get(a).cells++;
    }
    return [...byAttr].map(([attr, g]) => ({ attr, tiles: [...g.tiles].sort((x, y) => x - y), cells: g.cells })).sort((x, y) => y.cells - x.cells || x.attr - y.attr);
  };
  const gp = groupsOf('platformer', 'pf_tiles', 'pf_world', true);
  const fpf = out.platformer[0];
  check('platformer pf_world: background attribute groups (attribute, tiles, cell count) recomputed from the JSON (blank = tile 0, solid tiles left out)',
    eq(gp, fpf.groups.map((g) => ({ attr: g.attr, tiles: [...g.tiles].sort((x, y) => x - y), cells: g.cells }))) && gp.length === 5 && gp[0].attr === 104 && eq(gp[0].tiles, [0, 4, 9]) && gp[0].cells === 1105, JSON.stringify(gp));
  const pfTs = examples.platformer.assets.tilesets.pf_tiles.tiles;
  check('platformer: the solid tiles (1, 2, 3 ...) are foreground and are not among the groups; the flags say so in the JSON', pfTs[1].flags % 2 === 1 && pfTs[2].flags % 2 === 1 && !gp.some((g) => g.tiles.includes(1) || g.tiles.includes(2)));
  const gv = groupsOf('vaults', 'vl_tiles', 'vl_panel', false);
  const fvp = out.vaults.find((f) => f.id === 'background-attr-mix');
  check('vaults vl_panel: background attribute groups recomputed from the JSON', eq(gv, fvp.groups.map((g) => ({ attr: g.attr, tiles: [...g.tiles].sort((x, y) => x - y), cells: g.cells }))) && gv.length === 4, JSON.stringify(gv));
  const gt = groupsOf('vaults', 'vl_tiles', 'vl_title', false);
  const fvt = out.vaults.filter((f) => f.id === 'background-attr-mix').find((f) => f.asset === 'vl_title');
  check('vaults vl_title (the title picture: black, cyan wall textures, brass door and goblet; the title\'s sprites only move over its black corridor): background attribute groups recomputed from the JSON',
    eq(gt, fvt.groups.map((g) => ({ attr: g.attr, tiles: [...g.tiles].sort((x, y) => x - y), cells: g.cells }))) && gt.length === 3, JSON.stringify(gt));
  check('shooter sky: no warning, and the JSON agrees (at most one background attribute, no mixed black)', groupsOf('shooter', 'gfx', 'sky', false).length <= 1 && (() => { const bb = black('shooter', 'gfx'); return !(bb[0].length && bb[1].length); })());
  check('vaults vl_maze (the floor plan) has a wall ring in the JSON and gets no map finding; platformer pf_world is 128 x 16 with tiles <= 31',
    (() => { const m = examples.vaults.assets.maps.vl_maze, c = cellsRaw(m); return c.every((v, i) => { const x = i % m.w, y = Math.floor(i / m.w); return !(x === 0 || y === 0 || x === m.w - 1 || y === m.h - 1) || (v >= 1 && v <= 4); }); })() &&
    cellsRaw(examples.platformer.assets.maps.pf_world).every((v) => v === 255 || (v >= 0 && v <= 31)) && !out.vaults.some((f) => f.asset === 'vl_maze') && !out.platformer.some((f) => f.id.includes('shape')));
  check('the platformer has tile 0 blank in the JSON (so no tile0-not-blank)', raw(pfTs[0]).set === 0);
  // speed
  let best = 1e9;
  for (let k = 0; k < 6; k++) {
    const t = performance.now();
    for (const id of ['shooter', 'platformer', 'vaults']) checkAssets(examples[id].project, scanRoles(examples[id].text));
    best = Math.min(best, performance.now() - t);
  }
  check('all three example projects (scanRoles + checkAssets) take under 20 ms together', best < 20, `${best.toFixed(2)} ms`);
}

// ═══ 5  agreement with the compiler ═════════════════════════════════════════════════════════════════════════════
const dist = ROOT + 'arcade/dist/';
if (existsSync(dist + 'v2/runtime.json') && existsSync(dist + 'v3/runtime.json') && existsSync(dist + 'v4/runtime.json')) {
  const { compile, requiredRuntime } = await import('../src/lang/arcade/arcade-compile.js');
  const builds = {};
  for (const v of [2, 3, 4]) builds[v] = { rt: JSON.parse(readFileSync(dist + `v${v}/runtime.json`, 'utf8')), im: new Uint8Array(readFileSync(dist + `v${v}/runtime.bin`)) };
  const build = (proj) => {
    const s = P.buildSource(proj);
    const b = builds[requiredRuntime(s.text, proj.assets).version];
    return { r: compile(s.text, { runtime: b.rt, image: b.im, assets: proj.assets }), roles: scanRoles(s.text) };
  };
  const msgs = (r) => [...r.errors, ...r.warnings].map((d) => d.message).join(' | ');
  const mut = (id, f) => { const p = clone(examples[id].project); f(p); return p; };

  // tile0-not-blank
  const tile0Cases = [
    ['the platformer as shipped (tile 0 blank)', (p) => {}, false],
    ['tile 0, row 0, one pixel set', (p) => { p.assets.tilesets.pf_tiles.tiles[0].rows[0].bits = '10'; }, true],
    ['tile 0, last row, one pixel set', (p) => { p.assets.tilesets.pf_tiles.tiles[0].rows[7].bits = '01'; }, true],
    ['tile 0 with all pixels set', (p) => { for (const r of p.assets.tilesets.pf_tiles.tiles[0].rows) r.bits = 'FF'; }, true],
    ['tile 0 bits as the number 0 (still blank)', (p) => { for (const r of p.assets.tilesets.pf_tiles.tiles[0].rows) r.bits = 0; }, false],
    ['tile 0 blank but with other ink / paper / bright', (p) => { for (const r of p.assets.tilesets.pf_tiles.tiles[0].rows) { r.ink = 3; r.paper = 0; r.bright = 0; } }, false],
    ['tile 1 (not 0) with set pixels', (p) => { p.assets.tilesets.pf_tiles.tiles[1].rows[0].bits = 'FF'; }, false],
  ];
  for (const [name, f, expect] of tile0Cases) {
    const p = mut('platformer', f);
    const { r, roles: rl } = build(p);
    const compilerWarns = r.warnings.some((w) => /tile 0 of the tileset .* is not blank/.test(w.message));
    const mine = checkAssets(p, rl).some((x) => x.id === 'tile0-not-blank');
    check(`tile0-not-blank agrees with the compiler: ${name}: compiler ${compilerWarns ? 'warns' : 'is quiet'}, rule ${mine ? 'flags' : 'is quiet'}`, r.errors.length === 0 && compilerWarns === expect && mine === expect, msgs(r));
  }
  // the rules marked compilerAlso: the compiler's error when the rule fires, none when it does not
  const errCases = [
    ['world-shape', 'platformer width 23', (p) => { const m = p.assets.maps.pf_world; m.w = 23; m.cells = Array.from({ length: 23 * 16 }, () => 0); }, /world map/],
    ['world-shape', 'platformer a cell with tile 32', (p) => { p.assets.maps.pf_world.cells[100] = 32; }, /0\.\.31/],
    ['world-shape', 'platformer height 17 (cells padded)', (p) => { const m = p.assets.maps.pf_world; m.h = 17; m.cells = m.cells.concat(Array(128).fill(0)); }, /height/],
    ['map-undefined-tile', 'platformer a cell with tile 25 (20 tiles defined)', (p) => { p.assets.maps.pf_world.cells[100] = 25; }, /does not define/],
    ['map-undefined-tile', 'shooter a cell with tile 40 in the cell map (16 tiles)', (p) => { p.assets.maps.sky.cells[5] = 40; }, /tile index|does not define|tile/],
    ['floorplan-shape', 'vaults an empty cell on the outer ring', (p) => { p.assets.maps.vl_maze.cells[3] = 0; }, /outer ring/],
    ['floorplan-shape', 'vaults wall code 5', (p) => { p.assets.maps.vl_maze.cells[40] = 5; }, /wall types/],
    ['sfx-unstorable', 'shooter pew with tone 3840 vol 15', (p) => { p.assets.sfx.pew.ticks[0] = { tone: 3840, vol: 15, noise: 0, mix: 6 }; }, /cannot be stored/],
  ];
  for (const [id, name, f, re] of errCases) {
    const p = mut(name.startsWith('platformer') ? 'platformer' : name.startsWith('vaults') ? 'vaults' : 'shooter', f);
    const { r, roles: rl } = build(p);
    const mine = checkAssets(p, rl).filter((x) => x.id === id && x.compilerAlso);
    check(`${id} agrees with the compiler: ${name}`, r.errors.length > 0 && re.test(msgs(r)) && mine.length >= 1, `compiler: ${msgs(r).slice(0, 140)}  rule: ${mine.map((x) => x.message).join(' / ').slice(0, 100)}`);
  }
  for (const id of ['shooter', 'platformer', 'vaults', 'blockfall', 'breakout']) {
    const p = examples[id].project, { r, roles: rl } = build(p);
    check(`${id}: compiles with no error, and no compilerAlso finding`, r.errors.length === 0 && !checkAssets(p, rl).some((x) => x.compilerAlso), msgs(r));
  }
} else {
  console.log('SKIP  agreement with the compiler: arcade/dist/ is not published (node arcade/tools/publish-runtime.mjs)');
}

// ═══ 6  fuzz ════════════════════════════════════════════════════════════════════════════════════════════════════
{
  let seed = 0x1eaf2068;
  const rnd = () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const JUNK = [null, undefined, 'x', '', 'ZZ', '0F', 'FF', 'FFFF', 0, 1, -1, 4, 5, 31, 32, 127, 128, 255, 256, 4095, 4096, 1e9, -1e9, 1.5, NaN, Infinity, true, false, [], {}, [[]], [null], { rows: 5 }, { rows: [] }, { w: 1 }, { tone: 3840, vol: 15 }, '00FF', 'zz', 'a b'];
  const paths = (o, base = [], acc = []) => {
    acc.push(base);
    if (o && typeof o === 'object') for (const k of Object.keys(o)) paths(o[k], base.concat([k]), acc);
    return acc;
  };
  const at = (o, p) => p.reduce((x, k) => x?.[k], o);
  const mutate = (root) => {
    const ps = paths(root).filter((p) => p.length > 0);
    const p = pick(ps), parent = at(root, p.slice(0, -1)), key = p[p.length - 1];
    if (parent === null || typeof parent !== 'object') return;
    switch (Math.floor(rnd() * 6)) {
      case 0: delete parent[key]; break;
      case 1: parent[key] = pick(JUNK); break;
      case 2: if (Array.isArray(parent)) parent.splice(Math.floor(rnd() * parent.length), 1 + Math.floor(rnd() * 3)); else parent[key] = pick(JUNK); break;
      case 3: if (Array.isArray(parent)) parent.push(clone(pick(parent) ?? null)); else parent[key] = pick(JUNK); break;
      case 4: if (typeof parent[key] === 'string') parent[key] = parent[key].slice(0, Math.floor(rnd() * parent[key].length)); else if (typeof parent[key] === 'number') parent[key] += pick([-1, 1, 255, -256, 0.5]); else parent[key] = pick(JUNK); break;
      default: if (Array.isArray(parent[key])) parent[key] = parent[key].slice(0, Math.floor(rnd() * parent[key].length)); else parent[key] = pick(JUNK);
    }
  };
  const okFinding = (x) => x && typeof x.id === 'string' && ['warning', 'error'].includes(x.severity) && typeof x.message === 'string' && typeof x.asset === 'string' && typeof x.kind === 'string' && typeof x.compilerAlso === 'boolean';
  const bases = ['shooter', 'platformer', 'vaults', 'blockfall'].map((id) => ({ id, assets: { tilesets: examples[id].project.assets.tilesets, maps: examples[id].project.assets.maps, sfx: examples[id].project.assets.sfx }, roles: scanRoles(examples[id].text) }));
  let runs = 0, thrown = 0, bad = 0, internal = 0, findings = 0, firstThrow = null;
  const ROUNDS = 130;
  for (const base of bases) {
    for (let n = 0; n < ROUNDS; n++) {
      const assets = clone(base.assets);
      const mutations = 1 + Math.floor(rnd() * 3);
      for (let k = 0; k < mutations; k++) mutate(assets);
      const project = mkProject(assets);
      const mapNames = Object.keys(assets.maps ?? {}), tsNames = Object.keys(assets.tilesets ?? {});
      const rl = [base.roles, null, {}, { world: 5, floorplans: 'x', maps: null, view: { ceil: 'a' }, tileset: {} },
        { ...base.roles, world: pick([...mapNames, null, 'ghost']), floorplans: [pick([...mapNames, 'ghost'])], tileset: pick([...tsNames, null]), view: pick([base.roles.view, { bright: 1, ceil: 0, floor: 0 }, { bright: 0, ceil: 0, floor: 1 }, { bright: null, ceil: null, floor: null }, null]) }][Math.floor(rnd() * 5)];
      runs++;
      try {
        const fs = checkAssets(project, rl);
        if (!Array.isArray(fs) || !fs.every(okFinding)) bad++;
        findings += fs.length;
        internal += fs.filter((x) => /could not be checked/.test(x.message)).length;      // the guard around each asset caught an exception of the checker itself
        if (JSON.stringify(checkAssets(project, rl)) !== JSON.stringify(fs)) bad++;       // deterministic
      } catch (e) { thrown++; firstThrow ??= e.stack; }
    }
  }
  check(`fuzz: checkAssets on ${runs} randomly mutated assets / roles never throws and returns well-formed findings`, runs >= 300 && thrown === 0 && bad === 0 && internal === 0, `${runs} runs, ${findings} findings produced, ${thrown} threw, ${internal} internal errors caught by the guards, ${bad} malformed${firstThrow ? '\n' + firstThrow : ''}`);
  // wholly broken projects
  let ok = true;
  for (let n = 0; n < 60; n++) {
    const proj = { assets: pick([null, 5, [], { tilesets: pick(JUNK), maps: pick(JUNK), sfx: pick(JUNK) }, { tilesets: { a: pick(JUNK) }, maps: { b: pick(JUNK) }, sfx: { c: pick(JUNK) } }]) };
    try { if (!Array.isArray(checkAssets(Math.random() < 0.1 ? pick(JUNK) : proj, pick([null, {}, { tileset: 'a', world: 'b', floorplans: ['b'], maps: { b: 'b' }, view: { bright: 1, ceil: 0, floor: 0 } }, { tileset: 5 }]))) ) ok = false; } catch { ok = false; }
  }
  check('fuzz: 60 wholly broken projects (assets of the wrong type, junk asset values) never throw', ok);
  // scanRoles on damaged source text
  let sthrown = 0, sruns = 0, shape = true;
  const srcs = EX.map((id) => examples[id].text);
  for (let n = 0; n < 300; n++) {
    let s = pick(srcs);
    const a = Math.floor(rnd() * s.length), b = Math.min(s.length, a + Math.floor(rnd() * 40));
    s = pick([s.slice(0, a) + s.slice(b), s.slice(0, a) + pick(['"', '(', 'VIEW3D', 'WINDOW', ' MAP = "', '\u0000', 'CEIL', '\n\n', 'TILESET']) + s.slice(a), s.slice(0, a)]);
    sruns++;
    try { const r = scanRoles(s); if (!(r && 'tileset' in r && 'maps' in r && 'world' in r && Array.isArray(r.floorplans) && 'view' in r)) shape = false; } catch { sthrown++; }
  }
  check(`fuzz: scanRoles on ${sruns} damaged sources never throws and keeps its shape`, sthrown === 0 && shape, `${sthrown} threw`);
}

// ═══ Models (docs/ARCADE_WIREFRAME_CONTRACT.md section 2.1) ═══════════════════════════════════════════════════
{
  const sq = { points: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], edges: [[0, 1], [1, 2], [2, 3], [3, 0]] };
  const cm = (m) => checkAssets(mkProject({ models: { m } }), null);
  const shapeMsgs = (m) => cm(m).filter((f) => f.id === 'model-shape').map((f) => f.message).join(' | ');
  check('models: a good model gives no finding', cm(sq).length === 0);
  check('models: 129 points / 256 edges / a coordinate of 65 are errors (the limits 128, 255, 64 are fine)',
    /129 points; at most 128/.test(shapeMsgs({ points: Array.from({ length: 129 }, () => [0, 0, 0]), edges: [[0, 1]] })) && /256 edges; at most 255/.test(shapeMsgs({ points: sq.points, edges: Array.from({ length: 256 }, () => [0, 1]) }))
    && /point 1 has a coordinate beyond \+-64/.test(shapeMsgs({ points: [[0, 0, 0], [65, 0, 0]], edges: [[0, 1]] }))
    && cm({ points: Array.from({ length: 128 }, (_, i) => [i % 2 ? 64 : -64, 0, 0]), edges: Array.from({ length: 255 }, () => [0, 1]) }).filter((f) => f.severity === 'error').length === 0);
  check('models: no points / no edges / an edge i = j / an edge naming a missing point are errors, with the edge positions',
    /no points/.test(shapeMsgs({ points: [], edges: [] })) && /no edges/.test(shapeMsgs({ points: sq.points, edges: [] }))
    && /edge 1 joins a point to itself/.test(shapeMsgs({ points: sq.points, edges: [[0, 1], [2, 2]] }))
    && /edge 0 names a point that does not exist \(the points are 0\.\.3\)/.test(shapeMsgs({ points: sq.points, edges: [[0, 4]] }))
    && eq(cm({ points: sq.points, edges: [[0, 1], [3, 3], [9, 0]] }).filter((f) => f.id === 'model-shape').map((f) => f.positions), [[1], [2]]));
  check('models: a malformed point / edge or a missing array is asset-malformed; a point on no edge is a warning; every finding is shown (compilerAlso false)',
    has(cm({ edges: [] }), 'asset-malformed', 'm') && has(cm({ points: [[0, 0]], edges: [] }), 'asset-malformed') && has(cm({ points: sq.points, edges: [[0, 'x']] }), 'asset-malformed')
    && cm({ points: [...sq.points, [5, 5, 5]], edges: sq.edges }).some((f) => f.id === 'model-unused-point' && f.severity === 'warning' && eq(f.points, [4]))
    && cm({ points: [[0, 0, 0], [100, 0, 0]], edges: [[0, 0]] }).every((f) => f.compilerAlso === false && f.kind === 'models' && f.asset === 'm'));
  check('models: checkAssets never throws on junk', (() => { try { for (const m of [null, 5, 'x', [], { points: null }, { points: [null], edges: [null] }]) checkAssets(mkProject({ models: { m } }), null); return true; } catch { return false; } })());
}

console.log(failed ? `\n${failed} check(s) FAILED` : '\nAll checks passed');
process.exit(failed ? 1 : 0);
