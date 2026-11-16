# Fine colour in runtime v2 (slice F2): notes

`fine.asm` implements `docs/ARCADE_FINE_COLOUR_CONTRACT.md` sections 2, 3a, 4 and 5 with method BD (compose off screen, publish right after the next
frame interrupt, top to bottom, only the 8x1 groups that differ from the screen). Tests: `arcade/tests/m19-runtime-fine.mjs` (pictures, switches,
interrupts, memory), `m19-runtime-perf.mjs` (costs, the beam), `m19-mutations.mjs`. Every figure below was measured by those files on TSRun.

## Design

* **No change to the rest of the runtime.** `fine.asm` is appended after `wiretick.asm`; every byte below it is identical to a build without it
  (checked by m19 section 0), so a game without fine colour runs exactly the code it ran before: +0 T a tick, no moved address.
* **How the tick is entered and left (deviation, see below).** `main.asm` calls `init_entry` and every `frame_entry` with SP = `STACK_TOP`, so their
  return address is the word at `STACK_TOP - 2` (`TICK_LOOP` after `init_entry`, `SKIP_CALL` after a two-buffer `frame_entry`). `RT_FINEMODE` ON
  replaces it with `FINE_RES_INIT` / `FINE_RES_TICK`: the scene's code finishes its `init_entry` / `frame_entry` (its `INIT` runs after the switch, as
  the contract wants) and then returns into the fine tick, which composes that state and enters `FINE_LOOP` (a copy of `TICK_LOOP`'s wait, period and
  canary check). OFF inside the fine tick's `frame_entry` is seen after it returns (`FINE_FRET`): the rest of the two-buffer tick follows from
  `SKIP_CALL`. OFF after an ON in the same `init_entry` / `frame_entry` puts the original address back. ON from anywhere else is refused.
* **The fine tick:** `FINE_LOOP` (wait for `V_SYNC` = ready and the period) -> `fine_publish` -> `frame_entry` -> `fine_compose` -> `V_TICKS` + 1 ->
  `V_SYNC` = busy (no flip request) -> `FINE_LOOP`. The update starts 386..442 T after the interrupt (measured, frame_div 3).
* **Compose** (`fine_compose`):
  1. instances: each instance's state now (visible, x rounded to its phases, y, asset) against its record in `F_REC` (what the screen shows). When they
     differ, the cells under the old window and the new one are marked in `F_CMAP` (= `DIRTY1`; `mark_dirty` already sets the dirty cells there, so
     text / tile changes need no extra step) and their pixel rows in `F_RMASK` (one byte a cell row, bit k = pixel row k); when both windows are
     shown, of the same asset, at most 8 pixels apart and within 3 byte columns, one mark covers both (the rectangle over the two). The record
     follows. Every visible instance gets its blit data (`F_INFO`, 16 bytes, in the order the blit reads them: the rows, inks and phase row of its
     first and second cell row precomputed) and joins the list of each cell row it meets (`F_RL`; the entry is 16 i + d, d = that cell row - its
     first). An unchanged instance marks nothing.
  2. cell rows from 23 up to 0, each with a marked cell (`fine_rowbuild`): the pixel rows K0 .. K1 to recompose: all 8 when a cell of the row is
     marked in `DIRTY0` too (text, tiles: `mark_dirty` marks both maps; `DIRTY0` is cleared here), else the rows of `F_RMASK`; the values that
     depend on them only (N, the two block entries, the glyph plane, `tile_rows + K0`) are kept from the last row composed when its rows were the
     same (`F_LASTM`). The marked cells come from the four `F_CMAP` bytes through `F_LOWBIT` (the lowest set bit of a byte: one step a cell, none
     for a clear bit); each one's low byte goes to `F_COLS` and its background, rows K0 .. K1, into the strip (the bitmap blocks are unrolled 8
     times and entered at block 8 - N; a tile cell's colours by LDIR from `tile_rows + 8 t + K0`, a font cell's attribute by a loop). Every
     instance of the row's list (in order) whose window covers a marked cell of the row is blitted into the strip (bitmap `(s AND mask) OR image`;
     colour `(c AND $F8) OR ink_k` where the mask byte is not `$FF`). Then each marked cell (right to left), rows K1 .. K0 (the diff blocks are
     unrolled 8 times, entered at block 8 - N), is compared with the screen and every group that differs is PUSHed as (address, bitmap, colour).
     SP walks the list downwards from `F_LTOP`; the publish POPs it upwards, so it runs cell row by cell row from the top. Before a row's cells the
     room for 8 groups a cell above `F_LLOW + F_GUARD` is checked (one compare when there is room for 32 cells); when the list is full the row's
     cells go back into `F_CMAP` (from `F_RBITS`) and rows 0 .. this one are left to the publish (`F_OVF`; `F_NOVF` counts such ticks).
