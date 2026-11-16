"use strict";
// model-model.mjs -- tests for src/tools/model-model.js (the Leap Arcade Studio model editor's data model).
//   node tests/model-model.mjs
//   MODEL_QUICK=1 node tests/model-model.mjs     (fewer fuzz steps)
//
// Sections
//   1  creation, the stored form, the limits as live numbers
//   2  round trip over every model of the example assets (and odd stored forms, unknown keys)
//   3  points: add, move, nudge, delete (edges follow), loose points; the limits and the refusals
//   4  edges: join, unjoin, delete; no self edge, no duplicate
//   5  mirror: twin, asymmetry, make symmetric, and `mirror: true` on each edit
//   6  whole-model operations: centre, scale, rotate 90
//   7  presets: every one inside the limits, original, symmetric where it says so
//   8  selection helpers and the three flat views (project / unproject / hit tests)
//   9  validation against arcade-project's validateAsset and arcade-assetcheck's model checks
//  10  fuzz: random edits keep the model valid, a refused edit changes nothing, every result is storable
//  11  history (undo / redo)
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as M from '../src/tools/model-model.js';
import * as P from '../src/arcade-project.js';
import { checkAssets, MODEL_LIMITS } from '../src/lang/arcade/arcade-assetcheck.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const QUICK = !!process.env.MODEL_QUICK;

let passed = 0, failed = 0;
const ok = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  cond ? passed++ : failed++;
  return cond;
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Deep equality that ignores key order. */
const deq = (a, b) => {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b, k) && deq(a[k], b[k]));
};
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const mkProject = (models) => ({ format: 1, name: 't', framerate: 30, files: { 'main.arc': '' }, assets: { sprites: {}, tilesets: {}, maps: {}, sfx: {}, music: {}, models }, scenes: {} });
const findings = (stored) => checkAssets(mkProject({ m: stored }), null);
const mod = (points, edges, extra = {}) => ({ points, edges, ...extra });
const tri = () => M.fromAsset(mod([[0, 0, 0], [10, 0, 0], [0, 10, 0]], [[0, 1], [1, 2], [2, 0]]));
const cube = () => M.newModel();
const refused = (r, text) => r.ok === false && typeof r.message === 'string' && r.message.length > 5 && (!text || r.message.includes(text));

// ── 1. creation, the stored form, limits ──
console.log('1  creation, the stored form, limits');
{
  const m = M.newModel();
  ok('newModel is the cube: 8 points, 12 edges, inside the limits', m.points.length === 8 && m.edges.length === 12 && M.validateModel(m) === null);
  ok('the limits are the asset check\'s own numbers (imported): 128, 255, 64', M.MAX_POINTS === MODEL_LIMITS.points && M.MAX_EDGES === MODEL_LIMITS.edges && M.MAX_COORD === MODEL_LIMITS.coord && MODEL_LIMITS.points === 128 && MODEL_LIMITS.edges === 255 && MODEL_LIMITS.coord === 64);
  const lim = M.limitsOf(m);
  ok('limitsOf: live numbers (n, max, left) for points and edges', lim.points.n === 8 && lim.points.max === 128 && lim.points.left === 120 && lim.edges.n === 12 && lim.edges.max === 255 && lim.edges.left === 243 && lim.coord === 64);
  ok('modelSummary names the counts and the size', M.modelSummary(m) === '8 points, 12 edges, 40 x 40 x 40', M.modelSummary(m));
  ok('boundingBox: min, max, size; null without points', same(M.boundingBox(m), { min: [-20, -20, -20], max: [20, 20, 20], size: [40, 40, 40] }) && M.boundingBox({ points: [], edges: [] }) === null);
  const c1 = M.cloneModel(m); c1.points[0][0] = 99;
  ok('cloneModel is deep', m.points[0][0] === -20);
  ok('Studio\'s own "+" cube (studio.js NEW_ASSET.models) is the newModel cube', same(M.toAsset(m), { points: [[-20, -20, -20], [20, -20, -20], [20, 20, -20], [-20, 20, -20], [-20, -20, 20], [20, -20, 20], [20, 20, 20], [-20, 20, 20]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]] }));
}

