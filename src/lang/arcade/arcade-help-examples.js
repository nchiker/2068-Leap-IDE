/**
 * src/lang/arcade/arcade-help-examples.js — the Help overlay's hand-written part for Leap Arcade (pure: no DOM; Node can import it).
 *
 *   HELP_EXAMPLES   word -> a short example (a complete game, a scene, a declaration or a few statements); shown in the word's Help entry
 *   HELP_ALIASES    clause and closing words -> the word whose example shows them (ENDP -> PROC, FLIP -> SHOW, ...)
 *   HELP_PAGES      the extra pages of the Help overlay ("How a game is built"): [{id, title, blocks: [{type: 'h' | 'p' | 'code', text}]}]
 *
 * tools/gen-arcade-help.mjs merges the examples into src/lang/arcade/arcade-help-data.js (with each word's manual section).
 * Every example and every code block of a page is COMPILED by tests/arcade-help-data.mjs, with no error and no warning, inside a
 * minimal game: a complete program (it has a GAME line) as it stands; text with a SCENE gets a GAME header; a declaration (SPRITE, TIMER,
 * WINDOW, ...) gets a header and an empty scene; statements are put into the FRAME of a scene. The asset names an example uses
 * (ship, ball, bat, bullet, hero, gfx, tiles, sky, level, plan, zap, boom, pew, theme, gate) and its plain variables (x, y, dx, ...) are
 * declared by that wrapper (the list is in the test), so a fragment may use them without declaring them: in your own game you declare
 * them as the Help page "How a game is built" shows.
 * Style: keywords in capitals, two spaces of indent, at most about 12 lines, Leap Arcade words only (no LET, no GOTO).
 */

"use strict";

