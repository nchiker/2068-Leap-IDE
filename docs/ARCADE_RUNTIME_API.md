# Leap Arcade runtime API v0 (milestone M2 contract, 2026-11-09)

The contract between the compiler (`src/lang/arcade/`, JavaScript) and the runtime (`arcade/runtime/v0/`, Z80).
Both sides are built against this file; the runtime's build writes `arcade/build/runtime.json` with the real addresses
so the compiler never hard-codes one. Scope of M2: one scene, up to 4 sprites of 16x16, scalar integer variables,
arithmetic, control flow, procedures. Text, tiles, sound, input words other than `STICK` come later.

## Image layout (layout L1, `docs/ARCADE_CARTRIDGE_MAP.md`)
* DOCK chunks 0-1: the runtime, fixed addresses, built by `sjasmplus` (not by the compiler).
* DOCK chunks 4-5, from `GAME_BASE = $8000`: the game image written by the compiler's linker:
```
$8000 DW  init_entry      ; CALLed once after boot, display cleared, interrupts enabled; returns with RET
$8002 DW  frame_entry     ; CALLed once per tick; returns with RET
$8004 DB  frame_div       ; refreshes per tick (60 / FRAMERATE: 1, 2, 3, 4, 5, 6, ... )
$8005 DB  sprite_count    ; 0..4
$8006 DW  sprite_table    ; sprite_count descriptors of 6 bytes: DB width (16), DB height (<= 16), DW data, DW 0
$8008 ... code, constants, sprite data
```
  Sprite data is `height` rows of 4 bytes `mask_hi, mask_lo, image_hi, image_lo` (leftmost pixel = bit 15 of each word;
  mask bit 1 = background shows; new = (old AND mask) OR image), as `arcade/runtime/m1_sprite.asm` today.
