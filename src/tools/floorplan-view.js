/**
 * src/tools/floorplan-view.js -- the model of the Studio's floor plan 3D preview (pure: no DOM, Node can import it).
 *
 * The picture is NOT a new renderer: it is the JS reference of the v4 raycaster (src/tools/raycast-ref.js: castFrame + drawWalls, the code that
 * arcade/tests/m8-common.mjs compares with the Z80 runtime byte for byte) run on the floor plan the way the runtime's loader embeds it.
 *
 *   World      positions x, y are 8.8 fixed point (1/256 cell); the angle a is 0..255, 256 to a turn; angle 0 looks east (+x), 64 south (+y, down the
 *              plan), 128 west, 192 north.  The pose is { x, y, a }.
 *   The map    { w, h, cells } of wall codes 0 (empty) .. 4 (any size 4..32); embedMap() makes the runtime's 32 x 32 array from it (stride 32): cells
 *              outside w x h and every empty cell on the array's outer ring are wall 1; codes above 4 read as 4; a blank (negative or 255) reads as 0.
 *
 *   embedMap(map)                    -> { ok, array: Uint8Array(1024), problems[] } (problems: a size outside 4..32; empty cells on the plan's outer ring,
 *                                       which the compiler refuses)
 *   render(map, pose, colw, opts)    -> { ok, pose, inWall, cast, bitmap (the 6,144-byte display file), window (96 rows x 16 bytes), pixels (128 x 96, 1 = ink),
 *                                       problems } (opts { patterns: 16 bytes or null, top, bottom: attribute bytes }; error: { ok: false, message })
 *   rgba(result, opts)               -> Uint8ClampedArray(128 * 96 * 4): the picture in the attribute colours of the ceiling (top 6 cell rows) and floor
 *   placeViewer(map, cx, cy, dir)    -> { ok, pose } | { ok: false, message }: the centre of a cell, looking dir (an angle, or 'N' 'E' 'S' 'W' ...)
 *   stepPose(map, pose, dist)        -> { pose, moved, blocked }: forward (dist > 0) or back, one axis at a time, with the collision rule of Vaults
 *   turnPose(pose, delta), poseInWall(map, pose), firstFreeCell(map), legend(), attrColours(attr), viewerRays(pose)
 *
 * The collision rule is the example game's (arcade/examples/vaults.arc, MOVEPLAYER), not the runtime's: the runtime only reports WALL(x, y); the game
 * moves on one axis if the two leading corners of its box (radius RAD) are in empty cells, so it slides along a wall.
 */

"use strict";

import { rleEncode, loadMap, wallAt, castFrame, drawWalls, patsOf, rowAddr, VIEW, PAT, COS, cosa8, sina8, fxmul, clampPos } from './raycast-ref.js';
import { PALETTE, paletteRgb } from './sprite-model.js';

export const MIN_SIDE = 4;
export const MAX_SIDE = 32;
export const COLW_CHOICES = [4, 2];
/** The walking rule of Vaults: the half width of the viewer's box and the length of one of its ticks, in 1/256 cell. */
export const WALK = Object.freeze({ RAD: 40, SPD: 44 });
/** The compass: angle by letter (0 east, 64 south, 128 west, 192 north; the diagonals in between, 8 steps of 32). */
export const DIRS = Object.freeze({ E: 0, SE: 32, S: 64, SW: 96, W: 128, NW: 160, N: 192, NE: 224 });
/** The default attribute bytes of the view: white ink on black paper above and below the horizon. */
export const DEFAULT_ATTR = 0x07;

const WALL_NAMES = ['empty', 'wall 1', 'wall 2', 'wall 3', 'wall 4'];
export const wallName = (code) => WALL_NAMES[code] ?? 'invalid';

const cellValue = (v) => { v = Number(v); return !Number.isFinite(v) || v < 0 || v === 255 ? 0 : Math.min(4, Math.floor(v)); };

/** The angle of a direction: a number (taken AND 255) or a compass letter; anything else is east. */
export function angleOf(dir) {
  if (typeof dir === 'string') return DIRS[dir.toUpperCase()] ?? 0;
  return Number.isFinite(dir) ? Math.round(dir) & 255 : 0;
}