* **Publish** (`fine_publish`): the rows left by a full list first (composed now with the same code, all 8 rows, and written straight, top to
  bottom), then the list: `POP HL` (address), `POP DE`, `LD (HL),E`, `SET 5,H`, `LD (HL),D` (bitmap and colour 15 T apart), unrolled 8 times and
  entered at block (-groups) AND 7 with B = the passes (a count from `F_LIST`, so no end test a group). The end marker (H = 0) stays for the tests.
* **Interrupts.** No `DI` anywhere; no self-modifying code. While SP walks the list (compose step 2, publish) the interrupt pushes below SP: list bytes
  already read (publish) or free list bytes (compose; `F_GUARD` = 48 bytes kept free below the lowest entry). The deepest push measured, the
  three-channel sound tick included, is 12 bytes (re-measured after the speed pass). The compose uses the alternate registers, IX and IY; the ISR
  touches none of them.
* **Switch ON:** the hidden display file's attributes to 0 (plain black) and that file shown by the ISR's own flip (`V_SYNC` = `SYNC_REQUEST` + file);
  the fine picture of the cell map (no sprite) built into `$4000` / `$6000` behind it; `$FF` = 2 by the ISR's flip too (`V_SYNC` = 4: the ISR writes
  the value and `V_SHADOW_FF`, unchanged); records, dirty maps cleared; `V_FINE` = 1. **OFF:** file 2's attributes to 0 and file 2 shown (plain);
  file 1 drawn from the cell map (`redraw_dirty`), shown; file 2 drawn; `SPR_DRAWN` cleared; `V_HIDDEN` = 1, `V_HOFF` = `$20`. After the flip to
  `$FF` = 2 (the attribute areas are then not shown) ON also builds `F_LOWBIT`, sets `F_TMASK` and clears `F_LASTM` and `F_NW + 1` (they live in
  file 2's attributes, which hold anything before ON). Every frame of a
  switch is the old picture, plain black or the new picture (m19 section 3 checks the painted frames).
* **Refusals (fine colour stays off):** `V_WIRE` <> 0; more than 32 phase slots handed out by the boot (`V_SLOT` > 32); a call from outside
  `init_entry` / a `frame_entry`. A descriptor with `tile_rows` = 0 draws tile cells with their cell attribute on all rows.

## RAM (only while `V_FINE` = 1)

| Area | Use |
|---|---|
| `$E062` `V_FINE`, `$E063-$E06F` | `F_TBASE` (tile_rows - 1024), `F_INKS`, `F_LIST`, `F_OVF`, `F_NOVF`, `F_SP`, `F_R`, `F_M` |
| `$5800-$59FF` (file 1 attributes) | the strip: one cell row, cell column c pixel row k at `$5800 + 8 c + k`, colours at `+ $100` |
| `$5A00-$5AFF` | `F_INFO`: 16 bytes an instance (`I_MB` .. `I_PTR1`: the blit data, read in order) |
| `$7800-$797F` (file 2 attributes) | `F_RL`: 24 row lists of 16 entries (16 i + d) |
| `$7980-$79DF` | `F_RMASK`: the pixel rows of each cell row the changed windows cover (byte 4 r) |
| `$79E0-$79ED` | `F_FV`: the per-row values (`F_GP`, `F_TB0`, `F_NW`, `F_TMASK`, `F_K1`, `F_SCR1`, `F_DENT`, `F_BENT`, `F_K0`, `F_LASTM`) |
| `$7A00-$7AFF` | `F_LOWBIT`: the index of the lowest set bit of each byte (ON builds it) |
| `DIRTY1` (`$D500`) | `F_CMAP`: the cells to recompose |
| `DIRTY0` (`$D400`) | read and cleared a cell row at a time (a cell marked there needs all 8 rows) |
| `SPR_DRAWN` (`$D560`, 128) | `F_REC` (64), `F_RLC` row counts (24), `F_RBITS` (5), `F_COLS` (32) |
| phase pool B `$F000-$FA7F` | the update list: up to 660 groups (4 bytes each) above the 48-byte guard |

All of these are the fine areas the contract's free list names (the attribute areas, pool B, the dirty maps, the second half of `SPR_DRAWN`,
`$E062-$E06F`); the speed pass added `F_RMASK`, `F_FV` and `F_LOWBIT` inside file 2's attribute area and no new area. `V_ROWSAVE` / `V_PTR` are no
longer used.
`$5B00-$5FFF`, `$7B00-$7FFF`, T2, V_FREE2, POOL_A/C and the rest of the map are not touched (m19 section 5).

