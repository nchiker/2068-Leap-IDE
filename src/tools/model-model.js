/**
 * src/tools/model-model.js — the data model of the Leap Arcade Studio model editor (pure: no DOM, Node can import it).
 *
 * A wireframe model (docs/ARCADE_WIREFRAME_CONTRACT.md section 2.1) is stored as {points: [[x, y, z], ...], edges: [[i, j], ...]}: x right, y UP,
 * z forward, whole numbers |c| <= 64, 1..128 points, 1..255 edges, i <> j, both ends existing points. It is edited as the same shape plus the keys
 * the editor does not understand, kept aside and written back unchanged (as tile-model.js does):
 *
 *   model = { points: [[x, y, z] x n], edges: [[i, j] x m], extra?: {unknown keys of the model} }
 *
 * Every operation MUTATES the model in the style of tile-model.js and returns a result: {ok: true, changed, ...} when done, or {ok: false, message}
 * when it was refused (the model is then exactly as it was; the message is a plain sentence for the status line). Limits are the compiler's and the
 * asset check's (MODEL_LIMITS in src/lang/arcade/arcade-assetcheck.js, imported, not copied); an operation never leaves a model that breaks them, except
 * that a model that was read already broken (fromAsset accepts any stored model of the right shape, so it can be repaired) stays so until repaired.
 * The one thing an operation also refuses is a model with no point or no edge: the compiler calls that an error.
 * Mirror edits (`mirror: true`) find a point's twin by position, so they assume no two points share a spot; a model with doubled points can be edited,
 * but its twins may then pair up the wrong way.
 *
 *   fromAsset(asset) / toAsset(model)         stored <-> editing form (fromAsset throws an Error with a plain message; toAsset(fromAsset(x)) deep-equals x)
 *   newModel, cloneModel, boundingBox, modelSummary
 *   limitsOf, validateModel, validateAsset     the limits as live numbers; null = fine, else a message
 *   addPoint, movePoint, nudgePoint, deletePoint, deletePoints, removeLoosePoints     points (edges follow: a deleted point's edges go, higher indices shift down)
 *   join, unjoin, deleteEdge, findEdge, edgesOf, neighbours     edges (no self edge, no duplicate edge in either order)
 *   twinIndex, asymmetry, isSymmetric, makeSymmetric     mirror helpers (axis 'x' by default); `mirror: true` on add / move / delete / join / unjoin edits the twin too
 *   centre, scale, rotate90                    whole-model operations
 *   PRESETS, makePreset, applyPreset, ring     original starting shapes
 *   remapSelection, clampSelection             selection helpers (a selection is a list of point indices)
 *   VIEWS, VIEW_IDS, viewScale, projectToView, unprojectFromView, hitPoint, hitEdge     the three flat views (top = x,z; front = x,y; side = z,y)
 *   createHistory                              undo / redo (re-exported from sprite-model.js)
 */

"use strict";

import { createHistory } from './sprite-model.js';
import { MODEL_LIMITS } from '../lang/arcade/arcade-assetcheck.js';
import { validateAsset as projectValidate } from '../arcade-project.js';

export { createHistory };

// ── limits ────────────────────────────────────────────────────────────────────────────────────────────────────
export const MAX_POINTS = MODEL_LIMITS.points;
export const MAX_EDGES = MODEL_LIMITS.edges;
export const MAX_COORD = MODEL_LIMITS.coord;
export const AXES = Object.freeze(['x', 'y', 'z']);

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const isPoint = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isInteger);
const isEdge = (e) => Array.isArray(e) && e.length === 2 && e.every(Number.isInteger);
/** Round half away from zero (so a mirrored value rounds to the mirrored result); never -0. */
const rnd = (v) => Math.sign(v) * Math.round(Math.abs(v)) + 0;
const clampCoord = (v) => Math.max(-MAX_COORD, Math.min(MAX_COORD, rnd(v)));
const axisIndex = (a) => (typeof a === 'number' ? a : AXES.indexOf(a));
const ok = (extra = {}) => ({ ok: true, changed: true, ...extra });
const no = (message) => ({ ok: false, message });
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const samePoint = (p, q) => p[0] === q[0] && p[1] === q[1] && p[2] === q[2];
const samePair = (e, i, j) => (e[0] === i && e[1] === j) || (e[0] === j && e[1] === i);

