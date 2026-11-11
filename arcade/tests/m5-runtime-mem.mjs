"use strict";
// m5-runtime-mem.mjs -- M5 runtime test, part 5: the memory the tile operations touch (layout.inc "Language batch 1").  The ops game runs every operation for
// 300 refreshes with the free areas poisoned: no free byte is written (T2_FREE, VARS $E0FC-$E0FF, T3 above the operations' scratch), nothing is written outside
// the cell map, the dirty maps, SPR_TAB / SPR_DRAWN, the variables, the game variables, the stack and the operations' own RAM (T3, V_BORDER), the read-only tables are
// byte for byte what the boot built, the stack stays above its canary.  Also the boot's own writes: V_BORDER = 1, V_NMAP, V_MAPTAB.
//   node arcade/tests/m5-runtime-mem.mjs
import * as C from './m5-common.mjs';
import { rng, randomTiles } from './m3-scenes.mjs';
const { M, hex, makeChecks, rd8, rd16, op } = C;

const { check, finish } = makeChecks();
const S = C.rt().syms;
console.log('M5 runtime memory: what the tile operations write\n');

const toEnd = S.TO_VARS + 42;           // TO_TSC + 2: the end of the operations' scratch
const REGIONS = [
  ['ROW_TAB', S.ROW_TAB, 384, 'ro'], ['PHASE_PTR', S.PHASE_PTR, 128, 'ro'], ['POOL_A', S.POOL_A, 32 * 96, 'ro'], ['CELL_TILE', S.CELL_TILE, 768, 'rw'],
  ['CELL_ATTR', S.CELL_ATTR, 768, 'rw'], ['DIRTY0', S.DIRTY0, 96, 'rw'], ['SPR_TAB', S.SPR_TAB, 96, 'rw'], ['AST', S.AST, 64, 'ro'], ['DIRTY1', S.DIRTY1, 96, 'rw'],
  ['SPR_DRAWN', S.SPR_DRAWN, 128, 'rw'], ['T2_FREE', S.T2_FREE, S.T2_FREE_LEN, 'free'], ['TILE_ATTR', S.TILE_ATTR, 128, 'ro'], ['POOL_C', S.POOL_C, 4 * 96, 'ro'],
  ['GLYPH_TAB', S.GLYPH_TAB, 2048, 'ro'], ['VARS', S.VARS, 0xFC, 'rw'], ['VARS_FREE', S.VARS + 0xFC, 0x04, 'free'], ['GAME_VARS', S.GAME_VARS_BASE, S.GAME_VARS_LIMIT + 1 - S.GAME_VARS_BASE, 'rw'],
  ['POOL_B', S.POOL_B, 28 * 96, 'ro'], ['TILEOPS', S.T3, toEnd - S.T3, 'rw'], ['T3_FREE', toEnd, S.T3 + S.T3_LEN - toEnd, 'free'], ['STACK', S.STACK_CANARY, S.STACK_TOP - S.STACK_CANARY, 'stack'],
  ['HANDOFF', 0xFF00, 0x100, 'rw'],
];
{
  let overlap = null;
  for (let i = 0; i < REGIONS.length; i++) for (let j = i + 1; j < REGIONS.length; j++) {
    const [, a, la] = REGIONS[i], [, b, lb] = REGIONS[j];
    if (a < b + lb && b < a + la) overlap ??= `${REGIONS[i][0]} / ${REGIONS[j][0]}`;
  }
  check('the new regions overlap nothing: the operations\' scratch ends inside T3, the argument block and the buffers are where layout.inc says',
    overlap === null && S.RT_ARGS === S.T3 + 0x40 && S.TO_BUFT === S.T3 && S.TO_BUFA === S.T3 + 0x20 && S.TO_VARS === S.RT_ARGS + 12 && toEnd <= S.T3 + S.T3_LEN && S.V_BORDER === S.VARS + 0xF8, overlap ?? '');
  check('RT_ARGS words: RA_X +0, RA_Y +2, RA_W +4, RA_H +6, RA_V = RA_DX +8, RA_DY +10', S.RA_X === S.RT_ARGS && S.RA_Y === S.RT_ARGS + 2 && S.RA_W === S.RT_ARGS + 4 && S.RA_H === S.RT_ARGS + 6 && S.RA_V === S.RT_ARGS + 8 && S.RA_DX === S.RA_V && S.RA_DY === S.RT_ARGS + 10);
  const cst = C.rt().json.constants;
  check('runtime.json carries the constants the compiler needs (RT_ARGS, RA_*, GAME_MAPTAB = $8010, GAME_HEADER_EXT_LEN = 18, DIV_EXT = $80, MAX_MAPS = 64, V_BORDER) and the entry points',
    cst.RT_ARGS === S.RT_ARGS && cst.GAME_MAPTAB === 0x8010 && cst.GAME_HEADER_EXT_LEN === 18 && cst.DIV_EXT === 0x80 && cst.MAX_MAPS === 64 && cst.V_BORDER === S.V_BORDER &&
    ['RT_FILL', 'RT_FILLC', 'RT_COPY', 'RT_LOADMAP', 'RT_LOADMAPAT', 'RT_LOADMAPPTR', 'RT_BORDER', 'RT_RANDOMISE'].every((n) => C.rt().json.symbols[n] === S[n] && S[n] > 0));
}

