"use strict";
// m6-runtime-perf.mjs -- runtime v3 part 1, performance: T-states on TSRun's clock (58,688 T per refresh), measured on the real machine with the frame
// loop's own erase_all / draw_all spans (the m4-runtime-perf.mjs method), plus direct calls of build_frame / fc_miss / RT_SHOW / RT_SHOWF.  The numbers
// are printed (they go into docs/ARCADE_RUNTIME_API_V3.md); the checks bound them by the contract (section 2: a 16 x 24 sprite, 4 phases, unaligned,
// drawn <= 5,200 T; a 16 x 16 as v2, 3,339 T draw / 2,096 T erase, within +5 %).
//   node arcade/tests/m6-runtime-perf.mjs
import * as C from './m6-common.mjs';
import { rng } from './m3-scenes.mjs';
const { M, Z, FRAME_T, makeChecks, rd8, rd16, op } = C;

const { check, finish } = makeChecks();
const rt = C.runtime();
const S = rt.syms;
console.log(`Runtime v3 part 1 performance (T-states; a refresh is ${FRAME_T} T)\n`);
console.log(`Size: runtime ${rt.usage.per[0] + rt.usage.per[1]} of 16,384 bytes in DOCK chunks 0-1 (v2: 9,337)\n`);

const fill = [];
for (let row = 0; row < 24; row++) fill.push(op.at(row, 0), op.prints('0123456789ABCDEFGHIJKLMNOPQRSTU'), op.printc(65 + (row % 26)));
/** n instances of one asset moving every tick (positions from posOf, frames from frameOf); per-sprite erase / draw averages and the tick work. */
function measure(asset, n, posOf, { ticks = 30, skip = 6, frameOf = null } = {}) {
  const walk = [];
  for (let t = 0; t < ticks; t++) walk.push(Array.from({ length: n }, (_, i) => { const [x, y] = posOf(t, i); return frameOf ? op.showf(i, x, y, frameOf(t, i)) : op.show(i, x, y); }));
  const script = [fill, [], [], ...walk];
  const game = C.scriptGame({ assets: [asset], insts: Array(n).fill(0), script });
  const st = C.observe6(game, (ticks + 8) * Math.max(2, Math.ceil(n / 8)), { script: null, checkPicture: false, untilTicks: ticks + 3 });
  const a = skip + 3, b = ticks + 3;
  const e = st.eraseT.slice(a, b), d = st.drawT.slice(a, b), w = st.work.slice(a, b), r = st.redrawT.slice(a, b);
  return { erase: C.avg(e) / n, draw: C.avg(d) / n, eraseAll: C.avg(e), drawAll: C.avg(d), work: C.avg(w), max: Math.max(...w), redraw: C.avg(r), misses: rd16(st.m, S.FC_MISSES) };
}
const R = rng(99);
const art = (w, h, phases, nf = 1) => C.randomAsset(R, w, h, phases, nf);
const spread = (t, i) => [((i * 53 + t * 7 + 3) % 200) + (t & 7 ? 1 : 0), ((i * 29 + t * 5 + 3) % 140) + 1];
const aligned = (t, i) => [8 * ((i * 5 + t) % 24), 8 * ((i * 3 + t) % 17)];
const unal = (t, i) => [((i * 53 + t * 7) % 190) + 1 + ((i + t) % 7), ((i * 29 + t * 5) % 130) + 1 + ((i + 2 * t) % 6)];
const unalOf = (gran) => (t, i) => { let [x, y] = unal(t, i); x = x & ~(gran - 1); if ((x & 7) === 0) x += gran; return [x, y]; };   // never a multiple of 8 after rounding

console.log('Per visible sprite (averages over positions that change every tick; erase_all and draw_all divided by the number of sprites):');
console.log('  asset                                erase   draw   (aligned x and y: erase / draw)          v2');
const res = {};
const V2 = { '16x16, 8 phases': '2,096 / 3,339 (1,196 / 2,574)', '16x16, 2 phases': '1,868 / 3,049 (1,196 / 2,574)', '8x8, 8 phases': '1,091 / 1,772 (536 / 1,317)' };
for (const [label, w, h, ph, pos] of [['16x16, 8 phases', 16, 16, 8, spread], ['16x16, 2 phases', 16, 16, 2, spread], ['8x8, 8 phases', 8, 8, 8, spread],
  ['16x24, 4 phases, unaligned', 16, 24, 4, unalOf(2)], ['16x16, 4 phases, unaligned', 16, 16, 4, unalOf(2)], ['24x16, 4 phases, unaligned', 24, 16, 4, unalOf(2)],
  ['32x32, 4 phases, unaligned', 32, 32, 4, unalOf(2)], ['32x48, 2 phases, unaligned', 32, 48, 2, unalOf(4)], ['8x8, 1 phase', 8, 8, 1, spread]]) {
  const m = measure(art(w, h, ph), 8, pos);
  const al = measure(art(w, h, ph), 8, aligned);
  res[label] = { m, al };
  console.log(`  ${label.padEnd(34)} ${String(Math.round(m.erase)).padStart(6)} ${String(Math.round(m.draw)).padStart(6)}   (${Math.round(al.erase)} / ${Math.round(al.draw)})${''.padEnd(22)}${V2[label] ?? ''}`);
}
const r16 = res['16x16, 8 phases'].m, r24 = res['16x24, 4 phases, unaligned'].m;
check('a 16 x 24 sprite, 4 phases, unaligned, drawn: <= 5,200 T (contract section 2)', r24.draw <= 5200, `${Math.round(r24.draw)} T`);
check('a 16 x 16 sprite at 8 phases: draw within +5 % of v2\'s 3,339 T, erase within +5 % of v2\'s 2,096 T', r16.draw <= 3339 * 1.05 && r16.erase <= 2096 * 1.05, `${Math.round(r16.draw)} / ${Math.round(r16.erase)} T`);

