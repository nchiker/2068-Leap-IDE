"use strict";
// m5-runtime.mjs -- M5 runtime test, part 1: the tile operations of language batch 1, every routine called directly on the booted machine and
// compared with the JS model (m5-common.mjs, written from the contract):
//  1. RT_FILL and RT_FILLC over thousands of random rectangles (x, y, w, h anywhere in int16: clipped, degenerate, huge, negative), random cell states:
//     cells and attributes equal the model, DIRTY0 = DIRTY1 = exactly the cells whose byte or attribute changed, only the cell map, the dirty maps and
//     the tile-operation RAM written, AF BC DE HL the only registers touched, the stack inside its budget.
//  2. RT_COPY over thousands of random rectangles incl. all 8 directions of overlap, same-row copies, clipped on either side, degenerate.
//  3. RT_LOADMAP / RT_LOADMAPAT (the map table) and RT_LOADMAPPTR over every map size 0..255 x 0..255, at the screen edges and far away.
//  4. The map table and the boot: map 0 loaded at boot, count clamp, null pointers, old headers (no DIV_EXT) boot as before, frame_div read without bit 7.
//  5. RT_BORDER and RT_RANDOMISE.
//   node arcade/tests/m5-runtime.mjs
import * as C from './m5-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { M, Z, hex, makeChecks, rd8, rd16, op, int16, BG_ATTR } = C;

const { check, finish } = makeChecks();
const Q = process.env.M5_QUICK ? 0.15 : 1;        // the mutation run uses a short form of the random loops
const scale = (n) => Math.max(120, Math.round(n * Q));
const rt = C.rt();
const S = rt.syms;
console.log('M5 runtime: RT_FILL / RT_FILLC / RT_COPY / RT_LOADMAP* / RT_BORDER / RT_RANDOMISE called directly, against the model\n');

const tiles = randomTiles(rng(5), 6).map((t, k) => ({ ...t, attr: [0x38, 0x07, 0x46, 0x12, 0x5F, 0x38][k] }));
const tileAttr = (t) => (t < tiles.length ? tiles[t].attr : BG_ATTR);
const FONT_ATTRS = [0x38, 0x38, 0x38, 0x07, 0x47, 0x30, 0x3F];

/** A random cell map state: few distinct values, so that equal cells are common (an unchanged cell must mark nothing). */
function randomState(r, style = r.int(0, 3)) {
  const tile = new Uint8Array(768), attr = new Uint8Array(768);
  for (let i = 0; i < 768; i++) {
    let v;
    if (style === 0) v = 32;                                                   // a blank screen
    else if (style === 1) v = r.chance(0.7) ? 0x80 | 1 : r.pick([32, 0x80 | 2, 65]);
    else if (style === 2) v = r.chance(0.5) ? 0x80 | r.int(0, 7) : r.int(32, 127);
    else v = r.chance(0.5) ? r.int(0, 255) : 0x80 | 2;
    tile[i] = v;
    attr[i] = v & 0x80 ? tileAttr(v & 0x7F) : r.pick(FONT_ATTRS);
    if (style === 3 && r.chance(0.1)) attr[i] ^= 0x04;                          // a cell whose attribute differs from the usual one (the byte equal)
  }
  return { tile, attr };
}
const coord = (r) => r.pick([() => r.int(-32768, 32767), () => r.int(-40, 70), () => r.int(-8, 40), () => r.int(0, 31), () => r.pick([-1, 0, 1, 31, 32, 33, 23, 24, 25, 255, 256, 257, -32768, 32767, -255, -256, -257, 65535 - 65536])])();
const size = (r) => r.pick([() => r.int(-3, 40), () => r.int(1, 12), () => r.int(1, 33), () => r.int(-32768, 32767), () => r.pick([0, 1, 8, 16, 31, 32, 33, 24, 25, 255, 256, 32767, -1, -32768])])();

const game = C.opsGame({ tiles, insts: [], assets: [], script: [] });
const A = (a) => Array.from(a);

