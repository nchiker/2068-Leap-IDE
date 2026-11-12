// instr.mjs -- record every instruction the code generator emits (no compiler file is changed: the Emitter class is wrapped from outside).
// For each game: listing/<game>.json = {base, codeLen, items: [{a, n, t, args, fr, sl}], labels: {name: addr}, srcMap}
//   a address, n bytes, t mnemonic, args operands (text), fr the code generator's call stack (innermost first, "fn:line"), sl source line of the statement
// and listing/<game>.lst, the generated assembly as text with the source lines.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, GAMES, build } from './common.mjs';
const { Emitter } = await import(join(ROOT, 'src/lang/arcade/z80-emit.js'));
Error.stackTraceLimit = 40;
const INTERNAL = new Set(['constructor', 'label', 'define', 'newLabel', 'addressOf', 'finish', 'imm8', 'imm16', 'addr16', 'rel8', 'target16']);
let depth = 0; const all = [];
const fmt = (x) => typeof x === 'number' ? (x < 0 ? '-' : '') + (Math.abs(x) < 10 ? Math.abs(x) : '$' + Math.abs(x).toString(16).toUpperCase()) : typeof x === 'string' ? x
  : x && 'mem' in x ? `(${fmt(x.mem)})` : x && x.label ? (x.off ? `${x.label}+${x.off}` : x.label) : String(x);
for (const name of Object.getOwnPropertyNames(Emitter.prototype)) {
  const d = Object.getOwnPropertyDescriptor(Emitter.prototype, name);
  if (INTERNAL.has(name) || typeof d.value !== 'function') continue;
  const orig = d.value;
  Emitter.prototype[name] = function (...args) {
    if (depth > 0) return orig.apply(this, args);
    const a = this.pc; depth++;
    try { return orig.apply(this, args); } finally {
      depth--;
      const n = this.pc - a;
      if (n > 0) {
        const st = new Error().stack.split('\n').slice(2).map((l) => { const m = /at (?:Object\.)?(\S+) \(.*arcade-codegen\.js:(\d+):\d+\)/.exec(l) || /at ()(?:file:.*)arcade-codegen\.js:(\d+):\d+/.exec(l); return m ? `${m[1] || '?'}:${m[2]}` : null; }).filter(Boolean);
        (this.__rec ??= (all.push(this), [])).push({ a, n, t: name, args: args.map(fmt), raw: args, fr: st });
      }
    }
  };
}
const origLabel = Emitter.prototype.label;
Emitter.prototype.label = function (name) { (this.__lab ??= []).push([name, this.pc]); return origLabel.call(this, name); };

const OUT = process.env.CSPIKE_OUT || 'listing'; mkdirSync(OUT, { recursive: true });
for (const g of GAMES) {
  all.length = 0;
  const b = build(g);
  const gen = b.res.gen;
  const em = [...all].reverse().find((x) => x.size === gen.code.length && x.org === gen.base);
  if (!em) throw new Error('no emitter for ' + g);
  const items = em.__rec, labels = Object.fromEntries(em.__lab ?? []);
  const sm = gen.srcMap; let si = 0;
  const src = b.text.split('\n');
  for (const it of items) { while (si + 1 < sm.length && sm[si + 1].addr <= it.a) si++; it.sl = sm.length && sm[si].addr <= it.a ? sm[si].line : 0; it.sc = sm.length ? sm[si].col : 0; }
  // jump targets as absolute addresses
  for (const it of items) {
    if (['jp', 'jr', 'call', 'djnz'].includes(it.t)) { const tg = it.raw[it.raw.length - 1]; it.tg = typeof tg === 'number' ? tg : typeof tg === 'string' ? (tg === '(hl)' ? null : em.labels.get(tg)) : tg && tg.label ? em.labels.get(tg.label) + (tg.off || 0) : null; it.cc = it.raw.length > 1 ? it.raw[0] : null; }
    delete it.raw;
  }
  writeFileSync(`${OUT}/${g}.json`, JSON.stringify({ game: g, v: b.v, base: gen.base, codeLen: gen.code.length, items, labels, usage: b.res.usage, procs: b.res.map.procs }));
  const byAddr = new Map(); for (const [n, a] of em.__lab ?? []) (byAddr.get(a) ?? byAddr.set(a, []).get(a)).push(n);
  let out = '', lastSl = -1;
  for (const it of items) {
    for (const n of byAddr.get(it.a) ?? []) out += `${n}:\n`;
    if (it.sl !== lastSl && !['db', 'dw', 'ds'].includes(it.t)) { out += `; ${it.sl}: ${(src[it.sl - 1] ?? '').trim()}\n`; lastSl = it.sl; }
    out += `  ${it.a.toString(16).toUpperCase()}  ${it.t.toUpperCase().padEnd(5)} ${it.args.join(',').slice(0, 60).padEnd(26)} ; ${it.n}  ${it.fr.slice(0, 3).join(' < ')}\n`;
  }
  writeFileSync(`${OUT}/${g}.lst`, out);
  console.log(g, 'items', items.length, 'bytes', items.reduce((s, x) => s + x.n, 0), 'code', gen.code.length);
}
