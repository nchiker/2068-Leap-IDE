#!/usr/bin/env node
"use strict";
// fine-scenario-make.mjs -- (re)generate arcade/tools/xemu/<game>-fine-scenario.json, the input of the fine-game cross-emulator check (Starfall = shooter, Lumen = lumen).
//   node arcade/tools/xemu/fine-scenario-make.mjs shooter|lumen [MAXT]
// The run is worked out CLOSED-LOOP once on TSRun (a pilot reads the game's variables from the machine's RAM at every tick, as orbit-scenario-make.mjs does); what it chose (one stick value per
// FRAME call) is written out and every emulator then plays exactly that list open loop (a game is deterministic given its input per tick), so the pilot's use of TSRun's memory does not matter
// to the comparison.  Both runs tell the same story (every scene of both games is fine colour):
//   1. the title (a few ticks of the song and the graded text), FIRE enters the play scene
//   2. play, phase 1: the pilot plays the game properly (Starfall: it steers under the nearest enemy and holds fire, so bullets, kills and explosions happen, with a few moves up and down;
//      Lumen: breadth-first search of the maze to the nearest orb or prism, around the shades, to the pale shades after a prism), up to P1 play ticks
//   3. play, phase 2: it throws the game away (Starfall: it flies into the enemies; Lumen: it walks into the nearest shade) until the lives are gone: the GAME OVER scene
//   4. GAME OVER, FIRE once it is allowed (fire released and 20 ticks), the title or play again (a second game: the scene's variables are reset) and a few ticks of it
// The sample ticks (the state bytes are compared byte by byte at them, on top of every tick's picture): the first ticks, the ticks around every scene change and around the first of
// each event (a kill, a life lost, an orb eaten, a prism, a pale shade eaten), then every 40th tick and the last.
import { writeFileSync } from 'node:fs';
import { GAMES, gameArg, scenarioFile, readMeta } from './fine-games.mjs';
import { STICK } from './fine-tsrun.mjs';

const g = gameArg();
const MAXT = Number(process.argv.slice(2).find((a) => /^\d+$/.test(a)) ?? 1500);
const rle = (a) => { const r = []; for (const v of a) { if (r.length && r.at(-1)[0] === v) r.at(-1)[1]++; else r.push([v, 1]); } return r; };
// the TSRun module reads the scenario at run time only: write a placeholder first (a run needs it to exist for fine-tsrun.mjs's CLI, not for the library)
writeFileSync(scenarioFile(g), JSON.stringify({ runs: [[0, MAXT]], sample_ticks: [], last_tick: MAXT }));
const T = await import('./fine-tsrun.mjs');
const meta = readMeta(g);
const m = T.newMachine(new URL(`../../build/${g}.dck`, import.meta.url).pathname);
const rd = (a) => T.sgn(m.ram[a] | (m.ram[a + 1] << 8));
const V = (n) => rd(meta.vars[n]);
const A = (n, i) => rd(meta.arrays[n].addr + 2 * i);
const scene = () => m.ram[meta.sceneAddr];
const U = STICK;

// ---- Starfall ------------------------------------------------------------------------------------------------------------------------------
const P1_SHOOTER = 160;
function pilotShooter(ctx) {
  const { pt, phase } = ctx;
  let sv = 0;
  const px = V('PX'), py = V('PY');
  // the enemy nearest the ship's row (largest y) that is on screen
  let best = -1;
  for (let j = 0; j < 3; j++) if (A('ES', j) === 1 && (best < 0 || A('EY', j) > A('EY', best))) best = j;
  if (phase === 1) {
    if (best >= 0) { const d = A('EX', best) - px; if (d > 3) sv |= U.RIGHT; else if (d < -3) sv |= U.LEFT; }
    else if (pt % 40 < 20) sv |= pt % 80 < 40 ? U.RIGHT : U.LEFT;
    sv |= U.FIRE;
    if (pt >= 30 && pt < 36) sv |= U.UP; else if (pt >= 70 && pt < 74) sv |= U.DOWN;
  } else if (best >= 0) {                                 // phase 2: into the nearest enemy
    const dx = A('EX', best) - px, dy = A('EY', best) - py;
    if (dx > 3) sv |= U.RIGHT; else if (dx < -3) sv |= U.LEFT;
    if (dy < -3) sv |= U.UP; else if (dy > 3) sv |= U.DOWN;
  } else sv |= U.UP;
  return sv;
}

