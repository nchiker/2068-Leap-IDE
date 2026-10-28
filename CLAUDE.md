# Leap V2 Web IDE — CLAUDE.md

This is the authoritative technical brief for the Leap V2 Web IDE.
Read this file completely before writing any code. Then read
**`docs/HANDOFF.md`** (where the work stands, the owner's decisions, known
traps) and `docs/overview.md` for the design rationale. The mock-up is at `docs/mockup.html` (a visual
target only: its sample code and keyword list predate the language reference
below and are partly wrong).

Authorities, in order: the Leap manual (`~/2068-Leap/docs/manual/`) and
`~/2068-Leap/docs/V2_LANGUAGE_REFERENCE.md` for the language; the ROM source and
`.sym` files for addresses; the TSRun source for emulator APIs. Anything in this
file marked "unverified" has not been checked against those — check it before
building on it.

---

## What We Are Building

A **browser-based IDE** for writing and running programs in **Leap V2 BASIC**
on the **Timex Sinclair 2068**. The IDE runs entirely in the browser — no
build step, no npm; it only needs a static file server (ES modules cannot load
from `file://`). Plain HTML + JS + the TSRun emulator.

- **Editor panel** — CodeMirror 6, Leap V2 syntax highlighting, keyword
  autocomplete, built-in help (hover tooltips and the F1 overlay), ROM-compiler
  error checking, breakpoint gutter, New / Open / Save with browser auto-save.
  Programs may use the Leap packages (`CIRCLE`, `GRAB`, …); the IDE loads them.
- **Emulator panel** — TSRun's TS2068 running the Leap V2 ROMs, 256×192 canvas.
- **Debugger panel** — Z80 registers, Leap variables, breakpoints, call stack.
  It shares the right panel with the Symbols, UDG and Draw tabs (Phase 7).

Leap is **V2**; the current release is **2.1.0-emu.1** (tag `v2.1.0-emu.1`,
commit `c005159` of nchiker/2068-Leap, published 2026-10-28). The ROM table
also still knows 2.0.2-emu.1, which is useful with `LEAP_ROMS=<dir>`. V1 is
archived and irrelevant. ROM addresses change between releases; everything else
in the IDE should stay the same (see "Adding a Leap ROM release").

---

## Source Files in This Repo

```
Leap-IDE/
├── index.html        ← Forwards to ide.html (GitHub Pages entry)
├── .nojekyll         ← Makes GitHub Pages serve files as-is
├── ide.html          ← Shell (three-panel layout, CM6 import map)
├── ide.css           ← Shell layout and theme
├── ide.js            ← Orchestrator: boot emulator, prepare source, run/stop, status
├── src/
│   ├── emulator.js   ← Slim TSRun host + RAM-injection run/stop (Phase 1, done)
│   ├── leap-roms.js  ← Known ROM builds: SHA-256 -> addresses (Phase 1, done)
│   ├── pc-keyboard.js ← PC key -> TS2068 matrix translation (Phase 4, done)
│   ├── editor.js     ← CodeMirror 6 setup, gutter, autocomplete, help tooltip (Phase 2, done)
│   ├── files.js      ← Browser auto-save, text normalising, .tap -> source (no DOM; Node can import it)
│   ├── help.js       ← Help overlay: searchable keywords + Keys & tips (F1, "? Help")
│   ├── leap-lang.js  ← Language mode, token classes, scanSymbols (Phase 2, done)
│   ├── leap-keywords.js ← GENERATED keyword data from the manual; never hand-edit
│   ├── leap-check.js ← Editor error check: the ROM's own compiler on a hidden machine (Phase 5, done)
│   ├── leap-errors.js ← GENERATED compile/run-time error text from the manual; never hand-edit
│   ├── debugger.js   ← Debugger controller (breakpoints, step) + panel (Phase 3, done)
│   ├── leap-debug.js ← Line table, VM position, variables, call stack from machine RAM (Phase 3, done)
│   ├── tools/        ← Right-panel tools (Phase 7, done)
│   │   ├── symbols.js ← Symbols tab: procedures, functions, labels, variables; click jumps to the line
│   │   ├── udg.js     ← UDG tab: draw the 21 user-defined characters, insert / load POKEs
│   │   └── draw.js    ← Draw tab: graphics scratchpad generating PLOT / LINE
│   ├── export.js     ← TAP builder (Phase 6, done, verified)
│   └── cartridge.js  ← DCK / flat .bin cartridge builder (Phase 6, done, verified; no DOM, Node can import it)
├── cartridge-build/  ← Source of the cartridge images: leap.patch + setup.sh, CLI tools, tests, status (see its README)
├── cartridge/
│   └── 2.1.0-emu.1/  ← Leap's cartridge build: leap_v2_cart_home.bin (16 KB), leap_v2_cart_exrom.bin (8 KB), README
├── packages/
│   ├── 2.0.2-emu.1/  ← Package images of that release (<name>.bin; same six as 2.1.0-emu.1)
│   └── 2.1.0-emu.1/  ← The current release's package images: cbeep graphics mode printer shapes sprite (<name>.bin)
├── tools/
│   ├── leap-rom-entry.py  ← Prints a leap-roms.js entry for a 2068-Leap build
│   ├── gen-leap-keywords.py ← Generates src/leap-keywords.js from the Leap manual
│   └── gen-leap-errors.py   ← Generates src/leap-errors.js from manual Appendix B
├── tests/
│   ├── rom-checks.mjs    ← Node: run path, checker, packages, debugger, TAP vs Leap's SAVE, cartridge on a stock TS2068 (real ROMs)
│   └── browser-smoke.mjs ← Headless Chrome: the whole IDE end to end
├── docs/
│   ├── HANDOFF.md    ← Session handoff: status, owner decisions, traps
│   ├── overview.md   ← Design doc
│   ├── LEAP_CARTRIDGE_BUILD.md ← Spec: Leap runtime cartridge build for 2.1 (what DCK export needed; now built)
│   └── mockup.html   ← Visual mock-up
└── tsrun/            ← git submodule: TSRun fork, pinned at 016787f
```

**ROMs are not in this repo.** They load from `tsrun/roms/leap-0.rom` (16K
HOME) and `tsrun/roms/leap-1.rom` (8K EXROM). These are the 2.1.0-emu.1 release
images (SHA-256 `8c3d6c81…` and `e46e2065…` respectively; the pair's key in
`src/leap-roms.js` is `5a42872e…`). A `make build` of the tag is byte-identical
to the release zip's ROMs. The 2.0.2-emu.1 pair (`1fe5798f…`, `e6b507a4…`) is
also in the table.

