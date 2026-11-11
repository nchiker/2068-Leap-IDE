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

## 10. Platformer (runtime v3) cross-emulator check, 2026-11-09

`arcade/build/platformer.dck` (Leap Runner, runtime v3, 32,777 bytes) on TSRun, ZEsarUX 13.0 and Fuse 1.9.1, compared at equal game ticks
(`arcade/tools/xemu/platformer-*`; order of the commands is in the header of `platformer-compare.mjs`). Method: the state is sampled at the runtime's
`WORK_END` (V_TICKS just incremented, the tick's work done), the same instruction on every emulator (TSRun by single-stepping each frame, ZEsarUX by a
PC breakpoint), and the hidden display file (V_HIDDEN) is the tick's finished picture. Compared: that 6,912-byte screen at 170 ticks (md5) and, at 21 ticks,
the screen byte by byte plus 5,248 bytes of state (V3VARS, game variables, SPR_TAB, cell map, WORLD_RAM). Scenario (`platformer-scenario.json`): the title
at ticks 5 and 12 with no input; SPACE at ticks 14-15 starts the game; P (right) from tick 22, Q and SPACE jumps, O (left) 106-120, P again; the camera
passes every phase 0-7 (cam 5, 20, 37, 55, 77, 95, 110, 119, 135, 150, 157), the camera falls back to 0 between ticks 153 and 158 (a respawn, inferred from the camera; the game logic is not instrumented).

* Input: identical per tick on every emulator. TSRun presses the keys on its keyboard matrix; ZEsarUX gets ZRCP `send-keys-event` while stopped at
  `WORK_END` (it sets the matrix at once, FRAME(N) reads it later; the game's own key reads, V_KEYS, match TSRun's on all 170 ticks once the unused bits
  5-7 are masked: ZEsarUX returns bit 6 low, TSRun high). Fuse cannot be fed keys per tick headless, so a **test copy** of the cartridge
  (`platformer-patch.mjs`, `arcade/build/platformer-script.dck`, not the committed game) replaces `IN A,(C) / LD B,A` in RT_KEYDOWN by a call to a 79-byte
  stub in the free tail of chunk 1 that returns the row byte from a per-tick table (V_TICKS); the rest of KEYDOWN still runs. The test copy is validated:
  on TSRun and on ZEsarUX the script run and the real-key run are identical on all 170 ticks (camera, keys read, screen md5) and at the 21 sampled ticks
  (0 bitmap, 0 attribute, 0 state bytes).
* Results: TSRun vs ZEsarUX (real keys, and again script-driven): camera, keys read and finished screen identical on all 170 ticks; 0 bitmap bytes,
  0 attribute bytes, 0 state bytes differ at the 21 sampled ticks (title ticks 5 and 12 included). Fuse (script cartridge, 2,703 movie frames): all 170 tick
  screens (1..170) appear byte-identical to TSRun's, in order, 0 unmatched frames inside the span, about 2.99 refreshes a tick (2: 9, 3: 141, 4: 7 times).
* BRIGHT black: the compared bytes are display-file and attribute RAM, so the renderers' difference (TSRun #333, Fuse/ZEsarUX black) cannot appear; the
  cells that use it are the 128 text cells of cell rows 1, 2, 21, 22 (PAPER 0 BRIGHT 1, the title and HUD lines) from tick 12 on. No difference to explain.
* Not covered: Fuse state (only screens), real keys on Fuse, joystick (ZEsarUX reads AY R14 as 0 = no stick; not exercised), sound, real hardware.

### 10b. Vaults (runtime v4, the raycaster) cross-emulator check, 2026-11-10

`arcade/build/vaults.dck` (`arcade/examples/vaults.arc` compiled against `arcade/build/v4`, whose `runtime.bin` is byte-identical to `arcade/dist/v4/runtime.bin`;
32,777 bytes: runtime 16,274 + game 11,890) on TSRun, ZEsarUX 13.0 and Fuse 1.9.1, same method as section 10 (`arcade/tools/xemu/vaults-*`; the order of the commands is in the
header of `vaults-compare.mjs`; scratch files in `arcade/build/xemu/vaults` and `fuse-vaults`). ZEsarUX's `ts2068.rom` (24 KB) is `tsrun/roms/ts2068-0.rom` + `ts2068-1.rom` byte
for byte (MD5 `91942835...`); Fuse was given those two files. Sampling point: the runtime's `WORK_END` (V_TICKS = N, FRAME call N's work finished), the same instruction on
every emulator (TSRun by single-stepping each frame, ZEsarUX by a PC breakpoint), and the hidden display file (V_HIDDEN) is the tick's finished picture. In ray mode the 3D
window is drawn into that file as part of the tick (`ray_tick` returns to `TICK_COUNT`), so the file is the whole picture, window and HUD.

