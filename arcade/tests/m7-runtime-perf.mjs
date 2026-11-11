"use strict";
// m7-runtime-perf.mjs -- runtime v3 part 2, performance (TSRun, 58,688 T per refresh, no contention modelled), measured in running games with the
// real frame interrupt (every number with and without the interrupt handler's time), plus direct calls (interrupts off) for the exhaustive maxima.
// The checks are the budgets of docs/ARCADE_PLATFORMER_CONTRACT.md section 6; the numbers go into docs/ARCADE_RUNTIME_API_V3.md.
// Window fast path (docs/ARCADE_WINDOW_FASTPATH.md section 4): section 1 runs the contract's world test set (a)-(g) and checks its bounds on EVERY world
// (window_repaint worst, every band's attributes included: 1 band <= 130,000; 3 bands 2/3/11 <= 132,000; 4 bands 2/4/6/4 <= 135,000), the 53 % sky mean (at least 15 %
// below the old runtime's), the phase-0 worst (<= the old runtime's + 2,500) and prints every number; sections 2 and 3 run several of the worlds in running games.
//   node arcade/tests/m7-runtime-perf.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// ---- the world test set of docs/ARCADE_WINDOW_FASTPATH.md section 4 ---------------------------------------------------------------------------------------
const ASSETS_JSON = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../examples/runner.assets.json'), 'utf8'));
/** Tiles with random non-zero bitmaps; attribute of tile k = attrOf(k). */
const solidTiles = (r, attrOf) => Array.from({ length: 32 }, (_, k) => ({ bmp: Array.from({ length: 8 }, () => r.int(1, 255)), attr: attrOf(k) }));
const fill = (f) => { const ram = new Uint8Array(2048); for (let y = 0; y < 16; y++) for (let x = 0; x < 128; x++) ram[y * 128 + x] = f(x, y) * 8; return ram; };
/** Leap Runner's tileset and one of its worlds, as the window takes them (tile rows from the bits, the attribute of row 0). */
const runnerWorld = (name) => {
  const ts = ASSETS_JSON.tilesets.pf_tiles.tiles;
  const tiles = Array.from({ length: 32 }, (_, k) => (ts[k] ? { bmp: ts[k].rows.map((x) => parseInt(x.bits, 16)), attr: (ts[k].rows[0].bright << 6) | (ts[k].rows[0].paper << 3) | ts[k].rows[0].ink } : { bmp: Array(8).fill(0), attr: 0x28 }));
  const m = ASSETS_JSON.maps[name];
  return { tiles, ram: fill((x, y) => m.cells[y * m.w + x]) };
};
const WORLDS = [
  ['a  solid, one attribute (no blank tile)', (r) => { const tiles = solidTiles(r, () => 0x16); return { tiles, ram: fill(() => r.int(1, 31)), compress: true }; }],
  ['b  solid, random attributes', (r) => ({ tiles: W.randomWinTiles(r, 32), ram: W.randomWorld(r, 128, 32, { sky: 0 }), compress: true })],
  ['c  53 % sky, random', (r) => ({ tiles: W.randomWinTiles(r, 32), ram: W.randomWorld(r, 128, 32, { sky: 0.53 }), compress: true })],
  ['d  stripes of 2 columns, two attributes', (r) => { const tiles = solidTiles(r, (k) => (k < 16 ? 0x16 : 0x2F)); return { tiles, ram: fill((x) => ((x >> 1) & 1 ? r.int(16, 31) : r.int(1, 15))) }; }],
  ['e1 stripes of 1 column', (r) => { const tiles = solidTiles(r, (k) => (k < 16 ? 0x16 : 0x2F)); return { tiles, ram: fill((x) => (x & 1 ? r.int(16, 31) : r.int(1, 15))) }; }],
  ['e3 stripes of 3 columns', (r) => { const tiles = solidTiles(r, (k) => (k < 16 ? 0x16 : 0x2F)); return { tiles, ram: fill((x) => (Math.floor(x / 3) & 1 ? r.int(16, 31) : r.int(1, 15))) }; }],
  ['f  sky over a solid ground (rows 0-9 tile 0)', (r) => { const tiles = solidTiles(r, () => 0x16); tiles[0] = { bmp: Array(8).fill(0), attr: 0x28 }; return { tiles, ram: fill((x, y) => (y < 10 ? 0 : r.int(1, 31))), compress: true }; }],
  ['g1 Leap Runner level 1 (the platformer\'s world)', () => runnerWorld('pf_world')],
  ['g2 Leap Runner level 2', () => runnerWorld('rn_world2')],
  ['g3 Leap Runner level 3', () => runnerWorld('rn_world3')],
  ['g4 Leap Runner level 4', () => runnerWorld('rn_world4')],
];
// the bounds of docs/ARCADE_WINDOW_FASTPATH.md section 4 as amended 2026-11-11 (the owner kept option 2 with these), per layout in the order 1 band / 3 bands / 4 bands
const LNAMES = ['1 band', '3 bands 2/3/11 (1/4, 1/2, 1)', '4 bands 2/4/6/4 (1/4, 1/2, 1, 2)'];
const BOUND_PLAIN = [130000, 132000, 135000];              // direct calls, worlds without dense colour boundaries (a, c, f, g)
const BOUND_DENSE = [140000, 141000, 142000];              // direct calls, worlds of dense colour boundaries (b, d, e); also in a running game on b and d
const BOUND_GAME_A = [131000, 133000, 135000];             // in a running game, the interrupt included, world a
const TICK_BOUND = { plain: 3 * FRAME_T, dense: 177000 };  // the contract's tick: 53 % sky, a, f <= 176,064; b <= 177,000
const MEAN_G = 0.88;                                       // Leap Runner's worlds (g): bitmap-only mean at least 12 % below the pre-change mean of the same layout
const isDense = (wname) => /^(b|d|e)/.test(wname);
// the old runtime's numbers (main 0e6f777, measured with this file's world (c) and the same loop: 53 % sky, bitmap only, mean over every camera into both files; and the worst
// of the cameras where every band is at phase 0, bitmap only / with the attribute pass), the base of the "15 % below" and "+ 2,500" bounds
const OLD = {
  '1 band': { mean: 107753, p0: 77863, p0attr: 90471 },
  '3 bands 2/3/11 (1/4, 1/2, 1)': { mean: 109385, p0: 79423, p0attr: 92243 },
  '4 bands 2/4/6/4 (1/4, 1/2, 1, 2)': { mean: 109066, p0: 80175, p0attr: 93101 },
};

