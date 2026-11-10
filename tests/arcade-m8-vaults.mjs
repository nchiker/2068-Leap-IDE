#!/usr/bin/env node
"use strict";
// arcade-m8-vaults.mjs -- tests for the acceptance game of the raycaster slice, arcade/examples/vaults.arc ("Vaults"), docs/ARCADE_RAYCASTER_CONTRACT.md 8.1.
//
//   node tests/arcade-m8-vaults.mjs
//
//   1  assets and level data: the json is exactly what vaults.assets.gen.mjs makes; the maze (32 x 32, all four wall types, one locked door, every room reachable, the vault
//      reachable only through the door), what stands on it, the level data in the source equals the maze; sprites, tiles, the HUD panel, the messages
//   2  the compiler: the game compiles on the batch 3 mock runtime and on arcade/build/v4 (the real runtime) when it exists; the link report; 16 instances; no warnings
//   3  the WIN run on the reference interpreter (tests/arcade-m8-vaults-script.mjs, worked out by tests/arcade-m8-vaults-bot.mjs): a bump against the locked door, the key,
//      a wraith shot dead, a gem, a potion, the door opened with SETWALL, the vault's gems, the treasure; the HUD never leaves its strips (cell map compared every tick)
//   4  the LOSE run: standing still among the wraiths, game over, the title, a NEW game in which everything is back (door shut, items and wraiths in place)
//   5  DIFFERENTIAL on the mock: the compiled game's state equals the interpreter's tick by tick (variables, arrays, SPR_TAB entries, the map array, the pose) for both runs;
//      T-states of PROC FRAME on the mock (the runtime's routines are free there: the real figures are in the next section)
//   6  DIFFERENTIAL on the real runtime v4 (arcade/build/v4), when it has the routines: the same runs, SEEN / DEPTH fed the runtime's own BB_TAB (skips, saying why, until the
//      runtime exists). The per-tick COSTS on the real runtime are measured by tests/arcade-m8-vaults-perf.mjs (not part of run-all: it is a measurement, and slow)
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compile, requiredRuntime } from '../src/lang/arcade/arcade-compile.js';
import { diffV4, rng } from './arcade-m8-common.mjs';
import { compileOnMock, runOnMock, interpretVaults, VAULTS_SRC, VAULTS_ASSETS } from './arcade-m8-vaults-harness.mjs';
import { WIN_RUNS, WIN_SIGHT, LOSE_RUNS } from './arcade-m8-vaults-script.mjs';
import { CELLS, THINGS, DOOR, MAP_W, MAP_H, buildAssets } from '../arcade/examples/vaults.assets.gen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const M_ = await import(pathToFileURL(join(ROOT, 'tsrun/machine.js')).href);

let passed = 0, failed = 0, skipped = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const skip_ = (name, why) => { console.log(`  SKIP  ${name}  (${why})`); skipped++; };
const info = (s) => console.log('  INFO  ' + s);
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const runsToStick = (runs) => { const a = []; for (const [v, n] of runs) for (let i = 0; i < n; i++) a.push(v); return (t) => a[t - 1] ?? 0; };
const runsLength = (runs) => runs.reduce((n, [, k]) => n + k, 0);
const WIN_N = runsLength(WIN_RUNS), LOSE_N = runsLength(LOSE_RUNS);
const winStick = runsToStick(WIN_RUNS), loseStick = runsToStick(LOSE_RUNS);
/** the synthetic sighting of the win run: for these ticks wraith WIN_SIGHT.instance is "in the sights" (the interpreter and the mock cannot draw); every other instance is not seen */
const winBillboard = (t, i) => (i === WIN_SIGHT.instance && t >= WIN_SIGHT.from && t <= WIN_SIGHT.to ? { depth: WIN_SIGHT.depth, col: WIN_SIGHT.col } : undefined);

// instance numbers, in the order of the SPRITE lines of vaults.arc: me 0, wr 1..5, gem 6..10, pot 11..13, kk 14, tr 15
const INST = { me: 0, wr: 1, gem: 6, pot: 11, kk: 14, tr: 15 };

