/**
 * src/lang/arcade/arcade-assets.js — Leap Arcade asset converters for milestone M3 (pure; no DOM, no node: imports).
 *
 *   convertTileset(asset)   -> {count, bytes, tiles}   bytes = count x (8 bitmap bytes + 1 attribute byte), the runtime v1 format
 *   convertSfx(asset)       -> {records, channels, bytes}   one channel: 4 bytes per tick + a 4-byte terminator (tone_hi byte $FF); three channels: a register delta stream (batch 5)
 *   convertMap(asset, n)    -> {w, h, cells, bytes}    bytes = the 768 CELL_TILE bytes (tile = 128 + index, blank = 32)
 *   lookupAsset(table, ...names) -> asset | undefined  exact name first, then case-insensitive
 *   assetTables(assets)     -> {sprites, tilesets, sfx, maps, music, models}   see below
 *   convertModel(asset)     -> {points, edges, bytes}   a wireframe model's game image (DB npts, DB nedges, points, edges; arcade-wire.js modelBytes), checked by modelError (docs/ARCADE_WIREFRAME_CONTRACT.md 2.1)
 *
 * Asset shapes (docs/ARCADE_ASSETS.md, as extended here where that file is silent):
 *   tileset {tiles: [{rows: [8 x {bits, ink, paper, bright}], flags}]}   bits = 8-bit number or 1..2 hex digits, MSB = left pixel;
 *           the tile's attribute byte is taken from its FIRST row: bright<<6 | paper<<3 | ink (defaults ink 0, paper 7, bright 0).
 *           At most 128 tiles (the runtime's cell value has 7 bits for the index).
 *   sfx     {ticks: [{tone 0..4095, vol 0..15, noise 0..31, mix 0..7}], ticksB?, ticksC?}   (ticksB / ticksC: channels B and C, batch 5)   record = tone_lo, tone_hi | vol << 4, noise | mix << 5, 0.
 *           A tone of 3840..4095 with volume 15 would make the second byte $FF, the terminator: it is refused.
 *           At most 255 ticks are not enforced; the table holds at most 8 effects (checked by the code generator).
 *   map     {w, h, cells}  w <= 32, h <= 24; cells = array (or hex string, 2 digits per cell) of w*h values, each a tile index
 *           0..127 or blank (-1, null, or 255 / "FF"); placed at the top-left of the 32 x 24 cell map, the other cells are font
 *           spaces. (docs/ARCADE_ASSETS.md says "hex or run-length"; run-length is not implemented.)
 * `assets` passed to compile() is {sprites, tilesets, sfx, maps, music, models} (each a name -> asset object; `music`: the songs, docs/ARCADE_MUSIC_CONTRACT.md section 3; `models`: wireframe models {points, edges}, section 2.1).
 * For compatibility with M2 a value that has none of those five keys is taken to be the sprites table itself.
 */

"use strict";

import { LIMITS } from './arcade-words.js';
import { modelError, modelBytes } from './arcade-wire.js';

export const MAX_TILES = 128;
export const MAX_SFX = 8;
export const CELLS = 768;
export const BLANK_CELL = 32;               // font space
export const TILE_CELL = 128;               // cell value of tile 0

export function assetTables(assets) {
  const a = assets ?? {};
  const named = ['sprites', 'tilesets', 'sfx', 'maps', 'music', 'models'];
  if (named.some((k) => k in a)) {
    return { sprites: a.sprites ?? {}, tilesets: a.tilesets ?? {}, sfx: a.sfx ?? {}, maps: a.maps ?? {}, music: a.music ?? {}, models: a.models ?? {} };
  }
  return { sprites: a, tilesets: {}, sfx: {}, maps: {}, music: {}, models: {} };
}

/** A wireframe model asset ({points, edges}, docs/ARCADE_WIREFRAME_CONTRACT.md 2.1) converted: throws an Error naming the problem, else {points, edges, bytes} (its game image). */
export function convertModel(asset) {
  const why = modelError(asset);
  if (why) throw new Error(why);
  return { points: asset.points, edges: asset.edges, bytes: Uint8Array.from(modelBytes(asset)) };
}

export function lookupAsset(table, ...names) {
  if (!table) return undefined;
  for (const name of names) {
    if (name === undefined) continue;
    if (Object.hasOwn(table, name)) return table[name];
    const k = Object.keys(table).find((x) => x.toUpperCase() === String(name).toUpperCase());
    if (k !== undefined) return table[k];
  }
  return undefined;
}

