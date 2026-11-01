/**
 * src/lang/basic/leap-lang.js — Leap V2 BASIC language mode for CodeMirror 6
 *
 * Uses CM6 StreamLanguage (simpler than a full Lezer grammar; sufficient
 * for a line-based keyword language like Leap V2).
 *
 * Keyword facts come from leap-keywords.js (via leap-words.js), generated from the Leap
 * manual (tools/gen-leap-keywords.py), so classes, signatures and help text
 * follow the release's own documentation.
 *
 * Exports:
 *   leapLanguage   — CM6 StreamLanguage
 *   leapHighlight  — syntax highlighting for the token classes below
 *   LEAP_WORDS     — Map: upper-case word -> {cls, entry} for every keyword
 *   keywordEntry() — manual entry for a word (DEF -> "DEF FN", EXIT -> "EXIT FOR")
 *   scanSymbols()  — the program's PROCs, DEF FNs, labels and variables
 *   keywordTokens() — keyword positions on one line (editor auto-caps)
 *   packagesUsed()  — the packages a program's statements need
 */

"use strict";

import { StreamLanguage, StringStream, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags } from '@lezer/highlight';
import { LEAP_WORDS, NOT_IN_V2 } from './leap-words.js';

export { LEAP_WORDS, NOT_IN_V2, keywordEntry, scanSymbols, LEAP_PACKAGES, packagesUsed } from './leap-words.js';

// ── Lexer ─────────────────────────────────────────────────────────
// Identifiers: a letter, then letters and digits (no underscore), up to 31;
// a trailing $ makes a string name. Keywords are case-insensitive.
const IDENT = /^[A-Za-z][A-Za-z0-9]*\$?/;

