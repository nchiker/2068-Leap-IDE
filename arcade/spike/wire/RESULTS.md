# Wireframe feasibility spike (Leap Arcade), 2026-11-11

Question: can a Leap Arcade game on the TS2068 draw a wireframe (vector-style) 3D scene into the hidden display file
every tick, and how much fits in a 3-refresh (20 fps) or 2-refresh (30 fps) tick?

**Answer in one line:** yes, for small scenes. After a 25,000 T game logic budget and a 30,481 T PUSH clear of a
256x160 play area, a 20 fps tick has about 120,000 T left. That is two rotating 12-point ships (36 edges, measured
139,310 T worst), or about 30 diagonal 40-px lines, or about 38 yaw+pitch-projected points. A 30 fps tick holds one
ship. Dense landscapes and tunnels (80+ edges, 1,000+ pixels of lines) run at 6 to 15 fps. The cost is split between
points (about 2,400 to 3,300 T each) and lines (about 600 T per line plus 55 to 105 T per pixel); clearing is the
small part.

All numbers are **measured on TSRun** (58,688 T per refresh, **no memory contention**: real hardware writing into
`$4000-$7FFF` may be slower). The code is at `$8000` of a stock TS2068, with interrupts off, entered by `CALL`. T-states
are exact, from the call to the final `RET`. One full run, `node arcade/spike/wire/run-wire.mjs` (17 s, exit 0), compares
**33,892 pictures and result sets with the JS reference, with 0 mismatches**. Each line test compares both display files,
the attributes and all other RAM outside the variables page and the stack (`all-output.txt`, `results.json`). Before that,
a JS-only check compares 36,000 clipped lines with brute force (0 mismatches). Numbers marked *derived* are arithmetic on
the measured ones. Numbers marked *estimate* are cycle counts that were not run. Nothing here has run on a real TS2068.

## What was built

| File | What |
|---|---|
| `wire.asm` | Main file: `-DVARIANT=0/1/2` (line drawer A, B, C), `-DMODE=0/1/2` (OR, XOR, ERASE = AND NOT), `-DPROJ=1/2/3` (projector), `-DMODEL` (adds the compiled model) |
| `lines.asm` | Exact clipping (`line_setup`), the three drawers, `draw_line`, and `draw_fast` (ends known to be inside, passed in registers) |
| `clear.asm` | Play-area clears: `clear_ldir`, `clear_ld` (unrolled `LD (HL),A`), `clear_push` |
| `proj.asm` | `build_matrix`, `project_yaw`, `project_full`, `proj_point` (projectors P1, P2, P3 and the outcode), `draw_edges` |
| `gen-model.mjs` -> `model.inc` | Generates the "compiled model" rotation code for one fixed model (the 12-point ship); `model.inc` is generated output |
| `common.inc` | Memory map of the test machine |
| `ref.mjs` | **Bit-exact JS reference**: clipping, pixels, OR / XOR / ERASE, clear, matrix, all three projectors, outcodes; `idealPixels` (brute force) |
| `lib.mjs` | Harness: assemble (sjasmplus), stock TS2068 in TSRun, tables, `callAt` with exact T-states |
| `scenes.mjs` | The test scenes (ships, landscape, tunnel) and the edge classification |
| `run-wire.mjs` | All measurements and checks; sections `ideal lines clip clear proj scenes edges sizes` (none = all, plus `budget`) |
| `all-output.txt`, `results.json` | Output of the full run |

Reproduce: `node arcade/spike/wire/run-wire.mjs` (all sections; writes `results.json`), or name sections:
`node arcade/spike/wire/run-wire.mjs lines clip`. Needs `sjasmplus` on the PATH.

## 1. Lines

### Pixel definition and clipping (the same in the Z80 code and `ref.mjs`)

Normalise so that the major coordinate u increases (x-major when |dx| >= |dy|). Pixel k = 0..du is
`(u0 + k, v0 + s * floor((2*k*dv + du) / (2*du)))`, where s is the sign of the minor delta. A clipped line keeps
**exactly** the pixels of the unclipped line that are inside the rectangle; the slope is never changed. The Z80 code
works out the first visible pixel k_lo, the last k_hi and the Bresenham accumulator at k_lo with 32-bit products and
32/16 divisions (`mul16`, `div32`). This needs endpoints of -16,384..16,383, which the projector guarantees (QMAX).
Lines move smoothly across the edges, with no jitter. JS check: `lineSetup`+stepping equals `idealPixels`
(walk the whole line, keep what is inside) for 36,000 random lines and 3 rectangles.

