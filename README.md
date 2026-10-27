# Leap V2 Web IDE

A browser-based IDE for writing and running programs in **Leap V2 BASIC** on
the **Timex Sinclair 2068**. It has a CodeMirror 6 editor, a TS2068 emulator
(the TSRun emulator running the real Leap V2 ROMs) and, later, a debugger. No
build step and no npm; it only needs a static file server.

Live: https://nchiker.github.io/2068-Leap-IDE/ (GitHub Pages, built from
`main` on every push). Source: https://github.com/nchiker/2068-Leap-IDE.

Leap V2 is documented at https://github.com/nchiker/2068-Leap (the manual and
`docs/V2_LANGUAGE_REFERENCE.md`). Current release: 2.0.2-emu.1.

Status: Phases 1, 2 and 4 are done (the emulator boots, Run injects the editor text
into the ROM and runs it, compile and run-time errors come back with the line;
PC keys are translated for `INPUT`, `INKEY$` and `PAUSE 0`; the editor has
Leap V2 highlighting, autocomplete, hover help and automatic upper-casing of keywords). See
`CLAUDE.md` for the phase list and technical brief, and `docs/overview.md` for
the design.

## Setup

1. Clone with the TSRun submodule:

   ```
   git clone --recurse-submodules https://github.com/nchiker/2068-Leap-IDE.git
   ```

   (In an existing clone, run `git submodule update --init`.) `tsrun/` is a git
   submodule of the TSRun fork https://github.com/nchiker/TSRun, pinned at
   commit `f65de5a` (TSRun `main` with the 2.0.2 Leap ROMs and the `sound.js`
   worklet fix, which loads the worklet with
   `new URL("sound.worklet.js", import.meta.url)` so audio works from a page
   outside TSRun's directory). No separate `~/TSRun` clone is needed.

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
3. Paste the entry into `src/leap-roms.js`.
4. Move the submodule to a TSRun commit that carries the release's
   `leap-0.rom` and `leap-1.rom` in `roms/`:
   `git -C tsrun fetch && git -C tsrun checkout <commit>`, then commit the
   submodule bump.
5. Reload and re-check hello world, a compile error, BREAK and `INPUT`.

Nothing else in the IDE should need to change, except the editor's keyword data,
which is generated from the release's manual. Regenerate it at the release tag:

```
tools/gen-leap-keywords.py <2068-Leap checkout> <git ref> > src/leap-keywords.js
```

Never edit `src/leap-keywords.js` by hand.