**TSRun** is the fork https://github.com/nchiker/TSRun (upstream
josef-jelinek/TSRun), included as the git submodule `tsrun/` pinned at commit
`016787f` (TSRun `main` with the 2.1.0-emu.1 Leap ROMs, on top of the
`sound.js` worklet fix `f65de5a` and the tape-loading fix `4db1f1e`, both
pushed; `016787f` itself changes only the two ROMs and the READMEs). There is no
`../josef-jelinek/` path and no `~/TSRun` clone is needed. Do not copy TSRun
into the repo. The fork carries two changes on its `main`: `sound.js` loads its
worklet with `new URL("sound.worklet.js", import.meta.url)` instead of a
page-relative path, so audio works from a page outside TSRun's directory; and
the tape-loading fix (TSRun issue #3, josef-jelinek/TSRun, opened by the
owner), which keeps the tape playing for ROM-style loaders outside EXROM chunk
0 (tape loading used to stop mid-load, so Leap's `LOAD` failed in TSRun).
Verified: stock-ROM tape autoload and autostart are unchanged, and Leap
`LOAD ""` of the IDE's `.tap` loads (the tape even starts by itself) and `RUN`
works. The live TSRun site, which also hosts Leap's browser demo, loads Leap
tapes, including package tapes.

**Pinning matters:** the TSRun version must match the ROM table in
`src/leap-roms.js`, so a TSRun update cannot break the IDE until the submodule
is deliberately moved: `git -C tsrun fetch && git -C tsrun checkout <commit>`,
add the ROM entry (`tools/leap-rom-entry.py`), regenerate keywords if the manual
changed, then commit the submodule bump.

**Publishing:** the repo is public at https://github.com/nchiker/2068-Leap-IDE
(branch `main`). GitHub Pages serves it at
https://nchiker.github.io/2068-Leap-IDE/, built from `main` (root) on every
push, and includes the public submodule.

**Setup:** `git clone --recurse-submodules https://github.com/nchiker/2068-Leap-IDE.git`
(or `git submodule update --init` in an existing clone). For local development
serve with `python3 -m http.server 8080` from the project root and open
http://localhost:8080/ide.html.

---

## Leap V2 BASIC — Language Quick Reference

Leap V2 is a **structured BASIC**: the program is kept as source text and
compiled to bytecode by the ROM on every `RUN`. Full detail: the language
reference and manual. Keywords, names and statements are case-insensitive.

| Feature            | Leap V2                                                         |
|--------------------|-----------------------------------------------------------------|
| Line numbers       | **None.** Lines are edited in the ROM's full-screen editor      |
| Statements         | One or more per line separated by `:`; line max **127** chars   |
| Labels             | `name:` on its own line; the only jump targets; duplicate = error 57 |
| Comments           | `REM` to end of line (`'` is **not** a comment)                 |
| Assignment         | `x = 1`, `x$ = "a"`, `a(i) = 1` — **no `LET`** (compile error 2)|
| Control flow       | `IF cond THEN` … [`ELSE` …] `ENDIF` (always a block); only one-line form is `IF cond THEN GOTO label`; no `ELSEIF` |
| Loops              | `FOR v = a TO b [STEP s]` … `NEXT [v]`; `EXIT FOR`              |
| Jumps              | `GOTO label` only. **No `GOSUB`/`RETURN`** (compile error 2) — use `PROC`/`CALL` |
| Procedures         | `PROC name(p):` … `ENDP`, `CALL name(expr)`; one by-value parameter; recursion works (~739 levels) |
| User functions     | `DEF FN f(x) = expr`, used as `FN f(expr)`; numeric, one parameter |
| Identifiers        | Letter then letters/digits, **max 31**, **no underscore**; a keyword or built-in name cannot be a variable/label/PROC name (a name that merely begins with one can) |
| Numbers            | 16-bit integers or 5-byte floats (~9 digits, up to ~1.7E38); no exponent or hex literals |
| Strings            | 0..**31** characters (literal longer = compile error 70); `+` concatenates; no `a$(i TO j)` slicing (use `MID$`) |
| Arrays             | `DIM a(n)`, `DIM a$(n)`, `DIM a$(n,w)`; `n` a literal; one dimension; numeric elements are integers only |
| Functions          | Always written with brackets, even with no argument: `PI()`, `INKEY$()`, `FREE()` |
| Relations/logic    | `= <> < > <= >=`, `NOT`, `AND`, `OR` (logical 0/1, short-circuit); `MOD`/`DIV` are **functions**; no power operator |
| Graphics           | 256×192, **y from the top**: `PLOT x,y`, `LINE x0,y0 TO x1,y1` (absolute; no `DRAW`) |
| UDGs               | 21 characters, codes **144–164**, 8 bytes each at `$F180`–`$F227`; defined with `POKE`; print with `CHR$(144)`… |
| Sound              | `BEEP seconds,semitones`, `SOUND register,value`                |
| Output             | `PRINT item {; or , item}`; `AT row,col` and `TAB col` are **statements**, not `PRINT` items |
| Input              | `INPUT var`, `INPUT "prompt"; var` — plain variable only        |

### Keyword inventory (for highlighting, autocomplete and help)

A human-readable summary, checked against the language reference sections 5, 6,
7, 11 and manual Appendix H. The authoritative data is the generated
`src/leap-keywords.js` (see "Keyword data" below); this table must agree with
it.

| Class                       | Words |
|-----------------------------|-------|
| Structure                   | `REM` `END` `STOP` `GOTO` `IF` `THEN` `ELSE` `ENDIF` `FOR` `TO` `STEP` `NEXT` `EXIT` (`EXIT FOR`) `PROC` `ENDP` `CALL` `DEF` `FN` `CLEAR` |
| Declarations                | `DIM` |
| Screen/text statements      | `PRINT` `AT` `TAB` `CLS` `INK` `PAPER` `BRIGHT` `FLASH` `INVERSE` `OVER` `BORDER` |
| Graphics statements         | `PLOT` `LINE` |
| Sound statements            | `BEEP` `SOUND` |
| Input/machine statements    | `INPUT` `PAUSE` `POKE` `OUT` `RANDOMISE` |
| Operators (words)           | `AND` `OR` `NOT` |
| Numeric functions           | `ABS` `SGN` `INT` `MOD` `DIV` `SQR` `SIN` `COS` `TAN` `PI` `RAD` `DEG` `RND` |
| String functions            | `LEN` `CODE` `VAL` `CHR$` `STR$` `UPPER$` `LOWER$` `LEFT$` `RIGHT$` `MID$` |
| Machine/input functions     | `INKEY$` `PEEK` `USR` `IN` `STICK` `POINT` `ATTR` `FREE` `DIMN` |
| Package statements (loaded with `LOAD "NAME" EXT`) | mode: `MODE` `ULAPLUS` `PALETTE`; sprite: `GRAB` `SHOW` `MOVE` `HIDE`; printer: `LPRINT` `LLIST`; shapes: `CIRCLE` `FILL`; graphics: `CPLOT` `BLOCK` `FRAME` `INVERT`; cbeep: `CBEEP` |
| Commands (typed in the ROM editor, **not valid in programs**) | `RUN` `LIST` `NEW` `SAVE` `LOAD` `VERIFY` (with `ALL`, `ARRAY`, `EXT`) |

Not in V2 (compile error or simply absent): `LET`, `GOSUB`/`RETURN`,
`DRAW`, `COPY`, `DATA`/`READ`/`RESTORE`, `ELSEIF`, `INSTR`, `PRINT AT` /
colour items inside `PRINT`, multi-dimensional arrays, `DIM` with a variable
size, exponent/hex literals, `CIRCLE`/`FILL` without the SHAPES package. The
characters `[ \ ] ^ ` { | } ~` printed as blanks in 2.0.2 (no glyphs); 2.1 gives
every printable ASCII character a glyph (Q-26), so they print now. Leap still
has no key for them (see Keyboard).

### Compile and run-time errors

The ROM reports numeric codes; the IDE reads them from RAM (see "How Run
Works"). Full tables: manual Appendix B, which `src/leap-errors.js` is generated
from (see "Editor Error Checking"). Codes the editor and status bar meet
most often:

| Code | Cause |
|------|-------|
| 2    | Unknown word, identifier not followed by `=` (includes `LET`, `GOSUB`, a package statement whose package is not loaded) |
| 3    | Expression could not start |
| 7    | `GOTO` to an undefined label |
| 8, 9 | `IF` without `THEN`; `IF` block without `ELSE`/`ENDIF` |
| 16, 65 | `PROC` without `ENDP`; `FOR` without `NEXT` |
| 56, 57 | `NEXT` for the wrong variable; duplicate label/`PROC`/`DEF FN` |
| 60, 61 | Nesting too deep; name too long (> 31) |
| 64   | Unexpected token (also a literal beyond the number range) |
| 70   | String literal longer than 31 characters |
| run-time 66 | BREAK |

Limits (manual Appendix D): name 31 chars, string 31, line 127, 251 number
names, 251 string names, 255 array names, ~440 labels, nested `IF` 211 / `FOR`
141 / brackets 105, recursion 739, compiled code 4011 bytes, program text
about 8.9 KB.

---

## Memory Map — Critical Addresses (2.0.2-emu.1 and 2.1.0-emu.1)

The data layout below is the same in both releases (checked in 2.1: the main
pool, `V2_SOURCE_END`, the VM and compiler tables, the UDG table and the package
window did not move). Routine addresses did move (for example `V2_COMPILE_STORED`
is `$D54F` in 2.0.2 and `$D45A` in 2.1, `IO_READ_KEY.wait_hit` is `$0443` in
2.1); the per-release values live in `src/leap-roms.js`. Full table: manual
Appendix E.

| Range / symbol            | Address            | Notes |
|---------------------------|--------------------|-------|
| Free for user machine code | `$5B00`–`$5FFF`, `$7800`–`$7FFF` | Not used by V2 |
| Leap system variables     | `$8000`–`$8259`    | Do not touch |
| `PROG_END` sysvar         | `$8002`            | Byte after the end of the stored program. **Not** `$5C53` — that is Sinclair's |
| `PROG_AREA_START`         | `$825A`            | Start of the main pool |
| Main pool                 | `$825A`–`$A654`    | 9211 bytes: program text, variables, names, arrays. `V2_SOURCE_END` = `$A655` |
| Compiled bytecode         | `$A655`–`$B5FF`    | 4011 bytes, rebuilt on every run |
| Fixed tables / compiler workspace | `$B600`–`$BFFF` | Includes `RT_SYMTAB_PTR` (`$B80D`), `VM_ERROR_CODE`, `COMPILE_ERROR_CODE` |
| RAM under EXROM           | `$C000`–`$DFFF`    | Hidden while a program runs |
| Overflow segment          | `$E000`–`$E7FF`    | Arrays that did not fit, Array Store |
| UDG table                 | `$F180`–`$F227`    | 21 chars, codes 144–164, 8 bytes each (**not** `$FF58`) |
| Package window            | `$F400`–`$F7FF`    | Loaded package lives here |
| Machine stack             | grows down from `$FF00` | |

Sinclair addresses such as `$5C3A` (IY) and `$5C3D` (ERR_SP) do not apply to
Leap's own state. The Z80 `IY` is still saved/restored by `USR`.

---

## TSRun Integration

TSRun files are **ES modules** (`import`/`export`), imported by
`src/emulator.js` from the `tsrun` submodule. They are not classic `<script>`
tags. TSRun's own `host.js` is tied to its desk UI, so the IDE has its own slim
host in `src/emulator.js`. There is **no** `machine.run()` / `.stop()` /
`.step()` / `.poke()` API.

| File          | What the IDE uses |
|---------------|-------------------|
| `machine.js`  | `createMachine`, `setHomeRom`, `setExRom`, `insertDock` (tests only: a stock TS2068 with a dock cartridge), `resetMachine`, `runFrame`, `setVideoOn`, `enableSound`, `setSoundRate`, `takeAudio`, `cpuHz`, `tStatesPerFrame`. Memory: `machine.bus.read(addr)` / `machine.bus.write(addr, v)`. |
| `z80.js`      | `runZ80(cpu, budget)` — a budget of 1 runs one instruction. CPU state is `machine.cpu` (`pc`, `sp`, `a`, `f`, `b`, `c`, …, `iff1`, `im`). |
| `screen.js`   | `initScreen`, `resizeScreen`, `setCrt`, `drawScreen` (WebGL2) |
| `keyboard.js` | **Not used** by the IDE; `src/pc-keyboard.js` replaces it (see Keyboard). The IDE writes `machine.keyMatrix` itself. |
| `sound.js`    | `initSound`, `resumeSound`, `pushSound`, … (AudioWorklet, needs the fork's `import.meta.url` fix) |
| `dock.js`     | `parseDck` only (reads a dock; accepts banks 0 DOCK, 254 EXROM, 255 HOME; not used by the IDE, the tests load the exported DCK with `insertDock` in `machine.js`) |
| `tape.js`, `load.js` | Tape loading. The tape-loading fix below (TSRun issue #3) is needed for Leap's own `LOAD` to read the IDE's `.tap` in TSRun. |

`ide.html` loads no TSRun script tags. ROMs are fetched by `src/emulator.js`
from `tsrun/roms/`, hashed (HOME + EXROM, SHA-256) and looked up in
`src/leap-roms.js`; **an unknown ROM pair is refused**.

---

## How Run Works (RAM Injection) — implemented and verified

1. **Source to line store.** `prepareSource` (ide.js) splits the editor text,
   drops blank lines (the ROM editor never stores an empty line) and keeps a
   map back to editor line numbers; `encodeLineStore` (emulator.js) encodes it.
   The ROM's line store, at `PROG_AREA_START`, is, per line: LE16 (text length
   + 1), the text verbatim (no tokenising, no line numbers), then `$0D`. It is
   **not** one ASCII blob with `\r` terminators. Refuse non-printable-ASCII,
   lines over 127 characters, and a store larger than the pool.
2. **Wait for a safe point.** The CPU must be in the ROM's key-wait spin loop
   `IO_READ_KEY.wait_hit` (`$0435`–`$043A`) with the EXROM paged in (port `$F4`
   bit 6, port `$FF` bit 7). The editor idles there, as do `INPUT`, `PAUSE 0`
   and the "press a key" after a run. It is found by single-stepping the frame
   (`runZ80` with budget 1), then `runFrame` finishes the frame.
3. **If the program is busy,** press BREAK (CAPS SHIFT+SPACE in the matrix) for
   up to 60 frames. If that does not reach the key wait, reset and boot (about
   66 frames to the editor). After BREAK, clear the ROM's key latch
   `KBD_KEYHIT`, else the latched BREAK dismisses the BREAK message.
4. **Inject and jump.** Write the store and `PROG_END`; push a return chain on
   the ROM stack (`SP=$FEFC`: `V2_RESET_EDIT`, `V2_RUN_STORED`, then
   `V2_COMMAND_LOOP.loop` at `$FF00`) and jump to `V2_CLEAR_ARRAYS`. If the
   program uses a package, the jump goes to `EXT2_CLEAR_ALL` instead, with the
   package installed first (see "Packages").
   `CLEAR_ARRAYS` + `RESET_EDIT` are what `LOAD` does after replacing a
   program; `V2_RUN_STORED` is what typing `RUN` calls (it compiles, clears
   the screen, runs, then waits for a key). No code is written outside the
   stack. This mirrors the Leap test harness (`tools/v2_prod.py` /
   `v2_headless.py` in 2068-Leap).
5. **Result.** Back at the key wait with `SP=$FF00` means the run ended;
   `INPUT`/`PAUSE` wait deeper. `COMPILE_ERROR_CODE` and `VM_ERROR_CODE` give
   the error (VM 66 = BREAK). After a compile error `CUR_EDIT_INDEX` holds the
   failing line index, which the IDE maps back to the editor line and marks.
   The status bar shows Finished / Compile error N on line L / Runtime error N
   at line L / Stopped (BREAK) at line N, and the marked line carries the
   manual's message (`describeError` in ide.js, text from `src/leap-errors.js`).
   Leap reports no line for a run-time error; the IDE finds it through the
   debugger's line table (`stopLine` in `src/debugger.js`): `VM_IP` is left
   just past the failing instruction, so `VM_IP - 1` is looked up; after BREAK
   `VM_IP` is the next instruction, so it is looked up as is. While a program waits at `INPUT`/`PAUSE 0` it reads
   "Waiting for input — click the screen to type".
   When a run ends its output stays on screen: nothing dismisses it into
   Leap's editor (see Keyboard). The Run button injects at that "press a key"
   wait as before.

**Stop:** BREAK if busy; if the program is waiting at `INPUT`/`PAUSE 0`, jump
straight back to the ROM's command loop (`V2_COMMAND_LOOP.loop`). Observed
(Node, both releases): BREAK alone does not end an `INPUT` wait in 2.0.2, nor in
2.1.0-emu.1, whose VM latches error 66 and, per its source, stops only after
ENTER. The jump is therefore still needed and behaves the same on both.

`window.leapIDE` exposes `lintSource`, `encodeSource`, `setStatus` and
`emulator` (the object from `createEmulator`: `run`/`stop`/
`reset`, `rom`, `machine`), which is useful for tests and the debugger.

Verified in headless Chromium: hello world, compile error with line, BREAK
stop, `INPUT` stop, re-run while busy.

### Adding a Leap ROM release

1. Build the release tag in a separate detached worktree, not in the working
   clone (`~/2068-Leap` may have local edits on another branch):
   `git -C ~/2068-Leap worktree add --detach <dir> <tag>`, then `make build`
   in `<dir>`. Compare the ROMs with the release zip's.
2. `tools/leap-rom-entry.py <checkout> <version>` prints a `KNOWN_ROMS` entry
   (the script also checks that the key-wait spin loop still has the expected
   bytes). Its `SYMBOLS` table includes the debugger's compiler, VM and run-time
   table symbols, so each entry must be regenerated this way, not copied from
   another release. A symbol a release lacks is looked up under its
   `FALLBACK` name (2.0.2 has no `VM_RUN.next`, so `vmNext` takes
   `VM_RUN.loop`).
   It also emits the package fields `ext2ClearAll`, `packageBase`, `packageLen`
   and `packageDir` (see "Packages"), plus `symCounts` and, if the release has a
   cartridge build, a `cartridgeDir` line (step 5).
3. Paste the entry into `src/leap-roms.js` and put the new
   `leap-0.rom`/`leap-1.rom` in `tsrun/roms/` by moving the submodule to a TSRun
   commit that carries them. Copy the release's package binaries
   (`v2_package_<name>.bin`) unchanged to `packages/<version>/<name>.bin` and
   check them against the release's `SHA256SUMS`.
4. Run `LEAP_ROMS=<dir with the new leap-0.rom/leap-1.rom> node tests/rom-checks.mjs`
   (and again without `LEAP_ROMS` after moving the submodule), then
   `node tests/browser-smoke.mjs`. They cover hello world, compile and run-time
   errors, the checker, packages, the debugger and TAP export. Add the
   release's `SAVE_SYMBOLS` to `tests/rom-checks.mjs` from its `.sym` files.
   The TAP check replaces the block sender with a stand-in; since 2.1 it must
   return with carry set ("sent whole"), because 2.1's `SAVE` stops after a
   header block that reports an abort ("SAVE abort" fix). A later release may
   change such a contract again.
   BREAK and `INPUT` stop are still checked by hand in the IDE.
   Update the memory-map table above if the layout moved.
5. Cartridge build (DCK export): build the release's cartridge version
   (`make cart`, `-DV2_CARTRIDGE`): rebase `cartridge-build/leap.patch` onto the
   new tag and update `TAG` in `cartridge-build/setup.sh`, run it, copy `leap_v2_cart_home.bin` and `leap_v2_cart_exrom.bin`
   to `cartridge/<version>/` with a README, and keep the `cartridgeDir` line in
   the ROM entry. Check that `cartIdentity(cartridge HOME)` equals
   `romIdentity(release ROMs)`; export refuses a mismatch. If the release has
   no cartridge build, leave `cartridgeDir` out and export says there is none.
   The cartridge checks in `tests/rom-checks.mjs` (section 7) then need the new
   identity and the release's `symCounts` address.

---

## Keyboard (Phase 4 — done, `src/pc-keyboard.js`)

**Owner decision:** the finished IDE never allows typing in Leap's own ROM
editor; all program editing happens in CodeMirror. Keys reach the TS2068 only
while an injected program is running (`INPUT`, `INKEY$`, `PAUSE 0`) and the
emulator screen (`#ts-bezel`) has focus. When a run ends (finished, error,
BREAK) its output stays on screen, since no keypress can dismiss it into the
Leap editor.

