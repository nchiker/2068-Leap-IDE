/**
 * src/starters/starter-a-art.js -- the drawing helpers of the starter games of starters-a.js (pure: no DOM, no Node APIs; the browser loads it).
 *
 * The art of a starter is drawn by code, the way arcade/examples/*.assets.gen.mjs draw the example games' (the examples folder is not importable
 * from src/, so the few helpers needed are copied here):
 *   mirror(half), sprite(rows, opts), tileOf(bytes, ink, paper), ticks(n, f)     ASCII art -> assets
 *   picture(), dither(), set(), text(), tiler()      the fine-colour (8 x 1 colour) pipeline of arcade/examples/fineart.mjs: paint a full-colour picture,
 *       shade it along ramps of colours that are neighbours in brightness (a step between two colours is a checkerboard seam), cut it into
 *       8 x 1 groups and into de-duplicated 8 x 8 tiles (docs/ARCADE_FINE_COLOUR_CONTRACT.md section 2)
 */

"use strict";

export const W = 256, H = 192;

// ── ASCII art -> assets ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** A row of art and its mirror image: draw the left half, get the whole. */
export const mirror = (half) => half + [...half].reverse().join('');

/**
 * A sprite asset from ASCII rows: '#' a lit pixel (ink), '-' a covered but unlit pixel (paper: it hides what is behind), '.' transparent.
 * `ink` is one colour for every row, or `inks` one colour per pixel row (a fine-colour scene colours a sprite by the ink of each row). Black paper is BRIGHT 0.
 */
export function sprite(rows, { hot, phases, ink = 7, inks = null, paper = 0, bright = 0 }) {
  const h = rows.length, w = rows[0].length;
  if (rows.some((r) => r.length !== w)) throw new Error('a sprite\'s rows must all be as long as the first');
  if (inks && inks.length !== h) throw new Error(`${inks.length} row inks for ${h} rows`);
  const hex = (v) => v.toString(16).toUpperCase().padStart(w / 4, '0');
  const outRows = rows.map((r, k) => {
    let bits = 0, mask = 0;
    for (const ch of r) { bits <<= 1; mask <<= 1; if (ch === '#') { bits |= 1; mask |= 1; } else if (ch === '-') mask |= 1; }
    return { bits: hex(bits), mask: hex(mask), ink: inks ? inks[k] : ink, paper, bright };
  });
  const s = { w, h, frames: [{ rows: outRows }] };
  if (hot) s.hot = hot;
  if (phases) s.phases = phases;
  return s;
}

const per = (v, k) => (Array.isArray(v) ? v[k] : v);
/** A tile from eight row bytes; `ink` and `paper` are one colour or one per pixel row (a fine-colour scene draws each row in its own colours). */
export const tileOf = (bytes, ink = 7, paper = 0, flags = 0) => ({
  rows: bytes.map((b, k) => ({ bits: b.toString(16).toUpperCase().padStart(2, '0'), ink: per(ink, k), paper: per(paper, k), bright: 0 })), flags,
});
/** n sound-effect records from f(k) -> {tone, vol, noise, mix}. */
export const ticks = (n, f) => Array.from({ length: n }, (_, k) => f(k));

// ── the fine-colour picture (a port of arcade/examples/fineart.mjs) ───────────────────────────────────────────────────────────────

// the runtime's font: 96 glyphs of 8 bytes for the codes 32..127 (arcade/runtime/v1/font.inc), bit 7 = the leftmost pixel
const FONT_HEX = [
  '0000000000000000 2020202020002000 5050000000000000 5050F850F8505000 2078A07028F02000 8810202040880000',
  '6090606890986800 2020000000000000 1020404040201000 4020101010204000 0010543854100000 002020F820200000',
  '0000000000202040 000000F800000000 0000000000002000 0004081020400000 708898A8C8887000 2060A0202020F800',
  '708808102040F800 F008103008887000 10305090F8101000 F880F00808887000 304080F088887000 F808102040404000',
  '7088887088887000 7088887808106000 0020000020000000 0020000020204000 1020408040201000 0000F800F8000000',
  '4020100810204000 7088081020002000 7088B0B080887000 20508888F8888800 F08888F08888F000 7088808080887000',
  'F08888888888F000 F88080F08080F800 F88080F080808000 708880B888887000 888888F888888800 7020202020207000',
  '0808080808887000 8890A0C0A0908800 808080808080F800 88D8A88888888800 88C8A89888888800 7088888888887000',
  'F08888F080808000 70888888A8906800 F08888F0A0908800 7088807008887000 F820202020202000 8888888888887000',
  '8888888888502000 888888A8A8D88800 8850202020508800 8850202020202000 F80810204080F800 7040404040407000',
  '0040201008040000 7010101010107000 2050880000000000 000000000000F800 4020000000000000 0000700878887800',
  '8080B0C88888F000 0000708880887000 0808689888887800 00007088F8807000 3040F04040404000 0000788888780870',
  '8080B0C888888800 2000602020207000 1000301010109060 808090A0C0A09000 6020202020201800 0000D0A8A8888800',
  '0000B0C888888800 0000708888887000 0000F08888F08080 0000788888780808 0000B0C880808000 000078807008F000',
  '4040F04040483000 0000888888986800 0000888888502000 00008888A8A85000 0000885020508800 0000888888780870',
  '0000F8102040F800 1820204020201800 2020202020202000 C02020102020C000 000040A810000000 0000000000000000',
].join(' ');
const FONT = FONT_HEX.split(' ').map((g) => g.match(/../g).map((b) => parseInt(b, 16)));

