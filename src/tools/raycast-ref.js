"use strict";
// raycast-ref.js -- the JS REFERENCE of the v4 raycaster (the walls only), pure: no DOM, no node: imports; Node and the browser import it.
//
// It was written from docs/ARCADE_RAYCASTER_CONTRACT.md (sections 2-4) and docs/ARCADE_RUNTIME_API_V4.md "As built" (the exact integer rules) and lived in
// arcade/tests/m8-common.mjs, which the runtime v4 tests compare against the Z80 runtime byte for byte.  It moved here so that the Studio's floor plan
// preview (src/tools/floorplan-view.js) draws with the very same code; arcade/tests/m8-common.mjs imports and re-exports these names unchanged.
//   * tables: Q, COS, SIN, RECIP, HGT, PAT and the fixed point helpers;
//   * the map: rleEncode, loadMap (the 32 x 32 array, stride 32, as the runtime's loader makes it), wallAt, setWall, clampPos;
//   * casting: axisRef, frameSetup, castPos, castFrame; drawing: colMask, drawWalls (into a 6,144-byte display file), patsOf.
// Billboards (projectBB, drawBillboards) stay in the tests: the preview draws walls only.

/** The offset of pixel row y in a display file (the TS2068's screen layout). */
export const rowAddr = (y) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);

// ---- fixed point and tables ---------------------------------------------------------------------------------------------------
export const s16 = (v) => (v << 16) >> 16;
export const u16 = (v) => v & 0xFFFF;
export const Q = Array.from({ length: 65 }, (_, i) => Math.round(4096 * Math.sin(i * Math.PI / 128)));
/** C[a] (4.12): a <= 64: Q[64 - a]; 65..128: -C[128 - a]; 129..255: C[256 - a]. */
export const COS = (() => { const c = new Int16Array(256); for (let a = 0; a <= 64; a++) c[a] = Q[64 - a]; for (let a = 65; a <= 128; a++) c[a] = -c[128 - a]; for (let a = 129; a < 256; a++) c[a] = c[256 - a]; return c; })();
export const SIN = (a) => COS[(a + 192) & 255];
/** RECIP[n] = min(65535, floor(65536 / n)), RECIP[0] = 65535. */
export const RECIP = Array.from({ length: 512 }, (_, n) => (n === 0 ? 65535 : Math.min(65535, Math.floor(65536 / n))));
/** HGT[i] = 48 (i <= 32), else floor(1536 / i): the half height of a wall at perpendicular distance i / 32 cells. */
export const HGT = Uint8Array.from({ length: 1536 }, (_, i) => (i <= 32 ? 48 : Math.floor(1536 / i)));
/** The default wall patterns: [even row byte, odd row byte] per pattern index pi = (type - 1) * 2 + side. */
export const PAT = [[0xFF, 0xFF], [0xAA, 0x55], [0xEE, 0xBB], [0x88, 0x22], [0xFF, 0x00], [0xAA, 0x00], [0xCC, 0xCC], [0x88, 0x88]];
export const mulP = (v) => (v >> 1) + (v >> 4) + (v >> 6);
export const stepOf = (p, N) => { const q = (2 * Math.abs(p) + (N >> 1)) >> Math.log2(N); return p < 0 ? -q : q; };
export const cosa8 = (a) => (COS[a & 255] + 8) >> 4;
export const sina8 = (a) => (COS[(a + 192) & 255] + 8) >> 4;
/** FXMUL: floor(a b / 256) of the exact product, wrapped to 16 bits (a, b as signed 16-bit). */
export const fxmul = (a, b) => s16(Number((BigInt(s16(a)) * BigInt(s16(b))) >> 8n) & 0xFFFF);
/** The 3D window: pixel (8, 48), 128 x 96 (cell column 8, cell row 6, 16 x 12 cells). */
export const VIEW = { X0: 8, Y0: 48, W: 128, H: 96, HH: 48, CX: 8, CY: 6 };

// ---- the map: the 32 x 32 array (stride 32) ------------------------------------------------------------------------------------
/** The byte-RLE (pairs count 1..255, value; count 0 ends) of a map_w x map_h map (row-major, stride map_w). */
export function rleEncode(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length;) { let n = 1; while (i + n < bytes.length && n < 255 && bytes[i + n] === bytes[i]) n++; out.push(n, bytes[i]); i += n; }
  out.push(0);
  return out;
}
/** What the loader makes of map_src: the array = 1, then the RLE into the game's cells (values above 4 read as 4; a short list leaves 1; extra pairs
 *  are ignored), then every 0 on the array's outer ring becomes 1. */