* **Scenario** (`vaults-scenario.json`, made by `vaults-scenario-make.mjs`; 250 ticks = 16.7 s of play at 15 a second, 998 refreshes on TSRun). Ticks 1-178 are the first 178 ticks of
  the recorded LOSE run (`tests/arcade-m8-vaults-script.mjs`): the title turning on the spot (ticks 1-15), fire on call 15, the game starting (state 1 from tick 17), five ticks of
  left turn, then walking and turning through the maze from (640, 7296) to (5251, 7002); wraith 4 wakes at about tick 156. Ticks 179-250 were worked out **closed-loop once on
  TSRun** (turn to face wraith 4, hold fire, then walk on) and are played open-loop everywhere. The shots land: wraith 4's health goes 3 (tick 184), 2 (190), 1 (197), 0 (tick 200: killed,
  score 100, `WRAITH DESTROYED`); the player then walks 47 ticks. Covered: title (text drawn a piece a tick), the fire edge and the 2-tick game start (ticks 15-18), turning,
  walking, wall contacts, a billboard drawn at distance with SEEN / DEPTH read by the real raycaster, shooting with hits and a kill, the HUD changes. Not covered: the door, the key,
  the other pickups, being hurt (the LOSE run's own tail), the win; those are the interpreter and mock tests' ground (`tests/arcade-m8-vaults.mjs`).
* **Input**: stick values per FRAME call (joystick-1 bits 1 up, 2 down, 4 left, 8 right, 16 fire, the format of the recorded scripts). The game reads KEYDOWN and STICK(1) and ORs
  them, so the check drives **keys** (O left, P right, Q up, A down, SPACE fire): TSRun on its keyboard matrix, ZEsarUX by ZRCP `send-keys-event` while stopped at `WORK_END`
  (applied where V_TICKS becomes t, read by the FRAME call that runs next), as in section 10; the game's own key reads (V_KEYS) match TSRun's on all 249 ticks once bits 5-7 are masked and
  equal the script on all of them. Fuse cannot be fed keys per tick headless, so a **test copy** (`vaults-patch.mjs`, `arcade/build/vaults-script.dck`, not the committed game)
  replaces `IN A,(C) / LD B,A` in RT_KEYDOWN by a call to a 79-byte stub (bytes of runtime v4's `keys.asm` are identical to v3's) that returns the row byte from a per-tick table; the rest of KEYDOWN still runs.
  Unlike the platformer's, the stub and the 256-byte table are in the free tail of the **game area** ($B000, $B100; chunk 5 is ROM and the game ends at $AE72), because the v4
  runtime leaves only 110 bytes free in chunk 1.
* **Results, TSRun vs ZEsarUX** (real keys, and again script-driven): on all 250 ticks the game variables (ST PX PY PA HP), the key bits read, the border variable and the finished screen
  are the same; **0 bitmap bytes and 0 attribute bytes differ on any of the 250 ticks** (250 x 6,912 = 1,728,000 bytes compared, not only the sampled ticks) and **0 of the 27 x 5,166
  state bytes differ** at the sampled ticks (5 12 15-20 30 45 60 80 100 130 160 175 183 184 190 197-201 205 230 250; V4VARS 174 + game variables 2,048 + SPR_TAB 128 + CELL_TILE 768 + the
  ray map 2,048). The patched copy is validated: script-driven = real-key runs on TSRun and on ZEsarUX (same figures, 0 differences). A third TSRun run with the stick bits sent to
  **joystick 1** instead (STICK(1) exercised, no key pressed) gives the same 250 screens and game variables and identical state except the game variable JS, which holds the stick value
  (23 bytes differ over the 27 ticks, all JS).
* **Results, Fuse** (script cartridge; 2,404 movie frames in 40 s at 60 Hz): all 250 tick screens (1..250) appear byte-identical to TSRun's, in order, frames 142..1141, with 0 unmatched frames inside
  the span (the frames after 1141 repeat tick 250's picture: the player has stopped). 229 of the 250 ticks have a picture of their own; 21 ticks share a picture with a neighbour (14 groups: the window filled by one close wall,
  ticks 63-67 and 161; the short stretches of the shooting stand where the view does not change), which the frame match cannot tell apart. 999 refreshes from tick 1's picture to tick 250's against 998 on TSRun. A second Fuse run gave the same figures.
* **Tick alignment** (the one place the emulators differ, and not in the game): V_FRAMES (the refresh counter) read at `WORK_END` is 3, 4 or 5 refreshes after the previous tick's, average 4.0 on all three
  (TSRun 3 x 8, 4 x 233, 5 x 7 over 249 intervals, plus 7 for the boot interval; ZEsarUX 3 x 5, 4 x 239, 5 x 4, 6 for boot; Fuse, from its frames, 3 x 10, 4 x 194, 5 x 8 and one 8 across two ticks with the same picture). Between TSRun and ZEsarUX the
  counter differs by a constant 2 or 3 (boot offset 2) and moves 21 times, always back (ticks 10-12, 16, 65, 72, 152-153, 188-189, 194-195, 198-199, 201-208, 216-218, 226). Reading
  `WORK_END` at the TSRun instant shows why: the ticks that last 5 refreshes there (152, 188, 194, 198, 216, 218) all end 242 to 5,913 T-states after a frame interrupt (a frame is 58,688
  T-states) and are followed by a 3; the work ends that close to the interrupt, and a few hundred T-states of difference in where each emulator puts the interrupt moves the sample over the
  boundary. It is the sampling point, not the pacing (the runtime paces by V_TARGET; the picture and the game state do not move). Tick 200, the kill (HUD message, burst frame), is a true 5-refresh tick (ends 26,146
  T-states into a frame) on TSRun and ZEsarUX alike. The game never reads V_FRAMES (no RND, no RANDOMISE), so nothing else could depend on it.
* BRIGHT black: the compared bytes are display-file and attribute RAM, so the renderers' difference (TSRun #333, Fuse/ZEsarUX black) cannot appear in them. In Vaults it is a visible
  difference in TSRun though: 620 of the 768 cells have PAPER 0 BRIGHT 1 on every sampled tick, among them the 3D window's ceiling (rows 6-11, `CEIL 0`), which TSRun draws dark grey
  and the other two black. Not a runtime difference (the bytes are equal); it is TSRun issue #333 and shows in the Studio.
* Not covered: Fuse state (only screens), real keys on Fuse, the AY joystick on ZEsarUX and Fuse (ZEsarUX reads AY R14 as 0 = no stick; the TSRun joystick run is the only STICK(1) with a pressed stick), the border
  (neither `.scr` has it; V_BORDER, the variable, matches TSRun and ZEsarUX), sound, **memory contention** (none modelled by TSRun; the ticks that overrun are on the tick-length figures above, not on timing of
  real hardware), real hardware. 250 ticks of one path; the win (key, door, treasure) and the hurt / lose path are not replayed here.

## 11. Bank probe: DOCK chunks 2, 3, 6 and 2+3 mapped over RAM with the interrupt running (2026-11-10, slice B0)

`arcade/spike/bank/` (`probe.asm`, runners `tsrun.mjs`, `zesarux.py`, `fuse.sh` + `fuse-check.mjs`; exact commands and counts in its `RESULTS.md`).
A cartridge maps DOCK chunk 2, 3, 6 or chunks 2+3 together (`$F4` = `$3F`, the 16 KB window of `docs/ARCADE_BANKING_CONTRACT.md`) for the
length of an `LDIR` (pieces of 1 byte to 8,191, at odd offsets, straddling `$6000`), interrupts on, the ISR flipping the display file every frame,
and checks in Z80 code: (1) every copied byte against the formula, (2) the RAM under the window unchanged (checksums before and after),
(3) the displayed picture, (4) the interrupt count. Green border = pass, red = first failure.

| | TSRun | ZEsarUX 13.0 | Fuse 1.9.1 |
|---|---|---|---|
| (1) bytes | PASS: 160 pieces, 171,364 bytes | PASS: 240 pieces, 257,046 bytes | PASS (pass marker; Fuse gives no record) |
| (2) RAM under | PASS | PASS (DOCK data also intact afterwards) | PASS (marker) |
| (3) picture | PASS: 647 of 647 frames are a reference screen | PASS: every display-RAM sample (335 and 368 in two runs) | PASS: 669 of 669 movie frames |
| (4) interrupts | PASS: 649 in 649 frames, 65 taken while mapped | PASS: 816 in 816.4 refreshes | PASS: 655 alternating frames, no repeat |

Re-run by a second agent: the same figures (ZEsarUX's display-sample count varies run to run because it samples at real speed). Negative
controls (a corrupted copied byte, a changed RAM byte under the window, a corrupted byte across the `$6000` straddle) end red on TSRun and
ZEsarUX; the first also on Fuse.

* **ZEsarUX lets a mapped DOCK chunk above `$4000` be written** (`poke_byte_no_time_timex` protects only `dir < 16384`): a write into the
  window changes the DOCK data there; TSRun and Fuse ignore it. A runtime must never write into the window; ZEsarUX will not catch it.
* **The stock ROM hands over with `$F4` = `$43`: DOCK chunk 6 is mapped** when the DCK has one. The runtimes set `$F4` = `$33` before they
  clear any RAM (checked in `boot.asm`); a cartridge that clears `$C000-$DFFF` first wipes nothing on TSRun / Fuse but the DOCK copy on ZEsarUX.
* All three emulators' video reads display RAM by construction, so (3) is their model, not proof about the real SCLD: checklist item 0
  stays open.

## 12. Leap Runner (4 levels, runtime v3, banked worlds) cross-emulator check, 2026-11-11 (slice B5)

`arcade/build/runner.dck` (`arcade/examples/runner.arc`; 40,969 bytes, DOCK chunks 0, 1, 2, 4, 5; the four worlds, 1,670 bytes, in the bank window) on
TSRun, ZEsarUX 13.0 and Fuse 1.9.1, method of section 10 (`arcade/tools/xemu/runner-*`, order in the header of `runner-compare.mjs`; the Fuse test copy keeps
its key stub and 1,536-tick table in the free tail of chunk 1, the game area being full). Scenario `runner-scenario.json`: 913 ticks; level 1, flag at tick
413, **level 2's banked world loaded at tick 450**, flag 844, **level 3 loaded at 881**. Run twice (the second time by a separate agent, scenario regenerated
byte-identical):
* TSRun vs ZEsarUX, real keys and script-driven: all 913 tick screens identical (0 bitmap, 0 attribute bytes of 913 x 6,912), 0 state bytes differ at the 58
  sampled ticks (5,248 bytes each).
* Fuse (6,010 movie frames): all 913 tick screens appear, identical to TSRun's and in order, 0 unmatched frames in the span, 3.00 refreshes a tick.
* A world-load tick takes 5 refreshes (against 3), followed by a 2: the decode of 2,048 bytes through the window plus the whole-window repaint.
* Not covered: Fuse state (screens only), sound, the joystick on ZEsarUX / Fuse, real hardware (checklist item 0 is what banking depends on).

## 13. Leap Runner on tables (runtime v3, a banked table record), cross-emulator check, 2026-11-11 (slice T5 of `ARCADE_TABLES_CONTRACT.md`)

`arcade/build/runner.dck` (40,969 bytes, DOCK chunks 0, 1, 2, 4, 5; banked: the four worlds and the level-1 table record `play.lv1`, 2,013 bytes),
method and scripts of section 12 unchanged (`runner-patch.mjs` ran as is; the scenario regenerated byte-identical, 913 ticks). Every level start now
also runs `RT_TABLELOAD` (level 1's record through the window, levels 2 and 3 mapped).
* TSRun vs ZEsarUX, real keys and script-driven: 913 of 913 tick screens identical (0 bitmap, 0 attribute bytes differ), 0 state bytes differ at the 58 sampled ticks.
* Fuse (6,010 movie frames): every tick 1..913 appears in order, identical to TSRun's, 0 unmatched; 3.00 refreshes a tick ({2: 14, 3: 816, 4: 12, 5: 2});
  tick 1 to 913 takes 2,741 refreshes on Fuse, 2,739 on TSRun. Re-checked by the main session with `runner-compare.mjs` on the saved outputs: all match.
* Level-load ticks (20, 450, 881): 5 refreshes then a 2, as in section 12 (the table copy, about 7,000 T, does not change it).
* ZEsarUX DOCK contents (zone 19) read before the run, at ticks 20, 450, 881 and after 913: chunks 0, 1, 2, 4, 5 equal to the DCK file (0 bytes differ),
  so `RT_TABLELOAD` writes nothing into the mapped window.
* Not covered: Fuse state (screens only), sound, the joystick on ZEsarUX / Fuse, real hardware.