Keys are mapped as a PC keyboard is labelled. `src/pc-keyboard.js` takes the
character the PC key produces (`e.key`) and translates it to the TS2068 combo
that makes Leap's decoder (2068-Leap `kernel/io/io.asm`: `IO_DECODE_KEY`,
`KEY_ASCII_TABLE`, `KEY_ASCII_TABLE_UPPER`, `KEY_ASCII_TABLE_SYMBOL`, as of
2.0.2) produce the same character. Examples: a PC `"` sends SYMBOL SHIFT+P,
Shift+8 `(` sends SYMBOL SHIFT+8 without CAPS SHIFT, and `A` sends CAPS
SHIFT+A (Leap gives lowercase for plain letters).

- Mapped symbols: `: ? / < > ! @ # $ % _ ) ( ' & " ; = + - . , *`
- Named keys: Enter; Backspace/Delete -> CAPS SHIFT+0; arrows -> CAPS SHIFT
  5/6/7/8 (`INPUT` line editing); Escape -> BREAK (CAPS SHIFT+SPACE)
- Not mapped: characters Leap has no key for (`` ^ [ ] { } \ | ~ ` ``), Ctrl/Alt/
  Meta combos, and Tab (TSRun maps Tab to CAPS SHIFT+1, which Leap decodes as
  delete-line)

TSRun's `keyboard.js` is no longer used by the IDE and is not patched. The
seven `hostBits` lines proposed in earlier drafts were checked and
**rejected; do not apply them.** `hostBits` is keyed by physical `e.code` and
applied unconditionally, so `hostBits.Digit8 = [ss, key8]` would make the 8 key
always type `(` and would make 8, 9, 4, R, T, Z and P untypable everywhere.

`kernel/io` (the key tables) is identical in v2.0.2-emu.1 and v2.1.0-emu.1, so
`src/pc-keyboard.js` needed no change for 2.1. If a later release changes the
key tables, `SYMBOLS` in `src/pc-keyboard.js` must follow. The characters
`` ^ [ ] { } \ | ~ `` now print in 2.1 but have no Leap key, so they stay
unmapped.

Verified: typing `Hi(1)<2>;=+-*/,.:?!@#$%&'_"Z` into an `INPUT` returned
exactly that string (`LEN` 28). The on-screen TSRun keyboard (`#ts-keyboard`)
was removed from `ide.html`.

---

## Display and zoom (`ide.js`, "Display zoom")

TSRun draws a 320×240 frame (256×192 screen plus border). It is always scaled by
a **whole number of device pixels**: a fractional scale gave some pixel columns
1 and others 2 display pixels, which made text uneven and thin. A zoom control
"− 2× +" in the TS2068 Display panel header picks 1×, 2× or 3×. The emulator
panel widens to fit, the editor takes the remaining width and the debugger is
340 px (it shrinks to 240). The zoom drops automatically when the window is too
narrow; the default is 2× when the window is at least 1500 px wide; the choice
is remembered in `localStorage` (`leap-ide.zoom`). HiDPI and fractional
`devicePixelRatio` are handled. The CRT filter is off (the emulator API has
`setCrt(on)`, there is no UI for it). Leap's own font has 1-pixel strokes, so
1× looks light by nature.

---

## CodeMirror 6 Integration

CM6 ships as ESM modules; load them with an `importmap` from jsDelivr (no
bundler). The map in `ide.html` is authoritative; it currently is:

```html
<script type="importmap">
{
  "imports": {
    "@codemirror/state":        "https://cdn.jsdelivr.net/npm/@codemirror/state@6.4.1/dist/index.js",
    "@codemirror/view":         "https://cdn.jsdelivr.net/npm/@codemirror/view@6.34.3/dist/index.js",
    "@codemirror/language":     "https://cdn.jsdelivr.net/npm/@codemirror/language@6.10.3/dist/index.js",
    "@codemirror/commands":     "https://cdn.jsdelivr.net/npm/@codemirror/commands@6.7.1/dist/index.js",
    "@codemirror/autocomplete": "https://cdn.jsdelivr.net/npm/@codemirror/autocomplete@6.18.3/dist/index.js",
    "@codemirror/lint":         "https://cdn.jsdelivr.net/npm/@codemirror/lint@6.8.2/dist/index.js",
    "@lezer/highlight":         "https://cdn.jsdelivr.net/npm/@lezer/highlight@1.2.1/dist/index.js",
    "@lezer/common":            "https://cdn.jsdelivr.net/npm/@lezer/common@1.2.3/dist/index.js",
    "@lezer/lr":                "https://cdn.jsdelivr.net/npm/@lezer/lr@1.4.2/dist/index.js",
    "style-mod":                "https://cdn.jsdelivr.net/npm/style-mod@4.1.2/src/style-mod.js",
    "w3c-keyname":              "https://cdn.jsdelivr.net/npm/w3c-keyname@2.2.8/index.js",
    "crelt":                    "https://cdn.jsdelivr.net/npm/crelt@1.0.6/index.js"
  }
}
</script>
<script type="module" src="src/editor.js"></script>
```

Notes: `style-mod`'s entry is `src/style-mod.js` (not `dist/`); `@lezer/lr` is
required by `@codemirror/language`; `@codemirror/lint` is needed for the
the Phase 5 diagnostics.

### Keyword data (generated)

`src/leap-keywords.js` is **generated; never hand-edit it**:

```
tools/gen-leap-keywords.py <2068-Leap checkout> <git ref> > src/leap-keywords.js
```

It reads `docs/manual/03_keywords.md` at that ref (currently `v2.1.0-emu.1`) and
emits `LEAP_KEYWORD_ENTRIES`: 100 entries, each `{kind, package, syntax, forms[],
desc, example}`. `kind` is function / statement / operator / command / part of;
`package` is `null` or the package name; `desc` is the first paragraph (at most
420 characters); `example` is the first basic example (at most 6 lines). The
100 entries are unchanged in content between 2.0.2 and 2.1. For the next
release, rerun it at its tag.

### Language mode and editor (Phase 2 — done)

**`src/leap-lang.js`** implements the language mode with `@codemirror/language`
`StreamLanguage` (simpler than a Lezer grammar here). It exports `leapLanguage`,
`leapHighlight`, `LEAP_WORDS` (Map word -> `{cls, entry}`), `NOT_IN_V2`,
`keywordEntry(word)` (`DEF` -> `DEF FN`, `EXIT` -> `EXIT FOR`),
`keywordTokens(lineText)` (`[{from, to, text}]` keyword tokens on one line,
same lexer; used by auto-caps) and
`scanSymbols(text)` (PROCs, DEF FNs, labels and variables with line numbers;
`vars` is a `Map` name -> first line; used by the Phase 7 Symbols tab).
`LEAP_KEYWORDS` and `LEAP_HELP` no
longer exist.

Identifiers are a letter then letters/digits with an optional trailing `$`; no
underscore. Matching is whole-word (`tomato` is not `TO`). Token classes:

| Token | Colour / style |
|-------|----------------|
| Statements and their parts | amber, bold |
| Word operators `AND` `OR` `NOT` | amber |
| Package statements (`CIRCLE` etc.) | orange, bold |
| Built-in functions | cyan |
| Strings | green |
| Numbers (no hex, no exponent) | blue |
| `REM` text | grey italic; `REM` runs to end of line including `:`; `'` is not a comment |
| Label definitions (`name:` at line start) and label references after `GOTO` | coral italic |
| `PROC` names after `PROC` (definition) and after `CALL` / `FN` | lavender |
| Variables | light grey |
| Invalid | red, wavy underline |

Invalid covers the commands (`RUN` `LIST` `NEW` `SAVE` `LOAD` `VERIFY` `ALL`
`ARRAY` `EXT`) anywhere, and the `NOT_IN_V2` words (`LET` `GOSUB` `RETURN`
`DRAW` `DATA` `READ` `RESTORE` `COPY` `ELSEIF` `CONTINUE` `RANDOMIZE`) only at the start of a statement when not followed by `=` or `(`: V2 does
not reserve them, so `data = 5` is a valid assignment. The toggle-comment token
is `REM `.

**`src/editor.js`** creates the `EditorView`, the breakpoint gutter,
autocomplete and hover help, and exposes `window.leapEditor` (`getSource()`,
`setSource(text, {fresh})`, `setDiagnostics()`, `onChange(fn)`, `focus()`;
`fresh: true` starts a new document with its own undo history and the
breakpoints cleared, used by New and Open).

- **Autocomplete:** all manual keywords except commands, with the first form as
  the detail and the full help as the info panel; built-in functions insert
  `NAME(`; snippets for `IF` … `ENDIF`, `IF` … `ELSE` … `ENDIF`, `FOR` … `NEXT`,
  `PROC name(p):` … `ENDP` and `DEF FN`; the program's variables. Context: after
  `CALL` only `PROC` names (detail `PROC (param) · line N`), after `GOTO` only
  labels, after `FN` only `DEF FN` names.
- **Hover help:** a keyword shows every form, its kind (package statements say
  the IDE loads the package on Run, and `LOAD "NAME" EXT` on a real TS2068),
  the description and the example. Commands say they
  are typed at the Leap prompt; `NOT_IN_V2` words say "X is not in Leap V2
  (language reference §12)"; `PROC` / `DEF FN` / label names show their
  definition line. Built with DOM nodes and `textContent` (no `innerHTML`).
- **Auto-caps:** keywords are upper-cased automatically (no option). After
  typing, Enter or paste (`input*` user events), keyword tokens touched by the
  edit (statements, built-in functions, `AND` `OR` `NOT`, package statements)
  become upper case (`print` -> `PRINT`). Names, strings, `REM` text, commands
  and `NOT_IN_V2` words stay as typed (the latter keep their red marking). A
  word containing the cursor is left until finished; whole words only (`tomato`
  stays). It is a separate history step (`isolateHistory` "full", user event
  `autocaps`), so Ctrl+Z right after restores what was typed; `setSource()` does
  not auto-caps. Deliberately not a caps lock: Leap stores lines verbatim and
  prints strings as written, so full caps would change output
  (`PRINT "Hello"` -> `"HELLO"`). Typing into a running program (`INPUT`) is
  data and unaffected.

Verified in headless Chromium.

---

## Debugger (Phase 3 — done, `src/leap-debug.js` + `src/debugger.js`)

Verified in headless Chromium and Node against the real 2.0.2 ROM; all Node
checks also pass on 2.1.0-emu.1 (after the dispatch change below). The program
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
opcode; `vmInstruction` in `src/leap-debug.js` hooks it. A nonzero `VM_HALTED`
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

**Controller** (`createDebugger` in `src/debugger.js`): `beginRun()` resets the
line table and installs the watch, `endRun()` removes it. Breakpoints are
editor lines (the gutter), mapped to store lines through the last run
(`toStoreLine` / `toEditorLine` in `ide.js`; blank lines are not stored). A
breakpoint on a line without code (label, `REM`, blank) stops at the next line
with code. A breakpoint on a `PROC` line also stops at the procedure's entry:
its code starts with a jump over the body and calls enter 3 bytes later, at
`PARAM_BIND`. Step runs to the next statement start (it steps into `PROC`s;
`ENDP` gets a stop). Pause stops at the next statement. Breakpoints can be
added while running. Stop while paused ends the program as BREAK does
(`VM_ERROR_CODE` 66, `VM_HALTED` 1), so its screen stays up.

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

**Editor and toolbar.** The execution line is highlighted with an arrow in the
breakpoint gutter (a coral arrow when it is on a breakpoint line).
`window.leapEditor` gained `toggleBreakpoint(line)`, `onBreakpointsChanged(fn)`
and `setExecutionLine(line|null)`. The toolbar has Run, Stop, Pause/Continue
(F8) and Step (F10); the status bar reads "Paused at line N".

**Known limits.**

- `FOR` frames carry no line, so loops show without one.
- While a package statement runs, the EXROM is paged out: do not read `$C000`
  and up then.
- Z80-level breakpoints exist only as the `setWatch` API; there is no UI for
  them yet.

---

## Export Formats (Phase 6 — TAP and DCK done and verified)

`src/export.js` (tape) and `src/cartridge.js` (cartridge) hold pure builders
returning `Uint8Array`s. Neither touches the DOM, so Node can import them.

### Tape (done, verified) — `buildTAP`, toolbar "⬇ TAP"
Exactly what Leap's own `SAVE "name"` writes (`V2_SAVE` -> `STORAGE_SAVE` ->
`STORAGE_SEND_BLOCK`, a port of the stock SA-BYTES):

- **Header block:** flag `$00`, then 17 bytes: type 0; name, 10 bytes
  space-padded, as typed (`LOAD "name"` is a case-sensitive exact match; up to
  10 printable ASCII characters, see `checkTapeName`); length of the line store
  LE16; **Leap's tape format word** `V2_FORMAT_WORD` (`$8101` in 2.0.2 and 2.1) in the
  stock "autostart" field; program length LE16 (= the length for a plain
  program). `LOAD` refuses a tape without the format word. It is a ROM-table
  field, `tapeFormatWord` in `src/leap-roms.js`, generated by
  `tools/leap-rom-entry.py`.
- **Data block:** flag `$FF`, then the line store exactly as in RAM
  (`encodeLineStore`).
- Each block ends with the XOR of its flag and bytes. The `.tap` file is each
  block prefixed with its LE16 length. Leap uses the stock ROM pulse timings,
  which is what `.tap` assumes.
- **V2 has no autorun:** on the TS2068 type `LOAD ""` (or `LOAD "name"`), then
  `RUN`.

Verified byte for byte against Leap's real `SAVE` (capturing
`STORAGE_SEND_BLOCK` in Node; on 2.0.2 and on 2.1.0-emu.1, `V2_SAVE` `$D702`,
`STORAGE_SEND_BLOCK` `$C3F1` there), and loaded back by Leap's real `LOAD` with the
program intact; the browser download is identical. In TSRun this needs the
tape-loading fix (TSRun section above, in the submodule pin). The button (`exportTape` in
`ide.js`) prompts for the tape name (default: the file name, cut to 10
characters) and reports `Saved X.tap: on the TS2068, LOAD "X" then RUN`
(for a program that uses a package: `LOAD "NAME" EXT, then LOAD "X" then RUN`).

