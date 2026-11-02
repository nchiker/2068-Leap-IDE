# Leap-C's runtime cartridge: what the IDE can use (Q5 of LEAP_C_ANSWERS.md is implemented)

From: the 2068-Leap-C project, 2026-11-01. Release **1.1.0** (github.com/nchiker/2068-Leap-C). Full documents in that
repository: `docs/CARTRIDGE.md` (user and host), `docs/milestones/M12-cart.md` (the plan and report), `src/cart/cart.asm`
(its header comment is the authority for the image format).

## What is available

- **Release 1.1.0 asset `leapc-1.1.0-cartridge.zip`**: `roms/leapc_cart_home.bin` (the cartridge HOME, 16 KB),
  `roms/leapc_exrom.bin` (the release EXROM, 8 KB), a demo (`demo/hello.dck`, `demo/hello.bin`),
  `tools/cartpack.py` (+ `tools/cart_build.py`), `CARTRIDGE.md`, `SHA256SUMS`.
- In the repository: `make cart` (builds the cartridge HOME; no emulator), `make cart PROG=x.c [LIB=shapes]`
  (compiles on the release ROM in ZEsarUX and packs `build/cart/x.dck` and `x.bin`), `tools/c2cart.py`.
- **`tools/cartpack.py` is the reference packer** for a JavaScript port: `image()` (the program image), `verify()`,
  `place()` (the chunk layout), `dck()`, `flat_bin()`, and `model_load()`, a Python model of the cartridge's loader that
  checks an image the way the Z80 code does (`cartpack.py --selftest`). `tools/c2cart.py`'s `region_blocks()` is the
  reference for what to read from the machine.
- The cartridge was qualified on Fuse 1.9.1 and ZEsarUX 13.0 with their stock ROMs (160 test cases). Not run on a
  physical TS2068 or in TSRun with Leap-C's cartridge.

## The identity: it must match the release the IDE compiles with

The identity is the CRC-16/CCITT-FALSE (poly `$1021`, init `$FFFF`, MSB first, no reflection, no final xor) of the
release `leapc_home.bin` (16,384 bytes) then `leapc_exrom.bin` (8,192 bytes). **For 1.0.0 (and 1.1.0, whose ROM
images are byte-identical) it is `$E90E`.** The IDE compiles with the 1.0.0 ROM, so its images carry `$E90E` and the
1.1.0 cartridge accepts them. A later release that changes the ROMs changes the identity and needs its own cartridge
build; the cartridge shows `NO PROGRAM` for a program of another identity. The IDE can compute it from the ROMs it
loads, as V2's cartridge builder does.

## The program image (format 1)

At DOCK `$8000` (chunks 4-5); past 16 KB it continues at DOCK `$4000` (chunk 2), so an image is at most 24 KB (the four
regions hold about 19.9 KB). Little-endian words, except the CRC.

| Offset | Size | Content |
|---|---|---|
| 0 | 4 | `"LCPG"` |
| 4 | 1 | format `1` |
| 5 | 2 | identity |
| 7 | 2 | `RUN_MAIN` |
| 9 | 1 | `RUN_VOID` |
| 10 | 16 | `IMG_LIM` (four regions x [low:2][high:2]) |
| 26 | 1 | `LIB_LOADED` (`$F4` with a library in region 3, else 0) |
| 27 | n | blocks `[length:2][address:2][bytes]`, length 1-8192, inside one region; a length of 0 ends the list |
| end | 2 | CRC-16/CCITT-FALSE of every byte before it, **high byte first** |

**There is no `RUN_FNLINES` field** (the plan had one; it was dropped): the cartridge reports no source line.

## Capturing an image from the IDE's checker machine

`c2cart.compile_image()` does exactly this on a release-ROM machine; the IDE's checker should do the same:

1. Compile as the shell's `RUN` does but do not run: put the program in the source store, run the compile
   (`CC_PROGRAM`, as `SH_RUN` does) and stop where the compile has finished and the program has not started
   (`SH_RUN.ccdone`). Stop if `CC_ERRNUM` is non-zero. For a library program, load the library first as `LIB "name"` does.
2. Read the cells `RUN_MAIN` (word), `RUN_VOID` (byte), `IMG_LIM` (16 bytes) and `LIB_LOADED` (byte) by name from the
   release `.sym` files.
3. Read the program from RAM, region by region. The regions (the order of `IMG_LIM`): 1 `$C000-$DFFF`, 2 `$E000-$F17F`,
   3 `$F400-$F7FF`, 4 `$6000-$77FF`. For region i with limits [low, high] and end `E`:
   - a block `[base, low)` (the code) if `low > base`, and a block `[high, E)` (the static data) if `E > high`;
   - region 3, when `LIB_LOADED` is `$F4`: the whole region `$F400-$F7FF` as one block (instead of code and data blocks);
   - region 4 when `#pragma hires` reserved it (`low = high = E`): `$6000-$77FF` up to its last non-zero byte, if any.
   Check `base <= low <= high <= E` for each region; refuse otherwise.
4. **Region 1 lives in DOCK/EXROM chunk 6 and is RAM only while the EXROM is paged out.** Read `$C000-$DFFF` as RAM
   whatever the paging: `c2cart.py` uses `exectest.read_chunk6()`. Reading it through the paged EXROM would give the
   EXROM's bytes.
5. Pack with the identity of the compiling ROM. A block may not exceed 8192 bytes (split larger ones at region
   boundaries as the regions already do); a program whose image exceeds 24 KB cannot be packed.

## The DCK and the flat .bin

- **`.dck`**: byte 0 = 0 (DOCK bank id), then eight descriptor bytes for chunks 0-7 (`2` = 8 KB of ROM follows, `0` =
  absent; chunk 2 only when the image is over 16 KB; chunks 3 and 7 always absent), then the present chunks' 8 KB each in
  chunk order: 0, 1 (the cartridge HOME), [2], 4, 5 (the image, `$FF`-padded), 6 (the release EXROM). Same layout as
  2068-Forth's. For a program under 16 KB: 9 + 5 x 8192 bytes.
- **Flat `.bin`**: 65,536 bytes, chunks 0-7 in order (chunk n at n x 8192), `$FF` in absent chunks and in the unused
  tails of chunks 4, 5 and 2.

## Expected differences from RUN

Reports and final screens (rows 0-22 and the row-23 report) are identical for 115 programs compared. Differences:
`malloc`'s addresses (there is no source, so the heap starts lower); `PEEK($0000-$0007)` reads the LROS header; UDGs
are blank at every start; no `LINE` number in the report; a key after the report restarts from a cold start (the
image is copied afresh). A known hazard (an interrupt before the entry's `di`, BREAK held and a non-zero byte left at
`RUNNING` in stock RAM) is in `docs/CARTRIDGE.md`; it was forced in a test and never seen otherwise.

## Q5 of LEAP_C_ANSWERS.md

Q5 (hosting, EXROM at run time, banking, the image, after the program, the identity) is **now implemented** as planned,
with these points from the plan changed: the image has no `RUN_FNLINES` field; the report is the 1.0 one-row report
(`EXIT n`, `RUNTIME ERROR n MESSAGE`, `BREAK`); the identity is `$E90E`; and the release vehicle is 1.1.0 (an added
asset), not an update of 1.0.0. The "planned after 1.0" notes in LEAP_C_ANSWERS.md can be read as done.
