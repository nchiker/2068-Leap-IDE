# Raycaster feasibility spike (Leap Arcade), 2026-11-09

Question: how fast can a Wolfenstein-style raycaster (grid map, walls only, no floor or ceiling texture) run on the
TS2068's 3.528 MHz Z80, drawing into the ZX bitmap?

**Answer in one line:** a 128x96 window with 2-pixel columns runs at about 12 to 15 ticks per second, 4-pixel columns
at 20, and 1-pixel columns at about 8 to 10 (best case of the cleverest variant). The per-ray cost (about 2.3k T-states
a ray) is what limits it, not the drawing. Numbers are TSRun's (58,688 T per frame, 60.11 Hz, **no memory contention**);
nothing here has run on a real TS2068.

All numbers below are **measured**, T-state exact, on TSRun with the code in this directory. Every one of the 67
configurations was run for 16 player poses (position and angle) and the whole 6,144-byte bitmap was compared with the
JS reference after every frame (bitmap preloaded with garbage, so unwritten window bytes or stray writes outside the
window would show): **all 67 x 16 frames match bit for bit**. The ray arrays (height and pattern of each ray) are
compared too.

## What was built

| File | What |
|---|---|
| `raycast.asm` | The renderer in Z80 assembly (sjasmplus), loaded at `$8000` |
| `build.mjs` | Generates the per-configuration parts: unrolled DDA loops, the row chains, the window clear, the data |
| `common.mjs` | Patterns, table definitions, maps, poses, and the **bit-exact JS reference renderer** |
| `run-raycast.mjs` | Harness (copied from `../native/run-native.mjs`): assembles, runs, compares, measures, cost split by PC markers |
| `profile.mjs`, `make-tables.mjs`, `art.mjs` | T-state profile by routine; the tables of this file; the pictures |
| `sprite.asm`, `run-sprite.mjs` | The column-scaled billboard kernel and its harness |
| `results.json`, `sprite-results.json`, `frames.txt` | Raw results |

Reproduce: `node run-raycast.mjs --all --json results.json` (17 s), `node make-tables.mjs`, `node profile.mjs 1:128:96:2:16`,
`node run-sprite.mjs`, `node art.mjs 1:128:96:1:16 1`. Config strings are METHOD:W:H:WCOL:MAPN[:INTERP].

### Algorithm

* **Fixed point.** Position 8.8 (cell = high byte); direction and camera plane 4.12 (1.0 = 4096); distances 8.8;
  angle 0..255 (256 per circle). Camera-plane projection, so there is no fisheye correction. FOV 60 degrees
  (plane length 0.578 = v>>1 + v>>4 + v>>6).
* **Tables built at start** (cost counted separately, below): cosine/sine (256 x int16, mirrored from a 65-entry
  quarter wave that is data in the program), reciprocal `1/|dir|` as 8.8 (320 x uint16, built by 16-bit division loops),
  distance-to-height (`HH*32/idx`, one byte per 1/32 cell, built by division), the per-column pattern table.
  The sine is used with sin(a) = cos(a - 64), the 4.12 ray direction of ray j is `start + j*step` by repeated addition
  (`step = 2*plane/N` by one 16-bit division per frame; the per-column directions are therefore incremental, no table).
* **Per ray.** `delta = recip[|dir|>>4]` for both axes; the first side distance is `floor(frac * delta / 256)`
  (an exact 8x16 shift-and-add multiply, 8 iterations); then a DDA loop on map-pointer arithmetic (HL walks the map,
  +-1 or +-MAPN), `BC`/`DE` hold the two side distances, deltas are self-modified immediates in one of four loop copies
  (one per direction quadrant). Perpendicular distance = the side distance before the last step (no division),
  `half-height = HGT[dist>>3]`. Wall type 1..4 and side give a pattern index 0..7.
