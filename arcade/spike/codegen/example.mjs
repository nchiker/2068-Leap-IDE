// example.mjs <game> <source line> [dir ...] -- the code emitted for one source line, from each listing directory
import { readFileSync } from 'node:fs';
const [g, line, ...dirs] = process.argv.slice(2);
for (const d of dirs.length ? dirs : ['listing']) {
  const t = readFileSync(`${d}/${g}.lst`, 'utf8').split('\n'); let on = false, n = 0; const out = [];
  for (const l of t) { if (l.startsWith('; ')) on = l.startsWith(`; ${line}:`); if (on) { out.push(l.replace(/ ; (\d+) .*/, ' ; $1')); const m = / ; (\d+) /.exec(l); if (m) n += +m[1]; } }
  console.log(`--- ${d}: ${n} bytes`); console.log(out.join('\n'));
}
