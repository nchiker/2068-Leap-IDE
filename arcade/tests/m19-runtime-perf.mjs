"use strict";
// m19-runtime-perf.mjs -- Leap Arcade fine colour, slice F2: what the fine tick costs and what the viewer sees (docs/ARCADE_FINE_COLOUR_CONTRACT.md
// sections 3, 5.4, 8), on TSRun.  Every figure is measured here (T-states between the labels of fine.asm, one instruction at a time).
//  1. compose + publish per moving 16x16 sprite (8 phases, unaligned; 1 phase, byte aligned) and per moving 8x8 sprite, per dirty cell, publish
//     per changed group; RT_FINEMODE ON and OFF (T and refreshes).
//  2. Starfall-like ticks (a sky of tiles with 8 row colours, a HUD whose counter changes every tick, 8, 10, 12, 16 moving sprites of 16x16 and 8x8):
//     compose + publish per tick (median, 95th percentile, worst) and the part of a 20 Hz tick (3 refreshes) it leaves for FRAME.
//  3. the beam: every frame TSRun paints, classified (arcade/spike/fine/fine-check.mjs) against the fine pictures before and after the update in
//     flight: clean / torn / broken (split writes apart), on the 16-sprite and the 8-sprite scene.  Targets (section 3a): broken 0, torn 0.
//   node arcade/tests/m19-runtime-perf.mjs        (M19_QUICK=1: shorter beam runs)
import * as T from './m19-common.mjs';
import { frameKeys, classifyFrame, tally } from '../spike/fine/fine-check.mjs';
const { S, K, FRAME_T, FIRST_PIXEL_T, makeChecks, rd16, rng, fineGame, run, randomAsset, randomInks, randomFineTiles, fmt } = T;

const QUICK = !!process.env.M19_QUICK;
const { check, finish } = makeChecks();
console.log('M19 fine colour: costs and the beam (TSRun)\n');
const R = rng(1919);
const TILES = randomFineTiles(R, 12);
const MAP = Array.from({ length: 768 }, (_, i) => (i < 32 ? 32 : 128 + (((i >> 5) * 5 + (i & 31) * 3) % 12)));
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };
const med = (a) => pct(a, 0.5);
const HUD = (k) => [{ op: 'at', row: 0, col: 1 }, { op: 'ink', a: 6 }, { op: 'prints', s: 'SCORE ' + String(k * 10).padStart(5, '0') }];

/** A scene of moving instances: spec { assets, insts, steps: [[dx, dy]] per instance, hud, L, div }. */
function moving({ assets, insts, step, hud = false, L = 40, div = 1, seed = 1 }) {
  const Q = rng(seed);
  const pos = insts.map(() => ({ x: Q.int(8, 220), y: Q.int(10, 160), dx: step[0] * (Q.chance(0.5) ? 1 : -1), dy: step[1] * (Q.chance(0.5) ? 1 : -1) }));
  const ticks = [];
  for (let k = 0; k < L; k++) {
    const t = hud ? HUD(k) : [];
    pos.forEach((p, i) => {
      p.x += p.dx; p.y += p.dy;
      if (p.x < 0 || p.x > 239) { p.dx = -p.dx; p.x += 2 * p.dx; }
      if (p.y < 8 || p.y > 176) { p.dy = -p.dy; p.y += 2 * p.dy; }
      t.push({ op: 'show', i, x: p.x, y: p.y });
    });
    ticks.push(t);
  }
  return fineGame({ div, assets, insts, tiles: TILES, map: MAP, initMode: 1, ticks, wrap: true });
}
/** compose + publish per tick (after a few ticks), the list length per publish. */
function cost(game, frames, skip = 4) {
  const lens = [];
  const st = run(game, frames, { onStep: (m) => { if (m.cpu.pc === S.FINE_WORK) lens.push((K.F_LTOP - 2 - rd16(m, S.F_LIST)) / 4); } });
  const n = Math.min(st.comp.length, st.pub.length);
  const tick = [], comp = st.comp.slice(skip, n), pub = st.pub.slice(skip + 1, n + 1);
  for (let i = 0; i < Math.min(comp.length, pub.length); i++) tick.push(comp[i] + pub[i]);
  return { st, comp, pub, tick, groups: lens.slice(skip + 1), bad: st.pubBad + st.bufBad };
}

