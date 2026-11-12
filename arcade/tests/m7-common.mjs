"use strict";
// m7-common.mjs -- shared helpers of the runtime v3 part 2 tests (m7-*.mjs): the scrolling window, sprites in window mode, the camera and the
// collision routines.  Everything here is written from docs/ARCADE_PLATFORMER_CONTRACT.md (sections 3, 3b, 4, 5), docs/ARCADE_LANGUAGE_BATCH2.md
// (decisions 8, 10-13) and docs/ARCADE_RUNTIME_API_V3.md "As built (v3 part 2)", NOT from the Z80 sources, and not from the compiler's
// src/lang/arcade (the window data are built here by our own builders: tables, tile rows, flags, the byte-RLE world, the descriptor):
//   * `winGame(spec)`: the script game (test_script.asm) with DIV_EXT | DIV_WIN and a window_desc + its data written into the image;
//   * `rleEncode()` / `rleDecode()`: the byte-RLE of world_src (contract 3b);
//   * `refWindow()`: the reference compositor of the window, PIXEL BY PIXEL from the tile rows (no pre-shifted tables); option 2 (default) or 1 (the old colour rule);
//   * `classifyWorld()` / `setWorldClassed()` / `expectWorld()`: the class bits of WORLD_RAM (docs/ARCADE_WINDOW_FASTPATH.md section 2) and the SETWORLD update;
//   * `Model7`: the cell map + window + sprites in world coordinates (culling, clipping by ring repair) + camera + WORLD_RAM + collision;
//   * the collision model (`colTile`, `colFlags`, `colHit`) written from the contract, with the outside rules.
import * as C from './m6-common.mjs';
import { dckOf } from '../tools/build-runtime-v3.mjs';
import { rng } from './m3-scenes.mjs';
export * from './m6-common.mjs';
const { C3, int16, rowAddr, hex } = C;

// ---- where the window's data go in the test image (the script and the art must end below WIN.BASE) ----------------------------
// The tables take the top 3,584 bytes ($B200-$BFFF, page aligned as the compiler puts them); below them, packed downwards: the RLE world, the tile rows
// (at an odd address: they need not be page aligned), the flags and the descriptor.  The script must end below the descriptor.
export const WIN = { TABLES: 0xB200 };
export function winLayout(rleLen) { const RLE = WIN.TABLES - rleLen, TROWS = (RLE - 257) | 1, FLAGS = TROWS - 33, DESC = FLAGS - 24; return { RLE, TROWS, FLAGS, DESC, BASE: DESC }; }

const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
// ---- the extra script ops of test_script.asm (v3 part 2) -------------------------------------------------------------------------
export const op = {
  ...C.op,
  camera: (x) => ({ op: 'camera', x }),
  worldtile: (x, y) => ({ op: 'worldtile', x, y }),
  tileflags: (x, y) => ({ op: 'tileflags', x, y }),
  tilehit: (x, y, w, h, mask) => ({ op: 'tilehit', x, y, w, h, mask }),
  setworld: (x, y, t) => ({ op: 'setworld', x, y, t }),
  spin: (n) => ({ op: 'spin', n }),
};
function encodeOp(o) {
  switch (o.op) {
    case 'camera': return [23, ...w16(o.x)];
    case 'worldtile': return [24, ...w16(o.x), ...w16(o.y)];
    case 'tileflags': return [25, ...w16(o.x), ...w16(o.y)];
    case 'tilehit': return [26, ...w16(o.x), ...w16(o.y), ...w16(o.w), ...w16(o.h), ...w16(o.mask)];
    case 'setworld': return [27, ...w16(o.x), ...w16(o.y), ...w16(o.t)];
    case 'spin': return [28, ...w16(o.n)];
    default: return C.encodeScript([[o]]).slice(0, -1);
  }
}
export function encodeScript7(ticks) { const out = []; for (const t of ticks) { for (const o of t) out.push(...encodeOp(o)); out.push(0); } return out; }

