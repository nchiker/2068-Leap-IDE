REM Orbit Gates: the wireframe 3D sample game (docs/ARCADE_WIREFRAME_CONTRACT.md section 9) for the v2 runtime: a first-person flight through a course of gates, with a laser for the rocks.
REM Assets (the models gate, gatefar, rock and shards, the burst sprite, the title tiles, five sounds, the title song) are in orbit.assets.json, made by orbit.assets.gen.mjs.
REM   Keyboard: Q faster, A slower, O left, P right, SPACE fire (the laser).   Joystick 1: the stick and fire.   Fire starts a game (title) and goes back to the title (game over).
REM   Three scenes: title -> play -> over -> title.  The title and the game over are NOVIEW scenes (the whole cell screen, no 3D); play is the 3D flight (rows 2 to 21).
REM   The player is the EYE at (px, 0, pz) with the heading ea (256 to a turn).  The gates come one after another; the heading of the course drifts by -24 to 24 per gate.  The course gets harder with every
REM   gate passed (a narrower gate to pass, gates further apart, rocks closer to the course line and faster, a smaller fuel bonus: the level on the screen is 1 + gates / 4).
REM   Fire shoots the rock in front of the eye (a rock hit turns into debris, the model shards).  Only the current gate and the next one are drawn (and only while they are in front of the eye), plus two rocks
REM   or debris: at most 4 models a tick.
REM   Compile:  node arcade/tools/arcadec.mjs arcade/examples/orbit.arc --assets arcade/examples/orbit.assets.json --runtime v2
GAME "Orbit Gates"
FRAMERATE 12
WIRE3D ROWS 2 TO 21 INK 5 PAPER 0 BRIGHT 1

