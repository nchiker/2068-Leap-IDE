/**
 * src/tools/sprite-model.js — the data model of the Leap Arcade Studio sprite editor (pure: no DOM, Node can import it).
 *
 * One sprite is edited as a plain object ("sprite"), different from the stored asset only in that the row bit masks are
 * integers instead of hex strings:
 *
 *   { w, h, phases, hot: [x, y, w, h] | null,
 *     frames: [ { rows: [ { bits, mask, ink, paper, bright } x h ] } ] }
 *
 *   bits   one bit per pixel, MSB = leftmost: 1 = the row's INK colour, 0 = its PAPER colour
 *   mask   1 = the sprite covers the background there, 0 = transparent (docs/ARCADE_ASSETS.md)
 *   ink, paper  0..7 (TS2068 colours), bright 0 / 1: ONE bright flag for the row, as the hardware has it
 *
 * The colour model of docs/ARCADE_ASSETS.md ("two colours per 8x1 row, one BRIGHT flag") is enforced by construction: a
 * pixel stores only a bit, so it can only be the ink or the paper of its row. Writing a colour into a pixel
 * (paintColour) either picks the matching one or re-colours the row's ink / paper, which changes the row's other pixels of
 * that role; no operation can create a third colour in a row.
 *
 *   fromAsset(asset) / toAsset(sprite)     the stored form (hex strings) <-> the editing form
 *   newSprite, cloneSprite, frame / pixel / row-colour operations, fill, line, flips, rotate, shift, clear, invert
 *   autoMask, outline                      mask helpers
 *   framePixels, onionSkin, familyPixels   what the picture looks like (as authored, onion skin, per display family)
 *   importRGBA, importSheet                image import with palette reduction and ordered / Sierra-lite dither
 *   validateSprite, sizeInfo               the compiler's limits and the byte cost
 *   createHistory                          undo / redo
 */

"use strict";

// ── limits ────────────────────────────────────────────────────────────────────────────────────────────────────
export const WIDTHS = [8, 16, 24, 32];
export const MAX_H = 48;
export const MAX_FRAMES = 255;
export const PHASE_CHOICES = [1, 2, 4, 8];
export const DEFAULT_PHASES = 8;
/** What the build (src/lang/arcade/arcade-codegen.js convertSprite, runtime v2) accepts today; the editor warns past it. */
export const COMPILER_SUPPORT = {
  maxW: 16,                 // convertSprite: "width N is not supported yet in M2 (1..16 pixels)"
  maxH: 16,                 // ... and 1..16 rows (the runtime clamps taller sprites to 16)
  compiledFrames: 1,        // only frames[0] is compiled ("SHOW ... FRAME" is not supported yet)
  rowBytes: 4,              // mask_hi mask_lo image_hi image_lo, whatever the width
  descriptorWidth: 16,      // the descriptor's width byte stays 16 and the pre-shifted data has 16-bit rows
  colours: false,           // ink / paper / bright are authoring data; the runtime colours a sprite from the screen cell under it
};
export const FAMILIES = ['ecm', 'flip', 'hires'];
export const DEFAULT_ROW = { ink: 7, paper: 0, bright: 1 };

// ── colours ───────────────────────────────────────────────────────────────────────────────────────────────────
const COLOUR_NAMES = ['black', 'blue', 'red', 'magenta', 'green', 'cyan', 'yellow', 'white'];
const RGB16 = [[0, 0, 0], [0, 0, 204], [201, 5, 0], [206, 0, 196], [0, 204, 8], [0, 204, 204], [204, 204, 0], [204, 204, 204],
  [51, 51, 51], [51, 51, 255], [252, 56, 51], [255, 51, 247], [51, 255, 59], [51, 255, 255], [255, 255, 51], [255, 255, 255]];
/** The palette the emulator shows (tsrun/screen.frag.glsl); index = ink + 8 * bright. */
export const PALETTE = RGB16.map((rgb, i) => ({ name: (i >= 8 ? 'bright ' : '') + COLOUR_NAMES[i & 7], rgb }));
/** The 15 colours that exist: BRIGHT BLACK is black. Keys: 0 = black, 1..7 normal, 9..15 bright. */
export const COLOUR_KEYS = [0, 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15];

/** The key of an ink / paper colour in a row with the given bright flag (black has one key). */
export const colourKey = (c, bright) => (c === 0 ? 0 : c + 8 * (bright ? 1 : 0));
export const normKey = (key) => (key === 8 ? 0 : key);
export const keyParts = (key) => ({ ink: key & 7, bright: key >> 3 });
export const keyName = (key) => PALETTE[normKey(key)].name;
/** RGB of a key, from `pal` ([{rgb}], default PALETTE; index = ink + 8 * bright). Black is black in both brightnesses. */
export function keyRGB(key, pal = PALETTE) { return (pal[normKey(key)] ?? PALETTE[normKey(key)]).rgb; }
const RGB15 = (key) => (key === 0 ? [0, 0, 0] : RGB16[key]);          // for quantising: the real 15 colours

// ── small integer helpers (bits are unsigned up to 32 wide) ──────────────────────────────────────────────────
const fullMask = (w) => (w >= 32 ? 0xFFFFFFFF : (1 << w) - 1) >>> 0;
const bitAt = (v, w, x) => (v >>> (w - 1 - x)) & 1;
function withBit(v, w, x, on) {
  const m = (1 << (w - 1 - x)) >>> 0;
  return (on ? (v | m) : (v & ~m)) >>> 0;
}
export const hexDigits = (w) => 2 * Math.ceil(w / 8);
const toHex = (v, w) => (v >>> 0).toString(16).toUpperCase().padStart(hexDigits(w), '0');
function parseHex(v, w, what) {
  let n;
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0) n = v;
  else if (typeof v === 'string' && /^[0-9a-fA-F]{1,8}$/.test(v.trim())) n = parseInt(v.trim(), 16);
  else throw new Error(`${what} must be a hex string or a whole number, got ${JSON.stringify(v)}`);
  return (n & fullMask(w)) >>> 0;
}

const inb = (s, x, y) => x >= 0 && x < s.w && y >= 0 && y < s.h;
const frameOf = (s, f) => {
  const fr = s.frames[f];
  if (!fr) throw new RangeError(`no frame ${f}`);
  return fr;
};

