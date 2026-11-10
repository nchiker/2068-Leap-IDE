# Phase 1 / G1: execute-in-place, frame-interrupt flip, interrupts during DI

Measured 2026-11-09 on **TSRun only** (`tsrun/`, stock `ts2068-0/1.rom`, DCK bank 0, chunk kinds 0 and 2). Nothing was run on
ZEsarUX, Fuse, EightyOne or real hardware. Re-run with `node e1.mjs; node e2.mjs; node e3.mjs` (needs `sjasmplus`; output
goes to `build/`, regenerated each time). All three print `PASS:` / `FAIL:` and exit non-zero on failure. Current result: E1 24/24,
E2 12/12, E3 6/6 checks.

Files: `mkdck.mjs` (DCK builder: `buildDck({chunk: 8192 bytes})`, also a CLI), `lib.mjs` (assemble, boot, stepping harness),
`xip.asm` (E1 cartridge), `irq.asm` (E2/E3 cartridge), `e1.mjs`, `e2.mjs`, `e3.mjs`.

Cartridge shape used (same as the Leap cartridges): DOCK chunk 0 starts with the LROS header `00 01 <entry> <spec>`; the entry does
`DI`, sets SP, `OUT ($FF),0` (bit 7 = 0: DOCK), `OUT ($F4),mask`, `IM 1`, and jumps. Chunks 0-1 (our code, replacing the HOME ROM
view, interrupt handler at `$0038`) are always mapped.

## E1. Execute in place from DOCK chunks

**Does it run?** Yes, in every combination tried. Code in DOCK chunks 4+5, 4, 5, 3, 2, 6, 7, 6+7, 4+5+6 and 4+5+6+7 each ran a counter
loop (about 1,172 passes per frame, 50 T each) with the frame interrupt (handler in chunk 0) serviced 10 times in 10 frames. Every
sampled program counter (4,690 instructions per variant) was in a DOCK-mapped chunk. A loop that straddles `$A000` (chunk 4 to 5) runs
across the boundary. Writes into a DOCK chunk are ignored (kind 2 is ROM); reads return the DOCK bytes.

**RAM under the mapping.** A chunk that `$F4` maps from DOCK hides the RAM there (reads give the DOCK bytes, writes are lost); the
RAM chunks not mapped stay fully readable and writable (probe pattern at `$x234` in each chunk 2..7; `e1.mjs` prints the table):

| `$F4` | DOCK chunks | RAM left | Verdict |
|---|---|---|---|
| `$33` | 0,1,4,5 | 2,3,6,7 (32 KB) | works; `$4000-$7FFF` and `$C000-$FFFF` intact |
| `$13` / `$23` | 0,1,4 / 0,1,5 | the rest | works |
| `$0B` | 0,1,3 | 2,4,5,6,7 | works, but hides display file 2 (`$6000-$7AFF`) and the `$7B00-$7FFF` gap |
| `$07` | 0,1,2 | 3..7 | works, but hides display file 1 and the attributes |
| `$43` / `$83` / `$C3` | 0,1,6 / 0,1,7 / 0,1,6,7 | 2..5 (and 7 or 6) | works |
| `$73` | 0,1,4,5,6 | 2,3,7 (24 KB) | works |
| `$F3` | 0,1,4,5,6,7 | 2,3 (16 KB) | works; the 32 KB-in-place layout |

**Stack.** Works in any RAM chunk: tested with SP at the top of chunks 2, 3, 6 and 7 with the handler pushing and popping every frame.
A stack inside a DOCK-mapped chunk (SP=`$A000` with chunk 4 mapped) breaks (pushes vanish), as does a stack in a chunk that is paged to
DOCK for a moment (PUSH/POP returned `$0000`, written `$ABCD`).

