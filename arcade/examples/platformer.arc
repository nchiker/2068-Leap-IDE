REM Leap Runner: the acceptance game of the platformer slice (docs/ARCADE_PLATFORMER_CONTRACT.md section 8): a side-scrolling
REM platformer for the v3 runtime.  Assets (hero, walker, bat, coin, the tiles, the world map, six sounds, all named pf-...) are in
REM platformer.assets.json, drawn and laid out by platformer.assets.gen.mjs; the level data below (CXS/CYS, SX/SY/STY, CKX/CKY) is
REM printed by  node arcade/examples/platformer.assets.gen.mjs --data  and checked against the map by tests/arcade-m6-platformer.mjs.
REM   Keyboard: O left, P right, Q or SPACE jump (hold for a higher jump), A drop through a plank.   Joystick 1: the stick and fire.
REM   128 x 16 cell world, three bands (2 / 3 / 11 rows at 1/4, 1/2, 1/1).  Stomp the walkers and bats by jumping on them (HIT while
REM   falling), touch them from the side and you lose a life (brief invulnerability); spikes and the pit send you to the last checkpoint.
REM   50 coins (pickup tiles, a spinning sprite over each one in view), a flag at the far end.
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

REM instances: coins first, the hero last (a later instance is drawn on top): 6 + 4 + 2 + 1 = 13 of the 16
SPRITE cn(6) = "pf-coin"
SPRITE wk(4) = "pf-walker"
SPRITE fl(2) = "pf-bat"
SPRITE hero = "pf-hero"
TILESET pf = "pf-tiles"
MAP level = "pf-world"
SFX jump = "pf-jump"
SFX coin = "pf-coin"
SFX stomp = "pf-stomp"
SFX hurt = "pf-hurt"
SFX win = "pf-win"
SFX over = "pf-over"

WINDOW level
BAND 2, 1, 4
BAND 3, 1, 2
BAND 11, 1, 1