// ── creation and the stored form ──────────────────────────────────────────────────────────────────────────────
/** A new model: the cube of the Studio's "+" (corners at +-20). */
export function newModel() { return makePreset('cube'); }
export function cloneModel(m) { return clone(m); }

/**
 * The stored asset -> the editing form. Accepts any stored model of the right shape (a list of points of three whole numbers and a list of edges of two),
 * even one beyond the limits, so that it can be repaired in the editor; throws an Error with a plain message when the shape is wrong.
 */
export function fromAsset(asset) {
  if (!isObj(asset)) throw new Error('the model is not an object');
  const bad = projectValidate('models', asset);
  if (bad) throw new Error(bad);
  const model = { points: clone(asset.points), edges: clone(asset.edges) };
  const extra = {};
  for (const k of Object.keys(asset)) if (k !== 'points' && k !== 'edges') extra[k] = clone(asset[k]);
  if (Object.keys(extra).length) model.extra = extra;
  return model;
}

/** The editing form -> the stored asset: points, edges, then the unknown keys written back. */
export function toAsset(model) {
  const out = { points: clone(model.points), edges: clone(model.edges) };
  if (model.extra) Object.assign(out, clone(model.extra));
  return out;
}

/** {min: [x, y, z], max: [x, y, z], size: [w, h, d]} of the points, or null with no point. */
export function boundingBox(model) {
  const pts = model.points.filter(isPoint);
  if (!pts.length) return null;
  const min = [0, 1, 2].map((a) => Math.min(...pts.map((p) => p[a]))), max = [0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a])));
  return { min, max, size: [0, 1, 2].map((a) => max[a] - min[a]) };
}

/** One line for the info panel: "8 points, 12 edges, 40 x 40 x 40". */
export function modelSummary(model) {
  const b = boundingBox(model);
  return `${plural(model.points.length, 'point')}, ${plural(model.edges.length, 'edge')}${b ? `, ${b.size.join(' x ')}` : ''}`;
}

// ── limits and validation ─────────────────────────────────────────────────────────────────────────────────────
/** The limits as live numbers: {points: {n, max, left}, edges: {n, max, left}, coord}. */
export function limitsOf(model) {
  const np = model.points.length, ne = model.edges.length;
  return { points: { n: np, max: MAX_POINTS, left: MAX_POINTS - np }, edges: { n: ne, max: MAX_EDGES, left: MAX_EDGES - ne }, coord: MAX_COORD };
}

/** Check an editing-form model against the compiler's limits (1..128 points, 1..255 edges, |c| <= 64, edges join two different existing points). null = fine, else a message. */
export function validateModel(model) {
  if (!isObj(model) || !Array.isArray(model.points) || !Array.isArray(model.edges)) return 'a model needs a list of points and a list of edges';
  const n = model.points.length;
  if (n < 1) return 'the model has no points';
  if (n > MAX_POINTS) return `the model has ${n} points; at most ${MAX_POINTS}`;
  if (model.edges.length < 1) return 'the model has no edges';
  if (model.edges.length > MAX_EDGES) return `the model has ${model.edges.length} edges; at most ${MAX_EDGES}`;
  for (let i = 0; i < n; i++) {
    const p = model.points[i];
    if (!isPoint(p)) return `point ${i} must be [x, y, z], three whole numbers`;
    if (p.some((c) => Math.abs(c) > MAX_COORD)) return `point ${i} has a coordinate beyond +-${MAX_COORD}`;
  }
  for (let k = 0; k < model.edges.length; k++) {
    const e = model.edges[k];
    if (!isEdge(e)) return `edge ${k} must be [i, j], two whole numbers`;
    if (e[0] === e[1]) return `edge ${k} joins a point to itself`;
    if (e.some((v) => v < 0 || v >= n)) return `edge ${k} names a point that does not exist (the points are 0..${n - 1})`;
  }
  return null;
}

