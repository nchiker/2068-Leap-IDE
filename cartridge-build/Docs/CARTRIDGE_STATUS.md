# Leap V2.1 runtime cartridge — status

*2026-10-28. Built from 2068-Leap's `v2.1.0-emu.1` tag plus `leap.patch` (two commits: the original build, then
"Cartridge build: packages (program image format 2)"; `setup.sh` puts it in `leap/`, branch `cartridge`). The Leap repo itself is never written to. The design is in [LEAP_CARTRIDGE_BUILD.md](../../docs/LEAP_CARTRIDGE_BUILD.md);
this file records what was built, what was measured, and where the result differs from that proposal.*

## What exists

- **`make cart`** (in `leap/`) builds `build/cart/leap_v2_cart_home.bin` (16 KB) and
  `leap_v2_cart_exrom.bin` (8 KB) with `-DV2_CARTRIDGE`, then runs `tools/cart_check.py`.
  The release build from the same tree is unchanged: HOME `8c3d6c81…`, EXROM `e46e2065…`.
- **`tools/leap2cart.mjs`** compiles a program on the release ROMs, then packs the `.dck` and the flat
  64 KB `.bin`; `--package PKG.bin` installs a package image first and puts it on the cartridge.
  **`tools/cartpack.js`** does the packing without Node or DOM dependencies, so the IDE can use it
  (`IMAGE_FORMAT` 2, `MAX_PACKAGE` 1024, `cartFormat(cartHome)`, `buildProgramImage({..., pkg, format})`).
- **Images:** `leap_v2_cart_home.bin` SHA-256 `307b0616f411bef2d7c1ee99619ba78994b64a2a8b4bb0f50f3374bb626d8098`,
  `leap_v2_cart_exrom.bin` SHA-256 `c54be09c49d5cf84241d5c36911c85c2725d671f92f40745b6ee4afa48f5e9d7`
  (before packages: `fb16d609…` / `df50142d…`). A fresh clone from GitHub plus `setup.sh` reproduces both byte for byte.
- **Tests:** `tests/compare.mjs` (the cartridge against RUN on the release ROMs), `tests/scenarios.mjs`
  (behaviour) and `tests/zesarux_check.py` (ZEsarUX against TSRun).

## How the cartridge build works

Every symbol of the release build keeps its value in the cartridge build. `cart_check.py` checks this
on every build, along with which bytes differ. So the compiler and the VM are byte-identical to
2.1.0-emu.1, and the IDE's existing 2.1.0 checker produces the bytecode the cartridge runs.

| Where | Change |
|---|---|
| HOME `$0000-$0007` | LROS header `00 01 <CART_COLD_START> BC`, then `jp CART_COLD_START`. Jumping to `$0000` restarts the cartridge. |
| `MATH_RND_SEED` | Moved from `$0004` (now the chunk spec) to the end of HOME. Its one `call` operand (`$2050`) changes. |
| `BANK_PAGE_EXROM_IN` | `$FF` bit 7 forced to 0 (DOCK) and `$F4 = $43`. Same size. |
| `BANK_PAGE_EXROM_OUT` | `$F4 = $03` at depth 0, keeping chunks 0–1. Same 14 bytes, rearranged. |
| `V2_EXROM_ENTRY` | `jp CART_RUN` instead of `jp V2_COMMAND_LOOP`. |
| HOME free space | `CART_COLD_START` (`di`, `$F4 = $43`, `$FF = 0`, AY registers zeroed, `jp V2_COLD_START`) and `CART_LOAD` (map chunk 3 with interrupts off, check, copy, unmap). |
| EXROM free space | `CART_RUN`: an empty symbol table, `CART_LOAD`, the package's install entry if there is a package, then `V2_SESSION_START` and `V2_COMPILE_RUN.base` (what RUN does after a compile). Then `rst $00`. |

Leap's ordinary cold start (`V2_COLD_START`) runs unchanged after the stub, so the memory init,
keyboard ISR, `PAS_END = ARR2_BASE` and the `BANK_EXROM_DEPTH = 1` setting come from the release code.
Free space left (trailing `$FF`): HOME 174 bytes, EXROM 63 (198 / 73 before packages).

## Program image (DOCK chunk 3, `$6000`), format 2

| Offset | Size | Content |
|---|---|---|
| 0 | 8 | `"LEAPPROG"` |
| 8 | 2 | format `2` (the first cartridge build used `1`, which had no package field) |
| 10 | 2 | identity: CRC-16/CCITT (poly `$1021`, init `$FFFF`) of the compiling release's HOME then EXROM — **`$E0A5`** for 2.1.0-emu.1 |
| 12 | 2 | bytecode length *n*, 1..4011 |
| 14 | 5 | `SYM_COUNTS[0..4]` (numbers, strings, arrays, string arrays, labels) |
| 19 | *n* | bytecode, copied to `VM_CODE_BASE` (`$A655`); `EMIT_PTR` = its end |
| 19+*n* | 2 | package length *p*, LE16: 0 = none, at most 1024 |
| 21+*n* | *p* | the package image, copied to `EXTENSION_MODULE_BASE` (`$F400`) |

The cartridge refuses any other signature, format, identity or length (package too) and shows `NO PROGRAM`.

## Packages (format 2)

- `CART_LOAD` (HOME, `rom/v2_cart_home.asm`) copies the package image to `EXTENSION_MODULE_BASE` (`$F400`)
  and sets `V2_PACKAGE_LEN` (`$BE82`; `CART_PACKAGE_LEN` in `include/v2_cart.inc`, with an `ASSERT` that
  it equals `V2_PACKAGE_LEN` in `exrom_v2_cart.asm`). A length over 1024 is refused.