### DCK (Timex dock cartridge) — done, verified; `src/cartridge.js`, toolbar "⬇ DCK"
The owner approved this on 2026-10-28. Leap 2.0.2 and 2.1.0-emu.1 never look at
the dock, and their cold start clears RAM, so a cartridge that runs on a
**stock TS2068** needs Leap's *cartridge build* (`make cart`, `-DV2_CARTRIDGE`):
a runtime-only version with no editor. Its source is `cartridge-build/` in this repo: `leap.patch` on Leap's
`v2.1.0-emu.1` tag, applied and built by `setup.sh` into `cartridge-build/leap/`
(ignored); the details are in `cartridge-build/Docs/CARTRIDGE_STATUS.md`.
The original spec is [`docs/LEAP_CARTRIDGE_BUILD.md`](docs/LEAP_CARTRIDGE_BUILD.md).
The release's `roms/leap_v2_exrom.dck` is not this: it is only the EXROM as a
cartridge for EightyOne 1.41.

**Images.** `cartridge/2.1.0-emu.1/` holds `leap_v2_cart_home.bin` (16384 bytes,
SHA-256 `fb16d609…`) and `leap_v2_cart_exrom.bin` (8192 bytes, SHA-256
`df50142d…`) plus a README. Every release symbol keeps its address in the
cartridge build, so the IDE's 2.1.0-emu.1 checker produces exactly the
bytecode the cartridge runs.

