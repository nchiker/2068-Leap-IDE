# Answers from 2068-Leap (V2 BASIC): STICK, LINE's speed, high-resolution colour, the p q g glyphs

From: the 2068-Leap project (github.com/nchiker/2068-Leap), 2026-11-01.
To: the IDE's four findings on Leap V2 BASIC `v2.1.0-emu.1` (`c005159`), with `LEAP_FORTH_STICK.md` and
`LEAP_C_DRAW_SPEED.md` beside this file.

Everything below was measured on the release itself: a detached worktree of tag `v2.1.0-emu.1`, whose build
reproduces the published images byte for byte (HOME `8c3d6c81...`, EXROM `e46e2065...`; HOME 313 B free, EXROM
111 B). The two fixes proposed in sections 1 and 3 were built in a second worktree of the same tag and run in
ZEsarUX through `tools/qual/qharness.py`. **Nothing is committed or pushed in 2068-Leap, and no issue was
commented on.** The prototype is a patch kept outside the repository. Every fix waits for the owner.

**Update, 2026-11-02:** all of it is now released as `v2.1.1-emu.1`; see section 6.

## Summary

| Item | Finding | Fix | ROM bytes (HOME) | Changes | Release |
|---|---|---|---:|---|---|
| 1. STICK | **Confirmed in the source**: port A is an output when STICK reads it (boot leaves register 7 at `$F8`). The data sheet does not say what such a read returns. The stock TS2068 ROM does not set the direction either. A further defect: the joystick is never selected (1.4) | Clear bit 6 of register 7 before the read | **+10** | ROMs, identity | maintenance release (1.6) |
| 2. LINE | Confirmed: V2's `GFX_LINE` is the routine Forth and Leap-C replaced | Port Leap-C 1.2.0's `GFX_LINE` (its delta D25, Forth 2.0's loop with byte ends) | **about -60 (frees)**, estimate | ROMs, identity; not the packages | owner's choice: with item 1's release, or later |
| 3. Mode 1 colour | **Confirmed, and already reported as nchiker/2068-Leap#5** (open): colours go to the wrong pixel row for 168 of the 192 rows. One routine does it for PLOT, LINE, CIRCLE, FILL, CPLOT, BLOCK, FRAME and INVERT | `set 5,h` in `GFX_WRITE_PIXEL`; `GFX_SET_ATTR_EXT` removed | **-45 (frees)** | ROMs, identity; **package images unchanged** | maintenance release |
| 4. p, q, g | nchiker/2068-Leap#6 is **open and not fixed** on any branch; no release has it | The three glyphs, data only | 0 | ROMs, identity, manual screenshots | maintenance release |

With fixes 1, 3 and 4, HOME goes from 313 to 348 bytes free (built); adding the LINE port would bring it to about
410 (estimate). The EXROM does not change (111 B). Any of the four changes the HOME image, so each changes the
identity CRC (`$0AEF` in v2.1.0-emu.1). One release carrying all of them means one new ROM entry and one cartridge
rebuild for the IDE, not several.

---

## 1. STICK reads port A while it is an output

### 1.1 The source: confirmed

`BUILTIN_FN_STICK` (`rom/exrom_v2_vm_core.asm`; assembled into HOME at `$23CC`) selects register 14 and reads it.
It never writes register 7. Register 7 at boot is **`$F8`**: the startup chime's register table
(`rom/exrom_v2_shell.asm`, `CHIME_REGS`, the `V2_MAINT_CHIME_C` build the release uses) writes 248 to the mixer.
Bit 6 is 1, so port A is an output. `BEEP` (`rom/v2_ay_beep.asm`) reads register 7 and changes only bits 0 and 3,
so the port stays an output after any `BEEP`. `SOUND 7, n` and `OUT 245, 7 : OUT 246, n` set whatever *n* says.

The IDE's port numbers are right: `PORT_AY_REG` = `$F5` (245, select) and `PORT_AY_DATA` = `$F6` (246, data;
`include/hardware.inc`).

### 1.2 The data sheet

