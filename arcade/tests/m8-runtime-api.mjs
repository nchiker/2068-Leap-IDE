"use strict";
// m8-runtime-api.mjs -- runtime v4, the routines compiled code calls (contract section 2) against the JS model of m8-common.mjs, called directly on a
// booted machine (TSRun, stock ROMs) with sentinels in the alternate registers, IX and IY:
//   RT_COSA / RT_SINA (every angle, high bytes ignored), RT_FXMUL (fuzz with the extremes), RT_WALL / RT_SETWALL (against the map model, the whole
//   array compared after every write, the ring rule), RT_VIEW (the clamps), RT_SHOW / RT_SHOWF / RT_HIDE / RT_HIT in ray mode; the same routines in a
//   game without a view (non-ray mode).
//   node arcade/tests/m8-runtime-api.mjs        (M8_QUICK=1: shorter)
import * as R from './m8-common.mjs';
import { rng } from './m3-scenes.mjs';
const { makeChecks, rd8, rd16, callRoutine, hex } = R;

const QUICK = !!process.env.M8_QUICK;
const { check, finish } = makeChecks();
const S = R.runtime().syms;
console.log('Runtime v4: the routines of contract section 2\n');
const r = rng(811);
let preservedBad = 0, spBad = 0;
function call(m, name, regs) { const o = callRoutine(m, S[name], regs); if (!o.preserved) preservedBad++; if (!o.spOk) spBad++; return o; }
const s16 = R.s16;

const mw = 23, mh = 31, cells = R.randomCells(r, mw, mh, 0.3);
const assets = [R.randomAsset(r, 16, 16, 1, 2), R.randomAsset(r, 32, 48, 1, 1), R.randomAsset(r, 8, 5, 1, 1)];
const insts = [0, 1, 2, 0, 1, 2, 0];
const game = R.rayGame({ view: { colw: 4, mw, mh, cells }, assets, insts });
const m = R.bootIdle(game, 4);
const model = new R.Model8(game.spec);

// ---- COSA / SINA ------------------------------------------------------------------------------------------------------------
{
  let bad = 0, n = 0;
  for (let a = -600; a < 1100; a++) {
    const hl = a & 0xFFFF;
    if (s16(call(m, 'RT_COSA', { hl }).hl) !== R.cosa8(a & 255)) bad++;
    if (s16(call(m, 'RT_SINA', { hl }).hl) !== R.sina8(a & 255)) bad++;
    n += 2;
  }
  check(`RT_COSA / RT_SINA = (C[a AND 255] + 8) >> 4 for HL = -600..1099 (${n} calls; -256..256)`, bad === 0, `${bad} differ`);
  check('COSA(0) = 256, COSA(64) = 0, COSA(128) = -256, SINA(64) = 256, SINA(192) = -256 (angle 64 looks along +y)',
    s16(call(m, 'RT_COSA', { hl: 0 }).hl) === 256 && s16(call(m, 'RT_COSA', { hl: 64 }).hl) === 0 && s16(call(m, 'RT_COSA', { hl: 128 }).hl) === -256 &&
    s16(call(m, 'RT_SINA', { hl: 64 }).hl) === 256 && s16(call(m, 'RT_SINA', { hl: 192 }).hl) === -256);
}

// ---- FXMUL ---------------------------------------------------------------------------------------------------------------------
{
  const ext = [0, 1, -1, 2, -2, 255, 256, -256, 257, 32767, -32768, -32767, 16384, -16384, 12345, -4096, 4096];
  const pairs = [];
  for (const a of ext) for (const b of ext) pairs.push([a, b]);
  for (let k = 0; k < (QUICK ? 1500 : 4000); k++) pairs.push([r.int(-32768, 32767), r.pick([r.int(-32768, 32767), r.int(-300, 300), r.int(-5, 5)])]);
  let bad = 0, first = null;
  for (const [a, b] of pairs) { const got = s16(call(m, 'RT_FXMUL', { hl: a & 0xFFFF, de: b & 0xFFFF }).hl), exp = R.fxmul(a, b); if (got !== exp) { bad++; first ??= `${a} * ${b}: ${got} / ${exp}`; } }
  check(`RT_FXMUL = floor(a b / 256) of the exact 32-bit product, wrapped to 16 bits (${pairs.length} pairs incl. the extremes)`, bad === 0, first ?? '');
}

