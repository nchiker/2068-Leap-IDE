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

console.log(`\n${failed ? failed + ' FAILED, ' : ''}${passed} passed`);
process.exit(failed ? 1 : 0);
