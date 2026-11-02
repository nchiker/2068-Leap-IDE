/**
 * src/lang/c/leapc-debug.js — the Leap-C debugger's view of the machine
 * (stage C4 of docs/LEAP_C_PLAN.md). No DOM or CodeMirror: Node imports it.
 *
 * Leap-C compiles to native Z80 code, so the line table is built by watching
 * the compiler (the V2 trick; LEAP_C_ANSWERS.md Q1), at:
 *   STATEMENT       every statement (nested ones, labels, case, default):
 *                   (TOK_LINE, CG_PC);
 *   DCL_AUTOINIT    initialisers of automatic objects: (TOK_LINE, CG_PC);
 *   STMT_DO.cond    the condition of a do … while: (TOK_LINE, CG_PC);
 *   CG_UNIT.found   the code moves on to the next image region (at any
 *                   instruction): (the last record's line, DE);
 * and, when the program starts (RT_RUN), every RUN_FNLINES record
 * [link][address][line] (a function's prologue and its definition line).
 * At one address the later record wins (a case and its statement, `{` and
 * its first statement). The line of an address is the last record at or
 * below it. All four points are in HOME; RT_RUN too.
 *
 * At RT_RUN the compiler's symbol table is still intact (the heap overwrites
 * it once the program runs), so the globals (the SYM_GLO chain: their names,
 * types and static addresses; include/leapc_decl.inc) and the functions'
 * names are copied then.
 *
 * Code regions $6000-$77FF, $C000-$DFFF, $E000-$F17F and $F400-$F7FF are
 * RAM, but $C000-$DFFF is the EXROM whenever the shell or an EXROM library
 * routine runs: a position counts only when its 8K chunk is paged to RAM
 * (port $F4 bit clear).
 */

"use strict";

import { decodeFloat, formatNumber } from '../basic/leap-debug.js';

// Program memory is read from RAM itself (TSRun's flat m.ram), not through the
// paging: the code regions' static data in $C000-$DFFF (RUN_FNLINES, globals)
// lies under the EXROM whenever the shell or an EXROM routine runs.
const mem = (m, a) => m.ram[a & 0xFFFF];
const r16 = (m, a) => mem(m, a) | (mem(m, a + 1) << 8);
const s16 = v => (v & 0x8000 ? v - 0x10000 : v);
const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');

// include/leapc_decl.inc
const S_LINK = 0, S_KIND = 2, S_LEN = 3, S_FLAGS = 4, S_TYPE = 5, S_VAL = 7, S_NAME = 9;
const SK_OBJ = 0x01, SK_FUNC = 0x02;
const SF_AUTO = 4, SF_PARAM = 5, SF_NOADDR = 7;
const TB = ['void', 'char', 'signed char', 'int', 'unsigned', 'float'];
const TB_SIZE = [0, 1, 1, 2, 2, 5];
const TY_NODE_H = 0x40;
const TN_PTR = 1, TN_ARRAY = 2, TN_FUNC = 3, TN_STRUCT = 4;

/** Is this address's 8K chunk RAM now (not the EXROM or a dock bank)? */
export function inRam(m, addr) {
  return !(m.portF4 & (1 << (addr >> 13)));
}

/**
 * A type handle as {text, size, show(m, addr)}, decoded while the compile
 * workspace still holds its nodes.
 */
function typeOf(m, h, depth = 0) {
  if ((h >> 8) < TY_NODE_H) {
    const base = h & 0xFF, ptr = h >> 8;
    if (ptr > 0) return { text: TB[base] + ' ' + '*'.repeat(ptr), size: 2, show: (mm, a) => `$${hex4(r16(mm, a))}` };
    const size = TB_SIZE[base] ?? 0;
    const show = {
      1: (mm, a) => { const v = mem(mm, a); return v >= 32 && v < 127 ? `${v} '${String.fromCharCode(v)}'` : String(v); },
      2: (mm, a) => { const v = mem(mm, a); return String(v & 0x80 ? v - 256 : v); },
      3: (mm, a) => String(s16(r16(mm, a))),
      4: (mm, a) => String(r16(mm, a)),
      5: (mm, a) => formatNumber(decodeFloat([0, 1, 2, 3, 4].map(i => mem(mm, a + i)))),
    }[base] ?? (() => '');
    return { text: TB[base] ?? '?', size, show };
  }
  if (depth > 8) return { text: '…', size: 0, show: () => '' };
  const kind = mem(m, h), A = r16(m, h + 3), B = r16(m, h + 5);
  if (kind === TN_PTR) return { text: typeOf(m, A, depth + 1).text + ' *', size: 2, show: (mm, a) => `$${hex4(r16(mm, a))}` };
  if (kind === TN_ARRAY) {
    const el = typeOf(m, A, depth + 1);
    return {
      text: `${el.text}[${B || ''}]`, size: el.size * B,
      show(mm, a) {
        if (el.text === 'char') {           // a string, to its end mark
          let s = '';
          for (let i = 0; i < Math.min(B || 32, 32); i++) { const c = mem(mm, a + i); if (!c) break; s += c >= 32 && c < 127 ? String.fromCharCode(c) : '·'; }
          return `"${s}"`;
        }
        if (!el.size) return `at $${hex4(a)}`;
        const n = Math.min(B, 8);
        const items = Array.from({ length: n }, (_, i) => el.show(mm, a + i * el.size));
        return `{${items.join(', ')}${B > n ? ', …' : ''}}`;
      },
    };
  }
  if (kind === TN_STRUCT) return { text: `struct (${A} bytes)`, size: A, show: (mm, a) => `at $${hex4(a)}` };
  if (kind === TN_FUNC) return { text: 'function', size: 0, show: () => '' };
  return { text: '?', size: 0, show: () => '' };
}

