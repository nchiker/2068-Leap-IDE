"use strict";
// m16c-mutations.mjs -- mutation test of the COMPILER SIZE PASS (docs/ARCADE_COMPILER_SIZE_CONTRACT.md sections 4 and 6): copies the compiler (src/), the tests and the
// runtime builds to a temporary directory, applies ONE deliberate bug at a time to the new code (the emitter's F2 JR relaxation, F4 HL tracking and F5 RET / tail calls
// in z80-emit.js; the code generator's F1 comparisons with a constant, F3 SELECT, F6 FOR, F7 PRINT AT, F8 BAND tests, F9 array routines and the size bookkeeping in
// arcade-codegen.js) and runs the suites below, fastest first; a mutation is KILLED when one of them fails. (No runtime is rebuilt: these break JavaScript only.)
//   node arcade/tests/m16c-mutations.mjs [name-fragment]     (about 10 s to 3 minutes per mutant: a mutant is usually killed by the first suite)
//   node arcade/tests/m16c-mutations.mjs --check             only verifies that every pattern occurs exactly once
//   node arcade/tests/m16c-mutations.mjs --shard=0/4         every fourth mutant (run the shards in parallel)
//   TMPDIR=<dir> to choose where the scratch copy lives.
// A mutant whose name starts with "EQUIVALENT:" changes no behaviour anyone can observe (the name says why); it is expected to survive, is counted separately, and does
// not fail the run.
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
// fastest first: the emitter's checks (sjasmplus on every example, the F4 path check, F5's exclusions, usage against the image), the exhaustive Z80 tests of every fix,
// the scene differential (same-named arrays in two scenes), the random-program differential of batch 1 (arrays, SELECT, FOR, comparisons, PRINT AT on the real runtime)
const TESTS = ['tests/arcade-emitter-opt.mjs', 'tests/arcade-codegen-exhaustive.mjs', 'tests/arcade-m9-differential.mjs', 'tests/arcade-m5.mjs'];

