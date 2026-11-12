# Wireframe 3D in runtime v2 (`WIRE3D`), contract, 2026-11-12

Item 4 of the owner's order (`docs/ARCADE_NEXT_SESSION_PROMPT.md`; the owner confirmed on 2026-11-12: the wireframe game first,
then the Studio review, then the showcase game). Branch `arcade-wire` from `main` `f82442d`. Binding; "As built" notes are added
when each slice is done. **Owner's rule: every improvement is used in the sample games, and each new feature has a sample game
that shows it off** (section 9 is not optional).

Source of the numbers: the spike `arcade/spike/wire/RESULTS.md` (measured on TSRun, 33,892 pictures equal to a bit-exact JS
reference). Its recommendation, section 6: **a mode inside v2, not a new runtime**: about 4.7 KB of code and constant tables,
no self-modifying code, v2's tick model (draw into the hidden file, then flip), its text, sound and input reused.

## 0. What v2 has (checked for this contract)

* **ROM room:** `RT_END` = `$27E4` (10,212): **6,172 bytes free** in DOCK chunks 0-1 (the 6,987 quoted before the song player).
  The spike's package with the P2 projector is 4,714 bytes (3,818 code + 896 tables), with P3 5,823: **P2 is the contract**.
* **RAM:** chunk 6 is full. Free: `T2` 32 bytes, `V_FREE2` 4, and **`POOL_B`'s top**: the boot hands out phase slots in order
  (`pack_phase`, `assets.asm:264`: slot n = n-th phase of the assets in order; A = 0..31 at `$C200`, B = 32..59 at `$F000`, C =
  60..63), so a game whose assets have **at most 45 phases in all** never writes `$F4E0-$FA7F` (slot 44 ends at `$F4DF`). The 3D RAM
  goes there (section 3.2); the linker enforces the limit.
* **The tick** (`main.asm`): `TICK_LOOP` leaves **within about 100 T after a frame interrupt** in every case (it waits for
  `V_SYNC = READY`, which only the interrupt sets, then for `V_FRAMES`, which only the interrupt changes). Then `WORK_START`
  (hidden file -> `V_HOFF`), the game's `FRAME`, `skip_analysis`, `erase_all`, `redraw_dirty`, `draw_all`, the flip request.
* **The interrupt handler** (`isr.asm`) saves only AF; `SND_TICK` saves BC, DE, HL. It never touches IX, IY or the alternate
  registers, so the spike's kernels (which use `EX AF,AF'`, `EXX`, IX, IY) are safe with interrupts on. **Keep it that way**
  (a rule for every later ISR change; a test checks it, section 8).
* **Header:** v2 reads `frame_div AND $7F` (`boot.asm:98`); bit 6 (`DIV_WIN` / `DIV_VIEW` in v3 / v4) is unused in v2.

## 1. The language

```
GAME "Orbit Gates"
FRAMERATE 20
WIRE3D ROWS 2 TO 21 INK 5 PAPER 0 BRIGHT 1   REM the play area: character rows 2..21, all 32 columns
MODEL gate = "gate"                           REM a wireframe model, an asset made in the project
MODEL rock = "rock"

SCENE play
  PROC FRAME():
    EYE ex, 0, ez, ea                         REM the viewer: position and heading
    DRAWMODEL gate AT gx, 0, gz YAW t
    DRAWMODEL rock AT rx, ry, rz YAW t * 3 PITCH t SCALE 2
    LINE 120, 96 TO 136, 96                   REM 2-D, screen pixels, clipped to the play area
  ENDP
