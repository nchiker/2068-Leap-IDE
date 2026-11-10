# Leap Arcade language batch 4: scenes in the compiler (2026-11-10)

Gap-list item 8. Before this batch the parser and the checker knew `SCENE name ... ENDSCENE` and `ENTER name`, but the code generator and the reference interpreter accepted exactly one scene
(`a second SCENE is not supported yet`, `ENTER` unsupported). This file is the contract for the whole batch: language semantics, what the machine does at a switch, the runtime question, the checks,
the Studio changes and the acceptance tests. Style as batches 1 to 3: decisions where `docs/ARCADE_LANGUAGE.md` (lines 40-80) and `docs/ARCADE_PLAN.md` section 4 are silent. Code: `src/lang/arcade/`
(`arcade-check.js`, `arcade-codegen.js`, `arcade-interp.js`, `arcade-scan.js`, the new `arcade-display.js`, `arcade-compile.js`), Studio `studio.js`, `src/arcade-project.js`, `src/lang/arcade/profile.js`.

## 1. The model in one paragraph
A game is a list of **scenes**. The first scene in the source starts the game. A scene has its own `INIT` (runs once, when the scene starts) and `FRAME` (runs every tick afterwards), its own variables,
CONSTs, PROCs and DEF FNs; everything declared outside any SCENE (variables, PROCs, DEF FNs, CONSTs, assets, `FRAMERATE`, `WINDOW`, `VIEW3D`) belongs to the whole game. `ENTER name` ends the current scene
**at once** and starts `name`: the screen, the sprites and the sound are put back to the state the game started in, the new scene's own variables are zeroed, and its `INIT` runs, all inside the tick that
executed `ENTER`; the new scene's first `FRAME` is the next tick. **The rule to remember: a scene starts from the same machine state the first scene starts from.** The only things that carry over
are the game-level variables, the random sequence, and the window / 3D view (section 4).

## 2. `ENTER`
1. `ENTER name` is a statement, valid anywhere a statement is valid inside a PROC (`INIT`, `FRAME`, any PROC they call, a top-level PROC too), never in a DEF FN (an expression has no statements). `name` is a
   scene name written out (no run-time value); entering the scene you are in is allowed (a restart).
2. **From inside a PROC.** `ENTER` does not return: the running PROC and every PROC that called it (up to `INIT` / `FRAME`) are abandoned, whatever statement was half done, whatever depth. Nothing
   after the `ENTER` in the same block can run; the checker warns about such a statement (`unreachable statement`, as after `EXIT`). Locals and hidden slots of the abandoned PROCs are static, so
   nothing needs cleaning up.
3. **Order of a switch** (all inside the call of `FRAME` or `INIT` that executed `ENTER`):
   (a) abandon the running PROCs; (b) **reset the machine** (section 3); (c) zero the target scene's variables and copy its array initialisers (section 5);
   (d) call the target's `INIT`; (e) return to the runtime, which draws the tick. So the tick of the `ENTER` shows what `INIT` made; `FRAME` of the new scene runs from the next tick.
4. `ENTER` inside `INIT` is allowed (a scene that decides at once where to go). The new scene's `INIT` runs the same way, so a ring of `INIT`s that enter each other forever hangs the game like any
   endless loop; there is no guard.
5. The statement sets no condition for the tick timing: a switch that does a lot (the reset clears the screen, 69k T-states, then `INIT`) may overrun its tick; the runtime handles an overrun as ever
   (the flip waits, nothing is skipped). The first scene's `INIT` at boot is no different.
6. The game starts in the first scene: the runtime boots (this is the "game start state"), game-level variables are 0, the game-level array initialisers and the **first scene's** own variables /
   initialisers are applied, then the first scene's `INIT` runs. Other scenes' variables are 0 until they are entered.

