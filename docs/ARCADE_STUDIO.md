# Leap Arcade Studio: how it fits the existing IDE (2026-11-09)

From a read-only survey of the IDE code (line references are to the code as of 2026-11-09; check before relying).
**Decision: `studio.html` + `studio.js` is a new shell. It reuses the IDE's modules, not `ide.js`.**

## Why not extend `ide.js`
`ide.js` has about 60 unguarded `getElementById` calls and assumes one text string everywhere: `getSource`/`setSource`,
`lint`/`startRun`/`buildCartridge(text)`, auto-save of `{name, text, savedText}`, share links as one compressed
text, the dirty mark (a text comparison), the debugger's line map (single file). A project with assets and several
source files breaks each of these. A new orchestrator costs less than bending them.

## Reuse unchanged
| Module | Use in the Studio |
|---|---|
| `src/emulator.js` `createEmulator({profile, canvas, focusEl, onState})` | the TS2068 panel; run a DCK with `testCartridge(dck, symbols)` |
| `src/pc-keyboard.js` | keys into the running game |
| `src/debugger.js` | the Z80 debugger (needs `#debugger-mount`; builds its own skeleton). Arcade adapter = registers, memory, Z80 breakpoints, source map |
| `src/help.js`, `src/files.js` (pure helpers), `src/lang/profiles.js` / `editors.js` registries, themes (`ide.css` variables) | as is |
| `src/tools/*` pattern (`create*Tool(container)` returning `{render}`) | the model for sprite, tile, map and sound editors (DOM built with `createElement`, persistence in `localStorage` with validated data, insertion through the editor) |

## Needs a small change in shared code
* `src/editor.js` mounts `#editor-mount` at import and sets `window.leapEditor`; it calls `window.leapIDE?.lintSource`.
  The Studio provides the same element id and `window.leapIDE.lintSource`; later refactor to `createEditor(mountEl)` so
  the Studio can host more than one editor (one per source file).
* `src/emulator.js`: **Run for a cartridge-only language.** `run(job)` waits for a Leap key wait and calls
  `driver.inject`; a DCK never takes that path, and `run()` during a cartridge test returns to the ROM
  (`leaveCartridge`). The Studio's Run is `testCartridge(dck)`; add a `restartCartridge()` and let the arcade profile
  skip `driver`. The stock ROM pair has no entry in any `knownRoms` table (no `keyWait` etc.), so the arcade profile
  needs a small `knownRoms` entry for the stock pair (addresses from the ROM) or the emulator needs to allow a
  cartridge-only profile that is not refused.
* `tools/stamp-modules.py` handles only `ide.html` and the entries `src/editor.js`, `ide.js`; extend it to a list of
  (html, entries) pairs, and make `tools/pre-commit` re-add `studio.html`.
* `src/lang/profiles.js`: an `arcade` entry (`ownsTape` returns false; `extensions` `.arc`); `editors.js` must list it
  or `?lang=` is refused. Profile fields not needed may be stubbed (`NO_DEBUG` adapter pattern from the C profile).

## New in the Studio
* **Project store:** the `.leapgame` document (see `docs/ARCADE_ASSETS.md`), auto-saved under its own key, shared by
  link only when small (files.js share encoding has no size check today; add one).
* **Panels:** project tree, code editor(s), emulator, debugger, and tabbed asset editors (sprite, tileset, map,
  sound), plus the size and frame-budget reports. Layout is the Studio's own (wider, more tabs).
* **Build service:** `src/lang/arcade/` with the pure compiler/linker (Node-importable, no DOM), like the other
  profiles' `profile.js`, so `tests/rom-checks.mjs` can drive it.
* **Tests:** a new `tests/arcade-checks.mjs` section file in the style of `rom-checks.mjs` sections (skips cleanly
  when the runtime build is absent); a Studio block in `tests/browser-smoke.mjs` (no skip pattern there today).

## Risks for the project model
Single-text assumptions (above), the editor singleton and its undo reset on `setSource(..., {fresh})`, UDG/Draw storage
keys that are global rather than per project, and examples that assume one file. All are avoided by not using
`ide.js` for the Studio; the shared modules above do not depend on them.