/** One call of a routine on machine `m` against model `mdl` (both already holding the same state).  Returns problems (strings) and T-states. */
function trial(m, mdl, name, regs, args, modelOp, { diffRam = false, pattern = false } = {}) {
  C.clearDirty(m, S);
  mdl.changed = new Set();
  if (args) C.setArgs(m, S, args);
  const argsBefore = Array.from(m.ram.subarray(S.RT_ARGS, S.RT_ARGS + 12));
  const before = diffRam ? Uint8Array.from(m.ram) : null;
  const sp0 = m.cpu.sp;
  if (pattern) m.ram.fill(0xA5, S.STACK_LIMIT, sp0 - 2);          // the stack area below the call: find how deep the routine goes
  const res = C.call(m, S[name], regs);
  const probs = [];
  mdl.apply(modelOp);
  const got = C.cellsOf(m, S);
  for (let i = 0; i < 768; i++) if (got.tile[i] !== mdl.tile[i] || got.attr[i] !== mdl.attr[i]) { probs.push(`cell ${i} (r${i >> 5} c${i & 31}): ${hex(got.tile[i], 2)}/${hex(got.attr[i], 2)} want ${hex(mdl.tile[i], 2)}/${hex(mdl.attr[i], 2)}`); break; }
  const want = [...mdl.changed].sort((a, b) => a - b).join();
  const d0 = C.dirtyCells(m, S.DIRTY0).join(), d1 = C.dirtyCells(m, S.DIRTY1).join();
  if (d0 !== want) probs.push(`DIRTY0 ${d0} want ${want}`);
  if (d1 !== want) probs.push(`DIRTY1 ${d1} want ${want}`);
  if (!res.preserved) probs.push('IX/IY/alternates or the sentinel registers changed');
  if (!res.spOk) probs.push('SP changed');
  if (Array.from(m.ram.subarray(S.RT_ARGS, S.RT_ARGS + 12)).join() !== argsBefore.join()) probs.push('the argument block changed');
  let depth = 0;
  if (pattern) {
    let a = S.STACK_LIMIT; while (a < sp0 - 2 && m.ram[a] === 0xA5) a++;
    depth = sp0 - 2 - a;                                            // bytes pushed below the return address of the CALL (callRoutine's sentinel return at SP - 2)
  }
  if (before) {
    for (let a = 0x4000; a < 0x10000; a++) {
      if (m.ram[a] === before[a]) continue;
      const inCells = a >= S.CELL_TILE && a < S.CELL_TILE + 1536, inDirty = (a >= S.DIRTY0 && a < S.DIRTY0 + 96) || (a >= S.DIRTY1 && a < S.DIRTY1 + 96);
      const inT3 = a >= S.T3 && a < S.T3 + S.T3_LEN, inStack = a >= S.STACK_CANARY && a < S.STACK_TOP;
      if (!inCells && !inDirty && !inT3 && !inStack) { probs.push(`wrote ${hex(a)}`); break; }
    }
  }
  return { probs, t: res.t, depth, got };
}

function runSuite(label, count, seed, makeTrial, { ramEvery = 25 } = {}) {
  const r = rng(seed);
  const m = C.park(game), mdl = new C.Model5({ tiles });
  let bad = 0, first = null, tSum = 0, tMax = 0, depthMax = 0, n = 0, cells = 0;
  const per = [];
  for (let k = 0; k < count; k++) {
    const st = randomState(r);
    C.setCells(m, S, st.tile, st.attr);
    mdl.tile.set(st.tile); mdl.attr.set(st.attr);
    const t = makeTrial(r, m, mdl, k);
    const res = trial(m, mdl, t.name, t.regs ?? {}, t.args ?? null, t.op, { diffRam: k % ramEvery === 0, pattern: k % 7 === 0 });
    n++; tSum += res.t; tMax = Math.max(tMax, res.t); depthMax = Math.max(depthMax, res.depth);
    cells += t.cells ?? 0;
    if (t.cells !== undefined) per.push([t.cells, res.t, mdl.changed.size]);
    if (res.probs.length) { bad++; first ??= { k, name: t.name, args: t.args, regs: t.regs, probs: res.probs.slice(0, 3) }; if (process.env.M5_QUICK) break; }
  }
  check(`${label}: ${n} random calls equal the model (cells, attributes, dirty bits, registers, memory written)`, bad === 0, first ? JSON.stringify(first) : `${n} calls`);
  return { n, tMax, depthMax, per };
}