// ---- WALL / SETWALL --------------------------------------------------------------------------------------------------------------
{
  let bad = 0, first = null, q = 0, mapBad = 0, writes = 0, refused = 0;
  const pos = () => r.pick([r.int(-40000, 40000), r.int(-512, 9000), r.int(0, mw * 256 + 600), 0, 255, 256, mw * 256 - 1, mw * 256, 8191, 8192, -1, -256, 32767, -32768]);
  for (let round = 0; round < (QUICK ? 40 : 120); round++) {
    for (let k = 0; k < 25; k++) {
      const x = pos(), y = r.pick([pos(), r.int(0, mh * 256 + 600)]);
      const got = call(m, 'RT_WALL', { hl: x & 0xFFFF, de: y & 0xFFFF }).hl, exp = R.wallAt(model.map, x, y);
      q++;
      if (got !== exp) { bad++; first ??= `WALL(${x}, ${y}) = ${got} / ${exp}`; }
    }
    for (let k = 0; k < 4; k++) {
      const ring = r.chance(0.3);
      const x = ring ? r.pick([0, (mw - 1)]) * 256 + r.int(0, 255) : pos(), y = ring ? r.int(0, mh - 1) * 256 : r.pick([pos(), r.int(0, mh * 256 + 600)]);
      const t = r.pick([0, 0, 1, 2, 3, 4, 5, 255, 256, 0xFFFF, r.int(0, 4)]);
      R.wr16(m, S.RA_X, x & 0xFFFF); R.wr16(m, S.RA_Y, y & 0xFFFF); R.wr16(m, S.RA_V, t);
      const before = m.ram.slice(S.MAP_RAM, S.MAP_RAM + 1024).join();
      call(m, 'RT_SETWALL', {});
      R.setWall(model.map, mw, mh, x, y, t);
      const after = m.ram.slice(S.MAP_RAM, S.MAP_RAM + 1024).join();
      if (after !== before) writes++; else refused++;
      for (let i = 0; i < 1024; i++) if (m.ram[S.MAP_RAM + i] !== model.map[i]) { mapBad++; break; }
    }
  }
  check(`RT_WALL against the model (${q} queries: inside, outside the map but in the array (1), outside the array and negative (1))`, bad === 0, first ?? '');
  check(`RT_SETWALL: the whole 32 x 32 array equals the model after every call (${writes} writes, ${refused} ignored: outside the map, types 0..4 only, no 0 on the array's ring)`,
    mapBad === 0 && writes > (QUICK ? 15 : 50) && refused > (QUICK ? 15 : 50), `${mapBad} differ`);
  // the ring rule on a 32 x 32 map
  const g32 = R.rayGame({ view: { colw: 2, mw: 32, mh: 32, cells: R.randomCells(r, 32, 32) } });
  const m32 = R.bootIdle(g32, 3);
  let ringOk = true;
  for (const [x, y] of [[0, 5], [31, 7], [9, 0], [12, 31], [0, 0], [31, 31]]) {
    const before = rd8(m32, S.MAP_RAM + y * 32 + x);
    R.wr16(m32, S.RA_X, x * 256 + 100); R.wr16(m32, S.RA_Y, y * 256 + 3); R.wr16(m32, S.RA_V, 0);
    callRoutine(m32, S.RT_SETWALL, {});
    if (rd8(m32, S.MAP_RAM + y * 32 + x) !== before || before === 0) ringOk = false;
    R.wr16(m32, S.RA_V, 3);
    callRoutine(m32, S.RT_SETWALL, {});
    if (rd8(m32, S.MAP_RAM + y * 32 + x) !== 3) ringOk = false;
  }
  R.wr16(m32, S.RA_X, 5 * 256); R.wr16(m32, S.RA_Y, 6 * 256); R.wr16(m32, S.RA_V, 0);
  callRoutine(m32, S.RT_SETWALL, {});
  check('32 x 32 map: SETWALL 0 on the outer ring is ignored (a ray always stops inside the array), types 1..4 are written there, 0 inside the ring is written',
    ringOk && rd8(m32, S.MAP_RAM + 6 * 32 + 5) === 0);
}

