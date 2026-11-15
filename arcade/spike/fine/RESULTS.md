# F1 spike: fine colour (SCLD mode 2, 8x1 colour) with one screen: flicker and cost

Measured 2026-11-14 for `docs/ARCADE_FINE_COLOUR_CONTRACT.md` section 3 (the F1 slice of section 7). All flicker figures are from
**TSRun's beam** (every displayed frame, read from `m.pixels`) unless they say Fuse; ZEsarUX was checked for the picture only.
Nothing ran on real hardware.

## Verdict

* **A ("direct": per instance, erase then draw straight into the screen) misses the targets by far:** 49 % of frames are broken (419
  per 1,000 frames are not split writes; the target is 0). It also costs 286 k T an update (5 frames). Fuse shows the same (414 per 1,000).
* **B ("compose and publish") meets "broken 0 apart from split writes"** on TSRun and on Fuse: 0 non-split broken frames in 9,000 frames.
  Split writes are 1.3 per 1,000 frames as measured (one update every 5.6 frames), **2.5 per 1,000 scaled to 20 Hz**, above the 1-per-1,000
  limit. Torn frames 10.3 per 1,000 (19.4 at 20 Hz); per 100 frames median 0, worst 8.
* **B refined ("BD": publish only the groups that change, diffed against the screen during the compose) meets every target:** 0 torn and
  0 broken in 9,000 TSRun frames (1,296 updates) and in 1,363 Fuse frames. The publish takes 24 k T (worst 32 k), always ahead of the beam.
* **Neither fits the contract's budgets.** (1) RAM: B needs up to 143 slots on this scene (2.8 KB); BD needs up to 4.8 KB. With the
  1,536 free bytes (80 slots, "B80"), the overflow is composed at publish time: never broken, but **27 % of frames torn**. (2) CPU: B costs
  287 k T a tick (BD 378 k), so this 16-sprite scene runs at 5 to 7 frames a tick (about 10 Hz), not 3 (20 Hz). See "What the contract
  should change". **Changing the order of A and B, or choosing neither, is a stop-and-ask: this is that ask.** My recommendation: B with the
  diff publish (BD), with a bigger buffer and faster compose kernels, at 15 Hz or with fewer moving sprites.

## What was built

A cartridge of my own (`fine.asm`, sjasmplus), booted from the stock TS2068 ROMs as a DCK (bank 0, chunks 0, 1, 4, 5; `$F4` = `$33`), in
mode 2 (`OUT ($FF),2`) with interrupts on (IM 1, ISR counts frames, saves AF only) and no self-modifying code.

* **Scene** (`scene.mjs`): cell row 0 is a HUD text row (font cells, one attribute; a tick counter in cells 29-31 changes every update: the
  dirty cells); rows 1-23 are sky tiles in 6 bands, each tile with 8 row colours (plain and star tiles; no BRIGHT black paper). **16
  instances**: 0 ship 16x16, 1-4 bullets 8x8, 5-12 enemies 16x16 (5-6 move in rows 0-2, over the HUD; 7-8 cross each other; 9-12 a
  formation), 13-15 shots 8x8 falling through everything. Positions come from a 256-tick script table (`positions(n)`); every instance
  moves every update; one update every 3 frames is asked for (20 Hz). Masked sprites: phase tables of (mask, image, colour mask, colour
  ink) per screen byte, 8 phases (phase 0 one byte narrower), the colour rule of section 2.2 (colour mask `$F8`, ink of the row, only
  where the mask byte is not `$FF`). Per tick 113 cells are marked on average (143 worst), of their 903 groups only 397 change (520 worst).
* **The reference** (`fine-model.mjs`): `finePicture({cells, attrs, glyphs, tileRows, sprites, assets})` -> `{bits, colours}` exactly as
  section 2, plus `preshift`, `rowOff`, `spriteGroups`, `spriteCells`. Every build's screen memory equals `finePicture` of the shown state
  after every one of its updates (checked on 9,000 frames each) and after 100 updates on ZEsarUX and Fuse.
* **The checker** (`fine-check.mjs`, pure, for F2): `pictureKeys`, `frameKeys(m.pixels)`, `classifyFrame(shown, P_old, P_new, spritesOld,
  spritesNew, assets[, canon])` -> clean / torn / broken (+ split writes: `isSplit`, a group whose every pixel comes from old / new bitmap x
  old / new colour, which also covers TSRun painting a group in 4 T while it is written), `tally()` (per 1,000 frames, torn per 100 median
  / worst), `blackCanon` (for emulators that draw BRIGHT black as black). `run-fine.mjs` shows the use: the harness logs the update's start
  and end (writes to `V_MARKER`), and a frame is compared with P(a) / P(b) where a = the last update finished before the first painted line
  (8,992 T) and b = the last update started before the last painted line.

