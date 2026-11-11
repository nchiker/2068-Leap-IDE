"use strict";
// m10c-mutations.mjs -- mutation test of the language batch 5 COMPILER suites (timers, key edges, PRINT USING, PLAY by index, scene timers; docs/ARCADE_LANGUAGE_BATCH5.md): copies the
// compiler (src/), the tests and the runtime builds to a temporary directory, applies ONE deliberate bug at a time to the new code (the timer / edge / USING / PLAY code generation
// in arcade-codegen.js, the reference interpreter's counterparts in arcade-interp.js, the new checks in arcade-check.js) and runs the batch 5 and batch 4 compiler suites in their quick
// form; a mutation is KILLED when at least one of them fails. (Like m9-mutations.mjs these break JavaScript, so there is no rebuild. The runtime's own mutations are m10-mutations.mjs.)
//   node arcade/tests/m10c-mutations.mjs [name-fragment]     (about 20-60 s per mutant)
//   node arcade/tests/m10c-mutations.mjs --check             only verifies that every pattern occurs exactly once
//   node arcade/tests/m10c-mutations.mjs --shard=0/4         every fourth mutant (run the shards in parallel)
//   TMPDIR=<dir> to choose where the scratch copy lives.
// A mutant whose name starts with "EQUIVALENT:" changes no behaviour anyone can observe (the name says why); it is expected to survive, is counted separately, and does not fail the run.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shardArg = args.find((a) => a.startsWith('--shard='));
const [shardI, shardN] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
const TESTS = ['tests/arcade-m10-compiler.mjs', 'tests/arcade-m10-differential.mjs', 'tests/arcade-m9-compiler.mjs'];

