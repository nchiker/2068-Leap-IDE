# Leap Arcade: bankable per-level tables, contract for slices T1-T5 (2026-11-11)

Binding for runtimes v2, v3 and v4, the compiler (`src/lang/arcade/`), the linker, the Studio and the tests. It answers "What B5 showed"
in `docs/ARCADE_BANKING_CONTRACT.md`: per-level object tables are array initialisers in the code, so a game with many levels runs out of
mapped room although its bank window is nearly empty (Leap Runner: mapped 16,342 of 16,384, banked 1,670 of 16,384). Programs that use
none of the new words compile to the same game-area bytes as before. Style as `ARCADE_LANGUAGE_BATCH5.md` and the banking contract.

Owner decision that starts it (2026-11-11): this item next, built on the existing 16 KB bank window. Earlier decisions still bind: banking is
automatic (the language never says where data lives), chunk 6 (bank C) comes later, chunk 7 never, the emulators are the test ground.

## 1. Why the existing window is enough (the change from the space plan)

The space plan and the banking contract tied "a copy" to bank C (DOCK chunk 6) and `RT_BANKCOPY`, because chunk 6's consumers must copy
into the working RAM that chunk 6 hides. A table's destination is the game's **variable block** (`GAME_VARS`, RAM chunk 7: `$E200` up in
v3 / v4, the v2 equivalent in its `layout.inc`), which no DOCK chunk ever covers. So a table record can be copied **straight out of the
`$4000-$7FFF` window** by one runtime routine that maps the window around an `LDIR`, exactly like the B1 loaders read a map in place.
No bank numbers, no staging RAM, no chunk 6. Bank C stays "later" and is not needed for this.

## 2. Language

```
TABLE name                  declaration (game level, or among a SCENE's declarations); ends with ENDTABLE
  target = value, value ... one row per target: an array (all its values) or a numeric variable (one value)
ENDTABLE
LOADTABLE name              statement: copy every row of the table into its target
LOADTABLE expr              statement: the table with that index (section 2.3); an index outside the list does nothing
```