// ---- 1. unit costs ---------------------------------------------------------------------------------------------------------------------------
console.log('--- 1. costs ---');
const A16 = { ...randomAsset(R, 16, 16, 8), inks: randomInks(R) }, A16a = { ...randomAsset(R, 16, 16, 1), inks: randomInks(R) };
const A8 = { ...randomAsset(R, 8, 8, 8), inks: randomInks(R) };
const base = cost(moving({ assets: [A16], insts: [], step: [0, 0] }), 40);
const T0 = med(base.tick);
const per = {};
for (const [name, asset, step] of [['16x16, 8 phases, moving (2, 1)', A16, [2, 1]], ['16x16, 1 phase (byte aligned), moving (8, 1)', A16a, [8, 1]], ['8x8, 8 phases, moving (2, 1)', A8, [2, 1]]]) {
  const N = 8;
  const c = cost(moving({ assets: [asset], insts: Array(N).fill(0), step }), 110);
  per[name] = (med(c.tick) - T0) / N;
  check(`compose + publish per moving ${name}: ${fmt(per[name])} T (8 instances; publish ${fmt(med(c.pub) / N)} of it)`, c.bad === 0 && c.tick.length > 10, `tick median ${fmt(med(c.tick))}, empty tick ${fmt(T0)}`);
}
{ // dirty cells: 16 cells of text each tick, no sprite
  const ticks = Array.from({ length: 30 }, (_, k) => [{ op: 'at', row: 5 + (k % 10), col: 4 }, { op: 'ink', a: k & 7 }, { op: 'prints', s: String.fromCharCode(...Array.from({ length: 16 }, (_, j) => 65 + ((k + j) % 26))) }]);
  const c = cost(fineGame({ div: 1, assets: [A8], insts: [], tiles: TILES, map: MAP, initMode: 1, ticks }), 60);
  const perCell = (med(c.tick) - T0) / 16;
  const g = med(c.groups);
  check(`compose + publish per dirty cell: ${fmt(perCell)} T (16 text cells a tick; ${g} groups published a tick)`, c.bad === 0, '');
  const pubPer = med(c.pub) / Math.max(1, g);
  check(`publish per changed group: ${fmt(pubPer)} T (list of ${g} groups: ${fmt(med(c.pub))} T)`, pubPer < 70);
}
{ // ON / OFF
  const ticks = [[{ op: 'show', i: 0, x: 20, y: 20 }], [], [{ op: 'mode', a: 1 }], [], [], [{ op: 'mode', a: 0 }], [], []];
  let t0 = 0, f0 = 0;
  const sw = [];
  const st = run(fineGame({ div: 1, assets: [A16], insts: [0], tiles: TILES, map: MAP, ticks }), 80, { onStep: (m) => {
    if (m.cpu.pc === S.RT_FINEMODE) { t0 = m.tstates; f0 = rd16(m, S.V_FRAMES); }
    if (m.cpu.pc === T.GAME().syms['frame_entry.moded']) sw.push({ T: m.tstates - t0, refreshes: rd16(m, S.V_FRAMES) - f0 });
  } });
  check(`RT_FINEMODE ON: ${fmt(sw[0]?.T ?? 0)} T, ${sw[0]?.refreshes} refreshes; OFF: ${fmt(sw[1]?.T ?? 0)} T, ${sw[1]?.refreshes} refreshes (bound 30 refreshes)`, sw.length === 2 && sw.every((s) => s.refreshes <= 30) && st.pubBad + st.onBad + st.offBad === 0);
}

