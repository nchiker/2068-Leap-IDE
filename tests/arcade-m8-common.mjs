"use strict";
// arcade-m8-common.mjs -- shared by tests/arcade-m8-compiler.mjs and tests/arcade-m8-differential.mjs (language batch 3: the 3D view, the raycaster slice).
//   rng(seed)             seeded PRNG
//   ASSETS                view maps (a 12 x 12 maze with all four wall types, a 32 x 32 one, a 4 x 4 one, bad ones), sprites (square, framed, non-square), a HUD map
//   PROGRAMS              VIEW3D programs for the mock and the differential tests: {name, src, ticks, stick(t), billboard(t, i), mock}
//   independent models    cosModel / sinModel / fxmulModel / viewModel(...): written from the DEFINITIONS (4096 cos, BigInt products, a grid of arrays), not like arcade-view.js
//   diffV4(got, want)     compare a snapshot of a machine with an interpreter record (variables, arrays, SPR_TAB entries, the 32 x 32 map array, the pose)

export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── independent models ───────────────────────────────────────────────────────────────────────────────────────────────────────────
/** COSA(a): the angle's low byte; 4096 * cos(2 pi a / 256) rounded, plus 8, divided by 16 rounding down. */
export const cosModel = (a) => Math.floor((Math.round(4096 * Math.cos(2 * Math.PI * (a & 255) / 256)) + 8) / 16);
export const sinModel = (a) => Math.floor((Math.round(4096 * Math.sin(2 * Math.PI * (a & 255) / 256)) + 8) / 16);
/** FXMUL: the exact product shifted right by 8 (BigInt: floor for negatives), wrapped to a signed 16-bit value. */
export const fxmulModel = (a, b) => Number(BigInt.asIntN(16, (BigInt(a) * BigInt(b)) >> 8n));
/** The runtime's 32 x 32 map array as a grid of rows; cells outside the game's w x h are wall type 1. */
export function viewModel(w, h, cells) {
  const grid = Array.from({ length: 32 }, (_, r) => Array.from({ length: 32 }, (_, c) => (r < h && c < w ? cells[r * w + c] : 1)));
  const api = {
    grid, w, h,
    wall(x, y) { if (x < 0 || y < 0) return 1; const c = Math.floor(x / 256), r = Math.floor(y / 256); return c >= 32 || r >= 32 ? 1 : grid[r][c]; },
    set(x, y, t) { if (x < 0 || y < 0 || t < 0 || t > 4) return; const c = Math.floor(x / 256), r = Math.floor(y / 256); if (c < w && r < h && !(t === 0 && (c === 0 || r === 0 || c === 31 || r === 31))) grid[r][c] = t; },   // clarification 7: no 0 on the array's ring
    pose(x, y, a) { const cl = (v, n) => (v < 0 ? 0 : Math.min(v, n * 256 - 1)); return { x: cl(x, w), y: cl(y, h), a: ((a % 256) + 256) % 256 }; },
    flat() { return Uint8Array.from(grid.flat()); },
  };
  return api;
}

