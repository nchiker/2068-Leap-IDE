# Leap Arcade language, version 0 (draft, 2026-11-09)

**Policy (owner, 2026-11-09): only what is needed, adjusted as games are built.** A word enters the language when a
game under construction needs it. Names are provisional until 1.0; renaming is cheap now and expensive later, so
every addition goes through the same four steps: (1) an entry in the machine-readable runtime spec, (2) its runtime
routine and a test, (3) its Help text, (4) a line in the changelog at the end of this file. Nothing here is
implemented yet.

## Acceptance games (these decide what is added, in order)
| | Game | Needs |
|---|---|---|
| A | Breakout / Pong | a bat, a ball, bricks, collision, score text, a few sound effects |
| B | Vertical shooter | many sprites, scrolling background, enemy waves, AY music, joystick |
| C | Maze or platformer | tile map, scrolling, tile collision, animation, scenes (title, play, game over) |

Version 0 below is the minimum for **A**. B and C add words (marked *later*) when they are started.

## Kept from Leap V2 (unchanged meaning)
Assignment without `LET`; `IF`/`ELSE`/`ENDIF`; `FOR`/`NEXT`/`STEP`/`EXIT FOR`; `PROC name(p):`...`ENDP`, `CALL`;
`DEF FN`; `DIM a(n)` (one dimension, literal size); `REM`; `END`; operators `AND` `OR` `NOT`, `MOD`, `DIV`; `ABS`
`SGN` `RND` `RANDOMISE` `PEEK` `POKE` `IN` `OUT` `USR`; `PRINT` with `AT` and `TAB`; `INK` `PAPER` `BRIGHT` `FLASH`
`BORDER` `CLS` `PLOT` `LINE` `POINT`. Identifiers: letter then letters/digits, no underscore, case-insensitive.

## Changed or dropped
* **Integers only** (16-bit signed). Sub-pixel movement is done by scaling (positions in 1/8 pixel). Fixed-point
  (`!`) and floats are *later*, added when a game cannot do without; floats stay an optional linked library.
* **No `GOTO` and no labels.** `WHILE`/`WEND`, `EXIT`, `SELECT` and scenes cover the need; reconsider if a game
  shows otherwise.
* **No editor/tape words:** `LIST` `NEW` `RUN` `LOAD` `SAVE` `INPUT` `STOP` `CLEAR` `FREE` and the printer words.
* **No hardware-mode words and no `PALETTE`/`ULAPLUS`.** The build chooses the display setup per scene.
* Strings: `STR$(n)`, `+`, `LEN` only (for score and message text); the rest *later*.