console.log('\nA frame change of a cached frame costs nothing extra (every frame in its slot): 16x24, 4 phases, 4 frames, a new frame every tick:');
{
  const m = measure(art(16, 24, 4, 4), 8, unalOf(2), { frameOf: (t, i) => (t + i) % 4 });
  console.log(`  erase ${Math.round(m.erase)}  draw ${Math.round(m.draw)}  (misses: ${m.misses})`);
  check('frames changing every tick, all in slots: no miss, the draw costs what a still frame costs (within 1 %)', m.misses === 0 && m.draw <= r24.draw * 1.01, `${Math.round(m.draw)} vs ${Math.round(r24.draw)}`);
}

console.log('\nWorst-case tick: 16 visible 16x16 sprites, all moving every tick, never aligned, over a screen full of text (ISR excluded; 3 refreshes = ' + 3 * FRAME_T + ' T):');
const worst = {};
for (const ph of [8, 4]) {
  const m = measure(art(16, 16, ph), 16, (t, i) => [((i * 53 + t * 7) % 216) + 1 + ((i + t) % 7), ((i * 29 + t * 5) % 160) + 1 + ((i + 2 * t) % 6)], { ticks: 24 });
  worst[ph] = m;
  console.log(`  ${ph} phases: tick work avg ${Math.round(m.work)}, max ${m.max} T (${(m.max / FRAME_T).toFixed(2)} refreshes); erase_all ${Math.round(m.eraseAll)}, redraw_dirty ${Math.round(m.redraw)}, draw_all ${Math.round(m.drawAll)} T   (v2: ${ph === 8 ? '105,903' : '102,365'})`);
}
check('the worst-case tick (16 sprites, 8 phases) within +5 % of v2 (105,903 T) and inside 3 refreshes with room for the game', worst[8].max <= 105903 * 1.05 && worst[8].max < 0.8 * 3 * FRAME_T, `max ${worst[8].max} T`);