// ---- the window's data (contract 3b) -----------------------------------------------------------------------------------------------
/** tile rows: 256 bytes, tile * 8 + r = row r of tile t (from the test tileset; tiles the set lacks are blank). */
export function tileRowsOf(tiles) { const out = new Uint8Array(256); tiles.slice(0, 32).forEach((t, k) => t.bmp.forEach((b, r) => { out[k * 8 + r] = b; })); return out; }
/** the scroll tables: 14 pages, page 2(p-1) = LTAB[p] = (row << p) & $FF, page 2(p-1)+1 = RTAB[p] = row >> (8 - p). */
export function scrollTables(rows) {
  const out = new Uint8Array(14 * 256);
  for (let p = 1; p <= 7; p++) for (let i = 0; i < 256; i++) { out[(2 * p - 2) * 256 + i] = (rows[i] << p) & 0xFF; out[(2 * p - 1) * 256 + i] = rows[i] >> (8 - p); }
  return out;
}
/** byte-RLE: pairs (count 1..255, value), a count of 0 ends. */
export function rleEncode(bytes) {
  const out = [];
  for (let i = 0; i < bytes.length;) { let n = 1; while (i + n < bytes.length && n < 255 && bytes[i + n] === bytes[i]) n++; out.push(n, bytes[i]); i += n; }
  out.push(0);
  return out;
}
/** The decoder as the contract describes it (the expansion is cut at 2,048 bytes; the rest of WORLD_RAM is 0). */
export function rleDecode(src) {
  const out = new Uint8Array(2048); let o = 0;
  for (let i = 0; i < src.length && src[i] !== 0 && o < 2048; i += 2) for (let k = 0; k < src[i] && o < 2048; k++) out[o++] = src[i + 1] ?? 0;
  return out;
}
/** cam_max of the contract: floor((8 world_w - 192) / maxratio). */
export const camMaxOf = (worldW, bands) => Math.floor((worldW * 8 - 192) / (bands.some((b) => b.code === 4) ? 2 : 1));
/** The band's pixel position: 0 fixed, 1 = 1/4, 2 = 1/2, 3 = 1, 4 = 2 (floor of camera x ratio). */
export const bandPos = (cam, code) => [0, Math.floor(cam / 4), Math.floor(cam / 2), cam, cam * 2][code];

/** A random world (the RAM image: row r at r * 128, cell = tile * 8, columns >= worldW zero): `sky` = the fraction of tile-0 cells. */
export function randomWorld(r, worldW, ntiles, { sky = 0.3, rows = 16 } = {}) {
  const ram = new Uint8Array(2048);
  for (let y = 0; y < rows; y++) for (let x = 0; x < worldW; x++) ram[y * 128 + x] = (r.chance(sky) ? 0 : r.int(1, ntiles - 1)) * 8;
  return ram;
}
/** Random window tiles: tile 0 blank (the sky), the others random bitmaps with random attributes. */
export function randomWinTiles(r, n = 32) {
  return Array.from({ length: n }, (_, k) => ({ bmp: Array.from({ length: 8 }, () => (k === 0 ? 0 : r.int(0, 255))), attr: k === 0 ? 0x28 : r.int(0, 255) & 0x7F }));
}

/**
 * The script game in window mode.  spec = scriptGame's spec (assets, insts, tiles = the game tileset, the first 32 are the window's tiles, map = the
 * HUD cell map, script = ops incl. the m7 ops) + win: { cx, cy, worldW, bands: [{rows, code}], ram (2,048-byte world), camMax (descriptor value,
 * default the contract's), flags (32), rle (bytes overriding the encoding), desc (bytes overriding the descriptor), tableRows (tile rows for the tables
 * and tilerows; default from the tileset), noDivWin, divBits }.
 */
