/**
 * src/leap-lang.js — Leap V2 BASIC language mode for CodeMirror 6
 *
 * Uses CM6 StreamLanguage (simpler than a full Lezer grammar; sufficient
 * for a line-based keyword language like Leap V2).
 *
 * Keyword facts come from src/leap-keywords.js, generated from the Leap
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
import { LEAP_KEYWORD_ENTRIES } from './leap-keywords.js';

// ── Keyword classes ───────────────────────────────────────────────
// 'statement' — statements and their parts (IF, THEN, NEXT, ...)
// 'function'  — built-in functions, always written with brackets
// 'operator'  — AND, OR, NOT
// 'package'   — statements that need LOAD "NAME" EXT first
// 'command'   — typed at the ROM's prompt (RUN, SAVE, ...), not valid in a program
function classify(name, e) {
  if (e.kind === 'command' || ['ALL', 'ARRAY', 'EXT'].includes(name)) return 'command';
  if (e.package) return 'package';
  if (e.kind === 'function') return 'function';
  if (e.kind === 'operator') return 'operator';
  return 'statement';
}

export const LEAP_WORDS = new Map();
for (const [name, entry] of Object.entries(LEAP_KEYWORD_ENTRIES)) {
  // Two-word entries ("DEF FN", "EXIT FOR") lend their help to the first word;
  // the second word keeps its own entry if it has one.
  const words = name.split(' ');
  if (!LEAP_WORDS.has(words[0])) LEAP_WORDS.set(words[0], { cls: classify(name, entry), entry: name });
  for (const w of words.slice(1)) {
    if (!LEAP_WORDS.has(w)) LEAP_WORDS.set(w, { cls: classify(name, entry), entry: name });
  }
}
// FOR has its own entry; make sure it wins over "EXIT FOR".
LEAP_WORDS.set('FOR', { cls: 'statement', entry: 'FOR' });

// Familiar BASIC words that are not Leap V2 statements (language reference
// §12): at the start of a statement they are compile error 2. V2 does not
// reserve them, so `data = 1` is still a valid assignment.
export const NOT_IN_V2 = new Set([
  'LET', 'GOSUB', 'RETURN', 'DRAW', 'DATA', 'READ', 'RESTORE', 'COPY',
  'ELSEIF', 'CONTINUE', 'RANDOMIZE',
]);

/** Manual entry for a word, or null. */
export function keywordEntry(word) {
  const w = LEAP_WORDS.get(word.toUpperCase());
  return w ? { name: w.entry, cls: w.cls, ...LEAP_KEYWORD_ENTRIES[w.entry] } : null;
}

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
 * Keyword tokens on one line, as the highlighter sees them: words inside
 * strings or after REM are not keywords. The lexer restarts at each line, so
 * a line can be scanned on its own.
 *
 * @param {string} lineText
 * @returns {{from: number, to: number, text: string}[]}  offsets within the line
 */
export function keywordTokens(lineText) {
  const state = lexer.startState();
  const stream = new StringStream(lineText, 4, 2);
  const out = [];
  while (!stream.eol()) {
    stream.start = stream.pos;
    const type = lexer.token(stream, state);
    if (stream.pos === stream.start) stream.next();   // never stall
    if (CAPS_TOKENS.has(type)) {
      out.push({ from: stream.start, to: stream.pos, text: lineText.slice(stream.start, stream.pos) });
    }
  }
  return out;
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

// ── Program symbols (autocomplete, hover; Phase 7 symbol table) ───
/**
 * @param {string} text
 * @returns {{procs: Map<string, {line: number, param: string}>,
 *            fns: Map<string, {line: number, param: string}>,
 *            labels: Map<string, {line: number}>,
 *            vars: Map<string, number>}}   names as written -> first line; lines 1-based
 */
export function scanSymbols(text) {
  const procs = new Map(), fns = new Map(), labels = new Map(), vars = new Map();
  const addVar = (name, line) => { if (!vars.has(name)) vars.set(name, line); };
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/"[^"]*"?/g, '""').replace(/\bREM\b.*$/i, '');
    let m;
    if ((m = /^\s*PROC\s+([A-Za-z][A-Za-z0-9]*)\s*\(\s*([A-Za-z][A-Za-z0-9]*\$?)?/i.exec(line))) {
      procs.set(m[1], { line: i + 1, param: m[2] ?? '' });
      if (m[2]) addVar(m[2], i + 1);
    }
    for (const d of line.matchAll(/\bDEF\s+FN\s+([A-Za-z][A-Za-z0-9]*)\s*\(\s*([A-Za-z][A-Za-z0-9]*)?/gi)) {
      fns.set(d[1], { line: i + 1, param: d[2] ?? '' });
    }
    if ((m = /^\s*([A-Za-z][A-Za-z0-9]*)\s*:/.exec(line)) && !LEAP_WORDS.has(m[1].toUpperCase())) {
      labels.set(m[1], { line: i + 1 });
    }
    // Assignments (statement start), FOR, INPUT and DIM introduce variables.
    for (const a of line.matchAll(/(?:^|:)\s*([A-Za-z][A-Za-z0-9]*\$?)\s*(?:\([^)]*\))?\s*=(?!=)/g)) {
      if (!LEAP_WORDS.has(a[1].toUpperCase())) addVar(a[1], i + 1);
    }
    for (const a of line.matchAll(/\b(?:FOR|INPUT(?:\s*"[^"]*"\s*[;,])?|DIM)\s+([A-Za-z][A-Za-z0-9]*\$?)/gi)) {
      addVar(a[1], i + 1);
    }
  });
  return { procs, fns, labels, vars };
}

// ── Packages ──────────────────────────────────────────────────────

// Package statement word -> package name ("CIRCLE" -> "shapes"), from the manual.
const PACKAGE_OF = new Map();
for (const [name, e] of Object.entries(LEAP_KEYWORD_ENTRIES)) {
  if (e.package) PACKAGE_OF.set(name, e.package);
}

/** Every package the manual documents ("cbeep", "graphics", …). */
export const LEAP_PACKAGES = [...new Set(PACKAGE_OF.values())].sort();

/**
 * The packages a program needs: a package statement at the start of a
 * statement (line start or after ':'), not an assignment to a variable that
 * happens to share its name (`circle = 5`). Strings and REM text are ignored.
 *
 * @param {string} text
 * @returns {Map<string, number>}  package name -> first 1-based line using it
 */
export function packagesUsed(text) {
  const used = new Map();
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/"[^"]*"?/g, '""').replace(/\bREM\b.*$/i, '');
    for (const stmt of line.split(':')) {
      const m = /^\s*([A-Za-z][A-Za-z0-9]*)(?!\s*=)/.exec(stmt);
      const pkg = m && PACKAGE_OF.get(m[1].toUpperCase());
      if (pkg && !used.has(pkg)) used.set(pkg, i + 1);
    }
  });
  return used;
}
