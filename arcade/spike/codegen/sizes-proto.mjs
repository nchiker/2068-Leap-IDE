// sizes-proto.mjs -- measured code bytes of every example with each prototype switch (the scratch copy cspike/wt-proto), against the untouched worktree
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const HERE = new URL('.', import.meta.url).pathname;
const run = (root, opt) => JSON.parse(execFileSync('node', [HERE + 'size1.mjs'], { env: { ...process.env, CSPIKE_ROOT: root, CSPIKE_OPT: opt }, encoding: 'utf8' }));
const WT = HERE + '../wt-cspike', PR = HERE + (process.env.CSPIKE_PROTO || 'wt-proto');
const base = run(WT, ''), same = run(PR, '');
const GAMES = Object.keys(base);
if (JSON.stringify(base) !== JSON.stringify(same)) throw new Error('the prototype tree with no switch differs from the worktree');
const sets = process.argv.slice(2).length ? process.argv.slice(2) : ['hl', 'jr', 'cmpc', 'cmpv', 'cmpc,cmpv', 'sel', 'arr', 'shr', 'hl,cmpc,sel', 'hl,cmpc,sel,jr', 'hl,cmpc,sel,arr', 'hl,cmpc,cmpv,sel,arr,jr', 'hl,cmpc,cmpv,sel,arr,shr,jr'];
let out = `| switch | ${GAMES.join(' | ')} | total |\n|---|${GAMES.map(() => '--:').join('|')}|--:|\n| code bytes now | ${GAMES.map((g) => base[g][0]).join(' | ')} | ${GAMES.reduce((s, g) => s + base[g][0], 0)} |\n`;
const res = { base };
for (const o of sets) { const r = run(PR, o); res[o] = r; out += `| ${o} | ${GAMES.map((g) => r[g][0] - base[g][0]).join(' | ')} | ${GAMES.reduce((s, g) => s + r[g][0] - base[g][0], 0)} |\n`; }
console.log(out); writeFileSync(HERE + 'sizes-proto.md', out); writeFileSync(HERE + 'sizes-proto.json', JSON.stringify(res));