// =================================================================================================================
console.log('1. Assets and level data');
const A = VAULTS_ASSETS;
const SRC = VAULTS_SRC;
const cellAt = (cx, cy, grid = CELLS) => grid[cy * MAP_W + cx];
const toCell = ([x, y]) => [x >> 8, y >> 8];
/** the cells reachable from `from` over empty cells (4-connected), as a Set of "x,y" */
function reach(grid, from) {
  const seen = new Set([from.join(',')]), q = [from];
  while (q.length) {
    const [x, y] = q.shift();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H || grid[ny * MAP_W + nx] !== 0 || seen.has(`${nx},${ny}`)) continue;
      seen.add(`${nx},${ny}`); q.push([nx, ny]);
    }
  }
  return seen;
}
{
  const fresh = JSON.stringify(buildAssets(), null, 1) + '\n';
  check_('vaults.assets.json is exactly what vaults.assets.gen.mjs generates (deterministic)', fresh === readFileSync(join(ROOT, 'arcade/examples/vaults.assets.json'), 'utf8'));
  check_(`the maze is ${MAP_W} x ${MAP_H} (at least 24 x 24) and the asset says the same`, MAP_W >= 24 && MAP_H >= 24 && A.maps['vl_maze'].w === MAP_W && A.maps['vl_maze'].h === MAP_H && A.maps['vl_maze'].cells.length === MAP_W * MAP_H);
  const count = (t) => CELLS.filter((c) => c === t).length;
  check_(`all four wall types are used (type 1: ${count(1)} cells, 2: ${count(2)}, 3: ${count(3)}, 4: ${count(4)}) and there is exactly one locked door (type 4)`, [1, 2, 3, 4].every((t) => count(t) > 0) && count(4) === 1);
  const ring = []; for (let i = 0; i < MAP_W; i++) ring.push(cellAt(i, 0), cellAt(i, MAP_H - 1), cellAt(0, i), cellAt(MAP_W - 1, i));
  check_('the outer ring of the maze is all wall (the renderer needs it)', ring.every((c) => c >= 1 && c <= 4));
  check_('the layout letters mark exactly: 1 start, 1 key, 1 treasure, 5 wraiths, 5 gems, 3 potions, all on empty cells', THINGS.P.length === 1 && THINGS.K.length === 1 && THINGS.T.length === 1 && THINGS.E.length === 5 && THINGS.G.length === 5 && THINGS.H.length === 3 &&
    Object.values(THINGS).flat().every((p) => cellAt(...toCell(p)) === 0));
  const start = toCell(THINGS.P[0]);
  const closed = reach(CELLS, start);
  const door = toCell(DOOR);
  const opened = Uint8Array.from(CELLS); opened[door[1] * MAP_W + door[0]] = 0;
  const open = reach(opened, start);
  const inClosed = (p) => closed.has(toCell(p).join(','));
  const vault = (p) => !inClosed(p);
  check_('every empty cell of the maze outside the vault is joined to the start (no walled-off pockets) while the door is shut', (() => { let n = 0; for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) if (cellAt(x, y) === 0 && !closed.has(`${x},${y}`)) n++; return n; })() <= 3 * 5 + 2, 'cells outside: ' + [...Array(MAP_H * MAP_W).keys()].filter((i) => CELLS[i] === 0 && !closed.has(`${i % MAP_W},${(i / MAP_W) | 0}`)).length);
  check_('the key, the wraiths, the potions and three of the gems are reachable with the door SHUT; the treasure and the two gems of the vault are not', inClosed(THINGS.K[0]) && THINGS.E.every(inClosed) && THINGS.H.every(inClosed) && THINGS.G.filter(inClosed).length === 3 && vault(THINGS.T[0]) && THINGS.G.filter(vault).length === 2);
  check_('with the door OPEN (SETWALL to 0) the treasure and the vault\'s gems are reachable too: the key opens the way to the win', open.has(toCell(THINGS.T[0]).join(',')) && THINGS.G.every((p) => open.has(toCell(p).join(','))));
  check_('the door is the only way in: a cell next to it on each side is empty (the antechamber and the vault), the other two sides are vault walls (type 3)', (() => { const [x, y] = door; return cellAt(x, y + 1) === 0 && cellAt(x, y - 1) === 0 && cellAt(x - 1, y) === 3 && cellAt(x + 1, y) === 3; })());
  // every item has room to stand: its own cell and at least two of its four neighbours are empty (the player's box has a radius of 40 units, a cell is 256)
  check_('every item and the start stand in cells with at least two empty neighbours (room to walk up to them)', Object.values(THINGS).flat().every((p) => { const [x, y] = toCell(p); return [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dy]) => cellAt(x + dx, y + dy) === 0).length >= 2; }));

  // the source carries the level data
  const init = interpretVaults(0, () => 0).init;
  const arr = (n) => init.arrays[n];
  const num = (name) => Number(SRC.match(new RegExp(`^CONST ${name} = (-?\\d+)\\s*$`, 'm'))?.[1]);
  check_('the CONSTs SX0 SY0 KX KY TX TY DX0 DY0 in the source are the start, the key, the treasure and the door of the maze (8.8, the centre of the cell)',
    num('SX0') === THINGS.P[0][0] && num('SY0') === THINGS.P[0][1] && num('KX') === THINGS.K[0][0] && num('KY') === THINGS.K[0][1] && num('TX') === THINGS.T[0][0] && num('TY') === THINGS.T[0][1] && num('DX0') === DOOR[0] && num('DY0') === DOOR[1]);
  check_('EXS / EYS, GXS / GYS and PXS / PYS in the source are the wraiths, gems and potions of the maze (in reading order)',
    JSON.stringify([arr('EXS'), arr('EYS')]) === JSON.stringify([THINGS.E.map((p) => p[0]), THINGS.E.map((p) => p[1])]) &&
    JSON.stringify([arr('GXS'), arr('GYS')]) === JSON.stringify([THINGS.G.map((p) => p[0]), THINGS.G.map((p) => p[1])]) &&
    JSON.stringify([arr('PXS'), arr('PYS')]) === JSON.stringify([THINGS.H.map((p) => p[0]), THINGS.H.map((p) => p[1])]));
  check_('NEN / NGM / NPT in the source are the counts (5 wraiths, 5 gems, 3 potions)', num('NEN') === 5 && num('NGM') === 5 && num('NPT') === 3 && THINGS.E.length === 5 && THINGS.G.length === 5 && THINGS.H.length === 3);
  check_('the source says FRAMERATE 15, VIEW3D with COLW 4, and the SPRITE pools: 1 + 5 + 5 + 3 + 1 + 1 = 16 instances', /^FRAMERATE 15\s*$/m.test(SRC) && /^VIEW3D level COLW 4\b/m.test(SRC) && /^SPRITE wr\(5\)/m.test(SRC) && /^SPRITE gem\(5\)/m.test(SRC) && /^SPRITE pot\(3\)/m.test(SRC));

  // sprites and tiles
  const S = A.sprites;
  check_('sprites: the wraith is 16 x 16 with 4 frames (two floating, hurt, burst), the treasure 16 x 16 with 2, the gem 8 x 8 with 2, the potion and the key 8 x 8, the marker 16 x 16; all are SQUARE (a billboard is stretched to a square)',
    S['vl_wraith'].w === 16 && S['vl_wraith'].h === 16 && S['vl_wraith'].frames.length === 4 && S['vl_treasure'].w === 16 && S['vl_treasure'].frames.length === 2 && S['vl_gem'].w === 8 && S['vl_gem'].frames.length === 2 && S['vl_potion'].w === 8 && S['vl_key'].h === 8 && S['vl_marker'].w === 16 && S['vl_marker'].h === 16 &&
    Object.values(S).every((s) => s.w === s.h));
  check_('every sprite frame has h rows of the right hex width and no lit pixel outside its mask', Object.values(S).every((s) => s.frames.every((f) => f.rows.length === s.h && f.rows.every((r) => r.bits.length === s.w / 4 && r.mask.length === s.w / 4 && (Number(`0x${r.bits}`) & ~Number(`0x${r.mask}`)) === 0))));
  const tiles = A.tilesets['vl_tiles'].tiles;
  check_(`the tileset has ${tiles.length} tiles (at most 128); every tile has 8 rows and one attribute for all of them (a cell has one ink / paper / bright)`, tiles.length <= 128 && tiles.every((t) => t.rows.length === 8 && t.rows.every((r) => r.ink === t.rows[0].ink && r.paper === t.rows[0].paper && r.bright === t.rows[0].bright)));
  const panel = A.maps['vl_panel'];
  check_('the HUD panel is a full 32 x 24 screen map of defined tiles; its 16 x 12 window cells (8..23, 6..17) are blank (they are never drawn); a bezel closes the window; the aiming marks are in the middle of its four sides', panel.w === 32 && panel.h === 24 && panel.cells.length === 768 && panel.cells.every((t) => t >= 0 && t < tiles.length) &&
    (() => { for (let y = 6; y <= 17; y++) for (let x = 8; x <= 23; x++) if (panel.cells[y * 32 + x] !== 0) return false; return true; })() &&
    [...Array(18).keys()].every((k) => panel.cells[5 * 32 + 7 + k] >= 2 && panel.cells[18 * 32 + 7 + k] >= 2) && panel.cells[5 * 32 + 15] === 10 && panel.cells[18 * 32 + 16] === 13 && panel.cells[11 * 32 + 7] === 14 && panel.cells[12 * 32 + 24] === 17);
  check_('the eight SFX are declared and have records (shot thud kill pick door hurt win lose)', Object.keys(A.sfx).length === 8 && Object.values(A.sfx).every((s) => s.ticks.length >= 5));
  // messages: the message line is rewritten by a print with no clear, so every message is exactly as wide as the line it uses (30 characters at column 1)
  const left = [...SRC.matchAll(/PRINT AT 20, 1; "([^"]*)";/g)].map((m) => m[1]), right = [...SRC.matchAll(/PRINT AT 20, 16; "([^"]*)";/g)].map((m) => m[1]);
  check_(`the ${left.length} bottom messages are printed in two halves (columns 1..15 and 16..30), each exactly 15 characters, so a message replaces the last one with no clear and no print is longer than 15 characters`, left.length === 6 && right.length === 6 && left.every((m) => m.length === 15) && right.every((m) => m.length === 15), `${left.map((m) => m.length)} ${right.map((m) => m.length)}`);
  // statements that print are at most 31 characters (the language's string limit) and no number print can run off a row
  check_('the number prints leave room: the health number (3 digits and a space from column 3) ends before the bezel at column 7, the score (4 digits and 3 spaces from column 25) before column 32', /PRINT AT 9, 3; hp; " ";/.test(SRC) && /PRINT AT 8, 25; score; "   ";/.test(SRC));
}

