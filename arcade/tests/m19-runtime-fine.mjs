"use strict";
// m19-runtime-fine.mjs -- Leap Arcade fine colour, slice F2 (docs/ARCADE_FINE_COLOUR_CONTRACT.md sections 2, 3a, 4, 5): runtime v2's fine.asm
// (RT_FINEMODE, the fine tick: publish, frame_entry, compose) on a stock TS2068 (TSRun) with the real frame interrupt, one instruction at a time.
// The game is runtime/v2/test_fine.asm (a script interpreter with the op FINEMODE); the expectation is m19-common's model (cells, text, tiles,
// FILL / FILLC, instances) and the fine picture of contract section 2 (m19-fine-ref.mjs).
//  0. the build: the symbols, the size of fine.asm, the runtime below it byte-identical to a build without it (so a game without fine colour runs
//     exactly the code it ran before: no added test, no moved address).
//  1. random scenes: after every publish the screen ($4000 bitmap, $6000 colours, $FF = 2) equals the fine picture of the state; text, tiles with 8 row
//     colours, FILL / FILLC, 1..16 instances of 8x8 / 16x16 / other heights, 1/2/4/8 phases (<= 32 in all), overlaps, hide / show, every edge,
//     RT_FINEMODE on / off at random places in random ticks; every two-buffer tick's file against the model; right after ON the picture it built
//     (the cell map, no sprite) and after OFF both display files (the cell map), $FF and the flip state.
//  2. fixed cases: ON in init_entry, a fine game with no tileset in its descriptor, ON refused (33 phases; a WIRE3D-free game only), ON / OFF twice
//     in one tick, the list overflow (FILLC of the whole screen every tick: F_NOVF counts, the picture stays right).
//  3. what a switch shows: every frame TSRun paints while RT_FINEMODE runs is the old picture, a plain-colour frame, or the new one.
//  4. interrupts injected at every instruction boundary of fine.asm (a three-channel effect playing, so the sound tick pushes its full depth):
//     every register (IX, IY, the alternates included) back, and the pictures still right.
//  5. memory: every write after the boot lands in the screen, the cell map, the dirty maps, SPR_TAB / SPR_DRAWN, phase pool B (only while fine colour
//     is on), the variables, GAME_VARS, T3 (the test's FILL), the stack or the sound page; T2, V_FREE2 and $5B00-$5FFF / $7B00-$7FFF stay as poisoned.
//  6. a game without fine colour never executes a byte of fine.asm and V_FINE stays 0.
//   node arcade/tests/m19-runtime-fine.mjs        (M19_QUICK=1: fewer scenes)
import { readFileSync, writeFileSync, mkdirSync, readdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { RUNTIME_DIR, OUT } from '../tools/build-runtime-v2.mjs';
import * as T from './m19-common.mjs';
import { frameKeys, pictureKeys } from '../spike/fine/fine-check.mjs';
import * as C4 from './m4-common.mjs';
const { S, K, rt, M, Z, FRAME_T, hex, makeChecks, rd8, rd16, rng, fineGame, run, randomAssets, randomFineTiles, randomTicks, randomAsset, randomInks, busyEffect, fmt, GAME } = T;

const QUICK = !!process.env.M19_QUICK;
const MC = makeChecks();
const check = (name, ok, detail) => { const r = MC.check(name, ok, detail); if (!r && process.env.M19_FAILFAST) process.exit(1); return r; };
const finish = MC.finish;
console.log('M19 runtime fine colour (F2): RT_FINEMODE and the fine tick on runtime v2, real frame interrupt\n');

// ---- 0. the build -------------------------------------------------------------------------------------------------------------------------
console.log('--- 0. the build ---');
const FINE_BYTES = S.M_FINE_E - S.M_FINE_S;
check('the symbols RT_FINEMODE, FINE_LOOP, fine_publish, fine_compose and the fine variables exist; V_FINE = $E062', ['RT_FINEMODE', 'FINE_LOOP', 'FINE_WORK', 'FINE_FRAME', 'fine_publish', 'fine_compose', 'fine_off', 'FINE_RES_INIT', 'FINE_RES_TICK'].every((k) => S[k] > 0) && S.V_FINE === 0xE062 && K.V_FINE === 0xE062);
check(`fine.asm is ${fmt(FINE_BYTES)} bytes (bound 2,500), ${fmt(0x4000 - S.RT_END)} bytes free after RT_END`, FINE_BYTES <= 2500 && S.M_FINE_E === S.RT_END && 0x4000 - S.RT_END >= 900, `${hex(S.M_FINE_S)}-${hex(S.M_FINE_E)}`);
{
  // assemble runtime.asm without the fine.asm include: every byte below it must be the same
  const dir = join(OUT, 'work', 'm19-nofine' + (process.env.ARCADE_JOB_TAG ? '-' + process.env.ARCADE_JOB_TAG : ''));
  mkdirSync(dir, { recursive: true });
  for (const f of readdirSync(RUNTIME_DIR)) if (/\.(asm|inc)$/.test(f)) copyFileSync(join(RUNTIME_DIR, f), join(dir, f));
  const top = readFileSync(join(dir, 'runtime.asm'), 'utf8').split('\n').filter((l) => !/INCLUDE "fine\.asm"/.test(l)).join('\n');
  writeFileSync(join(dir, 'runtime.asm'), top);
  execFileSync('sjasmplus', ['--nologo', `--sym=${join(dir, 'nofine.sym')}`, join(dir, 'runtime.asm')], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  const img0 = new Uint8Array(readFileSync(join(dir, 'mem.bin')));
  let diff = 0;
  for (let a = 0; a < S.M_FINE_S; a++) if (img0[a] !== rt.img[a]) diff++;
  const end0 = readFileSync(join(dir, 'nofine.sym'), 'utf8').match(/^RT_END:\s+EQU\s+0x([0-9A-Fa-f]+)/m);
  check('the runtime below fine.asm is byte-identical to a build without fine.asm (main.asm, the ISR and every routine unchanged: +0 T a tick)', diff === 0 && end0 && parseInt(end0[1], 16) === S.M_FINE_S, `${diff} bytes differ`);
}

// ---- 1. random scenes ------------------------------------------------------------------------------------------------------------------------
console.log('\n--- 1. random scenes: the picture after every update ---');
function randomScene(seed, { L = 40, frames = 140 } = {}) {
  const R = rng(seed);
  const assets = randomAssets(R, R.int(1, 8));
  const tiles = randomFineTiles(R, R.int(2, 12));
  const n = R.int(1, 16);
  const insts = Array.from({ length: n }, () => R.int(0, assets.length - 1));
  const map = R.chance(0.7) ? Array.from({ length: 768 }, () => (R.chance(0.8) ? 128 + R.int(0, tiles.length - 1) : R.int(32, 126))) : null;
  const ticks = randomTicks(R, { n, L, tiles: tiles.length, modes: 0.08 });
  return { spec: { div: R.int(1, 3), assets, insts, tiles, map, initMode: R.chance(0.5) ? 1 : 0xFF, ticks, noTileRows: R.chance(0.12) }, frames };
}
const agg = { runs: 0, pubs: 0, bufs: 0, ons: 0, offs: 0, bad: 0, first: [], maxInst: 0, phases: new Set(), sizes: new Set() };
const NSEEDS = QUICK ? 6 : 24;
for (let seed = 1; seed <= NSEEDS; seed++) {
  const { spec, frames } = randomScene(seed * 7919);
  const st = run(fineGame(spec), frames);
  agg.runs++; agg.pubs += st.publishes; agg.bufs += st.bufTicks; agg.ons += st.ons; agg.offs += st.offs;
  agg.maxInst = Math.max(agg.maxInst, spec.insts.length);
  spec.assets.forEach((a) => { agg.phases.add(a.phases); agg.sizes.add(`${a.w}x${a.h}`); });
  const nb = st.pubBad + st.bufBad + st.onBad + st.offBad + st.fineFlag + st.opsBad + st.noopBad + st.listBad + st.spLow;
  agg.bad += nb;
  if (nb && agg.first.length < 3) agg.first.push(`seed ${seed}: ${st.bad.join(' | ')}`);
}
check(`${agg.runs} scenes: every publish equals the fine picture, every two-buffer tick its file, every switch its picture`, agg.bad === 0 && agg.pubs > 15 * NSEEDS && agg.ons >= NSEEDS && agg.offs >= NSEEDS / 2,
  `${agg.pubs} publishes, ${agg.bufs} two-buffer ticks, ${agg.ons} ON, ${agg.offs} OFF; up to ${agg.maxInst} instances; phases ${[...agg.phases].sort().join('/')}; ${agg.first.join('; ')}`);

// ---- 2. fixed cases --------------------------------------------------------------------------------------------------------------------------
console.log('\n--- 2. fixed cases ---');
const R2 = rng(1902);
const A16 = { ...randomAsset(R2, 16, 16, 8), inks: randomInks(R2) }, A8 = { ...randomAsset(R2, 8, 8, 8), inks: randomInks(R2) };
const A12 = { ...randomAsset(R2, 16, 12, 4), inks: randomInks(R2) }, A5 = { ...randomAsset(R2, 8, 5, 2), inks: randomInks(R2) };
const TILES = randomFineTiles(R2, 10);
const MAP = Array.from({ length: 768 }, (_, i) => (i < 64 ? 32 + (i % 90) : 128 + ((i * 7 + (i >> 5)) % 10)));
const allSt = (st) => st.pubBad + st.bufBad + st.onBad + st.offBad + st.fineFlag + st.opsBad + st.noopBad + st.listBad + st.spLow;
{ // edges and overlaps: 16 instances on every edge and corner, piled up
  const insts = Array.from({ length: 16 }, (_, i) => i % 4);
  const spots = [[0, 0], [239, 0], [0, 176], [239, 176], [120, 0], [120, 176], [0, 88], [239, 88], [100, 80], [102, 82], [104, 84], [106, 86], [5, 7], [233, 169], [64, 64], [65, 65]];
  const ticks = [spots.map(([x, y], i) => ({ op: 'show', i, x, y }))];
  for (let k = 1; k < 12; k++) ticks.push(spots.map(([x, y], i) => ({ op: 'show', i, x: Math.max(0, Math.min(239, x + ((k * (i + 1)) % 7) - 3)), y: Math.max(0, Math.min(176, y + ((k * (i + 3)) % 5) - 2)) })));
  ticks.push([{ op: 'hide', i: 3 }, { op: 'hide', i: 9 }], [{ op: 'show', i: 3, x: -20, y: 300 }]);
  const st = run(fineGame({ div: 1, assets: [A16, A8, A12, A5], insts, tiles: TILES, map: MAP, initMode: 1, ticks }), 140);
  check('16 instances on every edge and corner, overlapping (16x16, 8x8, 16x12, 8x5; 8/8/4/2 phases), hidden and shown again', allSt(st) === 0 && st.publishes >= 14, `${st.publishes} publishes; ${st.bad.join(' | ')}`);
}
{ // no tileset in the descriptor: a tile cell takes its attribute on all rows
  const ticks = [[{ op: 'show', i: 0, x: 30, y: 30 }], [{ op: 'tile', t: 3, row: 5, col: 5 }, { op: 'show', i: 0, x: 33, y: 31 }], []];
  const st = run(fineGame({ div: 1, assets: [A16], insts: [0], tiles: TILES, map: MAP, initMode: 1, ticks, noTileRows: true }), 40);
  check('descriptor tile_rows = 0: a tile cell is drawn with its cell attribute on all 8 rows', allSt(st) === 0 && st.publishes >= 3, st.bad.join(' | '));
}
{ // moves of 0..9 pixels in every direction (one mark over both windows up to 8 apart and 3 byte columns; apart otherwise), text in the sprites' rows
  const steps = [[1, 0], [0, 1], [-1, 0], [0, -1], [2, 2], [-2, -2], [3, -1], [-3, 1], [8, 0], [0, 8], [-8, -8], [9, 0], [0, 9], [-9, 3], [5, -9], [7, 7], [0, 0]];
  const ticks = [];
  let p = [[60, 40], [120, 100], [200, 150]];
  for (let k = 0; k < steps.length * 2; k++) {
    const [dx, dy] = steps[k % steps.length];
    p = p.map(([x, y], i) => [Math.max(0, Math.min(239, x + (i === 1 ? -dx : dx))), Math.max(0, Math.min(176, y + (i === 2 ? -dy : dy)))]);
    ticks.push([...p.map(([x, y], i) => ({ op: 'show', i, x, y })), ...(k % 3 === 0 ? [{ op: 'at', row: (p[0][1] >> 3) + 1, col: (p[0][0] >> 3) + 1 }, { op: 'prints', s: 'T' + k }] : [])]);
  }
  const st = run(fineGame({ div: 1, assets: [A16, A8, A12], insts: [0, 1, 2], tiles: TILES, map: MAP, initMode: 1, ticks }), 120);
  check('instances moving 0..9 pixels in every direction, across byte columns and cell rows, text in their rows: every picture right', allSt(st) === 0 && st.publishes >= ticks.length, `${st.publishes} publishes; ${st.bad.join(' | ')}`);
}
{ // ON resets the compose's per-row values: F_LASTM and F_NW + 1 are in file 2's attributes (garbage before ON)
  const ticks = Array.from({ length: 8 }, (_, k) => [{ op: 'show', i: 0, x: 30 + 3 * k, y: 40 + 2 * k }, { op: 'at', row: 3, col: 3 }, { op: 'prints', s: 'P' + k }]);
  let poisoned = false;
  const st = run(fineGame({ div: 1, assets: [A16], insts: [0], tiles: TILES, map: MAP, initMode: 1, ticks }), 40, { onStep: (m) => {
    if (!poisoned && m.cpu.pc === S['RT_FINEMODE.lb']) { poisoned = true; m.ram.fill(0xFF, S.F_FV, S.F_FV + 16); } } });
  check('ON resets the compose\'s per-row values (F_LASTM, F_NW + 1 in file 2\'s attributes: poisoned with $FF after ON made the hidden file plain)', poisoned && allSt(st) === 0 && st.publishes >= 8, st.bad.join(' | '));
}
{ // ON refused: 33 phases
  const big = [A16, A8, A12, A5, { ...randomAsset(R2, 16, 16, 8), inks: randomInks(R2) }, { ...randomAsset(R2, 8, 8, 2), inks: randomInks(R2) }, { ...randomAsset(R2, 8, 8, 1), inks: randomInks(R2) }];   // 8+8+4+2+8+2+1 = 33
  const ticks = [[{ op: 'show', i: 0, x: 40, y: 40 }, { op: 'mode', a: 1 }], [{ op: 'show', i: 0, x: 44, y: 41 }], []];
  const game = fineGame({ div: 1, assets: big, insts: [0, 1], tiles: TILES, map: MAP, initMode: 1, ticks });
  const st = run(game, 30);
  check('33 phase slots: RT_FINEMODE ON refused in init_entry and in a tick (V_FINE 0, $FF unchanged, two-buffer pictures right)', allSt(st) === 0 && st.ons === 0 && st.publishes === 0 && st.bufTicks >= 3 && rd8(st.m, S.V_FINE) === 0 && st.m.portFF < 2, `${st.bufTicks} two-buffer ticks; ${st.bad.join(' | ')}`);
}
{ // ON / OFF / ON in one tick, OFF in init after ON, ON from a two-buffer tick and OFF in the fine tick
  const ticks = [[{ op: 'show', i: 0, x: 10, y: 10 }], [{ op: 'mode', a: 1 }, { op: 'show', i: 0, x: 12, y: 11 }, { op: 'mode', a: 0 }, { op: 'show', i: 1, x: 60, y: 60 }, { op: 'mode', a: 1 }],
    [{ op: 'show', i: 0, x: 14, y: 12 }], [{ op: 'mode', a: 0 }, { op: 'mode', a: 0 }], [{ op: 'show', i: 0, x: 16, y: 13 }], [{ op: 'mode', a: 1 }, { op: 'mode', a: 1 }], [], [{ op: 'mode', a: 0 }, { op: 'mode', a: 1 }], []];
  const st = run(fineGame({ div: 1, assets: [A16, A8], insts: [0, 1], tiles: TILES, map: MAP, ticks }), 160);
  check('ON / OFF / ON in one two-buffer tick, OFF twice, ON twice, OFF then ON in one fine tick: every switch and every picture right', allSt(st) === 0 && st.ons === 4 && st.offs === 3 && st.publishes >= 4, `${st.ons} ON, ${st.offs} OFF, ${st.publishes} publishes; ${st.bad.join(' | ')}`);
}
{ // overflow
  const ticks = [];
  for (let k = 0; k < 10; k++) ticks.push([{ op: 'ink', a: k & 7 }, { op: 'fillc', x: 0, y: 0, w: 32, h: 24, c: 65 + k }, { op: 'show', i: 0, x: 20 + 3 * k, y: 30 + k }, { op: 'show', i: 1, x: 200 - 2 * k, y: 150 - k }]);
  ticks.push([{ op: 'show', i: 0, x: 60, y: 60 }], []);
  const st = run(fineGame({ div: 2, assets: [A16, A8], insts: [0, 1], tiles: TILES, map: MAP, initMode: 1, ticks }), 260);
  const novf = rd16(st.m, S.F_NOVF);
  check('the list overflows (FILLC of the whole screen every tick): F_NOVF counts those ticks, the publish composes the rest itself, the picture stays right', allSt(st) === 0 && novf >= 8 && st.publishes >= 11 && st.ovfCalls === novf && rd8(st.m, S.F_OVF) === 0, `F_NOVF ${novf}, fine_ovf ran ${st.ovfCalls} times, F_OVF now ${rd8(st.m, S.F_OVF)}; ${st.publishes} publishes; publish T median ${fmt([...st.pub].sort((a, b) => a - b)[st.pub.length >> 1])}; ${st.bad.join(' | ')}`);
}
{ // frame_div: one update every 3 refreshes, each right after an interrupt
  const ticks = Array.from({ length: 30 }, (_, k) => [{ op: 'show', i: 0, x: 5 * k, y: 3 * k }]);
  const st = run(fineGame({ div: 3, assets: [A16], insts: [0], tiles: TILES, map: MAP, initMode: 1, ticks }), 90, { keepRecs: true });
  const gaps = st.recs.slice(1).map((r, i) => Math.round((r.frameStart - st.recs[i].frameStart) / FRAME_T));
  const late = st.recs.map((r) => r.start - r.frameStart);
  check('frame_div 3: one update every 3 refreshes, each starting right after the frame interrupt (V_SYNC left busy, no flip request)', allSt(st) === 0 && gaps.length >= 20 && gaps.every((g) => g === 3) && Math.max(...late) < 1000 && st.m.portFF === 2,
    `${gaps.length + 1} updates; gaps ${[...new Set(gaps)].join('/')} refreshes; start ${Math.min(...late)}..${Math.max(...late)} T after the interrupt`);
}
{ // a compose longer than the period (12 sprites, frame_div 1): the next update still waits for an interrupt
  const ticks = Array.from({ length: 12 }, (_, k) => Array.from({ length: 12 }, (_, i) => ({ op: 'show', i, x: (20 * i + 3 * k) % 230, y: (13 * i + 2 * k) % 170 })));
  const st = run(fineGame({ div: 1, assets: [A16, A8], insts: Array.from({ length: 12 }, (_, i) => i & 1), tiles: TILES, map: MAP, initMode: 1, ticks }), 90, { keepRecs: true });
  const late = st.recs.map((r) => r.start - r.frameStart);
  check('a compose longer than the period: every update still starts right after a frame interrupt', allSt(st) === 0 && st.recs.length >= 8 && Math.max(...late) < 1000 && Math.max(...st.comp) > FRAME_T,
    `${st.recs.length} updates; compose up to ${fmt(Math.max(...st.comp))} T; start ${Math.min(...late)}..${Math.max(...late)} T after the interrupt`);
}

{ // refusals: a WIRE3D game (V_WIRE <> 0), exactly 32 phases allowed, a call from outside init_entry / a frame_entry
  const ticks = [[{ op: 'show', i: 0, x: 40, y: 40 }, { op: 'mode', a: 1 }], [{ op: 'show', i: 0, x: 44, y: 41 }], []];
  const st = run(fineGame({ div: 1, assets: [A16], insts: [0], tiles: TILES, map: MAP, initMode: 1, ticks, wire: true }), 30, { poison: (m) => { m.ram[K.V_WIRE] = K.WIRE_HAS; } });
  check('a WIRE3D game (V_WIRE <> 0): RT_FINEMODE ON refused', allSt(st) === 0 && st.ons === 0 && st.bufTicks >= 3 && rd8(st.m, S.V_FINE) === 0, st.bad.join(' | '));
  const P8 = [0, 1, 2, 3].map(() => ({ ...randomAsset(R2, 16, 16, 8), inks: randomInks(R2) }));
  const st32 = run(fineGame({ div: 1, assets: P8, insts: [0, 1, 2, 3], tiles: TILES, map: MAP, initMode: 1, ticks: [[0, 1, 2, 3].map((i) => ({ op: 'show', i, x: 30 + 40 * i, y: 20 + 30 * i }))] }), 30);
  check('exactly 32 phases (4 x 8): RT_FINEMODE ON accepted', allSt(st32) === 0 && st32.ons === 1 && st32.publishes >= 2, st32.bad.join(' | '));
  // a direct call (the word at STACK_TOP - 2 is neither init_entry's nor a frame_entry's return address): refused, returns at once
  const m = st32.m, cpu = m.cpu;
  m.ram[S.V_FINE] = 0; m.ram[K.STACK_TOP - 2] = 0x34; m.ram[K.STACK_TOP - 1] = 0x12;
  const saved = { pc: cpu.pc, sp: cpu.sp };
  cpu.sp = 0xFD00; m.ram[0xFD00] = 0x00; m.ram[0xFD01] = 0x00; cpu.pc = S.RT_FINEMODE; cpu.a = 1; cpu.h = T.ADDR.DESC >> 8; cpu.l = T.ADDR.DESC & 255;
  let steps = 0;
  while (cpu.pc !== 0 && steps < 5000) { Z.runZ80(cpu, m.bus, 1, m); steps++; }
  check('RT_FINEMODE ON called from anywhere else returns at once (fine colour stays off)', cpu.pc === 0 && rd8(m, S.V_FINE) === 0 && steps < 200, `${steps} instructions`);
  void saved;
}
{ // no instances at all; inks across a page boundary
  const ticks = Array.from({ length: 6 }, (_, k) => [{ op: 'at', row: k, col: 2 }, { op: 'ink', a: k }, { op: 'prints', s: 'NO SPRITES ' + k }, { op: 'tile', t: k, row: 10, col: 10 + k }]);
  const st = run(fineGame({ div: 1, assets: [], insts: [], tiles: TILES, map: MAP, initMode: 1, ticks }), 40);
  check('a fine scene with no instances: text and tiles', allSt(st) === 0 && st.publishes >= 6, st.bad.join(' | '));
  const A = [A16, A8, A12, A5, { ...randomAsset(R2, 16, 16, 4), inks: randomInks(R2) }, { ...randomAsset(R2, 8, 8, 4), inks: randomInks(R2) }];   // 8+8+4+2+4+4 = 30
  const t2 = Array.from({ length: 10 }, (_, k) => [4, 5].map((i) => ({ op: 'show', i, x: 20 + 9 * k + 50 * (i - 4), y: 30 + 5 * k })));
  const st2 = run(fineGame({ div: 1, assets: A, insts: [0, 1, 2, 3, 4, 5], tiles: TILES.slice(0, 4), map: MAP.map((v) => (v >= 128 ? 128 + (v & 3) : v)), initMode: 1, ticks: t2, inksAt: 0x8FB8 }), 50);
  check('the inks of asset 4 across a page boundary inside its rows ($8FB8 + 64 = $8FF8: rows 8..15 at $9000..)', allSt(st2) === 0 && st2.publishes >= 8, st2.bad.join(' | '));
}
{ // the scene's INIT after ON in init_entry shows sprites: composed before the first update
  const initOps = [{ op: 'show', i: 0, x: 50, y: 60 }, { op: 'show', i: 1, x: 120, y: 90 }];
  const ticks = [[], [{ op: 'show', i: 0, x: 53, y: 61 }], []];
  const st = run(fineGame({ div: 1, assets: [A16, A8], insts: [0, 1], tiles: TILES, map: MAP, initMode: 1, initOps, ticks }), 40);
  check('INIT shows sprites right after ON in init_entry: the first update shows them', allSt(st) === 0 && st.publishes >= 3, st.bad.join(' | '));
}
{ // a still sprite across a byte of columns (7..9) under a moving one that only ever covers columns 9..11
  const ticks = [[{ op: 'show', i: 0, x: 60, y: 80 }]];
  for (let k = 0; k < 12; k++) ticks.push([{ op: 'show', i: 1, x: 74 + (k & 3), y: 70 + 2 * k }]);
  const st = run(fineGame({ div: 1, assets: [A16, A8], insts: [0, 1], tiles: TILES, map: MAP, initMode: 1, ticks }), 50);
  check('a still instance whose window crosses a byte of F_CMAP columns is blitted where only its second byte\'s cells are recomposed', allSt(st) === 0 && st.publishes >= 12, st.bad.join(' | '));
}

{ // the stack canary is checked by the fine tick too
  const ticks = Array.from({ length: 8 }, (_, k) => [{ op: 'show', i: 0, x: 10 + k, y: 10 }]);
  let hit = false;
  const st = run(fineGame({ div: 1, assets: [A16], insts: [0], tiles: TILES, map: MAP, initMode: 1, ticks }), 30, { onPublish: (s, rec) => { if (s.publishes === 3) { s.m.ram[K.STACK_CANARY] = 0; hit = true; } } });
  check('a broken stack canary stops the fine tick (stack_dead: interrupts off, the red border)', hit && st.m.cpu.pc >= S.stack_dead && st.m.cpu.pc < S.stack_dead + 8 && !st.m.cpu.iff1, `PC ${hex(st.m.cpu.pc)}`);
}

// ---- 3. what a switch shows ------------------------------------------------------------------------------------------------------------------
console.log('\n--- 3. the frames during a switch ---');
{
  const R = rng(1903);
  const ticks = [];
  for (let k = 0; k < 36; k++) ticks.push([{ op: 'show', i: 0, x: 30 + 4 * k % 200, y: 40 + k }, { op: 'show', i: 1, x: 200 - 3 * k, y: 120 }, ...(k % 6 === 3 ? [...(k % 12 === 3 ? [{ op: 'burn' }] : []), { op: 'mode', a: 1 }] : k % 6 === 0 && k ? [...(k % 12 === 0 ? [{ op: 'burn' }] : []), { op: 'mode', a: 0 }] : [])]);
  const game = fineGame({ div: 1, assets: [A16, A8], insts: [0, 1], tiles: TILES, map: MAP, ticks });
  // the picture a memory state shows (mode 2: bitmap + colour plane; mode 0 / 1: the file with its 8x8 attributes)
  const memKeys = (m) => {
    const ff = m.portFF;
    if (ff === 2) return pictureKeys({ bits: m.ram.slice(0x4000, 0x5800), colours: m.ram.slice(0x6000, 0x7800) });
    const base = ff & 1 ? 0x6000 : 0x4000, cols = new Uint8Array(6144);
    for (let y = 0; y < 192; y++) for (let c = 0; c < 32; c++) { const o = ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | c; cols[o] = m.ram[base + 0x1800 + 32 * (y >> 3) + c]; }
    return pictureKeys({ bits: m.ram.slice(base, base + 0x1800), colours: cols });
  };
  let inSwitch = false, oldK = null, frames = [], sw = 0, bad = 0, plain = 0, ofOld = 0, ofNew = 0, firstBad = '';
  const st = run(game, 300, { video: true,
    onStep: (m) => {
      const pc = m.cpu.pc;
      if (pc === S.RT_FINEMODE && !inSwitch) { inSwitch = true; oldK = memKeys(m); frames = []; }
      if (inSwitch && pc === GAME().syms['frame_entry.moded']) {
        inSwitch = false; sw++;
        const newK = memKeys(m);
        for (const f of frames) {
          const eq = (a) => { for (let i = 0; i < 6144; i++) if (f[i] !== a[i]) return false; return true; };
          const one = f.every((k) => k === f[0]) && f[0] === ((f[0] & 15) * 0x11111111) >>> 0;
          if (eq(oldK)) ofOld++; else if (eq(newK)) ofNew++; else if (one) plain++; else { bad++; if (!firstBad) firstBad = `switch ${sw}`; }
        }
      }
    },
    onFrame: (m) => { if (inSwitch) frames.push(frameKeys(m.pixels)); } });
  check('every frame painted while RT_FINEMODE ran is the old picture, a plain-colour frame or the new picture (never garbage colours; switches early and late in a frame)', bad === 0 && sw >= 10 && plain > 0 && allSt(st) === 0,
    `${sw} switches: ${ofOld} old, ${plain} plain, ${ofNew} new, ${bad} other ${firstBad}`);
}

// ---- 4. interrupts at every instruction of fine.asm ---------------------------------------------------------------------------------------------
console.log('\n--- 4. an interrupt at every instruction boundary of fine.asm (a three-channel effect playing) ---');
{
  const R = rng(1904);
  const KEYS = ['a', 'f', 'b', 'c', 'd', 'e', 'h', 'l', 'a2', 'f2', 'b2', 'c2', 'd2', 'e2', 'h2', 'l2', 'xh', 'xl', 'yh', 'yl', 'sp', 'im', 'iff1', 'pc'];
  const sfx = busyEffect(R, 4);
  const ticks = [];
  for (let k = 0; k < 9; k++) ticks.push([{ op: 'play', i: 0 }, { op: 'show', i: 0, x: 40 + 5 * k, y: 30 + 3 * k }, { op: 'show', i: 1, x: 44 + 5 * k, y: 36 + 2 * k }, { op: 'show', i: 2, x: 230 - 3 * k, y: 48 },
    { op: 'show', i: 3, x: 100 + 2 * k, y: 140 - 4 * k },
    ...(k === 2 ? [{ op: 'at', row: 0, col: 3 }, { op: 'prints', s: 'INT' }] : []), ...(k === 4 ? [{ op: 'fillc', x: 0, y: 0, w: 32, h: 24, c: 66 }] : []), ...(k === 6 ? [{ op: 'mode', a: 0 }] : k === 7 ? [{ op: 'mode', a: 1 }] : [])]);
  const game = fineGame({ div: 1, assets: [A16, A8], insts: [0, 1, 1, 0], tiles: TILES, map: MAP, initMode: 1, ticks, sfx });
  let inj = 0, viol = 0, noRet = 0, firstV = '', maxDepth = 0, sndInj = 0;
  const pcs = new Set();
  const st = run(game, 130, { onStep: (m) => {
    const cpu = m.cpu, pc = cpu.pc;
    if (pc < S.M_FINE_S || pc >= S.M_FINE_E || !cpu.iff1 || cpu.eiDelay || cpu.halted) return;
    if (m.ram[S.V_SYNC] >= 2) return;                                      // a flip request pending (fine_flip): the real interrupt does that
    const before = Object.fromEntries(KEYS.map((k) => [k, cpu[k]]));
    const vars = m.ram.slice(0xE000, 0xE100), mus = m.ram.slice(0xFF00, 0xFFE0), ff = m.portFF, t0 = m.tstates;
    Z.irqZ80(cpu, m.bus);
    let steps = 0, minSp = cpu.sp;
    while (!(cpu.pc === before.pc && cpu.sp === before.sp) && steps < 3000) { Z.runZ80(cpu, m.bus, 1, m); minSp = Math.min(minSp, cpu.sp); steps++; }
    if (steps >= 3000) { noRet++; return; }
    if (vars[S.V_SFX_ACTIVE - 0xE000]) sndInj++;
    maxDepth = Math.max(maxDepth, before.sp - minSp);
    for (const k of KEYS) if (cpu[k] !== before[k]) { viol++; if (!firstV) firstV = `${hex(pc)}: ${k} ${before[k]} -> ${cpu[k]}`; }
    m.ram.set(vars, 0xE000); m.ram.set(mus, 0xFF00); m.portFF = ff; m.tstates = t0;    // the interrupt's own effects undone (V_FRAMES, V_SYNC, the sound state, its time)
    inj++; pcs.add(pc);
  } });
  check('registers (IX, IY, the alternates included) unchanged by an interrupt at every instruction of fine.asm, and every picture right', viol === 0 && noRet === 0 && allSt(st) === 0 && inj > 50000 && st.publishes >= 6,
    `${fmt(inj)} interrupts at ${pcs.size} addresses, ${fmt(sndInj)} with the effect playing; deepest push ${maxDepth} bytes below SP; ${st.publishes} publishes, ${st.ons} ON, ${st.offs} OFF; ${firstV} ${st.bad.join(' | ')}`);
  const all = T.fineInstructions(), miss = [...all].filter((a) => !pcs.has(a));
  console.log(`      instructions of fine.asm interrupted: ${pcs.size} of ${all.size}; not reached in this scene: ${miss.map(T.fineLabel).join(' ')}`);
  check('the interrupt pushes at most F_GUARD bytes (with the sound tick)', maxDepth <= K.F_GUARD, `${maxDepth} of ${K.F_GUARD}`);
}

// ---- 5. memory ----------------------------------------------------------------------------------------------------------------------------------
console.log('\n--- 5. where a fine game writes ---');
{
  const R = rng(1905);
  const assets = randomAssets(R, 6);
  const insts = Array.from({ length: 12 }, () => R.int(0, assets.length - 1));
  const ticks = randomTicks(R, { n: 12, L: 50, tiles: TILES.length, modes: 0.08, fills: 0.08, play: 0 });
  const game = fineGame({ div: 1, assets, insts, tiles: TILES, map: MAP, initMode: 1, ticks, sfx: busyEffect(R, 4) });
  const ok = (a, fine) => (a >= 0x4000 && a < 0x5B00) || (a >= 0x6000 && a < 0x7B00) || (a >= K.CELL_TILE && a < K.DIRTY0 + 96) || (a >= K.SPR_TAB && a < K.SPR_TAB + 96)
    || (a >= K.DIRTY1 && a < K.DIRTY1 + 96) || (a >= K.SPR_DRAWN && a < K.SPR_DRAWN + 128) || (a >= 0xE000 && a < 0xF000 && !(a >= 0xE0FC && a < 0xE100))
    || (fine && a >= K.POOL_B && a < K.F_LTOP) || (a >= K.T3 && a < K.T3 + K.T3_LEN) || (a >= K.STACK_LIMIT && a < K.STACK_TOP) || (a >= 0xFF00 && a < 0xFFE0);
  let bad = 0, n = 0, first = '', poolB = 0;
  const POISON = [[0x5B00, 0x6000], [0x7B00, 0x8000], [K.T2_FREE, K.T2_FREE + K.T2_FREE_LEN], [0xE0FC, 0xE100]];
  const st = run(game, 200, {
    poison: (m) => { for (const [a, b] of POISON) m.ram.fill(0xA5, a, b); },
    onWrite: (m, a, v, pc, armed) => {
      if (!armed) return;
      n++;
      const fine = m.ram[S.V_FINE] === 1 || (pc >= S.M_FINE_S && pc < S.M_FINE_E);
      if (a >= K.POOL_B && a < K.F_LTOP) poolB++;
      if (!ok(a, fine)) { bad++; if (!first) first = `${hex(a)} from ${hex(pc)}`; }
    } });
  let poisonOk = true;
  for (const [a, b] of POISON) for (let x = a; x < b; x++) if (st.m.ram[x] !== 0xA5) poisonOk = false;
  check('every write after the boot is in the allowed areas (phase pool B only while fine colour is on)', bad === 0 && n > 100000 && poolB > 1000 && allSt(st) === 0, `${fmt(n)} writes, ${fmt(poolB)} into pool B, ${bad} outside${first ? ', first ' + first : ''}`);
  check('$5B00-$5FFF, $7B00-$7FFF, T2 and V_FREE2 (poisoned after the boot) untouched', poisonOk);
}

// ---- 6. a game without fine colour ---------------------------------------------------------------------------------------------------------------
console.log('\n--- 6. a game without fine colour ---');
{
  const R = rng(1906);
  const assets = [C4.randomAsset(R, 16, 16, 8), C4.randomAsset(R, 8, 8, 4)];
  const script = [];
  for (let k = 0; k < 40; k++) script.push([C4.op.show(0, 10 + 3 * k, 20 + k), C4.op.show(1, 200 - 2 * k, 100), ...(k % 5 === 0 ? [C4.op.at(1, 1), C4.op.prints('T' + k)] : [])]);
  const game = C4.scriptGame({ div: 1, assets, insts: [0, 1], tiles: TILES, script });
  const m = T.newMachine(game.dck);
  let fineRun = 0;
  for (let f = 0; f < 400; f++) {
    const end = m.frameStart + FRAME_T;
    while (m.tstates < end) { const pc = m.cpu.pc; if (pc >= S.M_FINE_S && pc < S.M_FINE_E) fineRun++; if (m.cpu.halted) break; Z.runZ80(m.cpu, m.bus, 1, m); }
    M.runFrame(m);
  }
  const obs = C4.observe(game, 60, { script });
  check('a game without fine colour never runs a byte of fine.asm; V_FINE stays 0; its pictures are the model\'s (m4-common observe)', fineRun === 0 && rd8(m, S.V_FINE) === 0 && rd16(m, S.V_TICKS) > 30 && obs.pictureBad === 0 && obs.pixelBad === 0 && obs.writeViolations === 0 && obs.pictureOk > 30,
    `fine instructions ${fineRun}; V_TICKS ${rd16(m, S.V_TICKS)}; observe: ${obs.pictureOk} pictures right, ${obs.pictureBad} wrong`);
}

finish('M19 runtime fine colour');
