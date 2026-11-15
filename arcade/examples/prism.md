# Prism Catch (`prism.arc`)

The showcase game of **fine colour** (SCLD mode 2, 8 x 1 colour: one ink / paper / BRIGHT per 8 x 1 pixel group instead of per 8 x 8 cell; `docs/ARCADE_FINE_COLOUR_CONTRACT.md` sections 2 and 10) for the **v2 runtime**, `FRAMERATE 20`.

## Play

Gems of four colours (green, cyan, yellow, white) fall from a sunset sky. Your catcher, a bowl on the sea, is **one of the four colours**: **catch a gem of your colour** and you score; **a gem of another colour, or a gem you miss, costs one of your three lives** (the hearts at the top right). When the lives are gone the game is over; the **best score** is kept for the session and shown on the title and game over screens.

* **Score.** 10 points a catch, times a multiplier that grows with the streak (x2 after 5 catches in a row, x3 after 10, x4 after 15; a lost life puts it back to x1; the HUD shows it as `x2`). Clearing a wave adds 25 x the wave number.
* **Waves.** Each wave has more gems (6 + 2 x the wave, at most 30), they fall faster (3 pixels a tick at first, up to 7) and more are in the air at once (2 at first, up to `MAXGEMS`, reached in wave 7). A "WAVE n" banner and a short jingle (`MUSIC`) come between waves; the song of the play scene (A and B only, so the sound effects borrow channel C) starts when the banner goes.
* **The glow band.** From **wave 3** a gem **changes colour** as it crosses the glow band of the sky (the neon stripe of black and bright magenta rows about a third of the way down), with a ping: the colour that counts is the one it has when it reaches the bowl, so watch it and be ready to switch.
* **Keys:** **O** left, **P** right; **1 2 3 4** choose the colour (green, cyan, yellow, white), **Q** steps back through the colours, **A** and **Space** step on. **Joystick 1:** left / right, and fire steps the colour on. Fire (or Space) starts the game on the title and again after GAME OVER (release it first).

## Scenes and the fine colour setting

