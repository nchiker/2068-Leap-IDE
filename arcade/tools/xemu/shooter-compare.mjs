#!/usr/bin/env node
"use strict";
// shooter-compare.mjs -- compare the shooter's screens and state at equal ticks: TSRun (live, via shooter-tsrun.mjs's runCart) against
// ZEsarUX's dumps (shooter-zesarux.py) and, if present, Fuse's movie frames (fuse-shooter/frame-*.scr).
//   node arcade/tools/xemu/shooter-compare.mjs [--dir arcade/build/xemu] [--cart arcade/build/shooter.dck]
// Writes ASCII art (192 lines of 256 chars, '#' ink) of each screen dump as <name>.txt next to it.
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { newMachine, runCart } from './shooter-tsrun.mjs';

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(k) ? args[args.indexOf(k) + 1] : d);
const dir = resolve(opt('--dir', join(dirname(fileURLToPath(import.meta.url)), '../../build/xemu')));
const TICKS = [5, 30, 90, 200];
const md5 = (b) => createHash('md5').update(b).digest('hex');
const ZP = join(dir, 'zesarux/shooter-zesarux');
const TP = join(dir, 'tsrun/shooter-tsrun');

const bitmapPixel = (buf, x, y) => {
  const addr = ((y & 0xC0) << 5) | ((y & 0x07) << 8) | ((y & 0x38) << 2) | (x >> 3);
  return (buf[addr] >> (7 - (x & 7))) & 1;
};
const art = (buf) => {
  const lines = [];
  for (let y = 0; y < 192; y++) { let s = ''; for (let x = 0; x < 256; x++) s += bitmapPixel(buf, x, y) ? '#' : '.'; lines.push(s); }
  return lines.join('\n') + '\n';
};
const pixDiff = (a, b) => {
  let px = 0;
  for (let y = 0; y < 192; y++) for (let x = 0; x < 256; x++) if (bitmapPixel(a, x, y) !== bitmapPixel(b, x, y)) px++;
  let attr = 0;
  for (let i = 6144; i < 6912; i++) if (a[i] !== b[i]) attr++;
  return { px, attr };
};
const byteDiff = (a, b, off, len) => { let n = 0; for (let i = off; i < off + len; i++) if (a[i] !== b[i]) n++; return n; };

// ---- TSRun, every refresh: the displayed screen md5 and the state (SPR_TAB 96 + CELL_TILE 768) ----------------
// one run: the screen of every refresh (rows, md5 and dump) and the state (SPR_TAB + CELL_TILE) of every refresh
const S = JSON.parse(readFileSync(join(dir, '../../build/v2/runtime.json'), 'utf8')).symbols;
const stateAt = [];
const { rows } = runCart(newMachine(), { ticks: 210, keep: true, onRefresh: (mm, row) => {
  stateAt.push({ ticks: row.ticks, shown: row.shown, state: Buffer.from(mm.ram.subarray(S.SPR_TAB, S.SPR_TAB + 96)).toString('hex') +
    Buffer.from(mm.ram.subarray(S.CELL_TILE, S.CELL_TILE + 768)).toString('hex') });
} });
const tsScreens = new Map(); // shown tick -> dump (first refresh)
for (const r of rows) if (!tsScreens.has(r.shown)) tsScreens.set(r.shown, r.dump);
console.log(`TSRun: ${rows.length} refreshes; state rows ${stateAt.length}`);

console.log('\n== ZEsarUX vs TSRun: the displayed screen (6912 bytes) at equal ticks');
for (const n of TICKS) {
  const z = existsSync(`${ZP}-t${n}.bin`) ? readFileSync(`${ZP}-t${n}.bin`) : null;
  const t = tsScreens.get(n);
  if (!z || !t) { console.log(`tick ${n}: missing`); continue; }
  writeFileSync(`${ZP}-t${n}.txt`, art(z));
  writeFileSync(`${TP}-t${n}.txt`, art(t));
  const d = pixDiff(t, z);
  const same = d.px === 0 && d.attr === 0;
  // is the ZEsarUX screen some TSRun refresh's screen (any tick)?
  const zm = md5(z);
  const at = rows.find((r) => r.md5 === zm);
  console.log(`tick ${n}: ${same ? 'MATCH (identical 6912 bytes)' : `DIFFER: ${d.px} pixels, ${d.attr} attribute bytes`}` +
    (at ? `; ZEsarUX screen = TSRun refresh ${at.f} (displayed tick ${at.shown})` : '; ZEsarUX screen is no TSRun refresh'));
}

console.log('\n== ZEsarUX vs TSRun: SPR_TAB (96 bytes) and the cell map (CELL_TILE, 768 bytes) at equal V_TICKS');
for (const n of TICKS) {
  const zf = `${ZP}-state-t${n}.bin`;
  if (!existsSync(zf)) { console.log(`tick ${n}: missing`); continue; }
  const z = readFileSync(zf);
  const tsAt = stateAt.find((s) => s.ticks === n);
  const t = Buffer.from(tsAt.state, 'hex');
  const sprDiff = byteDiff(t, z, 0, 96), cellDiff = byteDiff(t, z, 96, 768);
  const zHex = z.toString('hex');
  const match = stateAt.find((s) => s.state === zHex);
  console.log(`tick ${n}: SPR_TAB ${sprDiff === 0 ? 'same' : `${sprDiff} bytes differ`}; cell map ${cellDiff === 0 ? 'same' : `${cellDiff} bytes differ`}` +
    (match ? `; ZEsarUX state = TSRun refresh with V_TICKS ${match.ticks} (displayed ${match.shown})` : '; ZEsarUX state matches no TSRun refresh'));
}

