#!/usr/bin/env node
"use strict";
// arcade-m8-vaults-bot.mjs -- records the scripted play-throughs of arcade/examples/vaults.arc that tests/arcade-m8-vaults.mjs replays.
//   node tests/arcade-m8-vaults-bot.mjs            work the runs out on the reference interpreter and print them (run-length coded)
//   node tests/arcade-m8-vaults-bot.mjs --write    ... and write tests/arcade-m8-vaults-script.mjs
//
// The bot walks the maze with a small JAVASCRIPT MODEL of the player (the same arithmetic as vaults.arc's MOVEPLAYER, written from the model functions of arcade-m8-common.mjs:
// COSA / SINA from 4096 cos, FXMUL from BigInt products) and a breadth-first search on the maze's cells. The player's walk does not depend on the wraiths, so the run is worked
// out in advance; the interpreter then checks it (the model must end where the game does). Shots use SYNTHETIC sightings: the interpreter and the mock cannot draw, so the test
// feeds SEEN / DEPTH from a table (a wraith "in the sights" for a while), the way tests/arcade-m8-common.mjs does.
//   WIN run:  the title (fire on tick 17), the walk to the vault door, a bump against it without the key ("THE DOOR IS LOCKED"), the walk to the key (gems on the way), a wraith shot three
//             times (killed), the walk back, the door opens with the key, the treasure.
//   LOSE run: the walk to the south-east room, then standing still: the wraiths come, ten touches, game over, fire (title), fire again (a new game), a few steps.
// (Since the title became a scene of its own the title's first 17 ticks are the same ticks as before, the game starts in the tick of the fire (play's INIT) and its first tick is 18, so the
// two runs differ from the runs of the one-scene game only in the idle ticks of the old start-up (2 ticks after each fire), which are gone: tests/arcade-m8-vaults.mjs compares them with the old game.)
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cosModel, sinModel, fxmulModel } from './arcade-m8-common.mjs';
import { interpretVaults } from './arcade-m8-vaults-harness.mjs';
import { CELLS, THINGS, MAP_W, MAP_H } from '../arcade/examples/vaults.assets.gen.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
const UP = 1, DOWN = 2, LEFT = 4, RIGHT = 8, FIRE = 16;
export const SPD = 44, TURN = 6, RAD = 40;

// ── the model of the player (vaults.arc MOVEPLAYER) ──────────────────────────────────────────────────────────────────────────────
export function newModel(pa) { return { px: 640, py: 7296, pa, grid: Uint8Array.from(CELLS), keys: 0, hasKey: false }; }
const wall = (g, x, y) => (x < 0 || y < 0 || x >= 8192 || y >= 8192 ? 1 : g.grid[(y >> 8) * MAP_W + (x >> 8)]);
/** one tick of play (the game's fc = the tick number `t`; the stick bits `s`) */
export function step(g, t, s) {
  if (s & LEFT) g.pa -= TURN;
  if (s & RIGHT) g.pa += TURN;
  g.pa &= 255;
  const mv = ((s & UP) ? 1 : 0) - ((s & DOWN) ? 1 : 0);
  if (mv !== 0) {
    const c = cosModel(g.pa), sn = sinModel(g.pa);
    const nx = g.px + fxmulModel(c, SPD * mv);
    let f = nx > g.px ? nx + RAD : nx - RAD;
    if (wall(g, f, g.py - RAD) === 0 && wall(g, f, g.py + RAD) === 0) g.px = nx;
    const ny = g.py + fxmulModel(sn, SPD * mv);
    f = ny > g.py ? ny + RAD : ny - RAD;
    if (wall(g, g.px - RAD, f) === 0 && wall(g, g.px + RAD, f) === 0) g.py = ny;
    if (mv > 0 && (t & 1) === 0) {
      const qx = g.px + fxmulModel(c, 112), qy = g.py + fxmulModel(sn, 112);
      if (wall(g, qx, qy) === 4 && g.keys > 0) { g.grid[(qy >> 8) * MAP_W + (qx >> 8)] = 0; g.keys = 0; }
    }
  }
  // pickups the walk crosses (the key): the game's HIT of the marker (R = 32) and a 16-high sprite (R = 64): both axes closer than 96
  const [kx, ky] = THINGS.K[0];
  if (!g.hasKey && Math.abs(kx - g.px) < 96 && Math.abs(ky - g.py) < 96) { g.hasKey = true; g.keys = 1; }
}

