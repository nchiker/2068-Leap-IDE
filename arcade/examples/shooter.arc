REM Starfall: acceptance game B for milestone M4a (docs/ARCADE_RUNTIME_API_V2.md): a vertical shooter for the v2 runtime.
REM Assets (ship, bullet, scout, heavy, shot, the gfx tiles, the sky map, five sounds, two songs) are in shooter.assets.json,
REM drawn and written by shooter.assets.gen.mjs.  Music (docs/ARCADE_MUSIC_CONTRACT.md): FANFARE on the title, DRIVE during play (on channels A
REM and B only, so the effects, which borrow channel C, never cut into it); the game over stops the music for its own sound.
REM   Keyboard: Q up, A down, O left, P right, SPACE fire.   Joystick 1: the stick and fire.   Fire starts the game and restarts it after GAME OVER.
REM   Three scenes (language batch 4, docs/ARCADE_LANGUAGE_BATCH4.md): title -> play -> over -> play.  The score and the wave are game-level variables
REM   (the over scene shows them); everything of the game itself lives in the play scene, whose variables ENTER zeroes at every start.  ENTER puts the screen
REM   (the sky, from the first MAP), the sprites and the sound back to the start state, so no scene cleans up after the one before.
REM   The version with one scene and a state variable is kept as arcade/tests/fixtures/shooter-v1.arc.
REM   FINE COLOUR (docs/ARCADE_FINE_COLOUR_CONTRACT.md): every scene is an 8 x 1 colour scene (shooter.assets.json says so: "scenes": {"title": {"display": "fine"}, ...}):
REM   every pixel row of every sprite and every tile has its own colour, so the ship, the enemies and the shots are shaded row by row over a starfield with a planet
REM   lit from the upper left (shaded black, blue, red, magenta in bands joined by checkerboard seams), and the title and the game over have a rainbow logo and graded
REM   text (maps of tiles loaded over the sky: LOADMAP logo AT ...).  Black paper is always BRIGHT 0.  The screen is then updated in the one picture the viewer sees (about 25,000 T for each moving 16 x 16
REM   sprite, 12,500 T for an 8 x 8 one), so a 20 Hz tick holds only a few sprites at once: the ship, 2 bullets, 2 enemies at a time (2 scouts and a heavy to pick from) and 1 enemy shot.
REM   A game with a fine scene has at most 32 sprite phases in all (ship 8, bullet 4, scout 8, heavy 8, shot 4 = 32).  The bullets are fast (16 pixels a tick)
REM   so two of them keep a steady fire; the waves make up for the three enemy slots by speed, shots, the heavies' dives and the number of enemies a wave.
REM   The HUD costs about 1,800 T for each text cell it prints, so only the number that changed is printed (the labels once).
REM   Compile:  node arcade/tools/arcadec.mjs arcade/examples/shooter.arc --assets arcade/examples/shooter.assets.json --runtime v2
GAME "Starfall"
FRAMERATE 20

SPRITE ship = "ship"
SPRITE bul(2) = "bullet"
SPRITE scout(2) = "scout"
SPRITE heavy(1) = "heavy"
SPRITE shot(1) = "shot"
TILESET gfx = "gfx"
MAP sky = "sky"
MAP logo = "logo"
MAP press = "press"
MAP gameover = "gameover"
SFX pew = "pew"
SFX boom = "boom"
SFX hurt = "hurt"
SFX wave = "wave"
SFX over = "over"
MUSIC fanfare = "fanfare"
MUSIC drive = "drive"

REM The score and the wave belong to the whole game: the over scene shows them.
DIM score, wv

SCENE title
  PROC INIT():
    BORDER 0
    PLAY fanfare
    REM the logo (each pixel row its own colour) and the graded line are maps of tiles; the keys are plain text
    LOADMAP logo AT 2, 5
    LOADMAP press AT 7, 14
    INK 5 : PAPER 0 : BRIGHT 0
    PRINT AT 18, 4; "Q A O P MOVE   SPACE FIRE";
    PRINT AT 20, 10; "OR JOYSTICK 1";
  ENDP

  PROC FRAME():
    IF KEYDOWN(" ") OR BIT(STICK(1), 4) THEN ENTER play ENDIF
  ENDP
ENDSCENE

