# Leap Arcade: project and asset formats, draft v0 (2026-11-09)

Authoring formats live in the project (`.leapgame`, a JSON document). The build turns them into the compact forms
that go on the cartridge; those compiled forms are decided by the linker per game (display family, sprite sizes,
shift phases), not fixed here. Implemented: see `ARCADE_STUDIO.md` and `ARCADE_STUDIO_S2_CONTRACT.md` (the editors and checks); this file stays the format reference.

## Project file
```json
{ "format": 1, "name": "Breakout", "framerate": 30,
  "files":  { "main.arc": "GAME \"Breakout\" ..." },
  "assets": { "sprites": {}, "tilesets": {}, "maps": {}, "sfx": {}, "music": {} },
  "scenes": { "play": { "display": "auto" } } }
```
* Saved in the browser (auto-save, one key per project), downloaded as `<name>.leapgame`, shareable by link when
  small. Several source files are allowed; `main.arc` is the entry. Assets are referred to by name in source
  (`SPRITE ball = "ball"` looks up `assets.sprites.ball`).
* `scenes.<n>.display` is `auto` (the build chooses, section 4 of the plan) or an explicit override set in the Studio:
  `flip`, `ecm`, `hires`.

## Colour model (the one rule behind all art)
Art is authored at the finest hardware precision: **per 8x1 row, two colours (ink, paper) and one BRIGHT flag**.
The build reduces it to the scene's display family:
* `ecm` (8x1 colour): used as authored.
* `flip` (8x8 colour): each 8x8 cell keeps one ink/paper/bright, chosen by the most used colours in the cell; the
  Studio shows the lost detail as a warning on that scene.
* `hires`: one ink/paper pair for the whole screen; art is reduced to 1-bit.
The Studio's editors enforce the two-colours-per-row rule while drawing and preview the result in each family.

## Sprites
`{ "w": 16, "h": 16, "frames": [ { "rows": [ { "bits": "FFFF", "mask": "FFFF", "ink": 7, "paper": 0, "bright": 1 }, ... ] } ], "hot": [x, y, w, h] }`
* `w` is 8, 16, 24 or 32 (more later); `h` 1-48; `bits` and `mask` are hex, MSB = leftmost pixel; `mask` 1 = sprite
  covers the background. `hot` is the collision box (default: the full size). Up to 255 frames per sprite.
* Compiled: pre-shifted phases (0, 2, 4 or 8 per sprite, chosen from how the game moves it), masked-blit routine
  specialised per width and display family; unused phases are not built.

## Tilesets and maps
* Tileset: up to **128** tiles of 8x8 (a scrolling world uses 0..31), each `{ "rows": [ 8 row objects as sprites ], "flags": 0, "fg": false }`;
  `flags` bit 0 = solid, 1 = hazard, 2 = pickup, 3-7 game-defined (read with `TILEFLAGS(t)`). The compiler takes a tile's attribute from
  **row 0 only**; the tile editor writes the same ink / paper / bright into all 8 rows. **`fg`** (authoring only, the compiler ignores it,
  S2): "sprites never pass over this tile"; it and the solid flag exempt a tile from the `background-attr-mix` check.
