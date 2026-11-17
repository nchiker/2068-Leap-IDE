# Fine colour (8x1 extended colour, SCLD mode 2) scenes in runtime v2: contract, 2026-11-14

The item after Studio completion stage 2 (`docs/ARCADE_FINE_COLOUR_PLAN.md`; the owner approved its decisions on 2026-11-14:
**inside runtime v2, per scene; one buffer, sprites drawn straight after the frame interrupt, a RAM-shadow compose only if the F1 spike shows
flicker; Starfall's play scene first, then a new showcase game**). Branch `arcade-fine` from `main` `c245446`. Binding. **All slices F0 to F5 and the rework are built (section 11, 2026-11-15; PR pending).** **Owner's rule: every improvement is used in the sample games, and each new feature has a sample game that shows it off**
(section 10 is not optional). Claude's own calls are listed in section 12 for the owner's review; the work does not wait for that review.

## 0. What exists (checked for this contract)

* **Hardware** (`docs/ARCADE_HARDWARE_NOTES.md` section 1): `$FF` = 2 shows the bitmap of display file 1 (`$4000-$57FF`) with **one colour byte
  per 8x1 group at the pixel address + `$2000`** (`$6000-$77FF`). The colour byte is an attribute (ink bits 0-2, paper 3-5, BRIGHT 6, FLASH 7).
  The two 8x8 attribute areas (`$5800-$5AFF`, `$7800-$7AFF`) are not shown in mode 2. Two buffers are impossible in mode 2 (both files are in
  use), so a fine scene draws into the one screen the viewer sees.
* **TSRun** draws mode 2 (`tsrun/machine.js` `paintScreenSpan`: "Hi-colour: one attribute byte per pixel line, from the other screen") and its
  raster is beam-accurate (rendering per span with write stalls; the pixel area starts at line 40, T 32: **8,992 T after the interrupt**, then
  224 T a line; a fitted figure, unverified on hardware). TSRun has no contention. **ZEsarUX uses 48K timing for the TS2068** (69,888 T a frame,
  312 lines, contention on `$4000-$7FFF`); Fuse's mode 2 and timing are checked in F1. So a method that needs the beam's exact position is
  fragile across emulators and hardware: section 3 prefers one that needs only "the update starts right after an interrupt".
* **Runtime v2** (`arcade/runtime/v2/`): `RT_END` `$328A` before fine colour (size pass: 3,446 bytes free then); with fine.asm in, **1,068 bytes free** after `RT_END` (786 in the ink variant, SC). The tick (`main.asm`): `TICK_LOOP` waits for
  `V_SYNC = READY` (set only by the interrupt) and the period, then `WORK_START`: `V_HOFF` = the hidden file, a `V_WIRE` test (27 T), `frame_entry`,
  `skip_analysis`, `erase_all`, `redraw_dirty`, `draw_all`, the flip request. The ISR flips only on a request (`V_SYNC` = 2 / 3) and saves only
  AF (+ `SND_TICK`'s BC, DE, HL): it never touches IX, IY or the alternates (keep it so). Sprites never write attributes today: a sprite takes the
  colour of the cells under it (Starfall's ships are drawn in the sky's ink, whatever the art says).
* **RAM:** `$E062-$E06F` (14 bytes after `V_WIRE`, in the variables page the boot zeroes) are free; `T2` (`$D5E0`, 32) and `V_FREE2` (`$E0FC`, 4)
  are free but poisoned by the memory tests; **in mode 2 the two attribute areas `$5800-$5AFF` and `$7800-$7AFF` (1,536 bytes) are not shown**
  and are free while a fine scene runs (they must be rebuilt when it ends: section 4).
* **Art** (`docs/ARCADE_ASSETS.md`): authored per 8x1 row (ink, paper, BRIGHT per row). Today a tile's attribute is its row 0
  (`tileAttr`, `arcade-assets.js`), a sprite has no colour on v2 (`convertSprite`, `arcade-codegen.js:232`).
* **Project / Studio:** `scenes.<name>.display = 'fine'` is a valid setting (`src/arcade-project.js`); `sceneDisplayPlan` (`arcade-display.js`)
  notes "display 'fine' (8 x 1 colour) is not built into any runtime yet"; the Studio lists "finer colour (not built yet)" (`studio.js`
  `DISPLAY_LABEL`). `arcadec` takes no scenes setting today.
* **The reference game** (jon0x0's R-Type, knowledge only): it expands the 8x8 attributes into the `$6000` colour plane and writes its colour
  straight to the live screen, with no beam timing; its docs say it does not claim tear-free output, and its title went back to 8x8 colour after
  flicker complaints. It does not settle section 3: F1 measures.

## 1. The setting

1. A scene is fine when the project says `scenes.<name>.display = 'fine'` (the Studio's display select; any case). The source does not change:
   no new word, no clause. `arcadec` gets the setting from a top-level `"scenes"` key of the assets file (the example games keep it there) or
   from `--scenes <file.json>` (which wins).
2. **Where it is allowed:** a program that compiles for v2 and has **no `WIRE3D`**. Errors (on the scene's line, from `compile`): `scene 'x':
   fine colour (display 'fine') needs runtime v2; this game uses <WINDOW | VIEW3D> (runtime v3 | v4)`; `scene 'x': fine colour (display 'fine')
   cannot be used in a WIRE3D game`. (Today's "not built yet" warning goes; `hires` keeps it.)
3. `sceneDisplayPlan`'s `built` becomes `'fine'` for a fine scene of a v2 game (else `'buffers'`).
4. Nothing else in the language changes: every statement means in a fine scene what it means elsewhere, with the picture of section 2.

## 2. The picture (exact; the JS reference implements exactly this)

While a fine scene runs, `$FF` = 2 and the screen is **the bitmap at `$4000` and the colour plane at `$6000`** (colour of pixel group (y, c) at
`$4000 + rowOff(y, c) + $2000`). After every tick's screen update (section 3) it equals the **fine picture** of the state:

1. **Cells.** Cell (r, c) holds value v and attribute a (the cell map, unchanged). Its 8 pixel rows are the glyph of v (as today). Its 8 colour
   bytes: **a font cell (v < 128): a on all 8 rows** (text, `FILLC`, `CLS`, blank cells); **a tile cell (v >= 128, tile t = v - 128): the tile's
   eight row attributes** `bright << 6 | paper << 3 | ink` of rows 0..7 as authored (the cell's own attribute byte is not used for a tile cell in a
   fine scene; it stays row 0's, so the other scenes are unchanged).
2. **Sprites**, in instance order (a higher index lies on top), each at its drawn position (x rounded to the asset's phases, as today): the
   bitmap exactly as today (`screen = (screen AND mask) OR image`, per screen byte of the blit window). **Colour:** for each pixel row k of the
   sprite and each screen byte of the blit window on that row **whose mask byte is not `$FF`** (the sprite covers at least one pixel of that
   byte): `colour = (colour AND $F8) OR ink_k`, where `ink_k` is the ink of the asset's row k as authored. A byte the sprite does not cover keeps
   its colour; the paper, BRIGHT and FLASH under the sprite are the background's (so a sprite's "paper" pixels show the background's paper).
   Sprites are applied in order, so a later sprite's ink wins on a shared byte.
3. Nothing else writes the screen in a fine scene: no flip, no 8x8 attributes.
4. The **two blacks** rule (`docs/HANDOFF.md`, K1-K3) applies per row: the asset check's `black-bright-mix` looks at a fine scene's tiles row by
   row (a row with paper 0 and BRIGHT 1 next to rows with BRIGHT 0 black paper warns, as cells do today).

## 3. The screen update with one buffer (what F1 settles)

**Requirement.** In a fine scene the screen update (erase the sprites' old places, the dirty cells, the sprites at their new places) is done **in
the one screen, starting right after a frame interrupt**, and the game's `FRAME` runs after it in the same tick (so `FRAME` never delays the
start of the update). The tick still runs every `frame_div` refreshes. If `FRAME` overruns, the next update waits for the next interrupt
(it never starts mid-frame).

**What the viewer may see.** Every frame the beam paints, compared per 8x1 group (pixels + colour) with the fine picture P_old (before this
tick's update) and P_new (after it):
* **clean**: every group equals P_old or P_new, and every sprite's groups all come from the same one (no sprite shown half old, half new);
* **torn**: every group equals P_old or P_new, but some sprite is shown partly at its old and partly at its new state;
* **broken**: some group equals neither (a sprite missing or half erased: the "blink"; a bitmap shown with the wrong colour).
**Targets** on the F1 scene (section 7, F1) and on Starfall's fine play scene, measured on TSRun's beam: **broken frames 0** apart from a split
write of one group (bitmap and colour written by two instructions: at most 1 frame in 1,000); **torn frames reported** (median and worst per 100
frames; the owner judges them by playing).

**Methods.** F1 builds and measures, in this order, and keeps the first that meets the targets:
* **A, direct** (the owner's first choice): from the interrupt, per instance in order of y (top first), erase its old cells and draw it at the
  new place straight into the screen; dirty cells first. Overlaps: an erase that wipes part of an already drawn sprite redraws it.
* **B, compose and publish** (the owner's fallback, R-Type-like in spirit): `FRAME`, then the update is **composed off screen** (no screen write)
  into a small RAM buffer of the groups that change (the cells under old and new sprite places and the dirty cells: background from the cell map,
  then every sprite over that cell, in order); at the next tick's start, right after the interrupt, the buffer is **published top to bottom**
  (bitmap byte and colour byte of a group written one after the other). Each group is written once, with its final value, so nothing blinks;
  a tear needs the beam to cross the publish. Buffer: the free attribute areas (1,536 bytes) and what else F1 shows is free; if a tick changes
  more groups than fit, the rest is published directly in the same order (counted and reported).
F1 may refine either (a better order, publishing per cell row, waiting a measured number of T before a row the beam is about to reach) as long
as nothing needs more than "the update starts within a few thousand T of an interrupt". **The decision and its figures go to section 3a ("F1 as
built") and to the owner in the slice report; changing the order of A and B, or choosing neither, is a stop-and-ask.**

### 3a. F1 as built and the owner's decisions (2026-11-14)
The spike (`arcade/spike/fine/RESULTS.md`, re-run by the main thread on 1,500 frames: same figures) measured on TSRun's beam and on Fuse's frames:
**A (direct)** 419 non-split broken frames per 1,000: it misses the target by far. **B** (compose, publish whole cells) 0 non-split broken,
2.5 split and 19 torn per 1,000 at 20 Hz, about 2.8 KB of buffer. **BD** (B, publishing only the 8x1 groups that differ from the screen):
**0 broken, 0 torn** in 9,000 TSRun frames and 1,363 Fuse frames, publish 24k T (worst 32k), about 4.8 KB of buffer on the 16-sprite scene;
compose 250k (B) to 350k T (BD) a tick for 16 moving sprites, unoptimised. ZEsarUX and Fuse show mode 2 exactly as TSRun (0 pixels off).
**The owner chose (asked, 2026-11-14, "what gives the most impressive screen results?" -> "yes" to the recommendation):**
1. **Method BD** for F2: compose off screen into a buffer, then right after the next interrupt publish, top to bottom, only the groups that
   change (bitmap and colour byte back to back). A tick that changes more groups than the buffer holds publishes the rest directly (counted).
2. **The RAM comes from a sprite-art cap:** a game with a fine scene has **at most 32 sprite phases in all** (the pre-shifted copies; e.g. 4
   assets x 8 phases, or 8 x 4), so phase pool B (`$F000-$FA7F`, 2,688 bytes) is never handed out; with the two free attribute areas (1,536),
   the second dirty map (96) and the second half of `SPR_DRAWN` (64) the buffer has about 4.3 KB. The linker refuses more (section 6).
   This replaces section 5.3's "anything more is a stop-and-ask" for these areas.
3. **Starfall's fine play scene keeps 20 Hz with fewer sprites at once** (smaller waves, fewer shots: the count F2's figures allow); the
   showcase game is designed from the start for about 8 to 10 large shaded sprites at 20 Hz.

## 4. Entering and leaving a fine scene

1. **`RT_FINEMODE`**: A = 0 off / 1 on, HL = the game's **fine descriptor** (on only; section 5.2). Called by the compiler's `ENTER` sequence
   after the reset (`CLS`, the first map, sprites hidden), before the scene's `INIT`, exactly where `RT_WIREMODE` is called today; and once at the
   start of the game's `init_entry` when the first scene is fine. A program with no fine scene never calls it (and is unchanged: section 6).
   On when on / off when off: nothing (the dirty cells of the reset are drawn by the next update).
2. **On** (from the two-buffer setup): the whole fine picture of the cell map is built (sprites: none drawn, every instance's record cleared in both
   files), then `$FF` = 2 (shadow included). **Off**: both display files are rebuilt for the two-buffer setup from the cell map (8x8 attributes
   in both files, every cell dirty in both maps as needed), then `$FF` = 0 with file 1 shown, and the flip state consistent (`V_SYNC`, the shadow).
3. **What the viewer sees during a switch:** every frame is the old scene's picture, a frame of plain colour (all groups one colour), or the new
   picture; never garbage colours (for example an old bitmap under the new colours). A switch may take several frames (a scene switch already
   takes about 13 refreshes).
4. The boot is unchanged: it starts in the two-buffer setup; a fine first scene switches at the start of `init_entry` (before its `INIT`).

## 5. Runtime v2

### 5.1 Code
A new module `fine.asm` (after `wiretick.asm`, before `RT_END`), plus the smallest edits elsewhere: `main.asm` (one test of `V_FINE` beside the
`V_WIRE` test, jumping to `fine_tick`), and whatever the method needs. **Size bound: the whole addition <= 2,500 bytes, leaving >= 900 free;**
report the figure. No self-modifying code. Interrupts stay on (no `DI` anywhere in the fine code). Registers: `RT_FINEMODE` may clobber AF, BC,
DE, HL, IX, IY and the alternates (as `RT_WIREMODE`; the code generator holds nothing in them).
* `fine_tick` (from `WORK_START` when `V_FINE` <> 0): `V_HOFF` = 0; the screen update of section 3; `frame_entry`; for method B the compose; then
  back to `TICK_LOOP` **without a flip request**, leaving `V_SYNC` = `SYNC_BUSY` so that the next update starts after the next interrupt.
  `V_TICKS` counts as today. A switch off inside `frame_entry` (ENTER) returns to the two-buffer tick from the next tick on.
* The ISR is unchanged: with no request it never writes `$FF`.

### 5.2 Data (the game image; compiler side in section 6)
The **fine descriptor** (mapped image, never banked), built only for a game with a fine scene:
`DW tile_rows` (128 x 8 bytes at most: tile t's row attributes at `tile_rows + 8 t`, rows 0..7; 0 = no tileset), `DW sprite_inks`
(`MAX_ASSETS` x 16 bytes: the ink of asset a's row k at `sprite_inks + 16 a + k`, 0..7; 0 = no assets). F2 may add fields at its end (the
compiler emits what `runtime.json` names).

### 5.3 RAM
`V_FINE` (`$E062`, zeroed by the boot: 0 = no fine scene running, 1 = running), the descriptor's pointers and the method's state in `$E063-$E06F`;
the method's buffers in `$5800-$5AFF` / `$7800-$7AFF` (only while `V_FINE` = 1). Anything more is a stop-and-ask (the memory map is full). The
memory tests (`m4-runtime-mem.mjs` and the new suite) prove the writes of a fine game confined to the screen, the cell map, the dirty maps,
`SPR_TAB` / `SPR_DRAWN`, the declared fine areas, the variables, `GAME_VARS` and the stack.

### 5.4 Cost
A game with no fine scene: at most **+30 T per tick** (one test). Fine-mode costs F2 reports (TSRun): a cell redraw (16 bytes), a 16x16 sprite's
erase and draw (aligned and not), 8x8 sprites, the worst-case tick (16 visible 16x16 sprites moving, a text screen), `RT_FINEMODE` on and off.

## 6. Compiler, interpreter, Studio

* **Assets:** `convertTileset` gains the eight row attributes per tile (`tileRowAttrs`, `arcade-assets.js`) for the descriptor; `convertSprite`
  gains the row inks (rows beyond the art: 0). Other scenes still reduce to 8x8 (a tile's row 0 attribute), unchanged.
* **Phase cap (3a.2):** the linker refuses a game with a fine scene whose sprite assets have more than 32 phases in all: `"sprite art too large
  for a fine-colour game: N phases, at most 32; use fewer phases"`.
* **Codegen / link** (`arcade-codegen.js`, `arcade-link.js`): the fine descriptor, `RT_FINEMODE` in `emitSceneMode`'s place (A, HL) for every
  `ENTER` of a game with a fine scene and at the start of `init_entry` for a fine first scene; the errors of section 1. The build's `CONSTANTS`
  (`arcade/tools/build-runtime-v2.mjs`) learn the new names.
* **Byte identity:** a program without a fine scene compiles to the same code bytes as on `main`; only runtime addresses move (the `main.asm`
  test), handled by `node arcade/tools/regen-baselines.mjs --old c245446`, which must report every program equal in behaviour.
* **Reference** (`arcade-interp.js`, a new pure `src/lang/arcade/arcade-fine.js`): `finePicture(cells, attrs, sprites, assets, tileRows)` ->
  `{bits, colours}` (6,144 + 6,144 bytes) exactly as section 2; the interpreter's records carry the scene's mode so the display model shows a
  fine scene through it. The differential suite compares interpreter and runtime pictures after every tick of scripted runs.
* **Studio:** "finer colour" without "(not built yet)" for a v2 game; the display select offers it; the run view shows mode 2 (TSRun already
  does); the tile and sprite editors' fine preview (`familyPixels(..., 'ecm')`) is what the game shows (checked by a test against
  `finePicture`); a fine scene in a v3 / v4 / WIRE3D game shows the section 1 error.
* **Docs:** `docs/ARCADE_RUNTIME_API_V2.md` ("As built: fine colour"), `docs/ARCADE_ASSETS.md` (what a fine scene keeps), `docs/ARCADE_STUDIO.md`,
  `docs/ARCADE_LANGUAGE_BATCH4.md` section 10 (fine is built on v2).

## 7. Slices (each ends with `verify --changed` green, a commit and a push of `arcade-fine`, the RESUME note updated)

* **F0** this contract (main thread).
* **F1 spike** (Opus, disposable worktree; `arcade/spike/fine/`): a hand-written cartridge on the stock TS2068: mode 2, a screen of tiles with
  per-row colour and a text HUD, a scene like Starfall's play (16 instances: 1 ship, 4 bullets, 8 16x16 enemies, 3 shots, all moving at 20 Hz
  by a scripted, repeatable pattern; overlaps included), then the methods of section 3 in order. Measured on TSRun: T per update (median, worst),
  broken and torn frames per 1,000 frames, T per cell / per sprite. Checked on ZEsarUX and Fuse: the picture after N ticks equals TSRun's (screenshots
  / memory), and a visual flicker run of each method (the owner can watch it: the commands go in `RESULTS.md`). Deliverable: `RESULTS.md` with the
  decision of section 3, the kernels F2 will reuse, and a JS checker of the measure (reusable by F2's tests).
* **F2 runtime** (Opus, disposable worktree): `fine.asm` and the edits of section 5; tests `arcade/tests/m19-runtime-fine.mjs` (the picture
  against `finePicture` after every update of random scenes: text, tiles, 1..16 sprites of every size and phase count, overlaps, hide / show,
  switches on / off at random ticks; the broken / torn measure on the beam; registers and interrupts injected at every instruction of `fine.asm`;
  memory confinement; costs) and `m19-mutations.mjs` (4 shards: every branch has a killing test).
* **F3 compiler + interpreter** (Sonnet): section 6 except the Studio; `tests/arcade-m19-compiler.mjs`, `tests/arcade-m19-differential.mjs`,
  mutation suite for the new compiler code.
* **F4 Studio** (Sonnet): section 6's Studio items; `tests/studio-smoke.mjs` extended.
* **F5 sample games** (Sonnet from my design, main thread checks): section 10; Fuse launch commands for the owner.
Every slice: `node tools/verify.mjs --changed` while working, `--all` before each behaviour commit and the PR; new tests are steps in
`arcade/tests/steps.mjs`; `python3 tools/stamp-modules.py` after `.js` changes; `node arcade/tools/publish-runtime.mjs` after runtime or example
changes. Runtime changes: `--all --full` once before the PR.

## 8. Performance targets (TSRun; real hardware unmeasured)

Each target is followed by its result (section 11 has the sources).

* A game with no fine scene: +30 T per tick at most; every recorded run of every example as fast as on `main` (`arcade-codegen-perf --compare`).
  **Met: +0 T.** `fine.asm` sits after `wiretick.asm` and no byte below it changes; the main tick has no test (section 11, F2, deviation 1); a game
  without fine colour never runs a byte of fine.asm (`m19-runtime-fine` check 6). (`arcade-codegen-perf --compare` was run by the slices' `verify`, not for this write-up.)
* Starfall's fine play scene keeps **FRAMERATE 20 in >= 95 % of its ticks** over its recorded runs (report median, 95th percentile, worst, ticks
  over budget), with as many sprites at once as that allows (section 3a.3). **Met:** 99.8 % of the script's 1,333 play ticks (1,331); 98.1 %, 98.5 %,
  98.6 % in waves 3, 6, 10 of the worst-play bot (844 ticks each). Tick cost over the script: median 60,723 T, 95th 155,036, worst 692,876 (budget 176,064;
  2 ticks started late); the late waves' median 120,627 to 138,466 T.
* F2 reports the compose + publish cost per moving 16x16 and 8x8 sprite, so F5 can size the games (the spike's unoptimised BD: about 23k T a
  16x16 sprite; the target after F2's optimisation is <= 12k). **Reported; the 12k target is MISSED:** 25,224 T per moving 16x16 sprite (8 phases; 23,895
  byte aligned) and 12,595 T per moving 8x8. The spike's 23k was an average over a mix with seven 8x8 sprites, so the 16x16 sprite alone was not better to start with; the speed pass
  took the figure from 28,634 to 25,224 T. The pure work alone is about 11k a sprite (`NOTES-FINE.md`, "Why the target was not met"): the target is out of reach for method BD as built.
  The games were sized with 25k a 16x16 sprite (Starfall 7 instances, Lumen 5 moving at once).
* The showcase game holds its own `FRAMERATE` in >= 99 % of its ticks. **Met by LUMEN:** 99.9 % (2,191 play ticks) and 99.7 % (3,191, small caves); the 599 heaviest
  ticks (all four shades out) 599 of 599 on time, median 124,687 T, 95th 143,540, worst 151,694 (budget 176,064).
* `RT_FINEMODE` on or off: at most 30 refreshes (a scene switch). **Met:** on 843,308 T and off 821,386 T, 14 refreshes each. A whole switch tick of a game
  (`ENTER` redraws the whole screen) is longer: 26 to 31 refreshes on TSRun and 23 to 27 on ZEsarUX (cross-emulator check, section 11).

## 9. Tests (summary; each named in its slice)
Runtime: m19 picture / beam / regs / mem / perf + mutations. Compiler: m19 compiler and differential + mutations. Studio smoke. Every example's
recorded runs unchanged (hash baselines; Starfall's are re-recorded in F5 because its play scene changes, with the old ones kept as the
`shooter-v1` / two-buffer fixtures). Cross-emulator: the sample games' pictures on TSRun, ZEsarUX and Fuse after scripted ticks (as Orbit Gates).

## 10. Sample games (as built)

The owner played the first set (2026-11-15) and changed it: Prism Catch was dropped and Starfall's art redone (section 11, "Rework"). What exists now:

1. **Starfall, every scene in fine colour** (`arcade/examples/shooter.*`; the assets file's `"scenes"` key sets title, play and over to `fine`; the
   `.arc` header says so). The sky is a starfield with a **shaded planet lit from the upper left** (black, blue, red, magenta bands joined by checkerboard seams), the title and the game
   over carry a **rainbow logo** and graded text (maps of tiles loaded over the sky), the border is black, and the ship, scouts, heavies, bullets and shots are shaded row by row.
   All art is generated by `shooter.assets.gen.mjs` with the helpers of `arcade/examples/fineart.mjs` (a full-colour picture, ordered dither between neighbouring colours, then cut into the
   8 x 1 groups and the de-duplicated tileset, at most 128 tiles). **7 instances of 5 assets (ship 1, bullets 2, scouts 2, heavy 1, shot 1) and 32 phases (ship 8, bullet 4, scout 8, heavy 8, shot 4)**: the
   cap in full. The HUD prints only the number that changed (a text cell costs about 1,800 T). Code 11,741 bytes, game 12,055 of 16,384, 4,329 free (`arcadec ... --runtime v2`). The old one-scene
   two-buffer game's assets are kept as `arcade/tests/fixtures/shooter-v1.assets.json` for the baselines that pin it. `tests/arcade-starfall-fine.mjs` (14 checks) and `tests/arcade-starfall.mjs` (9).
2. **LUMEN, the showcase** (`arcade/examples/lumen.*`, design in `lumen.md`): a **maze chase** (the owner chose the genre), every scene fine colour. A wisp eats light orbs in a cave maze; four
   horned shades (Ember, Bloom, Moss, Frost) hunt it; a prism in each corner turns them pale for a while (200, 400, 800, 1600 points); the caves alternate between two mazes (rainbow tubes, ice
   tubes) and the shades get faster each cave; the goal is the best score. Controls Q A O P or joystick 1, fire starts and restarts. 10 instances of 7 assets (wisp 2, shades 4, pale 4) and
   28 phases, at most 5 moving at once; code 12,018 bytes, game 12,540 of 16,384, 3,844 free; songs on channels A and B with the effects on C. `tests/arcade-lumen.mjs` (bots on the real runtime
   against the interpreter, the rules, the picture against `finePicture` every tick, the rate, the beam).
3. **Prism Catch** (the earlier design) is **gone**: its files, test and dist entry were removed (`3e89557`). Its shaded gems and sunset gradient read as random colours to the owner.

What the games show together: per-row colour in tiles and sprites, shaded sprites over per-row backgrounds, graded text, scenes of the same game (here all fine; the mix of fine and two-buffer
scenes is tested by `tests/arcade-m19-differential.mjs`, not shown by a sample).

## 11. As built

Branch `arcade-fine` from `main` `c245446`; done 2026-11-14 / 15, PR pending. Runtime details (method, RAM, per-routine times): `arcade/runtime/v2/NOTES-FINE.md` and
`docs/ARCADE_RUNTIME_API_V2.md` ("As built: fine colour"). Every figure below is from the commit message named, a test run for this write-up (2026-11-15, TSRun) or the file named.

**F0, the contract** (`3b399e5`). This file and the resume note.

**F1, the spike** (`5c25607`; `arcade/spike/fine/`, `RESULTS.md`). Methods A, B0, B80, B and BD measured on TSRun's beam and on Fuse; the figures and the owner's three decisions are section 3a.
The same screens on ZEsarUX and Fuse as on TSRun (0 pixels off).

**F2, the runtime** (`25c6101`; `arcade/runtime/v2/fine.asm`, `layout.inc`, `test_fine.asm`, `NOTES-FINE.md`). Method BD. `RT_FINEMODE` is `$328A` (the old `RT_END`) and `RT_END` is now `$3BD4` (`runtime.json`):
**`fine.asm` is 2,378 bytes (bound 2,500) and leaves 1,068 bytes free after `RT_END` (bound >= 900)**: 3,446 - 2,378. Costs on TSRun (`m19-runtime-perf`, 12 checks): 25,224 T per moving
16x16 sprite (**the 12k target missed**, section 8), 23,895 T when byte aligned, 12,595 T per 8x8, 1,761 T per dirty text cell, 46 T per published group, 3,724 T for an empty fine tick; `RT_FINEMODE` on
843,308 T and off 821,386 T (14 refreshes each). Starfall-like ticks (compose + publish, median / 95th): 8 sprites (5 16x16, 3 8x8) 171,601 / 178,094 T against the 20 Hz tick of 176,064 T; 10 sprites 215,596 /
228,462; 12 sprites 233,849 / 257,494; 16 sprites 314,681 / 329,683. Beam (1,500 frames, frame_div 3): 8 sprites 1,482 clean, 0 torn, 0 broken; 16 sprites 1,476 clean, 3 torn, 0 broken (the 3 ticks whose
update did not fit the 660-group list). Deviations from the contract (`NOTES-FINE.md`): (1) **no test in `main.asm`**: `RT_FINEMODE` on replaces the return address `main.asm` left on the stack, so a game
without fine colour pays +0 T instead of +27 and the call is allowed only inside `init_entry` or a `frame_entry` (the compiler's `ENTER` always is); (2) row ranges per cell row; (3) the 12k target; (4) a list overflow
composes the leftover rows during the publish (the contract's rule), about 1 tick in 70 with 16 moving sprites. Tests: `m19-runtime-fine` (27 checks: pictures against the reference after every update of random scenes,
switches, interrupts injected at every instruction of fine.asm, memory confinement, a game without fine colour; 27 passed again for this write-up with `M19_QUICK=1`), `m19-runtime-perf` (12), `m19-mutations` (186 mutants: 177 killed,
9 equivalent). Baselines regenerated against `c245446` (`regen-baselines.mjs --old c245446`): byte identity held.

**F3a, the compiler and interpreter** (`d00c842`; `src/lang/arcade/`). The setting from the assets file's `"scenes"` key or `arcadec --scenes <file>`; `sceneDisplayPlan` gives `built: 'fine'` for a fine scene of a v2 game;
`convertTileset` keeps the tile's eight row attributes and `convertSprite` its row inks; the fine descriptor (`fine$desc`: `DW tile_rows`, `DW sprite_inks`) and the `RT_FINEMODE` calls (`A` = 1 / 0, `HL` = the descriptor) at every `ENTER`
and at the start of `init_entry` for a fine first scene; the 32-phase cap in `arcade-link.js` (`FINE_MAX_PHASES`); the errors of section 1; the reference `finePicture` in `src/lang/arcade/arcade-fine.js`; the interpreter's
records carry the scene mode. `tests/arcade-m19-compiler.mjs`: 120 checks then, 153 now (153 passed for this write-up).

**F3b, mutation and differential suites** (`b296fb7`, `3869654`). `arcade/tests/m19c-mutations.mjs`: 238 mutants, 0 survived. `tests/arcade-m19-differential.mjs`: fine <-> two-buffer switching in every
direction against the interpreter, state and picture every tick, and the frames around a switch: **36,050 checks in 65 s** (quick mode 3,699 in 7 s): 79 runs, 6,796 ticks, 239 plain->fine, 237 fine->plain,
321 fine->fine, 230 plain->plain switches, no mismatch. It found the split writes of decision 12.9.

**F4, the Studio** (`b296fb7`, `9a053ac`; `studio.js`, `studio.html`, `src/tools/`, `docs/ARCADE_STUDIO.md`). "Finer colour" is offered for a v2 game without WIRE3D (the plan text, no "not built yet"), the
sprite editor's fine preview is checked against `finePicture`, the tile editor notes the 8 x 1 rule; after the owner's play `9a053ac` made a tile **keep its eight row colours** (`rowColours` in `tile-model.js`:
every example round-trips), added the tile editor's 8 x 1 colour view (on for a fine project), "Rows -> one colour", the map editor's thumbnails in fine colour, and taught the asset check that a fine scene's sprites carry
their own ink (no `background-attr-mix`) and that `black-bright-mix` / `bright-black-paper` read every row. Tests: tile-model 162/162, map-editor 95/95, studio / tile / sprite / map smokes, m18c 99 killed + 3 equivalent of 102 (per the commit message).

**F5, the sample games** (`47bba69`). Starfall's play scene in fine colour (7 sprites at 20 Hz: bullets 2, scouts 2, heavy 1, shot 1; 97 to 100 % of ticks at 20 Hz, 0 broken frames, every fine picture equal to the interpreter's)
and Prism Catch (MAXGEMS 5, 20 phases; 99.9 to 100 % at 20 Hz). The new Starfall and Prism compiled byte-identically with the compiler of `c245446` (the m19 non-fine baseline, `m19-nonfine-baseline.json`).

**Rework after the owner played (2026-11-15).** The owner played F5 and answered: Prism Catch is dropped (the art read as random colours); Starfall's art is redone with every scene fine and a black border;
the showcase is a maze chase.
* `b86c885`: Starfall's new art (shaded planet, rainbow logo, graded text), `arcade/examples/fineart.mjs`, `lumen.md`; the owner approved the stills. `tests/arcade-starfall-fine.mjs` 14 checks and
  `tests/arcade-starfall.mjs` 9 checks (this run: 1,340 fine ticks started, 717 play gaps, 716 of 3 refreshes (20 Hz) and 1 of 4).
* `3e89557`: **LUMEN** added, Prism Catch's files, test and dist entry removed, the example counts (Studio, map / tile models, m17) updated. `tests/arcade-lumen.mjs` was 25/25 at that commit
  ("99.6-99.9 % of play ticks at 20 Hz, beam 0 broken"). (The title's keys line became `MOVE WITH Q A O P` / `OR JOYSTICK 1` after a review of the title, since fire only starts the game; the test follows.)
* `3869654`: the differential suite (F3b above). `9a053ac`: the Studio fixes (F4 above).
* **Cross-emulator check** (`arcade/spike/fine/RESULTS.md`, "Cross-emulator check of the fine games (2026-11-15)"; scripts `arcade/tools/xemu/fine-*`): Starfall (347 ticks, 40 sampled for state) and Lumen
  (687 ticks, 57 sampled) match on TSRun, ZEsarUX and Fuse: **0 of 2,131,968 (Starfall) and 0 of 4,220,928 (Lumen) 8x1 groups differ between TSRun and ZEsarUX, state bytes identical at every sampled
  tick, and every one of the 347 / 687 tick pictures appears in Fuse in order with 0 of 49,152 pixels off.** Differences are in time only: a switch tick takes 26 to 31 refreshes on TSRun and 23 to 27 on
  ZEsarUX (its 48K-like timing); Fuse's PPM paints the runtime's switch border (colour 1) red, border only. **A scene switch between two fine scenes shows a top-to-bottom wipe** (10 to 17 Fuse frames
  per switch; TSRun's beam 14 and 47 frames for the two games): every group is the picture before or after, never another colour (decision 12.10).
* Not verified: real hardware; ZEsarUX frame by frame (its memory at the sampling point only); Fuse's state (frames only); a joystick on ZEsarUX / Fuse.

## 12. Decisions for the owner's review (Claude's calls; the work proceeds on them)

1. **The setting is a project setting only** (`scenes.<n>.display`), no source clause; `arcadec` reads it from the assets file's `"scenes"` key
   or `--scenes`. (Alternative: a `SCENE x FINE` clause, which would make the source self-contained but duplicate the Studio's select.)
2. **A sprite recolours the ink only, keeping the background's paper and BRIGHT** (the plan's `AND $F8 / OR ink`), and **only the bytes its
   mask touches** (a byte where the mask is all `$FF` keeps its colour, so a shifted sprite's empty edge does not recolour a star next to it).
   The sprite's authored paper and BRIGHT per row are not used. (Alternative: ink + BRIGHT, `AND $B8`, which would let a sprite brighten.)
3. **Tile cells take the tile's eight authored rows; text cells their attribute on all 8 rows**; a tile cell's own attribute byte is not used in
   a fine scene.
4. **No fine scene in a `WIRE3D` game** (and none in v3 / v4 games): the wire tick and the fine tick would have to be combined; no sample game
   needs it.
5. **The screen update moves before `FRAME`** in a fine scene (it uses the positions of the previous tick's `FRAME`). The time from a key press to
   the picture stays about one tick, as with two buffers (draw, then the flip).
8. (Owner-decided after F1, section 3a: method BD, the 32-phase cap, Starfall at 20 Hz with fewer sprites.)
6. **The flicker targets** of section 3 (broken 0 except split writes, torn reported), measured on TSRun's beam, which is the only beam-accurate
   emulator we have; ZEsarUX's 48K timing and Fuse are checked by eye.
9. **Split writes during a scene switch are allowed above section 3's 1-in-1,000** (found by `tests/arcade-m19-differential.mjs`, 2026-11-15): a
   switch publishes the whole screen (longer than a frame), so the beam catches a group between its bitmap and its colour write in 3 to 7 frames
   per 1,000 of the frames around a switch (one group, one frame, always a mix of the old and the new picture). The suite asserts that no group is
   anything but a picture around the switch, black or such a split write, at most 2 split groups a frame and at most 2 % of the switch frames;
   the play-time target of section 3 is unchanged (the games measure 0).
10. **A switch between two fine scenes shows a top-to-bottom wipe, accepted as the transition** (found by the cross-emulator check of 2026-11-15, `arcade/spike/fine/RESULTS.md`). `ENTER` redraws the whole screen
   in the one switch tick; the update list cannot hold it, so the publish writes the rest straight, top to bottom, across 10 to 17 refreshes (Fuse; TSRun's beam shows the same, about one frame fewer). Every group
   of every such frame is the picture before or the picture after (no plain frame, no wrong colour), so section 4.3's letter ("the old picture, a frame of plain colour or the new picture") does not list it
   but its point (never garbage colours) holds. Claude's call: **accept it as a transition** (0.17 s Starfall's title to play, 0.28 s Lumen); the owner judges it by playing. A plain-colour step first (as the
   two-buffer to fine switch does) would be a runtime change. Same on every emulator checked, so not an emulator difference. Related timing: the switch tick costs 26 to 31 refreshes on TSRun against 23 to 27 on
   ZEsarUX, and Fuse colours the runtime's switch border (colour 1) red in its PPM (border only).
7. ~~The showcase game is "Prism Catch"~~ (section 10, then item 2): built, played by the owner and dropped (2026-11-15: the art read as random colours); the
   showcase is now **LUMEN**, a maze chase (the owner chose the genre), `arcade/examples/lumen.*`.