**`src/cartridge.js`** (pure, no DOM or CodeMirror):
`romIdentity(home, exrom)` (CRC-16/CCITT, polynomial `$1021`, initial value
`$FFFF`, over HOME and then EXROM), `cartIdentity(cartHome)`,
`buildProgramImage({bytecode, symCounts, identity})`,
`buildCartridge({home, exrom, program})` returning `{dck, bin}`,
`pagingWrites(text)` (`OUT` statements with a literal port whose low byte is
244/`$F4` or 255/`$FF`), and the constants `CHUNK`, `MAX_BYTECODE` (4011) and
`SYM_COUNTS_SIZE` (5).

**Layout.** LROS cartridge. DOCK chunks 0-1 are the cartridge HOME, chunk 3 is
the program image, chunk 6 is the cartridge EXROM. The DCK header is
`00 02 02 00 02 00 00 02 00` (bank 0 = DOCK; chunks 0, 1, 3 and 6 are ROM (2),
the other chunks are absent (0)). The flat `.bin` is 64 KB with the chunks in address order; an
absent chunk is `$FF`.

**Program image** at `$6000`, format 1, 19-byte header: `"LEAPPROG"`, format
LE16 = 1, identity LE16, bytecode length LE16 (1 to 4011), `SYM_COUNTS` (5
bytes), then the bytecode. The identity for 2.1.0-emu.1 is `$E0A5`. The
cartridge refuses any other signature, format, identity or length and shows
`NO PROGRAM`. At run time it uses HSR (port `$F4`) = `$43` and DECR (port
`$FF`) bit 7 = 0. The stock ROM starts it after about 2 s (103 frames). After
the program ends, a key restarts it from cold.

