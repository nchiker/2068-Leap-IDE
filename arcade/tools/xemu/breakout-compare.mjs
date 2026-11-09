#!/usr/bin/env node
"use strict";
// breakout-compare.mjs -- compare the breakout screens of TSRun, ZEsarUX and Fuse at equal game ticks.
//   node arcade/tools/xemu/breakout-compare.mjs [--dir arcade/build/xemu]
// Reads (all written by the three run scripts into --dir):
//   breakout-tsrun-log.txt, breakout-tsrun-t<N>.bin, breakout-zesarux-t<N>.bin, breakout-zesarux-log.txt,
//   fuse-breakout/frame-*.scr  (fmfconv output of breakout-fuse.sh)
// Writes ASCII art (one char per pixel: '#' ink, '.' paper; 192 lines of 256 chars) of each dump as <name>.txt next to it,
// and prints: ZEsarUX vs TSRun pixel counts per tick; for each tick, whether the Fuse movie has the TSRun screen (and how
// many frames show it, and the first frame); the Fuse frame sequence checked as a run of the TSRun tick sequence.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

const args = process.argv.slice(2);
const dir = resolve(args.includes('--dir') ? args[args.indexOf('--dir') + 1] : 'arcade/build/xemu');
const md5 = (b) => createHash('md5').update(b).digest('hex');
const TICKS = [5, 20, 60];

// ---- helpers --------------------------------------------------------------------------------------------
// bitmap pixel of the 6912-byte dump: the TS2068 display file layout (row y, column x)
const bitmapPixel = (buf, x, y) => {
  const addr = ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2) | (x >> 3);
  return (buf[addr] >> (7 - (x & 7))) & 1;
};
function art(buf) {
  const lines = [];
  for (let y = 0; y < 192; y++) {
    let s = '';
    for (let x = 0; x < 256; x++) s += bitmapPixel(buf, x, y) ? '#' : '.';
    lines.push(s);
  }
  return lines.join('\n') + '\n';
}
// pixel diff between two dumps: differing pixels, the bounding box in pixels, the differing attribute bytes
function diff(a, b) {
  let px = 0, minx = 256, miny = 192, maxx = -1, maxy = -1;
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) {
    if (bitmapPixel(a, x, y) !== bitmapPixel(b, x, y)) {
      px++; minx = Math.min(minx, x); maxx = Math.max(maxx, x); miny = Math.min(miny, y); maxy = Math.max(maxy, y);
    }
  }
  let attr = 0;
  for (let i = 6144; i < 6912; i++) if (a[i] !== b[i]) attr++;
  return { px, attr, box: px ? `x ${minx}-${maxx}, y ${miny}-${maxy}` : '-' };
}
const load = (name) => readFileSync(join(dir, name));

// ---- the dumps ------------------------------------------------------------------------------------------
const tsrunDumps = new Map(), zesDumps = new Map();
for (const n of TICKS) {
  const t = join(dir, `breakout-tsrun-t${n}.bin`), z = join(dir, `breakout-zesarux-t${n}.bin`);
  if (existsSync(t)) tsrunDumps.set(n, load(`breakout-tsrun-t${n}.bin`));
  if (existsSync(z)) zesDumps.set(n, load(`breakout-zesarux-t${n}.bin`));
}
for (const [n, b] of tsrunDumps) writeFileSync(join(dir, `breakout-tsrun-t${n}.txt`), art(b));
for (const [n, b] of zesDumps) writeFileSync(join(dir, `breakout-zesarux-t${n}.txt`), art(b));

console.log('== ZEsarUX vs TSRun, equal ticks (pixels of the bitmap; attribute bytes)');
for (const n of TICKS) {
  const t = tsrunDumps.get(n), z = zesDumps.get(n);
  if (!t || !z) { console.log(`tick ${n}: missing ${!t ? 'TSRun' : ''} ${!z ? 'ZEsarUX' : ''} dump`); continue; }
  const d = diff(t, z);
  console.log(`tick ${n}: ${d.px === 0 && d.attr === 0 ? 'MATCH (identical 6912 bytes)' : `DIFFER: ${d.px} pixels (${d.box}), ${d.attr} attribute bytes`}`);
}

