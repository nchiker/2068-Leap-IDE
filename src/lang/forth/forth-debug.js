/**
 * src/lang/forth/forth-debug.js — the Leap-Forth debugger's view of the
 * machine (stage F4 of docs/LEAP_FORTH_PLAN.md). No DOM or CodeMirror: Node
 * imports it.
 *
 * Line table. Forth compiles as it reads, so the table is built by watching
 * the interpreter while the IDE sends a program (LEAP_FORTH_ANSWERS.md Q4):
 *  - each line goes in at EDITOR_LOOP_LIVE.enter (the driver sends the job's
 *    lines in order, so the n-th entry of a run is job line n);
 *  - at INTERPRET_NESTED.token with STATE 1, HERE is where the token's code
 *    goes: a record (HERE, the line being sent, the definition). The code of
 *    an address belongs to the last record at or below it;
 *  - a definition's code starts at COLON_XT; it gets a record on the line of
 *    the `:` (the last token read with STATE 0) when its first body token
 *    arrives, since `:` reads its name itself;
 *  - text that LOAD-TEXT or EDIT runs passes .token too, with SRC_PTR in the
 *    line store: ignored.
 * Records are only ever instruction starts: inline data (after CALL DOLIT,
 * DOFLIT, QBRANCH, BRANCH, ." / S") never gets one, so stopping at a record
 * address is always safe.
 *
 * Positions (the debugger controller's "statement" addresses): a record's
 * address while the code runs, and TOP + n when line n is sent, so lines run
 * at the prompt (outside definitions) can be stopped at and stepped too.
 */

"use strict";

import { decodeFloat, formatNumber } from '../basic/leap-debug.js';
import { lineTokens, scanContext } from './forth-scan.js';

/** Positions of lines being sent: TOP + the line's index (above any address). */
export const TOP = 0x10000;

const r16 = (m, a) => m.bus.read(a) | (m.bus.read(a + 1) << 8);
const s16 = v => (v & 0x8000 ? v - 0x10000 : v);
const hex4 = n => n.toString(16).toUpperCase().padStart(4, '0');

/**
 * Lines that run at the prompt when sent (they start outside a definition
 * and do not start one): a breakpoint there stops when the line is sent.
 * @param {string[]} lines  the job's lines
 * @returns {boolean[]}
 */
export function promptLines(lines) {
  const ctx = scanContext();
  return lines.map(line => {
    const inside = ctx.compiling;
    const toks = lineTokens(line, ctx);
    return !inside && !(toks[0] && toks[0].upper === ':');
  });
}

/** @param {object} rom  the Forth ROM entry */
export function createLineTable(rom) {
  let line = -1;              // the job line being sent
  let lines = [];             // the job's lines
  let prompt = [];            // promptLines(lines)
  let records = [];           // {addr, line, word} in the order they were made
  let colonLine = -1;         // line of the last token read with STATE 0 (a `:`)
  let lastXt = -1;
  let sorted = null;          // records by address (then order made), cached
  let starts = new Set();
  let version = 0;

  const bySorted = () => sorted ?? (sorted = records.map((r, i) => ({ ...r, i }))
    .sort((a, b) => a.addr - b.addr || a.i - b.i));
  const add = rec => {
    records.push(rec);
    starts.add(rec.addr);
    sorted = null;
    version++;
  };

  return {
    /** A new run: its job's lines (null for none). */
    reset(job = null) {
      line = -1;
      lines = job?.lines ?? [];
      prompt = promptLines(lines);
      records = [];
      starts = new Set();
      sorted = null;
      colonLine = -1;
      lastXt = -1;
      version++;
    },

    /** Changes whenever records are added (the controller then recomputes breakpoints). */
    version: () => version,

    /** Before each instruction while a run is watched. */
    observe(m) {
      const pc = m.cpu.pc;
      if (pc === rom.enterLine) { line++; return; }
      if (pc !== rom.interpToken || line < 0) return;
      const src = r16(m, rom.srcPtr);
      if (src < rom.editBuf || src > rom.editBuf + rom.editMaxLen) return;   // LOAD-TEXT / EDIT text
      if (r16(m, rom.state) === 0) { colonLine = line; return; }
      const xt = r16(m, rom.colonXt);
      if (xt !== lastXt && xt >= rom.dictBase) {
        lastXt = xt;
        add({ addr: xt, line: colonLine >= 0 ? colonLine : line, word: xt });
      }
      add({ addr: r16(m, rom.here), line, word: lastXt });
    },

    /** The position the machine is at: a record's address, TOP + line being sent, or -1. */
    position(m) {
      const pc = m.cpu.pc;
      if (pc === rom.enterLine && line >= 0) return TOP + line;
      return starts.has(pc) ? pc : -1;
    },

    /** Step stops at every position: each token's code, each line sent. */
    isStart: pos => pos >= TOP || starts.has(pos),

    /** The job line of a position or an address in recorded code, or -1. */
    lineOf(pos) {
      if (pos >= TOP) return pos - TOP;
      let best = null;
      for (const r of bySorted()) {
        if (r.addr > pos) break;
        best = r;
      }
      return best ? best.line : -1;
    },

    /**
     * Where a breakpoint on job line n stops: where each stretch of that
     * line's code starts (not at every token of it), and when the line is
     * sent if it runs at the prompt.
     */
    breakPositions(m, n) {
      const out = [];
      if (prompt[n]) out.push(TOP + n);
      let prev = null;
      for (const r of bySorted()) {
        if (r.line === n && !(prev && prev.line === n && prev.word === r.word)) out.push(r.addr);
        prev = r;
      }
      return out;
    },

    get line() { return line; },
  };
}

