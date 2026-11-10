REM Blockfall: a falling-blocks puzzle game for the v2 runtime (an original game; no sprites, the whole game is tiles and text).
REM Assets (12 tiles, 8 sound effects) are in blockfall.assets.json, drawn by blockfall.assets.gen.mjs.
REM   Keys: O left, P right, Q turn, A soft drop, SPACE hard drop, H pause.   Joystick 1: left, right, up = turn, down = soft drop, fire = hard drop.
REM   Holding left or right moves at once, then after 8 ticks repeats every 2 ticks; holding A drops a row every 2 ticks.
REM   Ten columns by twenty rows, seven pieces in four turns each, dealt from a 7-bag; the next piece is shown; every 10 lines make a level
REM   and the piece falls faster; a piece that has landed waits 15 ticks (a lock delay) and moving it in that time restarts the wait (12 times at most).
REM   A cleared line flashes (a bright tile), then the rows above fall one source row at a time; one to four lines have their own sound.
REM   Scoring: 40 / 100 / 300 / 1200 for 1 / 2 / 3 / 4 lines times (level + 1, at most 20); 1 point a row of soft drop, 2 a row of hard drop.
REM   States: 0 title, 1 clearing the well for a new game, 2 waiting for the next piece, 3 falling, 4 flashing lines, 5 collapsing, 6 game over, 7 paused.
REM   Compile:  node arcade/tools/arcadec.mjs arcade/examples/blockfall.arc --assets arcade/examples/blockfall.assets.json --runtime v2
REM
REM   Written with language batch 1 (docs/ARCADE_LANGUAGE_BATCH1.md): CONST for the geometry, PROCs with parameters and LOCALs, bit functions to
REM   decode the piece masks, array initialisers for the tables, a 2-D board, FILL and COPY for the wipe and the collapse, RANDOMISE for the piece
REM   order and BORDER. The version before the batch is kept in arcade/tests/fixtures/blockfall-v0.arc; tests/arcade-blockfall.mjs proves that
REM   the cell maps, the attributes and the score of the two are identical on the same 3,595-tick script (with FREESEED = 0, see below).
GAME "Blockfall"
FRAMERATE 30

TILESET gfx = "gfx"
SFX tick = "tick"
SFX thud = "lock"
SFX clear1 = "clear1"
SFX clear2 = "clear2"
SFX clear3 = "clear3"
SFX clear4 = "clear4"
SFX lvlup = "lvlup"
SFX over = "over"

REM The well: BW x BH cells, its first cell at screen column WX, row WY.  The board has a 2-cell wall each side and a floor of 4 rows (BX0 = the wall).
CONST BW = 10
CONST BH = 20
CONST WX = 11
CONST WY = 2
CONST BX0 = 2
REM The frame around the well, and the box that shows the next piece.
CONST FRL = WX - 1
CONST FRR = WX + BW
CONST FRT = WY - 1
CONST FRB = WY + BH
CONST NXC = 24
CONST NXR = 5
REM 1: the piece order is seeded from the frame counter when SPACE starts the game (a different game every time).  0: one random number is burnt for
REM every tick of the title, so the order depends only on how long the title waited (what tests/arcade-blockfall.mjs plays against the old version).
CONST FREESEED = 1