// ── creation, cloning, conversion ─────────────────────────────────────────────────────────────────────────────
function blankRow(colours) {
  return { bits: 0, mask: 0, ink: colours.ink, paper: colours.paper, bright: colours.bright };
}
function blankFrame(s, colours) {
  return { rows: Array.from({ length: s.h }, (_, y) => blankRow(colours[y] ?? colours[colours.length - 1] ?? DEFAULT_ROW)) };
}

/** A new sprite of w x h, one empty (fully transparent) frame, every row in the given colours. */
export function newSprite(w = 16, h = 16, { ink = DEFAULT_ROW.ink, paper = DEFAULT_ROW.paper, bright = DEFAULT_ROW.bright, phases = DEFAULT_PHASES } = {}) {
  if (!WIDTHS.includes(w)) throw new RangeError(`width must be one of ${WIDTHS.join(', ')}`);
  if (!Number.isInteger(h) || h < 1 || h > MAX_H) throw new RangeError(`height must be 1..${MAX_H}`);
  const s = { w, h, phases, hot: null, frames: [] };
  s.frames.push(blankFrame(s, [{ ink, paper, bright }]));
  return s;
}

export function cloneSprite(s) {
  return { w: s.w, h: s.h, phases: s.phases, hot: s.hot ? [...s.hot] : null, frames: s.frames.map((fr) => ({ rows: fr.rows.map((r) => ({ ...r })) })) };
}

/** The stored asset -> the editing form. Throws an Error with a plain message when the asset cannot be read. */
export function fromAsset(asset) {
  if (!asset || typeof asset !== 'object') throw new Error('the sprite is not an object');
  const frames = Array.isArray(asset.frames) ? asset.frames : Array.isArray(asset.rows) ? [{ rows: asset.rows }] : null;
  if (!frames || frames.length === 0) throw new Error('the sprite has no frames');
  const first = frames[0]?.rows;
  const w = asset.w ?? 16, h = asset.h ?? (Array.isArray(first) ? first.length : undefined);
  if (!Number.isInteger(w) || w < 1 || w > 32) throw new Error(`width ${JSON.stringify(w)} must be a whole number 1..32`);
  if (!Number.isInteger(h) || h < 1 || h > MAX_H) throw new Error(`height ${JSON.stringify(h)} must be a whole number 1..${MAX_H}`);
  const bit01 = (v, what, dflt) => {
    if (v === undefined || v === null) return dflt;
    const n = v === true ? 1 : v === false ? 0 : v;
    if (n !== 0 && n !== 1) throw new Error(`${what} must be 0 or 1`);
    return n;
  };
  const col = (v, what, dflt) => {
    if (v === undefined || v === null) return dflt;
    if (!Number.isInteger(v) || v < 0 || v > 7) throw new Error(`${what} must be a colour 0..7, got ${JSON.stringify(v)}`);
    return v;
  };
  const s = { w, h, phases: asset.phases ?? DEFAULT_PHASES, hot: Array.isArray(asset.hot) ? [...asset.hot] : null, frames: [] };
  frames.forEach((fr, i) => {
    const rows = fr?.rows;
    if (!Array.isArray(rows)) throw new Error(`frame ${i} has no rows`);
    if (rows.length !== h) throw new Error(`frame ${i} has ${rows.length} rows but the sprite is ${h} high`);
    s.frames.push({
      rows: rows.map((r, y) => ({
        bits: parseHex(r?.bits, w, `frame ${i} row ${y} bits`),
        mask: r?.mask === undefined || r?.mask === null ? fullMask(w) : parseHex(r.mask, w, `frame ${i} row ${y} mask`),
        ink: col(r?.ink, `frame ${i} row ${y} ink`, DEFAULT_ROW.ink),
        paper: col(r?.paper, `frame ${i} row ${y} paper`, DEFAULT_ROW.paper),
        bright: bit01(r?.bright, `frame ${i} row ${y} bright`, DEFAULT_ROW.bright),
      })),
    });
  });
  return s;
}

/** The editing form -> the stored asset (the compiler's format: bits / mask as hex of ceil(w / 8) bytes). */
export function toAsset(s) {
  const out = {
    w: s.w, h: s.h, phases: s.phases,
    frames: s.frames.map((fr) => ({ rows: fr.rows.map((r) => ({ bits: toHex(r.bits, s.w), mask: toHex(r.mask, s.w), ink: r.ink, paper: r.paper, bright: r.bright })) })),
  };
  if (s.hot) out.hot = [...s.hot];
  return out;
}

// ── frames ────────────────────────────────────────────────────────────────────────────────────────────────────
const cloneFrame = (fr) => ({ rows: fr.rows.map((r) => ({ ...r })) });

/** Add an empty frame after frame `after` (default: the last), with the row colours of that frame. Returns its index. */
export function addFrame(s, after = s.frames.length - 1) {
  if (s.frames.length >= MAX_FRAMES) throw new RangeError(`at most ${MAX_FRAMES} frames`);
  const src = frameOf(s, Math.max(0, Math.min(after, s.frames.length - 1)));
  const fr = { rows: src.rows.map((r) => ({ bits: 0, mask: 0, ink: r.ink, paper: r.paper, bright: r.bright })) };
  s.frames.splice(after + 1, 0, fr);
  return after + 1;
}
export function duplicateFrame(s, f) {
  if (s.frames.length >= MAX_FRAMES) throw new RangeError(`at most ${MAX_FRAMES} frames`);
  s.frames.splice(f + 1, 0, cloneFrame(frameOf(s, f)));
  return f + 1;
}
/** Delete frame f; the last remaining frame cannot be deleted (returns false). */
export function deleteFrame(s, f) {
  frameOf(s, f);
  if (s.frames.length <= 1) return false;
  s.frames.splice(f, 1);
  return true;
}
export function moveFrame(s, from, to) {
  frameOf(s, from);
  if (!(to >= 0 && to < s.frames.length)) return false;
  const [fr] = s.frames.splice(from, 1);
  s.frames.splice(to, 0, fr);
  return true;
}

