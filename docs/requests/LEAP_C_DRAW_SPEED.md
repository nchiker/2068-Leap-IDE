# draw() is the old GFX_LINE: about six times slower than Forth 2.0's LINE, same pixels

From: the Leap IDE (github.com/nchiker/2068-Leap-IDE), 2026-11-01.
For: the 2068-Leap-C project. Release `v1.1.0` (`f8db836`; the 1.0.0 ROMs, byte-identical). A note, not a defect.

## What the IDE found

The IDE added a speed test to the Examples menu of all three languages, "Spinning squares" (IDE commit `1c74c46`,
`src/lang/spin-demo.js`): 18 frames of 12 turning squares, 48 lines a frame, with the same integer arithmetic in each
language. Leap-C, Leap-Forth 2.0 and Leap V2 BASIC draw exactly the same bitmap and attributes (the IDE's tests compare
them). The frames each took, in TSRun:

| | Leap-Forth 2.0 | Leap-C 1.0.0 | Leap V2 BASIC 2.1 |
|---|---:|---:|---:|
| Spinning squares (864 lines) | 522 | 1644 | 1901 |

Leap-C's time is almost all in `draw()`. Measured the same way (`frames()` / the frame counter before and after):

| Test | Leap-C | Leap-Forth 2.0 | Leap V2 BASIC |
|---|---:|---:|---:|
| 864 x `draw(10, 10, 100, 60)` / `LINE` | 2005 frames | 422 | 2036 |
| 100 x `draw(10, 10, 100, 10)` (91 pixels) | 223 frames | 37 | |
| 100 x 91 `plot()` calls in a `for` loop | 249 frames (38 of them the empty loop) | | |
| The arithmetic of the speed test alone, 216 squares | 22 frames | | |

So a pixel of `draw()` costs about 1,700 T-states, about the same as a `plot()` call; Forth 2.0's `LINE` about 280.

## Why

Forth's own report says it: `docs/V2/milestones/Display_speed.md` in 2068-Forth (2026-10-31) found that Leap-C's and
Leap V2's `GFX_LINE` is "the one Forth had (memory cells, two `MATH_COMPARE16` calls and a full address setup per
pixel)", about 1,400 T a pixel, and rewrote Forth's: the major-axis Bresenham loop with r, dmin and dmaj in the
alternate registers, the screen address and mask stepped from pixel to pixel (`LINE_XSTEP`, `LINE_YSTEP`), the
attribute written only when the cell changes, signed 16-bit ends walked off the screen without drawing. It is
`GFX_LINE` in `kernel/graphics/graphics.asm` at `v2.0`. The report says it draws the same pixels as before (checked on
48,561 lines in Python), and the IDE's speed test agrees: Forth's and Leap-C's pictures are bit-identical.

## Suggestion

Port Forth 2.0's `GFX_LINE` (and `GFX_PIXEL_AT` for `plot()`) to `LIB_DRAW` (`src/runtime/library.asm`), keeping
Leap-C's rule that off-screen ends are moved to the edge if that is wanted (Forth draws the on-screen part of the
unbounded line instead; the manual's `draw` entry would need a word if that changed). The 115-program cartridge
comparison and the manual's `// pixel:` lines would show any pixel that moved. The same applies to Leap V2 BASIC's
`LINE`; the IDE has not sent this to the Leap project.

Nothing in the IDE depends on it.
