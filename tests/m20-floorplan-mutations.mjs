"use strict";
// m20-floorplan-mutations.mjs -- mutation test of src/tools/floorplan-view.js (Studio completion stage 6, item C3: the floor plan preview's pure model): copies src/, tests/, the examples,
// the published runtimes and the built v2 / v3 / v4 runtimes to a temporary directory, applies ONE deliberate bug at a time to floorplan-view.js (comparison flips, off-by-one, swapped
// operands, removed guards, changed constants, && / ||) and runs the suite below; a mutation is KILLED when it fails.
//   node tests/m20-floorplan-mutations.mjs [name-fragment]     (about a second per mutant)
//   node tests/m20-floorplan-mutations.mjs --check             only verifies that every pattern occurs exactly once (and changes something)
//   node tests/m20-floorplan-mutations.mjs --shard=0/2         every second mutant (run the shards in parallel)
//   TMPDIR=<dir> to choose where the scratch copy lives.
// The test is tests/floorplan-view.mjs WHOLE, section 6 included (the picture against the real v4 runtime on the emulator, 36 poses): the whole file takes 0.6 s, so there is no cheaper subset
// to choose. A mutant whose name starts with "EQUIVALENT:" changes no behaviour anyone can observe (the name says why); it is expected to survive, is counted separately, and does not fail the run.
import { cpSync, mkdtempSync, readFileSync, writeFileSync, symlinkSync, rmSync, mkdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const only = args.find((a) => !a.startsWith('--'));
const shardArg = args.find((a) => a.startsWith('--shard='));
const [shardI, shardN] = shardArg ? shardArg.slice(8).split('/').map(Number) : [0, 1];
const TIMEOUT = 120000;                       // a mutant that loops is killed by the timeout
const E = (file, from, to) => ({ file, from, to });
const TESTS = ['tests/floorplan-view.mjs'];
const COPY_DIRS = ['src', 'tests', 'arcade/tests', 'arcade/tools', 'arcade/runtime', 'arcade/examples', 'arcade/dist'];     // what the test reads (section 6 builds the v4 runtime)
const BUILT_RUNTIMES = ['v4'];

const FV = 'src/tools/floorplan-view.js';
const MUTANTS = [
  // ---- constants ----
  ['constants: WALK.RAD 40 -> 41', [E(FV, '{ RAD: 40, SPD: 44 }', '{ RAD: 41, SPD: 44 }')]],
  ['constants: WALK.SPD 44 -> 45', [E(FV, '{ RAD: 40, SPD: 44 }', '{ RAD: 40, SPD: 45 }')]],
  ['constants: MIN_SIDE 4 -> 5', [E(FV, 'export const MIN_SIDE = 4;', 'export const MIN_SIDE = 5;')]],
  ['constants: MAX_SIDE 32 -> 31', [E(FV, 'export const MAX_SIDE = 32;', 'export const MAX_SIDE = 31;')]],
  ['constants: COLW_CHOICES [4, 2] -> [2, 4]', [E(FV, 'COLW_CHOICES = [4, 2]', 'COLW_CHOICES = [2, 4]')]],
  ['constants: DIRS.SE 32 -> 33', [E(FV, 'SE: 32,', 'SE: 33,')]],
  ['constants: DIRS.SW 96 -> 97', [E(FV, 'SW: 96,', 'SW: 97,')]],
  ['constants: DIRS.N 192 -> 191', [E(FV, 'N: 192,', 'N: 191,')]],
  ['constants: DEFAULT_ATTR 0x07 -> 0x38', [E(FV, 'DEFAULT_ATTR = 0x07;', 'DEFAULT_ATTR = 0x38;')]],
  ['wallName: the names are shifted', [E(FV, "['empty', 'wall 1', 'wall 2', 'wall 3', 'wall 4']", "['empty', 'wall 1', 'wall 2', 'wall 4', 'wall 3']")]],
  ['wallName: an unknown code is not "invalid"', [E(FV, "WALL_NAMES[code] ?? 'invalid'", "WALL_NAMES[code] ?? 'wall 4'")]],
  // ---- cellValue ----
  ['cellValue: 255 is a wall, not a blank', [E(FV, '|| v < 0 || v === 255 ? 0 :', '|| v < 0 ? 0 :')]],
  ['cellValue: 254 is a blank', [E(FV, 'v === 255 ? 0', 'v === 254 ? 0')]],
  ['cellValue: a negative cell is a wall (the blank rule gone)', [E(FV, '|| v < 0 || v === 255', '|| v < -300 || v === 255')]],
  ['EQUIVALENT: cellValue: codes above 4 read as 5 (raycast-ref loadMap clamps every code to 4 itself, so the min in embedMap is a second clamp)', [E(FV, 'Math.min(4, Math.floor(v))', 'Math.min(5, Math.floor(v))')]],
  ['cellValue: codes above 4 read as 3', [E(FV, 'Math.min(4, Math.floor(v))', 'Math.min(3, Math.floor(v))')]],
  ['cellValue: codes above 4 read as 0', [E(FV, 'v < 0 || v === 255 ? 0 : Math.min(4, Math.floor(v))', 'v < 0 || v === 255 || v > 4 ? 0 : Math.floor(v)')]],
  ['EQUIVALENT: cellValue: a non-finite cell is not mapped to 0 first (NaN goes through Math.min / Uint8Array.from and is stored as 0 either way)', [E(FV, '!Number.isFinite(v) || v < 0', 'v < 0')]],
  ['EQUIVALENT: cellValue: 0 itself taken as blank (<= 0): 0 and a blank are both 0', [E(FV, '|| v < 0 || v === 255', '|| v <= 0 || v === 255')]],
  // ---- angleOf ----
  ['angleOf: letters are case sensitive', [E(FV, 'DIRS[dir.toUpperCase()]', 'DIRS[dir]')]],
  ['angleOf: an unknown letter looks south', [E(FV, "DIRS[dir.toUpperCase()] ?? 0", "DIRS[dir.toUpperCase()] ?? 64")]],
  ['angleOf: a number is taken AND 127', [E(FV, 'Math.round(dir) & 255 : 0', 'Math.round(dir) & 127 : 0')]],
  ['angleOf: a number is not rounded', [E(FV, 'Math.round(dir) & 255', '(dir | 0) & 255')]],
  ['angleOf: something that is not a number looks south', [E(FV, 'Math.round(dir) & 255 : 0', 'Math.round(dir) & 255 : 64')]],
  // ---- embedMap ----
  ['embedMap: a 1,024-byte array is not passed through', [E(FV, 'map.length === 1024', 'map.length === 1025')]],
  ['embedMap: a Uint8Array of the right size is not taken as the runtime array', [E(FV, 'if (map instanceof Uint8Array && map.length === 1024)', 'if (map instanceof Array && map.length === 1024)')]],
  ['embedMap: a width of 4 is refused', [E(FV, 'w < MIN_SIDE ||', 'w <= MIN_SIDE ||')]],
  ['embedMap: a width of 32 is refused', [E(FV, 'w > MAX_SIDE ||', 'w >= MAX_SIDE ||')]],
  ['embedMap: a height of 4 is refused', [E(FV, 'h < MIN_SIDE ||', 'h <= MIN_SIDE ||')]],
  ['embedMap: a height of 32 is refused', [E(FV, 'h > MAX_SIDE ||', 'h >= MAX_SIDE ||')]],
  ['embedMap: a width of 3 is accepted', [E(FV, 'w < MIN_SIDE ||', 'w < MIN_SIDE - 1 ||')]],
  ['embedMap: a height of 33 is accepted', [E(FV, 'h > MAX_SIDE ||', 'h > MAX_SIDE + 1 ||')]],
  ['embedMap: exactly w * h cells are refused', [E(FV, 'map.cells.length < w * h', 'map.cells.length <= w * h')]],
  ['embedMap: too few cells are accepted', [E(FV, 'map.cells.length < w * h', 'map.cells.length < w * h - 1')]],
  ['embedMap: a map without cells is accepted', [E(FV, '!map || !map.cells || w < MIN_SIDE', '!map || w < MIN_SIDE')]],
  ['embedMap: the bad-size problem text names other limits', [E(FV, 'A floor plan is ${MIN_SIDE} to ${MAX_SIDE} cells wide and high.', 'A floor plan is ${MAX_SIDE} to ${MIN_SIDE} cells wide and high.')]],
  ['embedMap: the refused map is not ok', [E(FV, 'return { ok: false, array: new Uint8Array(1024).fill(1), problems: [`A floor plan', 'return { ok: true, array: new Uint8Array(1024).fill(1), problems: [`A floor plan')]],
  ['embedMap: the ring test needs both x and y on the edge', [E(FV, 'if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && cells[y * w + x] === 0) bad++;', 'if ((x === 0 && y === 0 || x === w - 1 && y === h - 1) && cells[y * w + x] === 0) bad++;')]],
  ['embedMap: the last column is not part of the ring', [E(FV, 'x === w - 1 || y === h - 1) && cells', 'x === w || y === h - 1) && cells')]],
  ['embedMap: the last row is not part of the ring', [E(FV, 'x === w - 1 || y === h - 1) && cells', 'x === w - 1 || y === h) && cells')]],
  ['embedMap: the first row is not part of the ring', [E(FV, '(x === 0 || y === 0 || x === w - 1', '(x === 0 || y === 1 || x === w - 1')]],
  ['embedMap: walls on the ring are counted', [E(FV, '&& cells[y * w + x] === 0) bad++', '&& cells[y * w + x] !== 0) bad++')]],
  ['embedMap: one empty ring cell is not reported', [E(FV, 'if (bad) problems.push', 'if (bad > 1) problems.push')]],
  ['embedMap: the plural is off by one', [E(FV, "cell${bad > 1 ? 's' : ''}", "cell${bad > 2 ? 's' : ''}")]],
  ['embedMap: the cells are read in the wrong order (x, y swapped)', [E(FV, 'cells[y * w + x] === 0) bad++', 'cells[x * h + y] === 0) bad++')]],
  ['embedMap: the loaded map is not encoded with its own width', [E(FV, 'loadMap(rleEncode(cells), w, h)', 'loadMap(rleEncode(cells), h, w)')]],
  ['embedMap: a width read as a float is not cut', [E(FV, 'const w = map?.w | 0, h = map?.h | 0', 'const w = map?.w, h = map?.h | 0')]],
  // ---- poseInWall, firstFreeCell ----
  ['EQUIVALENT: firstFreeCell: scans one row past the plan (the array is wall 1 outside w x h, and the ring of a 32-high plan, so no cell there is 0)', [E(FV, 'cy < map.h; cy++', 'cy <= map.h; cy++')]],
  ['EQUIVALENT: firstFreeCell: scans one column past the plan (the array is wall 1 outside w x h; for a 32-wide plan the next index is the next row\'s ring cell, which is wall 1)', [E(FV, 'cx < map.w; cx++', 'cx <= map.w; cx++')]],
  ['firstFreeCell: returns the first wall', [E(FV, 'array[cy * 32 + cx] === 0) return', 'array[cy * 32 + cx] !== 0) return')]],
  ['firstFreeCell: reads with the map width as the stride', [E(FV, 'array[cy * 32 + cx] === 0) return', 'array[cy * map.w + cx] === 0) return')]],
  ['firstFreeCell: scans columns first', [E(FV, 'for (let cy = 0; cy < map.h; cy++) for (let cx = 0; cx < map.w; cx++) if', 'for (let cx = 0; cx < map.w; cx++) for (let cy = 0; cy < map.h; cy++) if')]],
  ['firstFreeCell: a bad map still scans', [E(FV, 'if (!ok) return null;', 'if (false) return null;')]],
  ['poseInWall: reads the map without embedding it', [E(FV, 'wallAt(embedMap(map).array, pose.x, pose.y);', 'wallAt(map.cells, pose.x, pose.y);')]],
  // ---- normalisePose ----
  ['normalisePose: x is clamped to w * 256', [E(FV, 'clampPos(pose.x | 0, w * 256 - 1)', 'clampPos(pose.x | 0, w * 256)')]],
  ['normalisePose: y is clamped to h * 256', [E(FV, 'clampPos(pose.y | 0, h * 256 - 1)', 'clampPos(pose.y | 0, h * 256)')]],
  ['normalisePose: y is clamped by the width', [E(FV, 'clampPos(pose.y | 0, h * 256 - 1)', 'clampPos(pose.y | 0, w * 256 - 1)')]],
  ['normalisePose: x is clamped by the height', [E(FV, 'clampPos(pose.x | 0, w * 256 - 1)', 'clampPos(pose.x | 0, h * 256 - 1)')]],
  ['normalisePose: the angle is taken AND 127', [E(FV, 'a: (pose.a | 0) & 255 }', 'a: (pose.a | 0) & 127 }')]],
  ['normalisePose: the angle is not wrapped', [E(FV, 'a: (pose.a | 0) & 255 }', 'a: (pose.a | 0) }')]],
  ['normalisePose: a map without a size is 16 cells wide', [E(FV, 'const w = map?.w ?? 32, h = map?.h ?? 32;', 'const w = map?.w ?? 16, h = map?.h ?? 32;')]],
  ['EQUIVALENT: normalisePose: a position is not cut to an integer first (clampPos\'s s16 does (v << 16) >> 16, which cuts it)', [E(FV, 'clampPos(pose.x | 0,', 'clampPos(pose.x,')]],
  // ---- placeViewer ----
  ['placeViewer: cell 0 is refused', [E(FV, 'cx < 0 || cy < 0 ||', 'cx <= 0 || cy < 0 ||')]],
  ['placeViewer: row 0 is refused', [E(FV, 'cx < 0 || cy < 0 ||', 'cx < 0 || cy <= 0 ||')]],
  ['placeViewer: the cell at x = w is accepted', [E(FV, 'cx >= map.w || cy >= map.h', 'cx > map.w || cy >= map.h')]],
  ['placeViewer: the cell at y = h is accepted', [E(FV, 'cx >= map.w || cy >= map.h', 'cx >= map.w || cy > map.h')]],
  ['placeViewer: a fractional cell is accepted', [E(FV, '!Number.isInteger(cx) || !Number.isInteger(cy) ||', '')]],
  ['placeViewer: the wall check is skipped', [E(FV, '  if (code) {\n    const own', '  if (false) {\n    const own')]],
  ['placeViewer: the centre of the cell is x * 256 + 127', [E(FV, 'x: cx * 256 + 128,', 'x: cx * 256 + 127,')]],
  ['placeViewer: the centre of the cell is y * 256 + 129', [E(FV, 'y: cy * 256 + 128,', 'y: cy * 256 + 129,')]],
  ['placeViewer: x and y swapped', [E(FV, 'x: cx * 256 + 128, y: cy * 256 + 128', 'x: cy * 256 + 128, y: cx * 256 + 128')]],
  ['placeViewer: the default direction is south', [E(FV, 'function placeViewer(map, cx, cy, dir = 0)', 'function placeViewer(map, cx, cy, dir = 64)')]],
  ['placeViewer: a wall inside the plan is called the outer ring', [E(FV, 'const own = cellValue(map.cells[cy * map.w + cx]);', 'const own = 0;')]],
  ['placeViewer: the wall name is not given', [E(FV, '(${wallName(own)}): the viewer needs an empty cell.`', '(${own}): the viewer needs an empty cell.`')]],
  ['placeViewer: the refused place has no message of the ring', [E(FV, 'on the outer ring, which the runtime treats as wall', 'in a corner')]],
  ['placeViewer: the cell is read with the wrong stride', [E(FV, 'const code = e.array[cy * 32 + cx];', 'const code = e.array[cy * map.w + cx];')]],
  // ---- turnPose ----
  ['turnPose: the turn is subtracted', [E(FV, 'a: (pose.a + delta) & 255', 'a: (pose.a - delta) & 255')]],
  ['turnPose: the angle is not wrapped', [E(FV, 'a: (pose.a + delta) & 255', 'a: (pose.a + delta)')]],
  ['turnPose: the angle is wrapped at 128', [E(FV, 'a: (pose.a + delta) & 255', 'a: (pose.a + delta) & 127')]],
  ['turnPose: the position is lost', [E(FV, '({ x: pose.x, y: pose.y, a: (pose.a + delta) & 255 })', '({ x: 0, y: pose.y, a: (pose.a + delta) & 255 })')]],
  // ---- stepPose ----
  ['stepPose: the default step is 0', [E(FV, 'function stepPose(map, pose, dist = WALK.SPD, rad = WALK.RAD)', 'function stepPose(map, pose, dist = 0, rad = WALK.RAD)')]],
  ['stepPose: the default radius is 0', [E(FV, 'function stepPose(map, pose, dist = WALK.SPD, rad = WALK.RAD)', 'function stepPose(map, pose, dist = WALK.SPD, rad = 0)')]],
  ['stepPose: x moves by the sine', [E(FV, 'const nx = x + fxmul(c, dist);', 'const nx = x + fxmul(s, dist);')]],
  ['stepPose: y moves by the cosine', [E(FV, 'const ny = y + fxmul(s, dist);', 'const ny = y + fxmul(c, dist);')]],
  ['stepPose: x moves the wrong way', [E(FV, 'const nx = x + fxmul(c, dist);', 'const nx = x - fxmul(c, dist);')]],
  ['stepPose: y moves the wrong way', [E(FV, 'const ny = y + fxmul(s, dist);', 'const ny = y - fxmul(s, dist);')]],
  ['stepPose: the x leading edge is on the trailing side', [E(FV, 'const f = nx > x ? nx + rad : nx - rad;', 'const f = nx > x ? nx - rad : nx + rad;')]],
  ['stepPose: the y leading edge is on the trailing side', [E(FV, 'const f = ny > y ? ny + rad : ny - rad;', 'const f = ny > y ? ny - rad : ny + rad;')]],
  ['stepPose: the x leading edge is the centre', [E(FV, 'const f = nx > x ? nx + rad : nx - rad;', 'const f = nx;')]],
  ['stepPose: only one x corner is tested (the upper)', [E(FV, 'if (wallAt(arr, f, y - rad) === 0 && wallAt(arr, f, y + rad) === 0) { x = nx;', 'if (wallAt(arr, f, y - rad) === 0) { x = nx;')]],
  ['stepPose: only one x corner is tested (the lower)', [E(FV, 'if (wallAt(arr, f, y - rad) === 0 && wallAt(arr, f, y + rad) === 0) { x = nx;', 'if (wallAt(arr, f, y + rad) === 0) { x = nx;')]],
  ['stepPose: either x corner may be free', [E(FV, 'if (wallAt(arr, f, y - rad) === 0 && wallAt(arr, f, y + rad) === 0) { x = nx;', 'if (wallAt(arr, f, y - rad) === 0 || wallAt(arr, f, y + rad) === 0) { x = nx;')]],
  ['stepPose: only one y corner is tested (the left)', [E(FV, 'if (wallAt(arr, x - rad, f) === 0 && wallAt(arr, x + rad, f) === 0) { y = ny;', 'if (wallAt(arr, x - rad, f) === 0) { y = ny;')]],
  ['stepPose: only one y corner is tested (the right)', [E(FV, 'if (wallAt(arr, x - rad, f) === 0 && wallAt(arr, x + rad, f) === 0) { y = ny;', 'if (wallAt(arr, x + rad, f) === 0) { y = ny;')]],
  ['stepPose: either y corner may be free', [E(FV, 'if (wallAt(arr, x - rad, f) === 0 && wallAt(arr, x + rad, f) === 0) { y = ny;', 'if (wallAt(arr, x - rad, f) === 0 || wallAt(arr, x + rad, f) === 0) { y = ny;')]],
  ['stepPose: y is tested against the old x', [E(FV, 'wallAt(arr, x - rad, f) === 0 && wallAt(arr, x + rad, f) === 0) { y = ny;', 'wallAt(arr, pose.x - rad, f) === 0 && wallAt(arr, pose.x + rad, f) === 0) { y = ny;')]],
  ['stepPose: x is not marked as moved', [E(FV, '{ x = nx; moved.x = true; }', '{ x = nx; }')]],
  ['stepPose: y is not marked as moved', [E(FV, '{ y = ny; moved.y = true; }', '{ y = ny; }')]],
  ['stepPose: x moves although a wall is there', [E(FV, '{ x = nx; moved.x = true; }', '{ moved.x = true; }')]],
  ['stepPose: y moves although a wall is there', [E(FV, '{ y = ny; moved.y = true; }', '{ moved.y = true; }')]],
  ['stepPose: blocked needs only one axis to fail', [E(FV, 'blocked: !moved.x && !moved.y', 'blocked: !moved.x || !moved.y')]],
  ['stepPose: blocked is never true', [E(FV, 'blocked: !moved.x && !moved.y', 'blocked: false')]],
  ['stepPose: the angle is changed', [E(FV, 'pose: { x, y, a: pose.a }, moved', 'pose: { x, y, a: 0 }, moved')]],
  ['stepPose: a zero x step still tests the walls', [E(FV, 'if (nx !== x) {', 'if (true) {')]],
  ['stepPose: a zero y step still tests the walls', [E(FV, 'if (ny !== y) {', 'if (true) {')]],
  // ---- attrColours ----
  ['attrColours: BRIGHT is bit 7', [E(FV, '(attr & 0x40) ? 8 : 0', '(attr & 0x80) ? 8 : 0')]],
  ['attrColours: BRIGHT adds 7', [E(FV, '(attr & 0x40) ? 8 : 0', '(attr & 0x40) ? 7 : 0')]],
  ['attrColours: ink is 2 bits', [E(FV, 'ink = attr & 7,', 'ink = attr & 3,')]],
  ['attrColours: paper is bits 2..4', [E(FV, 'paper = (attr >> 3) & 7;', 'paper = (attr >> 2) & 7;')]],
  ['attrColours: paper is 2 bits', [E(FV, 'paper = (attr >> 3) & 7;', 'paper = (attr >> 3) & 3;')]],
  ['attrColours: ink and paper swapped', [E(FV, 'return { ink: rgb(ink), paper: rgb(paper) };', 'return { ink: rgb(paper), paper: rgb(ink) };')]],
  ['attrColours: bright black is a bright palette entry', [E(FV, 'PALETTE[c === 0 ? 0 : c + b]', 'PALETTE[c + b]')]],
  // ---- render ----
  ['render: a column width of 3 is accepted', [E(FV, 'if (colw !== 4 && colw !== 2) return', 'if (colw !== 4 && colw !== 2 && colw !== 3) return')]],
  ['render: a column width of 2 is refused', [E(FV, 'if (colw !== 4 && colw !== 2) return', 'if (colw !== 4) return')]],
  ['render: the default column width is 2', [E(FV, 'export function render(map, pose0, colw = 4, opts = {})', 'export function render(map, pose0, colw = 2, opts = {})')]],
  ['render: a bad map does not stop the render', [E(FV, 'if (!e.ok) return { ok: false, message: e.problems[0], problems: e.problems };', 'if (false) return { ok: false, message: e.problems[0], problems: e.problems };')]],
  ['render: the pose is not normalised', [E(FV, 'const pose = normalisePose(map, pose0);', 'const pose = pose0;')]],
  ['render: the custom patterns are ignored', [E(FV, 'patsOf(opts.patterns ?? null)', 'patsOf(null)')]],
  ['render: the window is read one row down', [E(FV, 'rowAddr(VIEW.Y0 + r)', 'rowAddr(VIEW.Y0 + r + 1)')]],
  ['render: the window is read one byte right', [E(FV, 'VIEW.X0 + k]', 'VIEW.X0 + k + 1]')]],
  ['render: window rows are 15 bytes apart', [E(FV, 'window_[r * 16 + k] = v;', 'window_[r * 15 + k] = v;')]],
  ['render: the pixels are mirrored', [E(FV, '(v >> (7 - b)) & 1;', '(v >> b) & 1;')]],
  ['render: a pixel is 7 columns wide', [E(FV, 'pixels[r * VIEW.W + k * 8 + b]', 'pixels[r * VIEW.W + k * 7 + b]')]],
  ['render: inWall is inverted', [E(FV, 'inWall: wallAt(e.array, pose.x, pose.y) !== 0,', 'inWall: wallAt(e.array, pose.x, pose.y) === 0,')]],
  ['render: inWall is tested at the unclamped pose', [E(FV, 'inWall: wallAt(e.array, pose.x, pose.y) !== 0,', 'inWall: wallAt(e.array, pose0.x, pose0.y) !== 0,')]],
  ['render: the problems of the map are lost', [E(FV, 'window: window_, pixels, problems: e.problems };', 'window: window_, pixels, problems: [] };')]],
  ['render: the display file is the wrong size', [E(FV, 'const bitmap = new Uint8Array(6144);', 'const bitmap = new Uint8Array(6143);')]],
  ['render: a cast failure is not caught', [E(FV, 'try { cast = castFrame(e.array, pose, colw); } catch (err) {', 'try { cast = castFrame(e.array, pose, colw); } catch (err) { throw err;')]],
  // ---- rgba ----
  ['rgba: the ceiling takes 47 rows', [E(FV, 'i < VIEW.W * 48 ? top', 'i < VIEW.W * 47 ? top')]],
  ['rgba: the ceiling takes 49 rows', [E(FV, 'i < VIEW.W * 48 ? top', 'i < VIEW.W * 49 ? top')]],
  ['rgba: the floor takes the top attribute', [E(FV, 'attrColours(opts.bottom ?? DEFAULT_ATTR)', 'attrColours(opts.top ?? DEFAULT_ATTR)')]],
  ['rgba: the ceiling takes the bottom attribute', [E(FV, 'const top = attrColours(opts.top ?? DEFAULT_ATTR)', 'const top = attrColours(opts.bottom ?? DEFAULT_ATTR)')]],
  ['rgba: ink and paper swapped', [E(FV, 'result.pixels[i] ? c.ink : c.paper', 'result.pixels[i] ? c.paper : c.ink')]],
  ['rgba: the picture is transparent', [E(FV, 'out[i * 4 + 3] = 255;', 'out[i * 4 + 3] = 254;')]],
  ['rgba: the green and blue channels swapped', [E(FV, 'out[i * 4 + 1] = rgb[1]; out[i * 4 + 2] = rgb[2];', 'out[i * 4 + 1] = rgb[2]; out[i * 4 + 2] = rgb[1];')]],
  ['rgba: the default attribute is not used for a missing top', [E(FV, 'attrColours(opts.top ?? DEFAULT_ATTR)', 'attrColours(opts.top ?? 0)')]],
  // ---- legend, viewerRays ----
  ['legend: the second side is the first', [E(FV, 'pat[(code - 1) * 2 + 1]', 'pat[(code - 1) * 2]')]],
  ['legend: the sides of the codes overlap', [E(FV, 'sides: [pat[(code - 1) * 2], pat[(code - 1) * 2 + 1]]', 'sides: [pat[(code - 1)], pat[(code - 1) * 2 + 1]]')]],
  ['legend: only three codes', [E(FV, '[1, 2, 3, 4].map((code)', '[1, 2, 3].map((code)')]],
  ['legend: the game patterns are ignored', [E(FV, 'patsOf(patterns ?? null);\n  return [1', 'patsOf(null);\n  return [1')]],
  ['viewerRays: the centre uses the sine for x', [E(FV, 'const cx = COS[pose.a & 255] / 4096', 'const cx = COS[(pose.a + 64) & 255] / 4096')]],
  ['viewerRays: y looks the wrong way', [E(FV, 'COS[(pose.a + 192) & 255] / 4096', 'COS[(pose.a + 64) & 255] / 4096')]],
  ['viewerRays: the field of view is 0.5', [E(FV, 'const px = -cy * 0.578, py = cx * 0.578;', 'const px = -cy * 0.5, py = cx * 0.578;')]],
  ['viewerRays: the camera plane is not perpendicular', [E(FV, 'const px = -cy * 0.578, py = cx * 0.578;', 'const px = cy * 0.578, py = cx * 0.578;')]],
  ['viewerRays: left and right swapped', [E(FV, 'left: [cx - px, cy - py], right: [cx + px, cy + py]', 'left: [cx + px, cy + py], right: [cx - px, cy - py]')]],
  ['viewerRays: the angle is not wrapped', [E(FV, 'COS[pose.a & 255] / 4096', 'COS[pose.a] / 4096')]],
];

// ---- the driver (the same in the four m20 suites) -------------------------------------------------------------------------------------------------------
if (checkOnly) {
  let bad = 0;
  for (const [name, edits] of MUTANTS) {
    for (const e of edits) {
      const n = readFileSync(join(ROOT, e.file), 'utf8').split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad++; }
      else if (e.from === e.to) { console.log(`  ?? ${name}: the mutation changes nothing`); bad++; }
    }
  }
  const names = new Set(MUTANTS.map((m) => m[0]));
  if (names.size !== MUTANTS.length) { console.log('  ?? two mutants have the same name'); bad++; }
  console.log(bad ? `${bad} pattern(s) not found exactly once` : `all ${MUTANTS.length} mutants' patterns occur exactly once`);
  process.exit(bad ? 1 : 0);
}

