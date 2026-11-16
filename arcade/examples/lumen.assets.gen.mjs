#!/usr/bin/env node
"use strict";
// lumen.assets.gen.mjs -- draws the art of lumen.arc (the fine-colour showcase game, a maze chase) and writes lumen.assets.json next to this file.
//   node arcade/examples/lumen.assets.gen.mjs
// Every scene is 8 x 1 colour (docs/ARCADE_FINE_COLOUR_CONTRACT.md): the maze walls are tubes shaded row by row, the orbs glow white -> yellow -> red,
// the sprites are shaded per pixel row (a sprite's colour in a fine scene is the INK of each of its rows over the background's paper).
// The maze is 16 x 11 blocks of 16 x 16 pixels (cell rows 1..22; rows 0 and 23 are the HUD); a sprite stands on one block.  Block (bx, by) is the
// cells (2 bx, 1 + 2 by) .. (2 bx + 1, 2 + 2 by), a sprite on it is at x = 16 bx, y = 8 + 16 by.  The two mazes alternate (odd caves rainbow tubes,
// even caves ice tubes: owner's choice, 2026-11-15).
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { picture, set, get, text, tiler } from './fineart.mjs';
import { pattern, song, describe } from './songs.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const mirror = (half) => half + [...half].reverse().join('');

// ── the mazes: '#' wall, '.' an orb, 'o' a prism, ' ' empty floor, '=' the lair's door (a wall to the wisp, open to the shades), 'L' the lair
// (left halves, mirrored)
export const MAZES = [
  ['########', '#o.....#', '#.##.#.#', '#.#..#..', '#.#.###=', '#.....#L', '#.##.###', '#.#.... ', '#...#.#.', '#o#.....', '########'],
  ['########', '#o......', '#.###.##', '#...#...', '###.#.#=', '#.....#L', '#.#.#.##', '#.#.#.. ', '#...#.#.', '#o#.....', '########'],
].map((m) => m.map(mirror));
export const START = [7, 7];                 // the wisp's block (an empty floor block in both mazes); the shades start in the lair (blocks 7, 8 of row 5)
// every orb and prism can be reached from the start, and the lair through its door from the block above it
MAZES.forEach((m, i) => {
  const seen = new Set([START.join()]), todo = [START];
  while (todo.length) {
    const [x, y] = todo.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = (x + dx + 16) % 16, ny = y + dy, ch = m[ny]?.[nx];
      if (ch === undefined || ch === '#' || ch === '=' || ch === 'L' || seen.has(`${nx},${ny}`)) continue;
      seen.add(`${nx},${ny}`); todo.push([nx, ny]);
    }
  }
  m.forEach((row, y) => [...row].forEach((ch, x) => { if ((ch === '.' || ch === 'o') && !seen.has(`${x},${y}`)) throw new Error(`maze ${i + 1}: block (${x}, ${y}) cannot be reached`); }));
  if (m[START[1]][START[0]] !== ' ' || m[4][7] !== '=' || m[4][8] !== '=' || m[5][7] !== 'L' || m[5][8] !== 'L' || m[3][7] === '#' || m[3][8] === '#') throw new Error(`maze ${i + 1}: start or lair misplaced`);
});
export const ORBS = MAZES.map((m) => m.join('').split('').filter((c) => c === '.').length);

