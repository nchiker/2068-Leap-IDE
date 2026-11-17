"use strict";
// sc-runtime-mem.mjs -- the v2 ink build (classic-scene sprite ink, -DSPRITE_INK), the memory test in the pattern of m4-runtime-mem.mjs: what the build's play writes.
//  1. The map: the ink build's regions of RAM chunks 6 and 7 are the default build's (same symbols for every region), none overlaps another; T2_FREE keeps its length and
//     the ink scratch (SC_ON .. SC_N, T2_FREE+0..+8) lies inside it; the build is still inside chunks 0-1.
//  2. The worst-case game of m4 (8 assets of 16 x 16 with 8 phases = all 64 phase slots, 16 moving instances over a painted background, text) runs 100 ticks with the ink on,
//     an ink table for every asset in the game's variable area, and every free area poisoned (T2_FREE except the ink scratch, $E0FC-$E0FF, T3, the byte T2_FREE+2): no free byte
//     is written, the ink table and every read-only table are byte for byte what the boot left, nothing is written outside the regions play may write, the ink scratch is written
//     only at the offsets spritecol.asm defines (never +2, never +9 on), the only low-RAM writes are the two display files (the attribute files hold the ink), the stack canary holds,
//     and the ink did colour cells (so the game exercised the path).
//  3. The same game with the setter never called (an ink build, no ink scene): SC_ON is never written, only the two stores of the sprite loop reach the scratch, no attribute is recoloured (a game that does not use the ink writes the same regions, plus SC_SH / SC_A16 in the sprite loop).
//   node arcade/tests/sc-runtime-mem.mjs
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildRuntimeInk, assembleGameInk, linkGame, dckOf } from '../tools/build-runtime-v2ink.mjs';
import { RUNTIME_DIR } from '../tools/build-runtime-v2.mjs';
import * as C from './m4-common.mjs';
import { rng } from './m3-scenes.mjs';
const { M, op, newMachine, callRoutine, makeChecks, rd8, rd16, hex, SCRIPT, assetBytes, encodeScript } = C;

const { check, finish } = makeChecks();
const rt = buildRuntimeInk();
const S = rt.syms;
const HERE = dirname(fileURLToPath(import.meta.url));
const dflt = JSON.parse(readFileSync(join(HERE, '../dist/v2/runtime.json'), 'utf8')).symbols;
console.log('Runtime v2 ink build: memory, what play writes\n');