// ---- 1. FILL / FILLC --------------------------------------------------------------------------------------------------------
console.log('1. RT_FILL / RT_FILLC');
const fillArgs = (r) => {
  const mode = r.int(0, 3);
  if (mode === 0) return [coord(r), coord(r), size(r), size(r)];
  if (mode === 1) return [r.int(-4, 34), r.int(-4, 26), r.int(0, 40), r.int(0, 30)];
  if (mode === 2) return [r.int(0, 31), r.int(0, 23), r.int(1, 32), r.int(1, 24)];
  return [r.int(0, 3), r.int(0, 3), r.pick([32, 31, 33]), r.pick([24, 23, 25])];
};
const fillRes = runSuite('RT_FILL', scale(4000), 501, (r) => {
  const [x, y, w, h] = fillArgs(r);
  const t = r.chance(0.7) ? r.int(0, 5) : r.pick([6, 7, 127, 128, 129, 255, 256, 0x1182, -1, 0x7FFF, -32768]);
  return { name: 'RT_FILL', args: [x, y, w, h, t], op: op.fill(x, y, w, h, t & 0x7F), cells: Math.max(0, Math.min(32, Math.max(x, 0) + Math.max(0, Math.min(w, 40))) - Math.max(x, 0)) };
});
// (the model has its own tile attribute table from `tiles`; tile numbers >= 6 are undefined: BG_ATTR, a blank glyph)
{
  const r = rng(502);
  const m = C.park(game), mdl = new C.Model5({ tiles });
  let bad = 0, first = null;
  for (let k = 0; k < scale(3000); k++) {
    const st = randomState(r);
    C.setCells(m, S, st.tile, st.attr); mdl.tile.set(st.tile); mdl.attr.set(st.attr);
    const ta = r.int(0, 255);
    m.ram[S.V_TEXT_ATTR] = ta; mdl.textAttr = ta;
    const [x, y, w, h] = fillArgs(r);
    const c = r.chance(0.8) ? r.int(32, 127) : r.pick([0, 31, 127, 128, 200, 255, 256 + 65, -1]);
    const res = trial(m, mdl, 'RT_FILLC', {}, [x, y, w, h, c], op.fillc(x, y, w, h, c & 0x7F), { diffRam: k % 25 === 0, pattern: k % 9 === 0 });
    if (res.probs.length) { bad++; first ??= { k, x, y, w, h, c, probs: res.probs.slice(0, 3) }; if (process.env.M5_QUICK) break; }
    if (rd8(m, S.V_TEXT_ATTR) !== ta) { bad++; first ??= { k, why: 'V_TEXT_ATTR changed' }; }
  }
  check('RT_FILLC: 3000 random calls (character 0..255, any text attribute) equal the model; the text attribute and the cursor are untouched', bad === 0, first ? JSON.stringify(first) : '');
}
check('FILL: the stack stays within 20 bytes beyond the CALL', fillRes.depthMax <= 20, `${fillRes.depthMax} bytes`);
console.log(`  (deepest stack use measured: FILL ${fillRes.depthMax} bytes beyond the return address)`);
{ // an unchanged fill marks nothing; a changed one marks exactly the rectangle
  const m = C.park(game), mdl = new C.Model5({ tiles });
  C.clearDirty(m, S);
  C.setArgs(m, S, [3, 4, 10, 5, 2]);
  C.call(m, S.RT_FILL, {});
  const d1 = C.dirtyCells(m, S.DIRTY0);
  check('FILL of a blank screen: exactly the 10 x 5 rectangle is dirty, in both dirty maps', d1.length === 50 && d1.join() === C.dirtyCells(m, S.DIRTY1).join() && d1.every((i) => (i & 31) >= 3 && (i & 31) < 13 && (i >> 5) >= 4 && (i >> 5) < 9));
  C.clearDirty(m, S);
  C.call(m, S.RT_FILL, {});
  check('...the same FILL again changes nothing and marks nothing (as RT_TILE on an unchanged cell)', C.dirtyCells(m, S.DIRTY0).length === 0 && C.dirtyCells(m, S.DIRTY1).length === 0);
  void mdl;
}