MODEL gate = "gate"
MODEL gatefar = "gatefar"
MODEL rock = "rock"
MODEL shards = "shards"
SPRITE burst = "burst"
TILESET gfx = "gfx"
SFX chime = "chime"
SFX buzz = "buzz"
SFX crash = "crash"
SFX zap = "zap"
SFX boom = "boom"
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
    INK 4 : PRINT AT 19, 3; "SPACE (FIRE) FIRES THE LASER";
    INK 4 : PRINT AT 20, 9; "OR JOYSTICK 1";
    INK 3 : PRINT AT 22, 1; "FLY THE GATES, SHOOT THE ROCKS";
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
  DIM px, pz, ea, spd, fuel, shd, tt, inv, fl, hud, cd, lz, sb, pm, sp, ec, es, gcs, gsn, ncs, nsn
  DIM gx, gz, gch, nx, nz, nch, pal
  DIM js, lf, rg, up, dn, fire, dx, dz, along, side, fw, wob, w, ox, oz, i, f, sd, ux, uz, bi, bd, ar, sdv, lv
  DIM rx(1), rz(1), ry(1), rdx(1), rdz(1), rw(1), rp(1), rt(1), rs(1)

  PROC INIT():
    NOMUSIC
    BORDER 0
    PAPER 0 : INK 6 : BRIGHT 1 : CLS
    score = 0 : gates = 0 : why = 0
    px = 0 : pz = 0 : ea = 0 : spd = 24 : fuel = 900 : shd = 3 : inv = 0 : fl = 0 : cd = 0 : lz = 0 : sb = 0
    ec = COSA(0) : es = SINA(0)
    pm = 220 : sp = 1500
    gx = 0 : gz = 1500 : gch = 0 : gcs = ec : gsn = es
    CALL MAKENEXT()
    CALL SETPAL()
    CALL RESPAWNROCKS()
    hud = 31
    CALL SHOWHUD()
  ENDP

  REM The next gate: sp units on from this one, its heading drifting by -24 to 24 (this uses the game's RND once per gate).  Its cosine and sine are kept: the course heading never changes.
  PROC MAKENEXT():
    nch = BAND(gch + RND(49) - 24, 255)
    ncs = COSA(nch) : nsn = SINA(nch)
    nx = gx + FXMUL(sp, nsn)
    nz = gz + FXMUL(sp, ncs)
  ENDP

  REM pal = how far along the gate's heading the eye is (negative: in front of the gate); the pass test looks for the change from negative to not negative.
  PROC SETPAL():
    pal = FXMUL(px - gx, gsn) + FXMUL(pz - gz, gcs)
  ENDP

  REM The gate is passed or missed: the next one becomes the current one and the course gets harder with the gates passed: the pass margin shrinks (220 down to 140), the gates move further apart (1500 up to 2100).
  REM The rocks that are not debris are placed again.
  PROC ADVANCE():
    gx = nx : gz = nz : gch = nch : gcs = ncs : gsn = nsn
    pm = 220 - gates * 4 : IF pm < 140 THEN pm = 140 ENDIF
    sp = 1500 + gates * 20 : IF sp > 2100 THEN sp = 2100 ENDIF
    CALL MAKENEXT()
    CALL SETPAL()
    CALL RESPAWNROCKS()
  ENDP

  REM Rock k again: on the way from the eye to the gate (35 to 78 per cent of it; when the gate is nearer than about 1400 units, on the way from the gate to the next one), to one side of the course: 210 to 379 units at first, closer with every gate (down to 120 to 289), and drifting
  REM faster (3 to 8 a tick at first, up to 12).  Its drift is worked out once, along the course's side axis.
  PROC RESPAWN(k):
    ox = px : oz = pz : ux = gx - px : uz = gz - pz
    IF ABS(ux) + ABS(uz) < 2000 THEN ox = gx : oz = gz : ux = nx - gx : uz = nz - gz ENDIF
    f = 90 + RND(110)
    sd = 210 - gates * 3 : IF sd < 120 THEN sd = 120 ENDIF
    sd = sd + RND(170)
    IF RND(2) = 0 THEN sd = -sd ENDIF
    rx(k) = ox + FXMUL(ux, f) + FXMUL(sd, gcs)
    rz(k) = oz + FXMUL(uz, f) - FXMUL(sd, gsn)
    ry(k) = RND(61) - 30
    f = 3 + RND(6) + gates DIV 4 : IF f > 12 THEN f = 12 ENDIF
    IF RND(2) = 0 THEN f = -f ENDIF
    rdx(k) = FXMUL(f, gcs) : rdz(k) = -FXMUL(f, gsn)
    rw(k) = RND(256) : rp(k) = RND(256) : rt(k) = 0 : rs(k) = 0
  ENDP

  REM A rock that is being blown up (rs 1 to 29) keeps its place; the others are put on the course again.
  PROC RESPAWNROCKS():
    IF rs(0) = 0 THEN CALL RESPAWN(0) ENDIF
    IF rs(1) = 0 THEN CALL RESPAWN(1) ENDIF
  ENDP

  PROC FRAME():
    js = STICK(1)
    lf = KEYDOWN("O") OR BIT(js, 2)
    rg = KEYDOWN("P") OR BIT(js, 3)
    up = KEYDOWN("Q") OR BIT(js, 0)
    dn = KEYDOWN("A") OR BIT(js, 1)
    fire = KEYDOWN(" ") OR BIT(js, 4)
    tt = tt + 1
    CALL FLY()
    CALL RECENTRE()
    CALL TESTGATE()
    CALL ROCKS()
    CALL SHOOT()
    CALL HITFX()
    CALL SHOWHUD()
    CALL DRAW()
    IF shd <= 0 THEN why = 2 : CALL FINISH() ENDIF
    IF fuel <= 0 THEN why = 1 : CALL FINISH() ENDIF
  ENDP

  REM Turn 2 a tick, speed 8 to 40 (2 a tick), move along the heading, burn fuel.  The eye's cosine and sine are worked out once a tick and used by everything below.
  PROC FLY():
    IF lf THEN ea = BAND(ea - 2, 255) ENDIF
    IF rg THEN ea = BAND(ea + 2, 255) ENDIF
    IF up AND spd < 40 THEN spd = spd + 2 : hud = BOR(hud, 8) ENDIF
    IF dn AND spd > 8 THEN spd = spd - 2 : hud = BOR(hud, 8) ENDIF
    ec = COSA(ea) : es = SINA(ea)
    px = px + FXMUL(spd, es)
    pz = pz + FXMUL(spd, ec)
    fuel = fuel - 1
    IF inv > 0 THEN inv = inv - 1 ENDIF
    IF sb > 0 THEN sb = sb - 1 ENDIF
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

  REM The pass test of the current gate: along (the distance along its heading, negative before it) goes from below 0 to 0 or more; it scores when the eye is within pm of the middle
  REM (side), else it is a miss.  A gate 600 units behind, or 9000 away, is given up.
  PROC TESTGATE():
    dx = px - gx : dz = pz - gz
    IF dx > 9000 OR dx < -9000 OR dz > 9000 OR dz < -9000 THEN
      CALL LOST()
    ELSE
      along = FXMUL(dx, gsn) + FXMUL(dz, gcs)
      IF pal < 0 AND along >= 0 THEN
        side = FXMUL(dx, gcs) - FXMUL(dz, gsn)
        IF ABS(side) < pm THEN CALL PASSED() ELSE CALL MISSED() ENDIF
      ELSE
        IF along > 600 THEN CALL MISSED() ELSE pal = along ENDIF
      ENDIF
    ENDIF
  ENDP

  REM A sound that must not be cut off by the laser's zap: the zap keeps quiet for 12 ticks after it.
  PROC LOUD():
    sb = 12
  ENDP

  PROC PASSED():
    score = score + 50 + spd
    gates = gates + 1
    f = 150 - gates * 2 : IF f < 90 THEN f = 90 ENDIF
    fuel = fuel + f : IF fuel > 1500 THEN fuel = 1500 ENDIF
    IF gates MOD 5 = 0 AND shd < 3 THEN shd = shd + 1 ENDIF
    PLAY chime : CALL LOUD()
    hud = BOR(hud, 17)
    CALL ADVANCE()
  ENDP

  PROC MISSED():
    PLAY buzz : CALL LOUD()
    CALL ADVANCE()
  ENDP

  REM Flown far off the course: the course starts again 1500 units ahead of the eye.
  PROC LOST():
    PLAY buzz : CALL LOUD()
    gch = ea : gcs = ec : gsn = es
    gx = px + FXMUL(1500, es)
    gz = pz + FXMUL(1500, ec)
    CALL MAKENEXT()
    CALL SETPAL()
    CALL RESPAWNROCKS()
  ENDP

  REM The rocks drift sideways (the other way every 16 ticks) and tumble; a rock within 100 units of the eye on both ground axes is a hit.  A rock that is blown up (rs from 1) is debris: it spins, and after 29 ticks
  REM a new rock is placed.
  PROC ROCKS():
    FOR i = 0 TO 1
      IF rs(i) = 0 THEN
        rt(i) = rt(i) + 1
        IF rt(i) = 16 THEN rt(i) = 0 : rdx(i) = -rdx(i) : rdz(i) = -rdz(i) ENDIF
        rx(i) = rx(i) + rdx(i)
        rz(i) = rz(i) + rdz(i)
        rw(i) = BAND(rw(i) + 3 + i * 2, 255)
        rp(i) = BAND(rp(i) + 5, 255)
        IF inv = 0 AND ABS(px - rx(i)) < 100 AND ABS(pz - rz(i)) < 100 THEN
          shd = shd - 1 : inv = 20 : fl = 7 : hud = BOR(hud, 2)
          PLAY crash : CALL LOUD()
          CALL RESPAWN(i)
        ENDIF
      ELSE
        rs(i) = rs(i) + 1
        rw(i) = BAND(rw(i) + 19, 255)
        rp(i) = BAND(rp(i) + 27, 255)
        IF rs(i) >= 30 THEN CALL RESPAWN(i) ENDIF
      ENDIF
    NEXT i
  ENDP

  REM The laser: fire (cooldown 6 ticks) shows two beams for 3 ticks and hits the nearest rock that is in front of the eye, 250 to 2500 units along the view, within 70 + along / 16 units of
  REM the view direction (in the eye's own axes: along = forward, sdv = sideways).
  PROC SHOOT():
    IF cd > 0 THEN cd = cd - 1 ENDIF
    IF fire AND cd = 0 THEN
      cd = 6 : lz = 3
      IF sb = 0 THEN PLAY zap ENDIF
      bi = -1 : bd = 2501
      FOR i = 0 TO 1
        IF rs(i) = 0 THEN
          dx = rx(i) - px : dz = rz(i) - pz
          ar = FXMUL(dx, es) + FXMUL(dz, ec)
          IF ar >= 250 AND ar < bd THEN
            sdv = FXMUL(dx, ec) - FXMUL(dz, es)
            IF ABS(sdv) < 70 + ar DIV 16 THEN bi = i : bd = ar ENDIF
          ENDIF
        ENDIF
      NEXT i
      IF bi >= 0 THEN
        rs(bi) = 1
        score = score + 100 + spd
        hud = BOR(hud, 1)
        PLAY boom : CALL LOUD()
      ENDIF
    ENDIF
  ENDP

  REM The flash of a hit: a 16 x 16 sprite in the middle of the play area for 6 ticks (it is drawn over the lines).
  PROC HITFX():
    IF fl > 0 THEN
      fl = fl - 1
      IF fl = 0 THEN HIDE burst ELSE SHOW burst AT 120, 88 ENDIF
    ENDIF
  ENDP

  REM hud: the groups that need printing: bit 0 (value 1) score and gates (row 0), value 16 level and gate width (row 1), 2 shields, 4 fuel, 8 speed (rows 22 and 23).  One group a tick, the first that is set in that
  REM order (PRINT is slow, and a tick in which a gate is passed or a rock shot would be the slowest of all).
  PROC SHOWHUD():
    IF hud <> 0 THEN
      INK 6
      IF BAND(hud, 1) THEN
        PRINT AT 0, 1; "SCORE "; score USING "00000"; : PRINT AT 0, 19; "GATES "; gates USING "000";
        hud = hud - 1
      ELSE
        IF BAND(hud, 16) THEN
          lv = 1 + gates DIV 4
          PRINT AT 1, 1; "LEVEL "; lv USING "##"; : PRINT AT 1, 17; "GATE WIDTH "; pm USING "###";
          hud = hud - 16
        ELSE
          IF BAND(hud, 2) THEN
            PRINT AT 23, 1; "SHIELDS "; shd;
            hud = hud - 2
          ELSE
            IF BAND(hud, 4) THEN
              PRINT AT 22, 1; "FUEL "; fuel USING "####";
              hud = hud - 4
            ELSE
              PRINT AT 23, 19; "SPEED "; spd USING "##";
              hud = hud - 8
            ENDIF
          ENDIF
        ENDIF
      ENDIF
    ENDIF
  ENDP

  REM How far the point (x, z) lies in front of the eye (the heading's dot product); fw <= 0: behind it, not worth drawing.
  PROC AHEAD(x, z):
    fw = FXMUL(x - px, es) + FXMUL(z - pz, ec)
  ENDP

  REM The picture: the eye, the gates (the current one an octagon, the next a hexagon: it is far away and small; turning a little: the wobble is a flourish, never edge-on) while they are in front of the eye, and the two rocks, or the debris of a rock that was shot (the model shards:
  REM it turns fast and spreads, SCALE 1, 2, 4 in steps of 4 ticks), while they are more than 250 units along the view (a nearer one is about to be hit or missed, and costs the most).  Then the laser's
  REM beams (from the two lower corners of the play area to the gunsight, 3 ticks), the gunsight and the horizon marks.  At most 2 gates + 2 rocks or debris: 4 models a tick.  Nothing here changes the game.
  PROC DRAW():
    EYE px, 0, pz, ea
    w = BAND(tt, 31)
    IF w > 16 THEN w = 32 - w ENDIF
    wob = w * 3 - 12
    CALL AHEAD(gx, gz)
    IF fw > 0 THEN DRAWMODEL gate AT gx, 0, gz YAW gch + wob SCALE 4 ENDIF
    CALL AHEAD(nx, nz)
    IF fw > 0 THEN DRAWMODEL gatefar AT nx, 0, nz YAW nch + wob SCALE 4 ENDIF
    FOR i = 0 TO 1
      CALL AHEAD(rx(i), rz(i))
      IF fw > 250 THEN
        IF rs(i) = 0 THEN
          DRAWMODEL rock AT rx(i), ry(i), rz(i) YAW rw(i) PITCH rp(i) SCALE 2
        ELSE
          IF rs(i) <= 4 THEN
            DRAWMODEL shards AT rx(i), ry(i), rz(i) YAW rw(i) PITCH rp(i) SCALE 1
          ELSE
            IF rs(i) <= 8 THEN
              DRAWMODEL shards AT rx(i), ry(i), rz(i) YAW rw(i) PITCH rp(i) SCALE 2
            ELSE
              IF rs(i) <= 12 THEN DRAWMODEL shards AT rx(i), ry(i), rz(i) YAW rw(i) PITCH rp(i) SCALE 4 ENDIF
            ENDIF
          ENDIF
        ENDIF
      ENDIF
    NEXT i
    IF lz > 0 THEN
      LINE 0, 175 TO 128, 96 : LINE 255, 175 TO 128, 96
      lz = lz - 1
    ENDIF
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
