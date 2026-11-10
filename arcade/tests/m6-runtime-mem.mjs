"use strict";
// m6-runtime-mem.mjs -- runtime v3 part 1, the memory map v3 (layout.inc; docs/ARCADE_PLATFORMER_CONTRACT.md section 1):
//  1. The map as data: every region of RAM chunks 6 and 7 from the build's symbols; no two overlap; the gaps are the documented free areas.
//  2. Games with every free area poisoned (T2, T4, $E0FC-$E0FF, T3, V3VARS $E102-$E1BF, WORLD_RAM, the unused tails of the three pool pieces,
//     $5B00-$5FFF and $7B00-$7FFF): nothing writes them during play; play writes only the hidden display file, cell map, dirty maps, SPR_TAB,
//     SPR_DRAWN, the variables, the frame cache's scratch, GAME_VARS and the stack; with every frame in a slot the pool, AST and PHASE_OFF are never
//     written; in cache mode only the FTAB slot words, the slots and AST_RR are, and every slot write lies inside an allocated slot.
//  3. The stack: the runtime's own depth during a tick with cache misses (plus an interrupt), and the canary.
//   node arcade/tests/m6-runtime-mem.mjs
import * as C from './m6-common.mjs';
import { rng, randomScene, randomTiles } from './m3-scenes.mjs';
const { M, Z, FRAME_T, hex, makeChecks, rd8, rd16, op } = C;

const QUICK = !!process.env.M6_QUICK;
const { check, finish } = makeChecks();
const S = C.runtime().syms;
console.log('Runtime v3 part 1: memory map v3\n');

const REGIONS = [
  ['PHASE_OFF', S.PHASE_OFF, 128, 'ro'], ['POOL_A', S.POOL_A, S.POOL_A_LEN, 'pool'], ['CELL_TILE', S.CELL_TILE, 768, 'rw'], ['CELL_ATTR', S.CELL_ATTR, 768, 'rw'],
  ['DIRTY0', S.DIRTY0, 96, 'rw'], ['SPR_TAB', S.SPR_TAB, 128, 'rw'], ['T2_FREE', S.T2_FREE, S.T2_FREE_LEN, 'free'], ['DIRTY1', S.DIRTY1, 96, 'rw'],
  ['SPR_DRAWN', S.SPR_DRAWN, 128, 'rw'], ['T4_FREE', S.T4_FREE, S.T4_FREE_LEN, 'free'], ['TILE_ATTR', S.TILE_ATTR, 128, 'ro'], ['AST', S.AST, 128, 'ast'],
  ['POOL_C', S.POOL_C, S.POOL_C_LEN, 'pool'], ['GLYPH_TAB', S.GLYPH_TAB, 2048, 'ro'], ['VARS', S.VARS, 0xFC, 'rw'], ['VARS_FREE', S.VARS + 0xFC, 4, 'free'],
  ['V_CAM', S.V_CAM, 2, 'free'], ['V3VARS_PART2', S.V3VARS + 2, 0xBE, 'free'], ['FC_VARS', S.V3VARS + 0xC0, 0x40, 'rw'],
  ['GAME_VARS', S.GAME_VARS_BASE, S.GAME_VARS_LIMIT + 1 - S.GAME_VARS_BASE, 'rw'], ['WORLD_RAM', S.WORLD_RAM, S.WORLD_RAM_LEN, 'free'],
  ['POOL_B', S.POOL_B, S.POOL_B_LEN, 'pool'], ['T3', S.T3, S.T3_LEN, 'free'], ['STACK', S.STACK_CANARY, S.STACK_TOP - S.STACK_CANARY, 'stack'], ['HANDOFF', 0xFF00, 0x100, 'rw'],
];
console.log('1. The map');
{
  let overlap = null;
  for (let i = 0; i < REGIONS.length; i++) for (let j = i + 1; j < REGIONS.length; j++) {
    const [, a, la] = REGIONS[i], [, b, lb] = REGIONS[j];
    if (a < b + lb && b < a + la) overlap ??= `${REGIONS[i][0]} / ${REGIONS[j][0]}`;
  }
  check(`no two of the ${REGIONS.length} regions overlap`, overlap === null, overlap ?? '');
  const covered = new Uint8Array(0x4000);
  for (const [, a, l] of REGIONS) for (let k = 0; k < l; k++) covered[a - 0xC000 + k] = 1;
  const holes = [];
  for (let a = 0; a < 0x4000; a++) if (!covered[a]) { const s = a; while (a < 0x4000 && !covered[a]) a++; holes.push([0xC000 + s, a - s]); }
  check('the regions cover RAM chunks 6 and 7 ($C000-$FFFF) completely: no undocumented byte', holes.length === 0, holes.map(([s, l]) => `${hex(s)}+${l}`).join(', '));
  check('contract section 1: V3VARS $E100-$E1FF (V_CAM its first word), GAME_VARS $E200-$E9FF, WORLD_RAM $EA00-$F1FF (page aligned), POOL_B $F200-$FA7F, T3 $FA80, canary $FB00, stack to $FEFF',
    S.V3VARS === 0xE100 && S.V_CAM === 0xE100 && S.GAME_VARS_BASE === 0xE200 && S.GAME_VARS_LIMIT === 0xE9FF && S.WORLD_RAM === 0xEA00 && S.WORLD_RAM_LEN === 0x800 &&
    S.POOL_B === 0xF200 && S.POOL_B + S.POOL_B_LEN === 0xFA80 && S.T3 === 0xFA80 && S.STACK_CANARY === 0xFB00 && S.STACK_TOP === 0xFF00);
  check('the phase pool: POOL_A $C080 (3,456) + POOL_B (2,176) + POOL_C $D700 (256) = PHASE_POOL_BYTES 5,888; all even (the pair blitters use INC L)',
    S.POOL_A_LEN + S.POOL_B_LEN + S.POOL_C_LEN === S.PHASE_POOL_BYTES && S.PHASE_POOL_BYTES === 5888 && [S.POOL_A, S.POOL_B, S.POOL_C, S.POOL_A_LEN, S.POOL_B_LEN, S.POOL_C_LEN].every((v) => v % 2 === 0));
  check('8-bit address arithmetic: SPR_TAB + 127, AST + 127, PHASE_OFF + 127 stay inside their page; TILE_ATTR, GLYPH_TAB, CELL_TILE, DIRTY0 page aligned',
    (S.SPR_TAB & 255) + 127 < 256 && (S.AST & 255) + 127 < 256 && (S.PHASE_OFF & 255) + 127 < 256 && [S.TILE_ATTR, S.GLYPH_TAB, S.CELL_TILE, S.DIRTY0].every((a) => (a & 255) === 0));
}