export function winGame(spec) {
  const w = spec.win;
  const rle = w.rle ?? rleEncode(w.ram);
  const L = winLayout(rle.length);
  const g = C.scriptGame({ ...spec, script: [], divBits: w.divBits ?? (w.noDivWin ? 0x80 : 0xC0), winDesc: L.DESC });
  const sc = encodeScript7(spec.script ?? []);
  if (g.scriptAt + sc.length + 1 > L.BASE) throw new Error(`script too long for the window test image: ${sc.length} bytes from ${hex(g.scriptAt)} to ${hex(L.BASE)}`);
  g.img.fill(0, g.scriptAt, 0xC000);
  g.img.set(sc, g.scriptAt);
  const rows = w.tableRows ?? tileRowsOf(spec.tiles ?? []);
  g.img.set(rle, L.RLE);
  g.img.set(rows, L.TROWS);
  g.img.set(scrollTables(rows), WIN.TABLES);
  const flags = w.flags ?? new Array(32).fill(0);
  g.img.set(flags.slice(0, 32), L.FLAGS);
  const camMax = w.camMax ?? camMaxOf(w.worldW, w.bands);
  const desc = w.desc ?? [w.cx, w.cy, w.bands.length, w.worldW, ...w16(camMax), ...w16(WIN.TABLES), ...w16(L.FLAGS), ...w16(L.RLE), ...w16(L.TROWS),
    ...w.bands.flatMap((b) => [b.rows, b.code])];
  g.img.set(desc, L.DESC);
  g.layout = L;
  g.dck = dckOf(g.img);
  g.spec = spec;
  return g;
}

// ---- the reference compositor (pixel by pixel) ---------------------------------------------------------------------------------
/**
 * Which colour rule the reference compositor (and every test that compares the runtime's WORLD_RAM) follows.
 *   option 2 (the default; docs/ARCADE_WINDOW_FASTPATH.md section 1): when the two tiles of a cell have different attributes, the pixels of the tile that does
 *     not give the cell its colours are 0; WORLD_RAM carries the class bits of section 2.
 *   option 1 (the runtime before that change): both tiles' pixels are drawn and the cell has one attribute; WORLD_RAM has no class bits.
 * M7_OPTION=1 in the environment makes option 1 the default, so that the OLD runtime can be checked against the model (the checks written for the new
 * behaviour alone, the class-bit and option-2 checks marked "new" in their texts, then fail, as they should).
 */
export const WINDOW_OPTION = process.env.M7_OPTION === '1' ? 1 : 2;
export const CLASS_BITS = WINDOW_OPTION === 2;

/**
 * Write the window into bitmap (6,144) / attrs (768): for every band at its position, every window cell, every pixel: world pixel X = pos + 8 col + px of
 * the band's world row; its ink bit from the tile rows; the cell's attribute = the attribute of the tile covering at least half of the cell: world column col0 + col + (phase >= 4 ? 1 : 0)
 * (Part C of docs/ARCADE_LANGUAGE_BATCH6.md; at exactly 4 pixels the right tile).
 * Option 2 (section 1 of docs/ARCADE_WINDOW_FASTPATH.md), per pixel: at phase <> 0, when attr(A) <> attr(B) (A = the tile at col0 + col, B = the next one), a pixel
 * that belongs to the minority tile (the one that does not give the cell its attribute: B when the phase is below 4, A from 4 on) is 0.
 * `opts.option` (1 or 2) overrides WINDOW_OPTION.
 */
export function refWindow(bitmap, attrs, { cx, cy, bands }, ram, rows, tileAttr, cam, opts = {}) {
  const option = opts.option ?? WINDOW_OPTION;
  let row0 = 0;
  for (const b of bands) {
    const pos = bandPos(cam, b.code), col0 = pos >> 3, p = pos & 7;
    for (let wr = row0; wr < row0 + b.rows; wr++) for (let col = 0; col < 24; col++) {
      const tA = (ram[wr * 128 + col0 + col] >> 3) & 31, tB = (ram[wr * 128 + col0 + col + 1] >> 3) & 31;
      const differ = p !== 0 && tileAttr[tA] !== tileAttr[tB];
      const major = p >= 4 ? col0 + col + 1 : col0 + col;                  // the column of the tile whose colours the cell takes
      for (let r = 0; r < 8; r++) {
        let byte = 0;
        for (let px = 0; px < 8; px++) {
          const X = pos + 8 * col + px, t = (ram[wr * 128 + (X >> 3)] >> 3) & 31;
          let bit = (rows[t * 8 + r] >> (7 - (X & 7))) & 1;
          if (option === 2 && differ && (X >> 3) !== major) bit = 0;
          byte = (byte << 1) | bit;
        }
        bitmap[rowAddr((cy + wr) * 8 + r) + cx + col] = byte;
      }
      attrs[(cy + wr) * 32 + cx + col] = tileAttr[(ram[wr * 128 + col0 + col + (p >= 4 ? 1 : 0)] >> 3) & 31];
    }
    row0 += b.rows;
  }
}

