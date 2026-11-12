# Billboard spike B0: results

The brief is `docs/ARCADE_BILLBOARDS_CONTRACT.md` section 3. Everything here is **measured** on TSRun's stock TS2068 (code at `$8000`, entered
by CALL with interrupts off, T-states exact from the CALL to the final RET, no contention) unless it is marked **estimate**. Every number
comes from one run of the harness:

```
node arcade/spike/bb/run-bb.mjs            # all sections, 2 min 10 s; output in all-output.txt, numbers in results.json
node arcade/spike/bb/run-bb.mjs scenes     # (or correct / vaults / qbytes / png / proj: one section; BB_SCENES=n random scenes per colw, default 2000)
```

## The kernels (files in this directory)

| Kernel | File | What it is |
|---|---|---|
| **K0** | `k0.asm` | today's `bb_draw`, `bb_xc`, `mul8x16c` and the RAM row tails `BT_FI` / `BT_F` / `BT_I`, **copied verbatim** from `raybb.asm` / `ray.asm` and fed the same projection records (from the JS `projectBB`). Sanity: one 16 x 16 at 4 px, 16 rows: setup + code generation 5,088, rows 6,162 (the API doc's figures: 5,189 and 6,084); a 32 x 32 drawn 32 rows: rows 27,398 (doc 27,070). |
| **A1** | `a.asm` | the two-pass draw. One scan of the rays (depth test, source column `u`) builds a position list (`PL`, 2 bytes a ray: source byte, bit). Then row by row: when the source row `v` changes, *prepare* it (scale it horizontally into `ROWBUF`, one mask / image pair per screen byte column, the occlusion folded in as a pseudo pixel mask 1 / image 0); then *copy* `ROWBUF` to the screen, `(bg AND mask) OR image`, 40 T a byte (16 byte columns unrolled, entered at the first). Only source rows that are drawn are prepared, each once, so the buffer is one row (32 bytes) even for a 32 x 32. |
| **A2** | `a.asm -DA2=1` | A1 plus a cache: 7 slots of 256 bytes (`$F000`, `$F100`, `$F200`-`$F600` = RAY_BCODE), round robin; a slot keeps all `h` prepared rows of one instance with the key (frame, wpx, k0 = xc(j0) - L, j0, the occlusion bit of every scanned ray). A hit skips the prepare. A billboard whose rows do not fit a slot (h x 2 n > 256: every 32 x 32 drawn 5 or more byte columns wide) takes the A1 path. |
| **Q** | `q.asm` | quantised sets: n heights per frame (geometric from h / 4 to 3 h; n = 8 for the timings), each column-sampled at colw with column 0 at every byte phase (pre-shifted: 2 phases at 4 px, 4 at 2 px). The runtime picks the nearest height (ties to the taller), snaps the billboard to the ray grid, stages the visible rectangle from the "bank" into RAM (one LDIR when not clipped left / right), folds hidden columns into the staged bytes, and copies (44 T a byte: INC HL). Bank switching is **not** modelled (estimate: +120 T a billboard, `bank_on` + `bank_off` of `tileops.asm`). |
| **QM** | `q.asm -DQMAP=1` | Q with the sets readable in place (mapped): no staging unless a column must be folded. It shows what the staging costs; Vaults' sets (20.9 KB, below) do not fit the 16 KB game image, so QM is not a design on its own. |
| projection | `proj.asm` | today's `ray_bb` projection and sort (`bb_project`, `bb_sort`, `gen_mul`, `tm_cs` / `tm_sn`, `mul_p`, `mul8x16` ...) copied verbatim, `bb_draw` stubbed; its records and sort order are checked against `projectBB` / the reference order (0 mismatches). |

JS references: `ref.mjs` (the m8-common.mjs functions copied verbatim, `drawBillboards` is A's reference; Q's reference `drawQ` with
`qHeights` / `qGeom` / `buildQSet` / `projectQ`; the A2 key `a2Key`). Harness: `lib.mjs` (assembler, machine, `callAt`, PNG writer), `run-bb.mjs`.

## Correctness

