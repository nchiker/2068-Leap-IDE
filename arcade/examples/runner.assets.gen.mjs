#!/usr/bin/env node
"use strict";
// runner.assets.gen.mjs -- the three NEW levels, the title picture (rn_title, the 32 x 24 screen MAP of the game's `title` scene) and the level tables (TABLE lv1 .. lv4) of runner.arc ("Leap Runner", four levels), and runner.assets.json.
//   node arcade/examples/runner.assets.gen.mjs            writes runner.assets.json next to this file (deterministic)
//   node arcade/examples/runner.assets.gen.mjs --check            asserts the game's limits (see "the limits of runner.arc"); every other mode refuses to run when one is broken
//   node arcade/examples/runner.assets.gen.mjs --ascii    prints the title picture, then every level (rows 5..15) with its coins, enemies and checkpoints
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
import { pattern, song, describe } from './songs.mjs';

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
  L.coin = (c, r) => { if (c < 0 || c >= COLS || r < 5 || r > 13 || g[r][c] !== T.SKY) throw new Error(`coin (${c}, ${r}): not a free sky cell (it was tile ${g[r]?.[c]})`); put(c, r, T.COIN); L.coins.push([c, r]); };
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
  // denser: arcs over the pits, spikes and walls along the route (the limits, among them 14 coins in view, are checked by limitProblems)
  coin(30, 12); coin(31, 11); coin(32, 12);                  // over the first pit
  coin(39, 12); coins_(40, 41, 11); coin(42, 12);            // over the spikes at 40
  coins_(62, 63, 11);                                        // over the spikes at 62
  coin(67, 12); coin(70, 12);                                // the ends of the arc over the 4-wide pit (68-69 are up)
  coin(75, 11); coins_(76, 77, 10); coin(78, 11);            // over the two-high wall
  coin(97, 11); coin(98, 10); coin(99, 11);                  // over the last pit
  coin(113, 11); coins_(114, 115, 10); coin(116, 11);        // over the last wall
  [18, 36, 50, 65, 79, 108].forEach((c) => L.walker(c));
  L.flyer(28, 64); L.flyer(45, 56); L.flyer(74, 64); L.flyer(100, 56);
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
  // denser: arcs over the spikes and across the gaps between the islands, rows on the long grounds
  coins_(10, 11, 11);                                        // over the first spikes
  coin(27, 11); coin(28, 10); coin(29, 11);                  // first gap of pit one
  coins_(34, 36, 10);                                        // second gap
  coin(51, 12); coins_(52, 53, 11); coin(54, 12);            // over the spikes at 52
  coin(83, 11); coins_(84, 85, 10);                          // gaps of pit two
  coin(89, 10); coin(90, 10); coin(91, 11);
  coins_(108, 109, 11);                                      // over the spikes at 108
  coins_(115, 116, 10);                                      // over the wall
  [8, 49, 69, 80, 104, 119].forEach((c) => L.walker(c));      // 80: on the first island of pit two
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
  // denser: every pit has its arc, every spike row and wall a coin or two over it, and the islands carry rows (at most 14 coins in view: limitProblems)
  coin(18, 12); coin(19, 11); coin(20, 12);                  // over the first pit
  coin(27, 11);                                              // over the second pit
  coin(37, 12); coin(38, 11); coin(39, 12);                  // over the third pit
  coins_(71, 72, 11);                                        // over the spike pair
  coin(81, 11); coin(82, 10); coin(83, 11);                  // first gap of the long pit
  coin(89, 10); coin(90, 11);                                // second gap
  coins_(106, 107, 11);                                      // over the spikes at 106
  coins_(110, 111, 10);                                      // over the wall
  coins_(118, 119, 10);                                      // over the last wall
  coins_(120, 121, 13);                                      // after the last wall, before the flag
  coin(46, 12);                                              // before the step
  [15, 41, 49, 68, 98, 113].forEach((c) => L.walker(c));
  L.flyer(28, 64); L.flyer(47, 64); L.flyer(66, 72); L.flyer(85, 56); L.flyer(104, 72);   // 19 columns (152 px) apart: see the spawn limit
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

