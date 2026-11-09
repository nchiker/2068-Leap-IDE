# Scroll spike: what smooth horizontal tile scrolling costs on the TS2068 (2026-11-09)

Question: a platformer needs a world map wider than the screen and a camera in **pixels**. What does it cost per
tick to draw the visible 32x24 cells at pixel offset `camera_x mod 8`, and which design is cheapest for 15 to 20 fps?

Measured on TSRun (58,688 T per refresh, **no contention** modelled, so real hardware may be slower on `$4000-$7FFF`),
code at `$8000`, `DI`, the routine entered by a `CALL` from the harness, T-states exact (`m.tstates` from the call
to the final `RET`, both included). Every variant's screen was compared byte for byte (6,144 bitmap bytes and 768
attributes) with a JS reference renderer (`refRender` in `lib.mjs`) at 20 to 83 camera positions, the edges (0, 767,
768) and all eight phases included; **all 20 variant runs match, 0 mismatches** (`all-output.txt`). Means are over
**64 consecutive pixel positions** (cam 200..263 = 8 full phase cycles; V1's cost depends only on the phase, so its
mean is over the 8 positions of one cycle; for V4 and V5 the ticks are a real sequence, each starting from the previous result). No SP trick, no `DI` need, no self-modifying code in any
variant (they use `EXX`, `EX AF,AF'`, `IX`, `IY`: the frame interrupt handler must preserve those if it uses them).

Reproduce: `node run-scroll.mjs` (all, writes `results.json`), `node run-scroll.mjs v2 v3 v2b v4 v5 v1`, then
`node fits.mjs` for the refresh tables. Needs `sjasmplus` (`/usr/local/bin/sjasmplus`); the harness is a copy of
`../native/run-native.mjs` in spirit (TSRun, `DI`, exact `m.tstates`) but calls routines instead of running to a marker.

## The world and the screen convention (identical in the reference and all variants)

* World map 128 x 24 cells, one byte per cell holding **tile*8** (so a tile pointer is the map byte; at most 32 tiles
  per 256-byte table page), stride 128 so a row never crosses a page. 32 distinct tiles of 8 bytes, each with one
  attribute byte. `CAM` 0..768, `col0 = CAM>>3`, `p = CAM&7`.
* Screen byte (row y, column c) = `(T[m[c]+r] << p | T[m[c+1]+r] >> (8-p)) & $FF`, r = y&7, m[c] = map cell
  `col0+c`. Attribute at screen cell c = attribute of tile `m[c]` (the attribute does **not** move with the pixel
  phase: it changes in 8-pixel steps, bitmap every pixel). Three map worlds: `dense` ("mixed": 60 % of the 768 cells
  have a blank cell and a blank right neighbour), `level` (a plausible platformer: open sky, features, platforms,
  ground; 70 to 76 % blank pairs) and `solid` (no blank cell: the worst case for the blank path).

## Summary (T-states; a refresh is 58,688)

| Variant | Bitmap mean / worst | + attributes | Code (B) | Table RAM | Notes |
|---|---:|---:|---:|---:|---|
| V1 naive per-byte shift, 32x24 | 715,402 / 804,106 | 29,104 (as V2) | 202 | none | 116 T per byte; 12 to 14 refreshes |
| **V2 pre-shifted tables, 32x24** | **216,236 / 224,966** | 29,104 | 3,236 (all incl. init) | 4,096 B (3,584 used) | phase 0 is a copy: 155,126; phases 1..7: 224,966 |
| V2 + blank-cell path, 32x24 | 167,848 mixed / 155,773 level / 234,092 solid (worst 173,482 / 160,890 / 243,014) | 29,104 | 4,708 | 4,096 B | data dependent, see below |
| V3 32x16 | 144,239 / 150,060 | 19,449 | | | window = 512 cells |
| V3 28x20 | 158,213 / 164,588 | 21,637 | | | 560 cells |
| **V3 24x16** | **109,007 / 113,388** | 15,225 | 2,488 | 4,096 B | 384 cells; +blank (level) 72,319 / 76,057 |
| V3 20x14 | 80,000 / 83,204 | 11,491 | 2,114 | 4,096 B | 280 cells; +blank 53,161 / 56,168 |
| V3 16x12 | 55,398 / 57,604 | 8,285 | 1,740 | 4,096 B | 192 cells; +blank 36,824 / 38,324 |
| V4 shift 1 px, 2 files (copy from the shown file) | 188,182 / 188,182 | tick mean 192,563, worst 207,025 | 640 | 192 B | exactly 1 px per tick |
| V4 shift 1 px, 1 file in place | 144,073 / 144,073 | tick worst 162,916 | (same) | 192 B | single buffer only (tears) |
| V4 shift 2 px per tick, 2 files | tick mean 341,017 / worst 351,098 | included | | | cost grows with the speed |
| V5 full redraw, cell-granular | 153,481 | 29,125 | 2,410 | none | 195 T per cell |
| V5 8-px step per file: shift (LDI) + strip + attributes | 108,318 + 7,082 + 19,410 = **134,810** | included | | none | LDIR shift: 139,038 instead of 108,318 |