/** Change the size (a new width / height); pixels outside the new box are dropped, new ones are transparent paper, new rows copy the last row's colours. */
export function resizeSprite(s, w, h) {
  if (!WIDTHS.includes(w)) throw new RangeError(`width must be one of ${WIDTHS.join(', ')}`);
  if (!Number.isInteger(h) || h < 1 || h > MAX_H) throw new RangeError(`height must be 1..${MAX_H}`);
  const keep = (v, ow) => {
    // top-left anchored: take the leftmost min(ow, w) pixels
    let out = 0;
    for (let x = 0; x < Math.min(ow, w); x++) if (bitAt(v, ow, x)) out = withBit(out, w, x, 1);
    return out;
  };
  const ow = s.w;
  for (const fr of s.frames) {
    const rows = fr.rows.slice(0, h).map((r) => ({ ...r, bits: keep(r.bits, ow), mask: keep(r.mask, ow) }));
    while (rows.length < h) {
      const last = rows[rows.length - 1] ?? DEFAULT_ROW;
      rows.push({ bits: 0, mask: 0, ink: last.ink, paper: last.paper, bright: last.bright });
    }
    fr.rows = rows;
  }
  s.w = w; s.h = h;
  if (s.hot && !(s.hot[0] + s.hot[2] <= w && s.hot[1] + s.hot[3] <= h)) s.hot = null;
  return s;
}

// ── pixels ────────────────────────────────────────────────────────────────────────────────────────────────────
/** Layer 'image' (bits: 1 = ink) or 'mask' (1 = covered). Out of range reads 0. */
export function getPixel(s, f, x, y, layer = 'image') {
  if (!inb(s, x, y)) return 0;
  const r = frameOf(s, f).rows[y];
  return bitAt(layer === 'mask' ? r.mask : r.bits, s.w, x);
}
/** Set one pixel of a layer; returns true when it changed. */
export function setPixel(s, f, x, y, layer, v) {
  if (!inb(s, x, y)) return false;
  const r = frameOf(s, f).rows[y], key = layer === 'mask' ? 'mask' : 'bits';
  const nv = withBit(r[key], s.w, x, v ? 1 : 0);
  if (nv === r[key]) return false;
  r[key] = nv;
  return true;
}
/** Make a pixel transparent (mask 0). The bit under it is kept, so toggling the mask back restores the colour. */
export function erasePixel(s, f, x, y) { return setPixel(s, f, x, y, 'mask', 0); }

/** The colour key shown at a pixel, or -1 when transparent. */
export function pixelKey(s, f, x, y) {
  const r = frameOf(s, f).rows[y];
  if (!bitAt(r.mask, s.w, x)) return -1;
  return colourKey(bitAt(r.bits, s.w, x) ? r.ink : r.paper, r.bright);
}

// ── row colours ───────────────────────────────────────────────────────────────────────────────────────────────
export function getRowColours(s, f, y) {
  const r = frameOf(s, f).rows[y];
  return { ink: r.ink, paper: r.paper, bright: r.bright };
}
/** Set (a part of) a row's colours: patch = {ink?, paper?, bright?}. The row's pixels change with it. Returns true when valid. */
export function setRowColours(s, f, y, patch) {
  const r = frameOf(s, f).rows[y];
  if (!r) return false;
  const next = { ink: r.ink, paper: r.paper, bright: r.bright, ...patch };
  if (![next.ink, next.paper].every((c) => Number.isInteger(c) && c >= 0 && c <= 7)) return false;
  if (next.bright !== 0 && next.bright !== 1) return false;
  r.ink = next.ink; r.paper = next.paper; r.bright = next.bright;
  return true;
}
/** The same colours for every row of the frame (or of every frame when allFrames). */
export function setAllRowColours(s, f, patch, { allFrames = false } = {}) {
  const frames = allFrames ? s.frames.keys() : [f];
  for (const i of frames) for (let y = 0; y < s.h; y++) setRowColours(s, i, y, patch);
}
/** Give frame `to` (or every other frame) the row colours of frame `from` (pixels untouched). */
export function copyRowColours(s, from, to = 'all') {
  const src = frameOf(s, from).rows;
  const targets = to === 'all' ? [...s.frames.keys()].filter((i) => i !== from) : [to];
  for (const i of targets) frameOf(s, i).rows.forEach((r, y) => { r.ink = src[y].ink; r.paper = src[y].paper; r.bright = src[y].bright; });
}
export function swapRowColours(s, f, y) {
  const r = frameOf(s, f).rows[y];
  [r.ink, r.paper] = [r.paper, r.ink];
  r.bits = (~r.bits & fullMask(s.w)) >>> 0;       // the pixels keep their colour: only the roles swap
}

/**
 * Write a colour into a pixel (the pixel becomes covered). The colour must be one of the row's two: if it is neither, the row's
 * ink or paper is re-coloured (as: 'ink' | 'paper' | 'auto' = the colour used by fewer covered pixels of the row, ink on a tie),
 * which changes every pixel of the row with that role. A bright colour sets the row's bright flag for both its colours.
 * Returns {changed, recoloured: 'ink' | 'paper' | null}.
 */
export function paintColour(s, f, x, y, key, { as = 'auto' } = {}) {
  if (!inb(s, x, y)) return { changed: false, recoloured: null };
  const r = frameOf(s, f).rows[y];
  const before = r.bits ^ r.mask ^ r.ink ^ (r.paper << 8) ^ (r.bright << 16);
  key = normKey(key);
  r.mask = withBit(r.mask, s.w, x, 1);
  const ik = colourKey(r.ink, r.bright), pk = colourKey(r.paper, r.bright);
  let recoloured = null;
  if (key === ik) r.bits = withBit(r.bits, s.w, x, 1);
  else if (key === pk) r.bits = withBit(r.bits, s.w, x, 0);
  else {
    const { ink: c, bright } = keyParts(key);
    let role = as;
    if (role === 'auto') {
      let n1 = 0, n0 = 0;
      for (let i = 0; i < s.w; i++) if (i !== x && bitAt(r.mask, s.w, i)) (bitAt(r.bits, s.w, i) ? n1++ : n0++);
      role = n0 < n1 ? 'paper' : 'ink';
    }
    const nb = key === 0 ? r.bright : bright;
    if (role === 'paper') { r.paper = c; r.bits = withBit(r.bits, s.w, x, 0); } else { r.ink = c; r.bits = withBit(r.bits, s.w, x, 1); }
    r.bright = nb;
    recoloured = role;
  }
  const after = r.bits ^ r.mask ^ r.ink ^ (r.paper << 8) ^ (r.bright << 16);
  return { changed: after !== before || recoloured !== null, recoloured };
}
/** Draw with the row's own ink (v = 1) or paper (v = 0), leaving the row colours alone; the pixel becomes covered. */
export function paintRole(s, f, x, y, role) {
  if (!inb(s, x, y)) return false;
  const r = frameOf(s, f).rows[y];
  const nm = withBit(r.mask, s.w, x, 1), nb = withBit(r.bits, s.w, x, role === 'ink' ? 1 : 0);
  const changed = nm !== r.mask || nb !== r.bits;
  r.mask = nm; r.bits = nb;
  return changed;
}

