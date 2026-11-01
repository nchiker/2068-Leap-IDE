# Plan: one IDE for Leap V2 BASIC, Leap-C and Leap-Forth

Status: updated 2026-11-01. **Stage 0 is done** (2026-11-01, commit `3ed5d3b`;
see "Stage 0: what was built" below); no second language exists yet. Both ROM
projects have answered the IDE's questions
([`requests/LEAP_C_ANSWERS.md`](requests/LEAP_C_ANSWERS.md),
[`requests/LEAP_FORTH_ANSWERS.md`](requests/LEAP_FORTH_ANSWERS.md)).
2068-Forth v2.0 is released (2026-11-01, with its manual and cartridge build);
Leap-C is at `v1.0.0-beta.2` and proceeds on it.

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

Order (owner, 2026-11-01): **stage 0 (this document, done), then Forth and
Leap-C**, both unblocked, **Forth first**.

Why Forth first, and why this changes the earlier recommendation (Leap-C
first, as it is closer to V2 and most patterns carry over): on 2026-10-31
Leap-C was to wait for its 1.0 release and Forth had no stable build. Since
then 2068-Forth v2.0 has been released (tag `v2.0`, commit `50170f2`) with its
manual (184 word entries in the shape the IDE asked for), the IDE hooks the
Forth project added (`LAST_ERROR`, `EDITOR_LOOP_LIVE.enter` / `.key_ret`,
`INTERPRET_NESTED.token`) and its cartridge build (`make cart`,
`forth_cart.dck`), and the TSRun fork already carries those ROMs (`11731e1`).
Leap-C is still at `v1.0.0-beta.2`; the owner has since lifted the rule that
Leap-C work starts after 1.0 ("Leap-C can move forward also", 2026-11-01), so
it proceeds on beta.2 and moves to 1.0 later by regenerating the ROM entry and
data. Only its cartridge (C9) waits, for Leap-C's own `make cart`, which is in
progress. Forth is the one language whose release, manual and cartridge are all
complete, so it goes first; the two plans do not depend on each other, and
Leap-C can follow or overlap it.

---

## What is already in place

- The pinned TSRun submodule (`016787f`) already carries `roms/leapc-0.rom` /
  `leapc-1.rom` and `roms/leapforth-0.rom` / `leapforth-1.rom`. The Leap-C pair
  is byte-identical to Leap-C `v1.0.0-beta.2` (`043becf4…` / `97fe9523…`), so
  Leap-C needs no submodule move to start. The pin's Forth pair (`760a5ce3…` /
  `2add175c…`) is an older build. **For Forth the TSRun pin must move to
  `11731e1`**, the fork's `main`, which carries exactly the Forth v2.0 ROMs
  (`forth_boot_rom0.bin` `730c86d0…`, `graphics_exrom.bin` `fd877dd0…`) as
  `leapforth-0.rom` / `leapforth-1.rom`, with the Leap V2 and Leap-C ROMs
  unchanged (stage F0 of the Forth plan; not done yet).
- All three ROMs use the 16K HOME + 8K EXROM split and Leap V2's kernel I/O
  (copied, not shared), so `IO_READ_KEY.wait_hit` exists in each as the idle
  point, and the "single-step to a safe point, inject, jump" approach of
  `src/emulator.js` applies to all three.
- Language-neutral today: the emulator host (except the inject step), display
  and zoom, sound, the run/pause/step machinery and its `setWatch` hook, the
  debugger's registers, memory inspector and Z80 breakpoints, files and
  auto-save, share links, themes, the Help overlay's frame.
- **The cartridge test** (added 2026-10-31; CLAUDE.md "Cartridge test"): the
  emulator's `testCartridge(dck)` runs any `.dck` on the stock TS2068 ROMs, and
  Open accepts a `.dck`. The test itself knows nothing about the language; only
  *building* a cartridge from the editor's program (⬇ DCK, ▶ Test DCK) is
  BASIC-specific today (see "The cartridge test across languages" below).

## What assumed BASIC (before stage 0)

This table is the state before commit `3ed5d3b`; the paths are the old ones.

