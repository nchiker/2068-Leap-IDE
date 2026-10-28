# Leap cartridge build

A runtime cartridge for **2068-Leap V2.1**: one compiled Leap program on a stock Timex Sinclair 2068
(stock HOME ROM and EXROM installed, nothing replaced). Leap's runtime and the program's bytecode go in
the DOCK slot as an LROS cartridge. There is no editor, command prompt or tape. Built for export from
the Leap IDE. The design is in [../docs/LEAP_CARTRIDGE_BUILD.md](../docs/LEAP_CARTRIDGE_BUILD.md), and where
the work stands is in [Docs/CARTRIDGE_STATUS.md](Docs/CARTRIDGE_STATUS.md).

## Layout

| Path | What it is |
|---|---|
| `leap.patch` | The cartridge build (`V2_CARTRIDGE` flag, `make cart`) as one commit on top of Leap's `v2.1.0-emu.1` tag. |
| `setup.sh` | Clones 2068-Leap into `leap/` (not committed) at the tag, applies `leap.patch`, runs `make cart` and checks the result against `../cartridge/2.1.0-emu.1/`. |
| `tools/leap2cart.mjs` | Compiles a `.bas` program with the release ROMs' own compiler and writes the `.dck` / flat 64 KB `.bin`. |
| `tools/cartpack.js` | The packing as a plain ES module (program image, DCK, flat BIN, identity), for the IDE to import. |
| `tools/cartrun.mjs` | Runs a `.dck` headless on TSRun's emulator core with the stock ROMs: PNG, memory dumps, hand-off trace. |
| `tools/mkdck.py`, `tools/probe/` | A generic DCK packer and the LROS hand-off probe cartridge. |
| `tests/` | Equivalence with RUN (`compare.mjs`), behaviour (`scenarios.mjs`), ZEsarUX cross-check (`zesarux_check.py`). |

## Build and use

```sh
./setup.sh                    # leap/ at v2.1.0-emu.1 + leap.patch; make cart (release images and build/cart/*.bin)
mkdir -p build
node tools/leap2cart.mjs tests/programs/hello.bas -o build/hello.dck --bin build/hello.bin
node tools/cartrun.mjs --dck build/hello.dck --frames 200 --png build/hello.png
```

Needs git, `sjasmplus`, Python 3 and Node 18+. TSRun's emulator core and the stock ROMs come from the
IDE's `tsrun/` submodule (`TSRUN=` to override). After changing Leap sources in `leap/`, commit there
and refresh the patch: `git -C leap format-patch -1 --stdout > leap.patch`. To run in ZEsarUX, use `--machine TS2068` with the stock `ts2068.rom`
and smartload the `.dck`. Fuse's dock cartridge option should also take it, but that hasn't been tried.

## Tests

```sh
python3 tests/extract_corpus.py                                   # the V2 corpora -> build/corpus/
node tests/compare.mjs build/corpus/lang/*.bas build/corpus/manual/*.bas
node tests/scenarios.mjs
python3 tests/zesarux_check.py build/hello.dck
```