const CG = 'src/lang/arcade/arcade-codegen.js', IN = 'src/lang/arcade/arcade-interp.js', CK = 'src/lang/arcade/arcade-check.js';
const E = (file, from, to) => ({ file, from, to });
const MUTANTS = [
  ["timer: no negative guard", [E(CG, "e.ld('hl', M(addr)); e.bit(7, 'h'); e.jr('nz', skip); e.ld('a', 'h');", "e.ld('hl', M(addr)); e.ld('a', 'h');")]],
  ["timer: decrements by 2", [E(CG, "e.dec('hl'); e.ld(M(addr), 'hl');\n    e.label(skip);", "e.dec('hl'); e.dec('hl'); e.ld(M(addr), 'hl');\n    e.label(skip);")]],
  ["timer: zero check dropped", [E(CG, "e.jr('nz', skip); e.ld('a', 'h'); e.or('l'); e.jr('z', skip); e.dec('hl');", "e.jr('nz', skip); e.dec('hl');")]],
  ["edge: before never updated", [E(CG, "e.ld('a', 'l'); e.ld(M(info.before), 'a'); };", "};")]],
  ["edge: AND without NOT", [E(CG, "e.ld('a', M(info.before)); e.cpl(); e.and('l');", "e.ld('a', M(info.before)); e.and('l');")]],
  ["edge: now not before (OR)", [E(CG, "e.ld('a', M(info.before)); e.cpl(); e.and('l');", "e.ld('a', M(info.before)); e.cpl(); e.or('l');")]],
  ["prologue: game timers skipped in driver", [E(CG, "if (hasPrologue) emitTickPrologue();                          // batch 5: after", "if (false) emitTickPrologue();                          // batch 5: after")]],
  ["scene timers: all scenes use scene 0 list", [E(CG, "e.label(`frame$tm$${k}`); for (const a of sceneTimerAddrs[k]) timerStep(a);", "e.label(`frame$tm$${k}`); for (const a of sceneTimerAddrs[0]) timerStep(a);")]],
  ["scene timers: dispatch ignores them", [E(CG, "const target = (k) => (sceneTimerAddrs[k].length ? `frame$tm$${k}` : labelOf('P', 'FRAME', k));", "const target = (k) => labelOf('P', 'FRAME', k);")]],
  ["stub: scene timers not counted (one scene)", [E(CG, "for (const a of sceneTimerAddrs[0] ?? []) timerStep(a);", "")]],
  ["joy: stick number off", [E(CG, "for (const [n, info] of pressJoyInfo) { e.ld('a', n);", "for (const [n, info] of pressJoyInfo) { e.ld('a', n === 1 ? 2 : 1);")]],
  ["KEYPRESS reads before not edge", [E(CG, "e.ld('hl', M(info.edge));\n        return;", "e.ld('hl', M(info.before));\n        return;")]],
  ["PLAY: no range guard (H)", [E(CG, "e.ld('a', 'h'); e.or('a'); e.jr('nz', SKIP); e.ld('a', 'l'); e.call(rt);", "e.ld('a', 'l'); e.call(rt);")]],
  ["PLAY: constant 256 still calls", [E(CG, "if (k >= 0 && k <= 255) { e.ld('a', k); e.call(rt); } return; }", "{ e.ld('a', k & 255); e.call(rt); } return; }")]],
  ["fmt: sign rule (avail without neg)", [E(CG, "e.ld('a', 'b'); e.sub('e'); e.cp('d'); e.jp('c', 'fmt$star');", "e.ld('a', 'b'); e.cp('d'); e.jp('c', 'fmt$star');")]],
  ["fmt: nd chain off by one at 100", [E(CG, "[10000, 1000, 100, 10]) { e.ld('a', 'l'); e.sub(k & 255);", "[10000, 1000, 101, 10]) { e.ld('a', 'l'); e.sub(k & 255);")]],
  ["fmt: min(z, avail) -> z", [E(CG, "e.ld('b', 'a'); e.ld('a', 'c'); e.cp('b'); e.jr('c', 'fmt$m'); e.ld('a', 'b');", "e.ld('b', 'a'); e.ld('a', 'c');")]],
  ["fmt: stars w-1", [E(CG, "e.label('fmt$star'); e.ld('a', 42);", "e.label('fmt$star'); e.dec('b'); e.ret('z'); e.ld('a', 42);")]],
  ["EQUIVALENT: fmt: -32768 magnitude (LD A,0 / SBC A,H = 0-H-c is the same value as SBC A,A / SUB H = -c-H; only one byte bigger)", [E(CG, "e.xor('a'); e.sub('l'); e.ld('l', 'a'); e.sbc('a', 'a'); e.sub('h'); e.ld('h', 'a');          // HL = |value|", "e.xor('a'); e.sub('l'); e.ld('l', 'a'); e.ld('a', 0); e.sbc('a', 'h'); e.ld('h', 'a');          // HL = |value|")]],
  ["EQUIVALENT: fmt: stars drawn w-1 (the early RET C at B < 2 is exactly where DJNZ falls through to RET, and fmt$put keeps BC: the same w stars)", [E(CG, "e.label('fmt$star'); e.ld('a', 42); e.call('fmt$put'); e.djnz('fmt$star'); e.ret();", "e.label('fmt$star'); e.ld('a', 42); e.call('fmt$put'); e.ld('a', 'b'); e.cp(2); e.ret('c'); e.djnz('fmt$star'); e.ret();")]],
  ["usingText: zero fill ignores sign", [E(CG, "while (body.length < z && body.length + (neg ? 1 : 0) < w) body = '0' + body;", "while (body.length < z) body = '0' + body;")]],
  ["interp: timers count scene timers of scene 0", [E(IN, "for (const k of sceneTimers[curScene]) {", "for (const k of sceneTimers[0]) {")]],
  ["interp: negative timer counts", [E(IN, "const c = globalScope.vars.get(k); if (c && c.v > 0) c.v--;", "const c = globalScope.vars.get(k); if (c && c.v !== 0) c.v--;")]],
  ["interp: edge forgets before", [E(IN, "keyEdge.set(c, now & ~(keyBefore.get(c) ?? 0)); keyBefore.set(c, now);", "keyEdge.set(c, now); keyBefore.set(c, now);")]],
  ["interp: joy edge not masked by before", [E(IN, "joyEdge[n] = now & ~joyBefore[n] & 31;", "joyEdge[n] = now & 31;")]],
  ["interp: edges taken after FRAME", [E(IN, "countTimers(); takeEdges(t);              // batch 5", "countTimers();              // batch 5")]],
  ["interp: PLAY past the table not counted", [E(IN, "if (v >= sfxNames.length) { if (clock) ++playN; return null; }", "if (v >= sfxNames.length) { return null; }")]],
  ["interp: PLAY index negative plays", [E(IN, "if (v < 0 || v > 255) return null;", "if (v > 255) return null; if (v < 0) { i = 0; } ")]],
  ["check: JOYPRESS accepts 3", [E(CK, "if (k !== 1 && k !== 2) {", "if (k !== 1 && k !== 2 && k !== 3) {")]],
  ["check: PLAY literal range off by one", [E(CK, "if (k < 0 || k >= sfxs.length) this.err(e, sfxs.length ?", "if (k < 0 || k > sfxs.length) this.err(e, sfxs.length ?")]],
  ["check: USING accepts text", [E(CK, "if (t === 'str') this.err(it, 'USING formats a number", "if (false) this.err(it, 'USING formats a number")]],
];

