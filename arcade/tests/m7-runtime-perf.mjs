"use strict";
// m7-runtime-perf.mjs -- runtime v3 part 2, performance (TSRun, 58,688 T per refresh, no contention modelled), measured in running games with the
// real frame interrupt (every number with and without the interrupt handler's time), plus direct calls (interrupts off) for the exhaustive maxima.
// The checks are the budgets of docs/ARCADE_PLATFORMER_CONTRACT.md section 6; the numbers go into docs/ARCADE_RUNTIME_API_V3.md.
//   node arcade/tests/m7-runtime-perf.mjs
import * as W from './m7-common.mjs';
import { rng } from './m3-scenes.mjs';
const { makeChecks, rd16, wr16, op, FRAME_T } = W;

const { check, finish } = makeChecks();
const rt = W.runtime();
const S = rt.syms;
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const mx = (a) => (a.length ? Math.max(...a) : 0), avg = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
console.log(`Runtime v3 part 2 performance (T-states; a refresh is ${FRAME_T} T, 3 refreshes ${3 * FRAME_T})\n`);
console.log(`Size: runtime ${rt.usage.per[0] + rt.usage.per[1]} of 16,384 bytes in DOCK chunks 0-1; scroll.asm ${rt.usage.mods.find((m) => m.name === 'scroll').size} bytes\n`);

const LAYOUTS = {
  '1 band': [{ rows: 16, code: 3 }],
  '3 bands 2/3/11 (1/4, 1/2, 1)': [{ rows: 2, code: 1 }, { rows: 3, code: 2 }, { rows: 11, code: 3 }],
  '4 bands 2/4/6/4 (1/4, 1/2, 1, 2)': [{ rows: 2, code: 1 }, { rows: 4, code: 2 }, { rows: 6, code: 3 }, { rows: 4, code: 4 }],
};

// ---- 1. window_repaint, exhaustive maxima by direct calls (interrupts off, as the spikes were measured) ------------------------------
console.log('1. window_repaint by direct calls (interrupts off), every camera 0..cam_max into both files; a solid world (no tile 0) and a 53 % sky one:');
const direct = {};
for (const [name, bands] of Object.entries(LAYOUTS)) {
  for (const sky of [0, 0.53]) {
    const r = rng(7);
    const win = { cx: 4, cy: 4, worldW: 128, bands, ram: W.randomWorld(r, 128, 32, { sky }) };
    const m = W.bootIdle(W.winGame({ tiles: W.randomWinTiles(r, 32), win, script: [] }));
    const cmax = rd16(m, S.W_CAMMAX);
    let withAttr = 0, bitmap = 0, p0 = Infinity, sum = 0, n = 0;
    for (let cam = 0; cam <= cmax; cam++) for (const file of [0, 1]) {
      wr16(m, S.V_CAM, cam); m.ram[S.V_HIDDEN] = file; m.ram[S.V_HOFF] = file ? 0x20 : 0;
      for (let k = 0; k < 8; k++) m.ram[S.W_AC + k] = 0xFF;        // every band's attribute pass
      withAttr = Math.max(withAttr, W.callRoutine(m, S.window_repaint).t);
      const t = W.callRoutine(m, S.window_repaint).t;               // the same again: no attribute pass (the file shows these col0s now)
      bitmap = Math.max(bitmap, t); p0 = Math.min(p0, t); sum += t; n++;
    }
    direct[`${name}/${sky}`] = { withAttr, bitmap };
    console.log(`  ${name.padEnd(34)} ${sky ? '53 % sky' : 'solid   '}: worst with every band's attributes ${fmt(withAttr)}, bitmap only worst ${fmt(bitmap)} / mean ${fmt(sum / n)} / best ${fmt(p0)}`);
  }
}
check('1 band: window_repaint worst (attributes of a cell-boundary tick included) <= 130,000 T (direct calls)', direct['1 band/0'].withAttr <= 130000, fmt(direct['1 band/0'].withAttr));
check('4 bands: window_repaint worst (attributes included) <= 135,000 T (direct calls)', direct['4 bands 2/4/6/4 (1/4, 1/2, 1, 2)/0'].withAttr <= 135000, fmt(direct['4 bands 2/4/6/4 (1/4, 1/2, 1, 2)/0'].withAttr));

