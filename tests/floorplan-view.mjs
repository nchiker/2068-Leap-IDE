"use strict";
// floorplan-view.mjs -- tests for src/tools/floorplan-view.js and src/tools/raycast-ref.js (the Studio's floor plan 3D preview: pure model).
//   node tests/floorplan-view.mjs        (FPV_NOEMU=1 skips section 6, the comparison with the real v4 runtime on the emulator)
//
// Sections
//   1  raycast-ref.js is what arcade/tests/m8-common.mjs re-exports (the same functions and tables, not copies)
//   2  embedMap: the runtime's 32 x 32 array (smaller maps, the outer ring, codes above 4, blanks, bad sizes) equals the compiler's convertViewMap
//   3  render() equals the reference (castFrame + drawWalls on loadMap) byte for byte: Vaults, a 32 x 32 room, a corridor, small maps, colw 4 and 2
//   4  the picture itself: window / pixels / rgba / attribute colours, patterns, inside-a-wall
//   5  placeViewer, turnPose, stepPose (Vaults' rule), firstFreeCell, legend, viewerRays
//   6  THE REAL CHECK: the preview's picture equals the screen the real v4 runtime draws on the emulator, for the same map and pose
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as REF from '../src/tools/raycast-ref.js';
import * as V from '../src/tools/floorplan-view.js';
import { convertViewMap } from '../src/lang/arcade/arcade-view.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  cond ? passed++ : failed++;
  return cond;
};
const info = (s) => console.log('  INFO  ' + s);
const eqBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
const diffAt = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// ---- the maps -------------------------------------------------------------------------------------------------------------------
const ring = (w, h, f) => Array.from({ length: w * h }, (_, i) => { const x = i % w, y = (i / w) | 0; return x === 0 || y === 0 || x === w - 1 || y === h - 1 ? ((x + y) % 4) + 1 : f(x, y); });
const vaults = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/vaults.assets.json'), 'utf8')).maps.vl_maze;
const MAPS = {
  vaults: { w: vaults.w, h: vaults.h, cells: vaults.cells },
  room32: { w: 32, h: 32, cells: ring(32, 32, (x, y) => (x % 8 === 4 && y % 8 === 4 ? ((x + y) % 4) + 1 : 0)) },
  corridor: { w: 20, h: 5, cells: ring(20, 5, (x, y) => (y === 2 && x % 6 === 3 ? 2 : 0)) },
  small: { w: 6, h: 5, cells: ring(6, 5, (x, y) => (x === 3 && y === 2 ? 4 : 0)) },
  mid: { w: 10, h: 7, cells: ring(10, 7, (x, y) => (x === 5 && y > 1 && y < 6 ? 3 : (x === 2 && y === 3 ? 4 : 0))) },
  tall: { w: 5, h: 31, cells: ring(5, 31, (x, y) => (y % 5 === 0 ? 2 : 0)) },
};
const arrayOf = (m) => REF.loadMap(REF.rleEncode(m.cells), m.w, m.h);
const empty = (m) => { const a = arrayOf(m), out = []; for (let y = 0; y < m.h; y++) for (let x = 0; x < m.w; x++) if (!a[y * 32 + x]) out.push([x, y]); return out; };
/** n poses inside empty cells: fractions, angles at random (a few axis-aligned, a few exactly on a cell edge) */
function poses(m, n, seed) {
  const r = rng(seed), cells = empty(m), out = [];
  for (let i = 0; i < n; i++) {
    const [cx, cy] = cells[Math.floor(r() * cells.length)];
    const fx = r() < 0.15 ? 0 : Math.floor(r() * 256), fy = r() < 0.15 ? 0 : Math.floor(r() * 256);
    out.push({ x: cx * 256 + fx, y: cy * 256 + fy, a: r() < 0.2 ? [0, 64, 128, 192][Math.floor(r() * 4)] : Math.floor(r() * 256) });
  }
  return out;
}
console.log('Floor plan preview: the model\n');