const EM = 'src/lang/arcade/z80-emit.js', CG = 'src/lang/arcade/arcade-codegen.js';
const E = (file, from, to) => ({ file, from, to });
const MUTANTS = [
  // ---- F4: what HL holds (z80-emit.js trackHL) ----
  ['F4: a label does not drop the state', [E(EM, '    if (w.labels.length) reset();                     // a label', '    // a label')]],
  ['F4: inline data does not drop the state', [E(EM, 'if (w.data) { reset(); out.push(w); continue; }', 'if (w.data) { out.push(w); continue; }')]],
  ['F4: LD L,r keeps the state', [E(EM, "} else if (d === 'h' || d === 'l') reset();", "} else if (d === 'h') reset();")]],
  ['F4: a store through DE keeps the slot', [E(EM, "} else if (d === '(hl)' || d === '(de)' || d === '(bc)') s = undefined;", "} else if (d === '(hl)' || d === '(bc)') s = undefined;")]],
  ['F4: a store through HL keeps the slot', [E(EM, "} else if (d === '(hl)' || d === '(de)' || d === '(bc)') s = undefined;", "} else if (d === '(de)' || d === '(bc)') s = undefined;")]],
  ['F4: a 16-bit store by another register only checks its first byte', [E(EM, "const last = m === undefined ? 0 : m + (src === 'a' ? 0 : 1);", 'const last = m === undefined ? 0 : m;')]],
  ['F4: a store into the slot by another register keeps it', [E(EM, 'if (m === undefined || (s !== undefined && m <= s + 1 && last >= s)) s = undefined;', 'if (m === undefined) s = undefined;')]],
  ['F4: INC L / DEC H keep the state', [E(EM, "if (HLR(a[0])) reset(); else if (a[0] === '(hl)') s = undefined;", "if (a[0] === 'hl') reset(); else if (a[0] === '(hl)') s = undefined;")]],
  ['F4: INC (HL) keeps the slot', [E(EM, "if (HLR(a[0])) reset(); else if (a[0] === '(hl)') s = undefined;", 'if (HLR(a[0])) reset();')]],
  ['F4: ADD HL / SBC HL keep the state', [E(EM, "      case 'add': case 'adc': case 'sbc':\n        if (a[0] === 'hl') reset();", "      case 'add': case 'adc': case 'sbc':\n        if (a[0] === 'de') reset();")]],
  ['F4: POP HL keeps the state', [E(EM, "      case 'pop':\n        if (a[0] === 'hl') reset();", "      case 'pop':\n        if (a[0] === 'de') reset();")]],
  ['F4: an unconditional JP keeps the state', [E(EM, 'if (a.length < 2) reset();                    // unconditional', 'if (a.length < 0) reset();                    // unconditional')]],
  ['F4: RET keeps the state', [E(EM, "      case 'ret':\n        if (a[0] === undefined) reset();", "      case 'ret':\n        if (a[0] === 'z') reset();")]],
  ['F4: CALL keeps the state', [E(EM, "      case 'cpl': case 'neg':", "      case 'call': case 'cpl': case 'neg':")]],
  ['F4: EX DE,HL keeps the state', [E(EM, "      case 'cpl': case 'neg':", "      case 'ex': case 'cpl': case 'neg':")]],
  ['F4: LDIR keeps the slot', [E(EM, "      case 'cpl': case 'neg':", "      case 'ldir': case 'cpl': case 'neg':")]],
  ['F4: every address is tracked (runtime variables too)', [E(EM, 'const lo = slots ? slots[0] : 0, hi = slots ? slots[1] : 0;', 'const lo = 0, hi = 0x10000;')]],
  ['F4: LD DE,(v) with HL = v copies L into D', [E(EM, "encode('ld', [d[0], 'h']), { args: [d[0], 'h'], was: 'ld', need: { s }, split: true }", "encode('ld', [d[0], 'l']), { args: [d[0], 'l'], was: 'ld', need: { s }, split: true }")]],
  ['F4: a patched LD HL,0 (WORLD / LOADTABLE: ldPatched) is taken for the constant 0', [E(CG, "function ldPatched(label) { e.label(label); e.ld('hl', P(0)); }", "function ldPatched(label) { e.label(label); e.ld('hl', 0); }")]],
  ['F4: the slot range is not set (nothing tracked but constants)', [E(CG, '    e.slots = [VARS_BASE, VARS_BASE + 2 * nSlots];', '    e.slots = [0, 0];')]],
  // ---- F5: RET and tail calls (z80-emit.js foldReturns, NO_TAIL) ----
  ['F5: a tail call across a label', [E(EM, 'if (labelled || target === null || (noTail && noTail(target))) continue;', 'if (target === null || (noTail && noTail(target))) continue;')]],
  ['F5: the exclusion list is ignored', [E(EM, 'if (labelled || target === null || (noTail && noTail(target))) continue;', 'if (labelled || target === null) continue;')]],
  ['F5: the scene driver is not excluded', [E(CG, 'labels: /^(scn\\$|frame\\$|entry\\$)/', 'labels: /^(frame\\$|entry\\$)/')]],
  ['F5: a JP to a RET cc becomes RET', [E(EM, "const isRet = (w) => !!w && !w.data && !w.dead && w.mn === 'ret' && w.args[0] === undefined;", "const isRet = (w) => !!w && !w.data && !w.dead && w.mn === 'ret';")]],
  ['F5: JP cc to a RET loses its condition', [E(EM, 'const args = w.args.length > 1 ? [w.args[0]] : [];', 'const args = [];')]],
  ['F5: CALL cc,x / RET becomes JP cc,x', [E(EM, "if (w.dead || w.data || w.mn !== 'call' || w.args.length !== 1) continue;", "if (w.dead || w.data || w.mn !== 'call' || w.args.length > 2) continue;")]],
  // ---- F2: JR relaxation and the remapping (z80-emit.js build, codegen) ----
  ['F2: JP PE / PO / P / M are relaxed too', [E(EM, "if (t === '(hl)' || (cc !== undefined && CC[cc] > 3)) return;", "if (t === '(hl)') return;")]],
  ['F2: the reach is taken from the jump itself', [E(EM, 'const d = start[c.to] - (start[c.i] + 2);', 'const d = start[c.to] - start[c.i];')]],
  ['F2: a jump 128 forward is taken as in reach', [E(EM, 'if (d < -128 || d > 127) { c.w.short = false; changed = true; }', 'if (d < -128 || d > 128) { c.w.short = false; changed = true; }')]],
  ['F2: relaxation stops after one pass', [E(EM, '          if (d < -128 || d > 127) { c.w.short = false; changed = true; }', '          if (d < -128 || d > 127) { c.w.short = false; }')]],
  ['F2: the source map is not remapped', [E(CG, 'for (const sm of srcMap) { sm.addr = e.remap(sm.addr);', 'for (const sm of srcMap) {')]],
  ['F2: the size figures are the provisional ones', [E(CG, 'for (const [from, to, use] of spans) use(e.finalSize(from, to));', 'for (const [from, to, use] of spans) use(to - from);')]],
  // ---- F1: comparisons with a constant (codegen ltConst, compare) ----
  ['F1: no sign bias (an unsigned compare)', [E(CG, "    e.ld('a', 'h'); e.xor(0x80); e.ld('h', 'a'); e.ld('de', (0x10000 - ((T + 0x8000) & 0xFFFF)) & 0xFFFF); e.add('hl', 'de');", "    e.ld('de', (0x10000 - ((T + 0x8000) & 0xFFFF)) & 0xFFFF); e.add('hl', 'de');")]],
  ['F1: the carry read the wrong way', [E(CG, "    e.jp(wantLt ? 'nc' : 'c', label);", "    e.jp(wantLt ? 'c' : 'nc', label);")]],
  ['F1: the bias constant one off', [E(CG, "e.ld('de', (0x10000 - ((T + 0x8000) & 0xFFFF)) & 0xFFFF); e.add('hl', 'de');\n    e.jp(", "e.ld('de', (0x10000 - ((T + 0x8001) & 0xFFFF)) & 0xFFFF); e.add('hl', 'de');\n    e.jp(")]],
  ['F1: <= K compiled as < K', [E(CG, "const wantLt = o === '<' || o === '<=', T = (o === '>' || o === '<=') ? K + 1 : K;", "const wantLt = o === '<' || o === '<=', T = (o === '>') ? K + 1 : K;")]],
  ['F1: >= -32768 not decided at build time (an ADD of 0)', [E(CG, '        if (T > 32767 || T === -32768) {            // decided here', '        if (T > 32767) {            // decided here')]],
  ['F1: a decided comparison jumps the wrong way', [E(CG, '          if ((wantLt ? T > 32767 : T === -32768) === sense) e.jp(label);', '          if ((wantLt ? T > 32767 : T === -32768) !== sense) e.jp(label);')]],
  ['F1: K < x not mirrored', [E(CG, "const o = rc !== undefined ? op : ({ '<': '>', '>': '<', '<=': '>=', '>=': '<=', '=': '=', '<>': '<>' })[op];\n      if (o === '=' || o === '<>') {\n        if (K === -1", "const o = op;\n      if (o === '=' || o === '<>') {\n        if (K === -1")]],
  ['F1: = 1 without the DEC HL', [E(CG, "if (K === 1) { e.dec('hl'); e.ld('a', 'h'); e.or('l'); }", "if (K === 1) { e.ld('a', 'h'); e.or('l'); }")]],
  ['F1: FOR with a constant step: v <= K tested as v < K', [E(CG, 'if (stepConst >= 0) ltConst(K + 1, BODY, true); else ltConst(K, BODY, false);', 'if (stepConst >= 0) ltConst(K, BODY, true); else ltConst(K, BODY, false);')]],
  ['F1: FOR with a negative step: v >= K tested as v > K', [E(CG, 'if (stepConst >= 0) ltConst(K + 1, BODY, true); else ltConst(K, BODY, false);', 'if (stepConst >= 0) ltConst(K + 1, BODY, true); else ltConst(K + 1, BODY, false);')]],
  ['F1: FOR with a constant step: the always-true edge taken for every step', [E(CG, 'if (stepConst >= 0 ? K === 32767 : K === -32768) e.jp(BODY);', 'if (K === 32767 || K === -32768) e.jp(BODY);')]],
  // ---- F6: FOR STEP 1 ----
  ['F6: no overflow exit (FOR i = x TO 32767 never ends)', [E(CG, "        e.ld('a', 'h'); e.xor(0x80); e.or('l'); e.jp('z', END);  // the overflow exit", '        // the overflow exit')]],
  ['F6: an empty loop with constants runs once', [E(CG, 'if (from === undefined) e.jp(CHECK); else if (from > K) e.jp(END);', 'if (from === undefined) e.jp(CHECK);')]],
  ['F6: constant start: the step test one off', [E(CG, "        if (K !== -32768) ltConst(K, BODY, true);", "        if (K !== -32768) ltConst(K + 1, BODY, true);")]],
  ['F6: variable start: the limit test one off', [E(CG, 'if (K === 32767) e.jp(BODY); else ltConst(K + 1, BODY, true);', 'if (K === 32767) e.jp(BODY); else ltConst(K, BODY, true);')]],
  ['EQUIVALENT: F6: variable start, limit 32767 tested with ltConst(32768) (an ADD of 0 never carries, so the jump is always taken: the same as JP BODY; the overflow exit ends the loop)', [E(CG, 'if (K === 32767) e.jp(BODY); else ltConst(K + 1, BODY, true);', 'ltConst(K + 1, BODY, true);')]],
  ['F6: used for STEP 2 as well', [E(CG, 'if (CG.for && limSlot === null && stepConst === 1) {', 'if (CG.for && limSlot === null && stepConst >= 1) {')]],
  // ---- F3: SELECT with the selector in HL ----
  ['F3: a case with two values skips the second', [E(CG, "if (i < c.values.length - 1) e.jp('z', BODY); else e.jp('nz', NEXT);", "e.jp('nz', NEXT);")]],
  ['eqKeepHL (F1 and F3): -1 without the INC A', [E(CG, "else if (k === 0xFFFF) { e.ld('a', 'l'); e.and('h'); e.inc('a'); }", "else if (k === 0xFFFF) { e.ld('a', 'l'); e.and('h'); }")]],
  ['eqKeepHL (F1 and F3): 1..255 ignores the high byte', [E(CG, "else if (hi === 0) { e.ld('a', 'l'); e.xor(lo); e.or('h'); }", "else if (hi === 0) { e.ld('a', 'l'); e.xor(lo); }")]],
  ['eqKeepHL (F3): a multiple of 256 ignores the low byte', [E(CG, "else if (lo === 0) { e.ld('a', 'h'); e.xor(hi); e.or('l'); }", "else if (lo === 0) { e.ld('a', 'h'); e.xor(hi); }")]],
  ['eqKeepHL (F3): any other value: the low byte is not tested', [E(CG, "e.ld('a', 'l'); e.xor(lo); e.jr('nz', t); e.ld('a', 'h'); e.xor(hi); e.label(t);", "e.ld('a', 'l'); e.xor(lo); e.ld('a', 'h'); e.xor(hi); e.label(t);")]],
  ['F3: the last case before ELSE falls into ELSE', [E(CG, 'if (ci < s.cases.length - 1 || s.else) e.jp(END);', 'if (ci < s.cases.length - 1) e.jp(END);')]],
  // ---- F7, F8 ----
  ['F7: PRINT AT row and column swapped in BC', [E(CG, 'e.ld(\'bc\', (clampK(rc, 23) << 8) | clampK(cc, 31));', 'e.ld(\'bc\', (clampK(cc, 31) << 8) | clampK(rc, 23));')]],
  ['F8: the other byte is tested', [E(CG, "e.ld('a', lo ? 'l' : 'h');", "e.ld('a', lo ? 'h' : 'l');")]],
  ['F8: a constant with bits in both bytes tests one byte', [E(CG, '    if (lo && hi) return false;\n', '')]],
  ['F8: BAND(x, 0) taken as true', [E(CG, 'if (!lo && !hi) { if (!isSimple(l)) gen(l); if (!sense) e.jp(label); return true; }', 'if (!lo && !hi) { if (!isSimple(l)) gen(l); if (sense) e.jp(label); return true; }')]],
  ['F8: every constant tested as the whole byte', [E(CG, "if ((lo || hi) === 255) e.or('a'); else e.and(lo || hi);", "e.or('a');")]],
  ['F8: BAND(x, k) = 0 read as <> 0', [E(CG, "if (bandBranch(other, label, (o === '<>') === sense)) return;", "if (bandBranch(other, label, (o === '=') === sense)) return;")]],
  // ---- F9: array routines; the 2-D key ----
  ['arrayAddr (inline and F9 routines): the range test one too wide', [E(CG, "    const lim = a.n + 1;\n    e.ld('a', 'l'); e.sub(lim & 255);", "    const lim = a.n + 2;\n    e.ld('a', 'l'); e.sub(lim & 255);")]],
  ['F9: a read outside the array gives the sink\'s address', [E(CG, "e.label(bad); e.ld('hl', mode === 'r' ? 0 : arrSink); e.ret();", "e.label(bad); e.ld('hl', arrSink); e.ret();")]],
  ['F9: the read routine reads one byte', [E(CG, "if (mode === 'r') { e.ld('a', '(hl)'); e.inc('l'); e.ld('h', '(hl)'); e.ld('l', 'a'); }\n      e.ret();", "if (mode === 'r') { e.ld('a', '(hl)'); e.ld('l', 'a'); e.ld('h', 0); }\n      e.ret();")]],
  ['arrayAddr (inline and F9 routines): the element address is not doubled', [E(CG, "e.jp('nc', oob);\n    e.add('hl', 'hl'); e.ld('de', a.addr & 0xFFFF); e.add('hl', 'de');\n  }", "e.jp('nc', oob);\n    e.ld('de', a.addr & 0xFFFF); e.add('hl', 'de');\n  }")]],
  ['routineKey: two scenes\' same-named arrays share their routines (1-D F9 and 2-D; the 2-D case was a bug fixed in C2)', [E(CG, "const routineKey = (map, name, a, arrOf = (v) => v) => (map.has(name) && arrOf(map.get(name)).addr !== a.addr ? `${name}$${a.addr.toString(16)}` : name);", "const routineKey = (map, name) => name;")]],
  ['F9: reads and writes counted together', [E(CG, "if (n.type === 'Assign' && n.target?.type === 'Index') { count('w', n.target);", "if (n.type === 'Assign' && n.target?.type === 'Index') { count('r', n.target);")]],
];

