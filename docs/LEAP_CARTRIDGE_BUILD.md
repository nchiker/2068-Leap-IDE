# Leap V2 runtime cartridge — proposal for 2.1

*Leap V2 Web IDE, October 2026. Facts and addresses are from 2068-Leap
v2.0.2-emu.1 (source and the build's `.sym`/`.lst` files); 2.1 will move
addresses but the structure below should carry over. Items marked
**verify** have not been run yet.*

## Goal

A `.dck` (for emulators) and a flat 64 KB `.bin` (for a physical cartridge
such as a PicoROM) that **runs one Leap program on a stock TS2068**: stock
HOME ROM and stock EXROM installed, nothing replaced. The IDE builds it from
the editor's program. The cartridge carries Leap's runtime and the compiled
program; there is no editor, no command prompt and no tape.

Leap 2.0.2 cannot do this today: it starts only from its own HOME ROM, never
looks at the dock, and its paging routines would switch a cartridge's own
code out (see Banking). Four changes in 2068-Leap, behind one build flag,
make it possible; the rest is IDE work.

## Design in one paragraph

Leap's HOME image goes in DOCK chunks 0–1 and its EXROM image in DOCK chunk 6,
both unchanged in address (`$0000`, `$C000`), so the cartridge runs with
HSR (port `$F4`) = `$43` and DECR (port `$FF`) bit 7 = 0 — Leap's code is
always DOCK, the stock ROMs are never selected again after the hand-off. The
stock ROM starts the cartridge through an **LROS** header (the cartridge
type meant for "a language or full system"). The program arrives
**precompiled**: the IDE runs Leap's own compiler (it already does, for the
editor's error checking) and stores the bytecode in DOCK chunk 3. At boot the
cartridge copies it to `VM_CODE_BASE` and starts the VM directly, skipping the
compiler and the editor entirely.

## Why runtime-only works

- **Nothing at run time reads the source or the names.** Labels, `PROC` and
  `DEF FN` compile to bytecode offsets from `VM_CODE_BASE`; errors carry only
  `VM_ERROR_CODE`. The one reader of the symbol table during a run is the Array
  Store bind (`ARR_RUN_BIND` / `ARR_RUN_CHECK`), which returns at once when
  `PAS_END = $E000` — always true on a cartridge (no tape, no stored arrays).
- **The compiled state is tiny.** `VM_INIT` (`KTAB_VM_INIT`) and
  `VM_CARVE_PTRS` rebuild every run-time table from `SYM_COUNTS`. The
  cartridge needs only:
  - the bytecode `[$A655, EMIT_PTR)` — at most 4011 bytes, ends in `OP_HALT`;
  - `SYM_COUNTS[0..3]` (`$B800`–`$B803`: numbers, strings, arrays, string arrays).
  Literals are inline in the bytecode; the run-time tables start zeroed; arrays
  are created by `DIM` at run time.
- **The bytecode carries no absolute RAM addresses** (jumps and calls are
  offsets from `VM_CODE_BASE`, variables are table indexes), so it is valid for
  the runtime build it was compiled with — which the cartridge bundles.

## Cartridge memory map

| Chunk | Address | DOCK content | Mapped |
|---|---|---|---|
| 0–1 | `$0000`–`$3FFF` | Leap HOME image (cartridge build) — ROM | always |
| 2 | `$4000`–`$5FFF` | absent (screen in HOME RAM) | never |
| 3 | `$6000`–`$7FFF` | **program image** (below) — ROM | only while booting, interrupts off |
| 4–5 | `$8000`–`$BFFF` | absent (Leap sysvars, pool, bytecode, tables) | never |
| 6 | `$C000`–`$DFFF` | Leap EXROM image (cartridge build) — ROM | always |
| 7 | `$E000`–`$FFFF` | absent (segment 2, UDGs, package window, stack) | never |

Running HSR = `$43`; HSR = `$4B` only during the boot copy from chunk 3. DCK:
one block, bank `0`, descriptors `02 02 00 02 00 00 02 00`, then the four
8 KB images in chunk order (0, 1, 3, 6). The flat `.bin` is the eight chunks
in order with `$FF` fill.

Chunk 3 is Leap's second display file / free RAM, it overlaps no copy
destination, and the stack (`$FF00`) and interrupt handler (chunk 0) stay
visible while it is mapped.

## Changes in 2068-Leap (build flag, e.g. `V2_CARTRIDGE`)

### 1. Banking — four port writes

Every `OUT` to `$F4`/`$FF` in v2.0.2 (none read the ports back):

| Where (2.0.2) | Today | Cartridge build |
|---|---|---|
| `V2_COLD_START` `rom/v2_home.asm:61-62` (`$010A`) | `out ($FF),0` | unchanged (0 = DOCK) — plus add `out ($F4),$43` |
| `BANK_PAGE_EXROM_IN` `kernel/bank/bank.asm:77-88` (`$0F0F`/`$0F13`), on depth 0→1 | `$FF` \|= `$80`; `$F4` = `$40` | `$FF` unchanged (bit 7 stays 0); `$F4` = `$43` |
| `BANK_PAGE_EXROM_OUT` `kernel/bank/bank.asm:122-123` (`$0F25`), on depth 1→0 | `$F4` = 0 | `$F4` = `$03` — **writing 0 would unmap the cartridge's own chunks 0–1 and fall into the stock ROM** |
| `GFX_SET_MODE` `kernel/graphics/graphics.asm:1133-1147` | keeps shadow bits 3–7 | unchanged (bit 7 is 0 throughout) |

`BANK_EXROM_DEPTH` and the shadows (`PORT_FF_SHADOW` `$814A`) keep working as
they are. `OP_CALL_EXT` still pages chunk 6 out around package code (so FILL
gets RAM at `$C000`), now with chunks 0–1 kept. All EXROM addresses
(`V2_EXROM_*` slots at `$C009`–`$C04E`, `V2_CALC_ENTRY`'s `jp $C009`) stay
valid because the EXROM image keeps its address.

### 2. LROS header and entry stub

The stock ROM recognises an LROS by a header at DOCK `$0000`:

| Offset | Value | Meaning |
|---|---|---|
| 0 | any | unused |
| 1 | `$01` | cartridge type: LROS |
| 2–3 | entry, LE16 | |
| 4 | chunk spec, low-active (0 = DOCK) | chunks 0, 1, 6 → `%10111100` = `$BC` (bit 3 must stay 1: chunk 3 HOME during the hand-off) |

- Leap's `$0000`–`$0004` (`di; jp V2_COLD_START`) is never executed on a
  cartridge (the CPU resets into the stock ROM), so the header can replace it.
  `MATH_RND_SEED` at `$0004` (`rom/v2_lowrom_fill.asm`) must move.
- The entry should be a stub that starts with `di` — the stock ROM hands off
  with interrupts enabled (noted in Leap's own `docs/v1/NOTES_FROM_DESCENDANTS.md`
  item 5), and from the moment chunk 0 is DOCK an interrupt runs Leap's
  `V2_RST_38` with uninitialised sysvars. **Verify** that window on Fuse/TSRun.
- **Verify** how the stock ROM treats chunk-spec bits above 3 (chunk 6) at
  hand-off. The cartridge's own `out ($F4),$43` makes it irrelevant either way.

### 3. Cartridge cold start (`CART_COLD_START`, replaces the jump to the command loop)

1. `di`; `ld sp,$FF00`.
2. `out ($FF),0` (shadow 0); `out ($F4),$43`.
3. `MEM_COLD_INIT` (zeroes `$8000`–`$BFFF`) and the parts of `MEM_INIT` the
   runtime relies on; `VARS_START = V2_SOURCE_END`; `EXT2_CLEAR_ALL`;
   `KBD_ISR_INIT`; `PAS_END = $E000` (only `V2_EXROM_ENTRY` sets it today;
   left at 0, `ARR_RUN_INIT` would set `ARR2_END = 0`); `BANK_EXROM_DEPTH = 1`.
4. Empty source and symbol table: `PROG_END = PROG_AREA_START`;
   `SYM_BASE_V = SYM_END_V` → a single 0 terminator (so `VM_INIT`'s
   `ARRAYS_END = SYM_END_V + SESS_GAP + 1` is valid and `ARR_RUN_BIND` walks nothing).
5. Copy the program image: `out ($F4),$4B`; check the header (below); copy the
   bytecode to `VM_CODE_BASE` and `SYM_COUNTS[0..3]`; `out ($F4),$43`.
6. `im 1`; `ei`.
7. `V2_RESET_DISPLAY` (paper 7, border, mode 0); optional `STARTUP_CHIME`.
8. The run sequence V2 already uses after a successful compile
   (`V2_COMPILE_RUN.compiled` / `V2_SESSION_START`): `SESS_CODE_END = end of
   bytecode`; `KTAB_VM_INIT`; `ARR_RUN_INIT`; `VM_IP = VM_CODE_BASE`;
   `KTAB_GFX_CLS`; `KTAB_VM_RUN`.
9. When `VM_RUN` returns: error → `V2_RUNTIME_MSG` + `V2_SHOW_MESSAGE` (row 23);
   then wait for a key and go to step 3 (re-copy: a program may have `POKE`d its
   own bytecode). Alternative: show the message and `ei; halt` forever.

`RND_STATE` is 0 after cold start, so a cartridge produces the same random
sequence every time unless the program uses `RANDOMISE`.

### 4. Program image format (DOCK chunk 3, at `$6000`)

| Offset | Size | Content |
|---|---|---|
| 0 | 8 | `"LEAPPROG"` |
| 8 | 2 | image format version (`1` here; the built cartridge uses `2`, which adds a package after the bytecode: see `CARTRIDGE_STATUS.md`) |
| 10 | 2 | runtime build identity (e.g. the CRC-16 V2 already computes for `SAVE ... ALL`, `$F9E9` for 2.0.2) — the cartridge refuses an image compiled for another build |
| 12 | 2 | bytecode length *n* (≤ 4011) |
| 14 | 4 | `SYM_COUNTS[0..3]` |
| 18 | *n* | bytecode, copied to `VM_CODE_BASE` (`$A655`) |

Room for later fields (a package image for `$F400`, `EXT2_TABLE`, UDGs at
`$F180`) after the bytecode; see Not in the first version.

### Optional: drop what a cartridge never runs

The whole V2 image fits the cartridge as it is, so stripping is not needed
for space. If wanted later (a smaller, separately qualified runtime), the
listings show these are unreachable from the VM:

- HOME: compiler `$27FB`–`$3D4D` (5459 B — only the RST `$08`/`$20`/`$30`
  vectors and the `COMPILE_PAUSE/CLS/CLEAR` stubs reference it), `v2_saveall`
  (393 B), `v2_session_undo` (22 B), line store `MEM_LINE_*` (401 B),
  `VM_INIT_SESSION` (105 B), the SAVE ALL CRC code at `$0040`.
- EXROM: storage `$C310`–`$C628`, editor `$CF28`–`$D208`, the tape side of the
  Array Store `$C16E`–`$C307`, and the shell except `V2_RESET_DISPLAY`,
  `STARTUP_CHIME`, `V2_RUNTIME_MSG`, `MEM_CLEAR_V2`, `V2_SHOW_MESSAGE`,
  `V2_STATUS_SET_BAR_ATTR` and the run-time messages.
- Runtime size: about 9.3 KB HOME (9.7 KB with package support) and 3.0 KB
  EXROM.

## IDE side (Leap-IDE, after the Leap build exists)

- Ship the cartridge-build images (`leap_v2_cart_home.bin`,
  `leap_v2_cart_exrom.bin`) with a ROM-table entry keyed by their hash, like
  `src/leap-roms.js` does for the normal ROMs.
- **Export DCK**: compile the program on the hidden checker machine
  (`src/leap-check.js`, which runs the real compiler), capture
  `[VM_CODE_BASE, EMIT_PTR)` and `SYM_COUNTS[0..3]`, build the program image,
  and pack the DCK / `.bin` as in the memory map. The bytecode must come from
  the same build the cartridge carries (or one that produces identical
  bytecode) — the identity field enforces it.
- **Cartridge checks before export**: the editor already reports compile
  errors; add warnings for `OUT` to ports 244/255 (a program writing HSR/DECR
  can unmap the cartridge) and for package statements (not supported in the
  first version).
- **Test** in TSRun with its stock ROMs (`insertDock`; the stock ROM does its
  own LROS probe), then Fuse, then hardware.

## Not in the first version

*Packages have since been added (program image format 2); see `cartridge-build/Docs/CARTRIDGE_STATUS.md`.
The text below is the original proposal.*

- **Packages.** The compiler bakes a package's slot and generation into the
  bytecode, so a cartridge would need the package image at `$F400` plus
  `EXT2_TABLE` (`$BF00`, 168 B), `EXT2_REG_ARGTYPES` and `EXT2_GEN_COUNTER`, or a
  fresh install call at boot that reproduces the same slot. Fields in the
  program image can carry them later.
- **Tape and the Array Store** (`SAVE`/`LOAD` are commands, not statements).
- **Returning to an editor** after the program ends.

## To verify first (cheap, in an emulator)

1. Stock ROM LROS hand-off with chunk spec `$BC`: interrupt state at entry,
   whether chunk 6 is mapped by the ROM, and what an interrupt between hand-off
   and `di` does with Leap's ISR.
2. A Leap image with only the banking changes, started by hand in TSRun with
   stock ROMs (dock inserted, jump to the entry): editor appears, a typed
   program runs, BEEP and FILL (package) work.
3. The cold start of section 3 with a hand-made program image.
