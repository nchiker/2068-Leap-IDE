# Leap-C (`src/lang/c/`, stages C1 to C7 and C9)

> Moved verbatim out of `CLAUDE.md` to keep it under the 150k-character limit. `CLAUDE.md` still has the heading and a pointer.

### Leap-C (`src/lang/c/`, stages C1 to C7 and C9)

Leap-C **v1.2.0** (released 2026-11-02, tag `v1.2.0`, commit `e5cc932`): the
display code of Forth 2.0 ported (D25 to D29: `draw()` about 4 times faster;
print, scroll and the interrupt faster); pixels and glyphs are identical to
1.1.0's; the banner reads `2068 LEAP-C 1.2`. ROMs HOME `510023ba…`, EXROM
`14ee2434…`, the pair's key in `leapc-roms.js` is `5f0cc97f…`; TSRun `main`
`34b0794` carries them as `roms/leapc-0.rom` / `leapc-1.rom` (pushed by the
Leap-C project; in the current pin `c52f272`). Its answers to the IDE's notes
are `docs/requests/LEAP_C_1_2.md` and `LEAP_C_EXAMPLE_11_ANSWERS.md` (see
"Examples"; they answer `LEAP_C_EXAMPLE_11.md` and `LEAP_C_DRAW_SPEED.md`).
The move to 1.2.0 (2026-11-02, `4c02f48`) added the entry from
`tools/leapc-rom-entry.py` with `romIdentity: 0xF6E9` and
`cartridgeDir: 'cartridge/c/1.2.0/'`, `libs/c/1.2.0/`, the regenerated data
files and `LEAPC_TAPE_SYMBOLS['1.2.0']` (the same addresses as 1.0.0).
**v1.0.0** (released 2026-11-01, tag `v1.0.0`, commit `83e6e21`) stays in the
table (HOME `d2b18eaa…`, EXROM `02790ebe…`, key `c0f7f76f…`); **1.1.0** (tag
`v1.1.0`, commit `f8db836`, released 2026-11-02 UTC) added the runtime
cartridge and carries byte-identical ROMs to 1.0.0's, so it needed no ROM entry:
see "Cartridge (C9)". The `v1.0.0-beta.2` entry (HOME `043becf4…`, EXROM
`97fe9523…`) stays in the table, so `LEAPC_ROMS=<dir of the beta.2 ROMs>` still
tests it (the library and tape checks print SKIP there: no library images and
no `LEAPC_TAPE_SYMBOLS` entry for it, and the cartridge check, the C4 checks
too: 128 of the 150 checks run). Commits: C1 to C3 `d0e437b` (on beta.2),
1.0.0 `ac0d00f`, C5 `94700cf`, C6 `4f30b82`, C7 `1050d7b` (keys driven in
`5cfffb8`), C4 `0b419d3`, C9 `4798b64`.
Plan: [`docs/LEAP_C_PLAN.md`](docs/LEAP_C_PLAN.md).

- **Run is the shell path** the Leap-C project recommends. At a shell key wait
  (`RUNNING` = 0, so `canInject`), `inject` writes the V2-format line store
  (`encodeLineStore`, reused from BASIC), `PROG_END`, `ARRAYS_END` and
  `CUR_EDIT_INDEX`, then SP = `$FF00` less four, pushes `SH_LOOP` and `SH_RUN`,
  A = 7 and PC = `GFX_SET_BORDER`. The ROM compiles, runs and shows its own
  report; `RUNNING` <> 0 at the key wait means the program waits in `getkey` /
  `gets`.
- **Stop is BREAK**, held `breakHold` (5) frames and then released: the
  report waits for every key to be released, and BREAK ends every wait with
  run-time error 5, so no jump is needed.
- **Errors.** `driver.result` reads `CC_ERRNUM` / `CC_ERRLINE` / `SH_ERR_COL`,
  or `RT_ERRNUM` / `RT_ERRLINE` (the line where the failing function starts)
  and the exit status. The compile error's token is marked by columns. Status
  (since C4, `0b419d3`): `Finished: exit n` (`reportExit` reads the report's
  text "EXIT n" from `SH_REPORT_BUF`; a ROM entry without `reportBuf` says
  plain `Finished`), `Compile error N on line L`, `Runtime error N on line L` and
  `Stopped (BREAK) on line L`, where L is the failing **statement**: the
  adapter's `stopLine` looks `RT_ERRPC` (set by every `RT_ERROR`) up in the
  line table; without a line table (beta.2) it is the function's definition
  line as before, "in the function on line N".
