/**
 * src/lang/c/cartridge.js — a compiled Leap-C program as a DOCK cartridge
 * for a stock TS2068 (stage C9 of docs/LEAP_C_PLAN.md). No DOM or
 * CodeMirror: Node imports it.
 *
 * A port of Leap-C 1.1.0's tools/cartpack.py (image, place, dck, flat_bin)
 * and tools/c2cart.py's region_blocks; the format is src/cart/cart.asm's
 * (docs/requests/LEAP_C_CARTRIDGE.md). The cartridge build is the release's
 * leapc-1.1.0-cartridge.zip (cartridge/c/1.1.0/): its HOME in DOCK chunks
 * 0-1, the release EXROM in chunk 6, the program image at DOCK $8000
 * (chunks 4-5), continuing at DOCK $4000 (chunk 2) past 16 KB.
 *
 * Program image (format 1), little-endian words except the CRC:
 *   +0   "LCPG"   +4 format 1   +5 identity   +7 RUN_MAIN   +9 RUN_VOID
 *   +10  IMG_LIM (16 bytes: four regions x [low][high])   +26 LIB_LOADED
 *   +27  blocks [length:2][address:2][bytes] (1-8192 bytes, inside one
 *        region), then a length of 0
 *   end  CRC-16/CCITT-FALSE of every byte before it, HIGH byte first
 */

"use strict";

export const CHUNK = 0x2000;
const SIGNATURE = [0x4C, 0x43, 0x50, 0x47];          // "LCPG"
const FORMAT = 1;
const HEADER_SIZE = 27;
const MAX_BLOCK = 0x2000;
export const MAX_IMAGE = 3 * CHUNK;                 // chunks 4-5, then 2
/** Image regions, in IMG_LIM's order: [base, end). */
export const REGIONS = [[0xC000, 0xE000], [0xE000, 0xF180], [0xF400, 0xF800], [0x6000, 0x7800]];
const LIB_REGION = 2, HIRES_REGION = 3, LIB_LOADED_ON = 0xF4;

/** CRC-16/CCITT-FALSE: polynomial $1021, initial $FFFF, MSB first, no final XOR. */
export function crc16(bytes, crc = 0xFFFF) {
  for (const b of bytes) {
    crc ^= b << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xFFFF : (crc << 1) & 0xFFFF;
  }
  return crc;
}

/** The identity a cartridge checks: CRC-16/CCITT-FALSE of the release HOME then EXROM. */
export function romIdentity(home, exrom) {
  return crc16(exrom, crc16(home));
}

/**
 * The program's blocks from the machine after the compile (c2cart.py
 * region_blocks): per region its code [base, low) and static data
 * [high, end); with a library, region 3 whole; region 4 reserved by
 * `#pragma hires` (low = high = end) up to its last non-zero byte.
 * @param {(addr: number, n: number) => Uint8Array} read  RAM itself ($C000-$DFFF whatever the paging)
 * @param {Uint8Array} lim  IMG_LIM, 16 bytes
 * @returns {[number, Uint8Array][]}
 */
export function regionBlocks(read, lim, libLoaded) {
  const blocks = [];
  REGIONS.forEach(([base, end], i) => {
    const low = lim[4 * i] | (lim[4 * i + 1] << 8), high = lim[4 * i + 2] | (lim[4 * i + 3] << 8);
    if (!(base <= low && low <= high && high <= end)) {
      throw new Error(`IMG_LIM region ${i + 1} [$${low.toString(16)}, $${high.toString(16)}) is not inside its region`);
    }
    if (i === LIB_REGION && libLoaded === LIB_LOADED_ON) {
      blocks.push([base, read(base, end - base)]);
    } else if (i === HIRES_REGION && low === end && high === end) {
      const data = read(base, end - base);
      let last = data.length - 1;
      while (last >= 0 && data[last] === 0) last--;
      if (last >= 0) blocks.push([base, data.subarray(0, last + 1)]);
    } else {
      if (low > base) blocks.push([base, read(base, low - base)]);
      if (end > high) blocks.push([high, read(high, end - high)]);
    }
  });
  return blocks;
}

