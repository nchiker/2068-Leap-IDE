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

SCENE play
  DIM st, tt, js, kl, kr, ku, kd, kf, kh, pu, pf, ph, ef, er, eh, dir, hdir, hcnt, scnt
  DIM pc, nx, rot, px, py, tx, ty, tr, fit, bi, si, dv, gcnt, ldly, lres, wt, g
  DIM shi, slo, hhi, hlo, ph1, pl1, pr, pcl, lv, lns, nlin, mult, lvup, low, fr0, fr1, ft, cr, cw, wr, gor, hud, bagpos
  DIM a, m, n, c, j, t, i, x, rc, k, pk, kk, lk, lr, lc, fr, fc
  REM sh: the 7 pieces (I O T S Z J L) x 4 turns as masks of a 4 x 4 box, bit (y * 4 + x); sdx, sdy, sdo: the 4 cells of each (x, y, y * 14 + x)
  REM bd: the well with a 2-cell wall each side and a floor, 14 x 24; 0 = empty, 1..7 = a block of that piece, 9 = wall.  Well row r, column c is bd(r * 14 + c + 2)
  DIM sh(27), sdx(111), sdy(111), sdo(111), bd(335), bag(6), cl(19), gt(14), ls(4), kc(4)

  REM ---- the pieces ----
  PROC SETSHAPES():
    REM I: 240 17476 3840 8738      O: 102 x 4      T: 114 610 624 562      S: 54 1122 864 561
    REM Z: 99 612 1584 306          J: 113 550 1136 802      L: 116 1570 368 547      (a shape is a row of 4 bits a row; see blockfall.assets.gen.mjs --masks)
    sh(0) = 240 : sh(1) = 17476 : sh(2) = 3840 : sh(3) = 8738
    sh(4) = 102 : sh(5) = 102 : sh(6) = 102 : sh(7) = 102
    sh(8) = 114 : sh(9) = 610 : sh(10) = 624 : sh(11) = 562
    sh(12) = 54 : sh(13) = 1122 : sh(14) = 864 : sh(15) = 561
    sh(16) = 99 : sh(17) = 612 : sh(18) = 1584 : sh(19) = 306
    sh(20) = 113 : sh(21) = 550 : sh(22) = 1136 : sh(23) = 802
    sh(24) = 116 : sh(25) = 1570 : sh(26) = 368 : sh(27) = 547
    FOR a = 0 TO 27
      m = sh(a) : n = a * 4
      FOR c = 0 TO 15
        IF BIT(m, c) THEN
          sdx(n) = c MOD 4 : sdy(n) = c DIV 4 : sdo(n) = (c DIV 4) * 14 + c MOD 4
          n = n + 1
        ENDIF
      NEXT c
    NEXT a
    REM gravity: ticks a row at each level (30 ticks a second), the line scores, the wall kicks tried after a turn
    gt(0) = 24 : gt(1) = 21 : gt(2) = 18 : gt(3) = 15 : gt(4) = 12 : gt(5) = 10 : gt(6) = 8 : gt(7) = 6
    gt(8) = 5 : gt(9) = 4 : gt(10) = 3 : gt(11) = 3 : gt(12) = 2 : gt(13) = 2 : gt(14) = 1
    ls(0) = 0 : ls(1) = 40 : ls(2) = 100 : ls(3) = 300 : ls(4) = 1200
    kc(0) = 0 : kc(1) = -1 : kc(2) = 1 : kc(3) = -2 : kc(4) = 2
  ENDP

  REM Walls and floor; the inside empty.
  PROC CLEARBOARD():
    FOR i = 0 TO 335
      bd(i) = 0
    NEXT i
    FOR i = 0 TO 23
      bd(i * 14) = 9 : bd(i * 14 + 1) = 9 : bd(i * 14 + 12) = 9 : bd(i * 14 + 13) = 9
    NEXT i
    FOR i = 280 TO 335
      bd(i) = 9
    NEXT i
    FOR i = 0 TO 19
      cl(i) = 0
    NEXT i
  ENDP

  REM ---- drawing ----
  REM Well row r from the board (also puts a tile over any text there).
  PROC REDRAWROW(r):
    FOR rc = 0 TO 9
      TILE 11 + rc, 2 + r = bd(r * 14 + rc + 2)
    NEXT rc
  ENDP

  PROC CLEARROW(r):
    FOR rc = 0 TO 9
      bd(r * 14 + rc + 2) = 0
      TILE 11 + rc, 2 + r = 0
    NEXT rc
  ENDP

  REM The current piece (pc, rot, px, py) in tile dv (pc + 1 draws it, 0 erases it).
  PROC DRAWP():
    si = (pc * 4 + rot) * 4
    FOR k = 0 TO 3
      TILE 11 + px + sdx(si + k), 2 + py + sdy(si + k) = dv
    NEXT k
  ENDP

  REM The preview of piece p in the next box (tile dv).
  PROC PREVIEW(p):
    FOR pk = 0 TO 3
      TILE 24 + sdx(p * 16 + pk), 5 + sdy(p * 16 + pk) = dv
    NEXT pk
  ENDP

  REM The frame, the labels, the key help: drawn once.
  PROC DRAWSTATIC():
    FOR i = 1 TO 22
      TILE 10, i = 9
      TILE 21, i = 9
    NEXT i
    FOR i = 11 TO 20
      TILE i, 1 = 9
      TILE i, 22 = 9
    NEXT i
    FOR i = 0 TO 19
      CALL REDRAWROW(i)
    NEXT i
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

  REM Print the score (ph1 * 10000 + pl1) at row pr, column 23 (or 1), followed by 3 spaces.
  PROC PSCORE():
    PRINT AT pr, pcl; "";
    IF ph1 > 0 THEN
      PRINT ph1;
      IF pl1 < 1000 THEN PRINT "0"; ENDIF
      IF pl1 < 100 THEN PRINT "0"; ENDIF
      IF pl1 < 10 THEN PRINT "0"; ENDIF
    ENDIF
    PRINT pl1; "   ";
  ENDP

  PROC SHOWHUD():
    BRIGHT 1 : PAPER 0 : INK 7
    ph1 = shi : pl1 = slo : pr = 11 : pcl = 23
    CALL PSCORE()
    PRINT AT 14, 23; lv + 1; "   ";
    PRINT AT 17, 23; lns; "   ";
    INK 6
    ph1 = hhi : pl1 = hlo : pr = 4 : pcl = 1
    CALL PSCORE()
    hud = 0
  ENDP

  REM ---- the bag ----
  PROC SHUFFLE():
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
  REM Does piece pc in turn tr at column tx, row ty fit?  fit = 1 or 0.
  PROC FITS():
    bi = ty * 14 + tx + 2
    si = (pc * 4 + tr) * 4
    fit = (bd(bi + sdo(si)) = 0) AND (bd(bi + sdo(si + 1)) = 0) AND (bd(bi + sdo(si + 2)) = 0) AND (bd(bi + sdo(si + 3)) = 0)
  ENDP

  PROC RESETLOCK():
    IF ldly > 0 AND lres < 12 THEN ldly = 0 : lres = lres + 1 ENDIF
  ENDP

  PROC TRYMOVE(d):
    tx = px + d : ty = py : tr = rot
    CALL FITS()
    IF fit THEN
      dv = 0 : CALL DRAWP()
      px = tx
      dv = pc + 1 : CALL DRAWP()
      CALL RESETLOCK()
      PLAY tick
    ENDIF
  ENDP

  REM Turn clockwise; if it does not fit, try one column left, one right (and two for the I piece).
  PROC TRYROT():
    tr = (rot + 1) MOD 4 : ty = py
    m = 2 : IF pc = 0 THEN m = 4 ENDIF
    FOR kk = 0 TO m
      tx = px + kc(kk)
      CALL FITS()
      IF fit THEN
        dv = 0 : CALL DRAWP()
        px = tx : rot = tr
        dv = pc + 1 : CALL DRAWP()
        CALL RESETLOCK()
        PLAY tick
        EXIT FOR
      ENDIF
    NEXT kk
  ENDP

  REM One row down if it fits (fit tells).
  PROC STEPDOWN():
    tx = px : ty = py + 1 : tr = rot
    CALL FITS()
    IF fit THEN
      dv = 0 : CALL DRAWP()
      py = ty
      dv = pc + 1 : CALL DRAWP()
      ldly = 0 : lres = 0
    ENDIF
  ENDP

  PROC HARDDROP():
    dv = 0 : CALL DRAWP()
    tx = px : tr = rot : ty = py
    fit = 1
    WHILE fit
      ty = ty + 1
      CALL FITS()
    WEND
    ty = ty - 1
    CALL ADDSCORE((ty - py) * 2)
    py = ty
    dv = pc + 1 : CALL DRAWP()
    CALL LOCK()
  ENDP

  REM The next piece comes: nx becomes the piece, a new nx is drawn.  A piece that does not fit ends the game.
  PROC SPAWN():
    dv = 11 : CALL PREVIEW(nx)
    pc = nx : CALL TAKEPIECE()
    dv = nx + 1 : CALL PREVIEW(nx)
    rot = 0 : px = 3 : py = 0
    tx = px : ty = py : tr = rot
    CALL FITS()
    IF fit THEN
      dv = pc + 1 : CALL DRAWP()
      st = 3 : gcnt = 0 : ldly = 0 : lres = 0
    ELSE
      CALL GAMEOVER()
    ENDIF
  ENDP

  REM ---- locking and the lines ----
  PROC LOCK():
    si = (pc * 4 + rot) * 4
    bi = py * 14 + px + 2
    FOR lk = 0 TO 3
      bd(bi + sdo(si + lk)) = pc + 1
    NEXT lk
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
    nlin = 0 : low = -1
    fr0 = py : fr1 = py + 3 : IF fr1 > 19 THEN fr1 = 19 ENDIF
    FOR lr = fr0 TO fr1
      m = 1 : n = lr * 14 + 2
      FOR lc = 0 TO 9
        IF bd(n + lc) = 0 THEN m = 0 : EXIT FOR ENDIF
      NEXT lc
      IF m THEN cl(lr) = 1 : nlin = nlin + 1 : low = lr ENDIF
    NEXT lr
  ENDP

  PROC SCORELINES():
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

  REM The full rows in tile dv (dv < 0: back to what the board holds).
  PROC FLASHROWS():
    FOR fr = fr0 TO fr1
      IF cl(fr) THEN
        FOR fc = 0 TO 9
          IF dv >= 0 THEN
            TILE 11 + fc, 2 + fr = dv
          ELSE
            TILE 11 + fc, 2 + fr = bd(fr * 14 + fc + 2)
          ENDIF
        NEXT fc
      ENDIF
    NEXT fr
  ENDP

  REM Row cr moves down to row cw (board and screen).
  PROC COPYROW():
    FOR rc = 0 TO 9
      m = bd(cr * 14 + rc + 2)
      bd(cw * 14 + rc + 2) = m
      TILE 11 + rc, 2 + cw = m
    NEXT rc
  ENDP

  REM ---- game over ----
  PROC GAMEOVER():
    st = 6 : gor = 19
    PLAY over
    IF shi > hhi OR (shi = hhi AND slo > hlo) THEN hhi = shi : hlo = slo : hud = 1 ENDIF
  ENDP

  PROC STARTGAME():
    shi = 0 : slo = 0 : lv = 0 : lns = 0 : lvup = 0
    bagpos = 7
    hdir = 0 : hcnt = 0 : scnt = 0
    st = 1 : wr = 0
  ENDP

  REM ---- the states ----
  PROC TITLETICK():
    tt = tt + 1
    x = RND(2)
    IF tt MOD 30 = 0 THEN
      INK 7 : PRINT AT 12, 13; "PRESS";
      INK 7 : PRINT AT 13, 13; "SPACE";
    ENDIF
    IF tt MOD 30 = 20 THEN
      PRINT AT 12, 13; "     ";
      PRINT AT 13, 13; "     ";
    ENDIF
    IF ef THEN CALL STARTGAME() ENDIF
  ENDP

  REM Two rows a tick of the well are emptied (this wipes the title text or the old stack), then the game begins.
  PROC WIPETICK():
    CALL CLEARROW(wr)
    CALL CLEARROW(wr + 1)
    wr = wr + 2
    IF wr >= 20 THEN
      INK 7
      PRINT AT 3, 1; "HI SCORE";
      dv = 11 : CALL PREVIEW(nx)
      CALL TAKEPIECE()
      dv = nx + 1 : CALL PREVIEW(nx)
      hud = 1
      st = 2 : wt = 10
    ENDIF
  ENDP

  PROC WAITTICK():
    wt = wt - 1
    IF wt <= 0 THEN CALL SPAWN() ENDIF
  ENDP

  PROC HANDLEINPUT():
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
    gcnt = gcnt + 1
    g = lv : IF g > 14 THEN g = 14 ENDIF
    IF gcnt >= gt(g) THEN
      gcnt = 0
      CALL STEPDOWN()
    ENDIF
    tx = px : ty = py + 1 : tr = rot
    CALL FITS()
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
    IF ft MOD 6 = 0 THEN dv = 8 : CALL FLASHROWS() ENDIF
    IF ft MOD 6 = 3 THEN dv = -1 : CALL FLASHROWS() ENDIF
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
      FOR i = 0 TO cw
        CALL CLEARROW(i)
      NEXT i
      IF lvup THEN PLAY lvlup : lvup = 0 ENDIF
      st = 2 : wt = 4
    ENDIF
  ENDP

  REM The stack turns grey from the bottom, one row a tick; then the text, and fire starts again.
  PROC OVERTICK():
    IF gor >= 0 THEN
      FOR i = 0 TO 9
        IF bd(gor * 14 + i + 2) <> 0 THEN TILE 11 + i, 2 + gor = 10 ENDIF
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
  ENDP

  PROC FRAME():
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