"Table RAM" is the pre-shifted tables for 32 tiles: 8 phases x (left part 256 B + right part 256 B) = 4,096 B (16
tiles: 2,048 B; phase 0 is never read, so 3,584 B are really needed). The tables depend only on the tile set, so the
**compiler can emit them into the cartridge ROM** (4 KB of the 32 KB budget, 0 B of RAM); building them at boot with
`build_tables` costs 370,814 T (6.3 refreshes, a naive byte loop; once, not per frame).

## V1: naive per-byte shifting (`v1.asm`)

For each of the 192 pixel rows and 32 columns: map byte -> tile row byte (`ld a,(de); inc e; add a,c; ld l,a; ld a,(hl)`),
rotated by the phase with a computed jump into a chain of seven `RLCA` (`jp (iy)`, 4 T per bit), combined with the
previous column's rotated byte by `((ra xor rb) and M) xor rb`, store, loop. About 99 T + 4p per byte, 116 T mean.
The bitmap alone is 12 to 14 refreshes. A strawman: it shows that doing the arithmetic per byte per frame is out.

## V2: pre-shifted tile tables (`v2.asm`)

* **Tables:** `LTAB[p][tile*8+r] = (tile[r] << p) & $FF`, `RTAB[p][tile*8+r] = tile[r] >> (8-p)`, one 256-byte page
  each, 8 phases: 4,096 B. A screen byte is `LTAB[m[c]+r] OR RTAB[m[c+1]+r]`: two table loads and an OR.
* **Cell-major, 8 rows unrolled, boustrophedon:** HL = left table pointer, DE = right table pointer, BC = screen
  pointer, IX = map row. A row is `ld a,(de); or (hl); ld (bc),a; inc l; inc e; inc b` = **33 T** (7+7+7+4+4+4); the
  8th row has no increments, so a cell is 252 T. Cells alternate direction (cell c up, cell c+1 down: `dec l; dec e;
  dec b`), so the next cell's left pointer is simply the previous right pointer (`ld l,e`) and nothing is reset;
  the odd cells need `or 7` on the new right index. Setup between cells 31 to 38 T (one `ld a,(ix+n)` at 19 T). All 32
  columns unrolled (1.7 KB per path). 35 T per byte overall.
* **Phase 0** takes a separate copy path (`COPY_UP/COPY_DN`: `ld a,(hl); ld (bc),a; inc l; inc b`, 22 T per row, no
  right table): 155,126 T.
* **Attributes** (`render_attr`): `ld a,(hl); inc l; ld c,a; ld a,(bc); ld (de),a; inc e` = 33 T per cell, 29,104 T
  for 768 cells. Needed only when `col0` differs from what the *hidden* file holds (two ticks old): a fraction
  `min(1, s/4)` of the ticks at s px per tick. A pre-expanded attribute map in ROM (3 KB) would turn it into a
  32-byte `LDI` row copy, about 13,000 T for the screen.
