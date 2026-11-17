#!/usr/bin/env node
"use strict";
// source-debug-model.mjs -- tests for src/tools/source-debug.js (the Studio's source debugger, pure half; stage 6 item R4).  No runtime, no emulator: a hand-made map and a tiny Z80.
//   node tests/source-debug-model.mjs
// (The real-runtime tests -- breakpoints on three games, the non-perturbation check -- are tests/source-debug-runtime.mjs; the mutation shard is tests/source-debug-mutations.mjs.)
//
//   1  breakpointAddresses: the lowest address of a line, snapping to the next line with code, hollow lines, several lines on one address, bad input
//   2  watchFor
//   3  decodeCall: every opcode
//   4  lineOf
//   5  describePause
//   6  stepLine on a fake machine: line change, same-line statements, loops (backward jumps), calls into the game and the runtime, Step over (not taken, recursion, breakpoints inside),
//      breakpoints, the limit, the frame's end, the stack tests
import * as S from '../src/tools/source-debug.js';

let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  cond ? passed++ : failed++;
  return cond;
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const sorted = (s) => [...s].sort((a, b) => a - b);

// ---- 1. breakpointAddresses --------------------------------------------------------------------------------------
console.log('1. breakpointAddresses');
{
  // lines 5, 7 (two statements: 0x8003 and 0x8010 -- the LOWEST address counts), 12, 20 have code; the entries are not in line order
  const map = { lines: [{ addr: 0x8000, line: 5, col: 1 }, { addr: 0x8003, line: 7, col: 1 }, { addr: 0x8008, line: 12, col: 1 }, { addr: 0x8010, line: 7, col: 9 }, { addr: 0x8020, line: 20, col: 1 }] };
  let r = S.breakpointAddresses(map, [5]);
  check('a line with code: its address', eq(sorted(r.addrs), [0x8000]) && eq(r.resolved.get(5), { line: 5, addr: 0x8000 }) && r.hollow.length === 0);
  r = S.breakpointAddresses(map, [7]);
  check('a line with two statements: the lowest address (0x8003, not 0x8010)', eq(sorted(r.addrs), [0x8003]) && r.resolved.get(7).addr === 0x8003);
  r = S.breakpointAddresses({ lines: [{ addr: 0x8010, line: 7 }, { addr: 0x8003, line: 7 }] }, [7]);
  check('... whatever order the entries are in', eq(sorted(r.addrs), [0x8003]));
  r = S.breakpointAddresses(map, [6]);
  check('a line without code snaps to the next line with code (6 -> 7)', eq(r.resolved.get(6), { line: 7, addr: 0x8003 }) && eq(sorted(r.addrs), [0x8003]));
  r = S.breakpointAddresses(map, [1]);
  check('a line before the first one snaps to the first (1 -> 5)', eq(r.resolved.get(1), { line: 5, addr: 0x8000 }));
  r = S.breakpointAddresses(map, [8]);
  check('8 -> 12 (a gap of several lines)', eq(r.resolved.get(8), { line: 12, addr: 0x8008 }));
  r = S.breakpointAddresses(map, [13]);
  check('13 -> 20', eq(r.resolved.get(13), { line: 20, addr: 0x8020 }));
  r = S.breakpointAddresses(map, [20]);
  check('the last line with code: itself', eq(r.resolved.get(20), { line: 20, addr: 0x8020 }) && r.hollow.length === 0);
  r = S.breakpointAddresses(map, [21, 100, 30]);
  check('lines after the last one with code are hollow (ascending), and add no address', eq(r.hollow, [21, 30, 100]) && r.addrs.size === 0 && r.resolved.size === 0);
  r = S.breakpointAddresses(map, [6, 7]);
  check('two lines that snap to one line: one address, both resolved', r.addrs.size === 1 && r.resolved.size === 2 && r.resolved.get(6).line === 7 && r.resolved.get(7).line === 7);
  r = S.breakpointAddresses(map, [5, 12, 20, 25]);
  check('a mix: addresses of the lines with code, the hollow one apart', eq(sorted(r.addrs), [0x8000, 0x8008, 0x8020]) && eq(r.hollow, [25]));
  r = S.breakpointAddresses(map, [20, 5, 12, 20]);
  check('a duplicate line counts once; the input order does not matter', r.addrs.size === 3 && r.resolved.size === 3);
  r = S.breakpointAddresses(map, new Set([5, 6]));
  check('any iterable of lines (a Set)', r.addrs.size === 2);
  r = S.breakpointAddresses(map, []);
  check('no lines: nothing', r.addrs.size === 0 && r.resolved.size === 0 && r.hollow.length === 0);
  r = S.breakpointAddresses({ lines: [] }, [3]);
  check('an empty map: every line is hollow', eq(r.hollow, [3]) && r.addrs.size === 0);
  r = S.breakpointAddresses(null, [3]);
  check('no map: every line is hollow, no throw', eq(r.hollow, [3]));
  r = S.breakpointAddresses(map, [NaN, undefined, 5]);
  check('a non-number line is ignored (nothing resolved for it, not hollow)', r.addrs.size === 1 && r.hollow.length === 0 && r.resolved.size === 1 && r.resolved.has(5));
  const big = { lines: Array.from({ length: 1000 }, (_, i) => ({ addr: 0x8000 + 3 * i, line: 2 * i + 1 })) };      // odd lines have code
  let bad = 0;
  for (let l = 1; l <= 2000; l++) { const e = S.breakpointAddresses(big, [l]).resolved.get(l); const want = l % 2 === 1 ? l : l + 1; if (!e || e.line !== want) bad++; }
  check('1000 entries, every line 1..2000 snaps to the next odd one (2000 -> hollow aside)', bad === 1, `${bad} off (line 2000 is past the last, hollow)`);
}