// ── the limits of runner.arc, checked for every level ──────────────────────────────────────────────────────────────────────────────
// Where each number comes from (all of it is in runner.arc):
//   coins 50, enemies 11     the arrays cxs..cys(49) / sx..whi(10) and cc(49) / sd(10) are sized to the largest level; every level's TABLE is padded to them, so
//                            up to 50 / 11 costs no cartridge or RAM bytes, and one more grows all four records and the arrays.
//   14 coins in view         SPINCOINS swaps the pickup tile of coin CF + (fc MOD 8) and of that + 8, so the 16 coins from the first one not left of the camera are
//                            reached; at most 14 coins are ever in the 192-px window (cxs < cam + 192, cxs + 8 > cam) and each is swapped once every 8 ticks.
//   coins per 128 px (CIX)   PICKUP starts at cix(px / 128) and walks the sorted list up to the coin right of the hero's box (px + 13): its worst walk (11 coins in
//                            level 1) is the cost the game was measured with, so no level may walk more.
//   6 enemy slots            en(5): walkers (whi <> 0) use the 4 slots 0..3 (sprites wk), bats (whi = 0) the 2 slots 4..5 (sprites fl). SPAWNER starts at most one
//                            entry a tick, in list order, when sx < cam + 216 and sx > cam - 48; with no free slot of its kind it waits (and with it every entry
//                            behind it, a bat blocking the walkers too).  A walker leaves its slot when x < cam - 48, a bat when x < cam - 80 (or when stomped).
//                            Entries that wait show up inside the view when they finally start: simulateSpawns() plays the SPAWNER and the walk of the enemies
//                            from the start and each checkpoint with the camera at 0.5 .. 2.5 px a tick (nobody stomps anything) and reports the worst such pop-in.
//   9 CIX entries, 4 RCF / RNX, 3 checkpoints, 128 px world: the array sizes.
export const LIMITS = { coins: 50, enemies: 11, view: 14, scan: 11, walkerSlots: 4, batSlots: 2, popIn: 32, minXGap: 16 };

/** Play runner.arc's SPAWNER / WALKER / BAT slot logic over a camera that moves right at `speed` px a tick from `startCam` (the respawn: entries from `nx0`).
 *  Returns, for every entry that was not in the first view (sx >= startCam + 192), how many pixels of it were inside the view when it started. */
export function simulateSpawns(t, startCam, nx0, speed, parity) {
  const en = new Array(6).fill(0), ex = new Array(6).fill(0), ed = new Array(6).fill(0), ek = new Array(6).fill(0), e0 = new Array(6).fill(0);
  let nx = nx0, fc = parity;
  const seen = [];
  for (let tick = 0; tick < 2500; tick++) {
    const cam = Math.min(832, Math.floor(startCam + speed * tick));
    fc++;
    if (nx < t.se && t.sx[nx] < cam + 216) {                                   // SPAWNER
      if (t.sx[nx] > cam - 48) {
        const b = t.whi[nx] === 0 ? 1 : 0, lo = b ? 4 : 0, hi = b ? 5 : 3;
        for (let k = lo; k <= hi; k++) if (!en[k]) {
          en[k] = 1; ex[k] = t.sx[nx]; ek[k] = nx; e0[k] = t.sx[nx]; ed[k] = -1 + b * 2;
          if (t.sx[nx] >= startCam + 192) seen.push({ k: nx, bat: b === 1, vis: Math.max(0, cam + 192 - t.sx[nx]) });
          nx++; break;
        }
      } else nx++;
    }
    if ((fc & 1) === 0) {                                                       // ENEMIES: walkers on even ticks
      for (let i = 0; i < 4; i++) if (en[i]) {
        const k = ek[i]; let x = ex[i] + ed[i] * 4, d = ed[i];
        if (x < cam - 48) en[i] = 0;
        else { if (x <= t.wlo[k]) { x = t.wlo[k]; d = 1; } else if (x >= t.whi[k]) { x = t.whi[k]; d = -1; } ed[i] = d; ex[i] = x; }
      }
    } else {                                                                    // bats on odd ticks
      for (let i = 4; i < 6; i++) if (en[i]) {
        const x = ex[i] + ed[i] * 4;
        if (x < cam - 80) en[i] = 0; else { if (Math.abs(x - e0[i]) > 56) ed[i] = -ed[i]; ex[i] = x; }
      }
    }
  }
  return seen;
}