* Map: `{ "w": 64, "h": 24, "tileset": "bricks", "cells": "<w*h bytes, hex or run-length>" }`; one layer in v0. `cells` is an array or a hex
  string (2 digits per cell); blank is 255 (also -1 / null on read). `tileset` is authoring only (the compiler uses the program's `TILESET`);
  the map editor draws with it. Roles by source: cell map (<= 32 x 24, tiles 0..127), world map (`WINDOW`: 24..128 x 1..16, tiles 0..31, blank = tile 0),
  floor plan (`VIEW3D`: 4..32 per side, cells 0..4, none empty on the outer ring).
  Compiled as byte rows with run-length compression when it saves space; maps wider than the screen scroll.

## Sound
* `sfx` (as built in S2: `mix` bit 0 = tone off, bit 1 = noise off, bit 2 unused and always set by the editor: 6 tone, 4 tone + noise, 5 noise, 7 neither;
  a record with tone 3840..4095 and vol 15 is unstorable; at most 1,800 ticks in the Studio; one record per refresh, about 60.1 a second):
  `{ "ticks": [ { "tone": 0..4095, "vol": 0..15, "noise": 0..31, "mix": 0..7, "env": null }, ... ] }`: one record
  per refresh on one AY channel; compiled as 4-byte records with run-length for steady stretches. Played by the
  frame-interrupt tick, independent of `FRAME`.
* **Three-channel effects** (language batch 5, `docs/ARCADE_LANGUAGE_BATCH5.md` Part C items 16 to 20): `{ "ticks": [...], "ticksB": [...], "ticksC": [...] }`.
  `ticks` is AY channel A (as above, unchanged); `ticksB` and `ticksC` are optional arrays of the same records for channels B and C
  (absent, `null` or `[]` = none, and the Studio writes them only when they hold ticks). The channels play in lockstep, one record each per refresh;
  a shorter channel is padded with the silent record `tone 0, vol 0, noise 0, mix 7`, and the effect lasts as long as the longest channel.
  The same limits apply to every channel (1,800 ticks per channel in the Studio; tone 3840..4095 with vol 15 is unstorable in any channel; the
  sound check `sfx-unstorable` names the channel). The AY has **one noise generator**: R6 takes the `noise` of the lowest channel (A, then B,
  then C) whose record has noise on at that refresh, else channel A's.
* **Image** (`convertSfx(asset)` -> `{records, channels, bytes}`): one channel (no `ticksB` / `ticksC`, or both empty) is exactly the old form, `channels: 1`:
  4-byte records (`tone_lo`, `tone_hi | vol << 4`, `noise | mix << 5`, `0`) and the terminator record `0, $FF, 0, 0`. With channel B or C the image is
  a **register delta stream** (revised 2026-11-10; the first version's 12-byte groups never shipped): the 4-byte header `0, 0, 0, 3` (byte 3 = the
  channel count; 0 or 1 = a one-channel effect), then **one entry per refresh**: `n` (0..11) followed by `n` pairs `reg, value` in ascending register
  order, and the single byte `$FF` at the end. The compiler works out the 11 AY register values of each refresh, so the runtime has no channel logic:
  R0 / R2 / R4 = tone low bytes of A / B / C, R1 / R3 / R5 = the tone high nibbles (`(tone >> 8) & 15`), R6 = the noise of the lowest channel
  whose record has noise on that refresh (none: channel A's), R7 = the mixer (bit `c` = channel `c`'s mix bit 0, tone off; bit `3 + c` = its mix bit 1,
  noise off; bits 6 and 7 zero; c = 0 for A), R8 / R9 / R10 = the volumes of A / B / C. The **first entry holds all 11 registers**
  (the compiler cannot know what the chip held); every later entry holds only the registers whose value differs from the previous refresh's, so a steady
  stretch costs one byte per refresh. Size: `4 + sum over refreshes of (1 + 2 * changed registers) + 1`; for example three 30-tick fades (steady tones,
  volume falling every second tick) take 141 bytes where the 12-byte groups would take 364. `records` is the length of the longest channel, which is
  what the interpreter's sound-length model uses. The size panel and the sound editor (`sfxInfo`) count the real encoded length
  (`sfxRefreshRegisters` and `sfxStreamLength` in `src/lang/arcade/arcade-assets.js` are the shared source). Tested by `tests/sfx-stream.mjs` with an
  independent stream player. The runtime half (`SND_TICK` reading the stream) is separate: the current runtimes cannot play a three-channel effect yet.
* `music`: *later* (pattern/instrument format when game B needs it; the player runs in the interrupt).

## Size accounting
The Studio reports bytes by category (runtime modules, code, sprites, tiles, maps, sound) against the 64 KB DCK and
against RAM use, updating as assets change, so a game never overflows silently at export.

## Import
Image import converts a picture to a sprite or tileset with palette reduction and ordered / error-diffusion dither
(Sierra-style) to the two-colours-per-row rule; the result is editable. Sprite sheets split by grid.