// ── assets ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// A 12 x 12 maze: wall types 1..4 on the ring and inside, a corridor, a room with a door (type 3 at the room's gap), pillars.
const MAZE = [
  '111111111111',
  '1..........1',
  '1.22..4444.1',
  '1.2.......11',
  '1.2..33..3.1',
  '1....3.....1',
  '1.44.3.2...1',
  '1....3.2.4.1',
  '1.11...2.4.1',
  '1.......3..1',
  '1..44......1',
  '111111111111',
];
const mazeCells = (rows) => rows.flatMap((r) => [...r].map((ch) => (ch === '.' ? 0 : Number(ch))));
const ringMap = (w, h, inner = () => 0) => Array.from({ length: w * h }, (_, i) => { const r = (i / w) | 0, c = i % w; return r === 0 || c === 0 || r === h - 1 || c === w - 1 ? ((r + c) % 4) + 1 : inner(c, r); });
const solidSprite = (w, h, extra = {}) => ({ w, h, rows: Array.from({ length: h }, (_, y) => ({ bits: y & 1 ? 'A'.repeat(w / 4) : '5'.repeat(w / 4), mask: 'F'.repeat(w / 4) })), ...extra });
export const ASSETS = {
  sprites: {
    orb: solidSprite(16, 16),
    guard: { w: 16, h: 16, frames: [0, 1, 2].map((f) => ({ rows: Array.from({ length: 16 }, (_, y) => ({ bits: (0xFFFF >> f) & 0xFFFF, mask: 'FFFF' })) })) },
    giant: { w: 32, h: 32, frames: [0, 1].map((f) => ({ rows: Array.from({ length: 32 }, (_, y) => ({ bits: f ? '80000001' : 'FFFFFFFF', mask: 'FFFFFFFF' })) })) },
    tall: { w: 8, h: 16, rows: Array.from({ length: 16 }, () => ({ bits: 'AA', mask: 'FF' })) },
    pill: { w: 8, h: 8, rows: Array.from({ length: 8 }, () => ({ bits: 'FF', mask: 'FF' })) },
    big48: solidSprite(32, 48),
  },
  tilesets: { ts: { tiles: [0, 1, 2].map((i) => ({ rows: Array.from({ length: 8 }, () => ({ bits: i ? 0xFF : 0, ink: i, paper: 7 - i })) })) } },
  sfx: {},
  maps: {
    maze: { w: 12, h: 12, cells: mazeCells(MAZE) },
    big: { w: 32, h: 32, cells: ringMap(32, 32, (c, r) => (c % 5 === 2 && r % 5 === 2 ? ((c + r) % 4) + 1 : 0)) },
    small: { w: 4, h: 4, cells: [1, 2, 3, 4, 4, 0, 0, 3, 3, 0, 0, 2, 2, 1, 4, 1] },
    wide: { w: 32, h: 5, cells: ringMap(32, 5) },
    strip: { w: 5, h: 32, cells: ringMap(5, 32) },
    hud: { w: 32, h: 2, cells: Array.from({ length: 64 }, (_, i) => (i % 5 === 0 ? 1 : -1)) },
    blankring: { w: 6, h: 6, cells: ringMap(6, 6).map((v, i) => (i === 3 ? -1 : v)) },
    emptyring: { w: 6, h: 6, cells: ringMap(6, 6).map((v, i) => (i === 6 * 5 + 2 ? 0 : v)) },
    cell5: { w: 6, h: 6, cells: ringMap(6, 6, (c, r) => (c === 2 && r === 2 ? 5 : 0)) },
    tiny3: { w: 3, h: 8, cells: ringMap(3, 8) },
    huge33: { w: 33, h: 8, cells: ringMap(33, 8) },
    hexmap: { w: 4, h: 4, cells: '01010101' + '01000001' + '01000001' + '01010101' },
  },
};
/** a map patched into ASSETS under `name` */
export const withMap = (name, m, base = ASSETS) => ({ ...base, maps: { ...base.maps, [name]: m } });

// ── programs ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const HEAD = (extra = '', map = 'maze') => `GAME "t"\nFRAMERATE 12\nMAP level = "${map}"\n${extra}`;

/**
 * A small game of the 3D view (NOT the acceptance game): walk a maze with the joystick (turn left/right, forward/back by the sine table, collision with WALL), a door in the
 * room opened by walking up to it (SETWALL), three billboards that chase the player in 8.8 world coordinates, one shot (fire) that uses SEEN / DEPTH of the previous tick's
 * draw, HIT between a billboard and the player's marker, the pose given with VIEW every tick.
 */
