# Leap V2 Web IDE — CLAUDE.md

This is the authoritative technical brief for the Leap V2 Web IDE.
Read this file completely before writing any code. Then read `docs/overview.md`
for the design rationale. The mock-up is at `docs/mockup.html` (a visual
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
  autocomplete, built-in help, structure linter, breakpoint gutter.
- **Emulator panel** — TSRun's TS2068 running the Leap V2 ROMs, 256×192 canvas.
- **Debugger panel** — Z80 registers, Leap variables, breakpoints, call stack.

Leap is **V2**; the current release is **2.0.2-emu.1**. Version 2.1 is in
development; the owner will say when its ROMs are ready. V1 is archived and
irrelevant. ROM addresses change between releases; everything else in the IDE
should stay the same (see "Adding a Leap ROM release").

---

## Source Files in This Repo

```
Leap-IDE/
├── ide.html          ← Shell (three-panel layout, CM6 import map)
├── ide.css           ← Shell layout and theme
├── ide.js            ← Orchestrator: boot emulator, prepare source, run/stop, status
├── src/
│   ├── emulator.js   ← Slim TSRun host + RAM-injection run/stop (Phase 1, done)
│   ├── leap-roms.js  ← Known ROM builds: SHA-256 -> addresses (Phase 1, done)
│   ├── pc-keyboard.js ← PC key -> TS2068 matrix translation (Phase 4, done)
│   ├── editor.js     ← CodeMirror 6 setup, gutter, autocomplete, help tooltip (Phase 2, done)
│   ├── leap-lang.js  ← Language mode, token classes, scanSymbols (Phase 2, done)
│   ├── leap-keywords.js ← GENERATED keyword data from the manual; never hand-edit
│   ├── debugger.js   ← Registers, variables, breakpoints, call stack (Phase 3)
│   └── export.js     ← Tape + DCK builders (Phase 6; current layout is wrong)
├── tools/
│   ├── leap-rom-entry.py  ← Prints a leap-roms.js entry for a 2068-Leap build
│   └── gen-leap-keywords.py ← Generates src/leap-keywords.js from the Leap manual
├── docs/
│   ├── overview.md   ← Design doc
│   └── mockup.html   ← Visual mock-up
└── tsrun -> ../../TSRun   ← symlink to the TSRun fork (not in git history)
```

**ROMs are not in this repo.** They load from `tsrun/roms/leap-0.rom` (16K
HOME) and `tsrun/roms/leap-1.rom` (8K EXROM). These are the 2.0.2-emu.1 release
images (SHA-256 `1fe5798f…` and `e6b507a4…` respectively).

**TSRun** is the fork https://github.com/nchiker/TSRun (upstream
josef-jelinek/TSRun), cloned at `~/TSRun` and linked into the project root with
`ln -s ../../TSRun tsrun`. There is no `../josef-jelinek/` path. Do not copy
TSRun into the repo. The fork carries one change, committed on its `main`
branch (a local commit; pushing it is up to the owner): `sound.js` loads its
worklet with `new URL("sound.worklet.js", import.meta.url)` instead of a
page-relative path, so audio works from a page outside TSRun's directory.