// ---- 2. watchFor --------------------------------------------------------------------------------------------------
console.log('\n2. watchFor');
{
  const addrs = new Set([0x8003, 0x8010]);
  const hits = [];
  const w = S.watchFor(addrs, (pc) => hits.push(pc));
  const m = (pc) => ({ cpu: { pc } });
  check('true at a breakpoint address and false elsewhere', w(m(0x8003)) === true && w(m(0x8010)) === true && w(m(0x8004)) === false && w(m(0)) === false);
  check('onHit gets the pc, on a hit only', eq(hits, [0x8003, 0x8010]));
  check('no onHit: fine', S.watchFor(addrs)(m(0x8003)) === true);
  addrs.add(0x9000);
  check('the set is held, not copied (a breakpoint added later is seen)', w(m(0x9000)) === true);
  addrs.delete(0x8003);
  check('... and one removed is gone', w(m(0x8003)) === false);
  check('an empty set never pauses', S.watchFor(new Set())(m(0x8003)) === false);
}

// ---- 3. decodeCall ------------------------------------------------------------------------------------------------
console.log('\n3. decodeCall');
{
  const CALLS3 = new Set([0xCD, 0xC4, 0xCC, 0xD4, 0xDC, 0xE4, 0xEC, 0xF4, 0xFC]), RST = new Set([0xC7, 0xCF, 0xD7, 0xDF, 0xE7, 0xEF, 0xF7, 0xFF]);
  let wrong = [];
  for (let op = 0; op < 256; op++) {
    const r = S.decodeCall((a) => (a === 0x8000 ? op : 0), 0x8000);
    const want = CALLS3.has(op) ? { isCall: true, length: 3 } : RST.has(op) ? { isCall: true, length: 1 } : { isCall: false, length: 0 };
    if (!eq(r, want)) wrong.push(op.toString(16));
  }
  check('all 256 opcodes: CALL nn and CALL cc (9, length 3), RST (8, length 1), nothing else', wrong.length === 0, wrong.join(' '));
  check('17 calls in all', [...Array(256).keys()].filter((op) => S.decodeCall(() => op, 0).isCall).length === 17);
  check('the opcode is read at the pc it is given', S.decodeCall((a) => (a === 0x1234 ? 0xCD : 0), 0x1234).isCall && !S.decodeCall((a) => (a === 0x1234 ? 0xCD : 0), 0x1235).isCall);
  check('a value above 255 is masked to a byte (a read that returns 0x1CD is CD)', S.decodeCall(() => 0x1CD, 0).isCall);
  check('RET, JP, JR, DJNZ, LD, NOP and HALT are not calls', [0xC9, 0xC3, 0x18, 0x10, 0x3E, 0x00, 0x76, 0xE9].every((op) => !S.decodeCall(() => op, 0).isCall));
  check('an ED / DD / FD / CB prefix is not a call', [0xED, 0xDD, 0xFD, 0xCB].every((op) => !S.decodeCall(() => op, 0).isCall));
}

{
  const JUMPS = new Set([0x18, 0x20, 0x28, 0x30, 0x38, 0x10, 0xC3, 0xC2, 0xCA, 0xD2, 0xDA, 0xE2, 0xEA, 0xF2, 0xFA, 0xE9]);
  const wrong = [];
  for (let op = 0; op < 256; op++) if (S.isJump(op) !== JUMPS.has(op)) wrong.push(op.toString(16));
  check('isJump: all 256 opcodes: JR, JR cc, DJNZ, JP, JP cc and JP (HL) (16), nothing else (CALL, RET, RST, LD, NOP, HALT, prefixes)', wrong.length === 0, wrong.join(' '));
  check('isJump masks to a byte', S.isJump(0x118) === true && S.isJump(0x100) === false);
}