### The methods (builds in `lib.mjs` `BUILDS`)

| Build | What it does |
|---|---|
| A | From the interrupt: the HUD cells, then per instance in order of min(old y, new y): erase its old cells (`cell_scr`), draw it at the new place (`spr_scr`), and repair: redraw, in instance order, every instance whose current cell rect meets the erased rect, plus every later instance meeting a redrawn one (masked blits are idempotent, so this restores the order). |
| B | After the update and the "FRAME": mark the cells under every old and new place (+ HUD) in a 96-byte map; walk it top to bottom giving each cell an 18-byte slot (address, 8 x (bitmap, colour)) with its background (`cell_buf`); then per instance in order, per cell of its new rect, `clip_blit` into that cell's slot (slot found by a prefix count + popcount). Next tick, right after the interrupt: publish all slots through `POP`, bitmap and colour of a group written 11 T apart. |
| BD | B, then a diff pass during the compose keeps only the groups whose bitmap or colour differ from the screen as (address, bitmap, colour) entries; the publish writes only those. |
| B80 | B with 80 slots (PREFIX + slots = 1,536 bytes, the map assumed in a spare dirty map); the cells beyond are composed at publish time, one at a time, into a 16-byte slot and written at once (`compose_cell`, the cell-major path). |
| B0 | B with no slots: every marked cell is composed into one 16-byte slot and written at once, top to bottom, from the interrupt ("direct per cell": nothing blinks, but the update is slow). |

The update starts 149 T after the interrupt in every build (TSRun); no build reads the beam.

## Figures (TSRun, 9,000 frames each: `node arcade/spike/fine/run-fine.mjs 9000`)

| Build | updates (frames a tick) | update T median / p95 / worst | compose T median / worst | clean / torn / broken per 1,000 frames | broken not split | torn per 100 frames median / worst |
|---|---|---|---|---|---|---|
| A | 1,606 (5-7) | 285,978 / 314,585 / 350,016 | (in the update) | 434 / 73 / 493 | **419** | 7 / 12 |
| B0 | 1,373 (5-8) | 315,836 / 341,525 / 356,180 | 29,074 / 30,009 (mark only) | 338 / 651 / 10.8 | 0 | 66 / 73 |
| B80 | 1,509 (5-7) | 117,089 / 150,875 / 175,829 | 194,765 / 211,802 | 723 / 273 / 4.0 | 0 | 27 / 31 |
| **B** | 1,595 (5-6) | **38,585 / 42,665 / 48,785** | 247,484 / 269,508 | 988 / 10.3 / 1.3 | **0** | 0 / 8 |
| **BD** | 1,296 (6-8) | **24,116 / 25,906 / 31,551** | 353,223 / 389,197 | **1000 / 0 / 0** | **0** | 0 / 0 |

* B's publish ends before the last painted line in every update (the last pixel line starts 51,776 T after the interrupt); the tears and splits happen where a
  dense cell row lets the beam catch up with the publish front (they recur at the same script ticks, e.g. 133 -> 134). B80 overflowed in
  every update (median 34, worst 63 cells composed at publish time).
* **Scaled to 20 Hz** (an update every 3 frames; every non-clean frame has an update in flight, and an update always starts right after the
  interrupt, so for B and BD the counts scale with the update rate): B torn 19.4, split 2.5 per 1,000 frames; BD 0 / 0. (Not valid for A, B0,
  B80, whose updates last longer than a frame.)
* **Fuse 1.9.1** (its own TS2068 timing and contention; every movie frame of 25 s, about 1,363 frames each; `fuse-flicker.mjs`): A clean 442 /
  torn 73 / broken 484 (414 not split) per 1,000; B0 335 / 652 / 12.5 (0); B80 724 / 268 / 7.3 (0); B 978 / 20.5 / 1.5 (0); **BD 1000 / 0 / 0**.
  The same picture as TSRun. ZEsarUX: not measured per frame (no frame capture); see the cross-emulator check.

### Kernel costs (TSRun, exact T per call, `node arcade/spike/fine/bench.mjs`)

| Kernel | T |
|---|---|
| `cell_scr` cell render to the screen (8 bitmap + 8 colour bytes, each group back to back): font / tile | 484 / 581 |
| `cell_buf` the same into a slot: font / tile | 405 / 506 |
| `spr_scr` fine sprite draw to the screen: 16x16 aligned / unaligned; 8x8 aligned / unaligned | 4,237 / 5,895; 1,442 / 2,284 |
| `erase_rect` erase by cell redraw: 16x16 aligned (4 cells) / unaligned (9); 8x8 aligned (1) / unaligned (4) | 3,037 / 6,735; 809 / 3,037 |
| `clip_blit` fine blit clipped to one cell into a slot (8 rows / 3 rows) | 1,184 / 665 |
| `clip_blit` whole sprite into slots: 16x16 aligned (4 cells) / unaligned (9); 8x8 aligned (1) / unaligned (4) | 4,736 / 8,220; 1,184 / 3,112 |
| `publish` (POP) per cell: about 340 (36 a row + 50); BD's group list about 57 a changed group | |
| `mark_rect` a 3 x 3 rect | 425 |

