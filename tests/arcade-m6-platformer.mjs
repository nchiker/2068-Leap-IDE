#!/usr/bin/env node
"use strict";
// arcade-m6-platformer.mjs -- tests for the acceptance game of the platformer slice, arcade/examples/platformer.arc ("Leap Runner"), docs/ARCADE_PLATFORMER_CONTRACT.md 8.1.
//
//   node tests/arcade-m6-platformer.mjs
//
//   1  assets: the json is exactly what platformer.assets.gen.mjs makes; the level data in the source equals the map (coins, enemy spawns, checkpoints stand on solid ground);
//      the art rules (one paper per band, passable gameplay tiles carry the sky's paper); sprite sizes and frame counts
//   2  the compiler: the game compiles on the batch 2 mock runtime; the link report (bytes of the 16 KB game area, phase memory, variables, instances)
//   3  PLAY-THROUGH on the reference interpreter: the recorded input (tests/arcade-m6-platformer-script.mjs, found by tests/arcade-m6-platformer-bot.mjs) walks from the title
//      to the flag: the level is completable with this game's physics; counts of coins, stomps, lives; and the same input with the jumps removed does NOT win
//   4  the game over run: three lives lost, GAME OVER, back to the title, a new game
//   5  DIFFERENTIAL on the mock: the compiled game's state equals the interpreter's tick by tick (variables, arrays, SPR_TAB entries, WORLD_RAM, V_CAM) for both runs; coverage
//      of the run (states, frames, FLIP, camera range, world changes); T-states of PROC FRAME on the mock (runtime routines are free there)
//   (the same runs go to the real runtime in tests/arcade-m6-differential.mjs through PROGRAMS in arcade-m6-common.mjs)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LEVEL, T, FLAG, buildAssets } from '../arcade/examples/platformer.assets.gen.mjs';
import { PLATFORMER_SRC, PLATFORMER_ASSETS, compileOnMock, runOnMock, interpretPlatformer, s16 } from './arcade-m6-platformer-harness.mjs';
import { WIN_STICK, WIN_LENGTH, TWICE_STICK, TWICE_LENGTH, OVER_STICK, OVER_LENGTH, stickFromRuns } from './arcade-m6-common.mjs';
import { RUNS } from './arcade-m6-platformer-script.mjs';
import { diffV3, ASSETS } from './arcade-m6-common.mjs';
import { existsSync } from 'node:fs';
import { planPool, poolNeed, normPhases } from '../arcade/tests/m6-common.mjs';
import { compile } from '../src/lang/arcade/arcade-compile.js';

