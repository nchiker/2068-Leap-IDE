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
