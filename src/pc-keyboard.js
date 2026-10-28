/**
 * src/pc-keyboard.js — type on the TS2068 the way a PC keyboard is labelled.
 *
 * TSRun's keyboard.js maps physical keys (e.code) to the matrix, so a PC user
 * has to know the 2068's layout: `"` is SYMBOL SHIFT + P, and Shift + 8 would
 * press CAPS SHIFT + 8 (cursor right) instead of typing `(`. Here the
 * character the PC key produces (e.key) is translated to the 2068 key combo
 * that makes Leap's own decoder (kernel/io/io.asm, IO_DECODE_KEY and the
 * KEY_ASCII_TABLE* tables, 2.0.2-emu.1; unchanged in 2.1.0-emu.1) produce the same character.
 *
 * Programs are edited in CodeMirror, never in Leap's own editor, so only what
 * a running program reads is mapped: characters, ENTER, delete, the cursor
 * keys (INPUT line editing) and BREAK. Characters Leap's decoder has no key
 * for (^ [ ] { } \ | ~ `) and Ctrl/Alt/Meta combos are ignored.
 */

"use strict";

// The matrix: 8 rows of 5 keys, bit 0 first (TS2068 technical manual order).
const LAYOUT = [
  ['CS', 'Z', 'X', 'C', 'V'],
  ['A', 'S', 'D', 'F', 'G'],
  ['Q', 'W', 'E', 'R', 'T'],
  ['1', '2', '3', '4', '5'],
  ['0', '9', '8', '7', '6'],
  ['P', 'O', 'I', 'U', 'Y'],
  ['ENTER', 'L', 'K', 'J', 'H'],
  ['SPACE', 'SS', 'M', 'N', 'B'],
];

const KEY = {};
LAYOUT.forEach((row, r) => row.forEach((name, bit) => { KEY[name] = { row: r, bit }; }));

// Leap's KEY_ASCII_TABLE_SYMBOL: the character SYMBOL SHIFT + key produces.
const SYMBOLS = {
  ':': 'Z', '?': 'C', '/': 'V', '<': 'R', '>': 'T',
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
  '_': '0', ')': '9', '(': '8', "'": '7', '&': '6',
  '"': 'P', ';': 'O', '=': 'L', '+': 'K', '-': 'J',
  '.': 'M', ',': 'N', '*': 'B',
};

/** Matrix keys for one typed character, or undefined if Leap has no key for it. */
function charKeys(ch) {
  if (ch >= 'a' && ch <= 'z') return [KEY[ch.toUpperCase()]];        // Leap: plain = lowercase
  if (ch >= 'A' && ch <= 'Z') return [KEY.CS, KEY[ch]];               // CAPS SHIFT = uppercase
  if (ch >= '0' && ch <= '9') return [KEY[ch]];
  if (ch === ' ') return [KEY.SPACE];
  if (SYMBOLS[ch]) return [KEY.SS, KEY[SYMBOLS[ch]]];
  return undefined;
}

/** Matrix keys for a named (non-character) key; Leap's CAPS SHIFT combos. */
function namedKeys(e) {
  switch (e.key) {
  case 'Enter':      return [KEY.ENTER];
  case 'Backspace':
  case 'Delete':     return [KEY.CS, KEY['0']];
  case 'ArrowLeft':  return [KEY.CS, KEY['5']];
  case 'ArrowDown':  return [KEY.CS, KEY['6']];
  case 'ArrowUp':    return [KEY.CS, KEY['7']];
  case 'ArrowRight': return [KEY.CS, KEY['8']];
  case 'Escape':     return [KEY.CS, KEY.SPACE];                             // BREAK
  default:           return undefined;
  }
  // Tab is deliberately unmapped: TSRun sends CAPS SHIFT + 1, which Leap
  // decodes as delete-line.
}

/**
 * @param {Uint8Array} keyMatrix  the machine's 8 active-low rows (bits 0-4)
 */
export function createPcKeyboard(keyMatrix) {
  const held = new Map();   // e.code -> matrix keys pressed for it

  function sync() {
    keyMatrix.fill(0x1F);
    for (const keys of held.values()) {
      for (const k of keys) keyMatrix[k.row] &= ~(1 << k.bit);
    }
  }

  return {
    /** @param {KeyboardEvent} e */
    keyDown(e) {
      if (e.ctrlKey || e.altKey || e.metaKey) return;   // leave browser shortcuts alone
      const keys = e.key.length === 1 ? charKeys(e.key) : namedKeys(e);
      if (!keys) return;
      e.preventDefault();
      if (e.repeat) return;          // the ROM repeats a held key itself
      held.set(e.code, keys);        // keyed by physical key: its keyup releases it
      sync();
    },
    /** @param {KeyboardEvent} e */
    keyUp(e) {
      if (held.delete(e.code)) {
        e.preventDefault();
        sync();
      }
    },
    releaseAll() {
      held.clear();
      sync();
    },
    /** Rebuild the matrix from the keys held (after something else pressed keys). */
    sync,
  };
}
