"use strict";
// sc-ink-game.mjs -- the game of the cross-emulator check of the ink build (tests/arcade-sc-xemu.mjs, sc-ink-zesarux.py): a self-playing classic game, no input needed.
// Two sprites bounce at speeds that visit every shift (one with 2 phases), over a background of varied paper / bright attributes, with a text block changing every 9 ticks;
// scene s has spriteColour 'ink'.  (The same game as G2 of tests/arcade-sc-parity.mjs.)  Exports SRC and ASSETS; compile it against arcade/build/v2ink.
const rows = (spec) => spec.map(([bits, mask, ink]) => ({ bits, mask, ink }));
const rep = (n, v) => new Array(n).fill(v);
const SHIP = rows([...rep(4, ['FFFF', 'FFFF', 2]), ...rep(4, ['3C3C', '7E7E', 6]), ...rep(8, ['FFFF', 'FFFF', 5])]);
const DOT = rows([...rep(6, ['F0F0', 'F0F0', 3]), ['0000', '0000', 3], ['FFFF', 'FFFF', 1]]);
export const ASSETS = {
  sprites: {
    ship: { w: 16, h: 16, frames: [{ rows: SHIP }] },
    dot: { w: 16, h: 8, frames: [{ rows: DOT }], phases: 2 },
  },
  scenes: { s: { spriteColour: 'ink' } },
};
export const SRC = `GAME "p"
FRAMERATE 30
SPRITE ship = "ship"
SPRITE dot = "dot"
SCENE s
  DIM x, y, dx, dy, u, v, du, dv, t
  PROC INIT():
    CLS
    FOR r = 0 TO 23
      PAPER (r MOD 7) + 1 : INK 0 : BRIGHT r MOD 2
      PRINT AT r, 0; "###############################";
    NEXT r
    BRIGHT 0
    x = 5 : y = 3 : dx = 3 : dy = 2
    u = 200 : v = 150 : du = -5 : dv = -7
    SHOW ship AT x, y
    SHOW dot AT u, v
  ENDP
  PROC FRAME():
    t = t + 1
    x = x + dx : y = y + dy
    IF x > 239 THEN
      x = 239 : dx = 0 - dx
    ENDIF
    IF x < 0 THEN
      x = 0 : dx = 0 - dx
    ENDIF
    IF y > 176 THEN
      y = 176 : dy = 0 - dy
    ENDIF
    IF y < 0 THEN
      y = 0 : dy = 0 - dy
    ENDIF
    u = u + du : v = v + dv
    IF u > 239 THEN
      du = 0 - du
    ENDIF
    IF u < 0 THEN
      du = 0 - du
    ENDIF
    IF v > 176 THEN
      dv = 0 - dv
    ENDIF
    IF v < 0 THEN
      dv = 0 - dv
    ENDIF
    SHOW ship AT x, y
    SHOW dot AT u, v
    IF t MOD 9 = 0 THEN
      PAPER (t MOD 7) + 1 : INK 2 : PRINT AT (t MOD 20) + 2, 5; "XXXXXXXXXXXXXXXX";
    ENDIF
  ENDP
ENDSCENE
`;
