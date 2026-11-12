"use strict";
// ref.mjs -- the billboard spike's JavaScript references.
//  * COPIED VERBATIM from arcade/tests/m8-common.mjs (and m6-common.mjs, m3-common.mjs, m3-scenes.mjs): the tables, castFrame, drawWalls,
//    projectBB, drawBillboards, randomCells, randomPose, loadMap, rleEncode, randomAsset, rowAddr, rng.  They are copied (not imported) so that
//    this spike does not load arcade/tools/build-runtime-v4.mjs, which m8-common.mjs imports; drawBillboards stays THE reference of A1 / A2.
//  * New here: drawOne (drawBillboards' loop for one projection, used for synthetic scenes), the Q reference (qHeights, buildQSet, projectQ,
//    drawQ), the A2 key (a2Key) and its hit-rate model.

// ---- copied: m3-common.mjs, m3-scenes.mjs ----
export const rowAddr = (y) => ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2);
export function rng(seed) {
  let s = seed >>> 0;
  const next = () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const int = (lo, hi) => lo + Math.floor(next() * (hi - lo + 1));
  const pick = (a) => a[int(0, a.length - 1)];
  return { next, int, pick, chance: (p) => next() < p };
}
// ---- copied: m6-common.mjs ----
export const normW = (w) => (w <= 8 ? 8 : w <= 16 ? 16 : w <= 24 ? 24 : 32);
export const normH = (h) => (h < 1 ? 1 : h > 48 ? 48 : h);
export const normNF = (n) => (n < 1 ? 1 : n > 32 ? 32 : n);
export function randomAsset(r, w, h, phases, nframes = 1, { hot = null, opaque = 0.55 } = {}) {
  const wb = normW(w) / 8, frames = [];
  for (let f = 0; f < normNF(nframes); f++) {
    const rows = [];
    for (let k = 0; k < normH(h); k++) {
      const m = [], i = [];
      for (let b = 0; b < wb; b++) {
        let mb = 0, ib = 0;
        for (let bit = 0; bit < 8; bit++) {
          const cover = r.chance(opaque);
          mb = (mb << 1) | (cover ? 0 : 1);
          ib = (ib << 1) | (cover && r.chance(0.5) ? 1 : 0);
          if (!cover && r.chance(0.05)) ib |= 1;
        }
        m.push(mb); i.push(ib);
      }
      rows.push({ m, i });
    }
    frames.push(rows);
  }
  return { w, h, phases, nframes, frames, hot };
}
/** (simplified normAsset: the fields the billboards read) */
export const normAsset = (a) => { const w = normW(a.w), h = normH(a.h); return { w, wb: w / 8, h, nf: normNF(a.nframes), frames: a.frames }; };

