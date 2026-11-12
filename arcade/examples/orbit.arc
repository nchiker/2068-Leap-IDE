REM Orbit Gates: the wireframe 3D sample game (docs/ARCADE_WIREFRAME_CONTRACT.md section 9) for the v2 runtime: a first-person flight through a course of gates.
REM Assets (the models gate and rock, the burst sprite, the title tiles, three sounds, the title song) are in orbit.assets.json, made by orbit.assets.gen.mjs.
REM   Keyboard: Q faster, A slower, O left, P right, SPACE fire.   Joystick 1: the stick and fire.   Fire starts a game (title) and goes back to the title (game over).
REM   Three scenes: title -> play -> over -> title.  The title and the game over are NOVIEW scenes (the whole cell screen, no 3D); play is the 3D flight (rows 2 to 21).
REM   The player is the EYE at (px, 0, pz) with the heading ea (256 to a turn).  The gates come one after another, 1500 units apart; the heading of the course drifts by -24 to 24 per gate.
REM   Only the current gate and the next one are drawn (and only while they are in front of the eye), plus two rocks: at most 4 models a tick.
REM   Compile:  node arcade/tools/arcadec.mjs arcade/examples/orbit.arc --assets arcade/examples/orbit.assets.json --runtime v2
GAME "Orbit Gates"
FRAMERATE 20
WIRE3D ROWS 2 TO 21 INK 5 PAPER 0 BRIGHT 1

MODEL gate = "gate"
MODEL rock = "rock"
SPRITE burst = "burst"
TILESET gfx = "gfx"
SFX chime = "chime"
SFX buzz = "buzz"
SFX crash = "crash"
MUSIC theme = "theme"

REM The game's score, the gates passed, the best score and why the flight ended (1 fuel, 2 shields) belong to the whole game: the game over shows them.
DIM score, gates, best, why

SCENE title NOVIEW
  DIM fire, rel, tw

  PROC INIT():
    PLAY theme
    BORDER 0
    PAPER 0 : INK 7 : BRIGHT 1 : CLS
    CALL STARS()
    FOR r = 0 TO 3
      FOR c = 0 TO 3
        TILE 14 + c, 3 + r = 3 + r * 4 + c
      NEXT c
    NEXT r
    INK 6 : PRINT AT 8, 10; "ORBIT  GATES";
    INK 5 : PRINT AT 10, 6; "A WIREFRAME FLIGHT IN SPACE";
    INK 7 : PRINT AT 15, 11; "BEST "; best USING "00000";
    INK 4 : PRINT AT 18, 4; "Q FASTER  A SLOWER  O P TURN";
    INK 4 : PRINT AT 19, 6; "OR JOYSTICK 1 AND FIRE";
    INK 3 : PRINT AT 21, 5; "FLY THROUGH THE GATES";
  ENDP

  REM A few stars in the corners and at the sides of the picture.
  PROC STARS():
    TILE 3, 2 = 1 : TILE 8, 5 = 2 : TILE 25, 3 = 1 : TILE 28, 6 = 2 : TILE 5, 12 = 2 : TILE 26, 12 = 1
    TILE 2, 16 = 1 : TILE 29, 17 = 2 : TILE 9, 22 = 1 : TILE 22, 23 = 2 : TILE 1, 7 = 1 : TILE 30, 9 = 1
  ENDP

  REM Fire starts the game once it has been released and pressed again (it is still down when the game over sends us here).
  PROC FRAME():
    tw = tw + 1
    fire = KEYDOWN(" ") OR BIT(STICK(1), 4)
    IF fire = 0 THEN rel = 1 ENDIF
    IF tw MOD 20 < 12 THEN
      INK 6 : PRINT AT 13, 11; "PRESS  FIRE";
    ELSE
      INK 0 : PRINT AT 13, 11; "           ";
    ENDIF
    IF fire AND rel THEN ENTER play ENDIF
  ENDP
ENDSCENE

