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

### 2.2 As built (stage 0, 2026-11-14, branch `arcade-verify`)

* **V1, V2, V4, V5, V7:** `tools/verify.mjs` with the steps in `arcade/tests/steps.mjs` (run-all imports the same lists). `--all`: every suite
  (the run-all steps, the Studio / editor / model tests, `rom-checks`, `browser-smoke`, the perf checks incl. `arcade-codegen-perf --compare
  arcade/spike/codegen/perf-reference.json`, the AY and boot proof tests), `stamp-modules.py --check`, `publish-runtime.mjs --check`, every
  mutation suite's `--check`, and the mutation shards of the suites whose mutated code, own file or tests changed since the merge base (the
  owner's rule: mutation runs for new code). `--all --full`: every mutant. `--changed [ref]`: an import graph plus a rule table. Runtime builds
  are skipped by input hash; jobs default to the cores; the longest known steps start first (`arcade/build/verify-times.json`). `arcadec
  --runtime` defaults to `auto`. Decision (Claude): `--all` without `--full` runs mutation shards for changed code only; the 84-minute full run
  is for branches that change the runtimes, the harnesses or TSRun (this one did, and ran it).
* **V3:** every mutation suite is N shard steps (m17 33, m15 15, m14 12, ...); m9 and m10 differential are 4 shards each (shard 0 also runs
  the other sections; run whole they are unchanged, output identical).
* **V8, V9:** `arcade/tests/fast-boot.mjs` (video off unless a check reads the screen through `pixelsOf`; the stock ROM booted once per process
  to the start of frame 98, where it first writes port $F4 / $FF, then restored per case). Proof `arcade/tests/boot-snapshot.mjs`: 121 checks,
  cold boot = snapshot at the cartridge entry and 50 frames on, every example and runtime. TSRun has no contention or raster stall, so video
  off does not change timing (the codegen perf compare passed against a reference saved before the change).
* **V10:** TSRun `89208e8` "AY: closed-form silent advance" (`ay.js` only): all but the last 120 ticks of a silent span jumped
  arithmetically; chip state bit-identical, the analogue filter within 2.2e-16. Proof `tests/tsrun-ay-silent.mjs` (114,916 checks). AY alone
  25-28x faster.
* **V11:** interpreter: memoised upper-casing, names cached on AST nodes (non-enumerable), snapshot templates; records identical.
  `ARCADE_QUICK` arcade-orbit no longer crashes.
* **Found and fixed on the way:** three model tests counting seven examples (Orbit Gates is the eighth); seven mutants never run since MUSIC /
  wireframe moved their patterns (all re-run and killed); m14 / m15 / m17 never finished inside run-all's one-hour step limit; a stale perf
  reference (re-saved at main's runtimes); two timing checks that failed under 8 parallel jobs (page-ready waits now 60 s; the 20 ms asset
  check takes the best of tries spread over 2 s).

**Measured (8 logical CPUs, 8 jobs):**

| Run | Before | After |
|---|---|---|
| every suite (the old checklist: run-all + hand-run suites + perf checks) | about 19.5 min (run-all 14:40 at 4 jobs + 2:41 + about 2:10) | **10.2 min** `--all` (125 steps, 121,946 checks) |
| every suite + every mutant | 108 min, and m14 / m15 / m17 never finished | **84 min** `--all --full` (all 1,448 mutants accounted for) |
| a Studio-only change | the whole checklist | **63-68 s** `--changed` |
| a game cartridge in TSRun (Node) | 22-27 MT/s (8-9x real time) | 41-47 MT/s (14-16x) |
| m15-runtime-music, CPU | 216 s | 29 s |

