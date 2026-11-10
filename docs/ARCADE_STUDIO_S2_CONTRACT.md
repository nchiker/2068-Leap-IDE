# Leap Arcade Studio, slice S2: tile, map and sound editors, asset warnings (contract, 2026-11-10)

Written **before any code**. It fixes the files, the rules, the host additions and the acceptance tests. Where the code
finds a reason to differ, change this file in the same commit. Context: `docs/ARCADE_STUDIO.md` (shell, "Asset editor host
interface", which this slice extends), `docs/ARCADE_ASSETS.md` (formats), `docs/ARCADE_PLATFORMER_CONTRACT.md` section 9 and
`docs/ARCADE_LANGUAGE_GAPS.md` (where the three warnings were promised), `src/tools/sprite-editor.js` (the pattern to follow).

## 1. Scope

| Part | Files | Asset kind |
|---|---|---|
| Asset checks (pure, Node-importable) | `src/lang/arcade/arcade-assetcheck.js`; `scanRoles(text)` added to `src/lang/arcade/arcade-scan.js` | tilesets, maps, sfx |
| Tile editor | `src/tools/tile-model.js` (pure), `src/tools/tile-editor.js` | `tilesets` |
| Map editor | `src/tools/map-model.js` (pure), `src/tools/map-editor.js` | `maps` |
| Sound editor | `src/tools/sound-model.js` (pure, includes the AY renderer), `src/tools/sound-editor.js` | `sfx` |
| Studio wiring | `studio.js`, `studio.html`, `studio.css`, `docs/ARCADE_STUDIO.md` (host table) | |
| Tests | `tests/arcade-assetcheck.mjs`, `tests/tile-model.mjs`, `tests/map-model.mjs`, `tests/sound-model.mjs` (Node); `tests/tile-editor-smoke.mjs`, `tests/map-editor-smoke.mjs`, `tests/sound-editor-smoke.mjs` (headless Chrome on a fake host, like `sprite-editor-smoke.mjs`); a block in `tests/studio-smoke.mjs` | |

Out of scope, with the planned item each belongs to: `music` assets (the `MUSIC` / 3-channel player item), animated tiles
(the tile editor will author them with that item), image import for tiles (the sprite editor's importer stays sprite-only
until a game needs it), a source-text rewrite when an asset is renamed (the S1 rule stays: warn).
Nothing found while building is to be parked: fix it in the slice.

## 2. Formats (what the compiler accepts; the editors must write exactly this)

* **Tile set** `{tiles: [{rows: [8 x {bits, ink, paper, bright}], flags, fg?}]}`. `bits` is a 1..2 digit hex string; the compiler
  takes a tile's **attribute from row 0 only** (`bright << 6 | paper << 3 | ink`), so **the tile editor writes the same
  ink / paper / bright into all 8 rows** (a tile is one 8x8 colour cell). `flags` 0..255 (bit 0 solid, 1 hazard, 2 pickup, 3..7
  game-defined). At most 128 tiles (a cell-map cell holds 7 bits); a scrolling world uses tiles 0..31 only.
  **New authoring field `fg` (boolean, default false): "sprites never pass over this tile".** The compiler ignores it
  (`validateAsset` does not look at it; unknown keys survive the save/load round trip, which a test checks).
* **Map** `{w, h, cells, tileset?}`. `cells` is an array of `w*h` numbers or a hex string, 2 digits per cell; a cell is a tile
  index, or blank (`255`, `-1` or `null` on read). The editor keeps the representation it read (array stays array, string stays
  string) and writes blank as `255` in both (one blank form on write).
  `tileset` (authoring only, the compiler ignores it) names the tile set the editor draws with.
  Shapes by role, from the compiler (`arcade-assets.js`, `arcade-window.js`, `arcade-view.js`):
  cell map `w <= 32, h <= 24`, tiles 0..127, blank = a font space; **world map** (the map a `WINDOW` names) `w` 24..128, `h` 1..16,
  tiles 0..31, **blank = tile 0**; **floor plan** (the map a `VIEW3D` names) `w`,`h` 4..32, cell value 0..4 (0 empty, 1..4 wall
  codes), **no empty cell on the outer ring**.
* **Sound effect** `{ticks: [{tone 0..4095, vol 0..15, noise 0..31, mix 0..7}]}`, one record per **refresh** (58,688 T at
  3.528 MHz, about 60.1 per second), on AY channel A. `mix` bit 0 = tone **off**, bit 1 = noise **off**, bit 2 unused (the
  examples use 6 = tone only, 4 = tone and noise, 5 = noise only; the editor writes 6 / 4 / 5 / 7 for tone only / tone + noise / noise only / neither, bit 2 always set, as they do; the runtime's R7 is `%00110110 | mix bit 0 | mix bit 1 << 3`).
  A record with tone 3840..4095 **and** vol 15 cannot be stored (`convertSfx` throws): the editor refuses to make one. At most 8
  effects per game (the code generator checks; the editor shows the count).

## 3. The three warnings (and the checks that go with them): `arcade-assetcheck.js`

```js
checkAssets(project, roles) -> [{id, severity: 'warning' | 'error', kind, asset, tile?, cells?, message, compilerAlso: bool}]
```
Pure; never throws (a malformed asset yields a message, not an exception). `roles` comes from `scanRoles(sourceText)`:
`{tileset: assetName | null, maps: {mapDeclName: assetName}, world: assetName | null, floorplans: [assetName], view: {bright, ceil, floor} | null}`
(`world` = the asset of the map the `WINDOW` line names; `floorplans` = the `VIEW3D` map; `view` = the effective BRIGHT, CEIL and
FLOOR paper of the `VIEW3D`, defaults BRIGHT 1, CEIL 0, FLOOR 1; null without `VIEW3D`). With no source roles (`roles` null) the
role-dependent checks are skipped, never guessed. The Studio passes `scanRoles(P.buildSource(project).text)`.

| id | Rule | Where it shows |
|---|---|---|
| `black-bright-mix` (warning) | Per tile set. A tile **uses black** when paper is 0 and its bitmap has a clear bit, or ink is 0 and it has a set bit. If some tile that uses black has BRIGHT 0 **and** some has BRIGHT 1, warn, naming up to 6 tiles of each kind. With `roles.view`: a `VIEW3D` whose CEIL or FLOOR is 0 counts as a black-using tile of the view's BRIGHT. Reason in the text: TSRun draws BRIGHT black as dark grey and plain black as black (Fuse and ZEsarUX draw both black), so a screen mixing them looks patchy in the Studio. | tile editor banner, problems list |
| `background-attr-mix` (warning) | Per map that is a cell map or the world map (not a floor plan). **Background tiles** are the used tiles that are not foreground (`flags & 1` solid, or `fg: true`). In a world map blank cells count as tile 0; in a cell map blank cells are ignored. If the background tiles used carry **more than one attribute byte**, warn with each attribute (ink, paper, bright), its tiles and its cell count. Reason: a sprite takes its colour from the screen cell under it, so sprites change colour as they move. The fix is in the text: same colours, or mark the tile "sprites never pass over". A tile that is not used by the map is ignored. | map editor banner (tiles in the palette get a marker), tile editor, problems list |
| `tile0-not-blank` (warning, `compilerAlso`) | For the tile set the world map is drawn with (the `roles.tileset`, or the map's own `tileset`): tile 0's bitmap is not all zero. | tile editor (tile 0), map editor banner. Already a compiler warning, so **not repeated in the problems list** (`compilerAlso: true`); a test asserts the compiler warns for exactly the cases this rule flags |
| `world-shape` (error, `compilerAlso`) | The world map is not 24..128 x 1..16, or uses a tile above 31 or one the tile set does not define. | map editor banner |
| `floorplan-shape` (error / warning, `compilerAlso`) | Floor plan outside 4..32 per side, a cell above 4 (error), an empty cell on the outer ring (error). | map editor banner |
| `map-tileset-mismatch` (warning) | A cell map or world map whose own `tileset` names a different tile set than the program's `TILESET`. | map editor banner |
| `map-undefined-tile` (error, `compilerAlso`) | A cell uses a tile index the tile set does not define. | map editor (the cell is drawn as a red cross) |
| `sfx-unstorable` (error, `compilerAlso`) | A record with tone 3840..4095 and vol 15. | sound editor (the tick is marked) |
| `tileset-size` (warning) | More than 32 tiles in the world's tile set (tiles above 31 cannot be used in the world); more than 128 anywhere (error). | tile editor |

Severity: the Studio never blocks on a warning. `compilerAlso` rows are shown in the editors but left out of the problems list
because the compile already reports them.

## 4. Tile editor (`tile-editor.js` over `tile-model.js`)

* Layout: a **tile strip** (all tiles of the set, attribute colours, index under each, markers for warnings, solid / hazard / pickup
  / fg, "used in map X" count) on the left; the 8x8 **pixel grid** (zoom 16..32 px per pixel) in the middle; a side panel with
  ink / paper (the 8 colours), BRIGHT, the flag checkboxes (solid, hazard, pickup, bits 3..7 as numbers 3..7), the **fg** checkbox
  ("sprites never pass over"), a **preview** of the tile at 1x and tiled 4x4 (to see seams), and the set's warnings.
* Tools: pencil (click and drag set, the first pixel decides set or clear), fill, line, eyedropper not needed (two colours only),
  clear, invert, flip left-right / up-down, rotate 90, shift in four directions (wrap), copy, paste, undo / redo (200 steps,
  `createHistory(x, 201)` of `sprite-model.js`: its second argument counts snapshots, so 201 gives 200 undo steps), keys as the sprite editor where they apply.
* **Indices never move.** The game source names tiles by number, and the editor must not change what a number means. So:
  *add* appends (up to 128); *duplicate* appends; *paste onto* a tile overwrites it; *delete* is only offered for the **last**
  tile and is refused while any map of the project still uses it (the message names the map and the number of cells). No
  reorder, no insert. (The blank-tile convention: a new tile set starts with tile 0 blank, ink 0 paper 7 bright 0, "sky".)
* A new tile is blank with the attribute of the tile selected.
* Writes through `host.setAsset('tilesets', name, value)` after each completed user edit (a drag is one edit).

## 5. Map editor (`map-editor.js` over `map-model.js`)

* Canvas of `w x h` cells drawn with the tile set's real bitmaps and attribute colours (palette from `host.palette`), zoom 1x..4x
  of 8 px cells and a fit-to-width option, scrolling for a 128-wide world, grid on / off.
* **Tile palette** beside it (the effective tile set: the map's `tileset` if it names an existing one, else `roles.tileset`, else
  the only tile set). Left click paints the selected tile, right click paints blank. Tools: pencil, line, rectangle (outline /
  filled), flood fill, eyedropper (alt-click or `I`), erase, **select + copy / paste a block**; shift-click constrains a line.
  Undo / redo 200 steps; a drag is one step.
* **Role-aware.** From `host.roles()`: a **world map** shows the 24 x 16 window frame at a camera position set by a slider or by
  dragging the frame (display only, nothing is written), the palette shows tiles 0..31 only, and a ruler marks cell 24 steps; a
  **floor plan** (`VIEW3D`) replaces the palette by codes 0..4 (empty, wall 1..4) drawn as coloured numbered cells and flags an
  empty cell on the outer ring in red; a **cell map** is the default. A map the source does not use shows as a cell map with a
  note.
* **Overlays** (toggles): solid / hazard / pickup flags as tinted outlines; the warning markers (`background-attr-mix`: cells
  whose attribute is the minority are outlined; `map-undefined-tile`: red cross).
* **Size:** width / height fields with the role's limits, "crop or pad at the top-left" (padding is blank); presets "Screen
  32x24", "World 128x16", "Floor plan 32x32". Resizing is one undo step.
* Writes through `host.setAsset('maps', name, value)` in the representation read; a new map is a hex string.

## 6. Sound editor (`sound-editor.js` over `sound-model.js`)

* **Lanes** over the tick timeline (one column per tick, zoom): volume bars, tone (a curve on a log pitch axis, with the note name
  nearest the cursor), noise period, and the mix as two toggles per tick (tone on / noise on). Click and drag paint a lane; a selected
  range takes the operations below; a numeric row editor edits the selected tick (tone, vol, noise, mix).
* Operations (each one undo step): insert / delete ticks, duplicate range, reverse, scale volume, **fade** in / out, **pitch
  sweep** (from-to over the range, linear in tone or in semitones), repeat range n times, set the whole range to a value, plus
  **presets** that fill a new effect (beep, laser, blip, explosion (noise decay), power-up, hurt) which the user edits.
* **Preview**: `renderSfx(asset, {rate})` in `sound-model.js` (pure, returns a `Float32Array`) models the AY: clock 1,764,000 Hz
  (CPU / 2, as TSRun), tone frequency = clock / (16 x period) with a period of 0 taken as 1, noise from the 17-bit LFSR at
  clock / (16 x period) (period 0 as 1), the mixer bits as above, volume by the AY's logarithmic table
  (`[0, .0100, .0145, .0211, .0307, .0455, .0645, .1073, .1266, .2050, .2922, .3728, .4925, .6353, .8056, 1]`), one record per
  1 / 60.1 s. The editor plays it with the Web Audio API (`AudioBuffer`), a Play button and a space-key shortcut, a stop, and a
  waveform thumbnail. A test checks the pure renderer (frequency of a known tone, silence for vol 0, noise is not periodic at the
  tone period, record timing, the `$FF`-byte rule).
* Shows the duration (ticks, seconds), the bytes it takes on the cartridge (`(ticks + 1) x 4`) and "effects in this project: n of 8".
* Refuses a record that `convertSfx` would reject (the field that would make it is clamped, the status says why: tone is limited to 3839 or volume to 14 when the other is in the $FF range). Soft cap 1,800 ticks (30 s, 7.2 KB) on insert / duplicate / repeat; an effect keeps at least one tick. Renderer, as the AY does: tone + noise gates the tone with the noise, neither gives silence (no DC), output is bipolar +-0.5 x volume table.

## 7. Host interface additions (`docs/ARCADE_STUDIO.md` gets the same rows)

| Member | Meaning |
|---|---|
| `roles()` | `scanRoles` of the project's current source (cached per source version), or `null` when the source does not parse. |
| `assetWarnings(kind?, name?)` | `checkAssets(project, roles())` filtered by kind and asset name; a new array each call; synchronous; cheap (tested: all three example projects under 20 ms). |
| `usedBy(kind, name)` | `{assets: [map names drawn with this tile set (kind `tilesets` only; else `[]`)], source: [{file, line, ...}]}`: `assetReferences` plus the maps that use a tile set (`map.tileset`, else the program's `TILESET`). No cell counts: the tile editor counts with `map-model.cellsUsing`. Used by delete and "tile in use". |
| `soundCount()` | Number of sound effects the source declares (`SFX` lines), for the "n of 8" note. |

`studio.js`: `ASSET_EDITORS` gets `tilesets`, `maps`, `sfx` entries (tabs "Tiles", "Maps", "Sounds", containers `tool-tilesets`,
`tool-maps`, `tool-sfx`); `selectAsset` for these kinds switches to the tab as for sprites; the "comes with a later slice" status goes
away. The **problems list** also shows the non-`compilerAlso` asset warnings (`where` = `tiles: name`, `map: name` ...), a click
selects the asset; they count in the editor title's warning count; the size panel is unchanged. `NEW_ASSET.tilesets` becomes a set
with a blank tile 0, `NEW_ASSET.sfx` stays.

## 8. Acceptance (the slice is done when all of these hold)

1. **Pure checks, Node:** every rule of section 3 has positive and negative cases built by hand; `black-bright-mix` and
   `background-attr-mix` on a project made from the shooter's assets with one tile changed; the three example projects give the
   warnings they should and each reported warning is **true** (checked by hand for the first run and the expected list written
   into the test: whatever the examples really trigger is listed, with the reason). `tile0-not-blank` agrees with the compiler's
   warning for the platformer's tile set, both blank and with one pixel set. `scanRoles` on the examples: platformer (world
   `pf_world`), vaults (floor plan `vl_maze`, view attributes), shooter (cell map). `checkAssets` never throws on a fuzz of
   malformed assets (>= 300 random mutations).
2. **Models, Node:** every operation of tile / map / sound models against hand-computed results (flip, rotate, shift, fill,
   rectangle, line (same pixels as `sprite-model.line`), crop / pad, block copy / paste, attribute write into all 8 rows, hex
   representation round trips including blank, tile delete refusal, sound fade / sweep / repeat / reverse); round trip
   `toAsset(fromAsset(x))` equals `x` for every tile set, map and effect of the five example projects (deep equality, `fg` and
   unknown keys kept); the compiler still builds every example from assets written back through the models
   (`compile` byte-identical DCKs).
3. **Editors, headless Chrome on a fake host:** each editor loaded in both themes; drawing with real mouse events; undo / redo;
   the host sees a `setAsset` call with valid data after each edit (`validateAsset` ok); changes made by someone else show up;
   the warnings appear in the editor and disappear when fixed (tile editor: make two background tiles share colours; map editor:
   paint a minority tile; sound editor: mark an unstorable tick); the preview plays (an `AudioContext` stub records one
   `AudioBuffer` of the expected length); delete refusals; the world frame and floor-plan modes on the platformer and Vaults
   maps; screenshots to an out directory.
4. **Studio:** `tests/studio-smoke.mjs` additions: open the platformer project, select a tile set, a map and a sound effect from
   the project panel (the right tab changes), edit one tile through a real click and see the compile's size panel change, see the
   problems list carry the asset warnings of a project made to have them.
5. **Nothing else moved:** `node arcade/tests/run-all.mjs`, `node tests/arcade-project.mjs`, `node tests/studio-smoke.mjs`,
   `node tests/sprite-editor-smoke.mjs`, `node tests/sprite-model.mjs`, `node tests/rom-checks.mjs`, `node tests/browser-smoke.mjs`
   pass as before; `python3 tools/stamp-modules.py --check` (both pages) is current; the examples' compiled bytes are unchanged unless a
   test says why.
6. `docs/HANDOFF.md`, `docs/ARCADE_STUDIO.md` and `docs/ARCADE_ASSETS.md` are updated ("As built" for S2, the `fg` field, the
   map `tileset` field, the sound semantics above); the handoff's next-steps list loses this item.

## 9. Decisions taken here (the owner may reverse any)

1. Tile indices never renumber (section 4): the source names tiles by number.
2. `fg` is an explicit authoring flag, and a solid tile is foreground by flag: that keeps `background-attr-mix` from raising a
   false alarm on every platformer ground tile, and costs the author one checkbox where the rule would be wrong.
3. Sprite art colours stay out of the warnings: the compiler ignores a sprite's ink, paper and bright (the cell's attribute
   colours it), so only tile sets and the `VIEW3D` colours can show the patchwork.
4. Asset warnings never block Run or DCK export (they are warnings).
5. Tone / noise preview uses TSRun's AY clock (1.764 MHz); the real clock is unconfirmed on hardware (`ARCADE_HARDWARE_NOTES.md`),
   an audible detune of 0.5 % at most.
6. **Sound is AY-only; the loudspeaker is not used (owner, 2026-11-10).** The TS2068's own speaker (port `$FE` bit 4, `CBEEP` in Leap V2 BASIC) was considered
   for effects alongside the AY. It has no timer: the CPU toggles the port itself (CBEEP: interrupts off, one cycle = 222 + 52 x pitch T-states), which the 60 Hz game
   ticks cannot spare, and the runtimes have almost no free bytes. The owner left the call to the build: AY only, as V2's own `BEEP` does ("the AY simulates the beep").
   A beep-like sound is an AY tone effect (the sound editor's `beep` and `blip` presets). Revisit only on a measured need, as a new runtime.