* **Shading.** Two brightness levels by hit side, as dither: each pattern is an 8x2 tile (even row, odd row), e.g.
  type 1 = solid / checker, type 2 = 3/4 dither / 1/4 dither, type 3 = scanline stripes, type 4 = vertical bars.
  A ray's pixels are the tile bits at its own x position, so the texture is fixed to the screen, not to the wall.
* **Window.** Always byte aligned and centred on the 256x192 screen: 64x48, 96x64, 128x96, 128x128 (x origin byte
  12, 10, 8, 8; y origin 72, 64, 48, 32, all character-cell aligned so the centre row starts a cell).
* **Pixels each column width produces.** w=1: one ray per pixel column, 64..128 rays. w=2: one ray covers 2 adjacent
  pixel columns (same height, same pattern bits). w=4: one ray per nibble, so a byte holds two rays. w=8: one ray per
  byte (the 8-wide tile is applied unmasked). Heights are even (2*hh rows, symmetric around the window centre).

### Two drawing methods (both verified identical to the reference)

* **A, clear + read-modify-write.** Clear the window with `PUSH DE` along each row (stack pointer as the write pointer,
  DI needed; about 100 T a row for a 128-wide window), then draw each ray separately: from the window centre outward,
  one pair of rows (lower and upper) per step, `ld a,(hl) / or pat / ld (hl),a` on each. Rows are stepped with `inc h` /
  `dec d`, and the 8-row character-cell boundary is handled by a fix-up after every 8 pairs. The 64-pair loop is
  **straight-line code** that the drawer enters at pair 0 and leaves at pair `hh` by patching a `RET` into it (self-modifying
  code: 164 to 653 bytes of it would have to be copied to RAM in a cartridge).
* **B, byte-column composer.** The 8/w rays that share a byte column are sorted by height (insertion sort, 3-byte
  records of height and the two masked pattern bytes). Walking outward from the centre, the byte value only changes where a
  ray ends, so the column is a few **runs of constant bytes** (the accumulator is XORed with the record of the ray that
  ends; the masks of the rays in a byte are disjoint). Each run is drawn with plain stores (`ld (hl),b / ld a,c / ld (de),a /
  inc h / dec d`: 26 T per row pair, both halves) through the same enter/leave-by-patch straight-line chain. Every window byte is
  written once and never read, so there is **no clear**. Cost is per byte column plus per ray, not per pixel column.
* **I, interpolated rays (option on top of A or B).** Cast only every 4th ray. When the two ends of a 4-ray interval hit the
  same map cell and the same side, the 3 rays between get linearly interpolated heights (1/z is linear across a flat wall);
  otherwise they are cast normally. The picture is not identical to casting every ray (and the JS reference models this
  exactly): pillars narrower than an interval can be missed.

## Results

TSRun, 16 poses averaged per cell (positions in open areas, two of them 0.2 cells from a wall, and two looking down a
14-cell corridor; the 16x16 map has 4 wall types, pillars, rooms; the 32x32 map is a generated hall). "ticks/s (raw)" =
3,528,000 / T. "frame-locked" = 60.11 / ceil(T / 58,688): the rate a game gets if it steps once per whole number of video
frames, which is what a flip-synchronised engine does.


**16x16 map, every ray cast**

