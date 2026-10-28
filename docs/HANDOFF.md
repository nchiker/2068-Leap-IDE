# Handoff — Leap V2 Web IDE

Last updated 2026-10-27, at commit "Handoff: regression tests and session notes".
Read `CLAUDE.md` first: it is the technical brief, and this file does not repeat it.
This file covers where the work stands, what the owner has decided, and how
to pick it up.

## Where it stands

All phases are done except two items the owner has put **on hold until Leap 2.1
is ready**. Do not start them before the owner says 2.1 is ready.

| Done | |
|---|---|
| Phase 1 | Runs programs: RAM injection into the real Leap 2.0.2 ROMs in TSRun |
| Phase 2 | CodeMirror 6 editor, Leap syntax, autocomplete, hover help, auto-caps |
| Phase 3 | Debugger: breakpoints, Step/Pause, variables, call stack, registers, memory |
| Phase 4 | PC keyboard mapping (`"` is `"`), keys reach the TS2068 only while a program runs |
| Phase 5 | Error checking by the ROM's own compiler on a hidden machine |
| Phase 6 | TAP export, byte-identical to Leap's `SAVE` (DCK is on hold) |
| Phase 7 | Symbols / UDG / Draw tabs (Draw zooms 1×–3×) |
| Phase 8 | Help overlay (F1), keys & tips, light/dark themes |
| Extras | New/Open/Save + browser auto-save, `.tap` import, packages (`CIRCLE`, …) loaded automatically, whole-pixel display zoom, module fingerprints |

**On hold until 2.1 (in this order when the owner says go):**
1. **Leap 2.1 ROM entry**: follow "Adding a Leap ROM release" in `CLAUDE.md`,
   then run both test suites (below). Also regenerate `src/leap-keywords.js`
   and `src/leap-errors.js` at the 2.1 tag, copy the 2.1 packages, check
   `SYMBOLS` in `src/pc-keyboard.js` against 2.1's key tables, and add 2.1's
   `SAVE_SYMBOLS` to `tests/rom-checks.mjs`. Leap 2.1 is expected to let BREAK
   end an `INPUT` wait; the Stop workaround (a jump to the command loop) can
   then be re-checked.
2. **DCK export**: needs the Leap 2.1 *cartridge build* (runtime only, no
   editor, runs on a stock TS2068) specified in `docs/LEAP_CARTRIDGE_BUILD.md`.
   Implement the IDE side from that spec once the build exists; do not guess
   the layout.

## Owner decisions (keep them)

- Leap is V2 (2.0.2-emu.1 now; 2.1 in development). V1 is irrelevant.
- **Typing never reaches Leap's own ROM editor.** All editing is in CodeMirror;
  keys go to the TS2068 only while an injected program runs (`INPUT`, `INKEY$`).
- Keys are mapped as a PC keyboard is labelled, not as the TS2068 keyboard is.
- Keywords are upper-cased automatically (no option). Names and strings are
  left as typed.
- A DCK must run on a **stock** TS2068, hence the separate cartridge build.
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
node tests/rom-checks.mjs             # 42 checks, ~1 s, real ROMs in Node
node tests/browser-smoke.mjs          # 16 checks, ~30 s, headless Chrome
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
  differ from 2.0.2 (e.g. `V2_SAVE`). For a release, check out the tag and
  `make build` (`tools/leap-rom-entry.py` takes the checkout and version).
- **`src/leap-lang.js` imports CodeMirror**, so Node cannot import it, nor
  anything that imports it. Pure helpers that Node tests need must stay in
  modules without CodeMirror imports (`files.js`, `export.js`,
  `tools/draw.js`, `tools/udg.js`, `leap-debug.js`, `leap-check.js`).
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
| TSRun fork | submodule `tsrun/`, `nchiker/TSRun` | pinned at `4db1f1e` (sound worklet fix `f65de5a` + tape fix `4db1f1e`) |
| Leap | `~/2068-Leap`, `nchiker/2068-Leap` | release tag `v2.0.2-emu.1`; `main` is 2.1 development |