Against the targets: `--changed` under 2 minutes is met; `--all` is 52 % of the old time (target "at most half": just over). The run is now
bound by total work (4,688 s of step time / 8 jobs), not by one step; the next cuts would be `m7-runtime-perf` (380 s), `arcade-codegen-
exhaustive` (320 s) and `arcade-orbit` (290 s, now TSRun-bound in its sections 9-12).

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
* **Z as built (stage 2, 2026-11-14, branch `arcade-v2-size`):** `runtime (chunks 0-1)` 15,378 -> **12,935** bytes (**-2,443**, target 1,200);
  `RT_END` `$3CAA` -> `$328A` (3,446 free after it). Details: `ARCADE_RUNTIME_API_V2.md` "As built: size pass", per change `arcade/spike/v2size/`.
  Every target met: no measured figure slower except boot-only code (m4 worst tick 105,930 -> 103,772 T; `arcade-codegen-perf --compare` passes;
  Orbit Gates' worst play tick 340,848 -> 334,812, ticks over budget 29 -> 22); boot 11 -> 10 frames (bound 14); the font not packed (not
  needed); compiled programs equal except the moved `RT_*` addresses (10 hashes, `regen-baselines.mjs --old c985065`). **Verified:**
  `verify --all` 188/188 steps, 122,216 checks, the six changed suites' mutants 756 killed + 15 equivalent, 0 survivors (each worker's own run
  covered every v2 mutant: m17 377 killed + 11 equivalent); Orbit Gates on TSRun, ZEsarUX and Fuse: all 315 ticks identical (screens byte for
  byte, state at 73 sampled ticks). **Owner, 2026-11-14:** `--all` instead of `--all --full` (the extra mutants are those of v3, v4 and the
  compiler, unchanged) and Orbit Gates alone for the emulator check (the only change with a new hardware-facing part: RCPT in RAM); no Fuse
  launch this stage (no game changed; stage 3 launches them all).
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

#### As built (stage 1, 2026-11-14, branch `studio-stage1`)