// ---- the class bits of WORLD_RAM (docs/ARCADE_WINDOW_FASTPATH.md section 2), written from the contract ----------------------------
/** A tile is blank when its 8 rows are all zero (any tile number). */
export const isBlankTile = (rows, t) => { for (let r = 0; r < 8; r++) if (rows[t * 8 + r]) return false; return true; };
/**
 * The class byte (tile * 8 + S + 2 D + 4 P) of column y of a row whose tile numbers are `tiles[0 .. W-1]` (world width W).
 *   D_y = attr(t(y - 1)) <> attr(t(y)), S_y = D_y or (blank(t(y - 1)) and blank(t(y))): both 0 for y = 0 (and for y >= W, which has no cell);
 *   P_y = S_y or S_(y + 1) (S_W = 0, so P_(W-1) = S_(W-1)).
 */
export function classByte(tiles, y, W, rows, attr) {
  const D = (k) => (k >= 1 && k < W && attr[tiles[k - 1]] !== attr[tiles[k]] ? 1 : 0);
  const S = (k) => (k >= 1 && k < W ? (D(k) || (isBlankTile(rows, tiles[k - 1]) && isBlankTile(rows, tiles[k])) ? 1 : 0) : 0);
  if (y >= W) return tiles[y] * 8;
  return tiles[y] * 8 + S(y) + 2 * D(y) + 4 * (S(y) | S(y + 1));
}
/** The classified 2,048 bytes of a world: `ram` = WORLD_RAM contents (tile * 8, the low three bits ignored), W = world_w, rows = the 256 tile-row bytes, attr = the tile attributes (32). */
export function classifyWorld(ram, W, rows, attr) {
  const out = new Uint8Array(2048);
  for (let r = 0; r < 16; r++) {
    const tiles = Array.from({ length: 128 }, (_, y) => (ram[r * 128 + y] >> 3) & 31);
    for (let y = 0; y < 128; y++) out[r * 128 + y] = classByte(tiles, y, W, rows, attr);
  }
  return out;
}
/** The class model of RT_SETWORLD: from a classified world, the world after tile t is set at pixel (x, y): the bytes x - 1, x, x + 1 of that row inside the world are recomputed. */
export function setWorldClassed(cls, W, rows, attr, x, y, t) {
  const out = cls.slice(), c = Math.floor(x / 8), r = Math.floor(y / 8);
  if (!(c >= 0 && c < W && r >= 0 && r < 16)) return out;
  const tiles = Array.from({ length: 128 }, (_, k) => (cls[r * 128 + k] >> 3) & 31);
  tiles[c] = t & 31;
  for (let k = c - 1; k <= c + 1; k++) if (k >= 0 && k < W) out[r * 128 + k] = classByte(tiles, k, W, rows, attr);
  out[r * 128 + c] = (out[r * 128 + c] & 7) | ((t & 31) * 8);
  return out;
}
/**
 * What the runtime's WORLD_RAM must hold for a world of `ram` (tile * 8 bytes): with the class bits (option 2) or as it is (option 1, the old runtime).
 * `attr` and `rows` as classifyWorld.
 */
export const expectWorld = (ram, W, rows, attr) => (CLASS_BITS ? classifyWorld(ram, W, rows, attr) : Uint8Array.from(ram, (v) => v & 0xF8));
/**
 * The world of the class-bit and table-case tests: tiles 0, 1, 2 blank (attributes $28, $31, $28: tile 1 differs in colour, tile 2 is the sky's twin), 3 ordinary with the
 * sky's colours, 4 and 5 ordinary with a colour of their own, 6 and 7 ordinary with a single set pixel (one non-zero row: not blank), colours $2F and $47; the rest
 * random.  Each row of the 128 x 16 world walks a de Bruijn sequence over tiles 0..7 (every ordered pair once in 64 columns, twice in 128), turned by the row number.
 */