// ---- 4. lineOf ----------------------------------------------------------------------------------------------------
console.log('\n4. lineOf');
{
  const map = { lines: [{ addr: 0x8000, line: 5, col: 1 }, { addr: 0x8010, line: 7, col: 3 }, { addr: 0x8020, line: 9, col: 1 }], codeEnd: 0x8030 };
  check('an entry\'s own address', S.lineOf(map, 0x8010).line === 7 && S.lineOf(map, 0x8010).col === 3);
  check('inside a statement: the entry it belongs to', S.lineOf(map, 0x8015).line === 7 && S.lineOf(map, 0x801F).line === 7);
  check('the first and the last address of the code', S.lineOf(map, 0x8000).line === 5 && S.lineOf(map, 0x802F).line === 9);
  check('below the first entry (runtime code): null', S.lineOf(map, 0x7FFF) === null && S.lineOf(map, 0) === null);
  check('at and above the code\'s end (data): null, when codeEnd is set', S.lineOf(map, 0x8030) === null && S.lineOf(map, 0xE000) === null);
  const open = { lines: map.lines };
  check('without codeEnd the last entry reaches upward (findSource\'s answer)', S.lineOf(open, 0xE000).line === 9);
  check('an empty map and no map: null', S.lineOf({ lines: [] }, 0x8000) === null && S.lineOf(null, 0x8000) === null);
  check('codeEnd 0 is a real end (everything is outside)', S.lineOf({ lines: map.lines, codeEnd: 0 }, 0x8000) === null);
}

// ---- 5. describePause ---------------------------------------------------------------------------------------------
console.log('\n5. describePause');
{
  check('breakpoint', S.describePause({ pc: 0x8003, line: 12, file: 'game.arc', reason: 'breakpoint' }) === 'Paused at line 12 of game.arc (breakpoint)');
  check('step', S.describePause({ pc: 0x8003, line: 7, file: 'file.arc', reason: 'step' }) === 'Paused at line 7 of file.arc (step)');
  check('no source line: the address, upper case, four digits', S.describePause({ pc: 0x4f2, line: null, file: 'game.arc', reason: 'step' }) === 'Paused (address $04F2, no source line)');
  check('line undefined is no line either', S.describePause({ pc: 0xabcd, line: undefined }) === 'Paused (address $ABCD, no source line)');
  check('line 0 is a line', S.describePause({ pc: 1, line: 0, file: 'a.arc', reason: 'step' }) === 'Paused at line 0 of a.arc (step)');
  check('no file: just the line', S.describePause({ pc: 1, line: 3, reason: 'breakpoint' }) === 'Paused at line 3 (breakpoint)');
  check('no reason: none shown', S.describePause({ pc: 1, line: 3, file: 'a.arc' }) === 'Paused at line 3 of a.arc');
  check('another reason is passed through', S.describePause({ pc: 1, line: 3, file: 'a.arc', reason: 'tick' }) === 'Paused at line 3 of a.arc (tick)');
}