## Size

`fine.asm`: **2,378 bytes** (bound 2,500); 1,068 bytes free after `RT_END` (`$3BD4`). Before the speed pass: 2,079 bytes, 1,367 free.

## Figures (TSRun, `node arcade/tests/m19-runtime-perf.mjs`, 2026-11-15, after the speed pass; before it in brackets)

| What | T-states |
|---|---|
| compose + publish per moving 16x16 sprite (8 phases, moving 2 px, 1 px a tick) | 25,224 (publish 2,160 of it) [28,634 (2,881)] |
| the same, 1 phase (byte aligned, moving 8 px) | 23,895 [27,204] |
| per moving 8x8 sprite (8 phases) | 12,595 (publish 769) [14,267 (1,007)] |
| per dirty text cell (16 a tick) | 1,761 [1,840] |
| publish per changed group | 46 [61] |
| an empty fine tick (publish + compose, nothing changes) | 3,724 [4,736] |
| RT_FINEMODE ON / OFF | 843,308 (14 refreshes) / 821,386 (14 refreshes) [828,182 / 821,354] |

Starfall-like ticks (tiled sky with 8 row colours, a HUD counter every tick, all sprites moving 2 px), compose + publish a tick:

| Sprites | median | p95 | worst | publish median (groups) |
|---|---|---|---|---|
| 8 (5 16x16, 3 8x8) | 171,601 [195,460] | 178,094 [204,075] | 179,012 [204,474] | 14,179 (317) [19,002 (316)] |
| 10 (6 + 4) | 215,596 [241,044] | 228,462 [257,551] | 228,840 [258,018] | 17,362 (390) [23,286 (388)] |
| 12 (6 + 6) | 233,849 [267,249] | 257,494 [282,668] | 257,565 [282,854] | 18,493 (416) [24,952 (416)] |
| 16 (9 + 7) | 314,681 [345,535] | 329,683 [367,807] | 329,683 [367,807] | 25,528 (577) [34,529 (577)] |

A 20 Hz tick is 176,064 T: the 8-sprite tick now fits at its median (4,463 T left for FRAME) but not at its 95th percentile (2,030 T over); the
target of the pass (p95 <= 165,000, room for FRAME) is **not met** (see "Speed pass").