Serve with `python3 -m http.server 8080` from the project root and open
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
characters `[ \ ] ^ ` { | } ~` print as blanks (the ROM font has no glyphs).

### Compile and run-time errors

The ROM reports numeric codes; the IDE reads them from RAM (see "How Run
Works"). Full tables: manual Appendix B. Codes the linter and status bar care
about most:

| Code | Cause |
|------|-------|
| 2    | Unknown word, identifier not followed by `=` (includes `LET`, `GOSUB`, an absent package statement) |
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

## Memory Map — Critical Addresses (2.0.2-emu.1)

Addresses move between releases; the per-release values live in
`src/leap-roms.js`. Full table: manual Appendix E.

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
`src/emulator.js` through the `tsrun` symlink. They are not classic `<script>`
tags. TSRun's own `host.js` is tied to its desk UI, so the IDE has its own slim
host in `src/emulator.js`. There is **no** `machine.run()` / `.stop()` /
`.step()` / `.poke()` API.

| File          | What the IDE uses |
|---------------|-------------------|
| `machine.js`  | `createMachine`, `setHomeRom`, `setExRom`, `resetMachine`, `runFrame`, `setVideoOn`, `enableSound`, `setSoundRate`, `takeAudio`, `cpuHz`, `tStatesPerFrame`. Memory: `machine.bus.read(addr)` / `machine.bus.write(addr, v)`. |
| `z80.js`      | `runZ80(cpu, budget)` — a budget of 1 runs one instruction. CPU state is `machine.cpu` (`pc`, `sp`, `a`, `f`, `b`, `c`, …, `iff1`, `im`). |
| `screen.js`   | `initScreen`, `resizeScreen`, `setCrt`, `drawScreen` (WebGL2) |
| `keyboard.js` | **Not used** by the IDE; `src/pc-keyboard.js` replaces it (see Keyboard). The IDE writes `machine.keyMatrix` itself. |
| `sound.js`    | `initSound`, `resumeSound`, `pushSound`, … (AudioWorklet, needs the fork's `import.meta.url` fix) |
| `dock.js`     | `parseDck` only (reads a dock; reference for the Phase 6 builder) |
| `tape.js`, `load.js` | Tape loading; possible aid for Phase 6 verification (unverified: not yet read) |

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
   `V2_COMMAND_LOOP.loop` at `$FF00`) and jump to `V2_CLEAR_ARRAYS`.
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
   / Stopped (BREAK). While a program waits at `INPUT`/`PAUSE 0` it reads
   "Waiting for input — click the screen to type".
   When a run ends its output stays on screen: nothing dismisses it into
   Leap's editor (see Keyboard). The Run button injects at that "press a key"
   wait as before.

**Stop:** BREAK if busy; if the program is waiting at `INPUT`/`PAUSE 0`, jump
straight back to the ROM's command loop (`V2_COMMAND_LOOP.loop`). Observed:
BREAK alone does not end an `INPUT` wait in 2.0.2; Leap 2.1 (in testing) is
expected to fix that, and the jump is the workaround until then.

`window.leapIDE` exposes `lintLeap`, `encodeSource`, `refreshDebugger`,
`setStatus` and `emulator` (the object from `createEmulator`: `run`/`stop`/
`reset`, `rom`, `machine`), which is useful for tests and the Phase 3 debugger.

Verified in headless Chromium: hello world, compile error with line, BREAK
stop, `INPUT` stop, re-run while busy.

### Adding a Leap ROM release

1. In a 2068-Leap checkout at the release tag, `make build`.
2. `tools/leap-rom-entry.py <checkout> <version>` prints a `KNOWN_ROMS` entry
   (the script also checks that the key-wait spin loop still has the expected
   bytes).
3. Paste the entry into `src/leap-roms.js` and put the new
   `leap-0.rom`/`leap-1.rom` in `tsrun/roms/` (or switch the loader to them).
4. Re-run the Phase 1 checks (hello world, compile error, BREAK, `INPUT`).
   Update the memory-map table above if the layout moved.

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

If Leap 2.1 changes its key tables, `SYMBOLS` in `src/pc-keyboard.js` must
follow.

Verified: typing `Hi(1)<2>;=+-*/,.:?!@#$%&'_"Z` into an `INPUT` returned
exactly that string (`LEN` 28). The on-screen TSRun keyboard (`#ts-keyboard`)
was removed from `ide.html`.

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
Phase 5 diagnostics.

### Keyword data (generated)

`src/leap-keywords.js` is **generated; never hand-edit it**:

```
tools/gen-leap-keywords.py <2068-Leap checkout> <git ref> > src/leap-keywords.js
```

It reads `docs/manual/03_keywords.md` at that ref (currently `v2.0.2-emu.1`) and
emits `LEAP_KEYWORD_ENTRIES`: 100 entries, each `{kind, package, syntax, forms[],
desc, example}`. `kind` is function / statement / operator / command / part of;
`package` is `null` or the package name; `desc` is the first paragraph (at most
420 characters); `example` is the first basic example (at most 6 lines). For
Leap 2.1, rerun it at the 2.1 tag.

### Language mode and editor (Phase 2 — done)

