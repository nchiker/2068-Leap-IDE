REM Bounce: a ball bouncing off the screen edges and a paddle the joystick moves along the bottom.
REM The smallest example: a title scene with a song, then the play scene.
REM Assets (ball, paddle, the song "theme") are in bounce.assets.json, which bounce.assets.gen.mjs makes.
GAME "bounce"
FRAMERATE 30

SPRITE ball = "ball"
SPRITE paddle = "paddle"
MUSIC theme = "theme"

REM The title: the song plays until fire (the SPACE key or the joystick's button) starts the game.
SCENE title
  PROC INIT():
    PLAY theme
    CLS
    INK 1 : PRINT AT 8, 13; "BOUNCE";
    INK 2 : PRINT AT 12, 7; "PRESS FIRE TO PLAY";
    INK 0 : PRINT AT 16, 7; "O P OR JOYSTICK 1";
    PRINT AT 17, 8; "MOVE THE PADDLE";
  ENDP

  REM KEYPRESS and JOYPRESS are true for the one tick the key or the button goes down.
  PROC FRAME():
    IF KEYPRESS(" ") OR BIT(JOYPRESS(1), 4) THEN
      ENTER play
    ENDIF
  ENDP
ENDSCENE

SCENE play
  DIM bx, by, dx, dy, px

  PROC INIT():
    NOMUSIC
    CLS
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
    IF KEYDOWN("O") OR BIT(STICK(1), 2) THEN
      px = px - 4
    ENDIF
    IF KEYDOWN("P") OR BIT(STICK(1), 3) THEN
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
