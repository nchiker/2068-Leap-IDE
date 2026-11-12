// listing-diff.mjs -- for every example game: each source line's generated code BEFORE and AFTER a compiler change (compiler size pass,
// docs/ARCADE_COMPILER_SIZE_CONTRACT.md section 5: "every byte change is explained"). It grew out of the spike's instr.mjs.
//
//   node arcade/tools/listing-diff.mjs --before <git ref | directory> [options]
//
//   --before X        the compiler to compare with: a git ref (its src/lang/arcade is read with `git archive` into a temporary directory;
//                     the repository is not changed) or a directory that has src/lang/arcade/ (another checkout). Default: HEAD.
//   --game NAME       only this example (repeatable). Default: every example of arcade/examples that this tool knows (GAMES).
//   --before-emit L   --after-emit L     the emitter's optimisations for that side: a list of hl,ret,jr, or `none` (default: the compiler's
//                     own default, all on). `--before . --before-emit none --after-emit jr` shows what F2 alone does. (A compiler from
//                     before the size pass ignores it.)
//   --out DIR         write DIR/<game>.diff.txt and DIR/<game>.after.lst (the full listing with source lines) instead of printing
//   --all             also print the source lines whose code did not change
//
// Both compilers compile the SAME source text and assets (this checkout's arcade/examples) for the SAME runtime (this checkout's
// arcade/build). The code is attributed to source lines by the compiler's own source map (the debugger's): the instructions from one map
// entry up to the next belong to that entry's line, so the out-of-line stubs emitted after a PROC's RET count for its last statement.
// Code after a support label (lib$..., frame$..., scn$..., entry$...) is shown under that label, data as byte counts only.
// A compiler with Emitter.listing() (the size pass on) gives the listing itself; an older one is recorded by wrapping its Emitter from
// outside (no compiler file is changed).
"use strict";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const GAMES = ['runner', 'vaults', 'platformer', 'shooter', 'blockfall', 'breakout', 'bounce'];

const argv = process.argv.slice(2);
const opt = { before: 'HEAD', games: [], out: null, all: false, beforeEmit: undefined, afterEmit: undefined };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
  if (a === '--before') opt.before = next();
  else if (a === '--game') opt.games.push(next());
  else if (a === '--out') opt.out = next();
  else if (a === '--all') opt.all = true;
  else if (a === '--before-emit') opt.beforeEmit = next();
  else if (a === '--after-emit') opt.afterEmit = next();
  else { console.error(`unknown argument ${a} (see the header of arcade/tools/listing-diff.mjs)`); process.exit(2); }
}
const emitOf = (s) => (s === undefined ? undefined : { hl: false, ret: false, jr: false, ...Object.fromEntries(s === 'none' ? [] : s.split(',').filter(Boolean).map((k) => [k, true])) });

/** The directory of the compiler to compare with: `x` itself when it has src/lang/arcade, else the git ref `x` unpacked into a temporary directory. */
function compilerDir(x) {
  if (existsSync(join(resolve(x), 'src/lang/arcade/arcade-compile.js'))) return resolve(x);
  const dir = mkdtempSync(join(tmpdir(), 'listing-diff-'));
  process.on('exit', () => rmSync(dir, { recursive: true, force: true }));      // the unpacked copy is removed when the tool ends
  const tar = execFileSync('git', ['-C', ROOT, 'archive', x, 'src/lang/arcade'], { maxBuffer: 1 << 28 });      // read-only: nothing in the repository changes
  execFileSync('tar', ['-x', '-C', dir], { input: tar });
  return dir;
}

const rts = {};
function rt(v) {
  if (!rts[v]) {
    const d = join(ROOT, 'arcade/build/v' + v);
    const runtime = JSON.parse(readFileSync(join(d, 'runtime.json'), 'utf8'));
    rts[v] = { runtime, image: new Uint8Array(readFileSync(join(d, runtime.image ?? 'runtime.bin'))) };
  }
  return rts[v];
}

const num = (x) => (x < 0 ? '-' : '') + (Math.abs(x) < 10 ? String(Math.abs(x)) : '$' + Math.abs(x).toString(16).toUpperCase());
const fmt = (x) => (typeof x === 'number' ? num(x) : typeof x === 'string' ? x : x && 'mem' in x ? `(${fmt(x.mem)})` : x && typeof x.label === 'string' ? (x.off ? `${x.label}+${x.off}` : x.label)
  : x && typeof x.patch === 'number' ? `${num(x.patch)} (patched)` : String(x));

