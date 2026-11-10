"use strict";
// m8-runtime-mem.mjs -- runtime v4, memory: the map of ray mode (no overlap), and write confinement while ray games run on TSRun:
//  1. the regions of contract section 1 / docs/ARCADE_RUNTIME_API_V4.md "As built" do not overlap and stay inside their areas;
//  2. every write after the boot, tracked: only the hidden display file, the cell map and dirty maps, the variables, V4VARS (to R4_END), GAME_VARS,
//     RT_ARGS, the stack, the ray arrays, the billboard records / list / generated rows / distances, the RAM routines' patch points (the chain's unit
//     first bytes, the DDA's immediates and opcodes, the row tails' K and fraction, the generated multiplies) and the map cells SETWALL names; free
//     areas (poisoned) never written;
//  3. after play: the tables (cos, reciprocal, height, patterns) and the chain / DDA code equal what the boot made (every patch restored);
//  4. the runtime's stack depth in a ray tick.
//   node arcade/tests/m8-runtime-mem.mjs        (M8_QUICK=1: shorter)
import * as R from './m8-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { M, Z, hex, makeChecks, rd8, rd16, op } = R;

const QUICK = !!process.env.M8_QUICK;
const { check, finish } = makeChecks();
const rt = R.runtime(), S = rt.syms;
console.log('Runtime v4: memory map and write confinement\n');

// ---- 1. the map --------------------------------------------------------------------------------------------------------------
const RAM_CODE_LEN = S.RAY_RAM_END - S.RAY_RAM;
const regions = [
  ['RAY_PATM', S.RAY_PATM, 64], ['RAY_BLIST', S.RAY_BLIST, 16], ['RAY_COS', S.RAY_COS, 512], ['RAY_RECIP', S.RAY_RECIP, 1024], ['RAY_HGT', S.RAY_HGT, 1536],
  ['RAY_HHR', S.RAY_HHR, 64], ['RAY_PIR', S.RAY_PIR, 64], ['CELL_TILE..GLYPH_TAB end', S.CELL_TILE, 0xE000 - S.CELL_TILE],
  ['VARS', 0xE000, 0x100], ['BB_TAB', S.BB_TAB, 64], ['V4VARS (pose, render state)', S.RV_X, S.R4_END - S.RV_X], ['FC_VARS (non-ray)', 0xE1C0, 0x40],
  ['GAME_VARS', S.GAME_VARS_BASE, 0x800], ['MAP_RAM', S.MAP_RAM, 1024], ['RAY_BREC', S.RAY_BREC, 256], ['RAY_BCODE', S.RAY_BCODE, S.RAY_BCODE_LEN],
  ['RAY_DISTL', S.RAY_DISTL, 64], ['RAY_DISTH', S.RAY_DISTH, 64], ['T3 (RT_ARGS)', S.T3, 0x80], ['stack', S.STACK_CANARY, 0x400],
  ['RAM routines', S.RAY_RAM, S.RAY_MUL_END - S.RAY_RAM],
];
{
  console.log('1. The map of ray mode');
  let overlap = null;
  for (let i = 0; i < regions.length; i++) for (let j = i + 1; j < regions.length; j++) {
    const [na, a, la] = regions[i], [nb, b, lb] = regions[j];
    if (a < b + lb && b < a + la) overlap ??= `${na} / ${nb}`;
  }
  check(`${regions.length} regions, no overlap`, !overlap, overlap ?? '');
  check('the ray tables lie in the former POOL_A ($C080-$CDFF), the billboard rows and distances in POOL_B ($F200-$FA7F), the records in WORLD_RAM after the map',
    S.RAY_PATM >= 0xC080 && S.RAY_PIR + 64 <= 0xCE00 && S.RAY_BCODE >= 0xF200 && S.RAY_DISTH + 64 <= 0xFA80 && S.RAY_BREC >= S.MAP_RAM + 0x400 && S.RAY_BREC + 0x100 <= 0xF200);
  check(`the RAM routines: ${RAM_CODE_LEN} bytes copied to $5B00 (the chain ${S.DDA - S.CHAIN}, the DDA ${S.RAY_RAM_END - S.DDA}) + 6 generated multiplies to ${hex(S.RAY_MUL_END)} (below $6000)`,
    S.RAY_RAM === 0x5B00 && S.RAY_MUL_END <= 0x6000 && S.CHAIN === 0x5B00);
}

