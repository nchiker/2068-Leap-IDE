# Leap Arcade Studio completion (item 5): contract

Written 2026-11-12 on branch `arcade-studio-review` (from `main` `1780e98`), before any code. The findings, with their ids, are in the owner's
review doc "Leap Arcade Studio review (item 5)" (https://claude.ai/artifact/UWBj3tv5v7PPd1bTAjn6Ky). The owner agreed to Claude's recommended plan
on 2026-11-12 and added two things: the **backfeeds** (improvements made later that never reached earlier code, section 3) and **validation in the
fastest way possible** (stage 0). The owner also confirmed that Claude may run the `shrink-z80` skill itself (as for the v3 and v4 size passes).

Ids: B bugs, K two blacks, N new project, S / T sprite and tile editors, M map editor, A sound editor, W model editor, R running and debugging,
P project and files, E rough edges (all as in the review doc), plus V (validation speed, stage 0), X (IDE parity), G (games using later words),
Z (the v2 runtime size pass), defined here.

**Not in this contract** (named backlog items, owner 2026-11-12): S1 sprite colour in the game (runtime), T4 animated tiles (runtime, the planned
item), R4 the full source debugger (after R1 to R3). Dropped: A4 (Play on TS2068), K5 (black ink on bright paper stays unflagged).

## 1. Stages and order

Each stage is its own branch from `main` and its own pull request, merged only when the owner says. Every stage ends with the verification of
section 6 and a commit; a stage that changes an example game ends with the game launched in Fuse for the owner.

| Stage | Contents | Why this order |
|---|---|---|
| 0 | V1 to V11: validation speed | every later stage runs the suites many times |
| 1 | the fixes: B1, B2, B4 to B7, K1 to K3, N2, N3, T1, T3, A2, A3, R1, R2, R5, P2, E1 to E4, E6, X1 | small, independent, make the editors usable |
| 2 | Z: the v2 runtime size pass | moves runtime addresses: done before stage 3 so the example games are re-verified once, after both |
| 3 | the games: K4, E5, G1 to G4 | one pass over the same five games, one re-test, one Fuse look |
| 4 | the big four: N1, W1, M2, A1 | build on the fixed editors and the updated games |
| 5 | the medium items: B3, R3, P1, P3, P4, P5, T2 with M3, M4 | |

## 2. Stage 0: validation speed (V)

The design of this stage depends on measurements taken on 2026-11-12 (section 2.1, filled in from the baseline run). Rules that do not depend
on them:

* **V1. One driver for everything.** `node tools/verify.mjs` runs every suite the owner's checklist names (the Arcade `run-all` steps, the Studio
  and editor smoke tests, the model tests, `tests/rom-checks.mjs`, `tests/browser-smoke.mjs`, `--check` of `stamp-modules.py` and
  `publish-runtime.mjs`) in one parallel pool with one summary and per-step times. Today these are run one after another by hand.
* **V2. Choose by what changed.** `tools/verify.mjs --changed [<ref>]` maps the files changed since `<ref>` (default: the branch's merge base with
  `main`) to the steps that read them, from a table in the script (for example `studio.js`, `src/tools/*` -> the Studio and editor tests only;
  `src/lang/arcade/*` -> the compiler, interpreter and differential suites; `arcade/runtime/**` -> everything). A file the table does not know
  selects everything. `--all` is the full run, required before every pull request and every merge.
* **V3. Shard the long steps.** The steps that set the floor of a parallel run (the longest single steps) are split into seed or section
  shards that the pool runs side by side, so the wall time approaches total CPU time divided by the cores. Each shard is reproducible on its own.
* **V4. Do not rebuild what has not changed.** A runtime build is skipped when the hash of its sources and its build script equals the hash
  stored with its last output (`--rebuild` forces it).
* **V5. The default job count is the machine's.** `--jobs` defaults to the number of cores (8 here) when memory allows; the measurement shows
  whether 8 is faster than 4.
* **V6. Same coverage.** Nothing is dropped: every check that runs today still runs in `--all`, with the same counts, and the summary prints
  the totals so a missing step shows. The quick mode (`ARCADE_QUICK`) stays a developer's option and is never what a commit is verified with.

* **V7. v0 and v1 are frozen, not retired.** They were the milestone runtimes of M2 (the first compiled cartridge) and M3 (Breakout's first
  runtime); v2 has every v1 feature, the compiler's `auto` and the Studio pick only v2, v3 or v4, and no example targets them. They get no sample
  game. Their builds and suites stay in `--all` (V6) but, through V2 and V4, are neither rebuilt nor run while their files are unchanged. The trap
  `arcadec --runtime` defaulting to `v0` becomes `auto`.

