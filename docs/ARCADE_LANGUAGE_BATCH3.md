# Leap Arcade language batch 3: the 3D view (2026-11-10)

The language half of the raycaster slice. The binding contract is `docs/ARCADE_RAYCASTER_CONTRACT.md` (sections 2, 3, 6); this file records what the compiler and the reference interpreter do where that contract is
silent, and what the runtime engineer must match. Code: `src/lang/arcade/` (`arcade-words.js`, `arcade-parse.js`, `arcade-check.js`, `arcade-codegen.js`, `arcade-link.js`, `arcade-interp.js`, the new `arcade-view.js`,
`arcade-compile.js`). Tests: `tests/arcade-m8-compiler.mjs` (281 checks, no real runtime needed), `tests/arcade-m8-differential.mjs` (the same comparison on the real v4 runtime; skips until
`arcade/build/v4/runtime.json` has the routines), helpers `tests/arcade-m8-common.mjs` and `tests/arcade-m8-mock.mjs` (a mock v4 runtime: JavaScript traps for the new routines, written from the contract and from
the image the linker wrote). Programs that use none of the new words compile to the same bytes as before (`arcade/tests/fixtures/batch3-baseline.json`: the five older games on v2 and v3, and `platformer.arc` on v3).

## The words

```
VIEW3D level [COLW 2|4] [INK 0..7] [CEIL 0..7] [FLOOR 0..7] [BRIGHT 0|1] [PATTERNS b0, b1, ..., b15]     top level, once
VIEW x, y, a            statement: the viewer (x, y 8.8; a 0..255, taken AND 255)
SETWALL x, y = t        statement: the cell holding the 8.8 position becomes wall type t (0..4)
COSA(a)  SINA(a)  FXMUL(a, b)  WALL(x, y)  SEEN(s)  DEPTH(s)
SHOW s AT x, y [FRAME f] [FLIP]       in ray mode x, y are 8.8 world coordinates
```
**Reserved words:** `VIEW3D VIEW SETWALL COSA SINA FXMUL WALL SEEN DEPTH` (a variable, PROC or DEF FN called `wall`, `depth`, `seen` or `view` must be renamed). **Contextual** (still ordinary names elsewhere, like `FRAME`
and `FLIP`): `COLW CEIL FLOOR PATTERNS`; the clauses `INK` and `BRIGHT` are the existing words. **Assets may use the batch 3 words** (`BATCH3_WORDS` in `arcade-words.js`): `SFX wall = "wall"`, `PLAY wall`,
`SPRITE depth = ...`, `SHOW depth AT ...`, `HIT(depth, x)`, `SEEN(depth)` work because assets have a name space of their own and `breakout.arc` already calls a sound `wall`. The one exception: an asset called like a
FUNCTION word cannot be indexed as a pool inside an expression (`seen(1)` there is the function SEEN); name such a pool differently (`SHOW seen(1) AT ...` as a statement does work).

## Decisions where the contract is silent

**Syntax and checks**
1. `VIEW3D` stands anywhere at the top level (like `WINDOW`); its clauses come in any order, each at most once (a repeat is an error at the repeated word). The clause values are **constant expressions** (literals,
   CONSTs, `+ - * DIV MOD`, the bit functions). `COLW` must be 2 or 4, `INK` `CEIL` `FLOOR` 0..7, `BRIGHT` 0 or 1; each error names the clause and the allowed values.