// ==================================================================================================================
console.log('1. raycast-ref.js is the reference of the runtime tests');
{
  const R = await import('../arcade/tests/m8-common.mjs').catch((e) => ({ error: e }));
  if (R.error) check('arcade/tests/m8-common.mjs loads', false, String(R.error.message));
  else {
    const names = ['s16', 'u16', 'Q', 'COS', 'SIN', 'RECIP', 'HGT', 'PAT', 'mulP', 'stepOf', 'cosa8', 'sina8', 'fxmul', 'VIEW', 'rleEncode', 'loadMap', 'wallAt', 'setWall',
      'clampPos', 'axisRef', 'frameSetup', 'castPos', 'castFrame', 'colMask', 'drawWalls', 'patsOf'];
    const notSame = names.filter((n) => R[n] !== REF[n]);
    check(`m8-common re-exports the ${names.length} names of raycast-ref.js (the same objects, not copies)`, notSame.length === 0, notSame.join(','));
    check('rowAddr of raycast-ref.js is the display file layout of the runtime tests', Array.from({ length: 192 }, (_, y) => y).every((y) => REF.rowAddr(y) === R.rowAddr(y)));
  }
}

// ==================================================================================================================
console.log('\n2. embedMap');
{
  for (const [name, m] of Object.entries(MAPS)) {
    const e = V.embedMap(m), c = convertViewMap(m);
    check(`${name} (${m.w} x ${m.h}): the array equals the compiler's convertViewMap().ram (stride 32, outside = wall 1) and has no problems`, e.ok && eqBytes(e.array, c.ram) && e.problems.length === 0);
  }
  const m = { w: 6, h: 4, cells: [1, 1, 1, 1, 1, 9, 1, 0, 0, 0, -1, 1, 1, 255, 0, 0, 0, 1, 1, 1, 1, 1, 0, 1] };
  const e = V.embedMap(m);
  check('a code above 4 reads as 4, a blank (-1, 255) as empty', e.array[0 * 32 + 5] === 4 && e.array[1 * 32 + 4] === 0 && e.array[2 * 32 + 1] === 0 && e.array[1 * 32 + 3] === 0);
  check('empty cells on the outer ring are reported (3: row 2 column 0 is 1, ... counted) and read as wall by the runtime', e.problems.length === 1 && /outer ring/.test(e.problems[0]) && e.array[2 * 32 + 5] === 1);
  check('cells outside w x h are wall 1', e.array[0 * 32 + 6] === 1 && e.array[4 * 32 + 0] === 1 && e.array[31 * 32 + 31] === 1);
  for (const bad of [{ w: 3, h: 8, cells: new Array(24).fill(1) }, { w: 33, h: 8, cells: new Array(264).fill(1) }, { w: 8, h: 8, cells: [1, 2] }, null]) {
    const r = V.embedMap(bad);
    check(`embedMap refuses ${bad ? `${bad.w} x ${bad.h} with ${bad.cells.length} cells` : 'no map'}`, r.ok === false && r.problems.length === 1 && V.render(bad, { x: 256, y: 256, a: 0 }).ok === false);
  }
  const arr = new Uint8Array(1024).fill(1);
  check('a 1,024-byte array is taken as it is', V.embedMap(arr).array === arr);
}