| window | col px | rays | A: clear+RMW | B: byte-compose | best T-states | cast | draw+clear | ticks/s (raw) | ticks/s (frame-locked) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 64x48 | 1 | 64 | 227k | 222k | **222342** (B) | 152k | 70k | 15.9 | 15.0 |
| 64x48 | 2 | 32 | 118k | 119k | **117816** (A) | 78k | 40k | 29.9 | 20.0 |
| 64x48 | 4 | 16 | 63k | 68k | **63380** (A) | 41k | 22k | 55.7 | 30.1 |
| 64x48 | 8 | 8 | 36k | 42k | **36212** (A) | 23k | 13k | 97.4 | 60.1 |
| 96x64 | 1 | 96 | 358k | 334k | **333830** (B) | 226k | 108k | 10.6 | 10.0 |
| 96x64 | 2 | 48 | 185k | 180k | **179733** (B) | 115k | 65k | 19.6 | 15.0 |
| 96x64 | 4 | 24 | 99k | 103k | **98643** (A) | 60k | 39k | 35.8 | 30.1 |
| 96x64 | 8 | 12 | 55k | 65k | **55371** (A) | 32k | 23k | 63.7 | 60.1 |
| 128x96 | 1 | 128 | 532k | 453k | **452818** (B) | 299k | 154k | 7.8 | 7.5 |
| 128x96 | 2 | 64 | 275k | 247k | **246907** (B) | 152k | 95k | 14.3 | 12.0 |
| 128x96 | 4 | 32 | 146k | 145k | **144976** (B) | 78k | 67k | 24.3 | 20.0 |
| 128x96 | 8 | 16 | 82k | 94k | **81992** (A) | 41k | 41k | 43.0 | 30.1 |
| 128x128 | 1 | 128 | 589k | 464k | **463798** (B) | 299k | 165k | 7.6 | 7.5 |
| 128x128 | 2 | 64 | 305k | 257k | **256551** (B) | 152k | 105k | 13.8 | 12.0 |
| 128x128 | 4 | 32 | 163k | 154k | **154213** (B) | 78k | 76k | 22.9 | 20.0 |
| 128x128 | 8 | 16 | 92k | 103k | **92037** (A) | 41k | 51k | 38.3 | 30.1 |

**16x16 map, interpolated rays (every 4th ray cast, flat walls interpolated)**

| window | col px | rays | A: clear+RMW | B: byte-compose | best T-states | cast | draw+clear | ticks/s (raw) | ticks/s (frame-locked) |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 64x48 | 1 | 64 | 175k | 171k | **170850** (B) | 100k | 71k | 20.6 | 20.0 |
| 64x48 | 2 | 32 | 106k | 107k | **105700** (A) | 66k | 40k | 33.4 | 30.1 |
| 64x48 | 4 | 16 | 63k | 68k | **63448** (A) | 41k | 22k | 55.6 | 30.1 |
| 96x64 | 1 | 96 | 264k | 240k | **239625** (B) | 131k | 108k | 14.7 | 12.0 |
| 96x64 | 2 | 48 | 155k | 150k | **150272** (B) | 85k | 65k | 23.5 | 20.0 |
| 96x64 | 4 | 24 | 93k | 98k | **93214** (A) | 54k | 39k | 37.8 | 30.1 |
| 128x96 | 1 | 128 | 393k | 315k | **314580** (B) | 160k | 155k | 11.2 | 10.0 |
| 128x96 | 2 | 64 | 223k | 195k | **195350** (B) | 100k | 95k | 18.1 | 15.0 |
| 128x96 | 4 | 32 | 134k | 133k | **133034** (B) | 66k | 67k | 26.5 | 20.0 |
| 128x128 | 1 | 128 | 450k | 326k | **326031** (B) | 160k | 166k | 10.8 | 10.0 |
| 128x128 | 2 | 64 | 254k | 205k | **204874** (B) | 100k | 105k | 17.2 | 15.0 |
| 128x128 | 4 | 32 | 151k | 142k | **142317** (B) | 66k | 76k | 24.8 | 20.0 |

**32x32 map** (T-states; avg DDA steps per cast ray 8.9 against 5.1 on the 16x16 map)

| window | col px | interp | A | B | ticks/s best (raw) | frame-locked |
|---|---:|---|---:|---:|---:|---:|
| 64x48 | 1 | no | 240k | 244k | 14.7 | 12.0 |
| 96x64 | 2 | no | 193k | 197k | 18.3 | 15.0 |
| 96x64 | 2 | yes | - | 176k | 20.0 | 15.0 |
| 128x96 | 2 | no | 277k | 269k | 13.1 | 12.0 |
| 128x96 | 2 | yes | - | 232k | 15.2 | 15.0 |
| 128x96 | 4 | no | 147k | 157k | 23.9 | 20.0 |
| 128x96 | 4 | yes | - | 150k | 23.4 | 20.0 |