// ---- 2. games with the free areas poisoned ---------------------------------------------------------------------------------------
const pat = (k) => 0xA5 ^ (k & 0x3F);
function confined(label, spec, nframes, { cacheMode }) {
  const game = C.scriptGame(spec);
  const mdl = new C.Model6(spec);
  const plan = C.planPool(mdl.assets, mdl.ninstOf(), C.POOL_PIECES(S));
  // the allocated parts of the pool: FTABs and slots; the rest of each piece is poisoned
  const allocated = new Set();
  plan.ftab.forEach((a, k) => { if (a) for (let i = 0; i < 4 * mdl.assets[k].nf; i++) allocated.add(a + i); });
  plan.slots.forEach((list, k) => list.forEach((a) => { for (let i = 0; i < mdl.assets[k].slen; i++) allocated.add(a + i); }));
  const slotByte = new Set();
  plan.slots.forEach((list, k) => list.forEach((a) => { for (let i = 0; i < mdl.assets[k].slen; i++) slotByte.add(a + i); }));
  const ftabSlotWord = new Set();
  plan.ftab.forEach((a, k) => { if (a) for (let f = 0; f < mdl.assets[k].nf; f++) { ftabSlotWord.add(a + 4 * f + 2); ftabSlotWord.add(a + 4 * f + 3); } });
  const free = REGIONS.filter((x) => x[3] === 'free').map(([n, a, l]) => [n, a, l]).concat([['tail $5B00', 0x5B00, 0x500], ['tail $7B00', 0x7B00, 0x500]]);
  const pools = REGIONS.filter((x) => x[3] === 'pool');
  let poisoned = false, snapRo = null;
  const ro = REGIONS.filter((x) => x[3] === 'ro');
  const writes = new Map();
  const st = C.observe6(game, nframes, { script: spec.script, hooks: (pc, { m }) => {
    if (!poisoned && pc === S.MAIN) {
      poisoned = true;
      for (const [, a, l] of free) for (let k = 0; k < l; k++) m.ram[a + k] = pat(k);
      for (const [, a, l] of pools) for (let k = 0; k < l; k++) if (!allocated.has(a + k)) m.ram[a + k] = pat(k);
      snapRo = ro.map(([, a, l]) => m.ram.slice(a, a + l));
      const w = m.bus.write;
      m.bus.write = (addr, v) => { const a = addr & 0xFFFF; if (a >= 0xC000 || (a >= 0x5B00 && a < 0x6000) || a >= 0x7B00 && a < 0x8000) writes.set(a, (writes.get(a) ?? 0) + 1); w(addr, v); };
    }
  } });
  const m = st.m;
  const name = (a) => { for (const [n, s, l] of REGIONS) if (a >= s && a < s + l) return n; return a < 0x8000 ? 'display tail' : 'gap'; };
  const touched = {};
  for (const a of writes.keys()) touched[name(a)] = (touched[name(a)] ?? 0) + 1;
  console.log(`  ${label}: regions written during play (bytes): ${Object.entries(touched).map(([n, c]) => `${n} ${c}`).join(', ')}`);
  check(`${label}: the picture equals the model in every refresh (${st.pictureOk}/${nframes})`, st.pictureBad === 0 && st.pixelBad === 0 && st.pictureOk >= nframes - 2, JSON.stringify(st.firstBad));
  const freeOk = free.every(([, a, l]) => Array.from({ length: l }, (_, k) => m.ram[a + k]).every((v, k) => v === pat(k)));
  const tailOk = pools.every(([, a, l]) => Array.from({ length: l }, (_, k) => k).every((k) => allocated.has(a + k) || m.ram[a + k] === pat(k)));
  check(`${label}: no free area is written (T2, T4, $E0FC-$E0FF, V_CAM and $E102-$E1BF, WORLD_RAM, T3, $5B00-$5FFF, $7B00-$7FFF) and no unallocated pool byte`, freeOk && tailOk);
  check(`${label}: play writes only cell map, dirty maps, SPR_TAB, SPR_DRAWN, variables, the frame cache's scratch, GAME_VARS, stack${cacheMode ? ', and the pool / AST (cache mode)' : ''}`,
    Object.keys(touched).every((n) => ['CELL_TILE', 'CELL_ATTR', 'DIRTY0', 'DIRTY1', 'SPR_TAB', 'SPR_DRAWN', 'VARS', 'FC_VARS', 'GAME_VARS', 'STACK', ...(cacheMode ? ['POOL_A', 'POOL_B', 'POOL_C', 'AST'] : [])].includes(n)),
    JSON.stringify(touched));
  check(`${label}: PHASE_OFF, TILE_ATTR, GLYPH_TAB are byte for byte what the boot built`, ro.every(([, a, l], i) => Array.from({ length: l }, (_, k) => m.ram[a + k]).every((v, k) => v === snapRo[i][k])));
  if (cacheMode) {
    const poolW = [...writes.keys()].filter((a) => pools.some(([, p, l]) => a >= p && a < p + l));
    const astW = [...writes.keys()].filter((a) => a >= S.AST && a < S.AST + 128);
    check(`${label}: pool writes are slot bytes or FTAB slot words only (${poolW.length} bytes); AST writes are AST_RR bytes only`,
      poolW.length > 0 && poolW.every((a) => slotByte.has(a) || ftabSlotWord.has(a)) && astW.every((a) => (a - S.AST) % 16 === S.AST_RR));
  }
  return st;
}
console.log('\n2. Poisoned free areas, writes tracked');
{
  const r = rng(77);
  const assets = [C.randomAsset(r, 16, 16, 8, 1), C.randomAsset(r, 16, 24, 4, 4), C.randomAsset(r, 32, 30, 2, 2), C.randomAsset(r, 8, 8, 8, 3), C.randomAsset(r, 24, 12, 4, 2)];
  const insts = Array.from({ length: 16 }, (_, i) => i % 5);
  const nfs = insts.map((a) => C.normAsset(assets[a]).nf);
  const script = C.addWalk(randomScene(7701, QUICK ? 25 : 70, { sprites: 0, tiles: 12, textRate: 0.7, tileRate: 0.8, wild: true }), 16, r, { frames: nfs });
  const map = Array.from({ length: 768 }, () => (r.chance(0.5) ? 0x80 | r.int(0, 11) : r.int(32, 126)));
  const spec = { div: 3, assets, insts, tiles: randomTiles(rng(78), 12), map, script };
  const plan = C.planPool(new C.Model6(spec).assets, new C.Model6(spec).ninstOf(), C.POOL_PIECES(S));
  check('2a. every frame has a slot (K = nframes) in this game', plan.ok && plan.K.every((k, i) => k === 0 || k === C.normAsset(assets[i]).nf), `K ${plan.K}`);
  confined('2a. 16 instances of 5 assets (frames, every width), text and tiles, every frame in a slot', spec, script.length * 3, { cacheMode: false });
}
{
  const r = rng(79);
  const assets = [C.randomAsset(r, 16, 24, 4, 32), C.randomAsset(r, 16, 16, 8, 12), C.randomAsset(r, 8, 8, 8, 4)];
  const insts = [0, 0, 0, 1, 1, 2, 2, 2];
  const nfs = insts.map((a) => C.normAsset(assets[a]).nf);
  const script = C.addWalk(randomScene(7702, QUICK ? 25 : 60, { sprites: 0, tiles: 6, textRate: 0.5, tileRate: 0.5 }), 8, r, { frames: nfs, frameRate: 0.7 });
  const spec = { div: 3, assets, insts, tiles: randomTiles(rng(80), 6), script };
  const st = confined('2b. cache mode (a 32-frame and a 12-frame asset), frames changing all the time', spec, script.length * 3, { cacheMode: true });
  check('2b. misses happened', rd16(st.m, S.FC_MISSES) > 20, `${rd16(st.m, S.FC_MISSES)}`);
}