/** The same check for a STORED asset (the shape as arcade-project's validateAsset does, then the limits). null = fine, else a message. */
export function validateAsset(asset) {
  let model;
  try { model = fromAsset(asset); } catch (e) { return e.message; }
  return validateModel(model);
}

// ── edges: look-ups ───────────────────────────────────────────────────────────────────────────────────────────
/** The index of the edge between points i and j (either order), or -1. */
export function findEdge(model, i, j) { return model.edges.findIndex((e) => samePair(e, i, j)); }
/** The indices of the edges that end at point i. */
export function edgesOf(model, i) { const out = []; model.edges.forEach((e, k) => { if (e[0] === i || e[1] === i) out.push(k); }); return out; }
/** The points joined to point i, in edge order. */
export function neighbours(model, i) { return edgesOf(model, i).map((k) => (model.edges[k][0] === i ? model.edges[k][1] : model.edges[k][0])); }

// ── points ────────────────────────────────────────────────────────────────────────────────────────────────────
const readPoint = (p) => (Array.isArray(p) && p.length === 3 && p.every(Number.isFinite) ? p.map(clampCoord) : null);
const mirrored = (p, a) => p.map((c, k) => (k === a ? rnd(-c) + 0 : c));

/**
 * The index of the point that mirrors point i across the plane `axis` = 0 (the point with that coordinate negated and the other two equal). A point
 * on the plane is its own twin (returns i); -1 when there is none.
 */
export function twinIndex(model, i, axis = 'x') {
  const a = axisIndex(axis), p = model.points[i];
  if (!isPoint(p) || a < 0) return -1;
  if (p[a] === 0) return i;
  const want = mirrored(p, a);
  return model.points.findIndex((q, j) => j !== i && isPoint(q) && samePoint(q, want));
}

/**
 * Add a point at [x, y, z] (rounded, clamped to +-64). With `mirror`, a point off the mirror plane brings its twin (the point's index is first, the twin's next).
 * @returns {{ok, changed, index, indices}} or a refusal (at 128 points)
 */
export function addPoint(model, p, { mirror = false, axis = 'x' } = {}) {
  const q = readPoint(p);
  if (!q) return no('A point needs three numbers: x, y and z.');
  const a = axisIndex(axis), withTwin = mirror && a >= 0 && q[a] !== 0;
  const need = withTwin ? 2 : 1;
  if (model.points.length + need > MAX_POINTS) {
    return no(withTwin && model.points.length + 1 <= MAX_POINTS ? `A mirrored point needs two places and the model has room for one more: at most ${MAX_POINTS} points. Turn the mirror off to add it alone.` : `A model has at most ${MAX_POINTS} points.`);
  }
  const index = model.points.length;
  model.points.push(q);
  const indices = [index];
  if (withTwin) { model.points.push(mirrored(q, a)); indices.push(index + 1); }
  return ok({ index, indices });
}

/**
 * Move point i to [x, y, z] (rounded, clamped). With `mirror` its twin moves to the mirror image (`twin`: the twin's index when the caller already
 * knows it, e.g. through a drag; else found now), and a point on the mirror plane stays on it.
 * @returns {{ok, changed, indices}} (`changed` false when it did not move)
 */