**Cost split, 16x16 map, every ray cast** (T-states averaged over 16 poses; setup = per-frame direction/plane/step)

| config | setup | ray casting | clear | draw | total | worst pose | best pose |
|---|---:|---:|---:|---:|---:|---:|---:|
| A 128x96 w2 | 4299 | 147618 | 10077 | 113106 | 275100 | 335975 | 247158 |
| B 128x96 w2 | 4299 | 147618 | 0 | 94990 | 246907 | 271681 | 216970 |
| A 128x96 w1 | 4300 | 294926 | 10077 | 223115 | 532419 | 654311 | 475488 |
| B 128x96 w1 | 4300 | 294926 | 0 | 153591 | 452818 | 497596 | 393162 |
| A 128x96 w4 | 4297 | 73801 | 10077 | 58273 | 146447 | 176803 | 132313 |
| B 128x96 w4 | 4297 | 73801 | 0 | 66878 | 144976 | 158344 | 128870 |
| A 64x48 w4 | 4296 | 36921 | 2981 | 19182 | 63380 | 68467 | 60000 |
| B 64x48 w4 | 4296 | 36921 | 0 | 26920 | 68137 | 74877 | 60078 |
| A 96x64 w2 | 4297 | 110617 | 5343 | 64820 | 185077 | 210957 | 171388 |
| B 96x64 w2 | 4297 | 110617 | 0 | 64819 | 179733 | 197896 | 157326 |
| A 128x128 w2 | 4299 | 147618 | 13413 | 139977 | 305307 | 393839 | 260420 |
| B 128x128 w2 | 4299 | 147618 | 0 | 104634 | 256551 | 280848 | 225994 |

**Start-up (tables built on the Z80)**: 16x16 map: 1654k T = 28 frames = 0.47 s; 32x32 map: 2823k T = 48 frames = 0.80 s


Notes on the tables:

* **Method choice flips with column width.** B wins for 1- and 2-pixel columns (the more rays share a byte, the more B
  saves: 128x96 w1, 453k against 532k, and w2, 247k against 275k). At 8-pixel columns A is better (its work per ray is
  small and the clear is cheap), and at 4 pixels they are level (A for the small windows, B for the large).
* The worst pose of the 16 is typically 8 to 12 percent above the average (about 20 percent with interpolation, whose
  cost depends on the scene). The poses close to a wall are the cheapest (1 to 2 DDA steps a ray); the worst are long
  views across the room (9 steps a ray). A frame-locked engine has to be budgeted on the worst pose: see the verdict.
* The 32x32 map costs +17 percent on the casting and +9 percent on the whole 128x96 frame: the average DDA step count goes
  from 5.1 to 8.9 but each step is only about 90 T against 2.3k T of fixed per-ray work. It needs a 16-bit step in the
  Y direction and 1 KB of map.
* Interpolation saved 0 to 47 percent of the casting time on this room-and-pillar map: 0 at 64x48 with 4-pixel columns
  (16 rays, almost all intervals have a corner), 16 percent at 4 pixels on the larger windows, 35 to 47 percent at 2 and
  1 pixels (about a third of the rays were interpolated at 2 pixels; more rays per wall means more flat intervals).
  On a hall with long flat walls it would save more; on a maze with a corner every few cells, less.
* Start-up cost (all tables, on the Z80): see the last line of the tables. It is dominated by 16-bit division loops
  (1.6k T each, 320 + 700 to 1,500 of them) and could be cut by a factor of 5 to 10 by building the tables with
  incremental or table-driven methods, or the compiler can emit them as data (about 2.2 to 3.4 KB).

### Cost split and what limits speed

Profile of 128x96, 2-pixel columns, method B, every ray cast (T-states, average of 16 poses; `node profile.mjs`):