// ---- VIEW ------------------------------------------------------------------------------------------------------------------------
{
  let bad = 0, first = null;
  const vals = [0, 1, -1, -32768, 32767, mw * 256 - 1, mw * 256, mh * 256 - 1, mh * 256, 40000, 255, 256];
  for (let k = 0; k < (QUICK ? 300 : 1000); k++) {
    const x = r.chance(0.3) ? r.pick(vals) : r.int(-3000, 12000), y = r.chance(0.3) ? r.pick(vals) : r.int(-3000, 12000), a = r.int(-2000, 2000);
    call(m, 'RT_VIEW', { hl: x & 0xFFFF, de: y & 0xFFFF, bc: a & 0xFFFF });
    const ex = R.clampPos(x, mw * 256 - 1), ey = R.clampPos(y, mh * 256 - 1);
    if (rd16(m, S.RV_X) !== ex || rd16(m, S.RV_Y) !== ey || rd8(m, S.RV_A) !== (a & 255)) { bad++; first ??= `VIEW(${x}, ${y}, ${a})`; }
  }
  check('RT_VIEW: x, y clamped to 0..map_w * 256 - 1 / map_h * 256 - 1 (signed), the angle AND 255', bad === 0, first ?? '');
}

// ---- SHOW / SHOWF / HIDE / HIT in ray mode -----------------------------------------------------------------------------------
{
  let bad = 0, first = null, hitBad = 0, hits = 0, hitFirst = null, n = 0;
  const big = () => r.pick([r.int(0, 65535), r.int(0, 9000), 0, 65535, 32768, 32767]);
  for (let k = 0; k < (QUICK ? 2000 : 6000); k++) {
    const i = r.int(0, 8), x = big(), y = big(), kind = r.int(0, 3);
    if (kind === 0) { call(m, 'RT_SHOW', { a: i, bc: x, de: y }); model.apply(R.op.show(i, x, y)); }
    else if (kind === 1) { const f = r.int(0, 600); call(m, 'RT_SHOWF', { a: i, bc: x, de: y, hl: f }); model.apply(R.op.showf(i, x, y, f)); }
    else if (kind === 2) { call(m, 'RT_HIDE', { a: i }); model.apply(R.op.hide(i)); }
    else {
      const a = r.int(0, 8), b = r.int(0, 8);
      if (r.chance(0.5) && a < insts.length && b < insts.length) {      // near each other
        const sa = model.insts[a], nx = (sa.x + r.int(-450, 450)) & 0xFFFF, ny = (sa.y + r.int(-450, 450)) & 0xFFFF;
        call(m, 'RT_SHOW', { a: b, bc: nx, de: ny }); model.apply(R.op.show(b, nx, ny));
      }
      const got = call(m, 'RT_HIT', { a, de: b }).hl, exp = model.hit(a, b);
      if (got !== exp) { hitBad++; hitFirst ??= `HIT(${a}, ${b}) = ${got} / ${exp}`; }
      hits += exp; n++;
    }
    for (let j = 0; j < insts.length; j++) {
      const e = S.SPR_TAB + 8 * j, s = model.insts[j];
      if (rd8(m, e) !== (s.visible ? 1 : 0) || (s.visible || rd8(m, e)) && (rd16(m, e + 2) !== s.x || rd16(m, e + 4) !== s.y || rd8(m, e + 6) !== s.frame)) { bad++; first ??= `call ${k}, instance ${j}`; break; }
    }
  }
  // exact boundaries: |d| = Ra + Rb - 1 hits, Ra + Rb does not (strict), on each axis and both signs, across the 16-bit wrap too
  let bnd = 0, bndBad = 0;
  for (let k = 0; k < 300; k++) {
    const a = r.int(0, insts.length - 1), b = r.int(0, insts.length - 1);
    if (a === b) continue;
    const Sab = 4 * (model.assets[model.insts[a].asset].h + model.assets[model.insts[b].asset].h);
    const xa = r.pick([r.int(0, 65535), 0, 65535, 400]), ya = r.int(0, 65535), d = Sab + r.pick([-1, 0, 1]), sgn = r.pick([1, -1]), axisX = r.chance(0.5);
    const xb = axisX ? (xa + sgn * d) & 0xFFFF : xa, yb = axisX ? ya : (ya + sgn * d) & 0xFFFF;
    for (const [i, x, y] of [[a, xa, ya], [b, xb, yb]]) { call(m, 'RT_SHOW', { a: i, bc: x, de: y }); model.apply(R.op.show(i, x, y)); }
    const got = call(m, 'RT_HIT', { a, de: b }).hl;
    if (got !== model.hit(a, b)) bndBad++;
    bnd++;
  }
  check(`RT_HIT at the exact boundaries (|d| = Ra + Rb - 1, Ra + Rb, Ra + Rb + 1; ${bnd} pairs)`, bndBad === 0, `${bndBad} differ`);
  check('RT_SHOW / RT_SHOWF / RT_HIDE in ray mode: SPR_TAB equals the model after every call (x, y unsigned 8.8 stored as given, no clamp; the frame AND $FF; an index >= ninst ignored)',
    bad === 0, first ?? '');
  check(`RT_HIT in ray mode: |dx| < Ra + Rb and |dy| < Ra + Rb, R = 4 h, exact 16-bit differences; hidden or missing instances never hit (${n} pairs, ${hits} hits)`,
    hitBad === 0 && hits > (QUICK ? 20 : 50) && n - hits > 50, hitFirst ?? '');
}
check('every routine call kept IX, IY and the alternate registers, and SP', preservedBad === 0 && spBad === 0, `${preservedBad} / ${spBad}`);