// ---- copied: m8-common.mjs ----
export const s16 = (v) => (v << 16) >> 16;
export const u16 = (v) => v & 0xFFFF;
export const Q = Array.from({ length: 65 }, (_, i) => Math.round(4096 * Math.sin(i * Math.PI / 128)));
export const COS = (() => { const c = new Int16Array(256); for (let a = 0; a <= 64; a++) c[a] = Q[64 - a]; for (let a = 65; a <= 128; a++) c[a] = -c[128 - a]; for (let a = 129; a < 256; a++) c[a] = c[256 - a]; return c; })();
export const RECIP = Array.from({ length: 512 }, (_, n) => (n === 0 ? 65535 : Math.min(65535, Math.floor(65536 / n))));
export const HGT = Uint8Array.from({ length: 1536 }, (_, i) => (i <= 32 ? 48 : Math.floor(1536 / i)));
export const PAT = [[0xFF, 0xFF], [0xAA, 0x55], [0xEE, 0xBB], [0x88, 0x22], [0xFF, 0x00], [0xAA, 0x00], [0xCC, 0xCC], [0x88, 0x88]];
export const mulP = (v) => (v >> 1) + (v >> 4) + (v >> 6);
export const stepOf = (p, N) => { const q = (2 * Math.abs(p) + (N >> 1)) >> Math.log2(N); return p < 0 ? -q : q; };
export const cosa8 = (a) => (COS[a & 255] + 8) >> 4;
export const sina8 = (a) => (COS[(a + 192) & 255] + 8) >> 4;
export const VIEW = { X0: 8, Y0: 48, W: 128, H: 96, HH: 48, CX: 8, CY: 6 };
export function rleEncode(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length;) { let n = 1; while (i + n < bytes.length && n < 255 && bytes[i + n] === bytes[i]) n++; out.push(n, bytes[i]); i += n; }
  out.push(0);
  return out;
}
export function loadMap(src, mw, mh) {
  const a = new Uint8Array(1024).fill(1);
  let k = 0;
  for (let i = 0; i < src.length && src[i] !== 0 && k < mw * mh; i += 2) for (let n = 0; n < src[i] && k < mw * mh; n++, k++) a[Math.floor(k / mw) * 32 + (k % mw)] = Math.min(4, src[i + 1] ?? 0);
  for (let t = 0; t < 32; t++) for (const p of [t, 31 * 32 + t, t * 32, t * 32 + 31]) if (a[p] === 0) a[p] = 1;
  return a;
}
export function axisRef(v, f) {
  if (v === 0) return { neg: false, step: 32767, sd: 65535 };
  const neg = v < 0;
  let a = Math.min(Math.abs(v), 8191), e = 0;
  while (a < 2048) { a <<= 1; e++; }
  const D = RECIP[a >> 4] * 2 ** e, m = neg ? f : 256 - f;
  return { neg, step: Math.min(D, 32767), sd: Math.min(65535, Math.floor(m * D / 256)), e };
}
export function frameSetup(pose, N) {
  const cosA = COS[pose.a & 255], sinA = COS[(pose.a + 192) & 255];
  const plx = s16(-mulP(sinA)), ply = mulP(cosA);
  const stx = stepOf(plx, N), sty = stepOf(ply, N);
  return { cosA, sinA, plx, ply, stx, sty, rdx: s16(cosA - plx + (stx >> 1)), rdy: s16(sinA - ply + (sty >> 1)) };
}
export const castPos = (pose) => ({ x: Math.max(256, Math.min(31 * 256 - 1, pose.x)), y: Math.max(256, Math.min(31 * 256 - 1, pose.y)), a: pose.a });
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
export const colMask = (colw, p) => (((1 << colw) - 1) << (8 - (p + 1) * colw)) & 0xFF;
export function drawWalls(bitmap, cast, pat = PAT) {
  const { colw } = cast, R = 8 / colw;
  for (let k = 0; k < 16; k++) for (let r = 0; r < 96; r++) {
    const d = r >= 48 ? r - 48 : 47 - r;
    let v = 0;
    for (let p = 0; p < R; p++) { const j = k * R + p; if (cast.hh[j] > d) v |= pat[cast.pi[j]][r & 1] & colMask(colw, p); }
    bitmap[rowAddr(VIEW.Y0 + r) + VIEW.X0 + k] = v;
  }
}
export const tmul = (a, c) => Math.sign(a) * Math.sign(c) * Math.floor(Math.abs(a) * Math.abs(c) / 256);
export function projectBB(inst, a, pose, mapW, mapH) {
  if (inst.x > mapW * 256 - 1 || inst.y > mapH * 256 - 1) return null;
  const p = castPos(pose), cs = cosa8(pose.a), sn = sina8(pose.a), dx = inst.x - p.x, dy = inst.y - p.y;
  const tx = tmul(dx, cs) + tmul(dy, sn);
  if (tx < 64) return null;
  const hgt = HGT[Math.min(tx >> 3, 1535)], hpx = (a.h * hgt) >> 4;
  if (hpx === 0) return null;
  const wpx = hpx + (hpx >> 3) + (hpx >> 5);
  const ustep = a.wb * (RECIP[wpx] >> 5), vstep = Math.floor(a.h * RECIP[hpx] / 256);
  const ty = tmul(dy, cs) - tmul(dx, sn), q = mulP(tx), aty = Math.abs(ty);
  if ((aty >> 2) >= q) return null;
  const off = Math.floor(64 * aty / q);
  if (off >= 192) return null;
  const sxc = 64 + (ty < 0 ? -off : off), L = sxc - (wpx >> 1);
  return { tx, ty, hgt, hpx, wpx, sxc, L, col: Math.max(0, Math.min(127, sxc)), ustep, vstep };
}
export function drawBillboards(bitmap, cast, insts, assets, pose, mapW, mapH) {
  const { colw } = cast, N = 128 / colw, half = colw >> 1;
  const bb = Array.from({ length: 16 }, () => ({ depth: 0, col: 0xFFFF }));
  const list = [];
  insts.forEach((s, i) => {
    if (!s.visible) return;
    const a = assets[s.asset], p = projectBB(s, a, pose, mapW, mapH);
    if (p) list.push({ i, p, a, f: Math.min(s.frame, a.nf - 1) });
  });
  list.sort((u, v) => v.p.tx - u.p.tx || u.i - v.i);
  for (const { i, p, a, f } of list) {
    let drawn = 0;
    const top = VIEW.HH + p.hgt - p.hpx, bot = VIEW.HH + p.hgt - 1;
    for (let j = 0; j < N; j++) {
      const xc = j * colw + half;
      if (xc < p.L || xc >= p.L + p.wpx || !(p.tx < cast.dist[j])) continue;
      const u = Math.floor((xc - p.L) * p.ustep / 256);
      if (xc - p.L > 255) continue;
      drawn++;
      const cm = colMask(colw, j % (8 / colw)), adrX = VIEW.X0 + Math.floor(j * colw / 8);
      for (let r = Math.max(0, top); r <= bot; r++) {
        const v = Math.floor((r - top) * p.vstep / 256), row = a.frames[f][v];
        const m = (row.m[u >> 3] >> (7 - (u & 7))) & 1, im = (row.i[u >> 3] >> (7 - (u & 7))) & 1;
        const adr = rowAddr(VIEW.Y0 + r) + adrX;
        if (!m) bitmap[adr] &= ~cm;
        if (im) bitmap[adr] |= cm;
      }
    }
    if (drawn) bb[i] = { depth: p.tx, col: p.col };
  }
  return bb;
}
export function randomCells(r, mw, mh, fill = 0.18) {
  const c = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const ring = x === 0 || y === 0 || x === mw - 1 || y === mh - 1;
    c[y * mw + x] = ring || r.chance(fill) ? r.int(1, 4) : 0;
  }
  return c;
}
export function randomPose(r, map, mw, mh) {
  for (;;) {
    const cx = r.int(1, mw - 2), cy = r.int(1, mh - 2);
    if (map[cy * 32 + cx]) continue;
    const fx = r.chance(0.125) ? 0 : r.int(0, 255), fy = r.chance(0.125) ? 0 : r.int(0, 255);
    return { x: cx * 256 + fx, y: cy * 256 + fy, a: r.chance(1 / 6) ? r.pick([0, 64, 128, 192]) : r.int(0, 255) };
  }
}

