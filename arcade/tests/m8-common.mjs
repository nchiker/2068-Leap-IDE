"use strict";
// m8-common.mjs -- shared helpers of the runtime v4 tests (m8-*.mjs): the raycaster.  The JS REFERENCE here is written from
// docs/ARCADE_RAYCASTER_CONTRACT.md (sections 2-4) and docs/ARCADE_RUNTIME_API_V4.md "As built" (the exact integer rules), extending the spike's
// bit-exact reference (arcade/spike/raycast/common.mjs) with the fixes of the slice: exact cell edges (fraction 0) and rays near an axis
// (normalised reciprocal, exact first side distance, the step cap), the 32-stride map, colw 2 and 4, the billboards.  NOT from the Z80 sources.
//   * tables: Q, COS, RECIP, HGT, PAT; castFrame(), drawWalls(), billboards (projectBB, drawBB); the map model (loadMap, wall, setwall);
//   * rayGame(spec): the v4 script game (arcade/runtime/v4/test_script.asm) with DIV_EXT | DIV_VIEW, a view_desc, the RLE map, patterns;
//   * Model8: the cell map (M3 model) + the ray window (walls + billboards) + BB_TAB, advanced tick by tick;
//   * renderAt(): call ray_render on a booted machine for one pose (direct, interrupts off).
import { join } from 'node:path';
import { buildRuntime, assembleGame, linkGame, dckOf, RUNTIME_DIR } from '../tools/build-runtime-v4.mjs';
import * as C from './m6-common.mjs';
export const { M, Z, FRAME_T, hex, int16, makeChecks, rd8, rd16, newMachine, bootMachine, callRoutine, rowAddr, BG_ATTR, C3, dfileOf, diffCount,
  colourPlane, shownColours, randomAsset, assetBytes, normAsset, avg } = C;
export { C };

let _rt = null;
/** Build the v4 runtime once per process. */
export function runtime() { return (_rt ??= buildRuntime()); }
let _asm = null;
function scriptAsm() { return (_asm ??= assembleGame(join(RUNTIME_DIR, 'test_script.asm'), { name: 'script4' })); }
export const logAddrs = (S) => ({ LOGN: S.GAME_VARS_BASE + 2, LOGBUF: S.GAME_VARS_BASE + 0x100 });

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
export const PAT = [[0xFF, 0xFF], [0xAA, 0x55], [0xEE, 0xBB], [0x88, 0x22], [0xFF, 0x00], [0xAA, 0x00], [0xCC, 0xCC], [0x88, 0x88]];
export const mulP = (v) => (v >> 1) + (v >> 4) + (v >> 6);
export const stepOf = (p, N) => { const q = (2 * Math.abs(p) + (N >> 1)) >> Math.log2(N); return p < 0 ? -q : q; };
export const cosa8 = (a) => (COS[a & 255] + 8) >> 4;
export const sina8 = (a) => (COS[(a + 192) & 255] + 8) >> 4;
/** FXMUL: floor(a b / 256) of the exact product, wrapped to 16 bits (a, b as signed 16-bit). */
export const fxmul = (a, b) => s16(Number((BigInt(s16(a)) * BigInt(s16(b))) >> 8n) & 0xFFFF);
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

// ---- billboards ---------------------------------------------------------------------------------------------------------------
/** T(a, c) = sign(a c) floor(|a| |c| / 256). */
export const tmul = (a, c) => Math.sign(a) * Math.sign(c) * Math.floor(Math.abs(a) * Math.abs(c) / 256);
/**
 * Project an instance { x, y (unsigned 8.8), asset { h, wb } } for a pose: null when not drawable, else { tx, ty, hgt, hpx, wpx, sxc, L, col,
 * ustep, vstep }.  mapW / mapH bound the positions.
 */
