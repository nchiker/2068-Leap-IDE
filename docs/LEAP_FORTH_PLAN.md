# Plan: Leap-Forth in the Leap IDE

Status: updated 2026-11-02 (**the IDE moved to 2068-Forth v2.0.1**: tag `v2.0.1`,
merge `0dabe74`, released 2026-11-02; the `STICK` fix, HOME changed to
`f0cd0785…`, EXROM unchanged, `ROM_IDENTITY` `$F001`; TSRun `main` `02e5325`
carries it, the IDE pin is now `c52f272`. The ROM entry, `forth-words.js`,
`examples.js` and `tests/forth-manual-examples.json` were regenerated at the tag
(the same 313 manual blocks, lines shifted) and `cartridge/forth/2.0.1/` was
added, in `4c02f48`; the v2.0 entry and `cartridge/forth/2.0/` stay. All 313
blocks now pass: the `2 STICK .` difference noted under F6 is fixed, so the
`KNOWN` list is gone and the difference is expected, with its own check, only
when the 2.0 ROMs are tested. The release answers
`requests/LEAP_FORTH_STICK.md`; no answer file arrived. The text below still
describes v2.0 where it names versions and addresses.) Earlier status, updated
2026-11-01. **F0, F1, F2, F3, F4, F5, F6 and F8 are done** (F0
to F2 `b9526ce`, Send, Ctrl+Enter, after it; F3 `a3869d4`; Import session
`89a6d48`, the last part of F1; F5 `6103f66`; F4 `054198d`; F8 `f7a5d1d`; F6
`50fb417`). Open: F7 and the optional watches of F1 (and the optional LIB
tape). Prerequisite (done, `3ed5d3b`):
stage 0 of [`MULTI_LANGUAGE_PLAN.md`](MULTI_LANGUAGE_PLAN.md) (the language
profile). The Forth project has answered the IDE's questions
([`requests/LEAP_FORTH_ANSWERS.md`](requests/LEAP_FORTH_ANSWERS.md)), and
**2068-Forth v2.0 is released** (2026-11-01, tag `v2.0`, commit `50170f2`),
with its manual and its cartridge build. **Next after stage 0**: the order is
stage 0, then Forth and Leap-C, both unblocked, Forth first because its
release, manual and cartridge are all complete (owner, 2026-11-01; see
`MULTI_LANGUAGE_PLAN.md`).

**Leap-Forth** (`~/2068-forth`, "2068 FORTH V2.0") is a subroutine-threaded
Forth for the TS2068 with BASIC-flavoured extras (`STRING`, `ARRAY`, `PLOT`,
`BEEP`, …), built on a copy of Leap V2's kernel. Unlike BASIC and C there is no
compile-then-run step: the interpreter reads the source word by word,
executing or compiling each one. That changes how Run, error checking and the
debugger work, and the natural Forth workflow is interactive, so in the IDE
the Forth prompt stays live and the editor sends text to it (see
"Interaction model").

Overall difficulty: **medium**. The run model and the interaction model are
new (the IDE has never let the user type at a ROM prompt), but the Forth
project's answers gave the IDE a clean entry for sending a line, a cell with
the last error and a label for the line table, so the risky parts of the
first draft are settled. The debugger panel itself is easy and could be the
best of the three.

Authorities, in order: the Forth manual in the release (`docs/manual/01…08`;
the word reference is `03_language.md` and `04_machine.md`) and `docs/V2/*.md`
specs for the language; the release's `symbols/forth_boot.sym` and
`graphics_exrom.sym` for addresses; `tools/fharness.py`, `tools/edtest.py`,
`tools/tapetest.py` and `tools/forthcart.py` for how the ROM is driven.
**Everything below is named by label or cell, not by address: addresses move
with every build, names do not** (the Forth project keeps every name this plan
uses stable; a rename would be a breaking change, announced in its CHANGELOG).
The IDE's ROM entry takes every address from the `.sym` files
(`tools/forth-rom-entry.py`, F0).

---

## Facts this plan rests on

Sources: the Forth project's answers (`requests/LEAP_FORTH_ANSWERS.md`, "A")
and the release bundle.