| Where | What |
|---|---|
| `src/editor.js:42-45` | Imports `leap-lang.js` directly: language mode, `LEAP_WORDS`, `NOT_IN_V2`, `keywordEntry`, `scanSymbols`, `keywordTokens`, `nameTokens`, `blockStructure`, `blockIndent`. Completion (`leapComplete`), hover help, auto-caps, folding, indent, block match, go to definition, rename all sit on these. |
| `ide.js` | `prepareSource` / `encodeSource` (V2 line store), `injectProgram`, `showRunResult` (compile / VM error codes), `describeError` + `LEAP_*_ERRORS`, `packageFor` / `loadPackages`, `exportTape` / `exportCartridge`, `UNTITLED = 'untitled.leap'`, the Examples menu. |
| `src/emulator.js` | `inject()` writes the V2 line store and pushes the V2 return chain; `stop()` knows V2's command loop; `loadRoms` fetches `tsrun/roms/leap-*.rom`; `leaveCartridge` puts back "the Leap ROMs" (`emu.romImages`), which must become the active profile's ROMs. |
| `src/leap-roms.js` | One flat table of V2 entries. |
| `src/leap-check.js` | V2 compile chain and error cells. |
| `src/leap-debug.js`, `src/debugger.js` | V2 VM line table, variables, call stack; the panel's Variables / Call stack sections. |
| `src/pc-keyboard.js` | V2's SYMBOL SHIFT table. Leap-C and Forth changed it (they type `[ ] { } \| ~ ^ \`). |
| `src/help.js` | Reads `leap-keywords.js`, V2 groups and the V2 manual link. |
| `src/tools/udg.js`, `draw.js` | Generate BASIC (`POKE`, `PLOT`, `LINE`). |
| `src/files.js` | `tapeToText` accepts only V2 tapes (`$81xx`). |

## Stage 0: what was built (done 2026-11-01, commit `3ed5d3b`)

The design below was implemented with BASIC as the only profile; with it,
behaviour is unchanged (rom-checks 75 = 66 + 9 profile checks, browser-smoke
42 = 41 + the auto-save migration check). CLAUDE.md "Languages (language
profiles)" is the reference for what exists; the profile shape is documented in
the header of `src/lang/profiles.js`. Where the implementation differs from the
design that follows:

- **Layout.** `src/lang/profiles.js` (not `profile.js`) holds `PROFILES`,
  `profileById`, `profileForFile`, `profileForTape` and the shape comment. A
  language is split in two modules: `src/lang/<id>/profile.js` (no DOM or
  CodeMirror; Node imports it) and `src/lang/<id>/editor.js` (the CodeMirror
  half), registered in `src/lang/editors.js` (`LANGUAGE_EDITORS`). There is no
  `editorExtensions()` on the profile. BASIC's word tables were also split out
  of `leap-lang.js` into the CodeMirror-free `leap-words.js`.
- **Field names differ** from the table below: `romFiles {home, exrom}` +
  `knownRoms` + `romHint` + `romLabel` (not `romName`); `driver {safe,
  runState, inject, stopWaiting, result}` (replacing `inject`, `stopPlan` and
  `readResult`; `stopWaiting` returns true if it ended the wait itself, false
  to press BREAK); `createDebugAdapter(rom)` (not `debug`); `keyboard {symbols,
  always}`; `symbolGroups(text)` / `symbolsEmpty` (not `symbols`); `help` (not
  `helpEntries` / `manualRef`); `tools {udg, draw}`, `hasTape`, `hasCartridge`,
  `waitingText`, `ownsTape(bytes)`.
- **`attach()` returns the per-ROM half.** `prepare`, `createChecker`,
  `describeError`, `exportTape`, `buildCartridge` and `extensionsUsed` are not
  profile fields: `profile.attach({rom, romImages, fetchAsset})` binds the
  profile to the loaded ROM pair and returns `lint(text)`, `startRun(text)`,
  `describeResult(...)`, `progInfo(bytes)`, `exportTape(text, name)`,
  `buildCartridge(text, ui)` (optional) and, for BASIC, `checker` and
  `packageFor`. `ide.js` keeps it as `lang` and re-attaches after a switch.
- **Work item 7 (debugger)** was done as a **debug adapter** (`setAdapter`;
  `reset`, `observe`, `position`, `isStart`, `lineOf`, `breakPositions`,
  `stopLine`, `halt`, `variables`, `callStack`, `labels`), not as separate
  profile sections of the panel. The panel's registers, memory, Z80
  breakpoints and breakpoint list stay generic; a Forth adapter will have to
  supply its stacks / dictionary through the same shape (extending it if
  needed).
- **Emulator.** `setProfile(profile)` loads the profile's ROMs into the existing
  machine and resets (not `setRoms(home, exrom, entry)`); `leaveCartridge`
  restores the active profile's ROMs.
- **Done as planned:** the `?lang=` URL parameter, `leap-ide.lang`,
  per-language auto-save with migration, `&lang=` in share links, the
  selector (`#lang-select`, hidden while only one profile exists), Open
  switching language by extension or tape, the profile's SYMBOL SHIFT table
  in `src/pc-keyboard.js`, the rename to **Leap IDE** (work item 11).
  `window.leapIDE` now exposes `lintSource`, `setStatus`, `switchLanguage`,
  `emulator`, `profile` and `lang` (`encodeSource` is gone).
- **Not done in stage 0** (belongs to the language stages): the cartridge
  test's keyboard table picked from the cartridge's own signature, per-language
  `cartridge/<lang>/<version>/` directories (BASIC's still live in
  `cartridge/2.1.0-emu.1/`), and the language-switch browser test with a
  second language.

