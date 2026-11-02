# Leap IDE — CLAUDE.md

This is the authoritative technical brief for the Leap IDE (formerly the Leap V2
Web IDE; the repository and the Pages URL keep the name `2068-Leap-IDE`).
Read this file completely before writing any code. Then read
**`docs/HANDOFF.md`** (where the work stands, the owner's decisions, known
traps) and `docs/overview.md` for the design rationale. The mock-up is at `docs/mockup.html` (a visual
target only: its sample code and keyword list predate the language reference
below and are partly wrong).

Authorities, in order: the Leap manual (`~/2068-Leap/docs/manual/`) and
`~/2068-Leap/docs/V2_LANGUAGE_REFERENCE.md` for the language; the ROM source and
`.sym` files for addresses; the TSRun source for emulator APIs. Anything in this
file marked "unverified" has not been checked against those — check it before
building on it.

---

## What We Are Building

A **browser-based IDE** for writing and running programs on the **Timex
Sinclair 2068** in the owner's ROM languages. Three language profiles exist:
**Leap V2 BASIC** (the first, and what most of this file describes),
**Leap-Forth** and **Leap-C**
([`docs/MULTI_LANGUAGE_PLAN.md`](docs/MULTI_LANGUAGE_PLAN.md); stage 0, the
language profile, is done). See "Languages (language profiles)" below. The IDE
runs entirely in the browser — no
build step, no npm; it only needs a static file server (ES modules cannot load
from `file://`). Plain HTML + JS + the TSRun emulator.

- **Editor panel** — CodeMirror 6, Leap V2 syntax highlighting, keyword
  autocomplete, built-in help (hover tooltips and the F1 overlay), ROM-compiler
  error checking, breakpoint gutter, New / Open / Save with browser auto-save.
  Programs may use the Leap packages (`CIRCLE`, `GRAB`, …); the IDE loads them.
- **Emulator panel** — TSRun's TS2068 running the Leap V2 ROMs, 256×192 canvas.
- **Debugger panel** — Z80 registers, Leap variables, breakpoints, call stack.
  It shares the right panel with the Symbols, UDG and Draw tabs (Phase 7).

Leap is **V2**; the current release is **2.1.0-emu.1** (tag `v2.1.0-emu.1`,
commit `c005159` of nchiker/2068-Leap, published 2026-10-28). The ROM table
also still knows 2.0.2-emu.1, which is useful with `LEAP_ROMS=<dir>`. V1 is
archived and irrelevant. ROM addresses change between releases; everything else
in the IDE should stay the same (see "Adding a Leap ROM release").

---

## Source Files in This Repo

```
Leap-IDE/
├── index.html        ← Forwards to ide.html (GitHub Pages entry)
├── .nojekyll         ← Makes GitHub Pages serve files as-is
├── ide.html          ← Shell (three-panel layout, CM6 import map)
├── ide.css           ← Shell layout and theme
├── ide.js            ← Orchestrator: boot emulator, run/stop through the active language profile, status, files, language switching
├── src/
│   ├── emulator.js   ← Slim TSRun host + safe-point search, run/stop through the profile's driver, setProfile (Phase 1, done)
│   ├── pc-keyboard.js ← PC key -> TS2068 matrix translation; SYMBOL SHIFT table from the profile (Phase 4, done)
│   ├── editor.js     ← Language-neutral CodeMirror 6 editor: gutter, find/replace, buttons, theme, language compartment (setLanguage) (Phase 2, done)
│   ├── files.js      ← Browser auto-save (per language), text normalising, .tap -> source, share-link encode / decode (no DOM; Node can import it)
│   ├── help.js       ← Help overlay from the profile: searchable keywords + Keys & tips (F1, "? Help")
│   ├── debugger.js   ← Debugger controller (breakpoints, step, Z80 breakpoints) + panel, over the profile's debug adapter (Phase 3, done)
│   ├── lang/         ← Language profiles (stage 0 of docs/MULTI_LANGUAGE_PLAN.md)
│   │   ├── profiles.js ← PROFILES, profileById / profileForFile / profileForTape; the profile shape is in its header (no DOM)
│   │   ├── editors.js  ← LANGUAGE_EDITORS: id -> the CodeMirror half of each profile
│   │   ├── keytables.js ← SYMBOL SHIFT tables: LEAP_V2_SYMBOLS (BASIC) and LEAP_EXTENDED_SYMBOLS (Leap-C and Forth: adds ~ | \ { } ] [ ^)
│   │   └── basic/      ← Leap V2 BASIC
│   │       ├── profile.js    ← The BASIC profile: driver (inject / stop / result), prepareSource, describeError, encodeLineStore, debug adapter, help, symbols, attach() (no DOM or CodeMirror; Node can import it)
│   │       ├── editor.js     ← CodeMirror half: completion, hover help, auto-caps, folding, indent, Tidy, block match, go to definition, rename
│   │       ├── leap-words.js ← Pure word tables: LEAP_WORDS, NOT_IN_V2, keywordEntry, scanSymbols, LEAP_PACKAGES, packagesUsed (no CodeMirror)
│   │       ├── leap-lang.js  ← Language mode, token classes, lineTokens / nameTokens / blockStructure / blockIndent (imports CodeMirror; re-exports leap-words.js) (Phase 2, done)
│   │       ├── leap-roms.js  ← Known ROM builds: SHA-256 -> addresses (Phase 1, done)
│   │       ├── leap-keywords.js ← GENERATED keyword data from the manual; never hand-edit
│   │       ├── leap-errors.js ← GENERATED compile/run-time error text from the manual; never hand-edit
│   │       ├── leap-check.js ← Editor error check: the ROM's own compiler on a hidden machine (Phase 5, done)
│   │       ├── leap-debug.js ← Line table, VM position, variables, call stack from machine RAM (Phase 3, done)
│   │       ├── examples.js   ← The Examples menu's 12 programs (no DOM; Node can import it)
│   │       ├── export.js     ← TAP builder (Phase 6, done, verified)
│   │       └── cartridge.js  ← DCK / flat .bin cartridge builder, program image format 2 with a package (Phase 6, done, verified; no DOM, Node can import it)
│   │   ├── c/          ← Leap-C (v1.0.0; see "Leap-C")
│   │   │   ├── profile.js       ← The C profile: driver (shell path), prepareSource, describeError, debug adapter, tape export / Open, libraries, attach() (no DOM or CodeMirror)
│   │   │   ├── editor.js        ← CodeMirror half: C-subset highlighting, completion, hover, folding, indent, Tidy, match, go to definition, rename
│   │   │   ├── leapc-scan.js    ← Pure scanner: functions, globals, macros, types, librariesUsed (no CodeMirror)
│   │   │   ├── leapc-check.js   ← Editor error check: SH_COMPILE on a hidden machine, with the error's token column; compileImage() reads the compiled program back for the cartridge
│   │   │   ├── leapc-debug.js   ← Debugger (C4): line table from the compiler, globals, IX frame-chain call stack (no DOM; Node can import it)
│   │   │   ├── cartridge.js     ← DCK / flat .bin builder for a stock TS2068 (C9): program image "LCPG" format 1, port of cartpack.py and c2cart.py's region_blocks (no DOM; Node can import it)
│   │   │   ├── leapc-roms.js    ← Known Leap-C ROM builds (1.0.0, 1.0.0-beta.2): SHA-256 -> addresses
│   │   │   ├── leapc-keywords.js ← GENERATED keyword / library data from the manual; never hand-edit
│   │   │   ├── leapc-errors.js  ← GENERATED compile / run-time error text from include/leapc_errors.inc; never hand-edit
│   │   │   └── examples.js      ← GENERATED Examples menu (the manual's 18 Part 7 programs, test directives as data); never hand-edit
│   │   └── forth/      ← Leap-Forth (2068-Forth v2.0; see "Leap-Forth")
│   │       ├── profile.js       ← The Forth profile: driver (line by line through EDIT_BUF), prepareSource, describeThrow, debug adapter, interpretFresh + buildCartridge, attach() (no DOM or CodeMirror)
│   │       ├── editor.js        ← CodeMirror half: highlighting by the interpreter's reading, completion with stack effects, hover, folding, indent, Tidy, block match, go to definition, rename
│   │       ├── forth-scan.js    ← Pure scanner: lineTokens(line, ctx), scanContext, scanDefinitions, blockStructure, isNumber (no CodeMirror)
│   │       ├── forth-check.js   ← Static error check (F3): checkForth, readSessionWords, numberInRange (no DOM or CodeMirror)
│   │       ├── forth-debug.js   ← Debugger (F4): line table built while sending, stacks and words, call stack from the return stack (no DOM; Node can import it)
│   │       ├── cartridge.js     ← DCK / flat .bin builder for a stock TS2068 (F8): program image "F1", port of forthcart.py (no DOM; Node can import it)
│   │       ├── tape.js          ← TEXT tapes (F5): buildForthTap, forthTapeToText, isForthTape (no DOM; Node can import it)
│   │       ├── forth-roms.js    ← Known Forth ROM builds: SHA-256 -> addresses
│   │       ├── forth-words.js   ← GENERATED word data (184 words) from the manual; never hand-edit
│   │       └── examples.js      ← GENERATED Examples menu (15 manual programs + Blackjack); never hand-edit
│   └── tools/        ← Right-panel tools (Phase 7, done)
│       ├── symbols.js ← Symbols tab: the profile's symbol groups; click jumps to the line
│       ├── udg.js     ← UDG tab: draw the 21 user-defined characters, insert / load POKEs (BASIC)
│       └── draw.js    ← Draw tab: graphics scratchpad generating PLOT / LINE (BASIC)
├── cartridge-build/  ← Source of the cartridge images: leap.patch + setup.sh, CLI tools, tests, status (see its README)
├── cartridge/
│   ├── 2.1.0-emu.1/  ← Leap's cartridge build: leap_v2_cart_home.bin (16 KB), leap_v2_cart_exrom.bin (8 KB), README
│   ├── forth/2.0/    ← 2068-Forth v2.0's cartridge build: forth_cart.dck (Forth with no program, the release's, unchanged; identity $FDBE), README
│   └── c/1.1.0/      ← Leap-C 1.1.0's cartridge build: leapc_cart_home.bin (16 KB), leapc_exrom.bin (8 KB, the release EXROM), cartridge.json (the identity it accepts, E90E), README
├── packages/
│   ├── 2.0.2-emu.1/  ← Package images of that release (<name>.bin; same six as 2.1.0-emu.1)
│   └── 2.1.0-emu.1/  ← The current release's package images: cbeep graphics mode printer shapes sprite (<name>.bin)
├── libs/
│   └── c/1.0.0/      ← Leap-C library images (<name>.bin; shapes.bin, the data block of the release's libs/shapes.tap) and README
├── tools/
│   ├── leap-rom-entry.py  ← Prints a src/lang/basic/leap-roms.js entry for a 2068-Leap build
│   ├── gen-leap-keywords.py ← Generates src/lang/basic/leap-keywords.js from the Leap manual
│   ├── gen-leap-errors.py   ← Generates src/lang/basic/leap-errors.js from manual Appendix B
│   ├── forth-rom-entry.py   ← Prints a src/lang/forth/forth-roms.js entry for an unpacked 2068-Forth release
│   ├── gen-forth-words.py   ← Generates src/lang/forth/forth-words.js from the Forth manual (Parts 3 and 4)
│   ├── gen-forth-examples.py ← Generates src/lang/forth/examples.js (manual Part 7 programs + demos/blackjack.fs)
│   ├── leapc-rom-entry.py   ← Prints a src/lang/c/leapc-roms.js entry for a 2068-Leap-C build directory (optional third argument: the cartridge dir)
│   ├── gen-leapc-keywords.py ← Generates src/lang/c/leapc-keywords.js from the Leap-C manual
│   ├── gen-leapc-errors.py  ← Generates src/lang/c/leapc-errors.js from include/leapc_errors.inc
│   └── gen-leapc-examples.py ← Generates src/lang/c/examples.js from the Leap-C manual's Part 7
├── tests/
│   ├── rom-checks.mjs    ← Node: run path, checker, packages, debugger, TAP vs Leap's SAVE, cartridge on a stock TS2068, Forth, Leap-C (real ROMs)
│   └── browser-smoke.mjs ← Headless Chrome: the whole IDE end to end
├── docs/
│   ├── HANDOFF.md    ← Session handoff: status, owner decisions, traps
│   ├── overview.md   ← Design doc
│   ├── LEAP_CARTRIDGE_BUILD.md ← Spec: Leap runtime cartridge build for 2.1 (what DCK export needed; now built)
│   └── mockup.html   ← Visual mock-up
└── tsrun/            ← git submodule: TSRun fork, pinned at 9f9bbc5
```

**ROMs are not in this repo.** They load from `tsrun/roms/leap-0.rom` (16K
HOME) and `tsrun/roms/leap-1.rom` (8K EXROM). These are the 2.1.0-emu.1 release
images (SHA-256 `8c3d6c81…` and `e46e2065…` respectively; the pair's key in
`src/lang/basic/leap-roms.js` is `5a42872e…`). A `make build` of the tag is byte-identical
to the release zip's ROMs. The 2.0.2-emu.1 pair (`1fe5798f…`, `e6b507a4…`) is
also in the table.

**TSRun** is the fork https://github.com/nchiker/TSRun (upstream
josef-jelinek/TSRun), included as the git submodule `tsrun/` pinned at commit
`9f9bbc5` (TSRun `main` with the Leap-C 1.0.0 ROMs as `roms/leapc-*.rom`; the
Leap V2 and Forth ROMs are unchanged). Before it the pin was `11731e1` (the
2068-Forth v2.0 ROMs as `roms/leapforth-*.rom`), and before that `016787f`
(the 2.1.0-emu.1 Leap ROMs, on top of the
`sound.js` worklet fix `f65de5a` and the tape-loading fix `4db1f1e`, both
pushed; `016787f` itself changed only the two ROMs and the READMEs). There is no
`../josef-jelinek/` path and no `~/TSRun` clone is needed. Do not copy TSRun
into the repo. The fork carries two changes on its `main`: `sound.js` loads its
worklet with `new URL("sound.worklet.js", import.meta.url)` instead of a
page-relative path, so audio works from a page outside TSRun's directory; and
the tape-loading fix (TSRun issue #3, josef-jelinek/TSRun, opened by the
owner), which keeps the tape playing for ROM-style loaders outside EXROM chunk
0 (tape loading used to stop mid-load, so Leap's `LOAD` failed in TSRun).
Verified: stock-ROM tape autoload and autostart are unchanged, and Leap
`LOAD ""` of the IDE's `.tap` loads (the tape even starts by itself) and `RUN`
works. The live TSRun site, which also hosts Leap's browser demo, loads Leap
tapes, including package tapes.

**Pinning matters:** the TSRun version must match each language's ROM table
(`src/lang/basic/leap-roms.js`, `src/lang/c/leapc-roms.js`,
`src/lang/forth/forth-roms.js`; the Forth pair in `tsrun/roms/` of an older
pin is a different build and is refused), so a TSRun update cannot break the
IDE until the submodule is deliberately moved: `git -C tsrun fetch && git -C tsrun checkout <commit>`,
add the ROM entry (`tools/leap-rom-entry.py`), regenerate keywords if the manual
changed, then commit the submodule bump.

**Publishing:** the repo is public at https://github.com/nchiker/2068-Leap-IDE
(branch `main`). GitHub Pages serves it at
https://nchiker.github.io/2068-Leap-IDE/, built from `main` (root) on every
push, and includes the public submodule.

**Setup:** `git clone --recurse-submodules https://github.com/nchiker/2068-Leap-IDE.git`
(or `git submodule update --init` in an existing clone). For local development
serve with `python3 -m http.server 8080` from the project root and open
http://localhost:8080/ide.html.

---

## Languages (language profiles)

Stage 0 of [`docs/MULTI_LANGUAGE_PLAN.md`](docs/MULTI_LANGUAGE_PLAN.md) (done
2026-11-01, commit `3ed5d3b`): the IDE core no longer assumes Leap V2 BASIC.
Everything language-specific is a **profile** in `src/lang/<id>/`; the core
(`ide.js`, `src/emulator.js`, `src/debugger.js`, `src/editor.js`,
`src/pc-keyboard.js`, `src/help.js`, `src/files.js`, `src/tools/symbols.js`)
asks the active profile. Three profiles exist: `basic` (Leap V2 BASIC), `c`
(Leap-C, commit `d0e437b`) and `forth` (Leap-Forth, commit `b9526ce`); see
"Leap-Forth" and "Leap-C" below. The behaviour with BASIC did not change. The
rest of this file describes BASIC's profile unless it says otherwise.

**Shape** (the authoritative description is the header of
`src/lang/profiles.js`; `src/lang/basic/profile.js` is a complete one):

- `id`, `name`, `extensions[]`, `untitled`: `'basic'`, `'Leap V2 BASIC'`,
  `['.leap', '.bas']`, `'untitled.leap'`.
- `romFiles {home, exrom}` (paths under `tsrun/`), `knownRoms` (SHA-256 of
  HOME + EXROM -> ROM entry), `romHint` (the refusal text), `romLabel(rom)`.
- `lineLimit` (127); `keyboard {symbols, always}`: the SYMBOL SHIFT table for
  `src/pc-keyboard.js`, and whether keys reach the machine all the time (a
  live prompt) or only while a program runs.
- `driver`, the emulator's half of Run / Stop: `safe(m)` (paging at the key
  wait), `runState(m, rom)` (`'ended'` / `'waiting'`), `inject(m, rom, job)`,
  `stopWaiting(m, rom)` (true = ended directly, false = press BREAK) and
  `result(m, rom, job)`. Optional fields, all added with Forth and Leap-C:
  `canInject(m, rom)` (may a run start at this key wait? else the emulator
  presses BREAK first, as for a busy program), `next(m, rom, job)` (at the end
  of a part, send the next one and return true; Forth sends a line at a time;
  the emulator keeps the running job in `emu.job` and passes it to `result`)
  and `breakHold` (frames to hold BREAK before letting go, instead of holding
  it until the key wait; for ROMs that latch BREAK in their interrupt and then
  wait for all keys to be released).
