"use strict";
// Harness for the scroll spike.   node run-scroll.mjs [v1 v2 v3 v4 v5 ...]    (no argument: everything)
// Each variant is assembled with sjasmplus, loaded at $8000 of a stock TS2068 (TSRun), DI, no interrupts; its init
// routine is run once (not counted), then the frame routine is called for the camera positions; T-states are exact
// (m.tstates delta from the CALL to the RET, both included). Every screen is compared with refRender() (JS).
import { assemble, newMachine, callAt, poke16, makeWorld, blankPairs, refRender, diff, stats, tStatesPerFrame, CAM_MAX } from './lib.mjs';

const worldDense = makeWorld('dense'), worldLevel = makeWorld('level'), worldSolid = makeWorld('solid');
const world = worldDense;
const FR = tStatesPerFrame;
const SWEEP = Array.from({ length: 64 }, (_, i) => 200 + i);             // 64 consecutive pixel positions, 8 full phase cycles
const CHECK = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 100, 255, 256, 257, 511, 600, 700, 762, 767, 768, 331, 333];   // correctness positions
const out = [];                                                          // rows for the summary
const fmt = n => Math.round(n).toLocaleString('en-US');

/** Run a "render the window for CAM" variant. */
function windowVariant(label, src, defs, win, opts = {}) {
  const world = opts.world ?? worldDense;
  const prog = assemble(src, defs);
  const m = newMachine(prog, world);
  const tInit = callAt(m, prog.sym.build_tables);
  const snap = m.ram.slice();
  const dstHi = defs.DST_HI ?? 0x40;
  const dstBase = dstHi << 8, attrBase = (dstHi + 0x18) << 8;
  const ts = [], tsa = [], bad = [];
  const positions = [...new Set([...SWEEP, ...CHECK])];
  for (const cam of positions) {
    m.ram.set(snap); poke16(m, 0xF000, cam);
    const t = callAt(m, prog.sym.render);
    const ta = prog.sym.render_attr ? callAt(m, prog.sym.render_attr) : 0;
    const exp = refRender(world, cam, win);
    const e1 = diff(m.ram.subarray(dstBase, dstBase + 6144), exp.bm, 'bitmap@cam' + cam, dstBase);
    const e2 = diff(m.ram.subarray(attrBase, attrBase + 768), exp.at, 'attr@cam' + cam, attrBase);
    if (e1) bad.push(e1); if (e2) bad.push(e2);
    if (SWEEP.includes(cam)) { ts.push(t); tsa.push(ta); }
  }
  const s = stats(ts), a = stats(tsa);
  const p0 = ts.filter((_, i) => SWEEP[i] % 8 === 0), pn = ts.filter((_, i) => SWEEP[i] % 8 !== 0);
  console.log(`${label.padEnd(26)} bitmap mean ${fmt(s.mean).padStart(8)} worst ${fmt(s.max).padStart(8)}  (p0 ${fmt(stats(p0).mean)}, p1-7 ${fmt(stats(pn).mean)})  attr ${fmt(a.mean).padStart(7)}  code+data ${prog.bin.length} B  init ${fmt(tInit)} T  ${bad.length ? 'MISMATCH ' + bad[0] : 'MATCH (' + positions.length + ' positions)'}`);
  out.push({ label, mean: s.mean, max: s.max, attr: a.mean, size: prog.bin.length, ok: !bad.length, init: tInit });
}

const want = process.argv.slice(2);
const on = k => !want.length || want.includes(k);

