# Leap Arcade runtime API v2 (milestone M4a contract, 2026-11-09)

Game B (vertical shooter) needs more things on screen than v1 allows. M4a is the capacity step: sprite pools, arrays,
keyboard input, a memory re-plan. Scrolling and music are M4b. v2 extends v1 (`ARCADE_RUNTIME_API_V1.md`); v0 and v1
and their tests stay untouched. The v2 runtime lives in `arcade/runtime/v2/`, builds to `arcade/build/v2/` with
`"version": 2` in `runtime.json`.

## Sprite assets and instances
* **Assets** (shared art, pre-shifted tables): up to 8. **Instances** (things on screen, each with a position): up to 16.
  `MAX_SPRITES` = 16 is the instance count; an instance names the asset it draws.
* **Phases per asset** (horizontal positions the art is pre-shifted for): 8, 4, 2 or 1. With 4 / 2 / 1 phases the x
  coordinate is rounded DOWN to a multiple of 2 / 4 / 8 when drawn (the stored x is unchanged). Fewer phases = less RAM
  and faster setup; the compiler picks 8 unless the program says otherwise (a later Studio setting); v2 runtime must
  support all four.
* Descriptor in the game image, 8 bytes: `DB w, DB h, DW data, DW hot, DB phases, DB 0`. Header gains
  `$800E DW inst_table` -> `DB ninst (<=16)` then `ninst` bytes, each the asset index of that instance.
  `sprite_count` (header byte `$8005`) now means the number of **assets** (<= 8); `sprite_table` unchanged otherwise.
* `SPR_TAB` has 16 entries of 6 bytes (`DB visible, DB asset, DW x, DW y`), indexed by instance. `RT_SHOW`, `RT_HIDE` and
  `RT_HIT` take **instance** indices (0..15); an index >= `ninst` is ignored (HIT gives 0).
* Draw order: lowest instance first (so a higher index appears on top).

## Memory re-plan (runtime engineer decides the exact map; constraints)
RAM chunk 6 is full with v1 tables. Free space: the v1 stack region `$F002-$FEFF` is far larger than needed (peak use
measured at 10 bytes in v0, 8 in M1): limit the stack to a documented 1 KB at the top (`$FB00-$FEFF` with the canary at its
bottom) and use the freed space for tables (phase tables, instance state, dirty bitmaps). `GAME_VARS` `$E100-$EFFF` keeps
its size and address, and now also holds compiled arrays. Document the final map in `layout.inc`.

## Keyboard
`RT_KEYDOWN`: A = ASCII code of a key (`A`-`Z`, `0`-`9`, space `32`, enter `13`; upper case; 0 for unknown) -> HL = 1
if that key is held, else 0. Reads the 8 keyboard half-rows directly (`IN` with the half-row in B, as V2's `IO_KEY_SCAN_ALL`
does; no ROM). Shift keys are keys too: use codes `1` = CAPS SHIFT, `2` = SYMBOL SHIFT. It must not disturb the AY or the
interrupt handler (no `DI` needed for a keyboard read).

## Arrays (compiler-only; no runtime routine)
`DIM a(n)` with literal `n` (1..1000): elements `a(0)..a(n)` are 16-bit slots in `GAME_VARS`. **Out-of-range index:**
a read gives 0 and a write is ignored (safe, defined, identical in compiler and interpreter). Arrays are global or
scene-local like scalars; one dimension; no array parameters. `a(i)` is allowed anywhere a variable is.

## Language (v2 additions)
* `DIM a(n)` as above.
* Sprite declarations: `SPRITE name = "asset"` (one instance, as before) and `SPRITE name(n) = "asset"` (n instances
  sharing the asset, indices `name(0)..name(n-1)`; at most 16 instances in total across the program). A bare
  `SPRITE name = ...` instance and a pool both accept `SHOW name(i) AT x, y`, `HIDE name(i)`, `HIT(a, b)`, where a and b
  are instance references (`name` or `name(expr)`). Instance index expressions are bounds-checked like arrays
  (out of range: `SHOW`/`HIDE` ignored, `HIT` gives 0).
