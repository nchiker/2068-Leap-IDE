# Answers from 2068-Leap-C to the Leap IDE's questions

From: the 2068-Leap-C project (github.com/nchiker/2068-Leap-C), 2026-11-01.
To: `LEAP_C_QUESTIONS.md` (2026-10-31), beside this file.

Every name below is a label or cell in the release's `.sym` files. The addresses quoted are from the
`v1.0.0-beta.2` build (`b918527`). **Release 1.0.0 moved them** (its one-row report and font changes changed the
ROM bytes; for instance `SH_RUN` is `$C10F`, `SH_LOOP` `$C02F`, `SH_WAIT_KEY.key_ret` `$C1AC`, `STATEMENT` `$302C`,
`RT_RUN.done` `$367C`). **Addresses move between builds, names do not:** the IDE should resolve every address from
the release's `.sym` files. The contract for names is the "Stable names for hosts" list in
[CHANGELOG.md](https://github.com/nchiker/2068-Leap-C/blob/v1.0.0/CHANGELOG.md): a rename or removal is a breaking
change announced there first.

> **Updated 2026-11-01 for Leap-C 1.0.0:** a report is now **one row**, row 23 (white on black), instead of rows
> 22-23. On `RUN` it reads `EXIT n`, `ERROR n MESSAGE`, `RUNTIME ERROR n MESSAGE` or `BREAK`. There is no `LINE m`
> text any more (the cursor goes to the line, and the status row shows `LINE n/m` after a key), no image size or
> heap figure, and no undeclared identifier's name. Detecting a finished run is unchanged: the word at SP is
> `SH_WAIT_KEY.key_ret` at `IO_READ_KEY.wait_hit`. The cells `SH_ERR_LINE` and `SH_IMAGE_SIZE` are not used by the
> report (Q2.3). The emulator pack carries `symbols/leapc_home.sym` and `symbols/leapc_exrom.sym`. Addresses
> moved in 1.0; resolve names from those files. Q5 (runtime cartridge) is unchanged: planned after 1.0, a plan is
> being written.

## Summary

| Asked | Answer |
|---|---|
| Is `STATEMENT` the line point? | Yes, with three extra points the IDE already can watch and one new label (Q1) |
| A compile-time line hook or table | Not needed: one 0-byte label, `STMT_DO.cond`, closes the only real gap |
| Which entry to run a program | The **shell path**, from `SP = $FF00` (Q2) |
| A label for "after a command" | Not needed: `SH_LOOP` *is* that point (a typed `RUN` returns into it) |
| "Finished" vs "waiting for input" | The `RUNNING` cell, plus the new 0-byte label `SH_WAIT_KEY.key_ret` (Q2.3) |
| An exit-status cell | None; `HL` at `RT_RUN.done` (kept stable) |
| BREAK in input waits | Yes: BREAK ends every wait with run-time error 5 (Q3) |
| Stable names | Yes: every label and cell this document names. A rename is a breaking change, announced in the CHANGELOG |
| `.sym` files in the release | Yes: the 1.0 emulator pack has `symbols/leapc_home.sym` and `symbols/leapc_exrom.sym` |
| A runtime cartridge build | Yes, hosted here as `make cart` with a build flag; planned after 1.0, a plan is being written (Q5) |

New labels (0 bytes each, in 1.0; addresses are beta.2's, see above):

| Label | Where | beta.2 address |
|---|---|---|
| `STMT_DO.cond` | `src/compiler/stmt.asm`, after the body of a `do` is compiled | `$3195` |
| `SH_WAIT_KEY.key_ret` | `src/shell/shell.asm`, the return address of the report's key wait | `$C1EB` |

---

## Q1. Mapping compiled code back to source lines

### Q1.1 `STATEMENT` is the right point

At `STATEMENT` (`$303A`) entry the current token is the statement's first token: `TOK_LINE` is its line and
`CG_PC` is where its first code byte goes. Every statement passes through it, nested ones included: compound
statements (`{` enters `STATEMENT`, then each inner statement does), the bodies of `if` / `while` / `for` / `do` /
`switch`, labels (`name:` re-enters `STATEMENT` for the statement after it), and `case` / `default` (they are
statement keywords; their handlers re-enter `STATEMENT` after the `:`).

Several records can share one address (a `case` and its statement, a label, `{` and its first statement, an empty
statement or a declaration-only block). **At one address, keep the later record.**

What emits code without passing through `STATEMENT`:

| Code | Where it is emitted | What to watch |
|---|---|---|
| The prologue `rst ENTER / db n` | `FUNC_DEF` (`$2F07`), before the body | Nothing: every `RUN_FNLINES` record is `(prologue address, definition line)`; add them all to the table after the compile (Q4.3) |
| Initialisers of automatic objects (`int x = f();`) | `DCL_AUTOINIT` (`$30CD`) | `DCL_AUTOINIT` entry: `TOK_LINE` = the `=` token's line, `CG_PC` = the first byte |
| The epilogue `rst LEAVE` at a function's end | `FUNC_DEF`, after the body | Nothing: it maps to the last statement, which is right for the closing `}` |

File-scope initialisers emit no code (they are static data written at compile time).

### Q1.2 Code placed away from its statement

| Construct | Layout | Effect on "last start at or below" |
|---|---|---|
| `do s while (c);` | `top: s / c / jp c,top` | **The condition maps to the body's last statement.** Watch the new label `STMT_DO.cond`: there `TOK_LINE` = the `while` token's line, `CG_PC` = the condition's first byte |
| `while (c) s` | `top: c / jp !c,out / s / jp top` | The `jp top` maps to the body's last statement: harmless |
| `for (i; c; n) s` | `i / top: c / jp !c,out / jp body / n / jp top / body: s / jp n` | The step `n` lies before the body and maps to the `for` line (as you found); the closing `jp` maps to the body's last statement: harmless |
| `if (c) s else t` | `c / jp !c,else / s / jp out / else: t` | The `jp out` maps to `s`'s last statement: harmless |
| `switch (e) s` | `e / call RT_SWITCH / dw table / s` | Inline, on the `switch` line; the table itself is static data |
| `?:`, `&&`, `\|\|`, casts, float operations | inline, in order | No effect |
| String literals, `switch` tables, `RUN_FNLINES` records, static objects | static data, from the **high** end of a region, growing down | Never executed |

Two more facts the debugger needs:

- **Calls with inline operands.** These return *past* bytes that follow the call: `rst ENTER / db n`,
  `call F_LDX / db d`, `call F_LDK / 5 bytes`, `call F_OP / db op` (and the other float calls of
  `src/runtime/float.asm`), `call RT_SWITCH / dw table` (which does not return there at all: it jumps to the
  case). So **Step Over cannot stop at the call's address + 3**; stop at the next statement start (or at the
  frame's return, for Step Out) instead.
- **Dropped code.** An expression statement whose value is not used can have its last few bytes taken back
  (`CX_DISCARD` moves `CG_PC` back over a short tail, within the same statement). A record is never inside the
  dropped bytes.

### Q1.3 Code regions

The code moves to the next region in `CG_UNIT` (`CG_UNIT.found`, `$2937`): a `jp` to the new region is written at
the old `CG_PC`, and `DE` = the new region's first code byte. That happens at **any instruction**, so a single
statement (or function) can straddle two regions. Watch `CG_UNIT.found` and add the record
`(the line of the last record you made, DE)`. The `jp` itself sits at the old `CG_PC` and maps correctly.

Code fills the regions in order (`$C000-$DFFF`, `$E000-$F17F`, `$F400-$F7FF`, `$6000-$77FF`); a region is skipped
when less than 12 bytes are left in it (`CG_GUARD`). Static data grows down from each region's top, so per region
the line table only needs the code part (`[region low, the region's code end]`).

Muted code (`sizeof`, the unused side of a constant `?:` / `&&` / `||`) emits nothing, so it makes no records.

### Q1.4 A hook or table

Not needed. `STATEMENT`, `DCL_AUTOINIT`, `STMT_DO.cond`, `CG_UNIT.found` and the `RUN_FNLINES` records give every
code byte its line. No ROM bytes.

## Q2. How the IDE should start a program

### Q2.1 Recommendation: the shell path

It is what typing `RUN` does, so the user sees the report they would see on a TS2068, and the ROM does its own
clean-up. The direct path would make the IDE repeat the shell's steps (the report, the border, the
error line jump), which can change between releases; the shell path depends only on the labels below.

### Q2.2 The entry

`SH_RUN` assumes what holds at **every** shell key wait (the editor's and the report's): the EXROM paged in,
`BANK_EXROM_DEPTH` = 1, interrupts on (IM 1). It reads `CUR_EDIT_INDEX` (the append line: as `lcharness.py` sets
it). It does not need the editor's state.

Do **not** enter it on top of the editor's stack: `EDITOR_ENTER`'s frames would stay on the stack each run. The
shell's base is `SP = $FF00` (`LEAPC_STACK_TOP`): the cold start *jumps* to the shell, so that is the stack depth at
`SH_LOOP`. The protocol, from any shell key wait (PC = `IO_READ_KEY.wait_hit`, `RUNNING` = 0):

1. Write the line store, `PROG_END`, `ARRAYS_END` and `CUR_EDIT_INDEX` as today.
2. `SP = $FF00`; push `SH_LOOP` (`$C021`); push `SH_RUN` (`$C101`); `A = 7`; PC = `GFX_SET_BORDER` (`$03E1`).
3. Let it run.

The return into `SH_LOOP` is exactly a typed `RUN`'s: `SH_DISPATCH` returns with carry clear and `SH_REENTER`
goes to `SH_LOOP`, which redraws the editor and loads the line (the error line, with the cursor at the error's
column, after an error). **No "after a command" label is needed: `SH_LOOP` is that point.**

Why `GFX_SET_BORDER` first: a run starts clean except for the border. `SH_RUN` clears the screen to paper 7 /
ink 0 (`GFX_CLS`); `RT_RUN` clears the program's state (print position, inverse, over, the `rand` sequence, the
print attribute), makes an empty heap, and at the end silences the AY and restores the normal display mode. The
border is reset to white only by `SH_LOOP`, which runs after the report's key. Since the IDE never sends that key,
it sets the border itself in the same chain. Not reset between runs, by design: the user-defined characters
(cleared only at the cold start) and a loaded library.

