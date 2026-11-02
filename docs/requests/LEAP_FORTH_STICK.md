# STICK reads AY port A while the port is an output: `2 STICK .` gives 1 with no joystick

From: the Leap IDE (github.com/nchiker/2068-Leap-IDE), 2026-11-01.
For: the 2068-Forth project. Release `v2.0` (`50170f2`).

## What the IDE found

The IDE now runs every ```forth block of the manual the way `tools/forthtest.py` types `tests/doc/manual_*.fs`
(313 blocks; IDE commit `50fb417`, `tests/rom-checks.mjs` section 8). All of them print what their `\ expect:` lines
say, in TSRun, except one, the `STICK` example in `docs/manual/04_machine.md` (block at line 1214):

```forth
1 STICK .                \ expect: 0
2 STICK .                \ expect: 0
```

In TSRun the second line prints `1`. The manual says "With no joystick connected both give 0", and the test passes in
ZEsarUX, so `make check` cannot see this.

## Why

`STICK_READ` (`kernel/io/io.asm`) selects AY register 14 and reads it, but never sets the port's direction. Bit 6 of
register 7 (the mixer) chooses it: 0 = input, 1 = output. After boot Forth leaves register 7 at **`$F8`** (tones on,
noise off, both I/O ports outputs; measured in TSRun after 600 frames, and the same after `1 STICK . 2 STICK .`). So the
read happens with port A an **output**.

What a read of an output port returns depends on the emulator:

- **TSRun** (`tsrun/ay.js`, `ayReadReg`): with bit 6 of register 7 set it returns the register's own latch, here 0. After
  `CPL` that is `$FF`: device 1 sees all four direction bits set and gives 0 (the "all four set: no real input" rule
  hides it), device 2 takes bit 7 and gives **1**.
- **ZEsarUX** returns the joystick lines whatever the direction, so both give 0 and the manual's test passes.

TSRun models the AY-3-8912 the way the data sheet describes an I/O port set to output (a read gives the output
register). On a real TS2068 `2 STICK` therefore probably reads 1 with no joystick, and a joystick's lines may not be
seen at all while port A drives them. **Not tried on hardware.**

## Suggested fix

Make port A an input before reading it, in `STICK_READ` itself, so that nothing written to register 7 (`MIXER`, `SOUND`,
`BEEP`, the boot) can break it:

```asm
    ld   a, $07
    out  (PORT_AY_REG), a          ; select the mixer
    ld   c, PORT_AY_DATA
    in   a, (c)                    ; (the AY returns register 7 as written)
    and  $BF                       ; bit 6 = 0: port A is an input
    out  (c), a
    ld   a, $0E
    out  (PORT_AY_REG), a          ; then register 14 as now
    ...
```

Leaving the mixer at `$B8` instead of `$F8` at boot would not be enough: the manual's `MIXER` entry
(`04_machine.md`, line 713) tells the reader that bits 6 and 7 are "the chip's I/O port direction; leave them 1", which
is the output setting, so every `MIXER` that follows the advice brings the problem back. With the fix in `STICK_READ`
that advice can stay. A test that would catch it in ZEsarUX: `248 MIXER` first, then `2 STICK .` must still print 0.

## Also affected

Leap V2 BASIC (`2068-Leap`, `rom/exrom_v2_vm_core.asm`, `BUILTIN_FN_STICK`, the same algorithm from V1's
`STICK_READ`) has the same code and the same `$F8`: `PRINT STICK(1); " "; STICK(2)` prints `0 1` in TSRun. Leap-C has
no `STICK`. The IDE has not sent this to the Leap project; the owner decides.

## In the IDE meanwhile

`tests/rom-checks.mjs` keeps the block in a `KNOWN` list with its own check ("the known emulator difference is still
there"), so the IDE's tests stay green and notice when a new Forth release changes it.
