#!/usr/bin/env node
"use strict";
// runner.assets.gen.mjs -- the three NEW levels and the level tables (TABLE lv1 .. lv4) of runner.arc ("Leap Runner", four levels), and runner.assets.json.
//   node arcade/examples/runner.assets.gen.mjs            writes runner.assets.json next to this file (deterministic)
//   node arcade/examples/runner.assets.gen.mjs --ascii    prints every level (rows 5..15) with its coins, enemies and checkpoints
//   node arcade/examples/runner.assets.gen.mjs --data     prints the DIM and TABLE lv1 .. lv4 lines of the level data that runner.arc carries (level-relative lists)
//   node arcade/examples/runner.assets.gen.mjs --splice   writes those lines into runner.arc between its @@DATA-BEGIN@@ and @@DATA-END@@ markers
//
// Level 1 is the platformer's own (platformer.assets.gen.mjs, imported, never copied); levels 2 to 4 are laid out here with the same tileset, the same
// 128 x 16 shape (rows 0-1 mountains, 2-4 clouds, 5-15 the gameplay band: ground in rows 14-15), the same start (x 24, on the ground) and the same
// flag at column 122.  The hero's reach (platformer.md): a full jump rises 36 px (4.5 tiles) and covers about 42 px; the layouts keep to what level 1
// already asks (pits at most 4 cells, gaps between islands at most 3, steps and platforms at most 3 up, walls 2 high, spikes 2 wide) and get
// denser, not harder in kind:  2 "Ridge" (hills, small pits, spikes, floating platforms), 3 "Islands" (two long pits crossed by islands and planks,
// more bats), 4 "Gauntlet" (narrow ground, spike rows, walls, the most enemies).
// Every level: 3 checkpoints on ground at the height of the start (hero y = 88), the player's start (24, 88), and a coin list, a spawn list (sorted by x)
// and the walkers' turning points worked out from the map, exactly as platformer.assets.gen.mjs --data does for level 1.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildAssets, LEVEL as LEVEL1, T } from './platformer.assets.gen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
export const COLS = 128, ROWS = 16;
const BASE = buildAssets();
const FLAGS = BASE.tilesets.pf_tiles.tiles.map((t) => t.flags);

/** A level under construction: a 128 x 16 grid with the backdrop, and the helpers of platformer.assets.gen.mjs. */
function make(mountains, clouds) {
  const g = Array.from({ length: ROWS }, () => new Array(COLS).fill(T.SKY));
  const put = (c, r, t) => { if (c >= 0 && c < COLS && r >= 0 && r < ROWS) g[r][c] = t; };
  for (let c = 0; c < COLS; c++) { put(c, 0, T.F_BLANK); put(c, 1, T.F_BLANK); for (let r = 2; r <= 4; r++) put(c, r, T.M_BLANK); }
  for (const [c, plateau] of mountains) {
    const w = plateau ? 6 : 4;
    put(c, 1, T.F_UP); put(c + w - 1, 1, T.F_DOWN); for (let k = 1; k < w - 1; k++) put(c + k, 1, T.F_FILL);
    put(c + 1, 0, T.F_UP); put(c + w - 2, 0, T.F_DOWN); for (let k = 2; k < w - 2; k++) put(c + k, 0, T.F_FILL);
  }
  for (const [c, r, w] of clouds) { put(c, r, T.CLOUD_L); for (let k = 1; k < w - 1; k++) put(c + k, r, T.CLOUD_M); put(c + w - 1, r, T.CLOUD_R); }
  const L = { g, coins: [], spawns: [], checkpoints: [], put };
  L.ground = (c0, c1, top) => { for (let c = c0; c <= c1; c++) { put(c, top, T.GRASS); for (let r = top + 1; r < ROWS; r++) put(c, r, T.DIRT); } };
  L.run = (c0, c1, r, t) => { for (let c = c0; c <= c1; c++) put(c, r, t); };
  L.coin = (c, r) => { put(c, r, T.COIN); L.coins.push([c, r]); };
  L.coins_ = (c0, c1, r) => { for (let c = c0; c <= c1; c++) L.coin(c, r); };
  const top = (c) => { for (let r = 5; r < ROWS; r++) if (g[r][c] === T.GRASS || g[r][c] === T.BRICK) return r; return 16; };
  L.walker = (c) => L.spawns.push([c * 8, top(c) * 8 - 16, 0]);
  L.flyer = (c, y) => L.spawns.push([c * 8, y, 1]);
  L.flag = (c) => { put(c, 8, T.FLAG); for (let r = 9; r <= 13; r++) put(c, r, T.POLE); L.goalX = c * 8; };
  L.finish = () => {
    L.coins.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    L.spawns.sort((a, b) => a[0] - b[0]);
    L.start = [24, 88];
    return L;
  };
  return L;
}

