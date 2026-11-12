// perf-table.mjs -- the measured per-tick T-states of perf/<switches>.txt as one table (differences from perf/base.txt)
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
const n = (s) => Number(s.replace(/,/g, ''));
function parse(f) {
  const t = readFileSync(f, 'utf8'); const o = {};
  let m = /not a world load: \d+: median ([\d,]+), 95th ([\d,]+), 99th ([\d,]+), worst ([\d,]+) \(tick (\d+);.*mean ([\d,]+)/.exec(t);
  if (m) Object.assign(o, { 'runner tick median': n(m[1]), 'runner tick 95th': n(m[2]), 'runner tick worst': n(m[4]), 'runner worst tick no.': +m[5], 'runner tick mean': n(m[6]) });
  const v = t.split('== vaults')[1]?.split('== platformer')[0] ?? '';
  m = /win run:.*?whole tick \(interrupt time included\): median ([\d,]+), 95th ([\d,]+).*?\n\s+PROC FRAME[^:]*: median ([\d,]+), 95th ([\d,]+), worst ([\d,]+), mean ([\d,]+)/s.exec(v);
  if (m) Object.assign(o, { 'vaults (win) tick median': n(m[1]), 'vaults (win) tick 95th': n(m[2]), 'vaults (win) PROC FRAME median': n(m[3]), 'vaults (win) PROC FRAME 95th': n(m[4]), 'vaults (win) PROC FRAME mean': n(m[6]) });
  m = /over the budget: ticks ([\d, ]+)/.exec(v); if (m) o['vaults (win) ticks over budget'] = m[1].split(',').length;
  const p = t.split('== platformer')[1] ?? '';
  m = /win twice:.*?median ([\d,]+), 95th ([\d,]+), worst ([\d,]+).*?\n\s+PROC FRAME[^:]*: median ([\d,]+), 95th ([\d,]+), worst ([\d,]+), mean ([\d,]+)/s.exec(p);
  if (m) Object.assign(o, { 'platformer tick worst': n(m[3]), 'platformer PROC FRAME median': n(m[4]), 'platformer PROC FRAME worst': n(m[6]), 'platformer PROC FRAME mean': n(m[7]) });
  return o;
}
const base = parse('perf/base.txt');
const files = readdirSync('perf').filter((f) => f.endsWith('.txt') && f !== 'base.txt').sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
const keys = Object.keys(base);
let out = `| measure | now | ${files.map((f) => f.replace('.txt', '')).join(' | ')} |\n|---|--:|${files.map(() => '--:').join('|')}|\n`;
const all = files.map((f) => parse('perf/' + f));
for (const k of keys) out += `| ${k} | ${base[k]} | ${all.map((r) => (r[k] === undefined ? '?' : /no\.|over/.test(k) ? r[k] : (r[k] - base[k] >= 0 ? '+' : '') + (r[k] - base[k]))).join(' | ')} |\n`;
writeFileSync('perf-table.md', out); console.log(out);