/** Rows' colour summary for a frame: for each row the ink / paper keys, how many covered pixels use each, and the row's key set. */
export function rowReport(s, f) {
  return frameOf(s, f).rows.map((r, y) => {
    let ink = 0, paper = 0;
    for (let x = 0; x < s.w; x++) if (bitAt(r.mask, s.w, x)) (bitAt(r.bits, s.w, x) ? ink++ : paper++);
    return { y, ink: r.ink, paper: r.paper, bright: r.bright, inkKey: colourKey(r.ink, r.bright), paperKey: colourKey(r.paper, r.bright), inkPixels: ink, paperPixels: paper, covered: ink + paper };
  });
}
/** Rows breaking the two-colours-per-row rule. The model stores one ink, one paper and one bright per row, so this is empty for any
 *  sprite that passes validateSprite(); it exists so a caller (and the tests) can state the rule and check data from outside. */
export function twoColourViolations(s) {
  const bad = [];
  s.frames.forEach((fr, f) => fr.rows.forEach((r, y) => {
    const ok = Number.isInteger(r.ink) && r.ink >= 0 && r.ink <= 7 && Number.isInteger(r.paper) && r.paper >= 0 && r.paper <= 7 && (r.bright === 0 || r.bright === 1);
    if (!ok) bad.push({ frame: f, row: y });
  }));
  return bad;
}

// ── drawing helpers ───────────────────────────────────────────────────────────────────────────────────────────
/** Pixels of the line (x0,y0)-(x1,y1), both ends included (Bresenham). */
export function line(x0, y0, x1, y1) {
  const pts = [];
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (;;) {
    pts.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
  return pts;
}

/**
 * Flood fill (4-connected) of the pixels that equal the one at (x, y) on a layer. For 'mask' the value is set to `value` (0 / 1).
 * For 'image' the fill is of the pixels with the same colour KEY (transparent counts as its own region), painted with
 * `value` = a colour key (through paintColour; rows may be re-coloured) or 'ink' / 'paper' (paintRole). Returns the pixel count.
 */
export function fill(s, f, x, y, layer, value, opts = {}) {
  if (!inb(s, x, y)) return 0;
  const same = layer === 'mask' ? (a, b) => getPixel(s, f, a, b, 'mask') === getPixel(s, f, x, y, 'mask') : (() => {
    const k = pixelKey(s, f, x, y);
    return (a, b) => pixelKey(s, f, a, b) === k;
  })();
  const seen = new Uint8Array(s.w * s.h), stack = [[x, y]], region = [];
  while (stack.length) {
    const [px, py] = stack.pop();
    if (!inb(s, px, py) || seen[py * s.w + px] || !same(px, py)) continue;
    seen[py * s.w + px] = 1;
    region.push([px, py]);
    stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
  }
  for (const [px, py] of region) {
    if (layer === 'mask') setPixel(s, f, px, py, 'mask', value);
    else if (value === 'ink' || value === 'paper') paintRole(s, f, px, py, value);
    else paintColour(s, f, px, py, value, opts);
  }
  return region.length;
}

// ── whole-frame operations ────────────────────────────────────────────────────────────────────────────────────
const reverseBits = (v, w) => {
  let out = 0;
  for (let x = 0; x < w; x++) if (bitAt(v, w, x)) out = withBit(out, w, w - 1 - x, 1);
  return out;
};
/** Mirror left-right (row colours stay with their rows). */
export function flipH(s, f) {
  for (const r of frameOf(s, f).rows) { r.bits = reverseBits(r.bits, s.w); r.mask = reverseBits(r.mask, s.w); }
}
/** Mirror top-bottom: whole rows, with their colours, change places. */
export function flipV(s, f) { frameOf(s, f).rows.reverse(); }
/** Rotate 180 degrees. */
export function rotate180(s, f) { flipH(s, f); flipV(s, f); }
/** Rotate a square sprite by 90 degrees (clockwise when cw). The row colours stay with their row numbers. Returns false when w != h. */
export function rotate90(s, f, cw = true) {
  if (s.w !== s.h) return false;
  const fr = frameOf(s, f), n = s.w;
  const old = fr.rows.map((r) => ({ ...r }));
  for (let y = 0; y < n; y++) {
    let bits = 0, mask = 0;
    for (let x = 0; x < n; x++) {
      const [sx, sy] = cw ? [y, n - 1 - x] : [n - 1 - y, x];          // the source pixel that lands on (x, y)
      if (bitAt(old[sy].bits, n, sx)) bits = withBit(bits, n, x, 1);
      if (bitAt(old[sy].mask, n, sx)) mask = withBit(mask, n, x, 1);
    }
    fr.rows[y].bits = bits; fr.rows[y].mask = mask;
  }
  return true;
}
/** Move the picture by dx, dy pixels (right / down positive). Rows move with their colours; rows that come in are empty (or wrap). */
export function shift(s, f, dx, dy, { wrap = false } = {}) {
  const fr = frameOf(s, f), w = s.w, h = s.h;
  if (dx) {
    for (const r of fr.rows) {
      let bits = 0, mask = 0;
      for (let x = 0; x < w; x++) {
        let sx = x - dx;
        if (wrap) sx = ((sx % w) + w) % w; else if (sx < 0 || sx >= w) continue;
        if (bitAt(r.bits, w, sx)) bits = withBit(bits, w, x, 1);
        if (bitAt(r.mask, w, sx)) mask = withBit(mask, w, x, 1);
      }
      r.bits = bits; r.mask = mask;
    }
  }
  if (dy) {
    const old = fr.rows.map((r) => ({ ...r }));
    fr.rows = fr.rows.map((r, y) => {
      let sy = y - dy;
      if (wrap) return { ...old[((sy % h) + h) % h] };
      if (sy >= 0 && sy < h) return { ...old[sy] };
      const edge = old[Math.max(0, Math.min(h - 1, sy))];
      return { bits: 0, mask: 0, ink: edge.ink, paper: edge.paper, bright: edge.bright };
    });
  }
}
/** Clear a layer: 'image' sets every pixel to paper, 'mask' makes everything transparent, 'both' (default) does both. */
export function clearFrame(s, f, layer = 'both') {
  for (const r of frameOf(s, f).rows) {
    if (layer !== 'mask') r.bits = 0;
    if (layer !== 'image') r.mask = 0;
  }
}
/** Invert a layer: 'image' swaps ink and paper pixels, 'mask' swaps covered and transparent. */
export function invertFrame(s, f, layer = 'image') {
  const full = fullMask(s.w);
  for (const r of frameOf(s, f).rows) {
    if (layer === 'image') r.bits = (~r.bits & full) >>> 0;
    else r.mask = (~r.mask & full) >>> 0;
  }
}

// ── mask helpers ──────────────────────────────────────────────────────────────────────────────────────────────
/**
 * Build the mask of a frame from its image:
 *   'ink'        covered where the pixel is ink (bit 1); paper pixels become transparent
 *   'silhouette' covered everywhere except the paper pixels connected to the border by paper (holes inside stay covered)
 *   'nonblack'   covered where the shown colour is not black
 *   'all'        covered everywhere
 */
export function autoMask(s, f, mode = 'silhouette') {
  const fr = frameOf(s, f), w = s.w, h = s.h;
  const cover = Array.from({ length: h }, () => new Uint8Array(w));
  if (mode === 'all') cover.forEach((r) => r.fill(1));
  else if (mode === 'ink') fr.rows.forEach((r, y) => { for (let x = 0; x < w; x++) cover[y][x] = bitAt(r.bits, w, x); });
  else if (mode === 'nonblack') fr.rows.forEach((r, y) => { for (let x = 0; x < w; x++) cover[y][x] = colourKey(bitAt(r.bits, w, x) ? r.ink : r.paper, r.bright) !== 0 ? 1 : 0; });
  else if (mode === 'silhouette') {
    cover.forEach((r) => r.fill(1));
    const stack = [];
    const paper = (x, y) => !bitAt(fr.rows[y].bits, w, x);
    for (let x = 0; x < w; x++) stack.push([x, 0], [x, h - 1]);
    for (let y = 0; y < h; y++) stack.push([0, y], [w - 1, y]);
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= w || y >= h || !cover[y][x] || !paper(x, y)) continue;
      cover[y][x] = 0;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
  } else throw new RangeError(`unknown mask mode ${mode}`);
  fr.rows.forEach((r, y) => { let m = 0; for (let x = 0; x < w; x++) if (cover[y][x]) m = withBit(m, w, x, 1); r.mask = m; });
}
/**
 * Grow the mask by one pixel all round (8 neighbours with diagonals, else 4). The new pixels are paper (or ink: as 'ink'): an outline
 * in the row's colour. Returns how many pixels were added.
 */
