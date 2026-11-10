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
