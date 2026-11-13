/**
 * src/lang/arcade/arcade-wire.js — Leap Arcade wireframe 3D (WIRE3D): the bit-exact reference (pure, no DOM, no node: imports).
 *
 * docs/ARCADE_WIREFRAME_CONTRACT.md sections 2.1-2.3, built from the spike's reference (arcade/spike/wire/ref.mjs) with the contract's
 * matrix order.  Runtime v2's wire.asm does exactly this; arcade/tests/m17-runtime-wire.mjs compares the two pixel for pixel.
 *   - the play area (`areaOf`): character rows r0..r1, all 256 columns; its clip rectangle and projection centre
 *   - lines (`drawLine`): the spike's pixel definition, clipped exactly to the play area, ORed into a 6,144-byte bitmap
 *   - models (`drawModel`): the eye transform (2.2), the matrix Ry(a - ea) Rx(p), SCALE, projector P2 with its flags, the edges
 *   - the play-area clear (`clearArea`)
 *   - COSA / SINA / FXMUL (re-exported from arcade-view.js: v2 and v4 share them)
 * Bitmaps are the ZX layout of one display file (offset 0 = $4000 or $6000).  Angles are 0..255 (256 to a turn).
 */

"use strict";

import { cosa, sina, fxmul } from './arcade-view.js';
export { cosa, sina, fxmul };

// ── constants and tables ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const NEAR = 16;            // a point with Zc < NEAR is "near": its edges are not drawn
export const QMAX = 16000;         // |projected offset| > QMAX is "too far": its edges are not drawn
export const DMAX = 16000;         // an object with |d| or |T| > DMAX is not drawn
export const LINE_MIN = -16384;    // LINE: a coordinate outside -16384..16383 draws nothing (the exact clip's range)
export const LINE_MAX = 16383;
export const MAX_POINTS = 128, MAX_EDGES = 255, MAX_COORD = 64;
export const SCALES = Object.freeze([1, 2, 4, 8]);
/** SIN8[k] = round(64 sin(2 pi k / 256)): int8, 1.0 = 64. */
export const SIN8 = Object.freeze(Array.from({ length: 256 }, (_, i) => Math.round(64 * Math.sin(2 * Math.PI * i / 256)) + 0));
/** P2's reciprocal: RCPT[m] = floor(32767 / m), m = 128..255. */
export const RCPT = Object.freeze(Array.from({ length: 256 }, (_, m) => (m >= 128 ? Math.floor(32767 / m) : 0)));

/** Offset of pixel (x, y) in a display file (ZX layout). */
export const scrOff = (x, y) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | (x >> 3);

/** The play area of WIRE3D ROWS r0 TO r1: clip rectangle x 0..255, y 8 r0 .. 8 r1 + 7; projection centre c = 4 (r0 + r1 + 1). */
export function areaOf(r0, r1) {
  return Object.freeze({ r0, r1, xmin: 0, xmax: 255, ymin: 8 * r0, ymax: 8 * r1 + 7, cy: 4 * (r0 + r1 + 1) });
}

// ── lines ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const cdiv = (a, b) => Math.floor((a + b - 1) / b);          // ceil for a >= 0, b > 0
/**
 * The visible part of a line: { x, y, n, oct, du, dv, acc } or null.  Pixel definition: normalise so that the major coordinate u
 * increases; s = sign of the minor delta; pixel k = 0..du is (u0 + k, v0 + s floor((2 k dv + du) / (2 du))).  Clipping keeps exactly
 * the pixels of that line inside R (the slope never changes).  (The spike's lineSetup.)
 */
