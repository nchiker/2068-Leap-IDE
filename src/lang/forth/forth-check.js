/**
 * src/lang/forth/forth-check.js — the Forth editor's static error check
 * (stage F3 of docs/LEAP_FORTH_PLAN.md). No DOM or CodeMirror: Node imports it.
 *
 * Checking a Forth program on a hidden machine would mean running it (its
 * top-level lines execute), so this check reads the text the way the
 * interpreter would, line by line as the IDE sends it (forth-scan.js), and
 * reports in the ROM's own terms:
 *
 *   - a word that is neither a ROM word, nor defined earlier in the text, nor
 *     in the live session's dictionary (UNDEFINED WORD; order matters in
 *     Forth, so this catches a use before its definition);
 *   - a compile-only word (IF, DO, ." …) outside a definition, `;` without
 *     `:`, a `:` inside a definition, a `:` still open at the end;
 *   - unbalanced IF / ELSE / THEN, DO / LOOP / +LOOP, BEGIN / WHILE / REPEAT /
 *     UNTIL, LEAVE outside a DO loop;
 *   - a `."` or `S"` string not closed on its line (the ROM reads no further
 *     than the line), and, as a warning, a `(` comment not closed on its line
 *     (the rest of the line is the comment, but it does not continue);
 *   - a word that takes a name with none after it on the line (MISSING NAME);
 *   - a number out of range (OUT OF RANGE: integers -32768 to 65535, floats up
 *     to about 1.7E38).
 *
 * Diagnostics are {line0, message, cols: {from, to}, severity}.
 */

"use strict";

import { lineTokens, scanContext, FORTH_WORDS } from './forth-scan.js';

const MAX_DIAGNOSTICS = 100;
const FLOAT_MAX = 1.70141183e38;        // the Sinclair calculator's largest number

/** Words whose name argument is a tape name, not a word. */
const TAPE_WORDS = new Set(['SAVE-TEXT', 'LOAD-TEXT', 'VERIFY-TEXT', 'SAVE-LIB', 'LOAD-LIB', 'VERIFY-LIB']);
/** Words whose name is optional (EDIT alone opens the store). */
const NAME_OPTIONAL = new Set(['EDIT']);

/** Control words: what each opens, continues or closes. */
const OPENS = { IF: 'IF', DO: 'DO', BEGIN: 'BEGIN' };
const CLOSES = { THEN: ['IF'], LOOP: ['DO'], '+LOOP': ['DO'], UNTIL: ['BEGIN'], REPEAT: ['WHILE'] };
const CLOSER_OF = { IF: 'THEN', ELSE: 'THEN', DO: 'LOOP', BEGIN: 'UNTIL or WHILE … REPEAT', WHILE: 'REPEAT' };

/** Is the number token within what the ROM reads (else OUT OF RANGE, -43)? */
export function numberInRange(token) {
  if (/^-?\d+$/.test(token)) {
    const v = Number(token);
    return v >= -32768 && v <= 65535;
  }
  return Math.abs(Number(token)) <= FLOAT_MAX;
}

/**
 * @param {string} text  the editor's text
 * @param {Set<string>} [sessionWords]  upper-case names the live session defines
 * @returns {{line0: number, message: string, cols: {from: number, to: number}, severity: string}[]}
 */
