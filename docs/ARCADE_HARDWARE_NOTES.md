# Leap Arcade: TS2068 hardware notes (Phase 0)

Written 2026-11-09 from source reading by sub-agents, with the contradictions checked by hand. **Nothing here
has been tested on a real TS2068**, and no Timex Technical Reference Manual or SCLD datasheet exists on this
machine. The sources are: TSRun (`tsrun/machine.js`, the emulator the Studio will run on), ZEsarUX
(`~/zesarux-source/src/machines/timex.c`), the Leap projects' own notes and code (which cite the TRM), and the
ROM disassembly in `~/Projects/TS-Pico-Study`. EightyOne has no source on this machine (only the `.exe`), so it
is not a source. Citations are `file:line` as the agents reported them; spot-check before relying on one.

Confidence key: **A** = TSRun, ZEsarUX and the Leap notes agree; **B** = one emulator plus Leap code that runs;
**C** = single source or contradiction, must be tested.

## 1. Ports

| Port | Use | Facts | Conf |
|---|---|---|---|
| `$FF` (SCLD DEC) write | video mode, interrupt, bank source | bits 0-2 mode (table below); bits 3-5 hi-res ink (paper = ink XOR 7, border follows); **bit 6 = 1 disables the frame interrupt**; **bit 7 = 1 selects EXROM, 0 selects DOCK** for the chunks `$F4` maps (TSRun `machine.js:843-846`, ZEsarUX `timex.c:142-160`, Leap `hardware.inc`) | A |
| `$FF` read | | returns the last value written in both emulators (TSRun `:910`, ZEsarUX `operaciones.c:7429`); real chip behaviour unknown. **Keep a shadow copy in RAM**, as Leap does (`PORT_FF_SHADOW`) | B |
| `$F4` (HSR) | bank per 8 KB chunk | bit n governs chunk n (`addr >> 13`): 0 = HOME (chunks 0-1 ROM, 2-7 RAM), 1 = alternate bank (EXROM or DOCK by `$FF` bit 7). Read returns last write | A |
| `$F5` | AY register select | write | A |
| `$F6` | AY data | write data; read returns the selected register | A |
| `$FE` | border (bits 0-2), beeper (bit 4), keyboard rows | as 48K | A |

### Video modes (`$FF` bits 0-2)

| Value | Mode | Pixels | Colour | Conf |
|---|---|---|---|---|
| 0 | normal | `$4000` | 8x8 attributes `$5800` | A |
| 1 | second display file | `$6000` | 8x8 attributes `$7800` | A |
| 2 | extended colour (8x1) | `$4000` | one colour byte per pixel row at pixel address + `$2000`, i.e. in the `$6000` file | A |
| 6 | hi-res 512x192 | even byte columns from file at `$4000`, odd from `$6000` | none: ink = bits 3-5, paper = ink XOR 7, no bright/flash | A (ZEsarUX also treats 4 as hi-res; TSRun implements 3, 4, 5, 7 in ways the README does not document, so **use only 0, 1, 2, 6**) |

Consequences for the design:

* **Dual-screen flipping uses mode 0/1 only.** Extended colour (mode 2) and hi-res (mode 6) occupy *both*
  display files, so a game that flips cannot also use 8x1 colour or hi-res. The language must make `MODE` choose
  one family: *flip* (8x8 colour, two buffers) or *8x1* (one buffer) or *hi-res* (one buffer, two colours).
