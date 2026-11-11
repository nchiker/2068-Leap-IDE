"use strict";
// m8-runtime.mjs -- runtime v4 (the raycaster), pictures and boot, against the JS reference of m8-common.mjs (written from
// docs/ARCADE_RAYCASTER_CONTRACT.md and the "As built" rules, not from the Z80 sources).  On TSRun with the stock ROMs.
//  1. runtime.json (version 4, the contract's constants and routines), the size, the memory map;
//  2. boot: ray mode and its refusals, the tables, the map loader (RLE variants, clamps, the ring), the window's attributes in both files;
//  3. walls: >= 200 poses per column width (random maps 16 x 16 .. 32 x 32 and the spike's; fractions of exactly 0, axis-aligned angles and every angle
//     at one place, 0.2 cells from a wall, long corridors, rays parallel to an axis), both display files, bitmap preloaded with garbage: the window equals
//     the reference, everything else unchanged, the ray arrays equal;
//  4. billboards: dense random scenes (sizes 8..48, frames and the frame clamp, behind the viewer, at the view's edges, outside the map, overlapping,
//     hidden behind walls) against the reference column scaler, BB_TAB;
//  5. whole games: VIEW / SHOW / HIDE / SETWALL / HUD text and tiles (also into the window) at frame_div 1..3, the picture after every refresh.
//   node arcade/tests/m8-runtime.mjs        (M8_QUICK=1: shorter)
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as R from './m8-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { makeChecks, rd8, rd16, op, hex } = R;

const QUICK = !!process.env.M8_QUICK;
const { check, finish } = makeChecks();
const rt = R.runtime(), S = rt.syms;
console.log('Runtime v4: the raycaster, pictures and boot (stock TS2068, TSRun)\n');

// ==================================================================================================================
console.log('1. runtime.json, size, memory map');
{
  const json = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '../build/v4/runtime.json'), 'utf8'));
  const K = json.constants, Y = json.symbols;
  check('runtime.json: version 4; DIV_VIEW $40, WORLD_RAM $EA00, BB_TAB $E100 (BB_ENT 4), GAME_VARS $E200-$E9FF, MAX_FRAMES 32, SPR_ENT 8, SPR_FRAME_OFF 6, VIEW_W 128, VIEW_H 96',
    json.version === 4 && K.DIV_VIEW === 0x40 && K.WORLD_RAM === 0xEA00 && K.BB_TAB === 0xE100 && K.BB_ENT === 4 && K.GAME_VARS_BASE === 0xE200 &&
    K.GAME_VARS_LIMIT === 0xE9FF && K.MAX_FRAMES === 32 && K.SPR_ENT === 8 && K.SPR_FRAME_OFF === 6 && K.VIEW_W === 128 && K.VIEW_H === 96);
  const routines = ['RT_VIEW', 'RT_COSA', 'RT_SINA', 'RT_FXMUL', 'RT_WALL', 'RT_SETWALL', 'RT_SHOW', 'RT_SHOWF', 'RT_HIDE', 'RT_HIT', 'RT_ARGS', 'RA_X', 'RA_Y', 'RA_V'];
  check('runtime.json lists the routines of contract section 2 (and keeps the v3 ones; no RT_CAMERA / RT_TILEHIT)', routines.every((k) => Y[k] !== undefined || K[k] !== undefined) &&
    Y.RT_CAMERA === undefined && Y.RT_TILEHIT === undefined && Y.RT_PRINTS !== undefined && Y.RT_STICK !== undefined, routines.filter((k) => Y[k] === undefined && K[k] === undefined).join(','));
  const used = rt.usage.per[0] + rt.usage.per[1];
  check(`the runtime fits DOCK chunks 0-1: ${used} of 16,384 bytes (ray module ${rt.usage.mods.find((m) => m.name === 'ray').size} bytes)`, S.RT_END <= 0x4000 && used <= 16384);
  check('memory map: tables in the former pool A ($C080-$CDFF), BREC in WORLD_RAM after the map, DIST in POOL_B, the RAM routines in $5B00-$5FFF, V4VARS below $E1C0',
    S.RAY_PATM >= 0xC080 && S.RAY_HHR + 0x80 <= 0xCE00 && S.RAY_HGT + 1536 <= S.RAY_HHR && S.RAY_BREC >= S.MAP_RAM + 0x400 && S.RAY_BREC + 0x100 <= 0xF200 &&
    S.RAY_DISTL >= 0xF200 && S.RAY_BCODE + S.RAY_BCODE_LEN <= S.RAY_DISTL && S.RAY_RAM === 0x5B00 && S.RAY_MUL_END <= 0x6000 && S.R4_END <= 0xE1C0);
}