// ---- Lumen ---------------------------------------------------------------------------------------------------------------------------------
const P1_LUMEN = 260;
const DX = [0, 0, -1, 1], DY = [-1, 1, 0, 0];             // directions 0 up, 1 down, 2 left, 3 right (the STICK bits 1, 2, 4, 8)
let lumenDir = -1;
function pilotLumen(ctx) {
  const { phase } = ctx;
  const wx = V('WX'), wy = V('WY');
  if ((wx & 15) !== 0 || (wy & 15) !== 8) return lumenDir >= 0 ? 1 << lumenDir : 0;      // between two blocks: keep asking for the direction chosen
  const bx = wx >> 4, by = (wy - 8) >> 4;
  const mz = (b) => A('MZ', b);
  const open = (x, y) => x >= 0 && x < 16 && y >= 0 && y < 11 && mz(y * 16 + x) === 0;
  const tileOf = (x, y) => m.ram[T.C.CELL_TILE + (1 + 2 * y) * 32 + 2 * x] & 127;   // the cell map holds tile + 128
  const shades = [];
  for (let i = 0; i < 4; i++) { const st = A('PST', i); if (st > 0) shades.push({ i, st, x: (A('SX', i) + 8) >> 4, y: (A('SY', i) - 8 + 8) >> 4 }); }
  const bad = (x, y) => shades.some((s) => s.st === 1 && Math.abs(s.x - x) + Math.abs(s.y - y) <= 3);
  const bfs = (isGoal, avoid) => {
    const prev = new Map([[by * 16 + bx, -1]]);
    const q = [[bx, by, -1]];
    while (q.length) {
      const [x, y, first] = q.shift();
      if ((x !== bx || y !== by) && isGoal(x, y)) return first;
      for (let d = 0; d < 4; d++) {
        const nx = x + DX[d], ny = y + DY[d];
        if (!open(nx, ny) || prev.has(ny * 16 + nx)) continue;
        if (avoid && bad(nx, ny)) continue;
        prev.set(ny * 16 + nx, 1);
        q.push([nx, ny, first < 0 ? d : first]);
      }
    }
    return -1;
  };
  let d = -1;
  if (phase === 2) {
    // into the nearest shade (unpale)
    d = bfs((x, y) => shades.some((s) => s.st === 1 && s.x === x && s.y === y), false);
  } else {
    if (V('PW') > 40) d = bfs((x, y) => shades.some((s) => s.st === 2 && s.x === x && s.y === y), true);    // hunt the pale ones while it lasts
    if (d < 0) d = bfs((x, y) => { const t = tileOf(x, y); return t === 1 || t === 5; }, true);
    if (d < 0) {
      // every way to an orb passes a shade: run from them (the open neighbour farthest from the nearest unpale shade; the same direction if it ties)
      const near = (x, y) => Math.min(99, ...shades.filter((s) => s.st === 1).map((s) => Math.abs(s.x - x) + Math.abs(s.y - y)));
      let bestD = -1;
      for (let k = 0; k < 4; k++) { const nx = bx + DX[k], ny = by + DY[k]; if (!open(nx, ny)) continue; const sc = near(nx, ny) * 4 + (k === lumenDir ? 1 : 0); if (sc > bestD) { bestD = sc; d = k; } }
    }
  }
  if (d >= 0) lumenDir = d;
  return lumenDir >= 0 ? 1 << lumenDir : 0;
}

// ---- the loop ------------------------------------------------------------------------------------------------------------------------------
const PILOT = { shooter: [pilotShooter, P1_SHOOTER], lumen: [pilotLumen, P1_LUMEN] }[g];
const TAIL = 40;                                           // ticks of the second game
const out = [];
const feed = (t) => T.applyInput(m, 'keys', out[t] ?? 0);
const log = [];
let playTicks = 0, lastScene = -1, stage = 'game1', overTicks = 0, titleTicks = 0, playStart2 = -1, overAt = -1, againAt = -1, enterAt = -1, game2PlayTicks = 0, fireHold = 0;
const events = [];                                          // {t, what}
const prev = {};