export function caseWorld(seed = 1801) {
  const r = rng(seed);
  const tiles = randomWinTiles(r, 32);
  [0x28, 0x31, 0x28, 0x28, 0x16, 0x16, 0x2F, 0x47].forEach((a, k) => { tiles[k].attr = a; });
  for (let k = 0; k < 3; k++) tiles[k].bmp = Array(8).fill(0);
  for (let k = 3; k < 8; k++) tiles[k].bmp = tiles[k].bmp.map((b) => b || 0xA5);
  tiles[6].bmp = [0x80, 0, 0, 0, 0, 0, 0, 0]; tiles[7].bmp = [0, 0, 0, 0, 0, 0, 0, 1];
  const N = 8, a = Array(N * 2).fill(0), seq = [];
  const db = (t, p) => { if (t > 2) { if (2 % p === 0) for (let i = 1; i <= p; i++) seq.push(a[i]); } else { a[t] = a[t - p]; db(t + 1, p); for (let j = a[t - p] + 1; j < N; j++) { a[t] = j; db(t + 1, t); } } };
  db(1, 1);
  const ram = new Uint8Array(2048);
  for (let y = 0; y < 16; y++) for (let x = 0; x < 128; x++) ram[y * 128 + x] = ((seq[x % seq.length] + y) % N) * 8;
  return { tiles, ram, seqLen: seq.length, rows: tileRowsOf(tiles), attr: tiles.map((t) => t.attr) };
}
/** The cases of the section 1 table, for coverage: kind of A and B ('blank' / 'ord') and whether their attributes are equal. */
export const cellCase = (rows, attr, tA, tB) => `${isBlankTile(rows, tA) ? 'blank' : 'ord'}/${isBlankTile(rows, tB) ? 'blank' : 'ord'}/${attr[tA] === attr[tB] ? 'eq' : 'ne'}`;

// ---- the collision model (contract 4; batch 2 decisions 10-13), straight from the words -------------------------------------------
const sh3 = (v) => Math.floor(v / 8);
export function colTile(ram, ww, x, y) { const c = sh3(x), r = sh3(y); return c >= 0 && c < ww && r >= 0 && r < 16 ? ram[r * 128 + c] >> 3 : 0; }
export function colFlags(ram, ww, flags, x, y) {
  const c = sh3(x), r = sh3(y);
  if (r >= 16) return 0;                                   // below the world, whatever the column
  if (r < 0 || c < 0 || c >= ww) return 1;                 // above, left, right: solid
  return flags[(ram[r * 128 + c] >> 3) & 31];
}
/** Cells x..x+w-1, y..y+h-1 (exact); all rows < 0 behave alike, so do all rows >= 16, all columns < 0 and all >= ww: one of each is enough. */
export function colHit(ram, ww, flags, x, y, w, h, mask) {
  if (w <= 0 || h <= 0) return 0;
  const c0 = sh3(x), c1 = sh3(x + w - 1), r0 = sh3(y), r1 = sh3(y + h - 1);
  const reps = (a, b, n) => {                               // the distinct kinds of index in a..b: one below 0, the ones inside, one at n or above
    const out = [];
    if (a < 0) out.push(-1);
    for (let k = Math.max(a, 0); k <= Math.min(b, n - 1); k++) out.push(k);
    if (b >= n) out.push(n);
    return out;
  };
  let acc = 0;
  for (const r of reps(r0, r1, 16)) for (const c of reps(c0, c1, ww)) acc |= colFlags(ram, ww, flags, c * 8, r * 8) & mask;
  return acc & 0xFFFF;
}