// ── the planner ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const cellOf = (g) => [g.px >> 8, g.py >> 8];
const centre = ([cx, cy]) => [cx * 256 + 128, cy * 256 + 128];
function bfs(grid, from, to) {
  const prev = new Map(), key = ([x, y]) => y * MAP_W + x, q = [from];
  prev.set(key(from), null);
  while (q.length) {
    const c = q.shift();
    if (c[0] === to[0] && c[1] === to[1]) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = [c[0] + dx, c[1] + dy];
      if (n[0] < 0 || n[1] < 0 || n[0] >= MAP_W || n[1] >= MAP_H || grid[n[1] * MAP_W + n[0]] !== 0 || prev.has(key(n))) continue;
      prev.set(key(n), c); q.push(n);
    }
  }
  if (!prev.has(key(to))) throw new Error(`no path from ${from} to ${to}`);
  const path = []; for (let c = to; c; c = prev.get(key(c))) path.unshift(c);
  return path;
}
/** corner points of a cell path: the cells where the direction changes, and the last */
function corners(path) {
  const out = [];
  for (let i = 1; i < path.length; i++) {
    const d = [path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]], nd = i + 1 < path.length ? [path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]] : null;
    if (!nd || nd[0] !== d[0] || nd[1] !== d[1]) out.push(path[i]);
  }
  return out;
}
const heading = (dx, dy) => Math.round(Math.atan2(dy, dx) / (2 * Math.PI) * 256) & 255;
const angDiff = (a, b) => (((a - b + 128) & 255) + 256) % 256 - 128;

/** Worked out from the model `g` at tick t (the next tick to be played): the stick values that walk to cell `to`; the model is advanced. */
function walkTo(g, t, to, out, extra = () => 0) {
  for (const wp of corners(bfs(g.grid, cellOf(g), to))) {
    const [wx, wy] = centre(wp);
    for (let guard = 0; guard < 400; guard++) {
      const dx = wx - g.px, dy = wy - g.py;
      if (Math.hypot(dx, dy) < 50) break;
      const diff = angDiff(heading(dx, dy), g.pa);
      let s = Math.abs(diff) > 5 ? (diff > 0 ? RIGHT : LEFT) : UP;
      s |= extra(t);
      out.push(s); step(g, t, s); t++;
    }
  }
  return t;
}
/** face `deg256` (0 east, 64 south, 128 west, 192 north) */
function face(g, t, a, out) {
  while (Math.abs(angDiff(a, g.pa)) > 3) { const s = angDiff(a, g.pa) > 0 ? RIGHT : LEFT; out.push(s); step(g, t, s); t++; }
  return t;
}
const idle = (g, t, n, out, s = 0) => { for (let i = 0; i < n; i++) { out.push(s); step(g, t, s); t++; } return t; };

/** the title (SCENE title NOVIEW): nothing for 16 ticks, fire on tick 17, which enters play (its INIT runs in that tick); the game's first tick is 18, the tick it was before the title was
 *  a scene of its own (the counters FC and K3 run through the title, so the walk's timing is the same); returns {out, t, pa} with the pose angle the game starts with */
function title(out) {
  for (let i = 0; i < 16; i++) out.push(0);
  out.push(FIRE);
  const T0 = out.length + 1;
  const r = interpretVaults(T0 - 1, (t) => out[t - 1] ?? 0);
  return { t: T0, pa: r.ticks[T0 - 2].vars.PA };
}

