# Phase 1 spike: benchmark definitions (G1)

Every implementation (hand-written native Z80, Leap V2 BASIC, Leap-C) must produce exactly the output that
`reference.mjs` computes. Run `node reference.mjs` to print the expected values and SHA-256 of each bitmap.
"Bitmap" = the 6144 pixel bytes at `$4000-$57FF` (standard ZX layout); attributes are not compared.

Screen address of pixel (x,y): `$4000 | ((y&$C0)<<5) | ((y&7)<<8) | ((y&$38)<<2) | (x>>3)`, bit `$80 >> (x&7)`.
Start every benchmark from a cleared bitmap.

## B1 sprites (XOR blit, pixel aligned)
8 sprites, shape = 16x16 pixels, 16 rows of one 16-bit word: `shape[r] = (r*2663 + 4129) & $FFFF` (bit 15 = leftmost
pixel). Sprite i (0..7): start `x0 = 16*i`, `y0 = 8*i + 8`, velocity `dx = i+1`, `dy = (i&3)+1`.
Position at step t: `x = (x0 + dx*t) mod 240`, `y = (y0 + dy*t) mod 176`.
Procedure: draw (XOR) every sprite at t=0; then for t=1..99: for each sprite XOR the shape at its old position
(erase) and XOR it at the new one. Output: the final bitmap. (XOR is commutative, so the final bitmap is the XOR
of the 8 shapes at their t=99 positions.) Total: 8 x 99 x 2 + 8 = 1592 sprite blits.

## B2 tile map
16 tiles of 8x8 pixels: `tile[k][r] = (k*37 + r*11 + 3) & $FF`. Map 64 columns x 24 rows:
`map[row][col] = (col*7 + row*13 + col*row) & 15`. Step t=0..31: redraw the whole 32x24 screen, screen column c
showing map column `(c + t) mod 64`. Output: the bitmap after t=31. Total: 32 x 768 = 24576 tile draws.

## B3 number crunching
(a) Sieve of Eratosthenes over 2..3999 (flags in a byte array): count of primes.
(b) `x = 1; s = 0; repeat 20000: x = (x*5 + 3) mod 32768; s = (s + x) mod 65536`. Output: x and s.
Output: primes, x, s.

## How each result is reported
Native: store results at `$5B00` (marker `$A5` written LAST), `$5B02` primes (LE16), `$5B04` x, `$5B06` s; the bitmap
is read from RAM. BASIC / Leap-C: print or read as the existing tests do. All report **frames** (T-states / 58,688
on TSRun) from the start of the benchmark to its end, plus code size in bytes.
