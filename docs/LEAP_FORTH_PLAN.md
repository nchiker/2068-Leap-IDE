# Plan: Leap-Forth in the Leap IDE

Status: proposal, 2026-10-31. Nothing here is started. Prerequisite: stage 0 of
[`MULTI_LANGUAGE_PLAN.md`](MULTI_LANGUAGE_PLAN.md) (the language profile).
Recommended after the Leap-C plan, but independent of it.

**Leap-Forth** (`~/2068-forth`, "2068 FORTH V2.0") is a subroutine-threaded
Forth for the TS2068 with BASIC-flavoured extras (`STRING`, `ARRAY`, `PLOT`,
`BEEP`, …), built on a copy of Leap V2's kernel. Unlike BASIC and C there is no
compile-then-run step: the interpreter reads the source word by word,
executing or compiling each one. That changes how Run, error checking and the
debugger work, and the natural Forth workflow is interactive, so in the IDE
the Forth prompt stays live and the editor sends text to it (see
"Interaction model").

Overall difficulty: **medium to high**. The run model and the interaction
model are new (the IDE has never let the user type at a ROM prompt); the
debugger panel itself is easy and could be the best of the three.

Authorities, in order: the Forth manual (being updated for V2, owner
2026-10-31; until then `docs/forth_tutorial.md` Appendix A, the word reference)
and `docs/V2/*.md` specs for the language; `build/forth_boot.sym` /
`graphics_exrom.sym` for addresses; `tools/fharness.py`, `tools/edtest.py`,
`tools/tapetest.py` for how the ROM is driven. Addresses below are from the
local build at `205ac04` and move with every build.

---

## Facts this plan rests on

| Item | Value | Source |
|---|---|---|
| Releases | Tags `v0.1.0` (2026-09-09) and a moving `latest`; HEAD `205ac04` | `git tag` |
| ROMs | HOME `forth_boot_rom0.bin` 16K, EXROM `graphics_exrom.bin` 8K (without the EXROM: `EDIT`, `FILL`, `CIRCLE`, `RECT`, `POLYGON`, sprites say `NO EXROM`) | `Makefile`, README |
| TSRun copy | `roms/leapforth-*.rom` at today's pin (`760a5ce3…` / `2add175c…`) differ from the current build (`d056a159…` / `6360ccf6…`); the owner will have TSRun carry the matching Forth ROMs by the time this project starts | `sha256sum`; owner, 2026-10-31 |
| Interpret routine | `INTERPRET_RUN` `$0DCC`: HL = source, DE = length; runs to the end of the text; CR / TAB / control bytes are whitespace, so a whole program goes in one call; errors unwind to `THROW_ROOT_SP` and return | `core/interp.asm:380-468` |
| Line store | CR-ended plain text, `STORE_START` `$D000` to `$F000` (8 KB); `STORE_END` `$83C5` | `include/forth_layout.inc` |
| Existing injection | Write text at `$D000`, set `STORE_END`, call `INTERPRET_RUN` | `tools/edtest.py:2002-2030`, `tools/tapetest.py:752` |
| Shell | `EDITOR_LOOP_LIVE` `$36FF`, `.keyloop` `$3709`; the `call INTERPRET_RUN` at `$3724` returns to `$3727` (no symbol) for the "OK" handling | `build/forth_boot.lst:13187` |
| Idle point | `IO_READ_KEY.wait_hit` `$054F`; `KBD_LASTK` `$80EF`, `KBD_KEYHIT` `$80F0` | `.sym`, `kernel/io/io.asm:307-312` |
| Keys | Same SYMBOL SHIFT change as Leap-C (SS+A..G = `~ \| \ { }`, SS+H = `^`) | `kernel/io/io.asm` vs 2068-Leap |
| Unknown word | `INTERPRET_UNKNOWN_WORD` `$0203` prints `TOKEN ?`; the token is in `WORD_BUF` `$8129`; **no error code is set** | `core/interp.asm` |
| THROW | `THROW_CODE` `$819A`; `RUNTIME_ERROR_HOOK` `$0247` prints the message, then **clears `THROW_CODE`**; ANS numbering (-8, -13, -16, -28, …) | `rom/forth_boot.asm:266-267, 311-320` |
| After any error | `REPORT_INTERP_ERROR` `$0239`: `STATE` 0, `INTERP_ERROR_FLAG` `$8128` = 1, stacks reset | `.sym` |
| Error position | `SRC_PTR` `$811B` (not reset) points just past the failing token; `SRC_END` `$811D` | `.sym` |
| Stacks | Data: IX, empty at `$9100`, limit `$8900`. Float: IY, empty at `$8900`, 5-byte Sinclair floats. Return: Z80 SP from `$FF00` (CALL addresses mixed with `DO` and `CATCH` data) | `include/forth_layout.inc:11-58` |
| Dictionary | RAM `$9100-$CFFF` (`$A000-$BFFF` hidden while the EXROM is in); `LATEST` `$81CC`, `HERE` `$81CE`, `STATE` `$811F`; headers `LINK(2) LENFLAGS(1) NAME code`; user words have header ≥ `$9100` | `core/dict.asm:12-16` |
| Words | 184 headers (`H_*` in the `.sym`) | `build/forth_boot.sym` |
| Word list | Today: `forth_tutorial.md:4939-5191`, Appendix A, Markdown tables `Word \| Stack effect \| Notes` by topic, no longer descriptions. The manual is being updated for V2 (owner, 2026-10-31); the IDE's word data will be generated from that | |
| Tapes | TEXT: header type 0, raw source, param1 `$8000`, param2 = length (`LOAD-TEXT`, `SAVE-TEXT`); LIB: type 3, dictionary + CRC, tied to `ROM_IDENTITY` | `docs/V2/STORAGE_SPEC.md:157-171`, `tools/tape_gen_forth.py` |
| Case | Names are matched in upper case; input a-z is folded | `core/interp.asm:13, 82` |
| Not present | `EVALUATE`, `BLOCK` / `LOAD`, `INCLUDE`, `ABORT"`, `DEPTH`, `.S`, `>R` / `R>`, `BASE` / `HEX` | agent survey of `core/` |

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
  reset, exactly as if it had been typed: definitions accumulate, a
  redefinition shadows the old word (Forth's normal behaviour).
- **Send (Ctrl+Enter) sends the current line or the selection.**
- **Reset (cold start)** gives a fresh Forth with an empty dictionary; a
  toolbar button, with "discard the session's words?" if any exist.
- **Import session** copies the ROM's line store (everything typed or sent,
  `$D000` to `STORE_END`) into the editor, so work done at the prompt or in
  `EDIT` is not lost. It opens as a new unsaved document (owner, 2026-10-31),
  with the usual "discard changes?" first.