// ── 2. round trips ──
console.log('2  round trip over the example models');
{
  let n = 0, allOk = true, textOk = true;
  const seen = [];
  for (const f of readdirSync(join(ROOT, 'arcade/examples')).filter((x) => x.endsWith('.assets.json'))) {
    const j = JSON.parse(readFileSync(join(ROOT, 'arcade/examples', f), 'utf8'));
    for (const [name, asset] of Object.entries(j.models ?? j.assets?.models ?? {})) {
      n++;
      const back = M.toAsset(M.fromAsset(asset));
      if (!deq(back, asset)) { allOk = false; console.log('    differs:', f, name); }
      if (JSON.stringify(back) !== JSON.stringify(asset)) textOk = false;
      if (M.validateAsset(asset) !== null) { allOk = false; console.log('    invalid:', f, name, M.validateAsset(asset)); }
      seen.push(`${f.replace('.assets.json', '')}:${name}`);
    }
  }
  ok(`toAsset(fromAsset(x)) deep-equals x for every models asset of arcade/examples/*.assets.json (${n}: ${seen.join(', ')})`, n >= 4 && allOk);
  ok('...and serialises to the same JSON text', textOk);
  ok('Orbit Gates has its four models', ['gate', 'gatefar', 'rock', 'shards'].every((k) => seen.includes('orbit:' + k)));
  const withExtra = mod([[1, 2, 3], [4, 5, 6]], [[0, 1]], { note: 'keep me', nested: { a: [1, 2] } });
  const m = M.fromAsset(withExtra);
  ok('unknown keys are kept aside and written back', same(m.extra, { note: 'keep me', nested: { a: [1, 2] } }) && deq(M.toAsset(m), withExtra));
  M.addPoint(m, [9, 9, 9]);
  ok('...also after an edit', M.toAsset(m).note === 'keep me' && M.toAsset(m).points.length === 3);
  const src = mod([[1, 2, 3], [4, 5, 6]], [[0, 1]]);
  const m2 = M.fromAsset(src); m2.points[0][0] = 7; m2.edges.push([1, 0]);
  ok('fromAsset copies: the stored asset is not touched by edits', src.points[0][0] === 1 && src.edges.length === 1);
  const out = M.toAsset(m2); out.points[0][0] = -1;
  ok('toAsset copies too', m2.points[0][0] === 7);
  const bad = (a) => { try { M.fromAsset(a); return null; } catch (e) { return e.message; } };
  ok('fromAsset throws a plain message for a non-object, missing arrays, a bad point, a bad edge',
    bad(null) !== null && bad([]) !== null && /points/.test(bad({ edges: [] })) && /edges/.test(bad({ points: [] })) && /point 1/.test(bad(mod([[0, 0, 0], [1, 2]], []))) && /edge 0/.test(bad(mod([[0, 0, 0]], [[0, 0.5]]))) && /whole/.test(bad(mod([[0, 0, 1.5]], []))));
  ok('a model beyond the limits is still readable (so it can be repaired), and validateModel says what is wrong',
    (() => { const big = mod([[100, 0, 0], [0, 0, 0]], [[0, 1], [0, 1], [1, 1]]); const mm = M.fromAsset(big); return deq(M.toAsset(mm), big) && /beyond/.test(M.validateModel(mm)); })());
}

// ── 3. points ──
console.log('3  points');
{
  const m = tri();
  let r = M.addPoint(m, [3.6, -4.4, 70]);
  ok('addPoint rounds and clamps to +-64; returns its index', r.ok && r.index === 3 && same(m.points[3], [4, -4, 64]) && same(r.indices, [3]));
  r = M.addPoint(m, [-0.4, 0, -100]);
  ok('addPoint never writes -0 and clamps low', same(m.points[4], [0, 0, -64]) && Object.is(m.points[4][0], 0));
  ok('addPoint refuses non-numbers with a message and changes nothing', refused(M.addPoint(m, [1, 2]), 'three numbers') && refused(M.addPoint(m, [1, NaN, 3])) && m.points.length === 5);
  r = M.movePoint(m, 0, [5, 6, 7]);
  ok('movePoint', r.ok && r.changed && same(m.points[0], [5, 6, 7]) && same(r.indices, [0]));
  r = M.movePoint(m, 0, [5, 6, 7]);
  ok('movePoint to where it is: ok, changed false', r.ok && !r.changed);
  ok('movePoint clamps; a bad index is refused', same((M.movePoint(m, 0, [99, -99, 0]), m.points[0]), [64, -64, 0]) && refused(M.movePoint(m, 40, [0, 0, 0]), 'no point 40'));
  r = M.nudgePoint(m, 1, [1, -2, 3]);
  ok('nudgePoint adds a delta; at the limit it stops there', same(m.points[1], [11, -2, 3]) && (M.movePoint(m, 1, [64, 0, 0]), M.nudgePoint(m, 1, [8, 0, 0]).changed === false) && m.points[1][0] === 64);

  // delete: edges follow, higher indices shift down
  const c = cube();
  r = M.deletePoint(c, 0);
  ok('deletePoint removes the point and the edges that end at it (3 of the cube\'s 12)', r.ok && c.points.length === 7 && c.edges.length === 9 && r.edgesRemoved === 3 && same(r.removed, [0]));
  ok('...higher indices shift down in the edges: old edge [1,2] is [0,1]', same(c.edges[0], [0, 1]) && c.edges.every((e) => e[0] >= 0 && e[1] >= 0 && e[0] < 7 && e[1] < 7) && M.validateModel(c) === null);
  ok('...and the map says old -> new (-1 for the deleted)', same(r.map, [-1, 0, 1, 2, 3, 4, 5, 6]));
  const t = M.fromAsset(mod([[0, 0, 0], [5, 0, 0], [9, 9, 9]], [[0, 1]])); const keep = M.toAsset(t);
  ok('deletePoint refuses to leave no point or no edge, and changes nothing', refused(M.deletePoint(t, 0), 'at least one edge') && same(M.toAsset(t), keep) && refused(M.deletePoints(M.fromAsset(mod([[0, 0, 0]], [])), [0]), 'at least one point') && refused(M.deletePoints(tri(), [0, 1, 2]), 'at least one point'));
  ok('...a triangle loses a corner and keeps its one remaining edge', (() => { const x = tri(); return M.deletePoint(x, 0).ok && same(x.edges, [[0, 1]]) && x.points.length === 2; })());
  ok('deletePoint of a missing point is refused', refused(M.deletePoint(c, 99), 'No point'));
  const d2 = cube(); r = M.deletePoints(d2, [7, 1, 7, 99]);
  ok('deletePoints takes a set (duplicates and missing ones ignored)', r.ok && same(r.removed, [1, 7]) && d2.points.length === 6 && M.validateModel(d2) === null);

  // loose points
  const l = cube(); M.addPoint(l, [1, 1, 1]); M.addPoint(l, [2, 2, 2]);
  r = M.removeLoosePoints(l);
  ok('removeLoosePoints deletes the points on no edge; the others keep their edges', r.ok && same(r.removed, [8, 9]) && l.points.length === 8 && l.edges.length === 12);
  ok('...and with none loose it is ok but changed false', (() => { const x = M.removeLoosePoints(l); return x.ok && !x.changed; })());

  // the 128-point limit
  const full = M.fromAsset(M.makePreset('ring', { n: 128 }));
  ok('a ring of 128 is a full model', full.points.length === 128 && M.limitsOf(full).points.left === 0 && M.validateModel(full) === null);
  ok('addPoint at 128 is refused with a plain message and changes nothing', refused(M.addPoint(full, [0, 0, 0]), '128') && full.points.length === 128);
  const almost = M.fromAsset(M.makePreset('ring', { n: 127 }));
  ok('a mirrored add needs two places: refused with 127 points (the mirror-off hint), a point on the plane (x = 0) is one place',
    refused(M.addPoint(almost, [5, 5, 5], { mirror: true }), 'two places') && almost.points.length === 127 && M.addPoint(almost, [0, 5, 5], { mirror: true }).ok && almost.points.length === 128);
}

