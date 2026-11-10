"use strict";
// arcade-m6-common.mjs -- shared by tests/arcade-m6-compiler.mjs and tests/arcade-m6-differential.mjs (language batch 2: the scrolling window).
//   rng(seed)            seeded PRNG
//   ASSETS               tileset (flags), three worlds, four sprites with frames
//   PROGRAMS             window programs for the differential tests: {name, src, ticks, stick(t)}
//   independent models   worldModel(...) -> {tile, flags, hit, ...} written per PIXEL (not like arcade-window.js) for the collision fuzz
//   diffV3(got, want)    compare a snapshot of a machine with an interpreter record (variables, arrays, SPR_TAB entries, WORLD_RAM, V_CAM)

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── assets ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// tile 0 blank (the sky), 1 brick (solid), 2 spikes (hazard), 3 coin (pickup), 4 one-way platform (flag bit 3), 5 cloud, 6 hill (no flags), 7 solid + game bit 7
const TILE_BITS = [
  [0, 0, 0, 0, 0, 0, 0, 0],
  [0xFF, 0x81, 0xBD, 0xA5, 0xA5, 0xBD, 0x81, 0xFF],
  [0x00, 0x00, 0x18, 0x18, 0x3C, 0x3C, 0x7E, 0xFF],
  [0x3C, 0x42, 0x99, 0xA5, 0xA5, 0x99, 0x42, 0x3C],
  [0xFF, 0xFF, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00],
  [0x00, 0x1C, 0x3E, 0x7F, 0x00, 0x00, 0x00, 0x00],
  [0x00, 0x00, 0x00, 0x18, 0x3C, 0x7E, 0xFF, 0xFF],
  [0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55, 0xAA, 0x55],
];
export const TILE_FLAGS = [0, 1, 2, 4, 8, 0, 0, 0x81];
export const tileAsset = () => ({ tiles: TILE_BITS.map((rows, i) => ({ flags: TILE_FLAGS[i], rows: rows.map((b, y) => ({ bits: b, ink: i % 8, paper: i === 0 ? 5 : 7 - (y & 1), bright: i & 1 })) })) });

/** A world: columns w, rows h; ground at the bottom with pits, platforms, spikes, coins, a wall at the right edge. */
function makeWorld(w, h, seed) {
  const r = rng(seed), cells = new Array(w * h).fill(0);
  const set = (c, row, t) => { if (c >= 0 && c < w && row >= 0 && row < h) cells[row * w + c] = t; };
  for (let c = 0; c < w; c++) {
    const pit = (c % 23 >= 19 && c % 23 <= 20);
    if (!pit) { set(c, h - 1, 1); set(c, h - 2, 1); }
    if (c % 31 === 25) set(c, h - 3, 2);
    if (c % 9 === 3) set(c, h - 5, 4);
    if (c % 7 === 1) set(c, h - 4 - (c % 3), 3);
    if (c % 13 === 6 && h > 8) set(c, 2 + (c % 3), 5);
    if (r() < 0.1) set(c, h - 3, 6);
  }
  for (let row = 0; row < h; row++) { set(0, row, 1); set(w - 1, row, 7); }
  return { w, h, cells };
}
export const ASSETS = {
  sprites: {
    player: { w: 16, h: 24, hot: [3, 2, 10, 22], frames: Array.from({ length: 8 }, (_, f) => ({ rows: Array.from({ length: 24 }, (_, y) => ({ bits: (0xFFFF >> (f & 3)) & ((y + f) & 4 ? 0xFFFF : 0x7FFE), mask: 'FFFF', ink: 7, paper: 0 })) })) },
    coin: { w: 8, h: 8, frames: Array.from({ length: 4 }, (_, f) => ({ rows: Array.from({ length: 8 }, (_, y) => ({ bits: (0xFF << f) & 0xFF ^ (y << 1), mask: 'FF' })) })) },
    wide: { w: 32, h: 16, phases: 4, frames: [0, 1].map((f) => ({ rows: Array.from({ length: 16 }, (_, y) => ({ bits: f ? '80000001' : 'FFFFFFFF', mask: 'FFFFFFFF' })) })) },
    plain: { w: 16, h: 16, rows: Array.from({ length: 16 }, () => ({ bits: 'FFFF', mask: 'FFFF' })) },
    tall: { w: 8, h: 48, phases: 2, rows: Array.from({ length: 48 }, (_, y) => ({ bits: y & 1 ? 'AA' : '55', mask: 'FF' })) },
  },
  tilesets: { ts: tileAsset() },
  sfx: {},
  maps: { lv: makeWorld(128, 16, 1), mid: makeWorld(60, 16, 2), short: makeWorld(24, 9, 3), tiny: makeWorld(24, 16, 4), hud: { w: 32, h: 2, cells: Array.from({ length: 64 }, (_, i) => (i % 5 === 0 ? 3 : -1)) } },
};