// ---- 2. the same in a running game with the real interrupt: the camera moves 7 px a tick and a SETWORLD changes an attribute every tick ---
console.log('\n2. In a running game (the real frame interrupt; frame_div 3): camera + 7 px a tick, every band\'s attributes every tick (a SETWORLD that changes a tile\'s attribute):');
const inGame = {};
for (const [name, bands] of Object.entries(LAYOUTS)) {
  const r = rng(8);
  const tiles = W.randomWinTiles(r, 32);
  tiles[1].attr = 0x0F; tiles[2].attr = 0x30;
  const win = { cx: 4, cy: 4, worldW: 128, bands, ram: W.randomWorld(r, 128, 32, { sky: 0 }) };
  const script = Array.from({ length: 110 }, (_, k) => [op.camera(7 * k), op.setworld(5, 5, 1 + (k & 1))]);
  const g = W.winGame({ div: 3, tiles, win, script });
  const { spans } = W.timeRun(g, 360, { repaint: S.window_repaint });
  const sp = spans.repaint.slice(4);
  inGame[name] = { t: mx(sp.map((s) => s.t)), tx: mx(sp.map((s) => s.tx)) };
  console.log(`  ${name.padEnd(34)}: worst ${fmt(inGame[name].tx)} without the interrupt's time, ${fmt(inGame[name].t)} with it (${sp.length} ticks)`);
}
check('in a running game: 1 band <= 130,000 T and 4 bands <= 135,000 T, the interrupt\'s time included', inGame['1 band'].t <= 130000 && inGame['4 bands 2/4/6/4 (1/4, 1/2, 1, 2)'].t <= 135000,
  `${fmt(inGame['1 band'].t)} / ${fmt(inGame['4 bands 2/4/6/4 (1/4, 1/2, 1, 2)'].t)}`);

// ---- 3. the platformer-like tick (contract section 6): player 16x24 + 5 enemies 16x16 + a shot, HUD, collision, camera following -------
console.log('\n3. The platformer-like tick: 3 bands 2/3/11, a 53 % sky world, player 16x24 (4 phases, 8 frames), 5 enemies 16x16 (4 phases, 2 frames), a shot 8x8 (8 phases),');
console.log('   4 coins 8x8 (8 phases, 4 frames) in some runs, the camera following the player, the score printed in the HUD every tick, 4 TILEHIT + 2 TILEFLAGS a tick:');
const results = {};
for (const [label, coins, sky] of [['53 % sky, no coins', 0, 0.53], ['53 % sky, 4 coins', 4, 0.53], ['solid world (no sky), no coins', 0, 0]]) {
  const r = rng(9);
  const tiles = W.randomWinTiles(r, 32);
  const ram = W.randomWorld(r, 128, 32, { sky });
  for (let y = 0; y < 16; y++) for (let x = 0; x < 128; x++) ram[y * 128 + x] = ram[y * 128 + (x & ~7)];   // runs of 8: the RLE world fits the test image (the repaint cost does not depend on the tiles)
  const win = { cx: 4, cy: 4, worldW: 128, bands: LAYOUTS['3 bands 2/3/11 (1/4, 1/2, 1)'], ram, flags: Array.from({ length: 32 }, (_, t) => t & 3) };
  const assets = [W.randomAsset(r, 16, 24, 4, 8), W.randomAsset(r, 16, 16, 4, 2), W.randomAsset(r, 8, 8, 8, 1), W.randomAsset(r, 8, 8, 8, 4)];
  const insts = [0, 1, 1, 1, 1, 1, 2, ...Array(coins).fill(3)];
  const script = [];
  let px = 100, cam = 0;
  for (let k = 0; k < 44; k++) {
    px += 3; cam = Math.max(0, px - 88);
    const t = [op.camera(cam), op.showf(0, px, 70 + (k % 9), (k >> 1) & 7)];
    for (let e = 0; e < 5; e++) t.push(op.showf(1 + e, cam + 20 + 37 * e + (k % 5), 40 + 13 * e, (k >> 2) & 1));
    t.push(op.show(6, px + 20 + 5 * (k % 20), 80));
    for (let c = 0; c < coins; c++) t.push(op.showf(7 + c, cam + 30 + 40 * c, 20, (k + c) & 3));
    t.push(op.tilehit(px, 70, 16, 24, 1), op.tilehit(px, 94, 16, 1, 3), op.tilehit(px - 1, 70, 1, 24, 1), op.tilehit(px + 16, 70, 1, 24, 1), op.tileflags(px + 8, 95), op.tileflags(px, 69));
    t.push(op.at(1, 2), op.prints('SCORE'), op.printn(k * 10));
    script.push(t);
  }
  // the stand-in for the rest of the game logic: frame_entry is measured, and SPIN tops it up to 15,000 T
  const g0 = W.winGame({ div: 3, tiles, win, assets, insts, script });
  const fe = g0.gsyms.frame_entry;
  const probe = W.timeRun(g0, 120, { fe });
  const feMean = avg(probe.spans.fe.slice(4).map((s) => s.tx));
  const spinN = Math.max(0, Math.round((15000 - feMean) / 26));
  script.forEach((t) => t.push(op.spin(spinN)));
  const g = W.winGame({ div: 3, tiles, win, assets, insts, script });
  const { spans, work, m } = W.timeRun(g, 150, { fe, repaint: S.window_repaint, draw: S.win_draw_all, ring: S.ring_repair, redraw: S.redraw_dirty, mask: S.win_mask_dirty });
  const w = work.slice(6, 44), feT = spans.fe.slice(6, 44), rp = spans.repaint.slice(6, 44);
  // the runtime's part of a tick = the tick work minus frame_entry (the script interpreter, our stand-in for compiled code, costs more than the
  // contract's 15,000 T: its time is replaced by exactly 15,000); the bound replaces the tick's repaint by the worst repaint of this layout (section 2)
  const rtPart = w.map((x, i) => x.t - feT[i].t);
  const bound = w.map((x, i) => x.t - feT[i].t - rp[i].t).reduce((p, v) => Math.max(p, v), 0) + inGame['3 bands 2/3/11 (1/4, 1/2, 1)'].t + 15000;
  const per = (k) => avg(spans[k].slice(6, 44).map((s) => s.tx));
  console.log(`  ${label}: runtime part of a tick worst ${fmt(mx(rtPart))} (mean ${fmt(avg(rtPart))}), + 15,000 of game logic = ${fmt(mx(rtPart) + 15000)}; with the worst repaint of the layout: ${fmt(bound)}`);
  console.log(`     means: repaint ${fmt(per('repaint'))}, sprites ${fmt(per('draw'))} (${insts.length} drawn), ring repair ${fmt(per('ring'))}, redraw_dirty ${fmt(per('redraw'))}, dirty mask ${fmt(per('mask'))}; ${rd16(m, S.FC_MISSES)} frames built (cache misses); the whole measured tick (the script's own logic ${fmt(avg(feT.map((x) => x.t)))}) worst ${fmt(mx(w.map((x) => x.t)))}`);
  results[label] = { worst: mx(rtPart) + 15000, bound };
}
{
  const r = [results['53 % sky, no coins'], results['solid world (no sky), no coins']].reduce((a, b) => (b.bound > a.bound ? b : a));
  check('the contract\'s tick (player 16x24 + 5 enemies 16x16 + a shot, 15,000 T of game logic, the real interrupt) fits 3 refreshes: <= 176,064 T, measured and with the worst repaint',
    r.worst <= 3 * FRAME_T && r.bound <= 3 * FRAME_T, `${fmt(r.worst)} measured, ${fmt(r.bound)} bound`);
}