export function movePoint(model, i, p, { mirror = false, axis = 'x', twin } = {}) {
  if (!isPoint(model.points[i])) return no(`There is no point ${i}.`);
  const q = readPoint(p);
  if (!q) return no('A point needs three numbers: x, y and z.');
  const a = axisIndex(axis), old = model.points[i];
  let tw = -1;
  if (mirror && a >= 0) {
    tw = Number.isInteger(twin) ? twin : twinIndex(model, i, axis);
    if (old[a] === 0 || tw === i) { q[a] = 0; tw = -1; }                       // a point on the plane stays on it
  }
  const indices = [i];
  const before = JSON.stringify([model.points[i], tw >= 0 ? model.points[tw] : null]);
  model.points[i] = q;
  if (tw >= 0 && isPoint(model.points[tw])) { model.points[tw] = mirrored(q, a); indices.push(tw); }
  const changed = JSON.stringify([model.points[i], tw >= 0 ? model.points[tw] : null]) !== before;
  return { ok: true, changed, indices };
}

/** Move point i by (dx, dy, dz), as movePoint does (a move that would go past +-64 stops at the limit). */
export function nudgePoint(model, i, d, opts = {}) {
  const p = model.points[i];
  if (!isPoint(p)) return no(`There is no point ${i}.`);
  return movePoint(model, i, [p[0] + (d[0] ?? 0), p[1] + (d[1] ?? 0), p[2] + (d[2] ?? 0)], opts);
}

/**
 * Delete points (and with `mirror` their twins). The edges that end at a deleted point go with it and the indices above shift down.
 * Refused when it would leave no point or no edge.
 * @returns {{ok, changed, removed: [old indices, ascending], edgesRemoved, map}} `map[old] = new index or -1`, for remapSelection
 */
export function deletePoints(model, indices, { mirror = false, axis = 'x' } = {}) {
  const set = new Set();
  for (const i of indices) {
    if (!Number.isInteger(i) || i < 0 || i >= model.points.length) continue;
    set.add(i);
    if (mirror) { const t = twinIndex(model, i, axis); if (t >= 0) set.add(t); }
  }
  if (!set.size) return no('No point to delete.');
  if (set.size >= model.points.length) return no('A model needs at least one point.');
  const map = model.points.map((_, i) => -1);
  let n = 0;
  model.points.forEach((_, i) => { if (!set.has(i)) map[i] = n++; });
  const kept = model.edges.filter((e) => isEdge(e) && map[e[0]] >= 0 && map[e[1]] >= 0);
  if (!kept.length) return no('A model needs at least one edge: deleting this would leave none.');
  const edgesRemoved = model.edges.length - kept.length;
  model.points = model.points.filter((_, i) => !set.has(i));
  model.edges = kept.map((e) => [map[e[0]], map[e[1]]]);
  return ok({ removed: [...set].sort((x, y) => x - y), edgesRemoved, map });
}
export function deletePoint(model, i, opts = {}) { return deletePoints(model, [i], opts); }

/** Delete the points that are on no edge (nothing is drawn there; the asset check warns about them). `changed` is false when there are none. */
export function removeLoosePoints(model) {
  const used = new Set();
  for (const e of model.edges) if (isEdge(e)) { used.add(e[0]); used.add(e[1]); }
  const loose = model.points.map((_, i) => i).filter((i) => !used.has(i));
  if (!loose.length) return { ok: true, changed: false, removed: [], edgesRemoved: 0, map: model.points.map((_, i) => i) };
  return deletePoints(model, loose);
}

// ── edges: edits ──────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Join points i and j with an edge (one edge per pair, in either order; never a point to itself). With `mirror` the twins are joined too.
 * @returns {{ok, changed, added: [edge indices], edges: [[i, j]...]}} or a refusal
 */