export function checkForth(text, sessionWords = new Set()) {
  const out = [];
  const add = (line0, t, message, severity = 'error') => {
    if (out.length < MAX_DIAGNOSTICS) out.push({ line0, message, cols: { from: t.from, to: t.to }, severity });
  };
  const defined = new Set();
  const ctx = scanContext();
  let colon = null;            // the open definition: {line0, tok, name}
  let control = [];            // its open control structures: {kind, line0, tok}
  // `' SAVE-TEXT CATCH NAME`: the word EXECUTE / CATCH runs reads the next
  // token itself, so that token is its argument, not a word.
  let ticked = null, skipNext = false;

  const closeColon = (line0, tok) => {
    for (const c of control) {
      add(c.line0, c.tok, `${c.kind} without ${CLOSER_OF[c.kind]} before the ; that ends ${colon.name}`);
    }
    control = [];
    colon = null;
  };

  text.split('\n').forEach((raw, line0) => {
    const line = raw.replace(/\t/g, '  ');
    for (const t of lineTokens(line, ctx)) {
      if (skipNext && t.type !== 'comment') { skipNext = false; continue; }
      const tickedNow = ticked;
      ticked = null;
      switch (t.type) {
      case 'comment':
        if (t.unclosed && t.upper === '(') {
          add(line0, t, 'This ( comment has no ) on its line: the rest of the line is the comment, and it does not continue on the next line', 'warning');
        }
        continue;
      case 'string':
        if (t.unclosed) add(line0, t, 'The string has no closing " on its line: Forth reads no further than the line');
        continue;
      case 'char':
        continue;
      case 'number':
        if (!numberInRange(t.text)) add(line0, t, `OUT OF RANGE: ${t.text} (integers are -32768 to 65535, floats up to about 1.7E38)`);
        continue;
      case 'defName':
        defined.add(t.upper);
        if (t.definer === ':') {
          colon = { line0, tok: t, name: t.upper };
          control = [];
        }
        continue;
      case 'nameRef':
        if (t.definer && TAPE_WORDS.has(t.definer)) continue;
        if (t.definer === "'" || t.definer === "[']") {
          const e = FORTH_WORDS.get(t.upper);
          if (e && /"name"/.test(e.stack)) ticked = t.upper;
        }
        if (!FORTH_WORDS.has(t.upper) && !defined.has(t.upper) && !sessionWords.has(t.upper)) {
          add(line0, t, `UNDEFINED WORD: ${t.text} (not a Forth word, not defined above, nor in the session)`);
        }
        continue;
      case 'name':
        if (!defined.has(t.upper) && !sessionWords.has(t.upper)) {
          add(line0, t, `UNDEFINED WORD: ${t.text} (not a Forth word, not defined above, nor in the session)`);
        }
        if (t.missingName) add(line0, t, `MISSING NAME: ${t.text} defines a word, and the name must follow on the same line`);
        continue;
      }
      // A ROM word.
      const w = t.upper;
      if (tickedNow && (w === 'CATCH' || w === 'EXECUTE') && !t.compiling) skipNext = true;
      if (t.missingName && !NAME_OPTIONAL.has(w)) {
        add(line0, t, `MISSING NAME: ${t.text} reads a name, and it must follow on the same line`);
      }
      if (w === ':') {
        if (t.compiling) add(line0, t, `: inside the definition of ${colon ? colon.name : 'a word'}: end it with ; first`);
        continue;
      }
      if (w === ';') {
        if (!colon) add(line0, t, '; without a : before it');
        else closeColon(line0, t);
        continue;
      }
      if (t.entry.kind === 'compile-only word' && !t.compiling) {
        add(line0, t, `${t.text} ? : ${t.text} works only inside a : definition`);
        continue;
      }
      if (!colon || !t.compiling) continue;
      if (OPENS[w]) {
        control.push({ kind: OPENS[w], line0, tok: t });
      } else if (w === 'ELSE') {
        const top = control[control.length - 1];
        if (top && top.kind === 'IF') { top.kind = 'ELSE'; top.line0 = line0; top.tok = t; }
        else add(line0, t, 'ELSE without IF');
      } else if (w === 'WHILE') {
        const top = control[control.length - 1];
        if (top && top.kind === 'BEGIN') { top.kind = 'WHILE'; top.line0 = line0; top.tok = t; }
        else add(line0, t, 'WHILE without BEGIN');
      } else if (CLOSES[w]) {
        const top = control[control.length - 1];
        const ok = top && (CLOSES[w].includes(top.kind) || (w === 'THEN' && top.kind === 'ELSE'));
        if (ok) control.pop();
        else if (top) add(line0, t, `${t.text} where ${CLOSER_OF[top.kind]} was expected (to close the ${top.kind} on line ${top.line0 + 1})`);
        else add(line0, t, `${t.text} without ${w === 'THEN' ? 'IF' : w === 'REPEAT' ? 'BEGIN … WHILE' : w === 'UNTIL' ? 'BEGIN' : 'DO'}`);
      } else if (w === 'LEAVE' && !control.some(c => c.kind === 'DO')) {
        add(line0, t, 'LEAVE outside a DO loop');
      }
    }
  });
  if (colon) {
    add(colon.line0, colon.tok, `The definition of ${colon.name} has no ; (it is still being compiled at the end)`);
  }
  return out.sort((a, b) => a.line0 - b.line0 || a.cols.from - b.cols.from);
}

/**
 * The user words of the live session: the dictionary chain from LATEST down
 * to FORTH_DICT_RAM (headers LINK(2) LENFLAGS(1) NAME; core/dict.asm).
 * @param {(addr: number) => number} read  a byte from the machine
 * @param {object} rom  the Forth ROM entry
 * @returns {Set<string>}  upper-case names
 */
export function readSessionWords(read, rom) {
  const words = new Set();
  const read16 = a => read(a) | (read(a + 1) << 8);
  let h = read16(rom.latest);
  for (let n = 0; n < 4000 && h >= rom.dictBase && h < rom.dictCeiling; n++) {
    const len = read(h + 2) & 0x1F;
    let name = '';
    for (let i = 0; i < len; i++) name += String.fromCharCode(read(h + 3 + i));
    if (len > 0) words.add(name.toUpperCase());
    const next = read16(h);
    if (next >= h) break;           // the chain only goes down
    h = next;
  }
  return words;
}