// ---- the model ------------------------------------------------------------------------------------------------------------------
/** Model6 + the window: unclamped world positions, the camera, WORLD_RAM, the window and the sprites (culled, clipped by ring repair) in render(). */
export class Model7 extends C.Model6 {
  constructor(spec = {}) {
    super(spec);
    const w = spec.win;
    this.win = spec.noBoot || !w || w.expectNoWindow ? null : w;
    this.ram = this.win ? rleDecode(w.rle ?? rleEncode(w.ram)) : new Uint8Array(2048);
    this.cam = 0;
    this.camMax = this.win ? Math.min(w.camMax ?? 65535, camMaxOf(w.worldW, w.bands)) : 0;
    this.rows = this.win ? (w.tableRows ?? tileRowsOf(spec.tiles ?? [])) : null;
    this.flags = this.win ? (w.flags ?? new Array(32).fill(0)) : null;
    this.wAttr = Array.from({ length: 32 }, (_, t) => this.tileAttr[t]);
  }
  clone() { const m = super.clone(); m.ram = this.ram.slice(); return m; }
  /** What the runtime's WORLD_RAM holds now (class bits included under option 2). */
  worldRam() { return this.win ? expectWorld(this.ram, this.win.worldW, this.rows, this.wAttr) : this.ram.slice(); }
  show(i, x, y, f) {
    if (!this.win) return super.show(i, x, y, f);
    if (i < 0 || i >= this.insts.length) return;
    Object.assign(this.insts[i], { visible: true, x: int16(x), y: int16(y) });
    if (f !== undefined) this.insts[i].frame = f & 0xFF;
  }
  apply(o) {
    const w = this.win;
    switch (o.op) {
      case 'camera': { const v = int16(o.x); this.cam = v < 0 ? 0 : Math.min(v, this.camMax); break; }
      case 'setworld': if (w) { const c = sh3(int16(o.x)), r = sh3(int16(o.y)); if (c >= 0 && c < w.worldW && r >= 0 && r < 16) this.ram[r * 128 + c] = (o.t * 8) & 0xFF; } break;
      case 'worldtile': this.log.push(w ? colTile(this.ram, w.worldW, int16(o.x), int16(o.y)) : 0); break;
      case 'tileflags': this.log.push(w ? colFlags(this.ram, w.worldW, this.flags, int16(o.x), int16(o.y)) : (int16(o.y) >> 3 >= 16 ? 0 : 1)); break;
      case 'spin': break;
      case 'tilehit': this.log.push(colHit(this.ram, w ? w.worldW : 0, this.flags ?? [], int16(o.x), int16(o.y), int16(o.w), int16(o.h), o.mask & 0xFFFF)); break;
      default: super.apply(o);
    }
  }
  /** Where instance i is drawn: { sx, sy, w, h, ring } or null (hidden, off the screen, or missing the window). */
  placed(i) {
    const s = this.insts[i], w = this.win;
    if (!s.visible) return null;
    const a = this.assets[s.asset];
    const sx = (s.x - this.cam + 8 * w.cx) & ~(a.gran - 1), sy = s.y + 8 * w.cy;   // rounded in screen coordinates (As built, deviation 1)
    if (sx < 0 || sx + a.w > 256 || sy < 0 || sy + a.h > 192) return null;
    const X0 = 8 * w.cx, X1 = X0 + 192, Y0 = 8 * w.cy, Y1 = Y0 + 128;
    if (!(sx < X1 && sx + a.w > X0 && sy < Y1 && sy + a.h > Y0)) return null;
    return { sx, sy, w: a.w, h: a.h, ring: !(sx >= X0 && sx + a.w <= X1 && sy >= Y0 && sy + a.h <= Y1) };
  }
  render() {
    if (!this.win) return super.render();
    const base = C3.Model.prototype.render.call(this, null);
    const bitmap = base.bitmap.slice(), attrs = base.attrs.slice();
    const w = this.win;
    refWindow(bitmap, attrs, w, this.ram, this.rows, this.wAttr, this.cam);

    const touched = new Set();
    this.insts.forEach((s, i) => {
      const p = this.placed(i);
      if (!p) return;
      const a = this.assets[s.asset], f = Math.min(s.frame, a.nf - 1);
      a.frames[f].forEach((row, r) => {
        for (let px = 0; px < a.w; px++) {
          const keep = (row.m[px >> 3] >> (7 - (px & 7))) & 1, ink = (row.i[px >> 3] >> (7 - (px & 7))) & 1;
          const x = p.sx + px, adr = rowAddr(p.sy + r) + (x >> 3), bit = 0x80 >> (x & 7);
          bitmap[adr] = ((keep ? bitmap[adr] : bitmap[adr] & ~bit) | (ink ? bit : 0)) & 0xFF;
        }
      });
      for (let cy = p.sy >> 3; cy <= (p.sy + p.h - 1) >> 3; cy++) for (let cx = p.sx >> 3; cx <= (p.sx + p.w - 1) >> 3; cx++) {
        if (cy < w.cy || cy >= w.cy + 16 || cx < w.cx || cx >= w.cx + 24) touched.add(cy * 32 + cx);
      }
    });
    for (const idx of touched) {                            // ring repair: the cell from the cell map, bitmap and attribute
      const cy = idx >> 5, cx = idx & 31;
      for (let r = 0; r < 8; r++) bitmap[rowAddr(cy * 8 + r) + cx] = base.bitmap[rowAddr(cy * 8 + r) + cx];
      attrs[idx] = base.attrs[idx];
    }
    return { bitmap, attrs };
  }
}