* `KEYDOWN(c)`: `c` is a number or a single-character string literal (`KEYDOWN("Q")`, folded at compile time).
* `FRAMERATE` may be 60, 30, 20, 15, 12, 10, 6, 5, 4, 3, 2, 1 as before. The Studio-independent compiler reports a
  **warning** if a measured worst-case tick (debug build, later) overruns; not part of M4a.

## State the tests read (add to runtime.json)
`SPR_TAB` (16 entries, new layout), `INST_ASSET` or equivalent, `V_KEYS` (8 bytes: last scanned half-rows, optional),
`MAX_SPRITES`, `MAX_ASSETS`, plus the v1 symbols.

## Acceptance for M4a
A playable vertical shooter `arcade/examples/shooter.arc`: player ship (keyboard Q/A/O/P/space or joystick), a bullet pool
(4), an enemy pool (8, as two pools of 4) with several movement patterns chosen by `SELECT`, enemy shots (pool of 3), score and lives HUD,
explosions (a short tile or sprite animation), sound effects, waves that get harder, game over and restart. At
`FRAMERATE` 20 with 16 visible 16x16 sprites a worst-case tick must fit in 3 refreshes (176k T): the runtime reports
its measured cost per sprite so the budget can be checked; if it does not fit, the runtime engineer says what to optimise
first (the next steps would be skipping unchanged sprites, a faster erase, or unrolled blitters).

*Correction (2026-11-09): the first draft asked for 6 bullets + 8 enemies + 4 shots + the player = 19 instances, over the limit of 16. The shooter as built uses ship + 4 bullets + 8 enemies + 3 shots = 16.*

## As built (M4a, 2026-11-09)
Source `arcade/runtime/v2/` (a refactored copy of v1; v0 and v1 and their tests untouched), build `node arcade/tools/build-runtime-v2.mjs` ->
`arcade/build/v2/` (`runtime.json` with `"version": 2`, 270 symbols, 78 constants; `runtime.bin`, `runtime.inc`, `.sym`, `.lst`, `runtime.dck`; the tool also
exports `assembleGame`, `linkGame`, `dckOf`). Tests, all on TSRun with the stock ROMs: `m4-runtime.mjs` (boot, header and every clamp, the phase copies byte
for byte, the picture), `m4-runtime-api.mjs` (RT_SHOW / RT_HIDE / RT_HIT / RT_KEYDOWN against models), `m4-runtime-mem.mjs` (memory map, worst-case game,
stack), `m4-runtime-regs.mjs` (interrupt injection), `m4-runtime-skip.mjs` (the skip), `m4-runtime-perf.mjs` (T-states), `m4-mutations.mjs` (52 deliberate
bugs in the v2 sources, run in a scratch copy; all killed). Test game: `arcade/runtime/v2/test_script.asm`, the v1 script interpreter with RT_KEYDOWN, a compact SHOW and a stack-depth op; header, assets (random
art from the test), instances, tileset, sfx, map and script are data written by `m4-common.mjs`.
**Size:** runtime 7,227 of 16,384 bytes in DOCK chunks 0-1 (font 768).

**Header and clamps.** `GAME_HEADER_LEN` 16; `inst_table` at `$800E` (0 = no instances). Asset descriptor `DB w, h; DW data, hot; DB phases, 0`. Art rows: width 16 =
`mask_hi mask_lo image_hi image_lo`, width 8 = `mask image` (the contract left the 8 wide format open). Boot clamps (all tested): `sprite_count` > 8 -> 8;
`sprite_table` 0 -> no assets; width <= 8 -> 8, else 16; height 0 -> 1, > 16 -> 16; phases -> the largest of {1, 2, 4, 8} not above the value (0 -> 1);
`inst_table` 0 -> no instances; `ninst` > 16 -> 16; no asset -> `ninst` 0; an instance's asset index >= `sprite_count` -> `sprite_count - 1`. `hot` 0 = the
whole sprite (width x height). Clamps of `RT_SHOW` are the contract's for every asset (x 0..239, y 0..176: an 8 x 8 sprite cannot reach the last 16 pixel
columns / rows; the reference interpreter does the same).