{ // a deterministic sweep of the clip around the edges of the 8-bit arithmetic: rectangles whose end or length is near 256 / 288, on both axes
  const m = C.park(game), mdl = new C.Model5({ tiles });
  const r = rng(503);
  let bad = 0, first = null, n = 0;
  const starts = [-1, -2, -5, -17, -31, -32, -33, -40, -100, -200, -255, -256, -257];
  const ends = [255, 256, 257, 270, 287, 288, 289, 300, 511, 512, 513, 520];
  for (const x of starts) for (const e of ends) for (const d of (Q < 1 ? [-1, 1] : [-2, -1, 0, 1, 2])) {
    const w = e + d - x;                                   // end = x + w near e
    if (w < 1 || w > 32767) continue;
    for (const axis of [0, 1]) {
      const st = randomState(r);
      C.setCells(m, S, st.tile, st.attr); mdl.tile.set(st.tile); mdl.attr.set(st.attr);
      const a = axis === 0 ? [x, 3, w, 5, 2] : [4, x, 6, w, 2];
      const res = trial(m, mdl, 'RT_FILL', {}, a, op.fill(a[0], a[1], a[2], a[3], 2));
      n++;
      if (res.probs.length) { bad++; first ??= { a, probs: res.probs.slice(0, 2) }; }
    }
  }
  check(`RT_FILL clip sweep: ${n} rectangles with a negative start and an end or length near 255, 256, 288, 512 (both axes) equal the model`, bad === 0, first ? JSON.stringify(first) : '');
}

// ---- 2. COPY ---------------------------------------------------------------------------------------------------------------
console.log('\n2. RT_COPY');
const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
const copyRes = runSuite('RT_COPY', scale(6000), 601, (r) => {
  let x, y, w, h, dx, dy;
  const mode = r.int(0, 5);
  if (mode === 0) { x = coord(r); y = coord(r); w = size(r); h = size(r); dx = coord(r); dy = coord(r); }
  else if (mode === 1) { x = r.int(-3, 33); y = r.int(-3, 25); w = r.int(0, 36); h = r.int(0, 28); dx = r.int(-5, 36); dy = r.int(-5, 28); }
  else if (mode === 2) { // an overlapping move by a few cells in one of the 8 directions (the memmove cases)
    x = r.int(0, 20); y = r.int(0, 14); w = r.int(1, 32 - x); h = r.int(1, 24 - y);
    const [ux, uy] = r.pick(dirs); const k = r.int(1, 9);
    dx = x + ux * r.int(1, k); dy = y + uy * r.int(1, k);
  } else if (mode === 3) { x = r.int(0, 31); y = r.int(0, 23); w = r.int(1, 32); h = r.int(1, 24); dx = x + r.int(-7, 7); dy = y; }       // same rows
  else if (mode === 4) { x = r.int(0, 31); y = r.int(0, 23); w = r.int(1, 32); h = r.int(1, 24); dx = x; dy = y + r.int(-5, 5); }              // same columns
  else { x = r.int(-3, 6); y = r.int(-2, 4); w = r.int(20, 40); h = r.int(15, 30); dx = r.int(-6, 6); dy = r.int(-6, 6); }                   // large moves
  return { name: 'RT_COPY', args: [x, y, w, h, dx, dy], op: op.copy(x, y, w, h, dx, dy), cells: Math.max(0, Math.min(w, 32)) };
});
check('COPY: the stack stays within 20 bytes beyond the CALL', copyRes.depthMax <= 20, `${copyRes.depthMax} bytes`);
console.log(`  (deepest stack use measured: COPY ${copyRes.depthMax} bytes)`);
{ // hand-checked cases: a cell-by-cell identity of memmove
  const m = C.park(game), mdl = new C.Model5({ tiles });
  const r = rng(7);
  let bad = 0;
  for (const [ux, uy] of dirs) for (let rep = 0; rep < 40; rep++) {
    const st = randomState(r, 2);
    C.setCells(m, S, st.tile, st.attr); mdl.tile.set(st.tile); mdl.attr.set(st.attr);
    const w = r.int(2, 20), h = r.int(2, 14), x = r.int(4, 8), y = r.int(4, 8), k = r.int(1, 3);
    const res = trial(m, mdl, 'RT_COPY', {}, [x, y, w, h, x + ux * k, y + uy * k], op.copy(x, y, w, h, x + ux * k, y + uy * k));
    if (res.probs.length) bad++;
  }
  check('COPY by 1..3 cells in each of the 8 directions over overlapping rectangles: the memmove result (320 cases)', bad === 0, `${bad} wrong`);
}
{ // copy onto itself and a plain move, with dirty marking
  const m = C.park(game);
  const st = randomState(rng(3), 2);
  C.setCells(m, S, st.tile, st.attr); C.clearDirty(m, S);
  C.setArgs(m, S, [2, 2, 8, 8, 2, 2]);
  C.call(m, S.RT_COPY, {});
  check('COPY onto itself changes and marks nothing', C.dirtyCells(m, S.DIRTY0).length === 0 && A(C.cellsOf(m, S).tile).join() === A(st.tile).join());
}

