# Handoff — Leap V2 Web IDE

Last updated 2026-10-28, at packages on cartridges (DCK program image format 2), editor structure tools (folding, auto-indent, Tidy, go to definition, rename, line limit), the Examples menu and Z80 breakpoints.
Read `CLAUDE.md` first: it is the technical brief, and this file does not repeat it.
This file covers where the work stands, what the owner has decided, and how
to pick it up.

## Where it stands

All phases are done, and the IDE runs on Leap 2.1.0-emu.1. Nothing is on hold.
The DCK export, the last open item, was approved by the owner on 2026-10-28 and
is implemented.

| Done | |
|---|---|
| Phase 1 | Runs programs: RAM injection into the real Leap 2.1.0-emu.1 ROMs in TSRun (2.0.2 still known) |
| Phase 2 | CodeMirror 6 editor, Leap syntax, autocomplete, hover help, auto-caps |
| Phase 3 | Debugger: breakpoints, Step/Pause, variables, call stack, registers, memory |
| Phase 4 | PC keyboard mapping (`"` is `"`), keys reach the TS2068 only while a program runs |
| Phase 5 | Error checking by the ROM's own compiler on a hidden machine |
| Phase 6 | TAP export, byte-identical to Leap's `SAVE`; DCK export (`src/cartridge.js`, toolbar "⬇ DCK"): a cartridge that runs on a stock TS2068, also a flat 64 KB `.bin` for a cartridge board. A program's package goes on the cartridge too (image format 2) |
| Phase 7 | Symbols / UDG / Draw tabs (Draw zooms 1×–3×) |
| Phase 8 | Help overlay (F1), keys & tips, light/dark themes |
| 2.1 | Leap 2.1.0-emu.1 ROM entry, regenerated keyword and error data, packages, tests (61 ROM checks pass on 2.1; the 34 browser checks pass on 2.1) |
| Extras | New/Open/Save + browser auto-save, `.tap` import, packages (`CIRCLE`, …) loaded automatically, whole-pixel display zoom, module fingerprints, editor find / replace (Ctrl+F / Ctrl+H), Undo / Redo / Cut / Copy / Paste / Find buttons, editor folding, auto-indent / dedent, Tidy (Shift+Alt+F), block-keyword match, go to definition (F12, Ctrl+click), rename (F2), line-limit ruler at column 127, Examples menu (12 programs, `src/examples.js`), Z80 breakpoints and Step instruction in the debugger |

**Done for 2.1.0-emu.1** (tag `v2.1.0-emu.1`, commit `c005159`, published
2026-10-28): the ROM entry (key `5a42872e…`), `src/leap-keywords.js` and
`src/leap-errors.js` regenerated at the tag, packages copied (byte-identical to
2.0.2's), `SAVE_SYMBOLS` added, TSRun moved to `016787f`. The key tables did
not change (`src/pc-keyboard.js` untouched). The Stop workaround (a jump to the
command loop) is still needed: BREAK alone does not end an `INPUT` wait in 2.1
either (checked in Node; its VM latches error 66 and stops after ENTER).

**DCK export (done 2026-10-28).** `src/cartridge.js` builds the DCK from the
program's bytecode, which the checker machine compiles (`compile` in
`src/leap-check.js`), and from the cartridge images in
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

**Editor tools (done 2026-10-28).** `src/leap-lang.js` gained `lineTokens`,
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
of 12 programs from `src/examples.js` as a new unsaved document;
`tests/rom-checks.mjs` section 3b runs each on the real ROMs. The debugger
panel has a "Z80 Breakpoints" section and a "Step instruction" button (see
"Debugger" in `CLAUDE.md`).

**On hold:** nothing.

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

## How to resume

```sh
cd ~/Projects/Leap-IDE
git pull && git submodule update --init
python3 -m http.server 8080          # then http://localhost:8080/ide.html
node tests/rom-checks.mjs             # 61 checks, ~1 s, real ROMs in Node
node tests/browser-smoke.mjs          # 34 checks, ~30 s, headless Chrome
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
  `describeError` in `ide.js` drops a trailing " n" before adding the code.
- **`src/leap-lang.js` imports CodeMirror**, so Node cannot import it, nor
  anything that imports it. Pure helpers that Node tests need must stay in
  modules without CodeMirror imports (`files.js`, `export.js`,
  `cartridge.js`, `tools/draw.js`, `tools/udg.js`, `leap-debug.js`,
  `leap-check.js`).
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
| TSRun fork | submodule `tsrun/`, `nchiker/TSRun` | pinned at `016787f` (2.1.0-emu.1 ROMs, on top of sound worklet fix `f65de5a` + tape fix `4db1f1e`) |
| Leap | `~/2068-Leap`, `nchiker/2068-Leap` | release tag `v2.1.0-emu.1` (commit `c005159`); the clone may be on any branch, possibly with local edits: build releases in a worktree |
| Cartridge build | `cartridge-build/` in this repo | Source of `cartridge/<version>/`: `leap.patch` (two commits) on the `v2.1.0-emu.1` tag, applied by `setup.sh` into `leap/` (ignored). Status: `Docs/CARTRIDGE_STATUS.md`; CLI: `tools/leap2cart.mjs`. `~/Projects/Leap-Cartridge` was the original working copy |