// ── level 2: Ridge ───────────────────────────────────────────────────────────────────────────────────────────────────────────
function ridge() {
  const L = make([[3, 0], [9, 1], [18, 0], [27, 1], [35, 0], [44, 0], [49, 1]], [[3, 3, 4], [12, 2, 3], [21, 4, 3], [30, 2, 5], [41, 3, 3], [52, 2, 4], [64, 4, 3], [72, 2, 3], [80, 3, 4], [90, 2, 3], [99, 4, 5], [108, 2, 3], [117, 3, 4]]);
  const { ground, run, coin, coins_ } = L;
  ground(0, 29, 14);
  ground(33, 43, 14);                     // pit 30-32 (3 wide)
  ground(44, 47, 13);
  ground(48, 55, 12);                     // a hill
  ground(56, 59, 13);
  ground(60, 66, 14);
  ground(71, 84, 14);                     // pit 67-70 (4 wide)
  ground(85, 90, 13);
  ground(91, 96, 12);
  ground(100, 111, 14);                   // pit 97-99
  ground(112, 127, 14);
  L.put(4, 13, T.SIGN);
  run(20, 21, 13, T.SPIKES);
  run(40, 41, 13, T.SPIKES);
  run(62, 63, 13, T.SPIKES);
  run(105, 106, 13, T.SPIKES);
  run(46, 49, 9, T.PLANK);                // a plank platform over the first hill (a brick there would leave no room to jump: the hero is 22 px tall)
  run(52, 55, 9, T.PLANK);                // a plank over the hilltop
  run(76, 77, 12, T.BRICK); run(76, 77, 13, T.BRICK);          // a two-high wall
  run(102, 108, 11, T.PLANK);
  run(114, 115, 12, T.BRICK); run(114, 115, 13, T.BRICK);      // the last wall
  L.flag(122);
  coins_(8, 10, 13); coins_(15, 16, 11); coins_(35, 36, 12);
  coins_(47, 48, 8); coins_(53, 54, 8); coin(58, 11); coins_(68, 69, 11);
  coins_(80, 81, 12); coins_(87, 88, 11); coins_(93, 94, 10);
  coins_(103, 104, 10); coins_(118, 119, 13);
  [18, 36, 50, 79, 108].forEach((c) => L.walker(c));
  L.flyer(45, 56); L.flyer(74, 64); L.flyer(100, 56);
  L.checkpoints = [[38 * 8, 88], [73 * 8, 88], [103 * 8, 88]];
  return L.finish();
}

