# 2068-Forth 2.0 cartridge build

`forth_cart.dck` is the release's `roms/forth_cart.dck` from `2068-Forth-v2.0.zip`
(tag `v2.0`, commit `50170f2`), unchanged: Forth with no program, made by `make cart`
(`-DCARTRIDGE`) in the Forth repository. The IDE's ⬇ DCK / ▶ Test DCK for Forth
(`src/lang/forth/cartridge.js`, a port of the Forth project's `tools/forthcart.py`) takes
its HOME (chunks 0-1) and EXROM (chunk 5) and adds the program image from chunk 2
(DOCK `$4000`).

| File | Size | SHA-256 |
|---|---|---|
| `forth_cart.dck` | 24585 | `4f07fd88f231eeedf8a34caf539a1c91110546244e44b398331dc385a4cc057f` |

Checked: the zip against `2068-Forth-v2.0.zip.sha256` (the release's `SHA256SUMS` lists
the ROMs, not this file); its HOME equals `build/cart/forth_boot_rom0.bin` of `make cart` at
`v2.0`, and its EXROM equals the release's `graphics_exrom.bin`. Every release label keeps its
address in the cartridge build, and its `ROM_IDENTITY` is the release's, **`$FDBE`**, so a
dictionary built on the release ROMs (the IDE's hidden machine) is valid on the cartridge.
