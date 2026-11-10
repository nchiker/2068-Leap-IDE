"use strict";
// m4-runtime-skip.mjs -- M4a runtime test, part 5: the unchanged-sprite skip (skip.asm).  An instance that is visible, has not changed since it
// was drawn into both display files, covers no dirty cell and shares no cell with any other instance is neither erased nor drawn.  Proof by
// picture: every scene is compared with the JS compositor after EVERY refresh, with the skip on, and the same scenes run with the analysis
// switched off give the same pictures.  The scenes are built to break a wrong skip: static instances overlapped by moving ones in both draw orders,
// cells printed / tiled under static instances, static instances touching each other, hide / show to the same place, a static instance next to a
// moving one whose boxes touch edge to edge, and random mixes.
//   node arcade/tests/m4-runtime-skip.mjs
import * as C from './m4-common.mjs';
import { rng, randomScene, randomTiles } from './m3-scenes.mjs';
const { M, FRAME_T, makeChecks, rd8, op } = C;

const { check, finish } = makeChecks();
const rt = C.runtime();
const S = rt.syms;
console.log('M4a unchanged-sprite skip\n');

/** Run a scene with the skip on (and off), count the marked instances; compare pictures with the model after every refresh. */
function scene(label, spec, nframes, { compareOff = true, expectSkips = null, tickCheck = null } = {}) {
  const run = (noSkip) => {
    const game = C.scriptGame({ ...spec, noSkip });
    let marked = 0, ticksWithMarks = 0, leftover = 0;
    const st = C.observe(game, nframes, { script: spec.script, hooks: (pc, { m, inIsr }) => {
      if (pc === S.TICK_REQUEST && !inIsr) {
        for (let k = 0; k < 32; k++) if (rd8(m, S.SPR_DRAWN + 4 * k) > 1) leftover++;
      }
      if (pc === S.erase_all && !inIsr) {
        const base = S.SPR_DRAWN + 64 * rd8(m, S.V_HIDDEN);
        let n = 0;
        for (let i = 0; i < rd8(m, S.V_NINST); i++) if (rd8(m, base + 4 * i) === 0x81) n++;
        marked += n; if (n) ticksWithMarks++;
      }
    } });
    return { st, marked, ticksWithMarks, leftover };
  };
  const on = run(false);
  const off = compareOff ? run(true) : null;
  const st = on.st;
  const ok = st.pictureOk === nframes && st.pictureBad === 0 && st.pixelBad === 0 && st.writeViolations === 0 && st.canary === 0x5AA5;
  check(`${label}: the picture equals the model in 100 % of the ${nframes} refreshes (memory and colours), no write to the shown file`, ok, st.firstBad ? JSON.stringify(st.firstBad) : `${st.pictureOk}/${nframes}`);
  if (off) {
    const o = off.st;
    check(`${label}: with the analysis switched off the same picture (also 100 %), nothing is ever marked`, o.pictureOk === nframes && off.marked === 0, `${o.pictureOk}/${nframes}, ${off.marked} marked`);
  }
  if (expectSkips !== null) check(`${label}: instances were skipped (${on.marked} marks in ${on.ticksWithMarks} ticks)`, on.marked >= expectSkips, `${on.marked} marks`);
  check(`${label}: at the end of every tick no record holds a mark (flags are 0 or 1)`, on.leftover === 0, `${on.leftover} records`);
  if (tickCheck) tickCheck(on, off);
  return { on, off };
}

const R = rng(31);
const mkAssets = () => [C.randomAsset(R, 16, 16, 8), C.randomAsset(R, 8, 8, 8), C.randomAsset(R, 16, 12, 2), C.randomAsset(R, 16, 16, 1)];

{ // 1. static instances only: after two ticks everything is skipped
  const assets = mkAssets();
  const script = [Array.from({ length: 8 }, (_, i) => op.show(i, 12 + 28 * i, 20 + 20 * (i & 3))), ...Array.from({ length: 24 }, () => Array.from({ length: 8 }, (_, i) => op.show(i, 12 + 28 * i, 20 + 20 * (i & 3))))];
  const { on, off } = scene('1. eight static instances (SHOW repeated every tick to the same place)', { div: 1, assets, insts: Array.from({ length: 8 }, (_, i) => i % 4), script }, 40, { expectSkips: 8 * 15 });
  const wOn = on.st.work.slice(8, 20), wOff = off.st.work.slice(8, 20);
  console.log(`  tick work (ISR excluded): ${Math.round(C.avg(wOff))} T without the skip, ${Math.round(C.avg(wOn))} T with it`);
  check('1. 8 static instances: the tick is cheaper with the skip', C.avg(wOn) < C.avg(wOff));
}

