/**
 * src/leap-debug.js — Leap V2 program state, read from the emulated machine.
 *
 * Pure functions over machine.bus and a ROM entry from src/leap-roms.js; no
 * DOM, so they also run under Node against TSRun's machine.js.
 *
 * Leap's bytecode carries no line numbers, so the line table is built by
 * watching the compiler: COMPILE_STATEMENT_LIST.loop is reached once per
 * statement with LEX_LINE = the source line (store record index, bit 15 a
 * pending-newline flag) and EMIT_PTR = where that statement's code begins.
 * Code is emitted in source order (PROC and DEF FN bodies inline behind a
 * skip jump), so "the last statement start at or below an address" gives the
 * line of any bytecode address. Every VM instruction starts at the opcode
 * fetch with VM_IP pointing at its opcode: VM_RUN.next (ROM entry vmNext).
 * Since 2.1 most handlers jump straight there and only taken jumps, calls and
 * waits pass VM_RUN.loop, the BREAK poll just before it; in 2.0.2 the two
 * were one place.
 *
 * Layouts (2068-Leap 2.0.2-emu.1 source; the same in 2.1.0-emu.1):
 *  - compile symbol table at SYM_BASE_V: records [len][kind][namelen][index]
 *    [name][extra], ended by len 0; kinds 0 number, 1 string, 2 array,
 *    3 string array, 4 label / PROC / DEF FN (extra: code offset LE16, defined)
 *  - numbers: RT_SYMTAB 3 bytes per slot [tag][lo][hi]; tag 0 = int16,
 *    tag 1 = float, value = its RT_FLOATTAB index (5-byte calculator format)
 *  - strings: RT_STRTAB 32 bytes per slot [len][31 chars]
 *  - arrays: pointer tables of descriptors [1][count LE16][elements]
 *  - control stack from VM_CSP up to VARS_START: frames tagged
 *    1 FOR [1][var][limit 5][step 5], 2 CALL [2][return LE16],
 *    3 PARAM [3][saved 3][saved 5]
 */

"use strict";

const TOK_EOF = 0, TOK_COLON = 3;
const OP_JMP = 6, OP_CALL = 15, OP_CALL_FN = 53, OP_PARAM_BIND = 56;
const KIND = ['number', 'string', 'number array', 'string array', 'label'];
const ARRAY_PREVIEW = 8;   // elements shown per array

const r8  = (m, a) => m.bus.read(a & 0xFFFF);
const r16 = (m, a) => r8(m, a) | (r8(m, a + 1) << 8);

// ── Line table ────────────────────────────────────────────────────

/**
 * Statement starts of the program being compiled, filled by observe() while
 * the compiler runs. Lines are store record indexes (0-based).
 */
export function createLineTable(rom) {
  const starts = new Map();      // code address -> line
  let sorted = null;

  function list() {
    if (!sorted) sorted = [...starts].map(([addr, line]) => ({ addr, line })).sort((a, b) => a.addr - b.addr);
    return sorted;
  }

  return {
    reset() { starts.clear(); sorted = null; },

    /**
     * Call before each instruction while a program compiles; records a
     * statement start when the CPU is at the compiler's statement loop.
     * Only the stored program counts (not an immediate statement).
     */
    observe(m) {
      if (m.cpu.pc !== rom.compileStmt || r8(m, rom.runIsStored) !== 1) return;
      const tok = r8(m, rom.tokType);
      if (tok === TOK_EOF || tok === TOK_COLON) return;
      // A statement that emits no code (a label, REM, ENDIF) shares its
      // address with the next one, which owns the code: the last one wins.
      starts.set(r16(m, rom.emitPtr), r16(m, rom.lexLine) & 0x7FFF);
      sorted = null;
    },

    get size() { return starts.size; },

    /** Source line of a bytecode address, or -1 before the first statement. */
    lineOf(addr) {
      const s = list();
      let lo = 0, hi = s.length - 1, found = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (s[mid].addr <= addr) { found = s[mid].line; lo = mid + 1; } else hi = mid - 1;
      }
      return found;
    },

    /** Is addr the first instruction of a statement? */
    isStart(addr) { return starts.has(addr); },

    /** The first line at or after `line` that has code (labels, REM and blank lines have none), or -1. */
    nextCodeLine(line) {
      let best = -1;
      for (const { line: l } of list()) if (l >= line && (best < 0 || l < best)) best = l;
      return best;
    },

    /**
     * Addresses where a breakpoint on `line` stops: the line's statement
     * starts, plus a PROC's entry point. A PROC line's code begins with a
     * jump over the body; calls enter 3 bytes later at PARAM_BIND.
     */
    breakAddrs(m, line) {
      const out = [];
      for (const { addr, line: l } of list()) {
        if (l !== line) continue;
        out.push(addr);
        if (r8(m, addr) === OP_JMP && r8(m, addr + 3) === OP_PARAM_BIND) out.push(addr + 3);
      }
      return out;
    },
  };
}

// ── VM position ───────────────────────────────────────────────────

/** VM_IP when the CPU is about to run a bytecode instruction, else -1. */
export function vmInstruction(m, rom) {
  if (m.cpu.pc !== rom.vmNext || r8(m, rom.vmHalted) !== 0) return -1;
  return r16(m, rom.vmIp);
}

/** Stop the VM at its next instruction, as the BREAK key does (error 66). */
export function haltVm(m, rom) {
  m.bus.write(rom.vmErrorCode, 66);
  m.bus.write(rom.vmHalted, 1);
  // Paused at the fetch (2.1): go back to the BREAK poll, which sees VM_HALTED
  // now, or the VM would run on to the next taken jump before stopping. The
  // stack is the same at both labels, since handlers end at either.
  if (m.cpu.pc === rom.vmNext) m.cpu.pc = rom.vmLoop;
}

