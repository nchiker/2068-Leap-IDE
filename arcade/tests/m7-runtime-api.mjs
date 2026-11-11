"use strict";
// m7-runtime-api.mjs -- runtime v3 part 2, the routines compiled code calls, by direct calls on a booted window game (stock TS2068, TSRun), against the
// models of m7-common.mjs (written from docs/ARCADE_PLATFORMER_CONTRACT.md 3b / 4 / 5 and docs/ARCADE_LANGUAGE_BATCH2.md decisions 8, 10-13):
//   1. RT_WORLDTILE / RT_TILEFLAGS / RT_TILEHIT / RT_SETWORLD on random worlds of several widths: random, edge and extreme arguments (-32768, 32767,
//      huge w and h, w or h <= 0, every corner of the world), SETWORLD between the queries (WORLD_RAM compared after each), the attribute caches;
//   2. RT_CAMERA: the signed clamp to 0..cam_max;
//   3. RT_SHOW / RT_SHOWF in window mode store x, y signed and unclamped (and the frame), RT_HIT on the stored world positions, exact (no 16-bit wrap);
//   4. every routine keeps IX, IY and the alternate set (sentinels), and its cost (T-states, CALL and RET included).
// Window fast path (docs/ARCADE_WINDOW_FASTPATH.md section 2 and 6): WORLD_RAM now carries class bits in bits 0-2 of every byte, kept exact by SETWORLD (the bytes
// x - 1, x, x + 1 of its row), so every WORLD_RAM comparison here is with the class-bit model (m7-common: classifyWorld); the collision routines must give the same results
// with the class bits present.  M7_OPTION=1 compares with the old runtime's plain bytes; the checks marked "new" then fail on it.
//   node arcade/tests/m7-runtime-api.mjs        (M7_QUICK=1: shorter)
import * as W from './m7-common.mjs';
import { rng } from './m3-scenes.mjs';
const { makeChecks, rd8, rd16, wr16, hex, int16 } = W;

const QUICK = !!process.env.M7_QUICK;
const { check, finish } = makeChecks();
const S = W.runtime().syms;
console.log('Runtime v3 part 2: collision, camera, SHOW and HIT in window mode (direct calls)\n');

const u16 = (v) => v & 0xFFFF;
const EXTREME = [-32768, -32767, -1025, -1024, -129, -128, -9, -8, -7, -1, 0, 1, 7, 8, 9, 127, 128, 129, 1015, 1016, 1023, 1024, 1025, 32767, 32766];
function setArgs(m, args) { args.forEach((v, k) => wr16(m, S.RT_ARGS + 2 * k, u16(v))); }

