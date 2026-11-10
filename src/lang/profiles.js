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
 *     canInject(m, rom)                    optional: may a run start at this key wait (else BREAK first)
 *     inject(m, rom, job)                  write RAM and jump; job comes from startRun()
 *     stopWaiting(m, rom)                  end a wait directly (true), or false to press BREAK
 *     breakHold                            optional: frames to hold BREAK (else until the key wait)
 *     next(m, rom, job)                    optional: at the end of a part, start the next (true)
 *     result(m, rom, job)                  the ended run's result, for describeResult()
 *   createDebugAdapter(rom)              the debugger's view of a run (src/debugger.js)
 *   symbolGroups(text), symbolsEmpty     the Symbols tab
 *   help                                 the Help overlay (src/help.js)
 *   examples                             the Examples menu
 *   tools {udg, draw}                    which code-generating tools apply
 *   waitingText                          status while the program waits for keys
 *   tapeToText(bytes), ownsTape(bytes)   Open of a .tap
 *   hasTape, hasCartridge, hasSession    which buttons apply (⬇ TAP; ⬇ DCK / ▶ Test DCK; Import)
 *   attach({rom, romImages, fetchAsset}) the per-ROM half: lint(), startRun(), describeResult(),
 *                                        progInfo(), exportTape(), buildCartridge() (optional);
 *                                        for a live session (Forth) also keyWait(m) (called by
 *                                        the emulator at every key wait), sessionStamp() (changes
 *                                        when the session does: the editor is checked again) and
 *                                        importSession(m) (the session's typed lines as text)
 */

"use strict";

import { basicProfile } from './basic/profile.js';
import { leapcProfile } from './c/profile.js';
import { forthProfile } from './forth/profile.js';
import { arcadeProfile } from './arcade/profile.js';

/** Every language, in the selector's order. The first is the default. */
export const PROFILES = [basicProfile, leapcProfile, forthProfile];

/**
 * Profiles only the Leap Arcade Studio (studio.html) uses. Leap Arcade is deliberately NOT in PROFILES: it has no
 * ROM pair or key wait (it runs a compiled cartridge on the stock ROMs, `cartridgeOnly`) and works on a project, so
 * ide.html's selector, Open-by-extension and share links stay as they are. See docs/ARCADE_STUDIO.md.
 */
export const STUDIO_PROFILES = [arcadeProfile];

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
