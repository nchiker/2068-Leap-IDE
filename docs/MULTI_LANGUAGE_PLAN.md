# Plan: one IDE for Leap V2 BASIC, Leap-C and Leap-Forth

Status: proposal, 2026-10-31. Nothing here is started.

The IDE drives one ROM family today, Leap V2 BASIC. The owner also has two
sibling ROMs for the TS2068, built on Leap V2's kernel:

- **Leap-C** (`~/2068-Leap-C`, github.com/nchiker/2068-Leap-C): a C89 subset,
  compiled to Z80 code on `RUN`. Plan: [`LEAP_C_PLAN.md`](LEAP_C_PLAN.md).
- **Leap-Forth** (`~/2068-forth`): a subroutine-threaded Forth with an
  interactive prompt. Plan: [`LEAP_FORTH_PLAN.md`](LEAP_FORTH_PLAN.md).

This document is the shared groundwork both plans need first: the IDE has to
stop assuming BASIC before a second language can be added. It is written as
**stage 0** of both plans. Do it once, then the two language plans are
independent of each other.

Recommended order: stage 0 (this document), then Leap-C (close to V2, most
patterns carry over), then Forth (a different run model).

---

## What is already in place

- The pinned TSRun submodule (`016787f`) already carries `roms/leapc-0.rom` /
  `leapc-1.rom` and `roms/leapforth-0.rom` / `leapforth-1.rom`. The Leap-C pair
  is byte-identical to Leap-C `v1.0.0-beta.2` (`043becf4…` / `97fe9523…`). The
  Forth pair (`760a5ce3…` / `2add175c…`) does not match the current Forth
  build (`d056a159…` / `6360ccf6…`); the owner will have TSRun carry the
  matching Forth ROMs by the time the Forth work starts (see the Forth plan).
- All three ROMs use the 16K HOME + 8K EXROM split and Leap V2's kernel I/O
  (copied, not shared), so `IO_READ_KEY.wait_hit` exists in each as the idle
  point, and the "single-step to a safe point, inject, jump" approach of
  `src/emulator.js` applies to all three.
- Language-neutral today: the emulator host (except the inject step), display
  and zoom, sound, the run/pause/step machinery and its `setWatch` hook, the
  debugger's registers, memory inspector and Z80 breakpoints, files and
  auto-save, share links, themes, the Help overlay's frame.

## What assumes BASIC today

| Where | What |
|---|---|
| `src/editor.js:42-45` | Imports `leap-lang.js` directly: language mode, `LEAP_WORDS`, `NOT_IN_V2`, `keywordEntry`, `scanSymbols`, `keywordTokens`, `nameTokens`, `blockStructure`, `blockIndent`. Completion (`leapComplete`), hover help, auto-caps, folding, indent, block match, go to definition, rename all sit on these. |
| `ide.js` | `prepareSource` / `encodeSource` (V2 line store), `injectProgram`, `showRunResult` (compile / VM error codes), `describeError` + `LEAP_*_ERRORS`, `packageFor` / `loadPackages`, `exportTape` / `exportCartridge`, `UNTITLED = 'untitled.leap'`, the Examples menu. |
| `src/emulator.js` | `inject()` writes the V2 line store and pushes the V2 return chain; `stop()` knows V2's command loop; `loadRoms` fetches `tsrun/roms/leap-*.rom`. |
| `src/leap-roms.js` | One flat table of V2 entries. |
| `src/leap-check.js` | V2 compile chain and error cells. |
| `src/leap-debug.js`, `src/debugger.js` | V2 VM line table, variables, call stack; the panel's Variables / Call stack sections. |
| `src/pc-keyboard.js` | V2's SYMBOL SHIFT table. Leap-C and Forth changed it (they type `[ ] { } \| ~ ^ \`). |
| `src/help.js` | Reads `leap-keywords.js`, V2 groups and the V2 manual link. |
| `src/tools/udg.js`, `draw.js` | Generate BASIC (`POKE`, `PLOT`, `LINE`). |
| `src/files.js` | `tapeToText` accepts only V2 tapes (`$81xx`). |

## Stage 0 design: a language profile

Each language is one profile object; the IDE core asks the active profile for
everything language-specific. Proposed layout:

```
src/lang/
├── profile.js        ← the profile shape (doc comment), lookup by id / file extension / tape
├── basic/            ← today's code, moved: leap-lang.js, leap-keywords.js, leap-errors.js,
│                       leap-check.js, leap-debug.js, examples.js, export.js, cartridge.js
├── c/                ← Leap-C (LEAP_C_PLAN.md)
└── forth/            ← Leap-Forth (LEAP_FORTH_PLAN.md)
```

A profile provides (fields marked *optional* may be `null`, and the IDE hides
the matching UI):

