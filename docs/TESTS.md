# Tests

> Moved verbatim out of `CLAUDE.md` to keep it under the 150k-character limit. `CLAUDE.md` still has the heading and a pointer.

## Tests

- `node tests/rom-checks.mjs` — 156 checks in about 30 s against the real ROMs in
  Node (TSRun's machine, no browser): ROM table lookup, Run by injection
  (through the profile's real `driver.inject`; finished, compile error,
  run-time error, package), section 1b "Language profile" (9 checks: profile
  lookup by id / file extension, `prepareSource`, and the attached profile's
  `lint`, `startRun`, `describeResult`, TAP and cartridge as `ide.js` uses
  them), the checker's error codes
  and lines, packages, the debugger's line table / breakpoints / variables /
  call stack, TAP export byte-identical to Leap's `SAVE`, the UDG and Draw
  helpers, every Examples-menu program (section 3b: each finishes with no
  error; `guess` stops at its `INPUT`), share links (round trip with the name,
  shorter than the program, a fragment without a program ignored, a damaged
  link refused), and (section 7, "Cartridge") the
  cartridge: the identity match, the checker's bytecode and `SYM_COUNTS`, a
  compile error giving no bytecode, the DCK layout, the flat BIN, a stock TS2068
  (`tsrun/roms/ts2068-0.rom`/`ts2068-1.rom`, `insertDock`) running the exported
  cartridge to the end (POKE marker 42, VM error 0, `$F4` = `$43`), a wrong
  identity being refused, `pagingWrites`, "the cartridge build takes packages
  (image format 2)" and "a SHAPES program (CIRCLE + FILL) runs from the
  cartridge" (stock TS2068, about 5145 pixels set, POKE marker, VM error 0).
  Section 8 (Leap-Forth): boot, Run, words accumulating across runs, an
  unknown word with its line and column, THROW in a word, a `KEY` wait, BREAK,
  the 12 non-interactive examples running to OK; F3: the check knows a word of
  the live session and marks an unknown one, forgets the session's words after
  a Reset, finds nothing in any Examples-menu program, and gives the error and
  warning cases (use before definition, unbalanced `IF`, compile-only word at
  the prompt, `;` without `:`, an unclosed string or `(` comment, `MISSING
  NAME`, `OUT OF RANGE`, a word made with `CREATE`); Import session (the line
  store as text, empty after a Reset); F5: the tape byte-identical to the ROM's
  `SAVE-TEXT`, Open reading it back, the ROM's `LOAD-TEXT` defining its words,
  Leap V2 and Forth tapes told apart; F4: the debugger adapter driven as
  `src/debugger.js` drives it (a breakpoint inside a word with its callers,
  Step word by word, the stacks and the session's words); F8: the editor's
  text built on a fresh hidden machine, the start word chosen, the DCK run on
  a stock TS2068, a wrong identity refused; F6: the manual's 313 `forth`
  blocks and the Examples menu's programs compared with their `\ expect:` /
  `\ expect-end:` output, driven with `\ keys:` and `\ break:` (all 313 pass on
  v2.0.1; on the 2.0 ROMs the one `2 STICK .` difference is expected and has its
  own check, which runs only when `FORTH_ROMS` points at them), and the gallery
  loading and showing its title screen. Section 9 (Leap-C): the checker's lines
  and columns, Run, compile and run-time errors, `getkey` and BREAK, a run
  started from the report; C6: a shapes program checks clean with the library
  loaded and not without it, `circle()` draws, the next run without the library
  unloads it (`LIB_LOADED` 0), a program defining its own `circle()` loads
  nothing, ⬇ TAP names `LIB "shapes"`; C7: the 17 Examples-menu programs without
  the tape one (two of them typed on the keyboard matrix) give the manual's exit
  status, screen text and pixels, and all 18 check clean; C5: the tape byte-identical to the ROM's `SH_SAVE`, Open
  reading it back, `SH_LOAD` restoring the line store and `PROG_END`, Leap-C and
  Leap V2 tapes told apart; C4: stops with the globals and the call stack,
  Step statement by statement into a called function, the globals of each type,
  and the lines of a run-time error and of BREAK; C9: the identity (read from
  `<cartridgeDir>/cartridge.json`, `$F6E9` for 1.2.0, and compared with
  `romIdentity` of the ROMs and the entry's `romIdentity`),
  the DCK layout (chunks 0, 1, 4, 5, 6; `"LCPG"` at DOCK `$8000`) and the flat
  image, a program run from the cartridge on a stock TS2068 to its report
  (`EXIT 7`, a line drawn), a shapes program with the library in region 3
  (`EXIT 12`), a compile error refused with its line, and `outp(244, …)`
  asking first. The library and tape checks print SKIP for a ROM with no
  library images (`libs/c/<version>/`) or no `LEAPC_TAPE_SYMBOLS` entry
  (beta.2), the C4 checks print SKIP for an entry without the C4 fields
  (beta.2), and the C9 checks print SKIP for an entry without `cartridgeDir`
  (beta.2). Section 10 (speed test): the three versions of "Spinning squares"
  run through their profiles' Run path, each ends with no error and its frame
  counter counts, and the bitmap (rows 8 to 183) and attributes are identical
  in BASIC, Leap-C and Forth.
  `LEAP_ROMS=<dir>` tests other BASIC ROM files; `FORTH_ROMS=<dir>` and
  `LEAPC_ROMS=<dir>` do the same for Forth and Leap-C (with `LEAPC_ROMS` on the
  beta.2 ROMs 128 of the first 150 checks ran: libraries, the debugger, tapes
  and the cartridge are skipped; not recounted since). All 156 pass on the
  default ROMs (Leap 2.1.1-emu.1, Forth 2.0.1, Leap-C 1.2.0); they also passed
  with `LEAP_ROMS` on the 2.1.1 ROMs before the pin moved and on the 2.1.0 ROMs
  after it (it was 157 while the `KNOWN` Forth difference had its check on every
  run). With `LEAP_ROMS` pointing at the 2.0.2 ROMs
  all 150 passed, before F6, the C7 keys and section 10. The
  expected values were recorded on 2.0.2-emu.1 and held for 2.1 unchanged; only
  the debugger's `vmNext` hook and the TAP check's carry-set stand-in needed
  changes.
- `node tests/browser-smoke.mjs [outdir]` — 64 checks in about 40 s, in headless
  Chrome: it serves the repo itself, boots the IDE and checks fingerprinted
  modules, Run results in the status bar, the error check, auto-caps, tabs,
  Draw zoom, theme and Help, find and replace (Ctrl+H, replace all), Undo (the
  button is disabled for a new program, then undoes the replace), the Cut and
  Paste buttons through the system clipboard (permission granted over CDP), the
  DCK export (a cartridge downloads; the file-name
  prompt and the download are captured in the page; a package program is
  exported with its package), the cartridge test (▶ Test DCK runs the program
  on the stock ROMs to its POKE marker, Stop goes back to Leap, Open of a
  `.dck` tests it and keeps the editor's program, Pause / Continue, Run goes
  back to Leap and runs), auto-indent, Tidy (nested blocks, labels, `IF` …
  `THEN GOTO`; Tidy leaves every example unchanged, the BASIC speed test included), block match, fold markers,
  F12, F2 rename and its refusals, line-limit marking, the Examples menu (opens
  one, closes) and running the SHAPES example, and a Z80 breakpoint pause, Step
  instruction and continue to Finished, and Share (copies a link; loading it in
  a fresh page opens the program, its file name, an empty hash and the status),
  an auto-save from before languages (the bare `leap-ide.document` key) opening
  and moving to `leap-ide.document.basic`, switching to Forth and to Leap-C
  (run, an error marked on its token, typing at the Forth prompt, Ctrl+Enter
  sending the cursor's line only, Stop of a `getkey` wait, switching back keeps each language's document; Forth: an undefined word marked and a session word known, Import, the TEXT tape, a breakpoint in a word pausing with the data stack and the callers shown (then Continue to OK), ▶ Test DCK running the program's cartridge with start word MAIN on a stock TS2068 and Stop going back to Forth; Leap-C: Run giving `Finished: exit 9`, ⬇ TAP, a shapes program with its library, the Examples menu (19 entries: the manual's 18 and the speed test), a breakpoint in a function pausing with the globals and call stack, a second toggle clearing it, Continue giving the exit status, ▶ Test DCK running the compiled program's cartridge on a stock TS2068 (a line drawn) and Stop going back to Leap-C), with no page errors. Keys typed at the Forth prompt are held 150 ms and released for 100 ms (`KEY_HOLD_MS`, `KEY_GAP_MS`, `66a16e9`): at 60 ms a headless page, which runs the emulator's frames unevenly, sometimes lost the first key. Three runs in a row were green after the change. It saves screenshots. CodeMirror's search
  panel takes the query on keyup / change, so CDP `Input.insertText` alone does
  not set it; the test also sends a keyUp.
- Run both before every commit that changes behaviour. `src/lang/basic/leap-lang.js`
  and `src/lang/basic/editor.js` import CodeMirror, so Node cannot load them;
  they are covered by the browser test. Their pure parts are in
  `src/lang/basic/leap-words.js` and `src/lang/basic/profile.js`, which Node
  tests import.