// ── 4. edges ──
console.log('4  edges');
{
  const m = M.fromAsset(mod([[0, 0, 0], [10, 0, 0], [0, 10, 0], [0, 0, 10]], [[0, 1]]));
  let r = M.join(m, 1, 2);
  ok('join adds an edge', r.ok && r.changed && same(m.edges, [[0, 1], [1, 2]]) && same(r.added, [1]));
  ok('join refuses a duplicate (either order), a self edge, a missing point', refused(M.join(m, 2, 1), 'already joined') && refused(M.join(m, 0, 1), 'already') && refused(M.join(m, 2, 2), 'itself') && refused(M.join(m, 0, 9), 'points of the model') && refused(M.join(m, -1, 0)) && m.edges.length === 2);
  ok('findEdge looks either way; -1 for none', M.findEdge(m, 2, 1) === 1 && M.findEdge(m, 1, 2) === 1 && M.findEdge(m, 0, 3) === -1);
  ok('edgesOf / neighbours', same(M.edgesOf(m, 1), [0, 1]) && same(M.neighbours(m, 1), [0, 2]) && same(M.neighbours(m, 3), []));
  r = M.unjoin(m, 2, 1);
  ok('unjoin removes the edge between two points (either order)', r.ok && same(m.edges, [[0, 1]]) && same(r.removed, [1]));
  ok('unjoin refuses points that are not joined, and the last edge', refused(M.unjoin(m, 2, 3), 'not joined') && refused(M.unjoin(m, 0, 1), 'at least one edge') && m.edges.length === 1);
  M.join(m, 0, 2);
  r = M.deleteEdge(m, 0);
  ok('deleteEdge by index', r.ok && same(m.edges, [[0, 2]]));
  ok('deleteEdge refuses the last edge and a missing one', refused(M.deleteEdge(m, 0), 'at least one edge') && refused(M.deleteEdge(m, 5), 'no edge 5'));

  const full = M.fromAsset(M.makePreset('ring', { n: 128 }));
  // 255 edges: 127 more joins on a ring of 128 (the ring has 128 edges)
  let n = 0;
  for (let i = 0; i < 128 && full.edges.length < 255; i++) for (let j = i + 2; j < 128 && full.edges.length < 255; j++) { if (M.join(full, i, j).ok) n++; }
  ok('the 255-edge limit: the 255th edge is accepted', full.edges.length === 255 && n === 127 && M.limitsOf(full).edges.left === 0 && M.validateModel(full) === null);
  const ne = full.edges.length;
  let free = null;
  for (let i = 0; i < 128 && !free; i++) for (let j = i + 1; j < 128 && !free; j++) if (M.findEdge(full, i, j) < 0) free = [i, j];
  ok('a free pair of points exists to try the 256th edge on', free !== null);
  ok('the 256th edge is refused with a message naming 255, and nothing changes', refused(M.join(full, free[0], free[1]), '255') && full.edges.length === ne);
}