// ── level 3: Islands ─────────────────────────────────────────────────────────────────────────────────────────────────────────
function islands() {
  const L = make([[2, 1], [11, 0], [16, 0], [24, 1], [33, 0], [42, 1], [47, 0]], [[1, 2, 5], [10, 4, 3], [19, 3, 4], [27, 2, 3], [35, 4, 4], [44, 2, 5], [55, 3, 3], [62, 2, 3], [70, 4, 4], [79, 2, 3], [88, 3, 5], [97, 2, 3], [106, 4, 3], [115, 3, 4]]);
  const { ground, run, coin, coins_ } = L;
  ground(0, 19, 14);                      // the start
  run(10, 11, 13, T.SPIKES);
  // pit one (20..45): stepping stones, gaps of 3, each at most 1 up
  run(23, 26, 13, T.BRICK);
  run(30, 33, 12, T.BRICK);
  run(37, 40, 12, T.PLANK);
  run(43, 45, 13, T.BRICK);
  ground(46, 63, 14);
  run(52, 53, 13, T.SPIKES);
  ground(64, 67, 13);
  ground(68, 71, 12);
  ground(72, 75, 13);
  // pit two (76..101): islands with gaps of 3 and 2, bats over it
  run(79, 82, 12, T.BRICK);
  run(86, 88, 11, T.PLANK);
  run(92, 95, 12, T.BRICK);
  run(98, 100, 13, T.BRICK);
  ground(102, 127, 14);
  run(108, 109, 13, T.SPIKES);
  run(112, 113, 13, T.SPIKES);
  run(115, 116, 12, T.BRICK); run(115, 116, 13, T.BRICK);
  L.put(4, 13, T.SIGN);
  L.flag(122);
  coins_(6, 8, 13); coins_(13, 14, 11);
  coins_(24, 25, 12); coins_(31, 32, 11); coins_(38, 39, 11);
  coins_(65, 66, 12); coin(70, 11);
  coins_(80, 81, 11); coins_(93, 94, 11);
  coins_(105, 106, 13); coins_(118, 119, 13);
  [8, 49, 69, 104, 119].forEach((c) => L.walker(c));
  L.flyer(28, 56); L.flyer(60, 56); L.flyer(84, 64); L.flyer(110, 64);
  L.checkpoints = [[48 * 8, 88], [66 * 8, 80], [104 * 8, 88]];
  return L.finish();
}

// ── level 4: Gauntlet ────────────────────────────────────────────────────────────────────────────────────────────────────────
function gauntlet() {
  const L = make([[4, 0], [10, 1], [20, 0], [29, 1], [38, 0], [45, 0], [49, 1]], [[5, 2, 3], [14, 4, 4], [23, 2, 3], [33, 3, 5], [43, 2, 3], [51, 4, 4], [60, 2, 3], [69, 3, 4], [78, 2, 5], [88, 4, 3], [97, 2, 3], [105, 3, 4], [114, 2, 3]]);
  const { ground, run, coin, coins_ } = L;
  ground(0, 17, 14);
  run(12, 13, 13, T.SPIKES);
  ground(21, 25, 14);                     // pit 18-20: strips between pits of 3
  ground(29, 36, 14);                     // pit 26-28
  run(32, 33, 13, T.SPIKES);
  run(31, 34, 11, T.PLANK);               // a way over the spikes
  ground(40, 47, 14);                     // pit 37-39
  run(43, 44, 12, T.BRICK); run(43, 44, 13, T.BRICK);        // a wall
  ground(48, 51, 12);                     // a step up of two
  ground(52, 55, 14);
  run(57, 60, 11, T.BRICK);               // an island in the pit 56-62
  ground(63, 65, 13);
  ground(66, 69, 12);
  ground(70, 73, 14);
  run(71, 72, 13, T.SPIKES);
  run(77, 80, 13, T.BRICK);               // islands in the pit 74-96
  run(84, 87, 12, T.PLANK);
  run(91, 94, 12, T.BRICK);
  ground(97, 102, 14);
  run(99, 100, 13, T.SPIKES);
  ground(103, 127, 14);
  run(106, 107, 13, T.SPIKES);
  run(110, 111, 12, T.BRICK); run(110, 111, 13, T.BRICK);
  run(114, 115, 13, T.SPIKES);
  run(118, 119, 12, T.BRICK); run(118, 119, 13, T.BRICK);
  L.put(4, 13, T.SIGN);
  L.flag(122);
  coins_(6, 8, 13); coin(11, 12); coin(12, 11); coin(13, 11); coin(14, 12);
  coins_(23, 24, 13); coins_(32, 33, 10);
  coins_(43, 44, 11); coins_(49, 50, 11);
  coins_(58, 59, 10); coins_(64, 65, 12);
  coins_(78, 79, 12); coins_(85, 86, 11); coins_(92, 93, 11); coins_(97, 98, 13);
  [15, 41, 49, 68, 98].forEach((c) => L.walker(c));
  L.flyer(28, 64); L.flyer(58, 64); L.flyer(79, 72); L.flyer(89, 56); L.flyer(108, 72);
  L.checkpoints = [[41 * 8, 88], [64 * 8, 80], [104 * 8, 88]];
  return L.finish();
}