/** A compiler (the modules under `dir`) with a way to get the listing of what it compiled: {compile(game, emit) -> {items, srcMap, base, code, usage}}. */
async function loadCompiler(dir) {
  const url = (f) => pathToFileURL(join(dir, 'src/lang/arcade', f)).href;
  const { compile, requiredRuntime } = await import(url('arcade-compile.js'));
  const { Emitter } = await import(url('z80-emit.js'));
  const own = typeof Emitter.prototype.listing === 'function';
  const seen = [];                                    // (an older compiler) the emitters of the last compile, with what they recorded
  if (!own) {
    const INTERNAL = new Set(['constructor', 'label', 'define', 'newLabel', 'addressOf', 'finish', 'imm8', 'imm16', 'addr16', 'rel8', 'target16']);
    let depth = 0;
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
          if (n > 0) (this.__rec ??= (seen.push(this), [])).push({ addr: a, n, mn: name, args, labels: [], data: ['db', 'dw', 'ds', 'align'].includes(name) });
        }
      };
    }
    const origLabel = Emitter.prototype.label;
    Emitter.prototype.label = function (name) { (this.__lab ??= []).push([name, this.pc]); return origLabel.call(this, name); };
  }
  return {
    dir, own,
    compile(game, emit) {
      const text = readFileSync(join(ROOT, 'arcade/examples', game + '.arc'), 'utf8');
      const af = join(ROOT, 'arcade/examples', game + '.assets.json');
      const assets = existsSync(af) ? JSON.parse(readFileSync(af, 'utf8')) : { sprites: {} };
      seen.length = 0;
      const res = compile(text, { ...rt(requiredRuntime(text, assets).version), assets, ...(emit ? { emit } : {}) });
      if (res.errors.length) throw new Error(`${game} (${dir}): ${JSON.stringify(res.errors.slice(0, 3))}`);
      const gen = res.gen;
      let items;
      if (own) items = gen.emitter.listing().map((it) => ({ addr: it.addr, n: it.bytes.length, mn: it.mn, args: it.args, labels: it.labels, data: it.data, dead: !!it.dead, why: it.why }));
      else {
        const em = [...seen].reverse().find((x) => x.size === gen.code.length && x.org === gen.base);
        if (!em) throw new Error(`${game}: the emitter of the compiled code was not found`);
        items = em.__rec;
        const at = new Map(items.map((it) => [it.addr, it]));
        for (const [name, a] of em.__lab ?? []) at.get(a)?.labels.push(name);
      }
      return { text, items, srcMap: [...gen.srcMap].sort((a, b) => a.addr - b.addr), base: gen.base, code: gen.code.length, usage: res.usage };
    },
  };
}

const SUPPORT = /^(lib\$|fmt\$|frame\$|scn\$|entry\$|tab\$|wl\$|hot\$|str\$|inst\$|tileset\$|sfx\$|song\$|map\$|maps\$|init\$)/;
/** Group the items by source line: Map key -> {key, title, items}; key is a line number, 'support: <label>' or 'data'. */
function groups(c, src) {
  const out = new Map();
  let si = -1, support = null;
  for (const it of c.items) {
    let moved = false;
    // (a RET left out by a tail call has the address of what follows it, but belongs to the line of its CALL)
    if (!(it.dead && it.why === 'tail')) while (si + 1 < c.srcMap.length && c.srcMap[si + 1].addr <= it.addr) { si++; moved = true; }
    if (moved) support = null;
    const sup = it.labels.find((l) => SUPPORT.test(l));
    if (sup && !(si >= 0 && c.srcMap[si].addr === it.addr)) support = sup;
    const key = it.data ? 'data' : support ? `support: ${support}` : si < 0 ? 'support: (start)' : c.srcMap[si].line;
    if (!out.has(key)) out.set(key, { key, title: typeof key === 'number' ? `${key}: ${(src[key - 1] ?? '').trim()}` : key, items: [] });
    out.get(key).items.push(it);
  }
  return out;
}
const textOf = (it) => `${it.dead ? '; left out: ' : ''}${it.mn}${it.args.length ? ' ' + it.args.filter((x) => x !== undefined).map(fmt).join(',') : ''}`;
const keyOf = (it) => textOf(it).replace(/\$\d+/g, '$');          // generated label numbers may differ between two compilers: not a difference
const bytesOf = (g) => (g ? g.items.reduce((s, it) => s + it.n, 0) : 0);