// ---- 1. window_repaint, exhaustive maxima by direct calls (interrupts off), every camera 0..cam_max into both files ---------------------------------------
console.log('1. window_repaint by direct calls (interrupts off), every camera 0..cam_max into both files, on the world test set (docs/ARCADE_WINDOW_FASTPATH.md section 4):');
const direct = {};
for (const [name, bands] of Object.entries(LAYOUTS)) {
  for (const [wname, mk] of WORLDS) {
    const r = rng(7);
    const wd = mk(r);
    const win = { cx: 4, cy: 4, worldW: 128, bands, ram: wd.ram };
    const m = W.bootIdle(W.winGame({ tiles: wd.tiles, win, script: [] }));
    const cmax = rd16(m, S.W_CAMMAX);
    let withAttr = 0, bitmap = 0, p0 = 0, p0attr = 0, best = Infinity, sum = 0, n = 0;
    for (let cam = 0; cam <= cmax; cam++) for (const file of [0, 1]) {
      wr16(m, S.V_CAM, cam); m.ram[S.V_HIDDEN] = file; m.ram[S.V_HOFF] = file ? 0x20 : 0;
      for (let k = 0; k < 8; k++) m.ram[S.W_AC + k] = 0xFF;        // every band's attribute pass
      const ta = W.callRoutine(m, S.window_repaint).t;
      withAttr = Math.max(withAttr, ta);
      const t = W.callRoutine(m, S.window_repaint).t;               // the same again: no attribute pass (the file shows these col0s now)
      bitmap = Math.max(bitmap, t); best = Math.min(best, t); sum += t; n++;
      if (cam % 32 === 0) { p0 = Math.max(p0, t); p0attr = Math.max(p0attr, ta); }   // every band at phase 0 (1/4: cam 32 k .. 32 k + 3, 1/2: 16 j, 1: 8 i, 2: 4 h)
    }
    direct[`${name}/${wname}`] = { withAttr, bitmap, mean: sum / n, best, p0, p0attr };
    console.log(`  ${name.padEnd(34)} ${wname.padEnd(46)}: worst with every band's attributes ${fmt(withAttr)}, bitmap only worst ${fmt(bitmap)} / mean ${fmt(sum / n)} / best ${fmt(best)}; phase 0: ${fmt(p0)} (${fmt(p0attr)} with attributes)`);
  }
}
LNAMES.forEach((name, li) => {
  for (const [what, pick, bound] of [['worlds without dense colour boundaries (a, c, f, g)', (w) => !isDense(w), BOUND_PLAIN[li]], ['worlds of dense colour boundaries (b, d, e)', isDense, BOUND_DENSE[li]]]) {
    const all = WORLDS.map(([w]) => w).filter(pick).map((w) => [w, direct[`${name}/${w}`].withAttr]);
    const worst = all.reduce((a, b) => (b[1] > a[1] ? b : a));
    check(`${name}: window_repaint worst (every band's attributes included, every camera, both files) <= ${fmt(bound)} T on the ${what}; the worst is ${worst[0].slice(0, 2).trim()} at ${fmt(worst[1])}`, worst[1] <= bound, `${worst[0]}: ${fmt(worst[1])}`);
  }
});
for (const name of LNAMES) {
  const o = OLD[name], d = direct[`${name}/${WORLDS[2][0]}`];
  console.log(`  53 % sky (c), ${name}: bitmap-only mean ${fmt(d.mean)} (the pre-change ${fmt(o.mean)}: ${(100 * (1 - d.mean / o.mean)).toFixed(1)} % below; reported only)`);
  const gs = WORLDS.filter(([w]) => w.startsWith('g')).map(([w]) => [w, direct[`${name}/${w}`].mean]);
  for (const [w, mean] of gs) console.log(`  Leap Runner ${w.slice(0, 2)}, ${name}: bitmap-only mean ${fmt(mean)} (${(100 * (1 - mean / o.mean)).toFixed(1)} % below the pre-change ${fmt(o.mean)})`);
  check(`${name}: the bitmap-only mean on each of Leap Runner's four worlds (g) is at least 12 % below the pre-change mean ${fmt(o.mean)}`, gs.every(([, mean]) => mean <= MEAN_G * o.mean), gs.map(([w, mean]) => `${w.slice(0, 2)} ${(100 * (1 - mean / o.mean)).toFixed(1)} %`).join(', '));
}
for (const name of Object.keys(LAYOUTS)) {
  const o = OLD[name];
  const worst = Math.max(...WORLDS.map(([w]) => direct[`${name}/${w}`].p0)), worstA = Math.max(...WORLDS.map(([w]) => direct[`${name}/${w}`].p0attr));
  console.log(`  phase 0, ${name}: worst over the worlds ${fmt(worst)} (${fmt(worstA)} with the attribute pass); the old runtime's ${fmt(o.p0)} (${fmt(o.p0attr)})`);
  check(`${name}: window_repaint with every band at phase 0 is <= the old runtime's + 2,500 T on every world (${fmt(o.p0)} + 2,500; bitmap only and with the attribute pass)`, worst <= o.p0 + 2500 && worstA <= o.p0attr + 2500, `${fmt(worst)} / ${fmt(worstA)}`);
}