export function projectBB(inst, a, pose, mapW, mapH) {
  if (inst.x > mapW * 256 - 1 || inst.y > mapH * 256 - 1) return null;
  const p = castPos(pose), cs = cosa8(pose.a), sn = sina8(pose.a), dx = inst.x - p.x, dy = inst.y - p.y;
  const tx = tmul(dx, cs) + tmul(dy, sn);
  if (tx < 64) return null;
  const hgt = HGT[Math.min(tx >> 3, 1535)], hpx = (a.h * hgt) >> 4;
  if (hpx === 0) return null;
  const wpx = hpx + (hpx >> 3) + (hpx >> 5);                       // 37/32 hpx: the horizontal / vertical scale of the walls
  const ustep = a.wb * (RECIP[wpx] >> 5), vstep = Math.floor(a.h * RECIP[hpx] / 256);
  const ty = tmul(dy, cs) - tmul(dx, sn), q = mulP(tx), aty = Math.abs(ty);
  if ((aty >> 2) >= q) return null;
  const off = Math.floor(64 * aty / q);
  if (off >= 192) return null;
  const sxc = 64 + (ty < 0 ? -off : off), L = sxc - (wpx >> 1);
  return { tx, ty, hgt, hpx, wpx, sxc, L, col: Math.max(0, Math.min(127, sxc)), ustep, vstep };
}
/**
 * Draw the billboards of a pose over walls already in `bitmap` (the cast's dist[] for the depth test); insts: [{ visible, x, y, frame, asset }],
 * assets normalised ({ h, wb, nf, frames }).  Returns bb[i] = { depth, col } (BB_TAB).  Pixel by pixel from the source rows.
 */
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

// ---- the game image -----------------------------------------------------------------------------------------------------------
export const SCRIPT = { SPRTAB: 0x8800, HOT: 0x8840, INST: 0x8860, TILESET: 0x8880, SFXTAB: 0x8D10, SFXDATA: 0x8D40, MAP: 0x9000, ART: 0x9300, END: 0xC000, PTR: 0x8014 };
const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
export const op = {
  ...C.op,
  view: (x, y, a) => ({ op: 'view', x, y, a }),
  cosa: (a) => ({ op: 'cosa', a }), sina: (a) => ({ op: 'sina', a }), fxmul: (a, b) => ({ op: 'fxmul', a, b }),
  wall: (x, y) => ({ op: 'wall', x, y }), setwall: (x, y, t) => ({ op: 'setwall', x, y, t }), spin: (n) => ({ op: 'spin', n }), bbtab: (i) => ({ op: 'bbtab', i }),
};
function encodeOp(o) {
  switch (o.op) {
    case 'view': return [23, ...w16(o.x), ...w16(o.y), ...w16(o.a)];
    case 'cosa': return [24, ...w16(o.a)];
    case 'sina': return [25, ...w16(o.a)];
    case 'fxmul': return [26, ...w16(o.a), ...w16(o.b)];
    case 'wall': return [27, ...w16(o.x), ...w16(o.y)];
    case 'setwall': return [28, ...w16(o.x), ...w16(o.y), ...w16(o.t)];
    case 'spin': return [29, ...w16(o.n)];
    case 'bbtab': return [30, o.i];
    case 'show': return [1, o.i, ...w16(o.x), ...w16(o.y)];                 // always the 16-bit form (world positions)
    case 'showf': return [21, o.i, ...w16(o.x), ...w16(o.y), ...w16(o.f)];
    default: return C.encodeScript([[o]]).slice(0, -1);
  }
}
export function encodeScript8(ticks) { const out = []; for (const t of ticks) { for (const o of t) out.push(...encodeOp(o)); out.push(0); } return out; }

/**
 * Link the v4 script game.  spec: { div, assets, insts, tiles, sfx, map (the 768-cell HUD map), script, view: { colw, mw, mh, cells (mw x mh, row-major),
 * top, bottom, patterns (16 bytes or null), rle (override), desc (override bytes) } or null, divBits (default $C0 with a view), viewPtr (override) }.
 */