// =================================================================================================================
console.log('\n2. The compiler');
const res = compileOnMock();
{
  check_('vaults.arc compiles with no errors and no warnings (batch 3 mock runtime, v4)', res.errors.length === 0 && res.warnings.length === 0, errText(res) + ' ' + res.warnings.map((w) => w.message).join(' | '));
  if (res.errors.length) { console.log(`\nFAIL: arcade-m8-vaults (${passed} checks passed, ${failed + 1} failed)`); process.exit(1); }
  const u = res.usage;
  info(`link report: code ${u.code} B (strings ${u.data.strings}, tileset ${u.data.tileset}, sfx ${u.data.sfx}, HUD map ${u.data.map}), sprite frames ${u.frames} B, view: map source ${u.view.mapSource} B (1,024 expanded) + descriptor ${u.view.descriptor} B => ${u.total} of 16384 B game area (${u.free} spare); variables ${u.gameVars.used} of ${u.gameVars.available} B`);
  check_('the image fits the 16 KB game area with room to spare (at least 3 KB)', u.free >= 3072, `${u.free} bytes free of ${u.total + u.free}`);
  check_('16 sprite instances (the most there are), 6 assets of 8; the view is COLW 4; the header carries DIV_EXT | DIV_VIEW and the frame divisor 4 (15 a second)', u.codegen.instances === 16 && res.usage.view.colw === 4 && (res.memory[0x8004] & 0xC0) === 0xC0 && (res.memory[0x8004] & 0x3F) === 4);
  check_('game variables fit with room (GAME_VARS 2,048 bytes)', u.gameVars.used <= 2048 - 512, `${u.gameVars.used} B`);
  check_('requiredRuntime says the v4 runtime (VIEW3D, VIEW, SETWALL, WALL, COSA, SINA, FXMUL, SEEN, DEPTH)', (() => { const r = requiredRuntime(SRC, A); return r.version === 4 && ['VIEW3D', 'VIEW', 'SETWALL', 'WALL()', 'COSA()', 'SINA()', 'FXMUL()', 'SEEN()', 'DEPTH()'].every((w) => r.reasons.includes(w)); })());
  const rtJson = join(ROOT, 'arcade/build/v4/runtime.json');
  if (existsSync(rtJson)) {
    const rt = JSON.parse(readFileSync(rtJson, 'utf8')), img = new Uint8Array(readFileSync(join(dirname(rtJson), rt.image ?? 'runtime.bin')));
    const real = compile(SRC, { runtime: rt, image: img, assets: A });
    check_('it compiles against arcade/build/v4 (the real runtime build) with no errors and no warnings', real.errors.length === 0 && real.warnings.length === 0, errText(real) + ' ' + real.warnings.map((w) => w.message).join(' | '));
    if (real.errors.length === 0) info(`on the real runtime: code ${real.usage.code} B, ${real.usage.free} B free`);
  } else skip_('it compiles against arcade/build/v4', 'arcade/build/v4/runtime.json does not exist (node arcade/tools/build-runtime-v4.mjs)');
}