// ---- the TSRun tick sequence from the log (displayed tick -> md5 of the displayed screen) ----------------
const logLines = readFileSync(join(dir, 'breakout-tsrun-log.txt'), 'utf8').trim().split('\n').slice(1);
const tsrunTick = new Map();   // displayed tick -> md5 (first refresh showing it)
for (const line of logLines) {
  const p = line.split(' ');
  const shown = Number(p[3]), hash = p[7];   // refresh ticks sync shown shadowFF file sfx md5 AY...
  if (!tsrunTick.has(shown)) tsrunTick.set(shown, hash);
}
const tsrunMd5s = new Set(tsrunTick.values());

// ---- the Fuse movie ----------------------------------------------------------------------------------------
const fuseDir = join(dir, 'fuse-breakout');
const scr = readdirSync(fuseDir).filter((f) => /^frame-\d+\.scr$/.test(f)).sort();
const fuse = scr.map((f) => md5(readFileSync(join(fuseDir, f))));
console.log(`\n== Fuse: ${scr.length} frames, ${new Set(fuse).size} distinct screens`);
// distinct runs of consecutive identical frames
const runs = [];
fuse.forEach((h, i) => { if (i === 0 || h !== fuse[i - 1]) runs.push({ h, first: i, count: 1 }); else runs.at(-1).count++; });
console.log(`Fuse: ${runs.length} runs of identical frames (a new screen each run)`);
const inTsrun = runs.filter((r) => tsrunMd5s.has(r.h)).length;
console.log(`Fuse runs whose screen occurs in the TSRun tick sequence (ticks 0..${Math.max(...tsrunTick.keys())}): ${inTsrun} of ${runs.length}`);

// tick N's screen: is it in the Fuse movie, and where
const fuseIndex = new Map();
fuse.forEach((h, i) => { if (!fuseIndex.has(h)) fuseIndex.set(h, []); fuseIndex.get(h).push(i); });
console.log('\n== TSRun tick screens found in the Fuse movie');
for (const n of TICKS) {
  const h = tsrunTick.get(n);
  const hits = fuseIndex.get(h) ?? [];
  if (hits.length) {
    console.log(`tick ${n}: in Fuse, ${hits.length} frames, first at frame ${hits[0]}`);
  } else {
    // nearest Fuse screen by pixel count
    const t = tsrunDumps.get(n);
    let best = null;
    if (t) {
      const cands = [...new Set(fuse)];
      for (const hh of cands) {
        const f = fuseFrameBytes(hh);
        if (!f) continue;
        const d = diff(t, f.buf);
        if (!best || d.px + d.attr < best.px + best.attr) best = { ...d, frame: f.index };
      }
    }
    console.log(`tick ${n}: NOT in Fuse; closest Fuse screen: ${best ? `${best.px} pixels (${best.box}), ${best.attr} attribute bytes, at frame ${best.frame}` : 'n/a'}`);
  }
}
function fuseFrameBytes(h) {
  const i = fuse.indexOf(h);
  if (i < 0) return null;
  return { index: i, buf: readFileSync(join(fuseDir, scr[i])) };
}
// the Fuse dumps of the same ticks, as art (the frame that shows the tick's screen)
for (const n of TICKS) {
  const h = tsrunTick.get(n), i = fuse.indexOf(h);
  if (i >= 0) writeFileSync(join(dir, `breakout-fuse-t${n}.txt`), art(readFileSync(join(fuseDir, scr[i]))));
}
// what fraction of the TSRun ticks 1..60 the Fuse movie shows, and the first missing tick
const missing = [];
for (let n = 1; n <= 60; n++) if (!fuseIndex.has(tsrunTick.get(n))) missing.push(n);
console.log(`\nTSRun ticks 1..60 whose screen is not in the Fuse movie: ${missing.length ? missing.join(' ') : 'none'}`);

