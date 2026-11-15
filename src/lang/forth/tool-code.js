/**
 * src/lang/forth/tool-code.js — the code Leap-Forth's UDG and Draw tabs write and read.
 *
 * Pure (no DOM, no CodeMirror; Node can import it). The profile hands these to
 * src/tools/udg.js and src/tools/draw.js as `tools.udg` and `tools.draw`.
 *
 * `n UDG ( n -- addr )` leaves the address of user-defined graphic n's 8
 * bytes (n 0 to 20, character code 144 + n; row 0 first, from UDG_TABLE), so a
 * program defines a character with `byte n UDG C!` for row 0 and
 * `byte n UDG r + C!` for row r. Four stores to a line (about 70 characters;
 * the prompt's line holds 128). Drawing is `x y PLOT` and `x0 y0 x1 y1 LINE`
 * (both end points drawn; x 0-255, y from the top, 0-191). Each line is
 * complete on its own, as the IDE sends a program a line at a time. That line-at-a-time sending echoes each line on
 * the screen, over the picture, so a drawing belongs in a word run after CLS (the Draw tab's hint says so).
 */

"use strict";

import { lineTokens } from './forth-scan.js';

const STORES_PER_LINE = 4;

/** The Forth lines that define the given characters (slot indexes). */
export function udgCode(bytes, slots, table, codeBase) {
  const lines = [];
  for (const slot of slots) {
    lines.push(`\\ character ${codeBase + slot}: ${codeBase + slot} EMIT`);
    for (let row = 0; row < 8; row += STORES_PER_LINE) {
      const stores = [];
      for (let r = row; r < row + STORES_PER_LINE; r++) {
        stores.push(`${bytes[slot * 8 + r]} ${slot} UDG ${r ? r + ' + ' : ''}C!`);
      }
      lines.push(stores.join('  '));
    }
  }
  return lines.join('\n');
}

/**
 * The constant stores `byte n UDG [r +] C!` of a program, found in its text (comments and strings ignored).
 * @returns {Map<number, number>} table offset -> byte
 */
export function udgStoresInSource(text, table, size) {
  const found = new Map();
  const int = t => (/^\d+$/.test(t) ? Number(t) : NaN);
  for (const line of text.split('\n')) {
    const w = lineTokens(line).filter(t => t.type !== 'comment' && t.type !== 'string').map(t => t.upper);
    for (let i = 0; i + 3 < w.length; i++) {
      if (w[i + 2] !== 'UDG') continue;
      let offset = 0, end = i + 3;
      if (w[end] !== 'C!') {
        if (w[end + 1] !== '+' || w[end + 2] !== 'C!') continue;
        offset = int(w[end]);
        end += 2;
      }
      const value = int(w[i]), slot = int(w[i + 1]);
      const at = slot * 8 + offset;
      if (value <= 255 && slot >= 0 && offset >= 0 && offset < 8 && at < size) found.set(at, value);
      i = end;
    }
  }
  return found;
}

/** Leap-Forth words for a list of paths (each a list of [x, y]), one per line. */
export function pathsToCode(paths) {
  const lines = [];
  for (const path of paths) {
    if (path.length === 0) continue;
    if (path.length === 1) {
      lines.push(`${path[0][0]} ${path[0][1]} PLOT`);
      continue;
    }
    for (let i = 1; i < path.length; i++) {
      const [x0, y0] = path[i - 1], [x1, y1] = path[i];
      lines.push(`${x0} ${y0} ${x1} ${y1} LINE`);
    }
  }
  return lines.join('\n');
}

/** The UDG tab's half of the profile (shape: src/lang/profiles.js, "tools"). */
export const forthUdgTool = {
  show: code => `${code} EMIT`,
  hint: 'Insert C! lines adds the stores that define them to your program.',
  insert: { label: 'Insert C! lines', title: 'Add the lines that store this character with C! to the program' },
  insertAll: { label: 'Insert all', title: 'Add the C! lines for every character you have drawn' },
  load: { label: 'Load from program', title: 'Read the characters the program stores with UDG and C! into the table',
    none: 'The program stores no user-defined characters with UDG and C!' },
  generate: udgCode,
  read: udgStoresInSource,
};

/** The Draw tab's half of the profile. */
export const forthDrawTool = {
  hint: 'Click to add points (one point = PLOT, more = LINE). Shift snaps to horizontal / vertical. ' +
    'Right-click or End path finishes a path. y counts from the top. ' +
    'The prompt echoes every line it is sent over the picture: put the lines in a word (: PIC … ;) and run it after CLS.',
  generate: pathsToCode,
};