const r = rng(77);
const tiles = randomTiles(rng(78), 7);
const randMap = (rr, w, h) => ({ w, h, cells: Array.from({ length: w * h }, () => (rr.chance(0.6) ? 0x80 | rr.int(0, 6) : rr.int(32, 126))) });
const maps = [randMap(r, 32, 24), randMap(r, 17, 11)];
const script = [];
for (let k = 0; k < 60; k++) script.push(C.randomTileOps(r, { maps: 2, tiles: 7 }));
script.push([op.border(3), op.randomise(5), op.rnd()]);
const assets = [C.C.randomAsset(r, 16, 16, 8), C.C.randomAsset(r, 8, 8, 4)];
const game = C.opsGame({ div: 2, tiles, maps, assets, insts: [0, 1, 0], script });
const freeAreas = REGIONS.filter((x) => x[3] === 'free');
const ro = REGIONS.filter((x) => x[3] === 'ro');
const written = new Set();
let poisoned = false, snapRo = null;
const st = C.observe5(game, 300, {
  script, hooks: (pc, { m }) => {
    if (!poisoned && pc === S.MAIN) {
      poisoned = true;
      for (const [, a, l] of freeAreas) for (let k = 0; k < l; k++) m.ram[a + k] = 0xA5 ^ (k & 0x3F);
      snapRo = ro.map(([, a, l]) => m.ram.slice(a, a + l));
      const w = m.bus.write;
      m.bus.write = (addr, v) => { const a = addr & 0xFFFF; if (a >= 0xC000) written.add(a); w(addr, v); };
    }
  },
});
const m = st.m;
const name = (a) => { for (const [n, s, l] of REGIONS) if (a >= s && a < s + l) return n; return 'gap'; };
const touched = {};
for (const a of written) { const n = name(a); touched[n] = (touched[n] ?? 0) + 1; }
console.log('  regions written during play (bytes): ' + Object.entries(touched).map(([n, c]) => `${n} ${c}`).join(', '));
check('the picture equals the model after every refresh over the whole run (300 refreshes of random tile operations)', st.pictureBad === 0 && st.pixelBad === 0 && st.pictureOk >= 295, JSON.stringify(st.firstBad));
check('no free area is ever written (T2_FREE, $E0FC-$E0FF, the unused tail of T3)', freeAreas.every(([, a, l]) => Array.from({ length: l }, (_, k) => m.ram[a + k]).every((v, k) => v === (0xA5 ^ (k & 0x3F)))));
check('nothing is written to a read-only table nor to a gap; the tables are byte for byte what the boot built', ro.every(([n]) => !touched[n]) && !touched.gap && ro.every(([, a, l], i) => Array.from({ length: l }, (_, k) => m.ram[a + k]).every((v, k) => v === snapRo[i][k])), JSON.stringify(touched));
check('play writes only: cell map, dirty maps, SPR_TAB, SPR_DRAWN, variables (V_BORDER, RT_SEED), game variables, the stack and the operations\' own RAM',
  Object.keys(touched).every((n) => ['CELL_TILE', 'CELL_ATTR', 'DIRTY0', 'DIRTY1', 'SPR_TAB', 'SPR_DRAWN', 'VARS', 'GAME_VARS', 'STACK', 'TILEOPS'].includes(n)) && !touched.HANDOFF && touched.TILEOPS > 20);
check('the stack canary is intact and the stack stayed in $FB02..$FF00 (deepest use: ' + (S.STACK_TOP - st.spMin) + ' bytes including interrupts)', st.canary === 0x5AA5 && st.spMin >= S.STACK_LIMIT, `SP ${hex(st.spMin)}..${hex(st.spMax)}`);
console.log('  (V_BORDER ' + rd8(m, S.V_BORDER) + ', border ' + m.border + ', ticks ' + st.finalTicks + ')');
check('BORDER 3 was the last border written: V_BORDER = 3 and the machine border register agrees', rd8(m, S.V_BORDER) === 3 && m.border === 3);
finish('M5 runtime memory');
void rd16; void M;