/** The runtime's array of a map (see the header), or `map` itself when it already is a 1,024-byte array. */
export function embedMap(map) {
  if (map instanceof Uint8Array && map.length === 1024) return { ok: true, array: map, problems: [] };
  const w = map?.w | 0, h = map?.h | 0, problems = [];
  if (!map || !map.cells || w < MIN_SIDE || w > MAX_SIDE || h < MIN_SIDE || h > MAX_SIDE || map.cells.length < w * h) {
    return { ok: false, array: new Uint8Array(1024).fill(1), problems: [`A floor plan is ${MIN_SIDE} to ${MAX_SIDE} cells wide and high.`] };
  }
  const cells = Uint8Array.from({ length: w * h }, (_, i) => cellValue(map.cells[i]));
  let bad = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && cells[y * w + x] === 0) bad++;
  if (bad) problems.push(`${bad} empty cell${bad > 1 ? 's' : ''} on the outer ring: the compiler needs walls (1..4) all round the floor plan.`);
  return { ok: true, array: loadMap(rleEncode(cells), w, h), problems };
}

/** The wall code the runtime sees at a pose's cell (a position outside the array is wall 1). */
export const poseInWall = (map, pose) => wallAt(embedMap(map).array, pose.x, pose.y);

/** The first empty cell of the map in reading order, as {cx, cy}, or null. */
export function firstFreeCell(map) {
  const { ok, array } = embedMap(map);
  if (!ok) return null;
  for (let cy = 0; cy < map.h; cy++) for (let cx = 0; cx < map.w; cx++) if (array[cy * 32 + cx] === 0) return { cx, cy };
  return null;
}

/** RT_VIEW's rule for a pose: the angle AND 255, the position clamped into the map (0 .. size * 256 - 1). */
export function normalisePose(map, pose) {
  const w = map?.w ?? 32, h = map?.h ?? 32;
  return { x: clampPos(pose.x | 0, w * 256 - 1), y: clampPos(pose.y | 0, h * 256 - 1), a: (pose.a | 0) & 255 };
}

/** Put the viewer in the centre of cell (cx, cy) looking dir. Refused outside the map and inside a wall (the message says why). */
export function placeViewer(map, cx, cy, dir = 0) {
  const e = embedMap(map);
  if (!e.ok) return { ok: false, message: e.problems[0] };
  if (!Number.isInteger(cx) || !Number.isInteger(cy) || cx < 0 || cy < 0 || cx >= map.w || cy >= map.h) return { ok: false, message: 'That cell is outside the floor plan.' };
  const code = e.array[cy * 32 + cx];
  if (code) {
    const own = cellValue(map.cells[cy * map.w + cx]);
    return { ok: false, message: own ? `Cell ${cx}, ${cy} is a wall (${wallName(own)}): the viewer needs an empty cell.`
      : `Cell ${cx}, ${cy} is on the outer ring, which the runtime treats as wall: the viewer needs an empty cell inside it.` };
  }
  return { ok: true, pose: { x: cx * 256 + 128, y: cy * 256 + 128, a: angleOf(dir) } };
}

/** Turn by delta (positive = clockwise as drawn, to the right). */
export const turnPose = (pose, delta) => ({ x: pose.x, y: pose.y, a: (pose.a + delta) & 255 });

/**
 * Walk dist (1/256 cell; negative = backwards) along the pose's angle, as Vaults does: x first, then y, each when the two leading corners of the box
 * (radius WALK.RAD) are in empty cells.  `moved` says which axes moved; `blocked` is true when neither did.
 */
export function stepPose(map, pose, dist = WALK.SPD, rad = WALK.RAD) {
  const arr = embedMap(map).array, c = cosa8(pose.a), s = sina8(pose.a);
  let { x, y } = pose;
  const moved = { x: false, y: false };
  const nx = x + fxmul(c, dist);
  if (nx !== x) {
    const f = nx > x ? nx + rad : nx - rad;
    if (wallAt(arr, f, y - rad) === 0 && wallAt(arr, f, y + rad) === 0) { x = nx; moved.x = true; }
  }
  const ny = y + fxmul(s, dist);
  if (ny !== y) {
    const f = ny > y ? ny + rad : ny - rad;
    if (wallAt(arr, x - rad, f) === 0 && wallAt(arr, x + rad, f) === 0) { y = ny; moved.y = true; }
  }
  return { pose: { x, y, a: pose.a }, moved, blocked: !moved.x && !moved.y };
}