class Done extends Error {}
feed(0);
try {
  T.run(m, {
    lastTick: MAXT + 50,
    onTick(mm, t) {
      const sc = scene();
      const lives = V('PLAY.LIVES');
      const L = { t, sc, score: V('SCORE'), lives };
      log[t] = L;
      // events worth a sampled tick
      if (prev.sc !== undefined) {
        if (L.sc !== prev.sc) events.push({ t, what: `scene ${prev.sc}->${L.sc}` });
        if (L.sc === 1 && prev.sc === 1) {
          if (L.lives < prev.lives && L.lives >= 0) events.push({ t, what: `life lost (${L.lives} left)` });
          if (L.score > prev.score) { if (!events.some((e) => e.what === 'first score')) events.push({ t, what: 'first score' }); else if (L.score - prev.score >= 50 && !events.some((e) => e.what === 'big score')) events.push({ t, what: 'big score' }); }
        }
      }
      Object.assign(prev, L);
      let sv = 0;
      if (stage === 'game1' && sc === 0) {                                     // the title
        titleTicks++;
        sv = titleTicks >= 10 && titleTicks < 12 ? U.FIRE : 0;
      } else if (sc === 1 && (stage === 'game1')) {
        if (lastScene !== 1) { playTicks = 0; lumenDir = -1; if (enterAt < 0) enterAt = t; }
        playTicks++;
        const phase = playTicks > PILOT[1] ? 2 : 1;
        sv = PILOT[0]({ pt: playTicks, phase });
      } else if (sc === 2) {
        if (overAt < 0) overAt = t;
        overTicks++;
        stage = 'over';
        // fire has to be released first, and 20 ticks pass: hold FIRE for 2 ticks from tick 24 of the scene on
        sv = overTicks >= 24 && overTicks < 26 ? U.FIRE : 0;
        if (overTicks >= 24) stage = 'again';
      } else if (stage === 'again' && sc === 2) {
        sv = 0;
      } else if (stage === 'again' && sc !== 2) {
        // back from GAME OVER: the first scene of a game (Starfall and Lumen enter the play scene from the over scene) or the title
        if (againAt < 0) againAt = t;
        if (sc === 1) { if (game2PlayTicks === 0) { playStart2 = t; lumenDir = -1; } game2PlayTicks++; sv = PILOT[0]({ pt: game2PlayTicks, phase: 1 }); if (game2PlayTicks >= TAIL) { out[t] = sv; throw new Done(); } }
        else { titleTicks = 0; sv = 0; stage = 'title2'; }
      } else if (stage === 'title2') {
        titleTicks++;
        sv = titleTicks >= 6 && titleTicks < 8 ? U.FIRE : 0;
        if (sc === 1) { stage = 'again'; game2PlayTicks = 0; lastScene = sc; out[t] = sv; feed(t); return; }
      }
      lastScene = sc;
      out[t] = sv;
      feed(t);
      if (t >= MAXT) throw new Error(`the run did not reach the end by tick ${MAXT} (scene ${sc}, stage ${stage}, lives ${lives}, score ${L.score})`);
    },
  });
} catch (e) { if (!(e instanceof Done)) throw e; }
const lastTick = out.length - 1;
for (let i = 0; i < out.length; i++) out[i] ??= 0;
const ev = new Set([1, 2, 3, 5, 10, 12, 13, 20, 25]);
const names = [];
for (const e of events) { names.push(`${e.what}@${e.t}`); for (const d of [-1, 0, 1, 2]) ev.add(e.t + d); }
for (let t = 40; t <= lastTick; t += 40) ev.add(t);
ev.add(lastTick);
const samples = [...ev].filter((t) => t >= 1 && t <= lastTick).sort((a, b) => a - b);
const scenesSeen = [...new Set(log.filter(Boolean).map((l) => l.sc))];
console.error(`${GAMES[g].name}: ${lastTick + 1} ticks (index 0..${lastTick}); scenes seen ${scenesSeen.join(',')}; game over at tick ${overAt}, back at ${againAt}; ${samples.length} sampled ticks; events: ${names.join(' ')}`);
writeFileSync(scenarioFile(g), JSON.stringify({ comment: `Generated by fine-scenario-make.mjs (${GAMES[g].name}). runs: the stick value of every FRAME call, [value, ticks]; joystick 1 bits 1 up, 2 down, 4 left, 8 right, 16 fire (played as the keys Q A O P SPACE).`, events: names, runs: rle(out), sample_ticks: samples, last_tick: lastTick }, null, 1));