Target: `--all` at most half of today's wall time; `--changed` for a Studio-only change in under 2 minutes.

### 2.1 Measurements (2026-11-12)

Baseline: `node arcade/tests/run-all.mjs --jobs 4` on `main` `1780e98` (8 cores, 15 GB, nothing else running): **85/85 steps, 14 min 40 s
wall** (the docs said about 9 minutes; it has grown), 57 min 48 s of CPU, 879 s for the suites after the builds. The longest steps, as run under
4 jobs:

| Step | Time |
|---|---|
| `tests/arcade-m10-differential.mjs` | 424 s |
| `arcade/tests/m15-runtime-music.mjs` | 392 s |
| `tests/arcade-m9-differential.mjs` | 389 s |
| `arcade/tests/m7-runtime-perf.mjs` | 212 s |
| `tests/arcade-orbit.mjs` | 205 s |
| `tests/arcade-m11-differential.mjs` | 180 s |
| `tests/arcade-codegen-exhaustive.mjs` | 133 s |
| the next 8 steps | 69 to 110 s each |

So with any number of jobs the run cannot end before the 424 s step; with 8 jobs the CPU total alone gives about 7.2 minutes. Where the time
goes (Node CPU profiles, quick mode):

* **Emulator-based suites** (34 of them boot TSRun): in `m15-runtime-music`, **87 % of the time is `bootMachine`**, the stock ROM booting into
  the cartridge again for every case (up to 400 frames each); and of all emulated time, **39 % is TSRun drawing the screen picture**
  (`videoRunTo` / `paintScreenSpan`) and **19 % advancing the silent AY** (`ayRunSilent`), work no check reads. `m10-differential`: 21 % video,
  12 % AY.
* **Measured:** `TSRun`'s own `setVideoOn(m, false)` in the m2 harness takes `m15-runtime-music` (quick) from **209 s to 125 s** with the same
  21 checks passing. No Arcade test calls `setVideoOn` today.
* Four harnesses do read the drawn screen (`m.pixels`, in `m1.mjs`, `m1-overrun.mjs`, `m2-runtime-common.mjs`, `m3-common.mjs`: which display
  buffer the machine shows); those checks need video on.
* **Interpreter-only suites** (`arcade-orbit.mjs`, 205 s): the time is the reference interpreter (`interpret`, `ev`, scope lookups `find` / `up`,
  `snapshot` per tick).
* Found on the way: `ARCADE_QUICK=1 node tests/arcade-orbit.mjs` crashes in section 8b (`rec` undefined at line 493: the rising-challenge check
  needs more ticks than quick mode gives). Fixed in stage 0.

**Baseline 2 (2026-11-13, detached, `arcade/spike/verify/measure-baseline.sh` at `8967134`):** the suites outside `run-all`, one at a time,
take 161 s together (`studio-smoke` 62 s, `browser-smoke` 48 s, `rom-checks` 23 s, `sound-editor-smoke` 10 s, the rest under 5 s each).
`run-all --full --jobs 4`: **108 min wall, 367 min CPU**, 94 of 100 steps passed. The failures were the test tooling, not the product:
`tile-model`, `map-model` and `arcade-project` still counted seven examples (Orbit Gates is the eighth); six mutants had patterns the
MUSIC and wireframe changes had moved (m4 1, m9 4, m15c 2: they were reported as "bad pattern" / "not run", never run); and m14, m15
and m17 hit run-all's one-hour step limit (239, 92 and 357 mutants run whole inside one step). All fixed on `arcade-verify` (counts and
patterns; m4 got the `--check` mode the others have); the step limit is V3's job (each mutation shard is its own pool step).

Added rules from these measurements:

* **V8. No picture unless a check looks at it.** The harnesses create machines with video off; a check that reads `m.pixels` turns it on for
  its machine (the pixel reader refuses to read with video off, so a forgotten switch fails loudly).
* **V9. Boot once.** The stock ROM's boot is the same for every cartridge until it reads the dock. The harness boots once per runtime with a
  cartridge inserted, snapshots the machine (RAM, CPU, ports, paging, AY, frame counters) at a frame before the ROM first reads the dock, and
  for each case restores the snapshot and swaps in the case's cartridge. Proof test: for every example game and every runtime, the state at
  the cartridge entry (`HO_MARK`) is identical from the snapshot and from a cold boot.
