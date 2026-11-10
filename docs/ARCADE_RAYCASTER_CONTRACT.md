# Leap Arcade: the raycaster slice, contract for runtime v4 and language batch 3 (2026-11-10)

Owner's order (HANDOFF): after the platformer, "a Wolfenstein-class raycaster prototype (128x96 window)". Same method as the platformer
slice: this file first, then the runtime and the compiler in parallel, then a game. It extends `ARCADE_RUNTIME_API_V3.md` and
`ARCADE_LANGUAGE_BATCH2.md`. Measured basis: `arcade/spike/raycast/RESULTS.md` (67 configurations, bit-exact against a JS reference, TSRun only,
**no memory contention modelled**) and its code (`raycast.asm`, `build.mjs`, `common.mjs`, `sprite.asm`). Where this file and the spike disagree, this
file wins. Owner policy: do not defer a found issue unless it truly groups with a planned item (section 9 gives each reason).

| # | Decision | Why |
|---|---|---|
| R1 | **Runtime v4 is a new directory** `arcade/runtime/v4/`: a copy of v3 with `scroll.asm` replaced by a new `ray.asm`; v0-v3 untouched. A program with `VIEW3D` needs v4; `WINDOW` needs v3; **a program cannot have both** (compile error). The compiler picks v4 itself (`requiredRuntime`). | The v3 runtime is 15,649 of 16,384 bytes; the scroll engine is 4,514 of them. The ray module (2.0-3.1 KB in the spike) takes its place. |
| R2 | **One window: 128 x 96 pixels = 16 x 12 cells at screen cell (8, 6)** (byte column 8, pixel row 48), exactly centred. Cells inside it are never drawn from the cell map (as v3's window); everything around it (the 16-cell-high top and bottom strips and the 8-cell side strips) is the ordinary cell map: HUD, text, tiles, with the v3 `redraw_dirty`. | Spike: HUD outside the 3D window costs nothing per frame. |
| R3 | **Column width is a game choice, 4 or 2 pixels** (header field `colw`, default 4): 32 or 64 rays. Same code serves both (method B, 1/2/4 rays per byte). Measured worst poses: 4 px = 158k T (3 refreshes = 20 fps, ~18k left), 2 px = 272k T (5 refreshes = 12 fps, ~21k left). The game picks `FRAMERATE`; the compiler **warns** when the divisor is below the minimum for the width (3 for 4 px, 5 for 2 px). 1-pixel columns and interpolated rays are not shipped (section 9). | The spike's verdict: 1 px does not reach 10 ticks/s at 128 wide; the others are a trade of look against rate. |
| R4 | **Method B drawing (byte-column composer), double buffered**: the tick draws into the hidden display file, every window byte is written once and none read (no clear), then flip as v3. Attributes of the 192 window cells are written once at scene start into **both** files: the 6 top cell rows with `attr_top`, the 6 bottom with `attr_bottom` (full attribute bytes: ceiling and floor colours, wall ink, bright). | Spike method B; attributes are per cell, so ceiling/floor colour is free. |
| R5 | **Walls: types 1..4, two shades by side**, drawn as the spike's dither patterns (8x2 tile, 8 patterns = 4 types x 2 sides, `PAT` in `arcade/spike/raycast/common.mjs`); the game may supply its own 8 patterns (16 bytes). Walls are **flat shaded, not textured** (textured columns: ~10 refreshes a frame, section 9). | Budget. |
| R6 | **Map: up to 32 x 32 cells, one byte per cell = wall type 0..4** (0 empty), in `WORLD_RAM` (`$EA00`, row stride **32**, 1,024 bytes; the rest of `WORLD_RAM` may be used by the runtime). Cells of the 32 x 32 array outside the game's `map_w x map_h` are wall type 1. **The outer ring of the game's map must be non-empty** (compile error otherwise): a ray always stops inside the array. | The DDA walks a pointer; no bounds test per step (spike). |
| R7 | **Billboards = sprite instances.** `SHOW`, `HIDE`, `HIT` keep their meaning but in ray mode positions are **world coordinates in 8.8 fixed point (1/256 cell)**. A billboard is drawn **column-scaled** at the ray grid (blocky columns of `colw` pixels), depth-tested against the walls, painter's-sorted far to near, ORed through the sprite's mask. Up to the 16 instances v3 has. No pre-scaled copies. | Spike `sprite.asm`: 16 x 16 at 4 px columns = 8k T. |
| R8 | **All tables are built by the runtime at scene start, before `PROC INIT`** (cos/sin, reciprocal, distance-to-height; spike: 0.5-0.8 s = 28-48 refreshes, during which the screen shows the cell map only). Nothing of them is in the game image. The runtime may build them faster than the spike's division loops (any method that gives the same table values). | The game area is tight (15,378 of 16,384 in Leap Runner). |
| R9 | **The 2D sprite pool is not used in ray mode**: no pre-shifted copies, no `POOL_FAIL`. Billboard source frames are drawn straight from the game image (frame data as v3: `nframes` blocks of `h` rows of `wb` mask bytes then `wb` image bytes). The spike's self-modifying routines (DDA loop copies, row chains; ~0.8-1.2 KB) are **copied to RAM at scene start**, preferably `$5B00-$5FFF` (the display files' free tail, 1,280 bytes; RAM in the play mapping); the engineer may pick another free region and documents it. | The code lives in ROM (DOCK chunks 0-1). |
| R10 | **View and pose belong to the game**: the compiled code owns position and angle and calls `VIEW x, y, a` each tick; movement and collision are the game's (with `WALL`). No player entity in the runtime. | Keeps the runtime a renderer; the game decides speed, turning, strafing, doors. |