* The linker needs no assembler: it writes bytes into chunks 4-5 of the runtime's prebuilt image and saves a DCK
  (bank 0, kinds 0 and 2 only, via `arcade/tools/mkdck.mjs`'s logic ported to a browser-safe module).
* **As built:** boot reads the header once. `frame_div` 0 is read as 1; `sprite_count` above 4 is clamped to 4; a sprite height of 0
  is read as 1 and above 16 as 16; the descriptor `width` byte is not read (every sprite is 16 wide). The sprite data is read only
  at boot (to build the pre-shifted tables in RAM chunk 6), so it may lie anywhere in chunks 4-5. `init_entry` and `frame_entry`
  are CALLed through `CALL (HL)`, may use every register including IX, IY and the alternate set (the runtime keeps nothing in them
  between ticks), and must return with RET; their stack use is limited to the stack area below.

## Frame loop (runtime-owned)
Per tick (every `frame_div` refreshes): erase visible sprites in the hidden display file, call `frame_entry`, draw
visible sprites at their current positions, request the flip. Sprite positions persist until `RT_SHOW` / `RT_HIDE`
change them. `init_entry` runs once before the first tick. If `frame_entry` overruns, the flip is skipped (M1 behaviour).

**As built:**
* *Erase is per file.* Each display file has its own record (`SPR_DRAWN`) of where each sprite was drawn in THAT file; the tick
  erases the hidden file from its own record (not from `SPR_TAB`), so a sprite moved or hidden by `frame_entry` leaves no trace
  and a file never shows a position from two ticks ago. All sprites are erased first, then drawn in index order: a higher index
  lies on top. The v0 background is the fixed checkerboard (`BG_EVEN` `$AA` / `$55`, attribute `$38`) in both files, restored
  by the erase; tiles and backgrounds come later.
* *Timing.* A tick starts when the previous flip request has been honoured (`V_SYNC` = ready) AND `V_FRAMES >= V_TARGET`; `V_TARGET`
  is set to `V_FRAMES + frame_div` when a tick starts, so ticks are exactly `frame_div` refreshes apart (an overrunning tick is
  not "caught up": the next one starts after the late flip). The flip happens at the first interrupt after the request, i.e.
  one refresh after the tick started when `frame_div` is 1 and within the first refresh after the request otherwise.
* *`V_TICKS`* is the number of ticks begun and finished before the current one: `frame_entry` of tick n sees `V_TICKS` = n
  (n = 0 for the first); it is incremented just before the tick's flip request. A tick is never skipped by an overrun.
* *Stack and variables.* RAM chunk 7: runtime variables `$E000-$E0FF`, compiled variables `$E100-$EFFF` (boot zeroes all of
  `$E000-$EFFF`, so compiled variables start at 0), a canary word `$5AA5` at `$F000` (`STACK_CANARY`), stack `$F002-$FEFF`
  growing down from `STACK_TOP` = `$FF00` (3,838 bytes; the runtime itself uses at most 10), hand-off diagnostics `$FFE0-$FFE6`.
  The canary is checked at the start of every tick; if it was overwritten the machine stops with a red border and interrupts off.
* *RAM chunk 6.* `ROW_TAB` `$C000-$C17F` (192 words); `PHASE_TAB` `$C200-$CDFF`: sprite i's 8 phases at `PHASE_TAB + i*768`
  (phase p at `+ p*96`, 16 rows of `m0 i0 m1 i1 m2 i2`); `$CE00-$DFFF` free.
* *Registers.* No IX / IY / alternate registers anywhere in the frame loop or the ISR (boot uses IX / IY once).

## Calling convention
Compiled code runs with interrupts enabled, stack in chunk 7, may use all registers except it must preserve **IX/IY
if it uses them for its own purposes only between calls** (the runtime does not use IX/IY outside the ISR, which
preserves them). Runtime routines clobber AF, BC, DE, HL and preserve IX, IY and the alternate set. 16-bit values are
two's complement; results in HL.
| Routine | In | Out | Meaning |
|---|---|---|---|
| `RT_SHOW` | A = sprite index, BC = x, DE = y | - | make visible at (x, y); x clamped to 0..239, y to 0..176 |
| `RT_HIDE` | A = sprite index | - | hide |
| `RT_MUL` | HL, DE | HL = low 16 bits of HL*DE (signed wrap) | |
| `RT_DIV` | HL, DE | HL = HL DIV DE, truncating toward zero; DE = 0 gives 0 | |
| `RT_MOD` | HL, DE | HL = HL MOD DE, result takes the sign of the dividend (V2 rule: the compiler team checks `V2_LANGUAGE_REFERENCE.md` and matches it); DE = 0 gives 0 | |
| `RT_RND` | - | HL = 0..32767 (seeded; `RT_SEED` word is readable and writable) | |
| `RT_STICK` | A = 1 or 2 | HL = 0..31, V2 semantics (direction bits 0-3, fire = 16) | optional in M2 |

**As built (all seven are implemented and tested, `arcade/tests/m2-runtime-math.mjs`):**
* `RT_SHOW` / `RT_HIDE`: an index >= `sprite_count` (the header's, after clamping) is ignored. x, y are signed 16-bit and clamped
  (negative to 0, above the limit to the limit). The `SPR_TAB` entry holds the clamped values as words.
* `RT_MUL`: shift-and-add over the smaller operand (unsigned), 116 to 1,248 T (typical game operands 200-300 T).
* `RT_DIV` / `RT_MOD`: unsigned shift-subtract on the absolute values, 40 T (divisor 0) or about 770 to 1,460 T. `-32768 DIV -1`
  wraps to `-32768`; `-32768 MOD -1` = 0; `MOD(-7,3)` = -1 and `DIV(-7,2)` = -3 as in V2; `(a DIV b)*b + a MOD b = a` holds.
* `RT_RND`: 16-bit xorshift (`x ^= x<<7; x ^= x>>9; x ^= x<<8`, full period 65,535); the result is the new state AND `$7FFF`;
  `RT_SEED` starts at `RT_SEED_INIT` = `$ACE1` (so a game's sequence is the same on every run); a seed of 0 is read as 1.
  153 T.
* `RT_STICK`: Leap V2's `BUILTIN_FN_STICK` protocol exactly (AY register 7 bit 6 cleared, register 14 read with B = 1 or 2,
  inverted; all four direction bits set reads as none; fire = bit 7 -> 16). A other than 1 or 2 gives 0 (V2 raises error 15).
  194 T. TSRun only (see `ARCADE_HARDWARE_NOTES.md` section 4).
* All seven clobber AF, BC, DE, HL only (checked with sentinels in IX, IY and the alternate set), use no stack beyond their own
  CALL (a push or two), write no memory except `SPR_TAB` / `RT_SEED`.
`RT_CMP`-style helpers are not part of the API: the compiler emits comparisons inline.

## State the tests read (symbols in runtime.json)
`V_TICKS` (word, ticks completed; as built: see "Frame loop"), `V_FRAMES` (word, refreshes), `SPR_TAB` (4 entries of 6 bytes: `DB visible, DB 0,
DW x, DW y`), `RT_SEED`, `GAME_VARS_BASE` / `GAME_VARS_LIMIT` (the range where compiled code keeps its variables, 16-bit
slots, `$E100-$EFFF`), plus every `RT_*` entry address and the constants in `layout.inc` that tests need.

## runtime.json
```json
{ "version": 0, "symbols": { "RT_SHOW": 1234, "V_TICKS": 57345, "SPR_TAB": 57400, "...": 0 },
  "constants": { "GAME_BASE": 32768, "GAME_VARS_BASE": 57600, "GAME_VARS_LIMIT": 61439, "MAX_SPRITES": 4 },
  "image": "runtime.bin" }
```
`runtime.bin` = 65,536-byte memory image of the runtime build (chunks 0-1 filled; chunks 4-5 hold a placeholder
game image the linker overwrites). Produced by `node arcade/tools/build-runtime.mjs` into `arcade/build/`.

**As built:** `symbols` lists every non-local label and EQU of the build (the RT_* entries, V_*, SPR_TAB, SPR_HGT, SPR_DRAWN,
RT_SEED, the layout constants), `constants` the 32 the linker and tests need (`GAME_BASE`, `GAME_VARS_BASE`, `GAME_VARS_LIMIT`,
`MAX_SPRITES`, `STACK_TOP`, `STACK_CANARY`, header offsets `GAME_INIT`..`GAME_SPRTAB`, ...). The build also writes `runtime.inc`
(the symbols as EQUs, for assembling a hand-written game: `arcade/runtime/v0/test_game.asm`, `test_game4.asm`),
`runtime.dck` (the runtime with the placeholder game: it boots alone, init and frame are RET, 0 sprites), `runtime.sym`,
`runtime.lst`. `arcade/tools/build-runtime.mjs` also exports `assembleGame`, `linkGame` and `dckOf` for the tests.
Runtime size: 1,200 bytes of the 16,384 in chunks 0-1.

## Semantics both sides must share (the reference interpreter implements the same)
16-bit signed wrap on `+ - *`; `DIV` truncates toward zero and `MOD` takes the dividend's sign; comparisons signed; `AND`
`OR` `NOT` are logical (result 0 or 1) with short-circuit evaluation; `FOR` loops evaluate bound and step once;
division by zero gives 0 (v0 rule, to be replaced by a runtime error later); `BIT(v, n)` is 1 if bit n (0..15) of v is set.
