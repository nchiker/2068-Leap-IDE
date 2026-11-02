/**
 * src/lang/forth/cartridge.js — a Leap-Forth program as a DOCK cartridge for
 * a stock TS2068 (stage F8 of docs/LEAP_FORTH_PLAN.md). No DOM or
 * CodeMirror: Node imports it.
 *
 * A port of 2068-Forth's tools/forthcart.py (program_image, dck, flat_bin)
 * for the v2.0 cartridge build (make cart; the release's roms/forth_cart.dck,
 * kept in cartridge/forth/2.0/). The DCK: bank 0 (DOCK), the cartridge HOME
 * in chunks 0-1 (LROS header at $0000), the program image from chunk 2 (DOCK
 * $4000; chunk 3 too when it is over 8 KB), padded with $FF, and the EXROM
 * in chunk 5. At power-on the cartridge checks the image (signature,
 * identity, length; not the CRC), copies the dictionary to $9100 and the
 * UDGs to UDG_TABLE, sets HERE and LATEST, then runs the start word as a
 * line typed at the OK prompt.
 *
 * Program image (offsets: the cartridge build's CART_IMG_* symbols), all LE:
 *   +0    "F1" (CART_MAGIC $3146)
 *   +2    ROM_IDENTITY (also SAVE-LIB's header parameter 1)
 *   +4    n = HERE - $9100, at most 16,128 (CART_IMG_MAX)
 *   +6    LATEST
 *   +8    the start word's length (1-31), then its name, space-padded to 31
 *   +40   the UDG table, 168 bytes
 *   +208  the dictionary, n bytes
 *   +208+n  CRC-16/CCITT-FALSE of bytes +0 .. +207+n
 */

"use strict";

export const CHUNK = 0x2000;
export const CART_MAGIC = 0x3146;          // "F1"
export const IMG_UDG = 0x28;               // CART_IMG_UDG
export const IMG_DICT = 0xD0;              // CART_IMG_DICT
export const IMG_MAX = 0x3F00;             // CART_IMG_MAX: 16,128 bytes of dictionary
export const UDG_BYTES = 21 * 8;           // UDG_COUNT x 8
const IMAGE_CHUNK = 2;                     // DOCK $4000 (CART_IMAGE)
const HOME_CHUNKS = [0, 1], EXROM_CHUNK = 5;

