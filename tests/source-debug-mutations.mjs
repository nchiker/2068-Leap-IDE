"use strict";
// source-debug-mutations.mjs -- mutation test of src/tools/source-debug.js (the Studio's source debugger, pure half; stage 6 item R4): copies the sources, the tests, the examples and the
// runtime builds to a temporary directory, applies ONE deliberate bug at a time (snapping, the lowest address of a line, the watch, the call decoder, the jump decoder, Step line's stop rule,
// Step over's stack test, the limit, the frame's end, the halted CPU, the status text) and runs the two suites below; a mutation is KILLED when one of them fails.
//   node tests/source-debug-mutations.mjs [name-fragment]     (a second or two per mutant: nearly every one is killed by the first suite)
//   node tests/source-debug-mutations.mjs --check             only verifies that every pattern occurs exactly once
//   node tests/source-debug-mutations.mjs --shard=0/2        every second mutant
//   TMPDIR=<dir> to choose where the scratch copy lives.
// A mutant whose name starts with "EQUIVALENT:" changes no behaviour anyone can observe (the name says why); it is expected to survive, is counted separately, and does not fail the run.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shardArg = args.find((a) => a.startsWith('--shard='));
const [shardI, shardN] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
// the model suite first (no runtime: nearly every mutant dies here), then the three real games in their quick form (about 5 s)
const TESTS = ['tests/source-debug-model.mjs', 'tests/source-debug-runtime.mjs'];
const QUICK_ENV = { SOURCE_DEBUG_QUICK: '1' };

