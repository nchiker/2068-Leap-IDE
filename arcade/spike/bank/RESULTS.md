# Bank probe: mapping DOCK chunks 2, 3, 6 and 2+3 over RAM for the length of a copy (2026-11-10)

Question: with the frame interrupt running (no `DI`), can the CPU map DOCK chunk 2 (`$4000`), chunk 3 (`$6000`), chunk 6 (`$C000`) or
chunks 2 and 3 together (`$F4 = $3F`, one 16 KB window `$4000-$7FFF`) over RAM, `LDIR` bytes out into RAM chunk 7, and unmap, with
(1) every copied byte correct, (2) the RAM under the window unchanged, (3) the displayed picture unaffected, (4) no interrupt lost?
Runs on TSRun, ZEsarUX 13.0 and Fuse 1.9.1. Nothing here was run on real hardware.

## Files (all in `arcade/spike/bank/`)

* `probe.asm` (sjasmplus): LROS header, ISR at `$0038` in chunk 0 (flips `$FF` bit 0 from a shadow in chunk 7, counts frames), code in
  DOCK chunks 0,1,4,5 (`$F4 = $33` normally), variables `$FB00`, buffer `$E000-$FAFF`, stack down from `$FF00`, result record at `$FF00`.
* `build.mjs`: assembles and writes `build/probe.dck` (chunks 0-6; 2, 3, 6 hold byte i of chunk c = `(i*7 + (i>>8)*13 + c*31 + 1) & 255`),
  plus `probe-ctl.dck` (control, nothing mapped), `probe-storm.dck` (writes into the mapped window), `probe-neg1/2/3.dck` (negative controls).
* `tsrun.mjs`, `zesarux.py`, `fuse.sh` + `fuse-check.mjs`: the three runners. Logs of the runs: `build/logs/`.

