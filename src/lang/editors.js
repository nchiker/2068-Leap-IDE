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
import { forthEditor } from './forth/editor.js';

export const LANGUAGE_EDITORS = {
  basic: basicEditor,
  forth: forthEditor,
};