export function outline(s, f, { diagonals = true, as = 'paper' } = {}) {
  const fr = frameOf(s, f), w = s.w, h = s.h;
  const covered = (x, y) => x >= 0 && y >= 0 && x < w && y < h && bitAt(fr.rows[y].mask, w, x) === 1;
  const add = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (covered(x, y)) continue;
    let near = covered(x + 1, y) || covered(x - 1, y) || covered(x, y + 1) || covered(x, y - 1);
    if (!near && diagonals) near = covered(x + 1, y + 1) || covered(x - 1, y + 1) || covered(x + 1, y - 1) || covered(x - 1, y - 1);
    if (near) add.push([x, y]);
  }
  for (const [x, y] of add) { setPixel(s, f, x, y, 'mask', 1); setPixel(s, f, x, y, 'image', as === 'ink' ? 1 : 0); }
  return add.length;
}

// ── what the picture looks like ───────────────────────────────────────────────────────────────────────────────
/** One colour key per pixel (row-major, w * h), -1 where transparent. */
export function framePixels(s, f) {
  const out = new Int8Array(s.w * s.h);
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) out[y * s.w + x] = pixelKey(s, f, x, y);
  return out;
}

/** Ghost frames for onion skinning: [{frame, offset, pixels}] from the farthest to the nearest, frames before (offset < 0) and after. */
export function onionSkin(s, f, { before = 1, after = 0 } = {}) {
  const out = [];
  for (let d = before; d >= 1; d--) if (f - d >= 0) out.push({ frame: f - d, offset: -d, pixels: framePixels(s, f - d) });
  for (let d = after; d >= 1; d--) if (f + d < s.frames.length) out.push({ frame: f + d, offset: d, pixels: framePixels(s, f + d) });
  return out;
}

const d2 = (a, b) => 2 * (a[0] - b[0]) ** 2 + 4 * (a[1] - b[1]) ** 2 + 3 * (a[2] - b[2]) ** 2;
const luma = (rgb) => 0.3 * rgb[0] + 0.59 * rgb[1] + 0.11 * rgb[2];

/**
 * The frame as one display family shows it (docs/ARCADE_ASSETS.md, "Colour model"):
 *   ecm    as authored (8x1 colour)
 *   flip   each 8x8 cell (aligned to the sprite's top-left corner) keeps two colours of ONE brightness: the two most used hues
 *   hires  one ink / paper pair for the whole screen: the picture is reduced to 1 bit by luminance
 * Returns {pixels, lostPixels, lostCells, colours, warning} (pixels as framePixels; warning is null when nothing is lost).
 */
