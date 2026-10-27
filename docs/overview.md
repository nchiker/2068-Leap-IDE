# Leap V2 Web IDE — Project Overview

*October 2026 (facts corrected against the Leap manual, ROM source and TSRun)*

---

## What This Is

A self-contained, browser-based IDE for writing, running, and debugging
programs in **Leap V2 BASIC** on the **Timex Sinclair 2068**. The editor, the
TS2068 emulator and the debugger all run in the browser. No build step, no
npm; it only needs a static file server (`python3 -m http.server`) because ES
modules do not load from `file://`.

The target user is someone writing Leap V2 programs who wants a modern
editing experience without leaving the browser: keyword autocomplete,
inline help, syntax errors before the ROM sees the code, and a real
debugger showing Z80 registers and Leap variables.

Leap here is **V2** (current release 2.0.2-emu.1; 2.1 is in development).
The manual and `docs/V2_LANGUAGE_REFERENCE.md` in
https://github.com/nchiker/2068-Leap are the authority for the language. V1
is archived and irrelevant.

---

## Goals

1. Write Leap V2 source in a proper editor (CodeMirror 6) with syntax
   highlighting, autocomplete, and error checking by the ROM's own compiler.
2. Click Run — the program loads into the emulated TS2068 and executes.
3. Step through code in the debugger, inspect Z80 registers and Leap
   variable values, set breakpoints.
4. Export the finished program as a Leap tape file or a DCK dock cartridge
   (formats still to be derived; see Export below).

---

## Foundation — TSRun

**TSRun** is an open-source TS2068 emulator written in plain JavaScript. The
IDE uses the fork https://github.com/nchiker/TSRun (upstream
josef-jelinek/TSRun), included in the project as the git submodule `./tsrun`,
pinned at commit `4db1f1e` (TSRun `main` with the 2.0.2 Leap ROMs, the
`sound.js` worklet fix `f65de5a` and the tape-loading fix `4db1f1e`, both
pushed). The fork's
`roms/` folder carries the Leap V2 ROMs (`leap-0.rom`, 16K HOME, and
`leap-1.rom`, 8K EXROM; the 2.0.2-emu.1 release images). TSRun provides:

- Z80 CPU emulation (`z80.js`)
- Machine, memory bus and ROM/EXROM paging (`machine.js`)
- TS2068 screen rendering with WebGL2 (`screen.js`)
- AY-3-8912 sound through an AudioWorklet (`sound.js`)
- Keyboard matrix (`keyboard.js`; the IDE uses its own `src/pc-keyboard.js`)
- Tape loading (`tape.js`) and dock cartridges (`dock.js`, parse only; accepts
  banks 0 DOCK, 254 EXROM, 255 HOME)

TSRun files are ES modules. TSRun's own `host.js` is tied to its emulator-page
desk UI, so the IDE has its own slim host in `src/emulator.js` that imports
`machine.js`, `z80.js`, `screen.js` and `sound.js`. There is no
`machine.run()` / `step()` / `poke()` API: memory goes through
`machine.bus.read/write`, and registers are fields of `machine.cpu`.

The fork has two changes. The first is in `sound.js`: it loads its worklet with
`new URL("sound.worklet.js", import.meta.url)`, so audio works from a page
that lives outside TSRun's directory (commit `f65de5a`, pushed). The IDE no
longer uses TSRun's `keyboard.js` (see Keyboard below), and no `hostBits` patch
is planned.

The second is the owner's tape-loading fix (commit `4db1f1e` on `main`, pushed;
TSRun issue #3 in josef-jelinek/TSRun; the submodule pin). Tape loading used to
stop mid-load for loaders outside EXROM chunk 0, so Leap's `LOAD` failed in
TSRun; the fix keeps the tape playing for ROM-style loaders outside EXROM chunk
0. Verified: stock-ROM tape autoload and autostart are unchanged, and Leap
`LOAD ""` of the IDE's `.tap` loads (the tape even starts by itself) and `RUN`
works. The live TSRun site, which also hosts Leap's browser demo, now loads Leap
tapes, including package tapes.

The submodule is pinned because the TSRun version must match the ROM table in
`src/leap-roms.js`: a TSRun update (e.g. new Leap ROMs) cannot break the IDE
until the pin is deliberately moved (`git -C tsrun fetch && git -C tsrun
checkout <commit>`, add the ROM entry, regenerate keywords if the manual
changed, commit the submodule bump).