The GI AY-3-8910/8912 data sheet (the transcription at silicon-heaven.net, sections "I/O Ports", "Mixer Control-I/O
Enable (Register R7)", "I/O Port Data Store (Registers R16, R17)") says:

- "The direction (input or output) of the two general purpose I/O Ports (IOA and IOB) is determined by the state of
  bits B7 and B6 of R7." B6 is port A. The register figure labels the pair "Input Enable" with a bar: 0 = input,
  1 = output, as TSRun, ZEsarUX and Fuse all treat it.
- "Each pin is provided with an on-chip pull-up resistor, so that when in the 'input' mode, all pins will read
  normally high. Therefore, the recommended method for scanning external switches would be to ground the input bit."
- R16/R17 (registers 14/15) "function as intermediate data storage registers between the PSG/CPU data bus ... and
  the two I/O ports".
- Reset sets every register to 0, so after a hardware reset port A is an input. It is the ROM's mixer write of
  `$F8` that makes it an output.

**The data sheet does not say what a read of R16 returns while port A is an output**: neither the latch nor the
pins. So it neither confirms nor refutes TSRun's model (the latch) or ZEsarUX's (the pins). What it does say is
that switches are meant to be read in **input** mode. In output mode the chip drives the pins with the latch, here
0, and a switch to ground cannot change a pin already driven low. So on a real TS2068 STICK probably sees no
joystick at all while port A is an output, whatever the read returns. **Not tried on hardware**
(`docs/V2_HARDWARE_CHECKLIST.md` 2.8 and 5.11 are untested).

### 1.3 The stock TS2068 ROM

The stock HOME ROM's STICK (offset `$290E`, described here and not copied, under the project's provenance rule)
also selects register 14 and reads it **without setting the direction**. The stock ROM's own sound reset (offset
`$0EC8`) writes **`$FF`** to register 7, which leaves both ports outputs. So the stock machine has the same
behaviour, and V2 inherited the algorithm through V1's `STICK_READ`. (A stock EXROM routine at `$1168-$11FF`
saves registers 7 and 14, writes `$40` and 0, and restores them. That shows the ROM's authors knew the direction
bit, but the routine does not serve STICK.) So the stock ROM does not settle how real hardware behaves either: its STICK works only if a
real AY returns the pins while the port is an output, which nobody here has checked.

### 1.4 A second defect in the same routine: no joystick is selected

The stock read loads **B with the stick number** (1 or 2, its first argument) before `in a,(c)`, so the port
address is `$01F6` or `$02F6`. The TS2068 enables its two joystick connectors with the address lines A8 and A9
(inferred from the stock routine, not checked against a schematic). The stock function is `STICK(stick, what)`:
*what* = 1 gives the four direction bits, *what* = 2 the fire button (bit 7).

V2 has one argument and reads the address `B*256 + $F6` **with B never set**: whatever the VM left there. Its
`STICK(1)` is the stock *what* = 1 (directions) and its `STICK(2)` the stock *what* = 2 (**fire**), but of an
undetermined joystick, or none, or both. The manual's STICK entry says "Reads joystick *n* (1 or 2)" and that
`STICK(2)` giving 0 or 1 is "a hardware limitation of the machine's second joystick connection". The source does
not support that: `STICK(2)` is the fire bit. Neither TSRun nor ZEsarUX looks at the high address byte, so no test
can see this. The owner decides what STICK should mean. The two cheap fixes:

- (a) `ld b,1` before the read: both values come from joystick 1 (directions, fire). +2 B, and the manual entry
  is reworded.
- (b) the stock meaning: `STICK(n)` selects joystick *n* (B = *n*) and returns its directions and fire as one
  value (fire as bit 4: 0-31). About +6 B, a change of behaviour, and the manual entry is rewritten.

Recommended: (b), in the same release as the direction fix, since both need a hardware check anyway. Not built.

### 1.5 The proposed fix (built, measured)

Make port A an input in STICK itself, before reading, so nothing written to register 7 (the chime, `BEEP`, `SOUND`,
`OUT`) can break it:

```asm
        ld a,7
        out (PORT_AY_REG),a      ; the mixer
        ld c,PORT_AY_DATA
        in a,(c)
        and $BF                  ; bit 6 = 0: port A an input
        out (c),a
        ld a,$0E
        out (PORT_AY_REG),a      ; select AY register 14
        in a,(c)
        cpl                      ; (as before)
```