export function lineSetup(x0, y0, x1, y1, R) {
  const ymaj = Math.abs(x1 - x0) < Math.abs(y1 - y0);
  let u0, v0, u1, v1, umin, umax, vmin, vmax;
  if (!ymaj) {
    if (x1 < x0) [x0, y0, x1, y1] = [x1, y1, x0, y0];
    [u0, v0, u1, v1, umin, umax, vmin, vmax] = [x0, y0, x1, y1, R.xmin, R.xmax, R.ymin, R.ymax];
  } else {
    if (y1 < y0) [x0, y0, x1, y1] = [x1, y1, x0, y0];
    [u0, v0, u1, v1, umin, umax, vmin, vmax] = [y0, x0, y1, x1, R.ymin, R.ymax, R.xmin, R.xmax];
  }
  const neg = v1 < v0;
  if (neg) { v0 = -v0; v1 = -v1; [vmin, vmax] = [-vmax, -vmin]; }
  const du = u1 - u0, dv = v1 - v0;
  if (u1 < umin || umax < u0 || v1 < vmin || vmax < v0) return null;
  let klo = u0 < umin ? umin - u0 : 0;
  if (v0 < vmin) klo = Math.max(klo, cdiv(du * (2 * (vmin - v0) - 1), 2 * dv));
  let khi = umax < u1 ? umax - u0 : du;
  if (vmax < v1) khi = Math.min(khi, cdiv(du * (2 * (vmax - v0) + 1), 2 * dv) - 1);
  if (khi < klo) return null;
  let m = 0, acc = du;
  if (klo > 0) { const num = 2 * klo * dv + du; m = Math.floor(num / (2 * du)); acc = num - m * 2 * du; }
  const u = u0 + klo, v = neg ? -(v0 + m) : v0 + m;
  return { x: ymaj ? v : u, y: ymaj ? u : v, n: khi - klo + 1, oct: (ymaj ? 1 : 0) | (neg ? 2 : 0), du, dv, acc };
}
/** The pixels [[x, y], ...] of a line setup, in drawing order. */
export function stepPixels(st) {
  const out = [];
  if (!st) return out;
  let { x, y, n, oct, du, dv, acc } = st;
  const s = oct & 2 ? -1 : 1;
  for (let i = 0; i < n; i++) {
    out.push([x, y]);
    if (oct & 1) y++; else x++;
    acc += 2 * dv;
    if (acc >= 2 * du) { acc -= 2 * du; if (oct & 1) x += s; else y += s; }
  }
  return out;
}
/** The visible pixels of the line (x0, y0) - (x1, y1) clipped to R (ends within -16384..16383). */
export const linePixels = (x0, y0, x1, y1, R) => stepPixels(lineSetup(x0, y0, x1, y1, R));
/** OR the pixels into a bitmap. */
export function orPixels(bm, px) {
  for (const [x, y] of px) bm[scrOff(x, y)] |= 0x80 >> (x & 7);
}
const inLineRange = (v) => v >= LINE_MIN && v <= LINE_MAX;
/**
 * LINE x0, y0 TO x1, y1 (signed 16-bit values): ORed into `bm`, clipped exactly to the play area.  A coordinate outside
 * -16384..16383 draws nothing.  Returns the number of pixels drawn.
 */
export function drawLine(bm, x0, y0, x1, y1, area) {
  if (![x0, y0, x1, y1].every(inLineRange)) return 0;
  const px = linePixels(x0, y0, x1, y1, area);
  orPixels(bm, px);
  return px.length;
}

// ── the play-area clear ─────────────────────────────────────────────────────────────────────────────────────────────────────────
/** Character rows r0..r1 (all 32 columns) of the bitmap to 0. */
export function clearArea(bm, area) {
  for (let y = area.r0 * 8; y < (area.r1 + 1) * 8; y++) for (let c = 0; c < 32; c++) bm[scrOff(c * 8, y)] = 0;
}

// ── 3D ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const mulr = (a, b) => (a * b + 32) >> 6;
/** The rotation (contract 2.3): Ry(y') Rx(p), y' = (a - ea) AND 255.  Row-major 9 int8 entries (1.0 = 64). */
export function buildMatrix(yawRel, pitch) {
  const y = yawRel & 255, p = pitch & 255;
  const cy = SIN8[(y + 64) & 255], sy = SIN8[y], cp = SIN8[(p + 64) & 255], sp = SIN8[p];
  return [cy, mulr(sy, sp), mulr(sy, cp), 0, cp, -sp, -sy, mulr(cy, sp), mulr(cy, cp)];
}
/** An eye: { x, y, z, a } (a heading 0..255); the boot / ENTER value is 0, 0, 0, 0. */
export const EYE0 = Object.freeze({ x: 0, y: 0, z: 0, a: 0 });
/**
 * The eye transform (contract 2.2): T = (Tx, Ty, Tz) of an object at (x, y, z), or null when it is not drawn
 * (some |d| > DMAX or some |T| > DMAX).
 */