After **every kernel call**: the hidden display file against the reference, `BB_TAB`, and all other RAM `$4000-$FFFF` (the other display
file, the attributes, the records, the frames, the sets, the tables) unchanged outside the kernel's declared buffers (and the patched bytes
of its RAM code). Random scenes as in `m8-runtime.mjs` section 4 (`randomPose` / `randomCells` on a 20 x 20 map, 16 instances of 8 assets
from 8 x 8 to 32 x 48, frames out of range, positions outside the map), plus random occlusion in 60 % of the scenes (runs of 1-9 rays,
alternating rays, given a random wall distance). For K0 / A1 / A2 the per-billboard sequence is also checked against one `drawBillboards`
call per scene. A2 draws every scene twice (the second pass mostly hits); a JS model of the slot policy predicted hit / cold / A1 path for
every A2 call and was never wrong (it is the model used for Vaults' hit rate below).

| colw | scenes | K0 | A1 | A2 (2 passes) | Q (own reference) | QM | exercised |
|---|---|---|---|---|---|---|---|
| 4 | 2,000 | 7,274 / 0 | 7,274 / 0 | 14,548 / 0 (hit 1,879, cold 1,993, A1 path 2,074) | 7,274 / 0 | 7,274 / 0 | 831 partly hidden, 4,737 clipped left / right, 714 clipped at the top |
| 2 | 2,000 | 7,274 / 0 | 7,274 / 0 | 14,548 / 0 (hit 1,996, cold 2,108, A1 path 2,076) | 7,274 / 0 | 7,274 / 0 | 1,026 partly hidden, 4,622 clipped left / right, 722 clipped at the top |

(billboard pictures checked / mismatches.) The timing scenes and the Vaults runs below are checked the same way: 0 mismatches. Stack below
the return address: 6 bytes (K0, A1, A2), 8 (Q). No kernel disables interrupts or moves SP.

## The scenes (T-states of one billboard draw, projection and sort excluded)

Synthetic projections (`synthProj`: hpx, hgt, tx, sxc given; no walls unless said). Scene 1 is centred (sxc = 64); "phases" is the range
over sxc = 64 .. 71 (L at every column phase). Q's set height in brackets. A2 warm = the same billboard again (a hit).

### colw 4

| scene | cols x rows | K0 | A1 | A2 cold | A2 warm | Q banked (Hs) | QM mapped |
|---|---|---|---|---|---|---|---|
| 1: wraith 16x16, 8 rows | 2 x 8 | 5,820 | 11,752 | 19,285 | 6,240 | 5,609 (8) | 4,632 |
| 1: wraith 16x16, 16 rows | 4 x 16 | 11,250 | 20,785 | 21,493 | 8,048 | 10,147 (17) | 7,937 |
| 1: wraith 16x16, 24 rows | 6 x 24 | 20,465 | 32,273 | 32,814 | 11,755 | 15,036 (24) | 11,125 |
| 1: wraith 16x16, 32 rows | 10 x 32 | 37,165 | 45,131 | 45,868 | 17,006 | 25,887 (34) | 17,710 |
| 1: wraith 16x16, 48 rows | 14 x 48 | 68,783 | 63,543 | 64,483 | 27,607 | 43,384 (48) | 28,025 |
| 2: 32x32, 32 rows | 10 x 32 | 36,622 | 77,851 | 79,194 | 79,194 (A1 path) | 22,104 (33) | 15,538 |
| 2: 32x32, 64 rows | 18 x 64 | 110,211 | 133,349 | 135,249 | 135,249 (A1 path) | 70,608 (67) | 43,744 |
| 3a: 32x32 at hgt 48: 96 rows, 111 px, centre at x 8 (clipped left) | 16 x 96 | 139,594 | 126,248 | 128,388 | (A1 path) | 89,142 (96) | 50,456 |
| 3b: 32x48 at hgt 48: 144 rows (48 clipped at the top), 166 px (clipped both sides) | 32 x 96 | 269,532 | 231,710 | 234,366 | (A1 path) | 160,086 (144) | 89,145 |
| 4: 16x16 48 rows, one ray hidden | 13 x 48 | 65,035 | 63,298 | 64,238 | 27,592 | 48,137 | 48,166 |
| 4: 16x16 48 rows, 4 rays hidden (run) | 10 x 48 | 52,271 | 62,583 | 63,523 | 27,547 | 52,658 | 52,687 |
| 4: 16x16 48 rows, every other ray hidden | 7 x 48 | 41,622 | 56,483 | 57,396 | 25,582 | 68,216 | 68,245 |
| 4: 32x32 64 rows, one ray hidden | 17 x 64 | 105,393 | 132,874 | 134,774 | (A1 path) | 77,026 | 77,055 |
| 4: 32x32 64 rows, 4 rays hidden (run) | 14 x 64 | 88,971 | 131,489 | 133,389 | (A1 path) | 83,046 | 83,075 |
| 4: 32x32 64 rows, every other ray hidden | 9 x 64 | 65,540 | 119,357 | 121,257 | (A1 path) | 121,618 | 121,647 |

Scene 1 over the 8 column phases: K0 5,541-6,657 / 11,246-13,356 / 19,908-22,694 / 34,045-37,165 / 64,047-68,783 (8 / 16 / 24 / 32 / 48 rows);
A1 9,486-11,758 / 20,785-25,334 / 27,641-32,540 / 40,179-45,131 / 57,731-63,543; A2 warm 5,800-6,246 / 8,042-8,963 / 10,675-11,910 /
15,606-17,006 / 25,210-27,607; Q 4,892-5,609 / 10,140-10,147 / 15,036-15,043 / 22,934-25,887 / 39,227-43,384; QM 4,251-4,632 / 7,930-7,937 /
11,125-11,132 / 16,185-17,710 / 25,884-28,025.

### colw 2

| scene | cols x rows | K0 | A1 | A2 cold | A2 warm | Q banked (Hs) | QM mapped |
|---|---|---|---|---|---|---|---|
| 1: wraith 16x16, 8 rows | 4 x 8 | 8,164 | 14,785 | 25,024 | 6,689 | 6,139 (8) | 5,162 |
| 1: wraith 16x16, 16 rows | 9 x 16 | 19,913 | 33,973 | 34,873 | 9,557 | 11,229 (17) | 9,019 |
| 1: wraith 16x16, 24 rows | 14 x 24 | 38,149 | 44,668 | 45,485 | 13,077 | 16,676 (24) | 12,765 |
| 1: wraith 16x16, 32 rows | 18 x 32 | 59,891 | 63,372 | 64,385 | 19,134 | 28,349 (34) | 20,172 |
| 1: wraith 16x16, 48 rows | 28 x 48 | 122,535 | 88,132 | 89,568 | 30,284 | 46,950 (48) | 31,591 |
| 2: 32x32, 32 rows | 18 x 32 | 59,348 | 112,502 | 114,100 | (A1 path) | 27,710 (33) | 19,758 |
| 2: 32x32, 64 rows | 37 x 64 | 203,515 | 192,812 | 195,306 | (A1 path) | 75,836 (67) | 48,972 |
| 3a: 32x32, 96 rows, clipped left | 32 x 96 | 252,802 | 174,907 | 177,557 | (A1 path) | 94,163 (96) | 55,477 |
| 3b: 32x48, 144 rows, clipped top and both sides | 64 x 96 | 497,588 | 334,342 | 338,018 | (A1 path) | 169,634 (144) | 98,694 |
| 4: 16x16 48 rows, one ray hidden | 27 x 48 | 118,784 | 87,887 | 89,323 | 30,269 | 51,706 | 51,735 |
| 4: 16x16 48 rows, 4 rays hidden (run) | 24 x 48 | 107,675 | 87,392 | 88,828 | 30,224 | 51,864 | 51,893 |
| 4: 16x16 48 rows, every other ray hidden | 14 x 48 | 70,129 | 84,889 | 86,325 | 30,101 | 77,242 | 77,271 |
| 4: 32x32 64 rows, one ray hidden | 36 x 64 | 198,694 | 192,337 | 194,831 | (A1 path) | 82,257 | 82,286 |
| 4: 32x32 64 rows, 4 rays hidden (run) | 33 x 64 | 184,487 | 191,552 | 194,046 | (A1 path) | 88,286 | 88,315 |
| 4: 32x32 64 rows, every other ray hidden | 19 x 64 | 116,777 | 184,362 | 186,856 | (A1 path) | 134,258 | 134,287 |

Scene 3 note: the projection rule draws rows `max(0, top) .. 47 + hgt` and hgt <= 48, so the bottom of a billboard is never below the
window: "clipped top and bottom" cannot happen; 3b is clipped at the top (48 rows) and on both sides.

### T-state splits (prepare / copy / overhead), from the PC profile

| scene, colw | K0 | A1 | A2 warm | Q banked | QM |
|---|---|---|---|---|---|
| wraith 8 rows, 4 | setup + generation 3,800, rows 2,020 | scan + setup 3,225, prepare 5,586, copy 640, row tail 2,301 | scan + setup 4,032, key / slot 727, copy 640, tail 841 | select + scan + setup 3,542, stage 806, copy 704, tail 502 | 3,237, copy 704, tail 691 |
| wraith 48 rows, 4 | 12,425, rows 56,358 | 5,301, prepare 35,044, copy 15,360, tail 7,838 | 6,172, 769, copy 15,360, tail 5,306 | 7,159, stage 16,262, copy 16,896, tail 3,012 | 6,848, copy 16,896, tail 4,281 |
| wraith 48 rows, 2 | 21,283, rows 101,252 | 7,440, prepare 57,494, copy 15,360, tail 7,838 | 8,765, 853, copy 15,360, tail 5,306 | 10,725, stage 16,262, copy 16,896, tail 3,012 | 10,414, copy 16,896, tail 4,281 |
| 32x32 64 rows, 4 | 15,347, rows 94,864 | 5,999, prepare 89,224, copy 25,600, tail 12,526 | (A1 path) | 8,580, stage 28,274, copy 29,480, tail 4,219 | 8,263, copy 29,480, tail 6,001 |
| wraith 48, every other ray hidden, 4 | 8,534, rows 33,088 | 5,223, prepare 29,982, copy 13,440, tail 7,838 | 6,067, 769, copy 13,440, tail 5,306 | 8,016, stage 18,636, **fold 23,768**, copy 14,784, tail 3,012 | same as Q (it stages to fold) |

Unit costs derived from those: **K0** 84 T per drawn column-row at 4 px (75 at 2 px) including its per-byte and row-tail share, plus 650-750 T
of code generation per column. **A1 prepare** 123-156 T per *source* column-row (the per-position bit tests cost about 80 T, the rest is
the per-byte store and the per-row set-up: copying the source row, the call from the tail). **Copy** 40 T a byte-row (A), 44 (Q), whatever the
colw: 20 T per column-row at 4 px, 10 at 2 px. **Row tail** about 110 T (A2), 163 (A1, the new-row path included), 63 (Q), 89 (QM).
**Stage** 42 T a byte-row (LDIR of mask and image). **Fold** about 70 T per folded byte-row.

What that means:

* **A1 beats K0 only when a source row is drawn about 2 or more times** (hpx about 2-2.5 h at 2 px, about 3 h at 4 px): the 48-row wraith (3 x) is
  -8 % at 4 px and -28 % at 2 px; the 32 x 32 at 64 rows (2 x) is +21 % / -5 %; at 1 x or minified it is 1.5-2 x slower than K0 (the far
  wraith at 8 rows: 11,752 against 5,820). Its prepare (123-156 T per source column-row) is dearer than K0's generated BIT tests (66 T) and
  the copy is added on top. The alternatives considered on paper (a branch-free carry version, a class-byte expansion of the source row,
  a column-major loop with patched constants) came to 75-95 T a position before the per-byte store (**estimates**, not built).
* **A2 warm is the A that pays**: 2.5 x (4 px) to 4 x (2 px) faster than K0 for a near 16-high wraith, 1.4-2.9 x at 16-24 rows, about
  the same far away (the fixed ~4 k of scan and set-up). But **Vaults almost never hits** (below), and a 32-wide source no longer fits a
  256-byte slot once it is 5 byte columns wide.
* **Q** costs about 21 + 21 T per column-row at 4 px (copy + stage) and 11 + 10 at 2 px, against K0's 84 / 75: 1.6 x (4 px) to 2.6 x
  (2 px) faster for near billboards with the staging, 2.4-5 x without (QM). It gets **slower than K0 when many columns are hidden**
  (the every-other-ray scenes: Q 68,216 against K0 41,622): K0 skips hidden columns, Q stages them and then folds them. Q's fixed
  overhead (select, scan, hide masks: 3.2-4.1 k for a small billboard, up to 22 k for an 83-column one) is not optimised; the column
  scan costs about 230 T a column against A's 160-175 (**estimate** of what it could be brought to: A's figure).