// =================================================================================================================
console.log('\n3. The WIN run on the reference interpreter');
const win = interpretVaults(WIN_N, winStick, { billboard: winBillboard });
{
  const tk = win.ticks, V = (t) => tk[t - 1].vars, last = V(WIN_N);
  const sts = tk.map((r) => r.vars.ST), seq = sts.filter((s, i) => i === 0 || s !== sts[i - 1]);
  check_(`the recorded input (${WIN_N} ticks = ${(WIN_N / 15).toFixed(0)} s at 15 a second) takes the game from the title to the treasure: the states go ${seq.join(' -> ')}`, seq.join() === '0,1,2');
  const first = (f) => { const i = tk.findIndex(f); return i < 0 ? -1 : i + 1; };
  const tLock = first((r) => r.vars.MSG === 2), tKey = first((r) => r.vars.KEYS === 1), tDoor = first((r) => r.vars.MSG === 3), tKill = first((r) => r.vars.KILLS >= 1), tWin = first((r) => r.vars.ST === 2);
  check_(`the locked door answers "THE DOOR IS LOCKED" (message 2, tick ${tLock}) BEFORE the key is taken (tick ${tKey}), and opens with it (message 3, tick ${tDoor})`, tLock > 0 && tKey > tLock && tDoor > tKey);
  const doorCell = (r) => r.wallRam[(DOOR[1] >> 8) * 32 + (DOOR[0] >> 8)];
  check_('the map array shows the door: wall type 4 from the start until the player opens it, then 0 (SETWALL), and the key is used up', doorCell(tk[0]) === 4 && doorCell(tk[tDoor - 2]) === 4 && doorCell(tk[tDoor - 1]) === 0 && tk[tDoor - 1].vars.KEYS === 0 && tk[tKey - 1].vars.KEYS === 1);
  check_(`a wraith is shot dead with the three shots of the run (tick ${tKill}: kills ${last.KILLS}, +100); the others are untouched`, tKill > 0 && last.KILLS === 1 && win.ticks.some((r) => r.arrays.EH.filter((h) => h === 0).length === 1));
  check_('the player is hurt on the way (health fell below 100: HIT of the marker and a wraith) and healed by a potion (health went up at some tick)', last.HP < 100 && tk.some((r, i) => i > 0 && r.vars.HP > tk[i - 1].vars.HP));
  check_(`the gems of the run were picked up: ${last.GEMS} (one in the west, two in the vault)`, last.GEMS === 3);
  check_(`the treasure ends the game at tick ${tWin}; score ${last.SCORE} = 50 per gem (${last.GEMS}) + 100 per wraith (${last.KILLS}) + 500 + the health left (${last.HP})`, tWin > 0 && last.SCORE === 50 * last.GEMS + 100 * last.KILLS + 500 + last.HP);
  const minHp = Math.min(...tk.map((r) => r.vars.HP));
  check_(`the run is survived (the lowest health was ${minHp}): the walk is the same whatever the wraiths do`, minHp > 0);
  // the hidden-input checks: sprites shown / hidden
  const spr = (r, i) => r.sprites[i].visible;
  check_('the instances show and hide as the game says: the key (instance 14) hidden after the pickup, a gem hidden, a potion hidden, the dead wraith hidden after its burst', spr(tk[tKey - 2], INST.kk) === 1 && spr(tk[tKey - 1], INST.kk) === 0 && tk.some((r) => r.sprites.slice(INST.gem, INST.gem + 5).some((s) => !s.visible)) && tk.some((r) => r.sprites.slice(INST.pot, INST.pot + 3).some((s) => !s.visible)) && tk.some((r) => r.sprites.slice(INST.wr, INST.wr + 5).some((s) => !s.visible)));
  // billboard coordinates are 8.8 world coordinates: all shown instances are inside the maze
  check_('every shown billboard stays inside the maze (x, y within 0 .. 8191) on every tick', tk.every((r) => r.sprites.every((s) => !s.visible || (s.x >= 0 && s.x < 8192 && s.y >= 0 && s.y < 8192))));
  // the wraiths never walk into a wall: their cell is empty on every tick
  check_('the wraiths and the player always stand in empty cells of the map (the wall tests work: nobody is inside a wall)', tk.every((r) => { const g = r.wallRam; const at = (x, y) => g[(y >> 8) * 32 + (x >> 8)]; return at(r.vars.PX, r.vars.PY) === 0 && [0, 1, 2, 3, 4].every((i) => r.arrays.EH[i] === 0 || at(r.arrays.EX[i], r.arrays.EY[i]) === 0); }));
  // the HUD stays in its strips: the cells of the window and of the bezel never change after the boot
  const base = win.init.cells, bad = new Set();
  const protectedCell = (x, y) => (x >= 7 && x <= 24 && y >= 5 && y <= 18);
  tk.forEach((r, t) => { for (let i = 0; i < 768; i++) if (protectedCell(i & 31, i >> 5) && r.cells[i] !== base[i]) bad.add(`${i & 31},${i >> 5}@${t + 1}`); });
  check_('the HUD stays outside the window: no cell of the window or of its bezel (columns 7..24, rows 5..18) ever changes during the run (prints, tiles and fills all land in the strips)', bad.size === 0, [...bad].slice(0, 5).join(' '));
  const ten = tk.findIndex((r) => r.cells[9 * 32 + 3] !== base[9 * 32 + 3]);
  check_('the HUD does change: the health number, the score, the gem row and the key icon were drawn during the run', ten >= 0 && tk.some((r) => r.cells[8 * 32 + 25] !== base[8 * 32 + 25]) && tk.some((r) => r.cells[13 * 32 + 25] !== base[13 * 32 + 25]) && tk.some((r) => r.cells[13 * 32 + 3] !== base[13 * 32 + 3]));
  info(`the win run: key at tick ${tKey}, door opened ${tDoor}, wraith killed ${tKill}, treasure ${tWin}; ${last.GEMS} gems, ${last.KILLS} kill, health ${last.HP}, score ${last.SCORE}`);
}

