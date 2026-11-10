"use strict";
// Reference implementation of the Phase 1 benchmarks (see SPEC.md). Pure JS, no dependencies.
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const pixAddr = (x, y) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | (x >> 3); // offset from $4000

/** XOR a w-bit-wide (multiple of 8) shape given as rows of integers into the 6144-byte bitmap at pixel (x,y). */
function xorShape(bm, rows, wbits, x, y) {
  for (let r = 0; r < rows.length; r++) {
    for (let b = 0; b < wbits; b++) {
      if ((rows[r] >> (wbits - 1 - b)) & 1) {
        const px = x + b, py = y + r;
        bm[pixAddr(px, py)] ^= 0x80 >> (px & 7);
      }
    }
  }
}

export const SHAPE = Array.from({ length: 16 }, (_, r) => (r * 2663 + 4129) & 0xFFFF);
export const SPRITES = Array.from({ length: 8 }, (_, i) => ({ x0: 16 * i, y0: 8 * i + 8, dx: i + 1, dy: (i & 3) + 1 }));
export const spritePos = (s, t) => [(s.x0 + s.dx * t) % 240, (s.y0 + s.dy * t) % 176];

export function b1() {
  const bm = new Uint8Array(6144);
  for (const s of SPRITES) xorShape(bm, SHAPE, 16, ...spritePos(s, 0));
  for (let t = 1; t < 100; t++) for (const s of SPRITES) {
    xorShape(bm, SHAPE, 16, ...spritePos(s, t - 1));
    xorShape(bm, SHAPE, 16, ...spritePos(s, t));
  }
  return bm;
}

export const TILES = Array.from({ length: 16 }, (_, k) => Array.from({ length: 8 }, (_, r) => (k * 37 + r * 11 + 3) & 0xFF));
export const MAP = Array.from({ length: 24 }, (_, row) => Array.from({ length: 64 }, (_, col) => (col * 7 + row * 13 + col * row) & 15));

export function b2() {
  const bm = new Uint8Array(6144);
  // Only the last step's picture is the output; earlier steps are fully overwritten.
  const t = 31;
  for (let row = 0; row < 24; row++) for (let c = 0; c < 32; c++) {
    const tile = TILES[MAP[row][(c + t) % 64]];
    for (let r = 0; r < 8; r++) bm[pixAddr(c * 8, row * 8 + r)] = tile[r];
  }
  return bm;
}

export function b3() {
  const N = 4000, flag = new Uint8Array(N); let primes = 0;
  for (let i = 2; i < N; i++) if (!flag[i]) { primes++; for (let j = i * 2; j < N; j += i) flag[j] = 1; }
  let x = 1, s = 0;
  for (let i = 0; i < 20000; i++) { x = (x * 5 + 3) % 32768; s = (s + x) % 65536; }
  return { primes, x, s };
}

const sha = (u8) => createHash('sha256').update(u8).digest('hex');
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = { b1: sha(b1()), b2: sha(b2()), b3: b3() };
  console.log(JSON.stringify(out, null, 2));
}