const HERE = dirname(fileURLToPath(import.meta.url));
let passed = 0, failed = 0;
const check_ = (name, ok, detail = '') => { console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`); ok ? passed++ : failed++; return ok; };
const info = (s) => console.log('  INFO  ' + s);
const errText = (r) => r.errors.map((e) => `${e.line}:${e.col} ${e.message}`).join(' | ');

const A = PLATFORMER_ASSETS;
const cells = A.maps['pf_world'].cells, W = A.maps['pf_world'].w, H = A.maps['pf_world'].h;
const tiles = A.tilesets['pf_tiles'].tiles;
const flagOf = (t) => tiles[t]?.flags ?? 0;
const cell = (c, r) => (c < 0 || c >= W ? (r >= 16 ? 0 : 1) : r < 0 ? 1 : r >= H ? 0 : flagOf(cells[r * W + c]));
const tileAtPx = (x, y) => cells[(y >> 3) * W + (x >> 3)];
/** is any pixel of the rectangle in a cell with a flag of `mask`? (per cell, the contract's collision) */
const rectHit = (x, y, w, h, mask) => { for (let r = y >> 3; r <= (y + h - 1) >> 3; r++) for (let c = x >> 3; c <= (x + w - 1) >> 3; c++) if (cell(c, r) & mask) return true; return false; };

// =================================================================================================================
console.log('1. Assets and level data');
{
  const fresh = JSON.stringify(buildAssets(), null, 1) + '\n';
  check_('platformer.assets.json is exactly what platformer.assets.gen.mjs generates (deterministic)', fresh === readFileSync(join(HERE, '..', 'arcade/examples/platformer.assets.json'), 'utf8'));
  check_(`the tileset has ${tiles.length} tiles (at most 32), tile 0 is blank with no flags`, tiles.length <= 32 && tiles[0].rows.every((r) => Number(`0x${r.bits}`) === 0) && tiles[0].flags === 0);
  check_('the world is 128 x 16 cells and every cell is a defined tile', W === 128 && H === 16 && cells.length === 2048 && cells.every((t) => t >= 0 && t < tiles.length));
  const src = PLATFORMER_SRC;
  check_('the source declares WINDOW level and BAND 2, 1, 4 / 3, 1, 2 / 11, 1, 1 (far, mid, the 11-row gameplay band)', /^WINDOW level\s*$/m.test(src) && /^BAND 2, 1, 4\s*$/m.test(src) && /^BAND 3, 1, 2\s*$/m.test(src) && /^BAND 11, 1, 1\s*$/m.test(src));

  // the arrays the source carries, read from the interpreter's INIT record
  const init = interpretPlatformer(0).init;
  const arr = (n) => init.arrays[n];
  const pickups = [];
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) if (flagOf(cells[r * W + c]) & FLAG.PICKUP) pickups.push([c * 8, r * 8]);
  pickups.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const coinsSrc = arr('CXS').map((x, i) => [x, arr('CYS')[i]]);
  check_(`CXS / CYS in the source are exactly the ${pickups.length} pickup tiles of the map, sorted by x (${coinsSrc.length} coins)`, JSON.stringify(coinsSrc) === JSON.stringify(pickups) && coinsSrc.length === 50);
  check_('the source constants NC = 50 and NS = 11 match the arrays', /^CONST NC = 50$/m.test(src) && /^CONST NS = 11$/m.test(src) && arr('SX').length === 11 && arr('CXS').length === 50);
  const sx = arr('SX'), sy = arr('SY'), sty = arr('STY');
  check_('enemy spawns are sorted by x', sx.every((x, i) => i === 0 || sx[i - 1] <= x));
  let bad = [];
  sx.forEach((x, i) => {
    if (sty[i] === 0) {      // a walker: 16 x 16 standing on a floor, the cells of its body free, a wall or an edge within reach to turn at
      const floorOk = rectHit(x, sy[i] + 16, 16, 1, 1) && rectHit(x, sy[i] + 16, 1, 1, 1) && rectHit(x + 15, sy[i] + 16, 1, 1, 1);
      const bodyFree = !rectHit(x, sy[i] + 4, 16, 12, 1);
      if (!floorOk || !bodyFree) bad.push(`walker ${i} at ${x},${sy[i]}`);
    } else if (rectHit(x - 56, sy[i] - 12, 16 + 112, 16 + 24, 1)) bad.push(`bat ${i} at ${x},${sy[i]} (solid ground in its path)`);
  });
  check_(`all ${sx.length} enemies are placed on solid ground (walkers: floor under both feet, body clear) or in clear air (bats: ±56 px, ±12 px)`, bad.length === 0, bad.join('; '));
  const ckx = arr('CKX'), cky = arr('CKY');
  check_('the 3 checkpoints put the 10 x 22 box (x+3, y+2) on a floor with the box clear', ckx.every((x, i) => !rectHit(x + 3, cky[i] + 2, 10, 22, 1) && rectHit(x + 3, cky[i] + 2 + 22, 10, 1, 1)) && ckx.every((x, i) => i === 0 || ckx[i - 1] < x), JSON.stringify(ckx.map((x, i) => [x, cky[i]])));
  {
    const rs = [24, ...ckx].map((x) => Math.max(0, Math.min(832, x - 72))), cxs = arr('CXS');
    const wantCf = rs.map((cam) => cxs.findIndex((x) => x + 8 > cam)), wantNx = rs.map((cam) => sx.findIndex((x) => x >= cam - 48));
    check_('RCF / RNX (where a respawn restarts the coin and spawn lists) are the first coin not left of the respawn camera and the first enemy not 48 px behind it, for the start and each checkpoint', JSON.stringify(arr('RCF')) === JSON.stringify(wantCf) && JSON.stringify(arr('RNX')) === JSON.stringify(wantNx), `${JSON.stringify(arr('RCF'))} ${JSON.stringify(arr('RNX'))}`);
  }
  {
    // the walkers' turning points WLO / WHI, worked out here again from the map: from the spawn the walker steps 8 px at a time and turns at the first x where the cell in front
    // of it (x - 1 going left, x + 16 going right) is solid at its body (y+4 .. y+11) or has no solid / one-way floor under it (y + 16)
    const wlo = arr('WLO'), whi = arr('WHI'), cxs = arr('CXS');
    const blocked = (x, y, dir) => { const ax = dir > 0 ? x + 16 : x - 1; return !!(cell(ax >> 3, (y + 4) >> 3) & 1 || cell(ax >> 3, (y + 11) >> 3) & 1 || !(cell(ax >> 3, (y + 16) >> 3) & 9)); };
    const bad2 = [];
    sx.forEach((x, i) => {
      if (sty[i] !== 0) return;
      let lo = x, hi = x;
      while (!blocked(lo, sy[i], -1)) lo -= 8;
      while (!blocked(hi, sy[i], 1)) hi += 8;
      if (lo !== wlo[i] || hi !== whi[i]) bad2.push(`walker ${i}: ${wlo[i]}..${whi[i]}, map says ${lo}..${hi}`);
      if (!(wlo[i] <= x && x <= whi[i]) || wlo[i] % 8 || whi[i] % 8) bad2.push(`walker ${i} outside its range`);
    });
    check_('WLO / WHI (the walkers\' turning points): each walker turns exactly where a wall or the edge of its ground is, checked against the map with its own probe rule', bad2.length === 0, bad2.join('; '));
    const cix = arr('CIX');
    check_('CIX(b) is the first coin not left of x = 64 b (b = 0..16; the pickup search starts there)', cix.length === 17 && cix.every((k, b) => k === (cxs.findIndex((x) => x + 8 > 64 * b) < 0 ? cxs.length : cxs.findIndex((x) => x + 8 > 64 * b))));
    check_('the coin spin frames CT = tiles 6, 18, 19, 18 are all pickup tiles with the same attribute (the swap changes no colours, so it costs no attribute pass)', JSON.stringify(arr('CT')) === '[6,18,19,18]' && [6, 18, 19].every((t) => flagOf(t) === FLAG.PICKUP && tiles[t].rows[0].ink === tiles[6].rows[0].ink && tiles[t].rows[0].paper === tiles[6].rows[0].paper && tiles[t].rows[0].bright === tiles[6].rows[0].bright));
  }
  check_('the start (24, 88) stands on solid ground; the flag is at the far end with goal tiles (flag 16) in its column', !rectHit(27, 90, 10, 22, 1) && rectHit(27, 112, 10, 1, 1) && [8, 9, 10, 11, 12, 13].every((r) => flagOf(cells[r * W + 122]) === FLAG.GOAL));
  const flagCol = LEVEL.goalX >> 3;
  check_('the goal flag column is in the last 6 columns of the world (the far end)', flagCol >= W - 6);

  // art rules
  const paperOf = (t) => tiles[t].rows[0].paper, brightOf = (t) => tiles[t].rows[0].bright, inkOf = (t) => tiles[t].rows[0].ink;
  const rowTiles = (r0, r1) => new Set(cells.filter((_, i) => i >> 7 >= r0 && i >> 7 <= r1));
  const papersFar = new Set([...rowTiles(0, 1)].map(paperOf)), papersMid = new Set([...rowTiles(2, 4)].map(paperOf));
  check_('far band (rows 0-1) uses ONE paper colour; mid band (rows 2-4) uses ONE paper colour (and it is the gameplay sky\'s)', papersFar.size === 1 && papersMid.size === 1 && [...papersMid][0] === paperOf(0), `far ${[...papersFar]}, mid ${[...papersMid]}, sky ${paperOf(0)}`);
  const gameTiles = [...rowTiles(5, 15)];
  const passable = gameTiles.filter((t) => !(flagOf(t) & FLAG.SOLID));
  check_(`the ${passable.length} passable tiles of the gameplay band (${passable.join(',')}) all have the sky's paper and BRIGHT, so a sprite crossing them keeps its paper`, passable.every((t) => paperOf(t) === paperOf(0) && brightOf(t) === brightOf(0)));
  check_('the one-way plank carries the sky\'s ink as well (the hero does not change colour crossing it)', tiles[T.PLANK].rows.every((r) => r.ink === inkOf(0) && r.paper === paperOf(0) && r.bright === brightOf(0)));
  check_('every tile\'s 8 rows carry the same attribute (a cell has one ink / paper / bright)', tiles.every((t) => t.rows.every((r) => r.ink === t.rows[0].ink && r.paper === t.rows[0].paper && r.bright === t.rows[0].bright)));
  check_('flags: grass / dirt / brick solid, plank one-way only (not solid), spikes hazard, coin pickup, pole and flag goal, decoration none',
    flagOf(T.GRASS) === 1 && flagOf(T.DIRT) === 1 && flagOf(T.BRICK) === 1 && flagOf(T.PLANK) === 8 && flagOf(T.SPIKES) === 2 && flagOf(T.COIN) === 4 && flagOf(T.POLE) === 16 && flagOf(T.FLAG) === 16 && flagOf(T.SIGN) === 0 && flagOf(T.CLOUD_M) === 0);
  const S = { hero: A.sprites['pf_hero'], walker: A.sprites['pf_walker'], flyer: A.sprites['pf_bat'] };
  check_('hero 16 x 24 with 8 frames; walker and flyer 16 x 16 with 2 frames', S.hero.w === 16 && S.hero.h === 24 && S.hero.frames.length === 8 && S.walker.w === 16 && S.walker.h === 16 && S.walker.frames.length === 2 && S.flyer.frames.length === 2 && S.flyer.h === 16);
  check_('every sprite frame has h rows of the right hex width and a hot box inside the sprite', Object.values(S).every((s) => s.frames.every((f) => f.rows.length === s.h && f.rows.every((r) => r.bits.length === s.w / 4 && r.mask.length === s.w / 4 && (Number(`0x${r.bits}`) & ~Number(`0x${r.mask}`)) === 0)) && s.hot[0] + s.hot[2] <= s.w && s.hot[1] + s.hot[3] <= s.h));
  check_('the player\'s collision box in the source (BX 3, BY 2, BW 10, BH 22) is the hero\'s hot box', /CONST BX = 3\b/.test(PLATFORMER_SRC) && /CONST BY = 2\b/.test(PLATFORMER_SRC) && /CONST BW = 10\b/.test(PLATFORMER_SRC) && /CONST BH = 22\b/.test(PLATFORMER_SRC) && JSON.stringify(S.hero.hot) === '[3,2,10,22]');
}