// ---- 2. Starfall-like ticks ---------------------------------------------------------------------------------------------------------------------
console.log('\n--- 2. Starfall-like ticks (a HUD counter, a tiled sky, 16x16 and 8x8 sprites moving every tick) ---');
const SHIP = { ...randomAsset(R, 16, 16, 8), inks: randomInks(R) }, ENEMY = { ...randomAsset(R, 16, 16, 8), inks: randomInks(R) }, HEAVY = { ...randomAsset(R, 16, 16, 8), inks: randomInks(R) };
const BULLET = { ...randomAsset(R, 8, 8, 8), inks: randomInks(R) };
const STAR_ASSETS = [SHIP, BULLET, ENEMY, HEAVY];                       // 32 phases
const mix = (n) => ({ 8: [0, 1, 1, 2, 2, 3, 3, 1], 10: [0, 1, 1, 1, 2, 2, 2, 3, 3, 1], 12: [0, 1, 1, 1, 1, 2, 2, 2, 3, 3, 1, 1], 16: [0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 1, 1, 1] })[n];
const BUDGET = 3 * FRAME_T;
const starRes = {};
for (const n of [8, 10, 12, 16]) {
  const c = cost(moving({ assets: STAR_ASSETS, insts: mix(n), step: [2, 2], hud: true, L: 64, seed: n }), 150);
  starRes[n] = c;
  const big = mix(n).filter((a) => a !== 1).length;
  check(`${n} sprites (${big} 16x16, ${n - big} 8x8): compose + publish median ${fmt(med(c.tick))}, p95 ${fmt(pct(c.tick, 0.95))}, worst ${fmt(Math.max(...c.tick))} T a tick; `
    + `a 20 Hz tick (${fmt(BUDGET)} T) leaves ${fmt(BUDGET - med(c.tick))} T for FRAME; publish median ${fmt(med(c.pub))} T, ${med(c.groups)} groups`, c.bad === 0);
}

// ---- 3. the beam ---------------------------------------------------------------------------------------------------------------------------------
console.log('\n--- 3. the beam: every painted frame against the pictures before and after the update in flight ---');
const PAINT_END = FIRST_PIXEL_T + 192 * 224;
/** Every frame painted after the first updates, classified once the update it may show (started before its last line) has finished. */
function beam(game, frames) {
  const starts = [], recs = [], pending = [], T1 = tally();
  let model = null, multi = 0;
  const settle = () => {
    while (pending.length) {
      const { F0, keys } = pending[0];
      let a = -1, b = -1;
      for (let i = 0; i < starts.length; i++) if (starts[i] < F0 + PAINT_END) b = i;
      if (b >= recs.length) return;                               // that update is still in flight
      for (let i = 0; i < recs.length; i++) if (recs[i].end < F0 + FIRST_PIXEL_T) a = i;
      pending.shift();
      if (a < 0 || b < a) continue;
      if (b > a + 1) multi++;
      T1.add(classifyFrame(keys, recs[a].pic, recs[b].pic, recs[a].sprites, recs[b].sprites, model.fassets));
    }
  };
  const st = run(game, frames, { video: true,
    onStep: (m) => { if (m.cpu.pc === S.FINE_WORK) starts.push(m.tstates); },
    onPublish: (s, rec) => { model = s.model; recs.push(rec); settle(); },
    onFrame: (m) => { if (recs.length >= 2) { pending.push({ F0: m.frameStart - FRAME_T, keys: frameKeys(m.pixels) }); settle(); } } });
  return { st, s: T1.summary(1000), multi };
}
for (const n of [16, 8]) {
  const game = moving({ assets: STAR_ASSETS, insts: mix(n), step: [2, 2], hud: true, L: 64, div: 3, seed: 100 + n });
  const frames = QUICK ? 300 : 1500;
  const { st, s, multi } = beam(game, frames);
  check(`${n} sprites at 20 Hz asked (frame_div 3), ${s.frames} frames: clean ${s.clean}, torn ${s.torn}, broken ${s.broken} (split-write only ${s.brokenSplitOnly}); torn per 100 frames median ${s.tornPer100.median}, worst ${s.tornPer100.worst}`,
    s.broken - s.brokenSplitOnly === 0 && s.frames > frames * 0.8 && st.pubBad === 0,
    `updates ${st.publishes}; publish median ${fmt(med(st.pub))} T, worst ${fmt(Math.max(...st.pub))}; overflow ticks ${rd16(st.m, S.F_NOVF)}; frames spanning two updates ${multi}; ${JSON.stringify(s.examples.slice(0, 2))}`);
}

finish('M19 fine colour costs and beam');