- What is typed at the prompt is not written back to the editor
  automatically; the editor and the session can differ, and Import session is
  the bridge.
- Send is refused while Forth is busy (not at the `OK` prompt): "Forth is
  running: press Stop (BREAK) first".

The rejected options were A (Run = fresh machine + whole text, no prompt) and
B (A, then the prompt left live).

## Stages

Each stage ends with the tests green and is committed on its own.

### F0 — Pin the Forth build

- The owner will have TSRun carry ROMs matching the Forth version by the time
  this project starts. Move the submodule to that TSRun commit, as for a V2
  release, and confirm the ROMs' SHA-256 against the Forth build they came
  from.
- That build should have a tag in `2068-forth` (the ROM table is keyed by
  hash, and the word data is generated at a git ref; `latest` moves).
- Ask the Forth project to add symbols the IDE needs that have none today (the
  return point after `call INTERPRET_RUN`, `$3727`).
- `tools/forth-rom-entry.py <checkout> <version>` prints the Forth profile's
  ROM entry from the two `.sym` files of that build and checks the key-wait
  bytes.

### F1 — The live session: keys, Send, Run, Reset

- **Keyboard:** in Forth the screen passes keys through whenever it has focus
  (the profile switches off the "only while a program runs" gate of the BASIC
  and C profiles). The Forth SYMBOL SHIFT table (same as Leap-C's), so `\`
  (comments) and `{ } ~ | ^` can be typed.
- **Prompt detection:** the session is "at the prompt" when the CPU is in
  `IO_READ_KEY.wait_hit` called from `EDITOR_LOOP_LIVE.keyloop` (return
  address or stack depth; **check** which is reliable), as opposed to a word
  waiting in `KEY` / `INPUT` (also in the key wait, but deeper). Only at the
  prompt can text be sent.
- `prepare(text)`: CR line ends, printable ASCII only, fits the space left in
  the 8 KB line store (`$F000 - STORE_END`). **Check** the line length the
  ROM's `EDIT` / `LIST-DEFS` / `SAVE-TEXT` accept (the prompt's edit buffer
  is 128) and use that as the profile's `lineLimit`.
