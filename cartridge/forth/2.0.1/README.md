# 2068-Forth 2.0.1 cartridge build

`forth_cart.dck` is the release's `roms/forth_cart.dck` from `2068-Forth-v2.0.1.zip`
(tag `v2.0.1`, merge commit `0dabe74`; the STICK fix), unchanged: Forth with no program, made by
`make cart` (`-DCARTRIDGE`) in the Forth repository. The IDE's ⬇ DCK / ▶ Test DCK for Forth
(`src/lang/forth/cartridge.js`, a port of the Forth project's `tools/forthcart.py`) takes
its HOME (chunks 0-1) and EXROM (chunk 5) and adds the program image from chunk 2
(DOCK `$4000`).

| File | Size | SHA-256 |
|---|---|---|
| `forth_cart.dck` | 24585 | `1f6732215d7373b93b401deb39dc3b79735620b45cef4141697fe566bc511885` |

Checked: the zip against `2068-Forth-v2.0.1.zip.sha256`; the cartridge's EXROM equals the
release's `graphics_exrom.bin` (unchanged since 2.0), and its HOME's `ROM_IDENTITY` (`$0B15`) is the
release HOME's, **`$F001`**, so a dictionary built on the release ROMs (the IDE's hidden
machine) is valid on the cartridge. 2.0's cartridge (`$FDBE`) refuses a 2.0.1 dictionary.
