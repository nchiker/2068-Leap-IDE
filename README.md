# Leap V2 Web IDE

A browser-based IDE for writing and running programs in **Leap V2 BASIC** on
the **Timex Sinclair 2068**. It has a CodeMirror 6 editor, a TS2068 emulator
(the TSRun emulator running the real Leap V2 ROMs) and a debugger. No
build step and no npm; it only needs a static file server.

Live: https://nchiker.github.io/2068-Leap-IDE/ (GitHub Pages, built from
`main` on every push). Source: https://github.com/nchiker/2068-Leap-IDE.

Leap V2 is documented at https://github.com/nchiker/2068-Leap (the manual and
`docs/V2_LANGUAGE_REFERENCE.md`). Current release: 2.0.2-emu.1.

Status: Phases 1 to 5 are done (the emulator boots, Run injects the editor text
into the ROM and runs it, compile and run-time errors come back with the line;
PC keys are translated for `INPUT`, `INKEY$` and `PAUSE 0`; the editor has
Leap V2 highlighting, autocomplete, hover help and automatic upper-casing of
keywords; the editor underlines compile errors as you type, using the ROM's own
compiler on a hidden machine so they match what Run reports; the debugger sets
breakpoints in the editor gutter, pauses and steps by statement (F8 / F10), and
shows registers, variables, the call stack and memory). Also done: the program
is auto-saved in the browser, with New / Open / Save and Leap `.tap` import;
package statements such as `CIRCLE` work because the IDE loads the package on
Run; "? Help" (F1) opens a searchable keyword reference. Phase 6 is half done:
"⬇ TAP" saves exactly what Leap's own `SAVE` writes (verified: Leap's real
`LOAD` reads it back); the DCK cartridge needs a runtime-only Leap build first,
specified in `docs/LEAP_CARTRIDGE_BUILD.md`. Still to do: the Phase 7 tools,
Phase 8 themes, and the Leap 2.1 ROM entry. See `CLAUDE.md` for the phase list
and technical brief, and `docs/overview.md` for the design.

## Setup

1. Clone with the TSRun submodule:

   ```
   git clone --recurse-submodules https://github.com/nchiker/2068-Leap-IDE.git
   ```

   (In an existing clone, run `git submodule update --init`.) `tsrun/` is a git
   submodule of the TSRun fork https://github.com/nchiker/TSRun, pinned at
   commit `4db1f1e` (TSRun `main` with the 2.0.2 Leap ROMs, the `sound.js`
   worklet fix `f65de5a`, which loads the worklet with
   `new URL("sound.worklet.js", import.meta.url)` so audio works from a page
   outside TSRun's directory, and the tape-loading fix `4db1f1e`, both
   pushed). No separate `~/TSRun` clone is needed.

2. The Leap ROMs are not part of this repo. They load from
   `tsrun/roms/leap-0.rom` (16K HOME) and `tsrun/roms/leap-1.rom` (8K EXROM),
   which must be the 2.0.2-emu.1 release images. The IDE hashes the pair and
   refuses ROMs it does not know.

The pin matters: the TSRun version must match the ROM table in
`src/leap-roms.js`, so changes upstream in TSRun (such as new Leap ROMs) cannot
break the IDE until the submodule is deliberately moved (see "Adding a new Leap
ROM release"). GitHub Pages includes the public submodule when it publishes.

## Run

Online: https://nchiker.github.io/2068-Leap-IDE/ (`index.html` forwards to
`ide.html`; `.nojekyll` makes Pages serve the files as-is).

For local development, from the project root:

```
python3 -m http.server 8080
```

Open http://localhost:8080/ide.html. CodeMirror 6 is loaded from jsDelivr
through an import map in `ide.html`, so the first load needs network access.

The "− 2× +" control in the TS2068 Display panel header sets the screen zoom
(1×, 2× or 3×, always a whole number of device pixels so text stays even; the
choice is remembered, and it drops by itself in a narrow window).

To run a program on a real TS2068 or in another emulator, use "⬇ TAP": it asks for
a tape name (up to 10 characters) and downloads a `.tap`; on the TS2068 type
`LOAD "name"` (or `LOAD ""`), then `RUN` (Leap V2 has no autorun). In the
TSRun fork, loading it relies on the tape-loading fix (TSRun issue #3, in the
submodule pin above), which keeps the tape playing for ROM-style loaders
outside EXROM chunk 0; Leap `LOAD ""` of the `.tap` loads and the tape starts
by itself.

Your program is auto-saved in the browser (`localStorage`) as you type, so a
reload loses nothing. **New**, **Open** (`.leap` `.txt` `.bas` `.tap`; Ctrl+O)
and **Save** (downloads a text file; Ctrl+S) are next to the file name; click
the name to rename it, and a `•` marks unsaved changes. Opening a Leap `.tap`
reads the program back into source (stock Sinclair BASIC tapes are refused).

Package statements (`CIRCLE`, `FILL`, `GRAB`, `MODE`, …) work directly: Run and
the error check install the program's package first, as `LOAD "NAME" EXT` does
(the images are in `packages/<version>/`). Leap loads one package at a time, so
a program may use only one. On a real TS2068, type `LOAD "NAME" EXT` before
`LOAD "name"`; the TAP export's status says which.

"? Help" or F1 opens the Help overlay: every keyword of the manual, searchable,
with a link to the manual, plus the keyboard shortcuts (F5 Run, F6 Stop, F8
Pause/Continue, F10 Step, Ctrl+S, Ctrl+O, Ctrl+Space). Escape closes it.

Click the TS2068 screen to give it keyboard focus. Keys reach the emulated
machine only while it is focused and a program is running (`INPUT`, `INKEY$`,
`PAUSE 0`); programs are always edited in the CodeMirror editor, never in
Leap's own editor, so a finished run's output stays on screen.

## Adding a new Leap ROM release

ROM addresses change between Leap releases, and the IDE injects programs by
jumping into ROM routines, so each ROM build has its own entry in
`src/leap-roms.js`.

1. In a 2068-Leap checkout at the release tag, run `make build`.
2. Run `tools/leap-rom-entry.py <checkout> <version>`; it prints a
   `KNOWN_ROMS` entry keyed by the SHA-256 of HOME + EXROM.
   The script's `SYMBOLS` table also covers the debugger's compiler and VM
   symbols, so a new entry must be generated, not copied from an older one.
3. Paste the entry into `src/leap-roms.js`. It includes the package fields
   `ext2ClearAll`, `packageBase`, `packageLen` and `packageDir`.
   Copy the release's package binaries (`v2_package_<name>.bin`) to
   `packages/<version>/<name>.bin`, unchanged, and check them against the
   release's `SHA256SUMS`.
4. Move the submodule to a TSRun commit that carries the release's
   `leap-0.rom` and `leap-1.rom` in `roms/`:
   `git -C tsrun fetch && git -C tsrun checkout <commit>`, then commit the
   submodule bump.
5. Reload and re-check hello world, a compile error, BREAK, `INPUT`, a
   breakpoint / step and a program with `CIRCLE`.

Nothing else in the IDE should need to change, except the editor's keyword data
and error text, which are generated from the release's manual. Regenerate them
at the release tag:

```
tools/gen-leap-keywords.py <2068-Leap checkout> <git ref> > src/leap-keywords.js
tools/gen-leap-errors.py <2068-Leap checkout> <git ref> > src/leap-errors.js
```

Never edit `src/leap-keywords.js` or `src/leap-errors.js` by hand. The editor's
error check (`src/leap-check.js`) needs no change: it runs the new ROM's own
compiler, using the `compileStored` symbol in the ROM entry.
