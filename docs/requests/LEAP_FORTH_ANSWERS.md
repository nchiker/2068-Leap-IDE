# Answers from 2068-Forth to the Leap IDE's questions

From: the 2068-Forth project (github.com/nchiker/2068-Leap-Forth), 2026-11-01.
To: `LEAP_FORTH_QUESTIONS.md` (2026-10-31), beside this file.

The ROM changes below are on 2068-Forth's branch `v2/step-ide-hooks` (step *IDE hooks*,
`docs/V2/milestones/IDE_hooks.md` there) until it merges; the owner approved them. Every name below is a
label or cell in `build/forth_boot.sym`; addresses move between builds, names do not. The hooks are tested
the IDE's way in 2068-Forth's own suite (`tools/fharness.py`, boot check `p host line`, and `Console.host_line`),
so a change that breaks them fails that project's build.

**Two things changed since the build the questions quote (`205ac04`):** step *BREAK and timing* (PR #15,
merged 2026-11-01) made BREAK stop a running word (THROW -28, also in `KEY`, `ACCEPT`, `INPUT`), and the console
now sets `NOBRK` right after `call INTERPRET_RUN`: a host that returned past that instruction would leave BREAK
live at the prompt. The protocol below avoids both.

## Summary

| Asked | Answer |
|---|---|
| A label after `call INTERPRET_RUN` | Not needed: the IDE should enter the console's own ENTER path instead, `EDITOR_LOOP_LIVE.enter` (added, 0 B) |
| Interpret from the store | **No**: it is not safe (Q1.3); send one line at a time through `EDIT_BUF` |
| `HOST_INTERPRET` | Not needed |
| `LAST_ERROR` | Added (2 B RAM, +1 B ROM net) |
| `AT_PROMPT` | Not needed: `EDITOR_LOOP_LIVE.key_ret` (added, 0 B) tells the prompt's key wait from a program's |
| A label where each source word is compiled | `INTERPRET_NESTED.token` (added, 0 B) |
| Stable names | Yes: every label and cell this document names (the questions' list and the new ones). A rename would be a breaking change, announced in 2068-Forth's CHANGELOG |
| The manual's entry shape | Yes: the manual is being rewritten in Leap-C's and Leap V2's style, in that shape (Q5); a roadmap step |
| A tag on the build TSRun carries | Yes, at the release |
| A runtime cartridge build | Yes, hosted here as `make cart`; it is the next roadmap step (Q7) |

---

## Q1. Sending text "as if typed"

### The protocol (one line at a time)

1. **At the prompt** means: PC = `IO_READ_KEY` (the same address as `IO_READ_KEY.wait_hit`) and the word at SP is
   `EDITOR_LOOP_LIVE.key_ret` (Q3).
2. Write the line into `EDIT_BUF` (at most 128 bytes, `EDIT_MAX_LEN`; plain ASCII, no CR), its length into
   `EDIT_LEN` and the same value into `EDIT_CURSOR` (the byte after `EDIT_LEN`).
3. Drop the key wait's return address (SP + 2) and set PC = `EDITOR_LOOP_LIVE.enter`.
4. Let it run. The ROM does exactly what ENTER does: the line goes into the store (`STORE_APPEND`; an empty line
   is not stored), runs (`INTERPRET_RUN`), the console prints `OK` or the error's message, drops a `:` definition
   an error left open, clears the input line and waits for the next key.
5. The line is done when the machine is **at the prompt** again. Read `LAST_ERROR` (Q2): 0 means it ended in `OK`.
   Stop sending at the first line that did not.

If PC reaches `IO_READ_KEY` and the word at SP is **not** `EDITOR_LOOP_LIVE.key_ret`, the line is waiting in `KEY`,
`ACCEPT`, `INPUT` or `EDIT`'s view: keys typed on the screen go to it; the line is not done.

Interrupts are on at the key wait and must stay on (the keyboard and `FRAMES` run from them). The line does not
appear on the input row (row 23) as typed keys would; its output appears exactly as after a typed ENTER.

The error's column in the line is `SRC_PTR - EDIT_BUF` (Q2.3). Since the IDE sends line by line, the editor line is
known.

### Q1.2 Several lines in one call: not equivalent

Typed lines and one call over CR-separated text differ:

- `(` runs on over CRs to the next `)` in one source; at the prompt it ends with the line. `."` and `S"` with a
  missing `"` likewise run on into the next lines.
- An error stops the rest of the text, and only one `OK` is printed for the whole.
- `\` ends at a CR, as the IDE expected. `STATE` and an open `:` definition carry across lines either way.

So: send line by line, as above.

### Q1.3 Interpreting from the store: not safe

- `LOAD-TEXT` loads its tape **into the store**, from `STORE_START`, replacing it: the text being interpreted would
  be overwritten under `SRC_PTR`.
- `EDIT`'s view inserts and deletes lines in the store, moving everything after them.
- `SAVE-TEXT`, `VERIFY-TEXT`, `LOAD-TEXT` and `EDIT` take "the console line holding the command" off the store
  (`STORE_TRIM`: `STORE_END` goes back to `STORE_LAST_LINE`). That is the last line appended: with several lines
  appended ahead of the run, it would drop the wrong one.

`EDIT_BUF` has none of these problems: it is what the prompt itself interprets.

### Import session

`STORE_START` .. `STORE_END` (cells; today `$D000` and up, at most 8,192 bytes), lines ended by CR (`$0D`). At the
prompt every line end is `$0D` (`EDIT`'s changed-line marks, `$8D`, exist only while it commits). The command lines
above are not in it (they are commands, not source), and a `LOAD-TEXT` replaces it with the tape's text.

### Q1.4 `HOST_INTERPRET`

Not needed: `EDITOR_LOOP_LIVE.enter` is that entry, with nothing added.

---

## Q2. The error after it is reported

### Q2.2 `LAST_ERROR` (added)

A 2-byte cell: **the code the last console line ended with**. 0 after a line that printed `OK`; otherwise the error's
code, ANS-numbered. It is set by the shared error tail (`REPORT_INTERP_ERROR`) and cleared by the console when a
line ends in `OK`, so it can be read at the prompt after the line, with no breakpoints (and by the next line:
`{LAST_ERROR} @ .` in 2068-Forth's tests).

| Code | Printed | Raised by |
|---:|---|---|
| -1 | nothing | `ABORT` |
| -3 | `STACK?` | a stack (data or float) overflowed (also `-3 THROW`) |
| -4 | `STACK?` | a stack underflowed (also `-4 THROW`) |
| -5 | `RETURN STACK FULL` | recursion too deep |
| -8 | `DICTIONARY FULL` | |
| -13 | `name ?` | an unknown word; a compile-only word (`IF` ...) at the prompt; `EDIT name` with no such definition. Also `UNDEFINED WORD` from `'` |
| -16 | `MISSING NAME` | a word that takes a name, with none |
| -28 | `BREAK` | BREAK while a word runs; SPACE in a tape word |
| -37 | `TAPE ERROR` | |
| -42 | `DIVISION BY ZERO` | `F/` by zero, `TAN` |
| -43 | `OUT OF RANGE` | |
| -46 | `INVALID ARGUMENT` | |
| -56 | nothing | `QUIT` |
| other | `ERROR n` | the program's own `n THROW` |

While `EDIT` commits changed lines, the message is preceded by `LINE n `.

### Q2.1 Labels and what holds at their entry

The IDE can now use `LAST_ERROR` alone. If it still stops at the routines:

| Label | At entry |
|---|---|
| `INTERPRET_UNKNOWN_WORD` | `WORD_BUF` = the token (a counted string, upper case). Also reached from a compile-only word at the prompt (`COMPILE_ONLY_CHECK`: `WORD_BUF` holds the last token read) and from `EDIT name` |
| `RUNTIME_ERROR_HOOK` | `THROW_CODE` = the code. Every uncaught THROW, BREAK, and the stack check (`STACK_CHECK.violation` jumps here with -3 or -4: there is no third entry) |
| `REPORT_INTERP_ERROR` | HL = the code. Every error ends here, and `ABORT` / `QUIT` come here directly (no message) |

At all three, both stacks may already be reset; `INTERP_ERROR_FLAG` is set in `REPORT_INTERP_ERROR`.

### Q2.3 `SRC_PTR` at an error

- Just past the failing token **and the one delimiter after it** (the space, or the end of the line).
- For an error raised inside a word called from the line: past that word's token, which is what the IDE wants —
  unless the word itself read further input: `'`, `CHAR`, `."`, the defining words, `FORGET`, `EDIT`, the tape words
  (then past what it read).
- `STACK?` is found before the next token is read: `SRC_PTR` is past the token whose word caused it.
- An error inside text that `LOAD-TEXT` or `EDIT` was running: `SRC_PTR` and `SRC_END` point into the store, not
  `EDIT_BUF`. The IDE can tell by the range.

### Q2.4 BREAK

-28, as in ANS. Since 2068-Forth PR #15 it stops any running word, including one waiting in `KEY`, `ACCEPT` or
`INPUT`: the console prints `BREAK` and returns to the prompt; `LAST_ERROR` is -28; under `CATCH` it is caught as -28.
At the prompt and in `EDIT`'s view BREAK is a key, not an error. `SPRITE-*` and `HIRES` / `NORMAL` finish first, then
stop.

---

## Q3. The prompt or a program waiting for a key

`IO_READ_KEY` pushes nothing before its wait, so at `IO_READ_KEY.wait_hit` the word at SP is its caller's return
address. **At the prompt it is `EDITOR_LOOP_LIVE.key_ret`** (added). `KEY`, `ACCEPT` / `INPUT` and `EDIT`'s view (which
reaches the key wait through `GRAPHICS_HOME_TABLE`) all return elsewhere. 2068-Forth's own test tools use exactly this
test (`Console.in_editor`). No `AT_PROMPT` cell is needed.