The beam (frame_div 3 asked, 1,500 frames, every painted frame classified with `arcade/spike/fine/fine-check.mjs`): 8 sprites: 1,482 frames
clean, 0 torn, 0 broken (as before). 16 sprites: 1,476 clean, 3 torn, 0 broken (as before); the 3 torn frames come from the 3 ticks (of 243)
whose update did not fit the list (577 groups median, up to 660 fit): those rows are composed and written during the publish, which then takes up
to 119,441 T [130,167].

Where the time goes (one tick, by routine, measured per instruction on TSRun; interrupts are the ISR running inside the compose):

| | 8 moving 16x16 (204.5k: compose 187.5k + publish 17.0k) | Starfall-like, 8 sprites (171.2k median) [before: 196.2k] |
|---|---|---|
| diff (compare, push) | 43.3k | 39.1k [50.0k] |
| blits | 43.1k | 33.1k [32.8k] |
| backgrounds | 29.7k + the cell scan 9.1k | 26.5k + 7.8k [40.8k, + the row columns 13.5k] |
| instances and marks | 25.0k | 24.5k [26.0k] |
| per cell row (ranges, set-up, room) | 25.9k | 18.7k [2.4k: then inside the backgrounds] |
| blit set-up | 8.7k | 7.5k [10.9k] |
| publish | 16.8k | 13.9k [18.7k] |
| interrupts | 5.4k | 10.5k [10.6k] |

The 8 moving 16x16 recompose 70 cells a tick (8.8 a sprite: 3 byte columns by 3 cell rows, sometimes 4 columns), 6.46 pixel rows each (453 rows
compared, of which about 365 are published), against 565 rows before; the Starfall-like tick 60.5 cells of 6.78 rows. The pure work (8 rows of
background and diff per recomposed cell row, the 48 blit bytes of a 16x16 sprite, the publish) is about 105k of the Starfall-like tick's 171k
with the interrupts; the rest is bookkeeping per instance (about 3k each), per cell row (about 1.4k each, 13 rows) and per cell (about 350).

## Speed pass (2026-11-15)

Kept (each measured on the Starfall-like 8-sprite tick, compose + publish median, in order):

| Change | Effect |
|---|---|
| publish: a count instead of an end test, unrolled 8 times, entered at block (-groups) AND 7 | 61 -> 46 T a group; -4.9k |
| pixel-row ranges per cell row (`F_RMASK` from the marks, all 8 rows for a cell in `DIRTY0`), background and diff entered at block 8 - N; the marked cells through `F_LOWBIT` (no bit loop); the room checked once a row | rows per cell 8 -> 6.8; -8.5k |
| `F_INFO` in read order with the second cell row precomputed, row-list entries carrying the cell row (16 i + d), blit set-up reading it in order | -3.7k |
| one mark over both windows of a small move (<= 8 px, <= 3 byte columns); the per-row values cached on the row mask (`F_LASTM`, about 0 alone) | -3.8k |
| background built as each cell is found, the overflow put-back by copying `F_RBITS`, a faster row-list append, the blit dispatch falling into `fine_blit3` | -1.5k |
| diff block 23 bytes (a colour-only change falls into the push) | +0.3k, -32 bytes |
| `F_INFO` written in order through HL | -1.4k |
| room: one compare when there is room for 32 cells; D set once a row for the diff | -0.9k |
| the entries of N rows from a table (`F_ENT`) | -0.5k |

In all: 196.2k -> 171.2k median (profiler), 195.5k -> 171.6k (m19-runtime-perf).

Tried and dropped (numbers from a model of the same scene or measured):

* **Publishing every recomposed row without the compare**: saves about 26 T a row in the compose but publishes about 100 more groups a tick
  (+4.4k); net about -6k on 8 sprites, but the 16-sprite tick would need about 760 groups (660 fit) and overflow, tearing, every tick. It also
  drops the contract's rule (3a.1: only the groups that change). Not done.
