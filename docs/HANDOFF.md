# Handoff — Leap IDE (formerly the Leap V2 Web IDE)

Last updated 2026-11-06, after Leap V2 2.1.2-emu.1 (ROM entry, packages, cartridge `cartridge/2.1.2-emu.1/`, TSRun pin `9893b46`). Before that, 2026-11-02, after the three new ROM releases: Leap V2 2.1.1-emu.1 (`4aa678c`), 2068-Forth v2.0.1 and Leap-C 1.2.0 (`4c02f48`), the TSRun pin `c52f272` (`5c251a5`) and the ROM projects' answers (`c2fb7af`). Pushed on 2026-11-02 (TSRun `c52f272` first, then the IDE). Before that, 2026-11-01, after the speed test (all three languages, `1c74c46`), Forth F6 (`50fb417`), the keyed Leap-C Examples in the tests (`5cfffb8`) and the browser test's key-timing fix (`66a16e9`). Before that, 2026-11-01, Leap-C C9 (cartridge, `4798b64`) was added. Before that, 2026-11-01, Forth F4 (debugger, `054198d`), Leap-C C4 (debugger, exit status, `0b419d3`) and Forth F8 (cartridge, `f7a5d1d`). Before that, 2026-11-01, Forth F3 (static check), Import session and F5 (tape), and Leap-C 1.0.0 with C5 (tape), C6 (libraries) and C7 (Examples) (`a3869d4` to `1050d7b`). Before that, 2026-11-01, Leap-Forth (F0 to F2, `b9526ce`, plus Send) and Leap-C (C1 to C3, `d0e437b`) on top of stage 0 (language profiles, `3ed5d3b`). Before that, 2026-11-01 stage 0. Before that, 2026-11-01, the ROM projects' answers (Forth v2.0 released, Leap-C unblocked). Before that, 2026-10-31, the cartridge test (▶ Test DCK and Open `.dck`: the cartridge on the stock TS2068 ROMs in the IDE's emulator) and the multi-language plans (`docs/MULTI_LANGUAGE_PLAN.md`, `LEAP_C_PLAN.md`, `LEAP_FORTH_PLAN.md`; questions for the ROM projects in `docs/requests/`). Before that: share links (program in the URL fragment), packages on cartridges (DCK program image format 2), editor structure tools (folding, auto-indent, Tidy, go to definition, rename, line limit), the Examples menu and Z80 breakpoints.
Read `CLAUDE.md` first: it is the technical brief, and this file does not repeat it.
This file covers where the work stands, what the owner has decided, and how
to pick it up.

## Where it stands

**Leap Arcade / Leap Arcade Studio** (started 2026-11-09): a game-building BASIC compiled in JavaScript to native Z80 for the stock TS2068, delivered as a DCK cartridge, plus a browser Studio (`studio.html`). **Pick-up point (end of the first long session):**

