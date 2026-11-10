# Leap-Forth (`src/lang/forth/`, stages F0 to F6 and F8, plus Import session)

> Moved verbatim out of `CLAUDE.md` to keep it under the 150k-character limit. `CLAUDE.md` still has the heading and a pointer.

### Leap-Forth (`src/lang/forth/`, stages F0 to F6 and F8, plus Import session)

Commits: F0 to F2 `b9526ce` (Send after it), F3 `a3869d4`, Import session
`89a6d48`, F5 `6103f66`, F4 `054198d`, F8 `f7a5d1d`, F6 `50fb417` (the browser
test's key timing `66a16e9`).

2068-Forth **v2.0.1** (tag `v2.0.1`, merge commit `0dabe74`, released
2026-11-02; the `STICK` fix: AY port A is made an input, the joystick is
selected, fire is read on both sticks). HOME changed (`f0cd0785…`), EXROM did
not (`fd877dd0…`); the pair's key in `forth-roms.js` is `e57d88cd…` and
`ROM_IDENTITY` is `$F001` (2.0: `$FDBE`). TSRun carries it as
`roms/leapforth-0.rom` / `leapforth-1.rom` (since TSRun `main` `02e5325`,
pushed by the Forth project; in the current pin `c52f272`). The **v2.0** entry
(tag `v2.0`, commit `50170f2`; HOME `730c86d0…`, EXROM `fd877dd0…`, key
`04c3e54d…`; carried by TSRun since the pin `11731e1`) stays in the table, so
`FORTH_ROMS=<dir of the 2.0 ROMs>` tests it. The 2.0.1 move (2026-11-02,
`4c02f48`): the entry from `tools/forth-rom-entry.py` on the release zip;
`forth-words.js` (the `STICK` and `MIXER` text changed), `examples.js` and
`tests/forth-manual-examples.json` regenerated at `v2.0.1` (the same 313
manual blocks, lines shifted); `cartridge/forth/2.0.1/`. The release is the
answer to `docs/requests/LEAP_FORTH_STICK.md`; no answer file
(`LEAP_FORTH_STICK_ANSWERS.md`) has arrived.
Plan: [`docs/LEAP_FORTH_PLAN.md`](docs/LEAP_FORTH_PLAN.md).

- **Console-first model (owner).** The OK prompt is live all the time:
  `keyboard.always` is true, so keys reach the machine whenever the screen has
  focus, as on the real TS2068. Run does not reset: it sends the editor's text
  to the running session as if typed, so definitions accumulate; Reset gives
  a fresh Forth.
- **Send (Ctrl+Enter / Cmd+Enter).** Sends the cursor's line, or the whole
  lines of the selection, to the live prompt, for any profile with
  `keyboard.always` (Forth). `src/editor.js` has `getSendText()` and
  `onSend(fn)` (a `Prec.highest` `Mod-Enter` keymap that falls through to
  CodeMirror when `ide.js` does not take it); `sendSelection()` in `ide.js`
  maps an error in the sent lines back to their editor lines. It is in the
  Forth Help tips.
- **Run, line by line.** `prepareSource` drops blank lines, turns tabs into two
  spaces and refuses lines over 128 characters or non-ASCII. `driver.inject`
  writes line 1 into `EDIT_BUF` / `EDIT_LEN` / `EDIT_CURSOR`, drops the key
  wait's return address (SP + 2) and sets PC = `EDITOR_LOOP_LIVE.enter`; the
  ROM runs the line, prints OK or the error and waits again.
  "At the prompt" is the key wait with `EDITOR_LOOP_LIVE.key_ret` at SP (any
  other return address is a word waiting in `KEY` / `ACCEPT` / `INPUT` /
  `EDIT`); `canInject` is that test, so a Run while a word waits in `KEY`
  presses BREAK first. `driver.next` sends the next line and stops at the first
  line whose `LAST_ERROR` is not 0 (a deviation from "send everything": Run
  stops at the first error line). The failing token is marked from `SRC_PTR`
  (just past the token and one delimiter, `tokenBefore`); a `SRC_PTR` outside
  `EDIT_BUF` means the error came from text `LOAD-TEXT` or `EDIT` ran, so no
  token is marked. Status: `OK`, `<message> on line L` (`describeThrow`: ANS
  numbering, -13 unknown word names the word from `WORD_BUF`), `Stopped
  (BREAK) on line L` (-28). Stop is BREAK (-28), held `breakHold` (5) frames;
  it ends `KEY` / `ACCEPT` / `INPUT` waits too, so `stopWaiting` is false.
- **Editor** (`editor.js`, `forth-scan.js`): highlighting by the interpreter's
  reading (`\` comments, `( … )`, `."` and `S"` end with their line, the name
  after `:` and the defining words, numbers by the ROM's grammar;
  `lineTokens(line, ctx)` carries the interpreter's state from line to line
  through `scanContext()`: inside `: … ;` or `[ … ]` a defining word reads no
  name, and a word whose definition uses `CREATE` and the like defines the name
  that follows it), completion
  with stack effects, hover help, folding `:` … `;`, indent, Tidy, block
  match, go to definition and rename of the program's words. No auto-caps
  (owner). Help: 184 words in the groups of the manual's Part 3 and 4, links
  to the manual at `FORTH_MANUAL_REF`.
- **Generated data, never hand-edit.** `forth-words.js`:
  `tools/gen-forth-words.py ~/2068-forth v2.0 > src/lang/forth/forth-words.js`
  (184 words; the plan's cross-check of the names against the `H_*` headers in
  the `.sym` files is not done, but the count matches). `examples.js`:
  `tools/gen-forth-examples.py ~/2068-forth v2.0 > src/lang/forth/examples.js`
  (17 programs: the manual's 15 Part 7 programs, `demos/blackjack.fs` and, since
  F6, `demos/gallery.fs` as `gallery`, `input: true`; the file's header says it
  is the old demo ROM's source, not rebuilt for the finished ROM; each program's
  `keys` is `[line, text]`, the 0-based line of the text the keys are typed for
  and the keys, where it was a bare list before). `tests/forth-manual-examples.json`:
  `tools/gen-forth-doc-tests.py ~/2068-forth v2.0 > tests/forth-manual-examples.json`
  (a port of 2068-Forth's `tools/docexamples.py`: every ```forth block of the
  manual with its `\ expect:` / `\ expect-end:` / `\ keys:` / `\ break:` / `\ draws`
  directives, 313 at v2.0, commit `50170f2`, identical to 2068-Forth's
  `tests/doc/manual_*.fs`, checked).
- **Static check (F3, `forth-check.js`, advisory).** A Forth program cannot be
  compiled on a hidden machine (running it is the only way to read it), so
  `checkForth(text, sessionWords)` reads the text as the interpreter would,
  line by line as Run sends it, in the ROM's terms: `UNDEFINED WORD: X …` (a
  word that is neither a ROM word, nor defined earlier, nor in the live
  session), a compile-only word outside a definition, `;` without `:`, a `:`
  open at the end of the text, unbalanced `IF` / `ELSE` / `THEN`, `DO` /
  `LOOP` / `+LOOP`, `BEGIN` / `WHILE` / `REPEAT` / `UNTIL`, `LEAVE` outside a
  `DO`, a `."` or `S"` string not closed on its line (error), a `( … )`
  comment not closed on its line (**warning**: the rest of the line is the
  comment, but it does not continue), `MISSING NAME` and `OUT OF RANGE`
  (`numberInRange`: integers -32768 to 65535, floats to about 1.7E38).
  `lint` returns the storage problems of `prepareSource` and then these. Run
  does **not** refuse a program the check flags: the check is advice, the ROM's
  answer is what Run shows. **The session's words** are read from the live
  dictionary by `readSessionWords` (LATEST down to `FORTH_DICT_RAM`, headers
  `LINK(2) LENFLAGS(1) NAME`, the name's length in bits 0 to 4) in
  `attach().keyWait(m)`, which runs at the key wait when the machine is at the
  prompt (the EXROM is paged out there, so the whole dictionary is visible)
  and reads again only when LATEST changed. `sessionStamp()` returns LATEST;
  `ide.js` polls it with the debugger refresh interval (`DEBUG_REFRESH_MS`) and
  calls `leapEditor.relint()` when it changes, so a word typed at the prompt,
  or a Reset, changes the editor's marks. Diagnostics carry `severity`
  (`toDiagnostics` in `ide.js` passes it on; the Lint button reports the first
  error, not a warning).
- **Import session (`89a6d48`).** The "Import" button in the emulator panel
  header (`#btn-import-session`, shown when `profile.hasSession`) calls
  `attach().importSession(m)`: it reads the ROM's line store, `STORE_START` to
  `STORE_END` (every line typed or sent at the prompt; command lines such as
  `SAVE-TEXT` are not in it), CR-ended, as text, and `ide.js` opens it as a new
  unsaved document `session.fs` after the usual "discard changes?". An empty
  session, or a `STORE_END` outside the store, gives a message instead.
- **Tape (F5, `tape.js`, `6103f66`).** ⬇ TAP writes what `SAVE-TEXT` writes:
  header block (type 0, the name upper-cased and space-padded to 10, the text
  length, parameter 1 `FORTH_TEXT_WORD` `$8000`, parameter 2 the length) and a
  data block of the line store (every line ended by CR, no empty lines).
  `buildForthTap`, `forthTapeToText`, `isForthTape` (so Open on a `.tap` finds
  the language: Leap V2 tapes carry `$81xx`, Leap-C `$8C00`, Forth `$8000`),
  `textStore` and `LOAD_TEXT_MAX` (8 KB, `LOAD-TEXT`'s room). The tape name is
  upper-cased and has no spaces (`LOAD-TEXT` reads a word). Status: `Saved
  X.tap: on the TS2068, LOAD-TEXT X`. Verified in Node: the IDE's tape is
  byte-identical to the ROM's own `SAVE-TEXT` after the same lines were sent
  (the block sender replaced by a stand-in; `FORTH_TAPE_SYMBOLS` in the tests
  has `STORAGE_SEND_BLOCK` `$09CE` and `STORAGE_RECEIVE_BLOCK` `$0A5D` for 2.0,
  `$09D9` and `$0A68` for 2.0.1),
  and the ROM's `LOAD-TEXT` reads it back and defines the words.
- **ROM entry.** `tools/forth-rom-entry.py <unpacked release zip> 2.0.1`: it
  checks `SHA256SUMS` and the key-wait bytes and takes every address from
  `symbols/forth_boot.sym`. The entries were built from the unpacked v2.0 and
  v2.0.1 zips.
- **Debugger (F4, `forth-debug.js`, `054198d`).** Forth compiles as it reads,
  so the line table is built **while the program is sent**, by watching the
  interpreter (`createLineTable(rom)`): each line enters at
  `EDITOR_LOOP_LIVE.enter` (the n-th entry of a run is job line n); at
  `INTERPRET_NESTED.token` with `STATE` 1 a record `{addr: HERE, line, word}` is
  added (a `STATE` 0 token only remembers the line, for the `:`); a definition's
  code starts at `COLON_XT`, which gets a record on the line of the `:` when
  its first body token arrives; text that `LOAD-TEXT` or `EDIT` runs
  (`SRC_PTR` outside `EDIT_BUF`) is ignored. Records are instruction starts
  only, never inline data (after `CALL DOLIT` / `DOFLIT` / `QBRANCH` /
  `BRANCH`, `."` and `S"`), so stopping at one is always safe. The table
  grows during the run, so it has a `version()` and the controller places
  the breakpoints again when it changes.
  - *Positions* (the controller's "statement" addresses): a record's address
    while the code runs, or `TOP` (`0x10000`) + n when job line n is sent. A
    breakpoint on a line outside a definition (`promptLines`) therefore stops
    when the line is sent; one in a word stops where each stretch of that
    line's code starts (not at every token). Step goes token by token, into
    the program's words, and also stops at each line sent.
  - *Variables*, titled **"Stacks and words"** (`labels.variables`): the data
    stack (IX, top first, up to 16 cells, signed and hex), the float stack
    (IY), then the session's words with their values (`readWords` walks
    LATEST down to `FORTH_DICT_RAM`; the kind comes from the word's code:
    `CALL DOLIT` gives a `VARIABLE` / `FVARIABLE` / `CONSTANT` / data area,
    `CALL DOFLIT` an `FCONSTANT`, `CALL DODOES` a `CREATE`d word, anything else
    a `:` word). The adapter is `live`: the table also shows between runs.
  - *Call stack* (`readCallStack`): the word the PC is in, the user words whose
    `CALL`s are on the return stack (an entry counts only when a `CALL`
    precedes it and it lies in a user word, since `DO` loops and `CATCH` frames
    share the stack), then "the line sent". Stop while paused is BREAK
    (`halt` false).
  - *Limits.* The records are reset by every Run **and every Send**
    (`debug.beginRun(job)`), so breakpoints and Step apply only to the words
    the latest Run / Send defined; a word defined earlier, or typed at the
    prompt, has no lines (it still shows in the words table and the call
    stack). `tools/forth-rom-entry.py` emits the new fields `doLit`, `doFLit`,
    `doDoes`, `qBranch`, `branch` and `stkGuard`; the 2.0 entry was
    regenerated from the release zip.
- **Cartridge (F8, `cartridge.js`, `f7a5d1d`).** ⬇ DCK and ▶ Test DCK for a
  stock TS2068. `cartridge.js` is a port of 2068-Forth's `tools/forthcart.py`:
  `programImage` (`"F1"`, `ROM_IDENTITY`, n = `HERE` - `$9100` at most 16,128,
  `LATEST`, the start word's length and name, the 168 UDG bytes, the
  dictionary, CRC-16/CCITT-FALSE), `buildForthCartridge` (the DCK: bank 0, the
  cartridge HOME in chunks 0-1, the image from chunk 2, the EXROM in chunk 5;
  and the flat 64 KB `.bin`), `cartImages`, `homeIdentity`, `crc16` and
  `isForthCartridge`. `cartridge/forth/2.0/forth_cart.dck` is the release's,
  unchanged (24585 bytes, SHA-256 `4f07fd88…`; identity `$FDBE`; README there);
  `cartridge/forth/2.0.1/forth_cart.dck` is v2.0.1's, also the release's
  (SHA-256 `1f673221…`; identity `$F001`; README there).
  - *Owner's choices (2026-11-01), as built.* The editor's text is interpreted
    on a **fresh hidden machine** (`interpretFresh` in `profile.js`: a new
    machine with the loaded ROMs, line by line as Run sends it, at most about a
    minute of TS2068 time in all, 600 frames to boot and 3000 for the text); a
    line that errors (marked on its editor line), waits for a key (`KEY`,
    `ACCEPT`, `INPUT` at the top level) or runs too long is refused. Then
    `HERE` / `LATEST`, the dictionary (read from `m.ram`, since the EXROM hides
    part of it), the UDGs and the words are packed. **The start word is chosen
    at export** with `ui.prompt`, listing the program's `:` words, the newest
    as the default; it is checked against the dictionary.
  - *Checks before export.* The identity of the loaded ROMs against the
    cartridge's (`homeIdentity`), an `OUT` to port 244 or 255 with a literal
    port asks first, a program with no `:` word, a dictionary over 16,128
    bytes. The status gives the dictionary size and the start word.
  - *Test DCK / Open `.dck`.* `profile.ownsCartridge` recognises the image
    (`"F1"` at DOCK `$4000`), and `ide.js` passes that profile's keyboard table
    to `emulator.testCartridge(dck, symbols)`, so `[ ] { }` and the like can be
    typed in a Forth cartridge opened while BASIC is active; leaving the test
    puts the active profile's table back.
  - *Verified.* In Node, on a stock TS2068 the cartridge loads, runs the start
    word (a variable set to 42), keeps the UDGs and leaves the OK prompt; the
    IDE's DCK and BIN for the Blackjack demo are byte-identical to
    `forthcart.py`'s for the same dictionary (checked outside the tests). Not
    tried: real hardware, ZEsarUX / Fuse.
- **Manual examples (F6, `50fb417`).** `tests/rom-checks.mjs` section 8 reads
  what each line prints as 2068-Forth's `tools/forthtest.py` (v2.0) does: the
  screen rows from the print row (`PRINT_ROW`) before the line to the one after
  it, with scrolling and CLS allowed for, trailing blanks dropped, joined with
  `|`, the final OK dropped. It is compared with `\ expect:` (a line without
  one must print nothing), `\ expect-end:` (ends with), and `\ draws` is not
  read. The glyphs are learnt by calling the ROM's `GFX_PUTCHAR` for codes 32 to
  143, as `fharness` does (an unknown cell is `░`, a UDG U+E000+i, inverse `•`
  plus the character). Each case starts from a snapshot of a just-booted Forth,
  and its lines go in one at a time through the IDE's Send path (`startRun` +
  `driver.inject`), which is `fharness`'s `host_line`, the path 2068-Forth made
  for the IDE. `\ keys:` (Python escapes: `\r` ENTER, `\b` DELETE, `\xNN`;
  `\x01` to `\x04` the cursor keys, `\x10` BREAK, which is Escape on a PC) are
  typed on the matrix while the line waits; `\ break: after N` holds BREAK after
  N instructions until the prompt's key wait. `\ break: at SYMBOL` is not
  supported (the manual uses only `after N`).
  - *Results.* On v2.0.1 all 313 manual blocks pass. On v2.0 one differed,
    `2 STICK .` (1 in TSRun, 0 in the manual): `STICK_READ` read AY port A
    without making it an input, and Forth leaves the mixer (register 7) at
    `$F8` (port A an output), so TSRun returned the output latch, as an
    AY-3-8912 does, while ZEsarUX returned the joystick lines. That was
    reported (`docs/requests/LEAP_FORTH_STICK.md`) and fixed in v2.0.1. The
    `KNOWN` list is gone; the difference is expected only when the 2.0 ROMs are
    tested (`FORTH_ROMS`), and its own check runs only then, which is why the
    ROM suite has 156 checks, not 157. The Examples menu's 15 Part 7 programs
    run with their own `expect` and `keys` data (3 read keys): all pass. The
    gallery loads (every line OK and silent) and `MAIN` shows the title
    screen ("SHOOTING GALLERY" on row 3), which is a check.
  - *Per-release data.* `FORTH_SCREEN_SYMBOLS` in the tests: `PRINT_ROW`
    `$81CF`, `GFX_PUTCHAR` `$0705` for 2.0 (taken from
    `~/2068-forth/build/forth_boot.sym`, whose HOME ROM is byte-identical to
    v2.0's, SHA-256 `730c86d0…`) and `$0710` for 2.0.1. A new Forth release
    needs its entry, here and in `FORTH_TAPE_SYMBOLS`.
- **Not yet.** F7 (UDG and Draw tools) is optional and not started; the
  optional LIB tape (`SAVE-LIB` format) and the optional watches of F1 are not
  built.
- **Adding a Forth release.** Unpack its zip; move the TSRun pin to a commit
  carrying its ROMs (the pair in `tsrun/roms/` must match `forth-roms.js`);
  run `tools/forth-rom-entry.py <unpacked zip> <version>` and paste the entry;
  regenerate `forth-words.js` and `examples.js` at the tag; run
  `FORTH_ROMS=<dir> node tests/rom-checks.mjs` (like `LEAP_ROMS`) and the
  browser test. Also add its `FORTH_TAPE_SYMBOLS` and `FORTH_SCREEN_SYMBOLS`
  entries in the tests (done for 2.0.1: `$09D9` / `$0A68` and `$81CF` / `$0710`).