* **Stateless:** the whole window is repainted from the map every tick, so **both display files need no bookkeeping**
  (the hidden file's age does not matter) and **sprites inside the window need no erase** (saves about 34,800 T of
  the runtime's 106k for 16 sprites).
* **Blank-cell path (`-DBLANK`):** if a cell and its right neighbour are both tile 0 (`ld a,l; or e; jr nz`), the
  cell is 8 stores of zero (about 150 T with setup instead of 290). Costs 18 to 25 T on every other cell. Result:
  mixed world 216k -> 168k, level world 216k -> 156k (-28 %), solid world 216k -> 234k (+8 %, the worst case). The
  win depends on the level: designers must know that open sky is cheap. It also changes with the window position.
  Not done: skipping rows that are blank in both files (needs sprite dirty tracking, since a sprite makes a blank
  row non-blank in that file).

## V3: windows

V2 with `NC x NR` cells at screen cell (`WX`,`WY`) (assembled with `-DNC -DNR -DWX -DWY`): the cost is linear in
the cell count (about 282 T per cell mean, 293 worst), the code shrinks, nothing else changes.
The remaining screen (HUD, border art) is static and costs nothing. The table lists 32x16, 28x20, 24x16, 20x14, 16x12
(the windows asked for plus two bigger ones). Windows were centred; the reference compares the window and checks the
rest of the file is untouched.

## V4: shift the drawn screen one pixel, draw the new column (`v4.asm`)

* **New column:** pixel 255 of the new camera is bit `(p+7)&7` of tile column `col0+31` (+1 if p<>0). Pass 1 gathers
  the 192 masked bits into `STRIP` (192 B), pass 2 uses each as the *carry in* of the right-most byte.
* **Shift with the carry chain:** `scroll1` copies from the shown file into the hidden one: `ld a,(hl); rla; ld (de),a;
  dec l; dec e` x 32 per row = 26 T per byte, right to left so the carry runs the right way. `scroll1_inplace`
  (`rl (hl); dec l`, 19 T per byte) is the single-buffer case. Per-row bookkeeping and the strip add about 28k T to the
  copy version (an unrolled version might reach about 175k).
* **Both display files:** the hidden file is two ticks old, so it cannot be shifted in place by one pixel; the
  correct flow is *copy-shift from the shown file* (that is `scroll1`). In place on the hidden file would be two chain
  passes (38 T per byte). Attributes: when `col0` changed this tick, `attr_shift` (LDIR of 767 B + the new column,
  18,843 T); when it changed on the previous tick, `attr_copy` (LDIR 768 B, 16,205 T); else nothing. Tick mean with
  attributes 192,563, worst 207,025.
* **2 px per tick** = `scroll1` with CAM-1 then `scroll1_inplace` with CAM: 341,017 mean, 351,098 worst. The cost is
  linear in the speed; V2 is flat.
* **Trap: sprites.** The shifted copy carries the sprites that were drawn on the shown file. They have to be erased
  (cell background restored) at their shifted positions before they are redrawn, so V4 keeps the full 106k sprite cost
  and needs the sprite bookkeeping of the old frame. V2/V3 do not.
* The SP-trick version (`pop`/`rl`/`push` in 12-byte chunks held in BC DE HL BC' DE' HL', 21.5 T per byte by
  estimate, 13.5 T per byte for whole-byte moves) needs `DI` for the whole 100k+ T pass and was not built: it would lose
  frames on TSRun (an interrupt arriving under `DI` is dropped) and gains 17 % at best.

## V5: cell-granular scrolling (`v5.asm`)

The camera moves in steps of 8 pixels; the phase is always 0.

* **Cell blitter** (own, data driven): `ld l,(ix+n); ld d,b` then 8 x `ld a,(hl); ld (de),a; inc l; inc d` = 195 T
  per cell. **Full redraw** of 768 cells: 153,481 T (+ 29,125 attributes). A threaded, compiled-tile blitter
  (B2 in `../native/`, 126 T per tile) needs `DI`, so it was not used; with it a redraw would be about 100k T (estimate).
* **Step:** move the bitmap left by 8 pixels (31 bytes per row, 192 rows) and draw the new column of 24 cells
  (7,082 T). Unrolled `LDI` (16 T per byte, with 40 T per row to step the pointers): **108,318 T**; `LDIR` (21 T per
  byte): 139,038 T. Attributes: LDIR 767 B + new column: 19,410 T. **One step on one file: 134,810 T.**
* **Both files:** the step must be done on each file: tick 1 copy-shifts the shown file into the hidden one (it
  becomes shown), tick 2 shifts the other file in place (same cost; verified for 8 steps, both files full screen).
  So a step is 2 ticks of about 135k each, then the ticks until the next step cost nothing but sprites. The average
  cost per tick at a scroll speed of v px per tick is `2 x 134,810 x v / 8` = 33.7k x v, but the worst tick is the full
  135k, and a refresh count is set by the worst tick.
* The scrolling is visibly stepped (8 px at once): at 15 fps with a step every 2 ticks that is 60 px/s in
  jumps of 8 px.
* The same sprite trap as V4 (the shifted screen carries sprites; erase and redraw needed).

## Which design fits what (min refreshes per tick; fps = 60.1 / refreshes)

Worst tick = bitmap worst + the attribute work of a cell-step tick. Sprites: 16 sprites erase+draw = 105,903 T
(`docs/ARCADE_RUNTIME_API_V2.md` worst case), 6 sprites = 39,714 (scaled). For V1/V2/V3 the last two columns assume
no erase (background repainted anyway: 16 sprites 71,103, 6 sprites 26,664). The game's own logic is **not** in
these numbers: leave 10 to 25k.

| Variant | Worst tick T | Fits 1/2/3/4 refreshes, scroll alone | Fits 1/2/3/4 with 16 sprites, +105,903 as asked | Min refreshes with 6 sprites (fps) | Min with 16 sprites (fps) |
|---|---:|---|---|---|---|
| V1 naive 32x24 | 833,210 | - / - / - / - | - / - / - / - | 15 (4) | 16 (4) |
| V2 tables 32x24 | 254,070 | - / - / - / - | - / - / - / - | 5 (12) | 6 (10) |
| V2 + blank, level world | 189,994 | - / - / - / yes | - / - / - / - | 4 (15) | 5 (12) |
| V3 32x16 | 169,509 | - / - / yes / yes | - / - / - / - | 4 (15) | 5 (12) |
| V3 32x16 + blank (level) | 118,451 | - / - / yes / yes | - / - / - / yes | 3 (20) | 4 (15) |
| V3 28x20 | 186,225 | - / - / - / yes | - / - / - / - | 4 (15) | 5 (12) |
| V3 28x20 + blank (level) | 136,299 | - / - / yes / yes | - / - / - / - | 3 (20) | 4 (15) |
| **V3 24x16** | 128,613 | - / - / yes / yes | - / - / - / yes | **3 (20)** | 4 (15) |
| V3 24x16 + blank (level) | 91,282 | - / yes / yes / yes | - / - / - / yes | 3 (20) | 3 (20) |
| V3 20x14 | 94,695 | - / yes / yes / yes | - / - / - / yes | 3 (20) | 3 (20) |
| V3 20x14 + blank (level) | 67,659 | - / yes / yes / yes | - / - / yes / yes | 2 (30) | 3 (20) |
| V3 16x12 | 65,889 | - / yes / yes / yes | - / - / yes / yes | 2 (30) | 3 (20) |
| V3 16x12 + blank (level) | 46,609 | yes / yes / yes / yes | - / - / yes / yes | 2 (30) | 3 (20) |
| V4 1 px, 2 files | 207,025 | - / - / - / yes | - / - / - / - | 5 (12) | 6 (10) |
| V4 2 px, 2 files | 351,098 | - / - / - / - | - / - / - / - | 7 (9) | 8 (8) |
| V4 1 px, 1 file in place | 162,916 | - / - / yes / yes | - / - / - / - | 4 (15) | 5 (12) |
| V5 step tick (8 px) | 134,810 | - / - / yes / yes | - / - / - / - | 3 (20) | 5 (12) |
| V5 full redraw | 182,606 | - / - / - / yes | - / - / - / - | 4 (15) | 5 (12) |

### Scroll speeds that are possible

| Refreshes per tick (fps) | V2 / V3 (any window that fits above) | V4 | V5 |
|---|---|---|---|
| 2 (30 fps) | 1 to 8 px per tick = 30 to 240 px/s, window up to 16x12 with 6 sprites (20x14 with none) | no | no |
| 3 (20 fps) | 1 to 8 px per tick = 20 to 160 px/s, window up to 24x16 (32x16 with blank cells) | no | 8-px steps, at most one step per 2 ticks (80 px/s), 6 sprites |
| 4 (15 fps) | 1 to 8 px per tick = 15 to 120 px/s, window 28x20 or 32x16, 16 sprites in 24x16 | exactly 1 px per tick = 15 px/s | 8-px steps, 60 px/s, 6 sprites |
| 5 (12 fps) | any, window 32x24 with 6 sprites | 1 px per tick = 12 px/s | steps, 16 sprites |

V2/V3's cost does not depend on the speed (except that the attribute work is needed on a fraction `min(1, s/4)` of the
ticks at s px per tick: 1 px per tick every 4th tick, 4 px per tick or more every tick), so 2 px per 1/20 s (40 px/s)
and 2 px per 1/12 s are both fine; V4 only ever scrolls 1 px per tick.

