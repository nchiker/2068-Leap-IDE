/**
 * src/lang/arcade/arcade-words.js — Leap Arcade v0: the word tables (pure; no DOM, no CodeMirror).
 *
 * This is the single source for the words of the language. The tokenizer and parser read RESERVED and
 * BLOCK_WORDS, the checker reads the argument lists of the functions, and the later Help / autocomplete read the
 * descriptions. To add a word: add one line to WORD_LIST below (docs/ARCADE_LANGUAGE.md asks for four steps:
 * runtime spec entry, runtime routine + test, Help text = the `desc` here, changelog line). A word that needs new
 * syntax also needs a case in arcade-parse.js; a built-in function needs nothing else (its argument count and
 * types are checked from `args`).
 *
 * Entry: {name, cls, syntax, desc, args, min, ret, reserved}
 *   cls      'statement' (as in Leap V2), 'game' (new in Arcade), 'structure' (opens / closes a block or a
 *            declaration), 'function' (always written with brackets), 'operator'
 *   syntax   one line, as shown in Help
 *   args     functions only: [{name, type, optional}], type = 'num' | 'str' | 'key' | 'sprite' | 'sfx' | 'tileset' | 'map'
 *            ('sprite' etc. mean "the name of a declared asset", not an expression; M4a: a 'sprite' argument is an instance
 *            reference, `name` or `name(expr)` for a pool; 'key' (KEYDOWN) is a number 0..255 or a one-character string written out
 *            in the source and looked up when the game is built, checked by the checker itself)
 *   min      the number of required arguments
 *   ret      functions only: 'num' | 'str'
 *   reserved false for a contextual word (FRAME, FLIP, INIT): it is an ordinary name everywhere except where the
 *            grammar expects it, so `PROC FRAME()` works.
 *   callSyntax  optional: what the parser quotes when the word is used as a function without brackets (BAND is also a top-level
 *            statement in language batch 2, so its `syntax` shows both forms).
 *
 * Choices made where docs/ARCADE_LANGUAGE.md is silent (also listed in arcade-parse.js):
 *   - MOD and DIV are infix operators here (V2 has them as functions MOD(a,b) / DIV(a,b)); the call form is gone.
 *   - `/` is not a word: it is refused with a hint to use DIV (integers only).
 *   - (M3) PRINT is `PRINT [AT row, col;] item {; or , item}`; TAB is parsed but not supported by the compiler yet. AT is not
 *     a statement. Full semantics: docs/ARCADE_RUNTIME_API_V1.md "Language semantics" plus the notes in arcade-interp.js.
 *   - POINT(x,y) is kept from V2 (the language doc keeps it); INKEY$, CHR$, CODE, VAL, INT, ... are not in v0.
 *   - (M4a, runtime API v2, docs/ARCADE_RUNTIME_API_V2.md) arrays `DIM a(n)` (n 1..1000 with a v2 runtime), sprite pools
 *     `SPRITE name(n) = "asset"`, instance references `name` / `name(expr)` in SHOW, HIDE and HIT, and KEYDOWN("Q") / KEYDOWN(81).
 *     Decisions where the contract is silent: a bare pool name means instance 0; a single `SPRITE name = ...` accepts `name(0)`
 *     (and `name(i)` is bounds-checked against 1); KEYDOWN's code is folded at compile time, a one-character string is
 *     upper-cased (so "q" is Q); the code must be 0..255 and a number the runtime does not know as a key only gets a warning.
 *   - (language batch 1, docs/ARCADE_LANGUAGE_BATCH1.md) CONST, LOCAL, the bit functions BAND BOR BXOR BNOT SHL SHR, FILL FILLC COPY
 *     LOADMAP, 2-D arrays and array initialisers, RANDOMISE with no argument, several MAPs. CONST, LOCAL, FILL, FILLC, COPY, LOADMAP
 *     and the six bit functions are RESERVED now: a program that used one of them as a variable name must rename it. FILL was in
 *     NOT_IN_ARCADE; it is a real word now. Asset names (SPRITE, SFX, TILESET, MAP) live in their own namespaces, apart from variables,
 *     PROCs and DEF FNs (arcade-check.js).
 *   - (language batch 2, docs/ARCADE_PLATFORMER_CONTRACT.md sections 3b/4/7, docs/ARCADE_LANGUAGE_BATCH2.md) WINDOW, CAMERA, SETWORLD and the
 *     functions CAMX WORLDTILE TILEFLAGS TILEHIT SOLID are RESERVED; BAND was reserved by batch 1 as a bit function and is now also the top-level
 *     statement `BAND rows, num, den` (the position tells them apart: a statement starts a line, the function is always followed by a bracket).
 *     FLIP is contextual like FRAME (`SHOW s AT x, y FRAME f FLIP`), so a variable called `flip` keeps working.
 *   - (bankable per-level tables, docs/ARCADE_TABLES_CONTRACT.md) TABLE ENDTABLE LOADTABLE are RESERVED (a variable called `table` must be renamed); TABLE and LOADTABLE may still name an asset (BATCH11_WORDS).
 *   - (the banked cartridge map, docs/ARCADE_BANKING_CONTRACT.md section 4) WORLD: load another MAP as the world of the WINDOW / the plan of the VIEW3D; reserved for variables, a legal asset name (BATCH11_WORDS)
 *   - (language batch 3, docs/ARCADE_RAYCASTER_CONTRACT.md section 6, docs/ARCADE_LANGUAGE_BATCH3.md) VIEW3D VIEW SETWALL and the functions COSA SINA FXMUL WALL SEEN DEPTH
 *     are RESERVED (a variable called `wall` or `depth` must be renamed; BATCH3_WORDS below lists them: they may still NAME AN ASSET, since assets have their own name
 *     space, so `SFX wall = "wall"` and `PLAY wall` keep working). The clause words of VIEW3D (COLW CEIL FLOOR PATTERNS) are contextual like FRAME; its INK and BRIGHT clauses
 *     are the existing words.
 *   - (language batch 5, docs/ARCADE_LANGUAGE_BATCH5.md) TIMER KEYPRESS JOYPRESS are RESERVED (a variable called `timer` must be renamed). `TIMER a, b` declares variables the game counts
 *     down by itself (top level or directly in a SCENE, like DIM); KEYPRESS(c) / JOYPRESS(n) are the edge versions of KEYDOWN / STICK: 1 / the bits that went down in this tick. USING is
 *     contextual (`PRINT score USING "00000"`; an ordinary name elsewhere). PLAY takes an expression: a bare name of a declared SFX plays that effect, anything else is the effect's index.
 */