export const HELP_EXAMPLES = {
  // ── the shape of a game ───────────────────────────────────────────────────────────────────────────────────────────────────────
  GAME: `GAME "Hello"
FRAMERATE 30
SCENE title
  PROC INIT():
    PRINT AT 11, 12; "HELLO";
  ENDP
  PROC FRAME():
    REM runs 30 times a second
  ENDP
ENDSCENE`,
  FRAMERATE: `FRAMERATE 30      REM FRAME runs 30 times a second (60, 30, 20, 15, 12 or 10)`,
  SCENE: `SCENE play
  DIM score
  PROC INIT():
    score = 0
    PRINT AT 0, 0; "SCORE";
  ENDP
  PROC FRAME():
    score = score + 1
    PRINT AT 0, 6; score USING "0000";
  ENDP
ENDSCENE`,
  END: `IF lives = 0 THEN
  PRINT AT 11, 11; "GAME OVER";
  END               REM the picture stays; nothing runs again
ENDIF`,
  ENTER: `SCENE title
  PROC INIT():
    PRINT AT 11, 8; "PRESS FIRE";
  ENDP
  PROC FRAME():
    IF KEYPRESS(" ") OR BIT(JOYPRESS(1), 4) THEN ENTER play ENDIF
  ENDP
ENDSCENE
SCENE play
  PROC INIT():
    PRINT AT 11, 10; "PLAYING";
  ENDP
  PROC FRAME():
    REM the game goes here
  ENDP
ENDSCENE`,
  INIT: `SCENE play
  DIM x, y
  PROC INIT():           REM runs once when the scene starts
    x = 120 : y = 88
    PRINT AT 0, 0; "GO";
  ENDP
  PROC FRAME():          REM runs every tick
    x = x + 1
  ENDP
ENDSCENE`,
  PROC: `PROC BANNER(row):
  PRINT AT row, 10; "GAME OVER";
ENDP
REM then, in INIT or FRAME:
CALL BANNER(11)`,
  CALL: `PROC GREET(c, r):
  PRINT AT r, c; "HI";
ENDP
CALL GREET(4, 6)`,
  DEF: `DEF FN half(v) = v DIV 2
score = FN half(100)
PRINT AT 0, 0; score;`,
  CONST: `CONST PACE = 3
CONST TOP = 16
x = x + PACE
IF y < TOP THEN y = TOP ENDIF`,
  LOCAL: `PROC STEP2(v):
  LOCAL a, b
  a = v * 2
  b = a + 1
  PRINT AT 0, 0; b;
ENDP
CALL STEP2(4)`,
  DIM: `DIM lives, hits           REM numbers (16-bit integers)
DIM bx(7)                 REM an array: bx(0) to bx(7)
DIM board(9, 4)           REM two dimensions
DIM hx(2) = 80, 160, 88   REM with start values
lives = 3 : hits = hx(1)
bx(3) = board(2, 1) + 1`,
  TIMER: `TIMER cooldown            REM counts down by itself, once a tick, to 0
SCENE play
  PROC INIT():
    cooldown = 30
  ENDP
  PROC FRAME():
    IF cooldown = 0 THEN PRINT AT 0, 0; "READY"; ENDIF
  ENDP
ENDSCENE`,
  TABLE: `DIM lx(2), ly(2), n
TABLE room1
  lx = 40, 80, 120
  ly = 50, 60, 70
  n = 3
ENDTABLE
TABLE room2
  lx = 20, 90, 200
  ly = 100, 50, 150
  n = 3
ENDTABLE
LOADTABLE room1`,
  LOADTABLE: `DIM lx(2), n
TABLE room1
  lx = 40, 80, 120
  n = 3
ENDTABLE
TABLE room2
  lx = 20, 90, 200
  n = 3
ENDTABLE
LOADTABLE room2           REM or LOADTABLE n, to pick the table by number`,

  // ── assets ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  SPRITE: `SPRITE ship = "ship"          REM "ship" is the picture's name in the Sprites tab
SPRITE bullet(4) = "bullet"   REM a pool: bullet(0) to bullet(3)
SHOW ship AT 120, 160
SHOW bullet(2) AT 120, 100`,
  SFX: `SFX zap = "zap"           REM a sound effect from the Sounds tab
PLAY zap`,
  MUSIC: `MUSIC theme = "theme"     REM a song from the Music tab
PLAY theme
REM later: NOMUSIC`,
  TILESET: `TILESET gfx = "gfx"       REM the 8 x 8 tiles drawn in the Tiles tab
TILE 4, 4 = 1             REM tile number 1 at row 4, column 4`,
  MAP: `TILESET gfx = "gfx"       REM a map needs a tileset
MAP sky = "sky"           REM a screen of tiles from the Maps tab
LOADMAP sky`,
  MODEL: `MODEL gate = "gate"       REM a wireframe model from the Models tab
WIRE3D ROWS 2 TO 21
EYE 0, 0, 0, 0
DRAWMODEL gate AT 0, 0, 400`,
  SHOW: `SPRITE walker = "walker"
SHOW walker AT x, y                 REM pixels; y counts from the top
SHOW walker AT x, y FRAME 1         REM picture phase 1
SHOW walker AT x, y FRAME 1 FLIP    REM mirrored
HIDE walker`,
  HIDE: `SHOW ball AT x, y
IF y > 180 THEN HIDE ball ENDIF`,
  HIT: `IF HIT(ship, ball) THEN
  score = score + 10
  HIDE ball
ENDIF`,

  // ── sound ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  PLAY: `SFX zap = "zap"
SFX boom = "boom"
MUSIC theme = "theme"
PLAY zap          REM a sound effect, by its name
PLAY 1            REM or by its number (0 is zap, 1 is boom)
PLAY theme        REM a song, by its name`,
  SILENCE: `PLAY zap
SILENCE           REM stops the effect (not the song)`,
  NOMUSIC: `PLAY theme
NOMUSIC           REM stops the song`,

  // ── the screen ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  PRINT: `INK 6
PRINT AT 2, 10; "SCORE "; score;
PRINT AT 3, 10; score USING "0000";    REM 0042: right-aligned, zeros in front
PRINT AT 4, 10; "LIVES "; lives;`,
  TAB: `PRINT AT 5, 0; "NAME";
PRINT TAB 12; "SCORE";      REM column 12 of the same row
PRINT AT 7, 0; TAB 4; "INDENTED";`,
  USING: `PRINT AT 0, 0; score USING "00000";   REM 00042
PRINT AT 1, 0; lives USING "##";       REM " 3"`,
  CLS: `CLS               REM clear the screen`,
  INK: `INK 6 : PAPER 0 : BRIGHT 0
PRINT AT 5, 5; "YELLOW ON BLACK";`,
  PAPER: `PAPER 0 : INK 7
CLS`,
  BRIGHT: `PAPER 0 : INK 5 : BRIGHT 0     REM BRIGHT 1 on black paper shows grey in TSRun
PRINT AT 5, 5; "CYAN";`,
  FLASH: `FLASH 1
PRINT AT 11, 11; "PRESS FIRE";
FLASH 0           REM the text printed after this is steady again`,
  BORDER: `BORDER 2          REM red border`,
  LINE: `LINE 20, 40 TO 230, 150     REM in the WIRE3D play area (rows 2 to 21), in pixels`,
  TILE: `TILE 4, 4 = 1     REM tile number 1 of the TILESET at row 4, column 4`,
  TILEAT: `IF TILEAT(x DIV 8, y DIV 8) = 1 THEN PRINT AT 0, 0; "WALL"; ENDIF`,
  FILL: `FILL 0, 0, 32, 1 = 1        REM a row of tile 1 along the top`,
  FILLC: `FILLC 0, 23, 32, 1 = 32     REM clear the bottom row (32 is a blank)`,
  COPY: `COPY 0, 1, 32, 22 TO 0, 0    REM scroll the cells up one row`,
  LOADMAP: `MAP sky = "sky"
LOADMAP sky
LOADMAP sky AT 4, 4        REM a smaller map at a cell position`,
  STR$: `PRINT AT 0, 0; "SCORE " + STR$(score);`,
  POKE: `POKE p, 7         REM the byte at address p becomes 7 (p AND 65535, the value AND 255)
POKE p + 1, 300   REM 300 is stored as 44`,
  PEEK: `POKE p, 7
x = PEEK(p)       REM 0..255: the byte at address p (AND 65535)`,
  RANDOMISE: `RANDOMISE          REM seed from the frame counter
RANDOMISE 42       REM or a fixed seed: the same game every time
x = RND(10)`,

  // ── input ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  STICK: `js = STICK(1)                    REM bits: 1 up, 2 down, 4 left, 8 right, 16 fire
IF BIT(js, 2) THEN x = x - 2 ENDIF
IF BIT(js, 3) THEN x = x + 2 ENDIF`,
  BIT: `IF BIT(STICK(1), 4) THEN PRINT AT 0, 0; "FIRE"; ENDIF    REM bit 4 of the number is set`,
  KEYDOWN: `IF KEYDOWN("Q") THEN y = y - 2 ENDIF    REM true while the key is held
IF KEYDOWN("A") THEN y = y + 2 ENDIF
IF KEYDOWN(" ") THEN PRINT AT 0, 0; "SPACE"; ENDIF`,
  KEYPRESS: `IF KEYPRESS(" ") THEN shots = shots + 1 ENDIF    REM true in the one tick the key goes down`,
  JOYPRESS: `IF BIT(JOYPRESS(1), 4) THEN shots = shots + 1 ENDIF    REM the fire button went down this tick`,

  // ── control flow ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  IF: `IF x > 248 THEN
  x = 248
ELSE
  x = x + 1
ENDIF
IF lives = 0 THEN PRINT AT 11, 11; "GAME OVER"; ENDIF`,
  FOR: `FOR i = 0 TO 7
  bx(i) = i * 8
NEXT i
FOR j = 10 TO 0 STEP -2
  PRINT AT j, 0; "*";
NEXT j`,
  WHILE: `WHILE x < 100
  x = x + 8
WEND`,
  EXIT: `FOR i = 0 TO 7
  IF bx(i) = 0 THEN EXIT FOR ENDIF
NEXT i`,
  SELECT: `SELECT CASE lives
  CASE 0
    PRINT AT 0, 0; "DEAD";
  CASE 1, 2
    PRINT AT 0, 0; "CAREFUL";
  CASE ELSE
    PRINT AT 0, 0; "FINE";
ENDSEL`,
  REM: `REM a comment runs to the end of the line
x = 1 : REM so does one after a statement`,

  // ── operators and arithmetic ──────────────────────────────────────────────────────────────────────────────────────────────────
  AND: `IF x > 10 AND x < 20 THEN PRINT AT 0, 0; "IN"; ENDIF`,
  OR: `IF x < 0 OR x > 248 THEN dx = -dx ENDIF`,
  NOT: `IF NOT HIT(ship, ball) THEN PRINT AT 0, 0; "MISS"; ENDIF`,
  MOD: `IF t MOD 8 = 0 THEN PRINT AT 0, 0; "TICK"; ENDIF    REM the remainder`,
  DIV: `row = y DIV 8       REM whole-number division: 100 DIV 8 is 12`,
  ABS: `d = ABS(x - 100)    REM the distance, whatever the sign`,
  SGN: `dx = SGN(100 - x)   REM -1, 0 or 1`,
  RND: `x = RND(10)         REM 0 to 9
y = 16 + RND(160)`,
  BAND: `IF BAND(t, 7) = 0 THEN PRINT AT 0, 0; "TICK"; ENDIF    REM bitwise AND: every 8th tick
x = BAND(x + 1, 255)                                    REM wrap at 256`,
  BOR: `flags = BOR(flags, 4)       REM set bit 2`,
  BXOR: `flags = BXOR(flags, 1)      REM flip bit 0`,
  BNOT: `flags = BAND(flags, BNOT(4))   REM clear bit 2`,
  SHL: `x = SHL(n, 3)          REM n * 8`,
  SHR: `x = SHR(n, 3)          REM n DIV 8`,

  // ── the scrolling window (platformer slice, runtime v3) ───────────────────────────────────────────────────────────────────────
  WINDOW: `GAME "Window"
FRAMERATE 30
SPRITE hero = "hero"
TILESET tiles = "tiles"
MAP level = "level"
WINDOW level
SCENE play
  DIM x
  PROC INIT():
    x = 40
  ENDP
  PROC FRAME():
    x = x + 1
    CAMERA x - 100
    SHOW hero AT x - CAMX(), 100
  ENDP
ENDSCENE`,
  CAMERA: `CAMERA x - 100       REM the camera follows x (the world is wider than the window)
SHOW hero AT x - CAMX(), 100`,
  CAMX: `SHOW hero AT x - CAMX(), 100     REM world x -> window x`,
  SETWORLD: `SETWORLD 80, 40 = 0        REM the cell at world pixel (80, 40) becomes tile 0`,
  WORLDTILE: `IF WORLDTILE(x, y) = 3 THEN score = score + 1 ENDIF`,
  TILEFLAGS: `IF BAND(TILEFLAGS(x, y + 16), 1) THEN dy = 0 ENDIF    REM bit 0 is the tile's "solid" flag`,
  TILEHIT: `IF TILEHIT(x, y, 16, 24, 4) THEN lives = lives - 1 ENDIF   REM any tile under the box has flag bit 4 (mask 4)`,
  SOLID: `IF SOLID(x, y + 1, 16, 24) THEN dy = 0 ENDIF    REM standing on something solid`,

  // ── the 3D views ──────────────────────────────────────────────────────────────────────────────────────────────────────────────
  VIEW3D: `GAME "Vault"
FRAMERATE 20
TILESET gfx = "gfx"
MAP plan = "plan"
VIEW3D plan COLW 4 INK 5 CEIL 0 FLOOR 1
SCENE play
  DIM px, py, pa
  PROC INIT():
    px = 4 * 256 + 128 : py = 4 * 256 + 128
  ENDP
  PROC FRAME():
    pa = pa + 1
    VIEW px, py, pa
  ENDP
ENDSCENE`,
  VIEW: `VIEW px, py, pa      REM the viewer: 8.8 position (256 = one cell), angle 0 to 255`,
  SETWALL: `SETWALL 5, 3 = 0       REM open the wall at map cell (5, 3)`,
  WALL: `IF WALL(px DIV 256, py DIV 256) = 0 THEN ok = 1 ENDIF`,
  SEEN: `IF SEEN(ghost) THEN PRINT AT 0, 0; "SEEN"; ENDIF`,
  DEPTH: `d = DEPTH(ghost)       REM how far away a billboard sprite was drawn`,
  COSA: `x = x + FXMUL(speed, COSA(a))    REM 8.8 maths: COSA and SINA give -256 to 256`,
  SINA: `y = y + FXMUL(speed, SINA(a))`,
  FXMUL: `x = x + FXMUL(speed, SINA(a))   REM multiply two 8.8 numbers`,
  WIRE3D: `GAME "Wires"
FRAMERATE 30
MODEL gate = "gate"
WIRE3D ROWS 2 TO 21 INK 5 PAPER 0 BRIGHT 0
SCENE fly
  DIM a
  PROC INIT():
    a = 0
  ENDP
  PROC FRAME():
    a = a + 2
    EYE 0, 0, 0, 0
    DRAWMODEL gate AT 0, 0, 500 YAW a SCALE 2
  ENDP
ENDSCENE`,
  EYE: `EYE px, 0, pz, ea     REM the viewer: x, y, z and a heading (256 to a turn)
DRAWMODEL gate AT 0, 0, 500`,
  DRAWMODEL: `DRAWMODEL gate AT 0, 0, 500 YAW a PITCH 0 SCALE 2    REM clauses are optional; SCALE is 1, 2, 4 or 8`,
  WORLD: `MAP level = "level"
MAP level2 = "level2"
WORLD level2                 REM make level2 the world of the WINDOW
WORLD n OF level, level2     REM or pick by number: 0 is level, 1 is level2`,
  NOWINDOW: `GAME "Runner"
FRAMERATE 30
TILESET tiles = "tiles"
MAP level = "level"
WINDOW level
SCENE title NOWINDOW         REM the whole screen, no scrolling window
  PROC INIT():
    PRINT AT 11, 10; "LEAP RUNNER";
  ENDP
  PROC FRAME():
    IF KEYPRESS(" ") THEN ENTER play ENDIF
  ENDP
ENDSCENE
SCENE play                   REM this scene shows the window again
  PROC INIT():
    CAMERA 0
  ENDP
  PROC FRAME():
    CAMERA CAMX() + 1
  ENDP
ENDSCENE`,
  NOVIEW: `GAME "Vault"
FRAMERATE 20
TILESET gfx = "gfx"
MAP plan = "plan"
VIEW3D plan COLW 4 INK 5 CEIL 0 FLOOR 1
SCENE title NOVIEW           REM the whole screen, no 3D view
  PROC INIT():
    PRINT AT 11, 12; "VAULT";
  ENDP
  PROC FRAME():
    IF KEYPRESS(" ") THEN ENTER play ENDIF
  ENDP
ENDSCENE
SCENE play                   REM this scene shows the 3D view again
  DIM pa
  PROC INIT():
    pa = 0
  ENDP
  PROC FRAME():
    pa = pa + 1
    VIEW 1152, 1152, pa
  ENDP
ENDSCENE`,
};