const lexer = {
  name: 'leap-v2',

  startState() {
    // stmtStart: the next word begins a statement. expect: what the next
    // identifier names ('label', 'procDef', 'procUse', 'fn'), set by the
    // keyword before it.
    return { inRem: false, stmtStart: true, expect: null };
  },

  token(stream, state) {
    if (stream.sol()) {
      state.inRem = false;
      state.stmtStart = true;
      state.expect = null;
    }
    if (state.inRem) {
      stream.skipToEnd();
      return 'comment';
    }
    if (stream.eatSpace()) return null;

    // Strings: "..." with no escapes; an unclosed one runs to the end of the line.
    if (stream.eat('"')) {
      stream.skipTo('"') ? stream.next() : stream.skipToEnd();
      state.stmtStart = false;
      return 'string';
    }

    // Numbers: digits with an optional fraction; no exponent or hex in V2.
    if (stream.match(/^(\d+(\.\d*)?|\.\d+)/)) {
      state.stmtStart = false;
      return 'number';
    }

    // Label definition: `name:` at the start of a line.
    if (stream.column() === stream.indentation() && state.stmtStart) {
      const m = stream.match(/^([A-Za-z][A-Za-z0-9]*)(?=\s*:)/, false);
      if (m && !LEAP_WORDS.has(m[1].toUpperCase())) {
        stream.match(m[1]);
        return 'labelDef';
      }
    }

    if (stream.match(IDENT)) {
      const word = stream.current().toUpperCase();
      const atStart = state.stmtStart;
      const expect = state.expect;
      state.stmtStart = false;
      state.expect = null;
      const kw = LEAP_WORDS.get(word);

      if (kw) {
        switch (word) {
        case 'REM':  state.inRem = true; return 'keyword';
        case 'GOTO': state.expect = 'label'; break;
        case 'PROC': state.expect = 'procDef'; break;
        case 'CALL': state.expect = 'procUse'; break;
        case 'FN':   state.expect = 'fn'; break;
        case 'THEN':
        case 'ELSE': state.stmtStart = true; break;   // THEN GOTO label
        }
        switch (kw.cls) {
        case 'function': return 'builtin';
        case 'operator': return 'operatorKeyword';
        case 'package':  return 'packageKeyword';
        case 'command':  return 'invalid';
        default:         return 'keyword';
        }
      }
      if (expect === 'label')   return 'labelRef';
      if (expect === 'procDef') return 'procDef';
      if (expect === 'procUse' || expect === 'fn') return 'procUse';
      if (atStart && NOT_IN_V2.has(word) && !stream.match(/^\s*[=(]/, false)) return 'invalid';
      return 'variableName';
    }

    if (stream.eat(':')) {
      state.stmtStart = true;
      return 'separator';
    }
    if (stream.match(/^(<>|<=|>=|[+\-*\/=<>])/)) {
      state.stmtStart = false;
      return 'operator';
    }
    if (stream.match(/^[(),;]/)) return 'punctuation';

    stream.next();
    return null;
  },

  tokenTable: {
    builtin:         tags.standard(tags.variableName),
    operatorKeyword: tags.operatorKeyword,
    packageKeyword:  tags.moduleKeyword,
    labelDef:        tags.definition(tags.labelName),
    labelRef:        tags.labelName,
    procDef:         tags.definition(tags.function(tags.variableName)),
    procUse:         tags.function(tags.variableName),
    separator:       tags.separator,
  },

  languageData: {
    commentTokens: { line: 'REM ' },
  },
};

export const leapLanguage = StreamLanguage.define(lexer);

// Token classes the editor writes in upper case. Commands and not-in-V2 words
// ('invalid') are left as typed so their error marking stays visible.
const CAPS_TOKENS = new Set(['keyword', 'builtin', 'operatorKeyword', 'packageKeyword']);

/**
 * Every token on one line, as the highlighter sees it (spaces left out). The
 * lexer restarts at each line, so a line can be scanned on its own.
 * `atStart`: the token begins a statement (line start, after ':', THEN or ELSE).
 *
 * @param {string} lineText
 * @returns {{from: number, to: number, text: string, type: string|null, atStart: boolean}[]}
 *   offsets within the line
 */
export function lineTokens(lineText) {
  const state = lexer.startState();
  const stream = new StringStream(lineText, 4, 2);
  const out = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const atStart = state.stmtStart;
    const type = lexer.token(stream, state);
    if (stream.pos === stream.start) stream.next();   // never stall
    if (/^\s*$/.test(lineText.slice(stream.start, stream.pos))) continue;
    out.push({ from: stream.start, to: stream.pos, text: lineText.slice(stream.start, stream.pos), type, atStart });
  }
  return out;
}

/**
 * Keyword tokens on one line, as the highlighter sees them: words inside
 * strings or after REM are not keywords.
 *
 * @param {string} lineText
 * @returns {{from: number, to: number, text: string}[]}  offsets within the line
 */
export function keywordTokens(lineText) {
  return lineTokens(lineText).filter(t => CAPS_TOKENS.has(t.type));
}

// ── Names (go to definition, rename) ──────────────────────────────
// Leap names are case-insensitive; `a` and `a$` are different names. Labels,
// PROC / DEF FN names and variables are told apart by where they appear.
const NAME_KIND = {
  labelDef: 'label', labelRef: 'label',
  procDef: 'routine', procUse: 'routine',
  variableName: 'variable',
};

/**
 * The name tokens of one line.
 * @returns {{from: number, to: number, text: string, kind: 'label'|'routine'|'variable', def: boolean}[]}
 */
export function nameTokens(lineText) {
  const out = [];
  for (const t of lineTokens(lineText)) {
    const kind = NAME_KIND[t.type];
    if (kind) out.push({ from: t.from, to: t.to, text: t.text, kind, def: t.type === 'labelDef' || t.type === 'procDef' });
  }
  return out;
}

// ── Blocks: PROC … ENDP, IF … [ELSE …] ENDIF, FOR … NEXT ──────────
// Folding, auto-indent, Tidy and the matching-keyword highlight all read this.
// IF opens a block unless it is the one-line form IF cond THEN GOTO label.