## 3. The machine reset (what `ENTER` does to the machine)
Defined as a sequence of ordinary statements, so that **no new runtime routine is needed** (see section 7). In this order:
| Step | State | After the switch |
|---|---|---|
| 1 | sound | `SILENCE`: the effect stops (when `MUSIC` exists it stops too) |
| 2 | sprites | **every sprite instance is hidden.** On a runtime with `RT_SHOWF` (v3, v4) each is first shown at (0, 0) with frame 0 and then hidden, so its stored position and frame are the start values too (a later `SHOW` without `FRAME` draws frame 0); on v2 (no frames) only `HIDE` |
| 3 | text state | `INK 0 : PAPER 7 : BRIGHT 0`; the print cursor is 0, 0 (set by `CLS`) |
| 4 | border | the runtime's boot colour (`BORDER_COLOUR`, blue, from `runtime.json` symbols) |
| 5 | screen cells | `CLS`: every cell is a blank with paper 7 (all tiles and text gone) |
| 6 | first map | if the game declares a screen MAP (not the `WINDOW` world, not the `VIEW3D` floor plan), `LOADMAP` of the first one at (0, 0), exactly what the boot does; with no map nothing is loaded |
**Not touched:** game-level variables and arrays; the random sequence (`RND`'s seed, no re-seed); the tick / frame counters; assets (the TILESET, the SPRITE pools, SFX, MAPs are game-wide); the
`FRAMERATE`; the keyboard / joystick state (edge detection variables are the game's own, so keep the ones that must survive at game level). **`WINDOW` and `VIEW3D` are game-wide:** a scene
switch leaves the camera, the world (`SETWORLD` edits), the 3D pose and the walls (`SETWALL` edits) as they are, and the window / view keeps being drawn in every scene; a scene that wants a
fresh view says so in its `INIT` (`CAMERA`, `SETWORLD`, `VIEW`, `SETWALL`). (A scene without the window or the view needs a runtime that can switch them off; that is a later item, section 9.)

## 4. Per-scene state: variables, CONSTs, PROCs, DEF FNs
1. **Scope** (the checker's existing rule, now implemented below it): a name declared at the top level is visible everywhere; a name declared inside a SCENE is visible in that scene only. A scene may
   reuse another scene's name for its own variable, CONST, PROC or DEF FN (two scenes can both have `DIM t` and `PROC UPDATE()`); a name already declared at the top level cannot be redeclared in a scene
   (the checker's no-shadowing rule). Top-level PROCs and DEF FNs see only top-level names (they cannot see any scene's variables), as before.
2. **Storage.** Every scene's variables have **their own slots** (no sharing between scenes, as PROC slots are not shared); they count in `GAME_VARS` like any variable.
3. **Life.** A scene's variables and arrays are zero and its array initialisers are copied in **every time the scene is entered**, including a restart by `ENTER` of itself. Game-level variables keep
   their value across switches (that is how a score reaches the game over scene).
4. **Names in reports** (`symbols`, interpreter records, Symbols tab): in a game with **more than one scene**, a scene's variables, arrays, PROCs and DEF FNs are keyed `SCENE.NAME` in upper case
   (`PLAY.ST`); game-level names stay plain. In a game with one scene (with or without `ENTER` of itself) every name stays plain, so old programs and tools are unaffected.
5. The generated driver adds two hidden slots (current scene, saved stack pointer); `symbols.scene = {cur, count, names}` gives the address of the current scene index (0 = first scene) for tests.

## 5. Code generation (what the compiler emits)
Used whenever the program has **more than one scene or any `ENTER`**; other programs compile to **identical bytes as before** (hash baselines of batches 1-3, one fixture re-pointed, see section 10).
```
entry$init (header init):  clear every slot; copy the game-level and first-scene initialisers; LD (scn$sp),SP; JP P$s0$INIT      ; INIT's RET returns to the runtime
frame$entry (header frame): LD (scn$sp),SP; LD A,(scn$cur); OR A / JP Z,P$s0$FRAME / DEC A / JP Z,P$s1$FRAME / ... / JP P$s(n-1)$FRAME   ; tail jumps: FRAME's RET returns to the runtime
ENTER k:                    LD A,k; JP scn$enter                                                                              ; 5 bytes, any depth
scn$enter:                  LD SP,(scn$sp); PUSH AF; CALL scn$reset; POP AF; LD (scn$cur),A; <dispatch on A: for scene k: zero its slot range (LDIR), copy its initialisers (LDIR); JP P$sk$INIT>
scn$reset:                  CALL RT_SILENCE; per instance (loop, instance count from the image): [v3+: RT_SHOWF(i, 0, 0, frame 0)]; RT_HIDE(i);
                            XOR A / CALL RT_INK / XOR A / CALL RT_BRIGHT / LD A,7 / CALL RT_PAPER / LD A,BORDER_COLOUR / CALL RT_BORDER / CALL RT_CLS / [XOR A / CALL RT_LOADMAP]; RET
```
* The stack pointer is restored, not unwound: PROCs have no stack frames (static slots; a `CALL` pushes only return addresses and expression temporaries), so cutting the stack back to the
  level where the runtime called us loses nothing. `LD SP,nn` completes before an interrupt is accepted; an interrupt after it pushes below the restored SP.
* Labels are scene-qualified (`P$s<k>$NAME`, `F$s<k>$NAME`) for scene-level PROCs and DEF FNs of any scene; top-level ones keep `P$NAME`. A scene's slots are allocated in one block, in scene
  order, after the game-level slots; each PROC / DEF FN is generated in the name scope of its home (the game, or its scene).
* With a screen MAP and a driver the image uses the extended header and map table (`LOADMAP` needs it), as if the program had a `LOADMAP`.
* The compiler adds: `usage.codegen.scenes` (count), `symbols.scene`, `symbols.procs` / `fns` / `vars` / `arrays` with the keys of section 4.4.

## 6. The checker
New or changed (messages are exact; positions as stated):
| Check | Severity | Message | At |
|---|---|---|---|
| statement after `ENTER` in the same block | warning | `unreachable statement` | the statement |
| a scene (not the first) that no `ENTER` names | warning | `SCENE 'x' is never entered: only the first scene starts by itself` | the scene name |
| `ENTER` of an unknown scene | error (existing) | `ENTER: unknown SCENE 'x'` | the name |
| `FOR` variable declared later: only the names visible to that PROC count (the game level, plus its own scene), not another scene's | fix | `'v' is declared later (line N) than this PROC: ...` (unchanged text) | the variable |
Code generator errors (position: the node): on a runtime below v2 a second scene and any `ENTER` keep the old refusals, now with a hint: `a second SCENE (M2 has exactly one) is not supported yet in M2 (build with --runtime v2)` and `ENTER is not supported yet in M2 (build with --runtime v2)` (`M3` on a v1 runtime). (A checker error for it would have changed the message the M2 suite tests; the generator already knows the runtime.)

## 7. The runtime question
**No runtime change in v2, v3 or v4: 0 bytes.** Every step of the reset is an existing routine (`RT_SILENCE`, `RT_SHOWF` (v3, v4), `RT_HIDE`, `RT_INK`, `RT_BRIGHT`, `RT_PAPER`, `RT_BORDER`,
`RT_CLS`, `RT_LOADMAP`), called from game code in the `frame_entry` / `init_entry` context they were built for; the scene dispatch lives in the game image (roughly 90 bytes of driver, 5 bytes per `ENTER`, and about 14 bytes per scene for
its variable clear plus its initialiser copies). The v4 runtime has 385 bytes free and the v3 735; neither is touched. The cost is image bytes (reported in the Studio's size panel)
and the tick that switches (section 2.5). A multi-scene program needs runtime v2 or later (the CLI default `v0` refuses it with the messages of section 6; the Studio always picks v2 or later).
What this design cannot do, and what would need a runtime routine, is section 9.

## 8. The reference interpreter
`interpret()` runs a multi-scene program with the semantics above: the same switch sequence on its model of the machine (sound stopped, sprites reset as section 3 step 2 says for the runtime
version it models, text state, border `opts.border0 ?? 1`, cell map blank / paper 7 then the first map), per-scene scopes rebuilt on entry (so scene variables are zero and initialisers re-applied),
`ENTER` as an exception caught where `INIT` / `FRAME` was called. Records get `scene` (the current scene's index) and the keys of section 4.4. The game-level initialisers and the first scene's are
applied at the start. `RANDOMISE` and `RND` state continue across a switch. The `init` record is the state after the first scene's `INIT`; a tick record is the state after the tick's `FRAME`, plus
the new scene's `INIT` when `FRAME` executed an `ENTER`.

## 9. Not in this batch (and why)
* **A scene with no window / 3D view, or its own window / view / world** (a title screen in a `WINDOW` game that shows no world; a level reset that reloads `world_src`): needs a runtime entry that
  decodes `world_src` again / rebuilds the ray array, or switches `V_WIN` / ray mode off; the v4 runtime has no room without moving code out. Workaround today: set the camera, the world and the
  pose in `INIT`.
* **Overlaying scene variables** in the same RAM (each scene's slots are separate); worthwhile only when `GAME_VARS` fills up.
* **Per-scene frame rate**, **a run-time scene index** (`ENTER n`), `CALL SCENE` / return to the previous scene, scene transitions (fades): none is in the language.
* **Display setups other than the two-buffer 8 x 8 colour mode** (section 10). The plan's "the runtime switches setup at the scene change" has nothing to switch between yet: only one setup is built.

## 10. Per-scene display plan and override (docs/ARCADE_PLAN.md section 4)
The compiler reads each scene and reports which of the plan's three setups suits it, and why; the project may override per scene; **only the two-buffer setup is built into the runtimes**, so today the
override can only pin it and the report says what is not built.
* `arcade-display.js`: `sceneDisplayPlan(ast, {scenes})` (pure) -> `[{name, line, col, auto: 'buffers' | 'fine' | 'hires', reason, override, setting, built: 'buffers', notes: []}]`.
  The code a scene runs is its `INIT` and `FRAME` and every PROC / DEF FN they reach (scene-level and game-level); `override` is `project.scenes.<name>.display` (`auto` when absent).
  `auto` is `buffers` ("two display files flipped each tick, because sprites move" / "because the window or 3D view is drawn" / "because FRAME redraws text or tiles") when the reachable code has `SHOW` or
  `HIDE`, or the game has a `WINDOW` / `VIEW3D`, or code reachable from `FRAME` uses `PRINT`, `TILE`, `FILL`, `FILLC`, `COPY`, `LOADMAP` or `CLS`; otherwise `fine` ("a static picture: 8 x 1 colour
  would give a colour per pixel row") when it draws tiles or a map in `INIT`, else `hires` ("text only: 512 x 192 hi-res would give 64 columns"). `setting` is the override unless `auto`.
* `compile(text, {runtime, image, assets, scenes})` returns `out.scenes` (that list) and warnings on the scene's line: an override that is not one of `auto buffers fine hires`
  (`scenes.x.display: 'q' is not a display setup (auto, buffers, fine, hires); ignored`), and `fine` / `hires` (`scene 'x': display 'fine' (8 x 1 colour) is not built into any runtime yet; the scene is
  built with two buffers`). A report line "would suit fine" when `auto` is not `buffers` is advice and gives no warning.
* `src/arcade-project.js`: `validateProject` keeps `scenes` as an object `{name: {display?: 'auto'|'buffers'|'fine'|'hires', ...}}`, dropping a non-object entry with a warning; `setSceneDisplay(project,
  name, value)` (`auto` removes the key).

## 11. The Studio
* **Symbols tab, Scenes group**: each scene `name` with `(start)` on the first, and its `ENTER` targets (`title (start) -> play`); a click goes to the `SCENE` line. `scanArcade` gets `enters:
  [{from, to, line}]` (`from` the scene name or null for a top-level PROC).
* **Scenes panel** (project panel, left, under the assets): one row per scene of the last compile: name, a start marker, the plan text (`auto: two buffers, because sprites move`), a select `Auto` / `Two buffers` /
  `8x1 colour (not built yet)` / `Hi-res text (not built yet)` (the last two disabled while the runtime lacks them, still shown if a loaded project carries them), which calls `setSceneDisplay`, marks the project
  changed and recompiles. The panel is empty for a one-scene game with no `ENTER`.
* The size panel gets a `Scenes` row (`3 scenes`), problems show the display warnings, and the scene examples (below) are in the Examples menu.

## 12. Example
`arcade/examples/shooter.arc` (Starfall) becomes real scenes **`title` -> `play` -> `over`** (game-over: fire starts a new `play`). Only the score and the wave are game-level (the over scene prints them); all gameplay
variables and PROCs live in the play scene, so every start of `play` zeroes them. This removes the game-over tile save / restore hack (the reset restores the sky from the first MAP) and the state variable. The pre-batch program is kept as `arcade/tests/fixtures/shooter-v1.arc` (+ the same assets), and
`batch1/2/3-baseline.json` point at it, so "old programs compile to the same bytes" still means the old program (the hashes are unchanged).

## 13. Acceptance tests
`tests/arcade-m9-compiler.mjs` (no real runtime), `tests/arcade-m9-differential.mjs` (the real v2 runtime, and v3 / v4 where noted), `arcade/tests/m9-mutations.mjs` (deliberate bugs in the new code), plus the
existing suites unchanged. They must show:
1. **Parser / checker**: every row of section 6 positive and negative; `ENTER` forward and backward references; two scenes with the same variable / PROC / CONST names; `ENTER` in INIT, in a nested PROC, in a top-level
   PROC, in a branch; `ENTER` in a DEF FN refused; scene never entered; a v0 / v1 runtime refused.
2. **Interpreter hand-computed**: state after each switch: sound stopped; sprites hidden (and at 0, 0 frame 0 on v3 / v4 models); text state, border, cells (blank, then map 0); scene variables zero on each entry and
   initialisers re-applied; game variables kept; `RND` continues; `ENTER` from depth 3 abandons the rest; `ENTER` itself restarts; INIT chain A -> B -> C; the switch tick's record.
3. **Differential on the real v2 runtime**: random programs (generated from a grammar: 2-4 scenes, random sprites / text / tiles / sound / `ENTER` conditions on tick counts and keys, nested PROCs, same names
   in several scenes) equal the interpreter on every tick: scene index, every variable and array, cells, attributes, cursor, text attribute, border, SPR_TAB, sound state, `V_BORDER`; at least 300 programs
   x 60 ticks in the full run (`ARCADE_QUICK=1` shrinks it). v3 (frames, a `WINDOW`) and v4 (a `VIEW3D`) programs: 20 each, with the game-level window / view state surviving a switch.
4. **Image**: single-scene programs without `ENTER` are byte-identical to before (the three baselines + Blockfall, Leap Runner, Vaults, Starfall-v1); the driver's bytes and slot ranges are as section 5 says; the size of the
   driver for 1, 2, 4, 8 scenes is reported.
5. **Starfall (scenes)** plays on the real runtime against the interpreter for >= 1,200 scripted ticks (title -> play -> over -> play) with equal records; the old `shooter-v1.arc` still passes its own tests.
6. **Mutation**: >= 25 deliberate bugs in the driver, the reset, the per-scene scoping, the interpreter's switch, the checker rows and the display plan; all killed except documented equivalents.
7. **Studio**: `tests/studio-smoke.mjs` (scenes panel lists a multi-scene game, the override round-trips through save / load, the Symbols labels), `tests/arcade-project.mjs` (`scenes` validation, `setSceneDisplay`),
   a display-plan unit test (every rule of section 10).
8. Everything else green: `node arcade/tests/run-all.mjs`, `tests/studio-smoke.mjs`, `tests/sprite-editor-smoke.mjs`, `tests/sprite-model.mjs`, `tests/arcade-project.mjs`, `tests/rom-checks.mjs`, `tests/browser-smoke.mjs`.

## 14. As built (2026-11-10)
* Decisions taken while building: a second scene / `ENTER` on a runtime below v2 is refused by the **code generator** with the old messages plus a hint (a checker error would have changed the M2 suite's text); the driver uses `LD (nn),SP` / `LD SP,(nn)` (ED 73 / ED 7B), the driver has 2 hidden slots (`scene.cur`, `scene.sp`);
  `ENTER` itself in a one-scene program also gets the driver; the check "FOR variable declared later" was narrowed to the PROC's own scope chain.
* Measured on the real v2 runtime (TSRun): Starfall title -> play -> over -> play over 1,300 scripted ticks equals the interpreter on every tick (variables, arrays, cells, attributes, cursor, border, sprites). A switch tick costs
  790k-830k T (13-14 refreshes) with the full-screen sky map (reset: CLS and LOADMAP; plus INIT) and the next tick about 390k T (the runtime redraws every dirty cell); the boot has always cost the same (787k T).
* Starfall is 8,479 bytes (the one-scene version 8,986): the sky repair code and the state machine are gone.