**Publishing.** The repo is public at https://github.com/nchiker/2068-Leap-IDE
(branch `main`). GitHub Pages serves it at
https://nchiker.github.io/2068-Leap-IDE/, built from `main` (root folder) on
every push, and includes the public `tsrun` submodule. `index.html` forwards to
`ide.html`; `.nojekyll` makes Pages serve the files as-is.

---

## Architecture

```
ide.html
│
├── tsrun/ (git submodule of the TSRun fork, pinned 4db1f1e; ES modules imported by src/emulator.js)
│   ├── machine.js    ← machine, bus, ROM paging, frame loop
│   ├── z80.js        ← CPU
│   ├── screen.js     ← WebGL2 canvas renderer
│   ├── sound.js      ← AY audio
│   └── roms/         ← leap-0.rom, leap-1.rom
│
├── src/emulator.js   ← slim TSRun host + RAM-injection run/stop
├── src/pc-keyboard.js ← PC key -> TS2068 matrix translation
├── src/leap-roms.js  ← known ROM builds (SHA-256 -> addresses)
├── src/editor.js     ← CodeMirror 6 editor setup
├── src/leap-lang.js  ← Leap V2 StreamLanguage mode, token classes, scanSymbols
├── src/leap-keywords.js ← generated from the Leap manual (tools/gen-leap-keywords.py)
├── src/leap-check.js ← editor error check: the ROM's compiler on a hidden machine
├── src/leap-errors.js ← generated error text from the manual (tools/gen-leap-errors.py)
├── src/debugger.js   ← debugger controller (breakpoints, step) + panel UI
├── src/leap-debug.js ← line table, variables, call stack read from machine RAM
├── src/export.js     ← TAP builder (DCK waits for the Leap cartridge build; see docs/LEAP_CARTRIDGE_BUILD.md)
└── ide.js            ← orchestrator (prepare source → run → status/debug)
```

The three panels share the window:

| Panel    | Width  | Contents                                          |
|----------|--------|---------------------------------------------------|
| Editor   | rest   | CodeMirror 6, line numbers, breakpoint gutter     |
| Emulator | zoom 1×–3× | TS2068 256×192 canvas + bezel; "− 2× +" zoom control |
| Debugger | 340 px (min 240) | Registers, variables, breakpoints, call stack, memory |

The emulator receives keyboard input only while a program is running and its
screen has focus; click the screen to type into it.

**Display zoom.** TSRun's 320×240 frame (screen plus border) is always scaled by
a whole number of device pixels; a fractional scale made some pixel columns 1
and others 2 display pixels wide, so text looked uneven and thin. The "− 2× +"
control in the Display panel header picks 1×, 2× or 3×: the emulator panel
widens to fit, the editor takes the remaining width, and the zoom drops by
itself if the window is too narrow. The default is 2× when the window is at
least 1500 px wide; the choice is remembered in `localStorage`. HiDPI and
fractional `devicePixelRatio` are handled. The CRT filter is off (`setCrt(on)`
exists in the emulator API, with no UI). Leap's own font has 1-pixel strokes,
so 1× looks light by nature.

---

## How Run Works

Implemented and verified (hello world, compile error with line, BREAK stop,
`INPUT` stop, re-run while busy). The technical detail is in `CLAUDE.md`.
`window.leapIDE.emulator` exposes the emulator object (`run`/`stop`/`reset`,
`rom`, `machine`) for tests and the debugger.

1. **Prepare** — the editor text becomes Leap's line store: per line, LE16
   (length + 1), the text verbatim, `$0D`. There are no line numbers and no
   tokenising. Blank lines are dropped (the ROM editor never stores them) and
   a map back to editor line numbers is kept. Non-printable characters, lines
   over 127 characters and programs larger than the 9211-byte pool are
   refused before anything is sent.
2. **Reach a safe point** — wait until the CPU is in the ROM's key-wait loop
   (where the editor, `INPUT` and the end-of-run "press a key" idle). A busy
   program is stopped with BREAK first; if that fails, the machine is reset
   and booted to the editor (about 66 frames).
3. **Inject** — write the line store at `$825A` (`PROG_AREA_START`) and the end
   address to `PROG_END` at `$8002`.
4. **Enter the ROM** — put a return chain on the ROM's stack and jump to
   `V2_CLEAR_ARRAYS`, which flows through `V2_RESET_EDIT` into
   `V2_RUN_STORED` (what typing `RUN` does): the ROM compiles to bytecode,
   clears the screen, runs, and waits for a key. No code is written outside
   the stack.