// ==================================================================================================================
console.log('\n3. render() equals the reference, byte for byte');
for (const [name, m] of Object.entries(MAPS)) {
  for (const colw of [4, 2]) {
    const list = poses(m, 40, 100 + colw + m.w);
    let bad = 0, first = null, lit = 0;
    for (const pose of list) {
      const exp = new Uint8Array(6144), cast = REF.castFrame(arrayOf(m), pose, colw);
      REF.drawWalls(exp, cast);
      const got = V.render(m, pose, colw);
      let ok = got.ok && eqBytes(got.bitmap, exp) && eqBytes(got.cast.hh, cast.hh) && eqBytes(got.cast.pi, cast.pi) && eqBytes(got.cast.dist, cast.dist);
      if (ok) for (let r = 0; r < 96 && ok; r++) for (let k = 0; k < 16; k++) if (got.window[r * 16 + k] !== exp[REF.rowAddr(48 + r) + 8 + k]) { ok = false; break; }
      if (!ok) { bad++; first ??= JSON.stringify(pose); }
      lit += got.ok ? got.pixels.reduce((s, v) => s + v, 0) : 0;
    }
    check(`${name} (${m.w} x ${m.h}), colw ${colw}: ${list.length} poses, bitmap, window and ray arrays equal the reference`, bad === 0 && lit > 0, first ? `first bad pose ${first}` : `${lit} ink pixels in all`);
  }
}
{
  // a pose clamped into the map (RT_VIEW) and the caster's own clamp (the outer ring): no throw, the same picture as the clamped pose
  const m = MAPS.mid;
  const out = V.render(m, { x: -500, y: 30000, a: 300 }, 4), clamped = V.render(m, { x: 0, y: m.h * 256 - 1, a: 44 }, 4);
  check('a pose outside the map is clamped as RT_VIEW does (and the angle taken AND 255): the picture of the clamped pose', out.ok && out.pose.x === 0 && out.pose.y === m.h * 256 - 1 && out.pose.a === 44 && eqBytes(out.bitmap, clamped.bitmap));
  const all = [];
  for (const [name, mm] of Object.entries(MAPS)) for (let a = 0; a < 256; a += 5) all.push(V.render(mm, { x: 1 * 256 + 128, y: 1 * 256 + 128, a }, 4).ok);
  check('a viewer in the corner cell of every map, every 5th angle: always drawn (no ray leaves the array)', all.every(Boolean), `${all.length} renders`);
  check('colw 3 is refused', V.render(m, { x: 384, y: 384, a: 0 }, 3).ok === false);
}

// ==================================================================================================================
console.log('\n4. The picture: pixels, colours, patterns');
{
  const m = MAPS.small, res = V.render(m, V.placeViewer(m, 1, 1, 'E').pose, 4);
  check('window is 96 rows of 16 bytes and pixels 128 x 96 of 0 / 1; pixels are the bits of the window, left pixel = bit 7', res.window.length === 1536 && res.pixels.length === 12288 &&
    res.pixels.every((v, i) => v === ((res.window[((i / 128) | 0) * 16 + ((i % 128) >> 3)] >> (7 - (i % 8))) & 1)));
  const col = (x) => Array.from({ length: 96 }, (_, r) => res.pixels[r * 128 + x]);
  check('the centre of the view is wall pattern: the vertical middle of a column has ink; the top row of the view (a far wall at 3 cells is not that tall) has none', col(64).slice(40, 56).some(Boolean) && col(64)[0] === 0);
  const img = V.rgba(res, { top: 0x45, bottom: 0x0E });
  check('rgba: 128 x 96 x 4 bytes, opaque; ink / paper from the attribute bytes of the ceiling (top 48 rows) and the floor', img.length === 49152 && img.every((v, i) => i % 4 !== 3 || v === 255) &&
    (() => { const t = V.attrColours(0x45), b = V.attrColours(0x0E); const px = (x, y) => Array.from(img.slice((y * 128 + x) * 4, (y * 128 + x) * 4 + 3)); const wall = res.pixels[48 * 128 + 64] === 1;
      return JSON.stringify(px(0, 0)) === JSON.stringify(res.pixels[0] ? t.ink : t.paper) && JSON.stringify(px(0, 95)) === JSON.stringify(res.pixels[95 * 128] ? b.ink : b.paper) && typeof wall === 'boolean'; })());
  check('attrColours: $07 white on black, $47 bright white, $0E paper 1 ink 6 (yellow on blue), black stays black when bright', JSON.stringify(V.attrColours(0x07)) === JSON.stringify({ ink: [204, 204, 204], paper: [0, 0, 0] }) &&
    JSON.stringify(V.attrColours(0x47)) === JSON.stringify({ ink: [255, 255, 255], paper: [0, 0, 0] }) && JSON.stringify(V.attrColours(0x0E).paper) === JSON.stringify([0, 0, 204]) && JSON.stringify(V.attrColours(0x4E).ink) === JSON.stringify([255, 255, 51]) &&
    JSON.stringify(V.attrColours(0x40).ink) === JSON.stringify([0, 0, 0]));
  // the wall CODE decides the pattern: the same room with its walls 1 / 2 / 3 / 4 gives four different pictures, each drawn with its two patterns by side
  const rooms = [1, 2, 3, 4].map((code) => ({ w: 8, h: 8, cells: Array.from({ length: 64 }, (_, i) => { const x = i % 8, y = (i / 8) | 0; return x === 0 || y === 0 || x === 7 || y === 7 ? code : 0; }) }));
  const pics = rooms.map((r) => V.render(r, { x: 3 * 256 + 128, y: 3 * 256 + 128, a: 20 }, 4));
  const distinct = new Set(pics.map((p) => Buffer.from(p.bitmap).toString('base64')));
  check('the same room with wall code 1, 2, 3 and 4 gives four different pictures', distinct.size === 4);
  const pat = [0, 1, 2, 3].map((c) => new Set(Array.from(pics[c].cast.pi)));
  check('the pattern index of a ray is (code - 1) * 2 + side', pat.every((s, c) => [...s].every((pi) => (pi >> 1) === c)));
  const own = Array.from({ length: 16 }, (_, i) => (i % 2 ? 0x0F : 0xF0)), custom = V.render(rooms[0], { x: 3 * 256 + 128, y: 3 * 256 + 128, a: 20 }, 4, { patterns: own });
  const refB = new Uint8Array(6144); REF.drawWalls(refB, REF.castFrame(arrayOf(rooms[0]), { x: 3 * 256 + 128, y: 3 * 256 + 128, a: 20 }, 4), REF.patsOf(own));
  check('the game\'s own 16 pattern bytes are used (equal to drawWalls with patsOf)', eqBytes(custom.bitmap, refB) && !eqBytes(custom.bitmap, pics[0].bitmap));
  const inside = { w: 8, h: 8, cells: rooms[0].cells.slice() };
  const pose = V.placeViewer(inside, 3, 3, 'E').pose;
  inside.cells[3 * 8 + 3] = 2;
  const r2 = V.render(inside, pose, 4);
  check('a viewer left inside a wall (the map edited under it) is drawn without error and flagged', r2.ok && r2.inWall === true && V.poseInWall(inside, pose) === 2);
}