| Field | Purpose |
|---|---|
| `id`, `name`, `extensions`, `untitled` | `'basic'`, `'Leap V2 BASIC'`, `['.leap', '.bas']`, `'untitled.leap'` |
| `romName`, `knownRoms` | `tsrun/roms/<romName>-0.rom` / `-1.rom`; the SHA-256-keyed table (today's `KNOWN_ROMS` becomes BASIC's) |
| `editorExtensions()` | CodeMirror extensions: language, highlight, completion, hover help, folding, indent, block match, auto-caps (BASIC only) |
| `symbols(text)` | For the Symbols tab, go to definition and rename |
| `lineLimit` | 127 for BASIC and C; Forth per its plan |
| `helpEntries`, `manualRef` | For the Help overlay |
| `prepare(text)` | Text -> `{bytes, lineMap, problems}` (what to write into RAM, editor line mapping, storage errors) |
| `inject(machine, rom, prepared, extra)` | Write RAM and set up the jump; called by the emulator at the safe point |
| `stopPlan` | What Stop does when the program waits (V2: jump to the command loop) |
| `readResult(machine, rom)` | `{kind: finished/compile/runtime/break, code, line, column?}` |
| `describeError(result)` | Status-bar and diagnostic text |
| `createChecker(rom, images)` | Editor error check (`check(text) -> {code, line, column?}`) |
| `debug` | Line table hooks, variables / stack readers, extra panel sections |
| `keyboard` | The SYMBOL SHIFT table for `src/pc-keyboard.js` |
| `exportTape(text, name)` | *optional* |
| `exportCartridge(...)` | *optional* (BASIC only for now) |
| `extensionsUsed(text)` | *optional* packages (BASIC) / libraries (C) |
| `examples` | Examples menu entries |
| `tools` | *optional* UDG / Draw code generators |
| `tapeToText(bytes)` | Recognise its own tapes on Open |

### Switching language

- A language selector in the toolbar (next to the ROM name), plus
  `?lang=basic|c|forth` in the URL.
- Switching: stop any run, load the profile's ROM pair into the existing machine
  (`setHomeRom` / `setExRom` + reset; no new `createEmulator`), rebuild the
  checker, swap the editor extensions through a `Compartment`, rebuild the
  debugger's language sections, Help, Examples and the export buttons.
- **Auto-save per language:** `leap-ide.document.<id>`. On first start, migrate
  the existing `leap-ide.document` to `leap-ide.document.basic`. Switching
  language swaps documents rather than translating text. Breakpoints and undo
  history do not cross languages.
- **Open** picks the language from the extension (`.c` -> C, `.fs` / `.4th` ->
  Forth, `.leap` / `.bas` -> BASIC) or, for `.tap`, from the tape's format word
  (`$81xx` V2, `$8C00` Leap-C; Forth TEXT tapes have param1 `$8000`). A file of
  another language switches language (after the usual "discard changes?").
- **Share links** gain `&lang=<id>` (absent = `basic`, so existing links keep
  working).
- Remembered: the last language (`leap-ide.lang`).

### Work items

1. Create `src/lang/basic/` and move the BASIC modules there unchanged; update
   imports. Check that `tools/stamp-modules.py` still finds every module (it
   follows static relative imports from `ide.js` / `src/editor.js`; keep the
   profiles statically imported, or extend the script for `import()`).
2. Define the profile shape; build the BASIC profile from the moved code.
3. `src/editor.js`: take the profile's extensions instead of importing
   `leap-lang.js`; keep the generic parts (gutter, find, buttons, theme).
4. `ide.js`: route Run / Stop / result / lint / export / examples / packages /
   tools through the profile.
5. `src/emulator.js`: keep the safe-point search, BREAK and reset; delegate the
   RAM writes and stack chain to `profile.inject` and the waiting-stop to
   `profile.stopPlan`. Add `setRoms(home, exrom, entry)`.
6. `src/pc-keyboard.js`: take the SYMBOL SHIFT table from the profile.
7. `src/debugger.js`: split into the generic panel (registers, memory, Z80
   breakpoints, breakpoint list) and profile sections (variables, call stack,
   and for Forth the stacks / dictionary).
8. Language selector, `?lang=`, per-language auto-save with migration,
   `lang=` in share links.
9. Tests: `tests/rom-checks.mjs` gets a section per language;
   `tests/browser-smoke.mjs` adds a language switch (BASIC -> C -> BASIC keeps
   both documents).
10. Docs: CLAUDE.md gets a "Languages" section; the BASIC-specific sections stay
    as they are, under BASIC.
11. Rename the IDE to **Leap IDE**: `<title>` and header in `ide.html`, the
    README, CLAUDE.md's title and introduction, the Help overlay. The
    repository and Pages URL (`2068-Leap-IDE`) stay.

### Done when

- With only the BASIC profile, behaviour is unchanged: all 66 Node checks and
  36 browser checks pass, the module fingerprints are current, and the existing
  auto-save and share links still open.
- Stop there and commit before starting either language plan.

## Owner decisions (2026-10-31)

- **Name:** the IDE becomes **Leap IDE**, with a language selector (work
  item 11).
- **Typing at the ROM:** decided per language. BASIC and C keep the rule
  that keys reach the TS2068 only while a program runs; Forth's prompt is live
  all the time (console first; see the Forth plan). The keyboard gate is
  therefore a profile setting.
- **Releases:** Leap-C 1.0 (out of beta before this starts); the Forth build
  that TSRun will carry.
- **Default language** for a first visit: BASIC (what the live site does
  today). After that, the last language used (`leap-ide.lang`).
