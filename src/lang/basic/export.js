/**
 * src/export.js — save a Leap V2 program as a tape file (.tap).
 *
 * The layout is what Leap's own SAVE "name" writes (2068-Leap 2.0.2-emu.1 and 2.1.0-emu.1,
 * V2_SAVE -> STORAGE_SAVE -> STORAGE_SEND_BLOCK, a port of the stock
 * SA-BYTES), checked byte for byte against the ROM's SAVE:
 *
 *   header block: flag $00, then 17 bytes
 *     0      type 0 (program)
 *     1-10   name, as typed, space-padded (LOAD "name" matches exactly)
 *     11-12  length of the line store, LE16
 *     13-14  Leap's tape format word (V2_FORMAT_WORD, $8101 in 2.0.2 and 2.1) where
 *            a stock tape has its autostart line; LOAD refuses other values
 *     15-16  program length, LE16 (= length; smaller only for SAVE ... ALL)
 *   data block: flag $FF, then the line store exactly as in RAM
 *   each block ends with the XOR of its flag and bytes
 *
 * A .tap file is each block prefixed with its LE16 length. Leap's SAVE uses
 * the stock ROM pulse timings, which is what .tap assumes. V2 has no autorun:
 * after LOAD "" the user types RUN.
 */

"use strict";

const TAPE_NAME_LENGTH = 10;
const TYPE_PROGRAM = 0;
const FLAG_HEADER = 0x00;
const FLAG_DATA = 0xFF;

/**
 * A tape name Leap's SAVE would accept: printable ASCII, up to 10 characters.
 * @returns {string | null}  an error message, or null if valid
 */
export function checkTapeName(name) {
  if (name.length === 0) return 'The name is empty';
  if (name.length > TAPE_NAME_LENGTH) return `The name is longer than ${TAPE_NAME_LENGTH} characters`;
  if (/[^\x20-\x7E]/.test(name)) return 'Only printable ASCII characters can be used';
  return null;
}

/** One block as a .tap entry: [length LE16][flag][bytes][checksum]. */
function tapBlock(flag, bytes) {
  const out = new Uint8Array(bytes.length + 4);
  const blockLength = bytes.length + 2;          // flag + bytes + checksum
  out[0] = blockLength & 0xFF;
  out[1] = blockLength >> 8;
  out[2] = flag;
  out.set(bytes, 3);
  let check = flag;
  for (const b of bytes) check ^= b;
  out[out.length - 1] = check;
  return out;
}

/**
 * @param {Uint8Array} store   the line store (src/emulator.js encodeLineStore)
 * @param {string} name        tape name (see checkTapeName)
 * @param {number} formatWord  the ROM's V2_FORMAT_WORD (src/leap-roms.js tapeFormatWord)
 * @returns {Uint8Array}       a .tap image
 */
export function buildTAP(store, name, formatWord) {
  const header = new Uint8Array(17);
  header[0] = TYPE_PROGRAM;
  const padded = name.padEnd(TAPE_NAME_LENGTH, ' ');
  for (let i = 0; i < TAPE_NAME_LENGTH; i++) header[1 + i] = padded.charCodeAt(i);
  const le16 = (at, v) => { header[at] = v & 0xFF; header[at + 1] = (v >> 8) & 0xFF; };
  le16(11, store.length);
  le16(13, formatWord);
  le16(15, store.length);

  const a = tapBlock(FLAG_HEADER, header);
  const b = tapBlock(FLAG_DATA, store);
  const tap = new Uint8Array(a.length + b.length);
  tap.set(a);
  tap.set(b, a.length);
  return tap;
}