// =================================================================================================================
console.log('\n2. The compiler');
const res = compileOnMock();
{
  check_('platformer.arc compiles (batch 2 mock runtime, v3)', res.errors.length === 0, errText(res));
  if (res.errors.length) { console.log(`\nFAIL: arcade-m6-platformer (${passed} checks passed, ${failed + 1} failed)`); process.exit(1); }
  const merged = compileOnMock(PLATFORMER_SRC, ASSETS);
  check_('it also compiles against the shared ASSETS of arcade-m6-common.mjs (the asset names do not clash with the test programs\'; this is what PROGRAMS / the differential test use) to the same image', merged.errors.length === 0 && Buffer.compare(Buffer.from(merged.memory), Buffer.from(res.memory)) === 0, errText(merged));
  // the real v3 runtime build, when it has the window routines (the lead builds it: node arcade/tools/build-runtime-v3.mjs)
  const rtJson = join(HERE, '..', 'arcade/build/v3/runtime.json');
  if (existsSync(rtJson)) {
    const rt = JSON.parse(readFileSync(rtJson, 'utf8')), img = new Uint8Array(readFileSync(join(dirname(rtJson), rt.image ?? 'runtime.bin')));
    const real = compile(PLATFORMER_SRC, { runtime: rt, image: img, assets: PLATFORMER_ASSETS });
    const missing = real.errors.filter((e) => /does not provide/.test(e.message));
    if (real.errors.length === 0) check_('it compiles against arcade/build/v3 (the real runtime build)', true, `code ${real.usage.code} B, ${real.usage.free} B free`);
    else if (missing.length === real.errors.length) info(`arcade/build/v3 does not have the window routines yet (${[...new Set(missing.map((e) => e.message.match(/needs (\w+)/)?.[1]))].join(', ')}): the real-runtime compile is skipped`);
    else check_('it compiles against arcade/build/v3 (the real runtime build)', false, errText(real));
  }
  const u = res.usage;
  check_('it links: the game area has room (code + data + sprites + window data + scroll tables <= 16,384 bytes)', u.free >= 0 || (u.total + u.window.scrollTables) <= 16384, `used ${u.total + u.window.scrollTables} of 16384`);
  info(`link report: code ${u.code} B (strings ${u.data.strings}, tileset ${u.data.tileset}, sfx ${u.data.sfx}, array initialisers ${u.data.init}), sprite frames ${u.frames} B, window data ${u.window.worldSource + u.window.tileFlags + u.window.tileRows + u.window.descriptor} B, scroll tables ${u.window.scrollTables} B => ${u.total + u.window.scrollTables} of 16384 B game area (${16384 - u.total - u.window.scrollTables} spare)`);
  info(`phase memory (the linker's report): ${JSON.stringify(u.phaseRam).slice(0, 300)}; variables ${u.gameVars.used} of ${u.gameVars.available} B; instances ${u.codegen.instances} of 16; camMax ${u.window.camMax}`);
  // the phase pool of runtime v3 (docs/ARCADE_RUNTIME_API_V3.md): every asset must keep ALL its frames cached (K = nframes), or a frame built when first drawn costs ~32k T
  {
    const C = existsSync(rtJson) ? (JSON.parse(readFileSync(rtJson, 'utf8')).constants ?? {}) : {};
    const pieces = [[C.POOL_A ?? 0xC080, C.POOL_A_LEN ?? 3456], [C.POOL_B ?? 0xF200, C.POOL_B_LEN ?? 2176], [C.POOL_C ?? 0xD700, C.POOL_C_LEN ?? 256]];
    const flipped = (name) => new RegExp(`^\\s*SHOW ${name}(\\(.*?\\))? AT .*\\bFLIP\\s*$`, 'm').test(PLATFORMER_SRC);
    const decl = [['pf_hero', 'hero', 1], ['pf_walker', 'wk', 4], ['pf_bat', 'fl', 2]];
    const assets = decl.map(([key, name]) => { const a = A.sprites[key], ph = normPhases(a.phases ?? 8); return { nf: a.frames.length * (flipped(name) ? 2 : 1), phases: ph, slen: (ph - 1) * a.h * 2 * (a.w / 8 + 1) }; });
    const plan = planPool(assets, decl.map((d) => d[2]), pieces);
    check_(`phase pool: the plan fits (${poolNeed(assets, decl.map((d) => d[2]))} bytes at least of ${pieces.reduce((n, p) => n + p[1], 0)}) and EVERY asset keeps all its frames cached: K = ${plan.K.join(', ')} of nframes ${assets.map((a) => a.nf).join(', ')} (hero, walker, bat, coin)`, plan.ok && plan.K.every((k, i) => assets[i].phases === 1 || k === assets[i].nf), `phases ${assets.map((a) => a.phases).join(',')}`);
  }
  check_('7 sprite instances (4 walkers, 2 bats, the hero; the coins are tiles): well within the 16', u.codegen.instances === 7);
  check_('game variables fit with room (GAME_VARS 2,048 bytes)', u.gameVars.used <= 2048 - 256, `${u.gameVars.used} B`);
  check_('the game links with NO warnings (in particular no phase-memory warning)', res.warnings.length === 0, res.warnings.map((w) => w.message).join(' | '));
}