5. **Report** — when the machine is back at the key wait with the stack at
   `$FF00` the run is over. The ROM's compile and run-time error codes are
   read from RAM; after a compile error the failing line is mapped back to the
   editor line and marked with the manual's message. A run-time error gets a
   line number too, which Leap itself cannot report: the debugger's line table
   maps `VM_IP - 1` (`VM_IP` is left just past the failing instruction) to the
   source line. The status bar shows Finished, Compile error N on line L,
   Runtime error N at line L, or Stopped (BREAK) at line N; a program waiting at `INPUT`
   or `PAUSE 0` shows "Waiting for input — click the screen to type". A
   finished run's output stays on screen (see Keyboard); Run injects at the
   "press a key" wait as before.

Stop is BREAK; if the program is waiting at `INPUT` or `PAUSE 0` the IDE
jumps straight back to the ROM's command loop, because BREAK alone does not
end an `INPUT` wait in 2.0.2. Leap 2.1 (in testing) is expected to fix that.

The IDE refuses ROMs it does not recognise: injection jumps to ROM routine
addresses that change between releases, so each ROM pair is identified by
SHA-256 and looked up in `src/leap-roms.js`. Supporting a new release means
adding one entry (see `README.md`).

The editor checks the program with the same compiler before Run (see "Syntax
Assistance"), so its errors and Run's are the same.

---

## Editor Features

### Keyword Prediction and Autocomplete
CodeMirror 6 autocomplete opens as you type. Completions come from:
- The Leap V2 keywords in the manual (statements, built-in functions, word
  operators and package statements; the commands `RUN`, `LIST`, … are left
  out because they are not valid in a program)
- The program's own `PROC` names, `DEF FN` names and labels
- Variable names the program assigns

The popup shows the keyword's first syntax form, and an info panel beside it
shows the full help. Built-in functions insert `NAME(`, since Leap functions
are always written with brackets. Block snippets with tab-stops (CM6 snippet
extension) cover `IF` … `ENDIF`, `IF` … `ELSE` … `ENDIF`, `FOR v = a TO b` …
`NEXT v`, `PROC name(p):` … `ENDP` and `DEF FN`. Completion is context-aware:
after `CALL` only `PROC` names are offered (with the parameter and line), after
`GOTO` only labels, after `FN` only `DEF FN` names.

### Auto-caps
Keywords are upper-cased automatically, with no option: after typing, Enter or
paste, `print` becomes `PRINT` (statements, built-in functions, `AND` `OR`
`NOT`, package statements). Names, strings, `REM` text, commands (`RUN`,
`SAVE`, …) and words not in V2 (`LET`, `GOSUB`, …) stay as typed, and the
latter keep their red error marking. The word under the cursor is left alone
until it is finished, and only whole words count (`tomato` stays `tomato`).
Ctrl+Z straight after restores what was typed. It is deliberately not a caps
lock: Leap stores lines verbatim and prints strings as written, so full caps
would turn `PRINT "Hello"` into `"HELLO"`. Typing into a running program
(`INPUT`) is data and is not changed.

### Built-in Help
The keyword data is generated, not written by hand:
`tools/gen-leap-keywords.py` reads the Leap manual's keyword chapter
(`docs/manual/03_keywords.md`) at a release tag and writes
`src/leap-keywords.js` (100 entries: kind, package, syntax forms, description,
example). Help therefore follows the release's own documentation, and a new
Leap release means rerunning the generator, not editing a table.

Hovering over a keyword for 500ms shows a tooltip:
- Every syntax form (e.g. `LINE x0,y0 TO x1,y1`, `BEEP seconds,semitones`)
- The kind; package statements say `needs LOAD "NAME" EXT`
- The description (the manual's first paragraph) and an example in a small
  code block

Commands such as `RUN` say they are typed at the Leap prompt. Familiar BASIC
words that V2 lacks (`LET`, `GOSUB`, `DRAW`, …) say "not in Leap V2 (language
reference §12)". Hovering a `PROC`, `DEF FN` or label name shows the line where
it is defined. The tooltips are built from DOM nodes with `textContent`.

A `?` button in the toolbar is planned (Phase 8) to open a full help overlay
with all keywords searchable, built from the same generated data — no network.
Leap differs from Sinclair BASIC (for example `INT` truncates toward zero,
`RND(n)` returns 0..n-1, `AT` and `TAB` are statements, there is no `LET`), so
the help comes from the manual, not from memory of Sinclair BASIC.

### Syntax Assistance (Error Checking) — Phase 5
The editor's checker is **the ROM's own compiler**, not a re-implementation of
its rules. A second TS2068 that is never displayed boots the same ROM images
once to the editor and is snapshotted there. 500 ms after typing stops, the
editor restores the snapshot, writes the program in, and calls the compile
routine RUN calls (`V2_CLEAR_ARRAYS` -> `V2_COMPILE_STORED`), then reads the ROM's
error code and failing line. Because it is the real compiler, the editor's
errors always equal what Run reports, for whichever Leap release is loaded;
supporting 2.1 needs no checker change beyond the ROM entry. Like the ROM, it
stops at the first error, so one error shows at a time.

The failing line is underlined from its first non-blank character, with a
message from the manual's Appendix B, for example "SYNTAX ERROR 3: an
expression could not start where it did (…)". Errors at the end of the source
(an unclosed `IF`, a `GOTO` to an unknown label) go on the last line. The same
pass reports the storage problems: non-ASCII characters, lines over 127
characters, and a program larger than the pool. The Lint button runs the check
on demand and shows the first message, or "No errors", in the status bar.

A check is about 1 ms for typical programs and about 120 ms for a 302-line
one; it runs on the main thread (a Web Worker is the option if that matters).
The message text comes from `src/leap-errors.js`, generated from the manual by
`tools/gen-leap-errors.py` and regenerated for each release. Not implemented:
checks of the IDE's own (nested `PROC`), several errors at once, and warnings
such as unused labels.

### Keyword Syntax Highlighting
Token classes via CM6 StreamLanguage (`src/leap-lang.js`), classified from the
generated keyword data. Identifiers are a letter then letters/digits, with an
optional trailing `$` and no underscore; words match whole (`tomato` is not
`TO`).
- **Statements and their parts** — amber `#e3b341`, bold (`PROC`, `IF`,
  `FOR`, `PRINT`…); the word operators `AND` `OR` `NOT` are amber
- **Package statements** — orange `#f0883e`, bold (`CIRCLE` etc.)
- **Built-in functions** — cyan `#56d4dd`
- **Strings** — phosphor green `#8ddb8c`
- **Numbers** — blue `#79c0ff` (no hex or exponent in Leap)
- **Comments** — dim grey `#545d68` (italic); `REM` runs to end of line,
  including any `:`, and `'` is not a comment character in Leap
- **Labels** — coral `#f78166` (italic): `name:` at the start of a line and the
  name after `GOTO`
- **PROC names** — lavender `#dcbdfb`: after `PROC` (definition) and after
  `CALL` / `FN`
- **Variables** — light grey `#cdd9e5`
- **Invalid** — red with a wavy underline: the commands (`RUN`, `LIST`, `NEW`,
  `SAVE`, `LOAD`, `VERIFY`, `ALL`, `ARRAY`, `EXT`) anywhere, and the words V2
  lacks (`LET`, `GOSUB`, `RETURN`, `DRAW`, `DATA`, `READ`, `RESTORE`, `COPY`,
  `ELSEIF`, `CONTINUE`, `RANDOMIZE`) only at the start of a statement and not
  followed by `=` or `(`. V2 does not reserve those words, so `data = 5` is a
  valid assignment.

`scanSymbols(text)` in the same module returns the program's PROCs, DEF FNs,
labels and variables with line numbers. Autocomplete and hover use it, and the
Phase 7 symbol table can reuse it.

---

## Keyboard

The finished IDE never allows typing in Leap's own ROM editor: all program
editing happens in CodeMirror. Keys reach the TS2068 only while an injected
program is running (`INPUT`, `INKEY$`, `PAUSE 0`) and the emulator screen has
focus. When a run ends its output stays on screen, since no keypress can
dismiss it into the Leap editor.

The TS2068 keyboard is an 8×5 matrix; symbols such as `(`, `)`, `<`, `>`, `:`,
`$` and `"` are SYMBOL SHIFT combinations. `src/pc-keyboard.js` (Phase 4, done)
maps keys as a PC keyboard is labelled: the character the PC key produces
(`e.key`) is translated to the combo that makes Leap's own key decoder
(2068-Leap `kernel/io/io.asm`, as of 2.0.2) produce that character. A PC `"`
sends SYMBOL SHIFT+P, Shift+8 `(` sends SYMBOL SHIFT+8 without CAPS SHIFT, and
`A` sends CAPS SHIFT+A (Leap gives lowercase for plain letters). Enter,
Backspace/Delete (CAPS SHIFT+0), the arrows (CAPS SHIFT+5/6/7/8, for `INPUT`
line editing) and Escape (BREAK) are mapped too. Characters Leap has no key for
(`` ^ [ ] { } \ | ~ ` ``), Ctrl/Alt/Meta combos and Tab (which would be
delete-line) are ignored. If Leap 2.1 changes its key tables, `SYMBOLS` in
`pc-keyboard.js` must follow. Verified: a 28-character string of every mapped
symbol typed into an `INPUT` came back exactly.

TSRun's `keyboard.js` maps physical keys (`e.code`) to matrix bits
unconditionally, so it cannot be told "type `(` on Shift+8" without breaking
the bare `8` key. An earlier draft proposed seven extra `hostBits` lines
(Digit8, Digit9, KeyR, KeyT, KeyZ, Digit4, KeyP). They were checked and
**rejected**: they would make 8, 9, 4, R, T, Z and P untypable everywhere.
`keyboard.js` is therefore no longer used by the IDE and is not patched.

The editor panel (CodeMirror) is plain text and needs no translation.

---

## Additional Tools (Phase 7)

### UDG Editor
21 characters (codes 144–164), each an 8×8 pixel grid. Click pixels to toggle.
Live preview. A "Write to RAM" button copies the 21 × 8 = 168 bytes to
`$F180`–`$F227` in the emulator before RUN. (Leap has no UDG statement; the
table is filled with `POKE` and printed with `CHR$(144)`…`CHR$(164)`. The
table survives `RUN`, `CLEAR` and `NEW`, but is not saved on tape and is not
initialised at start-up.)

### Symbol Table
Scans source text for all `PROC` and `DEF FN` definitions, label definitions
and variable names (assignments, `DIM`, `FOR`). Shows name, type and line
number. Clicking a symbol scrolls the editor to its definition.

### Graphics Scratchpad
A 256×192 canvas (the same size as the TS2068 screen; y runs from the top)
where you can draw `PLOT` / `LINE` paths with the mouse. The scratchpad
generates the Leap V2 `PLOT x,y` / `LINE x0,y0 TO x1,y1` statements and lets
you copy them to the clipboard or insert them at the cursor position.
`CIRCLE` and `FILL` belong to the SHAPES package and need `LOAD "SHAPES" EXT`.

### Waveform / Sound Preview
For `BEEP seconds,semitones` calls, a mini waveform diagram shows what the note
sounds like. Clicking the diagram plays it through the Web Audio API.

---

## Debugger — Phase 3

Done and verified against the real 2.0.2 ROM. Run, Stop, Pause/Continue (F8)
and Step (F10) are in the toolbar; the status bar shows "Paused at line N".

Leap programs are bytecode run by a VM, and the bytecode has no line numbers.
The IDE therefore watches the emulator: a hook runs before every Z80
instruction (`setWatch` in `src/emulator.js`). While the ROM compiles, the hook
records the source line and the bytecode address of every statement, which
gives a line table for the run. While the VM runs, it stops on breakpoints, or
at the next statement when stepping. Because the hook sees every instruction,
a debugged program runs slower than a free one.

- **Breakpoints** are set in the editor gutter and can be added while the
  program runs. A breakpoint on a line without code (a label, `REM` or blank
  line) stops at the next line that has code. A breakpoint on a `PROC` line
  also stops when the procedure is entered.
- **Step** runs to the next statement and steps into `PROC`s; **Pause** stops at
  the next statement. The line the program is about to run is marked with an
  arrow in the gutter (coral when it is on a breakpoint line). Stop while paused
  ends the program like BREAK, leaving its screen up.
- **Registers and flags:** AF, BC, DE, HL (and primed pairs), IX, IY, SP, PC,
  with C N P/V H Z S decoded from F.
- **Variables** are listed by name from the compiler's symbol table, with their
  current values: integers and floats, strings, and the first 8 elements of
  arrays. They stay visible after the run ends.
- **Call stack** is read from the VM's control stack, innermost first: the
  current `PROC` (or the main program) and line, "called from line N", and
  active `FOR` loops. Clicking a stack or breakpoint line scrolls the editor.
- **Memory inspector:** a 256-byte hex dump (8 bytes a row, 32 rows, to fit the
  column) with an editable start address.

The panel refreshes every 300 ms while a program runs. Limits: `FOR` frames
hold no line, so loops are listed without one; while a package statement runs
the EXROM is paged out, so `$C000` and up are not readable; Z80-level
breakpoints exist only as the `setWatch` API, with no UI yet. Technical detail
(addresses, layouts) is in `CLAUDE.md`.

---

## Export — Phase 6

**Tape: done and verified** (toolbar "⬇ TAP", `buildTAP` in `src/export.js`).
The file is exactly what Leap's own `SAVE "name"` writes:

- a header block (flag `$00` + 17 bytes: type 0; the name, 10 bytes
  space-padded, as typed, because `LOAD "name"` is a case-sensitive exact match;
  the line-store length; **Leap's tape format word** `V2_FORMAT_WORD`, `$8101`
  in 2.0.2, in the stock "autostart" field, which `LOAD` insists on; the program
  length, equal to the length for a plain program);
- a data block (flag `$FF`) holding the line store exactly as in RAM;
- XOR checksums, and in the `.tap` file each block prefixed with its LE16
  length. Stock ROM pulse timings, which is what `.tap` assumes.

The format word is a ROM-table field (`tapeFormatWord` in `src/leap-roms.js`,
generated by `tools/leap-rom-entry.py`). V2 has no autorun: on the TS2068, type
`LOAD ""` (or `LOAD "name"`) and then `RUN`. Verified byte for byte against
Leap's real `SAVE` (a `STORAGE_SEND_BLOCK` capture in Node) and loaded back by
Leap's real `LOAD` with the program intact; the browser download is identical.
The button prompts for the tape name (default: the file name) and reports
`Saved X.tap: on the TS2068, LOAD "X" then RUN`. Loading it in TSRun needs the
pending tape-loading fix described under Foundation.

**DCK: needs a Leap cartridge build.** Leap 2.0.2 never looks at the dock and
its cold start clears RAM, so a cartridge for a *stock* TS2068 requires a
runtime-only build of Leap (planned for 2.1, no editor). The spec is
[`LEAP_CARTRIDGE_BUILD.md`](LEAP_CARTRIDGE_BUILD.md):

- Leap's HOME image in DOCK chunks 0-1 and its EXROM image in chunk 6; HSR
  (`$F4`) = `$43` and DECR (`$FF`) bit 7 = 0 keep Leap's code mapped.
- Four port writes change under a build flag.
- An LROS header (type 1, chunk spec `$BC`) and a `di` entry stub let the stock
  ROM start it.
- The program is precompiled: the bytecode and `SYM_COUNTS` from Leap's own
  compiler (the IDE's hidden checker machine) sit in DOCK chunk 3; cold start
  copies them to `VM_CODE_BASE` and starts the VM.
- Packages and tape are not in the first version.

The "⬇ DCK" button only explains this in the status bar for now. The DCK
container: a 9-byte header (bank id + 8 chunk descriptors: 0 absent, 1 RAM,
2 ROM, 3 initialised RAM) then 8 KB images (reference:
github.com/jon0x0/AISkill_TS2068). The builder follows the spec's "IDE side"
section once the cartridge build exists.

---

## Build Priority

| Phase | Feature                            | Effort | Status |
|-------|------------------------------------|--------|--------|
| 1     | IDE shell + TSRun + program runs   | High   | Done, verified |
| 2     | CodeMirror 6 + Leap syntax         | High   | Done, verified |
| 3     | Debugger (registers, step)         | High   | Done, verified |
| 4     | Keyboard translation + INPUT mode  | Medium | Done, verified |
| 5     | Error checking (ROM compiler)      | Medium | Done, verified |
| 6     | Tape + DCK export                  | Medium | TAP done, verified; DCK needs the Leap cartridge build (spec written) |
| 7     | UDG editor, symbol table           | Low    | Not started |
| 8     | Help overlay, themes, polish       | Low    | Not started |

---

## Source Repositories

- **Leap** (ROM source, manual): https://github.com/nchiker/2068-Leap
  (local clone `~/2068-Leap`)
- **TSRun** (emulator): fork https://github.com/nchiker/TSRun, upstream
  https://github.com/josef-jelinek/TSRun (git submodule `./tsrun`, pinned at
  `4db1f1e`)
- **This project**: `/home/charlie.day/Projects/Leap-IDE`
- **Leap V2 ROMs**: `tsrun/roms/leap-0.rom` / `leap-1.rom` (not stored in this
  repo)
- **Mock-up**: `docs/mockup.html` (open in browser; a visual target only)
