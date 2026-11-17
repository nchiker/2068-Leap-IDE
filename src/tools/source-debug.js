"use strict";
// source-debug.js -- Leap Arcade Studio's source debugger (stage 6, item R4): the PURE half.  No DOM, no CodeMirror, no TSRun import: Node can import it.
//
// What it knows: the build's source map (`map.lines` = [{addr, line, col}] sorted by address, one entry per generated statement; src/lang/arcade/arcade-link.js)
// and the Z80.  What it does not: the Studio, the gutter, the emulator's pause (src/emulator.js `setWatch` / `stepInstruction` / `resume`); the Studio wires those.
//
//   breakpointAddresses(map, lines)  source lines -> the addresses to stop at (the snapping rule below), which line each snapped to, the lines with no code after them
//   watchFor(addrs, onHit)           the function for `emulator.setWatch`: true (pause) when the pc is one of the addresses
//   decodeCall(read, pc)             is the instruction at pc a CALL or an RST, and how long is it (Step over runs to pc + length)
//   stepLine(machine, map, opts)     Step line / Step over: single-step until the pc is at the next source statement
//   lineOf(map, addr)                the map entry of an address, null for code with no source
//   describePause(info)              the status line text
//   instructionStepper(runZ80)       the one-instruction `step` function for stepLine
//
// COORDINATES.  A line here is a line of the text the compiler compiled (the `line` of the map's entries).  When the project's text had the generated objects.arc put in front of it
// (compile()'s `lineOffset`), those lines are the user's + lineOffset; the project's line map (src/arcade-project.js, "P4") turns a (file, line) into that joined line.  Nothing here knows files.
//
// ADDRESSES.  `map.lines` holds only the game's code; the runtime's own routines have no entry.  findSource() (arcade-link.js) answers "the last entry at or before addr", which for an
// address ABOVE the code (data, the sprite frames) is the last statement, so lineOf() takes the end of the code: `map.codeEnd` if the caller set it (the Studio sets
// `map.codeEnd = gen.base + gen.code.length`), else none.  An address below the first entry is runtime code: null.

/** T-states of one frame of the TS2068 (tsrun/machine.js `tStatesPerFrame`; stepLine's default for noticing a frame's end). */
export const T_STATES_PER_FRAME = 58688;

/** Step line gives up after this many instructions (contract R4). */
export const MAX_STEP_INSTRUCTIONS = 200000;

// ---- the map ---------------------------------------------------------------------------------------------------

/** line -> the entry with the LOWEST address of that line. */
function firstEntryByLine(map) {
  const first = new Map();
  for (const e of map?.lines ?? []) {
    const cur = first.get(e.line);
    if (cur === undefined || e.addr < cur.addr) first.set(e.line, e);
  }
  return first;
}