/** Words whose example is the example of another word (a clause, a closing word, a contextual word). */
export const HELP_ALIASES = {
  ENDSCENE: 'SCENE', ENDP: 'PROC', FN: 'DEF', ENDTABLE: 'TABLE', THEN: 'IF', ELSE: 'IF', ENDIF: 'IF',
  TO: 'FOR', STEP: 'FOR', NEXT: 'FOR', WEND: 'WHILE', CASE: 'SELECT', ENDSEL: 'SELECT',
  AT: 'SHOW', FRAME: 'SHOW', FLIP: 'SHOW', ROWS: 'WIRE3D', YAW: 'DRAWMODEL', PITCH: 'DRAWMODEL', SCALE: 'DRAWMODEL',
  COLW: 'VIEW3D', CEIL: 'VIEW3D', FLOOR: 'VIEW3D', PATTERNS: 'VIEW3D',
};

export const HELP_PAGES = [
  {
    id: 'how-a-game-is-built',
    title: 'How a game is built',
    blocks: [
      { type: 'h', text: 'The shape of a game' },
      { type: 'p', text: 'A game is one program made of scenes: a title, the play, the game over. It starts with GAME and FRAMERATE, declares the assets it uses, then lists its scenes. The first scene starts the game; ENTER switches to another.' },
      { type: 'code', text: `GAME "Dash"
FRAMERATE 30
SPRITE ball = "ball"
SCENE title
  PROC INIT():                 REM runs once, when the scene starts
    PRINT AT 11, 10; "PRESS FIRE";
  ENDP
  PROC FRAME():                REM runs every tick, 30 times a second here
    IF KEYPRESS(" ") OR BIT(JOYPRESS(1), 4) THEN ENTER play ENDIF
  ENDP
ENDSCENE
SCENE play
  DIM x, y
  PROC INIT():
    x = 120 : y = 88
  ENDP
  PROC FRAME():
    IF BIT(STICK(1), 2) THEN x = x - 2 ENDIF
    IF BIT(STICK(1), 3) THEN x = x + 2 ENDIF
    SHOW ball AT x, y
  ENDP
ENDSCENE` },
      { type: 'p', text: 'Every variable is a 16-bit integer and is declared with DIM. A DIM inside a scene belongs to that scene and starts at 0 each time the scene is entered; a DIM at the top of the game is shared by every scene and keeps its value across ENTER. ENTER also clears the screen and the sprites and stops the sound, so a scene starts clean.' },
      { type: 'h', text: 'Assets by name' },
      { type: 'p', text: 'Pictures and sounds are not typed into the source. You draw them in the editors of the right-hand panel (Sprites, Tiles, Maps, Sounds, Models) and the program declares each one it uses: SPRITE ship = "ship" gives the asset called "ship" the name ship in the code. The same word can serve as both. The kinds are SPRITE, TILESET, MAP, SFX, MUSIC and MODEL.' },
      { type: 'code', text: `GAME "Pictures"
FRAMERATE 30
SPRITE ship = "ship"           REM a picture from the Sprites tab
TILESET gfx = "gfx"            REM 8 x 8 tiles from the Tiles tab
MAP sky = "sky"                REM a screen of tiles from the Maps tab
SFX zap = "zap"                REM a sound effect from the Sounds tab
SCENE show
  PROC INIT():
    LOADMAP sky
    PLAY zap
  ENDP
  PROC FRAME():
    SHOW ship AT 120, 160
  ENDP
ENDSCENE` },
      { type: 'p', text: 'The project keeps the source files and every asset together, and Save writes them all to one .leapgame file. main.arc is compiled first and the other files follow from A to Z (+ File adds one). The objects you place on a map (coins, enemies) become a generated file, objects.arc, with one TABLE per map: the game reads one with LOADTABLE. It is shown read-only; change the objects in the Maps tab.' },
      { type: 'h', text: 'Run, test, ship' },
      { type: 'p', text: 'Run (F5) compiles the whole project and starts the game on a stock TS2068 in the Display tab. Click the screen to play: the arrow keys and Space are joystick 1, and letter keys reach KEYDOWN("Q") and KEYPRESS("Q"). Stop is F6; Pause (F8) and Step tick (F10) are under the screen. New offers starter games and Examples opens finished ones. ⬇ DCK downloads the game as a cartridge that runs on a stock TS2068 or in any emulator that takes a dock file.' },
      { type: 'h', text: 'Where the limits show' },
      { type: 'p', text: 'Size and budget (under the screen) shows how much of the game\'s 16 KB the last compile used, with a second bar for the maps the cartridge keeps in its bank window. The problems list under the editor shows every error and warning of the whole project, and a click goes to the line; the editor underlines an error about half a second after you stop typing. While the game runs, the frame meter shows how long a tick takes against the time FRAMERATE allows.' },
    ],
  },
];