/** @param {object} rom  the Leap-C ROM entry (with the C4 fields) */
export function createLineTable(rom) {
  let records = [];           // {addr, line} in the order made
  let sorted = null;
  let starts = new Set();
  let lastLine = 0;
  let running = false;        // RT_RUN reached: the program's code runs
  let functions = [];         // {addr, line, name} by address
  let globals = [];           // {name, type, addr, show}

  const add = (addr, line) => {
    records.push({ addr, line });
    starts.add(addr);
    lastLine = line;
    sorted = null;
  };
  const bySorted = () => sorted ?? (sorted = records.map((r, i) => ({ ...r, i })).sort((a, b) => a.addr - b.addr || a.i - b.i));

  /** At RT_RUN: the function table and the globals, while the workspace holds them. */
  function snapshot(m) {
    const names = new Map();
    globals = [];
    for (let e = r16(m, rom.symGlo), n = 0; e && n < 1000; e = r16(m, e + S_LINK), n++) {
      const kind = mem(m, e + S_KIND), len = mem(m, e + S_LEN) & 0x1F, flags = mem(m, e + S_FLAGS);
      let name = '';
      for (let i = 0; i < len; i++) name += String.fromCharCode(mem(m, e + S_NAME + i));
      const val = r16(m, e + S_VAL);
      if (kind === SK_FUNC && val) names.set(val, name);
      if (kind === SK_OBJ && !(flags & ((1 << SF_AUTO) | (1 << SF_PARAM) | (1 << SF_NOADDR)))) {
        const t = typeOf(m, r16(m, e + S_TYPE));
        globals.push({ name, type: t.text, addr: val, show: t.show });
      }
    }
    globals.reverse();                         // the chain is newest first
    functions = [];
    for (let p = r16(m, rom.runFnlines), n = 0; p && n < 500; p = r16(m, p), n++) {
      const addr = r16(m, p + 2), line = r16(m, p + 4);
      functions.push({ addr, line, name: names.get(addr) ?? `$${hex4(addr)}` });
      add(addr, line);
    }
    functions.sort((a, b) => a.addr - b.addr);
  }

  const table = {
    reset() {
      records = []; starts = new Set(); sorted = null; lastLine = 0;
      running = false; functions = []; globals = [];
    },

    observe(m) {
      const pc = m.cpu.pc;
      if (pc >= 0x4000) return;               // every point is in HOME
      if (pc === rom.statement || pc === rom.dclAutoinit || pc === rom.stmtDoCond) {
        add(r16(m, rom.cgPc), r16(m, rom.tokLine));
      } else if (pc === rom.cgUnitFound) {
        add((m.cpu.d << 8) | m.cpu.e, lastLine);
      } else if (pc === rom.rtRun) {
        snapshot(m);
        running = true;
      }
    },

    /** A statement's code address the PC is at, while the program runs; else -1. */
    position(m) {
      const pc = m.cpu.pc;
      return running && starts.has(pc) && inRam(m, pc) ? pc : -1;
    },

    isStart: pos => starts.has(pos),

    /** 1-based store line of an address in the program's code, or -1. */
    lineOf(addr) {
      let best = null;
      for (const r of bySorted()) {
        if (r.addr > addr) break;
        best = r;
      }
      return best ? best.line : -1;
    },

    /** Code addresses of the statements on a 1-based store line. */
    breakPositions(line) {
      const at = new Map();                    // address -> the line of its later record
      for (const r of records) at.set(r.addr, r.line);
      return [...at].filter(([, l]) => l === line).map(([a]) => a);
    },

    /** The function whose code holds this address (the last prologue at or below it), or null. */
    functionAt(addr) {
      let best = null;
      for (const f of functions) { if (f.addr > addr) break; best = f; }
      return best;
    },

    get running() { return running; },
    get globals() { return globals; },
    get functions() { return functions; },
  };
  return table;
}

/** The globals with their current values: {name, type, value}. */
export function readGlobals(m, table) {
  return table.globals.map(g => ({ name: g.name, type: g.type, value: g.show(m, g.addr) }));
}

/**
 * The call stack, innermost first, from the IX frame chain (rst ENTER: the
 * caller's IX at IX, its return address at IX+2). At a function's prologue
 * (before its ENTER) the return address is still at SP and IX the caller's.
 * @param {(storeLine: number) => number} toEditorLine  1-based store line -> editor line
 * @returns {{label: string, line: number, current?: boolean}[]}
 */
export function readCallStack(m, table, toEditorLine) {
  const frames = [];
  const line = addr => { const l = table.lineOf(addr); return l > 0 ? toEditorLine(l - 1) : -1; };
  const pc = m.cpu.pc;
  const cur = table.functionAt(pc);
  if (!cur) return frames;
  frames.push({ label: `${cur.name}()`, line: line(pc), current: true });
  let ix = (m.cpu.xh << 8) | m.cpu.xl;
  let ret;
  if (pc === cur.addr) {
    ret = r16(m, m.cpu.sp);                    // before ENTER: IX is still the caller's frame
  } else {
    ret = r16(m, ix + 2);
    ix = r16(m, ix);
  }
  for (let n = 0; n < 64; n++) {
    const f = table.functionAt(ret - 1);
    if (!f || !inRam(m, ret - 1)) break;       // back in RT_RUN (HOME): main's caller
    frames.push({ label: `${f.name}()`, line: line(ret - 1) });
    if (!ix) break;
    ret = r16(m, ix + 2);
    ix = r16(m, ix);
  }
  return frames;
}