{ // COPY: differences near +-256 (the 8-bit difference must not wrap), and sources / destinations far away
  const m = C.park(game), mdl = new C.Model5({ tiles });
  const r = rng(604);
  let bad = 0, first = null, n = 0;
  const diffs = [255, 256, 257, 261, -255, -256, -257, -261, 288, -288, 32, -32, 31, -31, 23, 24, -23, -24, 512 + 3, -512 - 3, 32767, -32768];
  for (const dd of diffs) for (const axis of [0, 1]) for (let rep = 0; rep < (Q < 1 ? 1 : 4); rep++) {
    const st = randomState(r, 2);
    C.setCells(m, S, st.tile, st.attr); mdl.tile.set(st.tile); mdl.attr.set(st.attr);
    const x = r.int(-3, 8), y = r.int(-3, 8);
    const a = axis === 0 ? [x, y, 32, 24, x + dd, y] : [x, y, 32, 24, x, y + dd];
    const res = trial(m, mdl, 'RT_COPY', {}, a, op.copy(...a));
    n++;
    if (res.probs.length) { bad++; first ??= { a, probs: res.probs.slice(0, 2) }; }
  }
  check(`RT_COPY: ${n} copies whose destination is 23..32 cells, 255..261 cells and more away (both axes) equal the model (nothing happens when they cannot overlap)`, bad === 0, first ? JSON.stringify(first) : '');
}