const SD = 'src/tools/source-debug.js';
const E = (from, to) => ({ file: SD, from, to });
const MUTANTS = [
  // ---- breakpointAddresses: the lowest address of a line, snapping, hollow ----
  ['a line keeps the first entry seen, not the lowest address', [E('if (cur === undefined || e.addr < cur.addr) first.set(e.line, e);', 'if (cur === undefined) first.set(e.line, e);')]],
  ['a line takes its HIGHEST address', [E('if (cur === undefined || e.addr < cur.addr) first.set(e.line, e);', 'if (cur === undefined || e.addr > cur.addr) first.set(e.line, e);')]],
  ['a line with code snaps to the NEXT line (strictly greater)', [E('if (sorted[mid] < x) lo = mid + 1; else hi = mid;', 'if (sorted[mid] <= x) lo = mid + 1; else hi = mid;')]],
  ['the snapping search shrinks its range by one too many', [E('if (sorted[mid] < x) lo = mid + 1; else hi = mid;', 'if (sorted[mid] < x) lo = mid + 1; else hi = mid - 1;')]],
  ['the snapping search grows its range by none', [E('if (sorted[mid] < x) lo = mid + 1; else hi = mid;', 'if (sorted[mid] < x) lo = mid; else hi = mid;')]],
  ['a line past the last one is not hollow (the loop reads off the end)', [E('if (at >= sorted.length) { hollow.add(line); continue; }', 'if (at > sorted.length) { hollow.add(line); continue; }')]],
  ['a hollow line is also resolved to the last line', [E('if (at >= sorted.length) { hollow.add(line); continue; }', 'if (at >= sorted.length) { hollow.add(line); }')]],
  ['the hollow lines are not sorted', [E('hollow: [...hollow].sort((a, b) => a - b) };', 'hollow: [...hollow] };')]],
  ['the hollow lines are sorted as text', [E('hollow: [...hollow].sort((a, b) => a - b) };', 'hollow: [...hollow].sort() };')]],
  ['the lines with code are not sorted before the search', [E('const sorted = [...first.keys()].sort((a, b) => a - b);', 'const sorted = [...first.keys()];')]],
  ['a line that is not a number snaps like any other', [E('if (!Number.isFinite(line)) continue;', '')]],
  ['the address added is the line asked for, not the address of the line it snapped to', [E('addrs.add(e.addr);', 'addrs.add(line);')]],
  ['the resolved line is the line asked for', [E('resolved.set(line, { line: e.line, addr: e.addr });', 'resolved.set(line, { line, addr: e.addr });')]],
  ['the resolved address is the line number', [E('resolved.set(line, { line: e.line, addr: e.addr });', 'resolved.set(line, { line: e.line, addr: e.line });')]],
  ['no address is collected (the Set stays empty)', [E('addrs.add(e.addr);', '')]],
  // ---- watchFor ----
  ['the watch pauses everywhere but at the breakpoints', [E('if (!addrs.has(pc)) return false;', 'if (addrs.has(pc)) return false;')]],
  ['the watch never calls onHit', [E('if (onHit) onHit(pc);', '')]],
  ['onHit is called with the machine, not the pc', [E('if (onHit) onHit(pc);', 'if (onHit) onHit(m);')]],
  ['the watch pauses on any pc (the test is dropped)', [E('if (!addrs.has(pc)) return false;', '')]],
  ['the watch copies the set (a breakpoint added later is not seen)', [E('export function watchFor(addrs, onHit) {\n  return (m) => {', 'export function watchFor(addrs0, onHit) {\n  const addrs = new Set(addrs0);\n  return (m) => {')]],
  // ---- lineOf ----
  ['lineOf: the end of the code is inclusive', [E('addr >= map.codeEnd', 'addr > map.codeEnd')]],
  ['lineOf: a codeEnd of 0 is "not set"', [E('map.codeEnd !== undefined && addr', 'map.codeEnd && addr')]],
  ['lineOf: the entry AT the address is not found', [E('if (lines[mid].addr <= addr) { best', 'if (lines[mid].addr < addr) { best')]],
  ['lineOf: the search keeps the first entry that fits, not the last', [E('{ best = lines[mid]; lo = mid + 1; } else hi = mid - 1;', '{ best = lines[mid]; hi = mid - 1; } else hi = mid - 1;')]],
  ['lineOf: no entry below the first (the runtime) is named by the first entry', [E('let lo = 0, hi = lines.length - 1, best = null;', 'let lo = 0, hi = lines.length - 1, best = lines[0];')]],
  ['EQUIVALENT: lineOf: the empty-map guard (the search over no entries finds none anyway)', [E('if (!lines || lines.length === 0) return null;', 'if (!lines) return null;')]],
  // ---- decodeCall ----
  ['decodeCall: CALL nn is not CD', [E('if (op === 0xCD || (op & 0xC7) === 0xC4)', 'if (op === 0xCE || (op & 0xC7) === 0xC4)')]],
  ['decodeCall: CALL cc is not found (C4 CC D4 DC E4 EC F4 FC)', [E('if (op === 0xCD || (op & 0xC7) === 0xC4)', 'if (op === 0xCD)')]],
  ['decodeCall: CALL cc matches C6 CE ... (the wrong low bits)', [E('(op & 0xC7) === 0xC4) return', '(op & 0xC7) === 0xC6) return')]],
  ['decodeCall: CALL cc mask is too loose', [E('(op & 0xC7) === 0xC4) return', '(op & 0xC3) === 0xC4) return')]],
  ['decodeCall: a CALL is 2 bytes', [E('(op & 0xC7) === 0xC4) return { isCall: true, length: 3 }', '(op & 0xC7) === 0xC4) return { isCall: true, length: 2 }')]],
  ['decodeCall: CALL nn is 4 bytes but CALL cc is 3', [E('if (op === 0xCD || (op & 0xC7) === 0xC4) return { isCall: true, length: 3 };', 'if (op === 0xCD) return { isCall: true, length: 4 };\n  if ((op & 0xC7) === 0xC4) return { isCall: true, length: 3 };')]],
  ['decodeCall: RST is not found', [E('if ((op & 0xC7) === 0xC7) return { isCall: true, length: 1 };', '')]],
  ['decodeCall: RST FF is left out', [E('if ((op & 0xC7) === 0xC7) return', 'if ((op & 0xC7) === 0xC7 && op !== 0xFF) return')]],
  ['decodeCall: RST is 2 bytes', [E('{ isCall: true, length: 1 }', '{ isCall: true, length: 2 }')]],
  ['decodeCall: the opcode is not masked to a byte', [E('const op = read(pc) & 0xFF;\n  if (op === 0xCD', 'const op = read(pc);\n  if (op === 0xCD')]],
  ['decodeCall: reads the byte after the pc', [E('const op = read(pc) & 0xFF;\n  if (op === 0xCD', 'const op = read(pc + 1) & 0xFF;\n  if (op === 0xCD')]],
  ['decodeCall: a non-call has a length of 1', [E('return { isCall: false, length: 0 };', 'return { isCall: false, length: 1 };')]],
  // ---- isJump ----
  ['isJump: JR is not 18', [E('op === 0x18 || (op & 0xE7) === 0x20', 'op === 0x19 || (op & 0xE7) === 0x20')]],
  ['isJump: JR cc is 20 only', [E('(op & 0xE7) === 0x20', 'op === 0x20')]],
  ['isJump: JR cc mask too loose', [E('(op & 0xE7) === 0x20', '(op & 0xE3) === 0x20')]],
  ['isJump: DJNZ is not a jump', [E('|| op === 0x10 ||', '||')]],
  ['isJump: JP is not C3', [E('op === 0xC3 ||', 'op === 0xC4 ||')]],
  ['isJump: JP cc is not found', [E('(op & 0xC7) === 0xC2 ||', '')]],
  ['isJump: JP cc mask too loose', [E('(op & 0xC7) === 0xC2', '(op & 0xC3) === 0xC2')]],
  ['isJump: JP (HL) is not a jump', [E('|| op === 0xE9;', ';')]],
  ['isJump: the opcode is not masked to a byte', [E('  op &= 0xFF;\n  return op === 0x18', '  return op === 0x18')]],
  // ---- stepLine: where it stops ----
  ['stepLine: the first instruction does not run (the start is looked at first)', [E('    if (cpu.halted) {\n      // A halted CPU', '    if (breakpoints && breakpoints.has(pc) && instructions === 0) return done(\'breakpoint\');\n    if (cpu.halted) {\n      // A halted CPU')]],
  ['stepLine: the line it started on is forgotten (any entry stops)', [E('const startLine = startEntry ? startEntry.line : null;', 'const startLine = null;')]],
  ['stepLine: the start entry is only taken at an entry address (mid-statement starts count as no line)', [E('const startEntry = lineOf(map, cpu.pc);', 'const startEntry = map.lines.find((e) => e.addr === cpu.pc) ?? null;')]],
  ['stepLine: stops at a LOWER line only', [E('if (e && (e.line !== startLine || back)) return done(\'line\');', 'if (e && (e.line > startLine || back)) return done(\'line\');')]],
  ['stepLine: stops at a HIGHER line only', [E('if (e && (e.line !== startLine || back)) return done(\'line\');', 'if (e && (e.line < startLine || back)) return done(\'line\');')]],
  ['stepLine: a loop that went back does not stop at the same line', [E('if (e && (e.line !== startLine || back)) return done(\'line\');', 'if (e && e.line !== startLine) return done(\'line\');')]],
  ['stepLine: the same line always stops (the line test is dropped)', [E('if (e && (e.line !== startLine || back)) return done(\'line\');', 'if (e) return done(\'line\');')]],
  ['stepLine: a backward jump is a jump to a strictly lower address', [E('jumps && now <= pc && cpu.sp === sp', 'jumps && now < pc && cpu.sp === sp')]],
  ['stepLine: a jump forward counts as going back', [E('jumps && now <= pc && cpu.sp === sp', 'jumps && now !== pc + 1 && cpu.sp === sp')]],
  ['stepLine: any lower pc counts as going back (a RET, a call)', [E('jumps && now <= pc && cpu.sp === sp', 'now <= pc && cpu.sp === sp')]],
  ['stepLine: an interrupt in place of the jump counts as going back', [E('jumps && now <= pc && cpu.sp === sp', 'jumps && now <= pc')]],
  ['stepLine: a backward jump is not looked for', [E('} else if (jumps && now <= pc && cpu.sp === sp) back = true;', '}')]],
  ['stepLine: the jump is decoded one byte late', [E('const op = read(pc) & 0xFF;\n      jumps', 'const op = read(pc + 1) & 0xFF;\n      jumps')]],
  // ---- stepLine: breakpoints, the limit ----
  ['stepLine: breakpoints are ignored', [E('    if (breakpoints && breakpoints.has(now)) return done(\'breakpoint\');\n    const e = entryAt.get(now);', '    const e = entryAt.get(now);')]],
  ['stepLine: a breakpoint stops only at an entry', [E('    if (breakpoints && breakpoints.has(now)) return done(\'breakpoint\');\n    const e = entryAt.get(now);', '    if (breakpoints && breakpoints.has(now) && entryAt.has(now)) return done(\'breakpoint\');\n    const e = entryAt.get(now);')]],
  ['stepLine: breakpoints inside a stepped-over call are ignored', [E('        if (breakpoints && breakpoints.has(now)) return done(\'breakpoint\');\n        if (instructions >= maxInstructions) return done(\'limit\');\n        continue;', '        if (instructions >= maxInstructions) return done(\'limit\');\n        continue;')]],
  ['stepLine: the line stop is checked before the breakpoint', [E('    if (breakpoints && breakpoints.has(now)) return done(\'breakpoint\');\n    const e = entryAt.get(now);\n    if (e && (e.line !== startLine || back)) return done(\'line\');', '    const e = entryAt.get(now);\n    if (e && (e.line !== startLine || back)) return done(\'line\');\n    if (breakpoints && breakpoints.has(now)) return done(\'breakpoint\');')]],
  ['stepLine: the limit is one too many (> instead of >=)', [E('    if (instructions >= maxInstructions) return done(\'limit\');\n  }\n}', '    if (instructions > maxInstructions) return done(\'limit\');\n  }\n}')]],
  ['stepLine: the limit inside a stepped-over call is not checked', [E('        if (instructions >= maxInstructions) return done(\'limit\');\n        continue;', '        continue;')]],
  ['stepLine: the default limit is 20000', [E('export const MAX_STEP_INSTRUCTIONS = 200000;', 'export const MAX_STEP_INSTRUCTIONS = 20000;')]],
  ['stepLine: opts.maxInstructions is ignored', [E('maxInstructions = MAX_STEP_INSTRUCTIONS, onFrameEnd', 'maxInstructions: _unused = MAX_STEP_INSTRUCTIONS, onFrameEnd')]],
  ['stepLine: the instruction count is not incremented', [E('      step(machine);\n      instructions++;', '      step(machine);')]],
  ['stepLine: the result names the line of the pc before the step', [E('const done = (stopped) => ({ stopped, pc: cpu.pc, line: lineOf(map, cpu.pc)?.line ?? null, instructions });', 'const done = (stopped) => ({ stopped, pc: cpu.pc, line: startLine, instructions });')]],
  // ---- stepLine: Step over ----
  ['stepLine: over is ignored (step into always)', [E('      if (over) {\n        const c = decodeCall(read, pc);', '      if (false) {\n        const c = decodeCall(read, pc);')]],
  ['stepLine: step over always (into never)', [E('      if (over) {\n        const c = decodeCall(read, pc);', '      if (true) {\n        const c = decodeCall(read, pc);')]],
  ['stepLine: step over also steps over a call made from runtime code', [E('if (c.isCall && lineOf(map, pc)) {', 'if (c.isCall) {')]],
  ['stepLine: step over never steps over a call (the call test is dropped)', [E('if (c.isCall && lineOf(map, pc)) {', 'if (false) {')]],
  ['stepLine: the return address is one byte too far', [E('retPc = (pc + c.length) & 0xFFFF;', 'retPc = (pc + c.length + 1) & 0xFFFF;')]],
  ['stepLine: the return address is pc + 3 for every call', [E('retPc = (pc + c.length) & 0xFFFF;', 'retPc = (pc + 3) & 0xFFFF;')]],
  ['stepLine: the stack is not looked at (recursion, a call to the next instruction)', [E('if (now === retPc && cpu.sp === retSp) pending = false;', 'if (now === retPc) pending = false;')]],
  ['stepLine: the stack is compared with the one after the call', [E('retSp = sp; }', 'retSp = sp - 2; }')]],
  ['stepLine: step over is over after the first instruction of the call', [E('      if (now === retPc && cpu.sp === retSp) pending = false;      // back (or a CALL cc that was not taken)\n      else {', '      pending = false;\n      if (false) {}\n      else if (now !== retPc || cpu.sp !== retSp) {')]],
  ['stepLine: the instructions of a stepped-over call are looked at for entries', [E('        if (instructions >= maxInstructions) return done(\'limit\');\n        continue;', '        if (entryAt.has(now)) return done(\'line\');\n        if (instructions >= maxInstructions) return done(\'limit\');\n        continue;')]],
  ['EQUIVALENT: stepLine: the return address is not wrapped to 16 bits (no call is at $FFFE in any program the tests or the games have)', [E('retPc = (pc + c.length) & 0xFFFF;', 'retPc = pc + c.length;')]],
  ['EQUIVALENT: stepLine: the first entry at an address is not the one kept (a map never has two entries at one address: the codegen merges them)', [E('if (!entryAt.has(e.addr)) entryAt.set(e.addr, e);', 'entryAt.set(e.addr, e);')]],
  ['EQUIVALENT: stepLine: no step function gives a TypeError instead of the thrown message (the test sees an exception in both cases)', [E("if (typeof step !== 'function') throw new Error('stepLine needs opts.step (one instruction)');", '')]],
  // ---- stepLine: the frame's end and a halted CPU ----
  ['stepLine: the frame end is never finished', [E('if (onFrameEnd && machine.tstates >= machine.frameStart + tStatesPerFrame) onFrameEnd(machine);', '')]],
  ['stepLine: the frame end is one T-state late', [E('machine.tstates >= machine.frameStart + tStatesPerFrame', 'machine.tstates > machine.frameStart + tStatesPerFrame')]],
  ['stepLine: the frame end is measured from 0', [E('machine.tstates >= machine.frameStart + tStatesPerFrame', 'machine.tstates >= tStatesPerFrame')]],
  ['stepLine: the frame end is frameStart - T', [E('machine.tstates >= machine.frameStart + tStatesPerFrame', 'machine.tstates >= machine.frameStart - tStatesPerFrame')]],
  ['stepLine: the frame length option is ignored', [E('onFrameEnd = null, tStatesPerFrame = T_STATES_PER_FRAME } = opts;', 'onFrameEnd = null, tStatesPerFrame: _t = T_STATES_PER_FRAME } = opts;')]],
  ['stepLine: the frame is 58687 T-states', [E('export const T_STATES_PER_FRAME = 58688;', 'export const T_STATES_PER_FRAME = 58687;')]],
  ['stepLine: a halted CPU is stepped with the step function (nothing moves)', [E('    if (cpu.halted) {\n      // A halted CPU', '    if (false) {\n      // A halted CPU')]],
  ['stepLine: a halted CPU with no way to finish the frame goes on', [E("      if (!onFrameEnd) return done('limit');\n      onFrameEnd(machine);", '      onFrameEnd(machine);')]],
  ['stepLine: a halted CPU the frame does not release is stepped again and again', [E("      instructions++;\n      if (cpu.halted) return done('limit');", '      instructions++;')]],
  ['stepLine: finishing a halted CPU\'s frame is not an instruction', [E('      onFrameEnd(machine);\n      instructions++;', '      onFrameEnd(machine);')]],
  ['stepLine: instructionStepper runs two instructions', [E('(m) => { runZ80(m.cpu, m.bus, 1, m); }', '(m) => { runZ80(m.cpu, m.bus, 2, m); }')]],
  ['stepLine: instructionStepper passes no clock', [E('(m) => { runZ80(m.cpu, m.bus, 1, m); }', '(m) => { runZ80(m.cpu, m.bus, 1, {}); }')]],
  // ---- describePause ----
  ['describePause: only null has no line', [E('if (line === null || line === undefined) return', 'if (line === null) return')]],
  ['describePause: line 0 has no line', [E('if (line === null || line === undefined) return', 'if (!line) return')]],
  ['describePause: the address is lower case', [E("(n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0')", "(n & 0xFFFF).toString(16).padStart(4, '0')")]],
  ['describePause: the address has no zero padding', [E("toUpperCase().padStart(4, '0')", 'toUpperCase()')]],
  ['describePause: the address is padded to 3', [E("toUpperCase().padStart(4, '0')", "toUpperCase().padStart(3, '0')")]],
  ['describePause: the file is always named', [E("${file ? ` of ${file}` : ''}", '${` of ${file}`}')]],
  ['describePause: the reason is always shown', [E("${reason ? ` (${reason})` : ''}", '${` (${reason})`}')]],
  ['describePause: the reason is not shown', [E("${reason ? ` (${reason})` : ''}", '')]],
  ['describePause: the line and the file are swapped', [E('Paused at line ${line}${file ? ` of ${file}` : \'\'}', 'Paused at ${file ? `${file} ` : \'\'}line ${line}')]],
  ['describePause: no-source text says "at"', [E('`Paused (address ${hex4(pc)}, no source line)`', '`Paused at address ${hex4(pc)} (no source line)`')]],
];

