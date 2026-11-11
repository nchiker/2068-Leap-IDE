# Vaults (`vaults.arc`)

The acceptance game of the raycaster slice (`docs/ARCADE_RAYCASTER_CONTRACT.md` section 8.1): a first-person maze for the **v4 runtime** (3D view,
billboards, `SEEN` / `DEPTH`). A 32 x 32 cell maze of nine rooms, a locked vault door, a gold key, five wraiths that chase you and can be shot,
five gems, three health potions, a treasure to find.

## Files

| File | What |
|---|---|
| `vaults.arc` | the game: three scenes, `title` (`SCENE title NOVIEW`, no 3D view), `demo` (the view turning) and `play` (a `SELECT CASE` state machine: playing / treasure found / dead) |
| `vaults.assets.gen.mjs` | the hand-drawn ASCII maze, the art, the HUD panel, the title picture and the sounds; writes `vaults.assets.json`; `--ascii` prints the maze and the sprite frames, `--data` prints the `CONST` / `DIM` lines of the level data that the source carries |
| `vaults.assets.json` | generated, committed (the generator is deterministic; a test checks the file is what it makes) |

## Build

```
node arcade/tools/arcadec.mjs arcade/examples/vaults.arc --assets arcade/examples/vaults.assets.json --runtime v4
```

The cartridge is `arcade/build/vaults.dck` (or `-o file.dck`). It needs the v4 runtime build (`arcade/build/v4/`, `node arcade/tools/build-runtime-v4.mjs`).

## The scenes (language batch 7)

