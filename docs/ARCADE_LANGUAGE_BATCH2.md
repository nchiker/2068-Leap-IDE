# Leap Arcade language batch 2: the scrolling window (2026-11-09)

The language half of the platformer slice. The binding contract is `docs/ARCADE_PLATFORMER_CONTRACT.md` (sections 3b, 4, 5, 7, 8); this file records
what the compiler and the reference interpreter do where that contract is silent, and what the runtime engineer must match. Code:
`src/lang/arcade/` (`arcade-words.js`, `arcade-parse.js`, `arcade-check.js`, `arcade-codegen.js`, `arcade-link.js`, `arcade-interp.js`,
`arcade-assets.js`, the new `arcade-window.js`, `arcade-compile.js`). Tests: `tests/arcade-m6-compiler.mjs` (275 checks, no real runtime needed),
`tests/arcade-m6-differential.mjs` (the same comparison on the real v3 runtime; skips until `arcade/build/v3/runtime.json` has `RT_CAMERA`),
helpers `tests/arcade-m6-common.mjs` and `tests/arcade-m6-mock.mjs` (a mock runtime: JavaScript traps for the new routines, written from the contract and from
the image the linker wrote). Programs that use none of the new words compile to the same bytes as before (`arcade/tests/fixtures/batch2-baseline.json`).

## The words

```
WINDOW level [AT cx, cy]       top level, once; the MAP `level` is the world; the window is 24 x 16 cells at screen cell (cx, cy), default (4, 4); cx, cy constants 0..8
BAND rows, num, den            top level, 0 to 4 times, in order from the top of the window; rows 1..16 adding up to 16; num/den one of 0/1 (fixed) 1/4 1/2 1/1 2/1
CAMERA x                       statement: the camera (the world x at the window's left edge), clamped to 0..cam_max (signed value)
CAMX()                         the clamped camera
SETWORLD x, y = t              statement: the cell holding the world pixel (x, y) becomes tile t
WORLDTILE(x, y)  TILEFLAGS(x, y)  TILEHIT(x, y, w, h, mask)  SOLID(x, y, w, h)
SHOW s AT x, y [FRAME f] [FLIP]
```
`WINDOW`, `CAMERA`, `SETWORLD`, `CAMX`, `WORLDTILE`, `TILEFLAGS`, `TILEHIT`, `SOLID` are reserved words (a variable called `solid` must be renamed). `BAND` was reserved
by batch 1 as the bit function `BAND(a, b)`; it is now also the top-level statement (a statement starts a line, the function is always followed by a bracket;
inside a PROC `BAND 16, 1, 1` gets a "must be at the top level" message). `FLIP` is **contextual like `FRAME`** (not reserved), so a variable called `flip` keeps working.

## Decisions where the contract is silent

**Syntax and checks**
1. `WINDOW` and `BAND` may stand anywhere at the top level; `BAND` rows are taken in source order. `BAND` without `WINDOW` is an error. No `BAND` = one band of 16 rows at 1/1.
2. `cx`, `cy`, and a `BAND`'s three numbers are **constant expressions** (literals, CONSTs, `+ - * DIV MOD`, the bit functions). Ratios are strict: only the five of the
   contract (`0/2` is not "fixed"; `3/4` is an error that lists the allowed ones). The rows must add up to 16: the error is on the band that passes 16, or on the last band when the sum is short.
   A window with no 1/1 band is a **warning** (the gameplay layer should be one).
3. The MAP a `WINDOW` uses is the **world**: it is not in the map table, not loaded into the screen cell map at boot, and `LOADMAP` of it is an error. Any other MAP
   (the HUD) works as before; with `DIV_WIN` the header is always the extended one (map_table at +16, zero when there is no map table).
4. `CAMERA`, `SETWORLD`, `CAMX()`, `WORLDTILE`, `TILEFLAGS`, `TILEHIT`, `SOLID` without a `WINDOW` are errors reported by the **code generator**, not the checker
   (the old table test `tests/arcade-parse.mjs` calls every function of the word table without a window). With a runtime older than v3 every new word is an error that
   says "needs the v3 runtime (... build with --runtime v3)" (`check(ast, {version})`; `check(ast)` with no version assumes nothing and stays quiet).
