# Plan: Leap-C in the Leap IDE

Status: updated 2026-11-01. **C1, C2 and C3 are done** (commit `d0e437b`,
on `v1.0.0-beta.2`); C4 to C9 are open. Prerequisite (done, `3ed5d3b`):
stage 0 of [`MULTI_LANGUAGE_PLAN.md`](MULTI_LANGUAGE_PLAN.md) (the language
profile). The Leap-C project has answered the IDE's questions
([`requests/LEAP_C_ANSWERS.md`](requests/LEAP_C_ANSWERS.md)).

**Owner decision, 2026-11-01: Leap-C work proceeds now**, on the current build
(`v1.0.0-beta.2`, which TSRun already carries); it does not wait for the 1.0
release. (The earlier rule, "Leap-C work starts after 1.0", is lifted.) Every
address comes from the `.sym` files, so moving to 1.0 later means
regenerating the ROM entry and the keyword and error data at the 1.0 tag.
Only **C9 (the cartridge) waits**, for Leap-C's own `make cart` build, which
the Leap-C project is building now. Order: stage 0, then Forth and Leap-C,
both unblocked; Forth first because its release, manual and cartridge are
all complete (see `MULTI_LANGUAGE_PLAN.md`).

**Leap-C** (`~/2068-Leap-C`, github.com/nchiker/2068-Leap-C) is a C89 subset
for the TS2068, built on Leap V2's kernel. The program is kept as source text in
V2's own line-store format and compiled to native Z80 code on every `RUN`. So
the IDE's run-by-injection, ROM-compiler checker and line-table approach carry
over almost unchanged; what is new is a C editor, the error cells, and a
debugger for native code instead of V2's bytecode VM.

Overall difficulty: **medium**. The riskiest part is the debugger (stage C4),
and the answers have settled most of its questions.

Authorities, in order: the Leap-C manual (`docs/manual/01…08_*.md`) and
`spec.md` for the language; `build/leapc_home.sym` / `leapc_exrom.sym` for
addresses; the Leap-C test tools (`tools/lcharness.py`, `tools/exectest.py`,
`tools/shelltest.py`) for how the ROM is driven.

**Everything below is named by label or cell, not by address.** Addresses
move between builds, names do not (the Leap-C project keeps every name this
plan uses stable; a rename would be a breaking change, announced in its
CHANGELOG). The few addresses quoted are from `v1.0.0-beta.2` and are
examples only; the IDE's ROM entry takes every address from the `.sym`
files. Two labels the answers rely on, `STMT_DO.cond` and
`SH_WAIT_KEY.key_ret`, cost 0 bytes and are **not in the beta.2 tag's `.sym`
files**: build the `.sym` files from the Leap-C commit that carries them (the
ROM images stay byte-identical to beta.2's, so TSRun's pair still matches;
**check** the hashes), or take them from 1.0, whose emulator pack ships
`symbols/leapc_home.sym` and `leapc_exrom.sym`.

---

## Facts this plan rests on

Sources: the Leap-C project's answers (`requests/LEAP_C_ANSWERS.md`, "A")
and the repository.