// ==================================================================================================================
console.log('\n2. Boot: ray mode, tables, the map loader, attributes');
{
  const r = rng(801);
  const cells = R.randomCells(r, 20, 13);
  const g = R.rayGame({ view: { colw: 4, mw: 20, mh: 13, cells, top: 0x45, bottom: 0x0E } });
  const m = R.bootIdle(g, 4);
  check('DIV_EXT | DIV_VIEW and a valid view_desc: ray mode; colw 4 = 32 rays, 2 a byte; map 20 x 13', rd8(m, S.V_RAY) === 1 && rd8(m, S.VD_COLW) === 4 && rd8(m, S.VD_NRAY) === 32 &&
    rd8(m, S.VD_RPB) === 2 && rd8(m, S.VD_MAPW) === 20 && rd8(m, S.VD_MAPH) === 13 && rd16(m, S.VD_XMAX) === 20 * 256 - 1 && rd16(m, S.VD_YMAX) === 13 * 256 - 1);
  let bad = 0;
  for (let a = 0; a < 256; a++) if (R.s16(rd16(m, S.RAY_COS + 2 * a)) !== R.COS[a]) bad++;
  check('the cosine table: C[a] of the contract (Q mirrored), all 256', bad === 0, `${bad} differ`);
  bad = 0;
  for (let n = 0; n < 512; n++) if (rd16(m, S.RAY_RECIP + 2 * n) !== R.RECIP[n]) bad++;
  check('the reciprocal table: min(65535, floor(65536 / n)), n = 0..511', bad === 0, `${bad} differ`);
  bad = 0;
  for (let i = 0; i < 1536; i++) if (rd8(m, S.RAY_HGT + i) !== R.HGT[i]) bad++;
  check('the height table: 48 up to i = 32, then floor(1536 / i), 1,536 entries', bad === 0, `${bad} differ`);
  const exp = R.loadMap(R.rleEncode(cells), 20, 13);
  bad = 0;
  for (let i = 0; i < 1024; i++) if (rd8(m, S.MAP_RAM + i) !== exp[i]) bad++;
  check('the map: 20 x 13 cells at stride 32, the rest of the 32 x 32 array type 1', bad === 0 && rd8(m, S.MAP_RAM + 13 * 32 + 5) === 1 && rd8(m, S.MAP_RAM + 2 * 32 + 25) === 1, `${bad} differ`);
  let attrOk = true;
  for (const base of [0x5800, 0x7800]) for (let cy = 0; cy < 24; cy++) for (let cx = 0; cx < 32; cx++) {
    const inWin = cy >= 6 && cy < 18 && cx >= 8 && cx < 24, v = rd8(m, base + cy * 32 + cx);
    if (inWin ? v !== (cy < 12 ? 0x45 : 0x0E) : v !== 0x38) attrOk = false;
  }
  check('the 192 window cells of both display files: attr_top in rows 6-11, attr_bottom in rows 12-17; the other cells BG_ATTR', attrOk);
  const pat = [0x81, 0x18, 0xF0, 0x0F, 0x3C, 0xC3, 0x55, 0xAA, 0x11, 0x22, 0x44, 0x88, 0x01, 0x80, 0x7E, 0xE7];
  const g2 = R.rayGame({ view: { colw: 2, mw: 8, mh: 8, cells: R.randomCells(r, 8, 8), patterns: pat } });
  const m2 = R.bootIdle(g2, 4);
  bad = 0;
  for (let p = 0; p < 4; p++) for (let pi = 0; pi < 8; pi++) for (let k = 0; k < 2; k++) if (rd8(m2, S.RAY_PATM + 16 * p + 2 * pi + k) !== (pat[2 * pi + k] & R.colMask(2, p))) bad++;
  check('colw 2: 64 rays, 4 a byte; the game\'s 16 pattern bytes, masked per position', rd8(m2, S.VD_NRAY) === 64 && rd8(m2, S.VD_RPB) === 4 && bad === 0, `${bad} differ`);
  // RLE variants
  const variants = [
    ['32 x 32 random, with zeros on its outer ring (forced to 1)', 32, 32, (() => { const c = R.randomCells(r, 32, 32, 0.3); c[5] = 0; c[31 * 32 + 7] = 0; c[9 * 32] = 0; c[17 * 32 + 31] = 0; return c; })(), null],
    ['4 x 4, the smallest', 4, 4, Uint8Array.from([1, 2, 3, 4, 4, 0, 0, 1, 2, 0, 0, 3, 1, 1, 1, 1]), null],
    ['32 x 4 with runs of 255', 32, 4, Uint8Array.from({ length: 128 }, (_, i) => (i < 40 || i >= 96 || i % 32 === 0 || i % 32 === 31 ? 2 : 0)), null],
    ['values above 4 read as 4', 6, 6, null, [6, 7, 30, 1, 0]],
    ['a short list leaves the rest 1', 10, 10, null, [12, 3, 5, 0, 0]],
    ['extra pairs after map_w x map_h cells are ignored', 5, 5, null, [25, 2, 200, 0, 50, 3, 0]],
    ['an empty list (count 0 first): every cell 1', 7, 9, null, [0]],
  ];
  for (const [label, mw, mh, cellsV, rle] of variants) {
    const v = { colw: 4, mw, mh, cells: cellsV ?? new Uint8Array(mw * mh), rle: rle ?? undefined };
    const gv = R.rayGame({ view: v });
    const mv = R.bootIdle(gv, 3);
    const e = R.loadMap(rle ?? R.rleEncode(cellsV), mw, mh);
    let b = 0, ringOk = true;
    for (let i = 0; i < 1024; i++) if (rd8(mv, S.MAP_RAM + i) !== e[i]) b++;
    for (let t = 0; t < 32; t++) for (const p of [t, 31 * 32 + t, t * 32, t * 32 + 31]) if (rd8(mv, S.MAP_RAM + p) === 0) ringOk = false;
    check(`map loader: ${label}`, b === 0 && ringOk && rd8(mv, S.V_RAY) === 1, `${b} differ`);
  }
  // refusals: non-ray mode, nothing of the view written
  const good = { colw: 4, mw: 16, mh: 16, cells: R.spikeMap(16) };
  const refusals = [
    ['DIV_VIEW without DIV_EXT', { view: good, divBits: 0x40 }],
    ['DIV_EXT without DIV_VIEW', { view: good, divBits: 0x80 }],
    ['colw 3', { view: { ...good, desc: [3, 16, 16, 0x47, 0x4F, 0x00, 0xBF, 0, 0, 0] } }],
    ['colw 8', { view: { ...good, desc: [8, 16, 16, 0x47, 0x4F, 0x00, 0xBF, 0, 0, 0] } }],
    ['map_w 3', { view: { ...good, desc: [4, 3, 16, 0x47, 0x4F, 0x00, 0xBF, 0, 0, 0] } }],
    ['map_w 33', { view: { ...good, desc: [4, 33, 16, 0x47, 0x4F, 0x00, 0xBF, 0, 0, 0] } }],
    ['map_h 3', { view: { ...good, desc: [4, 16, 3, 0x47, 0x4F, 0x00, 0xBF, 0, 0, 0] } }],
    ['map_h 33', { view: { ...good, desc: [4, 16, 33, 0x47, 0x4F, 0x00, 0xBF, 0, 0, 0] } }],
    ['map_src outside the game image and the bank window ($3F00; $4000-$7FFF is the window since banking B1)', { view: { ...good, desc: [4, 16, 16, 0x47, 0x4F, 0x00, 0x3F, 0, 0, 0] } }],
    ['patterns outside the game image', { view: { ...good, desc: [4, 16, 16, 0x47, 0x4F, 0x00, 0xBF, 0x00, 0xC0, 0] } }],
    ['patterns ending past $BFFF', { view: { ...good, desc: [4, 16, 16, 0x47, 0x4F, 0x00, 0xBF, 0xF5, 0xBF, 0] } }],
    ['view_desc pointer $C000', { view: good, viewPtr: 0xC000 }],
    ['view_desc pointer $7FF8', { view: good, viewPtr: 0x7FF8 }],
  ];
  for (const [label, spec] of refusals) {
    const gr = R.rayGame(spec);
    const mr = R.bootIdle(gr, 4);
    let z = true;
    for (let i = 0; i < 0x400; i++) if (rd8(mr, S.MAP_RAM + i) !== 0) z = false;
    check(`refused (non-ray mode, nothing of the view written): ${label}`, rd8(mr, S.V_RAY) === 0 && z && rd8(mr, S.VD_COLW) === 0 && rd8(mr, 0x5800 + 6 * 32 + 8) === 0x38 &&
      rd8(mr, S.V_DIV) === 1 && rd16(mr, S.V_TICKS) > 0);
  }
}

