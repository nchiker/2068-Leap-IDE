"use strict";
// Turns build/all.json into the Markdown tables of RESULTS.md.  node make-tables.mjs
import { readFileSync } from 'node:fs';
const R = JSON.parse(readFileSync(new URL('./build/all.json', import.meta.url)));
const FR = 58688, HZ = 3528000 / FR;
const tps = T => (3528000 / T).toFixed(1);
const lock = T => (HZ / Math.ceil(T / FR)).toFixed(1);
const k = x => (x / 1000).toFixed(0) + 'k';
const key = r => `${r.cfg.METHOD}|${r.cfg.W}x${r.cfg.H}|${r.cfg.WCOL}|${r.cfg.MAPN}|${r.cfg.INTERP ? 1 : 0}`;
const by = Object.fromEntries(R.map(r => [key(r), r]));
const wins = ['64x48', '96x64', '128x96', '128x128'];
const out = [];
function table(title, map, interp) {
  out.push(`\n**${title}**\n`);
  out.push('| window | col px | rays | A: clear+RMW | B: byte-compose | best T-states | cast | draw+clear | ticks/s (raw) | ticks/s (frame-locked) |');
  out.push('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
  for (const w of wins) for (const c of [1, 2, 4, 8]) {
    const a = by[`0|${w}|${c}|${map}|${interp}`], b = by[`1|${w}|${c}|${map}|${interp}`];
    if (!a || !b) continue;
    const best = a.avg.total <= b.avg.total ? a : b;
    out.push(`| ${w} | ${c} | ${parseInt(w) / c} | ${k(a.avg.total)} | ${k(b.avg.total)} | **${Math.round(best.avg.total)}** (${best.cfg.METHOD ? 'B' : 'A'}) | ${k(best.avg.cast + best.avg.setup)} | ${k(best.avg.draw + best.avg.clear)} | ${tps(best.avg.total)} | ${lock(best.avg.total)} |`);
  }
}
table('16x16 map, every ray cast', 16, 0);
table('16x16 map, interpolated rays (every 4th ray cast, flat walls interpolated)', 16, 1);
out.push('\n**32x32 map** (T-states; avg DDA steps per cast ray 8.9 against 5.1 on the 16x16 map)\n');
out.push('| window | col px | interp | A | B | ticks/s best (raw) | frame-locked |');
out.push('|---|---:|---|---:|---:|---:|---:|');
for (const [w, c, i] of [['64x48', 1, 0], ['96x64', 2, 0], ['96x64', 2, 1], ['128x96', 2, 0], ['128x96', 2, 1], ['128x96', 4, 0], ['128x96', 4, 1]]) {
  const a = by[`0|${w}|${c}|32|${i}`], b = by[`1|${w}|${c}|32|${i}`];
  const f = r => r ? k(r.avg.total) : '-';
  const best = Math.min(a ? a.avg.total : 1e9, b ? b.avg.total : 1e9);
  out.push(`| ${w} | ${c} | ${i ? 'yes' : 'no'} | ${f(a)} | ${f(b)} | ${tps(best)} | ${lock(best)} |`);
}
out.push('\n**Cost split, 16x16 map, every ray cast** (T-states averaged over 16 poses; setup = per-frame direction/plane/step)\n');
out.push('| config | setup | ray casting | clear | draw | total | worst pose | best pose |');
out.push('|---|---:|---:|---:|---:|---:|---:|---:|');
for (const [m, w, c] of [[0, '128x96', 2], [1, '128x96', 2], [0, '128x96', 1], [1, '128x96', 1], [0, '128x96', 4], [1, '128x96', 4], [0, '64x48', 4], [1, '64x48', 4], [0, '96x64', 2], [1, '96x64', 2], [0, '128x128', 2], [1, '128x128', 2]]) {
  const r = by[`${m}|${w}|${c}|16|0`];
  out.push(`| ${m ? 'B' : 'A'} ${w} w${c} | ${Math.round(r.avg.setup)} | ${Math.round(r.avg.cast)} | ${Math.round(r.avg.clear)} | ${Math.round(r.avg.draw)} | ${Math.round(r.avg.total)} | ${r.max} | ${r.min} |`);
}
out.push('\n**Start-up (tables built on the Z80)**: ' + [16, 32].map(n => { const r = R.find(x => x.cfg.MAPN === n); return `${n}x${n} map: ${(r.init / 1000).toFixed(0)}k T = ${(r.init / FR).toFixed(0)} frames = ${(r.init / 3528000).toFixed(2)} s`; }).join('; '));
console.log(out.join('\n'));