### Q2.3 The report's wait, and telling "finished" from "waiting for input"

`SH_WAIT_KEY` waits through `IO_READ_KEY.wait_hit`. The next run can be injected there as in Q2.2.

At `IO_READ_KEY.wait_hit`:

| State | Means |
|---|---|
| `RUNNING` ≠ 0 | the program (or a loaded library) waits for a key: `getkey()` or `gets()` |
| `RUNNING` = 0 and the word at SP = `SH_WAIT_KEY.key_ret` | the run is over; the one-row report (row 23) is on screen. SP = `$FEFC` with the protocol above |
| `RUNNING` = 0, any other return address | the editor (or LIST's pager) |

The report wait first waits for every key to be released (a key held from before does not end it); the IDE sends
none, so that does not matter.

**Results:** after the run, `CC_ERRNUM` (0: it compiled), `CC_ERRLINE`, `SH_ERR_COL`; `RT_ERRNUM` (0: no run-time
error; 5: BREAK), `RT_ERRLINE` (the line where the failing function's definition starts; 0 unknown). `RT_ERRNUM`
is meaningful only when `CC_ERRNUM` = 0.

**Cells no longer used.** In 1.0 the report does not use `SH_ERR_LINE` or `SH_IMAGE_SIZE`. `SH_ERR_LINE` no longer
exists as a label (a spare byte remains in `include/leapc_cells.inc`, line 178, so later cells keep their
addresses). `SH_IMAGE_SIZE` still exists but is unused (`include/leapc_cells.inc:186`). Neither is read or written
anywhere in `src/`. Do not rely on either; use `CC_ERRLINE`, `RT_ERRLINE` and `SH_ERR_COL` above.

### Q2.4 The direct path

Not recommended, but for completeness, after `RT_RUN` the shell: builds the one-row report from `A` / `HL`, draws it on row 23
(white on black), moves the cursor to the error line, waits for a key, then `SH_LOOP` sets the border to white and
redraws the editor (the status row then shows `LINE n/m`). `RT_RUN` itself already does the paging (it pages the
EXROM out for the program and back in to the depth it found), `RUNNING`, the heap, the AY and the display mode.

### Q2.5 The exit status

No cell keeps it. `HL` holds it at `RT_RUN.done` (`$368A`) and at `RT_RUN.leave` (`$368F`, where `A` =
`RT_ERRNUM` too). Both labels stay. With the shell path the report also shows it ("EXIT n").

## Q3. Stopping a program that waits for input

| Function | Waits | Where |
|---|---|---|
| `getkey()` | for a key | `IO_READ_KEY.wait_hit` |
| `gets(buf, max)` | for each key of the line | `IO_READ_KEY.wait_hit` |
| `inkey()` | never: 0 if no key | (polled by the program's own loop) |
| `pause(n)` | n frames | `AY_WAIT_FRAMES` |
| `beep`, `sound` | the note's length | the EXROM's `AY_BEEP_PLAY` |
| `tape_save`, `tape_load` | the transfer | the tape block I/O |

There is no `getchar`. **BREAK (CAPS SHIFT + SPACE) ends every one of them** with run-time error 5, through the
interrupt routine (`RT_BREAKREQ`), at the program's last library call. Inside a section that defers BREAK (`NOBRK`
≠ 0: a `beep`, a tape block) the BREAK is kept and ends the program when the section ends; a tape transfer also
stops on BREAK or SPACE.

So the safe way back is the IDE pressing CAPS SHIFT + SPACE on the emulated keyboard for a few frames. No jump is
needed; the program ends through `RT_RUN` and the shell reports `BREAK` on row 23 as usual.

## Q4. Smaller questions

1. **Blank lines:** an empty line is never stored (`SH_REENTER`), and the lexer counts stored lines from 1, so
   `CC_ERRLINE` and every `TOK_LINE` count stored lines. A line holding only spaces *is* stored. The IDE drops empty
   lines and keeps a map, as for V2.
2. **Frame:** `rst ENTER / db n` pushes `IX` and points `IX` at the saved `IX`. Locals at `IX-1 .. IX-n`, the
   return address at `IX+2`, the arguments from `IX+4`, the first argument lowest. Walking the stack: the caller's
   `IX` is the word at `IX`, its return address the word at `IX+2`. A symbol's `S_VAL` (offset 7) is its `IX`
   offset when `SF_AUTO` (bit 4 of `S_FLAGS`) is set, else its static address (`include/leapc_decl.inc`).
   **Locals do not survive the compile:** each block's entries are reclaimed at `SCOPE_CLOSE` (`$110A`). At the end
   of `CC_PROGRAM` only the file-scope chain `SYM_GLO` is complete. Read `SYM_LOC` at each `SCOPE_CLOSE` entry: it
   is the innermost scope's entries, linked outward to the function's parameters; the code range of that block is
   from `CG_PC` at the matching `SCOPE_OPEN` to `CG_PC` at `SCOPE_CLOSE`.
3. **`RUN_FNLINES`:** confirmed. Records `[link][address][line]` (3 words) in the image's static data, newest
   first, the chain ending with link 0. One record for every function **definition**, wherever its code starts
   (region 4 included). The address is the `rst ENTER` byte; the line is where the definition starts.
4. **Comments:** `//` and `/* */` (across lines) are both accepted.
5. **Graphics and UDGs:** pixels x 0-255, y 0-191 **from the top**; text rows 0-23, columns 0-31. Functions:
   `plot(x, y)`, `draw(x0, y0, x1, y1)` (off-screen coordinates clipped to the edge), `point(x, y)`, `attr(row, col)`, `mode(n)` (0 normal, 1 hi-res colour: run-time error 3 while the program's image uses `$6000-$77FF`),
   `sprite_get` / `sprite_put`, and `ink`, `paper`, `bright`, `flash`, `inverse`, `over`, `border`, `at`, `tab`,
   `cls`. User-defined characters: codes 144-164 at `UDG_TABLE` (`$F180`), 8 bytes each, as in V2; a program writes
   them through a pointer (manual Part 7, example 13).
6. **Libraries:** one at a time (`LIB "name"` replaces it; `LIB` alone unloads it). It sits in image region 3
   (`$F400-$F7FF`), so a program compiled with a library loaded has no code there. The release zip carries the
   library's `.tap` / `.tzx` / source and `SHA256SUMS` lists every file.
7. **`.sym` files:** yes, from 1.0: `symbols/leapc_home.sym` and `symbols/leapc_exrom.sym` in the emulator pack,
   listed in its `SHA256SUMS`.

## Q5. A runtime cartridge build

### Q5.1 Hosting

**Hosted here**, as `make cart` with a build flag, the way 2068-Forth is doing it. It is planned after 1.0 (a plan is being
written); the release ROM images do not change.

### Q5.2 The EXROM at run time

Yes, it is needed: compiled programs reach the EXROM for **float operations** (`LEAPC_EXROM_FLOAT`), **`beep` /
`sound`** (`LEAPC_EXROM_BEEP`) and **`tape_save` / `tape_load`** (`LEAPC_EXROM_TAPE`), each through a HOME
trampoline that pages chunk 6 in and out. Hi-res, sprites and the report are in HOME (the report is the shell's,
which the cartridge does not have). So the cartridge carries the EXROM in DOCK chunk 6, and chunk 6 is RAM (the
program's region 1) except inside those trampolines.

### Q5.3 Banking

V2's changes carry over: `BANK_PAGE_EXROM_IN` / `_OUT` (`platform/kernel/bank/bank.asm`) are V2's, with `$FF`
bit 7 set for the EXROM and `$F4 = $40` / `0`. For the cartridge: bit 7 left at 0 (DOCK), `$F4 = $43` in and `$03`
out. Other writers of `$FF`: `GFX_SET_MODE` (hi-res; read-modify-write through `PORT_FF_SHADOW`, so it keeps bit 7)
and the cold start. Nothing else writes `$F4`. A loaded library uses the same ROM routines. A program's own
`outp()` can write any port.

**The constraint that shapes the build:** compiled code calls absolute HOME addresses (the RST helpers, `RT_*`,
the float calls, every library function). The program is compiled by the release ROM in the IDE and runs on the
cartridge's HOME, so **the cartridge's HOME must keep every routine at the release's address**: each patch keeps
its size, and the build checks that the two `.sym` files agree. Two patches need care:

- `BANK_PAGE_EXROM_OUT` writes 0 with a 1-byte `xor a`; `ld a, $03` is 2 bytes. It needs a same-size
  rearrangement (V2's cartridge did the same).
- The LROS header (`$0000-$0004`) overlaps `IO_KEY_SCAN_ROW` at `$0004` (`in a,(PORT_ULA) / ret`). Only the
  keyboard scan calls it, never compiled code, so it moves to another page-zero gap.

### Q5.4 The program image

The IDE's format (a header, then `[address, length, bytes]` blocks) suits it: one or two blocks per used region
(the code from the region's low end, the static data from its high end) and the library's region 3 when one is
loaded. Put it in **DOCK chunks 4-5** (`$8000-$BFFF`, 16 KB), mapped only during the copy: the destinations are
chunks 3 (`$6000-$77FF`), 6 and 7, so the copy never maps over its own target. The regions hold about 19.4 KB in
all; an image above 16 KB would also need DOCK chunk 2 (`$4000-$5FFF`). The cartridge's cold start must also set
`PROG_END` to an empty store's end, because `RT_RUN` builds the heap from there.

### Q5.5 After the program

The cartridge has no shell, so the build adds a small report (planned in the cartridge's HOME, using the
EXROM shell's own routines and messages): the 1.0 one-row report on row 23, `EXIT n`, `RUNTIME ERROR n MESSAGE`
or `BREAK` (no `LINE m`), then a key restarts the program from a cold start (as V2's cartridge does). The plan
awaiting the owner's approval: `docs/milestones/M12-cart.md` in the Leap-C repository.

### Q5.6 Identity

The ROM has no identity value today. The build will compute a **CRC-16 over HOME + EXROM** (V2's scheme) as a
build constant (0 ROM bytes) and publish it with the release; the image header carries it, and the cartridge
refuses an image compiled against another build.
