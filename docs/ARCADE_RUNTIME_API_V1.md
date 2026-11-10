# Leap Arcade runtime API v1 (milestone M3 contract, 2026-11-09)

M3 makes acceptance game A (Breakout) playable: text, tiles, collision, sound. It extends `docs/ARCADE_RUNTIME_API.md`
(v0, which stays valid and keeps its tests). The v1 runtime lives in `arcade/runtime/v1/` (a copy of v0 refactored,
v0 untouched) and writes `arcade/build/v1/runtime.json` and `runtime.bin`; `runtime.json` has `"version": 1`.

## The screen is a 32x24 cell map plus sprites
Both display files show the same picture: the **cell map** (one byte per 8x8 cell, plus an attribute byte per cell)
drawn first, sprites on top. Text, tiles and the background are all cells. Sprites no longer erase to a fixed
checkerboard: erasing a sprite redraws the cells it covered (up to 3x3 per sprite) from the cell map.
* `CELL_TILE` (768 bytes, row-major, row 0 first) and `CELL_ATTR` (768 bytes) in RAM chunk 6 (addresses in runtime.json).
* Cell value: bit 7 = 0 -> built-in font character (codes 32..127 used; 0..31 draw blank); bit 7 = 1 -> game tile
  (value - 128 = tile index 0..127).