- `inject` (Send and Run): **append** the text to the line store at
  `STORE_END`, as typing a line does, move `STORE_END`, then call
  `INTERPRET_RUN` on the appended part with HL / DE and a return into the
  shell after the call (`$3727`), so the ROM prints `OK` and goes back to its
  prompt. Appending keeps `EDIT`, `LIST-DEFS`, `SAVE-TEXT` and Import session
  consistent with what typing would have produced. **Check** how the ROM
  appends a typed line (separator, `OK` echo) and do the same. If the store
  is full, say so (Forth's own message if it has one).
- Remember, per Send, the editor lines it came from (start offset in the
  store -> editor line), to map error positions back.
- Reset: TSRun reset and boot to the prompt.
- Import session: read `$D000` to `STORE_END` back as text.
- **Errors:** install watches (the debugger's `setWatch` mechanism) on
  `INTERPRET_UNKNOWN_WORD` (`$0203`: read the token from `WORD_BUF`) and
  `RUNTIME_ERROR_HOOK` (`$0247`: read `THROW_CODE` before it is cleared).
  These watches stay installed for the whole session, so errors from lines
  typed at the prompt are reported too. The position is `SRC_PTR` within the
  line store: inside text sent from the editor it maps to an editor line and
  column (the token that failed, or the top-level word that called the
  failing one); otherwise it is "typed at the prompt".
- Status bar: `OK`, `UNDEFINED WORD foo on line L`, `DIVISION BY ZERO
  (THROW -10) on line L`, `Stopped (BREAK)`, `Forth is running`, `Waiting for
  a key`. **Check** which THROW code BREAK gives (-28 in ANS).
- Stop: BREAK while busy; at the prompt there is nothing to stop.
- Node checks: send definitions then a call printing a result; send twice
  (words accumulate); an undefined word with its editor line; a THROW
  (division by zero) with its line; BREAK in an endless `BEGIN AGAIN`;
  Send refused while busy; a line typed at the prompt through the keyboard
  matrix; Import session returns what was sent and typed; Reset empties the
  dictionary.

### F2 — The Forth editor

- **Tokenizer** (`StreamLanguage`): words separated by whitespace; `\` to end
  of line and `( … )` comments; strings after `."` and the other string words
  (**check** the list: `."`, `S"`?, `STRING`); numbers (integers, floats —
  **check** the float syntax in `docs/numeric_model.md`); `:` followed by the
  new word's name; defining words (`VARIABLE`, `CONSTANT`, `CREATE`, `ARRAY`,
  `STRING`, …) followed by a name. ROM words highlighted by group (stack,
  arithmetic, control, I/O, graphics); EXROM words marked as such; the
  program's own words in another colour.
- Case-insensitive matching (the ROM folds a-z). **No auto-caps** (owner,
  2026-10-31: whatever is easier). Leaving it off is: the BASIC auto-caps
  would need Forth-specific rules (words like `."` and `+!`, the string after
  `."`, `( … )` comments), and the ROM accepts lower case anyway. Completion
  inserts ROM words in upper case, as the manual writes them.
- **Word data, generated:** `tools/gen-forth-words.py <checkout> <ref>` from
  the Forth manual updated for V2 (word, stack effect, kind, description,
  example, group; write the generator against the manual's final format,
  which is not settled yet). Cross-check against the `H_*` headers in the
  `.sym` (184 today) and report words missing from either side. Hover help
  shows the stack effect prominently; Help links to the manual section at the
  release tag. Only if the V2 manual is not ready: fall back to the tutorial's
  Appendix A tables (stack effect and notes only).
- Structure tools: fold `:` … `;`; indent `IF` / `ELSE` / `THEN`, `DO` /
  `LOOP` / `+LOOP`, `BEGIN` / `UNTIL` / `WHILE` / `REPEAT` / `AGAIN`; block
  match on those. Symbols: colon definitions, variables, constants, arrays,
  strings. Go to definition and rename for the program's own words (a Forth
  name can contain almost any character, so rename's checks differ).
- Completion: ROM words with their stack effect as detail, the program's
  words, snippets for `: name ;`, `IF THEN`, `DO LOOP`, `BEGIN UNTIL`.

### F3 — Error checking (static)

The hidden-machine trick does not transfer cleanly: checking a Forth program
means running it (top-level code executes, may loop forever or draw). So the
first version is a **static checker** in JavaScript, with the ROM's own
wording:

- a word that is neither a ROM word, nor defined *earlier* in the text, nor
  already defined in the live session (the user words in the dictionary,
  header ≥ `$9100`, read after each Send and whenever the prompt is reached;
  order matters in Forth: this catches use-before-definition);
- unbalanced control structures inside a definition; control words outside
  one; `;` without `:`; a `:` without `;` at the end;
- unclosed `(` comments and strings; a defining word without a name;
- EXROM-only words are fine (the IDE always has the EXROM).

Later, optional: a hidden-machine check that interprets the text with a cycle
budget and reports the first error, for definitions-only programs.

### F4 — Debugger

The generic panel (registers, memory, Z80 breakpoints) works as is. The Forth
sections:

- **Data stack** (IX up to `$9100`), **float stack** (IY up to `$8900`,
  `decodeFloat` from `leap-debug.js` reused), **return stack** (SP up to
  `$FF00`), each value annotated: return addresses named by the word whose
  code contains them (headers sorted by address).
- **Dictionary:** the program's words (header ≥ `$9100`) with their
  addresses, `HERE`, `LATEST`, `STATE`, and the values of variables and
  constants.
- **Breakpoints on words:** a breakpoint on a `:` line stops when the PC
  reaches that word's code (found by walking the dictionary after each Send;
  the newest definition of a name wins). It fires however the word is
  called, including from the prompt.
