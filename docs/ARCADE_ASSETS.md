# Leap Arcade: project and asset formats, draft v0 (2026-11-09)

Authoring formats live in the project (`.leapgame`, a JSON document). The build turns them into the compact forms
that go on the cartridge; those compiled forms are decided by the linker per game (display family, sprite sizes,
shift phases), not fixed here. Nothing is implemented yet.

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
* Tileset: up to 256 tiles of 8x8, each `{ "rows": [ 8 row objects as sprites ], "flags": 0 }`; `flags` bit 0 = solid,
  1 = hazard, 2 = pickup, 3-7 game-defined (read with `TILEFLAGS(t)`, *later*).
* Map: `{ "w": 64, "h": 24, "tileset": "bricks", "cells": "<w*h bytes, hex or run-length>" }`; one layer in v0.
  Compiled as byte rows with run-length compression when it saves space; maps wider than the screen scroll.

## Sound
* `sfx`: `{ "ticks": [ { "tone": 0..4095, "vol": 0..15, "noise": 0..31, "mix": 0..7, "env": null }, ... ] }`: one record
  per refresh on one AY channel; compiled as 4-byte records with run-length for steady stretches. Played by the
  frame-interrupt tick, independent of `FRAME`.
* `music`: *later* (pattern/instrument format when game B needs it; the player runs in the interrupt).

## Size accounting
The Studio reports bytes by category (runtime modules, code, sprites, tiles, maps, sound) against the 64 KB DCK and
against RAM use, updating as assets change, so a game never overflows silently at export.

## Import
Image import converts a picture to a sprite or tileset with palette reduction and ordered / error-diffusion dither
(Sierra-style) to the two-colours-per-row rule; the result is editable. Sprite sheets split by grid.