// ── 5. mirror ──
console.log('5  mirror');
{
  const m = M.fromAsset(mod([[10, 5, 3], [-10, 5, 3], [0, 8, 3], [7, 0, 0]], [[0, 1], [0, 2], [1, 2], [0, 3]]));
  ok('twinIndex: the point with x negated; a point on the plane is its own twin; none is -1', M.twinIndex(m, 0) === 1 && M.twinIndex(m, 1) === 0 && M.twinIndex(m, 2) === 2 && M.twinIndex(m, 3) === -1);
  ok('twinIndex across y and z', M.twinIndex(M.fromAsset(mod([[1, 4, 0], [1, -4, 0]], [[0, 1]])), 0, 'y') === 1 && M.twinIndex(M.fromAsset(mod([[1, 4, 6], [1, 4, -6]], [[0, 1]])), 0, 'z') === 1);
  const asy = M.asymmetry(m);
  ok('asymmetry names the points without a twin and the edges without a mirror edge', same(asy.points, [3]) && same(asy.edges, [3]) && !M.isSymmetric(m));
  const r = M.makeSymmetric(m);
  ok('makeSymmetric adds the missing twin and the mirror edge; nothing moved', r.ok && r.changed && r.addedPoints === 1 && r.addedEdges === 1 && same(m.points[4], [-7, 0, 0]) && m.points.length === 5 && m.edges.length === 5);
  ok('...the new edge joins the twins: [1, 4]', same(m.edges[4], [1, 4]) && M.isSymmetric(m) && M.validateModel(m) === null);
  ok('makeSymmetric on a symmetric model: ok, changed false', (() => { const x = M.makeSymmetric(m); return x.ok && !x.changed && m.points.length === 5; })());
  ok('makeSymmetric is refused when the result would pass 128 points', (() => { const f = M.fromAsset(M.makePreset('ring', { n: 127 })); M.addPoint(f, [5, 3, 0]); const before = M.toAsset(f); return refused(M.makeSymmetric(f), '128') && deq(M.toAsset(f), before); })());
  ok('makeSymmetric across y', (() => { const q = M.fromAsset(mod([[2, 3, 0], [5, 0, 1]], [[0, 1]])); const x = M.makeSymmetric(q, 'y'); return x.ok && q.points.length === 3 && same(q.points[2], [2, -3, 0]) && M.isSymmetric(q, 'y'); })());
  ok('the presets that say "the same on both sides" are symmetric across x; the rock is not', M.isSymmetric(M.fromAsset(M.makePreset('dart'))) && M.isSymmetric(cube()) && !M.isSymmetric(M.fromAsset(M.makePreset('rock'))));

  // mirror: true on each edit
  const s = M.fromAsset(M.makePreset('dart'));
  let a = M.addPoint(s, [12, 4, -6], { mirror: true });
  ok('addPoint with mirror adds the twin right after', a.ok && same(a.indices, [6, 7]) && same(s.points[6], [12, 4, -6]) && same(s.points[7], [-12, 4, -6]) && M.twinIndex(s, 6) === 7);
  a = M.addPoint(s, [0, 9, 9], { mirror: true });
  ok('...a point on the plane (x = 0) is added alone', a.ok && same(a.indices, [8]) && s.points.length === 9);
  M.join(s, 6, 7, { mirror: true });
  ok('join with mirror: a pair that is its own mirror gives one edge', same(s.edges[12], [6, 7]) && s.edges.length === 13);
  M.join(s, 6, 0, { mirror: true });
  ok('join with mirror also joins the twins: 6-0 and 7-0 (0 is on the plane)', M.findEdge(s, 6, 0) >= 0 && M.findEdge(s, 7, 0) >= 0 && s.edges.length === 15);
  M.join(s, 6, 1, { mirror: true });
  ok('join with mirror: 6-1 and 7-2 (1 and 2 are twins)', M.findEdge(s, 6, 1) >= 0 && M.findEdge(s, 7, 2) >= 0 && M.isSymmetric(s));
  const mv = M.movePoint(s, 6, [20, 8, -3], { mirror: true });
  ok('movePoint with mirror moves the twin to the mirror image', mv.ok && same(s.points[6], [20, 8, -3]) && same(s.points[7], [-20, 8, -3]) && same(mv.indices, [6, 7]));
  const mv2 = M.movePoint(s, 0, [9, 0, 48], { mirror: true });
  ok('...a point on the plane stays on it (x forced to 0)', mv2.ok && s.points[0][0] === 0 && s.points[0][2] === 48);
  const tw = M.twinIndex(s, 6);
  M.movePoint(s, 6, [30, 8, -3], { mirror: true, twin: tw });
  ok('...with the twin given (a drag) the same', same(s.points[7], [-30, 8, -3]));
  const un = M.unjoin(s, 6, 1, { mirror: true });
  ok('unjoin with mirror removes both edges', un.ok && M.findEdge(s, 6, 1) < 0 && M.findEdge(s, 7, 2) < 0);
  const before = s.points.length;
  const dl = M.deletePoint(s, 6, { mirror: true });
  ok('deletePoint with mirror removes the twin too', dl.ok && s.points.length === before - 2 && same(dl.removed, [6, 7]) && M.validateModel(s) === null);
  ok('without mirror the twin is left alone', (() => { const q = M.fromAsset(M.makePreset('dart')); const r2 = M.deletePoint(q, 1); return r2.ok && q.points.length === 5; })());
}