// ---- 3. LOADMAP ------------------------------------------------------------------------------------------------------------
console.log('\n3. RT_LOADMAP / RT_LOADMAPAT / RT_LOADMAPPTR');
const randomMap = (r, w, h) => ({ w, h, cells: Array.from({ length: w * h }, () => (r.chance(0.55) ? 0x80 | r.int(0, 8) : r.chance(0.8) ? r.int(32, 127) : r.int(0, 255))) });
const MAPSPOT = 0xE400;                        // RAM for a map record (RT_LOADMAPPTR reads anywhere)
{
  const bySize = [];
  const sizes = [[1, 1], [32, 24], [32, 1], [1, 24], [33, 25], [64, 48], [255, 255], [255, 1], [1, 255], [8, 8], [7, 3], [31, 23], [3, 17], [0, 5], [5, 0], [100, 30], [40, 24], [16, 16], [9, 9]];
  const per = Q < 1 ? 3 : 20;
  const r0 = rng(701);
  const pr = rng(702);
  const m = C.park(game);
  let bad = 0, first = null, n = 0, tSum = 0, cellsSum = 0, depthMax = 0;
  for (let k = 0; k < scale(3000); k++) {
    const [w, h] = k < sizes.length * per ? sizes[k % sizes.length] : [r0.int(0, 70), r0.int(0, 40)];
    if (w * h > 0xFF00 - MAPSPOT - 2) continue;
    const mp = randomMap(r0, w, h);
    m.ram.set([w, h, ...mp.cells.slice(0, Math.min(mp.cells.length, 0xFB00 - MAPSPOT - 2))], MAPSPOT);
    const mdl = new C.Model5({ tiles });
    const st = randomState(pr);
    C.setCells(m, S, st.tile, st.attr); mdl.tile.set(st.tile); mdl.attr.set(st.attr);
    let x, y;
    const mode = pr.int(0, 3);
    if (mode === 0) { x = coord(pr); y = coord(pr); } else if (mode === 1) { x = pr.int(-w - 2, 34); y = pr.int(-h - 2, 26); }
    else if (mode === 2) { x = pr.pick([0, 1, 31, 32, -1, -w + 1, -w, 24]); y = pr.pick([0, 1, 23, 24, -1, -h + 1, -h]); } else { x = pr.int(-3, 3); y = pr.int(-3, 3); }
    const res = trial(m, mdl, 'RT_LOADMAPPTR', { hl: MAPSPOT, bc: x & 0xFFFF, de: y & 0xFFFF }, null, { op: 'loadmapptr', rec: mp, x, y }, { diffRam: k % 30 === 0, pattern: k % 11 === 0 });
    n++; tSum += res.t; cellsSum += Math.min(32, w) * Math.min(24, h);
    depthMax = Math.max(depthMax, res.depth);
    if (res.depth > 20) { bad++; first ??= { k, why: 'stack ' + res.depth }; }
    if (res.probs.length) { bad++; first ??= { k, w, h, x, y, probs: res.probs.slice(0, 3) }; if (process.env.M5_QUICK) break; }
    bySize.push(res.t);
  }
  check(`RT_LOADMAPPTR: ${n} random maps (w, h 0..255, up to 8 KB) at random positions (edges, far away, negative) equal the model; dirty bits, registers, memory, stack (deepest use ${depthMax} bytes)`, bad === 0, first ? JSON.stringify(first) : '');
}
{ // the map table: several games, each with a table of maps, called by index, with and without a position
  let bad = 0, first = null, n = 0;
  for (let g = 0; g < 6; g++) {
    const r = rng(800 + g);
    const maps = Array.from({ length: g === 5 ? 8 : r.int(1, 5) }, (_, i) => randomMap(r, ...(i === 0 ? [r.int(1, 36), r.int(1, 26)] : [r.int(1, 20), r.int(1, 14)])));
    if (g === 4) maps[1].zeroPtr = true;
    const gm = C.opsGame({ tiles, maps, insts: [], assets: [], script: [] });
    const m = C.park(gm);
    for (let k = 0; k < scale(400); k++) {
      const mdl = new C.Model5({ tiles, maps });
      const st = randomState(r);
      C.setCells(m, S, st.tile, st.attr); mdl.tile.set(st.tile); mdl.attr.set(st.attr);
      const idx = r.chance(0.8) ? r.int(0, maps.length - 1) : r.int(0, 255);
      const at = r.chance(0.7);
      const x = r.int(-45, 38), y = r.int(-30, 28);
      const res = trial(m, mdl, at ? 'RT_LOADMAPAT' : 'RT_LOADMAP', at ? { a: idx, bc: x & 0xFFFF, de: y & 0xFFFF } : { a: idx, bc: 0x1234, de: 0x4321 }, null, at ? op.loadmapat(idx, x, y) : op.loadmap(idx));
      n++;
      if (res.probs.length) { bad++; first ??= { g, k, idx, at, x, y, probs: res.probs.slice(0, 3) }; if (process.env.M5_QUICK) break; }
    }
  }
  check(`RT_LOADMAP / RT_LOADMAPAT by index through the map table (6 games with 1..8 maps; bad indices, a zero pointer): ${n} calls equal the model`, bad === 0, first ? JSON.stringify(first) : '');
}