// =================================================================================================================
console.log('\n3. The play-through on the reference interpreter (the level is completable)');
const win = interpretPlatformer(WIN_LENGTH, WIN_STICK);
const twice = interpretPlatformer(TWICE_LENGTH, TWICE_STICK);
{
  const tk = win.ticks, v = (t) => tk[t - 1].vars;
  const endTick = tk.findIndex((r) => r.vars.ST === 2) + 1;
  check_(`the recorded input (${WIN_LENGTH} ticks = ${(WIN_LENGTH / 20).toFixed(0)} s at 20 fps) takes the player from the title to the flag: state 2 (level complete) reached at tick ${endTick}`, endTick > 0);
  const f = tk[tk.length - 1].vars;
  const stomps = (f.SCORE - 10 * f.COINS - 500) / 100;
  check_(`at the end: score ${f.SCORE} = 10 per coin (${f.COINS} of 50) + 100 per stomp (${stomps}) + 500 for the flag; lives ${f.LIVES}`, Number.isInteger(stomps) && stomps >= 1 && f.COINS >= 30);
  check_('the camera followed him to the right end of the world (camera 832 = cam_max) and the player stands at the flag column', Math.max(...tk.map((r) => r.cam)) === 832 && Math.abs(f.PX - LEVEL.goalX) < 40, `PX ${f.PX}, camera max ${Math.max(...tk.map((r) => r.cam))}`);
  const vis = (i) => tk.some((r) => r.sprites[i].visible === 1);
  check_('walkers and bats were spawned from the list (sprite instances 0..3 and 4..5 shown at some tick)', [0, 1, 2, 3].some(vis) && [4, 5].some(vis));
  // jumps: the longest stretch in the air, the highest the feet got
  let air = 0, maxAir = 0, minPy = 999;
  for (const r of tk) { if (r.vars.GND === 0 && r.vars.ST === 1) { air++; maxAir = Math.max(maxAir, air); } else air = 0; minPy = Math.min(minPy, r.vars.PY); }
  info(`physics seen in the run: longest time in the air ${maxAir} ticks (${(maxAir / 20).toFixed(1)} s), highest the sprite top got: y ${minPy}; checkpoints reached ${f.CK}; lives lost ${3 - f.LIVES}`);
  // the same input without any jump does not win: the level needs the jumps
  const nojump = stickFromRuns(RUNS.map(([val, n]) => [val & ~1, n]));
  const flat = interpretPlatformer(WIN_LENGTH, nojump);
  check_('the same input with the jump key never pressed does NOT win (the first pit stops it)', flat.ticks.every((r) => r.vars.ST !== 2));
  const sts2 = twice.ticks.map((r) => r.vars.ST), seq2 = sts2.filter((x, i) => i === 0 || x !== sts2[i - 1]);
  check_(`played twice (flag, back to the title, again): the states go ${seq2.join(' -> ')} and both games end with the same score`, seq2.join() === '0,1,2,0,1,2' && twice.ticks[WIN_LENGTH - 1].vars.SCORE === twice.ticks[TWICE_LENGTH - 1].vars.SCORE);
  const idle = interpretPlatformer(160, (t) => (t === 14 ? 16 : 0));
  check_('standing still at the start does not win, and the first walker walks up to him and costs a life (the enemies are awake and dangerous)', idle.ticks.every((r) => r.vars.ST !== 2) && idle.ticks[159].vars.LIVES < 3, `lives ${idle.ticks[159].vars.LIVES}`);
}

