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

Leap is **V2**; the current release is **2.1.1-emu.1** (tag `v2.1.1-emu.1`,
merge commit `4891681` of nchiker/2068-Leap, published 2026-11-02). It fixes
`STICK`, `LINE` (4-5 times faster, same pixels), the colour rows of mode 1 and
the p / q / g glyphs. With 2.1.0 a mode 1 program showed wrong colours in the
IDE (the colour bytes were written at `$6000 + y*32 + col` instead of the
bitmap address + `$2000`; nchiker/2068-Leap#5); with 2.1.1 they are right. The
ROM table also still knows 2.1.0-emu.1 (tag `v2.1.0-emu.1`, commit `c005159`,
published 2026-10-28) and 2.0.2-emu.1, which are useful with
`LEAP_ROMS=<dir>`. V1 is archived and irrelevant. ROM addresses change between releases; everything else
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
│   │       ├── examples.js   ← The Examples menu's 12 programs, then the speed test (no DOM; Node can import it)
│   │       ├── export.js     ← TAP builder (Phase 6, done, verified)
│   │       └── cartridge.js  ← DCK / flat .bin cartridge builder, program image format 2 with a package (Phase 6, done, verified; no DOM, Node can import it)
│   │   ├── spin-demo.js ← The speed test, "Spinning squares", one version per language: SPIN_DEMO {basic, c, forth} (no DOM; Node can import it)
│   │   ├── c/          ← Leap-C (v1.2.0; see "Leap-C")
│   │   │   ├── profile.js       ← The C profile: driver (shell path), prepareSource, describeError, debug adapter, tape export / Open, libraries, attach() (no DOM or CodeMirror)
│   │   │   ├── editor.js        ← CodeMirror half: C-subset highlighting, completion, hover, folding, indent, Tidy, match, go to definition, rename
│   │   │   ├── leapc-scan.js    ← Pure scanner: functions, globals, macros, types, librariesUsed (no CodeMirror)
│   │   │   ├── leapc-check.js   ← Editor error check: SH_COMPILE on a hidden machine, with the error's token column; compileImage() reads the compiled program back for the cartridge
│   │   │   ├── leapc-debug.js   ← Debugger (C4): line table from the compiler, globals, IX frame-chain call stack (no DOM; Node can import it)
│   │   │   ├── cartridge.js     ← DCK / flat .bin builder for a stock TS2068 (C9): program image "LCPG" format 1, port of cartpack.py and c2cart.py's region_blocks (no DOM; Node can import it)
│   │   │   ├── leapc-roms.js    ← Known Leap-C ROM builds (1.2.0, 1.0.0, 1.0.0-beta.2): SHA-256 -> addresses
│   │   │   ├── leapc-keywords.js ← GENERATED keyword / library data from the manual; never hand-edit
│   │   │   ├── leapc-errors.js  ← GENERATED compile / run-time error text from include/leapc_errors.inc; never hand-edit
│   │   │   └── examples.js      ← GENERATED Examples menu (the manual's 18 Part 7 programs, test directives as data); never hand-edit
│   │   └── forth/      ← Leap-Forth (2068-Forth v2.0.1; see "Leap-Forth")
│   │       ├── profile.js       ← The Forth profile: driver (line by line through EDIT_BUF), prepareSource, describeThrow, debug adapter, interpretFresh + buildCartridge, attach() (no DOM or CodeMirror)
│   │       ├── editor.js        ← CodeMirror half: highlighting by the interpreter's reading, completion with stack effects, hover, folding, indent, Tidy, block match, go to definition, rename
│   │       ├── forth-scan.js    ← Pure scanner: lineTokens(line, ctx), scanContext, scanDefinitions, blockStructure, isNumber (no CodeMirror)
│   │       ├── forth-check.js   ← Static error check (F3): checkForth, readSessionWords, numberInRange (no DOM or CodeMirror)
│   │       ├── forth-debug.js   ← Debugger (F4): line table built while sending, stacks and words, call stack from the return stack (no DOM; Node can import it)
│   │       ├── cartridge.js     ← DCK / flat .bin builder for a stock TS2068 (F8): program image "F1", port of forthcart.py (no DOM; Node can import it)
│   │       ├── tape.js          ← TEXT tapes (F5): buildForthTap, forthTapeToText, isForthTape (no DOM; Node can import it)
│   │       ├── forth-roms.js    ← Known Forth ROM builds: SHA-256 -> addresses
│   │       ├── forth-words.js   ← GENERATED word data (184 words) from the manual; never hand-edit
│   │       └── examples.js      ← GENERATED Examples menu (15 manual programs + Blackjack + Shooting Gallery; `keys` as `[line, text]`); never hand-edit
│   └── tools/        ← Right-panel tools (Phase 7, done)
│       ├── symbols.js ← Symbols tab: the profile's symbol groups; click jumps to the line
│       ├── udg.js     ← UDG tab: draw the 21 user-defined characters, insert / load POKEs (BASIC)
│       └── draw.js    ← Draw tab: graphics scratchpad generating PLOT / LINE (BASIC)
├── cartridge-build/  ← Source of the cartridge images: leap.patch + setup.sh, CLI tools, tests, status (see its README)
├── cartridge/
│   ├── 2.1.0-emu.1/  ← Leap 2.1.0-emu.1's cartridge build: leap_v2_cart_home.bin (16 KB), leap_v2_cart_exrom.bin (8 KB), README (identity $E0A5)
│   ├── 2.1.1-emu.1/  ← The current Leap cartridge build, same files (identity $4E00)
│   ├── forth/2.0/    ← 2068-Forth v2.0's cartridge build: forth_cart.dck (Forth with no program, the release's, unchanged; identity $FDBE), README
│   ├── forth/2.0.1/  ← v2.0.1's: forth_cart.dck (the release's, SHA-256 1f673221…; identity $F001), README
│   ├── c/1.2.0/      ← Leap-C 1.2.0's cartridge build, the current one: leapc_cart_home.bin (505d0f79…), leapc_exrom.bin (the release EXROM), cartridge.json (release 1.2.0, identity F6E9), README
│   └── c/1.1.0/      ← Leap-C 1.1.0's cartridge build (serves the 1.0.0 ROM entry): leapc_cart_home.bin (16 KB), leapc_exrom.bin (8 KB, the release EXROM), cartridge.json (the identity it accepts, E90E), README
├── packages/
│   ├── 2.0.2-emu.1/  ← Package images of that release (<name>.bin; same six as 2.1.1-emu.1)
│   ├── 2.1.0-emu.1/  ← Package images of that release (the same six)
│   └── 2.1.1-emu.1/  ← The current release's package images: cbeep graphics mode printer shapes sprite (<name>.bin; byte-identical to 2.1.0's)
├── libs/
│   └── c/            ← Leap-C library images, one directory per release (1.0.0, 1.2.0): <name>.bin (shapes.bin, the data block of the release's libs/shapes.tap; the same bytes in both) and README
├── tools/
│   ├── leap-rom-entry.py  ← Prints a src/lang/basic/leap-roms.js entry for a 2068-Leap build
│   ├── gen-leap-keywords.py ← Generates src/lang/basic/leap-keywords.js from the Leap manual
│   ├── gen-leap-errors.py   ← Generates src/lang/basic/leap-errors.js from manual Appendix B
│   ├── forth-rom-entry.py   ← Prints a src/lang/forth/forth-roms.js entry for an unpacked 2068-Forth release
│   ├── gen-forth-words.py   ← Generates src/lang/forth/forth-words.js from the Forth manual (Parts 3 and 4)
│   ├── gen-forth-examples.py ← Generates src/lang/forth/examples.js (manual Part 7 programs + demos/blackjack.fs + demos/gallery.fs)
│   ├── gen-forth-doc-tests.py ← Generates tests/forth-manual-examples.json: every ```forth block of the Forth manual, with its test directives (a port of 2068-Forth's tools/docexamples.py)
│   ├── leapc-rom-entry.py   ← Prints a src/lang/c/leapc-roms.js entry for a 2068-Leap-C build directory (optional third argument: the cartridge dir)
│   ├── gen-leapc-keywords.py ← Generates src/lang/c/leapc-keywords.js from the Leap-C manual
│   ├── gen-leapc-errors.py  ← Generates src/lang/c/leapc-errors.js from include/leapc_errors.inc
│   └── gen-leapc-examples.py ← Generates src/lang/c/examples.js from the Leap-C manual's Part 7 (`apply_overrides` takes any tools/leapc-example-overrides/<N>-<id>.md, a directory that does not exist now)
├── tests/
│   ├── rom-checks.mjs    ← Node: run path, checker, packages, debugger, TAP vs Leap's SAVE, cartridge on a stock TS2068, Forth (with the manual's examples), Leap-C, the speed test (real ROMs)
│   ├── forth-manual-examples.json ← GENERATED by tools/gen-forth-doc-tests.py (313 manual blocks at v2.0.1); never hand-edit
│   └── browser-smoke.mjs ← Headless Chrome: the whole IDE end to end
├── docs/
│   ├── HANDOFF.md    ← Session handoff: status, owner decisions, traps
│   ├── overview.md   ← Design doc
│   ├── LEAP_FORTH_REFERENCE.md, LEAP_C_REFERENCE.md, DEBUGGER.md, EXPORT_FORMATS.md, TESTS.md, BUILD_PHASES.md ← sections moved out of this file to keep it under the 150k-character limit
│   ├── LEAP_CARTRIDGE_BUILD.md ← Spec: Leap runtime cartridge build for 2.1 (what DCK export needed; now built)
│   └── mockup.html   ← Visual mock-up
└── tsrun/            ← git submodule: TSRun fork, pinned at 89208e8 (closed-form silent AY, on 9893b46)
```

**ROMs are not in this repo.** They load from `tsrun/roms/leap-0.rom` (16K
HOME) and `tsrun/roms/leap-1.rom` (8K EXROM). These are the 2.1.1-emu.1 release
images (SHA-256 `c79ce1cf…` and `ba7f0869…` respectively; the pair's key in
`src/lang/basic/leap-roms.js` is `57153400…`). The release bundle has no `.sym`
files, so the ROM entry was made from a `make build` of the tag in a temporary
detached worktree (since removed), which is byte-identical to the release zip's
ROMs. The 2.1.0-emu.1 pair (`8c3d6c81…`, `e46e2065…`; key `5a42872e…`) and the
2.0.2-emu.1 pair (`1fe5798f…`, `e6b507a4…`) are also in the table.

**TSRun** is the fork https://github.com/nchiker/TSRun (upstream
josef-jelinek/TSRun), included as the git submodule `tsrun/` pinned at commit
`89208e8` ("AY: closed-form silent advance", 2026-11-14: the AY's silent advance
in closed form, chip state identical; it speeds the Node test suites), on top of
`9893b46` (Leap V2 2.1.2-emu.1 ROMs) and `c52f272` (Leap V2 2.1.1-emu.1 as
`roms/leap-*.rom`, with the READMEs). `89208e8` is on the fork's branch
`silent-ay`; the fork's `main` has the same change as `6ccf56e`, on top of
two LeapG commits (Kempston mouse, host bridge on ports $6D / $6F) that the
IDE has not been verified with, so the pin stays on `silent-ay` until a move
to `main` is verified (`node tools/verify.mjs --all --full`). **Never push the IDE with a submodule
commit that is not pushed to nchiker/TSRun**, or GitHub Pages gets a submodule
commit it cannot fetch. `34b0794` carries the
Leap-C 1.2.0 ROMs (`roms/leapc-*.rom`) and, below it, `02e5325` the 2068-Forth
v2.0.1 ROMs; both were pushed by the ROM projects. Before them the pin was
`9f9bbc5` (the Leap-C 1.0.0 ROMs), `11731e1` (the
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

**Speed test** (`src/lang/spin-demo.js`, no DOM; Node can import it; added
2026-11-01, `1c74c46`). `SPIN_DEMO {basic, c, forth}` holds one
Examples-menu entry per language, "Spinning squares (speed test)", id `spin`;
each profile appends its own to its list (`examples: [...GENERATED,
SPIN_DEMO.<id>]`), so the generated C and Forth lists are untouched (BASIC's
`examples.js` is hand-written and has 12 programs, so the menu shows 13). The
task is the same in all three: 18 frames of 12 nested squares turning, 48 lines
a frame (CLS each frame, INK per square), the corners from an integer sine table
(72 entries, 5 degrees apart, 64 = 1) as `r * (s + 64) / 64 - r`, so that no
language divides a negative number. All three draw exactly the same picture.
Each times the animation with the ROM's frame counter and prints the frames:
BASIC PEEKs Leap's `FRAMES` (`$8175`, 33141), Leap-C calls `frames()`, Forth
fetches `FRAMES` (`$80F4`, 33012). C and Forth have the table as literals; BASIC
computes it with `INT(SIN(k * 5) * 64 + 64.5) - 64` (Leap's `SIN` takes degrees
and `INT` cuts toward zero). Measured in TSRun on Forth 2.0, Leap-C 1.0.0 and
Leap 2.1.0 (the figure each program prints): Forth 522 frames, Leap-C 1644,
Leap BASIC 1901. Leap-C was the slower of the compiled two because its `draw()`
was slow: 864 lines of 90 pixels took 2005 frames in Leap-C 1.0.0 against 422
for Forth's `LINE` (its arithmetic is fast). That was told to the Leap-C project
(`docs/requests/LEAP_C_DRAW_SPEED.md`) and answered with 1.2.0 (the display code
of Forth 2.0 ported: `draw()` about 4 times faster, see "Leap-C"); Leap V2's
`LINE` got the same port in 2.1.1. Measured later over the whole run, from
injection to its end (`VERBOSE=1 node tests/rom-checks.mjs` prints "(basic: N
frames from the start of the run to its end)"): BASIC 2081 frames on 2.1.0 and
850 on 2.1.1 (about 2.4 times faster); Forth 656, the same on 2.0 and 2.0.1. The
BASIC program's own printed figure (1901 on 2.1.0) was not read again on 2.1.1,
and Leap-C's speed was not measured on 1.2.0 (the test has no `FRAMES` address
for it; its manual claims `draw()` about 4 times faster). `tests/rom-checks.mjs` section 10 runs
the three through their profiles' Run path and checks that each ends with no
error, that the counter each reads counts, and that the bitmap (rows 8 to 183)
and the attributes are identical across the three.

