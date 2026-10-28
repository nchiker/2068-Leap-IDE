/**
 * tools/cartpack.js — build a Leap V2 runtime cartridge from compiled bytecode.
 *
 * Plain ES module, no Node or DOM APIs, so the Leap IDE can import it as is.
 * The layout is leap/include/v2_cart.inc's (see Docs/LEAP_CARTRIDGE_BUILD.md):
 *
 *   chunk 0-1  Leap HOME image, cartridge build (16 KB)   DOCK ROM
 *   chunk 3    program image (below)                       DOCK ROM
 *   chunk 6    Leap EXROM image, cartridge build (8 KB)   DOCK ROM
 *
 * Program image at $6000: "LEAPPROG", format (LE16 = 1), identity (LE16),
 * bytecode length n (LE16), SYM_COUNTS (5 bytes), n bytes of bytecode.
 */

"use strict";

export const CHUNK = 8192;
export const IMAGE_FORMAT = 1;
export const MAX_BYTECODE = 4011;           // V2_CODE_SIZE
const MAGIC = "LEAPPROG";
const HEADER = 19;

/**
 * CRC-16/CCITT (poly $1021, init $FFFF) of HOME then EXROM: the identity of
 * the ROM build whose compiler produced the bytecode (leap/tools/cart_identity.py).
 * @param {Uint8Array} home  16 KB
 * @param {Uint8Array} exrom 8 KB
 */
export function romIdentity(home, exrom) {
  let crc = 0xFFFF;
  for (const part of [home, exrom]) {
    for (const b of part) {
      crc ^= b << 8;
      for (let k = 0; k < 8; k++) crc = (crc & 0x8000 ? (crc << 1) ^ 0x1021 : crc << 1) & 0xFFFF;
    }
  }
  return crc;
}

/** The identity a cartridge build accepts (its CART_SIGNATURE in the HOME image). */
export function cartIdentity(cartHome) {
  const sig = findBytes(cartHome, MAGIC);
  if (sig < 0) throw new Error("not a Leap cartridge HOME image (no LEAPPROG signature)");
  return cartHome[sig + 10] | (cartHome[sig + 11] << 8);
}

/**
 * @param {{bytecode: Uint8Array, symCounts: Uint8Array|number[], identity: number}} p
 * @returns {Uint8Array} 8 KB chunk-3 image, $FF filled
 */
export function buildProgramImage({ bytecode, symCounts, identity }) {
  if (bytecode.length < 1 || bytecode.length > MAX_BYTECODE) {
    throw new Error(`bytecode is ${bytecode.length} bytes; the cartridge takes 1..${MAX_BYTECODE}`);
  }
  if (symCounts.length !== 5) throw new Error("symCounts must be the 5 SYM_COUNTS bytes");
  const img = new Uint8Array(CHUNK).fill(0xFF);
  for (let i = 0; i < 8; i++) img[i] = MAGIC.charCodeAt(i);
  le16(img, 8, IMAGE_FORMAT);
  le16(img, 10, identity);
  le16(img, 12, bytecode.length);
  img.set(symCounts, 14);
  img.set(bytecode, HEADER);
  return img;
}

/**
 * @param {{home: Uint8Array, exrom: Uint8Array, program: Uint8Array}} p
 *   cartridge-build HOME (16 KB) and EXROM (8 KB), program image (8 KB)
 * @returns {{dck: Uint8Array, bin: Uint8Array}}
 */
export function buildCartridge({ home, exrom, program }) {
  if (home.length !== 2 * CHUNK || exrom.length !== CHUNK || program.length !== CHUNK) {
    throw new Error("expected a 16 KB HOME, an 8 KB EXROM and an 8 KB program image");
  }
  if (home[1] !== 0x01) throw new Error("HOME image has no LROS header (not a cartridge build)");
  const chunks = { 0: home.subarray(0, CHUNK), 1: home.subarray(CHUNK), 3: program, 6: exrom };
  // DCK: one block, bank 0 (DOCK), eight descriptors (2 = ROM, 0 = absent), the ROM chunks in order.
  const present = Object.keys(chunks).map(Number);
  const dck = new Uint8Array(9 + present.length * CHUNK);
  for (let c = 0; c < 8; c++) dck[1 + c] = chunks[c] ? 2 : 0;
  present.sort((a, b) => a - b).forEach((c, i) => dck.set(chunks[c], 9 + i * CHUNK));
  // Flat 64 KB: the eight chunks in address order, absent ones $FF.
  const bin = new Uint8Array(8 * CHUNK).fill(0xFF);
  for (const c of present) bin.set(chunks[c], c * CHUNK);
  return { dck, bin };
}

function le16(a, o, v) { a[o] = v & 0xFF; a[o + 1] = (v >> 8) & 0xFF; }

function findBytes(hay, str) {
  outer: for (let i = 0; i + str.length <= hay.length; i++) {
    for (let k = 0; k < str.length; k++) if (hay[i + k] !== str.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}
