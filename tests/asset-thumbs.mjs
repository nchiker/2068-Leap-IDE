"use strict";
// asset-thumbs.mjs -- tests for src/tools/asset-thumbs.js (the pictures of the gallery strip of the Studio's asset editors; pure, no DOM).
//   node tests/asset-thumbs.mjs
//
// Sections
//   1  every sprite, tile set, map and model of the example assets gives a picture inside the box, with pixels, not a placeholder
//   2  what the pictures show: a sprite's first frame in its own colours (transparent where the mask is clear), a tile set's tiles, a map's cells
//      (with and without a tile set, a floor plan, a world), a model's lines
//   3  the box: sizes, aspect, whole-number enlargement, sampling down, clamping
//   4  total: malformed assets (null, numbers, strings, wrong shapes, random junk) give a placeholder and never throw
//   5  deterministic and the input is not modified
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as A from '../src/tools/asset-thumbs.js';
import * as S from '../src/tools/sprite-model.js';
import * as T from '../src/tools/tile-model.js';
import * as M from '../src/tools/map-model.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
let passed = 0, failed = 0;
const check = (name, cond, detail = '') => {
  console.log(`  ${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  (' + detail + ')' : ''}`);
  cond ? passed++ : failed++;
  return cond;
};
const J = JSON.stringify;
const pixelAt = (t, x, y) => Array.from(t.rgba.slice((y * t.w + x) * 4, (y * t.w + x) * 4 + 4));
const opaque = (t) => { let n = 0; for (let i = 3; i < t.rgba.length; i += 4) if (t.rgba[i]) n++; return n; };
const colours = (t) => { const s = new Set(); for (let i = 0; i < t.rgba.length; i += 4) if (t.rgba[i + 3]) s.add(t.rgba[i] << 16 | t.rgba[i + 1] << 8 | t.rgba[i + 2]); return s; };
const wellFormed = (t, box) => t && Number.isInteger(t.w) && Number.isInteger(t.h) && t.w >= 1 && t.h >= 1 && t.w <= box && t.h <= box && t.rgba instanceof Uint8ClampedArray && t.rgba.length === t.w * t.h * 4;
const rgbOf = (key) => S.keyRGB(key);

const files = readdirSync(join(ROOT, 'arcade/examples')).filter((f) => f.endsWith('.assets.json')).sort();
const projects = files.map((f) => [f.replace('.assets.json', ''), JSON.parse(readFileSync(join(ROOT, 'arcade/examples', f), 'utf8'))]);

// ── 1 ──
console.log('1  the example assets');
{
  const counts = { sprites: 0, tilesets: 0, maps: 0, models: 0 };
  let bad = [];
  for (const [game, assets] of projects) {
    const tilesets = assets.tilesets ?? {};
    for (const [n, a] of Object.entries(assets.sprites ?? {})) {
      counts.sprites++;
      const t = A.thumbSprite(a);
      if (!wellFormed(t, 48) || t.placeholder || !opaque(t)) bad.push(`${game}/sprites/${n}`);
    }
    for (const [n, a] of Object.entries(assets.tilesets ?? {})) {
      counts.tilesets++;
      const t = A.thumbTileset(a);
      if (!wellFormed(t, 48) || t.placeholder || !opaque(t)) bad.push(`${game}/tilesets/${n}`);
    }
    for (const [n, a] of Object.entries(assets.maps ?? {})) {
      counts.maps++;
      const ts = typeof a.tileset === 'string' ? tilesets[a.tileset] : Object.values(tilesets).length === 1 ? Object.values(tilesets)[0] : null;
      const t = A.thumbMap(a, { tileset: ts ?? null, role: 'cell' });
      if (!wellFormed(t, 48) || t.placeholder || opaque(t) !== t.w * t.h) bad.push(`${game}/maps/${n}`);
    }
    for (const [n, a] of Object.entries(assets.models ?? {})) {
      counts.models++;
      const t = A.thumbModel(a);
      if (!wellFormed(t, 48) || t.placeholder || colours(t).size < 2) bad.push(`${game}/models/${n}`);
    }
  }
  check('the examples hold sprites, tile sets, maps and models to draw', Object.values(counts).every((n) => n > 0), J(counts));
  check('every one gives a well-formed picture inside 48 x 48 that is not a placeholder', bad.length === 0, bad.slice(0, 5).join(', '));
}