"use strict";

/** Limits shared by the lexer, parser and checker. */
export const LIMITS = Object.freeze({
  maxName: 31,        // identifier length (V2)
  maxString: 31,      // string literal length (V2)
  minInt: -32768,     // 16-bit signed integers only
  maxInt: 32767,
  maxLiteral: 65535,  // a positive literal may be written up to 65535 (addresses for POKE/PEEK/USR); 32768..65535 wrap to the signed 16-bit value
  maxDim: 16383,      // DIM a(n): n a literal 1 .. 16383 (V2); with a v2 runtime the checker is given maxDimV2 instead
  maxDimV2: 1000,     // M4a: DIM a(n) with n 1..1000, elements a(0)..a(n) are 16-bit slots in GAME_VARS
  maxSlots2D: 1000,   // batch 1: DIM b(w, h) has (w + 1) * (h + 1) slots, at most 1000
  maxParams: 4,       // batch 1: PROC name(a, b, c, d)
  maxTables: 256,     // bankable per-level tables (docs/ARCADE_TABLES_CONTRACT.md 2.1): TABLE declarations, all scopes together
  maxMaps: 64,        // batch 1: MAP declarations (the header's map table); 8 until the banked cartridge map (docs/ARCADE_BANKING_CONTRACT.md section 4), then 64
  maxPool: 16,        // M4a: SPRITE name(n): n 1..16 (the runtime has 16 instances in all)
  maxInstances: 16,   // M4a: instances (things on screen) in all
  maxAssets: 8,       // M4a: distinct sprite assets (pre-shifted tables)
  // M3 (runtime API v1): the 32 x 24 cell map, 128 tiles, 8 sound effects
  maxCol: 31,         // PRINT AT row, col / TILE x, y: x and col 0..31
  maxRow: 23,         // y and row 0..23
  maxTile: 127,       // tile index 0..127
  maxSfx: 8,          // SFX declarations
  maxPrintChar: 127,  // string literals printed with PRINT: character codes 32..127
  // language batch 2 (the scrolling window, docs/ARCADE_PLATFORMER_CONTRACT.md)
  winCols: 24,        // the window is 24 x 16 cells
  winRows: 16,
  maxWinCell: 8,      // WINDOW AT cx, cy: both 0..8 (24 + 8 = 32, 16 + 8 = 24)
  minWorldW: 24,      // the world map: 24..128 cells wide, 1..16 tall, tiles 0..31
  maxWorldW: 128,
  maxWorldH: 16,
  maxWorldTile: 31,
  maxBands: 4,
  maxFrames: 32,      // frames of a sprite asset after the mirrored copies of FLIP
  // language batch 3 (the 3D view, docs/ARCADE_RAYCASTER_CONTRACT.md)
  minViewMap: 4,      // the view's map: 4..32 cells on each side, wall types 0..4
  maxViewMap: 32,
  maxWallType: 4,
  viewPatterns: 16,   // PATTERNS b0 .. b15: the 8 wall patterns (even-row byte, odd-row byte)
});

/** FRAMERATE values: 60 / n must be a whole number of refreshes. */
export const VALID_FRAMERATES = Object.freeze([60, 30, 20, 15, 12, 10, 6, 5, 4, 3, 2, 1]);

/** Asset declarations: keyword -> the asset type name used in argument lists. */
export const ASSET_KINDS = Object.freeze({ SPRITE: 'sprite', SFX: 'sfx', TILESET: 'tileset', MAP: 'map' });

// ── The word list ─────────────────────────────────────────────────
function parseArgs(specs = []) {
  // 'x:num' or 'x:num?' (optional)
  return specs.map(s => {
    const [name, t] = s.split(':');
    const optional = t.endsWith('?');
    return { name, type: optional ? t.slice(0, -1) : t, optional };
  });
}

function W(name, cls, syntax, desc, extra = {}) {
  const args = parseArgs(extra.args);
  return Object.freeze({
    name, cls, syntax, desc,
    args,
    min: args.filter(a => !a.optional).length,
    ret: extra.ret ?? null,
    reserved: extra.reserved !== false,
    callSyntax: extra.callSyntax ?? null,
  });
}