// ── 6. whole-model operations ──
console.log('6  centre, scale, rotate');
{
  const m = M.fromAsset(mod([[10, 20, 30], [30, 20, 30], [10, 40, 30]], [[0, 1], [1, 2]]));
  let r = M.centre(m);
  ok('centre moves the bounding-box middle to 0, 0, 0', r.ok && r.changed && same(r.shift, [-20, -30, -30]) && same(M.boundingBox(m), { min: [-10, -10, 0], max: [10, 10, 0], size: [20, 20, 0] }) && same(m.points[0], [-10, -10, 0]));
  r = M.centre(m);
  ok('centred again: ok, changed false', r.ok && !r.changed);
  const odd = M.fromAsset(mod([[0, 0, 0], [3, 0, 0]], [[0, 1]]));
  M.centre(odd);
  ok('an odd width rounds the half away from zero: [0,3] -> [-2,1]', same(odd.points, [[-2, 0, 0], [1, 0, 0]]));
  ok('centre of the example models is a no-op or keeps them valid', (() => { const g = M.fromAsset(JSON.parse(readFileSync(join(ROOT, 'arcade/examples/orbit.assets.json'), 'utf8')).models.shards); M.centre(g); return M.validateModel(g) === null; })());
  ok('centre refuses a model with no points', refused(M.centre({ points: [], edges: [] })));

  const s = M.fromAsset(mod([[10, -10, 4], [-10, 10, 20]], [[0, 1]]));
  r = M.scale(s, 2);
  ok('scale doubles about 0, 0, 0', r.ok && r.changed && same(s.points, [[20, -20, 8], [-20, 20, 40]]));
    r = M.scale(s, 2);
  ok('scale refuses what would pass +-64, naming the biggest coordinate (80), and changes nothing', refused(r, '80') && same(s.points, [[20, -20, 8], [-20, 20, 40]]), r.message);
  ok('...the limit itself is fine: 64 stays', (() => { const q = M.fromAsset(mod([[32, 0, 0], [0, 0, 0]], [[0, 1]])); return M.scale(q, 2).ok && q.points[0][0] === 64 && refused(M.scale(q, 1.01), '65'); })());
  const h = M.fromAsset(mod([[5, 3, -5], [-5, -3, 5]], [[0, 1]]));
  M.scale(h, 0.5);
  ok('rounding is half away from zero, so a symmetric model stays symmetric: 2.5 -> 3, -2.5 -> -3', same(h.points, [[3, 2, -3], [-3, -2, 3]]));
  ok('scale refuses a factor that is not above 0', refused(M.scale(s, 0)) && refused(M.scale(s, -1)) && refused(M.scale(s, NaN)));
  ok('scale refuses to put two different points on the same spot', (() => { const q = M.fromAsset(mod([[1, 0, 0], [2, 0, 0]], [[0, 1]])); const before = M.toAsset(q); const x = M.scale(q, 0.5); return refused(x, 'same spot') && deq(M.toAsset(q), before); })());
  ok('scale by 1 changes nothing: ok, changed false', (() => { const x = M.scale(s, 1); return x.ok && !x.changed; })());
  ok('scale 1.25 then 0.8 of the cube (+-20) is back where it was', (() => { const c = cube(); M.scale(c, 1.25); const up = c.points[0][0]; M.scale(c, 0.8); return up === -25 && c.points[0][0] === -20; })());

  // rotate: hand-computed
  const p = M.fromAsset(mod([[1, 2, 3], [0, 0, 0]], [[0, 1]]));
  const at = (axis, dir) => { const q = M.cloneModel(p); M.rotate90(q, axis, dir); return q.points[0]; };
  ok('rotate90 about x: (x, y, z) -> (x, -z, y)', same(at('x', 1), [1, -3, 2]) && same(at('x', -1), [1, 3, -2]));
  ok('rotate90 about y: (x, y, z) -> (z, y, -x)', same(at('y', 1), [3, 2, -1]) && same(at('y', -1), [-3, 2, 1]));
  ok('rotate90 about z: (x, y, z) -> (-y, x, z)', same(at('z', 1), [-2, 1, 3]) && same(at('z', -1), [2, -1, 3]));
  ok('four turns are the identity; a turn and its opposite cancel; no -0 appears', ['x', 'y', 'z'].every((ax) => { const q = M.cloneModel(p); for (let i = 0; i < 4; i++) M.rotate90(q, ax); const r2 = M.cloneModel(p); M.rotate90(r2, ax); M.rotate90(r2, ax, -1); return same(q, p) && same(r2, p); }) && ['x', 'y', 'z'].every((ax) => at(ax, 1).concat(at(ax, -1)).every((v) => !Object.is(v, -0))));
  ok('rotate90 refuses an unknown axis; the edges are untouched', refused(M.rotate90(M.cloneModel(p), 'w')) && same((() => { const q = M.cloneModel(p); M.rotate90(q, 'x'); return q.edges; })(), p.edges));
  ok('a rotated model stays inside the limits (a permutation with signs)', (() => { const q = M.fromAsset(mod([[64, -64, 63], [-64, 64, -63]], [[0, 1]])); for (const ax of ['x', 'y', 'z']) M.rotate90(q, ax); return M.validateModel(q) === null; })());
}

// ── 7. presets ──
console.log('7  presets');
{
  ok('the presets are cube, pyramid, ring, dart, rock', same(M.PRESETS.map((p) => p.id), ['cube', 'pyramid', 'ring', 'dart', 'rock']) && M.PRESETS.every((p) => p.title && p.about));
  for (const p of M.PRESETS) {
    const x = M.makePreset(p.id);
    ok(`preset ${p.id}: ${x.points.length} points, ${x.edges.length} edges, inside the limits, stored form valid, no finding from the asset check`,
      M.validateModel(x) === null && M.validateAsset(x) === null && P.validateAsset('models', x) === null && findings(x).length === 0, M.validateModel(x) ?? '');
  }
  ok('the ring: n points and n edges in order for n = 3, 8, 64, 128; out-of-range n is clamped to 3..128', [3, 8, 64, 128].every((n) => { const r = M.makePreset('ring', { n }); return r.points.length === n && r.edges.length === n && M.validateModel(r) === null; }) && M.makePreset('ring', { n: 1 }).points.length === 3 && M.makePreset('ring', { n: 500 }).points.length === 128);
  ok('the ring has no two points on the same spot, even at 128', (() => { const r = M.makePreset('ring', { n: 128 }); return new Set(r.points.map((q) => q.join())).size === 128; })());
  ok('the ring is flat (z = 0) and the first point is at +r on x', (() => { const r = M.makePreset('ring', { n: 8 }); return r.points.every((q) => q[2] === 0) && same(r.points[0], [48, 0, 0]); })());
  ok('presets are fresh copies each time', M.makePreset('cube').points !== M.makePreset('cube').points);
  ok('the presets are not the example models (original shapes)', (() => {
    const orbit = JSON.parse(readFileSync(join(ROOT, 'arcade/examples/orbit.assets.json'), 'utf8')).models;
    return M.PRESETS.every((p) => Object.values(orbit).every((o) => JSON.stringify(o) !== JSON.stringify(M.makePreset(p.id))));
  })());
  const m = M.fromAsset(mod([[1, 1, 1], [2, 2, 2]], [[0, 1]], { keep: 7 }));
  ok('applyPreset replaces points and edges, keeps the unknown keys; an unknown id is refused', M.applyPreset(m, 'pyramid').ok && m.points.length === 5 && m.extra.keep === 7 && M.toAsset(m).keep === 7 && refused(M.applyPreset(m, 'nope'), 'no preset') && m.points.length === 5);
  ok('makePreset throws for an unknown id', (() => { try { M.makePreset('x'); return false; } catch (e) { return /no preset/.test(e.message); } })());
}