// ---- the AY registers of the first sound effects: TSRun (chip) and ZEsarUX (AY_SHADOW) per tick and state -------
const seq = (lines, tCol, sCol, first) => {
  const out = [];
  for (const line of lines) {
    const p = line.trim().split(/\s+/);
    const ticks = Number(p[tCol]);
    if (ticks > 200) continue;
    const ay = p.slice(first, first + 11);
    if (ay[7] === '3f') ay[7] = '00';   // the chip's power-up R7 ($3F, TSRun) against the shadow's 0 (ZEsarUX)
    const key = ay.join(' ');
    if (!out.length || out.at(-1).key !== key) out.push({ ticks, sfx: Number(p[sCol]), key });
  }
  return out;
};
const tsLog = readFileSync(`${TP}-log.txt`, 'utf8').trim().split('\n').slice(1);
const zeLog = readFileSync(`${ZP}-log.txt`, 'utf8').trim().split('\n').slice(1);
const tsAy = seq(tsLog, 1, 5, 7);
const zeAy = seq(zeLog, 1, 5, 6);
const eq = tsAy.length === zeAy.length && tsAy.every((x, i) => x.key === zeAy[i].key);
console.log(`\n== AY registers (ticks 0..200): TSRun ${tsAy.length} distinct states, ZEsarUX ${zeAy.length}; ${eq ? 'the same states in the same order' : 'DIFFER'}`);
const starts = (a) => a.map((x, i) => (i > 0 && x.sfx !== 0 && a[i - 1].sfx === 0 ? x.ticks : null)).filter((t) => t !== null);
console.log(`sound effects start at ticks: TSRun ${starts(tsAy).slice(0, 12).join(' ')}; ZEsarUX ${starts(zeAy).slice(0, 12).join(' ')}`);

// ---- Fuse: the movie's frames (fmfconv .scr, 6912 bytes) matched to the TSRun displayed screens of every tick ------
const fuseDir = join(dir, 'fuse-shooter');
if (existsSync(fuseDir)) {
  const scr = readdirSync(fuseDir).filter((f) => /^frame-\d+\.scr$/.test(f)).sort();
  const fuse = scr.map((f) => readFileSync(join(fuseDir, f)));
  const fmd5 = fuse.map((b) => md5(b));
  const tsByMd5 = new Map();   // screen md5 -> displayed tick (TSRun, first refresh)
  for (const r of rows) if (!tsByMd5.has(r.md5)) tsByMd5.set(r.md5, r.shown);
  const tickOf = fmd5.map((h) => (tsByMd5.has(h) ? tsByMd5.get(h) : null));
  const known = tickOf.filter((t) => t !== null).length;
  console.log(`\n== Fuse: ${fuse.length} frames; ${known} show a TSRun screen (a displayed tick); ${fuse.length - known} show none`);
  const first = new Map();     // tick -> first frame showing it
  tickOf.forEach((t, i) => { if (t !== null && !first.has(t)) first.set(t, i); });
  for (const n of TICKS) {
    // the TSRun screen of tick n (the same bytes can show on several ticks: the tick-5 screen is also on ticks 1..~25)
    const want = md5(tsScreens.get(n));
    const idx = [];
    fmd5.forEach((h, i) => { if (h === want) idx.push(i); });
    const ticksWithIt = [...new Set(rows.filter((r) => r.md5 === want).map((r) => r.shown))];
    console.log(`tick ${n}: ${idx.length ? `in Fuse, ${idx.length} frames, first at frame ${idx[0]}` : 'NOT in Fuse'}; TSRun shows it on ticks ${ticksWithIt.length > 6 ? `${ticksWithIt[0]}..${ticksWithIt.at(-1)} (${ticksWithIt.length} ticks)` : ticksWithIt.join(',')}`);
    if (idx.length) writeFileSync(`${dir}/fuse-shooter-t${n}.txt`, art(fuse[idx[0]]));
  }
  const seq = tickOf.filter((t) => t !== null);
  const inOrder = seq.every((t, i) => i === 0 || t >= seq[i - 1]);
  const skipped = [];
  const ticksSeen = new Set(seq);
  for (let t = seq[0]; t <= seq.at(-1); t++) if (!ticksSeen.has(t)) skipped.push(t);
  console.log(`tick sequence in Fuse: ${inOrder ? 'in order' : 'OUT OF ORDER'}; ticks ${[...ticksSeen].length} seen from ${seq[0]} to ${seq.at(-1)}; skipped ${skipped.length}`);
  // frames per tick in Fuse (its own refresh count between the first frames of consecutive ticks)
  const fpt = [];
  for (let t = 2; t <= 200; t++) if (first.has(t) && first.has(t - 1)) fpt.push(first.get(t) - first.get(t - 1));
  const avgF = fpt.reduce((a, b) => a + b, 0) / fpt.length;
  const hist = {}; for (const g of fpt) hist[g] = (hist[g] || 0) + 1;
  console.log(`Fuse frames per tick (ticks 2..200, first-frame to first-frame): average ${avgF.toFixed(3)}, worst ${Math.max(...fpt)}, histogram ${JSON.stringify(hist)}`);
  console.log(`Fuse wall-clock: ${fuse.length} frames in the run (see fuse.log); its refresh rate is its own`);
}