**+10 bytes of HOME** (the routine goes from 33 to 43 bytes; HOME has 313 free). It leaves register 7 with bit 6
clear, which the tones and noise ignore. Changing the boot value to `$B8` would not be enough on its own: a program
that writes `SOUND 7, 255` or 248 brings the problem back.

### 1.6 A test that fails in ZEsarUX without the fix

ZEsarUX returns the joystick lines in either direction, so STICK's *value* is 0 there before and after. The test
therefore reads the mixer back. AY registers can be read through port 246, and `IN` passes the full 16-bit port:

```basic
OUT 245, 7
OUT 246, 248
PRINT STICK(1); " "; STICK(2)
OUT 245, 7
PRINT IN(246)
```

| Build | Output (ZEsarUX) |
|---|---|
| `v2.1.0-emu.1` | `0 0` / **`248`** (port A still an output: fails) |
| with the fix | `0 0` / **`184`** (bit 6 cleared: passes) |

For the corpus (`tools/qual/corpus.py`, next to `hw.stick_idle`):
`T("hw.stick_input", "fn.STICK", [the five lines], Out("0 0\n184"), only=NEW)`. In TSRun the same program prints
`0 1` / `248` on the release and should print `0 0` / `184` with the fix, which makes the IDE's own check meaningful.

### 1.7 The manual

- **STICK** (`docs/manual/03_keywords.md`, line 2515): "Reads joystick *n* ... `STICK(2)` gives 0 or 1 -- a
  hardware limitation of the machine's second joystick connection" conflicts with the code (1.4) and needs
  rewording whichever option is chosen. Its example (`j = STICK(1)` in 0..15, `k = STICK(2)` in 0..1) stays true.
- **SOUND** (line 2437): its register table says register 7 is "which tones and noise are on (a bit set =
  *off*)", which says nothing about bits 6 and 7. It gives no advice that conflicts (unlike Forth's MIXER entry,
  "leave them 1"). The example `SOUND 7, 62` leaves port A an input. With the fix nothing needs changing. A
  sentence would help the reader: "bits 6 and 7 set the chip's I/O ports; STICK sets bit 6 itself".
- **BEEP** (line 210): "the other bits are kept". True, and harmless with the fix.
- `docs/V2_HARDWARE_CHECKLIST.md` 5.11 expects "joystick still read (the mixer's I/O-port bits are kept)". It
  should say STICK works after `SOUND 7, 255`.

### 1.8 What changes

ROM: **HOME** only (+10 B; +2 to +6 more for 1.4). Package images: no. Identity CRC: yes. Manual: the STICK entry
(and SOUND's sentence), hence the IDE's keyword data. Release: the maintenance release proposed in section 5.

---

## 2. LINE: assessment of the port (not built)

### 2.1 Where V2 stands

`LINE x0, y0 TO x1, y1` is `OP_LINE` (HOME). It pops the four values into the byte cells `GFX_LINE_X0..Y1`: x by
its low byte (taken mod 256), y clamped to 0..191. It then calls `GFX_LINE` (`kernel/graphics/graphics.asm`, HOME
`$081B`), which is exactly the routine Forth's Display_speed report describes: memory cells, `MATH_NEGATE16` and
two `MATH_COMPARE16` calls per step, and per pixel `GFX_WRITE_PIXEL`, which runs `GFX_PIXEL_ADDR_SETUP` (the full
address through `ROW_BASE_TABLE`) and then `GFX_SET_ATTR`. The IDE's 2,036 frames (against Leap-C 1.1's 2,005)
fit: it is the same code.

### 2.2 The donor: Leap-C's port, not Forth's

Leap-C has since built the port (its branch `draw-speed`, report `docs/milestones/M13-draw.md`, delta D25, for its
1.2.0). That is the better donor for V2:

- Leap-C's `graphics.asm` **is V2's file** with recorded deltas, so the cells, tables and names line up.
- Its ends are **bytes on the screen** (Forth's are signed 16-bit and walk off the screen). V2's `OP_LINE` also
  hands over on-screen bytes, so nothing in V2's LINE behaviour changes, and Forth's off-screen walk and edge tests
  are not needed.
- It keeps OVER (exclusive-or), which Forth dropped and V2 has (`OVER 1`).
- It already writes the mode 1 colour at the bitmap address + `$2000` (section 3).
- Its tests (`tools/linetest.py`) compare a Python model of **V2's own e2 loop** (Leap-C 1.1's `GFX_LINE` is V2's)
  with the ROM's bitmap, attributes and second display file in both modes and both OVER settings: all equal, over
  48 fixed and 648 random lines, and the loop modelled against the e2 form on 200,000 lines. The model was shown to
  notice a one-rule change (56 of 352 lines differ).

### 2.3 What V2 must keep that Leap-C dropped

| Kept | Why |
|---|---|
| `GFX_WRITE_PIXEL` with B = x, C = y, A = attribute, D = OVER | package service 7 (`include/v2_package_abi.inc`); `OP_PLOT`; the graphics and shapes packages call it |
| `GFX_READ_PIXEL` with B = x, C = y (Leap-C swapped them) | package service 6 (FILL uses it); `POINT` |
| `GFX_PLOT_CLIPPED` | service 5 |
| `MATH_COMPARE16` (Leap-C removed it) | four callers in the VM (`FOR`, comparisons) |
| `MATH_NEGATE16` | service 11 |
| The RAM cells `GFX_LINE_*`, `GFX_PIXEL_*` | stay defined, as Leap-C left them: no RAM layout change |

The alternate registers are free in V2 as in Leap-C: the only `exx` in V2's HOME and EXROM sources are inside
`GFX_PRINT_STRING_ATTR` and the tape code, and the interrupt handler does not use them. A `USR` routine may use
them, but never while LINE runs.

The package service table keeps the package images unchanged. **CIRCLE, FILL, BLOCK, FRAME, INVERT and CPLOT do
not get faster**: they plot through `GFX_WRITE_PIXEL` one point at a time. If `GFX_WRITE_PIXEL` is rebuilt on the
new address code (`GFX_PIXEL_AT`, as Leap-C's `plot()` now is), they gain what `plot()` gained (Leap-C: -25% a
call).

### 2.4 ROM bytes (estimate)

Leap-C's port returned **95 B** of HOME on top of its D22 fix. For V2, take off `MATH_COMPARE16` (26 B, stays) and
allow about 10 B for keeping the `GFX_WRITE_PIXEL` and `GFX_READ_PIXEL` entries: **about 60 B freed in HOME**,
after section 3's 45. EXROM unchanged. The real figure would come from `make budget` after the port. One thing to
watch: the build asserts that `LOW_CHAR_TABLE` (33 B) does not cross a 256-byte page. Section 3's prototype already
had to move it (to the start of the graphics routines, at no cost in bytes), and the port will move code again.

### 2.5 Speed (estimate)

Leap-C measured `draw(10, 10, 100, 60)` at 136,701 T before and 29,461 after (4.6x). V2's statement overhead is
small next to the line, so the IDE's 864 x `LINE 10, 10 TO 100, 60` should go from 2,036 frames to **about
450-500** in TSRun (Forth: 422). The spinning squares should go from 1,901 to about 550-650. These are scaled
figures, not measured in V2.

### 2.6 The same pixels: how it would be shown

- Leap-C's `linetest.py` model ported to V2's harness: random and edge lines, mode 0 and 1, OVER 0 and 1, bitmap,
  attributes and the second display file, against the model and against the `v2.1.0-emu.1` ROM.
- The 670-case qualification corpus (`make qual`: 667 PASS, 1 XFAIL, 2 N/A at the release) and its screen
  comparisons (`qscrdiff`).
- The manual's examples (`make doc-examples`; about 50 lines in the keywords, concepts, packages, examples and
  beginner's parts use LINE, several with pixel checks and screenshots).
- The IDE's own speed test, whose bitmap must stay identical to Forth's and Leap-C's.

One difference cannot be avoided, and it is not in the pixels: in mode 0 the old loop writes a cell's attribute for
every pixel, the new one with the first pixel of each cell. The final screen is the same. A program that changed the
attributes *while* a line was being drawn (an interrupt routine) could see a difference. Nothing in V2 does.

### 2.7 How it fits the release plan

The back-port plan (`docs/V2_LEAPC_BACKPORT_PLAN.md`) is complete through phase 6 (v2.1.0-emu.1). Phase 7 is the
V3 gate (decision F5) and has not started. LINE's speed is a Class B item under the plan's weighted rule (a large
gain, and it frees bytes rather than spending them), so it qualifies for a v2.x release. Recommendation: **put it in
the same maintenance release as items 1, 3 and 4** if the owner approves. All four change the HOME image, so one
release means one identity change and one cartridge rebuild for the IDE. If the owner wants the bug fixes out
first, it can follow as the next minor release (v2.2).

**Waiting for the owner:** port it (yes / no), and in which release.

---

## 3. High-resolution colour on the wrong row

### 3.1 Confirmed (and already reported: nchiker/2068-Leap#5)

Issue **#5** ("MODE 1: PLOT and DRAW colour the wrong pixel rows"), opened 2026-11-01 from the Leap-C audit, is open
with no comments. The defect is the one D22 describes:

- `GFX_WRITE_PIXEL` (HOME `$07CF`) sets the pixel and then, when `GFX_MODE` is 1, rebuilds y from the character row
  and scanline and jumps to `GFX_SET_ATTR_EXT` (HOME `$0718`).
- `GFX_SET_ATTR_EXT` writes `$6000 + y*32 + col`. The colour byte of the bitmap byte at `$4000-$57FF` is at that
  address + `$2000`. Within a third, a row-by-row y*32 equals the interleaved offset only when the scanline equals
  the character row, so **24 of 192 rows** come out right: y = 0, 9, 18, ..., 63 in each third. The issue says the
  same.

### 3.2 Which statements: all of them, through one routine

Every drawing statement in mode 1 reaches the screen through `GFX_WRITE_PIXEL`:

| Statement | Where | Path |
|---|---|---|
| `PLOT` | HOME, `OP_PLOT` | `GFX_WRITE_PIXEL` |
| `LINE` | HOME, `OP_LINE` → `GFX_LINE` | `GFX_WRITE_PIXEL` per pixel |
| `CIRCLE`, `FILL` | shapes package | `GFX_WRITE_PIXEL` (service 7) |
| `CPLOT`, `BLOCK`, `FRAME`, `INVERT` | graphics package | `GFX_WRITE_PIXEL` (service 7) |
| `MODE 1` | mode package → `GFX_SET_MODE` (service 1) | clears all of `$6000-$77FF` to the default; not affected |

No package writes a colour byte itself, so **the fix is in the ROM only; the six package images do not change**
(built and compared: cbeep `5b863713...`, graphics `8c414c4d...`, mode `cbefadc4...`, printer `bbb63c25...`, shapes
`729adc61...`, sprite `5c7db935...`, identical before and after).

Not part of this defect, noted for completeness: in mode 1 the text attribute writes (`PRINT`, the sprite cells via
`GFX_CELL_ATTR_ADDR`) still go to `$5800-$5AFF`, which mode 1 does not display. That is a separate design question
(what colour text should have in mode 1), not a wrong address.

### 3.3 The fix (built, measured)

`.ext_attr` in `GFX_WRITE_PIXEL` becomes Leap-C's D22 / Forth's `734a966`. HL still holds the bitmap byte's
address there:

```asm
.ext_attr:
    set  5, h                      ; the colour byte: bitmap address + $2000 (laid out like the bitmap)
    ld   a, (GFX_PIXEL_ATTR)
    ld   (hl), a
    ret
```

`GFX_SET_ATTR_EXT` has no other caller and goes. **45 bytes of HOME freed** (Leap-C: 42). `LOW_CHAR_TABLE` then
crossed a page and its ASSERT failed, so the prototype moves the table to the start of the graphics routines (before
`GFX_CLS`), at no cost in bytes. `include/hardware.inc`'s comment on `SECOND_DISPLAY_ADDR` describes the old layout
and needs correcting. Section 2's LINE port would include this fix if it came first.

### 3.4 The test (colours, not only pixels)

In mode 1, eight pixels in one character row (y = 80 to 87, column 3), each with its own ink, then a horizontal and
a vertical `LINE`, and the colour bytes read at the bitmap address + `$2000`:

```basic
MODE 1
INK 1
PLOT 24, 80
INK 2
PLOT 24, 81
...                                   (INK 3..7, 1 for y = 82..87)
INK 5
LINE 40, 82 TO 47, 82
INK 3
LINE 64, 80 TO 64, 87
FOR y = 0 TO 7
PRINT PEEK(16384 + 8192 + 2048 + 256 * y + 64 + 3); " ";
NEXT y
PRINT
PRINT PEEK(16384+8192+2048+512+64+5); " "; PEEK(16384+8192+2048+64+8)+PEEK(16384+8192+2048+7*256+64+8)
MODE 0
```

(`packages=("mode",)` in the corpus.) Paper 7 and ink *n* give 56 + *n*.

| Build | Row of eight | LINE |
|---|---|---|
| `v2.1.0-emu.1` | `56 56 59 56 56 56 56 56` (only y = 82, a coinciding row, is right) | `61 112` (the vertical line's two ends are uncoloured) |
| with the fix | **`57 58 59 60 61 62 63 57`** | **`61 118`** |

The horizontal line sits on a coinciding row (y = 82) on purpose, as a control; the vertical one fails on the
release. A CIRCLE or BLOCK case (shapes / graphics package) adds nothing, since the path is the same routine, but
one would guard against a package that later draws on its own.

### 3.5 What changes

ROM: **HOME** only (-45 B). Package images: **no**. Identity: yes. Manual: no change needed. The MODE entry
describes colour per 8x1 pixels, which the fix makes true. The manual's mode 1 screenshots and pixel checks should
be rerun: an example whose colours were checked (if any) would have been checked against the wrong bytes.
Release: the maintenance release.

---

## 4. The p, q and g glyphs (nchiker/2068-Leap#6)

### 4.1 State

- **#6 is open**, opened 2026-11-01, with no comments and no label.
- **Not fixed** anywhere in 2068-Leap: `FONT_TABLE` (`kernel/graphics/graphics.asm`, HOME `$0961`) still has
  `p` = `$00, $F0, $88, $88, $F0, $80, $80, $80`, `q` = `$00, $78, ...`, `g` = `$00, $78, ...` on `v2-development`,
  on `backport/leapc` (`b30ca0c`) and on every local and remote branch.
- So **no release has it**. v2.1.0-emu.1 has the high glyphs.
- The sister projects have fixed theirs: Leap-C 1.0 (D24), 2068-Forth `a2672f1`, which is in its `v2.0` tag.

### 4.2 The fix

The three glyphs as #6 gives them (bowl on rows 2-5, descender rows 6-7, like `y`). Data only, **0 bytes**, in
HOME. `tools/qual/qglyphs.py` compares the rendered font with the source, so it follows the change without editing.
A case that pins the bowl to row 2 (as Leap-C's D24 test does) would catch a regression. The manual's screenshots
showing lowercase text (`docs/manual/images/charset.png` and others with p, q or g) need retaking, and the Word
editions need regenerating.

### 4.3 Which release

The maintenance release (section 5). It changes the HOME image, hence the identity CRC.

---

## 5. Proposed release, and what it means for the IDE

No release after v2.1.0-emu.1 is planned in this repository yet. Proposed: a **maintenance release
`v2.1.1-emu.1`** (the same pattern as `v2.0.2-emu.1`), with items 1, 3 and 4, and item 2 if the owner approves it.

| Item | HOME image | EXROM image | Package images / tapes | Identity CRC | Manual (IDE keyword / error data) |
|---|---|---|---|---|---|
| 1. STICK | changes (+10 B; +2 to +6 for 1.4) | no | no | changes | STICK entry, SOUND sentence: yes |
| 2. LINE | changes (about -60 B) | no | no | changes | no (same pixels); screenshots rerun |
| 3. Mode 1 colour | changes (-45 B) | no | **no** (byte-identical, built) | changes | no |
| 4. p q g | changes (0 B) | no | no | changes | screenshots and Word editions only |

So for the IDE, one release with all of them means: a new ROM entry (`tools/leap-rom-entry.py`); **no new package
images** (the six from `v2.0.2-emu.1` stay valid; ABI 2.1 unchanged); regenerated keyword data only for the STICK
entry; and `cartridge-build/leap.patch` rebased onto the new tag, because the identity CRC changes. No error code
changes. `.sym` addresses move: the IDE should keep reading them by name, since no stable name changes.

**Waiting for the owner:**

1. The STICK direction fix (1.5): yes / no.
2. Joystick selection (1.4): option (a), (b), or leave it.
3. The LINE port (section 2): yes / no, and in this release or v2.2.
4. Items 3 and 4: fix (recommended; they are reported defects #5 and #6).
5. The release: `v2.1.1-emu.1` as proposed, and whether to comment on #5 and #6 when it is out.

The prototype of fixes 1 and 3 (a patch against `v2.1.0-emu.1`, 2 files) is ready to become a branch from
`v2-development` when approved. A full regression run (`make test`, `make qual`, `make doc-examples`) has **not**
been done on it; it would be part of building the release.

---

## 6. Update, 2026-11-01: built, and released as `v2.1.1-emu.1`

The owner approved all four items, the LINE port, joystick option (b) and Leap-C's interrupt change (D27). They
are built and qualified on branch `maint/v2.1.1`, and released as **2068-Leap V2 Enhanced `v2.1.1-emu.1` —
Graphics and Joystick Maintenance Release** (release record `docs/V2_1_1_RELEASE_STATUS.md` in 2068-Leap). This
section supersedes the estimates above.

### 6.1 What is in it

| Item | Built | Test that fails on `v2.1.0-emu.1` |
|---|---|---|
| 1. STICK | Port A made an input before each read; `STICK(n)` selects joystick *n* (A8/A9); 0-31 = directions + 16 for fire, for both sticks | corpus `hw.stick_input` (register 7: 248 -> 184); `tools/qual/tsrun_stick.mjs` on **TSRun's** core, which models both connectors, fire and the port direction (2068-Forth pointed this out): 9/9, `v2.1.0` 3/9 |
| 2. LINE | Leap-C's D25 (`b024dbc`), with V2's `GFX_WRITE_PIXEL` / `GFX_READ_PIXEL` (B = x, C = y; package services 6 and 7) kept as adapters and `MATH_COMPARE16` kept | `tools/qual/qlines.py`: the same pixels and mode 0 attributes as `v2.1.0` for every line with both ends on the screen (3,728 lines in all, mode 0 and 1, OVER 0 and 1, byte for byte), and a model that notices a one-rule change (122 of 344 lines) |
| 2a. LINE's ends (new) | `LINE` moves an end off the screen to the nearest edge, as the manual always said and PLOT does. v2.1.0 took x by its low byte: `LINE -10, 50 TO 100, 50` started at x 246 | corpus `gfx.line_offscreen` |
| 3. Mode 1 colour | `set 5,h`; `GFX_SET_ATTR_EXT` removed | corpus `pkg.mode.colour_rows` (`56 56 59 56 56 56 56 56` -> `57 58 59 60 61 62 63 57`) |
| 4. p q g | The three glyphs | `qglyphs.py` pins the bowl to rows 2-5 |
| D27 | Leap-C's interrupt idle path (`22a220b`) | BREAK and keyboard suites unchanged; timing below |

**Measured** (ZEsarUX; frames from the frame counter, T-states from `qrtime`):

| | v2.1.0 | v2.1.1 | |
|---|---:|---:|---:|
| 864 x `LINE 10, 10 TO 100, 60` | 1,707 frames | 384 | 4.4x |
| 100 x `LINE 0, 100 TO 255, 100` | 529 frames | 93 | 5.7x |
| 1,000 x `PLOT 50, 50` | 50 frames | 48 | |
| frame interrupt, idle | 1,993 T | 190 T | |
| frame interrupt, a tracked key released | 2,191 T | 1,402 T | |

Your TSRun figure for the LINE test (2,036 frames) should come down in proportion, to about 450-460 frames
(scaled, not measured in TSRun).

### 6.2 Corrections to sections 1-5

- **The EXROM image changes too** (section 5 said no): its code calls HOME routines through generated
  cross-bank addresses, and those moved. Its size and free space are unchanged (111 B).
- **HOME is 403 B free** (313 before), not the estimate of about 410. The STICK option (b) and the version
  text took a few bytes; D27 returned 3.
- **The manual's screenshot tool had the same mode 1 defect.** `tools/qual/manual_run.py` read the colour
  bytes as `$6000 + y*32 + x`, so the old ROM's wrong bytes made a right-looking `mode1_strips` picture. It is
  fixed, and Fuse's `display.c` confirms the layout (`display_line_start[y] + x + ALTDFILE_OFFSET`). **If TSRun
  renders mode 1 from the bitmap layout, the v2.1.0 ROM's mode 1 programs will have shown wrong colours in the
  IDE**; with v2.1.1 they are right.
- `STICK`'s manual entry is rewritten (0-31, joystick *n*, fire = 16), so the IDE's keyword data changes there.
  `LINE`, `MODE`, `SOUND` and Appendix C gained notes, and the boot text is `2068 LEAP V2.1.1`.

### 6.3 What changes for the IDE

| | |
|---|---|
| ROM images | both new: HOME `c79ce1cf...`, EXROM `ba7f0869...` (full hashes in the release record and the bundle's `SHA256SUMS`) |
| Identity CRC | **`$2A70`** (`v2.1.0-emu.1`: `$0AEF`): a new ROM entry (`tools/leap-rom-entry.py`), and `cartridge-build/leap.patch` rebased onto tag `v2.1.1-emu.1` |
| Packages | **unchanged**: the six images and `.tzx` tapes are byte-identical to `v2.0.2-emu.1` / `v2.1.0-emu.1`; package ABI 2.1 unchanged |
| Keyword / error data | the STICK entry's text; no error code changes |
| Symbols | `.sym` addresses move. Removed names: `GFX_PIXEL_ADDR_SETUP`, `GFX_SET_ATTR_EXT`, `BIT_MASK_TABLE`, `ROW_TABLE`, and the production `IO_KEY_SCAN_ROW`. New: `GFX_PIXEL_AT`, `LINE_XSTEP`, `LINE_YSTEP`, `LINE_PEND`, `LINE_ATTR`, `LINE_DELTA`. `FRAMES`, `GFX_MODE` and the package service table are unchanged |
| The IDE's checks | in TSRun, `PRINT STICK(1); " "; STICK(2)` now prints `0 0`; any IDE check that expected v2.1.0's `0 1` should change |

### 6.4 The release (2026-11-02)

| | |
|---|---|
| Tag | `v2.1.1-emu.1` on `v2-development` merge commit `4891681` (branch `maint/v2.1.1`, `d0ea306`, has the same tree) |
| GitHub release | https://github.com/nchiker/2068-Leap/releases/tag/v2.1.1-emu.1 (Latest) |
| Bundle | `2068-Leap-V2-v2.1.1-emu.1.zip`, SHA-256 `02c2f7820ebe445a8aa06e08724c6c32f29ccb1e10b5ddb72e5947e5159536cc` (with its `.sha256`) |
| ROMs | HOME `c79ce1cfe1d757036fb7c53974d53dd56117ec2d231c7b4c5f2e65c510dc295a`, EXROM `ba7f0869d3ea8641cbcdc25f62b131a1cc1e8614fd083a873d77313a00d5a1b5`, ZEsarUX combined `5715340055dd67a2ef0054e015e96588dffa4dc4982da35e44245eae856f1656` |
| Issues | nchiker/2068-Leap#5 and #6 closed with the release |

Qualification is in the release record, section 3. One result differs from v2.1.0's record: `qtapetol`
accepted 22 of 23 distortions (`speed 1.25` refused). A sweep showed this is a timing artifact of the test
setup, not a regression. Both ROMs load or refuse speeds 1.22-1.30 depending only on where the tape signal
starts relative to the frame, and the receiver runs with interrupts off. Tape loading in the IDE is unaffected.