const WORD_LIST = [
  // ── Game words (new in Arcade) ──
  W('GAME', 'game', 'GAME "title"', 'The game title. Once, at the top level.'),
  W('FRAMERATE', 'game', 'FRAMERATE n', 'Target updates per second: 60 / n must be a whole number of refreshes (60, 30, 20, 15, 12, 10, 6, 5, 4, 3, 2, 1). Once, at the top level.'),
  W('SPRITE', 'game', 'SPRITE name = "asset"  /  SPRITE name(n) = "asset"', 'Declare a sprite made in the Studio. SPRITE name(n) makes a pool of n instances (name(0)..name(n-1)) that share the art; at most 16 instances in all and 8 different assets (v2 runtime). Declaration order is draw order: a later instance appears on top. The asset may say "phases": 8 (default), 4, 2 or 1: fewer phases use less memory, and the x position is then drawn rounded down to a multiple of 2, 4 or 8.'),
  W('SFX', 'game', 'SFX name = "asset"', 'Declare a sound effect made in the Studio (up to 8; PLAY starts one by name).'),
  W('TILESET', 'game', 'TILESET name = "asset"', 'Declare the tile set made in the Studio (up to 128 tiles of 8 x 8 pixels; TILE needs one).'),
  W('MAP', 'game', 'MAP name = "asset"', 'Declare a tile map made in the Studio; it fills the top-left of the 32 x 24 screen cells when the game starts.'),
  W('SCENE', 'game', 'SCENE name ... ENDSCENE', 'A game part with its own PROC INIT and PROC FRAME. May hold DIM, DEF FN and PROC.'),
  W('ENDSCENE', 'structure', 'ENDSCENE', 'Ends a SCENE.'),
  W('ENTER', 'game', 'ENTER scene', 'Switch to another scene (its INIT runs, then its FRAME every tick).'),
  W('SHOW', 'game', 'SHOW sprite AT x, y [FRAME f] [FLIP]  /  SHOW pool(i) AT x, y', 'Place a sprite (or the instance i of a pool) at a pixel position (y from the top). FRAME f picks the animation frame (0 is the first frame of the sprite asset; without FRAME the instance keeps the frame it had, 0 at the start); FLIP draws the frame mirrored left to right. FRAME, FLIP, sprites wider or taller than 16 pixels, and a WINDOW need the v3 runtime. In a WINDOW game x and y are world pixels (x from the left of the world, y from the top of the window) and are not clamped; a sprite that is not wholly inside the window is not drawn. An instance number outside the pool is ignored.'),
  W('AT', 'structure', 'AT row, col  (after PRINT) / AT x, y  (after SHOW)', 'A position: character row and column after PRINT, pixels after SHOW.'),
  W('HIDE', 'game', 'HIDE sprite  /  HIDE pool(i)', 'Remove a sprite (or the instance i of a pool) from the screen. An instance number outside the pool is ignored.'),
  W('PLAY', 'game', 'PLAY sfx  /  PLAY index', 'Start a sound effect (it replaces the one playing): by its SFX name, or by a number, the effect\'s place in the SFX declarations (0 is the first). The number may be any expression and is checked when it runs: a value outside 0 .. number of effects - 1 does nothing. A bare name that is an SFX plays that effect; to use a variable that has the name of an effect, write PLAY (name).'),
  W('SILENCE', 'game', 'SILENCE', 'Stop the sound effect that is playing.'),
  W('WINDOW', 'game', 'WINDOW map [AT cx, cy]', 'Top level, once: use the declared MAP as a scrolling world shown in a window of 24 x 16 cells (192 x 128 pixels) at screen cell (cx, cy) (default 4, 4; both constants 0..8). The map is 24..128 cells wide and 1..16 tall and uses the tiles 0..31 of the TILESET (tile 0 should be blank: the sky). The cells of the screen outside the window stay yours (HUD text and tiles); cells inside it are repainted from the world every tick. SHOW uses world pixel coordinates. Needs the v3 runtime.'),
  W('CAMERA', 'game', 'CAMERA x', 'Set the camera: the world x (in pixels) at the left edge of the window. The value is clamped to 0..the largest value the world allows (the world width x 8 - 192, halved when a BAND scrolls at 2/1). CAMX() reads the clamped value. Needs a WINDOW.'),
  W('SETWORLD', 'game', 'SETWORLD x, y = t', 'Change one cell of the world: the cell that contains the world pixel (x, y) becomes tile t (0..31, a tile of the TILESET); a cell outside the world, or a tile outside the tileset, is ignored. The picture follows on the next tick. Collision words see the new tile at once. Needs a WINDOW.'),
  W('LOADMAP', 'game', 'LOADMAP map  /  LOADMAP map AT x, y', 'Copy the whole of a declared MAP (its w x h cells) onto the screen cells, at the top-left or at cell (x, y); the part that falls outside the 32 x 24 screen is clipped, cells outside the map are left alone. Each tile cell takes its tile\'s colours. A game may declare up to 64 maps; the first one is loaded when the game starts.'),
  W('WORLD', 'game', 'WORLD map', 'Load another MAP as the world of the WINDOW (runtime v3) or the floor plan of the VIEW3D (runtime v4), as if the WINDOW or VIEW3D had named it at the start: in a WINDOW game the world is replaced, the camera goes back to 0 and the whole window is redrawn (SETWORLD changes made before are lost; WORLD with the WINDOW\'s own map restarts a level); in a VIEW3D game the floor plan is replaced and the viewer stays where it is, moved into the new map if it is outside (the game normally follows with VIEW; SETWALL changes are lost). The map must be valid for a world (24..128 cells wide, at most 16 rows) or a plan (4..32 cells each way, the outer ring walls). A MAP named by WINDOW, VIEW3D or WORLD is a world or plan: it is stored once, not loaded at the start, and LOADMAP cannot use it. Needs a WINDOW or a VIEW3D.'),
  W('FILL', 'game', 'FILL x, y, w, h = t', 'Set the w x h screen cells from column x, row y to tile t (0..127 of the TILESET), each with the tile\'s colours. The rectangle is clipped to the 32 x 24 screen; a w or h of 0 or less does nothing. Much cheaper than a TILE loop.'),
  W('FILLC', 'game', 'FILLC x, y, w, h = c', 'Like FILL with the font character c (32..127) and the current text colours (INK, PAPER, BRIGHT). FILLC 0, 0, 32, 24 = 32 blanks the screen cells (CLS also resets the cursor).'),
  W('COPY', 'game', 'COPY x, y, w, h TO dx, dy', 'Copy the rectangle of screen cells (tile or character and colours) at column x, row y to column dx, row dy. Source and destination may overlap (as memmove: the result is as if the whole rectangle were read first); only cells whose source and destination are both on the screen are copied.'),
  W('TILE', 'game', 'TILE x, y = t', 'Set the screen cell at column x (0..31), row y (0..23) to tile t (0..127) of the TILESET; it takes the tile\'s colours. A cell outside the screen is ignored.'),

  W('VIEW3D', 'game', 'VIEW3D map [COLW 2|4] [INK 0..7] [CEIL 0..7] [FLOOR 0..7] [BRIGHT 0|1] [PATTERNS b0, ..., b15]', 'Top level, once: use the declared MAP as the floor plan of a first-person 3D view (a raycaster) in a window of 128 x 96 pixels (16 x 12 cells) in the middle of the screen. The MAP is 4..32 cells on each side; each cell is a wall type 0 (empty) .. 4, and the outer ring must not be empty. COLW is the width of a screen column in pixels, 4 (32 rays, the default) or 2 (64 rays, sharper and slower); INK is the colour of the walls, CEIL and FLOOR the paper above and below the horizon, BRIGHT 0 or 1 (defaults: INK 7, CEIL 0, FLOOR 1, BRIGHT 1). PATTERNS gives your own 8 wall patterns (16 bytes: for wall type t and side s the even-row byte then the odd-row byte at 2 x ((t - 1) x 2 + s)). The cells of the screen around the window stay yours (HUD text and tiles). A game with a VIEW3D cannot have a WINDOW. Needs the v4 runtime.'),
  W('VIEW', 'game', 'VIEW x, y, a', 'Set the viewer for the next picture: x and y are positions on the map in 8.8 fixed point (1/256 of a cell: the high byte is the cell), a is the angle 0..255 (256 to a turn; 0 looks east, 64 south, 128 west, 192 north; the value is taken AND 255). A position outside the map is moved to its nearest edge. Call it once a tick from PROC FRAME. Needs a VIEW3D.'),
  W('SETWALL', 'game', 'SETWALL x, y = t', 'Change one cell of the map of the VIEW3D: the cell that holds the 8.8 position (x, y) becomes wall type t (0 empty .. 4). A position outside the map, or a t other than 0..4, is ignored. WALL sees the new value at once and the next picture shows it. Needs a VIEW3D.'),
  W('COSA', 'function', 'COSA(a)', 'The cosine of the angle a (0..255, 256 to a turn; the value is taken AND 255) in 8.8 fixed point: -256 .. 256. Needs the v4 runtime.', { args: ['a:num'], ret: 'num' }),
  W('SINA', 'function', 'SINA(a)', 'The sine of the angle a (0..255, 256 to a turn; 64 gives 256) in 8.8 fixed point: -256 .. 256. Needs the v4 runtime.', { args: ['a:num'], ret: 'num' }),
  W('FXMUL', 'function', 'FXMUL(a, b)', 'a x b / 256 rounded down (the product is worked out exactly in 32 bits), the way 8.8 numbers multiply; the result wraps to 16 bits. Needs the v4 runtime.', { args: ['a:num', 'b:num'], ret: 'num' }),
  W('WALL', 'function', 'WALL(x, y)', 'The wall type 0..4 of the map cell that holds the 8.8 position (x, y); 1 for a position outside the map (negative, or beyond the 32 x 32 cells the runtime keeps). Needs a VIEW3D.', { args: ['x:num', 'y:num'], ret: 'num' }),
  W('SEEN', 'function', 'SEEN(s)', 'Where the sprite s (or an instance of a pool) was drawn in the 3D view by the last picture: the screen column 0..127 of its centre, or -1 when it was not drawn (hidden, behind a wall, behind the viewer or out of sight). The value is the previous tick\'s. Needs a VIEW3D.', { args: ['s:sprite'], ret: 'num' }),
  W('DEPTH', 'function', 'DEPTH(s)', 'How far from the viewer the sprite s (or an instance of a pool) was drawn in the 3D view by the last picture, in 8.8 fixed point (256 = one cell); 0 when it was not drawn. The value is the previous tick\'s. Needs a VIEW3D.', { args: ['s:sprite'], ret: 'num' }),

  // ── Structure ──
  W('CONST', 'structure', 'CONST name = expression', 'A named constant, worked out when the game is built. The expression may use numbers, other CONSTs, + - * DIV MOD, unary minus, brackets and the bit functions (BAND BOR BXOR BNOT SHL SHR). At the top level or directly inside a SCENE. A CONST can be used wherever a number can, in a DIM size, a CASE value or an array initialiser too; it cannot be assigned to.'),
  W('LOCAL', 'structure', 'LOCAL a, b, c', 'Declare variables that belong to the PROC they are in (the first lines of the PROC, or anywhere at its top level). A local hides a global of the same name and starts at 0 on every call. Locals take fixed memory slots, so a PROC still cannot call itself. FOR i = ... inside a PROC makes i a local of that PROC when no variable i exists.'),
  W('PROC', 'structure', 'PROC name(a, b, c, d): ... ENDP', 'A procedure with 0 to 4 by-value parameters. CALL name(x, y) evaluates the arguments from left to right. PROC INIT() and PROC FRAME() are the scene entry points and take none.'),
  W('ENDP', 'structure', 'ENDP', 'Ends a PROC.'),
  W('CALL', 'structure', 'CALL name(expr, ...)', 'Call a procedure, giving one expression for each of its parameters.'),
  W('DEF', 'structure', 'DEF FN f(x) = expr', 'Define a numeric function of one parameter; use it as FN f(expr).'),
  W('FN', 'structure', 'FN f(expr)', 'Call a function made with DEF FN.'),
  W('TIMER', 'game', 'TIMER a, b, c', 'Declare timers: ordinary number variables (read them, assign them, compare them) that the game also counts down by itself. At the start of every tick, before PROC FRAME runs, every timer greater than 0 goes down by 1; 0 or less is left alone. So after cooldown = 30 in one tick, cooldown reads 29 in the next FRAME and 0 from 30 ticks on: IF cooldown = 0 THEN means it has run out. A timer at the top level counts in every scene and keeps its value across ENTER; a timer inside a SCENE belongs to that scene (it starts at 0 at every entry and counts only while that scene runs). PROC INIT never counts a timer down. Top level or directly inside a SCENE, like DIM; numbers only (no $ name, no array). Needs a v2 runtime.'),
  W('TABLE', 'structure', 'TABLE name ... ENDTABLE  (rows: target = value, value, ...)', 'Declare a table of level data: a block of rows, one per target. A target is a number variable or an array declared in the same scope (the game level, or the SCENE the table is in; a game-level table sees game-level names only); the values are constant expressions (CONSTs allowed). An array row lists 1 to all of its elements in DIM order (a 2-D array row by row) and LOADTABLE sets every element past the last one listed to 0; a variable row has exactly one value. A target appears once, a table has at least one row. Top level or directly inside a SCENE, like DIM; at most 256 tables. A table name is its own name: it cannot be used for a variable, constant, PROC, DEF FN, asset or scene. Needs a v2 runtime. The compiler keeps tables out of the code when the game is short of room (the banked cartridge map).'),
  W('ENDTABLE', 'structure', 'ENDTABLE', 'Ends a TABLE.'),
  W('LOADTABLE', 'game', 'LOADTABLE name  /  LOADTABLE index', 'Copy every row of a TABLE into its target: an array row sets the listed elements and zeroes the rest of the array, a variable row sets the variable; variables and arrays the table does not name keep their values. Nothing else changes (no sprite, screen, sound or scene). ENTER does not load a table: a game loads its level\'s table where it starts the level. By name, or by number: the table\'s place in the list this statement can see (the game-level tables in source order, then, inside a SCENE, that scene\'s tables), counting from 0. The number may be any expression and is checked when it runs: a value outside the list does nothing; a constant outside the list is a warning. A bare name that is a table loads that table. Needs a v2 runtime.'),
  W('DIM', 'statement', 'DIM a, b, c(n), d(w, h), e(n) = v0, v1, ...', 'Declare variables (every variable must be declared) and arrays. At the top level a DIM is global; inside a SCENE it belongs to the scene. An array c(n) has the elements c(0)..c(n) (16 bit, all 0 at the start); with a v2 runtime n is 1..1000. d(w, h) is a two-dimensional array of (w + 1) * (h + 1) elements, at most 1000, stored row by row (d(i, j) follows d(i, j - 1)). Sizes are constant expressions (numbers or CONSTs). "= v0, v1, ..." gives the first elements their values (constant expressions, at most one per element; the rest stay 0); the values are kept in the game and copied in when it starts. An index outside its range reads 0 and a write to it is ignored.'),
  W('IF', 'structure', 'IF cond THEN ... [ELSE ...] ENDIF', 'A block; there is no one-line form.'),
  W('THEN', 'structure', 'IF cond THEN', 'Part of IF.'),
  W('ELSE', 'structure', 'ELSE', 'Part of IF (and CASE ELSE).'),
  W('ENDIF', 'structure', 'ENDIF', 'Ends an IF.'),
  W('FOR', 'structure', 'FOR v = a TO b [STEP s] ... NEXT [v]', 'Counting loop.'),
  W('TO', 'structure', 'FOR v = a TO b / LINE x0, y0 TO x1, y1', 'Part of FOR and LINE.'),
  W('STEP', 'structure', 'STEP s', 'Part of FOR.'),
  W('NEXT', 'structure', 'NEXT [v]', 'Ends a FOR.'),
  W('EXIT', 'statement', 'EXIT FOR / EXIT WHILE', 'Leave the innermost FOR (or WHILE) loop.'),
  W('WHILE', 'structure', 'WHILE cond ... WEND', 'Loop while the condition is true.'),
  W('WEND', 'structure', 'WEND', 'Ends a WHILE.'),
  W('SELECT', 'structure', 'SELECT CASE n ... CASE v[, v] ... [CASE ELSE ...] ENDSEL', 'Choose by value; no fall-through.'),
  W('CASE', 'structure', 'CASE v[, v] / CASE ELSE', 'A branch of SELECT.'),
  W('ENDSEL', 'structure', 'ENDSEL', 'Ends a SELECT.'),
  W('END', 'statement', 'END', 'End the program.'),
  W('REM', 'statement', 'REM text', 'A comment to the end of the line (an apostrophe is not a comment).'),

  // ── Statements kept from V2 ──
  W('PRINT', 'statement', 'PRINT [AT row, col;] item [USING "pattern"] {; or , item [USING "pattern"]} [; or ,]', 'Print text (string literals, STR$(n)) and numbers (decimal, a leading - when negative, no padding unless the number has USING) at the cursor in the current INK, PAPER and BRIGHT. A number may be followed by USING and a pattern of # and 0, 1 to 8 characters, written out: the field is as wide as the pattern, padded on the left with spaces (#) or zeros (from the first 0 on), and prints asterisks when the number does not fit (PRINT 7 USING "0000" gives 0007, -5 USING "####" gives   -5, 12345 USING "0000" gives ****). AT row, col (0..23, 0..31) first moves the cursor. A comma prints one space. Without a trailing ; or , the cursor then moves to the start of the next row. Text wraps at column 32; the row after 23 is row 0 (no scrolling). TAB is not available yet.'),
  W('TAB', 'structure', 'TAB col', 'Move the PRINT position to a column (after PRINT).'),
  W('CLS', 'statement', 'CLS', 'Clear every screen cell to a space on the current PAPER (ink 0) and put the cursor at row 0, column 0. Tiles go too; sprites stay.'),
  W('INK', 'statement', 'INK n', 'Ink colour 0..7 for the text printed after it (the value is taken AND 7).'),
  W('PAPER', 'statement', 'PAPER n', 'Paper colour 0..7 for the text printed after it (the value is taken AND 7).'),
  W('BRIGHT', 'statement', 'BRIGHT n', 'Bright 0 or 1 for the text printed after it (the value is taken AND 1).'),
  W('FLASH', 'statement', 'FLASH n', 'Flash 0 or 1.'),
  W('BORDER', 'statement', 'BORDER n', 'Border colour 0..7 (the value is taken AND 7). Needs a v2 runtime.'),
  W('PLOT', 'statement', 'PLOT x, y', 'Set a pixel (y from the top).'),
  W('LINE', 'statement', 'LINE x0, y0 TO x1, y1', 'Draw a line.'),
  W('POKE', 'statement', 'POKE addr, value', 'Write a byte.'),
  W('OUT', 'statement', 'OUT port, value', 'Write to a port.'),
  W('RANDOMISE', 'statement', 'RANDOMISE  /  RANDOMISE n', 'Seed RND: RANDOMISE n starts the sequence at n (0 is taken as 1, so the same n always gives the same numbers); RANDOMISE alone seeds it from the frame counter, so it differs from run to run when called after the player has waited, e.g. on the title screen. Needs a v2 runtime.'),

  // ── Operators ──
  W('AND', 'operator', 'a AND b', 'Logical and, giving 0 or 1 (not bitwise; use BIT for bit tests).'),
  W('OR', 'operator', 'a OR b', 'Logical or, giving 0 or 1.'),
  W('NOT', 'operator', 'NOT a', 'Logical not, giving 0 or 1. Binds looser than the comparisons.'),
  W('MOD', 'operator', 'a MOD b', 'Remainder. An infix operator in Arcade (a function in V2).'),
  W('DIV', 'operator', 'a DIV b', 'Integer division. An infix operator in Arcade (a function in V2).'),

  // ── Functions (always written with brackets) ──
  W('HIT', 'function', 'HIT(a, b)', '1 if both sprites (names, or pool(i) instances) are shown and their collision boxes (the sprite\'s hot box, else its whole size) overlap, else 0. Boxes that only touch do not overlap. An instance number outside its pool gives 0.', { args: ['a:sprite', 'b:sprite'], ret: 'num' }),
  W('BAND', 'function', 'BAND(a, b)  /  BAND rows, num, den  (a window band, top level)', 'BAND(a, b): the bits set in both a and b (16 bit). AND is logical (0 or 1); BAND is bitwise. As a statement at the top level, BAND rows, num, den declares one scrolling band of a WINDOW (1 to 4 of them, in order from the top of the window): the band is `rows` cell rows tall (the rows of all BANDs add up to 16) and scrolls at num/den of the camera speed: 0/1 (fixed), 1/4, 1/2, 1/1 or 2/1. Band k shows the rows of the world map that follow the rows of the bands above it. Without BAND the window is one band of 16 rows at 1/1.', { args: ['a:num', 'b:num'], ret: 'num', callSyntax: 'BAND(a, b)' }),
  W('BOR', 'function', 'BOR(a, b)', 'The bits set in a or b (16 bit). OR is logical (0 or 1); BOR is bitwise.', { args: ['a:num', 'b:num'], ret: 'num' }),
  W('BXOR', 'function', 'BXOR(a, b)', 'The bits set in exactly one of a and b (16 bit).', { args: ['a:num', 'b:num'], ret: 'num' }),
  W('BNOT', 'function', 'BNOT(a)', 'Every bit of a flipped (16 bit): BNOT(0) is -1. NOT is logical (0 or 1); BNOT is bitwise.', { args: ['a:num'], ret: 'num' }),
  W('SHL', 'function', 'SHL(a, n)', 'a shifted left by n bits (16 bit); 0 when n is outside 0..15. A constant n is a few inline instructions; a run-time n costs about 50 + 24 x n T-states.', { args: ['a:num', 'n:num'], ret: 'num' }),
  W('SHR', 'function', 'SHR(a, n)', 'a shifted right by n bits, keeping the sign (arithmetic shift): SHR(-8, 1) is -4. When n is outside 0..15 the result is 0 for a non-negative a and -1 for a negative one. A run-time n costs about 50 + 29 x n T-states.', { args: ['a:num', 'n:num'], ret: 'num' }),
  W('CAMX', 'function', 'CAMX()', 'The camera in world pixels, as clamped by CAMERA (0 at the start). Needs a WINDOW.', { args: [], ret: 'num' }),
  W('WORLDTILE', 'function', 'WORLDTILE(x, y)', 'The tile (0..31) of the world cell that contains the world pixel (x, y), x from the left of the world, y from the top of the window; 0 outside the world. Needs a WINDOW.', { args: ['x:num', 'y:num'], ret: 'num' }),
  W('TILEFLAGS', 'function', 'TILEFLAGS(x, y)', 'The flags byte (bit 0 solid, 1 hazard, 2 pickup, 3 ladder / one-way, 4..7 yours; set per tile in the tileset) of the world cell at the world pixel (x, y). Outside the world it is 1 (solid) on the left, the right and above, and 0 below. Needs a WINDOW.', { args: ['x:num', 'y:num'], ret: 'num' }),
  W('TILEHIT', 'function', 'TILEHIT(x, y, w, h, mask)', 'The flags of every world cell the rectangle x..x+w-1, y..y+h-1 touches, ANDed with mask, ORed together: 0 when nothing in the rectangle has a flag of the mask (a w or h of 0 or less touches nothing). Cells outside the world count as in TILEFLAGS. Needs a WINDOW.', { args: ['x:num', 'y:num', 'w:num', 'h:num', 'mask:num'], ret: 'num' }),
  W('SOLID', 'function', 'SOLID(x, y, w, h)', 'TILEHIT(x, y, w, h, 1): 1 when any cell the rectangle touches is solid (flag bit 0), else 0. Needs a WINDOW.', { args: ['x:num', 'y:num', 'w:num', 'h:num'], ret: 'num' }),
  W('BIT', 'function', 'BIT(v, n)', '1 if bit n (0..15) of v is set, else 0.', { args: ['v:num', 'n:num'], ret: 'num' }),
  W('STICK', 'function', 'STICK(n)', 'Joystick 1 or 2 as bits 0..4 (directions, fire = 16).', { args: ['n:num'], ret: 'num' }),
  W('KEYDOWN', 'function', 'KEYDOWN("Q")  /  KEYDOWN(code)', '1 while that key is held, else 0. The key is a one-character string or an ASCII code written as a number (not an expression): A-Z (upper case), 0-9, space (32), enter (13); 1 is CAPS SHIFT and 2 is SYMBOL SHIFT. It is looked up when the game is built. Needs a v2 runtime.', { args: ['code:key'], ret: 'num' }),
  W('KEYPRESS', 'function', 'KEYPRESS("Q")  /  KEYPRESS(code)', '1 during the tick in which that key went down (it is held now and was not held at the previous tick), else 0; the same value everywhere in a tick, however often it is read. The key is written as for KEYDOWN. A key already held when the game starts counts as a press in the first tick. ENTER does not change it: a key held through a scene change is not a new press. Needs a v2 runtime.', { args: ['code:key'], ret: 'num' }),
  W('JOYPRESS', 'function', 'JOYPRESS(1)  /  JOYPRESS(2)', 'The STICK bits that went down in this tick (STICK(n) AND NOT the previous tick\'s value, 0..31): BIT(JOYPRESS(1), 4) is a fresh fire press. The joystick number must be written out: 1 or 2. Same timing as KEYPRESS. Needs a v2 runtime.', { args: ['n:num'], ret: 'num' }),
  W('TILEAT', 'function', 'TILEAT(x, y)', 'The tile index (0..127) shown in the screen cell at column x, row y, or -1 when the cell holds text or is outside the screen.', { args: ['x:num', 'y:num'], ret: 'num' }),
  W('STR$', 'function', 'STR$(n)', 'A number as text; in M3 only as a PRINT item (or joined to other text with +).', { args: ['n:num'], ret: 'str' }),
  W('LEN', 'function', 'LEN(s$)', 'The length of a string.', { args: ['s:str'], ret: 'num' }),
  W('ABS', 'function', 'ABS(n)', 'Absolute value.', { args: ['n:num'], ret: 'num' }),
  W('SGN', 'function', 'SGN(n)', '-1, 0 or 1.', { args: ['n:num'], ret: 'num' }),
  W('RND', 'function', 'RND(n)', 'A random whole number 0 .. n-1.', { args: ['n:num'], ret: 'num' }),
  W('PEEK', 'function', 'PEEK(addr)', 'Read a byte.', { args: ['addr:num'], ret: 'num' }),
  W('IN', 'function', 'IN(port)', 'Read a port.', { args: ['port:num'], ret: 'num' }),
  W('USR', 'function', 'USR(addr)', 'Call machine code; the result is HL.', { args: ['addr:num'], ret: 'num' }),
  W('POINT', 'function', 'POINT(x, y)', '1 if the pixel is set, else 0.', { args: ['x:num', 'y:num'], ret: 'num' }),

  // ── Contextual words (not reserved) ──
  W('FRAME', 'game', 'SHOW s AT x, y FRAME f   /   PROC FRAME()', 'Animation frame clause of SHOW; also the name of the per-tick scene procedure.', { reserved: false }),
  W('FLIP', 'game', 'SHOW s AT x, y [FRAME f] FLIP', 'Draw the frame mirrored left to right. The compiler adds a mirrored copy of every frame of the sprite asset (so the asset may have at most 16 frames); the collision box of the asset is not mirrored.', { reserved: false }),
  W('COLW', 'game', 'VIEW3D map COLW 2|4', 'Column width of a VIEW3D in pixels: 4 (32 rays, the default) or 2 (64 rays: sharper, about 1.7 times the cost).', { reserved: false }),
  W('CEIL', 'game', 'VIEW3D map CEIL 0..7', 'The paper colour above the horizon of a VIEW3D (default 0, black).', { reserved: false }),
  W('FLOOR', 'game', 'VIEW3D map FLOOR 0..7', 'The paper colour below the horizon of a VIEW3D (default 1, blue).', { reserved: false }),
  W('PATTERNS', 'game', 'VIEW3D map PATTERNS b0, b1, ..., b15', 'Your own wall patterns for a VIEW3D: 16 constant bytes, for the pattern index (type - 1) x 2 + side the even-row byte at 2 x index and the odd-row byte after it (side 0 is a wall facing east or west, 1 one facing north or south). Without it the runtime\'s patterns are used.', { reserved: false }),
  W('USING', 'game', 'PRINT n USING "0000"', 'Number format clause of PRINT: a pattern of # and 0 written out, 1 to 8 characters, is the width of the field; # pads with spaces, 0 (and everything to its right) with zeros; a number that does not fit prints asterisks.', { reserved: false }),
  W('INIT', 'game', 'PROC INIT()', 'The scene procedure that runs once when the scene starts.', { reserved: false }),
];