**`src/leap-lang.js`** implements the language mode with `@codemirror/language`
`StreamLanguage` (simpler than a Lezer grammar here). It exports `leapLanguage`,
`leapHighlight`, `LEAP_WORDS` (Map word -> `{cls, entry}`), `NOT_IN_V2`,
`keywordEntry(word)` (`DEF` -> `DEF FN`, `EXIT` -> `EXIT FOR`),
`keywordTokens(lineText)` (`[{from, to, text}]` keyword tokens on one line,
same lexer; used by auto-caps) and
`scanSymbols(text)` (PROCs, DEF FNs, labels and variables with line numbers;
reusable for the Phase 7 symbol table). `LEAP_KEYWORDS` and `LEAP_HELP` no
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
`setSource(text)`, `setDiagnostics()`).

- **Autocomplete:** all manual keywords except commands, with the first form as
  the detail and the full help as the info panel; built-in functions insert
  `NAME(`; snippets for `IF` … `ENDIF`, `IF` … `ELSE` … `ENDIF`, `FOR` … `NEXT`,
  `PROC name(p):` … `ENDP` and `DEF FN`; the program's variables. Context: after
  `CALL` only `PROC` names (detail `PROC (param) · line N`), after `GOTO` only
  labels, after `FN` only `DEF FN` names.
- **Hover help:** a keyword shows every form, its kind (package statements say
  `needs LOAD "NAME" EXT`), the description and the example. Commands say they
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

## Debugger Panel (Phase 3 — not started)

Read Z80 state from `machine.cpu` after each step/break. Display:

- **Registers:** AF, AF′, BC, BC′, DE, DE′, HL, HL′, IX, IY, SP, PC
- **Flags:** C N P/V H Z S decoded from F
- **Variables:** the Leap test harness reads numeric scalars from
  `RT_SYMTAB_PTR` (`$B80D` in 2.0.2) as 3-byte entries (tag, value LE16). This
  is a starting point only — unverified beyond that; strings, floats and arrays
  are not yet understood. Inspect the ROM source and RAM after a run.
- **Call stack:** unverified design — track `PROC` entry/exit through the
  bytecode VM's control stack (12 bytes per active `CALL`/`FOR`) rather than
  Z80 `CALL`/`RET`; the program is bytecode, not Z80 code.
- **Breakpoints/step:** Leap source breakpoints must map to VM state, not Z80
  PCs; the design is open. Z80-level stepping is available through `runZ80`.
- **Memory inspector:** hex dump of an arbitrary 256-byte window via
  `machine.bus.read`, address editable.

---

## Export Formats (Phase 6 — layout to be derived)

### Tape
The TAP layout in earlier drafts (a type-3 code block at `$825A` with an
autostart flag) was **invented and is wrong**. Leap V2 `SAVE` uses its own
TS2068-framed tape format; see `~/2068-Leap/docs/V2_SAVE_ALL_FORMAT.md` and the
storage code in the ROM source. Phase 6 must derive the block layout from
Leap's `SAVE`, then verify by `LOAD`ing the result in the emulator.

### DCK (Timex dock cartridge)
Structure: see TSRun's `dock.js`, which currently has only `parseDck` (reading);
a builder has to be written and verified by loading it in TSRun.

`src/export.js` should expose both builders as pure functions returning
`Uint8Array`. The current file was written to the wrong layouts.

---

## Structure Linter (Phase 5 — to be rewritten)

`lintLeap` in `ide.js` was written to the wrong rules (16-character names and
64-character strings instead of 31 and 31; one-line `IF … THEN stmt` treated
as an unclosed block; unaware of the real syntax). It is **not run before
Run**; the ROM compiler is the check for now, and its error code and line are
already surfaced.

Phase 5 must rewrite it from the language reference and manual Appendix B,
returning `[{line, col, message}]` mapped to CM6 `Diagnostic`s. Rules to cover
(each tied to a ROM compile error, so the IDE message can quote the code):

- `IF … THEN` without `ENDIF` (9); `IF` without `THEN` (8); allow the one-line
  `IF cond THEN GOTO label`
- `FOR` without `NEXT` (65), `NEXT` for another variable (56), `EXIT FOR`
  outside a loop (63), `FOR` without `TO` (11)
