"use strict";
// m8-runtime-perf.mjs -- runtime v4, measured budgets (TSRun, no contention; docs/ARCADE_RAYCASTER_CONTRACT.md section 5):
//   the render (cast + walls) of the spike's 16 poses, 4 and 2 pixel columns, 16 x 16 and 32 x 32 maps (worst / mean / best, ray_render called
//   directly, interrupts off); one billboard 16 x 16 and 32 x 32 (drawn 16 / 32 rows high) at 4 and 2 px, split into projection and drawing; the
//   scene-start table build (refreshes); the runtime size; a running game's tick (the interrupt included).
//   node arcade/tests/m8-runtime-perf.mjs
import * as R from './m8-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { M, Z, makeChecks, rd8, rd16, op, hex } = R;

const { check, finish } = makeChecks();
const rt = R.runtime(), S = rt.syms;
console.log('Runtime v4: measured budgets (TSRun, a refresh is 58,688 T)\n');
const fmt = (v) => Math.round(v).toLocaleString('en-US');
const refreshes = (t) => Math.ceil(t / R.FRAME_T);

// ---- the render -------------------------------------------------------------------------------------------------------------
console.log('1. Render (cast + walls), the spike\'s 16 poses per map');
const BUDGET = { 4: 158500, 2: 272000 };
const renderT = {};
for (const colw of [4, 2]) for (const n of [16, 32]) {
  const g = R.rayGame({ view: { colw, mw: n, mh: n, cells: R.spikeMap(n) } });
  const m = R.bootIdle(g, 3);
  const ts = R.spikePoses(n).map((p, k) => R.renderAt(m, S, p, k & 1).t);
  const worst = Math.max(...ts), mean = R.avg(ts), best = Math.min(...ts);
  renderT[`${colw}/${n}`] = { worst, mean, best };
  const budget = n === 16 ? BUDGET[colw] : Math.round(BUDGET[colw] * 1.1);
  check(`colw ${colw}, ${n} x ${n}: worst ${fmt(worst)} T (mean ${fmt(mean)}, best ${fmt(best)}) <= ${fmt(budget)}${n === 32 ? ' (+10 %)' : ''}; ${refreshes(worst)} refreshes`, worst <= budget);
}
check(`below the spike (158,344 / 271,681 worst at 16 x 16): colw 4 ${(100 * renderT['4/16'].worst / 158344 - 100).toFixed(1)} %, colw 2 ${(100 * renderT['2/16'].worst / 271681 - 100).toFixed(1)} %`,
  renderT['4/16'].worst < 158344 && renderT['2/16'].worst < 271681);

// ---- billboards --------------------------------------------------------------------------------------------------------------
console.log('\n2. One billboard (the render with it minus the render without it), drawn as high as its asset (3 cells away)');
const PROJ = new Set(['bb_project', 'recip_a', 'tm_cs', 'tm_sn', 'tm_sg', 'abs_hl', 'mul_p', 'neg_hl', 'neg_de', 'bb_sort', 'bb_tx', 'gen_mul', 'ray_bb', 'mul8x16', 'MULCS']);
const names = ['ray_bb', 'bb_project', 'recip_a', 'tm_cs', 'tm_sn', 'tm_sg', 'abs_hl', 'bb_sort', 'bb_tx', 'bb_draw', 'BB_TAIL', 'bb_xc', 'mul8x16c', 'gen_mul', 'mul8x16', 'mul_p', 'neg_hl', 'neg_de', 'rt_zero'];
const labels = names.map((k) => [k, S[k]]).filter((x) => x[1] !== undefined).sort((x, y) => x[1] - y[1]);
function region(pc) {
  if ((pc >= S.RAY_BCODE && pc < S.RAY_BCODE + S.RAY_BCODE_LEN) || (pc >= S.BT_FI && pc < S.RAY_RAM_END)) return 'rows';   // the generated rows and the RAM row tails
  if (pc >= S.RAY_MULC && pc < S.RAY_MUL_END) return 'MULCS';
  if (pc < 0x4000) { let best = 'other'; for (const [k, a] of labels) if (a <= pc) best = k; return best; }
  return 'ram';
}
const BB_BUDGET = { 16: 9000, 32: 31000 };
const bbT = {};
for (const colw of [4, 2]) for (const sz of [16, 32]) {
  const r = rng(sz * 10 + colw);
  const n = 16, cells = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) { cells[i] = 1; cells[(n - 1) * n + i] = 1; cells[i * n] = 1; cells[i * n + n - 1] = 1; }
  const a = R.randomAsset(r, sz, sz, 1, 1);
  const g = R.rayGame({ view: { colw, mw: n, mh: n, cells }, assets: [a], insts: [0] });
  const m = R.bootIdle(g, 3);
  const pose = { x: 2 * 256, y: 8 * 256, a: 0 };
  m.ram[S.SPR_TAB] = 0;
  const t0 = R.renderAt(m, S, pose, 0).t;
  m.ram[S.SPR_TAB] = 1; R.wr16(m, S.SPR_TAB + 2, pose.x + 768); R.wr16(m, S.SPR_TAB + 4, pose.y);
  const t1 = R.renderAt(m, S, pose, 0).t;
  // the split
  R.wr16(m, S.RV_X, pose.x); R.wr16(m, S.RV_Y, pose.y); m.ram[S.RV_A] = 0; m.ram[S.V_HIDDEN] = 0; m.ram[S.V_HOFF] = 0;
  const cpu = m.cpu, sp0 = cpu.sp; cpu.iff1 = false; cpu.sp -= 2; m.ram[cpu.sp] = 0xFE; m.ram[cpu.sp + 1] = 0xFF; cpu.pc = S.ray_render;
  let on = false, proj = 0, draw = 0, rows = 0;
  while (cpu.pc !== 0xFFFE) { const pc = cpu.pc, tt = m.tstates; if (pc === S.ray_bb) on = true; Z.runZ80(cpu, m.bus, 1, m); if (on) { const k = region(pc), d = m.tstates - tt; if (k === 'rows') rows += d; else if (PROJ.has(k)) proj += d; else draw += d; } }
  cpu.sp = sp0;
  const rec = S.RAY_BREC, hpx = rd8(m, rec + 5), wpx = rd8(m, rec + 4);
  bbT[`${colw}/${sz}`] = { total: t1 - t0, proj, gen: draw, rows, hpx, wpx };
  console.log(`  colw ${colw}, ${sz} x ${sz} asset drawn ${wpx} x ${hpx} px (${Math.ceil(wpx / colw)} columns): ${fmt(t1 - t0)} T = projection and sort ${fmt(proj)} + code generation ${fmt(draw)} + rows ${fmt(rows)}` +
    (colw === 4 ? `  (contract target ${fmt(BB_BUDGET[sz])})` : ''));
}
// The contract's 9,000 / 31,000 came from the spike's kernel (one byte per source pixel, OR only, no projection, no clipping); the as-built ceilings
// (docs/ARCADE_RUNTIME_API_V4.md "Deviations") are checked here so that a regression shows.
check(`one 16 x 16 billboard at 4 px: ${fmt(bbT['4/16'].total)} T (as-built ceiling 16,500; contract target 9,000: deviation, see ARCADE_RUNTIME_API_V4.md)`, bbT['4/16'].total <= 16500);
check(`one 32 x 32 billboard at 4 px: ${fmt(bbT['4/32'].total)} T (as-built ceiling 42,000; contract target 31,000: deviation)`, bbT['4/32'].total <= 42000);
check(`the row code per drawn column and row: ${(bbT['4/32'].rows / (Math.ceil(bbT['4/32'].wpx / 4) * bbT['4/32'].hpx)).toFixed(0)} T at 4 px (the spike's kernel: 108-143 T a pixel column-row for OR-only bytes)`,
  bbT['4/32'].rows / (Math.ceil(bbT['4/32'].wpx / 4) * bbT['4/32'].hpx) < 110);

