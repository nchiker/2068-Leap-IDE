# Leap Runner (`platformer.arc`)

The acceptance game of the platformer slice (`docs/ARCADE_PLATFORMER_CONTRACT.md` section 8.1): a side-scrolling platformer for the
**v3 runtime** (scrolling window, banded parallax, frames and `FLIP`, tile collision). One level, 128 cells (1,024 pixels, 5.3 screens)
wide, 50 coins, 11 enemies, three checkpoints, a flag at the far end.

## Files

| File | What |
|---|---|
| `platformer.arc` | the game (one `SCENE`, a `SELECT CASE` state machine: title / playing / level complete / game over) |
| `platformer.assets.gen.mjs` | draws the art (ASCII), lays out the level, writes `platformer.assets.json`; `--ascii` prints tiles, frames and the level, `--data` prints the `DIM` lines of the level data that the source carries |
| `platformer.assets.json` | generated, committed (the generator is deterministic; a test checks the file is what it makes) |

## Build

```
node arcade/tools/arcadec.mjs arcade/examples/platformer.arc --assets arcade/examples/platformer.assets.json --runtime v3
```

The cartridge is `arcade/build/platformer.dck` (or `-o file.dck`). It needs the v3 runtime build (`arcade/build/v3/`); older runtimes
refuse the window words with a clear message.

## Controls

| | Keyboard | Joystick 1 |
|---|---|---|
| left / right | `O` / `P` | stick |
| jump (hold for higher) | `Q` or `SPACE` | up or fire |
| drop through a plank | `A` (hold while standing on it) | down |
| start / back to the title | `SPACE` | fire |

Walk off nothing but the pit: spikes and the pit cost a life and send you to the last checkpoint (columns 52, 74 and 104). An enemy
that touches you from the side or below costs a life too and gives 2 seconds of blinking invulnerability; **jump on a walker or a bat from
above to stomp it** (+100, and a bounce). Coins +10, flag +500. Three lives. After the flag or after game over, fire goes back to the
title (the level scrolls by itself there).

## How it is built

* **World and bands.** `WINDOW level`, `BAND 2, 1, 4` (distant mountains, 1/4 speed), `BAND 3, 1, 2` (clouds, 1/2), `BAND 11, 1, 1`
  (the gameplay band, 88 pixels). The map's rows 0-1 are the mountains, rows 2-4 the clouds, rows 5-15 the level: ground in rows 14-15,
  platforms and islands above it. A 16 x 24 hero in an 88-pixel band: a full jump (hold the key) rises 36 pixels (4.5 tiles) and lasts 17 ticks (0.85 s,
  about 42 pixels forward at top speed), a short hop 11 pixels; the highest platform is 3 tiles (24 px) above the ground, the tallest wall 2 tiles,
  the widest pit 4 tiles (32 px) and the gaps between the islands 3.
* **Tiles** (20 of the 32 allowed; tile 0 blank): 0 sky, 1 grass, 2 dirt, 3 brick, 4 plank, 5 spikes, 6 coin, 7 pole, 8 flag, 9 sign;
  10-13 mountain pieces (far band); 14-17 clouds (mid band); 18-19 the coin's other spin frames. **Flags:** bit 0 solid (grass, dirt, brick), bit 1
  hazard (spikes), bit 2 pickup (the three coin tiles), bit 3 one-way (plank), bit 4 goal (pole, flag).
* **Collision** is `SOLID` / `TILEHIT` with the hero's hot box (x+3, y+2, 10 x 22): X and Y are moved separately; after each move one
  `SOLID` query on the new box, and if it hits the box is put on the tile's face (tile snapping; no pixel loop; the speed is below 8
  pixels a tick so a tile cannot be skipped). **One-way planks** are not solid (flag 8 only): while falling, when the feet cross into a
  new tile row, `TILEHIT(..., 8)` on that row lands the player on it, from above only; holding down (`dropt`) skips the test for 5 ticks.
  **Hazards, pickups and the goal** are one `TILEHIT(box, mask 2 | 4 | 16)` a tick and a branch on the bits.