export const LEVELS = [LEVEL1, ridge(), islands(), gauntlet()];
export const NAMES = ['Meadow', 'Ridge', 'Islands', 'Gauntlet'];

// ── the level tables (level-relative: every list of a level starts at 0, one TABLE a level) ─────────────────────────────────────────
/** The walkers' turning points, from the map: the first x (8 px steps) where the cell in front is solid at its body or has no floor under it. */
export function turning(level, spawn, dir) {
  const grid = level.g, flagsOf = (t) => FLAGS[t];
  const cellAt = (x, y) => (x < 0 || x >= COLS * 8 ? 1 : y < 0 ? 1 : y >= 128 ? 0 : flagsOf(grid[y >> 3][x >> 3]));
  const blocked = (x, y, d) => { const ax = d > 0 ? x + 16 : x - 1; return !!(cellAt(ax, y + 4) & 1 || cellAt(ax, y + 11) & 1 || !(cellAt(ax, y + 16) & 9)); };
  let x = spawn[0];
  while (!blocked(x, spawn[1], dir)) x += 8 * dir;
  return x;
}
/** One entry per level: its lists indexed from 0 (cxs cys: coins; sx sy wlo whi: enemies; ckx cky: checkpoints; cix: per 128 px, the first coin not left of x = 128 b;
 *  rcf rnx: at a respawn at the start and at each checkpoint, the first coin not left of the camera and the first enemy not left of camera - 48) and the counts ce, se. */
export function levelTables() {
  return LEVELS.map((L) => {
    const t = { cxs: [], cys: [], sx: [], sy: [], wlo: [], whi: [], ckx: [], cky: [], cix: [], rcf: [], rnx: [] };
    L.coins.forEach(([c, r]) => { t.cxs.push(c * 8); t.cys.push(r * 8); });
    L.spawns.forEach((s) => { t.sx.push(s[0]); t.sy.push(s[1]); t.wlo.push(s[2] === 0 ? turning(L, s, -1) : 0); t.whi.push(s[2] === 0 ? turning(L, s, 1) : 0); });
    L.checkpoints.forEach(([x, y]) => { t.ckx.push(x); t.cky.push(y); });
    for (let b = 0; b < 9; b++) { const k = L.coins.findIndex(([c]) => c * 8 + 8 > 128 * b); t.cix.push(k < 0 ? L.coins.length : k); }
    for (const x of [24, ...L.checkpoints.map((c) => c[0])]) {
      const cam = Math.max(0, Math.min(832, x - 72));
      t.rcf.push(L.coins.findIndex(([c]) => c * 8 + 8 > cam));
      t.rnx.push(L.spawns.findIndex(([sx]) => sx >= cam - 48));
    }
    t.ce = L.coins.length; t.se = L.spawns.length;
    return t;
  });
}

