REM Leap Runner: the acceptance game of the platformer slice (docs/ARCADE_PLATFORMER_CONTRACT.md section 8): a side-scrolling
REM platformer for the v3 runtime.  Assets (hero, walker, bat, the tiles (coins are tiles), the world map, six sounds, all named pf_...) are in
REM platformer.assets.json, drawn and laid out by platformer.assets.gen.mjs; the level data below (CXS/CYS, SX/SY/STY, WLO/WHI, CKX/CKY, RCF/RNX, CIX) is
REM printed by  node arcade/examples/platformer.assets.gen.mjs --data  and checked against the map by tests/arcade-m6-platformer.mjs.
REM   Keyboard: O left, P right, Q or SPACE jump (hold for a higher jump), A drop through a plank.   Joystick 1: the stick and fire.
REM   128 x 16 cell world, three bands (2 / 3 / 11 rows at 1/4, 1/2, 1/1).  Stomp the walkers and bats by jumping on them (HIT while
REM   falling), touch them from the side and you lose a life (brief invulnerability); spikes and the pit send you to the last checkpoint.
REM   50 coins (pickup tiles that spin by tile swaps), a flag at the far end.
REM   Compile:  node arcade/tools/arcadec.mjs arcade/examples/platformer.arc --assets arcade/examples/platformer.assets.json --runtime v3
GAME "Leap Runner"
FRAMERATE 20

REM level and physics.  Positions are pixels; the player's x also lives in 1/8 pixels (x8) for smooth acceleration.
CONST NC = 50
CONST NS = 11
CONST BX = 3
CONST BY = 2
CONST BW = 10
CONST BH = 22
CONST ACC = 4
CONST VMAX = 20
CONST FRIC = 4
CONST GRAV = 1
CONST VFALL = 7
CONST VJUMP = -9
CONST LZ = 72
CONST RZ = 112
CONST DEADY = 120

REM instances: the hero last (a later instance is drawn on top): 4 + 2 + 1 = 7 of the 16.  The coins are tiles (see SPINCOINS).
SPRITE wk(4) = "pf_walker"
SPRITE fl(2) = "pf_bat"
SPRITE hero = "pf_hero"
TILESET pf = "pf_tiles"
MAP level = "pf_world"
SFX jump = "pf_jump"
SFX coin = "pf_coin"
SFX stomp = "pf_stomp"
SFX hurt = "pf_hurt"
SFX win = "pf_win"
SFX over = "pf_over"

WINDOW level
BAND 2, 1, 4
BAND 3, 1, 2
BAND 11, 1, 1