// ==================================================================================================================
console.log('1. Collision routines against the model');
let preservedAll = true, spOk = true;
const call = (m, addr, regs) => { const r = W.callRoutine(m, addr, regs); if (!r.preserved) preservedAll = false; if (!r.spOk) spOk = false; return r; };
const costs = { tilehit16x24: [], worldtile: [], tileflags: [], setworld: [] };
for (const [worldW, seed] of [[128, 101], [24, 102], [61, 103], [100, 104]]) {
  const r = rng(seed);
  const tiles = W.randomWinTiles(r, 32);
  const flags = Array.from({ length: 32 }, () => (r.chance(0.3) ? 0 : r.int(0, 255)));
  flags[0] = 0;
  const ram = W.randomWorld(r, worldW, 32, { sky: 0.5 });
  const win = { cx: 4, cy: 4, worldW, bands: [{ rows: 16, code: 3 }], ram, flags };
  const game = W.winGame({ tiles, win, script: [] });
  const m = W.bootIdle(game);
  const model = new W.Model7({ tiles, win });
  let n = 0, bad = 0, first = null, setBad = 0, invBad = 0;
  const pick = () => (r.chance(0.3) ? r.pick(EXTREME) + r.int(-1, 1) : r.chance(0.5) ? r.int(-40, worldW * 8 + 40) : r.int(-32768, 32767));
  const N = QUICK ? 1500 : 6000;
  for (let k = 0; k < N; k++) {
    const kind = r.int(0, 3);
    const x = int16(pick()), y = int16(r.chance(0.5) ? r.int(-20, 150) : pick());
    if (kind === 0) {
      const g = call(m, S.RT_WORLDTILE, { hl: u16(x), de: u16(y) });
      const e = W.colTile(model.ram, worldW, x, y);
      n++; if (g.hl !== e) { bad++; first ??= { op: 'WORLDTILE', x, y, got: g.hl, exp: e }; }
      costs.worldtile.push(g.t);
    } else if (kind === 1) {
      const g = call(m, S.RT_TILEFLAGS, { hl: u16(x), de: u16(y) });
      const e = W.colFlags(model.ram, worldW, flags, x, y);
      n++; if (g.hl !== e) { bad++; first ??= { op: 'TILEFLAGS', x, y, got: g.hl, exp: e }; }
      costs.tileflags.push(g.t);
    } else if (kind === 2) {
      const wv = int16(r.chance(0.2) ? r.pick([-32768, -1, 0, 1, 2, 7, 8, 9, 16, 32767, 32766, 2000, 20000]) : r.int(-3, 60));
      const hv = int16(r.chance(0.2) ? r.pick([-32768, -1, 0, 1, 2, 7, 8, 9, 16, 32767, 32766, 2000, 20000]) : r.int(-3, 60));
      const mask = r.chance(0.3) ? r.pick([0, 1, 2, 4, 255, 0xFFFF, 0x100, 0xFF00, 0x8001]) : r.int(0, 0xFFFF);
      setArgs(m, [x, y, wv, hv, mask]);
      const g = call(m, S.RT_TILEHIT);
      const e = W.colHit(model.ram, worldW, flags, x, y, wv, hv, mask);
      n++; if (g.hl !== e) { bad++; first ??= { op: 'TILEHIT', x, y, w: wv, h: hv, mask, got: g.hl, exp: e }; }
    } else {
      const t = r.int(0, 31);
      const sx = r.chance(0.8) ? r.int(-16, worldW * 8 + 16) : x, sy = r.chance(0.8) ? r.int(-16, 140) : y;
      for (let i = 0; i < 8; i++) m.ram[S.W_AC + i] = 0x11 * i;
      const c = Math.floor(sx / 8), rr = Math.floor(sy / 8), inside = c >= 0 && c < worldW && rr >= 0 && rr < 16;
      const old = inside ? model.ram[rr * 128 + c] : 0;
      setArgs(m, [sx, sy, 0, 0, t]);
      const g = call(m, S.RT_SETWORLD);
      costs.setworld.push(g.t);
      model.apply({ op: 'setworld', x: sx, y: sy, t });
      const want = model.worldRam();
      if (!m.ram.slice(S.WORLD_RAM, S.WORLD_RAM + 2048).every((v, i) => v === want[i])) { setBad++; first ??= { op: 'SETWORLD', sx, sy, t }; }
      // attribute caches: invalidated (all $FF) exactly when the new tile's attribute differs from the old one's
      const attrDiffers = inside && tiles[old >> 3].attr !== tiles[t].attr;
      const inv = Array.from({ length: 8 }, (_, i) => m.ram[S.W_AC + i]);
      if (attrDiffers ? !inv.every((v) => v === 0xFF) : !inv.every((v, i) => v === 0x11 * i)) invBad++;
    }
  }
  // the 16 x 24 boxes the contract costs: every alignment
  for (let k = 0; k < 64; k++) { setArgs(m, [r.int(0, worldW * 8 - 24), r.int(0, 100), 16, 24, 1]); costs.tilehit16x24.push(call(m, S.RT_TILEHIT).t); }
  // every corner and edge of the world with tiny and huge rectangles
  let edgeBad = 0, edgeN = 0;
  for (const x of [-32768, -9, -8, -1, 0, 7, 8, worldW * 8 - 9, worldW * 8 - 8, worldW * 8 - 1, worldW * 8, worldW * 8 + 7, 32767]) {
    for (const y of [-32768, -9, -1, 0, 7, 8, 119, 120, 127, 128, 135, 32767]) {
      for (const [wv, hv] of [[1, 1], [2, 2], [9, 9], [32767, 1], [1, 32767], [32767, 32767], [0, 5], [5, 0], [-1, 5]]) {
        setArgs(m, [x, y, wv, hv, 0xFF]);
        edgeN++;
        if (call(m, S.RT_TILEHIT).hl !== W.colHit(model.ram, worldW, flags, x, y, wv, hv, 0xFF)) edgeBad++;
      }
      edgeN += 2;
      if (call(m, S.RT_TILEFLAGS, { hl: u16(x), de: u16(y) }).hl !== W.colFlags(model.ram, worldW, flags, x, y)) edgeBad++;
      if (call(m, S.RT_WORLDTILE, { hl: u16(x), de: u16(y) }).hl !== W.colTile(model.ram, worldW, x, y)) edgeBad++;
    }
  }
  check(`world ${worldW} wide: ${n} random queries (WORLDTILE / TILEFLAGS / TILEHIT incl. extreme values, w or h <= 0, every mask) with SETWORLD between them equal the model; WORLD_RAM equal after every SETWORLD${W.CLASS_BITS ? ' (class bits included)' : ''}`,
    bad === 0 && setBad === 0, first ? JSON.stringify(first) : '');
  check(`world ${worldW} wide: SETWORLD invalidates every band's attribute cache (both files) exactly when the tile's attribute changes`, invBad === 0, `${invBad} wrong`);
  check(`world ${worldW} wide: ${edgeN} queries at every corner and edge (x, y in -32768, -9 .. 8 w + 7, 32767; rectangles 1x1 .. 32767x32767, empty) equal the model`, edgeBad === 0, `${edgeBad} wrong`);
}
check('the collision routines keep IX, IY and the alternate set, and the stack balanced, in every call', preservedAll && spOk);
const mx = (a) => Math.max(...a), mn = (a) => Math.min(...a);
console.log(`  costs (T, CALL + RET): WORLDTILE ${mn(costs.worldtile)}..${mx(costs.worldtile)}, TILEFLAGS ${mn(costs.tileflags)}..${mx(costs.tileflags)}, TILEHIT of a 16x24 box ${mn(costs.tilehit16x24)}..${mx(costs.tilehit16x24)}, SETWORLD ${mn(costs.setworld)}..${mx(costs.setworld)}`);
check('RT_TILEHIT of a 16 x 24 box costs <= 1,500 T (contract section 4)', mx(costs.tilehit16x24) <= 1500, `max ${mx(costs.tilehit16x24)} T`);

