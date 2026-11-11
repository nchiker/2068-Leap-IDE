# Leap Arcade language batch 7: scenes without the window or the 3D view, contract, 2026-11-11

Item 4 of `docs/ARCADE_SPACE_PLAN.md` section 4 (owner's order, 2026-11-11: this item, then pre-scaled billboards, then `MUSIC`, then a wireframe
game). Branch `arcade-scene-views` from `main` `3a22ea1` (PRs #9 and #10 merged). Binding; "As built" notes are added when each part is done.

**Owner's rule (2026-11-11): every improvement is used in the sample games, and each new feature has a sample game that shows it off.** Parts C
and D are not optional.

## 0. What exists and what is missing

`WINDOW` and `VIEW3D` are game-wide: today every scene of a `WINDOW` game shows the scrolling window, and every scene of a `VIEW3D` game shows the
3D view (`ARCADE_LANGUAGE_BATCH4.md` section 3). Leap Runner's and Vaults' titles therefore live inside their play scene as a state, drawn over
the world. Reloading a level already works (`WORLD name`, `WORLD expr OF ...`: banking and batch 6). What is missing is a scene that **does not
show the window / view at all**: a full-screen title picture, a menu, a high-score table, an interlude, with the whole 32 x 24 cell screen and
sprites at screen positions, and the window / view back when the game enters a playing scene.

## 1. The language

1. **`SCENE name NOWINDOW`** (a game with a `WINDOW`) and **`SCENE name NOVIEW`** (a game with a `VIEW3D`): a clause at the end of the `SCENE`
   line. `NOWINDOW` and `NOVIEW` are **contextual** (only there; a variable named `nowindow` stays legal, as `OF` in batch 6).
2. **Errors:** `NOWINDOW` in a game without a `WINDOW`; `NOVIEW` in a game without a `VIEW3D`; the wrong one of the two (`NOVIEW` in a `WINDOW`
   game, `NOWINDOW` in a `VIEW3D` game); anything else after the scene name.
3. **Meaning: the scene's display mode.** A scene without the clause shows the window / view as today. A `NOWINDOW` / `NOVIEW` scene runs exactly as
   a game without `WINDOW` / `VIEW3D` would: the whole cell screen (text, tiles, `LOADMAP` maps, `CLS`) is shown, and in a `NOWINDOW` scene sprites
   are drawn at **screen** positions by the 2D sprite machinery (v3 non-window mode, with its erase and dirty cells).
4. **Sprites in a `NOVIEW` scene (v4): drawn, as in a `NOWINDOW` scene** (decided by B0, section 3). Ray mode has no 2D sprite machinery, so the
   switch OFF builds a phase pool in the RAM that ray mode only uses within a tick, and the switch ON gives the assets back their billboard meaning.
   That pool is smaller than a normal game's (3,712 bytes against 5,888): **the linker refuses a `VIEW3D` game with a `NOVIEW` scene whose sprite
   art does not fit it** (the message says to use fewer phases), so it can never fail at run time.
5. **The world / view words keep working in every scene:** `CAMERA`, `SETWORLD`, `WORLD`, `WORLDTILE`, `TILEFLAGS`, `TILEHIT`, `CAMX`, `SOLID`
   (v3), `VIEW`, `SETWALL`, `WALL`, `SEEN`, `DEPTH`, `WORLD` (v4) act on the stored world / camera / pose / walls exactly as in a window scene;
   nothing of it is drawn until a scene with the window / view is entered. (A title scene may load level 1 with `WORLD`; a menu may move the
   camera.) `HIT` compares the stored positions as the mode's own rule does (screen boxes in a `NOWINDOW` scene, as in a game without a window).
6. **The switch** is part of `ENTER`'s machine reset (`ARCADE_LANGUAGE_BATCH4.md` section 3): after step 6 (the first screen map) and before the
   target's `INIT`, the target scene's mode is set. At boot, the first scene's mode is set before its `INIT`. Entering a scene of the same mode
   changes nothing (the call is made anyway; it is cheap). Switching **on** shows the window / view from the world, camera, bands, pose and walls
   as they are (the attribute caches invalidated: the next two ticks repaint the window in both files, as after the boot). Switching **off**
   leaves the cell screen as the reset made it (`CLS`, first map).
7. **Not in this batch:** a scene with a different `WINDOW` / `VIEW3D` (other geometry or bands); a `WINDOW` and a `VIEW3D` in one game; a mode
   change without `ENTER`; per-scene frame rate.

## 2. Part A: compiler, checker, interpreter, Studio words

* **Parser / checker** (`arcade-parse.js`, `arcade-check.js`): the clause and the errors of section 1.2 (no `SHOW` warning: sprites are drawn).
* **Linker** (`arcade-codegen.js` / `arcade-link.js`): a `VIEW3D` game with a `NOVIEW` scene gets a second phase-pool plan with the NOVIEW pieces
  (`planPhasePool` already takes pieces; it is skipped for `view` today, `arcade-codegen.js:2503`); art that does not fit is a build error.
* **Code** (`arcade-codegen.js`): in a program with **at least one** `NOWINDOW` / `NOVIEW` scene, every `ENTER` sequence calls the runtime's mode
  routine (section 3) with the target's mode after the reset and before `INIT`, and the boot entry does the same for the first scene. **A program
  without the clause compiles to the same bytes as before** (no call is emitted; the routines are appended to the runtime, so no address moves
  and the hash baselines stay as they are: `regen-baselines.mjs` must report 0 changes).
* **Reference interpreter and display model** (`arcade-interp.js`, `arcade-display.js`, `arcade-window.js`, `arcade-view.js`): the mode per
  scene; the picture of a `NOWINDOW` / `NOVIEW` scene is that of a game without the window / view; the switch as section 1.6.
* **Studio:** `NOWINDOW` / `NOVIEW` in the word tables (`arcade-words.js`: completion after `SCENE name`, hover help, the Help overlay),
  highlighting; the Symbols tab shows a scene's mode (e.g. `title (no window)`); `scanRoles` unchanged.
* `docs/ARCADE_LANGUAGE.md` gets the clause.

## 3. Part B: the runtimes

* **v3 `RT_WINMODE`**: A = 0 window off, 1 on. On is honoured only when the boot found a valid window (else `V_WIN` stays 0). Off: `V_WIN` = 0 and
  whatever the non-window path needs to start clean (the erase records empty, as at boot: the reset has hidden every sprite and cleared the
  screen). On: `V_WIN` = 1, `win_ac_clear`, the ring records empty. Clobbers AF, BC, DE, HL; IX, IY, alternates kept; interrupts on.
* **v4 `RT_VIEWMODE`**: the same for `V_RAY`, with the sprite pool (B0's option (c), measured on Vaults with a prototype):
  * **OFF:** `V_RAY` = 0; the asset records get their 2D meaning back (`AST_FTAB` / `AST_CLEN`: `ray_assets` overwrote them; `PHASE_OFF` survives);
    the phase pool is built by the existing pool code (enter `plan_pool`'s body after its `V_RAY` test: a label) with `FC_NEXT` at the **NOVIEW
    pool pieces** `NV_POOL_A = $CD00` (256 bytes), `NV_POOL_B = $EE00` (`$EE00-$FA7F`, 3,200), `NV_POOL_C = $D700` (256): RAM that ray mode
    only uses within a tick (`RAY_BREC`, `RAY_BCODE`, `RAY_DIST`, free bytes; the ray tables in `$C080-$CCFF` must survive and do); the erase
    records empty; the window's cells marked dirty in both files.
  * **ON:** `V_RAY` = 1; `ray_assets` and `ray_attrs` again (measured 2,078 + 11,115 T); nothing else is rebuilt.
  * `RT_VIEWMODE` saves IX, IY and the alternate set (`build_frame` clobbers them). The three pieces are exported in `runtime.json` (symbols).
  * **`RT_PLANLOAD` must work in a `NOVIEW` scene** (section 1.5): today it returns when `V_RAY` = 0 (`ray.asm:262`); test that the game has a
    view (`VD_COLW` <> 0, the same size) instead.
  * Measured in the prototype: OFF 10,800 T for Vaults' sprites at 1 phase (130,908 at 2 phases, 205,284 at 4: the OFF of an art-heavy game is a
    long tick, like a world load); ON 13,193 T.
* **v3 `RT_WINMODE`, the same two fixes:** OFF marks the window's cells dirty in both files (`RT_CLS` marks a cell only when its value changes,
  and the window's cells are never drawn from the cell map, so the last window picture would stay); **`RT_WORLDLOAD` must work in a `NOWINDOW`
  scene** (today it returns when `V_WIN` = 0): test that the boot found a window instead.
* **Appended after the runtime's last routine** so that no address moves; the two fixes inside `RT_PLANLOAD` / `RT_WORLDLOAD` keep their size if
  possible. If an address does move, the hash baselines are regenerated with `regen-baselines.mjs --old 3a22ea1` (cross-checked) and the As built
  notes say so. Bytes: v3 has 880 free (keep >= 600); v4 has 1,592 free at its end (`RT_END $39C8`; the 1,751 quoted before counted gaps).
* **Cost bounds:** v3 switch <= 5,000 T (amended after Part B: <= 8,000 T, since switching ON turns every sprite record a scene without the window left into dirty cells, about 480 T a record: measured 7,674 T with 32 records; a scene switch already costs about 69,000 T for the reset's CLS); v4 OFF <= 15,000 T beyond the pool build, ON <= 15,000 T; the tick of a `NOWINDOW` / `NOVIEW` scene costs
  what a game without the window / view costs.

## 4. Part C: Leap Runner shows it off (`arcade/examples/runner.arc`, v3)

* **`SCENE title NOWINDOW`**: a full-screen title picture (a 32 x 24 screen `MAP` built from the game's own tiles: block letters "LEAP RUNNER" in
  brick tiles, ground, coins; made by `runner.assets.gen.mjs` so it is reproducible), the high score, "PRESS SPACE OR FIRE", and **sprites at
  screen positions**: the hero runs across the title, a walker follows, a bat flies (showing that sprites work outside the window).
* **`SCENE demo`** (window on): the attract mode that today is the title state: level 1 scrolls by itself (the camera ping-pongs). The title and
  the demo alternate every 8-10 seconds; fire in either starts the game.
* **`SCENE play`**: the game as now, minus its title states; `INIT` loads level 1 with `WORLD` (the reload), game won / game over return to
  `ENTER title` (the reset reloads nothing by itself: `play`'s `INIT` loads the world, so a new game always starts on a fresh level 1).
* Room: the mapped part is 16,344 of 16,384 bytes; the title map (768 bytes) and the tables of levels 2-4 bank (the linker does it when the mapped
  part is full); report mapped / banked sizes. The first screen `MAP` is loaded by every reset (batch 4 section 3 step 6): declare maps so that
  each scene gets the cells it needs (the title loads its picture in `INIT` if it is not the first).
* **The play itself is unchanged:** the recorded play-through (`tests/arcade-runner.mjs --record`) is replayed from the press of fire on the title;
  every tick of the game after that equals today's (state compared), pause and high score as now.
* The title picture is shown to the owner (screenshot) before Part C is committed.

## 5. Part D: Vaults shows it off (`arcade/examples/vaults.arc`, v4)

* **`SCENE title NOVIEW`**: a full-screen title (block letters "VAULTS" in wall tiles, the treasure, gems that sparkle by tile swaps; sprites if
  part B0 allows them), "PRESS FIRE", the best score of the session.
* **`SCENE demo`** (view on): the slowly turning view that is today's title state; title and demo alternate; fire starts the game.
* **`SCENE play`**: the game as now; `INIT` reloads the floor plan (`WORLD level`), so a new game starts with every door and wall as at the start.
* The play itself is unchanged (Vaults' recorded tests replayed from the start of a game); the title is shown to the owner before Part D is
  committed.

## 6. Tests

* **Compiler:** `tests/arcade-m14-compiler.mjs` (parser, the errors, contextual words, code: the call in every `ENTER` and at boot only when a
  clause exists; byte identity of every program without the clause against `0e6f777`'s compiler with `ARCADE_OLD`, as m13).
* **Differential:** `tests/arcade-m14-differential.mjs`: interpreter vs TSRun tick by tick, state AND picture, on v3 and v4: switching both ways
  many times (title -> demo -> play -> title ...), sprites shown in a `NOWINDOW` scene and then in a window scene (positions keep their meaning
  per mode), world words used in a `NOWINDOW` scene and seen when the window comes back, `WORLD` in a `NOWINDOW` scene, the first scene with the
  clause, `ENTER` of the same scene.
* **Runtime:** `arcade/tests/m14-runtime-mode.mjs`: `RT_WINMODE` / `RT_VIEWMODE` against the model (both files after the switch and after the
  next two ticks; on without a valid window is a no-op), an interrupt at every instruction boundary, the memory audit (only the documented state
  written), the cost; `m14-mutations.mjs` (every mutant killed or proved equivalent).
* **Examples:** `tests/arcade-runner.mjs` and Vaults' tests updated (the title flow, the alternation, the replay from the start of a game); the
  Studio's Examples menu builds and runs both (`tests/studio-smoke.mjs`); `tests/arcade-runner-perf.mjs --check`.
* The full battery (`node arcade/tests/run-all.mjs` with the new steps, the Studio / editor / model suites, `rom-checks`, `browser-smoke`), and the
  cross-emulator check of Leap Runner and Vaults once (`arcade/tools/xemu/runner-*`, `vaults-*`; the scenarios start with the title).

## 7. Order of work

B0 (v4 investigation: done, section 3) -> A (compiler side) and B (runtimes) in parallel with disjoint files -> C and D (examples; the owner sees both titles)
-> tests, battery, cross-emulator -> As built, HANDOFF, plan, PR.

## As built

**Parts A and B (2026-11-11).**
* **Compiler side** (`arcade-parse.js`: the clause as `mode` on the Scene node, contextual; `arcade-check.js` `checkSceneMode`; `arcade-codegen.js`
  `emitSceneMode`: `LD A,0|1 / CALL RT_WINMODE|RT_VIEWMODE` after `scn$reset` in every `scn$go$k` and at boot, only in a program with a clause;
  a runtime without the routine is one compile error naming it; the NOVIEW pool plan from the runtime's `NV_POOL_*` symbols, a missing symbol
  is a compile error (no guessed address); `arcade-interp.js` / `arcade-display.js`: the mode per scene; the Studio words, completion after
  `SCENE name`, the Symbols tab shows `(no window)` / `(no view)`). 320 of 320 compilations without the clause identical to `3a22ea1`.
* **Runtime v3** (`arcade/runtime/v3/mode.asm`, appended): `RT_WINMODE`; a new byte `V_WINOFF` says "the window exists but is off" (the in-place
  `RT_WORLDLOAD` test `win_has` = `V_WIN or V_WINOFF`, same size); OFF marks the window's 384 cells dirty in both files and empties the 2D sprite
  records; both directions run `drawn_dirty` (each sprite record left by a non-window scene becomes dirty cells in its own file: the window tick
  never erases). Measured: OFF 3,654 T, ON 820 T + about 480 T a sprite record (7,674 T with 32). v3 free 656 bytes.
* **Runtime v4** (`arcade/runtime/v4/mode.asm`, appended): `RT_VIEWMODE` (saves IX, IY, the alternates); OFF gives the asset records their 2D
  meaning back and builds the pool at `NV_POOL_A/B/C` through the new label `plan_pool.body`, marks the view's cells dirty, and on an OFF before
  the first tick (a NOVIEW first scene) puts `BG_ATTR` back in both files' view area (the boot had written the view's colours there); ON runs
  `drawn_dirty`, `ray_assets` and writes the view's attributes into the HIDDEN file only; the other file gets them from `vm_pre` (the ray tick's
  first call, replacing `call ray_mask_dirty`: same size) in the tick that next draws it (`V_RAYATTR`), so the file on screen is never written
  (no colour flash). `RT_PLANLOAD` tests `view_has` (same size). Measured on Vaults: OFF 5,184 T + the pool (10,800 T at 1 phase), ON 10,830 T
  + about 2,450 T once on the next tick; every ray tick +27 T. v4 uses 15,069 of 16,384 bytes.
* **No existing address moved** in either runtime (only `RT_END`); the 6 whole-cartridge hashes of `batch3-baseline.json` changed because the
  cartridge contains the grown runtime (game areas unchanged; regenerated with `--old 3a22ea1`, old and new compiler cross-checked).
* **Tests:** `tests/arcade-m14-compiler.mjs` (96 + 1 with `ARCADE_OLD`), `tests/arcade-m14-differential.mjs` (39: interpreter vs TSRun on v3 and v4,
  titles against games without the window / view, the window / view back against games that never left it: the switched game is an odd number of
  drawn ticks behind, so its display files are compared crosswise), `arcade/tests/m14-runtime-mode.mjs` (44). `m14-mutations.mjs` is still to do.