// ── 8. selection helpers and views ──
console.log('8  selection and the flat views');
{
  ok('remapSelection renumbers after a delete and drops the deleted', same(M.remapSelection([0, 3, 5], [-1, 0, 1, 2, 3, 4]), [2, 4]) && same(M.remapSelection([], [0]), []));
  ok('clampSelection keeps points that exist, once each', same(M.clampSelection([0, 7, 7, 2, -1, 9, 1.5], 5), [0, 2]));
  const c = cube(); const del = M.deletePoint(c, 2);
  ok('selection follows a real delete (select 1 and 3, delete 2: they are 1 and 2)', same(M.remapSelection([1, 3], del.map), [1, 2]));

  ok('the views: top = x, z; front = x, y; side = z, y', M.VIEW_IDS.join() === 'top,front,side' && M.VIEWS.top.h === 0 && M.VIEWS.top.v === 2 && M.VIEWS.front.v === 1 && M.VIEWS.side.h === 2 && M.VIEWS.side.v === 1 && M.VIEWS.top.thirdName === 'y' && M.VIEWS.front.thirdName === 'z' && M.VIEWS.side.thirdName === 'x');
  const size = 280, sc = M.viewScale(size);
  ok('viewScale: +-64 plus the padding fills the view', Math.abs(sc * 2 * (64 + M.VIEW_PAD) - size) < 1e-9 && sc === 2);
  ok('projectToView: the origin is the middle; +x is right; +y (and +z in the top view) is UP the screen', same(M.projectToView('front', [0, 0, 0], size), [140, 140]) && same(M.projectToView('front', [10, 5, 99], size), [160, 130]) && same(M.projectToView('top', [10, 99, 5], size), [160, 130]) && same(M.projectToView('side', [99, 5, 10], size), [160, 130]));
  let allBack = true;
  for (const v of M.VIEW_IDS) for (const p of [[0, 0, 0], [64, -64, 3], [-17, 33, 12], [5, 6, 7]]) {
    const [px, py] = M.projectToView(v, p, size);
    const q = M.unprojectFromView(v, px, py, size, { keep: p });
    if (!same(q, p)) { allBack = false; console.log('    round trip failed', v, p, q); }
  }
  ok('unprojectFromView inverts projectToView in every view (the third coordinate from `keep`)', allBack);
  ok('the third coordinate defaults to 0; a click is rounded, clamped to +-64, and snapped to `snap`', same(M.unprojectFromView('front', 160.6, 130.4, size), [10, 5, 0]) && same(M.unprojectFromView('front', -500, 900, size), [-64, -64, 0]) && same(M.unprojectFromView('top', 164, 126, size, { keep: [0, 7, 0], snap: 4 }), [12, 7, 8]));
  ok('the kept coordinate is clamped too', same(M.unprojectFromView('side', 140, 140, size, { keep: [90, 0, 0] }), [64, 0, 0]));

  const m = M.fromAsset(mod([[0, 0, 0], [10, 0, 0], [10, 0, 30], [-20, 5, 5]], [[0, 1], [1, 2]]));
  const at = (p, v = 'top') => M.projectToView(v, p, size);
  let [hx, hy] = at([10, 0, 0]);
  ok('hitPoint finds the nearest point within the radius, else -1', M.hitPoint(m, 'top', hx + 3, hy - 2, size) === 1 && M.hitPoint(m, 'top', hx + 30, hy, size) === -1 && M.hitPoint(m, 'top', hx + 7.5, hy, size, 8) === 1 && M.hitPoint(m, 'top', hx + 12, hy + 40, size, 7) === -1);
  ok('hitPoint with two points on top of each other in a view: the lowest index, or one in `prefer`', (() => { const o = M.fromAsset(mod([[10, 0, 0], [10, 20, 0]], [[0, 1]])); const [px, py] = M.projectToView('top', [10, 0, 0], size); return M.hitPoint(o, 'top', px, py, size) === 0 && M.hitPoint(o, 'top', px, py, size, 7, [1]) === 1; })());
  [hx, hy] = M.projectToView('top', [10, 0, 15], size);
  ok('hitEdge finds the nearest edge within the radius (to the segment, not the line)', M.hitEdge(m, 'top', hx + 2, hy, size) === 1 && M.hitEdge(m, 'top', hx + 20, hy, size) === -1 && M.hitEdge(m, 'top', ...M.projectToView('top', [5, 0, 0], size), size) === 0 && M.hitEdge(m, 'top', ...M.projectToView('top', [30, 0, 0], size), size) === -1);
  ok('hitEdge ignores an edge to a point that is not there', M.hitEdge(M.fromAsset(mod([[0, 0, 0], [1, 1, 1]], [[0, 5]])), 'top', 140, 140, size) === -1);
}

