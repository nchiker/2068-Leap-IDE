REM FIXTURE: the original joystick-only Breakout for the v1 runtime, kept so the M3 tests have a v1 reference program.
REM The playable example is arcade/examples/breakout.arc (v2 runtime, keyboard and joystick).
REM Breakout: acceptance game A (docs/ARCADE_LANGUAGE.md) written for the v1 runtime.
REM Assets (bat, ball, bricks, wall, brick, lose) are in breakout.assets.json.
REM   Joystick 1 left / right moves the bat; fire restarts after GAME OVER or YOU WIN.
REM   Six rows of 30 bricks are TILEs (three colours, the upper rows score more); the ball finds a brick with TILEAT.
REM   Compile:  node arcade/tools/arcadec.mjs arcade/examples/breakout.arc --assets arcade/examples/breakout.assets.json --runtime v1
GAME "Breakout"
FRAMERATE 30

SPRITE bat = "bat"
SPRITE ball = "ball"
TILESET bricks = "bricks"
SFX wall = "wall"
SFX brick = "brick"
SFX lose = "lose"

SCENE play
  REM state: 0 = playing, 1 = game over / won (waiting for fire)
  DIM bx, by, dx, dy, px, score, lives, left, state, cx, cy, t, i, j, hb

  REM Start (or restart) a game: clear the screen, print the HUD, lay the bricks, put the ball on the bat.
  PROC NEWGAME():
    CLS
    INK 1
    PRINT AT 0, 1; "SCORE";
    PRINT AT 0, 22; "LIVES";
    score = 0
    lives = 3
    left = 180
    PRINT AT 0, 7; score;
    PRINT AT 0, 28; lives;
    FOR j = 3 TO 8
      FOR i = 1 TO 30
        TILE i, j = (j - 3) DIV 2
      NEXT i
    NEXT j
    px = 120
    CALL SERVE()
    state = 0
  ENDP

  REM Ball on the bat, going up and to the right.
  PROC SERVE():
    bx = px + 4
    by = 160
    dx = 2
    dy = -2
  ENDP

  PROC INIT():
    CALL NEWGAME()
    SHOW bat AT px, 176
    SHOW ball AT bx, by
  ENDP

  REM Is the cell (cx, cy) in pixels a brick?  Remove it, score it and set hb = 1.
  PROC HITBRICK():
    hb = 0
    cx = cx DIV 8
    cy = cy DIV 8
    t = TILEAT(cx, cy)
    IF t >= 0 AND t < 3 THEN
      TILE cx, cy = 3
      PLAY brick
      score = score + 10 + (2 - t) * 10
      left = left - 1
      INK 1
      PRINT AT 0, 7; score;
      hb = 1
      IF left = 0 THEN
        state = 1
        INK 2
        PRINT AT 11, 12; "YOU WIN";
        PRINT AT 13, 7; "PRESS FIRE TO PLAY";
      ENDIF
    ENDIF
  ENDP

  PROC GAMEOVER():
    state = 1
    INK 2
    PRINT AT 11, 11; "GAME OVER";
    PRINT AT 13, 7; "PRESS FIRE TO PLAY";
  ENDP

  PROC PLAYTICK():
    IF BIT(STICK(1), 2) THEN
      px = px - 4
    ENDIF
    IF BIT(STICK(1), 3) THEN
      px = px + 4
    ENDIF
    IF px < 0 THEN
      px = 0
    ENDIF
    IF px > 240 THEN
      px = 240
    ENDIF

    REM horizontal step: walls, then the brick in front of the ball's middle
    bx = bx + dx
    IF bx < 0 THEN
      bx = 0
      dx = -dx
      PLAY wall
    ENDIF
    IF bx > 248 THEN
      bx = 248
      dx = -dx
      PLAY wall
    ENDIF
    IF dx > 0 THEN
      cx = bx + 7
    ELSE
      cx = bx
    ENDIF
    cy = by + 4
    CALL HITBRICK()
    IF hb = 1 THEN
      dx = -dx
    ENDIF

    REM vertical step: ceiling (below the HUD row), then the brick above or below
    by = by + dy
    IF by < 8 THEN
      by = 8
      dy = -dy
      PLAY wall
    ENDIF
    cx = bx + 4
    IF dy > 0 THEN
      cy = by + 7
    ELSE
      cy = by
    ENDIF
    CALL HITBRICK()
    IF hb = 1 THEN
      dy = -dy
    ENDIF

    REM the bat: the ball bounces up, sideways by where it landed
    SHOW bat AT px, 176
    SHOW ball AT bx, by
    IF dy > 0 AND HIT(ball, bat) THEN
      by = 168
      dy = -2
      dx = (bx + 4 - px - 8) DIV 4
      IF dx = 0 THEN
        dx = 1
      ENDIF
      PLAY wall
    ENDIF

    REM below the bat: a life is lost
    IF by > 184 THEN
      lives = lives - 1
      PLAY lose
      INK 1
      PRINT AT 0, 28; lives;
      IF lives = 0 THEN
        CALL GAMEOVER()
      ELSE
        CALL SERVE()
      ENDIF
    ENDIF
  ENDP

  PROC FRAME():
    IF state = 1 THEN
      IF BIT(STICK(1), 4) THEN
        CALL NEWGAME()
      ENDIF
    ELSE
      CALL PLAYTICK()
    ENDIF
    SHOW bat AT px, 176
    SHOW ball AT bx, by
  ENDP
ENDSCENE