/** The RGB of an attribute byte: { ink, paper } as [r, g, b] (BRIGHT = bit 6, paper = bits 3..5, ink = bits 0..2; black stays black). */
export function attrColours(attr) {
  const b = (attr & 0x40) ? 8 : 0, ink = attr & 7, paper = (attr >> 3) & 7;
  const rgb = (c) => paletteRgb(PALETTE[c === 0 ? 0 : c + b]);
  return { ink: rgb(ink), paper: rgb(paper) };
}

/**
 * Cast and draw the walls of a pose, exactly as the runtime does.  The pose is first made what RT_VIEW makes of it (clamped into the map); the
 * caster then clamps it into cells 1..30 of the array (castPos), as the runtime's does.  `inWall`: the viewer's cell is a wall (a map edited under it).
 */
export function render(map, pose0, colw = 4, opts = {}) {
  if (colw !== 4 && colw !== 2) return { ok: false, message: 'The column width of a view is 4 or 2 pixels.' };
  const e = embedMap(map);
  if (!e.ok) return { ok: false, message: e.problems[0], problems: e.problems };
  const pose = normalisePose(map, pose0);
  let cast;
  try { cast = castFrame(e.array, pose, colw); } catch (err) { return { ok: false, message: `The view could not be cast: ${err.message}`, problems: e.problems }; }
  const bitmap = new Uint8Array(6144);
  drawWalls(bitmap, cast, patsOf(opts.patterns ?? null));
  const window_ = new Uint8Array(96 * 16), pixels = new Uint8Array(VIEW.W * VIEW.H);
  for (let r = 0; r < VIEW.H; r++) for (let k = 0; k < 16; k++) {
    const v = bitmap[rowAddr(VIEW.Y0 + r) + VIEW.X0 + k];
    window_[r * 16 + k] = v;
    for (let b = 0; b < 8; b++) pixels[r * VIEW.W + k * 8 + b] = (v >> (7 - b)) & 1;
  }
  return { ok: true, pose, inWall: wallAt(e.array, pose.x, pose.y) !== 0, cast, bitmap, window: window_, pixels, problems: e.problems };
}

/** The picture as RGBA: ink / paper from the attribute bytes opts.top (pixel rows 0..47) and opts.bottom (48..95), default white on black. */
export function rgba(result, opts = {}) {
  const top = attrColours(opts.top ?? DEFAULT_ATTR), bottom = attrColours(opts.bottom ?? DEFAULT_ATTR);
  const out = new Uint8ClampedArray(VIEW.W * VIEW.H * 4);
  for (let i = 0; i < VIEW.W * VIEW.H; i++) {
    const c = i < VIEW.W * 48 ? top : bottom, rgb = result.pixels[i] ? c.ink : c.paper;
    out[i * 4] = rgb[0]; out[i * 4 + 1] = rgb[1]; out[i * 4 + 2] = rgb[2]; out[i * 4 + 3] = 255;
  }
  return out;
}

/** The wall patterns, for the legend: [{ code, name, sides: [[even row byte, odd row byte] for side 0, side 1] }] for codes 1..4 (patterns: 16 game bytes or null). */
export function legend(patterns = null) {
  const pat = patsOf(patterns ?? null);
  return [1, 2, 3, 4].map((code) => ({ code, name: wallName(code), sides: [pat[(code - 1) * 2], pat[(code - 1) * 2 + 1]] }));
}

/** The pose's view direction and its two field-of-view edges, for the mini plan: unit-ish vectors (cells) of the centre ray and the left / right rays. */
export function viewerRays(pose) {
  const cx = COS[pose.a & 255] / 4096, cy = COS[(pose.a + 192) & 255] / 4096;
  const px = -cy * 0.578, py = cx * 0.578;                       // the camera plane (length 0.578: a 60 degree field of view), 90 degrees to the right
  return { centre: [cx, cy], left: [cx - px, cy - py], right: [cx + px, cy + py] };
}

export { PAT };
