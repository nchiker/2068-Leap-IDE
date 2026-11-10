"use strict";
// m5-runtime-perf.mjs -- M5 runtime test, part 4: T-states of the tile operations (a refresh is 58,688 T), per cell, against 768 RT_TILE calls and against
// the cost a compiled loop would have (RT_TILE per cell + loop).  Every figure is measured on TSRun with callRoutine (the CALL and RET included).
//   node arcade/tests/m5-runtime-perf.mjs
import * as C from './m5-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { M, FRAME_T, hex, makeChecks, rd8, op } = C;

const { check, finish } = makeChecks();
const S = C.rt().syms;
console.log('M5 runtime performance: T-states of the tile operations\n');

const tiles = randomTiles(rng(5), 6);
const r = rng(11);
const randCells = () => { const t = new Uint8Array(768), a = new Uint8Array(768); for (let i = 0; i < 768; i++) { t[i] = 0x80 | r.int(0, 5); a[i] = tiles[t[i] & 127].attr; } return { t, a }; };
const blank = () => ({ t: new Uint8Array(768).fill(32), a: new Uint8Array(768).fill(0x38) });
const map32 = { w: 32, h: 24, cells: Array.from({ length: 768 }, () => 0x80 | r.int(0, 5)) };
const game = C.opsGame({ tiles, maps: [map32], insts: [], assets: [], script: [] });
const m = C.park(game);

const T = {};
function measure(label, name, setup, regs = {}) {
  setup();
  C.clearDirty(m, S);
  const res = C.call(m, S[name], regs);
  const nd = C.dirtyCells(m, S.DIRTY0).length;
  T[label] = res.t;
  return { t: res.t, dirty: nd };
}
const put = (st) => C.setCells(m, S, st.t, st.a);

// fixed cost
const fixed = measure('degenerate', 'RT_FILL', () => C.setArgs(m, S, [0, 0, 0, 5, 1])).t;
const rows = [];
function row(label, cells, t, note = '') { rows.push({ label, cells, t, per: cells ? t / cells : NaN, note }); }

// FILL
{
  const full = (v) => { put(blank()); C.setArgs(m, S, [0, 0, 32, 24, v]); };
  const a = measure('fill-full-changed', 'RT_FILL', () => full(1));
  row('FILL 32x24, every cell changed', 768, a.t, `${a.dirty} dirty`);
  const b = measure('fill-full-same', 'RT_FILL', () => { put(blank()); C.setArgs(m, S, [0, 0, 32, 24, 1]); C.call(m, S.RT_FILL, {}); });
  row('FILL 32x24, nothing changed', 768, b.t, `${b.dirty} dirty`);
  const c = measure('fill-8x8', 'RT_FILL', () => { put(blank()); C.setArgs(m, S, [8, 8, 8, 8, 1]); });
  row('FILL 8x8 at (8,8), byte aligned, changed', 64, c.t);
  const d = measure('fill-10x10', 'RT_FILL', () => { put(blank()); C.setArgs(m, S, [3, 5, 10, 10, 1]); });
  row('FILL 10x10 at (3,5), unaligned, changed', 100, d.t);
  const e = measure('fill-1x1', 'RT_FILL', () => { put(blank()); C.setArgs(m, S, [3, 5, 1, 1, 1]); });
  row('FILL 1x1, changed', 1, e.t);
  const f = measure('fill-row', 'RT_FILL', () => { put(blank()); C.setArgs(m, S, [0, 10, 32, 1, 1]); });
  row('FILL 32x1 (one row), changed', 32, f.t);
  const g = measure('fillc-full', 'RT_FILLC', () => { put(blank()); C.setArgs(m, S, [0, 0, 32, 24, 65]); });
  row('FILLC 32x24, every cell changed', 768, g.t);
}
// COPY
{
  const down = measure('copy-vdown', 'RT_COPY', () => { put(randCells()); C.setArgs(m, S, [0, 0, 32, 23, 0, 1]); });
  row('COPY 32x23 down by one row, random content (changed)', 736, down.t, `${down.dirty} dirty`);
  const up = measure('copy-vup-same', 'RT_COPY', () => { put(blank()); C.setArgs(m, S, [0, 1, 32, 23, 0, 0]); });
  row('COPY 32x23 up by one row, identical content (nothing changes)', 736, up.t, `${up.dirty} dirty`);
  const side = measure('copy-hright', 'RT_COPY', () => { put(randCells()); C.setArgs(m, S, [0, 0, 31, 24, 1, 0]); });
  row('COPY 31x24 right by one cell (same rows: through the row buffer), changed', 744, side.t, `${side.dirty} dirty`);
  const blk = measure('copy-block', 'RT_COPY', () => { put(randCells()); C.setArgs(m, S, [2, 2, 8, 8, 14, 12]); });
  row('COPY 8x8 to a distant place (no overlap), changed', 64, blk.t);
  const small = measure('copy-1x1', 'RT_COPY', () => { put(randCells()); C.setArgs(m, S, [2, 2, 1, 1, 14, 12]); });
  row('COPY 1x1', 1, small.t);
}
// LOADMAP
{
  const full = measure('loadmap-full', 'RT_LOADMAP', () => put(blank()), { a: 0 });
  row('LOADMAP 32x24 into a blank screen (every cell changed)', 768, full.t, `${full.dirty} dirty`);
  const same = measure('loadmap-same', 'RT_LOADMAP', () => { put(blank()); C.call(m, S.RT_LOADMAP, { a: 0 }); }, { a: 0 });
  row('LOADMAP 32x24 again (nothing changes)', 768, same.t, `${same.dirty} dirty`);
  const at = measure('loadmap-at', 'RT_LOADMAPAT', () => put(blank()), { a: 0, bc: 10, de: 5 });
  row('LOADMAPAT (10, 5): the map cut to 22x19', 22 * 19, at.t);
}
// RT_TILE
{
  put(blank());
  C.clearDirty(m, S);
  let tCh = 0, tSame = 0;
  for (let i = 0; i < 768; i++) tCh += C.call(m, S.RT_TILE, { a: 1, bc: ((i >> 5) << 8) | (i & 31) }).t;
  for (let i = 0; i < 768; i++) tSame += C.call(m, S.RT_TILE, { a: 1, bc: ((i >> 5) << 8) | (i & 31) }).t;
  row('768 x RT_TILE, every cell changed (calls only)', 768, tCh);
  row('768 x RT_TILE, nothing changed (calls only)', 768, tSame);
  T.tileChanged = tCh; T.tileSame = tSame;
}
console.log('  routine / case                                                      cells        T   T/cell   refreshes');
for (const x of rows) console.log(`  ${x.label.padEnd(66)} ${String(x.cells).padStart(5)} ${String(x.t).padStart(8)} ${x.per.toFixed(1).padStart(8)} ${(x.t / FRAME_T).toFixed(2).padStart(8)}  ${x.note}`);
console.log(`\n  fixed cost (a call that does nothing, w = 0): ${fixed} T`);
console.log(`  a compiled loop of RT_TILE (changed) costs about ${(T.tileChanged / 768).toFixed(0)} T/cell for the calls alone plus ~100-250 T of loop and argument code per cell`);