* **V10. The silent AY (needs the owner's approval: a TSRun fork change).** `ayRunSilent` steps the AY's counters one sound period at a time.
  A closed-form advance (same counters, noise and envelope state, checked against the current code over random register histories) removes most
  of that 12-19 %. Pushed to the `nchiker/TSRun` fork before the submodule moves, and it cannot change what TSRun plays (the state is
  identical). Without approval V10 is skipped and the rest still applies.
* **V11. The interpreter.** Profile-guided speedups of `arcade-interp.js` (resolved name slots instead of scope-chain `find` / `up` per access,
  a cheaper per-tick `snapshot`), checked by every differential suite (the interpreter is their reference) and the m17 interpreter tests.

**Projection** (to be measured, not promised): V8 + V9 cut the emulator suites' CPU by half or more; with V3 sharding and 8 jobs, `--all` in
about 5 minutes; `--changed` for a Studio-only change under 2 minutes.

## 3. Backfeeds

Improvements made later that never reached earlier code, found by checking the code (not from memory):

* **X1. IDE parity in the Studio:** Cut / Copy / Paste and Lint buttons in the editor header, as `ide.html` has. (B2 is the other IDE backfeed:
  the BASIC, C and Forth editors keep their block structure in a `StateField`; the Arcade editor recomputes it for every visible line.) Pause /
  Step are R2; the debugger is backlog R4.
* **Z. The v2 runtime size pass** (stage 2). The three runtimes are separate copies of the Z80 source. v4 had a shrink pass (16,147 -> 14,612
  bytes; sprite erases 15-450 T faster), v3 two (and a packed font); v2 had none: `tileops.asm` is 1,085 lines against 944 (v3) and 978 (v4).
  v2 is the tightest runtime (854 bytes free) and runs five of the eight examples plus the wireframe mode. Claude runs `shrink-z80` on v2,
  porting what the v3 / v4 passes did where it applies (shared `tileops` walkers, table-driven boot fills, erase variants falling through into
  each other, the packed font if the boot time allows), Opus for the Z80, in a disposable worktree.
  **Targets:** at least 1,200 bytes freed; no recorded tick slower (`tests/arcade-codegen-perf.mjs --compare`, the `m*-runtime-perf` suites,
  `tests/arcade-m4.mjs`); boot within its frame bound; every suite and the v2 mutation runs green; programs that use no new words compile to the
  same bytes except for moved `RT_*` addresses (`regen-baselines.mjs --old <ref>`); the cross-emulator checks re-run for every v2 game.
* **G. The example games use the later words** (stage 3, with K4):
  * G1 Starfall and Orbit Gates hand-code "fire released, then pressed again" with a `rel` variable: use `KEYPRESS(" ") OR BIT(JOYPRESS(1), 4)`.
  * G2 Blockfall pads its score with three `IF`s in `PSCORE`: use `PRINT ... USING`; Starfall's `score; "  "` likewise.
  * G3 hand-made tick counters (Starfall's game-over wait, Vaults' fire repeat, and any others found) become `TIMER`s. With G1, `TIMER` and
    `JOYPRESS`, today used by no example, are shown in at least one game each.
  * G4 Breakout and Bounce get a title scene and a short song (written as code in their asset generators, as the other songs).
  * Each change must keep the game's behaviour (the game tests compare with the interpreter; a deliberate change of play is named in the
    commit) and should make the code smaller; the size change of each game is reported.

## 4. The items (stages 1, 3, 4 and 5)

The finding and the suggested fix of each id are in the review doc; this section fixes what the doc left open.

### Stage 1
* **B1.** The Studio passes `sprite-model.js`'s `PALETTE` (arrays). The three editors also accept a hex string (one helper). New check in
  `tests/studio-smoke.mjs`: in each of the sprite, tile and map editors, a canvas pixel of a known coloured cell of an example equals the
  palette colour, and the swatches have a background.
* **B2.** The Arcade editor keeps `blockLines` in a `StateField` (as the BASIC editor does); fold, indent and Tidy read it. Test: typing 10
  characters in Vaults produces no long task over 30 ms in headless Chrome (the profile in the review measured 50-80 ms).
* **B4.** After a rename the Studio asks "Also change the N source lines that name it?"; yes rewrites them as one edit (one undo step in the
  open file; other files are changed in the project). B5: the delete question names the lines. B6: a refused auto-save shows a status warning.
  B7 and P4 share a project-wide scan (`buildSource` + its line map).
