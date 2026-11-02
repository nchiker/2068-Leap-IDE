# Leap-C 1.1.0 runtime cartridge build

The runtime cartridge of Leap-C (release 1.1.0, tag `v1.1.0`, commit `f8db836`; the
`leapc-1.1.0-cartridge.zip` asset, checked against the release's `SHA256SUMS` and its own),
used by the IDE's ⬇ DCK and ▶ Test DCK for Leap-C (`src/lang/c/cartridge.js`, a port of the
zip's `tools/cartpack.py`). It runs one compiled program on a **stock** TS2068 from the dock.

| File | Size | SHA-256 |
|---|---|---|
| `leapc_cart_home.bin` | 16384 | `034e294d27f3550e37cbd269f07de06e181c32b86f0a2f37ad7e992e0a87e43a` |
| `leapc_exrom.bin` | 8192 | `02790ebe3bf851a749b8ff6810db5bf76bd39518ebda7731b47b4a5239bc4847` (the release EXROM, equal to TSRun's `roms/leapc-1.rom`) |
| `cartridge.json` | | the identity the cartridge accepts, `E90E` |

The identity is the CRC-16/CCITT-FALSE of the release HOME then EXROM; 1.0.0 and 1.1.0 have
byte-identical ROMs, so programs compiled by the IDE on 1.0.0 (`$E90E`) are accepted. Layout:
HOME in DOCK chunks 0-1, the program image (format 1, `"LCPG"`) at DOCK `$8000` (chunks 4-5,
then chunk 2 past 16 KB), the EXROM in chunk 6. See `docs/requests/LEAP_C_CARTRIDGE.md`.

Checked: the IDE's cartridge for the release's demo (`examples/cart_hello.c` at `v1.1.0`) is
byte-identical to the zip's `demo/hello.dck` and `hello.bin`; `tests/rom-checks.mjs` runs
cartridges (one with the shapes library) on a stock TS2068 in TSRun to their report.