**Hand-off by the stock ROM** (real ROM code, TSRun's DOCK): reached after 104 frames; IFF2=1 (interrupts enabled), `$FF`=`$00`,
SP=`$61FE`, and `$F4` follows the header's low-active chunk-spec byte: spec `$BC` gives `$43`, `$CC` gives `$33`, `$FC` gives `$03`.
So the ROM maps what the header asks for; keep bit 3 = 1 (chunk 3 RAM holds its stack) and set SP before touching chunk 3. `$BC` is
what the shipped Leap cartridges use (proven on ZEsarUX and Fuse); `$CC` and `$FC` are only tested on TSRun.

**Paged window.** With code running from chunks 0,1,4,5, chunk 6 was paged in over its RAM (`OUT ($F4),$73`): the DOCK data (marker
`$C6`) appeared, a write was ignored, and after paging out the RAM byte (`$3C`) was unchanged. A frame interrupt arriving while the
window was open was serviced (handler in chunk 0, stack in chunk 7) and execution continued. Paging needs no `DI` as long as the
handler and the stack are outside the window and the handler touches no variable inside it. A switch costs `ld a,n; out ($F4),a` =
18 T (plus a shadow store: do not rely on reading `$F4` back).

**Conclusion for the layout.** Code and data execute and read in place from chunks 0,1,4,5,6,7. Chunks 2 and 3 cannot be DOCK
code if the game uses display file 1 or 2 (chunk 2 is display file 1 and the attributes, chunk 3 is display file 2). Display files
leave only `$5B00-$5FFF` and `$7B00-$7FFF` (1,280 bytes each) free in chunks 2 and 3. A flipping game with the whole 32 KB mapped
(`$F3`) therefore has 2,560 bytes of RAM for stack, variables, sprite state and background buffers. See the layout below.

## E2. Frame-interrupt display flip

Handler at `$0038` in DOCK chunk 0 (`push af; ld a,(shadow); xor 1; ld (shadow),a; out ($FF),a; frame counter; pop af; ei; ret`),
main code running in place from chunks 4+5. 20 frames per case; time = T-states from the nominal frame interrupt (TSRun's
`frameStart`; the start of the `OUT` instruction, 11 T more until it completes); first pixel line = line 40 + 32 T = **8,992 T**.

| Main loop | Interrupts taken | Missed | `OUT $FF` at (T) | Margin to first pixel | Accept delay | Handler cost | Torn frames |
|---|---|---|---|---|---|---|---|
| busy loop | 20/20 | 0 | 64-75 | >= 8,917 | 13-24 | 137 T | 0/20 |
| `HALT` + 39k T of work | 20/20 | 0 | 64 | >= 8,928 | 13 | 137 T | 0/20 |
| `LDIR` of 6,144 bytes (129k T) | 20/20 | 0 | 66-84 | >= 8,908 | 15-33 | 137 T | 0/20 |

Handler cost is the 13 T acknowledge plus the handler through `RET` (0.23 % of a frame). The frame buffer was inspected after every
frame: each frame showed exactly one display file, strictly alternating, uniform over all 192 rows. A control that flips from the
main loop at an unsynchronised moment tore 20 of 20 frames, so the detector does work. `LDIR` is interrupted between iterations
(accept delay up to 33 T), so long block moves do not postpone the flip.

**DI windows in the main code** (150 frames each, window 2,600-15,600 T): every interrupt that was delivered flipped at the same
64-75 T, no frame tore, and the fraction of frames whose interrupt was lost equals the DI duty cycle (23 % at 24 % duty, 65 % at 65 %).
TSRun never delays an interrupt, it either takes it at the frame boundary or drops it (E3). So the rule for the runtime is
"never be in `DI` at the frame boundary", not "keep DI short enough to flip in time".

**Conclusion.** On TSRun a flip done first thing in the handler lands about 8,900 T (2.5 ms at 3.528 MHz) before the first pixel line:
tear-free with a large margin, and the handler leaves 99.7 % of the frame to the game.

## E3. Interrupt while interrupts are disabled

TSRun raises the frame interrupt once, at the end of `runFrame`, and only if IFF1 is set then (`machine.js endRasterFrame`: `irqZ80`
returns 0 when `!iff1 || eiDelay`). Measured with `HALT; DI; busy N x 26 T; sample; EI; NOP; NOP; sample` repeated 20 times:

| DI window | Boundaries inside | Frames run | Handler runs | Delivered after `EI`? |
|---|---|---|---|---|
| 26,000 T | 0 | 20 | 20 | no (control) |
| 78,000 T | 1 | 40 | 20 | no: 1 interrupt lost per cycle |
| 130,000 T | 2 | 60 | 20 | no: 2 lost per cycle |

**The interrupt is lost, not latched and not delivered at `EI`**; a 2-frame DI period loses both. A second corner case: if the frame
ends with `EI` as the last instruction (IFF1 set, `eiDelay` still active) the interrupt is also dropped, so even a DI window that ended
"in time" can lose a frame (found with DIWIN=2251, NOPS=6; a real Z80 would take it after the next instruction).

**Consequence for the runtime:** a frame counter, the music tick and the flip all rely on the interrupt, so game code and the paging
code must avoid `DI` across the frame boundary (best: no `DI` in game code at all; E1 shows paging needs none) and never end a `DI`
section with `EI` as the last instruction before the boundary. Anything that must be exact should use the frame counter, not count interrupts.

## Recommended memory layout for a 32 KB game plus runtime (from these results)

Not decided by this spike; this is what the evidence supports. Chunks 0-1 hold the runtime and the handler; DOCK has at most 8 chunks.

| Layout | DOCK | RAM | Notes |
|---|---|---|---|
| **A: all in place** `$F3` | 0,1 runtime (16 KB) + 4,5,6,7 game (32 KB) | chunks 2,3 only: 2,560 B beyond the two display files | no paging at all, simplest; too little RAM for tile-map state, sprite buffers, pre-shifted data. Fine for a non-flipping game (chunk 3 free: +8 KB) |
| **B: one paged window** (recommended to evaluate) | 0,1 runtime + 4,5 code/hot data always mapped; **6 a paged asset window**; 7 RAM | chunks 2,3,7 (+6 while the window is shut): about 10.7 KB working RAM with two display files | up to 40 KB of runtime + game; the runtime must be about 8 KB or less to carry a 32 KB game. The pager lives in chunk 0/1/4/5; stack and variables in chunk 7 (or the chunk 2/3 gaps); the handler touches only chunk 2/7 |
| C: two paged windows | 0,1,4,5 + windows 6 and 7 | 2,560 B in chunks 2,3 when the windows are open | only if the data needs 48 KB; variables then live in the display gaps |

Rules that follow: (1) the handler, the pager and the stack never live in a chunk that is ever paged; (2) variables in a window chunk
are invisible while it is open; (3) hand-off with spec `$BC` is the proven one, then the entry sets `$F4`/`$FF` itself; (4) never
`DI` over a frame boundary; (5) keep a shadow of `$F4` and `$FF` in RAM.

## What was not verified

* Anything on real hardware, and anything on ZEsarUX, Fuse or EightyOne. TSRun's DCK model (kind 2 = ROM, ignored writes, any
  chunk maps) matches the shipped cartridges, but a real DOCK only the stock ROM and SCLD can confirm.