| Item | Value | Source |
|---|---|---|
| Release | `v2.0`, 2026-11-01, commit `50170f2`; version text "2068 FORTH V2.0" (`FORTH_VERSION_TEXT`, also on the status bar at power-on). Earlier: `v0.1.0` | GitHub release; A Q6.6 |
| Release zip | `roms/forth_boot_rom0.bin` (HOME, 16K, SHA-256 `730c86d0…`), `roms/graphics_exrom.bin` (EXROM, 8K, `fd877dd0…`), `roms/forth_cart.dck` (the cartridge with no program), `symbols/forth_boot.sym`, `graphics_exrom.sym` and the `.lst` files, `docs/manual/01…08`, `demos/blackjack.fs`, `gallery.fs`, `SHA256SUMS` | the release |
| TSRun | The fork's `main`, commit `11731e1`, carries exactly the v2.0 ROMs as `roms/leapforth-0.rom` / `leapforth-1.rom` (Leap V2 and Leap-C ROMs unchanged). The IDE's submodule was at `016787f`, whose Forth pair (`760a5ce3…` / `2add175c…`) was an older build; F0 moved it to `11731e1` (done, `b9526ce`). It has since moved on to `9f9bbc5` (Leap-C 1.0.0 ROMs; the Forth pair is unchanged) | TSRun; `git` |
| Without the EXROM | `EDIT`, `FILL`, `CIRCLE`, `RECT`, `POLYGON`, sprites say `NO EXROM` | README |
| Console | `EDITOR_LOOP_LIVE` handles one typed line. Entry points the IDE uses: `EDITOR_LOOP_LIVE.enter` (what ENTER does) and `EDITOR_LOOP_LIVE.key_ret` (the return address of the prompt's key wait). Input line: `EDIT_BUF` (128 bytes, `EDIT_MAX_LEN`), `EDIT_LEN`, `EDIT_CURSOR` (the byte after `EDIT_LEN`) | A Q1, Q3 |
| Line store | CR-ended plain text from `STORE_START` to `STORE_END` (cells; 8,192 bytes at most). `STORE_APPEND` adds a line (empty lines are not stored). Command lines (`SAVE-TEXT`, `LOAD-TEXT`, `EDIT` …) are taken off it, so it holds source only | A Q1 |
| Interpret routine | `INTERPRET_RUN` (HL = source, DE = length). The IDE does **not** call it: it enters through `EDITOR_LOOP_LIVE.enter` | A Q1 |
| Idle point | `IO_READ_KEY.wait_hit` (= `IO_READ_KEY`); `KBD_LASTK`, `KBD_KEYHIT` | `.sym` |
| Prompt test | PC at `IO_READ_KEY` and the word at SP = `EDITOR_LOOP_LIVE.key_ret`. A program waiting in `KEY`, `ACCEPT` / `INPUT` or `EDIT`'s view is at the same PC with another return address | A Q3 |
| Keys | Same SYMBOL SHIFT change as Leap-C (SS+A..G = `~ \| \ { }`, SS+H = `^`) | `kernel/io/io.asm` vs 2068-Leap |
| Last error | `LAST_ERROR` (2-byte cell): the code the last console line ended with, 0 = `OK`, else the ANS code (table in A Q2.2: -1 `ABORT`, -3 / -4 `STACK?`, -5 `RETURN STACK FULL`, -8 `DICTIONARY FULL`, -13 `name ?`, -16 `MISSING NAME`, -28 `BREAK`, -37 `TAPE ERROR`, -42 `DIVISION BY ZERO`, -43 `OUT OF RANGE`, -46 `INVALID ARGUMENT`, -56 `QUIT`, other = the program's own `n THROW`). Set by `REPORT_INTERP_ERROR`, cleared when a line ends in `OK` | A Q2.2 |
| Error entry points (optional) | `INTERPRET_UNKNOWN_WORD` (`WORD_BUF` = the token, upper case; also reached from a compile-only word at the prompt and from `EDIT name`), `RUNTIME_ERROR_HOOK` (`THROW_CODE` = the code; every uncaught THROW, BREAK and the stack check), `REPORT_INTERP_ERROR` (HL = the code). Both stacks may already be reset there; `INTERP_ERROR_FLAG` set in the last | A Q2.1 |
| Error position | `SRC_PTR` is just past the failing token **and the one delimiter after it**; for an error raised inside a word called from the line, past that word's token, unless the word read further input (`'`, `CHAR`, `."`, the defining words, `FORGET`, `EDIT`, the tape words: then past what it read). `STACK?` is found before the next token is read. Column in the line = `SRC_PTR - EDIT_BUF`. Inside text that `LOAD-TEXT` or `EDIT` ran, `SRC_PTR` points into the store (tell by range) | A Q2.3 |
| BREAK | THROW -28, since step "BREAK and timing" (PR #15, 2026-11-01): stops any running word, also one waiting in `KEY`, `ACCEPT` or `INPUT` (the console prints `BREAK`, back to the prompt; caught as -28 under `CATCH`). At the prompt and in `EDIT`'s view BREAK is a key. `SPRITE-*`, `HIRES` / `NORMAL` finish first | A Q2.4 |
| `NOBRK` | The console sets it right after `call INTERPRET_RUN`; a host that returned past that instruction would leave BREAK live at the prompt. Entering through `.enter` avoids it | A, intro |
| Compile hook | `INTERPRET_NESTED.token`: one source token has been read; `WORD_BUF` holds it, `SRC_PTR` is past it and its delimiter, `HERE` is where its code goes. `COLON_XT` (cell, set while a definition is open) = `LATEST` + 3 + the name length: the start of a colon definition's code | A Q4 |
| Stacks | Data: `IX`; float: `IY`, 5-byte Sinclair floats; return: Z80 SP (CALL addresses mixed with `DO` and `CATCH` data). Bounds from `include/forth_layout.inc` / the `.sym` | `forth_layout.inc` |
| Dictionary | RAM from `$9100` (fixed: **not relocatable**, compiled code holds absolute `CALL`s and links) to the dictionary limit (16,128 bytes at most; the part under `$A000-$BFFF` is hidden while the EXROM is in). `LATEST`, `HERE`, `STATE`. Headers `LINK(2) LENFLAGS(1) NAME code`; user words have header ≥ `$9100` | `core/dict.asm`; A Q7.3 |
| Words | 184 headers (`H_*` in the `.sym`) = 184 manual entries | `.sym`; A Q5 |
| Manual | `docs/manual/` parts `01_` to `08_`; `03_language.md` (stack, arithmetic, float, memory, strings, control, dictionary, errors) and `04_machine.md` (I/O, graphics, sound, storage, printer) hold one entry per ROM word, in ASCII order. Entry shape under F2. The build checks the manual against the ROM (`tools/manualcheck.py`) and runs every example (`tools/docexamples.py` -> `tests/doc/manual_*.fs`) | A Q5 as built |
| Numbers | `[-] digits [. digits] [E\|e [+\|-] digits]` or `[-] . digits [exponent]`, the whole token. A point or an exponent makes a float (on the float stack); otherwise an integer from -32768 to 65535 (a 16-bit pattern: `40000` is -25536). `+5` is not a number. Out of range: `OUT OF RANGE` (-43). Decimal only: no `BASE`, `HEX` or prefixes | A Q6.3 |
| Line length | 128 characters at the prompt and in `EDIT`'s view; `LIST-DEFS` shows the first 20 of a definition; `SAVE-TEXT` saves the store as it is | A Q6.1 |
| Words that read past their token | To a delimiter: `\` (end of line), `(` (to `)`), `."` and `S"` (to `"`). The next token, a name: `:` `CREATE` `VARIABLE` `CONSTANT` `ARRAY` `STRING` `FVARIABLE` `FCONSTANT` `'` `[']` `CHAR` `[CHAR]` `FORGET` `EDIT` (optional) `SAVE-TEXT` `LOAD-TEXT` `VERIFY-TEXT` `SAVE-LIB` `LOAD-LIB` `VERIFY-LIB`. There is no `WORD`, `PARSE` or `.(` | A Q6.2 |
| Graphics | `PLOT ( x y -- )` x 0-255, **y 0-191 from the top**, off-screen draws nothing; `LINE ( x1 y1 x2 y2 -- )` signed 16-bit ends, the on-screen part drawn; `CIRCLE ( xc yc r -- )` | A Q6.4 |
| UDGs | 21, codes 144-164, 8 bytes each (top row first) at `UDG_TABLE`; `n UDG ( n -- addr )`; `EMIT` of 144-164 draws them. Outside the dictionary: `SAVE-LIB` does not save them | A Q6.4 |
| Tapes | TEXT: header type 0, parameter 1 `$8000`, parameter 2 the length, data = the line store less the console line holding the command (`SAVE-TEXT`, `VERIFY-TEXT`, `LOAD-TEXT`, all `( "name" -- )`); LIB: type 3, dictionary + CRC, tied to `ROM_IDENTITY` | A Q6.5; `STORAGE_SPEC.md` |
| Case | Names are matched in upper case; input a-z is folded | `core/interp.asm` |
| Not present | `EVALUATE`, `BLOCK` / `LOAD`, `INCLUDE`, `ABORT"`, `DEPTH`, `.S`, `>R` / `R>`, `BASE` / `HEX` (survey of `core/`, 2026-10-31; check against the manual's 184 entries when generating the word data) | survey |
| Cartridge | `make cart` in the Forth repository; layout and program image under F8; `roms/forth_cart.dck` in the release | A Q7 as built |

## Interaction model: console first (owner decision, 2026-10-31)

The IDE's rule for BASIC and C stays: all editing happens in CodeMirror, and
keys reach the TS2068 only while an injected program runs. **Forth is
different, by the owner's choice (option C of three considered):** the Forth
prompt is live all the time, as on the real machine, and the editor is a
scratchpad whose text is sent to that session.

- **The TS2068 screen always takes keys** in Forth when it has focus: the
  `OK` prompt, the ROM's own line editor, `EDIT`, `KEY` / `INPUT`. Escape is
  BREAK, as elsewhere.
- **Run (F5) sends the whole editor text** to the live session, without a
  reset, **line by line** (see F1), exactly as if it had been typed:
  definitions accumulate, a redefinition shadows the old word (Forth's normal
  behaviour). It stops at the first line that ends in an error.
- **Send (Ctrl+Enter) sends the current line or the selection**, line by line.
- **Reset (cold start)** gives a fresh Forth with an empty dictionary; a
  toolbar button, with "discard the session's words?" if any exist.
- **Import session** copies the ROM's line store (everything typed or sent,
  `STORE_START` to `STORE_END`; source only, command lines are not in it) into
  the editor, so work done at the prompt or in `EDIT` is not lost. It opens as
  a new unsaved document (owner, 2026-10-31), with the usual "discard
  changes?" first. A `LOAD-TEXT` replaces the store with the tape's text.
- What is typed at the prompt is not written back to the editor
  automatically; the editor and the session can differ, and Import session is
  the bridge.
- Send is refused while Forth is busy (not at the prompt): "Forth is
  running: press Stop (BREAK) first".

The rejected options were A (Run = fresh machine + whole text, no prompt) and
B (A, then the prompt left live).

## Stages

Each stage ends with the tests green and is committed on its own.

### F0 — Pin the Forth build

**Done (2026-11-01, `b9526ce`).** The submodule is at `11731e1`;
`tools/forth-rom-entry.py` takes the unpacked release zip (`forth_boot.sym`,
`SHA256SUMS`) and the entry is in `src/lang/forth/forth-roms.js`. Not done:
copying `forth_cart.dck` to `cartridge/forth/2.0/` (that is F8).

- **Done by the Forth and TSRun side:** the tag `v2.0` exists (commit
  `50170f2`) and the TSRun fork's `main` at `11731e1` carries exactly the
  v2.0 ROMs as `roms/leapforth-0.rom` / `leapforth-1.rom`, with the Leap V2
  and Leap-C ROMs unchanged.
- **To do here:** move the `tsrun/` submodule from `016787f` to `11731e1`
  (`git -C tsrun fetch && git -C tsrun checkout 11731e1`, commit the bump);
  confirm the two Forth ROMs against the release's `SHA256SUMS` (`730c86d0…` /
  `fd877dd0…`) and that the V2 ROM pair is unchanged, so the BASIC entry in
  `src/leap-roms.js` still matches; run both test suites.
- **To do here:** write `tools/forth-rom-entry.py <checkout or release>
  <version>`. It prints the Forth profile's ROM entry from the two `.sym`
  files of that build (the labels and cells named in "Facts", `ROM_IDENTITY`,
  the cartridge image offsets `CART_IMG_*` and `CART_MAGIC`) and checks the
  key-wait bytes. No symbols are missing any more: the labels the IDE asked
  for are in v2.0.
- Copy the release's `forth_cart.dck` to `cartridge/forth/2.0/` (F8).

### F1 — The live session: keys, Send, Run, Reset

**Done (`b9526ce`; Import session `89a6d48`), except the optional watches**: keys
always pass (`keyboard.always`), Run sends line by line (`driver.inject` /
`next`, `canInject`), the failing token is marked from `SRC_PTR`, Stop is
BREAK held 5 frames (`breakHold`), Reset is TSRun's. **Deviation:** Run stops
at the first line whose `LAST_ERROR` is not 0 and sends nothing after it.
**Send** (Ctrl+Enter / Cmd+Enter: the cursor's line or the selection's whole
lines) was added after the commit (`getSendText` / `onSend` in
`src/editor.js`, `sendSelection` in `ide.js`). **Import session** is done too
(`89a6d48`): the "Import" button in the emulator panel header
(`#btn-import-session`, shown for a profile with `hasSession`) calls
`attach().importSession(m)`, which reads `STORE_START` to `STORE_END` as text
(CR becomes a newline) and `ide.js` opens it as a new unsaved `session.fs`
after the usual "discard changes?"; an empty session or a `STORE_END` outside
the store gives a message.

- **Keyboard:** in Forth the screen passes keys through whenever it has focus
  (the profile switches off the "only while a program runs" gate of the BASIC
  and C profiles). The Forth SYMBOL SHIFT table (same as Leap-C's), so `\`
  (comments) and `{ } ~ | ^` can be typed.
- **Prompt detection:** the session is "at the prompt" when PC = `IO_READ_KEY`
  and the word at SP = `EDITOR_LOOP_LIVE.key_ret`. If PC is at `IO_READ_KEY`
  and the word at SP is anything else, a word waits in `KEY`, `ACCEPT`,
  `INPUT` or `EDIT`'s view: keys typed on the screen go to it, and the line is
  not done. Only at the prompt can a line be sent.
- `prepare(text)`: split into lines; each at most 128 characters
  (`EDIT_MAX_LEN`, the profile's `lineLimit`), printable ASCII, no CR. An
  empty line is skipped (the ROM does not store it either) and the IDE keeps
  the map back to editor lines. The store is 8 KB: refuse (or warn) when the
  session's `STORE_END` plus the text would not fit.
- **`inject` (Send and Run), one line at a time**, the protocol of the Forth
  project:
  1. at the prompt, write the line into `EDIT_BUF`, its length into `EDIT_LEN`
     and the same value into `EDIT_CURSOR`;
  2. drop the key wait's return address (SP + 2) and set PC =
     `EDITOR_LOOP_LIVE.enter`; leave interrupts on (the keyboard and `FRAMES`
     run from them);
  3. let it run. The ROM does exactly what ENTER does: `STORE_APPEND`, run,
     print `OK` or the error's message, drop a `:` definition an error left
     open, clear the input line, wait for the next key. The line does not show
     on the input row as typed keys would; its output appears as after a typed
     ENTER;
  4. the line is done when the machine is **at the prompt** again. Read
     `LAST_ERROR`: 0 means `OK`. Stop sending at the first line with a
     non-zero code, and report it.
  If a line starts a word that waits for a key, the queue waits: the user
  types on the screen, and the next line goes when the prompt returns.
  Appending to the store is done by the ROM itself, so `EDIT`, `LIST-DEFS`,
  `SAVE-TEXT` and Import session stay consistent with what typing would have
  produced. Find the prompt with a watch on the PC (single-step) so the next
  line goes at once instead of at a frame boundary (**check** the speed with a
  300-line program).
- **Why one line at a time, not the whole text in one `INTERPRET_RUN` call**
  (A Q1.2): typed lines and CR-separated text differ. `(` runs on over CRs to
  the next `)` in one call, but at the prompt it ends with the line; `."` and
  `S"` with a missing `"` likewise run on into the next lines. An error stops
  the rest of the text, and only one `OK` is printed for the whole. `\` ends at
  a CR, and `STATE` and an open `:` definition carry across lines either way.
  Consequence for the IDE: a `( … )` comment or a string that spans lines does
  not work when sent line by line, exactly as at the real prompt; the
  tokenizer (F2) and the static checker (F3) treat both as ending at the end
  of the line and flag it.
- **Why not interpret from the line store** (A Q1.3): `LOAD-TEXT` loads its
  tape into the store from `STORE_START`, so the text being interpreted would
  be overwritten under `SRC_PTR`; `EDIT`'s view inserts and deletes lines in
  the store, moving everything after them; and `SAVE-TEXT`, `VERIFY-TEXT`,
  `LOAD-TEXT` and `EDIT` take the console line holding the command off the
  store (`STORE_TRIM`: `STORE_END` back to `STORE_LAST_LINE`, the last line
  appended), which would drop the wrong line if several lines were appended
  ahead of the run. `EDIT_BUF` is what the prompt itself interprets.
- **Errors:** `LAST_ERROR` after the line, no watches needed. The column in
  the line is `SRC_PTR - EDIT_BUF` (read it at the prompt: it is not reset). It
  is just past the failing token and one delimiter, so the failing token is
  the one ending at `SRC_PTR - 1`; for a word that read further input it is
  past what that word read. Since the IDE sends one line at a time, the editor
  line is the line being sent. If `SRC_PTR` is outside `EDIT_BUF`, the error
  happened in text that `LOAD-TEXT` or `EDIT` ran: "in the store", no editor
  line. Watches on `INTERPRET_UNKNOWN_WORD` (token in `WORD_BUF`) and
  `RUNTIME_ERROR_HOOK` (`THROW_CODE`) are **no longer necessary**; they stay
  an optional extra (for example to read the token name before the message is
  printed). The status text comes from a small table of the ANS codes above,
  cross-checked with the manual's error entries.
- Status bar: `OK`, `UNDEFINED WORD foo on line L` (-13), `DIVISION BY ZERO
  (THROW -42) on line L`, `Stopped (BREAK)` (-28), `Forth is running`,
  `Waiting for a key`.
- **Stop:** BREAK (CAPS SHIFT+SPACE) while busy. Since PR #15 it stops any
  running word, including one waiting in `KEY`, `ACCEPT` or `INPUT`, so (unlike
  V2) no jump back to the command loop is needed. At the prompt there is
  nothing to stop (BREAK is a key there). `SPRITE-*` and `HIRES` / `NORMAL`
  finish before they stop.
- Reset: TSRun reset and boot to the prompt.
- Import session: read `STORE_START` to `STORE_END` back as text (done).
- Node checks: send definitions then a call printing a result; send twice
  (words accumulate); an undefined word with its editor line and column; a
  THROW (division by zero) with its line; a run stopping at the first error;
  BREAK in an endless `BEGIN AGAIN` (-28); BREAK in a `KEY` wait; Send refused
  while busy; a word waiting in `KEY` is not mistaken for the prompt; a line
  typed at the prompt through the keyboard matrix; a `(` comment spanning
  lines behaves as at the prompt; Import session returns what was sent and
  typed; Reset empties the dictionary.

### F2 — The Forth editor

**Done (`b9526ce`)**: `src/lang/forth/editor.js` and `forth-scan.js`, the
generated `forth-words.js` (184 words, the manual's Parts 3 and 4) and the
Help overlay. **Not done:** the cross-check of the names against the `H_*`
headers in the `.sym` files (the count, 184, does match).

- **Tokenizer** (`StreamLanguage`): words separated by whitespace (CR, TAB and
  control bytes are whitespace to the ROM). Words that read past their own
  token, from the list under "Facts": `\` to end of line; `( … )` and `."` /
  `S"` strings to their closing delimiter, **but only within the line** (sent
  line by line, an unclosed one does not continue: mark it); the name after
  `:`, the defining words (`CREATE` `VARIABLE` `CONSTANT` `ARRAY` `STRING`
  `FVARIABLE` `FCONSTANT`), after `'` `[']` `CHAR` `[CHAR]` `FORGET` and the
  tape words. Numbers by the grammar under "Facts" (integers -32768 to 65535,
  floats with a point or exponent, no `+5`, no hex). ROM words highlighted by
  group (stack, arithmetic, float, memory, strings, control, dictionary, I/O,
  graphics, sound, storage, printer, from the manual); EXROM words marked as
  such; the program's own words in another colour.
- Case-insensitive matching (the ROM folds a-z). **No auto-caps** (owner,
  2026-10-31: whatever is easier). Leaving it off is: the BASIC auto-caps
  would need Forth-specific rules (words like `."` and `+!`, the string after
  `."`, `( … )` comments), and the ROM accepts lower case anyway. Completion
  inserts ROM words in upper case, as the manual writes them.
- **Word data, generated** by `tools/gen-forth-words.py <checkout> <ref>`
  (output `src/lang/forth/forth-words.js`, never hand-edited) from
  `docs/manual/03_language.md` and `04_machine.md` at the release tag, in the
  as-built format. An entry is:

  ````
  ## NAME                    the ROM's spelling (## \, ## ."  , ## ['])
  `( stack -- effect )` -- **kind**, group
  the first paragraph of description
  ```forth     (the first example, lines with `\ expect: TEXT`)
  **Notes.** / **Errors.** (a table) / **See also**, then ---
  ````

  Kinds: `word`, `immediate word`, `compile-only word`, `defining word`,
  `EXROM word`. The stack effect itself contains ` -- `, so split the line on
  ` -- **`; float-stack effects follow `F:` (`( n -- ) ( F: -- f )`). Each
  part's Summary table lists the words by group
  (`| **group** | `A` `B` … |`). Keep `desc` (first paragraph, at most 420
  characters), `example` (without the `\ expect:` lines for display; with
  them for tests, F6) and the manual section for the Help link. Expect 184
  entries and **fail** if the count or the names differ from the `H_*` headers
  in `forth_boot.sym` / `graphics_exrom.sym` (the Forth build already checks
  the manual against the ROM; this checks the IDE's copy). Hover help shows
  the stack effect prominently; Help links to the manual section at the
  release tag.
- Structure tools: fold `:` … `;`; indent `IF` / `ELSE` / `THEN`, `DO` /
  `LOOP` / `+LOOP`, `BEGIN` / `UNTIL` / `WHILE` / `REPEAT` / `AGAIN`; block
  match on those. Symbols: colon definitions, variables, constants, arrays,
  strings. Go to definition and rename for the program's own words (a Forth
  name can contain almost any character, so rename's checks differ).
- **Line limit 128** (the profile's `lineLimit`; ruler and too-long marking as
  in BASIC).
- Completion: ROM words with their stack effect as detail, the program's
  words, snippets for `: name ;`, `IF THEN`, `DO LOOP`, `BEGIN UNTIL`.

### F3 — Error checking (static)

**Done (`a3869d4`)**: `src/lang/forth/forth-check.js` (`checkForth`,
`readSessionWords`, `numberInRange`; pure, Node imports it) over
`forth-scan.js`, whose `lineTokens(line, ctx)` now follows the interpreter's
state across lines (`scanContext()`: inside `: … ;` or `[ … ]` a defining word
reads no name; a word whose definition uses `CREATE` and the like defines the
name after it). Everything in the list below is checked, with the ROM's
wording (the unknown word reads `UNDEFINED WORD: X …`). **Deviations and
details:** the check is **advisory**: Run does not refuse a program it flags.
A `(` comment not closed on its line is a **warning** (diagnostics may carry a
`severity`; the rest of the line is the comment, but it does not continue),
a `."` or `S"` string not closed on its line is an error. The session's words
are read from the dictionary (`LATEST` down to `FORTH_DICT_RAM`, headers
`LINK(2) LENFLAGS(1) NAME`, the name's length in bits 0 to 4) at the prompt's
key wait: `emulator.onKeyWait(fn)` (called by the frame loop at every key wait
of the language's own ROMs), wired in `ide.js` to `attach().keyWait(m)`, which
reads again only when `LATEST` changed; `sessionStamp()` (`LATEST`) is polled
with the debugger refresh interval and the editor is checked again when it
changes (a word typed at the prompt, a Reset). The "optional hidden-machine
check" below was not built.

The hidden-machine trick does not transfer cleanly: checking a Forth program
means running it (top-level code executes, may loop forever or draw). So the
first version is a **static checker** in JavaScript, with the ROM's own
wording:

- a word that is neither a ROM word, nor defined *earlier* in the text, nor
  already defined in the live session (the user words in the dictionary,
  header ≥ `$9100`, read after each Send and whenever the prompt is reached;
  order matters in Forth: this catches use-before-definition);
- unbalanced control structures inside a definition; control words outside
  one (the ROM says `name ?` for a compile-only word at the prompt); `;`
  without `:`; a `:` without `;` at the end;
- a `(` comment or a `."` / `S"` string not closed **on its line** (it would
  run on in one call but does not when sent line by line); a defining word or
  `:` without a name on the same line (`MISSING NAME`, -16);
- a number out of range (`OUT OF RANGE`, -43), by the grammar under "Facts";
  a line over 128 characters;
- EXROM-only words are fine (the IDE always has the EXROM).

Later, optional: a hidden-machine check that sends the text line by line
(F1's protocol, which gives the first error from `LAST_ERROR` for free) with
a cycle budget, for definitions-only programs. F8 builds that machine anyway.

### F4 — Debugger

**Done (`054198d`)**: `src/lang/forth/forth-debug.js` (`createLineTable`,
`readWords`, `readStacksAndWords`, `readCallStack`, `promptLines`; pure, Node
imports it), the profile's `createDebugAdapter(rom)`, and the generic changes
in `src/debugger.js` and `ide.js` (`beginRun(job)` passes the job to the
adapter's `reset`; `adapter.version()` makes the controller place the
breakpoints again when the table grows; `adapter.labels.variables` sets the
Variables section's title, here "Stacks and words"; `adapter.live` shows the
table between runs). The line table is built as the plan below says (the
records at `INTERPRET_NESTED.token` with `STATE` 1, `COLON_XT` on the line of
the `:`, `SRC_PTR` outside `EDIT_BUF` ignored; records are instruction starts
only, so a breakpoint or a Step never lands in inline data). `tools/forth-rom-entry.py`
now emits `doLit`, `doFLit`, `doDoes`, `qBranch`, `branch` and `stkGuard`
(the 2.0 entry was regenerated from the release zip). **Deviations and
details:**

- **Positions.** A record's address, or `TOP` (`0x10000`) + n when job line n
  is sent, so a breakpoint on a line **outside a definition** stops when the
  line is sent (`promptLines`); one in a word stops where each stretch of that
  line's code starts, not at every token of it. The plan's "word-level
  breakpoints" (stop when the PC reaches a word's code, however it is
  called) were **not built** as a separate kind: a breakpoint on a `:` line
  stops at the code of that line's records, which a call from the prompt also
  reaches.
- **Step** is token by token, into the program's words, and stops at each line
  sent; there is no step over / step out (the records make every stop safe).
  Stop while paused is BREAK (`halt` false).
- **Variables** ("Stacks and words"): the data stack (up to 16 cells, signed
  and hex), the float stack, then the session's words newest first with their
  values; the kind comes from the word's code (`CALL DOLIT` is a `VARIABLE`,
  `FVARIABLE`, data area or `CONSTANT`, `CALL DOFLIT` an `FCONSTANT`,
  `CALL DODOES` a `CREATE`d word). `HERE`, `LATEST` and `STATE` are not shown,
  and the return stack is not a section of its own: it is the call stack.
- **Call stack**: the word the PC is in, then the user words whose `CALL`s are
  on the return stack (an entry counts only when a `CALL` precedes it and it
  lies in a user word; `DO` loops and `CATCH` frames share the stack), then
  "the line sent".
- **Limit:** the records are reset by every Run **and Send**, so only the words
  the latest Run or Send defined have editor lines; a word defined earlier or
  typed at the prompt shows in the words table and the call stack but cannot
  carry a breakpoint (the plan's "word-level breakpoints only" for those was
  not built).
- Tests: `tests/rom-checks.mjs` section 8 drives the adapter as `src/debugger.js`
  does (a breakpoint in a word with the callers, Step word by word, the stacks
  and words); the browser test pauses at a breakpoint in a word and continues
  to OK.

The plan as written:

The generic panel (registers, memory, Z80 breakpoints) works as is. The Forth
sections:

- **Data stack** (`IX` up to the stack's base), **float stack** (`IY`,
  `decodeFloat` from `leap-debug.js` reused), **return stack** (SP up to its
  base), each value annotated: return addresses named by the word whose code
  contains them (headers sorted by address). Bounds from the ROM entry.
- **Dictionary:** the program's words (header ≥ `$9100`) with their
  addresses, `HERE`, `LATEST`, `STATE`, and the values of variables and
  constants.
- **Breakpoints on words:** a breakpoint on a `:` line stops when the PC
  reaches that word's code (found by walking the dictionary after each Send;
  the newest definition of a name wins). It fires however the word is
  called, including from the prompt.
- **Line-level breakpoints and Step** inside definitions, from a line table
  built by watching the interpreter: at `INTERPRET_NESTED.token`, while
  `STATE` is 1, record (the line being sent, `HERE`); the token's code is
  `HERE` up to the next record's `HERE`, and "the last record at or below the
  address" names the right token. Rules from the Forth project (A Q4):
  - `:` reads the name itself (not through `.token`) and runs with `STATE`
    0. The definition's code starts at `COLON_XT`; add the record
    (the line of the `:`, `COLON_XT`) when the first token of the body
    arrives (a `:` and its name are on one line, which the IDE knows from the
    line it is sending);
  - immediate words compile at `HERE` too (`IF`: `CALL QBRANCH` and a 2-byte
    target); `THEN`, `ELSE`, `REPEAT`, `UNTIL`, `LOOP`, `+LOOP` also patch
    bytes compiled by earlier tokens but put code nowhere else;
  - a recursive call compiles `CALL STK_GUARD` before it, under the same
    token; `;` compiles a plain `RET`; `EXIT` compiles `POP`s for the open
    `DO` loops, then `RET`; `[ … ]` runs with `STATE` 0 (no records);
    `LITERAL` after `]` compiles under its own token; `DOES>` patches a
    `CREATE`d word's jump at run time;
  - **inline data, never an instruction:** the 2 bytes after `CALL DOLIT`
    (integer literals, `[']`, `LITERAL`) and after `CALL QBRANCH` /
    `CALL BRANCH`; the 5 after `CALL DOFLIT`; the length and characters after
    the call that `."` and `S"` compile. A line breakpoint goes on the first
    byte of a record, which is always an instruction; **Step over** a call
    must not stop at the call's address + 3 (the callee returns past inline
    data): run to the next record's address;
  - `LOAD-TEXT`'s and `EDIT`'s nested runs pass `.token` too, with `SRC_PTR`
    in the store: ignore records whose `SRC_PTR` is outside `EDIT_BUF`.
  Step = run to the next record's address (and step into a user word
  entered by a `CALL`). Words defined by lines typed at the prompt have no
  editor lines; they get word-level breakpoints only.
- **Call stack** from the return stack, using the same naming.

### F5 — Tape export and Open

**Done (`6103f66`)**: `src/lang/forth/tape.js` (`buildForthTap`,
`forthTapeToText`, `isForthTape`, `textStore`, `LOAD_TEXT_MAX`,
`FORTH_TEXT_WORD` `$8000`), the profile's `hasTape`, `exportTape` and
`ownsTape` (Open switches to Forth; Leap V2 `$81xx` and Forth `$8000` tapes
are told apart, as are Leap-C's `$8C00`). Verified in Node: the tape is
byte-identical to the ROM's own `SAVE-TEXT` after the same lines were sent
(the block sender a stand-in; `FORTH_TAPE_SYMBOLS` in the tests holds
`STORAGE_SEND_BLOCK` `$09CE` and `STORAGE_RECEIVE_BLOCK` `$0A5D` for 2.0), and
the ROM's `LOAD-TEXT` reads it back and defines the words. The tape name is
upper-cased and has no spaces; at most 8 KB (`LOAD-TEXT`'s room). The LIB tape
below is still not done.

- `exportTape`: a TEXT tape (header type 0, parameter 1 `$8000`, parameter 2 =
  length; data = the source with CR line ends and no console line), as
  `tools/tape_gen_forth.py` writes. Verify against the ROM's `SAVE-TEXT` in
  Node and that `LOAD-TEXT` reads it back (confirmed by the Forth project). A
  program must not rely on lines that do not work line by line (F1). Status:
  `Saved X.tap: on the TS2068, LOAD-TEXT X`.
- Open `.tap`: recognise a Forth TEXT tape (type 0, parameter 1 `$8000`) and
  read the text back; switch to Forth (done).
- Later, optional: a LIB tape (compiled dictionary, `SAVE-LIB` format, tied to
  `ROM_IDENTITY`) captured from the live session. The cartridge (F8) reuses
  its format.
- DCK: stage F8.

### F6 — Examples and corpus test

**Done.** The Examples part came first (`b9526ce`): the menu is generated by
`tools/gen-forth-examples.py` and `tests/rom-checks.mjs` section 8 ran the 12
non-interactive programs to OK. The rest followed in `50fb417`. **As built, and
where it differs from the plan below:**

- **Reading the screen as `tools/forthtest.py` (v2.0) does.** For each line the
  test takes the screen rows from the print row (`PRINT_ROW`) before the line to
  the one after it, allowing for scrolling and CLS, drops trailing blanks, joins
  the rows with `|` and drops the final OK. It compares that with `\ expect:`
  (a line without one must print nothing) and `\ expect-end:` (ends with);
  `\ draws` is not read. The glyphs are learnt by calling the ROM's
  `GFX_PUTCHAR` for codes 32 to 143, as `fharness` does (an unknown cell is
  `░`, a UDG U+E000+i, inverse `•` plus the character). `FORTH_SCREEN_SYMBOLS`
  in the tests holds `PRINT_ROW` `$81CF` and `GFX_PUTCHAR` `$0705` for 2.0, from
  `~/2068-forth/build/forth_boot.sym` (its HOME ROM is byte-identical to
  v2.0's, SHA-256 `730c86d0…`); a new Forth release needs its entry.
- **Each case starts from a snapshot of a just-booted Forth**, and its lines go
  in one at a time through the IDE's Send path (`startRun` + `driver.inject`),
  which is `fharness`'s `host_line`, the path 2068-Forth made for the IDE.
- **`\ keys:` and `\ break:`.** `\ keys:` uses Python escapes (`\r` ENTER, `\b`
  DELETE, `\xNN`; `\x01` to `\x04` the cursor keys, `\x10` BREAK, which is
  Escape on a PC) and is typed on the keyboard matrix while the line waits.
  `\ break: after N` holds BREAK after N instructions until the prompt's key
  wait. **Deviation:** `\ break: at SYMBOL` is not supported; the manual uses
  only `after N`.
- **Deviation: the corpus is a generated JSON, not `tests/doc/*.fs`.** New
  `tools/gen-forth-doc-tests.py <2068-forth checkout> <ref> >
  tests/forth-manual-examples.json` (a port of `tools/docexamples.py`; generated,
  never hand-edited) holds every ```forth block of the manual with its
  directives: 313 at v2.0 (commit `50170f2`), identical to 2068-Forth's
  `tests/doc/manual_*.fs` (checked). The IDE reads the JSON, so it needs no copy
  of the Forth project's files.
- **One known difference on v2.0 (fixed in v2.0.1, 2026-11-02; the `KNOWN`
  list is gone, the check runs only with the 2.0 ROMs):**
  `2 STICK .` reads 1 in TSRun and 0 in the manual. `STICK_READ` reads AY port A
  without making it an input and Forth leaves the mixer (register 7) at `$F8`
  (port A an output); TSRun returns the output latch, as an AY-3-8912 does,
  while ZEsarUX returns the joystick lines. On a real TS2068 it probably reads 1
  too; reported (`requests/LEAP_FORTH_STICK.md`) and fixed in v2.0.1. All other
  blocks pass.
- **Examples.** `gen-forth-examples.py` now writes `keys` as `[line, text]` (the
  0-based line of the text the keys are typed for) and adds `demos/gallery.fs`
  (the Shooting Gallery; its header says it is the old demo ROM's source, not
  rebuilt for the finished ROM) as the entry `gallery`, `input: true`: 17
  programs. The 15 Part 7 programs run with their own `expect` and `keys` data
  (3 read keys) and all pass. The gallery loads on v2.0 (every line OK and
  silent) and `MAIN` shows the title screen ("SHOOTING GALLERY" on row 3); that
  is a check, not a play-through.

The plan as first written:

- Examples menu: from the release's `demos/*.fs` (`blackjack.fs`,
  `gallery.fs`) and the manual's examples.
- Corpus test in `tests/rom-checks.mjs`: the manual's ` ```forth ` blocks,
  which carry `\ expect: TEXT` lines (the format of the Forth project's
  `tests/*.fs`; its `tools/docexamples.py` makes `tests/doc/manual_*.fs` from
  them, each run on a just-booted ROM). The IDE runs each from a fresh session
  through its Send path, line by line, which is how `tools/forthtest.py` types
  them, so each test means the same. `\ keys:`, `\ break:` and `\ draws`
  lines are directives the IDE can ignore or implement.

### F7 — Tools (optional)

- **Draw tab:** generate Forth: `x y PLOT`, `x1 y1 x2 y2 LINE`,
  `xc yc r CIRCLE`; y from the top, 0-191; x 0-255. Every point can be
  written as decimal integers.
- **UDG tab:** the Forth ROM has 21 user-defined characters, codes 144-164,
  8 bytes each (top row first), `n UDG ( n -- addr )` giving a slot's address
  and `EMIT` of 144-164 drawing them. The tool's "Insert" would generate
  `n UDG` plus stores of the 8 bytes (**check** the memory words in the manual:
  `C!` or `!`), "Load from program" would read them back, and "Send to TS2068"
  works on the live machine through `UDG_TABLE`. The UDGs are outside the
  dictionary, so `SAVE-LIB` does not save them; the cartridge image carries
  them (F8).

### F8 — Cartridge (DCK) for a stock TS2068

**Done (`f7a5d1d`)**: `src/lang/forth/cartridge.js` (`programImage`,
`buildForthCartridge`, `cartImages`, `homeIdentity`, `crc16`, `findWord`,
`isForthCartridge`; pure), `cartridge/forth/2.0/` (the release's
`forth_cart.dck`, 24585 bytes, SHA-256 `4f07fd88…`, with a README; identity
`$FDBE`), the profile's `buildCartridge` and `interpretFresh`,
`hasCartridge: true` and `ownsCartridge`. **Deviations and details:**

- **No checker snapshot.** `interpretFresh` creates a fresh machine with the
  loaded ROMs each time (600 frames to boot, then 3000 frames in all for the
  text, about a minute of TS2068 time), sends the lines with F1's protocol and
  stops at the first line whose `LAST_ERROR` is not 0 (the error is named with
  its editor line), at a line that leaves the prompt (a `KEY`, `ACCEPT` or
  `INPUT` wait at the top level) and when the time is up. The dictionary is
  read from `m.ram` (the EXROM hides part of it).
- **The start word** is asked for with `ui.prompt` (`ide.js` passes
  `window.prompt`), listing the program's `:` words, the newest as the default;
  it is checked against the dictionary (1 to 31 characters), and stored as
  the dictionary spells it.
- **Checks before export:** the identity, the size (16,128 bytes at most),
  a program with no `:` word, an error while interpreting. `OUT` to port 244
  or 255 is found in the source text (`pagingWrites`: a literal port number
  before `OUT`, low byte 244 or 255) and asks to confirm; a port computed
  at run time is not seen.
- **Test DCK / Open `.dck`:** `ownsCartridge` recognises `"F1"` at DOCK
  `$4000`; `ide.js` hands that profile's keyboard table to
  `emulator.testCartridge(dck, symbols)`, and leaving the test puts the active
  profile's back (so a Forth cartridge opened from BASIC types as Forth does).
- **Verified:** in `tests/rom-checks.mjs` section 8 (the start word asked for,
  the DCK layout and flat image, the CRC, a stock TS2068 loading the
  cartridge, running `MAIN` (a variable set to 42), keeping the UDGs and
  leaving the OK prompt, an error naming its line, a start word that is not
  the program's refused, a program with no `:` word and another identity
  refused); in the browser test (▶ Test DCK with start word `MAIN`; Stop goes
  back to Forth); and outside the tests, the IDE's DCK and BIN for the
  Blackjack demo are byte-identical to `forthcart.py`'s for the same
  dictionary. **Not done:** a refused image printing `BAD PROGRAM` on the stock
  TS2068, ZEsarUX / Fuse runs, real hardware.

The plan as written:

Owner decision (2026-10-31): Forth gets a runtime cartridge build, as Leap V2
has, so ⬇ DCK and ▶ Test DCK work for Forth programs. **Built and released in
v2.0** (2068-Forth step Cartridge, `make cart`; hosted in the Forth repository,
the release ROMs do not change). The IDE side was what remained.

**As built (A Q7 as built).**

- **`make cart`** writes `build/cart/`: `forth_boot_rom0.bin` (HOME,
  `-DCARTRIDGE`), `graphics_exrom.bin` (the release EXROM, byte for byte),
  `forth_boot.sym` and `forth_cart.dck` (Forth with no program; also in the
  release as `roms/forth_cart.dck`). Every release label keeps its address,
  and the cartridge carries the release's `ROM_IDENTITY`
  (`tools/cart_check.py`), so a dictionary compiled on the release ROMs, or a
  LIB tape, is valid on the cartridge.
- **DCK layout:** bank 0 (DOCK). Chunks 0-1 hold HOME, with the LROS header
  `00 01 <CART_ENTRY lo hi> DC` at `$0000` (the entry stub starts with `di`).
  Chunk 2, and chunk 3 when the image is over 8 KB, hold the program image
  (DOCK `$4000-$7FFF`), padded with `$FF`. Chunk 5 holds the EXROM (it is
  assembled for `$A000`). Port `$F4` is `$03`, `$23` while an EXROM word
  runs, `$0F` while the image is copied; bit 7 of `$FF` is never set.
- **Cold start:** the normal `COLD_START`, then the image is checked
  (signature, identity, length; **not** the CRC, since the 2026-11-01 "Cart
  start" change, as Leap V2's production cartridge does not), copied to
  `$9100`, the UDGs to `UDG_TABLE`, `HERE` = `$9100` + n, `LATEST` from the
  image. A refused image (another identity, a length over 16,128, a start word
  of length 0) prints `BAD PROGRAM` and leaves Forth with an empty dictionary;
  no magic gives plain Forth. Hand-off at frame 103 with interrupts on. The
  load takes about 1.0M T-states for a small program and 1.34M for the largest.
- **Program image** at DOCK `$4000`, all little-endian (offsets in the build's
  symbols `CART_IMG_*`, `CART_MAGIC`):

  | Offset | Content |
  |---|---|
  | `+0` | `"F1"` (`$46 $31`) |
  | `+2` | `ROM_IDENTITY` (the same value as `SAVE-LIB`'s header parameter 1) |
  | `+4` | n = `HERE` - `$9100`, at most 16,128 |
  | `+6` | `LATEST` (`SAVE-LIB`'s parameter 2) |
  | `+8` | the start word's length (1-31), then its name, space-padded to 31 bytes |
  | `+40` | the UDG table, 168 bytes |
  | `+208` | the dictionary, n bytes |
  | `+208+n` | CRC-16/CCITT-FALSE of bytes `+0` to `+207+n`, low byte first |

- **After the start word: the `OK` prompt** (owner's choice). The start word
  runs from `EDITOR_LOOP_LIVE.enter` with its name in `EDIT_BUF` (the IDE's
  own run protocol), so its output, an error or `BREAK` look like a typed
  line's, the name is in the line store, and the program's words stay defined.
  Reset restarts the cartridge. Keys always reach the machine in a cartridge
  test (the existing `'cartridge'` mode), which is what Forth's live prompt
  needs.
- **Reference packer:** `tools/forthcart.py` in the Forth repository
  (`read_lib`, `program_image`, `dck`, `flat_bin`). It takes a `SAVE-LIB`
  `.tap` or `.tzx`, checks the identity, CRC and size, and that the start word
  is one of the program's words, and stores the name as the dictionary spells
  it.

**IDE side:**

- `cartridge/forth/2.0/` with the release's `forth_cart.dck` (and the
  cartridge `forth_boot_rom0.bin` / `graphics_exrom.bin` if the flat `.bin`
  is built from them), a README with the SHA-256s, and the identity check
  (`ROM_IDENTITY` of the IDE's loaded ROMs = the cartridge's; export refuses
  a mismatch, as for BASIC).
- A JavaScript port of the packer in `src/lang/forth/cartridge.js` (pure, no
  DOM; Node can import it): the image above, then the release
  `forth_cart.dck` with its chunk 2 (and 3, when the image is over 8 KB)
  replaced by the image padded with `$FF`, and the DCK header's chunk
  descriptors for those chunks set to ROM. Test it byte for byte against
  `tools/forthcart.py`'s output for the same program.
- The Forth profile's `buildCartridge`: a **hidden machine** booted from the
  checker snapshot (the same machine F3's optional check uses) receives the
  editor's text **line by line with F1's protocol**, with a cycle budget
  (top-level code runs). Then the IDE reads `HERE`, `LATEST`, the dictionary
  from `$9100` to `HERE`, the 168 UDG bytes and the identity, and packs the
  image. ⬇ DCK and ▶ Test DCK then work as for BASIC; the cartridge test picks
  Forth's keyboard table from the image signature (`"F1"` at DOCK `$4000`, with
  the LROS header at `$0000`).
- Checks before export: an error while interpreting (with its editor line and
  `LAST_ERROR`), the start word exists in the dictionary and is 1-31 long, the
  identity, the size (n at most 16,128), writes to the paging ports (`OUT` is
  not a Forth word the IDE can see; **check** the manual's port words), and
  that the hidden machine ended at the prompt.
- Tests: `tests/rom-checks.mjs` runs an exported Forth cartridge on a stock
  TS2068 (a start word that sets a marker, the prompt reached, UDGs present, a
  refused image printing `BAD PROGRAM`); a few in ZEsarUX / Fuse with the
  stock ROM.

**Owner decisions (made 2026-11-01, both as recommended; see "Owner decisions"):**

- **Which word starts the program:** a fixed name (`MAIN`), the last word
  defined, or chosen at export (a prompt listing the program's words,
  recommended).
- **What goes on the cartridge:** the editor's text, interpreted on a fresh
  hidden machine (recommended: reproducible, matches the file), or the live
  session's dictionary (whatever was typed at the prompt too).

Already decided: after the start word, the `OK` prompt (owner, per the Forth
project's "as built"); the build is hosted in the Forth repository as
`make cart`.

## Tests

- `tests/rom-checks.mjs`: a Forth section for each of F1 to F6, and F8's
  cartridge checks. Section 8 has F1, F3 (session words, a Reset, every
  example clean, the error and warning cases), Import session, F5 (the tape
  against `SAVE-TEXT`, `LOAD-TEXT` reading it back), F4 (the debugger adapter
  driven as `src/debugger.js` drives it), F6 (the manual's 313 blocks and the
  Examples menu against their `\ expect:` output, with `\ keys:` and `\ break:`)
  and F8 (the cartridge on a stock TS2068). 144 checks in all with Leap-C's and
  BASIC's at `f7a5d1d`; 157 now (the speed test, section 10, is in all three
  languages).
- `tests/browser-smoke.mjs`: switch to Forth, Run a definition and a call,
  Send one line, an undefined-word error on its line (done for the check: an
  undefined word marked, a session word known), type a word at the
  prompt and see its output, Import session (done), Reset, tape export and
  Open (done), a breakpoint in a word (done, F4), ▶ Test DCK (done, F8),
  switch back.

## Owner decisions

- **Interaction model (2026-10-31):** console first (option C), as described
  above.
- **Forth build (2026-10-31):** the one TSRun carries; it is v2.0 (tag `v2.0`,
  TSRun `11731e1`), F0.
- **Word data (2026-10-31):** from the Forth manual updated for V2; the manual
  is in the v2.0 release.
- **Auto-caps (2026-10-31):** whatever is easier, so none.
- **Cartridge (2026-10-31):** Forth gets a runtime cartridge build (F8); it is
  built. After the start word, the `OK` prompt.
- **Import session (2026-10-31):** opens a new document (done, `89a6d48`).
- **Order (2026-11-01):** stage 0, then Forth and Leap-C (both unblocked;
  Forth first because its release, manual and cartridge are complete).
- **Cartridge start word (2026-11-01):** chosen at export, from a list of the
  program's words (F8, built in `f7a5d1d`).
- **What goes on the cartridge (2026-11-01):** the editor's text, interpreted
  on a fresh hidden machine (reproducible, matches the file), not the live
  session's dictionary (F8, built in `f7a5d1d`).

## Still open

For the IDE: F7 (tools, optional), the optional watches of F1 and the optional
LIB tape; the Forth cartridge has run on TSRun's stock TS2068 only (ZEsarUX / Fuse and
real hardware not tried). Nothing is open with the Forth project (the `2 STICK` note was answered by
the v2.0.1 release, 2026-11-02; see the status at the top): all seven questions are answered
([`requests/LEAP_FORTH_QUESTIONS.md`](requests/LEAP_FORTH_QUESTIONS.md),
[`requests/LEAP_FORTH_ANSWERS.md`](requests/LEAP_FORTH_ANSWERS.md)), and the
hooks the IDE uses are in the `v2.0` tag (`tools/forth-rom-entry.py` found
them all). No owner choices are open: the two F8 choices were made on
2026-11-01 (see "Owner decisions").
