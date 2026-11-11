"use strict";
// Wireframe spike: the JS reference. Every routine here is the exact integer model of the Z80 code (lines.asm, clear.asm,
// proj.asm); the harness compares the machine's memory with it bit for bit. idealPixels() is an independent brute-force
// definition of a clipped line, used to check that lineSetup() keeps exactly the unclipped line's pixels.

// ---- tables (written into the machine by lib.mjs) ----------------------------------------------------------------------
export const SIN = Int8Array.from({ length: 256 }, (_, i) => Math.round(64 * Math.sin(2 * Math.PI * i / 256)));
export const QS = Uint16Array.from({ length: 256 }, (_, i) => { const n = i < 128 ? i : i - 256; return Math.floor(n * n / 4); });
export const RCPT = Uint8Array.from({ length: 256 }, (_, m) => m >= 128 ? Math.floor(32767 / m) : 0);
export const SQU = Uint16Array.from({ length: 512 }, (_, n) => Math.floor(n * n / 4));
export const NEAR = 16, QMAX = 16000;

// ---- screen ------------------------------------------------------------------------------------------------------------
export const scrOff = (x, y) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2) | (x >> 3);
export const FULL = { xmin: 0, xmax: 255, ymin: 0, ymax: 191 };

// ---- lines -------------------------------------------------------------------------------------------------------------
const cdiv = (a, b) => Math.floor((a + b - 1) / b);          // ceil for a >= 0, b > 0
/** The visible part of the line as the Z80's line_setup leaves it, or null. Coordinates |v| <= 16383. */
export function lineSetup(x0, y0, x1, y1, R = FULL) {
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
export const linePixels = (x0, y0, x1, y1, R = FULL) => stepPixels(lineSetup(x0, y0, x1, y1, R));
/** Brute force: every pixel of the unclipped line (same normalisation and rounding), kept if inside R. */
export function idealPixels(x0, y0, x1, y1, R = FULL) {
  const ymaj = Math.abs(x1 - x0) < Math.abs(y1 - y0);
  if (!ymaj ? x1 < x0 : y1 < y0) [x0, y0, x1, y1] = [x1, y1, x0, y0];
  const [u0, v0, u1, v1] = ymaj ? [y0, x0, y1, x1] : [x0, y0, x1, y1];
  const du = u1 - u0, dv = Math.abs(v1 - v0), s = v1 < v0 ? -1 : 1, out = [];
  for (let k = 0; k <= du; k++) {
    const v = v0 + s * (du ? Math.floor((2 * k * dv + du) / (2 * du)) : 0), u = u0 + k;
    const [x, y] = ymaj ? [v, u] : [u, v];
    if (x >= R.xmin && x <= R.xmax && y >= R.ymin && y <= R.ymax) out.push([x, y]);
  }
  return out;
}
/** Apply pixels to a 6,144-byte bitmap: mode 0 OR, 1 XOR, 2 ERASE. */
export function applyPixels(bm, px, mode) {
  for (const [x, y] of px) {
    const o = scrOff(x, y), b = 0x80 >> (x & 7);
    bm[o] = mode === 0 ? bm[o] | b : mode === 1 ? bm[o] ^ b : bm[o] & ~b;
  }
}

// ---- clear -------------------------------------------------------------------------------------------------------------
export function clearRows(bm, r0, r1) { for (let y = r0 * 8; y < (r1 + 1) * 8; y++) for (let c = 0; c < 32; c++) bm[scrOff(c * 8, y)] = 0; }

// ---- 3D ----------------------------------------------------------------------------------------------------------------
const mulr = (a, b) => (a * b + 32) >> 6;
export function buildMatrix(yaw, pitch) {
  const sy = SIN[yaw & 255], cy = SIN[(yaw + 64) & 255], sp = SIN[pitch & 255], cp = SIN[(pitch + 64) & 255];
  return [cy, 0, sy, mulr(sp, sy), cp, -mulr(sp, cy), -mulr(cp, sy), sp, mulr(cp, cy)];
}
const wrap16 = v => ((v + 0x8000) & 0xFFFF) - 0x8000;
/** q(|v|) for the two projectors; returns -1 for "too far" (flag 2). */
function qAbs(a, Z, proj) {
  if (proj === 1) {
    if ((a >> 9) >= Z) return -1;
    const q = Math.floor(a * 128 / Z);
    return q > QMAX ? -1 : q;
  }
  let z = Z, e = 0;
  if (z >= 256) { while (z >= 256) { z >>= 1; e++; } } else while (z < 128) { z <<= 1; e--; }
  if (proj === 3) {                                           // 8-bit fast path, else the P2 path
    const w = e > 0 ? (a + (1 << (e - 1))) >> e : a << -e;
    if (w <= 255) return (w * RCPT[z]) >> 8;
  }
  let P = a * RCPT[z], q;
  if (e >= 0) q = (P >> 8) >> e;
  else { P *= 2 ** -e; if (P >= 2 ** 24) return -1; q = P >> 8; }
  return q > QMAX ? -1 : q;
}
/** Records {sx, sy, flag} for model points [[x,y,z]...]; full = false uses the yaw-only rows (same result at pitch 0). */
export function project(pts, M, T, proj, full) {
  return pts.map(([x, y, z]) => {
    const rx = M[0] * x + (full ? M[1] * y : 0) + M[2] * z;
    const rz = M[6] * x + (full ? M[7] * y : 0) + M[8] * z;
    const X = wrap16(T[0] + ((rx + 32) >> 6));
    const Y = full ? wrap16(T[1] + ((M[3] * x + M[4] * y + M[5] * z + 32) >> 6)) : wrap16(T[1] + y);
    const Z = wrap16(T[2] + ((rz + 32) >> 6));
    if (Z < NEAR) return { flag: 1 };
    const qx = qAbs(Math.abs(X), Z, proj); if (qx < 0) return { flag: 2 };
    const qy = qAbs(Math.abs(Y), Z, proj); if (qy < 0) return { flag: 2 };
    const sx = 128 + (X < 0 ? -qx : qx), sy = 96 - (Y < 0 ? -qy : qy);
    return { sx, sy, flag: 0, X, Y, Z };
  });
}
/** The Z80's record flag: $80 near, $40 too far, else the outcode against R (1 left, 2 right, 4 top, 8 bottom). */
export const recFlag = (r, R) => r.flag === 1 ? 0x80 : r.flag === 2 ? 0x40
  : (r.sx < R.xmin ? 1 : r.sx > R.xmax ? 2 : 0) | (r.sy < R.ymin ? 4 : r.sy > R.ymax ? 8 : 0);
/** Exact perspective (floating point) of a camera-space point, for the projector error report. */
export const exactScreen = r => [128 + r.X * 128 / r.Z, 96 - r.Y * 128 / r.Z];