/** The scene declarations of runner.arc's level data, between its @@DATA-BEGIN@@ and @@DATA-END@@ markers: the DIMs (sized to the largest level) and TABLE lv1 .. lv4. */
export function dataLines() {
  const ts = levelTables();
  const out = [];
  const big = (k) => Math.max(...ts.map((t) => t[k].length)) - 1;
  const names = ['cxs', 'cys', 'sx', 'sy', 'wlo', 'whi', 'ckx', 'cky', 'cix', 'rcf', 'rnx'];
  out.push(`  DIM ${names.map((k) => `${k}(${big(k)})`).join(', ')}, ce, se`);
  out.push(`  DIM cc(${big('cxs')}), sd(${big('sx')})`);
  ts.forEach((t, i) => {
    out.push(`  TABLE lv${i + 1}`);
    for (const k of names) out.push(`    ${k} = ${t[k].join(', ')}`);
    out.push(`    ce = ${t.ce}`, `    se = ${t.se}`, '  ENDTABLE');
  });
  out.push(`  REM coins per level ${LEVELS.map((L) => L.coins.length).join(' ')}; enemies per level ${LEVELS.map((L) => L.spawns.length).join(' ')}`);
  return out.join('\n') + '\n';
}

export function buildRunnerAssets() {
  const a = JSON.parse(JSON.stringify(BASE));
  a.maps = {};
  LEVELS.forEach((L, i) => {
    const cells = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) cells.push(L.g[r][c]);
    a.maps[i === 0 ? 'pf_world' : `rn_world${i + 1}`] = { w: COLS, h: ROWS, cells };
  });
  return a;
}

if (MAIN) {
  if (process.argv.includes('--ascii')) {
    const ch = { [T.SKY]: ' ', [T.GRASS]: 'G', [T.DIRT]: 'd', [T.BRICK]: 'B', [T.PLANK]: '=', [T.SPIKES]: '^', [T.COIN]: 'o', [T.POLE]: '|', [T.FLAG]: 'F', [T.SIGN]: 'S' };
    LEVELS.forEach((L, i) => {
      console.log(`-- level ${i + 1} ${NAMES[i]}: ${L.coins.length} coins, ${L.spawns.length} enemies (${L.spawns.filter((s) => s[2] === 0).length} walkers, ${L.spawns.filter((s) => s[2] === 1).length} bats)`);
      const rows = L.g.map((r) => r.map((t) => ch[t] ?? '?'));
      for (const s of L.spawns) { const c = s[0] >> 3, r = s[1] >> 3; if (rows[r] && rows[r][c] === ' ') rows[r][c] = s[2] === 0 ? 'W' : 'V'; }
      for (const [x, y] of L.checkpoints) { const c = x >> 3, r = (y >> 3) + 2; if (rows[r] && rows[r][c] === ' ') rows[r][c] = 'K'; }
      for (let r = 5; r < ROWS; r++) console.log(String(r).padStart(2) + ' ' + rows[r].join(''));
      console.log('   ' + Array.from({ length: COLS }, (_, c) => (c % 10 === 0 ? String(c / 10 % 10) : ' ')).join(''));
    });
    process.exit(0);
  }
  if (process.argv.includes('--data')) {
    process.stdout.write(dataLines());
    process.exit(0);
  }
  if (process.argv.includes('--splice')) {          // rewrite the data block of runner.arc in place
    const f = join(HERE, 'runner.arc'), src = readFileSync(f, 'utf8');
    const a = src.indexOf('  REM @@DATA-BEGIN@@\n') + '  REM @@DATA-BEGIN@@\n'.length, b = src.indexOf('  REM @@DATA-END@@');
    if (a < 30 || b < a) throw new Error('runner.arc has no @@DATA-BEGIN@@ / @@DATA-END@@ markers');
    writeFileSync(f, src.slice(0, a) + dataLines() + src.slice(b));
    console.log('runner.arc: level data rewritten');
    process.exit(0);
  }
  const assets = buildRunnerAssets();
  writeFileSync(join(HERE, 'runner.assets.json'), JSON.stringify(assets, null, 1) + '\n');
  console.log(`runner.assets.json: ${Object.keys(assets.sprites).length} sprites, ${Object.keys(assets.sfx).length} sound effects, ${Object.keys(assets.maps).length} worlds (${LEVELS.map((L) => `${L.coins.length} coins ${L.spawns.length} enemies`).join('; ')})`);
}