/**
 * @param {{runMain: number, runVoid: number, imgLim: Uint8Array, libLoaded: number,
 *          blocks: [number, Uint8Array][], identity: number}} p
 * @returns {Uint8Array}
 * @throws {Error} with a message for the user
 */
export function programImage({ runMain, runVoid, imgLim, libLoaded, blocks, identity }) {
  if (imgLim.length !== 16) throw new Error(`IMG_LIM is ${imgLim.length} bytes, not 16`);
  const parts = [...SIGNATURE, FORMAT, identity & 0xFF, identity >> 8, runMain & 0xFF, runMain >> 8, runVoid,
    ...imgLim, libLoaded];
  for (const [addr, data] of blocks) {
    if (data.length === 0) throw new Error(`An empty block at $${addr.toString(16)}`);
    if (data.length > MAX_BLOCK) throw new Error(`A block at $${addr.toString(16)} is over ${MAX_BLOCK} bytes`);
    if (!REGIONS.some(([lo, hi]) => lo <= addr && addr + data.length <= hi)) {
      throw new Error(`A block at $${addr.toString(16)} is outside the image regions`);
    }
    parts.push(data.length & 0xFF, data.length >> 8, addr & 0xFF, addr >> 8, ...data);
  }
  parts.push(0, 0);
  const crc = crc16(parts);
  parts.push(crc >> 8, crc & 0xFF);
  if (parts.length > MAX_IMAGE) throw new Error(`The program image is ${parts.length} bytes; at most ${MAX_IMAGE} fit on the cartridge`);
  return Uint8Array.from(parts);
}

/** {DOCK chunk: 8 KB}: HOME in 0-1, the EXROM in 6, the image at 4-5 then 2, $FF-padded. */
function chunks(home, exrom, image) {
  const out = new Map([[0, home.subarray(0, CHUNK)], [1, home.subarray(CHUNK, 2 * CHUNK)], [6, exrom]]);
  const piece = (from, to) => { const c = new Uint8Array(CHUNK).fill(0xFF); c.set(image.subarray(from, Math.min(to, image.length))); return c; };
  out.set(4, piece(0, CHUNK));
  out.set(5, piece(CHUNK, 2 * CHUNK));
  if (image.length > 2 * CHUNK) out.set(2, piece(2 * CHUNK, 3 * CHUNK));
  return out;
}

/** @returns {{dck: Uint8Array, bin: Uint8Array}}  the .dck (as 2068-Forth's) and the flat 64 KB image */
export function buildCartridge({ home, exrom, image }) {
  if (home.length !== 2 * CHUNK || exrom.length !== CHUNK) throw new Error('The cartridge HOME must be 16384 bytes and the EXROM 8192');
  const c = chunks(home, exrom, image);
  const order = [...c.keys()].sort((a, b) => a - b);
  const dck = new Uint8Array(9 + order.length * CHUNK);
  for (let i = 0; i < 8; i++) dck[1 + i] = c.has(i) ? 2 : 0;
  order.forEach((k, j) => dck.set(c.get(k), 9 + j * CHUNK));
  const bin = new Uint8Array(8 * CHUNK).fill(0xFF);
  for (const [k, v] of c) bin.set(v, k * CHUNK);
  return { dck, bin };
}

/** Is this .dck a Leap-C program cartridge ("LCPG" at DOCK $8000)? */
export function isLeapcCartridge(dck) {
  if (dck.length < 9 || dck[0] !== 0 || !dck[1 + 4]) return false;
  let at = 9;
  for (let i = 0; i < 4; i++) if (dck[1 + i]) at += CHUNK;
  return SIGNATURE.every((b, i) => dck[at + i] === b);
}
