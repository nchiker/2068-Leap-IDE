"use strict";
// run-fine.mjs -- F1 measurement on TSRun: for each build (method), boot the cartridge on the stock TS2068, run FRAMES frames with video on,
// and classify every displayed frame (fine-check.mjs) against the fine pictures (scene.mjs / fine-model.mjs) before and after the update
// in flight; also check the screen memory equals the fine picture whenever no update is in progress, and time the updates.
//   node arcade/spike/fine/run-fine.mjs [FRAMES=3000] [build ...]      (builds: A B0 B80 B BP; default all)
// Writes build/results.json.  Exit code 1 when a picture in memory is wrong (a functional bug, not flicker).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BUILDS, build, boot, watchMarker, M, FRAME_T, FIRST_PIXEL_T, screenOf, HERE } from './lib.mjs';
import { picture, positions, assets } from './scene.mjs';
import { frameKeys, classifyFrame, tally } from './fine-check.mjs';

const args = process.argv.slice(2);
const NF = /^\d+$/.test(args[0] || '') ? +args.shift() : 3000;
const names = args.length ? args : Object.keys(BUILDS);
const PAINT_END = FIRST_PIXEL_T + 192 * 224;

const picCache = new Map();
function pic(n) {
  let p = picCache.get(n);
  if (!p) { p = picture(n); picCache.set(n, p); if (picCache.size > 16) picCache.delete(picCache.keys().next().value); }
  return p;
}
const eqPic = (a, b) => { for (let i = 0; i < 6144; i++) if (a.bits[i] !== b.bits[i] || a.colours[i] !== b.colours[i]) return i; return -1; };
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(q * s.length))] : 0; };

export function measure(name, defs, nFrames = NF) {
  const { syms, dck } = build(name, defs);
  const m = boot(dck);
  const log = watchMarker(m, syms.V_MARKER);
  const ovf = [];
  const origWrite = m.bus.write;
  let isReady = false;
  m.bus.write = (a, v) => { if (a === syms.V_MARKER && v === 9) isReady = true; if (a === syms.V_MARKER && v === 2 && isReady) ovf.push(m.ram[syms.V_OVF] | (m.ram[syms.V_OVF + 1] << 8)); origWrite(a, v); };
  let f = 0;
  while (!log.some((e) => e.v === 9)) { M.runFrame(m); if (++f > 400) throw new Error(name + ': not ready'); }
  const bad = [];
  const ready = log.find((e) => e.v === 9);
  { const d = eqPic(screenOf(m), pic(0)); if (d >= 0) bad.push(`state 0 picture differs at offset ${d}`); }
  const T = tally();
  const ups = [];           // {s, start, end, startRel}
  const composeT = [];
  let li = log.indexOf(ready) + 1, s = 0, cur = null, cstart = 0, multi = 0;
  for (let fr = 0; fr < nFrames; fr++) {
    const F0 = m.frameStart;
    M.runFrame(m);
    for (; li < log.length; li++) {
      const e = log[li];
      if (e.v === 1) { s++; cur = { s, start: e.t, end: null, startRel: e.rel }; ups.push(cur); }
      else if (e.v === 2) { cur.end = e.t; }
      else if (e.v === 3) cstart = e.t;
      else if (e.v === 4) composeT.push(e.t - cstart);
    }
    // the states this frame may show
    let a = 0, b = 0;
    for (const u of ups) {
      if (u.end !== null && u.end < F0 + FIRST_PIXEL_T) a = u.s;
      if (u.start < F0 + PAINT_END) b = u.s;
    }
    if (b > a + 1) multi++;
    const r = classifyFrame(frameKeys(m.pixels), pic(a), pic(b), positions(a), positions(b), assets);
    T.add(r, `frame ${fr} states ${a}->${b}`);
    // memory: when no update is in progress, the screen is exactly the fine picture of the last state shown
    const last = ups[ups.length - 1];
    if (last && last.end !== null && bad.length < 5) {
      const d = eqPic(screenOf(m), pic(last.s));
      if (d >= 0) bad.push(`after update ${last.s}: screen differs from the fine picture at offset $${d.toString(16)}`);
    }
  }
  const done = ups.filter((u) => u.end !== null);
  const dur = done.map((u) => u.end - u.start);
  const lateEnd = done.filter((u) => u.end - (u.start - u.startRel) > PAINT_END).length;
  const gaps = done.slice(1).map((u, i) => Math.round((u.start - done[i].start) / FRAME_T));
  const res = {
    name, defs, frames: nFrames, updates: done.length, bad,
    updateT: { median: pct(dur, 0.5), p95: pct(dur, 0.95), worst: Math.max(...dur), min: Math.min(...dur) },
    startRel: { min: Math.min(...done.map((u) => u.startRel)), max: Math.max(...done.map((u) => u.startRel)) },
    composeT: composeT.length ? { median: pct(composeT, 0.5), p95: pct(composeT, 0.95), worst: Math.max(...composeT) } : null,
    tickT: composeT.length ? { median: pct(done.map((u, i) => dur[i] + (composeT[i] || 0)), 0.5), worst: Math.max(...done.map((u, i) => dur[i] + (composeT[i] || 0))) } : null,
    overflowCells: ovf.length ? { median: pct(ovf, 0.5), worst: Math.max(...ovf), ticksWithOverflow: ovf.filter((x) => x > 0).length } : null,
    updatesEndingAfterPaint: lateEnd, tickGaps: gaps.reduce((o, g) => { o[g] = (o[g] || 0) + 1; return o; }, {}),
    framesSpanningTwoUpdates: multi, flicker: T.summary(1000),
  };
  // the same counts per 1,000 updates, and scaled to 20 Hz (333.3 updates per 1,000 frames): every frame that is not clean has an update
  // in flight, and an update starts right after the interrupt whatever the tick length, so the counts scale with the update rate
  const fl = res.flicker, k = 1000 / Math.max(1, done.length);
  res.perKUpdates = { torn: +(fl.torn * k).toFixed(1), broken: +(fl.broken * k).toFixed(1), brokenNotSplit: +((fl.broken - fl.brokenSplitOnly) * k).toFixed(1) };
  res.at20Hz = { torn: +(fl.torn * k / 3).toFixed(1), broken: +(fl.broken * k / 3).toFixed(1), brokenNotSplit: +((fl.broken - fl.brokenSplitOnly) * k / 3).toFixed(1) };
  return res;
}