To add a language: a new `src/lang/<id>/` with `profile.js` and `editor.js`,
one line each in `src/lang/profiles.js` and `src/lang/editors.js`, its ROM
entries and generated data under it, and tests (`tests/rom-checks.mjs`
sections 8 and 9 are the models).

### Leap-Forth (`src/lang/forth/`, stages F0 to F6 and F8, plus Import session)

**Details: [`docs/LEAP_FORTH_REFERENCE.md`](docs/LEAP_FORTH_REFERENCE.md).** Leap-Forth (2068-Forth v2.0.1) profile: console-first model, Send, Run line by line, editor, static check, Import session, tape, debugger, cartridge, manual examples, and how to add a release.

### Leap-C (`src/lang/c/`, stages C1 to C7 and C9)

**Details: [`docs/LEAP_C_REFERENCE.md`](docs/LEAP_C_REFERENCE.md).** Leap-C v1.2.0 profile: shell Run path, checker, editor, tape, libraries, Examples, debugger, cartridge (C9), ROM entry, and how to add a release.

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

## Memory Map — Critical Addresses (2.0.2-emu.1, 2.1.0-emu.1 and 2.1.1-emu.1)

The data layout below is the same in all three releases (checked in 2.1 and
again in 2.1.1: the main pool, `V2_SOURCE_END`, the VM and compiler tables, the
UDG table, the package window and `SYM_COUNTS` did not move). Routine addresses
did move (for example `V2_COMPILE_STORED` is `$D54F` in 2.0.2 and `$D45A` in
2.1, `IO_READ_KEY.wait_hit` is `$0443` in 2.1; 2.1.1 moved them again, so its
entry was generated, not copied; `V2_SAVE` `$D702` and `STORAGE_SEND_BLOCK`
`$C3F1` did not change from 2.1.0, and Leap's `FRAMES` stayed at `$8175`); the per-release values live in `src/lang/basic/leap-roms.js`. Full table: manual
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
   in `<dir>`. Compare the ROMs with the release zip's. (2.1.1-emu.1 was done
   this way, since its release bundle has no `.sym` files; remove the worktree
   afterwards: `git -C ~/2068-Leap worktree remove <dir>`.)
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