- **Checker** (`leapc-check.js`): `SH_COMPILE` on a hidden machine (boot to
  the shell key wait, snapshot, restore, write the store, call). The column is
  computed as `SH_RUN` does for `SH_ERR_COL`: `TOK_PTR` less the line's text
  start, 0-based, at most the line's length.
- **Editor** (`editor.js`, `leapc-scan.js`): highlighting of the Leap-C subset
  (unsupported C89 such as `long`, `union`, `volatile` marked), completion
  with prototypes, hover help, brace folding, indent, Tidy, match, go to
  definition and rename of file-scope names (functions, globals, macros). No
  auto-caps. Keys: `src/lang/keytables.js` `LEAP_EXTENDED_SYMBOLS`, so
  `[ ] { } | ~ ^ \` can be typed.
- **Tape (C5, `94700cf`).** ⬇ TAP writes what Leap-C's `SAVE "name"` writes:
  V2's two blocks (`buildTAP` and `encodeLineStore` reused from BASIC) with the
  format word `$8C00` (`LEAPC_TAPE_WORD`; the ROM entry's `tapeFormatWord`).
  Open reads a Leap-C tape back and switches to Leap-C (`tapeToText(bytes,
  {accepts, language})` in `src/files.js` takes the accepted format word, V2's
  `$81xx` by default, so the languages refuse each other's tapes). Status:
  `Saved X.tap: on the TS2068, LOAD "X" then RUN` (with `LIB "shapes", then `
  first for a program that uses the library). Verified in Node against the 1.0.0
  ROM: `SH_SAVE` (the shell's `SAVE "demo"`, the block sender a stand-in; the
  tests' `LEAPC_TAPE_SYMBOLS` holds the addresses) sends exactly the IDE's tape,
  and `SH_LOAD` of the IDE's tape restores the line store and `PROG_END`.
  Outside the tests, all 44 program tapes of the 1.0.0 release open and
  re-export byte for byte.
- **Libraries (C6, `4f30b82`).** `libs/c/1.0.0/shapes.bin` (438 bytes, SHA-256
  `c4c145cd…`; README there) is the data block of the release's
  `libs/shapes.tap`, unchanged. `librariesUsed(text, functions)` in
  `leapc-scan.js` finds calls of a library function (`circle`, `box`, `isqrt`;
  the names and their libraries come from the generated keyword data, the
  manual's Part 6) that the program does not define itself. `attach()` fetches
  `libs/c/<version>/<name>.bin` (`fetchAsset`); for every check and Run the
  profile installs the library the program uses, as `LIB "name"` does (the image
  at `LX_BASE` `$F400`, `LIB_LOADED` set to `$F4`), or unloads it
  (`LIB_LOADED` 0), because a library stays loaded between runs by design and
  would otherwise change where the compiler places code (it occupies image
  region 3). One library at a time (a second is an error on its line). A
  release without images says the library is not available. Run's start message
  is `Compiling (with LIB "shapes")…`.
- **Examples (C7, `1050d7b`).** `tools/gen-leapc-examples.py ~/2068-Leap-C
  v1.2.0 > src/lang/c/examples.js`: the manual's 18 Part 7 programs, each with
  its test directives taken out of the text as data (`exit`, `screen`,
  `pixels`, `attr`, `keys`, `library`, `tape`). `// attr: ROW COL V` (since
  1.2.0) is a normal attribute byte, kept as `attrs` `[[row, col, v]]`; the C7
  check compares those bytes too (its snapshot at `RT_RUN.done` now includes
  the attributes). The shapes examples load the library by
  themselves (C6). `tests/rom-checks.mjs` runs 17 programs (the 14 without keys
  or a tape, and, since `5cfffb8`, those that read keys: `guess-the-number`
  with `"50" ENTER "25" ENTER "37" ENTER`, `a-menu` with `"12x23"` and the
  IDE's example 11 with `" "`) through the
  IDE's run path and compares the exit status (HL at `RT_RUN.done`), the screen
  text (the glyphs learnt from the ROM by printing ASCII 32 to 126) and the
  pixels, both as at `RT_RUN.done` (before the report on row 23): all match, and
  all 18 check clean. The keys are typed on the keyboard matrix through the
  IDE's own `src/pc-keyboard.js` (`createPcKeyboard`, with the profile's SYMBOL
  SHIFT table), one key each time the program waits in `getkey()` / `gets()`,
  which is what Leap-C's `tools/exectest.py` (v1.1.0) does through the ISR latch
  (`KBD_LASTK` / `KBD_KEYHIT`; `// keys:` is "text", ENTER, DELETE, NONE or a
  number). A key counts as taken when the ROM latches it (`KBD_KEYHIT` nonzero;
  leaving the key-wait spin loop is no sign, since every frame interrupt leaves
  it), and is then released for 3 frames. The helpers `keyEvent`, `parseCKeys`
  and `typeKey` are at the top of the test file. Only the tape example
  (`a-score-on-tape`) is not driven.
  - *"Colour lines in high resolution" (example 11), resolved in 1.2.0.* The
    1.0.0 manual's version ended on a black screen (a user report: `paper(0);
    cls();` paint the normal attributes black and the lines show only while
    `mode(1)` is on). The IDE replaced manual section 11 with its own
    (56 rows, each its own ink, `PRESS A KEY` and a `getkey()` in mode 1, no
    `paper(0)`, so the band stays visible after `mode(0)`; `// keys: " "` and
    four pixels), proposed in `docs/requests/LEAP_C_EXAMPLE_11.md`. The 1.2.0
    manual carries that replacement (plus `// attr: 5 5 56`), so
    `tools/leapc-example-overrides/` and its file are deleted. The
    override mechanism stays in `tools/gen-leapc-examples.py`
    (`apply_overrides`): any `tools/leapc-example-overrides/<N>-<id>.md`
    replaces manual section N and is named in the generated header; the
    directory has to be created again, and an override for a section the
    manual no longer has stops the generator. Example 11 is the third keyed
    program the C7 check drives (14 without keys or a tape).
