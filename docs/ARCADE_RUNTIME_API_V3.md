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