if (on('v1')) {
  const prog = assemble('v1.asm');
  const m = newMachine(prog, world);
  const snap = m.ram.slice();
  const ts = [], bad = [];
  const V1SWEEP = SWEEP.slice(0, 8);                                    // cost depends on the phase only: 8 consecutive = a full cycle
  const positions = [...new Set([...V1SWEEP, ...CHECK.slice(0, 12)])];
  for (const cam of positions) {
    m.ram.set(snap); poke16(m, 0xF000, cam);
    const t = callAt(m, prog.sym.render, 400);
    const exp = refRender(world, cam);
    const e1 = diff(m.ram.subarray(0x4000, 0x5800), exp.bm, 'bitmap@cam' + cam, 0x4000);
    if (e1) bad.push(e1);
    if (V1SWEEP.includes(cam)) ts.push(t);
  }
  const s = stats(ts);
  console.log(`${'V1 naive'.padEnd(26)} bitmap mean ${fmt(s.mean).padStart(8)} worst ${fmt(s.max).padStart(8)}  (${ts.length} sweep positions)  code+data ${prog.bin.length} B  ${bad.length ? 'MISMATCH ' + bad[0] : 'MATCH (' + positions.length + ' positions)'}`);
  out.push({ label: 'V1 naive', mean: s.mean, max: s.max, attr: 0, size: prog.bin.length, ok: !bad.length });
}
if (on('v2')) windowVariant('V2 32x24 (full)', 'v2.asm', {}, { x0: 0, y0: 0, nc: 32, nr: 24 });
if (on('v2b')) {
  const pairs = [200, 232, 300, 400, 500, 600].map(c => blankPairs(worldLevel, c));
  console.log(`blank cell pairs in the 'level' world: ${(100 * Math.min(...pairs)).toFixed(0)}-${(100 * Math.max(...pairs)).toFixed(0)} % of the 768 cells; mixed world: ${(100 * blankPairs(worldDense, 200)).toFixed(0)} %`);
  windowVariant('V2 +blank, mixed world', 'v2.asm', { BLANK: 1 }, { x0: 0, y0: 0, nc: 32, nr: 24 });
  windowVariant('V2 +blank, level world', 'v2.asm', { BLANK: 1 }, { x0: 0, y0: 0, nc: 32, nr: 24 }, { world: worldLevel });
  windowVariant('V2 +blank, solid world', 'v2.asm', { BLANK: 1 }, { x0: 0, y0: 0, nc: 32, nr: 24 }, { world: worldSolid });
  windowVariant('V2 plain, level world', 'v2.asm', {}, { x0: 0, y0: 0, nc: 32, nr: 24 }, { world: worldLevel });
  for (const [nc, nr] of [[32, 16], [28, 20], [24, 16], [20, 14], [16, 12]]) {
    const wx = (32 - nc) >> 1, wy = (24 - nr) >> 1;
    windowVariant(`V3 ${nc}x${nr} +blank, level`, 'v2.asm', { NC: nc, NR: nr, WX: wx, WY: wy, BLANK: 1 }, { x0: wx, y0: wy, nc, nr }, { world: worldLevel });
  }
}
if (on('v3')) {
  for (const [nc, nr] of [[32, 16], [28, 20], [24, 16], [20, 14], [16, 12]]) {
    const wx = (32 - nc) >> 1, wy = (24 - nr) >> 1;
    windowVariant(`V3 ${nc}x${nr}`, 'v2.asm', { NC: nc, NR: nr, WX: wx, WY: wy }, { x0: wx, y0: wy, nc, nr });
  }
}