export function rayGame(spec = {}) {
  const rt = runtime(), g = scriptAsm();
  const img = linkGame(rt.img, g.bytes);
  const put = (a, bytes) => { img.set(bytes, a); };
  const assets = spec.assets ?? [], insts = spec.insts ?? [];
  const v = spec.view;
  img[0x8004] = (spec.div ?? 1) | (spec.divBits ?? (v ? 0xC0 : 0));
  img[0x8005] = assets.length;
  let dataAt = SCRIPT.ART;
  assets.forEach((a, i) => {
    const bytes = assetBytes(a);
    put(dataAt, bytes);
    let hotPtr = 0;
    if (a.hot) { hotPtr = SCRIPT.HOT + 4 * i; put(hotPtr, a.hot); }
    put(SCRIPT.SPRTAB + 8 * i, [a.w, a.h, ...w16(dataAt), ...w16(hotPtr), a.phases ?? 1, a.nframes]);
    dataAt += bytes.length;
  });
  put(SCRIPT.INST, [insts.length, ...insts]);
  let tilesetPtr = 0, mapPtr = 0, sfxPtr = 0;
  if (spec.tiles) { tilesetPtr = SCRIPT.TILESET; const b = [spec.tiles.length]; for (const t of spec.tiles) b.push(...t.bmp, t.attr); put(tilesetPtr, b); }
  if (spec.sfx) {
    sfxPtr = SCRIPT.SFXTAB; const tab = [spec.sfx.length]; let at = SCRIPT.SFXDATA;
    spec.sfx.forEach((recs) => { tab.push(...w16(at)); const b = recs.flatMap((r) => r).concat([0, 0xFF, 0, 0]); put(at, b); at += b.length; });
    put(sfxPtr, tab);
  }
  if (spec.map) { mapPtr = SCRIPT.MAP; put(mapPtr, spec.map); }
  put(0x8006, w16(SCRIPT.SPRTAB));
  put(0x8008, [...w16(tilesetPtr), ...w16(sfxPtr), ...w16(mapPtr), ...w16(SCRIPT.INST)]);
  // the view's data at the top of the image: the RLE map, the patterns, the descriptor
  let top = SCRIPT.END, viewPtr = 0, rle = null;
  if (v) {
    rle = v.rle ?? rleEncode(v.cells);
    top -= rle.length; const rleAt = top;
    put(rleAt, rle);
    let patAt = 0;
    if (v.patterns) { top -= 16; patAt = top; put(patAt, v.patterns); }
    top -= 10; viewPtr = top;
    put(viewPtr, v.desc ?? [v.colw, v.mw, v.mh, v.top ?? 0x47, v.bottom ?? 0x4F, ...w16(rleAt), ...w16(patAt), 0]);
  }
  put(0x8010, [0, 0, ...w16(spec.viewPtr ?? viewPtr)]);
  const scriptAt = (dataAt + 15) & ~15;
  const sc = encodeScript8(spec.script ?? []);
  if (scriptAt + sc.length + 1 > top) throw new Error(`script too long: ${sc.length} bytes from ${hex(scriptAt)} to ${hex(top)}`);
  img.fill(0, scriptAt, top);
  put(scriptAt, sc);
  put(SCRIPT.PTR, w16(scriptAt));
  return { img, dck: dckOf(img), syms: rt.syms, gsyms: g.syms, spec, scriptAt, rle };
}

