/**
 * src/cartridge.js — pack a compiled Leap V2 program into a runtime cartridge
 * for a stock TS2068 (.dck for emulators, a flat 64 KB .bin for a cartridge
 * board). No DOM or CodeMirror, so Node can import it.
 *
 * The cartridge build of Leap (cartridge/<version>/, see its README) is an
 * LROS cartridge; the stock ROM starts it from the dock:
 *
 *   DOCK chunk 0-1  Leap HOME, cartridge build (16 KB)   ROM
 *   DOCK chunk 3    the program image (below)            ROM
 *   DOCK chunk 6    Leap EXROM, cartridge build (8 KB)   ROM
 *
 * Program image at $6000 (format 2):
 *   0   "LEAPPROG"
 *   8   format, LE16 = 2
 *   10  identity, LE16: CRC-16/CCITT of the compiling ROMs' HOME then EXROM
 *   12  bytecode length n, LE16 (1 .. 4011)
 *   14  SYM_COUNTS, 5 bytes (numbers, strings, arrays, string arrays, labels)
 *   19  n bytes of bytecode, copied to VM_CODE_BASE at start-up
 *   19+n  package length p, LE16 (0 = none, at most 1024)
 *   21+n  p bytes: the package image, copied to its window ($F400) and
 *         installed at start-up, as LOAD "NAME" EXT does
 * Format 1 (the first cartridge build) ends after the bytecode and carries
 * no package; buildProgramImage writes the format the cartridge HOME accepts.
 *
 * The cartridge refuses an image with another signature, format, identity or
 * length and shows NO PROGRAM, so bytecode from a different Leap build can
 * never run on it.
 *
 * A DCK is a 9-byte header (bank 0 = DOCK, then 8 chunk descriptors: 0 absent,
 * 2 ROM) followed by the present chunks in order (TSRun's dock.js parseDck).
 */

"use strict";

export const CHUNK = 8192;
export const IMAGE_FORMAT = 2;
export const MAX_PACKAGE = 1024;            // EXTENSION_MODULE_LIMIT - EXTENSION_MODULE_BASE
export const MAX_BYTECODE = 4011;           // V2_CODE_SIZE: $A655-$B5FF
export const SYM_COUNTS_SIZE = 5;
const MAGIC = 'LEAPPROG';
const HEADER = 19;
const DCK_BANK_DOCK = 0;
const DCK_ROM = 2;
const DCK_ABSENT = 0;

/**
 * CRC-16/CCITT (poly $1021, init $FFFF) of HOME then EXROM: the identity of
 * the ROM build whose compiler produced the bytecode.
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

/** The identity a cartridge build accepts (from its LEAPPROG signature in HOME). */
export function cartIdentity(cartHome) {
  const sig = findBytes(cartHome, MAGIC);
  if (sig < 0) throw new Error('Not a Leap cartridge HOME image (no LEAPPROG signature)');
  return cartHome[sig + 10] | (cartHome[sig + 11] << 8);
}

/** The program image format a cartridge build accepts (1: no packages, 2: packages). */
export function cartFormat(cartHome) {
  const sig = findBytes(cartHome, MAGIC);
  if (sig < 0) throw new Error('Not a Leap cartridge HOME image (no LEAPPROG signature)');
  return cartHome[sig + 8] | (cartHome[sig + 9] << 8);
}

/**
 * @param {{bytecode: Uint8Array, symCounts: Uint8Array, identity: number,
 *          pkg?: Uint8Array|null, format?: number}} p
 *   pkg: the package image the program was compiled with (format 2 only)
 * @returns {Uint8Array}  the 8 KB chunk-3 image, $FF filled
 */