export const RAY = `${HEAD('SPRITE key = "pill"\nSPRITE guard(3) = "guard"\nSPRITE me = "orb"\nCONST SPEED = 40\nCONST TURN = 4\nCONST R = 40\n')}VIEW3D level COLW 4 INK 7 CEIL 1 FLOOR 5
SCENE play
  DIM px, py, pa, nx, ny, dx, dy, i, k, hp, score, door, keys, shots, aimed, seenmask, near, gx(2), gy(2), alive(2), gframe(2)
  PROC INIT()
    px = 2432 : py = 2432 : pa = 128 : hp = 20 : door = 0
    gx(0) = 1280 : gy(0) = 640 : gx(1) = 2432 : gy(1) = 2432 : gx(2) = 640 : gy(2) = 1920
    FOR i = 0 TO 2
      alive(i) = 1
    NEXT i
  ENDP
  PROC FRAME()
    LOCAL s
    s = STICK(1)
    IF BIT(s, 3) THEN pa = pa + TURN ENDIF
    IF BIT(s, 2) THEN pa = pa - TURN ENDIF
    dx = FXMUL(COSA(pa), SPEED) : dy = FXMUL(SINA(pa), SPEED)
    nx = px : ny = py
    IF BIT(s, 0) THEN
      nx = px + dx : ny = py + dy
    ENDIF
    IF BIT(s, 1) THEN
      nx = px - dx : ny = py - dy
    ENDIF
    IF WALL(nx, py) = 0 THEN px = nx ENDIF
    IF WALL(px, ny) = 0 THEN py = ny ENDIF
    REM the door: walking into a type 3 wall with the key opens the cell
    IF WALL(nx, ny) = 3 AND keys > 0 AND door = 0 THEN
      SETWALL nx, ny = 0
      door = 1 : keys = keys - 1
    ENDIF
    IF WALL(nx + 256, ny) = 4 THEN SETWALL nx + 256, ny = 3 ENDIF
    REM pickups: the key lies at (9.5, 9.5) where the player starts
    IF ABS(px - 2432) < 200 AND ABS(py - 2432) < 200 THEN keys = 1 : HIDE key ELSE SHOW key AT 2432, 2432 ENDIF
    REM the guards chase (one step of 8 per tick toward the player), the shot kills what the previous draw saw near the middle
    seenmask = 0
    FOR i = 0 TO 2
      IF alive(i) THEN
        gframe(i) = (gframe(i) + 1) MOD 3
        IF px > gx(i) AND WALL(gx(i) + 8 + 48, gy(i)) = 0 THEN gx(i) = gx(i) + 8 ENDIF
        IF px < gx(i) AND WALL(gx(i) - 8 - 48, gy(i)) = 0 THEN gx(i) = gx(i) - 8 ENDIF
        IF py > gy(i) AND WALL(gx(i), gy(i) + 8 + 48) = 0 THEN gy(i) = gy(i) + 8 ENDIF
        IF py < gy(i) AND WALL(gx(i), gy(i) - 8 - 48) = 0 THEN gy(i) = gy(i) - 8 ENDIF
        SHOW guard(i) AT gx(i), gy(i) FRAME gframe(i)
        IF SEEN(guard(i)) >= 0 THEN seenmask = seenmask + SHL(1, i) ENDIF
      ELSE
        HIDE guard(i)
      ENDIF
    NEXT i
    shots = shots + BIT(s, 4)
    IF BIT(s, 4) THEN
      near = 32000 : aimed = -1
      FOR i = 0 TO 2
        IF alive(i) AND SEEN(guard(i)) >= 0 THEN
          IF ABS(SEEN(guard(i)) - 64) < 12 AND DEPTH(guard(i)) < near THEN near = DEPTH(guard(i)) : aimed = i ENDIF
        ENDIF
      NEXT i
      IF aimed >= 0 THEN alive(aimed) = 0 : score = score + 10 ENDIF
    ENDIF
    SHOW me AT px, py
    FOR i = 0 TO 2
      IF HIT(me, guard(i)) THEN hp = hp - 1 ENDIF
    NEXT i
    VIEW px, py, pa
  ENDP
ENDSCENE
`;

/** Every new word with constants, variables, expressions and run-time pool indices; edges of the map, bad arguments, the pose clamp, the big map (32 x 32), sprite frames in ray mode. */
export const WORDS = `${HEAD('SPRITE g(4) = "guard"\nSPRITE giant = "giant"\nSPRITE pil = "pill"\nCONST C0 = 7\n', 'big')}VIEW3D level PATTERNS 255,255,170,85,238,187,136,34,255,0,170,0,204,204,136,136 BRIGHT 0 FLOOR 6 COLW 2 INK 3 CEIL 4
SCENE s
  DIM v, a, b, k, r(23), sn(5), dep(5), j
  DEF FN dbl(x) = FXMUL(x, 512)
  PROC INIT()
    VIEW 300, 300, 40
    SHOW giant AT 1000, 1000 FLIP
    SHOW pil AT 2000, 700 FRAME 0
  ENDP
  PROC FRAME()
    k = k + 1
    a = k * 331 - 600 : b = k MOD 11 * 777 - 300
    r(0) = WALL(a, b)
    r(1) = WALL(a MOD 8192, b MOD 8192)
    r(2) = WALL(k * 256 + 20, 256 * 3)
    r(3) = FXMUL(a, b) : r(4) = FXMUL(COSA(k * 9), SINA(k * 5))
    r(5) = COSA(a) + SINA(b) : r(6) = FN dbl(a)
    r(7) = COSA(k) : r(8) = SINA(k) : r(9) = COSA(0 - k) : r(10) = SINA(k + 256) : r(11) = COSA(k * 64)
    SETWALL a, b = k MOD 7 - 1
    SETWALL 32 * 256 - 1, 31 * 256 = 2
    SETWALL k * 100, 16 * k = C0 - 4 * (k MOD 2)
    SETWALL 256, 256 = k MOD 5
    VIEW a * 3, b * 2, k * 7
    SHOW g(k MOD 5) AT a * 4, b FRAME k MOD 3
    SHOW g(2) AT 5000 + k, 7000 FLIP
    SHOW giant AT 32000 + k * 50, 300 FRAME k MOD 2
    IF k > 30 THEN HIDE giant ENDIF
    FOR j = 0 TO 4
      sn(j) = SEEN(g(j)) : dep(j) = DEPTH(g(j))
    NEXT j
    r(12) = SEEN(giant) : r(13) = DEPTH(giant) : r(14) = SEEN(g(k MOD 7)) : r(15) = DEPTH(g(k MOD 7 - 1))
    r(16) = HIT(g(0), g(1)) + 2 * HIT(g(0), giant) + 4 * HIT(pil, giant)
    v = v + r(0) + r(2)
  ENDP
ENDSCENE
`;

