# Cartridge sizes: what a DCK can be (2026-11-09)

Sources: libspectrum, Fuse, ZEsarUX and TSRun source (read by a sub-agent, citations in the agent's report are
`libspectrum dck.c:141-152`, `fuse peripherals/dck.c:151-158`, `zesarux timex.c:276-301`, `tsrun/dock.js:37-39`);
the third-party reference <https://github.com/jon0x0/AISkill_TS2068> (cartridge guide, FAQ, graphics-animation
references; no licence file, so used as knowledge only, nothing copied); Leap's own cartridge notes. The reference
repo is secondary: its statements about the SCLD are not verified on hardware by us.

## Ceiling

* **64 KB.** The TS2068 DOCK is eight fixed 8 KB chunks; chunk N appears only at `N x $2000`. No format, emulator
  or document found supports more. A larger cartridge would need its own paging hardware, which stock hardware
  and the DCK format do not describe. The DCK can carry more blocks, but later ones overwrite earlier ones.
* **Arcade rule: one DOCK block (bank id 0), chunk kinds 0 and 2 only.** Bank ids 254/255 and RAM kinds are
  accepted by Fuse and TSRun but not by ZEsarUX, which loads bank 0 ROM chunks only.
* The flat `.bin` (64 KB, absent chunks `$FF`) is the same data for a physical cartridge board (PicoROM is named in
  the Leap notes; never tried on hardware). Output stays DCK-only as decided; the flat form costs nothing later.

## What is usable

| Chunk | Address | Notes for a game |
|---|---|---|
| 0, 1 | `$0000-$3FFF` | Hide the ROM and its `$0038` interrupt vector, so the cartridge must supply its own handler here; good home for the always-mapped runtime (Leap-style LROS cartridges boot here) |
| 2, 3 | `$4000-$7FFF` | Hide the CPU's view of the display files (and the stock hand-off stack is in chunk 3). The SCLD keeps displaying HOME RAM (reference repo; matches TSRun). Use as **asset storage copied into RAM on demand**, not for code |
| 4, 5 | `$8000-$BFFF` | Code and data; the standard AROS-style boot header is at `$8000` (entry `$8008`) |
| 6 | `$C000-$DFFF` | Code, data, or a paged asset window |
| 7 | `$E000-$FFFF` | Can be ROM, but then no RAM for stack/variables; one RAM chunk is needed somewhere |

So **all 64 KB can hold bytes**, and a real project (TSVideoCodec, in the reference repo) already streams 56 KB of
payload plus an 8 KB resident player that way. The practical limit is RAM: stack, variables, the sprite and tile
work buffers, and (for the extended-colour style) a 12 KB bitmap-plus-colour shadow all need HOME RAM, so each
chunk given to ROM is 8 KB less RAM. **The linker therefore plans memory per game** (see the plan): small action
games keep more RAM; data-heavy games stream assets in from chunks 2-3 and 6.

Typical splits (to be worked out in phase 2):

| Game type | ROM chunks | RAM left |
|---|---|---|
| Small, flipping, 8x8 colour | 0, 1, 4, 5 (32 KB) + 6 as asset window | chunk 7 (8 KB) and the display files |
| Large, assets streamed | 0-6 all ROM (56 KB), stream from 2-3 and 6 | chunk 7 (8 KB) and the display files |
| Colour-rich (8x1) with a shadow | 0, 1, 4 (24 KB) | chunks 5-7 (24 KB: shadow 12 KB + work) |

## E4 result: the whole 64 KB can be asset storage (TSRun)
`xip/e4.mjs`, 25/25 pass. Chunks 2 and 3 are reached only by **copying**: `OUT ($F4)` maps the chunk, `LDIR` into
RAM outside `$4000-$7FFF` (tested: chunk 6), `OUT ($F4)` unmaps. With the flip interrupt running and **no `DI`**:
data identical, the interrupt landed on every instruction boundary including either side of each `OUT`, 500 frames
bit-identical to a control that never pages. Cost: 8 KB = 172,349 T (2.94 frames) including the ISR, so stream in
1-2 KB slices if the game cannot stall. Rules: ISR, pager, stack and variables never in a paged chunk or in the
invisible gaps (`$5B00-$5FFF`, `$7B00-$7FFF`); copy destination outside `$4000-$7FFF`; initialise ISR variables
last (a stray `$FF` bit 7 maps EXROM over the handler). A DI-window alternative loses 4-6 % of frames unless
synchronised to the frame. If the real SCLD shows DOCK data while it is mapped, fall back to layout B (about 40 KB).

## Two boot patterns, both proven in emulators
| | **L: own chunks 0-1** (Leap's cartridges) | **P: stock ROM stays, code resident in chunk 4** (Sinistar, The Crown) |
|---|---|---|
| Entry | LROS header in chunk 0, own `$0038` handler (IM 1) | AROS header at `$8000`, entry `$8008`; IM 2 table in RAM |
| Always-mapped code | chunks 0, 1 (16 KB) + 4, 5 | chunk 4 (8 KB); other chunks mapped per call |
| Suits | a compiler: large contiguous code, few far calls | assets/code too large to keep mapped; ROM services |
| Shipped examples | Leap V2/C/Forth cartridges | Sinistar (fills 64 KB, 35 bytes free), The Crown (64,808 of 65,536 bytes) |
Phase 2 chooses; L is the working assumption for a compiled game, P is the fallback if more resident RAM is needed.

## Open (needs experiment or hardware)

* Real SCLD behaviour with DOCK mapped over the display files (the reference says the picture stays; unverified here).
* Chunk 0/1 boot behaviour on a stock ROM when the cartridge supplies them: the existing Leap cartridges do it and
  run on TSRun, ZEsarUX 13.0 and Fuse 1.9.1, so the pattern is proven in emulators.