SCENE play
  DIM st, tt, kl, kr, ku, kd, kf, kh, pu, pf, ph, ef, er, eh, hdir, hcnt, scnt
  DIM pc, nx, rot, px, py, fit, gcnt, ldly, lres, wt
  DIM shi, slo, hhi, hlo, lv, lns, nlin, mult, lvup, low, fr0, fr1, ft, cr, cw, wr, gor, hud, bagpos
  REM sh: the 7 pieces (I O T S Z J L) x 4 turns as masks of a 4 x 4 box, bit (y * 4 + x); sdx, sdy: the 4 cells of each, decoded at the start (sdx already
  REM includes the board's wall, BX0, so that a board index is x + sdx(...) with no addition; on the screen it is WX - BX0 + x + sdx(...))
  REM I: 240 17476 3840 8738      O: 102 x 4      T: 114 610 624 562      S: 54 1122 864 561      Z: 99 612 1584 306      J: 113 550 1136 802      L: 116 1570 368 547
  DIM sh(27) = 240, 17476, 3840, 8738, 102, 102, 102, 102, 114, 610, 624, 562, 54, 1122, 864, 561, 99, 612, 1584, 306, 113, 550, 1136, 802, 116, 1570, 368, 547
  REM gravity: ticks a row at each level (30 ticks a second), the line scores, the wall kicks tried after a turn
  DIM gt(14) = 24, 21, 18, 15, 12, 10, 8, 6, 5, 4, 3, 3, 2, 2, 1
  DIM ls(4) = 0, 40, 100, 300, 1200
  DIM kc(4) = 0, -1, 1, -2, 2
  REM the well with a 2-cell wall each side and a floor: bd(column, row), 14 x 24; 0 = empty, 1..7 = a block of that piece, 9 = wall
  DIM sdx(111), sdy(111), bd(13, 23), bag(6), cl(19)

  REM ---- the pieces ----
  PROC SETSHAPES():
    LOCAL m, n
    FOR a = 0 TO 27
      m = sh(a) : n = a * 4
      FOR c = 0 TO 15
        IF BAND(m, 1) THEN
          sdx(n) = BAND(c, 3) + BX0 : sdy(n) = SHR(c, 2)
          n = n + 1
        ENDIF
        m = SHR(m, 1)
      NEXT c
    NEXT a
  ENDP

  REM Walls and floor; the inside is empty (every variable starts at 0).
  PROC CLEARBOARD():
    FOR r = 0 TO 23
      bd(0, r) = 9 : bd(1, r) = 9 : bd(BX0 + BW, r) = 9 : bd(BX0 + BW + 1, r) = 9
    NEXT r
    FOR c = 2 TO BX0 + BW - 1
      FOR r = BH TO 23
        bd(c, r) = 9
      NEXT r
    NEXT c
  ENDP

  REM ---- drawing ----
  REM Rows r .. r + n - 1 of the well are emptied, on the board and on the screen (this also wipes any text there).
  PROC CLEARROWS(r, n):
    IF n > 0 THEN
      FOR i = r TO r + n - 1
        FOR c = 0 TO BW - 1
          bd(BX0 + c, i) = 0
        NEXT c
      NEXT i
    ENDIF
    FILL WX, WY + r, BW, n = 0
  ENDP

  REM The current piece (pc, rot, px, py) in tile tl (pc + 1 draws it, 0 erases it).
  PROC DRAWP(tl):
    LOCAL si
    si = (pc * 4 + rot) * 4
    FOR k = 0 TO 3
      TILE WX - BX0 + px + sdx(si + k), WY + py + sdy(si + k) = tl
    NEXT k
  ENDP

  REM The preview of piece p in the next box (tile tl).
  PROC PREVIEW(p, tl):
    FOR k = 0 TO 3
      TILE NXC - BX0 + sdx(p * 16 + k), NXR + sdy(p * 16 + k) = tl
    NEXT k
  ENDP

  REM The frame, the labels, the key help: drawn once.
  PROC DRAWSTATIC():
    FILL FRL, FRT, 1, BH + 2 = 9
    FILL FRR, FRT, 1, BH + 2 = 9
    FILL WX, FRT, BW, 1 = 9
    FILL WX, FRB, BW, 1 = 9
    FILL WX, WY, BW, BH = 0
    BRIGHT 1 : PAPER 0
    INK 6 : PRINT AT 0, 11; "BLOCKFALL";
    INK 5 : PRINT AT 3, 24; "NEXT";
    INK 5 : PRINT AT 10, 23; "SCORE";
    INK 5 : PRINT AT 13, 23; "LEVEL";
    INK 5 : PRINT AT 16, 23; "LINES";
    INK 5 : PRINT AT 3, 1; "HI SCORE";
    INK 4 : PRINT AT 8, 0; "O P  MOVE";
    INK 4 : PRINT AT 9, 0; "Q    TURN";
    INK 4 : PRINT AT 10, 0; "A    DOWN";
    INK 4 : PRINT AT 11, 0; "SPC  DROP";
    INK 4 : PRINT AT 12, 0; "H   PAUSE";
    INK 3 : PRINT AT 14, 0; "OR JOY 1";
  ENDP

  PROC SHOWTITLE():
    BRIGHT 1 : PAPER 0
    INK 2 : PRINT AT 6, 13; "B";
    INK 6 : PRINT "L";
    INK 4 : PRINT "O";
    INK 5 : PRINT "C";
    INK 3 : PRINT "K";
    INK 3 : PRINT AT 7, 14; "F";
    INK 5 : PRINT "A";
    INK 4 : PRINT "L";
    INK 6 : PRINT "L";
    INK 7 : PRINT AT 12, 13; "PRESS";
    INK 7 : PRINT AT 13, 13; "SPACE";
    FOR i = 0 TO 6
      TILE 12 + i, 15 = i + 1
    NEXT i
  ENDP

  REM ---- score, level, lines ----
  PROC ADDSCORE(pts):
    REM the score is shi * 10000 + slo (16-bit integers cannot hold a score): whole ten-thousands first, so that slo + pts cannot overflow
    WHILE pts >= 10000
      pts = pts - 10000 : shi = shi + 1
    WEND
    slo = slo + pts
    IF slo >= 10000 THEN slo = slo - 10000 : shi = shi + 1 ENDIF
    IF shi > 99 THEN shi = 99 : slo = 9999 ENDIF
    hud = 1
  ENDP

  REM Print the score (hi * 10000 + lo) at row r, column c, followed by 3 spaces.
  PROC PSCORE(r, c, hi, lo):
    PRINT AT r, c;
    IF hi > 0 THEN
      PRINT hi;
      IF lo < 1000 THEN PRINT "0"; ENDIF
      IF lo < 100 THEN PRINT "0"; ENDIF
      IF lo < 10 THEN PRINT "0"; ENDIF
    ENDIF
    PRINT lo; "   ";
  ENDP

  PROC SHOWHUD():
    BRIGHT 1 : PAPER 0 : INK 7
    CALL PSCORE(11, 23, shi, slo)
    PRINT AT 14, 23; lv + 1; "   ";
    PRINT AT 17, 23; lns; "   ";
    INK 6
    CALL PSCORE(4, 1, hhi, hlo)
    hud = 0
  ENDP

  REM ---- the bag ----
  PROC SHUFFLE():
    LOCAL j, t
    FOR a = 0 TO 6
      bag(a) = a
    NEXT a
    FOR a = 6 TO 1 STEP -1
      j = RND(a + 1)
      t = bag(a) : bag(a) = bag(j) : bag(j) = t
    NEXT a
    bagpos = 0
  ENDP

  REM nx = the next piece of the bag
  PROC TAKEPIECE():
    IF bagpos >= 7 THEN CALL SHUFFLE() ENDIF
    nx = bag(bagpos) : bagpos = bagpos + 1
  ENDP

  REM ---- the piece ----
  REM Does piece p in turn r at column x, row y fit?  fit = 1 or 0.
  PROC FITS(p, r, x, y):
    LOCAL si
    si = (p * 4 + r) * 4
    fit = (bd(x + sdx(si), y + sdy(si)) = 0) AND (bd(x + sdx(si + 1), y + sdy(si + 1)) = 0) AND (bd(x + sdx(si + 2), y + sdy(si + 2)) = 0) AND (bd(x + sdx(si + 3), y + sdy(si + 3)) = 0)
  ENDP

  PROC RESETLOCK():
    IF ldly > 0 AND lres < 12 THEN ldly = 0 : lres = lres + 1 ENDIF
  ENDP

  PROC TRYMOVE(d):
    CALL FITS(pc, rot, px + d, py)
    IF fit THEN
      CALL DRAWP(0)
      px = px + d
      CALL DRAWP(pc + 1)
      CALL RESETLOCK()
      PLAY tick
    ENDIF
  ENDP

  REM Turn clockwise; if it does not fit, try one column left, one right (and two for the I piece).
  PROC TRYROT():
    LOCAL tr, tx, m
    tr = (rot + 1) MOD 4
    m = 2 : IF pc = 0 THEN m = 4 ENDIF
    FOR k = 0 TO m
      tx = px + kc(k)
      CALL FITS(pc, tr, tx, py)
      IF fit THEN
        CALL DRAWP(0)
        px = tx : rot = tr
        CALL DRAWP(pc + 1)
        CALL RESETLOCK()
        PLAY tick
        EXIT FOR
      ENDIF
    NEXT k
  ENDP

  REM One row down if it fits (fit tells).
  PROC STEPDOWN():
    CALL FITS(pc, rot, px, py + 1)
    IF fit THEN
      CALL DRAWP(0)
      py = py + 1
      CALL DRAWP(pc + 1)
      ldly = 0 : lres = 0
    ENDIF
  ENDP

  REM The piece falls to the floor: FITS at one row lower until it does not.  The four cells (board column and row offset) are looked up once,
  REM not at every row, which is what keeps a hard drop from the top of the well inside the tick.
  PROC HARDDROP():
    LOCAL ty, si, x0, x1, x2, x3, y0, y1, y2, y3
    CALL DRAWP(0)
    si = (pc * 4 + rot) * 4
    x0 = px + sdx(si) : x1 = px + sdx(si + 1) : x2 = px + sdx(si + 2) : x3 = px + sdx(si + 3)
    y0 = sdy(si) : y1 = sdy(si + 1) : y2 = sdy(si + 2) : y3 = sdy(si + 3)
    ty = py
    fit = 1
    WHILE fit
      ty = ty + 1
      fit = (bd(x0, ty + y0) = 0) AND (bd(x1, ty + y1) = 0) AND (bd(x2, ty + y2) = 0) AND (bd(x3, ty + y3) = 0)
    WEND
    ty = ty - 1
    CALL ADDSCORE((ty - py) * 2)
    py = ty
    CALL DRAWP(pc + 1)
    CALL LOCK()
  ENDP

  REM The next piece comes: nx becomes the piece, a new nx is drawn.  A piece that does not fit ends the game.
  PROC SPAWN():
    CALL PREVIEW(nx, 11)
    pc = nx : CALL TAKEPIECE()
    CALL PREVIEW(nx, nx + 1)
    rot = 0 : px = 3 : py = 0
    CALL FITS(pc, rot, px, py)
    IF fit THEN
      CALL DRAWP(pc + 1)
      st = 3 : gcnt = 0 : ldly = 0 : lres = 0
    ELSE
      CALL GAMEOVER()
    ENDIF
  ENDP

  REM ---- locking and the lines ----
  PROC LOCK():
    LOCAL si
    si = (pc * 4 + rot) * 4
    FOR k = 0 TO 3
      bd(px + sdx(si + k), py + sdy(si + k)) = pc + 1
    NEXT k
    CALL CHECKLINES()
    IF nlin > 0 THEN
      CALL SCORELINES()
      st = 4 : ft = 0
    ELSE
      PLAY thud
      st = 2 : wt = 4
    ENDIF
  ENDP

  REM Which of the four rows the piece touched are full: cl(row) = 1, nlin of them, low = the lowest.
  PROC CHECKLINES():
    LOCAL m
    nlin = 0 : low = -1
    fr0 = py : fr1 = py + 3 : IF fr1 > BH - 1 THEN fr1 = BH - 1 ENDIF
    FOR r = fr0 TO fr1
      m = 1
      FOR c = 0 TO BW - 1
        IF bd(BX0 + c, r) = 0 THEN m = 0 : EXIT FOR ENDIF
      NEXT c
      IF m THEN cl(r) = 1 : nlin = nlin + 1 : low = r ENDIF
    NEXT r
  ENDP

  PROC SCORELINES():
    LOCAL c
    mult = lv + 1 : IF mult > 20 THEN mult = 20 ENDIF
    CALL ADDSCORE(ls(nlin) * mult)
    lns = lns + nlin
    c = lns DIV 10 : IF c > 99 THEN c = 99 ENDIF
    IF c > lv THEN lv = c : lvup = 1 ENDIF
    hud = 1
    SELECT CASE nlin
      CASE 1
        PLAY clear1
      CASE 2
        PLAY clear2
      CASE 3
        PLAY clear3
      CASE ELSE
        PLAY clear4
    ENDSEL
  ENDP

  REM The full rows in tile tl (tl < 0: back to what the board holds).
  PROC FLASHROWS(tl):
    FOR r = fr0 TO fr1
      IF cl(r) THEN
        IF tl >= 0 THEN
          FILL WX, WY + r, BW, 1 = tl
        ELSE
          FOR c = 0 TO BW - 1
            TILE WX + c, WY + r = bd(BX0 + c, r)
          NEXT c
        ENDIF
      ENDIF
    NEXT r
  ENDP

  REM Row cr moves down to row cw (board and screen).
  PROC COPYROW():
    FOR c = 0 TO BW - 1
      bd(BX0 + c, cw) = bd(BX0 + c, cr)
    NEXT c
    COPY WX, WY + cr, BW, 1 TO WX, WY + cw
  ENDP

  REM ---- game over ----
  PROC GAMEOVER():
    st = 6 : gor = BH - 1
    PLAY over
    BORDER 2
    IF shi > hhi OR (shi = hhi AND slo > hlo) THEN hhi = shi : hlo = slo : hud = 1 ENDIF
  ENDP

  PROC STARTGAME():
    shi = 0 : slo = 0 : lv = 0 : lns = 0 : lvup = 0
    bagpos = 7
    hdir = 0 : hcnt = 0 : scnt = 0
    st = 1 : wr = 0
    BORDER 0
  ENDP

  REM ---- the states ----
  PROC TITLETICK():
    LOCAL x
    tt = tt + 1
    IF FREESEED = 0 THEN x = RND(2) ENDIF
    IF tt MOD 30 = 0 THEN
      INK 7 : PRINT AT 12, 13; "PRESS";
      INK 7 : PRINT AT 13, 13; "SPACE";
    ENDIF
    IF tt MOD 30 = 20 THEN
      PRINT AT 12, 13; "     ";
      PRINT AT 13, 13; "     ";
    ENDIF
    IF ef THEN
      IF FREESEED THEN RANDOMISE ENDIF
      CALL STARTGAME()
    ENDIF
  ENDP

  REM Two rows a tick of the well are emptied (this wipes the title text or the old stack), then the game begins.
  PROC WIPETICK():
    CALL CLEARROWS(wr, 2)
    wr = wr + 2
    IF wr >= BH THEN
      INK 7
      PRINT AT 3, 1; "HI SCORE";
      CALL PREVIEW(nx, 11)
      CALL TAKEPIECE()
      CALL PREVIEW(nx, nx + 1)
      hud = 1
      st = 2 : wt = 10
    ENDIF
  ENDP

  PROC WAITTICK():
    wt = wt - 1
    IF wt <= 0 THEN CALL SPAWN() ENDIF
  ENDP

  PROC HANDLEINPUT():
    LOCAL dir
    IF er THEN CALL TRYROT() ENDIF
    dir = kr - kl
    IF dir <> 0 THEN
      IF dir = hdir THEN
        hcnt = hcnt + 1
      ELSE
        hdir = dir : hcnt = 0
      ENDIF
      IF hcnt = 0 THEN
        CALL TRYMOVE(dir)
      ELSE
        IF hcnt >= 8 THEN
          IF (hcnt - 8) MOD 2 = 0 THEN CALL TRYMOVE(dir) ENDIF
        ENDIF
      ENDIF
    ELSE
      hdir = 0 : hcnt = 0
    ENDIF
    IF ef THEN
      CALL HARDDROP()
    ELSE
      IF kd THEN
        IF scnt = 0 THEN
          CALL STEPDOWN()
          IF fit THEN CALL ADDSCORE(1) : gcnt = 0 ENDIF
        ENDIF
        scnt = 1 - scnt
      ELSE
        scnt = 0
      ENDIF
    ENDIF
  ENDP

  PROC GRAVITY():
    LOCAL g
    gcnt = gcnt + 1
    g = lv : IF g > 14 THEN g = 14 ENDIF
    IF gcnt >= gt(g) THEN
      gcnt = 0
      CALL STEPDOWN()
    ENDIF
    CALL FITS(pc, rot, px, py + 1)
    IF fit = 0 THEN
      ldly = ldly + 1
      IF ldly >= 15 THEN CALL LOCK() ENDIF
    ENDIF
  ENDP

  PROC FALLTICK():
    IF eh THEN
      st = 7
      INK 2 : BRIGHT 1 : PAPER 0 : PRINT AT 16, 0; "PAUSED";
    ELSE
      CALL HANDLEINPUT()
      IF st = 3 THEN CALL GRAVITY() ENDIF
    ENDIF
  ENDP

  PROC PAUSETICK():
    IF eh THEN
      PRINT AT 16, 0; "      ";
      st = 3
    ENDIF
  ENDP

  REM The full rows flash (a bright tile for 3 ticks, the blocks for 3, twice), then they go.
  PROC FLASHTICK():
    IF ft MOD 6 = 0 THEN CALL FLASHROWS(8) ENDIF
    IF ft MOD 6 = 3 THEN CALL FLASHROWS(-1) ENDIF
    ft = ft + 1
    IF ft >= 12 THEN
      cr = low : cw = low
      st = 5
    ENDIF
  ENDP

  REM Three source rows a tick, from the lowest full row up: a row that is not full moves down to the next free place.
  PROC COLLAPSETICK():
    FOR i = 1 TO 3
      IF cr >= 0 THEN
        IF cl(cr) = 0 THEN
          IF cr <> cw THEN CALL COPYROW() ENDIF
          cw = cw - 1
        ELSE
          cl(cr) = 0
        ENDIF
        cr = cr - 1
      ENDIF
    NEXT i
    IF cr < 0 THEN
      CALL CLEARROWS(0, cw + 1)
      IF lvup THEN PLAY lvlup : lvup = 0 ENDIF
      st = 2 : wt = 4
    ENDIF
  ENDP

  REM The stack turns grey from the bottom, one row a tick; then the text, and fire starts again.
  PROC OVERTICK():
    IF gor >= 0 THEN
      FOR i = 0 TO BW - 1
        IF bd(BX0 + i, gor) <> 0 THEN TILE WX + i, WY + gor = 10 ENDIF
      NEXT i
      gor = gor - 1
      IF gor < 0 THEN
        BRIGHT 1 : PAPER 0
        INK 2 : PRINT AT 10, 11; "GAME OVER";
        INK 7 : PRINT AT 12, 13; "PRESS";
        INK 7 : PRINT AT 13, 13; "SPACE";
      ENDIF
    ELSE
      IF ef THEN CALL STARTGAME() ENDIF
    ENDIF
  ENDP

  PROC INIT():
    CALL SETSHAPES()
    CALL CLEARBOARD()
    hhi = 0 : hlo = 0 : bagpos = 7
    PAPER 0 : INK 7 : BRIGHT 1
    CLS
    CALL DRAWSTATIC()
    CALL SHOWTITLE()
    hud = 1
    st = 0
    BORDER 0
  ENDP

  PROC FRAME():
    LOCAL js
    js = STICK(1)
    kl = KEYDOWN("O") OR BIT(js, 2)
    kr = KEYDOWN("P") OR BIT(js, 3)
    ku = KEYDOWN("Q") OR BIT(js, 0)
    kd = KEYDOWN("A") OR BIT(js, 1)
    kf = KEYDOWN(" ") OR BIT(js, 4)
    kh = KEYDOWN("H")
    ef = kf AND pf = 0
    er = ku AND pu = 0
    eh = kh AND ph = 0
    SELECT CASE st
      CASE 0
        CALL TITLETICK()
      CASE 1
        CALL WIPETICK()
      CASE 2
        CALL WAITTICK()
      CASE 3
        CALL FALLTICK()
      CASE 4
        CALL FLASHTICK()
      CASE 5
        CALL COLLAPSETICK()
      CASE 6
        CALL OVERTICK()
      CASE ELSE
        CALL PAUSETICK()
    ENDSEL
    IF hud THEN CALL SHOWHUD() ENDIF
    pu = ku : pf = kf : ph = kh
  ENDP
ENDSCENE