// ---- non-ray mode ------------------------------------------------------------------------------------------------------------
{
  const g = R.rayGame({ assets, insts });
  const mn = R.bootIdle(g, 4);
  let ok = rd8(mn, S.V_RAY) === 0;
  for (let a = 0; a < 256; a++) if (s16(callRoutine(mn, S.RT_COSA, { hl: a }).hl) !== R.cosa8(a) || s16(callRoutine(mn, S.RT_SINA, { hl: a }).hl) !== R.sina8(a)) ok = false;
  for (let k = 0; k < 200; k++) { const a = r.int(-32768, 32767), b = r.int(-32768, 32767); if (s16(callRoutine(mn, S.RT_FXMUL, { hl: a & 0xFFFF, de: b & 0xFFFF }).hl) !== R.fxmul(a, b)) ok = false; }
  const w0 = callRoutine(mn, S.RT_WALL, { hl: 0x300, de: 0x400 }).hl, w1 = callRoutine(mn, S.RT_WALL, { hl: 0x2000, de: 0x400 }).hl;
  R.wr16(mn, S.RA_X, 0x300); R.wr16(mn, S.RA_Y, 0x400); R.wr16(mn, S.RA_V, 2);
  callRoutine(mn, S.RT_SETWALL, {});
  let z = true;
  for (let i = 0; i < 0x800; i++) if (rd8(mn, S.WORLD_RAM + i) !== 0) z = false;
  callRoutine(mn, S.RT_VIEW, { hl: 0x1234, de: 0x2345, bc: 77 });
  check('non-ray mode: COSA, SINA, FXMUL as in ray mode; WALL 0 inside the array (nothing loaded), 1 outside; SETWALL writes nothing; VIEW clamps to 0',
    ok && w0 === 0 && w1 === 1 && z && rd16(mn, S.RV_X) === 0 && rd16(mn, S.RV_Y) === 0 && rd8(mn, S.RV_A) === 77);
  callRoutine(mn, S.RT_SHOW, { a: 0, bc: 300, de: 50 });
  check('non-ray mode: RT_SHOW clamps as v3 (x 0..256 - w)', rd16(mn, S.SPR_TAB + 2) === 240 && rd16(mn, S.SPR_TAB + 4) === 50);
}

finish('runtime v4, routines');
