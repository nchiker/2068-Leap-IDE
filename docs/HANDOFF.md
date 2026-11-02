# Handoff — Leap IDE (formerly the Leap V2 Web IDE)

Last updated 2026-11-01, after the speed test (all three languages, `1c74c46`), Forth F6 (`50fb417`), the keyed Leap-C Examples in the tests (`5cfffb8`) and the browser test's key-timing fix (`66a16e9`). Before that, 2026-11-01, Leap-C C9 (cartridge, `4798b64`) was added. Before that, 2026-11-01, Forth F4 (debugger, `054198d`), Leap-C C4 (debugger, exit status, `0b419d3`) and Forth F8 (cartridge, `f7a5d1d`). Before that, 2026-11-01, Forth F3 (static check), Import session and F5 (tape), and Leap-C 1.0.0 with C5 (tape), C6 (libraries) and C7 (Examples) (`a3869d4` to `1050d7b`). Before that, 2026-11-01, Leap-Forth (F0 to F2, `b9526ce`, plus Send) and Leap-C (C1 to C3, `d0e437b`) on top of stage 0 (language profiles, `3ed5d3b`). Before that, 2026-11-01 stage 0. Before that, 2026-11-01, the ROM projects' answers (Forth v2.0 released, Leap-C unblocked). Before that, 2026-10-31, the cartridge test (▶ Test DCK and Open `.dck`: the cartridge on the stock TS2068 ROMs in the IDE's emulator) and the multi-language plans (`docs/MULTI_LANGUAGE_PLAN.md`, `LEAP_C_PLAN.md`, `LEAP_FORTH_PLAN.md`; questions for the ROM projects in `docs/requests/`). Before that: share links (program in the URL fragment), packages on cartridges (DCK program image format 2), editor structure tools (folding, auto-indent, Tidy, go to definition, rename, line limit), the Examples menu and Z80 breakpoints.
Read `CLAUDE.md` first: it is the technical brief, and this file does not repeat it.
This file covers where the work stands, what the owner has decided, and how
to pick it up.

## Where it stands

All phases are done, and the IDE runs three languages: Leap V2 BASIC (Leap
2.1.0-emu.1), Leap-Forth (2068-Forth v2.0) and Leap-C (v1.0.0 ROMs; cartridge from 1.1.0), chosen
in the toolbar's language selector. Nothing is on hold.
The DCK export, the last open item, was approved by the owner on 2026-10-28 and
is implemented.

| Done | |
|---|---|
| Phase 1 | Runs programs: RAM injection into the real Leap 2.1.0-emu.1 ROMs in TSRun (2.0.2 still known) |
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
| Extras | New/Open/Save + browser auto-save, `.tap` import, packages (`CIRCLE`, …) loaded automatically, whole-pixel display zoom, module fingerprints, editor find / replace (Ctrl+F / Ctrl+H), Undo / Redo / Cut / Copy / Paste / Find buttons, editor folding, auto-indent / dedent, Tidy (Shift+Alt+F), block-keyword match, go to definition (F12, Ctrl+click), rename (F2), line-limit ruler at column 127, Examples menu (12 programs and the speed test, `src/lang/basic/examples.js`), Z80 breakpoints and Step instruction in the debugger, share links (Share button; program in the URL fragment, nothing uploaded) |

**Done for 2.1.0-emu.1** (tag `v2.1.0-emu.1`, commit `c005159`, published
2026-10-28): the ROM entry (key `5a42872e…`), `src/lang/basic/leap-keywords.js` and
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
TSRun submodule is now at `9f9bbc5`), C5 (`94700cf`), C6 (`4f30b82`), C7
(`1050d7b`), C4 (`0b419d3`) and C9 (`4798b64`) are done; see CLAUDE.md
"Leap-Forth", "Leap-C" and "Debugger". F6 (`50fb417`) is done too, so Forth lacks only the optional F7 tools, the
optional LIB tape and the optional watches. Nothing is open with the Leap-C
project, and Leap-C lacks only optional things: locals in the debugger,
driving the tape example in the tests (the key-reading ones are driven since
`5cfffb8`), running the C examples from cartridges against the manual, and the
C8 tools. Its cartridge (C9) is built on Leap-C 1.1.0's cartridge build
(released 2026-11-02 UTC, tag `v1.1.0`, commit `f8db836`; the Leap-C project's
description is `docs/requests/LEAP_C_CARTRIDGE.md`, read only: other people's
file); the IDE still compiles with the 1.0.0 ROM entry because the ROMs are
byte-identical (identity `$E90E`).

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

## Owner decisions (keep them)

- Leap is V2 (2.1.0-emu.1 now; 2.0.2-emu.1 is still in the ROM table). V1 is irrelevant.
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
- Pushing to `main` (2026-11-01): approved for the multi-language work.

## How to resume

```sh
cd ~/Projects/Leap-IDE
git pull && git submodule update --init
python3 -m http.server 8080          # then http://localhost:8080/ide.html
node tests/rom-checks.mjs             # 157 checks, ~30 s, real ROMs in Node
node tests/browser-smoke.mjs          # 64 checks, headless Chrome
```

Both suites must print `All checks passed`. The browser test serves the repo
itself and finds Chrome: `$CHROME`, then Playwright's headless shell in
`~/.cache/ms-playwright`, then `google-chrome`/`chromium`. It needs Node 22+;
this machine has Node 24.