// ---- the model -----------------------------------------------------------------------------------------------------------------
/** The cell map (M3 model) + the instances (ray mode: unsigned world positions) + the pose, the map, the window, BB_TAB. */
export class Model8 extends C3.Model {
  constructor(spec = {}) {
    super({ ...spec, sprites: [] });
    const v = spec.view;
    this.ray = !!v && !spec.noRay;
    this.view = v;
    this.assets = (spec.assets ?? []).map(normAsset);
    this.insts = (spec.insts ?? []).slice(0, 16).map((a) => ({ asset: Math.min(a, this.assets.length - 1), visible: false, x: 0, y: 0, frame: 0 }));
    this.mw = this.ray ? v.mw : 0; this.mh = this.ray ? v.mh : 0;
    this.map = this.ray ? loadMap(v.rle ?? rleEncode(v.cells), v.mw, v.mh) : new Uint8Array(1024);
    this.pat = patsOf(v?.patterns);
    this.pose = { x: 0, y: 0, a: 0 };
    this.bb = Array.from({ length: 16 }, () => ({ depth: 0, col: 0xFFFF }));
    this.win = null;                     // { bitmap: the window's bytes } of the last tick
  }
  clone() {
    const m = Object.create(Object.getPrototypeOf(this));
    Object.assign(m, this);
    m.tile = this.tile.slice(); m.attr = this.attr.slice(); m.map = this.map.slice();
    m.insts = this.insts.map((s) => ({ ...s })); m.pose = { ...this.pose }; m.bb = this.bb.map((b) => ({ ...b })); m.log = [];
    return m;
  }
  apply(o) {
    switch (o.op) {
      case 'show': case 'showf': {
        if (o.i < 0 || o.i >= this.insts.length) break;
        const s = this.insts[o.i];
        Object.assign(s, { visible: true, x: o.x & 0xFFFF, y: o.y & 0xFFFF });
        if (o.op === 'showf') s.frame = o.f & 0xFF;
        break;
      }
      case 'hide': if (o.i >= 0 && o.i < this.insts.length) this.insts[o.i].visible = false; break;
      case 'view': this.pose = { x: clampPos(o.x, this.mw * 256 - 1 < 0 ? 0 : this.mw * 256 - 1), y: clampPos(o.y, this.mh * 256 - 1 < 0 ? 0 : this.mh * 256 - 1), a: o.a & 255 }; break;
      case 'cosa': this.log.push(cosa8(o.a & 255) & 0xFFFF); break;
      case 'sina': this.log.push(sina8(o.a & 255) & 0xFFFF); break;
      case 'fxmul': this.log.push(fxmul(o.a, o.b) & 0xFFFF); break;
      case 'wall': this.log.push(wallAt(this.map, o.x, o.y)); break;
      case 'setwall': setWall(this.map, this.mw, this.mh, o.x, o.y, o.t); break;
      case 'bbtab': this.log.push(this.bb[o.i].depth, this.bb[o.i].col); break;
      case 'hit': this.log.push(this.hit(o.a, o.b)); break;
      case 'spin': break;
      default: super.apply(o);
    }
  }
  hit(a, b) {
    if (!this.ray) return 0;
    const A = this.insts[a], B = this.insts[b];
    if (!A || !B || !A.visible || !B.visible) return 0;
    const S = 4 * (this.assets[A.asset].h + this.assets[B.asset].h);
    return Math.abs(A.x - B.x) < S && Math.abs(A.y - B.y) < S ? 1 : 0;
  }
  /** The tick's render (after the ops of the tick): the window into this.win, BB_TAB for the next tick. */
  renderTick() {
    if (!this.ray) return;
    const cast = castFrame(this.map, this.pose, this.view.colw);
    const bitmap = new Uint8Array(6144);
    drawWalls(bitmap, cast, this.pat);
    this.bb = drawBillboards(bitmap, cast, this.insts, this.assets, this.pose, this.mw, this.mh);
    this.win = bitmap;
    this.cast = cast;
  }
  /** The expected display file: cells everywhere, the window from the last render, its attributes from the view. */
  render() {
    const { bitmap, attrs } = C3.Model.prototype.render.call(this, null);
    if (this.ray) {
      for (let r = 0; r < 96; r++) for (let k = 0; k < 16; k++) { const a = rowAddr(VIEW.Y0 + r) + VIEW.X0 + k; bitmap[a] = this.win ? this.win[a] : bitmap[a]; }
      for (let cy = 6; cy < 18; cy++) for (let cx = 8; cx < 24; cx++) attrs[cy * 32 + cx] = cy < 12 ? (this.view.top ?? 0x47) : (this.view.bottom ?? 0x4F);
    }
    return { bitmap, attrs };
  }
}

/** Boot a game and stop at the frame loop's wait (TICK_LOOP) after `frames` refreshes. */
export function bootIdle(game, frames = 12) {
  const S = game.syms, m = newMachine(game.dck);
  bootMachine(m, S);
  for (let f = 0; f < frames; f++) M.runFrame(m);
  for (let i = 0; i < 3000000 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) Z.runZ80(m.cpu, m.bus, 1, m);
  if (m.cpu.pc !== S.TICK_LOOP) throw new Error('the frame loop was not reached');
  return m;
}
export const wr16 = (m, a, v) => { m.ram[a] = v & 0xFF; m.ram[a + 1] = (v >> 8) & 0xFF; };
/** Call ray_render for a pose into display file `file` (0 / 1), interrupts off; returns { t, bitmap (6,144), attrs } of that file. */
export function renderAt(m, S, pose, file = 0) {
  wr16(m, S.RV_X, pose.x); wr16(m, S.RV_Y, pose.y); m.ram[S.RV_A] = pose.a & 255;
  m.ram[S.V_HIDDEN] = file; m.ram[S.V_HOFF] = file ? 0x20 : 0;
  const r = callRoutine(m, S.ray_render);
  if (!r.spOk || !r.preserved) throw new Error('ray_render broke SP or the preserved registers');
  return { t: r.t, ...dfileOf(m, file) };
}
/** The ray arrays of the machine after a render. */
export const rayArrays = (m, S, N) => ({ hh: Array.from({ length: N }, (_, j) => m.ram[S.RAY_HHR + j]), pi: Array.from({ length: N }, (_, j) => m.ram[S.RAY_PIR + j]),
  dist: Array.from({ length: N }, (_, j) => m.ram[S.RAY_DISTL + j] | (m.ram[S.RAY_DISTH + j] << 8)) });