// =============================================================================================================================
// New in this spike
// =============================================================================================================================
/** The projection of a billboard of source height h (wb bytes wide) drawn hpx rows high (a synthetic scene): hgt from a depth tx. */
export function synthProj({ h, wb }, hpx, hgt, tx, sxc) {
  const wpx = hpx + (hpx >> 3) + (hpx >> 5);
  const ustep = wb * (RECIP[wpx] >> 5), vstep = Math.floor(h * RECIP[hpx] / 256);
  return { tx, ty: 0, hgt, hpx, wpx, sxc, L: sxc - (wpx >> 1), col: Math.max(0, Math.min(127, sxc)), ustep, vstep };
}
/** drawBillboards' loop for one projection p (frame rows `rows`): the pixels and whether a column was drawn. */
export function drawOne(bitmap, dist, colw, p, rows) {
  const N = 128 / colw, half = colw >> 1, top = VIEW.HH + p.hgt - p.hpx, bot = VIEW.HH + p.hgt - 1;
  let drawn = 0;
  for (let j = 0; j < N; j++) {
    const xc = j * colw + half;
    if (xc < p.L || xc >= p.L + p.wpx || !(p.tx < dist[j])) continue;
    const u = Math.floor((xc - p.L) * p.ustep / 256);
    if (xc - p.L > 255) continue;
    drawn++;
    const cm = colMask(colw, j % (8 / colw)), adrX = VIEW.X0 + Math.floor(j * colw / 8);
    for (let r = Math.max(0, top); r <= bot; r++) {
      const v = Math.floor((r - top) * p.vstep / 256), row = rows[v];
      const m = (row.m[u >> 3] >> (7 - (u & 7))) & 1, im = (row.i[u >> 3] >> (7 - (u & 7))) & 1;
      const adr = rowAddr(VIEW.Y0 + r) + adrX;
      if (!m) bitmap[adr] &= ~cm;
      if (im) bitmap[adr] |= cm;
    }
  }
  return drawn;
}
/** The draw order of a scene (as drawBillboards): [{i, p, a, f}] far to near, equal tx: lower instance first. */
export function drawList(insts, assets, pose, mapW, mapH) {
  const list = [];
  insts.forEach((s, i) => {
    if (!s.visible) return;
    const a = assets[s.asset], p = projectBB(s, a, pose, mapW, mapH);
    if (p) list.push({ i, p, a, f: Math.min(s.frame, a.nf - 1) });
  });
  list.sort((u, v) => v.p.tx - u.p.tx || u.i - v.i);
  return list;
}