## Recommendation

**V2's pre-shifted tables on a window (V3), repainted from the map every tick: 24x16 cells (192x128 px) at 3
refreshes per tick (20 fps), 1 to 8 px per tick.** Worst tick 128,613 (113,388 bitmap + 15,225 attributes when a cell
boundary is crossed); the player (16x24) and about 6 enemies cost about 27k without erase, so about 156k of the
176k available, 20k for the game logic. That is also the **cheapest design that scrolls every pixel**: no state
between ticks, no sprite bookkeeping for the shift, both display files trivially correct, 1 to 8 px per tick for the
same price. The tables (4 KB) go into the cartridge ROM, so the RAM cost is zero. If the level has open sky the
blank-cell path (+1.5 KB code) takes the same window to 91k and 16 sprites into 3 refreshes, or lets it grow to
28x20 / 32x16 at 20 fps (136k / 118k). At 15 fps (4 refreshes) 24x16 takes 16 sprites with 35k to spare, 28x20 or 32x16
take 6 sprites.

What does not pay: a full 32x24 repaint (254k worst, 5 refreshes = 12 fps, 4 only for a very open level with few
sprites and no spare for logic); V4 (only 188 to 207k, 1 px per tick, no cheaper than V2 at 32x24, and the sprite
erase/shift problem); V5 as the only mechanism (stepped 8 px; 135k per step tick, so 3 refreshes with 6 sprites at best).
V5 is the right fallback if the owner accepts 8-px steps and wants the full 32x24 playfield: at 4 refreshes (15 fps) it
fits 6 sprites with 60 px/s.