function bits8(v, what) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255) return v;
  if (typeof v === 'string' && /^[0-9a-fA-F]{1,2}$/.test(v.trim())) return parseInt(v.trim(), 16);
  throw new Error(`${what} must be a number 0..255 or one or two hex digits, got ${JSON.stringify(v)}`);
}
function int(v, lo, hi, what, dflt) {
  if (v === undefined || v === null) { if (dflt !== undefined) return dflt; throw new Error(`${what} is missing`); }
  if (!Number.isInteger(v) || v < lo || v > hi) throw new Error(`${what} must be a whole number ${lo}..${hi}, got ${JSON.stringify(v)}`);
  return v;
}

/** The attribute byte of a tile: bright<<6 | paper<<3 | ink from its first row. */
export function tileAttr(row0, what = 'tile') {
  const ink = int(row0?.ink, 0, 7, `${what} ink`, 0);
  const paper = int(row0?.paper, 0, 7, `${what} paper`, 7);
  const bright = int(row0?.bright === true ? 1 : row0?.bright === false ? 0 : row0?.bright, 0, 1, `${what} bright`, 0);
  return (bright << 6) | (paper << 3) | ink;
}

export function convertTileset(asset) {
  const tiles = asset?.tiles ?? asset?.frames;
  if (!Array.isArray(tiles)) throw new Error('the tileset has no "tiles" array');
  if (tiles.length < 1) throw new Error('the tileset has no tiles');
  if (tiles.length > MAX_TILES) throw new Error(`the tileset has ${tiles.length} tiles; at most ${MAX_TILES} are supported`);
  const bytes = new Uint8Array(tiles.length * 9);
  const flags = new Array(tiles.length).fill(0);
  let flagsProblem = null;                     // language batch 2: a tile's flags (0..255); only a WINDOW game needs them, so a bad value is reported there
  tiles.forEach((t, i) => {
    const f = t?.flags;
    if (f !== undefined && f !== null) { if (Number.isInteger(f) && f >= 0 && f <= 255) flags[i] = f; else flagsProblem ??= `tile ${i} flags must be a whole number 0..255, got ${JSON.stringify(f)}`; }
    const rows = t?.rows;
    if (!Array.isArray(rows) || rows.length !== 8) throw new Error(`tile ${i} needs exactly 8 rows`);
    rows.forEach((r, y) => { bytes[i * 9 + y] = bits8(r?.bits, `tile ${i} row ${y} bits`); });
    bytes[i * 9 + 8] = tileAttr(rows[0], `tile ${i}`);
  });
  return { count: tiles.length, bytes, tiles, flags, flagsProblem };
}

/** The silent record that pads a shorter channel of a multi-channel effect: tone 0, vol 0, noise 0, mix 7 (both off). */
export const SFX_SILENT_RECORD = Object.freeze([0, 0, 7 << 5, 0]);
export const SFX_CHANNEL_NAMES = Object.freeze(['A', 'B', 'C']);

/** One record's four bytes, validated; `where` prefixes the error ("tick 3" for the one-channel form, "channel B tick 3" for the other). */
function sfxRecord(t, where) {
  const tone = int(t?.tone, 0, 4095, `${where} tone`);
  const vol = int(t?.vol, 0, 15, `${where} vol`, 0);
  const noise = int(t?.noise, 0, 31, `${where} noise`, 0);
  const mix = int(t?.mix, 0, 7, `${where} mix`, 0);
  const hi = (tone >> 8) | (vol << 4);
  if (hi === 0xFF) throw new Error(`${where}: tone ${tone} with volume 15 cannot be stored (the byte $FF ends an effect); lower the volume or the tone`);
  return [tone & 0xFF, hi, noise | (mix << 5), 0];
}

/** The channels of a sound asset as three arrays of ticks ([ticks, ticksB, ticksC]); B and C absent / null = []. Throws the "must be an array" errors. */
function sfxChannels(asset) {
  const ticks = asset?.ticks;
  if (!Array.isArray(ticks)) throw new Error('the sound effect has no "ticks" array');
  const extra = [asset?.ticksB, asset?.ticksC].map((v, k) => {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v)) throw new Error(`the sound effect's "ticks${SFX_CHANNEL_NAMES[k + 1]}" (channel ${SFX_CHANNEL_NAMES[k + 1]}) must be an array of ticks`);
    return v;
  });
  return [ticks, ...extra];
}