const OPENERS = { PROC: 'PROC', FOR: 'FOR', IF: 'IF' };
const CLOSERS = { ENDP: 'PROC', NEXT: 'FOR', ENDIF: 'IF' };

/**
 * @param {string[]} lines  the program's lines
 * @returns {{
 *   blocks: {kind: string, words: {line: number, from: number, to: number}[], closed: boolean}[],
 *   depth: number[],      // per line (0-based index): blocks open at its start
 *   dedent: boolean[],    // the line starts with ENDP / NEXT / ENDIF / ELSE
 * }}  words: the block's keywords (opener, ELSE, closer); line 0-based, from/to within the line
 */
export function blockStructure(lines) {
  const blocks = [], stack = [], depth = [], dedent = [];
  lines.forEach((text, line) => {
    depth.push(stack.length);
    const toks = lineTokens(text);
    dedent.push(false);
    toks.forEach((t, i) => {
      if (t.type !== 'keyword') return;
      const word = t.text.toUpperCase();
      const at = { line, from: t.from, to: t.to };
      const first = i === 0 || (i === 1 && toks[0].type === 'labelDef');
      if (OPENERS[word] && t.atStart) {
        if (word === 'IF') {
          // IF cond THEN GOTO label: no block
          const then = toks.findIndex((u, k) => k > i && u.text.toUpperCase() === 'THEN');
          if (then >= 0 && toks[then + 1]?.text.toUpperCase() === 'GOTO') return;
        }
        const b = { kind: OPENERS[word], words: [at], closed: false };
        blocks.push(b);
        stack.push(b);
      } else if (word === 'ELSE') {
        const top = stack[stack.length - 1];
        if (top && top.kind === 'IF') top.words.push(at);
        if (first) dedent[line] = true;
      } else if (CLOSERS[word] && t.atStart) {
        const top = stack[stack.length - 1];
        if (top && top.kind === CLOSERS[word]) {
          top.words.push(at);
          top.closed = true;
          stack.pop();
        }
        if (first) dedent[line] = true;
      }
    });
  });
  return { blocks, depth, dedent };
}

/** The indentation (in units) a line gets from the blocks around it; labels stay at column 0. */
export function blockIndent(structure, line, lineText) {
  if (/^\s*[A-Za-z][A-Za-z0-9]*\s*:\s*$/.test(lineText) && nameTokens(lineText)[0]?.def) return 0;
  return Math.max(0, structure.depth[line] - (structure.dedent[line] ? 1 : 0));
}

// ── Highlight style: colours are ide.css variables, so they follow the theme ─
export const leapHighlight = syntaxHighlighting(
  HighlightStyle.define([
    { tag: tags.keyword,                  color: 'var(--syn-keyword)', fontWeight: '600' },
    { tag: tags.operatorKeyword,          color: 'var(--syn-keyword)' },
    { tag: tags.moduleKeyword,            color: 'var(--syn-package)', fontWeight: '600' },
    { tag: tags.standard(tags.variableName), color: 'var(--syn-builtin)' },
    { tag: tags.string,                   color: 'var(--syn-string)' },
    { tag: tags.number,                   color: 'var(--syn-number)' },
    { tag: tags.comment,                  color: 'var(--syn-comment)', fontStyle: 'italic' },
    { tag: tags.variableName,             color: 'var(--syn-var)' },
    { tag: tags.labelName,                color: 'var(--syn-label)', fontStyle: 'italic' },
    { tag: tags.function(tags.variableName), color: 'var(--syn-proc)' },
    { tag: tags.operator,                 color: 'var(--syn-op)' },
    { tag: [tags.punctuation, tags.separator], color: 'var(--syn-punct)' },
    { tag: tags.invalid,                  color: 'var(--syn-invalid)', textDecoration: 'underline wavy var(--syn-invalid)' },
  ])
);
