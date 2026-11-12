# Leap Arcade runtime API v4 (the raycaster)

The contract is `docs/ARCADE_RAYCASTER_CONTRACT.md` (binding: sections 1-5). v4 is a copy of v3 (`docs/ARCADE_RUNTIME_API_V3.md`) with the scrolling
window (`scroll.asm`) replaced by the raycaster (`ray.asm`, which includes `raybb.asm`); v0-v3 and their tests are untouched. Source
`arcade/runtime/v4/`, build `node arcade/tools/build-runtime-v4.mjs` -> `arcade/build/v4/` (`runtime.json` with `"version": 4`), published to
`arcade/dist/v4/` by `node arcade/tools/publish-runtime.mjs`. The JS reference renderer is `arcade/tests/m8-common.mjs`; the tests are
`arcade/tests/m8-*.mjs`.

## As built, 2026-11-10

**Size:** the runtime is **15,999 of 16,384 bytes** in DOCK chunks 0-1 (`ray` module 4,839 bytes, of which 473 are the RAM routines' image
copied at boot; the RST run switches 22 bytes at `$0010` / `$0020`); 385 bytes are left. v3 was 15,649 with `scroll.asm` at 4,514.

### Ray mode on or off

Ray mode (`V_RAY` = `$E061` = 1, v3's `V_WIN` byte) is on when `frame_div` has **both** `DIV_EXT` (`$80`) and `DIV_VIEW` (`$40`) and `view_desc`
(`$8012`) passes `ray_check` at boot: the 10 descriptor bytes inside `$8000-$BFFF`, `colw` 2 or 4, `map_w` and `map_h` 4..32, `map_src` in the game
image, `patterns` 0 or 16 bytes inside the game image. Otherwise the game runs exactly as v3 without a window: the v3 part 1 suites (`m6-runtime`,
`-pic`, `-mem`, `-regs`) pass on the v4 build (`m8-runtime-v3compat.mjs`), and nothing of the view is written (tested for 13 bad headers).

The boot in ray mode (`ray_boot`, after `video_init`; `ray_check` runs before it so that `build_assets` ends in `ray_assets` instead of the phase-pool
plan): the view variables, the map, the tables, the masked patterns, the RAM routines, the attributes of the 192 window cells in **both** display
files (rows 6-11 `attr_top`, rows 12-17 `attr_bottom`, columns 8-23), `BB_TAB` = (0, `$FFFF`) for every instance, the pose x = y = a = 0 until the first
`RT_VIEW`.

**The map loader.** The 32 x 32 array at `MAP_RAM` = `WORLD_RAM` (`$EA00`, cell (x, y) at `+ 32 y + x`) is filled with 1, then the byte-RLE
`map_src` (pairs count 1..255, value; count 0 ends) is expanded row-major into the game's `map_w x map_h` cells; a value above 4 reads as 4; the
expansion stops after `map_w x map_h` cells (extra pairs are ignored, a short list leaves the rest 1). Then **every 0 on the outer ring of the array
becomes 1** (only a 32-wide or 32-high map has its own ring there), so a ray always stops inside the array (contract section 2, clarification 7).

### Memory map v4 (ray mode; non-ray mode uses v3's)

| Range | Use |
|---|---|
| `$0010-$001A`, `$0020-$002A` | `RST_EVEN` / `RST_ODD`: the row chain's run switches (ROM, chunk 0) |
| `$5B00-$5C80` | the RAM routines copied at boot: the row chain `CHAIN` (341 bytes), the DDA loop `DDA` (44), the three billboard row tails `BT_FI`, `BT_F`, `BT_I` (88) |
| `$5C81-$5D94` | six generated multiply routines (46 bytes each: (m, kind) + code), `RAY_MULXN/XP/YN/YP` (per frame, the cast) and `RAY_MULC/S` (billboards); `$5D95-$5FFF` free |
| `$C080-$C0BF` | `RAY_PATM`: 4 positions x 8 patterns x (even, odd) masked to the position's column bits |
| `$C0C0-$C0CF` | `RAY_BLIST`: the billboards of the tick in draw order |
| `$C100-$C2FF` | `RAY_COS`: C[a], 256 x int16 (4.12) |
| `$C300-$C6FF` | `RAY_RECIP`: R[n] = min(65535, floor(65536 / n)), n = 0..511 |
| `$C700-$CCFF` | `RAY_HGT`: 1,536 bytes, HGT[i] = 48 for i <= 32, else floor(1536 / i) |
| `$CD00-$CD3F` / `$CD40-$CD7F` | `RAY_HHR` (half height) / `RAY_PIR` (pattern index) of ray j |
| `$E100-$E13F` | `BB_TAB`: 16 x `BB_ENT` (4): `DW depth, DW col` |
| `$E140-$E1AD` | the pose (`RV_X`, `RV_Y`, `RV_A`), the view (`VD_*`), the render's per-frame state (`R_*`, `R4_END` = `$E1AE`) |
| `$E200-$E9FF` | `GAME_VARS` (unchanged) |
| `$EA00-$EDFF` | the map (32 x 32) |
| `$EF00-$EFFF` | `RAY_BREC`: 16 x 16 bytes, the billboard records of the tick |
| `$F200-$F6FF` | `RAY_BCODE`: the code generated for one billboard's rows (at most 64 columns x 16 + 16 x 3 + 5 = 1,077 bytes, asserted) |
| `$F700-$F73F` / `$F740-$F77F` | `RAY_DISTL` / `RAY_DISTH`: the perpendicular distance (8.8) of ray j (page aligned: indexed by L = j) |

Free in ray mode (poisoned and checked in `m8-runtime-mem.mjs`): T2, T4, `$E0FC-$E0FF`, `$E1AE-$E1FF`, `$EE00-$EEFF`, `$F000-$F1FF`,
`$C0D0-$C0FF`, `$CD80-$CDFF`, `POOL_C`, `PHASE_OFF`, `$5D95-$5FFF`, `$7B00-$7FFF`; `$F780-$FA7F` free too. The runtime's own stack in a ray tick: **32 bytes** at most (measured,
the interrupt included; v3: 26 + 10). Compiled code keeps the 1,012 bytes it had.