/**
 * The AY register values of a three-channel effect, one array of 11 numbers (R0..R10) per refresh (docs/ARCADE_LANGUAGE_BATCH5.md items 16 and 17):
 *   R0 / R1 = tone A low byte / high nibble, R2 / R3 = B, R4 / R5 = C; R6 = the noise of the lowest channel (A, B, C) whose record has noise on
 *   (mix bit 1 = 0) that refresh, none: channel A's noise; R7 = bit c = channel c's mix bit 0 (tone off), bit 3 + c = its mix bit 1 (noise off), bits 6, 7 = 0;
 *   R8 / R9 / R10 = the volumes of A / B / C.  A channel shorter than the longest contributes the silent record (tone 0, vol 0, noise 0, mix 7) after its end.
 * Every record has the field ranges and the unstorable rule of the one-channel form.  Used by convertSfx and by the sound editor's size accounting.
 */
export function sfxRefreshRegisters(asset) {
  const chans = sfxChannels(asset);
  const L = Math.max(...chans.map((c) => c.length));
  const out = [];
  for (let r = 0; r < L; r++) {
    const recs = chans.map((c, k) => (r < c.length ? sfxRecord(c[r], `channel ${SFX_CHANNEL_NAMES[k]} tick ${r}`) : SFX_SILENT_RECORD));
    const regs = new Array(11).fill(0);
    let noiseReg = recs[0][2] & 31, found = false, mixer = 0;
    recs.forEach((rec, c) => {
      const tone = rec[0] | ((rec[1] & 15) << 8), vol = rec[1] >> 4, noise = rec[2] & 31, mix = rec[2] >> 5;
      regs[c * 2] = tone & 0xFF;
      regs[c * 2 + 1] = tone >> 8;
      regs[8 + c] = vol;
      mixer |= (mix & 1) << c;
      mixer |= ((mix >> 1) & 1) << (3 + c);
      if (!found && (mix & 2) === 0) { found = true; noiseReg = noise; }
    });
    regs[6] = noiseReg;
    regs[7] = mixer;
    out.push(regs);
  }
  return out;
}

/** The byte length of the delta-stream image of the per-refresh registers `regs` (sfxRefreshRegisters): 4-byte header, entries, the $FF end. */
export function sfxStreamLength(regs) {
  let n = 4 + 1;
  regs.forEach((r, i) => { n += 1 + 2 * (i === 0 ? 11 : r.reduce((c, v, k) => c + (v !== regs[i - 1][k] ? 1 : 0), 0)); });
  return n;
}

/**
 * Sound effect asset -> image.  `asset` = {ticks, ticksB?, ticksC?} (channel A, B, C; B and C are optional arrays of the same records, null / absent / empty = none).
 *   one channel  (no ticksB / ticksC, or both empty): 4 bytes per record + the terminator record `0, $FF, 0, 0`  -> {records, channels: 1, bytes}
 *   three channels: the delta stream of item 17: header `0, 0, 0, 3`; per refresh an entry `n, (reg, value) x n` (the first all 11 registers, later
 *     only the registers that differ from the refresh before, ascending); the single byte $FF ends it  -> {records: the longest channel, channels: 3, bytes}
 * Every record of every channel has the field ranges and the unstorable rule (tone 3840..4095 with volume 15) of the one-channel form.
 */
export function convertSfx(asset) {
  const [ticks, ...extra] = sfxChannels(asset);
  if (extra[0].length === 0 && extra[1].length === 0) {
    const bytes = new Uint8Array((ticks.length + 1) * 4);
    ticks.forEach((t, i) => bytes.set(sfxRecord(t, `tick ${i}`), i * 4));
    bytes.set([0, 0xFF, 0, 0], ticks.length * 4);       // terminator record
    return { records: ticks.length, channels: 1, bytes };
  }
  const regs = sfxRefreshRegisters(asset);
  const out = [0, 0, 0, 3];
  regs.forEach((cur, i) => {
    const pairs = [];
    cur.forEach((v, k) => { if (i === 0 || v !== regs[i - 1][k]) pairs.push(k, v); });
    out.push(pairs.length / 2, ...pairs);
  });
  out.push(0xFF);
  return { records: regs.length, channels: 3, bytes: Uint8Array.from(out) };
}