* **Physics** is integer: x in 1/8 pixel (accelerate 4, top speed 20 = 2.5 px/tick, friction 4), y in whole pixels (gravity 1, jump -9,
  terminal 7; gravity is a whole pixel so a standing player is pushed into the floor every tick), coyote time of 3 ticks, jump cut when the key is released early.
* **Enemies.** Walkers (4 slots) patrol between the two turning points of their spawn entry (`WLO` / `WHI`: where a wall or the edge of their
  ground is; the generator works them out from the map and a test recomputes them with its own probe rule, so there is no run-time query),
  4 pixels every other tick (walkers on the even ticks, bats on the odd ones, which halves their cost per tick and spreads it). Bats (2 slots)
  fly 56 px either way of where they appeared and bob on a 16-entry sine table. All 11 live in a spawn list sorted by x; the next one appears
  when it comes within 216 pixels of the camera and a slot of its type is free, one a tick, and leaves when it is 48 pixels behind. A stomped
  one stays dead until the next game; a respawn at a checkpoint brings back the ones ahead (`RNX` says where the list restarts). Contact is
  `HIT(hero, enemy)`, asked only when the boxes can overlap and the touch can matter; it is a stomp when the hero is falling and his feet are
  in the enemy's top part (`py <= ey - 12`).
* **Coins are tiles that spin by SETWORLD.** A coin is a pickup *tile* in the world (flag 4, collected with `SETWORLD`, so the collision words and
  the picture agree). Its spin is the tile swapped through four frames (tiles 6, 18, 19, 18 in `CT`): one or two coins a tick, each every
  8 ticks (a turn takes 32), at most 14 coins are ever in view. **Why not a sprite over each coin** (the first version, a pool of six 8 x 8
  sprites over the still tiles): measured on the real runtime, a drawn 8 x 8 sprite costs about 2,400 T, 14,000 T on a tick with six coins in
  view, which with the repaint pushed ticks over three refreshes; the tile swap costs one `SETWORLD` (500 T) per coin turned, the
  attribute is the same for all four frames so no attribute pass is made, and every coin in view spins, not only six. The price is that all the
  coins spin in step (a wave, not independent). Picking a coin up needs no list scan from the start: `CIX` says where in the sorted list to start.
* **Sprite phases and the phase pool.** Runtime v3 caches pre-shifted copies of each frame in a shared 5,888-byte pool and builds an uncached
  frame (about 32,000 T for a 16 x 24) when it is first drawn, which would overrun the tick. So every asset's `phases` is chosen so that
  **all frames stay cached** (`planPool()` of `arcade/tests/m6-common.mjs`, asserted in `tests/arcade-m6-platformer.mjs`): hero 2 phases (16 frames
  with the mirrored ones), walker and bat 4; the plan needs 1,960 bytes at least and gives K = nframes for all three. The price: x is drawn
  rounded down to the phase granularity, so the **hero moves in steps of 4 pixels** on screen (walker and bat 2, coin cells exactly), against a
  top speed of 2.5 px a tick; the logic position stays exact. Walkers and bats move in 4-pixel steps every other tick.
* **Camera** follows with a dead zone (the hero stays between 72 and 112 pixels from the window's left edge) and clamps (`CAMERA`
  clamps to 0..832). The title pans the camera back and forth along the world by itself.
* **HUD** is text in the cell map outside the window (default window at (4, 4): 4 rows above and below, 4 columns each side): row 1
  `SCORE` and `LIVES`, row 2 `COINS n/50`, rows 21-22 the hints and the end-screen messages. Black paper, BRIGHT. The labels are printed once when a game
  starts; only a number that changed is printed again, one a call, on every fourth tick.