SCENE play
  REM st: 0 title, 1 playing, 2 level complete, 3 game over
  DIM st, tt, fc, js, lf, rg, up, dn, fire, jmp, pj, pfire
  DIM px, py, x8, vx, vy, face, gnd, cg, anim, fr, inv, dropt, fx, tc, ltc, kq, ka, pk
  DIM lives, score, coins, hud, ck, rx, ry, ti, ei
  REM where a respawn at checkpoint ck (0 = the start) starts the coin list and the spawn list: the first coin / enemy not behind the camera
  DIM rcf(3) = 0, 13, 24, 38
  DIM rnx(3) = 0, 2, 4, 7
  REM the walkers' turning points (per spawn entry; 0 for a bat), and for the coin list the first coin not left of x = 64 b
  DIM wlo(10) = 0, 272, 0, 448, 480, 0, 688, 0, 0, 816, 928
  DIM whi(10) = 224, 432, 0, 464, 544, 0, 704, 0, 0, 896, 1008
  DIM cix(16) = 0, 0, 7, 7, 9, 11, 17, 20, 23, 28, 31, 34, 39, 41, 45, 50, 50
  DIM cam, nx, cf, cnx
  REM the coin tile's four spin frames (tiles 6, 18, 19, 18)
  DIM ct(3) = 6, 18, 19, 18
  REM the coins (sorted by x): their cell's pixel position and whether taken
  DIM cxs(49) = 64, 72, 80, 96, 104, 112, 120, 192, 200, 304, 312, 320, 328, 352, 360, 368, 376, 424, 432, 440, 464, 496, 504, 512, 520, 528, 536, 568, 576, 616, 624, 640, 648, 696, 704, 720, 728, 752, 760, 800, 808, 832, 840, 848, 888, 896, 912, 920, 944, 952
  DIM cys(49) = 104, 104, 104, 88, 80, 80, 88, 104, 104, 80, 80, 80, 80, 80, 80, 80, 80, 96, 88, 96, 96, 80, 80, 64, 64, 64, 64, 96, 96, 80, 80, 96, 96, 88, 88, 72, 72, 88, 88, 96, 96, 104, 104, 96, 96, 96, 80, 80, 104, 104
  DIM cc(49)
  REM the enemies (sorted by x): spawn position, type (0 walker, 1 bat), killed; and the checkpoints
  DIM sx(10) = 160, 288, 368, 464, 528, 584, 704, 728, 864, 880, 944
  DIM sy(10) = 96, 96, 56, 88, 80, 56, 80, 64, 56, 96, 96
  DIM sty(10) = 0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 0
  DIM sd(10)
  DIM ckx(2) = 416, 592, 832
  DIM cky(2) = 88, 88, 88
  REM six enemy slots: 0..3 walkers (sprites wk), 4..5 bats (sprites fl): alive, position, direction, spawn entry, origin x
  DIM en(5), ex(5), ey(5), ed(5), ek(5), e0(5)
  REM the bats' vertical path: a sine, +-12 pixels in 16 steps
  DIM sn(15) = 0, 5, 9, 11, 12, 11, 9, 5, 0, -5, -9, -11, -12, -11, -9, -5

  PROC INIT():
    CALL TITLEINIT()
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- states
  PROC FRAME():
    js = STICK(1)
    lf = KEYDOWN("O") OR BIT(js, 2)
    rg = KEYDOWN("P") OR BIT(js, 3)
    REM Q and A are read every other tick (a KEYDOWN is 250 T and a few hundred more to call): the jump key is read through SPACE and the stick every tick
    IF BAND(fc, 1) = 1 THEN
      kq = KEYDOWN("Q") : ka = KEYDOWN("A")
    ENDIF
    up = kq OR BIT(js, 0)
    dn = ka OR BIT(js, 1)
    fire = KEYDOWN(" ") OR BIT(js, 4)
    jmp = fire OR up
    tt = tt + 1
    fc = fc + 1
    IF fc > 30000 THEN fc = 0 ENDIF
    SELECT CASE st
      CASE 0
        CALL TITLETICK()
      CASE 1
        CALL PLAYTICK()
      CASE ELSE
        CALL ENDTICK()
    ENDSEL
    pj = jmp
    pfire = fire
  ENDP

  REM The title: the level scrolls by itself (the camera ping-pongs along the world); fire starts the game.  Everything that costs
  REM much (giving the taken coins back, clearing and printing the text cells) is done a piece a tick (TSTAGE for the title, GSTAGE
  REM for starting a game), so that no tick goes over its three refreshes: TI counts the stages, 12 = the title waits for fire.
  PROC TITLEINIT():
    st = 0 : tt = 0 : cam = 0 : ti = 0
    HIDE hero
    CALL CLEARENEMIES()
    cf = 0
  ENDP

  PROC TITLETICK():
    LOCAL p
    p = (tt * 2) MOD 1664
    IF p > 832 THEN p = 1664 - p ENDIF
    IF tt > 8000 THEN tt = 0 ENDIF
    CAMERA p
    cam = CAMX()
    CALL SPINCOINS()
    IF ti < 12 THEN
      CALL TSTAGE(ti)
      ti = ti + 1
    ELSE
      IF ti = 12 THEN
        IF fire AND (NOT pfire) THEN ti = 20 ENDIF
      ELSE
        CALL GSTAGE(ti - 20)
        ti = ti + 1
      ENDIF
    ENDIF
  ENDP

  REM Stages 0..4 give the taken coins back (ten coins a tick), 5..11 redraw the title text (a row of cells is 32 cells to redraw, about 30,000 T in both files: one row a tick).
  PROC TSTAGE(s):
    LOCAL k
    SELECT CASE s
      CASE 0, 1, 2, 3, 4
        FOR k = s * 10 TO s * 10 + 9
          IF cc(k) THEN
            cc(k) = 0
            SETWORLD cxs(k), cys(k) = 6
          ENDIF
        NEXT k
      CASE 5
        INK 7 : PAPER 0 : BRIGHT 1
        FILLC 0, 1, 32, 1 = 32
      CASE 6
        FILLC 0, 2, 32, 1 = 32
      CASE 7
        FILLC 0, 21, 32, 1 = 32
      CASE 8
        FILLC 0, 22, 32, 1 = 32
      CASE 9
        INK 6 : PRINT AT 1, 10; "LEAP RUNNER";
      CASE 10
        INK 7 : PRINT AT 21, 6; "PRESS SPACE OR FIRE";
      CASE ELSE
        PRINT AT 22, 4; "O P MOVE   Q OR SPACE JUMP";
    ENDSEL
  ENDP

  REM Starting a game takes six ticks: 0 the variables, 1 and 2 clear the title text, 3 and 4 print the HUD's labels, 5 its numbers and the first respawn.
  PROC GSTAGE(s):
    LOCAL i
    SELECT CASE s
      CASE 0
        score = 0 : lives = 3 : coins = 0 : ck = 0 : hud = 0
        rx = 24 : ry = 88 : cnx = ckx(0)
        FOR i = 0 TO NS - 1
          sd(i) = 0
        NEXT i
        inv = 0 : dropt = 0 : pj = 1 : pk = 0
      CASE 1
        INK 7 : PAPER 0 : BRIGHT 1
        FILLC 0, 1, 32, 1 = 32
      CASE 2
        FILLC 0, 21, 32, 1 = 32
      CASE 3
        PRINT AT 1, 2; "SCORE";
        PRINT AT 1, 16; "LIVES";
      CASE 4
        PRINT AT 2, 2; "COINS";
        PRINT AT 2, 10; "/50";
      CASE ELSE
        hud = 7
        WHILE hud <> 0
          CALL SHOWHUD()
        WEND
        st = 1 : tt = 0 : fc = 0
        CALL RESPAWN()
    ENDSEL
  ENDP

  REM Put the player at the checkpoint, the camera on him, the enemies and coins back to where the camera is.
  PROC RESPAWN():
    px = rx : py = ry : x8 = px * 8 : vx = 0 : vy = 0 : face = 1 : gnd = 1 : cg = 3
    cam = px - LZ
    CAMERA cam
    cam = CAMX()
    CALL CLEARENEMIES()
    nx = rnx(ck) : cf = rcf(ck)
  ENDP

  PROC PLAYTICK():
    REM a coin the box touched when the last tick asked (the search and the SETWORLD are done one tick later, away from the query's tick)
    IF pk THEN
      pk = 0
      CALL PICKUP()
    ENDIF
    CALL PLAYER()
    IF st = 1 THEN
      CALL FOLLOW()
      CALL DRAWPLAYER()
      CALL ENEMIES()
      CALL SPINCOINS()
      IF inv > 0 THEN
        inv = inv - 1
        IF inv <= 30 AND BAND(inv, 2) <> 0 THEN HIDE hero ENDIF
      ENDIF
      IF hud <> 0 AND BAND(fc, 3) = 3 THEN CALL SHOWHUD() ENDIF
    ENDIF
  ENDP

  REM Level complete (2) and game over (3): the world stays up; the end text is put up a piece a tick (EI); fire (after half a second) goes back to the title.
  PROC ENDTICK():
    IF st = 2 THEN
      SHOW hero AT px, py FRAME 5 + BAND(SHR(tt, 2), 1)
    ENDIF
    CALL SPINCOINS()
    SELECT CASE ei
      CASE 0
        WHILE hud <> 0
          CALL SHOWHUD()
        WEND
      CASE 1
        INK 7 : PAPER 0 : BRIGHT 1
        FILLC 0, 21, 32, 1 = 32
      CASE 2
        FILLC 0, 22, 32, 1 = 32
      CASE 3
        IF st = 2 THEN
          INK 6 : PRINT AT 21, 8; "LEVEL COMPLETE!";
        ELSE
          INK 2 : PRINT AT 21, 11; "GAME OVER";
        ENDIF
      CASE 4
        INK 7 : PRINT AT 22, 7; "PRESS FIRE FOR TITLE";
    ENDSEL
    IF ei < 5 THEN ei = ei + 1 ENDIF
    IF tt > 10 AND ei > 4 AND fire AND (NOT pfire) THEN CALL TITLEINIT() ENDIF
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- the player
  PROC PLAYER():
    LOCAL d, nx2, ny, r
    d = rg - lf
    IF d <> 0 THEN
      vx = vx + d * ACC
      IF vx > VMAX THEN vx = VMAX ENDIF
      IF vx < -VMAX THEN vx = -VMAX ENDIF
      face = d
    ELSE
      IF vx > 0 THEN
        vx = vx - FRIC
        IF vx < 0 THEN vx = 0 ENDIF
      ENDIF
      IF vx < 0 THEN
        vx = vx + FRIC
        IF vx > 0 THEN vx = 0 ENDIF
      ENDIF
    ENDIF
    REM horizontal: move, then if the box is inside a solid tile put its edge on the tile's face
    x8 = x8 + vx
    nx2 = SHR(x8, 3)
    IF nx2 <> px THEN
      IF SOLID(nx2 + BX, py + BY, BW, BH) THEN
        IF vx > 0 THEN
          nx2 = SHR(nx2 + BX + BW - 1, 3) * 8 - BW - BX
        ELSE
          nx2 = SHR(nx2 + BX, 3) * 8 + 8 - BX
        ENDIF
        x8 = nx2 * 8 : vx = 0
      ENDIF
      px = nx2
    ENDIF
    REM jump (with a little coyote time), variable height, drop through planks
    IF gnd THEN
      cg = 3
    ELSE
      IF cg > 0 THEN cg = cg - 1 ENDIF
    ENDIF
    IF jmp AND (NOT pj) AND cg > 0 THEN
      vy = VJUMP : cg = 0 : gnd = 0
      PLAY jump
    ENDIF
    IF (NOT jmp) AND vy < -3 THEN vy = -3 ENDIF
    IF dn THEN
      dropt = 5
    ELSE
      IF dropt > 0 THEN dropt = dropt - 1 ENDIF
    ENDIF
    REM vertical.  Standing on the ground and still over the same tiles as last tick (TC: the box's first and last tile column) nothing can have changed:
    REM no query.  Otherwise: gravity, then land on a solid tile, on a plank the feet cross, or bump the head.
    tc = SHL(SHR(px + BX, 3), 5) + SHR(px + BX + BW - 1, 3)
    IF gnd AND tc = ltc AND dropt = 0 THEN
      vy = 0
    ELSE
    vy = vy + GRAV
    IF vy > VFALL THEN vy = VFALL ENDIF
    ny = py + vy
    gnd = 0
    IF vy > 0 THEN
      IF SOLID(px + BX, ny + BY, BW, BH) THEN
        r = SHR(ny + BY + BH - 1, 3)
        ny = r * 8 - BY - BH : vy = 0 : gnd = 1
      ELSE
        IF dropt = 0 THEN
          r = SHR(ny + BY + BH - 1, 3)
          IF r > SHR(py + BY + BH - 1, 3) THEN
            IF TILEHIT(px + BX, r * 8, BW, 1, 8) THEN
              ny = r * 8 - BY - BH : vy = 0 : gnd = 1
            ENDIF
          ENDIF
        ENDIF
      ENDIF
    ELSE
      IF vy < 0 THEN
        IF SOLID(px + BX, ny + BY, BW, BH) THEN
          r = SHR(ny + BY, 3)
          ny = r * 8 + 8 - BY : vy = 0
        ENDIF
      ENDIF
    ENDIF
    py = ny
    ENDIF
    ltc = tc
    REM what the box touches: hazard (2), pickup (4), goal (16); asked every fourth tick (a query is 1,300 T; any box overlaps a coin, a spike or the flag for at least 4 ticks)
    fx = 0
    IF BAND(fc, 3) = 0 THEN fx = TILEHIT(px + BX, py + BY, BW, BH, 22) ENDIF
    IF fx <> 0 THEN
      IF BAND(fx, 16) <> 0 THEN
        CALL WIN()
      ELSE
        IF BAND(fx, 4) <> 0 THEN pk = 1 ENDIF
        IF BAND(fx, 2) <> 0 THEN CALL DIE() ENDIF
      ENDIF
    ENDIF
    IF st = 1 AND py > DEADY THEN CALL DIE() ENDIF
    IF st = 1 THEN
      IF px >= cnx THEN
        rx = ckx(ck) : ry = cky(ck) : ck = ck + 1
        IF ck < 3 THEN cnx = ckx(ck) ELSE cnx = 32000 ENDIF
      ENDIF
    ENDIF
  ENDP

  REM Take the coins the box overlaps (the coins list is sorted by x; CIX(b) is the first coin not left of x = 64 b, so the search starts near the player; the pickup tile goes with SETWORLD).
  PROC PICKUP():
    LOCAL k, x, y, lx, rx, ty, bt
    lx = px + BX : rx = lx + BW : ty = py + BY : bt = ty + BH
    k = cix(SHR(px, 6))
    WHILE k < NC
      x = cxs(k)
      IF x >= rx THEN EXIT WHILE ENDIF
      IF x + 8 > lx THEN
        y = cys(k)
        IF y < bt AND y + 8 > ty AND cc(k) = 0 THEN
          cc(k) = 1
          SETWORLD x, y = 0
          coins = coins + 1 : score = score + 10 : hud = BOR(hud, 5)
          PLAY coin
        ENDIF
      ENDIF
      k = k + 1
    WEND
  ENDP

  PROC DRAWPLAYER():
    IF inv > 30 THEN
      fr = 7
    ELSE
      IF gnd = 0 THEN
        IF vy < 0 THEN fr = 5 ELSE fr = 6 ENDIF
      ELSE
        IF ABS(vx) < 2 THEN
          fr = 0
        ELSE
          anim = anim + ABS(vx)
          IF anim > 20000 THEN anim = 0 ENDIF
          fr = 1 + BAND(SHR(anim, 6), 3)
        ENDIF
      ENDIF
    ENDIF
    IF face > 0 THEN
      SHOW hero AT px, py FRAME fr
    ELSE
      SHOW hero AT px, py FRAME fr FLIP
    ENDIF
  ENDP

  REM The camera follows with a dead zone (LZ..RZ pixels from the window's left edge); CAMERA clamps to the world.
  PROC FOLLOW():
    cam = CAMX()
    IF px - cam < LZ THEN cam = px - LZ ENDIF
    IF px + 16 - cam > RZ THEN cam = px + 16 - RZ ENDIF
    CAMERA cam
    cam = CAMX()
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- life and death
  PROC HURT():
    lives = lives - 1 : hud = BOR(hud, 2)
    IF lives <= 0 THEN
      CALL GAMEOVER()
    ELSE
      inv = 40 : vy = -5 : vx = 0 - face * 16 : gnd = 0
      PLAY hurt
    ENDIF
  ENDP

  REM A hazard or the pit: a life, back to the last checkpoint.
  PROC DIE():
    lives = lives - 1 : hud = BOR(hud, 2)
    IF lives <= 0 THEN
      CALL GAMEOVER()
    ELSE
      PLAY hurt
      inv = 30
      CALL RESPAWN()
    ENDIF
  ENDP

  PROC GAMEOVER():
    st = 3 : tt = 0 : ei = 0
    HIDE hero
    CALL CLEARENEMIES()
    PLAY over
  ENDP

  PROC WIN():
    st = 2 : tt = 0 : ei = 0 : score = score + 500 : hud = BOR(hud, 1) : vx = 0 : vy = 0
    CALL CLEARENEMIES()
    PLAY win
  ENDP

  PROC CLEARENEMIES():
    LOCAL i
    FOR i = 0 TO 5
      en(i) = 0
      HIDE wk(i) : HIDE fl(i - 4)
    NEXT i
  ENDP

  REM Prints ONE changed number a call (hud: bit 0 score, 1 lives, 2 coins; the labels are printed once, when a game starts): a number is 1,000 to 2,500 T
  REM to print and the cells it dirties are redrawn by the runtime in the next tick.  While playing it is called on every fourth tick (fc MOD 4 = 3), after
  REM the tick that asks for a coin and the one that takes it.
  PROC SHOWHUD():
    INK 6 : PAPER 0 : BRIGHT 1
    IF BAND(hud, 1) <> 0 THEN
      PRINT AT 1, 8; score;
      hud = BAND(hud, 6)
    ELSE
      IF BAND(hud, 2) <> 0 THEN
        PRINT AT 1, 22; lives;
        hud = BAND(hud, 5)
      ELSE
        PRINT AT 2, 8; coins;
        hud = BAND(hud, 3)
      ENDIF
    ENDIF
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- enemies
  PROC ENEMIES():
    LOCAL i
    CALL SPAWNER()
    IF BAND(fc, 1) = 0 THEN
      FOR i = 0 TO 3
        IF en(i) THEN CALL WALKER(i) ENDIF
      NEXT i
    ELSE
      FOR i = 4 TO 5
        IF en(i) THEN CALL BAT(i) ENDIF
      NEXT i
    ENDIF
  ENDP

  REM At most one new enemy a tick: the next entry of the sorted list when it comes within 216 pixels of the camera
  REM (a walker needs a free walker slot, a bat a free bat slot; killed or passed entries are skipped).
  PROC SPAWNER():
    LOCAL k, lo, hi
    IF nx < NS THEN
      IF sx(nx) < cam + 216 THEN
        IF sd(nx) = 0 AND sx(nx) > cam - 48 THEN
          IF sty(nx) = 0 THEN
            lo = 0 : hi = 3
          ELSE
            lo = 4 : hi = 5
          ENDIF
          FOR k = lo TO hi
            IF en(k) = 0 THEN
              en(k) = 1 : ex(k) = sx(nx) : ey(k) = sy(nx) : ek(k) = nx : e0(k) = sx(nx)
              ed(k) = -1 + sty(nx) * 2
              nx = nx + 1
              EXIT FOR
            ENDIF
          NEXT k
        ELSE
          nx = nx + 1
        ENDIF
      ENDIF
    ENDIF
  ENDP

  REM A walker patrols its ground 4 pixels every other tick (walkers on the even ticks, bats on the odd ones, which halves their cost per tick) between the two turning points of its spawn entry (WLO / WHI: where a wall or the edge of its
  REM ground is, worked out from the map by the generator and checked by the tests; no run-time query).
  PROC WALKER(i):
    LOCAL f, x, d, k
    d = ed(i) : k = ek(i)
    x = ex(i) + d * 4
    IF x < cam - 48 THEN
      en(i) = 0
      HIDE wk(i)
    ELSE
      IF x <= wlo(k) THEN
        x = wlo(k) : d = 1
      ELSE
        IF x >= whi(k) THEN x = whi(k) : d = -1 ENDIF
      ENDIF
      ed(i) = d : ex(i) = x
      f = BAND(SHR(x, 3), 1)
      IF d > 0 THEN
        SHOW wk(i) AT x, ey(i) FRAME f
      ELSE
        SHOW wk(i) AT x, ey(i) FRAME f FLIP
      ENDIF
      REM (HIT only when the boxes can overlap, and when the touch can matter: falling onto it, or not blinking: HIT is 2,400 T)
      IF ABS(x - px) < 13 AND ey(i) - py > -15 AND ey(i) - py < 21 AND (inv = 0 OR vy > 0) THEN
        IF HIT(hero, wk(i)) THEN CALL TOUCH(i) ENDIF
      ENDIF
    ENDIF
  ENDP

  REM A bat flies to and fro 56 pixels either side of where it appeared and bobs on the sine table.
  PROC BAT(i):
    LOCAL f, x, y
    x = ex(i) + ed(i) * 4
    IF x < cam - 80 THEN
      en(i) = 0
      HIDE fl(i - 4)
    ELSE
      IF ABS(x - e0(i)) > 56 THEN ed(i) = 0 - ed(i) ENDIF
      ex(i) = x
      y = sy(ek(i)) + sn(BAND(SHR(fc, 1) + i * 5, 15))
      ey(i) = y
      f = BAND(SHR(fc, 1), 1)
      SHOW fl(i - 4) AT x, y FRAME f
      IF ABS(x - px) < 12 AND y - py > -12 AND y - py < 22 AND (inv = 0 OR vy > 0) THEN
        IF HIT(hero, fl(i - 4)) THEN CALL TOUCH(i) ENDIF
      ENDIF
    ENDIF
  ENDP

  REM The player met enemy slot i: falling onto it from above stomps it, anything else hurts.
  PROC TOUCH(i):
    IF vy > 0 AND py <= ey(i) - 12 THEN
      en(i) = 0 : sd(ek(i)) = 1
      HIDE wk(i) : HIDE fl(i - 4)
      vy = -6 : gnd = 0 : score = score + 100 : hud = BOR(hud, 1)
      PLAY stomp
    ELSE
      IF inv = 0 THEN CALL HURT() ENDIF
    ENDIF
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- coins
  REM The coins spin as TILES: the pickup tile of each coin in view is swapped through its four spin frames (ct) with SETWORLD, one coin in eight a
  REM tick (coin k when k - CF is the tick's number mod 8; a turn takes 32 ticks), so one or two SETWORLDs a tick (at most 14 coins are ever in view, and the two tries a tick reach 16) and no sprite at all.  (The first version drew
  REM six 8 x 8 sprites over the still tiles: 2,400 T each in the runtime's blitter, 14,000 T on a tick with six coins in view.)  The list is
  REM sorted by x: CF is the first coin not left of the camera.  A taken coin (cc) is left alone.
  PROC SPINCOINS():
    LOCAL k, f
    WHILE cf < NC AND cxs(cf) + 8 <= cam
      cf = cf + 1
    WEND
    f = ct(BAND(SHR(fc, 3), 3))
    k = cf + BAND(fc, 7)
    IF k < NC THEN
      IF cc(k) = 0 AND cxs(k) < cam + 192 THEN SETWORLD cxs(k), cys(k) = f ENDIF
    ENDIF
    k = k + 8
    IF k < NC THEN
      IF cc(k) = 0 AND cxs(k) < cam + 192 THEN SETWORLD cxs(k), cys(k) = f ENDIF
    ENDIF
  ENDP
ENDSCENE