## Traps (each one cost time)

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
  `git -C ~/2068-Leap worktree add --detach <dir> v2.1.0-emu.1`, then
  `make build` in `<dir>` (`tools/leap-rom-entry.py` takes that directory and
  the version). The 2.1.0-emu.1 build was byte-identical to the release zip.
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
- **Leap-C ROM entries.** 1.0.0 (the current one) was made from the release's
  emulator pack (`leapc-1.0.0-emulators.zip`: `roms/`, `symbols/`,
  `SHA256SUMS`): `tools/leapc-rom-entry.py` wants one directory, so copy the
  images, the `.sym` files and their `SHA256SUMS` lines into one directory
  first. The beta.2 entry stays (`LEAPC_ROMS=<dir>` tests it; the library and
  tape checks print SKIP there). beta.2's tag had no `.sym` and no
  `SH_WAIT_KEY.key_ret` label, so it was built in a detached worktree and the
  script derived `key_ret` as `SH_WAIT_KEY.read + 3`. The keyword data comes
  from the manual at the tag (`tools/gen-leapc-keywords.py ~/2068-Leap-C
  v1.0.0`; the script sets `LEAPC_MANUAL_REF` to the tag name, it had been
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
  refused if its SHA-256 is not in the table; the pin before `11731e1` carried
  an older Forth build (`760a5ce3…` / `2add175c…`). A TSRun move that changes
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
  table's counter of that ROM. A new release may move them.
- **`2 STICK .` reads 1 in TSRun, 0 in the manual (Forth).** Forth's
  `STICK_READ` reads AY port A without making it an input, and Forth leaves the
  mixer (register 7) at `$F8` (port A an output). TSRun returns the output
  latch, as an AY-3-8912 does; ZEsarUX returns the joystick lines. It is the
  one known difference of the 313 manual blocks (a `KNOWN` list in
  `tests/rom-checks.mjs` with its own check). On a real TS2068 `2 STICK`
  probably reads 1 too. Worth reporting to the 2068-Forth project; not
  reported yet.
- **Forth's screen checks need per-release symbols.** `FORTH_SCREEN_SYMBOLS` in
  `tests/rom-checks.mjs` (`PRINT_ROW` `$81CF`, `GFX_PUTCHAR` `$0705` for 2.0)
  comes from `~/2068-forth/build/forth_boot.sym`, whose HOME ROM is
  byte-identical to v2.0's (SHA-256 `730c86d0…`). A new Forth release needs its
  entry, or the F6 checks cannot read the screen. `tests/forth-manual-examples.json`
  is generated (`tools/gen-forth-doc-tests.py`), never hand-edited.
- **Leap-C's "Colour lines in high resolution" is the IDE's own version for now.**
  The manual's ends on a black screen (a user report; that is what the manual
  says it does). `tools/gen-leapc-examples.py` replaces manual section 11 with
  `tools/leapc-example-overrides/11-colour-lines-in-high-resolution.md` (waits
  for a key in mode 1, band visible after `mode(0)`), proposed to the Leap-C
  project in `docs/requests/LEAP_C_EXAMPLE_11.md`. When a Leap-C release's
  manual has it, delete the override and regenerate `src/lang/c/examples.js`;
  an override for a section the manual no longer has stops the generator.
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
  1.0.0 ROMs, which are byte-identical); export refuses when the loaded ROMs'
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
| TSRun fork | submodule `tsrun/`, `nchiker/TSRun` | pinned at `9f9bbc5` (Leap-C 1.0.0 ROMs; below it `11731e1`, the Forth v2.0 ROMs, and `016787f`, the 2.1.0-emu.1 Leap ROMs, on top of sound worklet fix `f65de5a` + tape fix `4db1f1e`; the Leap V2 and Forth ROMs are unchanged since their pins) |
| Leap | `~/2068-Leap`, `nchiker/2068-Leap` | release tag `v2.1.0-emu.1` (commit `c005159`); the clone may be on any branch, possibly with local edits: build releases in a worktree |
| Cartridge build | `cartridge-build/` in this repo | Source of `cartridge/<version>/`: `leap.patch` (two commits) on the `v2.1.0-emu.1` tag, applied by `setup.sh` into `leap/` (ignored). Status: `Docs/CARTRIDGE_STATUS.md`; CLI: `tools/leap2cart.mjs`. `~/Projects/Leap-Cartridge` was the original working copy |
| 2068-Forth | `~/2068-forth`, `nchiker/2068-Leap-Forth` | release `v2.0` (commit `50170f2`); word data and examples generated from it; ROM entry built from the unpacked release zip |
| 2068-Leap-C | `~/2068-Leap-C`, `nchiker/2068-Leap-C` | release `v1.0.0` (commit `83e6e21`, 2026-11-01); ROM entry from the release's emulator pack; keyword, error and example data and `libs/c/1.0.0/` from the tag. beta.2 entry kept. Release `v1.1.0` (commit `f8db836`, 2026-11-02 UTC) added the runtime cartridge (`leapc-1.1.0-cartridge.zip`, `make cart`); its ROMs are byte-identical to 1.0.0's, so the IDE kept the 1.0.0 entry and took the cartridge files into `cartridge/c/1.1.0/` (`docs/requests/LEAP_C_CARTRIDGE.md` is the Leap-C project's description) |