// ── music (docs/ARCADE_MUSIC_CONTRACT.md sections 3 and 4) ──────────────────────────────────────────────────────────────────────────────────
export const MAX_SONGS = LIMITS.maxSongs;           // the language's limit (arcade-words.js), the checker's "too many songs"
export const MAX_PATTERNS = 32;
export const MAX_ORDER = 64;
export const MAX_PATTERN_TICKS = 1800;              // the effect editor's cap, per pattern
export const MUSIC_WAIT = 0x80;                     // $80 + k: k + 1 refreshes with no change (k = 0..126)
export const MUSIC_MAX_WAIT = 127;                  // refreshes one wait item can hold
export const MUSIC_END = 0xFF;                      // the end of a pattern
export const MUSIC_NO_LOOP = 0xFF;                  // the song's loop byte when it does not loop
export const SFX_TYPE_C = 4;                        // header byte 3 of a channel-C effect stream (games with songs)
/** The registers a channel-C effect stream may hold: tone C (R4, R5), noise (R6, only when the effect uses noise), the mixer (R7: bits 2 and 5 only), volume C (R10). */
export const SFX_C_REGS = Object.freeze([4, 5, 6, 7, 10]);
export const SFX_C_MIXER_BITS = 0x24;

/** Items of a delta stream with waits from per-refresh register arrays: the first refresh writes all 11, a later one its changes (`n, pairs`), runs of
 *  unchanged refreshes become `$80 + k` items (at most 127 refreshes each).  Returns the items as a byte array without the end byte. */
function musicItems(regs) {
  const out = [];
  let wait = 0;
  const flush = () => { while (wait > 0) { const r = Math.min(wait, MUSIC_MAX_WAIT); out.push(MUSIC_WAIT + r - 1); wait -= r; } };
  regs.forEach((cur, i) => {
    const pairs = [];
    cur.forEach((v, k) => { if (i === 0 || v !== regs[i - 1][k]) pairs.push(k, v); });
    if (i > 0 && pairs.length === 0) { wait++; return; }
    flush();
    out.push(pairs.length / 2, ...pairs);
  });
  flush();
  return out;
}

/** One pattern ({ticks, ticksB?, ticksC?}, a three-channel effect's shape) -> its stream: items with waits, then $FF. */
export function convertPattern(pattern, where = 'pattern') {
  if (!pattern || typeof pattern !== 'object') throw new Error(`${where} is not an object`);
  let regs;
  try { regs = sfxRefreshRegisters(pattern); } catch (e) { throw new Error(`${where}: ${e.message}`); }
  if (regs.length === 0) throw new Error(`${where} is empty (no ticks in any channel)`);
  if (regs.length > MAX_PATTERN_TICKS) throw new Error(`${where} is ${regs.length} refreshes long (at most ${MAX_PATTERN_TICKS})`);
  return { refreshes: regs.length, bytes: Uint8Array.from([...musicItems(regs), MUSIC_END]) };
}

/**
 * Song asset -> its parts (the code generator lays them out: the song is `loop, DW pattern pointers in order, DW 0`, each pattern stream once).
 *   asset = {patterns: [pattern...], order: [pattern index...], loop: order position | null}
 *   -> {patterns: [{refreshes, bytes}], order, loop (0..order.length - 1 or MUSIC_NO_LOOP), refreshes (one pass of the order), bytes (all of it)}
 */
export function convertMusic(asset) {
  const pats = asset?.patterns, order = asset?.order;
  if (!Array.isArray(pats) || pats.length === 0) throw new Error('the song has no "patterns"');
  if (pats.length > MAX_PATTERNS) throw new Error(`the song has ${pats.length} patterns (at most ${MAX_PATTERNS})`);
  if (!Array.isArray(order) || order.length === 0) throw new Error('the song has an empty "order" list');
  if (order.length > MAX_ORDER) throw new Error(`the song's order list has ${order.length} entries (at most ${MAX_ORDER})`);
  order.forEach((p, i) => { if (!Number.isInteger(p) || p < 0 || p >= pats.length) throw new Error(`order entry ${i} is ${JSON.stringify(p)}: a pattern index 0..${pats.length - 1}`); });
  let loop = asset?.loop ?? null;
  if (loop === null) loop = MUSIC_NO_LOOP;
  else if (!Number.isInteger(loop) || loop < 0 || loop >= order.length) throw new Error(`the song's loop is ${JSON.stringify(asset.loop)}: an order position 0..${order.length - 1}, or null`);
  const patterns = pats.map((p, i) => convertPattern(p, `pattern ${i}`));
  const refreshes = order.reduce((n, p) => n + patterns[p].refreshes, 0);
  const bytes = 1 + 2 * (order.length + 1) + patterns.reduce((n, p) => n + p.bytes.length, 0);
  return { patterns, order: order.slice(), loop, refreshes, bytes };
}