**Checker.** `compile(store, symCountsSize)` in `src/leap-check.js` runs
`check(store)` (without a package) and, on code 0, also returns `bytecode`
(RAM from `VM_CODE_BASE` to `EMIT_PTR`) and `symCounts` (from `SYM_COUNTS`).
`src/leap-roms.js`: the 2.1.0-emu.1 entry has `symCounts: 0xB800` and
`cartridgeDir: 'cartridge/2.1.0-emu.1/'`; the 2.0.2 entry has neither, so
export says "There is no cartridge build for Leap 2.0.2-emu.1".
`tools/leap-rom-entry.py` emits `symCounts` and a `cartridgeDir` line (with a
comment to leave it out when a release has no cartridge build).

**The button** (`exportCartridge` in `ide.js`, title "Save the program as a
cartridge (.dck) that runs on a stock TS2068"), in order:
1. Storage problems or an empty program: error.
2. No `cartridgeDir` for the loaded ROM: error.
3. Any package statement: refused ("Cartridges cannot carry packages yet: line
   N uses SHAPES").
4. Pool size check.
5. Compiles on the checker machine. A compile error marks the line and reads
   "Compile error N on line L: fix it before exporting".
6. Fetches the cartridge images once (`loadCartridgeImages`) and refuses if
   `romIdentity` of the loaded ROMs differs from `cartIdentity` of the
   cartridge HOME.
7. An `OUT` to port 244 or 255 (literal) asks for confirmation ("... can switch
   Leap itself out ... Export anyway?").
8. Prompts for a file name, default `<name>.dck`. A name ending in `.bin`
   downloads the flat 64 KB image for a cartridge board instead.
9. Status: "Saved X.dck (N bytes of bytecode): it runs on a stock TS2068 from
   the dock slot".

Not supported in this first version: packages, tape / Array Store, returning to
an editor.

**Verification.** `tests/rom-checks.mjs` section 7 runs the exported cartridge
on a stock TS2068 (`tsrun/roms/ts2068-0.rom`, `ts2068-1.rom`, `insertDock`) to
the end (see "Tests"). The IDE's DCK was also byte-identical to the
CLI `cartridge-build/tools/leap2cart.mjs`'s for two programs. With those tools, 695 corpus programs give the same screen as `RUN` on the release ROMs
(5 expected differences, 0 failures), and ZEsarUX 13.0 with the stock ROM gives
byte-identical screens to TSRun; so does Fuse 1.9.1 for two cartridges
downloaded from the IDE in a browser. Not tried: real hardware.

Container reference (jon0x0/AISkill_TS2068, cartridge development skill): a DCK
is a 9-byte header (bank id + 8 chunk descriptors: 0 absent, 1 RAM, 2 ROM,
3 initialised RAM) followed by the 8 KB images; AROS/LROS headers. TSRun's
`dock.js` accepts banks 0 (DOCK), 254 (EXROM), 255 (HOME).

---

## Files (auto-save, New / Open / Save — done, `src/files.js` + `ide.js`)

`src/files.js` has no DOM or CodeMirror, so Node can import it; the toolbar
wiring is the "Files" section of `ide.js`.

- **Auto-save.** The program, its file name and the text as last saved or
  opened (`savedText`) are stored in the browser's `localStorage`, key
  `leap-ide.document` (`loadAutosave` / `storeAutosave`, which swallow storage
  errors), 500 ms after each change (`leapEditor.onChange`) and restored at
  start-up, so a reload loses nothing.
- **Toolbar**, next to the file name: **New** (asks before discarding unsaved
  changes), **Open** (`.leap` `.txt` `.bas` `.tap`; Ctrl+O), **Save** (downloads
  a text file to the browser's download folder; asks for a name the first time;
  Ctrl+S). Clicking the name renames. A `•` shows while the text differs from
  `savedText`. New and Open start a fresh document:
  `leapEditor.setSource(text, {fresh: true})` gives it its own undo history and
  clears the breakpoints. Line endings are normalised to `\n` (`normalizeText`).
- **Opening a Leap `.tap`** (written by Leap's `SAVE` or the IDE's TAP export)
  reads the first program back into source (`tapeToText`): a header with type 0
  and a `$81xx` format word, then the line-store records (LE16 length + 1, the
  text, `$0D`). A stock Sinclair/Timex BASIC tape is refused with a message,
  checksum errors are warned about, and a tape opened this way is marked unsaved
  (it is not a text file yet).
- Save and TAP export are separate: Save keeps the source as text; "⬇ TAP"
  builds the tape a TS2068 loads.

---

## Packages (done, `ide.js`, `src/emulator.js`, `src/leap-check.js`)

Package statements (`CIRCLE`, `FILL`, `GRAB`, `MODE`, `LPRINT`, `CBEEP`, …) are
not in the ROM: on a TS2068 a program loads a package with `LOAD "NAME" EXT`
first. The IDE does that for the user, so such programs compile and run.

- **Images.** The release's six package images are in
  `packages/2.1.0-emu.1/<name>.bin` (`cbeep graphics mode printer shapes sprite`),
  copied unchanged from the release zip and checked against its `SHA256SUMS`.
  The six are byte-identical to 2.0.2's (`packages/2.0.2-emu.1/`, checked with
  `cmp`; the release notes say the shipped packages are unchanged).
  `loadPackages` (ide.js) fetches them once at start-up, from the ROM entry's
  `packageDir`.
- **Which package.** `packagesUsed(text)` (`src/leap-lang.js`; with
  `LEAP_PACKAGES`) finds package statements at the start of a statement (line
  start or after `:`), so `circle = 5` is not one; strings and `REM` text are
  ignored. Leap loads **one package at a time**, so a program that uses two is
  an error on the line of the second (`packageFor` in ide.js). It finds package
  *statements* only. Leap 2.1 introduces package ABI 2.1 (package functions,
  floats, an error service); ABI 2.0 packages load unchanged and none of the
  shipped packages uses package functions. A future package that exports
  functions would need `packagesUsed` extended.
- **Install, as `LOAD "NAME" EXT` does (package ABI 2.0).** `inject()` in
  `src/emulator.js` and `check()` in `src/leap-check.js` do the same thing:
  `EXT2_CLEAR_ALL`, then the image at `$F400` (`EXTENSION_MODULE_BASE`) with its
  length in `V2_PACKAGE_LEN`, then the image's install entry at `$F400`, chained
  before `V2_CLEAR_ARRAYS` on the ROM stack (`EXT2_CLEAR_ALL` returns into the
  install, which returns into `CLEAR_ARRAYS`, then the usual
  `RESET_EDIT` / `RUN_STORED` chain for Run). The editor's error check installs
  the package too, so package statements are not flagged. Verified: `CIRCLE` +
  `FILL` draw.
- **ROM-table fields** `ext2ClearAll`, `packageBase`, `packageLen`, `packageDir`
  are generated by `tools/leap-rom-entry.py`; for a new release also copy its
  package binaries to `packages/<version>/`.
- **User-visible.** TAP export's status names the `LOAD "NAME" EXT` a real
  TS2068 needs before `LOAD "name"`. Hover help on a package statement says the
  IDE loads it on Run. `FILL` runs at real TS2068 speed (a radius-40 fill takes
  a few seconds).

---

## Themes (Phase 8 — done, `ide.css` + `ide.js` "Theme")

The toolbar's ☀ / ☾ button (after Help) switches between **light** and
**dark**; every click visibly changes the theme. Until the user clicks it, the
IDE follows the system setting (`prefers-color-scheme`, live). The choice is
remembered in `localStorage` (`leap-ide.theme` = `light` | `dark`; absent =
follow the system). (A first version cycled system → light → dark; rejected:
two of the three clicks often looked like nothing happened.)

- **Every colour is a CSS variable** in `ide.css`: the dark palette on `:root`,
  the light one on `:root[data-theme="light"]`. This includes the editor: the
  CodeMirror theme (`leapThemeSpec` in `src/editor.js`) and the syntax colours
  (`leapHighlight` in `src/leap-lang.js`, `--syn-*` variables) use `var(...)`,
  so switching theme only changes `<html data-theme>`. Do not add hex colours
  to the JS or CSS rules; add a variable to both palettes.
- `leapEditor.setDark(bool)` swaps CodeMirror's dark/light flag (through a
  `Compartment`), which only picks CM's own defaults for the lint tooltip and
  search panel.
- A small inline script in `ide.html`'s `<head>` applies the saved theme
  before the first paint, so a light page never flashes dark. It and
  `applyTheme` in `ide.js` must agree on the key and values.
- Unchanged in both themes: the TS2068 bezel and screen, and the TS2068
  paper/ink in the UDG and Draw tools (they show what the machine shows).

## Help (done, `src/help.js`)

"? Help" in the toolbar or F1 opens an overlay; Escape or a click outside closes
it. Everything is built with DOM nodes and `textContent`.

- **Keywords tab:** all 100 manual entries from `src/leap-keywords.js`, grouped
  as Statements, Functions, Operators, Package statements and Commands, with a
  search box that filters by name and description. Selecting one shows its
  forms, kind, description and example, and a link to its section of the manual
  on GitHub at the release tag (`LEAP_MANUAL_REF`; GitHub heading anchors, e.g.
  `#circle--package-shapes`).
- **Keys & tips tab:** the shortcuts (F5 Run, F6 Stop, F8 Pause/Continue, F10
  Step, Ctrl+S, Ctrl+O, Ctrl+Space completions, F1 help, Escape = BREAK in the
  TS2068 screen) and short usage tips. This is the keyboard cheat-sheet of
  Phase 8.
- Nothing is hand-written per keyword: a new release regenerates
  `src/leap-keywords.js` and Help follows.

---

## Editor Error Checking (Phase 5 — done, `src/leap-check.js`)

**Design decision: the linter is the ROM's own compiler, not a
re-implementation.** The editor's errors are therefore always the errors Run
reports, for whichever Leap release is loaded; nothing in the checker changes
for 2.1 beyond its ROM entry. As in the ROM, it stops at the first error, so
the editor shows one error at a time.

**`src/leap-check.js`** — `createChecker(rom, images)`. A second TSRun machine,
never displayed, boots the same ROM images once to the editor key wait
(`IO_READ_KEY.wait_hit`) and snapshots RAM, CPU and ports (about 74 ms in
Node). `check(store, pkg)` restores the snapshot, writes the line store and
`PROG_END`, puts a return chain on the ROM stack (`$FF00`) and calls
`V2_CLEAR_ARRAYS` -> `V2_COMPILE_STORED` -> back into the key-wait loop. It then
reads `COMPILE_ERROR_CODE` and `LEX_LINE & $7FFF`, the failing store line
(for end-of-source errors such as an unclosed `IF` or `GOTO` to an unknown
label that is the line count). It returns `{code, line}` (`code` 0 = compiles)
or `null` if the compiler does not finish. With a package image (`pkg`) the
package is installed first, as in "Packages". No frame interrupts are delivered
and nothing is drawn. Typical check about 1 ms; a 302-line program about
120 ms. It runs on the main thread; a Web Worker is the option if that ever
matters.

`V2_COMPILE_STORED` is the ROM symbol `compileStored` in `src/leap-roms.js`
(`$D54F` in 2.0.2, `$D45A` in 2.1), emitted by `tools/leap-rom-entry.py`. The emulator exposes
`romImages` for the checker.

**Error text** — `src/leap-errors.js` is generated by
`tools/gen-leap-errors.py <2068-Leap checkout> <git ref> > src/leap-errors.js`
from Appendix B of the manual. It exports `LEAP_COMPILE_ERRORS` and
`LEAP_RUNTIME_ERRORS`, each code -> `{message, cause}`; codes such as
"13, 14, 15" and "12 to 14" are expanded, and a code listed more than once
keeps the first message and joins the causes. Never edit it by hand; rerun it
for the next release (last run at `v2.1.0-emu.1`; `LEAP_MANUAL_REF` in
`src/leap-keywords.js` follows, so Help links go to the 2.1 manual). `describeError`
(ide.js) turns an entry into
"SYNTAX ERROR 3: an expression could not start where it did (…)". The 2.1 manual
writes run-time messages as `RUNTIME ERROR n`; `describeError` drops a trailing
" n" placeholder before adding the code. The 2.1 ROM itself shows the code with
both SYNTAX ERROR n and RUNTIME ERROR n.

**Editor wiring**
- `src/editor.js`: the CM6 `linter(...)` source calls
  `window.leapIDE.lintSource` 500 ms after typing stops. Until the hidden
  machine has booted there is nothing to report; `ide.js` then calls
  `leapEditor.relint()`.
- `lintSource(text)` (ide.js) first reports the storage problems from
  `prepareSource` (non-ASCII, lines over 127 characters, a program larger than
  the pool), then compiles. A diagnostic underlines the failing editor line from
  its first non-blank character (`lineRange`); blank lines are mapped
  correctly, and end-of-source errors go on the last line.
- The **Lint** button runs the same check and shows the first message, or "No
  errors", in the status bar.
- Run uses the same messages: a compile error reads "Compile error N on line L"
  with the line marked; a run-time error reads "Runtime error N at line L" with
  the line marked "RUNTIME ERROR 10: array index outside the array" (line found
  as described in "How Run Works"); BREAK reads "Stopped (BREAK) at line N".

Not implemented (the old plan listed them): a nested-`PROC` check of the
IDE's own, several errors at once, and warnings such as unused labels.
Verified in headless Chromium and Node against the 2.0.2 ROM.

---

## Phase 7 — done (`src/tools/`)

The right panel has four tabs: **Debugger | Symbols | UDG | Draw**. The chosen
tab is remembered in `localStorage` (`leap-ide.tab`); the debugger's refresh
button shows only on the Debugger tab, and a debugger pause (breakpoint or
Step) switches back to it. Code the tools generate goes in through
`leapEditor.insertLines(text)` in `src/editor.js`: it inserts whole lines after
the cursor's line, selects them, scrolls to them and is one undo step. The tab
code is in the "Right-panel tabs" section of `ide.js`; the UDG tool is created
in `bootEmulator` because it needs the ROM entry and the machine.

- **Symbols** (`src/tools/symbols.js`): procedures `name(param)`, `DEF FN`s,
  labels `name:` and variables (each with the line it is first set), grouped
  with counts and sorted by line, with a filter box. Clicking a name moves the
  editor to its line. Built on `scanSymbols()`; refreshes 300 ms after edits
  while the tab is open.
- **UDG** (`src/tools/udg.js`): Leap V2's 21 user-defined characters, codes
  144-164 (`UDG_CODE_BASE`, `UDG_COUNT`), 8 bytes each at `UDG_TABLE` (`$F180`
  in 2.0.2 and 2.1). The ROM entry carries `udgTable`, `udgCodeBase` and `udgCount`,
  generated by `tools/leap-rom-entry.py` (`SYMBOLS`). Leap programs define
  UDGs with `POKE` (no `DATA`/`READ`), and a UDG made only in the IDE would not
  exist on a real TS2068, so the tool works on the **program text**: "Insert
  POKEs" (this character) and "Insert all" (every drawn one) add a `REM` line
  plus two lines of four `POKE`s per character (about 70 characters, under the
  127 limit) after the cursor line; "Load from program" reads constant `POKE`s
  into the table range back into the grid (a round trip); "Send to TS2068"
  writes all 168 bytes into the emulated machine now. The grid: click or drag
  to draw (the first cell decides set or clear), Clear, Invert, flip left-right
  and up-down, shift in four directions; 21 thumbnails; the title shows
  `CHR$(n)`, the address and the 8 byte values. Designs persist in
  `localStorage` (`leap-ide.udg`). Exports `createUdgTool`, `udgPokes`,
  `pokesInSource`.
- **Draw** (`src/tools/draw.js`), the graphics scratchpad: a 256x192 canvas that
  is the TS2068 screen (y from the top, 1 CSS pixel per pixel). Clicks add
  points to a path; a one-point path is `PLOT x, y`, each further point a
  `LINE x0, y0 TO x1, y1`. Right-click, Escape or "End path" ends a path; Shift
  snaps horizontal/vertical; Backspace/Delete undoes a point. The preview is
  Bresenham (both ends inclusive) on an ink canvas, with an overlay canvas for
  markers and the rubber band. The generated code is shown live, with "Insert
  into program" and "Copy"; paths persist in `localStorage` (`leap-ide.draw`).
  The area zooms 1×, 2× or 3× with its own − / + buttons, like the display: a
  whole number of device pixels per screen pixel, the overlay drawn at device
  resolution, and when zoomed the pixel under the pointer is outlined. While
  the Draw tab is open the right panel widens to fit; the zoom drops when the
  editor would get less than 360 px (+ is then disabled, saying why). The
  choice is remembered (`leap-ide.drawZoom`, default 2×); layout is
  `applyDrawZoom` in `ide.js` ("Draw zoom"), and `createDrawTool` returns
  `{setSize}`. Exports `createDrawTool`, `bresenham`, `pathsToCode`.

Verified in headless Chromium: the tabs and the symbol table contents, and the
rendering of the UDG and Draw tabs; the tools' code insertion and runs were
tested separately.

---

## Build Phases

| Phase | Deliverable                                         | Key files               | Status |
|-------|-----------------------------------------------------|-------------------------|--------|
| 1     | Shell + TSRun embedded + program runs               | `ide.html`, `ide.js`, `src/emulator.js`, `src/leap-roms.js` | **Done**, verified |
| 2     | CodeMirror 6 editor + Leap V2 syntax                | `src/editor.js`, `src/leap-lang.js`, `src/leap-keywords.js` (generated) | **Done**, verified |
| 3     | Debugger panel (registers, step, breakpoints)       | `src/debugger.js`, `src/leap-debug.js` | **Done**, verified |
| 4     | Keyboard translation + `INPUT` mode                 | `src/pc-keyboard.js`    | **Done**, verified |
| 5     | Error checking by the ROM's compiler, wired to the CM6 linter | `src/leap-check.js`, `src/leap-errors.js` (generated), `ide.js`, `src/editor.js` | **Done**, verified |
| 6     | Tape + DCK export                                   | `src/export.js`, `src/cartridge.js`, `cartridge/2.1.0-emu.1/`, `src/leap-check.js` (`compile`), `ide.js` | **Done**, verified (TAP, DCK; DCK has no packages yet) |
| 7     | UDG editor, symbol table, graphics scratchpad       | `src/tools/symbols.js`, `udg.js`, `draw.js`, `src/editor.js` (`insertLines`), `ide.js` | **Done** |
| 8     | Polish: themes, help overlay, keyboard cheat-sheet  | `ide.html`, `ide.css`, `ide.js`, `src/help.js` | **Done** (themes: light / dark / system) |
| —     | Files (auto-save, New/Open/Save) and Packages (`LOAD "NAME" EXT` on Run) | `src/files.js`, `ide.js`, `src/emulator.js`, `src/leap-check.js`, `packages/` | **Done**, verified |

---

## Source Repositories

- **Leap** (ROM source, manual): https://github.com/nchiker/2068-Leap, local
  clone `~/2068-Leap`. V1 is archived; ignore it.
- **TSRun** (emulator): fork https://github.com/nchiker/TSRun, git submodule
  `./tsrun` pinned at `016787f`.
- **This project on GitHub**: https://github.com/nchiker/2068-Leap-IDE, live at
  https://nchiker.github.io/2068-Leap-IDE/.
- **This project**: `/home/charlie.day/Projects/Leap-IDE`
- **Mock-up**: `docs/mockup.html` — open in a browser for the visual target.
- **Design docs**: `docs/overview.md`

---

## Module fingerprints (browser caching)

Browsers cache scripts (GitHub Pages sends `max-age=600`; `python3 -m http.server`
lets them guess), so after an update a page could combine the new `ide.html`
with an old `ide.js` — e.g. tab buttons that do nothing. `tools/stamp-modules.py`
gives every module URL a hash of its contents: the two entry scripts in their
`<script src>`, every module they import (ours and TSRun's) as
`"./src/x.js": "./src/x.js?v=<hash>"` in the import map. Modules keep their
plain relative imports; the import map remaps them. A changed file gets a new
URL, an unchanged one stays cached, versions never mix.

**Run `tools/stamp-modules.py` after changing any `.js` file, before committing**
(`--check` reports whether `ide.html` is current). `tools/pre-commit` is an
optional git hook that does it on every commit (owner's choice to install:
`ln -s ../../tools/pre-commit .git/hooks/pre-commit`). A new module is picked up
automatically as long as a relative `import` reaches it from `src/editor.js` or
`ide.js`.

## Tests

- `node tests/rom-checks.mjs` — 47 checks in about 1 s against the real ROMs in
  Node (TSRun's machine, no browser): ROM table lookup, Run by injection
  (finished, compile error, run-time error, package), the checker's error codes
  and lines, packages, the debugger's line table / breakpoints / variables /
  call stack, TAP export byte-identical to Leap's `SAVE`, the UDG and Draw
  helpers, and (section 7, "Cartridge", 8 new checks) the cartridge: the
  identity match, the checker's bytecode and `SYM_COUNTS`, a compile error
  giving no bytecode, the DCK layout, the flat BIN, a stock TS2068
  (`tsrun/roms/ts2068-0.rom`/`ts2068-1.rom`, `insertDock`) running the exported
  cartridge to the end (POKE marker 42, VM error 0, `$F4` = `$43`), a wrong
  identity being refused, and `pagingWrites`. `LEAP_ROMS=<dir>` tests other ROM files. All 47 pass on 2.1.0-emu.1
  (the default ROMs now) and with `LEAP_ROMS` pointing at the 2.0.2 ROMs. The
  expected values were recorded on 2.0.2-emu.1 and held for 2.1 unchanged; only
  the debugger's `vmNext` hook and the TAP check's carry-set stand-in needed
  changes.
- `node tests/browser-smoke.mjs [outdir]` — 18 checks in about 30 s, in headless
  Chrome: it serves the repo itself, boots the IDE and checks fingerprinted
  modules, Run results in the status bar, the error check, auto-caps, tabs,
  Draw zoom, theme and Help, the DCK export (a cartridge downloads; the file-name
  prompt and the download are captured in the page; a package program is
  refused), with no page errors. It saves screenshots.
- Run both before every commit that changes behaviour. `src/leap-lang.js`
  imports CodeMirror, so Node cannot load it; it is covered by the browser
  test.

## Coding Conventions

- Plain ES2020 modules (`type="module"`). No TypeScript, no bundler.
- `"use strict"` in every file.
- Functions over classes where state is minimal.
- Constants for every magic address; per-release addresses belong in
  `src/leap-roms.js`, not scattered through the code.
- No external CSS frameworks — one `ide.css` for the shell layout.
- Comments on anything non-obvious, especially TSRun API calls.

---

## What Claude Code Should Do Next

All phases are done. Phases 1 to 5, 7 and 8 work, Phase 6's tape export (Leap's
own `LOAD` reads the IDE's `.tap`) and DCK export (a cartridge that runs on a
stock TS2068, approved by the owner on 2026-10-28) are done and verified, and
saving/opening programs, packages and the Help overlay are done. The Leap
2.1.0-emu.1 ROM entry is done (ROM table, generated keyword and error data,
packages, cartridge images, tests). Nothing is on hold. Ideas, none started:

1. **Packages on cartridges.** The cartridge image carries bytecode only; a
   program that uses a package is refused today.
2. **Test the DCK on real hardware.** It has run on TSRun, ZEsarUX 13.0 and
   Fuse 1.9.1 with the stock ROM (same screens), not on a real TS2068.
3. **Cartridge builds for future Leap releases** (see "Adding a Leap ROM
   release", step 5).
