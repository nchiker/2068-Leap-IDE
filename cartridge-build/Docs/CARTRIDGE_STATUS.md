# Leap V2.1 runtime cartridge — status

*2026-10-28. Built from 2068-Leap's `v2.1.0-emu.1` tag plus `leap.patch` (`setup.sh` puts it in `leap/`,
branch `cartridge`). The Leap repo itself is never written to. The design is in [LEAP_CARTRIDGE_BUILD.md](../../docs/LEAP_CARTRIDGE_BUILD.md);
this file records what was built, what was measured, and where the result differs from that proposal.*

## What exists

- **`make cart`** (in `leap/`) builds `build/cart/leap_v2_cart_home.bin` (16 KB) and
  `leap_v2_cart_exrom.bin` (8 KB) with `-DV2_CARTRIDGE`, then runs `tools/cart_check.py`.
  The release build from the same tree is unchanged: HOME `8c3d6c81…`, EXROM `e46e2065…`.
- **`tools/leap2cart.mjs`** compiles a program on the release ROMs, then packs the `.dck` and the flat
  64 KB `.bin`. **`tools/cartpack.js`** does the packing without Node or DOM dependencies, so the IDE can use it.
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
| EXROM free space | `CART_RUN`: an empty symbol table, `CART_LOAD`, then `V2_SESSION_START` and `V2_COMPILE_RUN.base` (what RUN does after a compile). Then `rst $00`. |

Leap's ordinary cold start (`V2_COLD_START`) runs unchanged after the stub, so the memory init,
keyboard ISR, `PAS_END = ARR2_BASE` and the `BANK_EXROM_DEPTH = 1` setting come from the release code.
Free space left (trailing `$FF`): HOME 198 bytes, EXROM 73.

## Program image (DOCK chunk 3, `$6000`), format 1

| Offset | Size | Content |
|---|---|---|
| 0 | 8 | `"LEAPPROG"` |
| 8 | 2 | format `1` |
| 10 | 2 | identity: CRC-16/CCITT (poly `$1021`, init `$FFFF`) of the compiling release's HOME then EXROM — **`$E0A5`** for 2.1.0-emu.1 |
| 12 | 2 | bytecode length *n*, 1..4011 |
| 14 | 5 | `SYM_COUNTS[0..4]` (numbers, strings, arrays, string arrays, labels) |
| 19 | *n* | bytecode, copied to `VM_CODE_BASE` (`$A655`); `EMIT_PTR` = its end |

The cartridge refuses any other signature, format, identity or length and shows `NO PROGRAM`.

## Differences from the proposal

- `SYM_COUNTS` has 5 bytes in 2.1, so the header is 19 bytes, not 18.
- The identity covers HOME + EXROM only. `SA_ROM_CRC` also covers the package registry, which isn't
  used here because packages aren't supported.
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
  the 194 manual examples that need no package. **695 pass, 5 expected differences, 0 fail.** 113 were skipped because they don't compile on the
  release ROMs either (deliberate compile-error cases, and statements from packages). The 5 known
  differences are all by design or from the harness: `PEEK(0)` reads 0, not 243; `FREE()` is 108–126 bytes larger (no source);
  `hw.stick_idle` (the reference run's stale B register strobes a stick; the cartridge prints the
  corpus's expected 0).
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
`pagingWrites` for `OUT` to ports 244/255), and `compile()` on the checker machine. It refuses
package programs and a ROM/cartridge identity mismatch; a file name ending in `.bin` gives the flat
image. The IDE's `.dck` is byte-identical to `leap2cart.mjs`'s for `hello` and `prog.lines.1`;
`tests/rom-checks.mjs` runs an exported cartridge on the stock ROMs.

## Not done

- **Packages** aren't supported in this version. A program using one doesn't compile on the release
  ROMs without the package, so it can't be packed.
- **Hardware** hasn't been tried. On a PicoROM, the flat `.bin` holds the eight chunks in
  address order, with `$FF` in absent ones.