| routine | T | share |
|---|---:|---:|
| `AXIS` (per axis: abs, table lookup, the 8x16 multiply for the first side distance), 2 per ray | 58,043 | 23.5% |
| `RAY` (patching the DDA loop, quadrant dispatch, register set-up) | 28,608 | 11.6% |
| `CAST` loop (store results, advance the ray direction, counters) | 18,765 | 7.6% |
| DDA stepping (4 loop copies, 5.1 steps a ray, about 90 T a step) | 29,283 | 11.9% |
| hit handling and height lookup | 12,901 | 5.2% |
| *ray casting total* (64 rays: 2.3k T a ray) | 147,618 | 59.8% |
| `UCHB`: the straight-line row pairs | 25,981 | 10.5% |
| `DRAWB`: gather rays, per-record loop (about 650 T a ray) | 41,461 | 16.8% |
| `INSREC`: insertion sort | 16,260 | 6.6% |
| `DORUN`: patch, call, restore (about 150 T a run) | 10,931 | 4.4% |
| per-frame set-up (direction, plane, 2 divisions) | 4,344 | 1.8% |

1. **Casting is 60 percent of the frame, and it is per ray, not per DDA step.** One ray costs about 2.3k T of which the DDA
   steps are only about 0.46k (5 steps at 80 to 100 T). The rest is the two reciprocal lookups and first-step
   multiplications (0.9k), loop-copy patching and dispatch (0.45k), results and bookkeeping (0.3k) and hit/height (0.2k).
   So the cost is nearly proportional to the number of rays (columns), and almost independent of map size and of the
   viewing angle. This is why column width is the main lever.
2. **Drawing floor.** The pair loop is 26 T per pair of rows per byte column plus 74 T of cell fix-up per 8 pairs: about
   17.6 T per byte written, so a 128x96 window is **27k T minimum** (0.46 frame) and 128x128 is 36k; the measured chains
   (26k) are at that floor. B at 128x96 w2 spends 95k, i.e. 3.5x the floor: 41k gathering rays and looping over records
   (memory variables, `IY`-indexed accesses), 16k sorting, 11k setting up runs. A spends 113k (+10k clear). For w=1 the
   draw cost is 154k (B) or 223k (A): the overhead of eight rays per byte, not the pixels.
3. **Self-modifying code is used everywhere** (DDA immediates, `RET` patching). On a cartridge these routines (about
   0.8 KB) would be copied to RAM at start. The clear in A uses SP as its write pointer and needs `DI`; B needs none.
4. **Hand tuning headroom, not done:** the profile suggests 20 to 30 percent off the casting cost by keeping pointers in
   registers instead of memory variables, a cheaper first-step multiply (nibble tables built per frame, or log tables at
   about 1 percent accuracy) and a tighter dispatch, and about 30 percent off B's draw overhead by special-casing 1 and
   2 rays per byte. Both estimates are unmeasured.
5. **What is not in these numbers:** the frame interrupt (the flip handler costs 137 T; a music tick perhaps 0.5 to
   2k T), the game logic, sprites, the HUD, and **any memory contention** (TSRun has none; if the real machine contends
   writes to `$4000-$7FFF`, the drawing share, 25 to 50 percent of the frame, gets slower by an unknown amount).

### Code sizes and table RAM

| Item | Size |
|---|---:|
| Init (table builders, 5 routines + `DIV16`) | 325 B |
| Frame set-up (+`MULP`, `STEPOF`) | 243 B |
| Ray casting: `AXIS`, `RAY`, hit, 4 DDA loop copies (164 B; 176 B on the 32-wide map) | 495 B (+313 B with interpolation) |
| Method B drawing: `DRAWB`, `DORUN`, `INSREC` + row chain + unit table | 764 B for 128x96 (chain 341 B, table 98 B) |
| Method A drawing: `DRAWA` + clear (109 B) + row chain + unit table | 851 B (+109 B), chain 485 B |
| Data: quarter sine 130 B, 8 patterns 16 B, map 256 B (1,024 B for 32x32) | about 0.4 to 1.2 KB with alignment padding |
| **Whole program** | **2.0 to 3.1 KB** |
| Table RAM built at start | cosine 512 B, reciprocal 640 B, height 768 B (1,536 B for 32x32), pattern table 16 x rays-per-byte x 2 B (at most 128 B) |
| Per-frame RAM | variables about 100 B, ray arrays 2 x (rays+4) B, sort buffer 3 x rays-per-byte B |
| **Tables and buffers** | **about 2.2 KB (16x16) to 3.2 KB (32x32)** |

