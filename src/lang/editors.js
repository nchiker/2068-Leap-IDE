/**
 * src/lang/editors.js — the editor half of each language profile, by id
 * (src/lang/profiles.js has the other half). Each is an object with:
 *   starter       the text of a first visit's program
 *   lineLimit     the ROM's longest line (the ruler)
 *   extensions    CodeMirror extensions: language mode, highlighting,
 *                 completion, hover help, folding, indent, …
 *   tidy(view), goToDefinition(view, pos?), rename(view, say)   optional
 */

"use strict";

import { basicEditor } from './basic/editor.js';
import { leapcEditor } from './c/editor.js';
import { forthEditor } from './forth/editor.js';
import { arcadeEditor } from './arcade/editor.js';

export const LANGUAGE_EDITORS = {
  basic: basicEditor,
  c: leapcEditor,
  forth: forthEditor,
};

/**
 * Editors only the Leap Arcade Studio uses (see STUDIO_PROFILES in profiles.js). Kept apart from LANGUAGE_EDITORS
 * so that ide.html (`?lang=`, the saved language) can never start in a language its orchestrator does not know.
 * src/editor.js looks a language up in both; the Studio selects it with window.LEAP_EDITOR_LANGUAGE.
 */
export const STUDIO_EDITORS = {
  arcade: arcadeEditor,
};