// ---- the spike's maps and poses (for the budgets) ------------------------------------------------------------------------------
const MAP16_ROWS = ['1111111111111111', '1..............1', '1.2222....3333.1', '1.2........3...1', '1.2..44....3...1', '1....44........1', '1..............1',
  '1.33...44...22.1', '1.3.........2..1', '1.3.....3......1', '1...........4..1', '1.444.......4..1', '1.....2222.....1', '1.............31', '1..............1', '1111111111111111'];
/** The spike's maps as map_w x map_h cell arrays (row-major). */
export function spikeMap(n) {
  const m = new Uint8Array(n * n);
  if (n === 16) MAP16_ROWS.forEach((row, y) => { for (let x = 0; x < 16; x++) m[y * 16 + x] = row[x] === '.' ? 0 : +row[x]; });
  else for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    let t = 0;
    if (x === 0 || y === 0 || x === n - 1 || y === n - 1) t = ((x + y) >> 3) % 4 + 1;
    else if (x % 5 === 2 && y % 5 === 2) t = ((x + y) % 4) + 1;
    else if (y === 12 && x > 4 && x < 24 && x % 7 !== 0) t = 2;
    else if (x === 20 && y > 14 && y < 28 && y % 6 !== 0) t = 3;
    else if (x > 5 && x < 11 && y > 19 && y < 25 && (x === 6 || x === 10 || y === 20 || y === 24) && !(x === 8 && y === 24)) t = 4;
    m[y * n + x] = t;
  }
  return m;
}
/** The spike's 16 poses per map ({ x, y, a }, 8.8). */
export function spikePoses(n) {
  const P = n === 16 ? [[1.30, 1.50, 8], [3.50, 6.50, 20], [7.50, 6.50, 0], [7.75, 1.50, 64], [14.30, 14.30, 160], [8.50, 14.50, 192], [1.20, 1.20, 160], [2.50, 1.80, 150],
    [6.50, 6.50, 100], [10.50, 8.50, 40], [13.50, 9.50, 128], [12.50, 6.50, 230], [5.50, 13.50, 245], [4.25, 4.75, 100], [13.50, 1.50, 100], [9.50, 11.50, 210]]
    : [[3.50, 3.50, 20], [8.50, 8.50, 0], [14.50, 14.50, 30], [16.50, 16.50, 100], [21.50, 21.50, 140], [28.50, 28.50, 200], [1.30, 1.40, 200], [30.40, 30.30, 40],
      [3.50, 20.50, 250], [12.50, 25.50, 192], [26.50, 3.50, 90], [18.50, 10.50, 75], [23.50, 21.50, 5], [9.50, 15.50, 60], [25.50, 18.50, 170], [7.50, 28.50, 130]];
  return P.map(([x, y, a]) => ({ x: Math.round(x * 256), y: Math.round(y * 256), a }));
}

// ---- observing a run -------------------------------------------------------------------------------------------------------------
/**
 * Run `game` on a stock TS2068 one instruction at a time from the cartridge entry, `nframes` refreshes after boot; at every tick's flip request the
 * model applies the tick's ops and renders; after every refresh the shown display file must equal the model's snapshot of that file.  Also: no write
 * to the shown file, the frame interrupt's flips.  opts: { script, hooks(pc, ctx), ModelClass, onTick(m, n, model) }.
 */