## Techniques and traps (what bit me)

* **`inc e` / `inc l` do not carry into D / H.** A row pointer in E that walks past `$FF` wraps silently; the attribute
  row code first lost the carry (fixed by restoring the row start with `sub NC` and adding 32 with a carry check).
  Screen rows are 32-aligned, map rows 128-aligned, so a *row* never wraps, but a pointer after the last cell can.
* **Flags:** `ex af,af'` swaps F as well, so a `ex af,af' / dec a / ex af,af' / jr nz` loop tests the wrong flags.
  `dec r` and `ld` keep the carry, so the V4 carry chain (`ld a,(hl); rla; ld (de),a; dec l; dec e`) works; `inc/dec rr`
  and `ld` never touch flags either. `add a,$FF` turns "nonzero" into carry.
* **Boustrophedon needs `or 7`:** a cell traversed downwards starts at row 7, so its table indices are tile*8+7;
  the blank-cell path has to leave E at 7 (up) or 0 (down) for the next setup. The blank test for a downward cell is
  `or e; cp 7`, not zero.
* **The phase-0 right table is all zero**, so phase 0 must be a copy path (155k against 225k), and the map read of
  column `col0+32` at the last camera position (768, where it would be column 128) must be harmless (it is: the right
  table is zero for p=0).
* **sjasmplus:** a `K DEFL ...` at column 0 makes `K` a label, so a following `.local` label becomes `K.local`
  ("Label not found: K.cr"); use global labels around DUP/DEFL counters. `DUP`+`IF` with a DEFL counter works for
  per-column code. A `jr` over a 32-cell unrolled body is out of range; use `jp`.
* **Tile table limit:** `tile*8` in one byte means 32 tiles per page; more tiles need a second page and a 16-bit map
  or a tile index byte multiplied by 8 per cell (adds about 20 T per cell, or a map of high bytes).
* **Real hardware:** none of this is verified on a TS2068; contention on `$4000-$7FFF` (if the SCLD has it) would
  slow every write to the display files, and V2/V3 write 6,144 (or the window's) bytes per tick at 7 T each.
* **Interrupts:** the numbers were taken with `DI` and no frame interrupt; the real tick has the runtime's ISR (137 T per
  refresh) and the flip. Nothing here depends on the stack except `CALL`/`RET` and a few `PUSH`/`POP` of data.
* **Sprites:** V2/V3 repaint the window every tick, so the sprite erase pass can be dropped for sprites inside the
  window (the runtime would need a "window mode"); V4/V5 keep it.

## Files

`lib.mjs` (world, reference renderer, harness), `run-scroll.mjs` (runs and checks everything), `fits.mjs` (refresh
tables from `results.json`), `common.inc` (memory map), `v1.asm`, `v2.asm` (V2, V3 and the blank path),
`v4.asm`, `v5.asm`, `all-output.txt` (the last full run), `results.json`.
