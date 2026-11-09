# Leap Arcade: project charter and plan

Status: **started 2026-11-09.** Phase 0 done (`docs/ARCADE_HARDWARE_NOTES.md`); phase 1 done, gate G1 decided: **native Z80** (`arcade/spike/G1.md`); phase 2 (language v0, cartridge map, runtime spec, asset formats) is in progress: drafts in `docs/ARCADE_LANGUAGE.md`, `docs/ARCADE_CARTRIDGE_MAP.md`, `docs/ARCADE_ASSETS.md` and `docs/ARCADE_RUNTIME_SPEC.md`; **milestone M1 reached 2026-11-09**: `arcade/build/m1.dck` boots on the stock ROM, flips the display files on the frame interrupt and moves a masked 16x16 sprite (24 checks pass on TSRun: `node arcade/tests/m1.mjs`; runtime 464 bytes, main loop 9.4 % of a frame). **Milestone M2 reached 2026-11-09:** Arcade source compiles to a DCK that runs on TSRun: parser + checker (`src/lang/arcade/arcade-parse.js`, `arcade-check.js`, 209 checks), code generator, linker, reference interpreter (`arcade-codegen.js`, `arcade-link.js`, `arcade-interp.js`, 108 checks incl. 8,000 fuzzed expressions and 12 games compared tick by tick with the interpreter), and runtime v0 (`arcade/runtime/v0/`: multi-sprite frame loop, MUL/DIV/MOD/RND/STICK, 108 checks). Contract: `docs/ARCADE_RUNTIME_API.md`. Runtime 1,200 of 16,384 bytes; a tick with 4 sprites uses 52 % of a refresh (blitter optimisation is phase 5). Run everything: `node arcade/tools/build-runtime.mjs` then the tests listed in `docs/HANDOFF.md`. The Studio shell is planned in `docs/ARCADE_STUDIO.md`. **Milestone M3 reached 2026-11-09:** acceptance game A (Breakout) compiles and runs: text, tiles (cell map with dirty redraw), collision (`HIT`), sound (`PLAY`/`SILENCE`, AY tick in the interrupt), contract `docs/ARCADE_RUNTIME_API_V1.md`, runtime v1 in `arcade/runtime/v1/` (3,450 of 16,384 bytes; a tick with 4 sprites over a text screen uses 48-76 % of a refresh), `arcade/examples/breakout.arc` (1,562 bytes, 1,000 scripted ticks match the reference interpreter). 14 test suites, all pass (list in `docs/HANDOFF.md`). **Milestone M4a reached 2026-11-09:** arrays (`DIM a(n)`, out-of-range read 0 / write ignored), sprite pools (`SPRITE bullet(4) = "bullet"`, 16 instances over 8 assets, per-asset phase counts), `KEYDOWN`, runtime v2 (`arcade/runtime/v2/`, contract `docs/ARCADE_RUNTIME_API_V2.md`, 7,227 of 16,384 bytes; 16 moving 16x16 sprites cost at most 105,903 T = 1.8 refreshes), and a playable vertical shooter `arcade/examples/shooter.arc` (9.3 KB; worst tick 2.24 of 3 refreshes at 20 fps; 1,300 scripted ticks match the interpreter). Run everything: `node arcade/tests/run-all.mjs` (24 steps, about 3.5 minutes; `--full` adds the mutation runs). Not yet: scrolling, music (M4b). Breakout (`arcade/build/breakout.dck`) cross-emulator check: screens at ticks 5, 20 and 60 are byte-identical on TSRun and ZEsarUX 13.0 and match Fuse 1.9.1 (Fuse shows ticks 1-387 in order, none skipped); the AY register writes of the first sound effect are identical on TSRun and ZEsarUX (ZEsarUX via the runtime's AY shadow, since its remote protocol cannot read AY registers); the display alternates every tick on both. Scripts in `arcade/tools/xemu/`. Earlier simple-cartridge check (2026-11-09): `arcade/examples/bounce.arc` compiled by `node arcade/tools/arcadec.mjs`; the static cartridge screen is byte-identical on TSRun and ZEsarUX 13.0 and matches Fuse 1.9.1 once the picture appears; the moving game matches ZEsarUX at equal ticks (frame lengths differ, 58,688 vs 69,888 T). Supported so far: variables, arithmetic, control flow, PROC/DEF FN, SELECT, SHOW/HIDE, RND, STICK; not yet: PRINT, tiles, sound, arrays, strings, scenes beyond one, sprites over 16x16. Nothing is built.
Origin: `~/2068-Leap/docs/GAME_BUILDER_PLAN.md` (draft of 2026-11-06, untracked in that repo). This file
replaces it as the working plan; the draft stays as the record of the study. Items marked **(proposal)** are
Claude's suggestion for the owner to confirm or change; everything else is an owner decision.

## 1. What it is

**Leap Arcade** is a structured BASIC for building arcade games for the stock Timex Sinclair 2068, and **Leap
Arcade Studio**, the browser environment that holds everything needed to make one: code, sprites, tiles, maps,
sound and music, a live emulator, a debugger, and the export. The output is one file, a **DCK cartridge** that
runs on a stock TS2068. The cartridge holds only the runtime and the compiled game: no editor, no compiler, no
source.

## 2. Decisions

| | |
|---|---|
| Name **(proposal)** | **Leap Arcade** (language), **Leap Arcade Studio** (the environment). Profile id `arcade`, file extension `.arc` for source, `.leapgame` for a whole project |
| Home | **This repository (Leap-IDE).** No new repository. The runtime's Z80 source lives in `arcade/runtime/` beside the cartridge images, as `cartridge-build/` does for Leap V2 **(proposal)** |
| Shell | **A second page, `studio.html`, on the shared core (proposal).** `ide.html` stays the three-language IDE. The Studio needs a different layout (many asset editors, not one editor and a tools tab), so it is its own shell, but it imports the same modules: TSRun host, CodeMirror editor, debugger, Z80 breakpoints, files, share links, themes, DCK container code. A profile is added for `arcade` so the code editor, Help and checks reuse the profile machinery; `ide.html` may also list it |
| Target | **Stock TS2068 only.** No ULAplus (`ULAPLUS`, `PALETTE` are dropped) |
| Output | **DCK only.** No tape, no TZX, no flat `.bin` unless asked later |
| Game size | **Largest the DCK format and the hardware support** (owner, 2026-11-09: any size, as long as it is supported). The hard ceiling is **64 KB** (eight 8 KB DOCK chunks; nothing larger is supported). All of it can hold bytes; RAM is the real limit, so the linker plans memory per game. See `arcade/spike/CART_SIZES.md` |
| Numbers | 16-bit signed integers by default; an 8.8 fixed-point type; **floats as an optional library**, linked only when the game uses them |
| Language | **Structured BASIC**, Leap-style: no line numbers, `PROC`/`ENDP`, `IF`/`ENDIF`, `FOR`/`NEXT`, labels. New words for game building (section 4) |
| Runtime | **No packages, no loader, no fixed ROM image.** Everything a game uses (sprites, joystick, AY player, tile engine, float library) is built into the cartridge image, optimised for that game. V2's loadable-package model (package window, ABI, one package at a time) is not carried over |
| Boot | **Pattern L**: LROS header in chunk 0, spec byte `$BC`, own interrupt handler in chunks 0-1 (proven on TSRun, ZEsarUX and Fuse); fallback AROS/IM 2. Owner delegated this to "the most compatible" (2026-11-09). Memory map draft: `docs/ARCADE_CARTRIDGE_MAP.md` |
| Language process | Only what is needed, adjusted as games are built (owner, 2026-11-09): `docs/ARCADE_LANGUAGE.md` v0, driven by acceptance games A (Breakout), B (shooter), C (maze/platformer) |
| Compiler | JavaScript, in the IDE. The only compiler. Source text exists only in the IDE |
| Compatibility | None with Leap V2 programs, tapes or ROM addresses. Leap V2 stays as it is |
| Games | Arcade style. The language supplies the game logic; the runtime owns the frame loop, video, sound and input |

## 3. Architecture (proposal)

```
Studio (studio.html)                     Cartridge (stock TS2068)
  project: source + assets                 HOME   runtime (frame loop, video, AY, sprites, tiles, input)
     |                                     EXROM  runtime overflow / optional float library
     v                                     DOCK   32 KB: compiled game (code + tables + assets)
  compiler (src/lang/arcade/*.js)  ---->   one .dck
     |
     v
  live preview: TSRun runs the same runtime ROM + image
```

* **The runtime owns the loop.** The game defines `PROC` entry points; the runtime calls them. Per frame:
  wait for the frame interrupt, flip display files if asked, run the music tick, move and draw sprites, then
  call the game's `FRAME` procedure. Games therefore never stall the music or tear the screen.
* **Preview and export are the same image.** The Studio's Run loads the runtime ROM and the compiled image into
  TSRun the way the cartridge test does; Export writes the DCK. There is no separate "run mode" to disagree with
  the cartridge.
* **Back end: native Z80, decided at gate G1 (2026-11-09, `arcade/spike/G1.md`).** Native hand code beat Leap V2's
  bytecode by 245x and Leap-C by 93x on the sprite job; statements compile to inline code or runtime calls, run in
  place from the cartridge. Cartridge layout B (runtime and code in DOCK chunks 0,1,4,5; chunk 6 asset window;
  chunk 7 RAM) and the budget reading (32 KB game, runtime in the other 8 KB of about 40 KB) are in G1.md.
  Leap-C 1.2.0 (`~/2068-Leap-C`) is the reference for code templates, calling convention and runtime helpers.
  Fallback if native is not clearly better: bytecode on a trimmed Leap V2 VM.
* **The runtime is a library, linked per game.** Subsystems (sprite blitters, tile engine, scroller, AY player,
  joystick/keyboard, 8.8 maths, strings, floats, display-mode switching) are separate Z80 modules. The compiler
  links in only the modules a program references, and may **specialise** them from the game's declarations: a
  sprite blitter for exactly the sizes and mode used, table-driven or compiled sprites where the 32 KB budget
  allows, no code for unused modes. Cartridge size and speed are therefore decided by the game, not by a fixed
  ROM. The frame loop and interrupt handler are generated from the same pieces. Nothing is loaded at run time.
  *How modules are relocated (for example assembling each module twice at different bases and diffing to get
  a relocation list, or fixed per-module slots) is a phase 2 decision; phase 1 must show the size and speed
  benefit of specialisation with hand-made examples.*
* **Runtime source** is Z80 assembly assembled with `sjasmplus` (installed locally). The assembled modules (with their
  symbol and relocation data) are committed, so the IDE itself still needs no build step; the IDE links, it
  does not assemble. A small generator turns one
  machine-readable spec (every runtime routine or opcode, with operands) into the runtime's include file and the
  compiler's table, so the two cannot disagree.
* **Project format (phase 2):** a single JSON document (`.leapgame`): settings, source files, and assets
  (sprites, tiles, maps, music) as small text/array forms. Auto-saved in the browser, downloaded on Save, shareable
  by link when small. Assets are edited in the Studio and stay in the project; the source refers to them by name.

### Display and memory are planned per game
Beyond the scene rule in section 4, the build also chooses the memory layout: how many DOCK chunks are ROM, what
stays RAM, whether a 12 KB shadow for composed 8x1-colour drawing is needed (shipped TS2068 action games compose
in scratch RAM and publish in a timed pass instead of flipping), and which assets stream in from chunks 2-3 and 6.
The Studio shows the plan and the byte budget; the programmer never writes a bank number.

### Lessons from shipped TS2068 games (Sinistar, The Crown, Berzerk; see `arcade/spike/CART_SIZES.md`, hardware notes section 9)
* **Frame rate is a design input.** Large-sprite colour games run at 5-15 fps (Sinistar: 12.9 fps best case). The
  runtime calls `FRAME` every *n* refreshes; the game states a target (`FRAMERATE 20` or similar, provisional), the
  Studio shows the measured budget per frame ("71 % of 3 refreshes") and flags overruns. Saving 1.3 ms across a
  refresh deadline moved one game from 19 to 28 fps: deadlines matter more than average speed.
* **Do not draw what cannot be seen.** The compiler/runtime clips and culls before any expensive preparation
  (one test cut a hidden-object cost from 151,919 T to 27 T). Offscreen sprites cost nothing by construction.
* **Compose, then publish.** For 8x1-colour games: compose in shadow planes in RAM, publish only changed bytes in a
  raster-aware pass; there is no hardware page flip in that mode. For 8x8-colour games: flip.
* **Banking discipline** (their hard-won rules, matching ours): map a chunk for one call and restore; the ISR never
  touches a mapped data chunk; set the shadow of `$F4` before the `OUT`; never map over the stack.
* **Art pipeline for the Studio:** image import with ordered/error-diffusion dither (Sierra-style) to 8x1 colour,
  with the two-colours-per-cell rule enforced and shown.

## Roadmap and aspirations (owner, 2026-11-09)
Order of games, each driving the language and runtime forward: **A Breakout** (done), **B shooter** (done, scrolling and
music still open), **Blockfall** (falling-blocks puzzle; tests the tile engine, arrays and input; in progress), then
**C platformer**, then the **ultimate goals**:
* a **Commander Keen-style** smooth-scrolling platformer with big animated sprites (needs sprite frames, sprites over
  16x16, a scrolling tile world; measured design in `arcade/spike/scroll/RESULTS.md`);
* a **Doom-style** first-person game: realistically a **Wolfenstein-style raycaster** in a small window at a low frame
  rate, with the game logic in Arcade BASIC and the raycaster as a hand-written runtime module linked in only for games
  that use it (feasibility numbers in `arcade/spike/raycast/RESULTS.md`). Doom's own engine (BSP sectors, textured
  floors and ceilings) is out of reach of a 3.5 MHz Z80.