// ── wall tubes: a wall block draws a tube 10 pixels thick (block pixels 3..12) joined to the wall blocks next to it.  A horizontal run is shaded
// row by row (lit from above); a vertical run is lit on its left half.  PALETTES: the colour of the tube's ten rows, top to bottom, one per maze.
export const PALETTES = [
  { name: 'rainbow', rows: [7, 6, 5, 5, 4, 3, 3, 2, 1, 1], left: 5, right: 1 },
  { name: 'ice', rows: [7, 7, 5, 5, 5, 5, 1, 1, 1, 1], left: 5, right: 1 },
];
function paintMaze(pic, maze, pal) {
  const wall = (bx, by) => by >= 0 && by < 11 && bx >= 0 && bx < 16 && (maze[by][bx] === '#' || maze[by][bx] === '=');
  for (let by = 0; by < 11; by++) for (let bx = 0; bx < 16; bx++) {
    const ch = maze[by][bx], x0 = 16 * bx, y0 = 8 + 16 * by;
    if (ch === '#') {
      const L = wall(bx - 1, by), R = wall(bx + 1, by), U = wall(bx, by - 1), D = wall(bx, by + 1);
      for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
        const inH = y >= 3 && y <= 12 && (x >= 3 && x <= 12 || (L && x < 3) || (R && x > 12));
        const inV = x >= 3 && x <= 12 && ((U && y < 3) || (D && y > 12));
        if (!inH && !inV) continue;
        const horiz = inH && (L || R || !(U || D));          // a horizontal run (or a lone block) is shaded by row, a vertical one by side
        const c = horiz ? pal.rows[y - 3] : (x < 8 ? pal.left : pal.right);
        set(pic, x0 + x, y0 + y, c);
      }
    } else if (ch === '=') {
      for (let x = 0; x < 16; x++) for (const y of [7, 8]) set(pic, x0 + x, y0 + y, y === 7 ? 3 : 2);   // the lair's door: a two-row magenta / red bar
    } else if (ch === '.') {
      ORB.forEach((row, k) => [...row].forEach((p, j) => { if (p === '#') set(pic, x0 + 6 + j, y0 + 6 + k, ORB_INK[k]); }));
    } else if (ch === 'o') {
      PRISM.forEach((row, k) => [...row].forEach((p, j) => { if (p === '#') set(pic, x0 + 3 + j, y0 + 3 + k, PRISM_INK[k]); }));
    }
  }
}
// an orb: 4 x 4 pixels at the block's centre (so it falls on four cells), white -> yellow -> red; a prism: 10 x 10, a rainbow diamond
const ORB = ['.##.', '####', '####', '.##.'], ORB_INK = [7, 6, 6, 2];
const PRISM = ['....##....', '...####...', '..######..', '.########.', '##########', '##########', '.########.', '..######..', '...####...', '....##....'];
const PRISM_INK = [7, 7, 6, 6, 5, 4, 3, 3, 2, 1];

// ── sprites (16 x 16; '#' ink, '-' covered paper, '.' transparent; drawn as the left half and mirrored), 4 phases each (2-pixel steps)
// the wisp: a ball of light with a flickering crown, two frames
const WISP_A = ['......#.', '...#..##', '....####', '..#.####', '...#####', '..######', '.#######', '.#######', '.#######', '.#######', '..######', '..######', '...#####', '....####', '......##', '........'];
const WISP_B = ['....#...', '.....#.#', '...#.###', '....####', '...#####', '..######', '.#######', '.#######', '.#######', '.#######', '..######', '..######', '...#####', '....####', '......##', '........'];
const WISP_INK = [6, 6, 6, 6, 7, 7, 7, 7, 7, 5, 5, 5, 5, 1, 1, 1];
// a shade: a horned mask with a ragged hem and two eye holes (the paper shows through them)
const SHADE = ['.#......', '.##.....', '..##.###', '..######', '..######', '.#######', '.##--###', '.##--###', '.#######', '.#######', '.#######', '.#######', '.##.####', '.#..##.#', '.#...#..', '........'];
const SHADE_INKS = {
  ember: [6, 6, 6, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1],
  bloom: [7, 7, 7, 3, 3, 3, 3, 3, 3, 3, 3, 3, 1, 1, 1, 1],
  moss: [6, 6, 6, 4, 4, 4, 4, 4, 4, 4, 4, 4, 1, 1, 1, 1],
  frost: [7, 7, 7, 5, 5, 5, 5, 5, 5, 5, 5, 5, 1, 1, 1, 1],
};
const PALE = [7, 7, 7, 7, 7, 7, 5, 5, 5, 5, 5, 5, 1, 1, 1, 1];          // a shade that flees (the burst of a prism)

function sprite(rows, { hot, phases = 4, inks }) {
  const h = rows.length, w = rows[0].length;
  const hex = (v) => v.toString(16).toUpperCase().padStart(w / 4, '0');
  const outRows = rows.map((r, k) => {
    let bits = 0, mask = 0;
    for (const ch of r) { bits <<= 1; mask <<= 1; if (ch === '#') { bits |= 1; mask |= 1; } else if (ch === '-') mask |= 1; }
    return { bits: hex(bits), mask: hex(mask), ink: inks[k], paper: 0, bright: 0 };
  });
  return { w, h, frames: [{ rows: outRows }], hot, phases };
}
const S = (half) => half.map(mirror);
const sprites = {
  wispa: sprite(S(WISP_A), { hot: [3, 3, 10, 10], inks: WISP_INK }),
  wispb: sprite(S(WISP_B), { hot: [3, 3, 10, 10], inks: WISP_INK }),
  ...Object.fromEntries(Object.entries(SHADE_INKS).map(([k, inks]) => [k, sprite(S(SHADE), { hot: [3, 3, 10, 10], inks })])),
  pale: sprite(S(SHADE), { hot: [3, 3, 10, 10], inks: PALE }),
};

