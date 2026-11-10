"use strict";
// Turns results.json into "how many refreshes" tables.   node fits.mjs
import { readFileSync } from 'node:fs';
const R = JSON.parse(readFileSync(new URL('./results.json', import.meta.url), 'utf8'));
const get = l => R.find(r => r.label === l) ?? (() => { throw new Error('no result ' + l); })();
const FR = 58688, HZ = 60.1145;
const SPR = 5200, SPR_NOERASE = 3500;          // T per sprite: erase + draw (the spike's figure); draw only (erase is about a third of it in runtime v2)
const k = t => Math.ceil(t / FR);
const f = n => Math.round(n).toLocaleString('en-US');
const V2 = { label: 'V2 24x16 single layer (parent spike, for reference)', worst: 113388 + 15225, bmp: 113388, attr: 15225 };
const rows = [V2];
const add = (r, name) => rows.push({ label: name ?? r.label, worst: r.max + (r.attrMax ?? r.attr), bmp: r.max, attr: r.attrMax ?? r.attr });
const sel = pred => R.filter(pred);
for (const r of R) {
  if (r.group === 'P1' && !/control/.test(r.label)) add(r);
  else if (['P2', 'P2o', 'P2s', 'P2f', 'P3s', 'P3f'].includes(r.group)) add(r);
  else if (r.group === 'P3' && /mid (0|10|30)% fg (0|10|30)%/.test(r.label)) add(r);
  else if (r.group === 'P4') add(r);
}
const farOnly = R.filter(r => r.attrFar && ['P2', 'P2s', 'P3', 'P3s'].includes(r.group));
const fit = t => [1, 2, 3, 4].map(n => t <= n * FR ? 'yes' : '-').join(' / ');
const out = [];
out.push('| variant | worst tick T (bitmap + attr) | fits 1/2/3/4 refreshes alone | min refreshes (fps): alone | with 6 sprites | with 16 sprites | with 6 sprites, no erase | with 16, no erase |');
out.push('|---|---:|---|---|---|---|---|---|');
for (const r of rows) {
  const c = n => `${k(r.worst + n)} (${(HZ / k(r.worst + n)).toFixed(0)})`;
  out.push(`| ${r.label} | ${f(r.worst)} (${f(r.bmp)} + ${f(r.attr)}) | ${fit(r.worst)} | ${c(0)} | ${c(6 * SPR)} | ${c(16 * SPR)} | ${c(6 * SPR_NOERASE)} | ${c(16 * SPR_NOERASE)} |`);
}
console.log(out.join('\n'));
console.log(`\nSprite cost: ${SPR} T per sprite erase+draw (6 = ${f(6 * SPR)}, 16 = ${f(16 * SPR)}); ${SPR_NOERASE} T draw only (6 = ${f(6 * SPR_NOERASE)}, 16 = ${f(16 * SPR_NOERASE)}). Refresh = ${FR} T, ${HZ} Hz.`);
// per-cell model of the 24x16 window (384 cells)
const g = l => get(l).mean;
const base = g('P2 24x16 fg 0% cells, all semi-transparent'), semi = g('P2 24x16 fg 100% cells, all semi-transparent'), opq = g('P2 24x16 fg 100% cells, all opaque, OPAQUE path');
console.log(`\nper cell (24x16, mean): blank fg cell ${(base / 384).toFixed(0)} T all-in; semi-transparent fg cell ${(semi / 384).toFixed(0)} T (+${((semi - base) / 384).toFixed(0)}); opaque fg cell ${(opq / 384).toFixed(0)} T (+${((opq - base) / 384).toFixed(0)})`);
// P4 model: tick cost of the retained far layer when it changes every N ticks
for (const fg of [0, 5, 20]) {
  const a = get(`P4a 24x16 fg ${fg}%: recompose every tick`).mean, b = get(`P4b 24x16 fg ${fg}%: retained, rebuild in one tick`);
  const keep = b.otherMean, reb = b.changeMean - keep;
  const line = [2, 4, 8, 16, 32].map(N => `N=${N}: ${f(keep + reb / N)}`).join('  ');
  console.log(`P4 fg ${fg}%: recompose every tick ${f(a)}; retained: copy-only tick ${f(keep)}, rebuild ${f(reb)} -> sliced mean ${line}; break-even N=${(reb / (a - keep)).toFixed(1)}`);
}

// the same worst ticks when only the far layer owns colour (overlay layers inherit the cell's colours): attribute pass = attr_rows alone
console.log('\n| variant | worst tick T, far-only attributes (bitmap + attr) | min refreshes (fps): alone | with 6 sprites no erase (21,000) | with 16 sprites no erase (56,000) |\n|---|---:|---|---|---|');
for (const r of farOnly) {
  const t = r.max + r.attrFar, c = n => `${k(t + n)} (${(HZ / k(t + n)).toFixed(0)})`;
  console.log(`| ${r.label} | ${f(t)} (${f(r.max)} + ${f(r.attrFar)}) | ${c(0)} | ${c(6 * SPR_NOERASE)} | ${c(16 * SPR_NOERASE)} |`);
}
