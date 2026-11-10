# Leap Arcade cartridge and RAM map, draft L1 (2026-11-09)

Built from the Phase 1 experiments (`arcade/spike/xip/`, `CART_SIZES.md`, `G1.md`); TSRun only, hardware unverified.
This is the **flipping display family**; other families change which RAM is used (see the end).

## Boot (decided: pattern L, owner delegated to "most compatible")
LROS header at DOCK chunk 0 offset 0 with spec byte `$BC` (proven on TSRun, ZEsarUX 13.0 and Fuse 1.9.1; `$CC` and
`$FC` work on TSRun only): bytes `00 01 <entry> BC` as in Leap's cartridges. Hand-off: IM 1, interrupts **on**,
`SP=$61FE`, `$F4=$43`, `$FF=$00`, after about 103 frames. First instruction `DI`; set our own stack, `$F4`, `$FF`,
IM 1 (own handler at `$0038` in chunk 0); ISR variables initialised last. Fallback if ever needed: AROS header at
`$8000` with IM 2 (Sinistar's pattern).

## DOCK chunks (64 KB DCK: one bank-0 block, kinds 0 and 2 only)
| Chunk | CPU address | Content | Reached |
|---|---|---|---|
| 0, 1 | `$0000-$3FFF` | runtime: vectors, ISR, frame loop, blitters, sound tick, linker-selected modules (16 KB) | always mapped |
| 4, 5 | `$8000-$BFFF` | compiled game code and hot tables (16 KB) | always mapped |
| 2, 3 | `$4000-$7FFF` | asset banks | copy only (map, `LDIR` out, unmap); never code |
| 6 | `$C000-$DFFF` | asset bank | copy only |
| 7 | `$E000-$FFFF` | asset bank | copy only, **inside a frame-synchronised `DI` window** (see below) |
`$F4` therefore runs at `$33` in play; a copy ORs in one more bit for a few instructions. Never map over the stack
chunk with interrupts enabled.

## RAM (visible while the above are mapped)
| Range | Use |
|---|---|
| `$4000-$5AFF`, `$6000-$7AFF` | the two display files (bitmap + 8x8 attributes), flipped by the ISR |
| `$5B00-$5FFF`, `$7B00-$7FFF` | 1,280 bytes each: small tables. **Invisible while DOCK chunk 2/3 is mapped**, so nothing the ISR or a copy loop needs |
| `$C000-$DFFF` | streaming buffer / sprite work / shadows (this is RAM; DOCK chunk 6 hides it only during a copy out of chunk 6) |
| `$E000-$FFFF` | variables, ISR state, sound state, **stack at the top** (`$FF00` downward) |
Copy destinations: from DOCK 2, 3 -> `$C000` area; from DOCK 6 -> low `$E000` area (not the stack).

## The stack-chunk wrinkle (found while drafting)
Whichever RAM chunk holds the stack cannot have its DOCK twin mapped while interrupts run (the ISR pushes onto the
stack; the push would land in ROM). With the stack in chunk 7, DOCK chunk 7 is reachable only through a **short DI
window synchronised to the frame** (E4: `HALT`, then 20 windows of 80 bytes lost 0 of 1,200 interrupts; 8 KB took
5.2 frames) or a stack-free gate. So the 64 KB is: 56 KB freely copyable + 8 KB in slower synchronised copies. A game
that needs fast access to all of it can move the stack for a scene (rule: change `SP` only inside `DI`, once,
between frames).

## Other display families (summary; designed in phase 5)
* **8x1 colour, one buffer:** `$4000-$5AFF` pixels + `$6000-$7AFF` colour; a 12 KB shadow (bitmap + colour) lives
  at `$A000-$D7FF`-style RAM, so chunk 5 and/or 6 become RAM and the code shrinks to chunks 0, 1, 4 (24 KB).
* **Hi-res:** both files used as 512 columns; text-heavy scenes only; the same chunk plan as flipping.
The build picks the family per scene and the linker lays out chunks accordingly; the Studio shows the result.
