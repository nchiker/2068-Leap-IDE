# Leap Arcade: "fine colour" (8x1 extended colour) scenes: plan

Written 2026-11-14; the owner approved every recommendation below the same day ("go with your recommendations"). F0 turns this plan into the
contract (`docs/ARCADE_FINE_COLOUR_CONTRACT.md`) before any code, as every Arcade item. **Order:** this item comes next, before the Studio
completion stages 3-5 (`docs/ARCADE_STUDIO_COMPLETION_CONTRACT.md`); stage 3 (the games) follows it, so the example games are re-verified once.

## What already exists
* **TSRun draws mode 2** (`tsrun/machine.js`: "Hi-colour: one attribute byte per pixel line, from the other screen"), so the Studio shows it as soon
  as a runtime sets it. ZEsarUX and Fuse are to be checked in F1.
* **The art is authored per 8x1 row** (two colours and one BRIGHT per row: `docs/ARCADE_ASSETS.md`; `src/tools/sprite-model.js` `FAMILIES`,
  `familyPixels(..., 'ecm')` = as authored).
* **The project format has the setting:** `scenes.<name>.display = 'fine'` (`src/arcade-project.js`); the Studio lists it as "finer colour (not
  built yet)" (`studio.js` `DISPLAY_LABEL`).
* **The reference:** jon0x0's R-Type (no licence: knowledge only, never code) plays in mode 2 with one buffer: `ecm_game_init` copies the 768
  attributes to `$6000`, then `LD A,2 / OUT ($FF),A`; the menu goes back to mode 0.

## Decisions (owner, 2026-11-14)
1. **Inside runtime v2**, entered per scene like the wireframe mode (the v2 size pass left 3,446 bytes after `RT_END`; estimate 1.5-2.5 KB). A game
   mixes scenes: e.g. the title in two buffers, the play in fine colour.
2. **One buffer** (forced: in mode 2 the colour bytes occupy the second display file). **Sprites are drawn straight to the screen right after the
   frame interrupt**; the fallback, if F1 shows flicker, is R-Type's method (compose in a RAM shadow, publish the changed bytes).
3. **Sample games:** first Starfall's play scene in fine colour with shaded 8x1 art (the fast first look), then a new small game made to show
   8x1 colour off, with a goal, live controls and a rising challenge (owner's sample-game rule); launched in Fuse for the owner.

## Slices
| Slice | What | Who |
|---|---|---|
| F0 | The contract (memory map, the mode's entry / exit per scene, the cell, sprite, erase and text rules, the costs to measure, tests, sample games) | main thread |
| F1 | Spike: a hand-written cartridge: mode 2, tiles with per-row colour, one moving 16x16 sprite on the single screen; T costs per tick and flicker on TSRun, ZEsarUX and Fuse; settles decision 2 | Opus |
| F2 | Runtime: fine-colour mode in v2. Cell render = 8 pixel rows + 8 colour bytes (colour address = pixel address + `$2000`: one `SET 5,D`); sprites masked into the bitmap, each covered row's colour = the sprite's ink over the paper already there (`AND $F8 / OR ink`); erase by re-rendering the cells under the old place; text writes its attribute on all 8 rows. Tests against a JavaScript picture model, interrupts at every instruction, mutation suite | Opus |
| F3 | Compiler + interpreter: a `fine` scene sets the mode in the scene table; its assets keep their 8x1 colours (other scenes still reduce to 8x8) | Sonnet |
| F4 | Studio: "finer colour" enabled; the editors' previews checked | Sonnet |
| F5 | Starfall's play scene in fine colour, then the new showcase game; Fuse launch | Sonnet + main thread |

Timing estimate: F0 + F1 about one session (first light in TSRun); F2-F4 one to two; F5 one. Real hardware stays untested.