// ---- 4. the map table and the boot ---------------------------------------------------------------------------------------------
console.log('\n4. The header: the map table at boot, old headers');
{
  const r = rng(900);
  const maps = [randomMap(r, 20, 10), randomMap(r, 32, 24), randomMap(r, 5, 5)];
  const gm = C.opsGame({ tiles, maps, insts: [], assets: [], script: [] });
  const m = C.park(gm, 4);
  const mdl = new C.Model5({ tiles, maps });
  const got = C.cellsOf(m, S);
  check('boot: map 0 (20 x 10) is loaded at (0, 0) as LOADMAP would: its cells and attributes, the rest of the screen blank with BG_ATTR', A(got.tile).join() === A(mdl.tile).join() && A(got.attr).join() === A(mdl.attr).join());
  check('V_NMAP = 3, V_MAPTAB = the table + 1', rd8(m, S.V_NMAP) === 3 && rd16(m, S.V_MAPTAB) === C.OPS.MAPTAB + 1);
  check('V_BORDER = 1 (BORDER_COLOUR) after boot and the frame divisor is read without bit 7 (V_DIV = 1)', rd8(m, S.V_BORDER) === 1 && rd8(m, S.V_DIV) === 1);
  // dirty after boot: the first ticks draw map 0; the picture then equals the model
  const st = C.observe ? null : null; void st;
}
for (const [name, sp, wantN, wantTab] of [['count 9 is read as 8', { mapCount: 9, nine: true }, 8, true], ['count 0 = no maps', { mapCount: 0 }, 0, true]]) {
  const r = rng(901);
  const maps = Array.from({ length: name.startsWith('count 9') ? 9 : 2 }, () => randomMap(r, r.int(1, 12), r.int(1, 12)));
  const gm = C.opsGame({ tiles, maps, mapCount: sp.mapCount, insts: [], assets: [], script: [] });
  const m = C.park(gm, 4);
  const mdl = new C.Model5({ tiles, maps, mapCount: sp.mapCount });
  const got = C.cellsOf(m, S);
  check(`header: ${name}: V_NMAP = ${wantN}, boot cells equal the model (${wantN ? 'map 0 loaded' : 'blank screen: no map_ptr either'})`, rd8(m, S.V_NMAP) === wantN && A(got.tile).join() === A(mdl.tile).join() && wantTab);
}
{ // old header: no DIV_EXT: a map_ptr (raw 768 cells) boots as before, V_NMAP = 0, loadmap does nothing, and $8010 is not read as a pointer
  const r = rng(902);
  const raw = Array.from({ length: 768 }, () => (r.chance(0.5) ? 0x80 | r.int(0, 5) : r.int(32, 127)));
  const gm = C.opsGame({ tiles, ext: false, rawMap: raw, insts: [], assets: [], script: [] });
  const m = C.park(gm, 4);
  const mdl = new C.Model5({ tiles, ext: false, rawMap: raw });
  const got = C.cellsOf(m, S);
  check('old header (frame_div without bit 7, 16-byte header): map_ptr (768 raw cells) is loaded as before; V_NMAP = 0; the code at $8010 is not taken for a table', A(got.tile).join() === A(mdl.tile).join() && A(got.attr).join() === A(mdl.attr).join() && rd8(m, S.V_NMAP) === 0);
  C.setCells(m, S, got.tile, got.attr);
  const t0 = A(C.cellsOf(m, S).tile).join();
  C.call(m, S.RT_LOADMAP, { a: 0 });
  check('...RT_LOADMAP with no table does nothing', A(C.cellsOf(m, S).tile).join() === t0);
}
{ // with the table the old map_ptr is ignored
  const r = rng(903);
  const raw = Array.from({ length: 768 }, () => 0x80 | r.int(0, 5));
  const maps = [randomMap(r, 10, 6)];
  const gm = C.opsGame({ tiles, maps, rawMap: raw, insts: [], assets: [], script: [] });
  const m = C.park(gm, 4);
  const mdl = new C.Model5({ tiles, maps });
  check('map table with count >= 1: the old map_ptr is ignored (map 0 only, the rest blank)', A(C.cellsOf(m, S).tile).join() === A(mdl.tile).join());
  const gm2 = C.opsGame({ tiles, maps: [{ ...maps[0], zeroPtr: true }], rawMap: raw, insts: [], assets: [], script: [] });
  const m2 = C.park(gm2, 4);
  const mdl2 = new C.Model5({ tiles, maps: [{ ...maps[0], zeroPtr: true }], rawMap: raw });
  check('...but a zero map 0 pointer falls back to the old map_ptr', A(C.cellsOf(m2, S).tile).join() === A(mdl2.tile).join());
  const gm3 = C.opsGame({ tiles, maps, rawMap: raw, noMapTab: true, insts: [], assets: [], script: [] });
  const m3 = C.park(gm3, 4);
  check('...and an extended header with a null table pointer boots the old map_ptr too (V_NMAP = 0)', A(C.cellsOf(m3, S).tile).join() === raw.join() && rd8(m3, S.V_NMAP) === 0);
}

