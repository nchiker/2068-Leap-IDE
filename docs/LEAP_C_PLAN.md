# Plan: Leap-C in the Leap IDE

Status: proposal, 2026-10-31. Nothing here is started. Prerequisite: stage 0 of
[`MULTI_LANGUAGE_PLAN.md`](MULTI_LANGUAGE_PLAN.md) (the language profile).

**Leap-C** (`~/2068-Leap-C`, github.com/nchiker/2068-Leap-C) is a C89 subset
for the TS2068, built on Leap V2's kernel. The program is kept as source text in
V2's own line-store format and compiled to native Z80 code on every `RUN`. So
the IDE's run-by-injection, ROM-compiler checker and line-table approach carry
over almost unchanged; what is new is a C editor, the error cells, and a
debugger for native code instead of V2's bytecode VM.

Overall difficulty: **medium**. The riskiest part is the debugger (stage C4).

Authorities, in order: the Leap-C manual (`docs/manual/01…08_*.md`) and
`spec.md` for the language; `build/leapc_home.sym` / `leapc_exrom.sym` for
addresses; the Leap-C test tools (`tools/lcharness.py`, `tools/exectest.py`,
`tools/shelltest.py`) for how the ROM is driven. Addresses below are from the
local `v1.0.0-beta.2` build and move between releases.

**Target release: Leap-C 1.0** (owner, 2026-10-31: it will be out of beta
before this project starts). Every address and count below must be re-read
from the 1.0 build; the facts are expected to hold, the values will not.

---

## Facts this plan rests on