- `createDebugAdapter(rom)`: the debugger's view of a run (see "Debugger").
  Optional adapter members added with Forth and Leap-C: `reset(job)` (gets the
  run's job), `version()` (a number that changes when the line table grows;
  the controller then places the breakpoints again), `live` (the variables
  table is also shown between runs) and `labels {variables, step}` (the
  Variables section's title and what a Step goes by). A profile may return a
  no-op adapter (registers, memory and Z80 breakpoints only), as Leap-C does
  for a ROM entry without the C4 fields.
- `symbolGroups(text)` and `symbolsEmpty` (Symbols tab), `help` (the Help
  overlay's entries, groups, manual link, shortcuts and tips), `examples`,
  `tools {udg, draw}` (which code generators apply), `waitingText`,
  `readyText` (the status when the ROM has booted; default `Ready`),
  `hasTape` / `hasCartridge` / `hasSession`, `tapeToText(bytes)` /
  `ownsTape(bytes)` and `ownsCartridge(dck)` (true for a cartridge image of
  this language, so a cartridge test takes its keyboard table: Forth's checks
  for `"F1"` at DOCK `$4000`, Leap-C's for `"LCPG"` at DOCK `$8000`).
  `help` may also carry `link(name, entry)` (the entry's manual URL),
  `forms(name, entry)` (the lines under its name) and `kindText(entry)`.
  Buttons and tabs a language lacks are hidden (`hidden`, with
  `.btn[hidden]` and the like in `ide.css`): UDG and Draw for Forth and
  Leap-C (both have a tape: ⬇ TAP; Forth has ⬇ DCK and ▶ Test DCK since F8,
  Leap-C since C9); Import (`#btn-import-session`, in the
  emulator panel header) shows only for a profile with `hasSession` (Forth).
- `attach({rom, romImages, fetchAsset})`: **the per-ROM half**, bound once the
  ROM pair is loaded. For BASIC it builds the checker machine, fetches the
  package images and returns `lint(text)`, `startRun(text)` (the `job`, the
  store-line to editor-line map, the byte count and the start message, or an
  error / problems), `describeResult(result, editorLine, stopLine)`,
  `progInfo(bytes)`, `exportTape(text, name)` and `buildCartridge(text, ui)`
  (`ui` is `{confirm(q), prompt(q, default)}`; `prompt` is how Forth asks for
  the start word; optional; `hasTape` / `hasCartridge` hide the ⬇ TAP, ⬇ DCK and ▶ Test DCK
  buttons when absent). A language with a live session (Forth) also has
  `keyWait(m)` (the emulator calls it at every key wait of the language's own
  ROMs: `emulator.onKeyWait(fn)`, wired in `ide.js`), `sessionStamp()` (changes
  when the session's dictionary does; `ide.js` polls it with the debugger
  refresh and checks the editor again) and `importSession(m)` (the typed lines
  as text). A diagnostic or run mark is `{line0, message, cols?, severity?}`;
  `cols {from, to}` underlines that part of the line instead of all of it
  (Leap-C and Forth mark the failing token), `severity` is `'error'` (the
  default) or `'warning'`. `describeResult` gets the run's
  `job` as a fourth argument. `ide.js` keeps it in `lang` and calls it again
  after each language switch (`attachLanguage`).

**Pure half and editor half.** A profile is two modules so Node can test it:
`src/lang/basic/profile.js` has no DOM and no CodeMirror (so
`tests/rom-checks.mjs` imports it, and Run in Node now goes through its real
`driver.inject`), while `src/lang/basic/editor.js` (the CodeMirror extensions:
language mode, completion, hover, folding, indent, Tidy, go to definition,
rename; also `starter` text and `lineLimit`) is registered in
`src/lang/editors.js` (`LANGUAGE_EDITORS`, id -> editor profile). The word
tables are split the same way: `leap-words.js` (pure) and `leap-lang.js`
(imports CodeMirror).

**Wiring.**
- `src/emulator.js`: `run(job)` queues a run; at the safe point it calls
  `profile.driver`. `setProfile(profile)` loads that language's ROM pair into
  the existing machine (looked up in `profile.knownRoms`, an unknown pair is
  refused and the previous language stays), resets, and sets the keyboard
  table (`kbd.setSymbols`). Leaving a cartridge test restores the active
  profile's ROMs, not a fixed pair. `testCartridge(dck, symbols)` takes the
  keyboard table of the cartridge's own language (`ide.js` finds it with the
  profiles' `ownsCartridge`), else the active profile's; leaving puts the
  profile's back. `profile` getter.
- `src/editor.js`: the language is held in a `Compartment`; `setLanguage(id)`
  swaps it (the ruler follows `lineLimit`).
- `src/debugger.js`: `setAdapter(profile.createDebugAdapter(rom))`.
- `ide.js`: `switchLanguage(id)` autosaves the current document, calls
  `emulator.setProfile`, switches the editor, loads that language's document,
  rebuilds the debugger adapter, Help, the Examples menu and the tool tabs /
  export buttons (`showLanguageTools`), then re-attaches. The selector
  `#lang-select` in the toolbar lists the three languages (it is hidden only
  while there is a single profile). Each language keeps its own document.
  **Open** picks the language by file extension (`profileForFile`) or, for a
  `.tap`, by the tape (`profileForTape`) and switches (after the usual
  "discard changes?"); a `.dck` does not switch language.
- Per-language auto-save: `leap-ide.document.<id>`. `loadAutosave('basic')`
  moves the old bare `leap-ide.document` key to `leap-ide.document.basic` the
  first time. `leap-ide.lang` remembers the last language;
  `initialLanguageId(known)` picks `?lang=<id>`, else that, else the first
  profile. Switching swaps documents; text is not translated, and breakpoints
  and undo do not cross languages.
- Share links carry `&lang=<id>` (`encodeShare(text, name, lang)`); absent
  means `basic`, so older links still open. `decodeShare` returns
  `{text, name, lang}`.
- `window.leapIDE` exposes `lintSource`, `setStatus`, `switchLanguage`,
  `emulator`, `profile` and `lang`.

To add a language: a new `src/lang/<id>/` with `profile.js` and `editor.js`,
one line each in `src/lang/profiles.js` and `src/lang/editors.js`, its ROM
entries and generated data under it, and tests (`tests/rom-checks.mjs`
sections 8 and 9 are the models).

### Leap-Forth (`src/lang/forth/`, stages F0 to F5 and F8, plus Import session)

Commits: F0 to F2 `b9526ce` (Send after it), F3 `a3869d4`, Import session
`89a6d48`, F5 `6103f66`, F4 `054198d`, F8 `f7a5d1d`.

2068-Forth **v2.0** (tag `v2.0`, commit `50170f2`; ROMs HOME `730c86d0…`,
EXROM `fd877dd0…`, the pair's key in `forth-roms.js` is `04c3e54d…`), which
TSRun carries as `roms/leapforth-0.rom` / `leapforth-1.rom` (since the pin
`11731e1`; unchanged in the current `9f9bbc5`).
Plan: [`docs/LEAP_FORTH_PLAN.md`](docs/LEAP_FORTH_PLAN.md).

- **Console-first model (owner).** The OK prompt is live all the time:
  `keyboard.always` is true, so keys reach the machine whenever the screen has
  focus, as on the real TS2068. Run does not reset: it sends the editor's text
  to the running session as if typed, so definitions accumulate; Reset gives
  a fresh Forth.
- **Send (Ctrl+Enter / Cmd+Enter).** Sends the cursor's line, or the whole
  lines of the selection, to the live prompt, for any profile with
  `keyboard.always` (Forth). `src/editor.js` has `getSendText()` and
  `onSend(fn)` (a `Prec.highest` `Mod-Enter` keymap that falls through to
  CodeMirror when `ide.js` does not take it); `sendSelection()` in `ide.js`
  maps an error in the sent lines back to their editor lines. It is in the
  Forth Help tips.
- **Run, line by line.** `prepareSource` drops blank lines, turns tabs into two
  spaces and refuses lines over 128 characters or non-ASCII. `driver.inject`
  writes line 1 into `EDIT_BUF` / `EDIT_LEN` / `EDIT_CURSOR`, drops the key
  wait's return address (SP + 2) and sets PC = `EDITOR_LOOP_LIVE.enter`; the
  ROM runs the line, prints OK or the error and waits again.
  "At the prompt" is the key wait with `EDITOR_LOOP_LIVE.key_ret` at SP (any
  other return address is a word waiting in `KEY` / `ACCEPT` / `INPUT` /
  `EDIT`); `canInject` is that test, so a Run while a word waits in `KEY`
  presses BREAK first. `driver.next` sends the next line and stops at the first
  line whose `LAST_ERROR` is not 0 (a deviation from "send everything": Run
  stops at the first error line). The failing token is marked from `SRC_PTR`
  (just past the token and one delimiter, `tokenBefore`); a `SRC_PTR` outside
  `EDIT_BUF` means the error came from text `LOAD-TEXT` or `EDIT` ran, so no
  token is marked. Status: `OK`, `<message> on line L` (`describeThrow`: ANS
  numbering, -13 unknown word names the word from `WORD_BUF`), `Stopped
  (BREAK) on line L` (-28). Stop is BREAK (-28), held `breakHold` (5) frames;
  it ends `KEY` / `ACCEPT` / `INPUT` waits too, so `stopWaiting` is false.
- **Editor** (`editor.js`, `forth-scan.js`): highlighting by the interpreter's
  reading (`\` comments, `( … )`, `."` and `S"` end with their line, the name
  after `:` and the defining words, numbers by the ROM's grammar;
  `lineTokens(line, ctx)` carries the interpreter's state from line to line
  through `scanContext()`: inside `: … ;` or `[ … ]` a defining word reads no
  name, and a word whose definition uses `CREATE` and the like defines the name
  that follows it), completion
  with stack effects, hover help, folding `:` … `;`, indent, Tidy, block
  match, go to definition and rename of the program's words. No auto-caps
  (owner). Help: 184 words in the groups of the manual's Part 3 and 4, links
  to the manual at `FORTH_MANUAL_REF`.
- **Generated data, never hand-edit.** `forth-words.js`:
  `tools/gen-forth-words.py ~/2068-forth v2.0 > src/lang/forth/forth-words.js`
  (184 words; the plan's cross-check of the names against the `H_*` headers in
  the `.sym` files is not done, but the count matches). `examples.js`:
  `tools/gen-forth-examples.py ~/2068-forth v2.0 > src/lang/forth/examples.js`
  (the manual's 15 Part 7 programs and `demos/blackjack.fs`; the 12
  non-interactive ones run to OK in the tests).
- **Static check (F3, `forth-check.js`, advisory).** A Forth program cannot be
  compiled on a hidden machine (running it is the only way to read it), so
  `checkForth(text, sessionWords)` reads the text as the interpreter would,
  line by line as Run sends it, in the ROM's terms: `UNDEFINED WORD: X …` (a
  word that is neither a ROM word, nor defined earlier, nor in the live
  session), a compile-only word outside a definition, `;` without `:`, a `:`
  open at the end of the text, unbalanced `IF` / `ELSE` / `THEN`, `DO` /
  `LOOP` / `+LOOP`, `BEGIN` / `WHILE` / `REPEAT` / `UNTIL`, `LEAVE` outside a
  `DO`, a `."` or `S"` string not closed on its line (error), a `( … )`
  comment not closed on its line (**warning**: the rest of the line is the
  comment, but it does not continue), `MISSING NAME` and `OUT OF RANGE`
  (`numberInRange`: integers -32768 to 65535, floats to about 1.7E38).
  `lint` returns the storage problems of `prepareSource` and then these. Run
  does **not** refuse a program the check flags: the check is advice, the ROM's
  answer is what Run shows. **The session's words** are read from the live
  dictionary by `readSessionWords` (LATEST down to `FORTH_DICT_RAM`, headers
  `LINK(2) LENFLAGS(1) NAME`, the name's length in bits 0 to 4) in
  `attach().keyWait(m)`, which runs at the key wait when the machine is at the
  prompt (the EXROM is paged out there, so the whole dictionary is visible)
  and reads again only when LATEST changed. `sessionStamp()` returns LATEST;
  `ide.js` polls it with the debugger refresh interval (`DEBUG_REFRESH_MS`) and
  calls `leapEditor.relint()` when it changes, so a word typed at the prompt,
  or a Reset, changes the editor's marks. Diagnostics carry `severity`
  (`toDiagnostics` in `ide.js` passes it on; the Lint button reports the first
  error, not a warning).
- **Import session (`89a6d48`).** The "Import" button in the emulator panel
  header (`#btn-import-session`, shown when `profile.hasSession`) calls
  `attach().importSession(m)`: it reads the ROM's line store, `STORE_START` to
  `STORE_END` (every line typed or sent at the prompt; command lines such as
  `SAVE-TEXT` are not in it), CR-ended, as text, and `ide.js` opens it as a new
  unsaved document `session.fs` after the usual "discard changes?". An empty
  session, or a `STORE_END` outside the store, gives a message instead.
- **Tape (F5, `tape.js`, `6103f66`).** ⬇ TAP writes what `SAVE-TEXT` writes:
  header block (type 0, the name upper-cased and space-padded to 10, the text
  length, parameter 1 `FORTH_TEXT_WORD` `$8000`, parameter 2 the length) and a
  data block of the line store (every line ended by CR, no empty lines).
  `buildForthTap`, `forthTapeToText`, `isForthTape` (so Open on a `.tap` finds
  the language: Leap V2 tapes carry `$81xx`, Leap-C `$8C00`, Forth `$8000`),
  `textStore` and `LOAD_TEXT_MAX` (8 KB, `LOAD-TEXT`'s room). The tape name is
  upper-cased and has no spaces (`LOAD-TEXT` reads a word). Status: `Saved
  X.tap: on the TS2068, LOAD-TEXT X`. Verified in Node: the IDE's tape is
  byte-identical to the ROM's own `SAVE-TEXT` after the same lines were sent
  (the block sender replaced by a stand-in; `FORTH_TAPE_SYMBOLS` in the tests
  has `STORAGE_SEND_BLOCK` `$09CE` and `STORAGE_RECEIVE_BLOCK` `$0A5D` for 2.0),
  and the ROM's `LOAD-TEXT` reads it back and defines the words.
- **ROM entry.** `tools/forth-rom-entry.py <unpacked release zip> 2.0`: it
  checks `SHA256SUMS` and the key-wait bytes and takes every address from
  `symbols/forth_boot.sym`. The entry was built from the unpacked v2.0 zip.
- **Debugger (F4, `forth-debug.js`, `054198d`).** Forth compiles as it reads,
  so the line table is built **while the program is sent**, by watching the
  interpreter (`createLineTable(rom)`): each line enters at
  `EDITOR_LOOP_LIVE.enter` (the n-th entry of a run is job line n); at
  `INTERPRET_NESTED.token` with `STATE` 1 a record `{addr: HERE, line, word}` is
  added (a `STATE` 0 token only remembers the line, for the `:`); a definition's
  code starts at `COLON_XT`, which gets a record on the line of the `:` when
  its first body token arrives; text that `LOAD-TEXT` or `EDIT` runs
  (`SRC_PTR` outside `EDIT_BUF`) is ignored. Records are instruction starts
  only, never inline data (after `CALL DOLIT` / `DOFLIT` / `QBRANCH` /
  `BRANCH`, `."` and `S"`), so stopping at one is always safe. The table
  grows during the run, so it has a `version()` and the controller places
  the breakpoints again when it changes.
  - *Positions* (the controller's "statement" addresses): a record's address
    while the code runs, or `TOP` (`0x10000`) + n when job line n is sent. A
    breakpoint on a line outside a definition (`promptLines`) therefore stops
    when the line is sent; one in a word stops where each stretch of that
    line's code starts (not at every token). Step goes token by token, into
    the program's words, and also stops at each line sent.
  - *Variables*, titled **"Stacks and words"** (`labels.variables`): the data
    stack (IX, top first, up to 16 cells, signed and hex), the float stack
    (IY), then the session's words with their values (`readWords` walks
    LATEST down to `FORTH_DICT_RAM`; the kind comes from the word's code:
    `CALL DOLIT` gives a `VARIABLE` / `FVARIABLE` / `CONSTANT` / data area,
    `CALL DOFLIT` an `FCONSTANT`, `CALL DODOES` a `CREATE`d word, anything else
    a `:` word). The adapter is `live`: the table also shows between runs.
  - *Call stack* (`readCallStack`): the word the PC is in, the user words whose
    `CALL`s are on the return stack (an entry counts only when a `CALL`
    precedes it and it lies in a user word, since `DO` loops and `CATCH` frames
    share the stack), then "the line sent". Stop while paused is BREAK
    (`halt` false).
  - *Limits.* The records are reset by every Run **and every Send**
    (`debug.beginRun(job)`), so breakpoints and Step apply only to the words
    the latest Run / Send defined; a word defined earlier, or typed at the
    prompt, has no lines (it still shows in the words table and the call
    stack). `tools/forth-rom-entry.py` emits the new fields `doLit`, `doFLit`,
    `doDoes`, `qBranch`, `branch` and `stkGuard`; the 2.0 entry was
    regenerated from the release zip.
- **Cartridge (F8, `cartridge.js`, `f7a5d1d`).** ⬇ DCK and ▶ Test DCK for a
  stock TS2068. `cartridge.js` is a port of 2068-Forth's `tools/forthcart.py`:
  `programImage` (`"F1"`, `ROM_IDENTITY`, n = `HERE` - `$9100` at most 16,128,
  `LATEST`, the start word's length and name, the 168 UDG bytes, the
  dictionary, CRC-16/CCITT-FALSE), `buildForthCartridge` (the DCK: bank 0, the
  cartridge HOME in chunks 0-1, the image from chunk 2, the EXROM in chunk 5;
  and the flat 64 KB `.bin`), `cartImages`, `homeIdentity`, `crc16` and
  `isForthCartridge`. `cartridge/forth/2.0/forth_cart.dck` is the release's,
  unchanged (24585 bytes, SHA-256 `4f07fd88…`; identity `$FDBE`; README there).
  - *Owner's choices (2026-11-01), as built.* The editor's text is interpreted
    on a **fresh hidden machine** (`interpretFresh` in `profile.js`: a new
    machine with the loaded ROMs, line by line as Run sends it, at most about a
    minute of TS2068 time in all, 600 frames to boot and 3000 for the text); a
    line that errors (marked on its editor line), waits for a key (`KEY`,
    `ACCEPT`, `INPUT` at the top level) or runs too long is refused. Then
    `HERE` / `LATEST`, the dictionary (read from `m.ram`, since the EXROM hides
    part of it), the UDGs and the words are packed. **The start word is chosen
    at export** with `ui.prompt`, listing the program's `:` words, the newest
    as the default; it is checked against the dictionary.
  - *Checks before export.* The identity of the loaded ROMs against the
    cartridge's (`homeIdentity`), an `OUT` to port 244 or 255 with a literal
    port asks first, a program with no `:` word, a dictionary over 16,128
    bytes. The status gives the dictionary size and the start word.
  - *Test DCK / Open `.dck`.* `profile.ownsCartridge` recognises the image
    (`"F1"` at DOCK `$4000`), and `ide.js` passes that profile's keyboard table
    to `emulator.testCartridge(dck, symbols)`, so `[ ] { }` and the like can be
    typed in a Forth cartridge opened while BASIC is active; leaving the test
    puts the active profile's table back.
  - *Verified.* In Node, on a stock TS2068 the cartridge loads, runs the start
    word (a variable set to 42), keeps the UDGs and leaves the OK prompt; the
    IDE's DCK and BIN for the Blackjack demo are byte-identical to
    `forthcart.py`'s for the same dictionary (checked outside the tests). Not
    tried: real hardware, ZEsarUX / Fuse.
- **Not yet.** Of F6, the examples' `\ expect:` output and `\ keys:` lines and
  `demos/gallery.fs` are not checked; F7 (UDG and Draw tools) is optional and
  not started; the optional LIB tape (`SAVE-LIB` format) and the optional
  watches of F1 are not built.
- **Adding a Forth release.** Unpack its zip; move the TSRun pin to a commit
  carrying its ROMs (the pair in `tsrun/roms/` must match `forth-roms.js`);
  run `tools/forth-rom-entry.py <unpacked zip> <version>` and paste the entry;
  regenerate `forth-words.js` and `examples.js` at the tag; run
  `FORTH_ROMS=<dir> node tests/rom-checks.mjs` (like `LEAP_ROMS`) and the
  browser test.

### Leap-C (`src/lang/c/`, stages C1 to C7 and C9)

Leap-C **v1.0.0** (released 2026-11-01, tag `v1.0.0`, commit `83e6e21`; the
IDE still compiles with this ROM entry. **1.1.0** (tag `v1.1.0`, commit
`f8db836`, released 2026-11-02 UTC) added the runtime cartridge and carries
byte-identical ROMs, so it needed no new ROM entry: see "Cartridge (C9)";
TSRun's `roms/leapc-0.rom` / `leapc-1.rom` at the pin `9f9bbc5`, HOME
`d2b18eaa…`, EXROM `02790ebe…`, the pair's key in `leapc-roms.js` is
`c0f7f76f…`). The `v1.0.0-beta.2` entry (HOME `043becf4…`, EXROM
`97fe9523…`) stays in the table, so `LEAPC_ROMS=<dir of the beta.2 ROMs>` still
tests it (the library and tape checks print SKIP there: no library images and
no `LEAPC_TAPE_SYMBOLS` entry for it, and the cartridge check, the C4 checks
too: 128 of the 150 checks run). Commits: C1 to C3 `d0e437b` (on beta.2),
1.0.0 `ac0d00f`, C5 `94700cf`, C6 `4f30b82`, C7 `1050d7b`, C4 `0b419d3`,
C9 `4798b64`.
Plan: [`docs/LEAP_C_PLAN.md`](docs/LEAP_C_PLAN.md).

- **Run is the shell path** the Leap-C project recommends. At a shell key wait
  (`RUNNING` = 0, so `canInject`), `inject` writes the V2-format line store
  (`encodeLineStore`, reused from BASIC), `PROG_END`, `ARRAYS_END` and
  `CUR_EDIT_INDEX`, then SP = `$FF00` less four, pushes `SH_LOOP` and `SH_RUN`,
  A = 7 and PC = `GFX_SET_BORDER`. The ROM compiles, runs and shows its own
  report; `RUNNING` <> 0 at the key wait means the program waits in `getkey` /
  `gets`.
- **Stop is BREAK**, held `breakHold` (5) frames and then released: the
  report waits for every key to be released, and BREAK ends every wait with
  run-time error 5, so no jump is needed.
- **Errors.** `driver.result` reads `CC_ERRNUM` / `CC_ERRLINE` / `SH_ERR_COL`,
  or `RT_ERRNUM` / `RT_ERRLINE` (the line where the failing function starts)
  and the exit status. The compile error's token is marked by columns. Status
  (since C4, `0b419d3`): `Finished: exit n` (`reportExit` reads the report's
  text "EXIT n" from `SH_REPORT_BUF`; a ROM entry without `reportBuf` says
  plain `Finished`), `Compile error N on line L`, `Runtime error N on line L` and
  `Stopped (BREAK) on line L`, where L is the failing **statement**: the
  adapter's `stopLine` looks `RT_ERRPC` (set by every `RT_ERROR`) up in the
  line table; without a line table (beta.2) it is the function's definition
  line as before, "in the function on line N".
- **Checker** (`leapc-check.js`): `SH_COMPILE` on a hidden machine (boot to
  the shell key wait, snapshot, restore, write the store, call). The column is
  computed as `SH_RUN` does for `SH_ERR_COL`: `TOK_PTR` less the line's text
  start, 0-based, at most the line's length.
- **Editor** (`editor.js`, `leapc-scan.js`): highlighting of the Leap-C subset
  (unsupported C89 such as `long`, `union`, `volatile` marked), completion
  with prototypes, hover help, brace folding, indent, Tidy, match, go to
  definition and rename of file-scope names (functions, globals, macros). No
  auto-caps. Keys: `src/lang/keytables.js` `LEAP_EXTENDED_SYMBOLS`, so
  `[ ] { } | ~ ^ \` can be typed.
- **Tape (C5, `94700cf`).** ⬇ TAP writes what Leap-C's `SAVE "name"` writes:
  V2's two blocks (`buildTAP` and `encodeLineStore` reused from BASIC) with the
  format word `$8C00` (`LEAPC_TAPE_WORD`; the ROM entry's `tapeFormatWord`).
  Open reads a Leap-C tape back and switches to Leap-C (`tapeToText(bytes,
  {accepts, language})` in `src/files.js` takes the accepted format word, V2's
  `$81xx` by default, so the languages refuse each other's tapes). Status:
  `Saved X.tap: on the TS2068, LOAD "X" then RUN` (with `LIB "shapes", then `
  first for a program that uses the library). Verified in Node against the 1.0.0
  ROM: `SH_SAVE` (the shell's `SAVE "demo"`, the block sender a stand-in; the
  tests' `LEAPC_TAPE_SYMBOLS` holds the addresses) sends exactly the IDE's tape,
  and `SH_LOAD` of the IDE's tape restores the line store and `PROG_END`.
  Outside the tests, all 44 program tapes of the 1.0.0 release open and
  re-export byte for byte.
- **Libraries (C6, `4f30b82`).** `libs/c/1.0.0/shapes.bin` (438 bytes, SHA-256
  `c4c145cd…`; README there) is the data block of the release's
  `libs/shapes.tap`, unchanged. `librariesUsed(text, functions)` in
  `leapc-scan.js` finds calls of a library function (`circle`, `box`, `isqrt`;
  the names and their libraries come from the generated keyword data, the
  manual's Part 6) that the program does not define itself. `attach()` fetches
  `libs/c/<version>/<name>.bin` (`fetchAsset`); for every check and Run the
  profile installs the library the program uses, as `LIB "name"` does (the image
  at `LX_BASE` `$F400`, `LIB_LOADED` set to `$F4`), or unloads it
  (`LIB_LOADED` 0), because a library stays loaded between runs by design and
  would otherwise change where the compiler places code (it occupies image
  region 3). One library at a time (a second is an error on its line). A
  release without images says the library is not available. Run's start message
  is `Compiling (with LIB "shapes")…`.
- **Examples (C7, `1050d7b`).** `tools/gen-leapc-examples.py ~/2068-Leap-C
  v1.0.0 > src/lang/c/examples.js`: the manual's 18 Part 7 programs, each with
  its test directives taken out of the text as data (`exit`, `screen`,
  `pixels`, `keys`, `library`, `tape`). The shapes examples load the library by
  themselves (C6). `tests/rom-checks.mjs` runs the 15 programs without keys or a
  tape through the IDE's run path and compares the exit status (HL at
  `RT_RUN.done`), the screen text (the glyphs learnt from the ROM by printing
  ASCII 32 to 126) and the pixels, both as at `RT_RUN.done` (before the report
  on row 23): all match, and all 18 check clean. The programs that need keys
  (`keys`) and the tape one are not driven in the tests yet.
- **ROM entry.** From the release's emulator pack (`leapc-1.0.0-emulators.zip`:
  `roms/`, `symbols/`, `SHA256SUMS`): flatten the images, the `.sym` files and
  their `SHA256SUMS` lines into one directory and run
  `tools/leapc-rom-entry.py <dir> 1.0.0` (it checks the images against the
  sums, and takes `SH_WAIT_KEY.key_ret` from the symbols; 1.0 has the label).
  The beta.2 entry was built from the tag in a detached worktree (the tag has
  no `.sym` and no `key_ret`, so the script derived it as
  `SH_WAIT_KEY.read + 3` after checking the CALL; that fallback is still in the
  script).
- **Generated data, never hand-edit.** `leapc-errors.js`:
  `tools/gen-leapc-errors.py ~/2068-Leap-C v1.0.0 >
  src/lang/c/leapc-errors.js` (from `include/leapc_errors.inc` at the tag).
  `leapc-keywords.js`: `tools/gen-leapc-keywords.py ~/2068-Leap-C v1.0.0 >
  src/lang/c/leapc-keywords.js` (from the manual at the tag; the content is
  the same as when it came from `main` at `83e6e21`, which is the commit
  `v1.0.0` points to; for a tag the script sets `LEAPC_MANUAL_REF` to the tag
  name, not the tag object's hash). `examples.js` as above.
- **Debugger (C4, `leapc-debug.js`, `0b419d3`).** Leap-C compiles to native
  Z80 code, so the line table (`createLineTable(rom)`) is built by watching the
  compiler, at `STATEMENT`, `DCL_AUTOINIT` and `STMT_DO.cond` (record
  `TOK_LINE`, `CG_PC`), at `CG_UNIT.found` (the code moves on to the next
  image region at any instruction: record the last line, `DE`), and, when the
  program starts (`RT_RUN`), from the `RUN_FNLINES` records (each function's
  prologue and definition line). At one address the later record wins; the
  line of an address is the last record at or below it. All these points are
  in HOME.
  - *At `RT_RUN`* the compile workspace is still intact (the heap overwrites it
    once the program runs), so the globals (the `SYM_GLO` chain: name, type
    decoded from its handle or type node, static address) and the functions'
    names are copied then.
  - *Memory is read from `m.ram`* (TSRun's flat RAM array), not through the
    paging: `$C000-$DFFF` is the EXROM whenever the shell or an EXROM routine
    runs, with the program's static data (RUN_FNLINES, globals) under it. A
    position counts only when its 8K chunk is paged to RAM (`inRam`, port `$F4`).
  - *Breakpoints* stop at a line's statements; *Step* goes statement by
    statement, into called functions (a `for` loop's test and step are not
    statement starts); `labels` are "Globals" and "statement". *Variables*
    ("Globals") shows `int`, `unsigned`, `char`, `float`, pointers, arrays
    (strings as text, the first 8 elements of others) and structs (address
    only). *Call stack*: the `IX` frame chain (the caller's `IX` at `IX`, its
    return address at `IX+2`; at a function's prologue the return is still at
    SP). Stop while paused is BREAK.
  - *ROM entry.* `tools/leapc-rom-entry.py` emits `reportBuf`, `dclAutoinit`,
    `stmtDoCond`, `cgUnitFound`, `runFnlines`, `symGlo`, `rtRun` and `rtErrPc`;
    the 1.0.0 entry was regenerated. The beta.2 entry lacks them: the profile
    then returns a no-op adapter (registers, memory and Z80 breakpoints), the
    status says plain `Finished`, and the C4 tests print SKIP.
- **Cartridge (C9, `cartridge.js`, `4798b64`).** ⬇ DCK and ▶ Test DCK for a
  stock TS2068, on Leap-C 1.1.0's runtime cartridge build (the release's
  `leapc-1.1.0-cartridge.zip`; description from the Leap-C project in
  `docs/requests/LEAP_C_CARTRIDGE.md`, read only). `cartridge/c/1.1.0/` holds
  `leapc_cart_home.bin` (16384 bytes, SHA-256 `034e294d…`),
  `leapc_exrom.bin` (8192 bytes, the release EXROM, equal to TSRun's
  `roms/leapc-1.rom`), `cartridge.json` (the identity it accepts) and a README.
  - *Identity.* CRC-16/CCITT-FALSE of HOME then EXROM (`romIdentity`). 1.0.0
    and 1.1.0 have byte-identical ROMs, so the IDE's 1.0.0 entry has
    `romIdentity: 0xE90E` and `cartridgeDir: 'cartridge/c/1.1.0/'` and the
    cartridge accepts what it compiles. A release that changes the ROMs needs
    its own cartridge build (the cartridge shows `NO PROGRAM` for another
    identity); export refuses when the loaded ROMs' identity or EXROM differs
    from the cartridge's.
  - *`cartridge.js`* (pure; a port of the zip's `tools/cartpack.py` and
    `tools/c2cart.py`'s `region_blocks`): `crc16`, `romIdentity`,
    `regionBlocks`, `programImage`, `buildCartridge` (`{dck, bin}`),
    `isLeapcCartridge` and the constants `CHUNK`, `MAX_IMAGE`, `REGIONS`.
  - *Program image (format 1).* `"LCPG"`, format 1, identity, `RUN_MAIN`
    (word), `RUN_VOID` (byte), `IMG_LIM` (16 bytes: four regions x
    [low][high]), `LIB_LOADED`, then blocks `[length][address][bytes]`
    (1 to 8192 bytes, inside one region) and a length of 0, then the
    CRC-16/CCITT-FALSE of everything before it, **high byte first**. There is
    no `RUN_FNLINES` field. At most 24 KB (the regions hold about 19.9 KB).
  - *Layout.* DCK bank 0; chunks 0-1 the cartridge HOME, 4-5 the image (at
    DOCK `$8000`), then chunk 2 past 16 KB, 6 the EXROM; chunks 3 and 7 absent.
    A program under 16 KB gives 9 + 5 x 8192 bytes. The flat `.bin` is 64 KB,
    chunk n at n x 8192, `$FF` in absent chunks and unused tails. The EXROM is
    in chunk 6 because compiled programs reach it at run time (floats, `beep`,
    `sound`, tape), and chunk 6 is also the program's region 1 (RAM) except
    inside those trampolines.
  - *Reading the program: the checker's `compileImage(store, lineCount, lib)`*
    (`leapc-check.js`). It compiles as `check()` does, with the program's
    library, and on code 0 returns `runMain`, `runVoid`, `imgLim`, `libLoaded`
    and the `blocks`: per region the code `[base, low)` and the static data
    `[high, end)`; region 3 whole when a library is loaded; region 4 (hi-res,
    `#pragma hires`) up to its last non-zero byte. They are read from `m.ram`
    itself, since `$C000-$DFFF` is the EXROM again once `SH_COMPILE` returns
    (region 1's code is under it). The cells' addresses are ROM-entry fields:
    `runMain`, `runVoid` and `imgLim` (and `libLoaded`), emitted by
    `tools/leapc-rom-entry.py`.
  - *`buildCartridge(text, ui)`* of the attached C profile, in order: source
    problems or an empty program, no `cartridgeDir` / `runMain` in the ROM
    entry ("There is no cartridge build for Leap-C <version>"), the store too
    big, a library problem (one library at a time), the cartridge files
    (fetched once through `fetchAsset`), the identity and EXROM against the
    loaded ROMs, an `outp` to port 244 or 255 with a literal port (`ui.confirm`;
    it can switch the cartridge's ROMs out), the compile (a compile error
    reads "Compile error N on line L: fix it first" and marks the line), then
    `programImage` and the pack. It returns `{dck, bin, summary}` (`N bytes of
    program`, `and the shapes library` when there is one), `{error, line0?}` or
    `null`. `profile.hasCartridge` is true and `profile.ownsCartridge`
    (`isLeapcCartridge`: `"LCPG"` at DOCK `$8000`) lets ▶ Test DCK / Open
    `.dck` pick the keyboard table (`[ ] { }` and the like).
  - *`tools/leapc-rom-entry.py <dir> <version> [<cartridge dir>]`.* The
    optional third argument (e.g. `cartridge/c/1.1.0/`) adds `romIdentity` (the
    CRC-16 of the ROMs it was given) and `cartridgeDir` to the entry; `runMain`,
    `runVoid` and `imgLim` are always emitted.
  - *How the cartridge differs from RUN* (worth telling a user): its report is
    the one-row report (`EXIT n`, `RUNTIME ERROR n MESSAGE`, `BREAK`) with **no
    line number** (there is no source on the cartridge); the UDGs are blank at
    every start; a key after the report restarts the program from a cold start
    (the image is copied afresh); `malloc`'s addresses differ (the heap starts
    lower) and `PEEK($0000-$0007)` reads the LROS header. Reports and final
    screens were identical for the 115 programs the Leap-C project compared.
  - *Verified.* The IDE's cartridge for the release demo (`examples/cart_hello.c`
    at `v1.1.0`) is byte-identical to the zip's `demo/hello.dck` and
    `hello.bin` (checked outside the tests). `tests/rom-checks.mjs` section 9
    runs the exported cartridges on a stock TS2068 in TSRun (Leap-C itself had
    only qualified it on Fuse 1.9.1 and ZEsarUX 13.0): a program to its report
    (`EXIT 7`, a line drawn) and a shapes program with the library in region 3
    (`EXIT 12`, a circle drawn); also the identity `$E90E`, the DCK layout, a
    compile error refused with its line and `outp(244, …)` asking first. The
    browser test runs ▶ Test DCK and Stop. Not tried: real hardware.
- **Not yet.** Locals in the debugger (a second version: `IX` + the symbol's
  value for `SF_AUTO` entries, with each block's code range from
  `SCOPE_OPEN` / `SCOPE_CLOSE`); driving the Examples-menu programs that need
  keys (`keys:`) and the tape one in the tests; running the C examples from
  cartridges against the manual (as V2's 695-program comparison); C8 (UDG and
  Draw tools) is optional and not started.
- **Moving to a later release.** Take the release's emulator pack, run
  `tools/leapc-rom-entry.py`, move the TSRun pin if the ROMs changed,
  regenerate the three data files at the tag, copy the library images to
  `libs/c/<version>/` (check them against the release's `SHA256SUMS`), add
  `LEAPC_TAPE_SYMBOLS` for it in the tests, and run
  `LEAPC_ROMS=<dir> node tests/rom-checks.mjs` and the browser test.

### Adding a Leap-C release

As above, plus the cartridge: a release whose ROMs changed needs its own
cartridge build. Copy the release's `leapc-<version>-cartridge.zip` files
(`roms/leapc_cart_home.bin`, `roms/leapc_exrom.bin`) to `cartridge/c/<release>/`
with a `cartridge.json` (`{"identity": "<hex>"}`, the identity the cartridge
accepts, published with the release) and a README with the SHA-256s, check them
against the zip's `SHA256SUMS`, and regenerate the entry with the third
argument, `tools/leapc-rom-entry.py <dir> <version> cartridge/c/<release>/`
(`romIdentity` and `cartridgeDir`). A release with byte-identical ROMs (1.0.0
and 1.1.0) keeps its entry and only the cartridge directory is new; check that
`romIdentity(ROM HOME, EXROM)` equals the cartridge's identity. Without
`cartridgeDir` export says there is no cartridge build for that version. The
C9 checks in `tests/rom-checks.mjs` section 9 then run against the new build.

---

## Leap V2 BASIC — Language Quick Reference

Leap V2 is a **structured BASIC**: the program is kept as source text and
compiled to bytecode by the ROM on every `RUN`. Full detail: the language
reference and manual. Keywords, names and statements are case-insensitive.

| Feature            | Leap V2                                                         |
|--------------------|-----------------------------------------------------------------|
| Line numbers       | **None.** Lines are edited in the ROM's full-screen editor      |
| Statements         | One or more per line separated by `:`; line max **127** chars   |
| Labels             | `name:` on its own line; the only jump targets; duplicate = error 57 |
| Comments           | `REM` to end of line (`'` is **not** a comment)                 |
| Assignment         | `x = 1`, `x$ = "a"`, `a(i) = 1` — **no `LET`** (compile error 2)|
| Control flow       | `IF cond THEN` … [`ELSE` …] `ENDIF` (always a block); only one-line form is `IF cond THEN GOTO label`; no `ELSEIF` |
| Loops              | `FOR v = a TO b [STEP s]` … `NEXT [v]`; `EXIT FOR`              |
| Jumps              | `GOTO label` only. **No `GOSUB`/`RETURN`** (compile error 2) — use `PROC`/`CALL` |
| Procedures         | `PROC name(p):` … `ENDP`, `CALL name(expr)`; one by-value parameter; recursion works (~739 levels) |
| User functions     | `DEF FN f(x) = expr`, used as `FN f(expr)`; numeric, one parameter |
| Identifiers        | Letter then letters/digits, **max 31**, **no underscore**; a keyword or built-in name cannot be a variable/label/PROC name (a name that merely begins with one can) |
| Numbers            | 16-bit integers or 5-byte floats (~9 digits, up to ~1.7E38); no exponent or hex literals |
| Strings            | 0..**31** characters (literal longer = compile error 70); `+` concatenates; no `a$(i TO j)` slicing (use `MID$`) |
| Arrays             | `DIM a(n)`, `DIM a$(n)`, `DIM a$(n,w)`; `n` a literal; one dimension; numeric elements are integers only |
| Functions          | Always written with brackets, even with no argument: `PI()`, `INKEY$()`, `FREE()` |
| Relations/logic    | `= <> < > <= >=`, `NOT`, `AND`, `OR` (logical 0/1, short-circuit); `MOD`/`DIV` are **functions**; no power operator |
| Graphics           | 256×192, **y from the top**: `PLOT x,y`, `LINE x0,y0 TO x1,y1` (absolute; no `DRAW`) |
| UDGs               | 21 characters, codes **144–164**, 8 bytes each at `$F180`–`$F227`; defined with `POKE`; print with `CHR$(144)`… |
| Sound              | `BEEP seconds,semitones`, `SOUND register,value`                |
| Output             | `PRINT item {; or , item}`; `AT row,col` and `TAB col` are **statements**, not `PRINT` items |
| Input              | `INPUT var`, `INPUT "prompt"; var` — plain variable only        |

### Keyword inventory (for highlighting, autocomplete and help)

A human-readable summary, checked against the language reference sections 5, 6,
7, 11 and manual Appendix H. The authoritative data is the generated
`src/lang/basic/leap-keywords.js` (see "Keyword data" below); this table must agree with
it.

| Class                       | Words |
|-----------------------------|-------|
| Structure                   | `REM` `END` `STOP` `GOTO` `IF` `THEN` `ELSE` `ENDIF` `FOR` `TO` `STEP` `NEXT` `EXIT` (`EXIT FOR`) `PROC` `ENDP` `CALL` `DEF` `FN` `CLEAR` |
| Declarations                | `DIM` |
| Screen/text statements      | `PRINT` `AT` `TAB` `CLS` `INK` `PAPER` `BRIGHT` `FLASH` `INVERSE` `OVER` `BORDER` |
| Graphics statements         | `PLOT` `LINE` |
| Sound statements            | `BEEP` `SOUND` |
| Input/machine statements    | `INPUT` `PAUSE` `POKE` `OUT` `RANDOMISE` |
| Operators (words)           | `AND` `OR` `NOT` |
| Numeric functions           | `ABS` `SGN` `INT` `MOD` `DIV` `SQR` `SIN` `COS` `TAN` `PI` `RAD` `DEG` `RND` |
| String functions            | `LEN` `CODE` `VAL` `CHR$` `STR$` `UPPER$` `LOWER$` `LEFT$` `RIGHT$` `MID$` |
| Machine/input functions     | `INKEY$` `PEEK` `USR` `IN` `STICK` `POINT` `ATTR` `FREE` `DIMN` |
| Package statements (loaded with `LOAD "NAME" EXT`) | mode: `MODE` `ULAPLUS` `PALETTE`; sprite: `GRAB` `SHOW` `MOVE` `HIDE`; printer: `LPRINT` `LLIST`; shapes: `CIRCLE` `FILL`; graphics: `CPLOT` `BLOCK` `FRAME` `INVERT`; cbeep: `CBEEP` |
| Commands (typed in the ROM editor, **not valid in programs**) | `RUN` `LIST` `NEW` `SAVE` `LOAD` `VERIFY` (with `ALL`, `ARRAY`, `EXT`) |

Not in V2 (compile error or simply absent): `LET`, `GOSUB`/`RETURN`,
`DRAW`, `COPY`, `DATA`/`READ`/`RESTORE`, `ELSEIF`, `INSTR`, `PRINT AT` /
colour items inside `PRINT`, multi-dimensional arrays, `DIM` with a variable
size, exponent/hex literals, `CIRCLE`/`FILL` without the SHAPES package. The
characters `[ \ ] ^ ` { | } ~` printed as blanks in 2.0.2 (no glyphs); 2.1 gives
every printable ASCII character a glyph (Q-26), so they print now. Leap still
has no key for them (see Keyboard).

### Compile and run-time errors

The ROM reports numeric codes; the IDE reads them from RAM (see "How Run
Works"). Full tables: manual Appendix B, which `src/lang/basic/leap-errors.js` is generated
from (see "Editor Error Checking"). Codes the editor and status bar meet
most often:

| Code | Cause |
|------|-------|
| 2    | Unknown word, identifier not followed by `=` (includes `LET`, `GOSUB`, a package statement whose package is not loaded) |
| 3    | Expression could not start |
| 7    | `GOTO` to an undefined label |
| 8, 9 | `IF` without `THEN`; `IF` block without `ELSE`/`ENDIF` |
| 16, 65 | `PROC` without `ENDP`; `FOR` without `NEXT` |
| 56, 57 | `NEXT` for the wrong variable; duplicate label/`PROC`/`DEF FN` |
| 60, 61 | Nesting too deep; name too long (> 31) |
| 64   | Unexpected token (also a literal beyond the number range) |
| 70   | String literal longer than 31 characters |
| run-time 66 | BREAK |

Limits (manual Appendix D): name 31 chars, string 31, line 127, 251 number
names, 251 string names, 255 array names, ~440 labels, nested `IF` 211 / `FOR`
141 / brackets 105, recursion 739, compiled code 4011 bytes, program text
about 8.9 KB.

---

## Memory Map — Critical Addresses (2.0.2-emu.1 and 2.1.0-emu.1)

The data layout below is the same in both releases (checked in 2.1: the main
pool, `V2_SOURCE_END`, the VM and compiler tables, the UDG table and the package
window did not move). Routine addresses did move (for example `V2_COMPILE_STORED`
is `$D54F` in 2.0.2 and `$D45A` in 2.1, `IO_READ_KEY.wait_hit` is `$0443` in
2.1); the per-release values live in `src/lang/basic/leap-roms.js`. Full table: manual
Appendix E.

| Range / symbol            | Address            | Notes |
|---------------------------|--------------------|-------|
| Free for user machine code | `$5B00`–`$5FFF`, `$7800`–`$7FFF` | Not used by V2 |
| Leap system variables     | `$8000`–`$8259`    | Do not touch |
| `PROG_END` sysvar         | `$8002`            | Byte after the end of the stored program. **Not** `$5C53` — that is Sinclair's |
| `PROG_AREA_START`         | `$825A`            | Start of the main pool |
| Main pool                 | `$825A`–`$A654`    | 9211 bytes: program text, variables, names, arrays. `V2_SOURCE_END` = `$A655` |
| Compiled bytecode         | `$A655`–`$B5FF`    | 4011 bytes, rebuilt on every run |
| Fixed tables / compiler workspace | `$B600`–`$BFFF` | Includes `RT_SYMTAB_PTR` (`$B80D`), `VM_ERROR_CODE`, `COMPILE_ERROR_CODE` |
| RAM under EXROM           | `$C000`–`$DFFF`    | Hidden while a program runs |
| Overflow segment          | `$E000`–`$E7FF`    | Arrays that did not fit, Array Store |
| UDG table                 | `$F180`–`$F227`    | 21 chars, codes 144–164, 8 bytes each (**not** `$FF58`) |
| Package window            | `$F400`–`$F7FF`    | Loaded package lives here |
| Machine stack             | grows down from `$FF00` | |

Sinclair addresses such as `$5C3A` (IY) and `$5C3D` (ERR_SP) do not apply to
Leap's own state. The Z80 `IY` is still saved/restored by `USR`.

---

## TSRun Integration

TSRun files are **ES modules** (`import`/`export`), imported by
`src/emulator.js` from the `tsrun` submodule. They are not classic `<script>`
tags. TSRun's own `host.js` is tied to its desk UI, so the IDE has its own slim
host in `src/emulator.js`. There is **no** `machine.run()` / `.stop()` /
`.step()` / `.poke()` API.

| File          | What the IDE uses |
|---------------|-------------------|
| `machine.js`  | `createMachine`, `setHomeRom`, `setExRom`, `insertDock` / `ejectDock` (a stock TS2068 with a dock cartridge: the cartridge test and the tests), `resetMachine`, `runFrame`, `setVideoOn`, `enableSound`, `setSoundRate`, `takeAudio`, `cpuHz`, `tStatesPerFrame`. Memory: `machine.bus.read(addr)` / `machine.bus.write(addr, v)`. |
| `z80.js`      | `runZ80(cpu, budget)` — a budget of 1 runs one instruction. CPU state is `machine.cpu` (`pc`, `sp`, `a`, `f`, `b`, `c`, …, `iff1`, `im`). |
| `screen.js`   | `initScreen`, `resizeScreen`, `setCrt`, `drawScreen` (WebGL2) |
| `keyboard.js` | **Not used** by the IDE; `src/pc-keyboard.js` replaces it (see Keyboard). The IDE writes `machine.keyMatrix` itself. |
| `sound.js`    | `initSound`, `resumeSound`, `pushSound`, … (AudioWorklet, needs the fork's `import.meta.url` fix) |
| `dock.js`     | `parseDck` only (reads a dock; accepts banks 0 DOCK, 254 EXROM, 255 HOME; used through `insertDock` in `machine.js`, not imported by the IDE) |
| `tape.js`, `load.js` | Tape loading. The tape-loading fix below (TSRun issue #3) is needed for Leap's own `LOAD` to read the IDE's `.tap` in TSRun. |

`ide.html` loads no TSRun script tags. ROMs are fetched by `src/emulator.js`
from `tsrun/roms/` (the paths are the active profile's `romFiles`), hashed
(HOME + EXROM, SHA-256) and looked up in the profile's `knownRoms` (BASIC:
`src/lang/basic/leap-roms.js`); **an unknown ROM pair is refused**.

---

## How Run Works (RAM Injection) — implemented and verified

1. **Source to line store.** `prepareSource` (`src/lang/basic/profile.js`)
   splits the editor text, drops blank lines (the ROM editor never stores an
   empty line) and keeps a map back to editor line numbers; `encodeLineStore`
   (same file; it used to be in emulator.js) encodes it. `startRun(text)` of the
   attached profile (see "Languages") wraps both and returns the job the
   emulator runs.
   The ROM's line store, at `PROG_AREA_START`, is, per line: LE16 (text length
   + 1), the text verbatim (no tokenising, no line numbers), then `$0D`. It is
   **not** one ASCII blob with `\r` terminators. Refuse non-printable-ASCII,
   lines over 127 characters, and a store larger than the pool.
2. **Wait for a safe point.** The CPU must be in the ROM's key-wait spin loop
   `IO_READ_KEY.wait_hit` (`$0435`–`$043A`) with the EXROM paged in (port `$F4`
   bit 6, port `$FF` bit 7). The editor idles there, as do `INPUT`, `PAUSE 0`
   and the "press a key" after a run. It is found by single-stepping the frame
   (`runZ80` with budget 1), then `runFrame` finishes the frame.
3. **If the program is busy,** press BREAK (CAPS SHIFT+SPACE in the matrix) for
   up to 60 frames. If that does not reach the key wait, reset and boot (about
   66 frames to the editor). After BREAK, clear the ROM's key latch
   `KBD_KEYHIT`, else the latched BREAK dismisses the BREAK message.
4. **Inject and jump** (`driver.inject` in `src/lang/basic/profile.js`; the
   emulator calls it at the safe point). Write the store and `PROG_END`; push a return chain on
   the ROM stack (`SP=$FEFA`: `V2_RESET_EDIT`, `V2_RESET_DISPLAY`,
   `V2_RUN_STORED`, then `V2_COMMAND_LOOP.loop` at `$FF00`) and jump to
   `V2_CLEAR_ARRAYS`. If the
   program uses a package, the jump goes to `EXT2_CLEAR_ALL` instead, with the
   package installed first (see "Packages").
   `CLEAR_ARRAYS` + `RESET_EDIT` are what `LOAD` does after replacing a
   program; `V2_RUN_STORED` is what typing `RUN` calls (it compiles, clears
   the screen, runs, then waits for a key). `V2_RESET_DISPLAY` (ROM-table
   field `resetDisplay`: `$D194` in 2.1, `$D283` in 2.0.2) sets INK 0, PAPER 7,
   BRIGHT / FLASH / INVERSE / OVER 0, a white border and video mode 0, which
   Leap does on every return to its editor; the IDE never returns there, so
   without it one run's colours carried into the next (checked by both test
   suites). No code is written outside the stack. This mirrors the Leap test harness (`tools/v2_prod.py` /
   `v2_headless.py` in 2068-Leap).
5. **Result.** Back at the key wait with `SP=$FF00` means the run ended;
   `INPUT`/`PAUSE` wait deeper. `COMPILE_ERROR_CODE` and `VM_ERROR_CODE` give
   the error (VM 66 = BREAK). After a compile error `CUR_EDIT_INDEX` holds the
   failing line index, which the IDE maps back to the editor line and marks.
   The status bar shows Finished / Compile error N on line L / Runtime error N
   at line L / Stopped (BREAK) at line N, and the marked line carries the
   manual's message (`describeError` in `src/lang/basic/profile.js`, text from
   `src/lang/basic/leap-errors.js`; the result is read by `driver.result` and
   turned into status text by the attached `describeResult`).
   Leap reports no line for a run-time error; the IDE finds it through the
   debugger's line table (`stopLine` of the debug adapter, `src/lang/basic/profile.js`): `VM_IP` is left
   just past the failing instruction, so `VM_IP - 1` is looked up; after BREAK
   `VM_IP` is the next instruction, so it is looked up as is. While a program waits at `INPUT`/`PAUSE 0` it reads
   "Waiting for input — click the screen to type".
   When a run ends its output stays on screen: nothing dismisses it into
   Leap's editor (see Keyboard). The Run button injects at that "press a key"
   wait as before.

**Stop:** BREAK if busy; if the program is waiting at `INPUT`/`PAUSE 0`, jump
straight back to the ROM's command loop (`V2_COMMAND_LOOP.loop`;
`driver.stopWaiting` in the profile, which returns false for a language whose
waits BREAK alone ends). Observed
(Node, both releases): BREAK alone does not end an `INPUT` wait in 2.0.2, nor in
2.1.0-emu.1, whose VM latches error 66 and, per its source, stops only after
ENTER. The jump is therefore still needed and behaves the same on both.

`window.leapIDE` exposes `lintSource`, `setStatus`, `switchLanguage`,
`emulator` (the object from `createEmulator`: `run`/`stop`/`reset`/`setProfile`,
`rom`, `machine`), `profile` (the active language profile) and `lang` (its
`attach()` result, null until attached), which is useful for tests and the
debugger. (`encodeSource` is gone: the profile's `startRun` does that.)

Verified in headless Chromium: hello world, compile error with line, BREAK
stop, `INPUT` stop, re-run while busy.

### Adding a Leap ROM release

1. Build the release tag in a separate detached worktree, not in the working
   clone (`~/2068-Leap` may have local edits on another branch):
   `git -C ~/2068-Leap worktree add --detach <dir> <tag>`, then `make build`
   in `<dir>`. Compare the ROMs with the release zip's.
2. `tools/leap-rom-entry.py <checkout> <version>` prints a `KNOWN_ROMS` entry
   (the script also checks that the key-wait spin loop still has the expected
   bytes). Its `SYMBOLS` table (in the script) includes the debugger's compiler, VM and run-time
   table symbols, so each entry must be regenerated this way, not copied from
   another release. A symbol a release lacks is looked up under its
   `FALLBACK` name (2.0.2 has no `VM_RUN.next`, so `vmNext` takes
   `VM_RUN.loop`).
   It also emits the package fields `ext2ClearAll`, `packageBase`, `packageLen`
   and `packageDir` (see "Packages"), plus `symCounts` and, if the release has a
   cartridge build, a `cartridgeDir` line (step 5).
3. Paste the entry into `src/lang/basic/leap-roms.js` and put the new
   `leap-0.rom`/`leap-1.rom` in `tsrun/roms/` by moving the submodule to a TSRun
   commit that carries them. Copy the release's package binaries
   (`v2_package_<name>.bin`) unchanged to `packages/<version>/<name>.bin` and
   check them against the release's `SHA256SUMS`.
4. Run `LEAP_ROMS=<dir with the new leap-0.rom/leap-1.rom> node tests/rom-checks.mjs`
   (and again without `LEAP_ROMS` after moving the submodule), then
   `node tests/browser-smoke.mjs`. They cover hello world, compile and run-time
   errors, the checker, packages, the debugger and TAP export. Add the
   release's `SAVE_SYMBOLS` to `tests/rom-checks.mjs` from its `.sym` files.
   The TAP check replaces the block sender with a stand-in; since 2.1 it must
   return with carry set ("sent whole"), because 2.1's `SAVE` stops after a
   header block that reports an abort ("SAVE abort" fix). A later release may
   change such a contract again.
   BREAK and `INPUT` stop are still checked by hand in the IDE.
   Update the memory-map table above if the layout moved.
5. Cartridge build (DCK export): build the release's cartridge version
   (`make cart`, `-DV2_CARTRIDGE`): rebase `cartridge-build/leap.patch` onto the
   new tag and update `TAG` in `cartridge-build/setup.sh`, run it, copy `leap_v2_cart_home.bin` and `leap_v2_cart_exrom.bin`
   to `cartridge/<version>/` with a README, and keep the `cartridgeDir` line in
   the ROM entry. Check that `cartIdentity(cartridge HOME)` equals
   `romIdentity(release ROMs)`; export refuses a mismatch. If the release has
   no cartridge build, leave `cartridgeDir` out and export says there is none.
   The cartridge checks in `tests/rom-checks.mjs` (section 7) then need the new
   identity and the release's `symCounts` address.

---

## Keyboard (Phase 4 — done, `src/pc-keyboard.js`)

**Owner decision:** the finished IDE never allows typing in Leap's own ROM
editor; all program editing happens in CodeMirror. Keys reach the TS2068 only
while an injected program is running (`INPUT`, `INKEY$`, `PAUSE 0`) and the
emulator screen (`#ts-bezel`) has focus. When a run ends (finished, error,
BREAK) its output stays on screen, since no keypress can dismiss it into the
Leap editor.

Keys are mapped as a PC keyboard is labelled. `src/pc-keyboard.js` takes the
character the PC key produces (`e.key`) and translates it to the TS2068 combo
that makes Leap's decoder (2068-Leap `kernel/io/io.asm`: `IO_DECODE_KEY`,
`KEY_ASCII_TABLE`, `KEY_ASCII_TABLE_UPPER`, `KEY_ASCII_TABLE_SYMBOL`, as of
2.0.2) produce the same character. The SYMBOL SHIFT table is the language
profile's (`keyboard.symbols`; `createPcKeyboard(keyMatrix, symbols)` and
`setSymbols()` on a language switch), since Leap-C and Forth type more
characters (`[ ] { }` and others). Examples: a PC `"` sends SYMBOL SHIFT+P,
Shift+8 `(` sends SYMBOL SHIFT+8 without CAPS SHIFT, and `A` sends CAPS
SHIFT+A (Leap gives lowercase for plain letters).

- Mapped symbols: `: ? / < > ! @ # $ % _ ) ( ' & " ; = + - . , *`
- Named keys: Enter; Backspace/Delete -> CAPS SHIFT+0; arrows -> CAPS SHIFT
  5/6/7/8 (`INPUT` line editing); Escape -> BREAK (CAPS SHIFT+SPACE)
- Not mapped: characters Leap has no key for (`` ^ [ ] { } \ | ~ ` ``), Ctrl/Alt/
  Meta combos, and Tab (TSRun maps Tab to CAPS SHIFT+1, which Leap decodes as
  delete-line)

TSRun's `keyboard.js` is no longer used by the IDE and is not patched. The
seven `hostBits` lines proposed in earlier drafts were checked and
**rejected; do not apply them.** `hostBits` is keyed by physical `e.code` and
applied unconditionally, so `hostBits.Digit8 = [ss, key8]` would make the 8 key
always type `(` and would make 8, 9, 4, R, T, Z and P untypable everywhere.

`kernel/io` (the key tables) is identical in v2.0.2-emu.1 and v2.1.0-emu.1, so
`src/pc-keyboard.js` needed no change for 2.1. If a later release changes the
key tables, the profile's `keyboard.symbols` (`SYMBOLS` in
`src/lang/basic/profile.js`) must follow. The characters
`` ^ [ ] { } \ | ~ `` now print in 2.1 but have no Leap key, so they stay
unmapped.

Verified: typing `Hi(1)<2>;=+-*/,.:?!@#$%&'_"Z` into an `INPUT` returned
exactly that string (`LEN` 28). The on-screen TSRun keyboard (`#ts-keyboard`)
was removed from `ide.html`.

---

## Display and zoom (`ide.js`, "Display zoom")

TSRun draws a 320×240 frame (256×192 screen plus border). It is always scaled by
a **whole number of device pixels**: a fractional scale gave some pixel columns
1 and others 2 display pixels, which made text uneven and thin. A zoom control
"− 2× +" in the TS2068 Display panel header picks 1×, 2× or 3×. The emulator
panel widens to fit, the editor takes the remaining width and the debugger is
340 px (it shrinks to 240). The zoom drops automatically when the window is too
narrow; the default is 2× when the window is at least 1500 px wide; the choice
is remembered in `localStorage` (`leap-ide.zoom`). HiDPI and fractional
`devicePixelRatio` are handled. The CRT filter is off (the emulator API has
`setCrt(on)`, there is no UI for it). Leap's own font has 1-pixel strokes, so
1× looks light by nature.

---

## CodeMirror 6 Integration

CM6 ships as ESM modules; load them with an `importmap` from jsDelivr (no
bundler). The map in `ide.html` is authoritative; it currently is:

```html
<script type="importmap">
{
  "imports": {
    "@codemirror/state":        "https://cdn.jsdelivr.net/npm/@codemirror/state@6.4.1/dist/index.js",
    "@codemirror/view":         "https://cdn.jsdelivr.net/npm/@codemirror/view@6.34.3/dist/index.js",
    "@codemirror/language":     "https://cdn.jsdelivr.net/npm/@codemirror/language@6.10.3/dist/index.js",
    "@codemirror/commands":     "https://cdn.jsdelivr.net/npm/@codemirror/commands@6.7.1/dist/index.js",
    "@codemirror/autocomplete": "https://cdn.jsdelivr.net/npm/@codemirror/autocomplete@6.18.3/dist/index.js",
    "@codemirror/lint":         "https://cdn.jsdelivr.net/npm/@codemirror/lint@6.8.2/dist/index.js",
    "@codemirror/search":       "https://cdn.jsdelivr.net/npm/@codemirror/search@6.5.8/dist/index.js",
    "@lezer/highlight":         "https://cdn.jsdelivr.net/npm/@lezer/highlight@1.2.1/dist/index.js",
    "@lezer/common":            "https://cdn.jsdelivr.net/npm/@lezer/common@1.2.3/dist/index.js",
    "@lezer/lr":                "https://cdn.jsdelivr.net/npm/@lezer/lr@1.4.2/dist/index.js",
    "style-mod":                "https://cdn.jsdelivr.net/npm/style-mod@4.1.2/src/style-mod.js",
    "w3c-keyname":              "https://cdn.jsdelivr.net/npm/w3c-keyname@2.2.8/index.js",
    "crelt":                    "https://cdn.jsdelivr.net/npm/crelt@1.0.6/index.js"
  }
}
</script>
<script type="module" src="src/editor.js"></script>
```

Notes: `style-mod`'s entry is `src/style-mod.js` (not `dist/`); `@lezer/lr` is
required by `@codemirror/language`; `@codemirror/lint` is needed for the
the Phase 5 diagnostics; `@codemirror/search` is the find / replace panel.

### Keyword data (generated)

`src/lang/basic/leap-keywords.js` is **generated; never hand-edit it**:

```
tools/gen-leap-keywords.py <2068-Leap checkout> <git ref> > src/lang/basic/leap-keywords.js
```

It reads `docs/manual/03_keywords.md` at that ref (currently `v2.1.0-emu.1`) and
emits `LEAP_KEYWORD_ENTRIES`: 100 entries, each `{kind, package, syntax, forms[],
desc, example}`. `kind` is function / statement / operator / command / part of;
`package` is `null` or the package name; `desc` is the first paragraph (at most
420 characters); `example` is the first basic example (at most 6 lines). The
100 entries are unchanged in content between 2.0.2 and 2.1. For the next
release, rerun it at its tag.

### Language mode and editor (Phase 2 — done)

The language mode is split so Node can import the pure half.
**`src/lang/basic/leap-words.js`** (no CodeMirror) holds `LEAP_WORDS`,
`NOT_IN_V2`, `keywordEntry`, `scanSymbols`, `LEAP_PACKAGES` and `packagesUsed`;
**`src/lang/basic/leap-lang.js`** (imports CodeMirror, so Node cannot load it)
re-exports them and implements the language mode with `@codemirror/language`
`StreamLanguage` (simpler than a Lezer grammar here). Between them they export
`leapLanguage`, `leapHighlight`, `LEAP_WORDS` (Map word -> `{cls, entry}`), `NOT_IN_V2`,
`keywordEntry(word)` (`DEF` -> `DEF FN`, `EXIT` -> `EXIT FOR`),
`keywordTokens(lineText)` (`[{from, to, text}]` keyword tokens on one line,
same lexer; used by auto-caps; built on `lineTokens`),
`lineTokens(lineText)` (every token with its type and `atStart`),
`nameTokens(lineText)` (names with `kind` label / routine / variable and a `def`
flag), `blockStructure(lines)` (`{blocks, depth, dedent}`: `PROC` … `ENDP`,
`IF` … [`ELSE`] … `ENDIF`, `FOR` … `NEXT`; `IF cond THEN GOTO label` is not a
block), `blockIndent(structure, line, text)` (labels at column 0) and
`scanSymbols(text)` (PROCs, DEF FNs, labels and variables with line numbers;
`vars` is a `Map` name -> first line; used by the Phase 7 Symbols tab).
`LEAP_KEYWORDS` and `LEAP_HELP` no
longer exist.

Identifiers are a letter then letters/digits with an optional trailing `$`; no
underscore. Matching is whole-word (`tomato` is not `TO`). Token classes:

| Token | Colour / style |
|-------|----------------|
| Statements and their parts | amber, bold |
| Word operators `AND` `OR` `NOT` | amber |
| Package statements (`CIRCLE` etc.) | orange, bold |
| Built-in functions | cyan |
| Strings | green |
| Numbers (no hex, no exponent) | blue |
| `REM` text | grey italic; `REM` runs to end of line including `:`; `'` is not a comment |
| Label definitions (`name:` at line start) and label references after `GOTO` | coral italic |
| `PROC` names after `PROC` (definition) and after `CALL` / `FN` | lavender |
| Variables | light grey |
| Invalid | red, wavy underline |

Invalid covers the commands (`RUN` `LIST` `NEW` `SAVE` `LOAD` `VERIFY` `ALL`
`ARRAY` `EXT`) anywhere, and the `NOT_IN_V2` words (`LET` `GOSUB` `RETURN`
`DRAW` `DATA` `READ` `RESTORE` `COPY` `ELSEIF` `CONTINUE` `RANDOMIZE`) only at the start of a statement when not followed by `=` or `(`: V2 does
not reserve them, so `data = 5` is a valid assignment. The toggle-comment token
is `REM `.

**`src/editor.js`** is the language-neutral editor: it creates the `EditorView`,
the breakpoint gutter, find / replace, the buttons and the theme, and holds the
active language's CodeMirror extensions in a `Compartment`, swapped by
`setLanguage(id)` (the line-limit ruler follows the profile's `lineLimit`).
**`src/lang/basic/editor.js`** is BASIC's half (listed in `src/lang/editors.js`):
autocomplete, hover help, auto-caps, folding, indent, Tidy, block match, go to
definition and rename, all described below. `src/editor.js` exposes
`window.leapEditor` (`language`, `starter`, `setLanguage(id)`, `getSource()`,
`setSource(text, {fresh})`, `setDiagnostics()`, `onChange(fn)`, `focus()`,
`undo()`, `redo()`, `onHistoryChanged(fn)`, `copy()`, `cut()`, `paste()`,
`find({replace})`, `tidy()`, `goToDefinition()`, `rename()`, `onMessage(fn)`,
`setCursor(line, col)`; `fresh: true` starts a new document with its own undo
history and the breakpoints cleared, used by New and Open). `setSource(text,
{fresh: true})` dispatches selection anchor 0 with the theme reconfigure right
after `view.setState()`: Chrome's EditContext otherwise kept the old cursor, and
the next keystroke past the new text's end threw "Invalid change range" and was
lost (New / Open while the editor had focus).

- **Autocomplete:** all manual keywords except commands, with the first form as
  the detail and the full help as the info panel; built-in functions insert
  `NAME(`; snippets for `IF` … `ENDIF`, `IF` … `ELSE` … `ENDIF`, `FOR` … `NEXT`,
  `PROC name(p):` … `ENDP` and `DEF FN`; the program's variables. Context: after
  `CALL` only `PROC` names (detail `PROC (param) · line N`), after `GOTO` only
  labels, after `FN` only `DEF FN` names.
- **Hover help:** a keyword shows every form, its kind (package statements say
  the IDE loads the package on Run, and `LOAD "NAME" EXT` on a real TS2068),
  the description and the example. Commands say they
  are typed at the Leap prompt; `NOT_IN_V2` words say "X is not in Leap V2
  (language reference §12)"; `PROC` / `DEF FN` / label names show their
  definition line. Built with DOM nodes and `textContent` (no `innerHTML`).
- **Auto-caps:** keywords are upper-cased automatically (no option). After
  typing, Enter or paste (`input*` user events), keyword tokens touched by the
  edit (statements, built-in functions, `AND` `OR` `NOT`, package statements)
  become upper case (`print` -> `PRINT`). Names, strings, `REM` text, commands
  and `NOT_IN_V2` words stay as typed (the latter keep their red marking). A
  word containing the cursor is left until finished; whole words only (`tomato`
  stays). It is a separate history step (`isolateHistory` "full", user event
  `autocaps`), so Ctrl+Z right after restores what was typed; `setSource()` does
  not auto-caps. Deliberately not a caps lock: Leap stores lines verbatim and
  prints strings as written, so full caps would change output
  (`PRINT "Hello"` -> `"HELLO"`). Typing into a running program (`INPUT`) is
  data and unaffected.
- **Find and replace, undo / clipboard buttons:** `@codemirror/search` gives the
  panel (`search({ top: true })`, `searchKeymap`, plus `Mod-h`, which opens it on
  the replace field); it is themed with the `ide.css` variables in
  `leapThemeSpec`. A replacement is an `input` user event, so auto-caps applies
  to it as to typing. The editor panel header has buttons Undo, Redo | Cut,
  Copy, Paste | Find, then Lint (class `edbtn`; `ide.js` prevents mousedown on
  them so the editor keeps focus). `onHistoryChanged(fn)` is called with the
  `{undo, redo}` depths when they change, once at registration and after
  `setSource(..., {fresh: true})`; Undo / Redo are disabled when there is
  nothing to undo / redo (`.phbtn:disabled`). `copy()`, `cut()` and `paste()`
  are async and go through `navigator.clipboard`; they resolve to false if the
  browser refuses, and the status bar then says "The browser did not allow the
  clipboard: use Ctrl+X in the editor" (or Ctrl+C / Ctrl+V). With nothing
  selected, copy and cut take the cursor's whole line, as CodeMirror's Ctrl+C /
  Ctrl+X do. `paste()` is an `input.paste` event, so auto-caps applies. The
  global keydown in `ide.js` opens find (Ctrl+F) and replace (Ctrl+H) from
  anywhere except a text field (input / textarea), unless the editor already
  handled the key. The editor title ellipsises before the buttons shrink.

**Structure tools** (in `src/lang/basic/editor.js`, built on `blockStructure` /
`blockIndent` / `nameTokens` in `src/lang/basic/leap-lang.js`):

- **Folding:** a `foldService` over the blocks, with a fold gutter (▾ / ▸);
  Ctrl+Shift+[ folds and Ctrl+Shift+] unfolds the block at the cursor.
- **Auto-indent:** Enter indents by the block depth (`indentService` at
  `Prec.high`, 2 spaces). Typing `ENDIF`, `ENDP`, `NEXT` or `ELSE` dedents the
  line (`indentOnInput`).
- **Tidy** (button "Tidy" in the editor header, Shift+Alt+F): re-indents the
  whole program by its blocks, labels at column 0, as one undo step. Leap stores
  indentation verbatim, so it counts towards the line length and the pool.
- **Block match:** the keywords of the block at the cursor (`PROC` / `ENDP`,
  `IF` / `ELSE` / `ENDIF`, `FOR` / `NEXT`) are highlighted (`.cm-block-match`).
- **Go to definition** (F12, Ctrl/Cmd+click): to the `PROC`, `FN` or label
  definition line, or a variable's first assignment (from `scanSymbols`).
- **Rename** (F2, `window.prompt`): the name at the cursor everywhere, one undo
  step. Case-insensitive, same kind only. It refuses a non-name, more than 31
  characters, a keyword, a change of the trailing `$` and a clash with another
  name; the reason goes to the status bar through `onMessage`.
- **Line limit:** a ruler at column 127 (a CSS gradient on `.cm-content`) and
  text past column 127 marked (`.cm-too-long`).

Verified in headless Chromium.

---

## Debugger (Phase 3 — done, `src/lang/basic/leap-debug.js` + `src/debugger.js`)

Verified in headless Chromium and Node against the real 2.0.2 ROM; all Node
checks also pass on 2.1.0-emu.1 (after the dispatch change below). The program
is bytecode run by a VM, so everything is read from the ROM's own state, not
from Z80 `CALL`/`RET`.

**Line table.** Leap bytecode carries no line numbers, so the table is built by
watching the compiler. At `COMPILE_STATEMENT_LIST.loop` (reached once per
statement) `LEX_LINE & $7FFF` is the store line and `EMIT_PTR` is the address
of the statement's first bytecode. Statements whose `TOK_TYPE` is colon or EOF
are skipped, and only the stored program counts (`V2_RUN_IS_STORED` = 1).
Code is emitted in source order, so the line of an address is the last
statement start at or below it. Every VM instruction starts at the opcode
fetch, `VM_RUN.next` (ROM-table field `vmNext`), with `VM_IP` (`$B600`) at the
opcode; `vmInstruction` in `src/lang/basic/leap-debug.js` hooks it. A nonzero `VM_HALTED`
means the VM is stopping. In 2.1 handlers end with `jp (iy)` to `.next`; only
taken jumps, calls (`PROC`, `FN`) and waits go through `VM_RUN.loop`, which is
now just the BREAK poll (`VM_HALTED` check) before `.next`. In 2.0.2 every
instruction went through `.loop` (there `vmNext` equals `vmLoop`, `$1161`).
Consequence: in 2.1 the ROM notices BREAK only at a taken jump, call or wait,
so "Stopped (BREAK) at line N" names the line that jump went to. "Stop while
paused" (`haltVm`) sets `VM_ERROR_CODE` 66 and `VM_HALTED` 1 and, if the PC is
at `.next`, moves it back to `.loop`, so the halt takes effect before another
instruction runs. These hooks are in the HOME ROM.

**Emulator hook** (`src/emulator.js`): `setWatch(fn)` runs `fn(machine)` before
every Z80 instruction while set (returning true pauses before it); `pause()`,
`resume()`, `stepInstruction()` (one Z80 instruction while paused) and the
`paused` getter. `run()` and `stop()` leave a pause. With a watch installed the
frame loop single-steps (`runZ80` budget 1), so it is slower than a free run.
The `'paused'` state is reported through `onEmulatorState`.

**Debug adapter.** `src/debugger.js` knows no language: it works through the
profile's `createDebugAdapter(rom)` (`debug.setAdapter()` on a language switch).
The adapter has `reset`, `observe(m)` (called before each instruction while
watched), `position(m)`, `isStart`, `lineOf`, `breakPositions`, `stopLine`,
`halt`, `variables`, `callStack` and `labels`, and optionally `version()` and
`live` (see "Languages"); `reset(job)` gets the run's job. BASIC's, in
`src/lang/basic/profile.js`, wraps the line table, `vmInstruction`, `haltVm`,
`readVariables` and `readCallStack` of `src/lang/basic/leap-debug.js`. Registers,
memory, Z80 breakpoints and the breakpoint list are generic.

**Controller** (`createDebugger` in `src/debugger.js`): `beginRun(job)` resets
the line table (passing the profile's job to the adapter) and installs the watch, `endRun()` removes it. Breakpoints are
editor lines (the gutter), mapped to store lines through the last run
(`toStoreLine` / `toEditorLine` in `ide.js`; blank lines are not stored). A
breakpoint on a line without code (label, `REM`, blank) stops at the next line
with code. A breakpoint on a `PROC` line also stops at the procedure's entry:
its code starts with a jump over the body and calls enter 3 bytes later, at
`PARAM_BIND`. Step runs to the next statement start (it steps into `PROC`s;
`ENDP` gets a stop). Pause stops at the next statement. Breakpoints can be
added while running. Stop while paused ends the program as BREAK does
(`VM_ERROR_CODE` 66, `VM_HALTED` 1), so its screen stays up.

**Forth and Leap-C adapters** (the descriptions above are BASIC's; see
"Leap-Forth" and "Leap-C" for the details). Both use the same controller; they
differ from BASIC's in how the line table comes about and what the panel
shows:

| | BASIC | Forth (`forth-debug.js`) | Leap-C (`leapc-debug.js`) |
|---|---|---|---|
| Line table | built by the compiler, once per run, before the VM starts | built **while the program is sent** (Forth compiles as it reads); grows during the run, `version()` makes the controller place breakpoints again | built by the compiler's hooks, plus `RUN_FNLINES` at `RT_RUN` |
| Position | VM instruction (`VM_IP`, `vmNext`) | a record's address, or `TOP` (`0x10000`) + n for line n being sent | a statement's code address (native Z80) |
| Step | next statement | next token (word), and each line sent | next statement, into called functions |
| Variables section | "Variables" | "Stacks and words": data and float stack, the session's words with values; `live`, also between runs | "Globals" (copied at `RT_RUN`); read from `m.ram` |
| Call stack | VM frames | user words on the return stack, then the line sent | the `IX` frame chain |
| Run-time error line | `stopLine` via `VM_IP` | none (Run stops at the error line, which the driver names) | `stopLine` via `RT_ERRPC` |
| Stop while paused | sets VM error 66 | BREAK | BREAK |

Forth's breakpoints apply only to the words the **latest Run or Send** defined
(its records are reset by each); Leap-C's debugger shows globals only (no
locals yet).

**Panel** (`#debugger-mount`; every value HTML-escaped, since strings can hold
any character):

- **Registers and flags** from `machine.cpu` (`a`, `f`, … `xh`, `xl`, `yh`,
  `yl`, `sp`, `pc`): AF, AF′, BC, BC′, DE, DE′, HL, HL′, IX, IY, SP, PC and
  C N P/V H Z S.
- **Variables** by name from the compile symbol table at `SYM_BASE_V`: records
  `[len][kind][namelen][index][name][extra]`, kinds 0 number, 1 string, 2 array,
  3 string array, 4 label / `PROC` / `DEF FN`. Numbers are int16 or 5-byte
  Sinclair calculator floats (`RT_FLOATTAB`), strings are 32-byte slots, arrays
  show their first 8 elements. Variables stay visible after a run ends (Leap
  keeps the session).
- **Call stack** from `VM_CSP` up to `VARS_START`, frames tagged FOR (12 bytes,
  `[1][var][limit 5][step 5]`), CALL (3 bytes, `[2][return LE16]`) and PARAM
  (9 bytes, `[3]…`). A `PROC` is named by matching the CALL operand (an offset
  from `VM_CODE_BASE`) with the kind-4 symbol records. Shown innermost first:
  the current `PROC` (or the main program) and line, "called from line N",
  "FOR i".
- **Breakpoints** list; **memory inspector**: a 256-byte hex dump (8 bytes a
  row, 32 rows, to fit the debugger column) with an editable start address. Clicking a breakpoint or stack line scrolls the
  editor there. The panel refreshes every 300 ms while a program runs.

**Z80 breakpoints** (section "Z80 Breakpoints" of the panel; Z80 level, not
Leap statements): a hex address field (`F400`, `$F400`, `0xF400` and `#F400`
are accepted; `parseHexAddr` is exported), Add, and a list with ✕ to remove.
The watch compares the PC with the list after `table.observe`; the PC alone,
whatever ROM, cartridge or RAM is paged in there. The status bar reads "Paused
at Z80 breakpoint $XXXX at line N" (the line is from `VM_IP` when the PC is not
at an instruction start). `pausedHere()` returns `{line, z80}`. **Step
instruction** (enabled while paused) calls `emulator.stepInstruction()`, then
refreshes the panel; `ide.js` reports "Paused at $XXXX (one Z80 instruction)"
through `opts.onInstructionStep`. The list is kept in `localStorage`, key
`leap-ide.z80bp`.

**Editor and toolbar.** The execution line is highlighted with an arrow in the
breakpoint gutter (a coral arrow when it is on a breakpoint line).
`window.leapEditor` gained `toggleBreakpoint(line)`, `onBreakpointsChanged(fn)`
and `setExecutionLine(line|null)`. The toolbar has Run, Stop, Pause/Continue
(F8) and Step (F10); the status bar reads "Paused at line N".
A toggle on a line that has a breakpoint removes it (gutter click or
`toggleBreakpoint`). Until `0b419d3` it never did: the state field tested a
`RangeCursor`'s nonexistent `.done`, so every toggle added a duplicate; it now
looks the position up with `set.between`.

**Known limits.**

- `FOR` frames carry no line, so loops show without one.
- While a package statement runs, the EXROM is paged out: do not read `$C000`
  and up then.
- Z80 breakpoints act only while a program runs: the watch is installed only
  then.

---

## Export Formats (Phase 6 — TAP and DCK done and verified)

`src/lang/basic/export.js` (tape) and `src/lang/basic/cartridge.js` (cartridge) hold pure builders
returning `Uint8Array`s. Neither touches the DOM, so Node can import them.

### Tape (done, verified) — `buildTAP`, toolbar "⬇ TAP"
Exactly what Leap's own `SAVE "name"` writes (`V2_SAVE` -> `STORAGE_SAVE` ->
`STORAGE_SEND_BLOCK`, a port of the stock SA-BYTES):

- **Header block:** flag `$00`, then 17 bytes: type 0; name, 10 bytes
  space-padded, as typed (`LOAD "name"` is a case-sensitive exact match; up to
  10 printable ASCII characters, see `checkTapeName`); length of the line store
  LE16; **Leap's tape format word** `V2_FORMAT_WORD` (`$8101` in 2.0.2 and 2.1) in the
  stock "autostart" field; program length LE16 (= the length for a plain
  program). `LOAD` refuses a tape without the format word. It is a ROM-table
  field, `tapeFormatWord` in `src/lang/basic/leap-roms.js`, generated by
  `tools/leap-rom-entry.py`.
- **Data block:** flag `$FF`, then the line store exactly as in RAM
  (`encodeLineStore`).
- Each block ends with the XOR of its flag and bytes. The `.tap` file is each
  block prefixed with its LE16 length. Leap uses the stock ROM pulse timings,
  which is what `.tap` assumes.
- **V2 has no autorun:** on the TS2068 type `LOAD ""` (or `LOAD "name"`), then
  `RUN`.

Verified byte for byte against Leap's real `SAVE` (capturing
`STORAGE_SEND_BLOCK` in Node; on 2.0.2 and on 2.1.0-emu.1, `V2_SAVE` `$D702`,
`STORAGE_SEND_BLOCK` `$C3F1` there), and loaded back by Leap's real `LOAD` with the
program intact; the browser download is identical. In TSRun this needs the
tape-loading fix (TSRun section above, in the submodule pin). The button (`exportTape` in
`ide.js`; the tape itself comes from the attached profile's `exportTape`) prompts for the tape name (default: the file name, cut to 10
characters) and reports `Saved X.tap: on the TS2068, LOAD "X" then RUN`
(for a program that uses a package: `LOAD "NAME" EXT, then LOAD "X" then RUN`).

### DCK (Timex dock cartridge) — done, verified; `src/lang/basic/cartridge.js`, toolbar "⬇ DCK"
The owner approved this on 2026-10-28. Leap 2.0.2 and 2.1.0-emu.1 never look at
the dock, and their cold start clears RAM, so a cartridge that runs on a
**stock TS2068** needs Leap's *cartridge build* (`make cart`, `-DV2_CARTRIDGE`):
a runtime-only version with no editor. Its source is `cartridge-build/` in this repo: `leap.patch` on Leap's
`v2.1.0-emu.1` tag, applied and built by `setup.sh` into `cartridge-build/leap/`
(ignored); the details are in `cartridge-build/Docs/CARTRIDGE_STATUS.md`.
The original spec is [`docs/LEAP_CARTRIDGE_BUILD.md`](docs/LEAP_CARTRIDGE_BUILD.md).
The release's `roms/leap_v2_exrom.dck` is not this: it is only the EXROM as a
cartridge for EightyOne 1.41.

**Images.** `cartridge/2.1.0-emu.1/` holds `leap_v2_cart_home.bin` (16384 bytes,
SHA-256 `307b0616…`) and `leap_v2_cart_exrom.bin` (8192 bytes, SHA-256
`c54be09c…`) plus a README (before packages: `fb16d609…` / `df50142d…`). Every release symbol keeps its address in the
cartridge build, so the IDE's 2.1.0-emu.1 checker produces exactly the
bytecode the cartridge runs.

**`src/lang/basic/cartridge.js`** (pure, no DOM or CodeMirror):
`romIdentity(home, exrom)` (CRC-16/CCITT, polynomial `$1021`, initial value
`$FFFF`, over HOME and then EXROM), `cartIdentity(cartHome)`,
`cartFormat(cartHome)` (the program image format the cartridge HOME accepts,
read from the format word of its `LEAPPROG` signature),
`buildProgramImage({bytecode, symCounts, identity, pkg, format})` (writes
the format the cartridge accepts; refuses a package for format 1),
`buildCartridge({home, exrom, program})` returning `{dck, bin}`,
`pagingWrites(text)` (`OUT` statements with a literal port whose low byte is
244/`$F4` or 255/`$FF`), and the constants `CHUNK`, `IMAGE_FORMAT` (2), `MAX_BYTECODE` (4011), `MAX_PACKAGE` (1024) and
`SYM_COUNTS_SIZE` (5).

**Layout.** LROS cartridge. DOCK chunks 0-1 are the cartridge HOME, chunk 3 is
the program image, chunk 6 is the cartridge EXROM. The DCK header is
`00 02 02 00 02 00 00 02 00` (bank 0 = DOCK; chunks 0, 1, 3 and 6 are ROM (2),
the other chunks are absent (0)). The flat `.bin` is 64 KB with the chunks in address order; an
absent chunk is `$FF`.

**Program image** at `$6000`, format 2, 19-byte header: `"LEAPPROG"`, format
LE16 = 2, identity LE16, bytecode length LE16 (1 to 4011), `SYM_COUNTS` (5
bytes), then the bytecode, then the package length LE16 (0 = none, at most
1024) and the package image. The identity for 2.1.0-emu.1 is `$E0A5` (unchanged by packages). The
cartridge refuses any other signature, format, identity or length and shows
`NO PROGRAM`. At run time it uses HSR (port `$F4`) = `$43` and DECR (port
`$FF`) bit 7 = 0. The stock ROM starts it after about 2 s (103 frames). After
the program ends, a key restarts it from cold.

**Packages on the cartridge.** `CART_LOAD` (HOME, `rom/v2_cart_home.asm` in
`leap.patch`) copies the package to `EXTENSION_MODULE_BASE` (`$F400`) and sets
`V2_PACKAGE_LEN` (`$BE82`; `CART_PACKAGE_LEN` in `include/v2_cart.inc`, ASSERTed
equal in `exrom_v2_cart.asm`). `CART_RUN` (EXROM) calls the install entry at
`$F400` when the length is nonzero, as `LOAD "NAME" EXT` does; CF from the
install gives `NO PROGRAM`. The cold start's `EXT2_CLEAR_ALL` leaves the
registry as on the IDE's checker (which does `EXT2_CLEAR_ALL` and then the
install before compiling), so the bytecode's package calls, with slot and
generation baked in, match. Free space left in the cartridge images: HOME 174
bytes, EXROM 63. `leap.patch` is two commits on the tag; refresh it with
`git -C leap format-patch --stdout v2.1.0-emu.1..HEAD > leap.patch`. A fresh
clone from GitHub plus `setup.sh` reproduces both images byte for byte.
`cartridge-build/tools/leap2cart.mjs` takes `--package PKG.bin`.

**Checker.** `compile(store, symCountsSize, pkg)` in `src/lang/basic/leap-check.js` runs
`check(store, pkg)` (the package is installed first, as in "Packages") and, on code 0, also returns `bytecode`
(RAM from `VM_CODE_BASE` to `EMIT_PTR`) and `symCounts` (from `SYM_COUNTS`).
`src/lang/basic/leap-roms.js`: the 2.1.0-emu.1 entry has `symCounts: 0xB800` and
`cartridgeDir: 'cartridge/2.1.0-emu.1/'`; the 2.0.2 entry has neither, so
export says "There is no cartridge build for Leap 2.0.2-emu.1".
`tools/leap-rom-entry.py` emits `symCounts` and a `cartridgeDir` line (with a
comment to leave it out when a release has no cartridge build).

**The button** (`exportCartridge` in `ide.js`, title "Save the program as a
cartridge (.dck) that runs on a stock TS2068"; steps 1-7 are the profile's
`attach().buildCartridge(text, {confirm, prompt})` in `src/lang/basic/profile.js` (BASIC ignores `prompt`; Forth's start-word question uses it, see "Leap-Forth"),
which returns `{dck, bin, summary}`, `{error, line0?}` or `null` when the user
declines), in order:
1. Storage problems or an empty program: error.
2. No `cartridgeDir` for the loaded ROM: error.
3. Package statements: `packageFor` (one package at a time, the same message
   as Run). A package is refused if the cartridge build's format
   (`cartFormat`) is below 2.
4. Pool size check.
5. Compiles on the checker machine. A compile error marks the line and reads
   "Compile error N on line L: fix it first".
6. Fetches the cartridge images once (`loadCartridgeImages`) and refuses if
   `romIdentity` of the loaded ROMs differs from `cartIdentity` of the
   cartridge HOME.
7. An `OUT` to port 244 or 255 (literal) asks for confirmation ("... can switch
   Leap itself out ... Make the cartridge anyway?").
8. Prompts for a file name, default `<name>.dck`. A name ending in `.bin`
   downloads the flat 64 KB image for a cartridge board instead.
9. Status: "Saved X.dck (N bytes of bytecode): it runs on a stock TS2068 from
   the dock slot"; for a program with a package, "Saved X.dck (N bytes of
   bytecode and the SHAPES package): ...".

`buildProgramCartridge` in `ide.js` calls `buildCartridge` (and says "There is
no cartridge build for <language> yet" for a profile without one); it is shared
with "▶ Test DCK".

Not supported: tape / Array Store, returning to an editor.

### Cartridge test — "▶ Test DCK" and Open `.dck`
The cartridge runs in the IDE's own emulator on the **stock** TS2068 ROMs, as
on a real TS2068 with the cartridge in the dock, without downloading anything.

- **▶ Test DCK** (`testProgramCartridge` in `ide.js`): the same build and
  checks as ⬇ DCK (`buildProgramCartridge`), then `startCartridgeTest`.
- **Open** accepts a `.dck` (any cartridge, e.g. one from
  `cartridge-build/tools/leap2cart.mjs`) and tests it; the editor's program is
  not touched, so the "discard unsaved changes?" question now comes after the
  file is chosen, and only for files that replace the program.
- **Emulator** (`testCartridge(dck, symbols)` in `src/emulator.js`; `symbols` is the keyboard table of the cartridge's own language, from the profile's `ownsCartridge`: a Forth cartridge opened from BASIC types as Forth does): fetches
  `tsrun/roms/ts2068-0.rom` / `ts2068-1.rom` once, puts them in the machine,
  `insertDock`, reset; state `'cartridge'`. The stock ROM starts the cartridge
  after about 2 s. A dock image TSRun cannot read is refused and the Leap ROMs
  stay. In this mode the frame loop does not look for Leap's key wait, keys
  always reach the machine (the cartridge has no editor; a key after the end
  restarts the program, as on hardware), and it single-steps only for the
  debugger. `get cartridge` tells the mode.
- **Leaving:** Stop (F6), Reset or Run eject the dock, put the Leap ROMs back
  and reset (`leaveCartridge`); Run then waits for Leap's boot (pending stage
  `'reset'`) and injects as usual.
- **Display and status:** the caption reads "Stock TS2068 + DCK" and
  "DCK: name"; the status "Cartridge test: X.dck on a stock TS2068. Stop (F6)
  or Run goes back to Leap".
- **Debugger** (`beginCartridge` in `src/debugger.js`): registers, memory, Z80
  breakpoints and Pause / Continue work (the watch is installed only while
  there are Z80 breakpoints); Step, Leap breakpoints, variables and call stack
  are off ("Not shown in a cartridge test").
- Note: `$7800`-`$7FFF` is RAM Leap leaves alone, and its cold start does not
  clear it, so a value POKEd there survives going back to Leap.

**Verification.** `tests/rom-checks.mjs` section 7 runs the exported cartridge
on a stock TS2068 (`tsrun/roms/ts2068-0.rom`, `ts2068-1.rom`, `insertDock`) to
the end (see "Tests"). The IDE's DCK was also byte-identical to the
CLI `cartridge-build/tools/leap2cart.mjs`'s for two programs. With those tools, 695 corpus programs give the same screen as `RUN` on the release ROMs
(5 expected differences, 0 failures), and ZEsarUX 13.0 with the stock ROM gives
byte-identical screens to TSRun; so does Fuse 1.9.1 for two cartridges
downloaded from the IDE in a browser. The manual's 33 `pkg=` examples
(`build/corpus/package/`, written by `tests/extract_corpus.py`) give the same
screen from the cartridge as `RUN` with that package installed (32 pass, 1
expected difference, `mem.pkg.1.bas`: `FREE()` is larger; 0 fail). Not tried:
real hardware.

Container reference (jon0x0/AISkill_TS2068, cartridge development skill): a DCK
is a 9-byte header (bank id + 8 chunk descriptors: 0 absent, 1 RAM, 2 ROM,
3 initialised RAM) followed by the 8 KB images; AROS/LROS headers. TSRun's
`dock.js` accepts banks 0 (DOCK), 254 (EXROM), 255 (HOME).

---

## Files (auto-save, New / Open / Save, share links — done, `src/files.js` + `ide.js`)

`src/files.js` has no DOM or CodeMirror, so Node can import it; the toolbar
wiring is the "Files" section of `ide.js`.

- **Auto-save.** The program, its file name and the text as last saved or
  opened (`savedText`) are stored in the browser's `localStorage`, one key per
  language, `leap-ide.document.<id>` (`loadAutosave(lang)` / `storeAutosave(doc,
  lang)`, which swallow storage errors; see "Languages" for the migration of the
  old `leap-ide.document` key to `.basic`), 500 ms after each change (`leapEditor.onChange`) and restored at
  start-up, so a reload loses nothing.
- **Toolbar**, next to the file name: **New** (asks before discarding unsaved
  changes), **Open** (`.leap` `.txt` `.bas` `.tap` `.dck`; Ctrl+O), **Save** (downloads
  a text file to the browser's download folder; asks for a name the first time;
  Ctrl+S). Clicking the name renames. A `•` shows while the text differs from
  `savedText`. New and Open start a fresh document:
  `leapEditor.setSource(text, {fresh: true})` gives it its own undo history and
  clears the breakpoints. Line endings are normalised to `\n` (`normalizeText`).
- **Opening a Leap `.tap`** (written by Leap's `SAVE` or the IDE's TAP export)
  reads the first program back into source (`tapeToText`): a header with type 0
  and a `$81xx` format word, then the line-store records (LE16 length + 1, the
  text, `$0D`). A stock Sinclair/Timex BASIC tape is refused with a message,
  checksum errors are warned about, and a tape opened this way is marked unsaved
  (it is not a text file yet).
- Save and TAP export are separate: Save keeps the source as text; "⬇ TAP"
  builds the tape a TS2068 loads.
- **Share links** (`encodeShare` / `decodeShare` in `src/files.js`; "Share links"
  section of `ide.js`, `shareProgram`, `openSharedLink`). The link carries the
  program in the URL fragment: `v1=<UTF-8 text, deflate-raw via
  CompressionStream, base64url>&name=<file name>[&lang=<id>]` (`encodeShare(text,
  name, lang)` returns it without the `#`; `&lang=` is left out for `basic`). `decodeShare(hash)` returns `{text, name, lang}` (`lang` defaults to `basic`), or
  `null` when the fragment has no `v1`, and throws "The shared link is damaged
  or cut short…" when it cannot be read. The fragment is never sent to a
  server, so nothing is uploaded and GitHub Pages needs no setup.
  - **Share** (toolbar, after Save) builds the page's address without its hash
    plus `#` and the fragment, copies it with `navigator.clipboard` (falls back
    to `window.prompt` showing the link), and says `Link copied (N characters): …`;
    an empty program says `Nothing to share`.
  - `openSharedLink` runs at start-up and on `hashchange` (a link pasted into
    the same tab). It decodes, removes the fragment from the address bar with
    `history.replaceState` (so a reload keeps later edits), and does nothing if
    the text equals the editor's. Otherwise, with unsaved changes it asks
    `confirmDiscard()` (declined: `Kept your program; the shared one was not
    opened`), then opens the program as a new unsaved document named after the
    link's `name` (`withExtension`, default `shared.leap`; the link's `lang` switches
    language first, `switchLanguage`), auto-saves, and says
    `Opened a shared program (X): press Run (F5)`. During boot that message is
    kept and shown instead of `Ready` (`readyMessage`).
  - Size: all 12 examples together (2674 characters) give a 1740-character
    fragment. The Help tip mentions Share.
- **Examples menu** (`src/lang/basic/examples.js`, toolbar "Examples ▾" after Open).
  `EXAMPLES` is a list of `{id, title, about, package?, input?, text}`, 12
  programs, mostly the manual's own examples: `hello`, `ball`, `lines`, `guess`
  (`INPUT`), `primes`, `binary`, `caesar`, `scale` (`BEEP`), `udg`, `circles`
  (shapes), `chart` (graphics), `ship` (sprite). The module has no DOM. The
  button opens `#examples-menu` (arrow keys move, Escape and a click outside
  close it). Choosing one asks before discarding unsaved changes, then opens the
  program as a new unsaved document named `<id>.leap` with the status
  `Example "X": press Run (F5)`. `tests/rom-checks.mjs` section 3b runs every
  example on the real ROMs: each finishes with no error (`guess` stops at its
  `INPUT`).

---

## Packages (done, `src/lang/basic/profile.js`, `src/lang/basic/leap-check.js`)

Package statements (`CIRCLE`, `FILL`, `GRAB`, `MODE`, `LPRINT`, `CBEEP`, …) are
not in the ROM: on a TS2068 a program loads a package with `LOAD "NAME" EXT`
first. The IDE does that for the user, so such programs compile and run.

- **Images.** The release's six package images are in
  `packages/2.1.0-emu.1/<name>.bin` (`cbeep graphics mode printer shapes sprite`),
  copied unchanged from the release zip and checked against its `SHA256SUMS`.
  The six are byte-identical to 2.0.2's (`packages/2.0.2-emu.1/`, checked with
  `cmp`; the release notes say the shipped packages are unchanged).
  `attach()` (`src/lang/basic/profile.js`) fetches them once per language / ROM
  load, from the ROM entry's `packageDir`.
- **Which package.** `packagesUsed(text)` (`src/lang/basic/leap-words.js`; with
  `LEAP_PACKAGES`) finds package statements at the start of a statement (line
  start or after `:`), so `circle = 5` is not one; strings and `REM` text are
  ignored. Leap loads **one package at a time**, so a program that uses two is
  an error on the line of the second (`packageFor` in the attached profile). It finds package
  *statements* only. Leap 2.1 introduces package ABI 2.1 (package functions,
  floats, an error service); ABI 2.0 packages load unchanged and none of the
  shipped packages uses package functions. A future package that exports
  functions would need `packagesUsed` extended.
- **Install, as `LOAD "NAME" EXT` does (package ABI 2.0).** `driver.inject` in
  `src/lang/basic/profile.js` and `check()` in `src/lang/basic/leap-check.js` do the same thing:
  `EXT2_CLEAR_ALL`, then the image at `$F400` (`EXTENSION_MODULE_BASE`) with its
  length in `V2_PACKAGE_LEN`, then the image's install entry at `$F400`, chained
  before `V2_CLEAR_ARRAYS` on the ROM stack (`EXT2_CLEAR_ALL` returns into the
  install, which returns into `CLEAR_ARRAYS`, then the usual
  `RESET_EDIT` / `RUN_STORED` chain for Run). The editor's error check installs
  the package too, so package statements are not flagged. Verified: `CIRCLE` +
  `FILL` draw.
- **ROM-table fields** `ext2ClearAll`, `packageBase`, `packageLen`, `packageDir`
  are generated by `tools/leap-rom-entry.py`; for a new release also copy its
  package binaries to `packages/<version>/`.
- **User-visible.** TAP export's status names the `LOAD "NAME" EXT` a real
  TS2068 needs before `LOAD "name"`. Hover help on a package statement says the
  IDE loads it on Run. `FILL` runs at real TS2068 speed (a radius-40 fill takes
  a few seconds).

---

## Themes (Phase 8 — done, `ide.css` + `ide.js` "Theme")

The toolbar's ☀ / ☾ button (after Help) switches between **light** and
**dark**; every click visibly changes the theme. Until the user clicks it, the
IDE follows the system setting (`prefers-color-scheme`, live). The choice is
remembered in `localStorage` (`leap-ide.theme` = `light` | `dark`; absent =
follow the system). (A first version cycled system → light → dark; rejected:
two of the three clicks often looked like nothing happened.)

- **Every colour is a CSS variable** in `ide.css`: the dark palette on `:root`,
  the light one on `:root[data-theme="light"]`. This includes the editor: the
  CodeMirror theme (`leapThemeSpec` in `src/editor.js`) and the syntax colours
  (`leapHighlight` in `src/lang/basic/leap-lang.js`, `--syn-*` variables) use `var(...)`,
  so switching theme only changes `<html data-theme>`. Do not add hex colours
  to the JS or CSS rules; add a variable to both palettes.
- `leapEditor.setDark(bool)` swaps CodeMirror's dark/light flag (through a
  `Compartment`), which only picks CM's own defaults for the lint tooltip and
  search panel.
- A small inline script in `ide.html`'s `<head>` applies the saved theme
  before the first paint, so a light page never flashes dark. It and
  `applyTheme` in `ide.js` must agree on the key and values.
- Unchanged in both themes: the TS2068 bezel and screen, and the TS2068
  paper/ink in the UDG and Draw tools (they show what the machine shows).

## Help (done, `src/help.js`; the entries come from the profile's `help`)

"? Help" in the toolbar or F1 opens an overlay; Escape or a click outside closes
it. Everything is built with DOM nodes and `textContent`.

- **Keywords tab:** all 100 manual entries from `src/lang/basic/leap-keywords.js`, grouped
  as Statements, Functions, Operators, Package statements and Commands, with a
  search box that filters by name and description. Selecting one shows its
  forms, kind, description and example, and a link to its section of the manual
  on GitHub at the release tag (`LEAP_MANUAL_REF`; GitHub heading anchors, e.g.
  `#circle--package-shapes`).
- **Keys & tips tab:** the shortcuts (F5 Run, F6 Stop, F8 Pause/Continue, F10
  Step, Ctrl+S, Ctrl+O, Ctrl+Space completions, Ctrl+F find (Enter / F3 next,
  Shift+F3 previous), Ctrl+H replace, Ctrl+Z undo, Ctrl+Y redo (also
  Ctrl+Shift+Z), Ctrl+X / C / V cut / copy / paste, F12 / Ctrl+click go to
  definition, F2 rename, Shift+Alt+F Tidy, Ctrl+Shift+[ / ] fold / unfold, F1
  help, Escape = BREAK in the TS2068 screen) and short usage tips, among them
  that ⬇ DCK carries the package, that ▶ Test DCK / Open `.dck` run a cartridge
  on the stock ROMs, and that Z80 breakpoints pause at an address. This is the keyboard cheat-sheet of
  Phase 8.
- Nothing is hand-written per keyword: a new release regenerates
  `src/lang/basic/leap-keywords.js` and Help follows.

---

## Editor Error Checking (Phase 5 — done, `src/lang/basic/leap-check.js`)

**Design decision: the linter is the ROM's own compiler, not a
re-implementation.** The editor's errors are therefore always the errors Run
reports, for whichever Leap release is loaded; nothing in the checker changes
for 2.1 beyond its ROM entry. As in the ROM, it stops at the first error, so
the editor shows one error at a time.

**`src/lang/basic/leap-check.js`** — `createChecker(rom, images)`. A second TSRun machine,
never displayed, boots the same ROM images once to the editor key wait
(`IO_READ_KEY.wait_hit`) and snapshots RAM, CPU and ports (about 74 ms in
Node). `check(store, pkg)` restores the snapshot, writes the line store and
`PROG_END`, puts a return chain on the ROM stack (`$FF00`) and calls
`V2_CLEAR_ARRAYS` -> `V2_COMPILE_STORED` -> back into the key-wait loop. It then
reads `COMPILE_ERROR_CODE` and `LEX_LINE & $7FFF`, the failing store line
(for end-of-source errors such as an unclosed `IF` or `GOTO` to an unknown
label that is the line count). It returns `{code, line}` (`code` 0 = compiles)
or `null` if the compiler does not finish. With a package image (`pkg`) the
package is installed first, as in "Packages". No frame interrupts are delivered
and nothing is drawn. Typical check about 1 ms; a 302-line program about
120 ms. It runs on the main thread; a Web Worker is the option if that ever
matters.

`V2_COMPILE_STORED` is the ROM symbol `compileStored` in `src/lang/basic/leap-roms.js`
(`$D54F` in 2.0.2, `$D45A` in 2.1), emitted by `tools/leap-rom-entry.py`. The emulator exposes
`romImages` for the checker.

**Error text** — `src/lang/basic/leap-errors.js` is generated by
`tools/gen-leap-errors.py <2068-Leap checkout> <git ref> > src/lang/basic/leap-errors.js`
from Appendix B of the manual. It exports `LEAP_COMPILE_ERRORS` and
`LEAP_RUNTIME_ERRORS`, each code -> `{message, cause}`; codes such as
"13, 14, 15" and "12 to 14" are expanded, and a code listed more than once
keeps the first message and joins the causes. Never edit it by hand; rerun it
for the next release (last run at `v2.1.0-emu.1`; `LEAP_MANUAL_REF` in
`src/lang/basic/leap-keywords.js` follows, so Help links go to the 2.1 manual). `describeError`
(`src/lang/basic/profile.js`) turns an entry into
"SYNTAX ERROR 3: an expression could not start where it did (…)". The 2.1 manual
writes run-time messages as `RUNTIME ERROR n`; `describeError` drops a trailing
" n" placeholder before adding the code. The 2.1 ROM itself shows the code with
both SYNTAX ERROR n and RUNTIME ERROR n.

**Editor wiring**
- `src/editor.js`: the CM6 `linter(...)` source calls
  `window.leapIDE.lintSource` 500 ms after typing stops. Until the hidden
  machine has booted there is nothing to report; `ide.js` then calls
  `leapEditor.relint()`.
- `lintSource(text)` (ide.js) calls the attached profile's `lint(text)`, which
  first reports the storage problems from `prepareSource` (non-ASCII, lines over 127 characters, a program larger than
  the pool), then compiles. A diagnostic underlines the failing editor line from
  its first non-blank character (`lineRange`); blank lines are mapped
  correctly, and end-of-source errors go on the last line.
- The **Lint** button runs the same check and shows the first message, or "No
  errors", in the status bar.
- Run uses the same messages: a compile error reads "Compile error N on line L"
  with the line marked; a run-time error reads "Runtime error N at line L" with
  the line marked "RUNTIME ERROR 10: array index outside the array" (line found
  as described in "How Run Works"); BREAK reads "Stopped (BREAK) at line N".

Not implemented (the old plan listed them): a nested-`PROC` check of the
IDE's own, several errors at once, and warnings such as unused labels.
Verified in headless Chromium and Node against the 2.0.2 ROM.

---

## Phase 7 — done (`src/tools/`)

The right panel has four tabs: **Debugger | Symbols | UDG | Draw**. The chosen
tab is remembered in `localStorage` (`leap-ide.tab`); the debugger's refresh
button shows only on the Debugger tab, and a debugger pause (breakpoint or
Step) switches back to it. Code the tools generate goes in through
`leapEditor.insertLines(text)` in `src/editor.js`: it inserts whole lines after
the cursor's line, selects them, scrolls to them and is one undo step. The tab
code is in the "Right-panel tabs" section of `ide.js`; the UDG tool is created
in `bootEmulator` because it needs the ROM entry and the machine.

- **Symbols** (`src/tools/symbols.js`): procedures `name(param)`, `DEF FN`s,
  labels `name:` and variables (each with the line it is first set), grouped
  with counts and sorted by line, with a filter box. Clicking a name moves the
  editor to its line. Built on `scanSymbols()`; refreshes 300 ms after edits
  while the tab is open.
- **UDG** (`src/tools/udg.js`): Leap V2's 21 user-defined characters, codes
  144-164 (`UDG_CODE_BASE`, `UDG_COUNT`), 8 bytes each at `UDG_TABLE` (`$F180`
  in 2.0.2 and 2.1). The ROM entry carries `udgTable`, `udgCodeBase` and `udgCount`,
  generated by `tools/leap-rom-entry.py` (`SYMBOLS`). Leap programs define
  UDGs with `POKE` (no `DATA`/`READ`), and a UDG made only in the IDE would not
  exist on a real TS2068, so the tool works on the **program text**: "Insert
  POKEs" (this character) and "Insert all" (every drawn one) add a `REM` line
  plus two lines of four `POKE`s per character (about 70 characters, under the
  127 limit) after the cursor line; "Load from program" reads constant `POKE`s
  into the table range back into the grid (a round trip); "Send to TS2068"
  writes all 168 bytes into the emulated machine now. The grid: click or drag
  to draw (the first cell decides set or clear), Clear, Invert, flip left-right
  and up-down, shift in four directions; 21 thumbnails; the title shows
  `CHR$(n)`, the address and the 8 byte values. Designs persist in
  `localStorage` (`leap-ide.udg`). Exports `createUdgTool`, `udgPokes`,
  `pokesInSource`.
- **Draw** (`src/tools/draw.js`), the graphics scratchpad: a 256x192 canvas that
  is the TS2068 screen (y from the top, 1 CSS pixel per pixel). Clicks add
  points to a path; a one-point path is `PLOT x, y`, each further point a
  `LINE x0, y0 TO x1, y1`. Right-click, Escape or "End path" ends a path; Shift
  snaps horizontal/vertical; Backspace/Delete undoes a point. The preview is
  Bresenham (both ends inclusive) on an ink canvas, with an overlay canvas for
  markers and the rubber band. The generated code is shown live, with "Insert
  into program" and "Copy"; paths persist in `localStorage` (`leap-ide.draw`).
  The area zooms 1×, 2× or 3× with its own − / + buttons, like the display: a
  whole number of device pixels per screen pixel, the overlay drawn at device
  resolution, and when zoomed the pixel under the pointer is outlined. While
  the Draw tab is open the right panel widens to fit; the zoom drops when the
  editor would get less than 360 px (+ is then disabled, saying why). The
  choice is remembered (`leap-ide.drawZoom`, default 2×); layout is
  `applyDrawZoom` in `ide.js` ("Draw zoom"), and `createDrawTool` returns
  `{setSize}`. Exports `createDrawTool`, `bresenham`, `pathsToCode`.

Verified in headless Chromium: the tabs and the symbol table contents, and the
rendering of the UDG and Draw tabs; the tools' code insertion and runs were
tested separately.

---

## Build Phases

| Phase | Deliverable                                         | Key files               | Status |
|-------|-----------------------------------------------------|-------------------------|--------|
| 1     | Shell + TSRun embedded + program runs               | `ide.html`, `ide.js`, `src/emulator.js`, `src/lang/basic/leap-roms.js` | **Done**, verified |
| 2     | CodeMirror 6 editor + Leap V2 syntax                | `src/editor.js`, `src/lang/basic/leap-lang.js`, `src/lang/basic/leap-keywords.js` (generated) | **Done**, verified |
| 3     | Debugger panel (registers, step, breakpoints)       | `src/debugger.js`, `src/lang/basic/leap-debug.js` | **Done**, verified |
| 4     | Keyboard translation + `INPUT` mode                 | `src/pc-keyboard.js`    | **Done**, verified |
| 5     | Error checking by the ROM's compiler, wired to the CM6 linter | `src/lang/basic/leap-check.js`, `src/lang/basic/leap-errors.js` (generated), `ide.js`, `src/editor.js` | **Done**, verified |
| 6     | Tape + DCK export                                   | `src/lang/basic/export.js`, `src/lang/basic/cartridge.js`, `cartridge/2.1.0-emu.1/`, `src/lang/basic/leap-check.js` (`compile`), `ide.js` | **Done**, verified (TAP, DCK with packages, cartridge test on the stock ROMs) |
| 7     | UDG editor, symbol table, graphics scratchpad       | `src/tools/symbols.js`, `udg.js`, `draw.js`, `src/editor.js` (`insertLines`), `ide.js` | **Done** |
| 8     | Polish: themes, help overlay, keyboard cheat-sheet  | `ide.html`, `ide.css`, `ide.js`, `src/help.js` | **Done** (themes: light / dark / system) |
| —     | Files (auto-save, New/Open/Save) and Packages (`LOAD "NAME" EXT` on Run) | `src/files.js`, `ide.js`, `src/emulator.js`, `src/lang/basic/leap-check.js`, `packages/` | **Done**, verified |
| 0 (multi-language) | Language profiles: BASIC moves to `src/lang/basic/`, the core asks the active profile (Leap-C and Forth followed) | `src/lang/profiles.js`, `src/lang/editors.js`, `src/lang/basic/profile.js`, `src/lang/basic/editor.js`, `src/lang/basic/leap-words.js`, `src/emulator.js`, `src/debugger.js`, `src/editor.js`, `ide.js` | **Done** (2026-11-01, `3ed5d3b`) |
| F0-F5, F8, Import (multi-language) | Leap-Forth: the live OK prompt, Run line by line, editor, Help, Examples (F0-F2); the static check (F3); Import session; the debugger (F4: line table built while sending, stacks and words); TEXT tape export and Open (F5); the cartridge (F8: ⬇ DCK / ▶ Test DCK on a stock TS2068); TSRun pin `11731e1` | `src/lang/forth/` (`forth-check.js`, `forth-debug.js`, `tape.js`, `cartridge.js`), `cartridge/forth/2.0/`, `src/lang/keytables.js`, `src/emulator.js` (`canInject`, `next`, `onKeyWait`, `testCartridge` symbols), `src/debugger.js` (`beginRun(job)`, `version`, `labels`), `src/lang/profiles.js`, `tools/forth-rom-entry.py`, `tools/gen-forth-*.py`, `ide.js` | **Done** (2026-11-01: F0-F2 `b9526ce`, Send after it, F3 `a3869d4`, Import `89a6d48`, F5 `6103f66`, F4 `054198d`, F8 `f7a5d1d`); F6 rest (`\ expect:` / `\ keys:` checks, `gallery.fs`) and F7 tools not yet |
| C1-C7, C9 (multi-language) | Leap-C: Run by the shell path, the ROM compiler as checker, a C editor (C1-C3); 1.0.0 ROM entry, TSRun pin `9f9bbc5`; tape export and Open (C5); libraries `LIB "shapes"` (C6); the cartridge (C9: ⬇ DCK / ▶ Test DCK on Leap-C 1.1.0's build, `4798b64`); the Examples menu with the manual's 18 programs (C7); the debugger and the exit status (C4) | `src/lang/c/` (`leapc-debug.js`), `libs/c/1.0.0/`, `src/files.js` (`tapeToText`), `src/emulator.js` (`breakHold`), `src/editor.js` (breakpoint toggle fix), `tools/leapc-rom-entry.py`, `tools/gen-leapc-*.py`, `ide.js` | **Done** (2026-11-01: C1-C3 `d0e437b`, 1.0.0 `ac0d00f`, C5 `94700cf`, C6 `4f30b82`, C7 `1050d7b`, C4 `0b419d3`, C9 `4798b64`); locals in the debugger and C8 tools not yet |
| —     | Editor structure tools (folding, indent, Tidy, go to definition, rename), Examples menu, Z80 breakpoints | `src/lang/basic/editor.js`, `src/lang/basic/leap-lang.js`, `src/lang/basic/examples.js`, `src/debugger.js`, `ide.js` | **Done**, verified |

---

## Source Repositories

- **Leap** (ROM source, manual): https://github.com/nchiker/2068-Leap, local
  clone `~/2068-Leap`. V1 is archived; ignore it.
- **TSRun** (emulator): fork https://github.com/nchiker/TSRun, git submodule
  `./tsrun` pinned at `9f9bbc5`.
- **This project on GitHub**: https://github.com/nchiker/2068-Leap-IDE, live at
  https://nchiker.github.io/2068-Leap-IDE/.
- **This project**: `/home/charlie.day/Projects/Leap-IDE`
- **Mock-up**: `docs/mockup.html` — open in a browser for the visual target.
- **Design docs**: `docs/overview.md`

---

## Module fingerprints (browser caching)

Browsers cache scripts (GitHub Pages sends `max-age=600`; `python3 -m http.server`
lets them guess), so after an update a page could combine the new `ide.html`
with an old `ide.js` — e.g. tab buttons that do nothing. `tools/stamp-modules.py`
gives every module URL a hash of its contents: the two entry scripts in their
`<script src>`, every module they import (ours and TSRun's) as
`"./src/x.js": "./src/x.js?v=<hash>"` in the import map. Modules keep their
plain relative imports; the import map remaps them. A changed file gets a new
URL, an unchanged one stays cached, versions never mix.

**Run `tools/stamp-modules.py` after changing any `.js` file, before committing**
(`--check` reports whether `ide.html` is current). `tools/pre-commit` is an
optional git hook that does it on every commit (owner's choice to install:
`ln -s ../../tools/pre-commit .git/hooks/pre-commit`). A new module is picked up
automatically as long as a relative `import` reaches it from `src/editor.js` or
`ide.js`.

## Tests

- `node tests/rom-checks.mjs` — 150 checks in about 5 s against the real ROMs in
  Node (TSRun's machine, no browser): ROM table lookup, Run by injection
  (through the profile's real `driver.inject`; finished, compile error,
  run-time error, package), section 1b "Language profile" (9 checks: profile
  lookup by id / file extension, `prepareSource`, and the attached profile's
  `lint`, `startRun`, `describeResult`, TAP and cartridge as `ide.js` uses
  them), the checker's error codes
  and lines, packages, the debugger's line table / breakpoints / variables /
  call stack, TAP export byte-identical to Leap's `SAVE`, the UDG and Draw
  helpers, every Examples-menu program (section 3b: each finishes with no
  error; `guess` stops at its `INPUT`), share links (round trip with the name,
  shorter than the program, a fragment without a program ignored, a damaged
  link refused), and (section 7, "Cartridge") the
  cartridge: the identity match, the checker's bytecode and `SYM_COUNTS`, a
  compile error giving no bytecode, the DCK layout, the flat BIN, a stock TS2068
  (`tsrun/roms/ts2068-0.rom`/`ts2068-1.rom`, `insertDock`) running the exported
  cartridge to the end (POKE marker 42, VM error 0, `$F4` = `$43`), a wrong
  identity being refused, `pagingWrites`, "the cartridge build takes packages
  (image format 2)" and "a SHAPES program (CIRCLE + FILL) runs from the
  cartridge" (stock TS2068, about 5145 pixels set, POKE marker, VM error 0).
  Section 8 (Leap-Forth): boot, Run, words accumulating across runs, an
  unknown word with its line and column, THROW in a word, a `KEY` wait, BREAK,
  the 12 non-interactive examples running to OK; F3: the check knows a word of
  the live session and marks an unknown one, forgets the session's words after
  a Reset, finds nothing in any Examples-menu program, and gives the error and
  warning cases (use before definition, unbalanced `IF`, compile-only word at
  the prompt, `;` without `:`, an unclosed string or `(` comment, `MISSING
  NAME`, `OUT OF RANGE`, a word made with `CREATE`); Import session (the line
  store as text, empty after a Reset); F5: the tape byte-identical to the ROM's
  `SAVE-TEXT`, Open reading it back, the ROM's `LOAD-TEXT` defining its words,
  Leap V2 and Forth tapes told apart; F4: the debugger adapter driven as
  `src/debugger.js` drives it (a breakpoint inside a word with its callers,
  Step word by word, the stacks and the session's words); F8: the editor's
  text built on a fresh hidden machine, the start word chosen, the DCK run on
  a stock TS2068, a wrong identity refused. Section 9 (Leap-C): the checker's lines
  and columns, Run, compile and run-time errors, `getkey` and BREAK, a run
  started from the report; C6: a shapes program checks clean with the library
  loaded and not without it, `circle()` draws, the next run without the library
  unloads it (`LIB_LOADED` 0), a program defining its own `circle()` loads
  nothing, ⬇ TAP names `LIB "shapes"`; C7: the 15 Examples-menu programs without
  keys or a tape give the manual's exit status, screen text and pixels, and all
  18 check clean; C5: the tape byte-identical to the ROM's `SH_SAVE`, Open
  reading it back, `SH_LOAD` restoring the line store and `PROG_END`, Leap-C and
  Leap V2 tapes told apart; C4: stops with the globals and the call stack,
  Step statement by statement into a called function, the globals of each type,
  and the lines of a run-time error and of BREAK; C9: the identity `$E90E`,
  the DCK layout (chunks 0, 1, 4, 5, 6; `"LCPG"` at DOCK `$8000`) and the flat
  image, a program run from the cartridge on a stock TS2068 to its report
  (`EXIT 7`, a line drawn), a shapes program with the library in region 3
  (`EXIT 12`), a compile error refused with its line, and `outp(244, …)`
  asking first. The library and tape checks print SKIP for a ROM with no
  library images (`libs/c/<version>/`) or no `LEAPC_TAPE_SYMBOLS` entry
  (beta.2), the C4 checks print SKIP for an entry without the C4 fields
  (beta.2), and the C9 checks print SKIP for an entry without `cartridgeDir`
  (beta.2).
  `LEAP_ROMS=<dir>` tests other BASIC ROM files; `FORTH_ROMS=<dir>` and
  `LEAPC_ROMS=<dir>` do the same for Forth and Leap-C (with `LEAPC_ROMS` on the
  beta.2 ROMs 128 checks run: libraries, the debugger, tapes and the cartridge
  are skipped). All 150 pass on 2.1.0-emu.1
  (the default ROMs now) and with `LEAP_ROMS` pointing at the 2.0.2 ROMs. The
  expected values were recorded on 2.0.2-emu.1 and held for 2.1 unchanged; only
  the debugger's `vmNext` hook and the TAP check's carry-set stand-in needed
  changes.
- `node tests/browser-smoke.mjs [outdir]` — 64 checks in about 40 s, in headless
  Chrome: it serves the repo itself, boots the IDE and checks fingerprinted
  modules, Run results in the status bar, the error check, auto-caps, tabs,
  Draw zoom, theme and Help, find and replace (Ctrl+H, replace all), Undo (the
  button is disabled for a new program, then undoes the replace), the Cut and
  Paste buttons through the system clipboard (permission granted over CDP), the
  DCK export (a cartridge downloads; the file-name
  prompt and the download are captured in the page; a package program is
  exported with its package), the cartridge test (▶ Test DCK runs the program
  on the stock ROMs to its POKE marker, Stop goes back to Leap, Open of a
  `.dck` tests it and keeps the editor's program, Pause / Continue, Run goes
  back to Leap and runs), auto-indent, Tidy (nested blocks, labels, `IF` …
  `THEN GOTO`; Tidy leaves every example unchanged), block match, fold markers,
  F12, F2 rename and its refusals, line-limit marking, the Examples menu (opens
  one, closes) and running the SHAPES example, and a Z80 breakpoint pause, Step
  instruction and continue to Finished, and Share (copies a link; loading it in
  a fresh page opens the program, its file name, an empty hash and the status),
  an auto-save from before languages (the bare `leap-ide.document` key) opening
  and moving to `leap-ide.document.basic`, switching to Forth and to Leap-C
  (run, an error marked on its token, typing at the Forth prompt, Ctrl+Enter
  sending the cursor's line only, Stop of a `getkey` wait, switching back keeps each language's document; Forth: an undefined word marked and a session word known, Import, the TEXT tape, a breakpoint in a word pausing with the data stack and the callers shown (then Continue to OK), ▶ Test DCK running the program's cartridge with start word MAIN on a stock TS2068 and Stop going back to Forth; Leap-C: Run giving `Finished: exit 9`, ⬇ TAP, a shapes program with its library, the Examples menu, a breakpoint in a function pausing with the globals and call stack, a second toggle clearing it, Continue giving the exit status, ▶ Test DCK running the compiled program's cartridge on a stock TS2068 (a line drawn) and Stop going back to Leap-C), with no page errors. It saves screenshots. CodeMirror's search
  panel takes the query on keyup / change, so CDP `Input.insertText` alone does
  not set it; the test also sends a keyUp.
- Run both before every commit that changes behaviour. `src/lang/basic/leap-lang.js`
  and `src/lang/basic/editor.js` import CodeMirror, so Node cannot load them;
  they are covered by the browser test. Their pure parts are in
  `src/lang/basic/leap-words.js` and `src/lang/basic/profile.js`, which Node
  tests import.

## Coding Conventions

- Plain ES2020 modules (`type="module"`). No TypeScript, no bundler.
- `"use strict"` in every file.
- Functions over classes where state is minimal.
- Constants for every magic address; per-release addresses belong in
  `src/lang/basic/leap-roms.js`, not scattered through the code.
- No external CSS frameworks — one `ide.css` for the shell layout.
- Comments on anything non-obvious, especially TSRun API calls.

---

## What Claude Code Should Do Next

All phases are done, and so are **stage 0 of the multi-language plan** (the
language profile, `3ed5d3b`), **Leap-Forth** F0 to F5 and F8 with Send and
Import session (`b9526ce`, `a3869d4`, `89a6d48`, `6103f66`, `054198d`,
`f7a5d1d`) and **Leap-C** C1 to C7 and C9, with the move to 1.0.0 (`d0e437b`,
`ac0d00f`, `94700cf`, `4f30b82`, `1050d7b`, `0b419d3`, `4798b64`); see
"Languages". Nothing is open with the Leap-C project. Remaining (details in
`docs/LEAP_FORTH_PLAN.md` and `docs/LEAP_C_PLAN.md`), all optional:

- **Forth:** of F6, the examples' `\ expect:` output and `\ keys:` lines and
  `demos/gallery.fs`; F7 (UDG and Draw tools) is optional; the Forth cartridge
  has run on TSRun's stock TS2068 only (ZEsarUX / Fuse and real hardware not
  tried).
- **Leap-C:** locals in the debugger; driving the Examples-menu programs that
  need keys (`keys:`) and the tape one in the tests; running the C examples
  from cartridges against the manual's results (as V2's 695-program
  comparison); C8 tools (UDG and Draw). The Leap-C cartridge has run on
  TSRun's stock TS2068 only (Fuse / ZEsarUX with it were the Leap-C project's
  own; real hardware not tried).

Phases 1 to 5, 7 and 8 work, Phase 6's tape export (Leap's
own `LOAD` reads the IDE's `.tap`) and DCK export (a cartridge that runs on a
stock TS2068, approved by the owner on 2026-10-28) are done and verified, and
saving/opening programs, packages and the Help overlay are done. The Leap
2.1.0-emu.1 ROM entry is done (ROM table, generated keyword and error data,
packages, cartridge images, tests). Nothing is on hold. Ideas, none started:

1. **Test the DCK on real hardware.** It has run on TSRun, ZEsarUX 13.0 and
   Fuse 1.9.1 with the stock ROM (same screens), not on a real TS2068.
2. **Cartridge builds for future Leap releases** (see "Adding a Leap ROM
   release", step 5).