## Stage 0 design: a language profile (as planned; implemented as above)

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
| `lineLimit` | 127 for BASIC and C; 128 for Forth (`EDIT_MAX_LEN`) |
| `helpEntries`, `manualRef` | For the Help overlay |
| `prepare(text)` | Text -> `{bytes, lineMap, problems}` (what to write into RAM, editor line mapping, storage errors) |
| `inject(machine, rom, prepared, extra)` | Write RAM and set up the jump; called by the emulator at the safe point |
| `stopPlan` | What Stop does when the program waits (V2: jump to the command loop; Leap-C and Forth: BREAK alone ends every wait) |
| `readResult(machine, rom)` | `{kind: finished/compile/runtime/break, code, line, column?}` |
| `describeError(result)` | Status-bar and diagnostic text |
| `createChecker(rom, images)` | Editor error check (`check(text) -> {code, line, column?}`) |
| `debug` | Line table hooks, variables / stack readers, extra panel sections |
| `keyboard` | The SYMBOL SHIFT table for `src/pc-keyboard.js` |
| `exportTape(text, name)` | *optional* |
| `buildCartridge(text)` | *optional*: the program as a `.dck` (BASIC's `buildProgramCartridge` in `ide.js` today). ⬇ DCK and ▶ Test DCK appear only for a profile that has it |
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
- Switching language during a cartridge test ends the test first (as Stop
  does), then loads the new profile's ROMs.
- Remembered: the last language (`leap-ide.lang`).

### The cartridge test across languages

- **Stays in the core**, not in a profile: `testCartridge` / `leaveCartridge`,
  the stock ROMs, Open `.dck`, the `'cartridge'` state, the debugger's
  cartridge mode (Z80 breakpoints, Pause, registers, memory).
- **Open `.dck` works in every language** and does not switch language: a
  cartridge carries its own runtime and does not need the IDE's ROMs.
- **Leaving a test restores the active profile's ROMs** (today it restores
  the Leap V2 pair it booted with).
- **Keyboard in a test:** a cartridge runs its own runtime's key decoding,
  and Leap-C and Forth changed the SYMBOL SHIFT table. The test therefore
  picks the table from the cartridge itself: each cartridge build's program
  image starts with its own signature, read from the DOCK when the `.dck` is
  inserted: V2's `"LEAPPROG"` in chunk 3; **Forth's `"F1"` at DOCK `$4000`
  (chunk 2)**, with the LROS header `00 01 <entry> DC` at `$0000`; Leap-C's is
  to be defined by its build (`make cart`, in progress; its program image is
  planned for DOCK chunks 4-5). An unknown cartridge gets V2's table.
  This works the same for Open `.dck`, whatever the active language.
- **Building a cartridge** is a profile's `buildCartridge`. **All three
  languages get one** (owner, 2026-10-31): BASIC has it today; Leap-C and Forth
  need a runtime cartridge build of their ROM first (stage C9 of the Leap-C
  plan, F8 of the Forth plan). Forth's is built and released (v2.0:
  `forth_cart.dck`, `make cart` in the Forth repository), so the IDE only packs
  the program into it; Leap-C's `make cart` is in progress. Until a
  language's build exists, its ⬇ DCK and ▶ Test DCK say so, as BASIC does for
  a release without one.
- **The cartridge builds' images** live per language and release, like
  today's `cartridge/2.1.0-emu.1/`: `cartridge/<lang>/<version>/` (BASIC's
  directory moves under `basic/`), each with the identity check of
  `src/cartridge.js` (`romIdentity` of the IDE's ROMs = the cartridge's).

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
   `profile.stopPlan`. Add `setRoms(home, exrom, entry)`; `leaveCartridge`
   restores whatever `setRoms` last installed. The cartridge test stays as it
   is.
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

- With only the BASIC profile, behaviour is unchanged: all the old Node checks
  and browser checks pass (now 75 and 42, with the cartridge test's five), the
  module fingerprints are current, and the existing auto-save and share links
  still open. **Done 2026-11-01.**
- Stop there and commit before starting either language plan. (Done: committed as `3ed5d3b`.)

## Owner decisions (2026-10-31)

- **Name:** the IDE becomes **Leap IDE**, with a language selector (work
  item 11).
- **Typing at the ROM:** decided per language. BASIC and C keep the rule
  that keys reach the TS2068 only while a program runs; Forth's prompt is live
  all the time (console first; see the Forth plan). The keyboard gate is
  therefore a profile setting.
- **Releases:** *superseded 2026-11-01*: Forth is the v2.0 release that the
  TSRun fork (`11731e1`) carries; Leap-C proceeds on `v1.0.0-beta.2` and moves
  to 1.0 later (its work no longer waits for 1.0).
- **Order (2026-11-01):** stage 0, then Forth and Leap-C (both unblocked),
  Forth first; the reasons are under "Order" at the top. Only Leap-C's
  cartridge (C9) waits, for its `make cart` build.
- **Cartridges:** Leap-C and Forth get a runtime cartridge build, as Leap V2
  has, so every language can make a `.dck` for a stock TS2068.
- **Default language** for a first visit: BASIC (what the live site does
  today). After that, the last language used (`leap-ide.lang`).