Row chains grow with the window height: 8 B a pair in A, 5 B in B, plus 20 B per 8 pairs (128x128: A 653 B, B 461 B).

## Pictures

These are the actual 1-bit bitmaps the Z80 code writes (checked equal to the reference), two pixel rows per text line
(half blocks), **in the window only** (the window is 128 or 64 pixels wide; the dither tile is fixed to the screen, so
shaded walls look like a pattern of dots). The scene is the 16x16 map, pose 1: a pillar room, a wall ahead and a
corridor mouth on the right.

**Frame 1: 128x96 window, 1-pixel columns (128 rays), pose 1 (x=3.5 y=6.5, 28 deg)**

```
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                        ██  ██  ▄▄  ▄▄  ▄▄  ▄▄  ▄▄                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                    █   ██  ██  ██  ██  ██  ██  ██  ██                                            ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                    █   ██  ██  ██  ██  ██  ██  ██  ██                                            ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                    █   ██  ██  ██  ██  ██  ██  ██  ██    ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀               ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
            ▀▀█▄█   █   ██  ██  ██  ██  ██  ██  ██  ██  ▄ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀       ▄ ▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
████████████▀▀█▄█   █   ██  ██  ██  ██  ██  ██  ██  ██  █ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▄ ▄ ▄▀ ▄ ▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
████████████▀▀█▄█   █   ██  ██  ██  ██  ██  ██  ██  ██  █ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▄▀▄▀▄▀ ▄ ▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
████████████▀▀█▄█   █   ██  ██  ██  ██  ██  ██  ██  ██  █ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▄▀▄▀▄▀ ▄ ▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
████████████▀▀█▄█   █   ██  ██  ██  ██  ██  ██  ██  ██  █ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ ▀ ▀ ▀ ▄ ▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
            ▀▀█▄█   █   ██  ██  ██  ██  ██  ██  ██  ██  ▀ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀     ▀ ▄ ▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                    █   ██  ██  ██  ██  ██  ██  ██  ██    ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀               ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                    █   ██  ██  ██  ██  ██  ██  ██  ██          ▀ ▀▀▀▀▀▀▀▀▀                       ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                    █   ██  ██  ██  ██  ██  ██  ██  ██                                            ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                        ██  ██  ▀▀  ▀▀  ▀▀  ▀▀  ▀▀                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
```

**Frame 2: the same view, 128x96 window, 4-pixel columns (32 rays)**

```
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                        ██  ██  ▄▄  ▄▄  ▄▄  ▄▄                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                    █   ██  ██  ██  ██  ██  ██  ██  ██                                          ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                ▄   █   ██  ██  ██  ██  ██  ██  ██  ██                                          ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                █   █   ██  ██  ██  ██  ██  ██  ██  ██  ▀ ▀ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀            ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
            █▀█▄█   █   ██  ██  ██  ██  ██  ██  ██  ██  ▀ ▀ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀      ▄ ▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
█████████████▀█▄█   █   ██  ██  ██  ██  ██  ██  ██  ██  ▀ ▀ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ ▄ ▄▀ ▄ ▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
█████████████▀█▄█   █   ██  ██  ██  ██  ██  ██  ██  ██  ▀ ▀ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▄▀▄▀ ▄ ▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
█████████████▀█▄█   █   ██  ██  ██  ██  ██  ██  ██  ██  ▀ ▀ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▄▀▄▀ ▄ ▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
█████████████▀█▄█   █   ██  ██  ██  ██  ██  ██  ██  ██  ▀ ▀ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀ ▀ ▀ ▄ ▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
            █▀█▄█   █   ██  ██  ██  ██  ██  ██  ██  ██  ▀ ▀ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀    ▀   ▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                █   █   ██  ██  ██  ██  ██  ██  ██  ██  ▀ ▀ ▀ ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀▀            ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                ▀   █   ██  ██  ██  ██  ██  ██  ██  ██          ▀ ▀ ▀▀▀▀                        ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                    █   ██  ██  ██  ██  ██  ██  ██  ██                                          ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                        ██  ██  ▀▀  ▀▀  ▀▀  ▀▀                                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
```