if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    if (!existsSync(join(ROOT, e.file))) { console.log(`  ?? ${name}: ${e.file} does not exist`); bad++; continue; }
    const src = readFileSync(join(ROOT, e.file), 'utf8');
    const n = src.split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
  }
  console.log(`${MUTANTS.length} mutants, ${bad} bad patterns`);
  process.exit(bad ? 1 : 0);
}

// The unmutated suites must pass first, else every "kill" would be the suite's own failure.
if (!only && shardI === 0 || args.includes('--baseline')) {
  for (const t of TESTS) {
    const r = spawnSync('node', [join(ROOT, t)], { encoding: 'utf8', timeout: 900000, env: { ...process.env, ARCADE_QUICK: '1' }, cwd: ROOT });
    if (r.status !== 0 || r.error) { console.log(`  BASELINE FAILS: ${t} fails without any mutation; fix it before trusting the kills`); process.exit(2); }
  }
}
const tmp = mkdtempSync(join(tmpdir(), 'm10cmut-'));
let killed = 0;
const survived = [], equivalent = [], broken = [];
try {
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (mi % shardN !== shardI) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade/build'), { recursive: true });
    cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
    cpSync(join(ROOT, 'tests'), join(root, 'tests'), { recursive: true });
    for (const d of ['examples', 'tests', 'runtime', 'tools']) cpSync(join(ROOT, 'arcade', d), join(root, 'arcade', d), { recursive: true });
    for (const v of ['v2', 'v3', 'v4']) for (const f of ['runtime.json', 'runtime.bin']) { mkdirSync(join(root, 'arcade/build', v), { recursive: true }); cpSync(join(ROOT, 'arcade/build', v, f), join(root, 'arcade/build', v, f)); }
    symlinkSync(join(ROOT, 'tsrun'), join(root, 'tsrun'));
    let bad = false;
    for (const e of edits) {
      const p = join(root, e.file);
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    if (bad) { broken.push(name); continue; }
    let failedBy = null;
    for (const t of TESTS) {
      const r = spawnSync('node', [join(root, t)], { encoding: 'utf8', timeout: 900000, env: { ...process.env, ARCADE_QUICK: '1' }, cwd: root });
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      if (r.status !== 0 || r.error) { failedBy = t.replace('tests/', '') + ': ' + ((out.match(/FAIL  .*/g) ?? [out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110); break; }
    }
    if (failedBy) { killed++; console.log(`  killed       ${name}  <- ${failedBy}`); }
    else if (name.startsWith('EQUIVALENT:')) { equivalent.push(name); console.log(`  equivalent   ${name}  (survived, as expected)`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
const ran = killed + survived.length + equivalent.length + broken.length;
console.log(`\n${ran} mutants run: ${killed} killed, ${equivalent.length} equivalent (expected to survive), ${survived.length} survived${broken.length ? `, ${broken.length} with a bad pattern` : ''}`);
for (const s of survived) console.log('  survivor: ' + s);
process.exit(survived.length || broken.length ? 1 : 0);