What the Z80 does, per piece (80 pieces per iteration over banks 2, 3, 6 and 2+3, repeated until the ISR has counted 600 refreshes: 2 iterations on TSRun, 3 on ZEsarUX, whose frame is longer):
checksum (Fletcher) of the RAM under the piece's window range, map (`OUT ($F4)`), `LDIR` to the buffer, unmap, checksum again (must equal),
verify every byte of the buffer against the formula computed in Z80 code (shifts and adds, +7 per byte, +13 when the low index byte wraps;
for 2+3 the piece is split at 8192 and each part uses its chunk's constant). Pieces: 8 x 1 KB (whole chunk, varied destination offsets),
lengths 1, 255, 256, 257, 2 (offset 4095), 1 byte at offset 8191, 1000 from offset 7, the gap areas `$5B00-$5FFF` / `$7B00-$7FFF`,
8191 from offset 1 (banks 2, 3, into RAM chunk 6), 6911 from offset 1 (bank 6, the most the chunk 7 buffer holds; 8191 does not fit `$E000-$FAFF`),
and for 2+3: 512 bytes from `$5F00`, 4 bytes from `$5FFE`, 2 bytes from `$5FFF`, 6911 from `$4000+5000`, `$5B00-$61FF`, and sixteen 1 KB pieces over the 16 KB.
Pass: green border, `$20` attributes in both display files; fail (first error only): red border, `$10` attributes, `DI` + `jr $`.
Record at `$FF00`: `"BKPR"`, state (1 pass / 2 fail), fail kind (1 verify, 2 RAM under changed), chunk (23 = 2+3), offset, expected / actual byte, pieces passed, bytes verified, ISR count, iterations.

## Commands

```
cd arcade/spike/bank
node build.mjs
node tsrun.mjs                                  # all variants; prints the checks
python3 zesarux.py                               # needs ~/Applications/ZEsarUX-13.0 and ~/ts2068-debug; --tag/--expect for the other .dck
python3 zesarux.py build/probe-storm.dck --tag storm
python3 zesarux.py build/probe-neg1.dck --tag neg1 --expect fail     (also neg2, neg3)
sh fuse.sh build/probe.dck build/fuse 25          # prints the frame count, then runs fuse-check.mjs on the .scr frames
sh fuse.sh build/probe-storm.dck build/fuse-storm 25
sh fuse.sh build/probe-neg1.dck build/fuse-neg1 12; node fuse-check.mjs build/fuse-neg1 fail
```

## Results

| Question | TSRun | ZEsarUX 13.0 | Fuse 1.9.1 |
|---|---|---|---|
| (1) copied bytes correct (chunks 2, 3, 6, 2+3, straddling `$6000`) | **PASS**: 160 pieces, 171,364 bytes verified (2 iterations); 34 maps of chunk 2, 34 of 3, 32 of 6, 60 of 2+3 | **PASS**: 240 pieces, 257,046 bytes (3 iterations; two runs gave the same record) | **PASS** by the pass marker only: all 669 run frames then the green final screen (the record cannot be read; Fuse has no debugger here). Two further runs identical |
| (2) RAM under the window unchanged | **PASS**: before/after checksum equal for every piece (also with the write storm) | **PASS** (same checksums); also the DOCK data itself intact afterwards (DOCK zone 19 chunks 2, 3, 6: 0 bytes differ) | **PASS** by the pass marker (same in-Z80 checks) |
| (3) displayed picture unaffected while mapped | **PASS**: 647 of 647 rendered frames (FNV of the 512x192 area) are one of the two reference screens (the control cartridge's), alternating, 0 other | **PASS**: 335 samples of both display files' RAM (zone 0, bypassing the CPU's paging), 0 different; 27 of them taken while the `$F4` shadow said mapped (`$37`, `$3B`, `$73`, `$3F`) | **PASS**: 669 of 669 run `.scr` frames are display pattern A or B (342 + 327), 0 other; final frames all green |
| (4) no interrupt lost | **PASS**: ISR count 649 = 649 frames run; 584 interrupts were accepted with `$33`, and 65 with `$37`/`$3B`/`$73`/`$3F` mapped (17, 12, 18, 18); SP always in `$FC00-$FEFF`, return PC always in chunk 0/4 | **PASS**: ISR count 816 against 816.38 refreshes (T-states from `ei` to the final `di`, 57,054,965 T / 69,888) | **PASS**: 655 consecutive frames after the first flip alternate A,B,A,B with no repeat |

Controls (each made the probe fail as designed, so the verifier and checkers can fail):
* `neg1` (one copied byte of bank 3 corrupted): FAIL kind 1, chunk 3, offset 2049, on TSRun and ZEsarUX; Fuse ends on the red screen.
* `neg2` (a RAM byte under bank 2's window changed between the checksums): FAIL kind 2, chunk 2, offset 0, TSRun and ZEsarUX.
* `neg3` (the first chunk-3 byte of the 512-byte piece from `$5F00` corrupted, chunks 2+3 mapped): FAIL kind 1, chunk 23, offset 8192, TSRun and ZEsarUX.
* `ctl` (nothing mapped): the reference screens (two, alternating) and the ZEsarUX interrupt calibration (600 ISR / 600.28 refreshes).

## What is surprising

1. **ZEsarUX lets a DOCK chunk above `$4000` be written**: `poke_byte_no_time_timex` protects only `dir < 16384`. With the storm variant (16
   writes of `$EE` into the mapped window) TSRun and Fuse ignore them (pass, as E4 found for TSRun); on ZEsarUX the DOCK data itself changed
   (DOCK zone 19 chunk 2: 16 bytes) and the copy read `$EE`. The RAM underneath was untouched in all three. So the main test (which never writes into a window) is
   unaffected, but a cartridge must not write into a mapped window, and ZEsarUX will not catch a stray write as TSRun / Fuse do.
2. **The cartridge hand-off leaves `$F4 = $43` (DOCK chunk 6 mapped at `$C000`).** The first version of the probe zeroed `$C000-$DFFF` at entry and
   so wiped DOCK chunk 6 on ZEsarUX (it failed with bank 6 reading 0). The entry code must set `$F4 = $33` before touching RAM there (done in `probe.asm`). It was only
   visible on ZEsarUX because of point 1.
3. **None of the three can show DOCK bytes in the video.** ZEsarUX's renderer and `save-screen` read home RAM page 0 directly (`get_base_mem_pantalla` returns
   `timex_home_ram_mem_table[0]`, source `mem128.c`); TSRun's raster reads its RAM array (E4); Fuse's display code reads RAM too (not checked in source here, and I
   could not tell whether its movie `.scr` is a raster or a RAM dump). Question (3) is therefore a statement about these emulators' models, not about the real SCLD,
   as E4 already said. The real-hardware check stays: map a DOCK chunk over `$4000-$7FFF` for 3 frames over a static picture and look.
4. The 8191-byte piece does not fit the chunk 7 buffer (`$E000-$FAFF` is 6,912 bytes): banks 2 and 3 copy 8191 bytes into RAM chunk 6 (not hidden by them), bank 6 copies 6911.
5. TSRun's map time: 9.5 % of the run (3.6 M T) was with a window mapped; the rest is checksums and verify. ZEsarUX contention on `$4000-$7FFF` is its 48K pattern (not studied).
6. The first 14 `.scr` frames of the Fuse movie after the picture appears repeat file 1: the entry code runs with interrupts off while it fills memory. That is start-up, not loss (excluded in `fuse-check.mjs`, reported).

## Not verified

Real hardware (all four answers are emulator results); Fuse's counts of pieces (only the pass marker); whether Fuse's `.scr` could differ from its raster; mapped chunk 7 or chunks 4/5 (the code stays mapped); a copy
with interrupts disabled (not the question here).