/** V4: shift the drawn screen one pixel per tick. two = the real double-buffer flow (copy from the shown file into the hidden one). */
function v4Variant(label, two) {
  const prog = assemble('v4.asm');
  const m = newMachine(prog, world);
  const S = prog.sym, F = [0x40, 0x60];
  const put = (hi, r) => { m.ram.set(r.bm, hi << 8); m.ram.set(r.at, (hi + 0x18) << 8); };
  const c0 = 200;
  put(F[0], refRender(world, c0));
  if (two) put(F[1], refRender(world, c0 - 1));
  let shown = 0;
  const tb = [], ta = [], tt = [], bad = [];
  const tAttrShift = [], tAttrCopy = [];
  for (let n = 1; n <= 64; n++) {
    const cam = c0 + n, col = c => c >> 3;
    const src = F[shown], dst = two ? F[1 - shown] : F[0];
    m.ram[S.SRCHI] = src; m.ram[S.DSTHI] = dst; poke16(m, S.CAM, cam);
    const t = callAt(m, two ? S.scroll1 : S.scroll1_inplace);
    let a = 0;
    if (col(cam) !== col(cam - 1)) { a = callAt(m, S.attr_shift); tAttrShift.push(a); }
    else if (two && col(cam - 1) !== col(cam - 2)) { a = callAt(m, S.attr_copy); tAttrCopy.push(a); }
    const exp = refRender(world, cam);
    const e1 = diff(m.ram.subarray(dst << 8, (dst << 8) + 6144), exp.bm, 'bitmap@cam' + cam, dst << 8);
    const e2 = diff(m.ram.subarray((dst + 0x18) << 8, ((dst + 0x18) << 8) + 768), exp.at, 'attr@cam' + cam, (dst + 0x18) << 8);
    if (e1) bad.push(e1); if (e2) bad.push(e2);
    tb.push(t); ta.push(a); tt.push(t + a);
    if (two) shown = 1 - shown;
  }
  const b = stats(tb), tot = stats(tt);
  console.log(`${label.padEnd(26)} bitmap mean ${fmt(b.mean).padStart(8)} worst ${fmt(b.max).padStart(8)}  tick incl. attributes: mean ${fmt(tot.mean)} worst ${fmt(tot.max)}  (attr shift ${fmt(stats(tAttrShift).mean)}${tAttrCopy.length ? ', attr copy ' + fmt(stats(tAttrCopy).mean) : ''})  code ${prog.bin.length} B  ${bad.length ? 'MISMATCH ' + bad[0] : 'MATCH (64 ticks, whole screen each)'}`);
  out.push({ label, mean: tot.mean, max: tot.max, bmean: b.mean, attr: 0, size: prog.bin.length, ok: !bad.length });
}
if (on('v4')) { v4Variant('V4 shift, 2 files (copy)', true); v4Variant('V4 shift, in place (1 file)', false); }

/** V5: cell-granular. Full redraw, and the step flow: shown file S, hidden file D (copy-shift), then the other file in place. */
function v5Variant() {
  const prog = assemble('v5.asm');
  const m = newMachine(prog, world);
  const S = prog.sym, F = [0x40, 0x60];
  const put = (hi, r) => { m.ram.set(r.bm, hi << 8); m.ram.set(r.at, (hi + 0x18) << 8); };
  const chk = (hi, cam, what, bad) => {
    const exp = refRender(world, cam);
    const e1 = diff(m.ram.subarray(hi << 8, (hi << 8) + 6144), exp.bm, what + ' bitmap@' + cam, hi << 8);
    const e2 = diff(m.ram.subarray((hi + 0x18) << 8, ((hi + 0x18) << 8) + 768), exp.at, what + ' attr@' + cam, (hi + 0x18) << 8);
    if (e1) bad.push(e1); if (e2) bad.push(e2);
  };
  const bad = [];
  // full redraw at several cell positions
  const tr = [], tra = [];
  for (const col0 of [0, 1, 25, 50, 95, 96]) {
    m.ram.fill(0, 0x4000, 0x8000);
    m.ram[S.DSTHI] = 0x40; poke16(m, S.CAM, col0 * 8);
    tr.push(callAt(m, S.redraw_full)); tra.push(callAt(m, S.redraw_attr));
    chk(0x40, col0 * 8, 'redraw', bad);
  }
  const fmtS = (label, t) => console.log(`${label.padEnd(26)} ${fmt(t).padStart(9)} T`);
  // steps
  const res = { ldi: [], ldir: [], strip: [], ashift: [], acopy: [] };
  for (const variant of ['shift8', 'shift8_ldir']) {
    const loc = [];
    m.ram.fill(0, 0x4000, 0x8000);
    let cam = 200; put(F[0], refRender(world, cam)); put(F[1], refRender(world, cam));
    let shown = 0;
    for (let step = 1; step <= 8; step++) {
      cam += 8;
      for (const inplace of [false, true]) {                       // tick 1: copy-shift into the hidden file; tick 2: the other file in place
        // tick 1 of a step: copy-shift the shown file into the hidden one, which is then shown (shown flips);
        // tick 2: the file that was shown before is fixed in place (it is the hidden one now)
        const s2 = inplace ? F[1 - shown] : F[shown], d2 = F[1 - shown];
        m.ram[S.SRCHI] = s2; m.ram[S.DSTHI] = d2; poke16(m, S.CAM, cam);
        const t1 = callAt(m, S[variant]), t2 = callAt(m, S.strip_cells), t3 = callAt(m, S.attr_shift);
        loc.push(t1 + t2 + t3);
        if (variant === 'shift8') { res.ldi.push(t1); res.strip.push(t2); res.ashift.push(t3); } else res.ldir.push(t1);
        chk(d2, cam, variant + (inplace ? ' in place' : ' copy'), bad);
        if (!inplace) shown = 1 - shown;
      }
    }
  }
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  console.log(`V5 full redraw (bitmap)    ${fmt(mean(tr)).padStart(9)} T  + attributes ${fmt(mean(tra))} T   code ${prog.bin.length} B`);
  console.log(`V5 shift8 LDI    (bitmap)  ${fmt(mean(res.ldi)).padStart(9)} T    shift8 LDIR ${fmt(mean(res.ldir))} T   strip (24 cells) ${fmt(mean(res.strip))} T   attr shift+column ${fmt(mean(res.ashift))} T`);
  console.log(`V5 step per file (LDI)     ${fmt(mean(res.ldi) + mean(res.strip) + mean(res.ashift)).padStart(9)} T   (two files per step: ${fmt(2 * (mean(res.ldi) + mean(res.strip) + mean(res.ashift)))} T)   ${bad.length ? 'MISMATCH ' + bad[0] : 'MATCH (every step, both files, whole screen)'}`);
  out.push({ label: 'V5 full redraw', mean: mean(tr), max: Math.max(...tr), attr: mean(tra), size: prog.bin.length, ok: !bad.length });
}
if (on('v5')) v5Variant();