### The tick in ray mode (`main.asm AFTER_FRAME` -> `ray_tick` -> `TICK_COUNT`)

1. `frame_entry`; 2. `ray_mask_dirty`: dirty bytes 1 and 2 of rows 6-17 of the hidden file's dirty map are zeroed (the window's cells are never drawn
from the cell map; text, tiles and `CLS` keep working on the cell map outside it); 3. `redraw_dirty`; 4. `ray_render` (saves and restores IX, IY, AF'
and the alternate set): set-up, cast + walls, billboards and `BB_TAB`; 5. the flip request. The 2D sprite machinery (skip analysis, erase, `draw_all`,
the phase pool) is not used.

### The exact rules (what `m8-common.mjs` reproduces bit for bit)

* **The cast's position** is the pose clamped to cells 1..30 of the array (x, y in 256..7,935): a viewer standing on the array's outer ring (which
  `RT_VIEW`'s clamp allows for a map of width or height below 32: column 0 of a 16-wide map) would cast out of the array. Inside the ring nothing
  changes; the billboards' dx, dy use the same position.
* **Set-up.** cos = C[a], sin = C[(a + 192) AND 255]; plane x = -mulP(sin), plane y = mulP(cos), mulP(v) = v >> 1 + v >> 4 + v >> 6 (arithmetic);
  step = sign(p) ((2 |p| + N / 2) >> log2 N) per axis (N = 128 / colw rays: 32 or 64); ray 0 = cos - plane x + (step x >> 1) (and y); ray j + 1 = ray j + step.
* **Per axis of a ray** (v = the component, f = the viewer's fraction 0..255): v = 0 never steps (first distance 65535, step 32767). Else w = |v| (read
  as 8191 above that) shifted left e times into 2048..8191, R = RECIP[w >> 4], **D = R x 2^e exactly** (so the precision is ~0.4 % for every |v|, not
  only the major axis), the first side distance **min(65535, floor(m D / 256))** with m = 256 - f for v >= 0 (1..256: a fraction of 0 gives a whole
  delta) and m = f for v < 0 (0 at a cell edge: the boundary is at the viewer), the step delta **min(D, 32767)**.
* **The 1/|dir| cap (contract: "document how you handle it").** The spike capped D at 128 cells and computed the first distance from the capped D,
  so rays within 0.45 degrees of an axis stepped early. Here the first distance always uses the exact D (a 24-bit product when D >= 65536), and only
  the step is capped: rays end inside the 32 x 32 array, so every stepping side distance is below 11,000 (43 cells); an axis whose D exceeds 32,767 can
  therefore step at most once before any hit, and its value after that step (>= 32,767) loses every later comparison whether the cap applies or not.
  The 16-bit side distances never wrap (<= 11,000 + 32,767).
* **DDA**: x steps when sdx < sdy, else y (ties go to y); the map pointer moves +-1 / +-32; perp = sd - step of the axis that hit; half height
  HGT[min(perp >> 3, 1535)]; pattern ((type - 1) 2 + side) AND 7.
* **Walls (method B).** Per byte column (2 rays at 4 px, 4 at 2 px) runs of constant bytes from the centre outwards; even window rows use the even
  pattern byte, odd rows the odd one; every window byte is written once, none read.
* **Billboards** (per visible instance with x <= map_w * 256 - 1 and y <= map_h * 256 - 1): dx = x - px, dy = y - py; T(a, c) = sign(a c) floor(|a| |c| / 256)
  with cs = (C[a] + 8) >> 4, sn = (C[a + 192] + 8) >> 4; depth tx = T(dx, cs) + T(dy, sn) (< 64: not drawn), lateral ty = T(dy, cs) - T(dx, sn);
  hgt = HGT[tx >> 3]; **height hpx = (h hgt) >> 4** rows (= h / 32 x 2 x HGT, contract section 3), **width wpx = hpx + hpx >> 3 + hpx >> 5** pixels
  (37/32 of the height: the walls' horizontal / vertical scale, so the billboard is square in the world); centre sxc = 64 +- floor(64 |ty| / mulP(tx))
  (an offset >= 192: not drawn), left edge L = sxc - wpx >> 1; ray j (centre pixel j colw + colw / 2) is a column when L <= xc < L + wpx and
  **tx < the wall's distance of ray j** (equal: the wall wins); source column floor((xc - L) ustep / 256), ustep = wb (RECIP[wpx] >> 5); window rows
  max(0, 48 + hgt - hpx) .. 48 + hgt - 1 (standing on the floor), source row floor((r - top) vstep / 256), vstep = floor(h RECIP[hpx] / 256); per
  pixel bg = (bg AND mask) OR image over the colw bits. Drawn after all walls, far to near by tx, equal tx: lower instance first.
  `BB_TAB[i]` = (tx, min(127, max(0, sxc))) when at least one column was drawn, else (0, `$FFFF`).

### Routines (CALL; clobber AF BC DE HL; IX, IY and the alternate set preserved; no DI; interrupts may arrive anywhere)

| Routine | In | Out | T (CALL + RET, measured) |
|---|---|---|---|
| `RT_VIEW` | HL = x, DE = y (signed 8.8), BC = angle (AND $FF) | the pose; x, y clamped to 0..map_w x 256 - 1 / map_h x 256 - 1 (0 in non-ray mode) | 224..312 |
| `RT_COSA` / `RT_SINA` | HL = angle (low byte only) | HL = (C[a] + 8) >> 4, -256..256 (from the 65-entry ROM table: any mode) | 256..305 / 275..324 |
| `RT_FXMUL` | HL, DE signed | HL = floor(HL x DE / 256) of the exact 32-bit product, wrapped | 1,029..1,354 |
| `RT_WALL` | HL = x, DE = y (signed 8.8) | HL = the cell's type; outside the 32 x 32 array or negative: 1 | 43..144 |
| `RT_SETWALL` | `RA_X`, `RA_Y` (signed 8.8), `RA_V` = type (whole word) | the cell := type when inside map_w x map_h and 0..4, **and not a 0 on the array's outer ring** | 51..311 |
| `RT_SHOW` / `RT_SHOWF` / `RT_HIDE` | as v3 | ray mode: x, y stored as given (unsigned 8.8), frame as v3 | 241 / 203 / 72 |
| `RT_HIT` | A, E = instances | ray mode: 1 when both exist and are visible and \|dx\| < Ra + Rb and \|dy\| < Ra + Rb, R = 4 h (exact unsigned differences) | 1,009 |

### Measured (TSRun, no contention; `arcade/tests/m8-runtime-perf.mjs`) against contract section 5

| Item | Target | As built |
|---|---|---|
| Render (cast + walls), 4 px, 16 x 16, worst of the spike's 16 poses | <= 158,500 | **128,963** (mean 115,774, best 101,372): -18.6 % below the spike, 3 refreshes |
| same, 2 px | <= 272,000 | **220,810** (mean 196,338): -18.7 %, 4 refreshes |
| 32 x 32 map | <= +10 % (174,350 / 299,200) | **154,061** (4 px, mean 126,114), **267,164** (2 px, mean 216,933) |
| One 16 x 16 billboard at 4 px (drawn 18 x 16) | <= 9,000 | **15,145, not met** (projection + sort 4,520, code generation 5,189, rows 6,084) |
| One 32 x 32 billboard at 4 px (drawn 37 x 32) | <= 31,000 | **40,321, not met** (rows 27,070: 85 T per drawn column-row) |
| Scene-start table build | <= 60 refreshes | **12.6 refreshes** (740,612 T more than a boot without a view; 32 x 32 map) |
| Runtime size | <= 16,384 | **15,999** |

At 2 px a 16 x 16 billboard costs 23,730 T, a 32 x 32 one 62,719 T. The per-frame billboard overhead when the angle changed (the two |cs|, |sn|
multiply routines) is about 1,800 T, otherwise nothing (the routines are kept while their multiplier is unchanged; the same holds for the cast's four).

**A running game** (the frame interrupt included; the spike's 16 x 16 map and poses, the HUD printed every tick): colw 4 / frame_div 3: worst tick
137,219 T with no billboard (2.34 refreshes), 205,745 with three 16 x 16 billboards 2.3 cells away (3.51 refreshes: over the 3); colw 2 / frame_div 5:
229,625 (3.91) and 327,872 (5.59).

**`vaults.arc` on this runtime** (contract 8.4; `node tests/arcade-m8-vaults-perf.mjs`, the game's recorded runs, 32 x 32 maze, 4 px columns,
frame_div 4 = 234,752 T): win run 1,433 ticks: median 159,468 T, 95th percentile 188,532, **worst 263,739 (4.49 refreshes); 7 ticks (0.49 %) over
the 4 refreshes**; mean ray_render 138,375 (cast + walls 116,571, billboards 17,046), the game's logic 18,994; worst picture 226,565 of which
billboards 96,861. Lose run 391 ticks: worst 205,502, none over. The overruns are the ticks with several wraiths close (deviation 1).

### Deviations from the contract, and why

1. **Billboard budgets (section 5) not met: 15,145 / 40,321 T against 9,000 / 31,000.** The targets came from the spike's kernel (`sprite.asm`: one
   byte per source pixel, OR only, no projection, no clipping, no depth test, no sort). With the real 2-plane frames of the game image and the
   contract's pixel rule, the drawn rows alone cost 76-85 T per column-row (generated code: `BIT b,(IX+mask)` / `JR` / `AND` / `BIT b,(IX+image)` / `JR` /
   `OR`, 16 bytes per column, 18 T per byte, a 60-80 T row tail): 27,070 T for the 32 x 32 one, so 31,000 is out of reach for that size whatever the set-up costs;
   the 16 x 16 one spends 4.5k in the projection (four multiplies by the frame's generated cos / sin routines, the screen-column division, the size and
   step computations) and 5.2k generating its row code. Measured consequence: three 16 x 16 enemies at 2.3 cells push a 4 px tick from 2.34 to 3.50
   refreshes. **This groups with the planned item of contract section 9, "pre-scaled billboard sets"** (10x cheaper per pixel, "groups with the first
   game that measures it as the limit"): `vaults.arc` is that game, and it measures 7 of 1,433 ticks over its budget (0.49 %, worst 4.49 of 4 refreshes,
   billboards up to 96,861 T in one picture): the item is now due, as its own follow-up (it changes the asset format the compiler emits).
2. **`RT_SETWALL` ignores a type 0 on the outer ring of the 32 x 32 array, the loader turns a 0 there into 1, a map value above 4 reads as 4, a short
   list leaves 1** (contract section 2, clarification 7, added). R6 only made the ring a compile-time rule; without the run-time rule an opened ring
   cell of a 32-wide map lets a ray walk through memory (a shallow ray can even loop on a cycle of zero addresses). Maps narrower and lower than 32 are
   not affected.
3. **`BB_TAB` col is clamped to 0..127** when the centre of a drawn billboard is off the view (clarification 8, added).
4. **The billboard width** is 37/32 of its height (the contract fixes only the height); the source column and row steps use the reciprocal table
   (`ustep = wb (RECIP[wpx] >> 5)`, `vstep = floor(h RECIP[hpx] / 256)`), never above the exact quotient, so a source index stays inside the frame.
5. **The depth test compares distances** (tx against the ray's perp, both 8.8), the contract's first option.
6. **Billboard positions are culled at the map's size** (x > map_w * 256 - 1 or y > ...): "a position outside the map is simply not drawn".
7. **Table memory**: the reciprocal table covers n = 0..511 (1 KB, the billboards use n < 256) and the height table always 1,536 bytes (any map size).
8. **The self-modifying code** lives in `$5B00-$5D94` as the contract prefers; the generated billboard rows in `POOL_B` (`$F200-$F6FF`).
9. **The render casts from the pose clamped to cells 1..30 of the array** (above; `RT_VIEW`'s stored pose is the contract's). It matters only for a
   viewer inside a ring wall, a game-level error; without it the rays read memory outside the map.

### Worst cases

* The render's cost grows with the DDA steps: the 32 x 32 spike map (8.9 steps a ray) is the measured worst, +19 % (4 px) / +21 % (2 px) over the
  16 x 16 map. A ray never takes more than the array's diagonal (the ring rule).
* Near-axis rays (a component below 16 / 4096) take the slow normalisation path (up to 11 shifts) and, below about 1 / 256, the exact 24-bit first
  distance: measured over every angle that produces such a ray (32 angles at 4 px, 82 at 2 px), all equal to the reference.
* A billboard right in front of the viewer (tx just above 64) is drawn 144 rows high (clipped to the window) and up to 166 pixels wide (clipped to
  the view): up to 32 columns at 4 px, 64 at 2 px: 1,074 bytes of generated code, inside `RAY_BCODE`'s 1,280 (asserted; a 1,024-byte buffer
  overran into the distance arrays: found by the full billboard run, now a quick test and a mutant).

### Tests (TSRun, stock ROMs; `M8_QUICK=1` shortens them)

| File | What |
|---|---|
| `m8-runtime.mjs` (72 checks) | runtime.json, size, map; boot: tables, 8 map-loader variants, attributes, 13 refused headers; walls against the reference for **more than 900 (4 px) and 1,300 (2 px) poses** (the spike's maps and poses, random maps 9 x 30 .. 32 x 32, fractions 0, every angle on a cell corner, near-axis angles with components exactly 0, deltas >= 2^16 and deltas the step cap must cut, a 29-cell corridor for the cap, a 30-cell corridor, 0.2 cells from a wall, a viewer on the array's ring looking out, poses inside walls), both files, garbage bitmaps, ray arrays; billboards: 160 scenes x 16 instances per width against the reference column scaler and BB_TAB, the widest billboard first, equal depths, billboards outside a holed map edge; whole games compared after every refresh (TSRun colours too) at frame_div 1..5 with HUD text and tiles also written into the window's rows |
| `m8-runtime-api.mjs` (13) | COSA / SINA (3,400 calls), FXMUL (4,289 pairs with the extremes), WALL / SETWALL against the map model (the whole array after every write, the ring rule), VIEW clamps, SHOW / SHOWF / HIDE / HIT in ray mode incl. the exact HIT boundaries, the registers kept; non-ray mode |
| `m8-runtime-regs.mjs` (19) | an interrupt at every instruction boundary of the ray code (55 ranges incl. the RAM chain, DDA, tails, multiplies and generated rows; 49,880 injections), chaos with the picture after every refresh, IX / IY / alternates kept across ticks |
| `m8-runtime-mem.mjs` (34) | the map; every write tracked in 6 games: only the allowed regions and patch points (the ray arrays only from `hit_c`, the row code only from `bb_draw`), free areas poisoned and unchanged, the map written only by SETWALL, tables and chain intact after play, the stack depth |
| `m8-runtime-perf.mjs` (14) | the numbers above |
| `m8-runtime-v3compat.mjs` (4 suites, 111 checks) | the v3 part 1 suites on the v4 build (non-ray mode) |
| `m8-mutations.mjs` | **78 deliberate bugs** in the ray code (boot, tables, set-up, axis, multiplies, DDA, hit, composer, RST switches, billboards, layout, the routines, the branches), run against the quick forms of the four suites above (the unmutated suites must pass first): **74 killed, 4 equivalent** (the 8,191 clamp, the height-index clamp, the 192 screen limit, the COSA fold at 128: each with its proof in the file), 0 survivors (4 shards, about 8 minutes) |

A real bug found by the full billboard run during the slice: a column's generated code is 16 bytes, so 64 columns (2 px, a billboard covering the
view) need 1,074 bytes and overran a 1,024-byte buffer into the distance arrays, corrupting the depth test of billboards drawn after it. Fixed (buffer
1,280 bytes, asserted; distances page aligned at `$F700`, asserted), and now caught in the quick forms (the widest-billboard scene, the write-confinement
check of the ray arrays) and by a mutant.

### Notes for the compiler

* `requiredRuntime` 4; `runtime.json` has `DIV_VIEW`, `GAME_VIEWDESC`, `VD_LEN`, `BB_TAB`, `BB_ENT`, `VIEW_W`, `VIEW_H`, `MAP_RAM` (= `WORLD_RAM`) and the
  v3 names a non-ray program needs. `SETWALL`'s ring rule (clarification 7) should be modelled by the interpreter for 32-wide / 32-high maps.
* Billboard cost (deviation 1) is the limit to watch in `vaults.arc`: with 4 px columns plan on about 15k T per near enemy and 6-9k T per far one.

## As built: three-channel effects (language batch 5 Part C, delta stream, 2026-11-10)

`sound.asm` is the same file in v2, v3 and v4; contract: `docs/ARCADE_LANGUAGE_BATCH5.md` Part C items 16-19 (items 17 and 18 as revised on 2026-11-10; the first version's 12-byte groups, `SND_TICK3` and `SND_W` never shipped and are gone).
**New variable `V_SFX_CH` = `VARS+$80` (`$E080`; boot zeroes it, 0 = one channel)**, in `runtime.json` `symbols`. **Image format.** A one-channel effect is as before (4-byte records, terminator = a record whose byte 1 is `$FF`).
A three-channel effect is the 4-byte header `0, 0, 0, 3` (byte 3 = 3), then one **entry per refresh**: a byte `n` (0..11) and `n` pairs `register, value` (ascending register order; the first entry holds all 11 registers R0-R10, every
later one only the registers that changed), and a single `$FF` in place of an entry ends the stream (`convertSfx` in `src/lang/arcade/arcade-assets.js` builds it; the runtime has no channel logic: the shared noise generator, the mixer
and the padding of shorter channels are the compiler's work). **`RT_PLAY`** reads byte 3 of the effect into `V_SFX_CH` (3 = three channels, anything else = 1) after clearing `V_SFX_ACTIVE`, then writes `V_SFX_CH` and `V_SFX_PTR` (for 3:
the address after the header) and sets `V_SFX_ACTIVE` (so the interrupt never sees a new pointer with the old mode). **When a one-channel effect replaces a three-channel one (`V_SFX_CH` was 3), `RT_PLAY` writes volume 0 to B and C once
(R9, R10, each only if its `AY_SHADOW` is not 0)**; a one-channel effect never touches R2-R5, R9, R10.
**The tick.** `SND_TICK` with `V_SFX_CH` <> 3 is the one-channel code of before with ONE added test at its start (`LD A,(V_SFX_CH) / CP 3 / JR Z`, 27 T, +5 when taken). With 3 it is the code after `.out` (`SND_S.three`, 50 bytes in two pieces,
the one-channel terminator `.end` sits between them so that every `JR` of `SND_TICK` still reaches its target): it saves HL, reads `n` through `V_SFX_PTR`; **n = 0**: stores the pointer and leaves (no other register touched); **n = 1..11**: also
saves BC and DE and, for every pair, selects the register (`OUT $F5`), writes the value (`OUT $F6`) and stores it in `AY_SHADOW` + register (so the one-channel tick, `RT_SILENCE` and `RT_PLAY` keep an exact shadow; every pair of an entry is
written, also when the value equals the shadow: the compiler already dropped the unchanged ones); **$FF**: `CALL RT_SILENCE` (`V_SFX_ACTIVE` = 0, R8, R9, R10 = 0 where the shadow is not 0). It leaves with the ISR's own `POP AF / EI / RET` (the same
three bytes as `JP ISR_DONE`, 10 T faster; the one-channel path still leaves through `ISR_DONE`). `RT_SILENCE` clears `V_SFX_ACTIVE` first, then writes R8 = R9 = R10 = 0 (only those not already 0); it still clobbers only AF.
**Size** (bytes free by `build-runtime-v4.mjs`, modules summed: 1,772 -> 1,873, which counts the old gap module out; the image itself grew: `RT_END` `$3925` -> `$394E`, +41 bytes of module `sound`, 267 -> 308). `KEY_ROWSEL` (8 bytes of data, `RT_KEYDOWN`'s half-row selects) stays in the gap, now at `$0068` (it followed the tick before); that is the only user of the gap.
**Stack:** an entry with pairs pushes HL, BC, DE (10 bytes below the interrupted SP, PC and AF of the interrupt included, as the one-channel tick); the `$FF` calls `RT_SILENCE` (12 bytes; the group tick: 16).
**Costs** (TSRun, whole interrupt from acceptance to RET, T-states, `arcade/tests/m10-runtime-sound.mjs`): no effect 151 (unchanged); one channel 758 median / 760 worst (before: 731 / 733: **+27 T exactly**, every refresh, the writes
identical); three channels by the pairs of the entry: **n = 0: 260, n = 1: 395, 2: 467, 3: 539, 4: 611, 5: 683, 6: 755, 8: 899, n = 11: 1,115** (260 for n = 0, 323 + 72 n above: 72 T a pair = two reads 2 x (7 + 6), two OUTs 2 x 11, `LD E,A` 4, the shadow store 7, DJNZ 13), the first entry (all 11 registers) 1,115, the `$FF` 538 (against 2,162 median / 2,188 worst of the group tick, which cost 1,691 even when nothing changed). **Against the contract's targets**
(item 18: no change 250, typical 3 to 6 changes 600, 11 changes 900, at most 100 bytes): code 50 bytes met; n = 3 (539) met, n = 4 (611) **missed by 11 T**, n = 5, 6 (683, 755) **missed**; n = 0 (260) **missed by 10 T**; n = 11 (1,115) **missed by 215 T**. The floors: for n = 0 the idle interrupt (151) + the entry test taken (32) + HL saved, the pointer read and stored (21 + 32) + the read and test of `n` (17); for a pair 72 T. **`AY_SHADOW` is page aligned** (`$E000`, 2026-11-10: it and the 16 bytes `V_FRAMES`..`RT_SEED` swapped places in `layout.inc`, so those variables moved by +`$70`: `V_FRAMES` `$E070`, `V_SYNC` `$E072`, `V_TICKS` `$E078`, `RT_SEED` `$E07E`; nothing else moved), so a pair's shadow address is `LD D,hi` once and `LD E,reg`: 7 T a pair saved (the first delta tick: 79). `RT_PLAY` 291 T for a stream (269 before the stream starts after the header: +22 T; one-channel effects unchanged), 539 T when it silences B and C; `RT_SILENCE` 270 T (234 T when already silent).
Tests: `arcade/tests/m10-runtime-sound.mjs` (a model of every refresh's writes on v2, v3 and v4 with streams built by hand, by the test's own encoder and by `convertSfx`; the chip against `sfxRefreshRegisters` after every refresh; RT_PLAY over RT_PLAY in
every 1 / 3-channel combination; an interrupt at every instruction of RT_PLAY / RT_SILENCE; register discipline; costs; one-channel code identical; **end to end**: a compiled game plays a three-channel asset on each build's cartridge) and
`arcade/tests/m10-mutations.mjs` (37 deliberate bugs).

## As built: size pass (2026-11-10)
A shrink pass over every v4 module (two workers on disjoint files, every change built and tested one at a time; combined and re-verified: `arcade/tests/run-all.mjs` 60/60 and the m8 mutation run, 74 killed, 4 equivalent, 0 survivors) took the runtime from **16,147 to 14,612 bytes: 1,772 free** (was 237). Largest items: sprite erase variants that fall through into each other (-662 bytes, 15-450 T faster per erase), the 341-byte RAM row chain built from a 60-byte pattern by three LDIRs (-255; the bytes are identical; the ray set-up costs +41,774 T once, inside the 60-refresh budget), `tileops` walkers sharing code (about -230), table-driven boot fills, and alignment waste removed (a 90-byte `ALIGN 256` became `BIT_TAB` at `$0100`, `video` moved up to close a 94-byte hole, `UNIT_TAB` no longer straddles a page). No exported address of the API changed except that `RT_*` entries moved (programs are recompiled by the build); `RT_VIDEO` is now unused. Alignment is the sensitive lever: `sprite.asm`'s `BLKP3` must start in `$1047-$1054` (now `$1048`) and `ray`'s `UNIT_TAB` align has about 60 bytes of slack; change code in front of them with that in mind. v2 and v3 were not touched.


## As built: banking (B1, 2026-11-10)

Contract: `docs/ARCADE_BANKING_CONTRACT.md` sections 2 and 3. **The common part** is as in `ARCADE_RUNTIME_API_V2.md` "As built: banking (B1)" (same code in `tileops.asm`, `maps_boot` included): `F4_BANK` `$3F`, `BANK_LO` `$40`, `BANK_HI` `$80`, `bank_on` / `bank_off`, `RT_LOADMAPPTR` as the checking entry, `MAX_MAPS` 64.
**`ray_map`** takes HL = the RLE stream and the dimensions from `VD_MAPW` / `VD_MAPH` (not from IX), so it can be called again (clobbers AF, BC, DE, HL, not IX). New internal routines in `ray.asm`: `ray_dims` (B = map_w, C = map_h -> `VD_MAPW`, `VD_MAPH`, `VD_XMAX` = map_w * 256 - 1, `VD_YMAX`; clobbers AF, DE; `ray_boot` uses it too) and `ray_map_load` (HL = stream; calls `ray_map` directly for `H` outside `$40..$7F`, else with the window mapped around it). **`ray_check`** accepts `map_src` (view_desc +5) in `$4000-$BFFF` (high byte `$40..$BF`; the descriptor and the patterns still only `$80..$BF`); **`ray_boot`** decodes through the window and the window is unmapped before the RAM routines are copied to `RAY_RAM` (`$5B00`).
**`RT_PLANLOAD`**: HL = the new plan's RLE stream (mapped or banked), B = map_w, C = map_h (each 4..32, **not checked here: the compiler does**); clobbers AF, BC, DE, HL (IX, IY and the alternates kept; `ray_map` does not use IX). Ray mode only (`V_RAY` = 1): otherwise it returns at once. It sets `VD_MAPW`, `VD_MAPH`, `VD_XMAX`, `VD_YMAX`, rebuilds the 32 x 32 array as the boot does (all 1, the plan, every 0 of the outer ring made 1) and clamps the pose (`RV_X`, `RV_Y`) into the new map exactly as `RT_VIEW` does (the angle stays). `RAY_RAM` and the display files are not touched by the call (the next tick draws the new plan).
**Size**: +88 bytes (`runtime (chunks 0-1)` 14,511 -> 14,599 of 16,384: **1,785 free**, was 1,873): the common part 26, `ray_dims` 23, `ray_map_load` 16, `RT_PLANLOAD` 38, less 15 bytes that `ray_boot` and `ray_map` no longer need (the dimensions are set by `ray_dims`; `ray_map` no longer reads IX).
Tests: `arcade/tests/m11-runtime-bank.mjs` on v4: the common tests; `ray_boot` with a banked plan = the mapped boot (the array against the JavaScript loader, `VD_*`, `RAY_RAM`, both display files; the window mapped once, only the stream read) and the high-byte check of `map_src`; `RT_PLANLOAD` from the window and mapped for four plans (8 x 12, 32 x 32, 4 x 4, 24 x 20) with two poses each (one clamped) = the boot's array and picture; the stream edges; an interrupt at every instruction boundary (about 19,000); outside ray mode; `arcade/tests/m11-mutations.mjs`. `m8-runtime.mjs`: the refused `map_src` is now `$3F00` (`$4000` is the window).

## As built: the billboard projection reorder (billboards B1, 2026-11-11)

Contract: `docs/ARCADE_BILLBOARDS_CONTRACT.md` section 5 (B0, the spike, found neither a two-pass draw nor pre-scaled sets worth building; the
owner kept today's draw and asked for this). **Every output is the same**: the picture, `BB_TAB`, `R_BN`, `RAY_BLIST` and the record of every
drawable billboard in `RAY_BREC`, byte for byte; the register contract of `ray_bb` / `ray_render` is unchanged. `bb_project` (`raybb.asm`) now:
* tests in this order: hidden, outside the map, the signs, tx (behind the viewer: tx < 64), ty, q, off (>= 192), and only then the size work
  (hgt, hpx, wpx, ustep, vstep, the record); every test depends on the instance and the pose alone, so the drawable set does not depend on the order;
* computes the four products with their signs once per pair (`tx = (-1)^s1 (P1 +- P2)`, `ty = (-1)^s3 (P3 -+ P4)`, exact, within +-16,382);
* rejects behind the viewer before the products where that is provable: both terms <= 0 (no multiply), or T(dx, cs) <= 0 with P2 <= 63 (one multiply);
* takes hpx = (h hgt) >> 4 by shifts when h is a power of two (every Vaults asset), the shift-add otherwise;
* inserts each drawable instance into `RAY_BLIST` as it is projected (the stable insertion by depth, far to near, equal depths in instance order:
  the order of the sort that ran over the whole list before), so `bb_sort` / `bb_tx` are gone.

**Measured** (TSRun; `node arcade/spike/bb/run-bb.mjs proj`, the angle unchanged, before -> after; 0 mismatches over 3,000 random scenes):
one billboard in view 5,158 -> **4,695** (target 4,800); one off the view sideways 4,352 -> **2,390** (3,000); one behind the viewer 1,666 ->
**1,039** (1,100), the mixed-sign cases 1,590 -> 1,238-1,522; sixteen visible with eight in view 56,096 -> 43,944. `arcade/tests/m8-runtime-perf.mjs`:
projection and sort of one 16 x 16 billboard 4,520 -> 4,053. Every path, 40,000 random single instances (`node arcade/spike/bb/proj-cases.mjs`):
faster or equal in every case but one, worst single instance 5,729 -> 5,385. **The one slower case:** hpx = 0 (a source under 16 rows high far
away: h < 8 beyond 3 cells, h = 8 beyond 24) costs 2,420 -> about 3,800 T, because it is now found after ty and off; testing it early again would
cost every far instance 70-130 T for a case no game has. It stays under the cost of a drawn instance.

**`vaults.arc`** (`node tests/arcade-m8-vaults-perf.mjs`, the same recorded runs and compiler on the runtime before and after; the game now has its
title scene, so the figures differ from the 2026-11-10 ones above): win run 1,433 ticks: mean `ray_bb` 16,879 -> **14,773**, mean `ray_render`
136,781 -> 134,674, median tick 158,943 -> 156,814, 95th percentile 188,433 -> 185,546, ticks over the 4 refreshes **9 -> 8** (tick 997 is no longer
over; two of the 8 are the scene switch at ticks 17-18, about 1.05 M T, not billboards), worst picture 226,058 -> 222,788 (billboards 96,805 ->
94,495). Lose run 389 ticks: mean `ray_bb` 9,789 -> 8,883, median 150,753 -> 149,463, the same 6 ticks over (all scene switches).

**Size:** `runtime (chunks 0-1)` 15,069 -> **15,079** bytes (+10; 1,305 free). The `RT_*` entries after `raybb.asm` moved by 10 bytes (`RT_VIEW`,
`RT_SINA`, `RT_COSA`, `RT_FXMUL`, `RT_WALL`, `RT_SETWALL`, `RT_TABLELOAD`, `RT_VIEWMODE`, `RT_END`): compiled v4 games change bytes; no hash baseline
covers a v4 program (batch 1-3 baselines are v2 / v3).

**Tests:** `m8-runtime.mjs` section 4b (new): the records and the list against the reference projection on 120 random scenes per colw (heights 1, 2, 4,
8, 16, 32 and 48, 13; equal depths), 46 edge scenes (tx = 63 / 64 / 65 with P1 or P2 at 63 / 64 and both signs, off = 191 / 192, off 255 / 256)
and 16 scenes of 16 instances at four depths in scattered order. `m8-mutations.mjs` (4 shards): 90 mutants, **86 killed, 4 equivalent** (each with its reason in the file), 0 survivors; the new ones cover the early behind-the-viewer rejects, the sign handling of tx and ty, the power-of-two heights and the insertion into the list. `arcade/tests/m14-runtime-mode.mjs` compared v4 byte for
byte with the runtime published before batch 7; since B1 moved code on purpose, v4 now has v3's rule from its size pass (every published symbol at or
above `$4000` keeps its address and every published `RT_*` routine exists; the byte comparison is retired). `arcade/dist/v4` is republished.