export function eyeTransform(eye, x, y, z) {
  const dx = x - eye.x, dy = y - eye.y, dz = z - eye.z;
  if (Math.abs(dx) > DMAX || Math.abs(dy) > DMAX || Math.abs(dz) > DMAX) return null;
  const C = cosa(eye.a), S = sina(eye.a);
  const Tx = Math.floor((dx * C - dz * S) / 256), Ty = dy, Tz = Math.floor((dx * S + dz * C) / 256);
  if (Math.abs(Tx) > DMAX || Math.abs(Tz) > DMAX) return null;
  return [Tx, Ty, Tz];
}
/** P2: q(|v|) at depth Z (Z >= NEAR), or -1 when too far. */
function qAbs(a, Z) {
  let z = Z, e = 0;
  if (z >= 256) { while (z >= 256) { z >>= 1; e++; } } else while (z < 128) { z <<= 1; e--; }
  let P = a * RCPT[z], q;
  if (e >= 0) q = (P >> 8) >> e;
  else { P *= 2 ** -e; if (P >= 2 ** 24) return -1; q = P >> 8; }
  return q > QMAX ? -1 : q;
}
/**
 * Project the model's points: records { flag, sx, sy } (flag: $80 near, $40 too far, else the outcode against the area:
 * 1 x < 0, 2 x > 255, 4 above, 8 below; 0 = inside).  T from eyeTransform, M from buildMatrix, k = log2 SCALE.
 */
export function projectPoints(points, M, T, k, area) {
  const s = 1 << k;
  return points.map(([px, py, pz]) => {
    const row = (i) => T[i] + (((M[3 * i] * px + M[3 * i + 1] * py + M[3 * i + 2] * pz) * s + 32) >> 6);
    const X = row(0), Y = row(1), Z = row(2);
    if (Z < NEAR) return { flag: 0x80 };
    const qx = qAbs(Math.abs(X), Z); if (qx < 0) return { flag: 0x40 };
    const qy = qAbs(Math.abs(Y), Z); if (qy < 0) return { flag: 0x40 };
    const sx = 128 + (X < 0 ? -qx : qx), sy = area.cy - (Y < 0 ? -qy : qy);
    const flag = (sx < area.xmin ? 1 : sx > area.xmax ? 2 : 0) | (sy < area.ymin ? 4 : sy > area.ymax ? 8 : 0);
    return { flag, sx, sy };
  });
}
/** Check a model { points: [[x, y, z]...], edges: [[i, j]...] } against contract 2.1; returns an error text or null. */
export function modelError(model) {
  const { points, edges } = model ?? {};
  if (!Array.isArray(points) || points.length < 1 || points.length > MAX_POINTS) return `a model has 1..${MAX_POINTS} points`;
  if (!Array.isArray(edges) || edges.length < 1 || edges.length > MAX_EDGES) return `a model has 1..${MAX_EDGES} edges`;
  for (const p of points) if (!Array.isArray(p) || p.length !== 3 || !p.every((c) => Number.isInteger(c) && Math.abs(c) <= MAX_COORD)) return `a point is three integers -${MAX_COORD}..${MAX_COORD}`;
  for (const e of edges) if (!Array.isArray(e) || e.length !== 2 || !e.every((i) => Number.isInteger(i) && i >= 0 && i < points.length) || e[0] === e[1]) return 'an edge joins two different points of the model';
  return null;
}
/** The model's game image (contract 2.1): DB npts, DB nedges, npts x (DB x, y, z), nedges x (DB i, j). */
export function modelBytes(model) {
  return [model.points.length, model.edges.length, ...model.points.flat().map((c) => c & 255), ...model.edges.flat()];
}
/**
 * DRAWMODEL: draws `model` ({ points, edges }) ORed into `bm`, posed at pose = { x, y, z, yaw, pitch, scale } (scale 1, 2, 4 or 8;
 * yaw / pitch default 0), seen from `eye` ({ x, y, z, a }), clipped to `area`.  An edge with a near or too-far end is not drawn.
 * Returns the number of pixels drawn (0 when the object is not drawn).
 */
export function drawModel(bm, model, pose, eye, area) {
  const T = eyeTransform(eye, pose.x, pose.y, pose.z);
  if (!T) return 0;
  const k = SCALES.indexOf(pose.scale ?? 1);
  if (k < 0) throw new Error('SCALE is 1, 2, 4 or 8');
  const M = buildMatrix(((pose.yaw ?? 0) - eye.a) & 255, (pose.pitch ?? 0) & 255);
  const recs = projectPoints(model.points, M, T, k, area);
  let n = 0;
  for (const [i, j] of model.edges) {
    const a = recs[i], b = recs[j];
    if ((a.flag | b.flag) & 0xC0) continue;
    if (a.flag & b.flag) continue;                              // both off the same side: no pixel would be inside
    const px = linePixels(a.sx, a.sy, b.sx, b.sy, area);
    orPixels(bm, px);
    n += px.length;
  }
  return n;
}