* **K1.** A compiler **warning** (so the Studio, the problems list and `arcadec` show it): the checker walks each procedure body in text order
  with the constant PAPER and BRIGHT in effect (each scene's INIT and FRAME start at `PAPER 7 BRIGHT 0`, the state the ENTER driver sets; a
  non-constant value makes that colour unknown); at the statement that makes paper 0 and bright 1 hold together it warns: "BRIGHT 1 on black
  paper: TSRun shows it as dark grey next to a black border (Fuse and ZEsarUX show black); use BRIGHT 0 on black paper". A branch is not
  followed (text order only): the warning is a hint, not a proof. Same bytes: warnings do not change code.
* **K2.** The `WIRE3D` and `VIEW3D` checks warn the same way when the clause, or its default, gives black paper (or a black ceiling or floor)
  with BRIGHT 1. **Decision for the owner (Claude recommends yes):** change both defaults to `BRIGHT 0`. That changes the bytes of a program that
  relies on the default (Vaults, fixed in stage 3 anyway; `WIRE3D` has no example relying on it); baselines are regenerated with
  `--accept-codegen-change`.
* **K3.** New tile warning `bright-black-paper` (a tile with paper 0, BRIGHT 1 and at least one paper pixel), one finding per tile set listing
  the tiles, marked on the tiles in the tile editor; `black-bright-mix` stays for sets that mix the two.
* **N2.** After `+` on an asset kind, a confirm "Add `SPRITE name = "name"` to main.arc?" (the declaration word per kind; one edit). N3: "Press
  Run (F5)" under the display until the first Run of the session.
* **T1.** A warning shows as one line (its first sentence) with a "details" toggle; the same component in the map editor. T3: Duplicate tile set;
  `project.flagNames` (optional, 8 strings) shown in the tile editor and the map editor's Flags view, validated by `validateProject`.
* **A2.** Keyboard piano in the sound editor: Z S X D C V G B H N J M (lower octave) and Q 2 W 3 E R 5 T 6 Y 7 U (upper), only while the editor
  has focus and no field is being typed in; plays the note with the current instrument; with "enter" mode on, writes it at the cursor (the
  existing note entry). A3: presets coin, jump, step, door, shield, chime, plus "Copy from example" listing the examples' 41 effects.
* **R1.** Under the display while a game runs: `FRAMERATE n: m fps now, budget used p %, worst tick w refreshes, k ticks over budget`, from
  `V_TICKS` and the frame counter sampled once a refresh. R2: Pause (F8), Step one tick (F10), Continue, speed ½× / 1× / 2×; the keyboard and
  joystick are not sent while paused. R5: "Save screen" (PNG of the 256 x 192 screen plus border, as shown).
* **P2.** Save in place with the File System Access API where the browser has it (the handle kept for the session; the first Save asks for the
  place), the download otherwise.
* **E1 to E4, E6** as the doc says. **X1** as section 3.

### Stage 3
* **K4.** Starfall, Vaults, Blockfall, Leap Runner (both) use BRIGHT 0 on every black-paper area, in code and tiles; Vaults' `VIEW3D` gets
  `BRIGHT 0` (or relies on the new default). The colour choices keep each game's look as close as the hardware allows (a bright colour becomes
  its plain version). After the change no example gives a K1, K2 or K3 warning.