// ── tiles and maps.  The program tells blocks apart by the tile of a block's top-left cell (TILEAT), so the first tiles are fixed:
//    0 the floor, 1..4 an orb's four cells (TL, TR, BL, BR), 5..8 a prism's, 9 / 10 the lair door's top / bottom cells, and every tile from
//    TWALL = 11 on is a wall (the top-left cell of a wall block always holds part of its tube).  lumen.arc's CONSTs say the same; checked below.
const tiles0 = [{ rows: Array.from({ length: 8 }, () => ({ bits: '00', ink: 7, paper: 0, bright: 0 })), flags: 0 }];
const T = tiler(tiles0);
{
  const pic = picture();
  paintMaze(pic, ['.o=#############', ...Array(10).fill('################')], PALETTES[0]);
  const orb = T.add(pic, 1, 0, 2, 2), prism = T.add(pic, 1, 2, 2, 2), door = T.add(pic, 1, 4, 2, 2);
  const want = [[orb, [1, 2, 3, 4]], [prism, [5, 6, 7, 8]], [door, [9, 9, 10, 10]]];
  for (const [got, w] of want) if (got.join() !== w.join()) throw new Error(`fixed tiles: got ${got} for ${w}`);
}
export const TWALL = 11;
const maps = {};
MAZES.forEach((m, i) => {
  const pic = picture();
  paintMaze(pic, m, PALETTES[i]);
  const cells = [...new Array(32).fill(0), ...T.add(pic, 1, 0, 22, 32), ...new Array(32).fill(0)];
  // every wall block's top-left cell is a wall tile, and nothing else is
  for (let by = 0; by < 11; by++) for (let bx = 0; bx < 16; bx++) {
    const t = cells[(1 + 2 * by) * 32 + 2 * bx], ch = m[by][bx];
    const ok = ch === '#' ? t >= TWALL : ch === '.' ? t === 1 : ch === 'o' ? t === 5 : ch === '=' ? t === 9 : t === 0;
    if (!ok) throw new Error(`maze ${i + 1} block (${bx}, ${by}) '${ch}': top-left tile ${t}`);
  }
  maps[`maze${i + 1}`] = { w: 32, h: 24, cells };
});
// the floor under an orb or a prism: the four cells of a block with nothing on them are tile 0
const RAINBOW = [7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 2, 2, 3, 3, 1, 1];
const GRADE = [6, 6, 6, 6, 2, 2, 2, 2];
function textMap(str, colourOf, opts = {}) {
  const pic = picture(), s = opts.scale ?? 1;
  text(pic, str, 0, 8, colourOf, opts);
  return { w: str.length * s, h: s, cells: T.add(pic, 1, 0, s, str.length * s) };
}
maps.logo = textMap('LUMEN', (py) => RAINBOW[py], { scale: 2, bold: true });
maps.press = textMap('PRESS FIRE TO PLAY', (py) => GRADE[py]);
maps.over = textMap('GAME OVER', (py) => RAINBOW[py], { scale: 2, bold: true });
if (T.count > 128) throw new Error(`${T.count} tiles: at most 128`);