{ // 2. a moving instance crosses static ones, in both draw orders; text under and next to them
  const assets = mkAssets();
  const insts = [0, 1, 2, 3, 0, 1, 2, 3, 0, 1, 2, 3];
  const script = [];
  const statics = [[40, 40], [100, 40], [40, 100], [100, 100], [180, 20], [200, 70], [190, 130], [20, 160]];     // instances 0..3 are overlapped by the movers, 4..7 stay alone
  for (let t = 0; t < 120; t++) {
    const ops = statics.map(([x, y], i) => op.show(i, x, y));
    ops.push(op.show(8, (t * 2) % 160, 40), op.show(9, (t * 2 + 30) % 170, 102 - ((t >> 3) & 1) * 4), op.show(10, 38 + ((t >> 2) % 6) * 12, (t * 3) % 150), op.show(11, 10 + (t * 3) % 150, 10 + (t * 2) % 100));
    if (t % 17 === 5) ops.push(op.at(6, 5), op.prints('HELLO ' + t));          // text near the statics
    if (t % 23 === 7) ops.push(op.at(5, 12), op.prints('X' + t));
    script.push(ops);
  }
  scene('2. eight static instances (four of them in the way of four moving ones, in both draw orders), the movers sweeping across', { div: 1, assets, insts, script }, 125, { expectSkips: 120 });
}

{ // 3. cells change under a static instance: the skip must give way; and then come back
  const assets = mkAssets();
  const script = [];
  for (let t = 0; t < 100; t++) {
    const ops = [op.show(0, 64, 64), op.show(1, 160, 64), op.show(2, 64, 120), op.show(3, 230, 20), op.show(4, 230, 90), op.show(5, 120, 150), op.show(6, 20, 20), op.show(7, 20, 170)];   // 16x16 at 64,64 covers cells (8..10) x (8..10)
    if (t % 9 === 4) ops.push(op.at(9, 9), op.printc(65 + (t % 26)));               // a cell under instance 0 (and t % 9 === 4 only)
    if (t % 13 === 6) ops.push(op.at(8, 21), op.prints('AB'));                       // cells under instance 1 (x 160 = column 20..22)
    if (t === 60) ops.push(op.cls());                                               // everything dirty
    if (t % 11 === 3) ops.push(op.tile(t % 4, 15, 8));                               // tile under instance 2 (row 15)
    script.push(ops);
  }
  const spec = { div: 1, assets, insts: [0, 1, 0, 1, 2, 3, 0, 1], tiles: randomTiles(rng(3), 4), script };
  scene('3. cells printed / tiled / cleared under static instances', spec, 105, { expectSkips: 30 });
}

{ // 4. two static instances that overlap (both orders) and a third moving next to them; touching boxes (edge to edge in cells)
  const assets = mkAssets();
  const script = [];
  for (let t = 0; t < 140; t++) {
    const ops = [op.show(0, 80, 80), op.show(1, 88, 84),           // overlapping: instance 1 on top of 0
      op.show(3, 150, 80), op.show(2, 143, 90),                    // overlapping the other way round: 3 (higher) at 150,80 vs 2 at 143,90 ... 2 under 3
      op.show(4, 8 * ((t >> 2) % 8) + 4, 40), op.show(5, 200, 8 * ((t >> 1) % 18) + 3),
      op.show(6, 20, 150), op.show(7, 60, 150), op.show(8, 100, 150), op.show(9, 140, 150), op.show(10, 20, 120), op.show(11, 60, 10)];     // six more that stand alone
    if (t % 31 === 30) ops.push(op.hide(0));                       // hide / show a static one
    if (t % 31 === 0 && t > 0) ops.push(op.show(0, 80, 80));
    script.push(ops);
  }
  scene('4. overlapping static pairs in both orders, instances moving along the cell boundaries, hide / show', { div: 1, assets, insts: [0, 1, 2, 3, 1, 2, 0, 1, 2, 3, 0, 1], script }, 145, { expectSkips: 60 });
}

{ // 5. hide + show to the same place within one tick, show to a new place and back, and the very first ticks
  const assets = mkAssets();
  const script = [];
  for (let t = 0; t < 100; t++) {
    const ops = [];
    for (let i = 0; i < 8; i++) {
      const x = 20 + 28 * i, y = 30 + 18 * (i % 4) + 70 * (i >> 2);
      if (t % 10 === i) ops.push(op.hide(i), op.show(i, x, y));    // hide + show in the same tick: counts as a change
      else if (t % 14 === 3 + i) ops.push(op.show(i, x + 3, y));    // a one pixel move
      else ops.push(op.show(i, x, y));
    }
    script.push(ops);
  }
  scene('5. static instances that are hidden and shown again, or nudged by one pixel, now and then', { div: 1, assets, insts: [0, 1, 2, 3, 0, 1, 2, 3], script }, 105, { expectSkips: 30 });
}