// ==================================================================================================================
console.log('\n3. Walls against the reference (bitmap preloaded with garbage, both display files)');
const garbage = (k) => Uint8Array.from({ length: 6144 }, (_, i) => (Math.imul(i + 1, 2654435761 + k) >>> 13) & 255);
function wallSweep(label, colw, mw, mh, cells, poses, rnd) {
  const g = R.rayGame({ view: { colw, mw, mh, cells } });
  const m = R.bootIdle(g, 3);
  const map = R.loadMap(R.rleEncode(cells), mw, mh);
  let ok = 0, bad = 0, first = null, outside = 0, rays = 0, frac0 = 0, axis = 0, vzero = 0, steps = 0, files = [0, 0];
  poses.forEach((pose, k) => {
    const file = (k + (rnd ? rnd.int(0, 1) : 0)) & 1;
    files[file]++;
    const gb = garbage(k * 7 + colw);
    m.ram.set(gb, file ? 0x6000 : 0x4000);
    const got = R.renderAt(m, S, pose, file);
    const cast = R.castFrame(map, pose, colw);
    const exp = gb.slice();
    R.drawWalls(exp, cast);
    const arr = R.rayArrays(m, S, cast.N);
    let rb = 0;
    for (let j = 0; j < cast.N; j++) if (arr.hh[j] !== cast.hh[j] || arr.pi[j] !== cast.pi[j] || arr.dist[j] !== cast.dist[j]) rb++;
    let d = 0, out = 0;
    for (let i = 0; i < 6144; i++) if (exp[i] !== got.bitmap[i]) { d++; const y = ((i >> 8) & 7) | ((i >> 2) & 0x38) | ((i >> 5) & 0xC0), x = i & 31; if (y < 48 || y >= 144 || x < 8 || x >= 24) out++; }
    outside += out;
    if (d === 0 && rb === 0) ok++; else { bad++; first ??= `pose ${JSON.stringify(pose)} file ${file}: ${d} bytes (${out} outside), ${rb} rays`; }
    rays += cast.N; steps += cast.steps;
    if ((pose.x & 255) === 0 || (pose.y & 255) === 0) frac0++;
    if ((pose.a & 63) === 0) axis++;
    if (cast.minV === 0) vzero++;
  });
  check(`${label}: ${ok}/${poses.length} poses equal the reference (window, outside unchanged, ray arrays)`, bad === 0 && outside === 0,
    first ?? `${rays} rays, ${(steps / rays).toFixed(1)} DDA steps a ray; ${frac0} poses on a cell edge, ${axis} axis-aligned, ${vzero} with a ray exactly parallel to an axis; files ${files.join('/')}`);
  return { ok, bad };
}
{
  const r = rng(803);
  let total = { 2: 0, 4: 0 };
  for (const colw of [4, 2]) {
    // the spike's maps and poses
    for (const n of [16, 32]) { const res = wallSweep(`colw ${colw}, the spike's ${n} x ${n} map and its 16 poses`, colw, n, n, R.spikeMap(n), R.spikePoses(n)); total[colw] += res.ok; }
    // random maps, random poses (fractions 0 and axis angles included)
    const maps = QUICK ? [[16, 16], [32, 32]] : [[16, 16], [24, 24], [32, 32], [32, 20], [9, 30]];
    for (const [mw, mh] of maps) {
      const cells = R.randomCells(r, mw, mh, 0.15), map = R.loadMap(R.rleEncode(cells), mw, mh);
      const poses = Array.from({ length: QUICK ? 24 : 48 }, () => R.randomPose(r, map, mw, mh));
      const res = wallSweep(`colw ${colw}, random ${mw} x ${mh} map, random poses`, colw, mw, mh, cells, poses, r);
      total[colw] += res.ok;
    }
    // every angle at one place, on a cell corner (fraction 0 on both axes)
    {
      const cells = R.randomCells(r, 24, 24, 0.12), map = R.loadMap(R.rleEncode(cells), 24, 24);
      let p = R.randomPose(r, map, 24, 24);
      p = { x: p.x & 0xFF00, y: p.y & 0xFF00, a: 0 };
      const poses = Array.from({ length: QUICK ? 64 : 256 }, (_, a) => ({ ...p, a: QUICK ? a * 4 : a }));
      total[colw] += wallSweep(`colw ${colw}, every angle on a cell corner (x, y fractions 0)`, colw, 24, 24, cells, poses).ok;
    }
    // 0.2 cells from a wall, facing it and along it; long corridors
    {
      const mw = 32, mh = 32, cells = new Uint8Array(mw * mh);
      for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) cells[y * mw + x] = x === 0 || y === 0 || x === 31 || y === 31 || y === 8 || y === 10 || (x === 16 && y > 12) ? 1 + ((x + y) & 3) : 0;
      for (let x = 1; x < 31; x += 6) cells[8 * mw + x] = 0;           // doors in the corridor's wall
      const poses = [];
      for (let k = 0; k < (QUICK ? 20 : 40); k++) {
        const x = r.int(2, 29) * 256 + r.pick([0, 51, 128, 205, 255]);
        poses.push({ x, y: 9 * 256 + r.pick([51, 128, 205, 0]), a: r.pick([0, 128, 1, 255, 127, 129, r.int(0, 255)]) });   // the corridor y = 9
        poses.push({ x: 15 * 256 + 205, y: r.int(14, 29) * 256 + r.pick([0, 51, 205]), a: r.pick([0, 64, 192, 128, 63, 65, r.int(0, 255)]) }); // 0.2 from the wall x = 16
      }
      total[colw] += wallSweep(`colw ${colw}, a 30-cell corridor and 0.2 cells from a wall`, colw, mw, mh, cells, poses, r).ok;
    }
    // rays parallel to an axis or close to it: components 0 (never steps), 1..15, 16 (the delta 2^16: the exact 24-bit first distance, e = 7) and 17..19 (a
    // delta above 54,535: without the step cap a second step would wrap); fractions 0, 1 / 255, 30 / 226 (m = 30: the first distance 3,967..11,000)
    {
      const N = 128 / colw, pick = [];
      for (let a = 0; a < 256; a++) {
        const s = R.frameSetup({ a }, N); let x = s.rdx, y = s.rdy; const vs = new Set();
        for (let j = 0; j < N; j++) { vs.add(Math.abs(x)); vs.add(Math.abs(y)); x = R.s16(x + s.stx); y = R.s16(y + s.sty); }
        const key = vs.has(0) ? 0 : [16, 17, 18, 19].some((v) => vs.has(v)) ? 1 : [...vs].some((v) => v < 16) ? 2 : 3;
        if (key < 3) pick.push([key, a]);
      }
      const quota = QUICK ? [3, 4, 3] : [99, 99, 99], used = [0, 0, 0];
      const angles = pick.filter(([key]) => used[key]++ < quota[key]).map((p) => p[1]);
      const cells = R.randomCells(r, 32, 32, 0.08), map = R.loadMap(R.rleEncode(cells), 32, 32);
      const poses = [];
      let big = 0, zero = 0, cap = 0;
      for (const a of angles) for (const [fx, fy] of [[0, 0], [1, 255], [255, 1], [30, 226], [226, 30], [128, 0], [r.int(0, 255), r.int(0, 255)]]) {
        const p = R.randomPose(r, map, 32, 32);
        const pose = { x: (p.x & 0xFF00) | fx, y: (p.y & 0xFF00) | fy, a };
        poses.push(pose);
        const s = R.frameSetup(pose, N); let x = s.rdx, y = s.rdy;
        for (let j = 0; j < N; j++) {
          for (const v of [x, y]) { if (v === 0) { zero++; continue; } const ax = R.axisRef(v, 0); const D = R.RECIP[(Math.abs(v) << ax.e) >> 4] * 2 ** ax.e; if (D >= 65536) big++; else if (D > 54535) cap++; }
          x = R.s16(x + s.stx); y = R.s16(y + s.sty);
        }
      }
      total[colw] += wallSweep(`colw ${colw}, near-axis rays (${angles.length} angles; ${zero} components exactly 0, ${big} with a delta of 2^16 or more, ${cap} with a delta above 54,535)`, colw, 32, 32, cells, poses, r).ok;
      check(`colw ${colw}: the near-axis sweep reached v = 0, the delta >= 65,536 path and deltas the step cap must cut`, zero > 0 && big > 0 && cap > 0, `${zero} / ${big} / ${cap}`);
    }
    // a viewer on the array's outer ring (row 0 / column 0 of a 16 x 16 map, allowed by RT_VIEW's clamp) looking out: the cast is clamped into cells 1..30
    {
      const cells = R.randomCells(r, 16, 16, 0.1), poses = [];
      for (let k = 0; k < 12; k++) poses.push({ x: r.int(256, 15 * 256), y: r.int(0, 255), a: r.int(140, 245) }, { x: r.int(0, 255), y: r.int(256, 15 * 256), a: r.int(75, 180) });
      total[colw] += wallSweep(`colw ${colw}, a viewer on the array's ring looking out of it`, colw, 16, 16, cells, poses, r).ok;
    }
    // the step cap: a 29-cell corridor along y, rays whose x component is 17..19 (a delta above 54,535) and m = 30: the x step comes after 28 cells, and an
    // uncapped delta would wrap the 16-bit side distance and step again at once
    {
      const N = 128 / colw, cells = new Uint8Array(32 * 32), angles = [];
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) cells[y * 32 + x] = x < 13 || x > 18 || y === 0 || y === 31 ? 1 + ((x + 2 * y) & 3) : 0;
      for (let a = 0; a < 256; a++) { const s = R.frameSetup({ a }, N); let x = s.rdx; for (let j = 0; j < N; j++) { if (Math.abs(x) >= 17 && Math.abs(x) <= 19) { angles.push(a); break; } x = R.s16(x + s.stx); } }
      const poses = [];
      for (const a of angles) { const up = R.SIN(a) < 0; for (const fx of [30, 226, 40, 216]) poses.push({ x: 15 * 256 + fx, y: up ? 30 * 256 + 128 : 1 * 256 + 128, a }); }
      total[colw] += wallSweep(`colw ${colw}, the step cap: ${angles.length} angles with an x component of 17..19, down a 29-cell corridor`, colw, 32, 32, cells, poses, r).ok;
    }
    // positions inside a wall cell and on the ring (the renderer ignores the viewer's own cell)
    {
      const cells = R.randomCells(r, 16, 16, 0.4), map = R.loadMap(R.rleEncode(cells), 16, 16);
      const poses = Array.from({ length: QUICK ? 10 : 20 }, () => ({ x: r.int(0, 16 * 256 - 1), y: r.int(0, 16 * 256 - 1), a: r.int(0, 255) }));
      total[colw] += wallSweep(`colw ${colw}, poses anywhere (inside walls and on the outer ring too)`, colw, 16, 16, cells, poses, r).ok;
      void map;
    }
  }
  check(`at least 200 poses per column width equal the reference (colw 4: ${total[4]}, colw 2: ${total[2]})`, QUICK || (total[4] >= 200 && total[2] >= 200));
}

