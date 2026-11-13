#!/usr/bin/env node
"use strict";
// orbit.assets.gen.mjs -- makes the assets of orbit.arc ("Orbit Gates", the wireframe 3D sample game of docs/ARCADE_WIREFRAME_CONTRACT.md section 9) and writes orbit.assets.json next to this file.
//   node arcade/examples/orbit.assets.gen.mjs            write orbit.assets.json
//   node arcade/examples/orbit.assets.gen.mjs --check    write nothing; exit 1 when orbit.assets.json is not what the generator makes (tests/arcade-orbit.mjs uses it)
// Deterministic (no random numbers: the same file every time).
//   models   gate  a flat octagon in the x-y plane: 8 points round(64 cos(k 45 deg)), round(64 sin(k 45 deg)), 0 and the 8 edges round it (drawn with SCALE 4: a radius of 256 world units)
//            gatefar  the same as a hexagon (6 points, 6 edges): the gate after the current one is drawn with it (it is 1500 or more units away, a few pixels wide: the swap to the octagon when it becomes the current gate is not seen)
//            rock  an octahedron, points at +-40 on each axis, the 12 edges between points that are not opposite (drawn with SCALE 2)
//            (a model editor is not in the contract: the models are written as code here, as the songs are, docs/ARCADE_WIREFRAME_CONTRACT.md section 4)
//            shards  the debris of a rock shot by the laser: 3 small separate triangles (9 points, 9 edges) around the origin, drawn with SCALE 1, 2, then 4 so that they spread
//   sprite   burst  16 x 16, one phase: a starburst, SHOWn over the play area when a rock hits (a sprite is drawn over the lines)
//   tiles    gfx  0 empty, 1-2 stars, 3..18 the title's ring logo (a 4 x 4 block of tiles: two octagons, one in the other)
//   sound    chime (a gate passed), buzz (a gate missed / out of fuel), crash (a rock hit the ship), zap (the laser), boom (a rock shot)
//   music    theme  the title song (A minor, original; written with songs.mjs)
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pattern, song, describe } from './songs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ── models ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const gate = {
  points: Array.from({ length: 8 }, (_, k) => [Math.round(64 * Math.cos(k * Math.PI / 4)), Math.round(64 * Math.sin(k * Math.PI / 4)), 0]),
  edges: Array.from({ length: 8 }, (_, k) => [k, (k + 1) % 8]),
};
// the next gate, far ahead and small on the screen: a hexagon (6 points: a gate costs about 5,500 T a point on the real runtime)
const gatefar = {
  points: Array.from({ length: 6 }, (_, k) => [Math.round(64 * Math.cos(k * Math.PI / 3)), Math.round(64 * Math.sin(k * Math.PI / 3)), 0]),
  edges: Array.from({ length: 6 }, (_, k) => [k, (k + 1) % 6]),
};
const rock = {
  points: [[40, 0, 0], [-40, 0, 0], [0, 40, 0], [0, -40, 0], [0, 0, 40], [0, 0, -40]],
  edges: [[0, 2], [0, 3], [0, 4], [0, 5], [1, 2], [1, 3], [1, 4], [1, 5], [2, 4], [2, 5], [3, 4], [3, 5]],
};
// three fragments, each a small triangle whose middle is 28 units out along one of the corners of a cube; the triangles differ in the way they face
const CORNERS = [[1, 1, 1], [-1, -1, 1], [-1, 1, -1]];
const TRI = [[[12, -6, 0], [-6, 12, 6], [-6, -6, -12]], [[0, 12, -6], [6, -6, 12], [-12, -6, -6]], [[-6, 0, 12], [12, 6, -6], [-6, -12, -6]], [[6, -12, 0], [-12, 6, 6], [6, 6, -12]]];
const shards = { points: [], edges: [] };
CORNERS.forEach((c, k) => {
  const base = shards.points.length;
  for (const t of TRI[k]) shards.points.push([28 * c[0] + t[0], 28 * c[1] + t[1], 28 * c[2] + t[2]]);
  shards.edges.push([base, base + 1], [base + 1, base + 2], [base + 2, base]);
});
if (shards.points.length !== 9 || shards.edges.length !== 9 || shards.points.some((p) => p.some((c) => Math.abs(c) > 64))) throw new Error('shards check');
if (gate.points.some((p) => p.some((c) => Math.abs(c) > 64)) || gate.edges.length !== 8 || rock.edges.length !== 12) throw new Error('model check');

// ── the flash sprite and the tiles ──────────────────────────────────────────────────────────────────────────────────────────────
const FLASH = ['.......##.......', '.......##.......', '..#....##....#..', '...#...##...#...', '....#..##..#....', '.....#.##.#.....', '......####......', '###############.',
  '.###############', '......####......', '.....#.##.#.....', '....#..##..#....', '...#...##...#...', '..#....##....#..', '.......##.......', '.......##.......'];
if (FLASH.length !== 16 || FLASH.some((r) => r.length !== 16)) throw new Error('flash is not 16 x 16');

function sprite(rows, { hot, phases, ink = 7, paper = 0, bright = 0 }) {
  const h = rows.length, w = rows[0].length;
  const hex = (v) => v.toString(16).toUpperCase().padStart(w / 4, '0');
  const outRows = rows.map((r) => {
    let bits = 0, mask = 0;
    for (const ch of r) { bits <<= 1; mask <<= 1; if (ch === '#') { bits |= 1; mask |= 1; } else if (ch === '-') mask |= 1; }
    return { bits: hex(bits), mask: hex(mask), ink, paper, bright };
  });
  return { w, h, frames: [{ rows: outRows }], hot, phases };
}
const tileRows = (bytes, ink, paper = 0, bright = 0) => ({ rows: bytes.map((b) => ({ bits: b.toString(16).toUpperCase().padStart(2, '0'), ink, paper, bright })), flags: 0 });