export function join(model, i, j, { mirror = false, axis = 'x' } = {}) {
  const n = model.points.length;
  if (!Number.isInteger(i) || !Number.isInteger(j) || i < 0 || j < 0 || i >= n || j >= n) return no('Both ends of an edge must be points of the model.');
  if (i === j) return no('A point cannot be joined to itself.');
  if (findEdge(model, i, j) >= 0) return no(`Points ${i} and ${j} are already joined.`);
  const pairs = [[i, j]];
  if (mirror) {
    const ti = twinIndex(model, i, axis), tj = twinIndex(model, j, axis);
    if (ti >= 0 && tj >= 0 && ti !== tj && !samePair([i, j], ti, tj) && findEdge(model, ti, tj) < 0) pairs.push([ti, tj]);
  }
  if (model.edges.length + pairs.length > MAX_EDGES) return no(`A model has at most ${MAX_EDGES} edges.`);
  const added = [];
  for (const pr of pairs) { added.push(model.edges.length); model.edges.push(pr); }
  return ok({ added, edges: pairs.map((pr) => pr.slice()) });
}

/** Remove the edge between i and j (and with `mirror` the twins' edge). Refused when they are not joined, or when it would leave the model no edge. */
export function unjoin(model, i, j, { mirror = false, axis = 'x' } = {}) {
  const ks = new Set();
  const k0 = findEdge(model, i, j);
  if (k0 < 0) return no(`Points ${i} and ${j} are not joined.`);
  ks.add(k0);
  if (mirror) {
    const ti = twinIndex(model, i, axis), tj = twinIndex(model, j, axis);
    if (ti >= 0 && tj >= 0) { const k = findEdge(model, ti, tj); if (k >= 0) ks.add(k); }
  }
  return removeEdges(model, ks);
}

/** Delete edge k. Refused when it is the only edge. */
export function deleteEdge(model, k) {
  if (!Number.isInteger(k) || k < 0 || k >= model.edges.length) return no(`There is no edge ${k}.`);
  return removeEdges(model, new Set([k]));
}

function removeEdges(model, ks) {
  if (ks.size >= model.edges.length) return no('A model needs at least one edge.');
  const gone = model.edges.filter((_, k) => ks.has(k));
  model.edges = model.edges.filter((_, k) => !ks.has(k));
  return ok({ removed: [...ks].sort((a, b) => a - b), edges: gone });
}

// ── mirror helpers ────────────────────────────────────────────────────────────────────────────────────────────
/**
 * What stops the model being symmetric across the plane `axis` = 0: {points: [indices with no twin], edges: [indices whose mirror edge is missing]}.
 */
export function asymmetry(model, axis = 'x') {
  const a = axisIndex(axis);
  const tw = model.points.map((_, i) => twinIndex(model, i, a));
  const points = [], edges = [];
  tw.forEach((t, i) => { if (t < 0) points.push(i); });
  model.edges.forEach((e, k) => {
    if (!isEdge(e)) return;
    const t0 = tw[e[0]], t1 = tw[e[1]];
    if (t0 < 0 || t1 < 0 || findEdge(model, t0, t1) < 0) edges.push(k);
  });
  return { points, edges };
}
/** True when every point has its twin across the plane (a point on it is its own) and every edge its mirror edge. */
export function isSymmetric(model, axis = 'x') { const r = asymmetry(model, axis); return !r.points.length && !r.edges.length; }

/**
 * Make the model symmetric by adding what is missing: a twin for each point without one, and the mirror of each edge. Nothing is moved or deleted.
 * @returns {{ok, changed, addedPoints, addedEdges}} (`changed` false when it already is); refused when the result would pass 128 points or 255 edges
 */