2. **Defaults** (the contract's): `COLW 4`, `INK 7`, `CEIL 0` (black), `FLOOR 1` (blue), `BRIGHT 1`. `attr_top = BRIGHT << 6 | CEIL << 3 | INK`, `attr_bottom = BRIGHT << 6 | FLOOR << 3 | INK` (flash 0): the defaults
   give `$47` and `$4F`. The compiler does not "choose better ones".
3. **`PATTERNS`** (optional, added here): 16 constant bytes `b0 ... b15`; pattern index `pi = (type - 1) * 2 + side`, the even-row byte at `2 * pi`, the odd-row byte at `2 * pi + 1`, side 0 = a wall facing east or west
   (the ray hit an x-facing wall), 1 = north or south. The 16 bytes are written between `map_src` and `view_desc` and `view_desc +7` points at them; without the clause `+7` is 0 (the runtime's default `PAT`).
   Not 16 values, or a value outside 0..255, is an error.
4. The MAP a `VIEW3D` names is the **floor plan**: it is not in the map table, not loaded into the cell map, and `LOADMAP` of it is an error. Any other MAP (the HUD) works as before, with the extended header (the map table
   at +16, zero when there is none). A `TILESET` is not needed for a VIEW3D (only for the cell-map words).
5. **The window words in a VIEW3D program are one message.** `WINDOW`, `BAND`, `CAMERA`, `SETWORLD`, `CAMX`, `WORLDTILE`, `TILEFLAGS`, `TILEHIT`, `SOLID` in a program with a `VIEW3D` give **one** error, at the first of them
   in source order: "X cannot be used in a program with a VIEW3D (line N): the scrolling-window words need the v3 runtime, the 3D view the v4 runtime, and no runtime has both". The same one message appears for a window word
   on a runtime of version 4 or more without a VIEW3D (the v4 runtime has no scroll engine): "X needs the v3 runtime (the v4 runtime has the 3D view in place of the scrolling window): build with --runtime v3".
   `FLIP` is fine in a VIEW3D program (it is a v3 feature that v4 keeps).
6. `VIEW`, `WALL`, `SETWALL`, `SEEN`, `DEPTH` without a `VIEW3D` are errors reported by the **code generator**, not the checker (as batch 2's `CAMERA`: the old table test `tests/arcade-parse.mjs` calls every function
   of the word table in a program with nothing declared). `COSA`, `SINA`, `FXMUL` are plain functions: no `VIEW3D` needed. With a runtime older than v4 every new word is an error that says "needs the v4 runtime (the
   raycaster runtime): build with --runtime v4" (`check(ast, {version})`; `check(ast)` with no version assumes nothing and stays quiet).
7. `SETWALL x, y = t`: a **literal** (or CONST) `t` outside 0..4 is an error ("the wall type is 5: it must be 0..4"); a run-time `t` outside 0..4 is **ignored by the runtime** (the compiler adds no guard, to keep the game area
   small). `y` is read at the additive level like `TILE`'s, so the `=` is not taken as a comparison.
8. The map errors (code generator, at the map name of the `VIEW3D`): 4..32 cells on each side, every cell 0..4 (blank, -1, null or 255 is 0), the outer ring non-empty, with the **row and column** of the first bad cell.
9. **Warnings.** (a) The `FRAMERATE` divisor (60 / rate) below the minimum: 3 for `COLW 4`, 5 for `COLW 2`. **No `FRAMERATE` means 30 a second, a divisor of 2, so it warns too** (the message says so). It is on the
   FRAMERATE line when there is one, else on the VIEW3D. (b) A **non-square billboard sprite** (the true width differs from the height; the asset is "stretched to a square"): once per asset, at its SPRITE line.
   A fully scaled 8-pixel-wide 8-high pill is square and fine.

**The image and the report**
10. Header: `frame_div | DIV_EXT | DIV_VIEW` (`DIV_VIEW` from `runtime.json`, default `$40`), 20 bytes, `map_table` at +16 (zero when no HUD map), `view_desc` at +18, descriptors at `$8014`, as batch 2. A v4
    program with **no** VIEW3D has frame_div only (and DIV_EXT when it has a map table): the runtime then behaves as v3 without a window, **and the compiler plans the v3 phase pool for it** (the v4 runtime keeps the
    pool for that case; `POOL_A/B/C` of `runtime.json`).
11. After the sprite data: `map_src` (the w x h cells row-major, **row stride = map_w**, byte-RLE: pairs `count 1..255, value`, a count of 0 ends; the same `rleEncode` as `world_src`), the 16 pattern bytes when there are
    any, `view_desc` (10 bytes: `+0 colw, +1 map_w, +2 map_h, +3 attr_top, +4 attr_bottom, +5 DW map_src, +7 DW patterns, +9 flags 0`). The expansion into the runtime's 32-stride array (cells outside w x h are wall
    type 1) is the runtime's job. No scroll tables, no tile data.