// ==================================================================================================================
console.log('\n4. Billboards against the reference column scaler');
{
  const r = rng(804);
  for (const colw of [4, 2]) {
    const mw = 20, mh = 20, cells = R.randomCells(r, mw, mh, 0.1), map = R.loadMap(R.rleEncode(cells), mw, mh);
    const sizes = [[8, 8, 1], [16, 16, 3], [24, 24, 2], [32, 32, 1], [16, 48, 2], [8, 13, 4], [32, 40, 1], [24, 12, 2]];
    const assets = sizes.map(([w, h, nf]) => R.randomAsset(r, w, h, 1, nf));
    const insts = [0, 1, 2, 3, 4, 5, 6, 7, 1, 1, 3, 0, 2, 4, 5, 6];
    const g = R.rayGame({ view: { colw, mw, mh, cells }, assets, insts });
    const m = R.bootIdle(g, 3);
    const model = new R.Model8({ view: { colw, mw, mh, cells }, assets, insts });
    let ok = 0, bad = 0, first = null, drawn = 0, partial = 0, edge = 0, behind = 0, outside = 0, clampF = 0, overl = 0;
    const N = QUICK ? 60 : 160;
    for (let k = 0; k < N; k++) {
      const pose = R.randomPose(r, map, mw, mh);
      const spread = r.pick([400, 900, 1600, 3000]);
      model.insts.forEach((s, i) => {
        const vis = r.chance(0.85);
        let x = pose.x + r.int(-spread, spread), y = pose.y + r.int(-spread, spread);
        if (r.chance(0.05)) x = r.int(mw * 256, 65535);                    // outside the map: not drawn
        else if (r.chance(0.08)) { x = mw * 256 + r.int(0, 700); y = pose.y + r.int(-700, 700); }   // just beyond the right edge
        else if (r.chance(0.05)) { y = mh * 256 + r.int(0, 700); x = pose.x + r.int(-700, 700); }   // just below the bottom edge
        x &= 0xFFFF; y = Math.max(0, y) & 0xFFFF;
        const f = r.chance(0.1) ? r.int(0, 255) : r.int(0, 3);
        Object.assign(s, { visible: vis, x, y, frame: f });
        const b = S.SPR_TAB + 8 * i;
        m.ram[b] = vis ? 1 : 0; R.wr16(m, b + 2, x); R.wr16(m, b + 4, y); m.ram[b + 6] = f;
      });
      const file = k & 1, gb = garbage(k + 99);
      m.ram.set(gb, file ? 0x6000 : 0x4000);
      const got = R.renderAt(m, S, pose, file);
      const exp = gb.slice(), cast = R.castFrame(map, pose, colw);
      R.drawWalls(exp, cast);
      const bb = R.drawBillboards(exp, cast, model.insts, model.assets, pose, mw, mh);
      let bbBad = 0;
      for (let i = 0; i < 16; i++) if (rd16(m, S.BB_TAB + 4 * i) !== bb[i].depth || rd16(m, S.BB_TAB + 4 * i + 2) !== bb[i].col) bbBad++;
      const d = R.diffCount(exp, got.bitmap);
      if (d === 0 && bbBad === 0) ok++; else { bad++; first ??= `scene ${k}: ${d} bytes, ${bbBad} BB_TAB entries`; }
      // statistics of what the scene exercised (from the reference)
      model.insts.forEach((s, i) => {
        if (!s.visible) return;
        const p = R.projectBB(s, model.assets[s.asset], pose, mw, mh);
        if (s.x > mw * 256 - 1) outside++;
        if (!p) { behind++; return; }
        if (bb[i].depth) { drawn++; if (p.L < 0 || p.L + p.wpx > 128) edge++; if (s.frame >= model.assets[s.asset].nf) clampF++; }
        let hid = 0, vis = 0;
        for (let j = 0; j < cast.N; j++) { const xc = j * colw + colw / 2; if (xc >= p.L && xc < p.L + p.wpx) { if (p.tx < cast.dist[j]) vis++; else hid++; } }
        if (hid && vis) partial++;
      });
      const shown = model.insts.map((s, i) => (bb[i].depth ? bb[i] : null)).filter(Boolean);
      for (let a = 0; a < shown.length; a++) for (let b = a + 1; b < shown.length; b++) if (Math.abs(shown[a].col - shown[b].col) < 12) overl++;
    }
    check(`colw ${colw}: ${ok}/${N} scenes of 16 instances (8 assets 8x8 .. 32x48) equal the reference and BB_TAB`, bad === 0,
      first ?? `${drawn} billboards drawn: ${partial} partly behind a wall, ${edge} cut by the view's edge, ${clampF} with the frame clamped; ${behind} culled (behind / too close / off the view), ${outside} outside the map; ${overl} overlapping pairs`);
    // outside the map but next to a hole in its ring (a map the compiler would refuse): the billboard is still not drawn
    {
      const holed = cells.slice(); for (let y = 7; y <= 11; y++) { holed[y * mw + mw - 1] = 0; holed[y * mw + mw - 2] = 0; holed[y * mw + mw - 3] = 0; }
      const g3 = R.rayGame({ view: { colw, mw, mh, cells: holed }, assets, insts }), m3 = R.bootIdle(g3, 3);
      const model3 = new R.Model8({ view: { colw, mw, mh, cells: holed }, assets, insts });
      let oOk = 0, oBad = 0, wouldShow = 0;
      for (let k = 0; k < 8; k++) {
        const pose = { x: (mw - 4) * 256 + 128, y: 9 * 256 - 200 + 50 * k, a: r.pick([10, 20, 245, 235, 0]) };
        model3.insts.forEach((s2, i) => { s2.visible = i === 4 || i === 6; m3.ram[S.SPR_TAB + 8 * i] = s2.visible ? 1 : 0; });
        for (const [i, dy] of [[4, 0], [6, 300]]) {
          const x = mw * 256 + r.int(1, 40), y = 9 * 256 + dy - 150 + 40 * k;
          Object.assign(model3.insts[i], { x, y, frame: 0 });
          const b = S.SPR_TAB + 8 * i; R.wr16(m3, b + 2, x); R.wr16(m3, b + 4, y); m3.ram[b + 6] = 0;
          const fake = { ...model3.insts[i], x: mw * 256 - 1 };       // (the same billboard moved just inside would show)
          if (R.projectBB(fake, model3.assets[fake.asset], pose, mw, mh)) wouldShow++;
        }
        const gb = garbage(k + 700), file = k & 1;
        m3.ram.set(gb, file ? 0x6000 : 0x4000);
        const got = R.renderAt(m3, S, pose, file), exp = gb.slice(), cast = R.castFrame(model3.map, pose, colw);
        R.drawWalls(exp, cast);
        const bb = R.drawBillboards(exp, cast, model3.insts, model3.assets, pose, mw, mh);
        let bbBad = 0; for (const i of [4, 6]) if (rd16(m3, S.BB_TAB + 4 * i) !== bb[i].depth) bbBad++;
        if (R.diffCount(exp, got.bitmap) === 0 && bbBad === 0) oOk++; else oBad++;
      }
      check(`colw ${colw}: billboards just outside the map (x = map_w * 256 + 1..40) next to a hole in its ring are not drawn`, oBad === 0 && wouldShow > 4, `${oOk} scenes, ${wouldShow} would be projected inside`);
    }
    // equal depths: pairs of instances at the same position (the draw order is the instance order), different assets overlapping
    let eqOk = 0, eqBad = 0, eqDrawn = 0;
    for (let k = 0; k < (QUICK ? 12 : 40); k++) {
      const pose = R.randomPose(r, map, mw, mh), cs = R.cosa8(pose.a), sn = R.sina8(pose.a);
      model.insts.forEach((s, i) => {
        const pair = i >> 1, d = 380 + 150 * pair, lat = (pair % 3 - 1) * 120;
        const x = (pose.x + ((d * cs - lat * sn) >> 8)) & 0xFFFF, y = Math.max(0, pose.y + ((d * sn + lat * cs) >> 8)), vis = i < 8;
        Object.assign(s, { visible: vis, x, y, frame: r.int(0, 2) });
        const b = S.SPR_TAB + 8 * i;
        m.ram[b] = vis ? 1 : 0; R.wr16(m, b + 2, x); R.wr16(m, b + 4, y); m.ram[b + 6] = s.frame;
      });
      const got = R.renderAt(m, S, pose, k & 1), exp = new Uint8Array(6144), cast = R.castFrame(map, pose, colw);
      exp.set(got.bitmap);                                               // (outside the window: whatever is there)
      R.drawWalls(exp, cast);
      const bb = R.drawBillboards(exp, cast, model.insts, model.assets, pose, mw, mh);
      eqDrawn += bb.filter((b) => b.depth).length;
      if (R.diffCount(exp, got.bitmap) === 0) eqOk++; else eqBad++;
    }
    check(`colw ${colw}: billboards at equal depth (4 pairs at one position each) are drawn in instance order`, eqBad === 0 && eqDrawn > (QUICK ? 30 : 100), `${eqOk} scenes, ${eqDrawn} drawn`);
    // the widest billboard first: a 32 x 48 one 1.2 cells ahead covers every ray (64 columns at 2 px: the largest generated code), then nearer ones
    // whose depth test reads the distances right after that code
    {
      const open = new Uint8Array(mw * mh); for (let y = 0; y < mh; y++) for (let x = 0; x < mw; x++) open[y * mw + x] = x === 0 || y === 0 || x === mw - 1 || y === mh - 1 ? 1 + ((x * 3 + y) & 3) : 0;
      const g2 = R.rayGame({ view: { colw, mw, mh, cells: open }, assets, insts }), m2 = R.bootIdle(g2, 3);
      const model2 = new R.Model8({ view: { colw, mw, mh, cells: open }, assets, insts }), map2 = model2.map;
      let wOk = 0, wBad = 0, cols = 0;
      for (let k = 0; k < 6; k++) {
        const a = k * 43 & 255, pose = { x: 10 * 256 + 17 * k, y: 10 * 256 + 9 * k, a }, cs = R.cosa8(a), sn = R.sina8(a);
        const place = [[6, 250, 0], [1, 170, -60], [5, 140, 70], [0, 110, 10], [2, 190, 40]];   // [instance, depth, lateral] (instance 6: the 32 x 40 one)
        model2.insts.forEach((s2, i) => { s2.visible = false; m2.ram[S.SPR_TAB + 8 * i] = 0; });
        for (const [i, d, lat] of place) {
          const x = (pose.x + ((d * cs - lat * sn) >> 8)) & 0xFFFF, y = (pose.y + ((d * sn + lat * cs) >> 8)) & 0xFFFF;
          Object.assign(model2.insts[i], { visible: true, x, y, frame: 0 });
          const b = S.SPR_TAB + 8 * i; m2.ram[b] = 1; R.wr16(m2, b + 2, x); R.wr16(m2, b + 4, y); m2.ram[b + 6] = 0;
        }
        const gb = garbage(k + 500), file = k & 1;
        m2.ram.set(gb, file ? 0x6000 : 0x4000);
        const got = R.renderAt(m2, S, pose, file), exp = gb.slice(), cast = R.castFrame(map2, pose, colw);
        R.drawWalls(exp, cast);
        R.drawBillboards(exp, cast, model2.insts, model2.assets, pose, mw, mh);
        const p6 = R.projectBB(model2.insts[6], model2.assets[model2.insts[6].asset], pose, mw, mh);
        if (p6) cols = Math.max(cols, Math.min(128, p6.L + p6.wpx) - Math.max(0, p6.L));
        if (R.diffCount(exp, got.bitmap) === 0) wOk++; else wBad++;
      }
      check(`colw ${colw}: the widest billboard drawn first (${cols} pixels of 128 wide), nearer ones after it`, wBad === 0 && cols >= 120, `${wOk} scenes`);
    }
    const q = N / 160;
    check(`colw ${colw}: the scenes exercised every case (drawn, partly hidden, at the edges, culled, outside the map, frame clamp, overlaps)`, drawn > 120 * q && partial > 20 * q && edge > 30 * q && behind > 300 * q && outside > 30 * q && clampF > 20 * q && overl > 10 * q);
  }
}