All stage 1 items are done. Sonnet agents built them with disjoint files, Claude reviewed and re-ran every suite, and a Haiku agent ran `verify --all`.
* **B1.** `paletteRgb(entry)` in `sprite-model.js` reads `[r, g, b]`, `'#rrggbb'` or `{rgb}`. `keyRGB` goes through it, so all three editors accept either form, and the Studio now passes `PALETTE`. New canvas-pixel checks in the three editor smokes and `studio-smoke`. They fail on the old `keyRGB` (checked).
* **B2.** The Arcade editor keeps its block structure in a `StateField`. `tests/arcade-editor-perf.mjs` types 10 keys in Vaults and asserts no key handler or long task over 30 ms (best of 3; Chrome's long-task observer starts at 50 ms, so it also reads Event Timing). Measured with the old editor: 34-66 ms.
* **B4-B7.** Rename asks "Also change the N source lines that name it?" (one edit in the open file; other files are changed in the project). The delete question names `file:line` (first three). A refused auto-save shows a warning. Symbols lists all files and opens the right one (the joined source and its line map; `symbols.js` is unchanged).
* **K1.** `arcade-check.js` `startColour` / `trackColour`. Scene and game-level INIT / FRAME start at PAPER 7 BRIGHT 0. Other PROCs start unknown, which cannot change any warning (a warning needs both colours set by the body). Values are folded with `cfold`.
* **K2.** Both defaults are `BRIGHT 0` (`VIEW_DEFAULTS`, the WIRE3D default in the codegen, interpreter and `scanRoles`). Only Vaults relies on a default: its DCK differs from the previous compiler's in exactly the 2 view attribute bytes (`$45`/`$4D` -> `$05`/`$0D`). Starfall, Blockfall and both Leap Runners compile to identical bytes and only gain warnings. `regen-baselines --accept-codegen-change HEAD --dry-run`: 23 programs equal the interpreter, 0 records changed (Vaults is in no hash baseline). The byte-identity sections of `arcade-m11`, `arcade-m15` and `arcade-m17` give a VIEW3D / WIRE3D with no BRIGHT clause an explicit `BRIGHT 1` for both compilers (`pinOldBright`), so they still cover every program byte for byte (98, 30 and 70 compilations, all identical).
* **K3.** `bright-black-paper` (field `tiles`). A set that also mixes the two blacks reports both findings.
* **Today's games fire them (the stage 1 sample).**

  | Game | K1 | K3 |
  |---|---|---|
  | Starfall | 3 | 16 / 16 tiles |
  | Vaults | 4 | 28 / 28 tiles |
  | Blockfall | 6 | 3 / 12 tiles |
  | Leap Runner (platformer and runner) | 4 each | none |
  | Bounce, Breakout, Orbit Gates | 0 | 0 |

  The R2 speed check passes if any of 5 attempts gives a 2× / 1× frame ratio in [1.5, 2.6] (a loaded page cannot emulate 120 frames a second). Every test that expected "no warnings" from an example now allows only this warning, marked `TWO-BLACKS ALLOWANCE (stage 1 K1; remove in stage 3, K4)`, and so does `publish-runtime --check`. **Stage 3 removes every allowance** (`grep -rn "TWO-BLACKS ALLOWANCE"`).
* **Mutants.** `arcade/tests/m18c-mutations.mjs` (K1-K3): 72 mutants, 69 killed, 3 equivalent (documented in the file), 4 shards.
* **N2.** `P.DECLARATION_WORD` (`SPRITE TILESET MAP SFX MUSIC MODEL`) and `P.addDeclaration` insert the line after the last declaration of that word.
* **N3.** "Press Run (F5)" shows until the first Run.
* **T1.** `src/tools/warning-list.js` (`createWarningList`) shows the first sentence plus a details toggle, in the tile and map editors.
* **T3.** `project.flagNames` (8 names, 1-12 printable characters; a bad value is dropped with a warning, not refused). Host `flagNames()` / `setFlagNames()`. A rename button per flag in the tile editor, a legend in the map editor's Flags view. ⧉ Duplicate works on every asset row.
* **A2.** The keyboard piano uses the note row's octave for Z..M and one octave higher for Q..U. It always plays. The new "keys enter" box (off by default, remembered) also writes the note through `enterNote`.
* **A3.** Six more presets, and "Copy from example" (host `exampleEffects()`: 41 effects from 7 games).
* **R1.** The meter is fed by emulator `onFrameDone`. A tick lasts from one `V_TICKS` increment to the next, measured in refreshes. A tick is over budget when it is longer than `V_DIV` = 60 / FRAMERATE. "fps now" counts the ticks of the last 60 refreshes (TSRun refreshes at 60.12 Hz). Vaults: 15 fps most of the time, 9-12 in some windows, worst tick up to 20 refreshes, 1 -> 6 ticks over budget in 27 s.
* **R2.** Emulator `holdFrames` / `stepFrame` / `setSpeed` (additive; the IDE calls none of them). A hold clears the keys and the joystick and silences the audio. Sound is muted at speeds other than 1×. Step runs to the next `V_TICKS` (at most 120 frames).
* **R5.** "Save screen" writes `<project>-screen.png`, 320 × 240, from TSRun's pixel buffer in the shader's palette.
* **P2.** File System Access save in place, with the handle kept for the session. The download is the fallback.
* **E1-E4, E6, X1.**
  * E1: long names, with the details on a second line and in the tooltip.
  * E2: the screen controls moved to a row of their own, the tab strip scrolls, and nothing overflows at 1280 or 1600 px.
  * E3: the problems list folds (with a count) and resizes.
  * E4: plain wording, and only the setups that are built.
  * E6: as listed in the review doc.
  * X1: Cut / Copy / Paste / Lint.

### Stage 3
* **K4.** Starfall, Vaults, Blockfall, Leap Runner (both) use BRIGHT 0 on every black-paper area, in code and tiles; Vaults' `VIEW3D` gets
  `BRIGHT 0` (or relies on the new default). The colour choices keep each game's look as close as the hardware allows (a bright colour becomes
  its plain version). After the change no example gives a K1, K2 or K3 warning.