/** CRC-16/CCITT-FALSE: polynomial $1021, initial $FFFF, no final XOR ("123456789" gives $29B1). */
export function crc16(bytes) {
  let crc = 0xFFFF;
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

/**
 * The cartridge build's HOME and EXROM from a Forth .dck with no program
 * (the release's forth_cart.dck: chunks 0, 1 and 5 as ROM).
 * @returns {{home: Uint8Array, exrom: Uint8Array}}
 */
export function cartImages(dck) {
  const present = [...dck.subarray(1, 9)].map((d, i) => (d ? i : -1)).filter(i => i >= 0);
  if (dck.length < 9 || dck[0] !== 0 || present.join() !== '0,1,5' || dck.length !== 9 + 3 * CHUNK) {
    throw new Error('Not the Forth cartridge build (a DOCK .dck with chunks 0, 1 and 5)');
  }
  return { home: dck.slice(9, 9 + 2 * CHUNK), exrom: dck.slice(9 + 2 * CHUNK) };
}

/** ROM_IDENTITY as stored in a HOME image at its symbol's address. */
export function homeIdentity(home, romIdentityAddr) {
  return home[romIdentityAddr] | (home[romIdentityAddr + 1] << 8);
}

/**
 * The name as the dictionary spells it, if `name` is one of its words (the
 * ROM's FIND matches either case), else null.
 */
export function findWord(dictionary, latest, base, name) {
  const seen = new Set();
  for (let link = latest; link >= base && link < base + dictionary.length - 2 && !seen.has(link);) {
    seen.add(link);
    const at = link - base, n = dictionary[at + 2] & 0x1F;
    const word = String.fromCharCode(...dictionary.subarray(at + 3, at + 3 + n));
    if (word.toUpperCase() === name.toUpperCase()) return word;
    link = dictionary[at] | (dictionary[at + 1] << 8);
  }
  return null;
}

/**
 * The program image, checked as the cartridge will check it.
 * @param {{dictionary: Uint8Array, latest: number, identity: number, cartIdentity: number,
 *          start: string, udg?: Uint8Array, base?: number}} p
 * @returns {Uint8Array}
 * @throws {Error} with a message for the user
 */
export function programImage({ dictionary, latest, identity, cartIdentity, start, udg = null, base = 0x9100 }) {
  if (identity !== cartIdentity) {
    throw new Error(`The program was made on other ROMs (identity $${identity.toString(16).toUpperCase()}; the cartridge's is $${cartIdentity.toString(16).toUpperCase()})`);
  }
  if (dictionary.length === 0) throw new Error('The program defines no words');
  if (dictionary.length > IMG_MAX) throw new Error(`The dictionary is ${dictionary.length} bytes; at most ${IMG_MAX} fit on the cartridge`);
  const word = findWord(dictionary, latest, base, start);
  if (word === null) throw new Error(`${start} is not one of the program's words`);
  if (word.length < 1 || word.length > 31) throw new Error('The start word must be 1 to 31 characters');
  const u = udg ?? new Uint8Array(UDG_BYTES);
  if (u.length !== UDG_BYTES) throw new Error(`The UDG table is ${u.length} bytes, not ${UDG_BYTES}`);
  const body = new Uint8Array(IMG_DICT + dictionary.length);
  const le16 = (at, v) => { body[at] = v & 0xFF; body[at + 1] = (v >> 8) & 0xFF; };
  le16(0, CART_MAGIC);
  le16(2, identity);
  le16(4, dictionary.length);
  le16(6, latest);
  body[8] = word.length;
  for (let i = 0; i < 31; i++) body[9 + i] = i < word.length ? word.charCodeAt(i) : 0x20;
  body.set(u, IMG_UDG);
  body.set(dictionary, IMG_DICT);
  const crc = crc16(body);
  const out = new Uint8Array(body.length + 2);
  out.set(body);
  out[body.length] = crc & 0xFF;
  out[body.length + 1] = crc >> 8;
  return out;
}

/** {chunk: 8 KB} of the cartridge: HOME in 0-1, the image from chunk 2, the EXROM in 5. */
function chunks(home, exrom, image) {
  const out = new Map([[HOME_CHUNKS[0], home.subarray(0, CHUNK)], [HOME_CHUNKS[1], home.subarray(CHUNK, 2 * CHUNK)], [EXROM_CHUNK, exrom]]);
  if (image) {
    const padded = new Uint8Array(Math.ceil(image.length / CHUNK) * CHUNK).fill(0xFF);
    padded.set(image);
    for (let i = 0; i < padded.length; i += CHUNK) out.set(IMAGE_CHUNK + i / CHUNK, padded.subarray(i, i + CHUNK));
  }
  return out;
}

/**
 * @param {{home: Uint8Array, exrom: Uint8Array, image: Uint8Array|null}} p
 * @returns {{dck: Uint8Array, bin: Uint8Array}}  the .dck and the flat 64 KB image ($FF where no chunk)
 */
export function buildForthCartridge({ home, exrom, image }) {
  const c = chunks(home, exrom, image);
  const order = [...c.keys()].sort((a, b) => a - b);
  const dck = new Uint8Array(9 + order.length * CHUNK);
  dck[0] = 0;                                   // bank 0: DOCK
  for (let i = 0; i < 8; i++) dck[1 + i] = c.has(i) ? 2 : 0;   // 2: ROM
  order.forEach((k, j) => dck.set(c.get(k), 9 + j * CHUNK));
  const bin = new Uint8Array(8 * CHUNK).fill(0xFF);
  for (const [k, v] of c) bin.set(v, k * CHUNK);
  return { dck, bin };
}

/** Is this .dck a Forth program cartridge ("F1" at DOCK $4000, chunk 2)? */
export function isForthCartridge(dck) {
  if (dck.length < 9 || dck[0] !== 0 || !dck[1 + IMAGE_CHUNK]) return false;
  let at = 9;
  for (let i = 0; i < IMAGE_CHUNK; i++) if (dck[1 + i]) at += CHUNK;
  return (dck[at] | (dck[at + 1] << 8)) === CART_MAGIC;
}