// ── window programs (differential tests) ─────────────────────────────────────────────────────────────────────────────────────────
const HEAD = (extra = '') => `GAME "t"\nFRAMERATE 20\nTILESET ts = "ts"\nMAP level = "lv"\n${extra}`;

/** A platformer in miniature: gravity, SOLID on the box, jump, walking, coins removed with SETWORLD, camera following, FRAME and FLIP, a pool of coins. */
export const PLATFORMER = `${HEAD('SPRITE p = "player"\nSPRITE c(4) = "coin"\nSPRITE e(2) = "plain"\nCONST GRAV = 1\nCONST PW = 16\nCONST PH = 24\n')}WINDOW level
BAND 2, 1, 4
BAND 3, 1, 2
BAND 11, 1, 1
SCENE play
  DIM px, py, vy, face, anim, score, grounded, n, i, hz
  DIM ex(1), ed(1)
  PROC INIT()
    px = 24 : py = 60 : face = 1
    ed(0) = 1 : ed(1) = -1 : ex(0) = 200 : ex(1) = 700
    FOR i = 0 TO 3
      SHOW c(i) AT 100 + i * 90, 100 FRAME i
    NEXT i
  ENDP
  PROC FRAME()
    LOCAL k
    n = n + 1
    REM horizontal
    IF BIT(STICK(1), 3) THEN
      IF NOT SOLID(px + 2, py, PW, PH) THEN px = px + 2 ENDIF
      face = 1 : anim = anim + 1
    ENDIF
    IF BIT(STICK(1), 2) THEN
      IF NOT SOLID(px - 2, py, PW, PH) THEN px = px - 2 ENDIF
      face = -1 : anim = anim + 1
    ENDIF
    REM vertical
    grounded = SOLID(px, py + 1, PW, PH)
    IF grounded AND BIT(STICK(1), 0) THEN vy = -9 ENDIF
    vy = vy + GRAV
    IF vy > 7 THEN vy = 7 ENDIF
    FOR k = 1 TO ABS(vy)
      IF NOT SOLID(px, py + SGN(vy), PW, PH) THEN py = py + SGN(vy) ELSE vy = 0 ENDIF
    NEXT k
    REM coins and spikes
    IF TILEHIT(px, py, PW, PH, 4) THEN
      FOR k = 0 TO 1
        IF WORLDTILE(px + 4 + k * 8, py + 12) = 3 THEN SETWORLD px + 4 + k * 8, py + 12 = 0 : score = score + 1 ENDIF
      NEXT k
    ENDIF
    hz = TILEHIT(px, py, PW, PH, 2)
    IF hz OR py > 130 THEN px = 24 : py = 60 : vy = 0 ENDIF
    REM camera and drawing
    CAMERA px - 96
    IF face < 0 THEN
      SHOW p AT px, py FRAME anim DIV 4 MOD 4 + 4 FLIP
    ELSE
      SHOW p AT px, py FRAME anim DIV 4 MOD 4 + 1
    ENDIF
    FOR i = 0 TO 3
      SHOW c(i) AT 100 + i * 90, 100 + SHL(BAND(n, 4), 0) FRAME (n DIV 3 + i) MOD 4
    NEXT i
    FOR i = 0 TO 1
      ex(i) = ex(i) + ed(i)
      IF SOLID(ex(i) + ed(i), 90, 16, 16) THEN ed(i) = -ed(i) ENDIF
      SHOW e(i) AT ex(i), 90
    NEXT i
    IF HIT(p, e(0)) OR HIT(p, e(1)) THEN score = score - 1 ENDIF
    IF CAMX() > 400 THEN HIDE e(1) ENDIF
  ENDP
ENDSCENE
`;

/** Every word once, with constants and variables as arguments, on a short world with a fixed band; also SHOW with a run-time instance, FLIP only, FRAME 0. */
export const WORDS = `${HEAD('MAP hud = "hud"\nSPRITE w = "wide"\nSPRITE t(3) = "tall"\nSPRITE pl = "plain"\nCONST C0 = 8\n')}WINDOW level AT 3, 2
BAND 4, 1, 4
BAND 12, 2, 1
SCENE s
  DIM v, a, b, k, r(9), cs
  DEF FN under(x) = WORLDTILE(x, 127) + TILEFLAGS(x, 120)
  PROC INIT()
    CAMERA 40
    cs = CAMX()
    SHOW w AT 10, 10 FLIP
    SHOW pl AT 20, 30 FRAME 0
  ENDP
  PROC FRAME()
    k = k + 1
    a = k * 7 - 30 : b = k MOD 9 * 13
    r(0) = WORLDTILE(a, b)
    r(1) = TILEFLAGS(a - 5, b + 200)
    r(2) = TILEHIT(a, b, 1 + k MOD 40, 1 + b MOD 30, 255)
    r(3) = SOLID(a, b, C0, C0)
    r(4) = FN under(a)
    r(5) = CAMX()
    CAMERA k * 21 - 100
    SETWORLD a, b = k MOD 9
    SETWORLD 16, 16 = 2
    SETWORLD a, 50 = k - 20
    SHOW t(k MOD 4) AT a, b FRAME 0
    SHOW t(5) AT 1, 1
    SHOW pl AT k * 2, 100 FLIP
    SHOW w AT 300 - k, 20 FRAME k MOD 2
    IF k > 40 THEN HIDE w ENDIF
    v = v + r(0) + r(3)
  ENDP
ENDSCENE
`;