* **Branches (nothing pushed):** `arcade-m3` has all the Arcade work (about 15 commits on top of `main`, which is untouched); `docs-split` has the owner's `CLAUDE.md` split (6 reference docs). They do not conflict. Suggested merge order: `docs-split`, then `arcade-m3`, then add a short "Leap Arcade Studio" paragraph to `CLAUDE.md` (text is in `docs/ARCADE_STUDIO.md` "As built"; it was left out to avoid a conflict).
* **Where things are:** plan and decisions `docs/ARCADE_PLAN.md`; hardware facts `docs/ARCADE_HARDWARE_NOTES.md`; language `docs/ARCADE_LANGUAGE.md` (+ `ARCADE_LANGUAGE_BATCH1.md`, and the work list `ARCADE_LANGUAGE_GAPS.md`); runtime contracts `docs/ARCADE_RUNTIME_API*.md` (v0, V1, V2, V3, V4 with "As built" notes; the slice contracts ARCADE_PLATFORMER_CONTRACT.md and ARCADE_RAYCASTER_CONTRACT.md; language batches 2 and 3); cartridge map `ARCADE_CARTRIDGE_MAP.md`; assets `ARCADE_ASSETS.md`; Studio `ARCADE_STUDIO.md`. Code: compiler `src/lang/arcade/`, runtimes `arcade/runtime/{v0,v1,v2,v3,v4}/` (v4 = the raycaster runtime, v3 = platformer/scrolling window, v2 serves the older games; the compiler and the Studio choose by program, `requiredRuntime`), Studio `studio.html/js/css` + `src/arcade-project.js` + `src/tools/sprite-*.js`, examples `arcade/examples/` (bounce, breakout, shooter, blockfall, platformer), measured spikes `arcade/spike/` (native vs bytecode, cartridge layout, scrolling, parallax, raycaster).
* **Done:** milestones M1-M4a, language batch 1 (CONST, locals, bit ops, array initialisers/2-D, FILL/COPY/LOADMAP...), four playable games (all checked on TSRun, ZEsarUX 13.0 and Fuse 1.9.1; the owner played shooter and breakout and liked them), Studio slice 1 (editor, projects, run, sprite editor). **The platformer slice (2026-11-09/10):** contract `docs/ARCADE_PLATFORMER_CONTRACT.md`; runtime v3 (`arcade/runtime/v3/`, `docs/ARCADE_RUNTIME_API_V3.md`: sprite frames, sprites to 32x48, per-asset frame cache, 24x16 scrolling window with banded parallax, camera, tile-flag collision, edge clipping with ring repair, RLE world decoder); language batch 2 (`docs/ARCADE_LANGUAGE_BATCH2.md`: WINDOW, BAND, CAMERA, CAMX, SETWORLD, WORLDTILE, TILEFLAGS, TILEHIT, SOLID, FRAME, FLIP, sprites to 32x48); the example **Leap Runner** `arcade/examples/platformer.arc` (`platformer.md`), published to the Studio, which now picks runtime v2 or v3 per program (`requiredRuntime`, `arcadec --runtime auto`).
* **The raycaster slice (2026-11-10, done):** contract `docs/ARCADE_RAYCASTER_CONTRACT.md`; runtime v4 (`arcade/runtime/v4/`, `docs/ARCADE_RUNTIME_API_V4.md`: `ray.asm`, 128x96 window, 4 px or 2 px columns, walls by method B, billboards with depth test, 15,999 of 16,384 bytes); language batch 3 (`docs/ARCADE_LANGUAGE_BATCH3.md`: VIEW3D, VIEW, COSA, SINA, FXMUL, WALL, SETWALL, SEEN, DEPTH); example **Vaults** (`arcade/examples/vaults.*`, a 32x32 maze with key, door, 5 wraiths, 15 fps). Measured on TSRun (no contention): walls 129k T worst of 16 poses at 4 px (spike 158k), 221k at 2 px; Vaults median tick 159k, worst 264k, 7 of 1,433 ticks (0.49 %) over its 4-refresh budget. **Open item, by measurement:** billboards cost 15k T (16x16) to 72k (16x16 within one cell), not the 9k the contract assumed (the spike kernel had no depth test and OR-only pixels); that is the "pre-scaled billboard sets" item of contract section 9, which Vaults now justifies; the runtime has only about 385 bytes left, so it needs code moved out or a banked module first. Cross-emulator (`ARCADE_HARDWARE_NOTES.md` 10b): TSRun and ZEsarUX identical over 250 scripted ticks (0 bitmap/attribute bytes differ), Fuse's screens identical to TSRun's; not covered: sound, AY joystick on ZEsarUX/Fuse, door/win paths, real hardware. Contract clarification 7 (array ring is never empty) is modelled by the interpreter and the mock.
* **Verify everything:** `node arcade/tests/run-all.mjs` (rebuilds the four runtimes, 56 steps, about 10 minutes; `--full` adds mutation runs). Also `node tests/studio-smoke.mjs`, `tests/sprite-editor-smoke.mjs`, `tests/sprite-model.mjs`, `tests/arcade-project.mjs`, and the original `tests/rom-checks.mjs` and `tests/browser-smoke.mjs` (all pass).
* **Play a game:** `node arcade/tools/arcadec.mjs arcade/examples/shooter.arc --assets arcade/examples/shooter.assets.json --runtime v2`, then Fuse: `fuse --machine ts2068 --rom-ts2068-0 tsrun/roms/ts2068-0.rom --rom-ts2068-1 tsrun/roms/ts2068-1.rom --no-confirm-actions arcade/build/shooter.dck`; ZEsarUX must be started from its folder: `cd ~/Applications/ZEsarUX-13.0 && ./zesarux --machine TS2068 <path>/shooter.dck`. Or the Studio: `python3 -m http.server 8080`, `http://localhost:8080/studio.html`.
* **Studio slice S2 (2026-11-10, done):** tile, map and sound editors and the asset warnings (mixed BRIGHT black, background cells with differing attributes, tile 0 not blank in a scrolling world, plus shape / undefined-tile / unstorable-sound checks). Contract `docs/ARCADE_STUDIO_S2_CONTRACT.md`, "As built: slice S2" in `docs/ARCADE_STUDIO.md`. The checks found the BRIGHT-black mix in Breakout, Blockfall and Vaults (fixed) and a 5-attribute background in Leap Runner and a 4-attribute one in the Vaults panel (left: art decisions, see ARCADE_STUDIO.md). Tile indices never renumber (the source names tiles by number); the sound preview uses TSRun's AY clock; sound is AY-only (the loudspeaker / CBEEP was considered and dropped for CPU cost, owner 2026-11-10, contract section 9 item 6); music and animated tiles stay with their planned items.
* **Next, in the owner's order (2026-11-09):** (1) language batch 1, (2) the platformer slice, (3) the raycaster prototype: all done (see above); the owner has not yet played Leap Runner or Vaults (open: does the feel of the trade-offs suit: Leap Runner's 4 px hero steps and 10 Hz enemies, Vaults' 15 fps and blocky 4 px columns). Next candidates: pre-scaled billboards (above), music (`MUSIC`, 3 AY channels), remaining gap-list items, real-hardware checks (scenes are done, see below).
* **Scenes in the compiler (language batch 4, 2026-11-10, branch `arcade-batch4`, done; not pushed, not merged).** Contract and decisions `docs/ARCADE_LANGUAGE_BATCH4.md`. `SCENE` / `ENTER` work in the checker, interpreter and code generator with **no runtime change** (v2, v3, v4 untouched): `ENTER` jumps to a generated driver that cuts the stack back, runs the machine reset (SILENCE, hide every sprite (RT_SHOWF to (0,0) frame 0 first on v3/v4), INK 0 / PAPER 7 / BRIGHT 0, border, CLS, LOADMAP of the first MAP), zeroes the scene's own variables and runs its INIT in the same tick. WINDOW / VIEW3D are game-wide and untouched by a switch (a scene without them needs a runtime change: contract section 9). A game with several scenes keys scene names `SCENE.NAME`. Switch ticks are expensive: about 790k-830k T (13-14 refreshes) for the switch tick with a full-screen map, then about 390k T for the redraw tick. **Starfall (`arcade/examples/shooter.arc`) is now title / play / over**; the old one-scene game is `arcade/tests/fixtures/shooter-v1.arc` (the three baselines and `tests/arcade-m4.mjs` use it). The Studio has a Scenes group (display override select; only the two-buffer setup exists, the others are listed "not built yet") and `->` labels in Symbols. Tests: `tests/arcade-m9-compiler.mjs`, `tests/arcade-m9-differential.mjs`, `tests/arcade-display.mjs`, `arcade/tests/m9-mutations.mjs` (47 mutants; `--full` in run-all). Next candidates: gap-list items 6, 7, 9 (three-channel effects only), 10, 11 by need; music; per-scene window / view (needs runtime room); pre-scaled billboards.
* **Language batch 5 (2026-11-10, branch `arcade-batch5`; gap items 6, 7, 9 without MUSIC).** Contract `docs/ARCADE_LANGUAGE_BATCH5.md` (section "As built" lines in Part C). `TIMER`, `KEYPRESS` / `JOYPRESS`, `PRINT ... USING`, `PLAY expr`, three-channel effects (runtime change in v2, v3, v4: `sound.asm`, `V_SFX_CH` at `$E080`; free bytes now v2 6,905, v3 593, **v4 237**; the three-channel tick sits in the gap `$0068-$00FF` of chunk 0). The sound editor has tracks A / B / C. **Costs to know:** a three-channel interrupt is about 2,160 T (a one-channel one 758 T, idle 151 T), which is 2.7 times the 800 T bound accepted for one channel (owner decision open: a faster tick would need more room than v4 has); `lib$fmt` is 179-182 bytes. Because the runtime moved `RT_*` addresses, `batch2/3-baseline.json` were regenerated with the batch 4 compiler on the new runtimes and checked equal to the batch 5 compiler (old programs still compile to the same bytes). New suites: `tests/arcade-m10-compiler.mjs`, `arcade-m10-differential.mjs`, `arcade/tests/m10-runtime-sound.mjs`, mutation `m10-mutations.mjs` (runtime, 30) and `m10c-mutations.mjs` (compiler, 31, 2 equivalent). `arcade/dist` was republished.
* **NEXT (owner, 2026-11-10): `docs/ARCADE_SPACE_PLAN.md`.** The banked cartridge map (a game up to 32 KB: 16 KB mapped + 16 KB in DOCK chunks 2-3 as cold-asset banks, checked against the TS2068 Technical Manual: the 64 KB cartridge limit is real, the 16 KB game limit was ours), its slices B0-B5, every item deferred for space in order (faster three-channel sound tick as a delta stream; port the v4 size pass to v3; blank-cell path; per-scene window / view reload; pre-scaled billboards; MUSIC), the open decisions and how to resume. Read it first.
* **The banked cartridge map, slices B0-B5 (2026-11-11, branch `arcade-banking`; PR #5 was merged into `main` first).** Contract and as-built notes `docs/ARCADE_BANKING_CONTRACT.md`. A game is now up to 32 KB: 16 KB mapped (chunks 4-5) + a **16 KB bank window** (DOCK chunks 2+3 mapped together at `$4000-$7FFF`, `$F4` = `$3F`) from which the runtime's loaders (`RT_LOADMAPPTR`, v3 `RT_WORLDLOAD`, v4 `RT_PLANLOAD`, and the boot) read maps, worlds and floor plans **in place**, interrupts on; compiled code never maps anything. The compiler banks automatically (largest first, only when the mapped part would not fit; per-map override `assets.maps.<name>.bank` = auto / mapped / banked, a Studio select), so programs that fit compile to the same bytes. New statement `WORLD name` (v3: another world, camera 0; v4: another floor plan); MAPs up to 64. Runtime bytes free now: v2 7,021, v3 2,075, v4 1,785. Probe on TSRun, ZEsarUX and Fuse (`arcade/spike/bank/`, `ARCADE_HARDWARE_NOTES.md` section 11): all pass; **ZEsarUX lets a mapped DOCK chunk be written** (TSRun / Fuse ignore it), and the stock ROM hands over with DOCK chunk 6 mapped. Example **Leap Runner (4 levels)** `arcade/examples/runner.arc`: mapped 16,342 + banked 1,670, identical on the three emulators through two banked-world loads (section 12). **Next limit:** per-level object tables live in code as array initialisers (the new levels' coins and enemies had to be cut); bankable per-level tables would need a copy (groups with bank C / `RT_BANKCOPY`). Tests: `arcade/tests/m11-runtime-bank.mjs`, `m11-mutations.mjs`, `tests/arcade-m11-compiler.mjs` (byte identity needs `ARCADE_OLD=<copy of the previous src/lang/arcade/>`), `tests/arcade-m11-differential.mjs`, `tests/arcade-runner.mjs`.
* **Bankable per-level tables, slices T1-T5 (2026-11-11, branch `arcade-tables`; PR #6, the banked map, was merged into `main` first).** Contract and as-built notes `docs/ARCADE_TABLES_CONTRACT.md`. `TABLE name` ... `ENDTABLE` (rows `array = values` / `variable = value`, game level or in a SCENE) and `LOADTABLE name` / `LOADTABLE expr` (index into the visible tables; outside the list does nothing). A table record is copied by the new `RT_TABLELOAD` (34 bytes, v2 / v3 / v4, appended so no address moved) **straight out of the existing 16 KB window into the variable block**: no bank C, no `RT_BANKCOPY` needed. Records bank automatically like maps. Runtime bytes free now: v2 6,987, v3 2,041, v4 1,751. Leap Runner uses four tables `lv1`..`lv4`: mapped 16,342 -> 16,131, about 1,280 bytes of mapped room now available for more coins / enemies (owner's call), gameplay identical (same play-through to the tick), identical on TSRun / ZEsarUX / Fuse (`ARCADE_HARDWARE_NOTES.md` section 13). Tests: `arcade/tests/m12-runtime-table.mjs`, `m12-mutations.mjs` (96/96), `tests/arcade-m12-compiler.mjs` (189), `tests/arcade-m12-differential.mjs` (21), `tests/arcade-runner.mjs` (57), `tests/studio-smoke.mjs` (92). `run-all.mjs` now also runs the m10-m12 compiler and differential tests (69 steps).
* **Leap Runner improvements and language batch 6 (2026-11-11, branch `arcade-runner-content`; PR #7, the tables, merged first).** Contract `docs/ARCADE_LANGUAGE_BATCH6.md` (with as-built notes). `WORLD expr OF m0, m1, ...` (a level costs data only); Leap Runner levels 2-4 fuller (46 / 44 / 50 coins, 10 / 10 / 11 enemies; limits asserted by `runner.assets.gen.mjs --check`), pause (H) and a session high score; the v3 window takes a cell's colours from the tile covering most of it (owner chose option 1 of a comparison of the black-outline colour clash: wrongly black pixels 523 -> 269 over a sweep; option 2, no black at all, waits for the blank-cell fast path that would pay its repaint cost). Worst tick headroom is now thin (platformer 174,919 of 176,064 T): the blank-cell fast path is the natural next item. Three stale mutation patterns repaired (m5, m7, m9).
* **The window fast path and colour-clash option 2 (2026-11-11, branch `arcade-window-fastpath`; PR #8 merged first).** Contract, owner's amendment and as-built notes `docs/ARCADE_WINDOW_FASTPATH.md`; runtime details `ARCADE_RUNTIME_API_V3.md` (last section). Runtime v3 only, compiled games the same bytes. A window cell whose two tiles differ in colour shows only the pixels of the tile whose colours it has (no wrongly black pixels); blank cells are written as zeros. `WORLD_RAM` bytes now carry class bits in bits 0-2 (`tile * 8 + S + 2D + 4P`; readers use the raw byte, the attribute / flags pages are replicated; tests compare the interpreter's WORLD_RAM with `AND $F8`). Leap Runner's worst non-load tick 173,167 -> 158,342, the platformer's 174,919 -> 160,199; worlds of dense colour boundaries are up to about 10 % slower to repaint than before (owner accepted), a world load about 2.5 frames longer; v3 free 880 bytes. New `tests/arcade-runner-perf.mjs`. **Trap:** a test that poisons `$4000-$7FFF` must spare `$5B00-$5EFF` in a window game (the class pass reads those pages).
* **Language batch 7: scenes without the window or 3D view (2026-11-11, branch `arcade-scene-views`; PRs #9 fast path and #10 Studio world roles merged first).** Contract, owner decisions and as-built notes `docs/ARCADE_LANGUAGE_BATCH7.md`. `SCENE name NOWINDOW` (v3) / `SCENE name NOVIEW` (v4): the whole cell screen and 2D sprites at screen positions; `ENTER` and the boot switch through the appended routines `RT_WINMODE` / `RT_VIEWMODE` (v4 builds a phase pool in `NV_POOL_A/B/C`, RAM ray mode only uses within a tick; the linker refuses art that does not fit); `WORLD` works with the window / view off. No runtime address moved (6 whole-cartridge hashes regenerated: the runtime grew). Free: v3 656 bytes, v4 about 1,315. **Sample games (owner's rule: every feature shown in an example):** Leap Runner and Vaults now have a full-screen title scene with sprites, a demo scene (the old attract mode) alternating with it, and the play scene (unchanged tick for tick from the press of fire; a new game reloads the level / maze). A scene switch costs about 1.0-1.2M T (0.3-0.4 s), at a transition only. Cross-emulator identical (`ARCADE_HARDWARE_NOTES.md` section 16). Also: the wireframe spike (`arcade/spike/wire/RESULTS.md`: two 12-point ships at 20 fps; recommendation a wireframe mode in v2, about 4.7 KB). New tests: `tests/arcade-m14-compiler.mjs`, `arcade-m14-differential.mjs`, `arcade/tests/m14-runtime-mode.mjs`, `m14-mutations.mjs`.
* **MUSIC M0-M4 (2026-11-12, branch `arcade-music`, pushed, no PR; B1 merged first as PR #13).** Contract `docs/ARCADE_MUSIC_CONTRACT.md` (5a: the runtime as built; 6a: the language as built; 11: Claude's decisions for the owner). The song player is in `sound.asm` of v2 / v3 / v4 (RT_MUSIC with HL = the song, RT_NOMUSIC; patterns with waits, order list, loop; a one-channel effect borrows channel C in games with songs, a three-channel effect pauses the song; state at `$FF00-$FF2A`; +431 bytes: v3 858 free, v4 874); games without songs write exactly what they wrote before (m10 compares with the runtime of `8737bdd`). Language and interpreter by an agent (merged), the Studio's song editor by an agent (merged). Tests: `tests/music-stream.mjs`, `arcade/tests/m15-runtime-music.mjs`, `m15-mutations.mjs` (83 / 83), `tests/arcade-m15-compiler.mjs`, `tests/arcade-m15-differential.mjs`, `m15c-mutations.mjs` (43 + 6 equivalent), `tests/music-model.mjs`; run-all 77/77. M5 followed the same day (next bullet).
* **MUSIC M5, songs in the sample games (2026-11-12, branch `arcade-music`, not merged: the owner listens first).** Contract section 8a. Original
  songs written as code in each game's asset generator (`arcade/examples/songs.mjs`, the Studio's note entry and instruments): Blockfall `stones`
  (in-game, 3,696 bytes), Starfall `fanfare` (title, 1,853) and `drive` (play, A and B only, 1,292), Leap Runner `rn_hop` (title and demo, 463), Vaults
  `vl_depths` (title and demo, 625). **Listen:** `node arcade/tools/song-wav.mjs arcade/examples/<game>.assets.json` writes `arcade/build/music/*.wav`, or
  the Studio's Examples menu (`arcade/dist` republished). Leap Runner had 117 mapped bytes: its source was rewritten for size by a Fable agent
  (reviewed; same variables, every runner test and the play digest unchanged; code 10,411 -> 9,384 before the song). Time: Runner worst gameplay tick
  160,456 -> 160,800 T, Vaults unchanged (8 over, as before), Blockfall worst 93,921 -> 94,258, Starfall 95th 99,608 -> 100,200; no new tick over budget.
  Tests: every game with songs compared at song level on the real runtime (new `tests/arcade-starfall.mjs`; runner, Vaults, Blockfall, m5 extended;
  `stripMusic` keeps the byte-identity checks on the song-less texts; `arcade/tests/fixtures/blockfall-v1.arc` for the hash baselines); run-all 78/78.
  Claude's decisions for review: contract section 8a. **Code review of the branch (2026-11-12):** a real runtime race fixed (with a song playing, an
  interrupt inside RT_PLAY / RT_SILENCE played the song over the effect for a refresh and moved a paused song: now the effect is posted, `SB_NEW`, and
  installed by the next refresh; contract 5a "Code review fix"; +76 bytes, v3 782 / v4 798 free), and nine Studio / checker / docs findings fixed (a
  false "too many songs", octave 0 notes refused, note entry after a pattern switch, the song editor's history and render cost, one source for the
  song limits, stale doc references). **Merged into main 2026-11-12 (owner listened). Next: the compiler size pass `docs/ARCADE_COMPILER_SIZE_CONTRACT.md`
  (written and reviewed by Fable 5.2, owner put arrays in batch 1; starts from `main` after `arcade-music` is merged), then the wireframe game.**
* **v3 size pass 2, parallel run-all, billboard spike (2026-11-11, branch `arcade-v3-shrink`; PR #11 merged first).** `node arcade/tests/run-all.mjs --jobs 4`: 74 steps in about 7.5 minutes on a quiet machine (sequential 21.5); builds and `tests/arcade-blockfall.mjs` run alone first, slowest suites first, `ARCADE_JOB_TAG` gives each step its own `assembleGame` work directory. v3 15,728 -> 15,095 bytes (**1,289 free**; Fable 5.2 agent, verified by the main thread: `ARCADE_RUNTIME_API_V3.md` "As built: size pass 2"; the boot is now 19 of its 20-frame bound). Billboards: spike B0 (`arcade/spike/bb/`) found neither a two-pass draw nor pre-scaled sets worth building; owner's decision: only the exact-output projection reorder, B1 (`docs/ARCADE_BILLBOARDS_CONTRACT.md` section 5): **done (2026-11-11, branch `arcade-billboards-b1`)**: every output the same, every target met (one in view 4,695 T, off the view 2,390, behind 1,039; Vaults' mean `ray_bb` 16,879 -> 14,773, ticks over budget 9 -> 8; +10 bytes; the one slower case, hpx = 0 far away, is accepted: `ARCADE_BILLBOARDS_CONTRACT.md` 5a, `ARCADE_RUNTIME_API_V4.md` "As built: the billboard projection reorder"). `arcade/spike/bb/proj-cases.mjs` times every projection path before vs after. **Next in the owner's order: `MUSIC`, then a wireframe game.**
* **Start of the next session: `docs/ARCADE_NEXT_SESSION_PROMPT.md`** (the prompt, the suggested model setup, the traps). `node arcade/tools/regen-baselines.mjs --old <ref>` regenerates the hash baselines after a runtime change, cross-checked against the previous compiler.
* **v3 size pass and the faster three-channel sound tick are DONE (2026-11-10, branch `arcade-batch5`, PR #5):** v3 15,791 -> 14,326 bytes; the delta-stream sound format replaces the 12-byte groups (compiler encoder + players in v2, v3, v4; the tick costs 260-1,115 T against 2,162 T); free bytes now v2 7,047, v3 2,159, v4 1,873. See `docs/ARCADE_SPACE_PLAN.md` for what comes next (the banked cartridge map, slices B0-B5).
* **v4 runtime size pass (2026-11-10, shrink-z80 skill, two workers, verified):** 16,147 -> 14,612 bytes, **1,772 free in chunks 0-1** (v3 593 free, v2 6,905: v3 is now the tightest; the same cold-code savings may port to it). See `docs/ARCADE_RUNTIME_API_V4.md` "As built: size pass".
* **Owner decisions (2026-11-10):** the emulators (TSRun, ZEsarUX, Fuse) are the test ground, real hardware cannot be tested; Leap Runner's and Vaults' feel trade-offs are accepted (the owner has played both); sound is AY-only.
* **Traps:** (a) everything is emulator-only; the first real-hardware test is whether the SCLD keeps displaying RAM while DOCK is mapped over `$4000-$7FFF` (`ARCADE_HARDWARE_NOTES.md` checklist item 0). (b) A sprite takes its colour from the screen cell under it, so background cells must share one attribute; TSRun draws BRIGHT-black paper as dark grey (`#333`), Fuse/ZEsarUX as black. (c) ZEsarUX returns AY register 14 as 0, which `RT_STICK` treats as "no stick". (d) The owner's `tools/pre-commit` hook re-stamps and `git add`s `ide.html` and `studio.html` on every commit: commit explicit paths and check `git status` first. (e) `arcade/build/` is git-ignored; after changing a runtime or an example run `node arcade/tools/publish-runtime.mjs` (it rewrites `arcade/dist/`, which the Studio serves) and never while a runtime build is mid-change. (f) The working pattern that has worked: write the contract doc first, then a runtime agent and a compiler agent in parallel (cheap models for routine testing), then verify everything yourself before committing.


All phases are done, and the IDE runs three languages: Leap V2 BASIC (Leap
2.1.1-emu.1; 2.1.0-emu.1 and 2.0.2-emu.1 stay in the ROM table), Leap-Forth
(2068-Forth v2.0.1; v2.0 stays) and Leap-C (1.2.0, with its own cartridge
build; 1.0.0 and beta.2 stay), chosen in the toolbar's language selector.
Nothing is on hold.
The DCK export, the last open item, was approved by the owner on 2026-10-28 and
is implemented.

| Done | |
|---|---|
| Phase 1 | Runs programs: RAM injection into the real Leap 2.1.1-emu.1 ROMs in TSRun (2.1.0 and 2.0.2 still known) |
| Phase 2 | CodeMirror 6 editor, Leap syntax, autocomplete, hover help, auto-caps |
| Phase 3 | Debugger: breakpoints, Step/Pause, variables, call stack, registers, memory |
| Phase 4 | PC keyboard mapping (`"` is `"`), keys reach the TS2068 only while a program runs |
| Phase 5 | Error checking by the ROM's own compiler on a hidden machine |
| Phase 6 | TAP export, byte-identical to Leap's `SAVE`; DCK export (`src/lang/basic/cartridge.js`, toolbar "⬇ DCK"): a cartridge that runs on a stock TS2068, also a flat 64 KB `.bin` for a cartridge board. A program's package goes on the cartridge too (image format 2). "▶ Test DCK" and Open `.dck` run a cartridge on the stock ROMs in the IDE's emulator (2026-10-31) |
| Phase 7 | Symbols / UDG / Draw tabs (Draw zooms 1×–3×) |
| Phase 8 | Help overlay (F1), keys & tips, light/dark themes |
| 2.1 | Leap 2.1.0-emu.1 ROM entry, regenerated keyword and error data, packages, tests |
| Stage 0 (2026-11-01, `3ed5d3b`) | Language profiles: the core (`ide.js`, `src/emulator.js`, `src/debugger.js`, `src/editor.js`, `src/pc-keyboard.js`, `src/help.js`) asks the active profile; BASIC moved to `src/lang/basic/` (`profile.js` pure, `editor.js` CodeMirror half, `leap-words.js` pure word tables). Per-language auto-save, `lang=` in share links, `?lang=`, language selector (hidden while there is one language), the IDE is now called Leap IDE. BASIC behaviour unchanged: 75 ROM checks and 42 browser checks pass |
| Leap-Forth (2026-11-01, `b9526ce`) | Stages F0 to F2 of `docs/LEAP_FORTH_PLAN.md`: TSRun pin moved to `11731e1`; the live OK prompt (keys always reach it); Run sends the editor's text line by line through `EDIT_BUF` / `EDITOR_LOOP_LIVE.enter` and stops at the first line with a nonzero `LAST_ERROR`, marking the failing token (`SRC_PTR`); Stop is BREAK; Forth editor, Help (184 words), Examples (15 manual programs + Blackjack). Send (Ctrl+Enter: the cursor's line or the selected lines to the live prompt) is done after the commit |
| Forth F3, Import, F5 (2026-11-01, `a3869d4`, `89a6d48`, `6103f66`) | F3: a static check (`src/lang/forth/forth-check.js`: undefined words, compile-only words at the prompt, unbalanced control structures, unclosed strings and `(` comments, `MISSING NAME`, `OUT OF RANGE`), advisory (Run does not refuse a flagged program); the live session's words are read from the dictionary at the prompt's key wait (`emulator.onKeyWait`, `attach().keyWait`) and the editor is checked again when LATEST changes (`sessionStamp`). Import session: the "Import" button above the screen opens the ROM's line store as a new unsaved `session.fs`. F5: ⬇ TAP writes what `SAVE-TEXT` writes (`src/lang/forth/tape.js`, byte-identical to the ROM's), Open reads a TEXT tape back |
| Leap-C 1.0.0 (2026-11-01, `ac0d00f`) | Leap-C 1.0.0 was released (tag `v1.0.0`, commit `83e6e21`); the TSRun pin moved from `11731e1` to `9f9bbc5` (only `roms/leapc-*.rom` and the READMEs changed); ROM entry from the release's emulator pack, keyword and error data regenerated at the tag (same content). The beta.2 entry stays in the table |
| Forth F4, debugger (2026-11-01, `054198d`) | `src/lang/forth/forth-debug.js`: the line table is built **while the program is sent** (each line enters at `EDITOR_LOOP_LIVE.enter`; at `INTERPRET_NESTED.token` with `STATE` 1 a record of `HERE` and the line; `COLON_XT` on the `:` line), so breakpoints stop in the program's words and, for a line outside a definition, when the line is sent; Step goes word by word; "Stacks and words" (data and float stack, the session's words with their values; shown between runs too); call stack from the return stack. Generic changes: `debug.beginRun(job)` passes the job to the adapter's `reset`, `adapter.version()` makes the controller place breakpoints again, `adapter.labels.variables` titles the section (`#vars-title`). Limit: only the words the latest Run or Send defined have lines (see Traps). 132 ROM checks, 61 browser checks at the commit |
| Leap-C C4, debugger (2026-11-01, `0b419d3`) | `src/lang/c/leapc-debug.js`: line table from the compiler (`STATEMENT`, `DCL_AUTOINIT`, `STMT_DO.cond`, `CG_UNIT.found`, `RUN_FNLINES`), the globals and function names copied at `RT_RUN`, memory read from `m.ram`, "Globals", the `IX` frame-chain call stack, Step statement by statement. The status bar gives `Finished: exit n` (from the report's text, `SH_REPORT_BUF`), and a run-time error or BREAK names its statement's line (`RT_ERRPC` + the line table: "Runtime error 6 on line 5"). The 1.0.0 entry was regenerated (`tools/leapc-rom-entry.py` emits `reportBuf`, `dclAutoinit`, `stmtDoCond`, `cgUnitFound`, `runFnlines`, `symGlo`, `rtRun`, `rtErrPc`); the beta.2 entry lacks them (no debugger, plain `Finished`, the C4 tests SKIP). Also fixed for all languages: a breakpoint toggle never removed the breakpoint (see Traps). 137 ROM checks, 62 browser checks at the commit. Not yet: locals |
| Forth F8, cartridge (2026-11-01, `f7a5d1d`) | ⬇ DCK and ▶ Test DCK for Forth (`src/lang/forth/cartridge.js`, a port of 2068-Forth's `tools/forthcart.py`; `cartridge/forth/2.0/forth_cart.dck`, the release's, identity `$FDBE`). The owner's choices of 2026-11-01 as built: the editor's text is interpreted on a fresh hidden machine (`interpretFresh`, about a minute of TS2068 time at most) and the start word is chosen at export (`ui.prompt`, the newest `:` word the default). Checks: the identity, `OUT` to port 244 / 255 (confirm), no `:` word. `profile.ownsCartridge` picks the keyboard table for a cartridge test (`emulator.testCartridge(dck, symbols)`). Verified on a stock TS2068 in Node; the DCK and BIN for the Blackjack demo are byte-identical to `forthcart.py`'s (checked outside the tests). 144 ROM checks, 63 browser checks |
| Leap-C C9, cartridge (2026-11-01, `4798b64`) | ⬇ DCK and ▶ Test DCK for Leap-C on Leap-C 1.1.0's runtime cartridge build (tag `v1.1.0`, commit `f8db836`, released 2026-11-02 UTC; the IDE still compiles with the 1.0.0 ROM entry, since the 1.1.0 ROMs are byte-identical, identity `$E90E`). `cartridge/c/1.1.0/`: `leapc_cart_home.bin`, `leapc_exrom.bin` (the release EXROM), `cartridge.json`, README. `src/lang/c/cartridge.js` (pure) ports the release's `cartpack.py` (program image format 1, `"LCPG"`, CRC high byte first; DCK: chunks 0-1 HOME, 4-5 the image at DOCK `$8000`, then chunk 2 past 16 KB, 6 EXROM; flat 64 KB `.bin`) and `c2cart.py`'s `region_blocks`. The checker's `compileImage()` compiles as the check does (with the program's library) and reads `RUN_MAIN`, `RUN_VOID`, `IMG_LIM`, `LIB_LOADED` and the regions' code and static data from `m.ram` (region 1 is under the EXROM). ROM-entry fields `runMain`, `runVoid`, `imgLim`, `romIdentity`, `cartridgeDir`; `tools/leapc-rom-entry.py <dir> <version> [<cartridge dir>]` (the third argument adds the last two). `profile.ownsCartridge` recognises `"LCPG"` at DOCK `$8000` (keyboard table for a cartridge test). Checks before export: the identity and EXROM against the loaded ROMs, `outp` to port 244 / 255 (confirm), compile errors with their line, one library at a time. Differences from RUN a user should know: no line number in the cartridge's report, UDGs blank at every start, a key after the report restarts from cold, `malloc` addresses differ. Verified: the IDE's cartridge for the release demo (`examples/cart_hello.c`) is byte-identical to the zip's `demo/hello.dck` and `hello.bin` (checked outside the tests); on a stock TS2068 in TSRun (Leap-C had not run its cartridge there) the cartridges run to their report, with and without the shapes library. 150 ROM checks (128 with `LEAPC_ROMS` on beta.2, which skips libraries, the debugger, tapes and the cartridge), 64 browser checks. Not tried: real hardware |
| Leap-C (2026-11-01, `d0e437b`, `94700cf`, `4f30b82`, `1050d7b`) | Stages C1 to C3 of `docs/LEAP_C_PLAN.md` (Run by the shell path, the ROM's `SH_COMPILE` as the checker with the error's token column, a C editor, Help from the manual) and C5 (⬇ TAP and Open, format word `$8C00`, byte-identical to the ROM's `SH_SAVE`), C6 (`LIB "shapes"`: `libs/c/1.0.0/shapes.bin` installed for every check and Run, or unloaded), C7 (Examples menu: the manual's 18 programs; 15 compared with the manual's exit status, screen and pixels in the tests). C4 and C9 followed (rows above) |
| Leap-C C7, keys (2026-11-01, `5cfffb8`) | `tests/rom-checks.mjs` section 9 now also runs the two Examples-menu programs that read keys, `guess-the-number` (`"50" ENTER "25" ENTER "37" ENTER`) and `a-menu` (`"12x23"`), and compares exit status, screen rows and pixels with the manual, like the 15 others: all match. The keys go on the keyboard matrix through the IDE's own `src/pc-keyboard.js` (`createPcKeyboard`, the profile's SYMBOL SHIFT table), one key each time the program waits in `getkey()` / `gets()`, as Leap-C's `tools/exectest.py` (v1.1.0) does through the ISR latch (see Traps). Helpers at the top of the test file: `keyEvent`, `parseCKeys`, `typeKey`. Still not driven: the tape example (`a-score-on-tape`). 151 ROM checks |
| Browser test, key timing (2026-11-01, `66a16e9`) | `tests/browser-smoke.mjs` holds each key typed at the Forth prompt 150 ms and releases it for 100 ms (`KEY_HOLD_MS`, `KEY_GAP_MS`; it was 60 ms, and a headless page runs the emulator's frames unevenly). That was the flake in Traps; three runs in a row were green after the change |
| Forth F6 (2026-11-01, `50fb417`) | The manual's examples are checked against their expected output. `tests/rom-checks.mjs` section 8 reads what each line prints as 2068-Forth's `tools/forthtest.py` (v2.0) does and compares it with `\ expect:` / `\ expect-end:` (`\ draws` is not read), types `\ keys:` on the matrix and holds BREAK for `\ break: after N` (`break: at SYMBOL` is not supported; the manual uses only `after N`). Lines go in one at a time through the IDE's Send path (`startRun` + `driver.inject`), which is `fharness`'s `host_line`. New `tools/gen-forth-doc-tests.py <2068-forth checkout> <ref> > tests/forth-manual-examples.json` (generated, never hand-edit): a port of `tools/docexamples.py`, every ```forth block of the manual, 313 at v2.0, identical to 2068-Forth's `tests/doc/manual_*.fs` (checked). All pass except one known emulator difference (`2 STICK .`, see Traps), which has its own check. `tools/gen-forth-examples.py` now writes `keys` as `[line, text]` and adds `demos/gallery.fs` (the Shooting Gallery; its header says it is the old demo ROM's source, not rebuilt for the finished ROM) as the Examples entry `gallery`, so the Forth menu has 17 programs; the 15 Part 7 programs pass with their own `expect` and `keys` data (3 read keys), the gallery loads (every line OK and silent) and `MAIN` shows the title screen. New table `FORTH_SCREEN_SYMBOLS` in the tests (`PRINT_ROW`, `GFX_PUTCHAR`; a new Forth release needs an entry). For Forth only F7 (UDG and Draw tools, optional), the optional LIB tape and the optional watches of F1 remain. 155 ROM checks |
| Speed test (2026-11-01, `1c74c46`) | "Spinning squares (speed test)", id `spin`, in the Examples menu of all three languages (`src/lang/spin-demo.js`, `SPIN_DEMO {basic, c, forth}`, appended by each profile, so the generated C and Forth lists are untouched). The same task and the same picture in each: 18 frames of 12 nested squares, 48 lines a frame, corners from an integer sine table; each times itself with its ROM's frame counter and prints the frames. Measured in TSRun: Forth 522 frames, Leap-C 1644, Leap BASIC 1901. Leap-C is the slowest of the compiled two because its `draw()` is slow (864 lines of 90 pixels: 2005 frames in Leap-C, 422 for Forth's `LINE`; its arithmetic is fast), which could be told to the Leap-C project. New section 10 of `tests/rom-checks.mjs`: each ends with no error and its counter counts, and the bitmap (rows 8 to 183) and attributes are identical across the three. The browser test's Leap-C Examples count is now 19 and its Tidy check includes the BASIC speed test. 157 ROM checks, 64 browser checks |
| Leap V2 2.1.2-emu.1 (2026-11-06) | Tag `v2.1.2-emu.1` (`1a4a861`): Array Store replace without double room, `SAVE ... ALL` (two blocks), segment 2 at `$5B00-$77FF` (7424 bytes; `FREE(1)`), `SAVE`/`LOAD ... CODE`, `MODE 1` interlock. ROM key `295dfe26…`; built from the tag in a scratch worktree, byte-identical to the release zip; the addresses of the compiler, VM and `SAVE` moved (`V2_SAVE` `$D715`, `STORAGE_SEND_BLOCK` `$C3DA`; `SAVE_SYMBOLS['2.1.2-emu.1']`). Keyword and error data regenerated (`FREE`, `LOAD`'s `CODE` forms, the array-full cause), `packages/2.1.2-emu.1/` (the six, byte-identical to 2.1.1's), TSRun pinned at `9893b46`. Cartridge: `leap.patch` rebased (one conflict, `OPTIONAL` in `write_v2_crossbank.py`); the cart EXROM overflowed by 14 bytes, so the symbol-table init and the package install call moved from `CART_RUN` (EXROM) into `CART_LOAD` (HOME); `cartridge/2.1.2-emu.1/` (HOME `5c5c8e89…`, EXROM `e43a842a…`, identity `$04B2`, `cart_check` OK, `setup.sh` reproduces it). `tests/rom-checks.mjs` (cartridge section included) and `tests/browser-smoke.mjs` pass; not run on a stock TS2068 |
| Releases of 2026-11-02 (`c2fb7af`, `4aa678c`, `4c02f48`, `5c251a5`) | **Leap V2 2.1.1-emu.1** (tag `v2.1.1-emu.1`, merge commit `4891681`): fixes `STICK` (AY port A made an input before each read; `STICK(n)` selects joystick n; result 0 to 31, +16 fire, both sticks; in TSRun `PRINT STICK(1);" ";STICK(2)` gives `0 0`, was `0 1`), `LINE` (Leap-C's port of Forth 2.0's `GFX_LINE`, 4 to 5 times faster, same pixels; `LINE` now moves off-screen ends to the nearest edge), the colour rows of mode 1 (the colour bytes were written at `$6000 + y*32 + col` instead of the bitmap address + `$2000`, nchiker/2068-Leap#5; **with 2.1.0 mode 1 programs showed wrong colours in the IDE**, now right) and the p / q / g glyphs (#6); also Leap-C's interrupt idle path. ROMs HOME `c79ce1cf…`, EXROM `ba7f0869…`, key `57153400…`; the release bundle has no `.sym` files, so the ROM entry (`tools/leap-rom-entry.py`: `keyWait` `$0437`, `keyWaitEnd` `$043D`; the data layout, `symCounts` `$B800`, `V2_SAVE` `$D702`, `STORAGE_SEND_BLOCK` `$C3F1` and `FRAMES` did not move) was made from a `make build` of the tag in a temporary detached worktree (since removed), byte-identical to the zip. Keyword data and error data regenerated (only `STICK`'s entry; errors: the header), `LEAP_MANUAL_REF` `v2.1.1-emu.1`, `packages/2.1.1-emu.1/` (the six, byte-identical to 2.1.0's), `SAVE_SYMBOLS['2.1.1-emu.1']` in the tests, `cartridge-build/leap.patch` rebased onto the tag (both commits applied cleanly, `setup.sh` `TAG=v2.1.1-emu.1`) and `cartridge/2.1.1-emu.1/` (HOME `14d50f5f…`, EXROM `2058303e…`; `cart_check` OK; identity `$4E00`, 2.1.0's was `$E0A5`). **2068-Forth v2.0.1** (tag `v2.0.1`, merge `0dabe74`): the `STICK` fix; HOME `f0cd0785…`, EXROM unchanged `fd877dd0…`, key `e57d88cd…`, `ROM_IDENTITY` `$F001`; TSRun `main` `02e5325` carries it; entry, `forth-words.js` (`STICK`, `MIXER` text), `examples.js` and `tests/forth-manual-examples.json` (same 313 blocks) regenerated at the tag; `cartridge/forth/2.0.1/forth_cart.dck` (the release's, `1f673221…`); `FORTH_TAPE_SYMBOLS['2.0.1']` (`$09D9`, `$0A68`) and `FORTH_SCREEN_SYMBOLS['2.0.1']` (`$81CF`, `$0710`). The `KNOWN` list is gone: all 313 blocks pass on 2.0.1, and the `2 STICK .` difference is expected, with its own check, only with the 2.0 ROMs (`FORTH_ROMS`). **Leap-C 1.2.0** (tag `v1.2.0`, commit `e5cc932`): the display code of Forth 2.0 ported (D25 to D29: `draw()` about 4 times faster; print, scroll, interrupt faster; pixels and glyphs identical to 1.1.0's; banner `2068 LEAP-C 1.2`); ROMs HOME `510023ba…`, EXROM `14ee2434…`, key `5f0cc97f…`; TSRun `main` `34b0794` carries them; entry from the emulator pack with `cartridge/c/1.2.0/` as third argument (`romIdentity` `$F6E9`, 1.0.0 / 1.1.0 `$E90E`); `cartridge/c/1.2.0/` (HOME `505d0f79…`, the release EXROM, `cartridge.json`); `libs/c/1.2.0/shapes.bin` (byte-identical to 1.0.0's); keywords, errors and examples regenerated at the tag; the IDE's cartridge for `examples/cart_hello.c` at `v1.2.0` is byte-identical to the zip's `demo/hello.dck` and `hello.bin` (checked outside the tests). Example 11: the 1.2.0 manual carries the IDE's replacement plus `// attr: 5 5 56`, so `tools/leapc-example-overrides/` is deleted (the generator keeps `apply_overrides`); `tools/gen-leapc-examples.py` reads `// attr: ROW COL V` into `attrs` and the C7 check compares those bytes. Test changes: the C9 identity check reads `<cartridgeDir>/cartridge.json` (was a hard-coded `$E90E`); `tests/browser-smoke.mjs` accepts any version in the language-boot checks (`/^Forth \d/`, `/^Leap-C \d/`). **TSRun**: `c52f272` (on top of `34b0794`, pushed first) puts the 2.1.1 ROMs in `roms/leap-0.rom` / `leap-1.rom`. **Speed test**, whole run from injection to its end (`VERBOSE=1` prints "(basic: N frames from the start of the run to its end)"): BASIC 2081 frames on 2.1.0, 850 on 2.1.1 (about 2.4 times faster); Forth 656 on 2.0 and 2.0.1. Not measured: Leap-C on 1.2.0, and the BASIC program's own printed figure on 2.1.1 (1901 on 2.1.0). 156 ROM checks, 64 browser checks, all pass; with `LEAP_ROMS` on the 2.1.0 ROMs the ROM checks pass too |
| Extras | New/Open/Save + browser auto-save, `.tap` import, packages (`CIRCLE`, …) loaded automatically, whole-pixel display zoom, module fingerprints, editor find / replace (Ctrl+F / Ctrl+H), Undo / Redo / Cut / Copy / Paste / Find buttons, editor folding, auto-indent / dedent, Tidy (Shift+Alt+F), block-keyword match, go to definition (F12, Ctrl+click), rename (F2), line-limit ruler at column 127, Examples menu (12 programs and the speed test, `src/lang/basic/examples.js`), Z80 breakpoints and Step instruction in the debugger, share links (Share button; program in the URL fragment, nothing uploaded) |

**Done for 2.1.0-emu.1** (tag `v2.1.0-emu.1`, commit `c005159`, published
2026-10-28; superseded by 2.1.1-emu.1, see the 2026-11-02 row): the ROM entry (key `5a42872e…`), `src/lang/basic/leap-keywords.js` and
`src/lang/basic/leap-errors.js` regenerated at the tag, packages copied (byte-identical to
2.0.2's), `SAVE_SYMBOLS` added, TSRun moved to `016787f` (now `11731e1`, see below). The key tables did
not change (`src/pc-keyboard.js` untouched). The Stop workaround (a jump to the
command loop) is still needed: BREAK alone does not end an `INPUT` wait in 2.1
either (checked in Node; its VM latches error 66 and stops after ENTER).

**DCK export (done 2026-10-28).** `src/lang/basic/cartridge.js` builds the DCK from the
program's bytecode, which the checker machine compiles (`compile` in
`src/lang/basic/leap-check.js`), and from the cartridge images in
`cartridge/2.1.0-emu.1/`. Those two images are Leap 2.1.0-emu.1's *cartridge
build* (`make cart`), built by `cartridge-build/setup.sh`. See "DCK" in
`CLAUDE.md` for the layout and the button's checks. Checked: the tests run the
exported cartridge on a stock TS2068 in TSRun; the IDE's DCK is byte-identical
to `cartridge-build/tools/leap2cart.mjs`'s for two programs; there 695 corpus programs match `RUN` on the release ROMs (5 expected
differences, 0 failures) and ZEsarUX 13.0 with the stock ROM gives screens
identical to TSRun, as do Fuse 1.9.1 with two cartridges downloaded from the
IDE. Not tried: real hardware. Not supported yet:
tape / Array Store, returning to an editor.

**Packages on cartridges (done 2026-10-28).** The program image is format 2:
after the bytecode, a package length (LE16, 0 = none, at most 1024) and the
package image. The cartridge's `CART_LOAD` copies it to `$F400` and sets
`V2_PACKAGE_LEN`; `CART_RUN` calls its install entry, as `LOAD "NAME" EXT`
does. `leap.patch` is now two commits on the tag, and the cartridge images
changed (new SHA-256 in `cartridge/2.1.0-emu.1/README.md`; identity still
`$E0A5`). A fresh clone from GitHub plus `setup.sh` reproduces both images byte
for byte. The export uses `packageFor` (one package at a time, as Run does) and
refuses a package if the cartridge build's format is below 2. Checked: the 33
`pkg=` examples of the manual, run from the cartridge against `RUN` with the
package installed (32 pass, 1 expected difference, 0 fail), and a SHAPES
program (`CIRCLE` + `FILL`) on a stock TS2068 in `tests/rom-checks.mjs`.

**Editor tools (done 2026-10-28).** `src/lang/basic/leap-lang.js` gained `lineTokens`,
`nameTokens`, `blockStructure` and `blockIndent`; `src/editor.js` builds on
them: folding, auto-indent and dedent, Tidy, matching block keywords, go to
definition, rename and the line-limit ruler (see "Language mode and editor" in
`CLAUDE.md`). Indentation is stored by Leap verbatim, so Tidy's indent counts
towards line length and the pool. Bug fixed in `setSource(text, {fresh:true})`:
after `view.setState()` Chrome's EditContext kept the old cursor, so the next
keystroke past the new text's end threw "Invalid change range" and was lost
(New / Open while the editor had focus). The fix dispatches selection anchor 0
with the theme reconfigure right after `setState`.

**Examples menu and Z80 breakpoints (done 2026-10-28).** "Examples ▾" opens one
of 12 programs from `src/lang/basic/examples.js` as a new unsaved document;
`tests/rom-checks.mjs` section 3b runs each on the real ROMs. The debugger
panel has a "Z80 Breakpoints" section and a "Step instruction" button (see
"Debugger" in `CLAUDE.md`).

**On hold:** nothing.

**Stage 0 done (2026-11-01).** The language profile is implemented and committed
(`3ed5d3b`); see CLAUDE.md "Languages (language profiles)" and the "Stage 0:
what was built" section of `docs/MULTI_LANGUAGE_PLAN.md` (where it differs from
the plan).

**Forth and Leap-C running (2026-11-01).** Forth F0 to F2 (`b9526ce`), F3
(`a3869d4`), Import session (`89a6d48`), F5 (`6103f66`), F4 (`054198d`) and F8
(`f7a5d1d`), and Leap-C C1 to C3 (`d0e437b`), the move to 1.0.0 (`ac0d00f`; the
TSRun submodule was then at `9f9bbc5`; now `c52f272`, see the 2026-11-02 row), C5 (`94700cf`), C6 (`4f30b82`), C7
(`1050d7b`), C4 (`0b419d3`) and C9 (`4798b64`) are done; see CLAUDE.md
"Leap-Forth", "Leap-C" and "Debugger". F6 (`50fb417`) is done too, so Forth lacks only the optional F7 tools, the
optional LIB tape and the optional watches. Nothing is open with the Leap-C
project (all notes answered, see Traps), and Leap-C lacks only optional things: locals in the debugger,
driving the tape example in the tests (the key-reading ones are driven since
`5cfffb8`), running the C examples from cartridges against the manual, and the
C8 tools. Its cartridge (C9) is built on Leap-C 1.1.0's cartridge build
(released 2026-11-02 UTC, tag `v1.1.0`, commit `f8db836`; the Leap-C project's
description is `docs/requests/LEAP_C_CARTRIDGE.md`, read only: other people's
file); the 1.0.0 ROM entry used 1.1.0's cartridge because the ROMs are
byte-identical (identity `$E90E`). Since 2026-11-02 the current entry is 1.2.0,
with its own cartridge build (identity `$F6E9`).

**Multi-language plans (2026-11-01).** The two ROM projects answered the IDE's
questions (`docs/requests/LEAP_FORTH_ANSWERS.md`,
`docs/requests/LEAP_C_ANSWERS.md`) and the plans were updated from them.
2068-Forth v2.0 is released (tag `v2.0`, commit `50170f2`) with its manual, the
IDE hooks it added (`LAST_ERROR`, `EDITOR_LOOP_LIVE.enter` / `.key_ret`,
`INTERPRET_NESTED.token`) and its cartridge build (`forth_cart.dck`, program
image "F1" at DOCK `$4000`); the TSRun fork's `main` (`11731e1`) carries its
ROMs; this repository's submodule was moved to it in `b9526ce` (Forth stage F0). Leap-C was at `v1.0.0-beta.2` then; the owner lifted the
rule that its work waits for 1.0, so it proceeded on beta.2, and 1.0.0 was
released the same day and adopted (`ac0d00f`; the ROM entry and data were
regenerated, nothing else changed). Its cartridge (C9) followed in `4798b64`,
on Leap-C 1.1.0's cartridge build. The order is **stage 0 (the language profile, now done) -> Forth -> Leap-C**
(both unblocked; Forth first because its release, manual and cartridge are
complete). Plans: `docs/MULTI_LANGUAGE_PLAN.md`, `LEAP_FORTH_PLAN.md`,
`LEAP_C_PLAN.md`. Forth's cartridge choices were made on 2026-11-01 (see F8 and the
owner decisions below).

### Studio (Leap Arcade Studio), slice S1a (2026-11-09, branch `arcade-m3`)

`studio.html` + `studio.js` + `studio.css` is a second shell on the IDE's modules (not `ide.js`): project panel (files,
assets), CodeMirror editor for the `arcade` language, TS2068 display with zoom, size panel, problems list, tabs
Display | Symbols | Sprites. Open it with `python3 -m http.server 8080` and http://localhost:8080/studio.html. Design,
file list, the emulator's `cartridgeOnly` / `runCartridge` change and the asset-editor host interface:
[`docs/ARCADE_STUDIO.md`](ARCADE_STUDIO.md) ("As built", "Asset editor host interface"). Traps:
`arcade/dist/` (runtime + examples) is committed because Pages has no build: after any runtime or example change run
`node arcade/tools/publish-runtime.mjs` (`--check` reports a stale copy) or the Studio runs old code;
`tools/stamp-modules.py` now stamps both pages (run it after any `.js` change); `arcade` is deliberately not in
`PROFILES`; after a Run the stock ROM needs about 2 s to boot into the cartridge, and `V_TICKS` holds RAM-test garbage
(>= 400 for the template) until the game zeroes it, which tests must allow for. Tests: `node tests/studio-smoke.mjs`,
`node tests/arcade-project.mjs`.

## Owner decisions (keep them)

- Leap is V2 (2.1.1-emu.1 now; 2.1.0-emu.1 and 2.0.2-emu.1 are still in the ROM table). V1 is irrelevant.
- **Typing never reaches Leap's own ROM editor.** All editing is in CodeMirror;
  keys go to the TS2068 only while an injected program runs (`INPUT`, `INKEY$`).
- Keys are mapped as a PC keyboard is labelled, not as the TS2068 keyboard is.
- Keywords are upper-cased automatically (no option). Names and strings are
  left as typed.
- A DCK must run on a **stock** TS2068, hence the separate cartridge build.
- DCK export: approved 2026-10-28. The cartridge images come from
  `cartridge-build/` (owner's choice: in this repo, not a repo of its own).
- TSRun fork (`nchiker/TSRun`): commit only changes that cannot break the
  TSRun that the Leap repo's browser demo uses.
- Theme button: a plain light/dark switch; until clicked, follow the system.
  (A three-way cycle was tried and rejected because clicks seemed to do
  nothing.)
- **Use cheaper models for routine work:** Sonnet for documentation and routine
  edits, Haiku for running tests (owner's request).
- Publishing: the repo is public at https://github.com/nchiker/2068-Leap-IDE;
  pushes to `main` deploy to https://nchiker.github.io/2068-Leap-IDE/.
- Forth cartridge (2026-11-01): the start word is chosen at export from the
  program's words; the cartridge carries the editor's text, interpreted on a
  fresh hidden machine, not the live session's dictionary. Built in `f7a5d1d`.
- Pushing to `main` (2026-11-01): approved for the multi-language work. The
  2026-11-02 commits were pushed with the owner's approval, TSRun `c52f272`
  first.

## How to resume

```sh
cd ~/Projects/Leap-IDE
git pull && git submodule update --init
python3 -m http.server 8080          # then http://localhost:8080/ide.html
node tests/rom-checks.mjs             # 156 checks, ~30 s, real ROMs in Node
node tests/browser-smoke.mjs          # 64 checks, headless Chrome
```

Both suites must print `All checks passed`. The browser test serves the repo
itself and finds Chrome: `$CHROME`, then Playwright's headless shell in
`~/.cache/ms-playwright`, then `google-chrome`/`chromium`. It needs Node 22+;
this machine has Node 24.

## Traps (each one cost time)

- **Push order.** When the IDE's submodule pin is a TSRun commit of our own
  (as `c52f272`, the Leap V2 2.1.1 ROMs, was), push it to nchiker/TSRun first,
  then the IDE, or GitHub Pages gets a submodule commit it cannot fetch. Per the
  owner's rule for the TSRun fork, such a commit changes only the ROM files and
  the READMEs.
- **Module fingerprints.** After changing any `.js`, run
  `tools/stamp-modules.py`, or the browser will mix cached old and new
  modules. In this clone the pre-commit hook (`tools/pre-commit`, installed by
  the owner's permission) does it on every commit. A fresh clone needs
  `ln -s ../../tools/pre-commit .git/hooks/pre-commit` again. If the owner
  reports "X does nothing" right after an update, suspect a stale `ide.html`
  first (GitHub Pages caches it for 10 minutes); Ctrl+Shift+R fixes it.
- **`~/2068-Leap/build/` is a dev build, not the release.** Its addresses
  differ from the releases (e.g. `V2_SAVE`). `~/2068-Leap` is the owner's working
  clone (its branch and local edits change), so build a release in a separate
  detached worktree, not by checking out the tag in place:
  `git -C ~/2068-Leap worktree add --detach <dir> v2.1.1-emu.1`, then
  `make build` in `<dir>` (`tools/leap-rom-entry.py` takes that directory and
  the version). The 2.1.0-emu.1 and 2.1.1-emu.1 builds were byte-identical to
  the release zips; the 2.1.1 release bundle has no `.sym` files, which is why
  its entry came from a build. Remove the worktree afterwards.
- **VM dispatch changed in 2.1.** Handlers end with `jp (iy)` to `VM_RUN.next`
  (the opcode fetch); only taken jumps, calls and waits pass `VM_RUN.loop`, now
  just the BREAK poll. The debugger hooks `vmNext` (`vmInstruction`), and
  `haltVm` moves the PC from `.next` to `.loop`. For users: in 2.1 BREAK is
  noticed only at a taken jump, call or wait, so "Stopped (BREAK) at line N"
  names the line that jump went to. `tools/leap-rom-entry.py` has a `FALLBACK`
  map (2.0.2 has no `VM_RUN.next`, so `vmNext` = `vmLoop` there).
- **Cartridge images are per Leap release.** `cartridge/<version>/` must be
  rebuilt (`cartridge-build/setup.sh`, with the patch rebased onto the new tag) for each new release.
  The cartridge refuses a program whose identity (CRC-16 of the ROMs it was
  built with) differs, and export refuses when `romIdentity(loaded ROMs)` is not
  `cartIdentity(cartridge HOME)`. A release without a `cartridgeDir` entry
  gives "There is no cartridge build for Leap <version>" (2.0.2 has none).
  Identities: 2.1.0-emu.1 `$E0A5`, 2.1.1-emu.1 `$4E00` (the IDE's
  `romIdentity` = `cartIdentity`, checked). The Leap project's answer file
  (`docs/requests/LEAP_V2_ANSWERS.md`) quotes "identity CRC $2A70 (was
  $0AEF)": that is a different CRC of theirs, not the IDE's cartridge identity;
  do not compare it with `cartIdentity`.
  Programs are limited to 4011 bytes of bytecode (and a package to 1024). A literal `OUT` to port 244 or
  255 can switch Leap itself out, so export asks first.
- **TAP test stand-in.** `tests/rom-checks.mjs` replaces `STORAGE_SEND_BLOCK`;
  2.1's block sender reports "sent whole" with carry set, and 2.1's `SAVE` stops
  after a header that reports an abort, so the stand-in returns with carry set.
  A future release may need a similar adjustment.
- **Error text.** The 2.1 manual writes run-time messages as `RUNTIME ERROR n`;
  `describeError` in `src/lang/basic/profile.js` drops a trailing " n" before adding the code.
- **`src/lang/basic/leap-lang.js` imports CodeMirror** (so does
  `src/lang/basic/editor.js`), so Node cannot import them, nor anything that
  imports them. The pure parts are in `src/lang/basic/leap-words.js` (word
  tables, `scanSymbols`, `packagesUsed`) and `src/lang/basic/profile.js` (the
  profile: driver, `prepareSource`, `describeError`, `attach()`). Pure helpers
  that Node tests need must stay in modules without CodeMirror imports
  (`src/files.js`, `src/lang/profiles.js`, `src/lang/basic/profile.js`,
  `leap-words.js`, `export.js`, `cartridge.js`, `leap-debug.js`,
  `leap-check.js`, `src/tools/draw.js`, `src/tools/udg.js`, and the Forth and
  Leap-C pure halves: `forth-scan.js`, `forth-check.js`, `tape.js`,
  `leapc-scan.js`, plus `forth-debug.js`, `cartridge.js` of Forth and
  `leapc-debug.js`).
- **Generated files moved.** `leap-keywords.js` and `leap-errors.js` are now
  under `src/lang/basic/` (`tools/gen-leap-keywords.py` and
  `tools/gen-leap-errors.py` write there); never hand-edit them. ROM entries go
  in `src/lang/basic/leap-roms.js`.
- **Auto-save keys moved.** The program is stored as `leap-ide.document.<id>`
  (BASIC: `.basic`); the old bare `leap-ide.document` key is migrated on first
  load.
- **Leap-C ROM entries.** 1.2.0 (the current one; 1.0.0 stays) was made, like
  1.0.0, from the release's emulator pack (`leapc-1.2.0-emulators.zip`:
  `roms/`, `symbols/`, `SHA256SUMS`; third argument `cartridge/c/1.2.0/`).
  `tools/leapc-rom-entry.py` wants one directory, so copy the
  images, the `.sym` files and their `SHA256SUMS` lines into one directory
  first. The beta.2 entry stays (`LEAPC_ROMS=<dir>` tests it; the library and
  tape checks print SKIP there). beta.2's tag had no `.sym` and no
  `SH_WAIT_KEY.key_ret` label, so it was built in a detached worktree and the
  script derived `key_ret` as `SH_WAIT_KEY.read + 3`. The keyword data comes
  from the manual at the tag (`tools/gen-leapc-keywords.py ~/2068-Leap-C
  v1.2.0`; the script sets `LEAPC_MANUAL_REF` to the tag name, it had been
  the tag object's hash), the errors from `include/leapc_errors.inc`, the
  examples from `docs/manual/07_examples.md`.
- **Leap-C libraries stay loaded between runs.** That is the ROM's design
  (`LIB "name"` loads, `LIB` alone unloads), and a loaded library takes image
  region 3 away from the compiler, so the IDE installs or unloads the program's
  library (`LIB_LOADED`) for every check and Run (`libraryFor` in
  `src/lang/c/profile.js`). A new release needs its images in
  `libs/c/<version>/` (the data block of each `libs/<name>.tap` of the pack);
  without them a library program says the library is not available.
- **Forth's static check is advisory and depends on the live session.** Run
  does not refuse a program the check flags (the ROM's answer is what Run
  shows). The session's words are read only when the machine is at the prompt's
  key wait, and again only when LATEST changed; a word defined while a
  program is busy appears after it ends. A `( … )` comment or string that spans
  lines is flagged (a warning for the comment) because sending is line by line.
- **Tape format words tell the languages apart:** Leap V2 `$81xx`, Leap-C
  `$8C00`, Forth `$8000`. `tapeToText(bytes, {accepts, language})` in
  `src/files.js` takes the accepted word; each profile's `ownsTape` is what
  Open uses (`profileForTape`).
- **Forth's ROMs in `tsrun/roms/` must match `forth-roms.js`.** The pair is
  refused if its SHA-256 is not in the table (v2.0.1 and v2.0 are both in it);
  the pin before `11731e1` carried an older Forth build (`760a5ce3…` /
  `2add175c…`). A TSRun move that changes
  `leapforth-*.rom` needs a new entry from `tools/forth-rom-entry.py` run on
  the unpacked release zip.
- **BREAK hold differs per driver.** BASIC holds BREAK until the key wait;
  Leap-C and Forth set `driver.breakHold` (5 frames) because the ROM latches
  BREAK in its interrupt and Leap-C's report then waits for all keys to be
  released. Without it a Leap-C Stop never reaches the report.
- **Forth's breakpoints cover only the words the latest Run or Send defined.**
  The line table is built while the program is sent and is reset by each Run
  and each Send (`debug.beginRun(job)`), so a word defined earlier, or typed at
  the prompt, has no editor lines: Step and breakpoints skip it, though it
  still shows in "Stacks and words" and in the call stack. Because Forth
  compiles as it reads, `adapter.version()` changes as records are added and
  the controller places the breakpoints again; a new adapter that grows its
  table while a run is watched needs the same.
- **Leap-C memory is read from `m.ram`, not through the paging.** `$C000-$DFFF`
  is the EXROM whenever the shell or an EXROM routine runs, and the program's
  static data (`RUN_FNLINES`, the globals) lies under it. A position counts
  only when its 8K chunk is RAM (`inRam`, port `$F4`). The globals and function
  names are copied at `RT_RUN` because the heap overwrites the compile
  workspace once the program runs. A Leap-C ROM entry without the C4 fields
  (beta.2) gets a no-op debugger and a plain `Finished`.
- **Breakpoint toggle (fixed in `0b419d3`).** Clicking a breakpoint in the
  gutter, or `toggleBreakpoint()`, never removed it: the state field tested a
  `RangeCursor`'s nonexistent `.done`, so every toggle added a duplicate. It
  affected all languages (BASIC too); the field now looks the position up with
  `set.between`. If breakpoints "cannot be cleared" again, look there first.
- **The browser test once lost the first key typed at the Forth prompt (fixed
  in `66a16e9`).** A timing flake in the test's 60 ms key press: a headless
  page runs the emulator's frames unevenly. The test now holds each key 150 ms
  and releases it for 100 ms (`KEY_HOLD_MS`, `KEY_GAP_MS`); three runs in a row
  were green. If the Forth typing check fails alone again, rerun before
  suspecting the IDE, and lengthen those two constants if it persists.
- **Typing keys in the Node tests: wait for the latch, not for the key wait.**
  The tests type on the keyboard matrix through the IDE's `src/pc-keyboard.js`
  (`createPcKeyboard`, the profile's SYMBOL SHIFT table). For Leap-C a key
  counts as taken when the ROM latches it (`KBD_KEYHIT` nonzero, set from the
  ISR with `KBD_LASTK`), then it is released for 3 frames; leaving the key-wait
  spin loop is no sign, since every frame interrupt leaves it. This is
  `tools/exectest.py`'s way (Leap-C v1.1.0; `// keys:` is "text", ENTER, DELETE,
  NONE or a number). Forth's `\ keys:` are Python escapes (`\r` ENTER, `\b`
  DELETE, `\xNN`; `\x01` to `\x04` the cursor keys, `\x10` BREAK, which is
  Escape on a PC) typed while the line waits.
- **Forth's `FRAMES` is `$80F4`, 33012 decimal; Leap's is `$8175`, 33141.**
  The speed test reads them (`FRAMES` in Forth, `PEEK` of 33141 in BASIC,
  `frames()` in Leap-C). Do not mix the two addresses up; each is the ROM
  table's counter of that ROM. Leap's did not move in 2.1.1 (per the release
  notes; the BASIC program's own printed figure was not read again on 2.1.1).
  A new release may move them.
- **`STICK` (historical, fixed 2026-11-02).** In Forth 2.0 `STICK_READ` read
  AY port A without making it an input and the mixer was left with port A an
  output, so TSRun returned the output latch (`2 STICK .` gave 1, the manual 0;
  Leap V2 BASIC's `STICK` had the same code, `0 1` in TSRun). Fixed in Forth
  v2.0.1 and in Leap 2.1.1-emu.1 (`PRINT STICK(1);" ";STICK(2)` now gives
  `0 0`). The `KNOWN` list in `tests/rom-checks.mjs` is gone; the `2 STICK .`
  difference is expected, with its own check, only when testing the 2.0 ROMs
  (`FORTH_ROMS`), which is why the ROM suite has 156 checks, not 157.
- **Notes sent to the ROM projects (2026-11-01): all answered (2026-11-02).**
  Leap-C: `docs/requests/LEAP_C_EXAMPLE_11.md` and
  `docs/requests/LEAP_C_DRAW_SPEED.md` by release 1.2.0 and the answer files
  `docs/requests/LEAP_C_EXAMPLE_11_ANSWERS.md` and `LEAP_C_1_2.md`. Forth:
  `docs/requests/LEAP_FORTH_STICK.md` by the v2.0.1 release itself; no answer
  file (`LEAP_FORTH_STICK_ANSWERS.md`) has arrived, so the release is the de
  facto answer. Leap V2 (the `STICK` and `LINE` observations, mode 1 colours,
  glyphs): `docs/requests/LEAP_V2_ANSWERS.md`, by 2.1.1-emu.1. As before, each
  project's session reads the notes from this repository and answers in a file
  beside them; those files are other people's, read only.
- **Forth's screen checks need per-release symbols.** `FORTH_SCREEN_SYMBOLS` in
  `tests/rom-checks.mjs` (`PRINT_ROW` `$81CF`, `GFX_PUTCHAR` `$0705` for 2.0,
  `$0710` for 2.0.1; `FORTH_TAPE_SYMBOLS` likewise: `$09CE` / `$0A5D` for 2.0,
  `$09D9` / `$0A68` for 2.0.1)
  comes from `~/2068-forth/build/forth_boot.sym`, whose HOME ROM is
  byte-identical to v2.0's (SHA-256 `730c86d0…`). A new Forth release needs its
  entry, or the F6 checks cannot read the screen. `tests/forth-manual-examples.json`
  is generated (`tools/gen-forth-doc-tests.py`), never hand-edited.
- **Leap-C's "Colour lines in high resolution" (example 11): resolved in
  1.2.0.** The 1.0.0 manual's version ended on a black screen; the IDE replaced
  the section with its own, and the 1.2.0 manual now carries that replacement
  (plus `// attr: 5 5 56`). `tools/leapc-example-overrides/` is deleted. The
  generator still has `apply_overrides`: to override a manual section again,
  create the directory with `<N>-<id>.md`, regenerate `src/lang/c/examples.js`
  and delete the file once a release's manual has it; an override for a
  section the manual no longer has stops the generator. `// attr: ROW COL V`
  directives become `attrs` and the C7 check compares those attribute bytes.
- **Forth's cartridge is built on a hidden machine, not the live session.**
  `interpretFresh` sends the editor's text line by line to a fresh Forth (boot
  600 frames, then 3000 frames in all for the text); top-level code runs, so a
  program that loops forever, waits for a key (`KEY`, `ACCEPT`, `INPUT` at the
  top level) or errors is refused with its editor line. The dictionary is
  read from `m.ram` (the EXROM hides part of it). The cartridge images are per
  Forth release, like BASIC's: `cartridge/forth/<version>/forth_cart.dck`
  (the release's `roms/forth_cart.dck`), and export refuses when the loaded
  ROMs' `ROM_IDENTITY` differs from the cartridge's.
- **Leap-C's cartridge is read from the checker machine's RAM.**
  `compileImage()` (`leapc-check.js`) reads the code and static data from
  `m.ram`, not through the bus: `$C000-$DFFF` is the EXROM again after
  `SH_COMPILE` returns and region 1's code is under it. The cartridge images
  are per Leap-C release in `cartridge/c/<release>/` (1.1.0's files serve the
  1.0.0 ROMs, which are byte-identical; the 1.2.0 ROMs differ, identity
  `$F6E9`, so the 1.2.0 entry uses `cartridge/c/1.2.0/`); export refuses when the loaded ROMs'
  identity or EXROM differs from the cartridge's. The cartridge's report has no
  line number and a key after it restarts the program from cold. A new Leap-C
  release: see CLAUDE.md "Adding a Leap-C release".
- **Forth's Run stops at the first error line** and sends nothing more; a
  `( … )` or string that spans lines does not continue (lines are sent as
  typed). Ctrl+Enter is a Forth thing (`keyboard.always`); BASIC and Leap-C
  ignore it.
- **Colours:** never hard-code hex colours in JS or CSS rules. Add a variable
  to both palettes in `ide.css` (see "Themes" in `CLAUDE.md`).
- The auto-mode safety check blocked writing into `.git/hooks` until the owner
  approved it explicitly. Treat similar persistence changes the same way: ask.
- `docs/mockup.html` is a visual target only; its sample code and keyword list
  are wrong.

## Repos and versions

| What | Where | State |
|---|---|---|
| This IDE | `~/Projects/Leap-IDE`, `nchiker/2068-Leap-IDE` | local branch `master` tracks `origin/main` |
| TSRun fork | submodule `tsrun/`, `nchiker/TSRun` | pinned at `9893b46` (Leap V2 2.1.2-emu.1 ROMs, 2026-11-06; before that `c52f272`, the 2.1.1 ROMs; pushed 2026-11-02, on top of `34b0794`, the Leap-C 1.2.0 ROMs, and `02e5325`, the Forth v2.0.1 ROMs, both pushed by the ROM projects; below them `9f9bbc5`, Leap-C 1.0.0, `11731e1`, the Forth v2.0 ROMs, and `016787f`, the 2.1.0-emu.1 Leap ROMs, on top of sound worklet fix `f65de5a` + tape fix `4db1f1e`) |
| Leap | `~/2068-Leap`, `nchiker/2068-Leap` | release tag `v2.1.1-emu.1` (merge commit `4891681`, 2026-11-02; earlier `v2.1.0-emu.1`, commit `c005159`); the clone may be on any branch, possibly with local edits: build releases in a worktree |
| Cartridge build | `cartridge-build/` in this repo | Source of `cartridge/<version>/`: `leap.patch` (two commits) on the `v2.1.1-emu.1` tag, applied by `setup.sh` into `leap/` (ignored). Status: `Docs/CARTRIDGE_STATUS.md`; CLI: `tools/leap2cart.mjs`. `~/Projects/Leap-Cartridge` was the original working copy |
| 2068-Forth | `~/2068-forth`, `nchiker/2068-Leap-Forth` | release `v2.0.1` (merge `0dabe74`, 2026-11-02; the `STICK` fix); word data and examples generated from it; ROM entry built from the unpacked release zip; earlier `v2.0` (commit `50170f2`) stays in the table |
| 2068-Leap-C | `~/2068-Leap-C`, `nchiker/2068-Leap-C` | release `v1.2.0` (commit `e5cc932`, 2026-11-02): the current entry, from the release's emulator pack with `cartridge/c/1.2.0/`; keyword, error and example data from the tag, `libs/c/1.2.0/`. Earlier `v1.0.0` (commit `83e6e21`, 2026-11-01; `libs/c/1.0.0/`) and beta.2 entries kept. Release `v1.1.0` (commit `f8db836`, 2026-11-02 UTC) added the runtime cartridge (`leapc-1.1.0-cartridge.zip`, `make cart`); its ROMs are byte-identical to 1.0.0's, so the IDE kept the 1.0.0 entry and took the cartridge files into `cartridge/c/1.1.0/` (`docs/requests/LEAP_C_CARTRIDGE.md` is the Leap-C project's description) |
