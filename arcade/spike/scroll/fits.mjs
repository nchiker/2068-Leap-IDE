"use strict";
// Turns the measured T-states (results.json, from run-scroll.mjs) into "how many refreshes" tables.   node fits.mjs
import { readFileSync } from 'node:fs';
const R = JSON.parse(readFileSync(new URL('./results.json', import.meta.url), 'utf8'));
const get = l => R.find(r => r.label === l) ?? (() => { throw new Error('no result ' + l); })();
const FR = 58688, HZ = 60.1;
const SPR16 = 105903, SPR6 = Math.round(SPR16 * 6 / 16);           // runtime v2 worst case (erase 33.5k + draw 53.2k + rest), scaled for 6
const NOERASE16 = SPR16 - 33500 - 1300, NOERASE6 = Math.round(NOERASE16 * 6 / 16);   // when the background is repainted anyway
const k = t => Math.ceil(t / FR);
const f = n => Math.round(n).toLocaleString('en-US');
const rows = [
  // [name, worst tick T (bitmap worst + the attribute work of a cell-step tick), erase needed?, speed rule]
  ['V1 naive, 32x24', get('V1 naive').max + get('V2 32x24 (full)').attr, false],
  ['V2 tables, 32x24', get('V2 32x24 (full)').max + get('V2 32x24 (full)').attr, false],
  ['V2 + blank cells, 32x24 (level world)', get('V2 +blank, level world').max + get('V2 +blank, level world').attr, false],
  ['V3 32x16 (full width)', get('V3 32x16').max + get('V3 32x16').attr, false],
  ['V3 32x16 + blank (level)', get('V3 32x16 +blank, level').max + get('V3 32x16 +blank, level').attr, false],
  ['V3 28x20', get('V3 28x20').max + get('V3 28x20').attr, false],
  ['V3 28x20 + blank (level)', get('V3 28x20 +blank, level').max + get('V3 28x20 +blank, level').attr, false],
  ['V3 24x16', get('V3 24x16').max + get('V3 24x16').attr, false],
  ['V3 24x16 + blank (level)', get('V3 24x16 +blank, level').max + get('V3 24x16 +blank, level').attr, false],
  ['V3 20x14', get('V3 20x14').max + get('V3 20x14').attr, false],
  ['V3 20x14 + blank (level)', get('V3 20x14 +blank, level').max + get('V3 20x14 +blank, level').attr, false],
  ['V3 16x12', get('V3 16x12').max + get('V3 16x12').attr, false],
  ['V3 16x12 + blank (level)', get('V3 16x12 +blank, level').max + get('V3 16x12 +blank, level').attr, false],
  ['V4 shift 1 px/tick, 2 files', get('V4 shift, 2 files (copy)').max, true],
  ['V4 shift 2 px/tick, 2 files', get('V4 2 px/tick').max, true],
  ['V4 shift 1 px/tick, 1 file (in place)', get('V4 shift, in place (1 file)').max, true],
  ['V5 step tick (per file), 8 px', 134810, true],
  ['V5 full redraw (no scroll trick)', get('V5 full redraw').mean + get('V5 full redraw').attr, true],
];
const fit = t => [1, 2, 3, 4].map(n => t <= n * FR ? 'yes' : '-');
console.log('| variant | worst tick T | fits 1 / 2 / 3 / 4 refreshes (scroll alone) | with 16 sprites (+105,903 T, as asked) | min refreshes with 6 sprites (fps) | min with 16 sprites (fps) |');
console.log('|---|---:|---|---|---|---|');
for (const [n, t, erase] of rows) {
  const s6 = erase ? SPR6 : NOERASE6, s16 = erase ? SPR16 : NOERASE16;
  console.log(`| ${n} | ${f(t)} | ${fit(t).join(' / ')} | ${fit(t + SPR16).join(' / ')} | ${k(t + s6)} (${(HZ / k(t + s6)).toFixed(0)}) | ${k(t + s16)} (${(HZ / k(t + s16)).toFixed(0)}) |`);
}
console.log(`\nSprite cost: 16 sprites erase+draw ${f(SPR16)} T (runtime v2 worst case), 6 sprites ${f(SPR6)} (scaled). When the background is repainted every tick (V2/V3) the erase is not needed: 16 -> ${f(NOERASE16)}, 6 -> ${f(NOERASE6)}; the last two columns use that for V1/V2/V3 and the full cost for V4/V5.`);