/** V4 at 2 pixels per tick: scroll1 (CAM = c-1) from the shown file into the hidden one, then scroll1_inplace (CAM = c) on the hidden one. */
function v4x2() {
  const prog = assemble('v4.asm');
  const m = newMachine(prog, world);
  const S = prog.sym, F = [0x40, 0x60];
  const put = (hi, r) => { m.ram.set(r.bm, hi << 8); m.ram.set(r.at, (hi + 0x18) << 8); };
  const c0 = 200;
  put(F[0], refRender(world, c0)); put(F[1], refRender(world, c0 - 2));
  let shown = 0;
  const tt = [], bad = [];
  for (let n = 1; n <= 32; n++) {
    const cam = c0 + 2 * n, col = c => c >> 3;
    const src = F[shown], dst = F[1 - shown];
    m.ram[S.SRCHI] = src; m.ram[S.DSTHI] = dst; poke16(m, S.CAM, cam - 1);
    let t = callAt(m, S.scroll1);
    m.ram[S.SRCHI] = dst; m.ram[S.DSTHI] = dst; poke16(m, S.CAM, cam);
    t += callAt(m, S.scroll1_inplace);
    m.ram[S.SRCHI] = src; m.ram[S.DSTHI] = dst; poke16(m, S.CAM, cam);
    if (col(cam) !== col(cam - 2)) t += callAt(m, S.attr_shift);
    else if (col(cam - 2) !== col(cam - 4)) t += callAt(m, S.attr_copy);
    const exp = refRender(world, cam);
    const e1 = diff(m.ram.subarray(dst << 8, (dst << 8) + 6144), exp.bm, 'bitmap@cam' + cam, dst << 8);
    const e2 = diff(m.ram.subarray((dst + 0x18) << 8, ((dst + 0x18) << 8) + 768), exp.at, 'attr@cam' + cam, (dst + 0x18) << 8);
    if (e1) bad.push(e1); if (e2) bad.push(e2);
    tt.push(t); shown = 1 - shown;
  }
  const s = stats(tt);
  console.log(`${'V4 2 px/tick, 2 files'.padEnd(26)} tick mean ${fmt(s.mean).padStart(8)} worst ${fmt(s.max).padStart(8)}  ${bad.length ? 'MISMATCH ' + bad[0] : 'MATCH (32 ticks of 2 px, whole screen each)'}`);
  out.push({ label: 'V4 2 px/tick', mean: s.mean, max: s.max, attr: 0, size: prog.bin.length, ok: !bad.length });
}
if (on('v4')) v4x2();
if (!want.length) import('node:fs').then(fs => fs.writeFileSync(new URL('./results.json', import.meta.url), JSON.stringify(out, null, 1)));
process.exitCode = out.some(o => !o.ok) ? 1 : 0;