/**
 * A one-channel effect as a channel-C stream (only in a game with songs, contract section 4): header `0, 0, noise, 4` (noise = 1 when any record has
 * noise on), then one entry per refresh holding R4, R5, R6 (only with noise), R7 (only bits 2 and 5: tone C off, noise C off) and R10; the first
 * entry all of them, later ones the changes; $FF ends it.  The records are channel A's of the stored effect (`ticks`).
 */
export function convertSfxC(asset) {
  const [ticks, ...extra] = sfxChannels(asset);
  if (extra[0].length || extra[1].length) throw new Error('convertSfxC takes a one-channel effect');
  const recs = ticks.map((t, i) => sfxRecord(t, `tick ${i}`));
  const noise = recs.some((r) => ((r[2] >> 5) & 2) === 0) ? 1 : 0;
  const regsOf = (r) => {
    const tone = r[0] | ((r[1] & 15) << 8), mix = r[2] >> 5, m = {};
    m[4] = tone & 0xFF; m[5] = tone >> 8;
    if (noise) m[6] = r[2] & 31;
    m[7] = ((mix & 1) << 2) | (((mix >> 1) & 1) << 5);
    m[10] = r[1] >> 4;
    return m;
  };
  const out = [0, 0, noise, SFX_TYPE_C];
  let prev = null;
  recs.forEach((r) => {
    const cur = regsOf(r), pairs = [];
    for (const k of SFX_C_REGS) if (k in cur && (prev === null || cur[k] !== prev[k])) pairs.push(k, cur[k]);
    out.push(pairs.length / 2, ...pairs);
    prev = cur;
  });
  out.push(0xFF);
  return { records: recs.length, channels: 1, noise, bytes: Uint8Array.from(out) };
}

export function convertMap(asset, tileCount = MAX_TILES) {
  const w = int(asset?.w, 1, 32, 'map w'), h = int(asset?.h, 1, 24, 'map h');
  let cells = asset?.cells;
  if (typeof cells === 'string') {
    const s = cells.replace(/\s+/g, '');
    if (!/^([0-9a-fA-F]{2})*$/.test(s)) throw new Error('map cells as a string must be hex, two digits per cell');
    cells = s.match(/../g)?.map((x) => parseInt(x, 16)) ?? [];
  }
  if (!Array.isArray(cells)) throw new Error('the map has no "cells"');
  if (cells.length !== w * h) throw new Error(`the map is ${w} x ${h} = ${w * h} cells but "cells" has ${cells.length}`);
  const bytes = new Uint8Array(CELLS).fill(BLANK_CELL);
  cells.forEach((v, i) => {
    let b = BLANK_CELL;
    if (!(v === null || v === -1 || v === 255)) {
      if (!Number.isInteger(v) || v < 0 || v >= tileCount) throw new Error(`map cell ${i} is ${JSON.stringify(v)}: a tile index 0..${tileCount - 1}, or blank (-1, null or 255)`);
      b = TILE_CELL + v;
    }
    bytes[(Math.floor(i / w)) * 32 + (i % w)] = b;
  });
  return { w, h, cells, bytes };
}

// ── Language batch 2: sprites of runtime v3 (widths 8..32, heights up to 48, frames, mirrored copies) ──────────────────────────────

function parseWide(v, what) {
  if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xFFFFFFFF) return v;
  if (typeof v === 'string' && /^[0-9a-fA-F]{1,8}$/.test(v.trim())) return parseInt(v.trim(), 16);
  throw new Error(`${what} must be a number or a hex string of up to 8 digits, got ${JSON.stringify(v)}`);
}
/** Reverse the lowest `n` bits of v (n <= 32). */
function reverseBits(v, n) {
  let r = 0;
  for (let i = 0; i < n; i++) { r = r * 2 + (v % 2); v = Math.floor(v / 2); }
  return r;
}
const byteOf = (v, k) => Math.floor(v / 2 ** (8 * k)) % 256;

