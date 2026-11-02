/**
 * src/lang/spin-demo.js — "Spinning squares", one program written in all three
 * languages, to compare their speed. Each profile appends its version to its
 * Examples menu (the generated C and Forth lists stay untouched).
 *
 * The same task everywhere: 18 frames of 12 squares turning, 48 lines a frame,
 * with the corners from an integer sine table (72 entries, 5 degrees apart,
 * 64 = 1) and r * (s + 64) / 64 - r, so no language divides a negative number
 * and all three draw exactly the same picture (tests/rom-checks.mjs compares
 * them). Each times the animation with its frame counter and prints the frames
 * it took: BASIC PEEKs Leap's FRAMES ($8175), C calls frames(), Forth fetches
 * FRAMES ($80F4).
 *
 * No DOM or CodeMirror, so Node can import it.
 */

"use strict";

const ABOUT = 'The same drawing in Leap BASIC, Leap-C and Leap-Forth: run each and compare the frames it takes';

/** @type {Object<string, {id: string, title: string, about: string, text: string}>} */
export const SPIN_DEMO = {
  basic: { id: 'spin', title: 'Spinning squares (speed test)', about: ABOUT, text: `REM Spinning squares: the same task in Leap BASIC, Leap-C and
REM Leap-Forth (each language's Examples menu), to compare speed.
REM 18 frames of 12 squares turning, 48 LINEs a frame, from an
REM integer sine table (64 = 1). The time is Leap's frame counter.
DIM s(72)
REM SIN takes degrees; INT cuts toward zero, so round a positive
FOR k = 0 TO 71
  s(k) = INT(SIN(k * 5) * 64 + 64.5) - 64
NEXT k
PAPER 0
INK 7
BORDER 0
CLS
t0 = PEEK(33141) + 256 * PEEK(33142)
FOR f = 0 TO 17
  CLS
  FOR i = 0 TO 11
    r = 66 - i * 5
    k = MOD(i * 3 + f, 72)
    rs = DIV(r * (s(k) + 64), 64) - r
    rc = DIV(r * (s(MOD(k + 18, 72)) + 64), 64) - r
    INK MOD(i + f, 7) + 1
    LINE 128 - rc + rs, 96 - rs - rc TO 128 + rc + rs, 96 + rs - rc
    LINE 128 + rc + rs, 96 + rs - rc TO 128 + rc - rs, 96 + rs + rc
    LINE 128 + rc - rs, 96 + rs + rc TO 128 - rc - rs, 96 - rs + rc
    LINE 128 - rc - rs, 96 - rs + rc TO 128 - rc + rs, 96 - rs - rc
  NEXT i
NEXT f
t = PEEK(33141) + 256 * PEEK(33142) - t0
INK 7
AT 0, 0
PRINT "BASIC: "; t; " frames"
` },
  c: { id: 'spin', title: 'Spinning squares (speed test)', about: ABOUT, text: `/* Spinning squares: the same task in Leap BASIC, Leap-C and
   Leap-Forth (each language's Examples menu), to compare speed.
   18 frames of 12 squares turning, 48 draws a frame, from an
   integer sine table (64 = 1). The time is frames().
   Most of C's time goes into draw(): the arithmetic is fast. */
int sn[72] = {
    0, 6, 11, 17, 22, 27, 32, 37, 41, 45, 49, 52,
    55, 58, 60, 62, 63, 64, 64, 64, 63, 62, 60, 58,
    55, 52, 49, 45, 41, 37, 32, 27, 22, 17, 11, 6,
    0, -6, -11, -17, -22, -27, -32, -37, -41, -45, -49, -52,
    -55, -58, -60, -62, -63, -64, -64, -64, -63, -62, -60, -58,
    -55, -52, -49, -45, -41, -37, -32, -27, -22, -17, -11, -6
};
int main(void)
{
    int f, i, r, k, rs, rc;
    unsigned t0, t;
    paper(0);
    ink(7);
    border(0);
    cls();
    t0 = frames();
    for (f = 0; f < 18; f++) {
        cls();
        for (i = 0; i < 12; i++) {
            r = 66 - i * 5;
            k = (i * 3 + f) % 72;
            rs = r * (sn[k] + 64) / 64 - r;
            rc = r * (sn[(k + 18) % 72] + 64) / 64 - r;
            ink((i + f) % 7 + 1);
            draw(128 - rc + rs, 96 - rs - rc, 128 + rc + rs, 96 + rs - rc);
            draw(128 + rc + rs, 96 + rs - rc, 128 + rc - rs, 96 + rs + rc);
            draw(128 + rc - rs, 96 + rs + rc, 128 - rc - rs, 96 - rs + rc);
            draw(128 - rc - rs, 96 - rs + rc, 128 - rc + rs, 96 - rs - rc);
        }
    }
    t = frames() - t0;
    ink(7);
    at(0, 0);
    printf("C: %u frames", t);
    return 0;
}
` },
  forth: { id: 'spin', title: 'Spinning squares (speed test)', about: ABOUT, text: `\\ Spinning squares: the same task in Leap BASIC, Leap-C and
\\ Leap-Forth (each language's Examples menu), to compare speed.
\\ 18 frames of 12 squares turning, 48 LINEs a frame, from an
\\ integer sine table (64 = 1). The time is the frame counter.
CREATE SN
0 , 6 , 11 , 17 , 22 , 27 , 32 , 37 , 41 , 45 , 49 , 52 ,
55 , 58 , 60 , 62 , 63 , 64 , 64 , 64 , 63 , 62 , 60 , 58 ,
55 , 52 , 49 , 45 , 41 , 37 , 32 , 27 , 22 , 17 , 11 , 6 ,
0 , -6 , -11 , -17 , -22 , -27 , -32 , -37 , -41 , -45 , -49 , -52 ,
-55 , -58 , -60 , -62 , -63 , -64 , -64 , -64 , -63 , -62 , -60 , -58 ,
-55 , -52 , -49 , -45 , -41 , -37 , -32 , -27 , -22 , -17 , -11 , -6 ,
: SN@ ( k -- n ) CELLS SN + @ ;
\\ r * (s + 64) / 64 - r: never a negative division
: SCALE ( r s -- v ) 64 + OVER * 64 / SWAP - ;
VARIABLE R  VARIABLE RS  VARIABLE RC
: X1 128 RC @ - RS @ + ;  : Y1 96 RS @ - RC @ - ;
: X2 128 RC @ + RS @ + ;  : Y2 96 RS @ + RC @ - ;
: X3 128 RC @ + RS @ - ;  : Y3 96 RS @ + RC @ + ;
: X4 128 RC @ - RS @ - ;  : Y4 96 RS @ - RC @ + ;
: SQUARE ( f i -- )
  DUP 5 * 66 SWAP - R !
  2DUP + 7 MOD 1+ INK
  3 * + 72 MOD
  DUP SN@ R @ SWAP SCALE RS !
  18 + 72 MOD SN@ R @ SWAP SCALE RC !
  X1 Y1 X2 Y2 LINE  X2 Y2 X3 Y3 LINE
  X3 Y3 X4 Y4 LINE  X4 Y4 X1 Y1 LINE ;
\\ 33012 ($80F4) is FRAMES, the frame counter
: FRAMES@ ( -- n ) 33012 @ ;
VARIABLE T0
: SPIN
  0 PAPER 7 INK 0 BORDER CLS
  FRAMES@ T0 !
  18 0 DO CLS 12 0 DO J I SQUARE LOOP LOOP
  FRAMES@ T0 @ -
  7 INK 0 0 AT-XY ." FORTH: " . ." FRAMES" ;
SPIN
` },
};