// ---- 4. sprites and ring repair --------------------------------------------------------------------------------------------------------
console.log('\n4. Sprites in window mode (win_draw_all / sprites drawn) and ring repair (per repaired cell, draw_cell included):');
{
  const r = rng(10);
  const tiles = W.randomWinTiles(r, 32);
  const win = { cx: 4, cy: 4, worldW: 128, bands: LAYOUTS['1 band'], ram: W.randomWorld(r, 128, 32) };
  const assets = [W.randomAsset(r, 16, 24, 4, 1), W.randomAsset(r, 16, 16, 8, 1), W.randomAsset(r, 8, 8, 8, 1)];
  for (const [label, a, pos] of [['16x24, 4 phases, unaligned, inside the window', 0, (k, i) => [41 + 2 * ((k + i) % 5) * 2 + 2 * i * 20, 21 + 3 * i + (k % 3)]],
    ['16x16, 8 phases, inside', 1, (k, i) => [37 + i * 20 + k % 7, 33 + 9 * i + (k % 5)]], ['8x8, 8 phases, inside', 2, (k, i) => [31 + i * 20 + k % 7, 41 + 9 * i]],
    ['16x24 straddling the left edge (ring repair)', 0, (k, i) => [-6 - (k % 4), 10 + 26 * i]]]) {
    const script = Array.from({ length: 40 }, (_, k) => Array.from({ length: 4 }, (_, i) => { const [x, y] = pos(k, i); return op.show(i, x, y); }));
    const g = W.winGame({ div: 2, tiles, win, assets, insts: [a, a, a, a], script });
    const { spans } = W.timeRun(g, 90, { draw: S.win_draw_all, ring: S.ring_repair, cell: S.draw_cell });
    const d = avg(spans.draw.slice(4).map((s) => s.tx)) / 4, rr = spans.ring.slice(4).map((s) => s.tx), cells = spans.cell.slice(4).length / Math.max(1, spans.ring.slice(4).length);
    const cellT = avg(spans.cell.slice(4).map((s) => s.tx));
    const perCell = cells ? (avg(rr) - cells * cellT) / cells : 0;
    console.log(`  ${label.padEnd(46)}: draw ${fmt(d)} T a sprite${avg(rr) > 30 ? `; ring repair ${fmt(avg(rr))} T a tick for ${cells.toFixed(1)} cells: draw_cell ${fmt(cellT)} + ${fmt(perCell)} T a cell` : ''}`);
    if (label.startsWith('16x24, 4')) check('a 16 x 24 sprite, 4 phases, unaligned, drawn in window mode: <= 5,200 T (culling and screen position included)', d <= 5200, `${fmt(d)} T`);
    if (label.includes('ring')) check('ring repair: <= 600 T per repaired cell beyond draw_cell itself', perCell <= 600 && cells > 1, `${fmt(perCell)} T over ${cells.toFixed(1)} cells a tick`);
  }
}
finish('runtime v3 part 2 perf');
