"use strict";
// mkdck.mjs -- build a TS2068 DCK cartridge from 8 KB chunks (bank 0 = DOCK only; kinds 0 and 2 only,
// the subset every emulator and the stock ROM accept; see docs/ARCADE_HARDWARE_NOTES.md section 2).
//
//   import { buildDck } from './mkdck.mjs';
//   const dck = buildDck({ 0: chunk0Bytes, 1: chunk1Bytes, 4: ... });   // chunk index -> 8192 bytes
//
// CLI:  node mkdck.mjs OUT.dck N=FILE [N=FILE ...]   (a FILE longer than 8 KB fills consecutive chunks)

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CHUNK = 8192;

/** @param {Record<number, Uint8Array>} chunks chunk index (0-7) -> exactly 8192 bytes. */
export function buildDck(chunks) {
  const idx = Object.keys(chunks).map(Number).sort((a, b) => a - b);
  const head = new Uint8Array(9); // bank id 0, then 8 chunk kinds
  for (const c of idx) {
    if (!(c >= 0 && c < 8)) throw new Error(`bad chunk index ${c}`);
    if (chunks[c].length !== CHUNK) throw new Error(`chunk ${c} is ${chunks[c].length} bytes, not ${CHUNK}`);
    head[1 + c] = 2; // kind 2 = ROM from file
  }
  const out = new Uint8Array(9 + idx.length * CHUNK);
  out.set(head, 0);
  idx.forEach((c, k) => out.set(chunks[c], 9 + k * CHUNK));
  return out;
}

/** Slice a 64 KB memory image into the chunks listed. */
export function chunksFromImage(img, list) {
  const o = {};
  for (const c of list) o[c] = img.slice(c * CHUNK, (c + 1) * CHUNK);
  return o;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [out, ...specs] = process.argv.slice(2);
  if (!out || !specs.length) { console.error('usage: mkdck.mjs OUT.dck N=FILE ...'); process.exit(2); }
  const chunks = {};
  for (const s of specs) {
    const [n, f] = s.split('=');
    const data = readFileSync(f);
    for (let k = 0; k * CHUNK < data.length; k++) {
      const part = new Uint8Array(CHUNK).fill(0xFF);
      part.set(data.subarray(k * CHUNK, (k + 1) * CHUNK));
      chunks[Number(n) + k] = part;
    }
  }
  writeFileSync(out, buildDck(chunks));
}