// ── 9. validation against the project and the asset check ──
console.log('9  validation');
{
  ok('validateModel names each problem', /no points/.test(M.validateModel({ points: [], edges: [] })) && /no edges/.test(M.validateModel({ points: [[0, 0, 0]], edges: [] })) &&
    /beyond/.test(M.validateModel({ points: [[65, 0, 0], [0, 0, 0]], edges: [[0, 1]] })) && /itself/.test(M.validateModel({ points: [[0, 0, 0], [1, 0, 0]], edges: [[1, 1]] })) &&
    /does not exist/.test(M.validateModel({ points: [[0, 0, 0], [1, 0, 0]], edges: [[0, 2]] })) && /at most 128/.test(M.validateModel({ points: Array.from({ length: 129 }, () => [0, 0, 0]), edges: [[0, 1]] })) &&
    /at most 255/.test(M.validateModel({ points: [[0, 0, 0], [1, 0, 0]], edges: Array.from({ length: 256 }, () => [0, 1]) })) && M.validateModel(null) !== null);
  ok('validateAsset (stored): fine, a bad shape, an over-limit model', M.validateAsset(M.makePreset('cube')) === null && /points/.test(M.validateAsset({ edges: [] })) && /beyond/.test(M.validateAsset(mod([[70, 0, 0], [0, 0, 0]], [[0, 1]]))));
  ok('whatever validateModel accepts, arcade-project validateAsset(models) accepts and the asset check has no error', (() => {
    for (const p of M.PRESETS) { const a = M.toAsset(M.fromAsset(M.makePreset(p.id))); if (P.validateAsset('models', a) !== null || findings(a).some((f) => f.severity === 'error')) return false; }
    return true;
  })());
  ok('a loose point is the checker\'s model-unused-point warning, and removeLoosePoints clears it', (() => {
    const c = cube(); M.addPoint(c, [1, 2, 3]);
    const f = findings(M.toAsset(c));
    const r = M.removeLoosePoints(c);
    return f.length === 1 && f[0].id === 'model-unused-point' && f[0].severity === 'warning' && same(f[0].points, [8]) && r.ok && findings(M.toAsset(c)).length === 0;
  })());
}