/** First index of `sorted` (ascending numbers) that is >= x, or sorted.length. */
function lowerBound(sorted, x) {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/**
 * The addresses to stop at for a set of breakpoint lines.  A breakpoint stops before the first instruction of the line's first (lowest address) entry.  A line with no entry
 * (a comment, a blank line, a declaration) snaps to the next greater line that has one; when none follows, the line is hollow (it can never be hit).
 * Several lines may snap to the same line: one address.
 * @param {{lines: {addr:number, line:number}[]}} map
 * @param {Iterable<number>} lines
 * @returns {{addrs: Set<number>, resolved: Map<number, {line:number, addr:number}>, hollow: number[]}}  `resolved` is keyed by the line asked for; `hollow` is ascending.
 */
export function breakpointAddresses(map, lines) {
  const first = firstEntryByLine(map);
  const sorted = [...first.keys()].sort((a, b) => a - b);
  const addrs = new Set(), resolved = new Map(), hollow = new Set();
  for (const line of lines ?? []) {
    if (!Number.isFinite(line)) continue;
    const at = lowerBound(sorted, line);
    if (at >= sorted.length) { hollow.add(line); continue; }
    const e = first.get(sorted[at]);
    resolved.set(line, { line: e.line, addr: e.addr });
    addrs.add(e.addr);
  }
  return { addrs, resolved, hollow: [...hollow].sort((a, b) => a - b) };
}

/**
 * The function for `emulator.setWatch(fn)`: called with the machine before each instruction, true = pause there.  It is a Set test and nothing more (the cost is paid per instruction,
 * and only while a breakpoint exists).  `addrs` is held, not copied: the Studio may change the set between runs.
 * @param {Set<number>} addrs
 * @param {(pc:number) => void} [onHit]  called with the pc when the watch answers true
 */
export function watchFor(addrs, onHit) {
  return (m) => {
    const pc = m.cpu.pc;
    if (!addrs.has(pc)) return false;
    if (onHit) onHit(pc);
    return true;
  };
}

/**
 * The map entry that holds `addr` ({addr, line, col}), or null for an address with no source: below the first entry (the runtime), or at or above `map.codeEnd` (when it is set).
 * It is findSource() (arcade-link.js) with the code's end.
 */
export function lineOf(map, addr) {
  const lines = map?.lines;
  if (!lines || lines.length === 0) return null;
  if (map.codeEnd !== undefined && addr >= map.codeEnd) return null;
  let lo = 0, hi = lines.length - 1, best = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].addr <= addr) { best = lines[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return best;
}

// ---- the Z80 ---------------------------------------------------------------------------------------------------

/**
 * Is the instruction at pc a call?  CALL nn (CD) and CALL cc,nn (C4 CC D4 DC E4 EC F4 FC) are 3 bytes, RST p (C7 CF D7 DF E7 EF F7 FF) is 1.  Step over sets the return address
 * pc + length.  A prefix (CB DD ED FD) never starts a call.  For anything else: {isCall: false, length: 0}.
 * @param {(addr:number) => number} read
 */
export function decodeCall(read, pc) {
  const op = read(pc) & 0xFF;
  if (op === 0xCD || (op & 0xC7) === 0xC4) return { isCall: true, length: 3 };
  if ((op & 0xC7) === 0xC7) return { isCall: true, length: 1 };
  return { isCall: false, length: 0 };
}

/** Does this opcode jump to a new pc?  JR (18), JR cc (20 28 30 38), DJNZ (10), JP (C3), JP cc (C2 CA D2 DA E2 EA F2 FA), JP (HL) (E9).  A loop's way back is one of these. */
export function isJump(op) {
  op &= 0xFF;
  return op === 0x18 || (op & 0xE7) === 0x20 || op === 0x10 || op === 0xC3 || (op & 0xC7) === 0xC2 || op === 0xE9;
}

/** `step` for stepLine: one instruction of a TSRun machine, from its z80.js `runZ80` (a budget of 1 runs exactly one). */
export const instructionStepper = (runZ80) => (m) => { runZ80(m.cpu, m.bus, 1, m); };

// ---- Step line / Step over -------------------------------------------------------------------------------------

/**
 * Run the paused machine one source statement.  Single-steps until the pc is at the address of a map entry whose LINE differs from the line it started on (a call into a game PROC
 * therefore stops inside it, at its first entry; a call into the runtime has no entry and runs through), or at an entry of the SAME line after a loop went back (a taken JR / JP / DJNZ to the same or a
 * lower address: `FOR i = 1 TO 8 : ... : NEXT` on one line stops at each pass).  The instruction the machine is paused at always runs first (a breakpoint there does not stop it).
 *
 * Step over (`over: true`) runs a CALL or RST of the game's code to its return address (pc + length with the stack where it was, so recursion and the frame interrupt cannot end it early), still
 * stopping at a breakpoint inside; the instructions in between are not looked at for entries.  A call made from runtime code (no source line at the call) is not stepped over: when the last statement
 * of PROC FRAME is stepped over, the runtime's tick loop calls PROC FRAME again and the step ends at its first statement.
 *
 * @param {object} machine  a TSRun machine: cpu {pc, sp}, tstates, frameStart, bus.read
 * @param {{lines: {addr:number, line:number}[], codeEnd?: number}} map
 * @param {object} [opts]
 *   step(m)              executes one instruction (required; `instructionStepper(runZ80)` for TSRun)
 *   read(addr)           memory read for decoding (default machine.bus.read)
 *   over                 step over calls
 *   breakpoints          Set of addresses: reaching one stops with 'breakpoint'
 *   maxInstructions      default 200000: then 'limit'
 *   onFrameEnd(m)        called when an instruction ran past the frame's end, to finish the frame as the emulator does (runFrame, which takes the frame interrupt); also the step of a halted CPU
 *   tStatesPerFrame      default 58688
 * @returns {{stopped: 'line'|'breakpoint'|'limit', pc:number, line:number|null, instructions:number}}
 */
export function stepLine(machine, map, opts = {}) {
  const { step, over = false, breakpoints = null, maxInstructions = MAX_STEP_INSTRUCTIONS, onFrameEnd = null, tStatesPerFrame = T_STATES_PER_FRAME } = opts;
  if (typeof step !== 'function') throw new Error('stepLine needs opts.step (one instruction)');
  const cpu = machine.cpu;
  const read = opts.read ?? ((a) => machine.bus.read(a));
  const entryAt = new Map();
  for (const e of map?.lines ?? []) if (!entryAt.has(e.addr)) entryAt.set(e.addr, e);
  const startEntry = lineOf(map, cpu.pc);
  const startLine = startEntry ? startEntry.line : null;
  let instructions = 0, back = false;
  let retPc = -1, retSp = 0, pending = false;       // Step over: waiting for the return address with this stack
  const done = (stopped) => ({ stopped, pc: cpu.pc, line: lineOf(map, cpu.pc)?.line ?? null, instructions });
  for (;;) {
    const pc = cpu.pc, sp = cpu.sp;
    let jumps = false;
    if (!pending) {
      const op = read(pc) & 0xFF;
      jumps = isJump(op);
      if (over) {
        const c = decodeCall(read, pc);
        // (only a call made from the game's code is stepped over: the runtime's own call of a game PROC -- its tick loop calling PROC FRAME -- is where the next statement is)
        if (c.isCall && lineOf(map, pc)) { pending = true; retPc = (pc + c.length) & 0xFFFF; retSp = sp; }
      }
    }
    if (cpu.halted) {
      // A halted CPU (the runtime waits for the frame interrupt with HALT) does not move by single instructions: runZ80 with a budget of 1 does nothing.  Only the frame's end moves it
      // (runFrame idles to the end and takes the interrupt), so that is the step.  No way to finish the frame, or still halted after it (DI + HALT): nothing more can happen.
      if (!onFrameEnd) return done('limit');
      onFrameEnd(machine);
      instructions++;
      if (cpu.halted) return done('limit');
    } else {
      step(machine);
      instructions++;
      if (onFrameEnd && machine.tstates >= machine.frameStart + tStatesPerFrame) onFrameEnd(machine);
    }
    const now = cpu.pc;
    if (pending) {
      if (now === retPc && cpu.sp === retSp) pending = false;      // back (or a CALL cc that was not taken)
      else {
        if (breakpoints && breakpoints.has(now)) return done('breakpoint');
        if (instructions >= maxInstructions) return done('limit');
        continue;
      }
    } else if (jumps && now <= pc && cpu.sp === sp) back = true;      // (the stack test: a frame interrupt taken instead of the jump also lands low)
    if (breakpoints && breakpoints.has(now)) return done('breakpoint');
    const e = entryAt.get(now);
    if (e && (e.line !== startLine || back)) return done('line');
    if (instructions >= maxInstructions) return done('limit');
  }
}

// ---- the status line -------------------------------------------------------------------------------------------

const hex4 = (n) => '$' + (n & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');

/**
 * The status line for a pause: `Paused at line N of file.arc (breakpoint)`, `(step)` or any other reason the caller names; with no `file`: `Paused at line N (reason)`;
 * with no source line (runtime code): `Paused (address $XXXX, no source line)`.
 * @param {{pc:number, line:number|null, file?:string, reason?:string}} info
 */
export function describePause({ pc, line, file, reason }) {
  if (line === null || line === undefined) return `Paused (address ${hex4(pc)}, no source line)`;
  return `Paused at line ${line}${file ? ` of ${file}` : ''}${reason ? ` (${reason})` : ''}`;
}
