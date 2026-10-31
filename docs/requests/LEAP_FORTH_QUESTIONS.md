# Questions from the Leap IDE for 2068-Forth

From: the Leap IDE (github.com/nchiker/2068-Leap-IDE), 2026-10-31.
For: the 2068-Forth project, to answer before the IDE's Forth work starts.

## Background

The Leap IDE is a browser IDE for Leap V2 BASIC that runs the real ROMs in the
TSRun emulator. It will support Leap-Forth (plan: `docs/LEAP_FORTH_PLAN.md` in
the IDE repository). The IDE never patches or re-implements the ROM. For Forth
the owner chose **console first**:

- the Forth `OK` prompt is live all the time, and keys typed on the emulated
  screen go straight to it;
- the IDE's editor is a scratchpad: **Run** sends the whole editor text to
  the live session, **Send** sends a line or the selection, as if typed;
  **Reset** cold-starts; **Import session** copies the line store
  (`$D000`..`STORE_END`) into the editor;
- errors from sent text are mapped back to the editor line;
- the debugger shows the data, float and return stacks and the dictionary,
  with breakpoints on words.

The IDE drives the ROM from outside: it writes RAM, sets registers and enters
ROM routines at a safe point (the key wait, `IO_READ_KEY.wait_hit`), and it
can stop before any instruction at a given address (a JavaScript hook).
Everything is keyed to symbol addresses from the build's `.sym` files, so what
matters most is **stable, documented labels and cells**. Labels cost no ROM
bytes; every request says what it would cost.

Addresses quoted are from the local build at `205ac04`. The IDE will use the
build that TSRun carries when the work starts; that build should have a git
tag.

---

## Q1 (main). Sending text "as if typed"

`EDITOR_LOOP_LIVE` (`core/editor.asm:555-594`) handles one typed line:
`STORE_APPEND` (the line + CR into the store, empty lines skipped), then
`INTERPRET_RUN` on `EDIT_BUF`, then `EDIT_CLEAR_MARKS` if `VIEW_RESULT`, then
`OK` unless `INTERP_ERROR_FLAG`, then back to the prompt.

**What the IDE plans to do (no ROM change):** at the prompt's key wait, for
the text being sent: `STORE_APPEND` it (line by line, as typing would), then
call `INTERPRET_RUN` with HL = the appended text in the store and DE = its
length, with the return address set to the instruction after
`call INTERPRET_RUN` (`$3727`, no label today), so the ROM's own `OK` /
no-`OK` logic runs and the prompt comes back.

**Please answer:**

1. **A label for the return point** after `call INTERPRET_RUN` in
   `EDITOR_LOOP_LIVE` (e.g. `EDITOR_LOOP_LIVE.ran`). Zero bytes. Without it
   the IDE has to hard-code `$3727` per build.
2. **Multi-line text in one call.** `INTERPRET_RUN` treats CR as whitespace,
   so one call can interpret many lines. Is that equivalent to typing them
   one by one? Differences we can think of: an error stops the rest of the
   text (typed lines would each still run); `\` comments end at CR (fine);
   `STATE` / an open `:` definition carries across lines either way? Anything
   that reads "the rest of the line" (`."`, `(`, string words, `WORD`-like
   parsing, `EDIT`, `LOAD-TEXT`) and would behave differently?
   If the IDE should rather send line by line (one `STORE_APPEND` +
   `INTERPRET_RUN` per line, stopping at the first error), say so.
3. **Interpreting from the store instead of `EDIT_BUF`:** is it safe for
   `SRC_PTR` to point into `$D000-$EFFF` while interpreting (does anything
   assume the source is `EDIT_BUF`, e.g. error display, `EDIT`, `FORGET`,
   `STORE_LAST_LINE`)? The IDE wants `SRC_PTR` inside the store so an error
   position maps to the sent text.
4. **Optional, if bytes allow:** a documented host entry, e.g.
   `HOST_INTERPRET` (HL = text, DE = length: append and interpret exactly as
   the prompt does, then return to the prompt). Only if Q1.2 / Q1.3 show the
   outside approach is fragile.

## Q2 (main). Keeping the error after it is reported

Today an unknown word goes through `INTERPRET_UNKNOWN_WORD` (`$0203`, prints
`TOKEN ?`, sets **no** code), and an uncaught `THROW` through
`RUNTIME_ERROR_HOOK` (`$0247`), which prints the message and then **clears
`THROW_CODE`** (`rom/forth_boot.asm:266-267`). Both end in
`REPORT_INTERP_ERROR`, which resets both stacks. After the fact the IDE can
see only `INTERP_ERROR_FLAG` = 1 and `SRC_PTR`.

**What the IDE will do without a ROM change:** stop at those two routines
(and the stack check at `core/interp.asm:479`), read `WORD_BUF` /
`THROW_CODE` / `SRC_PTR` there, then continue. This works, but depends on
three entry points and on their register / cell contents at entry.

**Please answer / consider:**

1. **Keep these labels stable** and confirm what is valid at their entry:
   `INTERPRET_UNKNOWN_WORD` (token in `WORD_BUF`), `RUNTIME_ERROR_HOOK`
   (`THROW_CODE` still set), the stack-check failure (which label?),
   `REPORT_INTERP_ERROR`.