export function makeSymmetric(model, axis = 'x') {
  const a = axisIndex(axis);
  if (a < 0) return no('The mirror axis is x, y or z.');
  const n = model.points.length;
  const tw = model.points.map((_, i) => twinIndex(model, i, a));
  const missing = tw.map((t, i) => (t < 0 ? i : -1)).filter((i) => i >= 0);
  const next = [...model.points];
  missing.forEach((i) => { tw[i] = next.length; next.push(mirrored(model.points[i], a)); });
  if (next.length > MAX_POINTS) return no(`Making it symmetric needs ${next.length} points; a model has at most ${MAX_POINTS}.`);
  const have = new Set(model.edges.map((e) => (e[0] < e[1] ? `${e[0]},${e[1]}` : `${e[1]},${e[0]}`)));
  const add = [];
  for (const e of model.edges) {
    if (!isEdge(e) || e[0] >= n || e[1] >= n) continue;
    const t0 = tw[e[0]], t1 = tw[e[1]];
    if (t0 === t1) continue;
    const key = t0 < t1 ? `${t0},${t1}` : `${t1},${t0}`;
    if (!have.has(key)) { have.add(key); add.push([t0, t1]); }
  }
  if (model.edges.length + add.length > MAX_EDGES) return no(`Making it symmetric needs ${model.edges.length + add.length} edges; a model has at most ${MAX_EDGES}.`);
  if (!missing.length && !add.length) return { ok: true, changed: false, addedPoints: 0, addedEdges: 0 };
  model.points = next;
  model.edges.push(...add);
  return ok({ addedPoints: missing.length, addedEdges: add.length });
}

// ── whole-model operations ────────────────────────────────────────────────────────────────────────────────────
/** Move the model so the middle of its bounding box is at 0, 0, 0 (to whole numbers: a half rounds away from zero). `changed` false when it is. */
export function centre(model) {
  const b = boundingBox(model);
  if (!b) return no('The model has no points.');
  const shift = [0, 1, 2].map((a) => rnd(-(b.min[a] + b.max[a]) / 2));
  if (shift.every((s) => s === 0)) return { ok: true, changed: false, shift };
  const pts = model.points.map((p) => (isPoint(p) ? p.map((c, a) => c + shift[a]) : p));
  if (pts.some((p) => isPoint(p) && p.some((c) => Math.abs(c) > MAX_COORD))) return no(`Centring would put a point beyond +-${MAX_COORD}.`);
  model.points = pts;
  return ok({ shift });
}

/**
 * Scale the model about 0, 0, 0 by `factor` (> 0; each coordinate rounded to a whole number, a half away from zero). Refused when a coordinate would pass
 * +-64 (the largest it can have is named), or when two different points would land on the same place.
 */
export function scale(model, factor) {
  if (!(Number.isFinite(factor) && factor > 0)) return no('The scale factor must be a number above 0.');
  const pts = model.points.map((p) => (isPoint(p) ? p.map((c) => rnd(c * factor)) : p));
  const big = Math.max(0, ...pts.filter(isPoint).map((p) => Math.max(...p.map(Math.abs))));
  if (big > MAX_COORD) return no(`Scaling by ${factor} would take a coordinate to ${big}; the limit is ${MAX_COORD}.`);
  const seenAfter = new Map();
  for (let i = 0; i < pts.length; i++) {
    if (!isPoint(pts[i])) continue;
    const key = pts[i].join(',');
    if (seenAfter.has(key) && !samePoint(model.points[seenAfter.get(key)], model.points[i])) return no(`Scaling by ${factor} would put points ${seenAfter.get(key)} and ${i} on the same spot.`);
    if (!seenAfter.has(key)) seenAfter.set(key, i);
  }
  const changed = JSON.stringify(pts) !== JSON.stringify(model.points);
  model.points = pts;
  return { ok: true, changed };
}

/**
 * Turn the model a quarter turn about an axis through 0, 0, 0 (right-handed: dir 1 turns y towards z about x, z towards x about y, x towards y about z; dir -1 the
 * other way). Four turns are the identity, and the coordinates stay inside the limits.
 *   about x: (x, y, z) -> (x, -z, y)    about y: (x, y, z) -> (z, y, -x)    about z: (x, y, z) -> (-y, x, z)
 */