**Assets, phases, rounding.** `AST` (8 bytes per asset, `$D4C0`): `AST_H`, `AST_WB` (width / 8), `AST_XMASK` (`$FF/$FE/$FC/$F8` for 8/4/2/1 phases), `AST_PHASES`,
`AST_HOT` x y w h. `PHASE_PTR[asset][shift]` (`$C180`, 8 x 8 words, 0 = this asset has no copy for that shift) points at the pre-shifted copy; copies live in 64
slots of 96 bytes in three pools (`POOL_A` 32, `POOL_B` 28, `POOL_C` 4), so 8 assets x 8 phases of 16 x 16 always fit (tested: all 64 used, every copy
compared with an independent JS pre-shift). A copy has only the asset's height rows and 2 x wb bytes a row (wb = width/8, +1 unless the shift is 0): an
aligned 16 wide sprite blits 2 bytes a row. **The x rounding happens in `draw_all`** (`main.asm`): `xd = x AND AST_XMASK`; `SPR_TAB` keeps the x `RT_SHOW`
stored; `RT_HIT` uses the stored x. `SPR_TAB` byte 1 is the asset (set at boot, never written by RT_SHOW; the `INST_ASSET`/`SPR_ASSET_OFF` constants name it).
Draw order is the instance index. Each file's record (`SPR_DRAWN`, 4 bytes: flag, E, D = the screen address of the first byte drawn in THAT file, N = n_cols<<5 |
height) drives the erase from where the instance was drawn in that file.

**Memory map (layout.inc).** Chunk 6: `ROW_TAB` `$C000`, `PHASE_PTR` `$C180`, `POOL_A` `$C200-$CDFF`, `CELL_TILE` `$CE00`, `CELL_ATTR` `$D100`, `DIRTY0` `$D400`,
`SPR_TAB` `$D460` (16 x 6), `AST` `$D4C0`, `DIRTY1` `$D500`, `SPR_DRAWN` `$D560` (2 x 16 x 4), free `$D5E0-$D5FF`, `TILE_ATTR` `$D600`, `POOL_C` `$D680-$D7FF`,
`GLYPH_TAB` `$D800-$DFFF`. Chunk 7: variables `$E000-$E0FF` (new: `V_KEYS`, `V_CHG`, `V_KIND`, `SK_RECT`, scratch; free `$E0F8-$E0FF`), `GAME_VARS` `$E100-$EFFF`
unchanged, `POOL_B` `$F000-$FA7F`, free `$FA80-$FAFF`, canary `$FB00`, **stack `$FB02-$FEFF` (1,022 bytes; compiled code may use 1,012 of them, the frame
interrupt needs 10 more at any moment: tested with an effect playing)**, hand-off `$FF00+`. Boot scratch (96 bytes) is `$FC00`, inside the stack area. Nothing
is written during play outside the display file, cell map, dirty maps, `SPR_TAB`, `SPR_DRAWN`, variables, `GAME_VARS` and the stack (a test tracks every write
of a worst-case game with all free areas poisoned). The build asserts the 8-bit address arithmetic the code uses; `m4-runtime-mem.mjs` proves the 21 regions disjoint.

**Frame loop order changed:** `frame_entry` now runs FIRST, then the skip analysis, `erase_all`, `redraw_dirty`, `draw_all` (v1 erased first). The erase uses the
file's own record and the cell map and the dirty cells are redrawn afterwards, so the picture is identical; the analysis needs the new positions.

**RT_SHOW / RT_HIDE / RT_HIT.** Index >= `ninst` is ignored (HIT gives 0). `RT_SHOW` compares the clamped position with the stored one: nothing changes -> nothing
is written; otherwise it writes and sets `V_CHG[i] = 2` (ticks still owed to the two display files); `draw_all` pays one per file. `RT_HIDE` does not touch
`V_CHG` (a hidden instance is never a skip candidate and `RT_SHOW` sets it again when the instance is shown). Clobbers AF BC DE HL only; 28..470 T (SHOW / HIDE) /
128..1,880 T (HIT).

**RT_KEYDOWN.** Own table from the TS2068/Spectrum matrix (`keys.asm`; Leap V2's `IO_KEY_SCAN_ALL` reads B = `$FE,$FD,...,$7F` with `IN A,(C)`, C = `$FE`; rows:
CAPS SHIFT Z X C V / A S D F G / Q W E R T / 1-5 / 0 9 8 7 6 / P O I U Y / ENTER L K J H / SPACE SYMBOL-SHIFT M N B). One `IN` of the one row needed, 251..271 T,
no `DI`, no port write, the value read is also stored in `V_KEYS[row]`. Tested against the matrix TSRun's own keyboard produces (`tsrun/keyboard.js`
`handleKeyDown`, host keys `KeyA`, `Digit1`, `Space`, `Enter`, `ShiftLeft`, `ControlLeft`): every one of the 40 keys alone with all 256 codes asked, 400 random
chords, and AY writes / ISR timing identical with and without 20 key reads a tick while an effect plays. Lower case, punctuation, 0 and unknown codes read 0.