* **E5.** Leap Runner's and Vaults' background-attribute warnings are resolved (tiles marked "sprites never pass over" or colours unified,
  Claude's choice per tile, listed in the as-built notes); every example opens with no warnings.
* **G1 to G4** as section 3.

### Stage 4
* **N1. Starters.** `src/arcade-starters.js` (pure, Node-importable): `STARTERS = [{id, title, about, runtime, make() -> project}]`, assets built
  by code. Six: blank, sprites-tiles, scenes-music, platformer, raycaster, wireframe (contents in the review doc). New opens a dialog (title, one
  line, runtime, a screenshot made with R5 and committed under `arcade/dist/starters/`). Every starter: under 150 lines of commented source,
  compiles with no warnings, is a game with a goal (owner's rule for samples: a clear goal, live controls, a rising challenge, a score), and
  follows the two-blacks rule.
* **W1. Model editor.** `src/tools/model-model.js` (pure: points, edges, add / move / delete, join, mirror, centre, scale, rotate 90, presets,
  limits, history) and `src/tools/model-editor.js` (UI: top, front and side views and the turning preview of `model-preview.js`); a Models tab in
  the right panel; `ASSET_EDITORS.models`. Limits and checks as `validateAsset('models')` and the model checks. Tests: `tests/model-model.mjs`,
  `tests/model-editor-smoke.mjs`, a Studio block.
* **M2. Object layer.** `assets.maps.<name>.objects = [{kind, x, y, props?}]` (cells or pixels per the map's role) and
  `project.objectKinds = {name: {colour, sprite?, props: [names]}}`. The Studio generates the read-only source file `objects.arc` (one
  `TABLE <map>_objects` per map that has objects: for each kind the arrays `<kind>x`, `<kind>y`, one per property, and the count `n<kind>`,
  each kind's objects sorted by x; optionally a bucket index per kind every N pixels, the spatial index scrolling games need). It is rewritten on
  every change and cannot be edited in the code editor. Leap Runner's level tables are rebuilt from object layers on its four worlds; the as-built
  notes list any column its generator computed that the object layer does not express, and how the game now gets it.
* **A1. Note view.** In song mode, a note lane per channel: notes as bars on a pitch grid (the pattern's ticks across), derived from the
  pattern's records by the inverse of `noteRecords` (a run of records that `noteRecords` would write for one note is shown as that note; anything
  else as raw ticks, still editable in the lanes). Click places a note of the current instrument and length; drag moves or lengthens; Delete
  removes; all through `enterNote` / `enterRest`, so the stored song format does not change.

### Stage 5
B3 (the diagnostics compile in a Web Worker; Run and DCK keep the page's compile), R3 (the compiler reports variable addresses; a Variables tab),
P1 (projects in IndexedDB, the current project still mirrored in `localStorage` for compatibility), P3 (one editor state per file), P4 (with B7),
P5 (Help examples from `ARCADE_LANGUAGE.md`, per-word anchors, a "How a game is built" page), T2 with M3 (picture import: a shared
`src/tools/picture-import.js`, error-diffusion as the plan's art pipeline says, two colours per cell), M4 (the floor plan's 3D preview from the
JS reference of `arcade/tests/m8-common.mjs`, moved into `src/`).

## 5. Sample games (owner's rule: every improvement used in the sample games, each new feature shown off)

| Stage | Sample |
|---|---|
| 0 | none (tooling); the per-step times are recorded in the as-built notes |
| 1 | the examples open in the editors in colour (B1); R1's meter shown on Vaults, the game that runs over its budget; K1 to K3 fire on today's games (the warnings are the proof that stage 3 is needed) |
| 2 | the v2 games (Bounce, Breakout, Starfall, Blockfall, Orbit Gates) on the smaller runtime, same play, same or better tick times |
| 3 | Starfall, Vaults, Blockfall and both Leap Runners in one black; `KEYPRESS` / `JOYPRESS` / `TIMER` / `USING` in Starfall, Orbit Gates, Blockfall and Vaults; Breakout and Bounce with a title scene and a song. All launched in Fuse for the owner |
| 4 | the six starters are small games themselves (one per game type); Orbit Gates' models open and edit in W1; Leap Runner's levels come from M2's object layers; one example song re-entered in A1's note view plays the same bytes |
| 5 | a starter's title screen made by picture import (M3); Vaults' floor plan shown in M4's preview |

## 6. Verification (every stage)

After stage 0: `node tools/verify.mjs --changed` while working, `node tools/verify.mjs --all` before each commit that changes behaviour and
before the pull request. Until then the checklist of `docs/ARCADE_NEXT_SESSION_PROMPT.md`. Mutation runs (4 shards) for new pure modules and new
compiler / runtime code. `python3 tools/stamp-modules.py` after any `.js` change, `node arcade/tools/publish-runtime.mjs` after a runtime or
example change. Agents' claims are re-run by Claude in the real tree.

## 7. Agents

Sonnet for implementation with disjoint file ownership (Studio shell; each editor; compiler checks; examples; test tooling), Haiku for running
suites, Opus for the Z80 of stage 2. Claude writes the designs and decisions, reviews every change and commits with explicit paths.

## 8. Decisions made here, for the owner's review

**Approved by the owner on 2026-11-13:** 1 (the stage order), 2 (both 3D defaults become `BRIGHT 0`) and 8 (the silent-AY change in the TSRun fork). Items 3 to 7 stand as written unless the owner says otherwise.

1. Order of the stages (section 1), with the v2 size pass before the game changes.
2. K2: both 3D defaults become `BRIGHT 0` (recommended).
3. K1 is a compiler warning following text order only (no branch analysis).
4. M2 generates a read-only `objects.arc` rather than writing into the user's own files.
5. A1 shows notes only where the records are exactly what note entry writes; other ticks stay raw.
6. P1 keeps `leap-studio.project` in `localStorage` as a mirror of the current project, so older pages still find it.
7. V7: v0 and v1 are frozen (kept and tested, but only when their files change), not deleted; `arcadec --runtime` defaults to `auto`.
8. V10: a closed-form silent AY advance in the TSRun fork (identical state; needs the owner's approval, as every fork change does).