// ---- the scene-start build ----------------------------------------------------------------------------------------------------
console.log('\n3. Scene start (boot) with the ray tables');
{
  const timeBoot = (spec) => {
    const g = R.rayGame(spec), m = R.newMachine(g.dck);
    let f = 0;
    for (; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
    let t = 0; const t0 = m.tstates;
    for (let i = 0; i < 20000000 && m.cpu.pc !== S.MAIN; i++) Z.runZ80(m.cpu, m.bus, 1, m);
    t = m.tstates - t0;
    return t;
  };
  const tRay = timeBoot({ view: { colw: 2, mw: 32, mh: 32, cells: R.spikeMap(32) } });
  const tNon = timeBoot({});
  check(`the boot with a 32 x 32 view: ${fmt(tRay)} T from ENTRY to MAIN, ${fmt(tRay - tNon)} T more than without a view = ${((tRay - tNon) / R.FRAME_T).toFixed(1)} refreshes (budget 60)`, (tRay - tNon) / R.FRAME_T <= 60);
}
check(`the runtime: ${rt.usage.per[0] + rt.usage.per[1]} of 16,384 bytes (DOCK chunks 0-1)`, rt.usage.per[0] + rt.usage.per[1] <= 16384);

// ---- a running game's tick --------------------------------------------------------------------------------------------------
console.log('\n4. A running game (TSRun with the frame interrupt): the tick\'s work, WORK_START .. WORK_END');
for (const [colw, div, nb] of [[4, 3, 0], [4, 3, 3], [2, 5, 0], [2, 5, 3]]) {
  const r = rng(840 + colw + nb);
  const cells = R.spikeMap(16), map = R.loadMap(R.rleEncode(cells), 16, 16);
  const assets = [R.randomAsset(r, 16, 16, 1, 2)];
  const insts = Array.from({ length: nb }, () => 0);
  const poses = R.spikePoses(16);
  const script = Array.from({ length: 32 }, (_, k) => {
    const p = poses[k % 16], t = [op.view(p.x, p.y, p.a), op.at(0, 0), op.prints('SCORE ' + k)];
    const cs = R.cosa8(p.a), sn = R.sina8(p.a);
    insts.forEach((_, i) => t.push(op.show(i, (p.x + ((600 * cs - (i - 1) * 300 * sn) >> 8)) & 0xFFFF, Math.max(0, p.y + ((600 * sn + (i - 1) * 300 * cs) >> 8)))));
    return t;
  });
  const g = R.rayGame({ div, view: { colw, mw: 16, mh: 16, cells }, assets, insts, script, tiles: randomTiles(r, 2) });
  const st = R.observe8(g, 32 * div + 30, { script });
  const w = st.work.slice(2), worst = Math.max(...w);
  check(`colw ${colw}, frame_div ${div}, ${nb} billboards (16 x 16, 2.3 cells away), HUD printed every tick: tick work worst ${fmt(worst)} T, mean ${fmt(R.avg(w))} (${(worst / R.FRAME_T).toFixed(2)} refreshes of ${div})`,
    w.length >= 10 && st.bad === 0, `${w.length} ticks`);
}

finish('runtime v4, measured budgets');
