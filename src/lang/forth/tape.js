/**
 * src/lang/forth/tape.js — Leap-Forth TEXT tapes (.tap): the IDE's program
 * as SAVE-TEXT writes it, and a TEXT tape read back as source (stage F5 of
 * docs/LEAP_FORTH_PLAN.md). No DOM or CodeMirror: Node imports it.
 *
 * The layout is the one 2068-Forth's SAVE-TEXT writes (core/loadtext.asm,
 * W_SAVETEXT -> STORAGE_SAVE -> STORAGE_SEND_BLOCK; tools/tape_gen_forth.py
 * in the Forth repository writes the same), checked byte for byte against the
 * ROM's SAVE-TEXT in tests/rom-checks.mjs:
 *
 *   header block: flag $00, then 17 bytes
 *     0      type 0 (TEXT)
 *     1-10   name, space-padded (LOAD-TEXT name matches it)
 *     11-12  length of the text, LE16
 *     13-14  $8000 (STORAGE_NO_AUTOSTART: parameter 1)
 *     15-16  the length again (parameter 2)
 *   data block: flag $FF, then the line store: every line ended by CR ($0D),
 *     no empty lines, without the console line that held SAVE-TEXT
 *   each block ends with the XOR of its flag and bytes
 *
 * Leap V2 BASIC tapes carry $81xx and Leap-C tapes $8C00 where Forth has
 * $8000, so the three never take each other's tapes.
 */

"use strict";

export const FORTH_TEXT_WORD = 0x8000;     // STORAGE_NO_AUTOSTART
const TAPE_NAME_LENGTH = 10;
const TYPE_TEXT = 0;
const FLAG_HEADER = 0x00;
const FLAG_DATA = 0xFF;
const CR = 0x0D;
/** LOAD-TEXT's room: STORE_LIMIT - STORE_START (include/forth_layout.inc). */
export const LOAD_TEXT_MAX = 0xF000 - 0xD000;

/** One block as a .tap entry: [length LE16][flag][bytes][checksum]. */
function tapBlock(flag, bytes) {
  const out = new Uint8Array(bytes.length + 4);
  const blockLength = bytes.length + 2;
  out[0] = blockLength & 0xFF;
  out[1] = blockLength >> 8;
  out[2] = flag;
  out.set(bytes, 3);
  let check = flag;
  for (const b of bytes) check ^= b;
  out[out.length - 1] = check;
  return out;
}

/** The lines (as sent: no empty ones) as the line store holds them, each ended by CR. */
export function textStore(lines) {
  const out = new Uint8Array(lines.reduce((n, l) => n + l.length + 1, 0));
  let p = 0;
  for (const l of lines) {
    for (let i = 0; i < l.length; i++) out[p++] = l.charCodeAt(i);
    out[p++] = CR;
  }
  return out;
}

/**
 * @param {string[]} lines  the program's lines (forth profile prepareSource)
 * @param {string} name     tape name (checkTapeName)
 * @returns {Uint8Array}    a .tap image
 */
export function buildForthTap(lines, name) {
  const store = textStore(lines);
  const header = new Uint8Array(17);
  header[0] = TYPE_TEXT;
  const padded = name.padEnd(TAPE_NAME_LENGTH, ' ');
  for (let i = 0; i < TAPE_NAME_LENGTH; i++) header[1 + i] = padded.charCodeAt(i);
  const le16 = (at, v) => { header[at] = v & 0xFF; header[at + 1] = (v >> 8) & 0xFF; };
  le16(11, store.length);
  le16(13, FORTH_TEXT_WORD);
  le16(15, store.length);
  const a = tapBlock(FLAG_HEADER, header);
  const b = tapBlock(FLAG_DATA, store);
  const tap = new Uint8Array(a.length + b.length);
  tap.set(a);
  tap.set(b, a.length);
  return tap;
}

/** The blocks of a .tap: {flag, data (without flag and checksum), ok}. */
function tapBlocks(bytes) {
  const blocks = [];
  for (let p = 0; p + 2 <= bytes.length;) {
    const len = bytes[p] | (bytes[p + 1] << 8);
    if (len < 2 || p + 2 + len > bytes.length) break;
    const block = bytes.subarray(p + 2, p + 2 + len);
    let check = 0;
    for (const b of block) check ^= b;
    blocks.push({ flag: block[0], data: block.subarray(1, len - 1), ok: check === 0 });
    p += 2 + len;
  }
  return blocks;
}

/** The first Forth TEXT header on the tape (index of its block), or -1. */
function findText(blocks) {
  return blocks.findIndex((h, i) => i + 1 < blocks.length && h.flag === FLAG_HEADER &&
    h.data.length === 17 && h.data[0] === TYPE_TEXT && (h.data[13] | (h.data[14] << 8)) === FORTH_TEXT_WORD);
}

/** Does this tape hold a Forth TEXT file? */
export function isForthTape(bytes) {
  return findText(tapBlocks(bytes)) >= 0;
}

/**
 * The first Forth TEXT file on a tape, as source text.
 * @returns {{name: string, text: string, warning: string | null}}
 * @throws {Error} with a message for the user
 */
export function forthTapeToText(bytes) {
  const blocks = tapBlocks(bytes);
  if (blocks.length === 0) throw new Error('Not a .tap file');
  const i = findText(blocks);
  if (i < 0) throw new Error('No Forth TEXT file (SAVE-TEXT) on this tape');
  const h = blocks[i], d = blocks[i + 1];
  const name = String.fromCharCode(...h.data.subarray(1, 11)).trimEnd();
  const length = h.data[11] | (h.data[12] << 8);
  if (d.flag !== FLAG_DATA || d.data.length < length) throw new Error(`The data for "${name}" is missing or short`);
  let text = '';
  for (const b of d.data.subarray(0, length)) text += b === CR ? '\n' : String.fromCharCode(b);
  if (text.length > 0 && !text.endsWith('\n')) text += '\n';
  const warning = h.ok && d.ok ? null : 'The tape has a checksum error; check the program';
  return { name, text, warning };
}