* **`SCENE title NOVIEW`** is the first scene, so the game starts in it, and it shows **no 3D view**: the whole 32 x 24 cell screen is a picture, the map `vl_title` (generated: `VAULTS` in
  brick-wall tiles, a vault room of stone, the goblet on its pedestal, gems, the locked door). On it the game prints the tagline, the prompt and the best score of the session and animates it:
  gems sparkle by `TILE` swaps (one a tick, and the goblet's top), and **sprites at screen positions** (the same instances the maze uses): a wraith patrols the corridor 2 pixels a tick (the wraith
  asset has 4 phases for that; ray mode ignores phases), the key, two gems and a potion bob. The NOVIEW sprite pool the linker plans for it: 1,196 of 3,712 bytes (the wraith's 4 frames cached).
* **`SCENE demo`** has the view back on: the colonnade turning slowly with the HUD panel (what the title used to be). Title and demo take turns every 135 ticks (9 seconds); fire in either enters play.
* **`SCENE play`** is the game. Its `INIT` loads the floor plan again (`WORLD level`), puts every thing back, draws the HUD and shows the start pose; the treasure or death `ENTER title`.
  The best score is a game-level variable. The play is tick for tick what it was when the title was a state of it (`tests/arcade-m8-vaults.mjs` compares digests of every tick).
* A scene switch is a long tick (about 1,000,000 T-states: the machine reset's `CLS` and first-map load, the floor plan, the pool build when the view goes off): about 0.3 s at the switch.

## How to play

Find the **gold key** (top left room, guarded by a wraith), carry it to the **vault door** (the barred wall at the end of the antechamber in the top right
corner: walk up to it), open it, and take the **treasure** (the goblet) in the vault. Gems are +50, a wraith is +100, the treasure is +500 plus your health.

| | Keyboard | Joystick 1 |
|---|---|---|
| turn left / right | `O` / `P` | stick left / right |
| walk forward / back | `Q` / `A` | stick up / down |
| shoot | `SPACE` | fire |
| start a game / back to the title | `SPACE` | fire |

* **Shooting** is a hit scan along the middle of the view (the four white marks on the bezel point at its centre): the wraith you are looking at, nearest first, up to 7 cells
  away, takes a hit (a shot every 6 ticks while the key is held). **Three hits destroy a wraith.** A wall in the way protects it (it is not drawn, so it cannot be seen).
* **Wraiths** sleep until you come within 6 cells, then walk toward you at about 0.4 of your speed (the maze slows them: they slide along walls and get stuck behind
  corners, so you can lose one). A touch costs 10 health and gives you 12 ticks (0.8 s) of immunity; at 0 health the game is over (the screen flashes the border red).
* **The door** answers "THE DOOR IS LOCKED. FIND A KEY" without the key and opens with a grinding noise when you walk up to it with the key (one key, used up).
* **Potions** give 40 health but only when you need it (walk over one at full health and it waits). The HUD on the left shows health (a bar of 7 cells with half steps, and the
  number), the keys; on the right the score and the gems (5 slots). Messages for pickups and the door appear on the bottom line.
* After the treasure or after dying, fire goes back to the title; the next game starts clean (door shut, everything back).

## How it is built

* **The view.** `VIEW3D level COLW 4 INK 5 CEIL 0 FLOOR 1`: 4-pixel columns (32 rays), cyan walls (wall pixels are ink), a black ceiling and a blue floor. The four wall types
  are the runtime's default dither patterns: 1 grey stone (outer ring and pillars: solid / checker), 2 brick (the room walls: 3/4 and 1/4 dither), 3 vault lining (scanlines), 4
  the locked door (vertical bars). The maze is a hand-drawn 32 x 32 text in the generator, with letters for the things on the floor (`P` start, `K` key, `T` treasure, `E` wraith,
  `G` gem, `H` potion); its tests check that every room is joined, that the key and everything but the vault is reachable with the door shut, and that the vault is reachable only
  through the door.
* **Pose and movement.** The game owns the player: `px`, `py` (8.8, 256 to a cell) and `pa` (angle 0..255; 0 east, 64 south) and calls `VIEW px, py, pa` once a tick. Turning is 6
  units a tick (128 degrees a second); walking is 44 units a tick (2.8 cells a second) along `(COSA(pa), SINA(pa))` scaled with `FXMUL`. **Collision is the game's own**: the move is
  made one axis at a time, when the two corners of the player's box (radius 40 units) on the side he moves toward are in empty cells (`WALL`); so he slides along a wall. Every other
  tick a probe 112 units ahead looks for wall type 4 (the door): with the key it is opened with `SETWALL`.
* **Billboards are the sprite instances**: 16 in all (the most there are): the player's marker (a 16 x 16 solid that stands at the viewer, never drawn, there for `HIT`), 5 wraiths (16 x 16,
  frames: float A, float B, hurt, burst), 5 gems and 3 potions and the key (8 x 8; the gem has a glint frame), the treasure (16 x 16, glint frame). Positions are 8.8 world
  coordinates, so `SHOW wr(i) AT ex(i), ey(i)` places a wraith directly. A billboard is drawn in the colours of the window cell it covers (it never writes attributes), so all of them
  are one-colour shapes, cyan on black above the horizon, cyan on blue below it; the `-` pixels in the art (eyes, facets) show the cell's paper.
* **Touch is `HIT(me, thing)`** (ray mode: both sprites shown, `|dx|` and `|dy|` below the sum of their half sizes, `4 h` units each: a 16-pixel wraith is 64, the marker 64,
  an 8-pixel gem 32). A cheap distance test comes first, so `HIT` is called only when the player is close.
* **Shooting uses `SEEN` and `DEPTH`** of the wraith instances: `SEEN(wr(i))` is the screen column (0..127) of its centre in the last picture, -1 when it was not drawn (hidden, behind a wall, behind
  you); `DEPTH` its distance in 8.8. A shot hits the nearest wraith whose `SEEN` is within `8000 DIV (depth + 1)` columns of 64 (at least 3: about 1.1 times the sprite's half width at that
  distance) and whose `DEPTH` is under 7 cells. `SEEN` and `DEPTH` are the previous tick's picture's, so you aim at where it was drawn 1/15 s ago.
* **Wraith AI** is a few integer compares: each wraith is looked at every second tick (the even ones on even ticks, the odd ones on odd ticks, so two or three a tick); awake, it takes one step of
  28 units toward the player on each axis whose lead point 3 steps ahead is in an empty cell (`WALL`), and slides sideways along the wall when neither axis is free. No pathfinding.
* **Seeing is expensive, so the game hides what you cannot use.** Measured on the real runtime (below): every billboard in view costs at least about 10,000 T-states, even far away or behind a
  wall, and one close to the viewer costs 72,000 (a 16 x 16 sprite closer than a cell; an 8 x 8 one 25,000; a 24 x 24 one 137,000). So gems, potions, the key, the treasure and the wraiths are `HIDE`n
  while the player is more than 7 cells away (a Chebyshev test the pickups already make, every third tick; the wraiths every second tick) and `SHOW`n when he comes within it: about
  3 or 4 things are shown at a time. The first version showed all 16 and the picture alone took 164,000 T-states on average.
* **The HUD is the ordinary cell map outside the 16 x 12 window** (cells 8..23 x 6..17): a boot map (`vl_panel`: dark-blue dotted stone, a brass bezel round the window, the aiming marks, a full
  health bar, empty slots), text from `PRINT`, tiles from `TILE`; nothing ever touches the window or its bezel (a test compares the cell map every tick). One change a tick: **printing is the
  game's dearest operation (about 550 T-states a character, and the cells it dirties are repainted too)**, so a 30-character message is printed in two halves of 15 on two ticks, numbers one a tick,
  the title text a line a tick.
* **Sound**: eight effects (`shot thud kill pick door hurt win lose`); the border flashes white on a shot, red when hurt.
* **Inputs** read `STICK(1)` and `KEYDOWN` together, as the other examples do.

## Measured numbers (TSRun, real v4 runtime build, real frame interrupt, no memory contention)

All **measured** unless it says estimate. The tick is 4 refreshes = 234,752 T-states (15 a second). `node tests/arcade-m8-vaults-perf.mjs [--sweep] [--spikes N]`
single-steps the two recorded runs (the win run of 1,436 ticks walks the whole maze, the lose run 394 ticks stands among the wraiths).

| | win run | lose run |
|---|---|---|
| whole tick (interrupt included): median / 95th / worst | 159,468 / 188,532 / 263,739 | 151,466 / 172,149 / 205,502 |
| ticks over 234,752 (the first 3 ticks excluded, see below) | 7 of 1,433 (0.49 %), all 4.0 to 4.5 refreshes | 0 of 391 |
| `PROC FRAME` (the game's logic, runtime calls included): median / 95th / worst | 19,000 / 26,818 / 37,435 | 15,003 / 21,478 / 25,227 |
| mean picture: cast + walls / billboards | 116,571 / 17,046 | 118,628 / 10,692 |

* **The first 3 ticks cost about 399,000 / 398,000 / 162,000**: the runtime paints the boot HUD map (the 576 cells outside the window, into both display files; `redraw_dirty` 262,000 T-states).
  That is the runtime's boot, not the game.
* **The over-budget ticks** are the ones in which a wraith stands within a cell in front of the player (a 16 x 16 billboard that close costs about 72,000): they run at 5 refreshes (12 a second) for
  3 ticks. With two wraiths in front at once the cost is about 150,000 on top of the cast. The lose run never goes over: the wraiths come from the side or behind.
* **Sweep** (`--sweep`: the viewer on every one of the 688 empty cells at 8 angles, 5,597 poses): the picture of the maze alone (walls, no billboards) costs median 118,417, 95th 130,683,
  **worst 146,278** (cast worst 130,145) T-states: it never goes over, with 88,000 to spare at the worst pose. With all 16 billboards shown at their posts (which the game never does) the worst pose is
  267,886 and 21 of 5,597 poses go over.
* **`PROC FRAME` is about 19,000 on average** (median 19,000 in the win run): the compiled code itself is about 17,000 to 22,000 of a busy tick, the runtime's calls the rest (per tick `KEYDOWN` 1,300
  for the five keys, `FXMUL` up to 4,400, `WALL` up to 1,700; `PRINT` 550 a character, `TILE` 250 to 400 each). The worst tick of the logic is 37,435 (half a message printed, 8,400, on top of a walking tick).
* **Image**: 11,890 of 16,384 bytes of the game area (code 10,761 including the 768-byte HUD map, 163 tileset, 565 sound, 440 strings; sprite frames 512; maze 539 bytes RLE of 1,024), 308 bytes
  of the 2,048 of game variables, 16 of 16 sprite instances, 6 of 8 sprite assets. The runtime is 16,241 of 16,384 bytes.
* Estimates (not measured): on a real TS2068 the SCLD's memory contention may make the picture slower (`docs/ARCADE_HARDWARE_NOTES.md`); every number here is TSRun's. The mock-runtime figures printed by
  `tests/arcade-m8-vaults.mjs` (median 13,000 for `PROC FRAME`) leave out the runtime's routines and understate it.

## Art rules (what a billboard can be)

1. One colour: a billboard takes the ink of the view and the paper of the cell under it (ceiling black, floor blue). `#` is a lit pixel, `-` a pixel that hides what is behind it and shows the
   cell's paper (eyes, facets), `.` is transparent.
2. A billboard is **stretched to a square** of side `h / 32` cells (a 16-pixel sprite is half a wall high and half a cell wide): the art is drawn square. Width 16 and height 16, or 8 and 8.
3. Detail is lost at 4-pixel columns: a wraith 3 cells away is 11 pixels wide (3 columns). Bold shapes and one or two dark holes read best.

## Tests

* `tests/arcade-m8-vaults.mjs` (51 checks; part of `node arcade/tests/run-all.mjs`): the assets and the maze (the json is what the generator makes, the maze's rooms and reachability, the level data in
  the source), the link report, **the recorded runs on the reference interpreter** (a bump against the locked door, the key, a wraith shot dead, a gem, a potion, the door opened by `SETWALL`, the
  treasure; standing still until dead, the title, a new game that is clean), the HUD staying outside the window (the cell map compared every tick), **the compiled game equal to the interpreter tick by tick
  on the mock runtime for 1,436 + 394 ticks and 4 random 300-tick scripts**, and the same two runs on the **real runtime** (`arcade/build/v4`) with `SEEN` / `DEPTH` fed from its own `BB_TAB`.
* `tests/arcade-m8-vaults-bot.mjs` finds the recorded runs (`--write` rewrites `tests/arcade-m8-vaults-script.mjs`): a model of the player (the game's own arithmetic) walks a breadth-first path on the
  maze's cells; the walk does not depend on the wraiths. The shots use a synthetic sighting (the interpreter and the mock cannot draw), the real-runtime run uses the real ones.
* `tests/arcade-m8-vaults-perf.mjs`: the costs above.