if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) for (const e of edits) {
    const n = readFileSync(join(ROOT, e.file), 'utf8').split(e.from).length - 1;
    if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
    if (e.from === e.to) { console.log(`  ?? ${name}: the mutation changes nothing`); bad++; }
  }
  console.log(bad ? `${bad} pattern(s) not found exactly once` : `all ${MUTANTS.length} mutants' patterns occur exactly once`);
  process.exit(bad ? 1 : 0);
}

// The unmutated suites must pass first, else every "kill" would be the suite's own failure.
if (!only && shardI === 0 || args.includes('--baseline')) {
  for (const t of TESTS) {
    const r = spawnSync('node', [join(ROOT, t)], { encoding: 'utf8', timeout: 900000, env: { ...process.env, ...QUICK_ENV }, cwd: ROOT });
    if (r.status !== 0 || r.error) {
      const out = (r.stdout ?? '') + (r.stderr ?? '');
      console.log(`  BASELINE FAILS: ${t} fails without any mutation; fix it before trusting the kills${r.error ? ` (${r.error.message})` : ''}`);
      for (const l of (out.match(/^.*FAIL.*$/gm) ?? out.split('\n').filter(Boolean).slice(-5)).slice(0, 8)) console.log('    ' + l.slice(0, 300));
      process.exit(2);
    }
  }
}
const tmp = mkdtempSync(join(tmpdir(), 'sdmut-'));
let killed = 0;
const survived = [], equivalent = [], broken = [];
try {
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (mi % shardN !== shardI) continue;
    const root = join(tmp, 'root');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(join(root, 'arcade/tests'), { recursive: true });
    cpSync(join(ROOT, 'src'), join(root, 'src'), { recursive: true });
    cpSync(join(ROOT, 'tests'), join(root, 'tests'), { recursive: true });
    cpSync(join(ROOT, 'arcade/examples'), join(root, 'arcade/examples'), { recursive: true });
    for (const f of ['fast-boot.mjs']) cpSync(join(ROOT, 'arcade/tests', f), join(root, 'arcade/tests', f));
    for (const v of ['v2', 'v3', 'v4']) {      // the runtimes the harness compiles against (the files its real() reads)
      const dir = join(ROOT, 'arcade/build', v);
      if (!existsSync(dir)) continue;
      mkdirSync(join(root, 'arcade/build', v), { recursive: true });
      for (const f of ['runtime.json', 'runtime.bin']) if (existsSync(join(dir, f))) cpSync(join(dir, f), join(root, 'arcade/build', v, f));
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
    const syntax = spawnSync('node', ['--check', join(root, SD)], { encoding: 'utf8' });      // a mutant that does not parse is no kill: the pattern is wrong
    if (syntax.status !== 0) { console.log(`  ?? ${name}: the mutated file does not parse: ${(syntax.stderr ?? '').split('\n').find((l) => /Error/.test(l))}`); broken.push(name); continue; }
    let failedBy = null;
    for (const t of TESTS) {
      const r = spawnSync('node', [join(root, t)], { encoding: 'utf8', timeout: 60000, env: { ...process.env, ...QUICK_ENV }, cwd: root });
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
console.log(`${survived.length || broken.length ? 'FAIL' : 'PASS'}: source-debug-mutations (${killed} killed, ${equivalent.length} equivalent, ${survived.length} survived)`);
process.exit(survived.length || broken.length ? 1 : 0);