- `PROC` without `ENDP` (16); nested `PROC` (to verify against the ROM)
- `GOTO` to an undefined label (7); duplicate label/`PROC`/`DEF FN` (57)
- `LET`, `GOSUB`, `RETURN`, `DRAW` and other words not in V2 (2)
- Names over 31 characters (61); string literals over 31 characters (70);
  underscores in names
- Package statements (`CIRCLE`, `FILL`, `MODE`, `GRAB`, …) used without a
  `LOAD "NAME" EXT` (2): warn, since the package is loaded at the ROM prompt
  and the IDE does not yet have a way to load one — unverified how the IDE
  should handle packages

---

## Additional Tools (Phase 7)

- **UDG editor** — 8×8 grid per character, 21 characters (codes 144–164),
  live preview; writes 168 bytes to `$F180`–`$F227` before RUN (the table
  survives `RUN`, but is not initialised at start-up).
- **Symbol table** — scans source for `PROC`, `DEF FN`, label and variable
  names; shows line number; click jumps to the definition.
- **Graphics scratchpad** — 256×192 canvas for drawing `PLOT` / `LINE` paths
  (y from the top) and copying the generated statements into the editor.

---

## Build Phases

| Phase | Deliverable                                         | Key files               | Status |
|-------|-----------------------------------------------------|-------------------------|--------|
| 1     | Shell + TSRun embedded + program runs               | `ide.html`, `ide.js`, `src/emulator.js`, `src/leap-roms.js` | **Done**, verified |
| 2     | CodeMirror 6 editor + Leap V2 syntax                | `src/editor.js`, `src/leap-lang.js`, `src/leap-keywords.js` (generated) | **Done**, verified |
| 3     | Debugger panel (registers, step, breakpoints)       | `src/debugger.js`       | Not started |
| 4     | Keyboard translation + `INPUT` mode                 | `src/pc-keyboard.js`    | **Done**, verified |
| 5     | Structure linter wired to CM6 lint extension        | `ide.js` (or `src/lint.js`) | Rewrite needed |
| 6     | Tape + DCK export                                   | `src/export.js`         | Format to derive |
| 7     | UDG editor, symbol table, graphics scratchpad       | `src/tools.js`          | Not started |
| 8     | Polish: themes, help overlay, keyboard cheat-sheet  | `ide.html`, `ide.css`   | Not started |

---

## Source Repositories

- **Leap** (ROM source, manual): https://github.com/nchiker/2068-Leap, local
  clone `~/2068-Leap`. V1 is archived; ignore it.
- **TSRun** (emulator): fork https://github.com/nchiker/TSRun, local clone
  `~/TSRun`, linked as `./tsrun`.
- **This project**: `/home/charlie.day/Projects/Leap-IDE`
- **Mock-up**: `docs/mockup.html` — open in a browser for the visual target.
- **Design docs**: `docs/overview.md`

---

## Coding Conventions

- Plain ES2020 modules (`type="module"`). No TypeScript, no bundler.
- `"use strict"` in every file.
- Functions over classes where state is minimal.
- Constants for every magic address; per-release addresses belong in
  `src/leap-roms.js`, not scattered through the code.
- No external CSS frameworks — one `ide.css` for the shell layout.
- Comments on anything non-obvious, especially TSRun API calls.

---

## What Claude Code Should Do Next — Phase 3

Phases 1, 2 and 4 work: the emulator runs injected programs, the editor has
highlighting, autocomplete and hover help, and keys reach `INPUT`. Now build the
debugger panel (`src/debugger.js`), following "Debugger Panel" above:

1. **Registers and flags** from `machine.cpu`, reachable through
   `window.leapIDE.emulator.machine`; show them after a stop, an error or a
   single step (`runZ80` with a budget of 1).
2. **Memory inspector** over `machine.bus.read`, with an editable address.
3. **Variables** from `RT_SYMTAB_PTR` as described above (unverified beyond
   numeric scalars; inspect the ROM source and RAM after a run first).
4. **Call stack:** the design is open and unverified (VM control stack, not Z80
   `CALL`/`RET`). `scanSymbols()` from `src/leap-lang.js` gives the `PROC` names
   and their source lines, which a call-stack view can use to show where each
   active `PROC` is defined.
5. Verify in the browser that the panel updates after a run, an error and a
   BREAK, and that Run still works.