* Whether the real SCLD displays RAM while the CPU sees DOCK at `$4000-$7FFF` (TSRun's raster reads its RAM array directly) and
  whether contention applies when code runs from DOCK (TSRun has none).
* The interrupt: real hardware holds /INT for some T-states, so a `DI` that ends just after the boundary may still be serviced; TSRun
  drops it. The 8,992 T first-pixel offset is TSRun's constant (`activeStartLine 40`, `activeStartT 32`).
* Spec bytes other than `$BC` on ZEsarUX and Fuse; reading `$F4` back on hardware; `$FF` bit 6 and modes other than 0/1 with flips.
* The handler timing was taken from instruction starts; the `OUT` takes 11 T more to complete.

## E4. DOCK chunks 2 and 3 as paged asset storage for a flipping game (copy, never execute)

Measured 2026-11-09 on **TSRun only**. Files: `stream.asm` (cartridge: ISR, pager, sprite blit, five main loops), `e4.mjs`
(`node e4.mjs`; 25 checks, all PASS; run it from this directory, it needs `sjasmplus`). Question: the two display files occupy
`$4000-$7AFF`, so DOCK chunks 2 and 3 (`$4000-$7FFF`) cannot be mapped while the game runs. Can they still be used as asset storage by
mapping one in for the length of a copy into RAM and mapping it out again, so that all 64 KB of a DCK count?

Design tested: DOCK chunks 0,1 (header, ISR at `$0038`) and 4,5 (main code at `$8000`) always mapped (`$F4` = `$33`); RAM chunk 7 holds the
ISR variables and the stack (`SP = $FF00`); RAM chunk 6 (`$C000`) is the copy destination. The copy is `ld a,$37 / out ($F4),a` (chunk 2)
or `$3B` (chunk 3), `LDIR` 8,192 bytes `$4000` (or `$6000`) to `$C000`, `ld a,$33 / out ($F4),a`. The ISR flips `$FF` bit 0 every frame.
The asset chunks held a position-dependent pattern (different in chunk 2 and 3). Display files hold distinct patterns; a sprite (8x8 XOR
blit) is drawn into both files by the main code.

| # | Question | Result |
|---|---|---|
| (a) | Works with the frame interrupt running throughout, no `DI`? | **PASS.** 12 copies (6 + 6) in 84 frames: the handler ran 84 times, the flip toggled every frame, every byte of every copy matched the DOCK data. 500 frames of a free-running game loop (blit, map 2, copy, blit, map 3, copy; interrupt accepted with a DOCK chunk mapped in 500 of 500 frames) lost nothing: handler 500/500. |
| (b) | Can the ISR fire while chunk 2/3 is mapped; does its push land in chunk 7? | **PASS.** 60 of 84 interrupts arrived with `$F4` = `$37`/`$3B`; the return address was always inside the LDIR/main code in chunk 4, `SP` in `$F000-$FEFF` (chunk 7) every time. The ISR is in chunk 0 (stays mapped) and touches only chunk 7. |
| (c) | Display RAM and screen during and after? | **PASS (on TSRun).** RAM `$4000-$7FFF` (both files, attributes, the two gaps) was byte-identical before and after each copy, even with a write storm into the whole mapped window (the writes are ignored, kind-2 chunk = ROM). A sprite drawn into the hidden file before the paging was intact. Every frame during and after the copy was one of two stable images, alternating, and the 500 screen frames of the paging run are bit-identical (FNV hash of the frame buffer) to a control with the same OUTs but no paging. This is a **model property**: TSRun's raster reads its RAM array directly (`machine.js videoRunTo`), so the SCLD "seeing RAM while the CPU sees DOCK" is the assumption, not a result. |
| (d) | Cost of an 8 KB copy | **172,075 T net** (map OUT to unmap OUT, = 21*8191 + 16 for the LDIR + 30 for the three `ld rr,nn` + 18 + 7) plus one 137 T interrupt per frame: **172,349 T = 2.94 frames**, measured exactly the same for chunk 2 and 3 and all copies. Paging itself costs 36 T per copy. 1 KB = 21.5 kT = 0.37 frame, so a game that cannot stop for 3 frames copies in slices of 1-2 KB per frame with the same safety. Faster copies (computed, not measured): unrolled LDI 16 T/byte = 131 kT, PUSH/POP ~86 kT but needs `DI`. |
| (e) | ISR fires between the OUT that maps/unmaps and the next instruction | **PASS.** A tight loop (map 2, copy 4 B, unmap, map 3, copy 4 B, unmap) was interrupted 3,000 times in 3,000 frames; the return addresses covered **20 of 20 instruction boundaries** of the sequence (2,240 with a chunk mapped, 760 without, i.e. before and after each OUT), SP always in chunk 7, no stray PC, copied bytes correct at the end. The accept delay of an `OUT` is zero extra T on TSRun; the mapping is a plain port value, there is no half-state. |

**Alternative: map only inside a `DI` window.** The window was `di; map; LDIR 80 B; unmap; ei` = **1,820 T**. Free-running, one window per
frame (period 59,090 T): **4.4 % of the interrupts were lost**, not the 3.1 % duty cycle, and in bursts of up to 6 consecutive frames (a loop
whose period is close to the frame period drifts slowly across the boundary, and a lost frame saves the 137 T ISR so the drift slows
down: 5-6 frames per crossing). Two windows per frame: 6.5 %; back to back: 38.8 %. So the target "under 4 %" is **not met** unsynchronised,
and 8 KB takes 103 windows: 103 frames and about 4.5 lost flips/ticks, against 2.9 frames and 0 lost without `DI`. **Synchronised** to the
frame (`HALT`, then 20 windows of 80 B back to back, the last unmap at 37,478 T into the frame, 21,210 T before the next interrupt): **0 of
1,200 lost**, 1,600 bytes per frame, 8 KB in 5.2 frames, all data correct. It works, but moves no more data per T than the no-`DI` copy
(LDIR speed is the same) and adds the constraint of a frame budget, so it is only a fallback.

**Negative control (rule: nothing the ISR touches may live in a window chunk).** With the ISR variables at `$5F00` (chunk 2's gap) and chunk
2 mapped, the ISR reads the DOCK byte there, its writes are lost, and the flip stops: 128 frames with chunk 2 mapped showed no run of two
consecutive flips (34 isolated flips from the changeover), against alternating flips while chunk 3 was mapped. (An earlier version of this
test also exposed an unrelated trap: `SHADOW` held `$A5` because the display-gap fill had overwritten it; the ISR then wrote `$A4` to `$FF`,
bit 7 = 1, which maps EXROM over the handler and crashed the machine. Initialise the variables last, and never take `$FF`'s value from memory
that could hold anything else.)

### Rules this adds to the layout (from E4)
1. The ISR, the pager, the stack and every variable the ISR or the pager touches live in chunks that are never paged (0, 1, 4, 5 for code,
   7 for variables and stack). Chunks 2 and 3 gaps (`$5B00-$5FFF`, `$7B00-$7FFF`) are **invisible while a window is open**, so the main
   code must not use them as variables across a copy, and the ISR never.
2. No `DI` around the paging. The pager is `ld a,n / out ($F4),a` before and after the copy; keep a shadow of `$F4` in chunk 7 (do not read
   it back).
3. The destination must be outside `$4000-$7FFF` and outside the display files: RAM chunk 6 (and the part of chunk 7 not used by variables
   and the stack). One 8 KB chunk fills RAM chunk 6; assets bigger than the free RAM are copied in slices when needed.
4. Do the copy in slices of at most about 2 KB per frame if the main loop cannot stall for 3 frames; the slice boundary can be any byte.
5. Because the DCK stores code or data in a chunk indifferently, chunks 2 and 3 are ordinary asset storage: the whole 64 KB of a DCK is
   addressable. Total ROM space = 8 chunks, of which 0 and 1 hold the runtime and ISR.

### What was not verified (E4)
* Anything on real hardware, ZEsarUX, Fuse or EightyOne. The decisive unknown is whether the real SCLD fetches video from the RAM while the
  CPU sees DOCK at `$4000-$7FFF` (and whether the display really stays unaffected for the 3 frames of a copy). TSRun renders from its RAM
  array whatever `$F4` says; it models **no contention** on `$4000-$7FFF`, and none when code runs from DOCK. If the SCLD on real hardware
  addresses DOCK instead for the video fetch, the display would show the asset bytes for the duration of the copy; the DI-window variant
  would then show 1,820 T glitches instead of 3 frames. Hardware checklist item: map a DOCK chunk over `$4000-$7FFF` for 3 frames while
  displaying a static picture, and look at the screen.
* Real interrupt timing: real hardware may latch /INT for some T-states while TSRun drops it; both the no-`DI` copy and the synchronised
  windows are insensitive to that, the unsynchronised numbers are TSRun's.
* `$F4` bit meanings on ZEsarUX / Fuse for chunks 2 and 3 (ZEsarUX's DCK loader accepts kinds 0 and 2 only, as used here; not run there).