// ---- 3. the stack ------------------------------------------------------------------------------------------------------------------
console.log('\n3. The stack');
{
  const r = rng(81);
  const assets = [C.randomAsset(r, 32, 40, 4, 12), C.randomAsset(r, 16, 24, 8, 8)];
  const script = Array.from({ length: 30 }, (_, t) => [op.showf(0, 13 + 3 * t, 20, t % 12), op.showf(1, 101 + 2 * t, 90, (t * 3) % 8), op.showf(2, 51, 130 - t, (t * 5) % 8), ...(t === 0 ? [op.play(0)] : [])]);
  const rec = (k) => [(60 + 3 * k) & 255, (((60 + 3 * k) >> 8) & 15) | ((15 - ((k >> 3) % 16)) << 4), (k % 31) | ((k % 4) << 5), 0];
  const game = C.scriptGame({ div: 2, assets, insts: [0, 1, 1], sfx: [Array.from({ length: 160 }, (_, k) => rec(k))], script });
  let workMin = 0xFFFF, ownMin = 0xFFFF, inWork = false, isrMax = 0, isrSp0 = -1;
  const st = C.observe6(game, 80, { script, hooks: (pc, { m, inIsr }) => {
    if (pc === S.SKIP_CALL) inWork = true;
    if (pc === S.TICK_REQUEST) inWork = false;
    const sp = m.cpu.sp;
    if (inWork && sp < workMin) workMin = sp;
    if (inWork && !inIsr && sp < ownMin) ownMin = sp;
    if (inIsr) { if (pc === S.ISR) isrSp0 = sp + 2; if (isrSp0 >= 0) isrMax = Math.max(isrMax, isrSp0 - sp); } else isrSp0 = -1;
  } });
  const depth = S.STACK_TOP - workMin, own = S.STACK_TOP - ownMin;
  console.log(`  the deepest stack during the tick work (skip, erase, redraw, draw with cache misses): ${own} bytes of the runtime's own; ${isrMax} bytes for an interrupt (effect playing); ${depth} together`);
  check('the runtime\'s own stack use during a tick is at most 26 bytes (layout.inc: draw_all > fc_miss > build_frame), with frames built in the tick; an interrupt adds 10', own <= 26 && isrMax <= 10 && depth <= 36 && rd16(st.m, S.FC_MISSES) > 10, `${own} + ${isrMax}, ${rd16(st.m, S.FC_MISSES)} misses`);
  check('the canary is intact, the stack never below $FB02', st.canary === 0x5AA5 && st.spMin >= S.STACK_LIMIT && st.pictureBad === 0);
}

finish('runtime v3 part 1, memory map');
void M; void Z; void FRAME_T; void rd8;
