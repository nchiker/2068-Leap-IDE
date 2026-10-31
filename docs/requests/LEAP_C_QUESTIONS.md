# Questions from the Leap IDE for 2068-Leap-C

From: the Leap IDE (github.com/nchiker/2068-Leap-IDE), 2026-10-31.
For: the 2068-Leap-C project, to answer before the IDE's Leap-C work starts.

## Background

The Leap IDE is a browser IDE for Leap V2 BASIC that runs the real ROMs in the
TSRun emulator. It will support Leap-C 1.0 (plan: `docs/LEAP_C_PLAN.md` in the
IDE repository). The IDE never patches or re-implements the ROM. It:

- writes the program into the source line store and enters the ROM at a safe
  point (the key wait, `IO_READ_KEY.wait_hit`) to run it, the way the
  project's own `tools/lcharness.py` / `exectest.py` do;
- checks the program as you type by running the ROM's own compiler on a
  second, hidden machine;
- debugs by watching the CPU before each instruction (a JavaScript hook: "is
  the PC at address X?"), and reads RAM.

Everything the IDE does is keyed to symbol addresses taken from the release's
`.sym` files, so what matters to it is **stable, documented labels and
cells**, not new code. Labels cost no ROM bytes; we know the reserves are
small and the ROM is feature-complete, so every request below says what it
would cost and has a zero-byte fallback.

Addresses quoted are from the local `v1.0.0-beta.2` build (`b918527`); the IDE
will use the 1.0 release.

---

## Q1 (main). Mapping compiled code back to source lines

The debugger needs, for any PC inside compiled code, the source line (for
breakpoints, Step, "Paused at line N"). Leap-C keeps only a per-function map
(`RUN_FNLINES`).

**What the IDE plans to do (no ROM change):** while the IDE's hidden machine
compiles, stop at `STATEMENT` (`$303A`) and record `(TOK_LINE, CG_PC)`. The
line of an address is then the last statement start at or below it, per code
region. This is how the IDE already builds V2's line table, by watching V2's
compiler.

**What we found reading `src/compiler/stmt.asm`:** in `STMT_FOR`, the step
expression is compiled by `STMT_EXPR` before the body, so its code lies
between the condition and the body and maps to the `for` line, which is what
we want; the jump back (`LOOP_BACK`) maps to the last statement of the body.

**Please answer:**

1. Is `STATEMENT` entry the right point, i.e. at that moment is `TOK_LINE` the
   line of the statement's first token and `CG_PC` the address of its first
   code byte? Are there statements that do not pass through `STATEMENT` but
   emit code (declarations with initialisers, the function prologue / epilogue
   (`ENTER` / `LEAVE`), `case` labels)?
2. Which constructs emit code **away from** their statement, so that "last
   statement start at or below" would name the wrong line? (`switch`
   dispatch tables, `do … while` conditions, `?:`, `&&` / `||` chains,
   float helpers, string literals or static data placed inline?)
3. **Code regions.** Code is placed in chunk 6 `$C000-$DFFF`, then
   `$E000-$F17F`, `$F400-$F7FF`, `$6000-$77FF`. Where in the compiler does
   `CG_PC` move to the next region (a label we can watch), and can a single
   statement's code straddle two regions?
4. **Optional, only if (2) shows real gaps:** would the project accept a
   compile-time hook, e.g. a documented label `CC_STMT_START` placed where
   the above holds (zero bytes if it can sit on existing code), or, if bytes
   allow, a line table written to a RAM buffer whose address the host puts
   in a cell (e.g. 3 bytes per statement: line LE16 low bits + address)? We
   expect the zero-byte answer to be enough.

## Q2. Running a program the way typing `RUN` does

The owner chose the **shell path**: the IDE wants the ROM's own report screen,
exactly as after typing `RUN`. Plan: at the key wait in the editor, write the
line store, `PROG_END`, `ARRAYS_END` and `CUR_EDIT_INDEX` (as
`lcharness.py:440-447` does), then push a return address and jump to
`SH_RUN` (`$C101`), so that after the report the shell carries on as if the
user had typed `RUN`.

**Please answer:**

1. What state does `SH_RUN` assume on entry (editor state, `CUR_EDIT_INDEX`,
   display, the EXROM paged in, stack depth)? Is entering it from the key
   wait inside `EDITOR_ENTER` safe, or must the IDE first unwind to
   `SH_LOOP` / `SH_REENTER`?
2. What should the return address be so the shell redraws the editor and
   waits for keys as after a typed `RUN` (`SH_LOOP` `$C021`? `SH_REENTER`
   `$C038`)? A dedicated label for "after a command" would make this stable.
3. After the report, the ROM waits in `SH_WAIT_KEY` (`.read` `$C1E8`). Does
   that wait go through `IO_READ_KEY.wait_hit` (`$02C0`)? The IDE detects
   "program finished" as "at the key wait with the shell's stack depth".
4. The exit status is only in HL when `RT_RUN` returns. Is there a cell that
   keeps it after the report (the IDE would show "Finished (exit 9)")? If not,
   the IDE will watch `RT_RUN.done` (`$368A`); please keep that label.

## Q3. Stopping a program that waits for input

In V2, BREAK does not end an `INPUT` wait, so the IDE jumps back to the
command loop. **Please answer:** which library functions wait for keys
(`getchar`, `gets`, `kbhit`-style polling, …), where do they idle (the same
`IO_READ_KEY.wait_hit`?), does BREAK (CAPS SHIFT+SPACE) end each of them with
run-time error 5, and if not, what is a safe way back to the shell?

## Q4. Smaller questions (one line each is enough)

1. **Blank lines:** does the editor store empty lines? Is `CC_ERRLINE` counted
   over stored lines (so the IDE must drop blank lines and keep a map, as for
   V2)?
2. **Locals:** IX is the frame pointer (`codegen.asm:10`). What is the frame
   layout (parameters at positive, locals at negative offsets? the saved IX and
   return address?), so the debugger can show locals and walk the call stack?
   Is the `SYM_GLO` / `SYM_LOC` chain complete at the end of `CC_PROGRAM`
   (locals of every function, or only the last one)?
3. **`RUN_FNLINES`:** confirm the record format `[link][address][line]` and
   that it covers every function, including ones placed in region 4.
4. **Comments:** does Leap-C accept `//` comments (the manual's examples use
   `// expect:` lines)?
5. **Graphics and UDGs** (for the IDE's Draw and UDG tools): the function
   names and coordinate convention (is y from the top, as in V2?), and does
   Leap-C have user-defined characters (V2: codes 144-164 at `$F180`)?
6. **Libraries:** can only one library be loaded at a time (V2: one package)?
   Will the 1.0 release zip carry the library images with a `SHA256SUMS`?
7. **`.sym` files:** could the 1.0 release include `leapc_home.sym` and
   `leapc_exrom.sym` (or a `symbols/` folder, as 2068-Forth's bundle does)?
   The IDE can rebuild them with `make repro`, but shipping them makes the
   IDE's ROM entry checkable against the release itself.

## Summary of what we ask for

| Item | Cost | Needed? |
|---|---|---|
| Answers to Q1-Q4 | none | yes |
| Keep these labels stable across releases: `STATEMENT`, `SH_RUN`, `SH_LOOP` / the return point, `RT_RUN.done`, `IO_READ_KEY.wait_hit` | none | yes |
| A label for the shell's "after a command" return point | 0 B | helpful |
| `.sym` files in the release | none | helpful |
| A compile-time line hook or table (Q1.4) | 0 B (label) or a few bytes | only if Q1.2 shows gaps |
