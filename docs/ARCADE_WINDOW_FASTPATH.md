# Leap Arcade: the window's blank-cell fast path and colour-clash option 2 (runtime v3), contract, 2026-11-11

Item 3 of `docs/ARCADE_SPACE_PLAN.md` section 4, together with option 2 of the colour-clash comparison (owner's choice, 2026-11-11; images:
https://claude.ai/artifact/UUC4r2kBz4H3aExJHviXNM). Branch `arcade-window-fastpath` from `main` `0e6f777` (PR #8 merged). Binding for the runtime
work; the "As built" section is added when it is done. Runtime v3 only (`arcade/runtime/v3/`); v2 and v4, the compiler and the language do not
change.

## 0. Why

The worst tick of the platformer perf run is 174,919 of 176,064 T since Part C of batch 6 (the attribute pass now falls on a shifted-bitmap tick).
`window_repaint` costs the same whatever the world holds (about 290 T a cell, 384 cells), so a sky-heavy world pays full price for cells that are
blank. The scroll spike measured -28 % on a platformer-like world with a blank-cell path. Option 2 (no wrongly black pixels at all) changes the
pixels of cells whose two tiles have different colours; it needs the same per-cell decision, so both are done together, and the time the blank
path saves pays for it.

## 1. The picture (binding)

A window cell at band position `pos` (`p = pos AND 7`, `col0 = pos >> 3`), window column `c`, shows tiles `A = m[col0 + c]` and
`B = m[col0 + c + 1]` (`m` = the band's world row, tile numbers). `attr(t)` is the tile's attribute byte (the whole byte: ink, paper, bright,
flash), `LTAB[p][t]` / `RTAB[p][t]` the compiler's pre-shifted tables (the right `8 - p` pixels of the cell come from A, the left `p` from B),
`TILEROWS[t]` the tile's rows.

| Case | Bitmap byte of row r | Attribute |
|---|---|---|
| `p = 0` | `TILEROWS[A][r]` (unchanged) | `attr(A)` (unchanged) |
| `p <> 0`, `attr(A) = attr(B)` | `LTAB[p][A][r] OR RTAB[p][B][r]` (unchanged) | Part C: `attr(A)` if `p < 4`, else `attr(B)` (unchanged) |
| `p <> 0`, `attr(A) <> attr(B)`, `p < 4` | `LTAB[p][A][r]` (**new**: B's pixels dropped) | `attr(A)` |
| `p <> 0`, `attr(A) <> attr(B)`, `p >= 4` | `RTAB[p][B][r]` (**new**: A's pixels dropped) | `attr(B)` |

In words: when the two tiles' colours differ, the cell shows only the pixels of the tile whose colours it has (the one covering at least half of
it); the other tile's part of the cell is paper. Every ink pixel in the window is then drawn in its own tile's colours. The visible cost: an edge
between differently coloured tiles sits up to 4 pixels from its true place (the owner saw this as option 2). Everything else is unchanged: the
cell map outside the window, sprites (still in the colours of the cell under them), ring repair, collision, `WORLDTILE`, the attribute caches.

**Blank tiles.** A tile is blank when its 8 rows (`TILEROWS[t]`) are all zero (any tile number, not only tile 0). A cell whose A and B are both
blank is 8 zero bytes under every rule above; the fast path (section 3) produces them without the table reads. This is a speed rule, not a
picture rule.

## 2. Class bits in WORLD_RAM (binding: the tests check them)

`WORLD_RAM` bytes were `tile * 8` with bits 0-2 always zero. They become `tile * 8 + class`, the class saying what the repaint must do with the
cell whose RIGHT tile is this byte. For row `r`, column `y` (`t(y)` = the tile at y, `blank(t)` as in section 1, `W` = `world_w`):

| Bit | Name | Value |
|---|---|---|
| 0 | `S_y` special | `D_y OR (blank(t(y - 1)) AND blank(t(y)))`; 0 for `y = 0` |
| 1 | `D_y` colours differ | `attr(t(y - 1)) <> attr(t(y))`; 0 for `y = 0` |
| 2 | `P_y` pair | `S_y OR S_(y + 1)` for `y <= W - 2`; `S_(W - 1)` for `y = W - 1` |

Columns `y >= W` (beyond the world) keep bits 0-2 zero. All 16 rows are classified (rows below the map's height hold tile 0 like any other).
`S_y` / `D_y` describe the cell with `A = y - 1`, `B = y`; `P_y` says "the cell with `A = y - 1` or the one with `A = y` is special", so one test
covers two cells (section 3).

* **Kept exact** after every world decode (`window_boot`, `RT_WORLDLOAD`: after the decode, and for a banked world after the bank window is
  unmapped again: the class pass reads the tables at `$5C00`-`$5EFF`, under the bank window) and after every `RT_SETWORLD` (the bytes `x - 1`,
  `x`, `x + 1` of that row that are inside the world, x = the changed column).
* **Every reader keeps working with the raw byte:** the attribute page (`W_ATTRT`, `$5C00`) and the flags page (`W_FLAGT`, `$5D00`) hold each
  tile's value at all 8 bytes `8t .. 8t + 7` (written by `window_boot`; today only `8t`). `RT_WORLDTILE` already shifts the byte (`>> 3`).
  `attr_rows`, `RT_TILEFLAGS`, `RT_TILEHIT` and `RT_SETWORLD` index the pages with the raw byte. The repaint's row loops mask where they
  must (the first cell of a row, the phase-0 path's upward cells).
* **The reference interpreter's WORLD_RAM has no class bits.** Tests that compare the machine's WORLD_RAM with the interpreter's compare
  `byte AND $F8` (`tests/arcade-m10-differential.mjs`, `tests/arcade-m11-differential.mjs`, any other that compares it); the class bits are
  checked against their own model (section 6).
* A per-tile blank page is allowed at `$5E00-$5EFF` (`W_BLANKT`, the blank flag of tile t at `8t .. 8t + 7` or as the engineer needs), written
  by `window_boot` in window mode only. `$5F00-$5FFF` stays free. The memory test's free areas follow.

## 3. The repaint (the method; the engineer may improve it, the numbers of section 4 are binding)

`rows_pn` (phase <> 0) keeps its shape: cell-major, 24 cells unrolled, boustrophedon, one world byte loaded per cell. At every second cell (the
upward cells, whose world byte `A + 1` is loaded with `ld e,(ix+d)`), test `P` of that byte (`bit 2,e` / `jp nz,stub`): **a clear P means both
cells of the pair are ordinary**, and since `P = 0` implies `S = D = 0` the byte is a clean index (no masking on the ordinary path). The first
cell of a row needs its A masked (`and $F8`). The ordinary path therefore pays about 18 T per two cells.

A set P jumps to that pair's stub (one per pair position, out of line), which does each of its two cells through shared handlers:
* `S = 0`: the ordinary OR cell (`SC_UP` / `SC_DN`);
* `S = 1, D = 0`: both tiles blank: 8 zero stores;
* `S = 1, D = 1`: one table only: `LTAB[p][A]` when `p < 4`, else `RTAB[p][B]` (8 loads and stores, cheaper than the OR); a blank kept tile
  may be 8 zero stores.

Each handler leaves L, E (and B, C) exactly as the inline cell would, so the next cell continues unchanged (an upward cell ends with E = `8B + 7`,
a downward one with E = `8B + 0`; the class bits must not leak into the next cell's index).

`rows_p0` (phase 0, a copy of A) masks its upward cells' bytes (`and $F8`); a blank fast path there is optional (phase-0 ticks are the cheap
ones). `attr_rows` is unchanged (the pages are replicated).

**Classification pass** (after a decode): right to left along each row, so `P_y` uses the `S_(y + 1)` just computed.

## 4. Numbers (TSRun, direct calls as `arcade/tests/m7-runtime-perf.mjs` section 1 unless stated; binding unless marked "report")

| What | Bound |
|---|---|
| `window_repaint` worst, every band's attributes included, every camera, both files, on EVERY world of the test set below | 1 band <= **130,000**; 3 bands 2/3/11 <= **132,000**; 4 bands 2/4/6/4 <= **135,000** (the platformer contract's budgets, now for every world, not only one) |
| The same, bitmap only, 53 % sky world (random tiles, `randomWorld` sky 0.53) | mean at least **15 % below** today's (report today's and the new) |
| The contract's tick (`m7-runtime-perf.mjs` section 3, every world it uses) | <= 176,064 (as now) |
| `tests/arcade-m6-platformer-perf.mjs` (three recorded runs) | ticks over budget not more than today's; worst and mean reported (today's in section 7) |
| Leap Runner (`arcade/examples/runner.arc`, the recorded play-through) | worst tick that is not a world load **below 173,167** (today's); report worst, mean, ticks over budget |
| Classification of a world | <= 80 T per cell of the world (16 x `world_w`) on top of today's decode; report the full world load |
| `RT_SETWORLD` | <= 1,000 T (today 113..596) |
| `window_repaint` at phase 0 | <= today's + 2,500 T |
| v3 free bytes (builder's figure, today 2,033) | >= **600** after |

**Amended 2026-11-11 (owner's decision, after the first build).** The method of section 3 meets the bounds on ordinary and sky worlds and on the
real games (Leap Runner's worst non-load tick 173,167 -> 158,342, the platformer's worst 174,919 -> 160,199) but not on worlds where most neighbouring
tiles differ in colour: a cell of differing colours costs about what an ordinary inline cell does (stub, call and dispatch eat the cheaper
one-table copy), so such a world pays the pair test on top. Measured (direct calls, 1 / 3 / 4 bands): stripes of two colours (d) 137,009 / 138,619 /
139,150; solid with random colours (b) 134,026 / 135,926 / 136,811; the contract's tick on (b) 176,459. The only faster method found needs about
1 KB more (875 bytes are free). The owner chose to keep option 2 and the fast path, with the bounds restated as follows (they replace the first
three rows of the table above):

| What | Bound |
|---|---|
| `window_repaint` worst, direct calls, worlds without dense colour boundaries (a, c, f, g) | 1 band <= 130,000; 3 bands <= 132,000; 4 bands <= 135,000 |
| The same, worlds of dense colour boundaries (b, d, e) | <= 140,000 / 141,000 / 142,000 (about +10 % over the pre-change 124,641 / 126,433 / 127,301; documented, not a target) |
| In a running game (section 2 of the perf test, the interrupt included), world a | <= 131,000 / 133,000 / 135,000 (measured 130,458 / 132,371 / 133,322: the ordinary world is 0.4 % over the old 130,000 when the interrupt is counted) |
| The same, worlds b and d | <= 140,000 / 141,000 / 142,000 |
| Bitmap-only mean on Leap Runner's four worlds (g) | at least 12 % below the pre-change mean of the same layout (measured 13-16 %); the 53 % sky random world (c) is reported only (its random colours make most cells differ: -1 %) |
| The contract's tick on worlds 53 % sky, one attribute (a), sky over ground (f) | <= 176,064 measured; on (b) <= 177,000 (measured 176,459); "with the worst repaint" reported only |

A world load (decode + class pass) of Leap Runner costs about 370,000-381,000 T (before: 228,000-238,000): about 2.5 frames more at a level start.

**The world test set** for the first row: (a) solid, one attribute: tiles 1..31 with random bitmaps and the SAME attribute, no blank tile (every
cell ordinary: the new worst case for the inline test); (b) solid, random attributes (today's "solid": nearly every cell differs); (c) 53 % sky
random (today's); (d) stripes of two attributes, two columns each (`b1 b1 b2 b2 ...`: ordinary and differing cells alternate, every pair goes
through a stub: the worst case for the stubs); (e) the same with one-column and three-column stripes; (f) sky over a solid ground (rows 0-9 tile
0, rows 10-15 one attribute); (g) the platformer's world and Leap Runner's four worlds with their own tiles. A world that breaks a bound is
reported with its numbers before anything else is changed (the engineer does not weaken a bound).

## 5. Byte identity and the published runtime

The compiler does not change: every compiled game is the same bytes. The runtime's addresses after the changed code move, so the hash baselines are
regenerated with `node arcade/tools/regen-baselines.mjs --old 0e6f777` (it cross-checks old and new compiler first). `node
arcade/tools/publish-runtime.mjs` after the runtime change (the Studio serves `arcade/dist/`), `python3 tools/stamp-modules.py` after any `.js`
change.

## 6. Tests

* **Reference compositor** (`refWindow`, `arcade/tests/m7-common.mjs`): the rule of section 1, written from this contract (per pixel: when
  `attr(A) <> attr(B)` and `p <> 0`, a pixel of the minority tile is 0). Every existing window test (every camera 0..cam_max, both files, 11
  layouts, per-band phases, Part C's checks, whole games after every refresh) then compares the runtime with it. New: a world built so that every
  case of the table occurs at every phase 1..7 (blank / blank, blank / ordinary with equal and different colours, ordinary / ordinary with equal
  and different colours, a blank tile other than 0), and a check that FAILS under option 1 (the old rule) at p = 3 and p = 4.
* **Class-bit model** (in `m7-common.mjs`, from section 2): after boot, after every `RT_WORLDLOAD` and after every `RT_SETWORLD` the runtime's
  WORLD_RAM equals the model's byte for byte, including bits 0-2 (worlds 24, 25, 61, 128 wide; SETWORLD at columns 0, 1, W - 2, W - 1 and inside;
  a blank tile set by SETWORLD next to blank and non-blank tiles; banked and mapped worlds).
* **Collision and API** (`m7-runtime-api.mjs`): unchanged results with the class bits present (the existing 18,100 random queries, now on
  classified worlds; the WORLD_RAM comparison there includes the class bits).
* **Interrupts and registers** (`m7-runtime-regs.mjs`): the injection test covers the new code (stubs, handlers, the class pass).
* **Memory** (`m7-runtime-mem.mjs`): `$5E00-$5EFF` written only if used, `$5F00-$5FFF` and `$7B00-$7FFF` free; nothing else new is written.
* **Perf** (`m7-runtime-perf.mjs`): the bounds of section 4 as checks, the world test set as its worlds.
* **Leap Runner perf**: a script like `tests/arcade-m6-platformer-perf.mjs` for `runner.arc` (the recorded play-through; ticks marked as world
  loads when they call `RT_WORLDLOAD` or start a scene), reporting distribution, worst non-load tick and ticks over budget.
* **Differentials**: `byte AND $F8` where WORLD_RAM is compared with the interpreter (section 2); everything else unchanged and passing.
* **Mutations** (`m7-mutations.mjs`): at least 12 new mutants on the new code (the P test, each handler, the class pass, SETWORLD's update, the
  masks, the page replication), all killed or proved equivalent in the file, run in 4 shards.
* The whole battery of the next-session prompt before the commit (`node arcade/tests/run-all.mjs`, `tests/studio-smoke.mjs`, the editor / model
  suites, `tests/rom-checks.mjs`, `tests/browser-smoke.mjs`), and the cross-emulator check of Leap Runner once (`arcade/tools/xemu/runner-*`).

## 7. Today's numbers (main `0e6f777`, measured before the change)

* `tests/arcade-m6-platformer-perf.mjs`: "win twice" 853 ticks, median 147,313, 95th 162,489, **worst 174,919**, 0 over 176,064; mean
  `window_repaint` **112,088**, `win_draw_all` 9,835, PROC FRAME 15,438. "Game over" 377 ticks, worst 165,919, 0 over; mean `window_repaint` 92,900.
* `m7-runtime-perf.mjs` section 1 (as built in batch 6 Part C, the docs' figures): 1 band worst 124,641, bitmap mean 107,722; 4 bands worst
  127,301. Content-independent (no blank path).
* Leap Runner: worst tick that is not a world load 173,167 (batch 6 As built); the new runner perf script gives the full baseline.

## 8. Not done

A phase-0 blank path (optional, section 3); comparing only the colours that show (ink of the dropped pixels against the kept tile's paper) instead
of the whole attribute byte; skipping rows blank in both display files (needs sprite dirty tracking).

## As built (2026-11-11, branch `arcade-window-fastpath`)

* **Runtime** (`arcade/runtime/v3/scroll.asm`, `layout.inc`): the method of section 3 as written; numbers and structure in `ARCADE_RUNTIME_API_V3.md`
  "As built: the window fast path and colour-clash option 2". `W_BLANKT` holds attr(t) at 8t and blank(t) at 8t + 1. The bounds of section 4 as
  amended are met (`m7-runtime-perf.mjs` 17 / 17); the original first rows are not (dense colour boundaries, see the amendment). v3 free bytes 880.
  A dead 5-byte entry (`cls_run1`) found by the regs test was removed by the main session.
* **Leap Runner** worst non-load tick 173,167 -> 158,342; **platformer** worst 174,919 -> 160,199; 0 ticks over budget in either (loads aside).
* **Tests** as section 6, plus: the m11 bank test's RAM poisoning spares `$5B00-$5EFF` in a window game (the class pass reads those pages; in a real
  game they always hold the boot's tables); five stale mutation patterns of earlier batches repaired; WORLD_RAM masked with `$F8` also in the
  m6 / m9 / m13 differentials and `tests/arcade-runner.mjs`. New: `tests/arcade-runner-perf.mjs` (`--check`: the worst non-load tick below 173,167
  and no non-load tick over 176,064).
* **Possible later cleanup:** the `or 7` in `H_UP_S`'s p < 4 copy is redundant (bits 0-2 are already 7 when D = 1); a mutant proves it equivalent.