// ── 10. fuzz ──
console.log('10 fuzz');
{
  const steps = QUICK ? 1500 : 12000;
  const rand = rng(20261115);
  const pick = (n) => Math.floor(rand() * n);
  const coord = () => pick(150) - 75;
  let bad = null, nOk = 0, nRefused = 0, maxP = 0, maxE = 0;
  const m = M.newModel();
  const pre = () => {
    const mirror = rand() < 0.3;
    return { mirror };
  };
  for (let s = 0; s < steps && !bad; s++) {
    const before = JSON.stringify(M.toAsset(m));
    const n = m.points.length;
    const o = pre();
    const k = pick(14);
    let r;
    let what;
    switch (k) {
      case 0: case 1: what = 'addPoint'; r = M.addPoint(m, [coord(), coord(), coord()], o); break;
      case 2: what = 'movePoint'; r = M.movePoint(m, pick(n + 1), [coord(), coord(), coord()], o); break;
      case 3: what = 'nudgePoint'; r = M.nudgePoint(m, pick(n), [pick(17) - 8, pick(17) - 8, pick(17) - 8], o); break;
      case 4: what = 'deletePoint'; r = M.deletePoint(m, pick(n + 1), o); break;
      case 5: case 6: case 7: what = 'join'; r = M.join(m, pick(n + 1) - (rand() < .05 ? 1 : 0), pick(n), o); break;
      case 8: what = 'unjoin'; r = M.unjoin(m, pick(n), pick(n), o); break;
      case 9: what = 'deleteEdge'; r = M.deleteEdge(m, pick(m.edges.length + 1)); break;
      case 10: what = 'rotate'; r = M.rotate90(m, ['x', 'y', 'z'][pick(3)], rand() < .5 ? 1 : -1); break;
      case 11: what = 'scale'; r = M.scale(m, [0.5, 0.8, 1.25, 2, 1][pick(5)]); break;
      case 12: what = 'centre / loose / symmetric'; r = [() => M.centre(m), () => M.removeLoosePoints(m), () => M.makeSymmetric(m)][pick(3)](); break;
      default: what = 'preset'; r = rand() < 0.1 ? M.applyPreset(m, M.PRESETS[pick(5)].id, { n: 3 + pick(126) }) : { ok: true, changed: false }; break;
    }
    const after = JSON.stringify(M.toAsset(m));
    if (!r || typeof r.ok !== 'boolean') { bad = `step ${s} ${what}: no result object`; break; }
    if (r.ok) {
      nOk++;
      const v = M.validateModel(m);
      if (v) bad = `step ${s} ${what} left an invalid model: ${v}`;
      else if (M.validateAsset(M.toAsset(m))) bad = `step ${s} ${what}: validateAsset says ${M.validateAsset(M.toAsset(m))}`;
      else if (P.validateAsset('models', M.toAsset(m))) bad = `step ${s} ${what}: project validateAsset refuses`;
      else if (!deq(M.toAsset(M.fromAsset(M.toAsset(m))), M.toAsset(m))) bad = `step ${s} ${what}: round trip`;
      else if (r.changed === false && before !== after) bad = `step ${s} ${what}: changed false but the model changed`;
      else if (r.changed === true && before === after && what !== 'preset') bad = `step ${s} ${what}: changed true but nothing changed`;
      else if (findings(M.toAsset(m)).some((f) => f.severity === 'error')) bad = `step ${s} ${what}: the asset check reports an error`;
    } else {
      nRefused++;
      if (before !== after) bad = `step ${s} ${what}: refused (${r.message}) but the model changed`;
      else if (!r.message) bad = `step ${s} ${what}: refused without a message`;
    }
    maxP = Math.max(maxP, m.points.length); maxE = Math.max(maxE, m.edges.length);
  }
  ok(`${steps} random edits: every accepted one leaves a valid, storable model; every refused one leaves it unchanged (${nOk} accepted, ${nRefused} refused; up to ${maxP} points / ${maxE} edges)`, !bad, bad ?? '');
  ok('the fuzz reached refusals and real work (not a trivial run)', nRefused > 50 && nOk > 500);

  // growth to the limits
  const g = M.fromAsset(M.makePreset('ring', { n: 100 }));
  const r1 = rng(5);
  let guard = 0;
  while (g.points.length < 128 && guard++ < 1000) M.addPoint(g, [Math.floor(r1() * 128) - 64, Math.floor(r1() * 128) - 64, Math.floor(r1() * 128) - 64]);
  for (let i = 0; i < 4000 && g.edges.length < 255; i++) M.join(g, Math.floor(r1() * 128), Math.floor(r1() * 128));
  ok('grown to 128 points and 255 edges by random adds and joins: valid, and one more of either is refused', g.points.length === 128 && g.edges.length === 255 && M.validateModel(g) === null && refused(M.addPoint(g, [0, 0, 0]), '128') && refused(M.join(g, 0, 50)));
  ok('...and the asset check agrees: only (maybe) loose-point warnings', findings(M.toAsset(g)).every((f) => f.severity === 'warning'));

  // symmetric fuzz: with mirror on, a symmetric model stays symmetric through adds, moves, joins, deletes
  const q = M.fromAsset(M.makePreset('dart'));
  const r2 = rng(99);
  let symOk = true;
  for (let s = 0; s < (QUICK ? 200 : 1500) && symOk; s++) {
    const n = q.points.length, c = Math.floor(r2() * 5), saved = M.cloneModel(q);
    const o = { mirror: true };
    if (c === 0) M.addPoint(q, [Math.floor(r2() * 60) - 30, Math.floor(r2() * 60) - 30, Math.floor(r2() * 60) - 30], o);
    else if (c === 1) M.movePoint(q, Math.floor(r2() * n), [Math.floor(r2() * 60) - 30, Math.floor(r2() * 60) - 30, Math.floor(r2() * 60) - 30], o);
    else if (c === 2) M.join(q, Math.floor(r2() * n), Math.floor(r2() * n), o);
    else if (c === 3) M.unjoin(q, Math.floor(r2() * n), Math.floor(r2() * n), o);
    else M.deletePoint(q, Math.floor(r2() * n), o);
    // mirror edits find a point's twin by position, so they assume no two points share a spot: a step that made one is taken back
    if (new Set(q.points.map((pt) => pt.join())).size !== q.points.length) { q.points = saved.points; q.edges = saved.edges; continue; }
    if (!M.isSymmetric(q)) { symOk = false; console.log('    asymmetric after step', s, 'op', c, JSON.stringify(M.asymmetry(q))); }
  }
  ok('with `mirror: true` on every edit a symmetric model (the dart) stays symmetric across x', symOk);
}

// ── 11. history ──
console.log('11 history');
{
  const m = M.newModel();
  const h = M.createHistory(m, 201);
  ok('a fresh history has nothing to undo or redo', !h.canUndo && !h.canRedo);
  M.addPoint(m, [1, 2, 3]);
  ok('commit records a change; the same state again is not a step', h.commit(m) === true && h.commit(m) === false && h.canUndo);
  M.join(m, 8, 0); h.commit(m);
  let u = h.undo();
  ok('undo returns the earlier state as a fresh copy', u.points.length === 9 && u.edges.length === 12 && h.canRedo);
  u = h.undo();
  ok('undo again: the cube', u.points.length === 8 && !h.canUndo && h.undo() === null);
  const r = h.redo();
  ok('redo', r.points.length === 9 && r.edges.length === 12 && h.canUndo);
  ok('a new edit after undo drops the redo', (() => { const x = h.current; M.addPoint(x, [9, 9, 9]); h.commit(x); return !h.canRedo; })());
  const m2 = M.fromAsset(mod([[0, 0, 0], [1, 0, 0]], [[0, 1]], { note: 'x' }));
  const h2 = M.createHistory(m2, 201);
  for (let i = 0; i < 250; i++) { M.addPoint(m2, [i % 60, 0, 0]); h2.commit(m2); if (m2.points.length >= 128) M.deletePoints(m2, [2, 3, 4]); }
  let steps = 0; while (h2.undo()) steps++;
  ok('the history keeps the last 200 steps (createHistory(model, 201)) and the unknown keys', steps === 200 && same(h2.current.extra, { note: 'x' }));
}

console.log(`\n${failed ? failed + ' FAILED, ' : ''}${passed} passed`);
process.exit(failed ? 1 : 0);