* **Fast path:** when all four coordinates are inside the rectangle (bytes), `line_setup` costs 645 T. **`draw_fast`**
  skips even that: the caller passes the four bytes in registers. `draw_edges` knows from the per-point outcodes when
  it can do this.
* **Error forms:** 8-bit when the whole line's du <= 255 (`E8 = (acc >> 1) - du`, add dv, carry = minor step).
  Otherwise 16-bit through `EXX` (`G = acc - 2du`). Both are exactly the reference's accumulator.

### Variants

* **A, plain:** the screen address and mask are computed from (x, y) for every pixel, with a 16-bit error. This is the baseline.
* **B, octant:** four loops (x-major down/up, y-major right/left). The address is stepped in place: `RRC` the mask and
  `INC L` on wrap; the row step is `INC H` with the character-row fix-up. Each loop has an 8-bit and a 16-bit error copy.
* **C, runs** (recommended): B, plus:
  * horizontal lines written as bytes (edge masks, `LD (HL),$FF`), and vertical lines with no error term;
  * for **OR and ERASE**, x-major lines unrolled per bit: `SET K,(HL)` / `RES K,(HL)`, with the error kept in A;
  * for **XOR**, shallow x-major lines (2dv <= du) collect a byte's pixels in C and write it once.

### T per line (mean of 4 directions x 4 positions; T per pixel in brackets), full 256x192 rectangle

**C, `draw_fast`** (both ends known to be inside), OR / ERASE:

| length | 0° | 15° | 30° | 45° | 60° | 75° | 90° |
|---|---:|---:|---:|---:|---:|---:|---:|
| 8 px | 585 (73) | 923 (115) | 1,086 (136) | 1,253 (157) | 1,255 (157) | 1,144 (143) | 842 (105) |
| 40 px | 686 (17) | 2,563 (64) | 3,341 (84) | 4,245 (106) | 4,548 (114) | 4,031 (101) | 2,826 (71) |
| 180 px | 1,166 (6) | 9,884 (55) | 13,024 (72) | 17,313 (96) | 18,812 (105) | 16,747 (93) | 11,481 (64) |
| 200 px | 1,226 (6) | 10,910 (55) | 14,441 (72) | | | | |

The "200 px" lines are x-major only, since the screen is 192 rows. XOR with `draw_fast` costs the same at 0° and at
60° to 90°. At 15°, 30° and 45° it costs 1,000 / 1,302 / 1,442 (8 px), 2,764 / 4,446 / 5,214 (40 px) and
10,480 / 18,048 / 21,676 (180 px), because XOR cannot use `SET`.

**Through `draw_line`** (16-bit ends, on-screen test and the general entry), 40 px: C OR 1,324 / 3,321 / 4,099 / 5,003 /
5,281 / 4,764 / 3,467; B 3,852 / 4,332 / 5,012 / 5,780 / 5,214 / 4,697 / 4,321; A 14,045 / 14,608 / 15,392 / 16,288 /
15,411 / 14,627 / 14,064. For 8-px lines `draw_line` adds about 640 T over `draw_fast` (C OR 1,223 / 1,681 / 1,844 /
2,011 / 1,988 / 1,877 / 1,483). The full tables for all 9 builds and 4 lengths are in `all-output.txt`.

Reading the tables:
* **The fixed cost per line is about 450 to 500 T in `draw_fast` plus 209 T in `draw_edges`** (measured: 32 copies of one
  edge, minus 32 `draw_fast` calls). Short lines are dominated by it.
* **Per pixel:** 6 T for horizontal lines, 55 to 72 T for 15° to 30°, 96 T at 45°, 93 to 105 T for steep lines and
  64 T for vertical lines.
* **ERASE costs the same as OR.** XOR is up to 40 % slower on 30° to 45° x-major lines.

### Clip cost (`line_setup` alone, then `draw_line` in total; variant C OR, 60 random lines each)