// ---- direct calls: build_frame (a cache miss's work), RT_SHOW / RT_SHOWF -----------------------------------------------------------
console.log('\nbuild_frame: the pre-shifted copies of one frame (what a cache miss costs, plus fc_miss\'s victim search):');
{
  const kinds = [['8x8, 8 phases', 8, 8, 8], ['16x16, 4 phases', 16, 16, 4], ['16x16, 8 phases', 16, 16, 8], ['16x24, 4 phases', 16, 24, 4], ['24x16, 4 phases', 24, 16, 4], ['32x32, 4 phases', 32, 32, 4], ['32x48, 2 phases', 32, 48, 2]];
  const assets = kinds.map(([, w, h, ph]) => art(w, h, ph, 2));
  const game = C.scriptGame({ assets, insts: kinds.map((_, i) => i), script: [] });
  const m = C.run(game, 40);
  for (let i = 0; i < 400000 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);
  const pool = C.poolState(m, S, kinds.length);
  const rows = [];
  kinds.forEach(([label], i) => {
    const e = pool[i].ftab;                                        // frame 0's entry: its slot is set (built at boot); rebuild it
    const t = C.callRoutine(m, S.build_frame, { a: i, hl: e, sentinels: false }).t;
    const a = C.normAsset(assets[i]);
    rows.push([label, t, a.h, t / a.h]);
    console.log(`  ${label.padEnd(18)} ${String(t).padStart(7)} T  (${a.phases - 1} copies of ${a.h} rows: ${Math.round(t / a.h)} T a row; ${(t / FRAME_T).toFixed(2)} refreshes)`);
  });
  const b24 = rows.find((r) => r[0] === '16x24, 4 phases')[1];
  check('build_frame of a 16 x 24, 4-phase frame (a miss of the reference player) costs under 0.6 refreshes', b24 < 0.6 * FRAME_T, `${b24} T`);
  // fc_miss: the victim search on top (2 frames, 1 instance each: K = 2 = nframes, so make frame 1 uncached by hand)
  const i = 3, e = pool[i].ftab, slot0 = rd16(m, e + 2);
  m.ram[e + 4 + 2] = 0; m.ram[e + 4 + 3] = 0; m.ram[S.SPR_TAB + 8 * i] = 1; m.ram[S.SPR_TAB + 8 * i + 6] = 1;
  m.ram[S.V_FTE] = (e + 4) & 255; m.ram[S.V_FTE + 1] = (e + 4) >> 8;
  const r = C.callRoutine(m, S.fc_miss, { a: i });
  console.log(`  fc_miss of a 16x24, 4-phase frame (7 instances scanned, 2 frames): ${r.t} T in all = build_frame + ${r.t - b24} T`);
  check('fc_miss returns the victim\'s slot (frame 0: no visible instance shows it) and keeps IX, IY and the alternates', r.hl === slot0 && r.preserved && rd16(m, e + 2) === 0 && rd16(m, e + 6) === slot0, `HL ${C.hex(r.hl)} (slot ${C.hex(slot0)})`);
}
console.log('\nRT_SHOW / RT_SHOWF (CALL and RET included):');
{
  const game = C.scriptGame({ assets: [art(16, 24, 4, 4)], insts: [0, 0], script: [] });
  const m = C.run(game, 10);
  const t = (addr, regs) => C.callRoutine(m, addr, regs).t;
  const show1 = t(S.RT_SHOW, { a: 0, bc: 100, de: 50 }), show2 = t(S.RT_SHOW, { a: 0, bc: 100, de: 50 }), showf1 = t(S.RT_SHOWF, { a: 0, bc: 101, de: 50, hl: 2 }), showf2 = t(S.RT_SHOWF, { a: 0, bc: 101, de: 50, hl: 2 });
  const showc = t(S.RT_SHOW, { a: 0, bc: -50 & 0xFFFF, de: 300 }), bad = t(S.RT_SHOW, { a: 5, bc: 1, de: 1 }), hide = t(S.RT_HIDE, { a: 0 }), hit = t(S.RT_HIT, { a: 0, de: 1 });
  console.log(`  RT_SHOW change ${show1}, unchanged ${show2}, clamped both ways ${showc}, index >= ninst ${bad};  RT_SHOWF change ${showf1}, unchanged ${showf2};  RT_HIDE ${hide};  RT_HIT (one hidden) ${hit}`);
  check('RT_SHOW / RT_SHOWF cost under 600 T', Math.max(show1, show2, showf1, showf2, showc) < 600);
}

console.log('\nThe reference art set (contract section 1) in non-window mode: player 16x24 (16 frames), 3 walkers, 3 flyers, a shot, 4 coins, all moving / animating, over text:');
{
  const r = rng(4);
  const assets = [C.randomAsset(r, 16, 24, 4, 16), C.randomAsset(r, 16, 16, 4, 4), C.randomAsset(r, 16, 16, 4, 2), C.randomAsset(r, 8, 8, 8, 4), C.randomAsset(r, 8, 8, 8, 1)];
  const insts = [0, 1, 1, 1, 2, 2, 2, 4, 3, 3, 3, 3];
  const script = [fill, [], []];
  const pos = insts.map((_, i) => ({ x: 20 + 17 * i, y: 30 + 9 * i, dx: 1 + (i % 3), dy: (i % 2) ? 1 : -1 }));
  for (let t = 0; t < 60; t++) script.push(pos.map((p, i) => {
    p.x += p.dx; p.y += p.dy; if (p.x < 0 || p.x > 235) p.dx = -p.dx; if (p.y < 0 || p.y > 165) p.dy = -p.dy;
    const nf = [16, 4, 2, 4, 1][insts[i]];
    return op.showf(i, p.x, p.y, i === 0 ? (t >> 2) % 16 : (t >> 2) % nf);
  }));
  const game = C.scriptGame({ div: 3, assets, insts, script });
  const st = C.observe6(game, 200, { script: null, checkPicture: false, untilTicks: 63 });
  const w = st.work.slice(6, 63);
  console.log(`  tick work avg ${Math.round(C.avg(w))}, max ${Math.max(...w)} T (${(Math.max(...w) / FRAME_T).toFixed(2)} refreshes); ${rd16(st.m, S.FC_MISSES)} frames built (player frames beyond its slots)`);
  check('the reference set\'s worst tick fits in 3 refreshes with room for the game (< 0.8 x 176,064 T)', Math.max(...w) < 0.8 * 3 * FRAME_T, `${Math.max(...w)} T`);
}
{
  const m = C.newMachine(C.scriptGame({ assets: Array.from({ length: 8 }, () => art(16, 16, 8)), insts: Array.from({ length: 16 }, (_, i) => i % 8), script: [] }).dck);
  const b = C.bootMachine(m, S);
  console.log(`\nBoot with the v2 worst case (8 assets of 16 x 16 at 8 phases: 56 copies built): ${b.bootFrames} frames from the entry to the first refresh`);
  check('boot within 20 frames of the entry (v2: 14; v3 builds its copies with build_frame)', b.bootFrames <= 20, `${b.bootFrames}`);
}
finish('runtime v3 part 1 perf');
void M; void rd8;
