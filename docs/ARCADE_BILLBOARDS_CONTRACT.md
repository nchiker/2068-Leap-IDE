# Faster billboards (runtime v4): step B0 (the spike) and B1 (the projection)

Item 5 of `docs/ARCADE_SPACE_PLAN.md` section 4 (owner's order, 2026-11-11: the v3 shrink pass, then this, then `MUSIC`, then a
wireframe game). **Status: B0 done (`arcade/spike/bb/RESULTS.md`, re-run by the main thread: same output, 0 mismatches). Owner's decision
(2026-11-11): neither draw candidate is built; B1, the projection reorder (section 5), is the contract. B1 done (2026-11-11): section 5a.**

## 1. Why

Billboards are the limit of `vaults.arc`: 7 of 1,433 ticks over the 4 refreshes (worst 263,739 T, of which billboards 96,861), and
the raycaster contract's budgets are missed (`ARCADE_RUNTIME_API_V4.md` "Deviations" 1): one 16 x 16 at 4 px 15,145 T against 9,000
(projection + sort 4,520, code generation 5,189, rows 6,084), one 32 x 32 40,321 against 31,000 (rows 27,070: 85 T per drawn
column-row). Today a drawn column costs two `BIT b,(IX+d)` tests per row (mask, image), about 66 T, in code generated per billboard.

## 2. The owner's question and what B0 must answer (2026-11-11)

The plan said "pre-scaled sets, banked, about 10x cheaper per pixel". Arithmetic before the spike: a billboard's drawn height takes
about 45 values (`hpx = h HGT[tx >> 3] >> 4`, 3 to 48 rows for h = 16, more for 32-high sources); every height of one 16 x 16 frame
at 4 px columns (mask + image, two nibble phases) is about 26 KB, 21 quantised heights about 9 KB, and Vaults has about 9 billboard
frames. Two candidates, **the owner chose: spike both, then decide**:

* **A. Two-pass draw, same pixels.** Per billboard: (1) scale each source row once horizontally into a RAM buffer (one byte pair
  mask / image per screen byte column; the wall occlusion of each ray column folded in: hidden columns get mask 1 / image 0, fully
  hidden byte columns skipped); (2) per drawn row, copy the buffer row of its source row `v` to the screen, one AND / OR per byte.
  No new asset data, no banks; the picture equals today's bit for bit (`drawBillboards` in `arcade/tests/m8-common.mjs` stays the
  reference). Variant **A2**: keep the prepared rows per instance and reuse them while (frame, wpx, L's column phase, first and last
  column, occlusion) are unchanged.
* **Q. Quantised pre-scaled sets.** The compiler emits each billboard frame at a small set of heights (for example 8, geometric),
  already column-sampled at `colw` (and both nibble phases at 4 px, the four 2-bit phases at 2 px, or a runtime shift: measure),
  banked (B3), copied into staging RAM for the instances in view; the runtime picks the nearest height, so sizes step visibly.

## 3. Step B0: the spike (`arcade/spike/bb/`)

Like `arcade/spike/wire/`: kernels assembled with sjasmplus, run on TSRun's stock TS2068 (code at `$8000`, DI, entered by CALL,
T-states exact from the CALL to the final RET), every picture compared with a JavaScript reference, results in `RESULTS.md` +
`results.json`, the harness `run-bb.mjs`. It changes nothing outside `arcade/spike/bb/` (no runtime, compiler or test edits; import
only the pure functions of `m8-common.mjs`, never `runtime()`, which rebuilds `arcade/build/v4`).