* **E5.** Leap Runner's and Vaults' background-attribute warnings are resolved (tiles marked "sprites never pass over" or colours unified,
  Claude's choice per tile, listed in the as-built notes); every example opens with no warnings.
* **G1 to G4** as section 3.

#### As built (stage 3, 2026-11-15, branch `studio-stage3`)
Five Sonnet agents in disposable worktrees (one per game group, patches kept in `arcade/spike/stage3/`), one for the shared tests, one for the
cross-emulator tools; Claude reviewed each diff and re-measured. Every example now compiles with no warning and no asset finding; every
`TWO-BLACKS ALLOWANCE` is gone. The comparisons with an older compiler (m11 / m15 / m17 compiler tests) and with the old fixtures in
`arcade/tests/fixtures/` keep a permanent, documented filter for the two-blacks warning: the older compiler has no such warning and the fixtures
are historical.

| Game | Items | Choices | Code bytes |
|---|---|---|---|
| Leap Runner (platformer, runner) | K4, E5 | HUD `BRIGHT 0` on black. Tile 14 (blank cloud band) takes the sky's attribute. `fg` on the mountains and clouds (only a jump from the top plank reaches them) and on spikes, coins, pole and flag: a sprite over one is being hurt, paid or finishing, so its brief change of ink is **an accepted colour change** (the art rules already said so), not a claim that no sprite passes | 7,179 / 9,095, unchanged |
| Blockfall | K4, G2, G3 | Every black attribute `BRIGHT 0` (tiles 0-8, 10, 11, six code spots): the blocks are plain colours now. `PSCORE` with `USING "0000"`. `wt`, `ft` as `TIMER`s; `gcnt`, `ldly`, key-repeat counters stay (they pause or reset conditionally) | 10,033 -> 10,180 (`lib$fmt` +179) |
| Vaults | K4, E5, G3 | All 28 tiles `BRIGHT 0`; tiles 1-27 `fg` (the panel's sprites are billboards inside the view; the title's sprites stay over blank cells). `inv`, `cool`, `bt`, `mt` and the demo's `left` as `TIMER`s. Play identical tick by tick | 11,205 -> 11,187 |
| Starfall | G1, G2, G3 | Game over: `KEYPRESS(" ") OR BIT(JOYPRESS(1), 4)` after a 21-tick `TIMER`; score and wave right-aligned with `USING`; `inv`, `cool`, `spt` as `TIMER`s; the blink by `BAND(inv, 2)` (Claude: the agent's `inv MOD 4` ran a division every tick, ~900 T) | 11,741 -> 11,896 (`lib$fmt`) |
| Orbit Gates | G1, G3 | Title and game over by `KEYPRESS` / `JOYPRESS`; `inv`, `fl`, `cd`, `sb`, `ow`, `bl` as `TIMER`s (`lz` replaced by `cd > 3`). Fire held from power-on now starts at once (KEYPRESS counts a key held at boot) | 8,263 -> 8,212 |
| Breakout, Bounce | G4 | A `title` scene each (name, PRESS FIRE TO PLAY; Breakout draws three brick rows), a song written with `songs.mjs` in new asset generators (Bounce 4 bars C-Am-F-G, 4.3 s; Breakout 8 bars D minor, 8.5 s), `NOMUSIC` in play; Bounce is no longer v0-only (MUSIC needs v2) | 414 -> 1,449 (song 758); 1,338 -> 3,481 (song 1,805) |

Deliberate changes of play: a fire pressed during a game-over wait no longer counts (a fresh press is needed); Orbit's title blink is one tick
later; Starfall's game-over numbers are right-aligned. **Time** (`tests/arcade-codegen-perf.mjs`, reference re-saved): medians +77 (platformer),
+41 (Vaults), +112 (Blockfall), +657 T (Starfall: the `KEYPRESS` / `JOYPRESS` snapshot, `RT_KEYDOWN` + `RT_STICK` every tick in every scene, is
~600 T of it), Runner -16; no tick newly over budget; Orbit faster (median 195,360 -> 194,268, worst 340,848 -> 335,463, over budget 29 -> 23).
The size goal ("should make the code smaller") is met by Vaults and Orbit, not by Blockfall and Starfall, where `lib$fmt` costs more than the
code it replaces. **Cross-emulator:** Starfall (fine pipeline, keys, script, joystick) TSRun = ZEsarUX at all 347 ticks, Fuse shows every
picture; Breakout (now pressing fire to leave its title) TSRun = ZEsarUX, Fuse shows ticks 1-60; `fine-compare.mjs` leaves out only the
joystick-only bytes (`JS` and the KEYPRESS / JOYPRESS slots). `shooter-scenario-make.mjs` was broken before stage 3 (its still phase ended
before game over) and is fixed.

### Stage 4
* **N1. Starters.** `src/arcade-starters.js` (pure, Node-importable): `STARTERS = [{id, title, about, runtime, make() -> project}]`, assets built
  by code. Seven: blank, sprites-tiles, scenes-music, platformer, raycaster, wireframe (contents in the review doc), and **fine-colour** (owner,
  2026-11-15: "N1 should also include hi color like our recent examples": a v2 game whose scenes are 8 x 1 colour, `scenes.<n>.display = 'fine'`,
  art drawn with `arcade/examples/fineart.mjs`'s method, within the fine rules: at most 32 sprite phases, about 7 moving 16 x 16 sprites at 20 Hz). New opens a dialog (title, one
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

#### As built (stage 4, 2026-11-16, branch `studio-stage4`)
Six Sonnet agents in disposable worktrees (N1 in two halves, W1, A1, M2 in two halves: M2a the source / project / Leap Runner side, M2b the map editor),
briefs kept in `arcade/spike/stage4/briefs/`; Claude reviewed every diff, re-ran every suite in the main tree, wired the Studio and wrote the Studio-level
checks (`tests/studio-smoke.mjs`: the starters dialog, the Models tab, the object layer on Leap Runner).

* **N1. Starters** (`src/arcade-starters.js` composes `src/starters/starters-a.js` and `starters-b.js`; the dialog is `#new-dialog` in `studio.html`,
  opened by New; stills `arcade/dist/starters/<id>.png`, README there). Seven, each a game with a point, under 150 lines of commented source, no warning,
  no asset finding, BRIGHT 0: **Star Dash** (blank, v2: steer a ball to a star against a clock), **Gem Mine** (sprites-tiles, v2: 12 gems, TILEAT walls, pooled
  bats, four sound effects), **Arrow Rush** (scenes-music, v2: title / play / over, a title song, a session best), **Coin Hop** (platformer, v3: WINDOW,
  80 x 16 world, NOWINDOW title, a stompable walker), **Gem Maze** (raycaster, v4: 16 x 16 plan, three gem billboards and a ghost), **Ring Run** (wireframe, v2:
  WIRE3D, two models of 12 edges or fewer so they open in the model editor), **Rainbow Gold** (fine colour, v2: both scenes `fine`, 58 of 128 tiles, 5 of 32
  phases, 99.7 % of play ticks at 20 Hz). Tests: `tests/arcade-starters-a.mjs` (46 checks) and `-b.mjs` (68): a bot plays each on the interpreter, the real
  runtime replays it, every tick equal; Rainbow Gold's real screen equals `finePicture` on every compared tick. FRAMERATE 12 for the two 3D starters.
  *Findings that cost time:* `WALL` and `NEXT` are reserved words; names cannot contain an underscore; `CLS` clears to ink 0 so a sprite over cleared cells is
  black on black (the starters fill the cells with `PAPER 0 : INK 7 : FILLC` instead); `ENTER` neither stops a song (`NOMUSIC` in the scene's INIT) nor reloads a
  `WINDOW` world (`WORLD level` in INIT). The New dialog falls back to the classic blank project when the starters module cannot load. Existing Studio
  tests that clicked New now pick the Blank starter (project "Star Dash").
* **W1. Model editor** (`src/tools/model-model.js` 500 lines pure, `src/tools/model-editor.js`; Models tab; `ASSET_EDITORS.models`). Top, front and side views plus
  the turning preview; add / move / delete points, join, mirror mode, centre, scale, rotate 90, presets (cube, pyramid, ring of n, dart ship, rock), live
  limits, undo. Choices: an edit that would leave no point or no edge is refused; scale is refused (not clamped) past 64 or when two points would meet.
  Orbit Gates' four models round-trip unchanged. 127 model checks (12,000 random edits keep every model valid), 91 editor checks. Selecting a model in the
  project panel opens the Models tab (it used to say there was no editor). The right panel's tab padding was tightened so seven tab names fit at 1280 px.
* **M2. Object layer.** *Data:* `assets.maps.<name>.objects = [{kind, x, y, props?}]` in **pixels** (the contract said cells or pixels; the editor snaps to
  1 / 4 / 8 / 16), `project.objectKinds = {name: {colour 0..15, sprite?, props[]}}` (at most 16 kinds, 8 props, names `[a-z][a-z0-9]{0,11}`),
  `project.objectBucket` (128 default, 0 = no index). *Source:* `src/arcade-objects.js` generates the DIMs and one TABLE per map with objects. **Deviations
  from the first design, forced by the language:** table names cannot contain an underscore, so `pf_world` is table `pfworldobjects` (lower case, non-alphanumerics
  removed, a clash gets a number); the generated text goes **first** in the joined source (a game-level DIM must precede the scene that reads it; a declaration
  before `GAME` is legal); a kind no map uses is not declared. A game's own source declares none of `<kind>x`, `<kind>y`, `<kind><prop>`, `<kind>ix`,
  `n<kind>` or the table names. *Compile:* `compile()` is the single front door (`completeSource`), so the Studio, `arcadec`, `publish-runtime` and the test
  harness give identical cartridge bytes (tested for Leap Runner); a project without objects compiles byte for byte as before (the batch hash baselines did
  not move; only `m19-nonfine-baseline.json`'s four Runner entries did). *Studio:* `objects.arc` is listed first, marked "generated", with no rename / delete
  button, read-only in the editor (`leapEditor.setReadOnly`), rewritten on every change, and `objects.arc` is a reserved file name (an older stored file of that
  name becomes `objects-user.arc` with a warning). *Map editor:* an Objects layer (key O) with a kind palette, a Kinds panel, place / drag / nudge / delete,
  a property box, the list in table order (`coin #3`), counts, hide / show; resizing a map moves objects that would fall off its edge to the last column /
  row after asking; the host provides `getObjectKinds`, `setObjectKinds`, `renameObjectKind`. 187 map-model checks, 179 editor checks, 99 `arcade-objects` checks.
* **M2 sample: Leap Runner's level tables are object layers** on its four worlds (kinds `coin {}`, `enemy {lo, hi}` where `hi = 0` is a bat, `checkpoint {}`);
  `runner.arc` has no level data; the generator writes the objects into `runner.assets.json`. Columns the old generator computed that an object layer does
  not express: **`cix`** is now the generated `coinix` (same numbers); **`wlo` / `whi`** (a walker's turning points, found from the map by `turning()`) are the
  enemy's props; **`rcf` / `rnx`** (first coin / first enemy at each respawn) are no longer stored: `RESPAWN` sets `cf = 0` (SPINCOINS' skip loop finds the
  coin in the same tick) and runs a short enemy loop for `nx`; the start (24, 88) stays a constant. *Cost:* mapped part 16,323 -> 16,056 of 16,384 bytes
  (328 spare, was 61), banked 2,636 -> 3,001 (the table record grew 343 -> 365 bytes: `enemyix`, `checkpointix` and `ncheckpoint` are generated for every kind,
  there is no opt-out), median tick 130,030 -> 130,054 T, level loads +462 T. *Play unchanged:* old and new game equal on the interpreter at every tick of the
  1,738-tick recorded play-through and on five off-route respawn runs. **Trap:** `ix(b)` ignores object width, so a game with wide objects starts one bucket early.
* **A1. Note view** (`notesOfTrack` in `music-model.js`, a Notes panel above the tick lanes of the sound editor in song mode). The inverse of `noteRecords`
  shares its per-record function, so they cannot drift; a note is claimed only where `noteRecords` reproduces the exact records, anything else is a grey
  raw strip (decision 5). Edits go only through `enterNote` / `enterRest` (`placeNote`, `replaceNote`, `removeNote`), one `setAsset` and one undo step each.
  Proofs: 61,360 note cases invert exactly; all 13 example songs show whole (1,614 notes, no raw tick) and re-enter note by note to an identical image;
  in the browser `bounce / theme` is re-entered into a blank pattern by 68 real clicks and its `convertMusic` image is identical to the original's.
  **Changed behaviour:** the peak box accepts 0..15 (0 is a silent note that keeps its pitch, how the examples write rests; typing 0 used to become 1). Ambiguous
  readings (1 tick of organ at peak 3 reads as pluck; a drum from C0 to G#0 is one record) re-enter to identical ticks.
* **Traps:** (1) the New dialog made every Studio test that clicked New need `newBlank()`; (2) Leap Runner's camera check in `studio-smoke` is wall-clock based
  and failed once under eight parallel jobs; (3) the example named `platformer` is the one-level game, `runner` is the four-level one with the object layers;
  (4) `git status` in an agent worktree shows `tsrun` as type-changed: it is the symlink.

### Stage 5
B3 (the diagnostics compile in a Web Worker; Run and DCK keep the page's compile), R3 (the compiler reports variable addresses; a Variables tab),
P1 (projects in IndexedDB, the current project still mirrored in `localStorage` for compatibility), P3 (one editor state per file), P4 (with B7),
P5 (Help examples from `ARCADE_LANGUAGE.md`, per-word anchors, a "How a game is built" page), T2 with M3 (picture import: a shared
`src/tools/picture-import.js`, error-diffusion as the plan's art pipeline says, two colours per cell), M4 (the floor plan's 3D preview from the
JS reference of `arcade/tests/m8-common.mjs`, moved into `src/`).
**S1. Gallery strip** (owner, 2026-11-16: in Starfall's Sprites tab only one sprite is visible; the editor edits one asset at a time and the others are in a drop-down and the project panel): a row of small thumbnails of every asset of the tab's kind (sprites, tile sets, maps, models) at the top of each of those four editors, the edited one highlighted, a click selects it; one pure helper for the thumbnails (`src/tools/asset-thumbs.js`) and a check per tab. Do it first: it is small and makes every game's art visible at a glance.

#### As built (stage 5, 2026-11-16, branch `studio-stage5`)
Seven Sonnet agents in disposable worktrees (S1, B3, R3, P1, P5, T2 + M3, M4, and the title-screen stills), briefs in `arcade/spike/stage5/briefs/`; Claude reviewed every diff,
re-ran every suite in the main tree, wired the Studio (`studio.js`, `studio.html`, `studio.css`, `src/editor.js`) and wrote the Studio-level checks (`tests/studio-smoke.mjs`).
* **S1. Gallery strip** (`src/tools/asset-thumbs.js` pure, `src/tools/asset-gallery.js` the shared strip, one `renderGallery()` per editor): a row of thumbnails of every
  sprite / tile set / map / model at the top of the four editors, the edited one highlighted (`current`), a click selects (what the drop-down does; the project panel does not
  follow), drawn lazily and cached by the asset's JSON so only the edited picture is redrawn. A map without its tile set is drawn in greys. 61 px high.
* **B3. Diagnostics in a Web Worker** (`src/arcade-check-handler.js` pure, `-worker.js`, `-client.js`; `compileWithBuilds` / `loadBuilds` in `src/lang/arcade/profile.js` are
  the ONE compile the page and the worker run). The worker gets `{project}` (not the joined source), answers everything the panels read except `dck` and `map` (it adds
  `runtimeLabel`, `variables`). Vaults: the main thread's longest gap while checking 15-17 ms with the worker against 297-485 ms compiling on the page. Studio wiring:
  `analyzeInWorker()` (the debounced path), `analyze({full: true})` is the page's own compile for Run and DCK (a worker result has `viaWorker` and no cartridge). **Found by
  the Studio test:** CodeMirror's `forceLinting` only hurries a lint that is already due, so the marks never updated after a late worker answer; `leapEditor.relint()` now
  dispatches a `relintEffect` (the linter's `needsRefresh`). **Trap:** a worker does not see the import map, so its modules load by plain URL (a second, unstamped copy of the
  compiler's modules; cached up to 10 minutes by Pages): the fingerprint check in `studio-smoke` ignores them, a stale worker only means older marks (Run always compiles on the page).
* **R3. Variables** (`out.variables` of `compile()`, `collectVariables` in `arcade-compile.js`; `gen.locals` in the code generator, report only: the compiled bytes are identical on
  41 outputs). Every value is a 16-bit signed integer in a 2-byte slot at `GAME_VARS_BASE + 2 * i`; entries: DIM'd variables and arrays of the game and each scene, TIMERs, the
  parameters and locals of every generated PROC / DEF FN (a callable nothing reaches has no storage and is not listed). The panel (`variables-model.js`, `variables-panel.js`)
  decodes the machine's memory; the Studio tab is called **Vars** (eight tab names no longer fit 1280 px with "Variables"; padding and letter spacing were tightened too),
  refreshes five times a second while running and once at each pause, and lists the running cartridge's own build (`runBuild`). The test compares the values decoded from the
  real runtime's RAM with the interpreter's on four games tick by tick (274,400 + 6,000 + 1,500 + 3,000 values) and mutation-checks the addresses.
* **P1. Projects list** (`src/arcade-store.js` IndexedDB with an injectable factory, `src/arcade-projects-session.js` the current-project logic, `src/tools/projects-dialog.js`). The
  open project is saved to the list before another replaces it: New, an example and an opened file give a new entry (examples and files are named uniquely, "X 2"), nothing is lost
  and the "discard changes?" question is gone (it stays for a browser without IndexedDB). `localStorage` `leap-studio.project` is still written first at every save (older pages and
  the page-unload path), the id is kept beside it in `leap-studio.project-id`. A failed list write warns once and loses nothing. **`studio.html?nolist=1`** switches the list off
  (the single-project path, used by the older checks of `studio-smoke`; the P1 block runs with it on). The Studio's New / Open are asynchronous now: tests wait for `leapStudio.opens`.
* **P3. One editor state per file** (`saveState()` / `restoreState()` in `src/editor.js`, `fileStates` in `studio.js`): undo, cursor and folds survive a file switch; a state is
  shown again only when its text is still the file's text (a rename of an asset can rewrite a closed file).
* **P4. Project-wide go to definition, hover and rename** (`setProjectContext` in `src/lang/arcade/editor.js`): the definition is looked up in the joined source and its line map;
  F12 / Ctrl+click opens the file; F2 renames in every editable file (other files are rewritten through the project, so that part is not one undo step of the open editor;
  `objects.arc` is refused as generated). **B7** was already done in stage 1 (Symbols tab over all files).
* **P5. Help** (`tools/gen-arcade-help.mjs` -> `src/lang/arcade/arcade-help-data.js` GENERATED; `arcade-help-examples.js` hand-written: 90 examples, 24 aliases and the page "How a
  game is built"; `help.pages` in `src/help.js`, backward compatible). Every example and page code block is compiled by `tests/arcade-help-data.mjs` in a wrapper that declares
  the standard assets and variables. The docs' own code blocks are syntax outlines, so the examples are all curated; the data holds each word's section anchor (many words share
  a section: the language document has few per-word headings). **11 words have no example because the compiler refuses them** ("not supported yet": END TAB FLASH PLOT POKE OUT LEN PEEK IN USR POINT);
  the test fails if the compiler starts accepting one.
* **T2 + M3. Picture import** (`src/tools/picture-import.js` pure engine, `picture-import-ui.js` the shared panel): two colours per 8 x 8 cell (or per 8 x 1 row in fine mode),
  serpentine Sierra-lite error diffusion (or ordered / none), identical and inverted cells merged, the 128-tile limit reported with a nearest-cell merge ("needs N tiles, M cells
  merged"), the two-blacks rule kept (a BRIGHT pair never holds black). Tile editor: Import picture (append / replace / new set, one undo step) and Export PNG (1x to 8x); map editor
  (cell maps only): 256 x 192 picture -> tile set + 32 x 24 map. `pictureToAssets(img, opts)` is the Node entry for a starter. Imported tiles are marked `fg` by default in the map
  editor (a picture has many attributes, which would warn `background-attr-mix`). 89 engine checks.
* **M4. Floor-plan 3D preview** (`src/tools/raycast-ref.js` moved out of `arcade/tests/m8-common.mjs`, which re-exports it unchanged: the m8 runtime suites are green; `floorplan-view.js`
  pure, `floorplan-preview.js`): under the plan of a floor plan, the view the runtime draws from any cell and direction (click a cell, turn, walk with collision). The test compares the
  preview with the real v4 runtime's screen on 36 poses of 7 maps and with the m8 reference byte for byte. INK is not read from the source (white).

## 5. Sample games (owner's rule: every improvement used in the sample games, each new feature shown off)

| Stage | Sample |
|---|---|
| 0 | none (tooling); the per-step times are recorded in the as-built notes |
| 1 | the examples open in the editors in colour (B1); R1's meter shown on Vaults, the game that runs over its budget; K1 to K3 fire on today's games (the warnings are the proof that stage 3 is needed) |
| 2 | the v2 games (Bounce, Breakout, Starfall, Blockfall, Orbit Gates) on the smaller runtime, same play, same or better tick times |
| 3 | Starfall, Vaults, Blockfall and both Leap Runners in one black; `KEYPRESS` / `JOYPRESS` / `TIMER` / `USING` in Starfall, Orbit Gates, Blockfall and Vaults; Breakout and Bounce with a title scene and a song. All launched in Fuse for the owner |
| 4 | the seven starters are small games themselves (one per game type, fine colour included); Orbit Gates' models open and edit in W1; Leap Runner's levels come from M2's object layers; one example song re-entered in A1's note view plays the same bytes |
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