/** The frames of a sprite asset as lists of rows: its `frames` array, else its single `rows`. */
export function assetFrames(asset) {
  if (Array.isArray(asset?.frames) && asset.frames.length) return asset.frames.map((f) => f?.rows);
  return [asset?.rows];
}
/** How many frames the compiler compiles from the asset: all of them when the program gives it a FRAME, else frame 0 only. */
export const compiledFrameCount = (asset, allFrames) => (allFrames ? assetFrames(asset).length : 1);

/**
 * Asset sprite -> runtime v3 frame data: `nframes` blocks (the compiled frames, then, with `flip`, the same frames mirrored left to right) of `h` rows;
 * a row is `wb` mask bytes then `wb` image bytes, `wb` = ceil(w / 8), leftmost pixel = bit 7 of the first byte, contract mask 1 = the background shows
 * (the asset's mask is 1 where the sprite covers; a row with no mask covers its whole width). A width that is not a multiple of 8 is padded on the right
 * with transparent pixels (descriptor width = 8 * wb); the mirrored copy is mirrored within the sprite's own width.
 *   opts: {allFrames, flip}
 *   -> {w: 8 * wb, srcW, h, wb, framesSrc, nframes, data}   framesSrc = compiled source frames (n), nframes = n or 2n
 * Limits: w 1..32, h 1..48, at most 32 frames after mirroring (16 source frames with flip).
 */
export function convertSpriteV3(asset, { allFrames = false, flip = false } = {}) {
  const w = asset.w ?? 16;
  const frames = assetFrames(asset);
  const first = allFrames ? frames[0] : (asset.rows ?? frames[0]);
  if (!Array.isArray(first)) throw new Error('the sprite has no rows');
  const h = asset.h ?? first.length;
  if (!(Number.isInteger(w) && w >= 1 && w <= 32)) throw new Error(`width ${w} is not supported (1..32 pixels; 8, 16, 24 or 32 are the natural widths)`);
  if (!(Number.isInteger(h) && h >= 1 && h <= 48)) throw new Error(`height ${h} is not supported (1..48 rows)`);
  const list = allFrames ? frames : [first];
  const n = list.length;
  if (n > 32 || (flip && n > 16)) throw new Error(flip ? `${n} frames and FLIP: the mirrored copies make ${2 * n}, at most 32 frames fit (16 frames with FLIP)` : `${n} frames: at most 32 frames per sprite`);
  const wb = Math.ceil(w / 8), W = 8 * wb;
  const wmask = 2 ** w - 1;
  const rowsOf = list.map((rows, k) => {
    if (!Array.isArray(rows)) throw new Error(`frame ${k} has no rows`);
    if (rows.length !== h) throw new Error(`the sprite says h = ${h} but ${n > 1 ? `frame ${k} has` : 'it has'} ${rows.length} rows`);
    return rows.map((r, i) => {
      const bits = parseWide(r?.bits, `frame ${k} row ${i} bits`) % (wmask + 1);
      const covers = (r?.mask === undefined || r?.mask === null ? wmask : parseWide(r.mask, `frame ${k} row ${i} mask`) % (wmask + 1));
      return { bits: Number(BigInt(bits) & BigInt(covers)), covers };
    });
  });
  const emit = (rows, mirror) => {
    const out = [];
    for (const { bits, covers } of rows) {
      const b = mirror ? reverseBits(bits, w) : bits, c = mirror ? reverseBits(covers, w) : covers;
      // left-align in W bits: pixel 0 is the top bit of the W-bit word
      const cw = c * 2 ** (W - w), bw = b * 2 ** (W - w);
      const maskW = (2 ** W - 1) - cw;                 // the contract mask: 1 = background shows (also outside the sprite's own width)
      for (let k = wb - 1; k >= 0; k--) out.push(byteOf(maskW, k));
      for (let k = wb - 1; k >= 0; k--) out.push(byteOf(bw, k));
    }
    return out;
  };
  const bytes = [];
  for (const rows of rowsOf) bytes.push(...emit(rows, false));
  if (flip) for (const rows of rowsOf) bytes.push(...emit(rows, true));
  return { w: W, srcW: w, h, wb, framesSrc: n, nframes: flip ? 2 * n : n, data: Uint8Array.from(bytes) };
}