// ---- new: the class bits after RT_SETWORLD at the edges of the world and inside, on worlds with blank tiles other than 0 ------------------------------------------
console.log('\n1b. RT_SETWORLD keeps the class bits exact (docs/ARCADE_WINDOW_FASTPATH.md sections 2 and 6): columns 0, 1, W - 2, W - 1 and inside; worlds 24, 25, 61, 128 wide');
{
  const CW = W.caseWorld(1802);
  const nEdge = [];
  let total = 0, bad = 0, incrBad = 0, first = null;
  for (const worldW of [24, 25, 61, 128]) {
    const win = { cx: 4, cy: 4, worldW, bands: [{ rows: 16, code: 3 }], ram: CW.ram, flags: [] };
    const m = W.bootIdle(W.winGame({ tiles: CW.tiles, win, script: [] }));
    const model = new W.Model7({ tiles: CW.tiles, win });
    let cls = W.classifyWorld(model.ram, worldW, CW.rows, CW.attr);                     // the model's incremental copy (setWorldClassed), kept next to the full re-classification
    const apply = (c, rr, t) => {
      const sx = c * 8 + (c & 7), sy = rr * 8 + ((c + rr) & 7);
      setArgs(m, [sx, sy, 0, 0, t]);
      const g = call(m, S.RT_SETWORLD);
      costs.setworld.push(g.t);
      model.apply({ op: 'setworld', x: sx, y: sy, t });
      cls = W.setWorldClassed(cls, worldW, CW.rows, CW.attr, sx, sy, t);
      const want = W.classifyWorld(model.ram, worldW, CW.rows, CW.attr), got = m.ram.slice(S.WORLD_RAM, S.WORLD_RAM + 2048);
      total++;
      if (!cls.every((v, i) => v === want[i])) incrBad++;
      if (!got.every((v, i) => v === want[i])) { bad++; first ??= { worldW, c, rr, t, at: got.findIndex((v, i) => v !== want[i]) }; }
    };
    // 1. every tile kind at the edge columns and inside, three rows
    for (const c of [0, 1, 2, worldW - 3, worldW - 2, worldW - 1, worldW >> 1, (worldW >> 1) + 1]) for (const t of [0, 1, 2, 3, 4, 5, 6, 7, 9, 31]) for (const rr of [0, 8, 15]) apply(c, rr, t);
    // 2. a blank tile set next to blank and to non-blank tiles: row 5 all blank (tile 0), then tile 1 (blank, other colours), tile 2 (blank twin), tile 3 (ordinary) and back, at several columns
    for (let c = 0; c < worldW; c++) apply(c, 5, 0);
    for (const c of [0, 1, worldW >> 1, worldW - 2, worldW - 1]) for (const t of [1, 2, 3, 0, 7, 6, 2, 0]) apply(c, 5, t);
    // 3. neighbours: blank 1 between two blanks, then the right one made ordinary, then the left one
    { const c = Math.max(2, Math.min(worldW - 3, worldW >> 1)); apply(c - 1, 6, 0); apply(c, 6, 1); apply(c + 1, 6, 0); apply(c + 1, 6, 3); apply(c - 1, 6, 3); apply(c, 6, 0); apply(c, 6, 5); }
    // 4. random cells and tiles
    const q = rng(1900 + worldW);
    for (let k = 0; k < (QUICK ? 150 : 600); k++) apply(q.chance(0.3) ? q.pick([0, 1, worldW - 2, worldW - 1]) : q.int(0, worldW - 1), q.int(0, 15), q.chance(0.5) ? q.pick([0, 1, 2, 3, 7]) : q.int(0, 31));
    // outside the world: nothing changes
    for (const [sx, sy] of [[-1, 0], [worldW * 8, 0], [0, -1], [0, 128], [-32768, 5], [32767, 5]]) { setArgs(m, [sx, sy, 0, 0, 3]); call(m, S.RT_SETWORLD); }
    const want = W.classifyWorld(model.ram, worldW, CW.rows, CW.attr);
    nEdge.push(m.ram.slice(S.WORLD_RAM, S.WORLD_RAM + 2048).every((v, i) => v === want[i]));
  }
  check(`new: after ${total} RT_SETWORLD calls (columns 0, 1, 2, W - 3 .. W - 1 and inside, every kind of tile, blank tiles next to blank and non-blank ones, random cells; worlds 24, 25, 61, 128 wide) WORLD_RAM equals the class-bit model byte for byte after each call; out-of-world calls change nothing (${nEdge.filter(Boolean).length} of 4 worlds)`,
    bad === 0 && incrBad === 0 && nEdge.every(Boolean), `${first ? JSON.stringify(first) + '; ' : ''}${bad} wrong, ${incrBad} model mismatches`);
}