if (process.argv[1] && process.argv[1].endsWith('run-fine.mjs')) {
  const out = [];
  let fail = false;
  for (const n of names) {
    const t0 = Date.now();
    const r = measure(n, BUILDS[n]);
    out.push(r);
    const fl = r.flicker;
    console.log(`\n== ${n} ${JSON.stringify(r.defs)}  (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
    console.log(`  updates ${r.updates} in ${r.frames} frames; tick gaps (frames) ${JSON.stringify(r.tickGaps)}; update starts ${r.startRel.min}..${r.startRel.max} T after the interrupt`);
    console.log(`  update T: median ${r.updateT.median}, p95 ${r.updateT.p95}, worst ${r.updateT.worst} (min ${r.updateT.min}); updates ending after the last painted line: ${r.updatesEndingAfterPaint}`);
    if (r.composeT) console.log(`  compose T: median ${r.composeT.median}, p95 ${r.composeT.p95}, worst ${r.composeT.worst}; publish + compose: median ${r.tickT.median}, worst ${r.tickT.worst}`);
    if (r.overflowCells) console.log(`  cells composed at publish time: median ${r.overflowCells.median}, worst ${r.overflowCells.worst}, in ${r.overflowCells.ticksWithOverflow} updates`);
    console.log(`  frames ${fl.frames}: clean ${fl.clean}, torn ${fl.torn}, broken ${fl.broken} (of them split-write only ${fl.brokenSplitOnly}); per 1,000: ${JSON.stringify(fl.perK)}`);
    console.log(`  per 1,000 updates: ${JSON.stringify(r.perKUpdates)}; scaled to 20 Hz, per 1,000 frames: ${JSON.stringify(r.at20Hz)}`);
    console.log(`  torn frames per 100: median ${fl.tornPer100.median}, worst ${fl.tornPer100.worst}; frames spanning two updates ${r.framesSpanningTwoUpdates}`);
    if (fl.examples.length) console.log(`  broken examples: ${JSON.stringify(fl.examples.slice(0, 3))}`);
    if (r.bad.length) { fail = true; console.log(`  PICTURE ERRORS: ${r.bad.join('; ')}`); }
    else console.log('  picture in memory = the fine picture after every update: yes');
  }
  writeFileSync(join(HERE, 'build', 'results.json'), JSON.stringify(out, null, 1));
  process.exitCode = fail ? 1 : 0;
}