// =================================================================================================================
console.log('\n4. The LOSE run and a new game');
const lose = interpretVaults(LOSE_N, loseStick);
{
  const tk = lose.ticks;
  const sts = tk.map((r) => r.vars.ST), seq = sts.filter((s, i) => i === 0 || s !== sts[i - 1]);
  check_(`the states visited are title 0, playing 1, dead 3, title 0, playing 1 (${seq.join(' -> ')})`, seq.join() === '0,1,3,0,1');
  const g = tk.findIndex((r) => r.vars.ST === 3), second = tk.findIndex((r, i) => i > g && r.vars.ST === 1);
  check_(`standing among the wraiths costs ten hits (health ${tk[g].vars.HP} at game over, tick ${g + 1}); the new game (tick ${second + 1}) starts at 100 with score 0, no key, no gems`, tk[g].vars.HP === 0 && tk[second].vars.HP === 100 && tk[second].vars.SCORE === 0 && tk[second].vars.KEYS === 0 && tk[second].vars.GEMS === 0);
  const s2 = tk[second];
  check_('the new game is clean: the door is shut again, every wraith is asleep with 3 health at its post, every gem, potion, the key and the treasure is back (hidden until the player comes within 7 cells)', s2.wallRam[(DOOR[1] >> 8) * 32 + (DOOR[0] >> 8)] === 4 && s2.arrays.EH.every((h) => h === 3) && s2.arrays.EA.every((a) => a === 0) && s2.arrays.EX.every((x, i) => x === THINGS.E[i][0]) &&
    s2.arrays.GA.every((v) => v === 1) && s2.arrays.OA.every((v) => v === 1) && s2.vars.KA === 1 && s2.sprites.slice(1, 16).every((s) => s.visible === 0) && s2.vars.PX === THINGS.P[0][0] && s2.vars.PY === THINGS.P[0][1]);
  const idle = interpretVaults(500, (t) => (t === 15 ? 16 : 0));
  check_('standing still at the start does not win or lose: nothing reaches the player in the start hall in 500 ticks (the wraiths sleep until you come within six cells)', idle.ticks.every((r) => r.vars.ST === 1 || r.vars.ST === 0) && idle.ticks[499].vars.HP === 100);
  const pressed = interpretVaults(60, (t) => (t === 1 ? 16 : 0));
  check_('fire pressed at the very start (tick 1) does not start the game (the title waits for its text, ten ticks)', pressed.ticks.slice(0, 20).every((r) => r.vars.ST === 0));
}

