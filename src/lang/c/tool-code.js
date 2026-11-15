/**
 * src/lang/c/tool-code.js — the code Leap-C's UDG and Draw tabs write and read.
 *
 * Pure (no DOM, no CodeMirror; Node can import it). The profile hands these to
 * src/tools/udg.js and src/tools/draw.js as `tools.udg` and `tools.draw`.
 *
 * Leap-C has no POKE statement: a program writes the 21 user-defined
 * characters (codes 144-164, 8 bytes each at UDG_TABLE, `$F180`) through a
 * pointer, with `memcpy((char *)0xF180, face, 8)` as manual Part 7 example 13
 * does. The tool inserts at the cursor, which is inside a function, so it
 * cannot add the example's global `char face[8]`; it gives `memcpy` the bytes
 * as a string literal of `\xhh` escapes instead (eight bytes are copied
 * whatever they are, a 0 included). "Load from program" reads that form back
 * and the manual's own (a `memcpy` from a named `char` array with an
 * initialiser list). Drawing is `plot(x, y);` and `draw(x0, y0, x1, y1);`
 * (both end points drawn; y from the top, 0-191).
 */

"use strict";

const hex2 = v => v.toString(16).toUpperCase().padStart(2, '0');

/** The C lines that define the given characters (slot indexes), one `memcpy` each. */
export function udgCode(bytes, slots, table, codeBase) {
  const lines = [];
  for (const slot of slots) {
    const at = table + slot * 8;
    const text = Array.from({ length: 8 }, (_, r) => '\\x' + hex2(bytes[slot * 8 + r])).join('');
    lines.push(`// character ${codeBase + slot}: putchar(${codeBase + slot});`);
    lines.push(`memcpy((char *)0x${at.toString(16).toUpperCase()}, "${text}", 8);`);
  }
  return lines.join('\n');
}

/** The text with comments and the insides of character constants blanked, strings kept. */
function stripComments(text) {
  let out = '', i = 0;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; }
    else if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; out += ' '; }
    else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < text.length && text[j] !== c && text[j] !== '\n') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1); i = j + 1;
    } else { out += c; i++; }
  }
  return out;
}

const SIMPLE_ESCAPES = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, '\\': 92, "'": 39, '"': 34 };

/** The bytes of a C string literal's body (escapes decoded), or null if an escape is not one Leap-C has. */
function decodeString(body) {
  const out = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { out.push(body.charCodeAt(i) & 0xFF); continue; }
    const e = body[++i];
    if (e === 'x') {
      const h = /^[0-9a-fA-F]+/.exec(body.slice(i + 1));
      if (!h) return null;
      out.push(parseInt(h[0], 16) & 0xFF); i += h[0].length;
    } else if (/[0-7]/.test(e ?? '')) {
      const o = /^[0-7]{1,3}/.exec(body.slice(i))[0];
      out.push(parseInt(o, 8) & 0xFF); i += o.length - 1;
    } else if (e in SIMPLE_ESCAPES) out.push(SIMPLE_ESCAPES[e]);
    else return null;
  }
  return out;
}

const number = s => (/^0x/i.test(s) ? parseInt(s, 16) : Number(s));

/**
 * The bytes a program copies into the UDG table with `memcpy((char *)ADDR, SOURCE, N)`, where SOURCE is a string
 * literal or a global `char` array with an initialiser list (a number, or a `'c'` constant).
 * @returns {Map<number, number>} table offset -> byte
 */
export function memcpyInSource(text, table, size) {
  const code = stripComments(text);
  const arrays = new Map();
  for (const m of code.matchAll(/\b(?:unsigned\s+)?char\s+(\w+)\s*\[[^\]]*\]\s*=\s*\{([^}]*)\}/g)) {
    const items = m[2].split(',').map(s => s.trim()).filter(Boolean)
      .map(s => (/^'.*'$/.test(s) ? decodeString(s.slice(1, -1))?.[0] : /^(0x[0-9a-f]+|\d+)$/i.test(s) ? number(s) & 0xFF : undefined));
    if (items.every(v => v !== undefined)) arrays.set(m[1], items);
  }
  const found = new Map();
  const call = /\bmemcpy\s*\(\s*\(\s*(?:unsigned\s+)?char\s*\*\s*\)\s*(0x[0-9a-f]+|\d+)\s*,\s*("(?:[^"\\\n]|\\.)*"|\w+)\s*,\s*(0x[0-9a-f]+|\d+)\s*\)/gi;
  for (const m of code.matchAll(call)) {
    const addr = number(m[1]), n = number(m[3]);
    const src = m[2][0] === '"' ? decodeString(m[2].slice(1, -1)) : arrays.get(m[2]);
    if (!src) continue;
    for (let i = 0; i < n && i < src.length; i++) {
      if (addr + i >= table && addr + i < table + size) found.set(addr + i - table, src[i]);
    }
  }
  return found;
}

/** Leap-C statements for a list of paths (each a list of [x, y]), one per line. */
export function pathsToCode(paths) {
  const lines = [];
  for (const path of paths) {
    if (path.length === 0) continue;
    if (path.length === 1) {
      lines.push(`plot(${path[0][0]}, ${path[0][1]});`);
      continue;
    }
    for (let i = 1; i < path.length; i++) {
      const [x0, y0] = path[i - 1], [x1, y1] = path[i];
      lines.push(`draw(${x0}, ${y0}, ${x1}, ${y1});`);
    }
  }
  return lines.join('\n');
}

/** The UDG tab's half of the profile (shape: src/lang/profiles.js, "tools"). */
export const leapcUdgTool = {
  show: code => `putchar(${code})`,
  hint: 'Insert memcpy adds the statements that define them (inside a function, such as main).',
  insert: { label: 'Insert memcpy', title: 'Add the memcpy statement for this character to the program' },
  insertAll: { label: 'Insert all', title: 'Add the memcpy statements for every character you have drawn' },
  load: { label: 'Load from program', title: 'Read the characters the program copies into the UDG table with memcpy',
    none: 'The program copies no user-defined characters with memcpy' },
  generate: udgCode,
  read: memcpyInSource,
};

/** The Draw tab's half of the profile. */
export const leapcDrawTool = {
  hint: 'Click to add points (one point = plot, more = draw). Shift snaps to horizontal / vertical. ' +
    'Right-click or End path finishes a path. y counts from the top. Insert it inside a function, such as main.',
  generate: pathsToCode,
};