---

## Q4. Mapping compiled code to source lines

**`INTERPRET_NESTED.token`** (added): the interpreter has read one token. There, `WORD_BUF` holds it, `SRC_PTR` is
just past it and its delimiter, and `HERE` is where its code will go. Record (`SRC_PTR`, `HERE`) when the cell
`STATE` is 1. The token's code is `HERE` up to the next record's `HERE`. Tested: `: SQ DUP * ;` gives `DUP` at the
definition's code address, `*` 3 bytes on, `;` 6 on.

"The last record at or below the address" names the right token:

- `:` reads the name itself (not through `.token`) and runs with `STATE` 0. The code starts at `COLON_XT` (a cell,
  set while the definition is open) = `LATEST` + 3 + the name's length.
- Immediate words compile at `HERE` too (`IF`: `CALL QBRANCH` and a 2-byte target). `THEN`, `ELSE`, `REPEAT`,
  `UNTIL`, `LOOP`, `+LOOP` also **patch** bytes compiled by earlier tokens (branch targets, `LEAVE` slots); they do not
  put code anywhere else.
- A call of the word being defined (recursion) compiles `CALL STK_GUARD` before it, under the same token.
- `;` compiles a plain `RET` (no tail-call rewrite). `EXIT` compiles `POP`s for the open `DO` loops, then `RET`.
- `[ ... ]` runs with `STATE` 0: no records. `LITERAL` after `]` compiles under its own token.
- `DOES>` patches a `CREATE`d word's jump **at run time**, not while compiling.
- **Inline data, never an instruction:** the 2 bytes after `CALL DOLIT` (integer literals, `[']`, `LITERAL`), after
  `CALL QBRANCH` / `CALL BRANCH`; the 5 after `CALL DOFLIT` (float literals); the length and characters after the
  call that `."` and `S"` compile. A line breakpoint goes on the first byte of a record, which is always an
  instruction.