// ---- the games ---------------------------------------------------------------------------------------------------------------
function makeGame(seed, colw, nticks) {
  const r = rng(seed);
  const mw = r.pick([16, 24, 32]), mh = r.pick([16, 20, 32]), cells = R.randomCells(r, mw, mh, 0.12), map = R.loadMap(R.rleEncode(cells), mw, mh);
  const assets = [R.randomAsset(r, 16, 16, 1, 2), R.randomAsset(r, 32, 48, 1, 2), R.randomAsset(r, 24, 8, 1, 1)];
  const insts = [0, 1, 2, 0, 1, 0];
  let pose = R.randomPose(r, map, mw, mh);
  const script = Array.from({ length: nticks }, (_, k) => {
    const t = [];
    pose = { x: Math.max(300, Math.min(mw * 256 - 300, pose.x + r.int(-80, 80))), y: Math.max(300, Math.min(mh * 256 - 300, pose.y + r.int(-80, 80))), a: (pose.a + r.int(-8, 8)) & 255 };
    t.push(op.view(pose.x, pose.y, pose.a));
    const cs = R.cosa8(pose.a), sn = R.sina8(pose.a);
    insts.forEach((_, i) => {
      if (r.chance(0.1)) { t.push(op.hide(i)); return; }
      if (i === 1 && k % 3 === 0) { t.push(op.showf(i, (pose.x + ((250 * cs) >> 8)) & 0xFFFF, Math.max(0, pose.y + ((250 * sn) >> 8)), 0)); return; }   // the 32 x 48 one 1 cell ahead: the widest row code
      const d = r.int(100, 2000), lat = r.int(-700, 700);
      t.push(op.showf(i, (pose.x + ((d * cs - lat * sn) >> 8)) & 0xFFFF, Math.max(0, pose.y + ((d * sn + lat * cs) >> 8)), r.int(0, 3)));
    });
    if (k % 2 === 0) t.push(op.setwall(r.int(-200, mw * 256 + 200), r.int(-200, mh * 256 + 200), r.pick([0, 1, 2, 3, 4, 5])));
    if (k % 5 === 1) t.push(op.at(r.int(0, 23), r.int(0, 28)), op.prints('M' + k), op.tile(r.int(0, 3), r.int(0, 23), r.int(0, 31)));
    if (k === 7) t.push(op.cls());
    t.push(op.wall(r.int(0, 9000), r.int(0, 9000)), op.hit(r.int(0, 5), r.int(0, 5)), op.bbtab(r.int(0, 5)));
    return t;
  });
  return { spec: { div: r.int(1, 4), view: { colw, mw, mh, cells }, assets, insts, tiles: randomTiles(r, 4), script }, script };
}

// free in ray mode (poisoned after the boot; never written in play)
const FREE = [['T2', S.T2_FREE, S.T2_FREE_LEN], ['T4', S.T4_FREE, S.T4_FREE_LEN], ['$E0FC-$E0FF', 0xE0FC, 4], ['V4VARS tail', S.R4_END, 0xE1C0 - S.R4_END],
  ['FC_VARS (unused in ray mode)', 0xE1C0, 0x40], ['WORLD_RAM after the map', S.MAP_RAM + 0x400, S.RAY_BREC - S.MAP_RAM - 0x400], ['WORLD_RAM after BREC', S.RAY_BREC + 0x100, 0xF200 - S.RAY_BREC - 0x100],
  ['POOL_B after the distances', S.RAY_DISTH + 64, 0xFA80 - S.RAY_DISTH - 64], ['POOL_A: $C0D0-$C0FF', S.RAY_BLIST + 16, 0xC100 - S.RAY_BLIST - 16],
  ['POOL_A: $CD80-$CDFF', S.RAY_PIR + 64, 0xCE00 - S.RAY_PIR - 64], ['POOL_C', S.POOL_C, S.POOL_C_LEN], ['PHASE_OFF', S.PHASE_OFF, S.PHASE_OFF_LEN],
  ['$5B00 tail', S.RAY_MUL_END, 0x6000 - S.RAY_MUL_END], ['$7B00-$7FFF', 0x7B00, 0x500]];
const inR = (a, from, len) => a >= from && a < from + len;