## Vaults

The JS model: `vaults.arc` on the reference interpreter (`src/lang/arcade/arcade-interp.js`) with the recorded stick inputs of
`tests/arcade-m8-vaults-script.mjs` (WIN_RUNS, and the test's synthetic sighting `WIN_SIGHT`; LOSE_RUNS) -- **not** the real runtime run
of `tests/arcade-m8-vaults-perf.mjs`, whose SEEN / DEPTH come from the real BB_TAB, so the wraiths' behaviour may differ. Every view tick:
`castFrame` on the tick's map array and pose, `drawWalls` into the hidden file (alternating files), then every billboard of the tick's
draw list through each kernel in TSRun, checked against the reference. colw 4 (Vaults' COLW).

| run | view ticks | billboard draws with a drawn column | A2 key unchanged from the instance's previous tick | 7-slot model hits |
|---|---|---|---|---|
| win | 1,420 | 290 | **17 (5.9 %)** | 17 (5.9 %), 273 cold, 0 A1 path |
| lose | 361 | 45 | 2 (4.4 %) | 2 (4.4 %) |

Why the key changed (win run, 273 misses): wpx 119, position (k0 / j0) 97, frame 31, not drawn the tick before 26, occlusion alone 0.
Keys a different cache could use, unchanged from the previous tick (win): without the occlusion 5.9 %, only the sub-ray / byte phase
(frame, wpx, k0, j0 mod 2) 9.3 %, frame and wpx only 39.3 %. The player walks and turns almost every tick and the wraiths animate, so
**A2's cache is worth nothing in Vaults**; a per-size cache with the position folded at draw time (which is what Q's sets are, built
offline) would see about 40 %.

Billboard draw per view tick (T-states, draw only; the projection and sort are on top):

| kernel | mean | p95 | max | whole win run |
|---|---|---|---|---|
| K0 | 3,829 | 22,345 | 74,964 | 5,437,512 |
| A1 | 4,655 | 27,473 | 72,401 | 6,609,639 |
| A2 | 5,006 | 29,213 | 73,941 | 7,108,844 |
| Q (banked) | 3,280 | 15,329 | 59,745 | 4,657,529 |
| QM (mapped) | 2,643 | 11,425 | 37,103 | 3,752,442 |

(lose run: K0 446,649, A1 661,167, A2 766,494, Q 656,980, QM 589,004 T over the run; its worst picture, tick 194: K0 30,972, A1 41,135,
A2 42,853, Q 22,555, QM 16,155.)

**Vaults' worst picture** (scene 5, reconstructed from the win run on the interpreter: the tick where K0 costs most): **tick 997**, three
billboards, two wraiths drawn 48 rows high (55 px wide) at tx 250 and 160 and one 4-row gem: **K0 74,964, A1 72,401, A2 73,941, Q
59,745, QM 37,103**. The real-runtime figure in `ARCADE_RUNTIME_API_V4.md` (worst picture's billboards 96,861 T) includes the projection and
sort; with this tick's three drawable billboards and today's projection (about 5 k each, below) the K0 total would be about 90 k
(**estimate**), the same order. The budget overrun reported there is 263,739 - 234,752 = 29 k on the worst tick: Q (banked) saves 15 k on
this picture, QM 38 k, A1 2.6 k.

Over the win run the projection matters more than the draw on average: per view tick 2.66 visible instances are behind the viewer, 0.28
in front but off the view, 0.92 drawable (of which most are hidden behind walls: 290 drew a column).

## Code bytes and RAM

| | ROM part | RAM code (copied at boot, patched per billboard) | net against K0 (image bytes) | RAM buffers |
|---|---|---|---|---|
| K0 (today) | 575 | 97 (`BT_*`) | 0 | RAY_BCODE 1,280 (up to 1,077 used) |
| A1 | 848 (incl. UTAB 64) | 185 (copy 112, tails) | **+361** | PL 128 + ROWBUF 32 + SROW 16 = 176 bytes in one page ($F800), 40 bytes of variables ($E1B0-); RAY_BCODE freed |
| A2 | 1,157 | 227 | **+712** | A1's + 7 slots x 256 = 1,792 (RAY_BCODE + $F000-$F1FF) + 160 bytes of slot keys |
| Q | 716 | 143 | **+187** | staging rows x 2 nb: up to 768 bytes for a 16-high source, **3,072** for a 32-high one drawn 96 rows (no contiguous free block that big in ray mode: $F000-$F6FF with RAY_BCODE freed is 1,792; it would need staging in chunks), + 144 (QV, QHM); plus the sets in a bank |
| QM | 732 | 143 | +203 | the sets mapped (do not fit: below) |

`bb_xc` + `mul8x16c` (102 bytes) are shared and unchanged. The RAM code fits `$5D95-$5FFF` (619 bytes free). RAM for the largest source
(32 x 32, 16 byte columns): A1 needs one row, 32 bytes (a full two-pass buffer would be 32 rows x 32 = 1,024 bytes); A2 cannot cache it in a
256-byte slot.

## Q: bytes, and the pictures

Bytes of one frame's sets (pre-shifted phases / one phase plus a run-time shift):

| source | colw | 6 heights | 8 heights | 12 heights |
|---|---|---|---|---|
| 16 x 16 (4 .. 48) | 4 | 2,324 / 1,078 | 2,960 / 1,390 | 3,966 / 1,880 |
| 16 x 16 | 2 | 4,772 / 1,078 | 5,992 / 1,390 | 8,240 / 1,974 |
| 32 x 32 (8 .. 96) | 4 | 8,792 / 4,176 | 10,842 / 5,278 | 15,302 / 7,374 |
| 32 x 32 | 2 | 18,000 / 4,292 | 22,192 / 5,310 | 31,442 / 7,468 |
| 8 x 8 (2 .. 24) | 4 | 628 / 290 | 792 / 388 | 1,066 / 510 |

Heights (h = 16): 6: 4 7 11 18 29 48; 8: 4 6 8 12 17 24 34 48; 12: 4 5 6 8 10 12 16 19 24 31 38 48.
**Vaults' 10 billboard frames** (wraith 4, gem 2, potion 1, key 1, treasure 2; the marker is never drawn): colw 4: **16,456 / 20,928 /
28,060** bytes pre-shifted for 6 / 8 / 12 heights (7,628 / 9,892 / 13,320 with one phase and a run-time shift); at colw 2: 33,960 /
42,576 / 58,568. The run-time shift was **not built**; its cost is an **estimate**: about 30-45 T more per staged byte-row (a nibble or
2-bit shift of mask and image), roughly doubling the staging.

Pictures (`approach-colw4.png`, `approach-colw2.png`, 5,944 x 548): an approaching wraith (frame 0, no walls) at every height **4 .. 48
rows** (columns left to right; hgt = hpx so its feet are on the floor line, each cell shows the 64 window rows ending at the feet, 64
pixels around the centre, at 2x). Row 1: today (and A, the same pixels); rows 2-4: Q with 6, 8 and 12 heights. The bar under a Q cell is
green when the set height equals hpx, red when Q snapped. Q also snaps the billboard to the ray grid (column 0 on a ray), so its sampling
does not change as it slides sideways.

## The interrupt (DI)

No kernel disables interrupts or points SP at data: all of them can run with interrupts on, as today's `bb_draw` does (their stack use is
6-8 bytes). In TSRun the frame interrupt is raised once at the frame boundary and taken only if IFF1 = 1 at that moment
(`tsrun/machine.js endRasterFrame` -> `irqZ80`), so a DI span that covers a boundary loses that refresh: `V_FRAMES` misses a count and the
sound tick is skipped (on hardware the /INT pulse is also short; not measured here). A POP-based copy (POP BC / LD A,(HL) / AND C / OR B /
LD (HL),A / INC L: 36 T a byte against 40) would save 4 T a byte-row, about 1.5 k on the 48-row wraith, and need DI for at least one row
(up to about 650 T) at a time, a lost interrupt with probability span / 58,800 per span (**estimate**, not built). Not worth it.

## Projection + sort (today's, measured with `proj.asm`; savings are estimates)

Label rows are PC ranges from one label to the next, so they do not split the work exactly. One 16 x 16 in view, the angle unchanged: **5,158 T** (7,005 when the angle changed: the two multiply routines regenerated, 1,847 T);
three in view 15,697; one visible but behind the viewer 1,666; one in front but off the view sideways **4,352**; 16 visible, 8 in view
56,096. Inside the 5,158:

| part | T | saving that keeps the outputs (**estimate**) |
|---|---|---|
| ray_bb's fixed part: BB_TAB reset (4 bytes an instance), the two `gen_mul` checks, the loops, the draw call | 614 | - |
| SPR_TAB read, the map bounds, dx, dy | 456 | - |
| the four products T(dx, cs), T(dy, sn), T(dy, cs), T(dx, sn): generated multiplies 726 + `tm_cs` / `tm_sn` / sign / `abs_hl` 505 | 1,231 | sign handling once per pair, not per product: -200 T, +10 bytes |
| hgt = HGT[tx >> 3], the record | 313 | - |
| label `.fok` (the asset, the frame clamp) | 117 | - |
| label `.f0` (the frame pointer stored, hpx = (h hgt) >> 4 by a 6-step shift-add, wpx) | 540 | h a power of two (every Vaults asset): shifts, about -200 T, +20 bytes |
| `recip_a` (twice) 146, `mul8x16` (vstep) 282 | 428 | - |
| label `.uw` (the ustep loop, vstep stored, ty's calls, \|ty\|, the 8-step restoring division off = 64 \|ty\| / q) and `mul_p` 152 | 1,205 | a division by a reciprocal of q needs a normalised table: about -150 T, risky for exactness: not proposed |
| sxc, col, L, the list entry | 254 | - |
| the sort (insertion, `bb_tx` per compare) | 31 (1), 1,085 (3), 7,310 (8) | keep tx beside the instance in the list: about -40 % of the sort, +20 bytes |

The two savings that matter for Vaults are about **order**, not arithmetic: (1) compute ty and the off-the-view test right after tx, before
hgt / hpx / wpx / ustep / vstep: an instance off the view sideways then costs about 2,700 instead of 4,352 (0 bytes, a reordering);
(2) an instance behind the viewer costs 1,220 (two products and the sign work); a conservative test on the high bytes first (reject when
it proves tx < 0) would save about 600 of them (+40 bytes). With Vaults' 2.66 behind and 0.28 sideways instances per view tick that is
about 2 k T a tick (**estimate**), more than A2 or the code generator's savings would give there on average.

## What was not done

* Nothing outside `arcade/spike/bb/` was changed; no runtime, compiler, test or doc edit; `runtime()` / `buildRuntime()` never called.
* K0 is today's code copied and fed the JS projection, not the real runtime.
* Vaults' worst picture is reconstructed from the recorded inputs on the reference interpreter (synthetic SEEN), not from the real runtime
  run; the interpreter's tick may differ from the perf suite's worst tick.
* Q: the bank switch is not modelled (+120 T a billboard, estimate); the run-time shift (one phase) and a staging cache are not built;
  staging of a 32-high set drawn 96 rows (3 KB) used `$C000` of the spike machine, which in ray mode holds the ray tables.
* A: a generated prepare, an A "direct" mode for minified billboards (prepare straight to the screen, no buffer), LRU slots, and a key
  without the occlusion were not built.
* The projection savings, the POP copy and the run-time shift are estimates only.
* No contention, no ZEsarUX / Fuse, no real hardware.

## B1: the projection reorder, re-measured (`node arcade/spike/bb/run-bb.mjs proj`)

`proj` now runs twice: KERNEL 3 is the copy above (before B1), KERNEL 4 (`proj-b1.asm`) wraps ray_bb .. abs_hl of the live
`arcade/runtime/v4/raybb.asm` (run-bb.mjs writes `proj-rt.asm` from it before assembling). Same scenes, same pose (a = 37):

| scene | before | B1 | B1 target |
|---|---|---|---|
| one 16 x 16 in view, angle unchanged | 5,158 | 4,738 | <= 4,800 |
| one 16 x 16 in view, angle changed | 7,005 | 6,585 | - |
| three in view, angle unchanged | 15,697 | 13,853 | - |
| one behind the viewer (rejected) | 1,666 | 1,069 | <= 1,100 |
| one in front, off the view sideways (rejected) | 4,352 | 2,484 | <= 3,000 |
| sixteen visible, eight in view (the sort: 7,310 -> about 3,700) | 56,096 | 44,528 | - |

Exactness at the projection level: 30,000 random scenes per kernel (`BB_PROJ_SCENES=30000`; whole 32 x 32 and smaller maps, every angle,
positions near and anywhere, outside the map, equal positions, heights 1, 2, 4, 8, 16, 32, 48, 13), 229,792 visible instances, 50,692 drawable:
R_BN, RAY_BLIST and every drawable record equal the reference, 0 mismatches on both kernels. What B1 changed is described in the comment
above `bb_project` in `raybb.asm`; the runtime suites (`arcade/tests/m8-runtime.mjs` 4b) check the records and the list too.