**The skip (optional optimisation, `skip.asm`).** An instance that is visible, has `V_CHG` = 0 (unchanged since it was drawn into BOTH files), covers no dirty cell
and shares no cell with any other drawn/visible instance is neither erased nor drawn (record flag `$81` during the tick). Proof by picture: all scenes of
`m4-runtime-skip.mjs` (statics overlapped by movers in both draw orders, text / tiles / CLS under statics, overlapping static pairs, hide + show, one pixel nudges,
five random 16-instance mixes at frame_div 1..3) equal the JS compositor after every refresh with the skip on, and with the call patched out (`noSkip`). **It does
not pay for a typical shooter:** the analysis runs only when 6 or more instances stand still (`SKIP_MIN`); it costs about 14,000 T plus 1,700 T per candidate
(pass A builds a cell rectangle for each of the 16 instances, then the candidates are tested against all 16), a skipped 16x16 sprite saves about 5,000 T.
Measured, 16 instances over a text screen, the rest moving: nothing static +1.0 %; 8 static -2.7 % (break-even); 12 static -16 %. With fewer than 6 static the
cost is the scan (35 T per instance) plus about 50 T per `RT_SHOW` and 80 T per drawn instance for the `V_CHG` bookkeeping, together about +1.5 % of the
worst-case tick.

**Performance** (TSRun, a refresh is 58,688 T; `m4-runtime-perf.mjs`; averages over positions that change every tick; "aligned" = x and y multiples of 8):

| asset | erase | draw | aligned (erase / draw) |
|---|---|---|---|
| 16x16, 8 phases | 2,096 | 3,339 | 1,196 / 2,574 |
| 16x16, 2 phases | 1,868 | 3,049 | 1,196 / 2,574 |
| 8x8, 8 phases | 1,091 | 1,772 | 536 / 1,317 |

v1 measured 2,582 erase and 3,335 draw for its 16x16 sprite (M3 report); the first working v2 (same algorithms, unrolled blitters) 2,544 / 3,561. Worst case
(16 visible 16x16 sprites, all moving every tick, x and y never aligned, a screen full of text, `frame_entry` = 16 `RT_SHOW`): **8 phases: tick work max
105,903 T (1.80 refreshes, erase_all 33.5k, redraw_dirty 1.3k, draw_all 53.2k); 4 phases: max 102,365 T.** That fits in 3 refreshes (176k T) with 70k T for the
game's own `frame_entry`, and in 2 refreshes (117k T) with 11k to spare (a game doing much logic needs 3). Cost split of a 16x16 / 8 phase draw: 2,240 T are the 16 rows
of 3 bytes at 40 T/byte (`ld a,(de); and (hl); inc hl; or (hl); inc hl; ld (de),a`), the rest the setup (about 700 T) and group handling. Optimisations done, each
checked by the full test suite: unrolled 8-row blitters per window width (1, 2, 3 bytes), entered at the right row, groups split at the cell boundaries (-245
T/sprite); a 2-byte window for aligned positions (-770 T for those); nine unrolled erase variants (rows x columns) with no per-row bookkeeping (-280 T) and a
record that keeps the screen address (-170 T more); pointer arithmetic in registers / on the stack instead of memory; the `V_CHG` bookkeeping of the skip
added about 90 T per sprite back. Next if more is needed: (1) erase only the
rows a sprite covered in its first and last cell row (-500 T per unaligned sprite, needs entry points into the erase rows), (2) trim fully transparent edge
bytes of each phase copy at boot (art dependent), (3) serpentine rows to drop the `inc e / dec e` pairs (-16 T/row, needs two block copies), (4) a cheaper analysis
(keep the cell rectangle in the record) if mostly-static scenes matter.