function runTracked(colw, seed, nticks) {
  const { spec, script } = makeGame(seed, colw, nticks);
  const g = R.rayGame(spec);
  const m = R.newMachine(g.dck);
  for (let f = 0; f < 400 && rd16(m, S.HO_MARK) !== 0x5AA5; f++) M.runFrame(m);
  // run to the frame loop, then snapshot the boot's work and poison the free areas
  for (let i = 0; i < 6000000 && m.cpu.pc !== S.MAIN; i++) Z.runZ80(m.cpu, m.bus, 1, m);
  for (const [, a, l] of FREE) for (let i = 0; i < l; i++) m.ram[a + i] = 0xA5 ^ (i & 0x3F);
  const free0 = FREE.map(([, a, l]) => m.ram.slice(a, a + l));
  const tables0 = { cos: m.ram.slice(S.RAY_COS, S.RAY_COS + 512), rec: m.ram.slice(S.RAY_RECIP, S.RAY_RECIP + 1024), hgt: m.ram.slice(S.RAY_HGT, S.RAY_HGT + 1536), pat: m.ram.slice(S.RAY_PATM, S.RAY_PATM + 64) };
  const code0 = m.ram.slice(S.RAY_RAM, S.RAY_RAM_END);
  const unitFirst = new Set(Array.from({ length: 48 }, (_, d) => S.CHAIN + 5 * d + 20 * Math.floor(d / 8)));   // (UNIT_TAB is in the ROM)
  const ddaPatch = new Set([S.DDA_PXL + 1, S.DDA_PXH + 1, S.DDA_PYL + 1, S.DDA_PYH + 1, S.DDA_XOP, S.DDA_YOP, S.DDA_YC,   // the DDA's immediates and opcodes,
    S.BT_FI_K + 1, S.BT_FI_F + 1, S.BT_F_K + 1, S.BT_F_F + 1, S.BT_I_K + 1]);                                                 // the billboard row tails' K and fraction
  const model = new R.Model8(spec);
  const viol = new Map(); let mapWrites = 0, mapBad = 0, spMin = 0xFFFF, writes = 0, mapCellsBad = 0;
  let mapExpected = model.map.slice();
  const origWrite = m.bus.write;
  m.bus.write = (addr, v) => {
    const a = addr & 0xFFFF, cpu = m.cpu;
    writes++;
    const hidden = rd8(m, S.V_HIDDEN), hfile = hidden ? 0x6000 : 0x4000;
    const ok = inR(a, hfile, 0x1B00) || inR(a, S.CELL_TILE, 0x600) || inR(a, S.DIRTY0, 0x60) || inR(a, S.DIRTY1, 0x60) || inR(a, 0xE000, 0xFC) ||
      inR(a, S.BB_TAB, S.R4_END - S.BB_TAB) || inR(a, S.GAME_VARS_BASE, 0x800) || inR(a, S.T3, 0x80) || inR(a, S.STACK_LIMIT, S.STACK_TOP - S.STACK_LIMIT) ||
      inR(a, S.RAY_HHR, 0x80) || inR(a, S.RAY_BLIST, 16) || inR(a, S.RAY_BREC, 0x100) || inR(a, S.RAY_BCODE, S.RAY_BCODE_LEN) || inR(a, S.RAY_DISTL, 0x80) ||
      unitFirst.has(a) || ddaPatch.has(a) || inR(a, S.RAY_MULXN, S.RAY_MUL_END - S.RAY_MULXN) || (inR(a, S.SPR_TAB, 0x80)) || inR(a, 0xE070, 0x10);
    if (inR(a, S.MAP_RAM, 0x400)) { mapWrites++; if (cpu.pc < S.RT_SETWALL || cpu.pc > S.show_ray) mapBad++; }
    else if (inR(a, S.RAY_DISTL, 0x80) || inR(a, S.RAY_HHR, 0x80)) { if (cpu.pc < S.hit_c || cpu.pc >= S.rw_column) { const k = 'ray arrays written at ' + hex(cpu.pc); viol.set(k, (viol.get(k) ?? 0) + 1); } }
    else if (inR(a, S.RAY_BCODE, S.RAY_BCODE_LEN)) { if (cpu.pc < S.bb_draw || cpu.pc >= S.bb_xc) { const k = 'row code written at ' + hex(cpu.pc); viol.set(k, (viol.get(k) ?? 0) + 1); } }
    else if (!ok) { const k = hex(a); viol.set(k, (viol.get(k) ?? 0) + 1); }
    origWrite(addr, v);
  };
  let started = true, chainBad = 0, ticks = 0, rSp = null, rDepth = 0;
  for (let f = 0; f < nticks * 14 + 60 && ticks < nticks; f++) {
    const end = m.frameStart + R.FRAME_T;
    while (m.tstates < end) {
      const cpu = m.cpu;
      if (cpu.sp < spMin) spMin = cpu.sp;
      if (cpu.pc === S.WORK_START) rSp = cpu.sp;
      if (rSp !== null && rSp - cpu.sp > rDepth) rDepth = rSp - cpu.sp;
      if (cpu.pc === S.TICK_REQUEST) {
        const n = rd16(m, S.V_TICKS) - 1;
        for (const o of script[n] ?? []) model.apply(o);
        ticks = n + 1;
        for (let i = 0; i < 1024; i++) if (m.ram[S.MAP_RAM + i] !== model.map[i]) { mapCellsBad++; break; }
        const code = m.ram.slice(S.RAY_RAM, S.CHAIN + (S.DDA - S.CHAIN));
        for (let i = 0; i < code.length; i++) if (code[i] !== code0[i]) { chainBad++; break; }
      }
      if (cpu.pc === S.WORK_END) rSp = null;
      Z.runZ80(cpu, m.bus, 1, m);
    }
    M.runFrame(m);
  }
  const freeBad = FREE.filter(([, a, l], k) => m.ram.slice(a, a + l).some((v, i) => v !== free0[k][i])).map(([n]) => n);
  const tablesOk = m.ram.slice(S.RAY_COS, S.RAY_COS + 512).every((v, i) => v === tables0.cos[i]) && m.ram.slice(S.RAY_RECIP, S.RAY_RECIP + 1024).every((v, i) => v === tables0.rec[i]) &&
    m.ram.slice(S.RAY_HGT, S.RAY_HGT + 1536).every((v, i) => v === tables0.hgt[i]) && m.ram.slice(S.RAY_PATM, S.RAY_PATM + 64).every((v, i) => v === tables0.pat[i]);
  return { viol, freeBad, tablesOk, chainBad, mapWrites, mapBad, mapCellsBad, ticks, spMin, rDepth, writes, canary: rd16(m, S.STACK_CANARY), spec };
}