Example (Leap Runner's level data, shortened):
```
SCENE play
  DIM cxs(49), cys(49), sx(10), ncoins, startx
  TABLE level1
    cxs = 64, 72, 80, 96
    cys = 104, 104, 104, 88
    sx = 160, 288
    ncoins = 4
    startx = 24
  ENDTABLE
  TABLE level2
    ...
  ENDTABLE
  PROC LOADLEVEL():
    LOADTABLE lv            ' lv is a variable: the index form (level1 is 0, level2 is 1, ...)
    ...
```

### 2.1 Declaration rules (checker; each with its own message, line and column)
1. `TABLE` stands where a `DIM` may stand at the game level or in a `SCENE`, never inside a `PROC`. `ENDTABLE` closes it; a missing one is an
   error at the `TABLE`. Inside, only rows (and `REM` lines / blank lines) are allowed.
2. The name follows the identifier rules and must not clash with any other name of its scope (variables, arrays, `CONST`s, `PROC`s,
   `DEF FN`s, `MAP`s, `SFX`, sprites, scenes, other tables), with the duplicate-name message the checker uses for those. A scene's table may
   share a name with a table of another scene (scopes as batch 4).
3. A row's target is a numeric scalar variable or a numeric array (1-D or 2-D) **declared in the table's scope** (the scene's own names and
   the game level's; a game-level table sees the game level only). Not a `CONST`, not a `PROC` parameter or `LOCAL`, not a string. `TIMER`
   variables are allowed (they are ordinary slots). Unknown target: "TABLE name: X is not a variable or array of this scope".
4. Values are constant expressions (`CONST` names allowed), folded exactly as `DIM` initialisers fold them (same range and wrap rules).
   An array row has 1 .. (number of elements) values, in the element order of `DIM` initialisers (2-D: row-major as B1-5); a scalar row
   has exactly one value.
5. A target appears at most once in a table. A table has at least one row.
6. At most 256 tables in a program (all scopes together).

### 2.2 Meaning
`LOADTABLE t` writes every row of `t`: an array row sets the listed elements to the values and **every element past the last listed value
to 0** (a level with fewer coins never sees the previous level's leftovers); a scalar row sets the variable. Variables and arrays the table
does not name keep their values. Nothing else happens: no sprite, screen, sound or scene change. `ENTER` does not load any table (it clears
the scene's variables and copies its `DIM` initialisers, as now); a game loads its level's table where it starts the level.

### 2.3 Which table (`LOADTABLE`)
1. **A bare name** that is a table visible in the statement's scope loads that table (game-level tables are visible everywhere; a scene's
   tables in that scene). Since a table name cannot clash with a variable (2.1 rule 2), a bare name is never ambiguous.
2. **Any other expression** (a variable, `lv + 1`, a number) is an **index** into the statement's **visible list**: the game-level tables in
   source order, then (in a scene) that scene's tables in source order, numbered from 0. Evaluated as a signed 16-bit value; below 0 or past
   the end: nothing happens (as `PLAY expr`). A constant index outside the list is a **warning** (not an error), and the statement compiles
   to nothing. In a scope with no visible table, `LOADTABLE expr` is an error.
3. With a runtime older than v2: "LOADTABLE needs the v2 runtime (or later)". A runtime build without `RT_TABLELOAD`: an error that says to
   rebuild the runtime (as the banking contract's `RT_LOADMAPPTR` message).

## 3. The table record (image format)

```
DB runs                      1..255
runs x { DW dst, DW len, len bytes }     dst = a slot address in GAME_VARS; len = bytes, even, >= 2; the words little-endian
```
The compiler turns the rows into runs: each row is the slot range of its target (array: all its n + 1 elements, zero-padded past the
listed values; scalar: 2 bytes); the ranges are sorted by address and **joined only when exactly adjacent** (never across a gap: the slots
between belong to variables the table must not touch, unlike `DIM` initialisers which may join over zeros at init). More than 255 runs
after joining is an error at the `TABLE` (it needs more than 255 separate targets). The same record is used whether the table is mapped
or banked; the compiler emits the same call either way.

## 4. Runtime (slice T1; v2, v3, v4)

**`RT_TABLELOAD`**: HL = a table record (mapped `$8000-$BFFF` or banked `$4000-$7FFF`). For each run: `LDIR` `len` bytes to `dst`.
When H is in `BANK_LO..BANK_HI-1` it calls `bank_on` first and `bank_off` last (the B1 helpers; the window is mapped for the whole
record, not per run); otherwise it reads the record where it is. Clobbers AF, BC, DE, HL; preserves IX, IY and the alternate registers
(no `EX AF,AF'` / `EXX`: keep the run count on the stack). Interrupts stay enabled.

1. **Banking rules 1-5** of `ARCADE_BANKING_CONTRACT.md` section 2 apply. Rule 2 holds because every `dst` / `len` lies inside the game's
   variable block (chunk 7); that is the **compiler's** guarantee (section 3), the runtime does not check it.
2. **Placement in the runtime image:** appended at the end of the last source file before `RT_END` (v2 `tileops.asm`, v3 `scroll.asm`,
   v4 `ray.asm`), so **no existing `RT_*` or internal address moves** and the game area of every existing program stays byte-identical.
   The runtime bytes change (the routine is new), so the DCK hash baselines are regenerated with
   `node arcade/tools/regen-baselines.mjs --old <the commit before T1>` (it cross-checks the old and the new compiler first).
3. **Budget:** about 30 bytes each (free now: v2 7,021, v3 2,075, v4 1,785). More than 60 is reported, not shipped silently.
4. **Cost:** about 21 T per byte copied + a small fixed cost per run and per call (+ `bank_on` / `bank_off` when banked). Measure and write
   the figures into the as-built notes (Leap Runner's level table: about 400 bytes, so about 9,000 T, inside one refresh).

## 5. Compiler and linker (slices T2, T3)

1. **Parser** (`arcade-parse.js`): `TABLE` gives a declaration node `{type: 'Table', name, rows: [{target: Ident, values: [expr]}]}` (with
   the usual `line` / `col`; each row and value keeps its own position) in the `decls` of the game or the scene; `LOADTABLE` gives
   `{type: 'LoadTable', table: Ident | null, index?: expr}`, mirroring `Play` (a bare unparenthesised name goes in `table`; the checker
   turns it into an index when it is not a table). Words `TABLE`, `ENDTABLE`, `LOADTABLE` in `arcade-words.js` (help text, kind).
2. **Checker** (`arcade-check.js`): section 2.1 and 2.3 rules. **Interpreter** (`arcade-interp.js`): section 2.2 / 2.3 semantics, so the
   differential tests compare it with the compiled game tick by tick.
3. **Code generator** (`arcade-codegen.js`): `LOADTABLE name` = `LD HL,record / CALL RT_TABLELOAD` (6 bytes). The index form: evaluate to
   HL, then a shared helper `lib$tabidx` (present only when used) with DE = the scope's pointer list (`DW record` per visible table, in the
   mapped code) and the list length: out of range (unsigned compare, so negatives fail too) returns, else loads the pointer and jumps to
   `RT_TABLELOAD`. A header comment block "Tables" (as B5-1 .. B5-4) records the decisions.
4. **Placement** (`arcade-bank.js`, `generate` in `arcade-codegen.js`): every table record is a bankable candidate,
   `{key: 'table:<scope>.<NAME>', name, kind: 'table', data, override: 'auto'}`, in the same automatic order as maps, worlds and plans
   (overrides first, then largest first, only while the mapped part does not fit; `bankAll` banks them too). There is **no per-table
   override** in this batch (tables are code, not project assets: the project document has no place for one; it can be added later with a
   `tables` map in the project document). A mapped record lies in the mapped part after the WORLD streams; `layoutOf` counts it (a new
   field, **not** `tablesBytes`, which is the v3 scroll tables).
5. **Usage and messages:** `usage` gets a `tables` figure (mapped bytes) and each banked table appears in `gen.bank.banked` with kind
   `'table'` and its `why`. The "does not fit" message names tables like the other parts.
6. Programs with no `TABLE` produce exactly the game-area bytes they do today (checked against the baselines).

## 6. Editor and Studio (slice T4)

* Editor (`src/lang/arcade/editor.js` and `arcade-scan.js`): highlighting of the three words; `TABLE` ... `ENDTABLE` folds and indents as a
  block; completion after `LOADTABLE` offers the visible tables; hover help from the word table; the Symbols tab lists tables (with their
  line); go to definition on a table name.
* Studio size panel: a banked table shows as one row of the Banked bar (`table level2 · 312 · auto`), mapped tables count in the Mapped bar
  ("tables N").

## 7. Example (slice T5): Leap Runner on tables

`arcade/examples/runner.arc`: the level data become four `TABLE level1` .. `level4` (printed by `runner.assets.gen.mjs --data`, spliced
between the existing markers), each with **level-relative** lists (the absolute index arrays `LCB` / `LSB` and the per-level offsets go),
sized to the largest level; `LOADLEVEL` does `LOADTABLE lv`. The freed mapped room is reported (before / after). Then the owner decides
whether the levels get more coins and enemies with it. The play-through test (`tests/arcade-runner.mjs`) passes on the interpreter and
TSRun, equal every tick, normal and `bankAll`; the cross-emulator comparison (TSRun, ZEsarUX, Fuse) is repeated with at least one level
change, as B5.

## 8. Tests

* **T1 runtime:** new `arcade/tests/m12-runtime-table.mjs` (in `run-all.mjs`) and `m12-mutations.mjs` (in `--full`): v2, v3, v4; a mapped and a banked record;
  1 run and 255 runs; `len` 2 and about 2,000; an interrupt after every instruction of `RT_TABLELOAD` on a banked record; registers
  preserved (IX, IY, alternates), `$F4` and `V_SHADOW_F4` back to `F4_PLAY`; the whole 64 KB compared before / after: only the destination
  bytes (and the interrupt's own variables) changed, DOCK chunks unchanged, display files unchanged. Mutation run of the new code.
* **T2 / T3 compiler** (`tests/arcade-m12-compiler.mjs`, `tests/arcade-m12-differential.mjs`, both in `run-all.mjs`): parser and checker positives and negatives for every rule of section 2 (one test per message); record bytes for
  a scalar, a 1-D, a 2-D, adjacent targets (joined) and separated targets (not joined); the index form (in range, negative, past the end,
  constant warning); differential interpreter vs compiled on the real runtimes (the batch 4 / 5 harnesses), every case also with
  `bankAll`; baseline programs byte-identical in the game area; `regen-baselines.mjs` after T1.
* **T4:** `tests/studio-smoke.mjs` sees a banked table row; editor smoke for highlighting and symbols.
* **T5:** section 7.
* Full battery before each commit (`ARCADE_NEXT_SESSION_PROMPT.md`): `node arcade/tests/run-all.mjs`, the Studio and model suites,
  `tests/rom-checks.mjs`, `tests/browser-smoke.mjs`; `python3 tools/stamp-modules.py`; `node arcade/tools/publish-runtime.mjs`.

## 9. Not in this batch

* **Banked `DIM` initialisers** (the ones `ENTER` / init copy): they could use the same record and `RT_TABLELOAD`; not needed once the
  per-level data are tables (Leap Runner's remaining initialisers are small).
* **Per-table override** in the project document (section 5 item 4).
* **Bank C (chunk 6), `RT_BANKCOPY`, banked sound effects, `MUSIC`**: unchanged from the banking contract section 9.
* **String tables** (no string arrays in the compiler yet).

## As built: slices T1-T4 (2026-11-11, commit `c84b238`)

* **T1 (runtimes):** `RT_TABLELOAD` is 34 bytes in each runtime, appended before `M_TILEOPS_E` (v2), `M_SCROLL_E` (v3) and in `ray.asm`
  after its `raybb.asm` include (v4). Every pre-existing symbol kept its address (349 / 556 / 643 symbols compared; only `RT_END` moved).
  Free bytes after: **v2 6,987, v3 2,041, v4 1,751**. Two improvements on section 4: the run count stays in A (nothing in the loop touches
  it), and a record with 0 runs returns at once. Measured (TSRun, all three the same): 21 T per byte, 105 T per extra 2-byte run, a
  1-run 2-byte record 162 T mapped / 295 T banked (banking a constant +133 T). Tests: `m12-runtime-table.mjs` 12 checks (about 17,800
  interrupts per runtime at every instruction boundary, half with the window mapped; whole-64 KB compare), `m12-mutations.mjs` 96 of 96 killed.
* **T2 / T3 (compiler):** as sections 2, 3 and 5. Decisions made: `lib$tabidx` takes HL = index, DE = list, BC = count (15 bytes); the
  layout field is `tableRecBytes`; `usage.tables` exists only when the game has tables; keys `table:game.NAME` / `table:SCENE.NAME`, a
  scene table's display name `scene.name`; a v0 / v1 runtime refuses `TABLE` as well as `LOADTABLE`; extra checker errors for a PROC
  parameter / LOCAL / FOR variable named like a visible table and for `LOADTABLE (tablename)`; TABLE / LOADTABLE may still name an asset
  (old projects build); a table banks without `RT_LOADMAPPTR`; records of unused tables are still emitted. A single table is capped in
  practice by the variable RAM (about 3.8 KB). Tests: `tests/arcade-m12-compiler.mjs` 189 checks, `tests/arcade-m12-differential.mjs` 21
  (120 random v2 programs and 30 each on v3 / v4, normal and `bankAll`, 255 runs, 256 tables); 138 of 138 baseline compilations
  identical to the previous compiler (after T5, runner.arc has tables and is left out: 132 of 132 against `84acdec`; that section needs
  `ARCADE_OLD=<git archive of the previous src>/src/lang/arcade` and is skipped without it, as in m11). Hash baselines regenerated (`regen-baselines.mjs --old 84acdec`: 16 hashes, runtime bytes only).
  `run-all.mjs` now runs the m10, m11 and m12 compiler and differential tests too (they were missing): 69 steps.
* **T4 (editor, Studio):** `arcade-scan.js` returns `tables`; TABLE ... ENDTABLE folds, indents and tidies as a block; completion after
  `LOADTABLE` offers the visible tables; go to definition and rename; a "Tables" group in the Symbols tab (`profile.js`); the Studio's
  size table has a "Tables" row (mapped bytes) and a banked table is a Banked-bar row (`banked: table level1 (3,609 bytes, auto)`, the map
  rows' format). `tests/studio-smoke.mjs` 92 checks (12 new).
* **T5 (Leap Runner on tables):** `runner.arc` keeps its level data in four tables `lv1` .. `lv4` (not `level1` ..: those are the MAP
  names, and a table name may not clash), printed and spliced by `runner.assets.gen.mjs --data` / `--splice`, level-relative, the counts
  `ce` / `se` as scalar rows; `LOADLEVEL` does `LOADTABLE lv`; `LCB` / `LSB` and the per-level offsets are gone. Arrays are sized to the
  largest level, so each record is 343 bytes. Sizes (runtime v3): **mapped 16,342 -> 16,131** of 16,384, banked 1,670 -> 2,013 (the four
  worlds + `play.lv1`; `lv2` .. `lv4`, 1,029 bytes, stay mapped because the policy banks only until the mapped part fits); with every table
  banked the mapped part is 15,102, so about **1,280 bytes of mapped room** are now available for more content; variable slots 711 -> 376
  (1,422 -> 752 bytes of RAM); code 10,486 -> 9,246. Gameplay unchanged: the recorded 1,762-tick play-through gives the same level entry
  ticks (21, 452, 883, 1306), flags (413, 844, 1267) and final state (score 4,530, 1 life) as the previous version (checked by running the
  old test in a worktree of `c84b238`). `tests/arcade-runner.mjs` 57 checks (it now reads the TABLE blocks). Cross-emulator:
  `ARCADE_HARDWARE_NOTES.md` section 13.