/** No band list (one band of 16 rows at 1/1), a 24-wide world (cam_max 0), a short map (rows beyond are 0), a fixed band, a window at (0, 0). */
export const SHORT = `${HEAD('SPRITE p = "plain"\n').replace('"lv"', '"short"')}WINDOW level AT 0, 0
BAND 5, 0, 1
BAND 11, 1, 1
SCENE s
  DIM i, v, t
  PROC INIT()
  ENDP
  PROC FRAME()
    i = i + 1
    CAMERA i * 8
    SETWORLD i * 5, 8 * 8 + i = 1 + i MOD 3
    t = WORLDTILE(i * 5, 70) + SOLID(i * 5, 71, 3, 3)
    v = v + TILEFLAGS(i * 9 - 20, 140 - i * 8)
    SHOW p AT i * 4, i
  ENDP
ENDSCENE
`;

// ── the acceptance game (arcade/examples/platformer.arc) ───────────────────────────────────────────────────────────────────────────
// Its assets are merged into ASSETS under names that do not clash with the miniature's (hero, walker, flyer, spincoin, the tileset pf, the map level, six sounds), so the
// differential runs find them. The two scripts are the recorded play-through to the flag (played twice) and a run that loses all three lives, goes back to the title and starts again.
// NOTE: the game PLAYs sounds, prints a HUD and reads KEYDOWN; tests/arcade-m6-mock.mjs has no such routines, so arcade-m6-compiler.mjs section 6 cannot compile these two
// (it would report RT_PLAY missing). They run on the mock with stubs in tests/arcade-m6-platformer.mjs, and on the real runtime in arcade-m6-differential.mjs.
import { RUNS as WIN_RUNS, LENGTH as WIN_LENGTH } from './arcade-m6-platformer-script.mjs';
const EX_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'arcade', 'examples');
export const PLATFORMER_GAME = readFileSync(join(EX_DIR, 'platformer.arc'), 'utf8');
const PLATFORMER_JSON = JSON.parse(readFileSync(join(EX_DIR, 'platformer.assets.json'), 'utf8'));
Object.assign(ASSETS.sprites, PLATFORMER_JSON.sprites);
Object.assign(ASSETS.tilesets, PLATFORMER_JSON.tilesets);
Object.assign(ASSETS.sfx, PLATFORMER_JSON.sfx);
Object.assign(ASSETS.maps, PLATFORMER_JSON.maps);
/** run-length list [[value, ticks], ...] -> stick(t) for tick t = 1, 2, ... (0 after the end) */
export const stickFromRuns = (runs) => { const a = []; for (const [v, n] of runs) for (let i = 0; i < n; i++) a.push(v); return (t) => a[t - 1] ?? 0; };
export const WIN_STICK = stickFromRuns(WIN_RUNS);
export { WIN_LENGTH };
/**
 * The play-through twice, with the end screen and the title between: after the flag, wait PAD ticks (the end text needs 4 and half a second), fire (back to the title, which gives the
 * coins back in 5 ticks), then the same input again. A new game resets the game's frame counter, so the second game repeats the first exactly.
 */
const TWICE_PAD = 12;
export const TWICE_RUNS = [...WIN_RUNS, [0, TWICE_PAD], [16, 1], ...WIN_RUNS];
export const TWICE_STICK = stickFromRuns(TWICE_RUNS);
export const TWICE_LENGTH = 2 * WIN_LENGTH + TWICE_PAD + 1;
/** Over the title: fire starts a game at tick 12; then right, a little left (the hero faces left: the FLIP frames), right again without jumping (the walkers cost the three lives), wait, fire for the title, fire again for a new game, run right. */
export const OVER_RUNS = [[0, 13], [16, 1], [0, 1], [8, 20], [4, 14], [8, 220], [0, 15], [16, 1], [0, 30], [16, 1], [0, 1], [8, 60]];
export const OVER_STICK = stickFromRuns(OVER_RUNS);
export const OVER_LENGTH = OVER_RUNS.reduce((n, [, k]) => n + k, 0);