**Deviations / decisions.** `inst_table` 0 means no instances (not "one per asset"). `RT_SHOW` clamps are not per asset. Frame loop order (above). The contract asked for
`INST_ASSET`: it is `SPR_TAB` byte 1 of each entry (`SPR_ASSET_OFF`, stride `SPR_ENT` = 6). `MAX_SPRITES` = 16 and `MAX_ASSETS` = 8 are in `constants`. The v1
statement "sprite descriptors keep the v0 format" no longer holds: v2 descriptors are 8 bytes and v1 games do not run on v2.

## As built: language batch 1, tile operations (M5, 2026-11-09)
Contract: `docs/ARCADE_LANGUAGE_BATCH1.md` ("Tile operations", "Maps"). **Additive to v2**: `"version": 2` stays; no routine, table or tick cost of v2 changed. The new code is one
module, `arcade/runtime/v2/tileops.asm` (labels `M_TILEOPS_S/E`, 2,104 bytes), placed after the font. Three tiny edits elsewhere: `boot.asm` (reads `frame_div AND $7F`; sets `V_BORDER`),
`video.asm` (`cells_init` calls `maps_boot`), `runtime.asm` (the include). Runtime size 9,337 of 16,384 bytes in DOCK chunks 0-1 (was 7,227). Entry points and constants are in
`arcade/build/v2/runtime.json` (`RT_FILL`, `RT_FILLC`, `RT_COPY`, `RT_LOADMAP`, `RT_LOADMAPAT`, `RT_LOADMAPPTR`, `RT_BORDER`, `RT_RANDOMISE`; constants `RT_ARGS`, `RA_X` `RA_Y` `RA_W` `RA_H` `RA_V`
`RA_DX` `RA_DY`, `GAME_MAPTAB`, `GAME_HEADER_EXT_LEN`, `DIV_EXT`, `MAX_MAPS`, `V_BORDER`, `V_NMAP`, `V_MAPTAB`, `TO_BUFT`, `TO_BUFA`, `RT_SEED`, `V_FRAMES`).

