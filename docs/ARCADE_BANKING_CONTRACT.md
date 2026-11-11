# Leap Arcade: the banked cartridge map, contract for slices B0-B5 (2026-11-10)

Binding for runtimes v2, v3 and v4, the compiler (`src/lang/arcade/`), the linker, the Studio and the tests. It implements
section 3 of `docs/ARCADE_SPACE_PLAN.md`, with one change found while writing it (section 2 below): the two banks are read
**in place**, not copied. Programs that bank nothing compile to the same bytes as before. Style as `ARCADE_LANGUAGE_BATCH4.md` and `_BATCH5.md`.

Owner decisions that bind this contract (2026-11-10, not to be asked again): a game up to 32 KB (16 KB mapped in DOCK chunks 4-5 + 16 KB
of cold assets in DOCK chunks 2-3); banking is automatic, with a per-asset `mapped` / `banked` / `auto` override in the project document
only (not in the language); chunk 6 as a third bank comes later; chunk 7 never; the emulators (TSRun, ZEsarUX 13.0, Fuse 1.9.1) are the
test ground; output is a DCK for a stock TS2068.

## 1. What the measurements say (slice B0)

**What a game image holds today** (`compile().usage`, the five shipped games): code dominates, data is small.

| Game | Runtime | Code | Strings | Tileset | Sound | Maps / world / plan | Sprite data | Other | Game area used |
|---|---|---|---|---|---|---|---|---|---|
| Leap Runner | v3 | 9,059 | 148 | 181 | 313 | world 463 (RLE of 2,048) | 1,920 | scroll tables 3,584, init 420 | 15,378 |
| Vaults | v4 | 10,761 | 440 | 163 | 565 | HUD map 768, plan 539 | 512 | | 11,890 |
| Starfall | v2 | 8,165 | 140 | 145 | 287 | map 773 | 256 | | 8,479 |
| Blockfall | v2 | 7,809 | 164 | 109 | 593 | - | 0 | init 106 | 7,825 |
| Breakout | v2 | 1,505 | 60 | 37 | 123 | - | 64 | | 1,601 |

So banking cannot make room for more **code**; what it gives is room for more **content**: screen maps (770 bytes each), worlds of a
scrolling game (about 460 bytes each, RLE) and floor plans of a 3D game (about 540 each). "Leap Runner with more levels" is the case:
each level is a banked world. Code, the tileset, sprite frames (shift 0 is drawn straight from the game image every tick), the
scroll tables and the sound effects (read by the interrupt) stay mapped.

**Free RAM per runtime** (from `layout.inc` of each runtime and a search of the sources for addresses in `$5B00-$5FFF` / `$7B00-$7FFF`):

| Region | v2 | v3 | v4 |
|---|---|---|---|
| `$5B00-$5FFF` (chunk 2 tail) | free (1,280) | `$5B00-$5DFF` window tables (window mode); `$5E00-$5FFF` free | `RAY_RAM` (ray mode) |
| `$7B00-$7FFF` (chunk 3 tail) | free (1,280) | free | free |
| `$C000-$DFFF` (chunk 6) | all used (tables, pools, glyphs); 32 free (T2) | all used; 64 free (T2, T4) | all used; 64 free |
| `GAME_VARS` (chunk 7) | 3,839 minus the game's variables | 2,048 minus | 2,048 minus |
| `WORLD_RAM` `$EA00-$F1FF` | - | world (window mode) | plan `$EA00-$EDFF`, billboards `$EF00-$EFFF` (ray mode) |

There is no common place for a staging buffer of map size in v3 / v4 (the chunk-3 tail is hidden while bank B is mapped, `GAME_VARS`
belongs to the game). Section 2 needs none.

