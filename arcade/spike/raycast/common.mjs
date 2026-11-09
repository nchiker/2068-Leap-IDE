"use strict";
// Raycaster spike: shared data (patterns, tables, maps, poses) and the bit-exact JS reference renderer.
// Every integer operation mirrors the Z80 code in raycast.asm (see RESULTS.md for the algorithm).
//
// Fixed point: ray directions and the plane are 4.12 (1.0 = 4096), player position 8.8 (cell = high byte),
// distances along a ray 8.8. Angles are 0..255 (256 per circle).

export const PAT = [            // [even-row byte, odd-row byte] per pattern index pi = (wallType-1)*2 + side
  [0xFF, 0xFF], [0xAA, 0x55],   // type 1: solid / checker
  [0xEE, 0xBB], [0x88, 0x22],   // type 2: 3/4 dither / 1/4 dither
  [0xFF, 0x00], [0xAA, 0x00],   // type 3: scanline stripes / sparse stripes
  [0xCC, 0xCC], [0x88, 0x88],   // type 4: vertical bars / thin bars
];
export const Q = Array.from({ length: 65 }, (_, i) => Math.round(4096 * Math.sin(i * Math.PI / 128)));
export const RECN = 320;                       // reciprocal table entries (index = |dir| >> 4, max seen < 300)

export const s16 = v => (v << 16) >> 16;
export const u16 = v => v & 0xFFFF;

export function buildCos() {
  const C = new Int16Array(256);
  for (let a = 0; a <= 64; a++) C[a] = Q[64 - a];
  for (let a = 65; a <= 128; a++) C[a] = -C[128 - a];
  for (let a = 129; a < 256; a++) C[a] = C[256 - a];
  return C;
}
export const RECIP = Array.from({ length: RECN }, (_, i) => i === 0 ? 0x7FFF : Math.min(0x7FFF, Math.floor(65535 / i)));
export function buildHgt(HH, n) {
  const t = new Uint8Array(n);
  for (let i = 0; i < n; i++) t[i] = i <= 32 ? HH : Math.min(HH, Math.floor(HH * 32 / i));
  return t;
}
const COS = buildCos();

// ---- maps (digits 1..4 = wall type, '.' = empty) ----------------------------------------------------------------
const MAP16_ROWS = [
  '1111111111111111',
  '1..............1',
  '1.2222....3333.1',
  '1.2........3...1',
  '1.2..44....3...1',
  '1....44........1',
  '1..............1',
  '1.33...44...22.1',
  '1.3.........2..1',
  '1.3.....3......1',
  '1...........4..1',
  '1.444.......4..1',
  '1.....2222.....1',
  '1.............31',
  '1..............1',
  '1111111111111111',
];
export function makeMap(n) {
  const m = new Uint8Array(n * n);
  if (n === 16) {
    MAP16_ROWS.forEach((row, y) => { if (row.length !== 16) throw new Error('map row ' + y); for (let x = 0; x < 16; x++) m[y * 16 + x] = row[x] === '.' ? 0 : +row[x]; });
  } else {
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      let t = 0;
      if (x === 0 || y === 0 || x === n - 1 || y === n - 1) t = ((x + y) >> 3) % 4 + 1;
      else if ((x % 5 === 2 && y % 5 === 2)) t = ((x + y) % 4) + 1;                 // pillars
      else if (y === 12 && x > 4 && x < 24 && x % 7 !== 0) t = 2;                   // long wall with gaps
      else if (x === 20 && y > 14 && y < 28 && y % 6 !== 0) t = 3;
      else if (x > 5 && x < 11 && y > 19 && y < 25 && (x === 6 || x === 10 || y === 20 || y === 24) && !(x === 8 && y === 24)) t = 4; // small room
      m[y * n + x] = t;
    }
  }
  return m;
}
// 16 poses per map: [cellX + fx/256, cellY + fy/256, angle]; fx, fy never 0 (see RESULTS.md, limitation)
export function makePoses(n) {
  const P = n === 16 ? [
    [1.30, 1.50, 8], [3.50, 6.50, 20], [7.50, 6.50, 0], [7.75, 1.50, 64], [14.30, 14.30, 160], [8.50, 14.50, 192],
    [1.20, 1.20, 160], [2.50, 1.80, 150],                   // close to walls
    [6.50, 6.50, 100], [10.50, 8.50, 40], [13.50, 9.50, 128], [12.50, 6.50, 230],
    [5.50, 13.50, 245], [4.25, 4.75, 100], [13.50, 1.50, 100], [9.50, 11.50, 210],
  ] : [
    [3.50, 3.50, 20], [8.50, 8.50, 0], [14.50, 14.50, 30], [16.50, 16.50, 100], [21.50, 21.50, 140], [28.50, 28.50, 200],
    [1.30, 1.40, 200], [30.40, 30.30, 40],                  // close to the border walls
    [3.50, 20.50, 250], [12.50, 25.50, 192], [26.50, 3.50, 90], [18.50, 10.50, 75],
    [23.50, 21.50, 5], [9.50, 15.50, 60], [25.50, 18.50, 170], [7.50, 28.50, 130],
  ];
  return P.map(([x, y, a], i) => {
    const px = Math.round(x * 256), py = Math.round(y * 256);
    if ((px & 255) === 0 || (py & 255) === 0) throw new Error('pose with zero fraction');
    return { px, py, ang: a, id: i };
  });
}

