"use strict";
// arcade-m11-common.mjs -- shared by tests/arcade-m11-compiler.mjs and tests/arcade-m11-differential.mjs (the banked cartridge map, docs/ARCADE_BANKING_CONTRACT.md).
//   ASSETS11                     the assets of tests/arcade-m9-common.mjs plus worlds (w24 w30 w60 w128), floor plans (p4 p8 p20 p32), screen maps (big0, small, s0..s69 of 32 x 24, t0..t29 of 10 x 10)
//   withBank(assets, map, bank)  the assets with `bank` set on one map asset (the project document's assets.maps.<name>.bank)
//   HEAD, scene, win3, view4, plain2, mapDecls   source builders (a one-scene game; a WINDOW game over the world "lv"; a VIEW3D game over the maze; a game with screen maps)

import { ASSETS } from './arcade-m9-common.mjs';
export { ASSETS };

// ── assets ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const mkMap = (w, h, f) => ({ w, h, cells: Array.from({ length: w * h }, (_, i) => f(i % w, (i / w) | 0, i)) });
/** a screen map of w x h cells whose contents depend on `seed` (so that two maps are never equal) */
export const screenMap = (w, h, seed) => mkMap(w, h, (c, r, i) => ((i + seed) % 7 === 0 ? -1 : (i * 3 + seed) % 6));
export const world = (w, h, seed) => mkMap(w, h, (c, r) => (r >= h - 2 ? 1 : (c + seed) % 9 === 0 && r === h - 4 ? 4 : 0));
export const plan = (w, h, seed) => mkMap(w, h, (c, r) => (c === 0 || r === 0 || c === w - 1 || r === h - 1 ? 1 + (seed % 4) : ((c * 7 + r * 5 + seed) % 11 === 0 ? 1 + ((c + r) % 4) : 0)));
export const ASSETS11 = {
  ...ASSETS,
  maps: {
    ...ASSETS.maps,
    w60: world(60, 16, 1), w128: world(128, 10, 2), w24: world(24, 16, 3), w30: world(30, 5, 4),
    p8: plan(8, 6, 1), p20: plan(20, 14, 2), p32: plan(32, 32, 3), p4: plan(4, 4, 4),
    big0: screenMap(32, 24, 0), small: screenMap(5, 4, 9),
  },
};
for (let i = 0; i < 70; i++) ASSETS11.maps[`s${i}`] = screenMap(32, 24, i + 11);        // 770 bytes each as a record
for (let i = 0; i < 30; i++) ASSETS11.maps[`t${i}`] = screenMap(10, 10, i + 3);         // 102 bytes each
export const withBank = (assets, name, bank) => ({ ...assets, maps: { ...assets.maps, [name]: { ...assets.maps[name], bank } } });

// ── sources ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
export const HEAD = 'GAME "t"\nFRAMERATE 30\nTILESET ts = "ts"\n';
export const scene = (init, frame, decl = '') => `SCENE s\n  DIM v${decl ? '\n  ' + decl : ''}\n  PROC INIT()\n${init}  ENDP\n  PROC FRAME()\n${frame}  ENDP\nENDSCENE\n`;
/** a v3 game: WINDOW over `level` (lv, 48 x 16) and the maps in `maps` (declared MAP name = "asset") */
export const win3 = (frame, maps = '', init = '', top = '') => `${HEAD}SPRITE ship = "orb"\nMAP level = "lv"\n${maps}${top}WINDOW level\n${scene(init, frame)}`;
export const view4 = (frame, maps = '', init = '', top = '') => `${HEAD}SPRITE ship = "orb"\nMAP level = "maze"\n${maps}${top}VIEW3D level\n${scene(init, frame)}`;
export const plain2 = (maps, frame = '', init = '') => `${HEAD}${maps}${scene(init, frame)}`;
export const mapDecls = (names, prefix = 'm', asset = (i) => `s${i}`) => names.map((n, i) => `MAP ${prefix}${n} = "${asset(i)}"\n`).join('');