export function familyPixels(s, f, family = 'ecm', { hiresInk = 7, hiresPaper = 0 } = {}) {
  const src = framePixels(s, f), w = s.w, h = s.h;
  const covered = src.reduce((n, k) => n + (k >= 0 ? 1 : 0), 0);
  const colours = new Set([...src].filter((k) => k >= 0));
  if (family === 'ecm') return { pixels: src, lostPixels: 0, lostCells: 0, colours: colours.size, warning: null };
  const out = Int8Array.from(src);
  if (family === 'flip') {
    let lostPixels = 0, lostCells = 0;
    for (let cy = 0; cy < h; cy += 8) for (let cx = 0; cx < w; cx += 8) {
      const cell = [];
      for (let y = cy; y < Math.min(h, cy + 8); y++) for (let x = cx; x < Math.min(w, cx + 8); x++) if (src[y * w + x] >= 0) cell.push(y * w + x);
      if (!cell.length) continue;
      const byHue = new Map(), byKey = new Map();
      for (const i of cell) {
        const k = src[i];
        byHue.set(k & 7, (byHue.get(k & 7) ?? 0) + 1);
        byKey.set(k, (byKey.get(k) ?? 0) + 1);
      }
      const hues = [...byHue.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0]).slice(0, 2).map((e) => e[0]);
      // the cell's brightness: that of the most used coloured key among the kept hues (black has none)
      const withBright = [...byKey.entries()].filter(([k]) => k !== 0 && hues.includes(k & 7)).sort((a, b) => b[1] - a[1] || a[0] - b[0]);
      const bright = withBright.length ? withBright[0][0] >> 3 : 0;
      const pair = hues.map((c) => colourKey(c, bright));
      let lost = 0;
      for (const i of cell) {
        const rgb = RGB15(src[i]);
        let best = pair[0], bd = d2(rgb, RGB15(pair[0]));
        if (pair[1] !== undefined) { const dd = d2(rgb, RGB15(pair[1])); if (dd < bd) { best = pair[1]; bd = dd; } }
        out[i] = best;
        if (best !== src[i]) lost++;
      }
      if (lost) { lostPixels += lost; lostCells++; }
    }
    return {
      pixels: out, lostPixels, lostCells, colours: colours.size,
      warning: lostPixels ? `flip (8x8 colour): ${lostPixels} of ${covered} pixels in ${lostCells} cell${lostCells === 1 ? '' : 's'} change colour: each 8x8 cell keeps two colours of one brightness.` : null,
    };
  }
  if (family === 'hires') {
    const used = [...src].filter((k) => k >= 0);
    const lums = used.map((k) => luma(RGB15(k)));
    const lo = Math.min(...lums, 255), hi = Math.max(...lums, 0), mid = (lo + hi) / 2;
    const counts = new Map();
    for (const k of used) counts.set(k, (counts.get(k) ?? 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map((e) => e[0]);
    let lostPixels = 0;
    for (let i = 0; i < src.length; i++) {
      if (src[i] < 0) continue;
      const l = luma(RGB15(src[i]));
      const lit = hi > lo ? l >= mid : src[i] !== 0;
      out[i] = lit ? colourKey(hiresInk, 0) : colourKey(hiresPaper, 0);
      if (!top.includes(src[i])) lostPixels++;
    }
    const extra = Math.max(0, colours.size - 2);
    return {
      pixels: out, lostPixels, lostCells: 0, colours: colours.size,
      warning: extra ? `hires (1 bit): the ${colours.size} colours of this frame become two (ink and paper by brightness); ${lostPixels} of ${covered} pixels are in the colours beyond the two most used.` : null,
    };
  }
  throw new RangeError(`unknown display family ${family}`);
}

// ── validation and cost ───────────────────────────────────────────────────────────────────────────────────────
/**
 * Check a sprite against the stored format and the build. errors: the compiler would reject it or the data is malformed.
 * warnings: valid data that the build does not support yet (COMPILER_SUPPORT) or will lose.
 */
export function validateSprite(s, support = COMPILER_SUPPORT) {
  const errors = [], warnings = [];
  if (!Number.isInteger(s.w) || s.w < 1 || s.w > 32) errors.push(`width ${s.w} must be 1..32`);
  else if (!WIDTHS.includes(s.w)) warnings.push(`width ${s.w} is not one of ${WIDTHS.join(', ')}`);
  if (!Number.isInteger(s.h) || s.h < 1 || s.h > MAX_H) errors.push(`height ${s.h} must be 1..${MAX_H}`);
  if (!PHASE_CHOICES.includes(s.phases)) errors.push(`phases ${JSON.stringify(s.phases)} must be 1, 2, 4 or 8`);
  if (s.frames.length < 1) errors.push('the sprite has no frames');
  if (s.frames.length > MAX_FRAMES) errors.push(`${s.frames.length} frames; at most ${MAX_FRAMES}`);
  s.frames.forEach((fr, i) => { if (fr.rows.length !== s.h) errors.push(`frame ${i} has ${fr.rows.length} rows, not ${s.h}`); });
  if (twoColourViolations(s).length) errors.push('a row has an ink, paper or bright value out of range');
  if (s.hot) {
    const [x, y, w, h] = s.hot;
    const ok = s.hot.length === 4 && s.hot.every(Number.isInteger) && x >= 0 && y >= 0 && w >= 1 && h >= 1 && x + w <= s.w && y + h <= s.h;
    if (!ok) errors.push(`the hot box [${s.hot.join(', ')}] must lie inside the ${s.w} x ${s.h} sprite`);
    else if (x + w > support.maxW) warnings.push(`the hot box reaches column ${x + w}; the build allows ${support.maxW}`);
  }
  if (s.w > support.maxW) warnings.push(`width ${s.w}: the build supports up to ${support.maxW} pixels today, so this sprite will not compile yet`);
  if (s.h > support.maxH) warnings.push(`height ${s.h}: the build supports up to ${support.maxH} rows today, so this sprite will not compile yet`);
  if (s.frames.length > support.compiledFrames) warnings.push(`${s.frames.length} frames: only frame 0 is compiled today (SHOW ... FRAME is not supported yet)`);
  if (!support.colours) warnings.push('ink / paper / bright are for the Studio: the runtime colours a sprite from the screen cell under it');
  return { ok: errors.length === 0, errors, warnings };
}

/** Validate a STORED asset (hex form): {ok, errors, warnings}; unreadable data is an error. */
export function validateAsset(asset, support = COMPILER_SUPPORT) {
  try { return validateSprite(fromAsset(asset), support); } catch (e) { return { ok: false, errors: [e.message], warnings: [] }; }
}

/**
 * The byte cost of a sprite. `cartridge`: the data the build writes today (frame 0, rowBytes per row); `cartridgeAll`: all frames;
 * `ram`: the pre-shifted copies the runtime builds at boot: one per phase, each `rows x 2 x (wb + 1)` bytes (an aligned copy without
 * the extra byte), wb = descriptor width / 8. `phaseShifts` lists the pixel shifts that get a copy.
 */
export function sizeInfo(s, support = COMPILER_SUPPORT) {
  const wb = support.descriptorWidth / 8;
  const phases = PHASE_CHOICES.includes(s.phases) ? s.phases : DEFAULT_PHASES;
  const step = 8 / phases, phaseShifts = [];
  for (let k = 0; k < 8; k += step) phaseShifts.push(k);
  const copy = (shift) => s.h * 2 * (wb + (shift ? 1 : 0));
  const ram = phaseShifts.reduce((n, k) => n + copy(k), 0);
  const cartridge = s.h * support.rowBytes;
  return { cartridge, cartridgeAll: cartridge * s.frames.length, ram, phases, phaseShifts, rows: s.h, rowBytes: support.rowBytes, wb };
}

// ── image import ──────────────────────────────────────────────────────────────────────────────────────────────
/** Suggest a target size for an image: the allowed width nearest to the cell width, the height keeping the aspect (1..48). */
export function suggestSize(imgW, imgH, { cols = 1, rows = 1 } = {}) {
  const cw = imgW / cols, ch = imgH / rows;
  const w = WIDTHS.reduce((best, c) => (Math.abs(c - cw) < Math.abs(best - cw) ? c : best), WIDTHS[0]);
  return { w, h: Math.max(1, Math.min(MAX_H, Math.round(ch * w / cw))) };
}

/** Box-resample an RGBA region (x0, y0, rw, rh) of img to w x h: {r, g, b, a} Float32Arrays, colour weighted by alpha. */
function resample(img, x0, y0, rw, rh, w, h) {
  const n = w * h, r = new Float32Array(n), g = new Float32Array(n), b = new Float32Array(n), a = new Float32Array(n);
  const sx = rw / w, sy = rh / h;
  for (let ty = 0; ty < h; ty++) for (let tx = 0; tx < w; tx++) {
    const ax = tx * sx, bx = (tx + 1) * sx, ay = ty * sy, by = (ty + 1) * sy;
    let wr = 0, wg = 0, wb = 0, wa = 0, area = 0;
    for (let yy = Math.floor(ay); yy < Math.ceil(by); yy++) for (let xx = Math.floor(ax); xx < Math.ceil(bx); xx++) {
      const cov = (Math.min(bx, xx + 1) - Math.max(ax, xx)) * (Math.min(by, yy + 1) - Math.max(ay, yy));
      if (cov <= 0) continue;
      const px = Math.min(img.width - 1, x0 + xx), py = Math.min(img.height - 1, y0 + yy), p = (py * img.width + px) * 4;
      const al = img.data[p + 3] / 255;
      wr += img.data[p] * al * cov; wg += img.data[p + 1] * al * cov; wb += img.data[p + 2] * al * cov; wa += al * cov; area += cov;
    }
    const i = ty * w + tx;
    a[i] = area ? (wa / area) * 255 : 0;
    if (wa > 0) { r[i] = wr / wa; g[i] = wg / wa; b[i] = wb / wa; }
  }
  return { r, g, b, a };
}

const BAYER4 = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

const W3 = [2, 4, 3];
/** Squared (weighted) distance from p to the segment a-b: the error left when p is dithered between the two colours. */
function segDist(p, a, b) {
  let dot = 0, len = 0;
  for (let i = 0; i < 3; i++) { dot += W3[i] * (p[i] - a[i]) * (b[i] - a[i]); len += W3[i] * (b[i] - a[i]) ** 2; }
  const t = len > 0 ? Math.max(0, Math.min(1, dot / len)) : 0;
  let d = 0;
  for (let i = 0; i < 3; i++) d += W3[i] * (p[i] - a[i] - t * (b[i] - a[i])) ** 2;
  return d + 1e-6 * len;                       // among equal fits prefer the closer pair
}
/** The least-error pair of one brightness: mode 'nearest' (each pixel becomes the nearer colour) or 'segment' (pixels are dithered between them). */
function bestPair(pixels, bright, mode = 'nearest') {
  const cand = Array.from({ length: 8 }, (_, c) => RGB15(colourKey(c, bright)));
  let best = null;
  for (let i = 0; i < 8; i++) for (let j = i; j < 8; j++) {
    let cost = 0;
    for (const p of pixels) cost += mode === 'segment' ? segDist(p, cand[i], cand[j]) : Math.min(d2(p, cand[i]), d2(p, cand[j]));
    if (!best || cost < best.cost - 1e-9) best = { cost, a: i, b: j };
  }
  return best;
}
/** Which of the pair is the ink: the colour more pixels are nearest to; a single colour gets black (white if it is black) as its partner. */
function assignRoles(pixels, pair, bright) {
  if (pair.a === pair.b) return { ink: pair.a, paper: pair.a === 0 ? 7 : 0 };
  const ra = RGB15(colourKey(pair.a, bright)), rb = RGB15(colourKey(pair.b, bright));
  let na = 0, nb = 0;
  for (const p of pixels) (d2(p, ra) <= d2(p, rb) ? na++ : nb++);
  return nb > na ? { ink: pair.b, paper: pair.a } : { ink: pair.a, paper: pair.b };
}
/**
 * The best (ink, paper, bright) for a row of pixels ([r, g, b] of the covered ones): the pair of one brightness with the least colour
 * error (a tie goes to preferBright, then to the lower colour numbers). `lock` (0 / 1) restricts the search to one brightness. `mode`
 * 'segment' measures the error to the line between the two colours, which is what dithering can reach; 'nearest' (no dither) to the nearer one.
 */
export function fitRow(pixels, preferBright = 1, lock = null, mode = 'nearest') {
  if (!pixels.length) return null;
  let best = null;
  for (const bright of lock !== null ? [lock] : preferBright ? [1, 0] : [0, 1]) {
    const p = bestPair(pixels, bright, mode);
    if (!best || p.cost < best.cost - 1e-9) best = { ...p, bright };
  }
  return { ...assignRoles(pixels, best, best.bright), bright: best.bright, cost: best.cost };
}

/**
 * Convert an RGBA image (or a region of it) to one frame of rows. opts: {w, h, dither: 'none' | 'ordered' | 'sierra',
 * alphaThreshold (128), bright: 'auto' | 0 | 1, region: {x, y, w, h}}. Each row gets the best two colours of one brightness for its
 * pixels (fitRow), then each pixel is ink or paper by the dither; alpha below the threshold makes the pixel transparent.
 * Returns the sprite with one frame.
 */
export function importRGBA(img, opts = {}) {
  if (!img || !img.data || !(img.width > 0) || !(img.height > 0) || img.data.length < img.width * img.height * 4) throw new Error('the image is empty or damaged');
  const reg = opts.region ?? { x: 0, y: 0, w: img.width, h: img.height };
  const sug = suggestSize(reg.w, reg.h);
  const w = opts.w ?? sug.w, h = opts.h ?? (opts.w ? Math.max(1, Math.min(MAX_H, Math.round(reg.h * w / reg.w))) : sug.h);
  const dither = opts.dither === 'sierra-lite' ? 'sierra' : (opts.dither ?? 'sierra');
  const thr = opts.alphaThreshold ?? 128;
  const lock = opts.bright === 0 || opts.bright === 1 ? opts.bright : null;
  const s = newSprite(w, h);
  const px = resample(img, reg.x, reg.y, reg.w, reg.h, w, h);
  const rows = s.frames[0].rows;
  const err = Array.from({ length: h + 1 }, () => new Float32Array((w + 2) * 3));       // error rows, x offset by 1
  let prevBright = lock ?? 1;
  for (let y = 0; y < h; y++) {
    const idx = [];
    for (let x = 0; x < w; x++) if (px.a[y * w + x] >= thr) idx.push(x);
    const row = rows[y];
    if (!idx.length) { row.ink = DEFAULT_ROW.ink; row.paper = DEFAULT_ROW.paper; row.bright = prevBright; continue; }
    const adj = (x, i) => clamp255((i === 0 ? px.r : i === 1 ? px.g : px.b)[y * w + x] + (dither === 'sierra' ? err[y][(x + 1) * 3 + i] : 0));
    const colours = idx.map((x) => [adj(x, 0), adj(x, 1), adj(x, 2)]);
    const fit = fitRow(colours, prevBright, lock, dither === 'none' ? 'nearest' : 'segment');
    row.ink = fit.ink; row.paper = fit.paper; row.bright = fit.bright; prevBright = fit.bright;
    const inkRGB = RGB15(colourKey(fit.ink, fit.bright)), paperRGB = RGB15(colourKey(fit.paper, fit.bright));
    const axis = [inkRGB[0] - paperRGB[0], inkRGB[1] - paperRGB[1], inkRGB[2] - paperRGB[2]];
    const len2 = axis[0] ** 2 + axis[1] ** 2 + axis[2] ** 2;
    let bits = 0, mask = 0;
    for (const x of idx) {
      mask = withBit(mask, w, x, 1);
      const rgb = [adj(x, 0), adj(x, 1), adj(x, 2)];
      let ink;
      if (len2 === 0) ink = 1;
      else if (dither === 'ordered') {
        const t = Math.max(0, Math.min(1, ((rgb[0] - paperRGB[0]) * axis[0] + (rgb[1] - paperRGB[1]) * axis[1] + (rgb[2] - paperRGB[2]) * axis[2]) / len2));
        ink = t > (BAYER4[y & 3][x & 3] + 0.5) / 16 ? 1 : 0;
      } else ink = d2(rgb, inkRGB) <= d2(rgb, paperRGB) ? 1 : 0;
      if (ink) bits = withBit(bits, w, x, 1);
      if (dither === 'sierra') {
        const chosen = ink ? inkRGB : paperRGB;
        for (let i = 0; i < 3; i++) {
          const e = rgb[i] - chosen[i];
          err[y][(x + 2) * 3 + i] += e * 0.5;
          err[y + 1][x * 3 + i] += e * 0.25;
          err[y + 1][(x + 1) * 3 + i] += e * 0.25;
        }
      }
    }
    row.bits = bits; row.mask = mask;
  }
  return s;
}

/** Import a sprite sheet: cols x rows cells in reading order become frames (empty trailing cells are kept). */
export function importSheet(img, { cols = 1, rows = 1, ...opts } = {}) {
  const cw = Math.floor(img.width / cols), ch = Math.floor(img.height / rows);
  if (cw < 1 || ch < 1) throw new Error('the grid is finer than the image');
  const size = suggestSize(cw, ch);
  const w = opts.w ?? size.w, h = opts.h ?? (opts.w ? Math.max(1, Math.min(MAX_H, Math.round(ch * w / cw))) : size.h);
  if (cols * rows > MAX_FRAMES) throw new Error(`at most ${MAX_FRAMES} frames`);
  let out = null;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const one = importRGBA(img, { ...opts, w, h, region: { x: c * cw, y: r * ch, w: cw, h: ch } });
    if (!out) out = one; else out.frames.push(one.frames[0]);
  }
  return out;
}