// ---- the A2 key: what the prepared rows depend on (frame, wpx, k0 = xc(j0) - L, j0, the occlusion bits of the scanned rays) ----
/** As a_draw's scan: null when no ray is scanned or none is drawn, else { key (string), j0, nscan, kf, kl, n, h2n } */
export function a2Key(p, dist, colw, frameId, h) {
  const N = 128 / colw, half = colw >> 1, R = 8 / colw;
  let j0 = colw === 4 ? (p.L + 1) >> 2 : p.L >> 1;
  if (j0 < 0) j0 = 0;
  if (j0 > N - 1) return null;
  const k0 = j0 * colw + half - p.L;
  if (k0 > 255 || k0 >= p.wpx) return null;
  const nscan = Math.min(N - j0, Math.floor((p.wpx - k0 + colw - 1) / colw));
  let occ = '', jf = -1, jl = -1;
  for (let j = j0; j < j0 + nscan; j++) { const vis = p.tx < dist[j]; occ += vis ? '0' : '1'; if (vis) { if (jf < 0) jf = j; jl = j; } }
  if (jf < 0) return null;
  const kf = Math.floor(jf / R), kl = Math.floor(jl / R), n = kl - kf + 1;
  return { key: `${frameId}:${p.wpx}:${k0}:${j0}:${occ}`, j0, nscan, kf, kl, n, h2n: h * 2 * n };
}

