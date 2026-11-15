/**
 * src/lang/basic/tool-code.js — the code BASIC's UDG and Draw tabs write and read.
 *
 * Pure (no DOM, no CodeMirror; Node can import it). The profile hands these to
 * src/tools/udg.js and src/tools/draw.js as `tools.udg` and `tools.draw`; the
 * tools themselves know no language (the shape is described in
 * src/lang/profiles.js, "tools").
 *
 * Leap V2 defines UDGs with POKE (no DATA / READ): 21 characters, codes
 * 144-164, 8 bytes each at UDG_TABLE; drawing is PLOT x, y and
 * LINE x0, y0 TO x1, y1 (absolute, y counted from the top).
 */

"use strict";

const POKES_PER_LINE = 4;        // ~70 characters a line, inside Leap's 127

/** The POKE lines that define the given characters (slot indexes). */
export function udgPokes(bytes, slots, table, codeBase) {
  const lines = [];
  for (const slot of slots) {
    lines.push(`REM character ${codeBase + slot}: PRINT CHR$(${codeBase + slot})`);
    for (let row = 0; row < 8; row += POKES_PER_LINE) {
      const pokes = [];
      for (let r = row; r < row + POKES_PER_LINE; r++) pokes.push(`POKE ${table + slot * 8 + r}, ${bytes[slot * 8 + r]}`);
      lines.push(pokes.join(' : '));
    }
  }
  return lines.join('\n');
}

/**
 * POKEs of constant values into the table, found in program text.
 * @returns {Map<number, number>} table offset -> byte
 */
export function pokesInSource(text, table, size) {
  const found = new Map();
  for (const raw of text.split('\n')) {
    const line = raw.replace(/"[^"]*"?/g, '""').replace(/\bREM\b.*$/i, '');
    for (const m of line.matchAll(/\bPOKE\s+(\d+)\s*,\s*(\d+)\b/gi)) {
      const addr = Number(m[1]), value = Number(m[2]);
      if (addr >= table && addr < table + size && value <= 255) found.set(addr - table, value);
    }
  }
  return found;
}

/** Leap statements for a list of paths (each a list of [x, y]), one per line. */
export function pathsToCode(paths) {
  const lines = [];
  for (const path of paths) {
    if (path.length === 0) continue;
    if (path.length === 1) {
      lines.push(`PLOT ${path[0][0]}, ${path[0][1]}`);
      continue;
    }
    for (let i = 1; i < path.length; i++) {
      const [x0, y0] = path[i - 1], [x1, y1] = path[i];
      lines.push(`LINE ${x0}, ${y0} TO ${x1}, ${y1}`);
    }
  }
  return lines.join('\n');
}

/** The UDG tab's half of the profile (shape: src/lang/profiles.js, "tools"). */
export const basicUdgTool = {
  show: code => `CHR$(${code})`,
  hint: 'Insert POKEs adds the lines that define them to your program.',
  insert: { label: 'Insert POKEs', title: 'Add the POKE lines for this character to the program' },
  insertAll: { label: 'Insert all', title: 'Add the POKE lines for every character you have drawn' },
  load: { label: 'Load from program', title: 'Read the characters the program POKEs into the table',
    none: 'The program POKEs no user-defined characters' },
  generate: udgPokes,
  read: pokesInSource,
};

/** The Draw tab's half of the profile. */
export const basicDrawTool = {
  hint: 'Click to add points (one point = PLOT, more = LINE). Shift snaps to horizontal / vertical. ' +
    'Right-click or End path finishes a path. y counts from the top.',
  generate: pathsToCode,
};