// ---- 1. the map ----------------------------------------------------------------------------------------------------------------
const TABLE = 0xEA00, GRIDS = 0xEA10, NASSETS = 8, TABLE_END = GRIDS + NASSETS * 81;
const REGIONS = [
  ['ROW_TAB', S.ROW_TAB, 384, 'ro'], ['PHASE_PTR', S.PHASE_PTR, 128, 'ro'], ['POOL_A', S.POOL_A, 32 * 96, 'ro'], ['CELL_TILE', S.CELL_TILE, 768, 'rw'],
  ['CELL_ATTR', S.CELL_ATTR, 768, 'rw'], ['DIRTY0', S.DIRTY0, 96, 'rw'], ['SPR_TAB', S.SPR_TAB, 96, 'rw'], ['AST', S.AST, 64, 'ro'], ['DIRTY1', S.DIRTY1, 96, 'rw'],
  ['SPR_DRAWN', S.SPR_DRAWN, 128, 'rw'], ['SC_SCRATCH', S.T2_FREE, 9, 'sc'], ['T2_FREE', S.T2_FREE + 9, S.T2_FREE_LEN - 9, 'free'], ['TILE_ATTR', S.TILE_ATTR, 128, 'ro'], ['POOL_C', S.POOL_C, 4 * 96, 'ro'],
  ['GLYPH_TAB', S.GLYPH_TAB, 2048, 'ro'], ['VARS', S.VARS, 0xFC, 'rw'], ['VARS_FREE', S.VARS + 0xFC, 0x04, 'free'],
  ['GAME_VARS', S.GAME_VARS_BASE, TABLE - S.GAME_VARS_BASE, 'rw'], ['INKTAB', TABLE, TABLE_END - TABLE, 'ro'], ['GAME_VARS2', TABLE_END, S.GAME_VARS_LIMIT + 1 - TABLE_END, 'rw'],
  ['POOL_B', S.POOL_B, 28 * 96, 'ro'], ['T3', S.T3, S.T3_LEN, 'free'], ['STACK', S.STACK_CANARY, S.STACK_TOP - S.STACK_CANARY, 'stack'], ['HANDOFF', 0xFF00, 0x100, 'rw'],
];
{
  console.log('1. The map');
  let overlap = null;
  for (let i = 0; i < REGIONS.length; i++) for (let j = i + 1; j < REGIONS.length; j++) {
    const [, a, la] = REGIONS[i], [, b, lb] = REGIONS[j];
    if (a < b + lb && b < a + la) overlap ??= `${REGIONS[i][0]} / ${REGIONS[j][0]}`;
  }
  check('no two of the 24 regions (the ink scratch carved out of T2_FREE, the ink table out of the game variables) overlap', overlap === null, overlap ?? '');
  const DATA = ['ROW_TAB', 'PHASE_PTR', 'POOL_A', 'CELL_TILE', 'CELL_ATTR', 'DIRTY0', 'SPR_TAB', 'AST', 'DIRTY1', 'SPR_DRAWN', 'T2_FREE', 'TILE_ATTR', 'POOL_C', 'GLYPH_TAB', 'VARS', 'GAME_VARS_BASE', 'GAME_VARS_LIMIT', 'POOL_B', 'T3', 'T3_LEN', 'T2_FREE_LEN', 'STACK_CANARY', 'STACK_LIMIT', 'STACK_TOP'];
  const moved = DATA.filter((k) => S[k] !== dflt[k]);
  check('every data region of RAM chunks 6 and 7 is where the default v2 build has it (the ink build moves code, not data)', moved.length === 0, moved.map((k) => `${k} ${hex(dflt[k])} -> ${hex(S[k])}`).join(', '));
  check('the ink scratch SC_ON .. SC_N is T2_FREE+0..+8 and fits T2_FREE (the +2 byte is not used)', S.SC_ON === S.T2_FREE && S.SC_INKH === S.T2_FREE + 1 && S.SC_SH === S.T2_FREE + 3 && S.SC_N === S.T2_FREE + 8 && S.T2_FREE_LEN >= 10 && S.SC_SH - S.SC_INKH === 2);
  check('the ink table address of this test ($EA00, page-aligned, 8 assets) lies in the game variables, clear of the boot\'s tables', TABLE % 256 === 0 && TABLE >= S.GAME_VARS_BASE && TABLE_END <= S.GAME_VARS_LIMIT + 1);
  check('the ink build ends before $4000 (chunks 0-1 hold the runtime)', S.RT_END <= 0x4000, hex(S.RT_END));
}

// ---- 2 and 3. the worst-case game --------------------------------------------------------------------------------------------
const w16 = (v) => [v & 0xFF, (v >> 8) & 0xFF];
const R = rng(7788);
const assets = Array.from({ length: NASSETS }, () => C.randomAsset(R, 16, 16, 8));
const insts = Array.from({ length: 16 }, (_, i) => i % NASSETS);
const LEAVE = 0x08;
const cls3 = (v) => (v === 0 ? 0 : v < 4 ? 1 : 2);
const gridByte = (a, cls, dr, dc) => {
  const nc = cls >= 3 ? 3 : 2, nr = cls % 3 ? 3 : 2;
  if (dc >= nc || dr >= nr) return LEAVE;
  const v = (a * 7 + cls * 5 + dr * 3 + dc * 11) % 11;
  return v >= 8 ? LEAVE : v;
};
const script = [];
{
  const Q = rng(4242);
  const pos = insts.map(() => ({ x: Q.int(0, 230), y: Q.int(0, 170), dx: Q.int(-4, 4) || 1, dy: Q.int(-3, 3) || 1 }));
  const paint = [];
  for (let row = 0; row < 24; row++) paint.push(op.ink(row % 8), op.paper((row * 3 + 1) % 8), op.bright(row % 2), op.at(row, 0), op.prints(' '.repeat(32)));
  for (let t = 0; t < 100; t++) {
    const o = t === 0 ? [...paint] : [];
    if (t % 17 === 5) o.push(op.at(t % 24, t % 20), op.ink(t % 8), op.prints('INK' + t));
    pos.forEach((p, i) => {
      p.x += p.dx; p.y += p.dy;
      if (p.x < 0 || p.x > 235) p.dx = -p.dx;
      if (p.y < 0 || p.y > 172) p.dy = -p.dy;
      if ((t + i) % 23 === 0) o.push(op.hide(i)); else o.push(op.show(i, Math.max(0, p.x), Math.max(0, p.y)));
    });
    script.push(o);
  }
}
let asmCache = null;
function gameImage() {
  const g = (asmCache ??= assembleGameInk(join(RUNTIME_DIR, 'test_script.asm'), { name: 'script2ink' }));
  const img = linkGame(rt.img, g.bytes);
  const put = (a, bytes) => { img.set(bytes, a); };
  img[0x8004] = 3; img[0x8005] = NASSETS;
  let dataAt = SCRIPT.SPRDATA;
  assets.forEach((a, i) => {
    const bytes = assetBytes(a);
    put(dataAt, bytes);
    put(SCRIPT.SPRTAB + 8 * i, [a.w, a.h, ...w16(dataAt), 0, 0, a.phases, 0]);
    dataAt += bytes.length;
  });
  put(SCRIPT.INST, [insts.length, ...insts]);
  put(0x8006, w16(SCRIPT.SPRTAB));
  put(0x8008, [0, 0, 0, 0, 0, 0, ...w16(SCRIPT.INST)]);
  img.fill(0, SCRIPT.BASE, SCRIPT.END);
  put(SCRIPT.BASE, encodeScript(script));
  return dckOf(img);
}
const dck = gameImage();
function plantTable(m) {
  for (let a = 0; a < NASSETS; a++) { m.ram[TABLE + 2 * a] = (GRIDS + 81 * a) & 0xFF; m.ram[TABLE + 2 * a + 1] = (GRIDS + 81 * a) >> 8; }
  for (let a = 0; a < NASSETS; a++) for (let cls = 0; cls < 9; cls++) for (let dr = 0; dr < 3; dr++) for (let dc = 0; dc < 3; dc++) m.ram[GRIDS + a * 81 + cls * 9 + dr * 3 + dc] = gridByte(a, cls, dr, dc);
}