- `LOAD-TEXT`'s and `EDIT`'s nested runs pass `.token` too, with `SRC_PTR` in the store.

---

## Q5. The manual

The V2 manual will be rewritten in the style of the Leap-C manual (`~/2068-Leap-C/docs/manual`, parts `01_` to
`08_`) and the Leap V2 manual. It is a roadmap step, after the cartridge build. The word chapter follows the IDE's
shape: one `## NAME` heading per word, spelled as the ROM spells it (upper case, as the `H_*` headers), and under it,
always in this order, the stack effect in code, the kind in bold (**word**, **immediate word**, **compile-only
word**, **defining word**, **EXROM word**, ...), the group (from the IDE's list), a first paragraph of description,
and a first example in a ```` ```forth ```` block. Examples carry `\ expect:` lines, the format of 2068-Forth's
`tests/*.fs`, and the build runs every one (as Leap-C's build runs its manual's examples); the IDE can use them as
tests. A check in the build will report words missing from either the manual or the ROM. We will send a sample
entry before writing the rest.

### Q5 as built (2026-11-01, 2068-Forth step Manual, branch `v2/step-manual`)

`docs/manual/`, eight parts as Leap-C's (the owner's choice): `03_language.md` (groups stack, arithmetic, float,
memory, strings, control, dictionary, errors) and `04_machine.md` (I/O, graphics, sound, storage, printer) hold one
entry per ROM word, 184 in all, in ASCII order of the name. An entry is exactly:

    ## NAME                                   the ROM's spelling (`## \`, `## ."`, `## [']`)
    <blank>
    `( stack -- effect )` -- **kind**, group  float-stack effects after F:, e.g. `( n -- ) ( F: -- f )`
    <blank>
    the first paragraph of description
    ```forth                                  the first example: lines with `\ expect: TEXT`
    **Notes.** / **Errors.** (a table) / **See also** (optional), then `---`

Kinds: `word`, `immediate word`, `compile-only word`, `defining word`, `EXROM word` (note the capitals). The line is
Leap V2's `` `syntax` -- **kind** `` shape with `, group` after it; the stack effect itself contains ` -- `, so split
on ` -- **`. `tools/manualcheck.py` (in `make check`) walks the dictionary chain in the built image and fails on a
missing or extra entry, a wrong kind (from the IMMEDIATE bit, `call COMPILE_ONLY_CHECK`, the EXROM call, the header
builder), group or order. Every ```forth block in the manual is a test (`tools/docexamples.py` -> `tests/doc/
manual_*.fs`, the format of `tests/*.fs`, each run on a just-booted ROM); `\ keys:`, `\ break:` and `\ draws` lines
are forthtest directives the IDE can ignore or use. The Summary table at the head of each part lists the words by
group (`| **group** | `A` `B` ... |`).

---

## Q6. Smaller questions

1. **Line length:** 128 characters at the prompt (`EDIT_BUF`, four screen rows) and in `EDIT`'s view (the same
   `EDIT_MAX_LEN`); `LIST-DEFS` shows the first 20 of a definition; `SAVE-TEXT` saves the store as it is, any length.
2. **Words that read past their own token** (for highlighting):
   - to a delimiter: `\` (to the end of the line), `(` (to `)`), `."` and `S"` (to `"`);
   - the next token, a name: `:` `CREATE` `VARIABLE` `CONSTANT` `ARRAY` `STRING` `FVARIABLE` `FCONSTANT`
     `'` `[']` `CHAR` `[CHAR]` `FORGET` `EDIT` (optional) `SAVE-TEXT` `LOAD-TEXT` `VERIFY-TEXT` `SAVE-LIB`
     `LOAD-LIB` `VERIFY-LIB`.

   There is no `WORD`, `PARSE` or `.(` word.
3. **Numbers** (`core/fpparse.asm`, Leap-C's grammar): `[-] digits [. digits] [E|e [+|-] digits]` or
   `[-] . digits [exponent]`, the whole token. With a point or an exponent it is a float (on the float stack);
   otherwise an integer from -32768 to 65535 (a 16-bit pattern: `40000` is -25536). `+5` is not a number. Outside
   those ranges: `OUT OF RANGE` (-43). Decimal only: no `BASE`, `HEX` or prefixes.
4. **Graphics:** `PLOT ( x y -- )`, x 0-255, **y 0-191 with 0 at the top**; off-screen points draw nothing.
   `LINE ( x1 y1 x2 y2 -- )`, signed 16-bit ends, the on-screen part drawn. `CIRCLE ( xc yc r -- )`. **User-defined
   characters:** 21, codes 144-164, 8 bytes each (top row first) in RAM at `UDG_TABLE`; `n UDG ( n -- addr )` gives
   slot n's address, and `EMIT` of 144-164 draws them. They are outside the dictionary: `SAVE-LIB` does not save them.
5. **Text tapes:** confirmed: header type 0, parameter 1 `$8000`, parameter 2 the length, data the line store less
   the console line holding the command. `STORAGE_SPEC.md` section 6 now gives `SAVE-TEXT` and `VERIFY-TEXT` as
   `( "name" -- )`.
6. **Release bundle:** kept: `roms/` with `SHA256SUMS`, `symbols/` with both `.sym` (and `.lst`) files; the version
   text is "2068 FORTH V2.0" (`FORTH_VERSION_TEXT`, also on the status bar at power-on). The release TSRun carries
   will be tagged.

---

## Q7. The runtime cartridge

**Q7.1 Hosting:** in 2068-Forth, as `make cart` with a build flag. The release ROMs do not change; the cartridge
images differ only under the flag. It is the next step on 2068-Forth's roadmap (before the manual and Blackjack).

**Q7.2 Banking:** simpler than Leap's. Only chunk 5 (`$A000-$BFFF`) is ever paged, and only two routines write port
`$F4`: `BANK_PAGE_EXROM_IN` (`$20`) and `BANK_PAGE_EXROM_OUT` (0). Port `$FF` is written only through
`PORT_FF_SHADOW`: by the cold start (0), `GFX_SET_MODE` (`HIRES` / `NORMAL`: bits 0-2) and `BANK_PAGE_EXROM_IN` (bit 7).
`EDIT` and the other EXROM words page only through those two routines (BREAK too: it forces the depth to 1, then
`BANK_PAGE_EXROM_OUT`). Under the flag: `$F4` = `$23` / `$03` (chunks 0-1 stay DOCK) and bit 7 of `$FF` stays 0
(DOCK, not EXROM). The Forth EXROM is assembled for `$A000`, so it goes in **DOCK chunk 5**.

**Q7.3 Program image:** `SAVE-LIB`'s data (`$9100` .. `HERE`, then a 2-byte CRC; its header carries `ROM_IDENTITY`
and `LATEST`) with the start word and the 168-byte UDG table added. **The dictionary is not relocatable**
(compiled code holds absolute `CALL`s and links): always `$9100`. Put the image in **DOCK chunks 2-3** (`$4000-$7FFF`,
16,384 bytes): the largest dictionary (16,128 bytes) with the UDGs and a small header fits, and the copy's source
never maps over its destination (`$9100-$CFFF`) or the machine stack.

**Q7.4 Cold start:** the normal `COLD_START` (it clears the cells, sets `LATEST`, `HERE`, an empty store, both stacks,
`STATE` 0), then: DOCK chunks 2-3 in, check the image (identity, CRC), copy it to `$9100` and the UDGs to `UDG_TABLE`,
`HERE` = `$9100` + its length, `LATEST` from the image, chunks 2-3 back. `$0000-$0004` (`di; jp COLD_START`, then
a free byte) can hold the LROS header: that code never runs on a cartridge. The entry stub starts with `di`.

**Q7.5 After the start word:** dropping to the `OK` prompt costs nothing (it is the console loop; `EDIT` works once
the paging is right). Restarting from cold on a key is a few bytes. Either is fine for the ROM: the owner chooses. One
option that costs almost nothing: run the start word the way the IDE runs a line (its name into `EDIT_BUF`, then
`EDITOR_LOOP_LIVE.enter`), so an error is reported like a typed line's and the prompt follows.

### Q7 as built (2026-11-01, 2068-Forth step Cartridge, branch `v2/step-cartridge`)

- **After the start word: the `OK` prompt** (the owner's choice). The start word runs from `EDITOR_LOOP_LIVE.enter`
  with its name in `EDIT_BUF`, so its output, an error or `BREAK` look like a typed line's, the name is in the line
  store, and the program's words stay defined. Reset restarts the cartridge.
- **`make cart`** builds `build/cart/`: `forth_boot_rom0.bin` (HOME, `-DCARTRIDGE`), `graphics_exrom.bin` (the
  release EXROM, byte for byte), `forth_boot.sym`, and `forth_cart.dck` (Forth with no program). Every release label
  keeps its address, and the cartridge carries the release's `ROM_IDENTITY` (`tools/cart_check.py`), so a dictionary
  compiled on the release ROMs, or a LIB tape, is valid on the cartridge.
- **DCK:** bank 0 (DOCK). Chunks 0-1 hold HOME, with the LROS header `00 01 <CART_ENTRY lo hi> DC` at `$0000`.
  Chunk 2, and chunk 3 when the image is over 8 KB, hold the program image, padded with `$FF`. Chunk 5 holds the
  EXROM. Port `$F4` is `$03`, `$23` while an EXROM word runs, `$0F` while the image is copied; `$FF` bit 7 is never
  set.
- **Program image** at DOCK `$4000`, all little-endian: `+0` `"F1"` (`$46 $31`); `+2` `ROM_IDENTITY` (SAVE-LIB's
  header parameter 1); `+4` n = `HERE - $9100` (at most 16,128); `+6` `LATEST` (parameter 2); `+8` the start word's
  length (1-31), then its name, space-padded to 31 bytes; `+40` the UDG table (168 bytes); `+208` the dictionary
  (n bytes); then the CRC-16/CCITT-FALSE of bytes `+0 .. +207+n`, low byte first. The offsets are in the build's
  symbols (`CART_IMG_*`, `CART_MAGIC`). A failed check prints `BAD PROGRAM` and leaves Forth with an empty
  dictionary. No magic gives plain Forth.
- **Packing:** `tools/forthcart.py` (`read_lib`, `program_image`, `dck`, `flat_bin`) is the reference. It takes a
  SAVE-LIB `.tap` or `.tzx`, checks the identity, CRC and size, and that the start word is one of the program's
  words. It stores the name as the dictionary spells it.
- **Measured** (ZEsarUX and TSRun, stock ROMs): the hand-off at frame 103 with interrupts on, SP `$61FE`, `$F4`
  `$23`. The load takes 1.13M T for a small program and 9.55M T for a 16,128-byte dictionary (the CRC is most of
  it).
- **Changed (2026-11-01, 2068-Forth step Cart start):** the cartridge no longer checks the CRC at power-on, as Leap V2's
  production cartridge does not (`CART_LOAD`: signature, format, identity, length). The image format is unchanged:
  the packer (the IDE, `tools/forthcart.py`) still writes the CRC and checks the SAVE-LIB tape's. A refused image is
  one with another identity, a length over 16,128 or a start word of length 0. The load now takes 1.0M T for a
  small program and 1.34M T for the largest.