* The runtime keeps per-file dirty bitmaps (96 bytes per file): any change to a cell marks it dirty for both display
  files; each tick the hidden file redraws its dirty cells (and clears that file's bit); sprites are drawn after the
  cells. A cell change therefore appears within two ticks in both files with no tearing.
* Boot state: every cell = font space (32), attribute = `BG_ATTR` (paper 7, ink 0), both files drawn.

## Game image header v1 (extends v0: same first 8 bytes, `$8008` onward)
```
$8008 DW  tileset_ptr     ; 0 = none.  Data: DB count (<=128), then count x (8 bitmap bytes + 1 attribute byte)
$800A DW  sfx_table       ; 0 = none.  DB count (<=8), then count x DW sfx_ptr; each sfx = records until terminator
$800C DW  map_ptr         ; 0 = none.  768 cell bytes (raw, tile bytes with bit 7 set as above) copied into CELL_TILE at boot
$800E ... code, data
```
(Sprite descriptors keep the v0 format; their last DW, "0" in v0, is now `hot`: 0 = whole sprite is the collision box,
else a pointer to `DB x, y, w, h`.) `init_entry` still runs after boot.
sfx record: 4 bytes `tone_lo, tone_hi|(vol<<4), noise|(mix<<5), 0`; terminator `tone_hi = $FF`. One record is played
per refresh on AY channel A (mix bits as AY register 7 for channel A: bit0 tone off, bit1 noise off; the third bit unused).

## Text
Current text attribute `V_TEXT_ATTR` (ink 0-7, paper 0-7, bright). Cursor row/col in `V_CUR_ROW`, `V_CUR_COL`.
| Routine | In | Meaning |
|---|---|---|
| `RT_AT` | B = row (0..23), C = col (0..31) | set the cursor (out of range values clamp) |
| `RT_PRINTS` | HL = address of a length-prefixed string (1 length byte, max 31 chars) | print at the cursor, advancing it; wraps to the next row at col 32; row 24 wraps to row 0 (no scrolling) |
| `RT_PRINTN` | HL = signed 16-bit value | decimal, leading `-` if negative, no padding |
| `RT_PRINTC` | A = character code | one character (also used for CHR$-style output later) |
| `RT_INK`, `RT_PAPER`, `RT_BRIGHT` | A = 0..7 / 0..7 / 0..1 | set parts of `V_TEXT_ATTR` |
| `RT_CLS` | - | all cells = space with the current text attribute's paper (ink 0 on paper `A`), cursor 0,0 |
Text uses the runtime's built-in 8x8 font for codes 32..127 (96 glyphs, 768 bytes in chunks 0-1; take the glyphs from the
Leap font in `~/2068-Leap/kernel/graphics/` since Leap is the owner's own project, and say which file).

## Tiles
| Routine | In | Out | Meaning |
|---|---|---|---|
| `RT_TILE` | A = tile index (0..127), B = row, C = col | - | set the cell to game tile A with that tile's attribute |
| `RT_TILEAT` | B = row, C = col | HL = tile index, or -1 if the cell holds a font character | read a cell |
Out-of-range row/col: `RT_TILE` ignores, `RT_TILEAT` returns -1.

## Collision and sound
| Routine | In | Out | Meaning |
|---|---|---|---|
| `RT_HIT` | A = sprite a, E = sprite b | HL = 1 if both visible and their collision boxes overlap, else 0 | box test on `SPR_TAB` positions |
| `RT_PLAY` | A = sfx index | - | start effect (replaces the one playing); ignores bad indices |
| `RT_SILENCE` | - | - | stop; AY channel A volume 0 |
Sound is driven from the frame interrupt (cost added to the ISR must stay under 120 T; the ISR's register rules and
the `V_SYNC` handshake are unchanged). `V_SFX_ACTIVE` (byte) is 1 while an effect plays.

## State the tests read (add to runtime.json)
`CELL_TILE`, `CELL_ATTR`, `V_TEXT_ATTR`, `V_CUR_ROW`, `V_CUR_COL`, `V_SFX_ACTIVE`, `AY_SHADOW` (16 bytes: what the sound
code last wrote to AY registers), plus the v0 symbols.

## Language semantics (both compiler and interpreter)
`PRINT [AT r, c;] item {; item}`: items are string literals, `STR$(n)` / numeric expressions (printed in decimal),
separated by `;` or `,` (a comma prints one space in v0); with a trailing `;` the cursor stays, otherwise it moves to
the start of the next row. `AT` without PRINT is not a statement. `INK n`, `PAPER n`, `BRIGHT n`, `CLS`, `TILE x, y = t`
(x column 0..31, y row 0..23), `TILEAT(x, y)`, `HIT(a, b)` with sprite names, `PLAY sfxname`, `SILENCE`. No string variables
yet. The reference interpreter keeps a cell map and the AY-effect state and exposes them per tick for comparison.

## As built (M3, 2026-11-09)
Source `arcade/runtime/v1/` (v0 untouched), build `node arcade/tools/build-runtime-v1.mjs` -> `arcade/build/v1/` (`runtime.json` with `"version": 1`,
`runtime.bin`, `runtime.inc`, `.sym`, `.lst`, `runtime.dck`; the tool also exports `assembleGame`, `linkGame`, `dckOf` like v0's). Tests:
`arcade/tests/m3-runtime.mjs` (boot, header, picture), `m3-runtime-text.mjs` (every routine vs a JS model, RT_HIT), `m3-runtime-sound.mjs`,
`m3-runtime-regs.mjs` (interrupt injection), `m3-runtime-perf.mjs` (T-states), `m3-mutations.mjs` (29 deliberate bugs, all killed). Test game:
`arcade/runtime/v1/test_script.asm`, a script interpreter whose script, tileset, sfx and map are data written by the test.
**Sizes:** runtime 3,450 of 16,384 bytes in DOCK chunks 0-1 (code 2,682, font 768). RAM chunk 6 is full by design (map in `layout.inc`): ROW_TAB `$C000`,
PHASE_TAB `$C200-$CDFF`, CELL_TILE `$CE00`, CELL_ATTR `$D100`, DIRTY0 `$D400`, DIRTY1 `$D500` (96 bytes each), TILE_ATTR `$D600`, GLYPH_TAB `$D800-$DFFF`;
about 800 bytes free in three pieces. Chunk 7 as v0 ($E100-$EFFF compiled variables, canary `$F000`, stack to `$FF00`); the new runtime variables sit in
`$E014-$E0AD` (`V_HOFF`, `V_TEXT_ATTR`, `V_CUR_ROW/COL`, `V_SFX_ACTIVE/PTR`, `SPR_HOT` `$E060`, `AY_SHADOW` `$E070`, scratch `$E080+`).

**Cell map and drawing.** Boot clears both display files (pixels 0, attributes `$38`) and fills the map with 32 / `$38`: that already is "both files drawn".
A `map_ptr` is copied at boot (a tile cell gets its tile's attribute, a font cell `$38`) and marks every cell dirty in both files, so the first two ticks
draw it (blank until the first flip, ~14 refreshes for a full screen: the first tick draws 768 cells). Tick order: erase sprites (bitmap rows of the covered
cells redrawn from the map, in the file's own record of where each sprite was), `frame_entry`, redraw the cells dirty for this file, draw sprites, request the
flip. A cell set to the value and attribute it already holds marks nothing dirty. Sprites never change attributes, so the erase redraws bitmaps only. Cell value
0..31 and 127 are blank (Leap's font has no glyph for 127; 128+ in a cell is a tile). GLYPH_TAB is stored as 8 planes (row k of glyph v at `GLYPH_TAB + 256 k + v`).
**Font:** the 95 glyphs of `FONT_TABLE` in `~/2068-Leap/kernel/graphics/graphics.asm` (the Leap V2 font, as of commit `2609b12`), extracted by
`arcade/tools/gen-font.mjs` into `arcade/runtime/v1/font.inc`; the test reads `font.inc`, not the Z80 build.

**Text and tiles, as built.** `RT_AT`: B, C are bytes; above 23 / 31 they clamp to 23 / 31. `RT_INK/PAPER` AND 7, `RT_BRIGHT` uses bit 0. `RT_PRINTC`: code AND `$7F`
(a code >= 128 prints the font character, never a tile). `RT_PRINTS`: a length above 31 is read as 31. The cursor wraps as soon as a character is printed in
column 31 (so `V_CUR_ROW/COL` are always in range); row 24 wraps to row 0. `RT_PRINTN`: `-32768` prints `-32768`. `RT_CLS`: attribute = `V_TEXT_ATTR AND $38` (the paper;
ink 0, no bright, no flash), only changed cells are marked dirty. `RT_TILE`: tile AND `$7F`; an undefined tile (>= the tileset's count) is a blank glyph with attribute `$38`.
**Header:** tile count above 128 is read as 128; `sfx_table` count above 8 as 8; a null pointer (table or effect) means none; `sprite_count` above 4 as 4 (v0).
**`RT_HIT`:** the box of sprite i is `[x + hx, x + hx + hw) x [y + hy, y + hy + hh)` with the sprite's `SPR_TAB` position; no hot box = `(0, 0, 16, height)`;
strict overlap of the half-open intervals (touching does not hit); a box with `hw` or `hh` = 0 never hits; an index >= `sprite_count` or a hidden sprite gives 0.

**Sound, as built.** Effect = records until one whose BYTE 1 is `$FF` (so tone_hi 15 with volume 15 cannot be written; use volume 14). Registers written, in this order,
only when different from `AY_SHADOW`: R0 = tone_lo, R1 = tone_hi AND 15, R6 = noise AND 31, R7 = `%00110110` | mix bit 0 (tone A off, R7 bit 0) | mix bit 1 << 3 (noise A off,
R7 bit 3), R8 = vol. Channels B and C stay off and R7 bit 6 stays 0 (the joystick port stays an input). Boot zeroes AY registers 0..15 exactly as the Leap
cartridge's `CART_COLD_START` does (R7 = 0 at boot; the first record writes it). `RT_PLAY` ignores a bad index, a missing table and a null pointer; it writes the pointer
with one instruction before setting `V_SFX_ACTIVE`. `RT_SILENCE` clears `V_SFX_ACTIVE` first, then writes R8 = 0 only if the chip is not silent. The effect ends one refresh
after its last record (the terminator is read at the next interrupt). **`RT_STICK` now brackets its AY access with DI ... EI** (the sound tick selects AY registers too;
an interrupt between select and data access would redirect it); it therefore returns with interrupts enabled, which compiled code has anyway.
**Deviation: the 120 T bound for the added ISR cost is NOT met.** Measured on TSRun (whole interrupt, flip included): idle 164..183 T (v0 156 T; +27 T for the check `LD A,(V_SFX_ACTIVE) / OR A / JP NZ`);
with an effect playing 399..765 T: 399-591 T when no register changes or one does, 658 T for 2 writes, +35 T per further write, 763 T for 5 writes (0.7 to 1.3 % of a refresh). Reasons: the
tick must preserve BC, DE, HL (63 T), fetch and advance the pointer (77 T), and test five registers against `AY_SHADOW` (23..77 T each); each AY write is 36 T of OUTs alone,
so even the ideal per-register-compare design cannot be under 120 T for two changed registers. The flip and the frame counter come first, so the cost never delays them.
What would meet it: `RT_PLAY` expands the effect (up to ~96 records in the free 384 bytes at `$D680`) into a delta list "n, n x (register, value)" in RAM, the interrupt then costs
about 110 T for a refresh with no change and +48 T per register write; the price is a copy cost in `RT_PLAY` (~120 T per record) and the cap. Not done; decision for the owner.

**T-states** (TSRun, `m3-runtime-perf.mjs`; a refresh is 58,688 T): `draw_cell` 333 T; erase of a cell 209 T (bitmap only); `redraw_dirty` clean 1,339 T, 460 T per cell for contiguous cells
(716 T scattered one per dirty byte); `RT_PRINTC` 466 T changed / 298 T unchanged; `RT_PRINTS` 553 / 385 T per character; `RT_PRINTN(12345)` 3,508 T; `RT_TILE` 402 / 234 T; `RT_CLS` 69,254 T
(58,454 T on a clear screen: 1 refresh); `RT_HIT` 1,770-1,890 T for two visible sprites (128 T for a bad index); `RT_TILEAT` 182 T. A character costs its call (466 T) plus one redraw in each file (2 x ~430 T), in two consecutive ticks. Tick overhead with a full
screen of text and nothing changing: 1,750 T (3 % of a refresh). Tick of 4 sprites over a full screen of text, all moving, worst alignment (9 cells each): avg 27.6k, max 28.3k T (48 % of a refresh, ISR excluded);
with a score of 12 changing characters and 2 tiles per tick also: max 44.7k T (76 %); both fit in one refresh at `frame_div` 1. Printing a whole screen of text in one tick (768 characters)
takes 789k T (13 refreshes; the other file another 349k T): do that between scenes; the overrun is safe (no tearing, the last complete picture stays).

## Decision on the sound-tick cost (2026-11-09, accepted as built)
The 120 T bound above was a guess. As built, the tick adds 27 T with no effect playing and 235-580 T while one plays
(ISR total 399-765 T, about 1.3 % of a refresh). The flip and the frame counter run **before** the sound tick, so the
longer handler cannot delay the flip or tear. The accepted bound is: ISR total under 800 T with sound active, flip
within the first 100 T. A pre-expanded delta list (about 110 T quiet, 48 T per write) is the known optimisation if a
game ever needs the time; not built.