console.log('\n2-4. Ray games with every write tracked');
let deepest = 0;
for (const [colw, seed] of (QUICK ? [[4, 1], [2, 2]] : [[4, 1], [2, 2], [4, 3], [2, 4], [4, 5], [2, 6]])) {
  const nt = QUICK ? 10 : 20;
  const res = runTracked(colw, 8100 + seed, nt);
  const label = `colw ${colw}, ${res.spec.view.mw} x ${res.spec.view.mh}, frame_div ${res.spec.div}`;
  check(`${label}: every write of ${res.ticks} ticks (${res.writes}) lands in the allowed regions`, res.viol.size === 0 && res.ticks >= nt, res.viol.size ? [...res.viol].slice(0, 6).join(' ') : '');
  check(`${label}: the free areas (poisoned: T2, T4, $E0FC, V4VARS tail, FC_VARS, WORLD_RAM gaps, POOL_A / B / C gaps, PHASE_OFF, $5B00 / $7B00 tails) unchanged`, res.freeBad.length === 0, res.freeBad.join(', '));
  check(`${label}: the map is written only by RT_SETWALL (${res.mapWrites} writes) and equals the model after every tick`, res.mapBad === 0 && res.mapCellsBad === 0);
  check(`${label}: the tables are unchanged, the chain equals its ROM image after every tick (every RST patch restored)`, res.tablesOk && res.chainBad === 0);
  deepest = Math.max(deepest, res.rDepth);
  check(`${label}: stack: canary intact, SP never below ${hex(S.STACK_LIMIT)}`, res.canary === 0x5AA5 && res.spMin >= S.STACK_LIMIT, `SP min ${hex(res.spMin)}`);
}
check(`the runtime's own stack depth in a ray tick (from WORK_START, the interrupt included): ${deepest} bytes (v3: 26 + 10)`, deepest > 0 && deepest <= 64);

finish('runtime v4, memory');
