/**
 * src/arcade-starters.js — the starters of the Studio's New-project dialog (N1; pure: no DOM, Node can import it).
 *
 *   STARTERS = [{id, title, about, runtime ('v2' | 'v3' | 'v4'), make() -> a NEW project}]
 *
 * Each starter is a small game with a goal, built by code (src/starters/*.js). `make()` returns a fresh project every call.
 */

"use strict";

import { STARTERS_A } from './starters/starters-a.js';

// The order of the dialog: the plain starters first, then one per game type, fine colour last.
const A = Object.fromEntries(STARTERS_A.map((s) => [s.id, s]));

export const STARTERS = [A.blank, A['sprites-tiles'], A['scenes-music'], A['fine-colour']];