* `title` and `over` are the ordinary **two-buffer 8 x 8 colour** scenes. They show the same sky tiles with one colour per cell (the colour of the tile's first pixel row), so you can see what the play scene adds.
* **`play` is the fine colour scene.** There is no new word: fine colour is a *project setting*, `scenes.play.display = "fine"`, which an assets file carries as the top-level key `"scenes": {"play": {"display": "fine"}}` (`prism.assets.gen.mjs` writes it; `arcadec` reads it). The source is ordinary Leap Arcade; the compiler calls `RT_FINEMODE` in the `ENTER` sequence of `play` and in `over` / `title` switches back to the two-buffer setup.

## How it shows fine colour

* **The sky is per-row colour.** One tile per character row (`tile r` = cell row `r`); each tile's eight pixel rows have their own paper and BRIGHT. Between the stops (black, blue, bright blue, magenta, bright magenta, red, bright red) the rows alternate between the two colours in a changing proportion (a 4-row ordered dither), ending in a yellow horizon line; below it a dark sea of blue and black rows. An 8 x 8 attribute screen cannot show any of it. The bitmaps are **empty** (paper only), so a sprite passing over never recolours a background pixel: in a fine scene a sprite sets the *ink* of the 8-pixel groups it covers and nothing else. A few star tiles (a white pixel on the same row colours) sit in the upper sky.
* **The glow band** is the same trick with BRIGHT and black: pixel rows 64 to 79 alternate bright magenta and black, thinning out at the edges.
* **Sprites are shaded per row, one asset per colour.** A fine sprite's colour is each row's ink, so a colour is a separate asset (`gem0..3`, `cat0..3`) whose rows have their own inks: a white crown (the highlight), the body colour, a darker tip. The gems are 16 x 16, **1 phase** (they fall on 8-aligned columns), the catchers 16 x 8, **4 phases** (x in steps of 2): **4 x 1 + 4 x 4 = 20 sprite phases** (a fine game may have 32).
* **A pool of three sprites a colour.** A gem that changes colour needs a free sprite of its new colour, so each colour has a pool of 3 (`gem0(3)` ..): 4 catchers + 4 x 3 gems = the 16 instances the v2 runtime has. A gem takes a free slot of its colour at its birth and swaps to another colour's free slot in the glow band (when none is free it keeps its colour).
* **Bursts and the HUD are tiles and text.** A caught gem makes a three-frame burst of tiles above the bowl in its own colour (a red burst for the wrong colour, a splash in the sea for a miss), made of tiles whose rows carry the sea / horizon paper of that cell row; the lives are a heart tile each; the HUD text is the ordinary text, in fine colour. Text and tiles are redrawn only when they change (the score, the wave, the multiplier and the hearts: one `SHOWHUD` after an event), because every changed cell costs about 1.8k T.

## The number of gems at once: `MAXGEMS = 5`

The one constant at the top of `prism.arc`. Every gem is a moving 16 x 16 sprite, about **25,000 T** a tick in a fine scene (compose and publish, `arcade/runtime/v2/NOTES-FINE.md`), and a 20 Hz tick is 176,064 T, so the speed decides it: **5** holds 20 Hz, **6** does not.

| `MAXGEMS` | what the run showed (the bot of `tests/arcade-prism.mjs`, 2,000 ticks, TSRun) |
|---|---|
| 5 | 100.0 % of the play ticks started on time (a tick every 3 refreshes); with 5 gems in the air the tick work (publish + `FRAME` + compose + interrupts) is median 150,491 T, worst 170,169 T, none over the 176,064 T budget |
| 6 | 95.6 % on time overall, but with 6 in the air the tick is median 172,992 T, worst 189,563 T, 57 of 145 over the budget |
| 8 | 86.2 % on time |

(The ramp follows the constant: `conc = 2 + wave x (MAXGEMS - 2) DIV 7`, so the cap is reached in wave 7 whatever the value; the owner may change it between 1 and 12: more gems means slower ticks and more late ticks. The assets and the pools are fixed at 3 a colour.)

## Measured (TSRun, the real v2 runtime; `node tests/arcade-prism.mjs`)

* **20 Hz:** over the 1,991 play ticks of the bot's run, **100.0 %** started 3 refreshes after the one before (worst gap 3); a 3,500-tick run gave 99.9 % (3 ticks started 4 refreshes after the one before). Tick work over the heaviest 599 ticks: median **112,166 T**, 95th percentile 157,351, 99th 164,784, **worst 170,169 T** (budget 176,064).
* **Beam:** every frame TSRun paints in that window, 1,789 frames, 600 updates: **clean 1,789, torn 0, broken 0** (method BD, `docs/ARCADE_FINE_COLOUR_CONTRACT.md` section 3a).
* **Sprite phases:** 20 (cap 32). **Instances:** 16. **Size:** the game 12,029 of 16,384 bytes (4,355 free), of which the three songs 4,287 bytes; the cartridge file 32,777 bytes. The runtime is v2 (15,316 bytes of its 16,384).
* The interpreter and the runtime agree on every tick of the 2,000-tick run (variables, arrays, cells, attributes, sprites) and on the sound at song level, and the real screen equals the reference picture of the interpreter's state (`finePicture`) after every tick of the play scene.

## Files

| File | What |
|---|---|
| `prism.arc` | the game: `title`, `play` (fine colour), `over` |
| `prism.assets.gen.mjs` | the art (the per-row sky, 8 sprites, 76 tiles), six sound effects, three songs (written with `songs.mjs`), the sky map and the `"scenes"` setting; writes `prism.assets.json` (`--check` compares it, and compares the tile numbers and the sky's two row tables that `prism.arc` repeats by hand) |
| `prism.assets.json` | generated, committed |
| `tests/arcade-prism.mjs` | the bot, the interpreter comparison, the rules, the picture, the 20 Hz share and the beam (`ARCADE_QUICK=1` shorter; `PRISM_SCRIPT=<file>` writes the bot's keys for screenshots) |

## Build

```
node arcade/tools/arcadec.mjs arcade/examples/prism.arc --assets arcade/examples/prism.assets.json --runtime v2
```

Needs the v2 runtime with fine colour (`RT_FINEMODE`; `node arcade/tools/build-runtime-v2.mjs`). The Studio plays it in the Examples menu with the play scene set to fine colour (`publish-runtime.mjs` carries the assets file's `"scenes"` into the example project).

## Names the language forced

Names cannot contain an underscore, so the tile constants are `TSTAR`, `THEART`, `TBURST`; `AND` / `OR` are logical, so the colour wrap is `MOD`; a parameter may not share a variable's name (`FREESLOT(cl)`, the scene variable is `c`).