// ── sound effects (the three-channel format of shooter.assets.gen.mjs: one tone and/or noise a refresh) and music (original; docs/ARCADE_MUSIC_CONTRACT.md section 8).
const ticks = (n, f) => Array.from({ length: n }, (_, k) => f(k));
const sfx = {
  orb: { ticks: ticks(4, (k) => ({ tone: 210 - 36 * k, vol: 12 - k, noise: 0, mix: 6 })) },                               // a short rising chirp
  prism: { ticks: ticks(16, (k) => ({ tone: 320 - 15 * k, vol: 13 - Math.floor(k / 3), noise: 0, mix: 6 })) },            // a long rising sweep
  gulp: { ticks: ticks(12, (k) => ({ tone: 110 + 22 * k, vol: 13 - Math.floor(k / 2), noise: k < 3 ? 8 : 0, mix: k < 3 ? 4 : 6 })) },   // a shade sent back: falling, with a click
  lost: { ticks: ticks(24, (k) => ({ tone: 90 + 12 * k + (k % 3 ? 0 : 40), vol: Math.max(2, 14 - Math.floor(k / 2)), noise: 0, mix: 6 })) },
  clear: { ticks: ticks(20, (k) => ({ tone: [250, 200, 166, 125, 100][Math.floor(k / 4)], vol: 13 - (k % 4), noise: 0, mix: 6 })) },   // a rising arpeggio
  over: { ticks: ticks(26, (k) => ({ tone: 140 + 17 * k, vol: Math.max(2, 13 - Math.floor(k / 2)), noise: 0, mix: 6 })) },
};
// A minor, a quaver on the title = 12 refreshes (bars of 96), in the play song 8 refreshes (bars of 64).
//   drip   the title: a pluck melody over a slow bass, a drum drop now and then (two patterns, looped)
//   cave   the play scene: an organ pulse on B, a held or slow tune on A; C is left for the effects
const bars = (s, n) => Array(n).fill(s).join(' | ');
const PULSE = (lo, hi) => `${lo} ${hi} `.repeat(4).trim();
const CAVE_B = `@organ !10 L8 | ${PULSE('A1', 'A2')} | ${PULSE('F1', 'F2')} | ${PULSE('D1', 'D2')} | ${PULSE('E1', 'E2')}`;
const music = {
  drip: song([
    pattern({
      A: '@pluck !12 L12 | A4 C5 E5 C5 B4 - G4 - | A4 C5 E5 A5 G5 E5 D5 - | F4 A4 C5 A4 G4 B4 D5 B4 | E5 - D5 - C5 - B4 -',
      B: '@bass !11 L48 | A1 E2 | A1 E2 | F1 C2 | E1 B1',
      C: '@drum !9 ' + bars('C2:6 -:42 G5:6 -:42', 4),
    }, 'drip'),
    pattern({
      A: '@pluck !12 L12 | A5 - E5 - C5 - E5 - | D5 - F5 - A5 - F5 - | E5 - G#4 - B4 - E5 - | A4:48 -:48',
      B: '@bass !11 L48 | A1 E2 | D2 A2 | E2 B2 | A1:96',
      C: '@drum !9 ' + bars('C2:6 -:42 G5:6 -:42', 4),
    }, 'answer'),
  ], [0, 1], 0),
  cave: song([
    pattern({ A: '@organ !9 L32 | E4 C4 | D4 B3 | C4 A3 | B3 G#3', B: CAVE_B }, 'pulse'),
    pattern({ A: '@organ !11 L16 | A4 C5 E5:32 | D5 C5 B4:32 | A4 B4 C5 D5 | E5:32 G#4:32', B: CAVE_B }, 'tune'),
    pattern({ A: '@organ !11 L16 | C5 E5 A5:32 | F5 E5 D5:32 | C5 D5 E5 F5 | E5:32 B4:32', B: CAVE_B }, 'tune up'),
  ], [0, 1, 0, 2], 0),
};

const assets = {
  scenes: { title: { display: 'fine' }, play: { display: 'fine' }, over: { display: 'fine' } },
  sprites,
  tilesets: { gfx: { tiles: T.tiles } },
  sfx,
  maps,
  music,
};
const json = JSON.stringify(assets, null, 1) + '\n';
// what lumen.arc repeats by hand: the fixed tile numbers (the test imports MAZES, START, ORBS, TWALL from here)
const ARC = join(HERE, 'lumen.arc');
function checkArc() {
  if (!existsSync(ARC)) return [];
  const text = readFileSync(ARC, 'utf8'), bad = [];
  const want = { TORB: 1, TPRISM: 5, TDOOR: 9, TWALL, STARTX: 16 * START[0], STARTY: 8 + 16 * START[1] };
  for (const [k, v] of Object.entries(want)) {
    const m = new RegExp(`^\\s*CONST ${k} = (\\d+)`, 'm').exec(text);
    if (!m || Number(m[1]) !== v) bad.push(`lumen.arc: CONST ${k} should be ${v}${m ? `, is ${m[1]}` : ' (missing)'}`);
  }
  return bad;
}
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const OUT = process.env.OUT ?? join(HERE, 'lumen.assets.json');
  if (process.argv.includes('--check')) {
    const bad = checkArc();
    if (!existsSync(OUT) || readFileSync(OUT, 'utf8') !== json) bad.push('lumen.assets.json is out of date: node arcade/examples/lumen.assets.gen.mjs');
    if (bad.length) { console.error(bad.join('\n')); process.exit(1); }
    console.log('lumen.assets.json is current; lumen.arc agrees with the generator');
  } else {
    writeFileSync(OUT, json);
    console.log(`lumen.assets.json: ${Object.keys(sprites).length} sprites (${Object.values(sprites).reduce((n, s) => n + s.phases, 0)} phases), ${T.count} tiles, ${Object.keys(sfx).length} effects, ${Object.keys(maps).length} maps; ${Object.entries(music).map(([k, v]) => describe(k, v)).join('; ')}`);
    const bad = checkArc();
    if (bad.length) console.log('NOTE (lumen.arc to be updated):\n' + bad.join('\n'));
  }
}