**Emulators** (`arcade/spike/bank/`, `RESULTS.md` there): mapping DOCK chunk 2, 3, both (`$F4` = `$3F`) or 6 over RAM for the length of
a read, with the frame interrupt running: copied bytes, RAM under the window, the displayed picture and the interrupt count, on TSRun,
ZEsarUX 13.0 and Fuse 1.9.1: **all four PASS on all three** for chunk 2, 3, 6 and 2+3 together (TSRun 160 pieces / 171,364 bytes
verified, 647 of 647 frames one of the two reference screens, 649 interrupts in 649 frames, 65 of them taken with a window mapped;
ZEsarUX 240 pieces / 257,046 bytes, 335 display samples, 816 interrupts in 816.4 refreshes; Fuse 669 of 669 movie frames correct and
the pass marker). Negative controls fail as designed. Two findings bind the runtime: (a) **ZEsarUX lets a mapped DOCK chunk above
`$4000` be written** (the DOCK data changes; TSRun and Fuse ignore the write), so a stray write into the window corrupts the bank on
ZEsarUX only: rule 2 forbids it and the B1 tests check it on TSRun; (b) the stock ROM hands over with `$F4` = `$43` (**DOCK chunk 6
mapped**): once chunk 6 is shipped (later), boot must set `$F4` before it clears `$C000-$DFFF` (the runtimes do today). The emulators'
video reads RAM by construction, so question (3) is a property of their model; real hardware stays untested (checklist item 0).
Details: `ARCADE_HARDWARE_NOTES.md` section 11.

## 2. The bank window (the change from the plan)

**DOCK chunks 2 and 3 are mapped together as one 16 KB window at `$4000-$7FFF`** (`F4_BANK` = `$3F`), and the runtime's loaders read a
banked asset **in place** from it. There are no bank numbers and no copy: a banked asset is just an address in `$4000-$7FFF`; a
mapped one an address in `$8000-$BFFF`. Why: every consumer of a banked asset in this batch (the map loader, the world decoder, the
floor-plan decoder) reads its source once and writes only RAM chunks 6 and 7, so it can run with the window mapped; that needs no
staging RAM (which v3 and v4 do not have) and no extra pass. The plan's `RT_BANKCOPY` comes with bank C (chunk 6), whose consumers
must copy (chunk 6 is the working RAM): the owner put chunk 6 later, so it is not built now (section 9).

**Rules** (for every routine that runs with the window mapped; checked by the runtime tests, section 7):
1. Interrupts stay **enabled**. The ISR touches only chunk 7, the AY and ports, and the code runs in chunks 0-1 (as E4 proved).
2. Between mapping and unmapping, nothing reads or writes `$4000-$7FFF` except the read of the banked source: no display-file access,
   no `W_TROWS` / `W_ATTRT` / `W_FLAGT` (v3, `$5B00-$5DFF`), no `RAY_RAM` call (v4), no `$7B00-$7FFF`. Writes go to chunk 6 or 7 only.
3. The window is mapped and unmapped by the **runtime's loaders themselves**, never by compiled code: a loader whose source address is in
   `$4000-$7FFF` maps the window, does its work, and unmaps; with a source in `$8000-$BFFF` it runs exactly as today. So the compiler
   emits the same call for a mapped and a banked asset, and the pairing cannot go wrong.
4. Mapping: `ld a,F4_BANK / ld (V_SHADOW_F4),a / out (PORT_HSR),a`; unmapping the same with `F4_PLAY` (`$33`). Only boot and these two
   helpers write `$F4` (true today: only boot does). The shadow stays exact.
5. No loader is ever called with the window already mapped (no nesting), and no loader calls `RT_SHOW`, the tick, or any drawing routine.

## 3. Runtime changes (slice B1; v2 first, then v3, v4)