const SPARE_T2 = [2, ...Array.from({ length: S.T2_FREE_LEN - 9 }, (_, k) => 9 + k)];      // offsets of T2_FREE the ink never writes
const regionOf = (a) => { for (const [n, s, l] of REGIONS) if (a >= s && a < s + l) return n; return 'gap'; };
const lowRegion = (a) => {
  if (a >= 0x4000 && a < 0x5800) return 'bitmap0'; if (a >= 0x5800 && a < 0x5B00) return 'attr0'; if (a >= 0x5B00 && a < 0x6000) return 'low-free0';
  if (a >= 0x6000 && a < 0x7800) return 'bitmap1'; if (a >= 0x7800 && a < 0x7B00) return 'attr1'; if (a >= 0x7B00 && a < 0x8000) return 'low-free1';
  return 'game-area';
};

/** Run 200 ticks.  mode 'on': the setter called (A = 1); 'never': not called.  Returns what was written, what stayed, and the recoloured cells seen. */
function play(mode) {
  const m = newMachine(dck);
  C.bootMachine(m, S);
  const writes = new Set(), lowWrites = new Map();
  m.ram[S.SC_ON] = 0;
  for (const o of SPARE_T2) m.ram[S.T2_FREE + o] = 0xA5 ^ (o & 0x3F);
  for (const [n, a, l] of REGIONS) if (n === 'VARS_FREE' || n === 'T3') for (let k = 0; k < l; k++) m.ram[a + k] = 0xA5 ^ (k & 0x3F);
  plantTable(m);
  if (mode === 'on') callRoutine(m, S.RT_SPRITEINK, { a: 1, hl: TABLE });
  const ro = REGIONS.filter((x) => x[3] === 'ro');
  const snap = ro.map(([, a, l]) => m.ram.slice(a, a + l));
  const scratch0 = Array.from(m.ram.slice(S.T2_FREE, S.T2_FREE + 9));
  const scratchWrites = new Set();
  const w = m.bus.write;
  m.bus.write = (addr, v) => {
    const a = addr & 0xFFFF;
    if (a >= 0xC000) { writes.add(a); if (a >= S.T2_FREE && a < S.T2_FREE + 9) scratchWrites.add(a - S.T2_FREE); }
    else if (a >= 0x4000) { const n = lowRegion(a); lowWrites.set(n, (lowWrites.get(n) ?? 0) + 1); }
    w(addr, v);
  };
  let recoloured = 0, frames = 0;
  const base = rd16(m, S.V_TICKS);
  while (rd16(m, S.V_TICKS) - base < 100 && frames < 2000) {
    M.runFrame(m); frames++;
    const at = (m.portFF & 1) ? 0x7800 : 0x5800;
    for (let c = 0; c < 768; c++) if (m.ram[at + c] !== m.ram[S.CELL_ATTR + c]) recoloured++;
  }
  const touched = {};
  for (const a of writes) { const n = regionOf(a); touched[n] = (touched[n] ?? 0) + 1; }
  const same = (n, ref) => { const [, a, l] = REGIONS.find((x) => x[0] === n); return Array.from({ length: l }, (_, k) => m.ram[a + k]).every((v, k) => v === ref(k)); };
  return { m, touched, lowWrites, scratchWrites, scratch0, recoloured, frames, ticks: rd16(m, S.V_TICKS) - base, ro, snap, same };
}