// ── 2 ──
console.log('2  what the pictures show');
{
  // a sprite: 8 x 2, frame 0 row 0 = bits 10000001 ink 2 (red) paper 4 (green) bright 0, mask all; row 1 = mask 0 (transparent)
  const sprite = { w: 8, h: 2, phases: 8, frames: [{ rows: [{ bits: '81', mask: 'FF', ink: 2, paper: 4, bright: 0 }, { bits: 'FF', mask: '00', ink: 7, paper: 0, bright: 1 }] }] };
  const t = A.thumbSprite(sprite, { box: 16 });
  check('a sprite of 8 x 2 in a 16 box is enlarged by 2 (16 x 4)', t.w === 16 && t.h === 4, `${t.w}x${t.h}`);
  check('its ink pixel is the row ink, its paper pixel the row paper', J(pixelAt(t, 0, 0)) === J([...rgbOf(2), 255]) && J(pixelAt(t, 3, 0)) === J([...rgbOf(4), 255]) && J(pixelAt(t, 14, 1)) === J([...rgbOf(2), 255]));
  check('a pixel under a clear mask is transparent', pixelAt(t, 0, 2)[3] === 0 && pixelAt(t, 15, 3)[3] === 0);
  const two = { ...sprite, frames: [sprite.frames[0], { rows: [{ bits: '00', mask: 'FF', ink: 1, paper: 6, bright: 1 }, { bits: '00', mask: 'FF', ink: 1, paper: 6, bright: 1 }] }] };
  check('opts.frame picks another frame; frame 0 is the default', J(pixelAt(A.thumbSprite(two, { box: 16, frame: 1 }), 0, 0)) === J([...rgbOf(14), 255]) && J(pixelAt(A.thumbSprite(two, { box: 16 }), 0, 0)) === J([...rgbOf(2), 255]) && A.thumbSprite(two, { box: 16, frame: 99 }).placeholder !== true);
  const pal = Array.from({ length: 16 }, (_, i) => ({ name: 'c' + i, rgb: [i * 10, i * 10 + 1, i * 10 + 2] }));
  check('opts.palette is the host palette', J(pixelAt(A.thumbSprite(sprite, { box: 16, palette: pal }), 0, 0)) === J([20, 21, 22, 255]));
  // a big sprite (32 x 48) is sampled down into the box
  const big = S.toAsset(S.newSprite(32, 48));
  const bt = A.thumbSprite(big, { box: 36 });
  check('a 32 x 48 sprite fits a 36 box with its aspect (24 x 36)', bt.w === 24 && bt.h === 36, `${bt.w}x${bt.h}`);

  // a tile set
  const ts = T.toAsset(T.fromAsset({ tiles: [0, 1, 2, 3, 4].map((i) => ({ rows: Array.from({ length: 8 }, () => ({ bits: i === 4 ? 'FF' : '00', ink: 3, paper: i + 1 > 7 ? 7 : i + 1, bright: 0 })), flags: 0 })) }));
  const tt = A.thumbTileset(ts, { box: 48 });
  check('5 tiles are a 3 x 2 grid of 8 x 8 (24 x 16), enlarged by 2 into 48 x 32', tt.w === 48 && tt.h === 32, `${tt.w}x${tt.h}`);
  check('tile 0 is its paper, tile 4 its ink; the unused cell is transparent', J(pixelAt(tt, 2, 2)) === J([...rgbOf(1), 255]) && J(pixelAt(tt, 18, 18)) === J([...rgbOf(3), 255]) && pixelAt(tt, 34, 18)[3] === 0);
  const many = { tiles: Array.from({ length: 128 }, (_, i) => ({ rows: Array.from({ length: 8 }, () => ({ bits: '00', ink: 0, paper: i % 8, bright: 0 })), flags: 0 })) };
  const mt = A.thumbTileset(many, { box: 48 });
  check('128 tiles (12 x 11 of 8 x 8) fit the box with their aspect', wellFormed(mt, 48) && mt.w >= 40 && mt.h >= 38 && !mt.placeholder, `${mt.w}x${mt.h}`);
  const fineSet = { tiles: [{ rows: Array.from({ length: 8 }, (_, y) => ({ bits: '00', ink: 0, paper: y % 7 + 1, bright: 0 })), flags: 0 }] };
  const f1 = A.thumbTileset(fineSet, { box: 8 }), f2 = A.thumbTileset({ tiles: [{ rows: Array.from({ length: 8 }, () => ({ bits: '00', ink: 0, paper: 1, bright: 0 })), flags: 0 }] }, { box: 8 });
  check('a tile with a colour of its own in each pixel row is drawn row by row', colours(f1).size > 1 && colours(f2).size === 1);

  // a map
  const tset = { tiles: [0, 1].map((i) => ({ rows: Array.from({ length: 8 }, () => ({ bits: 'FF', ink: i + 1, paper: 0, bright: 0 })), flags: 0 })) };
  const map = { w: 3, h: 2, cells: [0, 1, 255, 1, 0, 9] };
  const mm = A.thumbMap(map, { tileset: tset, role: 'cell' }, { box: 48 });
  check('a 3 x 2 map is 24 x 16 pixels, enlarged by 2 into 48 x 32', mm.w === 48 && mm.h === 32 && !mm.noTileset, `${mm.w}x${mm.h}`);
  check('its cells are its tiles, a blank cell is the blank colour, an undefined tile a dark red cell',
    J(pixelAt(mm, 1, 1)) === J([...rgbOf(1), 255]) && J(pixelAt(mm, 17, 1)) === J([...rgbOf(2), 255]) && J(pixelAt(mm, 33, 1)) === J([38, 42, 49, 255]) && J(pixelAt(mm, 33, 17)) === J([58, 29, 29, 255]));
  const noTs = A.thumbMap(map, { tileset: null, role: 'cell' }, { box: 48 });
  check('a map without a tile set is still drawn (flat greys, noTileset) and its layout shows', noTs.noTileset === true && !noTs.placeholder && colours(noTs).size >= 2);
  const world = A.thumbMap({ w: 2, h: 1, cells: [255, 1] }, { tileset: tset, role: 'world' }, { box: 16 });
  check('in a world map a blank cell is tile 0', J(pixelAt(world, 1, 1)) === J([...rgbOf(1), 255]));
  const plan = A.thumbMap({ w: 5, h: 1, cells: [0, 1, 2, 3, 4] }, { role: 'floorplan' }, { box: 40 });
  check('a floor plan is drawn from its wall codes, five different colours, without a tile set note', colours(plan).size === 5 && !plan.noTileset);
  const wide = A.thumbMap({ w: 128, h: 32, cells: new Array(128 * 32).fill(1) }, { tileset: tset, role: 'cell' }, { box: 36 });
  check('a 128 x 32 map fits the box with its aspect (36 x 9) and keeps its colour', wide.w === 36 && wide.h === 9 && colours(wide).size === 1 && J(pixelAt(wide, 3, 3)) === J([...rgbOf(2), 255]), `${wide.w}x${wide.h}`);
  const hexMap = A.thumbMap({ w: 2, h: 1, cells: '0001' }, { tileset: tset }, { box: 16 });
  check('a map with its cells as a hex string is read too', J(pixelAt(hexMap, 1, 1)) === J([...rgbOf(1), 255]) && J(pixelAt(hexMap, 9, 1)) === J([...rgbOf(2), 255]));

  // a model
  const cube = { points: [[-20, -20, -20], [20, -20, -20], [20, 20, -20], [-20, 20, -20], [-20, -20, 20], [20, -20, 20], [20, 20, 20], [-20, 20, 20]], edges: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]] };
  const mo = A.thumbModel(cube, { box: 36 });
  check('a model is a box x box picture of light lines on a dark ground', mo.w === 36 && mo.h === 36 && colours(mo).size === 2 && opaque(mo) === 36 * 36);
  const lit = [...colours(mo)].length === 2 ? Array.from(mo.rgba).filter((_, i) => i % 4 === 0).filter((v) => v > 100).length : 0;
  check('the lines cover some of the box but not most of it', lit > 40 && lit < 36 * 36 / 2, String(lit));
  check('a model with points and no edges is a placeholder', A.thumbModel({ points: [[0, 0, 0]], edges: [] }).placeholder === true);
}