/** A 4 x 4 map (the smallest), a 32 x 4... no: a 5 x 32 strip; no band of anything else; the window of the screen cells outside the view stays the program's (TILE / FILL on the cell map). */
export const SMALL = `GAME "t"\nFRAMERATE 12\nMAP level = "small"\nSPRITE o = "orb"\nVIEW3D level\nSCENE s
  DIM i, v, t
  PROC INIT()
    VIEW 512, 512, 128
  ENDP
  PROC FRAME()
    i = i + 1
    SETWALL 256 + i * 16, 256 * 2 = 4 - i MOD 5
    t = WALL(i * 100, 512) + WALL(300, i * 80)
    v = v + FXMUL(t, i)
    SHOW o AT i * 40, 1024 - i * 13
    VIEW 2000 - i * 40, i * 33, 192 + i
  ENDP
ENDSCENE
`;

/** scripted joystick for RAY: forward with turns, backward, a shot every so often. */
export const RAY_STICK = (t) => {
  const ph = t % 120;
  let v = 0;
  if (ph < 40) v = 1; else if (ph < 55) v = 8; else if (ph < 90) v = 1 | (ph % 7 === 0 ? 4 : 0); else if (ph < 100) v = 2; else if (ph < 110) v = 4;
  if (t % 23 === 0) v |= 16;
  return v;
};
/** the previous tick's draw as the harness injects it: deterministic, some instances not seen */
export const BILLBOARD = (t, i) => {
  if ((t * 7 + i * 3) % 5 === 0 || i > 8) return undefined;
  return { depth: 100 + ((t * 37 + i * 91) % 2900), col: ((t * 13 + i * 29) % 128) };
};

export const PROGRAMS = [
  { name: 'a maze game of the 3D view (walking by COSA/SINA/FXMUL, WALL collision, SETWALL doors, chasing billboards, SEEN/DEPTH shots, HIT)', src: RAY, ticks: 720, stick: RAY_STICK, billboard: BILLBOARD },
  { name: 'every word with constants, variables, run-time pool indices and out-of-range values on a 32 x 32 map (PATTERNS, COLW 2)', src: WORDS, ticks: 200, stick: () => 0, billboard: BILLBOARD },
  { name: 'the smallest map (4 x 4), the pose pushed out of the map', src: SMALL, ticks: 120, stick: () => 0, billboard: BILLBOARD },
];

// ── comparing a machine with the interpreter ─────────────────────────────────────────────────────────────────────────────────────
/**
 * got: {vars, arrays, sprites: [{visible, asset, x, y, frame}], wallRam: Uint8Array(1024) | null, pose: {x, y, a} | null}; want: an interpreter record. Returns null or the
 * first difference. A snapshot taken while PROC FRAME is entered shows the pose and the map of the previous tick.
 */
export function diffV4(got, want, label = '') {
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
    if (g.visible !== w.visible || g.asset !== w.asset || g.x !== w.x || g.y !== w.y || g.frame !== w.frame) return `${at}SPR_TAB[${i}] = ${JSON.stringify(g)}, interpreter ${JSON.stringify({ visible: w.visible, asset: w.asset, x: w.x, y: w.y, frame: w.frame })}`;
  }
  if (want.wallRam) {
    if (!got.wallRam) return `${at}no map array in the snapshot`;
    for (let i = 0; i < 1024; i++) if (got.wallRam[i] !== want.wallRam[i]) return `${at}map array[row ${i >> 5}, col ${i & 31}] = ${got.wallRam[i]}, interpreter ${want.wallRam[i]}`;
  }
  if (want.view && got.pose) {
    const g = got.pose, w = want.view;
    if (g.x !== w.x || g.y !== w.y || g.a !== w.a) return `${at}pose = ${JSON.stringify(g)}, interpreter ${JSON.stringify(w)}`;
  }
  return null;
}