**Frame 3: the same view, 64x48 window, 2-pixel columns (32 rays)**

```
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
            ▄▄                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
            ██  ██  ██  ██                      ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
      ▄▄█   ██  ██  ██  ██  ▀ ▀ ▀ ▀▀▀▀▀▀▀▀    ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
███████▄█   ██  ██  ██  ██  ▀ ▀ ▀ ▀▀▀▀▀▀▀▀ ▄▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
███████▄█   ██  ██  ██  ██  ▀ ▀ ▀ ▀▀▀▀▀▀▀▀▀ ▀ ▄ ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
      ▀ █   ██  ██  ██  ██  ▀ ▀ ▀ ▀▀▀▀▀▀▀▀      ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
            ██  ██  ██  ██                      ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
            ▀▀                                  ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
                                                ▀ ▀ ▀ ▀ ▀ ▀ ▀ ▀
```

## Billboard sprites (optional part): measured

`sprite.asm`: a 32x32 source (one byte per source pixel, column-major) drawn square at a chosen height HS, one pixel
column at a time. Source column and source row are 8.8 accumulators (nearest neighbour), pixels are ORed in; the
destination is a ZX bitmap column, so the row pointer needs the `inc h` and cell fix-up on every row. Verified against a JS
reference. The same kernel with 4-pixel columns (blocky, HS/4 columns, nibble masks) is the second block.

| drawn size | 1-pixel columns | 4-pixel columns |
|---|---:|---:|
| 8x8 | 9.2k T (0.16 frame) | - |
| 16x16 | 31.3k T (0.53 frame) | 8.0k T (0.14) |
| 24x24 | 66.9k (1.14) | 16.9k (0.29) |
| 32x32 | 115k (1.97) | 29.1k (0.50) |
| 48x48 | 252k (4.30) | 63.6k (1.08) |
| 64x64 | 442k (7.53) | 111k (1.89) |
| cost per drawn column (HS rows) | about 110 T x HS | the same, but 1/4 of the columns |
| cost per destination pixel | 108 to 143 T | 27 to 31 T |

This does not include the depth test against the wall heights (one compare per column against `hh[ray]`, about 40 T)
or a mask for the background. A pre-scaled sprite (a handful of sizes, blit with pre-shifted copies, as in `../native` B1,
which measured 2,083 T for a 16x16 XOR blit, 8 T a pixel) would cost very roughly 8 to 10 T per destination pixel
(estimate, not built), 10 times less, at the price of memory for the scaled images. Column scaling is only affordable for small (16x16) or distant sprites or with blocky 4-pixel columns.

## Verdict

Budget = the worst of the 16 poses, frame-locked, **raycasting only** (leave the rest of the frame for the game; one
frame = 58,688 T, so 20 ticks/s = 3 frames = 176k T, 15 ticks/s = 4 frames = 235k T, 10 ticks/s = 6 frames = 352k T).

| target | what fits (window, column width, method) | worst pose | spare for the game |
|---|---|---:|---:|
| **>= 20 ticks/s** | 128x96 or 128x128, **4-pixel columns** (B), no interpolation | 158k / 167k | 18k / 9k |
| | 96x64 or 64x48, 4-pixel columns (A) | 112k / 69k | 64k / 107k |
| **>= 15 ticks/s** | **128x96, 2-pixel columns with interpolated rays** (B) | 234k | about 1k (average 195k: 40k) |
| | 96x64, 2-pixel columns (B) | 198k | 37k |
| | 64x48, 1-pixel columns with interpolation | 208k | 27k |
| **>= 10 ticks/s** | **128x96 or 128x128, 2-pixel columns** (B), no interpolation | 272k / 281k | 80k / 71k |
| | 96x64, 1-pixel columns with interpolation | 297k | 55k |
| (misses 10) | 128x96, 1-pixel columns, interpolated | 371k (9.5 raw, 8.6 locked) | -19k |