// ── 3 ──
console.log('3  the box');
{
  const sp = S.toAsset(S.newSprite(16, 16));
  check('the default box is 48 (DEFAULT_BOX)', A.DEFAULT_BOX === 48 && A.thumbSprite(sp).w === 48 && A.thumbSprite(sp).h === 48);
  check('a 16 x 16 sprite in a box of 40 is enlarged by 2 only (32 x 32)', A.thumbSprite(sp, { box: 40 }).w === 32);
  check('the box is clamped to 4..256', A.thumbSprite(sp, { box: 1 }).w === 4 && A.thumbSprite(sp, { box: 100000 }).w === 256 && A.thumbSprite(sp, { box: 'x' }).w === 48 && A.thumbSprite(sp, { box: NaN }).w === 48);
  const wide = S.toAsset(S.newSprite(32, 8));
  const t = A.thumbSprite(wide, { box: 20 });
  check('a wide sprite keeps its aspect and never leaves the box', t.w === 20 && t.h === 5, `${t.w}x${t.h}`);
  for (const box of [4, 9, 17, 36, 48, 64]) {
    const ok = [A.thumbSprite(sp, { box }), A.thumbTileset({ tiles: T.toAsset(T.fromAsset({ tiles: [{ rows: Array.from({ length: 8 }, () => ({ bits: '55', ink: 1, paper: 2, bright: 0 })), flags: 0 }] })).tiles }, { box }),
      A.thumbMap({ w: 20, h: 9, cells: new Array(180).fill(0) }, {}, { box }), A.thumbModel({ points: [[0, 0, 0], [30, 5, 5]], edges: [[0, 1]] }, { box }), A.placeholder(box)].every((x) => wellFormed(x, box));
    if (!check(`every kind fits a box of ${box}`, ok)) break;
  }
}

