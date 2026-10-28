# Handoff — Leap V2 Web IDE

Last updated 2026-10-27, at the Leap 2.1.0-emu.1 ROM entry (on top of commit
"Handoff: regression tests and session notes").
Read `CLAUDE.md` first: it is the technical brief, and this file does not repeat it.
This file covers where the work stands, what the owner has decided, and how
to pick it up.

## Where it stands

All phases are done, and the IDE runs on Leap 2.1.0-emu.1. One item is **on
hold**: the DCK export. Do not start it before the owner says so.

| Done | |
|---|---|
| Phase 1 | Runs programs: RAM injection into the real Leap 2.1.0-emu.1 ROMs in TSRun (2.0.2 still known) |
| Phase 2 | CodeMirror 6 editor, Leap syntax, autocomplete, hover help, auto-caps |
| Phase 3 | Debugger: breakpoints, Step/Pause, variables, call stack, registers, memory |
| Phase 4 | PC keyboard mapping (`"` is `"`), keys reach the TS2068 only while a program runs |
| Phase 5 | Error checking by the ROM's own compiler on a hidden machine |
| Phase 6 | TAP export, byte-identical to Leap's `SAVE` (DCK is on hold) |
| Phase 7 | Symbols / UDG / Draw tabs (Draw zooms 1×–3×) |
| Phase 8 | Help overlay (F1), keys & tips, light/dark themes |
| 2.1 | Leap 2.1.0-emu.1 ROM entry, regenerated keyword and error data, packages, tests (42 ROM checks pass on 2.1 and on 2.0.2; the 16 browser checks pass on 2.1) |
| Extras | New/Open/Save + browser auto-save, `.tap` import, packages (`CIRCLE`, …) loaded automatically, whole-pixel display zoom, module fingerprints |

**Done for 2.1.0-emu.1** (tag `v2.1.0-emu.1`, commit `c005159`, published
2026-10-28): the ROM entry (key `5a42872e…`), `src/leap-keywords.js` and
`src/leap-errors.js` regenerated at the tag, packages copied (byte-identical to
2.0.2's), `SAVE_SYMBOLS` added, TSRun moved to `016787f`. The key tables did
not change (`src/pc-keyboard.js` untouched). The Stop workaround (a jump to the
command loop) is still needed: BREAK alone does not end an `INPUT` wait in 2.1
either (checked in Node; its VM latches error 66 and stops after ENTER).

**On hold:**
1. **DCK export**: needs the Leap *cartridge build* (runtime only, no editor,
   runs on a stock TS2068) specified in `docs/LEAP_CARTRIDGE_BUILD.md`. The
   2.1.0-emu.1 release does not contain it: its `roms/leap_v2_exrom.dck` is
   only the EXROM as a cartridge for EightyOne 1.41 (it still needs Leap's HOME
   ROM). Implement the IDE side from that spec once the build exists; do not
   guess the layout.

## Owner decisions (keep them)

- Leap is V2 (2.1.0-emu.1 now; 2.0.2-emu.1 is still in the ROM table). V1 is irrelevant.
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
- **TAP test stand-in.** `tests/rom-checks.mjs` replaces `STORAGE_SEND_BLOCK`;
  2.1's block sender reports "sent whole" with carry set, and 2.1's `SAVE` stops
  after a header that reports an abort, so the stand-in returns with carry set.
  A future release may need a similar adjustment.
- **Error text.** The 2.1 manual writes run-time messages as `RUNTIME ERROR n`;
  `describeError` in `ide.js` drops a trailing " n" before adding the code.
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
| TSRun fork | submodule `tsrun/`, `nchiker/TSRun` | pinned at `016787f` (2.1.0-emu.1 ROMs, on top of sound worklet fix `f65de5a` + tape fix `4db1f1e`) |
| Leap | `~/2068-Leap`, `nchiker/2068-Leap` | release tag `v2.1.0-emu.1` (commit `c005159`); the clone may be on any branch, possibly with local edits: build releases in a worktree |