2. **Optional, a few bytes:** a cell `LAST_ERROR` (2 bytes RAM) set on every
   reported error to its ANS code (-13 for an undefined word, the `THROW`
   code otherwise, a code for `STACK?`), and cleared at the start of each
   `INTERPRET_RUN`. Then the IDE (and the project's own `fharness`) can read
   the error after the fact with no breakpoints.
3. Is `SRC_PTR` at the error always just past the failing token, also for an
   error raised inside a word called from the text (it should then point past
   the calling word in the text, which is what the IDE wants)?
4. Which `THROW` code does BREAK give (-28 as in ANS)? Does BREAK while a word
   waits in `KEY` / `INPUT` / `ACCEPT` end that wait and return to the prompt?

## Q3. Telling the prompt from a program waiting for a key

The IDE may only send text when Forth is at the `OK` prompt, not when a word
is waiting in `KEY` / `INPUT` / `ACCEPT` (all three end in the same key wait).

**Please answer:** what is the reliable test? Candidates: the return address
on the stack is `EDITOR_LOOP_LIVE.keyloop`'s call site; the stack depth
equals the prompt's; a cell. If none is reliable, could the prompt set a flag
cell (`AT_PROMPT`, 1 byte RAM, a few bytes of code) while it waits?

## Q4. Mapping compiled words back to source lines (debugger)

Breakpoints on whole words work from the dictionary alone (header -> code
address). For breakpoints and Step **inside** a definition, the IDE would
build a line table by watching the compiler: while `STATE` = 1, each time a
word is compiled into the current definition, record (`SRC_PTR`, `HERE`).
This is how the IDE does it for V2 BASIC.

**Please answer:** which label is the point where one word of the source is
about to be compiled (in `core/interp.asm`), with `SRC_PTR` just past that
word and `HERE` at the address its `CALL` (or literal) will occupy? Do any
words compile code elsewhere (`IF` / `ELSE` / `THEN` patching, `DO` / `LOOP`,
literals, strings, `DOES>`-like words, `CREATE`), so that "last record at or
below the address" would name the wrong token? A label there costs nothing.

## Q5. The V2 manual's format (for the IDE's hover help and completion)

The IDE generates its keyword data from the manual with a script and never
hand-edits it. For Leap V2 and Leap-C this works because each entry is one
heading with a fixed shape (Leap V2: `docs/manual/03_keywords.md`; Leap-C:
`docs/manual/03_keywords.md` and `04_library.md`).

**Request, while the manual is being rewritten for V2:** one heading per word
(`## DUP`), and directly under it, always in the same order:

- the stack effect in code: `` `( n -- n n )` ``
- the kind in bold: **word**, **immediate word**, **defining word**,
  **variable**, **EXROM word**, …
- the group (stack, arithmetic, float, memory, strings, control, dictionary,
  errors, I/O, graphics, sound, storage, printer)
- a first paragraph of description (the IDE shows up to ~420 characters)
- a first example in a fenced ```` ```forth ```` block, ideally with the
  expected output, which the IDE can also use as a test
- names as the ROM spells them (upper case), so the IDE can cross-check the
  manual against the `H_*` headers in `forth_boot.sym` and report words
  missing from either.

## Q6. Smaller questions (one line each is enough)

1. **Line length** in the line store: what do `EDIT`, `LIST-DEFS` and
   `SAVE-TEXT` accept (the prompt's buffer is 128)? The IDE will mark longer
   lines.
2. **Words that take text to the end of a token or delimiter:** the full list
   (`."`, `(`, `\`, `S"`?, `STRING`, `CHAR`?, …), for syntax highlighting.
3. **Number syntax:** integers and floats as the interpreter accepts them
   (`docs/numeric_model.md`?), any prefixes or a decimal point rule.
4. **Graphics and UDGs** (for the IDE's Draw and UDG tools): `PLOT` / `LINE`
   word names, argument order and y direction; does the ROM have
   user-defined characters, and where?
5. **Tapes:** confirm the TEXT tape layout (header type 0, param1 `$8000`,
   param2 = length, data = the line store) and that the `STORAGE_SPEC.md` §6
   stack effects of `SAVE-TEXT` / `VERIFY-TEXT` will be fixed to
   `( "name" -- )`.
6. **Release bundle:** keep `symbols/` (both `.sym` files) and `SHA256SUMS`
   in the zip, and a version string the IDE can show ("2068 FORTH V2.0").

## Summary of what we ask for

| Item | Cost | Needed? |
|---|---|---|
| Answers to Q1-Q6 | none | yes |
| A label after `call INTERPRET_RUN` in `EDITOR_LOOP_LIVE` | 0 B | yes |
| Keep stable: `INTERPRET_RUN`, `STORE_APPEND`, `EDITOR_LOOP_LIVE(.keyloop)`, `INTERPRET_UNKNOWN_WORD`, `RUNTIME_ERROR_HOOK`, `REPORT_INTERP_ERROR`, `IO_READ_KEY.wait_hit`, the cells `SRC_PTR`, `SRC_END`, `STORE_END`, `LATEST`, `HERE`, `STATE`, `THROW_CODE`, `WORD_BUF`, `INTERP_ERROR_FLAG` | none | yes |
| A label where each source word is compiled (Q4) | 0 B | yes, for line breakpoints |
| The V2 manual's entry shape (Q5) | none | yes |
| A tag on the build TSRun carries | none | yes |
| `LAST_ERROR` cell (Q2.2) | a few bytes | helpful |
| `AT_PROMPT` flag (Q3) | a few bytes | only if no reliable test exists |
| `HOST_INTERPRET` entry (Q1.4) | tens of bytes | only if Q1 shows the outside approach is fragile |