Scenes (each at colw 4 and colw 2; the window and display layout of v4: 128 x 96 at character (8, 6), both files):
1. one 16 x 16 frame (Vaults' `vl_wraith`) drawn 8, 16, 24, 32, 48 rows high, centred and at L of every column phase;
2. one 32 x 32 frame drawn 32 and 64 rows high;
3. a near one, drawn taller than the window (clipped top and bottom) and wider than the view (clipped left and right);
4. partial occlusion: walls nearer than the billboard on some ray columns (single columns, runs, alternating);
5. Vaults' worst picture: several wraiths close (reconstruct it from the recorded run of `tests/arcade-m8-vaults*.mjs`, or the
   perf suite's three-billboards scene if that is not practical; say which).

Measure for each scene: **K0** (today's code: the same projection outputs fed to a copy of the current `bb_draw` + row tails, or
the figures from the real runtime for the same scenes; say which), **A1**, **A2** (cold and warm), **Q**. Report the T-states split
(prepare / copy / overhead), code bytes of each kernel (v4 has about 1,315 bytes free; A replaces the code generator, so give the
net), RAM (buffer size for the largest source, 32 x 32), and for A2 the hit rate over a Vaults play-through, computed with the JS
model (how often an instance's key is unchanged from the previous tick).

Correctness: A1 and A2 must equal `drawBillboards` bit for bit (both display files, the rest of RAM untouched outside the declared
buffers) on at least 2,000 random scenes per colw (random poses and instances from `randomPose` / `randomCells`, both source sizes,
random occlusion). Q has its own reference (nearest set height, then the same column sampling); give the bytes per frame for 6, 8
and 12 heights, the total for Vaults' frames, and **pictures for the owner**: an approaching wraith at every height from 4 to 48
rows, today vs Q (PNG strips in `arcade/spike/bb/`), so the size steps can be judged by eye.

The interrupt: a kernel may not run with interrupts off longer than today's draw does, and may not move SP into data while
interrupts are on (the frame interrupt pushes onto the stack). If a POP-based copy needs DI, measure the longest DI span and say
what it delays (the sound tick, `V_FRAMES`).

Projection + sort (4,520 T per billboard) is a separate lane: list the costs inside it and any saving that keeps its outputs, with
estimated T and bytes; do not build it in B0.

## 4. B0's result (verified: `node arcade/spike/bb/run-bb.mjs`, 2 min 10 s, output identical to `all-output.txt`)

* Every kernel equals its reference: 7,274 pictures per kernel and colw (A2 14,548), 0 mismatches.
* Draw only, T: 4 px wraith 48 rows K0 68,783 / A1 63,543 / Q 43,384; 2 px 122,535 / 88,132 / 46,950; Vaults' worst picture (tick 997
  of the win run, rebuilt on the interpreter) **K0 74,964, A1 72,401, A2 73,941, Q 59,745**, QM 37,103 (QM = Q's sets mapped: do not
  fit). A1's prepare costs 123-156 T per source column-row (K0: 66), so it wins only when each source row is drawn 2-3 times.
* A2's key is unchanged from the previous tick in **5.9 %** of Vaults' draws (the player turns and walks, the wraiths animate).
* Q's sets for Vaults' 10 frames at colw 4: 16,456 / 20,928 / 28,060 bytes (6 / 8 / 12 heights, pre-shifted), more than the 16 KB of
  banks; staging up to 3,072 bytes; size steps visible (`approach-colw4.png`). Q saves 15 k on the worst picture; the worst tick is
  29 k over.
* The projection (5,158 T for one billboard in view; 1,666 behind the viewer; 4,352 in front but off the view) matters more on average:
  Vaults has 2.66 instances behind the viewer and 0.28 off the view per view tick, 0.92 drawable.

**Decision (owner, 2026-11-11): build only the projection reorder (B1); keep today's draw (K0); accept Vaults' 0.49 % of ticks over
budget; then `MUSIC`.** The spike stays in `arcade/spike/bb/` as the record of A and Q.

## 5. B1: the projection reorder (the contract)

**Rule: every output is the same.** For every pose, map, instance set and colw: the picture (both display files), `BB_TAB`, the draw
order, and for every drawable billboard its record in `RAY_BREC` and its entry in `RAY_BLIST`, byte for byte as today. A rejected
instance's record bytes are scratch (no reader). The register contract of `ray_bb` / `ray_render` is unchanged.

The changes (`arcade/runtime/v4/raybb.asm`, `bb_project` and `bb_sort`; savings are B0's estimates):
1. **Reject before the size work.** Compute tx, then the behind-viewer test (tx < 64), then ty, q = mulP(tx), off and the off-view
   test (off >= 192), and only then hgt, hpx, wpx, ustep, vstep and the record. An instance off the view sideways: about 4,352 ->
   2,700 T.
2. **Early behind-viewer reject:** a conservative test on the high bytes of the products that proves tx < 64 without the full
   products (only when it is exact: it must never reject an instance that today's code draws). About -600 T of the 1,220 an
   instance behind the viewer costs; +40 bytes or less.
3. **h a power of two** (8, 16, 32: every Vaults asset; any other h keeps the shift-add): hpx = (h hgt) >> 4 by shifts. About -200 T.
4. **Sign handling once per pair of products** instead of per product, if it keeps the products exact. About -200 T.
5. **The sort:** tx kept beside the instance in the list, so a compare does not fetch it (`bb_tx`). About -40 % of the sort.
Each change is optional if its exactness cannot be shown; the report says which were built.

Targets (TSRun, `arcade/tests/m8-runtime-perf.mjs` and the spike's `proj.asm` scenes): one billboard in view, angle unchanged
<= 4,800 T (5,158); one off the view sideways <= 3,000 (4,352); one behind the viewer <= 1,100 (1,666); Vaults' win run (the real
runtime, `tests/arcade-m8-vaults-perf.mjs`): mean `ray_render` lower than today, no tick over budget more than today (7), worst tick not
higher. Bytes: at most +80 (v4 has about 1,315 free).

Tests: the m8 suites (`m8-runtime*.mjs`: the billboard references are exact) and `tests/arcade-m8-*` pass unchanged; `m8-mutations.mjs`
(4 shards) all killed or equivalent with a reason, patterns updated where the text moved, and **new mutants for each new branch** (the
early reject, the power-of-two path, the sort key): each must be killed, adding a quick scene to `m8-runtime.mjs` where none kills it
(an instance just behind the viewer, one exactly at tx = 64, one at off = 191 / 192, h = 8 / 16 / 32 and a non-power-of-two h, equal
tx sort ties). Compiled games are the same bytes unless `RT_*` addresses move (then `regen-baselines.mjs --old <main>`).

**Sample game:** Vaults is the game that uses it (no source change: the saving is in the runtime). Re-measure its win and lose runs and
record them in `ARCADE_RUNTIME_API_V4.md` beside today's (median, 95th percentile, worst, ticks over budget).

## 5a. B1's result (2026-11-11)

Built: changes 1, 2 (both conservative rejects: both terms <= 0 with no multiply; T(dx, cs) <= 0 with P2 <= 63 after one), 3 and 4. Change 5 is
built differently: each drawable instance is inserted into `RAY_BLIST` as it is projected (the depth read from its record), which replaces
`bb_sort` and `bb_tx`. Every output is the same (`m8-runtime.mjs` 4b; the spike's 3,000 random scenes and `proj-cases.mjs`' 40,000 instances: 0
mismatches). Every target is met: one in view 4,695 T (<= 4,800), off the view sideways 2,390 (<= 3,000), behind the viewer 1,039 (<= 1,100);
Vaults' win run: mean `ray_bb` 16,879 -> 14,773, ticks over budget 9 -> 8 (measured against the runtime before B1 with today's game: the figures
of section 1 predate its title scene), worst picture lower; +10 bytes. One case is slower: hpx = 0 (a source under 16 rows, far away), found
after ty and off instead of right after tx (about +1,400 T, still under a drawn instance; no game has it). Figures and tests:
`ARCADE_RUNTIME_API_V4.md` "As built: the billboard projection reorder".

## 6. Later (not planned)

Q with one phase and a run-time shift (7,628 / 9,892 bytes for Vaults at 6 / 8 heights: fits the banks; the shift's cost is unmeasured)
is the candidate if a game ever needs many near billboards; it would need its own spike step and the owner's view of the size steps.