It reads `docs/manual/03_keywords.md` at that ref (currently `v2.1.1-emu.1`) and
emits `LEAP_KEYWORD_ENTRIES`: 100 entries, each `{kind, package, syntax, forms[],
desc, example}`. `kind` is function / statement / operator / command / part of;
`package` is `null` or the package name; `desc` is the first paragraph (at most
420 characters); `example` is the first basic example (at most 6 lines). The
100 entries are unchanged in content between 2.0.2 and 2.1, and between 2.1.0
and 2.1.1 only `STICK`'s entry changed. For the next release, rerun it at its
tag.

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

**Details: [`docs/DEBUGGER.md`](docs/DEBUGGER.md).** Line table, VM hook, debug adapter, controller, panel, Z80 breakpoints, Forth / Leap-C adapter differences and known limits.

## Export Formats (Phase 6 — TAP and DCK done and verified)

**Details: [`docs/EXPORT_FORMATS.md`](docs/EXPORT_FORMATS.md).** Tape (`.tap`) and DCK / flat `.bin` cartridge export and the cartridge test (BASIC): formats, images, checks, verification.

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
  `Example "X": press Run (F5)`. The speed test (`spin`, see "Languages") is
  appended after the 12. `tests/rom-checks.mjs` section 3b runs every
  example on the real ROMs: each finishes with no error (`guess` stops at its
  `INPUT`).

