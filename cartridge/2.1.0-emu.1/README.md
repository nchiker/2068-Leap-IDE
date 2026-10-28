# Leap 2.1.0-emu.1 runtime cartridge images

The cartridge build of Leap 2.1.0-emu.1 (`make cart` with `-DV2_CARTRIDGE`), used by the
"⬇ DCK" export. It runs one precompiled program on a **stock** TS2068 from the dock slot
(LROS cartridge: HOME in DOCK chunks 0-1, EXROM in chunk 6, the program image in chunk 3).

| File | Size | SHA-256 |
|---|---|---|
| `leap_v2_cart_home.bin` | 16384 | `fb16d6096bf47db77df5f4fa011ecd8e442a804be170fe4ef9f1141b670d859f` |
| `leap_v2_cart_exrom.bin` | 8192 | `df50142d2e48ac235eb358bdf642e9a8cb72b4579a6955883eaa8b9cb30f2868` |

Built by `cartridge-build/setup.sh` (2068-Leap's `v2.1.0-emu.1` tag plus `cartridge-build/leap.patch`),
whose release build is byte-identical to the 2.1.0-emu.1 ROMs. Every
release symbol keeps its address in the cartridge build, so the compiler and VM are those of
2.1.0-emu.1 and the IDE's checker produces the bytecode the cartridge runs.

The images accept only programs compiled by the ROMs with identity **`$E0A5`** (CRC-16/CCITT
of the 2.1.0-emu.1 HOME then EXROM); anything else shows `NO PROGRAM`. The program image
format and the build are described in `cartridge-build/Docs/CARTRIDGE_STATUS.md`.