if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    const n = readFileSync(join(ROOT, e.file), 'utf8').split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
  }
  console.log(bad ? `${bad} pattern(s) not found exactly once` : `all ${MUTANTS.length} mutants' patterns occur exactly once`);
  process.exit(bad ? 1 : 0);
}

// The unmutated suites must pass first, else every "kill" would be the suite's own failure.
if (!only && shardI === 0 || args.includes('--baseline')) {
  for (const t of TESTS) {
    const r = spawnSync('node', [join(ROOT, t)], { encoding: 'utf8', timeout: 900000, env: { ...process.env, ARCADE_QUICK: '1' }, cwd: ROOT });
    if (r.status !== 0 || r.error) { console.log(`  BASELINE FAILS: ${t} fails without any mutation; fix it before trusting the kills`); process.exit(2); }
  }
}
const tmp = mkdtempSync(join(tmpdir(), 'm16cmut-'));
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
    for (const v of ['v1', 'v2', 'v3', 'v4']) for (const f of ['runtime.json', 'runtime.bin']) {
      if (!existsSync(join(ROOT, 'arcade/build', v, f))) continue;
      mkdirSync(join(root, 'arcade/build', v), { recursive: true });
      cpSync(join(ROOT, 'arcade/build', v, f), join(root, 'arcade/build', v, f));
    }
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