SCENE play
  DIM px, pz, ea, spd, fuel, shd, tt, inv, fl, hud
  DIM gx, gz, gch, nx, nz, nch, pal
  DIM js, lf, rg, up, dn, dx, dz, along, side, fw, wob, w, ox, i, f, sd, ux, uz
  DIM rx(1), rz(1), ry(1), rv(1), rw(1), rp(1), rt(1)

  PROC INIT():
    NOMUSIC
    BORDER 0
    PAPER 0 : INK 6 : BRIGHT 1 : CLS
    score = 0 : gates = 0 : why = 0
    px = 0 : pz = 0 : ea = 0 : spd = 24 : fuel = 900 : shd = 3 : inv = 0 : fl = 0
    gx = 0 : gz = 1500 : gch = 0
    CALL MAKENEXT()
    CALL SETPAL()
    CALL RESPAWNROCKS()
    hud = 15
    CALL SHOWHUD()
  ENDP

  REM The next gate: 1500 units on from this one, its heading drifting by -24 to 24 (this uses the game's RND once per gate).
  PROC MAKENEXT():
    nch = BAND(gch + RND(49) - 24, 255)
    nx = gx + FXMUL(1500, SINA(nch))
    nz = gz + FXMUL(1500, COSA(nch))
  ENDP

  REM pal = how far along the gate's heading the eye is (negative: in front of the gate); the pass test looks for the change from negative to not negative.
  PROC SETPAL():
    pal = FXMUL(px - gx, SINA(gch)) + FXMUL(pz - gz, COSA(gch))
  ENDP

  REM The gate is passed or missed: the next one becomes the current one, the rocks are placed again.
  PROC ADVANCE():
    gx = nx : gz = nz : gch = nch
    CALL MAKENEXT()
    CALL SETPAL()
    CALL RESPAWNROCKS()
  ENDP

  REM Rock i again: on the way from the eye to the gate (35 to 78 per cent of it), 210 to 379 units to one side of the course.
  PROC RESPAWN(k):
    ux = gx - px : uz = gz - pz
    f = 90 + RND(110)
    sd = 210 + RND(170)
    IF RND(2) = 0 THEN sd = -sd ENDIF
    rx(k) = px + FXMUL(ux, f) + FXMUL(sd, COSA(gch))
    rz(k) = pz + FXMUL(uz, f) - FXMUL(sd, SINA(gch))
    ry(k) = RND(61) - 30
    rv(k) = 3 + RND(6)
    IF RND(2) = 0 THEN rv(k) = -rv(k) ENDIF
    rw(k) = RND(256) : rp(k) = RND(256) : rt(k) = 0
  ENDP

  PROC RESPAWNROCKS():
    CALL RESPAWN(0)
    CALL RESPAWN(1)
  ENDP

  PROC FRAME():
    js = STICK(1)
    lf = KEYDOWN("O") OR BIT(js, 2)
    rg = KEYDOWN("P") OR BIT(js, 3)
    up = KEYDOWN("Q") OR BIT(js, 0)
    dn = KEYDOWN("A") OR BIT(js, 1)
    tt = tt + 1
    CALL FLY()
    CALL RECENTRE()
    CALL TESTGATE()
    CALL ROCKS()
    CALL HITFX()
    CALL SHOWHUD()
    CALL DRAW()
    IF shd <= 0 THEN why = 2 : CALL FINISH() ENDIF
    IF fuel <= 0 THEN why = 1 : CALL FINISH() ENDIF
  ENDP

  REM Turn 2 a tick, speed 8 to 40 (2 a tick), move along the heading, burn fuel.
  PROC FLY():
    IF lf THEN ea = BAND(ea - 2, 255) ENDIF
    IF rg THEN ea = BAND(ea + 2, 255) ENDIF
    IF up AND spd < 40 THEN spd = spd + 2 : hud = BOR(hud, 8) ENDIF
    IF dn AND spd > 8 THEN spd = spd - 2 : hud = BOR(hud, 8) ENDIF
    px = px + FXMUL(spd, SINA(ea))
    pz = pz + FXMUL(spd, COSA(ea))
    fuel = fuel - 1
    IF inv > 0 THEN inv = inv - 1 ENDIF
    IF BAND(tt, 7) = 0 THEN hud = BOR(hud, 4) ENDIF
  ENDP

  REM Keep the numbers small: when the eye is more than 12000 from the origin on an axis, the origin moves to the eye (the gates and rocks move with it).
  PROC RECENTRE():
    IF px > 12000 OR px < -12000 THEN
      ox = px : px = 0 : gx = gx - ox : nx = nx - ox : rx(0) = rx(0) - ox : rx(1) = rx(1) - ox
    ENDIF
    IF pz > 12000 OR pz < -12000 THEN
      ox = pz : pz = 0 : gz = gz - ox : nz = nz - ox : rz(0) = rz(0) - ox : rz(1) = rz(1) - ox
    ENDIF
  ENDP

  REM The pass test of the current gate: along (the distance along its heading, negative before it) goes from below 0 to 0 or more; it scores when the eye is within 220 of the middle
  REM (side), else it is a miss.  A gate 600 units behind, or 9000 away, is given up.
  PROC TESTGATE():
    dx = px - gx : dz = pz - gz
    IF dx > 9000 OR dx < -9000 OR dz > 9000 OR dz < -9000 THEN
      CALL LOST()
    ELSE
      along = FXMUL(dx, SINA(gch)) + FXMUL(dz, COSA(gch))
      IF pal < 0 AND along >= 0 THEN
        side = FXMUL(dx, COSA(gch)) - FXMUL(dz, SINA(gch))
        IF ABS(side) < 220 THEN CALL PASSED() ELSE CALL MISSED() ENDIF
      ELSE
        IF along > 600 THEN CALL MISSED() ELSE pal = along ENDIF
      ENDIF
    ENDIF
  ENDP

  PROC PASSED():
    score = score + 50 + spd
    gates = gates + 1
    fuel = fuel + 150 : IF fuel > 1500 THEN fuel = 1500 ENDIF
    IF gates MOD 5 = 0 AND shd < 3 THEN shd = shd + 1 ENDIF
    PLAY chime
    hud = 15
    CALL ADVANCE()
  ENDP

  PROC MISSED():
    PLAY buzz
    CALL ADVANCE()
  ENDP

  REM Flown far off the course: the course starts again 1500 units ahead of the eye.
  PROC LOST():
    PLAY buzz
    gch = ea
    gx = px + FXMUL(1500, SINA(ea))
    gz = pz + FXMUL(1500, COSA(ea))
    CALL MAKENEXT()
    CALL SETPAL()
    CALL RESPAWNROCKS()
  ENDP

  REM The rocks drift sideways (the other way every 16 ticks) and tumble; a rock within 100 units of the eye on both ground axes is a hit.
  PROC ROCKS():
    FOR i = 0 TO 1
      rt(i) = rt(i) + 1
      IF rt(i) = 16 THEN rt(i) = 0 : rv(i) = -rv(i) ENDIF
      rx(i) = rx(i) + FXMUL(rv(i), COSA(gch))
      rz(i) = rz(i) - FXMUL(rv(i), SINA(gch))
      rw(i) = BAND(rw(i) + 3 + i * 2, 255)
      rp(i) = BAND(rp(i) + 5, 255)
      IF inv = 0 AND ABS(px - rx(i)) < 100 AND ABS(pz - rz(i)) < 100 THEN
        shd = shd - 1 : inv = 20 : fl = 7 : hud = BOR(hud, 2)
        PLAY crash
        CALL RESPAWN(i)
      ENDIF
    NEXT i
  ENDP

  REM The flash of a hit: a 16 x 16 sprite in the middle of the play area for 6 ticks (it is drawn over the lines).
  PROC HITFX():
    IF fl > 0 THEN
      fl = fl - 1
      IF fl = 0 THEN HIDE burst ELSE SHOW burst AT 120, 88 ENDIF
    ENDIF
  ENDP

  REM hud: bit 0 score and gates, 1 shields, 2 fuel, 3 speed (the rows outside the play area: 0, 1 and 22, 23).
  PROC SHOWHUD():
    IF hud <> 0 THEN
      INK 6
      IF BAND(hud, 1) THEN PRINT AT 0, 1; "SCORE "; score USING "00000"; : PRINT AT 0, 19; "GATES "; gates USING "000"; ENDIF
      IF BAND(hud, 2) THEN PRINT AT 23, 1; "SHIELDS "; shd; ENDIF
      IF BAND(hud, 4) THEN PRINT AT 22, 1; "FUEL "; fuel USING "####"; ENDIF
      IF BAND(hud, 8) THEN PRINT AT 23, 19; "SPEED "; spd USING "##"; ENDIF
      hud = 0
    ENDIF
  ENDP

  REM How far the point (x, z) lies in front of the eye (the heading's dot product); fw <= 0: behind it, not worth drawing.
  PROC AHEAD(x, z):
    fw = FXMUL(x - px, SINA(ea)) + FXMUL(z - pz, COSA(ea))
  ENDP

  REM The picture: the eye, the gates (turning a little: the wobble is a flourish, never edge-on), the rocks, the gunsight and the horizon marks.  Nothing here changes the game.
  PROC DRAW():
    EYE px, 0, pz, ea
    w = BAND(tt, 31)
    IF w > 16 THEN w = 32 - w ENDIF
    wob = w * 3 - 12
    CALL AHEAD(gx, gz)
    IF fw > 0 THEN DRAWMODEL gate AT gx, 0, gz YAW gch + wob SCALE 4 ENDIF
    CALL AHEAD(nx, nz)
    IF fw > 0 THEN DRAWMODEL gate AT nx, 0, nz YAW nch + wob SCALE 4 ENDIF
    FOR i = 0 TO 1
      CALL AHEAD(rx(i), rz(i))
      IF fw > 0 THEN DRAWMODEL rock AT rx(i), ry(i), rz(i) YAW rw(i) PITCH rp(i) SCALE 2 ENDIF
    NEXT i
    LINE 118, 96 TO 124, 96 : LINE 132, 96 TO 138, 96 : LINE 128, 86 TO 128, 92 : LINE 128, 100 TO 128, 106
    LINE 0, 96 TO 9, 96 : LINE 246, 96 TO 255, 96
  ENDP

  PROC FINISH():
    IF why = 2 THEN PLAY crash ELSE PLAY buzz ENDIF
    ENTER over
  ENDP
ENDSCENE

SCENE over NOVIEW
  DIM ow, rel, fire

  PROC INIT():
    NOMUSIC
    BORDER 0
    IF score > best THEN best = score ENDIF
    PAPER 0 : INK 7 : BRIGHT 1 : CLS
    INK 2 : PRINT AT 6, 11; "GAME OVER";
    INK 3
    IF why = 1 THEN PRINT AT 8, 10; "OUT OF FUEL"; ELSE PRINT AT 8, 9; "SHIELDS DOWN"; ENDIF
    INK 6 : PRINT AT 11, 9; "SCORE "; score USING "00000";
    INK 5 : PRINT AT 13, 9; "BEST  "; best USING "00000";
    INK 7 : PRINT AT 15, 9; "GATES "; gates USING "000";
    INK 4 : PRINT AT 19, 7; "PRESS FIRE FOR THE TITLE";
  ENDP

  REM Fire goes on once it has been released and pressed again (it is usually still down when the scene starts).
  PROC FRAME():
    ow = ow + 1
    fire = KEYDOWN(" ") OR BIT(STICK(1), 4)
    IF fire = 0 THEN rel = 1 ENDIF
    IF fire AND rel AND ow > 20 THEN ENTER title ENDIF
  ENDP
ENDSCENE