---

## Packages (done, `src/lang/basic/profile.js`, `src/lang/basic/leap-check.js`)

Package statements (`CIRCLE`, `FILL`, `GRAB`, `MODE`, `LPRINT`, `CBEEP`, …) are
not in the ROM: on a TS2068 a program loads a package with `LOAD "NAME" EXT`
first. The IDE does that for the user, so such programs compile and run.

- **Images.** The release's six package images are in
  `packages/2.1.1-emu.1/<name>.bin` (`cbeep graphics mode printer shapes sprite`),
  copied unchanged from the release zip and checked against its `SHA256SUMS`.
  The six are byte-identical to 2.1.0's and 2.0.2's (`packages/2.1.0-emu.1/`,
  `packages/2.0.2-emu.1/`, checked with `cmp`; the release notes say the shipped
  packages are unchanged, and the package ABI 2.1 is unchanged in 2.1.1).
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
for the next release (last run at `v2.1.1-emu.1`, where only the header changed; `LEAP_MANUAL_REF` in
`src/lang/basic/leap-keywords.js` follows, so Help links go to the 2.1.1 manual). `describeError`
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

**Details: [`docs/BUILD_PHASES.md`](docs/BUILD_PHASES.md).** The phase table (1 to 8, multi-language stages, new releases) with files and status. All phases are done.