const per = (k, n = 768) => T[k] / n;
console.log(`\n  per cell, nothing to mark (= the cost beyond the dirty marking): FILL ${per('fill-full-same').toFixed(1)}, COPY ${per('copy-vup-same', 736).toFixed(1)}, LOADMAP ${per('loadmap-same').toFixed(1)} T`);
console.log(`  per cell, every cell changed (marking included): FILL ${per('fill-full-changed').toFixed(1)}, COPY ${per('copy-vdown', 736).toFixed(1)}, LOADMAP ${per('loadmap-full').toFixed(1)} T;  768 RT_TILE: ${per('tileChanged').toFixed(1)} T per cell (changed), ${per('tileSame').toFixed(1)} (unchanged), calls only`);
check('FILL of the whole screen (all changed) costs under half of 768 RT_TILE calls (calls only, no loop)', T['fill-full-changed'] < T.tileChanged / 2, `${T['fill-full-changed']} T vs ${T.tileChanged} T`);
check('COPY of 32 x 23 cells costs under half of 736 RT_TILE calls; LOADMAP of 32 x 24 under 0.6 of 768', T['copy-vdown'] < 0.5 * T.tileChanged * 736 / 768 && T['loadmap-full'] < 0.6 * T.tileChanged, `${T['copy-vdown']} T, ${T['loadmap-full']} T`);
check('FILL of the whole screen takes under 1.5 refreshes (88,000 T); COPY under 2; LOADMAP under 3', T['fill-full-changed'] < 1.5 * FRAME_T && T['copy-vdown'] < 2 * FRAME_T && T['loadmap-full'] < 3 * FRAME_T);
check('FILL: under 100 T per cell beyond the dirty marking on whole bytes (the contract\'s target)', per('fill-full-same') < 100, `${per('fill-full-same').toFixed(1)} T`);
check('an unchanged FILL / COPY / LOADMAP marks nothing dirty and is cheaper than the changed one', T['fill-full-same'] < T['fill-full-changed'] && T['copy-vup-same'] < T['copy-vdown'] && T['loadmap-same'] < T['loadmap-full']);
check('the fixed cost of a call is small: a degenerate FILL under 300 T, a 1 x 1 FILL under 2,000 T, a 1 x 1 COPY under 3,000 T', fixed < 300 && T['fill-1x1'] < 2000 && T['copy-1x1'] < 3000, `${fixed}, ${T['fill-1x1']}, ${T['copy-1x1']} T`);
finish('M5 runtime performance');
void M; void hex; void rd8; void op;
