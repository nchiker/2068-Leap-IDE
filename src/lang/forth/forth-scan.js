/**
 * src/lang/forth/forth-scan.js — Leap-Forth source, read the way the
 * interpreter reads it, without CodeMirror (Node can import it).
 *
 * Words are separated by spaces; names are matched in upper case (the ROM
 * folds a-z). The IDE sends a program a line at a time, as typed, so every
 * comment and string ends with its line: `\` runs to the end of the line,
 * `( … )` to its `)` or the line's end, `."` and `S"` to the next `"` or the
 * line's end (LEAP_FORTH_ANSWERS.md Q1.2, Q6.2).
 *
 * Exports:
 *   lineTokens(text)      the tokens of one line, typed
 *   scanDefinitions(text) the names the program defines (:, VARIABLE, …)
 *   blockStructure(lines) definitions and control structures, for folding,
 *                         indent, Tidy and block match
 *   isNumber(token)       the ROM's number grammar
 */

"use strict";

import { FORTH_WORD_ENTRIES } from './forth-words.js';

/** Upper-case name -> manual entry. */
export const FORTH_WORDS = new Map(Object.entries(FORTH_WORD_ENTRIES));

/** Words that read the next name from the line (the manual's `"name"` stack effects). */
const READS_NAME = new Set(
  [...FORTH_WORDS].filter(([, e]) => /"name"/.test(e.stack)).map(([n]) => n));
/** Of those, the ones that define the name. */
const DEFINES = new Set(
  [...FORTH_WORDS].filter(([, e]) => e.kind === 'defining word').map(([n]) => n));

/**
 * A number as the ROM reads one (core/fpparse.asm, Leap-C's grammar):
 * [-] digits [. digits] [E|e [+|-] digits], or [-] . digits [exponent];
 * the whole token. `+5` is not a number.
 */
export function isNumber(token) {
  return /^-?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/.test(token);
}

/**
 * The tokens of one line.
 * type: 'comment' | 'string' | 'number' | 'word' (a ROM word) | 'defName' (a
 * name being defined) | 'nameRef' (a name read by ' ['] FORGET EDIT …) |
 * 'char' (after CHAR / [CHAR]) | 'name' (any other token: the program's own
 * words, or unknown). `upper` is the token in upper case; `entry` the ROM
 * word's manual entry.
 *
 * With a context `ctx` (shared by the lines of one text, from
 * `scanContext()`), the interpreter's state is followed across lines: `:` …
 * `;`, `[` … `]`. While compiling, a defining word or `'` does not read a name
 * (it will when the definition runs), and the definition becomes a defining
 * word itself (`: CONST CREATE , ;` then `5 CONST FIVE` defines FIVE). Without
 * `ctx` every such word reads the next token, as for one typed line.
 *
 * @param {string} line
 * @param {{compiling: boolean, current: string|null, definers: Set<string>}} [ctx]
 * @returns {{from: number, to: number, text: string, upper: string, type: string, entry?: object, definer?: string, unclosed?: boolean, compiling?: boolean, missingName?: boolean}[]}
 */
