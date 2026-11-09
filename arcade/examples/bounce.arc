REM Bounce: a ball bouncing off the screen edges and a paddle the joystick moves along the bottom.
REM Arcade v0 subset. Assets (ball, paddle) are in bounce.assets.json.
GAME "bounce"
FRAMERATE 30

SPRITE ball = "ball"
SPRITE paddle = "paddle"

SCENE play
  DIM bx, by, dx, dy, px

  PROC INIT():
    bx = 120
    by = 60
    dx = 2
    dy = 2
    px = 112
    SHOW ball AT bx, by
    SHOW paddle AT px, 176
  ENDP

  PROC FRAME():
    REM joystick 1: bit 2 = left, bit 3 = right (direction bits 0-3, fire = 16)
    IF BIT(STICK(1), 2) THEN
      px = px - 4
    ENDIF
    IF BIT(STICK(1), 3) THEN
      px = px + 4
    ENDIF
    IF px < 0 THEN
      px = 0
    ENDIF
    IF px > 224 THEN
      px = 224
    ENDIF

    bx = bx + dx
    by = by + dy
    IF bx < 0 THEN
      bx = 0
      dx = -dx
    ENDIF
    IF bx > 232 THEN
      bx = 232
      dx = -dx
    ENDIF
    IF by < 0 THEN
      by = 0
      dy = -dy
    ENDIF
    REM the paddle catches the ball when it falls onto it; otherwise the ball bounces off the bottom edge
    IF by >= 168 AND dy > 0 THEN
      IF bx + 8 > px AND bx < px + 16 THEN
        by = 168
        dy = -2
      ENDIF
    ENDIF
    IF by >= 184 THEN
      by = 184
      dy = -2
    ENDIF

    SHOW ball AT bx, by
    SHOW paddle AT px, 176
  ENDP
ENDSCENE