| Item | Value | Source |
|---|---|---|
| Release (surveyed) | `v1.0.0-beta.2` (`b918527`); HOME `043becf4…`, EXROM `97fe9523…` = TSRun's `roms/leapc-*.rom` at the current pin. 1.0 is not out yet (owner: proceed anyway, 2026-11-01) | `build/SHA256SUMS` |
| Source line store | `[LE16 len+1][text][$0D]` per line, ASCII 32-126, max 127 chars (V2's format). An empty line is never stored (`SH_REENTER`); a line of spaces is. Lines are counted from 1 over **stored** lines, so `CC_ERRLINE` and every `TOK_LINE` do too: the IDE drops empty lines and keeps a map, as for V2 | `spec.md`, `tools/c2src.py`; A Q4.1 |
| Source region | `PROG_AREA_START` up to the code region limit; cells `PROG_END`, `ARRAYS_END`, `VARS_START`, `CUR_EDIT_INDEX` (the append line) | `.sym`, `tools/lcharness.py` |
| Compiler | `CC_PROGRAM` must run with the EXROM paged out; `SH_COMPILE` is the trampoline (page out, compile, page in; carry = error) | `.sym` |
| Run | `RT_RUN`: A = 0 and HL = exit status, or A = run-time error; the exit status is only in HL, at `RT_RUN.done` and `RT_RUN.leave` (A = `RT_ERRNUM` there too); both labels are kept stable | `spec.md`; A Q2.5 |
| Shell run | `SH_RUN` (EXROM): compile, run, report. It assumes what holds at every shell key wait: EXROM paged in, `BANK_EXROM_DEPTH` = 1, interrupts on (IM 1); it reads `CUR_EDIT_INDEX` | A Q2.2 |
| Shell loop | `SH_LOOP` is the shell's base: a typed `RUN` returns into it (`SH_DISPATCH` returns with carry clear, `SH_REENTER` goes to `SH_LOOP`); the shell's base stack depth is `SP = $FF00` (`LEAPC_STACK_TOP`), because the cold start jumps to the shell | A Q2.2 |
| Idle points | `IO_READ_KEY.wait_hit`. With `RUNNING` ≠ 0: the program waits for a key (`getkey()`, `gets()`). With `RUNNING` = 0 and the word at SP = `SH_WAIT_KEY.key_ret`: the run is over, the report is on screen. `RUNNING` = 0 and any other return address: the editor, or LIST's pager | A Q2.3 |
| Keys | `KBD_LASTK`, `KBD_KEYHIT`; SYMBOL SHIFT table changed (delta D7): SS+Y U F G S A H D = `[ ] { } \| ~ ^ \` | `spec.md` |
| Compile error | `CC_ERRNUM` (0: it compiled), `CC_ERRLINE` (1-based), column `SH_ERR_COL` | `.sym` |
| Run-time error | `RT_ERRNUM` (0: none; meaningful only when `CC_ERRNUM` = 0), `RT_ERRLINE` (the line where the failing **function's definition** starts; 0 unknown), `RT_ERRPC`; codes 1 stack overflow, 2 out of heap, 3 hi-res in use, 4 bad argument, 5 BREAK, 6 number too big | `.sym`, `spec.md`; A Q2.3 |
| Statement entry | `STATEMENT` (compiler): `TOK_LINE` is the statement's first token's line, `CG_PC` the address of its first code byte. Every statement passes through it, nested ones, labels, `case` and `default` included | A Q1.1 |
| Other line points | `DCL_AUTOINIT` (initialisers of automatic objects: `TOK_LINE` = the `=` token's line); `STMT_DO.cond` (the `while` condition of a `do`: `TOK_LINE` = the `while` token's line, `CG_PC` = the condition's first byte); `CG_UNIT.found` (the code moves to the next region: `DE` = its first byte); the `RUN_FNLINES` records (prologue address, definition line) | A Q1 |
| Line map in the image | `RUN_FNLINES`: records `[link][address][line]` (3 words) in the image's static data, newest first, ending with link 0; one per function **definition**, wherever its code starts (region 4 included); the address is the `rst ENTER` byte | A Q4.3 |
| Frame | `rst ENTER / db n` pushes `IX` and points `IX` at the saved `IX`. Locals at `IX-1 .. IX-n`, return address at `IX+2`, arguments from `IX+4`, the first argument lowest. The caller's `IX` is the word at `IX`, its return address the word at `IX+2` | A Q4.2 |
| Symbol table | `SYM_GLO` (file scope) / `SYM_LOC` (innermost scope); records in the compile workspace, **overwritten by the heap at run time**. A symbol's `S_VAL` (offset 7) is its `IX` offset when `SF_AUTO` (bit 4 of `S_FLAGS`) is set, else its static address (`include/leapc_decl.inc`). **Locals do not survive the compile**: each block's entries are reclaimed at `SCOPE_CLOSE`; at the end of `CC_PROGRAM` only the `SYM_GLO` chain is complete | `leapc_decl.inc`; A Q4.2 |
| Code placement | Four regions in order: chunk 6 (`$C000-$DFFF`), then `$E000-$F17F`, `$F400-$F7FF`, `$6000-$77FF`. Code fills a region from its low end, static data (strings, `switch` tables, `RUN_FNLINES`, static objects) from its high end. A region is skipped when under 12 bytes are left (`CG_GUARD`). A single statement or function can straddle two regions (the `jp` to the new region sits at the old `CG_PC`) | `spec.md`; A Q1.3 |
| Tape | V2's two-block format, format word `$8C00`; V2 and Leap-C refuse each other's tapes | `spec.md`, `tools/c2tape.py` |
| Libraries | `LIB "name"`: type-4 tape, word `$8D01`, ≤ 1 KB at `$F400`, `LIB_LOADED`; **one at a time** (`LIB "name"` replaces it, `LIB` alone unloads it); sits in image region 3, so a program compiled with a library loaded has no code in region 3. The release zip carries each library's `.tap` / `.tzx` / source, and `SHA256SUMS` lists every file. Not reset between runs, by design: the UDGs and a loaded library | `spec.md`; A Q4.6, Q2.2 |
| Comments | `//` and `/* */` (across lines) are both accepted | A Q4.4 |
| Graphics | Pixels x 0-255, y 0-191 **from the top**; text rows 0-23, columns 0-31. `plot(x, y)`, `draw(x0, y0, x1, y1)` (off-screen clipped to the edge), `point(x, y)`, `attr(row, col)`, `mode(n)` (0 normal, 1 hi-res colour: run-time error 3 while the image uses `$6000-$77FF`), `sprite_get` / `sprite_put`, `ink`, `paper`, `bright`, `flash`, `inverse`, `over`, `border`, `at`, `tab`, `cls` | A Q4.5 |
| UDGs | Codes 144-164 at `UDG_TABLE`, 8 bytes each, as in V2; a program writes them through a pointer (manual Part 7, example 13) | A Q4.5 |
| Waiting library calls | `getkey()` and `gets()` wait in `IO_READ_KEY.wait_hit`; `inkey()` never waits; `pause(n)` in `AY_WAIT_FRAMES`; `beep`, `sound` in the EXROM's `AY_BEEP_PLAY`; `tape_save` / `tape_load` in the block I/O. There is no `getchar` | A Q3 |
| Manual | `03_keywords.md` (58 `##` entries), `04_library.md` (52), `06_libraries.md` (7), `07_examples.md` (18), `08_appendices.md` (A reports, B compile errors, C run-time errors, H index) | `docs/manual/` |
| `.sym` files | In the 1.0 emulator pack (`symbols/leapc_home.sym`, `leapc_exrom.sym`, in its `SHA256SUMS`). Before 1.0: `make repro` rebuilds the images byte for byte, and the local `build/` has the `.sym` files | A Q4.7; Makefile |

## Stages

Each stage ends with the tests green and is committed on its own.

### C1 — ROM entry and Run

**Done (`d0e437b`).** `tools/leapc-rom-entry.py <build dir> <version>`; the
entry (`src/lang/c/leapc-roms.js`) was made from the tag built in a detached
worktree of `~/2068-Leap-C` (the release has no `.sym`; the worktree was
removed afterwards). `SH_WAIT_KEY.key_ret` does not exist in beta.2 (0 bytes
when added later), so it is derived as `SH_WAIT_KEY.read + 3` after checking
the CALL. Run is the shell path as described below. **Deviation:** Stop is
BREAK let go after `driver.breakHold` (5) frames, because Leap-C's report waits
for all keys to be released (the emulator now honours `breakHold`). **Not
done:** the exit status in the status bar.

- `tools/leapc-rom-entry.py <checkout> <version>`: build the tag (or commit)
  in a detached worktree, as for V2, check the images against the release
  `SHA256SUMS` (beta.2's: `043becf4…` / `97fe9523…`), and print a
  `KNOWN_ROMS` entry for the C profile from the two `.sym` files (every label
  and cell the C profile uses, nothing copied by hand). Like V2's script, it
  checks the bytes of the key-wait loop and fails if a label the plan uses is
  missing (`STMT_DO.cond`, `SH_WAIT_KEY.key_ret`).
- TSRun already carries the beta.2 pair at the current pin (`leapc-*.rom`,
  byte-identical); no submodule move is needed to start. When 1.0 is out,
  move the pin to a commit with the 1.0 ROMs and regenerate the entry.
- `prepare(text)`: V2's `encodeLineStore` and its checks unchanged (same
  format, same 127 limit), against the Leap-C pool (`PROG_AREA_START` up to
  the code region). Empty lines are dropped and a map kept, as for V2; a line
  holding only spaces is stored.
- `inject`: **the shell path** (Leap-C's recommendation; owner had no
  preference). It is what typing `RUN` does, so the ROM compiles, runs, shows
  its own report and does its own clean-up. From any shell key wait (PC =
  `IO_READ_KEY.wait_hit`, `RUNNING` = 0):
  1. write the line store, `PROG_END`, `ARRAYS_END` and `CUR_EDIT_INDEX` (as
     `lcharness.py` does);
  2. `SP = $FF00` (`LEAPC_STACK_TOP`); push `SH_LOOP`; push `SH_RUN`;
     `A = 7`; PC = `GFX_SET_BORDER`;
  3. let it run.
  Do **not** enter `SH_RUN` on top of the editor's stack (`EDITOR_ENTER`'s
  frames would pile up each run). `GFX_SET_BORDER` first because a run starts
  clean except for the border: `SH_RUN` clears the screen to paper 7 / ink 0,
  `RT_RUN` clears the program's state and makes an empty heap, and the border
  is reset to white only by `SH_LOOP`, after the report's key, which the IDE
  never sends. The return into `SH_LOOP` is exactly a typed `RUN`'s; no
  "after a command" label is needed. The report wait itself can be injected
  into the same way (`RUNNING` = 0 and the word at SP = `SH_WAIT_KEY.key_ret`;
  SP is then `$FEFC` with this protocol).
