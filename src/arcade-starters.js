/**
 * src/arcade-starters.js — the starters of the Studio's New-project dialog (N1; pure: no DOM, Node can import it).
 *
 *   STARTERS = [{id, title, about, runtime ('v2' | 'v3' | 'v4'), make() -> a NEW project}]
 *
 * Each starter is a small game with a goal, built by code (src/starters/*.js). `make()` returns a fresh project every call.
 */

"use strict";

import { STARTERS_A } from './starters/starters-a.js';
import { STARTERS_B } from './starters/starters-b.js';

// The order of the dialog: the plain starters first, then one per game type (v3 platformer, v4 raycaster, v2 wireframe), fine colour last.
const BY_ID = Object.fromEntries([...STARTERS_A, ...STARTERS_B].map((s) => [s.id, s]));

export const STARTERS = ['blank', 'sprites-tiles', 'scenes-music', 'platformer', 'raycaster', 'wireframe', 'fine-colour'].map((id) => BY_ID[id]);