/** Every limit above for every level, as {problems: [string], stats: [{...}]}.  The worlds' own rules (flag, start, checkpoints on ground, the walkers' turning points) are checked by tests/arcade-runner.mjs. */
export function checkLimits(levels = LEVELS, tables = levelTables()) {
  const problems = [], stats = [];
  levels.forEach((L, i) => {
    const t = tables[i], n = `level ${i + 1}`, bad = (m) => problems.push(`${n}: ${m}`);
    const standable = []; // [c, topRow]: a cell the hero can stand on (solid or a plank) with the cell above it free
    for (let c = 0; c < COLS; c++) for (let r = 6; r < ROWS; r++) if ((FLAGS[L.g[r][c]] & 9) && !(FLAGS[L.g[r - 1][c]] & 1)) standable.push([c, r]);
    if (t.ce > LIMITS.coins) bad(`${t.ce} coins, the arrays hold ${LIMITS.coins}`);
    if (t.se > LIMITS.enemies) bad(`${t.se} enemies, the arrays hold ${LIMITS.enemies}`);
    if (L.checkpoints.length !== 3 || t.cix.length !== 9 || t.rcf.length !== 4 || t.rnx.length !== 4) bad('CKX/CKY need 3 entries, CIX 9, RCF / RNX 4');
    if (!L.checkpoints.every(([x], j) => x > 24 && (j === 0 || x > L.checkpoints[j - 1][0]))) bad('the checkpoints must rise in x and the first lie right of the start (x 24)');
    if (!t.cix.every((v, j) => j === 0 || v >= t.cix[j - 1])) bad('CIX is not rising');
    // coins: sorted, distinct, on free sky cells (L.coin refuses anything else), reachable from a floor, at most 14 in view, short PICKUP walks
    for (let k = 1; k < t.ce; k++) if (t.cxs[k] < t.cxs[k - 1] || (t.cxs[k] === t.cxs[k - 1] && t.cys[k] <= t.cys[k - 1])) bad(`the coin list is not sorted / distinct at ${k}`);
    L.coins.forEach(([c, r]) => {
      if (!standable.some(([sc, st]) => Math.abs(sc - c) <= 4 && st - r >= 1 && st - r <= 6)) bad(`coin (${c}, ${r}) is out of reach: no floor within 4 columns and 6 rows under it`);
    });
    let view = 0, viewAt = 0;
    for (let cam = 0; cam <= 832; cam++) { const v = L.coins.filter(([c]) => c * 8 + 8 > cam && c * 8 < cam + 192).length; if (v > view) { view = v; viewAt = cam; } }
    if (view > LIMITS.view) bad(`${view} coins in view at camera ${viewAt} (at most ${LIMITS.view})`);
    let scan = 0;
    for (let px = 0; px < 1008; px++) { let w = 0; for (let k = t.cix[px >> 7]; k < t.ce; k++) { w++; if (t.cxs[k] >= px + 13) break; } scan = Math.max(scan, w); }
    if (scan > LIMITS.scan) bad(`PICKUP walks ${scan} coins at worst (at most ${LIMITS.scan})`);
    // enemies: sorted, apart, walkers' patrols disjoint, at most 4 walkers / 2 bats alive at once (static bound for walkers), bats at their heights, no pop-in beyond the limit
    for (let k = 1; k < t.se; k++) if (t.sx[k] - t.sx[k - 1] < LIMITS.minXGap) bad(`enemies ${k - 1} and ${k} are ${t.sx[k] - t.sx[k - 1]} px apart (at least ${LIMITS.minXGap})`);
    const walkers = [...Array(t.se).keys()].filter((k) => t.whi[k] !== 0);
    for (const a of walkers) for (const b of walkers) if (a < b && t.wlo[a] < t.whi[b] + 16 && t.wlo[b] < t.whi[a] + 16) bad(`the patrols of walkers ${a} and ${b} overlap`);
    let wMax = 0;
    for (let cam = 0; cam <= 832; cam++) wMax = Math.max(wMax, walkers.filter((k) => t.sx[k] < cam + 216 && t.whi[k] >= cam - 48).length);
    if (wMax > LIMITS.walkerSlots) bad(`${wMax} walkers can be alive together (${LIMITS.walkerSlots} slots)`);
    for (let k = 0; k < t.se; k++) if (t.whi[k] === 0 && (t.sy[k] < 56 || t.sy[k] > 72)) bad(`bat ${k} flies at y ${t.sy[k]} (56..72 is the range the levels use)`);
    let pop = 0, popWho = '';
    const starts = [[24, 0], ...L.checkpoints.map(([x], j) => [x, j + 1])];
    for (const [x, j] of starts) {
      const cam = Math.max(0, Math.min(832, x - 72));
      for (const sp of [0.5, 1, 1.5, 2, 2.5]) for (const par of [0, 1]) for (const e of simulateSpawns(t, cam, t.rnx[j], sp, par)) if (e.vis > pop) { pop = e.vis; popWho = `${e.bat ? 'bat' : 'walker'} ${e.k} from ${j ? 'checkpoint ' + j : 'the start'} at ${sp} px a tick`; }
    }
    if (pop > LIMITS.popIn) bad(`an enemy can start ${pop} px inside the view (${popWho}; at most ${LIMITS.popIn}): space the entries out or thin the bats`);
    stats.push({ coins: t.ce, enemies: t.se, view, scan, walkersAlive: wMax, popIn: pop });
  });
  return { problems, stats };
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

// ── the title picture (SCENE title NOWINDOW of runner.arc): a 32 x 24 screen MAP made of the game's own tiles ───────────────────────────────────────────────────
// "LEAP" and "RUNNER" in block letters of brick tiles (5 rows high, 3 cells wide, the N 4), a sky with clouds under the far band's mountains, the flag and the sign, ground (grass on row 19, dirt below) and
// two coins over each of the four hops the hero makes across the picture (the coins are at TITLE_COINS: the game's title scene takes them from that list, it spins them with TILE and the hero eats them).
// Rows 21 and 22 are the high score and PRESS SPACE OR FIRE, printed by the game over black bars.
export const TITLE_COLS = 32, TITLE_ROWS = 24;
export const TITLE_COINS = [[2, 14], [3, 14], [9, 14], [10, 14], [17, 14], [18, 14], [25, 14], [26, 14]];       // [column, row]
const GLYPHS = {
  L: ['X..', 'X..', 'X..', 'X..', 'XXX'], E: ['XXX', 'X..', 'XXX', 'X..', 'XXX'], A: ['.X.', 'X.X', 'XXX', 'X.X', 'X.X'], P: ['XXX', 'X.X', 'XXX', 'X..', 'X..'],
  R: ['XX.', 'X.X', 'XX.', 'X.X', 'X.X'], U: ['X.X', 'X.X', 'X.X', 'X.X', 'XXX'], N: ['X..X', 'XX.X', 'X.XX', 'X..X', 'X..X'],
};
export function titleMap() {
  const g = Array.from({ length: TITLE_ROWS }, () => new Array(TITLE_COLS).fill(T.SKY));
  const put = (c, r, t) => { if (c >= 0 && c < TITLE_COLS && r >= 0 && r < TITLE_ROWS) g[r][c] = t; };
  for (let c = 0; c < TITLE_COLS; c++) { put(c, 0, T.F_BLANK); put(c, 1, T.F_BLANK); }          // the far band, with its mountains (as the levels' rows 0 and 1)
  for (const [c, plateau] of [[0, 1], [7, 0], [13, 1], [21, 0], [26, 1]]) {
    const w = plateau ? 6 : 4;
    put(c, 1, T.F_UP); put(c + w - 1, 1, T.F_DOWN); for (let k = 1; k < w - 1; k++) put(c + k, 1, T.F_FILL);
    put(c + 1, 0, T.F_UP); put(c + w - 2, 0, T.F_DOWN); for (let k = 2; k < w - 2; k++) put(c + k, 0, T.F_FILL);
  }
  const word = (text, row) => {
    const width = [...text].reduce((w, ch) => w + GLYPHS[ch][0].length + 1, -1);
    let c0 = (TITLE_COLS - width) >> 1;
    for (const ch of text) { const gl = GLYPHS[ch]; gl.forEach((line, r) => [...line].forEach((x, k) => { if (x === 'X') put(c0 + k, row + r, T.BRICK); })); c0 += gl[0].length + 1; }
  };
  word('LEAP', 2); word('RUNNER', 8);
  for (const [c, r, w] of [[0, 3, 3], [29, 5, 3], [0, 7, 2], [29, 7, 3]]) { put(c, r, T.CLOUD_L); for (let k = 1; k < w - 1; k++) put(c + k, r, T.CLOUD_M); put(c + w - 1, r, T.CLOUD_R); }
  for (let c = 0; c < TITLE_COLS; c++) { put(c, 19, T.GRASS); for (let r = 20; r < TITLE_ROWS; r++) put(c, r, T.DIRT); }
  put(30, 14, T.FLAG); for (let r = 15; r <= 18; r++) put(30, r, T.POLE);
  put(1, 18, T.SIGN);
  for (const [c, r] of TITLE_COINS) put(c, r, T.COIN);
  return g;
}

// ── music: "Hop", the title song (docs/ARCADE_MUSIC_CONTRACT.md section 8; original music).  C major, a quaver = 8 refreshes, bars of 64: a bouncy
// tune on A and a bass on B, both organ (a held organ note changes the chip twice, so the song is small: the game area is nearly full), C left free.
// Two four-bar patterns, the call and the answer, looped; it plays in the title and the attract mode (the demo) and stops when a game starts.
export const MUSIC = {
  rn_hop: song([
    pattern({ A: '@organ !11 L8 | C5 E5 G5 E5 C6:16 G5:16 | A5 G5 F5 E5 D5:32 | B4 D5 G5 F5 E5:16 D5:16 | C5:48 -:16',
      B: '@organ !10 L32 | C3 G2 | F2 G2 | G2 B2 | C3:48 -:16' }, 'call'),
    pattern({ A: '@organ !11 L8 | E5 G5 C6 G5 E5:16 C5:16 | F5 A5 G5 F5 E5:32 | D5 F5 E5 D5 C5:16 B4:16 | C5:48 -:16',
      B: '@organ !10 L32 | C3 E3 | F2 C3 | G2:64 | C3:48 -:16' }, 'answer'),
  ], [0, 1], 0),
};

export function buildRunnerAssets() {
  const a = JSON.parse(JSON.stringify(BASE));
  a.maps = {};
  a.maps.rn_title = { w: TITLE_COLS, h: TITLE_ROWS, cells: titleMap().flat() };
  LEVELS.forEach((L, i) => {
    const cells = [];
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) cells.push(L.g[r][c]);
    a.maps[i === 0 ? 'pf_world' : `rn_world${i + 1}`] = { w: COLS, h: ROWS, cells };
  });
  a.music = JSON.parse(JSON.stringify(MUSIC));
  return a;
}