export function rotate90(model, axis, dir = 1) {
  const a = axisIndex(axis);
  if (a < 0) return no('The axis is x, y or z.');
  const f = a === 0 ? ([x, y, z]) => [x, -z, y] : a === 1 ? ([x, y, z]) => [z, y, -x] : ([x, y, z]) => [-y, x, z];
  const g = a === 0 ? ([x, y, z]) => [x, z, -y] : a === 1 ? ([x, y, z]) => [-z, y, x] : ([x, y, z]) => [y, -x, z];
  const turn = dir < 0 ? g : f;
  const next = model.points.map((p) => (isPoint(p) ? turn(p).map((c) => c + 0) : p));
  const changed = JSON.stringify(next) !== JSON.stringify(model.points);
  model.points = next;
  return { ok: true, changed };
}

// ── presets ───────────────────────────────────────────────────────────────────────────────────────────────────
/** A ring of n points (3..128) in the x-y plane, radius r, joined in order: n points, n edges. */
export function ring(n = 8, r = 48) {
  const k = Math.max(3, Math.min(MAX_POINTS, Math.round(n)));
  const rr = Math.max(1, Math.min(MAX_COORD, Math.round(r)));
  const points = [], edges = [];
  for (let i = 0; i < k; i++) {
    points.push([rnd(rr * Math.cos(2 * Math.PI * i / k)), rnd(rr * Math.sin(2 * Math.PI * i / k)), 0]);
    edges.push([i, (i + 1) % k]);
  }
  return { points, edges };
}

/** The presets (original shapes, all inside the limits): {id, title, about, make(opts) -> {points, edges}}. */
export const PRESETS = Object.freeze([
  { id: 'cube', title: 'Cube', about: '8 points, 12 edges: a box 40 across.', make: () => ({
    points: [[-20, -20, -20], [20, -20, -20], [20, 20, -20], [-20, 20, -20], [-20, -20, 20], [20, -20, 20], [20, 20, 20], [-20, 20, 20]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]] }) },
  { id: 'pyramid', title: 'Pyramid', about: '5 points, 8 edges: a square base and a point above it.', make: () => ({
    points: [[-24, -20, -24], [24, -20, -24], [24, -20, 24], [-24, -20, 24], [0, 28, 0]],
    edges: [[0, 1], [1, 2], [2, 3], [3, 0], [0, 4], [1, 4], [2, 4], [3, 4]] }) },
  { id: 'ring', title: 'Ring of n', about: 'n points in a circle, joined in order (3 to 128; n is the number box).', make: ({ n = 8 } = {}) => ring(n) },
  { id: 'dart', title: 'Dart ship', about: '6 points, 12 edges: a nose, two wing tips, a tail, a fin and a keel; the same on both sides.', make: () => ({
    points: [[0, 0, 48], [-36, 0, -32], [36, 0, -32], [0, 0, -16], [0, 16, -28], [0, -8, -24]],
    edges: [[0, 1], [0, 2], [1, 3], [2, 3], [0, 4], [4, 3], [4, 1], [4, 2], [0, 5], [5, 3], [5, 1], [5, 2]] }) },
  { id: 'rock', title: 'Rock', about: '7 points, 15 edges: a lopsided double pyramid, not the same on both sides.', make: () => ({
    points: [[2, 34, -4], [-4, -32, 6], [32, 6, 4], [12, -4, 30], [-26, 8, 20], [-30, -6, -14], [8, 4, -32]],
    edges: [[2, 3], [3, 4], [4, 5], [5, 6], [6, 2], [0, 2], [0, 3], [0, 4], [0, 5], [0, 6], [1, 2], [1, 3], [1, 4], [1, 5], [1, 6]] }) },
]);

/** A preset's {points, edges} by id (`opts.n` for the ring). Throws an Error for an unknown id. */
export function makePreset(id, opts = {}) {
  const p = PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`there is no preset "${id}"`);
  return p.make(opts);
}

/** Replace the model's points and edges by a preset's (unknown keys stay). Returns {ok, changed} or a refusal for an unknown id. */
export function applyPreset(model, id, opts = {}) {
  let m;
  try { m = makePreset(id, opts); } catch (e) { return no(`${e.message}.`); }
  model.points = m.points; model.edges = m.edges;
  return ok();
}