ENDSCENE
```

1. **`WIRE3D ROWS r0 TO r1 [INK n] [PAPER n] [BRIGHT n]`**: top level, at most once. `r0`, `r1` constant character rows,
   0 <= r0, r0 + 3 <= r1 <= 23 (at least 4 rows). Defaults: `INK 7 PAPER 0 BRIGHT 1`. The **play area** is pixel rows
   `8 r0 .. 8 r1 + 7`, all 256 columns. `ROWS` is contextual; `INK`, `PAPER`, `BRIGHT` are already words (as in `VIEW3D`).
2. **`MODEL name = "asset"`**: declares a model asset (like `SPRITE`). At most 32 models.
3. **`EYE x, y, z, a`**: the viewer: world position (signed 16-bit) and heading `a` (taken AND 255, 256 to a turn). Stored;
   used by every later `DRAWMODEL`. Boot / `ENTER` value: 0, 0, 0, 0.
4. **`DRAWMODEL m AT x, y, z [YAW a] [PITCH p] [SCALE s]`**: draws model `m` with its origin at world (x, y, z), turned by yaw
   `a` (about the vertical axis) after pitch `p` (about its own x axis), both AND 255, default 0. `SCALE` is a **constant**
   1, 2, 4 or 8 (default 1). Draws **at once** into the hidden display file (section 2.4). `m` is a model name (not a
   number: static names).
5. **`LINE x0, y0 TO x1, y1`**: a 2-D line in screen pixels (y from the top, signed 16-bit values), clipped exactly to the play
   area, drawn at once. (`LINE` is reserved from now on; no example uses it as a name.)
6. **`COSA(a)`, `SINA(a)`, `FXMUL(a, b)`** become available in v2 with exactly v4's values (`arcade-view.js`): a game moves
   along its heading with `x = x + FXMUL(speed, SINA(a))`, `z = z + FXMUL(speed, COSA(a))`.
7. **Scenes:** `SCENE name NOVIEW` is also allowed in a `WIRE3D` game (no new word): a scene without the play area (the whole
   cell screen, as a game without `WIRE3D`): title, menu, scores. `EYE` is stored there; `DRAWMODEL` and `LINE` do nothing.
8. **New reserved words:** `WIRE3D MODEL EYE DRAWMODEL LINE`; contextual: `ROWS YAW PITCH SCALE` (after their statement only).
   As `MUSIC` / `NOMUSIC` do (`BATCH11_WORDS`, `arcade-words.js`), the new words may still name an asset in a declaration.
9. **Errors** (checker): `WIRE3D` twice, with `WINDOW` or `VIEW3D`, rows out of range / fewer than 4, a colour out of 0..7;
   `DRAWMODEL` / `LINE` / `EYE` / `MODEL` without `WIRE3D`; `DRAWMODEL` of a name that is not a model; `SCALE` not a constant
   1 / 2 / 4 / 8; `NOVIEW` in a game with neither `VIEW3D` nor `WIRE3D`. **Warnings:** `DRAWMODEL` / `LINE` written directly
   in a scene's `INIT` (the tick's clear wipes it: draw in `FRAME`); `PRINT AT` / `TILE` with a constant row inside the play
   area (not shown while the play area is on, section 2.5).
10. **Runtime choice** (`requiredRuntime`): `WIRE3D` needs v2 (the error names it with v3 / v4). `COSA`, `SINA`, `FXMUL` no
    longer force v4: v2 and v4 have them, v3 refuses them ("needs the v2 or v4 runtime"). A program that used them only with
    `VIEW3D` (Vaults) is unchanged.

## 2. Meaning (exact; the JS reference implements exactly this)

### 2.1 Models
Asset (project / `*.assets.json`: `assets.models.<name>` = `{points, edges}`, a sixth kind beside `sprites`, `tilesets`, `maps`,
`sfx`, `music`): `points` [[x, y, z], ...], 1..128 points, integers |c| <= 64 (the quarter-square
range); `edges` [[i, j], ...], 1..255 edges, i <> j, both < points. World axes: x right, y **up**, z forward. Game image
(linker): `DB npts, DB nedges, npts x (DB x, y, z), nedges x (DB i, j)`, in the **mapped** 16 KB (never in a bank: the bank
window is the display files, and the draw reads the model every tick).

### 2.2 From the world to the camera (per `DRAWMODEL`)
`d = (x - ex, y - ey, z - ez)` exact (17-bit; an object with any |d| > 16,000 is not drawn). `C = COSA(ea)`, `S = SINA(ea)`:
`Tx = floor((dx C - dz S) / 256)`, `Ty = dy`, `Tz = floor((dx S + dz C) / 256)` (exact 32-bit products, as `FXMUL`). Not drawn
when |Tx|, |Ty| or |Tz| > 16,000.

### 2.3 Rotation, scale, projection, lines
* Sine table `SIN8[k] = round(64 sin(2 pi k / 256))` (the spike's; int8, 1.0 = 64). `mulr(a, b) = (a b + 32) >> 6`
  (arithmetic). With `y' = (a - ea) AND 255`, `cy = SIN8[y' + 64]`, `sy = SIN8[y']`, `cp = SIN8[p + 64]`, `sp = SIN8[p]`:
  `M = [[cy, mulr(sy, sp), mulr(sy, cp)], [0, cp, -sp], [-sy, mulr(cy, sp), mulr(cy, cp)]]` (= Ry(a - ea) Rx(p): pitch in the
  model's frame, then yaw, then the eye; **this order differs from the spike's `build_matrix`**, which is Rx Ry: same cost, and
  only this order lets the eye's turn fold into the yaw). A negated entry is the negation of the rounded value.
* Point: `sum = M_row . (px, py, pz)` (exact), camera `Xc = Tx + ((sum s + 32) >> 6)` (s = `SCALE`), likewise Yc, Zc.
* Projection **P2** of the spike (`ref.mjs` `qAbs(a, Z, 2)`, the RCPT table), focal length 128: `sx = 128 + q(Xc)`,
  `sy = c - q(Yc)` with `c = 4 (r0 + r1 + 1)` (the play area's middle row). Flags as the spike: Zc < 16 near, |q| > 16,000 too far.
* Edges: an edge with a flagged end is not drawn (no 3D clipping, spike "Traps"); otherwise the spike's line: its pixel
  definition and **exact clip** to the play area, **OR** into the hidden file. `LINE` uses the same line routine.
* Nothing else may differ from the reference: every pixel of both display files and every attribute.

### 2.4 The tick with the play area on
1. Right after the tick starts (section 0: within ~100 T of an interrupt), the play area of the hidden file is cleared (paper)
   by the spike's PUSH clear with interrupts off (30,481 T for 20 rows). Interrupts are off at most 37,000 T, and **no frame
   interrupt may be lost** (section 8 counts them).
2. The game's `FRAME`: `DRAWMODEL` and `LINE` draw at once into the hidden file (inside the play area only).
3. `skip_analysis` / `erase_all` / `redraw_dirty` **never write a play-area pixel row**; a sprite whose rectangle touches the play
   area is never "unchanged" (it is drawn every tick, since the clear removed it); outside the play area everything is as today.
4. `draw_all`: sprites over the lines (masked, as today: a sprite hides the lines under its mask).
Attributes: switching the play area on writes the declared attribute into the play-area cells of both files; nothing writes
them after that while it is on.

### 2.5 Text and tiles in the play area
`PRINT`, `TILE`, `FILL`, `LOADMAP` keep updating the cell map in the play rows, but those cells are not shown while the play
area is on. Switching it **off** (a `NOVIEW` scene) marks every play-area cell dirty in both files, so the cell map appears.
The HUD is the rows outside the play area.

### 2.6 The switch
As batch 7's `RT_WINMODE`: `ENTER`'s reset sets the target scene's mode (after the first screen map, before `INIT`); the boot
does the same for the first scene. On: the attributes (2.4), nothing else (the next tick clears). Off: play cells dirty (2.5).
A program without `NOVIEW` scenes emits no switch call (the boot turns it on, from the header).

## 3. Runtime v2

### 3.1 Code (appended after `RT_END` where possible)
`wire.asm` (new): the spike's variant C OR line drawer (`draw_line`, `line_setup` with the exact clip, `draw_fast`, the
octant / run loops), `clear_push`, the matrix (the order of 2.3), `project_yaw` / `project_full` (`project_yaw` when p = 0),
`proj_point` P2, `draw_edges`, the eye transform, and the entries:
* `RT_EYE`: the four values from `RT_ARGS` (`RA_*` words) into `W_EYE*`.
* `RT_DRAWMODEL`: HL = model address, `RT_ARGS` = x, y, z, yaw, pitch; A = log2(SCALE). Does nothing when the play area is off.
* `RT_LINE`: `RT_ARGS` = x0, y0, x1, y1. Does nothing when off.
* `RT_WIREMODE`: A = 0 off / 1 on (no-op without a `WIRE3D` header).
* `RT_COSA`, `RT_SINA`, `RT_FXMUL`: ported from v4 (`raybb.asm:940-1000`, `QTAB`) with the same register contract.
Registers: every entry may clobber AF, BC, DE, HL, IX, IY and the alternate set (checked for this contract: the code generator
never emits IX, IY, `EXX` or `EX AF,AF'`; a later change that does must make these entries save them). Interrupts stay on
except in the clear.
Tables (constant, in the runtime's ROM; page-aligned where the spike needs it): QSL / QSH 512, SIN8 256, RCPT 128 (the upper
half of a page: its lower half may hold code). **Size bound: the whole addition <= 5,300 bytes, leaving >= 870 free**; report
the figure.

### 3.2 RAM (`layout.inc`)
`W_REC = $F500-$F9FF`: five 256-byte pages (sx low, sx high, sy low, sy high, flag), point i at offset i (i < 128).
`W_VARS = $FA00-$FA7F`: line state, clip rectangle, eye, matrix, scratch (the spike's ~110 bytes). `$FA80` up (`T3`) untouched.
The linker refuses a `WIRE3D` game whose sprite assets have more than 45 phases in all (`"sprite art too large for a WIRE3D
game: N phases, at most 45; use fewer phases"`).

### 3.3 Header and boot
Bit 6 of `frame_div` = `DIV_WIRE` (with `DIV_EXT`, as v3 / v4's `DIV_WIN` / `DIV_VIEW`): the header is 20 bytes and `$8012`
is `DW wire_desc`, pointing at `DB r0, DB r1, DB attr, DB 0` (`arcade-codegen.js:1008`, `:2811` are the models). The boot reads it after the map table, sets
the clip rectangle, the projection centre and the clear's row range, and turns the play area on (unless the first scene is
`NOVIEW`, section 2.6).

### 3.4 The tick (`main.asm`)
At `WORK_START`, after `V_HOFF` is set: when the play area is on, the clear. `skip.asm` / `video.asm` (`erase_all`,
`redraw_dirty`) skip the play rows when it is on. **These edits move addresses**: the hash baselines are regenerated with
`node arcade/tools/regen-baselines.mjs --old f82442d` (cross-checked: every non-wire program behaves the same on both), and the
As built notes say so. Cost for a game without `WIRE3D`: at most +40 T per tick (one flag test per routine).

## 4. Compiler, interpreter, Studio

* **Parser / checker / words** (`arcade-parse.js`, `arcade-check.js`, `arcade-words.js`): section 1; hover help and the Help
  overlay entries; highlighting.
* **Codegen / link** (`arcade-codegen.js`, `arcade-link.js`): `EYE` / `DRAWMODEL` / `LINE` through `RT_ARGS` (`setArg`), the
  model data, the header descriptor and `DIV_WIRE`, the `NOVIEW` switch calls, the 45-phase check; `COSA` / `SINA` / `FXMUL`
  on v2. Every walker that lists statement types learns the new ones (the survey: `arcade-codegen.js` around lines 895, 944,
  1034, 1121). The build's `CONSTANTS` list (`arcade/tools/build-runtime-v2.mjs`) gets the new layout names.
* **Reference** (`arcade-interp.js` + a new `arcade-wire.js`): sections 2.2-2.6 bit-exact; built from the spike's `ref.mjs`
  (clip, pixels, P2) with the matrix order of 2.3. The display model (`arcade-display.js`) clears and draws the play area per
  tick in the order of 2.4.
* **Studio:** the words; a project keeps `model` assets (load, save, export, never drop them); the asset list shows them with
  a small turning wireframe preview (canvas, the reference's projection). **A model editor is not in this contract**: it goes on
  the Studio review list (item 5); the sample game's models are written as code in its asset generator, as the songs are
  (`arcade/examples/songs.mjs`). (Decision for the owner, section 10.)
* `docs/ARCADE_LANGUAGE.md`, `docs/ARCADE_RUNTIME_API_V2.md` ("As built: wireframe"), `docs/ARCADE_ASSETS.md` (the model
  asset) get the new parts.

## 5. Byte identity
Programs without `WIRE3D`, `COSA`, `SINA`, `FXMUL` compile to the same code bytes as on `main`; only runtime addresses move
(section 3.4), handled by `regen-baselines.mjs --old f82442d`, which must report every program equal in behaviour. Vaults
(v4) is unchanged byte for byte.

## 6. Performance targets (TSRun; real hardware may be slower: display-file contention, spike section "All numbers")
* Kernels as the spike measured, within 5 %: `draw_fast` 40 px 45° <= 4,460 T; one 12-point ship, yaw + pitch, generic P2:
  matrix + projection <= 50,000 T; the PUSH clear of 20 rows <= 31,000 T.
* Per `DRAWMODEL` overhead (the eye transform, arguments, setup) <= 3,000 T beyond the projection and the lines.
* `LINE` (40 px, inside): at most 400 T over `draw_fast` for the same line. (Amended after W1: the first figure, <= 4,000 T at
  every angle, was wrong: `draw_fast` alone takes 4,222 / 4,548 T at 45° / 60°, the spike's own figures.)
* The sample game (section 9): its `FRAMERATE` (20, or 15: section 9) holds in >= 99 % of the ticks of its recorded runs; report median,
  95th percentile, worst and ticks over budget (`tests/arcade-codegen-perf.mjs` style).

## 7. Slices (each ends with the suites green and a commit on `arcade-wire`)
* **W1 runtime kernels** (Opus agent, disposable worktree): `wire.asm` from the spike into v2, the matrix order of 2.3, the
  tables, `RT_EYE` / `RT_DRAWMODEL` / `RT_LINE` / `RT_COSA` / `RT_SINA` / `RT_FXMUL`; `arcade/tests/m17-runtime-wire.mjs`
  against the reference (both files, attributes and all RAM outside the declared areas).
* **W2 tick integration** (Opus agent): header, boot, `RT_WIREMODE`, the clear at `WORK_START`, the play-row skips, the
  baselines (`--old f82442d`).
* **W3 language** (Sonnet agent): parser, checker, words, reference, codegen, link, `requiredRuntime`;
  `tests/arcade-m17-compiler.mjs`, `tests/arcade-m17-differential.mjs` (interpreter vs the real runtime, pixel-exact).
* **W4 Studio** (Sonnet agent): section 4's Studio items; `tests/studio-smoke.mjs` extended.
* **W5 sample game** (Sonnet agent from my design, section 9): source, asset generator, scripted runs, its test file, the
  Studio Examples list (`publish-runtime.mjs` `EXAMPLES`).
* **W6 verification** (Haiku agents run, I check): run-all, mutations (`m17-mutations.mjs`, 4 shards: every new branch has a
  killing test), perf, cross-emulator (ZEsarUX, Fuse) for the sample game, docs, `HANDOFF.md`.

### 7a. W1 as built (2026-11-12; Opus agent, verified by the main thread)
`arcade/runtime/v2/wire.asm` (included last, before `RT_END`), `src/lang/arcade/arcade-wire.js` (the reference),
`arcade/tests/m17-runtime-wire.mjs`, `layout.inc` (the W_ section), the build's `CONSTANTS`. **+5,058 bytes** (`RT_END` `$27E4` ->
`$3BA6`; **1,114 free**); all 621 earlier labels keep their addresses (only `RT_END` moved; checked against the old `runtime.sym`).
m17: 73 checks, 0 mismatches: 2,000 scenes (4,089 `DRAWMODEL`s, 150 large models up to 128 points / 255 edges, 2,032 `LINE`s),
2,000 random `LINE`s, `COSA` / `SINA` for every angle and 10,324 `FXMUL` pairs against v4's values, the matrix for all 65,536
yaw / pitch pairs, the W1 guards, and 60 scenes with the real interrupt handler (636 interrupts: registers and pictures unchanged).
Figures (TSRun, exact): `draw_fast` 40 px 45° 4,222 T; 12-point ship yaw + pitch, matrix + projection max 47,419 (whole
`DRAWMODEL` mean 71,927 with its 18 edges); clear 20 rows 30,544, 24 rows 36,107 (interrupts off); per-`DRAWMODEL` overhead max
2,761; `RT_LINE` adds 298 T to `draw_fast`. Deviations: the eye transform uses three products instead of four with the same results
(the reference keeps the contract's four; equality is shown through the pictures: W6 adds a direct test of T over all 256 headings at
|d| = 16,000); a `LINE` with a coordinate outside -16384..16383 draws nothing (the exact clip's range; the reference does the same);
`wire_clear` does nothing while `W_ON` = 0, and `W_ON` is meaningful only after `wire_setup` (the RAM is phase slots in a game
without `WIRE3D`): W2 must call neither in such a game; SIN8 is stored as a 65-entry quarter table.

## 8. Tests (beyond the slices' files)
* Reference vs runtime: >= 2,000 random scenes (random eye, models, poses, scales, lines across and outside the play area,
  near / far points), every pixel of both files and the attributes, and RAM outside `W_REC`, `W_VARS`, the stack equal.
* Interrupts: a recorded run of the sample game counts the interrupts the handler took against the refreshes TSRun ran: equal
  (no lost interrupt); and IX, IY and the alternates set to patterns before an interrupt are unchanged after it.
* Each guard has a direct test (the size pass's lesson): |d| > 16,000 and |T| > 16,000 skips, a near end, a too-far end, a
  `SCALE 8` model at the range limit, a 128-point model, 255 edges, `LINE` fully outside / along an edge / one pixel, the 45 /
  46-phase link check, a `NOVIEW` scene's switch both ways (play cells dirty), `DRAWMODEL` in a `NOVIEW` scene (no pixel).
* The full `node arcade/tests/run-all.mjs --jobs 4`, `tests/studio-smoke.mjs`, the editor / model suites, `tests/rom-checks.mjs`,
  `tests/browser-smoke.mjs` before every commit; `python3 tools/stamp-modules.py`, `node arcade/tools/publish-runtime.mjs`.

## 9. Sample game: "Orbit Gates" (W5)
An original first-person flight through a ring of gates in space (v2, `FRAMERATE 20`), designed to show every part:
* **Play scene (`WIRE3D ROWS 2 TO 21`):** the player steers (`EYE` heading with left / right, speed with up / down) through
  gates (`gate`: a flat octagon, 8 points, 8 edges, `SCALE 4`, turning slowly with `YAW`), while tumbling rocks (`rock`: an
  octahedron, 6 points, 12 edges, `YAW` + `PITCH`) drift across. A gate passed scores; a rock hit costs a shield. At most 2
  gates and 2 rocks drawn per tick. Budget (spike figures, *derived*): 28 points about 90,000 T, 40 edges (near gates clip)
  about 40,000-60,000 T, clear 30,481, logic: about 165,000-185,000 T against 176,064 at 20 fps. **`FRAMERATE 20` if the
  measured worst tick allows, else 15** (235,000 T); the As built notes give the figure and section 6's target follows the
  rate chosen. (The first sketch had 16-point gates: 3 of them alone cost about 139,000 T.) `LINE` draws the gunsight and a horizon tick; a 2-D sprite (an explosion /
  shield flash) over the play area shows that sprites draw over lines.
* **HUD** (rows 0-1, 22-23): score, shields, gate count, in cells (`PRINT AT`), outside the play area.
* **Title and game-over scenes `NOVIEW`:** the full cell screen (no play area, so no 3D there): the logo in tiles, a new
  song in `songs.mjs` (`MUSIC`), the best score; `ENTER play` on fire.
* **Sound:** effects for gate, hit, game over; the title song.
* Recorded runs (a scripted pilot that flies the gates, and a lose run) in `tests/arcade-orbit.mjs`, pixel-compared with the
  interpreter at checkpoints; perf as section 6; cross-emulator as the other games.

## 10. Decisions made here, for the owner's review
1. **P2 projector, OR lines, generic models** (no compiled models, no XOR, no P3): the room (section 3.1). Compiled models
   (26 % faster, ~2 KB per model in the game) can come later as a compiler option.
2. **Camera: position + heading only** (no camera pitch or roll); objects have yaw + pitch. Enough for flying / driving games;
   camera pitch would need the full 3x3 composition per object (+9 products).
3. **Models authored as code** in the sample game's asset generator; a Studio model editor joins the Studio review (item 5).
4. **One ink for the whole play area** (attribute clash: lines are monochrome; colour per model is not possible in v2's cells
   without the clash).
5. **`NOVIEW` reused** for scenes without the play area, instead of a new word.
6. **COSA / SINA / FXMUL move to v2** (with v4's exact values) instead of a second, int8 sine function.

## 11. Not in this contract
3D near-plane clipping (an edge with an end behind the eye is dropped); hidden-line removal; XOR / erase modes; per-model
colour; compiled models; a model editor; camera pitch / roll; wireframe in v3 / v4; real-hardware timing.