These are directions, not commitments: each gets a measured spike before it is promised.

## 4. Language sketch (provisional, for the owner to react to)

Keep from Leap V2: assignment without `LET`, `IF`/`ELSE`/`ENDIF`, `FOR`/`NEXT`/`STEP`/`EXIT FOR`,
`PROC`/`ENDP`/`CALL`, `DEF FN`, `DIM`, `REM`, `PEEK`/`POKE`/`IN`/`OUT`/`USR`, `RND`, `ABS`, `SGN`, `INT`, `MOD`,
`DIV`, `AND`/`OR`/`NOT`, `PRINT` with `AT`/`TAB`, `INK`/`PAPER`/`BRIGHT`/`FLASH`, `BORDER`, `CLS`, `PLOT`, `LINE`,
`POINT`, `ATTR`, `BEEP`, `STICK`, `INKEY$`, `CHR$`, `STR$`, `LEN`, `MID$`, string `+`.
Drop (no editor, tape, printer or ULAplus on the cartridge): `LIST` `LLIST` `LPRINT` `NEW` `RUN` `LOAD` `SAVE`
`VERIFY` `CLEAR` `FREE` `INPUT` `STOP` `PALETTE` `ULAPLUS`. Floats (`SIN` `COS` `TAN` `SQR` `PI` `VAL`) move to the
float library; `SIN`/`COS` on integers become table lookups.