// ==================================================================================================================
console.log('\n5. placeViewer, turnPose, stepPose');
{
  const m = MAPS.mid;
  const p = V.placeViewer(m, 3, 3, 'S');
  check('placeViewer: the centre of the cell, the direction by letter (E 0, S 64, W 128, N 192)', p.ok && p.pose.x === 3 * 256 + 128 && p.pose.y === 3 * 256 + 128 && p.pose.a === 64 &&
    ['E', 'S', 'W', 'N'].map((d) => V.placeViewer(m, 3, 3, d).pose.a).join() === '0,64,128,192' && V.placeViewer(m, 3, 3, 300).pose.a === 44 && V.DIRS.NE === 224);
  const wall = V.placeViewer(m, 5, 3);
  check('a wall cell is refused with a message that names the cell and the wall', wall.ok === false && /Cell 5, 3 is a wall \(wall 3\)/.test(wall.message), wall.message);
  const rim = V.placeViewer(m, 0, 0);
  check('the outer ring is refused', rim.ok === false && /wall/.test(rim.message));
  check('outside the plan, a fraction and a bad size are refused', V.placeViewer(m, 10, 3).ok === false && V.placeViewer(m, -1, 3).ok === false && V.placeViewer(m, 1.5, 3).ok === false && V.placeViewer({ w: 2, h: 2, cells: [1, 1, 1, 1] }, 0, 0).ok === false);
  const open = { w: 6, h: 5, cells: ring(6, 5, () => 0).map((v, i) => (i === 6 ? 0 : v)) };       // cell (0, 1) empty on the ring
  const ringMsg = V.placeViewer(open, 0, 1);
  check('an empty cell on the plan\'s own outer ring is refused and the message says the runtime treats it as wall', ringMsg.ok === false && /outer ring/.test(ringMsg.message));
  check('turnPose wraps modulo 256, both ways, and keeps the position', V.turnPose({ x: 5, y: 6, a: 250 }, 8).a === 2 && V.turnPose({ x: 5, y: 6, a: 2 }, -8).a === 250 && V.turnPose({ x: 5, y: 6, a: 2 }, 8).x === 5);
  // stepping: forward in a room, stopped by the wall, sliding along it, back
  const room = { w: 8, h: 8, cells: ring(8, 8, () => 0) };
  let pose = V.placeViewer(room, 1, 3, 'E').pose, steps = 0;
  for (; steps < 100; steps++) { const r = V.stepPose(room, pose, 44); if (r.blocked) break; pose = r.pose; }
  check('walking east in a room stops at the wall: the box (radius 40) stays in the cell, x < 7 cells - 40', steps > 10 && steps < 40 && pose.x + V.WALK.RAD < 7 * 256 && pose.x + V.WALK.RAD + 44 >= 7 * 256 && pose.y === 3 * 256 + 128, `${steps} steps to x ${pose.x}`);
  const slide = V.stepPose(room, { x: pose.x, y: pose.y, a: 32 }, 44);                   // south-east: blocked east, free south
  check('walking south-east into the east wall slides south (x does not move, y does)', slide.moved.x === false && slide.moved.y === true && slide.pose.y > pose.y && !slide.blocked);
  const back = V.stepPose(room, { x: pose.x, y: pose.y, a: 0 }, -44);
  check('back is the opposite step', back.pose.x < pose.x && back.pose.y === pose.y && back.moved.x === true);
  const corner = V.stepPose(room, V.placeViewer(room, 1, 1, 'N').pose, 44 * 20);
  check('walking north out of the first row is blocked with no change', corner.blocked && corner.pose.y === 256 + 128);
  const rounds = V.stepPose(room, V.placeViewer(room, 3, 3, 'E').pose, 0);
  check('a step of 0 is blocked: nothing moves', rounds.blocked && rounds.pose.x === 3 * 256 + 128);
  // Vaults' MOVEPLAYER is the model: the same arithmetic as the example (WALL on the box corners, one axis at a time)
  {
    const arr = arrayOf(MAPS.vaults), s = V.placeViewer(MAPS.vaults, 2, 28, 34);
    let q = s.pose, mine = { ...q };
    for (let t = 0; t < 120; t++) {
      const c = REF.cosa8(q.a), sn = REF.sina8(q.a), sp = 44;
      let nx = q.x + REF.fxmul(c, sp), f = nx > q.x ? nx + 40 : nx - 40;
      if (REF.wallAt(arr, f, q.y - 40) === 0 && REF.wallAt(arr, f, q.y + 40) === 0) q.x = nx;
      const ny = q.y + REF.fxmul(sn, sp); f = ny > q.y ? ny + 40 : ny - 40;
      if (REF.wallAt(arr, q.x - 40, f) === 0 && REF.wallAt(arr, q.x + 40, f) === 0) q.y = ny;
      mine = V.stepPose(MAPS.vaults, mine, 44).pose;
      if (t % 17 === 16) { q.a = (q.a + 6 * 5) & 255; mine = V.turnPose(mine, 30); }
    }
    check('120 forward ticks with turns in the Vaults maze: stepPose equals the arithmetic of vaults.arc MOVEPLAYER', q.x === mine.x && q.y === mine.y && q.a === mine.a, `${q.x},${q.y} ${mine.x},${mine.y}`);
  }
  check('firstFreeCell: the first empty cell in reading order', JSON.stringify(V.firstFreeCell(m)) === JSON.stringify({ cx: 1, cy: 1 }) && V.firstFreeCell({ w: 4, h: 4, cells: new Array(16).fill(1) }) === null);
  const lg = V.legend();
  check('legend: codes 1..4 with their two patterns (the runtime\'s defaults), and the game\'s own when given', lg.length === 4 && lg[0].sides[0][0] === 0xFF && lg[1].sides[0][0] === 0xEE && lg[0].sides[1][0] === 0xAA && lg[3].sides[1][1] === 0x88 &&
    V.legend(Array.from({ length: 16 }, (_, i) => i))[2].sides[1][0] === 10);
  const r0 = V.viewerRays({ x: 0, y: 0, a: 0 }), r64 = V.viewerRays({ x: 0, y: 0, a: 64 });
  check('viewerRays: east is +x, south is +y (down the plan); the edges are 0.578 either side', Math.abs(r0.centre[0] - 1) < 1e-3 && Math.abs(r0.centre[1]) < 1e-3 && Math.abs(r64.centre[1] - 1) < 1e-3 &&
    r0.left[1] < 0 && r0.right[1] > 0 && Math.abs(r0.right[1] - 0.578) < 1e-3);
}

