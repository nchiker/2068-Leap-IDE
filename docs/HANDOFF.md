# Handoff — Leap IDE (formerly the Leap V2 Web IDE)

Last updated 2026-11-01, after Forth F3 (static check), Import session and F5 (tape), and Leap-C 1.0.0 with C5 (tape), C6 (libraries) and C7 (Examples) were added (`a3869d4` to `1050d7b`; see "Where it stands"). Before that, 2026-11-01, Leap-Forth (F0 to F2, `b9526ce`, plus Send) and Leap-C (C1 to C3, `d0e437b`) on top of stage 0 (language profiles, `3ed5d3b`). Before that, 2026-11-01 stage 0. Before that, 2026-11-01, the ROM projects' answers (Forth v2.0 released, Leap-C unblocked). Before that, 2026-10-31, the cartridge test (▶ Test DCK and Open `.dck`: the cartridge on the stock TS2068 ROMs in the IDE's emulator) and the multi-language plans (`docs/MULTI_LANGUAGE_PLAN.md`, `LEAP_C_PLAN.md`, `LEAP_FORTH_PLAN.md`; questions for the ROM projects in `docs/requests/`). Before that: share links (program in the URL fragment), packages on cartridges (DCK program image format 2), editor structure tools (folding, auto-indent, Tidy, go to definition, rename, line limit), the Examples menu and Z80 breakpoints.
Read `CLAUDE.md` first: it is the technical brief, and this file does not repeat it.
This file covers where the work stands, what the owner has decided, and how
to pick it up.

## Where it stands

All phases are done, and the IDE runs three languages: Leap V2 BASIC (Leap
2.1.0-emu.1), Leap-Forth (2068-Forth v2.0) and Leap-C (v1.0.0), chosen
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
| Leap-Forth (2026-11-01, `b9526ce`) | Stages F0 to F2 of `docs/LEAP_FORTH_PLAN.md`: TSRun pin moved to `11731e1`; the live OK prompt (keys always reach it); Run sends the editor's text line by line through `EDIT_BUF` / `EDITOR_LOOP_LIVE.enter` and stops at the first line with a nonzero `LAST_ERROR`, marking the failing token (`SRC_PTR`); Stop is BREAK; Forth editor, Help (184 words), Examples (15 manual programs + Blackjack). Send (Ctrl+Enter: the cursor's line or the selected lines to the live prompt) is done after the commit. Not yet: F4 debugger, F8 cartridge |
| Forth F3, Import, F5 (2026-11-01, `a3869d4`, `89a6d48`, `6103f66`) | F3: a static check (`src/lang/forth/forth-check.js`: undefined words, compile-only words at the prompt, unbalanced control structures, unclosed strings and `(` comments, `MISSING NAME`, `OUT OF RANGE`), advisory (Run does not refuse a flagged program); the live session's words are read from the dictionary at the prompt's key wait (`emulator.onKeyWait`, `attach().keyWait`) and the editor is checked again when LATEST changes (`sessionStamp`). Import session: the "Import" button above the screen opens the ROM's line store as a new unsaved `session.fs`. F5: ⬇ TAP writes what `SAVE-TEXT` writes (`src/lang/forth/tape.js`, byte-identical to the ROM's), Open reads a TEXT tape back |
| Leap-C 1.0.0 (2026-11-01, `ac0d00f`) | Leap-C 1.0.0 was released (tag `v1.0.0`, commit `83e6e21`); the TSRun pin moved from `11731e1` to `9f9bbc5` (only `roms/leapc-*.rom` and the READMEs changed); ROM entry from the release's emulator pack, keyword and error data regenerated at the tag (same content). The beta.2 entry stays in the table |
| Leap-C (2026-11-01, `d0e437b`, `94700cf`, `4f30b82`, `1050d7b`) | Stages C1 to C3 of `docs/LEAP_C_PLAN.md` (Run by the shell path, the ROM's `SH_COMPILE` as the checker with the error's token column, a C editor, Help from the manual) and C5 (⬇ TAP and Open, format word `$8C00`, byte-identical to the ROM's `SH_SAVE`), C6 (`LIB "shapes"`: `libs/c/1.0.0/shapes.bin` installed for every check and Run, or unloaded), C7 (Examples menu: the manual's 18 programs; 15 compared with the manual's exit status, screen and pixels in the tests). Not yet: C4 debugger and the exit status in the status bar, C9 cartridge |
| Extras | New/Open/Save + browser auto-save, `.tap` import, packages (`CIRCLE`, …) loaded automatically, whole-pixel display zoom, module fingerprints, editor find / replace (Ctrl+F / Ctrl+H), Undo / Redo / Cut / Copy / Paste / Find buttons, editor folding, auto-indent / dedent, Tidy (Shift+Alt+F), block-keyword match, go to definition (F12, Ctrl+click), rename (F2), line-limit ruler at column 127, Examples menu (12 programs, `src/lang/basic/examples.js`), Z80 breakpoints and Step instruction in the debugger, share links (Share button; program in the URL fragment, nothing uploaded) |

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
(`a3869d4`), Import session (`89a6d48`) and F5 (`6103f66`), and Leap-C C1 to C3
(`d0e437b`), the move to 1.0.0 (`ac0d00f`; the TSRun submodule is now at
`9f9bbc5`), C5 (`94700cf`), C6 (`4f30b82`) and C7 (`1050d7b`) are done; see
CLAUDE.md "Leap-Forth" and "Leap-C". Next, Forth first (the owner's order): F4
the debugger; F8 (cartridge: the start word chosen at export; the editor's text
built on a fresh hidden machine; owner, 2026-11-01); of F6, the examples'
`\ expect:` output and `\ keys:` lines and `demos/gallery.fs`; F7 tools are
optional. Then Leap-C: C4 debugger (with the exit status in the status bar),
driving the key-reading and tape examples in the tests, and C9 when Leap-C has
its `make cart` build (in progress, uncommitted in `~/2068-Leap-C` `src/cart/`;
the owner has still to approve their M12 plan).

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
regenerated, nothing else changed). Only its cartridge (C9) waits, for
Leap-C's own `make cart`, which is in progress. The order is **stage 0 (the language profile, now done) -> Forth -> Leap-C**
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
  fresh hidden machine, not the live session's dictionary.
- Pushing to `main` (2026-11-01): approved for the multi-language work.

## How to resume

```sh
cd ~/Projects/Leap-IDE
git pull && git submodule update --init
python3 -m http.server 8080          # then http://localhost:8080/ide.html
node tests/rom-checks.mjs             # 129 checks, ~5 s, real ROMs in Node
node tests/browser-smoke.mjs          # 60 checks, headless Chrome
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
  `leapc-scan.js`).
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
| 2068-Leap-C | `~/2068-Leap-C`, `nchiker/2068-Leap-C` | release `v1.0.0` (commit `83e6e21`, 2026-11-01); ROM entry from the release's emulator pack; keyword, error and example data and `libs/c/1.0.0/` from the tag. beta.2 entry kept. Its cartridge build (`make cart`) is in progress, uncommitted in `src/cart/` of the clone |