// =================================================================================================================
console.log('\n5. The compiled game against the interpreter on the mock runtime');
const sample = (a, p) => a[Math.min(a.length - 1, Math.floor(a.length * p))];
for (const [name, n, stick, bb, want] of [['WIN run', WIN_N, winStick, winBillboard, win], ['LOSE run', LOSE_N, loseStick, undefined, lose]]) {
  const t0 = Date.now();
  const got = runOnMock(res, { ticks: n, stick, billboard: bb });
  let d = diffV4(got.init, want.init, 'after INIT');
  for (let t = 1; !d && t <= n; t++) d = diffV4(got.ticks[t - 1], want.ticks[t - 1], `after tick ${t}`);
  check_(`${name}: ${n} ticks, the compiled code's state equals the interpreter's tick by tick (variables, arrays, SPR_TAB entries, the map array, the pose)`, d === null, d ?? `${((Date.now() - t0) / 1000).toFixed(1)} s`);
  const ts = [...got.tstates].sort((a, b) => a - b);
  info(`${name} PROC FRAME on the mock (the runtime's routines are one instruction here): median ${fmt(sample(ts, 0.5))}, 95th ${fmt(sample(ts, 0.95))}, worst ${fmt(ts[ts.length - 1])} T-states`);
}
check_('coverage on the compiled run: the key was taken, the door opened (SETWALL changed the map), a wraith shot, damage taken, the treasure found, then a lost game and a new one (the two runs together visit every state)',
  win.ticks.some((r) => r.vars.KEYS === 1) && new Set(win.ticks.map((r) => r.wallRam.join(''))).size >= 2 && win.ticks[WIN_N - 1].vars.KILLS === 1 && win.ticks[WIN_N - 1].vars.HP < 100 && win.ticks[WIN_N - 1].vars.ST === 2 && lose.ticks.some((r) => r.vars.ST === 3) && lose.ticks[LOSE_N - 1].vars.ST === 1);
{
  // random scripts: the compiled code and the interpreter agree for noise inputs too (turning, walking, fire in any order, from the title)
  const r = rng(8);
  let ok = true, detail = '';
  for (let k = 0; k < 4 && ok; k++) {
    const script = Array.from({ length: 300 }, (_, t) => (t < 15 ? 0 : t === 15 ? 16 : ((v) => ((v & 15) === 15 ? v & 23 : v))(Math.floor(r() * 32))));
    const stick = (t) => script[t - 1] ?? 0;
    const bb = (t, i) => ((t * 7 + i * 3) % 5 === 0 || i > 5 ? undefined : { depth: 100 + ((t * 37 + i * 91) % 2400), col: (t * 13 + i * 29) % 128 });
    const want = interpretVaults(300, stick, { billboard: bb }), got = runOnMock(res, { ticks: 300, stick, billboard: bb });
    let d = diffV4(got.init, want.init, 'init');
    for (let t = 1; !d && t <= 300; t++) d = diffV4(got.ticks[t - 1], want.ticks[t - 1], `random script ${k} tick ${t}`);
    if (d) { ok = false; detail = d; }
  }
  check_('4 random input scripts of 300 ticks (random stick bits except the all-directions pattern the runtime reads as no joystick, random sightings of the wraiths): the compiled code equals the interpreter tick by tick', ok, detail);
}

