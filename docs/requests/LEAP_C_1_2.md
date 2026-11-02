# Leap-C 1.2.0: what the IDE needs

From: the 2068-Leap-C project, 2026-11-02. Release **1.2.0**, published: https://github.com/nchiker/2068-Leap-C/releases/tag/v1.2.0
(tag `v1.2.0`, commit `e5cc932`). It
answers `LEAP_C_DRAW_SPEED.md` and `LEAP_C_EXAMPLE_11.md`, and replaces section 3 of `LEAP_C_EXAMPLE_11_ANSWERS.md`.
Full documents in that repository: `CHANGELOG.md` (1.2.0), `docs/releases/v1.2.0.md`, `docs/milestones/M13-draw.md`
and `docs/milestones/M14-display.md`.

## What changed

New ROM images: the display code of 2068-Forth 2.0, ported as platform deltas D25-D29. **The pixels, screens and
glyphs are the same as 1.1.0's**, checked byte for byte, so the IDE's bitmap comparisons should not move.

| T-states (ZEsarUX) | 1.1.0 | 1.2.0 |
|---|---:|---:|
| `draw(0, 100, 255, 100)` (256 pixels) | 369,298 | 60,702 |
| `draw(10, 10, 100, 60)` (91 pixels) | 136,701 | 29,461 |
| A `plot()` call | 1,366 | 1,029 |
| `print`, a character (any class) | 1,467-2,933 | 590 |
| One scroll of program output | 236,677 | 133,659 |
| The interrupt, an idle frame | 2,028 | 225 |

Your speed test should come out at about a quarter of 1.1.0's frames. For example, 864 x `draw(10, 10, 100, 60)` should
take about 430 frames instead of 2,005. That figure is scaled from the table above, not measured in TSRun.

- **The banner** now reads `2068 LEAP-C 1.2`.
- **Manual Part 7 example 11** is your replacement, plus one test line, `// attr: 5 5 56` (black on white after
  `mode(0)`). Your override `tools/leapc-example-overrides/11-colour-lines-in-high-resolution.md` can be deleted.

## The images and the identity

| File | SHA-256 |
|---|---|
| `leapc_home.bin` | `510023ba68f14ef13a9c2a1820588a034f776b15ee3b455732c3e67ff4426e8b` |
| `leapc_exrom.bin` | `14ee24347eff4d0b28b9c5c3f60f39b2920180d2529967b891e53e86b787e877` |
| `leapc_zesarux.bin` (HOME then EXROM: your `KNOWN_ROMS` key) | `5f0cc97f5a5f16480cb3851e3d03a8eb71c3b5e7fc715d2305bd358d10f1a248` |
| `leapc_cart_home.bin` (the cartridge HOME) | `505d0f792c8cd4fe0591d90443b4d1a0a1e0d080fec6bb939692f53a4fb1b6d7` |

**The cartridge identity is `$F6E9`.** 1.0.0 and 1.1.0 were `$E90E`. A cartridge built from a 1.2.0 compile needs the
1.2.0 cartridge HOME, in `leapc-1.2.0-cartridge.zip`. A 1.1.0 cartridge shows `NO PROGRAM` for a 1.2.0 image, and the
other way round.

## Adding it to the IDE

- **`src/lang/c/leapc-roms.js`:** your `tools/leapc-rom-entry.py` works unchanged on the 1.2.0 build. Every name it
  reads resolves, and `romIdentity` reads `0xF6E9`. Run it on the emulator pack, `leapc-1.2.0-emulators.zip`
  (`roms/`, `symbols/`, `SHA256SUMS`), with the cartridge zip's directory as the third argument.
- **Addresses moved, names did not.** No stable name in the CHANGELOG list changed. The labels that are gone are
  internal ones: `GFX_SET_ATTR`, `MATH_COMPARE16`, `GFX_SCROLL_TEXT_UP`, `GFX_COPY_ROW_BITMAP`, `PUNCT_CHAR_TABLE`,
  `ROW_TABLE` and `IO_KEY_SCAN_ROW`.
- **`FONT_TABLE` is in ASCII order** (codes 32-126, 8 bytes each), Forth 2.0's layout, which the IDE already reads.
  The backtick, which has no glyph, has a blank slot.
- **The library ABI is unchanged** (the jump table at `$3FD0`), so library tapes built for 1.x still load.
- **`cartridge/c/1.1.0/`:** add `cartridge/c/1.2.0/` from `leapc-1.2.0-cartridge.zip`. Your `cartridge.js` port of
  `cartpack.py` needs no change, because the image format is still 1.
- **TSRun:** `nchiker/TSRun` `main` serves the 1.2.0 ROMs at `?rom=leapc` (`roms/leapc-0.rom`, `leapc-1.rom`) from
  commit `34b0794`. Your `tsrun` submodule picks them up when you move it to that commit.

## The assets

The GitHub release `v1.2.0` has `leapc-1.2.0-emulators.zip`, `leapc-1.2.0-hardware-kit.zip`,
`leapc-1.2.0-cartridge.zip`, the Word manuals and `SHA256SUMS`. It was qualified with `make qualify` on Fuse 1.9.1 and
ZEsarUX 13.0, passing every step; the results are in `docs/releases/v1.2.0.md`. It has not been run on a physical TS2068.

| Asset | SHA-256 |
|---|---|
| `leapc-1.2.0-emulators.zip` | `6e3ca09f153c5085af737ada70fd32a4123e954820e7406364bfe68e69d5453b` |
| `leapc-1.2.0-hardware-kit.zip` | `cbf8972459e9f49dc9d73073e3ffbf8678f164c5a6aaceb5c41587760b9c0b35` |
| `leapc-1.2.0-cartridge.zip` | `46f5b4b40c2918e097fd4a6c8729dc7fb83f0e99704523513a6f374936762315` |

A copy of all six release files, the same bytes as the GitHub release (`SHA256SUMS` checks them), is in
`docs/requests/leapc-1.2.0/` beside this file. It is uncommitted; delete it once the IDE has taken what it needs.
