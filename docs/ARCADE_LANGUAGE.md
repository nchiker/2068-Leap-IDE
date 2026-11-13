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
| `SCENE n NOWINDOW` / `SCENE n NOVIEW` | a scene of a `WINDOW` / `VIEW3D` / `WIRE3D` game that shows no window / 3D view / wireframe play area: the whole cell screen and sprites at screen positions (title, menu, score table); the window / view / play area comes back when a scene without the clause is entered (`NOVIEW` covers both `VIEW3D` and `WIRE3D` games) | a full-screen title in a game whose play scenes scroll, ray-cast or draw wireframes |
| `PROC INIT()`, `PROC FRAME()` | entry points inside a scene | the runtime owns the loop |
| `SHOW s AT x, y [FRAME f]`, `HIDE s` | place / remove a sprite (pixel position, y from the top) | sprites |
| `HIT(a, b)` | 1 if two sprites overlap (pixel-exact test is *later*; bounding boxes first) | collision |
| `PLAY n`, `SILENCE` | start a sound effect; stop sound | sound |
| `BIT(v, n)` | 1 if bit n of v is set (`AND`/`OR` stay logical 0/1 as in V2, so bit tests need this; found while writing the example) | joystick and flag tests |
| `STICK(n)`, `KEYDOWN(code)` | joystick 1/2 bits (0-31, fire +16, as V2); held key test | input |
| `TILE x, y = t`, `TILEAT(x, y)` | set / read a map cell | bricks, *and* game C |

*Music is built* (2026-11-12): `MUSIC name = "asset"`, `PLAY song`, `NOMUSIC`; `docs/ARCADE_MUSIC_CONTRACT.md` sections 2 and 6a. *Later* (not specified until a game needs them): `SCROLL`, sprite flip/animation words, `SELECT`/`CASE`,
`WHILE`/`WEND` (these two are likely early, for game B), `COLLIDE` against tiles, fixed-point, more string words,
`ON COLLIDE`, a `TIMER`.

*Wireframe 3D is built* (2026-11-12; contract `docs/ARCADE_WIREFRAME_CONTRACT.md` sections 1 to 3 and the as-built notes 7a / 7b; runtime `docs/ARCADE_RUNTIME_API_V2.md` "As built: wireframe 3D"):
```
WIRE3D ROWS 2 TO 21 INK 5 PAPER 0 BRIGHT 1       REM top level, once: the play area is character rows 2..21, all 32 columns
MODEL gate = "gate"                              REM a wireframe model asset (up to 32)
  EYE ex, 0, ez, ea                              REM the viewer: world position and heading
  DRAWMODEL gate AT gx, 0, gz YAW t PITCH p SCALE 2
  LINE 120, 96 TO 136, 96                        REM a 2-D line in screen pixels
```
`WIRE3D ROWS r0 TO r1 [INK n] [PAPER n] [BRIGHT n]` gives the game a play area (r0 >= 0, r0 + 3 <= r1 <= 23, so at least 4 rows; defaults `INK 7 PAPER 0 BRIGHT 1`) in which only lines are drawn,
in one colour for the whole area (the attribute is set once; lines are not coloured per model). `MODEL name = "asset"` declares a model: 1..128 points, 1..255 edges, coordinates -64..64, x right, y up, z forward (`docs/ARCADE_ASSETS.md`).
`EYE x, y, z, a` sets the viewer (signed 16-bit position, heading `a` taken AND 255, 256 to a turn; it is 0, 0, 0, 0 at the start and after `ENTER`). `DRAWMODEL m AT x, y, z [YAW a] [PITCH p] [SCALE s]`
draws model `m` at once, seen from the eye: turned by PITCH about its own x axis, then by YAW about the vertical axis (both AND 255, default 0), scaled by the constant 1, 2, 4 or 8 (default 1); its clauses may come in any order and
are evaluated as x, y, z, yaw, pitch. `LINE x0, y0 TO x1, y1` draws a 2-D line in screen pixels (y from the top), clipped exactly to the play area; a coordinate outside -16384..16383 draws nothing. The play area is cleared at the
start of every tick, so `DRAWMODEL` and `LINE` belong in `PROC FRAME` (a warning for one in `INIT`); sprites are drawn over the lines, and `PRINT` / `TILE` inside the play rows are kept in the cell map but not shown while the area is on
(a warning for a constant row inside it). There is no 3D clipping: an edge with an end behind the eye (camera z below 16) or beyond 16,000 is not drawn, and neither is a model whose offset from the eye exceeds 16,000 in any axis.
`SCENE name NOVIEW` in a `WIRE3D` game is a scene without the play area (title, menu, score table; `DRAWMODEL` and `LINE` do nothing there, `EYE` is stored). Errors: `WIRE3D` twice, with a `WINDOW` or a `VIEW3D`, rows out of range,
a colour outside 0..7, `EYE` / `DRAWMODEL` / `LINE` / `MODEL` without a `WIRE3D`, `DRAWMODEL` of a name that is not a model, `SCALE` not a constant 1, 2, 4 or 8, `NOVIEW` in a game with neither `VIEW3D` nor `WIRE3D`; warning: a `MODEL` never drawn.
A `WIRE3D` game needs the **v2 runtime** (`requiredRuntime` says so; v3 and v4 refuse it) and its sprite art may have at most 45 phases in all (a link error otherwise). `COSA(a)`, `SINA(a)` and `FXMUL(a, b)` now work on the **v2 and the
v4 runtime** with the same values (8.8 fixed point, -256..256), so a game moves along its heading with `x = x + FXMUL(speed, SINA(a))` and `z = z + FXMUL(speed, COSA(a))`; the v3 runtime refuses them. New reserved words: WIRE3D MODEL EYE
DRAWMODEL (LINE was reserved already); they may still name an asset as MUSIC does. ROWS YAW PITCH SCALE are contextual (a variable `yaw` keeps working). The sample game is `arcade/examples/orbit.arc` ("Orbit Gates").

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
* 0.2 (2026-11-09, language batch 2, the platformer slice; contract `docs/ARCADE_PLATFORMER_CONTRACT.md`, decisions `docs/ARCADE_LANGUAGE_BATCH2.md`, tests `tests/arcade-m6-compiler.mjs`): `WINDOW map [AT cx, cy]`
  and `BAND rows, num, den` (top level; BAND is also still the bit function `BAND(a, b)`), `CAMERA x`, `CAMX()`, `SETWORLD x, y = t`, `WORLDTILE(x, y)`, `TILEFLAGS(x, y)`, `TILEHIT(x, y, w, h, mask)`, `SOLID(x, y, w, h)`,
  and `SHOW s AT x, y [FRAME f] [FLIP]` with FRAME and FLIP compiled (FLIP is a contextual word). Sprites of 8..32 x 1..48 pixels with frames (the compiler appends the mirrored frames to an asset used with FLIP),
  per-tile `flags` from the tileset, a world map of 24..128 x 1..16 cells with tiles 0..31. Needs the v3 runtime; a pre-v3 runtime refuses the new words with a clear error. New reserved words: WINDOW CAMERA
  SETWORLD CAMX WORLDTILE TILEFLAGS TILEHIT SOLID. Decisions where the contract was silent are in the batch 2 file (for example the corner rule of TILEFLAGS, `TILEHIT` with w or h <= 0, SETWORLD in pixels with the tile checked by
  the compiler, which frames are compiled, the phase-memory estimate and `PHASE_POOL_BYTES`).
