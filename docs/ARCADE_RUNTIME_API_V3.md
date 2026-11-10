# Leap Arcade runtime API v3

The contract is `docs/ARCADE_PLATFORMER_CONTRACT.md` (binding: sections 1, 2, 3b). v3 extends v2 (`docs/ARCADE_RUNTIME_API_V2.md`, including
"As built: language batch 1"); v0-v2 and their tests are untouched. Source `arcade/runtime/v3/`, build `node arcade/tools/build-runtime-v3.mjs` ->
`arcade/build/v3/` (`runtime.json` with `"version": 3`, 413 symbols, 122 constants).

## As built (v3 part 1: sprite frames, bigger sprites, memory re-plan), 2026-11-09

Part 1 is everything of the contract except the scrolling window, the collision routines and `RT_CAMERA` (part 2, another engineer, same directory).
**Size:** runtime 11,132 of 16,384 bytes in DOCK chunks 0-1 (v2: 9,337), so about 5.2 KB are left for part 2.

### Memory map v3 (`layout.inc`)

Chunk 7 is the contract's section 1 exactly; chunk 6 is v2's with three changes (SPR_TAB 128 bytes, AST 128 bytes, ROW_TAB gone).

| Range | Use |
|---|---|
| `$C000-$C07F` | `PHASE_OFF`: 8 assets x 8 shifts x DW, the offset of shift s's copy inside a frame slot of asset a (`+ 16 a + 2 s`) |
| `$C080-$CDFF` | `POOL_A`, 3,456 bytes of the phase pool. v2's `ROW_TAB` (384 bytes) is gone: `draw_all` computes the row address (about +15 T per sprite), which makes POOL_A large enough for the v2 worst case and for one 32 x 48 slot at 8 phases |
| `$CE00-$D3FF` | `CELL_TILE`, `CELL_ATTR` (as v2) |
| `$D400-$D45F` / `$D460-$D4DF` / `$D4E0-$D4FF` | `DIRTY0` / `SPR_TAB` (16 x 8 bytes) / `T2` free (32) |
| `$D500-$D55F` / `$D560-$D5DF` / `$D5E0-$D5FF` | `DIRTY1` / `SPR_DRAWN` (2 x 16 x 4) / `T4` free (32) |
| `$D600-$D67F` / `$D680-$D6FF` | `TILE_ATTR` / `AST` (8 x 16 bytes) |
| `$D700-$D7FF` | `POOL_C`, 256 bytes |
| `$D800-$DFFF` | `GLYPH_TAB` (as v2) |
| `$E000-$E0FF` | runtime variables (v2's, plus draw scratch in the formerly free `$E04E-$E05D`); `$E0FC-$E0FF` free |
| `$E100-$E1FF` | `V3VARS`, zeroed at boot. `V_CAM` = `$E100` (word, 0 in part 1). **`$E102-$E1BF` are left for part 2.** `$E1C0-$E1FF` the frame cache's scratch (`FC_*`, `BF_*`) |
| `$E200-$E9FF` | `GAME_VARS` (2,048 bytes; `GAME_VARS_BASE` / `GAME_VARS_LIMIT` in `runtime.json`) |
| `$EA00-$F1FF` | `WORLD_RAM` (2,048, page aligned), zeroed at boot, not used by part 1 |
| `$F200-$FA7F` | `POOL_B`, 2,176 bytes |
| `$FA80-$FAFF`, `$FB00`, `$FB02-$FEFF`, `$FF00+` | as v2 (tile-operation RAM, canary, 1 KB stack, hand-off) |

Boot zeroes `$E000-$F1FF`. The runtime's own stack depth in a tick is 26 bytes when `draw_all` builds a frame (`draw_all` > `fc_miss` > `build_frame`),
plus 10 for an interrupt (measured); this happens after `frame_entry` has returned, so compiled code keeps the 1,012 bytes it had in v2.
`$5B00-$5FFF` and `$7B00-$7FFF` (the display files' tails, RAM in the play mapping) are still unused.

### Header and descriptor

* `frame_div AND $3F` is the divisor. Bit 7 `DIV_EXT` (map table at `$8010`) as v2; bit 6 `DIV_WIN` (`$40`, 20-byte header, `$8012 DW window_desc`)
  is accepted and ignored by part 1 (a header with `DIV_WIN` and a nonsense `window_desc` boots and runs; tested).
* Descriptor (8 bytes): `DB w, DB h, DW data, DW hot, DB phases, DB nframes`. Boot clamps: w <= 8 -> 8, <= 16 -> 16, <= 24 -> 24, else 32; h 0 -> 1, > 48 -> 48;
  nframes 0 -> 1, > 32 -> 32 (`MAX_FRAMES`); phases as v2 (the largest of 1, 2, 4, 8 not above the value); hot 0 = (0, 0, w, h). Frame f's rows are at
  `data + f * h * 2 * wb` (wb = w/8; a row is wb mask bytes then wb image bytes). A v2 descriptor (pad byte 0) reads as one frame.
* `SPR_TAB` entries (`SPR_ENT` 8): `DB visible, DB asset, DW x, DW y, DB frame, DB 0`; `SPR_FRAME_OFF` 6. Byte 7 is never written.

### Routines (CALL; clobber AF BC DE HL; IX, IY and the alternate set preserved; no `DI`)

| Routine | In | Out / effect | T (CALL + RET) |
|---|---|---|---|
| `RT_SHOW` | A = instance, BC = x, DE = y (signed) | visible at the clamped position, **frame kept** | 455-567 (28 for index >= ninst) |
| `RT_SHOWF` | as `RT_SHOW`, **HL = frame** (taken AND $FF) | the same, frame set | 455-555 |
| `RT_HIDE` | A = instance | visible = 0 (x, y, frame kept) | 72 |
| `RT_HIT` | A, E = instances | HL = 1 / 0 (stored positions, the asset's box, any frame) | 188 (one hidden) .. as v2 |

Non-window clamps are per asset: x 0..256-w, y 0..192-h (8x8: 248 / 184; 16x24: 240 / 168; 32x48: 224 / 144); the high bytes are stored 0.
Nothing changed (visible, x, y and frame equal): nothing is written; otherwise the entry is written and `V_CHG[i] = 2` (a frame-only change counts).
`draw_all` clamps the frame to nframes - 1. **Window mode (part 2) must add its own branch: unclamped signed positions.**

### The phase memory: a frame cache per asset

**Why not exact allocation per asset-frame-phase:** the contract's reference art set needs 11,760 bytes that way (player 16 x 24 x 16 frames x
4 phases alone 8,448), and still 9,760 with shift 0 drawn from the game image, against about 5,600 bytes of pool. So:

* **Shift 0 is never copied:** it is drawn straight from the frame's rows in the game image (DOCK chunks 4-5, always mapped). A 1-phase asset needs
  no pool memory beyond its FTAB.
* Every asset with at least one instance has an **FTAB** in the pool: nframes x (DW rom = the frame's rows, DW slot = its frame slot or 0).
* An asset with phases > 1 has **K frame slots**; a slot holds one frame's copies for every non-zero shift: `(phases - 1) x CLEN` bytes,
  `CLEN = h x 2 x (wb + 1)` (a copy row is wb + 1 (mask, image) pairs; shift s's copy at `slot + PHASE_OFF[a][s] = slot + (s/g - 1) x CLEN`, g = 8/phases).
* **K = nframes:** every frame is built at boot and stays (no run-time cost at all; every v2-style image and every set that fits is like this).
  **K < nframes:** a cache. Frames 0..K-1 are built at boot; a frame that is not in a slot is built when it is drawn at a non-zero shift (`fc_miss`):
  the victim is the first frame from the asset's round-robin pointer `AST_RR` on that has a slot and that **no visible instance of the asset shows**
  (frames clamped); `AST_RR` = victim + 1 (mod nframes). K >= the asset's instance count guarantees a victim, so nothing thrashes: a draw costs
  at most one build, and a tick only builds frames that changed. `FC_MISSES` counts the builds (statistics).

**The plan (boot, `assets.asm plan_pool`; the linker must make the same one)** -- three pieces `POOL_A` ($C080, 3,456), `POOL_B` ($F200, 2,176),
`POOL_C` ($D700, 256), `PHASE_POOL_BYTES` = 5,888 (all in `runtime.json`); every allocation is **first fit over A, B, C in that order** and never
straddles two pieces:
1. for every asset with an instance, in index order: its FTAB (`4 x nframes` bytes);
2. for every such asset with phases > 1, in index order: `min(nframes, its instances)` slots;
3. for every such asset in index order: more slots, one at a time, while one fits, up to nframes (an asset whose next slot does not fit is left and the
   next asset is tried).

If anything of steps 1-2 does not fit, the boot stops: **border magenta (`POOL_FAIL_BORDER` = 3), interrupts off, no tick**, and `FC_MISS` (`$E1C0`)
holds the bytes that did not fit (the sum of the failed FTABs and slots). Nothing outside the pool is written (tested with every write tracked).
**For the linker:** the costs are `4 x nframes` per used asset plus `(phases - 1) x h x 2 x (w/8 + 1)` per slot, at least `min(nframes, instances)`
slots per used multi-phase asset; the exact answer (fragmentation included) is the plan above, which the JS reference `planPool()` in
`arcade/tests/m6-common.mjs` implements (`poolNeed()` is the fragmentation-free lower bound). Report "N bytes of sprite art do not fit" with N = the
plan's miss. Largest single slot: 32 x 48 at 8 phases = 3,360 bytes (fits POOL_A).

**The reference set** (player 16x24 x 16 x 4 phases; walker 16x16 x 4 x 4; flyer 16x16 x 2 x 4; coin 8x8 x 4 x 8; shot 8x8 x 1 x 8; instances
1 + 3 + 3 + 1 + 4) needs 3,100 bytes at least; the plan gives K = 6, 4, 2, 4, 1: every walker / flyer / coin / shot frame stays, the player has 6 of
its 16 frames cached (6 walkers and no flyer: K = 7; 6 flyers and no walker: K = 8; 1 + 2 + 2 + 1 + 2 instances: K = 8).

### Drawing and erasing (`main.asm draw_all`, `sprite.asm`)

* Blitters for windows of 1..5 bytes and 1..48 rows: pair rows (pre-shifted copies; unrolled 8-row blocks for 2 and 3 pairs, a one-row loop for
  4 and 5) and game-image rows (shift 0: 1 byte = a pair row, 2 bytes unrolled, 3 and 4 bytes looped). The group loop splits the rows at cell
  boundaries for any height. Every pool allocation is even, so a pair never straddles a page and the pair blitters step mask -> image with `INC L`.
* `SPR_DRAWN` keeps 4 bytes per instance and file: `flag, E, D, N` with **N = cell rows << 3 | byte columns** (1..7, 1..5). The erase redraws those
  cells: v2's nine unrolled variants up to 3 x 3 cells, else a loop over cell rows of a one-row variant (1..5 cells).
* The skip analysis works on the new record and on per-asset boxes (a changed instance's box is the join of its exact old record and
  `[x/8, x/8 + wb] x [y/8, (y + h - 1)/8]`); `MASK_TAB` covers 5 columns.

### Measured (TSRun, a refresh is 58,688 T; `arcade/tests/m6-runtime-perf.mjs`)

| Sprite (positions changing every tick) | erase | draw | aligned x, y: erase / draw | v2 |
|---|---|---|---|---|
| 16x16, 8 phases | 2,093 | **3,468** (+3.9 %) | 1,176 / 2,822 | 2,096 / 3,339 (1,196 / 2,574) |
| 16x16, 2 phases | 1,864 | 3,259 | 1,176 / 2,822 | 1,868 / 3,049 |
| 8x8, 8 phases | 1,083 | 1,937 | 512 / 1,376 | 1,091 / 1,772 |
| **16x24, 4 phases, unaligned** | 2,987 | **4,730** (target <= 5,200) | 1,606 / 3,775 | |
| 16x16, 4 phases, unaligned | 2,155 | 3,536 | | |
| 24x16, 4 phases, unaligned | 2,907 | 4,415 | 1,596 / 4,308 | |
| 32x32, 4 phases, unaligned | 5,733 | 9,236 | 3,923 / 11,254 | |
| 32x48, 2 phases, unaligned | 7,960 | 13,315 | 5,739 / 16,454 | |
| 8x8, 1 phase | 727 | 1,515 | | |

* A frame change of a cached frame costs nothing extra (16x24, a new frame every tick: 4,730 T, no build).
* Worst-case tick, 16 visible 16x16 sprites moving, never aligned, screen full of text: **8 phases max 110,343 T** (v2 105,903, +4.2 %),
  4 phases max 107,390 T (v2 102,365). The reference set in non-window mode over text: tick work avg 75,895, max 105,224 T (9 player frames built in 60 ticks).
* **A cache miss** (`build_frame`, one frame's copies): 8x8 / 8 phases 14,250 T; 16x16 / 4 21,512; 16x16 / 8 34,824; **16x24 / 4 32,088 (0.55
  refreshes)**; 24x16 / 4 25,494; 32x32 / 4 59,488; 32x48 / 2 52,176. `fc_miss` adds about 1,400 T (victim search). Built at boot the same way: boot
  with the v2 worst case takes 16 frames from the entry (v2: 14).
* Aligned 24 / 32 wide sprites are dearer than unaligned ones (game-image rows: 62 / 74 T a byte against 40 for pairs).

### Deviations from the contract, and why

1. **Section 1, "exact-size allocation per asset-frame-phase is expected":** impossible for the reference set (above), so the pool is a per-asset frame
   cache (the contract allows a cache; it is per asset, shared by the asset's instances, not per instance, because per-instance slots would not hold
   v2's worst case: 16 instances x 672 bytes). With K = nframes it is exact allocation (shift 0 excepted).
2. **"about 5,600 bytes":** 5,888, because v2's `ROW_TAB` was dropped to make `POOL_A` hold five 672-byte slots: with v2's layout (5,504 in pieces of
   3,072 / 2,176 / 256) the v2 worst case (8 assets of 16x16 at 8 phases, 16 instances: 5,408 bytes) did not fit by fragmentation. Section 3b is untouched.
3. **"a v2-style image must behave exactly as on v2":** the pictures are identical (the v2 scenes of `m4-runtime.mjs` and the worst case run on v3 with
   the picture equal to the model after every refresh), but the clamps follow the contract (x <= 256 - w, y <= 192 - h instead of v2's 239 / 176 for every asset).
4. RT_SHOW is about 100 T dearer than v2 (per-asset clamps, the frame); boot 2 frames longer; both outside the contract's targets.

### Notes for part 2 (window mode) and the compiler

* `draw_all` computes the screen address from y (`V_HBASE` = `$40` + the hidden file's offset); window mode can reuse its middle part with its own
  culling. Shift 0 reads the game image; window-mode clipping is not needed (culled sprites are not drawn).
* **Budget risk for the acceptance game:** a player frame that is not cached costs about 32,000 T in the tick it is first drawn at a non-zero
  shift; on top of a ~135,000 T window repaint that tick overruns 3 refreshes. With the reference set the player keeps 6 to 8 frames; its frames for one
  direction (idle, 4 walk, jump, fall, hurt) are 8. Options if it shows: give the player fewer distinct frames per direction, put fewer instances on other
  multi-frame assets (more slots for the player), 2 phases for the player (1 copy per slot: half the memory, a third of the build), or a later
  refinement that builds only the shift being drawn (about 11,000 T per miss for a 16x24).
* The compiler: the linker's phase-memory check must make the plan above (port `planPool()`): the "every frame in every phase" and "current frame
  per instance" estimates do not describe this runtime (shift 0 costs nothing, slots are per asset, pieces fragment). `RT_SHOWF` takes the frame in HL; `SHOW ... FRAME f FLIP` = `RT_SHOWF` with HL = f + nframes; `runtime.json` has `MAX_FRAMES`,
  `SPR_ENT`, `SPR_FRAME_OFF`, `DIV_WIN`, `WORLD_RAM`, `V_CAM`, `GAME_VARS_*`, `POOL_A/B/C` and lengths, `PHASE_POOL_BYTES`, `FTE_LEN`, `AST_*`,
  `POOL_FAIL_BORDER`, `FC_MISS`.

### Tests (all on TSRun with the stock ROMs; `M6_QUICK=1` shortens them)

| File | What |
|---|---|
| `m6-runtime.mjs` (61 checks) | memory map / runtime.json; descriptor clamps; the plan against `planPool()` and every cached copy against an independent pre-shift; the reference set (fits, runs, picture); pool overflow (magenta, `FC_MISS`, no write outside, the POOL_B wrap); RT_SHOW/SHOWF/HIDE/HIT against the model (5,000 calls); 80 size x phase combinations (w 8/16/24/32, h 1/7/16/24/48, phases 8/4/2/1) with frames and every shift / y offset, both files; 16-instance scenes at frame_div 1..3; the cache against an exact simulation of the replacement rule after every tick; `erase_cells` for all 35 shapes; a `DIV_WIN` header |
| `m6-runtime-pic.mjs` (36) | the v2 scenes of `m4-runtime.mjs` with v2-style images and the v2 worst case; the skip with v3 sprites (on / off); batch 1 tile operations over v3 sprites (`test_ops.asm`, frame_div 1..3) |
| `m6-runtime-regs.mjs` (12) | an interrupt injected at every instruction boundary of draw_all, sprite.asm, the cache, RT_SHOW/F/HIDE, skip.asm, hit_box (63,000 injections); chaos; IX / IY / alternates kept for compiled code across ticks with misses |
| `m6-runtime-mem.mjs` (18) | the map (no overlap, chunks 6-7 fully accounted for); poisoned free areas and unallocated pool bytes never written; in cache mode only slots, FTAB slot words and `AST_RR`; stack depth |
| `m6-runtime-perf.mjs` (9) | the numbers above |
| `m6-mutations.mjs` | 48 deliberate bugs in the v3 changes (the plan, the builder, the cache, draw_all, blitters, erase, RT_SHOW/F/HIDE, hit_box, skip, boot, layout), run in a scratch copy against the four suites above in their quick form: **all 48 killed** (run in 4 shards, `--shard=i/4`, about 4 minutes) |

The JS model (`m6-common.mjs`) is written from the contract and this file: `preShift()` builds a copy pixel by pixel, `Model6.render()` composites the
copies onto display-file bytes (cross-checked against a pixel-by-pixel compositor), `planPool()` and `CacheSim` model the plan and the replacement rule.

## As built (v3 part 2: the scrolling window, sprites in window mode, the camera, collision), 2026-11-09

Part 2 is `arcade/runtime/v3/scroll.asm` (new) plus small window branches in `main.asm`, `api.asm` (`RT_SHOW` / `RT_SHOWF`), `text.asm` (`RT_HIT`) and
`boot.asm`. **Size:** runtime 15,649 of 16,384 bytes in DOCK chunks 0-1 (`scroll.asm` 4,514 bytes); 735 bytes are left (424 of them after `scroll.asm`,
the rest in the gaps `$0005-$0037`, `$0068-$00FF`, `$019C-$01FF`). `runtime.json` gains `RT_CAMERA`, `RT_WORLDTILE`, `RT_TILEFLAGS`, `RT_TILEHIT`,
`RT_SETWORLD` (symbols) and the constants `V_WIN`, `W_*`, `W3_END`, `W_TROWS`, `W_ATTRT`, `W_FLAGT`, `WORLD_RAM_LEN` (with `DIV_WIN`, `WORLD_RAM`, `V_CAM` from part 1).

### Window mode on or off

Window mode (`V_WIN` = 1) is on when `frame_div` has **both** `DIV_EXT` and `DIV_WIN` and `window_desc` passes these checks at boot: the pointer in
`$8000-$BFFF`; `cx`, `cy` 0..8; `nbands` 1..4; `world_w` 24..128; `tables` page aligned with its 14 pages inside the game image (high byte `$80..$B2`);
`tile_flags`, `world_src`, `tilerows` in `$8000-$BFFF`; every band 1..16 rows with `ratio_code` 0..4, the rows adding up to 16. Otherwise the game runs
exactly as part 1 (nothing of the window is written; part 1's test with a `DIV_WIN` header and a nonsense descriptor still passes). The boot then:
expands the byte-RLE `world_src` into `WORLD_RAM` (pairs count 1..255, value; count 0 ends; the expansion stops at 2,048 bytes; a short list leaves the
rest 0), copies `tilerows` to the page `$5B00`, puts the attribute (`TILE_ATTR`) and the flags of tile t at `$5C00 + 8t` and `$5D00 + 8t`, computes the
geometry, sets every band's attribute cache to "none", and **clamps cam_max** to `floor((8 world_w - 192) / max ratio)` (the descriptor's value is
kept when smaller). `V_CAM` is 0.

### Memory map additions

| Where | What |
|---|---|
| `$E061` | `V_WIN` (byte, a formerly free byte of the variables; see deviation 6) |
| `$E100-$E101` | `V_CAM` (part 1) |
| `$E102-$E127` | window state: `W_CX`, `W_CY`, `W_NB`, `W_WW`, `W_TABHI`, `W_BEND`, `W_CAMMAX`, `W_WXR` (8 world_w), `W_WX0/1`, `W_WY0/1` (window pixel bounds), `W_BMBASE`, `W_ATBASE`, `W_DMASK0/3`, `W_BANDS` (8), `W_AC` (8: the col0 whose attributes file 0 / 1 shows per band, `$FF` = none) |
| `$E128-$E1AE` | tick scratch (repaint, `win_draw_all`, the 16 x 4-byte ring records `W_RING`, ring repair) and the routines' scratch (`TH_*` for `RT_TILEHIT`, `WH_*` for the window `RT_HIT`) |
| `$E1AF-$E1BF` | free |
| `$5B00` / `$5C00` / `$5D00` | tile rows (phase-0 copy path) / tile attribute at + 8t / tile flags at + 8t: three pages of display file 1's unused tail, written once by the boot, **in window mode only** |

`$5E00-$5FFF` and `$7B00-$7FFF` stay unused. The stack: a window tick uses at most 26 bytes of the runtime's own (`win_draw_all` > `fc_miss` >
`build_frame`, as part 1) plus 10 for an interrupt (measured, `m7-runtime-mem.mjs`).

### The tick in window mode (`main.asm` `AFTER_FRAME` -> `win_tick` -> `TICK_COUNT`)

1. `frame_entry`; 2. `win_mask_dirty`: the hidden file's dirty bits of the window's cells are cleared (16 rows x 4 bytes: byte 0 AND a mask, bytes 1-2
zero, byte 3 AND a mask; 1,414 T), so `redraw_dirty` never draws a window cell from the cell map; 3. `redraw_dirty` (HUD / border cells);
4. `window_repaint`: every band at `floor(camera x ratio)` (0 fixed, cam >> 2, cam >> 1, cam, cam x 2), bitmap of all 384 cells (V2 tables read from the
game image, the phase-0 copy path through the `$5B00` page, cell-major, boustrophedon, 24 columns unrolled), then per band the attribute pass when the
hidden file's cached col0 of that band differs; 5. `win_draw_all`: sprites after the repaint, no erase, no skip analysis, the part 1 frame / cache
logic (`fc_miss`) and blitters; 6. `ring_repair`; 7. the flip request. Non-window games take the part 1 path (one `LD A,(V_WIN) / OR A / JP NZ` more per
tick); `RT_SHOW` / `RT_SHOWF` / `RT_HIT` test `V_WIN` too (29 T: `RT_SHOW` changing a position now 596 T, under part 1's 600 T bound).

**Column col0 + 24.** The phase <> 0 path reads world column col0 + 24 of each row (the right neighbour of the last cell). It is read only when the band's
position is not a multiple of 8, and then position <= cam_max x ratio <= 8 world_w - 192 gives col0 + 24 <= world_w - 1 <= 127: the read stays in the
band's own world row. cam_max is clamped at boot and `RT_CAMERA` clamps to it, so this holds for any descriptor. The phase-0 path reads columns
col0..col0 + 23 only. Nothing outside `WORLD_RAM` is read; the repaint writes only the window's bytes of the hidden file (tested: everything else of both
files poisoned and unchanged over all sweeps).

**Sprites.** `sx = (x - V_CAM + 8 cx) AND xmask`, `sy = y + 8 cy` (16-bit; a sum that wraps cannot land in 0..255: x - V_CAM + 8 cx < -32768 wraps to
>= 31,936, > 32767 to < 0). Drawn when the footprint lies on the screen and meets the window; a drawn footprint not wholly inside the window gets a ring
record (its cell rectangle); `ring_repair` then redraws, with `draw_cell`, the record's cells outside the window, per row as one run left of the window
and one right of it. Hidden instances and instances that miss cost one test.

### Routines (CALL; clobber AF BC DE HL; IX, IY and the alternates preserved; no DI; interrupts may arrive at any instruction)

| Routine | In | Out | T (CALL + RET, measured) |
|---|---|---|---|
| `RT_CAMERA` | HL = camera (signed) | `V_CAM` = clamp(HL, 0, cam_max) (cam_max 0 in non-window mode) | 118 |
| `RT_WORLDTILE` | HL = x, DE = y (signed) | HL = tile 0..31; outside 0 | 98..290 |
| `RT_TILEFLAGS` | HL = x, DE = y | HL = flags; outside: below (y >= 128) 0 whatever x, else (left, right, above) 1 | 99..285 |
| `RT_TILEHIT` | `RA_X, RA_Y, RA_W, RA_H`, `RA_V` = mask | HL = OR of (flags AND mask) over the cells of x..x+w-1, y..y+h-1 (exact 17-bit edges); w or h <= 0: 0 | 16x24 box: 1,228..1,417 |
| `RT_SETWORLD` | `RA_X, RA_Y`, `RA_V` = tile | the cell = tile x 8 (outside the world: nothing); the attribute caches are invalidated when the new tile's attribute differs | 113..596 |
| `RT_SHOW` / `RT_SHOWF` | as part 1 | window mode: x, y stored signed, unclamped; frame as part 1 | 241 / 203 (non-window: part 1's + 29) |
| `RT_HIT` | as part 1 | window mode: boxes on the stored positions as exact 24-bit values | 2,434 (both visible; non-window: part 1's + 29) |

`RT_TILEHIT` visits only the cells inside the world; rows above / columns beside the world are decided from the clipped ranges (so any rectangle,
x = -32768 or w = 32767 included, is exact). 1..5 columns use unrolled rows; more columns loop and stop early once every bit of the mask is found.

### Measured (TSRun, no contention; `arcade/tests/m7-runtime-perf.mjs`)

`window_repaint`, every camera 0..cam_max into both files, direct calls (interrupts off, as the spikes):

| Layout | worst, every band's attributes included | bitmap only: worst / mean / best | in a running game, the interrupt's time included |
|---|---:|---:|---:|
| 1 band | **124,641** (budget 130,000) | 112,033 / 107,722 / 77,832 | 124,969 |
| 3 bands 2/3/11 at 1/4, 1/2, 1 | 126,433 | 113,613 / 109,292 / 79,330 | 126,761 |
| 4 bands 2/4/6/4 at 1/4, 1/2, 1, 2 | **127,301** (budget 135,000) | 114,375 / 108,942 / 80,051 | 127,629 |

The cost does not depend on the world's content (a solid world and a 53 % sky one give the same numbers: there is no blank-cell path).

The contract's tick (3 bands, player 16x24 4 phases 8 frames, 5 enemies 16x16 4 phases, a shot 8x8; the camera following; the HUD score printed every
tick; 4 `TILEHIT` + 2 `TILEFLAGS`; the real frame interrupt; frame_div 3): the runtime's part of a tick, worst **157,013** T (mean 147,287); + 15,000 of
game logic = **172,013** <= 176,064; with the tick's repaint replaced by the layout's worst repaint: 172,752. Means: repaint 117,319, sprites 25,514 (7),
ring repair 87, `redraw_dirty` 2,316, dirty mask 1,414. With 4 coins more (11 sprites) it does not fit: 181,833.
Sprites drawn in window mode: 16x24 4 phases unaligned **4,677** (budget 5,200), 16x16 8 phases 3,977, 8x8 8 phases 2,403 (part 1's non-window draw
plus about 450 T of culling and 16-bit position work). Ring repair: `draw_cell` 333 + **318** T a repaired cell (budget 600), measured with a 16x24 sprite
straddling the left edge (one cell a row outside; wider overhangs cost less a cell).

**The acceptance game** (`arcade/examples/platformer.arc`, compiled by the compiler of this branch, the recorded play-through to the flag twice, 863
ticks, on this runtime): mean tick 160,605 T; **182 of 860 ticks exceed 3 refreshes**. The game's own logic (`frame_entry`) is 22,980 T on average and up
to 120,256 (55,000-62,000 in the ticks around 186-202); the runtime's part exceeds 176,064 - 15,000 in 25 ticks (worst 173,176 with 34,813 of sprites and
6,050 of ring repair; one tick of 183,290 redraws 44,485 T of HUD cells). So the overrun is mainly the game's logic, then sprites near the window edge.

**Blank-cell path: not included.** (1) The contract's tick fits without it (172,013 / 172,752 of 176,064). (2) It does not fit the ROM: the spike's
path is about +1.1 KB, 735 bytes are left. (3) It makes the worst case worse: on a world without blank cells the spike measured +8 % for the bitmap,
which would take the solid-world repaint to about 134,000 (1 band; budget 130,000) and 137,000 (4 bands; budget 135,000) (estimates from the spike's
ratio, not built). It would help open levels (the platformer's world is 53 % sky; spike: -28 % at 70-76 % blank pairs).

### Deviations from the contract, and why

1. **Section 5, the screen x.** Built: `sx = (x - V_CAM + 8 cx)` rounded down to the asset's phase granularity; the contract says `(x rounded) - V_CAM +
   8 cx`. With a camera that is not a multiple of the granularity the contract's formula gives shifts the asset has no copy for (a 4-phase sprite at an
   odd screen x). The sprite stays on its world position to within granularity - 1 pixels, as before; with the camera following it, its screen
   position does not jitter.
2. **Attribute caches and SETWORLD.** Section 3 runs a band's attribute pass only when the file's col0 changes; a `SETWORLD` that changes a tile's
   attribute would then leave the old colour. `RT_SETWORLD` invalidates every band's cache (both files) when the new tile's attribute differs from the
   old one's (next two ticks pay the passes).
3. **window_desc is validated** (the list above); a descriptor that fails, or `DIV_WIN` without `DIV_EXT`, means non-window mode. The contract is silent.
4. **cam_max is clamped at boot** to the contract's formula (protects the col0 + 24 reads against a wrong descriptor).
5. **Three RAM pages** (`$5B00-$5DFF`, the display file's unused tail): section 3b does not require `tilerows` to be page aligned, and the copy path
   indexes a page; the attribute / flags tables indexed by tile x 8 save about 4,600 T per attribute pass and make the collision loops 26 T a cell.
6. **`V_WIN` is not in V3VARS** (`$E061`): part 1's memory test poisons `$E102-$E1BF` as free in non-window games; a mode flag there would be set by the
   poison. Every other part 2 variable is in `$E102-$E1AE`.
7. **Window cells' dirty bits are cleared every tick** (`win_mask_dirty`, 1,414 T) rather than never set: the cell setters (text, tiles, batch 1 tile
   operations) stay as in part 1.
8. **`RT_HIT` in window mode** is exact (24-bit edges), as the interpreter (exact integers).

### Tests (all on TSRun with the stock ROMs; `M7_QUICK=1` shortens them)

| File | What |
|---|---|
| `m7-runtime.mjs` (36 checks) | boot: the byte-RLE world for 8 encodings (random, runs of 255, exactly 2,048, cut short, too long, the empty list, sky only, a 9-row map), nothing written past `WORLD_RAM`, the three pages, cam_max, 18 bad descriptors refused; `window_repaint` against a pixel-by-pixel reference compositor for **every camera 0..cam_max**, up and down and random jumps, each camera in both files, 11 layouts (1 band; 2/3/11; ratio 2; a fixed band; 4 bands twice; worlds 24, 25, 26, 77, 128 wide; windows at (0,0), (8,8), (8,0), (0,8), (3,5), (4,4)), bitmap and attributes, outside the window unchanged, the attribute pass exactly when a band's col0 changed (10,134 repaints, 4,407 distinct cameras in the full run); whole games compared after every refresh (both files, also the TSRun screen colours): sprites of 6 sizes crossing the four edges and four corners with HUD text and tiles in every cell around the window, sprites off the screen edges (windows (0,0) and (8,8)), random games with camera walks incl. clamps, SETWORLD, collision ops, HIT, HUD printing (also into the window) at frame_div 1..3; after every tick the ring records = the model's; non-window games as part 1 |
| `m7-runtime-api.mjs` (19) | the collision routines against the model (worlds 24, 61, 100, 128 wide; 18,100 random queries incl. extreme values, SETWORLD between them, `WORLD_RAM` compared; 6,864 corner / edge / huge-rectangle queries), the attribute-cache invalidation, `RT_CAMERA`, `RT_SHOW`/`SHOWF`/`HIDE`/`HIT` in window mode (12,000 calls, SPR_TAB compared after each; 3,125 HIT pairs; exact boxes at +-32768, differences of 65,536 and more), IX / IY / alternates kept |
| `m7-runtime-regs.mjs` (12) | an interrupt injected at every instruction boundary of `scroll.asm` and the window branches (26 ranges, 49,396 injections at 3,234 addresses); chaos; IX, IY and the alternates kept across window ticks with cache misses |
| `m7-runtime-mem.mjs` (15) | the map; free areas poisoned (T2, T4, `$E0FC-$E0FF`, `$E1AF-$E1BF`, `$5E00-$5FFF`, `$7B00-$7FFF`, the unallocated pool, `SPR_DRAWN`); play writes only the hidden file, cell map, dirty maps, SPR_TAB, variables, V3VARS to `W3_END`, the cache scratch, GAME_VARS, RT_ARGS, the stack and `WORLD_RAM` in the cells SETWORLD named; the pages and tables unchanged; the stack depth |
| `m7-runtime-perf.mjs` (6) | the numbers above |
| `m7-mutations.mjs` | 73 deliberate bugs in the part 2 code, run against the four suites above in their quick form (`--shard=i/4`, about 3 minutes): **71 killed, 2 survivors, both equivalent and marked so with the proof in the file** (the screen-right-edge test is redundant with the 8-bit window test; `lt24`'s sign bit vs bit 0 cannot change an axis result). Part 1's `m6-mutations.mjs` still kills all 48 |

The models (`m7-common.mjs`) are written from the contract, not from the Z80 code: the window data (tables, tile rows, the RLE world, the descriptor)
are built by the test's own builders, the window is composited pixel by pixel from the tile rows, the sprites pixel by pixel from their source rows,
and the collision model takes one representative of each kind of row / column outside the world.

**Note for the compiler's differential test** (`tests/arcade-m6-differential.mjs`): it fails 3 of its 5 programs on this runtime at the first tick whose
stick input changes, because it sets the joystick at frame boundaries for "the tick about to run", while a window tick starts in the middle of a frame
(STICK then reads the previous tick's value). Setting the joystick when `PROC FRAME` is entered (a scratch copy of the test), all five programs agree
with the interpreter: the miniature platformer (600 ticks), the two short programs, and `platformer.arc` (863 and 375 ticks).

## As built: three-channel effects (language batch 5 Part C, 2026-11-10)

`sound.asm` is the same file in v2, v3 and v4; contract: `docs/ARCADE_LANGUAGE_BATCH5.md` Part C items 16-19. **New variable `V_SFX_CH` = `VARS+$80` (`$E080`; boot zeroes it, 0 = one channel)**, in
`runtime.json` `symbols`. An effect is as before (4-byte records, terminator = a record whose byte 1 is `$FF`) except that when **byte 3 of its first record is 3** it is a run of 12-byte GROUPS (the
records of AY channels A, B, C of one refresh; the terminator is one 4-byte record in place of a group, tested on the first record of the group). `RT_PLAY` reads that byte into `V_SFX_CH` (3 = three
channels, anything else = 1) after clearing `V_SFX_ACTIVE`, then writes `V_SFX_CH`, `V_SFX_PTR` and sets `V_SFX_ACTIVE` (so the interrupt never sees a new pointer with the old mode). **When a one-channel
effect replaces a three-channel one (`V_SFX_CH` was 3), `RT_PLAY` writes volume 0 to B and C once (R9, R10, each only if its `AY_SHADOW` is not 0)**; a one-channel effect never touches R2-R5, R9, R10.
`SND_TICK` with `V_SFX_CH` <> 3 is the one-channel code of before with ONE added test at its start (`LD A,(V_SFX_CH) / CP 3 / JR Z`, 27 T); with 3, `SND_TICK3` plays one group per refresh and
writes, **in this order** and each only when different from `AY_SHADOW`: R0 R1 (A tone), R2 R3 (B), R4 R5 (C), R6, R7, R8 R9 R10 (volumes). (The contract lists the registers per channel, tone low / high
then volume; the AY cannot tell the order within one interrupt; this order is the ascending one, as the one-channel code's.) R6 = the `noise` AND 31 of the lowest channel whose record has noise on
(mix bit 1 = 0), none: channel A's; R7 = bits 0-2 tone off (mix bit 0) of A, B, C, bits 3-5 noise off (mix bit 1), bits 6-7 zero (the joystick port stays an input). Bytes 3 of the records and the
mix bit 2 are ignored; a B or C record with byte 1 = `$FF` (tone 3840..4095 with volume 15) is a normal record. The terminator of a three-channel effect: `V_SFX_ACTIVE` = 0 and R8, R9, R10 = 0 (those not
already 0). `RT_SILENCE` clears `V_SFX_ACTIVE` first, then writes R8 = R9 = R10 = 0 (only those not already 0); it still clobbers only AF.
**Where it lives (a surprise): `SND_TICK3` (142 bytes) is in the unused gap `$0068-$00FF` of DOCK chunk 0** (`ORG $0068` inside `sound.asm`, `ASSERT` it ends by `$0100`), because the v4 runtime has only
`$4000 - RT_END` bytes after its last module (104 now), less than the code needs; the same place in all three builds. `SND_W` and the entry test are in the module as before (`SND_S`..`SND_E`);
`SND_TICK3` is the interrupt's code but outside that range (tests that classify the interrupt by `SND_S..SND_E` see its first instruction only).
**Size** (bytes free by `build-runtime-vN.mjs`, modules summed): v2 7,047 -> 6,905, v3 735 -> 593, v4 385 -> 237; the module `sound` went from 201 to 267 bytes (+66, of which v4's `sprite` module's
alignment padding absorbs 60: `RT_END` $3F92 -> $3F98) and `SND_TICK3` is 142; 208 bytes of code in all. **Stack:** the three-channel tick pushes BC, DE, HL and calls `SND_W` (up to 6 bytes deeper than
the one-channel tick at the terminator, where it calls `RT_SILENCE`: 16 bytes below the interrupted SP, PC and AF of the interrupt included, against 10).
**Costs** (TSRun, whole interrupt from acceptance to RET, T-states): no effect 151 (unchanged); one channel 758 median / 760 worst (before: 731 / 733: **+27 T exactly**, every refresh, the writes
identical); three channels 2,162 median / 2,188 worst over random effects, 2,175 when all eleven registers change, 1,691 when nothing changes (3.7 % of a refresh of 58,688 T at worst). The flip and the frame counter still run first, but the 800 T bound of the 2026-11-09 sound-tick decision (`ARCADE_RUNTIME_API_V1.md`) was set for one channel and a three-channel refresh is about 2.7 times over it (decision for the owner; a faster tick needs more code than the gap holds). `RT_PLAY` 269 T
(539 T when it silences B and C), `RT_SILENCE` 270 T (234 T when already silent). Tests: `arcade/tests/m10-runtime-sound.mjs` (model of every refresh's writes on v2, v3 and v4, RT_PLAY over RT_PLAY in
every 1 / 3-channel combination, an interrupt at every instruction of RT_PLAY / RT_SILENCE, register discipline, costs, one-channel code identical).