// One scratch copy (what the tests read) per run; each mutant rewrites the module in it and the original text is put back after the run.
function makeRoot(tmp) {
  const root = join(tmp, 'root');
  for (const d of COPY_DIRS) { mkdirSync(join(root, d), { recursive: true }); cpSync(join(ROOT, d), join(root, d), { recursive: true }); }
  for (const v of BUILT_RUNTIMES) for (const f of ['runtime.json', 'runtime.bin']) {          // the built runtimes the machine tests boot
    if (!existsSync(join(ROOT, 'arcade/build', v, f))) continue;
    mkdirSync(join(root, 'arcade/build', v), { recursive: true });
    cpSync(join(ROOT, 'arcade/build', v, f), join(root, 'arcade/build', v, f));
  }
  symlinkSync(join(ROOT, 'tsrun'), join(root, 'tsrun'));
  return root;
}
const runTests = (root) => {
  for (const t of TESTS) {
    const r = spawnSync('node', [join(root, t)], { encoding: 'utf8', timeout: TIMEOUT, env: { ...process.env, ARCADE_QUICK: '1' }, cwd: root });
    const out = (r.stdout ?? '') + (r.stderr ?? '');
    if (r.status !== 0 || r.error) return { t, out, error: r.error };
  }
  return null;
};