// =================================================================================================================
console.log('\n4. Game over and the state machine on the interpreter');
const over = interpretPlatformer(OVER_LENGTH, OVER_STICK);
{
  const sts = over.ticks.map((r) => r.vars.ST);
  const seq = sts.filter((s, i) => i === 0 || s !== sts[i - 1]);
  check_(`the states visited are title 0, playing 1, game over 3, title 0, playing 1 (${seq.join(' -> ')})`, seq.join() === '0,1,3,0,1');
  const g = over.ticks.findIndex((r) => r.vars.ST === 3);
  const second = over.ticks.findIndex((r, i) => i > g && r.vars.ST === 1);
  check_(`three lives are lost before game over (lives ${over.ticks[g].vars.LIVES}); the new game (tick ${second + 1}) starts with 3 lives, score 0, 0 coins`, over.ticks[g].vars.LIVES === 0 && over.ticks[second].vars.LIVES === 3 && over.ticks[second].vars.SCORE === 0 && over.ticks[second].vars.COINS === 0);
  const coinTilesAtEnd = over.ticks[over.ticks.length - 1].worldRam;
  let pick = 0; for (let r = 0; r < 16; r++) for (let c = 0; c < 128; c++) if (flagOf(coinTilesAtEnd[r * 128 + c] >> 3) & FLAG.PICKUP) pick++;
  check_(`the title restored every coin tile (${pick} pickup tiles in WORLD_RAM at the end of the second game; the first game took coins, and a new game is started from the title)`, pick === 50 - over.ticks[over.ticks.length - 1].vars.COINS);
}

