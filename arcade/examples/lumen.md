# LUMEN: the fine-colour showcase game (a maze chase)

An original game in the maze-chase genre (genre and mechanics only: its own name, characters, art, music and mazes) for runtime v2,
every scene in fine colour (8 x 1 colour; `docs/ARCADE_FINE_COLOUR_CONTRACT.md`). The owner chose the genre and approved the stills on
2026-11-15, with the walls alternating per cave between rainbow tubes and ice tubes.

## The game

* **You are the wisp**, a ball of light in a cave maze. Eat every **light orb** on the cave to clear it (10 points each).
* **Four shades** hunt you: Ember (red), Bloom (magenta), Moss (green) and Frost (cyan). A shade that touches you costs a life (3 lives).
* **A prism** in each corner (50 points): for a while every shade turns **pale** and flees; touching a pale shade sends it back to its lair,
  for 200, 400, 800 and then 1600 points within one prism. A pale shade flickers before it turns back.
* **Rising challenge:** each cave the shades are faster, chase more often and stay pale for less time. The caves alternate between the two
  mazes (odd caves: maze 1, rainbow tubes; even caves: maze 2, ice tubes). A cave cleared gives a bonus of 100 x the cave number.
* **The goal:** the best score (kept for the session and shown on the title and the game over).
* Controls: Q up, A down, O left, P right, or joystick 1. Fire (SPACE or the joystick's fire) starts the game and restarts it after
  GAME OVER. Every control shown on screen does something.

## Layout (fixed by `lumen.assets.gen.mjs`; the program's CONSTs must agree, and its test checks that they do)

* The screen: cell row 0 is the HUD (score, best, cave), row 23 the lives. The maze is 16 x 11 **blocks** of 16 x 16 pixels on cell rows
  1..22: block (bx, by) is cells (2 bx, 1 + 2 by) .. (2 bx + 1, 2 + 2 by), and a sprite standing on it is at x = 16 bx, y = 8 + 16 by.
* Maps `maze1` and `maze2` are whole screens (32 x 24; rows 0 and 23 empty), loaded with `LOADMAP mazeN` (at 0, 0). `logo` (LUMEN, 10 x 2
  cells), `press` (PRESS FIRE TO PLAY, 18 x 1) and `over` (GAME OVER, 18 x 2) are loaded `AT` a position.
* A block is told by the tile of its **top-left cell** (`TILEAT(2 * bx, 1 + 2 * by)`): 0 the floor, 1 an orb (its four cells are tiles 1, 2,
  3, 4: TL, TR, BL, BR), 5 a prism (5..8 the same way), 9 the lair's door (its cells 9, 9, 10, 10), 11 or more a wall (`TWALL` = 11). Eating
  an orb or a prism puts tile 0 in its four cells.
* The wisp starts on block (7, 7). The lair is blocks (7, 5) and (8, 5), behind the door (blocks (7, 4) and (8, 4)); the block above the door
  is open floor. The door is a wall to the wisp and open to the shades. Orbs per maze: 74 and 76.
* Sprites (16 x 16, 4 phases each, so x is a multiple of 2): `wispa`, `wispb` (two frames of the wisp's flicker, shown in turn), `ember`,
  `bloom`, `moss`, `frost` (one asset each: a sprite's colour in a fine scene is its asset's row inks) and `pale` (a fleeing shade; a pool of 4).
  28 sprite phases in all (a fine game may have 32). At most 5 sprites move at once (the wisp and four shades): about 25,000 T each a tick.

## Movement and the shades

* FRAMERATE 20. The wisp moves 4 pixels a tick. It turns at a block boundary (x and y both on the block grid) into the direction asked for if
  that block is open; otherwise it goes on if it can, else stops. Reversing works at any time. A step never goes past the next boundary.
* A shade moves 2 or 4 pixels a tick (its speed rises with the cave, e.g. a 4-pixel step on some ticks and 2 on the others, never passing
  a boundary). At each boundary it picks one of the open directions other than back the way it came (back only at a dead end): with a
  chance that grows with the cave it takes the one that brings it nearer the wisp (pale: farther from it), else a random one. Each shade
  has its own chance (Ember chases most, Frost least), so they do not move as one.
* Shades leave the lair one by one through the door (upwards), a few seconds apart at the start of a cave and after a lost life.
* A shade sent back to the lair waits there a moment, then comes out again (not pale).
* Losing a life: a short pause, every shade back to the lair, the wisp back to the start; the orbs stay eaten.

## Scenes

* `title`: the logo, PRESS FIRE TO PLAY (graded), one line of rules, the keys, BEST; music (an original tune, minor, cave-like).
* `play`: the maze, the HUD (only the numbers that changed are printed: every text cell costs about 1,800 T in a fine scene), a "CAVE n"
  word when a cave starts, music on channels A and B with the effects on C (as Starfall), effects for an orb, a prism, a shade sent back, a
  life lost and a cave cleared.
* `over`: GAME OVER (rainbow), the score, the best and "NEW BEST" when it is one, PRESS FIRE TO PLAY; fire (released and pressed again) starts
  a new game.

## Budget

At most 5 moving 16 x 16 sprites (the wisp, four shades) at 20 Hz in the fine play scene; the target is FRAMERATE 20 in at least 99 % of the
play ticks over the recorded runs (contract section 8). If the logic does not fit, the shades' decisions may be spread over ticks (one shade
decides a tick), never the frame rate dropped.
