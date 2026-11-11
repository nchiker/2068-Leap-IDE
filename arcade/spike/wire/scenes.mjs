"use strict";
// Wireframe spike: the three test scenes (frame f), and the edge classification used in the report.
import { recFlag } from './ref.mjs';

export function shipModel() {
  const pts = [], edges = [];
  for (let k = 0; k < 6; k++) pts.push([Math.round(20 * Math.cos(k * Math.PI / 3)), Math.round(12 * Math.sin(k * Math.PI / 3)), 40]);
  for (let k = 0; k < 6; k++) pts.push([Math.round(50 * Math.cos(k * Math.PI / 3)), Math.round(25 * Math.sin(k * Math.PI / 3)), -40]);
  for (let k = 0; k < 6; k++) edges.push([k, (k + 1) % 6], [6 + k, 6 + (k + 1) % 6], [k, 6 + k]);
  return { pts, edges };
}
/** size: ships 1..4; landscape grid side (odd, <= 9); tunnel rings. model: ships use the compiled model. */
export function makeScene(name, f, size, model = false) {
  const objs = [], edges = [];
  const add = (pts, e, o) => { const first = objs.reduce((s, ob) => s + ob.pts.length, 0); objs.push({ ...o, pts, first }); for (const [a, b] of e) edges.push([first + a, first + b]); };
  if (name === 'ships') {
    const s = shipModel();
    const pos = [[-150, -60, 500], [180, 50, 700], [-60, 90, 350], [250, -80, 1000]].slice(0, size ?? 4);
    pos.forEach((T, i) => add(s.pts, s.edges, { T, yaw: 20 * f + 64 * i, pitch: 12 * f + 30 * i, full: true, model }));
  } else if (name === 'landscape') {
    const pts = [], e = [], g = size ?? 9, h = (g - 1) >> 1;
    for (let j = -h; j <= h; j++) for (let i = -h; i <= h; i++) pts.push([16 * i, Math.round(10 * Math.sin((i + 4) * 0.9 + f * 0.3) * Math.cos((j + 4) * 0.7)), 16 * j]);
    for (let j = 0; j < g; j++) for (let i = 0; i < g; i++) { if (i < g - 1) e.push([j * g + i, j * g + i + 1]); if (j < g - 1) e.push([j * g + i, (j + 1) * g + i]); }
    add(pts, e, { T: [0, -28, 110], yaw: 6 * f, pitch: 0, full: false });
  } else if (name === 'tunnel') {
    const ring = Array.from({ length: 8 }, (_, k) => [Math.round(60 * Math.cos(k * Math.PI / 4)), Math.round(60 * Math.sin(k * Math.PI / 4)), 0]);
    for (let r = 0; r < (size ?? 8); r++) {
      const z = 64 + 72 * r - (f * 9) % 72;
      add(ring, ring.map((_, k) => [k, (k + 1) % 8]), { T: [Math.round(25 * Math.sin(0.6 * r + 0.4 * f)), Math.round(18 * Math.cos(0.5 * r + 0.3 * f)), z], yaw: 0, pitch: 0, full: false });
      if (r > 0) for (let k = 0; k < 8; k++) edges.push([(r - 1) * 8 + k, r * 8 + k]);
    }
  }
  return { objs, edges, npts: objs.reduce((s, o) => s + o.pts.length, 0) };
}
/** How draw_edges treats each edge of a projected frame: fast (both ends inside), clip (draw_line), reject, skip (near / far). */
export function edgeClasses(sc, recs, R) {
  const c = { fast: 0, clip: 0, reject: 0, skip: 0 };
  for (const [a, b] of sc.edges) {
    const fa = recFlag(recs[a], R), fb = recFlag(recs[b], R);
    if (!(fa | fb)) c.fast++; else if ((fa | fb) & 0xC0) c.skip++; else if (fa & fb) c.reject++; else c.clip++;
  }
  return c;
}
