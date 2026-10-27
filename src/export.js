/**
 * src/export.js — TAP and DCK file builders for Leap V2 programs
 *
 * Exports window.leapExport = { buildTAP(bytes, name), buildDCK(bytes) }
 *
 * TAP format reference:
 *   - 17-byte header block (type 0x00, then type byte, filename, length, params, checksum)
 *   - Data block (type 0xFF, data bytes, checksum)
 *   Each block is prefixed with a 2-byte LE16 length.
 *
 * DCK format reference:
 *   - See ../josef-jelinek/TSRun/dock.js for chunk structure
 *   - Bundles leap-0.rom + leap-1.rom + program source into a cartridge image
 */

"use strict";

const PROG_AREA_START = 0x825A;

// ── XOR checksum ──────────────────────────────────────────────────
function xorChecksum(bytes) {
  let cs = 0;
  for (const b of bytes) cs ^= b;
  return cs;
}

// ── LE16 helper ───────────────────────────────────────────────────
function le16(n) {
  return [n & 0xFF, (n >> 8) & 0xFF];
}

// ── Build a TAP block (header block or data block) ────────────────
function tapBlock(flag, data) {
  const block = new Uint8Array(data.length + 2); // flag + data + checksum
  block[0] = flag;
  block.set(data, 1);
  block[block.length - 1] = xorChecksum(block.slice(0, -1));

  const out = new Uint8Array(block.length + 2); // 2-byte length prefix
  const len = block.length;
  out[0] = len & 0xFF;
  out[1] = (len >> 8) & 0xFF;
  out.set(block, 2);
  return out;
}

// ── Build TAP file from program source bytes ──────────────────────
/**
 * @param {Uint8Array} sourceBytes  — encoded Leap V2 source
 * @param {string}     name         — filename (max 10 chars, space-padded)
 * @returns {Uint8Array} TAP file bytes
 */
function buildTAP(sourceBytes, name = 'program') {
  // Filename: 10 bytes, space-padded
  const fname = new Uint8Array(10).fill(0x20);
  const nb = new TextEncoder().encode(name.slice(0, 10));
  fname.set(nb);

  // Header data (inside the header block, after the 0x00 flag):
  //   1  type byte: 0x03 (code)
  //  10  filename
  //   2  data length (LE16)
  //   2  param1 = PROG_AREA_START (LE16)
  //   2  param2 = 0x0001 (autostart flag for Leap V2)
  const hdrData = new Uint8Array([
    0x03,                           // type: bytes
    ...fname,                       // 10-byte filename
    ...le16(sourceBytes.length),    // data length
    ...le16(PROG_AREA_START),       // param1: load address
    ...le16(0x0001),                // param2: Leap V2 autostart
  ]);

  const headerBlock = tapBlock(0x00, hdrData);
  const dataBlock   = tapBlock(0xFF, sourceBytes);

  // Concatenate
  const tap = new Uint8Array(headerBlock.length + dataBlock.length);
  tap.set(headerBlock, 0);
  tap.set(dataBlock, headerBlock.length);
  return tap;
}

// ── Build DCK cartridge ───────────────────────────────────────────
/**
 * Builds a Warajevo .dck dock cartridge containing:
 *   - leap-0.rom (16K, HOME bank)
 *   - leap-1.rom (8K, EXROM bank)
 *   - program source injected at offset (PROG_AREA_START - 0x8000) in HOME
 *
 * TODO: verify DCK chunk format against ../josef-jelinek/TSRun/dock.js.
 * The Warajevo DCK format has 9-byte chunk headers:
 *   bank_id (1) | flags (1) | data (8192 bytes if present)
 *
 * @param {Uint8Array} sourceBytes
 * @returns {Promise<Uint8Array>} DCK file bytes
 */
async function buildDCK(sourceBytes) {
  // Load the ROM files
  const [rom0buf, rom1buf] = await Promise.all([
    fetch('leap-0.rom').then(r => r.arrayBuffer()),
    fetch('leap-1.rom').then(r => r.arrayBuffer()),
  ]);
  const rom0 = new Uint8Array(rom0buf);
  const rom1 = new Uint8Array(rom1buf);

  // Patch program source into HOME bank copy at the right offset
  const homeBank = new Uint8Array(16384);
  homeBank.set(rom0);
  // PROG_AREA_START ($825A) relative to HOME bank start ($8000) = offset 0x025A = 602
  const progOffset = PROG_AREA_START - 0x8000;
  homeBank.set(sourceBytes.slice(0, Math.min(sourceBytes.length, 16384 - progOffset)), progOffset);

  // Minimal DCK format (Warajevo):
  // Refer to dock.js for exact byte layout — this is a placeholder scaffold.
  // TODO: replace with verified chunk headers from dock.js.
  console.warn('[export] DCK builder is a scaffold — verify format against dock.js');

  // For now, return a TAP as a fallback until DCK format is confirmed
  return buildTAP(sourceBytes, 'leapdck');
}

// ── Export ────────────────────────────────────────────────────────
window.leapExport = { buildTAP, buildDCK };