- **Finished or waiting for input:** at `IO_READ_KEY.wait_hit`, `RUNNING` ≠ 0
  means the program waits for a key; `RUNNING` = 0 with the word at SP =
  `SH_WAIT_KEY.key_ret` means the run is over (the report is on screen); any
  other return address is the editor or LIST's pager (not expected: the IDE
  never types there).
- `readResult`: compile error from `CC_ERRNUM` / `CC_ERRLINE` / `SH_ERR_COL`;
  run-time error from `RT_ERRNUM` / `RT_ERRLINE` (only when `CC_ERRNUM` = 0;
  Leap-C reports the line itself, unlike V2, but it is the line where the
  failing function starts); BREAK is run-time error 5. The exit status is in
  no cell (the shell's report shows "EXIT n"): capture `HL` with a watch at
  `RT_RUN.done` if the status bar should show "Finished (exit 9)".
- **Stop = BREAK only** (CAPS SHIFT + SPACE for a few frames). BREAK ends
  every wait (`getkey`, `gets`, `pause`, `beep`, `sound`, tape transfers) with
  run-time error 5, through the interrupt routine (`RT_BREAKREQ`), at the
  program's last library call; inside a section that defers BREAK (`NOBRK`
  ≠ 0: a `beep`, a tape block) it ends the program when the section ends.
  **No jump to a command loop is needed** (unlike V2); the program ends
  through `RT_RUN` and the shell reports as usual.
