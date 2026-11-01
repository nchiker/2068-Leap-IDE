/**
 * src/examples.js — the Examples menu's programs. No DOM or CodeMirror, so
 * Node can import it (tests/rom-checks.mjs compiles and runs every one).
 *
 * Most are the Leap manual's own example programs (docs/manual, 2.1.0-emu.1),
 * with a REM line saying what they show. `package` names the package a
 * program needs; the IDE loads it on Run.
 */

"use strict";

/** @type {{id: string, title: string, about: string, package?: string, input?: boolean, text: string}[]} */
export const EXAMPLES = [
  {
    id: 'hello',
    title: 'Hello, Leap',
    about: 'A PROC with a parameter and a FOR loop',
    text: `REM Leap V2 - hello world
CLS
CALL greet(3)
END

PROC greet(n):
  FOR i = 1 TO n
    AT 8 + i, 6
    PRINT "HELLO, LEAP V2! "; i
  NEXT i
ENDP
`,
  },
  {
    id: 'ball',
    title: 'Bouncing ball',
    about: 'Animation with OVER 1: draw, pause, draw again to erase',
    text: `REM Bouncing ball: OVER 1 draws and erases
PAPER 0
INK 7
CLS
OVER 1
x = 20
y = 30
dx = 5
dy = 3
FOR frame = 1 TO 60
  CALL ball(0)
  PAUSE 1
  CALL ball(0)
  x = x + dx
  y = y + dy
  IF x < 5 OR x > 245 THEN
    dx = 0 - dx
  ENDIF
  IF y < 5 OR y > 185 THEN
    dy = 0 - dy
  ENDIF
NEXT frame
OVER 0
CALL ball(0)
PRINT x; " "; y
END

PROC ball(n):
  FOR r = 0 TO 5
    LINE x, y + r TO x + 5, y + r
  NEXT r
ENDP
`,
  },
  {
    id: 'lines',
    title: 'Line art',
    about: 'LINE with absolute coordinates (y counts from the top)',
    text: `REM Line art: two fans of lines
INK 2
FOR i = 0 TO 255 STEP 8
  LINE 0, 0 TO i, 191
NEXT i
INK 1
FOR i = 0 TO 191 STEP 8
  LINE 255, 0 TO 0, i
NEXT i
`,
  },
  {
    id: 'guess',
    title: 'Guess the number',
    about: 'INPUT, labels and GOTO; click the screen to type',
    input: true,
    text: `REM Guess the number: click the screen to type
RANDOMISE 7
secret = RND(100) + 1
tries = 0
again:
INPUT "Guess? "; g
tries = tries + 1
IF g < secret THEN
  PRINT "Too low"
  GOTO again
ENDIF
IF g > secret THEN
  PRINT "Too high"
  GOTO again
ENDIF
PRINT "Got it in "; tries; " tries"
`,
  },
  {
    id: 'primes',
    title: 'Prime sieve',
    about: 'Arrays and nested FOR loops',
    text: `REM Sieve of Eratosthenes
DIM crossed(30)
FOR n = 2 TO 29
  IF crossed(n) = 0 THEN
    PRINT n;
    PRINT " ";
    FOR m = n * 2 TO 29 STEP n
      crossed(m) = 1
    NEXT m
  ENDIF
NEXT n
`,
  },
  {
    id: 'binary',
    title: 'Binary numbers',
    about: 'A recursive PROC, DIV() and MOD()',
    text: `REM Binary numbers with a recursive PROC
DIM v(4)
v(0) = 5
v(1) = 10
v(2) = 255
v(3) = 1000
FOR k = 0 TO 3
  PRINT v(k); " is ";
  CALL bin(v(k))
  PRINT
NEXT k
END

PROC bin(n):
  IF n > 1 THEN
    CALL bin(DIV(n, 2))
  ENDIF
  PRINT MOD(n, 2);
ENDP
`,
  },
  {
    id: 'caesar',
    title: 'Caesar cipher',
    about: 'Strings: MID$, CODE and CHR$',
    text: `REM Caesar cipher: shift each letter by 3
msg$ = "HELLO WORLD"
out$ = ""
FOR i = 1 TO LEN(msg$)
  ch$ = MID$(msg$, i, 1)
  k = CODE(ch$)
  IF k >= 65 AND k <= 90 THEN
    k = MOD(k - 65 + 3, 26) + 65
  ENDIF
  out$ = out$ + CHR$(k)
NEXT i
PRINT msg$
PRINT out$
`,
  },
  {
    id: 'scale',
    title: 'Beeps',
    about: 'BEEP seconds, semitones',
    text: `REM Five notes with BEEP
FOR n = 0 TO 4
  BEEP 0.2, n * 3
NEXT n
PRINT "DONE"
`,
  },
  {
    id: 'udg',
    title: 'A user-defined character',
    about: 'POKE a UDG (codes 144-164) and print it with CHR$',
    text: `REM A smiley as UDG 144 (8 bytes from 61824)
POKE 61824, 60: POKE 61825, 66: POKE 61826, 165: POKE 61827, 129
POKE 61828, 165: POKE 61829, 153: POKE 61830, 66: POKE 61831, 60
FOR i = 1 TO 8
  PRINT CHR$(144); " ";
NEXT i
PRINT
`,
  },
  {
    id: 'circles',
    title: 'Circles (SHAPES)',
    about: 'CIRCLE and FILL from the SHAPES package',
    package: 'shapes',
    text: `REM Circles: CIRCLE and FILL (SHAPES package)
FOR r = 10 TO 90 STEP 10
  INK MOD(r / 10, 7) + 1
  CIRCLE 128, 96, r
NEXT r
INK 2
FILL 128, 96
`,
  },
  {
    id: 'chart',
    title: 'Bar chart (GRAPHICS)',
    about: 'BLOCK and FRAME from the GRAPHICS package',
    package: 'graphics',
    text: `REM Bar chart: BLOCK and FRAME (GRAPHICS package)
DIM h(6)
h(0) = 40
h(1) = 90
h(2) = 65
h(3) = 120
h(4) = 80
h(5) = 30
FOR i = 0 TO 5
  INK i + 1
  BLOCK 20 + i * 38, 167 - h(i), 48 + i * 38, 167
NEXT i
INK 0
FRAME 10, 20, 245, 175
`,
  },
  {
    id: 'ship',
    title: 'Spaceship (SPRITE)',
    about: 'GRAB a drawing into a sprite, then SHOW and MOVE it',
    package: 'sprite',
    text: `REM Spaceship: GRAB, SHOW and MOVE (SPRITE package)
INK 6
PAPER 0
CLS
LINE 16, 24 TO 31, 16
LINE 31, 16 TO 31, 31
LINE 31, 31 TO 16, 24
LINE 16, 24 TO 31, 24
GRAB 0, 2, 2, 2, 2
INK 7
PAPER 0
CLS
RANDOMISE 3
FOR i = 1 TO 40
  PLOT RND(256), RND(176)
NEXT i
SHOW 0, 10, 0
FOR c = 1 TO 28
  MOVE 0, 10, c
  PAUSE 2
NEXT c
`,
  },
];