export function lineTokens(line, ctx = null) {
  const out = [];
  let i = 0;
  let expect = null;         // the word before wants a name: 'def' | 'ref' | 'char'
  let definer = null;
  const n = line.length;
  while (i < n) {
    while (i < n && line[i] === ' ') i++;
    if (i >= n) break;
    let j = i;
    while (j < n && line[j] !== ' ') j++;
    const text = line.slice(i, j), upper = text.toUpperCase();
    if (expect) {
      out.push({ from: i, to: j, text, upper,
        type: expect === 'def' ? 'defName' : expect === 'char' ? 'char' : 'nameRef', definer });
      if (ctx && definer === ':') { ctx.compiling = true; ctx.current = upper; }
      expect = null;
      definer = null;
      i = j;
      continue;
    }
    if (upper === '\\') {
      out.push({ from: i, to: n, text: line.slice(i), upper: '\\', type: 'comment' });
      break;
    }
    if (upper === '(') {
      const close = line.indexOf(')', j);
      const to = close < 0 ? n : close + 1;
      out.push({ from: i, to, text: line.slice(i, to), upper: '(', type: 'comment', unclosed: close < 0 });
      i = to;
      continue;
    }
    if (upper === '."' || upper === 'S"') {
      out.push({ from: i, to: j, text, upper, type: 'word', entry: FORTH_WORDS.get(upper),
        compiling: ctx ? ctx.compiling : undefined });
      // The string starts after the one space that ends the word.
      const start = Math.min(j + 1, n);
      const close = line.indexOf('"', start);
      const to = close < 0 ? n : close + 1;
      if (to > start || close >= 0) out.push({ from: j, to, text: line.slice(j, to), upper: '', type: 'string', unclosed: close < 0 });
      i = to;
      continue;
    }
    const entry = FORTH_WORDS.get(upper);
    const compiling = ctx ? ctx.compiling : undefined;
    if (entry) {
      out.push({ from: i, to: j, text, upper, type: 'word', entry, compiling });
      // While compiling, only the compile-only ones (['], [CHAR]) read now.
      const readsNow = READS_NAME.has(upper) &&
        (!ctx || !ctx.compiling || upper === ':' || entry.kind === 'compile-only word');
      if (readsNow) {
        expect = DEFINES.has(upper) ? 'def' : upper === 'CHAR' || upper === '[CHAR]' ? 'char' : 'ref';
        definer = upper;
      } else if (ctx && ctx.compiling && DEFINES.has(upper) && ctx.current) {
        ctx.definers.add(ctx.current);
      }
      if (ctx) {
        if (upper === ';') { ctx.compiling = false; ctx.current = null; }
        else if (upper === '[') ctx.compiling = false;
        else if (upper === ']') ctx.compiling = true;
      }
    } else {
      out.push({ from: i, to: j, text, upper, type: isNumber(text) ? 'number' : 'name', compiling });
      if (ctx && !ctx.compiling && ctx.definers.has(upper)) { expect = 'def'; definer = upper; }
    }
    i = j;
  }
  // A word that takes a name found none on this line (MISSING NAME, -16).
  if (expect && out.length > 0) out[out.length - 1].missingName = true;
  return out;
}

/** A fresh interpreter state for lineTokens(line, ctx) over one text. */
export function scanContext() {
  return { compiling: false, current: null, definers: new Set() };
}

/**
 * The names the program defines, in order, with their 1-based lines.
 * @returns {{name: string, kind: string, line: number, col: number}[]}  kind: the defining word
 */
export function scanDefinitions(text) {
  const out = [], ctx = scanContext();
  text.split('\n').forEach((line, i) => {
    for (const t of lineTokens(line, ctx)) {
      if (t.type === 'defName') out.push({ name: t.upper, kind: t.definer, line: i + 1, col: t.from });
    }
  });
  return out;
}

// ── Blocks ────────────────────────────────────────────────────────
// `:` … `;` (a definition may run over several lines), and inside it
// IF … [ELSE] … THEN, DO … LOOP / +LOOP, BEGIN … UNTIL, BEGIN … [WHILE] … REPEAT.

const OPENERS = { ':': ':', IF: 'IF', DO: 'DO', BEGIN: 'BEGIN' };
const MIDDLES = { ELSE: 'IF', WHILE: 'BEGIN' };
const CLOSERS = { ';': ':', THEN: 'IF', LOOP: 'DO', '+LOOP': 'DO', UNTIL: 'BEGIN', REPEAT: 'BEGIN' };

/**
 * @param {string[]} lines
 * @returns {{
 *   blocks: {kind: string, words: {line: number, from: number, to: number}[], closed: boolean}[],
 *   depth: number[],      // per line: blocks open at its start
 *   dedent: boolean[],    // the line starts with a closing or middle word
 * }}
 */
export function blockStructure(lines) {
  const blocks = [], stack = [], depth = [], dedent = [];
  lines.forEach((text, line) => {
    depth.push(stack.length);
    dedent.push(false);
    const toks = lineTokens(text).filter(t => t.type === 'word');
    const first = lineTokens(text)[0];
    toks.forEach(t => {
      const w = t.upper, at = { line, from: t.from, to: t.to };
      const lead = first && first.from === t.from;
      if (OPENERS[w]) {
        const b = { kind: OPENERS[w], words: [at], closed: false };
        blocks.push(b);
        stack.push(b);
      } else if (MIDDLES[w]) {
        const top = stack[stack.length - 1];
        if (top && top.kind === MIDDLES[w]) top.words.push(at);
        if (lead) dedent[line] = true;
      } else if (CLOSERS[w]) {
        const top = stack[stack.length - 1];
        if (top && top.kind === CLOSERS[w]) {
          top.words.push(at);
          top.closed = true;
          stack.pop();
        }
        if (lead) dedent[line] = true;
      }
    });
  });
  return { blocks, depth, dedent };
}

/** The indentation (in units) a line gets from the blocks around it. */
export function blockIndent(structure, line) {
  return Math.max(0, structure.depth[line] - (structure.dedent[line] ? 1 : 0));
}
