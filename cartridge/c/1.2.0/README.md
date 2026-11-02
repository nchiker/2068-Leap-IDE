# Leap-C 1.2.0 runtime cartridge build

The runtime cartridge of Leap-C (release 1.2.0, tag `v1.2.0`, commit `e5cc932`; the
`leapc-1.2.0-cartridge.zip` asset, checked against the release's `SHA256SUMS` and its own),
used by the IDE's ⬇ DCK and ▶ Test DCK for Leap-C (`src/lang/c/cartridge.js`, a port of the
zip's `tools/cartpack.py`; the image format is still 1). It runs one compiled program on a
**stock** TS2068 from the dock.

| File | Size | SHA-256 |
|---|---|---|
| `leapc_cart_home.bin` | 16384 | `505d0f792c8cd4fe0591d90443b4d1a0a1e0d080fec6bb939692f53a4fb1b6d7` |
| `leapc_exrom.bin` | 8192 | `14ee24347eff4d0b28b9c5c3f60f39b2920180d2529967b891e53e86b787e877` (the release EXROM, equal to TSRun's `roms/leapc-1.rom` at `34b0794`) |
| `cartridge.json` | | the identity the cartridge accepts, `F6E9` |

The identity is the CRC-16/CCITT-FALSE of the release HOME then EXROM. 1.2.0's ROMs changed
(the display code of 2068-Forth 2.0), so 1.0.0 / 1.1.0 programs (`$E90E`) are refused by this
cartridge and 1.2.0 programs by 1.1.0's (`NO PROGRAM`). Layout as for 1.1.0: HOME in DOCK chunks
0-1, the program image (`"LCPG"`) at DOCK `$8000` (chunks 4-5, then chunk 2 past 16 KB), the
EXROM in chunk 6. See `docs/requests/LEAP_C_1_2.md`.