// ── undo / redo ───────────────────────────────────────────────────────────────────────────────────────────────
const snapshot = (s) => JSON.stringify(s);
/**
 * A history of whole-sprite snapshots. commit(sprite) records the sprite when it differs from the current snapshot (returns true);
 * undo() / redo() return a fresh sprite (or null at the ends) for the caller to continue editing.
 */
export function createHistory(initial, limit = 200) {
  let stack = [snapshot(initial)], at = 0;
  return {
    commit(s) {
      const snap = snapshot(s);
      if (snap === stack[at]) return false;
      stack = stack.slice(0, at + 1);
      stack.push(snap);
      if (stack.length > limit) stack.shift(); else at++;
      return true;
    },
    undo() { if (at <= 0) return null; at--; return JSON.parse(stack[at]); },
    redo() { if (at >= stack.length - 1) return null; at++; return JSON.parse(stack[at]); },
    /** A fresh copy of the current snapshot (to roll back a failed edit). */
    get current() { return JSON.parse(stack[at]); },
    get canUndo() { return at > 0; },
    get canRedo() { return at < stack.length - 1; },
    /** Start over from `s` (after an outside change). */
    reset(s) { stack = [snapshot(s)]; at = 0; },
    get depth() { return { undo: at, redo: stack.length - 1 - at }; },
  };
}