export function buildProgramImage({ bytecode, symCounts, identity, pkg = null, format = IMAGE_FORMAT }) {
  if (bytecode.length < 1 || bytecode.length > MAX_BYTECODE) {
    throw new Error(`The program compiles to ${bytecode.length} bytes; a cartridge takes 1 to ${MAX_BYTECODE}`);
  }
  if (symCounts.length !== SYM_COUNTS_SIZE) throw new Error(`SYM_COUNTS must be ${SYM_COUNTS_SIZE} bytes`);
  if (format !== 1 && format !== 2) throw new Error(`Unknown program image format ${format}`);
  if (pkg && format < 2) throw new Error('This cartridge build cannot carry packages');
  if (pkg && (pkg.length < 1 || pkg.length > MAX_PACKAGE)) {
    throw new Error(`The package image is ${pkg.length} bytes; a cartridge takes 1 to ${MAX_PACKAGE}`);
  }
  const img = new Uint8Array(CHUNK).fill(0xFF);
  for (let i = 0; i < MAGIC.length; i++) img[i] = MAGIC.charCodeAt(i);
  le16(img, 8, format);
  le16(img, 10, identity);
  le16(img, 12, bytecode.length);
  img.set(symCounts, 14);
  img.set(bytecode, HEADER);
  if (format >= 2) {
    const at = HEADER + bytecode.length;
    le16(img, at, pkg ? pkg.length : 0);
    if (pkg) img.set(pkg, at + 2);
  }
  return img;
}

/**
 * @param {{home: Uint8Array, exrom: Uint8Array, program: Uint8Array}} p
 *   cartridge-build HOME (16 KB) and EXROM (8 KB), program image (8 KB)
 * @returns {{dck: Uint8Array, bin: Uint8Array}}
 */
export function buildCartridge({ home, exrom, program }) {
  if (home.length !== 2 * CHUNK || exrom.length !== CHUNK || program.length !== CHUNK) {
    throw new Error('Expected a 16 KB HOME, an 8 KB EXROM and an 8 KB program image');
  }
  if (home[1] !== 0x01) throw new Error('The HOME image has no LROS header (not a cartridge build)');
  const chunks = new Map([[0, home.subarray(0, CHUNK)], [1, home.subarray(CHUNK)], [3, program], [6, exrom]]);
  const dck = new Uint8Array(9 + chunks.size * CHUNK);
  dck[0] = DCK_BANK_DOCK;
  for (let c = 0; c < 8; c++) dck[1 + c] = chunks.has(c) ? DCK_ROM : DCK_ABSENT;
  // Flat 64 KB: the eight chunks in address order, absent ones $FF (unprogrammed).
  const bin = new Uint8Array(8 * CHUNK).fill(0xFF);
  let at = 9;
  for (const c of [...chunks.keys()].sort((a, b) => a - b)) {
    dck.set(chunks.get(c), at);
    at += CHUNK;
    bin.set(chunks.get(c), c * CHUNK);
  }
  return { dck, bin };
}

// Ports a program must not write on a cartridge: HSR (244, $F4) and DECR
// (255, $FF) page the memory, so a write can switch the cartridge's own code
// out. The TS2068 decodes them by the low byte of the port.
const PAGING_PORTS = new Set([0xF4, 0xFF]);

/**
 * OUT statements whose port is a literal 244 or 255 (low byte).
 * @param {string} text  program source
 * @returns {{line: number, port: number}[]}  1-based editor lines
 */
export function pagingWrites(text) {
  const found = [];
  text.split('\n').forEach((raw, i) => {
    const line = raw.replace(/"[^"]*"?/g, '""').replace(/\bREM\b.*$/i, '');
    for (const stmt of line.split(':')) {
      const m = /^\s*OUT\s+(\d+)\s*,/i.exec(stmt);
      if (m && PAGING_PORTS.has(Number(m[1]) & 0xFF)) found.push({ line: i + 1, port: Number(m[1]) });
    }
  });
  return found;
}

function le16(a, o, v) { a[o] = v & 0xFF; a[o + 1] = (v >> 8) & 0xFF; }

function findBytes(hay, str) {
  outer: for (let i = 0; i + str.length <= hay.length; i++) {
    for (let k = 0; k < str.length; k++) if (hay[i + k] !== str.charCodeAt(k)) continue outer;
    return i;
  }
  return -1;
}