// the ring logo: two octagons (vertices at k 45 degrees, radius 15 and 9 about the middle of a 32 x 32 block) drawn with a small Bresenham
const logo = Array.from({ length: 32 }, () => Array(32).fill(0));
function plot(x, y) { if (x >= 0 && x < 32 && y >= 0 && y < 32) logo[y][x] = 1; }
function line(x0, y0, x1, y1) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    plot(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}
for (const r of [15, 9]) {
  const v = Array.from({ length: 8 }, (_, k) => [Math.round(15.5 + r * Math.cos(k * Math.PI / 4)), Math.round(15.5 + r * Math.sin(k * Math.PI / 4))]);
  for (let k = 0; k < 8; k++) line(...v[k], ...v[(k + 1) % 8]);
}
const logoTile = (tx, ty) => Array.from({ length: 8 }, (_, r) => parseInt(logo[ty * 8 + r].slice(tx * 8, tx * 8 + 8).join(''), 2));
const tiles = [
  tileRows([0, 0, 0, 0, 0, 0, 0, 0], 7, 0, 0),                  // 0 empty (black)
  tileRows([0, 0, 0, 0, 0x08, 0, 0, 0], 7, 0, 0),               // 1 star
  tileRows([0, 0x10, 0x38, 0x10, 0, 0, 0, 0], 7, 0, 0),         // 2 bright star
];
for (let ty = 0; ty < 4; ty++) for (let tx = 0; tx < 4; tx++) tiles.push(tileRows(logoTile(tx, ty), 5, 0, 0));    // 3 + ty * 4 + tx

// ── sound ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ticks = (n, f) => Array.from({ length: n }, (_, k) => f(k));
const sfx = {
  chime: { ticks: ticks(15, (k) => ({ tone: [240, 190, 150, 120, 95][Math.floor(k / 3)], vol: 14 - (k % 3) * 2, noise: 0, mix: 6 })) },
  buzz: { ticks: ticks(14, (k) => ({ tone: 620 + (k % 2 ? 50 : 0), vol: 13 - Math.floor(k / 4), noise: 0, mix: 6 })) },
  zap: { ticks: ticks(6, (k) => ({ tone: 60 + 50 * k, vol: 14 - k, noise: k < 2 ? 6 : 0, mix: k < 2 ? 4 : 6 })) },
  boom: { ticks: ticks(20, (k) => ({ tone: 300 + 25 * k, vol: Math.max(0, 15 - Math.floor(k * 0.75)), noise: Math.min(31, 3 + k), mix: k < 8 ? 4 : 5 })) },
  crash: { ticks: ticks(16, (k) => ({ tone: 400 + 40 * k, vol: Math.max(0, 15 - k), noise: Math.min(31, 4 + 2 * k), mix: k < 5 ? 4 : 5 })) },
};

// ── the title song (docs/ARCADE_MUSIC_CONTRACT.md section 8; original): A minor, a quaver = 8 refreshes, bars of 64; two four-bar patterns, looped
const DRUMS = 'C2:4 -:12 G5:4 -:12 C2:4 -:4 C2:4 -:4 G5:4 -:12';
const bars = (s, n) => Array(n).fill(s).join(' | ');
const music = {
  theme: song([
    pattern({
      A: '@organ !11 L8 | A4:16 E5:16 A5:16 G5:16 | F5:16 E5:16 C5:32 | D5:16 A4:16 D5:16 F5:16 | E5:32 -:8 E5 D5 E5',
      B: '@bass !11 L16 | A2 A3 A2 A3 | F2 F3 F2 F3 | D2 D3 D2 D3 | E2 E3 E2 E3',
      C: '@drum !9 ' + bars(DRUMS, 4),
    }, 'launch'),
    pattern({
      A: '@organ !12 L8 | A5:16 G5:16 E5:16 C5:16 | F5:16 A5:16 G5:32 | F5:16 E5:16 D5:16 C5:16 | E5:48 -:16',
      B: '@bass !11 L16 | A2 A3 C3 A3 | F2 F3 A2 F3 | D2 D3 F2 D3 | E2 E3 B2 E3',
      C: '@drum !9 ' + bars(DRUMS, 4),
    }, 'orbit'),
  ], [0, 1, 0, 1], 0),
};

const assets = {
  sprites: { burst: sprite(FLASH, { hot: [0, 0, 16, 16], phases: 1, ink: 6 }) },
  tilesets: { gfx: { tiles } },
  models: { gate, gatefar, rock, shards },
  sfx,
  maps: {},
  music,
};
const out = join(HERE, 'orbit.assets.json'), text = JSON.stringify(assets, null, 1) + '\n';
if (process.argv.includes('--check')) {
  const same = existsSync(out) && readFileSync(out, 'utf8') === text;
  console.log(same ? 'orbit.assets.json is up to date' : 'orbit.assets.json is OUT OF DATE: run node arcade/examples/orbit.assets.gen.mjs');
  process.exit(same ? 0 : 1);
}
writeFileSync(out, text);
console.log(`orbit.assets.json: ${Object.keys(assets.models).length} models (gate ${gate.points.length} points / ${gate.edges.length} edges, rock ${rock.points.length} / ${rock.edges.length}, gatefar ${gatefar.points.length} / ${gatefar.edges.length}, shards ${shards.points.length} / ${shards.edges.length}), 1 sprite, ${tiles.length} tiles, ${Object.keys(sfx).length} sound effects; ${Object.entries(music).map(([k, v]) => describe(k, v)).join('; ')}`);