| case | setup mean / max | draw_line mean | visible px |
|---|---:|---:|---:|
| inside (fast path) | 645 / 668 | 8,684 | 107 |
| one end off screen (< 300 px out) | 5,436 / 7,756 | 17,266 | 112 |
| both ends off, crossing | 8,385 / 10,423 | 27,800 | 178 |
| one end far (\|c\| up to 16,383) | 6,074 / 7,907 | 14,973 | 80 |
| both ends far, crossing | 10,147 / 10,631 | 24,591 | 129 |
| rejected, all outside one side | 1,294 / 1,649 | 1,322 | 0 |
| rejected after the k tests (passes a corner) | 4,850 / 4,931 | 4,878 | 0 |

So a clipped line costs about 5,000 to 10,000 T extra: up to 3 shift-add 16x16 multiplies and 3 32/16 divisions (rolled
loops). In `draw_edges` an edge with both ends off the same side is rejected from the outcodes for 163 T, and an edge
with a near or too-far end is skipped for 148 T.

## 2. Clearing the play area (hidden file, character rows r0..r1, all 32 columns)

| area | LDIR | unrolled `LD (HL),A / INC L` | PUSH DE (unrolled, SP at the span end) |
|---|---:|---:|---:|
| 256x192 | 131,168 | 71,756 | **36,113** |
| 256x160 (rows 2..21) | 109,664 | 60,076 | **30,481** |
| 256x144 (rows 3..20) | 98,912 | 54,236 | **27,665** |
| 256x128 (rows 4..19) | 88,160 | 48,396 | **24,849** |

PUSH costs 1,408 T per character row (*derived*: (36,113 - 24,849) / 8), so clearing only the rows the previous
frame used scales the same way. In the ZX layout every area aligned to character rows is one contiguous span per third
and pixel line, so all three walk the same 8 spans per third.

**Erasing by redrawing the previous frame's lines** costs what drawing them costs (measured on every scene frame).
ERASE redraw (AND NOT) on the frame's own picture, and XOR redraw over an XOR-drawn frame, both leave the play area
blank (checked):

| scene | lines (OR draw) | ERASE redraw | XOR redraw | PUSH clear 256x160 |
|---|---:|---:|---:|---:|
| 1 ship, 18 edges, 184 px | 24,525 | 24,538 | 25,805 | 30,481 |
| 2 ships, 36 edges | 46,131 | 46,157 | 48,530 | 30,481 |
| landscape 7x7, 84 edges, 1,272 px | 130,642 | 130,685 | 141,164 | 30,481 |

Redrawing beats the PUSH clear only below about 20 short lines. XOR has a further trap: a pixel shared by two lines
(every vertex) cancels and disappears. **Use the PUSH clear.**

## 3. Rotation and projection

Formats:
* sine table: 256 steps per turn, int8, 1.0 = 64;
* matrix: int8 (1.0 = 64), built per object from yaw and pitch by `build_matrix` (1,078 T);
* model points: int8 with |c| <= 64.

Products use **quarter squares**: `a*b = QS[a+b] - QS[a-b]`, with one 256-entry table of `floor(n²/4)` indexed by the
byte. It is exact while |a| + |b| <= 128, which is why coordinates and entries are limited to 64 rather than using 8.8.
The products are accumulated into DE: two 2-byte table reads per product, 100 T. The rotated sum is exact
(1/64 units, effectively 10.6 fixed point). Camera space is `T + ((sum + 32) >> 6)` (int16).

