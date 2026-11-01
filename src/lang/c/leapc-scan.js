/**
 * src/lang/c/leapc-scan.js — Leap-C source read without CodeMirror (Node can
 * import it): comments and strings blanked, then the program's file-scope
 * names (functions, globals, macros, types) and brace structure.
 */

"use strict";

/**
 * The text with comments, strings and character constants replaced by spaces
 * (line breaks and lengths kept, so positions stay valid).
 */
export function blankOut(text) {
  let out = '', i = 0;
  const n = text.length;
  const blank = s => s.replace(/[^\n]/g, ' ');
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (c === '/' && d === '*') {
      const end = text.indexOf('*/', i + 2);
      const to = end < 0 ? n : end + 2;
      out += blank(text.slice(i, to));
      i = to;
    } else if (c === '/' && d === '/') {
      let to = text.indexOf('\n', i);
      if (to < 0) to = n;
      out += blank(text.slice(i, to));
      i = to;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      j = Math.min(j, n);
      const closed = text[j] === c;
      out += c + blank(text.slice(i + 1, j)) + (closed ? c : '');
      i = closed ? j + 1 : j;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

const TYPE_WORDS = 'void|char|int|short|unsigned|signed|float|double|const|static|extern|register|auto|struct\\s+\\w+|enum\\s+\\w+';
const RESERVED = new Set(('auto break case char const continue default do double else enum extern float for goto if int ' +
  'register return short signed sizeof static struct switch typedef unsigned void while').split(' '));

/**
 * @returns {{
 *   functions: {name: string, line: number, col: number}[],
 *   globals: {name: string, line: number, col: number}[],
 *   macros: {name: string, line: number, col: number}[],
 *   types: {name: string, line: number, col: number}[],
 * }}  lines 1-based, col 0-based within the line
 */
export function scanC(text) {
  const clean = blankOut(text).split('\n');
  const functions = [], globals = [], macros = [], types = [];
  let depth = 0;
  clean.forEach((line, i) => {
    const at = (re, list) => {
      for (const m of line.matchAll(re)) {
        const name = m.groups.name;
        if (!RESERVED.has(name)) list.push({ name, line: i + 1, col: m.index + m[0].lastIndexOf(name) });
      }
    };
    const pp = /^\s*#\s*define\s+(?<name>[A-Za-z_]\w*)/.exec(line);
    if (pp) macros.push({ name: pp.groups.name, line: i + 1, col: pp[0].lastIndexOf(pp.groups.name) });
    if (depth === 0 && !/^\s*#/.test(line)) {
      at(/\btypedef\b[^;]*?\b(?<name>[A-Za-z_]\w*)\s*;/g, types);
      at(/\b(?:struct|enum)\s+(?<name>[A-Za-z_]\w*)\s*\{/g, types);
      const fn = new RegExp(`^\\s*(?:(?:${TYPE_WORDS})\\s*\\**\\s*)+(?<name>[A-Za-z_]\\w*)\\s*\\(`).exec(line);
      if (fn && !/;\s*$/.test(line)) {
        functions.push({ name: fn.groups.name, line: i + 1, col: fn[0].lastIndexOf(fn.groups.name) });
      } else if (!/\btypedef\b/.test(line)) {
        const decl = new RegExp(`^\\s*(?:(?:${TYPE_WORDS})\\s+)+(?<rest>[^;{(]*)[;=\\[]`).exec(line);
        if (decl) {
          for (const v of decl.groups.rest.split(',')) {
            const m = /\**\s*([A-Za-z_]\w*)/.exec(v);
            if (m && !RESERVED.has(m[1])) globals.push({ name: m[1], line: i + 1, col: line.indexOf(m[1]) });
          }
        }
      }
    }
    for (const c of line) {
      if (c === '{') depth++;
      else if (c === '}') depth = Math.max(0, depth - 1);
    }
  });
  return { functions, globals, macros, types };
}

/**
 * Brace blocks for folding, indent, Tidy and block match.
 * @param {string[]} lines
 * @returns {{blocks: {kind: string, words: {line, from, to}[], closed: boolean}[], depth: number[], dedent: boolean[]}}
 */
export function blockStructure(lines) {
  const clean = blankOut(lines.join('\n')).split('\n');
  const blocks = [], stack = [], depth = [], dedent = [];
  clean.forEach((text, line) => {
    depth.push(stack.length);
    dedent.push(/^\s*\}/.test(text));
    for (let c = 0; c < text.length; c++) {
      if (text[c] === '{') {
        const b = { kind: '{', words: [{ line, from: c, to: c + 1 }], closed: false };
        blocks.push(b);
        stack.push(b);
      } else if (text[c] === '}' && stack.length) {
        const b = stack.pop();
        b.words.push({ line, from: c, to: c + 1 });
        b.closed = true;
      }
    }
  });
  return { blocks, depth, dedent };
}