console.log(`  costs (T, CALL + RET), RT_SETWORLD over every call above and in 1b: ${mn(costs.setworld)}..${mx(costs.setworld)}`);
check('RT_SETWORLD costs <= 1,000 T with the class update (window fast-path contract section 4; before it 113..596)', mx(costs.setworld) <= 1000, `max ${mx(costs.setworld)} T`);

// ==================================================================================================================
console.log('\n2. RT_CAMERA: signed clamp to 0..cam_max');
{
  const r = rng(201);
  let bad = 0, n = 0;
  for (const [bands, worldW] of [[[{ rows: 16, code: 3 }], 128], [[{ rows: 8, code: 3 }, { rows: 8, code: 4 }], 128], [[{ rows: 16, code: 1 }], 24], [[{ rows: 16, code: 3 }], 50]]) {
    const win = { cx: 4, cy: 4, worldW, bands, ram: W.randomWorld(r, worldW, 32) };
    const game = W.winGame({ tiles: W.randomWinTiles(r, 32), win, script: [] });
    const m = W.bootIdle(game);
    const cmax = W.camMaxOf(worldW, bands);
    for (const v of [-32768, -1, 0, 1, cmax - 1, cmax, cmax + 1, 32767, 32768, 65535, ...Array.from({ length: QUICK ? 50 : 300 }, () => r.int(-40000, 70000))]) {
      call(m, S.RT_CAMERA, { hl: u16(v) });
      const e = int16(u16(v)) < 0 ? 0 : Math.min(int16(u16(v)), cmax);
      n++; if (rd16(m, S.V_CAM) !== e) bad++;
    }
  }
  check(`${n} camera requests (incl. -32768, -1, cam_max +- 1, 32767, 32768 = -32768) give V_CAM = the signed value clamped to 0..cam_max (cam_max 832, 416, 0, 208)`, bad === 0, `${bad} wrong`);
}