// ── selection helpers ─────────────────────────────────────────────────────────────────────────────────────────
/** After points were deleted (`map` from deletePoints): the selection with the deleted ones dropped and the rest renumbered. */
export function remapSelection(sel, map) { return sel.map((i) => map[i]).filter((i) => Number.isInteger(i) && i >= 0); }
/** The selection kept to points that exist (and listed once). */
export function clampSelection(sel, n) { return [...new Set(sel)].filter((i) => Number.isInteger(i) && i >= 0 && i < n); }

// ── the three flat views ──────────────────────────────────────────────────────────────────────────────────────
/** A view shows two of the three axes: `h` across (to the right), `v` up the screen. Top: x across, z up (forward). Front: x across, y up. Side: z across, y up. */
export const VIEWS = Object.freeze({
  top: Object.freeze({ id: 'top', title: 'Top', h: 0, v: 2, hName: 'x', vName: 'z', third: 1, thirdName: 'y' }),
  front: Object.freeze({ id: 'front', title: 'Front', h: 0, v: 1, hName: 'x', vName: 'y', third: 2, thirdName: 'z' }),
  side: Object.freeze({ id: 'side', title: 'Side', h: 2, v: 1, hName: 'z', vName: 'y', third: 0, thirdName: 'x' }),
});
export const VIEW_IDS = Object.freeze(['top', 'front', 'side']);
export const VIEW_PAD = 6;                   // units of room round +-64 in a view
/** Pixels per model unit in a square view `size` pixels wide: the +-64 range plus the padding fills it. */
export function viewScale(size) { return size / (2 * (MAX_COORD + VIEW_PAD)); }

/** A model point -> [px, py] in a view of `size` pixels (the origin at the middle, y down the screen). */
export function projectToView(view, p, size) {
  const v = VIEWS[view], s = viewScale(size), c = size / 2;
  return [c + p[v.h] * s, c - p[v.v] * s];
}

/**
 * A view pixel -> a model point: the two axes of the view from the pixel (rounded to a multiple of `snap`, clamped to +-64), the third from `keep`
 * (the selected point; default 0, 0, 0).
 */
export function unprojectFromView(view, px, py, size, { keep = [0, 0, 0], snap = 1 } = {}) {
  const v = VIEWS[view], s = viewScale(size), c = size / 2;
  const st = Math.max(1, Math.round(snap));
  const q = (u) => clampCoord(rnd(u / st) * st);
  const out = keep.slice(0, 3).map((x) => clampCoord(x));
  out[v.h] = q((px - c) / s);
  out[v.v] = q((c - py) / s);
  return out;
}

/**
 * The point nearest to a view pixel within `radius` pixels, or -1. When two are as near (they overlap in this view), one in `prefer` wins, else the lowest
 * index.
 */
export function hitPoint(model, view, px, py, size, radius = 7, prefer = []) {
  let best = -1, bd = Infinity;
  model.points.forEach((p, i) => {
    if (!isPoint(p)) return;
    const [x, y] = projectToView(view, p, size), d = Math.hypot(x - px, y - py);
    if (d > radius) return;
    if (d < bd - 0.01 || (Math.abs(d - bd) <= 0.01 && !prefer.includes(best) && prefer.includes(i))) { best = i; bd = d; }
  });
  return best;
}

/** The edge nearest to a view pixel within `radius` pixels, or -1. */
export function hitEdge(model, view, px, py, size, radius = 5) {
  let best = -1, bd = Infinity;
  model.edges.forEach((e, k) => {
    if (!isEdge(e) || !isPoint(model.points[e[0]]) || !isPoint(model.points[e[1]])) return;
    const [ax, ay] = projectToView(view, model.points[e[0]], size), [bx, by] = projectToView(view, model.points[e[1]], size);
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
    const d = Math.hypot(ax + t * dx - px, ay + t * dy - py);
    if (d <= radius && d < bd) { best = k; bd = d; }
  });
  return best;
}