console.log('\n2. The worst-case game, ink on, free areas poisoned, writes tracked');
const on = play('on');
console.log('  regions written during play (bytes): ' + Object.entries(on.touched).map(([n, c]) => `${n} ${c}`).join(', '));
console.log('  low RAM writes: ' + [...on.lowWrites].map(([n, c]) => `${n} ${c}`).join(', ') + `; ink scratch offsets written: ${[...on.scratchWrites].sort().join(',') || 'none'}; recoloured cells seen ${on.recoloured}`);
check('100 ticks ran (8 assets x 8 phases, 16 moving instances, text, the ink on)', on.ticks >= 100 && on.frames < 2000, `${on.ticks} ticks, ${on.frames} frames`);
check('the ink did colour cells (the poison game exercises the ink path: many cells differ from the background during play)', on.recoloured > 1000, String(on.recoloured));
check('no free area is ever written (T2_FREE past the scratch and the +2 byte, $E0FC-$E0FF, T3)',
  SPARE_T2.every((o) => on.m.ram[S.T2_FREE + o] === (0xA5 ^ (o & 0x3F))) && on.same('VARS_FREE', (k) => 0xA5 ^ (k & 0x3F)) && on.same('T3', (k) => 0xA5 ^ (k & 0x3F)));
check('the ink scratch is written only at SC_ON, SC_INKH, SC_SH, SC_A16, SC_H, SC_T, SC_NR, SC_N (T2_FREE+0, 1, 3..8)', [...on.scratchWrites].every((o) => [0, 1, 3, 4, 5, 6, 7, 8].includes(o)) && on.scratchWrites.size >= 6, [...on.scratchWrites].join(','));
check('nothing is written to a read-only table, the ink table among them, nor to a gap; every one is byte for byte what the boot left', on.ro.every(([n]) => !on.touched[n]) && !on.touched.gap
  && on.ro.every(([, a, l], i) => Array.from({ length: l }, (_, k) => on.m.ram[a + k]).every((v, k) => v === on.snap[i][k])), JSON.stringify(on.touched));
check('play writes only: cell map, dirty maps, SPR_TAB, SPR_DRAWN, variables, game variables, the ink scratch, the stack (and the hand-off record is not touched)',
  Object.keys(on.touched).every((n) => ['CELL_TILE', 'CELL_ATTR', 'DIRTY0', 'DIRTY1', 'SPR_TAB', 'SPR_DRAWN', 'VARS', 'GAME_VARS', 'GAME_VARS2', 'SC_SCRATCH', 'STACK'].includes(n)) && !on.touched.HANDOFF);
check('the only low-RAM writes are the two display files (bitmaps and attribute files); nothing in $5B00-$5FFF, $7B00-$7FFF or the game area',
  [...on.lowWrites.keys()].every((n) => ['bitmap0', 'attr0', 'bitmap1', 'attr1'].includes(n)) && (on.lowWrites.get('attr0') ?? 0) + (on.lowWrites.get('attr1') ?? 0) > 0, JSON.stringify([...on.lowWrites]));
check('the stack canary is intact', rd16(on.m, S.STACK_CANARY) === 0x5AA5);

console.log('\n3. The same game, the setter never called');
const off = play('never');
console.log('  regions written during play (bytes): ' + Object.entries(off.touched).map(([n, c]) => `${n} ${c}`).join(', ') + `; recoloured cells seen ${off.recoloured}`);
check('SC_ON and the table page are never written (SC_ON stays 0 from the boot); the sprite loop only stores the shift and 16 * asset (SC_SH, SC_A16: T2_FREE+3, +4); the ink recolours nothing (far fewer cells differ from the background than with ink: ' + off.recoloured + ' against ' + on.recoloured + ', the rest is the refresh lag of text and tiles)',
  [...off.scratchWrites].every((o) => o === 3 || o === 4) && rd8(off.m, S.SC_ON) === 0 && off.recoloured * 3 < on.recoloured, [...off.scratchWrites].join(','));
check('the same free areas stay poisoned and the read-only tables (the ink table too) untouched', SPARE_T2.every((o) => off.m.ram[S.T2_FREE + o] === (0xA5 ^ (o & 0x3F))) && off.ro.every(([n]) => !off.touched[n]) && !off.touched.gap);
check('the writes of the game without ink are a subset of those with ink, region by region (the ink adds writes, it does not move them)', Object.keys(off.touched).every((n) => on.touched[n] !== undefined || n === 'STACK'), JSON.stringify(off.touched));
finish('Runtime v2 ink build memory');
void hex;