/** A picture: 256 x 192 pixels, each a colour 0..7 (black, blue, red, magenta, green, cyan, yellow, white: the TS2068's order of brightness) or -1 (nothing painted). */
export const picture = () => new Int8Array(W * H).fill(-1);

const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]];
/**
 * The colour of pixel (x, y) at `level` along `ramp` (colours that are neighbours in brightness). Between two colours the middle `seam` of a step is a
 * checkerboard of the two (ordered dither), the rest of the step is solid: bands with crisp, dithered seams.
 */
export function dither(x, y, level, ramp, { seam = 0.3 } = {}) {
  const top = ramp.length - 1;
  if (level <= 0) return ramp[0];
  if (level >= top) return ramp[top];
  const lo = Math.floor(level), g = level - lo;
  const f = seam > 0 ? (g < 0.5 - seam / 2 ? 0 : g > 0.5 + seam / 2 ? 1 : 0.5) : Math.round(g * 4) / 4;
  return 16 * f > BAYER[y & 3][x & 3] ? ramp[lo + 1] : ramp[lo];
}

export function set(pic, x, y, c) { if (x >= 0 && x < W && y >= 0 && y < H && c !== undefined && c !== null) pic[y * W + x] = c; }
const get = (pic, x, y) => (x >= 0 && x < W && y >= 0 && y < H ? pic[y * W + x] : -1);

/** Paint `str` in the font at pixel (x, y), each glyph pixel `scale` times (`bold` thickens the strokes); colourOf(py, px) is the colour of a lit pixel. */
export function text(pic, str, x, y, colourOf, { scale = 1, bold = false } = {}) {
  [...str].forEach((ch, i) => {
    const g = FONT[ch.charCodeAt(0) - 32] ?? FONT[0];
    for (let r = 0; r < 8; r++) for (let b = 0; b < 8; b++) {
      const on = (g[r] >> (7 - b)) & 1 || (bold && b > 0 && (g[r] >> (8 - b)) & 1);
      if (!on) continue;
      for (let sy = 0; sy < scale; sy++) for (let sx = 0; sx < scale; sx++) set(pic, x + 8 * scale * i + b * scale + sx, y + r * scale + sy, colourOf(r * scale + sy, 8 * scale * i + b * scale + sx));
    }
  });
}

/** One 8 x 1 group of the picture: {bits, ink, paper}: the two most used colours (the most used is the paper, ties the darker); -1 counts as black. */
function group(pic, y, c) {
  const px = [];
  for (let b = 0; b < 8; b++) { const v = pic[y * W + 8 * c + b]; px.push(v < 0 ? 0 : v & 7); }
  const n = new Array(8).fill(0);
  px.forEach((v) => n[v]++);
  const order = [...n.keys()].filter((k) => n[k] > 0).sort((a, b) => n[b] - n[a] || a - b);
  const paper = order[0], ink = order[1] ?? order[0];
  let bits = 0;
  px.forEach((v, b) => { if (v !== paper && (v === ink || Math.abs(v - ink) < Math.abs(v - paper))) bits |= 0x80 >> b; });
  return { bits, ink, paper };
}

/** A tile set under construction: add(pic, row, col, h, w) cuts a block of cells out of a picture and gives their tile numbers, equal tiles shared. */
export function tiler(preset = []) {
  const tiles = [...preset], index = new Map();
  const keyOf = (t) => t.rows.map((r) => `${r.bits}/${r.bits === '00' ? '-' : r.ink}/${r.paper}/${r.bright}`).join(' ');
  tiles.forEach((t, i) => { if (!index.has(keyOf(t))) index.set(keyOf(t), i); });
  function tileAt(pic, r, c) {
    const rows = [];
    for (let k = 0; k < 8; k++) {
      const g = group(pic, 8 * r + k, c);
      rows.push({ bits: g.bits.toString(16).toUpperCase().padStart(2, '0'), ink: g.bits ? g.ink : 7, paper: g.paper, bright: 0 });
    }
    return { rows, flags: 0 };
  }
  function add(pic, r0, c0, h, w) {
    const cells = [];
    for (let r = r0; r < r0 + h; r++) for (let c = c0; c < c0 + w; c++) {
      const t = tileAt(pic, r, c), k = keyOf(t);
      if (!index.has(k)) { index.set(k, tiles.length); tiles.push(t); }
      cells.push(index.get(k));
    }
    return cells;
  }
  return { tiles, add, get count() { return tiles.length; } };
}