**Register convention.** All coordinates are signed 16-bit and clipped by the runtime (the compiler does no clamping). FILL / FILLC / COPY take their arguments in the
**argument block `RT_ARGS`** (12 bytes of RAM at `$FAC0`, little-endian words; the compiler evaluates each argument to HL and stores it with `LD (RA_x),HL`, in any order, then CALLs):
`RA_X` +0, `RA_Y` +2, `RA_W` +4, `RA_H` +6, `RA_V` +8 (= `RA_DX`), `RA_DY` +10. The routines never change the block (unchanged words may be reused by the next call).
| Routine | In | Meaning |
|---|---|---|
| `RT_FILL` | `RA_X, RA_Y, RA_W, RA_H`, `RA_V` = tile (AND `$7F`) | `FILL x, y, w, h = t`: the cells of the clipped rectangle become game tile t (cell byte 128+t, attribute `TILE_ATTR[t]`, exactly as `RT_TILE`) |
| `RT_FILLC` | same, `RA_V` = character code (AND `$7F`) | `FILLC`: cell byte = code, attribute = `V_TEXT_ATTR` (as `RT_PRINTC`; codes 0..31 and 127 are blank glyphs); the text attribute and cursor are not changed |
| `RT_COPY` | `RA_X, RA_Y, RA_W, RA_H` (source), `RA_DX, RA_DY` (destination top left) | `COPY x, y, w, h TO dx, dy`: cell byte and attribute of each source cell go to the destination cell, as a **memmove** (all reads before the writes: any overlap, all 8 directions). **Clipping:** cell (i, j) of the w x h rectangle is copied only if BOTH (x+i, y+j) and (dx+i, dy+j) are on the 32 x 24 screen (the intersection of the visible parts; a source cell off screen leaves its destination untouched) |
| `RT_LOADMAP` | A = map index (0..count-1) | `LOADMAP name`, at cell (0, 0) |
| `RT_LOADMAPAT` | A = map index, BC = x, DE = y (signed; the `RT_SHOW` convention) | `LOADMAP name AT x, y` |
| `RT_LOADMAPPTR` | HL = address of a map record (`DB w, DB h`, w*h cell bytes), BC = x, DE = y | the same for a map the compiler addresses directly (any address, also RAM) |
| `RT_BORDER` | A = colour (AND 7) | `OUT ($FE),A` (beeper and MIC bits 0); the colour is kept in `V_BORDER` (`$E0F8`; boot sets `BORDER_COLOUR` = 1: the boot border is unchanged) |
| `RT_RANDOMISE` | HL = seed | `RT_SEED = HL`; **HL = 0 seeds from the low 16 bits of `V_FRAMES`**, and `RT_SEED` is never left 0 (a zero frame counter gives 1). `RANDOMISE` = `LD HL,0`; `RANDOMISE n` = `LD HL,n` (the compiler turns a constant n = 0 into 1; an `n` that is 0 at run time seeds from the frame counter) |
Degenerate cases do nothing (no cell, no dirty bit): w <= 0 or h <= 0, a rectangle entirely off screen, a destination that cannot overlap (|dx - x| >= 32, |dy - y| >= 24), `COPY` onto itself, an index >= the map count, no map table, a zero map pointer, a map with w = 0 or h = 0. w, h up to 32767; x + w never wraps (the clip works on the true sum).
**LOADMAP**: the map's cells (`cell < 128` a font code, `>= 128` a tile) go to the cell map at (x, y), cut to the screen on all four sides (the source offset follows the cut); cells outside the map and outside the screen are untouched. Attribute: `TILE_ATTR` of the tile for a tile cell, `BG_ATTR` for a font cell (as the boot's map copy). Maps may be larger than the screen (up to 255 x 255).
**Dirty marking** is `RT_TILE`'s: a cell is marked dirty (both dirty maps) iff its cell byte OR its attribute changed; an unchanged cell marks nothing, so a repeated FILL costs no redraw. (Marked 8 cells at a time: a mask per dirty-map byte.)
**Clobbers** AF BC DE HL; IX, IY and the alternate registers are preserved (the loops use the alternate set and put it back: 6 bytes of stack); no `DI`/`EI`; stack beyond the CALL: 10 (FILL, LOADMAP) to 12 bytes (COPY) measured, 20 allowed, plus 10 for an interrupt. RAM: `$FA80-$FAF5` (formerly the free area "T3") and `$E0F8-$E0FB` (formerly free):
`TO_BUFT $FA80` (32) / `TO_BUFA $FAA0` (32) COPY's row buffer, `RT_ARGS $FAC0`, scratch `TO_VARS $FACC-$FAF5`; `V_BORDER $E0F8`, `V_NMAP $E0F9`, `V_MAPTAB $E0FA` (word); `$E0FC-$E0FF` stay free. `m4-runtime-mem.mjs` and `m5-runtime-mem.mjs` know the new map.
Only the operations write these; a game that never calls them leaves them untouched (the poisoned-memory test of the worst-case game passes unchanged).