- **Line-level breakpoints and Step** inside definitions: a line table built
  by watching the compiler, the V2 trick again: while `STATE` = 1, record
  (`SRC_PTR` line, `HERE`) as each word is compiled. **Check** the hook point
  in `core/interp.asm`. Step = run to the next compiled word's CALL; Step into
  enters a user word. Words defined at the prompt have no editor lines; they
  get word-level breakpoints only.
- **Call stack** from the return stack, using the same naming.

### F5 — Tape export and Open

- `exportTape`: a TEXT tape (type 0, param1 `$8000`, param2 = length), as
  `tools/tape_gen_forth.py` writes; verify against the ROM's `SAVE-TEXT` in
  Node and that `LOAD-TEXT` reads it back. Status: `Saved X.tap: on the
  TS2068, LOAD-TEXT X`.
- Open `.tap`: recognise a Forth TEXT tape and read the text back; switch to
  Forth.
- Later, optional: a LIB tape (compiled dictionary, `SAVE-LIB` format, tied to
  `ROM_IDENTITY`) captured from the live session.
- No DCK (no cartridge build).

### F6 — Examples and corpus test

- Examples menu: from `demos/*.fs` and the tutorial.
- Corpus test in `tests/rom-checks.mjs`: `tests/**/*.fs` with `\ expect:`
  comments sent through the IDE's Send path in Node, each from a fresh
  session (the Forth project's `tools/forthtest.py` types them line by line;
  the IDE sends the whole file in one call, so **check** that each test means
  the same either way).

### F7 — Tools (optional)

- Draw tab: generate Forth (`x y PLOT`, `LINE`, …); **check** the word names,
  argument order and y direction.
- UDG tab: **check** whether the Forth ROM has user-defined characters; hide
  the tab if not.

## Tests

- `tests/rom-checks.mjs`: a Forth section for each of F1 to F6.
- `tests/browser-smoke.mjs`: switch to Forth, Run a definition and a call,
  Send one line, an undefined-word error on its line, type a word at the
  prompt and see its output, Import session, Reset, tape export, switch back.

## Owner decisions (2026-10-31)

- **Interaction model:** console first (option C), as described above.
- **Forth build:** the one TSRun will carry by the time this starts; give it
  a tag in `2068-forth` (F0).
- **Word data:** from the Forth manual updated for V2.
- **Auto-caps:** whatever is easier, so none.
- **Import session:** opens a new document.

## Still open

1. **Symbols in the Forth ROM** for the IDE's entry points (the return point
   after `call INTERPRET_RUN`), and optionally an error hook that keeps
   `THROW_CODE`, so the IDE needs fewer watches.
