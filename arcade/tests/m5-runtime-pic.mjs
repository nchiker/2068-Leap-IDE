"use strict";
// m5-runtime-pic.mjs -- M5 runtime test, part 2: the tile operations inside the frame loop, on a stock TS2068, compared with the model after every refresh.
//  1. A random mix of FILL / FILLC / COPY / LOADMAP / LOADMAPAT / TILE / PRINT every tick over 12 moving sprite instances, at frame_div 1, 2 and 3: the
//     picture shown (display file bytes, attributes, the colours the frame buffer shows) equals cells + sprites of the model after EVERY refresh; no write
//     to the file on show; ticks in order; flips right.
//  2. Boot with a map table: the first map appears (the dirty bits left by the boot's LOADMAP are enough: both files draw it).
//  3. The overrun: a FILL / COPY / LOADMAP of the whole screen in every tick (about 100,000 T of work in a 58,688 T refresh): no tearing, the last complete
//     picture stays on screen, the picture after every refresh equals the model of the file shown, no frame lost.
//  4. BORDER and RANDOMISE inside a running game: RT_RND values equal the model, V_BORDER follows.
//   node arcade/tests/m5-runtime-pic.mjs
import * as C from './m5-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { FRAME_T, hex, makeChecks, rd8, rd16, op } = C;

const { check, finish } = makeChecks();
const S = C.rt().syms;
console.log('M5 runtime: the tile operations in the frame loop, picture equality after every refresh\n');

const tiles = randomTiles(rng(21), 7);
const randMap = (r, w, h) => ({ w, h, cells: Array.from({ length: w * h }, () => (r.chance(0.6) ? 0x80 | r.int(0, 6) : r.int(32, 126))) });
const sprites = (r, n = 12) => {
  const assets = [C.C.randomAsset(r, 16, 16, 8), C.C.randomAsset(r, 8, 8, 4), C.C.randomAsset(r, 16, 10, 2)];
  return { assets, insts: Array.from({ length: n }, (_, i) => i % 3) };
};
const addSprites = (script, r, n) => {
  const pos = Array.from({ length: n }, () => ({ x: r.int(0, 230), y: r.int(0, 170), dx: r.int(-5, 5), dy: r.int(-4, 4) }));
  script.forEach((t) => pos.forEach((p, i) => { p.x += p.dx; p.y += p.dy; if (p.x < 0 || p.x > 235) p.dx = -p.dx; if (p.y < 0 || p.y > 172) p.dy = -p.dy; t.push(r.chance(0.04) ? op.hide(i) : op.show(i, Math.max(0, p.x), Math.max(0, p.y))); }));
};
const report = (label, st, extra = true) => {
  check(`${label}: the picture equals the model after every refresh (${st.pictureOk} refreshes, memory and colours)`, st.pictureBad === 0 && st.pixelBad === 0 && st.pictureOk >= st.frames - 2, JSON.stringify(st.firstBad) + ` pixelBad ${st.pixelBad}`);
  check(`${label}: nothing is written to the displayed file, the flips and the frame counter are right, ticks are in order, the canary is intact`,
    st.writeViolations === 0 && st.flipMismatch === 0 && st.missed === 0 && st.shadowBad === 0 && st.canary === 0x5AA5 && st.ticksSeen.every((n, i) => n === i),
    `${st.writeViolations} writes, ${st.flipMismatch} flip mismatches, ${st.missed} missed, canary ${hex(st.canary)}`);
  void extra;
};

// ---- 1. random mixes -----------------------------------------------------------------------------------------------------
console.log('1. Random tile operations every tick over moving sprites');
for (const [div, seed, nticks] of [[1, 31, 100], [2, 32, 90], [3, 33, 70]]) {
  const r = rng(seed);
  const maps = [randMap(r, 32, 24), randMap(r, 14, 9), randMap(r, 24, 16), randMap(r, 3, 3)];
  const { assets, insts } = sprites(r, 6);
  const script = Array.from({ length: nticks }, () => C.randomTileOps(r, { maps: 4, tiles: 7, size: div === 1 ? 'small' : 'mixed' }));
  addSprites(script, r, 6);
  const game = C.opsGame({ div, tiles, maps, assets, insts, script });
  const st = C.observe5(game, nticks * div + 4, { script });
  report(`frame_div ${div}, ${nticks} ticks of random operations + 6 sprites`, st);
}