**Header: the map table (backward compatible).** Bit 7 of `frame_div` (`DIV_EXT` = `$80`, header byte `$8004`) says the header is 18 bytes (`GAME_HEADER_EXT_LEN`): `$8010 DW map_table` (`GAME_MAPTAB`).
Games compiled before this change have `frame_div` <= 60 (bit 7 clear), keep the 16-byte header and boot exactly as before (the runtime reads `frame_div AND $7F`; a hand-made image with `frame_div` >= 128 would now be read as extended).
`map_table` -> `DB count` (0..8; more is read as 8), then `count` x `DW map_ptr`; each map: `DB w, DB h`, then w*h cell bytes row-major (cell = 128 + tile index, or a font code; `docs/ARCADE_ASSETS.md`). A zero `map_ptr` is an empty map.
With the table present and `count` >= 1 the boot loads **map 0 as `LOADMAP` would at (0, 0)** (its own w x h, clipped; the rest of the screen blank) and the old `map_ptr` (`$800C`, 768 raw cells) is ignored (the compiler may still fill it in for old tools, e.g. with map 0's cells when map 0 is 32 x 24); a zero pointer for map 0 falls back to `map_ptr`.
Without the table (no `DIV_EXT`, a null table pointer, or `count` = 0) `map_ptr` means what it always did. The sprite descriptors follow the header wherever `sprite_table` says (the linker places them at `$8012` for an extended header).

**Cost** (TSRun, `m5-runtime-perf.mjs`; a refresh is 58,688 T; CALL and RET included; "nothing to mark" = the cost beyond the dirty marking):
| case | T | T per cell |
|---|---|---|
| FILL 32x24, every cell changed | 80,200 (1.37 refreshes) | 104 |
| FILL 32x24, nothing changed | 71,848 | **94** |
| FILLC 32x24, every cell changed | 77,868 | 101 |
| FILL 8x8 byte aligned / 32x1 / 10x10 unaligned / 1x1 | 9,846 / 4,115 / 22,154 / 1,850 | 154 / 129 / 222 / (fixed cost) |
| COPY 32x23 down one row, changed (630 dirty) / nothing changes | 98,161 / 90,749 | 133 / **123** |
| COPY 31x24 right one cell (same rows, through the row buffer) | 144,450 | 194 |
| COPY 8x8 to a distant place / 1x1 | 21,121 / 2,652 | 330 / (fixed) |
| LOADMAP 32x24 into a blank screen / again, nothing changes | 147,880 (2.52 refreshes) / 139,528 | 193 / **182** |
| LOADMAPAT (10, 5), cut to 22x19 | 91,833 | 220 |
| 768 x `RT_TILE`, changed / unchanged (the calls only, no loop, no argument code) | 308,736 / 179,712 | 402 / 234 |
A call that does nothing costs 207 T. Whole bytes (8 cells aligned to the dirty map) run in unrolled loops (FILL slot 34..37 T per cell and plane, COPY 41..44, LOADMAP tile 43..46); the first and last groups of a row
(and rectangles narrower than a byte) use a slower loop (about 60 T per cell and plane) and carry about 500 T of overhead per group, which is why narrow rectangles cost 130-220 T per cell. **The "under 100 T per cell beyond the dirty marking"
target is met for FILL on whole bytes (94 T); not for COPY (123 T) and LOADMAP (182 T; its attribute pass looks every tile up) and not for narrow rectangles.** Against a compiled loop (RT_TILE alone is 402 T changed, plus about 100-250 T of loop and
argument code per cell) FILL is 5-6 times, COPY 4-5 times and LOADMAP about 3 times cheaper; a whole-screen FILL is 1.4 refreshes (a whole-screen redraw of 768 cells costs another 6 refreshes in the two display files, which is the real cost of changing the whole screen).
Ideas if more is needed: keep the dirty mask of a whole row in registers (saves ~80 T per group), a translate-then-compare attribute pass for LOADMAP (saves ~25 T per cell), position-specific unrolled entries for partial groups.

**Tests** (all on TSRun with the stock ROMs, `node arcade/tests/run-all.mjs`): `m5-runtime.mjs` (every routine against the JS model of `m5-common.mjs`: 4,000 FILL, 3,000 FILLC, 6,000 COPY incl. all 8 overlap directions, same-row and
far-away destinations, 2,980 random maps of every size 0..255 at random positions through `RT_LOADMAPPTR` and 2,400 by index through six map tables, the clip sweep around 255/256/288/512; cells, attributes, DIRTY0 = DIRTY1 = exactly the changed cells,
registers, argument block, memory written, stack; the header cases: table at boot, count clamp, zero pointers, old 16-byte header, `frame_div` bit 7; BORDER over all 256 values; RANDOMISE), `m5-runtime-pic.mjs` (the frame loop: the picture
equals cells + sprites after EVERY refresh at frame_div 1, 2, 3 with random operations over moving instances, the boot map, the overrun with whole-screen operations every tick, RNG/BORDER in a running game), `m5-runtime-regs.mjs` (a real interrupt
injected at every instruction boundary of tileops.asm, up to 10 times per address and every 25th time after: all registers incl. alternates, IX, IY, SP, flags unchanged; chaos run with extra interrupts at random boundaries incl. inside the operations;
FILL of the whole screen every tick), `m5-runtime-mem.mjs` (writes confined to the cell map, dirty maps and the operations' own RAM; poisoned free areas untouched; the new map is disjoint), `m5-runtime-perf.mjs`,
`m5-mutations.mjs` (58 deliberate bugs in tileops.asm / boot.asm / video.asm, run in a scratch copy: 55 killed, 3 equivalent mutants survive by construction: redundant early exits). Test game: `arcade/runtime/v2/test_ops.asm` (the v2 script game with the 18-byte header, a map table and ops 21..29).