// =================================================================================================================
console.log('\n6. The compiled game on the real runtime v4');
const contact = (v) => (~((v & 15) | (v & 16 ? 0x80 : 0))) & 0xFF;
function loadRuntime(dir) {
  const json = join(resolve(ROOT, dir), 'runtime.json');
  if (!existsSync(json)) return null;
  const rt = JSON.parse(readFileSync(json, 'utf8'));
  return { rt, img: new Uint8Array(readFileSync(join(dirname(json), rt.image ?? 'runtime.bin'))), dir };
}
/** Boot the cartridge, run until PROC FRAME has been entered ticks + 1 times; one snapshot at each entry. */
function runReal(R, built, { ticks, stick }) {
  const SYM = { ...R.rt.symbols, ...(R.rt.constants ?? {}) };
  const m = M_.createMachine(new Uint8Array(9).fill(0x1F), new Uint8Array(2).fill(0xFF));
  const must = (e) => { if (e) throw new Error(e); };
  const ROMDIR = join(ROOT, 'tsrun/roms');
  must(M_.setHomeRom(m, readFileSync(join(ROMDIR, 'ts2068-0.rom'))));
  must(M_.setExRom(m, readFileSync(join(ROMDIR, 'ts2068-1.rom'))));
  must(M_.insertDock(m, built.dck));
  M_.resetMachine(m);
  const rd16 = (a) => m.ram[a] | (m.ram[a + 1] << 8);
  const s16 = (v) => ((v & 0xFFFF) ^ 0x8000) - 0x8000;
  const ent = SYM.SPR_ENT ?? 8, bbEnt = SYM.BB_ENT ?? 4;
  const snap = () => ({
    vars: Object.fromEntries(Object.entries(built.map.vars).map(([k, a]) => [k, s16(rd16(a))])),
    arrays: Object.fromEntries(Object.entries(built.map.arrays ?? {}).map(([k, { addr, n }]) => [k, Array.from({ length: n + 1 }, (_, i) => s16(rd16(addr + 2 * i)))])),
    sprites: Array.from({ length: 16 }, (_, i) => { const e = SYM.SPR_TAB + ent * i; return { visible: m.ram[e], asset: m.ram[e + 1], x: s16(rd16(e + 2)), y: s16(rd16(e + 4)), frame: m.ram[e + 6] }; }),
    wallRam: m.ram.slice(SYM.WORLD_RAM, SYM.WORLD_RAM + 1024),
    pose: SYM.V_POSE !== undefined ? { x: rd16(SYM.V_POSE), y: rd16(SYM.V_POSE + 2), a: m.ram[SYM.V_POSE + 4] } : null,
    bb: Array.from({ length: 16 }, (_, i) => ({ depth: rd16(SYM.BB_TAB + bbEnt * i), col: rd16(SYM.BB_TAB + bbEnt * i + 2) })),
  });
  const out = { snaps: [], error: null };
  for (let f = 0; f < 400 && rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE; f++) M_.runFrame(m);
  if (rd16(SYM.HO_MARK) !== SYM.HO_MARK_VALUE) { out.error = 'the runtime did not boot'; return out; }
  const fe = built.map.entries.frame;
  const setInput = (k) => { const sv = stick(k); m.joystick[0] = contact(sv); m.joystick[1] = contact(0); for (let r = 0; r < 8; r++) m.keyMatrix[r] = 0x1F; };
  setInput(1);
  const origRead = m.bus.read;
  m.bus.read = function (a) {
    if (a === fe && out.snaps.length < ticks + 1 && m.cpu.pc === fe) { out.snaps.push(snap()); setInput(out.snaps.length); }
    return origRead.call(this, a);
  };
  const div = built.memory[0x8004] & 0x3F;
  for (let f = 0; f < 400 + (ticks + 3) * div * 6 && out.snaps.length < ticks + 1; f++) M_.runFrame(m);
  if (out.snaps.length < ticks + 1) out.error = `only ${out.snaps.length} of ${ticks + 1} samples`;
  return out;
}
{
  const R = loadRuntime('arcade/build/v4');
  const needs = ['RT_VIEW', 'RT_COSA', 'RT_SINA', 'RT_FXMUL', 'RT_WALL', 'RT_SETWALL', 'RT_SHOWF', 'BB_TAB'];
  const missing = R ? needs.filter((n) => R.rt.symbols[n] === undefined && R.rt.constants?.[n] === undefined) : needs;
  if (!R || missing.length) skip_('the WIN and LOSE runs on the real runtime', !R ? 'arcade/build/v4/runtime.json does not exist' : `arcade/build/v4/runtime.json lacks ${missing.join(' ')}`);
  else {
    const built = compile(SRC, { runtime: R.rt, image: R.img, assets: A });
    if (built.errors.length) check_('compile for the real runtime', false, errText(built));
    else for (const [name, n, stick] of [['WIN run', WIN_N, winStick], ['LOSE run', LOSE_N, loseStick]]) {
      const t0 = Date.now();
      const got = runReal(R, built, { ticks: n, stick });
      if (got.error) { check_(`${name} on the real runtime`, false, got.error); continue; }
      // the interpreter is fed the runtime's own BB_TAB (what the previous tick's draw left when PROC FRAME of tick t was entered)
      const billboard = (t, i) => { const b = got.snaps[t - 1]?.bb?.[i]; return b && b.col !== 0xFFFF ? { depth: b.depth, col: b.col } : undefined; };
      const want = interpretVaults(n, stick, { billboard });
      let d = diffV4(got.snaps[0], want.init, 'after INIT');
      for (let t = 1; !d && t <= n; t++) d = diffV4(got.snaps[t], want.ticks[t - 1], `after tick ${t}`);
      const f = want.ticks[n - 1].vars;
      check_(`${name}: ${n} ticks on the real runtime equal to the interpreter (variables, arrays, SPR_TAB, the map array${R.rt.symbols.V_POSE !== undefined ? ', the pose' : ''}; SEEN / DEPTH fed the runtime's BB_TAB)`, d === null, d ?? `${((Date.now() - t0) / 1000).toFixed(1)} s; ended in state ${f.ST}, kills ${f.KILLS}, health ${f.HP}`);
    }
  }
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: arcade-m8-vaults (${passed} checks passed, ${failed} failed, ${skipped} skipped)`);
process.exit(failed === 0 ? 0 : 1);