// ── 4 ──
console.log('4  total: damaged assets');
{
  const junk = [null, undefined, 0, 1, -1, NaN, '', 'abc', true, [], [1, 2], {}, { w: 'x' }, { frames: 5 }, { w: 8, h: 8 }, { w: 8, h: 8, frames: [] }, { w: 8, h: 8, frames: [{ rows: 'no' }] },
    { tiles: 'x' }, { tiles: [] }, { tiles: [{}] }, { tiles: [{ rows: [] }] }, { w: 2, h: 2, cells: [1] }, { w: 2, h: 2, cells: 'zz' }, { w: 1e9, h: 1, cells: [] }, { w: -3, h: 2, cells: [] },
    { points: 3, edges: [] }, { points: [[0, 0]], edges: [[0, 1]] }, { points: [[NaN, 0, 0], [1, 1, 1]], edges: [[0, 1]] }, { points: [[1e300, 0, 0], [-1e300, 0, 0]], edges: [[0, 1]] }, { points: [[0, 0, 0], [Infinity, 0, 0]], edges: [[0, 1]] }];
  const fns = [(a) => A.thumbSprite(a), (a) => A.thumbTileset(a), (a) => A.thumbMap(a, {}), (a) => A.thumbMap(a, { tileset: a, role: 'world' }), (a) => A.thumbMap(a, null), (a) => A.thumbModel(a), (a) => A.thumbSprite(a, null), (a) => A.thumbModel(a, { box: 20 })];
  let threw = 0, malformed = 0, n = 0;
  for (const a of junk) for (const f of fns) {
    n++;
    try { const t = f(a); if (!wellFormed(t, 256)) malformed++; } catch { threw++; }
  }
  check(`${n} malformed asset / function pairs: none throws, every result is a well-formed picture`, threw === 0 && malformed === 0, `threw ${threw}, malformed ${malformed}`);
  check('the placeholder says so, and is a box x box picture with an outline', A.thumbSprite(null, { box: 20 }).placeholder === true && A.thumbSprite(null, { box: 20 }).w === 20 && opaque(A.thumbSprite(null, { box: 20 })) > 0);
  check('a map with a damaged tile set is drawn like one without', A.thumbMap({ w: 2, h: 1, cells: [0, 1] }, { tileset: { tiles: 7 } }, { box: 16 }).noTileset === true);
  // a deterministic fuzz of stored shapes
  let seed = 12345;
  const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const val = (d = 0) => pick([null, 0, 1, 7, -2, 255, 1.5, 'FF', 'zz', true, [], {}, () => (d < 3 ? [val(d + 1), val(d + 1)] : 0), () => (d < 3 ? { w: val(d + 1), h: val(d + 1), cells: val(d + 1), points: val(d + 1), edges: val(d + 1), tiles: val(d + 1), frames: val(d + 1), rows: val(d + 1), bits: val(d + 1) } : 0)].map((v) => (typeof v === 'function' ? v() : v)));
  let fthrew = 0;
  for (let i = 0; i < 400; i++) { const a = val(); for (const f of fns) { try { if (!wellFormed(f(a), 256)) fthrew++; } catch { fthrew++; } } }
  check('400 random shapes through every function: never throws, always well-formed', fthrew === 0, String(fthrew));
}

// ── 5 ──
console.log('5  deterministic, no side effects');
{
  const [, assets] = projects.find(([g]) => g === 'orbit') ?? projects[0];
  const before = J(assets);
  const run = () => [
    ...Object.values(assets.sprites ?? {}).map((a) => A.thumbSprite(a)), ...Object.values(assets.tilesets ?? {}).map((a) => A.thumbTileset(a)),
    ...Object.values(assets.maps ?? {}).map((a) => A.thumbMap(a, { tileset: Object.values(assets.tilesets ?? {})[0] ?? null })), ...Object.values(assets.models ?? {}).map((a) => A.thumbModel(a)),
  ].map((t) => `${t.w}x${t.h}:${Buffer.from(t.rgba).toString('base64')}`).join('|');
  check('the same assets give byte-identical pictures twice', run() === run());
  check('the assets are not modified', J(assets) === before);
}

