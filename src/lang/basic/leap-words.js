/**
 * src/lang/basic/leap-words.js — Leap V2 BASIC's words and program scans,
 * without CodeMirror (Node can import it; src/lang/basic/leap-lang.js builds
 * the editor's language mode on top of it).
 *
 * Exports:
 *   LEAP_WORDS     — Map: upper-case word -> {cls, entry} for every keyword
 *   NOT_IN_V2      — familiar BASIC words that are not V2 statements
 *   keywordEntry() — manual entry for a word (DEF -> "DEF FN", EXIT -> "EXIT FOR")
 *   scanSymbols()  — the program's PROCs, DEF FNs, labels and variables
 *   LEAP_PACKAGES, packagesUsed() — the packages a program's statements need
 */

"use strict";

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