* **1-pixel columns at 128 wide do not reach 10 ticks/s** (9.5 raw, 8.6 locked at best) even with interpolation; at 96x64
  they make 10 to 12. One-pixel columns are only worth it for a small window.
* The visual difference between widths: 1-pixel columns give clean slanted edges and thin pillars; 2 pixels is still
  clearly "raycaster" (edges step by 2); 4-pixel columns look blocky (see the pictures) but are the only width that gets
  20 ticks/s at 128 wide. With dithered shading all three read as walls; the dither makes the column step less visible.
* **Sprites and HUD sharing the frame.** The HUD can live outside the 3D window (rows 0-47 and 144-191 around a 128x96
  window, so a text strip and a face redrawn only when they change cost nothing per frame). Enemies: at 20 ticks/s there are
  9k to 18k T left, which is one blocky 16x16 to 24x24 billboard (8k to 17k, 4-pixel columns) or nothing for a bigger one.
  At 15 ticks/s on the 96x64 window (37k to 65k left) three to four 16x16 blocky or one 32x32 blocky billboard fit. At
  10 ticks/s on 128x96 (80k left) about three 32x32 blocky billboards, or a pre-scaled sprite set for eight. A sprite
  drawn with 1-pixel columns costs 31k for 16x16 and 115k for 32x32 and should be avoided.
* **What a Doom-like game can be on this hardware.** The honest target is a **Wolfenstein / Catacomb-3D-class engine**:
  a flat grid map (16x16 or 32x32), no height changes, no textures (the shading above is a fixed dither tile, not a bitmap
  texture; a textured column costs about 100 T a pixel, so a textured 128x96 window would take about 10 frames), a
  128x96 window with 2- or 4-pixel columns at 12 to 20 ticks/s, 4 wall types, two shades, 3 to 6 enemy billboards
  (blocky or pre-scaled), a HUD outside the window. Double buffering (two display files) is needed because a frame takes
  2 to 4 video frames and a visible half-drawn picture would flicker; the draw code only needs the base address changed
  ($4000 or $6000). Colour can be added for free-ish: attributes are per 8x8 cell, so ceiling and floor bands cost
  nothing at run time, and per-column wall colour costs one attribute write per cell (about 190 writes, about 5k T: estimate)
  with 8-pixel-wide columns. **Not achievable:** Doom proper (BSP sectors, variable floor and ceiling heights, textured
  flats, 35 ticks/s). That needs a different renderer and about 10 to 20 times the computing power per pixel.
* Caveats that change the numbers: real-hardware memory contention is unmeasured (the draw share would slow down);
  the 60 Hz interrupt (music, input) takes a share per frame; hand tuning could give 20 to 30 percent more (see
  above); a different map style changes the DDA share (but not much) and the interpolation gain (a lot); and the test
  code limits the player position to non-zero fractions (a cell edge position needs a special case in the first-step
  multiply) and caps `1/|dir|` at 128 cells (rays within 0.45 degrees of an axis may step early).

## Limitations of this spike

* Static poses only, no collision or movement; tables are 16-bit, arithmetic exact against the JS reference by
  construction (the reference reproduces every truncation).
* Distance to height is `HH*32/dist` clamped (a wall at 1 cell or closer fills the window); there is no per-row
  perspective, no door/thin walls (wall types 1..4 are solid cells).
* The sorting and run machinery of B is generic for 1, 2, 4 and 8 rays per byte; it was not specialised.
* No sound, no attributes beyond setting the window to bright white on black, no interrupts in the harness.