// ── Numbers ───────────────────────────────────────────────────────

/** Sinclair 5-byte calculator format -> JS number. */
export function decodeFloat(b) {
  if (b[0] === 0) {                       // small integer: [0][sign][lo][hi][0]
    const v = b[2] | (b[3] << 8);
    return b[1] === 0xFF ? v - 0x10000 : v;
  }
  const mant = ((b[1] | 0x80) * 0x1000000 + b[2] * 0x10000 + b[3] * 0x100 + b[4]) / 0x100000000;
  const v = mant * Math.pow(2, b[0] - 128);
  return (b[1] & 0x80) ? -v : v;
}

function readFloat(m, addr) {
  return decodeFloat([0, 1, 2, 3, 4].map(i => r8(m, addr + i)));
}

/** Leap prints about 9 significant digits. */
export function formatNumber(v) {
  if (Number.isInteger(v)) return String(v);
  return String(Number(v.toPrecision(9)));
}

function readString(m, addr, max) {
  const len = Math.min(r8(m, addr), max);
  let s = '';
  for (let i = 0; i < len; i++) s += String.fromCharCode(r8(m, addr + 1 + i));
  return s;
}

// ── Symbols and variables ─────────────────────────────────────────

/** Records of the compile symbol table: {kind, index, name, extra address}. */
export function readSymbols(m, rom) {
  const out = [];
  let p = r16(m, rom.symBase);
  const end = r16(m, rom.symEnd);
  for (let guard = 0; guard < 2000 && p < end; guard++) {
    const len = r8(m, p);
    if (len === 0) break;
    const kind = r8(m, p + 1), nameLen = r8(m, p + 2), index = r8(m, p + 3);
    let name = '';
    for (let i = 0; i < nameLen; i++) name += String.fromCharCode(r8(m, p + 4 + i));
    out.push({ kind, index, name, extra: p + 4 + nameLen });
    p += len;
  }
  return out;
}

/**
 * The program's variables with their current values.
 * @returns {{name: string, type: string, value: string}[]}
 */
export function readVariables(m, rom) {
  const symtab = r16(m, rom.rtSymtab), floats = r16(m, rom.rtFloattab);
  const strs = r16(m, rom.rtStrtab);
  const arrs = r16(m, rom.rtArrPtr), sarrs = r16(m, rom.rtStrArrPtr);
  const out = [];
  for (const s of readSymbols(m, rom)) {
    if (s.kind === 0) {
      const slot = symtab + 3 * s.index;
      const tag = r8(m, slot);
      let v = r16(m, slot + 1);
      if (tag === 1) v = readFloat(m, floats + 5 * (v & 0xFF));
      else if (v >= 0x8000) v -= 0x10000;
      out.push({ name: s.name, type: 'number', value: formatNumber(v) });
    } else if (s.kind === 1) {
      out.push({ name: s.name + '$', type: 'string', value: JSON.stringify(readString(m, strs + 32 * s.index, 31)) });
    } else if (s.kind === 2 || s.kind === 3) {
      const desc = r16(m, (s.kind === 2 ? arrs : sarrs) + 2 * s.index);
      const name = s.name + (s.kind === 3 ? '$' : '') + '()';
      if (desc === 0) {
        out.push({ name, type: KIND[s.kind], value: 'not DIMmed' });
        continue;
      }
      const count = r16(m, desc + 1);
      const items = [];
      if (s.kind === 2) {
        for (let i = 0; i < Math.min(count, ARRAY_PREVIEW); i++) {
          let v = r16(m, desc + 3 + 2 * i);
          items.push(v >= 0x8000 ? v - 0x10000 : v);
        }
      } else {
        const width = r8(m, desc + 3);
        for (let i = 0; i < Math.min(count, ARRAY_PREVIEW); i++) {
          items.push(JSON.stringify(readString(m, desc + 4 + width * i, width - 1)));
        }
      }
      out.push({ name, type: `${KIND[s.kind]} (${count})`, value: items.join(', ') + (count > ARRAY_PREVIEW ? ', …' : '') });
    }
  }
  return out;
}

// ── Call stack ────────────────────────────────────────────────────

/**
 * Active PROC / FN calls and FOR loops, innermost first.
 * @param {(addr: number) => number} lineOf  bytecode address -> source line
 * @returns {{kind: 'call'|'for', name: string, line: number}[]}
 *   line: for a call, the line of the CALL; for a FOR, -1 (frames hold no line)
 */
export function readCallStack(m, rom, lineOf) {
  const labels = new Map(), numbers = new Map();
  for (const s of readSymbols(m, rom)) {
    if (s.kind === 4) labels.set(r16(m, s.extra), s.name);
    if (s.kind === 0) numbers.set(s.index, s.name);
  }
  const base = rom.vmCodeBase;
  const top = r16(m, rom.varsStart);
  const out = [];
  let p = r16(m, rom.vmCsp);
  for (let guard = 0; guard < 500 && p < top; guard++) {
    const tag = r8(m, p);
    if (tag === 1) {
      out.push({ kind: 'for', name: 'FOR ' + (numbers.get(r8(m, p + 1)) ?? '?'), line: -1 });
      p += 12;
    } else if (tag === 2) {
      const ret = r16(m, p + 1);
      const op = r8(m, ret - 3);
      const target = r16(m, ret - 2);
      const name = labels.get(target) ?? '?';
      out.push({ kind: 'call', name: (op === OP_CALL_FN ? 'FN ' : '') + name, line: lineOf(ret - 3) });
      p += 3;
    } else if (tag === 3) {
      p += 9;
    } else {
      break;   // not a frame: the stack is not in a state we understand
    }
  }
  return out;
}

export { OP_CALL };