// ---- every Fuse frame: a TSRun tick screen, a TSRun refresh screen before the first tick (the init, drawn in
// place), or nothing; the tick sequence must be in order -----------------------------------------------------
const refreshHash = new Map();   // md5 -> first refresh showing it (TSRun, every refresh)
const logAll = readFileSync(join(dir, 'breakout-tsrun-log.txt'), 'utf8').trim().split('\n').slice(1);
for (const line of logAll) {
  const p = line.split(' ');
  if (!refreshHash.has(p[7])) refreshHash.set(p[7], { refresh: Number(p[0]), tick: Number(p[3]) });
}
// tick 0's displayed screens are the init's (drawn in place before the first flip), so only ticks 1.. are "tick" screens
const tickByHash = new Map([...tsrunTick].filter(([t]) => t >= 1).map(([t, h]) => [h, t]));
const fuseClass = fuse.map((h) => {
  if (tickByHash.has(h)) return { kind: 'tick', tick: tickByHash.get(h) };
  if (refreshHash.has(h)) return { kind: 'init', refresh: refreshHash.get(h).refresh };
  return { kind: 'none' };
});
const counts = { tick: 0, init: 0, none: 0 };
for (const c of fuseClass) counts[c.kind]++;
console.log(`\nFuse frames: ${counts.tick} show a TSRun tick screen, ${counts.init} show a TSRun screen from before the first tick (init), ${counts.none} show neither`);
const ticks = fuseClass.filter((c) => c.kind === 'tick').map((c) => c.tick);
const ordered = ticks.every((t, i) => i === 0 || t >= ticks[i - 1]);
console.log(`tick sequence in Fuse: ${ordered ? 'in order' : 'OUT OF ORDER'}, from tick ${ticks[0]} to ${ticks.at(-1)}, ticks shown ${new Set(ticks).size}`);
const skipped = [];
for (let t = ticks[0]; t <= ticks.at(-1); t++) if (!ticks.includes(t)) skipped.push(t);
console.log(`ticks skipped by Fuse within that range: ${skipped.length ? skipped.slice(0, 20).join(' ') : 'none'}`);
const noneIdx = fuseClass.map((c, i) => (c.kind === 'none' ? i : -1)).filter((i) => i >= 0);
if (noneIdx.length) console.log(`frames with neither: ${noneIdx.slice(0, 20).join(' ')}${noneIdx.length > 20 ? ' ...' : ''}`);

// ---- AY: the chip's registers (TSRun, m.ay) against the runtime's AY_SHADOW (ZEsarUX) per distinct state -----
// Both logs are sampled after each frame interrupt; the chip powers up with R7 = $3F while the shadow starts at 0,
// so a TSRun R7 of $3F is taken as 0 (the only difference found).
const aySeq = (lines, ticksCol, sfxCol, first) => {
  const out = [];
  for (const line of lines) {
    const p = line.split(' ');
    const ticks = Number(p[ticksCol]);
    if (ticks > 300) continue;
    const ay = p.slice(first, first + 11).map((v) => v.padStart(2, '0'));
    if (ay[7] === '3f' && first === 8) ay[7] = '00';
    const key = ay.join(' ');
    if (!out.length || out.at(-1).key !== key) out.push({ ticks, sfx: Number(p[sfxCol]), key });
  }
  return out;
};
const tsAy = aySeq(logAll, 1, 6, 8);
const zeLines = readFileSync(join(dir, 'breakout-zesarux-log.txt'), 'utf8').trim().split('\n').slice(1);
const zeAy = aySeq(zeLines, 1, 4, 5);
const eq = tsAy.length === zeAy.length && tsAy.every((x, i) => x.key === zeAy[i].key);
console.log(`\n== AY registers (ticks 0..300): TSRun ${tsAy.length} distinct states, ZEsarUX ${zeAy.length}; ${eq ? 'the same states in the same order (R0..R10)' : 'DIFFER'}`);
const starts = (a) => a.map((x, i) => (i > 0 && x.sfx !== 0 && a[i - 1].sfx === 0 ? x.ticks : null)).filter((t) => t !== null);
console.log(`sound effects start at ticks: TSRun ${starts(tsAy).join(' ')}; ZEsarUX ${starts(zeAy).join(' ')}`);