SCENE play
  DIM px, py, lives, js, inv, cool, spl, spt, alive, wt, hs, hl, hw
  DIM lf, rg, up, dn, fire, vs, fr, sp0, ssp, sw, fb, ax, ay, i, j, k, m, c, q, f, g, x, y, ee, o, u
  REM bullets 0..1, enemies 0..2 (0..1 scouts, 2 the heavy; two of them at a time at most), the enemy shot 0 (the arrays have a slot 1 too: a DIM has at least 2 elements), explosions 0..1
  DIM bx(1), by(1), bon(1)
  DIM ex(2), ey(2), et(2), ep(2), es(2), ed(2), eh(2)
  DIM sx(1), sy(1), sdx(1), son(1)
  DIM xc(1), yc(1), ef(1)
  REM the 4 map tiles under each explosion, put back when it is over (the sky, the stars, the planet)
  DIM st(7)
  REM the zigzag pattern's sideways offsets
  DIM wob(15)

  REM Does the ship touch enemy k?  (scout(k) is outside its pool for k > 1 and heavy(k - 2) for k < 2, which HIT answers with 0)
  DEF FN touch(n) = HIT(ship, scout(n)) OR HIT(ship, heavy(n - 2))

  PROC INIT():
    BORDER 0
    wob(0) = 0 : wob(1) = 6 : wob(2) = 11 : wob(3) = 14 : wob(4) = 16 : wob(5) = 14 : wob(6) = 11 : wob(7) = 6
    wob(8) = 0 : wob(9) = -6 : wob(10) = -11 : wob(11) = -14 : wob(12) = -16 : wob(13) = -14 : wob(14) = -11 : wob(15) = -6
    CALL NEWGAME()
    PLAY drive
  ENDP

  REM Start a game (the scene has just been entered: the sky is on the screen, no sprite is shown, the variables are 0).
  PROC NEWGAME():
    score = 0 : lives = 3 : wv = 0
    px = 120 : py = 160 : inv = 0 : cool = 0 : alive = 0
    SHOW ship AT px, py
    INK 6 : PAPER 0 : BRIGHT 0
    PRINT AT 0, 0; "SCORE"; : PRINT AT 0, 14; "LIVES"; : PRINT AT 0, 24; "WAVE";
    hs = 1 : hl = 1
    CALL NEXTWAVE()
  ENDP

  PROC NEXTWAVE():
    wv = wv + 1
    spl = 4 + wv * 2 : IF spl > 20 THEN spl = 20 ENDIF
    spt = 24 : wt = 0
    vs = 2 + wv DIV 2 : IF vs > 5 THEN vs = 5 ENDIF
    fr = 70 - wv * 8 : IF fr < 10 THEN fr = 10 ENDIF
    sp0 = 16 - wv : IF sp0 < 5 THEN sp0 = 5 ENDIF
    ssp = 4 + wv DIV 2 : IF ssp > 8 THEN ssp = 8 ENDIF
    sw = 1 + wv DIV 4 : IF sw > 3 THEN sw = 3 ENDIF
    hw = 1
    PLAY wave
  ENDP

  REM Print the HUD numbers that changed (the labels were printed once): every text cell costs about 1,800 T in a fine scene.
  PROC SHOWHUD():
    INK 6 : PAPER 0 : BRIGHT 0
    IF hs THEN PRINT AT 0, 6; score; : hs = 0 ENDIF
    IF hl THEN PRINT AT 0, 20; lives; : hl = 0 ENDIF
    IF hw THEN PRINT AT 0, 29; wv; : hw = 0 ENDIF
  ENDP

  PROC FRAME():
    js = STICK(1)
    lf = KEYDOWN("O") OR BIT(js, 2)
    rg = KEYDOWN("P") OR BIT(js, 3)
    up = KEYDOWN("Q") OR BIT(js, 0)
    dn = KEYDOWN("A") OR BIT(js, 1)
    fire = KEYDOWN(" ") OR BIT(js, 4)
    CALL PLAYING()
    CALL UPDATEEXP()
  ENDP

  PROC PLAYING():
    IF lf THEN px = px - 4 ENDIF
    IF rg THEN px = px + 4 ENDIF
    IF up THEN py = py - 3 ENDIF
    IF dn THEN py = py + 3 ENDIF
    IF px < 0 THEN px = 0 ENDIF
    IF px > 240 THEN px = 240 ENDIF
    IF py < 96 THEN py = 96 ENDIF
    IF py > 168 THEN py = 168 ENDIF
    IF cool > 0 THEN cool = cool - 1 ENDIF
    IF fire AND cool = 0 THEN CALL FIREBULLET() ENDIF
    IF inv > 0 THEN
      inv = inv - 1
      IF inv MOD 4 < 2 THEN
        SHOW ship AT px, py
      ELSE
        HIDE ship
      ENDIF
    ELSE
      SHOW ship AT px, py
    ENDIF
    CALL BULLETS()
    CALL ENEMIES()
    CALL SHOTS()
    CALL SPAWNER()
    IF hs + hl + hw > 0 THEN CALL SHOWHUD() ENDIF
  ENDP

  PROC FIREBULLET():
    FOR i = 0 TO 1
      IF bon(i) = 0 THEN
        bon(i) = 1 : bx(i) = px + 4 : by(i) = py - 6
        SHOW bul(i) AT bx(i), by(i)
        cool = 4
        PLAY pew
        EXIT FOR
      ENDIF
    NEXT i
  ENDP

  REM A bullet climbs 16 pixels a tick, so two of them keep a steady fire.
  PROC BULLETS():
    FOR i = 0 TO 1
      IF bon(i) = 1 THEN
        by(i) = by(i) - 16
        IF by(i) < 8 THEN
          bon(i) = 0
          HIDE bul(i)
        ELSE
          SHOW bul(i) AT bx(i), by(i)
          CALL BULLETHIT(i)
        ENDIF
      ENDIF
    NEXT i
  ENDP

  REM Bullet n against every enemy (a box test on the arrays, the HIT calls are kept for the ship).
  PROC BULLETHIT(n):
    FOR j = 0 TO 2
      IF es(j) = 1 AND ABS(bx(n) + 4 - ex(j) - 8) < 12 AND ABS(by(n) + 4 - ey(j) - 8) < 12 THEN
        bon(n) = 0
        HIDE bul(n)
        eh(j) = eh(j) - 1
        IF eh(j) <= 0 THEN
          CALL KILL(j)
        ELSE
          PLAY hurt
        ENDIF
        EXIT FOR
      ENDIF
    NEXT j
  ENDP

  REM Enemy n is destroyed: score, explosion, sound.
  PROC KILL(n):
    score = score + (et(n) + 1) * 10
    IF score > 30000 THEN score = 30000 ENDIF
    hs = 1
    es(n) = 0
    ax = ex(n) : ay = ey(n)
    CALL EXPLODE()
    PLAY boom
    HIDE scout(n)
    HIDE heavy(n - 2)
  ENDP

  REM Start an explosion at (ax, ay): 2 x 2 tiles, 3 frames, drawn by UPDATEEXP; the tiles under it are kept.
  PROC EXPLODE():
    FOR c = 0 TO 1
      IF ef(c) = 0 THEN
        ef(c) = 1 : xc(c) = (ax + 4) DIV 8 : yc(c) = (ay + 4) DIV 8
        IF yc(c) > 22 THEN yc(c) = 22 ENDIF
        x = xc(c) : y = yc(c) : o = 4 * c
        st(o) = TILEAT(x, y) : st(o + 1) = TILEAT(x + 1, y) : st(o + 2) = TILEAT(x, y + 1) : st(o + 3) = TILEAT(x + 1, y + 1)
        REM (a tile that is part of another explosion, or a text cell or a cell off the screen, is not kept: -1 stays -1, an explosion tile becomes the empty sky)
        FOR u = 0 TO 3
          IF st(o + u) >= 4 AND st(o + u) <= 15 THEN st(o + u) = 0 ENDIF
        NEXT u
        EXIT FOR
      ENDIF
    NEXT c
  ENDP

  PROC UPDATEEXP():
    FOR ee = 0 TO 1
      IF ef(ee) > 0 THEN
        SELECT CASE ef(ee)
          CASE 1
            fb = 4 : CALL DRAWEXP(ee)
          CASE 3
            fb = 8 : CALL DRAWEXP(ee)
          CASE 5
            fb = 12 : CALL DRAWEXP(ee)
          CASE 7
            fb = -1 : CALL DRAWEXP(ee)
        ENDSEL
        ef(ee) = ef(ee) + 1
        IF ef(ee) > 7 THEN ef(ee) = 0 ENDIF
      ENDIF
    NEXT ee
  ENDP

  REM The four tiles of an explosion frame starting at tile fb, or the tiles that were there when fb < 0.
  PROC DRAWEXP(n):
    x = xc(n) : y = yc(n) : o = 4 * n
    IF fb < 0 THEN
      IF st(o) >= 0 THEN TILE x, y = st(o) ENDIF
      IF st(o + 1) >= 0 THEN TILE x + 1, y = st(o + 1) ENDIF
      IF st(o + 2) >= 0 THEN TILE x, y + 1 = st(o + 2) ENDIF
      IF st(o + 3) >= 0 THEN TILE x + 1, y + 1 = st(o + 3) ENDIF
    ELSE
      TILE x, y = fb : TILE x + 1, y = fb + 1 : TILE x, y + 1 = fb + 2 : TILE x + 1, y + 1 = fb + 3
    ENDIF
  ENDP

  PROC ENEMIES():
    alive = 0
    FOR k = 0 TO 2
      IF es(k) = 1 THEN
        alive = alive + 1
        CALL MOVEENEMY(k)
        IF es(k) = 1 THEN
          SHOW scout(k) AT ex(k), ey(k)
          SHOW heavy(k - 2) AT ex(k), ey(k)
          IF ey(k) > 16 AND ey(k) < 130 THEN
            IF RND(fr) = 0 THEN CALL ESHOOT(k) ENDIF
          ENDIF
          IF inv = 0 AND FN touch(k) THEN
            CALL KILL(k)
            CALL PLAYERHIT()
          ENDIF
        ENDIF
      ENDIF
    NEXT k
  ENDP

  REM Four movement patterns, chosen by the enemy's type.
  PROC MOVEENEMY(n):
    ep(n) = ep(n) + 1
    SELECT CASE et(n)
      CASE 0
        REM straight down
        ey(n) = ey(n) + vs
      CASE 1
        REM a zigzag along the wave table, around the column it started in
        ey(n) = ey(n) + vs - 1
        ex(n) = ed(n) + wob(ep(n) MOD 16)
      CASE 2
        REM slide in, hover, then dive at the ship
        IF ep(n) < 26 THEN
          IF ey(n) < 40 THEN ey(n) = ey(n) + 2 ENDIF
        ELSE
          ey(n) = ey(n) + 5
          ex(n) = ex(n) + SGN(px - ex(n)) * 2
        ENDIF
      CASE ELSE
        REM strafe from side to side and creep down
        ex(n) = ex(n) + ed(n)
        IF ex(n) < 8 THEN ed(n) = 3 ENDIF
        IF ex(n) > 232 THEN ed(n) = -3 ENDIF
        IF ep(n) MOD 2 = 0 THEN ey(n) = ey(n) + 1 ENDIF
    ENDSEL
    IF ey(n) > 180 THEN
      es(n) = 0
      HIDE scout(n)
      HIDE heavy(n - 2)
    ENDIF
  ENDP

  PROC ESHOOT(n):
    FOR m = 0 TO 0
      IF son(m) = 0 THEN
        son(m) = 1 : sx(m) = ex(n) + 4 : sy(m) = ey(n) + 12
        sdx(m) = SGN(px - ex(n))
        EXIT FOR
      ENDIF
    NEXT m
  ENDP

  PROC SHOTS():
    FOR i = 0 TO 0
      IF son(i) = 1 THEN
        sx(i) = sx(i) + sdx(i) * sw
        sy(i) = sy(i) + ssp
        IF sy(i) > 184 OR sx(i) < 0 OR sx(i) > 248 THEN
          son(i) = 0
          HIDE shot(i)
        ELSE
          SHOW shot(i) AT sx(i), sy(i)
          IF inv = 0 AND HIT(ship, shot(i)) THEN
            son(i) = 0
            HIDE shot(i)
            CALL PLAYERHIT()
          ENDIF
        ENDIF
      ENDIF
    NEXT i
  ENDP

  PROC PLAYERHIT():
    lives = lives - 1
    hl = 1
    ax = px : ay = py
    CALL EXPLODE()
    IF lives <= 0 THEN
      ENTER over
    ELSE
      inv = 40 : px = 120 : py = 160
      PLAY hurt
    ENDIF
  ENDP

  REM Place the next enemy of the wave: its type, the free slot of its pool (types 0, 1 = the scouts' slots 0 and 1, types 2, 3 = the heavy's slot 2).
  PROC SPAWN():
    q = wv + 1 : IF q > 4 THEN q = 4 ENDIF
    q = RND(q)
    f = 2 : g = 2
    IF q < 2 THEN f = 0 : g = 1 ENDIF
    FOR m = f TO g
      IF es(m) = 0 THEN
        es(m) = 1 : et(m) = q : ep(m) = 0 : eh(m) = 1
        ex(m) = 24 + RND(176) : ey(m) = 8 : ed(m) = ex(m)
        IF q = 3 THEN eh(m) = 2 : ed(m) = 3 ENDIF
        spl = spl - 1 : spt = sp0
        EXIT FOR
      ENDIF
    NEXT m
  ENDP

  PROC SPAWNER():
    IF spl > 0 THEN
      spt = spt - 1
      IF spt <= 0 AND alive < 2 THEN CALL SPAWN() ENDIF
    ELSE
      IF alive = 0 THEN
        wt = wt + 1
        IF wt > 25 THEN CALL NEXTWAVE() ENDIF
      ENDIF
    ENDIF
  ENDP
ENDSCENE

SCENE over
  DIM ow, rel, fire
  PROC INIT():
    BORDER 0
    NOMUSIC
    PLAY over
    INK 6 : PAPER 0 : BRIGHT 0
    PRINT AT 0, 0; "SCORE "; score; "  ";
    PRINT AT 0, 24; "WAVE "; wv; " ";
    LOADMAP gameover AT 7, 14
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