/** upper-case word -> entry, for every word including the contextual ones. */
export const ARCADE_WORDS = new Map(WORD_LIST.map(e => [e.name, e]));

/** Words that tokenize as keywords (cannot be names). */
export const RESERVED = new Set(WORD_LIST.filter(e => e.reserved).map(e => e.name));

/** Built-in functions: upper-case name -> entry. */
export const FUNCTIONS = new Map(WORD_LIST.filter(e => e.cls === 'function').map(e => [e.name, e]));

/** Words that open or close a block; see arcade-parse.js for how they recover. */
export const BLOCK_WORDS = new Set(['ELSE', 'ENDIF', 'NEXT', 'WEND', 'CASE', 'ENDSEL', 'ENDP', 'ENDSCENE', 'ENDTABLE', 'PROC', 'SCENE']);

/**
 * The words language batch 3 reserved. A variable, PROC or DEF FN cannot have one of these names, but an ASSET may (SFX wall = "wall", PLAY wall): assets live in their own
 * name space, and the first project that used one of them (breakout.arc) named a sound `wall`. arcade-parse.js reads them as names in asset declarations and references.
 */
export const BATCH3_WORDS = Object.freeze(new Set(['VIEW3D', 'VIEW', 'SETWALL', 'COSA', 'SINA', 'FXMUL', 'WALL', 'SEEN', 'DEPTH']));