Per update, by routine (self time, `bench.mjs`): **B** clip_blit 84.9 k (92.7 calls), cell_buf 56.6 k (113), assign 40.0 k, sprites_b 39.6 k,
publish 38.4 k, mark_rect 12.2 k, rect_new 8.0 k, the rest 10 k. **BD** adds diff_b 101.6 k and publishes in 23.6 k. **A** spr_scr 82.1 k (20.4
draws for 16 instances), repair 74.6 k, cell_scr 55.7 k (97 cells), ovl 31.5 k (401 rect tests), the rest 37 k.

### RAM (B)

Map 96 bytes (in F2 it can be the spare dirty map: one screen needs one), PREFIX 96, 18 bytes a slot, + 4 bytes a changed group for BD's list
(+ 2). On this scene: B up to 143 slots = 2,574 + 192 = **2,766 bytes**; BD + up to 520 groups = 2,082 more (**4,848**). The free 1,536
bytes hold PREFIX + 80 slots (B80). The overflow path (`compose_cell`, cell-major) also needs per-row instance lists (here 24 x 32 bytes;
16 + 1 bytes a row suffice).

### Code (bytes, `build/BD/out.sym`)

`cell_buf` 148, `clip_blit` 101 + unrolled `CLIP8` 113 + entry table 16 + `MUL4` 48, `publish` 248 (slot loop, group-list loop, overflow
path), `assign` 115, `sprites_b` 118, `mark_rect` 60 + `MASK_TAB` 48, `diff_b` 283, `clear_mark` 49, `prep_b` 67, `rect_new` 99 (with the
per-instance phase pointer, window width, stride), `POP256` 256 + `LOWMASK` 8, overflow: `compose_cell` 91 + `build_rows` 60. B's kernels
about 1.6 KB, BD's about 1.9 KB (within the 2,500 of section 5.1, before `RT_FINEMODE` and the on / off switch).

## Cross-emulator check (the picture after 100 updates)

`STOPAT = 100` builds (`build/x<method>/fine.dck`) stop after the update that shows state 100. For every build (A, B0, B80, B, BD):
**TSRun's screen memory = ZEsarUX's (zone 0) = `finePicture` of state 100** (12,288 bytes, 0 differ); ZEsarUX's own rendered screenshot
(`save-screen` .bmp, 352 x 304, screen at 48, 56) and **Fuse's last movie frame** (320 x 240, screen at 32, 24) each show the fine picture
with **0 of 49,152 pixels off**, 15 colours, each palette index drawn as one RGB and no two indices sharing one: **mode 2 shows correctly in
both**. Times to the stop: TSRun 692 to 831 frames.

## Kernels for F2