- `CART_RUN` (EXROM) calls the install entry at `$F400` when the length is nonzero, as `LOAD "NAME" EXT`
  does. CF from the install gives `NO PROGRAM`.
- The bytecode's package calls have the package's slot and generation baked in. The cold start's
  `EXT2_CLEAR_ALL` leaves the registry as on the IDE's checker, which does `EXT2_CLEAR_ALL` and then the
  install before compiling, so the calls match. The identity is unchanged (`$E0A5`).
- One package per program, as with `LOAD "NAME" EXT`. `buildProgramImage` refuses a package for a cartridge
  build whose format is 1 (`cartFormat`).

## Differences from the proposal

- `SYM_COUNTS` has 5 bytes in 2.1, so the header is 19 bytes, not 18.
- The identity covers HOME + EXROM only. `SA_ROM_CRC` also covers the package registry, which isn't
  part of the identity here: the package image travels with the program and the registry is rebuilt by
  the install.
- The run sequence isn't re-coded. The stub jumps into the release cold start, and the EXROM entry's
  jump is redirected.
- The AY is zeroed at entry, because the stock ROM has already written to it.
- There is no startup chime. A key after the end of a program, an error or BREAK restarts from cold,
  re-copying the image.

## Measured (TSRun, stock ROMs, `tools/probe/lros_probe.asm`)

The stock ROM reaches the LROS entry after about 103 frames (2 s) with **interrupts enabled**, IM 1,
SP = `$61FE` (its stack in chunk 3), **`$F4 = $43`** (it maps chunk 6 from the spec too) and `$FF = $00`.
An interrupt forced at the entry, before the `di`, runs Leap's ISR on the stock stack and returns.
The program then runs normally (`scenarios.mjs`).

## Verified

- **Equivalence with RUN** (`compare.mjs`, 1500 frames): the 619 cases of `V2_LANGUAGE_CASES.csv` and
  the 194 manual examples that need no package, on the format 2 build: **710 pass, 5 expected
  differences, 0 fail, 98 skipped** (deliberate compile-error cases that compile with no package either).
  The 15 more passes than the first build's 695 are language cases using package statements, now run
  with their package installed. The 5 known differences are all by design or from the harness: `PEEK(0)` reads 0, not 243;
  `FREE()` is 108-126 bytes larger (no source); `hw.stick_idle` (the reference run's stale B register
  strobes a stick; the cartridge prints the corpus's expected 0).
- **Equivalence with RUN, packages** (`node tests/compare.mjs build/corpus/package/*.bas`): the manual's
  33 `pkg=` examples (`extract_corpus.py` writes them to `build/corpus/package/`). When a program does not
  compile, `compare.mjs` tries each of the six release packages (`../packages/2.1.0-emu.1`, override with
  `PACKAGES=`) and compares with that package installed on both sides. **32 pass, 1 expected difference,
  0 fail, 0 skipped**: `mem.pkg.1.bas` (`FREE()` is larger, no source text; added to `EXPECTED`). Covers
  cbeep, graphics, mode, printer (`LPRINT`, `LLIST`), shapes and sprite.
- **Behaviour** (`scenarios.mjs`, 15 checks, all pass): the hand-off, the output, a key restarts from
  cold and the program runs again, `$F4` only ever `$43`/`$4B` and `$FF` bit 7 never set after the
  hand-off, the runtime error message, restart after an error, BREAK, INPUT, BEEP, `NO PROGRAM` for a
  wrong identity or a missing chunk 3, and the interrupt at the hand-off.
- **ZEsarUX 13.0** (the qualified emulator, stock `ts2068.rom`, smartload): `hello`, `demos/smoketest`
  and `manual/prog.lines.1` give screens byte-identical to TSRun's, with `$F4 = $43` and `$FF = $00` at the end.
- **Fuse 1.9.1** (stock `ts2068-0/1.rom`, the `.dck` given on the command line; run with no window,
  see the README): cartridges downloaded from the IDE in a browser (`hello`, `manual/prog.lines.1`)
  give final screens byte-identical to TSRun's (`fmfconv -S` of a 1200-frame movie). `hello`'s
  screen is complete at frame 124. The same two downloads also match in ZEsarUX.
- The release build's own `make check` passes on the `cartridge` branch.

## In the Leap IDE (2026-10-28)

The IDE's "⬇ DCK" button exports a cartridge: the two images
in `cartridge/2.1.0-emu.1/`, `src/cartridge.js` (`cartpack.js` in the IDE's style, plus
`pagingWrites` for `OUT` to ports 244/255), and `compile(store, symCountsSize, pkg)` on the checker
machine. A program that uses a package carries it (one package at a time, `packageFor`, the same message
as Run); the export refuses a package if the cartridge build's format (`cartFormat`) is below 2. It also
refuses a ROM/cartridge identity mismatch; a file name ending in `.bin` gives the flat image. Status:
"Saved X.dck (N bytes of bytecode and the SHAPES package): ...". The IDE's `.dck` is byte-identical to
`leap2cart.mjs`'s for `hello` and `prog.lines.1`. `tests/rom-checks.mjs` section 7 runs exported
cartridges on the stock ROMs, among them "the cartridge build takes packages (image format 2)" and "a
SHAPES program (CIRCLE + FILL) runs from the cartridge" (stock TS2068, about 5145 pixels set, POKE marker,
VM error 0).

## Not done

- **Tape and the Array Store**, and **returning to an editor** after the program ends.
- **Hardware** hasn't been tried. On a PicoROM, the flat `.bin` holds the eight chunks in
  address order, with `$FF` in absent ones.