## As built: slice S1a, the shell (2026-11-09)
What exists, and where it differs from the plan above.

**Run it:** `python3 -m http.server 8080` in the repo root, open http://localhost:8080/studio.html (ide.html is unchanged).
The compiler loads the runtime from `arcade/dist/v2/` (committed; `node arcade/tools/build-runtime-v2.mjs` then
`node arcade/tools/publish-runtime.mjs` refreshes it; `--check` reports a stale copy). Examples come from
`arcade/dist/examples/` (`.leapgame` projects made from `arcade/examples/*.arc` + `*.assets.json` by the same script).

| Part | File |
|---|---|
| Shell | `studio.html` (layout, import map stamped by `tools/stamp-modules.py`), `studio.css` (additions to `ide.css`), `studio.js` (orchestrator) |
| Project document | `src/arcade-project.js` (pure): `.leapgame` format 1, validate / migrate, new-project template, asset and file operations (what the host calls), multi-file source build with a line map, auto-save (`leap-studio.project`) |
| Language profile | `src/lang/arcade/profile.js` (pure: help, symbols, `attach()` loads the runtime and gives `compileProject(project)`), `src/lang/arcade/arcade-scan.js` (pure: names defined, block structure, key hints), `src/lang/arcade/editor.js` (CodeMirror half) |
| Emulator | `src/emulator.js`: `cartridgeOnly` profiles and `runCartridge(dck)` (below) |
| Tests | `tests/studio-smoke.mjs` (headless Chrome, helpers in `tests/browser-lib.mjs`), `tests/arcade-project.mjs` (Node) |

