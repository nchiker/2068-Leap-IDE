# Leap 2.1.2-emu.1 runtime cartridge images

The cartridge build of Leap 2.1.2-emu.1 (`make cart` with `-DV2_CARTRIDGE`), used by the
"⬇ DCK" export. It runs one precompiled program on a **stock** TS2068 from the dock slot
(LROS cartridge: HOME in DOCK chunks 0-1, EXROM in chunk 6, the program image in chunk 3).
The program may carry one package (program image format 2): the cartridge installs it before the
program runs, as `LOAD "NAME" EXT` does.

| File | Size | SHA-256 |
|---|---|---|
| `leap_v2_cart_home.bin` | 16384 | `5c5c8e891c826fb566cca9958a5b9710d6546c2f95c3934959ebda58afddf11e` |
| `leap_v2_cart_exrom.bin` | 8192 | `e43a842a881855daa0499060874656bd49343a669746c5037cd7820c02220419` |

Built by `cartridge-build/setup.sh` (2068-Leap's `v2.1.2-emu.1` tag plus `cartridge-build/leap.patch`),
whose release build is byte-identical to the 2.1.2-emu.1 ROMs. Every
release symbol keeps its address in the cartridge build, so the compiler and VM are those of
2.1.2-emu.1 and the IDE's checker produces the bytecode the cartridge runs.

The images accept only programs compiled by the ROMs with identity **`$04B2`** (CRC-16/CCITT
of the 2.1.2-emu.1 HOME then EXROM); anything else shows `NO PROGRAM`. These images read format 2 only;
the IDE and `cartridge-build/tools/` write that format. The program image
format and the build are described in `cartridge-build/Docs/CARTRIDGE_STATUS.md`.