SCENE play
  REM st: 0 title, 1 playing, 2 level complete, 3 game over
  DIM st, tt, fc, js, lf, rg, up, dn, fire, jmp, pj, pfire
  DIM px, py, x8, vx, vy, face, gnd, cg, anim, fr, inv, dropt, fx
  DIM lives, score, coins, hud, ck, rx, ry
  DIM cam, nx, cf, cnp, cr, cdirty, cnx
  DIM csx(5), csy(5)
  REM the coins (sorted by x): their cell's pixel position and whether taken
  DIM cxs(49) = 64, 72, 80, 96, 104, 112, 120, 192, 200, 304, 312, 320, 328, 352, 360, 368, 376, 424, 432, 440, 464, 496, 504, 512, 520, 528, 536, 568, 576, 616, 624, 640, 648, 696, 704, 720, 728, 752, 760, 800, 808, 832, 840, 848, 888, 896, 912, 920, 944, 952
  DIM cys(49) = 104, 104, 104, 88, 80, 80, 88, 104, 104, 80, 80, 80, 80, 80, 80, 80, 80, 96, 88, 96, 96, 80, 80, 64, 64, 64, 64, 96, 96, 80, 80, 96, 96, 88, 88, 72, 72, 88, 88, 96, 96, 104, 104, 96, 96, 96, 80, 80, 104, 104
  DIM cc(49)
  REM the enemies (sorted by x): spawn position, type (0 walker, 1 bat), killed; and the checkpoints
  DIM sx(10) = 160, 288, 368, 464, 496, 528, 640, 704, 800, 880, 944
  DIM sy(10) = 96, 96, 56, 88, 56, 80, 64, 80, 56, 96, 96
  DIM sty(10) = 0, 0, 1, 0, 1, 0, 1, 0, 1, 0, 0
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
    up = KEYDOWN("Q") OR BIT(js, 0)
    dn = KEYDOWN("A") OR BIT(js, 1)
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

  REM The title: the level scrolls by itself (the camera ping-pongs along the world); fire starts the game.
  PROC TITLEINIT():
    LOCAL i
    st = 0 : tt = 0 : cam = 0
    HIDE hero
    CALL CLEARENEMIES()
    FOR i = 0 TO NC - 1
      cc(i) = 0
      SETWORLD cxs(i), cys(i) = 6
    NEXT i
    cf = 0 : cnp = 6 : cdirty = 1
    INK 7 : PAPER 0 : BRIGHT 1
    FILLC 0, 0, 32, 4 = 32
    FILLC 0, 20, 32, 4 = 32
    INK 6 : PRINT AT 1, 10; "LEAP RUNNER";
    PRINT AT 21, 6; "PRESS SPACE OR FIRE";
    PRINT AT 22, 4; "O P MOVE   Q OR SPACE JUMP";
  ENDP

  PROC TITLETICK():
    LOCAL p
    p = (tt * 2) MOD 1664
    IF p > 832 THEN p = 1664 - p ENDIF
    IF tt > 8000 THEN tt = 0 ENDIF
    CAMERA p
    cam = CAMX()
    CALL SPINCOINS()
    IF fire AND (NOT pfire) THEN CALL NEWGAME() ENDIF
  ENDP

  PROC NEWGAME():
    LOCAL i
    score = 0 : lives = 3 : coins = 0 : ck = 0 : hud = 1
    rx = 24 : ry = 88 : cnx = ckx(0)
    FOR i = 0 TO NS - 1
      sd(i) = 0
    NEXT i
    INK 7 : PAPER 0 : BRIGHT 1
    FILLC 0, 0, 32, 4 = 32
    FILLC 0, 21, 32, 1 = 32
    st = 1 : tt = 0 : inv = 0 : dropt = 0 : pj = 1
    CALL RESPAWN()
  ENDP

  REM Put the player at the checkpoint, the camera on him, the enemies back to where the camera is.
  PROC RESPAWN():
    px = rx : py = ry : x8 = px * 8 : vx = 0 : vy = 0 : face = 1 : gnd = 1 : cg = 3
    cam = px - LZ
    CAMERA cam
    cam = CAMX()
    CALL CLEARENEMIES()
    nx = 0
    WHILE nx < NS AND sx(nx) < cam - 48
      nx = nx + 1
    WEND
    cf = 0 : cdirty = 1
    WHILE cf < NC AND cxs(cf) + 8 <= cam
      cf = cf + 1
    WEND
  ENDP

  PROC PLAYTICK():
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
      IF hud THEN CALL SHOWHUD() ENDIF
    ENDIF
  ENDP

  REM Level complete (2) and game over (3): the world stays up; fire (after half a second) goes back to the title.
  PROC ENDTICK():
    IF st = 2 THEN
      SHOW hero AT px, py FRAME 5 + BAND(SHR(tt, 2), 1)
    ENDIF
    CALL SPINCOINS()
    IF tt > 10 AND fire AND (NOT pfire) THEN CALL TITLEINIT() ENDIF
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
    REM vertical: gravity, then land on a solid tile, on a plank the feet cross, or bump the head
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
    REM what the box touches: hazard (2), pickup (4), goal (16)
    fx = TILEHIT(px + BX, py + BY, BW, BH, 22)
    IF fx <> 0 THEN
      IF BAND(fx, 16) <> 0 THEN
        CALL WIN()
      ELSE
        IF BAND(fx, 4) <> 0 THEN CALL PICKUP() ENDIF
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

  REM Take the coins the box overlaps (the coins list is sorted by x; the pickup tile goes with SETWORLD).
  PROC PICKUP():
    LOCAL k
    k = cf
    WHILE k < NC
      IF cxs(k) >= px + BX + BW THEN EXIT WHILE ENDIF
      IF cc(k) = 0 AND cxs(k) + 8 > px + BX AND cys(k) < py + BY + BH AND cys(k) + 8 > py + BY THEN
        cc(k) = 1
        SETWORLD cxs(k), cys(k) = 0
        coins = coins + 1 : score = score + 10 : hud = 1 : cdirty = 1
        PLAY coin
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
    lives = lives - 1 : hud = 1
    IF lives <= 0 THEN
      CALL GAMEOVER()
    ELSE
      inv = 40 : vy = -5 : vx = 0 - face * 16 : gnd = 0
      PLAY hurt
    ENDIF
  ENDP

  REM A hazard or the pit: a life, back to the last checkpoint.
  PROC DIE():
    lives = lives - 1 : hud = 1
    IF lives <= 0 THEN
      CALL GAMEOVER()
    ELSE
      PLAY hurt
      inv = 30
      CALL RESPAWN()
    ENDIF
  ENDP

  PROC GAMEOVER():
    st = 3 : tt = 0
    HIDE hero
    CALL CLEARENEMIES()
    PLAY over
    INK 2 : PAPER 0 : BRIGHT 1
    FILLC 0, 21, 32, 2 = 32
    PRINT AT 21, 11; "GAME OVER";
    CALL ENDTEXT()
  ENDP

  PROC WIN():
    st = 2 : tt = 0 : score = score + 500 : vx = 0 : vy = 0
    CALL CLEARENEMIES()
    PLAY win
    INK 6 : PAPER 0 : BRIGHT 1
    FILLC 0, 21, 32, 2 = 32
    PRINT AT 21, 8; "LEVEL COMPLETE!";
    CALL ENDTEXT()
  ENDP

  REM The common last line of the two end screens; the score is printed again (the last coin or stomp may not have been).
  PROC ENDTEXT():
    CALL SHOWHUD()
    INK 7 : PAPER 0 : BRIGHT 1
    PRINT AT 22, 7; "PRESS FIRE FOR TITLE";
  ENDP

  PROC CLEARENEMIES():
    LOCAL i
    FOR i = 0 TO 5
      en(i) = 0
      HIDE wk(i) : HIDE fl(i - 4)
    NEXT i
  ENDP

  PROC SHOWHUD():
    INK 7 : PAPER 0 : BRIGHT 1
    PRINT AT 1, 2; "SCORE";
    PRINT AT 1, 16; "LIVES";
    PRINT AT 2, 2; "COINS";
    INK 6
    PRINT AT 1, 8; score; " ";
    PRINT AT 1, 22; lives;
    PRINT AT 2, 8; coins; "/50";
    hud = 0
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- enemies
  PROC ENEMIES():
    LOCAL i
    CALL SPAWNER()
    FOR i = 0 TO 3
      IF en(i) THEN CALL WALKER(i) ENDIF
    NEXT i
    FOR i = 4 TO 5
      IF en(i) THEN CALL BAT(i) ENDIF
    NEXT i
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

  REM A walker patrols its ground at 2 pixels a tick and turns at a wall or an edge; the test is made once a tile.
  PROC WALKER(i):
    LOCAL ax, f, x, d
    d = ed(i)
    x = ex(i) + d * 2
    IF x < cam - 48 THEN
      en(i) = 0
      HIDE wk(i)
    ELSE
      IF BAND(x, 7) = 0 THEN
        IF d > 0 THEN ax = x + 16 ELSE ax = x - 1 ENDIF
        IF SOLID(ax, ey(i) + 4, 1, 8) THEN
          d = 0 - d
        ELSE
          IF NOT TILEHIT(ax, ey(i) + 16, 1, 1, 9) THEN d = 0 - d ENDIF
        ENDIF
        ed(i) = d
      ENDIF
      ex(i) = x
      f = BAND(SHR(x, 3), 1)
      IF d > 0 THEN
        SHOW wk(i) AT x, ey(i) FRAME f
      ELSE
        SHOW wk(i) AT x, ey(i) FRAME f FLIP
      ENDIF
      IF ABS(x - px) < 20 THEN
        IF HIT(hero, wk(i)) THEN CALL TOUCH(i) ENDIF
      ENDIF
    ENDIF
  ENDP

  REM A bat flies to and fro 56 pixels either side of where it appeared and bobs on the sine table.
  PROC BAT(i):
    LOCAL f, x, y
    x = ex(i) + ed(i) * 2
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
      IF ABS(x - px) < 20 THEN
        IF HIT(hero, fl(i - 4)) THEN CALL TOUCH(i) ENDIF
      ENDIF
    ENDIF
  ENDP

  REM The player met enemy slot i: falling onto it from above stomps it, anything else hurts.
  PROC TOUCH(i):
    IF vy > 0 AND py <= ey(i) - 12 THEN
      en(i) = 0 : sd(ek(i)) = 1
      HIDE wk(i) : HIDE fl(i - 4)
      vy = -6 : score = score + 100 : hud = 1
      PLAY stomp
    ELSE
      IF inv = 0 THEN CALL HURT() ENDIF
    ENDIF
  ENDP

  REM ---------------------------------------------------------------------------------------------------------------- coins
  REM Up to six spinning coins are drawn over the pickup tiles of the coins in view (the tile itself shows a still coin, so a
  REM seventh coin in view is still there, only not spinning).  The list is sorted by x: CF is the first coin not left of the
  REM camera.  Coins do not move, so the six slots are mapped (CSX / CSY) only when something changes (CF moves on, a coin is
  REM taken, a new coin comes into view on the right) and a slot is drawn again, with the next spin frame, once every 4 ticks
  REM (slot s on the ticks where fc MOD 4 = s MOD 4), which spreads the SHOWs over the ticks.
  PROC SPINCOINS():
    LOCAL n, k, f
    WHILE cf < NC AND cxs(cf) + 8 <= cam
      cf = cf + 1 : cdirty = 1
    WEND
    IF cdirty = 0 AND cnp < 6 AND cr < NC THEN
      IF cxs(cr) < cam + 192 THEN cdirty = 1 ENDIF
    ENDIF
    f = BAND(SHR(fc, 2), 3)
    IF cdirty THEN
      n = 0 : k = cf
      WHILE n < 6 AND k < NC
        IF cxs(k) >= cam + 192 THEN EXIT WHILE ENDIF
        IF cc(k) = 0 THEN
          csx(n) = cxs(k) : csy(n) = cys(k)
          SHOW cn(n) AT csx(n), csy(n) FRAME f
          n = n + 1
        ENDIF
        k = k + 1
      WEND
      cr = k
      FOR k = n TO cnp - 1
        HIDE cn(k)
      NEXT k
      cnp = n : cdirty = 0
    ELSE
      k = BAND(fc, 3)
      IF k < cnp THEN SHOW cn(k) AT csx(k), csy(k) FRAME f ENDIF
      k = k + 4
      IF k < cnp THEN SHOW cn(k) AT csx(k), csy(k) FRAME f ENDIF
    ENDIF
  ENDP
ENDSCENE
