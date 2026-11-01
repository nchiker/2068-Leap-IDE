/**
 * src/lang/profiles.js — the languages the Leap IDE knows, as profiles.
 *
 * The IDE core (ide.js, src/emulator.js, src/debugger.js, src/editor.js) asks
 * the active profile for everything language-specific. Each language lives in
 * src/lang/<id>/: profile.js (no DOM or CodeMirror: Node can import it) and
 * editor.js (the CodeMirror half, registered in src/lang/editors.js).
 *
 * A profile has (see src/lang/basic/profile.js for a complete one):
 *   id, name, extensions[], untitled      'basic', 'Leap V2 BASIC', ['.leap', '.bas'], 'untitled.leap'
 *   romFiles {home, exrom}               paths under tsrun/
 *   knownRoms, romHint, romLabel(rom)    SHA-256 (HOME + EXROM) -> ROM entry; refusal hint; caption
 *   lineLimit                            longest line the ROM stores
 *   keyboard {symbols, always}           SYMBOL SHIFT table for src/pc-keyboard.js; keys pass
 *                                        all the time (true) or only while a program runs
 *   driver                               the emulator's half of Run / Stop:
 *     safe(m)                              at the key wait, is this a safe point (paging)?
 *     runState(m, rom)                     'ended' | 'waiting' while a run is active
 *     inject(m, rom, job)                  write RAM and jump; job comes from startRun()
 *     stopWaiting(m, rom)                  end a wait directly (true), or false to press BREAK
 *     result(m, rom)                       the ended run's result, for describeResult()
 *   createDebugAdapter(rom)              the debugger's view of a run (src/debugger.js)
 *   symbolGroups(text), symbolsEmpty     the Symbols tab
 *   help                                 the Help overlay (src/help.js)
 *   examples                             the Examples menu
 *   tools {udg, draw}                    which code-generating tools apply
 *   waitingText                          status while the program waits for keys
 *   tapeToText(bytes), ownsTape(bytes)   Open of a .tap
 *   attach({rom, romImages, fetchAsset}) the per-ROM half: lint(), startRun(), describeResult(),
 *                                        progInfo(), exportTape(), buildCartridge() (optional)
 */

"use strict";

import { basicProfile } from './basic/profile.js';

/** Every language, in the selector's order. The first is the default. */
export const PROFILES = [basicProfile];

/** The profile with this id, or the default. */
export function profileById(id) {
  return PROFILES.find(p => p.id === id) ?? PROFILES[0];
}

/** The profile a file of this name belongs to, or null (any language may open it). */
export function profileForFile(name) {
  const ext = (/\.[^.]+$/.exec(name)?.[0] ?? '').toLowerCase();
  return PROFILES.find(p => p.extensions.includes(ext)) ?? null;
}

/** The profile whose tape this is, or null. */
export function profileForTape(bytes) {
  return PROFILES.find(p => p.ownsTape(bytes)) ?? null;
}