// ── 6 ──
// Added with the mutation suite tests/m20-thumbs-mutations.mjs. A reference built only from the header's description (a picture of w x h source pixels, scaled to fit the box: a whole-number
// enlargement or nearest-neighbour sampling at pixel centres; the colours of sprite-model / tile-model / map-model through the palette) and compared byte for byte with the module on
// many sizes, boxes, palettes, roles and random contents.
console.log('6  against a reference built from the header');
{
  let seed = 987654321;
  const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) / 0x7fffffff;
  const ri = (n) => Math.floor(rnd() * n);
  const rgbN = (c) => (c[0] << 16) | (c[1] << 8) | c[2];
  const sameBytes = (a, b) => !!a && !!b && a.w === b.w && a.h === b.h && !!a.placeholder === !!b.placeholder && !!a.noTileset === !!b.noTileset && Buffer.compare(Buffer.from(a.rgba), Buffer.from(b.rgba)) === 0;
  const bad = (a, b) => { if (!a || !b) return 'missing'; if (a.w !== b.w || a.h !== b.h) return `size ${a.w}x${a.h} against ${b.w}x${b.h}`; let n = 0; for (let i = 0; i < a.rgba.length; i++) if (a.rgba[i] !== b.rgba[i]) n++; return `${n} bytes differ, noTileset ${a.noTileset} / ${b.noTileset}`; };
  /** sample(x, y) -> packed 0xRRGGBB or -1 (transparent) */
  function refRender(sw, sh, sample, box) {
    const m = Math.max(sw, sh), s = box / m, k = Math.floor(s);
    const ow = k >= 1 ? sw * k : Math.max(1, Math.round(sw * s)), oh = k >= 1 ? sh * k : Math.max(1, Math.round(sh * s));
    const rgba = new Uint8ClampedArray(ow * oh * 4);
    for (let oy = 0; oy < oh; oy++) for (let ox = 0; ox < ow; ox++) {
      const v = sample(Math.min(sw - 1, Math.floor((ox + 0.5) * sw / ow)), Math.min(sh - 1, Math.floor((oy + 0.5) * sh / oh)));
      if (v >= 0) rgba.set([(v >> 16) & 255, (v >> 8) & 255, v & 255, 255], (oy * ow + ox) * 4);
    }
    return { w: ow, h: oh, rgba };
  }
  const palettes = [undefined, Array.from({ length: 16 }, (_, i) => ({ name: 'c' + i, rgb: [(i * 37 + 11) & 255, (i * 53 + 5) & 255, (i * 91 + 3) & 255] }))];
  const colourOf = (key, pal) => rgbN(S.keyRGB(S.normKey(key), pal));
  const hex = (n, bytes) => Array.from({ length: bytes }, () => ri(256).toString(16).padStart(2, '0')).join('').toUpperCase().slice(0, bytes * 2) || '00';

  // ---- the box: clamped and rounded (every kind of picture) ----
  {
    const cubeM = { points: [[-20, -20, -20], [20, 20, 20]], edges: [[0, 1]] };
    const w = (box) => A.thumbModel(cubeM, { box }).w;                                // a model's picture is exactly box x box
    check('box: rounded to the nearest whole number (4.4 is 4, 4.6 is 5, 19.5 is 20) and clamped to 4 .. 256 (255 stays 255, 257 is 256)', w(4.4) === 4 && w(4.6) === 5 && w(19.5) === 20 && w(255) === 255 && w(256) === 256 && w(257) === 256 && w(2) === 4 && w(0) === 4 && w(-5) === 4 && w(1e9) === 256 && w(undefined) === 48 && w('64') === 64);
    const pl = A.placeholder;
    check('placeholder(box): the default is 48, a zero or non-number is 48, the box is rounded and clamped to 4 .. 256 (255 stays 255, 300 is 256, 2 is 4)', pl().w === 48 && pl(0).w === 48 && pl('x').w === 48 && pl(NaN).w === 48 && pl(4.4).w === 4 && pl(4.6).w === 5 && pl(255).w === 255 && pl(300).w === 256 && pl(2).w === 4 && pl(100).h === 100);
    // the picture: a 1-pixel outline and both diagonals in [120, 128, 140], everything else transparent
    const odd = [4, 5, 9, 10, 31];
    const wrong = odd.filter((n) => { const t = pl(n); for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) { const on = x === 0 || y === 0 || x === n - 1 || y === n - 1 || x === y || x + y === n - 1; const px = pixelAt(t, x, y); if (J(px) !== J(on ? [120, 128, 140, 255] : [0, 0, 0, 0])) return true; } return t.placeholder !== true; });
    check('placeholder: the outline, both diagonals and nothing else, in [120, 128, 140, 255], for even and odd boxes', wrong.length === 0, wrong.join());
  }

  // ---- sprites ----
  {
    const sizes = [[8, 1], [8, 8], [16, 16], [24, 7], [32, 32], [32, 40], [8, 33], [16, 3], [32, 5]];
    const boxes = [4, 7, 20, 36, 48, 100, 256];
    let bad1 = 0, first = '', n = 0, fcyc = 0;
    for (const [w, h] of sizes) {
      const frames = [0, 1, 2].map(() => ({ rows: Array.from({ length: h }, () => ({ bits: hex(0, 0) || '', mask: '', ink: ri(8), paper: ri(8), bright: ri(2) })) }));
      for (const fr of frames) for (const r of fr.rows) { r.bits = hex(0, w / 8); r.mask = ri(3) === 0 ? 'FF'.repeat(w / 8) : hex(0, w / 8); }
      const asset = { w, h, phases: 8, frames };
      const sprite = S.fromAsset(asset);
      for (const box of boxes) for (const pal of palettes) for (const frame of [[undefined, 0, 1, 2], [3, 99, -1, 1.5]][fcyc++ % 2]) {
        n++;
        const f = Math.max(0, Math.min(sprite.frames.length - 1, Number.isInteger(frame) ? frame : 0)), keys = S.framePixels(sprite, f);
        const ref = refRender(w, h, (x, y) => { const k = keys[y * w + x]; return k < 0 ? -1 : colourOf(k, pal); }, box);
        const got = A.thumbSprite(asset, { box, frame, palette: pal });
        if (!sameBytes(got, ref)) { bad1++; first ||= `${w}x${h} box ${box} frame ${frame}: ${bad(got, ref)}`; }
      }
    }
    check(`thumbSprite equals the reference on ${n} (size, box, palette, frame) cases: frames 0..2 chosen, 3, 99 and -1 clamped, 1.5 and undefined are frame 0`, bad1 === 0, first);
    const tr = { w: 8, h: 1, phases: 8, frames: [{ rows: [{ bits: '00', mask: 'FF', ink: 7, paper: 0, bright: 0 }] }] };
    const p0 = pixelAt(A.thumbSprite(tr, { box: 8 }), 0, 0);
    check('a pixel of palette colour 0 (black) is opaque black; only a clear mask is transparent', J(p0) === J([0, 0, 0, 255]));
    const bright = { w: 8, h: 1, phases: 8, frames: [{ rows: [{ bits: '80', mask: 'FF', ink: 7, paper: 7, bright: 1 }] }] };
    check('BRIGHT white is key 15 (the last palette entry) and shows as such', J(pixelAt(A.thumbSprite(bright, { box: 8 }), 0, 0)) === J([...S.keyRGB(15), 255]) && J(pixelAt(A.thumbSprite(bright, { box: 8, palette: palettes[1] }), 0, 0)) === J([...palettes[1][15].rgb, 255]));
  }

  // ---- tile sets ----
  {
    const mkTile = (colourRows) => { const base = { ink: ri(8), paper: ri(8), bright: ri(2) }; return { rows: Array.from({ length: 8 }, () => ({ bits: hex(0, 1), ...(colourRows ? { ink: ri(8), paper: ri(8), bright: ri(2) } : base) })), flags: 0 }; };
    let bad2 = 0, first = '', n = 0;
    for (const count of [1, 2, 3, 4, 5, 9, 17, 50, 127, 128, 129, 140]) for (const rowColours of [false, true]) {
      if (count > 128) { const big = { tiles: Array.from({ length: count }, () => mkTile(false)) }; if (!A.thumbTileset(big).placeholder) { bad2++; first ||= `${count} tiles are over the limit of a set (128): a placeholder expected`; } continue; }
      const asset = { tiles: Array.from({ length: count }, () => mkTile(rowColours)) };
      const set = T.fromAsset(asset);
      for (const box of [4, 16, 48, 100, 256]) for (const pal of palettes) for (const fine of [[undefined, true, false][n % 3]]) {
        n++;
        const n_ = set.tiles.length, cols = Math.min(16, Math.ceil(Math.sqrt(n_))), rows = Math.ceil(n_ / cols);
        const px = set.tiles.map((t) => Array.from(T.tilePixels(t, { fine: T.hasRowColours(t) }), (k) => colourOf(k, pal)));
        const ref = refRender(cols * 8, rows * 8, (x, y) => { const i = (y >> 3) * cols + (x >> 3); return i < n_ ? px[i][(y & 7) * 8 + (x & 7)] : -1; }, box);
        const got = A.thumbTileset(asset, { box, palette: pal, fine });
        if (!sameBytes(got, ref)) { bad2++; first ||= `${count} tiles rowColours ${rowColours} box ${box}: ${bad(got, ref)}`; }
      }
    }
    check(`thumbTileset equals the reference on ${n} (tile count 1..128, row colours or not, box, palette, opts.fine) cases; 129 tiles is a placeholder`, bad2 === 0, first);
    const t127 = { tiles: Array.from({ length: 128 }, (_, i) => ({ rows: Array.from({ length: 8 }, () => ({ bits: '00', ink: 0, paper: (i % 7) + 1, bright: 0 })), flags: 0 })) };
    const g = A.thumbTileset(t127, { box: 256 }), cols = 12, rows = 11;
    check('128 tiles: a 12 x 11 grid, the last tile (127) is drawn in its place and the cell after it is transparent, 16 columns at most', g.w === 12 * 8 * 2 && g.h === 11 * 8 * 2 && J(pixelAt(g, 7 * 16 + 4, 10 * 16 + 4)) === J([...S.keyRGB((127 % 7) + 1), 255]) && pixelAt(g, 8 * 16 + 4, 10 * 16 + 4)[3] === 0 && A.thumbTileset({ tiles: t127.tiles.slice(0, 17) }, { box: 256 }).w === 5 * 8 * 6 && cols * rows >= 128);
    check('opts.fine changes nothing (a map\'s ctx.fine neither): a tile with a colour of its own in each row is always drawn row by row, one without has the same colour in every row',
      (() => { const a = { tiles: [mkTile(true), mkTile(false)] }; return sameBytes(A.thumbTileset(a, { box: 32, fine: true }), A.thumbTileset(a, { box: 32, fine: false })) && sameBytes(A.thumbTileset(a, { box: 32 }), A.thumbTileset(a, { box: 32, fine: true })); })());
  }

  // ---- maps ----
  {
    const FP = [null, 13, 12, 9, 11];
    const mapEditorSrc = readFileSync(join(ROOT, 'src/tools/map-editor.js'), 'utf8');
    check('the floor plan colours are the map editor\'s own (FP_COLOURS, empty #14161c, odd code #7a3cff)', mapEditorSrc.includes('FP_COLOURS = [null, 13, 12, 9, 11]') && mapEditorSrc.includes("'#14161c'") && mapEditorSrc.includes("'#7a3cff'"));
    const BLANKC = rgbN([38, 42, 49]), UNDEF = rgbN([58, 29, 29]), EMPTY = rgbN([20, 22, 28]), ODD = rgbN([122, 60, 255]);
    const grey = (t) => { const v = Math.min(235, 85 + ((t * 37) % 120)); return (v << 16) | (v << 8) | v; };
    const mkTile = () => ({ rows: Array.from({ length: 8 }, () => ({ bits: hex(0, 1), ink: ri(8), paper: ri(8), bright: ri(2) })), flags: 0 });
    function refMap(asset, ctx, opts) {
      const m = M.fromAsset(asset), role = ctx?.role === 'world' || ctx?.role === 'floorplan' ? ctx.role : 'cell';
      const pal = opts.palette ?? ctx?.palette;
      let tiles = null;
      if (role !== 'floorplan' && ctx?.tileset) { try { tiles = T.fromAsset(ctx.tileset).tiles.map((t) => Array.from(T.tilePixels(t, { fine: T.hasRowColours(t) }), (k) => colourOf(k, pal))); } catch { tiles = null; } }
      const avg = tiles && tiles.map((px) => [16, 8, 0].map((sh) => Math.round(px.reduce((s, v) => s + ((v >> sh) & 255), 0) / 64))).map((c) => (c[0] << 16) | (c[1] << 8) | c[2]);
      const cellT = (v) => (v === -1 ? (role === 'world' ? 0 : null) : v);
      const flat = (v) => {
        if (role === 'floorplan') { const code = v < 0 ? 0 : v; return code === 0 ? EMPTY : code <= 4 ? rgbN(S.keyRGB(FP[code], pal)) : ODD; }
        const t = cellT(v);
        if (t === null) return BLANKC;
        if (!tiles) return grey(t);
        return t < tiles.length ? avg[t] : UNDEF;
      };
      const sw = m.w * 8, sh = m.h * 8, cellOut = 8 * (opts.box ?? 48) / Math.max(sw, sh);
      const useAvg = cellOut < 3 || role === 'floorplan' || !tiles;
      const out = refRender(sw, sh, (x, y) => {
        const v = m.cells[(y >> 3) * m.w + (x >> 3)];
        if (useAvg) return flat(v);
        const t = cellT(v);
        return t !== null && t < tiles.length ? tiles[t][(y & 7) * 8 + (x & 7)] : flat(v);
      }, opts.box ?? 48);
      if (role !== 'floorplan' && !tiles) out.noTileset = true;
      return out;
    }
    const tsets = [null, { tiles: Array.from({ length: 1 }, mkTile) }, { tiles: Array.from({ length: 5 }, mkTile) }, { tiles: Array.from({ length: 128 }, mkTile) }];
    const shapes = [[1, 1], [3, 2], [4, 4], [12, 12], [16, 4], [16, 16], [32, 24], [13, 7], [7, 13], [40, 3], [3, 40], [100, 1], [1, 100], [32, 32]];
    const boxes = [4, 12, 20, 36, 48, 64, 100];
    let cyc = 0;
    let bad3 = 0, first = '', n = 0;
    for (const [w, h] of shapes) for (const role of ['cell', 'world', 'floorplan', undefined, 'other']) for (const ts of tsets.filter((t) => !t || t.tiles.length < 128 || w * h <= 64)) {
      const cells = Array.from({ length: w * h }, () => { const r = rnd(); return r < 0.15 ? 255 : r < 0.25 ? 5 + ri(5) : r < 0.3 ? 0 : ri(role === 'floorplan' ? 6 : 8); });
      const asset = { w, h, cells };
      for (const box of boxes) for (const palIn of [['none', 'ctx', 'opts'][cyc++ % 3]]) {
        const pal = palettes[palIn === 'none' ? 0 : 1];
        const ctx = { tileset: ts, role, ...(palIn === 'ctx' ? { palette: pal } : {}) }, opts = { box, ...(palIn === 'opts' ? { palette: pal } : {}) };
        n++;
        const got = A.thumbMap(asset, ctx, opts), ref = refMap(asset, ctx, opts);
        if (!sameBytes(got, ref)) { bad3++; first ||= `${w}x${h} role ${role} tiles ${ts?.tiles.length ?? 0} box ${box} palette ${palIn}: ${bad(got, ref)}`; }
      }
    }
    check(`thumbMap equals the reference on ${n} (shape, role, tile set, box, palette in the context or in the options) cases, noTileset included`, bad3 === 0, first);
    const rcSet = { tiles: Array.from({ length: 3 }, () => ({ rows: Array.from({ length: 8 }, () => ({ bits: hex(0, 1), ink: ri(8), paper: ri(8), bright: ri(2) })), flags: 0 })) };
    const fm = { w: 3, h: 2, cells: [0, 1, 2, 1, 0, 255] };
    check('ctx.fine and opts.fine change nothing in a map either (a tile with a colour of its own in each row is always drawn row by row)', sameBytes(A.thumbMap(fm, { tileset: rcSet, fine: true }, { box: 48, fine: true }), A.thumbMap(fm, { tileset: rcSet, fine: false }, { box: 48 })) && colours(A.thumbMap(fm, { tileset: rcSet }, { box: 48 })).size > 3);
    // the decision between textured and flat cells is made on the size of one cell in the picture: exactly 3 pixels is textured, 2 is flat
    const ts1 = { tiles: [{ rows: Array.from({ length: 8 }, (_, y) => ({ bits: 'CC', ink: 2, paper: 5, bright: 0 })), flags: 0 }] };      // columns 0, 1, 4, 5 set: any 3 or 4 samples of a cell see both colours
    const textured = (w, h, box) => { const t = A.thumbMap({ w, h, cells: new Array(w * h).fill(0) }, { tileset: ts1 }, { box }); return colours(t).size > 1; };
    check('a cell of 3 pixels in the picture shows the tile\'s pixels, a cell of 2 pixels its average colour (one colour), a cell of 4 pixels the tile', textured(16, 4, 48) && !textured(16, 4, 32) && textured(16, 4, 64) && textured(12, 12, 36) && !textured(12, 12, 35));
    check('a floor plan with a tile set given is still the wall colours, and its wall codes 1..4 are the map editor\'s palette entries', J(pixelAt(A.thumbMap({ w: 5, h: 1, cells: [0, 1, 2, 3, 4] }, { role: 'floorplan', tileset: ts1 }, { box: 40 }), 9, 4)) === J([...S.keyRGB(13), 255]) &&
      [1, 2, 3, 4].every((c) => J(pixelAt(A.thumbMap({ w: 5, h: 1, cells: [0, 1, 2, 3, 4] }, { role: 'floorplan' }, { box: 40 }), c * 8 + 4, 4)) === J([...S.keyRGB(FP[c]), 255])) &&
      J(pixelAt(A.thumbMap({ w: 2, h: 1, cells: [0, 9] }, { role: 'floorplan' }, { box: 16 }), 12, 4)) === J([122, 60, 255, 255]) && J(pixelAt(A.thumbMap({ w: 2, h: 1, cells: [255, 0] }, { role: 'floorplan' }, { box: 16 }), 4, 4)) === J([20, 22, 28, 255]));
    const g1 = A.thumbMap({ w: 3, h: 1, cells: [1, 2, 254] }, {}, { box: 24 });
    check('without a tile set the cell of tile t is the grey 85 + (t * 37 mod 120)(t = 1: 122, t = 2: 159, t = 254: 85 + 38 = 123)', J(pixelAt(g1, 4, 4)) === J([122, 122, 122, 255]) && J(pixelAt(g1, 12, 4)) === J([159, 159, 159, 255]) && J(pixelAt(g1, 20, 4)) === J([123, 123, 123, 255]));
  }

  // ---- models: the standard integer line (Bresenham, both ends) over the preview's own segments ----
  {
    const { previewSegments } = await import('../src/tools/model-preview.js');
    const FG = [140, 200, 255], BG = [24, 28, 36];
    const refModel = (asset, box, fg = FG, bg = BG) => {
      const rgba = new Uint8ClampedArray(box * box * 4);
      for (let i = 0; i < box * box; i++) rgba.set([...bg, 255], i * 4);
      const st = { outside: 0, onEdge: 0, drawn: 0 };
      const set = (x, y) => { if (x < 0 || x >= box || y < 0 || y >= box) { st.outside++; return; } if (x === 0 || y === 0 || x === box - 1 || y === box - 1) st.onEdge++; st.drawn++; rgba.set([...fg, 255], (y * box + x) * 4); };
      for (const seg of previewSegments(asset, 0.6, box, box)) {
        if (!seg.every(Number.isFinite)) continue;
        let [x0, y0, x1, y1] = seg.map(Math.round);
        const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
        let err = dx - dy;
        for (;;) {
          set(x0, y0);
          if (x0 === x1 && y0 === y1) break;
          const e2 = 2 * err;
          if (e2 >= -dy) { err -= dy; x0 += sx; }        // ties step both axes (the module's own rule)
          if (e2 <= dx) { err += dx; y0 += sy; }
        }
      }
      return { img: { w: box, h: box, rgba }, ...st };
    };
    const models = [];
    const cube = (r) => ({ points: [[-r, -r, -r], [r, -r, -r], [r, r, -r], [-r, r, -r], [-r, -r, r], [r, -r, r], [r, r, r], [-r, r, r]], edges: [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]] });
    models.push(cube(20), cube(1), { points: [[0, 0, 0], [0, 40, 0]], edges: [[0, 1]] }, { points: [[-30, 0, 0], [30, 0, 0]], edges: [[0, 1]] }, { points: [[-30, -2, -30], [30, 3, 30]], edges: [[0, 1]] },
      { points: [[0, 0, -40], [0, 0, 40], [40, 0, 0], [-40, 0, 0]], edges: [[0, 1], [2, 3], [0, 2], [1, 3]] }, { points: [[1, 2, 3], [4, 5, 6], [1e300, 0, 0]], edges: [[0, 1], [1, 2]] });
    for (let i = 0; i < 40; i++) {
      const np = 2 + ri(8), pts = Array.from({ length: np }, () => [ri(80) - 40, ri(80) - 40, ri(80) - 40]), ne = 1 + ri(12);
      models.push({ points: pts, edges: Array.from({ length: ne }, () => [ri(np), ri(np)]) });
    }
    let bad4 = 0, first = '', n = 0, outsideTotal = 0, edgeTotal = 0, drawnTotal = 0;
    for (const model of models) for (const box of [4, 5, 9, 16, 36, 48, 100, 256]) for (const colours_ of [undefined, { fg: [250, 10, 20], bg: [1, 2, 3] }]) {
      n++;
      const ref = refModel(model, box, colours_?.fg, colours_?.bg), got = A.thumbModel(model, { box, ...(colours_ ?? {}) });
      outsideTotal += ref.outside; edgeTotal += ref.onEdge; drawnTotal += ref.drawn;
      const r = previewSegments(model, 0.6, box, box).length ? ref.img : A.placeholder(box);
      if (!sameBytes(got, r)) { bad4++; first ||= `box ${box} model ${J(model).slice(0, 60)}: ${bad(got, r)}`; }
    }
    check(`thumbModel equals the standard integer line over previewSegments(model, 0.6, box, box) on ${n} (model, box, colours) cases (${drawnTotal} pixels drawn)`, bad4 === 0, first);
    check('no line reaches the border of the box or leaves it (previewSegments keeps every end within 0.89 * (box / 2 - 2) of the centre), so the bounds test of the module\'s plot() is only a guard', edgeTotal === 0 && outsideTotal === 0, `${edgeTotal} border pixels, ${outsideTotal} outside`);
    const longLine = A.thumbModel({ points: [[-30, 0, 0], [30, 0, 0]], edges: [[0, 1]] }, { box: 256 });
    check('a long line (over 120 pixels) is drawn whole', Array.from(longLine.rgba).filter((_, i) => i % 4 === 0 && longLine.rgba[i] > 100).length > 120);
  }
}

console.log(`\n${failed ? failed + ' FAILED, ' : ''}${passed} passed`);
process.exit(failed ? 1 : 0);