// ==================================================================================================================
console.log('\n5. Whole games: the picture after every refresh');
{
  const r = rng(805);
  for (const [colw, div, mw, mh] of [[4, 3, 16, 16], [2, 5, 24, 20], [4, 1, 32, 32], [2, 2, 12, 12]]) {
    const cells = R.randomCells(r, mw, mh, 0.15), map = R.loadMap(R.rleEncode(cells), mw, mh);
    const assets = [R.randomAsset(r, 16, 16, 1, 4), R.randomAsset(r, 32, 32, 1, 2), R.randomAsset(r, 8, 8, 1, 1)];
    const insts = [0, 0, 1, 2, 0];
    const tiles = randomTiles(r, 6);
    const nt = QUICK ? 14 : 30;
    let pose = R.randomPose(r, map, mw, mh);
    const script = Array.from({ length: nt }, (_, k) => {
      const t = [];
      pose = { x: pose.x + r.int(-90, 90), y: pose.y + r.int(-90, 90), a: (pose.a + r.int(-9, 9)) & 255 };
      t.push(op.view(pose.x, pose.y, pose.a + (r.chance(0.2) ? 256 * r.int(1, 3) : 0)));
      insts.forEach((_, i) => {
        if (r.chance(0.1)) t.push(op.hide(i));
        else if (r.chance(0.5)) t.push(op.showf(i, pose.x + r.int(-1200, 1200), pose.y + r.int(-1200, 1200), r.int(0, 4)));
        else t.push(op.show(i, pose.x + r.int(-1200, 1200), pose.y + r.int(-1200, 1200)));
      });
      if (k % 4 === 1) t.push(op.setwall(r.int(0, mw * 256), r.int(0, mh * 256), r.int(0, 4)));
      if (k % 3 === 0) t.push(op.at(r.pick([0, 2, 20, 23, 8]), r.int(0, 28)), op.prints('HUD ' + k));    // row 8: inside the window's rows (masked)
      if (k % 5 === 2) t.push(op.tile(r.int(0, 5), r.int(0, 23), r.int(0, 31)));
      if (k % 2 === 1) t.push(op.at(r.pick([6, 17]), r.int(8, 18)), op.prints('IN' + k), op.tile(r.int(0, 5), r.pick([6, 11, 12, 17]), r.int(8, 23)));   // into the window (masked)
      t.push(op.bbtab(r.int(0, 4)), op.wall(r.int(-300, mw * 256 + 300), r.int(-300, mh * 256 + 300)), op.hit(r.int(0, 4), r.int(0, 4)));
      return t;
    });
    const spec = { div, view: { colw, mw, mh, cells, top: 0x41 | (r.int(0, 7) << 3), bottom: 0x47 }, assets, insts, tiles, script };
    const g = R.rayGame(spec);
    const st = R.observe8(g, nt * Math.max(div, colw === 2 ? 5 : 3) + 6, { script, pixels: true });
    const logOk = st.gameLog.length >= st.modelLog.length && st.gameLog.length <= st.modelLog.length + 4 && st.modelLog.every((v, i) => (v & 0xFFFF) === st.gameLog[i]);   // (the last tick may have logged before its flip request)
    check(`colw ${colw}, frame_div ${div}, ${mw} x ${mh}: the shown file equals the model after every refresh (${st.ok} refreshes), the TSRun colours too, never written while shown`,
      st.bad === 0 && st.ok > nt && st.writeViolations === 0 && st.pixelBad === 0 && st.canary === 0x5AA5, st.firstBad ? JSON.stringify(st.firstBad) : `${st.ticks} ticks`);
    check(`colw ${colw}, frame_div ${div}: BB_TAB (previous tick's draw), WALL and HIT read by the game equal the model`, logOk && st.modelLog.length >= 4 * Math.min(nt, st.ticks) && st.ticks >= 6, `${st.modelLog.length} values, ${st.ticks} ticks`);
  }
}

finish('runtime v4, pictures and boot');