for (const [seed, div] of [[101, 1], [102, 2], [103, 3], [104, 1], [105, 2]]) { // 6. random mixes
  const r = rng(seed);
  const assets = [C.randomAsset(r, 16, 16, r.pick([8, 4, 2, 1])), C.randomAsset(r, 8, 8, r.pick([8, 4])), C.randomAsset(r, 16, 12, r.pick([8, 2, 1])), C.randomAsset(r, 8, 15, 1), C.randomAsset(r, 16, 16, 8)];
  const insts = Array.from({ length: 16 }, () => r.int(0, 4));
  const script = randomScene(seed, 90, { sprites: 0, tiles: 6, textRate: 0.35, tileRate: 0.3 });
  // each instance has a mode: static, slow mover, fast mover, blinker; positions are drawn from a small area so they meet
  const modes = insts.map(() => r.pick(['static', 'static', 'slow', 'fast', 'blink', 'still-show']));
  const pos = insts.map(() => ({ x: r.int(20, 190), y: r.int(10, 150), dx: r.int(-2, 2), dy: r.int(-2, 2) }));
  script.forEach((t, k) => insts.forEach((_, i) => {
    const p = pos[i], m = modes[i];
    if (m === 'slow' && k % 4 === 0) { p.x = Math.max(0, p.x + p.dx); p.y = Math.max(0, p.y + p.dy); }
    else if (m === 'fast') { p.x += p.dx * 3; p.y += p.dy * 3; if (p.x < 0 || p.x > 235) p.dx = -p.dx; if (p.y < 0 || p.y > 170) p.dy = -p.dy; p.x = Math.max(0, p.x); p.y = Math.max(0, p.y); }
    if (m === 'blink' && k % 6 === i % 6) t.push(op.hide(i));
    else if (m === 'still-show' && r.chance(0.5)) { /* no SHOW this tick: the previous one stands */ }
    else t.push(op.show(i, p.x, p.y));
  }));
  scene(`6. random mix, seed ${seed}, 16 instances (static / slow / fast / blinking / shown only now and then), text and tiles, frame_div ${div}`, { div, assets, insts, tiles: randomTiles(rng(seed + 1), 6), script }, 100 * div + 20, { expectSkips: 1 });
}

{ // 7. the cost: the all-moving worst case pays little for the analysis, a mostly static one gains
  const r = rng(77);
  const assets = [C.randomAsset(r, 16, 16, 8)];
  const fill = [];
  for (let row = 0; row < 24; row++) fill.push(C.op.at(row, 0), C.op.prints('0123456789ABCDEFGHIJKLMNOPQRSTU'), C.op.printc(65 + (row % 26)));
  const mk = (nStatic) => {
    const walk = [];
    for (let t = 0; t < 30; t++) walk.push(Array.from({ length: 16 }, (_, i) => (i < nStatic ? op.show(i, 20 * (i % 12) + 3, 150 + 22 * (i & 1) - 3 * (i & 2)) : op.show(i, ((i * 53 + t * 7) % 216) + 1 + ((i + t) % 7), ((i * 29 + t * 5) % 90) + 1 + ((i + 2 * t) % 6)))));
    return [fill, [], [], ...walk];
  };
  const out = {};
  for (const ns of [0, 8, 12]) {
    for (const noSkip of [true, false]) {
      const script = mk(ns);
      const game = C.scriptGame({ div: 1, assets, insts: Array(16).fill(0), script, noSkip });
      const st = C.observe(game, 80, { script: null, checkPicture: false });
      out[`${ns}${noSkip ? 'off' : 'on'}`] = C.avg(st.work.slice(12, 33));
    }
  }
  console.log(`  tick work with 16 instances (16x16, 8 phases), a screen of text, the others moving every tick:`);
  for (const ns of [0, 8, 12]) console.log(`    ${String(ns).padStart(2)} static: ${Math.round(out[`${ns}off`])} T without the skip, ${Math.round(out[`${ns}on`])} T with it  (${(100 * (out[`${ns}on`] / out[`${ns}off`] - 1)).toFixed(1)} %)`);
  check('7. nothing static (below SKIP_MIN): the analysis costs under 3 % of the tick', out['0on'] < out['0off'] * 1.03, `${(100 * (out['0on'] / out['0off'] - 1)).toFixed(1)} %`);
  check('7. 12 of 16 static: the tick is at least 15 % cheaper', out['12on'] < out['12off'] * 0.85, `${(100 * (out['12on'] / out['12off'] - 1)).toFixed(1)} %`);
  check('7. 8 of 16 static: about break-even (within 8 %)', Math.abs(out['8on'] / out['8off'] - 1) < 0.08, `${(100 * (out['8on'] / out['8off'] - 1)).toFixed(1)} %`);
}

finish('M4a skip');
void M; void FRAME_T;