/** Words of the banked cartridge map (docs/ARCADE_BANKING_CONTRACT.md section 4): reserved like batch 3's, and like them they may still NAME AN ASSET (`MAP world = "w"`). */
export const BATCH11_WORDS = Object.freeze(new Set(['WORLD', 'TABLE', 'LOADTABLE']));      // (TABLE and LOADTABLE: bankable per-level tables, docs/ARCADE_TABLES_CONTRACT.md; a project that named an asset `table` keeps building)

/** Entry for a word (any case), or null. */
export function wordEntry(word) {
  return ARCADE_WORDS.get(String(word).toUpperCase()) ?? null;
}

/** Words of one class, in table order (autocomplete / Help groups). */
export function wordsOfClass(cls) {
  return WORD_LIST.filter(e => e.cls === cls);
}

/**
 * Familiar words that Arcade does not have, with the advice shown when one is used as a statement or a name.
 * They are ordinary names for the tokenizer (V2 does not reserve them either), so `let = 1` still lexes.
 */
export const NOT_IN_ARCADE = new Map(Object.entries({
  LET: 'assign with  x = 1  (no LET)',
  GOTO: 'there is no GOTO and no labels: use WHILE/WEND, EXIT, SELECT or scenes',
  GOSUB: 'there is no GOSUB: use PROC and CALL',
  RETURN: 'there is no RETURN: a PROC ends at ENDP',
  INPUT: 'there is no INPUT: read STICK or KEYDOWN',
  STOP: 'there is no STOP: use END',
  CLEAR: 'there is no CLEAR',
  FREE: 'there is no FREE',
  DATA: 'there is no DATA/READ/RESTORE',
  READ: 'there is no DATA/READ/RESTORE',
  RESTORE: 'there is no DATA/READ/RESTORE',
  LIST: 'editor and tape commands are not part of a game',
  NEW: 'editor and tape commands are not part of a game',
  RUN: 'editor and tape commands are not part of a game',
  LOAD: 'editor and tape commands are not part of a game',
  SAVE: 'editor and tape commands are not part of a game',
  VERIFY: 'editor and tape commands are not part of a game',
  LPRINT: 'there are no printer words',
  LLIST: 'there are no printer words',
  PALETTE: 'there is no PALETTE: the build chooses the display setup per scene',
  ULAPLUS: 'there is no ULAPLUS: the build chooses the display setup per scene',
  MODE: 'there is no MODE: the build chooses the display setup per scene',
  DRAW: 'there is no DRAW: use LINE',
  CIRCLE: 'not in v0',
  BEEP: 'sound is PLAY with a SFX asset',
  SOUND: 'sound is PLAY with a SFX asset',
  PAUSE: 'the runtime owns the loop: use FRAMERATE',
  ELSEIF: 'there is no ELSEIF: nest an IF, or use SELECT CASE',
  CONTINUE: 'there is no CONTINUE',
  RANDOMIZE: 'spell it RANDOMISE',
  INKEY$: 'not in v0: use KEYDOWN(code) or STICK(n)',
  CHR$: 'not in v0 (string words are later)',
  CODE: 'not in v0 (string words are later)',
  VAL: 'not in v0 (string words are later)',
  LEFT$: 'not in v0 (string words are later)',
  RIGHT$: 'not in v0 (string words are later)',
  MID$: 'not in v0 (string words are later)',
  UPPER$: 'not in v0 (string words are later)',
  LOWER$: 'not in v0 (string words are later)',
  INT: 'integers only: there is no INT',
  SQR: 'floating point is not in v0',
  SIN: 'floating point is not in v0',
  COS: 'floating point is not in v0',
  TAN: 'floating point is not in v0',
  PI: 'floating point is not in v0',
  ATTR: 'not in v0',
  INVERSE: 'not in v0',
  OVER: 'not in v0',
}));

/** "X is not in Arcade: advice" for a familiar word the language lacks, or null. */
export function notInArcadeMessage(word) {
  const h = NOT_IN_ARCADE.get(String(word).toUpperCase());
  if (!h) return null;
  return h.startsWith('not in v0') ? `${word} is ${h}` : `${word} is not in Arcade: ${h}`;
}
