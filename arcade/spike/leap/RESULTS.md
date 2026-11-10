# Phase 1 spike: Leap V2 BASIC and Leap-C baselines (B1, B2, B3)

Run with `node run-leap.mjs <file>` from this directory (real ROMs from `tsrun/roms/`, through each
language profile's Run path). ROMs: Leap V2 **2.1.2-emu.1** (`leap-0.rom` / `leap-1.rom`) and Leap-C
**1.2.0** (`leapc-0.rom` / `leapc-1.rom`), both as pinned in the Leap-IDE checkout (TSRun 9893b46).

| Language | Benchmark | Frames | Correct? | Stored program (line store) | Compiled program | Source (chars) |
|---|---|---:|---|---:|---:|---:|
| Leap V2 BASIC | B1 sprites | 24535 | yes (bitmap identical) | 789 B | 285 B bytecode | 711 |
| Leap V2 BASIC | B2 tile map | 11517 | yes (bitmap identical) | 790 B | 253 B bytecode | 740 |
| Leap V2 BASIC | B3 numbers | 26081 | yes (primes 550, x 16673, s 14032) | 789 B | 254 B bytecode | 723 |
| Leap-C | B1 sprites | 9349 | yes (bitmap identical) | 835 B | 615 B image | 779 |
| Leap-C | B2 tile map | 14756 | yes (bitmap identical) | 825 B | 483 B image | 783 |
| Leap-C | B3 numbers | 1152 | yes (primes 550, x 16673, s 14032) | 1263 B | 4614 B image | 1196 |

Frames are `runFrame` calls from the injection to the end of the run (the same count as the ROM's
frame counter, which the speed test reads). Multiply by 58,688 T-states for the SPEC's T-state figure.
No run hit the 60,000-frame cap.

## Files

- `b1.leap`, `b2.leap`, `b3.leap`: Leap V2 BASIC.
- `b1.c`, `b2.c`, `b3.c`: Leap-C.
- `run-leap.mjs`: the runner (boots the ROM, injects, counts frames, compares with `reference.mjs`).

## Method notes and deviations

- **B1 BASIC** lists the shape's 128 set pixels once (`ox`, `oy` arrays) and PLOTs them with OVER 1.
  A first version tested all 256 cells with `IF` on every blit; it was correct in its arithmetic but
  ran past the 60,000-frame cap (at step t = 98 of 99, about 60,600 frames by linear extrapolation),
  so it was replaced.
- **B2 BASIC** draws rows 0-22 with `AT` and `PRINT CHR$(...);`. Row 23 is poked straight into the
  bitmap (address `20704 + line*256 + column`). Reason: printing into row 23 scrolls the whole screen
  on this ROM (the first version was exact for rows 0-22 and wrong everywhere else). The poked bytes
  are the same tile bytes.
- **B2 Leap-C** has no UDGs, so each tile byte is written through a pointer into the bitmap (`poke`
  style). This is the closest method; the C version does no `plot()` calls.
- **B3 results** are not read from the printed text (the ROM font is not at the usual address, so
  screen OCR was not practical). Both programs print the three lines and also write the numbers to
  attribute row 10 (`$5940`: marker `$A5` last, then LE16 primes, x, s). The runner reads those bytes.
  Attributes are not part of the bitmap comparison.
- **Leap-C bitmap timing:** the shell draws its report (`Finished: exit 0`) on row 23 when the run
  ends, which overwrites the bitmap's last text row. The runner therefore takes the bitmap at the
  instant the shell's RUNNING flag drops, before the report. With the bitmap read after the report,
  row 23 differed (B1: 35 bytes, B2: all 256 bytes of that row). BASIC has no report row and its
  bitmap is read at the end.
- **Leap-C B1** plots with `over(1)` (exclusive-or). **Leap-C B3** uses `unsigned` so the LCG's
  wrap-around gives the same values as the mod operations (mod 32768 and mod 65536 divide 65536).
- **Integer ranges:** Leap V2 promotes overflowing integer arithmetic to floats, so `x*5+3` and
  `s+x` are exact there. Array elements must be 16-bit integers (a float store gives run-time error 11;
  an index past `DIM` gives error 10 — `DIM bits(256)` is needed for indices 0..255).
- **Leap-C** rejects the constant `65536` (ERROR 16), hence `s = s + x` and no `% 65536`.

## Problems

- None blocks the six programs. Repeat runs gave identical frame counts (B1 BASIC, B1 and B2 Leap-C).
- `CLAUDE.md` describes Leap 2.1.1-emu.1, but the pinned `tsrun/roms` are **2.1.2-emu.1** (the runner
  reports the version from the ROM table). The BASIC numbers are for 2.1.2.