* Display file 2 is `$6000-$77FF` pixels, `$7800-$7AFF` attributes (mode 1). A program cannot also keep code
  or data there (Leap-C's `#pragma hires` reserves region `$6000-$77FF` for this).
* Hi-res in this form is mono per whole screen (one ink/paper pair), so it suits text and line graphics, not
  coloured sprites.
* `MODE 1` in Leap V2 is the *extended colour* mode (value 2), not "second display file"; the name differs from
  the TRM's. The Arcade language must name modes by what they do (`FLIP`, `COLOUR8X1`, `HIRES`, or similar).

## 2. Memory and cartridge

* RAM is 48 KB at `$4000-$FFFF` (chunks 2-7). `$0000-$3FFF` is ROM (HOME) unless `$F4` bits 0-1 map another bank.
* **Mapping an alternate bank over a chunk hides the RAM there.** A cartridge's DOCK code mapped at `$8000-$BFFF`
  leaves only `$4000-$7FFF` and `$C000-$FFFF` as RAM. This is the central layout problem of phase 1 (32 KB of
  game plus the runtime against 48 KB of RAM).
* Cartridge handoff: see the DCK paragraph below. Leap V2 keeps its program image in DOCK chunk 3 (`$6000`);
  Leap-C keeps its image in chunks 4-5 (`$8000`) with EXROM/RAM in chunk 6. Both leave different parts of RAM free.
* DCK format (TSRun `dock.js`, ZEsarUX `timex.c:257-316`): blocks of 9 bytes (bank id, then 8 chunk kinds) +
  8 KB per chunk present. TSRun also accepts banks 254 (EXROM) and 255 (HOME) and kinds 1 and 3 (RAM); ZEsarUX as
  read here accepts only bank id 0 and kinds 0 and 2, with no writable flag. **Leap's existing cartridges use
  bank 0 and kinds 0 and 2 only** (the cartridge code is in DOCK chunks 0-1, so no HOME bank is needed), and they
  run on TSRun, ZEsarUX 13.0 and Fuse 1.9.1 with identical screens (`cartridge-build/Docs/CARTRIDGE_STATUS.md`).
  **Rule for Arcade: bank 0, kinds 0 and 2 only.**
* The stock ROM reaches a cartridge's entry about 103 frames (2 s) after reset, with **interrupts enabled**,
  IM 1, and a stack in chunk 3 (`SP=$61FE`); the cartridge starts with `DI` and sets its own `$F4`/`$FF`. Leap V2
  maps DOCK chunks 0-1 (runtime, 16 KB), 3 (program image at `$6000`) and 6 (EXROM, `$C000`) with `$F4=$43`.
* The EXROM is one 8 KB image repeated in every chunk it is selected for (both emulators).

## 3. Interrupt and timing

| Fact | TSRun | ZEsarUX | Verdict |
|---|---|---|---|
| T-states per frame | 58,688 (262 lines x 224) | 69,888 (312 x 224, the 48K figure) | **ZEsarUX uses 48K timing for the TS2068 (its source says so); TSRun's figures are the TS2068/NTSC ones (3.528 MHz, about 60.11 Hz) but are unverified on hardware.** Do frame budgets on TSRun, treat ZEsarUX frame counts as wrong |
| Frame interrupt | at line 0; **dropped, not latched, if interrupts are disabled when it fires**; instantaneous | fires at frame end | C |
| `$FF` bit 6 | checked at the frame boundary only | masks the interrupt | A |
| Pixel area starts | line 40, T 32 of the frame (about 8,960 T after the interrupt) | n/a | B |
| Contention | **none** | 48K pattern on `$4000-$7FFF` (its source: "TODO timex") | C: unknown on hardware |
| Rendering | per span, so mid-frame mode changes show | per scanline | B |

* A display flip written inside the frame interrupt handler happens about 8,960 T before the first pixel line
  (TSRun's geometry), so it is tear-free *if the handler is that fast and the interrupt is not delayed*. Because
  TSRun drops an interrupt that arrives while interrupts are disabled, **game code must never leave `DI` for a
  whole frame**, or frames and music ticks are lost silently.
* The interrupt handler budget: 58,688 T minus the game. Music tick, sprite redraw and flip all come out of it.
* A game written for 60 Hz runs at 60 Hz; PAL machines do not exist for the TS2068, so there is no 50 Hz case
  to support, but speed in an emulator whose host runs at 60 fps is the right unit (frames).

## 4. Sound and joystick

* AY-3-8912 through `$F5` (select) and `$F6` (data). Clock is CPU/2 = 1.764 MHz in TSRun (ZEsarUX uses the
  Spectrum's 1.7734 MHz; the difference is 0.5 %, an audible detune only; confirm on hardware).
* Registers 0-13 as the AY datasheet (tones, noise, mixer R7, volumes, envelope). Register 15 is not used.
* **Joysticks** are read through AY register 14 (I/O port A) with R7 bit 6 = 0 (input). Leap V2's `STICK`
  (`rom/exrom_v2_vm_core.asm:4813`) writes R7 bit 6 = 0, selects the joystick by putting **A8 (joystick 1) or A9
  (joystick 2) high** in the port address of the data read, and returns direction bits 0-3 (active high after
  inversion) plus fire as 16. TSRun reads the stick as active low: bit 0 up, 1 down, 2 left, 3 right, **7 fire**
  (`joystick.js:5-10`). TSRun's comment on the strobe contradicts its code; the code includes a stick when the
  address bit is high, which matches Leap's. ZEsarUX's source has no joystick-on-AY code in `timex.c` (only a
  light-gun in `ay38912.c`), so **joystick tests run on TSRun only until checked elsewhere**. Conf: B.
* (A previous survey said Leap V2 has no `STICK`. That is wrong: the kernel routine `STICK_READ` was removed, but
  the BASIC function is in the VM, and 2.1.1 fixed it.)
* Beeper: port `$FE` bit 4, as on the 48K. AY envelope and noise are not used by any Leap code yet; the
  driver in phase 6 is new.

## 5. What existing code can be reused

From the Leap V2 (2.1.2), Leap-C (1.2.0) and Forth (2.0.1) sources (survey by sub-agent; sizes approximate):

| Need | Where | Notes |
|---|---|---|
| Port equates and bank paging | `include/hardware.inc`, `kernel/bank/bank.asm` | `BANK_PAGE_EXROM_IN/OUT`; EXROM paging without `DI` is deliberate |
| Video mode switch with shadow of `$FF` | `GFX_SET_MODE` (V2 `graphics.asm` ~1122, Leap-C ~835) | refuses mode 1 if arrays reach `$6000` |
| Fast line, plot, char blit | `GFX_LINE`, `GFX_PLOT_CLIPPED`, `GFX_PUTCHAR`, `GFX_PIXEL_AT` | HOME graphics total about 2,071 B; line is the Forth 2.0 port, about 4x faster |
| Interrupt and keyboard | `kernel/interrupt/interrupt.asm`: `KBD_ISR_TICK`, `FRAMES` | IM 1, entry via `RST $38`; scans keys itself, so a game runtime replaces it |
| Key scan | `kernel/io/io.asm`: `IO_KEY_SCAN_ALL`, `IO_DECODE_KEY` | |
| Joystick | `BUILTIN_FN_STICK` in `exrom_v2_vm_core.asm`; Forth `STICK_READ` in `kernel/io/io.asm` | working code in both |
| Sprites | V2 sprite package (`ext_sprite_module.asm`, `GFX_SPRITE_CAPTURE/DRAW`): 8 slots, up to 4x4 cells of 9 bytes (attribute + 8 bitmap), background save/restore. Forth `core/sprite.asm`: 4 slots, 2x2 cells | cell-aligned and background-saving, **not** pixel-aligned; arcade sprites will need new pre-shifted or masked routines |
| AY | `rom/v2_ay_beep.asm` (`AY_BEEP`, channel A only, no envelope), Forth `core/soundext.asm` | the music/effects player is new |
| Cartridge boot and DCK build | `cartridge-build/`, `src/lang/c/cartridge.js`, `src/lang/basic/cartridge.js`, Leap-C `docs/CARTRIDGE.md` | handoff and chunk mapping solved |
| Hi-res reservation | Leap-C `PP_HIRES`, region 4 `$6000-$77FF` | the dual-screen mechanism in a compiler |

## 6. Contradictions found and how they were settled

| Claim | Resolution |
|---|---|
| "Mode 6 is a 64-column mode" vs "512x192" | Same mode: 512x192 hi-res (value 6), with ink/paper from bits 3-5. Naming differs across Leap docs |
| Bit 7 meaning disagreed in the Leap docs | 1 = EXROM, 0 = DOCK (TSRun, ZEsarUX and `hardware.inc` agree) |
| V2 has no `STICK` | False; see section 4 |
| ZEsarUX frame length | It is the 48K figure; not valid for the TS2068 |
| ZEsarUX DCK accepts only bank 0 | Not a problem: Leap's cartridges use bank 0 only and run on ZEsarUX 13.0 (screens identical to TSRun's) |

## 7. Hardware checklist (to run on a real TS2068 when possible)

0. **DOCK over the display files:** map a DOCK chunk over `$4000-$7FFF` for 3 frames while a static picture is shown;
   the picture must stay (the whole 64 KB asset-streaming design depends on this).
1. Frame length and interrupt rate (count `FRAMES` against a stopwatch over 5 min).
2. Whether the interrupt is latched when it arrives during `DI` (TSRun drops it).
3. Time from interrupt to the first pixel line; whether a flip inside the handler tears.
4. Contention on `$4000-$7FFF` (a timed loop run from each region).
5. Each `$FF` mode in turn, including a read-back of `$FF`; mode 2 colours; mode 6 ink/paper and border.
6. `$F4` / `$FF` bit 7 mapping with a DOCK cartridge that has code in chunks 2-7.
7. AY: tone, noise, envelope; the AY clock (pitch of a 440 Hz note); joystick 1 and 2 directions and fire.
8. A DCK or cartridge ROM that maps chunks over RAM, to prove the memory layout of phase 2.

## 8. Open questions this raises for phase 1 and 2

* Layout of RAM and DOCK for a 32 KB game plus a runtime: which chunks are code, which are data, and what stays
  RAM (stack, variables, sprite buffers, display files).
* Whether the runtime fits in DOCK chunks 0-1 (16 KB) or needs part of chunk 6. Chunk 3 (`$6000`) is also where
  the stock ROM leaves its stack at hand-off and where display file 2 lives: a flipping game cannot keep its image there.
* Whether to support flipping *and* 8x1 colour (impossible, section 1) or choose a per-game display family.

## 9. Third-party evidence added 2026-11-09 (jon0x0/AISkill_TS2068 and jon0x0/ts2068)

Both repositories have **no licence**: used as knowledge, nothing copied. Their emulator results are TSRun and Fuse
results; they state that **no SCLD cartridge was tested on a physical TS2068** (Sinistar: "physical hardware
validation is still outstanding"; The Crown: `physical_hardware_tested: false`). They cite the Timex TRM (which we
do not have). So they agree with our emulator facts but add no hardware proof.

* **Agrees:** modes 0, 1, 2, 6 are the documented ones (the 3/4/5/7 behaviour is TSRun's; use only 0/1/2/6); hi-res
  is 8 bits from file 0 then 8 from file 1 per 16 pixels with ink = bits 5-3 and paper = ink XOR 7; bit 6 inhibits
  the frame interrupt; bit 7 = 0 DOCK, 1 EXROM; frame = 224 T x 262 lines = 58,688 T, 60.1145 Hz, derived from the
  14.112 MHz counter chain (their design doc notes the TRM's "15.635 ms" paragraph conflicts).
* **First pixel line (8,992 T after the interrupt) is a fitted figure in TSRun, not measured** (its own comment).
  Our flip margin (about 8,900 T) is large enough that a few hundred T of error does not matter, but the
  checklist item stays.
* **ECM (mode 2) timing:** the TRM is cited for "a new pair every 1.134 us" = 4 T = one 8x1 cell. A write to an
  attribute byte takes effect for beam positions after it, so per-line colour tricks are possible; whether the
  hardware latches the attribute for a whole byte is an unconfirmed inference.
* **Contention: not measured anywhere.** Still unknown on hardware.
* **Interrupt during DI:** TSRun drops it. A real Z80 sees /INT as a level that the SCLD holds for some time, so a
  short DI window may still be serviced at EI on hardware. Design for the worst case (never DI across a boundary).
* **DOCK mapped over the display files:** the reference repos state the SCLD keeps fetching video from HOME RAM
  (the picture stays; CPU writes do not reach the screen). Sinistar and The Crown both depend on it, and TSRun
  models it. Unverified on hardware; first item of the hardware checklist.
* **DCK files with several blocks:** TSRun applies HOME (255), DOCK (0) and EXROM (254) blocks in order, so a DCK can
  exceed 65,545 bytes (a 163,867-byte demo has three). That is an emulator container feature, not extra
  cartridge capacity. Arcade uses one bank-0 block.