// ---- 2. the same in a running game with the real interrupt: the camera moves 7 px a tick and a SETWORLD changes an attribute every tick ---
console.log('\n2. In a running game (the real frame interrupt; frame_div 3): camera + 7 px a tick, every band\'s attributes every tick (a SETWORLD that changes a tile\'s attribute), worlds a, b and d:');
const inGame = {};
for (const [name, bands] of Object.entries(LAYOUTS)) {
  for (const wi of [0, 1, 3]) {
    const r = rng(8);
    const wd = WORLDS[wi][1](r);
    const tiles = wd.tiles;
    tiles[1].attr = 0x0F; tiles[2].attr = 0x30;
    const win = { cx: 4, cy: 4, worldW: 128, bands, ram: wd.ram };
    const script = Array.from({ length: 110 }, (_, k) => [op.camera(7 * k), op.setworld(5, 5, 1 + (k & 1))]);
    const g = W.winGame({ div: 3, tiles, win, script });
    const { spans } = W.timeRun(g, 360, { repaint: S.window_repaint });
    const sp = spans.repaint.slice(4);
    inGame[`${name}/${wi}`] = { t: mx(sp.map((s) => s.t)), tx: mx(sp.map((s) => s.tx)) };
    console.log(`  ${name.padEnd(34)} world ${WORLDS[wi][0].slice(0, 2).trim()}: worst ${fmt(inGame[`${name}/${wi}`].tx)} without the interrupt's time, ${fmt(inGame[`${name}/${wi}`].t)} with it (${sp.length} ticks)`);
  }
}
const inGameWorst = (name) => Math.max(...[0, 1, 3].map((wi) => inGame[`${name}/${wi}`].t));       // printed only (the tick's "with the worst repaint")
check('in a running game (the interrupt included), world a: 1 band <= 131,000 T, 3 bands <= 133,000 T, 4 bands <= 135,000 T', LNAMES.every((n, li) => inGame[`${n}/0`].t <= BOUND_GAME_A[li]), LNAMES.map((n) => fmt(inGame[`${n}/0`].t)).join(' / '));
check('in a running game (the interrupt included), worlds b and d: 1 band <= 140,000 T, 3 bands <= 141,000 T, 4 bands <= 142,000 T', LNAMES.every((n, li) => Math.max(inGame[`${n}/1`].t, inGame[`${n}/3`].t) <= BOUND_DENSE[li]), LNAMES.map((n) => fmt(Math.max(inGame[`${n}/1`].t, inGame[`${n}/3`].t))).join(' / '));