Screen: `sx = 128 + q(Xc)`, `sy = 96 - q(Yc)`, focal length 128 (a 90° horizontal field of view). A point with
Zc < 16 is flagged "near", and |q| > 16,000 is flagged "too far" (that keeps the line drawer's input range). Each record
also gets the Cohen-Sutherland outcode against the clip rectangle.

* **P1:** exact, `floor(|v|*128/Zc)` with a 32/16 division per coordinate.
* **P2:** Zc normalised to an 8-bit mantissa m (128..255) and an exponent e; `R = floor(32767/m)` (128-byte table);
  `q = (|v|*R) >> (8+e)` with an unrolled 16x8 shift-add multiply.
* **P3:** P2's normalisation, then `w = |v| >> e`, rounded. If w <= 255, `q = (w*R) >> 8` with one 8x8 unsigned
  quarter-square multiply (1 KB table); otherwise the P2 path.

**T per point** = (T for 64 points - T for 1 point) / 63, 64 random points per object pose:

| projector | yaw only (4 products) | yaw + pitch (9 products) | far (Z 8000), yaw / full | error vs exact perspective (19,036 on-screen points) |
|---|---:|---:|---:|---|
| P1 division | 4,891 | 5,631 | 4,891 / 5,627 | mean 0.66 px, max 1.00 |
| P2 reciprocal | 2,902 | 3,644 | 3,249 / 3,996 | mean 0.67, 99 % 1.09, max 1.70 |
| **P3** reciprocal + 8x8 | **2,394** | **3,140** | 2,768 / 3,526 | mean 0.68, 99 % 1.30, max 1.70 |

Where a P3 point goes (one point at Xc 50, Yc -30, Zc 400, measured piece by piece): `proj_point` 1,409 T =
`rcp_setup` 127 + two `q` (289 T for the positive coordinate; the negative one pays two negations more) + 704 for the
sign handling, records, outcode and calls. That leaves about 985 T of the 2,394 for the yaw rotation and the loop
(*derived*). For P2 `proj_point` is 1,901 T (`q` 535) and for P1 3,891 T (`q` 1,626). Flagged points are cheaper
(near: rotation only).

**Compiled model** (`gen-model.mjs`): what the Leap Arcade compiler could emit for a model known at compile time.
Every distinct (matrix entry x |coordinate|) product is computed once per object; for the ship that is 21 products
instead of 108. Each vertex is then a sum of stored products, with zeros dropped and signs folded into add and
subtract. The arithmetic is the same, so the result is identical (checked).
* Measured on the 12-point ship, yaw + pitch, P3: **29,333 T per ship (2,444 per vertex) against 39,781 generic (3,315)**,
  26 % less.
* It costs **1,989 bytes of code per model**, which belongs in the game, not the runtime.

## 4. Scenes and budget

### Measured scenes

Setup: 256x160 play area, clip rectangle y 16..175, PUSH clear, lines variant C (OR), projector P3. The hidden file
alternates `$6000` / `$4000`. Each scene runs 8 frames of animation; every frame is checked against the reference
(both files and the attributes), as are the ERASE and XOR redraws. Columns are means over the 8 frames except
"worst". "fits" = the worst frame plus 25,000 T of logic within 117,376 T (30 fps) / 176,064 T (20 fps), otherwise the
whole refreshes needed.

| scene | points | edges (fast / clipped / rejected / skipped) | px | clear | matrices | project | lines | total (worst) | fits |
|---|---:|---|---:|---:|---:|---:|---:|---:|---|
| 1 ship, compiled | 12 | 18 (18/0/0/0) | 184 | 30,481 | 1,078 | 29,333 | 24,525 | 85,416 (89,019) | **30 fps** |
| 1 ship | 12 | 18 | 184 | 30,481 | 1,078 | 39,781 | 24,525 | 95,864 (99,467) | 20 fps |
| 2 ships, compiled | 24 | 36 (36/0/0/0) | 324 | 30,481 | 2,156 | 56,239 | 46,131 | 135,008 (139,310) | **20 fps** |
| 2 ships | 24 | 36 | 324 | 30,481 | 2,156 | 77,135 | 46,131 | 155,904 (160,206) | 4 refreshes (15 fps) |
| 3 ships, compiled | 36 | 54 | 571 | 30,481 | 3,234 | 83,560 | 74,593 | 191,868 (194,957) | 4 refreshes |
| 4 ships, compiled | 48 | 72 | 666 | 30,481 | 4,312 | 112,257 | 92,815 | 239,866 (243,684) | 5 refreshes |
| 4 ships (P2 / P1) | 48 | 72 | 663 | 30,481 | 4,312 | 178,418 / 270,220 | 92,648 / 92,926 | 305,860 / 397,939 | 6 / 8 refreshes |
| landscape 5x5 (yaw) | 25 | 40 (40/0/0/0) | 564 | 30,481 | 1,078 | 61,162 | 60,060 | 152,781 (154,982) | 4 refreshes (3,918 T over 20 fps) |
| landscape 7x7 | 49 | 84 | 1,272 | 30,481 | 1,078 | 119,970 | 130,642 | 282,172 (284,339) | 6 refreshes |
| landscape 9x9 | 81 | 144 (133/8/3/0) | 2,167 | 30,481 | 1,078 | 198,976 | 255,825 | 486,360 (498,706) | 9 refreshes |
| tunnel, 3 rings of 8 | 24 | 40 (24/9/4/4) | 1,214 | 30,481 | 3,234 | 56,105 | 157,437 | 247,257 (273,152) | 6 refreshes |
| tunnel, 4 rings | 32 | 56 | 1,503 | 30,481 | 4,312 | 75,054 | 190,265 | 300,112 (325,471) | 6 refreshes |
| tunnel, 8 rings | 64 | 120 (104/9/4/4) | 2,135 | 30,481 | 8,624 | 153,517 | 281,789 | 474,411 (501,630) | 9 refreshes |

A tunnel's nearest ring is large and partly off the screen. Its 9 clipped lines and about 1,200 px of long lines cost
more than all its points.

### Budget (*derived* from the measured per-line, per-edge and per-point costs)

Available = tick - 25,000 T of logic - 30,481 T PUSH clear (256x160). A line = `draw_fast` + 209 T of `draw_edges`.
"Diagonal" is the mean of 15° to 75°.

| tick | T left | lines only: 8 px diag. (h/v) | 40 px diag. (h/v) | 180 px diag. (h/v) | points only, P3 yaw / yaw+pitch |
|---|---:|---:|---:|---:|---:|
| 3 refreshes, 20 fps | 120,583 | 89 (130) | 30 (61) | 7 (18) | 50 / 38 |
| 2 refreshes, 30 fps | 61,895 | 46 (67) | 15 (31) | 4 (9) | 25 / 19 |

Realistic shapes at 20 fps (from the measured scenes):
* **A few rotating ships:** 2 ships of 12 points and 18 edges with compiled models (139,310 T worst), or 1 generic
  ship at 30 fps with a compiled model (89,019).
* **A landscape of lines:** a 5x5 grid (25 points, 40 edges, about 560 px) just misses 20 fps (154,982 + 25,000 =
  179,982 against 176,064), so a 4x5 or 5x5 grid with fewer, shorter edges fits.
* **A tunnel:** 2 to 3 rings at about 10 fps as built. For 20 fps a tunnel must keep its lines short; about 1,100
  diagonal pixels is the whole budget.

Sprites, text and sound come on top of these figures.

## 5. Code size (bytes; whole program = everything the test build assembles)

| routine | bytes |
|---|---:|
| `line_setup` + exact clip (incl. `mul16`, `div32`) | 970 |
| drawing, variant C OR / ERASE (loops, `draw_state`, `draw_fast` 251, hv, tables) | 1,447 |
| drawing, variant C XOR | 1,639 |
| drawing, variant B (octant only) / A (plain) | 663 / 215 |
| `clear_push` + `clr_third` (`clear_ldir` 43, `clear_ld` 91 for comparison) | 243 |
| `build_matrix` / `project_yaw` / `project_full` | 131 / 210 / 368 |
| `proj_point` + q: P1 / P2 / P3 | 203 / 341 / 426 |
| `draw_edges` | 101 |
| compiled 12-point ship model (game code, per model) | 1,989 |
| tables: QS 512, SIN 256, RCPT 128 (P2, P3), SQU 1,024 (P3 only) | 896 + 1,024 |
| whole program C OR + P3 (incl. the two comparison clears) | 4,037 |

Recommended package (*derived*): C OR lines 2,424 (`draw_line` 7 + setup and clip 970 + drawing 1,447) + PUSH clear
243 + matrix and both projections 709 + P2 `proj_point` 341 + `draw_edges` 101 = **3,818 bytes of code + 896 of
tables = 4,714 bytes**. With P3: +85 code and +1,024 table = **5,823 bytes**.

RAM:
* point records: 5 bytes per point (1,280 for 256 points, page-aligned fields);
* the edge list: 2 bytes per edge;
* compiled-model scratch: 2 bytes per product;
* about 110 bytes of variables;
* a few bytes of stack.

## 6. Recommendation: a mode in v2, not a new runtime (yet)

* **It fits v2.** v2 has 6,987 bytes free (`docs/ARCADE_TABLES_CONTRACT.md`). The recommended package is about 4,700
  bytes with P2 (4,714), leaving about 2,270, or 5,823 with P3, leaving about 1,160. The code has **no self-modifying
  code**, and the tables are constant, so all of it can live in cartridge ROM like the rest of v2.
* **v2's tick model is what wireframe needs:** draw into the hidden file, then flip. Its text (HUD), sound and input are
  reused unchanged. Sprites drawn after the lines need no erase, because the play area is cleared every tick. So in
  this mode the play area bypasses the dirty-rectangle erase.
* **When to make a separate 16 KB runtime instead:** if a game needs the speed-ups that cost room, or needs both OR and
  XOR loops (a second copy of the drawing code, about +1,500 bytes, *estimate*). The speed-ups are a y-major per-bit unroll, a row address table (384 bytes), unrolled
  clip arithmetic and the P3 table. Also if a wireframe game needs RAM that v2's map does not have free (records and
  edges, about 1.5 to 2 KB; v2's free RAM was not checked in this spike).
* **Compiled models belong in the compiler,** not the runtime: they are per model and large (about 2 KB for 12 points),
  but 26 % faster.

## Techniques that paid off (measured gains)

* **Outcodes per point + `draw_fast`:** an 8-px line went from 1,223 to 585 T (C OR, 0°). Edges with both ends inside
  skip all range checks and the state round trip; edges off one side are rejected for 163 T.
* **Per-bit unrolled x-major loops with `SET` / `RES`:** at 45°, 120 -> 96 T per pixel; at 30°, 100 -> 72 (180 px lines).
* **Horizontal lines as bytes:** 6 T per pixel.
* **Quarter-square multiply into an accumulator:** 100 T per exact signed product, from a 512-byte table.
* **Reciprocal projection (P3):** 2,394 against 4,891 T per point for P1, at the same worst error class (1.7 against
  1.0 px).
* **PUSH clear:** 5.95 T per byte (30,481 for 5,120 bytes) against 21.4 for LDIR.

## Traps

* **The PUSH clear needs DI,** or an interrupt pushes into the area. On the TS2068 the frame interrupt is a short pulse;
  if it arrives while interrupts are off it is **lost**. Run the clear (about 30,000 T, half a refresh) right after the
  frame interrupt, so no pulse can fall inside it.
* **Registers the frame interrupt handler must preserve:** the routines use `EX AF,AF'` (`draw_fast`, the unrolled
  loops, the XOR collector), `EXX` (16-bit-error loops), IX (`draw_fast`, projectors, clears) and IY (`clear_push`).
* **Quarter-square range:** the signed table is exact only while |a| + |b| <= 128, so model coordinates and matrix
  entries are limited to +-64. A larger model must be scaled at compile time.
* **Exact clipping needs |endpoint| <= 16,383** (32-bit intermediates). The projector flags points beyond QMAX, so an
  edge to such a point is skipped rather than drawn wrongly. A game with huge near objects needs 3D near-plane
  clipping; it is not built.
* **Points behind the near plane** (Zc < 16) are flagged, and their edges are not drawn (no 3D clipping). In the tunnel
  this drops 4 edges per frame when a ring passes the camera.
* **Ordering inside the reference:** `-r(sp*cy)` (negate after rounding) is not `r(-sp*cy)`. The Z80 code and the
  reference must round the same way, which the matrix check catches.
* **XOR erase cancels shared pixels** (vertices); ERASE-mode redraw wipes anything under the lines (sprites, HUD inside
  the play area).
* **`ld ixh,l` does not exist** (H and L become IXH and IXL under the IX prefix): load IX through the stack.
  sjasmplus `jr` range errors in the unrolled macros are resolved by placing half of the step blocks before the bit chain.

## Estimates (cycle counts, not run)

* y-major per-bit unroll: about 5 to 10 % on steep lines (69 instead of 72 T per row, about 32 instead of about 40 per
  column step).
* A 2 x 192-byte row address table in `draw_fast`: about 65 T less per line (60 instead of 125 for the address).
* Unrolled `mul16` / `div32`: clipped lines about 30 % cheaper (the loop overhead is about a third of each iteration).
* Mirror-symmetric models: half the products. The compiled model already shares equal |coordinate| products, which
  covers most of this for the ship.