// =================================================================================================================
console.log('\n5. The compiled game against the interpreter, tick by tick (mock runtime)');
{
  const cover = (want) => {
    const t = want.ticks;
    return { states: new Set(t.map((r) => r.vars.ST)), frames: new Set(t.map((r) => r.sprites[6].frame)), cams: t.map((r) => r.cam), changed: t[t.length - 1].worldRam.reduce((n, b, i) => n + (b !== want.init.worldRam[i] ? 1 : 0), 0) };
  };
  const coverage = [];
  for (const [name, stick, n, want] of [['the win run played twice (title and a restart between)', TWICE_STICK, TWICE_LENGTH, twice], ['the game over run', OVER_STICK, OVER_LENGTH, over]]) {
    const t0 = Date.now();
    const got = runOnMock(res, { ticks: n, stick });
    let d = diffV3(got.init, want.init, 'after INIT');
    for (let t = 0; !d && t < n; t++) d = diffV3(got.ticks[t], want.ticks[t], `tick ${t + 1}`);
    check_(`${name}: ${n} ticks, the compiled game's variables, arrays, SPR_TAB (8-byte entries incl. frame), WORLD_RAM and V_CAM equal the interpreter's every tick`, d === null, d ?? `${((Date.now() - t0) / 1000).toFixed(1)} s`);
    const cv = cover(want);
    const sorted = [...got.tstates].sort((a, b) => a - b);
    info(`${name}: PROC FRAME on the mock (runtime routines cost nothing there): min ${sorted[0]}, median ${sorted[sorted.length >> 1]}, 95th ${sorted[Math.floor(sorted.length * 0.95)]}, max ${sorted[sorted.length - 1]} T-states`);
    coverage.push(cv);
    if (stick === TWICE_STICK) {
      check_(`coverage of the win run: states ${[...cv.states].join(',')}; hero frames ${[...cv.frames].sort((a, b) => a - b).join(',')}; camera 0..${Math.max(...cv.cams)}; ${cv.changed} world cells changed by SETWORLD`,
        [0, 1, 2].every((s) => cv.states.has(s)) && [0, 1, 2, 3, 4, 5, 6, 7].every((f) => cv.frames.has(f)) && Math.max(...cv.cams) === 832 && cv.changed >= 30);
      const med = sorted[sorted.length >> 1], mx = sorted[sorted.length - 1];
      check_(`the game logic fits the contract's budget (about 15,000 T per tick for logic at 20 fps; routine calls excluded, they cost nothing on the mock): median ${med}, 95th ${sorted[Math.floor(sorted.length * 0.95)]}, worst ${mx}`, mx < 40000 && med < 15000);
    }
  }
  const allFrames = new Set(coverage.flatMap((c) => [...c.frames]));
  check_(`the mirrored frames (FLIP, 8..15) are used too in the two runs together: hero frames seen ${[...allFrames].sort((a, b) => a - b).join(',')}`, [8, 9, 10, 11, 12, 13].some((f) => allFrames.has(f)) && coverage[1].states.has(3));
}