| Item | Value | Source |
|---|---|---|
| Release (surveyed) | `v1.0.0-beta.2`; HOME `043becf4…`, EXROM `97fe9523…` | `build/SHA256SUMS`; = TSRun's `roms/leapc-*.rom` at the current pin |
| Source line store | `[LE16 len+1][text][$0D]` per line, ASCII 32-126, max 127 chars (V2's format) | `spec.md:267`, `tools/c2src.py:37` |
| Source region | `PROG_AREA_START` `$7800` up to `$C000`; `PROG_END` `$5B02`; `ARRAYS_END` `$5D2D`, `VARS_START` `$5D2F` | `.sym`, `tools/lcharness.py:440-447` |
| Compiler | `CC_PROGRAM` `$3445` (HOME), must run with the EXROM paged out; `SH_COMPILE` `$2EED` is the trampoline (page out, compile, page in; carry = error) | `.sym`, `src/rom/home.asm:232` |
| Run | `RT_RUN` `$3649`: A = 0 and HL = exit status, or A = run-time error | `spec.md:631` |
| Shell run | `SH_RUN` `$C101` (EXROM): compile, run, report; `SH_RUN.ccdone` `$C10A` | `src/shell/shell.asm:190` |
| Idle point | `IO_READ_KEY.wait_hit` `$02C0`; report screens wait in `SH_WAIT_KEY` (`.read` `$C1E8`) | `.sym`, `shell.asm:318` |
| Keys | `KBD_LASTK` `$5C6B`, `KBD_KEYHIT` `$5C6C`; SYMBOL SHIFT table changed (delta D7): SS+Y U F G S A H D = `[ ] { } \| ~ ^ \` | `spec.md:95, 743-753` |
| Compile error | `CC_ERRNUM` `$5EB1`, `CC_ERRLINE` `$5EB2` (1-based), column `SH_ERR_COL` `$5F42` | `.sym` |
| Run-time error | `RT_ERRNUM` `$5EB7`, `RT_ERRLINE` `$5EBA`, `RT_ERRPC` `$5EB8`; codes 1 stack overflow, 2 out of heap, 3 hi-res in use, 4 bad argument, 5 BREAK, 6 number too big | `.sym`, `spec.md:655-666` |
| Statement entry | `STATEMENT` `$303A` (compiler), with `TOK_LINE` `$5D61` and `CG_PC` `$5E84` (next code byte) | `src/compiler/stmt.asm:198`, `.sym` |
| Line map in the image | `RUN_FNLINES` `$5EAB`: per-function records `[link][address][line]` only | `spec.md:666-680` |
| Symbol table | `SYM_GLO` `$5E38` / `SYM_LOC` `$5E3A`; records in the compile workspace below `$C000`, **overwritten by the heap at run time** | `include/leapc_decl.inc:25-33, 82-96`, `spec.md:298-305` |
| Code placement | chunk 6 `$C000-$DFFF`, then `$E000-$F17F`, `$F400-$F7FF`, `$6000-$77FF` | `spec.md:234-246, 280` |
| Tape | V2's two-block format, format word `$8C00`; V2 and Leap-C refuse each other's tapes | `spec.md:906-923`, `tools/c2tape.py` |
| Libraries | `LIB "name"`: type-4 tape, word `$8D01`, ≤ 1 KB at `$F400`, `LIB_LOADED` `$5F54`; `libs/shapes.asm` -> `build/libs/shapes.bin` | `spec.md:191-219, 867-902` |
| Manual | `03_keywords.md` (58 `##` entries), `04_library.md` (52), `06_libraries.md` (7), `07_examples.md` (18), `08_appendices.md` (A reports, B compile errors, C run-time errors, H index) | `docs/manual/` |
| `.sym` files | Not in the release zips; `make repro` rebuilds the images byte for byte | Leap-C README / Makefile |

## Stages

Each stage ends with the tests green and is committed on its own.

### C1 — ROM entry and Run

- `tools/leapc-rom-entry.py <checkout> <version>`: build the tag in a detached
  worktree (as for V2), check the images against the release `SHA256SUMS`,
  and print a `KNOWN_ROMS` entry for the C profile from the two `.sym` files
  (every address the C profile uses, nothing copied by hand). Like V2's script,
  it checks the bytes of the key-wait loop.
- Move the TSRun submodule to a commit whose `leapc-*.rom` are the 1.0
  release (today's pin carries beta.2), and confirm the hashes against the
  release's `SHA256SUMS`.
- `prepare(text)`: V2's `encodeLineStore` and its checks unchanged (same
  format, same 127 limit), against the Leap-C pool (`$7800`-`$C000`). Unlike
  V2, keep blank lines? **Check** whether Leap-C's editor stores empty lines
  (it matters for line numbers in errors; `CC_ERRLINE` is 1-based over stored
  lines).
- `inject`: write the store and `PROG_END` (and `ARRAYS_END` /
  `CUR_EDIT_INDEX` as `lcharness.py` does), then start the run by the entry
  the Leap-C project recommends (owner, 2026-10-31: no preference, whatever
  works best for both projects; asked in `requests/LEAP_C_QUESTIONS.md` Q2).
  The IDE's lean is the **shell path**: a return chain into what typing `RUN`
  calls (`SH_RUN`), so the ROM compiles, runs and shows its own report, and
  ends in its key wait like V2's `V2_RUN_STORED`; find the shell's
  command-loop re-entry for the chain end (V2: `V2_COMMAND_LOOP.loop`). The
  alternative, the direct path (`BANK_PAGE_EXROM_OUT`, `CC_PROGRAM`, `RT_RUN`
  with a return slot at `$FF00`, `tools/exectest.py:186-216`), shows no
  report and leaves the clean-up after a run to the IDE. The direct path is
  the model for the checker (C3) either way.
- `readResult`: compile error from `CC_ERRNUM` / `CC_ERRLINE` / `SH_ERR_COL`;
  run-time error from `RT_ERRNUM` / `RT_ERRLINE` (Leap-C reports the line
  itself, unlike V2); BREAK is run-time error 5. The exit status is only in HL
  when `RT_RUN` returns: capture it with a watch at `RT_RUN.done` (`$368A`) if
  the status bar should show "Finished (exit 9)".
- Stop: BREAK while busy; for a program waiting for input, find Leap-C's
  equivalent of V2's command-loop jump. **Check** which library calls wait
  for keys (`getchar`, `gets`, … in `04_library.md`) and where they idle.
- Keyboard: the C profile's SYMBOL SHIFT table from Leap-C's
  `platform/kernel/io` (delta D7), so `[ ] { } | ~ ^ \` reach a running
  program. `src/pc-keyboard.js` takes it from the profile (stage 0).
- Node checks: hello world (`printf`), exit status, compile error with line
  and column, run-time error with line, BREAK, re-run while busy, injecting
  over a finished run.

### C2 — The C editor

- **Tokenizer:** our own `StreamLanguage` (like V2's), not CodeMirror's
  generic C mode, so the editor knows the Leap-C subset:
  - keywords; types; preprocessor lines (`#define`, `#undef`, `#pragma hires`,
    `#include <leap.h>`);
  - **unsupported** C89 marked invalid: `long`, `union`, `volatile`,
    `long double`, other `#include`s, `#if`, function-like macros;
  - library functions (cyan, as V2's built-ins); library-package functions
    (orange, as V2's package statements);
  - strings, character constants, numbers (decimal, hex, octal, float),
    `/* */` comments (C89 has no `//`: **check** whether Leap-C accepts `//`;
    the manual's examples use `// expect:` lines).
- **No auto-caps.** C is case-sensitive (`while` is a keyword, `WHILE` a name).
- **Keyword data, generated, never hand-edited:**
  `tools/gen-leapc-keywords.py <checkout> <ref> > src/lang/c/leapc-keywords.js`
  from `03_keywords.md` (`## name` entries: syntax, kind, first paragraph,
  first example), `04_library.md` (signature line `` `int abs(int n)` --
  **function** ``, description, example) and `06_libraries.md`. Cross-check
  the names against `src/compiler/keywords.asm` (`LEX_KW_TABLE`) and
  `src/compiler/libnames.asm` (`LIB_NAMES`) and fail on a mismatch.
- **Error text, generated:** `tools/gen-leapc-errors.py` from
  `08_appendices.md` Appendices B and C (or from `include/leapc_errors.inc`,
  the ROM's single source; pick one and cross-check with the other).
- Completion: keywords, library functions with signatures as detail,
  snippets (`if`, `if/else`, `for`, `while`, `do/while`, `switch`, a function,
  `int main(void)`), the program's globals and functions.
- Structure tools: fold on `{ }` (a `foldService` over brace pairs, skipping
  strings and comments), indent by brace depth, Tidy, block match on braces.
- Symbols: functions, globals, `#define`s, `typedef`s, `struct` / `enum` tags.
  Go to definition for those. Rename: functions, globals, macros; locals only
  within their function (C scoping; refuse when unsure).
- Line limit: 127 as in BASIC.
- Help overlay: groups from Appendix H; links to the Leap-C manual at the
  release tag.

### C3 — Error checking with the ROM's compiler

- A hidden second machine, as for BASIC: boot once to the key wait, snapshot;
  per check restore, write the store, page the EXROM out, call `CC_PROGRAM`
  with a return slot, read `CC_ERRNUM`, `CC_ERRLINE` and the column.
- The underline starts at the error column (more precise than V2, which has
  only the line).
- A program using a library function gets the library installed first, as for
  V2 packages.
- Node checks: one compile error of each common kind, a clean program, a
  library program.

### C4 — Debugger (native code)

The generic panel (registers, memory, Z80 breakpoints) works as is. The
Leap-specific parts need new readers.

- **Line table** by watching the compiler, the same trick as V2: at
  `STATEMENT` (`$303A`) record `(TOK_LINE, CG_PC)`. **Risks to check first:**
  - code is split over four regions; keep the table per region, in emission
    order;
  - a single-pass compiler may emit some code away from its statement (the
    increment of a `for`, the jump back of a `while`, `switch` tables), so
    "last statement start at or below the address" can misattribute. Compare
    against `RT_ERRLINE` for run-time errors in the test corpus.
- **Breakpoints and Step:** a breakpoint is "PC equals the code address of a
  statement starting on that line". Step runs to the next statement start;
  Step over / Step out need the call structure (below). This is simpler than
  V2's VM hooks because the program is native code.
- **Variables:** the symbol table is overwritten by the heap at run time, so
  copy it (the `SYM_GLO` chain) at the end of the hidden check or the real
  compile. Globals are at static addresses with known types (`char`, `int`,
  `unsigned`, 5-byte `float`, pointers, arrays, structs). Locals need the
  frame layout of the generated code (**check** which register is the frame
  pointer, if any); first version: globals only.
- **Call stack:** return addresses on the Z80 stack, mapped to functions with
  `RUN_FNLINES` or the copied symbol table. Needs the frame layout to walk
  reliably; first version: the current function and line.
- Memory inspector note: compiled code in `$C000-$DFFF` is RAM under the
  EXROM; reads must follow the paging.

### C5 — Tape export and Open

- `exportTape`: port `tools/c2tape.py` (header type 0, `$8C00`, line store as
  data). Verify byte for byte against the ROM's own `SAVE` in Node (as the V2
  TAP check does), and that `LOAD` reads it back.
- Open `.tap`: recognise `$8C00` and read the program back; switch to C.
- Status: `Saved X.tap: on the TS2068, LOAD "X" then RUN` (and `LIB "shapes"`
  first when the program uses it).
- No DCK: Leap-C has no cartridge build; the button says so. (A cartridge
  build would be its own project, like V2's `cartridge-build/`.)

### C6 — Libraries

- Copy the release's library images (`shapes.bin`, …) to
  `libs/c/<version>/`, checked against `build/libs/SHA256SUMS` /
  the release.
- `extensionsUsed(text)`: calls to a library's functions (names from
  `06_libraries.md`) -> install before run and check, as
  `lcharness.py:429` does (image at `$F400`, set `LIB_LOADED`).
- **Check** whether more than one library can be loaded at once (V2: one).

### C7 — Examples and corpus test

- Examples menu: a selection from `07_examples.md` (18 programs).
- Corpus test in `tests/rom-checks.mjs`: every manual example with
  `// expect: exit N` / `// screen:` lines run through the IDE's run path in
  Node, compared with the expectation (the V2 equivalent ran 695 programs).

### C8 — Tools (optional)

- Draw tab: generate Leap-C graphics calls. **Check** the function names and
  coordinate convention (y from the top?) in `04_library.md`.
- UDG tab: **check** whether Leap-C has user-defined characters; if not, hide
  the tab for C.

## Tests

- `tests/rom-checks.mjs`: a Leap-C section for each of C1 to C7.
- `tests/browser-smoke.mjs`: switch to C, run hello world, a compile error
  with the column underline, completion of a library function, tape export,
  switch back.

## Adding a Leap-C release

As for V2: build the tag in a detached worktree, compare with the release
zip, run `tools/leapc-rom-entry.py`, regenerate the keyword and error data at
the tag, copy the library images, move TSRun to a commit with the new ROMs,
run both test suites.

## Owner decisions (2026-10-31)

- **Release:** Leap-C 1.0, which will be out of beta before this starts.
- **Run path:** no preference; whichever works best for the IDE and Leap-C.
  The IDE leans towards the shell path; the Leap-C project is asked to
  recommend (Q2 of the questions).

## Still open

Questions for the ROM project, to take back: [`requests/LEAP_C_QUESTIONS.md`](requests/LEAP_C_QUESTIONS.md).

1. **Could Leap-C emit a per-statement line table** (a debug build or a
   flag)? Not needed if watching `STATEMENT` works, but it would make C4
   robust.