12. **No phase pool in ray mode**: `planPhasePool` is not run (no `POOL_FAIL`, no "frames stay cached" warnings); sprites only need their frame data in the image (descriptors as v3: `nframes`, true width padded to 8).
    Frames are compiled as in batch 2 (item 15: all frames of an asset some SHOW animates, mirrored copies with FLIP). The `hot` box stays in the image (the descriptor's pointer) and is ignored by `RT_HIT` in ray mode.
13. The link report (`usage.view`): `mapSource` (encoded bytes), `mapExpanded` (1,024), `mapW`, `mapH`, `descriptor` (10), `patterns` (0 or 16), `colw`, `attrTop`, `attrBottom`, `at` (addresses), and a fixed `note` that the ray
    tables, buffers and the 32 x 32 array are runtime memory. `usageLines` shows two lines for it. `usage.phaseRam` and `usage.window` are absent; `usage.gameVars` and `usage.frames` are there.

**Code generation**
14. `VIEW x, y, a`: HL = x, DE = y, BC = a, `CALL RT_VIEW`; the arguments are evaluated in source order (plain variables and constants are loaded last, which cannot change the result).
    `SETWALL x, y = t`: `RA_X`, `RA_Y`, `RA_V` in that order, `CALL RT_SETWALL`. `COSA(a)` / `SINA(a)`: HL = a, `CALL RT_COSA` / `RT_SINA`. `FXMUL(a, b)` / `WALL(x, y)`: HL, DE, `CALL`.
15. `SEEN(s)` / `DEPTH(s)`: no call, a read of `BB_TAB` (address from `runtime.json`'s symbols or constants; **no fallback**: without it the compiler says so) at `BB_TAB + BB_ENT * instance` (+2 for SEEN, +0 for DEPTH);
    `BB_ENT` from `runtime.json`, default 4 (the contract). A constant instance is one `LD HL,(nn)`; a run-time index is bounds-checked against the pool and gives -1 (SEEN) / 0 (DEPTH) outside it, like a
    sprite not drawn. `SEEN` returns the 16-bit word as a signed value ($FFFF is -1).
16. `SHOW` in ray mode compiles exactly as in v3 (`RT_SHOW` / `RT_SHOWF`); the **runtime** stores the raw 16 bits unclamped.

**Reference interpreter** (`arcade-interp.js`, with `arcade-view.js`)
17. State: the 32 x 32 array (1,024 bytes, row stride 32, cells outside the game's map = wall type 1) and the pose `{x, y, a}` (0, 0, 0 until the first VIEW). The record has `view` (the pose) and `wallRam` (a copy).
18. **Signedness.** `VIEW` and `WALL` read x, y as **signed** 16-bit values: `VIEW` clamps a negative value to 0 and a large one to `map * 256 - 1`; `WALL` gives 1 for a negative value or one at/after 32 * 256. `SETWALL`
    ignores a negative position. `HIT` in ray mode takes the stored positions as **unsigned** 16-bit values (`SHOW` stores the raw 16 bits; a position outside the map is never meant to hit anything). These are
    contract section 2's "Clarifications"; they make no difference for positions inside the map.
19. `COSA` / `SINA` take the angle AND 255 (the low byte of any 16-bit value); the table is the contract's (`Q[k] = round(4096 sin(k pi / 128))` mirrored; `COSA(a) = (C[a] + 8) >> 4`, `SINA(a) = (C[(a + 192) AND 255] + 8) >> 4`);
    hand values: `COSA(0) = 256`, `COSA(32) = 181`, `COSA(64) = 0`, `COSA(128) = -256`, `SINA(64) = 256`. `FXMUL(a, b) = floor(a * b / 256)` of the exact product wrapped to 16 bits (`FXMUL(-1, 1) = -1`,
    `FXMUL(32767, 32767) = -256`).
20. `SHOW` in ray mode stores x, y as signed 16-bit, **no clamp**. `HIT`: both shown, `|dx| < Ra + Rb` and `|dy| < Ra + Rb`, `R = 4 * h` (h = the asset's height in pixels, so a 16-high sprite has R = 64 and two of
    them hit at |d| < 128); the `hot` box is ignored.
21. `SEEN` / `DEPTH` return what the harness injects: `opts.billboard(tick, instance)` -> `{depth, col}` (or nothing = not drawn), the values the previous tick's draw left in `BB_TAB` when PROC FRAME of `tick` starts. The
    differential test records the real runtime's `BB_TAB` at each entry of PROC FRAME and passes exactly those values.

## What the runtime engineer must match
* The header and `view_desc` as above; `map_src` is **w x h** cells row-major with stride `map_w` (not 32), expanded into the 32-stride array with wall type 1 outside; a count of 0 ends the stream; stop at `map_w * map_h` bytes.
* `RT_VIEW`: HL = x, DE = y **signed**, BC = a (low byte); a negative position is 0, beyond the map `map * 256 - 1`. `RT_WALL`: signed, negative or >= 8192 gives 1. `RT_SETWALL`: `RA_X`, `RA_Y` signed (negative ignored), `RA_V`
  the whole 16-bit word, written only for 0..4, only inside `map_w x map_h`. `RT_COSA` / `RT_SINA`: low byte of HL. `RT_FXMUL` as the contract. These are the "Clarifications" added to contract section 2.
* `RT_HIT` in ray mode: unsigned positions, `R = 4 * h` from the descriptor's height byte (+1), the hot box ignored, hidden never hit, an instance >= the count gives 0.
* `BB_TAB` / `BB_ENT` in `runtime.json` (a symbol or a constant); at boot every entry `depth` 0, `col` $FFFF. `DIV_VIEW` in `runtime.json` (default `$40`). `RA_X RA_Y RA_V` and `RT_ARGS` as v2/v3.
* `SPR_TAB` entries as v3 (8 bytes: visible, asset, x, y, frame, pad); in ray mode no clamp; `SPR_TAB` byte 1 (asset) set at boot for every declared instance.
* `runtime.json` `version: 4` (the compiler takes the v3 code path for `version >= 3`, adds the batch 3 words at `>= 4`).

## Tests
`node tests/arcade-m8-compiler.mjs` (under a second; `ARCADE_QUICK=1` shrinks the fuzz): parser and checker positives and negatives for every word and error, the word table (and breakout's `SFX wall`), the maths against
independent models (all 256 angles, 20,000 FXMUL pairs, the map array), the interpreter hand-computed, the image layout read back from the DCK (header, view_desc, map_src, attributes, PATTERNS, descriptors, the
refusals, runtime.json constants), the compiled maze game (720 ticks), every word and the smallest map on the mock equal to the interpreter tick by tick, argument forms and evaluation order, **3,368 queries** (WALL,
FXMUL, COSA, SINA among SETWALLs and VIEWs, maps 4..32 a side, the 1,024-byte array and the pose compared at the end) against an independent model on both the interpreter and the compiled code, the byte-identity of
eleven old builds, `requiredRuntime`. `node tests/arcade-m8-differential.mjs` runs the same programs on the real runtime (skips with a message until it has the routines).
