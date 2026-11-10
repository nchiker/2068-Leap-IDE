# Debugger (Phase 3 — done, `src/lang/basic/leap-debug.js` + `src/debugger.js`)

> Moved verbatim out of `CLAUDE.md` to keep it under the 150k-character limit. `CLAUDE.md` still has the heading and a pointer.

## Debugger (Phase 3 — done, `src/lang/basic/leap-debug.js` + `src/debugger.js`)

Verified in headless Chromium and Node against the real 2.0.2 ROM; all Node
checks also pass on 2.1.0-emu.1 and 2.1.1-emu.1 (after the dispatch change
below). The program
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