## Leap Arcade and Leap Arcade Studio

A second product lives in this repository next to the IDE: **Leap Arcade**, a game-building structured BASIC compiled in
JavaScript (`src/lang/arcade/`) to native Z80 for the stock TS2068 and delivered as a DCK cartridge, and **Leap Arcade
Studio** (`studio.html`, `studio.js`, `src/arcade-project.js`, `src/tools/sprite-*.js`), a browser editor with projects, a
sprite editor, the compiler and the emulator. The IDE above is unchanged by it. Runtimes are `arcade/runtime/v0` to `v4`
(published builds in `arcade/dist/`; the compiler and the Studio choose v2, v3 or v4 per program), examples are in
`arcade/examples/` (bounce, breakout, shooter, blockfall, platformer "Leap Runner", raycaster "Vaults"). Everything about it
(plan, contracts, language batches, hardware notes, tests, traps) starts at **`docs/HANDOFF.md`** ("Leap Arcade / Leap Arcade
Studio") and `docs/ARCADE_PLAN.md`. Test everything (Arcade, Studio, editors, models, the IDE's own suites, perf and stamp checks) with `node tools/verify.mjs --all`
(before every PR; `--full` adds every mutant; `--changed` runs only what a change reads; steps in `arcade/tests/steps.mjs`). Run it with
`python3 -m http.server 8080` and open `http://localhost:8080/studio.html`. All its numbers are emulator-only (TSRun, ZEsarUX
13.0, Fuse 1.9.1); real hardware is untested.

---

## Source Repositories

- **Leap** (ROM source, manual): https://github.com/nchiker/2068-Leap, local
  clone `~/2068-Leap`. V1 is archived; ignore it.
- **TSRun** (emulator): fork https://github.com/nchiker/TSRun, git submodule
  `./tsrun` pinned at `89208e8`.
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

**Details: [`docs/TESTS.md`](docs/TESTS.md).** What `tests/rom-checks.mjs` and `tests/browser-smoke.mjs` cover, and how to run them. Run both before every commit that changes behaviour (`node tests/rom-checks.mjs`, `node tests/browser-smoke.mjs`).

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
language profile, `3ed5d3b`), **Leap-Forth** F0 to F6 and F8 with Send and
Import session (`b9526ce`, `a3869d4`, `89a6d48`, `6103f66`, `054198d`,
`f7a5d1d`, `50fb417`) and **Leap-C** C1 to C7 and C9, with the move to 1.0.0
(`d0e437b`, `ac0d00f`, `94700cf`, `4f30b82`, `1050d7b`, `0b419d3`, `4798b64`,
and the keyed Examples in `5cfffb8`), then the 2026-11-02 releases (Leap V2
2.1.1-emu.1 `4aa678c`, 2068-Forth v2.0.1 and Leap-C 1.2.0 `4c02f48`, TSRun pin
`c52f272` `5c251a5`); the speed test is in all three; see "Languages". All the
notes sent to the ROM projects are answered (Leap-C by 1.2.0 and
`docs/requests/LEAP_C_1_2.md` / `LEAP_C_EXAMPLE_11_ANSWERS.md`, Forth by the
v2.0.1 release, Leap V2 by 2.1.1 and `docs/requests/LEAP_V2_ANSWERS.md`).
All of it is pushed (TSRun `c52f272` first). Remaining (details in
`docs/LEAP_FORTH_PLAN.md` and `docs/LEAP_C_PLAN.md`), all optional:

- **Forth:** F7 (UDG and Draw tools) is optional; the optional LIB tape and
  watches; the `2 STICK` difference is fixed in v2.0.1 (the release answers
  `docs/requests/LEAP_FORTH_STICK.md`; no answer file); the
  Forth cartridge has run on TSRun's stock TS2068 only (ZEsarUX / Fuse and real
  hardware not tried).
- **Leap-C:** locals in the debugger; driving the tape example
  (`a-score-on-tape`) in the tests; running the C examples
  from cartridges against the manual's results (as V2's 695-program
  comparison); C8 tools (UDG and Draw). The Leap-C cartridge has run on
  TSRun's stock TS2068 only (Fuse / ZEsarUX with it were the Leap-C project's
  own; real hardware not tried).

Phases 1 to 5, 7 and 8 work, Phase 6's tape export (Leap's
own `LOAD` reads the IDE's `.tap`) and DCK export (a cartridge that runs on a
stock TS2068, approved by the owner on 2026-10-28) are done and verified, and
saving/opening programs, packages and the Help overlay are done. The Leap
2.1.1-emu.1 ROM entry is done (ROM table, generated keyword and error data,
packages, cartridge images, tests; the 2.1.0-emu.1 and 2.0.2-emu.1 entries stay). Nothing is on hold. Ideas, none started:

1. **Test the DCK on real hardware.** It has run on TSRun, ZEsarUX 13.0 and
   Fuse 1.9.1 with the stock ROM (same screens), not on a real TS2068.
2. **Cartridge builds for future Leap releases** (see "Adding a Leap ROM
   release", step 5).
3. **Measure the speed test again:** Leap-C 1.2.0 in TSRun, and the BASIC
   program's own printed figure on 2.1.1 (not read yet; see "Speed test").