// ---- 6. stepLine on a fake machine ------------------------------------------------------------------------------------
console.log('\n6. stepLine (a fake machine with the Z80 opcodes the game code is made of)');
// A tiny Z80: NOP (00), DJNZ (10), JR (18), JR NZ (20), JP (C3), CALL (CD), CALL NZ (C4), RST 0 (C7), RET (C9).  4 T-states each.
function fake(bytesAt, { b = 0, z = false } = {}) {
  const mem = new Uint8Array(65536);
  for (const [at, bytes] of Object.entries(bytesAt)) mem.set(bytes, Number(at));
  const m = { mem, cpu: { pc: 0x8000, sp: 0xFF00, b, z }, tstates: 0, frameStart: 0, bus: { read: (a) => mem[a & 0xFFFF] }, steps: 0 };
  const w16 = (a, v) => { mem[a] = v & 255; mem[a + 1] = v >> 8; };
  const r16 = (a) => mem[a] | (mem[a + 1] << 8);
  const s8 = (v) => (v << 24) >> 24;
  const push = (v) => { m.cpu.sp = (m.cpu.sp - 2) & 0xFFFF; w16(m.cpu.sp, v); };
  m.step = (mm) => {
    const c = mm.cpu, op = mem[c.pc];
    mm.steps++;
    mm.tstates += 4;
    switch (op) {
      case 0x00: c.pc++; break;
      case 0x10: c.b = (c.b - 1) & 255; c.pc = c.b !== 0 ? c.pc + 2 + s8(mem[c.pc + 1]) : c.pc + 2; break;
      case 0x18: c.pc = c.pc + 2 + s8(mem[c.pc + 1]); break;
      case 0x20: c.pc = !c.z ? c.pc + 2 + s8(mem[c.pc + 1]) : c.pc + 2; break;
      case 0xC3: c.pc = r16(c.pc + 1); break;
      case 0xC2: c.pc = !c.z ? r16(c.pc + 1) : c.pc + 3; break;
      case 0xCD: push(c.pc + 3); c.pc = r16(c.pc + 1); break;
      case 0xC4: if (!c.z) { push(c.pc + 3); c.pc = r16(c.pc + 1); } else c.pc += 3; break;
      case 0xC7: push(c.pc + 1); c.pc = 0; break;
      case 0xED: c.b = (c.b - 1) & 255; c.pc = c.b !== 0 ? c.pc : c.pc + 1; break;      // (stands for LDIR: repeats on its own pc until the count runs out)
      case 0x76: c.halted = true; break;                  // (the pc stays on the HALT; a frame's end delivers the interrupt and moves it on)
      case 0xC9: c.pc = r16(c.sp); c.sp = (c.sp + 2) & 0xFFFF; break;
      default: throw new Error('fake Z80: opcode ' + op.toString(16) + ' at ' + c.pc.toString(16));
    }
  };
  return m;
}
const NOP = 0, RET = 0xC9;
const lo = (a) => a & 255, hi = (a) => a >> 8;
const PROG = {
  0x8000: [NOP, NOP, NOP, NOP],                          // 8000 L10, 8001 -, 8002 L10 (a second statement of line 10), 8003 L11
  0x8004: [0xCD, lo(0x8100), hi(0x8100)],                // 8004 L12: CALL a game PROC
  0x8007: [NOP],                                         // 8007 L13
  0x8008: [0xCD, lo(0x9000), hi(0x9000)],                // 8008 L14: CALL a runtime routine (no entries)
  0x800B: [NOP],                                         // 800B L15
  0x8010: [NOP, NOP, 0x10, 0xFD, NOP],                   // 8010 L20, 8011 L20 (b), 8012 DJNZ 8011, 8014 L21
  0x8020: [0xC4, lo(0x8100), hi(0x8100), NOP],           // 8020 L30: CALL NZ (taken when z is false), 8023 L31
  0x8030: [0x18, 0xFE],                                  // 8030 (no entries): JR $ -- an endless loop
  0x8040: [0xCD, lo(0x8043), hi(0x8043)],                // 8040 L40: CALL to the next instruction ...
  0x8043: [RET, NOP],                                    // 8043 L41: ... which is a RET: the return address is the callee's own address
  0x8050: [0xC7],                                        // 8050 L50: RST 0 (a routine of the runtime at 0000: it is RET)
  0x8051: [NOP],                                         // 8051 L51
  0x8070: [NOP, NOP, 0x20, 0xFD, NOP],                   // 8070 L80, 8071 L80 (b), 8072 JR NZ 8071, 8074 L81
  0x8080: [NOP, NOP, 0xC3, 0x81, 0x80],                  // 8080 L90, 8081 L90 (b), 8082 JP 8081 (an endless loop on one line)
  0x8090: [NOP, NOP, 0x18, 0xFD],                        // 8090 L91, 8091 L91 (b), 8092 JR 8091 (the same with JR)
  0x80A0: [0x18, 0xFE],                                  // 80A0 L100: JR $ (a spin on one statement)
  0x80B0: [0x10, 0x00, NOP, NOP],                        // 80B0 L110 DJNZ (to the next instruction), 80B2 L110, 80B3 L111
  0x80C0: [NOP, NOP, 0xC2, 0xC1, 0x80, NOP],             // 80C0 L120, 80C1 L120 (b), 80C2 JP NZ 80C1, 80C5 L121
  0x80D0: [0xED, NOP],                                   // 80D0 L130: a repeating instruction (LDIR), 80D1 L131
  0x8060: [NOP, 0x76, NOP],                              // 8060 L70, 8061 HALT (no entry), 8062 L71
  0x9010: [0xCD, lo(0x8100), hi(0x8100), RET],           // the runtime calls a game PROC (its tick loop calling PROC FRAME)
  0x8100: [NOP, NOP, RET],                               // 8100 L60 (PROC), 8101 L61, RET
  0x9000: [NOP, NOP, RET],                               // the runtime
  0x0000: [RET],
};
const MAP = { lines: [
  [0x8000, 10], [0x8002, 10], [0x8003, 11], [0x8004, 12], [0x8007, 13], [0x8008, 14], [0x800B, 15], [0x8010, 20], [0x8011, 20], [0x8014, 21],
  [0x8020, 30], [0x8023, 31], [0x8040, 40], [0x8043, 41], [0x8050, 50], [0x8051, 51], [0x8060, 70], [0x8062, 71], [0x8070, 80], [0x8071, 80], [0x8074, 81], [0x8080, 90], [0x8081, 90], [0x8090, 91], [0x8091, 91], [0x80A0, 100], [0x80B0, 110], [0x80B2, 110], [0x80B3, 111], [0x80C0, 120], [0x80C1, 120], [0x80C5, 121], [0x80D0, 130], [0x80D1, 131], [0x8100, 60], [0x8101, 61],
].map(([addr, line]) => ({ addr, line, col: 1 })), codeEnd: 0x8200 };
const at = (pc, o = {}) => { const m = fake(PROG, o); m.cpu.pc = pc; return m; };
const go = (m, o = {}) => S.stepLine(m, MAP, { step: m.step, ...o });
{
  let m = at(0x8000), r = go(m);
  check('a statement of the same line is passed (8000 L10 -> 8003 L11, past the second entry of line 10)', r.stopped === 'line' && r.pc === 0x8003 && r.line === 11 && r.instructions === 3 && m.cpu.pc === 0x8003, JSON.stringify(r));
  m = at(0x8001); r = go(m);
  check('from the middle of a statement: the line is the entry\'s (8001 is in line 10)', r.pc === 0x8003 && r.instructions === 2);
  m = at(0x8003); r = go(m);
  check('line 11 -> 12 is one instruction', r.pc === 0x8004 && r.line === 12 && r.instructions === 1);
  m = at(0x8004); r = go(m);
  check('step into a game PROC: stops at its first entry (8100 L60), in the callee', r.stopped === 'line' && r.pc === 0x8100 && r.line === 60 && r.instructions === 1);
  m = at(0x8004); r = go(m, { over: true });
  check('step over it: the next line (8007 L13) after CALL + 3 instructions of the callee', r.stopped === 'line' && r.pc === 0x8007 && r.line === 13 && r.instructions === 4 && m.cpu.sp === 0xFF00);
  m = at(0x8004); r = go(m, { over: true, breakpoints: new Set([0x8101]) });
  check('step over honours a breakpoint inside the callee (8101)', r.stopped === 'breakpoint' && r.pc === 0x8101 && r.line === 61 && r.instructions === 2);
  m = at(0x8004); r = go(m, { over: true, breakpoints: new Set([0x8007]) });
  check('a breakpoint at the line stepped to is a breakpoint stop', r.stopped === 'breakpoint' && r.pc === 0x8007);
  m = at(0x8101); m.mem[0xFEFE] = 0x07; m.mem[0xFEFF] = 0x80; m.cpu.sp = 0xFEFE; r = go(m);
  check('stepping out of a PROC: from its last statement (8101, then the RET) to the line after the CALL (8007), the return address on the stack', r.stopped === 'line' && r.pc === 0x8007 && r.instructions === 2 && m.cpu.sp === 0xFF00, JSON.stringify(r));
  m = at(0x8008); r = go(m);
  check('a call into the runtime (no entries) runs through even stepping into: 8008 -> 800B', r.stopped === 'line' && r.pc === 0x800B && r.line === 15 && r.instructions === 4, JSON.stringify(r));
  m = at(0x8008); r = go(m, { over: true });
  check('... and stepping over it is the same', r.pc === 0x800B && r.instructions === 4);
  m = at(0x8008); r = go(m, { breakpoints: new Set([0x9001]) });
  check('a breakpoint address inside the runtime routine is honoured too', r.stopped === 'breakpoint' && r.pc === 0x9001 && r.line === null, JSON.stringify(r));

  // loops
  m = at(0x8010, { b: 3 }); r = go(m);
  check('a loop on one line: the pass back to the same line stops (8010 -> 8011 after the DJNZ went back)', r.stopped === 'line' && r.pc === 0x8011 && r.line === 20 && r.instructions === 3, JSON.stringify(r));
  r = go(m);
  check('... again from 8011 (b is 2)', r.stopped === 'line' && r.pc === 0x8011 && r.instructions === 2 && m.cpu.b === 1, JSON.stringify(r));
  r = go(m);
  check('... and when the loop ends, the next line (8014 L21)', r.stopped === 'line' && r.pc === 0x8014 && r.line === 21 && m.cpu.b === 0, JSON.stringify(r));
  m = at(0x8010, { b: 1 }); r = go(m);
  check('a loop that does not go back: line 20 straight on to 21 (b = 1)', r.pc === 0x8014 && r.line === 21 && r.instructions === 3, JSON.stringify(r));

  // the other jumps that go back
  m = at(0x8070); r = go(m);
  check('JR NZ back on one line stops at the pass (8070 -> 8071)', r.stopped === 'line' && r.pc === 0x8071 && r.instructions === 3, JSON.stringify(r));
  m.cpu.z = true; r = go(m);
  check('... and the loop ending (z set) goes on to the next line (8074 L81)', r.pc === 0x8074 && r.line === 81 && r.instructions === 2, JSON.stringify(r));
  m = at(0x8080); r = go(m);
  check('JP back on one line stops at the pass (8080 -> 8081)', r.stopped === 'line' && r.pc === 0x8081 && r.instructions === 3, JSON.stringify(r));
  m = at(0x8090); r = go(m);
  check('JR back on one line stops at the pass (8090 -> 8091)', r.stopped === 'line' && r.pc === 0x8091 && r.instructions === 3, JSON.stringify(r));
  m = at(0x80C0); r = go(m);
  check('JP NZ back on one line stops at the pass (80C0 -> 80C1)', r.stopped === 'line' && r.pc === 0x80C1 && r.instructions === 3, JSON.stringify(r));
  m = at(0x80A0); r = go(m);
  check('a jump to its own address (JR $ on a statement) is a loop that went back: the step ends after one instruction, at the same pc', r.stopped === 'line' && r.pc === 0x80A0 && r.instructions === 1, JSON.stringify(r));

  m = at(0x80D0, { b: 3 }); r = go(m);
  check('a repeating instruction (LDIR: the pc stays on it) is not a loop that went back: the statement runs to its end (80D0 -> 80D1 in 3)', r.stopped === 'line' && r.pc === 0x80D1 && r.line === 131 && r.instructions === 3, JSON.stringify(r));

  // conditional call
  m = at(0x8020, { z: true }); r = go(m, { over: true });
  check('CALL cc not taken, stepping over: the next instruction, one instruction', r.stopped === 'line' && r.pc === 0x8023 && r.instructions === 1 && m.cpu.sp === 0xFF00, JSON.stringify(r));
  m = at(0x8020, { z: true }); r = go(m);
  check('CALL cc not taken, stepping into: the same', r.pc === 0x8023 && r.instructions === 1);
  m = at(0x8020, { z: false }); r = go(m, { over: true });
  check('CALL cc taken, stepping over: through the callee to 8023', r.pc === 0x8023 && r.instructions === 4 && m.cpu.sp === 0xFF00, JSON.stringify(r));
  m = at(0x8020, { z: false }); r = go(m);
  check('CALL cc taken, stepping into: the callee\'s first entry', r.pc === 0x8100 && r.line === 60 && r.instructions === 1);

  // the stack decides: a call whose target is the next instruction
  m = at(0x8040); r = go(m, { over: true });
  check('step over a CALL to the next instruction: only the RET brings the stack back (2 instructions, not 1)', r.stopped === 'line' && r.pc === 0x8043 && r.instructions === 2 && m.cpu.sp === 0xFF00, JSON.stringify(r));
  m = at(0x8050); r = go(m, { over: true });
  check('step over RST 0 (the routine at 0000 is a RET): 8050 -> 8051', r.stopped === 'line' && r.pc === 0x8051 && r.line === 51 && r.instructions === 2 && m.cpu.sp === 0xFF00, JSON.stringify(r));
  m = at(0x8050); r = go(m);
  check('step into RST 0: the routine has no entry, runs through', r.pc === 0x8051 && r.instructions === 2);

  // breakpoints
  m = at(0x8000); r = go(m, { breakpoints: new Set([0x8001]) });
  check('a breakpoint address on the way stops before anything else (8001 is no entry)', r.stopped === 'breakpoint' && r.pc === 0x8001 && r.line === 10 && r.instructions === 1);
  m = at(0x8000); r = go(m, { breakpoints: new Set([0x8000]) });
  check('a breakpoint at the starting pc does not stop the first instruction (resume semantics)', r.stopped === 'line' && r.pc === 0x8003);
  m = at(0x8000); r = go(m, { breakpoints: new Set([0x8003]) });
  check('a breakpoint at the line it reaches: reported as the breakpoint', r.stopped === 'breakpoint' && r.pc === 0x8003);
  m = at(0x8000); r = go(m, { breakpoints: new Set([0x8002, 0x8003]) });
  check('the first one on the way wins', r.pc === 0x8002 && r.instructions === 2);
  m = at(0x8000); r = go(m, { breakpoints: new Set([0x9999]) });
  check('a breakpoint not on the way changes nothing', r.stopped === 'line' && r.pc === 0x8003);

  // the limit
  m = at(0x8030); r = go(m, { maxInstructions: 50 });
  check('an endless loop with no entry ends at the limit', r.stopped === 'limit' && r.instructions === 50 && m.steps === 50 && r.pc === 0x8030, JSON.stringify(r));
  m = at(0x8030); r = go(m);
  check('the default limit is 200000 instructions', r.stopped === 'limit' && r.instructions === 200000 && S.MAX_STEP_INSTRUCTIONS === 200000, JSON.stringify(r));
  m = at(0x8000); r = go(m, { maxInstructions: 3 });
  check('a stop on the very instruction the limit counts out is the stop, not the limit', r.stopped === 'line' && r.instructions === 3);
  m = at(0x8000); r = go(m, { maxInstructions: 2 });
  check('one short of it: the limit', r.stopped === 'limit' && r.instructions === 2 && r.pc === 0x8002);
  m = at(0x8004); r = go(m, { over: true, maxInstructions: 2 });
  check('the limit counts the instructions of a stepped-over callee too', r.stopped === 'limit' && r.instructions === 2 && r.pc === 0x8101 && r.line === 61, JSON.stringify(r));

  // the frame's end
  m = at(0x8000); m.tstates = 58684; let ends = 0, endAt = 0;
  r = go(m, { onFrameEnd: (mm) => { ends++; endAt = mm.steps; mm.frameStart += 58688; } });
  check('a frame end inside the step calls onFrameEnd once, right after the instruction that reached it (the hook moves frameStart on, as runFrame does)', ends === 1 && endAt === 1 && r.pc === 0x8003, `${ends} calls, at step ${endAt}`);
  m = at(0x8000); m.tstates = 100; ends = 0;
  r = go(m, { onFrameEnd: () => { ends++; } });
  check('no frame end: no call', ends === 0 && r.pc === 0x8003);
  m = at(0x8000); m.tstates = 5000; m.frameStart = 5000 - 58688 + 8; ends = 0;
  r = go(m, { onFrameEnd: (mm) => { ends++; endAt = mm.steps; mm.frameStart = mm.tstates; } });
  check('the end is frameStart + 58688 (a frame that began earlier: it ends two instructions in)', ends === 1 && endAt === 2 && r.pc === 0x8003, `${ends} calls, at step ${endAt}`);
  m = at(0x8000); m.tstates = 20; m.frameStart = 0; ends = 0;
  r = go(m, { onFrameEnd: (mm) => { ends++; endAt = mm.steps; mm.frameStart += 24; }, tStatesPerFrame: 24 });
  check('the frame length can be given', ends === 1 && endAt === 1 && r.pc === 0x8003, `${ends} calls, at step ${endAt}`);
  m = at(0x8000); m.tstates = 58690;
  r = go(m);
  check('no onFrameEnd given: the step simply goes on', r.pc === 0x8003);

  // the stack tests: an interrupt that takes the place of a backward jump
  m = at(0x8010, { b: 3 });
  const irqStep = (mm) => {
    if (mm.cpu.pc === 0x8012 && !mm.fired) { mm.fired = true; mm.cpu.sp -= 2; mm.mem[mm.cpu.sp] = 0x12; mm.mem[mm.cpu.sp + 1] = 0x80; mm.cpu.pc = 0x0038; mm.tstates += 13; mm.steps++; return; }
    if (mm.cpu.pc === 0x0038) { mm.cpu.pc = mm.mem[mm.cpu.sp] | (mm.mem[mm.cpu.sp + 1] << 8); mm.cpu.sp += 2; mm.steps++; return; }
    mm.step(mm);
  };
  r = S.stepLine(m, MAP, { step: irqStep });
  check('an interrupt taken in place of the DJNZ (pc falls to $38, sp drops) is not a backward jump: the step goes on to the DJNZ and back', r.pc === 0x8011 && r.instructions === 5, JSON.stringify(r));
  m = at(0x80B0, { b: 1 });
  const irqDjnz = (mm) => {
    if (mm.cpu.pc === 0x80B0 && !mm.fired) { mm.fired = true; mm.cpu.sp -= 2; mm.mem[mm.cpu.sp] = 0xB0; mm.mem[mm.cpu.sp + 1] = 0x80; mm.cpu.pc = 0x0038; mm.steps++; return; }
    if (mm.cpu.pc === 0x0038) { mm.cpu.pc = mm.mem[mm.cpu.sp] | (mm.mem[mm.cpu.sp + 1] << 8); mm.cpu.sp += 2; mm.steps++; return; }
    mm.step(mm);
  };
  r = S.stepLine(m, MAP, { step: irqDjnz });
  check('an interrupt taken in place of a DJNZ that then falls through: no backward jump was seen, so the second statement of the line is passed (80B0 -> 80B3 L111)', r.stopped === 'line' && r.pc === 0x80B3 && r.line === 111 && r.instructions === 4, JSON.stringify(r));
  m = at(0x8040); const irqCall = (mm) => {
    if (mm.cpu.pc === 0x8040 && !mm.fired) { mm.fired = true; mm.cpu.sp -= 2; mm.mem[mm.cpu.sp] = 0x40; mm.mem[mm.cpu.sp + 1] = 0x80; mm.cpu.pc = 0x0038; mm.steps++; return; }
    if (mm.cpu.pc === 0x0038) { mm.cpu.pc = mm.mem[mm.cpu.sp] | (mm.mem[mm.cpu.sp + 1] << 8); mm.cpu.sp += 2; mm.steps++; return; }
    mm.step(mm);
  };
  r = S.stepLine(m, MAP, { step: irqCall, over: true });
  check('an interrupt taken at the CALL: step over still ends at the return address (8043) with the stack back', r.stopped === 'line' && r.pc === 0x8043 && m.cpu.sp === 0xFF00 && r.instructions === 4, JSON.stringify(r));

  // a halted CPU (the runtime waits for the frame interrupt with HALT)
  m = at(0x8060); ends = 0;
  r = go(m, { onFrameEnd: (mm) => { ends++; mm.frameStart += 58688; mm.cpu.halted = false; mm.cpu.pc++; } });
  check('HALT: a halted CPU is moved by the frame\'s end (onFrameEnd), which counts as the step: 8060 -> 8062 in 3', r.stopped === 'line' && r.pc === 0x8062 && r.line === 71 && r.instructions === 3 && ends === 1 && m.steps === 2, JSON.stringify(r));
  m = at(0x8060); r = go(m);
  check('HALT with no way to finish the frame: the limit at once, not 200000 idle steps', r.stopped === 'limit' && r.pc === 0x8061 && r.instructions === 2 && m.steps === 2, JSON.stringify(r));
  m = at(0x8060); ends = 0; r = go(m, { onFrameEnd: () => { ends++; } });
  check('HALT that the frame\'s end does not release (DI + HALT): the limit after one frame', r.stopped === 'limit' && r.pc === 0x8061 && ends === 1, JSON.stringify(r));
  m = at(0x8060); r = go(m, { over: true, onFrameEnd: (mm) => { mm.frameStart += 58688; mm.cpu.halted = false; mm.cpu.pc++; } });
  check('HALT in step over: the same', r.stopped === 'line' && r.pc === 0x8062 && r.instructions === 3);

  m = at(0x9010); r = go(m, { over: true });
  check('step over does not step over a call made from runtime code: the runtime\'s call of a game PROC ends the step at the PROC\'s first statement (8100)', r.stopped === 'line' && r.pc === 0x8100 && r.line === 60 && r.instructions === 1, JSON.stringify(r));
  m = at(0x9010); r = go(m);
  check('... as stepping into does', r.pc === 0x8100 && r.instructions === 1);

  // starting outside the game's code
  m = at(0x9000); m.mem[0xFEFE] = 0x0B; m.mem[0xFEFF] = 0x80; m.cpu.sp = 0xFEFE; r = go(m);
  check('started in the runtime with a return address into the game: the first entry reached ends it (800B L15), line 15', r.stopped === 'line' && r.pc === 0x800B && r.line === 15 && r.instructions === 3, JSON.stringify(r));
  m = at(0x8000); r = go(m);
  check('the result names the line of the pc it stopped at', r.line === S.lineOf(MAP, r.pc).line);

  // arguments
  let threw = false; try { S.stepLine(at(0x8000), MAP, {}); } catch { threw = true; }
  check('no step function: an error, not a hang', threw);
  m = at(0x8000); const reads = []; r = S.stepLine(m, MAP, { step: m.step, read: (a) => { reads.push(a); return m.mem[a]; }, over: true });
  check('the decoding reads through opts.read', reads.length > 0 && r.pc === 0x8003);
  m = at(0x8000); let seen = null;
  const stepper = S.instructionStepper((cpu, bus, n, clock) => { seen = { cpu, bus, n, clock }; m.step(m); });
  stepper(m);
  check('instructionStepper runs runZ80(cpu, bus, 1, machine)', seen && seen.cpu === m.cpu && seen.bus === m.bus && seen.n === 1 && seen.clock === m);
  m = at(0x8000); const noMap = S.stepLine(m, { lines: [] }, { step: m.step, maxInstructions: 7 });
  check('a map with no entries: runs to the limit', noMap.stopped === 'limit' && noMap.instructions === 7 && noMap.line === null);
  check('T_STATES_PER_FRAME is TSRun\'s 58688', S.T_STATES_PER_FRAME === 58688);
}

console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: source-debug-model (${passed} passed, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
