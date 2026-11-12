# Orbit Gates (`orbit.arc`)

The sample game of the wireframe 3D mode (`WIRE3D`, `docs/ARCADE_WIREFRAME_CONTRACT.md` section 9): a first-person flight through a course of gates, for the **v2 runtime** (with the wireframe mode), `FRAMERATE 20`.

## Play

Fly through the gates (a flat octagon, radius 256 units, turning a little as you come). A gate passed within 220 units of its middle scores 50 plus your speed, adds 150 fuel, and every 5th gate gives a shield back (at most 3). A gate flown past
at the edge or 600 units behind is missed (a buzz, no score). Tumbling rocks drift sideways beside the course: a rock within 100 units of you costs a shield (a crash, a burst in the middle of the screen, 20 ticks of protection). The flight
ends when the fuel (starts at 900, one a tick) or the shields run out. Fire starts a game and takes you back to the title from the game over (release it first).

Keys: **O** left, **P** right, **Q** faster, **A** slower (speed 8 to 40), **Space** fire. Joystick 1: the stick and fire.

## Scenes

* **`title`** (`NOVIEW`): the ring logo in tiles, the name, the best score, the controls, the title song (`MUSIC theme`, original, written with `songs.mjs`).
* **`play`**: the 3D flight (`WIRE3D ROWS 2 TO 21`: pixel rows 16 to 175, the horizon at row 96). The HUD is the four rows outside the play area (score, gates, fuel, shields, speed).
* **`over`** (`NOVIEW`): the score, the best score, the gates passed, why it ended.

## How it uses the mode

* `EYE px, 0, pz, ea` is the player; `COSA` / `SINA` / `FXMUL` move it along its heading (`px += FXMUL(spd, SINA(ea))`) and test a gate pass (`along`, `side`, in the gate's own heading).
* `DRAWMODEL gate AT .. YAW ch + wobble SCALE 4` for the current and the next gate, `DRAWMODEL rock AT .. YAW .. PITCH .. SCALE 2` for two rocks: **at most 4 models a tick**, and only those in front of the eye.
* `LINE` draws the gunsight and the horizon marks. The `burst` sprite (16 x 16, one phase) is `SHOW`n over the lines for 6 ticks after a hit.
* The origin is moved (the eye, the gates and the rocks together) when the eye is more than 12000 units out on an axis; a gate more than 9000 units away is given up and the course starts again ahead of the eye.
* The models are written as code in `orbit.assets.gen.mjs` (no model editor yet), as the songs are.

## Files

| File | What |
|---|---|
| `orbit.arc` | the game |
| `orbit.assets.gen.mjs` | the models, the sprite, the tiles, three sounds and the song; writes `orbit.assets.json` (`--check` compares without writing) |
| `orbit.assets.json` | generated, committed |
| `tests/arcade-orbit.mjs` | the game on the reference interpreter: a bot that reads the game's variables flies 3,000 ticks and passes 60 gates; the no-input, rock-hit and fly-away runs; the pictures against the reference. The runtime part is a TODO in the file |

## Build

```
node arcade/tools/arcadec.mjs arcade/examples/orbit.arc --assets arcade/examples/orbit.assets.json --runtime v2
```

Needs a v2 runtime build with the wireframe mode (`RT_WIREMODE`, slice W2).

## Names the language forced

`flash` is a reserved word (the colour attribute), so the sprite is `burst`; a `GATES` variable and a PROC of that name clash, so the pass test is `TESTGATE`. `AND` / `OR` are logical, so the angle masks use `BAND`.