- Keyboard: the C profile's SYMBOL SHIFT table from Leap-C's
  `platform/kernel/io` (delta D7), so `[ ] { } | ~ ^ \` reach a running
  program. `src/pc-keyboard.js` takes it from the profile (stage 0).
- Node checks: hello world (`printf`), exit status, compile error with line
  and column, run-time error with line, BREAK (also in `getkey` and `gets`),
  re-run while busy, injecting over a finished run (at the report wait), the
  border and colours clean on the second run.

### C2 — The C editor

**Done (`d0e437b`)**: `src/lang/c/editor.js` and `leapc-scan.js`.
**Deviation:** the keyword data comes from the manual on Leap-C `main` at
`83e6e21` (the beta.2 tag has no manual); regenerate it at the 1.0 tag. The
error text comes from `include/leapc_errors.inc` at the tag. `//` and `/* */`
comments, no auto-caps, folding, Tidy, go to definition and rename of
file-scope names are in; the names are not yet cross-checked against
`LEX_KW_TABLE` / `LIB_NAMES`.

- **Tokenizer:** our own `StreamLanguage` (like V2's), not CodeMirror's
  generic C mode, so the editor knows the Leap-C subset:
  - keywords; types; preprocessor lines (`#define`, `#undef`, `#pragma hires`,
    `#include <leap.h>`);
  - **unsupported** C89 marked invalid: `long`, `union`, `volatile`,
    `long double`, other `#include`s, `#if`, function-like macros;
  - library functions (cyan, as V2's built-ins); library-package functions
    (orange, as V2's package statements);
  - strings, character constants, numbers (decimal, hex, octal, float),
    `/* */` comments across lines, and **`//` line comments** (both accepted
    by the ROM).
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

**Done (`d0e437b`)**: `src/lang/c/leapc-check.js` calls `SH_COMPILE` (the
shell's trampoline) rather than `CC_PROGRAM` directly, and the underline starts
at the error's token (column as `SH_RUN` computes `SH_ERR_COL`: `TOK_PTR` less
the line start). **Not done:** a library program (needs C6).

- A hidden second machine, as for BASIC: boot once to the key wait, snapshot;
  per check restore, write the store, page the EXROM out, call `CC_PROGRAM`
  with a return slot (the direct path of `tools/exectest.py`; the shell path
  is for Run), read `CC_ERRNUM`, `CC_ERRLINE` and `SH_ERR_COL`.
- The underline starts at the error column (more precise than V2, which has
  only the line).
- A program using a library function gets the library installed first, as for
  V2 packages.
- Node checks: one compile error of each common kind, a clean program, a
  library program.

### C4 — Debugger (native code)

The generic panel (registers, memory, Z80 breakpoints) works as is. The
Leap-specific parts need new readers.

- **Line table** by watching the compiler, the V2 trick, at these points
  (all confirmed in A Q1):
  - `STATEMENT`: record (`TOK_LINE`, `CG_PC`). Several records can share an
    address (a `case` and its statement, a label, `{` and its first statement,
    an empty statement): **at one address keep the later record**;
  - `DCL_AUTOINIT`: record (`TOK_LINE`, `CG_PC`) (initialisers of automatic
    objects, which do not pass through `STATEMENT`);
  - `STMT_DO.cond`: record (`TOK_LINE`, `CG_PC`), else a `do … while`
    condition maps to the body's last statement;
  - `CG_UNIT.found`: the code moves to the next region at **any instruction**,
    so a statement can straddle two regions; add the record (the line of the
    last record made, `DE`);
  - after the compile, add every `RUN_FNLINES` record (prologue address,
    definition line).
  Keep the table per region, in emission order, and per region only the code
  part (`[region low, the region's code end]`: static data grows down from the
  top and is never executed). Other layouts need nothing: `while` and `if`
  jumps map to the body's last statement, harmlessly; the `for` step lies
  before the body and maps to the `for` line; `switch` dispatch is inline on
  the `switch` line; `?:`, `&&`, `||`, casts and float operations are inline;
  muted code (`sizeof`, the unused side of a constant `?:`) emits nothing.
  Dropped code (`CX_DISCARD` taking back a short tail) is within the same
  statement, and no record falls inside it. Compare against `RT_ERRLINE` for
  run-time errors in the test corpus.
- **Breakpoints and Step:** a breakpoint is "PC equals the code address of a
  statement starting on that line". Step runs to the next statement start.
  **Step over cannot stop at the call's address + 3**: calls with inline
  operands return past bytes that follow them (`rst ENTER / db n`,
  `call F_LDX / db d`, `call F_LDK / 5 bytes`, `call F_OP / db op` and the
  other float calls) and `call RT_SWITCH / dw table` does not return there at
  all (it jumps to the case). So Step over stops at the next statement start,
  Step out at the frame's return.
- **Variables:** globals are at static addresses with known types (`char`,
  `int`, `unsigned`, 5-byte `float`, pointers, arrays, structs); copy the
  `SYM_GLO` chain at the end of the hidden check or the real compile (the heap
  overwrites it at run time). **Locals** (second version): `IX` is the frame
  pointer; a local is at `IX + S_VAL` when `SF_AUTO` is set; because each
  block's entries are reclaimed at `SCOPE_CLOSE`, read `SYM_LOC` at each
  `SCOPE_CLOSE` entry (the innermost scope's entries, linked outward to the
  function's parameters) and record the block's code range, from `CG_PC` at
  the matching `SCOPE_OPEN` to `CG_PC` at `SCOPE_CLOSE`. First version:
  globals only.
- **Call stack:** walk the `IX` chain: the caller's `IX` is the word at `IX`,
  its return address the word at `IX+2`; map return addresses to functions
  with `RUN_FNLINES` (`rst ENTER` addresses) and to lines with the line table.
  First version can show the current function and line.
- Memory inspector note: compiled code in `$C000-$DFFF` is RAM under the
  EXROM; reads must follow the paging.

### C5 — Tape export and Open

- `exportTape`: port `tools/c2tape.py` (header type 0, `$8C00`, line store as
  data). Verify byte for byte against the ROM's own `SAVE` in Node (as the V2
  TAP check does), and that `LOAD` reads it back.
- Open `.tap`: recognise `$8C00` and read the program back; switch to C.
- Status: `Saved X.tap: on the TS2068, LOAD "X" then RUN` (and `LIB "shapes"`
  first when the program uses it).
- DCK: stage C9.

### C6 — Libraries

- Copy the library images (`shapes.bin`, …) to `libs/c/<version>/`, checked
  against `build/libs/SHA256SUMS` (beta.2) or the release's `SHA256SUMS`
  (1.0).
- `extensionsUsed(text)`: calls to a library's functions (names from
  `06_libraries.md`) -> install before run and check, as `lcharness.py` does
  (image at `$F400`, set `LIB_LOADED`).
- **One library at a time**, as V2's packages: a program using two is an
  error on the line of the second. A library occupies image region 3, so a
  program compiled with one loaded has no code in region 3 (it fills the
  other regions); a library stays loaded between runs, so the IDE installs
  or unloads it explicitly for every run and check.

### C7 — Examples and corpus test

- Examples menu: a selection from `07_examples.md` (18 programs).
- Corpus test in `tests/rom-checks.mjs`: every manual example with
  `// expect: exit N` / `// screen:` lines run through the IDE's run path in
  Node, compared with the expectation (the V2 equivalent ran 695 programs).

### C8 — Tools (optional)

- **Draw tab:** generate `plot(x, y)` and `draw(x0, y0, x1, y1)`; y from the
  top, x 0-255, y 0-191, as in BASIC; `draw` clips off-screen coordinates to
  the edge.
- **UDG tab:** Leap-C has the 21 user-defined characters (codes 144-164, 8
  bytes each at `UDG_TABLE`), but a program writes them through a pointer
  (manual Part 7, example 13), not with a `POKE` statement. The tool inserts
  the C that does so (**check** example 13's form) and loads it back; "Send
  to TS2068" works on the live machine as in BASIC. The UDGs survive between
  runs (cleared only at the cold start).

### C9 — Cartridge (DCK) for a stock TS2068

Owner decision (2026-10-31): Leap-C gets a runtime cartridge build, as Leap V2
has (V2's: `cartridge-build/`, `docs/LEAP_CARTRIDGE_BUILD.md`,
`cartridge-build/Docs/CARTRIDGE_STATUS.md`), so ⬇ DCK and ▶ Test DCK work for
C programs. **This stage waits for the Leap-C project's `make cart` build**
(the Leap-C project is building it now; its answers had called it a
roadmap step after 1.0); the other stages do not wait.

**The Leap-C project's answers (A Q5).**

- **Hosting:** in 2068-Leap-C, as `make cart` with a build flag, the way
  2068-Forth did it. The release ROM images do not change.
- **The EXROM is needed at run time:** compiled programs reach it for float
  operations (`LEAPC_EXROM_FLOAT`), `beep` / `sound` (`LEAPC_EXROM_BEEP`) and
  `tape_save` / `tape_load` (`LEAPC_EXROM_TAPE`), each through a HOME
  trampoline that pages chunk 6 in and out. Hi-res, sprites and the report
  are in HOME (the report is the shell's, which the cartridge does not have).
  So the cartridge carries the EXROM in **DOCK chunk 6**, and chunk 6 is RAM
  (the program's region 1) except inside those trampolines.
- **Banking:** `BANK_PAGE_EXROM_IN` / `_OUT` are V2's. Cartridge: bit 7 of
  port `$FF` left at 0 (DOCK); port `$F4` = `$43` in and `$03` out. Other
  writers of `$FF`: `GFX_SET_MODE` (read-modify-write through
  `PORT_FF_SHADOW`, keeps bit 7) and the cold start; nothing else writes
  `$F4`. A loaded library uses the same routines. A program's own `outp()` can
  write any port.
- **HOME must keep every routine at the release's address**, because compiled
  code calls absolute HOME addresses (the RST helpers, `RT_*`, the float
  calls, every library function): the program is compiled by the release ROM
  in the IDE and runs on the cartridge's HOME. Each patch keeps its size and
  the build checks that the two `.sym` files agree. Two patches need care:
  `BANK_PAGE_EXROM_OUT`'s 1-byte `xor a` against `ld a, $03` (a same-size
  rearrangement, as V2's cartridge did) and the LROS header at
  `$0000-$0004`, which overlaps `IO_KEY_SCAN_ROW` at `$0004` (it moves to
  another page-zero gap; only the keyboard scan calls it).
- **Program image:** a header, then `[address, length, bytes]` blocks: one or
  two per used region (code from the region's low end, static data from its
  high end) and region 3 when a library is loaded. It sits in **DOCK chunks
  4-5** (`$8000-$BFFF`, 16 KB), mapped only during the copy (the destinations
  are chunks 3, 6 and 7, so the copy never maps over its own target); the
  regions hold about 19.4 KB in all, so an image over 16 KB would also use
  DOCK chunk 2 (`$4000-$5FFF`). The cartridge's cold start sets `PROG_END` to
  an empty store's end, because `RT_RUN` builds the heap from there.
- **After the program:** a small report in the cartridge's EXROM: "EXIT n", or
  "RUNTIME ERROR n: MESSAGE" / "LINE m" (or "BREAK") on rows 22-23 with the
  shell's own messages; then a key restarts the program, as V2's cartridge
  does.
- **Identity:** the ROM has none today. The build computes a **CRC-16 over
  HOME + EXROM** (V2's scheme) as a build constant (0 ROM bytes) and
  publishes it with the release; the image header carries it, and the
  cartridge refuses an image compiled against another build.

**IDE side:**

- `cartridge/c/<version>/` with the cartridge HOME and EXROM, a README with
  the SHA-256s, and the identity check (`romIdentity` of the IDE's ROMs = the
  published CRC-16; export refuses a mismatch).
- The C profile's `buildCartridge`: compile on the hidden checker machine
  (C3), capture the code and static-data blocks from RAM per region (`CG_PC`,
  the region limits `IMG_LIM`) and the entry, build the image in the layout
  the build defines (**to be defined by Leap-C's build**: its signature, as
  the cartridge test needs it to pick the keyboard table), pack the DCK / flat
  `.bin`. ⬇ DCK and ▶ Test DCK then work as for BASIC.
- Checks before export, as for BASIC: compile errors, the identity, writes to
  the paging ports (`outp` to 244 / 255, **check** the library name), and the
  image size (the 16 KB source chunks).
- Tests: `tests/rom-checks.mjs` runs an exported C cartridge on a stock TS2068
  to its end (exit status, a POKEd marker, as V2's section 7); the corpus
  (C7) from cartridges against `RUN` on the release ROMs, as V2's 695-program
  comparison; ZEsarUX / Fuse with the stock ROM for a few.

## Tests

- `tests/rom-checks.mjs`: a Leap-C section for each of C1 to C7.
- `tests/browser-smoke.mjs`: switch to C, run hello world, a compile error
  with the column underline, completion of a library function, tape export,
  switch back.

## Adding a Leap-C release

As for V2: build the tag in a detached worktree, compare with the release
zip, run `tools/leapc-rom-entry.py`, regenerate the keyword and error data at
the tag, copy the library images, move TSRun to a commit with the new ROMs,
run both test suites. This is also the step from beta.2 to 1.0: nothing in the
IDE should change beyond the generated data (the names are stable).

## Owner decisions

- **Release (2026-11-01):** Leap-C proceeds now on `v1.0.0-beta.2`, without
  waiting for 1.0 (this replaces 2026-10-31's "after 1.0"). Moving to 1.0
  later is regenerating the ROM entry and data.
- **Order (2026-11-01):** stage 0, then Forth and Leap-C (both unblocked);
  Forth first because its release, manual and cartridge are complete.
- **Cartridge (2026-10-31):** Leap-C gets a runtime cartridge build (C9),
  hosted in the Leap-C repository as `make cart`; C9 waits for it.
- **Run path (2026-10-31):** no preference; the Leap-C project recommended the
  shell path, which this plan uses.

## Still open

Nothing is open with the Leap-C project except its cartridge build:
[`requests/LEAP_C_QUESTIONS.md`](requests/LEAP_C_QUESTIONS.md) is answered
([`requests/LEAP_C_ANSWERS.md`](requests/LEAP_C_ANSWERS.md)); the line-table
points make a compile-time hook unnecessary (the earlier Q1.4 request is
withdrawn).

1. **The commit that carries `STMT_DO.cond` and `SH_WAIT_KEY.key_ret`** (not
   in the beta.2 tag): ask which commit or when 1.0 is tagged, to build the
   `.sym` files from (C1).
2. **The cartridge build** (C9): its program image signature and format, the
   identity value and the DOCK layout, once `make cart` exists.