export const PROGRAMS = [
  { name: 'platformer (gravity, SOLID, SETWORLD coins, camera, FRAME + FLIP, pools)', src: PLATFORMER, ticks: 600, stick: (t) => (t < 30 ? 0 : t % 100 < 70 ? (t % 25 < 3 ? 8 | 1 : 8) : t % 100 < 80 ? 4 : t % 100 < 90 ? 4 | 1 : 0) },
  { name: 'every word with constants and variables (ratio 2 band, window at (3, 2))', src: WORDS, ticks: 160, stick: () => 0 },
  { name: 'a short 24-wide world, a fixed band, a window at (0, 0)', src: SHORT, ticks: 90, stick: () => 0 },
  { name: 'platformer.arc, two play-throughs from the title to the flag with the title between (coins, stomps, FLIP, checkpoints, camera, state machine)', src: PLATFORMER_GAME, ticks: TWICE_LENGTH, stick: TWICE_STICK, needsFullRuntime: true },
  { name: 'platformer.arc, three lives lost, game over, back to the title, a new game', src: PLATFORMER_GAME, ticks: OVER_LENGTH, stick: OVER_STICK, needsFullRuntime: true },
];

// ── independent collision model (per pixel; a different formulation from arcade-window.js) ──────────────────────────────────────────
/**
 * A world as the contract describes it, kept as a grid of tile numbers (rows 0..15, columns 0..w-1) and the 32 flags. pixel(x, y) is the flags of the
 * pixel's cell: outside the world: solid (1) on the left, the right and above, empty (0) below the 16 rows; below wins at a corner.
 */
export function worldModel(w, cells, h, flags) {
  const grid = Array.from({ length: 16 }, (_, r) => Array.from({ length: w }, (_, c) => (r < h ? cells[r * w + c] : 0)));
  const api = {
    grid, w,
    set(x, y, t) { const c = Math.floor(x / 8), r = Math.floor(y / 8); if (c >= 0 && c < w && r >= 0 && r < 16 && t >= 0 && t <= 31) grid[r][c] = t; },
    tile(x, y) { const c = Math.floor(x / 8), r = Math.floor(y / 8); return c >= 0 && c < w && r >= 0 && r < 16 ? grid[r][c] : 0; },
    pixel(x, y) {
      const c = Math.floor(x / 8), r = Math.floor(y / 8);
      if (r >= 16) return 0;
      if (c < 0 || c >= w || r < 0) return 1;
      return flags[grid[r][c]] ?? 0;
    },
    hit(x, y, rw, rh, mask) { let acc = 0; for (let j = 0; j < rh; j++) for (let i = 0; i < rw; i++) acc |= api.pixel(x + i, y + j) & mask; return acc; },
  };
  return api;
}

// ── comparing a machine with the interpreter ─────────────────────────────────────────────────────────────────────────────────────
/**
 * got: {vars, arrays, sprites: [{visible, asset, x, y, frame, pad}], worldRam: Uint8Array(2048), cam}; want: an interpreter record. Returns null or the first difference.
 * `sprites` limits the compared instances (default: all the snapshot has).
 */
export function diffV3(got, want, label = '') {
  const at = label ? `${label}: ` : '';
  for (const [k, v] of Object.entries(want.vars)) if (got.vars[k] !== v) return `${at}${k} = ${got.vars[k]}, interpreter ${v}`;
  for (const [k, arr] of Object.entries(want.arrays ?? {})) {
    const ga = got.arrays[k];
    if (!ga) return `${at}array ${k} missing`;
    for (let j = 0; j < arr.length; j++) if (ga[j] !== arr[j]) return `${at}${k}(${j}) = ${ga[j]}, interpreter ${arr[j]}`;
  }
  const n = Math.min(got.sprites.length, want.sprites.length);
  for (let i = 0; i < n; i++) {
    const g = got.sprites[i], w = want.sprites[i];
    // a hidden instance keeps its last position / frame; both sides do
    if (g.visible !== w.visible || g.asset !== w.asset || g.x !== w.x || g.y !== w.y || g.frame !== w.frame) return `${at}SPR_TAB[${i}] = ${JSON.stringify(g)}, interpreter ${JSON.stringify({ visible: w.visible, asset: w.asset, x: w.x, y: w.y, frame: w.frame })}`;
  }
  if (want.worldRam) {
    if (!got.worldRam) return `${at}no WORLD_RAM in the snapshot`;
    for (let i = 0; i < 2048; i++) if (got.worldRam[i] !== want.worldRam[i]) return `${at}WORLD_RAM[row ${i >> 7}, col ${i & 127}] = ${got.worldRam[i]}, interpreter ${want.worldRam[i]}`;
    if (got.cam !== want.cam) return `${at}V_CAM = ${got.cam}, interpreter ${want.cam}`;
  }
  return null;
}