Common to v2, v3, v4 (`layout.inc`, `tileops.asm`; about 30 bytes):
* `F4_BANK EQU $3F`; `BANK_LO EQU $40`, `BANK_HI EQU $80` (the window's high-byte range).
* `bank_on` / `bank_off` (internal, clobber A only): rule 4.
* `RT_LOADMAPPTR` (HL = map record, BC = x, DE = y): when `H` is in `$40..$7F`, `bank_on`, `loadmap_core`, `bank_off`; else
  `loadmap_core` as today. `RT_LOADMAP` / `RT_LOADMAPAT` fall through to this checking entry (not straight to `loadmap_core`), and
  `maps_boot` calls it too, so a map-table entry may point into the window: a banked map is loaded by index exactly like a mapped one.
* `MAX_MAPS` 8 -> **64** (the clamp in `maps_boot`; the table is indexed with `add a,a`, fine below 128).
* Registers and the clobber list of the three entries are unchanged (AF, BC, DE, HL).

v3 only (`scroll.asm`):
* The RLE decoder of `window_boot` becomes a subroutine `world_decode` (HL = source; writes `WORLD_RAM`, 2,048 bytes, zero-filled as now).
* `window_boot` accepts `world_src` in `$4000-$7FFF` as well as `$8000-$BFFF` and decodes through the window when it is there (window
  mapped only around `world_decode`; `W_TROWS` etc. are written after `bank_off`).
* **`RT_WORLDLOAD`**: HL = RLE source (mapped or banked), A = `world_w` (24..128), DE = `cam_max` (pixels, computed by the compiler as
  `camMax()` in `arcade-window.js`). Decodes into `WORLD_RAM` (through the window when banked), sets the world width and `cam_max`, sets
  the camera to 0, and makes the next two ticks repaint the whole window in both display files (as after boot). Tile rows, attributes,
  flags, bands and the window position do not change. Sprites are not touched. Only in window mode (`V_WIN` = 1); otherwise it returns at
  once. Clobbers AF, BC, DE, HL.

v4 only (`ray.asm`):
* `ray_map` takes HL = source and the dimensions from `VD_MAPW` / `VD_MAPH` (not from IX), so it can be called again.
* `ray_check` accepts `map_src` in `$4000-$7FFF` as well, and `ray_boot` decodes through the window when it is there (unmapped before
  the RAM routines are copied to `RAY_RAM`).
* **`RT_PLANLOAD`**: HL = RLE source (mapped or banked), B = `map_w`, C = `map_h` (4..32 each). Sets `VD_MAPW`, `VD_MAPH`, `VD_XMAX`,
  `VD_YMAX`, rebuilds the 32 x 32 array as the boot does (all 1, the plan, the outer ring), and clamps the pose (`RV_X`, `RV_Y`) into the
  new map as `RT_VIEW` would. The next tick draws the new plan. Only in ray mode (`V_RAY` = 1); otherwise it returns at once. Clobbers
  AF, BC, DE, HL (and IX if `ray_map` needs it: then it saves it).

**Byte budget:** v2 about 30 (7,047 free), v3 about 80 (2,159 free), v4 about 80 (1,873 free). A runtime that grows by more than 150
bytes is reported, not shipped silently. Every `RT_*` address that moves needs the hash baselines regenerated
(`node arcade/tools/regen-baselines.mjs --old <previous ref>`), which cross-checks old and new compiler output first.

## 4. Language (slice B3): `WORLD`, more maps

```
WORLD name          statement: load MAP `name` as the world of the WINDOW (v3) or the floor plan of the VIEW3D (v4)
```
1. **v3 (a game with `WINDOW`):** the world becomes MAP `name` exactly as if the `WINDOW` had named it at boot: `WORLD_RAM` reloaded (rows
   and columns beyond the map 0), the world width and the camera limit those of `name`, **the camera set to 0**, the whole window redrawn.
   `SETWORLD` changes made before are lost (the map is decoded again). `WORLD level` with the `WINDOW`'s own map restarts a level.
2. **v4 (a game with `VIEW3D`):** the floor plan becomes MAP `name` as if `VIEW3D` had named it: array rebuilt, `map_w` / `map_h` those of
   `name`, the pose kept but clamped into the new map (the game normally follows with `VIEW`). `SETWALL` changes are lost.
3. `name` must pass the same map checks as the map the `WINDOW` / `VIEW3D` names (v3: width 24..128, at most 16 rows, tile values; v4:
   4..32 x 4..32, values, the walls rule of batch 3), with the same messages prefixed `WORLD: `. A MAP named by `WINDOW`, `VIEW3D` or any
   `WORLD` is a world / plan: not in the map table, not loaded at boot, `LOADMAP` of it an error (as for the `WINDOW`'s map today).
4. `WORLD` without a `WINDOW` or `VIEW3D`: `WORLD needs a WINDOW (runtime v3) or a VIEW3D (runtime v4)`. An unknown name:
   `WORLD: unknown MAP 'x'`. Allowed anywhere a statement is (INIT, FRAME, PROCs, scene code). `WORLD` is a reserved word (a variable
   called `world` must be renamed). `requiredRuntime` is unchanged (`WORLD` needs what `WINDOW` / `VIEW3D` already need).
5. **Maps:** at most **64** `MAP` declarations per game (was 8): `at most 64 MAPs per game`. The help text of `LOADMAP` and the
   interpreter's comment follow.
6. **Code:** `WORLD name` = `LD HL,src / LD A,world_w / LD DE,cam_max / CALL RT_WORLDLOAD` (v3, 11 bytes) or
   `LD HL,src / LD BC,w<<8|h / CALL RT_PLANLOAD` (v4, 9 bytes). `src` is the world's RLE stream wherever the linker put it. Each world /
   plan is stored once however many `WORLD` statements name it.
7. **Interpreter and mock runtime:** model `WORLD` (the interpreter already holds the world / plan); banking is invisible to both.
8. Bytes: a program with no `WORLD`, at most 8 maps and nothing banked compiles to the same bytes as before.

## 5. Placement (slices B2, B3): what is banked, and when

**Bankable** (and nothing else in this batch): screen maps (the map record `w, h, cells`), worlds (RLE stream), floor plans (RLE stream).

**Policy `auto`** (the default for every bankable asset):
1. Lay the game out with everything mapped. If it fits chunks 4-5 (16,384 bytes from `$8000`), **nothing is banked**: the image, the DCK
   and every byte are what they were (programs with up to 8 maps and no `WORLD` are byte-identical to the previous compiler's).
2. Otherwise bank `auto` assets, **largest first** (ties: declaration order), one at a time, until the mapped game fits. Assets with the
   override `banked` are banked first whatever the size; `mapped` ones never move.
3. The window is filled in the order the assets were banked, from `$4000` up, no alignment, no straddle rule (the window is one 16 KB
   range). Banked bytes beyond 16,384: error.
4. A map that is banked keeps its place in the map table (its entry points into the window); the boot map (map 0) may be banked: the boot
   loads it through the window. The old one-map header form (`map_ptr` to 768 raw bytes) is used only when nothing is banked, as today.
5. The `WINDOW`'s and the `VIEW3D`'s own map may be banked: the header's `world_src` / `map_src` then points into the window.

**Overrides** (project document only): a map asset may carry `bank: 'auto' | 'mapped' | 'banked'` (`assets.maps.<name>.bank`, absent =
`auto`). `compile(text, {..., assets})` reads it from the assets it already gets; a bad value is a warning
(`map 'x': bank 'q' is not auto, mapped or banked; auto used`). A test-only option `compile(..., {bankAll: true})` banks every bankable
asset (the forced-banking runs of section 7).

**Errors** (instead of today's single "does not fit"): `the game does not fit: mapped part N of 16,384 bytes after banking every map,
world and plan (code C, sprites S, ...)` and `banked assets need N of 16,384 bytes`; and for an override that cannot be met:
`map 'x' is set to mapped but the game then does not fit (N of 16,384 bytes)`.

**`usage`** gains `mapped: {used, available: 16384}`, `banked: {used, available: 16384, assets: [{name, kind: 'map'|'world'|'plan',
bytes, at, why: 'auto'|'override'|'bankAll'}]}`; the existing fields keep their meaning (`gameArea` is the mapped part).

## 6. Linker and DCK (slice B2)

* The DCK ships chunks 0, 1, 4, 5 as today, plus **chunk 2 when anything is banked and chunk 3 when the banked bytes pass 8,192**
  (`SHIPPED_CHUNKS` becomes per build: `link()` returns `shipped`). Unused bytes of a shipped bank chunk are `$FF`.
* The flat `.bin` and the Studio's download follow the same image. `findSource(map, addr)` and the source map cover the window.
* The DCK header's chunk kinds: the bank chunks are kind 2 (ROM), like 4 and 5.

## 7. Tests (each slice; all with the real runtimes on TSRun unless said)

* **B1, `arcade/tests/m11-runtime-bank.mjs`** (v2, v3, v4): `RT_LOADMAPPTR` from the window equals the same map loaded mapped (cell map,
  attributes, dirty bits); `RT_WORLDLOAD` from window and mapped equals the boot's decode of that world (WORLD_RAM, width, cam_max,
  camera 0, the next two ticks' window pictures); `RT_PLANLOAD` likewise against the boot's array; `$F4` and `V_SHADOW_F4` are `$33`
  after every call; registers outside the clobber list preserved; the display files and `$5B00-$5FFF` / `$7B00-$7FFF` byte-identical
  before and after; **an interrupt at every instruction boundary** of the banked path (as `m10-runtime-sound.mjs` does), with the
  return address in chunks 0-1 and `SP` in chunk 7; `MAX_MAPS` 64: a table of 64 maps, the last loaded by index. Mutation run
  (`m11-mutations.mjs`) over the new code.
* **B2:** linker unit tests (placement order, overrides, errors, `usage`), DCK read-back (chunks present, bytes at the window
  addresses), and **byte-identity**: every existing baseline and example compiles to the same bytes.
* **B3:** compiler tests for `WORLD` (checks, messages, code), the interpreter's `WORLD`, and a **differential with forced banking**:
  the batch 4 / 5 harnesses and the examples run built normally and with `bankAll`; pictures and state must be equal tick by tick.
* **B4:** studio smoke (section 8).
* **B5:** the example played on all three emulators (section 10); `ARCADE_HARDWARE_NOTES.md` section 11.

## 8. Studio (slice B4)

* Size panel: two budgets, `Mapped 15,8xx / 16,384` and `Banked 1,4xx / 16,384`, with the banked list
  (`banked: world level2 (472), map room3 (770)` and why).
* Map assets get a `Bank: Auto / Mapped / Banked` select (project document `assets.maps.<name>.bank`; `auto` removes the key), which
  marks the project changed and recompiles. Validation in `src/arcade-project.js` keeps the field.
* Problems list: the errors and warnings of section 5.

## 9. Not in this batch, and why

* **Bank C (DOCK chunk 6) and `RT_BANKCOPY`:** the owner put chunk 6 later. Its consumers must copy (chunk 6 is the working RAM), which
  is what `RT_BANKCOPY` is for; the directory form (addresses) extends to it by giving bank C addresses a kind of their own.
* **Banked sound effects:** the interrupt reads them, so a banked effect needs a RAM sound buffer; that is the same mechanism `MUSIC`
  needs (item 6 of the space plan) and is built with it. Effects are small (141 bytes for 3 x 30 ticks).
* **Banked strings, tileset, sprite frames:** strings are read by `PRINT` from the game image (a banked text needs the print path
  through the window: possible later, no game needs it); the tileset is copied once at boot (1.2 KB at most, no gain); sprite frames are
  drawn from the game image every tick (shift 0), hot by design.
* **Code beyond 16 KB** (owner, 2026-11-10: the 64 KB cartridge is there if the size needs revisiting). Not needed now: code is 9-11 KB in
  the largest games, and the growth is content, which this batch banks. The trigger is the first game whose mapped part (code, hot data)
  passes 16 KB with everything bankable banked. The candidate then: compiled code executing in place from the `$4000-$7FFF` window
  (compiled code reaches the display only through the runtime's tick; every runtime routine it calls would have to be checked or kept
  off the display while the window is mapped). That needs its own probe and contract.
* **A scene with no window / view (`NOWINDOW`, `NOVIEW`):** item 4 of the space plan, unchanged; `WORLD` covers its "level restart
  reloads the world" half.

## 10. Example (slice B5)

**Leap Runner with more levels**: `arcade/examples/platformer.arc` gets three more worlds (`level2`, `level3`, `level4`, 128 x 16) and
the level change (`WORLD levelN` when the goal is reached, a short "LEVEL N" message). Without banking the mapped game no longer fits
(about 15.4 KB + 3 x about 470); with banking it builds as one DCK of chunks 0-5. Played and compared on TSRun, ZEsarUX and Fuse with
the method of `ARCADE_HARDWARE_NOTES.md` section 10, including at least one level change.

## As built: slices B2 and B3 (compiler and linker, 2026-11-10)

What differs from, or is left open by, the text above (`src/lang/arcade/arcade-bank.js` is the new shared module: layout arithmetic and placement order):

* **Overrides are per asset, reports are per MAP.** `bank` is read from the asset object (`assets.maps.<asset name>.bank`), so two `MAP` declarations of one asset share it; the names in `usage.banked.assets`, the warning and the errors are the declared `MAP` names (`level2`), not asset names. `bankAll` banks a `mapped` override too (it is a test option).
* **Worlds and plans a `WORLD` names are stored by the linker, not in the code.** The streams sit after the window / view data of the mapped part (or in the window); the operand of each `WORLD`'s `LD HL,src` is a fixup (`gen.fixups`: `{at, key}`) the linker fills in. A `WORLD` of the WINDOW's / VIEW3D's own map uses that stream. `gen.streams` lists the extra ones.
* **Banking regenerates the code.** `generate()` lays the game out mapped first; when it does not fit (or an override says `banked`, or `bankAll`) it generates again with the placement: banked screen-map records leave the code, map-table entries are window addresses, and a game whose only map is banked gets the extended header (the old one-map form is for maps in the image). If the mapped part still does not fit one more asset is banked and the check repeated. Programs that bank nothing take the first generation unchanged: byte identity.
* **Messages.** The generic `the game does not fit: mapped part N ...` replaces the linker's old message only when the game has at least one MAP to bank; a game with none keeps `the game does not fit: N bytes (...)`. `banked assets need N of 16,384 bytes` is reported before the mapped part is checked. A bad `bank` value is a warning at the `MAP` declaration. A `WORLD` in a PROC nobody calls is checked like any statement (the runtime must have `RT_WORLDLOAD` / `RT_PLANLOAD`: `WORLD needs RT_WORLDLOAD, which this runtime does not provide`).
* **Added:** `compile().shipped` and `link().shipped` (the DOCK chunks of the DCK), `usage.shippedChunks`, `map.banked` (the debugger / Studio list), and a check against the runtime's `MAX_MAPS` constant (`this runtime build holds at most N maps ...`) when the table says fewer than the game declares. `WORLD` is reserved for variables but may name an asset (`MAP world = "w"`).
* **Tests:** `tests/arcade-m11-compiler.mjs` (the byte identity needs `ARCADE_OLD=<copy of the previous src/lang/arcade/>`; without it that section is skipped), `tests/arcade-m11-differential.mjs`, shared `tests/arcade-m11-common.mjs`. Four older tests changed because the contract changed behaviour: `tests/arcade-m5.mjs` (the 8-MAP limit is 64 now), `tests/arcade-m6-compiler.mjs` and `tests/arcade-m8-compiler.mjs` (the m6 game fits once its world is banked, so its sprite art was doubled; the m8 one now gets the generic message).
* **A runtime without `RT_LOADMAPPTR`** (a build older than slice B1) still builds every game that banks nothing; when banking is needed or forced it is an error (`... this runtime build cannot read banked assets (it has no RT_LOADMAPPTR): build the runtime with the banked cartridge map`). A v0 / v1 runtime never banks (no map table).

## As built: slices B0, B1, B4, B5 (2026-11-11)

* **B0:** section 1 (the probe in `arcade/spike/bank/`, re-run by a second agent with the same figures; `ARCADE_HARDWARE_NOTES.md` section 11).
* **B1** (runtimes; bytes used in chunks 0-1 before -> after, free after): v2 9,337 -> 9,363 (+26, 7,021 free), v3 14,225 -> 14,309 (+84, 2,075 free),
  v4 14,511 -> 14,599 (+88, 1,785 free). As section 3, with these names: v3 `world_load` (maps the window around `world_decode` when the stream is
  banked), `RT_WORLDLOAD` invalidates both files' attribute caches (`win_ac_clear`), which makes the next two ticks repaint the window; v4 `ray_dims`,
  `ray_map_load`, `RT_PLANLOAD`. `RT_WORLDLOAD` stores `world_w` and `cam_max` as given and `RT_PLANLOAD` does not check `map_w` / `map_h`: the
  compiler passes only values that passed the map checks. Tests: `arcade/tests/m11-runtime-bank.mjs` (35 checks, v2 / v3 / v4, an interrupt after
  every instruction of each banked loader: 19,000 to 32,000 per loader), `m11-mutations.mjs` (81 of 81 killed). Older tests touched: the m5 tests
  and `runtime/v2/test_ops.asm` (MAX_MAPS 64), `m8-runtime.mjs` (its "map_src outside the image" case used `$4000`, now the window: `$3F00`). The
  hash baselines were regenerated (`regen-baselines.mjs --old HEAD`: 16 hashes, old and new compiler identical on the new runtimes).
* **B4** (Studio): two bars in the size panel (`Mapped N / 16,384`, `Banked N / 16,384` with one row per banked asset and why), `+ N banked` in the
  status bar, a `Bank` select (Auto / Mapped / Banked) in the map editor's toolbar, `bank` validated in `src/arcade-project.js`. `ARCADE_STUDIO.md`
  "As built: banking (B4)". `tests/studio-smoke.mjs` sets Starfall's `sky` map to Banked and saves a 40,969-byte DCK (chunks 0, 1, 2, 4, 5).
* **B5:** `arcade/examples/runner.arc` ("Leap Runner (4 levels)", `runner.md`): the platformer's world and three new 128 x 16 worlds, `WORLD levelN`
  at each flag, a retry reloads the current level. Mapped part **16,342 of 16,384**, banked 1,670 (the four worlds, 383-463 bytes each), DCK 40,969
  bytes; with every world forced `mapped` it does not fit (18,012). `tests/arcade-runner.mjs` (48 checks): a 1,762-tick play-through of all four
  levels on the interpreter and on TSRun, equal every tick, with 3 banked-world loads; game over and retry; normal vs `bankAll`; a negative control.
  Cross-emulator: `ARCADE_HARDWARE_NOTES.md` section 12. A world-load tick takes 5 refreshes instead of 3 (then a 2).
* **What B5 showed (the next limit):** the new levels' coins and enemies had to be cut (and two lookup tables dropped) to fit the mapped part.
  Per-level object tables are **array initialisers in the code**, which this batch does not bank. Banking is now limited by per-level data held in
  code, not by worlds. The candidate next step: bankable `DATA`-style tables (an array initialiser declared per level, copied into the game's array
  when the level is entered). It needs a copy, so it groups with bank C / `RT_BANKCOPY` (section 9). The owner decides; not started.