* **Pixel-row ranges per 8-column byte group instead of per cell row**: rows per cell 6.79 -> 6.00 in a model of the Starfall scene (-6k of row
  work), but marking two bytes a row and a range per group in the row and in the diff cost about 4.5k back. Per-cell ranges (5.56 rows) need a
  mask per cell (768 bytes) and a per-cell entry (~120 T a cell). Not done.
* **Comparing with the alternate registers** (no `SET` / `RES 5,H`): 8 T faster when a group is equal, 8 T slower when it differs; most compared
  groups differ after the ranges. Not done.
* **LDI unrolled for the tile colours** (a second computed entry): about 8 T a cell; not worth the bytes.
* **Blits**: `(s AND mask) OR image` and the colour are 88 T a byte; the phase copies cross pages (96-byte slots), so `INC L` is not safe, and
  SP cannot read them (an interrupt would overwrite art already read). The row overhead (ink, column steps) is 94 T for a 3-byte row and stays.
* **Why the target was not met**: about 105k of the 171k tick is the work itself (backgrounds, compare, blits, publish, interrupts); the target
  would leave about 60k for everything else and the bookkeeping is still about 66k after the pass. The remaining ideas each give 1-2k (byte-column
  runs in the diff and background, a 4-column joined mark, row set-up shortcuts) and the size bound leaves 122 bytes. The 12k target per 16x16
  sprite is out of reach for method BD as built: the pure work alone is about 11k a sprite (8.8 cells of 6.5 rows of background and compare, 48
  blit bytes, the publish).

## Deviations from the contract / the brief

1. **No test in `main.asm`** (contract 5.1 asks for one beside the `V_WIRE` test). A switch ON happens inside `frame_entry`, after that test, so a
   test before `frame_entry` alone cannot route the tick that switches; a second test after it would cost a non-fine game 27 T more (54 T in all,
   over the 30 T bound). Replacing the return address on the stack (not code) routes both the switching tick and `init_entry`, and a game without
   fine colour pays nothing. The price: `RT_FINEMODE` must be called inside `init_entry` or a `frame_entry` (the compiler's ENTER always is).
2. **Row ranges per cell row.** A marked cell is recomposed and compared on the pixel rows K0 .. K1 of its cell row (the union of the changed
   windows' rows there; all 8 for a dirty cell), not per cell (the diff keeps only the groups that change, so the publish is still "only the groups
   that differ"). Per-cell or per-byte ranges cost more than they saved (see "Speed pass").
3. **The 12k T target per moving 16x16 sprite is not met**: 25.2k after the speed pass (28.6k before; the spike's BD about 23k a sprite was an
   average over a mix with seven 8x8 sprites). The pure work alone is about 11k; the rest is per-cell, per-row and per-instance bookkeeping.
4. `RT_FINEMODE` ON when on / OFF when off write nothing (checked: no port `$FF` write).
5. A list overflow composes the leftover rows during the publish (the contract's rule); with 16 moving sprites that happens in about 1 tick in 70
   and tears a frame (3 torn frames in 1,476); 8 sprites never overflow.

6. `arcade/tests/m17-runtime-wire.mjs` measured "the wireframe addition" as `M_WIRE_S .. RT_END`; with fine.asm after it that counted fine colour too.
   It now ends at `M_WTICK_E` (the wireframe's own last module; 4,731 bytes, unchanged).

## Tests

* `node arcade/tests/m19-runtime-fine.mjs` (27 checks; `M19_QUICK=1` fewer random scenes; the speed pass added moves of 0..9 pixels in every
  direction with text in the sprites' rows, and ON over a poisoned `F_FV`), `node arcade/tests/m19-runtime-perf.mjs` (12 checks),
  `node arcade/tests/m19-mutations.mjs` (186 mutants, 9 marked equivalent with the reason; `--check` for the patterns).
* The reference picture is reached through `arcade/tests/m19-fine-ref.mjs` (one import line, now the spike's `fine-model.mjs`).