/**
 * The user words, newest first: {name, header, code, end, kind, value}
 * (headers LINK(2) LENFLAGS(1) NAME code; core/dict.asm). `end` is where the
 * next newer header (or HERE) starts. kind and value from the code's shape:
 * VARIABLE (CALL DOLIT addr RET, data after it: 2 bytes, 5 for FVARIABLE,
 * more for ARRAY / STRING), CONSTANT (CALL DOLIT n RET), FCONSTANT
 * (CALL DOFLIT f RET), CREATE (CALL DODOES), anything else a colon word.
 */
export function readWords(m, rom) {
  const here = r16(m, rom.here);
  const out = [];
  let h = r16(m, rom.latest), end = here;
  for (let n = 0; n < 2000 && h >= rom.dictBase && h < rom.dictCeiling && h < end; n++) {
    const len = m.bus.read(h + 2) & 0x1F;
    let name = '';
    for (let i = 0; i < len; i++) name += String.fromCharCode(m.bus.read(h + 3 + i));
    const code = h + 3 + len;
    const w = { name, header: h, code, end, kind: ':', value: `code $${hex4(code)}` };
    const call = m.bus.read(code) === 0xCD ? r16(m, code + 1) : -1;
    if (call === rom.doLit && m.bus.read(code + 5) === 0xC9) {
      const lit = r16(m, code + 3);
      const size = end - (code + 6);
      if (lit === code + 6 && size === 2) { w.kind = 'variable'; w.value = String(s16(r16(m, lit))); }
      else if (lit === code + 6 && size === 5) {
        w.kind = 'fvariable';
        w.value = formatNumber(decodeFloat([0, 1, 2, 3, 4].map(i => m.bus.read(lit + i))));
      } else if (lit === code + 6) { w.kind = 'data'; w.value = `${size} bytes at $${hex4(lit)}`; }
      else { w.kind = 'constant'; w.value = String(s16(lit)); }
    } else if (call === rom.doFLit && m.bus.read(code + 8) === 0xC9) {
      w.kind = 'fconstant';
      w.value = formatNumber(decodeFloat([0, 1, 2, 3, 4].map(i => m.bus.read(code + 3 + i))));
    } else if (call === rom.doDoes) {
      w.kind = 'created';
      w.value = `data $${hex4(code + 6)}`;
    }
    out.push(w);
    end = h;
    const next = r16(m, h);
    if (next >= h) break;
    h = next;
  }
  return out;
}

/** The word whose code holds this address, from readWords(), or null. */
export function wordAt(words, addr) {
  return words.find(w => addr >= w.code && addr < w.end) ?? null;
}

const MAX_SHOWN = 16;

/**
 * The debugger's Variables table for Forth: the data stack (top first), the
 * float stack, then the program's words with their values.
 * @returns {{name: string, type: string, value: string}[]}
 */
export function readStacksAndWords(m, rom) {
  const out = [];
  const ix = (m.cpu.xh << 8) | m.cpu.xl, iy = (m.cpu.yh << 8) | m.cpu.yl;
  const depth = (rom.dstackTop - ix) / 2;
  if (depth < 0 || !Number.isInteger(depth) || ix < rom.dstackLimit) out.push({ name: 'stack', type: 'data', value: 'outside the stack (IX)' });
  else if (depth === 0) out.push({ name: 'stack', type: 'data', value: 'empty' });
  else {
    for (let i = 0; i < Math.min(depth, MAX_SHOWN); i++) {
      const v = r16(m, ix + 2 * i);
      out.push({ name: i === 0 ? 'top' : `${i + 1}`, type: 'data', value: `${s16(v)}  $${hex4(v)}` });
    }
    if (depth > MAX_SHOWN) out.push({ name: '…', type: 'data', value: `${depth} cells in all` });
  }
  const fdepth = (rom.fstackTop - iy) / 5;
  if (fdepth > 0 && Number.isInteger(fdepth) && iy >= rom.fstackLimit) {
    for (let i = 0; i < Math.min(fdepth, MAX_SHOWN); i++) {
      out.push({ name: i === 0 ? 'F top' : `F${i + 1}`, type: 'float',
        value: formatNumber(decodeFloat([0, 1, 2, 3, 4].map(k => m.bus.read(iy + 5 * i + k)))) });
    }
  }
  for (const w of readWords(m, rom).reverse()) out.push({ name: w.name, type: w.kind, value: w.value });
  return out;
}

/**
 * The call stack, innermost first: the word the PC is in, the user words on
 * the return stack (an entry is a return address only if a CALL precedes it
 * and it lies in a user word: DO loops and CATCH frames share the stack),
 * then the line being sent.
 * @param {object} table  createLineTable()
 * @param {(jobLine: number) => number} toEditorLine  -> 1-based editor line or -1
 * @returns {{label: string, line: number, current?: boolean}[]}
 */
export function readCallStack(m, rom, table, toEditorLine) {
  const words = readWords(m, rom);
  const frames = [];
  const lineAt = addr => { const l = table.lineOf(addr); return l < 0 ? -1 : toEditorLine(l); };
  const here = wordAt(words, m.cpu.pc);
  if (here) frames.push({ label: here.name, line: lineAt(m.cpu.pc), current: true });
  for (let sp = m.cpu.sp, n = 0; n < 64 && sp < 0xFFFE; sp += 2, n++) {
    const ret = r16(m, sp);
    if (ret < 3 || m.bus.read(ret - 3) !== 0xCD) continue;
    const w = wordAt(words, ret - 3);
    if (w) frames.push({ label: w.name, line: lineAt(ret - 3) });   // the caller, at the call
  }
  if (table.line >= 0) {
    frames.push({ label: 'the line sent', line: toEditorLine(table.line), current: frames.length === 0 });
  }
  return frames;
}