* 0.3 (2026-11-10, language batch 3, the raycaster slice; contract `docs/ARCADE_RAYCASTER_CONTRACT.md` section 6, decisions `docs/ARCADE_LANGUAGE_BATCH3.md`, tests `tests/arcade-m8-compiler.mjs`):
  `VIEW3D map [COLW 2|4] [INK n] [CEIL n] [FLOOR n] [BRIGHT n] [PATTERNS b0, ..., b15]` (top level, once: the MAP is the floor plan of a first-person 3D view in a 128 x 96 window, 4..32 cells a side, wall types 0..4,
  outer ring walls), `VIEW x, y, a` (the viewer: 8.8 positions, angle 0..255), `SETWALL x, y = t`, `WALL(x, y)`, `COSA(a)`, `SINA(a)`, `FXMUL(a, b)` (8.8 maths), `SEEN(s)` and `DEPTH(s)` (where the last picture drew a
  billboard sprite), and `SHOW` / `HIT` in ray mode (8.8 world coordinates, unclamped; `HIT` by the sprites' sizes). Needs the v4 runtime; `requiredRuntime` returns 4 for any of these words. A program cannot have both a
  `WINDOW` and a `VIEW3D`. New reserved words: VIEW3D VIEW SETWALL COSA SINA FXMUL WALL SEEN DEPTH (they may still name an asset: `SFX wall = "wall"` keeps working); COLW CEIL FLOOR PATTERNS are contextual.
* 0.4 (2026-11-10, language batch 4, scenes; contract and decisions `docs/ARCADE_LANGUAGE_BATCH4.md`, tests `tests/arcade-m9-compiler.mjs`, `tests/arcade-m9-differential.mjs`, `tests/arcade-display.mjs`, `arcade/tests/m9-mutations.mjs`):
  any number of `SCENE name ... ENDSCENE` (the first starts the game) and `ENTER name` (a statement that does not return: it abandons every running PROC, resets the machine to the game start state (sound, sprites, text state,
  border, screen, first MAP), zeroes the target scene's own variables and re-applies its array initialisers, runs its `INIT` in the same tick, and its `FRAME` runs from the next tick). Scene-level variables, CONSTs, PROCs and DEF FNs are
  private to the scene (two scenes may reuse names); game-level variables survive a switch; `WINDOW` and `VIEW3D` are game-wide. Done in the compiler's generated code with existing runtime routines: no runtime change in v2, v3 or v4.
  In a game with several scenes a scene's names are keyed `SCENE.NAME` in `symbols` and interpreter records. New checks: unreachable statement after `ENTER`, a scene nobody enters (warning). The display plan per scene
  (`sceneDisplayPlan`, `scenes.<name>.display` in the project) is reported in the Studio; only the two-buffer setup is built. No new reserved words.
* 0.5 (2026-11-10, language batch 5; contract `docs/ARCADE_LANGUAGE_BATCH5.md`, tests `tests/arcade-m10-compiler.mjs`, `tests/arcade-m10-differential.mjs`, `arcade/tests/m10-runtime-sound.mjs`, mutation `m10c-mutations.mjs` and `m10-mutations.mjs`):
  `TIMER a, b` (variables the game counts down by itself, once a tick before FRAME, to 0), `KEYPRESS(c)` and `JOYPRESS(n)` (1 / the mask of STICK bits during the tick a key went down; the state is taken at the start of every FRAME and survives `ENTER`),
  `PRINT item USING "##00"` (right-aligned fixed field, zero fill from the first `0`, `*` fill on overflow; a ~180-byte `lib$fmt` only when a run-time value is used), `PLAY expr` (an effect index; a bare SFX name still plays by name; out of range does nothing)
  and three-channel sound effects (`ticksB` / `ticksC` in the SFX asset: groups of 12 bytes, one shared noise generator; the runtimes v2, v3, v4 got a three-channel interrupt tick). New reserved words TIMER KEYPRESS JOYPRESS; USING is contextual.
* 0.7 (2026-11-11, language batch 7, scenes without the window or the 3D view; contract and decisions `docs/ARCADE_LANGUAGE_BATCH7.md`, tests `tests/arcade-m14-compiler.mjs`, `tests/arcade-m14-differential.mjs`):
  `SCENE name NOWINDOW` (a `WINDOW` game) and `SCENE name NOVIEW` (a `VIEW3D` game): the scene's display mode. A scene without the clause shows the window / view as before; a scene with it runs as a game without one would (the whole
  32 x 24 cell screen: text, `TILE`, `LOADMAP`, `CLS`; sprites at screen positions drawn by the 2D sprite machinery, `SHOW` clamped to the screen, `HIT` on the hot boxes), while the world words (`CAMERA`, `SETWORLD`, `WORLD`,
  `WORLDTILE`, `TILEFLAGS`, `TILEHIT`, `SOLID`, `CAMX`, `VIEW`, `SETWALL`, `WALL`, `SEEN`, `DEPTH`) keep working on the stored world / camera / pose / walls. The mode is set by `ENTER` (after the machine reset, before the target's
  `INIT`) and, for the first scene, at the start; switching on draws the window / view again from the state as it is. Errors: `NOWINDOW` without a `WINDOW`, `NOVIEW` without a `VIEW3D`, the wrong one of the two, anything else after the
  scene name. The words are contextual (`nowindow` stays a legal variable name). In a program with at least one clause every `ENTER` sequence and the boot call the runtime's mode routine (`RT_WINMODE` v3, `RT_VIEWMODE` v4) with A = 0
  or 1; a program without the clause compiles to the same bytes as before. A `VIEW3D` game with a `NOVIEW` scene also gets a second phase-pool plan (3,712 bytes against 5,888); sprite art that does not fit is a build error (use fewer
  phases). Needs a runtime that has the routines (a build of language batch 7); a runtime without them is a compile error that names the routine.
* 0.8 (2026-11-12, wireframe 3D; contract `docs/ARCADE_WIREFRAME_CONTRACT.md`, tests `arcade/tests/m17-runtime-wire.mjs`, `arcade/tests/m17-runtime-tick.mjs`): `WIRE3D ROWS r0 TO r1 [INK n] [PAPER n] [BRIGHT n]`, `MODEL name = "asset"`, `EYE x, y, z, a`,
  `DRAWMODEL m AT x, y, z [YAW a] [PITCH p] [SCALE s]` and `LINE x0, y0 TO x1, y1` (a new use of the word `LINE`, which was already reserved); `SCENE name NOVIEW` also in a `WIRE3D` game; `COSA`, `SINA`, `FXMUL` on the v2 runtime as well as v4
  (before: v4 only; `requiredRuntime` no longer forces v4 for them, a program that used them only with `VIEW3D` is unchanged). Needs the v2 runtime for `WIRE3D`. New reserved words WIRE3D MODEL EYE DRAWMODEL; contextual ROWS YAW PITCH SCALE.
  Detail in the paragraph "Wireframe 3D is built" above.