// ---- 3. the platformer-like tick (contract section 6): player 16x24 + 5 enemies 16x16 + a shot, HUD, collision, camera following -------
console.log('\n3. The platformer-like tick: 3 bands 2/3/11, a 53 % sky world, player 16x24 (4 phases, 8 frames), 5 enemies 16x16 (4 phases, 2 frames), a shot 8x8 (8 phases),');
console.log('   4 coins 8x8 (8 phases, 4 frames) in some runs, the camera following the player, the score printed in the HUD every tick, 4 TILEHIT + 2 TILEFLAGS a tick:');
const results = {};
for (const [label, coins, wi] of [['53 % sky, no coins', 0, 2], ['53 % sky, 4 coins', 4, 2], ['solid world (no sky), no coins', 0, 1], ['one attribute (a), no coins', 0, 0], ['sky over a solid ground (f), no coins', 0, 6]]) {
  const r = rng(9);
  const wd = WORLDS[wi][1](r);
  const tiles = wd.tiles, ram = wd.ram;
  if (wd.compress) for (let y = 0; y < 16; y++) for (let x = 0; x < 128; x++) ram[y * 128 + x] = ram[y * 128 + (x & ~7)];   // runs of 8: the RLE world fits the test image
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
  const bound = w.map((x, i) => x.t - feT[i].t - rp[i].t).reduce((p, v) => Math.max(p, v), 0) + inGameWorst('3 bands 2/3/11 (1/4, 1/2, 1)') + 15000;
  const per = (k) => avg(spans[k].slice(6, 44).map((s) => s.tx));
  console.log(`  ${label}: runtime part of a tick worst ${fmt(mx(rtPart))} (mean ${fmt(avg(rtPart))}), + 15,000 of game logic = ${fmt(mx(rtPart) + 15000)}; with the worst repaint of the layout: ${fmt(bound)}`);
  console.log(`     means: repaint ${fmt(per('repaint'))}, sprites ${fmt(per('draw'))} (${insts.length} drawn), ring repair ${fmt(per('ring'))}, redraw_dirty ${fmt(per('redraw'))}, dirty mask ${fmt(per('mask'))}; ${rd16(m, S.FC_MISSES)} frames built (cache misses); the whole measured tick (the script's own logic ${fmt(avg(feT.map((x) => x.t)))}) worst ${fmt(mx(w.map((x) => x.t)))}`);
  results[label] = { worst: mx(rtPart) + 15000, bound };
}
{
  const plain = ['53 % sky, no coins', 'one attribute (a), no coins', 'sky over a solid ground (f), no coins'].map((k) => [k, results[k]]);
  const dense = results['solid world (no sky), no coins'];
  const wp = plain.reduce((a, b) => (b[1].worst > a[1].worst ? b : a));
  console.log(`  ("with the worst repaint of the layout" figures, reported only: ${[...plain, ['solid world (b)', dense]].map(([k, v]) => `${k.replace(', no coins', '')} ${fmt(v.bound)}`).join('; ')})`);
  check(`the contract's tick (player 16x24 + 5 enemies 16x16 + a shot, 15,000 T of game logic, the real interrupt), measured: <= 176,064 T on 53 % sky, one attribute (a) and sky over ground (f); <= 177,000 T on the solid random-colour world (b) (the stripes worlds' RLE leaves no room for the script)`,
    wp[1].worst <= TICK_BOUND.plain && dense.worst <= TICK_BOUND.dense, `plain worst ${fmt(wp[1].worst)} (${wp[0]}), b ${fmt(dense.worst)}`);
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
