# CRABSMASH: a single-screen arena game (fine colour, runtime v2)

An original arena game in the single-screen genre (genre and mechanics only: its own name, characters, art, music and sounds), for runtime v2,
every scene in fine colour (8 x 1 colour; `docs/ARCADE_FINE_COLOUR_CONTRACT.md`). Built in stage 6B of the Studio completion from the owner's
approved stills (hero, crab, fly, arena). Because the v2 runtime has no `FLIP` (and a game with `FLIP` or `WINDOW` needs v3, which cannot do fine
colour), **every sprite is drawn mirror symmetric**: the hero is seen from the front.

## The game

* **You are the hero** in the arena: three platforms, a floor and two pipes at the top. **Crabs and flies** come out of the pipes and wander down.
* **Bump a platform from below** (jump into its underside): every enemy standing on that platform within 24 pixels of you is **stunned** (it hops and
  lies on its back; a fly blinks). Then **walk into a stunned one to smash it**: 200 points for a crab, 300 for a fly. Bumping a stunned one again
  **wakes it, angry** (faster for good).
* **A live enemy that touches you costs a life** (3 lives; a short pause, then you are back on the floor and cannot be hurt for about 2.5 seconds, the
  hero blinks). Smashed enemies leave a **coin** five cells away: fetch it for 500 before it fades (about 8 seconds).
* **Phases.** Smash every enemy of a phase to clear it (1000 points) and the next begins: more enemies (4 + the phase number, at most 12), flies from
  phase 2 (every fourth), quicker legs from phase 3 (4 pixels on every other tick), shorter stuns (170 - 14 x phase ticks, at least 60), a quicker pipe
  (64 - 6 x phase ticks between enemies, at least 26). Never more than 3 enemies are out at once.
  **Phase 1 is the lesson** (added after the owner could not get through it): 3 crabs (not 5), a stun of 300 ticks (15 seconds), a pipe every 90 ticks (4.5 seconds),
  and a **hint** on the screen, "JUMP UP UNDER A PLATFORM TO STUN A CRAB, THEN TOUCH IT!" on text rows 9 and 10. The hint is printed a few characters a tick in the first
  four ticks of the scene (a text cell costs about 1,800 T), and taken away in four ticks when phase 2 begins (`PROC HINT`, `hn` 1 to 9), which also puts back the five stars of the
  arena map it covered. From phase 2 the numbers are as before.
* The left and right edges wrap round for the hero and the enemies; an enemy that walks off the end of the floor goes back into the pipe on that
  side, and one that walks off a platform's end falls to the platform below.
* **The goal:** the best score (kept for the session; shown in the HUD and on the title and the game over). The game has no end: the phases only
  get harder.
* Controls: **O** left, **P** right, **Q** or **SPACE** jump; joystick 1 left, right, up or fire. Fire starts the game and restarts it after
  GAME OVER. The title says all of this on screen.

## Layout (fixed by `crabsmash.assets.gen.mjs`; the program's DIMs must agree, and `--check` and the test compare)

* Surfaces (y of the walking surface, x range): floor 176 (0..256), tier 3 at 144 (0..80 and 176..256), tier 2 at 104 (48..208), tier 1 at 64 (0..104 and
  152..256). The program keeps them in `PYS` / `PX0` / `PX1`. A platform is one cell row (8 pixels) thick; the hero is 16 x 16, stands with its feet on a
  surface and cannot pass up through a platform (a bump) but can come down through its gaps.
* The hero walks 4 pixels a tick, jumps with 10 pixels up in the first tick (gravity 1, at most 8 down): 55 pixels high, so he reaches the next tier
  by the gaps and the platform ends (the bot climbs by jumping from an edge towards the next tier). Crabs walk 2 pixels a tick, flies 4 and hop.
* Map `arena` (32 x 24) is the whole screen: HUD row 0, pipes in rows 2..5 at both corners, the platforms, the floor in rows 22 and 23 and a few
  stars. Maps `logo`, `press` and `over` are text pictures. The coin is tiles 1..4 (TL TR BL BR), so a `TILE` can put it anywhere; it is drawn over two
  ticks (top row, then bottom row) so that no tick is much heavier than the others.

## Art and the asset budget

* **8 sprite assets, 16 x 16, 4 phases each = 32 phases** (a fine game's cap), one ink per pixel row, all symmetric: `herora`, `herorb` (run A, run
  B), `herojump`; `craba`, `crabb` (walk), `stun` (on its back); `flya`, `flyb` (wings up, down). The coin and everything else is tiles (67 of 128).
* **16 instances** (the most a game may have): hero 3 forms, crab slots 0..2 with 3 forms each, fly slots 0..1 with 2 forms each. A form change is a
  `HIDE` and a `SHOW`. A stunned fly has no sprite of its own: it blinks.
* Sprite colour in a fine scene is the INK of each pixel row over the background's paper (`docs/ARCADE_FINE_COLOUR_CONTRACT.md` section 2), so the
  runtime's new classic-scene sprite colour setting (SC) is not needed here and is not used.

## Budget (measured on TSRun, `tests/arcade-crabsmash.mjs`)

FRAMERATE 20 (176,064 T a tick). Movers at once: the hero and at most 3 enemies. The first version allowed 4 enemies out at once and its heaviest tick
took 175,923 T (99.9 % of the budget); with 3 the heaviest tick over the play-through is about 157,000 T (89 %), the median 125,000 T with three
enemies out, and 100 % of the play ticks keep 20 Hz. Spread over ticks for that reason: the coin's two rows, and the HUD (printed the tick after the
event: a text cell costs about 1,800 T in a fine scene, and only numbers that changed are printed).

## Test

`node tests/arcade-crabsmash.mjs` (`ARCADE_QUICK=1` shortens it): the build and the art rules; a bot (`tests/crabsmash-bot.mjs`) plays 3,600 ticks on
the real runtime and the interpreter replays it (every tick equal, the sound at song level); the rules read off every tick (also for a run started at
phase 4, with flies); the picture against the reference fine picture; 20 Hz; the beam (0 broken frames) and the work of the heaviest ticks; the real
game (3 lives, game over, new best, restart).
