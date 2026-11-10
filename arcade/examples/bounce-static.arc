REM Bounce, static: the same two sprites at fixed positions, shown once in INIT and never moved.
REM Used to compare emulators pixel for pixel, since a moving game's frames depend on each emulator's frame length.
GAME "bounce"
FRAMERATE 30

SPRITE ball = "ball"
SPRITE paddle = "paddle"

SCENE play
  PROC INIT():
    SHOW ball AT 120, 60
    SHOW paddle AT 112, 176
  ENDP

  PROC FRAME():
  ENDP
ENDSCENE