export function loadMap(src, mw, mh) {
  const a = new Uint8Array(1024).fill(1);
  let k = 0;
  for (let i = 0; i < src.length && src[i] !== 0 && k < mw * mh; i += 2) for (let n = 0; n < src[i] && k < mw * mh; n++, k++) a[Math.floor(k / mw) * 32 + (k % mw)] = Math.min(4, src[i + 1] ?? 0);
  for (let t = 0; t < 32; t++) for (const p of [t, 31 * 32 + t, t * 32, t * 32 + 31]) if (a[p] === 0) a[p] = 1;
  return a;
}
/** RT_WALL. */
export const wallAt = (map, x, y) => { x = s16(x); y = s16(y); return x < 0 || y < 0 || (x >> 8) >= 32 || (y >> 8) >= 32 ? 1 : map[(y >> 8) * 32 + (x >> 8)]; };
/** RT_SETWALL (in place). */
export function setWall(map, mw, mh, x, y, t) {
  x = s16(x); y = s16(y); t &= 0xFFFF;
  if (t > 4 || x < 0 || y < 0 || (x >> 8) >= mw || (y >> 8) >= mh) return;
  const cx = x >> 8, cy = y >> 8;
  if (t === 0 && (cx === 0 || cx === 31 || cy === 0 || cy === 31)) return;
  map[cy * 32 + cx] = t;
}
/** RT_VIEW's clamp. */
export const clampPos = (v, max) => { v = s16(v); return v < 0 ? 0 : v > max ? max : v; };

// ---- casting ------------------------------------------------------------------------------------------------------------------
/** One axis: v = the ray component (4.12), f = the viewer's fraction (0..255). */
export function axisRef(v, f) {
  if (v === 0) return { neg: false, step: 32767, sd: 65535 };
  const neg = v < 0;
  let a = Math.min(Math.abs(v), 8191), e = 0;
  while (a < 2048) { a <<= 1; e++; }
  const D = RECIP[a >> 4] * 2 ** e, m = neg ? f : 256 - f;
  return { neg, step: Math.min(D, 32767), sd: Math.min(65535, Math.floor(m * D / 256)), e };
}
/** The frame setup of a pose { x, y, a } for N rays. */
export function frameSetup(pose, N) {
  const cosA = COS[pose.a & 255], sinA = COS[(pose.a + 192) & 255];
  const plx = s16(-mulP(sinA)), ply = mulP(cosA);
  const stx = stepOf(plx, N), sty = stepOf(ply, N);
  return { cosA, sinA, plx, ply, stx, sty, rdx: s16(cosA - plx + (stx >> 1)), rdy: s16(sinA - ply + (sty >> 1)) };
}
/** The cast's position: the pose clamped to cells 1..30 of the array (a viewer on the array's outer ring would cast out of it). */
export const castPos = (pose) => ({ x: Math.max(256, Math.min(31 * 256 - 1, pose.x)), y: Math.max(256, Math.min(31 * 256 - 1, pose.y)), a: pose.a });
/** Cast the N = 128 / colw rays of a pose over the 32-stride map: { hh[], pi[], dist[], steps, maxSteps }. */
export function castFrame(map, pose0, colw) {
  const pose = castPos(pose0), N = 128 / colw, s = frameSetup(pose, N);
  const fx = pose.x & 255, fy = pose.y & 255, p0 = (pose.y >> 8) * 32 + (pose.x >> 8);
  const hh = new Uint8Array(N), pi = new Uint8Array(N), dist = new Uint16Array(N);
  let rdx = s.rdx, rdy = s.rdy, steps = 0, maxSteps = 0, minV = 1e9;
  for (let j = 0; j < N; j++) {
    const ax = axisRef(rdx, fx), ay = axisRef(rdy, fy);
    minV = Math.min(minV, Math.abs(rdx), Math.abs(rdy));
    let sdx = ax.sd, sdy = ay.sd, ptr = p0, side = 0, cell = 0, n = 0;
    for (;;) {
      n++;
      if (sdx < sdy) { sdx = u16(sdx + ax.step); ptr += ax.neg ? -1 : 1; side = 0; } else { sdy = u16(sdy + ay.step); ptr += ay.neg ? -32 : 32; side = 1; }
      if (ptr < 0 || ptr >= 1024) throw new Error(`ray ${j} left the map array (pose ${JSON.stringify(pose)})`);
      cell = map[ptr];
      if (cell) break;
    }
    const perp = side === 0 ? u16(sdx - ax.step) : u16(sdy - ay.step);
    dist[j] = perp; hh[j] = HGT[Math.min(perp >> 3, 1535)]; pi[j] = ((cell - 1) * 2 + side) & 7;
    steps += n; maxSteps = Math.max(maxSteps, n);
    rdx = s16(rdx + s.stx); rdy = s16(rdy + s.sty);
  }
  return { hh, pi, dist, steps, maxSteps, minV, N, colw };
}
/** The masked pattern of position p: [even, odd]. */
export const colMask = (colw, p) => (((1 << colw) - 1) << (8 - (p + 1) * colw)) & 0xFF;
/** Draw the walls into a display file (6,144-byte bitmap, screen layout): every window byte written. */
export function drawWalls(bitmap, cast, pat = PAT) {
  const { colw } = cast, R = 8 / colw;
  for (let k = 0; k < 16; k++) for (let r = 0; r < 96; r++) {
    const d = r >= 48 ? r - 48 : 47 - r;
    let v = 0;
    for (let p = 0; p < R; p++) { const j = k * R + p; if (cast.hh[j] > d) v |= pat[cast.pi[j]][r & 1] & colMask(colw, p); }
    bitmap[rowAddr(VIEW.Y0 + r) + VIEW.X0 + k] = v;
  }
}
/** The patterns of a view: 16 game bytes ([even, odd] per pi) or the default. */
export const patsOf = (bytes) => (bytes ? Array.from({ length: 8 }, (_, pi) => [bytes[2 * pi], bytes[2 * pi + 1]]) : PAT);