// ---- 5. BORDER and RANDOMISE -------------------------------------------------------------------------------------------------
console.log('\n5. RT_BORDER, RT_RANDOMISE');
{
  const m = C.park(game, 4);
  const writes = [];
  const o = m.bus.ioWrite; m.bus.ioWrite = (p, v) => { if ((p & 0xFF) === 0xFE) writes.push(v); o(p, v); };
  let bad = 0;
  for (let a = 0; a < 256; a++) {
    const res = C.call(m, S.RT_BORDER, { a });
    if (!res.preserved || !res.spOk || writes[writes.length - 1] !== (a & 7) || rd8(m, S.V_BORDER) !== (a & 7)) bad++;
  }
  check('RT_BORDER: A = 0..255: OUT ($FE) of A AND 7 (beeper and MIC bits 0), V_BORDER = A AND 7, registers preserved', bad === 0 && writes.length === 256, `${bad} wrong`);
  check('the machine\'s border register is the colour last written', m.border === 7);
}
{
  const m = C.park(game, 4);
  const seedOf = () => rd16(m, S.RT_SEED);
  let bad = 0, ramBad = 0;
  for (const s of [1, 2, 0xACE1, 0xFFFF, 0x8000, 0x7FFF, 0x1234]) {
    const before = Uint8Array.from(m.ram);
    const res = C.call(m, S.RT_RANDOMISE, { hl: s });
    if (seedOf() !== s || !res.preserved || !res.spOk) bad++;
    for (let a = 0x4000; a < 0x10000; a++) if (m.ram[a] !== before[a] && a !== S.RT_SEED && a !== S.RT_SEED + 1 && !(a >= S.STACK_CANARY && a < S.STACK_TOP)) { ramBad++; break; }
  }
  check('RT_RANDOMISE: HL = seed sets RT_SEED = HL; nothing else is written', bad === 0 && ramBad === 0, `${bad} wrong, ${ramBad} memory`);
  // HL = 0: the frame counter
  let zb = 0;
  for (let k = 0; k < 30; k++) {
    for (let f = 0; f < 1 + (k % 3); f++) M.runFrame(m);
    const fr = rd16(m, S.V_FRAMES);
    C.call(m, S.RT_RANDOMISE, { hl: 0 });
    if (seedOf() !== (fr || 1)) zb++;
  }
  check('RT_RANDOMISE with HL = 0 seeds from V_FRAMES (the low 16 bits)', zb === 0, `${zb} wrong`);
  m.ram[S.V_FRAMES] = 0; m.ram[S.V_FRAMES + 1] = 0;
  C.call(m, S.RT_RANDOMISE, { hl: 0 });
  check('...and a zero frame counter gives seed 1: RT_SEED is never left 0', seedOf() === 1);
  // the sequence after RANDOMISE n equals the model's xorshift
  const mdl = new C.Model5({ tiles });
  let rb = 0;
  for (const s of [1, 77, 0xACE1, 0xBEEF]) {
    C.call(m, S.RT_RANDOMISE, { hl: s });
    mdl.apply(op.randomise(s));
    for (let k = 0; k < 50; k++) { const res = C.call(m, S.RT_RND, {}); if (res.hl !== mdl.rndStep()) rb++; }
  }
  check('RT_RND after RT_RANDOMISE n follows the model xorshift from state n (4 seeds x 50 values)', rb === 0, `${rb} wrong`);
}

console.log('\nRESULTS-JSON ' + JSON.stringify({ fill: { tMax: fillRes.tMax }, copy: { tMax: copyRes.tMax } }));
finish('M5 runtime routines');
void int16; void Z;