// ---- reference: the frame setup, the ray caster and the drawing -----------------------------------------------------
const sar = (v, n) => v >> n;
const mulP = v => sar(v, 1) + sar(v, 4) + sar(v, 6);          // v * 37/64 (0.578125), arithmetic shifts
function stepOf(p, N) { const q = Math.floor((2 * Math.abs(p) + (N >> 1)) / N); return p < 0 ? -q : q; }
function axis(dir, mneg, mpos, st) {
  const neg = dir < 0;
  const a = neg ? u16(-dir) : dir;
  const idx = a >> 4;
  if (idx >= RECN) throw new Error('RECIP index ' + idx);
  st.maxIdx = Math.max(st.maxIdx, idx);
  const delta = RECIP[idx];
  const m = neg ? mneg : mpos;
  return { neg, delta, sd: Math.floor(m * delta / 256) };
}
export function pxAddr(y) { return ((y & 0xC0) << 5) | ((y & 7) << 8) | ((y & 0x38) << 2); }   // offset from $4000

/** Cast every ray of one frame. Returns {hh[], pi[], steps, ...}.
 *  cfg.INTERP: cast every 4th ray (plus the ray just past the right edge); when the two ends of an interval hit the same
 *  map cell and the same side, the 3 rays between them get linearly interpolated heights (1/z is linear across a flat
 *  wall), otherwise they are cast. */