- **ROM entry.** From the release's emulator pack (`leapc-1.2.0-emulators.zip`:
  `roms/`, `symbols/`, `SHA256SUMS`): flatten the images, the `.sym` files and
  their `SHA256SUMS` lines into one directory and run
  `tools/leapc-rom-entry.py <dir> 1.2.0 cartridge/c/1.2.0/` (it checks the images against the
  sums, and takes `SH_WAIT_KEY.key_ret` from the symbols; 1.0 has the label).
  The beta.2 entry was built from the tag in a detached worktree (the tag has
  no `.sym` and no `key_ret`, so the script derived it as
  `SH_WAIT_KEY.read + 3` after checking the CALL; that fallback is still in the
  script).
- **Generated data, never hand-edit.** `leapc-errors.js`:
  `tools/gen-leapc-errors.py ~/2068-Leap-C v1.2.0 >
  src/lang/c/leapc-errors.js` (from `include/leapc_errors.inc` at the tag).
  `leapc-keywords.js`: `tools/gen-leapc-keywords.py ~/2068-Leap-C v1.2.0 >
  src/lang/c/leapc-keywords.js` (from the manual at the tag; for a tag the
  script sets `LEAPC_MANUAL_REF` to the tag name, not the tag object's hash).
  `examples.js` as above. Regenerated at `v1.2.0`: the content is unchanged
  except the refs and example 11.
- **Debugger (C4, `leapc-debug.js`, `0b419d3`).** Leap-C compiles to native
  Z80 code, so the line table (`createLineTable(rom)`) is built by watching the
  compiler, at `STATEMENT`, `DCL_AUTOINIT` and `STMT_DO.cond` (record
  `TOK_LINE`, `CG_PC`), at `CG_UNIT.found` (the code moves on to the next
  image region at any instruction: record the last line, `DE`), and, when the
  program starts (`RT_RUN`), from the `RUN_FNLINES` records (each function's
  prologue and definition line). At one address the later record wins; the
  line of an address is the last record at or below it. All these points are
  in HOME.
  - *At `RT_RUN`* the compile workspace is still intact (the heap overwrites it
    once the program runs), so the globals (the `SYM_GLO` chain: name, type
    decoded from its handle or type node, static address) and the functions'
    names are copied then.
  - *Memory is read from `m.ram`* (TSRun's flat RAM array), not through the
    paging: `$C000-$DFFF` is the EXROM whenever the shell or an EXROM routine
    runs, with the program's static data (RUN_FNLINES, globals) under it. A
    position counts only when its 8K chunk is paged to RAM (`inRam`, port `$F4`).
  - *Breakpoints* stop at a line's statements; *Step* goes statement by
    statement, into called functions (a `for` loop's test and step are not
    statement starts); `labels` are "Globals" and "statement". *Variables*
    ("Globals") shows `int`, `unsigned`, `char`, `float`, pointers, arrays
    (strings as text, the first 8 elements of others) and structs (address
    only). *Call stack*: the `IX` frame chain (the caller's `IX` at `IX`, its
    return address at `IX+2`; at a function's prologue the return is still at
    SP). Stop while paused is BREAK.
  - *ROM entry.* `tools/leapc-rom-entry.py` emits `reportBuf`, `dclAutoinit`,
    `stmtDoCond`, `cgUnitFound`, `runFnlines`, `symGlo`, `rtRun` and `rtErrPc`;
    the 1.0.0 entry was regenerated. The beta.2 entry lacks them: the profile
    then returns a no-op adapter (registers, memory and Z80 breakpoints), the
    status says plain `Finished`, and the C4 tests print SKIP.
- **Cartridge (C9, `cartridge.js`, `4798b64`).** ⬇ DCK and ▶ Test DCK for a
  stock TS2068, on Leap-C's runtime cartridge build (first 1.1.0's, the
  release's `leapc-1.1.0-cartridge.zip`; description from the Leap-C project in
  `docs/requests/LEAP_C_CARTRIDGE.md`, read only; since 1.2.0 the entry uses
  `cartridge/c/1.2.0/`, built the same way for the 1.2.0 ROMs: HOME SHA-256
  `505d0f79…`, EXROM the release EXROM, `cartridge.json` release 1.2.0, identity
  `F6E9`). `cartridge/c/1.1.0/` holds
  `leapc_cart_home.bin` (16384 bytes, SHA-256 `034e294d…`),
  `leapc_exrom.bin` (8192 bytes, the release EXROM, equal to TSRun's
  `roms/leapc-1.rom`), `cartridge.json` (the identity it accepts) and a README.
  - *Identity.* CRC-16/CCITT-FALSE of HOME then EXROM (`romIdentity`). 1.0.0
    and 1.1.0 have byte-identical ROMs, so the IDE's 1.0.0 entry has
    `romIdentity: 0xE90E` and `cartridgeDir: 'cartridge/c/1.1.0/'` and the
    cartridge accepts what it compiles. The 1.2.0 ROMs changed: the 1.2.0 entry
    has `romIdentity: 0xF6E9` and `cartridgeDir: 'cartridge/c/1.2.0/'`. A release that changes the ROMs needs
    its own cartridge build (the cartridge shows `NO PROGRAM` for another
    identity); export refuses when the loaded ROMs' identity or EXROM differs
    from the cartridge's.
  - *`cartridge.js`* (pure; a port of the zip's `tools/cartpack.py` and
    `tools/c2cart.py`'s `region_blocks`): `crc16`, `romIdentity`,
    `regionBlocks`, `programImage`, `buildCartridge` (`{dck, bin}`),
    `isLeapcCartridge` and the constants `CHUNK`, `MAX_IMAGE`, `REGIONS`.
  - *Program image (format 1).* `"LCPG"`, format 1, identity, `RUN_MAIN`
    (word), `RUN_VOID` (byte), `IMG_LIM` (16 bytes: four regions x
    [low][high]), `LIB_LOADED`, then blocks `[length][address][bytes]`
    (1 to 8192 bytes, inside one region) and a length of 0, then the
    CRC-16/CCITT-FALSE of everything before it, **high byte first**. There is
    no `RUN_FNLINES` field. At most 24 KB (the regions hold about 19.9 KB).
  - *Layout.* DCK bank 0; chunks 0-1 the cartridge HOME, 4-5 the image (at
    DOCK `$8000`), then chunk 2 past 16 KB, 6 the EXROM; chunks 3 and 7 absent.
    A program under 16 KB gives 9 + 5 x 8192 bytes. The flat `.bin` is 64 KB,
    chunk n at n x 8192, `$FF` in absent chunks and unused tails. The EXROM is
    in chunk 6 because compiled programs reach it at run time (floats, `beep`,
    `sound`, tape), and chunk 6 is also the program's region 1 (RAM) except
    inside those trampolines.
  - *Reading the program: the checker's `compileImage(store, lineCount, lib)`*
    (`leapc-check.js`). It compiles as `check()` does, with the program's
    library, and on code 0 returns `runMain`, `runVoid`, `imgLim`, `libLoaded`
    and the `blocks`: per region the code `[base, low)` and the static data
    `[high, end)`; region 3 whole when a library is loaded; region 4 (hi-res,
    `#pragma hires`) up to its last non-zero byte. They are read from `m.ram`
    itself, since `$C000-$DFFF` is the EXROM again once `SH_COMPILE` returns
    (region 1's code is under it). The cells' addresses are ROM-entry fields:
    `runMain`, `runVoid` and `imgLim` (and `libLoaded`), emitted by
    `tools/leapc-rom-entry.py`.
  - *`buildCartridge(text, ui)`* of the attached C profile, in order: source
    problems or an empty program, no `cartridgeDir` / `runMain` in the ROM
    entry ("There is no cartridge build for Leap-C <version>"), the store too
    big, a library problem (one library at a time), the cartridge files
    (fetched once through `fetchAsset`), the identity and EXROM against the
    loaded ROMs, an `outp` to port 244 or 255 with a literal port (`ui.confirm`;
    it can switch the cartridge's ROMs out), the compile (a compile error
    reads "Compile error N on line L: fix it first" and marks the line), then
    `programImage` and the pack. It returns `{dck, bin, summary}` (`N bytes of
    program`, `and the shapes library` when there is one), `{error, line0?}` or
    `null`. `profile.hasCartridge` is true and `profile.ownsCartridge`
    (`isLeapcCartridge`: `"LCPG"` at DOCK `$8000`) lets ▶ Test DCK / Open
    `.dck` pick the keyboard table (`[ ] { }` and the like).
  - *`tools/leapc-rom-entry.py <dir> <version> [<cartridge dir>]`.* The
    optional third argument (e.g. `cartridge/c/1.2.0/`) adds `romIdentity` (the
    CRC-16 of the ROMs it was given) and `cartridgeDir` to the entry; `runMain`,
    `runVoid` and `imgLim` are always emitted.
  - *How the cartridge differs from RUN* (worth telling a user): its report is
    the one-row report (`EXIT n`, `RUNTIME ERROR n MESSAGE`, `BREAK`) with **no
    line number** (there is no source on the cartridge); the UDGs are blank at
    every start; a key after the report restarts the program from a cold start
    (the image is copied afresh); `malloc`'s addresses differ (the heap starts
    lower) and `PEEK($0000-$0007)` reads the LROS header. Reports and final
    screens were identical for the 115 programs the Leap-C project compared.
  - *Verified.* The IDE's cartridge for the release demo (`examples/cart_hello.c`
    at `v1.1.0`, and again at `v1.2.0`) is byte-identical to the zip's
    `demo/hello.dck` and `hello.bin` (checked outside the tests). `tests/rom-checks.mjs` section 9
    runs the exported cartridges on a stock TS2068 in TSRun (Leap-C itself had
    only qualified it on Fuse 1.9.1 and ZEsarUX 13.0): a program to its report
    (`EXIT 7`, a line drawn) and a shapes program with the library in region 3
    (`EXIT 12`, a circle drawn); also the identity `$E90E`, the DCK layout, a
    compile error refused with its line and `outp(244, …)` asking first. The
    browser test runs ▶ Test DCK and Stop. Not tried: real hardware.
- **Not yet.** Locals in the debugger (a second version: `IX` + the symbol's
  value for `SF_AUTO` entries, with each block's code range from
  `SCOPE_OPEN` / `SCOPE_CLOSE`); driving the tape example (`a-score-on-tape`)
  in the tests; running the C examples from cartridges against the manual (as
  V2's 695-program comparison); C8 (UDG and Draw tools) is optional and not
  started.
- **Moving to a later release** (done for 1.2.0 on 2026-11-02: the library
  image `libs/c/1.2.0/shapes.bin` is the data block of the pack's
  `libs/shapes.tap`, byte-identical to 1.0.0's since the library ABI did not
  change; `LEAPC_TAPE_SYMBOLS['1.2.0']` has 1.0.0's addresses). Take the
  release's emulator pack, run
  `tools/leapc-rom-entry.py`, move the TSRun pin if the ROMs changed,
  regenerate the three data files at the tag, copy the library images to
  `libs/c/<version>/` (check them against the release's `SHA256SUMS`), add
  `LEAPC_TAPE_SYMBOLS` for it in the tests, and run
  `LEAPC_ROMS=<dir> node tests/rom-checks.mjs` and the browser test.

### Adding a Leap-C release

As above, plus the cartridge: a release whose ROMs changed needs its own
cartridge build. Copy the release's `leapc-<version>-cartridge.zip` files
(`roms/leapc_cart_home.bin`, `roms/leapc_exrom.bin`) to `cartridge/c/<release>/`
with a `cartridge.json` (`{"identity": "<hex>"}`, the identity the cartridge
accepts, published with the release) and a README with the SHA-256s, check them
against the zip's `SHA256SUMS`, and regenerate the entry with the third
argument, `tools/leapc-rom-entry.py <dir> <version> cartridge/c/<release>/`
(`romIdentity` and `cartridgeDir`). A release with byte-identical ROMs (1.0.0
and 1.1.0) keeps its entry and only the cartridge directory is new; check that
`romIdentity(ROM HOME, EXROM)` equals the cartridge's identity. Without
`cartridgeDir` export says there is no cartridge build for that version. The
C9 checks in `tests/rom-checks.mjs` section 9 then run against the new build.

---
