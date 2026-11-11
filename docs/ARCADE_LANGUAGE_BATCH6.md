# Leap Arcade: language batch 6 (`WORLD ... OF`), and Leap Runner's pause and high score (2026-11-11)

Binding for the compiler (`src/lang/arcade/`), the editor and the tests. Owner decision (2026-11-11): after the bankable tables, three small
Leap Runner improvements: a **pause key**, a **high score**, and **`WORLD` by number** so that a level costs data only (one banked world and one
bankable table) and no code. The first two are game code (Part B); the third is a language change (Part A). No runtime change: programs that
do not use the new form compile to the same bytes. Style as `ARCADE_LANGUAGE_BATCH5.md` and `ARCADE_TABLES_CONTRACT.md`.

## Part A: `WORLD expr OF name, name, ...`

```
WORLD name                     as before (ARCADE_BANKING_CONTRACT.md section 4)
WORLD expr OF m0, m1, ..., mk  load the world (v3) / floor plan (v4) m<expr>; an index outside 0..k does nothing
```
Why a list and not a bare index (as `LOADTABLE lv`): a program may also have screen MAPs (Vaults' HUD), so the compiler cannot number "the
worlds" by itself; the list says which MAPs are worlds and in which order. Leap Runner: `WORLD lv OF level, level2, level3, level4` replaces its
four-way `SELECT CASE`.

1. **Parsing.** After `WORLD`, a bare unparenthesised name **not followed by `OF`** is the existing form (node `World {map: Ident}`, unchanged).
   Otherwise an expression, then `OF` and 1 to 64 MAP names separated by commas: node `World {map: null, index: expr, maps: [Ident]}`. `OF`
   is **contextual** (recognised only in this place; it is not a reserved word, so a variable called `of` stays legal). `WORLD expr` with no
   `OF` is an error: "WORLD by number needs OF and the list of maps: WORLD n OF a, b, c".
2. **Checks.** Every listed name is a MAP and becomes a world exactly as if `WORLD name` had named it (the same map checks and messages with the
   prefix `WORLD: `; not in the map table, `LOADMAP` of it an error). The same name may appear more than once. A game with neither `WINDOW` nor
   `VIEW3D`: the same error as `WORLD name`. A constant index outside the list: a **warning**, and the statement compiles to nothing. More than
   64 names: an error.
3. **Meaning.** The index is evaluated as a signed 16-bit value; below 0 or past the last name nothing happens (no camera change, no redraw),
   as `PLAY expr` and `LOADTABLE expr`. Otherwise exactly `WORLD m<index>`.
4. **Code.** A constant index in range compiles to the code of `WORLD name` (same bytes). Otherwise: the index to HL, `LD DE,list / LD BC,count
   / CALL lib$worldidx`. `list` is a table in the mapped code, one entry per listed name: v3 `DW src, DB world_w, DW cam_max` (5 bytes), v4
   `DW src, DB map_w, DB map_h` (4 bytes); `src` is a fixup like the `WORLD name` operand (mapped or banked stream). `lib$worldidx` (present only
   when used): unsigned compare of HL with BC (a negative index fails too) and return, else HL = DE + index x entry size, load the entry into the
   registers of `RT_WORLDLOAD` (HL, A, DE) or `RT_PLANLOAD` (HL, BC) and JP to it. A list identical to another one in the same program may be
   shared (not required). A header comment block "Batch 6" (as B5-1 .. B5-4) records the decisions.
5. **Interpreter** (`arcade-interp.js`): the same meaning, so the differential tests compare it with the compiled game.
6. **Editor:** `OF` is not highlighted as a keyword (contextual); completion after `OF` offers the MAP names; the listed names count as uses for
   go to definition and rename.

## Part B: Leap Runner, pause and high score (game code in `arcade/examples/runner.arc`)

* **Pause:** key **H** (and nothing on the joystick: fire is jump) toggles pause while playing (state 1) only. Paused: the game's logic does not
  run (no movement, no timers advance, no collision queries), the sound is silenced once, and `PAUSED` is shown in the HUD's message row
  (row 21, where "LEVEL n" goes); unpausing clears it. Sprites and the camera stay where they are. Use `KEYPRESS` (edge) so one press is one toggle.
  Hold the cost of the paused tick near the idle tick (no text printed every tick).
* **High score:** a game-level variable `HI` (not cleared by a new game; 0 at power-on) updated when a game ends (win or game over: `HI =
  score` when higher); the title shows `HI n` in the HUD. The score stays the 16-bit value it is (32-bit scores are gap item 11; Leap Runner's
  scores are about 4,500 a game).
* **`WORLD lv OF level, level2, level3, level4`** in `LOADLEVEL` (Part A).
* The recorded play-through (`node tests/arcade-runner.mjs --record`) never presses H, so the play itself is unchanged; the tests add a pause
  case (press H mid-level: the state and both display files stay identical for the paused ticks, except the `PAUSED` text; press H again and the
  game continues exactly as an unpaused run shifted by the paused ticks) and a high-score case (two games in one session: `HI` keeps the
  higher score and the title shows it). Interpreter and TSRun tick by tick, as the existing runner tests; cross-emulator check repeated
  (`arcade/tools/xemu/runner-*`).

## Tests (Part A)

`tests/arcade-m13-compiler.mjs` and `tests/arcade-m13-differential.mjs` (in `arcade/tests/run-all.mjs`), modelled on the m12 files: parser
(both forms, `OF` contextual, a variable named `of`, the missing-`OF` error), checker (non-MAP name, map checks through the list, no
WINDOW / VIEW3D, more than 64 names, constant index out of range warning), code (constant index = the `WORLD name` bytes; the list entry
bytes for v3 and v4; mapped and banked streams through the fixups), the differential on the real v3 and v4 runtimes (index in range,
negative, past the end; normal and `bankAll`), and byte identity of every program without the new form against the previous compiler
(`ARCADE_OLD=<git archive of the previous src>/src/lang/arcade`, as m11 / m12).