* **Cell render, 16 bytes** (`cell_scr` / `cell_buf`): glyph planes (`GLYPH + 256 k + v`, as v2's `GLYPH_TAB`), colour from the cell attribute
  (font) or `tile_rows + 8 t + k` (tile; 8-aligned, `inc l`); per row bitmap then colour.
* **Fine sprite blit**: v2's `BYTE_OP` plus the colour op on the same group (`set 5,d` / `res 5,d` to the colour plane). The spike's phase
  tables carry 4 bytes a screen byte (mask, image, colour mask, ink): branch-free, but twice v2's pool. The alternative is v2's tables plus
  `sprite_inks` and a test of the mask byte per screen byte (slower, no extra RAM).
* **Clipped blit into a slot** (`clip_blit` + `CLIP8`, entered 8 - rows from its start) and the slot lookup (`PREFIX` + `POP256`): B's compose.
* **Publish** through `POP` with HL = bitmap and DE = HL + `$2000`: `pop bc / ld (hl),c / ld a,b / ld (de),a / inc h / inc d` (36 T a row);
  BD: `pop hl / ld a,h / or a / jr z / pop bc / ld (hl),c / set 5,h / ld (hl),b` (about 57 T a group). Interrupts stay on: the ISR's push lands
  in bytes already read; the counter lives in AF' (the ISR saves AF only). This needs the ISR to push into RAM that is free below the
  buffer, which is true in the spike; in v2 the sound tick pushes more (check its depth).

## What the contract should change (the measurements contradict it)

1. **Section 3's default order.** A cannot meet "broken 0": an erase and a draw of the same sprite are thousands of T apart, and the beam
   (which outruns the update) shows the gap. Refinements of A that write each group once with its final value become B0 (no blink, but
   65 % of frames torn because composing on the fly is slow). B is the method; BD the refinement that removes the tears and splits.
2. **Section 5.3 RAM.** 1,536 bytes give 80 slots; this scene needs 143 (B) and BD's group list 2 KB more. With 80 slots the overflow costs
   27 % torn frames. Options: more RAM for the buffer (about 2.8 KB for B, 4.8 KB for BD, scene-dependent), compose directly into a
   group list per cell (header + changed rows: about 1.1 KB average, 1.5 KB worst here, but the compose then works cell by cell, slower), or
   limit a fine scene's moving sprites.
3. **Section 8 CPU.** This scene's tick costs 287 k T (B: publish 39 k + compose 248 k) or 378 k T (BD), against 176 k for 20 Hz. The
   overheads (slot lookups 40 k, assign 40 k, clip setup about 35 k, diff 102 k) can be cut, but the unavoidable work (background 57 k,
   blit rows about 48 k, publish 24 to 39 k) is already about 130 to 145 k. Starfall's play scene at 20 Hz needs fewer moving sprites than
   16, or 15 Hz; F2 should measure it early.
4. **Split writes (section 3 target <= 1 in 1,000).** Met only when the publish stays ahead of the beam (BD here). With a full-cell publish
   (B) the beam catches the front in dense rows: 2.5 per 1,000 at 20 Hz.

## Not checked

Real hardware; ZEsarUX frame by frame (only the final picture and screenshot); memory contention on TSRun (none modelled; Fuse has its
own and agrees); ZEsarUX's 48K timing (first pixel line later, so more margin, but contended writes); the v2 ISR's sound tick (deeper pushes
during the POP publish); entering / leaving mode 2 (section 4).

## Reproduce

```
node arcade/spike/fine/run-fine.mjs 9000            # flicker + T per update, every build (about 2.5 min); build/results.json
node arcade/spike/fine/run-fine.mjs 900 B BD        # some builds, fewer frames
node arcade/spike/fine/bench.mjs                    # kernel costs and per-routine profiles
node arcade/spike/fine/xemu.mjs build 100           # STOPAT builds, run on TSRun (build/x<method>/tsrun-mem.bin)
python3 arcade/spike/fine/zesarux.py arcade/spike/fine/build/xB/fine.dck arcade/spike/fine/build/xB    # per build: A B0 B80 B BD
sh arcade/spike/fine/fuse.sh arcade/spike/fine/build/xB                                                # per build
node arcade/spike/fine/xemu.mjs compare 100         # TSRun / ZEsarUX / Fuse against the fine picture
node arcade/spike/fine/fuse-flicker.mjs BD 25       # flicker on Fuse's frames (needs build/BD from run-fine or xemu watch)
```

### Watching each method (by eye)

`node arcade/spike/fine/xemu.mjs watch` builds the free-running cartridges (the script loops every 256 updates) and prints, from the
repository root:

```
fuse --machine ts2068 --rom-ts2068-0 tsrun/roms/ts2068-0.rom --rom-ts2068-1 tsrun/roms/ts2068-1.rom arcade/spike/fine/build/A/fine.dck
fuse --machine ts2068 --rom-ts2068-0 tsrun/roms/ts2068-0.rom --rom-ts2068-1 tsrun/roms/ts2068-1.rom arcade/spike/fine/build/B0/fine.dck
fuse --machine ts2068 --rom-ts2068-0 tsrun/roms/ts2068-0.rom --rom-ts2068-1 tsrun/roms/ts2068-1.rom arcade/spike/fine/build/B80/fine.dck
fuse --machine ts2068 --rom-ts2068-0 tsrun/roms/ts2068-0.rom --rom-ts2068-1 tsrun/roms/ts2068-1.rom arcade/spike/fine/build/B/fine.dck
fuse --machine ts2068 --rom-ts2068-0 tsrun/roms/ts2068-0.rom --rom-ts2068-1 tsrun/roms/ts2068-1.rom arcade/spike/fine/build/BD/fine.dck
```

ZEsarUX (from its folder, not tried by eye; `zesarux.py` loads the same files through ZRCP `smartload`): `cd ~/Applications/ZEsarUX-13.0 && ./zesarux --machine TS2068 --romfile ts2068.rom <absolute path of the .dck>`.
All of them update at about 10 Hz (5 to 7 frames a tick, the compose cost above), not 20 Hz.

Files: `fine.asm` (cartridge), `scene.mjs` (scene, script, data images), `fine-model.mjs` (reference), `fine-check.mjs` (checker), `lib.mjs`
(build / boot harness; reuses `../xip/mkdck.mjs`), `run-fine.mjs`, `bench.mjs`, `xemu.mjs`, `zesarux.py`, `fuse.sh`, `fuse-flicker.mjs`.
`build/` is generated (git-ignored).