## New in version 0 (for game A)
```
GAME "Breakout"              REM title, once, at the top
FRAMERATE 30                 REM refreshes per FRAME call = 60 / 30; checked against the measured budget

SPRITE bat  = "bat"          REM assets are named; made in the Studio, not in source
SPRITE ball = "ball"
SFX    bounce = "bounce"
TILESET bricks = "bricks"

SCENE play
  DIM bx, by, dx, dy, px, score

  PROC INIT():               REM runs once when the scene starts
    bx = 120 : by = 100 : dx = 2 : dy = -2 : px = 100 : score = 0
  ENDP

  PROC FRAME():              REM runs every FRAMERATE tick; the runtime does sync, drawing and sound
    REM STICK bits as in Leap V2: 0-3 directions (up, down, left, right order to be fixed in the spec), +16 fire
    IF BIT(STICK(1), 2) THEN
      px = px - 4
    ENDIF
    IF BIT(STICK(1), 3) THEN
      px = px + 4
    ENDIF
    bx = bx + dx : by = by + dy
    IF bx < 0 OR bx > 248 THEN
      dx = -dx : PLAY bounce
    ENDIF
    IF HIT(ball, bat) THEN
      dy = -dy : PLAY bounce : score = score + 10
    ENDIF
    SHOW ball AT bx, by
    SHOW bat AT px, 176
    PRINT AT 0, 0; "SCORE "; score
  ENDP
ENDSCENE
```
| Word | Meaning | Why in v0 |
|---|---|---|
| `GAME "t"`, `FRAMERATE n` | title; target updates per second (60, 30, 20, 15, 12, 10...) | frame rate is a design input |
| `SPRITE n = "a"`, `SFX n = "a"`, `TILESET n = "a"`, `MAP n = "a"` | declare named assets from the project | assets are authored in the Studio |
| `SCENE n` ... `ENDSCENE`, `ENTER n` | a game part with its own `INIT` and `FRAME`; `ENTER` switches scene | the build plans display and memory per scene |
| `PROC INIT()`, `PROC FRAME()` | entry points inside a scene | the runtime owns the loop |
| `SHOW s AT x, y [FRAME f]`, `HIDE s` | place / remove a sprite (pixel position, y from the top) | sprites |
| `HIT(a, b)` | 1 if two sprites overlap (pixel-exact test is *later*; bounding boxes first) | collision |
| `PLAY n`, `SILENCE` | start a sound effect; stop sound | sound |
| `BIT(v, n)` | 1 if bit n of v is set (`AND`/`OR` stay logical 0/1 as in V2, so bit tests need this; found while writing the example) | joystick and flag tests |
| `STICK(n)`, `KEYDOWN(code)` | joystick 1/2 bits (0-31, fire +16, as V2); held key test | input |
| `TILE x, y = t`, `TILEAT(x, y)` | set / read a map cell | bricks, *and* game C |

*Later* (not specified until a game needs them): `MUSIC`, `SCROLL`, sprite flip/animation words, `SELECT`/`CASE`,
`WHILE`/`WEND` (these two are likely early, for game B), `COLLIDE` against tiles, fixed-point, more string words,
`ON COLLIDE`, a `TIMER`.

## Rules the compiler enforces
Static names (no run-time name lookup); 16-bit arithmetic with defined wrap; array bounds checked in the
debug build only; a `FRAME` that overruns its refresh budget is reported in the Studio's profile, not by stopping.

## Changelog
* 0.0 (2026-11-09): first draft from the game A target.
* 0.1 (2026-11-09, language batch 1; contract `docs/ARCADE_LANGUAGE_BATCH1.md`, tests `tests/arcade-m5.mjs`): `CONST`; `PROC` with 0 to 4 parameters and
  `LOCAL` (an undeclared `FOR` variable inside a PROC becomes a local); `BAND` `BOR` `BXOR` `BNOT` `SHL` `SHR`; `DIM a(n) = v0, v1, ...` and two-dimensional
  `DIM b(w, h)`; `RANDOMISE [n]` and `BORDER n`; `PRINT AT r, c;` with no items only positions the cursor; asset names (SPRITE, SFX, TILESET, MAP) live
  apart from variables, PROCs and DEF FNs; `FILL` `FILLC` `COPY` `LOADMAP [AT]`; up to 8 `MAP`s. Decisions where the contract was silent (also at the top
  of `tests/arcade-m5.mjs`): a CONST may also use `BIT()`, DIV or MOD by zero in a CONST is an error, a CONST is visible below its declaration only, and
  no parameter, LOCAL or FOR variable may take a CONST's name; locals (and implicit FOR variables) are 0 at the start of every call; `LOCAL` may stand
  anywhere at the top level of a PROC but not after its first use; an initialiser must be the last item of its `DIM`; a 2-D array has index i (slow)
  0..w and j 0..h, flat slot i * (h + 1) + j, each index checked on its own, w and h at least 1, at most 1000 slots; `FILL` ignores a tile outside the
  tileset and `FILLC` a character outside 32..127; `RANDOMISE n` seeds n AND $FFFF (0 becomes 1); `LOADMAP` gives a font cell the attribute $38. Slots of
  different PROCs are not shared. New reserved words: CONST LOCAL FILL FILLC COPY LOADMAP BAND BOR BXOR BNOT SHL SHR.