**Cartridge-only profile (the emulator change).** `profile.cartridgeOnly = true` makes `src/emulator.js` treat the profile's
`romFiles` (here the stock `ts2068-0/1.rom`) as its ROMs without a `knownRoms` lookup (a stand-in ROM entry with no key
wait), never single-step the frame looking for a key wait, and go to state `ready` instead of `booting` after Stop /
Reset. `runCartridge(dck)` ejects a running cartridge and calls `testCartridge`, so Run restarts the game from a cold
reset; Stop (`stop()`) leaves the cartridge (the stock ROM's start screen shows). `emu.joystick` is exposed; the Studio
maps the arrow keys and Space (while the screen has focus) to joystick 1 (bits up 0, down 1, left 2, right 3, fire 7,
active low), in addition to `pc-keyboard.js`, so `KEYDOWN("Q")` and `STICK(1)` both work. Every existing code path is
unchanged (the new branches test `profile.cartridgeOnly` or a null `kbdKeyHit`).

**Registration (deviation from the plan).** `arcade` is *not* in `PROFILES` / `LANGUAGE_EDITORS`: ide.html's selector,
Open-by-extension, share links and `?lang=` would otherwise offer a language `ide.js` cannot run. It is in
`STUDIO_PROFILES` (`src/lang/profiles.js`) and `STUDIO_EDITORS` (`src/lang/editors.js`). `src/editor.js` looks a language up in
both and starts in the one named by `window.LEAP_EDITOR_LANGUAGE` (set by studio.html before the module loads); ide.html
sets nothing and behaves as before.

**Project and build.** One CodeMirror editor shows one file at a time (the other files wait in the project object;
switching a file gives the editor a fresh undo history, a known limit until the editor is refactored to
`createEditor(mountEl)`). The compiler gets the files joined in a fixed order: `main.arc`, then the others A to Z
(case-insensitive), each ended by a newline; `buildSource()`'s `lineMap` turns a compiler line back into
`{file, line}`. Diagnostics: 400 ms after the last change (project or asset) the Studio compiles all files with all
assets (about 30 ms for the shooter), shows errors and warnings in the status bar, in the problems list under the
editor and as editor marks (this file's only); clicking the status text or a problem opens the file at the error. Run
= the same compile, then `runCartridge(res.dck)`; an error stops Run and jumps to the first error. ⬇ DCK saves the
compiled cartridge. The size panel (right, under the display) shows the last good build: bytes used of the game's 16,384
(code, sprite data, text, tiles, map, sound, tables, variables), sprites and instances, runtime version, compile time.

**Right-hand tabs.** Display (TS2068, zoom, Reset, size panel) | Symbols (`src/tools/symbols.js`, scenes, procedures,
functions, assets, variables) | Sprites (the S1b editor; loaded with `import()` the first time the tab opens, a note if
`src/tools/sprite-editor.js` is absent). Tile, map and sound editors will add tabs the same way (`ASSET_EDITORS` in
studio.js). Picking a tile set, map or sound effect in the project panel only selects it for now.

**Auto-save / unsaved mark.** The project is saved to `localStorage['leap-studio.project']` 400 ms after each change
(and on unload); `leap-studio.saved` holds a hash of the project as last downloaded / opened, so the `•` mark survives a
reload. Theme (`leap-ide.theme`) is shared with the IDE; zoom is `leap-studio.zoom`, tab `leap-studio.tab`.

**Not in S1a:** the debugger panel (the breakpoint gutter is hidden), share links, `.tap`, scene display overrides
(`scenes` is kept in the document but has no UI), per-file undo history, music.

**Window handles for tests:** `window.leapStudio` (`project`, `lastCompile`, `ticks()` = `V_TICKS`, `makeHost(id)`,
`openProject`, `runProject`, ...) and `window.leapIDE.lintSource` (what `src/editor.js`'s linter calls).

## Asset editor host interface (contract for S1a and S1b, fixed 2026-11-09)

The Studio shell (`studio.js`, S1a) owns the project; asset editors (`src/tools/sprite-editor.js` in S1b, later tile, map
and sound editors) are plug-ins that edit assets through a **host** object. An editor never touches `localStorage`, the
code editor or the emulator, and never mutates the project object directly.

```js
// src/tools/sprite-editor.js
export function createSpriteEditor(container, host) -> { refresh(), select(name), destroy() }
```
* `container`: an empty `HTMLElement` the editor fills (DOM built with `createElement`/`textContent`, no `innerHTML` from
  user data). It may be hidden (`display:none`, zero size) when created and shown later; the Studio calls `refresh()`
  each time the tab becomes visible, so size-dependent layout belongs in `refresh()`. Style with the `ide.css`
  variables only (`--bg`, `--bg-panel`, `--bg-surface`, `--bg-hover`, `--fg`, `--fg-muted`, `--border`, `--border-hi`, `--amber-fg`, `--red-fg`, `--ok-fg`, `--font-ui`, `--font-code`, as the other `src/tools/*` do); both themes must work. Put the
  editor's own CSS in a `<style>` it adds once, with every selector prefixed (`.sprited-`), not in `studio.css`.
* Return value: `refresh()` re-reads everything from the host and redraws; `select(name)` shows that asset (no-op if it
  does not exist); `destroy()` removes listeners. The Studio calls only these three, and tolerates a missing one.

### `host` (all synchronous; `kind` is one of `'sprites' | 'tilesets' | 'maps' | 'sfx' | 'music'`)
| Member | Meaning |
|---|---|
| `getProject()` | The live project object (`.leapgame` document, format 1, `docs/ARCADE_ASSETS.md`). **Read-only**: do not mutate; use the calls below. Treat it as replaced on every `'project'` change (re-read it, do not cache sub-objects across events). |
| `listAssets(kind)` | Asset names of that kind, sorted, as a new array. |
| `getAsset(kind, name)` | A **deep copy** of the asset value (the editor may mutate it freely), or `null` if absent. |
| `setAsset(kind, name, value)` | Create or replace the asset (the value is deep-copied in). Returns `{ok: true}` or `{ok: false, error: 'message'}` (bad kind, bad name, value failing `validateAsset`). Name rule: letters, digits, `_`, 1-31 chars, starting with a letter (what the source's `SPRITE x = "name"` string may hold). Fires `onProjectChange` (`type: 'asset'`), schedules auto-save and a diagnostics recompile. Call it after each user edit that should count (cheap; the Studio debounces). |
| `deleteAsset(kind, name)` | Remove it; returns boolean. Fires the change event. |
| `renameAsset(kind, oldName, newName)` | Returns `{ok}` / `{ok:false,error}` (clash, bad name). The Studio does **not** rewrite source text that refers to the old name; it warns in the status bar when a `SPRITE ... = "old"` remains. |
| `onProjectChange(fn)` | `fn(ev)` after any change to the project, whoever made it (the editor itself, another editor, the code editor, New/Open, an example). Returns an unsubscribe function. `ev` = `{type, kind?, name?, source}`: `type` is `'asset'` (one asset created/changed/deleted/renamed; `kind`, `name` set, `oldName` for a rename), `'source'` (a code file changed; ignore) or `'project'` (the whole project was replaced: re-read everything). `source` is the `host.id` of the editor whose `setAsset`/`deleteAsset`/`renameAsset` caused it, or `'studio'`; compare it with your own `host.id` to skip echoes of your own writes. (Each editor gets its own host object, so `id` identifies the caller.) |
| `id` | A unique string for this editor instance (the Studio assigns it, e.g. `'sprite-editor'`). |
| `onSelectAsset(fn)` | `fn({kind, name})` when the user picks an asset of **any** kind in the Studio's project panel (or the code editor asks for it). An editor shows it if `kind` is its own. Returns unsubscribe. |
| `selectAsset(kind, name)` | Ask the Studio to select that asset: highlights it in the project panel, switches the right-hand tab to the editor of that kind, and fires `onSelectAsset`. |
| `getUsage()` | The last compile's `usage` object (`{sprites, ...}` as `compile()` returns it) or `null`. |
| `status(text)` | Show a short message in the Studio's status bar. |
| `roles()` | (S2) `scanRoles` of the project's current source: `{tileset, maps, world, floorplans, view}` or `null`. |
| `assetWarnings(kind?, name?)` | (S2) The asset checks (`src/lang/arcade/arcade-assetcheck.js`, contract `ARCADE_STUDIO_S2_CONTRACT.md` section 3) for the live project, filtered; a new array of `{id, severity, kind, asset, tile?, cells?, message, compilerAlso}`. |
| `usedBy(kind, name)` | (S2) `{assets: [maps drawn with this tile set], source: [{file, line}]}`. |
| `soundCount()` | (S2) How many `SFX` lines the source declares (the game takes at most 8). |
| `songCount()` | (M4) How many `MUSIC` lines the source declares (the game takes at most 8). |
| `palette` | `[{name, rgb}]` of the 8 TS2068 colours x 2 brightness (index = `ink + 8 * bright`), the same RGB the emulator shows, for swatches. |

### Asset values
As `docs/ARCADE_ASSETS.md` and `arcade-assets.js` define them. Sprite: `{w, h, frames: [{rows: [{bits, mask, ink?, paper?, bright?}]}], hot?, phases?}`
(`bits`/`mask` hex strings, `ceil(w/8)` bytes per row). The compiler reads `w`, `h`, `frames[].rows[].bits/mask`, `phases`;
`ink`, `paper`, `bright` (and `hot`) are authoring data it ignores today. `validateAsset(kind, value)` in `src/arcade-project.js`
(pure, Node-importable) is the single validator; an editor may import it for early feedback.

### Events the Studio fires on its side
Every successful `setAsset`/`deleteAsset`/`renameAsset` triggers: dirty mark, auto-save (400 ms debounce), a diagnostics
compile (the size panel updates), and `onProjectChange` for all subscribers, including the caller (use `ev.source` to skip your own).
The Studio never calls `setAsset` on its own except for New/Open/Examples (those send `type: 'project'`).

## As built: slice S2, tile, map and sound editors and asset warnings (2026-11-10)

Contract and decisions: [`ARCADE_STUDIO_S2_CONTRACT.md`](ARCADE_STUDIO_S2_CONTRACT.md). Right-hand tabs are now Display | Symbols | Sprites | Tiles | Maps | Sounds
(`ASSET_EDITORS` in `studio.js`; picking an asset in the project panel opens its tab). Each editor is a pure model plus a UI module with a headless-Chrome smoke test on a fake host:

| Part | Files | Tests |
|---|---|---|
| Checks | `src/lang/arcade/arcade-assetcheck.js` (`checkAssets`, helpers), `scanRoles` in `arcade-scan.js` | `tests/arcade-assetcheck.mjs` (125) |
| Tiles | `src/tools/tile-model.js`, `tile-editor.js` | `tests/tile-model.mjs` (135), `tile-editor-smoke.mjs` (73) |
| Maps | `src/tools/map-model.js`, `map-editor.js` | `tests/map-model.mjs` (138), `map-editor-smoke.mjs` (78) |
| Sound | `src/tools/sound-model.js` (includes the AY renderer), `sound-editor.js` | `tests/sound-model.mjs` (121), `sound-editor-smoke.mjs` (112) |
| Studio | host members `roles`, `assetWarnings`, `usedBy`, `soundCount` (table above); asset warnings in the problems list (click selects the asset; rules marked `compilerAlso` stay out because the compile reports them) | block in `tests/studio-smoke.mjs` |

Where the build differs from the contract text, the contract has been corrected (mix values 6 / 4 / 5 / 7; `usedBy` shape; undo depth: `createHistory(x, 201)`).
Choices made while building: `validateAsset` allows 1,800 ticks (was 1,000) and `'tilesets'` still 256 (the tile model is stricter: 128); in a map the source does not use
(or with no source roles) the editor shows a cell map with relaxed limits (1..128 x 1..32); the erase tool paints tile 0 in a world map, code 0 in a floor plan, blank in a cell map;
`background-attr-mix` belongs to the **map** (its `asset` is the map name; the tile editor also lists the ones of maps drawn with its set); `floorplan-shape` is always an error;
two ids beyond the contract: `map-shape` and `asset-malformed`; the tone axis of the sound editor covers tone 16..4095.

**What the checks found in our own examples** (and what was done): Breakout, Blockfall and Vaults mixed plain and BRIGHT black in their tile sets (fixed the way the shooter was in
`45bf27f`: one black everywhere; Breakout's green brick is now dim, Blockfall's L piece is bright and its game-over dimmed block is blue dither, Vaults' brass bezel is bright; the
batch baselines and the `blockfall-v0` fixture were regenerated, sizes unchanged). **Left as they are, reported by the checker:** Leap Runner's world uses 5 background colour
attributes (clouds / hills / water differ in paper and ink, so the hero changes colour over them) and Vaults' panel map 4 (HUD tiles); these are art trade-offs for the owner (mark
the tiles "sprites never pass over" or unify the colours).

## As built: language batch 4, scenes (2026-11-10)

Contract: [`ARCADE_LANGUAGE_BATCH4.md`](ARCADE_LANGUAGE_BATCH4.md) sections 10 and 11. `compile(text, {..., scenes: project.scenes})` returns `out.scenes` (from `src/lang/arcade/arcade-display.js`
`sceneDisplayPlan`: per scene `auto` setup and `reason`, `override`, `setting`, `built: 'buffers'`, `notes`) and turns the notes into warnings on the scene's line. **Project document:** `scenes` is
`{name: {display?: 'auto' | 'buffers' | 'fine' | 'hires'}}`; `validateProject` drops a non-object entry (warning) and a non-string `display`; `setSceneDisplay(project, name, value)` (`auto` removes the key).
**Studio:** a Scenes group in the project panel (hidden for a one-scene game) with one row per scene of the last good compile: a start marker, the plan text (`auto: two buffers, because sprites move`) and a select
Auto / Two buffers / 8x1 colour / Hi-res text, the last two disabled ("not built yet") unless the loaded project carries them; a change goes through the same changed -> autosave -> recompile path as the asset editors.
The size panel has a `Scenes` row. The Symbols tab's Scenes group reads `name (start) -> a, b` from `scanArcade`'s new `enters`. **Only the two-buffer setup exists in the runtimes**, so today the override can only pin
`buffers`; the field, the validation and the UI are in place for the runtimes that will add the others. Tests: `tests/arcade-display.mjs` (73), `tests/arcade-project.mjs`, a block in `tests/studio-smoke.mjs`.

## As built: banking (B4, 2026-11-10)

The banked cartridge map (`docs/ARCADE_BANKING_CONTRACT.md` sections 5 and 8) in the Studio:

* **Size panel, two budgets.** The existing bar is now `Mapped N / 16,384 bytes (p %), F free` (from `usage.mapped`; an older result falls back to `usage.gameArea`, then to `total + free`). A second bar, `Banked N / 16,384 bytes`
  (`usage.banked`, class `bank-fill`, a `--blue-fg` bar that turns amber and red like the first), sits under it and is hidden when the game has no map assets, nothing is banked and `usage.banked` is absent. Under it is one row per banked asset,
  `banked: map sky (770 bytes, set to Banked)` (`kind name (bytes, why)`; why is `auto`, `set to Banked` for an override or `forced` for the test option), or `nothing banked: the game fits in its mapped 16 KB`. The names are the declared `MAP` names (the compiler's), not asset names.
  The status bar reads `8479 of 16384 bytes + 770 banked · 54 ms` while something is banked. Both budgets show the last good build, as before.
* **Bank select: in the map editor's toolbar**, after Tile set (`[data-role=bank-select]`, Auto / Mapped / Banked). It is an edit like any other (one `setAsset`, one undo step, auto-save, recompile). `bank` travels in the map model's `extra` keys, so
  `fromAsset` / `toAsset` already kept it; Auto deletes the key. A stored value that is not one of the three shows as `x (not valid)`.
* **Validation** (`validateProject`): `bank` of `mapped` or `banked` is kept; `auto` is stored as no key; anything else is dropped with a warning (`assets.maps.room.bank must be "auto", "mapped" or "banked" ...`). (The compiler's own warning for a bad value
  therefore reaches the Studio only through a project that bypasses validation.) `setAsset` does not look at `bank` (it keeps whatever the editor writes).
* **Problems list:** the compiler's new errors and warnings (`the game does not fit: mapped part ...`, `banked assets need ...`, `map 'x' is set to mapped ...`) are ordinary diagnostics and appear with no Studio change.
* **Fixed on the way:** `ensureEditor` could run twice before an editor module had loaded (two quick selections), putting two editors in one tab; it now keeps the pending load.
* Tests: a `B4` block in `tests/studio-smoke.mjs` (the Shooter's `sky` map set to Banked: banked list, both budgets, status bar, a DCK saved, Auto / Mapped round trip, auto-save, a bad value in an opened file, the old-usage fallback), `tests/arcade-project.mjs`
  (bank validation), `tests/map-editor-smoke.mjs` (the select and its undo), `tests/map-model.mjs` (`bank` kept in `extra`).

## As built: music editor (M4, 2026-11-12)

Contract: [`ARCADE_MUSIC_CONTRACT.md`](ARCADE_MUSIC_CONTRACT.md) sections 3 (the asset) and 7 (the Studio). Songs (`assets.music.<name>` = `{patterns, order, loop}`) are edited in
the **sound editor**, as the owner decided: no separate tracker, no text note format.

| Part | Files | Tests |
|---|---|---|
| Model | `src/tools/music-model.js` (pure, Node-importable): `fromSong` / `toSong`, `newSong`, pattern list (`addPattern`, `duplicatePattern`, `deletePattern`, `movePattern`, `labelPattern`), order list (`orderAppend`, `orderInsert`, `orderRemove`, `orderMove`, `orderSet`, `setLoop`), note entry (`INSTRUMENTS`, `noteRecords`, `enterNote`, `enterRest`), `songInfo`, `validateSong`, `songTimeline`, `renderSong`, `createHistory` | `tests/music-model.mjs` (106) |
| Editor | `src/tools/sound-editor.js` (song mode) | `tests/sound-editor-smoke.mjs` (169 in all; the song block is 31 of them) |
| Project | `validateAsset('music', ...)` and `MUSIC_LIMITS` in `src/arcade-project.js`; `assetReferences` knows `MUSIC` | `tests/arcade-project.mjs` |
| Checks | `music-unstorable`, `music-shape`, `music-unused-pattern` in `src/lang/arcade/arcade-assetcheck.js` | `tests/arcade-assetcheck.mjs`, `tests/music-model.mjs` |
| Studio | a **Songs** group in the project panel (its `+` makes `newSong()`), `ASSET_EDITORS.music = {tab: 'sfx', shared: 'sfx'}`, host `songCount()` | a block in `tests/studio-smoke.mjs` |

**The editor.** Buttons **Effects | Songs** at the left of the editor's top bar switch between the project's `sfx` and `music` assets (the asset last shown in each mode comes back).
In song mode the pattern shown is edited exactly as an effect is: the same lanes, tracks A / B / C, painting, the row editor, every range operation; the pattern is
`song.patterns[i]` in sound-model's editing form, so no operation needed a song version. Above the lanes, the **song panel**:
* **Patterns**: one chip per pattern (`2 intro` when it has a label; dashed when the order list never plays it); Add (a silent pattern as long as the one shown, after it),
  Duplicate (the copy goes right after), Delete (its order entries go; refused for the last pattern), ◀ ▶ (move it in the list), Label. Adding, duplicating, moving and
  deleting renumber the order list, so the song plays the same music (tested on 400 random operations).
* **Order**: one chip per entry (↻ marks the loop; clicking one selects it and shows its pattern); Append / Insert (the pattern shown), Set (the selected entry plays the
  pattern shown), ◀ ▶, Remove (refused for the last entry); the **loop** select (`none (stop)` or a position). The loop stays on the entry it marks when entries are
  inserted, removed or moved; when its own entry is removed it goes to the entry after it (the last, if none).
* A line with the song's size on the cartridge (`convertMusic(...).bytes`, with refused fields clamped as the effect size is, so a size always shows), its length per pass and
  the loop's length in seconds.

**Note entry** (a row under the row editor; effects have it too): note, octave, length in refreshes, instrument, an optional peak volume and the tick to start at; Enter
writes `noteRecords` into the selected track from that tick (overwriting, padding a short track with silent records, extending the pattern), Rest writes silence. The
tick follows the cursor and moves to the end of each note entered, so notes typed one after another make a melody. (The instrument envelopes and the default song were approved by the owner on 2026-11-12.) Instruments (volume envelopes; `toneOfNote` for the
tone): **pluck** (from the peak, falling by a fifth every refresh), **organ** (held; the last refresh at half, so repeated notes are heard apart), **bass** (two refreshes at
the peak, falling to 60 %, the last refresh silent from 4 refreshes on), **drum** (noise only, falling by 30 %, the note picks the noise period). A record that would be
unstorable (tone 3840+ at volume 15: the lowest notes of octave 0) gets volume 14.

**Preview.** ▶ Pattern plays the pattern shown, ▶ Song the whole song: the order list, then (with a loop) from the loop to the end once more, through `renderSfx` over
`songTimeline` (each channel padded to its pattern's length with the compiler's silent record; a channel no pattern uses is left out, so a channel-A song mixes as a
one-channel effect); the order entry playing is marked. The preview stops at 5 minutes (`MAX_PREVIEW_TICKS`).

**Undo / redo, saving.** One history per asset: in song mode it holds the whole song, so a pattern edit, an order change and a loop change are each one step, and every
edit is one `setAsset('music', name, song)`. A refused write rolls back as for effects.

**Validation.** `validateAsset('music')` (what `setAsset` and opening a project enforce): 1..32 patterns, each a pattern with the effect's shape checks and at least one tick
(at most 1,800 per channel), a non-empty order list of at most 64 pattern indices that exist, `loop` null / absent or an order position. As for effects, an unstorable record
passes it and is reported by the checks: `music-unstorable` (per pattern and channel, `compilerAlso`), `music-shape` (the structure, for a project that bypassed validation),
`music-unused-pattern` (a warning the compiler does not give, shown in the problems list). The editor's own list comes from `validateSong`, whose `ok` is exactly "convertMusic
accepts it" (1,500 random songs); clicking an unstorable entry goes to its pattern, channel and tick.

**Studio wiring.** Songs open in the Sounds tab: `selectAsset('music', name)` shows the tab and calls the sound editor's `select(name, 'music')` (a second argument; `select(name)`
alone keeps the editor's mode); `onSelectAsset` events of kind `music` do the same. **Fixed on the way:** `tools/stamp-modules.py` now fingerprints the tile, map and sound
editors (loaded with `import(variable)`, so they and their models had no stamp and could be served stale after an update).

**Not done here** (other slices): the Symbols tab listing songs (needs `scanArcade` to know `MUSIC`, the language slice M3); the size panel's music row (the compiler's
`usage`, M3); songs for the sample games (M5).