if (MAIN) {
  const lim = checkLimits();
  if (process.argv.includes('--check')) {
    // the title picture: no cloud touches a letter (8 neighbours), every letter is drawn whole, and the two R of RUNNER are the same cells
    { const g = titleMap(); let touch = 0, ok = true;
      for (let r = 0; r < TITLE_ROWS; r++) for (let c = 0; c < TITLE_COLS; c++) if (g[r][c] >= T.CLOUD_L && g[r][c] <= T.CLOUD_R) for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (g[r + dr]?.[c + dc] === T.BRICK) touch++;
      for (let r = 0; r < 5; r++) for (let c = 0; c < 3; c++) if (g[8 + r][3 + c] !== g[8 + r][25 + c]) ok = false;
      for (const [ch, c0, r0] of [['L', 8, 2], ['E', 12, 2], ['A', 16, 2], ['P', 20, 2], ['R', 3, 8], ['U', 7, 8], ['N', 11, 8], ['N', 16, 8], ['E', 21, 8], ['R', 25, 8]])
        GLYPHS[ch].forEach((line, r) => [...line].forEach((x, k) => { if ((g[r0 + r][c0 + k] === T.BRICK) !== (x === 'X')) ok = false; }));
      console.log(touch === 0 && ok ? 'title picture: no cloud touches a letter, every letter whole, the two R equal' : `title picture BROKEN: ${touch} cloud cells touch a letter, letters ${ok ? 'whole' : 'damaged or the two R differ'}`);
      if (touch || !ok) process.exit(1); }
    lim.stats.forEach((x, i) => console.log(`level ${i + 1}: ${x.coins} coins (${x.view} at most in view, PICKUP walk ${x.scan}), ${x.enemies} enemies (${x.walkersAlive} walkers alive at most, pop-in up to ${x.popIn} px)`));
    console.log(lim.problems.length ? lim.problems.join('\n') : 'all limits hold');
    process.exit(lim.problems.length ? 1 : 0);
  }
  if (lim.problems.length) { console.error('runner levels break the game\'s limits:\n  ' + lim.problems.join('\n  ')); process.exit(1); }
  if (process.argv.includes('--ascii')) {
    { const ch = { [T.SKY]: ' ', [T.GRASS]: 'G', [T.DIRT]: 'd', [T.BRICK]: 'B', [T.COIN]: 'o', [T.POLE]: '|', [T.FLAG]: 'F', [T.SIGN]: 'S' }; console.log('-- the title picture (rn_title, 32 x 24)'); titleMap().forEach((r, i) => console.log(String(i).padStart(2) + ' ' + r.map((t) => ch[t] ?? (t >= 15 && t <= 17 ? '~' : '.')).join(''))); }
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
  console.log(`runner.assets.json: ${Object.keys(assets.sprites).length} sprites, ${Object.keys(assets.sfx).length} sound effects, ${Object.keys(assets.maps).length - 1} worlds and the title picture (${LEVELS.map((L) => `${L.coins.length} coins ${L.spawns.length} enemies`).join('; ')}); ${Object.entries(assets.music).map(([k, v]) => describe(k, v)).join('; ')}`);
}
