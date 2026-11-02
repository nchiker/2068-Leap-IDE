# Leap 2.1.1-emu.1 runtime cartridge images

The cartridge build of Leap 2.1.1-emu.1 (`make cart` with `-DV2_CARTRIDGE`), used by the
"⬇ DCK" export. It runs one precompiled program on a **stock** TS2068 from the dock slot
(LROS cartridge: HOME in DOCK chunks 0-1, EXROM in chunk 6, the program image in chunk 3).
The program may carry one package (program image format 2): the cartridge installs it before the
program runs, as `LOAD "NAME" EXT` does.

| File | Size | SHA-256 |
|---|---|---|
| `leap_v2_cart_home.bin` | 16384 | `14d50f5fcf1435c682657ed37bb21512526ccb978cc1216bed14e67706af4564` |
| `leap_v2_cart_exrom.bin` | 8192 | `2058303e728518295cd9ffb7f781bc54ba87c393c62d77702ad9238fe2b1c6c8` |

Built by `cartridge-build/setup.sh` (2068-Leap's `v2.1.1-emu.1` tag plus `cartridge-build/leap.patch`),
whose release build is byte-identical to the 2.1.1-emu.1 ROMs. Every
release symbol keeps its address in the cartridge build, so the compiler and VM are those of
2.1.1-emu.1 and the IDE's checker produces the bytecode the cartridge runs.

The images accept only programs compiled by the ROMs with identity **`$4E00`** (CRC-16/CCITT
of the 2.1.1-emu.1 HOME then EXROM); anything else shows `NO PROGRAM`. These images read format 2 only;
the IDE and `cartridge-build/tools/` write that format. The program image
format and the build are described in `cartridge-build/Docs/CARTRIDGE_STATUS.md`.