/** Line diff of two instruction lists (longest common subsequence): [' ' | '-' | '+', item]. */
function diff(a, b) {
  const n = a.length, m = b.length, ka = a.map(keyOf), kb = b.map(keyOf);
  if (n * m > 4e6) return [...a.map((x) => ['-', x]), ...b.map((x) => ['+', x])];
  const T = Array.from({ length: n + 1 }, () => new Int32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) T[i][j] = ka[i] === kb[j] ? T[i + 1][j + 1] + 1 : Math.max(T[i + 1][j], T[i][j + 1]);
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (ka[i] === kb[j]) { out.push([' ', b[j]]); i++; j++; } else if (T[i + 1][j] >= T[i][j + 1]) out.push(['-', a[i++]]); else out.push(['+', b[j++]]);
  }
  while (i < n) out.push(['-', a[i++]]);
  while (j < m) out.push(['+', b[j++]]);
  return out;
}

const before = await loadCompiler(compilerDir(opt.before)), after = await loadCompiler(ROOT);
const games = opt.games.length ? opt.games : GAMES;
if (opt.out) mkdirSync(opt.out, { recursive: true });
const summary = [];
for (const g of games) {
  const A = before.compile(g, emitOf(opt.beforeEmit)), B = after.compile(g, emitOf(opt.afterEmit));
  const src = B.text.split('\n');
  const ga = groups(A, src), gb = groups(B, src);
  const keys = [...new Set([...ga.keys(), ...gb.keys()])].sort((x, y) => (typeof x === 'number' ? x : 1e9) - (typeof y === 'number' ? y : 1e9) || String(x).localeCompare(String(y)));
  let text = `== ${g}: code ${A.code} -> ${B.code} bytes (${B.code - A.code >= 0 ? '+' : ''}${B.code - A.code})   [before: ${opt.before}${opt.beforeEmit ? ' emit ' + opt.beforeEmit : ''}; after: this tree${opt.afterEmit ? ' emit ' + opt.afterEmit : ''}]\n`;
  let changed = 0, explained = 0;
  for (const k of keys) {
    const a = ga.get(k), b = gb.get(k), na = bytesOf(a), nb = bytesOf(b);
    const isData = k === 'data';
    const d = isData ? [] : diff(a?.items ?? [], b?.items ?? []);
    const differs = isData ? na !== nb : d.some(([s]) => s !== ' ');
    explained += nb - na;
    if (!differs && !opt.all) continue;
    if (differs) changed++;
    text += `\n${(a ?? b).title}\n    ${na} -> ${nb} bytes${nb !== na ? ` (${nb - na > 0 ? '+' : ''}${nb - na})` : ''}\n`;
    for (const [s, it] of d) if (s !== ' ' || opt.all) text += `  ${s} ${it.labels.length ? it.labels.join(': ') + ': ' : ''}${textOf(it)}${it.n ? `   ; ${it.n}` : ''}\n`;
  }
  text += `\n${changed} source lines / support blocks changed; the per-line differences add up to ${explained} bytes (the code changed by ${B.code - A.code})\n`;
  summary.push({ game: g, before: A.code, after: B.code, changed, explained });
  if (opt.out) {
    writeFileSync(join(opt.out, `${g}.diff.txt`), text);
    let lst = '', last = null;
    for (const it of B.items) {
      for (const l of it.labels) lst += `${l}:\n`;
      const sm = B.srcMap.filter((x) => x.addr <= it.addr).pop();
      if (sm && sm.line !== last && !it.data) { lst += `; ${sm.line}: ${(src[sm.line - 1] ?? '').trim()}\n`; last = sm.line; }
      lst += it.data ? `  ${it.addr.toString(16).toUpperCase()}  (data, ${it.n} bytes)\n` : `  ${it.addr.toString(16).toUpperCase()}  ${textOf(it)}\n`;
    }
    writeFileSync(join(opt.out, `${g}.after.lst`), lst);
  } else process.stdout.write(text + '\n');
}
console.log('| game | before | after | change | lines changed |\n|---|--:|--:|--:|--:|');
for (const s of summary) console.log(`| ${s.game} | ${s.before} | ${s.after} | ${s.after - s.before} | ${s.changed} |`);
console.log(`| total | ${summary.reduce((n, s) => n + s.before, 0)} | ${summary.reduce((n, s) => n + s.after, 0)} | ${summary.reduce((n, s) => n + s.after - s.before, 0)} | ${summary.reduce((n, s) => n + s.changed, 0)} |`);
const off = summary.filter((s) => s.explained !== s.after - s.before);
if (off.length) { console.error(`the per-line differences do not add up for: ${off.map((s) => s.game).join(', ')}`); process.exit(1); }