/** Boot a game and stop at the frame loop's wait (TICK_LOOP) after `frames` refreshes, so routines can be called directly. */
export function bootIdle(game, frames = 12) {
  const S = game.syms, m = C.run(game, frames);
  for (let i = 0; i < 2000000 && !(m.cpu.pc === S.TICK_LOOP && !m.cpu.halted); i++) C.Z.runZ80(m.cpu, m.bus, 1, m);
  if (m.cpu.pc !== S.TICK_LOOP) throw new Error('the frame loop was not reached');
  return m;
}
export const wr16 = (m, a, v) => { m.ram[a] = v & 0xFF; m.ram[a + 1] = (v >> 8) & 0xFF; };

/**
 * Run a game on the stock machine one instruction at a time (the real frame interrupt), `nframes` refreshes after the entry, and time the calls of
 * the routines in `routines` ({name: address}; a span ends when its CALL returns) and the tick work (WORK_START .. WORK_END), each both with and
 * without the interrupt handler's time (ISR + sound tick).  Returns { spans: {name: [{t, tx}]}, work: [{t, tx, n}], m }.
 */
export function timeRun(game, nframes, routines) {
  const S = game.syms, m = C.newMachine(game.dck);
  for (let f = 1; f <= 400 && C.rd16(m, S.HO_MARK) !== 0x5AA5; f++) C.M.runFrame(m);
  const spans = Object.fromEntries(Object.keys(routines).map((k) => [k, []])), work = [], open = [];
  const byAddr = new Map(Object.entries(routines).map(([k, a]) => [a, k]));
  let inIsr = false, isrT0 = 0, isrAcc = 0, w0 = null;
  for (let f = 0; f < nframes; f++) {
    const end = m.frameStart + C.FRAME_T;
    while (m.tstates < end) {
      const cpu = m.cpu, pc = cpu.pc;
      const isr = (pc >= S.ISR && pc < S.ISR_END) || (pc >= S.SND_S && pc < S.SND_E) || (inIsr && pc >= S.SND_XS && pc < S.SND_E);   // (the tick calls SND_SYNC / SND_OWNCLR below SND_S: music)
      if (isr && !inIsr) { inIsr = true; isrT0 = m.tstates - 13; } else if (!isr && inIsr) { inIsr = false; isrAcc += m.tstates - isrT0; }
      if (!inIsr) {
        const name = byAddr.get(pc);
        if (name) open.push({ name, sp: cpu.sp, ret: C.rd16(m, cpu.sp), t0: m.tstates, i0: isrAcc });
        for (let k = open.length - 1; k >= 0; k--) { const s = open[k]; if (pc === s.ret && cpu.sp === s.sp + 2) { spans[s.name].push({ t: m.tstates - s.t0, tx: m.tstates - s.t0 - (isrAcc - s.i0) }); open.splice(k, 1); } }
        if (pc === S.WORK_START) w0 = { t0: m.tstates, i0: isrAcc, n: C.rd16(m, S.V_TICKS) };
        if (pc === S.WORK_END && w0) { work.push({ t: m.tstates - w0.t0, tx: m.tstates - w0.t0 - (isrAcc - w0.i0), n: w0.n }); w0 = null; }
      }
      if (cpu.halted) break;
      C.Z.runZ80(cpu, m.bus, 1, m);
    }
    C.M.runFrame(m);
  }
  return { spans, work, m };
}