// ---- Q: the quantised pre-scaled sets ----
/** n heights, geometric from hmin = max(2, round(h / 4)) to hmax = 3 h (the tallest hpx of a source of height h), rounded, distinct. */
export function qHeights(h, n) {
  const lo = Math.max(2, Math.round(h / 4)), hi = 3 * h, out = [];
  for (let k = 0; k < n; k++) { const v = Math.round(lo * (hi / lo) ** (k / (n - 1))); if (!out.includes(v)) out.push(v); }
  return out;
}
/** The nearest set height to hpx (ties to the taller): the index s.  thresholds[s] = ceil((H[s] + H[s + 1]) / 2): hpx >= it -> s + 1. */
export const qThresholds = (H) => H.slice(0, -1).map((v, s) => Math.ceil((v + H[s + 1]) / 2));
export const qPick = (H, hpx) => { const T = qThresholds(H); let s = 0; while (s < T.length && hpx >= T[s]) s++; return s; };
/** The set geometry of height Hs for a source {h, wb, w}: wq, ncq, ustep, vstep, u[c]. */
export function qGeom(a, Hs, colw) {
  const half = colw >> 1, wq = Hs + (Hs >> 3) + (Hs >> 5);
  const ustep = a.wb * (RECIP[wq] >> 5), vstep = Math.floor(a.h * RECIP[Hs] / 256);
  const ncq = Math.max(1, Math.ceil((wq - half) / colw));
  const u = Array.from({ length: ncq }, (_, c) => Math.min(a.w - 1, Math.floor((c * colw + half) * ustep / 256)));
  const v = Array.from({ length: Hs }, (_, r) => Math.min(a.h - 1, Math.floor(r * vstep / 256)));
  return { Hs, wq, ncq, ustep, vstep, u, v };
}
/** The pre-scaled bytes of frame `rows` at geometry g and byte phase ph: Hs rows of Bq (mask, image) pairs, row-major. */
export function buildQSet(rows, g, colw, ph) {
  const R = 8 / colw, Bq = Math.ceil((ph + g.ncq) / R), out = new Uint8Array(g.Hs * 2 * Bq);
  for (let r = 0; r < g.Hs; r++) {
    const src = rows[g.v[r]];
    for (let b = 0; b < Bq; b++) { out[(r * Bq + b) * 2] = 0xFF; out[(r * Bq + b) * 2 + 1] = 0; }
    for (let c = 0; c < g.ncq; c++) {
      const u = g.u[c], m = (src.m[u >> 3] >> (7 - (u & 7))) & 1, im = (src.i[u >> 3] >> (7 - (u & 7))) & 1;
      const pos = ph + c, b = Math.floor(pos / R), cm = colMask(colw, pos % R), o = (r * Bq + b) * 2;
      if (!m) out[o] &= ~cm;
      if (im) out[o + 1] |= cm;
    }
  }
  return { Bq, bytes: out };
}
/** Bytes of one frame's sets: n heights x R phases (pre-shifted), or x 1 phase (a runtime shift). */
export function qBytes(a, colw, n, phases = 8 / colw) {
  let total = 0;
  for (const Hs of qHeights(a.h, n)) { const g = qGeom(a, Hs, colw); for (let ph = 0; ph < phases; ph++) total += g.Hs * 2 * Math.ceil((ph + g.ncq) / (8 / colw)); }
  return total;
}
/** Q's placement of a projection p: { s, Hs, g, jL, ph } */
export function projectQ(p, a, colw, H) {
  const s = qPick(H, p.hpx), g = qGeom(a, H[s], colw), sxc = p.L + (p.wpx >> 1), Lq = sxc - (g.wq >> 1);
  const half = colw >> 1, jL = Math.floor((Lq + half) / colw), ph = ((jL % (8 / colw)) + 8 / colw) % (8 / colw);
  return { s, Hs: H[s], g, jL, ph };
}
/** Q's reference: draw projection p with the set's pixels (the same per-pixel rule), column c at ray jL + c, rows 1:1 standing on the floor. */
export function drawQ(bitmap, dist, colw, p, rows, a, H) {
  const q = projectQ(p, a, colw, H), N = 128 / colw, top = VIEW.HH + p.hgt - q.Hs, bot = VIEW.HH + p.hgt - 1;
  let drawn = 0;
  for (let c = 0; c < q.g.ncq; c++) {
    const j = q.jL + c;
    if (j < 0 || j >= N || !(p.tx < dist[j])) continue;
    drawn++;
    const u = q.g.u[c], cm = colMask(colw, j % (8 / colw)), adrX = VIEW.X0 + Math.floor(j * colw / 8);
    for (let r = Math.max(0, top); r <= bot; r++) {
      const row = rows[q.g.v[r - top]];
      const m = (row.m[u >> 3] >> (7 - (u & 7))) & 1, im = (row.i[u >> 3] >> (7 - (u & 7))) & 1;
      const adr = rowAddr(VIEW.Y0 + r) + adrX;
      if (!m) bitmap[adr] &= ~cm;
      if (im) bitmap[adr] |= cm;
    }
  }
  return { drawn, q };
}

// ---- Vaults' sprites (arcade/examples/vaults.assets.json) as the runtime's frames: mask 1 = the background shows ----
export function spriteFrames(spr) {
  const w = spr.w, wb = Math.ceil(w / 8), W = 8 * wb, frames = [];
  for (const f of spr.frames) {
    frames.push(f.rows.map((r) => {
      const covers = r.mask == null ? 2 ** w - 1 : parseInt(r.mask, 16), bits = parseInt(r.bits, 16) & covers;
      const cw = covers * 2 ** (W - w), bw = bits * 2 ** (W - w), maskW = 2 ** W - 1 - cw;
      const m = [], i = [];
      for (let k = wb - 1; k >= 0; k--) { m.push(Math.floor(maskW / 2 ** (8 * k)) & 255); i.push(Math.floor(bw / 2 ** (8 * k)) & 255); }
      return { m, i };
    }));
  }
  return { w: W, wb, h: spr.h, nf: frames.length, frames };
}