// ==================================================================================================================
console.log('\n6. THE REAL CHECK: the preview equals the screen of the real v4 runtime');
if (process.env.FPV_NOEMU) info('skipped (FPV_NOEMU=1)');
else {
  let R = null;
  try { R = await import('../arcade/tests/m8-common.mjs'); R.runtime(); } catch (e) { check('the v4 runtime builds and the emulator loads', false, String(e.message)); }
  if (R) {
    const S = R.runtime().syms;
    const garbage = (k) => Uint8Array.from({ length: 6144 }, (_, i) => (Math.imul(i + 1, 2654435761 + k) >>> 13) & 255);
    // the poses to show: Vaults' start (SX0, SY0, SPA) and its title-demo pose (TVX, TVY, 0), then each map's own
    const cases = [
      ['vaults', MAPS.vaults, 4, [{ x: 640, y: 7296, a: 34 }, { x: 3456, y: 1408, a: 0 }, { x: 640, y: 384, a: 200 }, ...poses(MAPS.vaults, 4, 7)]],
      ['vaults', MAPS.vaults, 2, [{ x: 640, y: 7296, a: 34 }, ...poses(MAPS.vaults, 3, 8)]],
      ['room32', MAPS.room32, 4, poses(MAPS.room32, 5, 9)],
      ['corridor', MAPS.corridor, 4, [{ x: 1 * 256 + 128, y: 2 * 256 + 128, a: 0 }, { x: 18 * 256 + 128, y: 2 * 256 + 128, a: 128 }, ...poses(MAPS.corridor, 4, 10)]],
      ['small', MAPS.small, 4, poses(MAPS.small, 5, 11)],
      ['mid', MAPS.mid, 2, poses(MAPS.mid, 5, 12)],
      ['tall', MAPS.tall, 4, poses(MAPS.tall, 4, 13)],
    ];
    let total = 0, lit = 0;
    for (const [name, m, colw, list] of cases) {
      const g = R.rayGame({ view: { colw, mw: m.w, mh: m.h, cells: m.cells } });
      const mach = R.bootIdle(g, 3);
      let bad = 0, first = null;
      list.forEach((pose, k) => {
        const file = k & 1, gb = garbage(k * 5 + colw);
        mach.ram.set(gb, file ? 0x6000 : 0x4000);
        const got = R.renderAt(mach, S, pose, file);
        const mine = V.render(m, pose, colw);
        // the 128 x 96 window of the runtime's display file, byte for byte, and the rest of the file untouched
        let d = 0;
        for (let r = 0; r < 96; r++) for (let kx = 0; kx < 16; kx++) if (got.bitmap[REF.rowAddr(48 + r) + 8 + kx] !== mine.window[r * 16 + kx]) d++;
        let outside = 0;
        for (let i = 0; i < 6144; i++) { const y = ((i >> 8) & 7) | ((i >> 2) & 0x38) | ((i >> 5) & 0xC0), x = i & 31; if ((y < 48 || y >= 144 || x < 8 || x >= 24) && got.bitmap[i] !== gb[i]) outside++; }
        total++; lit += mine.pixels.reduce((s, v) => s + v, 0) > 0 ? 1 : 0;
        if (d || outside || !mine.ok) { bad++; first ??= `pose ${JSON.stringify(pose)} file ${file}: ${d} window bytes differ, ${outside} outside`; }
      });
      check(`${name} (${m.w} x ${m.h}), colw ${colw}: ${list.length} poses, the preview's window equals the runtime's screen on the emulator (display file ${list.length > 1 ? '0 and 1' : '0'})`, bad === 0, first ?? '');
    }
    check(`${total} poses compared in all, every picture has ink`, total >= 30 && lit === total);
  }
}

console.log(`\n${failed ? 'FAIL' : 'PASS'}: floor plan preview model (${passed} checks passed, ${failed} failed)`);
process.exit(failed ? 1 : 0);