* **Cost control** (the tick budget is three refreshes, 176,064 T, of which the runtime's repaint takes up to 126,000): work that is not needed every tick is
  spread over ticks. Starting a game, the title text and the end text are put up a stage a tick (a row of text cells costs about 30,000 T to redraw in both
  display files, so one row a tick); the taken coins come back ten a tick on the title; hazards, pickups and the goal are asked every fourth tick
  (a box overlaps a coin, a spike or the flag for at least 4 ticks), a coin taken is handled the tick after; Q and A are read every other tick;
  while standing still on the same tiles no collision query is made; respawn data (`RCF` / `RNX`) are tables. Measured results are in the next section.
* **Sound** (6 `SFX`): jump, coin, stomp, hurt, win, over.
* **Input** reads `STICK(1)` and `KEYDOWN` together, as the shooter does.

## Art rules used (`arcade/spike/scroll/parallax/RESULTS.md`, "Art rules")

A cell holds two colours, and a sprite is drawn in the colours of the cell under it.

1. **One paper per band.** Far band: blue paper (1), cyan ink (5), normal. Mid band: cyan paper (5), white ink, BRIGHT. Gameplay band:
   cyan paper (5), BRIGHT everywhere a sprite can be.
2. **Every gameplay cell a sprite can pass over has the sky's paper and BRIGHT:** the sky (ink 0), the plank (the sky's attribute exactly,
   ink 0 too, so the hero does not change colour crossing it), the sign, the spikes, the coin, the pole and the flag (their own ink on
   the cyan paper). The ground, grass, dirt and brick carry their own colours, but the collision stops the hero a pixel above them, so a
   sprite is never drawn over them.
3. The heroes are therefore **one-colour silhouettes** (black ink on the cyan sky) with `-` pixels (the sky colour inside the mask) for
   faces and highlights. The coin is the exception that proves the rule: it sits on a yellow-ink cell, so the spinning sprite is yellow.
4. Tile attributes are per tile (the first row's ink / paper / bright; every row of a tile carries the same). Black paper is BRIGHT
   wherever it occurs (the HUD), as in the other examples.
5. No tile in the two backdrop bands is black on black (attribute 0 means "nothing here" for layers); there are no transparent layers.

## Tick cost on the real runtime v3 (TSRun, real interrupt; `node tests/arcade-m6-platformer-perf.mjs`)

Two recorded runs, whole tick = the runtime's work plus the game's `PROC FRAME`, interrupt time included, budget 176,064 T (3 refreshes at 20 fps):

| | before | after |
|---|---|---|
| win run played twice (853 ticks): median / 95th / worst / ticks over budget | 164,328 / 200,081 / 270,214 / 188 | 146,443 / 162,004 / 171,393 / 0 |
| game over run (377 ticks): same | 117,699 / 166,618 / 270,214 / 10 | 106,467 / 149,752 / 168,471 / 0 |
| `PROC FRAME` (win run): median / 95th / worst / mean | 20,537 / 47,302 / 120,274 / 22,977 | 15,500 / 20,652 / 25,500 / 15,479 |

The worst spikes were the title restore (50 `SETWORLD`s and two `FILLC`s of 4 rows each, 120,000 T), the HUD (nine prints a change), the respawn
(list searches) and six coin sprites (14,000 T of drawing); the remaining cost is the runtime's repaint (about 112,000 T on average, 126,000 at
the worst camera) plus up to five sprites (about 10,000 T on average).

## Tests

`tests/arcade-m6-platformer.mjs` (assets and level data, compile and link report, the play-through, game over, the compiled game against the
reference interpreter tick by tick on the batch 2 mock); `tests/arcade-m6-platformer-bot.mjs` finds the recorded play-through
(`tests/arcade-m6-platformer-script.mjs`, a greedy search over jump macros replayed on the reference interpreter; `--write` re-records
it after any change to the game's logic: about 4 minutes). The same runs go to the real runtime through `PROGRAMS` in
`tests/arcade-m6-common.mjs` (`tests/arcade-m6-differential.mjs`).