const tmp = mkdtempSync(join(tmpdir(), 'm20mut-'));
let killed = 0;
const survived = [], equivalent = [], broken = [];
try {
  const root = makeRoot(tmp);
  // The unmutated tests must pass first, else every "kill" would be the tests' own failure.
  if (!only && shardI === 0 || args.includes('--baseline')) {
    const f = runTests(root);
    if (f) {
      console.log(`  BASELINE FAILS: ${f.t} fails without any mutation; fix it before trusting the kills${f.error ? ` (${f.error.message})` : ''}`);
      for (const l of (f.out.match(/^.*FAIL.*$/gm) ?? f.out.split('\n').filter(Boolean).slice(-5)).slice(0, 8)) console.log('    ' + l.slice(0, 300));
      process.exit(2);
    }
  }
  for (const [mi, [name, edits]] of MUTANTS.entries()) {
    if (only && !name.includes(only)) continue;
    if (mi % shardN !== shardI) continue;
    const originals = new Map();
    let bad = false;
    for (const e of edits) {
      const p = join(root, e.file);
      if (!originals.has(p)) originals.set(p, readFileSync(p, 'utf8'));
      const src = readFileSync(p, 'utf8');
      const n = src.split(e.from).length - 1;
      if (n !== 1) { console.log(`  ?? ${name}: pattern found ${n} times in ${e.file}`); bad = true; break; }
      writeFileSync(p, src.replace(e.from, () => e.to));
    }
    let failed = null;
    if (!bad) failed = runTests(root);
    for (const [p, text] of originals) writeFileSync(p, text);
    if (bad) { broken.push(name); continue; }
    if (failed) {
      killed++;
      const why = failed.error ? 'timed out / did not run' : ((failed.out.match(/FAIL  .*/g) ?? [failed.out.split('\n').filter(Boolean).pop()])[0] ?? '').slice(0, 110);
      console.log(`  killed       ${name}  <- ${failed.t.replace('tests/', '')}: ${why}`);
    }
    else if (name.startsWith('EQUIVALENT:')) { equivalent.push(name); console.log(`  equivalent   ${name}  (survived, as expected)`); }
    else { survived.push(name); console.log(`  SURVIVED     ${name}`); }
  }
} finally { rmSync(tmp, { recursive: true, force: true }); }
const ran = killed + survived.length + equivalent.length + broken.length;
console.log(`\n${ran} mutants run: ${killed} killed, ${equivalent.length} equivalent (expected to survive), ${survived.length} survived${broken.length ? `, ${broken.length} with a bad pattern` : ''}`);
for (const s of survived) console.log('  survivor: ' + s);
process.exit(survived.length || broken.length ? 1 : 0);