// =================================================================================================================
console.log('\n6. Tick cost on the real runtime v3 (arcade/build/v3, TSRun, the real frame interrupt; tests/arcade-m6-platformer-perf.mjs has the detail)');
{
  const rtJson2 = join(HERE, '..', 'arcade/build/v3/runtime.json');
  const rt2 = existsSync(rtJson2) ? JSON.parse(readFileSync(rtJson2, 'utf8')) : null;
  if (!rt2 || rt2.symbols.RT_CAMERA === undefined) info('arcade/build/v3 has no window routines: the real-runtime tick costs are skipped');
  else {
    const P = await import('./arcade-m6-platformer-perf.mjs');
    for (const [name, stick, n] of P.RUNS) {
      const { ticks } = P.profile(PLATFORMER_SRC, { ticks: n, stick });
      const w = P.summarise(ticks, 't'), lg = P.summarise(ticks.filter((x) => x.logic).map((x) => ({ t: x.logic.t })), 't');
      const f = (v) => Math.round(v).toLocaleString('en-US');
      info(`${name}: ${w.n} ticks; whole tick median ${f(w.median)}, 95th ${f(w.p95)}, worst ${f(w.worst)}; PROC FRAME median ${f(lg.median)}, 95th ${f(lg.p95)}, worst ${f(lg.worst)}`);
      check_(`${name}: no tick goes over 3 refreshes (${f(P.BUDGET)} T, the interrupt's time included): ${w.over} over`, w.over === 0);
    }
  }
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: arcade-m6-platformer (${passed} checks passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
