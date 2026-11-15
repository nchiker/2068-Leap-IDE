REM Lumen: the fine-colour showcase game of Leap Arcade (docs/ARCADE_FINE_COLOUR_CONTRACT.md section 10), a maze chase for the v2 runtime.  Design: lumen.md.
REM You are the wisp, a ball of light in a cave maze: eat every light orb to clear the cave.  Four shades hunt you (Ember, Bloom, Moss, Frost); a shade that touches you costs a
REM life (3 lives).  A prism in each corner turns every shade outside the lair pale for a while: touching a pale shade sends it back to the lair for 200, 400, 800 and 1600 points.
REM Each cave the shades are faster, chase more often and stay pale for less time; the caves alternate between the two mazes (odd caves: rainbow tubes, even caves: ice tubes).
REM   Keyboard: Q up, A down, O left, P right, SPACE fire.   Joystick 1: the stick and fire.   Fire starts the game and restarts it after GAME OVER.
REM Every scene is fine colour (8 x 1 colour): the assets file's "scenes" key says so (lumen.assets.gen.mjs); the source is ordinary.  The maze is 16 x 11 blocks of 16 x 16 pixels on
REM cell rows 1..22 (block (bx, by) is the cells (2 bx, 1 + 2 by) .. (2 bx + 1, 2 + 2 by); a sprite on it stands at x = 16 bx, y = 8 + 16 by).  A block is told by the tile of its
REM top-left cell: 0 floor, 1 an orb, 5 a prism, 9 the lair's door, 11 or more a wall (the CONSTs below say what lumen.assets.gen.mjs says; `--check` compares).
REM The HUD costs about 1,800 T for each text cell it prints in a fine scene, so only the numbers that changed are printed.
REM   Compile:  node arcade/tools/arcadec.mjs arcade/examples/lumen.arc --assets arcade/examples/lumen.assets.json --runtime v2
GAME "Lumen"
FRAMERATE 20

CONST TORB = 1
CONST TPRISM = 5
CONST TDOOR = 9
CONST TWALL = 11
CONST STARTX = 112                  REM the wisp starts on block (7, 7)
CONST STARTY = 120
CONST LAIRY = 88                    REM the lair is the blocks (7, 5) and (8, 5), behind the door (blocks (7, 4) and (8, 4))

MAP maze1 = "maze1"
MAP maze2 = "maze2"
MAP logo = "logo"
MAP press = "press"
MAP over = "over"
SPRITE wispa = "wispa"
SPRITE wispb = "wispb"
SPRITE ember(1) = "ember"
SPRITE bloom(1) = "bloom"
SPRITE moss(1) = "moss"
SPRITE frost(1) = "frost"
SPRITE pale(4) = "pale"
TILESET gfx = "gfx"
SFX sorb = "orb"
SFX sprism = "prism"
SFX sgulp = "gulp"
SFX slost = "lost"
SFX sclear = "clear"
SFX sover = "over"
MUSIC mdrip = "drip"
MUSIC mcave = "cave"

REM The score, the best score and the cave number belong to the whole game: the game over scene shows them.
DIM score, best, cave, nbest

SCENE title
  PROC INIT():
    BORDER 0
    INK 7 : PAPER 0 : BRIGHT 0
    CLS
    PLAY mdrip
    LOADMAP logo AT 11, 3
    PRINT AT 6, 4; "EAT ALL THE LIGHT ORBS.";
    SHOW wispa AT 40, 64
    SHOW ember(0) AT 76, 64
    SHOW bloom(0) AT 108, 64
    SHOW moss(0) AT 140, 64
    SHOW frost(0) AT 172, 64
    SHOW pale(0) AT 204, 64
    INK 5 : PRINT AT 11, 2; "A PRISM TURNS THE SHADES PALE:";
    INK 6 : PRINT AT 12, 2; "TOUCH THEM FOR 200 TO 1600.";
    LOADMAP press AT 7, 15
    INK 4 : PRINT AT 18, 3; "MOVE WITH Q A O P";
    PRINT AT 19, 3; "OR JOYSTICK 1";
    INK 3 : PRINT AT 21, 11; "BEST "; best;
  ENDP

  PROC FRAME():
    IF KEYDOWN(" ") OR BIT(STICK(1), 4) THEN ENTER play ENDIF
  ENDP
ENDSCENE