5. A sprite wider than 16 or taller than 16 on a v2 runtime keeps the old message and adds "needs the v3 runtime". `SHOW ... FRAME 0` (the literal) is a plain `SHOW` on a
   pre-v3 runtime (it can only mean frame 0); any other FRAME there keeps "SHOW ... FRAME is not supported yet in M4a" and adds the hint. `requiredRuntime(text, assets)`
   (exported from `arcade-compile.js`) says which runtime a program needs (`{version: 2 | 3, reasons}`) for a caller that has both: WINDOW, BAND, CAMERA, SETWORLD, the five functions,
   FLIP, a FRAME other than the literal 0, a sprite wider or taller than 16. (`arcadec --runtime auto` and the Studio's choice are not wired: `arcadec.mjs` and the profile are outside this batch.)
6. `TILEHIT` / `SOLID` cannot stand inside the arguments of `FILL`, `FILLC`, `COPY`, `SETWORLD`, `TILEHIT` or `SOLID` (also through a `DEF FN` that uses one): they all share the
   runtime's argument block `RT_ARGS`, and the inner call would overwrite the arguments stored so far. A code generator error says "put it in a variable first".

**The world map** (`convertWorldMap`)
7. 24..128 cells wide, 1..16 tall. Cell = a tile index 0..31; **blank (-1, null, 255) is tile 0** (the sky); an index above 31 is an error; an index the tileset does not define is an error
   ("tile with no definition"). `world_src` has row r at `r * 128`, cell = tile * 8; columns beyond the width and rows beyond the height are 0, and **WORLD_RAM rows 0..15 are all inside the
   world** (a 9-row map has 7 empty rows, not solid ones). The map errors are reported at the map name of the `WINDOW` line. A warning when tile 0 of the tileset is not blank.
8. `cam_max = floor((world_w * 8 - 192) / maxratio)`, maxratio 2 if any band is 2/1, else 1 (the contract's formula, also when all bands are slower: 128 wide, 1/4 only: 832).
   `CAMERA` clamps the **signed** 16-bit value (`CAMERA px - 96` with px < 96 gives 0); `CAMX()` is 0 until the first CAMERA.
9. Tile flags: the tileset's per-tile `flags` (0..255, default 0) for tiles 0..31; tiles the set lacks have flags 0. A bad value is an error only in a game with a WINDOW.

**Collision semantics** (the interpreter; `arcade-window.js` `worldTile` / `tileFlags` / `tileHit`; the runtime must agree)
10. Coordinates are world pixels: column `x >> 3` (arithmetic shift), row `y >> 3`. Inside the world = column `0..world_w-1`, row `0..15`.
11. `WORLDTILE` outside is 0. `TILEFLAGS` outside: **below the world (row >= 16) is 0, wherever the column is; otherwise left, right and above are 1 ("below wins at a corner")**.
12. `TILEHIT(x, y, w, h, mask)` ORs `flags AND mask` over the cells of x..x+w-1, y..y+h-1; sums are exact (no 16-bit wrap). **w <= 0 or h <= 0 gives 0** (the contract says w, h >= 1; the compiler does
    not guard a run-time value, so the runtime must return 0 for a rectangle of no pixels, w and h being signed 16-bit). `SOLID(x, y, w, h)` is `TILEHIT(x, y, w, h, 1)`; the compiler passes the mask 1.
13. `SETWORLD x, y = t` takes world **pixels** (like the collision words), writes `t * 8`, ignores a cell outside the world. The compiler guards `t`: it is ignored unless
    `0 <= t < min(32, tile count)` (as TILE ignores a tile outside the tileset); a constant `t` in 0..127 outside that range is an error. The runtime therefore only ever sees valid tiles.

**SHOW, frames and sprites**
14. Evaluation order: instance index, x, y, then the frame. `FRAME f` and `FLIP` may come in either order, each once. Registers: `RT_SHOWF` A = instance, BC = x, DE = y, HL = frame
    (the low byte matters: `AND $FF`, and the runtime clamps at draw time). A plain `SHOW` calls `RT_SHOW` and **keeps the instance's frame** (0 at the start; `HIDE` keeps it too). The
    interpreter stores `(f + n if FLIP) AND $FF` (`opts.clampFrame` clamps to the compiled frame count - 1 instead, if the runtime clamps when storing: to confirm).
15. **Which frames are compiled.** All frames of the sprite asset when some `SHOW` of it (any instance, any PROC) has a FRAME other than the literal `0` (a CONST that is 0 counts as "not the literal 0": all frames);
    otherwise only frame 0 (nframes 1), so an asset with many frames the game never animates costs nothing. With `FLIP` on any `SHOW` of the asset the mirrored copies are appended: frames n..2n-1, n being
    the number of compiled source frames. `SHOW s AT x, y FLIP` is frame 0 + n. A constant FRAME outside 0..n-1 is an error (with FLIP too: n is the unmirrored count). More than 32 frames in an
    asset that is animated, or more than 16 with FLIP, is an error. The `frames` array wins over `rows` when both are present (and frame 0 comes from `rows` when the asset is never animated, as in v2).
16. A v3 sprite descriptor has the true width (8, 16, 24, 32) and `nframes`; a width that is not a multiple of 8 (12, say) is padded on the right with transparent pixels (the hot box default keeps the true width);
    the mirror is within the true width. Heights 1..48. The collision box (`hot`) is not mirrored. Frame data is nframes blocks of h rows of wb mask bytes then wb image bytes (the v2 row generalised).
17. Positions: in a window game `SHOW` stores x, y as signed 16-bit **unclamped**; a v3 game without a window clamps per asset to `0..256-w`, `0..192-h` (the contract, section 2: 240 and 168 for a
    16 x 24 sprite; the v2 runtime stops at 239 and 176: **the runtime engineer must follow the contract here**). `SPR_TAB` entries in the interpreter's records: `{visible, asset, x, y, frame}`.

**The image and the report**
18. Header: `frame_div | $C0` (DIV_EXT and DIV_WIN), 20 bytes, `window_desc` at +18, descriptors at `$8014`. After the sprite data: `world_src` (2,048), `tile_flags` (32), `tilerows` (256), `window_desc`
    (14 + 2 per band). The 3,584 table bytes sit at the very end of the game area (**`tables` = `$B200`**, page aligned by construction); if the rest does not fit the linker says how many bytes too many.
19. Phase memory: a faithful port of the runtime's boot plan (`planPhasePool()` in `arcade-window.js`; `docs/ARCADE_RUNTIME_API_V3.md` "The phase memory: a frame cache per asset"; the runtime tests' JS reference
    is `planPool()` in `arcade/tests/m6-common.mjs`, and a test compares the two on 500 random asset sets): FTABs (4 x nframes per used asset), `min(nframes, instances)` frame slots of
    `(phases - 1) x h x 2 x (w/8 + 1)` bytes for every used asset with phases > 1, then more slots asset by asset while they fit, everything first fit over `POOL_A`, `POOL_B`, `POOL_C` (addresses and lengths
    from `runtime.json`, defaults $C080 3,456 / $F200 2,176 / $D700 256; `PHASE_POOL_BYTES` is the capacity the report shows). **The link fails exactly when the runtime would stop at boot with the magenta border**
    ("N bytes of sprite art do not fit in the phase pool", N = the runtime's `FC_MISS`), for every v3 build. **The code generator warns once per asset whose K < nframes** (at its SPRITE line): "asset X: only K of N
    frames stay cached; a frame that is not cached is built when first drawn (about T cycles for this size) ...", T = the measured table of the runtime document scaled by area x (phases - 1) (`buildFrameT`, a
    least-squares fit, to the nearest 100: 16x24/4 gives about 25,900 where 32,088 was measured).
20. `usage` (the linker's report) gains, for a v3 build: `frames` (sprite frame bytes), `window` ({worldSource, tileFlags, tileRows, descriptor, scrollTables, camMax, worldW, bands, at: {addresses}}), `phaseRam`
    ({needed (the fragmentation-free minimum), available, miss, K, perAsset}) and `gameVars` ({used, available}, from `GAME_VARS_BASE` / `GAME_VARS_LIMIT` of `runtime.json`); `usageLines(usage)` renders them. A variable overflow reports the byte counts.

## What the runtime engineer must match
* The header and `window_desc` as above; `V_CAM` and `WORLD_RAM` before PROC INIT: `V_CAM` 0, `WORLD_RAM` loaded from `world_src` (and rows/columns outside the map 0).
* `RT_SHOWF` as in item 14 (HL = frame; clamp at draw); `RT_SHOW` keeps the frame; `SPR_TAB` byte 1 (asset) set at boot for every declared instance; v3 non-window clamp `256 - w` / `192 - h`.
* `RT_TILEHIT`: `RA_X RA_Y RA_W RA_H RA_V`, w/h <= 0 gives 0 (item 12); `RT_SETWORLD`: `RA_X RA_Y RA_V`; `RT_WORLDTILE` / `RT_TILEFLAGS`: HL = x, DE = y, signed 16-bit, any value; the corner rule of item 11.
* `RT_CAMERA`: signed clamp to `0..cam_max` (item 8).
* The constants the compiler reads from `runtime.json`: `GAME_VARS_BASE`, `GAME_VARS_LIMIT`, `V_CAM` (a constant or symbol), `RA_*` / `RT_ARGS`, `DIV_EXT`, `DIV_WIN` (default `$80` / `$40`), `PHASE_POOL_BYTES` (fallback 5,600).

## Tests
`node tests/arcade-m6-compiler.mjs` (about 20 s; `ARCADE_QUICK=1` shrinks the fuzz): parser/checker positives and negatives for every word and every error of section 7, the word table, the data builders against independent
bit-string shifts and reversals, the interpreter hand-computed, the image layout read back from the DCK (header, descriptors, window_desc, tables, mirrored frames), the refusals, the link report, the compiled platformer
(600 ticks) and two more window programs on the mock runtime equal to the interpreter tick by tick, SHOW in every register shape, **3,367 collision queries** (WORLDTILE, TILEFLAGS, TILEHIT, SOLID, with SETWORLD between them,
worlds 24..128 wide, queries inside and outside) equal to an independent per-pixel model on both the interpreter and the compiled code, and the byte-identity of five old programs.
`node tests/arcade-m6-differential.mjs`: the same programs on the real runtime (skips with a message until it has the routines; checks its own harness on v2 meanwhile).

## Proposal (not implemented): a compressed `world_src`
`world_src` is 2,048 bytes in the image whatever the level. Measured on `arcade/examples/platformer.arc` (128 x 16, 956 non-zero cells, 230 runs in row-major order; the game area is 16,288 of 16,384):

| scheme (row-major, 2,048 cells) | bytes | saves |
|---|---|---|
| byte RLE, pairs (count 1..255, value), a 0 count ends | **463** | 1,585 |
| zero-run + literal (control byte: 1..127 zeros, or $80 + n then n literal bytes; 0 ends) | 1,066 | 982 |
| the same two, column-major | 1,627 / 1,304 | 421 / 744 |

Byte RLE in row-major order clears the 1,000-byte bar by a wide margin (the sky and the ground are long runs of one value). The decoder is a short loop at scene start that expands into `WORLD_RAM`
(about 30 bytes of Z80, one pass of 2,048 stores; `RT_WORLDLOAD`-style routine owned by the scroll engineer), so the window_desc's `world_src` would point at the compressed stream and carry
a format flag (e.g. a bit of `nbands`' high nibble or a new descriptor byte). The compiler already has the map as cells: emitting the stream is about 15 lines in `arcade-link.js`. Not done: the binary encoding is unchanged until the contract is edited.