// ==================================================================================================================
console.log('\n3. RT_SHOW / RT_SHOWF / RT_HIT in window mode');
{
  const r = rng(301);
  const assets = [W.randomAsset(r, 16, 24, 4, 3, { hot: [2, 1, 12, 22] }), W.randomAsset(r, 8, 8, 8, 2), W.randomAsset(r, 32, 48, 2, 1, { hot: [255, 255, 255, 255] }), W.randomAsset(r, 16, 16, 4, 1, { hot: [3, 3, 0, 5] })];
  const insts = [0, 1, 2, 3, 0, 1, 2, 3];
  const win = { cx: 4, cy: 4, worldW: 128, bands: [{ rows: 16, code: 3 }], ram: W.randomWorld(r, 128, 32) };
  const tiles = W.randomWinTiles(r, 32);
  const game = W.winGame({ tiles, win, assets, insts, script: [] });
  const m = W.bootIdle(game);
  const model = new W.Model7({ tiles, win, assets, insts });
  const V = () => (r.chance(0.3) ? r.pick([-32768, -32767, -300, -1, 0, 1, 255, 256, 32767, 32766, 32512]) + r.int(-2, 2) : r.int(-500, 1500));
  let bad = 0, hitBad = 0, hits = 0, n = 0, first = null;
  for (let k = 0; k < (QUICK ? 3000 : 12000); k++) {
    const i = r.int(0, 9), x = int16(V()), y = int16(V());
    const kind = r.int(0, 3);
    if (kind === 0) { call(m, S.RT_SHOW, { a: i, bc: u16(x), de: u16(y) }); model.apply({ op: 'show', i, x, y }); }
    else if (kind === 1) { const f = r.int(0, 0xFFFF); call(m, S.RT_SHOWF, { a: i, bc: u16(x), de: u16(y), hl: f }); model.apply({ op: 'showf', i, x, y, f }); }
    else if (kind === 2) { if (r.chance(0.2)) { call(m, S.RT_HIDE, { a: i }); model.apply({ op: 'hide', i }); } }
    else {
      const a = r.int(0, 9), b = r.int(0, 9);
      const g = call(m, S.RT_HIT, { a, de: b }).hl, e = model.hit(a, b);
      hits += e; n++;
      if (g !== e) { hitBad++; first ??= { a, b, got: g, exp: e, A: model.insts[a], B: model.insts[b] }; }
    }
    // SPR_TAB = the model's entries (visible, asset, x, y signed 16-bit, frame)
    for (let j = 0; j < insts.length; j++) {
      const e = model.insts[j], at = S.SPR_TAB + 8 * j;
      if (rd8(m, at) !== (e.visible ? 1 : 0) || rd8(m, at + 1) !== e.asset || (rd16(m, at + 2) !== u16(e.x) || rd16(m, at + 4) !== u16(e.y) || rd8(m, at + 6) !== e.frame)) { bad++; first ??= { j, k, e }; break; }
    }
  }
  check('RT_SHOW / RT_SHOWF store x, y unclamped (signed 16-bit), the frame AND $FF (RT_SHOW keeps it), RT_HIDE: SPR_TAB equals the model after every call; an index >= ninst does nothing', bad === 0, first ? JSON.stringify(first) : '');
  check(`RT_HIT on the stored world positions, exact (boxes at x = -32768 or 32767 + offsets up to 255 do not wrap): ${n} pairs, ${hits} hits, equal the model`, hitBad === 0 && hits > 20, first ? JSON.stringify(first) : '');
  // the wrap cases explicitly: a box at 32767 + 255 and one at -32768 overlap after a 16-bit wrap, not exactly
  // instances 2 and 6 are the 32x48 asset with the hot box (255, 255, 255, 255): at x = 32767 its box is [33022, 33277), at x = -32768 + 1 it is
  // [-32512, -32257): a 16-bit sum puts the first at [-32514, -32259) and they would overlap; exactly they are 65,534 apart
  call(m, S.RT_SHOW, { a: 2, bc: 32767, de: 0 }); call(m, S.RT_SHOW, { a: 6, bc: u16(-32768 + 1), de: 0 });
  call(m, S.RT_SHOW, { a: 0, bc: u16(-32768), de: u16(-32768) }); call(m, S.RT_SHOW, { a: 4, bc: u16(-32768 + 10), de: u16(-32768 + 20) });
  const hw = call(m, S.RT_HIT, { a: 2, de: 6 }).hl, hw2 = call(m, S.RT_HIT, { a: 0, de: 4 }).hl, hw3 = call(m, S.RT_HIT, { a: 6, de: 2 }).hl;
  // differences of 65,536 and more must keep their sign: a (32x48, hot 255,255,255,255) at x = 32767 is 65,776 pixels right of b (hot 2,1,12,22) at -32768,
  // with the y ranges overlapping; and the same along y
  call(m, S.RT_SHOW, { a: 2, bc: 32767, de: 0 }); call(m, S.RT_SHOW, { a: 0, bc: u16(-32768), de: 250 });
  const far1 = call(m, S.RT_HIT, { a: 2, de: 0 }).hl, far2 = call(m, S.RT_HIT, { a: 0, de: 2 }).hl;
  call(m, S.RT_SHOW, { a: 2, bc: 0, de: 32767 }); call(m, S.RT_SHOW, { a: 0, bc: 250, de: u16(-32768) });
  const far3 = call(m, S.RT_HIT, { a: 2, de: 0 }).hl, far4 = call(m, S.RT_HIT, { a: 0, de: 2 }).hl;
  check('two boxes 65,534 pixels apart that a 16-bit sum would put on top of each other (x = 32767 and -32767, offsets 255) do not hit; two boxes near (-32768, -32768) do; boxes 65,776 apart along x or y (the other axis overlapping) do not',
    hw === 0 && hw3 === 0 && hw2 === 1 && far1 === 0 && far2 === 0 && far3 === 0 && far4 === 0, `${hw} ${hw3} ${hw2} ${far1} ${far2} ${far3} ${far4}`);
  const t = (addr, regs) => W.callRoutine(m, addr, regs).t;
  console.log(`  costs: RT_SHOW ${t(S.RT_SHOW, { a: 0, bc: 1000, de: u16(-5) })}, RT_SHOWF ${t(S.RT_SHOWF, { a: 0, bc: 1000, de: 5, hl: 3 })}, RT_HIT (both visible) ${t(S.RT_HIT, { a: 0, de: 4 })}, RT_CAMERA ${t(S.RT_CAMERA, { hl: 300 })} T`);
}
check('every routine called here kept IX, IY, the alternates and SP', preservedAll && spOk);

finish('runtime v3 part 2, routines');
void hex;