## 1. Memory map v4

As v3 (`layout.inc`) with these changes; the engineer documents the exact addresses in `ARCADE_RUNTIME_API_V4.md`:

| Range | v4 use |
|---|---|
| `$C080-$D3FF` and `$F200-$FA7F` (v3 pools A, B) | free for the ray tables and buffers (cos 512 B, reciprocal 640 B, distance-to-height 1,536 B for 32 x 32; pattern table; ray arrays 2 x (rays + 4); sort buffer). Engineer's allocation; must not touch `GAME_VARS`, the cell-map tables or the stack |
| `$E100-$E1FF` | `V4VARS` (pose, per-frame variables, `BB_TAB`: 4 bytes per instance `DW depth, DW col`, see section 3) |
| `$E200-$E9FF` | `GAME_VARS` 2,048 bytes (unchanged) |
| `$EA00-$EE00` | the map (R6); the rest of `WORLD_RAM` free for the runtime |
| `$5B00-$5FFF` | the RAM copy of the self-modifying routines (R9) |

The runtime must stay within DOCK chunks 0-1 (16,384 bytes); report the size.

## 2. Binding encodings (compiler <-> runtime; neither side may change them without editing this section)

* **Header.** The v4 runtime reads `frame_div AND $3F` as the divisor, `DIV_EXT` (`$80`) as v3, and **bit 6 (named `DIV_VIEW`, `$40`, in v4's `runtime.json`; it is v3's `DIV_WIN` bit reused, a v4 runtime has no scroll window) = a 20-byte header, `+18 DW view_desc`**. A v4 image has `DIV_EXT | DIV_VIEW` or neither (no 3D view: the runtime then behaves as v3 without a window; it must pass the v3 non-window tests that apply). Descriptors follow the header as v3 (`sprite_table`).
* **`view_desc`:**
  `+0 DB colw` (2 or 4), `+1 DB map_w` (4..32), `+2 DB map_h` (4..32), `+3 DB attr_top` (attribute byte for the 6 cell rows above the horizon), `+4 DB attr_bottom` (the 6 rows below),
  `+5 DW map_src` (the map **byte-RLE encoded**, exactly as v3's `world_src`: pairs `DB count 1..255, DB value`, count 0 ends; row-major, row stride `map_w`, `map_w x map_h` cells of wall type 0..4; the loader expands into the 32-stride array, fills cells outside `map_w x map_h` with 1, and zeroes nothing else it does not need),
  `+7 DW patterns` (0 = the runtime's default `PAT`; else 16 bytes: for pattern index `pi = (type-1)*2 + side` the even-row byte at `+2*pi`, the odd-row byte at `+2*pi+1`; side 0 = the ray hit an x-facing wall, 1 = a y-facing wall as in the spike),
  `+9 DB flags` (reserved, 0).
* **Conventions.** World position x, y: 16-bit unsigned **8.8** (`cell = high byte`; 0..`map_w*256-1`). Angle: 0..255, 256 to a turn; direction = (cos a, sin a); **angle 0 looks along +x (east), 64 along +y, which is down the map rows (south)**; angle increases clockwise as drawn. Field of view 60 degrees (camera-plane projection, no fisheye; plane length 0.578 as the spike). The sine table is the spike's: `Q[k] = round(4096 * sin(k*pi/128))`, k = 0..64, mirrored to 256 entries `C[a]` (4.12); `SIN(a) = C[(a + 192) AND 255]`.
* **Routines (all CALLs; clobber AF BC DE HL; IX, IY, alternates preserved; no `DI` that outlives the call):**
  `RT_VIEW` (HL = x, DE = y, BC = angle, taken `AND $FF`; stores the pose for the next render; positions outside 0..`map_w*256-1` are clamped into the map),
  `RT_COSA` / `RT_SINA` (HL = angle -> HL = `(C[..] + 8) >> 4` arithmetic shift, so -256..256 = 8.8),
  `RT_FXMUL` (HL, DE signed -> HL = `floor(HL * DE / 256)` of the exact 32-bit product, wrapped to 16 bits),
  `RT_WALL` (HL = x, DE = y in 8.8 -> HL = wall type 0..4 of the cell; outside the 32 x 32 array or a negative value -> 1),
  `RT_SETWALL` (`RA_X`, `RA_Y` 8.8, `RA_V` = type; writes only a cell inside the game's `map_w x map_h` and only types 0..4; otherwise ignored).
  `RT_SHOW` / `RT_SHOWF` / `RT_HIDE` / `RT_HIT` as v3 with the ray-mode rules of section 3. `RT_ARGS` / `RA_*` as v2.
* **Billboard info.** Per instance, `BB_TAB[i]` = `DW depth, DW col`, written by the draw of every tick: for an instance that was drawn with at least one visible column, `depth` = its perpendicular distance in 8.8 and `col` = the screen column (0..127) of its centre; otherwise `depth` = 0 and `col` = `$FFFF`. Compiler words `SEEN(s)` (col as a signed value: -1 when not drawn) and `DEPTH(s)` read it (a compiler-emitted table read, like `CAMX()`; the runtime exports `BB_TAB` and its entry size in `runtime.json`). The value is that of the **previous tick's draw** (the game's `PROC FRAME` runs before this tick's draw).
* **Clarifications fixed by language batch 3 (2026-11-10; the compiler, the interpreter and the tests rely on them; details in `ARCADE_LANGUAGE_BATCH3.md`).**
  (1) Positions in `RT_VIEW` (HL, DE) and `RT_WALL` (HL, DE) are **signed** 16-bit values: a negative value is clamped to 0 by `RT_VIEW` and gives wall type 1 from `RT_WALL`; 32768..65535 are negative. `RT_SETWALL`'s `RA_X`, `RA_Y` are read the same way (negative: ignored).
  (2) `RT_COSA` / `RT_SINA` use the **low byte** of HL only (the angle AND 255), whatever H holds.
  (3) `RT_SETWALL`'s `RA_V` is the **whole 16-bit word**: the write happens only for 0..4 as a signed word (256 and -1 are ignored); the compiler does not guard the value.
  (4) `RT_HIT` in ray mode takes the stored positions as **unsigned** 16-bit values: `|dx|` and `|dy|` are the absolute differences of those, compared with `Ra + Rb` (`R = 4 h`).
  (5) Until the first `RT_VIEW` the pose is x = y = a = 0; at boot every `BB_TAB` entry is `depth` 0, `col` $FFFF (so `SEEN` is -1 before the first draw). `SEEN` / `DEPTH` of an instance outside the pool are -1 and 0 (the compiler decides that without reading `BB_TAB`).
  (6) `BB_ENT` (bytes per instance) is read from `runtime.json`; absent, the compiler assumes the 4 bytes above. `BB_TAB` has no fallback address (the compiler refuses `SEEN` / `DEPTH` without it).
  (7) *(runtime engineer, 2026-11-10; `ARCADE_RUNTIME_API_V4.md` "As built")* **The outer ring of the 32 x 32 array is never empty**, so that a ray always stops inside the array (R6) whatever the game does at run time: `RT_SETWALL` also ignores a **type 0 written to a cell on row 0 or 31 or column 0 or 31 of the array** (only a 32-wide or 32-high map has its own outer ring there), and the loader turns a 0 there into 1. The loader reads a map value above 4 as 4 and leaves the cells a short list does not reach at 1. Without this rule an opened ring cell of a 32-wide map lets a ray walk through memory (a shallow ray can loop on a zero cycle of addresses). The interpreter should model the `RT_SETWALL` rule (it changes nothing for a map whose width and height are below 32).
  (8) *(runtime engineer)* `BB_TAB` `col` of a drawn billboard whose centre lies left or right of the view is clamped to 0 or 127.
  (9) *(runtime engineer)* The render casts from the stored pose clamped to cells 1..30 of the array (a viewer on the array's ring, possible with `RT_VIEW`'s clamp for a map narrower or lower than 32, would cast out of it); `RT_VIEW` stores the contract's clamp. Pictures and `BB_TAB` differ only for a viewer inside a ring wall.
* `runtime.json` of v4 lists the routines above and `DIV_VIEW`, `WORLD_RAM`, `BB_TAB`, `BB_ENT`, `GAME_VARS_BASE`, `GAME_VARS_LIMIT`, `MAX_FRAMES`, `SPR_ENT`, `SPR_FRAME_OFF`, `VIEW_W` (128), `VIEW_H` (96).

## 3. Billboards in ray mode

* `SHOW s AT x, y [FRAME f]` stores x, y as unsigned 8.8 world coordinates (no clamp; a position outside the map is simply not drawn). `FLIP` is allowed (mirrored frames as v3). `HIDE` as v3.
* **World size.** A sprite is a square of side `h / 32` cells (`h` = the asset's height in pixels; the asset is expected to be square; a non-square asset is stretched to a square); it stands on the floor, centred on (x, y). A 32-pixel sprite is as tall as a wall, a 16-pixel one half as tall.
* **Projection.** Transform to the camera frame; skip if behind the camera or closer than 1/4 cell or farther than the map allows; screen column of the centre and size from the same fixed-point tables as the walls (the hgt table: drawn height in rows = `size_cells * 2 * HGT[dist]`). Drawn at ray-grid resolution: `colw`-pixel columns, source column by nearest neighbour; source rows by nearest neighbour with the same accumulator method as `sprite.asm`.
* **Depth test.** A column is drawn only where the sprite's distance is less than the wall's distance for that ray (compare the distances, or equivalently the `HGT` heights: the sprite column is drawn if its height is greater than the wall's `hh` for that ray; at equal distance the wall wins). Sprites are drawn **after** all walls of the tick, far to near by depth (stable for equal depth, lower instance first).
* **Pixels.** `bg = (bg AND mask) OR image` per source pixel where the mask bit is the sprite's transparent bit (1 = background shows, as v2/v3 frames). Billboard pixels never write attributes.
* **`RT_HIT` in ray mode:** instances a, b overlap when `|dx| < Ra + Rb` and `|dy| < Ra + Rb`, with `R = h * 4` (1/256 cells; half the world side), taken from the assets' `h`; hidden instances never hit. (The `hot` box is ignored in ray mode.)

## 4. Per tick (ray mode)

(1) `frame_entry`; (2) the game's `PROC FRAME` runs (calls `VIEW`, `SHOW`...); (3) `redraw_dirty` for the cells outside the window; (4) cast one ray per column from the stored pose, draw the walls (method B), then the billboards, into the hidden display file; (5) update `BB_TAB`; (6) flip request. A tick in which the pose, the map and the instances did not change may still redraw (no skip analysis needed). The result must equal the JS reference renderer for every pose (section 8).

## 5. Budgets (TSRun, no contention; **the engineer reports measured numbers**)

| Item | Target |
|---|---|
| Render (cast + walls), 128 x 96, 4 px, 16 x 16 map, worst of 16 spike poses | <= 158,500 T (spike 158,344) |
| same, 2 px | <= 272,000 T (spike 271,681) |
| 32 x 32 map | up to +10 % of the above |
| One 16 x 16 billboard at 4 px columns, drawn | <= 9,000 T (spike 8.0k, which excluded the depth test; allow it). **As built: 15,145 T, not met** (projection 4.5k + code generation 5.2k + rows 6.1k; the spike's 8.0k was its kernel alone, one byte per source pixel, OR only, no projection or clipping); see `ARCADE_RUNTIME_API_V4.md`, deviation 1 |
| One 32 x 32 billboard at 4 px | <= 31,000 T. **As built: 40,321 T, not met** (rows 27.1k alone: 85 T per drawn column-row with the mask; the reason above) |
| Scene-start table build | <= 60 refreshes |
| Runtime size | <= 16,384 bytes (DOCK chunks 0-1) |

The engineer is free to tune below the spike (its profile shows 20-30 % headroom in casting) and reports the real numbers in `ARCADE_RUNTIME_API_V4.md` ("As built").

## 6. Language batch 3 (compiler and interpreter; `ARCADE_LANGUAGE.md` changelog 0.3)

```
MAP level = "level1"                         REM existing: the map asset; for VIEW3D cells are wall types 0..4, 4..32 x 4..32, outer ring non-empty
VIEW3D level                                 REM top level, once; a game with a WINDOW cannot have it
VIEW3D level COLW 2 INK 7 CEIL 1 FLOOR 5     REM clauses, any order, each once: COLW 2|4 (default 4), INK 0..7 (wall ink), CEIL / FLOOR 0..7 (paper above / below the horizon); BRIGHT 0|1 (default 1)
VIEW x, y, a                                 REM statement: viewer pose, x, y in 8.8 (1/256 cell), a angle 0..255 (taken AND 255)
COSA(a)   SINA(a)                            REM -256..256 (8.8) per section 2
FXMUL(a, b)                                  REM floor(a * b / 256), exact 32-bit product
WALL(x, y)                                   REM wall type at the 8.8 position (outside the map: 1)
SETWALL x, y = t                             REM statement; t 0..4; x, y 8.8; outside the map ignored
SEEN(s)   DEPTH(s)                           REM billboard info of the previous tick (section 2); SEEN = -1 when not drawn, DEPTH in 8.8
SHOW s AT x, y [FRAME f] [FLIP]              REM x, y 8.8 world coordinates in ray mode
```
* `attr_top` = BRIGHT bit | CEIL paper | INK; `attr_bottom` = BRIGHT | FLOOR paper | INK; Defaults without clauses: INK 7, CEIL 0 (black), FLOOR 1 (blue), BRIGHT 1; the compiler may choose better ones but documents them in `ARCADE_LANGUAGE_BATCH3.md`. Wall pixels are ink, so every window cell has the same ink; the ceiling and the floor differ by paper.
* **Checks (errors with line and column):** `VIEW3D` twice, inside a scene or in a program with `WINDOW`; `WINDOW`, `BAND`, `CAMERA`, `CAMX`, `SETWORLD`, `WORLDTILE`, `TILEFLAGS`, `TILEHIT`, `SOLID` in a `VIEW3D` program (they need v3; one message); `VIEW`, `WALL`, `SETWALL`, `SEEN`, `DEPTH` without `VIEW3D`; the map outside 4..32 per side, a cell value above 4, an empty cell on the outer ring; `COLW` not 2 or 4; a clause value out of range. **Warnings:** the `FRAMERATE` divisor below 3 (colw 4) or 5 (colw 2); a non-square billboard asset. `COSA`, `SINA`, `FXMUL` are plain functions available in every program on v4 (and are errors on v2/v3: "needs the v4 runtime").
* The cell-map words (`TILE`, `FILL`, `PRINT`, `LOADMAP`...) work for the cells outside the 16 x 12 window; inside it they are never drawn.
* `requiredRuntime` returns version 4 for any of: `VIEW3D`, `VIEW`, `COSA`, `SINA`, `FXMUL`, `WALL`, `SETWALL`, `SEEN`, `DEPTH`. `arcadec --runtime auto` and the Studio use it.
* **Link report** (`usage`): map source bytes (encoded and 1,024 expanded), the view descriptor, the runtime-owned memory (tables) as a fixed note.
* **Reference interpreter** (`arcade-interp.js`): models `VIEW`, `COSA`, `SINA`, `FXMUL`, `WALL`, `SETWALL` on a model of the 32-stride map, and the unclamped 8.8 `SHOW`; `SEEN`/`DEPTH` return what the test harness injects (a settable table; default not seen) because they depend on the renderer, and the differential tests inject the runtime's real values. Pixels are checked by the runtime's own tests.

## 7. Studio

The Studio picks the v4 runtime for such a program (as it does v2/v3). `arcade/dist/v4/` is published by `publish-runtime.mjs`. A map editor is Studio slice S2 (planned); until then the example's map is generated by a script like the other assets.

## 8. Acceptance (the slice is done when all of these hold)

1. `arcade/examples/vaults.arc` (+ generated assets and notes): a 24 x 24 or larger maze with all 4 wall types, a door (`SETWALL`) opened with a key picked up as a billboard, at least 4 enemy billboards that chase and can be shot (using `SEEN` / `DEPTH`), pickups, a HUD (health, keys, score) in the cell map outside the window, turning and moving on keys and the joystick, sound effects, a title and a won/lost state. Plays on TSRun, ZEsarUX 13.0 and Fuse 1.9.1 (screens compared as the earlier games).
2. Runtime tests (TSRun, stock ROMs): the window bitmap equals the JS reference for >= 200 poses per column width (random positions including fractions of exactly 0, axis-aligned angles, 0.2 cells from a wall, long corridors; 16 x 16 and 32 x 32 maps; both display files; bitmap preloaded with garbage so stray writes show), attributes of the window cells, cells outside the window untouched; billboards against an independent JS column-scaler (sizes 8 to 48, frames, FLIP, depth against walls, behind the camera, at the edges of the view, several overlapping, mask); `RT_COSA/SINA/FXMUL` against JS over the full range; `RT_WALL/SETWALL` against a model; `RT_HIT` in ray mode; `BB_TAB`; register preservation with injected interrupts; memory-write confinement; a header without `DIV_VIEW`; a mutation run of >= 40 deliberate bugs in `ray.asm` (killed or justified).
3. Compiler tests: parser/checker positive and negative for every new word and error, interpreter semantics, a differential run (state equality per tick) of `vaults.arc` against the runtime for >= 600 ticks with scripted input and injected `SEEN`/`DEPTH` equal to the runtime's, fuzzed `WALL`/`SETWALL`/`FXMUL`/`COSA`/`SINA` queries (>= 3,000) against the interpreter. All existing suites stay green (`node arcade/tests/run-all.mjs`, the Studio and original IDE suites).
4. Measured: the budgets of section 5, written into `ARCADE_RUNTIME_API_V4.md`, plus the worst tick of `vaults.arc` on the real runtime.

## 9. Not in this slice, and why

* **1-pixel columns and interpolated rays**: rejected by measurement (1 px at 128 wide: 7.5-9.5 ticks/s; interpolation drops thin pillars and adds 313 bytes). Revisit only if a game needs a smaller window with 1 px, which the same code would not serve.
* **Textured walls**: rejected by measurement (~100 T a pixel, ~10 refreshes a frame at 128 x 96).
* **Floor and ceiling textures, variable heights, Doom-like sectors**: not achievable on this hardware (spike verdict).
* **Per-column wall colour**: needs 8-pixel columns and an attribute write per cell; not a Wolfenstein-class need. If wanted, groups with the Studio asset/colour tooling.
* **Pre-scaled billboard sets**: an optimisation (10x cheaper per pixel) with no need yet: the budget fits 3-6 enemies at 4 px columns. Groups with the first game that measures it as the limit.
* **Mouse look, strafe, doors that slide**: game-level (angles and `SETWALL` are in the language).
* **Music** and **scenes in the compiler**: separate planned items (M4b, gap-list #8); unrelated to the renderer.
* **Real hardware** (the SCLD / contention question, `ARCADE_HARDWARE_NOTES.md`): needs the owner's machine. Every number here is TSRun-only; the draw share (25-50 % of the frame) is the part that real contention could slow.
