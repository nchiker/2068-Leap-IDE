/**
 * src/lang/keytables.js — the SYMBOL SHIFT tables of the Leap ROMs, for
 * src/pc-keyboard.js: the character SYMBOL SHIFT + key produces (each ROM's
 * KEY_ASCII_TABLE_SYMBOL in kernel/io/io.asm). Letters, digits and the CAPS
 * SHIFT combos are the same in every Leap ROM.
 */

"use strict";

/** Leap V2 BASIC (2.0.2-emu.1 and 2.1.0-emu.1): no key for ^ [ ] { } \ | ~ `. */
export const LEAP_V2_SYMBOLS = {
  ':': 'Z', '?': 'C', '/': 'V', '<': 'R', '>': 'T',
  '!': '1', '@': '2', '#': '3', '$': '4', '%': '5',
  '_': '0', ')': '9', '(': '8', "'": '7', '&': '6',
  '"': 'P', ';': 'O', '=': 'L', '+': 'K', '-': 'J',
  '.': 'M', ',': 'N', '*': 'B',
};

/**
 * Leap-C (delta D7, v1.0.0-beta.2) and 2068-Forth (v2.0): V2's table plus
 * ~ | \ { } on SS+A..G, ] [ on SS+U, Y and ^ on SS+H.
 */
export const LEAP_EXTENDED_SYMBOLS = {
  ...LEAP_V2_SYMBOLS,
  '~': 'A', '|': 'S', '\\': 'D', '{': 'F', '}': 'G',
  ']': 'U', '[': 'Y', '^': 'H',
};
