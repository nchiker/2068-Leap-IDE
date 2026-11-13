/**
 * src/tools/model-preview.js — a small wireframe preview of a model asset (pure drawing helper; no project state, no DOM lookups).
 * Contract: docs/ARCADE_WIREFRAME_CONTRACT.md section 4 ("Studio"). A model is {points: [[x, y, z], ...], edges: [[i, j], ...]}
 * (section 2.1; x right, y UP, z forward). The preview is NOT the runtime's projection (that is the game's, arcade-wire.js): it
 * only shows the shape, turning about the vertical axis, with a fixed tilt and a mild perspective, scaled to fit the box.
 *
 *   previewSegments(model, yaw, w, h)       -> [[x0, y0, x1, y1], ...] in box pixels (y down); [] for a model it cannot read
 *   drawModelPreview(ctx, model, yaw, w, h, colors)   clears the box and strokes the segments; colors {line, bg} are CSS colour
 *                                           strings the caller read from the page's CSS variables (no colour is chosen here)
 *   PREVIEW_TILT                            the fixed pitch in radians (a little from above, so a flat model is not edge-on)
 */

"use strict";

export const PREVIEW_TILT = 0.45;

const isPoint = (p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite);

export function previewSegments(model, yaw, w, h) {
  const pts = Array.isArray(model?.points) ? model.points : [];
  const edges = Array.isArray(model?.edges) ? model.edges : [];
  if (!pts.length || !edges.length) return [];
  const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(PREVIEW_TILT), sp = Math.sin(PREVIEW_TILT);
  // turn about the vertical axis, then tilt about x; z is depth
  const cam = pts.map((p) => {
    if (!isPoint(p)) return null;
    const [x, y, z] = p;
    const x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    return [x1, y * cp - z1 * sp, y * sp + z1 * cp];
  });
  // fit: the largest distance from the model's centre of its bounding box decides the scale (so the turning shape never grows or shrinks)
  const ok = pts.filter(isPoint);
  if (!ok.length) return [];
  let r = 1;
  const mid = [0, 1, 2].map((a) => (Math.max(...ok.map((p) => p[a])) + Math.min(...ok.map((p) => p[a]))) / 2);
  for (const p of ok) r = Math.max(r, Math.hypot(p[0] - mid[0], p[1] - mid[1], p[2] - mid[2]));
  const dist = 3.2 * r;                                    // eye distance, in model units: a mild perspective
  const scale = (Math.min(w, h) / 2 - 2) / r * (1 - 0.5 * r / dist);
  // the centre in camera space (the same rotation of `mid`) keeps the shape in the middle of the box
  const mc = (() => { const [x, y, z] = mid; const x1 = x * cy + z * sy, z1 = -x * sy + z * cy; return [x1, y * cp - z1 * sp, y * sp + z1 * cp]; })();
  const proj = (q) => {
    if (!q) return null;
    const f = dist / (dist + (q[2] - mc[2]));
    return [w / 2 + (q[0] - mc[0]) * f * scale, h / 2 - (q[1] - mc[1]) * f * scale];
  };
  const out = [];
  for (const e of edges) {
    if (!Array.isArray(e)) continue;
    const a = proj(cam[e[0]]), b = proj(cam[e[1]]);
    if (a && b) out.push([a[0], a[1], b[0], b[1]]);
  }
  return out;
}

export function drawModelPreview(ctx, model, yaw, w, h, colors) {
  ctx.clearRect(0, 0, w, h);
  if (colors?.bg) { ctx.fillStyle = colors.bg; ctx.fillRect(0, 0, w, h); }
  ctx.strokeStyle = colors?.line ?? 'currentColor';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (const [x0, y0, x1, y1] of previewSegments(model, yaw, w, h)) { ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); }
  ctx.stroke();
}
