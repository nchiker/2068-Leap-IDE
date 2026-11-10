# Leap Arcade: the platformer slice, contract for runtime v3 and language batch 2 (2026-11-09)

Owner's order (HANDOFF): "the platformer slice (Commander Keen-style): write the contract first, then runtime and compiler
in parallel". This file is that contract. It extends `ARCADE_RUNTIME_API_V2.md` (+ "As built: language batch 1") and
`ARCADE_LANGUAGE_BATCH1.md`. Measured basis: `arcade/spike/scroll/RESULTS.md` (V2 pre-shifted tables, V3 windows) and
`arcade/spike/scroll/parallax/RESULTS.md` (P1 banded parallax). Where this file and a spike disagree, this file wins.

**Decisions made here (owner delegated: "only what is needed, adjusted as games are built"; each is cheap to revise before code
exists, expensive after):**

| # | Decision | Why |
|---|---|---|
| D1 | **Runtime v3 is a new directory** `arcade/runtime/v3/` (copy of v2, `"version": 3` in `runtime.json`); v0-v2 and their tests stay untouched. A game picks v3 with `--runtime v3`; the compiler picks it by itself when the program uses `WINDOW`, `FLIP`, a sprite wider than 16 or taller than 16, or a `FRAME` other than 0. | Same working pattern as v0 -> v1 -> v2. |
| D2 | **Window: exactly 24 x 16 cells (192 x 128 px)**, at screen cell (`cx`, `cy`) (default 4, 4; `cx` 0..8, `cy` 0..8). Other sizes later (a build define). | The measured sweet spot: 3 refreshes (20 fps), room for ~6 sprites (spike). |
| D3 | **Horizontal scrolling only**, camera in whole pixels, 16-bit. The window shows world rows 0..15. | What Keen needs first; vertical is a later module. |
| D4 | **Parallax = bands** (P1): the 16 window rows are split into 1..4 bands of whole cell rows; each band has its own speed ratio and reads its own rows of the world map. **No transparent layers.** | Banded is nearly free (+237 T/band); transparent layers cost 129k-398k T (parallax RESULTS). |
| D5 | **The world map is RAM** (`WORLD_RAM`, 2,048 bytes = 128 columns x 16 rows, one byte per cell = tile * 8, 32 tiles), copied from the game image when the scene starts. The scroll tables (pre-shifted tiles, 3,584 bytes) are **ROM data in the game image** (the compiler pre-shifts, page aligned). | Pickups and breakable blocks need to change the world; tables cost no RAM. |
| D6 | **In window mode the world is repainted from the maps every tick**; sprites are drawn afterwards with **no erase and no skip analysis**. Sprites use **world pixel coordinates**; the runtime subtracts the camera. A sprite that overhangs the window edge is **clipped** (drawn, then the overhanging cells outside the window are restored from the cell map by ring repair; section 5). Sprites never write attributes (they take the cell's colours, as in v2). | Spike: stateless repaint makes both display files trivially correct; saves ~1/3 of a sprite's cost. |
| D7 | **Sprite frames: up to 16 per asset (32 with the compiler's mirrored copies, `FLIP`).** Widths 8, 16, 24, 32; heights 1..48. | Platformer characters. |
| D8 | **Tile flags** (8 bits per tile, from the tileset's `flags`): bit 0 solid, bit 1 hazard, bit 2 pickup, bit 3 ladder/one-way (game-defined), bits 4-7 game-defined. Collision queries are **runtime routines on `WORLD_RAM`** in world pixel coordinates. | Compiled loops over tiles are 5-6x dearer (batch 1 measurements). |

## 1. Memory map v3 (binding; the runtime engineer fills in the rest and documents it in `layout.inc`)

RAM chunk 6 as v2 except as noted; chunk 7 changes:

| Range | v3 use |
|---|---|
| `$E000-$E0FF` | runtime variables (as v2) |
| `$E100-$E1FF` | **new** `V3VARS`: camera, band state, attribute caches, window geometry, collision scratch (256 bytes) |
| `$E200-$E9FF` | `GAME_VARS` (**2,048 bytes**, was 3,839): the compiled code's variables and arrays. `GAME_VARS_BASE` / `GAME_VARS_LIMIT` in `runtime.json` change; the compiler must read them from there and report "out of variable space" with the byte counts |
| `$EA00-$F1FF` | `WORLD_RAM` (2,048): row r (0..15), column c (0..127) at `+ r*128 + c`; page aligned; a cell = tile index * 8 (0..248) |
| `$F200-$FA7F` | phase pool B (2,176 bytes; was `$F000-$FA7F`) |
| `$FA80-$FAFF`, `$FB00...` | as v2 (tile-operation RAM, canary, 1 KB stack) |

Sprite phase memory in total (pools A + B + C) is about **5,600 bytes**. The engineer chooses how to allocate it (exact-size
allocation per asset-frame-phase instead of v2's fixed 96-byte slots is expected; a lazy per-instance cache of the *current* frame
is also allowed if its cost is within the budget in section 6). Whatever is chosen, **the linker must fail with a clear message
and the number of bytes missing** when a game's art does not fit, and the following reference art set must fit and run (it is the
acceptance game's art):

| Asset | Size | Frames | Phases | Note |
|---|---|---|---|---|
| player | 16 x 24 | 8 (+ 8 mirrored by `FLIP`) | 4 | idle, 4 walk, jump, fall, hurt |
| walker | 16 x 16 | 2 (+ 2 mirrored) | 4 | enemy |
| flyer | 16 x 16 | 2 | 4 | enemy |
| coin / pickup | 8 x 8 | 4 | 8 | spinning |
| shot | 8 x 8 | 1 | 8 | |

(Instances: 1 player + up to 6 walkers/flyers + 1 shot + up to 4 coins on screen = 12 of the 16.)

## 2. Sprite frames and bigger sprites (non-window mode too)

**Asset descriptor v3** (8 bytes, same size as v2): `DB w, DB h, DW data, DW hot, DB phases, DB nframes`
(v2's zero pad becomes `nframes`; 0 is read as 1). `w` in {8, 16, 24, 32}; `h` 1..48; `phases` in {8, 4, 2, 1}; `nframes` 1..32.
**Frame data** is `nframes` blocks of `h` rows, consecutive; a row is `wb` mask bytes then `wb` image bytes (`wb` = w/8; leftmost pixel
= bit 7 of the first byte; mask 1 = background shows, image 1 = ink), i.e. the v2 rows generalised (`w` 16 was mask_hi, mask_lo, image_hi, image_lo;
`w` 8 was mask, image). `hot` is one collision box per asset (not per frame); 0 = the whole sprite.
**Instances.** `SPR_TAB` entries become **8 bytes**: `DB visible, DB asset, DW x, DW y, DB frame, DB 0` (visible 0 = hidden, 1 = shown; the
frame byte 0..nframes-1, clamped at draw time to `nframes - 1`). `RT_SHOW` takes the frame in a register (convention: the
engineer's, documented, e.g. A = frame) and sets it; changing only the frame counts as a change (skip analysis / `V_CHG` as in v2 for non-window
mode). `SHOW s AT x, y` without `FRAME` keeps the instance's last frame (0 at start). `HIDE` unchanged.
**Non-window clamps.** v2's `RT_SHOW` clamp (x 0..239, y 0..176) becomes per asset: x 0..(256 - w), y 0..(192 - h).
**Blitters** for window widths of 1..5 bytes (w 32 shifted by a non-zero phase touches 5), rows 1..48; the v2 draw / erase bookkeeping (`SPR_DRAWN`
records, whose `N` byte limits height to 31 and columns to 7) must be widened for h up to 48 and 5 columns (non-window mode only; window mode has no erase).
**Cost targets** (TSRun, a refresh is 58,688 T): a 16 x 24 sprite, 4 phases, unaligned, drawn: <= 5,200 T; a 16 x 16 as v2 (3,339 T) unchanged within +5 %.
`RT_HIT` uses the stored position and the asset's box (any frame).

## 3. The scrolling window (new module `scroll.asm`, ported from the spike's `v2.asm` + `p1.asm`)

**Header v3** (appended after the v2 extended header, bit 6 of `frame_div` = `DIV_WIN` `$40` says it is present, so `frame_div` <= 60 still fits in bits 0-5;
the engineer may instead put it behind a header-version byte, but must document and test the old/new split):
`DW window_desc` -> `DB cx, DB cy, DB nbands, DB world_w (cells, 24..128), DW cam_max (pixels), DW tables (page aligned), DW tile_flags (32 bytes),
DW world_src (ROM copy of the 128 x 16 map, loaded into WORLD_RAM at scene start)`, then `nbands` x `DB rows, DB ratio_code`.
`ratio_code`: 0 fixed (position 0), 1 = 1/4, 2 = 1/2, 3 = 1, 4 = 2. Rows sum to 16. Bands are stacked from the top of the window; band k reads
world rows `sum(rows before k) ..` (so far-away layers simply occupy their own rows of the one world map). At least one band should have ratio 3 (the
gameplay band; collision is defined on the whole `WORLD_RAM` regardless of band, see section 4).
**Tables.** For each phase p = 1..7 two 256-byte pages `LTAB[p][tile*8 + r] = (row << p) & $FF`, `RTAB[p][tile*8 + r] = row >> (8 - p)` (7 x 2 x 256 = 3,584 bytes,
ordered as the engineer needs; phase 0 is a copy path through the tile table `TILEROWS[tile*8 + r]`, 256 bytes, also in the game image). Attributes: `TILE_ATTR` (v2) of the tile
at `m[c]`, per the spike's V2 convention (changes in 8-pixel steps).
**State.** `V_CAM` (word, clamped camera in pixels) is readable by tests and by `CAMX()`. `RT_CAMERA`: HL = requested camera, clamped to `0..cam_max`, stored.
Per band position = `floor(camera * ratio)`: ratios 1/4, 1/2 and 1 are shifts of the clamped camera; ratio 2 is `camera * 2`. `cam_max` (the compiler computes it) =
`floor((world_w*8 - 192) / max ratio over the bands)` so no band reads past its map (`max ratio` = 2 when a ratio-2 band exists, else 1).
**Per tick, window mode** (`main.asm`; `frame_entry` first, as v2): (1) `frame_entry`; (2) `redraw_dirty` (the cell map outside the window: HUD text and tiles; cells inside the window are never
drawn from the cell map); (3) `window_repaint`: bitmap of all 384 cells into the hidden file for every band at its position, then the attribute pass of each band **if its `col0` differs from the one
that file already shows** (two cached `col0` per band, one per display file); (4) `draw_all` (section 5, no erase); (5) flip request. The result must be **identical to the JS reference compositor
for every camera 0..cam_max, both display files, every phase 0..7, every band layout** (tests, section 7).
**Blank-cell path** (spike: 216k -> 156-168k on open levels): optional in v3.0, assembled in only if the measured worst tick of the acceptance game needs it; the engineer reports the decision.

## 3b. Binding encodings (compiler <-> runtime; neither side may change them without editing this section)

* **Header.** `frame_div` bit 7 (`DIV_EXT`, `$80`) = 18-byte header with `map_table` at `+16` (unchanged). New: bit 6 (`DIV_WIN`, `$40`) = **20-byte header**, `+18 DW window_desc` (bit 6 requires bit 7).
  `frame_div AND $3F` is the divisor. Sprite descriptors follow the header (`sprite_table` says where). A descriptor is `DB w, DB h, DW data, DW hot, DB phases, DB nframes`.
* **`window_desc`:** `+0 DB cx, +1 DB cy, +2 DB nbands (1..4), +3 DB world_w (24..128), +4 DW cam_max, +6 DW tables, +8 DW tile_flags, +10 DW world_src, +12 DW tilerows, +14 nbands x (DB rows, DB ratio_code)`.
  `tables` is 256-byte aligned: 14 pages, page `2*(p-1)` = `LTAB[p]`, page `2*(p-1)+1` = `RTAB[p]` for p = 1..7, each indexed by `tile*8 + r` (tiles 0..31, so entries 0..255). `tilerows` = 256 bytes, `tile*8 + r` = the tile's row r (phase 0 copy path).
  `tile_flags` = 32 bytes. `world_src` = 2,048 bytes, row `r` at `+ r*128`, cells beyond `world_w` and rows beyond the map's height are 0. All pointers are inside the game image (`$8000-$BFFF`).
* **Routines (all CALLs; clobber AF BC DE HL; IX, IY and alternates preserved):**
  `RT_SHOW` (A = instance, BC = x, DE = y; as v2; **keeps the instance's frame**; in window mode x, y are not clamped), **`RT_SHOWF`** (the same with **HL = frame**),
  `RT_HIDE` (as v2), `RT_HIT` (as v2), **`RT_CAMERA`** (HL = camera), **`RT_WORLDTILE`** (HL = x, DE = y; returns HL), **`RT_TILEFLAGS`** (HL = x, DE = y; returns HL),
  **`RT_TILEHIT`** (`RA_X, RA_Y, RA_W, RA_H` = the rectangle, `RA_V` = mask; returns HL), **`RT_SETWORLD`** (`RA_X, RA_Y`, `RA_V` = tile). The argument block `RT_ARGS` / `RA_*` is v2's (batch 1).
  `CAMX()` is `LD HL,(V_CAM)` (a compiler-emitted read of the runtime variable, no routine). A frame argument is taken `AND $FF`, then clamped to `nframes - 1` at draw time.
* `runtime.json` of v3 lists those routines and constants `DIV_WIN`, `WORLD_RAM`, `V_CAM`, `GAME_VARS_BASE`, `GAME_VARS_LIMIT`, `MAX_FRAMES` (32), `SPR_ENT` (8), `SPR_FRAME_OFF` (6).

## 4. Collision (runtime routines on `WORLD_RAM`; coordinates are world pixels: x from the left of the world, y from the top of the window, i.e. row `y >> 3`)

| Routine | Meaning |
|---|---|
| `RT_WORLDTILE` (HL = x, DE = y) -> HL | tile index (0..31) of the cell containing the pixel; outside the world -> 0 |
| `RT_TILEFLAGS` (HL = x, DE = y) -> HL | the flags byte of that tile; **outside the world: left, right and above it is solid (1), below it is empty (0)** |
| `RT_TILEHIT` (x, y, w, h, mask) -> HL | OR of `flags AND mask` over every cell the rectangle touches (w, h >= 1; the rectangle is x..x+w-1, y..y+h-1; arguments in `RT_ARGS`-style block, convention documented); outside cells count as in `RT_TILEFLAGS` |
| `RT_SETWORLD` (x, y, tile) | writes `tile * 8` into `WORLD_RAM` at that cell; outside the world ignored; no dirty bookkeeping (the next tick repaints) |
All four are `DI`-free, clobber only AF BC DE HL, and cost: `RT_TILEHIT` of a 16 x 24 box <= 1,500 T (it visits at most 3 x 4 cells).

## 5. Sprites in window mode

`RT_SHOW` stores x, y as signed 16-bit **unclamped** (world pixels; v3 window mode only). At `draw_all` time: `sx = (x rounded down to the asset's phase granularity) - V_CAM + 8*cx`, `sy = y + 8*cy`.
**Clipping at the window edge (in this slice, by ring repair):** an instance is drawn when its footprint `[sx, sx+w) x [sy, sy+h)` intersects the window rectangle `[8*cx, 8*(cx+24)) x [8*cy, 8*(cy+16))` AND lies
entirely on the 256 x 192 screen (a footprint that leaves the screen is not drawn; with the default `cx`, `cy` = 4 the 32 pixel margin holds any sprite that touches the window). A footprint that misses the window is not drawn.
After **all** instances are drawn, `ring_repair` redraws, from the cell map (`draw_cell`, bitmap and attribute, into the hidden file), every cell **outside** the window that any drawn footprint touched, so the part of a sprite that overhangs the
window disappears and the HUD/border cells are restored. (Repair after the last draw also removes the overhang of overlapping sprites; cells are redrawn idempotently, so a cell touched twice is only wasted time.) Cost target: <= 600 T per repaired cell
beyond `draw_cell` itself; a sprite wholly inside the window costs one rectangle test. Draw order: lowest instance first. Hidden instances and instances that miss the window cost one test.
`RT_HIT` works on the stored world positions (16-bit compare; the v2 hit box logic with unclamped values).

## 6. Budgets (TSRun, no contention modelled; **the engineer reports measured numbers, not estimates**)

| Item | Target |
|---|---|
| `window_repaint`, 24 x 16, 4 bands, worst camera, attributes of a cell-boundary tick included | <= 135,000 T (spike P1: 130,108); <= 3 refreshes with room |
| 1 band, same | <= 130,000 T (spike V3: 128,613) |
| Whole tick, acceptance game (window, player 16x24 + 5 enemies 16x16 + shot, game logic ~15k) | <= 176,064 T (3 refreshes = 20 fps) |
| Tables in the game image | 3,584 + 256 + 32 (flags) bytes; world source 2,048 bytes |
| Sprite draw, 16 x 24 unaligned, 4 phases | <= 5,200 T |

## 7. Language batch 2 (compiler and interpreter; `docs/ARCADE_LANGUAGE.md` changelog 0.2)

```
MAP level = "level1"                  REM existing asset declaration: the world map (for a window: w 24..128, h 1..16, tile indexes 0..31)
WINDOW level                          REM top level, once: use that map as the scrolling world; window 24x16 at the default cell (4, 4)
WINDOW level AT 4, 2                  REM ... at screen cell (cx, cy); both constants 0..8
BAND 2, 1, 4                          REM top level, 1 to 4 times, in order from the window's top: rows, then the ratio as num, den
BAND 3, 1, 2                          REM (allowed ratios 0/1 (fixed), 1/4, 1/2, 1/1, 2/1; rows sum to 16; a missing BAND list = one band of 16 rows at 1/1)
BAND 11, 1, 1
CAMERA expr                           REM statement: set the camera (clamped to 0..cam_max)
CAMX()                                REM function: the clamped camera in pixels
SHOW s AT x, y [FRAME f] [FLIP]       REM FRAME now compiled; FLIP = frame f + nframes (the compiler adds the mirrored frames to an asset used with FLIP)
WORLDTILE(x, y)  TILEFLAGS(x, y)  TILEHIT(x, y, w, h, mask)  SOLID(x, y, w, h)   REM SOLID = TILEHIT(..., 1)
SETWORLD x, y = t                     REM statement
```
* In a program with `WINDOW`, the cell-map words (`TILE`, `FILL`, `PRINT`, `LOADMAP`...) still work but cells inside the window rectangle are never drawn; `SHOW` coordinates are world coordinates.
* Compile-time checks (errors with line and column): `WINDOW` more than once or inside a scene; the map is not 24..128 wide / 1..16 tall or has a tile index > 31 or a tile with no definition;
  `BAND` rows not summing to 16 or an unsupported ratio; `BAND` without `WINDOW`; `CAMERA` / `CAMX` / collision words / `SETWORLD` without `WINDOW`; `FLIP` on an asset whose frames x 2 exceed 32;
  `FRAME` constant >= nframes (a warning for a non-constant that can be out of range is not required; the runtime clamps).
* **Assets:** the sprite asset's `frames` array (already in the Studio format) is compiled completely; `w` 8/16/24/32 and `h` 1..48 are accepted (bits/mask hex strings of `2 * w/8` digits); the tileset's per-tile
  `flags` (0..255) go into the window header's `tile_flags`. Tile 0 of a window tileset should be blank (the sky); the checker warns if it is not (the blank-cell path assumes it).
* **Link report** (`usage`): bytes for code, descriptors, frames, scroll tables, world source, flags; phase RAM needed vs available; `GAME_VARS` used vs 2,048.
* Reference interpreter (`arcade-interp.js`): models `CAMERA`, `CAMX`, `SETWORLD`, the collision words on a model of `WORLD_RAM`, the 8-byte `SPR_TAB` entries (frame included) and the unclamped window-mode
  positions, so scripted differential tests (state equality per tick: variables, `SPR_TAB`, `WORLD_RAM`, `V_CAM`, cells) keep working. Pixels are checked by the runtime's own compositor tests, not by the interpreter.

## 8. Acceptance (the slice is done when all of these hold)

1. `arcade/examples/platformer.arc` (+ generated assets, `.assets.gen.mjs` like the shooter): a level at least 128 cells wide (5.3 screens) with 3 bands (2 / 3 / 11 rows at 1/4, 1/2, 1), a 16 x 24 player
   with 8 walk/jump frames and `FLIP`, walkers and flyers with frames, solid and one-way platforms, hazards, collectible coins (`SETWORLD` removes them), a HUD in the cell map outside the window (score, lives),
   camera following the player, stomp/hit interaction by `HIT`, sound effects, a goal. Plays on TSRun, ZEsarUX 13.0 and Fuse 1.9.1 (screens compared as the earlier games).
2. Runtime tests (all on TSRun, stock ROMs): the repaint equals the JS reference for every camera position of a 128-wide world (cam_max steps of 1 for one full sweep per band layout; all 8 phases; both
   display files; attributes), edge cameras, `col0` changes on consecutive ticks, ratio 2 and fixed bands; every sprite size/frame/phase against an independent JS pre-shift and compositor, including clipping and ring repair at all four window
   edges and corners (the HUD cells outside the window equal the cell map after every tick); the collision routines against JS models (random worlds, random rectangles including outside); register preservation with injected interrupts (`m5-runtime-regs` style); memory-write confinement
   (`m5-runtime-mem` style, the new regions disjoint, poisoned free areas untouched); a mutation run of >= 40 deliberate bugs on `scroll.asm`, the collision routines and the new blitters (all killed or justified).
3. Compiler tests: parser/checker positive and negative for every new word, interpreter semantics, a differential run of >= 600 ticks of the platformer against the runtime (state equality per tick), fuzzed collision
   queries (>= 3,000) against the interpreter. All existing suites stay green (`node arcade/tests/run-all.mjs`).
4. Measured: the budgets of section 6, with the real numbers written into `ARCADE_RUNTIME_API_V3.md` ("As built"), including the worst tick of the platformer.

## 9. Not in this slice, and why each belongs with a planned item rather than here

* Vertical scrolling, and window sizes other than 24 x 16: one module (a second scroll axis changes the repaint loops and the window geometry together); needed by the raycaster/Doom-like step only if at all.
* Transparent layers: not deferred, **rejected by measurement** (129k-398k T; parallax RESULTS). Revisit only if a game needs it.
* Animated tiles: groups with the Studio tile editor (the animation data is authored there); a game can animate by `SETWORLD` meanwhile.
* Music (`MUSIC`, 3 AY channels) and scenes in the compiler: separate planned items (M4b and gap-list #8) that do not touch the scroll engine.
* The Studio world-map editor and asset warnings (mixed BRIGHT-black paper, sky tile 0 not blank, background cells with differing attributes): Studio slice S2, planned next.
* Real hardware (the SCLD / contention question, `ARCADE_HARDWARE_NOTES.md` item 0): needs the owner's machine; every number here is TSRun-only until then.
