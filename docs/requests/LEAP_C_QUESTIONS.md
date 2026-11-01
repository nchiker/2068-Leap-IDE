# Questions from the Leap IDE for 2068-Leap-C

Answered 2026-11-01: see [LEAP_C_ANSWERS.md](LEAP_C_ANSWERS.md).

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

## Q2. How the IDE should start a program: your recommendation

The owner has no preference here: the IDE should use whichever entry works
best for both projects. We would like the Leap-C project to recommend one.

**What the IDE needs from a run** (this is how it drives Leap V2 today):

1. **Start from the editor's key wait.** The IDE single-steps until the CPU is
   in `IO_READ_KEY.wait_hit` (`$02C0`) with the EXROM paged in, writes the line
   store, `PROG_END`, `ARRAYS_END` and `CUR_EDIT_INDEX` (as
   `lcharness.py:440-447` does), pushes return addresses on the stack and
   jumps to a ROM routine. It writes no code into RAM.
2. **Leave the output on screen.** When the program ends (finished, error,
   BREAK), its screen stays visible. The IDE never sends a key to dismiss it,
   because the user does not type into the ROM's editor in the IDE.
3. **End at a key wait the IDE can recognise** (`IO_READ_KEY.wait_hit` at a
   known stack depth), from which the next Run can be injected the same way.
   The IDE tells "finished" apart from "the program waits for input" by the
   stack depth at that wait.
4. **Read the result from RAM:** compile error (`CC_ERRNUM`, `CC_ERRLINE`,
   `SH_ERR_COL`), run-time error (`RT_ERRNUM`, `RT_ERRLINE`), and if possible
   the exit status.
5. **Start in a clean state each time:** default colours, border, display mode
   and an empty heap, as a typed `RUN` gives. (In V2 the IDE had to add the
   ROM's display reset to the chain, because one run's colours carried into
   the next.)

**The two entries we know of:**

| | Shell path | Direct path |
|---|---|---|
| How | A return chain into `SH_RUN` (`$C101`, EXROM): compile, run, report, as after typing `RUN` | `BANK_PAGE_EXROM_OUT`, `CC_PROGRAM`, `RT_RUN` with a return slot at `$FF00` (`tools/exectest.py:186-216`) |
| Screen | The ROM's own report line (error with line and column, or the exit status) | The program's output only; no report |
| Afterwards | The shell's report wait, `SH_WAIT_KEY` (`.read` `$C1E8`) | The return slot; the IDE must put the machine back somewhere idle itself |
| Depends on | `SH_RUN`'s entry state and the shell's return point | Paging, the compile/run sequence and the ROM's clean-up after a run, done by the IDE |

The IDE leans towards the **shell path**: it mirrors how the IDE runs V2 (it
calls what typing `RUN` calls, `V2_RUN_STORED`), it shows the same report the
user would see on a real TS2068, and the ROM keeps doing its own clean-up.
But you know the shell; if the direct path, or another entry, fits better,
say so.

**Please answer:**

1. Which entry do you recommend, and why?
2. For the shell path: what state does `SH_RUN` assume on entry (editor
   state, `CUR_EDIT_INDEX`, display, the EXROM paged in, stack depth)? Is
   entering it from the key wait inside `EDITOR_ENTER` safe, or must the IDE
   first unwind to `SH_LOOP` / `SH_REENTER`? What should the return address
   be so the shell carries on as after a typed `RUN` (`SH_LOOP` `$C021`?
   `SH_REENTER` `$C038`?); a dedicated label for "after a command" would make
   it stable.
3. Does `SH_WAIT_KEY` wait through `IO_READ_KEY.wait_hit`? Can the IDE inject
   the next run from that wait (as it does in V2 at the "press a key" after a
   run), or must it first get back to the editor?
4. For the direct path: what does the shell do after `RT_RUN` that the IDE
   would have to repeat (paging, border, heap, `RUNNING`, display mode)?
5. The exit status is only in HL when `RT_RUN` returns. Is there a cell that
   keeps it (the IDE would show "Finished (exit 9)")? If not, the IDE will
   watch `RT_RUN.done` (`$368A`); please keep that label.

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

## Q5. A runtime cartridge build (owner decision, 2026-10-31)

The owner wants Leap-C programs to run as a cartridge on a **stock** TS2068
(stock HOME and EXROM installed, nothing replaced), as the IDE already does
for Leap V2. V2's cartridge build is described in the Leap IDE repository:
`docs/LEAP_CARTRIDGE_BUILD.md` (design), `cartridge-build/` (a patch on
Leap's tag: `V2_CARTRIDGE` flag, `make cart`) and
`cartridge-build/Docs/CARTRIDGE_STATUS.md` (as built). In short: Leap's HOME
in DOCK chunks 0-1, its EXROM in DOCK chunk 6, an LROS header at DOCK `$0000`
so the stock ROM starts it, the banking routines changed so they never page
the cartridge out (`BANK_PAGE_EXROM_OUT` writes `$03` to port `$F4`, not 0),
and the compiled program in DOCK chunk 3, copied to RAM at start-up.

For Leap-C the program part is simpler: no VM, the compiled code runs as it
is. But compiled code calls the HOME (bank rule 1, `spec.md:157`), so the
cartridge must carry Leap-C's HOME.

**Please answer:**

1. **Would you host it** as a `make cart` target with a build flag in
   2068-Leap-C (recommended by the IDE: you know the free bytes and the
   paging), or should the IDE keep a patch on your release tag, as it does for
   V2?
2. **Is the EXROM needed at run time?** The float core is in the EXROM;
   what else do compiled programs reach there (hi-res, sprites, tape
   functions, the report)? If any, the cartridge carries the EXROM in DOCK
   chunk 6 too, and the program's own chunk-6 code region (`$C000-$DFFF` RAM)
   must be paged against the DOCK EXROM instead of the stock one.
3. **Banking:** Leap-C uses V2's `BANK_PAGE_EXROM_IN/OUT`; do the V2 changes
   (`$F4` = `$43` / `$03`, `$FF` bit 7 left at 0) carry over, and what else
   writes ports `$F4` / `$FF` (the hi-res mode, the library)?
4. **Program image:** the IDE proposes a header (signature, format, ROM
   identity, entry address) and blocks `[address, length, bytes]` for the code
   regions and a loaded library, which the cartridge copies to RAM and then
   calls `RT_RUN` on. Where in the DOCK should it sit so the copy never maps a
   chunk over its own destination (the destinations cover chunks 3, 6 and 7;
   DOCK chunks 4-5 mapped only during the copy?), and how large can a program
   get?
5. **After the program:** what should the cartridge show (exit status,
   run-time error and line) without the shell, and then restart on a key as
   V2's does?
6. **Identity:** which value identifies the HOME build the code was compiled
   against (V2 uses a CRC-16 over HOME + EXROM)?

## Summary of what we ask for

| Item | Cost | Needed? |
|---|---|---|
| Answers to Q1-Q5 | none | yes |
| Keep these labels stable across releases: `STATEMENT`, `SH_RUN`, `SH_LOOP` / the return point, `RT_RUN.done`, `IO_READ_KEY.wait_hit` | none | yes |
| A label for the shell's "after a command" return point | 0 B | helpful |
| `.sym` files in the release | none | helpful |
| A compile-time line hook or table (Q1.4) | 0 B (label) or a few bytes | only if Q1.2 shows gaps |
| A runtime cartridge build (Q5) | a build flag; bytes only in the cartridge images, not the release ROMs | yes (owner decision) |