export function castFrame(cfg, pose, map) {
  const { W, WCOL, MAPN } = cfg, N = W / WCOL, HH = cfg.H / 2;
  const hgt = cfg.hgt || (cfg.hgt = buildHgt(HH, MAPN * 48));
  const cosA = COS[pose.ang], sinA = COS[(pose.ang + 192) & 255];
  const plx = -mulP(sinA), ply = mulP(cosA);
  const stx = stepOf(plx, N), sty = stepOf(ply, N);
  let rdx = s16(cosA - plx + sar(stx, 1)), rdy = s16(sinA - ply + sar(sty, 1));
  const fx = pose.px & 255, fy = pose.py & 255;
  const mxn = fx, mxp = (256 - fx) & 255, myn = fy, myp = (256 - fy) & 255;
  const mapp0 = (pose.py >> 8) * MAPN + (pose.px >> 8);
  const hh = new Uint8Array(N), pi = new Uint8Array(N);
  const st = { maxIdx: 0, steps: 0, maxPerp: 0, stepsMax: 0, cast: 0, interp: 0 };
  function castOne(rdx, rdy) {
    const ax = axis(rdx, mxn, mxp, st), ay = axis(rdy, myn, myp, st);
    let sdx = ax.sd, sdy = ay.sd, ptr = mapp0, side, cell, n = 0;
    const stepx = ax.neg ? -1 : 1, stepy = ay.neg ? -MAPN : MAPN;
    for (;;) {
      n++;
      if (sdx < sdy) { sdx = u16(sdx + ax.delta); ptr += stepx; side = 0; }
      else { sdy = u16(sdy + ay.delta); ptr += stepy; side = 1; }
      cell = map[ptr];
      if (cell) break;
    }
    const perp = side === 0 ? u16(sdx - ax.delta) : u16(sdy - ay.delta);
    const idx = perp >> 3;
    if (idx >= hgt.length) throw new Error('HGT index ' + idx);
    st.maxPerp = Math.max(st.maxPerp, idx);
    st.steps += n; st.stepsMax = Math.max(st.stepsMax, n); st.cast++;
    return { hh: hgt[idx], pi: (cell - 1) * 2 + side, ptr };
  }
  if (!cfg.INTERP) {
    for (let j = 0; j < N; j++) {
      const r = castOne(rdx, rdy);
      hh[j] = r.hh; pi[j] = r.pi;
      rdx = s16(rdx + stx); rdy = s16(rdy + sty);
    }
  } else {
    let L = castOne(rdx, rdy);
    hh[0] = L.hh; pi[0] = L.pi;
    for (let j0 = 0; j0 < N; j0 += 4) {
      const lx = rdx, ly = rdy;
      rdx = s16(rdx + 4 * stx); rdy = s16(rdy + 4 * sty);
      const R = castOne(rdx, rdy);
      if (L.ptr === R.ptr && L.pi === R.pi) {
        const d = R.hh - L.hh;
        let v = 4 * L.hh;
        for (let k = 1; k < 4; k++) { v += d; hh[j0 + k] = (v + 2) >> 2; pi[j0 + k] = L.pi; }
        st.interp += 3;
      } else {
        let cx = lx, cy = ly;
        for (let k = 1; k < 4; k++) {
          cx = s16(cx + stx); cy = s16(cy + sty);
          const r = castOne(cx, cy);
          hh[j0 + k] = r.hh; pi[j0 + k] = r.pi;
        }
      }
      if (j0 + 4 < N) { hh[j0 + 4] = R.hh; pi[j0 + 4] = R.pi; }
      L = R;
    }
  }
  return { hh, pi, steps: st.steps, stepsMax: st.stepsMax, maxIdx: st.maxIdx, maxPerp: st.maxPerp, cast: st.cast, interp: st.interp };
}

/** Draw the rays into bm (6144-byte bitmap, offset from $4000); touches the window only. */
export function drawFrame(cfg, hh, pi, bm) {
  const { W, H, WCOL } = cfg, WB = W / 8, R = 8 / WCOL, HHh = H / 2, XB0 = (32 - WB) / 2, Y0 = (192 - H) / 2;
  for (let r = 0; r < H; r++) for (let b = 0; b < WB; b++) bm[pxAddr(Y0 + r) + XB0 + b] = 0;
  for (let j = 0; j < hh.length; j++) {
    const c = Math.floor(j / R), rr = j % R;
    const mask = ((1 << WCOL) - 1) << (8 - (rr + 1) * WCOL);
    const E = PAT[pi[j]][0] & mask, O = PAT[pi[j]][1] & mask;
    for (let d = 0; d < hh[j]; d++) {
      for (const r of [HHh + d, HHh - 1 - d]) bm[pxAddr(Y0 + r) + XB0 + c] |= (r & 1) ? O : E;
    }
  }
  return bm;
}

/** Text picture of the window: two pixel rows per text line (half blocks). */
export function asciiWindow(cfg, bm) {
  const { W, H } = cfg, WB = W / 8, XB0 = (32 - WB) / 2, Y0 = (192 - H) / 2;
  const px = (x, y) => (bm[pxAddr(Y0 + y) + XB0 + (x >> 3)] >> (7 - (x & 7))) & 1;
  const lines = [];
  for (let y = 0; y < H; y += 2) {
    let s = '';
    for (let x = 0; x < W; x++) { const a = px(x, y), b = px(x, y + 1); s += a ? (b ? '█' : '▀') : (b ? '▄' : ' '); }
    lines.push(s.replace(/\s+$/, ''));
  }
  return lines.join('\n');
}