SCENE play
  DIM js, ku, kd, kl, kr, wx, wy, wdir, wd, nw, wf, wbx, wby, cb, tk
  DIM sstp, srem, sdir, fnew
  DIM dbx, dby, dbase, dback, dn, dt, dd, bd, bk
  DIM ex, ey, tt
  DIM lives, orbs, scn, bn, pz, pr, pw, pwmax, eatn, fast, gap, hs, hl, hc
  REM the maze as the program sees it: 0 open, 1 the lair's door (a wall to the wisp, open to the shades going up), 2 a wall, 3 the lair
  DIM mz(175)
  REM the directions: 0 up, 1 down, 2 left, 3 right (the STICK bits); the step in x, in y and in the block index
  DIM ddx(3) = 0, 0, -1, 1
  DIM ddy(3) = -1, 1, 0, 0
  DIM ddi(3) = -16, 16, -1, 1
  REM the shades 0..3: position, direction, state (0 in the lair, 1 out, 2 pale), the wait in the lair, the form shown (0 its own colour, 1 pale), its chance of chasing
  DIM sx(3), sy(3), sd(3), pst(3), tmr(3), fm(3), ch(3)
  DIM chb(3) = 50, 40, 30, 20
  DIM cand(3)

  PROC INIT():
    BORDER 0
    score = 0 : cave = 1 : nbest = 0
    lives = 3
    INK 6 : PAPER 0 : BRIGHT 0
    PRINT AT 0, 1; "SCORE"; : PRINT AT 0, 25; "CAVE";
    PRINT AT 23, 1; "LIVES"; : PRINT AT 23, 24; "BEST "; best;
    hs = 1 : hl = 1 : hc = 1
    PLAY mcave
    CALL STARTCAVE()
  ENDP

  REM Start cave number `cave`: the maze (cave 1 is on the screen already: the first MAP), the actors, the banner.  The maze is read into mz a block row a tick during the banner.
  PROC STARTCAVE():
    IF cave > 1 THEN
      HIDE wispa : HIDE wispb
      FOR i = 0 TO 3
        CALL HIDEFORM(i)
      NEXT i
      IF BAND(cave, 1) = 1 THEN LOADMAP maze1 ELSE LOADMAP maze2 ENDIF
    ENDIF
    orbs = 0 : scn = 0
    fast = 2 * cave - 1 : IF fast > 7 THEN fast = 7 ENDIF
    pwmax = 220 - 24 * cave : IF pwmax < 70 THEN pwmax = 70 ENDIF
    gap = 60 - 6 * cave : IF gap < 16 THEN gap = 16 ENDIF
    FOR i = 0 TO 3
      ch(i) = chb(i) + 8 * cave : IF ch(i) > 95 THEN ch(i) = 95 ENDIF
    NEXT i
    CALL RESETACTORS()
    bn = 30
    hc = 1
    INK 6 : PAPER 0 : BRIGHT 0
    PRINT AT 23, 13; "CAVE "; cave;
  ENDP

  REM The wisp on its start block, the four shades in the lair (each waits its turn), no prism running.  (The old forms of the shades are hidden first.)
  PROC RESETACTORS():
    FOR i = 0 TO 3
      CALL HIDEFORM(i)
      pst(i) = 0 : fm(i) = 0 : sd(i) = 0
      sx(i) = 112 + 4 * i : sy(i) = LAIRY
      tmr(i) = 20 + i * gap
      CALL SHOWSH(i)
    NEXT i
    HIDE wispb
    wx = STARTX : wy = STARTY : wdir = -1 : wd = -1 : wf = 0
    SHOW wispa AT wx, wy
    pw = 0 : eatn = 0
  ENDP

  REM Scan the maze row r (block row): read each block's top-left cell; count the orbs.
  PROC SCANROW(r):
    FOR j = 0 TO 15
      tt = TILEAT(2 * j, 1 + 2 * r)
      IF tt >= TWALL THEN
        mz(r * 16 + j) = 2
      ELSE
        IF tt = TDOOR THEN
          mz(r * 16 + j) = 1
        ELSE
          mz(r * 16 + j) = 0
          IF tt = TORB THEN orbs = orbs + 1 ENDIF
        ENDIF
      ENDIF
    NEXT j
    IF r = 5 THEN mz(87) = 3 : mz(88) = 3 ENDIF
  ENDP

  PROC SHOWHUD():
    INK 6 : PAPER 0 : BRIGHT 0
    IF hs THEN PRINT AT 0, 7; score; : hs = 0 ENDIF
    IF hc THEN PRINT AT 0, 30; cave; : hc = 0 ENDIF
    IF hl THEN PRINT AT 23, 7; lives; : hl = 0 ENDIF
  ENDP

  PROC FRAME():
    tk = BAND(tk + 1, 1023)
    IF pz > 0 THEN
      CALL PAUSED()
    ELSE
      IF bn > 0 THEN
        CALL BANNER()
      ELSE
        CALL PLAYING()
      ENDIF
    ENDIF
    IF hs + hl + hc > 0 THEN CALL SHOWHUD() ENDIF
  ENDP

  REM The banner: the maze is scanned a row a tick, then the word goes and the shades' waits start.
  PROC BANNER():
    bn = bn - 1
    IF scn < 11 THEN
      CALL SCANROW(scn)
      scn = scn + 1
    ENDIF
    IF bn = 0 THEN FILLC 13, 23, 9, 1 = 32 ENDIF
  ENDP

  REM A pause (a life lost, a cave cleared): nothing moves; at its end the game goes on, or is over.
  PROC PAUSED():
    pz = pz - 1
    IF pz = 0 THEN
      IF pr = 2 THEN
        cave = cave + 1
        CALL STARTCAVE()
      ELSE
        IF lives <= 0 THEN
          IF score > best THEN best = score : nbest = 1 ENDIF
          ENTER over
        ELSE
          CALL RESETACTORS()
        ENDIF
      ENDIF
    ENDIF
  ENDP

  PROC PLAYING():
    CALL READKEYS()
    CALL MOVEWISP()
    IF pz = 0 THEN
      FOR i = 0 TO 3
        CALL MOVESH(i)
      NEXT i
      IF pw > 0 THEN
        pw = pw - 1
        IF pw = 0 THEN CALL PALEOFF() ENDIF
      ENDIF
      FOR i = 0 TO 3
        IF pz = 0 AND pst(i) > 0 THEN
          IF ABS(wx - sx(i)) < 10 AND ABS(wy - sy(i)) < 10 THEN
            IF pst(i) = 2 THEN CALL EATSHADE(i) ELSE CALL LOSELIFE() ENDIF
          ENDIF
        ENDIF
      NEXT i
    ENDIF
    CALL SHOWWISP()
  ENDP

  REM The direction keys: a direction is asked for by its key; of several keys the ones for another direction than the wisp's own win, and a key held for the wisp's own direction
  REM cancels a turn asked for before.  What was asked for is kept (until the next press), so a turn can be asked for a little before the boundary.
  PROC READKEYS():
    js = STICK(1)
    ku = KEYDOWN("Q") OR BIT(js, 0)
    kd = KEYDOWN("A") OR BIT(js, 1)
    kl = KEYDOWN("O") OR BIT(js, 2)
    kr = KEYDOWN("P") OR BIT(js, 3)
    nw = -1
    IF ku THEN nw = 0 ENDIF
    IF kd THEN nw = 1 ENDIF
    IF kl THEN nw = 2 ENDIF
    IF kr THEN nw = 3 ENDIF
    IF ku AND wdir <> 0 THEN nw = 0 ENDIF
    IF kd AND wdir <> 1 THEN nw = 1 ENDIF
    IF kl AND wdir <> 2 THEN nw = 2 ENDIF
    IF kr AND wdir <> 3 THEN nw = 3 ENDIF
    IF nw >= 0 THEN wd = nw ENDIF
  ENDP

  REM The wisp: 4 pixels a tick; it turns only on a block boundary into a free block, reverses at any time, stops against a wall; arriving on a block it eats what is there.
  PROC MOVEWISP():
    IF wdir >= 0 AND wd >= 0 THEN
      IF wd = BXOR(wdir, 1) THEN wdir = wd ENDIF
    ENDIF
    IF BAND(wx, 15) = 0 AND BAND(wy, 15) = 8 THEN
      cb = SHR(wy - 8, 4) * 16 + SHR(wx, 4)
      IF wd >= 0 THEN
        IF mz(cb + ddi(wd)) = 0 THEN wdir = wd ENDIF
      ENDIF
      IF wdir >= 0 THEN
        IF mz(cb + ddi(wdir)) <> 0 THEN wdir = -1 ENDIF
      ENDIF
    ENDIF
    IF wdir >= 0 THEN
      wx = wx + 4 * ddx(wdir)
      wy = wy + 4 * ddy(wdir)
      IF BAND(wx, 15) = 0 AND BAND(wy, 15) = 8 THEN CALL EAT() ENDIF
    ENDIF
    wbx = SHR(wx + 8, 4) : wby = SHR(wy, 4)
  ENDP

  REM The wisp has arrived on a block: an orb is eaten (10), a prism (50: the shades turn pale); the last orb clears the cave.
  PROC EAT():
    ex = SHR(wx, 4) * 2 : ey = SHR(wy - 8, 4) * 2 + 1
    tt = TILEAT(ex, ey)
    IF tt = TORB THEN
      CALL CLEARCELLS()
      score = score + 10 : IF score > 30000 THEN score = 30000 ENDIF
      hs = 1
      orbs = orbs - 1
      IF orbs = 0 THEN
        score = score + 100 * cave : IF score > 30000 THEN score = 30000 ENDIF
        pz = 24 : pr = 2
        PLAY sclear
      ELSE
        PLAY sorb
      ENDIF
    ENDIF
    IF tt = TPRISM THEN
      CALL CLEARCELLS()
      score = score + 50
      hs = 1
      CALL PALEON()
      PLAY sprism
    ENDIF
  ENDP

  PROC CLEARCELLS():
    TILE ex, ey = 0 : TILE ex + 1, ey = 0
    TILE ex, ey + 1 = 0 : TILE ex + 1, ey + 1 = 0
  ENDP

  PROC SHOWWISP():
    fnew = SHR(BAND(tk, 2), 1)
    IF fnew <> wf THEN
      IF wf = 0 THEN HIDE wispa ELSE HIDE wispb ENDIF
      wf = fnew
    ENDIF
    IF wf = 0 THEN SHOW wispa AT wx, wy ELSE SHOW wispb AT wx, wy ENDIF
  ENDP

  REM A prism: every shade outside the lair turns pale and turns round; the first shade eaten is worth 200, then 400, 800, 1600.
  PROC PALEON()
    pw = pwmax : eatn = 0
    FOR i = 0 TO 3
      IF pst(i) = 1 THEN
        pst(i) = 2
        sd(i) = BXOR(sd(i), 1)
      ENDIF
    NEXT i
  ENDP

  PROC PALEOFF()
    FOR i = 0 TO 3
      IF pst(i) = 2 THEN pst(i) = 1 ENDIF
    NEXT i
  ENDP

  REM Shade sn: waiting in the lair, or going out through the door, or moving through the maze.
  PROC MOVESH(sn):
    IF pst(sn) = 0 THEN
      IF tmr(sn) > 0 THEN
        tmr(sn) = tmr(sn) - 1
      ELSE
        pst(sn) = 1
        sx(sn) = 112 + 16 * BAND(sn, 1) : sy(sn) = LAIRY : sd(sn) = 0
        CALL SHOWSH(sn)
      ENDIF
    ELSE
      CALL STEPSH(sn)
    ENDIF
  ENDP

  REM 2 pixels a tick, or 4 on some ticks (more of them each cave); pale shades are slow.  A step never goes past the next block boundary.
  PROC STEPSH(sn):
    sstp = 2
    IF pst(sn) = 1 AND BAND(tk + 3 * sn, 7) < fast THEN sstp = 4 ENDIF
    IF BAND(sx(sn), 15) = 0 AND BAND(sy(sn), 15) = 8 THEN
      CALL DECIDE(sn)
      srem = 16
    ELSE
      SELECT CASE sd(sn)
        CASE 0
          srem = BAND(sy(sn) - 8, 15)
        CASE 1
          srem = 16 - BAND(sy(sn) - 8, 15)
        CASE 2
          srem = BAND(sx(sn), 15)
        CASE ELSE
          srem = 16 - BAND(sx(sn), 15)
      ENDSEL
    ENDIF
    IF sstp > srem THEN sstp = srem ENDIF
    sdir = sd(sn)
    sx(sn) = sx(sn) + ddx(sdir) * sstp
    sy(sn) = sy(sn) + ddy(sdir) * sstp
    CALL SHOWSH(sn)
  ENDP

  REM On a boundary a shade takes one of the open directions other than back the way it came (back only at a dead end; the door only upwards): with its chance the one nearest
  REM the wisp (a pale shade: the farthest), else a random one.
  PROC DECIDE(sn):
    dbx = SHR(sx(sn), 4) : dby = SHR(sy(sn) - 8, 4)
    dbase = dby * 16 + dbx
    dback = BXOR(sd(sn), 1)
    dn = 0
    FOR i = 0 TO 3
      IF i <> dback THEN
        dt = mz(dbase + ddi(i))
        IF dt = 0 OR (dt = 1 AND i = 0) THEN
          cand(dn) = i : dn = dn + 1
        ENDIF
      ENDIF
    NEXT i
    IF dn = 0 THEN
      sd(sn) = dback
    ELSE
      IF dn = 1 THEN
        sd(sn) = cand(0)
      ELSE
        IF RND(100) < ch(sn) THEN
          bd = 99 : bk = cand(0)
          FOR j = 0 TO dn - 1
            dd = ABS(dbx + ddx(cand(j)) - wbx) + ABS(dby + ddy(cand(j)) - wby)
            IF pst(sn) = 2 THEN dd = 0 - dd ENDIF
            IF dd < bd THEN bd = dd : bk = cand(j) ENDIF
          NEXT j
          sd(sn) = bk
        ELSE
          sd(sn) = cand(RND(dn))
        ENDIF
      ENDIF
    ENDIF
  ENDP

  REM Show shade sn in the form it should have: its own colour, or pale (a pale shade flickers back to its colour in its last 30 ticks).
  PROC SHOWSH(sn):
    fnew = 0
    IF pst(sn) = 2 THEN
      fnew = 1
      IF pw < 30 AND BAND(pw, 4) = 0 THEN fnew = 0 ENDIF
    ENDIF
    IF fnew <> fm(sn) THEN
      CALL HIDEFORM(sn)
      fm(sn) = fnew
    ENDIF
    IF fnew = 1 THEN
      SHOW pale(sn) AT sx(sn), sy(sn)
    ELSE
      SELECT CASE sn
        CASE 0
          SHOW ember(0) AT sx(sn), sy(sn)
        CASE 1
          SHOW bloom(0) AT sx(sn), sy(sn)
        CASE 2
          SHOW moss(0) AT sx(sn), sy(sn)
        CASE ELSE
          SHOW frost(0) AT sx(sn), sy(sn)
      ENDSEL
    ENDIF
  ENDP

  PROC HIDEFORM(sn):
    IF fm(sn) = 1 THEN
      HIDE pale(sn)
    ELSE
      SELECT CASE sn
        CASE 0
          HIDE ember(0)
        CASE 1
          HIDE bloom(0)
        CASE 2
          HIDE moss(0)
        CASE ELSE
          HIDE frost(0)
      ENDSEL
    ENDIF
  ENDP

  REM A pale shade is touched: 200, 400, 800, 1600 in one prism, and it goes back to the lair, where it waits a moment.
  PROC EATSHADE(sn):
    score = score + SHL(200, eatn) : IF score > 30000 THEN score = 30000 ENDIF
    IF eatn < 3 THEN eatn = eatn + 1 ENDIF
    hs = 1
    CALL HIDEFORM(sn)
    pst(sn) = 0 : fm(sn) = 0 : sd(sn) = 0
    sx(sn) = 112 + 4 * sn : sy(sn) = LAIRY
    tmr(sn) = 40
    CALL SHOWSH(sn)
    PLAY sgulp
  ENDP

  REM A shade touches the wisp: a life is lost; everything stops for a moment, then the actors go back to the start (the orbs stay eaten).
  PROC LOSELIFE():
    lives = lives - 1
    hl = 1
    pz = 30 : pr = 1
    PLAY slost
  ENDP
ENDSCENE

SCENE over
  DIM ow, rel, fire
  PROC INIT():
    BORDER 0
    INK 6 : PAPER 0 : BRIGHT 0
    CLS
    NOMUSIC
    PLAY sover
    LOADMAP over AT 7, 3
    PRINT AT 8, 11; "SCORE "; score;
    INK 5 : PRINT AT 10, 11; "CAVE "; cave;
    INK 4 : PRINT AT 12, 11; "BEST "; best;
    IF nbest THEN
      INK 7 : PRINT AT 14, 11; "NEW BEST!";
    ENDIF
    LOADMAP press AT 7, 18
  ENDP

  REM Fire restarts once it has been released and pressed again (it is usually still down when the scene starts).
  PROC FRAME():
    ow = ow + 1
    fire = KEYDOWN(" ") OR BIT(STICK(1), 4)
    IF fire = 0 THEN rel = 1 ENDIF
    IF fire AND rel AND ow > 20 THEN ENTER play ENDIF
  ENDP
ENDSCENE