// ---- 2. boot with a map table --------------------------------------------------------------------------------------------------
console.log('\n2. A map table at boot');
{
  const r = rng(41);
  const maps = [randMap(r, 32, 24), randMap(r, 20, 20)];
  const game = C.opsGame({ div: 2, tiles, maps, assets: [], insts: [], script: [[], [], [op.loadmapat(1, 5, 3)], [], [op.loadmap(0)], [], [op.fill(0, 0, 32, 24, 3)], [], [op.loadmap(1)]] });
  const st = C.observe5(game, 40, { script: [[], [], [op.loadmapat(1, 5, 3)], [], [op.loadmap(0)], [], [op.fill(0, 0, 32, 24, 3)], [], [op.loadmap(1)]] });
  report('map 0 loaded at boot, then LOADMAPAT / LOADMAP / FILL of the whole screen', st);
  const got = C.cellsOf(st.m, S);
  check('...and the final cell map equals the model\'s', got.tile.join() === st.model.tile.join() && got.attr.join() === st.model.attr.join());
}

// ---- 3. the overrun ---------------------------------------------------------------------------------------------------------------
console.log('\n3. Whole-screen operations every tick (the work exceeds a refresh)');
{
  const r = rng(51);
  const maps = [randMap(r, 32, 24), randMap(r, 32, 24)];
  const { assets, insts } = sprites(r);
  const script = Array.from({ length: 60 }, (_, k) => {
    const ops = [];
    const kind = k % 5;
    if (kind === 0) ops.push(op.fill(0, 0, 32, 24, 1 + (k % 6)));
    else if (kind === 1) ops.push(op.loadmap(k % 2));
    else if (kind === 2) ops.push(op.fillc(0, 0, 32, 24, 33 + (k % 90)));
    else if (kind === 3) ops.push(op.fill(0, 0, 32, 24, k % 7), op.copy(0, 0, 32, 23, 0, 1), op.copy(1, 0, 31, 24, 0, 0));
    else ops.push(op.copy(0, 1, 32, 23, 0, 0), op.fillc(-5, -5, 100, 100, 65 + (k % 20)));
    return ops;
  });
  addSprites(script, r, 12);
  const game = C.opsGame({ div: 1, tiles, maps, assets, insts, script });
  const st = C.observe5(game, 420, { script });
  const worst = Math.max(...st.work);
  console.log(`  (tick work: max ${worst} T = ${(worst / FRAME_T).toFixed(2)} refreshes, median ${st.work.slice().sort((a, b) => a - b)[st.work.length >> 1]} T)`);
  check('the whole-screen operations really overrun the refresh (the case is exercised)', worst > 1.3 * FRAME_T, `${worst} T`);
  report('frame_div 1, whole-screen FILL / FILLC / COPY / LOADMAP every tick over 12 sprites', st);
  check('...the interrupt skipped its flip while the main loop was busy (SYNC_BUSY) and still nothing tore', st.skippedFlips > 0, `${st.skippedFlips} interrupts flipped nothing`);
}

// ---- 4. BORDER and RANDOMISE inside a game ----------------------------------------------------------------------------------------
console.log('\n4. BORDER and RANDOMISE inside a running game');
{
  const script = [[op.rnd(), op.rnd()], [op.randomise(1234), op.rnd(), op.rnd(), op.rnd()], [op.border(5)], [op.randomise(1234), op.rnd(), op.border(300)], [op.randomise(0x0000 + 0xACE1), op.rnd(), op.rnd()], [op.border(2)], []];
  const game = C.opsGame({ div: 1, tiles, script });
  const st = C.observe5(game, 16, { script });
  check('RT_RND values equal the model through RANDOMISE n (same seed twice: same sequence)', st.gameLog.length === st.modelLog.length && st.gameLog.join() === st.modelLog.join() && st.gameLog.length === 8, `${st.gameLog.join()} / ${st.modelLog.join()}`);
  check('V_BORDER follows (BORDER 2 last) and the picture is unaffected', rd8(st.m, S.V_BORDER) === 2 && st.pictureBad === 0);
  check('the border register of the machine shows colour 2', st.m.border === 2);
}

finish('M5 runtime frame loop');
void rd16;