Added for games **(names provisional)**:

* **Structure:** `SELECT`/`CASE`/`ENDSEL` and `WHILE`/`WEND` or `REPEAT`/`UNTIL`, for state machines and loops that
  arcade code uses constantly. `GOTO` is **dropped** unless the spike shows a need **(proposal)**.
* **Declarations (assets by name):** `SPRITE name = "file"`, `TILESET name = "file"`, `MAP name = "file"`,
  `MUSIC name = "file"`, `SFX name = "file"`.
* **Entry points:** `PROC INIT()` runs once; `PROC FRAME()` runs every frame; optional `ON COLLIDE a, b CALL p`
  and `ON TIMER n CALL p`.
* **Video: no `MODE` word (owner, 2026-11-09).** The game does not name hardware modes; the build chooses the best
  display setup the game's needs allow, per **scene**. A game is divided into scenes (`SCENE title`, `SCENE play`,
  ... with `GOTO SCENE`/`CALL SCENE`; the Studio lists them). The compiler reads what each scene uses and picks:
  * *Smooth animation* (any moving sprites, scrolling, or a per-frame redraw) -> **two display files, flipped
    at the frame interrupt** (colour in 8x8 cells).
  * *Fine colour with little motion* (a static or slowly changing picture whose art needs a colour per pixel
    row) -> **8x1 extended colour**, one buffer.
  * *Text-heavy or line-art scenes* (64-column text, menus, plots) -> **512x192 hi-res**, one ink/paper pair.
  The runtime switches at scene change; the choice and its reason are shown in the Studio ("play: two buffers,
  because sprites move") and may be overridden there per scene, not in source. Hardware limits behind this are in
  `docs/ARCADE_HARDWARE_NOTES.md` section 1 (the three setups each use both display files, so they cannot be
  combined inside one scene). Words that remain: `SCREEN`/`FLIP`/`WAITFRAME` are not needed in source either:
  the runtime owns the frame loop.
* **Sprites:** `SHOW`, `HIDE`, `MOVE`, `SPRITEFRAME`, `SPRITEFLIP`, collision tests.
* **Tiles and scrolling:** `TILE x,y,t`, `MAP`, `SCROLL dx,dy`, `COLLIDE`.
* **Sound:** `SFX n`, `MUSIC n`, `MUSICSTOP`, driven from the frame interrupt.
* **Input:** `STICK(n)`, `KEYDOWN(k)`.
* **Types (proposal):** integer by default; `name!` is 8.8 fixed-point; `name$` string; the optional float library
  adds a float suffix only if the game links it. Static types are what let the native code be fast.

**Superseded by `docs/ARCADE_LANGUAGE.md` (version 0, 2026-11-09):** only what the acceptance games need, added as games are built; `GOTO`/labels dropped; fixed-point and floats later. This section stays as the original sketch.

## 5. Phases

Each phase ends with a gate the owner can inspect.

0. **Hardware notes.** Confirm SCLD port `$FF`, bank port `$F4`, AY `$F5`/`$F6`, hi-res, dual files and interrupt
   facts against the Timex documentation and two emulator sources (ZEsarUX, EightyOne; TSRun is the third).
   Write `docs/ARCADE_HARDWARE_NOTES.md`. List what Leap V2 already has for `MODE`, sprites, `STICK`, AY. *Gate:*
   notes reviewed.
1. **Backend spike (G1).** Three programs (a sprite loop, a scrolling tile map, a number-crunching loop) written
   by hand both ways, plus in Leap-C where it can express them; compare size and frames per second; test
   execute-in-place from a DOCK chunk and a frame-interrupt flip of the display files on TSRun and ZEsarUX.
   Also measure what **specialisation** buys: a generic sprite blitter against one specialised for a fixed size
   and mode, in bytes and T-states.
   *Gate G1:* native or bytecode decided, with numbers.
2. **Language and spec.** The language reference, the type system, the cartridge memory map, the project and
   asset formats, and the one machine-readable runtime spec with its generator.
3. **Runtime modules and linker.** Boot, bank setup, interrupt handler, frame loop, mode switching, display
   routines, AY driver, as separately linkable modules plus the JS linker that places them. Runs a hand-made
   image in TSRun. *Milestone M1:* a cartridge that shows one moving sprite.
4. **Compiler.** Slice first (variables, `PRINT`, `FOR`, `IF`, `PROC`, `PEEK`/`POKE`), then the full language,
   then the game keywords as the runtime gains them. Errors with line and column, several at once. Source map for
   the debugger. Differential test against Leap V2 for the shared subset.
5. **Video.** All modes, flipping, hi-res, extended colour, tiles, scrolling. Pixel-exact tests per primitive per
   mode (Leap V2's colour-row bug, nchiker/2068-Leap#5, is the cautionary example).
6. **Sound and input.** Interrupt-driven AY player and effects, beeper, joystick and keyboard.
7. **Studio.** Project panel, code editor, sprite/tile editor (TS2068 colour rules enforced), map editor,
   sound/music editor, live preview, debugger with source map, DCK export. Can start once the asset formats are
   fixed in phase 2; the sprite editor ships first. *Milestone M2:* a small complete arcade game built only in
   the Studio.
8. **Qualification.** Emulators (TSRun, ZEsarUX, EightyOne), example games as the acceptance suite (a Pong, a
   shooter, a platformer or maze game), hardware checklist, manual, release record.

## 6. Reuse

Leap-IDE: TSRun host and cartridge test (`src/emulator.js`), editor, debugger, files and share links, themes,
DCK container code (`src/lang/basic/cartridge.js`, `src/lang/c/cartridge.js`), test harnesses. Leap V2: graphics,
sprites, `STICK`, AY beep. Leap-C: the native back end reference (`spec.md`, `codegen.asm`, `expr.asm`,
`#pragma hires`, the cartridge path). Leap-Forth 2.0: the faster display routines. Benchmarks:
`~/2068-rom-benchmarks`.

## 7. Testing

Oracle for the shared subset: the same program on Leap V2 (2.1.2) and on Arcade must give identical screens.
Golden images per mode and primitive, AY register traces for sound, compiler unit tests against a reference
interpreter of the integer core, frame-timing tests (flip at sync, music tick regularity), and a hardware
checklist. **No Leap work has run on real hardware yet**; emulator timing, hi-res and dual-screen results are
informative until it does. New checks go in `tests/rom-checks.mjs` and `tests/browser-smoke.mjs` as sections
that skip cleanly when the runtime ROM is not built.

## 8. Risks

| Risk | Mitigation |
|---|---|
| Emulators differ from hardware (dual-screen, hi-res, AY) | Hardware checklist from phase 0; emulator results treated as informative |
| Native code too large, or banking awkward | Gate G1 with numbers; bytecode fallback |
| Studio UI is most of the effort | Fix asset formats in phase 2; sprite editor first; build on `studio.html` shell early |
| 32 KB fills fast with assets | Compact asset encodings; report the size budget live in the Studio |
| Scope creep from full BASIC | Keyword list fixed in phase 2; dropped words return only by request |
