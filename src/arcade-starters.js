/**
 * src/arcade-starters.js — the starters of the Studio's New-project dialog (N1; pure: no DOM, Node can import it).
 *
 *   STARTERS = [{id, title, about, runtime ('v2' | 'v3' | 'v4'), make() -> a NEW project}]
 *
 * Each starter is a small game with a goal, built by code (src/starters/*.js). `make()` returns a fresh project every call.
 */

"use strict";

import { newProject } from './arcade-project.js';

export const STARTERS = [
  { id: 'blank', title: 'Blank', about: 'A ball you steer with the joystick: the smallest game.', runtime: 'v2', make: () => newProject('Blank') },
];