export function winRun() {
  const out = [];
  const { t: T0, pa } = title(out);
  const g = newModel(pa);
  let t = T0;
  t = walkTo(g, t, [27, 6], out);               // to the foot of the vault door ...
  t = face(g, t, 192, out);                      // ... facing north,
  t = idle(g, t, 8, out, UP);                    // and bump into it without the key (the probe looks 112 units ahead on even ticks)
  t = idle(g, t, 12, out, 0);                    // read the message
  t = walkTo(g, t, [2, 1], out);                // to the key (the key room is behind the wraith in it)
  t = idle(g, t, 3, out, UP);
  const shots = [];                              // three shots at the wraith (the synthetic sighting window is [t0, t1] below)
  const t0 = t;
  for (let k = 0; k < 3; k++) { for (let i = 0; i < 7; i++) { out.push(i === 0 ? FIRE : 0); step(g, t, 0); t++; } shots.push(t0 + 7 * k); }
  t = walkTo(g, t, [3, 8], out);                // a gem in the key room's neighbour,
  t = walkTo(g, t, [3, 12], out);               // and a health potion (the wraiths have taken some health)
  t = walkTo(g, t, [27, 6], out);               // back to the door
  t = face(g, t, 192, out);
  t = idle(g, t, 12, out, UP);                   // the door opens (keys = 1), the player walks in
  t = walkTo(g, t, [25, 4], out);               // the two gems in the vault, then the treasure
  t = walkTo(g, t, [29, 4], out);
  t = walkTo(g, t, [27, 3], out);
  t = idle(g, t, 20, out, 0);
  return { out, sight: { instance: 1, from: t0, to: t0 + 21, col: 66, depth: 900 }, model: g, T0 };
}
export function loseRun() {
  const out = [];
  const { t: T0, pa } = title(out);
  const g = newModel(pa);
  let t = T0;
  t = walkTo(g, t, [23, 27], out);
  t = idle(g, t, 20, out, 0);
  const startWait = t;
  // stand still until the game is over (the interpreter says when: the wraiths walk up and touch him)
  let n = 0;
  for (;;) {
    const r = interpretVaults(out.length + n, (tt) => out[tt - 1] ?? 0);
    if (r.ticks[r.ticks.length - 1].vars.ST === 3) break;
    n += 10; if (n > 1500) throw new Error('the player did not die');
  }
  for (let i = 0; i < n; i++) out.push(0);
  void startWait;
  for (let i = 0; i < 24; i++) out.push(0);     // the end text goes up a line a tick; fire after tt > 20
  out.push(FIRE);                                // back to the title
  for (let i = 0; i < 14; i++) out.push(0);     // the title for a second
  out.push(FIRE);                                // a new game (play's INIT runs in this tick)
  for (let i = 0; i < 40; i++) out.push(UP | (i < 20 ? RIGHT : 0));
  return { out };
}
const rle = (a) => { const r = []; for (const v of a) { if (r.length && r[r.length - 1][0] === v) r[r.length - 1][1]++; else r.push([v, 1]); } return r; };

if (MAIN) {
  const w = winRun(), l = loseRun();
  const check = interpretVaults(w.out.length, (t) => w.out[t - 1] ?? 0);
  const last = check.ticks[w.out.length - 1].vars;
  console.log(`win run: ${w.out.length} ticks; the model ends at (${w.model.px}, ${w.model.py}), the game at (${last.PX}, ${last.PY}); st ${last.ST}, keys ${last.KEYS}, gems ${last.GEMS}, score ${last.SCORE}`);
  console.log(`lose run: ${l.out.length} ticks`);
  if (process.argv.includes('--write')) {
    const text = `"use strict";
// GENERATED by tests/arcade-m8-vaults-bot.mjs --write: the stick values (joystick 1: 1 up, 2 down, 4 left, 8 right, 16 fire) of two runs of arcade/examples/vaults.arc,
// run-length coded as [value, ticks]. Do not edit by hand.
export const WIN_RUNS = ${JSON.stringify(rle(w.out))};
export const WIN_SIGHT = ${JSON.stringify(w.sight)};
export const LOSE_RUNS = ${JSON.stringify(rle(l.out))};
`;
    writeFileSync(join(HERE, 'arcade-m8-vaults-script.mjs'), text);
    console.log('wrote tests/arcade-m8-vaults-script.mjs');
  }
}
