"use strict";
// m4-runtime-perf.mjs -- M4a runtime test, performance: T-states of runtime v2 on TSRun's clock (58,688 T per refresh), measured on the real
// machine with the frame loop's own erase_all / draw_all spans: T per visible sprite (erase and draw separately) for 16x16 with 8 phases,
// 16x16 with 2 phases and 8x8 with 8 phases, and the worst-case tick of 16 visible 16x16 sprites at 8 and at 4 phases over a text-filled
// screen.  The numbers are printed (they go into docs/ARCADE_RUNTIME_API_V2.md); the checks bound them.
//   node arcade/tests/m4-runtime-perf.mjs
import * as C from './m4-common.mjs';
import { rng } from './m3-scenes.mjs';
const { FRAME_T, makeChecks, op } = C;

const { check, finish } = makeChecks();
const rt = C.runtime();
console.log('M4a runtime performance (T-states; a refresh is ' + FRAME_T + ' T)\n');
console.log('Sizes: runtime ' + (rt.usage.per[0] + rt.usage.per[1]) + ' of 16384 bytes in DOCK chunks 0-1 (font 768);  placeholder game ' + (rt.usage.per[4] + rt.usage.per[5]) + ' bytes\n');

const fill = [];
for (let row = 0; row < 24; row++) fill.push(op.at(row, 0), op.prints('0123456789ABCDEFGHIJKLMNOPQRSTU'), op.printc(65 + (row % 26)));

/** n instances of one asset moving every tick (positions from posOf); returns per-sprite erase / draw averages and the tick work. */
function measure(asset, n, posOf, { ticks = 30, skip = 6 } = {}) {
  const walk = [];
  for (let t = 0; t < ticks; t++) walk.push(Array.from({ length: n }, (_, i) => { const [x, y] = posOf(t, i); return op.show(i, x, y); }));
  const script = [fill, [], [], ...walk];
  const game = C.scriptGame({ assets: [asset], insts: Array(n).fill(0), script });
  const st = C.observe(game, (ticks + 8) * Math.max(2, Math.ceil(n / 8)), { script: null, checkPicture: false });
  const a = skip + 3, b = ticks + 3;
  const e = st.eraseT.slice(a, b), d = st.drawT.slice(a, b), w = st.work.slice(a, b), r = st.redrawT.slice(a, b);
  return { erase: C.avg(e) / n, draw: C.avg(d) / n, eraseAll: C.avg(e), drawAll: C.avg(d), work: C.avg(w), max: Math.max(...w), redraw: C.avg(r), n: w.length };
}
const R = rng(99);
const art = (w, h, phases) => C.randomAsset(R, w, h, phases);

// positions: unaligned in both axes (x = 8k + 3, y = 8m + 3 would be a fixed shift; vary the shift per instance/tick), full coverage
const spread = (t, i) => [((i * 53 + t * 7 + 3) % 224) + (t & 7 ? 1 : 0), ((i * 29 + t * 5 + 3) % 168) + 1];
const aligned = (t, i) => [8 * ((i * 5 + t) % 28), 8 * ((i * 3 + t) % 20)];

console.log('Per visible sprite (T-states, averages over positions that vary every tick; erase_all and draw_all divided by the number of sprites):');
console.log('  asset                      erase   draw   (aligned x and y: erase / draw)');
const rows = [];
for (const [label, w, h, ph] of [['16x16, 8 phases', 16, 16, 8], ['16x16, 2 phases', 16, 16, 2], ['8x8, 8 phases', 8, 8, 8]]) {
  const m = measure(art(w, h, ph), 8, spread);
  const al = measure(art(w, h, ph), 8, aligned);
  rows.push({ label, m, al });
  console.log(`  ${label.padEnd(24)} ${String(Math.round(m.erase)).padStart(6)} ${String(Math.round(m.draw)).padStart(6)}   (${Math.round(al.erase)} / ${Math.round(al.draw)})`);
}

console.log('\nWorst-case tick: 16 visible 16x16 sprites, all moving every tick, over a screen full of text (ISR excluded; 3 refreshes = ' + 3 * FRAME_T + ' T):');
const worst = {};
for (const ph of [8, 4]) {
  // the worst alignment: x and y never multiples of 8 (3 columns x 3 cell rows each), shift 1..7
  const m = measure(art(16, 16, ph), 16, (t, i) => [((i * 53 + t * 7) % 216) + 1 + ((i + t) % 7), ((i * 29 + t * 5) % 160) + 1 + ((i + 2 * t) % 6)], { ticks: 24 });
  worst[ph] = m;
  console.log(`  ${ph} phases: tick work avg ${Math.round(m.work)}, max ${m.max} T (${(m.max / FRAME_T).toFixed(2)} refreshes);  erase_all ${Math.round(m.eraseAll)}, redraw_dirty ${Math.round(m.redraw)}, draw_all ${Math.round(m.drawAll)} T`);
}
check('the worst-case tick (16 sprites, 8 phases) fits in 3 refreshes (176k T) with room for the game', worst[8].max < 0.8 * 3 * FRAME_T, `max ${worst[8].max} T`);
check('...and at 4 phases', worst[4].max < 0.8 * 3 * FRAME_T, `max ${worst[4].max} T`);
const r16 = rows[0].m;
check('a 16x16 sprite at 8 phases costs under 6,000 T to erase and draw together', r16.erase + r16.draw < 6000, `${Math.round(r16.erase + r16.draw)} T`);
finish('M4a runtime perf');