export function observe8(game, nframes, { script = [], hooks = null, ModelClass = Model8, onTick = null, pixels = false } = {}) {
  const S = game.syms, m = newMachine(game.dck);
  let entry = -1;
  for (let f = 1; f <= 400; f++) { M.runFrame(m); if (rd16(m, S.HO_MARK) === 0x5AA5) { entry = f; break; } }
  const model = new ModelClass(game.spec);
  const st = { m, entry, frames: 0, ticks: 0, ok: 0, bad: 0, firstBad: null, writeViolations: 0, work: [], renders: [], pixelBad: 0, model, spMin: 0xFFFF };
  const snaps = [null, null];
  let armed = false, w0 = null, r0 = null;
  const origWrite = m.bus.write;
  m.bus.write = (addr, v) => { const a = addr & 0xFFFF, base = (m.portFF & 1) ? 0x6000 : 0x4000; if (armed && a >= base && a < base + 0x1B00) st.writeViolations++; origWrite(addr, v); };
  for (let f = 0; f < nframes + 400 && st.frames < nframes; f++) {
    const end = m.frameStart + FRAME_T;
    while (m.tstates < end) {
      const cpu = m.cpu, pc = cpu.pc;
      if (pc === S.MAIN) armed = true;
      if (cpu.sp < st.spMin) st.spMin = cpu.sp;
      if (pc === S.WORK_START) w0 = m.tstates;
      if (pc === S.ray_render) r0 = { t: m.tstates, sp: cpu.sp };
      if (r0 && pc === rd16(m, r0.sp) && cpu.sp === r0.sp + 2) { st.renders.push(m.tstates - r0.t); r0 = null; }
      if (pc === S.WORK_END && w0 !== null) { st.work.push(m.tstates - w0); w0 = null; }
      if (pc === S.TICK_REQUEST) {
        const n = rd16(m, S.V_TICKS) - 1, hidden = rd8(m, S.V_HIDDEN);
        for (const o of script[n] ?? []) model.apply(o);
        model.renderTick();
        snaps[hidden] = model.clone();
        st.ticks = n + 1;
        if (onTick) onTick(m, n, model);
      }
      if (hooks) hooks(pc, { m, st });
      if (cpu.halted) break;
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
    if (!armed) continue;
    st.frames++;
    const bit = m.portFF & 1, sn = snaps[bit];
    if (!sn) continue;
    const exp = sn.render(), got = dfileOf(m, bit);
    const bad = diffCount(exp.bitmap, got.bitmap) + diffCount(exp.attrs, got.attrs);
    if (pixels) { const sc = shownColours(m), ec = colourPlane(exp); if (sc === null || diffCount(ec, sc) !== 0) st.pixelBad++; }
    if (bad === 0) st.ok++;
    else {
      st.bad++;
      if (!st.firstBad) {
        const where = [];
        for (let i = 0; i < 6144 && where.length < 6; i++) if (exp.bitmap[i] !== got.bitmap[i]) where.push(`${hex(i, 4)}:${hex(got.bitmap[i], 2)}/${hex(exp.bitmap[i], 2)}`);
        st.firstBad = { frame: st.frames, bad, file: bit, where: where.join(' ') };
      }
    }
  }
  const { LOGN, LOGBUF } = logAddrs(S);
  st.gameLog = Array.from({ length: rd16(m, LOGN) }, (_, i) => rd16(m, LOGBUF + 2 * i));
  st.modelLog = model.log;
  st.canary = rd16(m, S.STACK_CANARY);
  return st;
}

/** A random map of mw x mh cells (outer ring walls of random types, `fill` of the interior walls), every type 1..4 used. */
export function randomCells(r, mw, mh, fill = 0.18) {
  const c = new Uint8Array(mw * mh);
  for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) {
    const ring = x === 0 || y === 0 || x === mw - 1 || y === mh - 1;
    c[y * mw + x] = ring || r.chance(fill) ? r.int(1, 4) : 0;
  }
  return c;
}
/** A random pose inside an empty cell (fractions: 1/8 of them exactly 0 on each axis; angles: 1/6 of them axis-aligned). */
export function randomPose(r, map, mw, mh) {
  for (;;) {
    const cx = r.int(1, mw - 2), cy = r.int(1, mh - 2);
    if (map[cy * 32 + cx]) continue;
    const fx = r.chance(0.125) ? 0 : r.int(0, 255), fy = r.chance(0.125) ? 0 : r.int(0, 255);
    return { x: cx * 256 + fx, y: cy * 256 + fy, a: r.chance(1 / 6) ? r.pick([0, 64, 128, 192]) : r.int(0, 255) };
  }
}
